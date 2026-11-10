"use strict";

const { TABLE, readStaticRows } = require("./referenceData");
const { normalizeLinkRules } = require("../spaceComponents/shipLinkPolicy");

// Only installed reference definitions grant the capability. Neither a slim
// field nor client RPC arguments can supply or override component attributes.
function getLinkWithShipComponentAttributes(typeID) {
  const row = readStaticRows(TABLE.CLIENT_SHIP_LINK_COMPONENTS)
    .find((candidate) => candidate.typeID === Number(typeID));
  return normalizeLinkRules(row);
}

function getMicroJumpDriverComponentAttributes(typeID) {
  const row = readStaticRows(TABLE.CLIENT_MICRO_JUMP_COMPONENTS)
    .find((candidate) => candidate.typeID === Number(typeID));
  if (!row || ![row.interactionRange, row.maxShipMass, row.spoolUpDurationMillisec]
    .every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
    return null;
  }
  return {
    typeID: row.typeID,
    interactionRange: row.interactionRange,
    maxShipMass: row.maxShipMass,
    spoolUpDurationMillisec: row.spoolUpDurationMillisec,
  };
}

function getTowGameObjectiveComponentAttributes(typeID) {
  const row = readStaticRows(TABLE.CLIENT_TOW_COMPONENTS).find((candidate) => candidate.typeID === Number(typeID));
  if (!row || ![row.startTowingMaxRange, row.breakTowAboveRange, row.followAtRange]
    .every((value) => typeof value === "number" && Number.isFinite(value) && value > 0) ||
    row.breakTowAboveRange < row.startTowingMaxRange ||
    !Number.isSafeInteger(row.towingShipTypeListID) || row.towingShipTypeListID <= 0) return null;
  return { ...row };
}

module.exports = { getLinkWithShipComponentAttributes, getMicroJumpDriverComponentAttributes,
  getTowGameObjectiveComponentAttributes };
