"use strict";

const path = require("node:path");

const {
  serializeError,
} = require(path.join(
  __dirname,
  "../services/_shared/orderedProcessProtocol",
));
const {
  createOrderedProcessClient,
} = require(path.join(
  __dirname,
  "../services/_shared/orderedProcessClient",
));

const EDGE_REQUEST_TOPIC = "edge.request";
const EDGE_RESPONSE_COMMAND = "edge.response";

function createEdgeProcessClient(options = {}) {
  const handleRequest = options.handleRequest;
  if (typeof handleRequest !== "function") {
    throw new TypeError("edge process client requires a request handler");
  }
  const createTransport = typeof options.createTransport === "function"
    ? options.createTransport
    : createOrderedProcessClient;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  let acceptingEdgeRequests = false;
  const inFlightRequests = new Set();
  let transport = null;

  async function dispatchEdgeRequest(event) {
    const requestID = Number(event && event.payload && event.payload.requestID);
    const command = String(event && event.payload && event.payload.command || "").trim();
    if (!Number.isSafeInteger(requestID) || requestID <= 0 || !command) {
      return;
    }
    let response;
    try {
      if (!acceptingEdgeRequests) {
        const error = new Error("edge request owner is shutting down");
        error.code = "EDGE_OWNER_SHUTTING_DOWN";
        throw error;
      }
      const result = await handleRequest(
        command,
        event.payload.payload,
        Object.freeze({
          authorityName: event.authorityName,
          generation: event.generation,
          requestID,
        }),
      );
      response = { ok: true, requestID, result };
    } catch (error) {
      response = {
        error: serializeError(error, "EDGE_OWNER_REQUEST_FAILED"),
        ok: false,
        requestID,
      };
    }
    try {
      await transport.call(EDGE_RESPONSE_COMMAND, response);
    } catch (_) {
      // ignored: the child that issued this request may have exited while the owner was
      // handling it. A response can no longer be delivered in that case, and
      // rejecting the request lane only creates a late unhandled rejection in
      // the parent process.
    }
  }

  function handleEvent(event) {
    if (event.topic === EDGE_REQUEST_TOPIC) {
      // Requests dispatch CONCURRENTLY — the same interleaving these handlers
      // had when the gateway ran inside the owner process (HTTP handlers
      // yielding to each other at their await points). Chaining them onto one
      // promise lane made every queued call wait out the slowest one in front
      // of it, so a single slow bridge call (a mission settlement, a cold map
      // read, a select with a space restore) stalled every flight-status and
      // snapshot poll behind it past its timeout budget — surfacing as bursts
      // of gateway timeouts on a healthy server.
      //
      // Ordering is not part of this contract: every response carries its
      // requestID and the child settles a pending map, so answers may arrive
      // in any order. The child's maxPending cap bounds how many can be in
      // flight. dispatchEdgeRequest contains its own errors; the catch here
      // only keeps an unexpected throw from becoming process-fatal.
      const dispatch = dispatchEdgeRequest(event).catch(() => null);
      inFlightRequests.add(dispatch);
      void dispatch.then(() => inFlightRequests.delete(dispatch));
      return;
    }
    if (onEvent) onEvent(event);
  }

  transport = createTransport({
    ...options,
    onEvent: handleEvent,
  });

  async function start() {
    const child = await transport.start();
    acceptingEdgeRequests = true;
    return child;
  }

  async function shutdown() {
    acceptingEdgeRequests = false;
    await Promise.all([...inFlightRequests]).catch(() => null);
    return transport.shutdown();
  }

  return Object.freeze({
    call: (command, payload, metadata) => transport.call(command, payload, metadata),
    drain: () => transport.drain(),
    getStats: () => transport.getStats(),
    shutdown,
    start,
  });
}

module.exports = {
  EDGE_REQUEST_TOPIC,
  EDGE_RESPONSE_COMMAND,
  createEdgeProcessClient,
};
