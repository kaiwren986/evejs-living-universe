"use strict";
const { handleCommand } = require("../../../space/FireShow/fireShowRuntime");
const { handledResult } = require("./commandReplies");

function handleFireShowCommand(session, argumentText, chatHub, options) {
  const result = handleCommand(session, argumentText);
  return handledResult(chatHub, session, options, result.message);
}

module.exports = { handleFireShowCommand };
