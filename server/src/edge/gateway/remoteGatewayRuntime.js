"use strict";

const {
  GATEWAY_EDGE_COMMAND,
  GATEWAY_OWNER_COMMAND,
  GATEWAY_RUNTIME_METHODS,
  GATEWAY_SUBSCRIPTION_KIND,
} = require("./gatewayRuntimeProtocol");

function createRemoteGatewayRuntime(options = {}) {
  const requestOwner = options.requestOwner;
  if (typeof requestOwner !== "function") {
    throw new TypeError("remote gateway runtime requires an owner request function");
  }
  const dependencies = Object.freeze({
    ...(options.dependencies && typeof options.dependencies === "object"
      ? options.dependencies
      : {}),
  });
  const subscriptions = new Map();
  let nextSubscriptionID = 1;
  let stopped = false;

  function ensureRunning() {
    if (!stopped) return;
    const error = new Error("remote gateway runtime is shutting down");
    error.code = "GATEWAY_EDGE_SHUTTING_DOWN";
    throw error;
  }

  function closeLocal(subscriptionID, details = null) {
    const entry = subscriptions.get(subscriptionID);
    if (!entry) return false;
    subscriptions.delete(subscriptionID);
    if (details && entry.handlers && typeof entry.handlers.onClose === "function") {
      entry.handlers.onClose(details);
    }
    return true;
  }

  async function subscribe(kind, args, handlers = {}) {
    ensureRunning();
    const subscriptionID = `gateway_${process.pid}_${nextSubscriptionID}`;
    nextSubscriptionID += 1;
    subscriptions.set(subscriptionID, { handlers, kind, subscriptionID });
    try {
      await requestOwner(GATEWAY_OWNER_COMMAND.SUBSCRIBE, {
        args,
        kind,
        subscriptionID,
      });
    } catch (error) {
      subscriptions.delete(subscriptionID);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!closeLocal(subscriptionID)) return;
      void requestOwner(GATEWAY_OWNER_COMMAND.UNSUBSCRIBE, {
        subscriptionID,
      }).catch(() => null);
    };
  }

  async function handleCommand(command, payload) {
    const subscriptionID = String(payload && payload.subscriptionID || "");
    const entry = subscriptions.get(subscriptionID);
    if (command === GATEWAY_EDGE_COMMAND.FRAME) {
      if (!entry || !entry.handlers || typeof entry.handlers.onFrame !== "function") {
        return { delivered: false, subscriptionID };
      }
      const delivered = await entry.handlers.onFrame(payload.frame);
      if (delivered === false) subscriptions.delete(subscriptionID);
      return { delivered: delivered !== false, subscriptionID };
    }
    if (command === GATEWAY_EDGE_COMMAND.CLOSE) {
      return {
        closed: closeLocal(subscriptionID, payload && payload.details || {}),
        subscriptionID,
      };
    }
    const error = new Error(`unknown remote gateway command: ${command}`);
    error.code = "GATEWAY_EDGE_COMMAND_UNKNOWN";
    throw error;
  }

  const runtime = {
    dependencies,
    subscribeCharacterEvents(characterID, cursor, handlers) {
      return subscribe(
        GATEWAY_SUBSCRIPTION_KIND.CHARACTER,
        [characterID, cursor],
        handlers,
      );
    },
    subscribeSessionEvents(bridgeSessionID, userid, cursor, handlers) {
      return subscribe(
        GATEWAY_SUBSCRIPTION_KIND.SESSION,
        [bridgeSessionID, userid, cursor],
        handlers,
      );
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      const pending = [];
      for (const subscriptionID of [...subscriptions.keys()]) {
        subscriptions.delete(subscriptionID);
        pending.push(requestOwner(GATEWAY_OWNER_COMMAND.UNSUBSCRIBE, {
          subscriptionID,
        }).catch(() => null));
      }
      await Promise.all(pending);
    },
  };

  for (const method of GATEWAY_RUNTIME_METHODS) {
    runtime[method] = (...args) => {
      ensureRunning();
      return requestOwner(GATEWAY_OWNER_COMMAND.CALL, { args, method });
    };
  }

  return Object.freeze({
    handleCommand,
    runtime: Object.freeze(runtime),
    getDiagnostics() {
      return Object.freeze({
        activeSubscriptions: subscriptions.size,
        stopped,
      });
    },
  });
}

module.exports = {
  createRemoteGatewayRuntime,
};
