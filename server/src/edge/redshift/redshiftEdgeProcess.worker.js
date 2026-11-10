"use strict";

process.env.EVEJS_GAMESTORE_OWNER_ROLE = "reader";

const http = require("node:http");
const path = require("node:path");

const {
  installProcessLifecycleLogging,
} = require("../../utils/processLifecycle");

installProcessLifecycleLogging({
  appName: "eve.js redshift edge",
  signals: [],
});

const { createEdgeProcessHost } = require(path.join(
  __dirname,
  "../edgeProcessHost",
));
const { AUTHORITY_NAME } = require(path.join(__dirname, "redshiftEdgeRuntime"));

const hostName = String(process.env.EVEJS_REDSHIFT_EDGE_HOST || "127.0.0.1").trim();
const configuredPort = Number(process.env.EVEJS_REDSHIFT_EDGE_PORT);
const port = Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65_535
  ? configuredPort
  : 26_400;
let server = null;
let address = null;
let requestOwner = null;
let activeRequests = 0;
let completedRequests = 0;
let failedRequests = 0;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res, statusCode, body) {
  setCors(res);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        const error = new Error("body too large");
        error.code = "REDSHIFT_BODY_TOO_LARGE";
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        error.code = "REDSHIFT_BODY_INVALID";
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  activeRequests += 1;
  try {
    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      res.end();
      completedRequests += 1;
      return;
    }
    const route = String(req.url || "/").split("?")[0];
    let ownerResponse = null;
    if (req.method === "GET" && (route === "/" || route === "/api/status")) {
      ownerResponse = await requestOwner("monitor.status", {});
    } else if (req.method === "POST" && route === "/api/autoscaler") {
      ownerResponse = await requestOwner("monitor.autoscaler", await readJsonBody(req));
    } else if (req.method === "POST" && route === "/api/override") {
      ownerResponse = await requestOwner("monitor.override", await readJsonBody(req));
    } else {
      sendJson(res, 404, { ok: false, error: "not found" });
      completedRequests += 1;
      return;
    }
    sendJson(
      res,
      Number(ownerResponse && ownerResponse.statusCode) || 200,
      ownerResponse && ownerResponse.body,
    );
    completedRequests += 1;
  } catch (error) {
    failedRequests += 1;
    const clientError = error && (
      error.code === "REDSHIFT_BODY_INVALID" ||
      error.code === "REDSHIFT_BODY_TOO_LARGE"
    );
    sendJson(res, clientError ? 400 : 502, {
      ok: false,
      error: String(error && error.message || (
        clientError ? "invalid request body" : "monitor owner unavailable"
      )),
    });
  } finally {
    activeRequests = Math.max(0, activeRequests - 1);
  }
}

function startServer() {
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
  return new Promise((resolve) => target.close(() => resolve()));
}

const edgeHost = createEdgeProcessHost({
  authorityName: AUTHORITY_NAME,
  handleCommand(command) {
    if (command === "status") {
      return {
        activeRequests,
        address,
        completedRequests,
        failedRequests,
        pid: process.pid,
      };
    }
    const error = new Error(`Unknown redshift edge command: ${command}`);
    error.code = "REDSHIFT_EDGE_COMMAND_UNKNOWN";
    throw error;
  },
  onShutdown: stopServer,
  async onStart(context) {
    requestOwner = context.request;
    await startServer();
  },
});

void edgeHost.ready.catch(() => null);
