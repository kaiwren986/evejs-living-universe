"use strict";

const { EventEmitter } = require("node:events");

const { CHAT_EDGE_COMMAND, CHAT_OWNER_COMMAND } = require("./chatSocketProtocol");

// The chat authority writes through an IPC hop before reaching the TLS socket
// owned by the edge process.  Treating that hop as a synchronous Socket.write
// was tempting, but it meant a burst could create one outstanding authority
// request per XMPP stanza.  A room-roster refresh is especially bad: it is
// naturally N occupants by N recipients.  Keep the proxy's normal Writable
// contract instead: queue bytes locally, expose a meaningful high-water mark,
// and send only a bounded number of writes into the cross-process lane.
const DEFAULT_WRITE_HIGH_WATER_MARK = 64 * 1024;
const DEFAULT_MAX_IN_FLIGHT_WRITES = 8;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function positiveID(value, label) {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  const error = new Error(`chat ${label} is invalid`);
  error.code = "CHAT_SOCKET_INVALID";
  throw error;
}

function createChatSocketAuthorityBridge(options = {}) {
  const handleSocket = options.handleSocket;
  const sendCommand = options.sendCommand;
  if (typeof handleSocket !== "function" || typeof sendCommand !== "function") {
    throw new TypeError("chat socket bridge requires a handler and edge sender");
  }
  const sockets = new Map();
  const writeHighWaterMark = positiveInteger(
    options.writeHighWaterMark,
    DEFAULT_WRITE_HIGH_WATER_MARK,
  );
  const maxInFlightWrites = positiveInteger(
    options.maxInFlightWrites,
    DEFAULT_MAX_IN_FLIGHT_WRITES,
  );
  const readyWriteEntries = [];
  const readyWriteKeys = new Set();
  let bufferedWriteBytes = 0;
  let inFlightWrites = 0;
  let writePumpScheduled = false;
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

  function queueEntryForWrite(entry) {
    if (
      !entry ||
      entry.socket.destroyed ||
      entry.edgeBackpressured ||
      entry.edgeClosed ||
      entry.writeInFlight ||
      entry.endInFlight ||
      (entry.writeQueue.length === 0 && !entry.endRequested) ||
      readyWriteKeys.has(entry.key)
    ) {
      return;
    }
    readyWriteKeys.add(entry.key);
    readyWriteEntries.push(entry);
    scheduleWritePump();
  }

  function emitDrainWhenReady(entry) {
    if (
      !entry ||
      !entry.needsDrain ||
      entry.socket.destroyed ||
      entry.edgeBackpressured ||
      entry.writeInFlight ||
      entry.endInFlight ||
      entry.endRequested ||
      entry.writeQueue.length > 0 ||
      entry.bufferedBytes > 0
    ) {
      return;
    }
    entry.needsDrain = false;
    entry.socket.emit("drain");
  }

  function scheduleWritePump() {
    if (writePumpScheduled || stopped) return;
    writePumpScheduled = true;
    // setImmediate deliberately yields between batches.  If the edge is
    // responding from an in-memory/fake transport immediately, a microtask
    // pump would still monopolize the owner event loop.
    setImmediate(() => {
      writePumpScheduled = false;
      pumpWrites();
    });
  }

  function handleQueuedWriteOutcome(
    entry,
    bytes,
    drainSequenceAtWrite,
    outcome,
  ) {
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    entry.writeInFlight = false;
    entry.bufferedBytes = Math.max(0, entry.bufferedBytes - bytes);
    bufferedWriteBytes = Math.max(0, bufferedWriteBytes - bytes);
    entry.socket.writableLength = entry.bufferedBytes;

    if (sockets.get(entry.key) !== entry || entry.socket.destroyed) {
      scheduleWritePump();
      return;
    }
    if (outcome && outcome.accepted === true) {
      if (outcome.backpressured === true) {
        // The edge's DRAIN notification travels on its own owner-command
        // lane, while this WRITE result is the RPC response.  A drain can
        // therefore arrive first.  Do not resurrect a stale block after that
        // already-observed drain or this socket would wait forever for a
        // second event which the edge will never emit.
        entry.edgeBackpressured =
          entry.edgeDrainSequence === drainSequenceAtWrite;
      }
      if (!entry.edgeBackpressured) queueEntryForWrite(entry);
      emitDrainWhenReady(entry);
      scheduleWritePump();
      return;
    }
    // A closed response races the worker's ordered ERROR/CLOSE owner event.
    // Preserve that terminal reason, but stop sending subsequent queued data.
    if (outcome && outcome.closed === true) {
      entry.edgeClosed = true;
      discardQueuedOutput(entry);
      scheduleWritePump();
      return;
    }
    release(entry.key, "error", Object.assign(
      new Error("chat edge rejected socket output"),
      { code: "CHAT_EDGE_OUTPUT_REJECTED" },
    ));
    scheduleWritePump();
  }

  function handleQueuedWriteFailure(entry, bytes, error) {
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    entry.writeInFlight = false;
    entry.bufferedBytes = Math.max(0, entry.bufferedBytes - bytes);
    bufferedWriteBytes = Math.max(0, bufferedWriteBytes - bytes);
    entry.socket.writableLength = entry.bufferedBytes;
    if (sockets.get(entry.key) === entry && !entry.socket.destroyed) {
      release(entry.key, "error", error);
    }
    scheduleWritePump();
  }

  function handleQueuedEndOutcome(entry) {
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    entry.endInFlight = false;
    entry.endRequested = false;
    entry.endData = null;
    if (sockets.get(entry.key) === entry && !entry.socket.destroyed) {
      release(entry.key);
    }
    scheduleWritePump();
  }

  function handleQueuedEndFailure(entry) {
    // Match net.Socket.end(): the terminal close lifecycle owns the final
    // error/close notification.  The authority proxy must not keep buffered
    // bytes alive merely because the edge did not accept its end command.
    handleQueuedEndOutcome(entry);
  }

  function pumpWrites() {
    while (inFlightWrites < maxInFlightWrites && readyWriteEntries.length > 0) {
      const entry = readyWriteEntries.shift();
      readyWriteKeys.delete(entry.key);
      if (
        sockets.get(entry.key) !== entry ||
        entry.socket.destroyed ||
        entry.edgeBackpressured ||
        entry.edgeClosed ||
        entry.writeInFlight ||
        entry.endInFlight ||
        (entry.writeQueue.length === 0 && !entry.endRequested)
      ) {
        continue;
      }
      if (entry.writeQueue.length > 0) {
        const data = entry.writeQueue.shift();
        const bytes = data.length;
        const drainSequenceAtWrite = entry.edgeDrainSequence;
        entry.writeInFlight = true;
        inFlightWrites += 1;
        void transmit(entry, CHAT_EDGE_COMMAND.WRITE, { data })
          .then((outcome) => handleQueuedWriteOutcome(
            entry,
            bytes,
            drainSequenceAtWrite,
            outcome,
          ))
          .catch((error) => handleQueuedWriteFailure(entry, bytes, error));
        continue;
      }
      // A graceful end is ordered behind all prior writes for this socket.
      // This is important now that those writes may still be waiting in the
      // bounded local queue rather than already being fire-and-forget IPC.
      entry.endInFlight = true;
      inFlightWrites += 1;
      void transmit(entry, CHAT_EDGE_COMMAND.END, {
        ...(entry.endData ? { data: entry.endData } : {}),
      })
        .then(() => handleQueuedEndOutcome(entry))
        .catch(() => handleQueuedEndFailure(entry));
    }
  }

  function discardQueuedOutput(entry) {
    if (!entry) return;
    const queuedBytes = entry.writeQueue.reduce(
      (total, data) => total + data.length,
      0,
    );
    entry.writeQueue.length = 0;
    entry.bufferedBytes = Math.max(0, entry.bufferedBytes - queuedBytes);
    bufferedWriteBytes = Math.max(0, bufferedWriteBytes - queuedBytes);
    entry.socket.writableLength = entry.bufferedBytes;
    entry.endData = null;
    entry.endRequested = false;
    entry.needsDrain = false;
    readyWriteKeys.delete(entry.key);
  }

  function queueWrite(entry, data) {
    if (
      !entry ||
      entry.socket.destroyed ||
      entry.socket.writableEnded ||
      entry.edgeClosed
    ) {
      return false;
    }
    entry.writeQueue.push(data);
    entry.bufferedBytes += data.length;
    bufferedWriteBytes += data.length;
    entry.socket.writableLength = entry.bufferedBytes;
    queueEntryForWrite(entry);
    // The edge lane is shared by every chat socket.  Signal backpressure as
    // soon as its bounded in-flight/ready set is full, not only once one
    // individual recipient crosses 64 KiB.  That lets a roster producer stop
    // at the global IPC capacity instead of filling one small queue per room
    // member before it learns the edge is saturated.
    const globalOutputSaturated =
      inFlightWrites + readyWriteKeys.size >= maxInFlightWrites;
    const writable =
      !entry.edgeBackpressured &&
      !entry.edgeClosed &&
      !globalOutputSaturated &&
      entry.bufferedBytes < writeHighWaterMark;
    if (!writable) entry.needsDrain = true;
    return writable;
  }

  function queueEnd(entry, data) {
    if (entry.endRequested || entry.endInFlight || entry.edgeClosed) return;
    entry.endRequested = true;
    entry.endData = data;
    queueEntryForWrite(entry);
  }

  function release(key, event = "close", eventValue = false) {
    const entry = sockets.get(key);
    if (!entry) return false;
    sockets.delete(key);
    discardQueuedOutput(entry);
    entry.socket.destroyed = true;
    entry.socket.readyState = "closed";
    entry.socket.writableLength = 0;
    entry.socket.writableEnded = true;
    entry.socket.writableFinished = true;
    if (event) entry.socket.emit(event, eventValue);
    return true;
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
      this.writableEnded = false;
      this.writableFinished = false;
    }

    setKeepAlive() { return this; }
    setNoDelay() { return this; }
    setTimeout() { return this; }

    write(data) {
      if (this.destroyed || this.writableEnded) return false;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      return queueWrite(this._entry, buffer);
    }

    end(data) {
      if (this.destroyed || this.writableEnded) return;
      this.writableEnded = true;
      queueEnd(
        this._entry,
        data === undefined
          ? null
          : Buffer.isBuffer(data) ? data : Buffer.from(String(data)),
      );
    }

    destroy(error) {
      if (this.destroyed) return this;
      this._entry.edgeClosed = true;
      discardQueuedOutput(this._entry);
      void transmit(this._entry, CHAT_EDGE_COMMAND.DESTROY, {
        code: String(error && error.code || "CHAT_SOCKET_DESTROYED"),
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
      const error = new Error("chat socket bridge is shutting down");
      error.code = "CHAT_SOCKET_SHUTTING_DOWN";
      throw error;
    }
    const generation = positiveID(context && context.generation, "generation");
    const socketID = positiveID(payload && payload.socketID, "socket ID");
    const key = socketKey(generation, socketID);
    if (sockets.has(key)) {
      const error = new Error("chat socket is already open");
      error.code = "CHAT_SOCKET_DUPLICATE";
      throw error;
    }
    const entry = {
      bufferedBytes: 0,
      edgeBackpressured: false,
      edgeClosed: false,
      edgeDrainSequence: 0,
      endData: null,
      endInFlight: false,
      endRequested: false,
      generation,
      key,
      needsDrain: false,
      socketID,
      socket: null,
      writeInFlight: false,
      writeQueue: [],
    };
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
    if (command === CHAT_OWNER_COMMAND.OPEN) return open(payload, context);
    const entry = getEntry(payload, context);
    if (!entry) return { handled: false };
    if (command === CHAT_OWNER_COMMAND.DATA) {
      entry.socket.emit("data", Buffer.from(payload.data || Buffer.alloc(0)));
      return { handled: true };
    }
    if (command === CHAT_OWNER_COMMAND.DRAIN) {
      entry.edgeDrainSequence += 1;
      entry.edgeBackpressured = false;
      queueEntryForWrite(entry);
      emitDrainWhenReady(entry);
      return { handled: true };
    }
    if (command === CHAT_OWNER_COMMAND.ERROR) {
      const error = new Error(String(payload.message || "chat edge socket failed"));
      error.code = String(payload.code || "CHAT_EDGE_SOCKET_ERROR");
      entry.socket.emit("error", error);
      return { handled: true };
    }
    if (command === CHAT_OWNER_COMMAND.CLOSE) {
      return { handled: release(entry.key, "close", payload.hadError === true) };
    }
    const error = new Error(`unknown chat owner command: ${command}`);
    error.code = "CHAT_OWNER_COMMAND_UNKNOWN";
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
      pending.push(transmit(entry, CHAT_EDGE_COMMAND.DESTROY, {
        code: "CHAT_SOCKET_SHUTTING_DOWN",
      }).catch(() => null));
      release(key);
    }
    await Promise.all(pending);
  }

  return Object.freeze({
    cleanupGeneration,
    getDiagnostics() {
      return Object.freeze({
        activeSockets: sockets.size,
        bufferedWriteBytes,
        inFlightWrites,
        maxInFlightWrites,
        queuedWriteEntries: readyWriteKeys.size,
        stopped,
        writeHighWaterMark,
      });
    },
    handleRequest,
    shutdown,
  });
}

module.exports = {
  createChatSocketAuthorityBridge,
};
