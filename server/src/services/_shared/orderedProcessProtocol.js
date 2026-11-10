"use strict";

const PROTOCOL = "evejs-ordered-process-v1";

const MESSAGE_KIND = Object.freeze({
  BOOTSTRAP: "bootstrap",
  READY: "ready",
  REQUEST: "request",
  STARTED: "started",
  RESPONSE: "response",
  EVENT: "event",
  SHUTDOWN: "shutdown",
  CLOSED: "closed",
});

function serializeError(error, fallbackCode = "AUTHORITY_COMMAND_FAILED") {
  return {
    name: String(error && error.name || "Error"),
    message: String(error && error.message || "Authority command failed"),
    code: String(error && error.code || fallbackCode),
    stack: typeof (error && error.stack) === "string" ? error.stack : null,
  };
}

function deserializeError(value, fallbackCode = "AUTHORITY_COMMAND_FAILED") {
  const error = new Error(String(value && value.message || "Authority command failed"));
  error.name = String(value && value.name || "Error");
  error.code = String(value && value.code || fallbackCode);
  if (value && typeof value.stack === "string") {
    error.remoteStack = value.stack;
  }
  return error;
}

function isProtocolMessage(message, kind = null) {
  return Boolean(
    message &&
    typeof message === "object" &&
    message.protocol === PROTOCOL &&
    (!kind || message.kind === kind),
  );
}

function buildMessage(kind, fields = {}) {
  return {
    protocol: PROTOCOL,
    kind,
    ...fields,
  };
}

module.exports = {
  MESSAGE_KIND,
  PROTOCOL,
  buildMessage,
  deserializeError,
  isProtocolMessage,
  serializeError,
};
