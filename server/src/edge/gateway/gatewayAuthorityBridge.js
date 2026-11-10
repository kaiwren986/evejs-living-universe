"use strict";

const {
  GATEWAY_EDGE_COMMAND,
  GATEWAY_OWNER_COMMAND,
  GATEWAY_RUNTIME_METHODS,
  GATEWAY_SUBSCRIPTION_KIND,
} = require("./gatewayRuntimeProtocol");

const RUNTIME_METHOD_SET = new Set(GATEWAY_RUNTIME_METHODS);

function positiveGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

function normalizeSubscriptionID(value) {
  const subscriptionID = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionID)) {
    const error = new Error("gateway subscription ID is invalid");
    error.code = "GATEWAY_SUBSCRIPTION_INVALID";
    throw error;
  }
  return subscriptionID;
}

function createGatewayAuthorityBridge(options = {}) {
  const gatewayRuntime = options.gatewayRuntime;
  const sendCommand = options.sendCommand;
  if (!gatewayRuntime || typeof gatewayRuntime !== "object") {
    throw new TypeError("gateway authority bridge requires a runtime");
  }
  if (typeof sendCommand !== "function") {
    throw new TypeError("gateway authority bridge requires an edge command sender");
  }
  const subscriptions = new Map();
  let stopped = false;

  function subscriptionKey(generation, subscriptionID) {
    return `${generation}:${subscriptionID}`;
  }

  function transmit(command, payload) {
    return Promise.resolve()
      .then(() => sendCommand(command, payload));
  }

  function closeEntry(key) {
    const entry = subscriptions.get(key);
    if (!entry) return false;
    subscriptions.delete(key);
    if (typeof entry.unsubscribe === "function") {
      try {
        entry.unsubscribe();
      } catch {
        // ignored: the authoritative subscription is already closing.
      }
    }
    return true;
  }

  function deliverFrame(entry, frame) {
    void transmit(GATEWAY_EDGE_COMMAND.FRAME, {
      subscriptionID: entry.subscriptionID,
      frame,
    }).then((outcome) => {
      if (!outcome || outcome.delivered !== true) closeEntry(entry.key);
    }).catch(() => closeEntry(entry.key));
    return true;
  }

  function deliverClose(entry, details) {
    if (!subscriptions.has(entry.key)) return;
    subscriptions.delete(entry.key);
    void transmit(GATEWAY_EDGE_COMMAND.CLOSE, {
      subscriptionID: entry.subscriptionID,
      details: details && typeof details === "object" ? details : {},
    }).catch(() => null);
  }

  async function openSubscription(payload, context) {
    if (stopped) {
      const error = new Error("gateway authority bridge is shutting down");
      error.code = "GATEWAY_AUTHORITY_SHUTTING_DOWN";
      throw error;
    }
    const generation = positiveGeneration(context && context.generation);
    if (!generation) {
      const error = new Error("gateway subscription generation is invalid");
      error.code = "GATEWAY_SUBSCRIPTION_INVALID";
      throw error;
    }
    const subscriptionID = normalizeSubscriptionID(payload && payload.subscriptionID);
    const kind = String(payload && payload.kind || "");
    const args = Array.isArray(payload && payload.args) ? payload.args : [];
    const key = subscriptionKey(generation, subscriptionID);
    if (subscriptions.has(key)) {
      const error = new Error("gateway subscription ID is already active");
      error.code = "GATEWAY_SUBSCRIPTION_DUPLICATE";
      throw error;
    }
    const entry = {
      generation,
      key,
      kind,
      subscriptionID,
      unsubscribe: null,
    };
    subscriptions.set(key, entry);
    const handlers = {
      onFrame: (frame) => deliverFrame(entry, frame),
      onClose: (details) => deliverClose(entry, details),
    };
    try {
      if (kind === GATEWAY_SUBSCRIPTION_KIND.CHARACTER) {
        if (typeof gatewayRuntime.subscribeCharacterEvents !== "function") {
          throw new Error("character gateway subscriptions are unavailable");
        }
        entry.unsubscribe = await gatewayRuntime.subscribeCharacterEvents(
          args[0],
          args[1],
          handlers,
        );
      } else if (kind === GATEWAY_SUBSCRIPTION_KIND.SESSION) {
        if (typeof gatewayRuntime.subscribeSessionEvents !== "function") {
          throw new Error("session gateway subscriptions are unavailable");
        }
        entry.unsubscribe = await gatewayRuntime.subscribeSessionEvents(
          args[0],
          args[1],
          args[2],
          handlers,
        );
      } else {
        const error = new Error(`unknown gateway subscription kind: ${kind}`);
        error.code = "GATEWAY_SUBSCRIPTION_INVALID";
        throw error;
      }
    } catch (error) {
      subscriptions.delete(key);
      throw error;
    }
    if (typeof entry.unsubscribe !== "function") {
      subscriptions.delete(key);
      const error = new Error("gateway subscription did not return a disposer");
      error.code = "GATEWAY_SUBSCRIPTION_INVALID";
      throw error;
    }
    return { kind, subscriptionID };
  }

  async function handleRequest(command, payload, context = {}) {
    if (command === GATEWAY_OWNER_COMMAND.DESCRIBE) {
      return {
        dependencies: {
          ...(gatewayRuntime.dependencies &&
          typeof gatewayRuntime.dependencies === "object"
            ? gatewayRuntime.dependencies
            : {}),
        },
      };
    }
    if (command === GATEWAY_OWNER_COMMAND.CALL) {
      const method = String(payload && payload.method || "").trim();
      if (!RUNTIME_METHOD_SET.has(method) || typeof gatewayRuntime[method] !== "function") {
        const error = new Error(`gateway runtime method is not allowed: ${method}`);
        error.code = "GATEWAY_RUNTIME_METHOD_FORBIDDEN";
        throw error;
      }
      const args = Array.isArray(payload && payload.args) ? payload.args : [];
      return gatewayRuntime[method](...args);
    }
    if (command === GATEWAY_OWNER_COMMAND.SUBSCRIBE) {
      return openSubscription(payload, context);
    }
    if (command === GATEWAY_OWNER_COMMAND.UNSUBSCRIBE) {
      const generation = positiveGeneration(context && context.generation);
      const subscriptionID = normalizeSubscriptionID(payload && payload.subscriptionID);
      return {
        closed: closeEntry(subscriptionKey(generation, subscriptionID)),
        subscriptionID,
      };
    }
    const error = new Error(`unknown gateway owner command: ${command}`);
    error.code = "GATEWAY_OWNER_COMMAND_UNKNOWN";
    throw error;
  }

  function cleanupGeneration(value) {
    const generation = positiveGeneration(value);
    let closed = 0;
    for (const [key, entry] of [...subscriptions.entries()]) {
      if (entry.generation === generation && closeEntry(key)) closed += 1;
    }
    return closed;
  }

  async function shutdown(options = {}) {
    if (stopped) return;
    stopped = true;
    for (const key of [...subscriptions.keys()]) closeEntry(key);
    if (options.shutdownRuntime === true && typeof gatewayRuntime.shutdown === "function") {
      await gatewayRuntime.shutdown();
    }
  }

  return Object.freeze({
    cleanupGeneration,
    getDiagnostics() {
      return Object.freeze({
        activeSubscriptions: subscriptions.size,
        stopped,
      });
    },
    handleRequest,
    shutdown,
  });
}

module.exports = {
  createGatewayAuthorityBridge,
};
