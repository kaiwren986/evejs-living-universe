"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const campaign = require("./campaignTrailCatalog");
const schedule = require("./eventSchedule");

function active(entity, nowMs = getWallclockNowMs()) {
  if (!entity?.session || !campaign.isEnabled(nowMs)) return false;
  const hull = require("../inventory/itemTypeRegistry").resolveItemByTypeID(entity.typeID);
  const system = require("../../space/worldData").getSolarSystemByID(entity.systemID);
  return Number(hull?.categoryID) === 6 && Number(hull?.raceID) === 8 && Number(system?.factionID) === 500004;
}
function shipModifiers(entity, nowMs) {
  if (!active(entity, nowMs)) return [];
  return [{ modifiedAttributeID: 600, value: schedule.get(schedule.ELECTION).bonuses.warpSpeedPercent,
    operation: 6, stackingPenalized: false }];
}
function moduleSources(entity, nowMs) {
  if (!active(entity, nowMs)) return [];
  const bonuses = schedule.get(schedule.ELECTION).bonuses;
  // CCP dbuff collections 2530 and 2533 target required skills, including
  // capital hybrids and capital local repairers. Remote repair is excluded.
  return [[160, bonuses.hybridTrackingPercent, [3301, 3304, 3307, 21666]],
    [84, bonuses.localArmorRepairPercent, [3393, 21803]]].map(([attribute, value, skills]) => ({
      sourceKind: "system", sourceAttributes: { 99998: value },
      sourceEffects: [{ modifierInfo: skills.map(skillTypeID => ({
        func: "LocationRequiredSkillModifier", domain: "shipID", skillTypeID,
        modifiedAttributeID: attribute, modifyingAttributeID: 99998, operation: 6, stackingPenalized: false,
      })) }],
    }));
}
module.exports = { active, shipModifiers, moduleSources };
