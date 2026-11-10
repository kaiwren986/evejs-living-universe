#!/usr/bin/env node
/**
 * EvEJS ErrorReport collector.
 *
 * Gathers everything the EvEJS team needs to triage a player-reported problem
 * into ONE zip file the player uploads by hand:
 *
 *   - the most recent server logs (the data root's logs folder, _local/logs by
 *     default, rotates hourly; we take the
 *     window around the LAST activity, not around "now", so a morning-after
 *     report still captures last night's crash),
 *   - Node fatal-error reports (logs/node-reports),
 *   - the versioned config/*.json files and the machine-specific
 *     tools/ClientSETUP/scripts/EvEJSConfig.bat (client install paths),
 *   - version numbers from config/version.json AND package.json (a mismatch
 *     means a half-updated install, which is itself a finding),
 *   - a manifest.json with system facts and a pre-digested error summary so
 *     triage can start without extracting anything.
 *
 * Zero dependencies on purpose: it must run on a lean release (no dev trees),
 * inside the Docker image, and on a maintainer checkout alike. The zip writer
 * is self-contained (deflate via zlib) and the finished archive is re-opened
 * and fully CRC-verified before the tool reports success.
 *
 * Never collected: TLS keys/certificates, .env files, the gameStore database.
 *
 * Usage: node tools/ErrorReport/collect-error-report.js [options]
 *   --root <dir>         repo root (default: two levels up from this file)
 *   --logs-dir <dir>     log directory (default: EVEJS_DATA_ROOT/logs, else
 *                        <root>/_local/logs, else the old <root>/server/logs; the
 *                        Docker orchestrator points this at a copied-out dir)
 *   --out <file|dir>     zip path or destination directory (default: <root>)
 *   --hours <n>          log window in hours before last activity (default 6)
 *   --note <text>        reporter's description (else prompted when on a TTY)
 *   --no-prompt          never prompt, even on a TTY
 *   --profile-dir <dir>  include one explicit pause-capture session, intact
 *   --max-file-mb <n>    per-file cap, larger files keep their tail (default 15)
 *   --max-total-mb <n>   total uncompressed log budget (default 250)
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const MANIFEST_SCHEMA = "evejs-error-report/1";
const DEFAULT_HOURS = 6;
const DEFAULT_MAX_FILE_MB = 15;
const DEFAULT_MAX_TOTAL_MB = 250;
const NODE_REPORT_CAP = 10;
const LAST_ERROR_CAP = 20;
const LAST_ERROR_LINE_CHARS = 300;

// Defense in depth: nothing that looks like key material may enter the zip,
// no matter what future collection rules add. Matched against basenames.
const NEVER_COLLECT = /\.(pem|pfx|p12|key|sqlite[^.]*)$|passphrase|\.env/i;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    root: null,
    logsDir: null,
    out: null,
    hours: DEFAULT_HOURS,
    note: null,
    noPrompt: false,
    profileDir: null,
    maxFileMb: DEFAULT_MAX_FILE_MB,
    maxTotalMb: DEFAULT_MAX_TOTAL_MB,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--root") opts.root = next();
    else if (arg === "--logs-dir") opts.logsDir = next();
    else if (arg === "--out") opts.out = next();
    else if (arg === "--hours") opts.hours = Number(next());
    else if (arg === "--note") opts.note = next();
    else if (arg === "--no-prompt") opts.noPrompt = true;
    else if (arg === "--profile-dir") opts.profileDir = next();
    else if (arg === "--max-file-mb") opts.maxFileMb = Number(next());
    else if (arg === "--max-total-mb") opts.maxTotalMb = Number(next());
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) {
    throw new Error("--hours must be a positive number");
  }
  if (!Number.isFinite(opts.maxFileMb) || opts.maxFileMb <= 0) {
    throw new Error("--max-file-mb must be a positive number");
  }
  if (!Number.isFinite(opts.maxTotalMb) || opts.maxTotalMb <= 0) {
    throw new Error("--max-total-mb must be a positive number");
  }
  return opts;
}

// ---------------------------------------------------------------- gathering

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function collectVersions(root) {
  const versionJson = readJsonSafe(path.join(root, "config", "version.json"));
  const packageJson = readJsonSafe(path.join(root, "package.json"));
  return {
    evejsVersion: versionJson ? versionJson.evejsVersion ?? null : null,
    configSchemaVersion: versionJson ? versionJson.configSchemaVersion ?? null : null,
    packageJsonVersion: packageJson ? packageJson.version ?? null : null,
  };
}

function collectGit(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const head = run(["rev-parse", "HEAD"]);
  if (!head) return null;
  const status = run(["status", "--porcelain"]);
  return {
    head,
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirtyFileCount: status === null ? null : status === "" ? 0 : status.split("\n").length,
  };
}

function collectSystem(probePath) {
  let diskFreeMb = null;
  try {
    // statfsSync exists from Node 18.15; older Nodes simply report null.
    if (typeof fs.statfsSync === "function") {
      const stat = fs.statfsSync(probePath);
      diskFreeMb = Math.round((stat.bavail * stat.bsize) / (1024 * 1024));
    }
  } catch {
    /* leave null */
  }
  const cpus = os.cpus() || [];
  return {
    node: process.version,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus.length ? cpus[0].model : null,
    cpuCount: cpus.length,
    totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemMb: Math.round(os.freemem() / (1024 * 1024)),
    diskFreeMb,
    inContainer: fs.existsSync("/.dockerenv"),
  };
}

function statFilesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (NEVER_COLLECT.test(entry.name)) continue;
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      /* raced away mid-scan; skip */
    }
  }
  return files;
}

// The server writes its logs under the data root: EVEJS_DATA_ROOT/logs, else <root>/_local/logs.
// An install that has not started since logs moved there still has them in server/logs.
function defaultLogsDir(root) {
  const configured = String(process.env.EVEJS_DATA_ROOT || "").trim();
  const current = configured
    ? path.join(path.resolve(configured), "logs")
    : path.join(root, "_local", "logs");
  const legacy = path.join(root, "server", "logs");
  if (fs.existsSync(path.join(current, "server.log")) || !fs.existsSync(legacy)) {
    return current;
  }
  return legacy;
}

function scanLogsDir(logsDir) {
  return {
    exists: fs.existsSync(logsDir),
    files: statFilesIn(logsDir),
    nodeReports: statFilesIn(path.join(logsDir, "node-reports")),
  };
}

// -------------------------------------------------------------- selection

/**
 * Pick which log files ride along. Pure over the scan result so tests can
 * exercise the policy without a filesystem.
 *
 * Policy: anchor on the NEWEST log mtime (the last session), include every
 * file touched within `hours` before it, always include the live server.log,
 * then spend the total budget newest-first. Node reports inside the window
 * ride along (capped); if none are in the window the newest one still ships,
 * because an old crash report can still be the whole story.
 */
function selectLogFiles(scan, { hours, maxFileBytes, maxTotalBytes }) {
  const byNewest = (a, b) => b.mtimeMs - a.mtimeMs;
  const files = [...scan.files].sort(byNewest);
  const nodeReports = [...scan.nodeReports].sort(byNewest);

  const anchorMs = files.length
    ? files[0].mtimeMs
    : nodeReports.length
      ? nodeReports[0].mtimeMs
      : null;
  if (anchorMs === null) {
    return { anchorMs: null, windowStartMs: null, logs: [], nodeReports: [], skipped: [] };
  }
  const windowStartMs = anchorMs - hours * 3600 * 1000;

  const inWindow = files.filter((f) => f.mtimeMs >= windowStartMs);
  const serverLive = files.find((f) => f.name === "server.log");
  if (serverLive && !inWindow.includes(serverLive)) inWindow.push(serverLive);

  let reports = nodeReports.filter((f) => f.mtimeMs >= windowStartMs).slice(0, NODE_REPORT_CAP);
  if (!reports.length && nodeReports.length) reports = [nodeReports[0]];

  // Budget: node reports and the live server.log are precious and small-ish,
  // charge them first; then remaining logs newest-first. A file that does not
  // fit is skipped but later (smaller, older) files may still fit.
  const selected = [];
  const skipped = [];
  let spent = reports.reduce((sum, f) => sum + Math.min(f.size, maxFileBytes), 0);
  const ordered = [
    ...(serverLive && inWindow.includes(serverLive) ? [serverLive] : []),
    ...inWindow.filter((f) => f !== serverLive).sort(byNewest),
  ];
  for (const file of ordered) {
    const cost = Math.min(file.size, maxFileBytes);
    if (spent + cost > maxTotalBytes && selected.length) {
      skipped.push({ name: file.name, bytes: file.size, mtime: new Date(file.mtimeMs).toISOString(), reason: "total-budget" });
      continue;
    }
    spent += cost;
    selected.push(file);
  }
  return { anchorMs, windowStartMs, logs: selected, nodeReports: reports, skipped };
}

function readFileTail(absPath, maxBytes) {
  const stat = fs.statSync(absPath);
  if (stat.size <= maxBytes) {
    return { data: fs.readFileSync(absPath), originalSize: stat.size, truncated: false };
  }
  const fd = fs.openSync(absPath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    const marker = Buffer.from(
      `[ErrorReport] Truncated: original file was ${stat.size} bytes; this copy keeps only the last ${bytesRead} bytes.\n`,
      "utf8",
    );
    return {
      data: Buffer.concat([marker, buffer.subarray(0, bytesRead)]),
      originalSize: stat.size,
      truncated: true,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------ error digest

// Filtering rules adapted from tools/ErrorWatch/watch.js (which does not ship
// in lean releases, so the small subset needed here is inlined).
const RECORD_HEAD = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\s+\[([A-Z]{3,5})\]\s?(.*)$/;
const EXTRA_PATTERNS =
  /uncaughtException|unhandledRejection|UnhandledPromiseRejection|FATAL ERROR|Traceback \(most recent/;

/**
 * Count warning/error records and keep the trailing few error lines so the
 * manifest alone is enough to start triage. `sources` must be ordered oldest
 * first; the digest keeps the LAST errors seen.
 */
function scanErrorLines(sources) {
  const summary = { errCount: 0, wrnCount: 0, fatalCount: 0, lastErrors: [] };
  const push = (fileName, line) => {
    summary.lastErrors.push(`${fileName}: ${line.slice(0, LAST_ERROR_LINE_CHARS)}`);
    if (summary.lastErrors.length > LAST_ERROR_CAP) summary.lastErrors.shift();
  };
  for (const { name, text } of sources) {
    for (const line of text.split("\n")) {
      const head = RECORD_HEAD.exec(line);
      if (head) {
        const level = head[1];
        if (level === "ERR") {
          summary.errCount += 1;
          push(name, line);
        } else if (level === "WRN") {
          summary.wrnCount += 1;
        } else if (level === "FATAL") {
          summary.fatalCount += 1;
          push(name, line);
        }
      } else if (EXTRA_PATTERNS.test(line)) {
        summary.fatalCount += 1;
        push(name, line);
      }
    }
  }
  return summary;
}

// ---------------------------------------------------------------- zip writer

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Write a standard ZIP (deflate per entry, stored when deflate does not help).
 * Entries: {zipPath, data:Buffer, mtime:Date}. Written to a `<out>.tmp-<pid>`
 * sidecar first, then renamed, so an interrupted run never leaves a plausible
 * looking half-zip behind.
 */
function writeZip(outPath, entries) {
  if (entries.length >= 0xffff) throw new Error(`too many zip entries: ${entries.length}`);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    if (NEVER_COLLECT.test(path.basename(entry.zipPath))) {
      throw new Error(`refusing to zip sensitive-looking file: ${entry.zipPath}`);
    }
    const name = Buffer.from(entry.zipPath.replace(/\\/g, "/"), "utf8");
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);
    const { time, date } = dosDateTime(entry.mtime || new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    // extra len, comment len, disk, internal attrs already zero
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, name]));

    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  if (offset + centralBuffer.length >= 0xffffffff) {
    throw new Error("zip would exceed 4 GB; lower --max-total-mb");
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const tmpPath = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, Buffer.concat([...chunks, centralBuffer, eocd]));
  verifyZip(tmpPath);
  fs.renameSync(tmpPath, outPath);
}

/** Re-open the finished zip, walk the central directory, inflate every entry
 * and check its CRC. Returns [{name, data}] — doubling as a dependency-free
 * zip reader for tests and maintainer tooling. Throws on any inconsistency. */
function verifyZip(zipPath) {
  const buffer = fs.readFileSync(zipPath);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("zip verify: end-of-central-directory not found");
  const total = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = buffer.readUInt32LE(eocdOffset + 16);
  const verified = [];
  for (let n = 0; n < total; n += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`zip verify: bad central directory signature at entry ${n}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`zip verify: bad local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : payload;
    if (data.length !== size) throw new Error(`zip verify: size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`zip verify: CRC mismatch for ${name}`);
    verified.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return verified;
}

// ------------------------------------------------------------------- report

function collectProfiling(directory, budgetBytes = 250 * 1024 * 1024) {
  if (!directory) return { entries: [], manifest: null };
  const root = path.resolve(directory);
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error("profile directory must be a real directory");
  }
  const entries = [];
  const included = [];
  let totalBytes = 0;
  const allowed = /^(?:events\.jsonl|cpu-\d+\.cpuprofile|windows-counters\.jsonl|windows-counters\.log|launcher\.json)$/;
  const visit = (folder, depth = 0) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { if (depth < 2) visit(file, depth + 1); continue; }
      if (!stat.isFile() || !allowed.test(name) || NEVER_COLLECT.test(name)) continue;
      totalBytes += stat.size;
      // CPU/JSONL data must never be tail-truncated into an unusable profile.
      // Fail explicitly and preserve the raw capture if it exceeds the budget.
      if (totalBytes > budgetBytes) throw new Error("profiling exceeds the 250 MiB budget; raw capture preserved");
      const zipPath = `profiling/${path.relative(root, file).split(path.sep).join("/")}`;
      const data = fs.readFileSync(file);
      entries.push({ zipPath, data, mtime: stat.mtime });
      included.push({ zipPath, bytes: data.length, truncated: false });
    }
  };
  visit(root);
  return { entries, manifest: { dir: root, included, totalBytes } };
}

function defaultZipName(versions) {
  const version = versions.evejsVersion || versions.packageJsonVersion || "unknown";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `EveJS-ErrorReport_v${version}_${stamp}.zip`;
}

function resolveOutPath(out, root, versions) {
  if (!out) return path.join(root, defaultZipName(versions));
  const expanded = path.resolve(out);
  if (out.toLowerCase().endsWith(".zip")) return expanded;
  return path.join(expanded, defaultZipName(versions));
}

/** Full pipeline; returns {zipPath, manifest, zipBytes, entryNames}. */
function collectReport(options) {
  const root = path.resolve(options.root || path.join(__dirname, "..", ".."));
  const logsDir = path.resolve(options.logsDir || defaultLogsDir(root));
  const hours = options.hours || DEFAULT_HOURS;
  const maxFileBytes = Math.round((options.maxFileMb || DEFAULT_MAX_FILE_MB) * 1024 * 1024);
  const maxTotalBytes = Math.round((options.maxTotalMb || DEFAULT_MAX_TOTAL_MB) * 1024 * 1024);

  const versions = collectVersions(root);
  const git = collectGit(root);
  const system = collectSystem(fs.existsSync(logsDir) ? logsDir : root);
  const scan = scanLogsDir(logsDir);
  const selection = selectLogFiles(scan, { hours, maxFileBytes, maxTotalBytes });

  const entries = [];
  const profiling = collectProfiling(options.profileDir);
  entries.push(...profiling.entries);
  const included = [];
  const errorSources = [];

  const addLogFile = (dir, file, zipDir) => {
    const absPath = path.join(dir, file.name);
    let read;
    try {
      read = readFileTail(absPath, maxFileBytes);
    } catch (error) {
      selection.skipped.push({
        name: file.name,
        bytes: file.size,
        mtime: new Date(file.mtimeMs).toISOString(),
        reason: `unreadable: ${error.code || error.message}`,
      });
      return;
    }
    const zipPath = `${zipDir}/${file.name}`;
    entries.push({ zipPath, data: read.data, mtime: new Date(file.mtimeMs) });
    included.push({
      zipPath,
      bytes: read.originalSize,
      includedBytes: read.data.length,
      truncated: read.truncated,
      mtime: new Date(file.mtimeMs).toISOString(),
    });
    if (file.name.endsWith(".log")) {
      errorSources.push({ name: file.name, mtimeMs: file.mtimeMs, text: read.data.toString("utf8") });
    }
  };

  for (const file of [...selection.logs].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    addLogFile(logsDir, file, "server-logs");
  }
  for (const file of [...selection.nodeReports].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    addLogFile(path.join(logsDir, "node-reports"), file, "server-logs/node-reports");
  }

  errorSources.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const errorSummary = scanErrorLines(errorSources);

  // Optional extras must never sink the report: a config file locked by the
  // ConfigEditor or a half-written EvEJSConfig.bat is skipped, not fatal.
  const configDir = path.join(root, "config");
  const configIncluded = [];
  for (const file of statFilesIn(configDir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.name.endsWith(".json")) continue;
    try {
      entries.push({
        zipPath: `config/${file.name}`,
        data: fs.readFileSync(path.join(configDir, file.name)),
        mtime: new Date(file.mtimeMs),
      });
      configIncluded.push(`config/${file.name}`);
    } catch {
      /* skip unreadable config file */
    }
  }

  const clientConfigPath = path.join(root, "tools", "ClientSETUP", "scripts", "EvEJSConfig.bat");
  let clientConfigIncluded = false;
  try {
    if (fs.existsSync(clientConfigPath)) {
      const stat = fs.statSync(clientConfigPath);
      entries.push({
        zipPath: "client-setup/EvEJSConfig.bat",
        data: fs.readFileSync(clientConfigPath),
        mtime: stat.mtime,
      });
      clientConfigIncluded = true;
    }
  } catch {
    /* skip unreadable client config */
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    versions,
    git,
    system,
    window: {
      hours,
      anchor: selection.anchorMs === null ? null : new Date(selection.anchorMs).toISOString(),
      from: selection.windowStartMs === null ? null : new Date(selection.windowStartMs).toISOString(),
    },
    logs: {
      dir: logsDir,
      exists: scan.exists,
      totalFilesInDir: scan.files.length,
      included,
      skipped: selection.skipped,
    },
    config: { included: configIncluded, clientConfigIncluded },
    errorSummary,
    note: options.note || null,
    profiling: profiling.manifest,
  };

  const finalEntries = [
    { zipPath: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), mtime: new Date() },
  ];
  if (options.note) {
    finalEntries.push({ zipPath: "DESCRIPTION.txt", data: Buffer.from(options.note + "\n", "utf8"), mtime: new Date() });
  }
  if (options.clientReport) {
    finalEntries.push({
      zipPath: "client/report.json",
      data: Buffer.from(JSON.stringify(options.clientReport, null, 2), "utf8"),
      mtime: new Date(),
    });
  }
  finalEntries.push(...entries);

  const zipPath = resolveOutPath(options.out, root, versions);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  writeZip(zipPath, finalEntries);
  const verified = verifyZip(zipPath);
  if (verified.length !== finalEntries.length) {
    throw new Error(`zip verify: expected ${finalEntries.length} entries, found ${verified.length}`);
  }
  return {
    zipPath,
    manifest,
    zipBytes: fs.statSync(zipPath).size,
    entryNames: verified.map((entry) => entry.name),
  };
}

// ---------------------------------------------------------------------- cli

function promptForNote() {
  return new Promise((resolve) => {
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Describe what happened (optional, Enter to skip): ", (answer) => {
      rl.close();
      resolve(answer.trim() || null);
    });
  });
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ErrorReport: ${error.message}`);
    console.error("Run with --help for usage.");
    process.exit(2);
  }
  if (opts.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\*\*?/, ""));
    return;
  }
  if (!opts.note && !opts.noPrompt && process.stdin.isTTY && process.stdout.isTTY) {
    opts.note = await promptForNote();
  }

  let result;
  try {
    result = collectReport(opts);
  } catch (error) {
    console.error(`ErrorReport: FAILED: ${error.message}`);
    process.exit(1);
  }

  const { manifest, zipPath, zipBytes, entryNames } = result;
  const truncatedCount = manifest.logs.included.filter((f) => f.truncated).length;
  console.log("");
  console.log("EvEJS Error Report");
  console.log(`  version : ${manifest.versions.evejsVersion || "?"} (config) / ${manifest.versions.packageJsonVersion || "?"} (package.json)`);
  if (!manifest.logs.exists) {
    console.log(`  logs    : WARNING - no log directory at ${manifest.logs.dir} (server never ran?)`);
  } else {
    console.log(
      `  logs    : ${manifest.logs.included.length} files included` +
        (truncatedCount ? ` (${truncatedCount} truncated)` : "") +
        (manifest.logs.skipped.length ? `, ${manifest.logs.skipped.length} skipped` : "") +
        `, window ${manifest.window.hours}h ending ${manifest.window.anchor || "n/a"}`,
    );
    console.log(
      `  errors  : ${manifest.errorSummary.errCount} ERR / ${manifest.errorSummary.wrnCount} WRN / ${manifest.errorSummary.fatalCount} fatal-pattern in collected window`,
    );
  }
  console.log(`  zip     : ${zipPath}`);
  console.log(`            ${formatMb(zipBytes)}, ${entryNames.length} entries, verified OK`);
  console.log("");
  console.log("The zip contains your server logs and configuration, which include");
  console.log("file paths and character names. Review it before sharing if that");
  console.log("concerns you. It never contains certificates, keys, or the game database.");
  console.log("");
  console.log("Upload this file to the EvEJS team (for example the Discord bug channel).");
}

module.exports = {
  parseArgs,
  selectLogFiles,
  scanErrorLines,
  crc32,
  writeZip,
  verifyZip,
  collectReport,
  collectProfiling,
  MANIFEST_SCHEMA,
};

if (require.main === module) {
  main();
}
