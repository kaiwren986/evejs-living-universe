"use strict";

const BaseService = require("../baseService");
const log = require("../../utils/logger");
const {
  buildList,
} = require("../_shared/serviceHelpers");
const {
  throwWrappedUserError,
} = require("../../common/machoErrors");
const {
  getInfrastructureHubClaim,
  getSystemSovClaim,
  listSovStructuresForSystem,
} = require("../sovereignty/sovState");
const {
  requireStructureManagementSession,
} = require("../sovereignty/sovPlayerDeployment");
const {
  acquireSkyhooks,
  destroySkyhooks,
  getActiveCharacterIdentity,
  getFuelAccessGroupID,
  getSkyhook,
  isOnLocalFuelAccessGroup,
  setFuelAccessGroupID,
} = require("../sovereignty/sovModernState");
const {
  buildSovClaimInfoPayload,
  buildSovHubInfoPayload,
  buildSovStructuresPayload,
} = require("../sovereignty/sovPayloads");

function requireFuelAccessGroupManagement(solarSystemID, session) {
  const claim = getInfrastructureHubClaim(solarSystemID);
  if (!claim) {
    throwWrappedUserError("CustomNotify", {
      notify: "That solar system does not have a claimed Sovereignty Hub.",
    });
  }

  // Fuel access is Hub configuration. Apply the same corporation-owner and
  // management-role gate used by the surrounding player Hub lifecycle before
  // mutating the system-level setting.
  requireStructureManagementSession(session, {
    ownerCorpID: Number(claim.corporationID) || 0,
  });
}

function getRequestedSkyhookIDs(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .map((entry) => Number(entry) || 0)
    .filter((entry) => entry > 0))];
}

function requireSkyhookManagement(skyhookIDs, session) {
  const characterID = Number(
    session && (session.characterID || session.charID || session.charid),
  ) || 0;
  const identity = getActiveCharacterIdentity(characterID);
  for (const skyhookID of skyhookIDs) {
    const result = getSkyhook(skyhookID, identity);
    if (!result.ok || !result.skyhook) {
      throwWrappedUserError("CustomNotify", {
        notify: "You do not have permission to manage that Orbital Skyhook.",
      });
    }
    requireFuelAccessGroupManagement(result.skyhook.solarSystemID, session);
  }
}

class SovMgrService extends BaseService {
  constructor() {
    super("sovMgr");
  }

  Handle_GetSovStructuresInfoForLocalSolarSystem(args, session) {
    const solarSystemID =
      Number(session && (session.solarsystemid2 || session.solarsystemid)) || 0;
    log.debug(
      `[SovMgr] GetSovStructuresInfoForLocalSolarSystem called (solarsystemid=${solarSystemID})`,
    );

    // solar4.txt shows the client iterates this result directly in the
    // inflight info panel. Returning None crashes with:
    //   TypeError: 'NoneType' object is not iterable
    // An empty list is the safe no-structures contract.
    return buildSovStructuresPayload(listSovStructuresForSystem(solarSystemID));
  }

  Handle_GetSovStructuresInfoForSolarSystem(args, session) {
    const solarSystemID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    log.debug(
      `[SovMgr] GetSovStructuresInfoForSolarSystem called (solarsystemid=${solarSystemID})`,
    );
    return buildSovStructuresPayload(listSovStructuresForSystem(solarSystemID));
  }

  Handle_GetSystemSovereigntyInfo(args, session) {
    const solarSystemID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    return buildSovClaimInfoPayload(getSystemSovClaim(solarSystemID));
  }

  Handle_GetInfrastructureHubInfo(args, session) {
    const solarSystemID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    return buildSovHubInfoPayload(getInfrastructureHubClaim(solarSystemID));
  }

  Handle_GetSovHubFuelAccessGroup(args, session) {
    const solarSystemID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    return getFuelAccessGroupID(solarSystemID);
  }

  Handle_SetSovHubFuelAccessGroup(args, session) {
    const solarSystemID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    const fuelAccessGroupID = Number(args && args.length > 1 ? args[1] : 0) || null;
    requireFuelAccessGroupManagement(solarSystemID, session);
    return setFuelAccessGroupID(solarSystemID, fuelAccessGroupID);
  }

  Handle_IsOnLocalSovHubFuelAccessGroup(args, session) {
    return isOnLocalFuelAccessGroup(session);
  }

  Handle_DestroySkyhooks(args, session) {
    const skyhookIDs = getRequestedSkyhookIDs(args && args[0]);
    requireSkyhookManagement(skyhookIDs, session);
    return buildList(destroySkyhooks(skyhookIDs));
  }

  Handle_AcquireSkyhooks(args, session) {
    const skyhookIDs = getRequestedSkyhookIDs(args && args[0]);
    requireSkyhookManagement(skyhookIDs, session);
    return buildList(acquireSkyhooks(skyhookIDs, args && args[1], session));
  }

  callMethod(method, args, session, kwargs) {
    const normalizedMethod = BaseService.normalizeMethodName(method);
    const hasHandler =
      typeof this[`Handle_${normalizedMethod}`] === "function" ||
      typeof this[normalizedMethod] === "function";
    const response = super.callMethod(method, args, session, kwargs);
    if (hasHandler) {
      return response;
    }
    return { type: "list", items: [] };
  }
}

module.exports = SovMgrService;
