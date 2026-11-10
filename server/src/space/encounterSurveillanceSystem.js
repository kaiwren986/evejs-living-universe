"use strict";

const worldData = require("./worldData");
const { createRng } = require("../common/random");
const {
  isSovereigntyClaimableSolarSystem,
} = require("../services/sovereignty/sovSystemRules");
const {
  resolveItemByTypeID,
} = require("../services/inventory/itemTypeRegistry");
const { SCENE_KIND_SOLAR_SYSTEM } = require("./runtime/sceneIdentity");

const TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM = 55914;
const TYPE_ESS_ENTRY_BEACON = 10645;
const TYPE_ESS_ACCELERATION_GATE = 17831;
const TYPE_ESS_ENTRY_DECLOAK_CLOUD = 55934;
const TYPE_ESS_BANK_DECLOAK_CLOUD = 56704;
// Separate from authored props and empire scenery; never allocate runtime items.
const ESS_ITEM_ID_BASE = 8_440_000_000_000_000;
const ESS_BEACON_ID_BASE = 8_450_000_000_000_000;
const ESS_GATE_ID_BASE = 8_460_000_000_000_000;
const ESS_ENTRY_CLOUD_ID_BASE = 8_470_000_000_000_000;
const ESS_BANK_CLOUD_ID_BASE = 8_480_000_000_000_000;
const ESS_ALLOWED_GATE_SHIPS_LIST = 372;
// The pinned client establishes dungeon 8872's types and admission list. Its
// room coordinates are absent from that build's export. These layout values
// follow the supplemental client room layout and remain local placement policy.
const ESS_ENTRY_OFFSET_METERS = 314_580_300;
const ESS_BANK_WARP_IN_DISTANCE_METERS = 7_500;
// Match the existing dungeon owner's spatial approximation. The entry has its
// own lobby inside this region; arbitrary bank-pocket bookmarks cannot bypass
// the gate, including bookmarks beyond the combat field.
const ESS_DEADSPACE_RADIUS_METERS = 1_000_000_000;
const ESS_ENTRY_LOBBY_RADIUS_METERS = 1_000_000;
const ASTRONOMICAL_UNIT_METERS = 149_597_870_700;
const ESS_MIN_CLEARANCE_METERS = 3 * ASTRONOMICAL_UNIT_METERS;
const ESS_PLACEMENT_PADDING_METERS = 10 * ASTRONOMICAL_UNIT_METERS;
const POSITION_AXES = ["x", "y", "z"];
const sitesByScene = new WeakMap();

function buildSystemEssPosition(systemID) {
  // Only immutable map objects shape placement. Player-built structures must
  // never move an existing ESS when the system is reloaded.
  const anchors = [
    { position: { x: 0, y: 0, z: 0 }, radius: 0 },
    ...worldData.getCelestialsForSystem(systemID),
    ...worldData.getStargatesForSystem(systemID),
    ...worldData.getStationsForSystem(systemID),
    ...worldData.getAsteroidBeltsForSystem(systemID),
  ].filter((entity) => entity.position && POSITION_AXES.every(
    (axis) => Number.isFinite(Number(entity.position[axis])),
  )).map((entity) => ({
    position: Object.fromEntries(POSITION_AXES.map((axis) => [axis, Number(entity.position[axis])])),
    radius: Number.isFinite(Number(entity.radius)) ? Math.max(0, Number(entity.radius)) : 0,
  }));
  const bounds = Object.fromEntries(POSITION_AXES.map((axis) => [axis, {
    min: Math.min(...anchors.map((entity) => entity.position[axis] - entity.radius)),
    max: Math.max(...anchors.map((entity) => entity.position[axis] + entity.radius)),
  }]));
  // This is a local placement policy, not CCP's unpublished coordinate math.
  // A dedicated stream keeps the random location stable across scene reloads
  // and independent of unrelated gameplay random draws.
  const random = createRng(`ess-position-v1:${Number(systemID)}`);
  const samplePosition = () => Object.fromEntries(POSITION_AXES.map((axis) => [axis,
    bounds[axis].min - ESS_PLACEMENT_PADDING_METERS + random() * (
      bounds[axis].max - bounds[axis].min + 2 * ESS_PLACEMENT_PADDING_METERS
    ),
  ]));
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const position = samplePosition();
    if (anchors.every((entity) => Math.hypot(
      position.x - entity.position.x,
      position.y - entity.position.y,
      position.z - entity.position.z,
    ) >= ESS_MIN_CLEARANCE_METERS + entity.radius)) return position;
  }

  // A crowded map still gets a finite, bounded-time result. One coordinate
  // beyond every anchor's surface guarantees the same minimum clearance.
  const position = samplePosition();
  const axis = POSITION_AXES[Math.floor(random() * POSITION_AXES.length)];
  const clearance = ESS_MIN_CLEARANCE_METERS + ASTRONOMICAL_UNIT_METERS * (1 + random());
  position[axis] = random() < 0.5 ? bounds[axis].min - clearance : bounds[axis].max + clearance;
  return position;
}

function isPublicEssEntity(entity) {
  return Boolean(
    entity &&
    Number(entity.typeID) === TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM &&
    !entity.airNpeOwnerCharacterID &&
    !entity.airNpeInstanceID &&
    entity.staticVisibilityScope === "publicgrid"
  );
}

function isPublicSiteEntity(entity) {
  return Boolean(entity && !entity.airNpeOwnerCharacterID && !entity.airNpeInstanceID &&
    entity.staticVisibilityScope === "publicgrid");
}

function createSiteProp(systemID, itemID, typeID, position, properties = {}) {
  const metadata = resolveItemByTypeID(typeID);
  return {
    kind: "authoredSpaceProp",
    generatedSystemEss: true,
    itemID,
    solarSystemID: systemID,
    typeID,
    groupID: Number(metadata && metadata.groupID) || 0,
    categoryID: Number(metadata && metadata.categoryID) || 2,
    graphicID: Number(metadata && metadata.graphicID) || 0,
    itemName: metadata && metadata.name || "Encounter Surveillance System",
    ownerID: 1,
    radius: Number(metadata && metadata.radius) || 1,
    position: { ...position },
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    staticVisibilityScope: "publicgrid",
    isGlobal: false,
    destinyBallMode: "RIGID",
    ...properties,
  };
}

function buildSystemEssEntity(system) {
  if (!isSovereigntyClaimableSolarSystem(system)) return null;

  const systemID = Number(system.solarSystemID);
  const metadata = resolveItemByTypeID(TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM);
  return {
    kind: "authoredSpaceProp",
    generatedSystemEss: true,
    essSiteRole: "bank",
    itemID: ESS_ITEM_ID_BASE + systemID,
    solarSystemID: systemID,
    typeID: TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM,
    groupID: Number(metadata && metadata.groupID) || 4079,
    categoryID: Number(metadata && metadata.categoryID) || 2,
    graphicID: Number(metadata && metadata.graphicID) || 0,
    itemName: "Encounter Surveillance System",
    ownerID: 1,
    radius: Number(metadata && metadata.radius) || 1,
    position: buildSystemEssPosition(systemID),
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    staticVisibilityScope: "publicgrid",
    isGlobal: false,
    destinyBallMode: "RIGID",
  };
}

function resolveSiteEntity(scene, itemID, typeID) {
  const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(itemID) : null;
  return isPublicSiteEntity(entity) && Number(entity.typeID) === typeID ? entity : null;
}

function ensureCompanion(scene, entity) {
  const existing = scene.getEntityByID(entity.itemID);
  if (existing) {
    // A replacement authored bank may reuse the system's generated companions.
    // Never replace an unrelated authored object in the reserved ID range.
    if (!existing.generatedSystemEss || existing.essSiteRole !== entity.essSiteRole) return null;
    if (Number(existing.essBankID) === Number(entity.essBankID) &&
      POSITION_AXES.every(axis => existing.position[axis] === entity.position[axis])) return existing;
    scene.removeStaticEntity(existing.itemID, { broadcast: false });
  }
  return scene.addStaticEntity(entity) ? entity : null;
}

function ensureEssSiteCompanions(scene, bank) {
  sitesByScene.delete(scene);
  const systemID = Number(scene.systemID);
  const bankID = Number(bank.itemID);
  const entryPosition = { ...bank.position, z: bank.position.z - ESS_ENTRY_OFFSET_METERS };
  let beacon = resolveSiteEntity(scene, bank.essEntryBeaconID || bank.beaconID, TYPE_ESS_ENTRY_BEACON);
  if (beacon?.essBankID && Number(beacon.essBankID) !== bankID) beacon = null;
  if (!beacon) beacon = ensureCompanion(scene, createSiteProp(
    systemID, ESS_BEACON_ID_BASE + systemID, TYPE_ESS_ENTRY_BEACON, entryPosition,
    { essSiteRole: "beacon", essBankID: bankID, itemName: "Encounter Surveillance System", isGlobal: true },
  ));
  if (!beacon) return null;
  let gate = resolveSiteEntity(scene, bank.essAccelerationGateID, TYPE_ESS_ACCELERATION_GATE);
  if (gate?.essBankID && Number(gate.essBankID) !== bankID) gate = null;
  if (!gate) gate = ensureCompanion(scene, createSiteProp(
    systemID, ESS_GATE_ID_BASE + systemID, TYPE_ESS_ACCELERATION_GATE, beacon.position,
    { essSiteRole: "gate", essBankID: bankID, essBeaconID: beacon.itemID,
      essAllowedShipsList: ESS_ALLOWED_GATE_SHIPS_LIST, itemName: "ESS Acceleration Gate" },
  ));
  if (!gate) return null;
  scene.rememberBallGlobalStatus?.(beacon);
  beacon.isGlobal = true;
  beacon.essSiteRole = "beacon";
  beacon.essBankID = bankID;
  scene.refreshBallGlobalStatus?.(beacon.itemID);
  scene.rememberBallGlobalStatus?.(gate);
  gate.isGlobal = false;
  gate.essSiteRole = "gate";
  gate.essBankID = bankID;
  gate.essBeaconID = beacon.itemID;
  gate.essAllowedShipsList = ESS_ALLOWED_GATE_SHIPS_LIST;
  scene.refreshBallGlobalStatus?.(gate.itemID);
  scene.rememberBallGlobalStatus?.(bank);
  bank.isGlobal = false;
  bank.essSiteRole = "bank";
  bank.essEntryBeaconID = beacon.itemID;
  bank.essAccelerationGateID = gate.itemID;
  bank.essDeadspaceRadiusMeters = ESS_DEADSPACE_RADIUS_METERS;
  bank.essEntryLobbyRadiusMeters = ESS_ENTRY_LOBBY_RADIUS_METERS;
  bank.essWarpInPosition = { ...bank.position, z: bank.position.z - ESS_BANK_WARP_IN_DISTANCE_METERS };
  require("../services/dynamic/essFieldRuntime").ensureFieldVisual(bank);
  scene.refreshBallGlobalStatus?.(bank.itemID);
  for (const [role, idBase, typeID, position, radius] of [
    ["entryDecloakCloud", ESS_ENTRY_CLOUD_ID_BASE, TYPE_ESS_ENTRY_DECLOAK_CLOUD, beacon.position, 102_706],
    ["bankDecloakCloud", ESS_BANK_CLOUD_ID_BASE, TYPE_ESS_BANK_DECLOAK_CLOUD, bank.position, 500_000],
  ]) {
    ensureCompanion(scene, createSiteProp(systemID, idBase + systemID, typeID, position, {
      essSiteRole: role, essBankID: bankID, radius, destinyBallFlags: 0,
    }));
  }
  return bank;
}

function ensureSystemEssEntity(scene) {
  if (
    !scene ||
    scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM ||
    scene.hydrateStaticEntities === false ||
    !isSovereigntyClaimableSolarSystem(scene.system || scene.systemID)
  ) return null;

  let bank = (scene.staticEntities || []).find(isPublicEssEntity);
  if (!bank) {
    const entity = buildSystemEssEntity(scene.system || worldData.getSolarSystemByID(scene.systemID));
    if (!entity || !scene.addStaticEntity(entity)) return null;
    bank = entity;
  }
  return ensureEssSiteCompanions(scene, bank);
}

function listSystemEssSites(scene) {
  if (!scene || scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM) return [];
  const cached = sitesByScene.get(scene);
  if (cached && cached.staticCount === scene.staticEntities.length && cached.sites.every(({ bank, beacon, gate }) =>
    scene.getEntityByID(bank.itemID) === bank && isPublicEssEntity(bank) &&
    resolveSiteEntity(scene, bank.essEntryBeaconID, TYPE_ESS_ENTRY_BEACON) === beacon &&
    resolveSiteEntity(scene, bank.essAccelerationGateID, TYPE_ESS_ACCELERATION_GATE) === gate &&
    Number(gate.essBankID) === Number(bank.itemID))) return cached.sites;
  const sites = [];
  for (const bank of scene.staticEntities || []) {
    if (!isPublicEssEntity(bank)) continue;
    const beacon = resolveSiteEntity(scene, bank.essEntryBeaconID, TYPE_ESS_ENTRY_BEACON);
    const gate = resolveSiteEntity(scene, bank.essAccelerationGateID, TYPE_ESS_ACCELERATION_GATE);
    if (!beacon || !gate || Number(gate.essBankID) !== Number(bank.itemID)) continue;
    sites.push({ bank, beacon, gate, warpInPosition: bank.essWarpInPosition });
  }
  sitesByScene.set(scene, { staticCount: scene.staticEntities.length, sites });
  return sites;
}

module.exports = {
  ESS_ITEM_ID_BASE,
  ESS_BEACON_ID_BASE,
  ESS_GATE_ID_BASE,
  ESS_ALLOWED_GATE_SHIPS_LIST,
  ESS_ENTRY_OFFSET_METERS,
  ESS_DEADSPACE_RADIUS_METERS,
  ESS_ENTRY_LOBBY_RADIUS_METERS,
  ESS_MIN_CLEARANCE_METERS,
  TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM,
  TYPE_ESS_ENTRY_BEACON,
  TYPE_ESS_ACCELERATION_GATE,
  buildSystemEssPosition,
  buildSystemEssEntity,
  ensureSystemEssEntity,
  isPublicEssEntity,
  listSystemEssSites,
};
