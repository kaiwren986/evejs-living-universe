"use strict";

const net = require("node:net");

const {
  CLIENT_COMPATIBILITY_PROFILE,
} = require("../network/protocolProfile");
const {
  marshalDecodeExact,
} = require("../network/tcp/utils/marshal");

const DEFAULT_GAME_GREETING_TIMEOUT_MS = 2_000;
const MAX_GAME_GREETING_PAYLOAD_LENGTH = 64 * 1024;

function numericValue(value) {
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : Number.NaN;
  }
  return Number(value);
}

function stringValue(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  if (value && typeof value.value === "string") return value.value;
  return "";
}

function isPlausibleGameGreetingPayload(
  payload,
  profile = CLIENT_COMPATIBILITY_PROFILE,
) {
  try {
    const decoded = marshalDecodeExact(Buffer.from(payload || []));
    if (!Array.isArray(decoded) || decoded.length !== 7) return false;

    const [birthday, machoVersion, userCount, bootVersion, bootBuild, project, updateInfo] =
      decoded;
    return (
      numericValue(birthday) === Number(profile.eveBirthday) &&
      numericValue(machoVersion) === Number(profile.machoVersion) &&
      Number.isFinite(numericValue(userCount)) &&
      numericValue(userCount) >= 0 &&
      numericValue(bootVersion) === Number(profile.clientVersion) &&
      numericValue(bootBuild) === Number(profile.clientBuild) &&
      stringValue(project) === String(profile.projectVersion) &&
      updateInfo === null
    );
  } catch (_) {
    // ignored: a greeting that cannot be read is not a healthy one
    return false;
  }
}

function probeGameGreeting(port, timeoutMs = DEFAULT_GAME_GREETING_TIMEOUT_MS, options = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65_535) {
    return Promise.resolve(false);
  }

  const host = String(options.host || "127.0.0.1");
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.trunc(Number(timeoutMs))
    : DEFAULT_GAME_GREETING_TIMEOUT_MS;
  const validatePayload = typeof options.validatePayload === "function"
    ? options.validatePayload
    : isPlausibleGameGreetingPayload;

  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    let connected = false;
    let settled = false;
    let forceCloseTimer = null;
    const socket = net.connect({ host, port: numericPort });

    function closeProbe() {
      socket.setTimeout(0);
      if (connected && !socket.destroyed) {
        socket.resume();
        socket.end();
        forceCloseTimer = setTimeout(() => socket.destroy(), boundedTimeoutMs);
        forceCloseTimer.unref?.();
        return;
      }
      socket.destroy();
    }

    function settle(value) {
      if (settled) return;
      settled = true;
      resolve(value === true);
      closeProbe();
    }

    socket.once("connect", () => {
      connected = true;
    });
    socket.setTimeout(boundedTimeoutMs, () => settle(false));
    socket.on("data", (chunk) => {
      if (settled) return;
      buffered = buffered.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;

      const payloadLength = buffered.readUInt32LE(0);
      if (
        payloadLength <= 0 ||
        payloadLength > MAX_GAME_GREETING_PAYLOAD_LENGTH
      ) {
        settle(false);
        return;
      }
      if (buffered.length < 4 + payloadLength) return;

      settle(validatePayload(buffered.subarray(4, 4 + payloadLength)) === true);
    });
    socket.once("end", () => settle(false));
    socket.once("error", () => settle(false));
    socket.once("close", () => {
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
  });
}

module.exports = {
  DEFAULT_GAME_GREETING_TIMEOUT_MS,
  isPlausibleGameGreetingPayload,
  MAX_GAME_GREETING_PAYLOAD_LENGTH,
  probeGameGreeting,
};
