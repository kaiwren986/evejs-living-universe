"use strict";

// Chat command replies: the channel a command answers in (named in the call options), sending
// the reply as a system message, and the handled-result shape every command returns.

function getFeedbackChannel(options) {
  if (!options || typeof options !== "object") {
    return null;
  }

  const candidate =
    options.feedbackChannel || options.channelID || options.channelName || null;
  if (typeof candidate !== "string") {
    return null;
  }

  const trimmed = candidate.trim();
  return trimmed || null;
}

function emitChatFeedback(chatHub, session, options, message) {
  if (!message) {
    return;
  }

  if (
    chatHub &&
    session &&
    (!options || options.emitChatFeedback !== false)
  ) {
    chatHub.sendSystemMessage(session, message, getFeedbackChannel(options));
  }
}

function handledResult(chatHub, session, options, message) {
  emitChatFeedback(chatHub, session, options, message);
  return {
    handled: true,
    message,
  };
}

module.exports = {
  getFeedbackChannel,
  emitChatFeedback,
  handledResult,
};
