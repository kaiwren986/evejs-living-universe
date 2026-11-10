"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "reader";

const path = require("node:path");

const {
  installProcessLifecycleLogging,
} = require("../../utils/processLifecycle");

installProcessLifecycleLogging({
  appName: "eve.js gateway edge",
  signals: [],
});

const { createEdgeProcessHost } = require(path.join(
  __dirname,
  "../edgeProcessHost",
));
const { createRemoteGatewayRuntime } = require("./remoteGatewayRuntime");
const { createRemoteGatewayGrpcTransport } = require("./remoteGatewayGrpcTransport");
const { AUTHORITY_NAME } = require("./gatewayEdgeRuntime");
const expressServer = require(path.join(
  __dirname,
  "../../_secondary/express/server",
));

const hostName = String(
  process.env.EVEJS_GATEWAY_EDGE_HOST || "127.0.0.1",
).trim();
const configuredPort = Number(process.env.EVEJS_GATEWAY_EDGE_PORT);
const port = Number.isInteger(configuredPort) &&
  configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : 26_002;
const protocol = process.env.EVEJS_GATEWAY_EDGE_PROTOCOL === "https:"
  ? "https:"
  : "http:";
let dependencies = {};
try {
  dependencies = JSON.parse(process.env.EVEJS_GATEWAY_EDGE_DEPENDENCIES || "{}");
} catch {
  dependencies = {};
}
let runningServer = null;
let remoteGateway = null;
let remoteGrpc = null;
let ownerRequest = null;
let boundAddress = null;

async function stopServer() {
  if (runningServer) await runningServer.shutdown();
  if (remoteGrpc) await remoteGrpc.shutdown();
  runningServer = null;
  remoteGateway = null;
  remoteGrpc = null;
  boundAddress = null;
}

const edgeHost = createEdgeProcessHost({
  authorityName: AUTHORITY_NAME,
  async handleCommand(command, payload) {
    if (
      command === "test.crash" &&
      process.env.EVEJS_GATEWAY_EDGE_TEST_CRASH === "1"
    ) {
      setImmediate(() => process.exit(87));
      return new Promise(() => {});
    }
    if (command === "status") {
      return {
        address: boundAddress,
        grpc: remoteGrpc ? remoteGrpc.getDiagnostics() : null,
        pid: process.pid,
        runtime: remoteGateway ? remoteGateway.getDiagnostics() : null,
      };
    }
    if (String(command).startsWith("gateway.grpc.")) {
      return remoteGrpc.handleCommand(command, payload);
    }
    return remoteGateway.handleCommand(command, payload);
  },
  onShutdown: stopServer,
  async onStart(context) {
    ownerRequest = context.request;
    remoteGateway = createRemoteGatewayRuntime({
      dependencies,
      requestOwner: ownerRequest,
    });
    remoteGrpc = createRemoteGatewayGrpcTransport({
      requestOwner: ownerRequest,
    });
    runningServer = expressServer.__testHooks.startServer({
      gatewayRuntime: remoteGateway.runtime,
      // Read LAZILY, at probe time. `edgeHost` is the const this callback is an
      // argument to, so it cannot be referenced here directly — and by the time
      // anyone asks /health, it is long since assigned.
      ownerDiagnostics: () => (edgeHost ? edgeHost.getDiagnostics() : null),
      serviceManager: Object.freeze({}),
    }, {
      bindHost: hostName,
      handleGatewayStream: remoteGrpc.handleGatewayStream,
      httpPort: port,
      listenUrl: `${protocol}//${hostName}:${port}/`,
    });
    const ready = await runningServer.ready;
    boundAddress = Object.freeze({
      host: hostName,
      port: Number(ready && ready.http && ready.http.port) || port,
      protocol,
    });
  },
});

void edgeHost.ready.catch(() => null);
