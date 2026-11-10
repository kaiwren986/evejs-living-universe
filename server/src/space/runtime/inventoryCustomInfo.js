"use strict";

module.exports = {
  parseInventoryCustomInfo,
};


function parseInventoryCustomInfo(item) {
  const rawCustomInfo = String(item && item.customInfo || "").trim();
  if (!rawCustomInfo) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawCustomInfo);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    // ignored: customInfo that is not JSON counts as empty
    return {};
  }
}
