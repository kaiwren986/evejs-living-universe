"use strict";

const {
  GATEWAY_GRPC_EDGE_COMMAND,
  GATEWAY_GRPC_OWNER_COMMAND,
} = require("./gatewayRuntimeProtocol");

const GATEWAY_GRPC_PATHS = new Set([
  "/eve_public.gateway.Requests/Ping",
  "/eve_public.gateway.Notices/Ping",
  "/eve_public.gateway.Events/Ping",
  "/eve_public.gateway.Requests/Send",
  "/eve_public.gateway.Notices/Consume",
  "/eve_public.gateway.Events/Publish",
]);

function createRemoteGatewayGrpcTransport(options = {}) {
  const requestOwner = options.requestOwner;
  if (typeof requestOwner !== "function") {
    throw new TypeError("remote gateway gRPC transport requires an owner request function");
  }
  const streams = new Map();
  const sessionIDs = new WeakMap();
  let nextStreamID = 1;
  let nextSessionID = 1;
  let stopped = false;

  function sessionIDFor(stream) {
    const session = stream && stream.session;
    if (!session || (typeof session !== "object" && typeof session !== "function")) {
      const fallback = { stream };
      sessionIDs.set(fallback, nextSessionID);
      nextSessionID += 1;
      return nextSessionID - 1;
    }
    let sessionID = sessionIDs.get(session);
    if (!sessionID) {
      sessionID = nextSessionID;
      nextSessionID += 1;
      sessionIDs.set(session, sessionID);
    }
    return sessionID;
  }

  function destroyEntry(entry, error = null, notifyOwner = true) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    streams.delete(entry.streamID);
    if (notifyOwner) {
      void entry.lane.then(() => requestOwner(GATEWAY_GRPC_OWNER_COMMAND.CLOSE, {
        streamID: entry.streamID,
      })).catch(() => null);
    }
    if (error && entry.stream && !entry.stream.destroyed) {
      entry.ownerClosing = true;
      try {
        entry.stream.destroy(error);
      } catch {
        // ignored: the network stream is already gone.
      }
    }
  }

  function enqueue(entry, command, fields = {}) {
    if (entry.closed) return Promise.resolve(null);
    entry.lane = entry.lane.then(() => requestOwner(command, {
      streamID: entry.streamID,
      ...fields,
    }));
    entry.lane.catch((error) => destroyEntry(entry, error, false));
    return entry.lane;
  }

  function handleGatewayStream(stream, headers) {
    const routePath = String(headers && headers[":path"] || "");
    if (stopped || !GATEWAY_GRPC_PATHS.has(routePath)) return false;
    const streamID = nextStreamID;
    nextStreamID += 1;
    const entry = {
      closed: false,
      lane: Promise.resolve(),
      ownerClosing: false,
      stream,
      streamID,
    };
    streams.set(streamID, entry);
    stream.on("data", (chunk) => {
      if (typeof stream.pause === "function") stream.pause();
      void enqueue(entry, GATEWAY_GRPC_OWNER_COMMAND.DATA, {
        chunk: Buffer.from(chunk),
      })
        .finally(() => {
          if (!entry.closed && typeof stream.resume === "function") stream.resume();
        })
        .catch(() => null);
    });
    stream.on("end", () => {
      void enqueue(entry, GATEWAY_GRPC_OWNER_COMMAND.END).catch(() => null);
    });
    stream.on("wantTrailers", () => {
      if (entry.ownerClosing) return;
      void enqueue(
        entry,
        GATEWAY_GRPC_OWNER_COMMAND.WANT_TRAILERS,
      ).catch(() => null);
    });
    stream.on("error", (error) => {
      if (entry.ownerClosing) return;
      void enqueue(entry, GATEWAY_GRPC_OWNER_COMMAND.ERROR, {
        code: String(error && error.code || "GATEWAY_GRPC_EDGE_ERROR"),
        message: String(error && error.message || "edge stream failed"),
      }).catch(() => null);
    });
    stream.on("close", () => {
      if (!entry.ownerClosing) destroyEntry(entry, null, true);
      else destroyEntry(entry, null, false);
    });
    const openRequest = requestOwner(GATEWAY_GRPC_OWNER_COMMAND.OPEN, {
      headers,
      sessionID: sessionIDFor(stream),
      streamID,
    });
    entry.lane = openRequest;
    void openRequest.then((outcome) => {
      if (!outcome || outcome.handled !== true) {
        const error = new Error(`gateway owner did not handle ${routePath}`);
        error.code = "GATEWAY_GRPC_UNHANDLED";
        destroyEntry(entry, error, true);
      }
    }).catch((error) => destroyEntry(entry, error, false));
    return true;
  }

  async function handleCommand(command, payload) {
    const streamID = Number(payload && payload.streamID);
    const entry = streams.get(streamID);
    if (!entry || entry.closed) return { delivered: false, streamID };
    const stream = entry.stream;
    if (command === GATEWAY_GRPC_EDGE_COMMAND.RESPOND) {
      stream.respond(payload.headers || {}, payload.options || {});
      return { delivered: true, streamID };
    }
    if (command === GATEWAY_GRPC_EDGE_COMMAND.WRITE) {
      const delivered = stream.write(Buffer.from(payload.chunk || Buffer.alloc(0)));
      return { delivered: delivered !== false, streamID };
    }
    if (command === GATEWAY_GRPC_EDGE_COMMAND.TRAILERS) {
      stream.sendTrailers(payload.headers || {});
      return { delivered: true, streamID };
    }
    if (command === GATEWAY_GRPC_EDGE_COMMAND.END) {
      entry.ownerClosing = true;
      const trailers = payload && payload.trailers;
      if (trailers && typeof trailers === "object") {
        stream.once("wantTrailers", () => {
          try {
            stream.sendTrailers(trailers);
          } catch {
            // ignored: the peer closed before the terminal trailers were writable.
          }
        });
      }
      stream.end();
      return { delivered: true, streamID };
    }
    if (command === GATEWAY_GRPC_EDGE_COMMAND.DESTROY) {
      entry.ownerClosing = true;
      stream.destroy();
      destroyEntry(entry, null, false);
      return { delivered: true, streamID };
    }
    const error = new Error(`unknown gateway gRPC edge command: ${command}`);
    error.code = "GATEWAY_GRPC_EDGE_COMMAND_UNKNOWN";
    throw error;
  }

  async function shutdown() {
    if (stopped) return;
    stopped = true;
    const pending = [];
    for (const entry of [...streams.values()]) {
      entry.ownerClosing = true;
      try {
        entry.stream.destroy();
      } catch {
        // ignored: continue closing all streams.
      }
      pending.push(entry.lane.then(() => requestOwner(
        GATEWAY_GRPC_OWNER_COMMAND.CLOSE,
        { streamID: entry.streamID },
      )).catch(() => null));
      destroyEntry(entry, null, false);
    }
    await Promise.all(pending);
  }

  return Object.freeze({
    getDiagnostics() {
      return Object.freeze({ activeStreams: streams.size, stopped });
    },
    handleCommand,
    handleGatewayStream,
    shutdown,
  });
}

module.exports = {
  GATEWAY_GRPC_PATHS,
  createRemoteGatewayGrpcTransport,
};
