"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildKillmailItemTreeForLocation,
} = require(path.join(__dirname, "../../services/killmail/killmailItemPayload"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../entityConstants"));
const {
  resolveExactAbyssalNpcOutcomeContext,
  shouldSuppressResolvedAbyssalNpcOutcome,
} = require(path.join(
  __dirname,
  "../../services/_shared/abyssalNpcOutcomePolicy",
));
const {
  toPublicSolarSystemID,
} = require("../../abyssal").engineSupport.hostLocation;

const CATEGORY_SHIP = 6;
const GROUP_CAPSULE = 29;
const GROUP_SHUTTLE = 31;
const GROUP_CORVETTE = 237;
const KILLMARK_EXCLUDED_GROUP_IDS = new Set([
  GROUP_CAPSULE,
  GROUP_SHUTTLE,
  GROUP_CORVETTE,
]);

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const LEDGER_TTL_MS = 30 * 60 * 1000;

const ledgersByVictim = new Map();

function getCharacterStateService() {
  return require(path.join(__dirname, "../../services/character/characterState"));
}

function getKillmailStateService() {
  return require(path.join(__dirname, "../../services/killmail/killmailState"));
}

function getKillRightStateService() {
  return require(path.join(__dirname, "../../services/bounty/killRightState"));
}

function getSessionRegistry() {
  return require(path.join(__dirname, "../../services/chat/sessionRegistry"));
}

function getShipKillCounterStateService() {
  return require(path.join(__dirname, "../../services/ship/shipKillCounterState"));
}

function getKillmailPostCommitPipeline() {
  const pipeline = require(path.join(
    __dirname,
    "../../services/killmail/killmailPostCommitPipeline",
  ));
  pipeline.recoverPending({
    onCommitted(record) {
      return getKillmailNotificationFanout().notifyVictimKillmailAvailable(record);
    },
  });
  return pipeline;
}

function getKillmailNotificationFanout() {
  return require(path.join(
    __dirname,
    "../../services/killmail/killmailNotificationFanout",
  ));
}

function recoverPendingKillmailWork() {
  return getKillmailPostCommitPipeline();
}

function createKillmailRecord(recordInput) {
  const killmailState = getKillmailStateService();
  return killmailState && typeof killmailState.createKillmailRecord === "function"
    ? killmailState.createKillmailRecord(recordInput)
    : { success: false, errorMsg: "KILLMAIL_STATE_UNAVAILABLE" };
}

function resolveKillmailWarID(recordInput) {
  const killmailState = getKillmailStateService();
  return killmailState && typeof killmailState.resolveKillmailWarID === "function"
    ? killmailState.resolveKillmailWarID(recordInput)
    : null;
}

function resolveCharacterRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function toInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function toPositiveInt(value, fallback = null) {
  const numericValue = toInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function formatKillmailFiletime(whenMs = Date.now()) {
  const numericWhenMs = Number.isFinite(Number(whenMs)) ? Math.trunc(Number(whenMs)) : Date.now();
  return (BigInt(numericWhenMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET).toString();
}

function cleanupExpiredLedgers(nowMs = Date.now()) {
  for (const [ledgerKey, ledger] of [...ledgersByVictim.entries()]) {
    if (!ledger || nowMs - toFiniteNumber(ledger.lastUpdatedAtMs, 0) > LEDGER_TTL_MS) {
      ledgersByVictim.delete(ledgerKey);
    }
  }
}

function getVictimLedgerKey(entity) {
  const itemID = toPositiveInt(entity && entity.itemID, 0) || 0;
  return `${String(entity && entity.kind || "entity")}:${itemID}`;
}

function resolveWeaponTypeID(options = {}) {
  const weaponSnapshot = options.weaponSnapshot || null;
  const moduleItem = options.moduleItem || null;
  const chargeItem = options.chargeItem || null;
  return (
    toPositiveInt(
      options.weaponTypeID,
      toPositiveInt(
        weaponSnapshot && weaponSnapshot.chargeTypeID,
        toPositiveInt(
          weaponSnapshot && weaponSnapshot.moduleTypeID,
          toPositiveInt(
            chargeItem && chargeItem.typeID,
            toPositiveInt(moduleItem && moduleItem.typeID, null),
          ),
        ),
      ),
    ) || null
  );
}

function resolveEntityTypeRecord(entity) {
  const typeID = toPositiveInt(
    entity && (entity.typeID || entity.slimTypeID),
    null,
  );
  return typeID ? resolveItemByTypeID(typeID) || null : null;
}

function resolveEntityGroupID(entity, typeRecord = null) {
  return toPositiveInt(
    entity && (entity.groupID || entity.slimGroupID),
    toPositiveInt(typeRecord && typeRecord.groupID, 0),
  ) || 0;
}

function resolveEntityCategoryID(entity, typeRecord = null) {
  return toPositiveInt(
    entity && (entity.categoryID || entity.slimCategoryID),
    toPositiveInt(typeRecord && typeRecord.categoryID, 0),
  ) || 0;
}

function resolveAttackerIdentity(attackerEntity, options = {}) {
  if (!attackerEntity) {
    return {
      characterID: null,
      corporationID: null,
      allianceID: null,
      factionID: null,
      shipTypeID: null,
      weaponTypeID: resolveWeaponTypeID(options),
      securityStatus: null,
    };
  }

  const characterID = toPositiveInt(
    attackerEntity.pilotCharacterID ?? attackerEntity.characterID,
    null,
  );
  const characterRecord = characterID ? resolveCharacterRecord(characterID) || {} : {};
  return {
    characterID,
    corporationID: toPositiveInt(
      characterRecord.corporationID,
      toPositiveInt(attackerEntity.corporationID, toPositiveInt(attackerEntity.ownerID, null)),
    ),
    allianceID: toPositiveInt(characterRecord.allianceID, toPositiveInt(attackerEntity.allianceID, null)),
    factionID: toPositiveInt(
      characterRecord.factionID,
      toPositiveInt(attackerEntity.warFactionID, null),
    ),
    shipTypeID: toPositiveInt(attackerEntity.typeID, null),
    weaponTypeID: resolveWeaponTypeID(options),
    securityStatus:
      characterID && characterRecord
        ? toFiniteNumber(
            characterRecord.securityStatus ?? characterRecord.securityRating,
            0,
          )
        : null,
  };
}

function isCapsuleerPilotedShipVictim(targetEntity, victimIdentity) {
  if (String(targetEntity && targetEntity.kind || "").toLowerCase() !== "ship") {
    return false;
  }
  if (targetEntity && targetEntity.nativeNpc === true) {
    return false;
  }
  if (toPositiveInt(victimIdentity && victimIdentity.victimCharacterID, 0) <= 0) {
    return false;
  }

  const typeRecord = resolveEntityTypeRecord(targetEntity);
  const categoryID = resolveEntityCategoryID(targetEntity, typeRecord);
  const groupID = resolveEntityGroupID(targetEntity, typeRecord);
  return categoryID === CATEGORY_SHIP && !KILLMARK_EXCLUDED_GROUP_IDS.has(groupID);
}

function isNpcVictimEntity(entity) {
  if (!entity) {
    return false;
  }
  const npcEntityType = String(entity.npcEntityType || "").trim().toLowerCase();
  return (
    entity.nativeNpc === true ||
    entity.nativeNpcOccupied === true ||
    npcEntityType === ENTITY_TYPE.NPC ||
    npcEntityType === ENTITY_TYPE.CONCORD
  );
}

// Last-resort victim identity, and in practice the ONLY one that survives.
//
// ⚠ WHY THIS EXISTS. A destroyed player ship reaches recordKillmailFromDestruction
// already unlinked from its pilot: pilotCharacterID and characterID are 0 and
// `session` is null (see the shape the golden killmailParity test builds). The
// runtime captures `targetEntity.session` before the destroy, but for a player
// ship that field is null there too, so `victimSession` arrives empty and the
// victim resolved to NULL. Losses were then written with victimCharacterID:null,
// which the killmail index cannot file under anyone — so a player's losses never
// appeared in their combat log at all.
//
// `ownerID` is the one identity that does survive, and it is already trusted
// enough to be used for the victim's CORPORATION below. Only accept it when it
// resolves to a real character, so an NPC hull whose ownerID is a faction corp
// can never be mistaken for a capsuleer.
function resolveVictimCharacterIDFromOwner(targetEntity) {
  const ownerID = toPositiveInt(targetEntity && targetEntity.ownerID, null);
  if (!ownerID || !resolveCharacterRecord(ownerID)) {
    return null;
  }
  return ownerID;
}

function canAwardKillmark(targetEntity, attackerEntity, finalAttacker, victimIdentity) {
  if (!isCapsuleerPilotedShipVictim(targetEntity, victimIdentity)) {
    return false;
  }

  const attackerShipID = resolveKillmarkAwardShipID(attackerEntity);
  const victimShipID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  const attackerCharacterID = toPositiveInt(finalAttacker && finalAttacker.characterID, 0);
  const victimCharacterID = toPositiveInt(victimIdentity && victimIdentity.victimCharacterID, 0);
  if (
    attackerShipID <= 0 ||
    victimShipID <= 0 ||
    attackerShipID === victimShipID ||
    attackerCharacterID <= 0 ||
    victimCharacterID <= 0 ||
    attackerCharacterID === victimCharacterID
  ) {
    return false;
  }

  const attackerCorporationID = toPositiveInt(finalAttacker && finalAttacker.corporationID, 0);
  const victimCorporationID = toPositiveInt(victimIdentity && victimIdentity.victimCorporationID, 0);
  if (attackerCorporationID > 0 && victimCorporationID > 0 && attackerCorporationID === victimCorporationID) {
    return false;
  }

  return true;
}

function resolveKillmarkAwardShipID(attackerEntity) {
  if (!attackerEntity) {
    return 0;
  }
  if (String(attackerEntity.kind || "").toLowerCase() === "ship") {
    return toPositiveInt(attackerEntity.itemID, 0);
  }
  return (
    toPositiveInt(attackerEntity.controllerID, 0) ||
    toPositiveInt(attackerEntity.launcherID, 0) ||
    toPositiveInt(attackerEntity.sourceShipID, 0) ||
    0
  );
}

function broadcastKillmarkSlimChange(targetEntity, attackerEntity, awardShipID, playerKills) {
  if (!attackerEntity) {
    return false;
  }
  if (toPositiveInt(attackerEntity.itemID, 0) === awardShipID) {
    attackerEntity.kills = playerKills;
  }

  try {
    const spaceRuntime = require(path.join(__dirname, "../runtime"));
    const session = attackerEntity.session || (targetEntity && targetEntity.session) || null;
    const scene =
      session && spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : spaceRuntime && spaceRuntime.scenes instanceof Map
          ? spaceRuntime.scenes.get(
            toPositiveInt(
              attackerEntity.systemID,
              toPositiveInt(targetEntity && targetEntity.systemID, 0),
            ),
          ) || null
          : null;
    const liveEntity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(awardShipID)
        : null;
    if (!scene || !liveEntity || typeof scene.broadcastSlimItemChanges !== "function") {
      return false;
    }
    liveEntity.kills = playerKills;
    scene.broadcastSlimItemChanges([liveEntity]);
    return true;
  } catch (error) {
    // ignored: the kill is recorded either way; false says the live kill marks were not refreshed
    return false;
  }
}

function awardKillmarkForFinalBlow(targetEntity, attackerEntity, finalAttacker, victimIdentity, record, options = {}) {
  if (!canAwardKillmark(targetEntity, attackerEntity, finalAttacker, victimIdentity)) {
    return null;
  }

  const killID = toPositiveInt(record && record.killID, 0);
  const shipCounterState = getShipKillCounterStateService();
  if (!shipCounterState || typeof shipCounterState.incrementItemKillCountPlayer !== "function") {
    return null;
  }

  const awardShipID = resolveKillmarkAwardShipID(attackerEntity);
  const result = shipCounterState.incrementItemKillCountPlayer(awardShipID, {
    awardID: options.idempotencyKey || null,
    reason: "player_final_blow",
    lastAward: {
      killID: killID || null,
      victimShipID: toPositiveInt(targetEntity && targetEntity.itemID, null),
      victimCharacterID: toPositiveInt(victimIdentity && victimIdentity.victimCharacterID, null),
      victimShipTypeID: toPositiveInt(victimIdentity && victimIdentity.victimShipTypeID, null),
      weaponTypeID: toPositiveInt(finalAttacker && finalAttacker.weaponTypeID, null),
      awardedAt: formatKillmailFiletime(options.whenMs),
    },
  });
  if (!result || result.success !== true) {
    if (options.idempotencyKey) throw new Error(result?.errorMsg || "KILLMARK_COMMIT_FAILED");
    return result || null;
  }
  if (result.changed === true) {
    broadcastKillmarkSlimChange(targetEntity, attackerEntity, awardShipID, result.playerKills);
  }
  return result;
}

function resolveSessionCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID || session.charID || session.charid),
    null,
  );
}

function resolveVictimIdentity(targetEntity, options = {}) {
  if (!targetEntity) {
    return {
      victimCharacterID: null,
      victimCorporationID: null,
      victimAllianceID: null,
      victimFactionID: null,
      victimShipTypeID: null,
    };
  }

  if (String(targetEntity.kind || "").toLowerCase() === "structure") {
    return {
      victimCharacterID: null,
      victimCorporationID: toPositiveInt(
        targetEntity.corporationID,
        toPositiveInt(targetEntity.ownerID, null),
      ),
      victimAllianceID: toPositiveInt(targetEntity.allianceID, null),
      victimFactionID: null,
      victimShipTypeID: toPositiveInt(targetEntity.typeID, null),
    };
  }

  const victimSession = options && options.victimSession
    ? options.victimSession
    : null;
  const sessionCharacterID = resolveSessionCharacterID(victimSession);
  const characterID = isNpcVictimEntity(targetEntity)
    ? null
    : toPositiveInt(
        targetEntity.pilotCharacterID ?? targetEntity.characterID,
        sessionCharacterID,
      ) ?? resolveVictimCharacterIDFromOwner(targetEntity);
  const characterRecord = characterID ? resolveCharacterRecord(characterID) || {} : {};
  return {
    victimCharacterID: characterID,
    victimCorporationID: toPositiveInt(
      characterRecord.corporationID,
      toPositiveInt(
        targetEntity.corporationID,
        toPositiveInt(
          victimSession && victimSession.corporationID,
          toPositiveInt(targetEntity.ownerID, null),
        ),
      ),
    ),
    victimAllianceID: toPositiveInt(
      characterRecord.allianceID,
      toPositiveInt(
        targetEntity.allianceID,
        toPositiveInt(victimSession && victimSession.allianceID, null),
      ),
    ),
    victimFactionID: toPositiveInt(
      characterRecord.factionID,
      toPositiveInt(
        targetEntity.warFactionID,
        toPositiveInt(victimSession && victimSession.warFactionID, null),
      ),
    ),
    victimShipTypeID: toPositiveInt(targetEntity.typeID, null),
  };
}

function getOrCreateLedger(targetEntity, whenMs = Date.now()) {
  cleanupExpiredLedgers(whenMs);
  const ledgerKey = getVictimLedgerKey(targetEntity);
  if (!ledgersByVictim.has(ledgerKey)) {
    ledgersByVictim.set(ledgerKey, {
      victimKey: ledgerKey,
      victimItemID: toPositiveInt(targetEntity && targetEntity.itemID, null),
      victimKind: String(targetEntity && targetEntity.kind || "entity"),
      solarSystemID: toPositiveInt(targetEntity && targetEntity.systemID, null),
      damageTaken: 0,
      attackers: {},
      lastUpdatedAtMs: whenMs,
    });
  }
  return ledgersByVictim.get(ledgerKey);
}

function buildAttackerLedgerKey(identity = {}) {
  return [
    toPositiveInt(identity.characterID, 0) || 0,
    toPositiveInt(identity.corporationID, 0) || 0,
    toPositiveInt(identity.allianceID, 0) || 0,
    toPositiveInt(identity.factionID, 0) || 0,
    toPositiveInt(identity.shipTypeID, 0) || 0,
    toPositiveInt(identity.weaponTypeID, 0) || 0,
  ].join(":");
}

function noteDamage(attackerEntity, targetEntity, appliedDamage, options = {}) {
  if (require("../FireShow/showIdentity").isFireShowShip(targetEntity)) return null;
  const damageAmount = Math.max(0, toFiniteNumber(appliedDamage, 0));
  if (!targetEntity || damageAmount <= 0) {
    return null;
  }

  const whenMs = Number.isFinite(Number(options.whenMs)) ? Number(options.whenMs) : Date.now();
  const ledger = getOrCreateLedger(targetEntity, whenMs);
  if (targetEntity.airEncounterSlot?.startsWith("hostile:") && attackerEntity?.session) require("../../services/nodegraph/nodeGraphEvents").publish(attackerEntity.session, "air.weapon-damage", { target: targetEntity, damage: damageAmount });
  return addDamageToLedger(ledger, attackerEntity, targetEntity, damageAmount, { ...options, whenMs });
}

function addDamageToLedger(ledger, attackerEntity, targetEntity, damageAmount, options) {
  const whenMs = options.whenMs;
  const identity = options.attackerIdentity || resolveAttackerIdentity(attackerEntity, options);
  const attackerKey = buildAttackerLedgerKey(identity);
  const currentEntry = ledger.attackers[attackerKey] || {
    ...identity,
    damageDone: 0,
  };
  currentEntry.damageDone = toFiniteNumber(currentEntry.damageDone, 0) + damageAmount;
  ledger.attackers[attackerKey] = currentEntry;
  ledger.damageTaken = toFiniteNumber(ledger.damageTaken, 0) + damageAmount;
  ledger.lastUpdatedAtMs = whenMs;
  ledger.solarSystemID = toPositiveInt(
    targetEntity.systemID,
    toPositiveInt(ledger.solarSystemID, null),
  );
  return cloneValue(currentEntry);
}

// A terminal journal needs the accepted lethal hit and every earlier attacker,
// without modifying the live ledger before health has committed.
function snapshotDamageLedger(targetEntity, attackerEntity, appliedDamage, options = {}) {
  const whenMs = options.whenMs ?? Date.now();
  const ledger = cloneValue(getOrCreateLedger(targetEntity, whenMs));
  if (appliedDamage > 0) addDamageToLedger(ledger, attackerEntity, targetEntity, appliedDamage, { ...options, whenMs });
  return ledger;
}

// NPC wreck ownership follows damage contribution, while the killmail still
// records the pilot who landed the final blow separately.  Ledger rows are
// keyed by the full ship/weapon identity for killmail fidelity, so collapse
// them by character here before comparing totals.  The lethal hit is supplied
// as a non-mutating candidate because destruction currently happens before
// the normal post-damage ledger write.
function resolveHighestDamageAttacker(targetEntity, options = {}) {
  if (!targetEntity) {
    return null;
  }

  const whenMs = Number.isFinite(Number(options.whenMs))
    ? Number(options.whenMs)
    : Date.now();
  cleanupExpiredLedgers(whenMs);
  const ledger = ledgersByVictim.get(getVictimLedgerKey(targetEntity)) || null;
  const totalsByCharacterID = new Map();

  const addContribution = (identity, damageDone) => {
    const characterID = toPositiveInt(identity && identity.characterID, 0);
    const damage = Math.max(0, toFiniteNumber(damageDone, 0));
    if (characterID <= 0 || damage <= 0) {
      return;
    }
    const current = totalsByCharacterID.get(characterID) || {
      characterID,
      corporationID: null,
      allianceID: null,
      factionID: null,
      shipTypeID: null,
      weaponTypeID: null,
      securityStatus: null,
      damageDone: 0,
    };
    for (const field of [
      "corporationID",
      "allianceID",
      "factionID",
      "shipTypeID",
      "weaponTypeID",
      "securityStatus",
    ]) {
      if (identity && identity[field] !== undefined && identity[field] !== null) {
        current[field] = identity[field];
      }
    }
    current.damageDone += damage;
    totalsByCharacterID.set(characterID, current);
  };

  for (const entry of Object.values(ledger && ledger.attackers || {})) {
    addContribution(entry, entry && entry.damageDone);
  }

  const candidateDamage = Math.max(
    0,
    toFiniteNumber(options.candidateDamage, 0),
  );
  if (candidateDamage > 0 && options.candidateAttackerEntity) {
    addContribution(
      resolveAttackerIdentity(
        options.candidateAttackerEntity,
        options.candidateOptions || options,
      ),
      candidateDamage,
    );
  }

  const ranked = [...totalsByCharacterID.values()].sort((left, right) => (
    toFiniteNumber(right && right.damageDone, 0) -
      toFiniteNumber(left && left.damageDone, 0) ||
    toPositiveInt(left && left.characterID, 0) -
      toPositiveInt(right && right.characterID, 0)
  ));
  return ranked.length > 0 ? cloneValue(ranked[0]) : null;
}

function resolveKillmailItems(destroyResult = {}, lootLocationIDs = []) {
  const lootOutcomeItems =
    destroyResult &&
    destroyResult.data &&
    destroyResult.data.lootOutcome &&
    Array.isArray(destroyResult.data.lootOutcome.items)
      ? cloneValue(destroyResult.data.lootOutcome.items)
      : null;
  if (lootOutcomeItems) {
    return lootOutcomeItems;
  }
  return lootLocationIDs.flatMap((locationID) => buildKillmailItemTreeForLocation(locationID));
}

function sumItemLossValue(items = []) {
  return items.reduce((sum, item) => {
    const basePrice = Math.max(
      0,
      toFiniteNumber((resolveItemByTypeID(item && item.typeID) || {}).basePrice, 0),
    );
    const quantity =
      Math.max(0, toInteger(item && item.qtyDropped, 0)) +
      Math.max(0, toInteger(item && item.qtyDestroyed, 0));
    return sum + basePrice * quantity + sumItemLossValue(item && item.contents ? item.contents : []);
  }, 0);
}

function resolveLootLocationIDs(targetEntity, destroyResult = {}) {
  if (
    String(targetEntity && targetEntity.kind || "").toLowerCase() === "ship" &&
    destroyResult &&
    destroyResult.data &&
    destroyResult.data.wreck
  ) {
    return [toPositiveInt(destroyResult.data.wreck.itemID, null)].filter(Boolean);
  }

  if (
    String(targetEntity && targetEntity.kind || "").toLowerCase() === "structure" &&
    destroyResult &&
    destroyResult.data
  ) {
    const loot = destroyResult.data.loot || null;
    if (loot) {
      const ids = [];
      if (loot.wreck && loot.wreck.itemID) {
        ids.push(toPositiveInt(loot.wreck.itemID, null));
      }
      for (const container of Array.isArray(loot.containers) ? loot.containers : []) {
        ids.push(toPositiveInt(container && container.containerID, null));
      }
      return ids.filter(Boolean);
    }
    if (Array.isArray(destroyResult.data.lootItemIDs)) {
      return destroyResult.data.lootItemIDs.map((value) => toPositiveInt(value, null)).filter(Boolean);
    }
  }

  return [];
}

function resolveBountyPayout(targetEntity, finalAttacker = {}, options = {}) {
  const bountyRuntime = require(path.join(__dirname, "../../services/bounty/bountyRuntime"));
  const result = bountyRuntime.recordNpcBountyKill(targetEntity, finalAttacker, {
    nowMs: options.whenMs,
    solarSystemID: toPositiveInt(targetEntity && targetEntity.systemID, null),
  });
  if (result && result.eligible === true) {
    return result.amount;
  }

  const hunterCharacterID = toPositiveInt(finalAttacker && finalAttacker.characterID, null);
  if (!hunterCharacterID) {
    return null;
  }

  const playerBountyState = require(path.join(__dirname, "../../services/bounty/playerBountyState"));
  const payoutResult = playerBountyState.claimBountyPayout({
    victim: options.victimIdentity || {},
    victimEntity: targetEntity,
    iskLost: options.iskLost,
    hunterCharacterID,
    payoutID: options.payoutID,
    ownerID2:
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimCharacterID, 0) ||
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimCorporationID, 0) ||
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimAllianceID, 0) ||
      0,
    referenceID:
      toPositiveInt(targetEntity && targetEntity.itemID, 0) ||
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimCharacterID, 0) ||
      hunterCharacterID,
  });
  if (!payoutResult || payoutResult.eligible !== true || !(payoutResult.amount > 0)) {
    return null;
  }
  return payoutResult.amount;
}

function selectKillRightActivationForKill(victimCharacterID, finalAttacker, whenMs) {
  const targetCharacterID = toPositiveInt(victimCharacterID, 0);
  if (targetCharacterID <= 0) {
    return null;
  }

  const killRightState = getKillRightStateService();
  if (
    !killRightState ||
    typeof killRightState.readActiveActivationsForTarget !== "function"
  ) {
    return null;
  }

  const activations = killRightState.readActiveActivationsForTarget(
    targetCharacterID,
    whenMs,
  );
  if (!Array.isArray(activations) || activations.length === 0) {
    return null;
  }

  const finalCharacterID = toPositiveInt(finalAttacker && finalAttacker.characterID, 0);
  return activations.find((activation) => (
    finalCharacterID > 0 &&
    toPositiveInt(activation && activation.activatorID, 0) === finalCharacterID
  )) || activations[0];
}

function uniqueKillRightNotificationSessions(characterIDs, candidateSessions = []) {
  const sessions = [];
  const seen = new Set();
  const characterSet = new Set(
    (Array.isArray(characterIDs) ? characterIDs : [])
      .map((characterID) => toPositiveInt(characterID, 0))
      .filter((characterID) => characterID > 0),
  );

  const addSession = (session) => {
    if (
      !session ||
      typeof session.sendNotification !== "function" ||
      seen.has(session)
    ) {
      return;
    }
    const characterID = toPositiveInt(
      session.characterID || session.charID || session.charid,
      0,
    );
    if (!characterSet.has(characterID)) {
      return;
    }
    seen.add(session);
    sessions.push(session);
  };

  for (const session of Array.isArray(candidateSessions) ? candidateSessions : []) {
    addSession(session);
  }

  const sessionRegistry = getSessionRegistry();
  if (sessionRegistry && typeof sessionRegistry.findSessionByCharacterID === "function") {
    for (const characterID of characterSet) {
      addSession(sessionRegistry.findSessionByCharacterID(characterID));
    }
  }

  return sessions;
}

function notifyKillRightUsed(activation, targetEntity, attackerEntity) {
  if (!activation) {
    return 0;
  }

  const killRightID = toPositiveInt(activation.killRightID, 0);
  const toID = toPositiveInt(activation.toID, 0);
  if (killRightID <= 0 || toID <= 0) {
    return 0;
  }

  const sessions = uniqueKillRightNotificationSessions(
    [
      activation.fromID,
      activation.toID,
      activation.activatorID,
      attackerEntity && (attackerEntity.characterID || attackerEntity.pilotCharacterID),
    ],
    [
      targetEntity && targetEntity.session,
      attackerEntity && attackerEntity.session,
    ],
  );

  for (const session of sessions) {
    session.sendNotification("OnKillRightUsed", "clientID", [killRightID, toID]);
  }
  return sessions.length;
}

function notifyVictimKillmailAvailable(record, targetEntity, victimIdentity, options = {}) {
  const victimCharacterID = toPositiveInt(
    victimIdentity && victimIdentity.victimCharacterID,
    0,
  ) || 0;
  const killID = toPositiveInt(record && record.killID, 0) || 0;
  if (victimCharacterID <= 0 || killID <= 0) {
    return null;
  }

  const extraSessions = [
    targetEntity && targetEntity.session,
    options.victimSession,
  ].filter(Boolean);
  return getKillmailNotificationFanout().notifyVictimKillmailAvailable(record, {
    victimCharacterID,
    victimShipTypeID:
      toPositiveInt(record.victimShipTypeID, 0) ||
      toPositiveInt(victimIdentity && victimIdentity.victimShipTypeID, 0) ||
      null,
    extraSessions,
  });
}

// The killer's kill report, sent off the same committed record as the victim's.
// Fires for every kill the record itself says belongs in a kill log, which
// includes player-owned structures as well as capsuleers, so the shooter and
// their corporation see the kill without waiting for the victim to log in.
function notifyFinalBlowKillmailAvailable(record, attackerEntity, options = {}) {
  const killID = toPositiveInt(record && record.killID, 0) || 0;
  if (killID <= 0) {
    return null;
  }

  const extraSessions = [
    attackerEntity && attackerEntity.session,
    options.attackerSession,
  ].filter(Boolean);
  return getKillmailNotificationFanout().notifyFinalBlowKillmailAvailable(record, {
    extraSessions,
  });
}

function consumeKillRightAfterKill(activation, targetEntity, attackerEntity, whenMs) {
  if (!activation) {
    return null;
  }

  const killRightID = toPositiveInt(activation.killRightID, 0);
  if (killRightID <= 0) {
    return null;
  }

  const killRightState = getKillRightStateService();
  if (!killRightState || typeof killRightState.markKillRightUsed !== "function") {
    return null;
  }

  const usedBy =
    toPositiveInt(attackerEntity && (attackerEntity.characterID || attackerEntity.pilotCharacterID), 0) ||
    toPositiveInt(activation.activatorID, 0) ||
    null;
  const usedResult = killRightState.markKillRightUsed(killRightID, usedBy, {
    nowMs: whenMs,
  });
  if (!usedResult || !usedResult.success) {
    return null;
  }

  return {
    killRightID,
    suppliedBy: toPositiveInt(activation.fromID, null),
    toID: toPositiveInt(activation.toID, null),
    usedBy,
    notificationCount: notifyKillRightUsed(activation, targetEntity, attackerEntity),
  };
}

function recordCombatAchievement(killRecord, context = {}) {
  const killID = toPositiveInt(killRecord && killRecord.killID, 0);
  if (!killID) {
    return;
  }
  try {
    require(path.join(
      __dirname,
      "../../services/achievement/achievementRuntime",
    )).recordCombatKillmailOutcome({
      killID,
      solarSystemID: context.solarSystemID,
      victimEntity: context.targetEntity,
      victimIdentity: context.victimIdentity,
      finalAttacker: context.finalAttacker,
    });
  } catch (error) {
    // Killmail persistence and combat state must never be held hostage by
    // optional progression bookkeeping.
    log.debug(`[Killmail] achievement progress for kill ${killID} failed: ${error && error.message}`);
  }
}

function recordKillmailFromDestruction(targetEntity, destroyResult, options = {}) {
  if (!targetEntity || !destroyResult || destroyResult.success !== true) {
    return null;
  }
  // The asynchronous pipeline does not retain terminal event keys. AIR's two
  // accepted deaths need the permanent receipt before their owner can resume.
  if (destroyResult.data?.deathReceiptKey) options = { ...options, idempotencyKey: destroyResult.data.deathReceiptKey, deferPostCommit: false };

  const whenMs = Number.isFinite(Number(options.whenMs)) ? Number(options.whenMs) : Date.now();
  const ledgerKey = getVictimLedgerKey(targetEntity);
  if (require("../FireShow/showIdentity").isFireShowShip(targetEntity)) {
    ledgersByVictim.delete(ledgerKey);
    return null;
  }
  if (String(targetEntity.kind || "").toLowerCase() === "drone") {
    // Omit drones from killmails
    ledgersByVictim.delete(ledgerKey);
    return null;
  }
  const abyssalNpcContext = resolveExactAbyssalNpcOutcomeContext(targetEntity);
  if (shouldSuppressResolvedAbyssalNpcOutcome(abyssalNpcContext)) {
    // NPC-victim killmails expose the reused host location, encounter hull mix,
    // and corporation activity. Abyssal NPC outcomes are private run state, so
    // clear the transient damage ledger without persisting a public record.
    ledgersByVictim.delete(ledgerKey);
    return null;
  }
  const ledger = options.damageLedger
    ? cloneValue(options.damageLedger)
    : ledgersByVictim.get(ledgerKey) || getOrCreateLedger(targetEntity, whenMs);
  const finalIdentity = options.attackerIdentity || resolveAttackerIdentity(options.attackerEntity || null, options);
  const finalAttackerKey = buildAttackerLedgerKey(finalIdentity);
  const finalAttacker = ledger.attackers[finalAttackerKey] || {
    ...finalIdentity,
    damageDone: 0,
  };
  ledger.attackers[finalAttackerKey] = finalAttacker;
  ledger.lastUpdatedAtMs = whenMs;

  const victimIdentity = options.victimIdentity || resolveVictimIdentity(targetEntity, options);
  const lootLocationIDs = resolveLootLocationIDs(targetEntity, destroyResult);
  const items = resolveKillmailItems(destroyResult, lootLocationIDs);
  const iskLost =
    Math.max(
      0,
      toFiniteNumber((resolveItemByTypeID(victimIdentity.victimShipTypeID) || {}).basePrice, 0),
    ) + sumItemLossValue(items);
  const bountyClaimed = resolveBountyPayout(targetEntity, finalAttacker, {
    whenMs,
    victimIdentity,
    iskLost,
    payoutID: `kill:${ledgerKey}`,
  });
  // Faction standing loss (TQ parity): destroying a faction NPC lowers standing with its faction
  // only (single-faction hit, no derived; debounced per character/faction/system, calibrated from
  // the golden mission logs). Best-effort; never blocks the kill.
  if (isNpcVictimEntity(targetEntity)) {
    try {
      const factionKillStanding = require(path.join(__dirname, "../../services/character/factionKillStandingRuntime"));
      factionKillStanding.recordNpcFactionStandingLoss(
        targetEntity,
        toPositiveInt(finalAttacker && finalAttacker.characterID, 0),
        { nowMs: whenMs, systemID: toPositiveInt(targetEntity && targetEntity.systemID, 0) },
      );
    } catch (error) {
      /* ignored: faction-standing loss is best-effort (it logs its own failures); the kill must still record */
    }
  }
  const killRightActivation = selectKillRightActivationForKill(
    victimIdentity.victimCharacterID,
    finalAttacker,
    whenMs,
  );
  const rawSolarSystemID = toPositiveInt(
    targetEntity.systemID,
    toPositiveInt(ledger.solarSystemID, null),
  );
  const killRecordInput = {
    killTime: formatKillmailFiletime(whenMs),
    // Reserved Abyssal hosts are reusable implementation details, not public
    // geography. Preserve the player loss but redact its host at the point the
    // durable killmail is assembled; never misattribute it to the entry system.
    solarSystemID: toPublicSolarSystemID(rawSolarSystemID, null),
    moonID: null,
    ...victimIdentity,
    victimDamageTaken: Math.max(0, toFiniteNumber(ledger.damageTaken, 0)),
    finalCharacterID: finalAttacker.characterID,
    finalCorporationID: finalAttacker.corporationID,
    finalAllianceID: finalAttacker.allianceID,
    finalFactionID: finalAttacker.factionID,
    finalShipTypeID: finalAttacker.shipTypeID,
    finalWeaponTypeID: finalAttacker.weaponTypeID,
    finalSecurityStatus: finalAttacker.securityStatus,
    finalDamageDone: Math.max(0, toFiniteNumber(finalAttacker.damageDone, 0)),
    iskLost,
    bountyClaimed,
    loyaltyPoints: null,
    killRightSupplied: killRightActivation
      ? toPositiveInt(killRightActivation.fromID, null)
      : null,
    attackers: Object.entries(ledger.attackers)
      .filter(([attackerKey]) => attackerKey !== finalAttackerKey)
      .map(([, attacker]) => attacker)
      .sort((left, right) => toFiniteNumber(right && right.damageDone, 0) - toFiniteNumber(left && left.damageDone, 0)),
    items,
  };
  killRecordInput.warID = resolveKillmailWarID(killRecordInput);
  const careerAttackHull = destroyResult.data?.careerAttackHull;
  if (careerAttackHull && Number(careerAttackHull.characterID) === Number(finalAttacker.characterID) &&
      Number(resolveItemByTypeID(careerAttackHull.shipTypeID)?.categoryID) === CATEGORY_SHIP)
    killRecordInput.careerFinalShipTypeID = Number(careerAttackHull.shipTypeID);
  const fwWinner = require("../../services/achievement/achievementRuntime")
    .snapshotFactionWarfareWinner(killRecordInput);
  if (fwWinner) killRecordInput.achievementFwWinnerCharacterID = fwWinner;
  const careerFwFinalBlow = require("../../services/career/careerCombatSources").snapshotFactionWarfareFinalBlow(killRecordInput);
  if (careerFwFinalBlow) {
    killRecordInput.careerFwFinalBlowCharacterID = careerFwFinalBlow.characterID;
    killRecordInput.careerFwFinalBlowFactionID = careerFwFinalBlow.factionID;
    killRecordInput.careerFwVictimFactionID = careerFwFinalBlow.victimFactionID;
  }
  if (targetEntity.kind === "ship" && isNpcVictimEntity(targetEntity)) killRecordInput.careerNpcShip = true;

  if (options.deferPostCommit === true) {
    const targetSession = targetEntity.session || null;
    const victimSession = options.victimSession || null;
    const attackerSession =
      (options.attackerEntity && options.attackerEntity.session) || null;
    const pipeline = getKillmailPostCommitPipeline();
    const receipt = pipeline.enqueue(killRecordInput, {
      onCommitted(record) {
        const victimResult = notifyVictimKillmailAvailable(
          record,
          { session: targetSession },
          victimIdentity,
          { victimSession },
        );
        notifyFinalBlowKillmailAvailable(record, { session: attackerSession });
        return victimResult;
      },
    });
    const reservedRecord = receipt && receipt.success
      ? { killID: receipt.killID }
      : null;

    // These are authoritative combat consequences. They commit at the
    // destruction boundary and never wait for killmail enrichment,
    // persistence, or client fan-out.
    awardKillmarkForFinalBlow(
      targetEntity,
      options.attackerEntity || null,
      finalAttacker,
      victimIdentity,
      reservedRecord,
      { whenMs },
    );
    if (killRightActivation) {
      consumeKillRightAfterKill(
        killRightActivation,
        targetEntity,
        options.attackerEntity || null,
        whenMs,
      );
    }
    if (reservedRecord) {
      recordCombatAchievement(reservedRecord, {
        solarSystemID: rawSolarSystemID,
        targetEntity,
        victimIdentity,
        finalAttacker,
      });
    }
    ledgersByVictim.delete(ledgerKey);
    return receipt && receipt.success ? receipt : null;
  }

  const record = options.idempotencyKey
    ? getKillmailStateService().createKillmailRecordIdempotent(killRecordInput, options.idempotencyKey)
    : createKillmailRecord(killRecordInput);
  if (record && toPositiveInt(record.killID, 0) > 0) {
    notifyVictimKillmailAvailable(record, targetEntity, victimIdentity, options);
    notifyFinalBlowKillmailAvailable(record, options.attackerEntity || null, options);
    awardKillmarkForFinalBlow(
      targetEntity,
      options.attackerEntity || null,
      finalAttacker,
      victimIdentity,
      record,
      { whenMs, idempotencyKey: options.idempotencyKey },
    );
    recordCombatAchievement(record, {
      solarSystemID: rawSolarSystemID,
      targetEntity,
      victimIdentity,
      finalAttacker,
    });
  }
  if (record && toPositiveInt(record.killID, 0) > 0 && killRightActivation) {
    consumeKillRightAfterKill(
      killRightActivation,
      targetEntity,
      options.attackerEntity || null,
      whenMs,
    );
  }
  ledgersByVictim.delete(ledgerKey);
  return record;
}

function enqueueKillmailFromDestruction(targetEntity, destroyResult, options = {}) {
  return recordKillmailFromDestruction(targetEntity, destroyResult, {
    ...options,
    deferPostCommit: true,
  });
}

module.exports = {
  enqueueKillmailFromDestruction,
  noteDamage,
  snapshotDamageLedger,
  resolveAttackerIdentity,
  resolveVictimIdentity,
  resolveHighestDamageAttacker,
  recoverPendingKillmailWork,
  recordKillmailFromDestruction,
};
module.exports._testing = {
  notifyVictimKillmailAvailable,
  notifyFinalBlowKillmailAvailable,
  resolveKillmailItems,
};
