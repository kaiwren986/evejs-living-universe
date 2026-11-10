"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));

function normalizePositiveInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return numericValue;
}

function resolveSessionSolarSystemID(session) {
  return normalizePositiveInteger(
    session &&
      (
        session.solarsystemid2 ||
        session.solarsystemid ||
        session.locationid
      ),
    0,
  );
}

function sendSolarSystemTaleData(session, solarSystemID = null, taleIDs = null) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const targetSystemID =
    normalizePositiveInteger(solarSystemID, 0) ||
    resolveSessionSolarSystemID(session);
  if (!targetSystemID) {
    return false;
  }

  session.sendNotification("OnTaleData", "solarsystemid2", [
    targetSystemID,
    require("../incursion/incursionPresentation").buildSystemTalesDict(targetSystemID, taleIDs),
  ]);
  return true;
}

class TaleMgrService extends BaseService {
  constructor() {
    super("taleMgr");
  }

  // The answer is all a client is told here. A system's own tales are sent a
  // session after its change of solar system (taleSessionNotices.js), as
  // Tranquility sends them: its recorded call of this is followed by none.
  Handle_GetGlobalWorldEventTales(args, session) {
    return buildCachedMethodCallResult([], {
      serviceName: this.name,
      method: "GetGlobalWorldEventTales",
      versionCheck: "15 minutes",
      proxyCache: true,
    });
  }

  GetGlobalWorldEventTales(args = [], session = null) {
    return this.Handle_GetGlobalWorldEventTales(args, session);
  }

  // No tale of any template is active here. The client reads the answer and
  // waits for no notice (taleclient/tale_service.py 119).
  Handle_get_active_tales_by_template() {
    return [];
  }

  get_active_tales_by_template(args, session = null) {
    const templateID = Array.isArray(args) ? args[0] : args;
    return this.Handle_get_active_tales_by_template([templateID], session);
  }
}

TaleMgrService._testing = {
  sendSolarSystemTaleData,
};

module.exports = TaleMgrService;
