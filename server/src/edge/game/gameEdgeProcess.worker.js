"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "reader";

const crypto = require("node:crypto");
const net = require("node:net");

const {
  installProcessLifecycleLogging,
} = require("../../utils/processLifecycle");

installProcessLifecycleLogging({
  appName: "eve.js game edge",
  signals: [],
});

const config = require("../../config");
const log = require("../../utils/logger");
const { configureGameClientSocket } = require("../../network/tcp/socketTuning");
const { createEdgeProcessHost } = require("../edgeProcessHost");
const { AUTHORITY_NAME } = require("./gameEdgeRuntime");
const {
  GAME_EDGE_COMMAND,
  GAME_OWNER_COMMAND,
  MAX_GAME_PAYLOAD_LENGTH,
} = require("./gameSocketProtocol");
const { isSocketWritable, writeSocket } = require("./gameSocketWrite");

const hostName = String(process.env.EVEJS_GAME_EDGE_HOST || "127.0.0.1").trim();
const configuredPort = Number(process.env.EVEJS_GAME_EDGE_PORT);
const port = Number.isInteger(configuredPort) &&
  configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : 26_000;
let server = null;
let address = null;
let requestOwner = null;
let nextSocketID = 1;
const sockets = new Map();

function destroyEntry(entry, error = null, notifyOwner = true) {
  if (!entry || entry.closed) return;
  entry.closed = true;
  sockets.delete(entry.socketID);
  if (notifyOwner) {
    void entry.lane.then(() => requestOwner(GAME_OWNER_COMMAND.CLOSE, {
      hadError: Boolean(error),
      socketID: entry.socketID,
    })).catch(() => null);
  }
  if (error && !entry.socket.destroyed) {
    entry.ownerClosing = true;
    entry.socket.destroy(error);
  }
}

function enqueue(entry, command, fields = {}) {
  if (entry.closed) return Promise.resolve(null);
  entry.lane = entry.lane.then(() => requestOwner(command, {
    socketID: entry.socketID,
    ...fields,
  }));
  entry.lane.catch((error) => destroyEntry(entry, error, false));
  return entry.lane;
}

function decryptTransportPayload(entry, payload) {
  const transport = entry.transport;
  if (!transport || transport.encrypted !== true) return payload;
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    transport.sessionKey,
    transport.sessionIV,
  );
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([
    decipher.update(payload),
    decipher.final(),
  ]);
  transport.sessionIV = Buffer.from(payload.subarray(-16));
  return decrypted;
}

function frameTransportPayload(entry, payload) {
  const transport = entry.transport;
  if (!transport) {
    const error = new Error("game transport is not active");
    error.code = "GAME_TRANSPORT_NOT_ACTIVE";
    throw error;
  }
  let body = payload;
  if (transport.encrypted === true) {
    const cipher = crypto.createCipheriv(
      "aes-256-cbc",
      transport.sessionKey,
      transport.sessionIV,
    );
    cipher.setAutoPadding(true);
    body = Buffer.concat([cipher.update(payload), cipher.final()]);
    transport.sessionIV = Buffer.from(body.subarray(-16));
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function activateTransport(entry, payload) {
  if (entry.transport) {
    const error = new Error("game transport is already active");
    error.code = "GAME_TRANSPORT_ALREADY_ACTIVE";
    throw error;
  }
  const encrypted = payload && payload.encrypted === true;
  const sessionKey = encrypted ? Buffer.from(payload.sessionKey || []) : null;
  const sessionIV = encrypted ? Buffer.from(payload.sessionIV || []) : null;
  if (encrypted && (sessionKey.length !== 32 || sessionIV.length !== 16)) {
    const error = new Error("game transport key or IV is invalid");
    error.code = "GAME_TRANSPORT_CRYPTO_INVALID";
    throw error;
  }
  entry.transport = { encrypted, sessionIV, sessionKey };
  return { accepted: true, encrypted, socketID: entry.socketID };
}

function handleSocket(socket) {
  configureGameClientSocket(socket, config, log);
  const socketID = nextSocketID;
  nextSocketID += 1;
  const entry = {
    closed: false,
    lane: Promise.resolve(),
    ownerClosing: false,
    socket,
    socketID,
    tcpBuffer: Buffer.alloc(0),
    transport: null,
  };
  sockets.set(socketID, entry);
  const openRequest = requestOwner(GAME_OWNER_COMMAND.OPEN, {
    localAddress: socket.localAddress,
    localPort: socket.localPort,
    remoteAddress: socket.remoteAddress,
    remotePort: socket.remotePort,
    socketID,
  });
  entry.lane = openRequest;
  void openRequest.catch((error) => destroyEntry(entry, error, false));

  socket.on("data", (chunk) => {
    socket.pause();
    entry.tcpBuffer = Buffer.concat([entry.tcpBuffer, chunk]);
    let pending = entry.lane;
    while (!entry.closed && entry.tcpBuffer.length >= 4) {
      const payloadLength = entry.tcpBuffer.readUInt32LE(0);
      if (payloadLength <= 0 || payloadLength > MAX_GAME_PAYLOAD_LENGTH) {
        const error = new Error(`invalid game payload length: ${payloadLength}`);
        error.code = "GAME_FRAME_LENGTH_INVALID";
        destroyEntry(entry, error, true);
        return;
      }
      const totalLength = 4 + payloadLength;
      if (entry.tcpBuffer.length < totalLength) break;
      const wirePayload = Buffer.from(entry.tcpBuffer.subarray(4, totalLength));
      entry.tcpBuffer = entry.tcpBuffer.subarray(totalLength);
      let payload;
      try {
        payload = decryptTransportPayload(entry, wirePayload);
      } catch (error) {
        error.code = error.code || "GAME_TRANSPORT_DECRYPT_FAILED";
        destroyEntry(entry, error, true);
        return;
      }
      pending = enqueue(entry, GAME_OWNER_COMMAND.FRAME, { payload });
    }
    void pending
      .finally(() => {
        if (!entry.closed) socket.resume();
      })
      .catch(() => null);
  });
  socket.on("drain", () => {
    void enqueue(entry, GAME_OWNER_COMMAND.DRAIN).catch(() => null);
  });
  socket.on("error", (error) => {
    if (entry.ownerClosing) return;
    void enqueue(entry, GAME_OWNER_COMMAND.ERROR, {
      code: String(error && error.code || "GAME_EDGE_SOCKET_ERROR"),
      message: String(error && error.message || "game socket failed"),
    }).catch(() => null);
  });
  socket.on("close", (hadError) => {
    if (!entry.ownerClosing) destroyEntry(entry, hadError ? new Error("socket error") : null, true);
    else destroyEntry(entry, null, false);
  });
}

function startServer() {
  server = net.createServer(handleSocket);
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, hostName, () => {
      server.off("error", onError);
      server.on("error", (error) => {
        log.err(`[GameEdge] TCP server error: ${error.message}`);
      });
      const bound = server.address();
      address = Object.freeze({
        host: hostName,
        port: Number(bound && bound.port) || port,
      });
      resolve(address);
    });
  });
}

async function stopServer() {
  for (const entry of [...sockets.values()]) {
    entry.ownerClosing = true;
    entry.socket.destroy();
    destroyEntry(entry, null, false);
  }
  const target = server;
  server = null;
  address = null;
  if (!target) return;
  await new Promise((resolve) => target.close(() => resolve()));
}

const edgeHost = createEdgeProcessHost({
  authorityName: AUTHORITY_NAME,
  async handleCommand(command, payload) {
    if (
      command === "test.crash" &&
      process.env.EVEJS_GAME_EDGE_TEST_CRASH === "1"
    ) {
      setImmediate(() => process.exit(89));
      return new Promise(() => {});
    }
    if (command === "status") {
      return { activeSockets: sockets.size, address, pid: process.pid };
    }
    const socketID = Number(payload && payload.socketID);
    const entry = sockets.get(socketID);
    if (!entry || entry.closed || !isSocketWritable(entry.socket)) {
      return { accepted: false, closed: true, socketID };
    }
    if (command === GAME_EDGE_COMMAND.ACTIVATE_TRANSPORT) {
      return activateTransport(entry, payload);
    }
    if (command === GAME_EDGE_COMMAND.WRITE) {
      return {
        ...writeSocket(
          entry.socket,
          Buffer.from(payload.data || Buffer.alloc(0)),
        ),
        socketID,
      };
    }
    if (command === GAME_EDGE_COMMAND.WRITE_PAYLOAD) {
      const framed = frameTransportPayload(
        entry,
        Buffer.from(payload.data || Buffer.alloc(0)),
      );
      return {
        ...writeSocket(entry.socket, framed),
        bodyBytes: framed.length - 4,
        framedBytes: framed.length,
        socketID,
      };
    }
    if (command === GAME_EDGE_COMMAND.END) {
      entry.ownerClosing = true;
      entry.socket.end(payload.data ? Buffer.from(payload.data) : undefined);
      return { accepted: true, socketID };
    }
    if (command === GAME_EDGE_COMMAND.DESTROY) {
      entry.ownerClosing = true;
      entry.socket.destroy();
      destroyEntry(entry, null, false);
      return { accepted: true, socketID };
    }
    const error = new Error(`unknown game edge command: ${command}`);
    error.code = "GAME_EDGE_COMMAND_UNKNOWN";
    throw error;
  },
  onShutdown: stopServer,
  async onStart(context) {
    requestOwner = context.request;
    await startServer();
  },
});

void edgeHost.ready.catch(() => null);
