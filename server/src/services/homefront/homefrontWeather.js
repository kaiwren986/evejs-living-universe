"use strict";

// Client appliedProximityEffects IDs. Strengths and radius come from the pack's
// recovered type components; these bindings use the same Dogma attributes and
// non-stacking percent operation as the existing Abyssal weather engine.
const BINDINGS = {
  90: [271, 267, 113],
  92: [55],
  93: [272, 268, 111],
  94: [263],
  95: [274, 270, 110],
  96: [265],
  98: [37],
  99: [273, 269, 109],
  100: [564],
};
const RANGE_ATTRIBUTE = 9880000002;
function descriptor(siteConfig, state) {
  return (
    siteConfig.artifactWeather?.choices[state.weather]?.tiers[
      state.weatherTier ?? Math.floor((state.wave - 1) / 3)
    ] || null
  );
}
function context(entity) {
  if (!entity?.position || !["ship", "drone", "fighter"].includes(entity.kind))
    return null;
  const instanceID =
    entity.homefrontWeatherInstanceID ||
    entity.dungeonCurrentInstanceID ||
    entity.dungeonSiteInstanceID;
  if (!instanceID) return null;
  if (entity.homefrontParkedInstanceID === instanceID) return null;
  const runtime = require("./homefrontRuntime");
  const instance = runtime.homefrontInstance(instanceID);
  if (
    !instance ||
    ["completed", "failed", "despawned"].includes(instance.lifecycleState)
  )
    return null;
  const selection = entity.homefrontWeatherSelection;
  if (selection?.instanceID === instance.instanceID) {
    const { weather, center } = selection;
    return Math.hypot(
      entity.position.x - center.x,
      entity.position.y - center.y,
      entity.position.z - center.z,
    ) <= weather.radius
      ? { instance, weather }
      : null;
  }
  const siteConfig = runtime.config(instance);
  if (!siteConfig || siteConfig.family !== "abyssal_artifact_recovery")
    return null;
  const state = runtime.getState(instance);
  if (!state || state.weatherCleanedUp) return null;
  const weather = descriptor(siteConfig, state);
  if (!weather) return null;
  const center = runtime.position(instance, siteConfig);
  if (
    Math.hypot(
      entity.position.x - center.x,
      entity.position.y - center.y,
      entity.position.z - center.z,
    ) > weather.radius
  )
    return null;
  return { instance, c: siteConfig, state, weather };
}
function shipModifiers(entity) {
  const ctx = context(entity);
  if (!ctx) return [];
  return Object.entries(ctx.weather.effects).flatMap(([id, value]) =>
    (BINDINGS[id] || []).map((modifiedAttributeID) => ({
      modifiedAttributeID,
      operation: 6,
      value,
      stackingPenalized: false,
      modifierSourceKey: `homefront-weather:${ctx.instance.instanceID}`,
    })),
  );
}
function locationModifiers(entity) {
  const ctx = context(entity);
  const percent = ctx?.weather.effects[97];
  if (percent == null) return [];
  return [
    {
      sourceKind: "homefrontWeather",
      sourceAttributes: { [RANGE_ATTRIBUTE]: percent },
      sourceEffects: [
        {
          name: "homefrontDarkWeather",
          modifierInfo: [53, 55, 74].flatMap((groupID) =>
            [54, 158].map((modifiedAttributeID) => ({
              func: "LocationModifier",
              domain: "shipID",
              groupID,
              modifiedAttributeID,
              modifyingAttributeID: RANGE_ATTRIBUTE,
              operation: 6,
            })),
          ),
        },
      ],
    },
  ];
}
function mergeClientDbuffState(entity, entries) {
  const ctx = context(entity);
  if (!ctx || entity.kind !== "ship") return entries;
  // Presentation only: shipModifiers/locationModifiers already apply Dogma.
  // The client replaces its entire buff list on each OnDbuffUpdated/SetState,
  // so merge here without creating a second mechanical command-burst source.
  const merged = new Map(entries);
  for (const [id, value] of Object.entries(ctx.weather.effects)) {
    const collectionID = Number(id);
    const existing = merged.get(collectionID);
    // Recovered client DBuff aggregation: recharge/range use Minimum; the
    // remaining weather collections use Maximum. Continuous weather has no timer.
    const minimum = collectionID === 92 || collectionID === 97;
    if (!existing || (minimum ? value <= existing[0] : value >= existing[0]))
      merged.set(collectionID, [value, null]);
  }
  return [...merged].sort((a, b) => a[0] - b[0]);
}
function sync(scene, instance, siteConfig, state, cleanup = false) {
  if (cleanup) {
    state.weatherCleanedUp = true;
    // Attribute/HUD fallback queries must see removal before clearing snapshots.
    require("./homefrontRewards").markOperationDirty(instance, state);
  }
  const weather =
    cleanup || state.weatherCleanedUp ? null : descriptor(siteConfig, state);
  const center = require("./homefrontRuntime").position(instance, siteConfig);
  for (const entity of scene.dynamicEntities.values()) {
    if (!["ship", "drone", "fighter"].includes(entity.kind) || !entity.position)
      continue;
    const inside =
      weather &&
      Math.hypot(
        entity.position.x - center.x,
        entity.position.y - center.y,
        entity.position.z - center.z,
      ) <= weather.radius;
    if (!inside && entity.homefrontWeatherInstanceID !== instance.instanceID)
      continue;
    if (inside) {
      entity.homefrontWeatherInstanceID = instance.instanceID;
      // This transient snapshot avoids reading/cloning the persisted replay
      // table on every weapon/active-module attribute query between ticks.
      entity.homefrontWeatherSelection = {
        instanceID: instance.instanceID,
        weather,
        center,
      };
    } else {
      delete entity.homefrontWeatherInstanceID;
      delete entity.homefrontWeatherSelection;
    }
    const signature = inside ? `${instance.instanceID}:${weather.typeID}` : "";
    const session = entity.session;
    const hudSignature = `${entity.itemID}:${signature}`;
    if (
      entity.kind === "ship" &&
      session?._space &&
      session._space.homefrontWeatherHudSignature !== hudSignature
    ) {
      if (
        require("../../space/runtime/commandBurst").notifyCommandBurstDbuffStateToSession(
          scene,
          session,
          entity,
          null,
          { force: true, reason: "homefront-weather" },
        )
      )
        session._space.homefrontWeatherHudSignature = hudSignature;
    }
    if (entity.homefrontWeatherSignature === signature) continue;
    entity.homefrontWeatherSignature = signature;
    // Rebuild from base/fitted attributes, never multiply the current values.
    // Both players and native NPC ships use this common derived-state path.
    if (entity.kind === "ship") {
      const result = scene.refreshShipEntityDerivedState(entity);
      if (!result?.success) delete entity.homefrontWeatherSignature; // Retry once the ship is fully materialized.
    } else if (entity.kind === "drone") {
      const controller = scene.getEntityByID(
        entity.controllerID || entity.launcherID,
      );
      if (
        !require("../drone/droneRuntime").applyDroneOperationalEntityAttributes(
          entity,
          controller,
        )
      )
        delete entity.homefrontWeatherSignature;
    }
  }
}
function cleanupSite(scene, instance) {
  const runtime = require("./homefrontRuntime");
  const siteConfig = runtime.config(instance);
  if (!siteConfig || siteConfig.family !== "abyssal_artifact_recovery") return;
  const state = runtime.getState(instance);
  if (!state) return;
  sync(scene, instance, siteConfig, state, true);
}
module.exports = {
  descriptor,
  shipModifiers,
  locationModifiers,
  mergeClientDbuffState,
  sync,
  cleanupSite,
};
