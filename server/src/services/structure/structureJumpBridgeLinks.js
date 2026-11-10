"use strict";

const { toPositiveInt } = require("../../common/numbers");
const { TYPE_ANSIBLEX_JUMP_BRIDGE } = require("../sovereignty/sovUpgradeSupport");
const { STRUCTURE_SERVICE_ID, STRUCTURE_SERVICE_STATE } = require("./structureConstants");
const { findServiceProximityConflict } = require("./structureServiceProximity");
const geo2 = require("../../common/geo2");

function isAnsiblexStructure(structure) {
  return Boolean(structure && Number(structure.typeID) === TYPE_ANSIBLEX_JUMP_BRIDGE &&
    !structure.destroyedAt);
}

function getJumpBridgeDestinationSolarSystemID(structure) {
  const flags = structure && structure.devFlags || {};
  return toPositiveInt(flags.destinationSolarsystemID ||
    flags.sovereigntyJumpBridgeDestinationSolarsystemID, 0);
}

function getJumpBridgeAlignmentRotation(structure, getSolarSystem) {
  if (!isAnsiblexStructure(structure)) return null;
  const sourceID = toPositiveInt(structure.solarSystemID, 0);
  const destinationID = getJumpBridgeDestinationSolarSystemID(structure);
  if (!sourceID || !destinationID || sourceID === destinationID) return null;
  const source = getSolarSystem(sourceID);
  const destination = getSolarSystem(destinationID);
  if (!source || !destination || !source.position || !destination.position) return null;
  // Match the deployment preview's GetAlignmentYawPitchRadians. Galactic
  // coordinates need double precision before normalizing; dunRotation is degrees.
  const direction = geo2.Vec3NormalizeD(geo2.Vec3SubtractD(destination.position, source.position));
  if (!direction.x && !direction.y && !direction.z) return null;
  return geo2.buildDunRotationFromNormalizedDirection(direction);
}

function findReciprocalJumpBridge(source, structures) {
  if (!isAnsiblexStructure(source)) return null;
  const sourceSystemID = toPositiveInt(source.solarSystemID, 0);
  const destinationSystemID = getJumpBridgeDestinationSolarSystemID(source);
  if (!sourceSystemID || !destinationSystemID || sourceSystemID === destinationSystemID) return null;
  return structures.find((candidate) => (
    isAnsiblexStructure(candidate) &&
    Number(candidate.structureID) !== Number(source.structureID) &&
    Number(candidate.solarSystemID) === destinationSystemID &&
    getJumpBridgeDestinationSolarSystemID(candidate) === sourceSystemID
  )) || null;
}

function isJumpBridgeServiceAvailable(structure, structures) {
  return Boolean(structure &&
    Number(structure.serviceStates && structure.serviceStates[STRUCTURE_SERVICE_ID.JUMP_BRIDGE]) ===
      STRUCTURE_SERVICE_STATE.ONLINE &&
    !findServiceProximityConflict(structure, STRUCTURE_SERVICE_ID.JUMP_BRIDGE, structures));
}

function getActiveJumpBridgeDestination(source, structures) {
  const destination = findReciprocalJumpBridge(source, structures);
  if (!destination || !isJumpBridgeServiceAvailable(source, structures) ||
    !isJumpBridgeServiceAvailable(destination, structures)) return null;
  return destination;
}

module.exports = {
  isAnsiblexStructure,
  getJumpBridgeDestinationSolarSystemID,
  getJumpBridgeAlignmentRotation,
  findReciprocalJumpBridge,
  isJumpBridgeServiceAvailable,
  getActiveJumpBridgeDestination,
};
