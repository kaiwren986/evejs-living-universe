"use strict";

/**
 * STARTUP HEAL PASS FOR WEDGED MISSION REWARD SETTLEMENTS.
 *
 * A mission reward settlement is a saga: escrow the courier cargo, credit ISK,
 * credit LP, apply standings, finalize the mission, deliver reward items,
 * consume the escrowed cargo, drop the record. Every step is idempotent and
 * checkpoints itself into the settlement record before the next one runs.
 *
 * The failure this heals is a settlement whose *work* completed but whose
 * *checkpoints* did not. That record can neither finish nor fail: the durable
 * job retries it forever, and -- because a pending settlement is consulted
 * before the mission being handed in -- it also blocks every later turn-in for
 * that character/agent pair. Silently, and for as long as the record exists.
 *
 * THE CENTRAL RULE: the settlement's own applied/committed flags are NOT
 * evidence. The case that motivated this pass had walletApplied=false,
 * lpApplied=false and committed=false on a record where all three legs
 * demonstrably executed -- the ISK and LP receipts were on file and the escrow
 * item had already been consumed. Healing from those flags would have paid the
 * player a second time.
 *
 * The authority receipts are the source of truth:
 *   - ISK   walletAuthorityState/character:<characterID> .walletAuthorityReceipts[]
 *   - tax   walletAuthorityState/corporation:<corporationID> (same array)
 *   - LP    lpWallets/operationReceipts keyed by the idempotency key
 *   - cargo the items table: a staged leg whose escrow row is gone was consumed
 *           by a commit that ran
 *
 * The pass only ever moves a flag from false to true, and only on positive
 * evidence, because the two mistakes are not symmetric:
 *
 *   - Wrongly concluding "not applied" costs nothing. The replay goes through
 *     the ordinary settlement path, which is keyed by the same commandID, so
 *     the authority returns the committed result instead of paying again.
 *   - Wrongly concluding "applied" silently forfeits a player's reward, and
 *     the record is dropped afterwards so there is nothing left to find.
 *
 * That asymmetry is why a receipt is not accepted on its own: its amount is
 * cross-checked against what this settlement expected to pay. A receipt that
 * exists but pays the wrong amount means the commandID belongs to a *different*
 * operation (see advanceMissionSequenceWatermark for how that becomes possible),
 * and such a leg is classified neither way -- the settlement is left in place
 * and reported, never guessed at.
 */

const path = require("node:path");

const log = require(path.join(__dirname, "../../utils/logger"));
const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
const lpWalletState = require(path.join(__dirname, "../corporation/lpWalletState"));
const walletAuthorityOwnerState = require(path.join(
  __dirname,
  "../account/walletAuthorityOwnerState",
));
const walletAuthorityReceiptState = require(path.join(
  __dirname,
  "../account/walletAuthorityReceiptState",
));
const {
  custodyStepCommitted,
} = require(path.join(__dirname, "../_shared/settlementCustodyRecovery"));
const missionRuntimeState = require(path.join(__dirname, "./missionRuntimeState"));
const settlementState = require(path.join(__dirname, "./missionRewardSettlementState"));

const LOG_TAG = "[MissionRewardStartup]";
// Money is stored rounded to two decimals, so anything under half a cent is the
// same number. Nothing here needs a looser match: a receipt that paid a
// different amount is exactly the signal this cross-check exists to catch.
const MONEY_EPSILON = 0.005;
const COMMAND_ID_SEQUENCE_PATTERN = /^mission-reward:\d+:(\d+):/;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** The amount a committed wallet/LP receipt actually moved, or null. */
function receiptDelta(receipt) {
  const result = receipt && receipt.result;
  if (!result || result.success === false) {
    return null;
  }
  const candidates = [
    result.delta,
    result.data && result.data.delta,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function amountsAgree(left, right) {
  return Math.abs(roundMoney(left) - roundMoney(right)) < MONEY_EPSILON;
}

/**
 * Classify one money leg. Returns one of:
 *   {verdict: "applied", delta}      -- a receipt committed the expected amount
 *   {verdict: "unapplied"}           -- no receipt, and none could have been
 *                                       evicted; safe to replay
 *   {verdict: "unresolved", reason}  -- evidence conflicts or was evicted; never
 *                                       guess
 *
 * `receiptListSaturated` is the owner's authority-receipt list sitting at its
 * eviction cap. It matters only when there is no receipt: below the cap, absence
 * proves the leg never ran (nothing has ever been evicted), so replaying is
 * safe; at the cap, absence is ambiguous -- the receipt for a leg that DID pay
 * may have been pushed out -- so the leg cannot be replayed without risking a
 * second payment. A saturated list is the only durable signal available: there
 * is no uncapped journal to fall back on (the wallet journal is capped tighter
 * than the receipt list, so it evicts first, not last).
 */
function classifyMoneyLeg({ receipt, expectedAmount, label, receiptListSaturated = false }) {
  if (!receipt) {
    if (receiptListSaturated) {
      return {
        verdict: "unresolved",
        evicted: true,
        label,
        reason:
          "no receipt, but the owner's authority-receipt list is at its eviction " +
          "cap; a receipt for a leg that already paid may have been evicted, so " +
          "replaying it could pay a second time",
      };
    }
    return { verdict: "unapplied", label };
  }
  const delta = receiptDelta(receipt);
  if (delta === null) {
    return {
      verdict: "unresolved",
      label,
      reason: "receipt exists but records no committed amount",
    };
  }
  if (!amountsAgree(delta, expectedAmount)) {
    return {
      verdict: "unresolved",
      label,
      reason:
        `receipt moved ${roundMoney(delta)} but this settlement expected ` +
        `${roundMoney(expectedAmount)} -- the commandID belongs to a different ` +
        `operation`,
    };
  }
  return { verdict: "applied", label, delta };
}

function characterReceipt(characterID, commandID) {
  return walletAuthorityReceiptState.findOwnerReceipt(
    { kind: "character", ownerID: toPositiveInt(characterID, 0) },
    commandID,
  );
}

function corporationReceipt(corporationID, commandID) {
  return walletAuthorityReceiptState.findOwnerReceipt(
    { kind: "corporation", ownerID: toPositiveInt(corporationID, 0) },
    commandID,
  );
}

/**
 * Reconcile every leg of one settlement against the ledgers.
 *
 * Produces the checkpoint patch that should be written before the settlement is
 * handed back to the ordinary path, plus the list of legs that could not be
 * classified. It performs no writes and no authority calls.
 */
function reconcileSettlementLegs(settlement) {
  const patch = {};
  const unresolved = [];
  const healedLegs = [];
  const inferences = [];
  const characterID = toPositiveInt(settlement.characterID, 0);

  for (const leg of settlementState.buildWalletPayoutLegs(settlement)) {
    if (leg.gross > 0 && settlement[leg.appliedField] !== true) {
      const verdict = classifyMoneyLeg({
        receipt: characterReceipt(characterID, leg.commandID),
        expectedAmount: leg.net,
        label: `isk:${leg.kind}`,
        receiptListSaturated: walletAuthorityReceiptState.isOwnerReceiptListSaturated({
          kind: "character",
          ownerID: characterID,
        }),
      });
      if (verdict.verdict === "applied") {
        patch[leg.appliedField] = true;
        healedLegs.push(`isk:${leg.kind}`);
      } else if (verdict.verdict === "unresolved") {
        unresolved.push(verdict);
      }
    }
    if (leg.tax > 0 && leg.corporationTaxable && settlement[leg.taxAppliedField] !== true) {
      const verdict = classifyMoneyLeg({
        receipt: corporationReceipt(leg.corporationID, leg.taxCommandID),
        expectedAmount: leg.tax,
        label: `corp-tax:${leg.kind}`,
        receiptListSaturated: walletAuthorityReceiptState.isOwnerReceiptListSaturated({
          kind: "corporation",
          ownerID: toPositiveInt(leg.corporationID, 0),
        }),
      });
      if (verdict.verdict === "applied") {
        patch[leg.taxAppliedField] = true;
        patch[leg.taxPaidField] = leg.tax;
        healedLegs.push(`corp-tax:${leg.kind}`);
      } else if (verdict.verdict === "unresolved") {
        unresolved.push(verdict);
      }
    }
  }

  const loyaltyPoints = Math.max(0, Math.trunc(Number(settlement.loyaltyPoints) || 0));
  // The member is credited the net of corporation LP tax. A record prepared
  // before LP was taxed has no net, and paid the full loyaltyPoints.
  const loyaltyPointsNet = settlement.loyaltyPointsNet === undefined ||
    settlement.loyaltyPointsNet === null
    ? loyaltyPoints
    : Math.max(0, Math.trunc(Number(settlement.loyaltyPointsNet) || 0));
  if (loyaltyPoints > 0 && settlement.lpApplied !== true) {
    const receipt = lpWalletState.getOperationReceipt(settlement.lpKey);
    const verdict = classifyMoneyLeg({
      receipt,
      expectedAmount: loyaltyPointsNet,
      label: "lp",
    });
    if (verdict.verdict === "applied") {
      patch.lpApplied = true;
      patch.lpResult = (receipt.result && receipt.result.data) || null;
      healedLegs.push("lp");
    } else if (verdict.verdict === "unresolved") {
      unresolved.push(verdict);
    }
  }

  const loyaltyPointsTax = Math.max(0, Math.trunc(Number(settlement.loyaltyPointsTax) || 0));
  if (
    loyaltyPointsTax > 0 &&
    toPositiveInt(settlement.loyaltyPointTaxCorporationID, 0) > 0 &&
    settlement.corpLpTaxApplied !== true
  ) {
    const verdict = classifyMoneyLeg({
      receipt: lpWalletState.getOperationReceipt(settlement.corpLpTaxKey),
      expectedAmount: loyaltyPointsTax,
      label: "corp-lp-tax",
    });
    if (verdict.verdict === "applied") {
      patch.corpLpTaxApplied = true;
      patch.corpLpTaxPaid = loyaltyPointsTax;
      healedLegs.push("corp-lp-tax");
    } else if (verdict.verdict === "unresolved") {
      unresolved.push(verdict);
    }
  }

  // Cargo. A staged leg is committed if its commit step has a durable custody
  // receipt (a fact), or -- failing that -- if the escrow row it staged is no
  // longer in the items table (an inference: committing a courier leg is what
  // consumes it, and nothing else can reach a per-operation escrow location).
  // The inference is logged loudly precisely because it is an inference.
  const cargoLegs = [];
  for (const leg of settlement.cargoLegs) {
    if (leg.staged !== true || leg.committed === true || leg.returned === true) {
      continue;
    }
    if (custodyStepCommitted(leg.commitKey)) {
      cargoLegs.push({ legID: leg.legID, inferred: false });
      healedLegs.push(`cargo:${leg.legID}`);
      continue;
    }
    const escrowItemID = toPositiveInt(leg.escrowItemID, 0);
    if (!escrowItemID) {
      continue;
    }
    if (!itemStore.findItemById(escrowItemID)) {
      cargoLegs.push({ legID: leg.legID, inferred: true });
      healedLegs.push(`cargo:${leg.legID}`);
      inferences.push(
        `cargo leg ${leg.legID} escrowItem=${escrowItemID} is absent from the ` +
          `items table with no commit receipt; treating it as committed`,
      );
    }
  }

  return { patch, cargoLegs, unresolved, healedLegs, inferences };
}

/**
 * Finalizer used while healing. Ordinary finalization refuses a mission it can
 * no longer find (MISSION_STATE_CHANGED), which is the normal state of a
 * settlement wedged long enough for its mission to have been cleared -- the
 * very records this pass exists for. Finalization's only durable effects are
 * removing the active mission and writing its history row, so a mission that is
 * already gone has nothing left to finalize and must not block the payout's
 * bookkeeping from closing.
 *
 * This tolerance is deliberately scoped to the recovery pass; the live
 * completion path still treats a vanished mission as an error.
 */
function buildRecoveryFinalizer(operationID, finalizeMissionCompletion) {
  return (characterID, agentRecord, missionRecord, options) => {
    const result = finalizeMissionCompletion(
      characterID,
      agentRecord,
      missionRecord,
      options,
    );
    if (result && result.success === true) {
      return result;
    }
    const errorMsg = result && result.errorMsg;
    if (errorMsg !== "MISSION_STATE_CHANGED" && errorMsg !== "MISSION_NOT_FOUND") {
      return result;
    }
    log.warn(
      `${LOG_TAG} operation=${operationID} mission record is already gone ` +
        `(${errorMsg}); its rewards were paid, so finalization is treated as ` +
        `complete and the settlement is closed`,
    );
    return { success: true, data: { finalized: true, recovered: true } };
  };
}

/**
 * Raise nextMissionSequence above every sequence any receipt or settlement
 * already references.
 *
 * Mission commandIDs are `mission-reward:<characterID>:<missionSequence>:<leg>`,
 * so the guarantee that "a receipt for this commandID means this leg already
 * paid" rests entirely on missionSequence never repeating for a character. A
 * store reset or migration that rewinds the counter without clearing the
 * receipt ledgers breaks that: a fresh mission inherits an old mission's
 * receipts and is treated as already paid, skipping a real reward.
 *
 * Idempotent -- it only ever raises the counter, so a healthy store is a no-op.
 */
function advanceMissionSequenceWatermark() {
  let watermark = 0;
  const observe = (commandID) => {
    const match = COMMAND_ID_SEQUENCE_PATTERN.exec(String(commandID || ""));
    if (match) {
      watermark = Math.max(watermark, Number(match[1]) || 0);
    }
  };

  for (const record of walletAuthorityOwnerState.listOwnedRecords()) {
    for (const receipt of Array.isArray(record && record.walletAuthorityReceipts)
      ? record.walletAuthorityReceipts
      : []) {
      observe(receipt && receipt.commandID);
    }
    const corporationReceipts = record && record.wallet &&
      Array.isArray(record.wallet.authorityReceipts)
      ? record.wallet.authorityReceipts
      : [];
    for (const receipt of corporationReceipts) {
      observe(receipt && receipt.commandID);
    }
  }
  for (const key of lpWalletState.listOperationReceiptKeys()) {
    observe(key);
  }
  for (const settlement of settlementState.listPendingMissionRewardSettlements()) {
    watermark = Math.max(watermark, toPositiveInt(settlement.missionSequence, 0));
  }

  const required = watermark + 1;
  const state = missionRuntimeState.getStateSnapshot();
  const current = toPositiveInt(state && state.nextMissionSequence, 1);
  if (!watermark || current >= required) {
    return { advanced: false, from: current, to: current, watermark };
  }
  const result = missionRuntimeState.mutateState((mutable) => {
    mutable.nextMissionSequence = Math.max(
      toPositiveInt(mutable.nextMissionSequence, 1),
      required,
    );
    return mutable.nextMissionSequence;
  });
  if (!result || result.success !== true) {
    log.warn(
      `${LOG_TAG} could not advance nextMissionSequence from ${current} to ` +
        `${required}: ${(result && result.errorMsg) || "WRITE_FAILED"}. Mission ` +
        `commandIDs may collide with existing receipts until this is corrected`,
    );
    return { advanced: false, from: current, to: current, watermark };
  }
  log.warn(
    `${LOG_TAG} nextMissionSequence advanced ${current} -> ${required}: existing ` +
      `mission-reward receipts already reference sequence ${watermark}, so the ` +
      `counter had been rewound and new missions would have inherited old ` +
      `receipts (paying nothing) or collided with them`,
  );
  return { advanced: true, from: current, to: required, watermark };
}

async function healSettlement(settlement, finalizeMissionCompletion) {
  const operationID = String(settlement.operationID || "");
  const reconciliation = reconcileSettlementLegs(settlement);

  if (reconciliation.unresolved.length > 0) {
    for (const entry of reconciliation.unresolved) {
      log.warn(
        `${LOG_TAG} operation=${operationID} leg=${entry.label} cannot be ` +
          `classified: ${entry.reason}. The settlement is left pending and no ` +
          `leg is replayed -- replaying could pay twice and dropping it would ` +
          `forfeit the reward. This needs operator review`,
      );
    }
    if (reconciliation.unresolved.some((entry) => entry.evicted === true)) {
      // Leaving the settlement merely "pending" is not safe when the block is a
      // possibly-evicted receipt: reconcile reschedules every pending settlement,
      // and the ordinary forward path trusts the (false) applied flag and would
      // pay the leg again. Persist a hold the forward path refuses to run through,
      // so an unverifiable settlement wedges for operator review instead of
      // paying twice. Amount-mismatch conflicts (receipt present) are left as
      // before -- the forward path replays them idempotently against the receipt.
      const held = settlementState.applyRecoveredCheckpoints(operationID, (current) => ({
        ...current,
        recoveryHoldError: current.recoveryHoldError ||
          "MISSION_REWARD_RECEIPT_EVICTED_UNVERIFIABLE",
      }));
      if (!held || held.success !== true) {
        log.warn(
          `${LOG_TAG} operation=${operationID} could not persist the ` +
            `receipt-eviction hold: ${(held && held.errorMsg) || "WRITE_FAILED"}; ` +
            `the settlement is left pending but the forward path is not blocked`,
        );
      }
    }
    return { outcome: "unresolved", operationID };
  }

  for (const inference of reconciliation.inferences) {
    log.warn(`${LOG_TAG} operation=${operationID} ${inference}`);
  }

  const hasPatch = Object.keys(reconciliation.patch).length > 0 ||
    reconciliation.cargoLegs.length > 0;
  if (hasPatch) {
    const committedLegIDs = new Set(reconciliation.cargoLegs.map((entry) => entry.legID));
    const written = settlementState.applyRecoveredCheckpoints(operationID, (current) => ({
      ...current,
      ...reconciliation.patch,
      cargoLegs: current.cargoLegs.map((leg) =>
        committedLegIDs.has(leg.legID)
          ? { ...leg, committed: true, commitError: null }
          : leg),
    }));
    if (!written || written.success !== true) {
      log.warn(
        `${LOG_TAG} operation=${operationID} could not persist reconciled ` +
          `checkpoints: ${(written && written.errorMsg) || "WRITE_FAILED"}; ` +
          `left pending`,
      );
      return { outcome: "pending", operationID };
    }
    log.info(
      `${LOG_TAG} operation=${operationID} reconciled from the ledgers: ` +
        `${reconciliation.healedLegs.join(", ")}`,
    );
  }

  // Everything still false at this point genuinely has no receipt, so the
  // ordinary path may replay it. It is also what finalizes the mission, drops
  // the record and reports the outcome, so the heal never duplicates that
  // logic. Inventory notifications are suppressed: this runs before any player
  // can be connected.
  let settled = null;
  try {
    settled = await settlementState.settleMissionRewardSettlement(operationID, {
      notifyInventory: false,
      finalizeMission: buildRecoveryFinalizer(operationID, finalizeMissionCompletion),
    });
  } catch (error) {
    log.warn(
      `${LOG_TAG} operation=${operationID} threw while settling: ` +
        `${(error && error.message) || "UNKNOWN"}; left pending`,
    );
    return { outcome: "pending", operationID };
  }

  if (settlementState.getPendingMissionRewardSettlement(operationID)) {
    log.warn(
      `${LOG_TAG} operation=${operationID} is still pending after recovery: ` +
        `${(settled && settled.errorMsg) || "settlement did not complete"}`,
    );
    return { outcome: "pending", operationID };
  }

  await settlementState.cancelSettlementJob(operationID);
  return {
    outcome: settled && settled.rejected === true ? "rejected" : "healed",
    operationID,
  };
}

/**
 * The once-per-startup barrier. Safe to run twice: reconciliation is derived
 * from the ledgers rather than from any progress marker, a settlement that
 * already healed is gone by the second run, and the sequence watermark only
 * raises.
 */
async function prepareStartupRecoveryBarrier(reason = "startup", options = {}) {
  const finalizeMissionCompletion = typeof options.finalizeMissionCompletion === "function"
    ? options.finalizeMissionCompletion
    : require(path.join(__dirname, "./agentMissionRuntime")).finalizeMissionCompletion;

  const sequence = advanceMissionSequenceWatermark();
  const pending = settlementState.listPendingMissionRewardSettlements();
  const summary = {
    success: true,
    reason: String(reason || "startup"),
    inspected: pending.length,
    healed: 0,
    rejected: 0,
    pending: 0,
    deadLetteredJobIDs: [],
    nextMissionSequence: sequence.to,
  };

  for (const settlement of pending) {
    let result = null;
    try {
      result = await healSettlement(settlement, finalizeMissionCompletion);
    } catch (error) {
      log.warn(
        `${LOG_TAG} operation=${settlement.operationID} recovery failed: ` +
          `${(error && error.message) || "UNKNOWN"}`,
      );
      result = { outcome: "pending" };
    }
    if (result.outcome === "healed") {
      summary.healed += 1;
    } else if (result.outcome === "rejected") {
      summary.rejected += 1;
    } else {
      summary.pending += 1;
    }
  }

  summary.deadLetteredJobIDs = await settlementState.listDeadLetteredSettlementJobIDs();
  for (const jobID of summary.deadLetteredJobIDs) {
    log.warn(
      `${LOG_TAG} durable job ${jobID} is dead-lettered: it exhausted its retry ` +
        `budget and will not run again until it is rescheduled or cancelled`,
    );
  }

  log.info(
    `${LOG_TAG} recovery complete reason=${summary.reason} ` +
      `inspected=${summary.inspected} healed=${summary.healed} ` +
      `rejected=${summary.rejected} pending=${summary.pending} ` +
      `deadLettered=${summary.deadLetteredJobIDs.length} ` +
      `nextMissionSequence=${summary.nextMissionSequence}`,
  );
  return summary;
}

module.exports = {
  advanceMissionSequenceWatermark,
  prepareStartupRecoveryBarrier,
  reconcileSettlementLegs,
};

// The settlement store runs this pass at scheduler startup without requiring this module.
settlementState.setStartupRecovery(module.exports);
