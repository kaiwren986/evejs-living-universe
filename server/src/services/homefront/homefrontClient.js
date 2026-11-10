"use strict";

const {
  buildDict,
  buildFiletimeLong,
  buildList,
} = require("../_shared/serviceHelpers");
const epoch = 116444736000000000n;
const filetime = (ms) =>
  buildFiletimeLong(epoch + BigInt(Math.trunc(ms)) * 10000n);
function marshal(value) {
  // A real list: a tuple is taken for one target (objective_task/target.py L217),
  // and the objective tracker then raises on every update.
  if (Array.isArray(value)) return buildList(value.map(marshal));
  if (value && typeof value === "object" && !value.type)
    return buildDict(Object.entries(value).map(([k, v]) => [k, marshal(v)]));
  return value;
}
// Names consumed by recovered client graphs 648, 657, 658 and shared graph
// 669. Counters alone do not switch the siege/mining/evacuation objectives.
function dungeonState(siteConfig, operationState) {
  if (operationState.status === "failed")
    return (
      {
        three_civilians_harmed: "FailureCivilians",
        five_smugglers_escaped: "FailureSmugglers",
        asteroids_remaining: "FailureTimeout",
      }[operationState.failure] || "Failure"
    );
  if (operationState.status === "completed") return "Success";
  if (siteConfig.family === "abyssal_artifact_recovery")
    return (
      { wave: "Wave", escape: "SuccessEscape", intermission: "Cooldown" }[
        operationState.phase
      ] || "Default"
    );
  if (siteConfig.family === "dread_assault" && operationState.phase === "siege")
    return "Siege";
  if (siteConfig.family === "suspicious_signal")
    return require("./homefrontEngine").signalVulnerable(
      operationState,
      siteConfig.hackTargets.map(
        (profileEntry) => `hack:${profileEntry.objectID}`,
      ),
    )
      ? "Vulnerable"
      : "Invulnerable";
  if (
    siteConfig.family === "salvage_research" &&
    operationState.werpostActivated
  )
    return "Hacked";
  return "Default";
}
function values(instance, scene = null, now = Date.now()) {
  const runtime = require("./homefrontRuntime");
  const siteConfig = runtime.config(instance);
  if (!siteConfig) return buildDict([]);
  const operationState = runtime.getState(instance);
  if (!operationState) return buildDict([]);
  scene ||= require("../../space/runtime").scenes.get(instance.solarSystemID);
  const entities = scene
    ? require("./homefrontWorld").all(scene, instance)
    : [];
  const targets = (role) =>
    entities
      .filter((entity) => entity.homefrontRole === role)
      .map((entity) => ({ item_id: entity.itemID, type_id: entity.typeID }));
  const timer = (end) => ({
    start_time: filetime(now - operationState.elapsedMs),
    end_time: filetime(now + Math.max(0, end - operationState.elapsedMs)),
  });
  const result = {
    dungeon_state: dungeonState(siteConfig, operationState),
    timer: timer(siteConfig.durationMs),
    protect_target: targets("protected"),
    destroy_target: targets("objective"),
    items_delivered: operationState.deliveries,
    required_items: 4,
    container_target: targets("receiver")[0] || null,
    charge: (operationState.capacitors.dread || 0) * 30000,
    capacitor_need: 30000,
    charge_target: targets("dread")[0] || null,
    asteroid_target: targets("rock")[0] || null,
    current_value: operationState.rocksCleared,
    goal_value: 1,
    friendly_fire_current: Object.keys(operationState.civilianStrikes).length,
    friendly_fire_max: 3,
    escaped_current: operationState.smugglerEscapes,
    escaped_max: 5,
    salvaged_current: operationState.salvaged,
    salvaged_goal: 30,
    target: { type_id: 81438 },
    max_charge: 100,
    min_charge: 0,
    charge_requirement: 20,
    drain_display_percentage: true,
    wave_number: operationState.wave,
    wave_number_max: 9,
    asteroids_depleted: operationState.rocksCleared,
    asteroids_depleted_max: 12,
    asteroids: { type_id: 77524 },
    dungeon_completed: operationState.status === "completed",
  };
  if (siteConfig.family === "metaliminal_meteoroid") {
    const rock = entities.find((entity) => entity.homefrontRole === "rock");
    const profile = siteConfig.rocks[operationState.selectedRock ?? 0];
    result.goal_value = profile?.quantity || 5000;
    result.ore_quantity_current =
      rock?.miningRemainingQuantity ??
      Object.values(operationState.ore || {})[0] ??
      result.goal_value;
    result.current_value = Math.max(
      0,
      result.goal_value - result.ore_quantity_current,
    );
  }
  if (operationState.phase === "siege")
    result.siege_timer = timer(operationState.phaseEndsAtMs);
  const phaseTimer = {
    preparation: "initial_timer",
    wave: "wave_timer",
    intermission: "cooldown_timer",
    escape: "escape_timer",
  }[operationState.phase];
  if (phaseTimer) result[phaseTimer] = timer(operationState.phaseEndsAtMs);
  [...siteConfig.hackTargets]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach((profileEntry, i) => {
      const key = `hack:${profileEntry.objectID}`;
      const letter = String.fromCharCode(97 + i);
      const entity = entities.find((entity) => entity.homefrontKey === key);
      result[`node_${letter}_target`] = entity
        ? { item_id: entity.itemID, type_id: entity.typeID }
        : null;
      // Values are merged into the client's blackboard; explicitly clear an
      // expired timer rather than leaving the previous successful hack visible.
      result[`node_${letter}_timer`] =
        operationState.hacks[key] > operationState.elapsedMs
          ? timer(operationState.hacks[key])
          : null;
    });
  for (let i = 0; i < 5; i++) {
    const key = `array:${i}`;
    const entity = entities.find((entity) => entity.homefrontKey === key);
    const letter = String.fromCharCode(97 + i);
    result[`current_${letter}`] = (operationState.capacitors[key] ?? 1) * 100;
    result[`target_${letter}`] = {
      type_id: 81402,
      ...(entity ? { item_id: entity.itemID } : {}),
    };
  }
  return marshal(result);
}
function publish(scene, instance, ships, now) {
  const template = require("../dungeon/dungeonAuthority").getTemplateByID(
    instance.templateID,
  );
  const payload = values(instance, scene, now);
  for (const ship of ships)
    ship.session?.sendNotification?.("OnDungeonValues", "charid", [
      template.sourceDungeonID,
      payload,
    ]);
}
module.exports = { values, publish, dungeonState };
