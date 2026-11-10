"use strict";

/**
 * rotatingLog — bounded, hourly rotating file logger.
 *
 * append() keeps at most a bounded amount of data queued per file and writes
 * one batch at a time.  Waiting for each write callback means a slow disk can
 * no longer grow Node's Writable queue without limit.  If a producer outruns
 * the bounded queue, the logger drops the overflow and writes one explicit
 * summary record after it catches up.
 *
 * Rotation is serialized with writes.  The old stream is fully closed before
 * archival, which is required on Windows, and new-hour records remain queued
 * until the new file is open.  A cross-process lock and file-identity check
 * prevent one process from re-archiving a replacement base owned by another.
 *
 * appendSync() remains available for last-chance lifecycle logging.  It always
 * performs its own synchronous append before returning, including when the
 * same path has asynchronous work in flight.  Cross-lane ordering is not
 * guaranteed, but a crash record cannot be stranded in the asynchronous queue.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_LINES = 10_000;
const DEFAULT_MAX_BATCH_BYTES = 256 * 1024;
const DEFAULT_STREAM_HIGH_WATER_MARK = 64 * 1024;
// Keep stale dev-box logs comfortably below Node's roughly 512 MiB maximum
// string size.  Current debug streams should remain far below this after the
// producer-side volume caps, so crossing it means the file is no longer safe
// or useful to retain across a restart.
const DEFAULT_STARTUP_MAX_LOG_ARCHIVE_BYTES = 128 * 1024 * 1024;
const ROTATED_LOG_ARCHIVE_PATTERN =
  /^(.+)\.(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])_(?:[01]\d|2[0-3]))(?:\.([1-9]\d*))?(\.log)$/i;
const ROTATION_LOCK_RETRY_MS = 10;
const ROTATION_LOCK_TIMEOUT_MS = 1_000;
// Names written by rotationLockOwnerPath(): <base>.rotate.lock.<pid>.<ms>.<random>.owner
const ROTATION_LOCK_OWNER_PATTERN = /\.rotate\.lock\.(\d+)\.(\d+)\.[a-z0-9]+\.owner$/;
// An acquisition holds its owner file for milliseconds and gives up after
// ROTATION_LOCK_TIMEOUT_MS, so one this old was left by a process that died
// mid-acquisition. Age, not PID liveness: PIDs are reused across restarts.
const ORPHANED_LOCK_OWNER_AGE_MS = 60 * 60 * 1_000;
const STREAM_FILE_IDENTITY = Symbol("rotatingLogFileIdentity");
const PROCESS_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1_000);

const _streams = new Map();

let nowProvider = () => new Date();
let maxPendingBytes = DEFAULT_MAX_PENDING_BYTES;
let maxPendingLines = DEFAULT_MAX_PENDING_LINES;
let maxBatchBytes = DEFAULT_MAX_BATCH_BYTES;
let streamHighWaterMark = DEFAULT_STREAM_HIGH_WATER_MARK;
let closeAllPromise = null;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

// 0 disables a limit; anything else that is not a positive integer falls back.
function limitOrDisabled(value, fallback) {
  return Number(value) === 0 ? 0 : positiveInteger(value, fallback);
}

/**
 * Deletes hourly archives that are larger than maxArchiveBytes, and keeps only
 * the newest keepArchiveHoursPerLog hours of archives for each log (each base
 * name such as server.log or inventory-debug.log is counted on its own). A log
 * that writes rarely therefore keeps its last hours however long ago they
 * were. Hours come from the archive names, not from mtime, so copying or
 * touching a log directory changes nothing; collision copies of one hour
 * (name.hour.1.log) count as that hour. Either limit is disabled by 0;
 * keepArchiveHoursPerLog defaults to disabled, so existing callers keep the
 * size-only behavior.
 *
 * Also deletes rotation lock owner files orphaned by a process that died
 * between creating one and linking it (see acquireRotationLock()).
 */
function pruneLogArchivesSync(logDirectory, options = {}) {
  const directory = path.resolve(logDirectory);
  const maxArchiveBytes = limitOrDisabled(
    options.maxArchiveBytes,
    DEFAULT_STARTUP_MAX_LOG_ARCHIVE_BYTES,
  );
  const keepArchiveHoursPerLog = limitOrDisabled(options.keepArchiveHoursPerLog ?? 0, 0);
  const nowMs = currentDate().getTime();
  const summary = {
    beyondRetentionFiles: 0,
    deletedBytes: 0,
    deletedFiles: 0,
    deletedPaths: [],
    failedPaths: [],
    keepArchiveHoursPerLog,
    maxArchiveBytes,
    orphanedLockOwnerFiles: 0,
    oversizedFiles: 0,
    scannedFiles: 0,
    skippedLockedPaths: [],
  };

  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return summary;
    summary.failedPaths.push(directory);
    return summary;
  }

  const archives = [];
  for (const entry of entries) {
    // Only direct archives created by archivePath() and orphaned lock owner
    // files are eligible. Live base logs, node reports, databases,
    // directories, symlinks and the canonical *.rotate.lock files are
    // deliberately outside this cleanup.
    if (!entry.isFile()) continue;
    const ownerMatch = ROTATION_LOCK_OWNER_PATTERN.exec(entry.name);
    if (ownerMatch) {
      // Read the creation time from the name: a crash right after open()
      // leaves the file empty, so the token inside cannot be relied on.
      if (Number(ownerMatch[2]) > nowMs - ORPHANED_LOCK_OWNER_AGE_MS) continue;
      const ownerFilePath = path.join(directory, entry.name);
      try {
        fs.unlinkSync(ownerFilePath);
        summary.orphanedLockOwnerFiles += 1;
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          summary.failedPaths.push(ownerFilePath);
        }
      }
      continue;
    }
    const archiveMatch = ROTATED_LOG_ARCHIVE_PATTERN.exec(entry.name);
    if (!archiveMatch) continue;
    archives.push({
      filePath: path.join(directory, entry.name),
      baseFilePath: path.join(directory, `${archiveMatch[1]}${archiveMatch[4]}`),
      hourKey: archiveMatch[2],
    });
  }

  // For each log, the newest keepArchiveHoursPerLog hours it has archives for.
  // Hour keys (YYYY-MM-DD_HH) sort in time order as plain strings.
  const keptHoursByBase = new Map();
  if (keepArchiveHoursPerLog > 0) {
    const hoursByBase = new Map();
    for (const archive of archives) {
      if (!hoursByBase.has(archive.baseFilePath)) {
        hoursByBase.set(archive.baseFilePath, new Set());
      }
      hoursByBase.get(archive.baseFilePath).add(archive.hourKey);
    }
    for (const [baseFilePath, hourKeys] of hoursByBase) {
      keptHoursByBase.set(
        baseFilePath,
        new Set([...hourKeys].sort().reverse().slice(0, keepArchiveHoursPerLog)),
      );
    }
  }

  for (const { filePath, baseFilePath, hourKey } of archives) {
    summary.scannedFiles += 1;
    const beyondRetention = keepArchiveHoursPerLog > 0 &&
      !keptHoursByBase.get(baseFilePath).has(hourKey);
    let lock = null;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const oversized = maxArchiveBytes > 0 && stat.size > maxArchiveBytes;
      if (!beyondRetention && !oversized) continue;
      lock = tryAcquireRotationLockSync(baseFilePath);
      if (!lock) {
        summary.skippedLockedPaths.push(filePath);
        continue;
      }
      fs.unlinkSync(filePath);
      summary.deletedBytes += stat.size;
      summary.deletedFiles += 1;
      summary.deletedPaths.push(filePath);
      if (beyondRetention) summary.beyondRetentionFiles += 1;
      else summary.oversizedFiles += 1;
    } catch (_) {
      // A concurrently rotated/open file can legitimately disappear or be
      // locked. Keep startup moving and surface the count through the caller.
      summary.failedPaths.push(filePath);
    } finally {
      releaseRotationLockSync(lock);
    }
  }

  return summary;
}

function pruneOversizedLogArchivesSync(logDirectory, options = {}) {
  return pruneLogArchivesSync(logDirectory, {
    maxArchiveBytes: positiveInteger(
      options.maxArchiveBytes,
      DEFAULT_STARTUP_MAX_LOG_ARCHIVE_BYTES,
    ),
  });
}

function currentDate() {
  const value = nowProvider();
  return value instanceof Date ? value : new Date(value);
}

function hourKeyFromDate(date) {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${d}_${h}`;
}

function currentHourKey() {
  return hourKeyFromDate(currentDate());
}

function archivePath(filePath, hourKey, suffix = 0) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const collisionSuffix = suffix > 0 ? `.${suffix}` : "";
  return path.join(dir, `${base}.${hourKey}${collisionSuffix}${ext}`);
}

function rotationLockPath(filePath) {
  return `${filePath}.rotate.lock`;
}

function rotationLockToken() {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function rotationLockOwnerPath(lockPath, token) {
  return `${lockPath}.${token.replaceAll(":", ".")}.owner`;
}

function parseRotationLockOwner(token) {
  const match = /^(\d+):(\d+):/.exec(String(token || "").trim());
  if (!match) return null;
  const pid = Number(match[1]);
  const createdAt = Number(match[2]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0
  ) {
    return null;
  }
  return { createdAt, pid };
}

function rotationLockOwnerIsDead(owner) {
  if (!owner) return false;
  if (owner.pid === process.pid) {
    // Handles PID reuse after this process starts without stealing a lock held
    // by another rotatingLog module instance in the same live process.
    return owner.createdAt < PROCESS_STARTED_AT_MS - 1_000;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === "ESRCH");
  }
}

async function reclaimDeadRotationLock(lockPath) {
  let token;
  try {
    token = await fs.promises.readFile(lockPath, "utf8");
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
  if (!rotationLockOwnerIsDead(parseRotationLockOwner(token))) return false;
  try {
    // The canonical path cannot be acquired by a new owner while it exists.
    // Re-read nevertheless so a partially written token is never reclaimed.
    if (await fs.promises.readFile(lockPath, "utf8") !== token) return false;
    await fs.promises.unlink(lockPath);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
}

function reclaimDeadRotationLockSync(lockPath) {
  let token;
  try {
    token = fs.readFileSync(lockPath, "utf8");
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
  if (!rotationLockOwnerIsDead(parseRotationLockOwner(token))) return false;
  try {
    if (fs.readFileSync(lockPath, "utf8") !== token) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function acquireRotationLock(filePath) {
  const lockPath = rotationLockPath(filePath);
  const deadline = Date.now() + ROTATION_LOCK_TIMEOUT_MS;
  while (true) {
    const token = rotationLockToken();
    const ownerPath = rotationLockOwnerPath(lockPath, token);
    let handle = null;
    let ownerCreated = false;
    try {
      // Publish only a fully written token at the canonical path. A process
      // crash before link() can leave an inert *.owner file, but never an empty
      // lock whose owner cannot be checked safely.
      handle = await fs.promises.open(ownerPath, "wx");
      ownerCreated = true;
      await handle.writeFile(token, "utf8");
      await handle.close();
      handle = null;
      await fs.promises.link(ownerPath, lockPath);
      if (ownerCreated) {
        try {
          await fs.promises.unlink(ownerPath);
        } catch (_) {
          // ignored: the lock is held; a leftover owner file is only litter
        }
      }
      return { lockPath, token };
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error below is the one that counts
        }
      }
      if (ownerCreated) {
        try {
          await fs.promises.unlink(ownerPath);
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error below is the one that counts
        }
      }
      if (!error || error.code !== "EEXIST") throw error;
      if (await reclaimDeadRotationLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        const timeoutError = new Error(
          `timed out waiting for rotation lock ${lockPath}`,
        );
        timeoutError.code = "EVEJS_LOG_ROTATION_BUSY";
        throw timeoutError;
      }
      await sleep(ROTATION_LOCK_RETRY_MS);
    }
  }
}

async function releaseRotationLock(lock) {
  if (!lock) return;
  try {
    const owner = await fs.promises.readFile(lock.lockPath, "utf8");
    if (owner === lock.token) await fs.promises.unlink(lock.lockPath);
  } catch (_) {
    // ignored: the lock is already gone or not ours; one left behind is reclaimed once its process is gone
  }
}

function tryAcquireRotationLockSync(filePath) {
  const lockPath = rotationLockPath(filePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = rotationLockToken();
    const ownerPath = rotationLockOwnerPath(lockPath, token);
    let fd = null;
    let ownerCreated = false;
    try {
      fd = fs.openSync(ownerPath, "wx");
      ownerCreated = true;
      fs.writeFileSync(fd, token, "utf8");
      fs.closeSync(fd);
      fd = null;
      fs.linkSync(ownerPath, lockPath);
      if (ownerCreated) {
        try {
          fs.unlinkSync(ownerPath);
        } catch (_) {
          // ignored: the lock is held; a leftover owner file is only litter
        }
      }
      return { lockPath, token };
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error below is the one that counts
        }
      }
      if (ownerCreated) {
        try {
          fs.unlinkSync(ownerPath);
        } catch (_) {
          // ignored: cleanup after a failed attempt; the error below is the one that counts
        }
      }
      if (
        attempt === 0 &&
        error &&
        error.code === "EEXIST" &&
        reclaimDeadRotationLockSync(lockPath)
      ) {
        continue;
      }
      return null;
    }
  }
  return null;
}

function releaseRotationLockSync(lock) {
  if (!lock) return;
  try {
    const owner = fs.readFileSync(lock.lockPath, "utf8");
    if (owner === lock.token) fs.unlinkSync(lock.lockPath);
  } catch (_) {
    // ignored: the lock is already gone or not ours; one left behind is reclaimed once its process is gone
  }
}

function identityFromStat(stat) {
  if (!stat) return null;
  const device = String(stat.dev);
  const inode = String(stat.ino);
  if (inode !== "0") return `${device}:${inode}`;
  const birthtime = stat.birthtimeNs === undefined
    ? String(stat.birthtimeMs)
    : String(stat.birthtimeNs);
  return `${device}:${inode}:${birthtime}`;
}

function fileIdentity(filePath) {
  try {
    return {
      exists: true,
      identity: identityFromStat(fs.statSync(filePath, { bigint: true })),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { exists: false, identity: null };
    }
    throw error;
  }
}

function captureStreamFileIdentity(stream) {
  if (!stream) return null;
  if (stream[STREAM_FILE_IDENTITY]) return stream[STREAM_FILE_IDENTITY];
  if (!Number.isInteger(stream.fd)) return null;
  try {
    const identity = identityFromStat(fs.fstatSync(stream.fd, { bigint: true }));
    stream[STREAM_FILE_IDENTITY] = identity;
    return identity;
  } catch (_) {
    // ignored: null means the identity is unknown; rotation reads it again once the stream has closed
    return null;
  }
}

function archiveReservationToken() {
  return `EVEJS_ROTATING_LOG_RESERVATION:${rotationLockToken()}\n`;
}

async function reserveAvailableArchive(filePath, hourKey) {
  let suffix = 0;
  while (true) {
    const target = archivePath(filePath, hourKey, suffix);
    const token = archiveReservationToken();
    let handle = null;
    let created = false;
    try {
      handle = await fs.promises.open(target, "wx");
      created = true;
      await handle.writeFile(token, "utf8");
      await handle.close();
      handle = null;
      return { target, token };
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch (_) {
          // ignored: cleanup after a failed reservation; the error below decides whether to try the next name
        }
      }
      if (created) {
        try {
          await fs.promises.unlink(target);
        } catch (_) {
          // ignored: cleanup after a failed reservation; the error below decides whether to try the next name
        }
      }
      if (!error || error.code !== "EEXIST") throw error;
      suffix += 1;
    }
  }
}

function reserveAvailableArchiveSync(filePath, hourKey) {
  let suffix = 0;
  while (true) {
    const target = archivePath(filePath, hourKey, suffix);
    const token = archiveReservationToken();
    let fd = null;
    let created = false;
    try {
      fd = fs.openSync(target, "wx");
      created = true;
      fs.writeFileSync(fd, token, "utf8");
      fs.closeSync(fd);
      fd = null;
      return { target, token };
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_) {
          // ignored: cleanup after a failed reservation; the error below decides whether to try the next name
        }
      }
      if (created) {
        try {
          fs.unlinkSync(target);
        } catch (_) {
          // ignored: cleanup after a failed reservation; the error below decides whether to try the next name
        }
      }
      if (!error || error.code !== "EEXIST") throw error;
      suffix += 1;
    }
  }
}

async function discardArchiveReservation(reservation) {
  if (!reservation) return false;
  try {
    if (
      await fs.promises.readFile(reservation.target, "utf8") !==
      reservation.token
    ) {
      return false;
    }
    await fs.promises.unlink(reservation.target);
    return true;
  } catch (_) {
    // ignored: false tells the caller the reservation was not discarded
    return false;
  }
}

function discardArchiveReservationSync(reservation) {
  if (!reservation) return false;
  try {
    if (fs.readFileSync(reservation.target, "utf8") !== reservation.token) {
      return false;
    }
    fs.unlinkSync(reservation.target);
    return true;
  } catch (_) {
    // ignored: false tells the caller the reservation was not discarded
    return false;
  }
}

async function archiveOwnedBase(filePath, hourKey, expectedIdentity) {
  const lock = await acquireRotationLock(filePath);
  try {
    const current = fileIdentity(filePath);
    if (!current.exists) return { archived: false, reason: "absent" };
    if (!expectedIdentity) {
      const identityError = new Error(
        `could not identify the stream backing ${filePath}`,
      );
      identityError.code = "EVEJS_LOG_IDENTITY_UNKNOWN";
      throw identityError;
    }
    if (current.identity !== expectedIdentity) {
      // Another process already moved our old inode and created this base.
      // Its current-hour file must not be archived under our old hour key.
      return { archived: false, reason: "replaced" };
    }

    const reservation = await reserveAvailableArchive(filePath, hourKey);
    let renamed = false;
    try {
      const source = fileIdentity(filePath);
      if (!source.exists || source.identity !== expectedIdentity) {
        return { archived: false, reason: "replaced" };
      }
      await fs.promises.rename(filePath, reservation.target);
      renamed = true;
      const archived = fileIdentity(reservation.target);
      if (!archived.exists || archived.identity !== expectedIdentity) {
        const identityError = new Error(
          `archive identity changed while rotating ${filePath}`,
        );
        identityError.code = "EVEJS_LOG_ARCHIVE_IDENTITY_CHANGED";
        throw identityError;
      }
      return {
        archived: true,
        reason: "archived",
        target: reservation.target,
      };
    } finally {
      if (!renamed) await discardArchiveReservation(reservation);
    }
  } finally {
    await releaseRotationLock(lock);
  }
}

function ensureDir(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (_) {
    // ignored: the open or write that follows reports the useful failure
  }
}

function existingFileHourKey(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const stat = fs.statSync(filePath);
    if (!stat || stat.size <= 0) return fallback;
    return hourKeyFromDate(stat.mtime);
  } catch (_) {
    return fallback;
  }
}

function createEntry(filePath) {
  const entry = {
    filePath,
    stream: null,
    hourKey: null,
    pending: [],
    pendingHead: 0,
    pendingBytes: 0,
    activeBatch: null,
    transitioning: false,
    closed: false,
    forcedHourKey: null,
    idleWaiters: [],
    unreportedDroppedLines: 0,
    unreportedDroppedBytes: 0,
    firstDroppedHourKey: null,
    lastDroppedHourKey: null,
    stats: {
      acceptedBytes: 0,
      acceptedLines: 0,
      backpressureSignals: 0,
      droppedBytes: 0,
      droppedLines: 0,
      peakBufferedBytes: 0,
      peakBufferedLines: 0,
      rotationErrors: 0,
      rotations: 0,
      writeErrors: 0,
      writtenBytes: 0,
      writtenLines: 0,
    },
  };
  _streams.set(filePath, entry);
  return entry;
}

function getEntry(filePath) {
  return _streams.get(filePath) || createEntry(filePath);
}

function activeBatchBytes(entry) {
  return entry.activeBatch ? entry.activeBatch.byteLength : 0;
}

function activeBatchLines(entry) {
  return entry.activeBatch ? entry.activeBatch.items.length : 0;
}

function pendingLineCount(entry) {
  return entry.pending.length - entry.pendingHead;
}

function peekPending(entry) {
  return pendingLineCount(entry) > 0
    ? entry.pending[entry.pendingHead]
    : null;
}

function dequeuePending(entry) {
  const item = peekPending(entry);
  if (!item) return null;
  entry.pending[entry.pendingHead] = undefined;
  entry.pendingHead += 1;
  entry.pendingBytes -= item.byteLength;
  return item;
}

function compactPending(entry) {
  const remaining = pendingLineCount(entry);
  if (remaining === 0) {
    entry.pending = [];
    entry.pendingHead = 0;
    return;
  }
  if (entry.pendingHead >= 1024 && entry.pendingHead >= remaining) {
    entry.pending = entry.pending.slice(entry.pendingHead);
    entry.pendingHead = 0;
  }
}

function prependPending(entry, items) {
  if (items.length === 0) return;
  if (entry.pendingHead >= items.length) {
    entry.pendingHead -= items.length;
    for (let index = 0; index < items.length; index += 1) {
      entry.pending[entry.pendingHead + index] = items[index];
    }
  } else {
    // This path is defensive. A failed active batch always leaves at least as
    // many consumed head slots as it can retry, so normal prepends are O(k).
    const remaining = entry.pending.slice(entry.pendingHead);
    entry.pending = items.concat(remaining);
    entry.pendingHead = 0;
  }
  for (const item of items) entry.pendingBytes += item.byteLength;
}

function bufferedBytes(entry) {
  return entry.pendingBytes + activeBatchBytes(entry);
}

function bufferedLines(entry) {
  return pendingLineCount(entry) + activeBatchLines(entry);
}

function updatePeakBuffered(entry) {
  entry.stats.peakBufferedBytes = Math.max(
    entry.stats.peakBufferedBytes,
    bufferedBytes(entry),
  );
  entry.stats.peakBufferedLines = Math.max(
    entry.stats.peakBufferedLines,
    bufferedLines(entry),
  );
}

function buildPendingItem(line, hourKey, attempts = 0, isDropNotice = false) {
  const normalizedLine = typeof line === "string" ? line : String(line);
  return {
    attempts,
    byteLength: Buffer.byteLength(normalizedLine),
    hourKey,
    isDropNotice,
    line: normalizedLine,
  };
}

function recordDrop(entry, item) {
  entry.stats.droppedLines += 1;
  entry.stats.droppedBytes += item.byteLength;
  // A failed summary cannot recursively demand another summary.  This is
  // particularly important when the destination is permanently unwritable:
  // flushAll() must settle instead of manufacturing notices forever.
  if (item.isDropNotice) return;
  entry.unreportedDroppedLines += 1;
  entry.unreportedDroppedBytes += item.byteLength;
  entry.firstDroppedHourKey ||= item.hourKey;
  entry.lastDroppedHourKey = item.hourKey;
}

function enqueueItem(entry, item, { force = false } = {}) {
  const nextBufferedBytes = bufferedBytes(entry) + item.byteLength;
  const nextBufferedLines = bufferedLines(entry) + 1;
  if (!force && (
    nextBufferedBytes > maxPendingBytes ||
    nextBufferedLines > maxPendingLines
  )) {
    recordDrop(entry, item);
    return false;
  }
  entry.pending.push(item);
  entry.pendingBytes += item.byteLength;
  updatePeakBuffered(entry);
  return true;
}

function buildDropNotice(entry) {
  if (entry.unreportedDroppedLines <= 0) return null;
  const firstHour = entry.firstDroppedHourKey || "unknown";
  const lastHour = entry.lastDroppedHourKey || firstHour;
  const hourSpan = firstHour === lastHour
    ? firstHour
    : `${firstHour}..${lastHour}`;
  const line =
    `[${currentDate().toISOString()}] [WRN] [RotatingLog] ` +
    `dropped ${entry.unreportedDroppedLines} line(s) ` +
    `(${entry.unreportedDroppedBytes} bytes) for ${path.basename(entry.filePath)} ` +
    `while the bounded writer was backpressured; source_hours=${hourSpan}\n`;
  return buildPendingItem(
    line,
    entry.lastDroppedHourKey || currentHourKey(),
    0,
    true,
  );
}

function queueDropNotice(entry) {
  const notice = buildDropNotice(entry);
  if (!notice) return false;
  if (notice.byteLength > maxPendingBytes) {
    // A deliberately tiny configured ceiling may not fit even the summary.
    // Clear the pending summary so flushAll() can still settle; the cumulative
    // drop counters remain available through diagnostics.
    entry.unreportedDroppedLines = 0;
    entry.unreportedDroppedBytes = 0;
    entry.firstDroppedHourKey = null;
    entry.lastDroppedHourKey = null;
    return false;
  }
  if (
    bufferedBytes(entry) + notice.byteLength > maxPendingBytes ||
    bufferedLines(entry) + 1 > maxPendingLines
  ) {
    return false;
  }
  entry.pending.push(notice);
  entry.pendingBytes += notice.byteLength;
  entry.unreportedDroppedLines = 0;
  entry.unreportedDroppedBytes = 0;
  entry.firstDroppedHourKey = null;
  entry.lastDroppedHourKey = null;
  updatePeakBuffered(entry);
  return true;
}

function hasUnreportedDrops(entry) {
  return entry.unreportedDroppedLines > 0;
}

function isIdle(entry) {
  return !entry.transitioning &&
    !entry.activeBatch &&
    pendingLineCount(entry) === 0 &&
    !hasUnreportedDrops(entry);
}

function resolveIdleWaiters(entry) {
  if (!isIdle(entry) || entry.idleWaiters.length === 0) return;
  const waiters = entry.idleWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function waitForIdle(entry) {
  if (isIdle(entry)) return Promise.resolve();
  return new Promise((resolve) => entry.idleWaiters.push(resolve));
}

function reportInternalError(message, error) {
  try {
    // The logger writes through this module, so its own failures go straight to stderr.
    // eslint-disable-next-line no-console
    console.error(`[RotatingLog] ${message}: ${error && error.message || error}`);
  } catch (_) {
    // ignored: logging must not recursively fail the application
  }
}

function openEntryStream(entry, desiredHourKey) {
  ensureDir(entry.filePath);
  entry.hourKey = entry.forcedHourKey ||
    existingFileHourKey(entry.filePath, desiredHourKey);
  entry.forcedHourKey = null;
  const stream = fs.createWriteStream(entry.filePath, {
    encoding: "utf8",
    flags: "a",
    highWaterMark: streamHighWaterMark,
  });
  stream.on("error", (error) => {
    entry.stats.writeErrors += 1;
    reportInternalError(`stream error for ${entry.filePath}`, error);
  });
  stream.once("open", () => {
    captureStreamFileIdentity(stream);
  });
  entry.stream = stream;
}

function closeWritable(stream) {
  if (!stream || stream.closed === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off("close", finish);
      stream.off("error", onError);
      resolve();
    };
    const onError = () => {
      // A Writable normally auto-destroys after an error, but `error` can be
      // emitted before its file descriptor closes.  Keep waiting for close.
      try {
        if (stream.destroyed !== true && typeof stream.destroy === "function") {
          stream.destroy();
        }
      } catch (_) {
        // ignored: the stream is already failing; its close event still ends the wait
      }
      if (stream.closed === true) finish();
    };
    stream.once("close", finish);
    stream.once("error", onError);
    try {
      if (stream.destroyed !== true && stream.writableEnded !== true) {
        stream.end();
      }
      if (stream.closed === true) finish();
    } catch (error) {
      onError(error);
    }
  });
}

async function rotateEntry(entry) {
  if (entry.transitioning) return;
  entry.transitioning = true;
  const oldHourKey = entry.hourKey;
  const oldStream = entry.stream;
  let oldFileIdentity = captureStreamFileIdentity(oldStream);
  entry.stream = null;
  try {
    await closeWritable(oldStream);
    oldFileIdentity ||= captureStreamFileIdentity(oldStream);
    await archiveOwnedBase(entry.filePath, oldHourKey, oldFileIdentity);
    entry.stats.rotations += 1;
  } catch (error) {
    entry.stats.rotationErrors += 1;
    // Preserve forward progress if another process or the filesystem prevents
    // archival. Continue in the base file for this hour rather than repeatedly
    // reopening its old mtime and attempting the same failed rotation.
    const nextPending = peekPending(entry);
    entry.forcedHourKey = nextPending && nextPending.hourKey ||
      currentHourKey();
    reportInternalError(`failed to rotate ${entry.filePath}`, error);
  } finally {
    entry.hourKey = null;
    entry.transitioning = false;
    pumpEntry(entry);
  }
}

function requeueFailedBatch(entry, batch) {
  const retryable = [];
  for (const item of batch.items) {
    if (item.attempts < 1) {
      retryable.push({ ...item, attempts: item.attempts + 1 });
    } else {
      recordDrop(entry, item);
    }
  }
  prependPending(entry, retryable);
  updatePeakBuffered(entry);
}

function resetFailedStream(entry) {
  if (entry.transitioning) return;
  entry.transitioning = true;
  const failedStream = entry.stream;
  entry.stream = null;
  void closeWritable(failedStream).finally(() => {
    entry.hourKey = null;
    entry.transitioning = false;
    pumpEntry(entry);
  });
}

function writeNextBatch(entry) {
  const targetHourKey = entry.hourKey;
  const items = [];
  let byteLength = 0;
  while (pendingLineCount(entry) > 0) {
    const item = peekPending(entry);
    if (item.hourKey !== targetHourKey) break;
    if (items.length > 0 && byteLength + item.byteLength > maxBatchBytes) break;
    dequeuePending(entry);
    items.push(item);
    byteLength += item.byteLength;
  }
  if (items.length === 0) return false;

  const payload = items.map((item) => item.line).join("");
  const batch = { byteLength, items, payload };
  entry.activeBatch = batch;
  updatePeakBuffered(entry);
  let accepted = true;
  try {
    accepted = entry.stream.write(payload, "utf8", (error) => {
      entry.activeBatch = null;
      if (error) {
        entry.stats.writeErrors += 1;
        requeueFailedBatch(entry, batch);
        if (pendingLineCount(entry) === 0) compactPending(entry);
        resetFailedStream(entry);
        return;
      }
      entry.stats.writtenBytes += byteLength;
      entry.stats.writtenLines += items.length;
      compactPending(entry);
      queueDropNotice(entry);
      pumpEntry(entry);
    });
  } catch (error) {
    entry.activeBatch = null;
    entry.stats.writeErrors += 1;
    requeueFailedBatch(entry, batch);
    if (pendingLineCount(entry) === 0) compactPending(entry);
    resetFailedStream(entry);
    return true;
  }
  if (!accepted) entry.stats.backpressureSignals += 1;
  return true;
}

function pumpEntry(entry) {
  if (!entry || entry.closed || entry.transitioning || entry.activeBatch) return;
  queueDropNotice(entry);
  if (pendingLineCount(entry) === 0) {
    resolveIdleWaiters(entry);
    return;
  }

  const desiredHourKey = peekPending(entry).hourKey;
  if (!entry.stream) {
    try {
      openEntryStream(entry, desiredHourKey);
    } catch (error) {
      entry.stats.writeErrors += 1;
      reportInternalError(`failed to open ${entry.filePath}`, error);
      const failed = dequeuePending(entry);
      compactPending(entry);
      recordDrop(entry, failed);
      setImmediate(() => pumpEntry(entry));
      return;
    }
  }
  if (entry.hourKey !== desiredHourKey) {
    void rotateEntry(entry);
    return;
  }
  writeNextBatch(entry);
}

function append(filePath, line) {
  // closeAll() owns a stable snapshot of every accepted async record.  Reject
  // new async work while that snapshot drains so a caller can never receive
  // `true` for a line that shutdown subsequently discards.
  if (closeAllPromise) return false;
  const resolvedPath = path.resolve(filePath);
  const entry = getEntry(resolvedPath);
  const item = buildPendingItem(line, currentHourKey());
  const accepted = enqueueItem(entry, item);
  if (accepted) {
    entry.stats.acceptedLines += 1;
    entry.stats.acceptedBytes += item.byteLength;
  }
  pumpEntry(entry);
  return accepted;
}

function rotateSyncIfNeeded(filePath, hourKey) {
  const lock = tryAcquireRotationLockSync(filePath);
  if (!lock) return;
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat || stat.size <= 0) return;
    const fileHourKey = hourKeyFromDate(stat.mtime);
    if (fileHourKey === hourKey) return;
    const expectedIdentity = identityFromStat(stat);
    const reservation = reserveAvailableArchiveSync(filePath, fileHourKey);
    let renamed = false;
    try {
      const source = fileIdentity(filePath);
      if (!source.exists || source.identity !== expectedIdentity) return;
      fs.renameSync(filePath, reservation.target);
      renamed = true;
      const archived = fileIdentity(reservation.target);
      if (!archived.exists || archived.identity !== expectedIdentity) {
        throw new Error(`archive identity changed while rotating ${filePath}`);
      }
    } finally {
      if (!renamed) discardArchiveReservationSync(reservation);
    }
  } catch (_) {
    // ignored: last-chance logging favors writing the record over rotation fidelity
  } finally {
    releaseRotationLockSync(lock);
  }
}

function appendSync(filePath, line) {
  const resolvedPath = path.resolve(filePath);
  const activeEntry = _streams.get(resolvedPath);
  const hourKey = currentHourKey();
  ensureDir(resolvedPath);
  // Never rename a file that the asynchronous lane may still have open.  The
  // synchronous record is more important than perfect hour-boundary placement
  // during last-chance logging; normal async rotation will catch up afterward.
  if (!activeEntry) rotateSyncIfNeeded(resolvedPath, hourKey);
  try {
    const normalizedLine = typeof line === "string" ? line : String(line);
    fs.appendFileSync(resolvedPath, normalizedLine, "utf8");
    if (activeEntry) {
      const byteLength = Buffer.byteLength(normalizedLine);
      activeEntry.stats.acceptedLines += 1;
      activeEntry.stats.acceptedBytes += byteLength;
      activeEntry.stats.writtenLines += 1;
      activeEntry.stats.writtenBytes += byteLength;
    }
    return true;
  } catch (_) {
    // ignored: false tells the caller the line was not written
    return false;
  }
}

function flushAll() {
  const entries = [..._streams.values()];
  for (const entry of entries) pumpEntry(entry);
  return Promise.all(entries.map((entry) => waitForIdle(entry))).then(() => undefined);
}

function closeAll() {
  if (closeAllPromise) return closeAllPromise;
  closeAllPromise = (async () => {
    await flushAll();
    const entries = [..._streams.entries()];
    await Promise.all(entries.map(async ([filePath, entry]) => {
      entry.closed = true;
      const stream = entry.stream;
      entry.stream = null;
      await closeWritable(stream);
      _streams.delete(filePath);
    }));
  })().finally(() => {
    closeAllPromise = null;
  });
  return closeAllPromise;
}

function getDiagnostics(filePath) {
  const entry = _streams.get(path.resolve(filePath));
  if (!entry) return null;
  return {
    activeBatchBytes: activeBatchBytes(entry),
    bufferedBytes: bufferedBytes(entry),
    hourKey: entry.hourKey,
    pendingBytes: entry.pendingBytes,
    pendingLines: pendingLineCount(entry),
    transitioning: entry.transitioning,
    unreportedDroppedLines: entry.unreportedDroppedLines,
    ...entry.stats,
  };
}

async function resetForTests() {
  await closeAll();
  nowProvider = () => new Date();
  maxPendingBytes = DEFAULT_MAX_PENDING_BYTES;
  maxPendingLines = DEFAULT_MAX_PENDING_LINES;
  maxBatchBytes = DEFAULT_MAX_BATCH_BYTES;
  streamHighWaterMark = DEFAULT_STREAM_HIGH_WATER_MARK;
}

process.once("beforeExit", () => {
  void closeAll();
});

module.exports = {
  append,
  appendSync,
  closeAll,
  flushAll,
  pruneLogArchivesSync,
  pruneOversizedLogArchivesSync,
  _testing: {
    DEFAULT_MAX_BATCH_BYTES,
    DEFAULT_MAX_PENDING_BYTES,
    DEFAULT_MAX_PENDING_LINES,
    DEFAULT_STREAM_HIGH_WATER_MARK,
    DEFAULT_STARTUP_MAX_LOG_ARCHIVE_BYTES,
    archivePath,
    closeWritable,
    getDiagnostics,
    resetForTests,
    rotationLockOwnerPath,
    setLimits(options = {}) {
      maxPendingBytes = positiveInteger(
        options.maxPendingBytes,
        DEFAULT_MAX_PENDING_BYTES,
      );
      maxPendingLines = positiveInteger(
        options.maxPendingLines,
        DEFAULT_MAX_PENDING_LINES,
      );
      maxBatchBytes = positiveInteger(
        options.maxBatchBytes,
        DEFAULT_MAX_BATCH_BYTES,
      );
      streamHighWaterMark = positiveInteger(
        options.streamHighWaterMark,
        DEFAULT_STREAM_HIGH_WATER_MARK,
      );
    },
    setNowProvider(provider) {
      nowProvider = typeof provider === "function" ? provider : () => new Date();
    },
  },
};
