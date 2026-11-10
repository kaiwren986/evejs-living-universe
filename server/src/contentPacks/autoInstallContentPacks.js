"use strict";

/**
 * INSTALLING THE SHIPPED CONTENT PACKS AT STARTUP.
 *
 * A release ships its packs in content-packs/ and the server installs whatever
 * is in there. The folder is the source of truth: to run without a pack, delete
 * its file. Anything removed another way comes back on the next start, which is
 * the deliberate trade for never having to explain pack installation to anyone.
 *
 * THE NEWEST VERSION WINS
 *
 * The folder decides which packs are on, but it never moves one backwards. If a
 * newer version of a pack is already installed than the folder offers -- one
 * installed by hand, or brought by an earlier release -- the newer version stays
 * and the log says so. Two versions in the folder resolve the same way. Going
 * back to an older version is a deliberate ContentPacks.bat rollback.
 *
 * WHY THIS IS GUARDED
 *
 * Re-importing when nothing has changed is not free -- it is slower than the
 * first install, because every pack is read and hashed and then compared against
 * the stored copy. With the packs at 232 MB that measured 56 seconds, against 34
 * for a cold install. Adding that to every boot would be indefensible, so a
 * fingerprint of the drop folder and the registry is recorded after each run and
 * the whole thing is skipped while both still match. The steady-state check
 * streams the raw bytes; it never parses packs merely to recognize a touch.
 *
 * The fingerprint covers the registry as well as the folder, so a pack removed
 * with ContentPacks.bat is noticed and reinstated rather than silently staying
 * gone until someone touches the folder.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fingerprintFolder } = require("./dropFolderFingerprint");

const {
  importContentPackDirectory,
  readRegistry,
  removeContentPack,
  resolveContentPacksRoot,
  contentPackCompatibility,
} = require(path.join(__dirname, "contentPackManager"));

const DROP_DIRECTORY = path.resolve(__dirname, "../../..", "content-packs");
const MARKER_NAME = ".auto-install.json";
const MARKER_SCHEMA = "evejs.content-pack-auto-install.v2";

function listPackFiles(directory) {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

function fingerprintRegistry(options) {
  try {
    return readRegistry(options).installed
      .map((entry) => {
        const stored = path.join(resolveContentPacksRoot(options), "packs", entry.id, entry.version, "pack.json");
        return `${entry.id}@${entry.version}:${entry.packSha256}:${fs.existsSync(stored) ? "present" : "missing"}`;
      })
      .sort();
  } catch (_error) {
    // ignored: an unreadable registry is the content-pack manager's problem to report,
    // not something to swallow into a fingerprint that then matches nothing.
    return null;
  }
}

function markerPath(options) {
  return path.join(resolveContentPacksRoot(options), MARKER_NAME);
}

function readMarker(options) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(options), "utf8"));
    if (parsed && parsed.schema === MARKER_SCHEMA && typeof parsed.compatibility === "string") return parsed;
  } catch (_error) {
    // ignored: no marker, or an unreadable one: treat as "never run"
  }
  return null;
}

function writeMarker(options, folder, registry, compatibility) {
  const target = markerPath(options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.writing-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      schema: MARKER_SCHEMA,
      comment: "Recognizes unchanged bytes and the engine rules that checked them. Safe to delete.",
      installedAt: new Date().toISOString(),
      compatibility,
      folder,
      registry,
    }, null, 2), { flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_error) { /* preserve the write error */ }
  }
}

function sameFingerprint(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

/**
 * @param {object} [options] passed through to the content-pack manager
 * @param {string} [options.dropDirectory] where the shipped packs live
 */
function autoInstallContentPacks(options = {}) {
  const directory = options.dropDirectory
    ? path.resolve(options.dropDirectory)
    : DROP_DIRECTORY;

  const outcome = {
    directory,
    ran: false,
    reason: "",
    installed: [],
    updated: [],
    removed: [],
    skippedOlderVersions: [],
    keptNewer: [],
    failed: [],
  };

  // A missing folder means nothing can be concluded -- an older installation
  // simply never had one -- so nothing is touched. An empty folder is different:
  // somebody deleted the files, which is how a pack is turned off, so that runs
  // and clears the registry out.
  const names = listPackFiles(directory);
  if (names === null) {
    outcome.reason = "no content-packs folder";
    return outcome;
  }

  const folder = fingerprintFolder(directory, names);
  const compatibility = JSON.stringify(contentPackCompatibility(options));
  const registryBefore = fingerprintRegistry(options);
  const marker = readMarker(options);
  if (
    marker &&
    marker.compatibility === compatibility &&
    registryBefore !== null &&
    sameFingerprint(marker.folder, folder) &&
    sameFingerprint(marker.registry, registryBefore)
  ) {
    outcome.reason = "already in step with the content-packs folder";
    return outcome;
  }

  outcome.ran = true;
  const started = performance.now();
  const result = importContentPackDirectory(directory, options);
  outcome.stats = { ...result.stats, elapsedMs: Math.round(performance.now() - started) };
  for (const entry of result.results) {
    if (!entry.ok) {
      outcome.failed.push({ file: entry.file, code: entry.code, message: entry.message });
    } else if (entry.action === "skipped") {
      outcome.skippedOlderVersions.push({
        file: entry.file,
        id: entry.id,
        version: entry.version,
        newerVersion: entry.newerVersion,
      });
    } else if (entry.action === "kept") {
      outcome.keptNewer.push({
        file: entry.file,
        id: entry.id,
        version: entry.version,
        installedVersion: entry.installedVersion,
      });
    } else if (entry.action === "updated" || entry.action === "replaced") {
      outcome.updated.push(`${entry.id}@${entry.version}`);
    } else if (entry.action === "installed") {
      outcome.installed.push(`${entry.id}@${entry.version}`);
    }
  }

  // Deleting a pack file is how somebody turns a pack off, so a pack the folder
  // no longer offers has to come back out of the registry -- otherwise the file
  // is gone and the content is still live. removeContentPack only deactivates:
  // the stored copy stays, so putting the file back reinstates it.
  //
  // Not attempted when a file failed to identify. Its pack id is unknown, so it
  // would look absent and get removed on the strength of a corrupt download.
  const finalNames = listPackFiles(directory);
  const folderUnchanged = finalNames !== null &&
    sameFingerprint(folder, fingerprintFolder(directory, finalNames));
  if (outcome.failed.length === 0 && folderUnchanged) {
    const offered = new Set(result.results.filter((entry) => entry.ok).map((entry) => entry.id));
    for (const entry of readRegistry(options).installed) {
      if (offered.has(entry.id)) continue;
      try {
        if (removeContentPack(entry.id, options).changed) {
          outcome.removed.push(`${entry.id}@${entry.version}`);
        }
      } catch (error) {
        outcome.failed.push({
          file: entry.id,
          code: (error && error.code) || "CONTENT_PACK_ERROR",
          message: `could not remove ${entry.id}: ${(error && error.message) || error}`,
        });
      }
    }
  }

  // Stable content failures are remembered too: unchanged invalid input need
  // not force an expensive import on every boot.
  // Changing bytes, the registry, or engine compatibility makes it try again.
  // A transient lock/I/O failure must be retried even when those are unchanged.
  const registryAfter = fingerprintRegistry(options);
  const stableFailure = (failure) => ["CONTENT_PACK_INVALID", "CONTENT_PACK_JSON_INVALID",
    "CONTENT_PACK_TOO_LARGE", "CONTENT_PACK_VERSION_CONFLICT", "CONTENT_PACK_TEMPLATE_CONFLICT",
    "CONTENT_PACK_SOURCE_DUNGEON_CONFLICT", "CONTENT_PACK_SPAWN_PROFILE_CONFLICT"].includes(failure.code);
  // Do not attest to a folder modified during import, including newly added or
  // removed files. The next startup must judge the new input instead.
  if (registryAfter !== null && outcome.failed.every(stableFailure) && folderUnchanged) {
    writeMarker(options, folder, registryAfter, compatibility);
  }
  return outcome;
}

// One line per interesting thing, so a server log says what happened without
// anyone opening a tool.
function describeAutoInstall(outcome) {
  const lines = [];
  if (outcome.installed.length > 0) {
    lines.push(`installed ${outcome.installed.length} content pack(s): ${outcome.installed.join(", ")}`);
  }
  if (outcome.updated.length > 0) {
    lines.push(`updated ${outcome.updated.length} content pack(s): ${outcome.updated.join(", ")}`);
  }
  if (outcome.removed.length > 0) {
    lines.push(
      `removed ${outcome.removed.length} content pack(s) whose file is no longer in ` +
      `${outcome.directory}: ${outcome.removed.join(", ")}`,
    );
  }
  for (const skipped of outcome.skippedOlderVersions) {
    lines.push(
      `${outcome.directory} holds two versions of ${skipped.id}: using ${skipped.newerVersion} ` +
      `and ignoring ${skipped.file}. Delete the older file to silence this.`,
    );
  }
  for (const kept of outcome.keptNewer) {
    lines.push(
      `${kept.id} ${kept.installedVersion} is installed, which is newer than ${kept.version} ` +
      `in ${outcome.directory}, so ${kept.installedVersion} stays.`,
    );
  }
  for (const failure of outcome.failed) {
    lines.push(`${failure.file} could not be installed: ${failure.message}`);
  }
  if (outcome.stats) {
    lines.push(`checked ${outcome.stats.packsParsed} distinct pack(s) in ${outcome.stats.elapsedMs} ms; ` +
      `${outcome.stats.preflightMerges} collision preflight merge(s)`);
  }
  return lines;
}

module.exports = {
  DROP_DIRECTORY,
  MARKER_NAME,
  autoInstallContentPacks,
  describeAutoInstall,
};
