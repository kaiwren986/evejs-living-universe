"use strict";

const {
  MESSAGE_KIND,
  buildMessage,
  isProtocolMessage,
  serializeError,
} = require("./orderedProcessProtocol");
const { performance } = require("node:perf_hooks");

function createOrderedProcessHost(options = {}) {
  const authorityName = String(options.authorityName || "").trim();
  const handleCommand = options.handleCommand;
  const processRef = options.processRef || process;
  const exitOnClose = options.exitOnClose !== false;
  if (!authorityName || typeof handleCommand !== "function") {
    throw new TypeError("ordered process host requires an authority name and command handler");
  }
  if (
    !processRef ||
    typeof processRef.on !== "function" ||
    typeof processRef.send !== "function"
  ) {
    throw new TypeError("ordered process host requires an IPC process");
  }

  let accepting = false;
  let closing = false;
  let closed = false;
  let expectedSequence = 1;
  let lane = Promise.resolve();
  let committedSequence = 0;
  let queuedCount = 0;
  let closePromise = null;
  const waitForBootstrap = options.waitForBootstrap === true;
  let bootstrapReceived = !waitForBootstrap;
  let resolveBootstrap = null;
  const bootstrapReady = waitForBootstrap
    ? new Promise((resolve) => {
      resolveBootstrap = resolve;
    })
    : Promise.resolve(undefined);

  function send(message) {
    if (closed || processRef.connected === false) {
      return false;
    }
    try {
      processRef.send(message);
      return true;
    } catch (_) {
      // ignored: false tells the caller the channel is closed and nothing was sent
      return false;
    }
  }

  function publish(topic, payload, metadata = {}) {
    const normalizedTopic = String(topic || "").trim();
    if (!normalizedTopic) {
      throw new TypeError("authority events require a topic");
    }
    return send(buildMessage(MESSAGE_KIND.EVENT, {
      authorityName,
      topic: normalizedTopic,
      payload,
      sequence: Number(metadata.sequence || committedSequence) || 0,
    }));
  }

  async function executeRequest(message, queuedAtMs) {
    const requestId = Number(message.requestId);
    const sequence = Number(message.sequence);
    if (
      !Number.isSafeInteger(requestId) || requestId <= 0 ||
      !Number.isSafeInteger(sequence) || sequence <= 0 ||
      typeof message.command !== "string" || !message.command.trim()
    ) {
      const error = new Error("Authority request envelope is invalid");
      error.code = "AUTHORITY_REQUEST_INVALID";
      send(buildMessage(MESSAGE_KIND.RESPONSE, {
        authorityName,
        requestId,
        sequence,
        ok: false,
        error: serializeError(error),
      }));
      return;
    }
    if (sequence !== expectedSequence) {
      const error = new Error(
        `Authority sequence mismatch: expected ${expectedSequence}, received ${sequence}`,
      );
      error.code = "AUTHORITY_SEQUENCE_MISMATCH";
      send(buildMessage(MESSAGE_KIND.RESPONSE, {
        authorityName,
        requestId,
        sequence,
        ok: false,
        error: serializeError(error),
      }));
      return;
    }

    expectedSequence += 1;
    const startedAtMs = performance.now();
    const startedAtUnixMs = Date.now();
    const queueMs = Math.max(0, startedAtMs - queuedAtMs);
    send(buildMessage(MESSAGE_KIND.STARTED, {
      authorityName,
      requestId,
      sequence,
      queueMs,
      startedAtUnixMs,
    }));
    try {
      const result = await handleCommand(
        String(message.command),
        message.payload,
        Object.freeze({
          authorityName,
          requestId,
          sequence,
          metadata: message.metadata && typeof message.metadata === "object"
            ? message.metadata
            : {},
          publish(topic, payload) {
            return publish(topic, payload, { sequence });
          },
        }),
      );
      committedSequence = sequence;
      send(buildMessage(MESSAGE_KIND.RESPONSE, {
        authorityName,
        requestId,
        sequence,
        ok: true,
        result,
        timing: {
          queueMs,
          executionMs: Math.max(0, performance.now() - startedAtMs),
        },
      }));
    } catch (error) {
      send(buildMessage(MESSAGE_KIND.RESPONSE, {
        authorityName,
        requestId,
        sequence,
        ok: false,
        error: serializeError(error),
        timing: {
          queueMs,
          executionMs: Math.max(0, performance.now() - startedAtMs),
        },
      }));
    }
  }

  function enqueueRequest(message) {
    if (!accepting || closing || closed) {
      const error = new Error("Authority process is shutting down");
      error.code = "AUTHORITY_SHUTTING_DOWN";
      send(buildMessage(MESSAGE_KIND.RESPONSE, {
        authorityName,
        requestId: Number(message && message.requestId) || 0,
        sequence: Number(message && message.sequence) || 0,
        ok: false,
        error: serializeError(error),
      }));
      return;
    }
    queuedCount += 1;
    const queuedAtMs = performance.now();
    lane = lane
      .then(() => executeRequest(message, queuedAtMs))
      .finally(() => {
        queuedCount = Math.max(0, queuedCount - 1);
      });
  }

  function finishClose(fields, exitCode) {
    send(buildMessage(MESSAGE_KIND.CLOSED, {
      authorityName,
      committedSequence,
      ...fields,
    }));
    closed = true;
    if (typeof processRef.disconnect === "function" && processRef.connected !== false) {
      try {
        processRef.disconnect();
      } catch (_) {
        // ignored: the close acknowledgment is already queued; an IPC teardown race
        // must not transform a successful durable shutdown into a false error.
      }
    }
    if (exitOnClose) {
      setImmediate(() => processRef.exit(exitCode));
    }
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }
    closing = true;
    accepting = false;
    closePromise = (async () => {
      await lane.catch(() => null);
      try {
        let shutdownResult = null;
        if (typeof options.onShutdown === "function") {
          shutdownResult = await options.onShutdown({ committedSequence, queuedCount });
        }
        if (
          shutdownResult &&
          typeof shutdownResult === "object" &&
          shutdownResult.success === false
        ) {
          const failedTables = Array.isArray(shutdownResult.results)
            ? shutdownResult.results
              .filter((entry) => entry && entry.success === false)
              .map((entry) => (
                `${String(entry.table || "unknown")}:` +
                `${String(entry.errorMsg || "flush failed")}`
              ))
            : [];
          const error = new Error(
            String(shutdownResult.errorMsg || "Authority shutdown flush failed") +
              (failedTables.length ? ` (${failedTables.join(", ")})` : ""),
          );
          error.code = String(
            shutdownResult.code || "AUTHORITY_SHUTDOWN_FLUSH_FAILED",
          );
          throw error;
        }
        finishClose({}, 0);
        return null;
      } catch (error) {
        // A durable owner must never acknowledge a clean close after its final
        // flush failed. Send a typed negative close so the parent can surface
        // the failure immediately, then leave a non-zero lifecycle exit.
        finishClose({
          shutdownError: serializeError(error, "AUTHORITY_SHUTDOWN_FAILED"),
        }, 1);
        return null;
      }
    })();
    return closePromise;
  }

  function onMessage(message) {
    if (isProtocolMessage(message, MESSAGE_KIND.BOOTSTRAP)) {
      if (
        waitForBootstrap &&
        !bootstrapReceived &&
        !closing &&
        !closed &&
        message.authorityName === authorityName
      ) {
        bootstrapReceived = true;
        const resolve = resolveBootstrap;
        resolveBootstrap = null;
        resolve(message.bootstrapPayload);
      }
      return;
    }
    if (isProtocolMessage(message, MESSAGE_KIND.REQUEST)) {
      enqueueRequest(message);
      return;
    }
    if (isProtocolMessage(message, MESSAGE_KIND.SHUTDOWN)) {
      void close();
    }
  }

  processRef.on("message", onMessage);
  processRef.on("disconnect", () => {
    void close();
  });

  const ready = bootstrapReady
    .then((bootstrapPayload) => (
      typeof options.onStart === "function"
        ? options.onStart({ authorityName, bootstrapPayload, publish })
        : null
    ))
    .then(() => {
      if (closing || closed) {
        return false;
      }
      accepting = true;
      send(buildMessage(MESSAGE_KIND.READY, {
        authorityName,
        pid: Number(processRef.pid) || null,
      }));
      return true;
    })
    .catch((error) => {
      send(buildMessage(MESSAGE_KIND.CLOSED, {
        authorityName,
        startupError: serializeError(error, "AUTHORITY_START_FAILED"),
      }));
      closed = true;
      if (exitOnClose) {
        setImmediate(() => processRef.exit(1));
      }
      // The structured CLOSED message is the startup failure contract. The
      // returned ready promise is commonly not retained by worker entrypoints;
      // rethrowing here turns an already-reported refusal into a second,
      // process-global unhandled rejection and duplicate diagnostic report.
      return false;
    });

  return Object.freeze({
    close,
    publish,
    ready,
    getDiagnostics() {
      return Object.freeze({
        accepting,
        authorityName,
        bootstrapReceived,
        closing,
        closed,
        committedSequence,
        expectedSequence,
        queuedCount,
        waitForBootstrap,
      });
    },
  });
}

module.exports = {
  createOrderedProcessHost,
};
