"use strict";
const incursionClock = require("./incursionClock");

// Coordinate durable terminal work through existing reward, health, dungeon and
// scene owners. No second economic balance or system simulation lives here.
const contract = require("./incursionTerminalContract");
const lifecycle = require("./incursionLifecycle");
const rewards = require("./incursionRewards");
const rewardStore = require("./incursionRewardStore");
const { fingerprint, fail } = require("./incursionLifecycleContract");
const { retireActors } = require("./incursionActorCleanup");
const deliveries = new Map();
function checked(result) {
  if (result?.success === false) fail(result.errorMsg || "INCURSION_TERMINAL_CLEANUP_PENDING");
  return result;
}
async function run(boundary, nowMs) {
  const tale = lifecycle.getTale(boundary.taleID), expected = tale && contract.boundary(tale);
  if (!expected || fingerprint(expected) !== fingerprint(boundary)) return { applied: false, reason: "stale" };
  if (nowMs < boundary.dueAtMs) return { applied: false, reason: "early" };
  const terminal = contract.assertDecision(tale);
  if (tale.policy.testOnly && process.env.EVEJS_TEST_STORE_ISOLATED !== "1") fail("INCURSION_SIMULATION_STORE_REQUIRED");
  const proof = { poolGroupID: tale.poolGroupID, taleID: tale.taleID, eventID: terminal.eventID, proof: terminal.proof };
  if (terminal.outcome === "defeated") rewards.releasePool({ ...proof, eventType: "incursion-defeated", releasedAtMs: terminal.decidedAtMs });
  else rewards.forfeitPool({ ...proof, forfeitedAtMs: terminal.decidedAtMs });
  for (const operation of Object.values(rewardStore.read("/operations") || {})) {
    if (operation.identity.taleID !== tale.taleID || operation.identity.poolGroupID !== tale.poolGroupID) continue;
    require("./incursionEncounterRuntime").retireOperation(operation, tale, nowMs);
    retireActors(operation, nowMs);
  }
  require("./incursionSiteRuntime").reconcile({ nowMs });
  require("./incursionFinalSiteRuntime").reconcile({ nowMs });
  // Retry the fence even when the prior attempt already removed cached rows.
  // A lost/refused flush acknowledgement is not durable cleanup completion.
  checked(require("../../gameStore").flushTablesSync(
    ["npcEntities", "npcRuntimeControllers", "npcModules", "npcCargo"]));
  require("./incursionProjectionRuntime").reconcile();
  try { await rewards.reconcilePending(); }
  catch (error) { if (!rewards.terminalPoolSettled(tale)) throw error; }
  if (!rewards.terminalPoolSettled(tale)) fail("INCURSION_TERMINAL_SETTLEMENT_PENDING");
  lifecycle.acknowledgeTerminal(tale.taleID, terminal.eventID, terminal.proof);
  return { applied: true, taleID: tale.taleID, kind: "terminal", outcome: terminal.outcome };
}
function reconcileTale(boundary, nowMs = incursionClock.now()) {
  const key = `${boundary?.taleID}:${boundary?.proof}`;
  if (deliveries.has(key)) return deliveries.get(key);
  const delivery = Promise.resolve().then(() => run(boundary, nowMs)).finally(() => deliveries.delete(key));
  deliveries.set(key, delivery);
  return delivery;
}
module.exports = { reconcileTale };
