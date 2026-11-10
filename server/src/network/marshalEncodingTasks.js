"use strict";

const zlib = require("node:zlib");
const { performance } = require("node:perf_hooks");
const path = require("node:path");

const { marshalEncode } = require(path.join(
  __dirname,
  "./tcp/utils/marshal",
));

const CRC_HQX_POLY = 0x1021;

function computeSignedAdler32(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const modAdler = 65521;
  let a = 1;
  let b = 0;
  for (let index = 0; index < source.length; index += 1) {
    a = (a + source[index]) % modAdler;
    b = (b + a) % modAdler;
  }
  const unsignedValue = (((b << 16) | a) >>> 0);
  return unsignedValue > 0x7fffffff
    ? unsignedValue - 0x100000000
    : unsignedValue;
}

function computeCrcHqx(buffer, seed = 0) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  let crc = seed & 0xffff;
  for (let index = 0; index < source.length; index += 1) {
    crc ^= source[index] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000
        ? ((crc << 1) ^ CRC_HQX_POLY) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeMarshal(value) {
  const startedAtMs = performance.now();
  const buffer = marshalEncode(value);
  return {
    buffer,
    encodeMs: performance.now() - startedAtMs,
  };
}

function encodeCachedMethodPayload(value, options = {}) {
  const startedAtMs = performance.now();
  const rawPickle = marshalEncode(value);
  const adler32 = computeSignedAdler32(rawPickle);
  const shouldCompress = options.compress === true;
  const compressThresholdBytes = Math.max(
    0,
    Math.trunc(Number(options.compressThresholdBytes) || 0),
  );
  let pickle = rawPickle;
  let compressed = 0;

  if (shouldCompress && rawPickle.length > compressThresholdBytes) {
    try {
      const compressedPickle = zlib.deflateSync(rawPickle, {
        level: Math.trunc(Number(options.compressLevel) || 1),
      });
      if (compressedPickle.length < rawPickle.length) {
        pickle = compressedPickle;
        compressed = 1;
      }
    } catch (error) {
      // ignored: the existing wire contract falls back to the raw marshal payload.
    }
  }

  return {
    adler32,
    pickle: shouldCompress ? pickle : null,
    compressed,
    crcHqx: shouldCompress
      ? computeCrcHqx(pickle, Number(options.crcSeed) || 0)
      : null,
    rawBytes: rawPickle.length,
    outputBytes: shouldCompress ? pickle.length : rawPickle.length,
    encodeMs: performance.now() - startedAtMs,
  };
}

module.exports = {
  computeSignedAdler32,
  computeCrcHqx,
  encodeMarshal,
  encodeCachedMethodPayload,
};
