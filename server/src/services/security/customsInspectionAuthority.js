"use strict";

const crypto = require("node:crypto");
const {
  getCustomsOperatorLayout,
} = require("../../space/empireGatePresence/customsOperatorLayouts");

const ATTRIBUTE_CONTRABAND_DETECTION_CHANCE = 723;
const ATTRIBUTE_SCAN_CHANCE = 725;

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function buildLawSnapshot(laws) {
  if (!Array.isArray(laws)) {
    throw new TypeError("Customs laws must be an array.");
  }
  const keys = new Set();
  const rows = laws.map((source) => {
    const row = {
      typeID: positiveInteger(source && source.typeID),
      factionID: positiveInteger(source && source.factionID),
      basePrice: Number(source && source.basePrice),
      attackMinSec: Number(source && source.attackMinSec),
      confiscateMinSec: Number(source && source.confiscateMinSec),
      fineByValue: Number(source && source.fineByValue),
      standingLoss: Number(source && source.standingLoss),
    };
    if (!row.typeID || !row.factionID ||
        !Object.values(row).every(Number.isFinite) ||
        row.basePrice < 0 || row.fineByValue < 0 || row.standingLoss < 0) {
      throw new TypeError("Customs authority contains an invalid law.");
    }
    const key = `${row.typeID}:${row.factionID}`;
    if (keys.has(key)) {
      throw new TypeError(`Customs authority contains duplicate law ${key}.`);
    }
    keys.add(key);
    return row;
  }).sort((left, right) => left.factionID - right.factionID || left.typeID - right.typeID);
  return deepFreeze({
    revision: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    laws: rows,
  });
}

function installedDependencies() {
  // Resolve at the domain entry point, after module initialization: the
  // existing contraband owner also calls this authority for case arrivals.
  const worldData = require("../../space/worldData");
  const { CONTRABAND_TYPE_RULES } = require("./contrabandInspectionRuntime");
  const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
  const { getTypeDogmaAttributes } = require("../fitting/liveFittingState");
  const { getNpcProfile, getNpcLoadout } = require("../../space/npc/npcData");
  const { listControllersForScene } = require("../../space/npc/npcRegistry");
  const { getCorporationRecord } = require("../corporation/corporationState");
  return {
    getSystem: worldData.getSolarSystemByID,
    getGate: worldData.getStargateByID,
    getLayout: getCustomsOperatorLayout,
    getType: resolveItemByTypeID,
    getAttributes: getTypeDogmaAttributes,
    getProfile: getNpcProfile,
    getLoadout: getNpcLoadout,
    getCorporation: getCorporationRecord,
    listControllers: listControllersForScene,
    rules: CONTRABAND_TYPE_RULES,
  };
}

function getLawSnapshot(dependencies) {
  const authority = dependencies || installedDependencies();
  const laws = [];
  for (const typeRule of authority.rules) {
    const itemType = authority.getType(typeRule.typeID);
    if (!itemType || !Number.isFinite(Number(itemType.basePrice))) {
      throw new TypeError(`Installed customs item type ${typeRule.typeID} is unavailable.`);
    }
    for (const rule of typeRule.factions) {
      laws.push({ ...rule, typeID: typeRule.typeID, basePrice: Number(itemType.basePrice) });
    }
  }
  return buildLawSnapshot(laws);
}

function ineligible(reason) {
  return { success: true, data: { eligible: false, reason } };
}

function validProbability(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 1 ? numeric : 0;
}

function resolveArrivalAuthority(scene, gateID, dependencies) {
  const installed = dependencies || installedDependencies();
  const systemID = positiveInteger(scene && scene.systemID);
  const sceneKey = String(scene && scene.sceneKey || "");
  if (!systemID || !sceneKey || !scene || typeof scene.getEntityByID !== "function" ||
      scene.sceneKind !== "solarSystem" || positiveInteger(scene.instanceID)) {
    return ineligible("EXACT_SOLAR_SCENE_REQUIRED");
  }
  const gate = installed.getGate(gateID);
  const gateEntity = scene.getEntityByID(gateID);
  if (!gate || !gateEntity || Number(gate.solarSystemID) !== systemID ||
      gateEntity.kind !== "stargate" || Number(gateEntity.itemID) !== Number(gateID)) {
    return ineligible("GATE_NOT_IN_SCENE");
  }
  const system = installed.getSystem(systemID);
  const factionID = positiveInteger(system && system.factionID);
  const security = Number(system && (system.security ?? system.securityStatus));
  if (!system || !factionID || !Number.isFinite(security)) {
    return ineligible("NO_FACTION_AUTHORITY");
  }
  const lawSnapshot = getLawSnapshot(installed);
  const laws = lawSnapshot.laws.filter((law) => law.factionID === factionID);
  if (laws.length === 0) {
    return ineligible("NO_APPLICABLE_LAW");
  }
  const layout = installed.getLayout(systemID, gateID);
  if (!layout || Number(layout.lawFactionID) !== factionID) {
    return ineligible("NO_VALIDATED_CUSTOMS_LAYOUT");
  }
  const corporation = installed.getCorporation(layout.corporationID);
  if (!corporation || corporation.isNPC !== true || corporation.deleted ||
      Number(corporation.factionID) !== Number(layout.factionID)) {
    return ineligible("CUSTOMS_OPERATOR_AUTHORITY_UNAVAILABLE");
  }
  const expectedProfiles = new Map(layout.slots.map((slot) => [slot.profileID, Number(slot.typeID)]));
  const officers = [];
  for (const controller of installed.listControllers(scene)) {
    const entityID = positiveInteger(controller && controller.entityID);
    const entity = entityID && scene.getEntityByID(entityID);
    const expectedTypeID = expectedProfiles.get(controller && controller.profileID);
    if (!entity || entity.kind !== "ship" || entity.nativeNpc !== true ||
        entity.nativeNpcOccupied !== true || String(entity.sceneKey || "") !== sceneKey ||
        !expectedTypeID || Number(controller.systemID) !== systemID ||
        String(controller.sceneKey || "") !== sceneKey ||
        controller.sceneKind !== scene.sceneKind || positiveInteger(controller.instanceID) ||
        Number(controller.anchorID) !== Number(gateID) || controller.anchorKind !== "stargate" ||
        controller.disabled === true || entity.destroyed === true ||
        (entity.conditionState && entity.conditionState.incapacitated === true)) {
      continue;
    }
    const profile = installed.getProfile(controller.profileID);
    const itemType = installed.getType(expectedTypeID);
    if (!profile || !itemType || !installed.getLoadout(profile.loadoutID) ||
        Number(profile.presentationTypeID || profile.shipTypeID) !== expectedTypeID ||
        Number(profile.corporationID) !== Number(layout.corporationID) ||
        Number(profile.factionID) !== Number(layout.factionID) ||
        Number(entity.slimTypeID || entity.typeID) !== expectedTypeID ||
        Number(entity.corporationID) !== Number(layout.corporationID) ||
        Number(entity.warFactionID || entity.factionID) !== Number(layout.factionID)) {
      continue;
    }
    const attributes = installed.getAttributes(expectedTypeID);
    const scanChance = validProbability(attributes[ATTRIBUTE_SCAN_CHANCE]);
    const detectionChance = validProbability(attributes[ATTRIBUTE_CONTRABAND_DETECTION_CHANCE]);
    if (scanChance && detectionChance) {
      officers.push({
        entityID,
        typeID: expectedTypeID,
        profileID: profile.profileID,
        corporationID: Number(layout.corporationID),
        factionID: Number(layout.factionID),
        scanChance,
        detectionChance,
      });
    }
  }
  officers.sort((left, right) => left.entityID - right.entityID);
  if (officers.length === 0) {
    return ineligible("NO_OPERATIONAL_CUSTOMS_GROUP");
  }
  const revision = crypto.createHash("sha256").update(JSON.stringify({
    lawRevision: lawSnapshot.revision,
    layout,
  })).digest("hex");
  const scanner = officers[0];
  return { success: true, data: deepFreeze({
    eligible: true,
    systemID,
    solarSystemID: systemID,
    solarSystemName: String(system.solarSystemName || ""),
    factionID,
    security,
    sceneKey,
    revision,
    lawRevision: lawSnapshot.revision,
    laws,
    layout: JSON.parse(JSON.stringify(layout)),
    scannerID: scanner.entityID,
    scannerTypeID: scanner.typeID,
    scanChance: scanner.scanChance,
    detectionChance: scanner.detectionChance,
    officerIDs: officers.map((officer) => officer.entityID),
    officers,
  }) };
}

module.exports = {
  ATTRIBUTE_CONTRABAND_DETECTION_CHANCE,
  ATTRIBUTE_SCAN_CHANCE,
  buildLawSnapshot,
  getLawSnapshot,
  resolveArrivalAuthority,
};
