"use strict";

module.exports = {
  normalizeModuleConsequenceDelivery,
  resolveModuleConsequenceDelivery,
};

const {
  isSnapshotWeaponFamily,
} = require("./weaponSnapshot");

const MODULE_CONSEQUENCE_DELIVERY = Object.freeze({
  ACTIVATION: "activation",
  BOUNDARY: "boundary",
  CONTINUOUS: "continuous",
  MANAGED: "managed",
  LEGACY_UNKNOWN: "legacy-unknown",
});

const MODULE_CONSEQUENCE_DELIVERY_VALUES = new Set(
  Object.values(MODULE_CONSEQUENCE_DELIVERY),
);

const CONTINUOUS_ASSISTANCE_FAMILIES = new Set([
  "remoteSensorBoost",
  "remoteTracking",
]);

const ACTIVATION_ASSISTANCE_FAMILIES = new Set([
  "remoteCapacitor",
  "remoteShield",
  "remoteArmor",
  "remoteHull",
]);

const CONTINUOUS_HOSTILE_FAMILIES = new Set([
  "stasisWebifier",
  "targetPainter",
  "warpScrambler",
  "warpDisruptor",
  "sensorDampener",
  "trackingDisruptor",
  "guidanceDisruptor",
]);

const ACTIVATION_HOSTILE_FAMILIES = new Set([
  "energyNeutralizer",
  "energyNosferatu",
]);

function normalizeModuleConsequenceDelivery(rawDelivery) {
  const normalizedDelivery = String(rawDelivery || "").trim();
  return MODULE_CONSEQUENCE_DELIVERY_VALUES.has(normalizedDelivery)
    ? normalizedDelivery
    : MODULE_CONSEQUENCE_DELIVERY.LEGACY_UNKNOWN;
}

function resolveModuleConsequenceDelivery(effectState) {
  if (!effectState || typeof effectState !== "object") {
    return MODULE_CONSEQUENCE_DELIVERY.LEGACY_UNKNOWN;
  }

  // These families already own their terminal/reload sequencing. The shared
  // repeat lifecycle must not create a second terminal policy for them.
  if (
    effectState.cloakModuleEffect === true ||
    effectState.cynosuralGeneration === true ||
    effectState.superweaponEffect === true ||
    effectState.commandBurstEffect === true ||
    effectState.autoDeactivateAtCycleEnd === true
  ) {
    return MODULE_CONSEQUENCE_DELIVERY.MANAGED;
  }

  // These families pay at activation but deliver their authoritative outcome
  // only when that paid cycle reaches its boundary.
  if (
    effectState.miningEffect === true ||
    effectState.salvagerEffect === true ||
    effectState.microJumpDriveEffect === true ||
    // A cargo or ship scanner pays capacitor when it starts and opens the
    // client's result window when the cycle completes. Every one of the seven
    // published types also declares disallowRepeatingActivation, so that single
    // cycle IS the module: left in the legacy-unknown class its only boundary
    // is the terminal one, which returns before any per-cycle work runs and the
    // scan would deliver nothing however it were written.
    effectState.scannerModuleEffect === true ||
    (
      effectState.localCycleEffect === true &&
      effectState.localCycleTiming === "end"
    )
  ) {
    return MODULE_CONSEQUENCE_DELIVERY.BOUNDARY;
  }

  const assistanceFamily = String(effectState.assistanceFamily || "").trim();
  const hostileFamily = String(effectState.hostileFamily || "").trim();
  if (
    effectState.tractorBeamEffect === true ||
    effectState.bastionModuleEffect === true ||
    CONTINUOUS_ASSISTANCE_FAMILIES.has(assistanceFamily) ||
    CONTINUOUS_HOSTILE_FAMILIES.has(hostileFamily)
  ) {
    return MODULE_CONSEQUENCE_DELIVERY.CONTINUOUS;
  }

  if (
    (
      effectState.localCycleEffect === true &&
      effectState.localCycleTiming === "start"
    ) ||
    isSnapshotWeaponFamily(effectState.weaponFamily) ||
    effectState.pointDefenseEffect === true ||
    effectState.smartbombEffect === true ||
    effectState.jammerModuleEffect === true ||
    effectState.jammerBurstEffect === true ||
    ACTIVATION_ASSISTANCE_FAMILIES.has(assistanceFamily) ||
    ACTIVATION_HOSTILE_FAMILIES.has(hostileFamily)
  ) {
    return MODULE_CONSEQUENCE_DELIVERY.ACTIVATION;
  }

  if (effectState.affectsShipDerivedState === true) {
    return MODULE_CONSEQUENCE_DELIVERY.CONTINUOUS;
  }

  // Unknown family/timing combinations deliberately retain the Phase-A path.
  // Retail timing evidence is required before moving them out of this class.
  return MODULE_CONSEQUENCE_DELIVERY.LEGACY_UNKNOWN;
}

Object.assign(module.exports, {
  ACTIVATION_ASSISTANCE_FAMILIES,
  ACTIVATION_HOSTILE_FAMILIES,
  CONTINUOUS_ASSISTANCE_FAMILIES,
  CONTINUOUS_HOSTILE_FAMILIES,
  MODULE_CONSEQUENCE_DELIVERY,
  MODULE_CONSEQUENCE_DELIVERY_VALUES,
});
