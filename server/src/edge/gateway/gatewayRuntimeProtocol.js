"use strict";

const GATEWAY_OWNER_COMMAND = Object.freeze({
  CALL: "gateway.runtime.call",
  DESCRIBE: "gateway.runtime.describe",
  SUBSCRIBE: "gateway.subscription.open",
  UNSUBSCRIBE: "gateway.subscription.close",
});

const GATEWAY_EDGE_COMMAND = Object.freeze({
  FRAME: "gateway.subscription.frame",
  CLOSE: "gateway.subscription.closed",
});

const GATEWAY_GRPC_OWNER_COMMAND = Object.freeze({
  OPEN: "gateway.grpc.open",
  DATA: "gateway.grpc.data",
  END: "gateway.grpc.end",
  CLOSE: "gateway.grpc.close",
  ERROR: "gateway.grpc.error",
  WANT_TRAILERS: "gateway.grpc.want-trailers",
});

const GATEWAY_GRPC_EDGE_COMMAND = Object.freeze({
  RESPOND: "gateway.grpc.respond",
  WRITE: "gateway.grpc.write",
  TRAILERS: "gateway.grpc.trailers",
  END: "gateway.grpc.finish",
  DESTROY: "gateway.grpc.destroy",
});

const GATEWAY_RUNTIME_METHODS = Object.freeze([
  "getStatus",
  "listAccounts",
  "getAccountByUsername",
  "getAccountByID",
  "createAccount",
  "listCharacters",
  "getCharacter",
  "buildSnapshot",
  "buildSkillSheet",
  "isCharacterOnline",
  "getCharacterControlStatus",
  "claimBrowserControl",
  "renewBrowserControl",
  "releaseBrowserControl",
  "submitSkillQueueSaveCommand",
  "submitPiRestartExtractorsCommand",
  "getCharacterEventDiagnostics",
  "getSessionEventDiagnostics",
  "getStationAsks",
  "callServiceMethod",
  "selectCharacter",
  "releaseBrowserSession",
  "bindBoundObject",
  "callBoundMethod",
  "readFlightStatus",
  "readScannerState",
  "readSpaceSnapshot",
  "authorizeSessionEvents",
]);

const GATEWAY_SUBSCRIPTION_KIND = Object.freeze({
  CHARACTER: "character",
  SESSION: "session",
});

module.exports = {
  GATEWAY_EDGE_COMMAND,
  GATEWAY_GRPC_EDGE_COMMAND,
  GATEWAY_GRPC_OWNER_COMMAND,
  GATEWAY_OWNER_COMMAND,
  GATEWAY_RUNTIME_METHODS,
  GATEWAY_SUBSCRIPTION_KIND,
};
