"use strict";

const { parentPort } = require("node:worker_threads");
const {
  encodeMarshal,
  encodeCachedMethodPayload,
} = require("./marshalEncodingTasks");
const { decodeMarshalPayload } = require("./marshalDecodingTasks");

function restoreBuffers(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = restoreBuffers(value[index], seen);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    value[key] = restoreBuffers(value[key], seen);
  }
  return value;
}

function transferableBytes(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  return Uint8Array.from(source);
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "task") {
    return;
  }

  const taskId = message.taskId;
  try {
    const value = restoreBuffers(message.value);
    if (message.operation === "marshal") {
      const result = encodeMarshal(value);
      const buffer = transferableBytes(result.buffer);
      parentPort.postMessage(
        {
          type: "result",
          taskId,
          operation: message.operation,
          result: { buffer, encodeMs: result.encodeMs },
        },
        [buffer.buffer],
      );
      return;
    }

    if (message.operation === "cached-method") {
      const result = encodeCachedMethodPayload(value, message.options);
      const pickle = result.pickle ? transferableBytes(result.pickle) : null;
      parentPort.postMessage(
        {
          type: "result",
          taskId,
          operation: message.operation,
          result: { ...result, pickle },
        },
        pickle ? [pickle.buffer] : [],
      );
      return;
    }

    if (message.operation === "unmarshal") {
      const result = decodeMarshalPayload(value, message.options);
      parentPort.postMessage({
        type: "result",
        taskId,
        operation: message.operation,
        result,
      });
      return;
    }

    throw new Error(`unsupported marshal worker operation: ${message.operation}`);
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      taskId,
      operation: message.operation,
      error: error && error.message ? error.message : String(error),
    });
  }
});
