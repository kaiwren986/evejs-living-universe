"use strict";

function isThenable(value) {
  return Boolean(value && typeof value.then === "function");
}

function buildWriteFailureResult(writeResult) {
  return {
    writeAttempted: true,
    writeCompleted: false,
    readbackAttempted: false,
    readbackAvailable: false,
    writeResult,
    readbackState: null,
  };
}

function buildReadbackResult(writeResult, readbackState) {
  return {
    writeAttempted: true,
    writeCompleted: true,
    readbackAttempted: true,
    readbackAvailable: readbackState != null,
    writeResult,
    readbackState,
  };
}

function readAfterWrite(writeResult, read) {
  if (writeResult && writeResult.success === false) {
    return buildWriteFailureResult(writeResult);
  }

  const readbackState = read(writeResult);
  if (isThenable(readbackState)) {
    return Promise.resolve(readbackState).then((resolvedReadbackState) =>
      buildReadbackResult(writeResult, resolvedReadbackState)
    );
  }
  return buildReadbackResult(writeResult, readbackState);
}

function performDurableWriteAndReadback({
  write,
  read,
  writeArguments = [],
} = {}) {
  if (typeof write !== "function") {
    throw new TypeError("write dependency is required");
  }
  if (typeof read !== "function") {
    throw new TypeError("read dependency is required");
  }

  const writeResult = write(...writeArguments);
  if (isThenable(writeResult)) {
    return Promise.resolve(writeResult).then((resolvedWriteResult) =>
      readAfterWrite(resolvedWriteResult, read)
    );
  }
  return readAfterWrite(writeResult, read);
}

module.exports = { performDurableWriteAndReadback };
