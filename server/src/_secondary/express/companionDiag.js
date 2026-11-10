"use strict";

// TEMPORARY DIAGNOSTIC INSTRUMENTATION — web-companion starvation investigation.
// Isolated and env-gated: does NOTHING unless EVEJS_COMPANION_DIAG=1.
// Writes to logs/companion-diag.log. Safe to delete wholesale; nothing in the
// production path depends on it beyond the guarded hook calls.
//
// Purpose: answer the central pass/fail question — during a companion
// "disconnect", is the world event loop BUSY (CPU starvation) or IDLE
// (a wedged socket / lost correlation)? Plus: does any per-session structure
// (notification backlog, push-ring) grow without bound over wall-clock time?

const path = require("node:path");
const { resolveDataRootPath } = require(path.join(__dirname, "../../config/dataRoot"));
const { monitorEventLoopDelay } = require("node:perf_hooks");

const ENABLED = String(process.env.EVEJS_COMPANION_DIAG || "") === "1";

let rotatingLog = null;
let logPath = null;
if (ENABLED) {
  try {
    rotatingLog = require(path.join(__dirname, "../../utils/rotatingLog"));
    logPath = resolveDataRootPath("logs", "companion-diag.log");
  } catch {
    rotatingLog = null;
  }
}

function write(line) {
  if (!ENABLED || !rotatingLog || !logPath) return;
  try {
    rotatingLog.append(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // ignored: diagnostic writes must never disturb the world.
  }
}

// ---------------------------------------------------------------------------
// In-flight gateway call accounting + slow-call log.
const SLOW_CALL_MS = Number(process.env.EVEJS_COMPANION_DIAG_SLOW_MS || 250);
let inFlightCalls = 0;
let peakInFlight = 0;
let totalCalls = 0;
let slowCalls = 0;
const callCountByMethod = new Map();
const callTimeByMethod = new Map();

// Provider hooks the gateway registers so the 1 Hz sampler can read live state
// without this module importing the runtime (avoids a require cycle).
let sessionStateProvider = null;
let wsStateProvider = null;

function registerSessionStateProvider(fn) {
  if (typeof fn === "function") sessionStateProvider = fn;
}
function registerWsStateProvider(fn) {
  if (typeof fn === "function") wsStateProvider = fn;
}

// Wrap an async gateway dispatch. `label` is "service.method".
async function instrumentCall(label, backlogBefore, fn) {
  if (!ENABLED) return fn();
  inFlightCalls += 1;
  totalCalls += 1;
  if (inFlightCalls > peakInFlight) peakInFlight = inFlightCalls;
  const startNs = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    inFlightCalls -= 1;
    const ms = Number(process.hrtime.bigint() - startNs) / 1e6;
    callCountByMethod.set(label, (callCountByMethod.get(label) || 0) + 1);
    callTimeByMethod.set(label, (callTimeByMethod.get(label) || 0) + ms);
    if (ms >= SLOW_CALL_MS) {
      slowCalls += 1;
      write(
        `SLOWCALL ${label} ${ms.toFixed(1)}ms inflight=${inFlightCalls + 1} ` +
          `backlogBefore=${backlogBefore == null ? "?" : backlogBefore}`,
      );
    }
  }
}

function noteWs(event, detail) {
  if (!ENABLED) return;
  write(`WS ${event} ${detail || ""}`);
}

// ---------------------------------------------------------------------------
// 1 Hz sampler: event-loop delay histogram + live gateway state.
let histogram = null;
let samplerHandle = null;
let lastSampleMs = Date.now();

function startSampler() {
  if (!ENABLED || samplerHandle) return;
  try {
    histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
  } catch {
    histogram = null;
  }
  lastSampleMs = Date.now();
  let lastSampleNs = process.hrtime.bigint();
  samplerHandle = setInterval(() => {
    const now = Date.now();
    const nowNs = process.hrtime.bigint();
    // ⚠ TWO CLOCKS, DELIBERATELY.
    //
    // `wallGap` is Date.now()-based and therefore moves when the SYSTEM CLOCK
    // moves — a Windows time-service correction steps it by seconds, and that
    // is indistinguishable from a stall if you only look at one clock. This
    // produced a false "4654ms stall" alert on 2026-08-31 whose event-loop
    // delay histogram, which is monotonic, showed a max of 40.6ms: nothing had
    // blocked at all.
    //
    // `monoGap` is monotonic and is the one that actually answers "was this
    // process stopped". Their difference is the clock step itself, so a
    // correction is now REPORTED as a correction instead of masquerading as a
    // freeze.
    const monoGap = Number(nowNs - lastSampleNs) / 1e6;
    const wallGap = now - lastSampleMs;
    const clockStep = Math.round(wallGap - monoGap);
    lastSampleMs = now;
    lastSampleNs = nowNs;

    let elp50 = 0;
    let elp99 = 0;
    let elMax = 0;
    if (histogram) {
      // ns -> ms
      elp50 = histogram.percentile(50) / 1e6;
      elp99 = histogram.percentile(99) / 1e6;
      elMax = histogram.max / 1e6;
      histogram.reset();
    }

    let sess = "";
    if (sessionStateProvider) {
      try {
        sess = sessionStateProvider() || "";
      } catch {
        sess = "sessErr";
      }
    }
    let ws = "";
    if (wsStateProvider) {
      try {
        ws = wsStateProvider() || "";
      } catch {
        ws = "wsErr";
      }
    }

    let mem = "";
    try {
      const m = process.memoryUsage();
      mem = ` | rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}/${Math.round(m.heapTotal / 1048576)}MB ext=${Math.round((m.external || 0) / 1048576)}MB`;
    } catch {
      mem = "";
    }

    // A clock correction is its own event, not a stall. Report it separately so
    // it can never be read as one.
    if (Math.abs(clockStep) >= 250) {
      write(
        `CLOCKSTEP ${clockStep > 0 ? "+" : ""}${clockStep}ms ` +
          `(wallGap=${wallGap}ms monoGap=${monoGap.toFixed(0)}ms) — system clock moved, ` +
          `NOT an event-loop stall`,
      );
    }

    write(
      `SAMPLE monoGap=${monoGap.toFixed(0)}ms wallGap=${wallGap}ms elDelay(p50/p99/max)=` +
        `${elp50.toFixed(1)}/${elp99.toFixed(1)}/${elMax.toFixed(1)}ms ` +
        `inflight=${inFlightCalls} peakInflight=${peakInFlight} ` +
        `calls=${totalCalls} slow=${slowCalls} | ${sess} | ${ws}${mem}`,
    );
    peakInFlight = inFlightCalls;
  }, 1000);
  if (samplerHandle && typeof samplerHandle.unref === "function") {
    samplerHandle.unref();
  }
  write(
    `DIAG START pid=${process.pid} slowCallMs=${SLOW_CALL_MS} ` +
      `node=${process.version}`,
  );
}

if (ENABLED) {
  startSampler();
}

module.exports = {
  ENABLED,
  instrumentCall,
  noteWs,
  registerSessionStateProvider,
  registerWsStateProvider,
  write,
};
