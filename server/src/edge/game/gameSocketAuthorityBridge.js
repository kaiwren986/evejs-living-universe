"use strict";

const { EventEmitter } = require("node:events");

const { GAME_EDGE_COMMAND, GAME_OWNER_COMMAND } = require("./gameSocketProtocol");

function positiveID(value, label) {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  const error = new Error(`game ${label} is invalid`);
  error.code = "GAME_SOCKET_INVALID";
  throw error;
}

function createGameSocketAuthorityBridge(options = {}) {
  const handleSocket = options.handleSocket;
  const sendCommand = options.sendCommand;
  if (typeof handleSocket !== "function" || typeof sendCommand !== "function") {
    throw new TypeError("game socket bridge requires a handler and edge sender");
  }
  const sockets = new Map();
  let stopped = false;

  function socketKey(generation, socketID) {
    return `${generation}:${socketID}`;
  }

  function transmit(entry, command, fields = {}) {
    return Promise.resolve().then(() => sendCommand(command, {
      socketID: entry.socketID,
      ...fields,
    }));
  }

  function release(key, event = "close", eventValue = false) {
    const entry = sockets.get(key);
    if (!entry) return false;
    sockets.delete(key);
    entry.socket.destroyed = true;
    entry.socket.readyState = "closed";
    if (event) entry.socket.emit(event, eventValue);
    return true;
  }

  function handleWriteOutcome(entry, outcome, message, code) {
    if (outcome && outcome.accepted === true) return;
    // A closed response races the worker's already ordered ERROR/CLOSE owner
    // event. Let that event carry the real terminal reason instead of
    // manufacturing a rejection from an ordinary close.
    if (outcome && outcome.closed === true) return;
    release(entry.key, "error", Object.assign(new Error(message), { code }));
  }

  class AuthoritySocket extends EventEmitter {
    constructor(entry, payload) {
      super();
      this._entry = entry;
      this.destroyed = false;
      this.readyState = "open";
      this.remoteAddress = String(payload.remoteAddress || "unknown");
      this.remotePort = Number(payload.remotePort) || 0;
      this.localAddress = String(payload.localAddress || "");
      this.localPort = Number(payload.localPort) || 0;
      this.writableLength = 0;
      this.offloadAllMarshal = true;
      this._frameHandler = null;
      this._transportEncrypted = false;
      this._transportReady = false;
    }

    setKeepAlive() { return this; }
    setNoDelay() { return this; }
    setTimeout() { return this; }

    setFrameHandler(handler) {
      if (typeof handler !== "function") {
        throw new TypeError("game frame handler must be a function");
      }
      this._frameHandler = handler;
      return this;
    }

    receiveFrame(payload) {
      if (this.destroyed || !this._frameHandler) return Promise.resolve(false);
      return Promise.resolve(this._frameHandler(payload)).then(() => true);
    }

    async activateTransportCrypto(options = {}) {
      if (this.destroyed) {
        const error = new Error("game socket is closed");
        error.code = "GAME_SOCKET_CLOSED";
        throw error;
      }
      const encrypted = options.encrypted === true;
      const outcome = await transmit(
        this._entry,
        GAME_EDGE_COMMAND.ACTIVATE_TRANSPORT,
        {
          encrypted,
          sessionIV: encrypted ? Buffer.from(options.sessionIV || []) : null,
          sessionKey: encrypted ? Buffer.from(options.sessionKey || []) : null,
        },
      );
      if (!outcome || outcome.accepted !== true) {
        const error = new Error("game edge rejected transport activation");
        error.code = "GAME_TRANSPORT_ACTIVATION_REJECTED";
        throw error;
      }
      this._transportEncrypted = encrypted;
      this._transportReady = true;
      return outcome;
    }

    writePayload(data) {
      if (this.destroyed || !this._transportReady) return null;
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const bodyBytes = this._transportEncrypted
        ? Math.ceil((payload.length + 1) / 16) * 16
        : payload.length;
      void transmit(this._entry, GAME_EDGE_COMMAND.WRITE_PAYLOAD, {
        data: payload,
      }).then((outcome) => {
        handleWriteOutcome(
          this._entry,
          outcome,
          "game edge rejected transport payload",
          "GAME_EDGE_PAYLOAD_REJECTED",
        );
      }).catch((error) => release(this._entry.key, "error", error));
      return {
        bodyBytes,
        framedBytes: bodyBytes + 4,
        writeAccepted: true,
      };
    }

    write(data) {
      if (this.destroyed) return false;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      void transmit(this._entry, GAME_EDGE_COMMAND.WRITE, { data: buffer })
        .then((outcome) => {
          handleWriteOutcome(
            this._entry,
            outcome,
            "game edge rejected socket output",
            "GAME_EDGE_OUTPUT_REJECTED",
          );
        })
        .catch((error) => release(this._entry.key, "error", error));
      return true;
    }

    end(data) {
      if (this.destroyed) return;
      const fields = data === undefined
        ? {}
        : { data: Buffer.isBuffer(data) ? data : Buffer.from(data) };
      void transmit(this._entry, GAME_EDGE_COMMAND.END, fields)
        .finally(() => release(this._entry.key))
        .catch(() => null);
    }

    destroy(error) {
      if (this.destroyed) return this;
      void transmit(this._entry, GAME_EDGE_COMMAND.DESTROY, {
        code: String(error && error.code || "GAME_SOCKET_DESTROYED"),
      })
        .finally(() => release(this._entry.key))
        .catch(() => null);
      return this;
    }
  }

  function getEntry(payload, context) {
    const generation = positiveID(context && context.generation, "generation");
    const socketID = positiveID(payload && payload.socketID, "socket ID");
    return sockets.get(socketKey(generation, socketID)) || null;
  }

  function open(payload, context) {
    if (stopped) {
      const error = new Error("game socket bridge is shutting down");
      error.code = "GAME_SOCKET_SHUTTING_DOWN";
      throw error;
    }
    const generation = positiveID(context && context.generation, "generation");
    const socketID = positiveID(payload && payload.socketID, "socket ID");
    const key = socketKey(generation, socketID);
    if (sockets.has(key)) {
      const error = new Error("game socket is already open");
      error.code = "GAME_SOCKET_DUPLICATE";
      throw error;
    }
    const entry = { generation, key, socketID, socket: null };
    entry.socket = new AuthoritySocket(entry, payload || {});
    sockets.set(key, entry);
    try {
      handleSocket(entry.socket);
    } catch (error) {
      release(key, null);
      throw error;
    }
    return { opened: true, socketID };
  }

  async function handleRequest(command, payload, context = {}) {
    if (command === GAME_OWNER_COMMAND.OPEN) return open(payload, context);
    const entry = getEntry(payload, context);
    if (!entry) return { handled: false };
    if (command === GAME_OWNER_COMMAND.FRAME) {
      const handled = await entry.socket.receiveFrame(
        Buffer.from(payload.payload || Buffer.alloc(0)),
      );
      return { handled };
    }
    if (command === GAME_OWNER_COMMAND.DRAIN) {
      entry.socket.emit("drain");
      return { handled: true };
    }
    if (command === GAME_OWNER_COMMAND.ERROR) {
      const error = new Error(String(payload.message || "game edge socket failed"));
      error.code = String(payload.code || "GAME_EDGE_SOCKET_ERROR");
      entry.socket.emit("error", error);
      return { handled: true };
    }
    if (command === GAME_OWNER_COMMAND.CLOSE) {
      return { handled: release(entry.key, "close", payload.hadError === true) };
    }
    const error = new Error(`unknown game owner command: ${command}`);
    error.code = "GAME_OWNER_COMMAND_UNKNOWN";
    throw error;
  }

  function cleanupGeneration(value) {
    const generation = positiveID(value, "generation");
    let closed = 0;
    for (const [key, entry] of [...sockets.entries()]) {
      if (entry.generation === generation && release(key)) closed += 1;
    }
    return closed;
  }

  async function shutdown() {
    if (stopped) return;
    stopped = true;
    const pending = [];
    for (const [key, entry] of [...sockets.entries()]) {
      pending.push(transmit(entry, GAME_EDGE_COMMAND.DESTROY, {
        code: "GAME_SOCKET_SHUTTING_DOWN",
      }).catch(() => null));
      release(key);
    }
    await Promise.all(pending);
  }

  return Object.freeze({
    cleanupGeneration,
    getDiagnostics() {
      return Object.freeze({ activeSockets: sockets.size, stopped });
    },
    handleRequest,
    shutdown,
  });
}

module.exports = {
  createGameSocketAuthorityBridge,
};
