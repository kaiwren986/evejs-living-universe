"use strict";

// Private cosmic anomalies and signatures: a mission site whose template asks for it
// (populationHints.privateScannerSite = "anomaly" or "signature") is listed in its owner's
// Probe Scanner, and in no one else's. On Tranquility the career agents' Anomaly Training Site
// is an anomaly (the briefing sends the pilot to the Probe Scanner's "Warp To"); the Data,
// Relic and Gas Training Sites are signatures the pilot probes down. The system's shared
// signal tracker lists stay as they are; scanMgrService adds these per character, the probe
// scan finds the owner's signatures, and the scan warp resolves them for their owner.

const path = require("path");

const dungeonRuntime = require(path.join(__dirname, "../../dungeon/dungeonRuntime"));
const dungeonAuthority = require(path.join(__dirname, "../../dungeon/dungeonAuthority"));
const explorationAuthority = require(path.join(__dirname, "../explorationAuthority"));
const targetIdRuntime = require(path.join(__dirname, "./targetIdRuntime"));
const { toInt } = require(path.join(__dirname, "../../../common/numbers"));

function ownerOf(instance) {
  const ownership = instance && instance.ownership;
  if (!ownership || ownership.visibilityScope !== "private") {
    return 0;
  }
  return toInt(ownership.missionOwnerCharacterID, toInt(ownership.characterID, 0));
}

// The character's private sites of one kind in this system, in the shape of the providers'
// sites (signatureRuntime.listSystemAnomalySites / listSystemSignatureSites).
function listPrivateSites(systemID, characterID, siteKind) {
  const numericSystemID = toInt(systemID, 0);
  const numericCharacterID = toInt(characterID, 0);
  if (numericSystemID <= 0 || numericCharacterID <= 0) {
    return [];
  }
  const sites = [];
  for (const instance of dungeonRuntime.listActiveInstancesBySystem(numericSystemID, { full: true }) || []) {
    if (!instance || ownerOf(instance) !== numericCharacterID) {
      continue;
    }
    const template = dungeonAuthority.getTemplateByID(instance.templateID);
    const hints = (template && template.populationHints) || {};
    if (hints.privateScannerSite !== siteKind) {
      continue;
    }
    const instanceID = toInt(instance.instanceID, 0);
    const siteID = toInt(instance.metadata && instance.metadata.siteID, 0) || instanceID;
    const position = instance.position || {};
    const family = String(template.siteFamily || "combat").trim().toLowerCase();
    const site = {
      siteID,
      itemID: siteID,
      instanceID,
      siteKind,
      family,
      label: String(template.resolvedName || template.name || (siteKind === "anomaly" ? "Cosmic Anomaly" : "Cosmic Signature")),
      difficulty: Math.max(1, toInt(template.difficulty, 1)),
      dungeonID: toInt(template.sourceDungeonID, 0) || null,
      dungeonNameID: toInt(template.dungeonNameID, 0) || null,
      archetypeID: toInt(template.archetypeID, 0) || null,
      factionID: toInt(template.factionID, 0) || null,
      solarSystemID: numericSystemID,
      typeID: toInt(template.entryObjectTypeID, 0) || null,
      actualPosition: { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 },
      position: [Number(position.x) || 0, Number(position.y) || 0, Number(position.z) || 0],
    };
    if (siteKind === "anomaly") {
      Object.assign(site, {
        scanStrengthAttribute: explorationAuthority.getScanStrengthAttribute(family) || null,
        allowedTypes: [],
        entryObjectTypeID: toInt(template.entryObjectTypeID, 0) || null,
        targetID: targetIdRuntime.encodeTargetID("private-mission-anomaly", numericSystemID, instanceID),
      });
    } else {
      // As sceneSignatureSiteProvider describes a dungeon signature to the probe scan.
      const contracts = explorationAuthority.getScanContracts() || {};
      const signatureType = explorationAuthority.getSignatureTypeDefinition(family) || {};
      Object.assign(site, {
        scanGroupID: toInt(contracts.probeScanGroups && contracts.probeScanGroups.signatures, 3),
        // The client's scan filter hides a result without a known group ("1 Filtered"): a
        // dungeon signature is a Cosmic Signature (inventory group 502), as the probe scan's
        // own default has it.
        groupID: toInt(signatureType.inventoryGroupID, 0) ||
          toInt((explorationAuthority.getSignatureTypeDefinition("wormhole") || {}).inventoryGroupID, 0) || 502,
        strengthAttributeID: explorationAuthority.getScanStrengthAttribute(family) || null,
        targetID: targetIdRuntime.encodeTargetID("private-mission-signature", numericSystemID, instanceID),
      });
    }
    sites.push(site);
  }
  return sites.sort((left, right) => left.siteID - right.siteID);
}

const listPrivateAnomalySites = (systemID, characterID) => listPrivateSites(systemID, characterID, "anomaly");
const listPrivateSignatureSites = (systemID, characterID) => listPrivateSites(systemID, characterID, "signature");

module.exports = {
  listPrivateAnomalySites,
  listPrivateSignatureSites,
};
