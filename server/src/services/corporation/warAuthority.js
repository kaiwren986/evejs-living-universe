"use strict";

const {
  getPersistedCorporationAuthority,
  getAllianceMemberAuthority,
  getAllianceExecutorDirectorAuthority,
} = require("./corporationAuthority");
const { throwWrappedUserError } = require("../../common/machoErrors");

// A corporation in an alliance acts as that alliance in war negotiations.
// Resolve that relationship from current membership, never caller affiliation
// aliases. Only the active executor's directors may bind an alliance to a war.
function getWarAuthority(session, { director = true } = {}) {
  let authority = getPersistedCorporationAuthority(session);
  if (!authority) return null;
  const allianceID = Number(authority.corporation.allianceID) || 0;
  if (allianceID) {
    authority = director
      ? getAllianceExecutorDirectorAuthority(session, allianceID)
      : getAllianceMemberAuthority(session, allianceID);
  } else if (director && !authority.isDirector) {
    authority = null;
  }
  return authority ? { ...authority, warEntityID: allianceID || authority.corporationID } : null;
}

function requireWarAuthority(session, options) {
  const authority = getWarAuthority(session, options);
  if (!authority) throwWrappedUserError("CrpAccessDenied");
  return authority;
}

module.exports = { getWarAuthority, requireWarAuthority };
