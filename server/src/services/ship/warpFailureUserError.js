"use strict";

// The user error a refused warp answers the client with, by the reason the
// space runtime refused it. Every warp command that can be refused raises it.

const path = require("path");

const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));

const CRIMEWATCH_WARP_BLOCKED_MESSAGE = "Warp is disabled while the criminal timer is active.";
const SHIP_IMMOBILE_WARP_BLOCKED_MESSAGE =
  "Your ship cannot warp while an active module is preventing movement.";

function throwWarpFailureUserError(errorMsg = "") {
  switch (String(errorMsg || "").trim()) {
    case "CRIMINAL_TIMER_ACTIVE":
      throwWrappedUserError("CustomInfo", {
        info: CRIMEWATCH_WARP_BLOCKED_MESSAGE,
      });
      break;
    case "WARP_DISRUPTED_BY_BUBBLE":
      throwWrappedUserError("WarpDisrupted");
      break;
    case "WARP_SCRAMBLED":
      throwWrappedUserError("CustomNotify", {
        notify: "You cannot warp because you are warp scrambled.",
      });
      break;
    case "WARP_BLOCKED_BY_CLOAK":
      throwWrappedUserError("CustomNotify", {
        notify: "You cannot warp while cloaked. Deactivate your cloaking device first.",
      });
      break;
    case "SHIP_IMMOBILE":
      throwWrappedUserError("CustomNotify", {
        notify: SHIP_IMMOBILE_WARP_BLOCKED_MESSAGE,
      });
      break;
    case "DUNGEON_INSTANCE_NOT_AUTHORIZED":
      throwWrappedUserError("CustomNotify", {
        notify: "You have not scanned that site down, so you cannot warp to it yet.",
      });
      break;
    case "":
      break;
    default:
      // Every reason spaceRuntime can refuse a warp for used to fall through
      // here, which meant the ship simply did not move and the client was
      // told nothing at all -- the reason went to the server log and nowhere
      // else. A generic message is worse than a specific one and far better
      // than silence.
      throwWrappedUserError("CustomNotify", {
        notify: "You cannot warp there right now.",
      });
      break;
  }
}

module.exports = {
  throwWarpFailureUserError,
};
