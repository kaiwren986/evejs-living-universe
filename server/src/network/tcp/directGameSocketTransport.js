"use strict";

const DEFAULT_MAX_PAYLOAD_LENGTH = 10_000_000;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * Attach MachoNet's 4-byte little-endian length framing directly to a native
 * game socket. Frames are delivered on a per-socket lane: the next coalesced
 * frame cannot run until the previous frame's state transition has completed.
 *
 * Unlike the retired game-edge bridge, this transport has no cross-player
 * pending-request ceiling and no authority deadline that can destroy a healthy
 * client while the simulation thread is busy.
 *
 * @param {import("node:net").Socket} socket
 * @param {{
 *   handleFrame: (payload: Buffer) => unknown | Promise<unknown>,
 *   maxPayloadLength?: number,
 *   onFrameError?: (error: Error) => void,
 *   onProtocolError?: (error: Error) => void,
 * }} options
 */
function attachDirectGameSocketTransport(socket, options = {}) {
  if (!socket || typeof socket.on !== "function") {
    throw new TypeError("direct game transport requires a socket");
  }
  if (typeof options.handleFrame !== "function") {
    throw new TypeError("direct game transport requires a frame handler");
  }

  const maxPayloadLength = positiveInteger(
    options.maxPayloadLength,
    DEFAULT_MAX_PAYLOAD_LENGTH,
  );
  const onFrameError = typeof options.onFrameError === "function"
    ? options.onFrameError
    : null;
  const onProtocolError = typeof options.onProtocolError === "function"
    ? options.onProtocolError
    : null;

  let buffered = Buffer.alloc(0);
  let bufferedAllocationBytes = 0;
  let closed = false;
  let processing = false;
  let framesProcessed = 0;

  function invokeErrorHandler(handler, error) {
    if (!handler) return;
    try {
      handler(error);
    } catch (_) {
      // ignored: diagnostics must not prevent deterministic socket teardown.
    }
  }

  function detach({ destroySocket = false } = {}) {
    if (closed) return false;
    closed = true;
    buffered = Buffer.alloc(0);
    bufferedAllocationBytes = 0;
    socket.off("data", onData);
    socket.off("close", onSocketClose);
    if (destroySocket && !socket.destroyed && typeof socket.destroy === "function") {
      socket.destroy();
    }
    return true;
  }

  function failProtocol(message, code) {
    const error = new Error(message);
    error.code = code;
    invokeErrorHandler(onProtocolError, error);
    detach({ destroySocket: true });
  }

  function failFrame(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    normalized.code = normalized.code || "GAME_FRAME_PROCESSING_FAILED";
    invokeErrorHandler(onFrameError, normalized);
    detach({ destroySocket: true });
  }

  function consumeBufferedPrefix(consumedBytes) {
    const remainingBytes = buffered.length - consumedBytes;
    if (remainingBytes <= 0) {
      buffered = Buffer.alloc(0);
      bufferedAllocationBytes = 0;
      return;
    }

    const remainder = buffered.subarray(consumedBytes);
    // A tiny incomplete next frame must not keep a multi-megabyte frame's
    // backing allocation alive. Compact whenever unread bytes fall below half
    // of the last allocation's logical size. Remembering that allocation size
    // across subarray views makes repeated coalesced frames compact
    // geometrically instead of copying the whole remainder after every frame.
    if (remainingBytes * 2 <= bufferedAllocationBytes) {
      buffered = Buffer.from(remainder);
      bufferedAllocationBytes = remainingBytes;
    } else {
      buffered = remainder;
    }
  }

  async function processBufferedFrames() {
    if (processing || closed) return;
    if (socket.destroyed) {
      detach();
      return;
    }
    processing = true;
    try {
      while (!closed && !socket.destroyed && buffered.length >= 4) {
        const payloadLength = buffered.readUInt32LE(0);
        if (payloadLength <= 0 || payloadLength > maxPayloadLength) {
          failProtocol(
            `invalid game payload length: ${payloadLength}`,
            "GAME_FRAME_LENGTH_INVALID",
          );
          return;
        }

        const totalLength = 4 + payloadLength;
        if (buffered.length < totalLength) break;

        const payload = Buffer.from(buffered.subarray(4, totalLength));
        consumeBufferedPrefix(totalLength);
        try {
          await options.handleFrame(payload);
          framesProcessed += 1;
          if (socket.destroyed) {
            detach();
            return;
          }
        } catch (error) {
          if (closed || socket.destroyed) {
            detach();
            return;
          }
          failFrame(error);
          return;
        }
      }
    } finally {
      processing = false;
      if (!closed && !socket.destroyed && typeof socket.resume === "function") {
        socket.resume();
      }
    }
  }

  function onData(chunk) {
    if (closed) return;
    if (socket.destroyed) {
      detach();
      return;
    }
    if (typeof socket.pause === "function") socket.pause();
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    buffered = buffered.length === 0
      ? Buffer.from(incoming)
      : Buffer.concat([buffered, incoming]);
    bufferedAllocationBytes = buffered.length;
    void processBufferedFrames();
  }

  function onSocketClose() {
    detach();
  }

  socket.on("data", onData);
  socket.once("close", onSocketClose);

  return Object.freeze({
    close() {
      return detach({ destroySocket: true });
    },
    getSnapshot() {
      return Object.freeze({
        bufferCapacityBytes:
          buffered.length === 0 ? 0 : buffered.buffer.byteLength,
        bufferedBytes: buffered.length,
        closed,
        framesProcessed,
        maxPayloadLength,
        processing,
      });
    },
  });
}

module.exports = {
  attachDirectGameSocketTransport,
  DEFAULT_MAX_PAYLOAD_LENGTH,
};
