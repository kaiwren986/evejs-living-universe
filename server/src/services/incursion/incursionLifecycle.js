"use strict";
const incursionClock = require("./incursionClock");

const contract = require("./incursionLifecycleContract");
const { fail, fingerprint, PHASE, SCENE } = contract;
const ID_BASE = 8000000000000;
const clone = value => structuredClone(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const keyValid = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);

function validatePlacement(placement, resolveSystem, policy) {
  if (!positive(placement?.constellationID) || !positive(placement.stagingSolarSystemID) ||
      !["high", "low", "null"].includes(placement.securityBand) || !Array.isArray(placement.systems) ||
      !placement.systems.length || !Array.isArray(placement.siteSlots)) fail("INCURSION_PLACEMENT_INVALID");
  const seen = new Set();
  for (const row of placement.systems) {
    if (!positive(row.solarSystemID) || seen.has(row.solarSystemID) ||
        ![SCENE.headquarters, SCENE.assault, SCENE.vanguard, SCENE.staging].includes(row.sceneType)) fail("INCURSION_SYSTEM_ROLE_INVALID");
    seen.add(row.solarSystemID);
    const system = resolveSystem(row.solarSystemID);
    const security = Number(system?.security ?? system?.securityStatus);
    const band = security >= 0.45 ? "high" : security > 0 ? "low" : "null";
    if (!system || system.constellationID !== placement.constellationID || !Number.isFinite(security) ||
        band !== placement.securityBand) fail("INCURSION_GEOGRAPHY_MISMATCH");
  }
  if (!placement.systems.some(row => row.solarSystemID === placement.stagingSolarSystemID && row.sceneType === SCENE.staging)) fail("INCURSION_STAGING_INVALID");
  const slots = new Set();
  for (const slot of placement.siteSlots) {
    const row = placement.systems.find(system => system.solarSystemID === slot.solarSystemID);
    const native = policy.sites?.contentVersion === 2 ? contract.SITES.find(site => site.dungeonID === slot.dungeonID && site.role !== "boss") : null;
    const role = { scout: SCENE.staging, vanguard: SCENE.vanguard, assault: SCENE.assault, headquarters: SCENE.headquarters };
    // 8B freezes placement intents for the already implemented encounter. It
    // never expands NPC groups or materializes content through a generic fallback.
    if (!keyValid(slot.slotID) || slots.has(slot.slotID) ||
        (policy.sites?.contentVersion === 2 ? !native || row?.sceneType !== role[native.role] : slot.dungeonID !== 5166 || row?.sceneType !== SCENE.vanguard) ||
        ![slot.position?.x, slot.position?.y, slot.position?.z].every(Number.isFinite)) fail("INCURSION_SITE_SLOT_INVALID");
    slots.add(slot.slotID);
  }
  if (policy.boss?.version === "evejs.incursion-final-sites.v1") {
    const final = placement.finalSite;
    if (!final || placement.systems.find(row => row.solarSystemID === final.solarSystemID)?.sceneType !== SCENE.headquarters ||
        ![final.position?.x, final.position?.y, final.position?.z].every(Number.isFinite)) fail("INCURSION_FINAL_SITE_PLACEMENT_INVALID");
  }
}

function validateTale(tale) {
  if (tale.policyFingerprint !== fingerprint(tale.policy) || tale.contractVersion !== contract.VERSION ||
      tale.policy.contractVersion !== contract.VERSION) fail("INCURSION_FROZEN_POLICY_MISMATCH");
  return tale;
}

function nextBoundary(tale) {
  validateTale(tale);
  if (tale.terminal) return null;
  const next = tale.timeline[tale.phaseIndex + 1];
  return { taleID: tale.taleID, generation: tale.generation, revision: tale.revision,
    dueAtMs: next ? next.atMs : tale.expiresAtMs, kind: next ? "phase" : "expiry" };
}

function addIntent(tale, kind, atMs, payload) {
  const operationID = `sansha:${tale.taleID}:g${tale.generation}:r${tale.revision}:${kind}`;
  tale.work[operationID] = { operationID, kind, atMs, status: "pending", payload: clone(payload) };
}
function appendTransition(tale, event, atMs) {
  tale.revision++;
  tale.history.push({ sequence: tale.revision, event, atMs, phase: tale.phase, terminal: tale.terminal?.outcome || null });
  // Immutable publication input is committed with the transition. No native
  // notices, effects, sites or economic calls run inside this reducer (8C–8E).
  addIntent(tale, "projection", atMs, { taleID: tale.taleID, revision: tale.revision,
    phase: tale.phase, terminal: tale.terminal, affectedSystems: tale.placement.systems,
    influence: tale.influence, boss: tale.boss });
}

function createIncursionLifecycle(options = {}) {
  const store = options.store || require("./incursionLifecycleStore");
  const now = options.now || (() => incursionClock.now());
  const resolveSystem = options.resolveSystem || (id => require("../../space/worldData").getSolarSystemByID(id));
  const terminalContract = require("./incursionTerminalContract");
  const resolveTerminalReceipts = options.resolveTerminalReceipts || terminalContract.readReceipts;
  const listeners = new Set();
  function changed() {
    for (const listener of listeners) {
      try { listener(); } catch (error) {
        (options.log || require("../../utils/logger")).warn(`[Incursion] Lifecycle reconciliation pending: ${error.message}`);
      }
    }
  }

  function createTale(request) {
    const organic = request?.mode === "organic";
    const allowed = organic ? contract.organicSchedulingEnabled(request.placement?.securityBand ?? "high")
      : request?.mode === "simulation" && process.env.EVEJS_TEST_STORE_ISOLATED === "1";
    if (!allowed) fail("INCURSION_ORGANIC_ACTIVATION_DISABLED");
    if (!keyValid(request.requestID) || !positive(request.createdAtMs)) fail("INCURSION_CREATE_REQUEST_INVALID");
    const requestFingerprint = fingerprint(request);
    const result = store.mutate(state => {
      const existing = state.requests[request.requestID];
      if (existing) {
        if (existing.fingerprint !== requestFingerprint) fail("INCURSION_CREATE_REQUEST_CONFLICT");
        return validateTale(state.tales[existing.taleID]);
      }
      const focus = require("./incursionFocusState");
      const reservation = focus.creationPolicy(state, request);
      if (organic && !reservation) fail("INCURSION_FOCUS_RESERVATION_REQUIRED");
      const frozen = reservation || contract.freezeProfile(request.profileID, request.mode);
      validatePlacement(request.placement, resolveSystem, frozen.policy);
      focus.assertAvailable(state, request);
      for (const tale of Object.values(state.tales)) {
        const overlaps = tale.placement.constellationID === request.placement.constellationID ||
          tale.placement.systems.some(a => request.placement.systems.some(b => a.solarSystemID === b.solarSystemID));
        if (!overlaps) continue;
        if (!tale.terminal) fail("INCURSION_LOCATION_OCCUPIED");
        if (request.createdAtMs < tale.replacementEligibleAtMs) fail("INCURSION_REPLACEMENT_COOLDOWN");
      }
      const serial = state.nextSerial;
      // Distinct reserved numeric namespace; curve IDs (1/2/3/8/10) are never
      // used as tale/pool identities. Terminal rows remain identity tombstones.
      const taleID = ID_BASE + serial * 2, poolGroupID = taleID + 1;
      if (!positive(poolGroupID) || state.tales[taleID]) fail("INCURSION_IDENTITY_EXHAUSTED");
      state.nextSerial++;
      let atMs = request.createdAtMs;
      const timeline = frozen.policy.phases.map(phase => {
        const entry = { name: phase.name, phase: PHASE[phase.name], atMs };
        atMs += phase.durationMs;
        return entry;
      });
      if (!positive(atMs + frozen.policy.replacementDelayMs)) fail("INCURSION_DEADLINE_INVALID");
      const tale = { schema: "evejs.sansha-tale.v1", contractVersion: contract.VERSION,
        taleID, poolGroupID, generation: serial, mode: request.mode, ...frozen,
        placement: clone(request.placement), createdAtMs: request.createdAtMs,
        timeline, expiresAtMs: atMs, replacementEligibleAtMs: atMs + frozen.policy.replacementDelayMs,
        phaseIndex: 0, phase: timeline[0].phase, revision: 0, terminal: null,
        boss: { available: false, unlockedAtMs: null, reason: "full-predicate-and-encounter-unavailable",
          minimumAgeMs: frozen.policy.boss.minimumAgeMs[request.placement.securityBand] },
        influence: { value: frozen.policy.influence.initial, lastUpdatedAtMs: request.createdAtMs,
          graceMinutes: frozen.policy.influence.graceMinutes, decayPerHour: frozen.policy.influence.decayPerHour },
        siteSlots: request.placement.siteSlots.map(slot => ({ ...clone(slot), state: "intent-only",
          operationID: `sansha:${taleID}:g${serial}:slot:${slot.slotID}:0`, incarnation: 0, instanceID: null })),
        history: [], work: {},
      };
      require("./incursionSiteSlots").initialize(tale);
      require("./incursionFinalSiteSlots").initialize(tale);
      appendTransition(tale, "created", tale.createdAtMs);
      if (!tale.policy.sites?.enabled) for (const slot of tale.siteSlots) addIntent(tale, `slot-${slot.slotID}`, tale.createdAtMs, slot);
      state.tales[taleID] = tale;
      state.requests[request.requestID] = { fingerprint: requestFingerprint, taleID };
      return tale;
    });
    changed();
    return result;
  }

  function listTales() { return Object.values(store.read().tales).map(validateTale); }
  function getTale(taleID) { const tale = store.read().tales[taleID]; return tale ? validateTale(tale) : null; }
  function advanceBoundary(boundary, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    if (boundary?.kind === "site") return slots.advance(boundary, atMs);
    if (boundary?.kind === "final") return finalSlots.advance(boundary, atMs);
    const result = store.mutate(state => {
      const tale = state.tales[boundary?.taleID];
      if (!tale) return { applied: false, reason: "missing" };
      const expected = nextBoundary(tale);
      if (!expected || fingerprint(expected) !== fingerprint(boundary)) return { applied: false, reason: "stale" };
      if (tale.mode === "simulation" && process.env.EVEJS_TEST_STORE_ISOLATED !== "1") fail("INCURSION_SIMULATION_STORE_REQUIRED");
      if (atMs < expected.dueAtMs) return { applied: false, reason: "early" };
      if (expected.kind === "phase") {
        tale.phaseIndex++;
        tale.phase = tale.timeline[tale.phaseIndex].phase;
        appendTransition(tale, "phase", expected.dueAtMs);
      } else {
        if (terminalContract.enabled(tale)) terminalContract.sealDecision(tale,
          { outcome: "expired", atMs, receipts: resolveTerminalReceipts(tale) });
        else tale.terminal = { outcome: "expired", decidedAtMs: expected.dueAtMs,
          eventID: `sansha:${tale.taleID}:g${tale.generation}:terminal`, settlement: "blocked-until-8E" };
        require("./incursionFinalSiteSlots").closeInPlace(tale, expected.dueAtMs);
        appendTransition(tale, "expired", expected.dueAtMs);
        addIntent(tale, "terminal-reconciliation", expected.dueAtMs, { terminal: tale.terminal,
          siteOperationIDs: tale.siteSlots.map(slot => slot.operationID), replacementEligibleAtMs: tale.replacementEligibleAtMs });
      }
      return { applied: true, taleID: tale.taleID, revision: tale.revision, kind: expected.kind };
    });
    if (result.applied) changed();
    return result;
  }

  function acceptFinalCompletion(receiptID, atMs = now()) {
    const receipt = require("./incursionSiteSlots").readCompletion(receiptID);
    const result = store.mutate(state => {
      const tale = state.tales[receipt.identity.taleID];
      if (!tale) fail("INCURSION_TALE_MISSING");
      validateTale(tale);
      if (tale.terminal) return { applied: false, reason: "terminal", outcome: tale.terminal.outcome };
      if (tale.policy.testOnly && process.env.EVEJS_TEST_STORE_ISOLATED !== "1") fail("INCURSION_SIMULATION_STORE_REQUIRED");
      if (atMs >= tale.expiresAtMs) return { applied: false, reason: "expired" };
      terminalContract.sealDecision(tale, { outcome: "defeated", atMs, bossReceipt: receipt, receipts: resolveTerminalReceipts(tale) });
      require("./incursionFinalSiteSlots").closeInPlace(tale, atMs);
      appendTransition(tale, "defeated", atMs);
      addIntent(tale, "terminal-reconciliation", atMs, { terminal: tale.terminal,
        siteOperationIDs: tale.siteSlots.map(slot => slot.operationID), replacementEligibleAtMs: tale.replacementEligibleAtMs });
      return { applied: true, taleID: tale.taleID, revision: tale.revision, kind: "victory" };
    });
    if (result.applied) changed();
    return result;
  }
  function acknowledgeTerminal(taleID, eventID, proof) {
    const result = store.mutate(state => {
      const tale = state.tales[taleID];
      if (!tale) fail("INCURSION_TALE_MISSING");
      validateTale(tale);
      const terminal = terminalContract.assertDecision(tale);
      if (terminal.eventID !== eventID || terminal.proof !== proof) fail("INCURSION_TERMINAL_PROOF_REQUIRED");
      if (terminal.settlement === "applied") return false;
      if (!require("./incursionRewards").terminalPoolSettled(tale)) fail("INCURSION_TERMINAL_SETTLEMENT_PENDING");
      terminal.settlement = "applied";
      for (const work of Object.values(tale.work)) if (work.kind === "terminal-reconciliation") work.status = "applied";
      return true;
    });
    if (result) changed();
    return result;
  }

  function prepareProjection(taleID, revision) {
    return store.mutate(state => {
      const tale = state.tales[taleID];
      if (!tale || tale.revision !== revision) return false;
      validateTale(tale);
      if (tale.publication?.preparedRevision === revision) return true;
      tale.publication = { ...tale.publication, preparedRevision: revision };
      return true;
    });
  }
  function acknowledgeProjection(taleID, revision) {
    return store.mutate(state => {
      const tale = state.tales[taleID];
      if (!tale || tale.revision !== revision || tale.publication?.preparedRevision !== revision) return false;
      validateTale(tale);
      tale.publication.acknowledgedRevision = revision;
      for (const work of Object.values(tale.work)) {
        if (work.kind !== "projection" || work.status !== "pending") continue;
        work.status = work.payload.revision === revision ? "applied" : "superseded";
      }
      return true;
    });
  }

  const slots = require("./incursionSiteSlots").createSiteSlots({ store, changed, validateTale, appendTransition, now,
    resolveCompletion: options.resolveCompletion });
  const finalSlots = require("./incursionFinalSiteSlots").createFinalSiteSlots({ store, changed, validateTale, appendTransition, now });
  return { createTale, getTale, listTales, advanceBoundary, nextBoundary, prepareProjection, acknowledgeProjection,
    acceptFinalCompletion, acknowledgeTerminal,
    siteAdmission: slots.admission, bindSiteInstance: slots.bind, retrySiteInstance: slots.retry, acceptSiteCompletion: slots.complete, closeSiteSlots: slots.close,
    acceptSiteFailure: slots.failed,
    acknowledgeSiteRetirement: slots.acknowledgeRetirement,
    finalAdmission: finalSlots.admission, bindFinalInstance: finalSlots.bind, retryFinalInstance: finalSlots.retry,
    closeFinalSite: finalSlots.close,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listBoundaries: () => listTales().flatMap(tale => [nextBoundary(tale), ...slots.boundaries(tale), finalSlots.boundary(tale), terminalContract.boundary(tale)]).filter(Boolean),
    pendingWork: () => listTales().flatMap(tale => Object.values(tale.work).filter(work => work.status === "pending")),
    activationReadiness: contract.activationReadiness };
}

module.exports = { ...createIncursionLifecycle(), createIncursionLifecycle, ID_BASE };
