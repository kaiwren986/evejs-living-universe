"use strict";

const config = require("../../../config");
const { handledResult } = require("./commandReplies");
const { RUINED_ELECTRICAL, VOID_SPACE_JUMP_ERROR: E } = require("../../activity/voidReplayAdmission");

const ERRORS = {
  [E.SAFETY_ENGAGED]: "Set your safety to yellow or red before replaying Ruined Electrical.",
  [E.INVALID_SHIP_TYPE]: "Board an eligible exploration or covert ops frigate.",
  [E.PROXIMITY_RESTRICTION]: "Move at least 1,000 km away from nearby structures, gates and traces.",
  [E.SHIP_IS_DOCKED]: "Undock before activating the Ruined Electrical replay.",
  [E.SHIP_IS_INVULNERABLE]: "Wait for your invulnerability timer to end.",
  [E.VOID_SPACE_DISALLOWED]: "You already have a pending or active Void replay.",
};

function handleVoidReplayCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (config.voidReplayEnabled !== true) return reply("Historical Void replay is disabled.");
  if (argumentText) return reply("Use /voidreplay with an Expired Ruined Electrical Filament in your active ship's cargo.");
  const { ITEM_FLAGS, listContainerItems } = require("../../inventory/itemStore");
  const characterID = Number(session?.characterID);
  const shipID = Number(session?._space?.shipID || session?.shipID);
  const { filamentTypeID } = RUINED_ELECTRICAL;
  const key = characterID > 0 && shipID > 0
    ? listContainerItems(characterID, shipID, ITEM_FLAGS.CARGO_HOLD, [filamentTypeID])[0]
    : null;
  if (!key) return reply("Put an Expired Ruined Electrical Filament in your active ship's cargo.");
  return require("../../activity/voidReplayRuntime").startReplay(key.itemID, filamentTypeID, session)
    .then(({ errors }) => {
      if (!errors.length) return reply("Entered the Ruined Electrical replay. Use the Origin Conduit to return.");
      return reply(ERRORS[errors[0][0]] || "The Ruined Electrical replay could not start. Check your ship and current session state.");
    });
}

module.exports = { handleVoidReplayCommand };
