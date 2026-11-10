"use strict";
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { CrewError } = require("./crewService");
const progression = require("./crewProgression");
const TABLE = "refiningCrewRuntime", MAX_RECEIPTS = 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const positive = n => Number.isSafeInteger(n) && n > 0;
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).sort().join() === [...keys].sort().join();
const fail = (code, message, status = 409) => { throw new CrewError(code, message, status); };
function normalize(input) {
  if (!exact(input, ["commandID", "expectedRevision", "type", "payload"]) || typeof input.commandID !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.commandID) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !["start", "pause", "resume", "stop", "prioritize"].includes(input.type)) fail("CREW_COMMAND_INVALID", "The refining order is invalid.", 400);
  const keys = input.type === "start" ? ["stationID", "typeID", "oreReserve",...(Object.hasOwn(input.payload||{},"followProduction")?["followProduction"]:[])] : input.type==="prioritize"?["enabled"]:[];
  if (!exact(input.payload, keys) || (input.type === "start" && (!positive(input.payload.stationID) || !positive(input.payload.typeID) ||
      !Number.isSafeInteger(input.payload.oreReserve) || input.payload.oreReserve < 0 || (keys.includes("followProduction")&&typeof input.payload.followProduction!=="boolean"))) ||
      (input.type==="prioritize"&&typeof input.payload.enabled!=="boolean")) fail("CREW_COMMAND_INVALID", "Choose a station, ore, nonnegative reserve and a valid production-following option.", 400);
  const command = { commandID: input.commandID, expectedRevision: input.expectedRevision, type: input.type,
    payload: Object.fromEntries(keys.map(key => [key, input.payload[key]])) };
  return { ...command, fingerprint: hash(JSON.stringify(command)) };
}
function createRefiningCrewService({ repo, inventory, crew, planning, enabled = true, now = Date.now, cycleMs = 30000, batchM3 = 1000 }) {
  if (!repo || !inventory || typeof crew !== "function" || !positive(cycleMs) || !positive(batchM3) || batchM3 > 1000) throw new TypeError("Invalid refinery dependencies");
  let initialized = false, cursor = 0, ticking = false;
  const active = new Set(), lanes = new Map();
  function validate(state, id) {
    progression.validate(state?.progression);
    const invalid = () => fail("CREW_STATE_INVALID", "The saved refinery team needs recovery.", 503);
    if (!state || state.version !== 1 || state.ownerID !== id || !positive(id) || !positive(8_400_000_000_000_000 + id) ||
        state.escrowLocationID !== 8_400_000_000_000_000 + id || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
        !positive(state.nextSerial) || !positive(state.systemID) || typeof state.paused !== "boolean" ||
        !state.plan || typeof state.plan.enabled !== "boolean" || !positive(state.plan.stationID) || !positive(state.plan.typeID) ||
        !Number.isSafeInteger(state.plan.oreReserve) || state.plan.oreReserve < 0 || (state.plan.followProduction!==undefined&&typeof state.plan.followProduction!=="boolean") ||
        inventory.station(state.plan.stationID)?.solarSystemID !== state.systemID ||
        !Array.isArray(state.roster) || state.roster.length !== 2 || state.roster.some((p, index) => !p || p.actorID !== `refining:${id}:member:${index}`) ||
        !state.receipts || typeof state.receipts !== "object" || Array.isArray(state.receipts) || Object.keys(state.receipts).length > MAX_RECEIPTS ||
        !Array.isArray(state.history) || state.history.length > 20 || !Number.isSafeInteger(state.totalOreProcessed) || state.totalOreProcessed < 0 ||
        !Number.isSafeInteger(state.completedBatches) || state.completedBatches < 0 || !state.mineralsProduced ||
        Object.values(state.mineralsProduced).some(n => !Number.isSafeInteger(n) || n < 0)) invalid();
    if (state.job) {
      const j = state.job, q = j.quote;
      if (!/^[a-f0-9]{64}$/.test(j.jobID) || !positive(j.serial) || j.serial >= state.nextSerial ||
          !["reserving", "working", "settling", "returning", "acknowledging"].includes(j.phase) ||
          !Number.isSafeInteger(j.nextAtMs) || !positive(j.cycleMs) || (j.pausedAtMs !== null && !Number.isSafeInteger(j.pausedAtMs)) ||
          !j.cargo || !positive(j.cargo.itemID) || j.cargo.typeID !== state.plan.typeID || !positive(j.cargo.quantity) ||
          !q || q.typeID !== j.cargo.typeID || !positive(q.portionSize) || !positive(q.quantityToProcess) ||
          q.quantityToProcess % q.portionSize !== 0 || !Number.isSafeInteger(q.leftOvers) || q.leftOvers < 0 ||
          q.quantityToProcess + q.leftOvers !== j.cargo.quantity || !Number.isFinite(q.totalCost) || q.totalCost < 0 ||
          !Number.isFinite(q.efficiency) || q.efficiency <= 0 || q.efficiency > 1 ||
          !Array.isArray(q.outputs) || !q.outputs.length || q.outputs.length > 16 ||
          q.outputs.some(o => !positive(o.typeID) || !positive(o.quantity)) || new Set(q.outputs.map(o => o.typeID)).size !== q.outputs.length) invalid();
      if (j.cargo.custodyItemID !== undefined && !positive(j.cargo.custodyItemID)) invalid();
      if (j.cargo.inputs && (!Array.isArray(j.cargo.inputs) || !j.cargo.inputs.length || j.cargo.inputs.length > 32 ||
          j.cargo.inputs.some(i => !positive(i.itemID) || !positive(i.quantity) || !positive(i.sourceQuantity) || i.quantity > i.sourceQuantity) ||
          new Set(j.cargo.inputs.map(i => i.itemID)).size !== j.cargo.inputs.length ||
          j.cargo.inputs.reduce((n, i) => n + i.quantity, 0) !== j.cargo.quantity || j.cargo.inputs[0].itemID !== j.cargo.itemID)) invalid();
    }
  }
  function check() {
    if (!enabled) fail("CREW_DISABLED", "Crew refining is disabled.", 503);
    if (!initialized) {
      repo.ensureTable(TABLE); const root = repo.read(TABLE, "/");
      if (!root.success || !root.data || Array.isArray(root.data) || Object.keys(root.data).length > 128) fail("CREW_STORE_UNAVAILABLE", "Refinery records are unavailable.", 503);
      for (const [id, state] of Object.entries(root.data)) { validate(state, Number(id)); if (state.job || state.plan.enabled) active.add(Number(id)); }
      initialized = true;
    }
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Refinery records are pending. Retry the same order.", 503);
  }
  function load(id) {
    if (!positive(id) || !positive(8_400_000_000_000_000 + id)) fail("CREW_OWNER_INVALID", "Select a valid pilot.", 400);
    const row = repo.read(TABLE, `/${id}`);
    if (!row.success) { if (row.errorMsg === "ENTRY_NOT_FOUND") return null; fail("CREW_STORE_UNAVAILABLE", "Refinery records are unavailable.", 503); }
    validate(row.data, id); const state = clone(row.data); progression.ensure(state, "refining"); return state;
  }
  function save(state) {
    progression.ensure(state, "refining");
    validate(state, state.ownerID); state.revision++;
    if (repo.write(TABLE, `/${state.ownerID}`, clone(state))?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Refinery records are pending.", 503);
    if (state.job || state.plan.enabled) active.add(state.ownerID); else active.delete(state.ownerID);
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Refinery records are pending. Retry the same order.", 503);
  }
  function run(id, action) {
    const previous = lanes.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action); lanes.set(id, next);
    void next.finally(() => { if (lanes.get(id) === next) lanes.delete(id); }).catch(() => {}); return next;
  }
  async function progress(state, atMs) {
    if (!state) return;
    if (!state.job) {
      if (!state.plan.enabled || state.paused || atMs < (state.nextCheckAtMs || 0)) return;
      let selection;
      if(state.plan.followProduction){
        const decision=await planning.refining(state,batchM3);state.priority=decision.priority;
        if(!decision.choice){state.status=decision.status;state.nextCheckAtMs=atMs+10000;save(state);return;}
        state.plan.typeID=decision.choice.typeID;state.plan.recipe=decision.choice.recipe;selection=decision.choice.selection;
      }else selection = inventory.select(state, batchM3);
      if (!selection) { state.status = "waiting_for_ore"; state.nextCheckAtMs = atMs + 5000; save(state); return; }
      if (inventory.balance(state.ownerID) < selection.quote.totalCost) {
        state.status = "insufficient_funds"; state.nextCheckAtMs = atMs + 5000; save(state); return;
      }
      const serial = state.nextSerial++;
      state.job = { ...selection, ...(state.plan.followProduction?{priority:state.priority}:{}), jobID: hash(`refining:${state.ownerID}:${serial}`), serial, phase: "reserving", cycleMs: progression.duration(cycleMs, state, "refining"), skillAtStart: progression.profile(state, "refining"),
        nextAtMs: atMs, pausedAtMs: null }; state.status = "reserving"; save(state);
    }
    for (let step = 0; step < 5 && state.job; step++) {
      const job = state.job;
      if (job.phase === "reserving") {
        inventory.reserve(state); job.phase = "working"; job.nextAtMs = atMs + job.cycleMs; state.status = "refining"; save(state); return;
      } else if (job.phase === "working") {
        if (state.paused || atMs < job.nextAtMs) return;
        job.phase = "settling"; state.status = "settling"; save(state);
      } else if (job.phase === "settling") {
        const result = await inventory.settle(state);
        job.rejected = result.rejected === true; job.rejectionError = result.errorMsg || null;
        if (job.rejected) { if(job.rejectionError !== "INSUFFICIENT_FUNDS")state.plan.enabled = false; state.status = job.rejectionError === "INSUFFICIENT_FUNDS" ? "insufficient_funds" : "input_rejected"; }
        else {
          job.experienceGained = progression.award(state, "refining");
          state.totalOreProcessed += job.quote.quantityToProcess; state.completedBatches++;
          for (const output of job.quote.outputs) state.mineralsProduced[output.typeID] = (state.mineralsProduced[output.typeID] || 0) + output.quantity;
          state.totalTaxPaid = Math.round((state.totalTaxPaid + job.quote.totalCost) * 100) / 100;
        }
        state.history.unshift({ jobID: job.jobID, completedAtMs: atMs, stationID: state.plan.stationID, rejected: job.rejected,
          oreTypeID: job.cargo.typeID, oreQuantity: job.rejected ? 0 : job.quote.quantityToProcess,
          outputs: job.rejected ? [] : job.quote.outputs, taxPaid: job.rejected ? 0 : job.quote.totalCost,priority:job.priority, experienceGained: job.experienceGained || 0 }); state.history = state.history.slice(0, 20);
        job.phase = "returning"; delete job.recoveryError; save(state);
      } else if (job.phase === "returning") {
        inventory.returnRemainder(state); job.phase = "acknowledging"; save(state);
      } else {
        inventory.acknowledge(state); const rejected = job.rejected; state.job = null;
        if (!rejected) state.status = state.paused ? "paused" : state.plan.enabled ? "ready" : "stopped";
        state.nextCheckAtMs = rejected ? atMs + 5000 : atMs; save(state); return;
      }
    }
  }
  function snapshot(id) {
    if (!enabled) return { enabled: false, revision: 0, refining: null };
    check(); const state = load(id);
    return { enabled: true, planningEnabled:Boolean(planning), revision: state?.revision || 0, refining: state ? { ...state, receipts: undefined,
      station: inventory.station(state.plan.stationID), skill: progression.profile(state, "refining") } : null, settings: { cycleMs, batchM3 }, commandCapacityRemaining: MAX_RECEIPTS - Object.keys(state?.receipts || {}).length };
  }
  function submit(id, input) { return run(id, async () => {
    check(); const command = normalize(input), receiptID = hash(command.commandID), atMs = now(); let state = load(id);
    const prior = state?.receipts[receiptID];
    if (prior) { if (prior.fingerprint !== command.fingerprint) fail("CREW_COMMAND_REUSED", "This order ID describes another order."); return { ...snapshot(id), replayed: true }; }
    if ((state?.revision || 0) !== command.expectedRevision) fail("CREW_REVISION_CONFLICT", "Refinery work changed. Refresh before issuing another order.");
    if (Object.keys(state?.receipts || {}).length >= MAX_RECEIPTS - (command.type === "stop" ? 0 : 1)) fail("CREW_COMMAND_CAPACITY", "The refinery order ledger is full.");
    if (command.type === "start") {
      if(command.payload.followProduction&&!planning)fail("CREW_DISABLED","Production resource planning is unavailable.",503);
      if (state?.job || state?.plan.enabled) fail("CREW_BUSY", "Stop the current refinery assignment and finish its batch first.");
      if (!crew(id)?.crew) fail("CREW_NOT_FOUND", "Establish a crew first.", 404);
      const station = inventory.station(command.payload.stationID), recipe = inventory.recipe(id, command.payload.stationID, command.payload.typeID);
      if (!state) {
        if (Object.keys(repo.read(TABLE, "/").data).length >= 128) fail("CREW_CAPACITY", "The refinery registry is full.", 503);
        state = { version: 1, ownerID: id, revision: 0, nextSerial: 1, escrowLocationID: 8_400_000_000_000_000 + id,
          receipts: {}, history: [], totalOreProcessed: 0, completedBatches: 0, totalTaxPaid: 0, mineralsProduced: {}, job: null,
          roster: [{ actorID: `refining:${id}:member:0`, name: "Tessa Renn", role: "Refining chief" },
            { actorID: `refining:${id}:member:1`, name: "Davin Korr", role: "Materials handler" }] };
      }
      state.plan = { ...command.payload, recipe, enabled: true }; state.systemID = station.solarSystemID;
      state.paused = false; state.status = "ready"; state.nextCheckAtMs = atMs;
    } else {
      if (!state?.plan.enabled) fail("CREW_NOT_FOUND", "There is no active refinery assignment.", 404);
      if(command.type==="prioritize"){
        if(command.payload.enabled&&!planning)fail("CREW_DISABLED","Production resource planning is unavailable.",503);
        state.plan.followProduction=command.payload.enabled;state.nextCheckAtMs=atMs;
      }else if (command.type === "pause") {
        if (state.paused) fail("CREW_ALREADY_PAUSED", "The refinery is already paused.");
        state.paused = true; if (state.job) state.job.pausedAtMs = atMs;
      } else {
        if (command.type === "resume" && !state.paused) fail("CREW_NOT_PAUSED", "The refinery is not paused.");
        if (command.type === "stop") state.plan.enabled = false;
        if (state.job?.pausedAtMs !== null && state.job?.pausedAtMs !== undefined) { state.job.nextAtMs += Math.max(0, atMs - state.job.pausedAtMs); state.job.pausedAtMs = null; }
        state.paused = false; state.nextCheckAtMs = atMs;
        if (!state.job && !state.plan.enabled) state.status = "stopped";
      }
    }
    state.receipts[receiptID] = { fingerprint: command.fingerprint, acceptedAtMs: atMs };
    save(state); await progress(state, atMs); return { ...snapshot(id), replayed: false };
  }); }
  async function tick({ budgetMs = 4 } = {}) {
    if (!enabled || ticking) return { processed: 0, errors: [] };
    ticking = true;
    try {
      check(); const ids = [...active], errors = [], started = performance.now(); let processed = 0;
      for (let i = 0; i < Math.min(ids.length, 8); i++) {
        if (i && performance.now() - started >= budgetMs) break;
        const id = ids[(cursor + i) % ids.length]; if (lanes.has(id)) { processed++; continue; }
        try { await run(id, () => progress(load(id), now())); } catch (error) {
          errors.push({ ownerID: id, code: error.code || "CREW_RETRY_PENDING" });
          try { const state = load(id); if (state?.job && !state.job.recoveryError) { state.job.recoveryError = "Refining is awaiting confirmation. The saved batch will retry."; save(state); } } catch { /* retain durable intent */ }
        }
        processed++;
      }
      cursor = ids.length ? (cursor + processed) % ids.length : 0; return { processed, errors };
    } finally { ticking = false; }
  }
  function universeFacts({ ownerID } = {}) {
    if (!enabled) return { actors: [], recentEvents: [] }; check();
    const rows = ownerID ? [load(ownerID)].filter(Boolean) : Object.values(repo.read(TABLE, "/").data);
    return { actors: rows.flatMap(s => s.roster.map(p => ({ ...p, ownerID: s.ownerID, kind: "crew_member", source: "refining_crews",
      crewID: `refining:${s.ownerID}`, crewName: "Refining crew", stationID: s.plan.stationID, systemID: s.systemID,
      activity: s.job?.recoveryError ? "awaiting_confirmation" : s.paused ? "paused" : s.job ? "refining" : s.status,
      representation: "virtual", physicalEntityID: null, skill: progression.profile(s, "refining") }))), recentEvents: rows.flatMap(s => s.history.filter(h => !h.rejected).map(h => ({
        eventID: `refining:${h.jobID}:completed`, type: "ore_refined", source: "refining_crews", ownerID: s.ownerID,
        crewID: `refining:${s.ownerID}`, stationID: h.stationID, occurredAtMs: h.completedAtMs, oreQuantity: h.oreQuantity, outputs: h.outputs }))) };
  }
  return Object.freeze({ enabled, snapshot, submit, tick, universeFacts, drain: () => Promise.allSettled([...lanes.values()]), options(id, stationID, extraTypeID) {
    check(); if (!crew(id)?.crew) fail("CREW_NOT_FOUND", "Establish a crew first.", 404); return inventory.options(id, stationID, extraTypeID);
  } });
}
module.exports = { TABLE, createRefiningCrewService };
