"use strict";

const http = require("node:http");
const https = require("node:https");

const { probeGameGreeting } = require("./gameServerHealth");

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

function gatewayHealthUrl(env = process.env) {
  const value = String(env.EVEJS_MICROSERVICES_PUBLIC_URL || "").trim();
  if (!value) throw new Error("gateway health URL is not configured");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported gateway health protocol: ${url.protocol}`);
  }
  url.hostname = "127.0.0.1";
  if (env.EVEJS_MICROSERVICES_PORT) {
    url.port = String(env.EVEJS_MICROSERVICES_PORT);
  }
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url;
}

function probeHttpHealth(url, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, { rejectUnauthorized: false }, (response) => {
      response.once("error", () => resolve(false));
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("gateway timeout")));
    request.once("error", () => resolve(false));
  });
}

async function runDeploymentHealthcheck(options = {}) {
  const env = options.env || process.env;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS;
  const gameProbe = options.gameProbe || probeGameGreeting;
  const gatewayProbe = options.gatewayProbe || probeHttpHealth;
  const gamePort = Number(env.EVEJS_SERVER_PORT);
  const url = gatewayHealthUrl(env);

  const [gameHealthy, gatewayHealthy] = await Promise.all([
    gameProbe(gamePort, timeoutMs),
    gatewayProbe(url, timeoutMs),
  ]);
  if (!gameHealthy) {
    throw new Error("game server did not return a valid MachoNet greeting");
  }
  if (!gatewayHealthy) {
    throw new Error("gateway health check failed");
  }
  return Object.freeze({ gameHealthy: true, gatewayHealthy: true });
}

if (require.main === module) {
  void runDeploymentHealthcheck().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  gatewayHealthUrl,
  probeHttpHealth,
  runDeploymentHealthcheck,
};
