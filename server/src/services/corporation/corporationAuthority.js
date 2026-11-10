"use strict";

const path = require("node:path");
const { parseCorporationRoleMask, getSessionCorporationRoleMask } = require("./corporationRoleChecks");

const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "../_shared/sessionIdentity"));
const {
  peekCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getAllianceRecord,
  getAllianceCorporationIDs,
  getCorporationRecord,
  isNpcCorporationID,
} = require(path.join(__dirname, "./corporationState"));
const {
  CORP_ROLE_ACCOUNTANT,
  CORP_ROLE_DIRECTOR,
  CORP_ROLE_JUNIOR_ACCOUNTANT,
  getCorporationMember,
  getCorporationWalletDivisionTakeRole,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  getActiveExecutorCorporationID,
} = require(path.join(__dirname, "./allianceGovernanceState"));

const ACCOUNT_ROLE_GML = 18014398509481984n;

function resolveSessionCorporationID(session) {
  return normalizePositiveInteger(
    session && (session.corporationID || session.corpid),
    null,
  );
}

function parseNonNegativeMask(value) {
  return parseCorporationRoleMask(value);
}

function getPersistedCorporationAuthority(session) {
  const characterID = resolveSessionCharacterID(session);
  const corporationID = resolveSessionCorporationID(session);
  if (!characterID || !corporationID) {
    return null;
  }
  const corporation = getCorporationRecord(corporationID);
  const character = peekCharacterRecord(characterID);
  const member = getCorporationMember(corporationID, characterID);
  if (
    !corporation ||
    corporation.deleted ||
    corporation.isNPC !== false ||
    isNpcCorporationID(corporationID) ||
    !character ||
    character.isDeleted ||
    character.deletedAt ||
    Number(character.corporationID) !== Number(corporationID) ||
    !member ||
    member.deleted ||
    Number(member.characterID) !== Number(characterID) ||
    Number(member.corporationID) !== Number(corporationID)
  ) {
    return null;
  }
  const sessionCorporationRoles = getSessionCorporationRoleMask(session);
  return {
    characterID,
    corporationID,
    corporation,
    member,
    sessionCorporationRoles,
    isCEO: Number(corporation.ceoID) === Number(characterID),
    // Membership comes from the store; operation permissions come from the
    // server-owned session, refreshed after grants, revocations and moves.
    isDirector:
      (sessionCorporationRoles & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR,
  };
}

function getAllianceMemberAuthority(session, allianceID) {
  const authority = getPersistedCorporationAuthority(session);
  const persistedAllianceID = normalizePositiveInteger(
    authority && authority.corporation && authority.corporation.allianceID,
    null,
  );
  const requestedAllianceID = normalizePositiveInteger(allianceID, null);
  if (
    !authority ||
    !persistedAllianceID ||
    (requestedAllianceID && requestedAllianceID !== persistedAllianceID)
  ) {
    return null;
  }
  const alliance = getAllianceRecord(persistedAllianceID);
  if (!alliance || alliance.deleted) {
    return null;
  }
  const members = new Set(getAllianceCorporationIDs(persistedAllianceID));
  if (
    Number(authority.corporation.allianceID) !== Number(persistedAllianceID) ||
    !members.has(Number(authority.corporationID))
  ) {
    return null;
  }
  return { ...authority, allianceID: persistedAllianceID };
}

function corporationAuthorityHasRole(authority, roleMask) {
  const requiredRole = parseNonNegativeMask(roleMask);
  if (!authority || requiredRole <= 0n) {
    return false;
  }
  if (authority.isDirector) {
    return true;
  }
  const roles = parseNonNegativeMask(authority.sessionCorporationRoles);
  return (roles & requiredRole) === requiredRole;
}

// Reading a corporation wallet division is a weaker permission than taking from it.
// V24.01 splits the two in eve.common.lib.corporations: ValidateCorpWalletDivisionAccess
// wants that division's Account Take bit and nothing else, while
// ValidateCorpWalletDivisionReadAccess is satisfied by Accountant or Junior Accountant
// for every division, and otherwise falls back to the division's own bit. So an
// accountant can see the money without being able to move it, and a member holding one
// Account Take can see that division and no other.
function corporationAuthorityHasWalletDivisionReadAccess(authority, accountKey) {
  if (!authority) {
    return false;
  }
  if (
    corporationAuthorityHasRole(authority, CORP_ROLE_ACCOUNTANT) ||
    corporationAuthorityHasRole(authority, CORP_ROLE_JUNIOR_ACCOUNTANT)
  ) {
    return true;
  }
  const divisionRole = getCorporationWalletDivisionTakeRole(accountKey);
  return Boolean(divisionRole) &&
    corporationAuthorityHasRole(authority, divisionRole);
}

// Session-taking convenience for the single-division callers. Anything iterating the
// divisions should resolve the authority once and use the function above instead, since
// the lookup re-reads the persisted membership on every call.
function hasCorporationWalletDivisionReadAccess(session, accountKey) {
  return corporationAuthorityHasWalletDivisionReadAccess(
    getPersistedCorporationAuthority(session),
    accountKey,
  );
}

function getAllianceRoleAuthority(session, allianceID, roleMask) {
  const authority = getAllianceMemberAuthority(session, allianceID);
  return corporationAuthorityHasRole(authority, roleMask) ? authority : null;
}

function getAllianceDirectorAuthority(session, allianceID) {
  return getAllianceRoleAuthority(session, allianceID, CORP_ROLE_DIRECTOR);
}

function getAllianceExecutorRoleAuthority(session, allianceID, roleMask) {
  const authority = getAllianceRoleAuthority(session, allianceID, roleMask);
  const activeExecutorCorporationID = authority
    ? getActiveExecutorCorporationID(authority.allianceID)
    : null;
  if (
    !authority ||
    !activeExecutorCorporationID ||
    Number(authority.corporationID) !== Number(activeExecutorCorporationID)
  ) {
    return null;
  }
  return { ...authority, activeExecutorCorporationID };
}

function getAllianceExecutorDirectorAuthority(session, allianceID) {
  return getAllianceExecutorRoleAuthority(
    session,
    allianceID,
    CORP_ROLE_DIRECTOR,
  );
}

function sessionHasGmlRole(session) {
  const accountRoles = parseNonNegativeMask(session && session.role);
  return (accountRoles & ACCOUNT_ROLE_GML) === ACCOUNT_ROLE_GML;
}

module.exports = {
  ACCOUNT_ROLE_GML,
  corporationAuthorityHasRole,
  corporationAuthorityHasWalletDivisionReadAccess,
  hasCorporationWalletDivisionReadAccess,
  getAllianceDirectorAuthority,
  getAllianceExecutorDirectorAuthority,
  getAllianceExecutorRoleAuthority,
  getAllianceMemberAuthority,
  getAllianceRoleAuthority,
  getPersistedCorporationAuthority,
  resolveSessionCorporationID,
  sessionHasGmlRole,
};
