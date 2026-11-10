#!/usr/bin/env node
"use strict";

// EveJS RPG fork: installs the client mod hook into the EVE client's code.ccp.
//
// code.ccp is a plain zip of zlib-compressed Python 2.7 modules (.pyj). The hook
// replaces autoexec_client (both copies in the archive) and keeps the original
// under a new name, so the client's own startup runs unchanged before mods load.
// Every other entry is copied byte for byte. The first patch saves the untouched
// archive beside it as code.ccp.evejs-original.
//
//   node tools/ClientMods/patchClient.js --client <...\EVE\tq> [--status | --apply | --restore]
//
// --apply is idempotent: an already patched archive with the current hook is left alone.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const HOOK_BIN = path.join(__dirname, "hook", "autoexec_client_hook.bin");
const TARGETS = ["autoexec_client.pyj", "eve/common/lib/autoexec_client.pyj"];
const ORIGINAL_NAME = "evejs_original_autoexec_client.pyj";
const BACKUP_SUFFIX = ".evejs-original";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip archive (no end record)");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`bad central record #${n}`);
    const nameLen = buf.readUInt16LE(p + 28);
    const recordLen = 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const central = buf.subarray(p, p + recordLen);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (central.readUInt16LE(8) & 0x08) throw new Error(`${name}: data descriptors are not supported`);
    const at = central.readUInt32LE(42);
    if (buf.readUInt32LE(at) !== SIG_LOCAL) throw new Error(`${name}: bad local header`);
    const dataStart = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const dataEnd = dataStart + central.readUInt32LE(20);
    entries.push({ name, central, local: buf.subarray(at, dataEnd), data: buf.subarray(dataStart, dataEnd) });
    p += recordLen;
  }
  return entries;
}

// A stored entry that copies version, flags, method, time, date and attributes from a template.
function makeEntry(template, name, data) {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = zlib.crc32(data) >>> 0;
  const local = Buffer.alloc(30 + nameBuf.length);
  template.local.copy(local, 0, 0, 14);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  template.central.copy(central, 0, 0, 16);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  template.central.copy(central, 38, 38, 42);
  nameBuf.copy(central, 46);
  return { name, central, local: Buffer.concat([local, data]), data };
}

function writeZip(entries) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const central = Buffer.from(entry.central);
    central.writeUInt32LE(offset, 42);
    parts.push(entry.local);
    centrals.push(central);
    offset += entry.local.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function inflate(data) {
  try { return zlib.inflateSync(data); } catch { return null; }
}

function inspect(entries, hookPyc) {
  const targets = entries.filter((entry) => TARGETS.includes(entry.name));
  if (targets.length === 0) throw new Error("autoexec_client.pyj not found: unsupported client build");
  const hasOriginal = entries.some((entry) => entry.name === ORIGINAL_NAME);
  if (!hasOriginal) return { state: "original", targets };
  const current = targets.every((entry) => hookPyc.equals(inflate(entry.data) || Buffer.alloc(0)));
  return { state: current ? "patched" : "outdated", targets };
}

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

function replaceFile(file, buf) {
  const tmp = `${file}.evejs-tmp`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    if (error.code === "EPERM" || error.code === "EBUSY") {
      throw new Error("code.ccp is in use. Close the EVE client and try again.");
    }
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  const clientIndex = args.indexOf("--client");
  const tq = clientIndex >= 0 ? args[clientIndex + 1] : path.join(__dirname, "..", "..", "client", "EVE", "tq");
  const mode = args.includes("--restore") ? "restore" : args.includes("--status") ? "status" : "apply";
  const ccp = path.join(tq, "code.ccp");
  const backup = ccp + BACKUP_SUFFIX;
  if (!fs.existsSync(ccp)) throw new Error(`code.ccp not found at ${ccp}`);

  if (mode === "restore") {
    if (!fs.existsSync(backup)) { console.log("Client mods: nothing to restore (no backup)."); return; }
    replaceFile(ccp, fs.readFileSync(backup));
    console.log("Client mods: original code.ccp restored.");
    return;
  }

  const hookPyc = fs.readFileSync(HOOK_BIN);
  const archive = fs.readFileSync(ccp);
  const entries = readZip(archive);
  const { state, targets } = inspect(entries, hookPyc);

  if (mode === "status" || state === "patched") {
    console.log(`Client mods: ${state}`);
    return;
  }

  const hookEntryData = zlib.deflateSync(hookPyc, { level: 9 });
  let next;
  if (state === "original") {
    const original = targets[0].data;
    if (!targets.every((entry) => entry.data.equals(original))) {
      throw new Error("the autoexec_client copies differ: unsupported client build");
    }
    if (!fs.existsSync(backup)) fs.copyFileSync(ccp, backup);
    next = entries.map((entry) => (TARGETS.includes(entry.name) ? makeEntry(entry, entry.name, hookEntryData) : entry));
    next.push(makeEntry(targets[0], ORIGINAL_NAME, original));
  } else {
    next = entries.map((entry) => (TARGETS.includes(entry.name) ? makeEntry(entry, entry.name, hookEntryData) : entry));
  }

  const patched = writeZip(next);
  const check = inspect(readZip(patched), hookPyc);
  if (check.state !== "patched") throw new Error("self-check failed; code.ccp was not changed");
  replaceFile(ccp, patched);
  console.log(`Client mods: hook ${state === "original" ? "installed" : "updated"} (code.ccp md5 ${md5(archive)} -> ${md5(patched)}).`);
}

try {
  main();
} catch (error) {
  console.error(`Client mods: ${error.message}`);
  process.exit(1);
}
