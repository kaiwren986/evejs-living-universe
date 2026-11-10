"use strict";

const authority = require("./factionWarfareAuthority");
const { buildDict, buildKeyVal, buildList, buildObjectEx1, buildFiletimeLong } = require("../_shared/serviceHelpers");

function buildOccupation(system) {
  return system ? buildObjectEx1("factionwarfare.occupationState.OccupationState", [
    system.occupierID, system.adjacencyState, buildList(system.potentialOccupierIDs), system.pirateFactionID,
    system.dateTaken ? buildFiletimeLong(system.dateTaken) : null,
  ]) : null;
}

function buildVictoryPoints(system) {
  return system ? buildObjectEx1("factionwarfare.victoryPointState.VictoryPointState", [system.score, system.threshold]) : null;
}

function buildAllOccupations() {
  const systems = authority.listSystems();
  return buildDict(Object.keys(authority.WARZONES).map(Number).map(warzoneID => [warzoneID,
    buildDict(systems.filter(system => system.warzoneID === warzoneID)
      .map(system => [system.solarSystemID, buildOccupation(system)])),
  ]));
}

function buildZoneInfo(factionID) {
  const validFaction = authority.getWarzoneID(factionID) ? factionID : null;
  const systems = validFaction ? authority.listSystems().filter(system => system.warzoneID === authority.getWarzoneID(factionID)) : [];
  const owned = systems.filter(system => system.occupierID === factionID);
  // One control point per owned system and up to five upgrade points. The
  // authored local warzone has no donation/upgrade mechanic, so upgrades are0.
  return buildKeyVal([["factionID", validFaction],
    ["systemUpgradeLevel", buildDict(systems.map(system => [system.solarSystemID, system.upgradeLevel]))],
    ["factionPoints", owned.reduce((sum, system) => sum + 1 + system.upgradeLevel, 0)],
    ["maxWarZonePoints", Math.max(1, systems.length * 6)]]);
}

function publishSystemChange(before, after) {
  if (!after) return;
  // This follows the durable source checkpoint. Presentation failures cannot
  // reverse it or prevent the independent LP/progression outbox from settling.
  const cache = require("../cache/objectCacheRuntime");
  cache.invalidateCachedMethodCall({ serviceName: "facWarMgr", method: "GetStats_FactionInfo" });
  cache.invalidateCachedMethodCall({ serviceName: "fwWarzoneSolarsystem", method: "GetAllWarzonesOccupationStates" });
  for (const factionID of authority.WARZONES[after.warzoneID]) {
    cache.invalidateCachedMethodCall({ serviceName: "map", method: "GetFacWarZoneInfo", args: [factionID] });
    cache.invalidateCachedMethodCall({ serviceName: "facWarMgr", method: "GetFacWarZoneInfo", args: [factionID] });
  }
  for (const session of require("../chat/sessionRegistry").getSessions()) {
    if (Number(session.solarsystemid2 || session.solarsystemid) !== after.solarSystemID) continue;
    try {
      session.sendNotification("OnVictoryPointStateUpdated", "charid", [after.solarSystemID, buildVictoryPoints(after)]);
      if (!before || before.occupierID !== after.occupierID || before.adjacencyState !== after.adjacencyState || before.dateTaken !== after.dateTaken)
        session.sendNotification("OnWarzoneOccupationStateUpdated", "charid", [after.solarSystemID, buildOccupation(after)]);
    } catch (error) {
      require("../../utils/logger").warn(`[FW] State notification failed: ${error.message}`);
    }
  }
}

module.exports = { buildOccupation, buildVictoryPoints, buildAllOccupations, buildZoneInfo, publishSystemChange };
