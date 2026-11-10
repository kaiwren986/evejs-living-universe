"use strict";

// Missing external civilian hooks use this explicit emulator policy.
// Native room IDs, narrative delays and thresholds come from the matching
// client loader export. Legacy defaults remain immutable; new admissions can
// use captured timer/bonus parameters without rewriting saved attempts.
// This module is pure: the dungeon/NPC owner supplies committed facts and
// acknowledges idempotent intents after applying its own durable effects.
const crypto = require("node:crypto");
const NATIVE = require("./visionsCaldariNative.json");
const CAPTURE = require("./visionsCaldariCapture.json");
const { compareValues } = require("../nodegraph/nodeGraphCompiler");
const clone = value => JSON.parse(JSON.stringify(value));
const POLICY_SCHEMA = "evejs.visions-caldari-policy.v1";
const STATE_SCHEMA = "evejs.visions-caldari-progress.v1";
const AUTHORED_DEFAULTS = Object.freeze({ initialScore: 3, civilianCount: 5, bonusMax: 3,
  protectBonusLossMax: 0, rescueBonusMs: 180000, protectDurationMs: 60000, destroyBonusMs: 180000 });
const PHASES = Object.freeze({ lobby: "Lobby", rescueLead: "Wait", rescue: "RescueCivilains",
  enterRoom2Lead: "Wait", enterRoom2: "EnterR2", protectLead: "Wait", protect: "ProtectCivilains",
  destroyLead: "Wait", destroy: "DestroyHostiles", completionLead: "Wait", complete: "Complete" });
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function fingerprint(policy) { return crypto.createHash("sha256").update(JSON.stringify(canonical(policy))).digest("hex"); }
function validatePolicy(policy) {
  if (policy?.schema !== POLICY_SCHEMA || policy.version !== 1 || !policy.authored || !policy.native) fail("CALDARI_POLICY_INVALID");
  for (const key of Object.keys(AUTHORED_DEFAULTS)) if (!integer(policy.authored[key])) fail("CALDARI_POLICY_INVALID");
  const a = policy.authored, n = policy.native;
  if (!a.civilianCount || !a.protectDurationMs || !a.rescueBonusMs || !a.destroyBonusMs ||
      a.initialScore > a.bonusMax || a.protectBonusLossMax >= n.thresholds.protectDestroyedStop) fail("CALDARI_POLICY_INVALID");
  for (const key of ["lobby", "rescue", "protect"]) if (!integer(n.roomIDs?.[key]) || !n.roomIDs[key]) fail("CALDARI_POLICY_INVALID");
  for (const key of ["rescueLead", "enterRoom2Lead", "protectLead", "destroyLead", "completionLead"]) {
    if (!integer(n.delaysMs?.[key])) fail("CALDARI_POLICY_INVALID");
  }
  for (const key of ["fleetDestroyed", "protectDestroyedStop"]) if (!integer(n.thresholds?.[key]) || !n.thresholds[key]) fail("CALDARI_POLICY_INVALID");
  return policy;
}
function createPolicy(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) ||
      Object.keys(overrides).some(key => !Object.hasOwn(AUTHORED_DEFAULTS, key))) fail("CALDARI_POLICY_INVALID");
  return validatePolicy({ schema: POLICY_SCHEMA, version: 1, authority: "authored-emulator-policy",
    authored: { ...AUTHORED_DEFAULTS, ...clone(overrides) }, native: {
      build: NATIVE.source.clientBuild, graphID: 1023, roomIDs: clone(NATIVE.roomIDs),
      delaysMs: clone(NATIVE.delaysMs), thresholds: clone(NATIVE.thresholds), clientDefaults: clone(NATIVE.clientDefaults),
      cuesByEvent: clone(NATIVE.cuesByEvent), guardsByEvent: clone(NATIVE.guardsByEvent),
    } });
}
function createCapturedPolicy() {
  const policy = createPolicy({ rescueBonusMs: CAPTURE.timers.rescue.durationMs,
    protectDurationMs: CAPTURE.timers.protect.durationMs, destroyBonusMs: CAPTURE.timers.destroy.durationMs,
    protectBonusLossMax: CAPTURE.protectionBonus.value - 1 });
  policy.authority = "native-and-captured-with-authored-world-hooks";
  // Keep the v1 field layout for existing engines and frozen-state readers.
  // `authored` is a historical field name, not the authority of these values.
  policy.capturedParameters = clone(CAPTURE);
  return policy;
}
function deepFreeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
const DEFAULT_POLICY = deepFreeze(createPolicy());
function createProgress(policy = DEFAULT_POLICY, nowMs = 0, sceneEpoch = "initial") {
  validatePolicy(policy);
  if (!finite(nowMs) || !String(sceneEpoch)) fail("CALDARI_CLOCK_INVALID");
  const state = { schema: STATE_SCHEMA, version: 1, policy: clone(policy), policyFingerprint: fingerprint(policy),
    phase: "lobby", stage: "Lobby", phaseElapsedMs: 0, activeElapsedMs: 0,
    clock: { sceneEpoch: String(sceneEpoch), lastNowMs: nowMs, ownerPresent: false },
    facts: { roomID: null, escapedCount: 0, destroyedCount: 0, fleetKillCount: 0 },
    bonus: { rescue: "pending", protect: "pending", destroy: "pending" }, score: policy.authored.initialScore,
    fleetMilestones: [], emittedIntentIDs: [], pendingIntents: {}, history: [],
    presentation: { events: {}, ledger: {}, onceOwners: {}, currentValues: {}, pendingNotifications: {} } };
  recordHistory(state);
  return state;
}
function bonusActive(state) {
  const key = { rescue: "rescue", protect: "protect", destroy: "destroy" }[state.phase];
  return key && state.bonus[key] === "pending" ? 1 : 0;
}
function buildValues(state) {
  const { authored: a, native: n } = state.policy;
  return { ...clone(n.clientDefaults), dungeon_state: state.stage, bonus_active: bonusActive(state), score: state.score,
    civilians_escaped: Math.min(state.facts.escapedCount, a.civilianCount), civilians_escaped_max: a.civilianCount,
    civilians_destroyed: Math.min(state.facts.destroyedCount, n.thresholds.protectDestroyedStop),
    civilians_destroyed_max: n.thresholds.protectDestroyedStop, civilians_destroyed_max_bonus: a.protectBonusLossMax + 1,
    enemy_fleet_destroyed: state.facts.fleetKillCount, bonus_progress: state.score, bonus_progress_max: a.bonusMax };
}
function recordHistory(state) {
  const values = buildValues(state), last = state.history.at(-1);
  if (!last || JSON.stringify(last.values) !== JSON.stringify(values)) {
    state.history.push({ activeAtMs: state.activeElapsedMs, values });
  }
}
function emit(state, event, suffix = event, kind = "nativeEvent") {
  const id = `caldari:${suffix}`;
  if (state.emittedIntentIDs.includes(id)) return;
  state.emittedIntentIDs.push(id);
  state.pendingIntents[id] = { id, kind, event, phase: state.phase, activeAtMs: state.activeElapsedMs,
    sequence: state.emittedIntentIDs.length,
    context: buildValues(state) };
  if (kind === "nativeEvent") state.presentation.events[id] = clone(state.pendingIntents[id]);
}
function enter(state, phase) {
  state.phase = phase; state.stage = PHASES[phase]; state.phaseElapsedMs = 0;
  recordHistory(state);
  emit(state, phase, `phase:${phase}`, "phaseEntered");
}
function lose(state, key, event) {
  if (state.bonus[key] !== "pending") return;
  emit(state, event);
  state.bonus[key] = "lost";
  state.score = Math.max(0, state.policy.authored.initialScore - Object.values(state.bonus).filter(value => value === "lost").length);
  recordHistory(state);
}
function win(state, key) { if (state.bonus[key] === "pending") { state.bonus[key] = "won"; recordHistory(state); } }
function duration(state) {
  if (Object.hasOwn(state.policy.native.delaysMs, state.phase)) return state.policy.native.delaysMs[state.phase];
  if (state.phase === "protect") return state.policy.authored.protectDurationMs;
  if (state.phase === "rescue" && state.bonus.rescue === "pending") return state.policy.authored.rescueBonusMs;
  if (state.phase === "destroy" && state.bonus.destroy === "pending") return state.policy.authored.destroyBonusMs;
  return null;
}
function resolve(state) {
  if (!state.clock.ownerPresent || state.phase === "complete") return false;
  const { authored: a, native: n } = state.policy, f = state.facts;
  switch (state.phase) {
    case "lobby":
      if (f.roomID === n.roomIDs.rescue) { emit(state, "room1Entered"); enter(state, "rescueLead"); return true; }
      break;
    case "rescueLead": if (state.phaseElapsedMs >= n.delaysMs.rescueLead) { enter(state, "rescue"); return true; } break;
    case "rescue":
      if (f.escapedCount >= a.civilianCount) { emit(state, "civiliansEscaped"); win(state, "rescue"); enter(state, "enterRoom2Lead"); return true; }
      if (state.phaseElapsedMs >= a.rescueBonusMs && state.bonus.rescue === "pending") { lose(state, "rescue", "rescueBonusExpired"); return true; }
      break;
    case "enterRoom2Lead": if (state.phaseElapsedMs >= n.delaysMs.enterRoom2Lead) { enter(state, "enterRoom2"); return true; } break;
    case "enterRoom2": if (f.roomID === n.roomIDs.protect) { emit(state, "room2Entered"); enter(state, "protectLead"); return true; } break;
    case "protectLead": if (state.phaseElapsedMs >= n.delaysMs.protectLead) { enter(state, "protect"); return true; } break;
    case "protect":
      if (f.destroyedCount > a.protectBonusLossMax && state.bonus.protect === "pending") lose(state, "protect", "protectBonusFailed");
      if (f.destroyedCount >= n.thresholds.protectDestroyedStop) { emit(state, "protectDestroyedStop"); enter(state, "destroyLead"); return true; }
      if (state.phaseElapsedMs >= a.protectDurationMs) { emit(state, "protectComplete"); win(state, "protect"); enter(state, "destroyLead"); return true; }
      break;
    case "destroyLead": if (state.phaseElapsedMs >= n.delaysMs.destroyLead) { enter(state, "destroy"); return true; } break;
    case "destroy": {
      const reached = f.fleetKillCount >= n.thresholds.fleetDestroyed ? n.thresholds.fleetDestroyed :
        [...n.thresholds.fleetDialogueMilestones].reverse().find(value => f.fleetKillCount >= value);
      if (reached && !state.fleetMilestones.includes(reached)) {
        state.fleetMilestones = [...new Set([...state.fleetMilestones, ...n.thresholds.fleetDialogueMilestones.filter(value => value <= reached), reached])];
        emit(state, "fleetDestroyed", `fleetDestroyed:${reached}`);
      }
      if (f.fleetKillCount >= n.thresholds.fleetDestroyed) { win(state, "destroy"); enter(state, "completionLead"); return true; }
      if (state.phaseElapsedMs >= a.destroyBonusMs && state.bonus.destroy === "pending") { lose(state, "destroy", "destroyBonusExpired"); return true; }
      break;
    }
    case "completionLead": if (state.phaseElapsedMs >= n.delaysMs.completionLead) { enter(state, "complete"); return true; } break;
    default: fail("CALDARI_PHASE_INVALID");
  }
  return false;
}
function advanceTime(state, elapsedMs) {
  // Apply elapsed intervals to facts known before the current observation.
  // Newly arriving facts cannot retroactively consume a narrative lead delay.
  let budget = elapsedMs;
  for (let iteration = 0; iteration < 64; iteration++) {
    if (resolve(state)) continue;
    if (!budget || state.phase === "complete") return;
    const limit = duration(state);
    const step = limit === null ? budget : Math.min(budget, Math.max(0, limit - state.phaseElapsedMs));
    if (!step) fail("CALDARI_CLOCK_STALLED");
    state.phaseElapsedMs += step; state.activeElapsedMs += step; budget -= step;
  }
  fail("CALDARI_TRANSITION_LIMIT");
}
function buildTimer(state) {
  const length = duration(state);
  return length === null ? null : { durationMs: length, elapsedMs: Math.min(length, state.phaseElapsedMs),
    remainingMs: Math.max(0, length - state.phaseElapsedMs), active: state.clock.ownerPresent };
}
function valuesAt(state, activeAtMs) {
  return state.history.findLast(entry => entry.activeAtMs <= activeAtMs)?.values || state.history[0]?.values || {};
}
function conditionsPass(state, event, conditions) {
  return (conditions || []).every(condition => {
    const values = condition.atMs > 0 ? valuesAt(state, event.activeAtMs + condition.atMs) : event.context;
    const right = Object.hasOwn(condition, "valueFromKey") ? values[condition.valueFromKey] ?? null : condition.value;
    const passed = compareValues(values[condition.key] ?? null, right ?? null, condition.operator || "equalTo");
    return condition.negate ? !passed : passed;
  });
}
function advancePresentation(state, acknowledgedNotificationIDs = []) {
  const { native } = state.policy, ready = [];
  for (const event of Object.values(state.presentation.events)) {
    const cues = native.cuesByEvent?.[event.event] || [];
    const guard = conditionsPass(state, event, native.guardsByEvent?.[event.event]);
    for (const [index, cue] of cues.entries()) {
      const id = `${event.id}:cue:${index}`;
      if (Object.hasOwn(state.presentation.ledger, id)) continue;
      const activeAtMs = event.activeAtMs + cue.offsetMs;
      const guardsReadyAt = Math.max(activeAtMs, ...(cue.when || []).map(condition => event.activeAtMs + (condition.atMs || 0)));
      if (guardsReadyAt > state.activeElapsedMs) continue;
      ready.push({ id, event, cue, activeAtMs, index, guard });
    }
  }
  ready.sort((a, b) => a.activeAtMs - b.activeAtMs || a.event.activeAtMs - b.event.activeAtMs ||
    a.event.sequence - b.event.sequence || a.index - b.index);
  for (const { id, event, cue, activeAtMs, guard } of ready) {
    const onceKeys = cue.onceKeys || [];
    const allowed = guard && conditionsPass(state, event, cue.when) &&
      onceKeys.every(key => !state.presentation.onceOwners[key] || state.presentation.onceOwners[key] === event.id);
    state.presentation.ledger[id] = allowed ? "accepted" : "skipped";
    if (!allowed) continue;
    for (const key of onceKeys) state.presentation.onceOwners[key] ||= event.id;
    const historical = valuesAt(state, activeAtMs), values = {};
    for (const [key, value] of Object.entries(cue.values || {})) {
      // Stage/counter/bonus state belongs to the FSM, never to an old cue.
      values[key] = Object.hasOwn(historical, key) ? clone(historical[key]) : clone(value);
    }
    // Uppercase world hooks, GRANT_REWARD and scoreDelta are intentionally not
    // executed. Actor/economic owners are separate; the authored bonus state
    // already applied its single score loss before this presentation projection.
    if (!Object.keys(values).length) continue;
    Object.assign(state.presentation.currentValues, values);
    state.presentation.pendingNotifications[id] = { id, event: event.event, activeAtMs, values };
  }
  for (const id of acknowledgedNotificationIDs) {
    if (!Object.hasOwn(state.presentation.ledger, id)) fail("CALDARI_NOTIFICATION_UNKNOWN");
    delete state.presentation.pendingNotifications[id];
  }
  return Object.values(state.presentation.pendingNotifications).sort((a, b) => a.activeAtMs - b.activeAtMs).map(clone);
}
function advanceProgress({ policy = DEFAULT_POLICY, state: previous = null, facts = {}, nowMs, sceneEpoch }) {
  if (!finite(nowMs) || sceneEpoch === null || sceneEpoch === undefined || !String(sceneEpoch) || typeof facts.ownerPresent !== "boolean") fail("CALDARI_CLOCK_INVALID");
  const state = previous ? clone(previous) : createProgress(policy, nowMs, sceneEpoch);
  validatePolicy(state.policy);
  if (state.schema !== STATE_SCHEMA || state.version !== 1 || !Object.hasOwn(PHASES, state.phase) ||
      state.policyFingerprint !== fingerprint(state.policy) || !finite(state.phaseElapsedMs) || !finite(state.activeElapsedMs)) fail("CALDARI_STATE_INVALID");
  const oldClock = state.clock;
  const continuous = oldClock.sceneEpoch === String(sceneEpoch) && oldClock.ownerPresent && facts.ownerPresent && nowMs >= oldClock.lastNowMs;
  const elapsed = continuous ? nowMs - oldClock.lastNowMs : 0;
  state.clock = { sceneEpoch: String(sceneEpoch), lastNowMs: nowMs, ownerPresent: facts.ownerPresent };
  advanceTime(state, elapsed);
  for (const key of ["escapedCount", "destroyedCount", "fleetKillCount"]) {
    if (Object.hasOwn(facts, key)) {
      if (!integer(facts[key])) fail("CALDARI_FACT_INVALID");
      state.facts[key] = Math.max(state.facts[key], facts[key]);
    }
  }
  if (Object.hasOwn(facts, "roomID")) {
    if (facts.roomID !== null && (!integer(facts.roomID) || facts.roomID === 0)) fail("CALDARI_FACT_INVALID");
    state.facts.roomID = facts.roomID;
  }
  recordHistory(state);
  advanceTime(state, 0);
  for (const id of facts.acknowledgedIntentIDs || []) {
    if (!state.emittedIntentIDs.includes(id)) fail("CALDARI_INTENT_UNKNOWN");
    delete state.pendingIntents[id];
  }
  const notifications = advancePresentation(state, facts.acknowledgedNotificationIDs || []);
  return { state, values: { ...clone(state.presentation.currentValues), ...buildValues(state) },
    intents: Object.values(state.pendingIntents).map(clone), notifications, timer: buildTimer(state) };
}

module.exports = { AUTHORED_DEFAULTS, DEFAULT_POLICY, PHASES, createPolicy, createCapturedPolicy, createProgress, advanceProgress, advancePresentation, buildValues, buildTimer };
