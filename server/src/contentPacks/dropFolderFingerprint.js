"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Adapted from ciefa/evejs-ciefa-fork df2f91743. Hash every time: a same-size
// edit can preserve mtime even long after a write has supposedly settled.
// Streaming keeps the steady-state startup check independent of pack size in RAM.
function fingerprintFolder(directory, names) {
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  return names.map((name) => {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(path.join(directory, name), "r");
    let size = 0;
    try {
      for (;;) {
        const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (bytes === 0) break;
        hash.update(chunk.subarray(0, bytes));
        size += bytes;
      }
    } finally {
      fs.closeSync(fd);
    }
    return JSON.stringify([name, size, hash.digest("hex")]);
  });
}

module.exports = { fingerprintFolder };
