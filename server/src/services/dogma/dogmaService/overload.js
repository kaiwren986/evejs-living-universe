"use strict";

// Overloading in the dogma service: turning overheating on and off for one module (Overload,
// StopOverload) or for its whole rack (OverloadRack, StopOverloadRack), through the space
// runtime, and the message a pilot sees when a module cannot be overloaded. These are
// DogmaService methods, moved here as they were; dogmaService.js puts them back on the class
// prototype, so `this` is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(
  __dirname,
  "../../../common/machoErrors",
));
const {
  findItemById,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));
const {
  summarizeModuleItemForLog,
} = require(path.join(__dirname, "./shared"));

module.exports = {
  _throwModuleOverloadUserError(errorMsg = "", moduleItem = null, data = null) {
    const errorData = data && typeof data === "object" ? data : {};
    const moduleName = this._resolveModuleDisplayName(moduleItem);
    switch (String(errorMsg || "").trim()) {
      case "NOT_IN_SPACE":
      case "SHIP_NOT_FOUND":
      case "MODULE_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "MODULE_NOT_ONLINE":
        this._throwCustomNotifyUserError(`${moduleName} is offline.`);
        break;
      case "MODULE_INCAPACITATED":
        this._throwCustomNotifyUserError(`${moduleName} is too damaged to overload.`);
        break;
      case "MODULE_NOT_OVERLOADABLE":
        this._throwCustomNotifyUserError(`${moduleName} cannot be overloaded.`);
        break;
      case "THERMODYNAMICS_SKILL_REQUIRED":
        throwWrappedUserError("DontHaveThermoDynamicsSkill", {
          skillLevel: Math.max(1, Number(errorData.skillLevel) || 1),
        });
        break;
      default:
        this._throwCustomNotifyUserError(
          `Failed to change overload state for ${moduleName}.`,
        );
        break;
    }
  },

  Handle_Overload(args, session) {
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const effectID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const item = findItemById(itemID);
    log.debug(
      `[DogmaIM] Overload(itemID=${itemID}, effectID=${effectID}) ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} inSpace=${Boolean(session && session._space)}`,
    );
    const result = spaceRuntime.overloadModule(session, item, effectID);
    if (!result.success) {
      log.warn(
        `[DogmaIM] Overload rejected itemID=${itemID} effectID=${effectID} error=${result.errorMsg}`,
      );
      this._throwModuleOverloadUserError(result.errorMsg, item, result.data);
    }
    return itemID;
  },

  Handle_OverloadRack(args, session) {
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const item = findItemById(itemID);
    log.debug(
      `[DogmaIM] OverloadRack(itemID=${itemID}) ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} inSpace=${Boolean(session && session._space)}`,
    );
    const result = spaceRuntime.overloadRack(session, item);
    if (!result.success) {
      log.warn(`[DogmaIM] OverloadRack rejected itemID=${itemID} error=${result.errorMsg}`);
      this._throwModuleOverloadUserError(result.errorMsg, item, result.data);
    }
    return result.data && Array.isArray(result.data.moduleIDs)
      ? result.data.moduleIDs
      : [];
  },

  Handle_StopOverload(args, session) {
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const effectID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const item = findItemById(itemID);
    log.debug(
      `[DogmaIM] StopOverload(itemID=${itemID}, effectID=${effectID}) ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} inSpace=${Boolean(session && session._space)}`,
    );
    const result = spaceRuntime.stopOverloadModule(session, item, effectID);
    if (!result.success) {
      log.warn(
        `[DogmaIM] StopOverload rejected itemID=${itemID} effectID=${effectID} error=${result.errorMsg}`,
      );
      this._throwModuleOverloadUserError(result.errorMsg, item, result.data);
    }
    return itemID;
  },

  Handle_StopOverloadRack(args, session) {
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const item = findItemById(itemID);
    log.debug(
      `[DogmaIM] StopOverloadRack(itemID=${itemID}) ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} inSpace=${Boolean(session && session._space)}`,
    );
    const result = spaceRuntime.stopOverloadRack(session, item);
    if (!result.success) {
      log.warn(`[DogmaIM] StopOverloadRack rejected itemID=${itemID} error=${result.errorMsg}`);
      this._throwModuleOverloadUserError(result.errorMsg, item, result.data);
    }
    return result.data && Array.isArray(result.data.moduleIDs)
      ? result.data.moduleIDs
      : [];
  },
};
