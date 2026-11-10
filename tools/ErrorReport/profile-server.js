#!/usr/bin/env node
"use strict";

// Native Windows only. Runs the world process and read-only counter helper;
// calls the native ErrorReport library directly, with no deployment detection.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { collectReport } = require("./collect-error-report");

// Windows PowerShell exits silently with DETACHED_PROCESS. A detached Node
// host gives it a hidden console and keeps it outside the game's Ctrl+C group.
function runCounterHost(args) {
  const child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.once("close", (code) => { process.exitCode = code ?? 1; });
}

function parseArgs(args) {
  const options = { seconds: 900, reveal: true };
  for (let i = 0; i < args.length; i += 1) {
    const next = () => { if (i + 1 >= args.length) throw new Error(`missing value for ${args[i]}`); return args[++i]; };
    if (args[i] === "--seconds") options.seconds = Number(next());
    else if (args[i] === "--out") options.out = next();
    else if (args[i] === "--note") options.note = next();
    else if (args[i] === "--no-reveal") options.reveal = false;
    else throw new Error(`unknown option: ${args[i]}`);
  }
  if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 3600) {
    throw new Error("--seconds must be an integer from 1 to 3600");
  }
  return options;
}

async function assertServerStopped(root, env) {
  const file = path.join(root, "config/server.json");
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const port = Number(env.EVEJS_SERVER_PORT || config.network?.serverPort || 26000);
  const bindHost = env.EVEJS_GAME_SERVER_BIND_HOST || config.network?.gameServerBindHost || "127.0.0.1";
  const host = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is already in use. Stop the existing Node game server normally, then run ProfileServer.bat.`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("Could not verify that the game server is stopped")); });
  });
}

async function startProfileSession(options = {}, dependencies = {}) {
  if (process.platform !== "win32") throw new Error("ProfileServer.bat requires native Windows");
  const root = path.resolve(options.root || path.join(__dirname, "../.."));
  const env = { ...process.env, ...options.env };
  const dataRoot = env.EVEJS_DATA_ROOT ? path.resolve(root, "server", env.EVEJS_DATA_ROOT) : path.join(root, "_local");
  await assertServerStopped(root, env);
  const parentDirectory = path.resolve(env.EVEJS_PAUSE_PROFILE_DIR || path.join(dataRoot, "logs/pause-profiles"));
  fs.mkdirSync(parentDirectory, { recursive: true });
  const runID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = fs.mkdtempSync(path.join(parentDirectory, `session-${runID}-`));
  const stopFile = path.join(directory, "counter.stop");
  const announce = dependencies.announce || console.log;
  const state = { schema: "evejs-profile-session/1", startedAt: new Date().toISOString(),
    seconds: options.seconds || 900, serverPID: null, capture: null, counter: null, serverExit: null };
  const saveState = () => {
    try { fs.writeFileSync(path.join(directory, "launcher.json"), JSON.stringify(state, null, 2) + "\n"); }
    catch (error) { state.launcherWriteError = error.message; announce(`Cannot save capture status: ${error.message}`); }
  };
  saveState();
  fs.mkdirSync(path.join(dataRoot, "logs/node-reports"), { recursive: true });
  const server = spawn(process.execPath, ["--report-on-fatalerror", "--report-uncaught-exception",
    `--report-dir=${path.join(dataRoot, "logs/node-reports")}`, "--max-old-space-size=8192",
    dependencies.serverEntry || path.join(root, "server/index.js")], {
    cwd: path.join(root, "server"), windowsHide: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...env, EVEJS_DATA_ROOT: dataRoot, EVEJS_PROXY_LOCAL_INTERCEPT: "1", EVEJS_PAUSE_PROFILE: "1",
      EVEJS_PAUSE_PROFILE_SECONDS: String(state.seconds), EVEJS_PAUSE_PROFILE_DIR: directory,
      EVEJS_PAUSE_PROFILE_LAUNCHER: "1", EVEJS_TICK_PROFILE: "1" },
  });
  state.serverPID = server.pid || null;
  saveState();
  let counter = null;
  let counterDone = Promise.resolve();
  let captureStopped = false;
  let finishRequested = false;
  let waitForServerExit = false;
  let reportPromise = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
  let resolveExit;
  const serverExit = new Promise((resolve) => { resolveExit = resolve; });
  function requestFinish(stoppingServer = false) {
    if (stoppingServer) waitForServerExit = true;
    finishRequested = true;
    if (!captureStopped && server.connected) server.send({ type: "pause-profile-stop" }, () => {});
  }
  function finish() {
    if (reportPromise) return reportPromise;
    reportPromise = (async () => {
      fs.writeFileSync(stopFile, "stop\n");
      let timeout;
      if (counter) timeout = setTimeout(() => {
        state.counter.timedOut = true;
        // Only this launcher's read-only helper; never terminate the world.
        const terminator = spawn("taskkill.exe", ["/PID", String(counter.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" });
        terminator.on("error", () => counter.kill());
      }, 15_000);
      await counterDone;
      clearTimeout(timeout);
      state.finishedAt = new Date().toISOString();
      let events = [];
      let counters = [];
      const readLines = (file) => fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
      try { events = readLines(path.join(state.capture.directory, "events.jsonl")); } catch (_) { /* incomplete capture */ }
      try { counters = readLines(path.join(directory, "windows-counters.jsonl")); } catch (_) { /* incomplete capture */ }
      state.captureComplete = captureStopped && !state.capture?.writeError && events.at(-1)?.type === "stop" &&
        events.some((event) => event.type === "cpu-profile") && !events.some((event) => event.type === "cpu-error");
      state.countersComplete = state.counter?.exitCode === 0 && !state.counter?.timedOut &&
        counters.some((event) => event.type === "sample") && counters.at(-1)?.type === "stop";
      saveState();
      const out = options.out || path.join(root, `EveJS-ErrorReport_profile_${runID}.zip`);
      const result = collectReport({ root, logsDir: path.join(dataRoot, "logs"), out,
        profileDir: directory, noPrompt: true, note: options.note || "One-click login/jump/warp pause capture" });
      announce(`Report ready: ${result.zipPath}`);
      if (!state.captureComplete || !state.countersComplete) announce("Capture is partial; launcher.json records its status. Raw files are preserved.");
      else announce("CPU/GC capture and Windows counters are included with the ErrorReport.");
      resolveCompleted({ ...result, state, directory });
    })().catch((error) => {
      announce(`Report failed: ${error.message}. Raw capture: ${directory}`);
      rejectCompleted(error);
    });
    return reportPromise;
  }
  server.on("message", (message) => {
    if (message?.type === "pause-profile-started") {
      if (message.pid !== server.pid || state.capture) return;
      const relative = path.relative(directory, path.resolve(message.directory));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
      state.capture = { directory: message.directory };
      state.counter = { exitCode: null, timedOut: false };
      const counterLog = fs.createWriteStream(path.join(directory, "windows-counters.log"), { flags: "wx" });
      counterLog.on("error", (error) => { state.counter.logError = error.message; });
      counter = spawn(process.execPath, [__filename, "--counter-host", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        dependencies.counterScript || path.join(root, "scripts/Diagnostics/capture-process-counters.ps1"),
        "-ServerProcessId", String(server.pid), "-OutputPath", path.join(directory, "windows-counters.jsonl"),
        "-Seconds", String(state.seconds), "-StopFile", stopFile],
      { windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      counter.stdout.pipe(counterLog, { end: false });
      counter.stderr.pipe(counterLog, { end: false });
      counterDone = new Promise((resolve) => {
        counter.once("error", (error) => { state.counter.error = error.message; });
        counter.once("close", (code) => {
          state.counter.exitCode = code;
          counterLog.end(resolve);
        });
      });
      saveState();
      announce(`Profiling PID ${server.pid}; reproduce the pause. Enter finishes the capture early. Ctrl+C stops the server normally.`);
      if (finishRequested) requestFinish();
    } else if (message?.type === "pause-profile-stopped") {
      captureStopped = true;
      state.capture = { ...state.capture, reason: message.reason, writeError: message.writeError };
      if (message.reason === "shutdown" || message.reason === "boot-failed") waitForServerExit = true;
      if (!waitForServerExit) void finish();
    } else if (message?.type === "pause-profile-unavailable") {
      state.captureError = message.error;
      void finish();
    }
  });
  server.once("error", (error) => { state.serverError = error.message; });
  server.once("close", (code, signal) => {
    state.serverExit = { code, signal };
    resolveExit(state.serverExit);
    void finish();
  });
  return { server, serverExit, completed, requestFinish, directory };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const capture = await startProfileSession(options);
  const readline = require("node:readline");
  const input = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  input?.on("line", () => capture.requestFinish());
  const onInterrupt = () => capture.requestFinish(true);
  process.on("SIGINT", onInterrupt);
  input?.on("SIGINT", onInterrupt);
  try {
    const result = await capture.completed;
    input?.close();
    if (options.reveal) {
      const explorer = spawn("explorer.exe", ["/select,", result.zipPath], { windowsHide: true, stdio: "ignore" });
      explorer.on("error", () => {});
      explorer.unref();
    }
    console.log("The server stays running. Use Ctrl+C when you are ready to stop it.");
    await capture.serverExit;
    if (result.state.serverExit?.code) process.exitCode = result.state.serverExit.code;
  } catch (error) {
    process.exitCode = 1;
    console.error(error.message);
    await capture.serverExit;
  } finally {
    input?.close();
    process.off("SIGINT", onInterrupt);
  }
}

module.exports = { parseArgs, assertServerStopped, startProfileSession };
if (require.main === module) {
  if (process.argv[2] === "--counter-host") runCounterHost(process.argv.slice(3));
  else main().catch((error) => { console.error(`ProfileServer: ${error.message}`); process.exitCode = 1; });
}
