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
  getOperationReceipt: getLpOperationReceipt,
} = require(path.join(__dirname, "../corporation/lpWalletState"));
const walletAuthorityReceiptState = require(path.join(
  __dirname,
  "../account/walletAuthorityReceiptState",
));
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
const {
  buildSecurityTaxDescription,
  computeAgentMissionSecurityTax,
} = require(path.join(__dirname, "../security/securityTax"));
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
// The LP credit's final refusals. Every other LP error, the storage failures
// (WRITE_FAILED, LP_WALLET_FLUSH_FAILED) included, is temporary: the leg
// returns it and the durable job retries.
const DEFINITIVE_LP_ERRORS = new Set([
  "INVALID_OWNER_OR_ISSUER",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_REUSED",
]);
// A sharer's standing leg's final refusals. Every other refusal, a storage write
// failure of the character record included, is temporary.
const DEFINITIVE_STANDING_ERRORS = new Set([
  "CHARACTER_NOT_FOUND",
  "STANDING_CHANGE_REQUIRED",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_KEY_REUSED",
]);
// The completing pilot's part lives in the settlement's own fields; each
// sharer's in settlement.shares[index].
const COMPLETING_PILOT = -1;
// Every recipient's paying legs: the field holding the leg's key, and the leg's
// name. The completing pilot's key is
// mission-reward:<characterID>:<missionSequence>:<generation>:<leg>; a sharer's
// is mission-reward:<characterID>:<missionSequence>:<generation>:share:
// <sharerID>:<leg>. The generation is the prepare attempt's (buildKeyBase), and
// both keep the mission-reward:<characterID>:<missionSequence>: prefix the
// recovery's sequence watermark reads. A settlement stored before generations
// keeps its mission-reward:<characterID>:<missionSequence>:<leg> keys.
const LEG_KEY_FIELDS = Object.freeze({
  walletCommandID: "wallet-credit",
  corpTaxCommandID: "corp-tax-credit",
  walletBonusCommandID: "wallet-bonus-credit",
  corpBonusTaxCommandID: "corp-bonus-tax-credit",
  lpKey: "lp-credit",
  corpLpTaxKey: "corp-lp-tax-credit",
  standingKey: "standing",
});
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

function blueprintEfficiencyMetadata(record) {
  if (!(toPositiveInt(record?.blueprintRuns, 0) > 0) ||
      (record.blueprintMaterialLevel === undefined && record.blueprintProductivityLevel === undefined)) return {};
  return { blueprintMaterialLevel: toFlag(record.blueprintMaterialLevel, 0),
    blueprintProductivityLevel: toFlag(record.blueprintProductivityLevel, 0) };
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
// row. The security tax keys beside it make it draw CONCORD's row and show the
// full reward: each recipient's own part, since every recipient's leg is its
// own journal entry. A reversal carries none: the client draws no row for a
// negative security tax. Untaxed payouts carry a plain scalar (no colons, so it
// parses as a string and yields no derived rows) that reads the way the
// client's line does.
function buildRewardDescription(
  settlement,
  leg,
  reversal = false,
  recipientID = settlement && settlement.characterID,
) {
  const corporationTax = leg.tax > 0 && leg.corporationID > 0
    ? buildCorporationTaxDescription(
      leg.taxEntryTypeID,
      leg.corporationID,
      leg.tax,
      { reversal },
    )
    : "";
  if (leg.securityTax > 0 && !reversal) {
    return buildSecurityTaxDescription(
      "grossRewardAmount",
      leg.gross,
      leg.securityTax,
      corporationTax ? { into: corporationTax } : {},
    );
  }
  if (corporationTax) {
    return corporationTax;
  }
  const agentName = resolveAgentName(settlement);
  const characterName = resolveCharacterName(recipientID);
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
      securityTax: roundMoney(settlement && settlement.walletRewardSecurityTax),
      tax: roundMoney(settlement && settlement.walletRewardTax),
      corporationID,
      corporationTaxable,
      entryTypeID: JOURNAL_ENTRY_TYPE.AGENT_MISSION_REWARD,
      taxEntryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_TAX_AGENT_REWARDS,
      taxDescription: "Corporation tax on mission rewards",
      legName: LEG_KEY_FIELDS.walletCommandID,
      taxLegName: LEG_KEY_FIELDS.corpTaxCommandID,
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
      securityTax: roundMoney(settlement && settlement.walletBonusSecurityTax),
      tax: roundMoney(settlement && settlement.walletBonusTax),
      corporationID,
      corporationTaxable,
      entryTypeID: JOURNAL_ENTRY_TYPE.AGENT_MISSION_TIME_BONUS_REWARD,
      taxEntryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_TAX_AGENT_BONUS_REWARDS,
      taxDescription: "Corporation tax on mission bonus rewards",
      legName: LEG_KEY_FIELDS.walletBonusCommandID,
      taxLegName: LEG_KEY_FIELDS.corpBonusTaxCommandID,
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
  ].map((leg) => ({ ...leg, net: roundMoney(leg.gross - leg.securityTax - leg.tax) }));
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
  // A key is absent only from a record prepared before that key existed, and
  // every such record predates key generations, so the backfill builds the
  // pre-generation shape, mission-reward:<operationID>:<leg>. A record prepared
  // since stores every key, and keeps the keys it stored.
  const key = (suffix) => `${DURABLE_SETTLEMENT_JOB_PREFIX}${operationID}:${suffix}`;

  fill("walletReward", 0);
  fill("walletRewardTax", 0);
  fill("walletBonusReward", 0);
  fill("walletBonusTax", 0);
  // A record prepared before the Safe Security tax was quoted the full reward.
  fill("walletRewardSecurityTax", 0);
  fill("walletBonusSecurityTax", 0);
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
  // Absent means accepted by the old rounded implementation. This must remain
  // false even if a standing receipt committed before its checkpoint did.
  fill("standingPreservePrecision", false);
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
  // A record prepared before fleet shares has no sharer to pay.
  normalized.shares = Array.isArray(normalized.shares) ? normalized.shares : [];

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

function normalizeCargoLeg(input, index, keyBase) {
  return {
    legID: index + 1,
    itemID: toPositiveInt(input && input.itemID, 0),
    typeID: toPositiveInt(input && input.typeID, 0),
    quantity: toPositiveInt(input && input.quantity, 0),
    ownerID: toPositiveInt(input && input.ownerID, 0),
    sourceLocationID: toPositiveInt(input && input.locationID, 0),
    sourceFlagID: toFlag(input && input.flagID, 0),
    stageKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:cargo:${index + 1}:stage`,
    returnKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:cargo:${index + 1}:return`,
    commitKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:cargo:${index + 1}:commit`,
    staged: false,
    returned: false,
    committed: false,
    commitError: null,
    escrowItemID: 0,
  };
}

function normalizeRewardLeg(output, index, keyBase, target) {
  return {
    legID: index + 1,
    typeID: toPositiveInt(output && output.typeID, 0),
    quantity: toPositiveInt(output && output.quantity, 0),
    ...(toPositiveInt(output && output.blueprintRuns, 0) > 0
      ? { blueprintRuns: toPositiveInt(output.blueprintRuns, 0) }
      : {}),
    ...blueprintEfficiencyMetadata(output),
    ...(output && output.original === true ? { original: true } : {}),
    ownerID: target.ownerID,
    destinationLocationID: target.locationID,
    destinationFlagID: target.flagID,
    grantKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:reward:${index + 1}:grant`,
    deliverKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:reward:${index + 1}:deliver`,
    revokeKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:reward:${index + 1}:revoke`,
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
        ...blueprintEfficiencyMetadata(output),
        ...(output.original === true ? { original: true } : {}),
      });
      remaining -= quantity;
    }
  }
  return result;
}

// An absent amount is 0; anything else must be a number. NaN marks a value the
// check refuses.
function readAmount(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  return typeof value === "number" || typeof value === "string"
    ? Number(value)
    : Number.NaN;
}

function isIskAmount(value) {
  return Number.isFinite(value) &&
    value >= 0 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function isLoyaltyPointAmount(value) {
  return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

// A recipient's standing changes, kept as given. [] when there are none; null
// when they are malformed.
function readStandingChanges(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) &&
    value.every((change) => Number.isFinite(readAmount(change && change.rawChange)))
    ? value
    : null;
}

// One recipient's part as prepare was given it, with whether its amounts pass
// the check: ISK and time bonus in whole cents, LP in whole points, each ≥ 0,
// and every standing amount finite.
function readRecipientPart(input) {
  const walletReward = readAmount(input.walletReward);
  const walletBonusReward = readAmount(input.walletBonusReward);
  const loyaltyPoints = readAmount(input.loyaltyPoints);
  const standingsChanges = readStandingChanges(input.standingsChanges);
  return {
    characterID: toPositiveInt(input.characterID, 0),
    walletReward: isIskAmount(walletReward) ? roundMoney(walletReward) : walletReward,
    walletBonusReward: isIskAmount(walletBonusReward)
      ? roundMoney(walletBonusReward)
      : walletBonusReward,
    loyaltyPoints,
    standingsChanges: standingsChanges || [],
    amountsValid: isIskAmount(walletReward) &&
      isIskAmount(walletBonusReward) &&
      isLoyaltyPointAmount(loyaltyPoints) &&
      standingsChanges !== null,
  };
}

// The sharers' entries, or null when `shares` is malformed: not an array, an
// entry without a positive characterID, the completing pilot named again, or a
// recipient named twice.
function readShares(value, completingCharacterID) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const seen = new Set([completingCharacterID]);
  const shares = [];
  for (const entry of value) {
    const characterID = entry && typeof entry === "object"
      ? Number(entry.characterID)
      : 0;
    if (!Number.isSafeInteger(characterID) || characterID <= 0 || seen.has(characterID)) {
      return null;
    }
    seen.add(characterID);
    shares.push(readRecipientPart(entry));
  }
  return shares;
}

// Every key a settlement stores is built on its key base,
// <operationID>:<generation>, so mission-reward:<characterID>:<missionSequence>:
// <generation>:... . The generation is the settlement's operation sequence,
// which never repeats, so a turn-in prepared again after a rejected settlement
// was reversed and removed meets none of the old attempt's receipts.
function buildKeyBase(operationID, generation) {
  return `${operationID}:${generation}`;
}

function buildLegKeys(keyBase, characterID = 0) {
  const recipient = characterID ? `share:${characterID}:` : "";
  return Object.fromEntries(Object.entries(LEG_KEY_FIELDS).map(([field, leg]) => [
    field,
    `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:${recipient}${leg}`,
  ]));
}

function isWellFormedLegKey(key, keyBase) {
  return typeof key === "string" &&
    key.startsWith(`${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:`) &&
    !/\s/.test(key);
}

// "Unused": no receipt yet under the key, judged only through its own ledger's
// reader. A reader that throws (a failed store read) is never taken as unused:
// the error reaches prepare's caller, with nothing stored and no one named.
function isLegKeyUsed(field, key, characterID, corporationID) {
  switch (field) {
    case "walletCommandID":
    case "walletBonusCommandID":
      return Boolean(walletAuthorityReceiptState.findOwnerReceipt(
        { kind: "character", ownerID: characterID },
        key,
      ));
    case "corpTaxCommandID":
    case "corpBonusTaxCommandID":
      return Boolean(walletAuthorityReceiptState.findOwnerReceipt(
        { kind: "corporation", ownerID: corporationID },
        key,
      ));
    case "lpKey":
    case "corpLpTaxKey":
      return Boolean(getLpOperationReceipt(key));
    case "standingKey":
      return standingRuntime.hasStandingOperationReceipt(characterID, key) === true;
    default:
      return true;
  }
}

function isTaxRate(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

// The check before storage, for one recipient: the character exists, the
// amounts are valid, an LP part has a valid LP corporation, the corporation
// and its rates resolve, and every leg's key is well formed and unused.
// Answers the corporation tax profile to lock in, or null when a check fails.
function checkRecipient(part, keys, keyBase, loyaltyPointCorporationID) {
  if (!part.amountsValid || !peekCharacterRecord(part.characterID)) {
    return null;
  }
  if (part.loyaltyPoints > 0 && !loyaltyPointCorporationID) {
    return null;
  }
  const profile = resolveCorporationTaxProfile(part.characterID);
  if (
    !profile ||
    toPositiveInt(profile.corporationID, 0) <= 0 ||
    !isTaxRate(profile.taxRate) ||
    !isTaxRate(profile.loyaltyPointTaxRate)
  ) {
    return null;
  }
  const keysUsable = Object.keys(LEG_KEY_FIELDS).every((field) =>
    isWellFormedLegKey(keys[field], keyBase) &&
    !isLegKeyUsed(field, keys[field], part.characterID, profile.corporationID));
  return keysUsable ? profile : null;
}

// One recipient's taxes, locked in at prepare: each deposit taxed on its own
// amount, LP net of the corporation's LP tax. CONCORD's Safe Security share of
// each ISK deposit comes off first and the corporation taxes what is left: the
// client's corporation tax row reads its rate as the tax over the payout plus
// the tax (transactionsUtil._GetDerivedCorporationTaxTransaction), which is the
// corporation's rate only on that remainder. The security tax is the agent's,
// so it falls on every recipient's part alike, each part rounded on its own:
// the client reads each journal entry's own gross and tax
// (_GetDerivedSecurityTaxTransaction) and never sees the whole reward.
function lockRecipientTax(part, profile, agentRecord) {
  const rewardSecurityTax = computeAgentMissionSecurityTax(agentRecord, part.walletReward);
  const bonusSecurityTax = computeAgentMissionSecurityTax(agentRecord, part.walletBonusReward);
  const rewardTax = computeCorporationTax(
    profile,
    CORPORATION_TAX_CURRENCY.ISK,
    rewardSecurityTax.net,
  );
  const bonusTax = computeCorporationTax(
    profile,
    CORPORATION_TAX_CURRENCY.ISK,
    bonusSecurityTax.net,
  );
  const loyaltyPointTax = computeCorporationTax(
    profile,
    CORPORATION_TAX_CURRENCY.LP,
    part.loyaltyPoints,
  );
  return { rewardSecurityTax, bonusSecurityTax, rewardTax, bonusTax, loyaltyPointTax };
}

// A sharer's part as stored: the completing pilot's field names, so the same
// leg descriptors pay it, with no reversal keys, since a sharer is never
// reversed.
function buildSharePart(part, profile, keys, agentRecord) {
  const {
    rewardSecurityTax,
    bonusSecurityTax,
    rewardTax,
    bonusTax,
    loyaltyPointTax,
  } = lockRecipientTax(part, profile, agentRecord);
  return {
    characterID: part.characterID,
    walletReward: part.walletReward,
    walletRewardSecurityTax: rewardSecurityTax.tax,
    walletRewardTax: rewardTax.tax,
    walletBonusReward: part.walletBonusReward,
    walletBonusSecurityTax: bonusSecurityTax.tax,
    walletBonusTax: bonusTax.tax,
    taxCorporationID: profile.corporationID,
    taxCorporationIsNPC: profile.isNPC,
    taxRate: profile.taxRate,
    loyaltyPoints: part.loyaltyPoints,
    loyaltyPointsTax: loyaltyPointTax.tax,
    loyaltyPointsNet: loyaltyPointTax.net,
    loyaltyPointTaxRate: profile.loyaltyPointTaxRate,
    loyaltyPointTaxCorporationID: loyaltyPointTax.credit ? profile.corporationID : 0,
    standingsChanges: cloneValue(part.standingsChanges),
    ...keys,
    walletApplied: part.walletReward <= 0,
    walletResult: null,
    walletBonusApplied: part.walletBonusReward <= 0,
    walletBonusResult: null,
    corpTaxApplied: !rewardTax.credit,
    corpTaxPaid: 0,
    corpBonusTaxApplied: !bonusTax.credit,
    corpBonusTaxPaid: 0,
    lpApplied: part.loyaltyPoints <= 0,
    lpResult: null,
    corpLpTaxApplied: !loyaltyPointTax.credit,
    corpLpTaxPaid: 0,
    standingApplied: part.standingsChanges.length <= 0,
    standingResult: part.standingsChanges.length <= 0
      ? { modifications: [], appliedChanges: [] }
      : null,
    // Legs that failed for good, by leg name, with the error: logged, never
    // attempted again, never reversed.
    skippedLegs: {},
  };
}

function prepareMissionRewardSettlement(options = {}) {
  const characterID = toPositiveInt(options.characterID, 0);
  const agentID = toPositiveInt(options.agentID, 0);
  const missionSequence = toPositiveInt(options.missionSequence, 0);
  const operationID = `${characterID}:${missionSequence}`;
  const pilotPart = readRecipientPart({ ...options, characterID });
  const shares = readShares(options.shares, characterID);
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
  const { walletReward, walletBonusReward, loyaltyPoints } = pilotPart;
  const continuationMissionID = options.continuationMissionID === null ||
    options.continuationMissionID === undefined
    ? null
    : cloneValue(options.continuationMissionID);
  const loyaltyPointCorporationID = toPositiveInt(
    options.loyaltyPointCorporationID,
    0,
  );
  if (
    !characterID ||
    !agentID ||
    !missionSequence ||
    !shares ||
    !pilotPart.amountsValid ||
    (rewardItems.length > 0 && (!target.ownerID || !target.locationID)) ||
    (loyaltyPoints > 0 && !loyaltyPointCorporationID)
  ) {
    return { success: false, errorMsg: "INVALID_MISSION_REWARD_SETTLEMENT" };
  }

  // Shares join the fingerprint only when present, so a pending settlement
  // prepared before shares existed still matches its own turn-in.
  const sharedParts = {};
  if (shares.length > 0) {
    sharedParts.shares = shares.map((entry) => ({
      characterID: entry.characterID,
      walletReward: entry.walletReward,
      walletBonusReward: entry.walletBonusReward,
      loyaltyPoints: entry.loyaltyPoints,
      standingsChanges: entry.standingsChanges,
    }));
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
      ...blueprintEfficiencyMetadata(entry),
      ...(entry && entry.original === true ? { original: true } : {}),
    })),
    walletReward,
    walletBonusReward,
    loyaltyPoints,
    loyaltyPointCorporationID,
    standingsChanges,
    continuationMissionID,
    ...sharedParts,
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
  // This prepare attempt's key generation is its operation sequence.
  const keyBase = buildKeyBase(operationID, operationSequence);
  const cargoLegs = cargoInputs.map((entry, index) =>
    normalizeCargoLeg(entry, index, keyBase));
  const rewardLegs = splitRewardLegs(rewardItems).map((entry, index) =>
    normalizeRewardLeg(entry, index, keyBase, target));
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

  // Every leg of every recipient is checked before anything is stored, so
  // before the first deposit. The completing pilot failing answers the turn-in's
  // own error; every failing sharer is named, for Agent missions to drop.
  const pilotKeys = buildLegKeys(keyBase);
  const corporationTax = checkRecipient(
    pilotPart,
    pilotKeys,
    keyBase,
    loyaltyPointCorporationID,
  );
  if (!corporationTax) {
    return { success: false, errorMsg: "INVALID_MISSION_REWARD_SETTLEMENT" };
  }
  const failedCharacterIDs = [];
  const shareParts = [];
  for (const entry of shares) {
    const keys = buildLegKeys(keyBase, entry.characterID);
    const profile = checkRecipient(entry, keys, keyBase, loyaltyPointCorporationID);
    if (!profile) {
      failedCharacterIDs.push(entry.characterID);
      continue;
    }
    shareParts.push(buildSharePart(entry, profile, keys, options.agentRecord));
  }
  if (failedCharacterIDs.length > 0) {
    return {
      success: false,
      errorMsg: "MISSION_REWARD_SHARER_INVALID",
      failedCharacterIDs,
    };
  }

  // Each recipient's corporation and rates are locked in here, so a replayed
  // settlement pays exactly what it was quoted, even if a recipient changes
  // corporation mid-flight.
  const {
    rewardSecurityTax,
    bonusSecurityTax,
    rewardTax,
    bonusTax,
    loyaltyPointTax,
  } = lockRecipientTax(pilotPart, corporationTax, options.agentRecord);
  const walletRewardTax = rewardTax.tax;
  const walletBonusTax = bonusTax.tax;
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
    walletRewardSecurityTax: rewardSecurityTax.tax,
    walletRewardTax,
    walletBonusReward,
    walletBonusSecurityTax: bonusSecurityTax.tax,
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
    // Server-assigned policy, frozen with this intent. Keep requestFingerprint
    // stable so retries of an old prepared request still find that old intent.
    standingPreservePrecision: true,
    shares: shareParts,
    continuationMissionID,
    missionRecord: cloneValue(options.missionRecord || null),
    agentRecord: cloneValue(options.agentRecord || null),
    bonusAvailable: options.bonusAvailable === true,
    // The paying keys are the ones the check above found unused.
    ...pilotKeys,
    walletReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:wallet-reversal`,
    walletBonusReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:wallet-bonus-reversal`,
    corpTaxReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:corp-tax-reversal`,
    corpBonusTaxReversalCommandID:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:corp-bonus-tax-reversal`,
    lpReversalKey: `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:lp-reversal`,
    corpLpTaxReversalKey:
      `${DURABLE_SETTLEMENT_JOB_PREFIX}${keyBase}:corp-lp-tax-reversal`,
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
  // A standing change can't be taken back, so a settlement whose completing
  // pilot's standing part has been applied is past reversal. Their standing leg
  // comes after their money legs, and no sharer is paid before it.
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

function readRecipientPartOf(settlement, index) {
  if (!settlement) {
    return null;
  }
  return index === COMPLETING_PILOT ? settlement : settlement.shares[index] || null;
}

function checkpointRecipient(operationID, index, patch) {
  return updateSettlement(operationID, (current) => (index === COMPLETING_PILOT
    ? { ...current, ...patch }
    : {
        ...current,
        shares: current.shares.map((part, partIndex) =>
          partIndex === index ? { ...part, ...patch } : part),
      }));
}

// Whether a recipient's leg is checkpointed as skipped (failed for good). The
// live path and the startup recovery pass share this one reading.
function isLegSkipped(part, legName) {
  return Boolean(part && part.skippedLegs && part.skippedLegs[legName]);
}

// A sharer's leg that failed for good, money or standing: logged and
// checkpointed as skipped with its tax leg (a money leg's), so no retry or
// restart attempts it again. Nothing is reversed and nothing redistributed.
function skipShareLegs(operationID, index, legNames, errorMsg) {
  const part = readRecipientPartOf(getPendingMissionRewardSettlement(operationID), index);
  log.warn(
    `[MissionRewardSettlement] operation=${operationID} sharer=${part.characterID} ` +
      `leg=${legNames[0]} failed for good: ${errorMsg}; skipped with its tax, ` +
      `nothing reversed`,
  );
  const skippedLegs = { ...(part.skippedLegs || {}) };
  for (const legName of legNames) {
    skippedLegs[legName] = errorMsg;
  }
  return checkpointRecipient(operationID, index, { skippedLegs });
}

// A recipient's standing part, with the recipient's own key, under the policy
// the settlement froze at prepare. Their own Social applies.
function applyRecipientStanding(settlement, part) {
  return standingRuntime.applyStandingChanges(
    part.characterID,
    part.standingsChanges,
    {
      idempotencyKey: part.standingKey,
      preservePrecision: settlement.standingPreservePrecision === true,
    },
  );
}

// Pays one recipient's legs in the entry's order: ISK and its tax, time bonus
// and its tax, LP and its LP tax, then standing; each checkpointed. Answers
// null once every leg is paid or skipped, or the result the settle returns: a
// temporary failure (the durable job retries), a failed checkpoint, or the
// completing pilot's rejection.
async function payRecipientLegs(operationID, index) {
  const isCompletingPilot = index === COMPLETING_PILOT;
  let settlement = getPendingMissionRewardSettlement(operationID);
  let part = readRecipientPartOf(settlement, index);
  for (const leg of buildWalletPayoutLegs(part)) {
    settlement = getPendingMissionRewardSettlement(operationID);
    part = readRecipientPartOf(settlement, index);
    if (leg.gross > 0 && !part[leg.appliedField] && !isLegSkipped(part, leg.legName)) {
      const result = await adjustCharacterBalanceAsync(
        part.characterID,
        leg.net,
        {
          idempotencyKey: leg.commandID,
          description: buildRewardDescription(settlement, leg, false, part.characterID),
          ownerID1: toPositiveInt(settlement.agentID, 0),
          ownerID2: part.characterID,
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
        if (!DEFINITIVE_WALLET_ERRORS.has(errorMsg)) {
          return result || { success: false, errorMsg };
        }
        if (isCompletingPilot) {
          return rejectSettlement(operationID, errorMsg);
        }
        const skipped = skipShareLegs(operationID, index, [leg.legName, leg.taxLegName], errorMsg);
        if (!skipped.success) {
          return skipped;
        }
        continue;
      }
      const checkpoint = checkpointRecipient(operationID, index, {
        [leg.appliedField]: true,
        [leg.resultField]: cloneValue(result),
      });
      if (!checkpoint.success) {
        return checkpoint;
      }
    }

    settlement = getPendingMissionRewardSettlement(operationID);
    part = readRecipientPartOf(settlement, index);
    if (
      leg.tax > 0 &&
      leg.corporationTaxable &&
      !part[leg.taxAppliedField] &&
      !isLegSkipped(part, leg.taxLegName)
    ) {
      const result = await adjustCorporationWalletDivisionBalanceAsync(
        leg.corporationID,
        CORPORATION_WALLET_KEY_START,
        leg.tax,
        {
          idempotencyKey: leg.taxCommandID,
          description: leg.taxDescription,
          ownerID1: part.characterID,
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
      const checkpoint = checkpointRecipient(operationID, index, {
        [leg.taxAppliedField]: true,
        [leg.taxPaidField]: paid ? leg.tax : 0,
      });
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  part = readRecipientPartOf(settlement, index);
  if (!part.lpApplied && !isLegSkipped(part, LEG_KEY_FIELDS.lpKey)) {
    // One write of the net: the client pops up every LP change it is told
    // about, so crediting the gross and then debiting the tax shows two.
    const result = adjustCharacterWalletLPBalance(
      part.characterID,
      settlement.loyaltyPointCorporationID,
      part.loyaltyPointsNet,
      {
        changeType: "mission_reward",
        idempotencyKey: part.lpKey,
        // The "Earn LP" daily goal counts LP before corporation tax.
        grossEarned: part.loyaltyPoints,
      },
    );
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "MISSION_REWARD_LP_FAILED";
      if (!DEFINITIVE_LP_ERRORS.has(errorMsg)) {
        return result || { success: false, errorMsg };
      }
      if (isCompletingPilot) {
        return rejectSettlement(operationID, errorMsg);
      }
      const skipped = skipShareLegs(
        operationID,
        index,
        [LEG_KEY_FIELDS.lpKey, LEG_KEY_FIELDS.corpLpTaxKey],
        errorMsg,
      );
      if (!skipped.success) {
        return skipped;
      }
    } else {
      const checkpoint = checkpointRecipient(operationID, index, {
        lpApplied: true,
        lpResult: cloneValue(result.data || null),
      });
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  part = readRecipientPartOf(settlement, index);
  if (!part.corpLpTaxApplied && !isLegSkipped(part, LEG_KEY_FIELDS.corpLpTaxKey)) {
    const corporationID = part.loyaltyPointTaxCorporationID;
    const result = adjustCorporationWalletLPBalance(
      corporationID,
      settlement.loyaltyPointCorporationID,
      part.loyaltyPointsTax,
      {
        reason: "mission_reward_corporation_tax",
        idempotencyKey: part.corpLpTaxKey,
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
    const checkpoint = checkpointRecipient(operationID, index, {
      corpLpTaxApplied: true,
      corpLpTaxPaid: paid ? part.loyaltyPointsTax : 0,
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
  }

  settlement = getPendingMissionRewardSettlement(operationID);
  part = readRecipientPartOf(settlement, index);
  if (!part.standingApplied && !isLegSkipped(part, LEG_KEY_FIELDS.standingKey)) {
    // A duplicate: true answer is success: the gain was applied before.
    const result = applyRecipientStanding(settlement, part);
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "MISSION_REWARD_STANDING_FAILED";
      // The completing pilot's standing retries every refusal; only a sharer's
      // final refusal is skipped.
      if (isCompletingPilot || !DEFINITIVE_STANDING_ERRORS.has(errorMsg)) {
        return result || { success: false, errorMsg };
      }
      const skipped = skipShareLegs(
        operationID,
        index,
        [LEG_KEY_FIELDS.standingKey],
        errorMsg,
      );
      if (!skipped.success) {
        return skipped;
      }
      return null;
    }
    // Character gains and their idempotency receipt must reach stable storage
    // before the separate settlement checkpoint can outlive this process.
    let standingFlush;
    try {
      standingFlush = database.flushTableSync("characters");
    } catch (_error) {
      return { success: false, errorMsg: "MISSION_REWARD_STANDING_FLUSH_FAILED" };
    }
    if (!standingFlush || standingFlush.success !== true) {
      return standingFlush || { success: false, errorMsg: "MISSION_REWARD_STANDING_FLUSH_FAILED" };
    }
    const checkpoint = checkpointRecipient(operationID, index, {
      standingApplied: true,
      standingResult: cloneValue(result.data || null),
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
  }
  return null;
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
        materialEfficiency: leg.blueprintMaterialLevel,
        timeEfficiency: leg.blueprintProductivityLevel,
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

  // The completing pilot's legs first, money before standing, since their
  // reversal can't take a standing change back; then each sharer's, in the
  // order `shares` gave. A sharer is never reversed, so nothing after the
  // completing pilot's legs can reject the settlement.
  const pilotOutcome = await payRecipientLegs(operationID, COMPLETING_PILOT);
  if (pilotOutcome) {
    return pilotOutcome;
  }
  settlement = getPendingMissionRewardSettlement(operationID);
  for (let index = 0; index < settlement.shares.length; index += 1) {
    const shareOutcome = await payRecipientLegs(operationID, index);
    if (shareOutcome) {
      return shareOutcome;
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
  LEG_KEY_FIELDS,
  TABLE_NAME,
  applyRecoveredCheckpoints,
  bindDurableScheduler,
  buildSettlementJob,
  buildWalletPayoutLegs,
  cancelSettlementJob,
  findPendingMissionRewardSettlement,
  getPendingMissionRewardSettlement,
  handleDurableMissionRewardSettlement,
  isLegSkipped,
  listDeadLetteredSettlementJobIDs,
  listPendingMissionRewardSettlements,
  normalizeStoredSettlement,
  prepareMissionRewardSettlement,
  reconcileDurableMissionRewardSettlements,
  setStartupRecovery,
  settleMissionRewardSettlement,
  unbindDurableScheduler,
};
