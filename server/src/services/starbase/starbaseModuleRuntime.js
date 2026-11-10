"use strict";

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  findItemById,
  listSystemSpaceItems,
  updateInventoryItem: persistInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const { TABLE, readStaticTable } = require(path.join(
  __dirname,
  "../_shared/referenceData",
));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const resourceRuntime = require("./starbaseResourceRuntime");
const anchoringPolicy = require("./starbaseAnchoringPolicy");

const TYPE_ANCHORING = 11584;
const EFFECT_ONLINE_FOR_STRUCTURES = 901;
const EFFECT_ANCHOR_DROP_FOR_STRUCTURES = 1022;
const EFFECT_ANCHOR_LIFT_FOR_STRUCTURES = 1023;
const ATTRIBUTE_ANCHORING_DELAY = 556;
const ATTRIBUTE_UNANCHORING_DELAY = 676;
const ATTRIBUTE_ONLINING_DELAY = 677;
const MAX_ASSOCIATION_DISTANCE_METERS =
  anchoringPolicy.DEFAULT_MAX_STRUCTURE_DISTANCE_METERS;
const MAX_LOCAL_OPERATION_DISTANCE_METERS = 2500;
const MAX_TIMER_DELAY_MS = 2147000000;
const timers = new Map();

// State transitions must reconcile manufacturing even when presentation is
// disabled (startup, fuel recovery, tests). This is not an inventory engine.
function updateInventoryItem(itemID, transform) {
  const result = persistInventoryItem(itemID, transform);
  if (result.success) require("./starbaseTravelRuntime").notifyInfrastructureChanged(result.data);
  const industry = require("../industry/starbaseIndustryRuntime");
  if (result.success && industry.isAssemblyArray(result.data)) {
    const jobs = industry.reconcileAssemblyJobs(itemID);
    if (!jobs.success) return { ...result, success: false, errorMsg: jobs.errorMsg };
  }
  if (result.success && require("./starbaseProductionRuntime").isProductionStructure(result.data)) {
    require("./starbaseProductionCycles").invalidateProductionForItem(result.data);
  }
  return result;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function dogma(typeID, attributeID, fallback = 0) {
  const table = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const row = table.typesByTypeID && table.typesByTypeID[String(toInt(typeID, 0))];
  const value = Number(row && row.attributes && row.attributes[String(attributeID)]);
  return Number.isFinite(value) ? value : fallback;
}

function vectorDistance(left, right) {
  return anchoringPolicy.vectorDistance(left, right);
}

function normalizePosition(value) {
  const source = Array.isArray(value)
    ? { x: value[0], y: value[1], z: value[2] }
    : value;
  if (
    !source ||
    ![source.x, source.y, source.z].every((coordinate) => (
      Number.isFinite(Number(coordinate))
    ))
  ) {
    return null;
  }
  return {
    x: Number(source.x),
    y: Number(source.y),
    z: Number(source.z),
  };
}

function getState(item) {
  const state = item && item.spaceState || {};
  const condition = item && item.conditionState || {};
  const resourceProfile = resourceRuntime.getStarbaseResourceProfile(item) || {};
  const anchorState = String(state.anchorState || "unanchored").toLowerCase();
  const onlineState = String(state.onlineState || "offline").toLowerCase();
  return {
    itemID: toInt(item && item.itemID, 0),
    typeID: toInt(item && item.typeID, 0),
    groupID: toInt(item && item.groupID, 0),
    categoryID: toInt(item && item.categoryID, 0),
    corporationID: toInt(state.corporationID, toInt(item && item.ownerID, 0)),
    solarSystemID: toInt(state.systemID, toInt(item && item.locationID, 0)),
    position: state.position && typeof state.position === "object"
      ? {
          x: Number(state.position.x) || 0,
          y: Number(state.position.y) || 0,
          z: Number(state.position.z) || 0,
        }
      : null,
    anchorState,
    isAnchored: anchorState !== "unanchored",
    anchorStartedAtMs: toInt(state.anchorStartedAtMs, 0) || null,
    anchorCompletesAtMs: toInt(state.anchorCompletesAtMs, 0) || null,
    onlineState,
    isOnline: onlineState === "online",
    onlineStartedAtMs: toInt(state.onlineStartedAtMs, 0) || null,
    onlineCompletesAtMs: toInt(state.onlineCompletesAtMs, 0) || null,
    controlTowerID: resourceRuntime.getModuleControlTowerID(item),
    towerID: resourceRuntime.getModuleControlTowerID(item),
    health: {
      damage: Math.max(0, Number(condition.damage) || 0),
      armorDamage: Math.max(0, Number(condition.armorDamage) || 0),
      shieldCharge: Math.max(0, Math.min(1, Number(
        condition.shieldCharge === undefined ? 1 : condition.shieldCharge,
      ) || 0)),
      incapacitated: condition.incapacitated === true || state.incapacitated === 1,
    },
    cpuUsage: Math.max(0, Number(resourceProfile.cpuUsage) || 0),
    powergridUsage: Math.max(0, Number(resourceProfile.powergridUsage) || 0),
    moduleSpecificState:
      state.starbaseModuleState && typeof state.starbaseModuleState === "object"
        ? { ...state.starbaseModuleState }
        : {},
  };
}

function sessionContext(session) {
  return {
    characterID: toInt(session && (session.characterID || session.charid), 0),
    corporationID: toInt(session && (session.corporationID || session.corpid), 0),
    systemID: toInt(
      session && session._space && session._space.systemID,
      toInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
    ),
    shipID: toInt(
      session && session._space && session._space.shipID,
      toInt(session && (session.shipID || session.shipid), 0),
    ),
  };
}

function hasAnchoringSkill(characterID) {
  const map = getCachedCharacterSkillMap(characterID);
  const row = map instanceof Map ? map.get(TYPE_ANCHORING) : null;
  return toInt(
    row && (row.effectiveSkillLevel ?? row.trainedSkillLevel ?? row.skillLevel ?? row.level),
    0,
  ) >= 1;
}

function isEligibleAssociationTower(item, tower) {
  if (!resourceRuntime.isStarbaseModule(item) || !resourceRuntime.isControlTower(tower)) return false;
  if (require("./starbaseDefenseRuntime").hasUnavailableHealth(tower)) return false;
  const itemState = item.spaceState || {};
  const towerState = tower.spaceState || {};
  const itemSystemID = toInt(itemState.systemID, toInt(item.locationID, 0));
  const towerSystemID = toInt(towerState.systemID, toInt(tower.locationID, 0));
  return itemSystemID > 0 && towerSystemID === itemSystemID &&
    toInt(tower.ownerID, 0) === toInt(item.ownerID, 0) &&
    String(towerState.anchorState || "").toLowerCase() === "anchored" &&
    vectorDistance(itemState.position, towerState.position) <=
      anchoringPolicy.getTowerMaximumStructureDistance(tower);
}

function findAssociationTower(item) {
  if (!resourceRuntime.isStarbaseModule(item) || !item.spaceState) return null;
  const storedID = resourceRuntime.getModuleControlTowerID(item);
  const stored = storedID > 0 ? findItemById(storedID) : null;
  if (isEligibleAssociationTower(item, stored)) return stored;
  const systemID = toInt(item.spaceState.systemID, toInt(item.locationID, 0));
  return listSystemSpaceItems(systemID)
    .filter((tower) => isEligibleAssociationTower(item, tower))
    .map((tower) => ({
      tower,
      distance: vectorDistance(item.spaceState.position, tower.spaceState.position),
    }))
    .sort((a, b) => a.distance - b.distance || a.tower.itemID - b.tower.itemID)[0]?.tower || null;
}

function validatePlacement(item, tower) {
  return anchoringPolicy.validateModulePlacement(item, tower);
}

function getEntitySurfaceDistance(scene, left, right) {
  return scene && typeof scene.getEntitySurfaceDistance === "function"
    ? scene.getEntitySurfaceDistance(left, right)
    : Math.max(
        0,
        vectorDistance(left && left.position, right && right.position) -
          Math.max(0, Number(left && left.radius) || 0) -
          Math.max(0, Number(right && right.radius) || 0),
      );
}

function isShipInsideTowerForceField(ship, tower) {
  if (!ship || !resourceRuntime.isControlTower(tower)) return false;
  const towerState = tower.spaceState || {};
  if (String(towerState.onlineState || "").toLowerCase() !== "online") {
    return false;
  }
  const shieldRadius = Math.max(
    0,
    Number(anchoringPolicy.getDogmaAttribute(
      tower.typeID,
      anchoringPolicy.ATTRIBUTE_SHIELD_RADIUS,
      0,
    )) || 0,
  );
  return shieldRadius > 0 &&
    vectorDistance(ship.position, towerState.position) <= shieldRadius;
}

function validateAccess(session, item, operation = "anchor") {
  if (require("./starbaseDefenseRuntime").hasUnavailableHealth(item)) return "MODULE_INCAPACITATED";
  const context = sessionContext(session);
  if (!context.characterID || !context.corporationID || !context.systemID || !context.shipID) {
    return "INVALID_SESSION";
  }
  const storedTowerID = resourceRuntime.getModuleControlTowerID(item);
  const storedTower = storedTowerID > 0 ? findItemById(storedTowerID) : null;
  const tower = isEligibleAssociationTower(item, storedTower)
    ? storedTower
    : findAssociationTower(item);
  const authority = anchoringPolicy.validateCorporationAuthority(
    session,
    item.ownerID,
    { tower, structureID: item.itemID, operation },
  );
  if (!authority.success) return authority.errorMsg;
  if (toInt(item.locationID, 0) !== context.systemID || !item.spaceState) return "STARBASE_MODULE_NOT_IN_SPACE";
  const runtime = require(path.join(__dirname, "../../space/runtime"));
  const scene = runtime.getSceneForSession(session);
  const ship = runtime.getEntity(session, context.shipID);
  const module = runtime.getEntity(session, item.itemID);
  if (!ship || !module) return "STARBASE_MODULE_NOT_VISIBLE";
  if (
    !isShipInsideTowerForceField(ship, tower) &&
    getEntitySurfaceDistance(scene, ship, module) >
      MAX_LOCAL_OPERATION_DISTANCE_METERS
  ) {
    return "STARBASE_STRUCTURE_TOO_FAR";
  }
  return null;
}

function clearTimer(itemID) {
  const id = toInt(itemID, 0);
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

function clearTimers() {
  for (const itemID of timers.keys()) clearTimer(itemID);
}

function schedule(itemID, deadline) {
  clearTimer(itemID);
  const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - Date.now()));
  const timer = setTimeout(() => {
    timers.delete(toInt(itemID, 0));
    const result = reconcileStarbaseModule(itemID, { nowMs: Date.now(), schedule: true });
    if (!result.success) log.warn(`[Starbase] module reconciliation failed item=${itemID} error=${result.errorMsg}`);
  }, delay);
  if (timer.unref) timer.unref();
  timers.set(toInt(itemID, 0), timer);
}

function refresh(item) {
  const runtime = require(path.join(__dirname, "../../space/runtime"));
  runtime.spawnDynamicInventoryEntity(toInt(item.locationID, 0), item.itemID);
}

// Revalidate restrictions at admission, timer completion and hydration. A
// structure cannot retain a stale sovereignty/upgrade grant by waiting out an
// onlining timer or replaying an idempotent Online request.
function validateOnlineEligibility(item, tower) {
  if (!isEligibleAssociationTower(item, tower) ||
      String(tower.spaceState && tower.spaceState.onlineState).toLowerCase() !== "online") {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_ONLINE" };
  }
  if (require("./starbaseDefenseRuntime").hasUnavailableHealth(item)) {
    return { success: false, errorMsg: "MODULE_INCAPACITATED" };
  }
  const restrictions = anchoringPolicy.validateSystemRestrictions(item);
  if (!restrictions.success) return restrictions;
  return resourceRuntime.validateModuleResources(tower, item);
}

function reconcileStarbaseModule(itemOrID, options = {}) {
  const itemID = toInt(itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID, 0);
  const item = findItemById(itemID);
  if (!resourceRuntime.isStarbaseModule(item)) return { success: false, errorMsg: "ITEM_NOT_STARBASE_MODULE" };
  const state = getState(item);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const transition = state.anchorState === "anchoring" || state.anchorState === "unanchoring"
    ? "anchor"
    : state.onlineState === "onlining" ? "online" : null;
  if (!transition) {
    if (state.onlineState !== "online") {
      return { success: true, data: item, completed: false };
    }
    const tower = findItemById(state.controlTowerID);
    const eligibility = validateOnlineEligibility(item, tower);
    if (eligibility.success) {
      return { success: true, data: item, completed: false };
    }
    const updated = updateInventoryItem(itemID, (current) => ({
      ...current,
      spaceState: {
        ...(current.spaceState || {}),
        onlineState: "offline",
        online: 0,
        onlineStartedAtMs: null,
        onlineCompletesAtMs: null,
        starbaseDisabledReason: eligibility.errorMsg,
        starbaseDisabledAtMs: nowMs,
      },
    }));
    clearTimer(itemID);
    if (updated.success && options.refreshPresentation !== false) {
      refresh(updated.data);
    }
    return updated.success
      ? {
          success: true,
          data: updated.data,
          completed: false,
          recovered: true,
          disabledReason: eligibility.errorMsg,
        }
      : updated;
  }
  const deadline = transition === "anchor" ? state.anchorCompletesAtMs : state.onlineCompletesAtMs;
  if (deadline && nowMs < deadline) {
    if (options.schedule !== false) schedule(itemID, deadline);
    return { success: true, data: item, completed: false };
  }
  let finalAnchor = state.anchorState;
  let finalOnline = state.onlineState;
  let disabledReason = null;
  if (transition === "anchor") {
    finalAnchor = state.anchorState === "anchoring" ? "anchored" : "unanchored";
    if (finalAnchor === "unanchored") finalOnline = "offline";
  } else {
    const tower = findItemById(state.controlTowerID);
    const eligibility = validateOnlineEligibility(item, tower);
    finalOnline = eligibility.success ? "online" : "offline";
    disabledReason = eligibility.errorMsg || null;
  }
  const updated = updateInventoryItem(itemID, (current) => ({
    ...current,
    spaceState: {
      ...(current.spaceState || {}),
      anchorState: finalAnchor,
      isAnchored: finalAnchor !== "unanchored",
      anchorStartedAtMs: null,
      anchorCompletesAtMs: null,
      onlineState: finalOnline,
      online: finalOnline === "online" ? 1 : 0,
      onlineStartedAtMs: null,
      onlineCompletesAtMs: null,
      ...(transition === "online"
        ? {
            starbaseDisabledReason: finalOnline === "online" ? null : disabledReason,
            starbaseDisabledAtMs: finalOnline === "online" ? null : nowMs,
          }
        : {}),
    },
  }));
  clearTimer(itemID);
  if (updated.success && options.refreshPresentation !== false) refresh(updated.data);
  return updated.success ? { success: true, data: updated.data, completed: true } : updated;
}

function startAnchorTransition(session, itemID, effectName, options = {}) {
  let item = findItemById(toInt(itemID, 0));
  if (!resourceRuntime.isStarbaseModule(item)) return { success: false, errorMsg: "ITEM_NOT_STARBASE_MODULE" };
  const lifting = String(effectName || "").toLowerCase().includes("lift");
  const accessError = validateAccess(session, item, lifting ? "unanchor" : "anchor");
  if (accessError) return { success: false, errorMsg: accessError };
  if (lifting && require("../industry/starbaseIndustryRuntime").hasUnfinishedAssemblyJobs(item)) {
    return { success: false, errorMsg: "STARBASE_INDUSTRY_JOBS_ACTIVE" };
  }
  if (!hasAnchoringSkill(sessionContext(session).characterID)) return { success: false, errorMsg: "ANCHORING_SKILL_REQUIRED" };
  const state = getState(item);
  if (state.anchorState === "anchoring" || state.anchorState === "unanchoring") return { success: true, data: item, idempotent: true };
  if ((!lifting && state.anchorState === "anchored") || (lifting && state.anchorState === "unanchored")) {
    return { success: true, data: item, idempotent: true };
  }
  if (lifting && state.onlineState !== "offline") return { success: false, errorMsg: "STARBASE_MODULE_MUST_BE_OFFLINE" };
  let tower = findItemById(state.controlTowerID);
  const requestedPosition = lifting
    ? null
    : normalizePosition(options.requestedPosition);
  if (!lifting) {
    const placementItem = requestedPosition
      ? {
          ...item,
          spaceState: {
            ...(item.spaceState || {}),
            position: requestedPosition,
          },
        }
      : item;
    tower = findAssociationTower(placementItem);
    if (!tower) return { success: false, errorMsg: "CONTROL_TOWER_NOT_FOUND" };
    const authority = anchoringPolicy.validateCorporationAuthority(session, item.ownerID, {
      tower, structureID: item.itemID, operation: "anchor",
    });
    if (!authority.success) return authority;
    const placement = validatePlacement(placementItem, tower);
    if (!placement.success) return placement;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const delay = Math.max(0, dogma(item.typeID, lifting ? ATTRIBUTE_UNANCHORING_DELAY : ATTRIBUTE_ANCHORING_DELAY, 60000));
  const anchorState = lifting ? "unanchoring" : "anchoring";
  const updated = updateInventoryItem(item.itemID, (current) => ({
    ...current,
    spaceState: {
      ...(current.spaceState || {}),
      ...(requestedPosition
        ? {
            position: requestedPosition,
            targetPoint: requestedPosition,
            velocity: { x: 0, y: 0, z: 0 },
          }
        : {}),
      controlTowerID: lifting ? state.controlTowerID : tower.itemID,
      anchorState,
      isAnchored: true,
      anchorStartedAtMs: nowMs,
      anchorCompletesAtMs: nowMs + delay,
      onlineState: "offline",
      online: 0,
    },
  }));
  if (updated.success) {
    if (options.schedule !== false) schedule(item.itemID, nowMs + delay);
    if (options.refreshPresentation !== false) {
      refresh(updated.data);
      if (requestedPosition) {
        const systemID = toInt(
          updated.data.spaceState && updated.data.spaceState.systemID,
          toInt(updated.data.locationID, 0),
        );
        const relocation = require(path.join(__dirname, "../../space/runtime"))
          .teleportDynamicEntityToPoint(
            systemID,
            item.itemID,
            requestedPosition,
            {
              direction:
                updated.data.spaceState && updated.data.spaceState.direction ||
                { x: 1, y: 0, z: 0 },
            },
          );
        if (
          relocation &&
          relocation.success === false &&
          !["SCENE_NOT_FOUND", "DYNAMIC_ENTITY_NOT_FOUND"].includes(
            relocation.errorMsg,
          )
        ) {
          log.warn(
            `[Starbase] Anchor placement presentation failed item=${item.itemID} ` +
            `error=${relocation.errorMsg}`,
          );
        }
      }
    }
  }
  return updated.success ? { success: true, data: updated.data, delayMs: delay } : updated;
}

function setOnlineState(session, itemID, online, options = {}) {
  let item = findItemById(toInt(itemID, 0));
  if (!resourceRuntime.isStarbaseModule(item)) return { success: false, errorMsg: "ITEM_NOT_STARBASE_MODULE" };
  const accessError = validateAccess(session, item, online ? "online" : "offline");
  if (accessError) return { success: false, errorMsg: accessError };
  const reconciliation = reconcileStarbaseModule(item, { ...options, schedule: false, refreshPresentation: false });
  if (!reconciliation.success) return reconciliation;
  item = reconciliation.data;
  const state = getState(item);
  if (!online) {
    const updated = updateInventoryItem(item.itemID, (current) => ({ ...current, spaceState: { ...(current.spaceState || {}), onlineState: "offline", online: 0, onlineStartedAtMs: null, onlineCompletesAtMs: null } }));
    clearTimer(item.itemID);
    if (updated.success && options.refreshPresentation !== false) refresh(updated.data);
    return updated;
  }
  if (state.anchorState !== "anchored") return { success: false, errorMsg: "STARBASE_MODULE_NOT_ANCHORED" };
  const tower = findItemById(state.controlTowerID);
  const eligibility = validateOnlineEligibility(item, tower);
  if (!eligibility.success) return eligibility;
  if (state.onlineState === "online" || state.onlineState === "onlining") return { success: true, data: item, idempotent: true };
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const delay = Math.max(0, dogma(item.typeID, ATTRIBUTE_ONLINING_DELAY, 60000));
  const updated = updateInventoryItem(item.itemID, (current) => ({
    ...current,
    spaceState: {
      ...(current.spaceState || {}),
      onlineState: "onlining",
      online: 0,
      onlineStartedAtMs: nowMs,
      onlineCompletesAtMs: nowMs + delay,
      starbaseDisabledReason: null,
      starbaseDisabledAtMs: null,
    },
  }));
  if (updated.success) {
    if (options.schedule !== false) schedule(item.itemID, nowMs + delay);
    if (options.refreshPresentation !== false) refresh(updated.data);
  }
  return updated.success ? { success: true, data: updated.data, delayMs: delay } : updated;
}

module.exports = {
  clearModuleTimer: clearTimer,
  TYPE_ANCHORING,
  EFFECT_ONLINE_FOR_STRUCTURES,
  EFFECT_ANCHOR_DROP_FOR_STRUCTURES,
  EFFECT_ANCHOR_LIFT_FOR_STRUCTURES,
  MAX_ASSOCIATION_DISTANCE_METERS,
  MAX_LOCAL_OPERATION_DISTANCE_METERS,
  getState,
  findAssociationTower,
  isEligibleAssociationTower,
  validatePlacement,
  reconcileStarbaseModule,
  startAnchorTransition,
  setOnlineState,
  _testing: {
    clearTimer,
    clearTimers,
    getEntitySurfaceDistance,
    isShipInsideTowerForceField,
    normalizePosition,
    validateAccess,
  },
};
