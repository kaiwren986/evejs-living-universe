"use strict";

const net = require("net");
const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));

const REQUIRED_MARKET_DAEMON_CAPABILITY = "idempotent-fill-v1";

function normalizePositiveInteger(value, fallback) {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.trunc(numericValue);
  }
  return fallback;
}

function annotateMarketDaemonError(error, details = {}) {
  const annotated = error instanceof Error
    ? error
    : new Error(String(error || "market daemon RPC request failed"));
  if (details.code) annotated.code = details.code;
  if (details.method) annotated.marketDaemonMethod = String(details.method);
  if (details.requestSent !== undefined) {
    annotated.marketDaemonRequestSent = details.requestSent === true;
  }
  if (details.outcomeUnknown !== undefined) {
    annotated.marketDaemonOutcomeUnknown = details.outcomeUnknown === true;
  }
  return annotated;
}

class MarketDaemonClient {
  constructor(options = {}) {
    this.host = String(options.host || config.marketDaemonHost || "127.0.0.1");
    this.port = normalizePositiveInteger(
      options.port || config.marketDaemonPort,
      40111,
    );
    this.connectTimeoutMs = normalizePositiveInteger(
      options.connectTimeoutMs || config.marketDaemonConnectTimeoutMs,
      1500,
    );
    this.requestTimeoutMs = normalizePositiveInteger(
      options.requestTimeoutMs || config.marketDaemonRequestTimeoutMs,
      15000,
    );
    this.retryDelayMs = normalizePositiveInteger(
      options.retryDelayMs || config.marketDaemonRetryDelayMs,
      2000,
    );

    this._socket = null;
    this._buffer = "";
    this._connected = false;
    this._connectingPromise = null;
    this._pendingRequests = new Map();
    this._nextRequestId = 1;
    this._backgroundReconnectEnabled = false;
    this._reconnectTimer = null;
    this._lastConnectFailureLogAt = 0;
    this._compatibilityVerified = false;
    this._compatibilityPromise = null;
  }

  getStatus() {
    return {
      host: this.host,
      port: this.port,
      connected: this._connected && this._isSocketUsable(),
      connecting: Boolean(this._connectingPromise),
      pendingRequests: this._pendingRequests.size,
    };
  }

  startBackgroundConnect() {
    this._backgroundReconnectEnabled = true;
    this._scheduleReconnect(0);
  }

  async startupCheck() {
    await this.ensureConnected();
    await this._ensureCompatible();
    return null;
  }

  async call(method, params = {}, options = {}) {
    try {
      await this.ensureConnected(options);
    } catch (error) {
      throw annotateMarketDaemonError(error, {
        code: error && error.code || "MARKET_DAEMON_CONNECT_FAILED",
        method,
        requestSent: false,
        outcomeUnknown: false,
      });
    }
    if (method !== "Health") {
      try {
        await this._ensureCompatible();
      } catch (error) {
        throw annotateMarketDaemonError(error, {
          code: error && error.code || "MARKET_DAEMON_INCOMPATIBLE",
          method,
          requestSent: false,
          outcomeUnknown: false,
        });
      }
    }
    return this._sendRequest(method, params);
  }

  async _ensureCompatible() {
    if (this._compatibilityVerified) {
      return true;
    }
    if (this._compatibilityPromise) {
      return this._compatibilityPromise;
    }
    this._compatibilityPromise = this._sendRequest("Health", {})
      .then((health) => {
        const capabilities = Array.isArray(health && health.capabilities)
          ? health.capabilities.map(String)
          : [];
        if (!capabilities.includes(REQUIRED_MARKET_DAEMON_CAPABILITY)) {
          throw annotateMarketDaemonError(
            new Error(
              `market daemon is incompatible: missing ` +
                `${REQUIRED_MARKET_DAEMON_CAPABILITY}; rebuild the Docker image`,
            ),
            {
              code: "MARKET_DAEMON_INCOMPATIBLE",
              method: "Health",
              requestSent: false,
              outcomeUnknown: false,
            },
          );
        }
        this._compatibilityVerified = true;
        return true;
      })
      .finally(() => {
        this._compatibilityPromise = null;
      });
    return this._compatibilityPromise;
  }

  async ensureConnected(options = {}) {
    if (this._isSocketUsable()) {
      return;
    }

    if (this._connectingPromise) {
      return this._connectingPromise;
    }

    this._connectingPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection({
        host: this.host,
        port: this.port,
      });
      if (typeof socket.unref === "function") {
        socket.unref();
      }

      let settled = false;
      let timeoutHandle = null;

      const cleanup = () => {
        socket.removeListener("connect", handleConnect);
        socket.removeListener("error", handleError);
        socket.removeListener("close", handleCloseBeforeConnect);
        socket.removeListener("timeout", handleTimeout);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      };

      const finishReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          socket.destroy();
        } catch (destroyError) {
          // ignored: the connection already failed; destroying the socket is cleanup
        }
        this._logConnectFailure(error, options);
        reject(error);
      };

      const handleConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        socket.setNoDelay(true);
        socket.setEncoding("utf8");
        this._buffer = "";
        this._socket = socket;
        this._connected = true;
        this._compatibilityVerified = false;
        this._attachSocket(socket);
        log.info(
          `[MarketDaemonClient] Connected to market daemon RPC at ${this.host}:${this.port}`,
        );
        resolve();
      };

      const handleError = (error) => {
        finishReject(error);
      };

      const handleCloseBeforeConnect = () => {
        finishReject(new Error("market daemon RPC socket closed before connect"));
      };

      const handleTimeout = () => {
        finishReject(
          new Error(
            `market daemon RPC connect timeout after ${this.connectTimeoutMs} ms`,
          ),
        );
      };

      socket.once("connect", handleConnect);
      socket.once("error", handleError);
      socket.once("close", handleCloseBeforeConnect);
      socket.once("timeout", handleTimeout);
      socket.setTimeout(this.connectTimeoutMs);

      timeoutHandle = setTimeout(() => {
        handleTimeout();
      }, this.connectTimeoutMs + 50);
      if (typeof timeoutHandle.unref === "function") {
        timeoutHandle.unref();
      }
    }).finally(() => {
      this._connectingPromise = null;
      if (this._backgroundReconnectEnabled && !this._isSocketUsable()) {
        this._scheduleReconnect(this.retryDelayMs);
      }
    });

    return this._connectingPromise;
  }

  _isSocketUsable() {
    return Boolean(
      this._connected &&
        this._socket &&
        !this._socket.destroyed &&
        this._socket.writable,
    );
  }

  _attachSocket(socket) {
    socket.on("data", (chunk) => {
      this._buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newlineIndex = this._buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = this._buffer.slice(0, newlineIndex).trim();
        this._buffer = this._buffer.slice(newlineIndex + 1);
        if (line) {
          this._handleResponseLine(line);
        }
        newlineIndex = this._buffer.indexOf("\n");
      }
    });

    socket.on("error", (error) => {
      log.warn(`[MarketDaemonClient] RPC socket error: ${error.message}`);
    });

    socket.on("close", () => {
      if (this._socket === socket) {
        this._socket = null;
      }
      const wasConnected = this._connected;
      this._connected = false;
      this._compatibilityVerified = false;
      this._compatibilityPromise = null;
      this._buffer = "";
      this._failPendingRequests(
        new Error("market daemon RPC connection closed"),
      );
      if (wasConnected) {
        log.warn("[MarketDaemonClient] Market daemon RPC connection closed");
      }
      if (this._backgroundReconnectEnabled) {
        this._scheduleReconnect(this.retryDelayMs);
      }
    });
  }

  _handleResponseLine(line) {
    let response = null;
    try {
      response = JSON.parse(line);
    } catch (error) {
      log.warn(
        `[MarketDaemonClient] Failed to parse RPC response line: ${error.message}`,
      );
      return;
    }

    const requestId = String(
      response && Object.prototype.hasOwnProperty.call(response, "id")
        ? response.id
        : "",
    );
    const pendingRequest = this._pendingRequests.get(requestId);
    if (!pendingRequest) {
      return;
    }

    this._pendingRequests.delete(requestId);
    clearTimeout(pendingRequest.timeoutHandle);

    if (response.ok === false) {
      pendingRequest.reject(
        annotateMarketDaemonError(
          new Error(response.error || "market daemon RPC request failed"),
          {
            code: "MARKET_DAEMON_RPC_REJECTED",
            method: pendingRequest.method,
            requestSent: true,
            outcomeUnknown: false,
          },
        ),
      );
      return;
    }

    pendingRequest.resolve(
      Object.prototype.hasOwnProperty.call(response, "result")
        ? response.result
        : null,
    );
  }

  _sendRequest(method, params) {
    if (!this._isSocketUsable()) {
      return Promise.reject(new Error("market daemon RPC connection is not ready"));
    }

    const requestId = String(this._nextRequestId++);
    const payload = JSON.stringify({
      id: requestId,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(
          annotateMarketDaemonError(
            new Error(
              `market daemon RPC request timed out after ${this.requestTimeoutMs} ms`,
            ),
            {
              code: "MARKET_DAEMON_RPC_TIMEOUT",
              method,
              requestSent: true,
              outcomeUnknown: true,
            },
          ),
        );
      }, this.requestTimeoutMs);

      this._pendingRequests.set(requestId, {
        method,
        resolve,
        reject,
        timeoutHandle,
      });

      this._socket.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }

        const pendingRequest = this._pendingRequests.get(requestId);
        if (!pendingRequest) {
          return;
        }

        clearTimeout(timeoutHandle);
        this._pendingRequests.delete(requestId);
        reject(annotateMarketDaemonError(error, {
          code: error && error.code || "MARKET_DAEMON_RPC_WRITE_FAILED",
          method,
          requestSent: true,
          outcomeUnknown: true,
        }));
      });
    });
  }

  _failPendingRequests(error) {
    for (const [requestId, pendingRequest] of this._pendingRequests.entries()) {
      clearTimeout(pendingRequest.timeoutHandle);
      pendingRequest.reject(annotateMarketDaemonError(
        new Error(error && error.message || "market daemon RPC connection closed"),
        {
          code: error && error.code || "MARKET_DAEMON_RPC_CONNECTION_CLOSED",
          method: pendingRequest.method,
          requestSent: true,
          outcomeUnknown: true,
        },
      ));
      this._pendingRequests.delete(requestId);
    }
  }

  _scheduleReconnect(delayMs) {
    if (!this._backgroundReconnectEnabled) {
      return;
    }
    if (this._reconnectTimer || this._isSocketUsable() || this._connectingPromise) {
      return;
    }

    const delay = Math.max(0, Number(delayMs) || 0);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.ensureConnected().catch(() => {
        this._scheduleReconnect(this.retryDelayMs);
      });
    }, delay);
    if (typeof this._reconnectTimer.unref === "function") {
      this._reconnectTimer.unref();
    }
  }

  _logConnectFailure(error, options = {}) {
    if (options && options.suppressConnectFailureLog === true) {
      return;
    }
    const now = Date.now();
    if (now - this._lastConnectFailureLogAt < 10_000) {
      return;
    }
    this._lastConnectFailureLogAt = now;
    log.warn(
      `[MarketDaemonClient] Unable to reach market daemon RPC at ${this.host}:${this.port}: ${error.message}`,
    );
  }
}

const marketDaemonClient = new MarketDaemonClient();

module.exports = {
  MarketDaemonClient,
  marketDaemonClient,
};
