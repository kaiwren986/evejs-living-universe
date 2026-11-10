"use strict";

const { performance } = require("node:perf_hooks");
const zlib = require("node:zlib");

const { marshalDecode } = require("./tcp/utils/marshal");

function decodeMarshalPayload(value, options = {}) {
  const startedAtMs = performance.now();
  const input = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  const compressed = options.inflateZlib === true && input[0] === 0x78;
  const payload = compressed ? zlib.inflateSync(input) : input;
  return {
    compressed,
    decodeMs: performance.now() - startedAtMs,
    decoded: marshalDecode(payload),
    inputBytes: input.length,
    payloadBytes: payload.length,
  };
}

module.exports = {
  decodeMarshalPayload,
};
