"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  buildDict,
  buildList,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildFacilityPayload,
  buildLocationPayload,
  buildFacilityTaxesPayload,
} = require(path.join(__dirname, "./industryPayloads"));
const {
  getFacilityPayloadByID,
  listFacilitiesForSession,
} = require(path.join(__dirname, "./industryStaticData"));
const {
  getFacilityTaxConfig,
  setFacilityTaxConfig,
} = require(path.join(__dirname, "./industryFacilityState"));
const {
  getBlueprintByItemID,
  resolveFacilityLocations,
} = require(path.join(__dirname, "./industryRuntimeState"));
const {
  INDUSTRY_ACTIVITY,
} = require(path.join(__dirname, "./industryConstants"));
const {
  notifyFacilitiesUpdated,
} = require(path.join(__dirname, "./industryNotifications"));
const {
  resolveSystemCostIndex,
} = require(path.join(__dirname, "./industrySystemCostIndex"));

function toInt(value, fallback = 0) {
  const numeric = Number(unwrapMarshalValue(value));
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

class FacilityManagerService extends BaseService {
  constructor() {
    super("facilityManager");
  }

  Handle_GetFacilities(args, session) {
    return buildList(
      listFacilitiesForSession(session).map((facility) => buildFacilityPayload(facility)),
    );
  }

  Handle_GetFacility(args, session) {
    const facilityID = toInt(args && args.length > 0 ? args[0] : null, 0);
    const facility = getFacilityPayloadByID(facilityID, session);
    // An unknown facility must fail rather than return an empty payload. The
    // client primes the response into facilitySvc.facilities keyed by the
    // returned facilityID, so a zeroed payload lands under key 0 and the very
    // next `self.facilities[facilityID]` raises KeyError. facilitySvc wraps its
    // GetFacility calls in `except UserError`, which is the shape it expects.
    if (!facility) {
      throwWrappedUserError("CustomNotify", {
        notify: "That facility could not be found.",
      });
    }
    return buildFacilityPayload(facility);
  }

  Handle_GetFacilitiesByID(args, session) {
    const facilityIDs = Array.isArray(args && args[0]) ? args[0] : [];
    return buildList(
      facilityIDs
        .map((facilityID) => getFacilityPayloadByID(facilityID, session))
        .filter(Boolean)
        .map((facility) => buildFacilityPayload(facility)),
    );
  }

  // The client scales its system cost index gauges against this
  // (systemCostIndexGauge / facilityEntry -> GetMaxActivityModifier), so it has
  // to carry the same index that applySystemCostIndexModifiers stamps into each
  // facility's SYSTEM cost modifier. Returning only manufacturing left every
  // science and reaction gauge falling back to the client default of 1.0 while
  // the actual modifier is the configured index, so the gauges read near-empty.
  Handle_GetMaxActivityModifiers() {
    return buildDict(
      [
        INDUSTRY_ACTIVITY.MANUFACTURING,
        INDUSTRY_ACTIVITY.RESEARCH_TIME,
        INDUSTRY_ACTIVITY.RESEARCH_MATERIAL,
        INDUSTRY_ACTIVITY.COPYING,
        INDUSTRY_ACTIVITY.INVENTION,
        INDUSTRY_ACTIVITY.REACTION,
      ].map((activityID) => [activityID, resolveSystemCostIndex(0, activityID)]),
    );
  }

  Handle_GetFacilityTaxes(args, session) {
    const facilityID = toInt(args && args.length > 0 ? args[0] : null, 0);
    const facility = getFacilityPayloadByID(facilityID, session);
    return buildFacilityTaxesPayload(getFacilityTaxConfig(facilityID, facility));
  }

  Handle_SetFacilityTaxes(args, session) {
    const facilityID = args && args.length > 0 ? args[0] : null;
    const corporationID = args && args.length > 1 ? args[1] : null;
    // The client submits its named rates as a marshal dict.  Persisting the
    // wrapper made setFacilityTaxConfig look for tax field names on {type,
    // entries}, so an authorized edit quietly saved the defaults instead.
    const taxRateValues = unwrapMarshalValue(args && args.length > 2 ? args[2] : null);
    const facility = getFacilityPayloadByID(facilityID, session);
    setFacilityTaxConfig(session, facility, corporationID, taxRateValues);
    notifyFacilitiesUpdated([toInt(facilityID, 0)]);
    return null;
  }

  Handle_GetFacilityLocations(args, session) {
    const facilityID = args && args.length > 0 ? args[0] : null;
    const ownerID = args && args.length > 1 ? args[1] : null;
    const blueprint = args && args.length > 2 ? getBlueprintByItemID(args[2]) : null;
    return buildList(
      resolveFacilityLocations(
        toInt(facilityID, 0),
        toInt(ownerID, 0),
        blueprint,
        session,
      ).map((location) => buildLocationPayload(location)),
    );
  }
}

module.exports = FacilityManagerService;
