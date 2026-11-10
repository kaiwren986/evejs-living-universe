"use strict";
const incursionClock = require("./incursionClock");

// Immutable lifecycle decisions authorize economic work in the existing reward
// owner. Neither an event-name string nor a dungeon's administrative state is
// independent proof that a mothership died.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const VERSION = "evejs.incursion-terminal.v1";
const positive = value => Number.isSafeInteger(value) && value > 0;
const enabled = tale => tale?.policy?.terminal?.version === VERSION && tale.policy.terminal.enabled === true;
const completionProof = receipt => fingerprint([receipt.id, receipt.requestFingerprint,
  receipt.identity, receipt.policyFingerprint, receipt.completedAtMs, receipt.rewardDefinition,
  receipt.catalogIdentity, receipt.eligibleCount, receipt.disqualified,
  receipt.participants.map(row => ({ characterID: row.characterID, taxProfile: row.taxProfile,
    grossLP: row.grossLP, netLP: row.netLP, legs: row.legs.map(leg => Object.fromEntries(
      ["id", "characterID", "ownerID", "issuerCorpID", "kind", "delayed", "amount", "grossAmount", "walletOptions"]
        .map(key => [key, leg[key]]))) }))]);
function policy() {
  return { version: VERSION, enabled: true,
    completionCutoff: "reward-sealed-before-terminal-decision-and-deadline",
    deadlinePrecedence: "expiry-at-or-after-deadline", victory: "sealed-final-encounter",
    expiry: "forfeit-unreleased-lp", settlement: "durable-owner-reconciliation",
    source: "emulator-policy",
    qualification: "Conservative explicit cutoff. Deferred health journals cannot create new incursion awards after closure; already reward-sealed ISK is preserved. Retail terminal timing/cutoffs remain unproven." };
}
function immutableDecision(terminal) {
  return Object.fromEntries(["version", "outcome", "eventID", "taleID", "poolGroupID", "generation",
    "policyFingerprint", "decidedAtMs", "recordedAtMs", "causeAtMs", "completionCutoff",
    "receipts", "bossReceiptID"].map(key => [key, terminal[key]]));
}
function assertDecision(tale, outcome = null) {
  const terminal = tale?.terminal;
  if (!enabled(tale) || !terminal || terminal.version !== VERSION ||
      !["defeated", "expired"].includes(terminal.outcome) || (outcome && terminal.outcome !== outcome) ||
      terminal.taleID !== tale.taleID || terminal.poolGroupID !== tale.poolGroupID || terminal.generation !== tale.generation ||
      terminal.policyFingerprint !== tale.policyFingerprint || terminal.proof !== fingerprint(immutableDecision(terminal))) {
    fail("INCURSION_TERMINAL_PROOF_REQUIRED");
  }
  return terminal;
}
function readReceipts(tale) {
  const store = require("./incursionRewardStore"), { readCompletion } = require("./incursionSiteSlots");
  return Object.values(store.read("/receipts") || {}).filter(receipt =>
    receipt.identity.poolGroupID === tale.poolGroupID && receipt.identity.taleID === tale.taleID)
    .map(receipt => readCompletion(receipt.id));
}
function sealDecision(tale, { outcome, atMs, receipts, bossReceipt = null }) {
  if (!enabled(tale) || tale.terminal || !positive(atMs) || !["expired", "defeated"].includes(outcome)) {
    fail("INCURSION_TERMINAL_DECISION_INVALID");
  }
  if (outcome === "expired" ? atMs < tale.expiresAtMs : atMs >= tale.expiresAtMs) fail("INCURSION_TERMINAL_DEADLINE");
  const selected = receipts.map(receipt => {
    const id = receipt.identity;
    if (!["tale-slot", "tale-final"].includes(id?.placement) || id.taleID !== tale.taleID ||
        id.poolGroupID !== tale.poolGroupID || id.generation !== tale.generation ||
        !positive(receipt.completedAtMs) || receipt.completedAtMs < tale.createdAtMs ||
        receipt.completedAtMs >= tale.expiresAtMs || receipt.completedAtMs > atMs) fail("INCURSION_TERMINAL_RECEIPT_SCOPE");
    return { receiptID: receipt.id, proof: completionProof(receipt) };
  }).sort((a, b) => a.receiptID.localeCompare(b.receiptID));
  if (new Set(selected.map(row => row.receiptID)).size !== selected.length) fail("INCURSION_TERMINAL_RECEIPT_SCOPE");
  if (outcome === "defeated") {
    const boss = tale.boss, id = bossReceipt?.identity;
    if (!boss?.available || boss.state !== "active" || !id || id.placement !== "tale-final" ||
        id.taleID !== tale.taleID || id.poolGroupID !== tale.poolGroupID || id.generation !== tale.generation ||
        id.instanceID !== boss.instanceID || id.slotOperationID !== boss.operationID ||
        id.solarSystemID !== boss.solarSystemID || id.rewardID !== 10 ||
        !selected.some(row => row.receiptID === bossReceipt.id && row.proof === completionProof(bossReceipt))) {
      fail("INCURSION_FINAL_COMPLETION_UNPROVEN");
    }
  }
  const decidedAtMs = outcome === "expired" ? tale.expiresAtMs : atMs;
  tale.terminal = { version: VERSION, outcome, eventID: `sansha:${tale.taleID}:g${tale.generation}:terminal`,
    taleID: tale.taleID, poolGroupID: tale.poolGroupID, generation: tale.generation, policyFingerprint: tale.policyFingerprint,
    decidedAtMs, recordedAtMs: atMs, causeAtMs: bossReceipt?.completedAtMs ?? tale.expiresAtMs,
    completionCutoff: tale.policy.terminal.completionCutoff, receipts: selected,
    bossReceiptID: bossReceipt?.id ?? null, settlement: "pending" };
  tale.terminal.proof = fingerprint(immutableDecision(tale.terminal));
  tale.replacementEligibleAtMs = decidedAtMs + tale.policy.replacementDelayMs;
  for (const slot of tale.siteSlots) {
    if (slot.state !== "closed") { slot.state = "closed"; slot.sequence++; }
    if (tale.work[slot.operationID]?.status === "pending") tale.work[slot.operationID].status = "superseded";
  }
  tale.boss.available = false;
  return tale.terminal;
}
function boundary(tale) {
  if (!enabled(tale) || !tale.terminal || tale.terminal.settlement === "applied") return null;
  const terminal = assertDecision(tale);
  return { taleID: tale.taleID, generation: tale.generation, revision: tale.revision,
    kind: "terminal", dueAtMs: terminal.decidedAtMs, eventID: terminal.eventID, proof: terminal.proof };
}
function assertCompletionOpen(identity, completedAtMs, nowMs = incursionClock.now()) {
  if (!["tale-slot", "tale-final"].includes(identity?.placement)) return;
  const tale = require("./incursionLifecycle").getTale(identity.taleID);
  if (!enabled(tale)) return;
  if (identity.poolGroupID !== tale.poolGroupID || identity.generation !== tale.generation ||
      identity.securityBand !== tale.placement.securityBand) fail("INCURSION_COMPLETION_SCOPE_MISMATCH");
  if (tale.terminal || completedAtMs < tale.createdAtMs || completedAtMs >= tale.expiresAtMs ||
      nowMs >= tale.expiresAtMs || completedAtMs > nowMs) fail("INCURSION_TERMINAL_COMPLETION_CUTOFF");
  const binding = identity.placement === "tale-final" ? tale.boss : tale.siteSlots.find(row => row.slotID === identity.slotID);
  if (!binding || binding.state !== "active" || binding.instanceID !== identity.instanceID ||
      binding.operationID !== identity.slotOperationID || binding.solarSystemID !== identity.solarSystemID ||
      (identity.placement === "tale-slot" && binding.incarnation !== identity.incarnation)) fail("INCURSION_COMPLETION_SCOPE_MISMATCH");
}
function resolveDecision({ poolGroupID, taleID, eventID, proof, atMs }, outcome) {
  const tale = require("./incursionLifecycle").getTale(taleID), terminal = assertDecision(tale, outcome);
  if (terminal.poolGroupID !== poolGroupID || terminal.eventID !== eventID || terminal.proof !== proof ||
      terminal.decidedAtMs !== atMs || (tale.policy.testOnly && process.env.EVEJS_TEST_STORE_ISOLATED !== "1")) {
    fail("INCURSION_TERMINAL_PROOF_REQUIRED");
  }
  const store = require("./incursionRewardStore");
  const receipts = terminal.receipts.map(row => {
    const receipt = store.read(`/receipts/${row.receiptID}`);
    if (!receipt || completionProof(receipt) !== row.proof) fail("INCURSION_TERMINAL_RECEIPT_SCOPE");
    return receipt;
  });
  return { tale, terminal, receipts };
}
module.exports = { VERSION, enabled, policy, completionProof, assertDecision, sealDecision, readReceipts,
  boundary, assertCompletionOpen, resolveDecision };
