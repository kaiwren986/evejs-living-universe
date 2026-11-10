"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const dynamicResourceState = require(path.join(
  __dirname,
  "./dynamicResourceState",
));

class DynamicResourceCacheMgrService extends BaseService {
  constructor() {
    super("dynamicResourceCacheMgr");
  }

  Handle_GetDynamicResourceSettings() {
    log.debug("[DynamicResourceCacheMgr] GetDynamicResourceSettings");
    return dynamicResourceState.buildSettingsPayload();
  }

  Handle_GetDBSMapData() {
    log.debug("[DynamicResourceCacheMgr] GetDBSMapData");
    return dynamicResourceState.buildDbsMapDataPayload();
  }

  Handle_GetESSAgencyData() {
    log.debug("[DynamicResourceCacheMgr] GetESSAgencyData");
    return dynamicResourceState.buildAgencyDataPayload();
  }

  Handle_GetESSSystemDetails(args) {
    const solarSystemID = dynamicResourceState.getSystemIDFromArgsOrSession(args);
    log.debug(
      `[DynamicResourceCacheMgr] GetESSSystemDetails solarsystemid=${solarSystemID}`,
    );
    return dynamicResourceState.buildEssSystemDetailsPayload(solarSystemID);
  }

  Handle_GetESSReserveBankKeys(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromArgsOrSession(
      args,
      session,
    );
    log.debug(
      `[DynamicResourceCacheMgr] GetESSReserveBankKeys solarsystemid=${solarSystemID}`,
    );
    return dynamicResourceState.buildReserveKeyTypeIDListPayload(solarSystemID);
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
    return { type: "dict", entries: [] };
  }
}

module.exports = DynamicResourceCacheMgrService;
