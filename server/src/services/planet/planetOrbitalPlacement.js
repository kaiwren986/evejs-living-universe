"use strict";

// Position ownership is inventory for player orbitals and the scene builder for
// synthetic offices. Keep their clearance policy in one place. The clearance is
// a conservative server policy, not an asserted retail orbit measurement.
const POSITION_VERSION = 1;
const MIN_CLEARANCE_METERS = 500_000;
const PLANET_CLEARANCE_FRACTION = 0.5;
const CUSTOMS_GROUPS = new Set([1025, 1106, 4736]);
const UNANCHORED_STATES = new Set([-2, -3]);
const { resolveEntityInteractionScope } = require("../../space/destiny/identity/interactionScope");

function finiteVector(value) {
  if (!value || ![value.x, value.y, value.z].every((v) => Number.isFinite(Number(v)))) {
    return null;
  }
  return { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
}

function hasPrivateScope(value, ports = {}) {
  if (!value) return false;
  const scope = resolveEntityInteractionScope(value);
  if (!scope.valid || scope.hasAirScope || scope.hasAbyssalScope) return true;
  // Ordinary site tags identify shared space. Only an instance explicitly
  // marked private by the existing dungeon policy is an isolation boundary.
  if (scope.hasDungeonScope && scope.dungeonInstanceID !== null) {
    const getInstance = ports.getDungeonInstance ||
      require("../dungeon/dungeonRuntime").getInstanceRef;
    const instance = getInstance(scope.dungeonInstanceID);
    return require("../dungeon/dungeonVisibilityPolicy").isPrivateDungeonInstance(instance);
  }
  return false;
}

function getOrbitalPlacementRadius(planet, orbital = {}) {
  const planetRadius = Math.max(1_000, Number(planet && planet.radius) || 0);
  const orbitalRadius = Math.max(0, Number(orbital.radius || orbital.spaceRadius) || 7_500);
  return planetRadius + Math.max(
    MIN_CLEARANCE_METERS,
    planetRadius * PLANET_CLEARANCE_FRACTION,
    orbitalRadius + 10_000,
  );
}

function buildOrbitalDirection(orbital = {}) {
  const seed = Math.abs(Math.trunc(Number(orbital.planetID || orbital.itemID) || 1));
  const angle = (((seed * 41) % 360) * Math.PI) / 180;
  const y = (((seed * 29) % 200) - 100) / 500;
  const planar = Math.sqrt(Math.max(0, 1 - y * y));
  return { x: Math.cos(angle) * planar, y, z: Math.sin(angle) * planar };
}

function buildOrbitalPosition(planet, orbital = {}, options = {}) {
  const center = finiteVector(planet && planet.position) || { x: 0, y: 0, z: 0 };
  const supplied = finiteVector(options.direction);
  const length = supplied ? Math.hypot(supplied.x, supplied.y, supplied.z) : 0;
  const direction = length > 0 ? {
    x: supplied.x / length, y: supplied.y / length, z: supplied.z / length,
  } : buildOrbitalDirection(orbital);
  const radius = getOrbitalPlacementRadius(planet, orbital);
  return {
    x: center.x + direction.x * radius,
    y: center.y + direction.y * radius,
    z: center.z + direction.z * radius,
  };
}

function isPublicPlanetOrbital(entity) {
  return Boolean(
    entity && entity.kind === "orbital" &&
    [1025, 4736].includes(Number(entity.groupID)) &&
    !entity.destroyed && !entity.destroyedAtMs &&
    !UNANCHORED_STATES.has(Number(entity.orbitalState)) &&
    !hasPrivateScope(entity)
  );
}

function planOrbitalPositionMigration(item, orbital, planet) {
  const spaceState = item && item.spaceState;
  const systemID = Number(orbital && orbital.solarSystemID);
  if (!item || !orbital || !planet || !spaceState ||
      Number(item.categoryID) !== 46 || !CUSTOMS_GROUPS.has(Number(item.groupID)) ||
      orbital.destroyedAtMs || UNANCHORED_STATES.has(Number(orbital.state)) ||
      Number(item.locationID) !== systemID || Number(spaceState.systemID) !== systemID ||
      Number(planet.solarSystemID) !== systemID ||
      Number(planet.itemID || planet.planetID) !== Number(orbital.planetID) ||
      hasPrivateScope(item) || hasPrivateScope(spaceState) ||
      (spaceState.sceneKind && spaceState.sceneKind !== "solarSystem") ||
      Number(spaceState.orbitalPositionVersion) >= POSITION_VERSION) {
    return null;
  }
  const center = finiteVector(planet.position);
  const previousPosition = finiteVector(spaceState.position);
  if (!center || !previousPosition) return null;
  const direction = {
    x: previousPosition.x - center.x,
    y: previousPosition.y - center.y,
    z: previousPosition.z - center.z,
  };
  const distance = Math.hypot(direction.x, direction.y, direction.z);
  const minimumRadius = getOrbitalPlacementRadius(planet, item);
  const moved = distance + 1 < minimumRadius;
  const position = moved ? buildOrbitalPosition(planet, orbital, { direction }) : previousPosition;
  return {
    itemID: Number(item.itemID),
    moved,
    previousPosition,
    position,
    item: {
      ...item,
      spaceState: {
        ...spaceState,
        orbitalPositionVersion: POSITION_VERSION,
        ...(moved ? { position, targetPoint: { ...position } } : {}),
      },
    },
  };
}

// Called before a public scene publishes entities, so persistence failure cannot
// expose a migrated in-memory position that will revert on the next load.
function migratePlanetOrbitalsForScene(items, descriptor, ports = {}) {
  if (!descriptor || descriptor.sceneKind !== "solarSystem") {
    return { success: true, migrated: 0, moved: 0, changes: [] };
  }
  const resolveOrbital = ports.resolveOrbital || ((item) => (
    require("./planetOrbitalState").ensureOrbitalForItem(item, {
      solarSystemID: descriptor.locationID,
    })
  ));
  const resolvePlanet = ports.resolvePlanet || ((planetID) => (
    require("../../space/worldData").getCelestialByID(planetID)
  ));
  const updateItems = ports.updateItems || ((ids, updater) => (
    require("../inventory/itemStore").updateInventoryItemsAtomic(ids, updater)
  ));
  const flushItems = ports.flushItems || (ports.updateItems
    ? () => ({ success: true })
    : () => require("../../gameStore").flushTableSync("items"));
  const plans = new Map();
  for (const item of items || []) {
    if (Number(item && item.categoryID) !== 46 ||
        !CUSTOMS_GROUPS.has(Number(item.groupID)) ||
        Number(item.locationID) !== Number(descriptor.locationID)) continue;
    const orbital = resolveOrbital(item);
    const planet = orbital && resolvePlanet(orbital.planetID);
    const plan = planOrbitalPositionMigration(item, orbital, planet);
    if (plan) plans.set(plan.itemID, { ...plan, orbital, planet });
  }
  if (!plans.size) {
    // Retry a failed flush even if the owner cache already contains the new
    // version from that attempt. Do not publish before it becomes durable.
    const flushed = flushItems();
    return flushed && flushed.success !== false
      ? { success: true, migrated: 0, moved: 0, changes: [] }
      : { success: false, errorMsg: flushed && flushed.errorMsg || "WRITE_ERROR", migrated: 0, moved: 0, changes: [] };
  }
  const applied = [];
  const result = updateItems([...plans.keys()], (current) => {
    const plan = plans.get(Number(current.itemID));
    // Recheck current ownership/location and position inside the inventory write.
    const latest = planOrbitalPositionMigration(current, plan.orbital, plan.planet);
    if (latest) applied.push(latest);
    return latest ? latest.item : current;
  });
  if (!result || result.success !== true) {
    return { success: false, errorMsg: result && result.errorMsg || "WRITE_ERROR", migrated: 0, moved: 0, changes: [] };
  }
  const flushed = flushItems();
  if (!flushed || flushed.success === false) {
    return { success: false, errorMsg: flushed && flushed.errorMsg || "WRITE_ERROR", migrated: 0, moved: 0, changes: [] };
  }
  return {
    success: true,
    migrated: applied.length,
    moved: applied.filter((plan) => plan.moved).length,
    changes: result.changes || result.data && result.data.changes || [],
  };
}

module.exports = {
  POSITION_VERSION,
  MIN_CLEARANCE_METERS,
  PLANET_CLEARANCE_FRACTION,
  buildOrbitalDirection,
  getOrbitalPlacementRadius,
  buildOrbitalPosition,
  planOrbitalPositionMigration,
  migratePlanetOrbitalsForScene,
  isPublicPlanetOrbital,
  hasPrivateScope,
};
