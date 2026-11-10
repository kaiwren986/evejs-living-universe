"use strict";

const BaseService = require("../baseService");
const log = require("../../utils/logger");
const { buildMarshalReal } = require("../_shared/serviceHelpers");

class DynamicBountyMgrService extends BaseService {
  constructor() {
    super("dynamicBountyMgr");
  }

  Handle_GetOutputForClientSolarSystem(args, session, kwargs) {
    const solarSystemID = (session && session.solarsystemid) || null;
    log.debug(
      `[DynamicBountyMgr] GetOutputForClientSolarSystem called (solarsystemid=${solarSystemID})`,
    );

    const dbs = require("./dynamicBountyRuntime");
    const systemID = Number(session?.solarsystemid2 || session?.solarsystemid || 0);
    const result = dbs.getOutput(systemID);
    return [buildMarshalReal(result.output), result.active];
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
    return [0, 0];
  }
}

module.exports = DynamicBountyMgrService;
