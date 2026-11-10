"use strict";

const path = require("node:path");

const {
  deserializeError,
} = require(path.join(
  __dirname,
  "../services/_shared/orderedProcessProtocol",
));
const {
  createOrderedProcessHost,
} = require(path.join(
  __dirname,
  "../services/_shared/orderedProcessHost",
));
const {
  EDGE_REQUEST_TOPIC,
  EDGE_RESPONSE_COMMAND,
} = require(path.join(__dirname, "edgeProcessClient"));

const DEFAULT_MAX_PENDING = 128;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * What fraction of the request deadline the OLDEST queued request may have been
 * waiting before this stops admitting new ones.
 *
 * ---------------------------------------------------------------------------
 * WHY ADMISSION CONTROL IS NOT THE SAME AS A QUEUE LIMIT
 *
 * `maxPending` bounds how many requests may be outstanding. That protects
 * memory, and nothing else — because the queue is only full in the one case
 * where the count no longer describes the problem. When the owner stops
 * answering, the queue does not fill up and start refusing; it fills up SLOWLY,
 * and every request already in it sits until its own deadline expires. A caller
 * then waits the full timeout to be told something that was already knowable
 * the moment it asked.
 *
 * That wait is not free. Upstream of here it is an HTTP request, a socket, and
 * — for a browser, which opens about six connections per origin — one sixth of
 * everything that tab can do, held for the duration. Enough of them and the
 * page stops being able to send anything at all, which is a much larger failure
 * than the one that started it, and one whose symptoms point somewhere else
 * entirely.
 *
 * So the signal is not "how many are queued" but "IS THE QUEUE DRAINING". If
 * the request at the FRONT has been waiting longer than half the deadline, the
 * owner is not keeping up, and something joining the back now has less than half
 * its budget left to be answered in. Refusing it immediately is both more useful
 * and more honest: the caller learns the truth at once, and gets its connection
 * back to do something else with.
 *
 * ⚠ HALF, NOT ALL. The cutoff has to leave room for the answer itself. A cutoff
 * at the full deadline would admit requests that are already certain to time
 * out, which is the behaviour this replaces.
 *
 * It clears itself: the moment the front of the queue is answered, admission
 * resumes. Nothing has to notice the recovery or reset anything.
 */
const ADMISSION_CUTOFF_FRACTION = 0.5;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function keepRejectionHandled(promise) {
  // Callers still receive and can await the original rejecting promise. The
  // attached derivative only prevents a fire-and-forget owner request from
  // becoming process-fatal before a caller has a chance to observe it.
  void promise.catch(() => null);
  return promise;
}

function createEdgeProcessHost(options = {}) {
  const authorityName = String(options.authorityName || "").trim();
  if (!authorityName) {
    throw new TypeError("edge process host requires an authority name");
  }
  const maxPending = positiveInteger(options.maxPending, DEFAULT_MAX_PENDING);
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  let publishEvent = null;
  let acceptingOwnerResponses = false;
  let executingParentCommand = false;
  let nextRequestID = 1;
  const pending = new Map();
  const monotonicNow = typeof options.now === "function"
    ? options.now
    : () => Date.now();
  const admissionCutoffMs = Math.max(
    1,
    Math.round(requestTimeoutMs * ADMISSION_CUTOFF_FRACTION),
  );

  /**
   * How long the request at the FRONT of the queue has been waiting, in ms.
   *
   * The Map preserves insertion order, so the first entry is the oldest still
   * outstanding. Zero when nothing is queued.
   */
  function oldestPendingWaitMs() {
    for (const entry of pending.values()) {
      return Math.max(0, monotonicNow() - entry.queuedAtMs);
    }
    return 0;
  }

  function settle(requestID, outcome) {
    const entry = pending.get(requestID);
    if (!entry) return false;
    pending.delete(requestID);
    clearTimeout(entry.timeout);
    if (outcome.ok) entry.resolve(outcome.result);
    else entry.reject(outcome.error);
    return true;
  }

  function rejectPending(error) {
    for (const requestID of [...pending.keys()]) {
      settle(requestID, { error, ok: false });
    }
  }

  function request(command, payload = {}) {
    const normalizedCommand = String(command || "").trim();
    if (!normalizedCommand) {
      return keepRejectionHandled(
        Promise.reject(new TypeError("edge owner command is required")),
      );
    }
    if (executingParentCommand) {
      const error = new Error(
        "edge owner requests cannot be awaited from a parent command handler",
      );
      error.code = "EDGE_OWNER_REQUEST_DEADLOCK";
      return keepRejectionHandled(Promise.reject(error));
    }
    if (!acceptingOwnerResponses || !publishEvent) {
      const error = new Error("edge owner bridge is not ready");
      error.code = "EDGE_OWNER_NOT_READY";
      return keepRejectionHandled(Promise.reject(error));
    }
    if (pending.size >= maxPending) {
      const error = new Error(`edge owner queue is full (${maxPending})`);
      error.code = "EDGE_OWNER_OVERLOADED";
      return keepRejectionHandled(Promise.reject(error));
    }
    const frontWaitMs = oldestPendingWaitMs();
    if (frontWaitMs >= admissionCutoffMs) {
      // The queue is not draining. See ADMISSION_CUTOFF_FRACTION: this request
      // cannot be answered inside its deadline, so saying so now is strictly
      // better than holding the caller's connection to say it later.
      const error = new Error(
        `edge owner is not draining its queue (oldest request waiting ${frontWaitMs} ms, ` +
        `${pending.size} outstanding)`,
      );
      error.code = "EDGE_OWNER_OVERLOADED";
      return keepRejectionHandled(Promise.reject(error));
    }
    const requestID = nextRequestID;
    nextRequestID += 1;
    return keepRejectionHandled(new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(
          `edge owner request timed out after ${requestTimeoutMs} ms`,
        );
        error.code = "EDGE_OWNER_REQUEST_TIMEOUT";
        settle(requestID, { error, ok: false });
      }, requestTimeoutMs);
      pending.set(requestID, {
        queuedAtMs: monotonicNow(),
        reject,
        resolve,
        timeout,
      });
      const published = publishEvent(EDGE_REQUEST_TOPIC, {
        command: normalizedCommand,
        payload,
        requestID,
      });
      if (!published) {
        const error = new Error("edge owner request could not be published");
        error.code = "EDGE_OWNER_DISCONNECTED";
        settle(requestID, { error, ok: false });
      }
    }));
  }

  const host = createOrderedProcessHost({
    authorityName,
    exitOnClose: options.exitOnClose,
    processRef: options.processRef,
    async handleCommand(command, payload, context) {
      if (command === EDGE_RESPONSE_COMMAND) {
        const requestID = Number(payload && payload.requestID);
        if (!Number.isSafeInteger(requestID) || requestID <= 0) {
          throw new Error("edge response request ID is invalid");
        }
        const settled = payload && payload.ok === true
          ? settle(requestID, { ok: true, result: payload.result })
          : settle(requestID, {
            error: deserializeError(
              payload && payload.error,
              "EDGE_OWNER_REQUEST_FAILED",
            ),
            ok: false,
          });
        return { requestID, settled };
      }
      if (typeof options.handleCommand !== "function") {
        const error = new Error(`Unknown edge process command: ${command}`);
        error.code = "EDGE_PROCESS_COMMAND_UNKNOWN";
        throw error;
      }
      executingParentCommand = true;
      try {
        return await options.handleCommand(command, payload, context);
      } finally {
        executingParentCommand = false;
      }
    },
    async onShutdown(context) {
      acceptingOwnerResponses = false;
      const error = new Error("edge process is shutting down");
      error.code = "EDGE_PROCESS_SHUTTING_DOWN";
      rejectPending(error);
      if (typeof options.onShutdown === "function") {
        await options.onShutdown(context);
      }
    },
    async onStart(context) {
      publishEvent = context.publish;
      if (typeof options.onStart === "function") {
        await options.onStart(Object.freeze({
          ...context,
          request,
        }));
      }
      acceptingOwnerResponses = true;
    },
  });

  return Object.freeze({
    close: host.close,
    getDiagnostics() {
      return Object.freeze({
        ...host.getDiagnostics(),
        acceptingOwnerResponses,
        // ⚠ REPORTED, not merely enforced. Saturation that only shows up as
        // failed requests is found by users first; these two numbers say the
        // owner is falling behind while everything still works, and they are
        // what a health probe should be reading.
        admissionCutoffMs,
        maxPending,
        oldestPendingWaitMs: oldestPendingWaitMs(),
        pendingOwnerRequests: pending.size,
        sheddingOwnerRequests: oldestPendingWaitMs() >= admissionCutoffMs,
      });
    },
    publish: host.publish,
    ready: host.ready,
    request,
  });
}

module.exports = {
  createEdgeProcessHost,
};
