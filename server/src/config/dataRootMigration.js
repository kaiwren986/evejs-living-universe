"use strict";

// Moves what the server used to write inside the checkout (server/logs and the like) into its
// data-root area, once, at server start.
//
// Only when the data root is the default <repo>/_local: an EVEJS_DATA_ROOT that was set on
// purpose (the Docker image, a test, a custom install) is never filled from the checkout. The
// move merges: each entry of the old folder is renamed into the area unless the area already
// has an entry of that name, which stays untouched, and the old entry stays where it was. The
// old folder is removed once it is empty. Nothing is copied or overwritten, and a failure
// leaves files where they were.

const fs = require("fs");
const path = require("path");

const { DATA_ROOT_AREAS, DEFAULT_DATA_ROOT, resolveDataRoot, resolveDataRootPath } = require("./dataRoot");

// Moves legacyDir's entries into the data-root area. Returns a summary; throws only for an
// unknown area, never for the file system:
//   { status: "moved" | "partly-moved" | "nothing-to-move" | "custom-data-root" | "failed",
//     from, to, moved, left, error }
// options.env and options.defaultDataRoot stand in for process.env and <repo>/_local in tests.
function adoptLegacyDataDir(area, legacyDir, options = {}) {
  const env = options.env || process.env;
  const defaultDataRoot = options.defaultDataRoot || DEFAULT_DATA_ROOT;
  resolveDataRootPath(area); // throws on an unknown area
  const from = path.resolve(legacyDir);
  const to = path.join(resolveDataRoot(env), DATA_ROOT_AREAS[area]);
  const summary = { status: "nothing-to-move", from, to, moved: 0, left: [], error: null };

  let entries;
  try {
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
      return summary;
    }
    entries = fs.readdirSync(from);
  } catch (error) {
    return { ...summary, status: "failed", error };
  }
  if (from === to) {
    return summary;
  }
  if (resolveDataRoot(env) !== path.resolve(defaultDataRoot)) {
    return { ...summary, status: "custom-data-root", left: entries };
  }

  try {
    fs.mkdirSync(to, { recursive: true });
  } catch (error) {
    return { ...summary, status: "failed", error, left: entries };
  }
  for (const name of entries) {
    const target = path.join(to, name);
    if (fs.existsSync(target)) {
      summary.left.push(name);
      continue;
    }
    try {
      fs.renameSync(path.join(from, name), target);
      summary.moved += 1;
    } catch (error) {
      summary.left.push(name);
      summary.error = summary.error || error;
    }
  }
  if (summary.left.length === 0) {
    try {
      fs.rmdirSync(from);
    } catch (error) {
      summary.error = summary.error || error;
    }
  }
  if (summary.moved === 0 && summary.left.length > 0) {
    summary.status = summary.error ? "failed" : "partly-moved";
  } else if (summary.moved > 0) {
    summary.status = summary.left.length > 0 ? "partly-moved" : "moved";
  }
  return summary;
}

// One line for the server log, or null when there was nothing to say.
function describeAdoption(label, summary) {
  const { status, from, to, moved, left, error } = summary;
  if (status === "nothing-to-move") {
    return null;
  }
  if (status === "custom-data-root") {
    return `[DataRoot] ${label}: ${from} still has ${left.length} entries; EVEJS_DATA_ROOT is set, so they were not moved to ${to}`;
  }
  const reason = error ? ` (${error.code || error.message})` : "";
  if (status === "moved") {
    return `[DataRoot] ${label}: moved ${moved} entries from ${from} to ${to}`;
  }
  return `[DataRoot] ${label}: moved ${moved} entries from ${from} to ${to}; ` +
    `${left.length} left in ${from} because ${to} already has entries of the same name or they could not be moved${reason}`;
}

module.exports = {
  adoptLegacyDataDir,
  describeAdoption,
};
