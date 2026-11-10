"use strict";

const { random: serverRandom } = require("../../common/random");
const { normalizeLinkRules } = require("../spaceComponents/shipLinkPolicy");

// Reviewed type-81933 ClientSDE component authority from build 3487903.
// The installed 3396210 type, ship list 602 and skyhook siloPlacement locator
// agree with the native V24.01 component contract. No donor runtime data is used.
const SILO_TYPE_ID = 81933;
const SKYHOOK_TYPE_ID = 81080;
const SILO_LINK_RULES = Object.freeze({ ...normalizeLinkRules({
  typeID: SILO_TYPE_ID,
  linkableShipTypeListID: 602,
  maxLinkRange: 30000,
  omegaOnly: true,
  linkDuration: 600,
  dbuffs: { 4: 100, 5: 1, 6: 1, 2426: 1, 2427: 1000, 2428: 1 },
  applyPvpFlag: true,
  dbuffPostLinkDuration: 0,
  keepDbuffDurationOnLinkBreak: true,
  canRelink: true,
  linkEffectGraphicIDOverride: 25030,
  characterEnergyCost: null,
  solarsystemInterferenceCost: null,
}), friendlyDurationMs: 300000 });
const RAID_WINDOW_MS = 7200000;
const SILO_SHIELD_LINK_THRESHOLD = 0.1;

function isWindowOpen(record, nowMs) {
  const window = record && record.theftVulnerability;
  return Boolean(record && record.active && !record.destroyed && window &&
    window.startMs <= nowMs && nowMs < window.endMs);
}

function sampleNextWindow(reinforceHour, nowMs, random = serverRandom) {
  const unit = () => Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, Number(random())));
  const target = new Date(nowMs + (3 + unit()) * 86400000);
  target.setUTCHours(Math.min(23, Math.max(0, Math.trunc(Number(reinforceHour) || 0))), 0, 0, 0);
  const gaussian = Math.sqrt(-2 * Math.log(unit())) * Math.cos(2 * Math.PI * unit());
  const startMs = Math.max(nowMs + 86400000, Math.trunc(target.getTime() + gaussian * 10800000));
  return { startMs, endMs: startMs + RAID_WINDOW_MS };
}

module.exports = { SILO_TYPE_ID, SKYHOOK_TYPE_ID, SILO_LINK_RULES,
  RAID_WINDOW_MS, SILO_SHIELD_LINK_THRESHOLD, isWindowOpen, sampleNextWindow };
