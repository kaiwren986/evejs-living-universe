"use strict";

// Sovereignty Hub cleanup window. For 24 hours after a Hub is claimed, a
// Station Manager or Director of the Hub's corporation may convert or destroy
// the Orbital Skyhooks of other alliances in that system (client
// ui/services/sovSvc.py CanCleanUpSystem and GetStructuresAvailableToCleanUp,
// ui/shared/sov/sovHub/skyhooksCleanup/cleanupWndController.py ProcessSkyhooks).
//
// - Convert costs SKYHOOK_CLAIM_FEE (200,000,000 ISK) per skyhook
//   (sovereignty/hub/const.py) and hands the skyhook to the Hub owner with
//   default reinforcement and tax settings and the chosen access list
//   (localization 1011727, 1011796).
// - Destroy is free (GetNumDestroyingAndPrice returns 0) and removes the
//   skyhook from orbit (localization 1011729).
// Both calls return the IDs actually processed; the window marks only those.
// The fee is paid from the Hub corporation's master wallet with journal type
// refSkyhookClaimedBySovHubFee (appConst 184). No source says which wallet
// pays; the corporation wallet is the synthetic choice (owner ruling
// 2026-11-06: reasonable synthetic data where no source exists).

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(__dirname, "../../common/machoErrors"));
const planetOrbitalState = require(path.join(__dirname, "../planet/planetOrbitalState"));
const { getInfrastructureHubClaim } = require(path.join(__dirname, "./sovState"));
const { requireStructureManagementSession } = require(path.join(__dirname, "./sovPlayerDeployment"));
const { buildNotEnoughMoneyUserErrorValues } = require(path.join(__dirname, "../account/walletState"));
const {
  CORPORATION_WALLET_KEY_START,
  adjustCorporationWalletDivisionBalanceAsync,
  getCorporationWalletBalance,
} = require(path.join(__dirname, "../corporation/corpWalletState"));

const SKYHOOK_CLAIM_FEE = 200000000;
const ALLOWED_DURATION_AFTER_SOVHUB_CLAIM_SECONDS = 86400;
const REF_SKYHOOK_CLAIMED_BY_SOV_HUB_FEE = 184;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function filetimeToUnixMs(value) {
  try {
    const filetime = BigInt(String(value || "0"));
    return filetime > FILETIME_EPOCH_OFFSET ? Number((filetime - FILETIME_EPOCH_OFFSET) / 10000n) : 0;
  } catch (error) {
    return 0;
  }
}

function getScene(solarSystemID) {
  const runtime = require(path.join(__dirname, "../../space/runtime"));
  return (runtime.scenes && runtime.scenes.get(solarSystemID)) || null;
}

function refuse() {
  throwWrappedUserError("CustomNotify", { notify: "You are unable to clean up the system." });
}

// The same checks as the client's CanCleanUpSystem, made on the server's own
// records: the session's system has a Hub owned by the caller's corporation,
// the caller may manage it, and the claim is under 24 hours old.
function requireCleanupContext(session, nowMs) {
  const solarSystemID = toInt(session && (session.solarsystemid2 || session.solarsystemid), 0);
  const claim = solarSystemID ? getInfrastructureHubClaim(solarSystemID) : null;
  const corporationID = toInt(claim && claim.corporationID, 0);
  if (!claim || !corporationID) refuse();
  requireStructureManagementSession(session, { ownerCorpID: corporationID });
  const claimAtMs = filetimeToUnixMs(claim.claimTime);
  const scene = getScene(solarSystemID);
  const resolvedNowMs = nowMs ?? (scene && typeof scene.getCurrentSimTimeMs === "function"
    ? scene.getCurrentSimTimeMs() : Date.now());
  if (!claimAtMs || resolvedNowMs - claimAtMs > ALLOWED_DURATION_AFTER_SOVHUB_CLAIM_SECONDS * 1000) refuse();
  return {
    solarSystemID,
    corporationID,
    allianceID: toInt(claim.allianceID, 0) || null,
    claimTime: String(claim.claimTime),
    scene,
  };
}

// Only skyhooks in the system that belong to another alliance qualify, as in
// GetStructuresAvailableToCleanUp. Anything else in the request is skipped and
// left out of the returned list.
function listCleanupSkyhooks(skyhookIDs, context) {
  const ids = [...new Set((Array.isArray(skyhookIDs) ? skyhookIDs : [])
    .map((value) => toInt(value, 0)).filter((value) => value > 0))];
  return ids.map((id) => planetOrbitalState.getOrbitalByID(id, { refresh: false }))
    .filter((record) => record &&
      toInt(record.typeID, 0) === planetOrbitalState.TYPE_ORBITAL_SKYHOOK &&
      toInt(record.solarSystemID, 0) === context.solarSystemID &&
      !planetOrbitalState.isOrbitalRecordDestroyed(record) &&
      toInt(record.allianceID, 0) !== toInt(context.allianceID, 0));
}

function invalidateSovSkyhookViews() {
  require(path.join(__dirname, "./sovModernState")).invalidateSovereigntyModernStateCache();
}

async function acquireSkyhooks(skyhookIDs, accessListID, session, options = {}) {
  const context = requireCleanupContext(session, options.nowMs);
  const records = listCleanupSkyhooks(skyhookIDs, context);
  if (records.length === 0) return [];
  const required = records.length * SKYHOOK_CLAIM_FEE;
  const balance = getCorporationWalletBalance(context.corporationID, CORPORATION_WALLET_KEY_START);
  if (balance < required) {
    throwWrappedUserError("NotEnoughMoney", buildNotEnoughMoneyUserErrorValues(required, balance));
  }
  const characterID = toInt(session.characterID || session.charid, 0);
  const acquired = [];
  for (const record of records) {
    const commandID = `skyhook-claim:${record.itemID}:${context.claimTime}`;
    const charge = await adjustCorporationWalletDivisionBalanceAsync(
      context.corporationID,
      CORPORATION_WALLET_KEY_START,
      -SKYHOOK_CLAIM_FEE,
      {
        description: `Orbital Skyhook ${record.itemID} claimed by Sovereignty Hub`,
        entryTypeID: REF_SKYHOOK_CLAIMED_BY_SOV_HUB_FEE,
        idempotencyKey: commandID,
        ownerID1: context.corporationID,
        ownerID2: toInt(record.corporationID, 0),
        referenceID: record.itemID,
      },
      { commandID, source: "sov-skyhook-claim", characterID },
    );
    if (!charge || !charge.success) {
      log.warn(`[SkyhookCleanup] Fee for skyhook=${record.itemID} failed: ${charge && charge.errorMsg}`);
      break;
    }
    const transfer = planetOrbitalState.transferOrbitalOwnership(record.itemID, {
      corporationID: context.corporationID,
      allianceID: context.allianceID,
      aclGroupID: accessListID,
    });
    if (!transfer.success) {
      log.warn(`[SkyhookCleanup] Transfer of skyhook=${record.itemID} failed: ${transfer.errorMsg}`);
      break;
    }
    acquired.push(record.itemID);
  }
  invalidateSovSkyhookViews();
  return acquired;
}

function retireSkyhook(record, context) {
  const marked = planetOrbitalState.markOrbitalDestroyed(record.itemID);
  if (!marked.success) return marked;
  const scene = context.scene;
  const entity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(record.itemID) : null;
  if (scene && entity) {
    require(path.join(__dirname, "./skyhookRaidRuntime")).handleParentDestroyed(record.itemID, scene);
    // Dismantled rather than shot down: no explosion and no wreck.
    return scene.dynamicEntities instanceof Map && scene.dynamicEntities.has(record.itemID)
      ? scene.destroyInventoryBackedDynamicEntity(record.itemID, { actor: context.characterID })
      : scene.removeStaticEntity(record.itemID);
  }
  const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
  return itemStore.findItemById(record.itemID)
    ? itemStore.removeInventoryItem(record.itemID, { removeContents: true })
    : { success: true };
}

function destroySkyhooks(skyhookIDs, session, options = {}) {
  const context = requireCleanupContext(session, options.nowMs);
  context.characterID = toInt(session.characterID || session.charid, 0);
  const destroyed = [];
  for (const record of listCleanupSkyhooks(skyhookIDs, context)) {
    const result = retireSkyhook(record, context);
    if (!result || !result.success) {
      log.warn(`[SkyhookCleanup] Destroying skyhook=${record.itemID} failed: ${result && result.errorMsg}`);
      continue;
    }
    destroyed.push(record.itemID);
  }
  invalidateSovSkyhookViews();
  return destroyed;
}

module.exports = {
  SKYHOOK_CLAIM_FEE,
  ALLOWED_DURATION_AFTER_SOVHUB_CLAIM_SECONDS,
  REF_SKYHOOK_CLAIMED_BY_SOV_HUB_FEE,
  acquireSkyhooks,
  destroySkyhooks,
};
