"use strict";

// Process diagnostics only. No game-store imports, simulation ownership or
// network listener. The disabled entry point does not load the profiler APIs.
function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number : fallback;
}

function startPauseProfilerFromEnvironment(env = process.env) {
  if (env.EVEJS_PAUSE_PROFILE !== "1") {
    return { enabled: false, stop: async () => {} };
  }
  const { resolveDataRootPath } = require("../config/dataRoot");
  const capture = startPauseProfiler({
    outputRoot: env.EVEJS_PAUSE_PROFILE_DIR || resolveDataRootPath("logs", "pause-profiles"),
    durationMs: boundedNumber(env.EVEJS_PAUSE_PROFILE_SECONDS, 900, 1, 3600) * 1000,
  });
  if (env.EVEJS_PAUSE_PROFILE_LAUNCHER === "1" && process.connected) {
    const notify = (message) => {
      if (process.connected) process.send(message, () => {});
    };
    if (!capture.enabled) {
      notify({ type: "pause-profile-unavailable", error: capture.error || "capture disabled" });
      return capture;
    }
    const onMessage = (message) => {
      if (message?.type === "pause-profile-stop") void capture.stop("launcher-request");
    };
    process.on("message", onMessage);
    notify({ type: "pause-profile-started", directory: capture.directory, pid: process.pid });
    capture.stopped.then((result) => {
      process.off("message", onMessage);
      notify({ type: "pause-profile-stopped", ...result });
    });
  }
  return capture;
}

function startPauseProfiler(options = {}) {
  const fs = require("node:fs");
  const path = require("node:path");
  const inspector = require("node:inspector");
  const { performance, monitorEventLoopDelay, PerformanceObserver, constants } = require("node:perf_hooks");
  const durationMs = boundedNumber(options.durationMs, 900_000, 100, 3_600_000);
  const sampleMs = boundedNumber(options.sampleMs, 1000, 20, 10_000);
  const segmentMs = boundedNumber(options.segmentMs, 60_000, 100, 300_000);
  const samplingIntervalUs = 2000;
  const status = options.onStatus || ((message) => {
    // eslint-disable-next-line no-console
    console.error(`[PauseProfile] ${message}`);
  });
  const announce = (message) => { try { status(message); } catch (_) { /* diagnostic only */ } };
  let directory;
  let stream;
  try {
    fs.mkdirSync(options.outputRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(path.resolve(options.outputRoot),
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-`));
    stream = fs.createWriteStream(path.join(directory, "events.jsonl"), { flags: "wx" });
  } catch (error) {
    announce(`disabled: ${error.message}`);
    return { enabled: false, error: error.message, stop: async () => {} };
  }
  let writeError = null;
  let droppedRecords = 0;
  stream.on("error", (error) => {
    writeError = error.message;
    announce(`event output failed: ${error.message}`);
    void stop("output-error");
  });
  function record(type, fields = {}) {
    if (writeError || stream.destroyed) return;
    // Slow/full diagnostic storage must not make an unbounded telemetry queue.
    if (stream.writableLength > 256 * 1024) { droppedRecords += 1; return; }
    stream.write(JSON.stringify({ type, utc: new Date(Date.now()).toISOString(),
      monoMs: performance.now(), ...fields }) + "\n");
  }

  const startedMonoMs = performance.now();
  let previousMonoMs = startedMonoMs;
  let previousWallMs = Date.now();
  let previousCpu = process.cpuUsage();
  let previousElu = performance.eventLoopUtilization();
  let previousResources = process.resourceUsage();
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  function sample(final = false) {
    const nowMonoMs = performance.now();
    const nowWallMs = Date.now();
    const gapMs = nowMonoMs - previousMonoMs;
    const wallGapMs = nowWallMs - previousWallMs;
    const cpu = process.cpuUsage();
    const elu = performance.eventLoopUtilization();
    const eluDelta = performance.eventLoopUtilization(elu, previousElu);
    const resources = process.resourceUsage();
    const cpuUserMs = (cpu.user - previousCpu.user) / 1000;
    const cpuSystemMs = (cpu.system - previousCpu.system) / 1000;
    const resourceDelta = {};
    for (const key of ["fsRead", "fsWrite", "minorPageFault", "majorPageFault",
      "voluntaryContextSwitches", "involuntaryContextSwitches"]) {
      // Node documents these page-fault/context-switch fields as unsupported
      // on Windows. Do not present a plausible-looking number there as evidence.
      resourceDelta[key] = process.platform === "win32" &&
        /PageFault|ContextSwitches/.test(key) ? null : resources[key] - previousResources[key];
    }
    const lagMs = Math.max(0, gapMs - sampleMs);
    record(lagMs >= 1000 ? "stall" : "sample", {
      final, intervalStartMonoMs: previousMonoMs, intervalEndMonoMs: nowMonoMs,
      gapMs, lagMs, wallGapMs, clockStepMs: wallGapMs - gapMs,
      cpuUserMs, cpuSystemMs,
      processCpuPercentOfOneCore: gapMs > 0 ? (cpuUserMs + cpuSystemMs) / gapMs * 100 : 0,
      eventLoop: { activeMs: eluDelta.active, idleMs: eluDelta.idle, utilization: eluDelta.utilization,
        delayP50Ms: histogram.count ? histogram.percentile(50) / 1e6 : null,
        delayP99Ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
        delayMaxMs: histogram.count ? histogram.max / 1e6 : null },
      memoryBytes: process.memoryUsage(), resourceDelta, droppedRecords,
    });
    histogram.reset();
    previousMonoMs = nowMonoMs;
    previousWallMs = nowWallMs;
    previousCpu = cpu;
    previousElu = elu;
    previousResources = resources;
  }
  function recordGc(entries) {
    if (entries.length === 0) return;
    // A long allocation storm can deliver thousands of GC entries at once.
    // Preserve all totals and the 32 longest event intervals without flooding
    // the stream ahead of the stall sample we are trying to capture.
    const longest = [];
    const byKind = {};
    let totalDurationMs = 0;
    let startMonoMs = Infinity;
    let endMonoMs = 0;
    for (const entry of entries) {
      const event = { startMonoMs: entry.startTime, endMonoMs: entry.startTime + entry.duration,
        durationMs: entry.duration, kind: entry.detail?.kind ?? null, flags: entry.detail?.flags ?? null };
      totalDurationMs += event.durationMs;
      startMonoMs = Math.min(startMonoMs, event.startMonoMs);
      endMonoMs = Math.max(endMonoMs, event.endMonoMs);
      const kind = byKind[event.kind] || (byKind[event.kind] = { count: 0, durationMs: 0 });
      kind.count += 1;
      kind.durationMs += event.durationMs;
      if (longest.length < 32) longest.push(event);
      else {
        let smallest = 0;
        for (let i = 1; i < longest.length; i += 1) {
          if (longest[i].durationMs < longest[smallest].durationMs) smallest = i;
        }
        if (event.durationMs > longest[smallest].durationMs) longest[smallest] = event;
      }
    }
    record("gc", { count: entries.length, totalDurationMs, startMonoMs, endMonoMs, byKind,
      omittedEventDetails: entries.length - longest.length,
      longest: longest.sort((left, right) => left.startMonoMs - right.startMonoMs) });
  }
  const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  record("start", {
    schemaVersion: 1, pid: process.pid, node: process.version, platform: process.platform,
    timeOriginUnixMs: performance.timeOrigin, durationMs, sampleMs, segmentMs, samplingIntervalUs,
    gcKinds: Object.fromEntries(Object.entries(constants).filter(([name]) => /^NODE_PERFORMANCE_GC_/.test(name))),
    resourceUsageLimit: "CPU is process-wide; profiles and GC are main isolate. Windows page-fault/context-switch fields are unavailable.",
  });

  let session = null;
  let cpuRunning = false;
  let cpuStartMonoMs = null;
  let sequence = 0;
  let rotation = null;
  let stopping = false;
  let stopPromise = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  function cpuError(error) {
    record("cpu-error", { message: error.message });
    cpuRunning = false;
    try { session?.disconnect(); } catch (_) { /* already disconnected */ }
    session = null;
    announce(`CPU capture unavailable: ${error.message}; event/GC capture continues`);
  }
  // Callback chaining starts sampling immediately, before synchronous bootstrap
  // imports. No inspector port is opened by Session.connect().
  const ready = new Promise((resolve) => {
    try {
      session = new inspector.Session();
      session.connect();
      session.post("Profiler.enable", (error) => {
        if (error) { cpuError(error); resolve(false); return; }
        session.post("Profiler.setSamplingInterval", { interval: samplingIntervalUs }, (intervalError) => {
          if (intervalError) { cpuError(intervalError); resolve(false); return; }
          session.post("Profiler.start", (startError) => {
            if (startError) { cpuError(startError); resolve(false); return; }
            cpuRunning = true;
            cpuStartMonoMs = performance.now();
            record("cpu-start", { profileSequence: 1, startMonoMs: cpuStartMonoMs });
            resolve(true);
          });
        });
      });
    } catch (error) { cpuError(error); resolve(false); }
  });
  const post = (method) => new Promise((resolve, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolve(result));
  });
  async function finishSegment(final) {
    if (!cpuRunning) return;
    try {
      const startMonoMs = cpuStartMonoMs;
      const { profile } = await post("Profiler.stop");
      const endMonoMs = performance.now();
      cpuRunning = false;
      const file = `cpu-${String(++sequence).padStart(3, "0")}.cpuprofile`;
      if (!final && !stopping) {
        await post("Profiler.start");
        cpuRunning = true;
        cpuStartMonoMs = performance.now();
        record("cpu-start", { profileSequence: sequence + 1, startMonoMs: cpuStartMonoMs });
      }
      const writeStartMonoMs = performance.now();
      await fs.promises.writeFile(path.join(directory, file), JSON.stringify(profile), { flag: "wx" });
      record("cpu-profile", { file, startMonoMs, endMonoMs,
        v8StartUs: profile.startTime, v8EndUs: profile.endTime,
        samples: profile.samples?.length || 0, writeMs: performance.now() - writeStartMonoMs });
    } catch (error) { cpuError(error); }
  }
  async function finish(reason) {
    await ready;
    if (rotation) await rotation;
    await finishSegment(true);
    sample(true);
    recordGc(observer.takeRecords());
    observer.disconnect();
    histogram.disable();
    try { session?.disconnect(); } catch (_) { /* already disconnected */ }
    record("stop", { reason, elapsedMs: performance.now() - startedMonoMs, profiles: sequence, droppedRecords });
    await new Promise((resolve) => {
      if (stream.destroyed) { resolve(); return; }
      stream.once("close", resolve);
      stream.end();
    });
    announce(`finished (${reason}): ${directory}`);
    resolveStopped({ directory, reason, writeError });
  }
  function stop(reason = "requested") {
    if (!stopPromise) {
      stopping = true;
      clearInterval(sampleTimer);
      clearInterval(cpuTimer);
      clearTimeout(deadlineTimer);
      stopPromise = finish(reason);
    }
    return stopPromise;
  }
  const sampleTimer = setInterval(() => sample(), sampleMs);
  const cpuTimer = setInterval(() => {
    if (stopping || rotation) return;
    rotation = ready.then(() => finishSegment(false)).finally(() => { rotation = null; });
  }, segmentMs);
  const deadlineTimer = setTimeout(() => { void stop("duration-limit"); }, durationMs);
  sampleTimer.unref();
  cpuTimer.unref();
  deadlineTimer.unref();
  announce(`pid=${process.pid} capturing ${durationMs / 1000}s in ${directory}`);
  return { enabled: true, directory, ready, stopped, stop };
}

module.exports = { startPauseProfilerFromEnvironment, startPauseProfiler };
