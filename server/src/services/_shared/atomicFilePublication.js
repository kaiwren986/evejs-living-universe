"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Resolve and validate a publication target. Atomic stages always live beside
 * their destination so the final rename stays on the same filesystem.
 */
function resolvePublicationTarget(filePath) {
  const targetPath = path.resolve(String(filePath || ""));
  if (!filePath || targetPath === path.parse(targetPath).root) {
    throw new TypeError("atomic file publication requires a file path");
  }
  return targetPath;
}

function createAtomicFileStageSync(filePath, populateTemporaryFile) {
  const targetPath = resolvePublicationTarget(filePath);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath =
    `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor = null;
  let state = "staging";
  try {
    descriptor = fs.openSync(temporaryPath, "wx");
    populateTemporaryFile(descriptor, temporaryPath);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    state = "staged";
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch (_) {
        // ignored: the write already failed; closing the temporary file is cleanup
      }
    }
    if (state === "staging") {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (_) {
        // ignored: the write already failed; removing the temporary file is cleanup
      }
    }
  }

  return Object.freeze({
    targetPath,
    temporaryPath,
    publish() {
      if (state !== "staged") {
        throw new Error(
          `atomic file stage for ${targetPath} is no longer publishable`,
        );
      }
      fs.renameSync(temporaryPath, targetPath);
      state = "published";
      return targetPath;
    },
    discard() {
      if (state !== "staged") return false;
      let removed = true;
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        removed = Boolean(error && error.code === "ENOENT");
      }
      state = "discarded";
      return removed;
    },
  });
}

/**
 * Stage one complete file without publishing it. Callers may perform a
 * durable authorization check after the comparatively expensive write/fsync,
 * then invoke publish() inside that authorization boundary.
 */
function stageFileAtomicSync(filePath, contents) {
  return createAtomicFileStageSync(filePath, (descriptor) => {
    fs.writeFileSync(descriptor, contents);
  });
}

/** Stage a byte-for-byte copy for later atomic publication. */
function stageFileCopyAtomicSync(sourcePath, filePath) {
  const resolvedSourcePath = path.resolve(String(sourcePath || ""));
  if (!sourcePath || resolvedSourcePath === path.parse(resolvedSourcePath).root) {
    throw new TypeError("atomic file copy requires a source file path");
  }
  return createAtomicFileStageSync(filePath, (descriptor) => {
    fs.writeFileSync(descriptor, fs.readFileSync(resolvedSourcePath));
  });
}

/**
 * Publish one complete file without exposing a truncated destination to
 * concurrent readers.
 */
function publishFileAtomicSync(filePath, contents) {
  const stage = stageFileAtomicSync(filePath, contents);
  try {
    return stage.publish();
  } finally {
    stage.discard();
  }
}

module.exports = {
  publishFileAtomicSync,
  stageFileAtomicSync,
  stageFileCopyAtomicSync,
};
