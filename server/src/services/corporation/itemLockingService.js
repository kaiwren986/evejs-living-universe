"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const { getPersistedCorporationAuthority, corporationAuthorityHasRole } = require("./corporationAuthority");
const { CORP_ROLE_ACCOUNTANT } = require("./corporationRuntimeState");
const { getCorporationRolesAtLocation } = require("./corporationRoleChecks");
const { CORP_HANGAR_QUERY_ROLE_BY_FLAG } = require("../industry/industryConstants");
const { findItemById } = require("../inventory/itemStore");
const {
  buildDict,
  buildKeyVal,
  buildPythonSet,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getLockedItemLocations,
  getLockedItemsByLocation,
} = require(path.join(__dirname, "./corporationRuntimeState"));

function canReadLockedItem(authority, session, locationID, lockedItem) {
  if (!authority) return false;
  if (authority.isCEO || authority.isDirector || corporationAuthorityHasRole(authority, CORP_ROLE_ACCOUNTANT)) return true;
  const item = findItemById(Number(lockedItem && lockedItem.itemID));
  if (!item || Number(item.ownerID) !== Number(authority.corporationID)) return false;
  const queryRole = CORP_HANGAR_QUERY_ROLE_BY_FLAG[Number(item.flagID)];
  const roles = getCorporationRolesAtLocation(session, locationID);
  return Boolean(queryRole && (roles & queryRole) !== 0n);
}

class ItemLockingService extends BaseService {
  constructor() {
    super("itemLocking");
  }

  Handle_GetItemsByLocation(args, session) {
    const authority = getPersistedCorporationAuthority(session);
    const corporationID = authority ? authority.corporationID : 0;
    const locationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    return buildDict(
      getLockedItemsByLocation(corporationID, locationID)
        .filter((item) => canReadLockedItem(authority, session, locationID, item))
        .map((item) => [
        Number(item && item.itemID ? item.itemID : 0),
        buildKeyVal([
          ["itemID", Number(item && item.itemID ? item.itemID : 0)],
          ["typeID", Number(item && item.typeID ? item.typeID : 0)],
          ["ownerID", Number(item && item.ownerID ? item.ownerID : 0)],
          ["locationID", Number(item && item.locationID ? item.locationID : 0)],
        ]),
      ]),
    );
  }

  Handle_GetLockedItemLocations(args, session) {
    const authority = getPersistedCorporationAuthority(session);
    const corporationID = authority ? authority.corporationID : 0;
    return buildPythonSet(getLockedItemLocations(corporationID).filter((locationID) =>
      getLockedItemsByLocation(corporationID, locationID).some((item) =>
        canReadLockedItem(authority, session, locationID, item))));
  }
}

ItemLockingService.canReadLockedItem = function(session, corporationID, locationID, itemID) {
  const authority = getPersistedCorporationAuthority(session);
  return Boolean(authority && Number(authority.corporationID) === Number(corporationID) &&
    canReadLockedItem(authority, session, locationID, { itemID }));
};

module.exports = ItemLockingService;
