"use strict";

// Focused checks of recovered algorithms, with production dependencies blocked.
// These are not integration tests of the running EveJS server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const root = path.resolve(__dirname, "../..");
const snapshot = path.join(root, "_local/living-universe-audit/legacy-added");
const cache = new Map();
let defaultRepositoryCalls = 0;

function loadLegacy(relative) {
  const filename = path.resolve(snapshot, relative);
  const local = path.relative(snapshot, filename);
  assert.ok(local && !local.startsWith("..") && !path.isAbsolute(local));
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = new Module(filename);
  cache.set(filename, loaded);
  loaded.filename = filename;
  loaded.require = (request) => {
    if (["path", "crypto", "perf_hooks"].includes(request.replace(/^node:/, ""))) return require(request);
    const target = path.resolve(path.dirname(filename), request);
    if (target === path.join(snapshot, "server/src/gameStore/tableRepository")) {
      return { createTableRepository() {
        defaultRepositoryCalls += 1;
        throw new Error("Production repository access is forbidden in kernel checks");
      } };
    }
    if (!request.startsWith(".") && !path.isAbsolute(request)) throw new Error(`Unreviewed dependency: ${request}`);
    for (const candidate of [target, target + ".js", path.join(target, "index.js")]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return loadLegacy(path.relative(snapshot, candidate));
      }
    }
    throw new Error(`External server dependency is forbidden in kernel checks: ${request}`);
  };
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return loaded.exports;
}

function verifyLedger() {
  const { createMemoryRepository, createStateStore } = loadLegacy("server/src/services/xEve/xEveState.js");
  const { createLedger } = loadLegacy("server/src/services/xEve/xEveLedger.js");
  const repo = createMemoryRepository();
  const stateStore = createStateStore({ repo });
  const ledger = createLedger({ stateStore, clock: () => 1_800_000_000_000 });
  assert.equal(ledger.ensureInitialized().success, true);
  for (const accountID of ["firm:estate", "firm:hauler"]) {
    assert.equal(ledger.createAccount({ accountID, ownerType: "firm", ownerID: accountID, category: "cash" }, { durable: false }).success, true);
  }
  assert.equal(ledger.openBalance({ transactionID: "opening:estate", accountID: "firm:estate", amountCents: "100000" }, { durable: false }).success, true);
  const transfer = { transactionID: "delivery:one", fromAccountID: "firm:estate", toAccountID: "firm:hauler", amountCents: "25000" };
  assert.equal(ledger.transfer(transfer, { durable: false }).success, true);
  assert.equal(ledger.transfer(transfer, { durable: false }).replayed, true);
  assert.equal(ledger.getAccount("firm:estate").balanceCents, "75000");
  assert.equal(ledger.getAccount("firm:hauler").balanceCents, "25000");
  assert.equal(ledger.transfer({ ...transfer, amountCents: "25001" }, { durable: false }).errorMsg, "X_EVE_TRANSACTION_CONFLICT");
  assert.equal(ledger.transfer({ ...transfer, transactionID: "delivery:unfunded", amountCents: "75001" }, { durable: false }).errorMsg, "X_EVE_INSUFFICIENT_FUNDS");
  assert.equal(ledger.getAccount("firm:estate").balanceCents, "75000");
  assert.equal(ledger.getStatus().ledgerImbalanceCents, "0");
  assert.equal(ledger.audit().success, true);

  // Reconstruct from a serialized memory snapshot; this is not a disk crash test.
  const serialized = JSON.parse(JSON.stringify(repo.snapshot()));
  const restored = createLedger({ stateStore: createStateStore({ repo: createMemoryRepository(serialized) }) });
  assert.equal(restored.ensureInitialized().success, true);
  assert.equal(restored.transfer(transfer, { durable: false }).replayed, true);
  assert.equal(restored.getStatus().transactionCount, 2);
  serialized.accountsByID["firm:estate"].balanceCents = "75001";
  const corrupt = createLedger({ stateStore: createStateStore({ repo: createMemoryRepository(serialized) }) });
  assert.equal(corrupt.ensureInitialized().success, true);
  assert.equal(corrupt.audit().success, false);
  assert.equal(corrupt.recover().success, false);
  assert.equal(corrupt.getStatus().healthy, false);
  assert.equal(defaultRepositoryCalls, 0);
  return { duplicateTransferSuppressed: true, conflictingIDRejected: true, unfundedTransferRejected: true,
    serializedReplaySuppressed: true, corruptBalanceRejected: true, productionRepositoryCalls: defaultRepositoryCalls };
}

function verifyCrewNavigation() {
  const navigation = loadLegacy("server/src/services/industrialHirelings/industrialHirelingNavigation.js");
  const topology = {
    getStationSolarSystemID: (stationID) => ({ 100: 1, 300: 3 })[stationID] || 0,
    getShortestPath: (source, destination) => source === 1 && destination === 3 ? [1, 2, 3] : [],
  };
  const command = { commandID: "route:one", destinationStationID: 300 };
  const planned = navigation.planNavigation({ currentSystemID: 1, homeStationID: 100 }, command,
    { topology, nowMs: 1000, legDurationMs: 10000 });
  assert.equal(planned.success, true);
  let contract = { navigation: planned.data.navigation };
  assert.deepEqual(contract.navigation.routeSystemIDs, [1, 2, 3]);
  assert.equal(navigation.advanceNavigation(contract, 10999).changed, false);
  contract.navigation = navigation.advanceNavigation(contract, 11000).data.navigation;
  assert.equal(contract.navigation.currentSystemID, 2);
  assert.equal(navigation.isNavigationInTransit(contract), true);
  contract = JSON.parse(JSON.stringify(contract));
  const arrived = navigation.advanceNavigation(contract, 21000);
  assert.equal(arrived.data.arrived, true);
  assert.equal(arrived.data.currentSystemID, 3);
  contract.navigation = arrived.data.navigation;
  assert.equal(navigation.inspectCommandReplay(contract, command).replayed, true);
  assert.equal(navigation.inspectCommandReplay(contract, { ...command, destinationStationID: 100 }).errorMsg,
    "INDUSTRIAL_HIRELING_NAVIGATION_COMMAND_CONFLICT");
  assert.equal(navigation.planNavigation({ currentSystemID: 1 }, { destinationSystemID: 99 }, { topology }).success, false);
  const corrupt = JSON.parse(JSON.stringify(contract));
  corrupt.navigation.phase = navigation.NAVIGATION_PHASE.IN_TRANSIT;
  corrupt.navigation.currentSystemID = 99;
  assert.equal(navigation.advanceNavigation(corrupt, 50000).data.blocked, true);
  return { timedRouteProgression: true, serializedCatchUp: true, retrySuppressed: true,
    conflictingCommandRejected: true, invalidRouteBlocked: true, recentCommandLimit: navigation.MAX_RECENT_COMMANDS };
}

function verifyLoadGovernor() {
  const { MODE, WORK_CLASS, XEveLoadGovernor } = loadLegacy("server/src/services/xEve/xEveLoadGovernor.js");
  const ticks = (ms) => Array.from({ length: 20 }, () => ({ actualIntervalMs: ms }));
  const evaluate = (ms) => new XEveLoadGovernor().evaluate(ticks(ms), 1_800_000_000_000);
  const healthy = evaluate(100);
  assert.equal(healthy.mode, MODE.HEALTHY);
  assert.equal(healthy.maxJobs, 32);
  const constrained = evaluate(120);
  assert.equal(constrained.mode, MODE.CONSTRAINED);
  assert.ok(!constrained.allowedWorkClasses.includes(WORK_CLASS.PLANNING));
  assert.equal(evaluate(130).mode, MODE.OVERLOADED);
  assert.equal(evaluate(500).mode, MODE.SHED);
  assert.equal(evaluate(600).mode, MODE.UNPLAYABLE);
  assert.equal(evaluate(500).maxJobs, 0);
  assert.equal(evaluate(600).budgetMs, 0);
  return { healthyJobsPerPass: healthy.maxJobs, warningMs: 120, overloadMs: 130, shedMs: 500, unplayableMs: 600 };
}

async function verifyCurrentCommandBoundary() {
  // This current module imports only node:crypto; all handlers/control are memory fixtures.
  const { AUTHORIZATION_POLICIES, createCharacterCommandRuntime } = require(path.join(root, "server/src/services/online/characterCommandRuntime"));
  let handlerCalls = 0;
  let controlState = "offline";
  const runtime = createCharacterCommandRuntime({
    controlRuntime: {
      getCharacterControlSnapshot: () => ({ controlState, online: controlState !== "offline" }),
      subscribe: () => () => {},
    },
    commandDefinitions: {
      "probe.order": {
        authorizationPolicy: AUTHORIZATION_POLICIES.OFFLINE_COMPANION,
        normalizePayload: (value) => value,
        handler: async ({ payload }) => { handlerCalls += 1; return { order: payload.order }; },
      },
    },
  });
  try {
    const command = { commandID: "probe:one", controllerID: "local-command-probe", type: "probe.order",
      expectedStateVersion: runtime.getStateVersion(90001), payload: { order: "standby" } };
    const [first, concurrent] = await Promise.all([runtime.submitCommand(90001, command), runtime.submitCommand(90001, command)]);
    assert.deepEqual(first, concurrent);
    assert.deepEqual(await runtime.submitCommand(90001, command), first);
    assert.equal(handlerCalls, 1);
    await assert.rejects(runtime.submitCommand(90001, { ...command, payload: { order: "withdraw" } }), { code: "CHARACTER_COMMAND_ID_REUSED" });
    await assert.rejects(runtime.submitCommand(90001, { ...command, commandID: "probe:stale" }), { code: "CHARACTER_STATE_VERSION_MISMATCH" });
    controlState = "retail_client";
    await assert.rejects(runtime.submitCommand(90001, { ...command, commandID: "probe:retail",
      expectedStateVersion: runtime.getStateVersion(90001) }), { code: "CHARACTER_CONTROL_RETAIL_CLIENT" });
    assert.equal(handlerCalls, 1);
    return { concurrentDuplicateSuppressed: true, completedReplaySuppressed: true, conflictingIDRejected: true,
      staleStateRejected: true, retailPilotControlProtected: true,
      limitation: "Current command receipts are process-local; durable gameplay effects need owner receipts. Crew management while EVE is open needs a distinct authority policy." };
  } finally { runtime.shutdown(); }
}

async function main() {
  const results = { ledger: verifyLedger(), crewNavigation: verifyCrewNavigation(),
    loadGovernor: verifyLoadGovernor(), currentCommandBoundary: await verifyCurrentCommandBoundary() };
  console.log(JSON.stringify({ success: true, results, integrationVerified: false }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
