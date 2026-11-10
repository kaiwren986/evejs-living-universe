"use strict";

// GM control over a declared war's timers. A declared war fights only after its
// 24 hour spool-up (evewar/const.py WAR_SPOOLUP_HOURS); the client has no GM
// control for it, and reads the war's times from the war rows and
// OnWarChanged, so moving timeStarted on the server is what it follows.
//   /war start <warID>   the war is fighting-legal from now

const path = require("path");

const { currentFileTime } = require(path.join(__dirname, "../_shared/serviceHelpers"));
const warRuntimeState = require(path.join(__dirname, "./warRuntimeState"));

const USAGE = "Usage: /war start <warID>";

function executeWarGmCommand(session, argumentText) {
  const [subcommandRaw, warToken] = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  if (String(subcommandRaw || "").toLowerCase() !== "start") {
    return { success: false, message: USAGE };
  }
  const warID = Number(warToken);
  const war = Number.isInteger(warID) && warID > 0 ? warRuntimeState.getWarRecord(warID) : null;
  if (!war) {
    return { success: false, message: `War not found. ${USAGE}` };
  }
  if (war.timeFinished) {
    return { success: false, message: `War ${warID} has finished.` };
  }
  const now = currentFileTime();
  if (BigInt(String(war.timeStarted || 0)) <= now) {
    return { success: true, message: `War ${warID} is already fighting-legal.` };
  }
  warRuntimeState.updateWarRecord(warID, (current) => ({
    ...current,
    timeStarted: now.toString(),
  }));
  // Sends the defender's and attacker's "war is now fighting legal" notices.
  warRuntimeState.processWarLifecycle({ nowFiletime: now });
  return { success: true, message: `GM started war ${warID}: fighting-legal from now.` };
}

module.exports = {
  executeWarGmCommand,
};
