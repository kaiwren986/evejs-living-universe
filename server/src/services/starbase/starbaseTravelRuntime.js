"use strict";

// Category 23 endpoints are inventory-backed, not fabricated Upwell records.
// The adapters below feed the existing cyno / bridge travel authorities.
const inventory = require("../inventory/itemStore");
const policy = require("./starbaseAnchoringPolicy");
const access = require("./starbaseAccessRuntime");
const world = require("../../space/worldData");
const { STRUCTURE_SERVICE_ID, STRUCTURE_SERVICE_STATE } = require("../structure/structureConstants");
const TYPE_GENERATOR = 27673;
const TYPE_JAMMER = 27674;
const TYPE_BRIDGE = 27897;
const INFRASTRUCTURE_TYPES = new Set([TYPE_GENERATOR, TYPE_JAMMER, TYPE_BRIDGE]);
const CAPITAL_GROUPS = new Set([30, 485, 547, 659, 883, 902, 1538]);
const LY_METERS = 9460730472580800;
const n = (v) => Number(v) || 0;
const failure = (errorMsg) => ({ success: false, errorMsg });

function isInfrastructure(item) {
  return Boolean(item && n(item.categoryID) === 23 && INFRASTRUCTURE_TYPES.has(n(item.typeID)));
}

function persisted(itemOrID) {
  return inventory.findItemById(n(typeof itemOrID === "object" ? itemOrID?.itemID || itemOrID?.structureID : itemOrID));
}

function anchored(item) {
  const state = item?.spaceState;
  return Boolean(state && n(item.flagID) === 0 && n(item.locationID) === n(state.systemID) &&
    state.anchorState === "anchored" && state.isFree !== true &&
    !require("./starbaseDefenseRuntime").hasUnavailableHealth(item));
}

function getTower(item) {
  const tower = inventory.findItemById(n(item?.spaceState?.controlTowerID));
  return tower && n(tower.groupID) === 365 && n(tower.categoryID) === 23 &&
    n(tower.ownerID) === n(item.ownerID) && n(tower.locationID) === n(item.locationID) ? tower : null;
}

function validateInfrastructure(item, tower = getTower(item)) {
  if (!isInfrastructure(item)) return null;
  if (!tower || !anchored(tower)) return "STARBASE_INVENTORY_TOWER_UNAVAILABLE";
  const restrictions = policy.validateSystemRestrictions(item);
  return restrictions.success ? null : restrictions.errorMsg;
}

function isOperational(itemOrID) {
  const item = persisted(itemOrID);
  if (!isInfrastructure(item) || !anchored(item) || item.spaceState.onlineState !== "online" || n(item.spaceState.online) !== 1) return false;
  const tower = getTower(item);
  // A PG-only jammer remains operational while its tower is reinforced. CPU
  // structures are forcibly offlined by the shared reinforcement controller.
  return !validateInfrastructure(item, tower) && tower.spaceState.onlineState === "online" && n(tower.spaceState.online) === 1;
}

function getEndpoint(itemOrID) {
  const item = persisted(itemOrID);
  if (!isInfrastructure(item) || !anchored(item)) return null;
  const tower = getTower(item);
  const serviceID = n(item.typeID) === TYPE_BRIDGE ? STRUCTURE_SERVICE_ID.JUMP_BRIDGE : STRUCTURE_SERVICE_ID.CYNO_BEACON;
  return {
    legacyStarbase: true, structureID: item.itemID, itemID: item.itemID, typeID: item.typeID,
    ownerCorpID: item.ownerID, ownerID: item.ownerID, solarSystemID: item.locationID,
    allianceID: tower ? access.getTowerAllianceID(tower) : 0,
    itemName: item.itemName, name: item.itemName, position: item.spaceState.position,
    radius: n(item.radius) || n(world.getMovementAttributesForType(item.typeID)?.radius),
    serviceStates: { [serviceID]: isOperational(item) ? STRUCTURE_SERVICE_STATE.ONLINE : STRUCTURE_SERVICE_STATE.OFFLINE },
    state: 0, item,
  };
}

function hasTravelAccess(session, endpointOrID) {
  const item = persisted(endpointOrID);
  const tower = item && getTower(item);
  return Boolean(tower && access.hasStarbasePermission(session, tower, item.itemID, "use"));
}

function listBeacons(session = null, options = {}) {
  return inventory.listStarbaseItems({ typeID: TYPE_GENERATOR }).filter(isOperational)
    .map(getEndpoint).filter((endpoint) => endpoint && (options.publicSystemsOnly === true || hasTravelAccess(session, endpoint)));
}

function getJammerActivationTimeMs(systemID, options = {}) {
  const numericSystemID = n(systemID);
  if (numericSystemID <= 0) return null;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  return inventory.listStarbaseItems({ systemID: numericSystemID, typeID: TYPE_JAMMER })
    .some((item) => (!Number.isFinite(Number(item.expiresAtMs)) || Number(item.expiresAtMs) > nowMs) &&
      isOperational(item)) ? 0 : null;
}

function distanceLy(source, destination) {
  const left = world.getSolarSystemByID(n(source.solarSystemID || source.locationID))?.position;
  const right = world.getSolarSystemByID(n(destination.solarSystemID || destination.locationID))?.position;
  if (!left || !right || ![left.x, left.y, left.z, right.x, right.y, right.z].every(Number.isFinite)) return null;
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) / LY_METERS;
}

function getBridgeLink(item) {
  const link = item?.spaceState?.starbaseModuleState?.jumpBridge;
  return link && n(link.version) === 1 ? link : null;
}

function getLinkedBridge(endpointOrID) {
  const source = persisted(endpointOrID);
  if (!source || n(source.typeID) !== TYPE_BRIDGE || !anchored(source)) return null;
  const link = getBridgeLink(source);
  const destination = link && persisted(link.destinationID);
  const reverse = getBridgeLink(destination);
  if (!destination || n(destination.typeID) !== TYPE_BRIDGE || !anchored(destination) ||
      n(reverse?.destinationID) !== n(source.itemID) || !link.linkID || link.linkID !== reverse.linkID ||
      n(source.ownerID) !== n(destination.ownerID)) return null;
  const ly = distanceLy(source, destination);
  const maximum = Math.min(policy.getDogmaAttribute(source.typeID, 867, 0), policy.getDogmaAttribute(destination.typeID, 867, 0));
  return ly !== null && ly > 0 && ly <= maximum + 1e-7 ? getEndpoint(destination) : null;
}

// Server-facing configuration operation. Latest has no legacy POS pairing UI;
// do not invent a posMgr RPC or pretend the Upwell-only menu exposes this.
function linkBridges(session, sourceID, destinationID) {
  const source = persisted(sourceID);
  const destination = persisted(destinationID);
  if (!source || !destination || source.itemID === destination.itemID ||
      n(source.typeID) !== TYPE_BRIDGE || n(destination.typeID) !== TYPE_BRIDGE ||
      !anchored(source) || !anchored(destination)) return failure("POS_BRIDGE_ENDPOINT_UNAVAILABLE");
  if (n(source.ownerID) !== n(destination.ownerID)) return failure("STARBASE_CORPORATION_OWNER_REQUIRED");
  for (const item of [source, destination]) {
    const error = validateInfrastructure(item);
    if (error) return failure(error);
    const authority = policy.validateCorporationAuthority(session, item.ownerID);
    if (!authority.success) return authority;
    if (item.spaceState.onlineState !== "offline") return failure("POS_BRIDGE_OFFLINE_REQUIRED");
    if (getBridgeLink(item)?.destinationID) return failure("POS_BRIDGE_ALREADY_LINKED");
  }
  const ly = distanceLy(source, destination);
  if (ly === null || ly <= 0 || ly > Math.min(policy.getDogmaAttribute(source.typeID, 867, 0),
    policy.getDogmaAttribute(destination.typeID, 867, 0)) + 1e-7) return failure("POS_BRIDGE_RANGE");
  const linkID = require("node:crypto").randomUUID();
  return inventory.updateInventoryItemsAtomic([source.itemID, destination.itemID], (item) => ({ ...item,
    spaceState: { ...item.spaceState, starbaseModuleState: { ...item.spaceState.starbaseModuleState,
      jumpBridge: { version: 1, linkID, destinationID: item.itemID === source.itemID ? destination.itemID : source.itemID } } } }));
}

function unlinkBridge(session, sourceID) {
  const source = persisted(sourceID);
  if (!source || n(source.typeID) !== TYPE_BRIDGE) return failure("POS_BRIDGE_ENDPOINT_UNAVAILABLE");
  const authority = policy.validateCorporationAuthority(session, source.ownerID);
  if (!authority.success) return authority;
  const destination = persisted(getBridgeLink(source)?.destinationID);
  const items = [source];
  if (destination && getBridgeLink(destination)?.linkID === getBridgeLink(source)?.linkID &&
      n(destination.ownerID) === n(source.ownerID)) items.push(destination);
  if (items.some((item) => item.spaceState?.onlineState !== "offline")) return failure("POS_BRIDGE_OFFLINE_REQUIRED");
  return inventory.updateInventoryItemsAtomic(items.map((item) => item.itemID), (item) => ({ ...item,
    spaceState: { ...item.spaceState, starbaseModuleState: { ...item.spaceState.starbaseModuleState, jumpBridge: null } } }));
}

function validateBridgePassenger(session, source, destination, ship, mass) {
  if (!isOperational(source) || !isOperational(destination) || !hasTravelAccess(session, source) || !hasTravelAccess(session, destination)) return "POS_BRIDGE_ACCESS_OR_ENDPOINT_UNAVAILABLE";
  if (!ship || n(ship.categoryID) !== 6 || CAPITAL_GROUPS.has(n(ship.groupID)) || !Number.isFinite(mass) || mass <= 0) return "POS_BRIDGE_SHIP_INELIGIBLE";
  if (require("../_shared/jumpTimerRuntime").hasActiveJumpActivation(n(session?.characterID))) return "POS_BRIDGE_JUMP_ACTIVATION";
  return null;
}

function calculateBridgeFuel(source, shipMass, ly) {
  return Math.max(1, Math.ceil(shipMass * ly * policy.getDogmaAttribute(source.typeID, 868, 0) *
    policy.getDogmaAttribute(source.typeID, 1001, 0)));
}

function notifyInfrastructureChanged(item) {
  const systemID = n(item?.spaceState?.systemID || item?.locationID);
  if (!systemID || (!isInfrastructure(item) && n(item?.groupID) !== 365)) return;
  try {
    const suppression = require("../sovereignty/sovSuppressionState");
    require("../sovereignty/sovNotifications").broadcastCynoJammerChanged(systemID, suppression.getCynoJammerOnlineSimTime(systemID));
  } catch (error) {
    require("../../utils/logger").warn(`[StarbaseTravel] presentation retry on next update: ${error.message}`);
  }
  // Current beacon directory memoization expires after one second. No invented
  // legacy notification is required to make offline / destroyed rows disappear.
}

// Teardown waits for shared escrow compensation/commit. A root marked for
// destruction has already offlined itself and its dependents, so no pending
// pre-transition request can start a new jump here.
function prepareDestruction(itemID) {
  const service = require("../structure/structureJumpBridgeMgrService");
  const pending = service.listPendingJumpBridgeSettlements().filter((entry) =>
    entry.sourceStructureID === n(itemID) || entry.destinationStructureID === n(itemID));
  for (const entry of pending) void service.settlePendingJumpBridge(entry.operationID).catch(() => {});
  return pending.length === 0;
}

module.exports = { TYPE_GENERATOR, TYPE_JAMMER, TYPE_BRIDGE, isInfrastructure, isOperational, getEndpoint,
  getTower, validateInfrastructure, hasTravelAccess, listBeacons, getJammerActivationTimeMs,
  getLinkedBridge, linkBridges, unlinkBridge, validateBridgePassenger, calculateBridgeFuel,
  notifyInfrastructureChanged, prepareDestruction };
