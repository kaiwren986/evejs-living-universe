"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalanceAsync,
} = require(path.join(__dirname, "../account/walletState"));
const {
  peekCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  adjustCharacterWalletLPBalance,
  adjustCorporationWalletLPBalance,
} = require(path.join(__dirname, "../corporation/lpWalletState"));
const {
  CORPORATION_WALLET_KEY_START,
  adjustCorporationWalletDivisionBalanceAsync,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  CORPORATION_TAX_CURRENCY,
  buildCorporationTaxDescription,
  computeCorporationTax,
  corporationReceivesTax,
  isUnpayableCorporationTaxError,
  resolveCorporationTaxProfile,
} = require(path.join(__dirname, "../corporation/corporationTax"));
const standingRuntime = require(path.join(__dirname, "../character/standingRuntime"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const {
  custodyStepCommitted,
  reportSettlementRetry,
  reportUnresolvedLeg,
  resolveCustodyResultItem,
} = require(path.join(__dirname, "../_shared/settlementCustodyRecovery"));
const missionRewardItemCustody = require(path.join(
  __dirname,
  "../inventory/missionRewardItemCustody",
));
const { ensureGrantedBlueprintCopyState } = require("../inventory/blueprintRewardState");

const TABLE_NAME = "missionRewardSettlements";
const ROOT_VERSION = 1;
const ESCROW_LOCATION_BASE = 9_500_000_000;
const DURABLE_SETTLEMENT_JOB_TYPE = "agent-mission.reward-settle";
const DURABLE_SETTLEMENT_JOB_PREFIX = "mission-reward:";
const DEFINITIVE_WALLET_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "INVALID_AMOUNT",
]);
const settlementLanes = new Map();
let durableScheduler = null;
// The startup recovery pass (missionRewardSettlementRecovery.js) registers itself here when it
// loads, so this store never requires it (it requires this store). missionRewardSettlementJobs.js
// loads it before the scheduler's reconcile.
let startupRecovery = null;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function toFlag(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function resolveAgentName(settlement) {
  const agentName = settlement && settlement.agentRecord &&
    typeof settlement.agentRecord.ownerName === "string"
    ? settlement.agentRecord.ownerName.trim()
    : "";
  return agentName || `Agent ${toPositiveInt(settlement && settlement.agentID, 0)}`;
}

function resolveCharacterName(characterID) {
  const record = peekCharacterRecord(characterID);
  const characterName = record && typeof record.characterName === "string"
    ? record.characterName.trim()
    : "";
  return characterName || `Character ${toPositiveInt(characterID, 0)}`;
}

// The V24.01 client renders the journal description itself: FmtWalletEntry
// looks the entry type up in its own accountingEntryTypes static data and
// formats message 234515 for refAgentMissionReward (33) -- "Mission reward
// from agent {name1} to {name2}" -- out of ownerID1/ownerID2, and 234516 for
// the time bonus (34). The stored description is the raw reason blob TQ
// reserves for tax detail: GetDerivedTransactions yaml-parses it, and a
// {taxRefType: [corporationID, taxAmount]} mapping is what makes the client
// draw the corporation tax row and restore the pre-tax amount on the reward
// row. Untaxed payouts carry a plain scalar (no colons, so it parses as a
// string and yields no derived rows) that reads the way the client's line does.
function buildRewardDescription(settlement, leg, reversal = false) {
  if (leg.tax > 0 && leg.corporationID > 0) {
    return buildCorporationTaxDescription(
      leg.taxEntryTypeID,
      leg.corporationID,
      leg.tax,
      { reversal },
    );
  }
  const agentName = resolveAgentName(settlement);
  const characterName = resolveCharacterName(settlement && settlement.characterID);
  const payout = leg.kind === "bonus" ? "Mission reward bonus" : "Mission reward";
  return reversal
    ? `${payout} reversal from agent ${agentName} to ${characterName}`
    : `${payout} from agent ${agentName} to ${characterName}`;
}

// The reward and the time bonus are independent payouts: their own journal
// entry, their own corporation tax row, their own durable checkpoints, and each
// is measured against the corporation tax minimum on its own. The descriptors
// are derived from the amounts locked in at prepare, so a settlement written
// before the bonus was split off simply has no bonus leg to pay.
function buildWalletPayoutLegs(settlement) {
  const corporationID = toPositiveInt(settlement && settlement.taxCorporationID, 0);
  const corporationTaxable = corporationReceivesTax({
    corporationID,
    isNPC: settlement && settlement.taxCorporationIsNPC === true,
  });
  return [
    {
      kind: "reward",
      gross: roundMoney(settlement && settlement.walletReward),
      tax: roundMoney(settlement && settlement.walletRewardTax),
      corporationID,
      corporationTaxable,
      entryTypeID: JOURNAL_ENTRY_TYPE.AGENT_MISSION_REWARD,
      taxEntryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_TAX_AGENT_REWARDS,
      taxDescription: "Corporation tax on mission rewards",
      commandID: settlement && settlement.walletCommandID,
      reversalCommandID: settlement && settlement.walletReversalCommandID,
      taxCommandID: settlement && settlement.corpTaxCommandID,
      taxReversalCommandID: settlement && settlement.corpTaxReversalCommandID,
      appliedField: "walletApplied",
      reversedField: "walletReversed",
      resultField: "walletResult",
      taxAppliedField: "corpTaxApplied",
      taxReversedField: "corpTaxReversed",
      taxPaidField: "corpTaxPaid",
    },
    {
      kind: "bonus",
      gross: roundMoney(settlement && settlement.walletBonusReward),
      tax: roundMoney(settlement && settlement.walletBonusTax),
      corporationID,
      corporationTaxable,
      entryTypeID: JOURNAL_ENTRY_TYPE.AGENT_MISSION_TIME_BONUS_REWARD,
      taxEntryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_TAX_AGENT_BONUS_REWARDS,
      taxDescription: "Corporation tax on mission bonus rewards",
      commandID: settlement && settlement.walletBonusCommandID,
      reversalCommandID: settlement && settlement.walletBonusReversalCommandID,
      taxCommandID: settlement && settlement.corpBonusTaxCommandID,
      taxReversalCommandID: settlement && settlement.corpBonusTaxReversalCommandID,
      appliedField: "walletBonusApplied",
      reversedField: "walletBonusReversed",
      resultField: "walletBonusResult",
      taxAppliedField: "corpBonusTaxApplied",
      taxReversedField: "corpBonusTaxReversed",
      taxPaidField: "corpBonusTaxPaid",
    },
  ].map((leg) => ({ ...leg, net: roundMoney(leg.gross - leg.tax) }));
}

function readRoot() {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, "/");
  const root = result && result.success && result.data &&
    typeof result.data === "object"
    ? result.data
    : {};
  return {
    version: ROOT_VERSION,
    nextOperationID: toPositiveInt(root.nextOperationID, 1),
    // Detached: gameStore.read returns the live cache object, and writeRoot's
    // change detection compares against that same object. Mutating it in place
    // makes every write look unchanged, so the table stays right in memory and
    // never reaches disk.
    byOperationID:
      root.byOperationID && typeof root.byOperationID === "object"
        ? cloneValue(root.byOperationID)
        : {},
  };
}

function writeRoot(root) {
  database.ensureTable(TABLE_NAME);
  const result = database.write(TABLE_NAME, "/", {
    version: ROOT_VERSION,
    nextOperationID: toPositiveInt(root.nextOperationID, 1),
    byOperationID: cloneValue(root.byOperationID || {}),
  });
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(TABLE_NAME);
  return flushResult && flushResult.success
    ? result
    : flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
}

// A settlement is durable state that outlives the code that wrote it, so a
// payout schema change lands on records already in flight. The reward/time-bonus
// split plus corporation tax added eight fields that a pre-split record simply
// does not have; buildWalletPayoutLegs read them as `undefined`, which
// roundMoney turns into 0 for the amounts and toPositiveInt turns into 0 for
// the corporation -- survivable -- but left every bonus/tax commandID
// `undefined`, so a bonus leg that was never quoted could still be *attempted*
// with an invalid commandID. Backfilling on read gives an old record exactly
// the shape prepare() would have produced for "no bonus, no corporation tax",
// which is what it was: legs worth zero, already applied, nothing to pay.
//
// Only genuinely absent fields are filled. A stored `false` or `0` is a real
// checkpoint and is left alone. This never turns an unpaid leg into a paid one:
// every flag defaulted to `true` here belongs to a leg whose amount is 0.
function normalizeStoredSettlement(settlement) {
  if (!settlement || typeof settlement !== "object") {
    return null;
  }
  const normalized = cloneValue(settlement);
  const operationID = String(normalized.operationID || "").trim();
  const has = (field) => Object.prototype.hasOwnProperty.call(normalized, field) &&
    normalized[field] !== undefined &&
    normalized[field] !== null;
  const fill = (field, value) => {
    if (!has(field)) {
      normalized[field] = value;
    }
  };
  const key = (suffix) => `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:${suffix}`;

  fill("walletReward", 0);
  fill("walletRewardTax", 0);
  fill("walletBonusReward", 0);
  fill("walletBonusTax", 0);
  fill("taxCorporationID", 0);
  fill("taxCorporationIsNPC", false);
  fill("taxRate", 0);
  fill("walletCommandID", key("wallet-credit"));
  fill("walletReversalCommandID", key("wallet-reversal"));
  fill("walletBonusCommandID", key("wallet-bonus-credit"));
  fill("walletBonusReversalCommandID", key("wallet-bonus-reversal"));
  fill("corpTaxCommandID", key("corp-tax-credit"));
  fill("corpTaxReversalCommandID", key("corp-tax-reversal"));
  fill("corpBonusTaxCommandID", key("corp-bonus-tax-credit"));
  fill("corpBonusTaxReversalCommandID", key("corp-bonus-tax-reversal"));
  fill("lpKey", key("lp-credit"));
  fill("lpReversalKey", key("lp-reversal"));
  fill("corpLpTaxKey", key("corp-lp-tax-credit"));
  fill("corpLpTaxReversalKey", key("corp-lp-tax-reversal"));
  fill("standingKey", key("standing"));
  // A record prepared before LP was taxed paid (or will pay) the member the
  // full loyaltyPoints, with no corporation leg.
  fill("loyaltyPointsTax", 0);
  fill("loyaltyPointsNet", Math.max(0, Math.trunc(Number(normalized.loyaltyPoints) || 0)));
  fill("loyaltyPointTaxRate", 0);
  fill("loyaltyPointTaxCorporationID", 0);

  fill("walletBonusApplied", roundMoney(normalized.walletBonusReward) <= 0);
  fill("walletBonusReversed", false);
  fill("walletBonusResult", null);
  fill("corpTaxApplied", roundMoney(normalized.walletRewardTax) <= 0);
  fill("corpTaxReversed", false);
  fill("corpTaxPaid", 0);
  fill("corpBonusTaxApplied", roundMoney(normalized.walletBonusTax) <= 0);
  fill("corpBonusTaxReversed", false);
  fill("corpBonusTaxPaid", 0);
  fill(
    "corpLpTaxApplied",
    !(toPositiveInt(normalized.loyaltyPointTaxCorporationID, 0) > 0 &&
      Math.trunc(Number(normalized.loyaltyPointsTax) || 0) > 0),
  );
  fill("corpLpTaxReversed", false);
  fill("corpLpTaxPaid", 0);
  // Set only by the startup recovery pass when a money leg's receipt may have
  // been evicted and its payment state is unknowable; the forward path refuses a
  // settlement carrying it rather than risk a double payout.
  fill("recoveryHoldError", null);

  normalized.cargoLegs = Array.isArray(normalized.cargoLegs) ? normalized.cargoLegs : [];
  normalized.rewardLegs = Array.isArray(normalized.rewardLegs) ? normalized.rewardLegs : [];
  return normalized;
}

function getPendingMissionRewardSettlement(operationID) {
  const key = String(operationID || "").trim();
  return normalizeStoredSettlement(readRoot().byOperationID[key] || null);
}

// Matching on (characterID, agentID) alone is not enough to identify the
// settlement that belongs to a *particular* mission. A settlement that cannot
// finish outlives the mission that created it, and completeMission consults
// this before it looks at the mission being handed in -- so an orphan from a
// long-deleted mission sequence was returned for the character's current
// mission, resumed in its place, and failed. One wedged settlement blocked
// every future turn-in for that pair, permanently.
//
// missionSequence is therefore part of the identity. Callers that know which
// mission they are settling must pass it; callers that only want to know
// whether *any* settlement is in flight for the pair (quitMission) legitimately
// omit it.
function findPendingMissionRewardSettlement(characterID, agentID = 0, missionSequence = 0) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  const normalizedAgentID = toPositiveInt(agentID, 0);
  const normalizedMissionSequence = toPositiveInt(missionSequence, 0);
  return listPendingMissionRewardSettlements().find((settlement) =>
    settlement.characterID === normalizedCharacterID &&
    (!normalizedAgentID || settlement.agentID === normalizedAgentID) &&
    (
      !normalizedMissionSequence ||
      toPositiveInt(settlement.missionSequence, 0) === normalizedMissionSequence
    )) || null;
}

function listPendingMissionRewardSettlements() {
  return Object.values(readRoot().byOperationID)
    .filter(Boolean)
    .map(normalizeStoredSettlement)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function updateSettlement(operationID, updater) {
  const root = readRoot();
  const key = String(operationID || "").trim();
  const current = root.byOperationID[key];
  if (!current) {
    return { success: false, errorMsg: "MISSION_REWARD_SETTLEMENT_NOT_FOUND" };
  }
  // Normalize before handing the record to the updater so a checkpoint written
  // against an old-schema record persists the migrated shape rather than
  // spreading the gaps forward.
  const next = typeof updater === "function"
    ? updater(normalizeStoredSettlement(current))
    : current;
  if (next === null) {
    delete root.byOperationID[key];
  } else {
    root.byOperationID[key] = cloneValue(next);
  }
  const result = writeRoot(root);
  return result && result.success
    ? { success: true, data: cloneValue(next) }
    : result || { success: false, errorMsg: "MISSION_REWARD_SETTLEMENT_WRITE_FAILED" };
}

function buildSettlementJob(operationID) {
  const normalizedOperationID = String(operationID || "").trim();
  return normalizedOperationID
    ? {
        jobID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${normalizedOperationID}`,
        type: DURABLE_SETTLEMENT_JOB_TYPE,
        dueAtMs: Date.now(),
        payload: { operationID: normalizedOperationID },
      }
    : null;
}

async function scheduleSettlement(operationID) {
  const job = buildSettlementJob(operationID);
  if (!job || !durableScheduler) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueSettlement(operationID) {
  if (!durableScheduler) {
    return;
  }
  void scheduleSettlement(operationID).catch((error) => {
    log.warn(
      `[MissionRewardSettlement] scheduling failed operation=${operationID}: ${error.message}`,
    );
  });
}

function normalizeCargoLeg(input, index, operationID) {
  return {
    legID: index + 1,
    itemID: toPositiveInt(input && input.itemID, 0),
    typeID: toPositiveInt(input && input.typeID, 0),
    quantity: toPositiveInt(input && input.quantity, 0),
    ownerID: toPositiveInt(input && input.ownerID, 0),
    sourceLocationID: toPositiveInt(input && input.locationID, 0),
    sourceFlagID: toFlag(input && input.flagID, 0),
    stageKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:cargo:${index + 1}:stage`,
    returnKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:cargo:${index + 1}:return`,
    commitKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:cargo:${index + 1}:commit`,
    staged: false,
    returned: false,
    committed: false,
    commitError: null,
    escrowItemID: 0,
  };
}

function normalizeRewardLeg(output, index, operationID, target) {
  return {
    legID: index + 1,
    typeID: toPositiveInt(output && output.typeID, 0),
    quantity: toPositiveInt(output && output.quantity, 0),
    ...(toPositiveInt(output && output.blueprintRuns, 0) > 0
      ? { blueprintRuns: toPositiveInt(output.blueprintRuns, 0) }
      : {}),
    ...(output && output.original === true ? { original: true } : {}),
    ownerID: target.ownerID,
    destinationLocationID: target.locationID,
    destinationFlagID: target.flagID,
    grantKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:reward:${index + 1}:grant`,
    deliverKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:reward:${index + 1}:deliver`,
    revokeKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:reward:${index + 1}:revoke`,
    granted: false,
    delivered: false,
    revoked: false,
    escrowItemID: 0,
  };
}

function splitRewardLegs(outputs) {
  const stackLimit = toPositiveInt(
    itemStore.CLIENT_INVENTORY_STACK_LIMIT,
    2_147_483_647,
  );
  const result = [];
  for (const output of outputs) {
    const typeID = toPositiveInt(output && output.typeID, 0);
    let remaining = toPositiveInt(output && output.quantity, 0);
    const blueprintRuns = toPositiveInt(output && output.blueprintRuns, 0);
    while (typeID && remaining > 0) {
      const quantity = blueprintRuns > 0 || output.original === true
        ? 1
        : Math.min(remaining, stackLimit);
      result.push({
        typeID,
        quantity,
        ...(blueprintRuns > 0 ? { blueprintRuns } : {}),
        ...(output.original === true ? { original: true } : {}),
      });
      remaining -= quantity;
    }
  }
  return result;
}

function prepareMissionRewardSettlement(options = {}) {
  const characterID = toPositiveInt(options.characterID, 0);
  const agentID = toPositiveInt(options.agentID, 0);
  const missionSequence = toPositiveInt(options.missionSequence, 0);
  const operationID = `${characterID}:${missionSequence}`;
  const target = {
    ownerID: toPositiveInt(options.rewardTarget && options.rewardTarget.ownerID, characterID),
    locationID: toPositiveInt(options.rewardTarget && options.rewardTarget.locationID, 0),
    flagID: toFlag(options.rewardTarget && options.rewardTarget.flagID, itemStore.ITEM_FLAGS.HANGAR),
  };
  const cargoInputs = Array.isArray(options.cargoInputs) ? options.cargoInputs : [];
  const rewardItems = Array.isArray(options.rewardItems) ? options.rewardItems : [];
  const standingsChanges = Array.isArray(options.standingsChanges)
    ? options.standingsChanges
    : [];
  const walletReward = roundMoney(options.walletReward);
  const walletBonusReward = roundMoney(options.walletBonusReward);
  const continuationMissionID = options.continuationMissionID === null ||
    options.continuationMissionID === undefined
    ? null
    : cloneValue(options.continuationMissionID);
  const loyaltyPoints = Math.max(0, Math.trunc(Number(options.loyaltyPoints) || 0));
  const loyaltyPointCorporationID = toPositiveInt(
    options.loyaltyPointCorporationID,
    0,
  );
  if (
    !characterID ||
    !agentID ||
    !missionSequence ||
    (rewardItems.length > 0 && (!target.ownerID || !target.locationID)) ||
    (loyaltyPoints > 0 && !loyaltyPointCorporationID)
  ) {
    return { success: false, errorMsg: "INVALID_MISSION_REWARD_SETTLEMENT" };
  }

  const requestFingerprint = JSON.stringify({
    characterID,
    agentID,
    missionSequence,
    target,
    cargoInputs: cargoInputs.map((entry) => ({
      itemID: toPositiveInt(entry && entry.itemID, 0),
      typeID: toPositiveInt(entry && entry.typeID, 0),
      quantity: toPositiveInt(entry && entry.quantity, 0),
      ownerID: toPositiveInt(entry && entry.ownerID, 0),
      locationID: toPositiveInt(entry && entry.locationID, 0),
      flagID: toFlag(entry && entry.flagID, 0),
    })),
    rewardItems: rewardItems.map((entry) => ({
      typeID: toPositiveInt(entry && entry.typeID, 0),
      quantity: toPositiveInt(entry && entry.quantity, 0),
      ...(toPositiveInt(entry && entry.blueprintRuns, 0) > 0
        ? { blueprintRuns: toPositiveInt(entry.blueprintRuns, 0) }
        : {}),
      ...(entry && entry.original === true ? { original: true } : {}),
    })),
    walletReward,
    walletBonusReward,
    loyaltyPoints,
    loyaltyPointCorporationID,
    standingsChanges,
    continuationMissionID,
  });
  const root = readRoot();
  const existing = root.byOperationID[operationID];
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      return { success: false, errorMsg: "MISSION_REWARD_ALREADY_PENDING" };
    }
    queueSettlement(operationID);
    return { success: true, duplicate: true, data: cloneValue(existing) };
  }
  const conflicting = Object.values(root.byOperationID).find((settlement) =>
    settlement && settlement.characterID === characterID);
  if (conflicting) {
    return { success: false, errorMsg: "MISSION_REWARD_ALREADY_PENDING" };
  }

  const operationSequence = root.nextOperationID;
  const escrowLocationID = ESCROW_LOCATION_BASE + operationSequence;
  const cargoLegs = cargoInputs.map((entry, index) =>
    normalizeCargoLeg(entry, index, operationID));
  const rewardLegs = splitRewardLegs(rewardItems).map((entry, index) =>
    normalizeRewardLeg(entry, index, operationID, target));
  if (
    cargoLegs.some((leg) =>
      !leg.itemID ||
      !leg.typeID ||
      !leg.quantity ||
      !leg.ownerID ||
      !leg.sourceLocationID) ||
    rewardLegs.some((leg) => !leg.typeID || !leg.quantity)
  ) {
    return { success: false, errorMsg: "INVALID_MISSION_REWARD_LEG" };
  }

  // The member's corporation and rate are locked in here, so a replayed
  // settlement pays exactly what it was quoted, even if the member changes
  // corporation mid-flight.
  const corporationTax = resolveCorporationTaxProfile(characterID);
  const rewardTax = computeCorporationTax(
    corporationTax,
    CORPORATION_TAX_CURRENCY.ISK,
    walletReward,
  );
  const bonusTax = computeCorporationTax(
    corporationTax,
    CORPORATION_TAX_CURRENCY.ISK,
    walletBonusReward,
  );
  const walletRewardTax = rewardTax.tax;
  const walletBonusTax = bonusTax.tax;
  const loyaltyPointTax = computeCorporationTax(
    corporationTax,
    CORPORATION_TAX_CURRENCY.LP,
    loyaltyPoints,
  );
  const settlement = {
    operationID,
    operationSequence,
    requestFingerprint,
    characterID,
    agentID,
    missionSequence,
    escrowLocationID,
    cargoLegs,
    rewardLegs,
    rewardTarget: target,
    walletReward,
    walletRewardTax,
    walletBonusReward,
    walletBonusTax,
    taxCorporationID: corporationTax.corporationID,
    taxCorporationIsNPC: corporationTax.isNPC,
    taxRate: corporationTax.taxRate,
    loyaltyPoints,
    loyaltyPointCorporationID,
    // The LP split, locked in with the ISK one. loyaltyPoints stays the gross
    // (what the mission UI and the "Earn LP" daily goal see); the member is
    // credited loyaltyPointsNet, and loyaltyPointTaxCorporationID (0 for a
    // sink) is credited loyaltyPointsTax in its wallet for the same issuer.
    loyaltyPointsTax: loyaltyPointTax.tax,
    loyaltyPointsNet: loyaltyPointTax.net,
    loyaltyPointTaxRate: corporationTax.loyaltyPointTaxRate,
    loyaltyPointTaxCorporationID: loyaltyPointTax.credit ? corporationTax.corporationID : 0,
    standingsChanges: cloneValue(standingsChanges),
    continuationMissionID,
    missionRecord: cloneValue(options.missionRecord || null),
    agentRecord: cloneValue(options.agentRecord || null),
    bonusAvailable: options.bonusAvailable === true,
    walletCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:wallet-credit`,
    walletReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:wallet-reversal`,
    walletBonusCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:wallet-bonus-credit`,
    walletBonusReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:wallet-bonus-reversal`,
    corpTaxCommandID: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:corp-tax-credit`,
    corpTaxReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:corp-tax-reversal`,
    corpBonusTaxCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:corp-bonus-tax-credit`,
    corpBonusTaxReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:corp-bonus-tax-reversal`,
    lpKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:lp-credit`,
    lpReversalKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:lp-reversal`,
    corpLpTaxKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:corp-lp-tax-credit`,
    corpLpTaxReversalKey:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:corp-lp-tax-reversal`,
    standingKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:standing`,
    walletApplied: walletReward <= 0,
    walletReversed: false,
    walletResult: null,
    walletBonusApplied: walletBonusReward <= 0,
    walletBonusReversed: false,
    walletBonusResult: null,
    corpTaxApplied: !rewardTax.credit,
    corpTaxReversed: false,
    corpTaxPaid: 0,
    corpBonusTaxApplied: !bonusTax.credit,
    corpBonusTaxReversed: false,
    corpBonusTaxPaid: 0,
    lpApplied: loyaltyPoints <= 0,
    lpReversed: false,
    lpResult: null,
    corpLpTaxApplied: !loyaltyPointTax.credit,
    corpLpTaxReversed: false,
    corpLpTaxPaid: 0,
    standingApplied: standingsChanges.length <= 0,
    standingResult: standingsChanges.length <= 0
      ? { modifications: [], appliedChanges: [] }
      : null,
    missionFinalized: false,
    finalizationResult: null,
    rejectionError: null,
    cargoChanges: [],
    rewardChanges: [],
    createdAt: new Date().toISOString(),
  };
  root.nextOperationID = operationSequence + 1;
  root.byOperationID[operationID] = settlement;
  const result = writeRoot(root);
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "MISSION_REWARD_SETTLEMENT_WRITE_FAILED" };
  }
  queueSettlement(operationID);
  return { success: true, duplicate: false, data: cloneValue(settlement) };
}

function runSerialized(characterID, operation) {
  const laneKey = String(toPositiveInt(characterID, 0));
  const previous = settlementLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  settlementLanes.set(laneKey, current);
  void current.finally(() => {
    if (settlementLanes.get(laneKey) === current) {
      settlementLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function durableCustodyFailure(result, fallbackError) {
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: fallbackError };
  }
  if (result.durable !== true) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "ITEM_CUSTODY_NOT_DURABLE",
    };
  }
  return null;
}

function getResultItem(result) {
  return resolveCustodyResultItem(result);
}

function findEscrowItem(settlement, leg, kind) {
  const candidates = itemStore.listContainerItems(
    toPositiveInt(leg && leg.ownerID, 0),
    settlement.escrowLocationID,
    0,
  ).filter((item) =>
    toPositiveInt(item && item.typeID, 0) === toPositiveInt(leg && leg.typeID, 0));
  const assigned = new Set([
    ...settlement.cargoLegs
      .filter((entry) => kind !== "cargo" || entry.legID !== leg.legID)
      .map((entry) => toPositiveInt(entry.escrowItemID, 0)),
    ...settlement.rewardLegs
      .filter((entry) => kind !== "reward" || entry.legID !== leg.legID)
      .map((entry) => toPositiveInt(entry.escrowItemID, 0)),
  ].filter(Boolean));
  return candidates
    .filter((item) => !assigned.has(toPositiveInt(item.itemID, 0)))
    .sort((left, right) => Number(left.itemID) - Number(right.itemID))[0] || null;
}

function buildCargoClientChanges(changes, settlement, leg) {
  const normalized = Array.isArray(changes) ? changes : [];
  const result = [];
  for (const change of normalized) {
    const item = change && change.item;
    const previousData = change && (change.previousData || change.previousState);
    const isEscrowDestination = Boolean(
      item &&
        toPositiveInt(item.locationID, 0) === settlement.escrowLocationID &&
        toFlag(item.flagID, 0) === 0
    );
    if (!isEscrowDestination) {
      result.push(cloneValue(change));
      continue;
    }
    if (
      previousData &&
      toPositiveInt(previousData.itemID, 0) === leg.itemID &&
      toPositiveInt(item.itemID, 0) === leg.itemID
    ) {
      result.push({ removed: true, previousData: cloneValue(previousData), item: null });
    }
  }
  return result;
}

async function compensateRejectedSettlement(operationID) {
  let settlement = getPendingMissionRewardSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true };
  }
  if (
    (
      Array.isArray(settlement.standingsChanges) &&
      settlement.standingsChanges.length > 0 &&
      settlement.standingApplied
    ) ||
    settlement.missionFinalized
  ) {
    return { success: false, errorMsg: "MISSION_REWARD_NOT_COMPENSATABLE" };
  }

  if (settlement.corpLpTaxPaid > 0 && !settlement.corpLpTaxReversed) {
    const result = adjustCorporationWalletLPBalance(
      settlement.loyaltyPointTaxCorporationID,
      settlement.loyaltyPointCorporationID,
      -settlement.corpLpTaxPaid,
      {
        reason: "mission_reward_corporation_tax_reversal",
        requireSufficientFunds: true,
        idempotencyKey: settlement.corpLpTaxReversalKey,
      },
    );
    if (!result || result.success !== true) {
      return result ||
        { success: false, errorMsg: "MISSION_REWARD_CORP_LP_TAX_REVERSAL_FAILED" };
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      corpLpTaxReversed: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  // The member is only ever credited the net, so only the net comes back.
  if (settlement.lpApplied && !settlement.lpReversed && settlement.loyaltyPointsNet > 0) {
    const result = adjustCharacterWalletLPBalance(
      settlement.characterID,
      settlement.loyaltyPointCorporationID,
      -settlement.loyaltyPointsNet,
      {
        changeType: "mission_reward_reversal",
        requireSufficientFunds: true,
        idempotencyKey: settlement.lpReversalKey,
      },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "MISSION_REWARD_LP_REVERSAL_FAILED" };
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      lpReversed: true,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  for (const leg of buildWalletPayoutLegs(settlement).reverse()) {
    settlement = getPendingMissionRewardSettlement(operationID);
    if (roundMoney(settlement[leg.taxPaidField]) > 0 && !settlement[leg.taxReversedField]) {
      const result = await adjustCorporationWalletDivisionBalanceAsync(
        leg.corporationID,
        CORPORATION_WALLET_KEY_START,
        -roundMoney(settlement[leg.taxPaidField]),
        {
          idempotencyKey: leg.taxReversalCommandID,
          description: `${leg.taxDescription} reversal`,
          ownerID1: settlement.characterID,
          ownerID2: leg.corporationID,
          referenceID: settlement.agentID,
          entryTypeID: leg.taxEntryTypeID,
        },
        {
          commandID: leg.taxReversalCommandID,
          source: `agent-mission-${leg.kind}-corporation-tax-reversal`,
        },
      );
      if (!result || result.success !== true) {
        return result ||
          { success: false, errorMsg: "MISSION_REWARD_CORP_TAX_REVERSAL_FAILED" };
      }
      const checkpoint = updateSettlement(operationID, (current) => ({
        ...current,
        [leg.taxReversedField]: true,
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    }

    settlement = getPendingMissionRewardSettlement(operationID);
    if (settlement[leg.appliedField] && !settlement[leg.reversedField] && leg.gross > 0) {
      const result = await adjustCharacterBalanceAsync(
        settlement.characterID,
        -leg.net,
        {
          idempotencyKey: leg.reversalCommandID,
          description: buildRewardDescription(settlement, leg, true),
          ownerID1: settlement.agentID,
          ownerID2: settlement.characterID,
          referenceID: settlement.agentID,
          entryTypeID: leg.entryTypeID,
        },
        {
          commandID: leg.reversalCommandID,
          source: `agent-mission-${leg.kind}-reversal`,
        },
      );
      if (!result || result.success !== true) {
        return result || { success: false, errorMsg: "MISSION_REWARD_WALLET_REVERSAL_FAILED" };
      }
      const checkpoint = updateSettlement(operationID, (current) => ({
        ...current,
        [leg.reversedField]: true,
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  for (const candidate of [...settlement.rewardLegs].reverse()) {
    settlement = getPendingMissionRewardSettlement(operationID);
    const leg = settlement && settlement.rewardLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.granted || leg.revoked || leg.delivered) {
      continue;
    }
    const result = missionRewardItemCustody.revokeReward({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.revokeKey,
    });
    const failure = durableCustodyFailure(result, "MISSION_REWARD_REVOKE_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      rewardLegs: current.rewardLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, revoked: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  for (const candidate of [...settlement.cargoLegs].reverse()) {
    settlement = getPendingMissionRewardSettlement(operationID);
    const leg = settlement && settlement.cargoLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || !leg.staged || leg.returned || leg.committed) {
      continue;
    }
    const result = missionRewardItemCustody.returnCargo({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      destinationLocationID: leg.sourceLocationID,
      destinationFlagID: leg.sourceFlagID,
      idempotencyKey: leg.returnKey,
    });
    const failure = durableCustodyFailure(result, "MISSION_CARGO_RETURN_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      cargoLegs: current.cargoLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, returned: true } : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  const errorMsg = settlement && settlement.rejectionError || "MISSION_REWARD_REJECTED";
  const removed = updateSettlement(operationID, () => null);
  return removed.success
    ? { success: true, rejected: true, errorMsg }
    : removed;
}

async function rejectSettlement(operationID, errorMsg) {
  const checkpoint = updateSettlement(operationID, (current) => ({
    ...current,
    rejectionError: current.rejectionError || errorMsg,
  }));
  if (!checkpoint.success) {
    return checkpoint;
  }
  return compensateRejectedSettlement(operationID);
}

async function finalizeMission(settlement, options = {}) {
  const finalizer = typeof options.finalizeMission === "function"
    ? options.finalizeMission
    : require(path.join(__dirname, "./agentMissionRuntime"))
      .finalizeMissionCompletion;
  if (typeof finalizer !== "function") {
    return { success: false, errorMsg: "MISSION_FINALIZER_UNAVAILABLE" };
  }
  return Promise.resolve(finalizer(
    settlement.characterID,
    settlement.agentRecord,
    settlement.missionRecord,
    { continuationMissionID: settlement.continuationMissionID },
  ));
}

function emitInventoryChanges(settlement, completion, options = {}) {
  if (options.notifyInventory === false) {
    return;
  }
  const runtime = require(path.join(__dirname, "./agentMissionRuntime"));
  if (typeof runtime.notifyMissionInventoryChanges !== "function") {
    return;
  }
  runtime.notifyMissionInventoryChanges(
    settlement.characterID,
    [
      ...(completion.cargoChanges || []),
      ...(completion.rewardChanges || []),
    ],
  );
}

function buildCompletionResult(settlement) {
  return {
    operationID: settlement.operationID,
    missionRecord: cloneValue(settlement.missionRecord),
    wallet: cloneValue(
      settlement.walletResult && settlement.walletResult.data ||
      settlement.walletResult ||
      null,
    ),
    loyaltyPoints: settlement.loyaltyPoints,
    bonusAvailable: settlement.bonusAvailable,
    modifications: cloneValue(
      settlement.standingResult && settlement.standingResult.modifications || [],
    ),
    continuation: cloneValue(
      settlement.finalizationResult && settlement.finalizationResult.continuation || null,
    ),
    cargoChanges: cloneValue(settlement.cargoChanges || []),
    rewardChanges: cloneValue(settlement.rewardChanges || []),
  };
}

async function settleMissionRewardInternal(operationID, options = {}) {
  let settlement = getPendingMissionRewardSettlement(operationID);
  if (!settlement) {
    return { success: true, alreadySettled: true, data: null };
  }
  if (settlement.recoveryHoldError) {
    // The startup recovery pass could not prove whether a money leg already
    // paid -- its authority receipt may have been evicted past the retention cap
    // -- so neither paying nor reversing is safe here: one would double the
    // payout, the other would forfeit it. Refuse without compensating. The job
    // retries, dead-letters and is reported; no money moves until an operator
    // clears the hold.
    return { success: false, errorMsg: settlement.recoveryHoldError };
  }
  if (settlement.rejectionError) {
    return compensateRejectedSettlement(operationID);
  }

  for (const candidate of settlement.cargoLegs) {
    settlement = getPendingMissionRewardSettlement(operationID);
    const leg = settlement && settlement.cargoLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.staged) {
      continue;
    }
    const result = missionRewardItemCustody.stageCargo({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.itemID,
      quantity: leg.quantity,
      sourceLocationID: leg.sourceLocationID,
      sourceFlagID: leg.sourceFlagID,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.stageKey,
    });
    const failure = durableCustodyFailure(result, "MISSION_CARGO_STAGE_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(operationID, failure.errorMsg || "MISSION_CARGO_NOT_FOUND");
    }
    const movedItem = getResultItem(result) || findEscrowItem(settlement, leg, "cargo");
    if (!movedItem) {
      // A staged row that is no longer in escrow, whose commit already ran, is a
      // finished leg with a lost checkpoint — not work to retry.
      if (custodyStepCommitted(leg.commitKey)) {
        const recovered = updateSettlement(operationID, (current) => ({
          ...current,
          cargoLegs: current.cargoLegs.map((entry) =>
            entry.legID === leg.legID
              ? { ...entry, staged: true, committed: true, commitError: null }
              : entry),
        }));
        if (!recovered.success) {
          return recovered;
        }
        continue;
      }
      reportUnresolvedLeg({
        scope: "MissionRewardSettlement",
        operationID: settlement.operationID,
        step: "cargo-stage",
        legID: leg.legID,
        errorMsg: "MISSION_CARGO_ESCROW_UNKNOWN",
      });
      return { success: false, ambiguous: true, errorMsg: "MISSION_CARGO_ESCROW_UNKNOWN" };
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      cargoLegs: current.cargoLegs.map((entry) =>
        entry.legID === leg.legID
          ? { ...entry, staged: true, escrowItemID: toPositiveInt(movedItem.itemID, 0) }
          : entry),
      cargoChanges: [
        ...(current.cargoChanges || []),
        ...buildCargoClientChanges(
          result.data && result.data.changes || [],
          settlement,
          leg,
        ),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  for (const candidate of settlement.rewardLegs) {
    settlement = getPendingMissionRewardSettlement(operationID);
    const leg = settlement && settlement.rewardLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.granted) {
      continue;
    }
    const result = missionRewardItemCustody.grantReward({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      typeID: leg.typeID,
      quantity: leg.quantity,
      blueprintRuns: leg.blueprintRuns,
      original: leg.original,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.grantKey,
    });
    const failure = durableCustodyFailure(result, "MISSION_REWARD_GRANT_FAILED");
    if (failure) {
      return failure.ambiguous === true
        ? failure
        : rejectSettlement(operationID, failure.errorMsg || "MISSION_REWARD_GRANT_FAILED");
    }
    const grantedItem = getResultItem(result) || findEscrowItem(settlement, leg, "reward");
    if (!grantedItem) {
      if (custodyStepCommitted(leg.deliverKey)) {
        const recovered = updateSettlement(operationID, (current) => ({
          ...current,
          rewardLegs: current.rewardLegs.map((entry) =>
            entry.legID === leg.legID
              ? { ...entry, granted: true, delivered: true }
              : entry),
        }));
        if (!recovered.success) {
          return recovered;
        }
        continue;
      }
      reportUnresolvedLeg({
        scope: "MissionRewardSettlement",
        operationID: settlement.operationID,
        step: "reward-grant",
        legID: leg.legID,
        errorMsg: "MISSION_REWARD_ESCROW_UNKNOWN",
      });
      return { success: false, ambiguous: true, errorMsg: "MISSION_REWARD_ESCROW_UNKNOWN" };
    }
    if (toPositiveInt(leg.blueprintRuns, 0) > 0) {
      const blueprintResult = ensureGrantedBlueprintCopyState([grantedItem], {
        runsRemaining: leg.blueprintRuns,
      });
      if (!blueprintResult.success) {
        // The custody receipt owns this item. Leave the settlement pending so
        // a replay can finish its industry state without minting another copy.
        return { ...blueprintResult, ambiguous: true };
      }
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      rewardLegs: current.rewardLegs.map((entry) =>
        entry.legID === leg.legID
          ? { ...entry, granted: true, escrowItemID: toPositiveInt(grantedItem.itemID, 0) }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  for (const leg of buildWalletPayoutLegs(settlement)) {
    settlement = getPendingMissionRewardSettlement(operationID);
    if (leg.gross > 0 && !settlement[leg.appliedField]) {
      const result = await adjustCharacterBalanceAsync(
        settlement.characterID,
        leg.net,
        {
          idempotencyKey: leg.commandID,
          description: buildRewardDescription(settlement, leg),
          ownerID1: toPositiveInt(settlement.agentID, 0),
          ownerID2: settlement.characterID,
          referenceID: settlement.agentID,
          entryTypeID: leg.entryTypeID,
        },
        {
          commandID: leg.commandID,
          source: `agent-mission-${leg.kind}-credit`,
        },
      );
      if (!result || result.success !== true) {
        const errorMsg = result && result.errorMsg || "MISSION_REWARD_WALLET_FAILED";
        return DEFINITIVE_WALLET_ERRORS.has(errorMsg)
          ? rejectSettlement(operationID, errorMsg)
          : result || { success: false, errorMsg };
      }
      const checkpoint = updateSettlement(operationID, (current) => ({
        ...current,
        [leg.appliedField]: true,
        [leg.resultField]: cloneValue(result),
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    }

    settlement = getPendingMissionRewardSettlement(operationID);
    if (leg.tax > 0 && leg.corporationTaxable && !settlement[leg.taxAppliedField]) {
      const result = await adjustCorporationWalletDivisionBalanceAsync(
        leg.corporationID,
        CORPORATION_WALLET_KEY_START,
        leg.tax,
        {
          idempotencyKey: leg.taxCommandID,
          description: leg.taxDescription,
          ownerID1: settlement.characterID,
          ownerID2: leg.corporationID,
          referenceID: settlement.agentID,
          entryTypeID: leg.taxEntryTypeID,
        },
        {
          commandID: leg.taxCommandID,
          source: `agent-mission-${leg.kind}-corporation-tax`,
        },
      );
      const errorMsg = result && result.errorMsg || "MISSION_REWARD_CORP_TAX_FAILED";
      if (
        (!result || result.success !== true) &&
        !isUnpayableCorporationTaxError(errorMsg)
      ) {
        return result || { success: false, errorMsg };
      }
      const paid = result && result.success === true;
      if (!paid) {
        log.warn(
          `[MissionRewardSettlement] corporation ${leg.corporationID} could not ` +
            `receive the ${leg.kind} tax for operation=${operationID}: ${errorMsg}`,
        );
      }
      const checkpoint = updateSettlement(operationID, (current) => ({
        ...current,
        [leg.taxAppliedField]: true,
        [leg.taxPaidField]: paid ? leg.tax : 0,
      }));
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  if (!settlement.lpApplied) {
    // One write of the net: the client pops up every LP change it is told
    // about, so crediting the gross and then debiting the tax shows two.
    const result = adjustCharacterWalletLPBalance(
      settlement.characterID,
      settlement.loyaltyPointCorporationID,
      settlement.loyaltyPointsNet,
      {
        changeType: "mission_reward",
        idempotencyKey: settlement.lpKey,
        // The "Earn LP" daily goal counts LP before corporation tax.
        grossEarned: settlement.loyaltyPoints,
      },
    );
    if (!result || result.success !== true) {
      return rejectSettlement(
        operationID,
        result && result.errorMsg || "MISSION_REWARD_LP_FAILED",
      );
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      lpApplied: true,
      lpResult: cloneValue(result.data || null),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  if (!settlement.corpLpTaxApplied) {
    const corporationID = settlement.loyaltyPointTaxCorporationID;
    const result = adjustCorporationWalletLPBalance(
      corporationID,
      settlement.loyaltyPointCorporationID,
      settlement.loyaltyPointsTax,
      {
        reason: "mission_reward_corporation_tax",
        idempotencyKey: settlement.corpLpTaxKey,
      },
    );
    const errorMsg = result && result.errorMsg || "MISSION_REWARD_CORP_LP_TAX_FAILED";
    if (
      (!result || result.success !== true) &&
      !isUnpayableCorporationTaxError(errorMsg)
    ) {
      return result || { success: false, errorMsg };
    }
    const paid = result && result.success === true;
    if (!paid) {
      log.warn(
        `[MissionRewardSettlement] corporation ${corporationID} could not ` +
          `receive the LP tax for operation=${operationID}: ${errorMsg}`,
      );
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      corpLpTaxApplied: true,
      corpLpTaxPaid: paid ? settlement.loyaltyPointsTax : 0,
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  if (!settlement.standingApplied) {
    const result = standingRuntime.applyStandingChanges(
      settlement.characterID,
      settlement.standingsChanges,
      { idempotencyKey: settlement.standingKey },
    );
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "MISSION_REWARD_STANDING_FAILED" };
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      standingApplied: true,
      standingResult: cloneValue(result.data || null),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  if (!settlement.missionFinalized) {
    const result = await finalizeMission(settlement, options);
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "MISSION_FINALIZATION_FAILED" };
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      missionFinalized: true,
      finalizationResult: cloneValue(result.data || null),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  for (const candidate of settlement.rewardLegs) {
    settlement = getPendingMissionRewardSettlement(operationID);
    const leg = settlement && settlement.rewardLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.delivered) {
      continue;
    }
    const result = missionRewardItemCustody.deliverReward({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      destinationLocationID: leg.destinationLocationID,
      destinationFlagID: leg.destinationFlagID,
      idempotencyKey: leg.deliverKey,
    });
    const failure = durableCustodyFailure(result, "MISSION_REWARD_DELIVERY_FAILED");
    if (failure) {
      return failure;
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      rewardLegs: current.rewardLegs.map((entry) =>
        entry.legID === leg.legID ? { ...entry, delivered: true } : entry),
      rewardChanges: [
        ...(current.rewardChanges || []),
        ...cloneValue(result.data && result.data.changes || []),
      ],
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  for (const candidate of settlement.cargoLegs) {
    settlement = getPendingMissionRewardSettlement(operationID);
    const leg = settlement && settlement.cargoLegs.find(
      (entry) => entry.legID === candidate.legID,
    );
    if (!settlement || !leg || leg.committed) {
      continue;
    }
    const result = missionRewardItemCustody.commitCargo({
      actorID: settlement.characterID,
      ownerID: leg.ownerID,
      itemID: leg.escrowItemID,
      quantity: leg.quantity,
      escrowLocationID: settlement.escrowLocationID,
      idempotencyKey: leg.commitKey,
    });
    const failure = durableCustodyFailure(result, "MISSION_CARGO_COMMIT_FAILED");
    if (failure && failure.ambiguous === true) {
      return failure;
    }
    const checkpoint = updateSettlement(operationID, (current) => ({
      ...current,
      cargoLegs: current.cargoLegs.map((entry) =>
        entry.legID === leg.legID
          ? {
              ...entry,
              committed: true,
              commitError: failure ? failure.errorMsg : null,
            }
          : entry),
    }));
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  const completion = buildCompletionResult(settlement);
  const removed = updateSettlement(operationID, () => null);
  if (!removed.success) {
    return removed;
  }
  emitInventoryChanges(settlement, completion, options);
  return { success: true, data: completion };
}

function settleMissionRewardSettlement(operationID, options = {}) {
  const settlement = getPendingMissionRewardSettlement(operationID);
  const characterID = settlement && settlement.characterID;
  if (!characterID) {
    return Promise.resolve({ success: true, alreadySettled: true, data: null });
  }
  return runSerialized(characterID, () =>
    settleMissionRewardInternal(operationID, options));
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("mission reward scheduler requires schedule");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function handleDurableMissionRewardSettlement(job = {}) {
  const operationID = String(job.payload && job.payload.operationID || "").trim();
  if (!operationID) {
    throw new Error("mission reward settlement job is invalid");
  }
  // A settlement step that *throws* used to bypass this reporting entirely --
  // the escalation only ran for failure-shaped results -- which is how one
  // settlement failed 297 times without producing a line at any log level.
  let result = null;
  try {
    result = await settleMissionRewardSettlement(operationID);
  } catch (error) {
    const errorMsg = error && error.message || "mission reward settlement threw";
    reportSettlementRetry({
      scope: "MissionRewardSettlement",
      attempt: job.attempt,
      ownerID: operationID,
      errorMsg,
    });
    throw error;
  }
  if (!result || result.success !== true) {
    const errorMsg = result && result.errorMsg || "mission reward settlement failed";
    reportSettlementRetry({
      scope: "MissionRewardSettlement",
      attempt: job.attempt,
      ownerID: operationID,
      errorMsg,
    });
    throw new Error(errorMsg);
  }
  return result;
}

async function cancelSettlementJob(operationID) {
  const job = buildSettlementJob(operationID);
  if (!job || !durableScheduler || typeof durableScheduler.cancel !== "function") {
    return false;
  }
  try {
    await durableScheduler.cancel(job.jobID);
    return true;
  } catch (error) {
    log.warn(
      `[MissionRewardSettlement] could not cancel durable job ${job.jobID}: ` +
        `${error.message}`,
    );
    return false;
  }
}

async function listDeadLetteredSettlementJobIDs() {
  if (!durableScheduler || typeof durableScheduler.list !== "function") {
    return [];
  }
  try {
    const jobs = await durableScheduler.list();
    return (Array.isArray(jobs) ? jobs : [])
      .filter((job) =>
        job &&
        job.type === DURABLE_SETTLEMENT_JOB_TYPE &&
        job.state === "dead-letter")
      .map((job) => String(job.jobID));
  } catch (error) {
    log.warn(
      `[MissionRewardSettlement] could not list durable jobs: ${error.message}`,
    );
    return [];
  }
}

/**
 * Write reconciled checkpoints onto a pending settlement. Reserved for the
 * startup recovery pass, which derives them from the authority ledgers rather
 * than from the settlement's own (untrustworthy) flags.
 */
function setStartupRecovery(recovery) {
  if (!recovery || typeof recovery.prepareStartupRecoveryBarrier !== "function") {
    throw new TypeError("mission reward startup recovery requires prepareStartupRecoveryBarrier");
  }
  startupRecovery = recovery;
}

function applyRecoveredCheckpoints(operationID, updater) {
  return updateSettlement(operationID, updater);
}

async function reconcileDurableMissionRewardSettlements(options = {}) {
  // The heal runs before anything is queued, on purpose. Re-scheduling a wedged
  // settlement first would hand it straight back to the retry loop that has been
  // failing it, and the pass would then be racing the very job it is repairing.
  let healRan = options.heal === false ? null : false;
  let healError = null;
  if (options.heal !== false) {
    const recovery = options.recovery || startupRecovery;
    try {
      if (!recovery) {
        const missing = new Error(
          "the mission reward recovery pass is not loaded (missionRewardSettlementJobs.js loads it)",
        );
        missing.code = "MISSION_REWARD_RECOVERY_NOT_LOADED";
        throw missing;
      }
      await recovery.prepareStartupRecoveryBarrier("scheduler-startup", options);
      healRan = true;
    } catch (error) {
      // NOT swallowed into a warn, and NOT fatal either.
      //
      // This used to be a log.warn, and that is precisely how a boot where the
      // heal never ran at all looked exactly like a boot where it ran and found
      // nothing -- one line among the startup warnings, for as long as it took
      // someone to read it. The barrier is the only thing that unwedges a
      // settlement whose durable job retries forever and blocks every later
      // turn-in for that character/agent pair, so "it did not run" is an error.
      //
      // Rethrowing would be worse. This call is awaited inside
      // productionSchedulerRuntime.start(), whose rejection makes server/index.js
      // exit(1) -- so one unhealable settlement, or any bug in the pass itself,
      // would leave the server unstartable with no way in to fix it. The pass is
      // already tolerant per settlement (it leaves what it cannot classify
      // pending and reports it); the boot inherits that stance. Loudly degraded
      // beats not booting.
      healError = {
        code: (error && error.code) || null,
        message: (error && error.message) || "UNKNOWN",
      };
      log.err(
        `[MissionRewardStartup] HEALING DID NOT RUN: the startup recovery ` +
          `barrier threw before reconciling any settlement ` +
          `(${healError.code || "NO_CODE"}: ${healError.message}). Wedged mission ` +
          `reward settlements stay wedged -- their durable jobs keep retrying and ` +
          `every later mission turn-in for those character/agent pairs stays ` +
          `blocked. Startup continues so the server still comes up; this needs ` +
          `operator attention.`,
      );
    }
  }
  const pending = listPendingMissionRewardSettlements();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length, healRan, healError };
  }
  await Promise.all(pending.map((settlement) =>
    scheduleSettlement(settlement.operationID)));
  return {
    scheduled: pending.length,
    pending: pending.length,
    healRan,
    healError,
  };
}

module.exports = {
  DURABLE_SETTLEMENT_JOB_TYPE,
  ESCROW_LOCATION_BASE,
  TABLE_NAME,
  applyRecoveredCheckpoints,
  bindDurableScheduler,
  buildSettlementJob,
  buildWalletPayoutLegs,
  cancelSettlementJob,
  findPendingMissionRewardSettlement,
  getPendingMissionRewardSettlement,
  handleDurableMissionRewardSettlement,
  listDeadLetteredSettlementJobIDs,
  listPendingMissionRewardSettlements,
  normalizeStoredSettlement,
  prepareMissionRewardSettlement,
  reconcileDurableMissionRewardSettlements,
  setStartupRecovery,
  settleMissionRewardSettlement,
  unbindDurableScheduler,
};
