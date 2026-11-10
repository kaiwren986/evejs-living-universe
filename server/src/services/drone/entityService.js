"use strict";

const path = require("path");
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  commandAssist,
  commandGuard,
  commandEngage,
  commandMineRepeatedly,
  commandSalvage,
  commandAbandonDrone,
  commandReconnectToDrones,
  commandReturnBay,
  commandReturnHome,
} = require(path.join(__dirname, "./droneRuntime"));

class EntityService extends BaseService {
  constructor() {
    super("entity");
  }

  Handle_MachoResolveObject() {
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session) {
    const config = require(path.join(__dirname, "../../config"));
    const nestedCall = args && args.length > 1 ? args[1] : null;
    const boundId = config.getNextBoundId();
    const idString = `N=${PROXY_NODE_ID}:${boundId}`;
    const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
    const oid = [idString, now];

    if (session) {
      if (!session._boundObjectIDs || typeof session._boundObjectIDs !== "object") {
        session._boundObjectIDs = {};
      }
      session._boundObjectIDs.entity = idString;
      session.lastBoundObjectID = idString;
    }

    let callResult = null;
    if (Array.isArray(nestedCall) && nestedCall.length > 0) {
      const methodName =
        typeof nestedCall[0] === "string"
          ? nestedCall[0]
          : Buffer.isBuffer(nestedCall[0])
            ? nestedCall[0].toString("utf8")
            : String(nestedCall[0]);
      const callArgs = nestedCall.length > 1 ? nestedCall[1] : [];
      const callKwargs = nestedCall.length > 2 ? nestedCall[2] : null;
      callResult = this.callMethod(
        methodName,
        Array.isArray(callArgs) ? callArgs : [callArgs],
        session,
        callKwargs,
      );
    }

    return [
      {
        type: "substruct",
        value: { type: "substream", value: oid },
      },
      callResult != null ? callResult : null,
    ];
  }

  Handle_CmdReturnHome(args, session) {
    return commandReturnHome(session, args && args[0]);
  }

  Handle_CmdEngage(args, session) {
    return commandEngage(session, args && args[0], args && args[1]);
  }

  // ⚠ THE ARGUMENTS ARE THE OTHER WAY ROUND FROM EVERY SIBLING HERE. CmdEngage,
  // CmdSalvage and CmdMineRepeatedly are (droneIDs, targetID); CmdAssist and
  // CmdGuard are (charID, droneIDs), because their subject is a PILOT rather
  // than a ball. That is the retail wire — see menuSvcExtras/droneFunctions.py.
  Handle_CmdAssist(args, session) {
    return commandAssist(session, args && args[0], args && args[1]);
  }

  Handle_CmdGuard(args, session) {
    return commandGuard(session, args && args[0], args && args[1]);
  }

  Handle_CmdMineRepeatedly(args, session) {
    return commandMineRepeatedly(session, args && args[0], args && args[1]);
  }

  Handle_CmdSalvage(args, session) {
    return commandSalvage(session, args && args[0], args && args[1]);
  }

  Handle_CmdReturnBay(args, session) {
    return commandReturnBay(session, args && args[0]);
  }

  Handle_CmdAbandonDrone(args, session) {
    return commandAbandonDrone(session, args && args[0]);
  }

  Handle_CmdReconnectToDrones(args, session) {
    return commandReconnectToDrones(session, args && args[0]);
  }

}

module.exports = EntityService;
