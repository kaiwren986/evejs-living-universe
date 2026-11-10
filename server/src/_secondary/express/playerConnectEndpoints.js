"use strict";

// These helper routes require the configured token in a header, compared in
// constant time. An unset token disables them with HTTP 503.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const config = require("../../config");
const {
  CLIENT_COMPATIBILITY_PROFILE,
} = require("../../network/protocolProfile");
const {
  probeGameGreeting,
} = require("../../utils/gameServerHealth");

const {
  adoptLegacyCertificateFilesOnce,
  certificateFilePath,
} = require("../../config/certificateFiles");

const CA_CERT_PATH = certificateFilePath("xmpp-ca-cert.pem");
const CLIENT_START_INI_PATH = path.join(
  __dirname,
  "../../../../client/EVE/tq/start.ini",
);

// Resolve the effective token from the current schema-backed files on every
// request. A read/validation failure must fail closed so an old boot credential
// can never become valid again after it was rotated or revoked.
function resolveConfiguredToken(_inMemoryToken, readLiveToken) {
  try {
    return String(readLiveToken() || "").trim();
  } catch (error) {
    // ignored: a token that cannot be read fails closed: no token is valid
    return "";
  }
}

// Live re-read of the token from the config files so a token changed after the
// server booted is honored without a restart. getConfigStateSnapshot only reads
// + merges the config files, so this is safe per request. Swappable for tests.
function defaultLiveTokenReader() {
  const snapshot = config.getConfigStateSnapshot();
  return (
    snapshot && snapshot.resolvedConfig && snapshot.resolvedConfig.playerConnectToken
  );
}

let liveTokenReader = defaultLiveTokenReader;
let gameGreetingProbe = probeGameGreeting;

// getConfigStateSnapshot re-reads AND re-validates all six config domain files
// plus version.json synchronously. Doing that per request put blocking disk I/O
// on the same express app the web gateway is mounted on (:26002), so a polling
// caller stole event-loop time from gateway owner calls that are
// already racing a 15 s deadline. Cache the resolved token for a beat: a token
// rotated or revoked after boot still takes effect without a restart — the
// point of live-reading — just a second later instead of instantly, which is a
// fair trade for a secret gating a health ping and a public CA download.
const TOKEN_CACHE_TTL_MS = 1000;
let cachedToken = null;
let cachedTokenAt = 0;

function invalidateTokenCache() {
  cachedToken = null;
  cachedTokenAt = 0;
}

function getConfiguredToken() {
  // A backwards clock jump reads as "stale", never as an unbounded hit — the
  // cache may only ever be shorter than the TTL, never longer.
  const now = Date.now();
  const age = now - cachedTokenAt;
  if (cachedToken !== null && age >= 0 && age < TOKEN_CACHE_TTL_MS) {
    return cachedToken;
  }
  cachedToken = resolveConfiguredToken(
    config && config.playerConnectToken,
    liveTokenReader,
  );
  cachedTokenAt = now;
  return cachedToken;
}

function isTokenValid(providedToken, configuredToken) {
  const configured = String(configuredToken || "");
  const provided = String(providedToken || "");
  if (!configured) {
    return false;
  }
  const configuredBuffer = Buffer.from(configured, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (configuredBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(configuredBuffer, providedBuffer);
}

function isConfiguredTokenUsable(value) {
  return /^[A-Za-z0-9_-]{32,128}$/u.test(String(value || ""));
}

function extractProvidedToken(req) {
  const headerToken = req && req.headers && req.headers["x-playerconnect-token"];
  if (typeof headerToken === "string" && headerToken) {
    return headerToken;
  }
  return "";
}

// Returns true when the caller may proceed; otherwise writes the 503/401 error
// response and returns false.
function authorizeRequest(req, res) {
  const configuredToken = getConfiguredToken();
  if (!isConfiguredTokenUsable(configuredToken)) {
    res.status(503).json({ ok: false, error: "playerconnect_disabled" });
    return false;
  }
  if (!isTokenValid(extractProvidedToken(req), configuredToken)) {
    res.status(401).json({ ok: false, error: "invalid_token" });
    return false;
  }
  return true;
}

function readCaBuffer() {
  adoptLegacyCertificateFilesOnce();
  try {
    return fs.readFileSync(CA_CERT_PATH);
  } catch (error) {
    // ignored: no CA file; null means there is none to serve
    return null;
  }
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readClientBuild() {
  try {
    const content = fs.readFileSync(CLIENT_START_INI_PATH, "utf8");
    const match = /^\s*build\s*=\s*(.+?)\s*$/im.exec(content);
    return match
      ? match[1].trim()
      : String(CLIENT_COMPATIBILITY_PROFILE.clientBuild);
  } catch (error) {
    return String(CLIENT_COMPATIBILITY_PROFILE.clientBuild);
  }
}

function getXmppHost() {
  try {
    const { getXmppConnectHost } = require("../../services/chat/xmppConfig");
    return getXmppConnectHost();
  } catch (error) {
    // ignored: the chat config is not loaded in this process; null means no XMPP host
    return null;
  }
}

function resolveGameProbeHost(bindHost) {
  const normalized = String(bindHost || "").trim();
  if (
    !normalized ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  ) {
    return "127.0.0.1";
  }
  return normalized;
}

function mountPlayerConnectEndpoints(app) {
  if (!app || typeof app.get !== "function") {
    return;
  }

  app.get("/playerconnect/health", async (req, res) => {
    if (!authorizeRequest(req, res)) {
      return;
    }

    const caBuffer = readCaBuffer();
    const gamePort = Number((config && config.serverPort) || 26000) || 26000;
    const gameProbeHost = resolveGameProbeHost(
      config && config.gameServerBindHost,
    );
    let gameGreetingValid = false;
    try {
      gameGreetingValid = await gameGreetingProbe(
        gamePort,
        undefined,
        { host: gameProbeHost },
      );
    } catch (error) {
      gameGreetingValid = false;
    }

    res.status(gameGreetingValid ? 200 : 503).json({
      ok: gameGreetingValid,
      service: "playerconnect",
      error: gameGreetingValid ? null : "game_server_unhealthy",
      build: readClientBuild(),
      xmppHost: getXmppHost(),
      gamePort,
      // Keep the legacy response field while tightening its
      // meaning from "TCP accepted" to "complete greeting validated".
      gamePortOpen: gameGreetingValid,
      gameGreetingValid,
      caSha256: caBuffer ? sha256Hex(caBuffer) : null,
      time: new Date().toISOString(),
    });
  });

  app.get("/playerconnect/ca.pem", (req, res) => {
    if (!authorizeRequest(req, res)) {
      return;
    }

    const caBuffer = readCaBuffer();
    if (!caBuffer) {
      res.status(404).json({ ok: false, error: "ca_not_found" });
      return;
    }

    res.setHeader("Content-Type", "application/x-pem-file");
    res.setHeader("x-evejs-ca-sha256", sha256Hex(caBuffer));
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="evejs-ca-cert.pem"',
    );
    res.status(200).send(caBuffer);
  });
}

module.exports = {
  mountPlayerConnectEndpoints,
  __test__: {
    isTokenValid,
    isConfiguredTokenUsable,
    extractProvidedToken,
    probeGameGreeting,
    probeGamePort: probeGameGreeting,
    resolveConfiguredToken,
    resolveGameProbeHost,
    sha256Hex,
    CA_CERT_PATH,
    invalidateTokenCache,
    setLiveTokenReader(fn) {
      liveTokenReader = typeof fn === "function" ? fn : defaultLiveTokenReader;
      invalidateTokenCache();
    },
    resetLiveTokenReader() {
      liveTokenReader = defaultLiveTokenReader;
      invalidateTokenCache();
    },
    setGameGreetingProbe(fn) {
      gameGreetingProbe = typeof fn === "function" ? fn : probeGameGreeting;
    },
    resetGameGreetingProbe() {
      gameGreetingProbe = probeGameGreeting;
    },
  },
};
