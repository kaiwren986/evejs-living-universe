"use strict";

// Focus reservations share the lifecycle table. Only their independently saved
// request can supply a frozen policy to tale creation.
const { FOCUS_PROFILES, ORGANIC_FOCUS_PROFILES, fingerprint, fail } = require("./incursionLifecycleContract");
const placement = require("./incursionFocusPlacement");
const VERSION = "evejs.incursion-focus-scheduling.v1";
const positive = value => Number.isSafeInteger(value) && value > 0;
function immutable(configuration) {
  return Object.fromEntries(["version", "requestID", "mode", "createdAtMs", "seed", "securityBands", "policy", "profile"]
    .map(key => [key, configuration[key]]));
}
function selectionKey(slot) { return `focus:${slot.key}:g${slot.generation}`; }
function reservationID(configuration, slot) { return `focus-${configuration.fingerprint.slice(0, 24)}-${slot.securityBand}-g${slot.generation}`; }
function frozenPolicy(configuration, slot) {
  const policy = { ...structuredClone(configuration.profile.policy),
    replacementDelayMs: placement.replacementDelay(configuration.seed, selectionKey(slot)),
    focusScheduling: { version: VERSION, configurationID: configuration.fingerprint, slotKey: slot.key,
      generation: slot.generation, placementVersion: placement.VERSION } };
  return { policy, policyFingerprint: fingerprint(policy) };
}
function validate(configuration, band) {
  if (!configuration || configuration.version !== VERSION || !Object.hasOwn(FOCUS_PROFILES, configuration.mode) ||
      typeof configuration.requestID !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(configuration.requestID) ||
      !positive(configuration.createdAtMs) || typeof configuration.seed !== "string" || !/^[a-f0-9]{64}$/.test(configuration.seed) ||
      !Array.isArray(configuration.securityBands) || !configuration.securityBands.length || configuration.securityBands.length > 3 ||
      new Set(configuration.securityBands).size !== configuration.securityBands.length ||
      configuration.securityBands.some(band => !["high", "low", "null"].includes(band)) ||
      (configuration.mode === "organic" ? configuration.securityBands.length !== 1 || configuration.securityBands[0] !== band : band !== "high") ||
      fingerprint(configuration.policy) !== fingerprint(placement.policy()) ||
      configuration.profile?.policy?.profileID !== (configuration.mode === "organic" ? ORGANIC_FOCUS_PROFILES[band] : FOCUS_PROFILES.simulation) ||
      configuration.profile.policy.testOnly !== (configuration.mode === "simulation") ||
      configuration.profile.policy.organicActivation !== (configuration.mode === "organic") ||
      fingerprint(configuration.profile.policy) !== configuration.profile.policyFingerprint ||
      fingerprint(immutable(configuration)) !== configuration.fingerprint || !configuration.slots ||
      Object.keys(configuration.slots).length !== configuration.securityBands.length)
    fail("INCURSION_FOCUS_STATE_INVALID");
  for (const band of configuration.securityBands) {
    const slot = configuration.slots[`${band}:1`];
    if (!slot || slot.key !== `${band}:1` || slot.securityBand !== band || !positive(slot.generation) ||
        !Number.isSafeInteger(slot.revision) || slot.revision < 0 || !["waiting", "reserved", "active"].includes(slot.state) ||
        !Array.isArray(slot.history) || (slot.state === "waiting" ? !positive(slot.dueAtMs) || slot.reservation !== null || slot.taleID !== null
          : slot.dueAtMs !== null || !slot.reservation || (slot.state === "active" ? !positive(slot.taleID) : slot.taleID !== null)))
      fail("INCURSION_FOCUS_SLOT_INVALID");
    if (!slot.reservation) continue;
    const reservation = slot.reservation, request = reservation.request, frozen = frozenPolicy(configuration, slot);
    if (reservation.id !== reservationID(configuration, slot) || request?.focusReservationID !== reservation.id || request.requestID !== reservation.id ||
        request.mode !== configuration.mode || request.profileID !== configuration.profile.policy.profileID || !positive(request.createdAtMs) ||
        request.placement?.securityBand !== band || request.placement.provenance?.selectionKey !== selectionKey(slot) ||
        fingerprint(reservation.frozen) !== fingerprint(frozen) || reservation.requestFingerprint !== fingerprint(request) ||
        reservation.proof !== fingerprint({ id: reservation.id, request, frozen })) fail("INCURSION_FOCUS_RESERVATION_INVALID");
  }
  return configuration;
}
function list(state) {
  const configurations = [];
  if (state.focusScheduling !== undefined) configurations.push(validate(state.focusScheduling, "high"));
  const extra = state.organicFocusScheduling;
  if (extra === undefined) return configurations;
  if (!extra || typeof extra !== "object" || Array.isArray(extra) || state.focusScheduling?.mode === "simulation") {
    fail("INCURSION_FOCUS_STATE_INVALID");
  }
  for (const [band, configuration] of Object.entries(extra)) {
    if (band !== "low" && band !== "null") fail("INCURSION_FOCUS_STATE_INVALID");
    configurations.push(validate(configuration, band));
  }
  return configurations;
}
function read(state, band) {
  const configurations = list(state);
  return (band === undefined ? configurations[0] : configurations.find(row => row.securityBands.includes(band))) || null;
}
function add(state, configuration) {
  const band = configuration.securityBands?.[0];
  // Keep the original high-security row and its fingerprint in place.
  if (configuration.mode === "simulation" || band === "high") {
    state.focusScheduling = configuration;
  } else if (band === "low" || band === "null") {
    (state.organicFocusScheduling ||= {})[band] = configuration;
  } else {
    fail("INCURSION_FOCUS_STATE_INVALID");
  }
  list(state);
}
function creationPolicy(state, request) {
  if (request.focusReservationID === undefined) return null;
  const slot = list(state).flatMap(row => Object.values(row.slots)).find(row => row.reservation?.id === request.focusReservationID);
  if (!slot || slot.state !== "reserved" || slot.reservation.requestFingerprint !== fingerprint(request))
    fail("INCURSION_FOCUS_RESERVATION_REQUIRED");
  return structuredClone(slot.reservation.frozen);
}
function assertAvailable(state, request) {
  for (const slot of list(state).flatMap(row => Object.values(row.slots))) {
    if (slot.state !== "reserved" || slot.reservation.id === request.focusReservationID) continue;
    const reserved = slot.reservation.request.placement;
    if (reserved.constellationID === request.placement.constellationID ||
        reserved.systems.some(a => request.placement.systems.some(b => a.solarSystemID === b.solarSystemID)))
      fail("INCURSION_LOCATION_RESERVED");
  }
}
function boundary(configuration, slot) {
  return slot.state !== "waiting" ? null : { kind: "focus", configurationID: configuration.fingerprint,
    slotID: slot.key, generation: slot.generation, revision: slot.revision, dueAtMs: slot.dueAtMs };
}
module.exports = { VERSION, immutable, selectionKey, reservationID, frozenPolicy, list, read, add, creationPolicy, assertAvailable, boundary };
