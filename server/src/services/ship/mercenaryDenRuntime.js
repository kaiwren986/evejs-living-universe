"use strict";

// The Mercenary Den in space: launch from a ship's hold next to a temperate
// planet's Orbital Skyhook, activation, reinforcement, owner notices,
// destruction and infomorph extraction. The den's sovereignty record
// (evolution, infomorphs, gateway reads) belongs to
// sovereignty/mercenaryDenState; the in-space component state this file runs
// (activation, reinforcement, attack notices) is kept on that record too, in
// its "space" field, so the den item needs no field of its own.
//
// Client 3396210 sources:
// - Static data spacecomponentsbytype 85230 and 85980: activate
//   durationSeconds 600; deploy deployAtRange 1250, maxSecurityLevel 0.0,
//   launchForOwnCorp 0, minDistanceFromOwnGroup 1000000,
//   minDistanceFromControlTower 100000, disallowInWormholeSpace 1,
//   isForPlayerOwnableSpace 1; fitting range 3000; mercenaryDen; reinforce
//   durationSeconds 86400, jitterSeconds 21600, emitAttack {frequency 60,
//   shieldLevelThreshold 95}.
// - Skill 85233 Mercenary Den Management: within 10 km of a temperate planet's
//   Skyhook, one den per skill level.
// - sovereignty/mercenaryden/common/errors.py RegistrationInvalid reasons and
//   client/repository.py: OnMercenaryDenRegistrationSuccess,
//   OnMercenaryDenRegistrationInvalid (notifyMsg, notifyArgs) open the FSD
//   dialog notifyMsg with notifyArgs; OnMyMercenaryDenRemoved reads
//   notifyArgs['itemID'].
// - spacecomponents/client/components/mercenaryDen.py: component_activate
//   drives the build-up; ExtractInfomorphsToShip(flagID, quantity) is a
//   CallComponentFromClient on component 'mercenaryDen' that returns the
//   quantity moved.
// - eve/client/script/ui/inflight/selectedItemTimers.py GetMercDenTimer reads
//   component_reinforce (isReinforced, timestamp).
// - notifications/common/formatters/mercenaryDen.py MakeData: the data of
//   MercenaryDenReinforced (286) and MercDenAttacked (287).

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  findItemById,
  getItemMetadata,
  grantItemToOwnerLocation,
  listContainerItems,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const mobileItemCustody = require(path.join(__dirname, "../inventory/mobileItemCustody"));
const { buildDict } = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { random: sharedRandom } = require(path.join(__dirname, "../../common/random"));
const { getWallclockNowMs } = require(path.join(__dirname, "../../space/runtime/runtimeClock"));
const {
  MachoWrappedException,
  buildUserErrorPayload,
} = require(path.join(__dirname, "../../common/machoErrors"));
const denState = require(path.join(__dirname, "../sovereignty/mercenaryDenState"));
const {
  MERCENARY_DEN_MANAGEMENT_SKILL_TYPE_ID,
  TYPE_MERCENARY_DEN,
  TYPE_SENESCHAL_MERCENARY_DEN,
} = require(path.join(__dirname, "../sovereignty/sovConstants"));

const GROUP_MERCENARY_DEN = 4810;
const CATEGORY_DEPLOYABLE = 22;
const CATEGORY_STARBASE = 23;
const GROUP_CONTROL_TOWER = 365;
const TYPE_ORBITAL_SKYHOOK = 81080;
const TYPE_PLANET_TEMPERATE = 11;

const ACTIVATION_MS = 600 * 1000;
const DEPLOY_AT_RANGE_METERS = 1250;
const SKYHOOK_MAX_DISTANCE_METERS = 10_000;
const MIN_DISTANCE_FROM_OWN_GROUP_METERS = 1_000_000;
const MIN_DISTANCE_FROM_CONTROL_TOWER_METERS = 100_000;
const MAX_SECURITY_LEVEL = 0.0;
const FITTING_RANGE_METERS = 3000;
const REINFORCE_DURATION_MS = 86400 * 1000;
const REINFORCE_JITTER_MS = 21600 * 1000;
const ATTACK_NOTICE_INTERVAL_MS = 60 * 1000;
const ATTACK_NOTICE_SHIELD_THRESHOLD = 0.95;
// Patch 22.02: infomorphs cannot be taken until the shield is repaired above
// 50% (dialog MercenaryDenExtractionWithoutShieldHp, minShieldHpPercent).
const EXTRACTION_MIN_SHIELD = 0.5;
// Revenant notes: a destroyed den has a 50% chance to drop its infomorphs.
const INFOMORPH_DROP_CHANCE = 0.5;
const NOTIFICATION_MERCENARY_DEN_REINFORCED = 286;
const NOTIFICATION_MERC_DEN_ATTACKED = 287;
const OWNER_DEATHLESS_CUSTODIANS = 1000438;
const OWNER_UNKNOWN = 3006;
const LAUNCH_SOURCE_FLAGS = new Set([
  ITEM_FLAGS.CARGO_HOLD,
  ITEM_FLAGS.FLEET_HANGAR,
  ITEM_FLAGS.INFRASTRUCTURE_HOLD,
]);
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const REGISTRATION_REASON = Object.freeze({
  UNKNOWN: "MercenaryDen_DeploymentFailed",
  SKILL_LIMITS: "MercenaryDen_DeploymentFailed_SkillLimits",
  SKYHOOK_ALREADY_OCCUPIED: "MercenaryDen_DeploymentFailed_SkyhookAlreadyOccupied",
  SKYHOOK_NOT_FOUND: "MercenaryDen_DeploymentFailed_RequiresNearbySkyhook",
  SKYHOOK_OFFLINE: "MercenaryDen_DeploymentFailed_RequiresOnlineSkyhook",
  PLANET_DOES_NOT_SUPPORT_DENS: "MercenaryDen_DeploymentFailed_MustBeTemperatePlanet",
  MAXIMUM_DENS_REACHED: "MercenaryDen_DeploymentFailed_MaximumDensReached",
});
const REGISTRATION_SUCCESS = "MercenaryDen_DeploymentSuccessful";

const timersByDenID = new Map();
let nowOverride = null;
let randomOverride = null;

function getNowMs() {
  return typeof nowOverride === "function" ? nowOverride() : getWallclockNowMs();
}

function getRandom() {
  return typeof randomOverride === "function" ? randomOverride() : sharedRandom();
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toReal(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value, fallback = 1) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getPositionOf(source) {
  const position = source && (source.position || (source.spaceState && source.spaceState.position));
  if (!position) return null;
  const vector = { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
  return [vector.x, vector.y, vector.z].every(Number.isFinite) ? vector : null;
}

function distanceBetween(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function getRadiusOf(source) {
  const metadata = source && getItemMetadata(source.typeID) || {};
  return Math.max(0, toReal(source && (source.radius || source.spaceRadius), toReal(metadata.radius, 0)));
}

function isMercenaryDenType(typeIDOrItem) {
  if (typeIDOrItem && typeof typeIDOrItem === "object") {
    const typeID = toInt(typeIDOrItem.typeID, 0);
    return typeID === TYPE_MERCENARY_DEN || typeID === TYPE_SENESCHAL_MERCENARY_DEN ||
      toInt(typeIDOrItem.groupID, 0) === GROUP_MERCENARY_DEN;
  }
  const typeID = toInt(typeIDOrItem, 0);
  return typeID === TYPE_MERCENARY_DEN || typeID === TYPE_SENESCHAL_MERCENARY_DEN;
}

// The den's in-space state with its identity: the record's "space" plus the
// den, owner, system, skyhook and planet.
function getDenSpaceState(itemOrID) {
  const denID = toInt(itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID, 0);
  if (!denID || (itemOrID && typeof itemOrID === "object" && !isMercenaryDenType(itemOrID))) {
    return null;
  }
  const record = denState.peekMercenaryDenRecord(denID);
  if (!record || !record.space) return null;
  return {
    denID,
    ownerCharacterID: toInt(record.ownerCharacterID, 0),
    solarSystemID: toInt(record.solarSystemID, 0),
    skyhookID: toInt(record.skyhookID, 0),
    planetID: toInt(record.planetID, 0),
    ...record.space,
  };
}

function toStoredSpace(state) {
  return {
    deployedAtMs: state.deployedAtMs,
    activateAtMs: state.activateAtMs,
    active: state.active === true,
    reinforcement: state.reinforcement || null,
    lastAttackNoticeAtMs: state.lastAttackNoticeAtMs || 0,
  };
}

function updateDenSpaceState(denID, updater, nowMs = getNowMs()) {
  const current = getDenSpaceState(denID);
  if (!current) return { success: false, errorMsg: "MERCENARY_DEN_NOT_REGISTERED" };
  const result = denState.updateMercenaryDenSpace(denID, () => toStoredSpace(updater({ ...current })), nowMs);
  return result.ok ? { success: true } : { success: false, errorMsg: result.errorCode };
}

function isReinforcedState(state, nowMs = getNowMs()) {
  return Boolean(state && state.reinforcement && state.reinforcement.stage === "reinforced" &&
    state.reinforcement.endsAtMs > nowMs);
}

// --- client messages ---------------------------------------------------------

function buildArgsDict(values) {
  return buildDict(Object.entries(values));
}

function findOwnerSession(characterID, fallbackSession = null) {
  if (fallbackSession && toInt(fallbackSession.characterID, 0) === toInt(characterID, 0)) {
    return fallbackSession;
  }
  try {
    return require(path.join(__dirname, "../chat/sessionRegistry"))
      .findSessionByCharacterID(characterID);
  } catch (_) {
    // ignored: no registry in isolated callers; the notice is advisory
    return null;
  }
}

function sendDenNotify(session, eventName, message, values) {
  if (!session || typeof session.sendNotification !== "function") return false;
  session.sendNotification(eventName, "charid", [message, buildArgsDict(values)]);
  return true;
}

function refusal(message, reason, values = {}) {
  const error = new MachoWrappedException(buildUserErrorPayload(message, values));
  error.reason = reason;
  return error;
}

// sovereignty/mercenaryden/client/notice_listener.py: the owner's client
// takes EvolutionStateChangedNotice (mercenary_den, state) and redraws the
// den's levels and pause.
function publishEvolutionState(denID, nowMs) {
  try {
    const gateway = require(path.join(__dirname, "../../_secondary/express/publicGatewayNotices")).getPublicGateway();
    const den = denState.getMercenaryDenByID(denID, nowMs);
    if (!gateway || !den) return;
    const { lookupType } = require(path.join(__dirname, "../sovereignty/sovGatewayProto"));
    const { buildEvolutionPayload } = require(path.join(
      __dirname,
      "../../_secondary/express/gatewayServices/mercenaryDenGatewayService",
    ));
    const typeName = "eve_public.sovereignty.mercenaryden.api.EvolutionStateChangedNotice";
    const type = lookupType(typeName);
    const payload = {
      mercenary_den: { sequential: den.mercenaryDenID },
      state: buildEvolutionPayload(den.evolution).simulation,
    };
    gateway.publishGatewayNotice(
      typeName,
      Buffer.from(type.encode(type.create(payload)).finish()),
      { character: den.ownerCharacterID },
    );
  } catch (error) {
    log.warn(`[MercenaryDen] Evolution notice failed den=${denID}: ${error.message}`);
  }
}

function msToFiletimeLong(ms) {
  return { type: "long", value: (BigInt(Math.trunc(ms)) * 10000n + 116444736000000000n).toString() };
}

// --- placement ---------------------------------------------------------------

function getSessionContext(session) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  return {
    characterID,
    corporationID: toInt(session && (session.corporationID || session.corpid), 0),
    shipID: toInt(session && session._space && session._space.shipID,
      toInt(session && (session.shipID || session.shipid), 0)),
    systemID: toInt(session && session._space && session._space.systemID,
      toInt(session && (session.solarsystemid2 || session.solarsystemid), 0)),
  };
}

function getSystemSecurity(systemID) {
  const system = require(path.join(__dirname, "../../space/worldData")).getSolarSystemByID(systemID);
  const security = toReal(system && (system.security ?? system.securityStatus), NaN);
  return Number.isFinite(security) ? security : null;
}

function isWormholeSystem(systemID) {
  return systemID >= 31_000_000 && systemID < 32_000_000;
}

function getPlanetTypeID(planetID) {
  const planet = require(path.join(__dirname, "../../space/worldData")).getCelestialByID(planetID);
  return toInt(planet && planet.typeID, 0);
}

function getPlanetWorkforce(planetID) {
  try {
    const { getSovereigntyStaticSnapshot } = require(path.join(__dirname, "../sovereignty/sovStaticData"));
    const definition = getSovereigntyStaticSnapshot().planetDefinitionsByPlanetID.get(toInt(planetID, 0));
    return Math.max(0, toInt(definition && definition.workforce, 0));
  } catch (error) {
    log.warn(`[MercenaryDen] Planet workforce lookup failed planet=${planetID}: ${error.message}`);
    return 0;
  }
}

function listSceneEntities(scene) {
  const entities = [];
  for (const map of [scene && scene.dynamicEntities, scene && scene.staticEntitiesByID]) {
    if (map instanceof Map) entities.push(...map.values());
  }
  if (Array.isArray(scene && scene.staticEntities)) entities.push(...scene.staticEntities);
  return entities;
}

// Skyhooks in the system with a position: the scene's ball when it has one,
// else the item's stored space state.
function listSystemSkyhooks(systemID, scene) {
  const planetOrbitalState = require(path.join(__dirname, "../planet/planetOrbitalState"));
  return planetOrbitalState.listOrbitalsForSystem(systemID)
    .filter((record) => toInt(record.typeID, 0) === TYPE_ORBITAL_SKYHOOK &&
      !planetOrbitalState.isOrbitalRecordDestroyed(record))
    .map((record) => {
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(record.itemID)
        : null;
      const item = findItemById(record.itemID);
      return {
        record,
        position: getPositionOf(entity) || getPositionOf(item),
        radius: getRadiusOf(entity || item || { typeID: TYPE_ORBITAL_SKYHOOK }),
      };
    })
    .filter((entry) => entry.position);
}

function isSkyhookOnline(record) {
  const planetOrbitalState = require(path.join(__dirname, "../planet/planetOrbitalState"));
  const { ORBITAL_STATE } = planetOrbitalState;
  return [ORBITAL_STATE.IDLE, ORBITAL_STATE.OPERATING].includes(toInt(record.state, -99)) &&
    !record.destroyedAtMs;
}

function registrationRefusal(reason, values) {
  return { success: false, errorMsg: reason, registrationInvalid: { message: reason, values } };
}

function deployRefusal(message, values) {
  return { success: false, errorMsg: message, userError: { message, values } };
}

// The deploy component's own rules (synchronous user errors on the launch,
// as for every deployable), then the den's registration rules (sent as
// OnMercenaryDenRegistrationInvalid). Returns the chosen skyhook and the den's
// position, or a refusal.
function resolveDenPlacement(session, item, context) {
  const typeID = toInt(item.typeID, 0);
  const runtime = getSpaceRuntime();
  const scene = typeof runtime.getSceneForSession === "function" ? runtime.getSceneForSession(session) : null;
  const shipEntity = runtime.getEntity(session, context.shipID);
  const shipPosition = getPositionOf(shipEntity);
  if (!shipPosition) return { success: false, errorMsg: "SHIP_NOT_IN_SPACE" };
  if (shipEntity.mode === "WARP") return { success: false, errorMsg: "SHIP_IN_WARP" };

  if (isWormholeSystem(context.systemID)) {
    return deployRefusal("NotAllowedToDeployInWormholeSpace", { deployTypeID: typeID });
  }
  const security = getSystemSecurity(context.systemID);
  if (security === null || security > MAX_SECURITY_LEVEL + 0.05 - 1e-9) {
    return deployRefusal("CantDeploySecurityLevelRestrictionTooHigh", {
      typeID,
      maxSecurityLevel: MAX_SECURITY_LEVEL,
    });
  }

  const shipRadius = getRadiusOf(shipEntity);
  const skyhooks = listSystemSkyhooks(context.systemID, scene)
    .map((entry) => ({
      ...entry,
      surfaceDistance: distanceBetween(entry.position, shipPosition) - entry.radius - shipRadius,
    }))
    .filter((entry) => entry.surfaceDistance <= SKYHOOK_MAX_DISTANCE_METERS)
    .sort((left, right) => left.surfaceDistance - right.surfaceDistance);
  const skyhook = skyhooks[0] || null;
  if (!skyhook) {
    return registrationRefusal(REGISTRATION_REASON.SKYHOOK_NOT_FOUND, {
      typeID,
      minDistance: SKYHOOK_MAX_DISTANCE_METERS,
    });
  }
  if (getPlanetTypeID(skyhook.record.planetID) !== TYPE_PLANET_TEMPERATE) {
    return registrationRefusal(REGISTRATION_REASON.PLANET_DOES_NOT_SUPPORT_DENS, { typeID });
  }
  if (!isSkyhookOnline(skyhook.record)) {
    return registrationRefusal(REGISTRATION_REASON.SKYHOOK_OFFLINE, { typeID });
  }
  if (denState.getMercenaryDenIDForSkyhook(skyhook.record.itemID)) {
    return registrationRefusal(REGISTRATION_REASON.SKYHOOK_ALREADY_OCCUPIED, { typeID });
  }
  const owned = denState.countOwnedMercenaryDens(context.characterID);
  const maximum = denState.getMercenaryDenMaximumForCharacter(context.characterID);
  if (owned >= maximum.currentMaximum) {
    if (owned >= maximum.absoluteMaximum) {
      return registrationRefusal(REGISTRATION_REASON.MAXIMUM_DENS_REACHED, { typeID });
    }
    return registrationRefusal(REGISTRATION_REASON.SKILL_LIMITS, {
      typeID,
      skillTypeID: MERCENARY_DEN_MANAGEMENT_SKILL_TYPE_ID,
      level: owned + 1,
    });
  }

  // The den goes out on the far side of the ship from the skyhook,
  // deployAtRange from the ship's surface, so the two balls do not overlap.
  const denRadius = getRadiusOf({ typeID });
  const away = {
    x: shipPosition.x - skyhook.position.x,
    y: shipPosition.y - skyhook.position.y,
    z: shipPosition.z - skyhook.position.z,
  };
  const awayLength = Math.hypot(away.x, away.y, away.z) || 1;
  const direction = { x: away.x / awayLength, y: away.y / awayLength, z: away.z / awayLength };
  const offset = shipRadius + DEPLOY_AT_RANGE_METERS + denRadius;
  const position = {
    x: shipPosition.x + direction.x * offset,
    y: shipPosition.y + direction.y * offset,
    z: shipPosition.z + direction.z * offset,
  };

  for (const entity of listSceneEntities(scene)) {
    if (!entity || toInt(entity.itemID, 0) === toInt(item.itemID, 0)) continue;
    const entityPosition = getPositionOf(entity);
    if (!entityPosition) continue;
    if (isMercenaryDenType(entity) &&
        distanceBetween(entityPosition, position) < MIN_DISTANCE_FROM_OWN_GROUP_METERS) {
      return deployRefusal("CantDeployNearGroup", {
        typeID,
        distance: MIN_DISTANCE_FROM_OWN_GROUP_METERS,
        groupName: "Mercenary Den",
      });
    }
    if (toInt(entity.categoryID, 0) === CATEGORY_STARBASE &&
        toInt(entity.groupID, 0) === GROUP_CONTROL_TOWER &&
        distanceBetween(entityPosition, position) < MIN_DISTANCE_FROM_CONTROL_TOWER_METERS) {
      return deployRefusal("CantDeployNearGroup", {
        typeID,
        distance: MIN_DISTANCE_FROM_CONTROL_TOWER_METERS,
        groupName: "Control Tower",
      });
    }
  }

  return {
    success: true,
    skyhook: skyhook.record,
    spawnState: {
      systemID: context.systemID,
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction,
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
    },
  };
}

function findLaunchedChange(changes, systemID, ownerID, typeID) {
  return (Array.isArray(changes) ? changes : []).find((change) => {
    const changed = change && change.item;
    return Boolean(changed && toInt(changed.locationID, 0) === systemID &&
      toInt(changed.flagID, -1) === 0 && toInt(changed.ownerID, 0) === ownerID &&
      toInt(changed.typeID, 0) === typeID);
  }) || null;
}

function syncChange(session, item, previousData) {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  if (typeof characterState.syncInventoryItemForSession === "function") {
    characterState.syncInventoryItemForSession(session, item, previousData || {}, { emitCfgLocation: true });
  }
}

// ship.Drop for a den. The den is the launching character's own
// (launchForOwnCorp 0); the skyhook may belong to anyone.
function launchMercenaryDenFromShip(session, itemID) {
  const context = getSessionContext(session);
  if (!context.characterID || !context.shipID || !context.systemID) {
    return { success: false, errorMsg: "INVALID_SESSION" };
  }
  const item = findItemById(itemID);
  if (!item || !isMercenaryDenType(item)) {
    return { success: false, errorMsg: "ITEM_NOT_MERCENARY_DEN" };
  }
  if (toInt(item.ownerID, 0) !== context.characterID ||
      toInt(item.locationID, 0) !== context.shipID ||
      !LAUNCH_SOURCE_FLAGS.has(toInt(item.flagID, 0))) {
    return { success: false, errorMsg: "ITEM_NOT_IN_SHIP_CARGO" };
  }

  const placement = resolveDenPlacement(session, item, context);
  if (!placement.success) {
    if (placement.registrationInvalid) {
      sendDenNotify(session, "OnMercenaryDenRegistrationInvalid",
        placement.registrationInvalid.message, placement.registrationInvalid.values);
    }
    log.info(
      `[MercenaryDen] Launch refused char=${context.characterID} item=${item.itemID} ` +
      `system=${context.systemID} reason=${placement.errorMsg}`,
    );
    return placement;
  }

  const typeID = toInt(item.typeID, 0);
  const transferResult = mobileItemCustody.deployFromShip({
    item,
    position: placement.spawnState.position,
    ownerID: context.characterID,
    shipID: context.shipID,
    systemID: context.systemID,
    actor: context.characterID,
  });
  if (!transferResult.success) return transferResult;
  const changes = transferResult.data && transferResult.data.changes || [];
  const launchedChange = findLaunchedChange(changes, context.systemID, context.characterID, typeID);
  const denID = toInt(launchedChange && launchedChange.item && launchedChange.item.itemID, 0);
  if (!denID) return { success: false, errorMsg: "LAUNCHED_ITEM_NOT_FOUND" };

  const nowMs = getNowMs();
  const skyhook = placement.skyhook;
  const space = {
    deployedAtMs: nowMs,
    activateAtMs: nowMs + ACTIVATION_MS,
    active: false,
    reinforcement: null,
    lastAttackNoticeAtMs: 0,
  };
  const registration = denState.registerMercenaryDen({
    mercenaryDenID: denID,
    ownerCharacterID: context.characterID,
    typeID,
    skyhookID: skyhook.itemID,
    planetID: skyhook.planetID,
    solarSystemID: context.systemID,
    skyhookOwnerCorporationID: toInt(skyhook.corporationID || skyhook.ownerID, 0),
    planetWorkforce: getPlanetWorkforce(skyhook.planetID),
    space,
    nowMs,
  });
  const updated = updateInventoryItem(denID, (currentItem) => ({
    ...currentItem,
    ownerID: context.characterID,
    locationID: context.systemID,
    flagID: 0,
    singleton: 1,
    createdAtMs: currentItem.createdAtMs || nowMs,
    spaceRadius: currentItem.spaceRadius || getRadiusOf({ typeID }) || null,
    dunRotation: currentItem.dunRotation || [0, 0, 0],
    spaceState: placement.spawnState,
  }));
  if (!updated.success || !updated.data) return updated;

  for (const change of changes) {
    if (change && change.item && toInt(change.item.itemID, 0) !== denID) {
      syncChange(session, change.item, change.previousData || change.previousState);
    }
  }
  syncChange(session, updated.data, launchedChange.previousData || updated.previousData);

  const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(context.systemID, denID);
  if (!spawnResult || !spawnResult.success) {
    log.warn(`[MercenaryDen] Launched den ${denID} but space spawn failed: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN"}`);
  }

  if (!registration.ok) {
    // Another launch took the skyhook or the last slot between the check and
    // the write. The den is in space but unregistered; the owner is told.
    sendDenNotify(session, "OnMercenaryDenRegistrationInvalid",
      REGISTRATION_REASON[registration.errorCode] || REGISTRATION_REASON.UNKNOWN, { typeID });
    log.warn(`[MercenaryDen] Den ${denID} launched but registration failed: ${registration.errorCode}`);
  } else {
    sendDenNotify(session, "OnMercenaryDenRegistrationSuccess", REGISTRATION_SUCCESS, {
      itemID: denID,
      typeID,
    });
  }
  scheduleDenTimers(denID);
  log.info(
    `[MercenaryDen] char=${context.characterID} launched den=${denID} type=${typeID} ` +
    `skyhook=${skyhook.itemID} planet=${skyhook.planetID} system=${context.systemID}`,
  );
  return {
    success: true,
    data: { itemID: denID, sourceItemID: item.itemID, state: getDenSpaceState(denID) },
  };
}

// --- timers ------------------------------------------------------------------

function clearDenTimers(denID) {
  const timers = timersByDenID.get(toInt(denID, 0));
  if (!timers) return;
  for (const timer of Object.values(timers)) {
    if (timer) clearTimeout(timer);
  }
  timersByDenID.delete(toInt(denID, 0));
}

function setUnrefTimeout(callback, delayMs) {
  const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, toInt(delayMs, 0)));
  const timer = setTimeout(callback, delay);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

function refreshPresentation(state, denID) {
  try {
    getSpaceRuntime().refreshInventoryBackedEntityPresentation(state.solarSystemID, denID);
  } catch (error) {
    log.warn(`[MercenaryDen] Presentation refresh failed den=${denID}: ${error.message}`);
  }
}

function activateDen(denID) {
  const item = findItemById(denID);
  const state = getDenSpaceState(item);
  if (!state || !item || toInt(item.locationID, 0) !== state.solarSystemID || toInt(item.flagID, 0) !== 0) {
    clearDenTimers(denID);
    return false;
  }
  const nowMs = getNowMs();
  if (!state.active) {
    const result = updateDenSpaceState(denID, (current) => ({ ...current, active: true }));
    if (!result.success) return false;
    denState.activateMercenaryDen(denID, nowMs);
    publishEvolutionState(denID, nowMs);
    refreshPresentation(state, denID);
    log.info(`[MercenaryDen] Activated den=${denID} system=${state.solarSystemID}`);
  }
  scheduleDenTimers(denID);
  return true;
}

function exitReinforcement(denID) {
  const item = findItemById(denID);
  const state = getDenSpaceState(item);
  if (!state || !state.reinforcement || state.reinforcement.stage !== "reinforced") return false;
  const nowMs = getNowMs();
  const result = updateDenSpaceState(denID, (current) => ({
    ...current,
    reinforcement: { ...current.reinforcement, stage: "vulnerable" },
  }));
  if (!result.success) return false;
  denState.setMercenaryDenEvolutionPaused(denID, false, nowMs);
  publishEvolutionState(denID, nowMs);
  refreshPresentation(state, denID);
  scheduleDenTimers(denID);
  log.info(`[MercenaryDen] Den=${denID} left reinforcement and can be destroyed`);
  return true;
}

function settleEvolution(denID) {
  const nowMs = getNowMs();
  denState.settleMercenaryDen(denID, nowMs);
  publishEvolutionState(denID, nowMs);
  scheduleDenTimers(denID);
}

function scheduleDenTimers(denOrID) {
  const denID = toInt(denOrID && denOrID.itemID ? denOrID.itemID : denOrID, 0);
  const item = denOrID && denOrID.itemID ? denOrID : findItemById(denID);
  const state = getDenSpaceState(item);
  clearDenTimers(denID);
  if (!state || !item || toInt(item.flagID, 0) !== 0) return false;
  const nowMs = getNowMs();
  const timers = {};
  if (!state.active) {
    timers.activation = setUnrefTimeout(() => activateDen(denID), state.activateAtMs - nowMs);
  }
  if (state.reinforcement && state.reinforcement.stage === "reinforced") {
    timers.reinforcement = setUnrefTimeout(() => exitReinforcement(denID),
      state.reinforcement.endsAtMs - nowMs);
  }
  const den = denState.getMercenaryDenByID(denID, nowMs);
  const nextStageMs = den ? denState.getNextEvolutionStageChangeMs(den, nowMs) : null;
  if (nextStageMs) {
    timers.evolution = setUnrefTimeout(() => settleEvolution(denID), nextStageMs - nowMs + 1000);
  }
  timersByDenID.set(denID, timers);
  return true;
}

function registerMercenaryDenItem(itemOrID) {
  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(itemOrID);
  if (!getDenSpaceState(item)) return false;
  return scheduleDenTimers(item);
}

// Called with the item snapshot when a den's ball is destroyed or removed:
// stop its timers, drop its registration, and tell the owner.
function clearMercenaryDen(itemOrID, reason = "cleared") {
  const denID = toInt(itemOrID && itemOrID.itemID ? itemOrID.itemID : itemOrID, 0);
  if (!denID) return false;
  clearDenTimers(denID);
  const item = itemOrID && itemOrID.itemID ? itemOrID : findItemById(denID);
  const state = getDenSpaceState(item);
  if (!state) return false;
  const removed = denState.unregisterMercenaryDen(denID, getNowMs());
  if (removed.ok) {
    sendDenNotify(findOwnerSession(state.ownerCharacterID), "OnMyMercenaryDenRemoved", null, { itemID: denID });
  }
  log.info(`[MercenaryDen] Cleared den=${denID} reason=${reason}`);
  return removed.ok === true;
}

// --- presentation ------------------------------------------------------------

function hydrateMercenaryDenEntityFromInventoryItem(entity, item) {
  if (!entity || !isMercenaryDenType(item)) return entity;
  const state = getDenSpaceState(item);
  if (!state) return entity;
  const nowMs = getNowMs();
  const active = state.active || (state.activateAtMs > 0 && state.activateAtMs <= nowMs);
  entity.component_activate = [active, active ? null : state.activateAtMs];
  entity.activate_comp_durationSeconds = Math.trunc(ACTIVATION_MS / 1000);
  const reinforced = isReinforcedState(state, nowMs);
  entity.component_reinforce = [reinforced, reinforced ? state.reinforcement.endsAtMs : null];
  entity.mercenaryDenOwnerCharacterID = state.ownerCharacterID;
  return entity;
}

// --- combat ------------------------------------------------------------------

function isMercenaryDenEntityInvulnerable(entity, nowMs = getNowMs()) {
  if (!entity || !isMercenaryDenType(entity)) return false;
  return isReinforcedState(getDenSpaceState(findItemById(entity.itemID)), nowMs);
}

function getAttackerIdentity(attackerEntity) {
  const session = attackerEntity && attackerEntity.session || null;
  return {
    characterID: toInt(attackerEntity && (attackerEntity.pilotCharacterID || attackerEntity.characterID) ||
      session && session.characterID, 0) || null,
    corporationID: toInt(attackerEntity && attackerEntity.corporationID ||
      session && session.corporationID, 0) || null,
    allianceID: toInt(attackerEntity && attackerEntity.allianceID ||
      session && session.allianceID, 0) || null,
  };
}

function getOwnerName(ownerID) {
  if (!ownerID) return null;
  try {
    const corporationState = require(path.join(__dirname, "../corporation/corporationState"));
    const corporation = corporationState.getCorporationRecord && corporationState.getCorporationRecord(ownerID);
    if (corporation) return String(corporation.corporationName || corporation.name || "") || null;
    const alliance = corporationState.getAllianceRecord && corporationState.getAllianceRecord(ownerID);
    if (alliance) return String(alliance.allianceName || alliance.name || "") || null;
  } catch (_) {
    // ignored: an unknown owner shows as Unknown
  }
  return null;
}

// formatters/mercenaryDen.py _GetCorporationName/_GetAllianceName build a
// showinfo link, or the name of ownerUnknown.
function buildOwnerLink(ownerID, showInfoTypeID) {
  const name = getOwnerName(ownerID);
  if (!ownerID || !name) return "Unknown";
  return `<a href="showinfo:${showInfoTypeID}//${ownerID}">${name}</a>`;
}

function buildBaseNotificationData(state, typeID) {
  const planetTypeID = getPlanetTypeID(state.planetID);
  return {
    itemID: state.denID,
    typeID,
    solarsystemID: state.solarSystemID,
    planetID: state.planetID,
    mercenaryDenShowInfoData: ["showinfo", typeID, state.denID],
    planetShowInfoData: ["showinfo", planetTypeID, state.planetID],
  };
}

function buildReinforcedNotification(state, typeID, attacker) {
  return {
    typeID: NOTIFICATION_MERCENARY_DEN_REINFORCED,
    data: {
      ...buildBaseNotificationData(state, typeID),
      timestampEntered: msToFiletimeLong(state.reinforcement.startedAtMs),
      timestampExited: msToFiletimeLong(state.reinforcement.endsAtMs),
      aggressorCharacterID: attacker.characterID || OWNER_UNKNOWN,
      aggressorCorporationName: buildOwnerLink(attacker.corporationID, 2),
      aggressorAllianceName: buildOwnerLink(attacker.allianceID, 16159),
    },
  };
}

function buildAttackedNotification(state, typeID, condition, attacker) {
  return {
    typeID: NOTIFICATION_MERC_DEN_ATTACKED,
    data: {
      ...buildBaseNotificationData(state, typeID),
      shieldPercentage: 100 * clamp01(condition.shieldCharge, 1),
      armorPercentage: 100 * (1 - clamp01(condition.armorDamage, 0)),
      hullPercentage: 100 * (1 - clamp01(condition.damage, 0)),
      aggressorCharacterID: attacker.characterID,
      aggressorCorporationName: buildOwnerLink(attacker.corporationID, 2),
      aggressorAllianceName: buildOwnerLink(attacker.allianceID, 16159),
    },
  };
}

function notifyOwner(state, notification) {
  try {
    const { createNotification } = require(path.join(__dirname, "../notifications/notificationState"));
    const { NOTIFICATION_GROUP } = require(path.join(__dirname, "../notifications/notificationConstants"));
    const result = createNotification(state.ownerCharacterID, {
      typeID: notification.typeID,
      senderID: OWNER_DEATHLESS_CUSTODIANS,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data: notification.data,
    });
    if (!result || result.success !== true) {
      log.warn(`[MercenaryDen] Notification ${notification.typeID} den=${state.denID} failed: ${result && result.errorMsg}`);
    }
  } catch (error) {
    log.warn(`[MercenaryDen] Notification ${notification.typeID} den=${state.denID} failed: ${error.message}`);
  }
}

function round6(value) {
  return Math.round(toReal(value, 0) * 1e6) / 1e6;
}

// Stops the shot at an empty shield: no armor or hull damage and no death.
function holdDamageAtEmptyShield(damageResult, nextConditionState) {
  const data = damageResult.data;
  const beforeLayers = data.beforeLayers || {};
  data.destroyed = false;
  data.afterConditionState = { ...nextConditionState };
  data.afterLayers = {
    shield: 0,
    armor: round6(beforeLayers.armor),
    structure: round6(beforeLayers.structure),
  };
  if (Array.isArray(data.perLayer)) {
    data.perLayer = data.perLayer.map((entry) => {
      if (!entry || entry.layer === "shield") {
        const beforeHP = round6(entry && entry.beforeHP);
        return { ...(entry || { layer: "shield" }), beforeHP, afterHP: 0, appliedEffective: beforeHP };
      }
      if (entry.layer === "armor" || entry.layer === "structure") {
        return { ...entry, afterHP: round6(beforeLayers[entry.layer]), appliedEffective: 0 };
      }
      return entry;
    });
  }
}

// The den's half of a hit, after the damage is worked out and before the
// damage path decides on death. A den whose shield runs out goes into
// reinforcement (one cycle: then it can be destroyed; a den repaired back to a
// full shield starts a fresh cycle, which no source states). Attack notices
// follow the reinforce component's emitAttack: at most one a minute while the
// shield is below 95%.
function applyMercenaryDenDamage(scene, entity, damageResult, options = {}) {
  if (!entity || !isMercenaryDenType(entity) || !damageResult || damageResult.success !== true ||
      !damageResult.data) {
    return { success: true, entered: false };
  }
  const item = findItemById(entity.itemID);
  let state = getDenSpaceState(item);
  if (!state) return { success: true, entered: false };
  const nowMs = toInt(options.nowMs, getNowMs());
  const attacker = getAttackerIdentity(options.attackerEntity);
  const before = damageResult.data.beforeConditionState || {};
  const after = damageResult.data.afterConditionState || {};
  const typeID = toInt(item.typeID, TYPE_MERCENARY_DEN);

  let cycleReset = false;
  if (state.reinforcement && state.reinforcement.stage === "vulnerable" &&
      clamp01(before.shieldCharge, 0) >= 0.999) {
    state = { ...state, reinforcement: null };
    cycleReset = true;
  }

  let entered = false;
  let condition = { ...after };
  if (!state.reinforcement && clamp01(after.shieldCharge, 1) <= 1e-6) {
    condition = {
      ...before,
      shieldCharge: 0,
    };
    holdDamageAtEmptyShield(damageResult, condition);
    // Patch notes: 24 hours, give or take up to 6 (jitterSeconds 21600).
    const jitterMs = Math.round((getRandom() * 2 - 1) * REINFORCE_JITTER_MS);
    state = {
      ...state,
      reinforcement: {
        stage: "reinforced",
        startedAtMs: nowMs,
        endsAtMs: nowMs + REINFORCE_DURATION_MS + jitterMs,
      },
    };
    entered = true;
  }

  const sendAttackNotice = clamp01(condition.shieldCharge, 1) < ATTACK_NOTICE_SHIELD_THRESHOLD &&
    nowMs - state.lastAttackNoticeAtMs >= ATTACK_NOTICE_INTERVAL_MS;
  if (sendAttackNotice) {
    state = { ...state, lastAttackNoticeAtMs: nowMs };
  }
  if (entered || sendAttackNotice || cycleReset) {
    const result = updateDenSpaceState(item.itemID, () => state, nowMs);
    if (!result.success) {
      return { success: false, entered: false, errorMsg: result.errorMsg || "WRITE_ERROR" };
    }
  }
  if (entered) {
    updateInventoryItem(item.itemID, (currentItem) => ({
      ...currentItem,
      conditionState: { ...(currentItem.conditionState || {}), ...condition },
    }));
  }
  if (sendAttackNotice) {
    notifyOwner(state, buildAttackedNotification(state, typeID, condition, attacker));
  }
  if (entered) {
    entity.conditionState = { ...(entity.conditionState || {}), ...condition };
    entity.component_reinforce = [true, state.reinforcement.endsAtMs];
    denState.setMercenaryDenEvolutionPaused(state.denID, true, nowMs);
    publishEvolutionState(state.denID, nowMs);
    notifyOwner(state, buildReinforcedNotification(state, typeID, attacker));
    if (scene && typeof scene.refreshInventoryBackedEntityPresentation === "function") {
      scene.refreshInventoryBackedEntityPresentation(item.itemID);
    } else {
      refreshPresentation(state, item.itemID);
    }
    scheduleDenTimers(item.itemID);
    log.info(`[MercenaryDen] Den=${item.itemID} reinforced until ${state.reinforcement.endsAtMs}`);
  }
  return {
    success: true,
    entered,
    data: entered ? { itemID: item.itemID, reinforcedUntilMs: state.reinforcement.endsAtMs } : null,
  };
}

// Combat destruction: remove the ball, leave a Mercenary Den Wreck (86175)
// and, half the time, the den's infomorphs in it.
function destroyMercenaryDenEntity(scene, entity, options = {}) {
  const item = findItemById(entity.itemID);
  const state = getDenSpaceState(item);
  const nowMs = toInt(options.destructionNowMs, getNowMs());
  const den = state ? denState.getMercenaryDenByID(state.denID, nowMs) : null;
  const position = getPositionOf(entity) || getPositionOf(item);
  const destroyResult = scene.destroyInventoryBackedDynamicEntity(entity.itemID, {
    terminalDestructionEffectID: options.terminalDestructionEffectID,
  });
  if (!destroyResult || destroyResult.success !== true) return destroyResult;
  // The ball's custody removal already ran clearMercenaryDen.
  if (!state) return destroyResult;

  const infomorphCount = den ? den.infomorphs.contents.count : 0;
  const dropped = infomorphCount > 0 && getRandom() < INFOMORPH_DROP_CHANCE ? infomorphCount : 0;
  let wreck = null;
  try {
    const structureWreckState = require(path.join(__dirname, "../structure/structureWreckState"));
    const created = structureWreckState.createStructureWreck({
      structureID: state.denID,
      typeID: toInt(item.typeID, TYPE_MERCENARY_DEN),
      ownerID: state.ownerCharacterID,
      solarSystemID: state.solarSystemID,
      position: position || { x: 0, y: 0, z: 0 },
    }, { nowMs });
    if (created.success && created.data) {
      wreck = created.data;
      if (dropped > 0 && den) {
        const { resolveItemByTypeID } = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
        const itemType = resolveItemByTypeID(den.infomorphs.definition.infomorphTypeID);
        const granted = itemType
          ? grantItemToOwnerLocation(state.ownerCharacterID, wreck.itemID, 0, itemType, dropped, { singleton: 0 })
          : { success: false, errorMsg: "TYPE_NOT_FOUND" };
        if (!granted || granted.success !== true) {
          log.warn(`[MercenaryDen] Den ${state.denID} infomorph drop failed: ${granted && granted.errorMsg}`);
        }
      }
      const spawned = getSpaceRuntime().spawnDynamicInventoryEntity(state.solarSystemID, wreck.itemID);
      if (!spawned || spawned.success !== true) {
        log.warn(`[MercenaryDen] Den ${state.denID} wreck ${wreck.itemID} did not spawn: ${spawned && spawned.errorMsg}`);
      }
    } else {
      log.warn(`[MercenaryDen] Den ${state.denID} wreck failed: ${created.errorMsg}`);
    }
  } catch (error) {
    log.warn(`[MercenaryDen] Den ${state.denID} wreck failed: ${error.message}`);
  }
  log.info(
    `[MercenaryDen] Den=${state.denID} destroyed infomorphs=${infomorphCount} dropped=${dropped} ` +
    `wreck=${wreck ? wreck.itemID : 0}`,
  );
  return {
    ...destroyResult,
    data: {
      ...(destroyResult.data || {}),
      wreck,
      infomorphsDropped: dropped,
      infomorphsHeld: infomorphCount,
    },
  };
}

// --- infomorph extraction ------------------------------------------------------

function getCargoUsedVolume(characterID, shipID) {
  return listContainerItems(characterID, shipID, ITEM_FLAGS.CARGO_HOLD).reduce((sum, entry) => {
    const units = toInt(entry.singleton, 0) === 1 ? 1 : Math.max(0, toReal(entry.stacksize ?? entry.quantity, 0));
    const volume = toReal(entry.volume, toReal(getItemMetadata(entry.typeID).volume, 0));
    return sum + volume * units;
  }, 0);
}

function getShipCargoCapacity(characterID, ship) {
  const { getShipFittingSnapshot } = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
  const snapshot = getShipFittingSnapshot(characterID, ship.itemID, { shipItem: ship, reason: "mercenaryDen.extract" });
  return Math.max(0, toReal(snapshot && snapshot.resourceState && snapshot.resourceState.cargoCapacity, 0));
}

// ballpark.CallComponentFromClient(denID, 'mercenaryDen',
// 'ExtractInfomorphsToShip', flagID, quantity). Every refusal is a user error,
// so the client shows its own dialog (repository.extract_infomorphs).
function extractInfomorphsToShip(session, denID, flagID, quantity) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  const numericDenID = toInt(denID, 0);
  const nowMs = getNowMs();
  const den = denState.getMercenaryDenByID(numericDenID, nowMs);
  if (!den || den.ownerCharacterID !== characterID) {
    throw refusal("MercenaryDenUnknown", "MERCENARY_DEN_ACCESS_DENIED");
  }
  if (toInt(flagID, 0) !== ITEM_FLAGS.CARGO_HOLD || !Number.isSafeInteger(Number(quantity))) {
    throw refusal("MercenaryDenExtractionInvalid", "INVALID_EXTRACTION");
  }
  if (toInt(quantity, 0) <= 0) {
    throw refusal("MercenaryDenNotEnoughUnits", "INVALID_QUANTITY");
  }
  const runtime = getSpaceRuntime();
  const shipID = toInt(session._space && session._space.shipID, 0);
  const ship = findItemById(shipID);
  const shipEntity = ship && runtime.getEntity(session, shipID);
  const denEntity = runtime.getEntity(session, numericDenID);
  const item = findItemById(numericDenID);
  const state = getDenSpaceState(item);
  const shipPosition = getPositionOf(shipEntity);
  const denPosition = getPositionOf(denEntity);
  if (!ship || toInt(ship.ownerID, 0) !== characterID || !state || !shipPosition || !denPosition) {
    throw refusal("ConfigureMercenaryDenTooFar", "OUT_OF_RANGE");
  }
  const distance = distanceBetween(shipPosition, denPosition) - getRadiusOf(shipEntity) - getRadiusOf(denEntity);
  if (distance > FITTING_RANGE_METERS) {
    throw refusal("ConfigureMercenaryDenTooFar", "OUT_OF_RANGE");
  }
  if (isReinforcedState(state, nowMs)) {
    throw refusal("MercenaryDenExtractionDenied_Reinforced", "REINFORCED");
  }
  const shield = clamp01(denEntity.conditionState && denEntity.conditionState.shieldCharge, 1);
  if (shield < EXTRACTION_MIN_SHIELD) {
    throw refusal("MercenaryDenExtractionWithoutShieldHp", "SHIELD_TOO_LOW", {
      minShieldHpPercent: EXTRACTION_MIN_SHIELD * 100,
      currentShieldHpPercent: shield * 100,
    });
  }
  const typeID = den.infomorphs.definition.infomorphTypeID;
  const unitVolume = toReal(getItemMetadata(typeID).volume, 0);
  const freeVolume = getShipCargoCapacity(characterID, ship) - getCargoUsedVolume(characterID, shipID);
  const fits = unitVolume > 0 ? Math.floor((freeVolume + 1e-9) / unitVolume) : 0;
  const wanted = Math.min(toInt(quantity, 0), fits);
  if (wanted <= 0) {
    throw refusal("MercenaryDenNoUnitsFitInShipCargo", "NO_CARGO_SPACE");
  }
  const taken = denState.takeMercenaryDenInfomorphs(numericDenID, characterID, wanted, nowMs);
  if (!taken.ok) {
    throw refusal("MercenaryDenExtractionFailed", taken.errorCode || "TAKE_FAILED");
  }
  if (taken.taken <= 0) {
    throw refusal("MercenaryDenNotEnoughUnits", "EMPTY");
  }
  const { resolveItemByTypeID } = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
  const itemType = resolveItemByTypeID(typeID);
  const granted = itemType
    ? grantItemToOwnerLocation(characterID, shipID, ITEM_FLAGS.CARGO_HOLD, itemType, taken.taken)
    : { success: false, errorMsg: "TYPE_NOT_FOUND" };
  if (!granted || granted.success !== true) {
    denState.returnMercenaryDenInfomorphs(numericDenID, taken.taken, nowMs);
    throw refusal("MercenaryDenExtractionFailed", granted && granted.errorMsg || "GRANT_FAILED");
  }
  for (const change of granted.data && granted.data.changes || []) {
    syncChange(session, change.item || findItemById(change.itemID), change.previousData || change.previousState);
  }
  log.info(`[MercenaryDen] char=${characterID} took ${taken.taken} infomorphs from den=${numericDenID}`);
  return taken.taken;
}

module.exports = {
  ACTIVATION_MS,
  ATTACK_NOTICE_INTERVAL_MS,
  EXTRACTION_MIN_SHIELD,
  FITTING_RANGE_METERS,
  GROUP_MERCENARY_DEN,
  NOTIFICATION_MERCENARY_DEN_REINFORCED,
  NOTIFICATION_MERC_DEN_ATTACKED,
  REGISTRATION_REASON,
  REINFORCE_DURATION_MS,
  REINFORCE_JITTER_MS,
  SKYHOOK_MAX_DISTANCE_METERS,
  applyMercenaryDenDamage,
  clearMercenaryDen,
  destroyMercenaryDenEntity,
  extractInfomorphsToShip,
  getDenSpaceState,
  hydrateMercenaryDenEntityFromInventoryItem,
  isMercenaryDenEntityInvulnerable,
  isMercenaryDenType,
  launchMercenaryDenFromShip,
  registerMercenaryDenItem,
  _testing: {
    activateDen,
    clearDenTimers,
    exitReinforcement,
    scheduleDenTimers,
    setNowOverride(fn) { nowOverride = fn; },
    setRandomOverride(fn) { randomOverride = fn; },
    reset() {
      nowOverride = null;
      randomOverride = null;
      for (const denID of [...timersByDenID.keys()]) clearDenTimers(denID);
    },
  },
};
