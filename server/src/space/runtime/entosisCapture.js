"use strict";

module.exports = {
  recordEntosisWeaponTimer,
  sovereigntyCaptureTickRequiresStructureSync,
};

const {
  recordCommandBurstWeaponTimer,
} = require("./commandBurst");
const {
  toInt,
} = require("../../common/numbers");

function recordEntosisWeaponTimer(scene, sourceEntity, nowMs, options = {}) {
  const result = recordCommandBurstWeaponTimer(
    scene,
    sourceEntity,
    nowMs,
    options,
  );
  if (result && result.success === true) {
    return result;
  }
  return {
    ...(result || {}),
    success: false,
    errorMsg:
      result && result.errorMsg || "ENTOSIS_WEAPON_TIMER_FAILED",
  };
}

function sovereigntyCaptureTickRequiresStructureSync(tickResult) {
  const data = tickResult && tickResult.data;
  if (!data || data.available === false) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(data, "changed")) {
    return data.changed === true;
  }
  // Compatibility with an older capture-core result shape. Current core
  // authors `changed` explicitly so an executor-blocked target does not make
  // the scene rebuild the same static entity on every simulation tick.
  if (toInt(data.completedTargets, 0) > 0) {
    return true;
  }
  const results = Array.isArray(data.results) ? data.results : [];
  return results.some((result) => Boolean(
    result &&
    (
      result.completed === true ||
      result.transitioned === true ||
      result.blocked === true ||
      result.missing === true ||
      result.capture
    )
  ));
}
