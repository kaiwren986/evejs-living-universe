"use strict";

// What dogmaService.js and its system files under dogmaService/ share: dogma attribute,
// group and effect IDs, two marshal column types, a clamp to the range 0 to 1 and the module
// summary written to the log. Each is used by more than one of those files. They were
// top-level declarations in dogmaService.js and moved here as they were, so a system file can
// require them without requiring dogmaService.js back.

const path = require("path");
const {
  getAttributeIDByNames,
  getEffectIDByNames,
  isEffectivelyOnlineModule,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  normalizeNumber,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));

const ATTRIBUTE_PILOT_SECURITY_STATUS = 2610;
const ATTRIBUTE_MASS = 4;
const ATTRIBUTE_CAPACITY = 38;
const ATTRIBUTE_MAX_LOCKED_TARGETS =
  getAttributeIDByNames("maxLockedTargets") || 192;
const ATTRIBUTE_VOLUME = 161;
const ATTRIBUTE_RADIUS = 162;
const ATTRIBUTE_MODULE_REPAIR_RATE =
  getAttributeIDByNames("moduleRepairRate") || 1267;
const ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER =
  getAttributeIDByNames("shipBrokenModuleRepairCostMultiplier") || 1277;
const GROUP_SCAN_PROBE_LAUNCHER = 481;
const ANALYZER_EFFECT_NAME = "doHacking";
function clampRatio(value, fallback = 1) {
  const numericValue = normalizeNumber(value, fallback);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  if (numericValue <= 0) {
    return 0;
  }
  if (numericValue >= 1) {
    return 1;
  }
  return numericValue;
}
const DBTYPE_I4 = 0x03;
const DBTYPE_I8 = 0x14;
const EFFECT_ONLINE = getEffectIDByNames("online") || 16;
function summarizeModuleItemForLog(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  return {
    itemID: Number(item.itemID) || 0,
    typeID: Number(item.typeID) || 0,
    locationID: Number(item.locationID) || 0,
    flagID: Number(item.flagID) || 0,
    groupID: Number(item.groupID) || 0,
    categoryID: Number(item.categoryID) || 0,
    online: isEffectivelyOnlineModule(item),
    quantity: Math.max(0, Number(item.stacksize ?? item.quantity ?? 0) || 0),
  };
}

module.exports = {
  ATTRIBUTE_PILOT_SECURITY_STATUS,
  ATTRIBUTE_MASS,
  ATTRIBUTE_CAPACITY,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_VOLUME,
  ATTRIBUTE_RADIUS,
  ATTRIBUTE_MODULE_REPAIR_RATE,
  ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER,
  GROUP_SCAN_PROBE_LAUNCHER,
  ANALYZER_EFFECT_NAME,
  clampRatio,
  DBTYPE_I4,
  DBTYPE_I8,
  EFFECT_ONLINE,
  summarizeModuleItemForLog,
};
