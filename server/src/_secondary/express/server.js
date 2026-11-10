"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const http2 = require("http2");
const crypto = require("crypto");
const tls = require("tls");

const config = require("../../config");
const log = require("../../utils/logger");
const {
  adoptLegacyCertificateFilesOnce,
  certificateDirectory,
} = require("../../config/certificateFiles");
const {
  ensureLocalLeafCertificate,
  LOCAL_TLS_DNS_ALT_NAMES,
} = require("./localTlsCertificate");

let gatewayStreamHandler = null;
let mapTagsCdnAssetResolver = null;
let achievementCdnAssetResolver = null;

function getGatewayStreamHandler() {
  if (!gatewayStreamHandler) {
    ({ handleGatewayStream: gatewayStreamHandler } = require("./publicGatewayLocal"));
  }
  return gatewayStreamHandler;
}

function getMapTagsCdnAsset(routePath) {
  if (!mapTagsCdnAssetResolver) {
    ({ getMapTagsCdnAsset: mapTagsCdnAssetResolver } =
      require("./gatewayServices/mapTagsGatewayService"));
  }
  return mapTagsCdnAssetResolver(routePath);
}

function getAchievementCdnAsset(routePath) {
  if (!achievementCdnAssetResolver) {
    ({ getAchievementCdnAsset: achievementCdnAssetResolver } =
      require("./gatewayServices/achievementGatewayService"));
  }
  return achievementCdnAssetResolver(routePath);
}

function getGatewayBinaryAsset(routePath) {
  return getMapTagsCdnAsset(routePath) || getAchievementCdnAsset(routePath) ||
    require("../../services/character/projectDiscoverySamples").getSampleAsset(routePath) || null;
}

function shouldEnableLocalInterceptByDefault() {
  try {
    const redirectUrl = new URL(config.microservicesPublicUrl);
    return isLoopbackHost(redirectUrl.hostname);
  } catch {
    // ignored: an unparsable public URL is not a loopback one
    return false;
  }
}

function parseBooleanEnv(value, fallback = false) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseOptionalUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }
  try {
    return new URL(normalized);
  } catch {
    // ignored: not a URL; null means none was given
    return null;
  }
}

function parseNonNegativeIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseHostPatternList(value) {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  const bracketedIpv6 = normalized.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) {
    return bracketedIpv6[1];
  }

  const colonIndex = normalized.lastIndexOf(":");
  if (
    colonIndex > -1 &&
    normalized.indexOf(":") === colonIndex &&
    /^\d+$/.test(normalized.slice(colonIndex + 1))
  ) {
    return normalized.slice(0, colonIndex);
  }

  return normalized;
}

function hostMatchesPattern(hostname, pattern) {
  const normalizedHost = normalizeHostname(hostname);
  const normalizedPattern = String(pattern || "").trim().toLowerCase();

  if (!normalizedHost || !normalizedPattern) {
    return false;
  }

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return (
      normalizedHost === normalizedPattern.slice(2) ||
      normalizedHost.endsWith(suffix)
    );
  }

  if (normalizedPattern.startsWith(".")) {
    return (
      normalizedHost === normalizedPattern.slice(1) ||
      normalizedHost.endsWith(normalizedPattern)
    );
  }

  return normalizedHost === normalizedPattern;
}

function shouldInterceptHost(hostname) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }

  return LOCAL_INTERCEPT_HOSTS.has(normalized);
}

function shouldBlockHost(hostname) {
  if (isBlockedFeatureRequest(hostname)) return true;
  if (shouldInterceptHost(hostname)) {
    return false;
  }
  return BLOCKED_PROXY_HOSTS.some((pattern) =>
    hostMatchesPattern(hostname, pattern),
  );
}

function normalizeLaunchDarklyPath(routePath) {
  // Native endpoint literals retain their original length using trailing '/'
  // padding. Treat repeated leading slashes as a path, never a URL authority.
  return String(routePath || "/").replace(/^\/+/, "/").split("?", 1)[0];
}

function isLaunchDarklyPath(routePath) {
  const normalized = normalizeLaunchDarklyPath(routePath);
  return /^\/(?:meval|eval|mping|ping|diagnostic|all|flags|mobile|bulk)(?:\/|$)/i.test(normalized) ||
    /^\/events\/bulk(?:\/|$)/i.test(normalized) ||
    /^\/msdk\/evalx\/contexts?(?:\/|$)/i.test(normalized) ||
    /^\/sdk\/latest-all(?:\/|$)/i.test(normalized);
}

function isBlockedFeatureRequest(hostname, routePath = "") {
  const normalized = normalizeHostname(hostname);
  return (normalized === "launchdarkly.com" || normalized.endsWith(".launchdarkly.com")) ||
    (isLoopbackHost(normalized) && isLaunchDarklyPath(routePath));
}

function shouldDenyUnhandledProxyHost(hostname) {
  return !ENABLE_LOCAL_INTERCEPT || !shouldInterceptHost(hostname);
}

function makeResponsePayload(req) {
  return {
    status: "ok",
    message: "microservice placeholder response",
    method: req.method,
    path: req.originalUrl || req.url,
    host: req.headers.host || null,
    timestamp: new Date().toISOString(),
  };
}

function makeHttp2Payload(headers) {
  return {
    status: "ok",
    message: "microservice placeholder response",
    method: headers[":method"] || null,
    path: headers[":path"] || null,
    host: headers[":authority"] || headers.host || null,
    timestamp: new Date().toISOString(),
  };
}

function makeHttp1Payload(req) {
  return {
    status: "ok",
    message: "microservice placeholder response",
    method: req.method || null,
    path: req.url || null,
    host: req.headers.host || null,
    timestamp: new Date().toISOString(),
  };
}

const CLIENT_FEATURE_VALUES = Object.freeze({
  achievements_feature_enabled: true,
  character_titles_feature_enabled: true,
  eve_ag_guidance_enabled: true,
});
const clientFeatureStreams = new Set();

function buildClientFeatureEvaluations() {
  // The installed native SDK consumes a map of versioned evaluations. Absent
  // keys keep their client defaults; no broad or configurable profile is sent.
  return Object.fromEntries(Object.entries(CLIENT_FEATURE_VALUES).map(([key, value]) => [key, {
    value, variation: 0, version: 1, flagVersion: 1,
    trackEvents: false, trackReason: false, debugEventsUntilDate: null,
    reason: { kind: "OFF" },
  }]));
}

function buildOfflinePolicyStatus() {
  return {
    version: 4,
    proxyForwarding: "disabled",
    clientFeatureFlags: "local-supported-features",
    clientFeatureFlagValues: { ...CLIENT_FEATURE_VALUES },
  };
}

function buildHealthPayload(loopbackListener, secureListener) {
  return {
    status: "ok",
    service: "express-secondary",
    gatewayMode: shouldHandleInterceptLocally() ? "local" : "blocked",
    offlinePolicy: buildOfflinePolicyStatus(loopbackListener, secureListener),
  };
}

function isHealthRequest(method, routePath) {
  return String(method || "").toUpperCase() === "GET" &&
    /^\/health\/?(?:\?|$)/i.test(String(routePath || ""));
}

function handleHealthHttpRequest(req, res, getHealthPayload) {
  if (!isHealthRequest(req.method, req.url)) return false;
  req.resume();
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(getHealthPayload()));
  return true;
}

function clientFeatureResponse(hostname, routePath, method, accept = "") {
  const denied = { status: 404, headers: { "content-length": "0", "cache-control": "no-store" }, body: "" };
  // Only the existing patched loopback endpoints may receive local values.
  // Real LaunchDarkly hosts remain blocked without DNS or an upstream request.
  if (!isLoopbackHost(normalizeHostname(hostname))) return denied;
  const route = normalizeLaunchDarklyPath(routePath);
  const verb = String(method || "").toUpperCase();
  if (verb === "OPTIONS") return { status: 204, headers: { "cache-control": "no-store" }, body: "" };
  if (verb === "POST" && /^\/(?:events\/bulk|mobile|bulk|diagnostic)(?:\/|$)/i.test(route)) {
    return { status: 202, headers: { "cache-control": "no-store" }, body: "" };
  }
  if (!["GET", "REPORT"].includes(verb) ||
      !/^\/(?:meval|eval|mping|ping|all|flags|msdk\/evalx\/contexts?|sdk\/latest-all)(?:\/|$)/i.test(route)) return denied;
  const streaming = String(accept).toLowerCase().includes("text/event-stream") ||
    /^\/(?:meval|eval|mping|ping|all)(?:\/|$)/i.test(route);
  const json = JSON.stringify(buildClientFeatureEvaluations());
  return {
    status: 200,
    headers: { "cache-control": "no-store", "content-type": streaming ? "text/event-stream" : "application/json" },
    body: streaming ? `event: put\ndata: ${json}\n\n` : json,
    streaming,
  };
}

function writeClientFeatureResponse(target, response) {
  if (!response.streaming) { target.end(response.body); return; }
  clientFeatureStreams.add(target);
  const heartbeat = setInterval(() => {
    if (!target.destroyed && !target.writableEnded) target.write(": EveJS local achievements\n\n");
  }, 15_000);
  heartbeat.unref();
  const cleanup = () => { clearInterval(heartbeat); clientFeatureStreams.delete(target); };
  target.once("close", cleanup);
  target.once("finish", cleanup);
  target.once("error", cleanup);
  target.write(response.body);
}

// Keep feature handling ahead of generic placeholders on every local listener.
function handleFeatureHttpRequest(req, res) {
  if (!isBlockedFeatureRequest(req.headers.host, req.url)) return false;
  req.resume();
  const response = clientFeatureResponse(req.headers.host, req.url, req.method, req.headers.accept);
  res.writeHead(response.status, response.headers);
  writeClientFeatureResponse(res, response);
  return true;
}

function handleFeatureHttp2Stream(stream, headers) {
  if (!isBlockedFeatureRequest(headers[":authority"] || headers.host, headers[":path"])) return false;
  stream.resume();
  const response = clientFeatureResponse(headers[":authority"] || headers.host,
    headers[":path"], headers[":method"], headers.accept);
  stream.respond({ ":status": response.status, ...response.headers });
  writeClientFeatureResponse(stream, response);
  return true;
}

function buildBinaryAssetHeaders(asset) {
  return {
    "content-type": asset.contentType || "application/octet-stream",
    "content-length": String(asset.buffer.length),
    "cache-control": "no-store",
  };
}

function parseConnectTarget(connectUrl) {
  const raw = String(connectUrl || "").trim();
  if (!raw) {
    return { host: null, port: null };
  }

  const idx = raw.lastIndexOf(":");
  if (idx === -1) {
    return { host: raw.toLowerCase(), port: 443 };
  }

  const host = raw.slice(0, idx).toLowerCase();
  const parsedPort = Number.parseInt(raw.slice(idx + 1), 10);
  return {
    host,
    port: Number.isFinite(parsedPort) ? parsedPort : 443,
  };
}

function parseHttpProxyTarget(req) {
  const rawUrl = String(req.url || "");
  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      return new URL(rawUrl);
    } catch {
      // ignored: not an absolute URL; null leaves the request to the normal routes
      return null;
    }
  }
  return null;
}

function isLoopbackHost(hostname) {
  const host = normalizeHostname(hostname);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function mountGatewayBinaryAssetRoutes(app) {
  app.get(/.*/, (req, res, next) => {
    const asset = getGatewayBinaryAsset(req.path);
    if (!asset) {
      next();
      return;
    }
    res.status(200).set(buildBinaryAssetHeaders(asset)).send(asset.buffer);
  });
}

function getUrlPort(targetUrl) {
  const parsedPort = Number.parseInt(targetUrl.port || "", 10);
  if (Number.isFinite(parsedPort) && parsedPort > 0) {
    return parsedPort;
  }
  return targetUrl.protocol === "https:" ? 443 : 80;
}

// Pin localhost without consulting DNS. All other service targets must be IP
// literals, so neither proxy input nor a configured hostname can trigger DNS.
function getNumericServiceHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost") return "127.0.0.1";
  return net.isIP(host) ? host : null;
}

function isConfiguredImageTarget(
  targetUrl,
  configuredImageServerUrl = config.imageServerUrl,
) {
  const target = targetUrl instanceof URL
    ? targetUrl
    : parseOptionalUrl(targetUrl);
  const configured = configuredImageServerUrl instanceof URL
    ? configuredImageServerUrl
    : parseOptionalUrl(configuredImageServerUrl);
  if (!target || !configured) {
    return false;
  }
  const targetHost = getNumericServiceHost(target.hostname);
  const configuredHost = getNumericServiceHost(configured.hostname);
  if (!targetHost || !configuredHost || targetHost !== configuredHost) {
    return false;
  }
  if (!["http:", "https:"].includes(target.protocol) ||
      target.protocol !== configured.protocol || target.username || target.password) {
    return false;
  }
  if (getUrlPort(target) !== getUrlPort(configured)) {
    return false;
  }

  const configuredPath = configured.pathname || "/";
  if (configuredPath === "/") {
    return true;
  }
  const pathPrefix = configuredPath.endsWith("/")
    ? configuredPath
    : `${configuredPath}/`;
  return target.pathname === configuredPath || target.pathname.startsWith(pathPrefix);
}

function pipeHttpRequest(req, res, targetUrl) {
  // This is the only HTTP socket-opening path. Recheck at the socket boundary,
  // even if a caller already classified the request.
  if (!isConfiguredImageTarget(targetUrl)) {
    blockHttpProxyRequest(req, res, targetUrl);
    return;
  }
  const requestImpl = targetUrl.protocol === "https:" ? https : http;
  const targetHost = getNumericServiceHost(targetUrl.hostname);
  const targetPort = getUrlPort(targetUrl);

  const headers = { ...req.headers };
  headers.host = targetUrl.host;
  delete headers["proxy-connection"];

  log.proxy(`${req.method} ${targetUrl.href} -> ${targetHost}:${targetPort}`);

  const upstreamReq = requestImpl.request(
    {
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
    },
    (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode || 502;
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (typeof v !== "undefined") {
          res.setHeader(k, v);
        }
      }
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (err) => {
    log.proxyErr(`forward failed ${targetUrl.href} ${err.message}`);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
    }
    res.end("Bad Gateway");
  });

  req.pipe(upstreamReq);
}

function blockHttpProxyRequest(req, res, targetUrl) {
  log.proxy(`block ${req.method} ${targetUrl.href} -> local deny`);
  res.statusCode = 204;
  res.setHeader("x-evejs-proxy-blocked", "true");
  res.end();
}

function isSentryRequest(hostname, routePath) {
  return hostMatchesPattern(hostname, ".sentry.io") ||
    (isLoopbackHost(hostname) &&
      /^\/api\/[^/]+\/(?:store|envelope|minidump)\/?(?:\?|$)/i.test(routePath));
}

function discardSentryHttpRequest(req, res) {
  if (!isSentryRequest(req.headers.host, req.url || "/")) return false;
  req.resume();
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end("{}");
  return true;
}

function loadLocalTlsOptions() {
  adoptLegacyCertificateFilesOnce((message) => log.info(`[TLS] ${message}`));
  const certDir = certificateDirectory();
  const certificateResult = ensureLocalLeafCertificate({ certDir });
  const dnsCertificateResult = ensureLocalLeafCertificate({ certDir, dnsOnly: true });
  const dnsContext = tls.createSecureContext({
    key: dnsCertificateResult.key,
    cert: dnsCertificateResult.cert,
  });

  if (certificateResult.rebuilt) {
    log.debug("rebuilt local public-gateway TLS certificate");
  }
  if (dnsCertificateResult.rebuilt) {
    log.debug("rebuilt local public-gateway DNS TLS certificate");
  }

  return {
    tlsOptions: {
      key: certificateResult.key,
      cert: certificateResult.cert,
      allowHTTP1: true,
      ALPNProtocols: ["h2", "http/1.1"],
      // The gateway's bundled BoringSSL rejects IP SANs under IP name
      // constraints. DNS clients use a DNS-only leaf under the same CA; numeric
      // clients without SNI retain the certificate that covers 127.0.0.1.
      SNICallback(servername, callback) {
        if (!LOCAL_TLS_DNS_ALT_NAMES.includes(String(servername).toLowerCase())) {
          callback(new Error("The requested TLS server name is not an EveJS endpoint."));
          return;
        }
        callback(null, dnsContext);
      },
    },
    certPem: certificateResult.certPem,
  };
}

function createLoopbackCdnRequestHandler(options = {}) {
  const getHealthPayload = typeof options.getHealthPayload === "function"
    ? options.getHealthPayload
    : () => buildHealthPayload(null, null);
  return (req, res) => {
    if (discardSentryHttpRequest(req, res)) return;
    if (handleHealthHttpRequest(req, res, getHealthPayload)) return;
    if (handleFeatureHttpRequest(req, res)) return;
    const routePath = String(req.url || "/");
    const binaryAsset =
      String(req.method || "").toUpperCase() === "GET"
        ? getGatewayBinaryAsset(routePath)
        : null;
    if (binaryAsset) {
      res.writeHead(200, buildBinaryAssetHeaders(binaryAsset));
      res.end(binaryAsset.buffer);
      return;
    }

    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("Not Found");
  };
}

function createLoopbackCdnResponder(
  activeHttpsPort,
  listenPort = 443,
  bindHost = "127.0.0.1",
  options = {},
) {
  if (activeHttpsPort === listenPort) {
    return null;
  }

  const { tlsOptions } = loadLocalTlsOptions();
  const server = https.createServer(
    tlsOptions,
    createLoopbackCdnRequestHandler({
      getHealthPayload: typeof options.getHealthPayload === "function"
        ? options.getHealthPayload
        : () => buildHealthPayload(server, null),
    }),
  );

  server.on("error", (err) => {
    log.http2Err(
      `loopback CDN responder failed on ${bindHost}:${listenPort}: ${err.message}`,
    );
  });
  server.listen(listenPort, bindHost, () => {
    log.debug(
      `loopback CDN responder listening on ${bindHost}:${listenPort}`,
    );
  });
  return server;
}

// A stream's trailers sent once: the first send stands, and any later one is nothing. The 'request' listener below
// (the HTTP/1.1 fallback) has Node's compatibility layer wrap every HTTP/2 stream in a request and a response of its
// own, and that response sends the stream's trailers too when the stream wants them (compat onStreamTrailersReady,
// a 'wantTrailers' listener added after this server's own). Once a gRPC handler here had sent its trailers
// (grpc-status), that second send threw ERR_HTTP2_TRAILERS_ALREADY_SENT out of the event, uncaught, and the server
// went down whenever a client ended or reset a gRPC stream: measured 2026-10-17 on Requests/Send, once closed by
// RST_STREAM and once by a half-close, each leaving a node report with that error and stack.
function sendTrailersOnce(stream) {
  const sendTrailers = stream.sendTrailers;
  let sent = false;
  stream.sendTrailers = function sendTrailersOnceOnly(headers) {
    if (sent) {
      return;
    }
    sent = true;
    return sendTrailers.call(this, headers);
  };
}

function createLocalSecureResponder(httpsPort, bindHost, options = {}) {
  const { tlsOptions, certPem } = loadLocalTlsOptions();
  const handleGatewayStream = typeof options.handleGatewayStream === "function"
    ? options.handleGatewayStream
    : getGatewayStreamHandler();

  try {
    if (certPem) {
      const x509 = new crypto.X509Certificate(certPem);
      log.debug(
        `[local https cert] subject=${x509.subject} issuer=${x509.issuer} validTo=${x509.validTo}`,
      );
    }
  } catch (err) {
    log.http2Err(`cert parse error: ${err.message}`);
  }

  const secureServer = http2.createSecureServer(tlsOptions);
  const getHealthPayload = typeof options.getHealthPayload === "function"
    ? options.getHealthPayload
    : () => buildHealthPayload(null, secureServer);

  secureServer.on("connection", (socket) => {
    log.http2Log(`tcp connect ${socket.remoteAddress}:${socket.remotePort}`);
  });

  secureServer.on("secureConnection", (tlsSocket) => {
    log.http2Log(
      `tls established ${tlsSocket.remoteAddress} ALPN=${tlsSocket.alpnProtocol || "none"}`,
    );
  });

  secureServer.on("stream", (stream, headers) => {
    sendTrailersOnce(stream);
    const method = headers[":method"] || "";
    const routePath = headers[":path"] || "";
    const authority = headers[":authority"] || headers.host || "";
    const contentType = String(headers["content-type"] || "");

    log.http2Log(
      `${method} ${routePath} host=${authority} type=${contentType || "none"}`,
    );

    stream.on("error", (err) => {
      log.http2Err(`stream error: ${err.message}`);
    });

    if (isSentryRequest(authority, routePath)) {
      stream.resume();
      stream.respond({ ":status": 200, "content-type": "application/json" });
      stream.end("{}");
      return;
    }

    if (isHealthRequest(method, routePath)) {
      stream.resume();
      stream.respond({
        ":status": 200,
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      stream.end(JSON.stringify(getHealthPayload()));
      return;
    }

    if (handleFeatureHttp2Stream(stream, headers)) {
      return;
    }

    const binaryAsset =
      method === "GET" ? getGatewayBinaryAsset(routePath) : null;
    if (binaryAsset) {
      stream.respond({
        ":status": 200,
        ...buildBinaryAssetHeaders(binaryAsset),
      });
      stream.end(binaryAsset.buffer);
      return;
    }

    if (
      contentType.includes("application/grpc") &&
      handleGatewayStream(stream, headers)
    ) {
      return;
    }

    let bodyLength = 0;
    stream.on("data", (chunk) => {
      bodyLength += chunk.length;
    });

    stream.on("end", () => {
      log.http2Log(`body ${bodyLength} bytes`);
    });

    if (contentType.includes("application/grpc")) {
      stream.respond(
        {
          ":status": 200,
          "content-type": "application/grpc+proto",
          "grpc-encoding": "identity",
          "grpc-accept-encoding": "identity",
        },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => {
        try {
          stream.sendTrailers({
            "grpc-status": "12",
            "grpc-message": encodeURIComponent(
              `EveJS Elysian local gateway has no handler for ${routePath}`,
            ),
          });
        } catch (err) {
          log.http2Err(`trailer error: ${err.message}`);
        }
      });
      stream.end();
      return;
    }

    stream.respond({
      ":status": 200,
      "content-type": "application/json",
    });
    stream.end(JSON.stringify(makeHttp2Payload(headers)));
  });

  secureServer.on("request", (req, res) => {
    if (Number(req.httpVersionMajor || 0) >= 2) {
      return;
    }

    if (discardSentryHttpRequest(req, res)) return;
    if (handleHealthHttpRequest(req, res, getHealthPayload)) return;

    if (handleFeatureHttpRequest(req, res)) {
      return;
    }

    res.writeHead(200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(makeHttp1Payload(req)));
  });

  secureServer.on("sessionError", (err) => {
    log.http2Err(`session error: ${err.message}`);
  });

  secureServer.on("tlsClientError", (err) => {
    log.http2Err(`tls client error: ${err.message} code=${err.code || "n/a"}`);
  });

  secureServer.on("error", (err) => {
    log.http2Err(`server error: ${err.message}`);
  });

  secureServer.listen(httpsPort, bindHost, () => {
    log.debug(`local https responder listening on ${bindHost}:${httpsPort}`);
  });
  return secureServer;
}

// Node hands the CONNECT socket over unmanaged and rethrows an unlistened
// 'error' event as a fatal uncaught exception. A client vanishing mid-tunnel
// (ECONNRESET) is routine, so the socket needs a listener before the upstream
// connect callback reaches wireTunnel, and on the early reject paths too.
function guardRawSocket(socket, label) {
  if (!socket || typeof socket.on !== "function") {
    return;
  }
  socket.on("error", (err) => {
    log.debug(`[PRX] client socket closed ${label}: ${err.message}`);
    if (!socket.destroyed) {
      socket.destroy();
    }
  });
}

function wireTunnel(clientSocket, upstreamSocket, head, label, options = {}) {
  let upBytes = 0;
  let downBytes = 0;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs)
    ? options.idleTimeoutMs
    : DEFAULT_PROXY_TUNNEL_IDLE_TIMEOUT_MS;

  clientSocket.setNoDelay(true);
  clientSocket.setKeepAlive(true, SOCKET_KEEPALIVE_INITIAL_DELAY_MS);
  clientSocket.setTimeout(0);
  upstreamSocket.setNoDelay(true);
  upstreamSocket.setKeepAlive(true, SOCKET_KEEPALIVE_INITIAL_DELAY_MS);
  upstreamSocket.setTimeout(idleTimeoutMs > 0 ? idleTimeoutMs : 0);

  if (head && head.length > 0) {
    upstreamSocket.write(head);
    upBytes += head.length;
  }

  clientSocket.on("data", (chunk) => {
    upBytes += chunk.length;
  });

  upstreamSocket.on("data", (chunk) => {
    downBytes += chunk.length;
  });

  upstreamSocket.pipe(clientSocket);
  clientSocket.pipe(upstreamSocket);

  if (idleTimeoutMs > 0) {
    upstreamSocket.on("timeout", () => {
      log.proxyErr(`tunnel timeout ${label} ▲${upBytes}B ▼${downBytes}B`);
      upstreamSocket.destroy();
      clientSocket.destroy();
    });
  }

  upstreamSocket.on("close", () => {
    log.proxy(`tunnel closed ${label} ▲${upBytes}B ▼${downBytes}B`);
  });

  upstreamSocket.on("error", (err) => {
    log.proxyErr(`tunnel upstream error ${label} ${err.message}`);
    clientSocket.destroy();
  });

  clientSocket.on("error", (err) => {
    log.proxyErr(`tunnel client error ${label} ${err.message}`);
    upstreamSocket.destroy();
  });
}

function resolveListenUrl() {
  try {
    const listenUrl = new URL(config.microservicesPublicUrl);
    listenUrl.port = String(config.microservicesPort);
    return listenUrl;
  } catch {
    return new URL("http://127.0.0.1:26002/");
  }
}

function resolveBindHost(listenUrl) {
  const configuredBindHost = String(config.microservicesBindHost || "").trim();
  if (configuredBindHost) {
    return configuredBindHost;
  }
  return isLoopbackHost(listenUrl.hostname) ? "127.0.0.1" : listenUrl.hostname;
}

const ENABLE_LOCAL_INTERCEPT = parseBooleanEnv(
  process.env.EVEJS_PROXY_LOCAL_INTERCEPT,
  shouldEnableLocalInterceptByDefault(),
);
const EXPRESS_PROXY_ENABLED = parseBooleanEnv(
  process.env.EVEJS_EXPRESS_PROXY_ENABLED,
  true,
);
const LOOPBACK_CDN_LISTEN_PORT = parseNonNegativeIntegerEnv(
  process.env.EVEJS_PROXY_LOOPBACK_CDN_LISTEN_PORT,
  443,
);
const DEFAULT_PROXY_TUNNEL_IDLE_TIMEOUT_MS = parseNonNegativeIntegerEnv(
  process.env.EVEJS_PROXY_TUNNEL_IDLE_TIMEOUT_MS,
  30_000,
);
const INTERCEPT_PROXY_TUNNEL_IDLE_TIMEOUT_MS = parseNonNegativeIntegerEnv(
  process.env.EVEJS_PROXY_INTERCEPT_TUNNEL_IDLE_TIMEOUT_MS,
  0,
);
const SOCKET_KEEPALIVE_INITIAL_DELAY_MS = parseNonNegativeIntegerEnv(
  process.env.EVEJS_PROXY_SOCKET_KEEPALIVE_INITIAL_DELAY_MS,
  15_000,
);
const LOCAL_INTERCEPT_HOSTS = new Set([
  "sentry.io",
  "dev-public-gateway.evetech.net",
  "public-gateway.evetech.net",
]);
const BLOCKED_PROXY_HOSTS = parseHostPatternList(config.proxyBlockedHosts);

function shouldHandleInterceptLocally() {
  return ENABLE_LOCAL_INTERCEPT;
}

function mountEvejsWebGatewayRoutes(app, runtimeContext) {
  const { mountEvejsWebGateway } = require("./evejsWebGateway");
  mountEvejsWebGateway(app, runtimeContext);
}

function waitForListening(server) {
  if (!server || server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

const openConnectionsByServer = new WeakMap();

// Keeps the server's open sockets so closeServer can end them. The client
// holds its gateway tunnels and HTTP/2 sessions open, so close() alone never
// finished and the shutdown hook ran into its 10 s timeout on every stop.
function trackConnections(server) {
  if (!server) return server;
  const sockets = new Set();
  openConnectionsByServer.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return server;
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    for (const socket of openConnectionsByServer.get(server) || []) socket.destroy();
  });
}

function startServer(runtimeContext, options = {}) {
  const express = require("express");
  const app = express();
  const getHealthPayload = () => buildHealthPayload(loopbackCdnServer, secureServer);

  app.use((req, res, next) => {
    const targetUrl = parseHttpProxyTarget(req);
    if (targetUrl && isSentryRequest(targetUrl.hostname, targetUrl.pathname)) {
      req.resume();
      res.status(200).json({});
      return;
    }
    if (!targetUrl && discardSentryHttpRequest(req, res)) return;
    if (!targetUrl && handleFeatureHttpRequest(req, res)) return;
    if (targetUrl && isBlockedFeatureRequest(targetUrl.hostname, targetUrl.pathname)) {
      req.url = `${targetUrl.pathname}${targetUrl.search}`;
      req.headers.host = targetUrl.host;
      handleFeatureHttpRequest(req, res);
      return;
    }

    if (isConfiguredImageTarget(targetUrl)) {
      pipeHttpRequest(req, res, targetUrl);
      return;
    }

    if (targetUrl && shouldBlockHost(targetUrl.hostname)) {
      blockHttpProxyRequest(req, res, targetUrl);
      return;
    }

    if (targetUrl && ENABLE_LOCAL_INTERCEPT && shouldInterceptHost(targetUrl.hostname)) {
      log.proxy(`intercept ${req.method} ${targetUrl.href} -> local`);
      req.url = `${targetUrl.pathname}${targetUrl.search}`;
      req.headers.host = targetUrl.host;
      if (handleFeatureHttpRequest(req, res)) return;
      next();
      return;
    }

    if (targetUrl) {
      blockHttpProxyRequest(req, res, targetUrl);
      return;
    }

    const loggedUrl = String(req.path || "").startsWith("/playerconnect/")
      ? req.path
      : req.url;
    log.proxy(`${req.method} ${loggedUrl} host=${req.headers.host || "?"}`);
    next();
  });

  app.use(express.json({ limit: "1mb" }));
  // Play checks every indexed resource before launch. A runtime cache miss must
  // fail locally, never turn into a CDN download from this process.
  app.use("/resfiles", (req, res) => {
    req.resume();
    res.status(404).type("text").send("Resource missing from the offline cache. Restore it from your complete client backup and run Play again.");
  });
  mountGatewayBinaryAssetRoutes(app);

  app.get("/health", (req, res) => {
    res.status(200).set("cache-control", "no-store").json(getHealthPayload());
  });

  const { mountPlayerConnectEndpoints } = require("./playerConnectEndpoints");
  mountPlayerConnectEndpoints(app);

  mountEvejsWebGatewayRoutes(app, runtimeContext);

  app.all(/.*/, (req, res) => {
    res.status(200).json(makeResponsePayload(req));
  });

  const listenUrl = options.listenUrl
    ? new URL(String(options.listenUrl))
    : resolveListenUrl();
  const configuredHttpPort = Number(options.httpPort);
  const httpPort = Number.isInteger(configuredHttpPort) &&
    configuredHttpPort >= 0 && configuredHttpPort <= 65_535
    ? configuredHttpPort
    : getUrlPort(listenUrl);
  const httpsPort = httpPort + 1;
  const bindHost = getNumericServiceHost(options.bindHost || resolveBindHost(listenUrl));
  if (!bindHost) {
    throw new Error("EveJS proxy bind host must be a numeric IP address or localhost; DNS is disabled.");
  }

  let secureServer = null;
  let loopbackCdnServer = null;
  if (shouldHandleInterceptLocally()) {
    secureServer = trackConnections(createLocalSecureResponder(httpsPort, bindHost, {
      handleGatewayStream: options.handleGatewayStream,
      getHealthPayload,
    }));
    loopbackCdnServer = trackConnections(createLoopbackCdnResponder(
      httpsPort,
      LOOPBACK_CDN_LISTEN_PORT,
      bindHost,
      { getHealthPayload },
    ));
  }

  const proxyServer = trackConnections(http.createServer(app));
  const {
    mountEvejsWebGatewayUpgrades,
  } = require("./evejsWebGateway");
  const gatewayEventServer = mountEvejsWebGatewayUpgrades(
    proxyServer,
    runtimeContext,
  );

  proxyServer.once("close", () => {
    const gatewayRuntime = runtimeContext && runtimeContext.gatewayRuntime;
    if (gatewayRuntime && typeof gatewayRuntime.shutdown === "function") {
      void Promise.resolve(gatewayRuntime.shutdown()).catch(() => null);
    }
  });

  proxyServer.on("connect", (req, clientSocket, head) => {
    const targetRaw = req.url || "";
    guardRawSocket(clientSocket, targetRaw || "unknown");
    const { host, port } = parseConnectTarget(targetRaw);

    if (!host || !port) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    if (shouldBlockHost(host)) {
      log.proxy(`CONNECT ${targetRaw} -> BLOCKED local policy`);
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
        "Proxy-Agent: EveJS Elysian\r\n" +
        "X-EveJS-Proxy-Blocked: true\r\n" +
        "\r\n",
      );
      clientSocket.destroy();
      return;
    }

    const interceptTarget = ENABLE_LOCAL_INTERCEPT && shouldInterceptHost(host);
    if (!interceptTarget) {
      log.proxy(`CONNECT ${targetRaw} -> BLOCKED unhandled host policy`);
      clientSocket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
        "Proxy-Agent: EveJS Elysian\r\n" +
        "X-EveJS-Proxy-Blocked: true\r\n" +
        "\r\n",
      );
      clientSocket.destroy();
      return;
    }

    // CONNECT never uses any host or port supplied by the client. This socket
    // reaches only the listener created by this EveJS process.
    const connectHost = bindHost === "0.0.0.0" ? "127.0.0.1"
      : bindHost === "::" ? "::1" : bindHost;
    const connectPort = secureServer.address().port;

    log.proxy(`CONNECT ${targetRaw} -> LOCAL ${connectHost}:${connectPort}`);

    const upstreamSocket = net.connect(connectPort, connectHost, () => {
      clientSocket.write(
        "HTTP/1.1 200 Connection Established\r\n" +
        "Proxy-Agent: EveJS Elysian\r\n" +
        "\r\n",
      );

      wireTunnel(
        clientSocket,
        upstreamSocket,
        head,
        `${targetRaw} via ${connectHost}:${connectPort}`,
        {
          idleTimeoutMs: INTERCEPT_PROXY_TUNNEL_IDLE_TIMEOUT_MS,
        },
      );
    });

    upstreamSocket.on("error", (err) => {
      log.proxyErr(`connect failed ${connectHost}:${connectPort} ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      }
      clientSocket.destroy();
    });
  });

  proxyServer.on("error", (err) => {
    log.proxyErr(`server error: ${err.message}`);
  });

  proxyServer.listen(httpPort, bindHost);

  const ready = Promise.all([
    waitForListening(proxyServer),
    waitForListening(secureServer),
    waitForListening(loopbackCdnServer),
  ]).then(() => Object.freeze({
    bindHost,
    http: proxyServer.address(),
    https: secureServer ? secureServer.address() : null,
    loopbackCdn: loopbackCdnServer ? loopbackCdnServer.address() : null,
  }));

  log.debug(
    `express proxy mode: ${shouldHandleInterceptLocally() ? "local intercept enabled" : "unhandled traffic blocked"}`,
  );

  return Object.freeze({
    proxyServer,
    secureServer,
    loopbackCdnServer,
    ready,
    gatewayEventServer,
    async shutdown() {
      for (const stream of clientFeatureStreams) stream.end();
      await gatewayEventServer.shutdown();
      const gatewayRuntime = runtimeContext && runtimeContext.gatewayRuntime;
      if (gatewayRuntime && typeof gatewayRuntime.shutdown === "function") {
        await gatewayRuntime.shutdown();
      }
      await Promise.all([
        closeServer(proxyServer),
        closeServer(secureServer),
        closeServer(loopbackCdnServer),
      ]);
    },
  });
}

let runningServer = null;
let unregisterShutdownHook = null;

module.exports = {
  enabled: EXPRESS_PROXY_ENABLED,
  serviceName: "expressServer",
  exec(runtimeContext, options = {}) {
    // Direct in-process socket ownership is the stable production path. The
    // gateway edge process (server/src/edge/gateway/**) remains in the tree for
    // research and tests but must not be wired back into production startup —
    // its IPC bridge fails the offload roadmap's stability bar. See
    // doc/archive/PUBLIC_GATEWAY_STABILITY_ROLLBACK_2026-08-22.md and
    // doc/archive/GAME_TCP_STABILITY_ROLLBACK_2026-08-09.md for the incident history.
    if (runningServer) return runningServer;
    runningServer = startServer(runtimeContext, options);
    if (!unregisterShutdownHook) {
      const database = require("../../gameStore");
      unregisterShutdownHook = database.registerShutdownHook(
        "express-server",
        () => runningServer.shutdown(),
      );
    }
    void runningServer.ready.then((address) => {
      const httpPort = address.http ? address.http.port : "?";
      log.debug(
        `express server pid=${process.pid} listening on ${address.bindHost}:${httpPort}`,
      );
    }).catch((error) => {
      log.err(`[ExpressServer] startup failed: ${error.message}`);
    });
    return runningServer;
  },
};

module.exports.__testHooks = {
  buildOfflinePolicyStatus,
  buildHealthPayload,
  buildClientFeatureEvaluations,
  handleFeatureHttpRequest,
  hostMatchesPattern,
  isConfiguredImageTarget,
  getNumericServiceHost,
  parseHostPatternList,
  isBlockedFeatureRequest,
  normalizeLaunchDarklyPath,
  isLaunchDarklyPath,
  handleFeatureHttp2Stream,
  shouldBlockHost,
  shouldDenyUnhandledProxyHost,
  discardSentryHttpRequest,
  createLoopbackCdnRequestHandler,
  createLoopbackCdnResponder,
  createLocalSecureResponder,
  getGatewayBinaryAsset,
  loadLocalTlsOptions,
  mountGatewayBinaryAssetRoutes,
  mountEvejsWebGatewayRoutes,
  startServer,
};
