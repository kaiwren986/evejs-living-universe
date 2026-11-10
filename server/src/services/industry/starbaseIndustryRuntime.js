"use strict";

// Latest industry/storage.py:97-155 and industryCommon.py:378-417 define these
// installation profiles and the normal six-field facility activity payload.
// Jobs, custody, wallet settlement, scheduling and delivery stay in the shared
// industry engine; this module supplies only POS facility authority/lifecycle.
const profiles = require("./starbaseAssemblyProfiles.json").profiles;
const inventory = require("../inventory/itemStore");
const worldData = require("../../space/worldData");
const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
const access = require("./industryAccess");
const { CORP_HANGAR_FLAGS, INDUSTRY_REFERENCE, INDUSTRY_ERROR } = require("./industryConstants");
const number = (value) => Number(value) || 0;

function getAssemblyProfile(typeID) {
  return profiles[String(typeID)] || null;
}

function isAssemblyArray(item) {
  // Retain the adapter name for shared lifecycle callers. Latest industry/
  // mixins.py:775 treats assembly arrays and laboratories identically.
  return Boolean(item && number(item.categoryID) === 23 && [397, 413].includes(number(item.groupID)) && getAssemblyProfile(item.typeID));
}

function getAssemblyArray(itemID) {
  // Blueprint location walks ask this about every container; only starbase rows
  // can be assembly arrays, so ordinary items are not copied.
  const item = inventory.findStarbaseItemById(number(itemID));
  return isAssemblyArray(item) ? item : null;
}

function hasUnfinishedAssemblyJobs(itemOrID) {
  const array = getAssemblyArray(itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID);
  return Boolean(array && require("./industryRuntimeState").hasUnfinishedIndustryJobsAtFacility(array.itemID));
}

function getArrayContext(itemOrID) {
  const array = getAssemblyArray(itemOrID && typeof itemOrID === "object" ? itemOrID.itemID : itemOrID);
  const state = array && array.spaceState;
  const unavailable = (item) => !item || item.destroyed === true || item.spaceState?.destroyed === true ||
    ["destroyed", "destroying"].includes(String(item.destructionState || item.spaceState?.destructionState)) ||
    number(item.conditionState?.damage) >= 1;
  if (!state || number(state.systemID) <= 0 || state.anchorState !== "anchored" || state.isFree === true || unavailable(array)) return null;
  const tower = inventory.findItemById(number(state.controlTowerID));
  const towerState = tower && tower.spaceState;
  if (!towerState || number(tower.categoryID) !== 23 || number(tower.groupID) !== 365 ||
      number(tower.ownerID) !== number(array.ownerID) || number(towerState.systemID) !== number(state.systemID) ||
      towerState.anchorState !== "anchored" || towerState.isFree === true || unavailable(tower) ||
      number(tower.locationID) !== number(array.locationID)) return null;
  const online = (item) => item.spaceState.onlineState === "online" && number(item.spaceState.online) === 1 &&
    number(item.spaceState.incapacitated) !== 1 && item.conditionState?.incapacitated !== true &&
    item.spaceState.reinforced !== true && !require("../starbase/starbaseReinforcementRuntime").isReinforced(item);
  const restrictionsMet = !getAssemblyProfile(array.typeID).capital ||
    require("../starbase/starbaseAnchoringPolicy").validateSystemRestrictions(array).success;
  return { array, tower, online: online(array) && online(tower) && restrictionsMet };
}

function canAccessArray(session, array) {
  if (!array) return false;
  if (!session) return true; // Internal facility/capacity queries; RPCs pass a session.
  const authority = getPersistedCorporationAuthority(session);
  return Boolean(authority && number(authority.corporationID) === number(array.ownerID));
}

function buildAssemblyFacility(itemOrID, session = null) {
  const context = getArrayContext(itemOrID);
  if (!context || !canAccessArray(session, context.array)) return null;
  const { array, tower, online } = context;
  const profile = getAssemblyProfile(array.typeID);
  const modifier = (value, groupID = null) => value === 1 ? [] : [[value, null, groupID, null, INDUSTRY_REFERENCE.FACILITY]];
  const activities = Object.fromEntries(Object.entries(profile.activities || { 1: profile }).map(([activityID, activity]) => {
    const modifiers = (kind) => [...modifier(activity[kind]), ...Object.entries(activity.groupModifiers || {})
      .flatMap(([groupID, values]) => modifier(values[kind] ?? 1, number(groupID)))];
    return [activityID, [modifiers("time"), modifiers("material"), modifiers("cost"),
      [...activity.categories], [...activity.groups], []]];
  }));
  const tax = require("./industryFacilityState").getFacilityTaxRate(array.itemID,
    { facilityID: array.itemID, ownerID: array.ownerID, tax: 0 });
  return {
    facilityID: number(array.itemID), typeID: number(array.typeID), ownerID: number(array.ownerID),
    solarSystemID: number(array.spaceState.systemID), online, tax, serviceAccess: [],
    sccTaxModifier: 1, rigModifiers: [], starbaseTowerID: number(tower.itemID),
    activities,
  };
}

function listAssemblyFacilities(session) {
  const regionID = number(session && session.regionid);
  return [397, 413].flatMap((groupID) => inventory.listStarbaseItems({ groupID }))
    .filter(isAssemblyArray).map((item) => {
    const system = worldData.getSolarSystemByID(number(item.spaceState && item.spaceState.systemID));
    return system && number(system.regionID) === regionID ? buildAssemblyFacility(item, session) : null;
  }).filter(Boolean);
}

function getAssemblyLocations(facilityID, ownerID, session) {
  const context = getArrayContext(facilityID);
  if (!context || !session || number(ownerID) !== number(context.array.ownerID) || !canAccessArray(session, context.array)) return [];
  return CORP_HANGAR_FLAGS.map((flagID) => ({
    itemID: number(facilityID), inventoryLocationID: number(facilityID), typeID: number(context.array.typeID),
    ownerID: number(ownerID), flagID, solarSystemID: number(context.array.spaceState.systemID),
    canView: access.canViewOwnerLocation(session, ownerID, facilityID, flagID),
    canTake: access.canTakeFromOwnerLocation(session, ownerID, facilityID, flagID),
  })).filter((entry) => entry.canView);
}

function getAssemblyRestriction(activityID, productTypeID, facility, blueprintTypeID) {
  const array = getAssemblyArray(facility && facility.facilityID);
  if (!array) return null;
  const installation = getAssemblyProfile(array.typeID);
  const profile = (installation.activities || { 1: installation })[number(activityID)];
  // Facility filters describe the SOURCE blueprint's product, not the
  // blueprint-copy type returned by copying or invention (industryCommon:378).
  const definition = require("./industryStaticData").getBlueprintDefinitionByTypeID(number(blueprintTypeID));
  const product = inventory.getItemMetadata(definition?.productTypeID || productTypeID);
  if (!profile || !product || ((profile.categories.length || profile.groups.length) &&
      !profile.categories.includes(number(product.categoryID)) && !profile.groups.includes(number(product.groupID)))) {
    return { code: INDUSTRY_ERROR.FACILITY_TYPE, args: [number(blueprintTypeID)] };
  }
  return null;
}

// Reuse the shared structure-service pause/resume machinery, including durable
// deadline reconciliation. A POS supplies industry activities instead of an
// Upwell service module; resolved activity/product service IDs filter jobs.
function reconcileAssemblyJobs(itemOrID, options = {}) {
  if (options.nowFiletime === undefined && Number.isFinite(options.nowMs)) {
    options = { ...options, nowFiletime: 116444736000000000n + BigInt(Math.trunc(options.nowMs)) * 10000n };
  }
  const itemID = number(typeof itemOrID === "object" ? itemOrID.itemID : itemOrID);
  const engine = require("./industryRuntimeState");
  const restrictions = require("./industryRestrictions");
  const array = getAssemblyArray(itemID);
  const arrays = array ? [array] : inventory.listStarbaseItems({ controlTowerID: itemID }).filter(isAssemblyArray);
  const changedJobIDs = [];
  for (const item of arrays) {
    // A prepared installation owns blueprint/material escrow until the common
    // durable settlement decides it. Destruction must retain its inactive array
    // and retry, rather than delete the eventual return location underneath it.
    if (options.destroyed === true && engine.hasPendingIndustryInstallAtFacility(item.itemID)) {
      return { success: false, errorMsg: "STARBASE_INDUSTRY_INSTALL_PENDING", data: { changedJobIDs } };
    }
    const deliveryRecovery = engine.recoverCommittedAssemblyDeliveries(item.itemID);
    if (!deliveryRecovery.success) return deliveryRecovery;
    const jobs = engine.listJobsByOwner(item.ownerID, true).filter((job) => number(job.facilityID) === number(item.itemID));
    const serviceIDs = [...new Set(jobs.map((job) => restrictions.resolveIndustryStructureServiceID(job.activityID, job.productTypeID)))];
    const result = options.destroyed === true
      ? engine.cancelIndustryJobsForStructure(item.itemID, options)
      : (getArrayContext(item)?.online ? engine.resumeIndustryJobsForStructureServices : engine.pauseIndustryJobsForStructureServices)(item.itemID, serviceIDs, options);
    if (!result.success) return result;
    changedJobIDs.push(...result.data.changedJobIDs);
  }
  if (options.notify !== false) require("./industryNotifications").notifyFacilitiesUpdated(arrays.map((item) => item.itemID));
  return { success: true, data: { changedJobIDs } };
}

module.exports = { getAssemblyProfile, isAssemblyArray, getAssemblyArray, getArrayContext,
  hasUnfinishedAssemblyJobs,
  canAccessArray, buildAssemblyFacility, listAssemblyFacilities, getAssemblyLocations,
  getAssemblyRestriction, reconcileAssemblyJobs };
