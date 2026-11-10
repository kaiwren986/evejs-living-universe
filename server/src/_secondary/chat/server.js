"use strict";

const database = require("../../gameStore");
const log = require("../../utils/logger");
const { createChatEdgeRuntime } = require("../../edge/chat/chatEdgeRuntime");
const { handleSocketForEdge } = require("../../services/chat/xmppStubServer");
const { getXmppConnectHost } = require("../../services/chat/xmppConfig");

let runtime = null;
let startRequested = false;
let unregisterShutdownHook = null;

function getRuntime() {
  if (!runtime) {
    runtime = createChatEdgeRuntime({ handleSocket: handleSocketForEdge });
  }
  return runtime;
}

module.exports = {
  enabled: true,
  serviceName: "xmppChatServer",
  exec() {
    const owner = getRuntime();
    if (!unregisterShutdownHook) {
      unregisterShutdownHook = database.registerShutdownHook(
        "chat-edge",
        () => owner.shutdown(),
      );
    }
    if (!startRequested) {
      startRequested = true;
      void owner.start().then((status) => {
        log.debug(
          `xmpp chat edge pid=${status.pid} running on ` +
          `tls://${getXmppConnectHost()}:${status.address.port}`,
        );
      }).catch((error) => {
        log.err(`[ChatEdge] startup failed: ${error.message}`);
      });
    }
    return owner;
  },
  __testing: { getRuntime },
};
