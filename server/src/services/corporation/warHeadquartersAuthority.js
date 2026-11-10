"use strict";

const { throwWrappedUserError } = require("../../common/machoErrors");
const { unwrapMarshalValue } = require("../_shared/serviceHelpers");

function requireOwnedWarHeadquarters(authority, rawStructureID) {
  if (rawStructureID === undefined || rawStructureID === null) return null;
  const structureID = Number(unwrapMarshalValue(rawStructureID));
  const structure = Number.isSafeInteger(structureID) && structureID > 0
    ? require("../structure/structureState").getStructureByID(structureID, { refresh: false })
    : null;
  if (!structure || structure.destroyedAt ||
      Number(structure.ownerCorpID || structure.ownerID) !== Number(authority && authority.corporationID)) {
    throwWrappedUserError("CrpAccessDenied");
  }
  return structureID;
}

module.exports = { requireOwnedWarHeadquarters };
