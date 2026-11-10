"use strict";

const marshalWorkerPool = require("./marshalWorkerPool");
const { decodeMarshalPayload } = require("./marshalDecodingTasks");

function createInboundMarshalDecoder(options = {}) {
  const pool = options.pool || marshalWorkerPool;

  async function decode(value) {
    const payload = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || []);
    const taskOptions = { inflateZlib: true };
    const plan = pool.plan(
      "unmarshal",
      payload,
      taskOptions,
      { force: true },
    );
    if (plan.mode === "worker") {
      try {
        return {
          ...(await plan.promise),
          mode: "worker",
        };
      } catch (error) {
        const result = decodeMarshalPayload(payload, taskOptions);
        pool.recordInline("fallback", result);
        return { ...result, mode: "inline-fallback" };
      }
    }
    const result = decodeMarshalPayload(payload, taskOptions);
    pool.recordInline(plan.reason, result);
    return { ...result, mode: "inline" };
  }

  return Object.freeze({ decode });
}

const decoder = createInboundMarshalDecoder();

module.exports = {
  decode: decoder.decode,
  _createInboundMarshalDecoderForTests: createInboundMarshalDecoder,
};
