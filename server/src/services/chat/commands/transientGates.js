"use strict";
const { handleCommand } = require("../../../space/transientStargates");
const { handledResult } = require("./commandReplies");
function handleTransientGateCommand(session, command, text, chatHub, options) {
  const result = handleCommand(session, command, text);
  return handledResult(chatHub, session, options, result.message);
}
module.exports = { handleTransientGateCommand };
