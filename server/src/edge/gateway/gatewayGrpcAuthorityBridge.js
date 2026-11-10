"use strict";

const { EventEmitter } = require("node:events");

const {
  GATEWAY_GRPC_EDGE_COMMAND,
  GATEWAY_GRPC_OWNER_COMMAND,
} = require("./gatewayRuntimeProtocol");

function positiveID(value, label) {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric > 0) return numeric;
  const error = new Error(`gateway gRPC ${label} is invalid`);
  error.code = "GATEWAY_GRPC_STREAM_INVALID";
  throw error;
}

function createGatewayGrpcAuthorityBridge(options = {}) {
  const handleGatewayStream = options.handleGatewayStream;
  const sendCommand = options.sendCommand;
  if (typeof handleGatewayStream !== "function" || typeof sendCommand !== "function") {
    throw new TypeError(
      "gateway gRPC authority bridge requires a stream handler and edge sender",
    );
  }
  const streams = new Map();
  const transports = new Map();
  let stopped = false;

  function streamKey(generation, streamID) {
    return `${generation}:${streamID}`;
  }

  function transportKey(generation, sessionID) {
    return `${generation}:${sessionID}`;
  }

  function transmit(entry, command, fields = {}) {
    return Promise.resolve().then(() => sendCommand(command, {
      streamID: entry.streamID,
      ...fields,
    }));
  }

  function releaseStream(key, emitClose = true) {
    const entry = streams.get(key);
    if (!entry) return false;
    streams.delete(key);
    entry.stream.closed = true;
    entry.stream.destroyed = true;
    if (emitClose) entry.stream.emit("close");
    const transport = entry.stream.session;
    transport.activeStreams = Math.max(0, transport.activeStreams - 1);
    if (transport.activeStreams === 0) {
      transports.delete(transport.key);
    }
    return true;
  }

  class AuthorityStream extends EventEmitter {
    constructor(entry) {
      super();
      this._entry = entry;
      this.session = entry.transport;
      this.closed = false;
      this.destroyed = false;
      this.writableEnded = false;
      this._waitForTrailers = false;
      this._pendingTrailers = null;
    }

    _send(command, fields) {
      if (this.closed || this.destroyed) return Promise.resolve(null);
      return transmit(this._entry, command, fields).catch((error) => {
        if (!this.destroyed) {
          this.destroyed = true;
          this.emit("error", error);
        }
        return null;
      });
    }

    respond(headers, options) {
      this._waitForTrailers = Boolean(options && options.waitForTrailers);
      void this._send(
        GATEWAY_GRPC_EDGE_COMMAND.RESPOND,
        { headers, options },
      ).catch(() => null);
    }

    write(chunk) {
      if (this.closed || this.destroyed || this.writableEnded) return false;
      void this._send(GATEWAY_GRPC_EDGE_COMMAND.WRITE, {
        chunk: Buffer.from(chunk || Buffer.alloc(0)),
      }).then((outcome) => {
        if (outcome && outcome.delivered === false) {
          releaseStream(this._entry.key);
        }
      }).catch(() => null);
      return true;
    }

    sendTrailers(headers) {
      if (this._waitForTrailers) {
        this._pendingTrailers = headers;
        return;
      }
      void this._send(
        GATEWAY_GRPC_EDGE_COMMAND.TRAILERS,
        { headers },
      ).catch(() => null);
    }

    end(chunk) {
      if (this.closed || this.destroyed || this.writableEnded) return;
      if (chunk !== undefined) this.write(chunk);
      this.writableEnded = true;
      if (this._waitForTrailers) this.emit("wantTrailers");
      void this._send(GATEWAY_GRPC_EDGE_COMMAND.END, {
        trailers: this._pendingTrailers,
      })
        .finally(() => {
          releaseStream(this._entry.key);
        })
        .catch(() => null);
    }
  }

  function getEntry(payload, context) {
    const generation = positiveID(context && context.generation, "generation");
    const streamID = positiveID(payload && payload.streamID, "stream ID");
    return streams.get(streamKey(generation, streamID)) || null;
  }

  async function open(payload, context) {
    if (stopped) {
      const error = new Error("gateway gRPC authority bridge is shutting down");
      error.code = "GATEWAY_GRPC_SHUTTING_DOWN";
      throw error;
    }
    const generation = positiveID(context && context.generation, "generation");
    const streamID = positiveID(payload && payload.streamID, "stream ID");
    const sessionID = positiveID(payload && payload.sessionID, "session ID");
    const key = streamKey(generation, streamID);
    if (streams.has(key)) {
      const error = new Error("gateway gRPC stream is already open");
      error.code = "GATEWAY_GRPC_STREAM_DUPLICATE";
      throw error;
    }
    const sharedTransportKey = transportKey(generation, sessionID);
    let transport = transports.get(sharedTransportKey);
    if (!transport) {
      transport = { activeStreams: 0, generation, key: sharedTransportKey, sessionID };
      transports.set(sharedTransportKey, transport);
    }
    transport.activeStreams += 1;
    const entry = { generation, key, sessionID, streamID, transport, stream: null };
    entry.stream = new AuthorityStream(entry);
    streams.set(key, entry);
    let handled = false;
    try {
      handled = handleGatewayStream(
        entry.stream,
        payload && payload.headers && typeof payload.headers === "object"
          ? payload.headers
          : {},
      ) === true;
    } catch (error) {
      releaseStream(key);
      throw error;
    }
    if (!handled) releaseStream(key);
    return { handled, streamID };
  }

  async function handleRequest(command, payload, context = {}) {
    if (command === GATEWAY_GRPC_OWNER_COMMAND.OPEN) {
      return open(payload, context);
    }
    const entry = getEntry(payload, context);
    if (!entry) return { handled: false };
    if (command === GATEWAY_GRPC_OWNER_COMMAND.DATA) {
      entry.stream.emit("data", Buffer.from(payload.chunk || Buffer.alloc(0)));
      return { handled: true };
    }
    if (command === GATEWAY_GRPC_OWNER_COMMAND.END) {
      entry.stream.emit("end");
      return { handled: true };
    }
    if (command === GATEWAY_GRPC_OWNER_COMMAND.WANT_TRAILERS) {
      entry.stream.emit("wantTrailers");
      return { handled: true };
    }
    if (command === GATEWAY_GRPC_OWNER_COMMAND.ERROR) {
      const error = new Error(String(payload && payload.message || "edge stream failed"));
      error.code = String(payload && payload.code || "GATEWAY_GRPC_EDGE_ERROR");
      entry.stream.emit("error", error);
      return { handled: true };
    }
    if (command === GATEWAY_GRPC_OWNER_COMMAND.CLOSE) {
      return { handled: releaseStream(entry.key) };
    }
    const error = new Error(`unknown gateway gRPC owner command: ${command}`);
    error.code = "GATEWAY_GRPC_OWNER_COMMAND_UNKNOWN";
    throw error;
  }

  function cleanupGeneration(value) {
    const generation = positiveID(value, "generation");
    let closed = 0;
    for (const [key, entry] of [...streams.entries()]) {
      if (entry.generation === generation && releaseStream(key)) closed += 1;
    }
    return closed;
  }

  async function shutdown() {
    if (stopped) return;
    stopped = true;
    const pending = [];
    for (const [key, entry] of [...streams.entries()]) {
      pending.push(transmit(entry, GATEWAY_GRPC_EDGE_COMMAND.DESTROY, {
        code: "GATEWAY_GRPC_SHUTTING_DOWN",
      }).catch(() => null));
      releaseStream(key);
    }
    await Promise.all(pending);
  }

  return Object.freeze({
    cleanupGeneration,
    getDiagnostics() {
      return Object.freeze({
        activeStreams: streams.size,
        activeTransports: transports.size,
        stopped,
      });
    },
    handleRequest,
    shutdown,
  });
}

module.exports = {
  createGatewayGrpcAuthorityBridge,
};
