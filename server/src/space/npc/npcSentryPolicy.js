"use strict";

const DESTRUCTIBLE_SENTRY_GUN_GROUP_ID = 383;
const NPC_SENTRY_AMMO_DROP_CHANCE = 0.5;

const MISSILE_NAMES_BY_BATTERY_SIZE = Object.freeze({
  light: Object.freeze([
    "Mjolnir Light Missile",
    "Nova Light Missile",
    "Scourge Light Missile",
    "Inferno Light Missile",
  ]),
  heavy: Object.freeze([
    "Mjolnir Heavy Missile",
    "Nova Heavy Missile",
    "Scourge Heavy Missile",
    "Inferno Heavy Missile",
  ]),
  cruise: Object.freeze([
    "Mjolnir Cruise Missile",
    "Nova Cruise Missile",
    "Scourge Cruise Missile",
    "Inferno Cruise Missile",
  ]),
});

const TURRET_AMMO_BASE_NAMES = Object.freeze({
  hybrid: Object.freeze([
    "Antimatter Charge",
    "Plutonium Charge",
    "Uranium Charge",
    "Thorium Charge",
    "Lead Charge",
    "Iridium Charge",
    "Tungsten Charge",
    "Iron Charge",
  ]),
  projectile: Object.freeze([
    "EMP",
    "Phased Plasma",
    "Fusion",
    "Proton",
    "Depleted Uranium",
    "Titanium Sabot",
    "Nuclear",
    "Carbonized Lead",
  ]),
  laser: Object.freeze([
    "Multifrequency",
    "Gamma",
    "Xray",
    "Ultraviolet",
    "Standard",
    "Infrared",
    "Microwave",
    "Radio",
  ]),
});

const STATIONARY_SENTRY_BEHAVIOR_OVERRIDES = Object.freeze({
  movementMode: "hold",
  idleAnchorOrbit: false,
  returnToHomeWhenIdle: false,
  useChasePropulsion: false,
  useSdeChaseVelocity: false,
  cruiseSpeedMetersPerSecond: 0,
  chaseMaxVelocityMetersPerSecond: 0,
});

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function isDestructibleNpcSentry(value) {
  return Boolean(
    value &&
      (
        toPositiveInt(value.groupID, 0) === DESTRUCTIBLE_SENTRY_GUN_GROUP_ID ||
        toPositiveInt(value.slimGroupID, 0) === DESTRUCTIBLE_SENTRY_GUN_GROUP_ID
      )
  );
}

function buildNpcSentryBehaviorOverrides(existingOverrides = {}) {
  return {
    ...(existingOverrides && typeof existingOverrides === "object"
      ? existingOverrides
      : {}),
    ...STATIONARY_SENTRY_BEHAVIOR_OVERRIDES,
  };
}

function applyStationaryNpcSentryState(state) {
  if (!state || typeof state !== "object") {
    return state;
  }
  state.velocity = { x: 0, y: 0, z: 0 };
  state.mode = "STOP";
  state.speedFraction = 0;
  state.targetEntityID = 0;
  state.followRange = 0;
  state.orbitDistance = 0;
  state.maxVelocity = 0;
  if (state.position) {
    state.targetPoint = { ...state.position };
  }
  return state;
}

function applyNpcSentryRuntimePolicy(entity) {
  if (!isDestructibleNpcSentry(entity)) {
    return entity;
  }
  entity.nativeNpcSentry = true;
  applyStationaryNpcSentryState(entity);
  if (entity.spaceState && typeof entity.spaceState === "object") {
    applyStationaryNpcSentryState(entity.spaceState);
  }
  if (entity.passiveDerivedState && typeof entity.passiveDerivedState === "object") {
    entity.passiveDerivedState.maxVelocity = 0;
  }
  return entity;
}

function resolveNpcSentryMissileNames(value) {
  if (!isDestructibleNpcSentry(value)) {
    return [];
  }
  const name = String(
    value.itemName || value.slimName || value.typeName || "",
  ).trim().toLowerCase();
  for (const [size, missileNames] of Object.entries(MISSILE_NAMES_BY_BATTERY_SIZE)) {
    if (name.includes(`${size} missile batter`)) {
      return [...missileNames];
    }
  }
  return [];
}

function resolveNpcSentryTurretFamily(value) {
  const name = String(
    value && (value.itemName || value.slimName || value.typeName) || "",
  ).trim().toLowerCase();
  if (/\b(railgun|blaster)\b/.test(name)) {
    return "hybrid";
  }
  if (/\b(artillery|autocannon)\b/.test(name)) {
    return "projectile";
  }
  if (/\b(beam laser|pulse laser)\b/.test(name)) {
    return "laser";
  }
  return null;
}

function resolveNpcSentryTurretSizeSuffix(optimalSigRadius) {
  const signature = Math.max(0, Number(optimalSigRadius) || 0);
  if (signature > 0 && signature <= 40) {
    return "S";
  }
  if (signature > 0 && signature <= 150) {
    return "M";
  }
  return "L";
}

function resolveNpcSentryAmmoNames(value, options = {}) {
  const missileGroupName = String(options.missileGroupName || "").trim();
  if (missileGroupName) {
    return ["Mjolnir", "Nova", "Scourge", "Inferno"]
      .map((damageName) => `${damageName} ${missileGroupName}`);
  }
  const missileNames = resolveNpcSentryMissileNames(value);
  if (missileNames.length > 0) {
    return missileNames;
  }
  const family = resolveNpcSentryTurretFamily(value);
  const baseNames = family ? TURRET_AMMO_BASE_NAMES[family] : null;
  if (!baseNames) {
    return [];
  }
  const size = resolveNpcSentryTurretSizeSuffix(options.optimalSigRadius);
  return baseNames.map((baseName) => `${baseName} ${size}`);
}

function rollNpcSentryAmmoDrop(value, options = {}) {
  const ammoNames = Array.isArray(options.ammoNames)
    ? options.ammoNames.filter(Boolean).map(String)
    : resolveNpcSentryAmmoNames(value, options);
  if (ammoNames.length <= 0) {
    return null;
  }
  const random = typeof options.random === "function" ? options.random : Math.random;
  const chance = Number.isFinite(Number(options.chance))
    ? Math.max(0, Math.min(1, Number(options.chance)))
    : NPC_SENTRY_AMMO_DROP_CHANCE;
  if (random() >= chance) {
    return null;
  }
  const roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  return {
    itemName: ammoNames[Math.floor(roll * ammoNames.length)],
    quantity: 100,
  };
}

module.exports = {
  DESTRUCTIBLE_SENTRY_GUN_GROUP_ID,
  NPC_SENTRY_AMMO_DROP_CHANCE,
  MISSILE_NAMES_BY_BATTERY_SIZE,
  TURRET_AMMO_BASE_NAMES,
  STATIONARY_SENTRY_BEHAVIOR_OVERRIDES,
  isDestructibleNpcSentry,
  buildNpcSentryBehaviorOverrides,
  applyStationaryNpcSentryState,
  applyNpcSentryRuntimePolicy,
  resolveNpcSentryMissileNames,
  resolveNpcSentryTurretFamily,
  resolveNpcSentryTurretSizeSuffix,
  resolveNpcSentryAmmoNames,
  rollNpcSentryAmmoDrop,
};
