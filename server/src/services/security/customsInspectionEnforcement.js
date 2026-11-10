"use strict";

const { cloneValue } = require("../../common/clone");
const { getControllerByEntityID } = require("../../space/npc/npcRegistry");
const { resolveArrivalAuthority } = require("./customsInspectionAuthority");
const leases = new Map();

function layoutIdentity(layout) {
  if (!layout || !Array.isArray(layout.slots)) return null;
  // Compare the validated static deployment, not its former runtime IDs or
  // the current law revision. A static-data price update does not change an
  // already settled case, while a different operator cannot inherit it.
  return JSON.stringify([
    layout.layoutKey, Number(layout.solarSystemID), Number(layout.gateID),
    Number(layout.corporationID), Number(layout.factionID), Number(layout.lawFactionID),
    layout.spawnGroupID,
    layout.slots.map((slot) => [slot.profileID, Number(slot.typeID),
      Number(slot.offset && slot.offset.x), Number(slot.offset && slot.offset.y), Number(slot.offset && slot.offset.z),
      slot.orbitTarget, Number(slot.orbitDistanceMeters), Number(slot.maxVelocity), Number(slot.speedFraction)]),
  ]);
}

function acquire(record, scene) {
  if (!record || !record.authority || !scene || scene.sceneKey !== record.sceneKey ||
      Number(scene.systemID) !== Number(record.systemID) || !scene.dynamicEntities.has(record.shipID)) {
    return { success: false, errorMsg: "CUSTOMS_SCENE_UNAVAILABLE" };
  }
  const current = resolveArrivalAuthority(scene, record.gateID);
  if (!current || !current.success || !current.data || !current.data.eligible) {
    release(record.caseID);
    return { success: false, errorMsg: "CUSTOMS_OFFICERS_UNAVAILABLE" };
  }
  if (!layoutIdentity(record.authority.layout) ||
      layoutIdentity(current.data.layout) !== layoutIdentity(record.authority.layout) ||
      Number(current.data.factionID) !== Number(record.factionID) ||
      Number(record.authority.systemID || record.authority.solarSystemID) !== Number(record.systemID)) {
    release(record.caseID);
    return { success: false, errorMsg: "CUSTOMS_OPERATOR_AUTHORITY_CHANGED" };
  }
  const officers = current.data.officerIDs.filter((entityID) => {
    const controller = getControllerByEntityID(entityID);
    return controller && (!controller.customsEngagementCaseID || controller.customsEngagementCaseID === record.caseID);
  });
  if (leases.has(record.caseID)) {
    const entries = leases.get(record.caseID);
    if (entries.length === officers.length && entries.every(({ entityID, controller }) =>
      getControllerByEntityID(entityID) === controller &&
      officers.includes(entityID) && controller.customsEngagementCaseID === record.caseID)) {
      return { success: true, duplicate: true, officerIDs: [...officers] };
    }
    release(record.caseID);
  }
  const service = require("../../space/npc/npcService");
  const acquired = [];
  for (const entityID of officers) {
    const controller = getControllerByEntityID(entityID);
    const entity = scene.dynamicEntities.get(entityID);
    if (!controller || !entity || controller.systemID !== record.systemID ||
        Number(controller.anchorID) !== record.gateID ||
        controller.sceneKey !== record.sceneKey ||
        controller.customsEngagementCaseID && controller.customsEngagementCaseID !== record.caseID) continue;
    const previous = {};
    for (const key of ["runtimeKind", "manualOrder", "behaviorOverrides", "currentTargetID", "preferredTargetID"]) {
      previous[key] = cloneValue(controller[key] ?? null);
    }
    const result = service.issueManualOrder(entityID, {
      type: "attack", targetID: record.shipID, allowWeapons: true,
      keepLock: true, allowPodKill: false, movementMode: "orbit",
    });
    if (!result || !result.success) continue;
    controller.customsEngagementCaseID = record.caseID;
    controller.runtimeKind = "nativeCombat";
    controller.behaviorOverrides = { ...(controller.behaviorOverrides || {}), allowPodKill: false };
    controller.currentTargetID = record.shipID;
    controller.preferredTargetID = record.shipID;
    acquired.push({ entityID, controller, previous,
      sceneKey: record.sceneKey, systemID: record.systemID, gateID: record.gateID });
  }
  if (!acquired.length) return { success: false, errorMsg: "CUSTOMS_OFFICERS_UNAVAILABLE" };
  leases.set(record.caseID, acquired);
  return { success: true, officerIDs: acquired.map((entry) => entry.entityID) };
}

function release(caseID) {
  const entries = leases.get(caseID);
  if (!entries) return;
  const service = require("../../space/npc/npcService");
  for (const { entityID, controller, previous, sceneKey, systemID, gateID } of entries) {
    // An ID reused in another scene/run must never receive our old order.
    if (getControllerByEntityID(entityID) !== controller || controller.customsEngagementCaseID !== caseID ||
        controller.sceneKey !== sceneKey || Number(controller.systemID) !== Number(systemID) ||
        Number(controller.anchorID) !== Number(gateID)) continue;
    service.issueManualOrder(entityID, previous.manualOrder || {
      type: "returnHome", allowWeapons: false, allowPodKill: false,
    });
    Object.assign(controller, previous);
    delete controller.customsEngagementCaseID;
  }
  leases.delete(caseID);
}

function releaseAll() {
  for (const caseID of leases.keys()) release(caseID);
}
module.exports = { acquire, release, releaseAll };
