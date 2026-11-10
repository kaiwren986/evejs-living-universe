"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "reader";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const {
  installProcessLifecycleLogging,
} = require("../../utils/processLifecycle");

installProcessLifecycleLogging({
  appName: "eve.js image edge",
  signals: [],
});

const {
  configureCorporationLogoProjection,
  resolveImageRequest,
} = require(path.join(__dirname, "../../_secondary/image/imageRequestResolver"));
const { createOrderedProcessHost } = require(path.join(
  __dirname,
  "../../services/_shared/orderedProcessHost",
));
const { AUTHORITY_NAME } = require(path.join(__dirname, "imageEdgeRuntime"));

const hostName = String(process.env.EVEJS_IMAGE_EDGE_HOST || "127.0.0.1").trim();
const configuredPort = Number(process.env.EVEJS_IMAGE_EDGE_PORT);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : 26001;

let server = null;
let address = null;
let activeRequests = 0;
let bytesServed = 0;
let completedRequests = 0;
let failedRequests = 0;
let projectionCounts = null;

function contentLengthHeaders(contentType, length) {
  return {
    "Cache-Control": "public, max-age=300",
    "Content-Length": length,
    "Content-Type": contentType,
  };
}

async function handleRequest(req, res) {
  activeRequests += 1;
  try {
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      completedRequests += 1;
      return;
    }

    const resolved = resolveImageRequest(String(req.url || "/"));
    let data;
    try {
      data = await fs.promises.readFile(resolved.filePath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        res.writeHead(404);
        res.end();
        completedRequests += 1;
        return;
      }
      throw error;
    }

    res.writeHead(
      200,
      contentLengthHeaders(resolved.contentType, data.length),
    );
    if (method === "HEAD") {
      res.end();
    } else {
      res.end(data);
      bytesServed += data.length;
    }
    completedRequests += 1;
  } catch (_) {
    failedRequests += 1;
    if (!res.headersSent) res.writeHead(500);
    res.end();
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
  }
}

function startServer() {
  if (server) return Promise.resolve(address);
  server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server = null;
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, hostName, () => {
      server.off("error", onError);
      const bound = server.address();
      address = Object.freeze({
        host: hostName,
        port: Number(bound && bound.port) || port,
      });
      resolve(address);
    });
  });
}

function stopServer() {
  const target = server;
  server = null;
  address = null;
  if (!target) return Promise.resolve();
  return new Promise((resolve) => {
    target.close(() => resolve());
  });
}

function buildStatus() {
  return {
    activeRequests,
    address,
    bytesServed,
    completedRequests,
    failedRequests,
    pid: process.pid,
    projectionCounts,
  };
}

const host = createOrderedProcessHost({
  authorityName: AUTHORITY_NAME,
  async handleCommand(command) {
    if (command === "status") return buildStatus();
    const error = new Error(`Unknown image edge command: ${command}`);
    error.code = "IMAGE_EDGE_COMMAND_UNKNOWN";
    throw error;
  },
  async onStart({ bootstrapPayload }) {
    projectionCounts = configureCorporationLogoProjection(
      bootstrapPayload && bootstrapPayload.corporationLogoProjection,
    );
    await startServer();
  },
  onShutdown: stopServer,
  waitForBootstrap: true,
});

void host.ready.catch(() => null);
