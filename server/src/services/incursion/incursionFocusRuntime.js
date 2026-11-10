"use strict";

// Quota and placement intents live beside tales in the same world-owned table.
// Reconciliation calls the existing tale/dungeon/economic owners; it never
// creates another simulation authority or publishes uncommitted reservations.
const contract = require("./incursionLifecycleContract"), model = require("./incursionFocusState");
const placement = require("./incursionFocusPlacement"), clock = require("./incursionClock");
const { fail, fingerprint } = contract;
function createIncursionFocusRuntime(options = {}) {
  const store = options.store || require("./incursionLifecycleStore");
  const lifecycle = () => options.lifecycle || require("./incursionLifecycle");
  const now = options.now || (() => clock.now()), catalog = options.catalog || placement.loadCatalog;
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) {
    try { listener(); } catch (error) { (options.log || require("../../utils/logger")).warn(`[Incursion] Focus scheduling pending: ${error.message}`); }
  } };
  const allowed = configuration => configuration?.mode === "organic"
    ? contract.organicSchedulingEnabled(configuration.securityBands[0])
    : configuration?.mode === "simulation" && process.env.EVEJS_TEST_STORE_ISOLATED === "1";
  function configure(request) {
    if (request?.mode !== "simulation" || process.env.EVEJS_TEST_STORE_ISOLATED !== "1") fail("INCURSION_ORGANIC_ACTIVATION_DISABLED");
    return configureFocus(request);
  }
  function initializeOrganic() {
    const bands = Object.keys(contract.ORGANIC_FOCUS_PROFILES).filter(contract.organicSchedulingEnabled);
    if (!bands.length) return null;
    const state = store.read();
    if (model.read(state)?.mode === "simulation") fail("INCURSION_FOCUS_CONFIGURATION_CONFLICT");
    let first = null;
    for (const band of bands) {
      const current = model.read(state, band) || configureFocus({
        requestID: contract.ORGANIC_FOCUS_PROFILES[band],
        mode: "organic",
        createdAtMs: now(),
        seed: require("node:crypto").randomBytes(32).toString("hex"),
        securityBands: [band],
      });
      first ||= current;
    }
    return first;
  }
  function configureFocus(request) {
    const band = request.mode === "organic" ? request.securityBands[0] : undefined;
    const existing = read(band);
    if (existing) {
      const fields = row => Object.fromEntries(["requestID", "mode", "createdAtMs", "seed", "securityBands"].map(key => [key, row[key]]));
      if (fingerprint(fields(existing)) !== fingerprint(fields(request))) fail("INCURSION_FOCUS_CONFIGURATION_CONFLICT");
      changed(); return existing;
    }
    const profileID = band === undefined ? contract.FOCUS_PROFILES.simulation : contract.ORGANIC_FOCUS_PROFILES[band];
    const configuration = { version: model.VERSION, requestID: request.requestID, mode: request.mode,
      createdAtMs: request.createdAtMs, seed: request.seed, securityBands: structuredClone(request.securityBands),
      policy: placement.policy(), profile: contract.freezeProfile(profileID, request.mode) };
    configuration.fingerprint = fingerprint(model.immutable(configuration));
    configuration.slots = Object.fromEntries((Array.isArray(request.securityBands) ? request.securityBands : []).map(band => [`${band}:1`,
      { key: `${band}:1`, securityBand: band, generation: 1, revision: 0, state: "waiting", dueAtMs: request.createdAtMs,
        reservation: null, taleID: null, history: [] }]));
    model.add({}, configuration);
    if (!contentAvailable(configuration)) fail("INCURSION_FOCUS_CONTENT_UNAVAILABLE");
    const result = store.mutate(state => {
      const prior = model.read(state, band);
      if (prior) {
        if (prior.fingerprint !== configuration.fingerprint) fail("INCURSION_FOCUS_CONFIGURATION_CONFLICT");
        return prior;
      }
      model.add(state, configuration);
      return configuration;
    });
    changed(); return result;
  }
  function read(band) { return model.read(store.read(), band); }
  function contentAvailable(configuration) {
    const authority = require("../dungeon/dungeonAuthority");
    const admission = require("./incursionAdmission");
    const sites = require("./incursionSiteAdmission");
    return configuration.profile.policy.encounters.every(binding => {
      const template = authority.getTemplateByID(binding.templateID);
      return template?.sourceDungeonID === binding.dungeonID &&
        (binding.dungeonID === 5166 ? admission.isSharedTemplate(template) : sites.isTemplate(template));
    });
  }
  function realize(slotKey, band) {
    const state = store.read();
    const configuration = model.read(state, band), slot = configuration?.slots[slotKey];
    if (!allowed(configuration) || slot?.state !== "reserved") return false;
    const reservation = slot.reservation;
    if (configuration.mode === "organic" && !state.requests[reservation.id] && !contentAvailable(configuration)) {
      fail("INCURSION_FOCUS_CONTENT_UNAVAILABLE");
    }
    const tale = lifecycle().createTale(structuredClone(reservation.request));
    const bound = store.mutate(state => {
      const current = model.read(state, band), row = current?.slots[slotKey];
      if (!row || current.fingerprint !== configuration.fingerprint || row.generation !== slot.generation ||
          row.reservation?.proof !== reservation.proof) fail("INCURSION_FOCUS_BINDING_CONFLICT");
      if (row.state === "active") {
        if (row.taleID !== tale.taleID) fail("INCURSION_FOCUS_BINDING_CONFLICT");
        return false;
      }
      if (row.state !== "reserved" || fingerprint(tale.policy) !== reservation.frozen.policyFingerprint ||
          fingerprint(tale.placement) !== fingerprint(reservation.request.placement) ||
          state.requests[reservation.id]?.taleID !== tale.taleID) fail("INCURSION_FOCUS_BINDING_CONFLICT");
      row.state = "active"; row.taleID = tale.taleID; row.revision++; return true;
    });
    if (bound) changed(); return bound;
  }
  function reconcile() {
    const configurations = model.list(store.read()).filter(allowed);
    if (!configurations.length) return { recovered: 0, waiting: 0, enabled: false };
    let recovered = 0;
    const slots = configurations.flatMap(row => Object.values(row.slots));
    for (const slot of slots) if (slot.state === "reserved" && realize(slot.key, slot.securityBand)) recovered++;
    const waiting = store.mutate(state => {
      const activeSlots = model.list(state).filter(allowed).flatMap(row => Object.values(row.slots));
      let count = 0;
      for (const slot of activeSlots) {
        if (slot.state !== "active") continue;
        const tale = lifecycle().getTale(slot.taleID);
        if (!tale || state.requests[slot.reservation.id]?.taleID !== tale.taleID ||
            tale.policyFingerprint !== slot.reservation.frozen.policyFingerprint) fail("INCURSION_FOCUS_BINDING_CONFLICT");
        if (!tale.terminal) continue;
        const terminal = require("./incursionTerminalContract").assertDecision(tale);
        // The production terminal owner sets applied only after economic work,
        // actor cleanup fences and native projection reconciliation succeed.
        if (terminal.settlement !== "applied" || tale.publication?.acknowledgedRevision !== tale.revision ||
            tale.siteSlots.some(row => row.state !== "closed") || tale.boss.available) continue;
        slot.history.push({ generation: slot.generation, taleID: tale.taleID, requestID: slot.reservation.id,
          reservationProof: slot.reservation.proof, terminalProof: terminal.proof, outcome: terminal.outcome,
          replacementEligibleAtMs: tale.replacementEligibleAtMs });
        slot.previousTaleID = tale.taleID; slot.generation++; slot.revision++;
        slot.state = "waiting"; slot.dueAtMs = tale.replacementEligibleAtMs; slot.reservation = null; slot.taleID = null; count++;
      }
      return count;
    });
    if (waiting) changed(); return { recovered, waiting, enabled: true };
  }
  function listBoundaries() {
    return model.list(store.read()).filter(allowed).flatMap(configuration =>
      Object.values(configuration.slots).map(slot => model.boundary(configuration, slot)).filter(Boolean));
  }
  function advanceBoundary(boundary, atMs = now()) {
    if (!Number.isSafeInteger(atMs) || atMs <= 0) fail("INCURSION_CLOCK_INVALID");
    const configurations = model.list(store.read());
    const configuration = configurations.find(row => Object.hasOwn(row.slots, boundary?.slotID));
    if (!configuration) return { applied: false, reason: configurations.some(allowed) ? "stale" : "disabled" };
    if (!allowed(configuration)) return { applied: false, reason: "disabled" };
    const currentSlot = configuration.slots[boundary.slotID];
    const expected = model.boundary(configuration, currentSlot);
    if (!expected || fingerprint(expected) !== fingerprint(boundary)) return { applied: false, reason: "stale" };
    if (atMs < expected.dueAtMs) return { applied: false, reason: "early" };
    const contentReady = configuration.mode !== "organic" || contentAvailable(configuration);
    const geography = contentReady ? catalog() : null;
    const reserved = store.mutate(state => {
      const all = model.list(state);
      const current = all.find(row => row.fingerprint === configuration.fingerprint);
      if (!allowed(current)) return false;
      const slot = current.slots[boundary.slotID];
      if (fingerprint(model.boundary(current, slot)) !== fingerprint(boundary)) return false;
      const occupied = Object.values(state.tales).filter(tale => !tale.terminal || tale.terminal.settlement !== "applied" || tale.replacementEligibleAtMs > atMs);
      const otherReservations = all.flatMap(row => Object.values(row.slots)).filter(row => row.state === "reserved");
      const quota = occupied.filter(tale => tale.placement.securityBand === slot.securityBand &&
        (!tale.terminal || tale.terminal.settlement !== "applied")).length + otherReservations.filter(row => row.securityBand === slot.securityBand).length;
      const plan = !contentReady || quota >= current.policy.concurrencyTargets[slot.securityBand] ? null : placement.selectPlacement(geography, {
        seed: current.seed, selectionKey: model.selectionKey(slot), securityBand: slot.securityBand,
        occupiedConstellationIDs: [...occupied.map(tale => tale.placement.constellationID), ...otherReservations.map(row => row.reservation.request.placement.constellationID)],
        occupiedSystemIDs: [...occupied.flatMap(tale => tale.placement.systems.map(row => row.solarSystemID)),
          ...otherReservations.flatMap(row => row.reservation.request.placement.systems.map(system => system.solarSystemID))] });
      slot.revision++;
      if (!plan) {
        slot.dueAtMs = atMs + current.policy.retryDelayMs;
        slot.lastReason = !contentReady ? "content-unavailable" : quota ? "quota" : "no-location";
        return false;
      }
      const id = model.reservationID(current, slot), frozen = model.frozenPolicy(current, slot);
      const request = { requestID: id, focusReservationID: id, mode: current.mode, profileID: current.profile.policy.profileID,
        createdAtMs: atMs, placement: plan };
      slot.state = "reserved"; slot.dueAtMs = null; delete slot.lastReason;
      slot.reservation = { id, request, requestFingerprint: fingerprint(request), frozen, proof: fingerprint({ id, request, frozen }) };
      return true;
    });
    changed();
    if (reserved) realize(boundary.slotID, currentSlot.securityBand);
    return { applied: true, kind: "focus", reserved, slotID: boundary.slotID };
  }
  return { configure, initializeOrganic, read, reconcile, listBoundaries, advanceBoundary,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
module.exports = { ...createIncursionFocusRuntime(), createIncursionFocusRuntime };
