"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");
const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
const { parseCorporationRoleMask, getCorporationRolesAtLocation, getSessionCorporationRoleMask } = require("../corporation/corporationRoleChecks");

const {
  CORP_BLUEPRINT_VIEW_MASK,
  CORP_HANGAR_FLAGS,
  CORP_HANGAR_QUERY_ROLE_BY_FLAG,
  CORP_HANGAR_TAKE_ROLE_BY_FLAG,
  CORP_WALLET_TAKE_ROLE_BY_KEY,
  INDUSTRY_ACTIVITY,
  ROLE_FACTORY_MANAGER,
  ROLE_FACTORY_MANUFACTURING,
  ROLE_FACTORY_SCIENCE,
} = require(path.join(__dirname, "./industryConstants"));

function normalizeRoleValue(value) {
  return parseCorporationRoleMask(value);
}

function getSessionCharacterID(session) {
  return toInt(session && (session.characterID || session.charid), 0);
}

function getSessionCorporationID(session) {
  return toInt(session && (session.corporationID || session.corpid), 0);
}

function rolesAtLocation(session, locationID) {
  return getCorporationRolesAtLocation(session, locationID);
}

function isCharacterOwner(session, ownerID) {
  return toInt(ownerID, 0) > 0 && getSessionCharacterID(session) === toInt(ownerID, 0);
}

function isCorporationOwner(session, ownerID) {
  const corporationID = toInt(ownerID, 0);
  if (corporationID <= 0 || getSessionCorporationID(session) !== corporationID) return false;
  const authority = getPersistedCorporationAuthority(session);
  return Boolean(authority && authority.corporationID === corporationID);
}

function canSeeCorporationBlueprints(session, ownerID) {
  if (!isCorporationOwner(session, ownerID)) {
    return false;
  }
  const corpRole = getSessionCorporationRoleMask(session);
  return (corpRole & CORP_BLUEPRINT_VIEW_MASK) !== 0n;
}

function hasCorporationIndustryJobAccess(session, ownerID) {
  if (!isCorporationOwner(session, ownerID)) {
    return false;
  }
  const corpRole = getSessionCorporationRoleMask(session);
  return (corpRole & ROLE_FACTORY_MANAGER) === ROLE_FACTORY_MANAGER;
}

function getRequiredCorporationIndustryActivityRole(activityID) {
  return toInt(activityID, 0) === INDUSTRY_ACTIVITY.MANUFACTURING
    ? ROLE_FACTORY_MANUFACTURING
    : ROLE_FACTORY_SCIENCE;
}

function getMissingCorporationIndustryRoles(session, ownerID, locationID, activityID) {
  if (!isCorporationOwner(session, ownerID)) {
    return [];
  }
  const roles = rolesAtLocation(session, locationID);
  return [
    ROLE_FACTORY_MANAGER,
    getRequiredCorporationIndustryActivityRole(activityID),
  ].filter((requiredRole) => (roles & requiredRole) !== requiredRole);
}

function canViewOwnerLocation(session, ownerID, locationID, flagID) {
  if (isCharacterOwner(session, ownerID)) {
    return true;
  }
  if (!isCorporationOwner(session, ownerID)) {
    return false;
  }
  const queryRole = CORP_HANGAR_QUERY_ROLE_BY_FLAG[toInt(flagID, 0)];
  if (!queryRole) {
    return hasCorporationIndustryJobAccess(session, ownerID);
  }
  const roles = rolesAtLocation(session, locationID);
  return (roles & (queryRole | ROLE_FACTORY_MANAGER)) !== 0n;
}

/**
 * The corporation hangar rule on its own: the division's own take role at this
 * location, and nothing else. This is a corporation rule rather than an
 * industry one - moving an item out of a corp hangar is plain inventory work -
 * so callers that are not running an industry job want this one.
 */
function canTakeFromCorporationHangarDivision(session, ownerID, locationID, flagID) {
  if (isCharacterOwner(session, ownerID)) {
    return true;
  }
  if (!isCorporationOwner(session, ownerID)) {
    return false;
  }
  const takeRole = CORP_HANGAR_TAKE_ROLE_BY_FLAG[toInt(flagID, 0)];
  if (!takeRole) {
    return null;
  }
  const roles = rolesAtLocation(session, locationID);
  return (roles & takeRole) === takeRole;
}

/**
 * The industry variant: the division's take role AND Factory Manager, because
 * drawing corporation materials into a job also requires the right to run
 * corporation jobs at all.
 *
 * Keep this distinct from canTakeFromCorporationHangarDivision. When the
 * Factory Manager clause was added here it silently tightened every caller,
 * including plain inventory moves in invBrokerService, which left a member
 * holding a division's Hangar Take role unable to take from that division.
 */
function canTakeFromOwnerLocation(session, ownerID, locationID, flagID) {
  const divisionAccess = canTakeFromCorporationHangarDivision(
    session,
    ownerID,
    locationID,
    flagID,
  );
  // null means "not a recognized corp hangar division flag" - the industry rule
  // falls back to general corporation job access there.
  if (divisionAccess === null) {
    return hasCorporationIndustryJobAccess(session, ownerID);
  }
  if (!divisionAccess) {
    return false;
  }
  if (isCharacterOwner(session, ownerID)) {
    return true;
  }
  const roles = rolesAtLocation(session, locationID);
  return (roles & ROLE_FACTORY_MANAGER) === ROLE_FACTORY_MANAGER;
}

function canUseCorporationWallet(session, ownerID, accountKey) {
  if (!isCorporationOwner(session, ownerID)) {
    return false;
  }
  const normalizedAccountKey = toInt(accountKey, 0);
  const roles = getSessionCorporationRoleMask(session);
  const requiredRole = CORP_WALLET_TAKE_ROLE_BY_KEY[normalizedAccountKey];
  return Boolean(requiredRole && (roles & requiredRole) === requiredRole);
}

function getAccessibleCorpHangarFlags(session, locationID, options = {}) {
  const flags = [];
  const takeRequired = options && options.takeRequired === true;
  for (const flagID of CORP_HANGAR_FLAGS) {
    const accessible = takeRequired
      ? canTakeFromOwnerLocation(session, getSessionCorporationID(session), locationID, flagID)
      : canViewOwnerLocation(session, getSessionCorporationID(session), locationID, flagID);
    if (accessible) {
      flags.push(flagID);
    }
  }
  return flags;
}

module.exports = {
  canSeeCorporationBlueprints,
  canTakeFromCorporationHangarDivision,
  canTakeFromOwnerLocation,
  canUseCorporationWallet,
  canViewOwnerLocation,
  getAccessibleCorpHangarFlags,
  getMissingCorporationIndustryRoles,
  getRequiredCorporationIndustryActivityRole,
  getSessionCharacterID,
  getSessionCorporationID,
  hasCorporationIndustryJobAccess,
  isCharacterOwner,
  isCorporationOwner,
  normalizeRoleValue,
  rolesAtLocation,
};
