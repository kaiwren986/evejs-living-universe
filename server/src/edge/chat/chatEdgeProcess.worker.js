"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "reader";

const tls = require("node:tls");

const {
  installProcessLifecycleLogging,
} = require("../../utils/processLifecycle");

installProcessLifecycleLogging({
  appName: "eve.js chat edge",
  signals: [],
});

const config = require("../../config");
const log = require("../../utils/logger");
const { XMPP_SERVER_PORT } = require("../../network/protocolProfile");
const { configureClientSocket } = require("../../network/tcp/socketTuning");
const { createEdgeProcessHost } = require("../edgeProcessHost");
const { AUTHORITY_NAME } = require("./chatEdgeRuntime");
const { CHAT_EDGE_COMMAND, CHAT_OWNER_COMMAND } = require("./chatSocketProtocol");
const { isSocketWritable, writeSocket } = require("./chatSocketWrite");
const { readXmppTlsCredentials } = require("./xmppTlsCredentials");

const hostName = String(process.env.EVEJS_CHAT_EDGE_HOST || "127.0.0.1").trim();
const configuredPort = Number(process.env.EVEJS_CHAT_EDGE_PORT);
const port = Number.isInteger(configuredPort) &&
  configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : XMPP_SERVER_PORT;
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
    void entry.lane.then(() => requestOwner(CHAT_OWNER_COMMAND.CLOSE, {
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

function handleSocket(socket) {
  configureClientSocket(socket, config, log);
  const socketID = nextSocketID;
  nextSocketID += 1;
  const entry = {
    closed: false,
    lane: Promise.resolve(),
    ownerClosing: false,
    socket,
    socketID,
  };
  sockets.set(socketID, entry);
  const openRequest = requestOwner(CHAT_OWNER_COMMAND.OPEN, {
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
    void enqueue(entry, CHAT_OWNER_COMMAND.DATA, {
      data: Buffer.from(chunk),
    })
      .finally(() => {
        if (!entry.closed) socket.resume();
      })
      .catch(() => null);
  });
  socket.on("drain", () => {
    void enqueue(entry, CHAT_OWNER_COMMAND.DRAIN).catch(() => null);
  });
  socket.on("error", (error) => {
    if (entry.ownerClosing) return;
    void enqueue(entry, CHAT_OWNER_COMMAND.ERROR, {
      code: String(error && error.code || "CHAT_EDGE_SOCKET_ERROR"),
      message: String(error && error.message || "chat socket failed"),
    }).catch(() => null);
  });
  socket.on("close", (hadError) => {
    if (!entry.ownerClosing) destroyEntry(entry, hadError ? new Error("socket error") : null, true);
    else destroyEntry(entry, null, false);
  });
}

function startServer() {
  server = tls.createServer({
    ...readXmppTlsCredentials(),
    minVersion: "TLSv1",
    maxVersion: "TLSv1.3",
  }, handleSocket);
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, hostName, () => {
      server.off("error", onError);
      server.on("error", (error) => {
        log.err(`[ChatEdge] TLS server error: ${error.message}`);
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
      process.env.EVEJS_CHAT_EDGE_TEST_CRASH === "1"
    ) {
      setImmediate(() => process.exit(88));
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
    if (command === CHAT_EDGE_COMMAND.WRITE) {
      return {
        ...writeSocket(
          entry.socket,
          Buffer.from(payload.data || Buffer.alloc(0)),
        ),
        socketID,
      };
    }
    if (command === CHAT_EDGE_COMMAND.END) {
      entry.ownerClosing = true;
      entry.socket.end(payload.data ? Buffer.from(payload.data) : undefined);
      return { accepted: true, socketID };
    }
    if (command === CHAT_EDGE_COMMAND.DESTROY) {
      entry.ownerClosing = true;
      entry.socket.destroy();
      destroyEntry(entry, null, false);
      return { accepted: true, socketID };
    }
    const error = new Error(`unknown chat edge command: ${command}`);
    error.code = "CHAT_EDGE_COMMAND_UNKNOWN";
    throw error;
  },
  onShutdown: stopServer,
  async onStart(context) {
    requestOwner = context.request;
    await startServer();
  },
});

void edgeHost.ready.catch(() => null);
