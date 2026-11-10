"use strict";

// These notices are emitted by the scene only after a paid module cycle has
// executed. Activation preflights and per-tick modifier refreshes never call it.
const { resolveTargetResistanceMultiplier } = require("../modules/hostileModuleRuntime");
const { lazyRequire } = require("./runtimeModuleBoundary");

const FAMILIES = Object.freeze({
  targetPainter: "target-paint",
  energyNeutralizer: "energy-neutralizer",
  sensorDampener: "sensor-damp",
  stasisWebifier: "web",
  warpDisruptor: "warp-disrupt",
  warpScrambler: "warp-disrupt",
});

function buildNotice(source, target, effect, result, kind, nowMs) {
  if (!source || !(target?.dungeonSiteContentKey || target?.visionsActorKey || target?.dungeonEncounterKey) || !(Number(target.dungeonSiteInstanceID) > 0) || result?.success !== true ||
      !(Number(effect?.moduleID) > 0) || !(Number(effect?.effectID) > 0) || !Number.isFinite(Number(nowMs))) return null;
  const data = result.data || {};
  let family;
  if (kind === "jammer" && effect.jammerModuleEffect === true && data.jamApplied === true) family = "ecm";
  else if (kind === "hostile" && effect.hostileModuleEffect === true) {
    family = FAMILIES[effect.hostileFamily];
    if (!family || data.effectApplied === false || !(Number(data.multiplier) > 0) ||
        resolveTargetResistanceMultiplier(target, effect.hostileResistanceAttributeID) <= 0) return null;
    const magnitude = Math.max(Math.abs(Number(effect.hostileStrengthValue) || 0),
      Math.abs(Number(effect.hostileWarpScrambleStrength) || 0),
      ...(effect.hostileModuleModifierEntries || []).map(entry => Math.abs(Number(entry.value) || 0)),
      ...(effect.hostileChargeModifierEntries || []).map(entry => Math.abs(Number(entry.value) || 0)));
    // A warp disruptor with no warp scramble strength still tackles for the lesson: the career
    // agents' Civilian Warp Disruptor (32459) has 0, and on TQ it completes Your Undivided
    // Attention ("Career missions part 2 - Minmatar", 12:42:39 fitted with strength 0.0,
    // 12:43:51 dunTriggerEffectActivated, then AllObjectivesComplete).
    if (!(magnitude > 0) && family !== "warp-disrupt") return null;
    // A paid neutralizer still applies to an already depleted capacitor. The
    // captured lesson observes the valid effect, not a minimum drained amount.
    if (family === "energy-neutralizer" && !(Number(data.appliedAmount) >= 0)) return null;
  }
  if (!family) return null;
  const cycleAtMs = Math.max(0, Math.trunc(Number(nowMs)));
  const startedAtMs = Math.max(0, Math.trunc(Number(effect.startedAtMs) || cycleAtMs));
  const moduleID = Number(effect.moduleID), effectID = Number(effect.effectID);
  return { family, moduleID, effectID, cycleAtMs, startedAtMs,
    appliedAmount: Math.max(0, Number(data.appliedAmount) || 0),
    cycleID: `${source.itemID}:${moduleID}:${effectID}:${target.itemID}:${startedAtMs}:${cycleAtMs}` };
}

function dispatch(scene, pending) {
  try {
    const sites = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
    if (typeof sites.notifyVisionsModuleCycle !== "function") return false;
    const result = sites.notifyVisionsModuleCycle(scene, pending.source, pending.target, pending.event);
    return result === true || result?.success === true;
  } catch { return false; }
}

function retryPendingVisionsModuleCycles(scene) {
  const pending = scene?._pendingVisionsEwarCycles;
  if (!(pending instanceof Map)) return 0;
  let accepted = 0;
  for (const [key, notice] of pending) if (dispatch(scene, notice)) {
    pending.delete(key); accepted += 1;
  }
  if (!pending.size) delete scene._pendingVisionsEwarCycles;
  return accepted;
}

function noteVisionsPaidEwarCycle(scene, source, effect, result, kind, nowMs) {
  const target = result?.data?.targetEntity;
  if (!scene || scene.getEntityByID?.(source?.itemID) !== source ||
      scene.getEntityByID?.(target?.itemID) !== target || Number(effect?.targetID) !== Number(target?.itemID)) return false;
  const event = buildNotice(source, target, effect, result, kind, nowMs);
  if (!event) return false;
  const key = `${target.dungeonSiteInstanceID}:${source.itemID}:${target.itemID}:${event.family}`;
  const queued = scene._pendingVisionsEwarCycles?.get(key);
  if (queued) return false; // Retain the first paid outcome until its receipt commits.
  const notice = { source, target, event };
  if (dispatch(scene, notice)) return true;
  scene._pendingVisionsEwarCycles ||= new Map();
  scene._pendingVisionsEwarCycles.set(key, notice);
  return false;
}

module.exports = { buildNotice, noteVisionsPaidEwarCycle, retryPendingVisionsModuleCycles };
