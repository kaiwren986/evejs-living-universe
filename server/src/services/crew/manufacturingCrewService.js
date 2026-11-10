"use strict";
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { CrewError } = require("./crewService");
const { compareProductionPriority, productionPriority } = require("./productionPriority");
const progression = require("./crewProgression");
const TABLE = "manufacturingCrewRuntime";
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const positive = n => Number.isSafeInteger(n) && n > 0;
const exact = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();
const fail = (code, message, status = 409) => { throw new CrewError(code, message, status); };
function normalize(input) {
  if (!exact(input, ["commandID", "expectedRevision", "type", "payload"]) || typeof input.commandID !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.commandID) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !["starter", "start", "pause", "resume", "stop"].includes(input.type)) fail("CREW_COMMAND_INVALID", "The manufacturing order is invalid.", 400);
  const keys = input.type === "start" ? ["stationID", "orders"] : input.type === "starter" ? ["stationID"] : [];
  if (!exact(input.payload, keys) || (keys.length && !positive(input.payload.stationID))) fail("CREW_COMMAND_INVALID", "Choose a factory and production queue.", 400);
  if (input.type === "start" && (!Array.isArray(input.payload.orders) || !input.payload.orders.length || input.payload.orders.length > 8 ||
      input.payload.orders.some(o => !exact(o, ["blueprintID", "runs", "targetStock"]) || !positive(o.blueprintID) || !positive(o.runs) || o.runs > 1000 || !positive(o.targetStock) || o.targetStock > 1000000) ||
      new Set(input.payload.orders.map(o => o.blueprintID)).size !== input.payload.orders.length)) fail("CREW_COMMAND_INVALID", "Use up to eight different blueprints, 1–1000 runs per batch and a stock target up to 1,000,000.", 400);
  const command = { commandID: input.commandID, expectedRevision: input.expectedRevision, type: input.type, payload: clone(input.payload) };
  return { ...command, fingerprint: hash(JSON.stringify(command)) };
}
function createManufacturingCrewService({ repo, industry, crew, enabled = true, now = Date.now }) {
  let initialized = false, cursor = 0, ticking = false;
  const active = new Set(), lanes = new Map();
  function validate(s, id) {
    progression.validate(s?.progression);
    const invalid = () => fail("CREW_STATE_INVALID", "The saved manufacturing crew needs recovery.", 503);
    if (!s || s.version !== 1 || s.ownerID !== id || !positive(id) || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
        !positive(s.nextSerial) || !positive(s.stationID) || industry.station(s.stationID)?.solarSystemID !== s.systemID || typeof s.paused !== "boolean" ||
        !Array.isArray(s.roster) || s.roster.length !== 2 || s.roster.some((p, i) => p?.actorID !== `manufacturing:${id}:member:${i}`) ||
        !s.receipts || Array.isArray(s.receipts) || Object.keys(s.receipts).length > 1024 || !Array.isArray(s.history) || s.history.length > 20 ||
        !Number.isSafeInteger(s.completedBatches) || s.completedBatches < 0 || !s.produced || Object.values(s.produced).some(n => !Number.isSafeInteger(n) || n < 0)) invalid();
    if (s.plan && (typeof s.plan.enabled !== "boolean" || s.plan.stationID !== s.stationID || !Array.isArray(s.plan.orders) ||
        !s.plan.orders.length || s.plan.orders.length > 8 || !Number.isSafeInteger(s.plan.cursor) || s.plan.cursor < 0 || s.plan.cursor >= s.plan.orders.length ||
        s.plan.orders.some(o => !positive(o.blueprintID) || !positive(o.runs) || o.runs > 1000 || !positive(o.targetStock) || !positive(o.recipe?.productTypeID)))) invalid();
    if (s.starter && (!positive(s.starter.stationID) || typeof s.starter.complete !== "boolean")) invalid();
    if (s.selection && (s.selection.strategy !== "profit_per_hour" || !Number.isSafeInteger(s.selection.checkedAtMs) ||
        (s.selection.selectedBlueprintID !== null && !positive(s.selection.selectedBlueprintID)) || !Array.isArray(s.selection.candidates) ||
        s.selection.candidates.length > 8 || s.selection.candidates.some(c => !positive(c.blueprintID) || !positive(c.productTypeID)))) invalid();
    if (s.job) {
      const j = s.job, intent = j.intent;
      if (!/^[a-f0-9]{64}$/.test(j.jobID) || !positive(j.serial) || j.serial >= s.nextSerial ||
          !["installing", "building", "delivering", "acknowledging"].includes(j.phase) || !intent || intent.characterID !== id || intent.ownerID !== id ||
          intent.crewOrder?.jobID !== j.jobID || intent.crewOrder?.serial !== j.serial || !positive(intent.jobID) ||
          intent.jobRecord?.ownerID !== id || intent.jobRecord.facilityID !== s.stationID || intent.jobRecord.activityID !== 1 ||
          !positive(j.summary?.productTypeID) || !positive(j.summary?.quantity) || !Number.isFinite(j.summary.cost) || j.summary.cost < 0) invalid();
    }
  }
  function check() {
    if (!enabled) fail("CREW_DISABLED", "Crew manufacturing is disabled.", 503);
    if (!initialized) {
      repo.ensureTable(TABLE); const root = repo.read(TABLE, "/");
      if (!root.success || !root.data || Array.isArray(root.data) || Object.keys(root.data).length > 128) fail("CREW_STORE_UNAVAILABLE", "Manufacturing records are unavailable.", 503);
      for (const [id, s] of Object.entries(root.data)) { validate(s, Number(id)); if (s.job || s.plan?.enabled || (s.starter && !s.starter.complete)) active.add(Number(id)); }
      initialized = true;
    }
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Manufacturing records are pending. Retry the same order.", 503);
  }
  function load(id) {
    if (!positive(id)) fail("CREW_OWNER_INVALID", "Select a valid pilot.", 400);
    const result = repo.read(TABLE, `/${id}`);
    if (!result.success) { if (result.errorMsg === "ENTRY_NOT_FOUND") return null; fail("CREW_STORE_UNAVAILABLE", "Manufacturing records are unavailable.", 503); }
    validate(result.data, id); const state = clone(result.data); progression.ensure(state, "manufacturing"); return state;
  }
  function save(s) {
    progression.ensure(s, "manufacturing");
    validate(s, s.ownerID); s.revision++;
    if (repo.write(TABLE, `/${s.ownerID}`, clone(s))?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Manufacturing records are pending.", 503);
    if (s.job || s.plan?.enabled || (s.starter && !s.starter.complete)) active.add(s.ownerID); else active.delete(s.ownerID);
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Manufacturing records are pending. Retry the same order.", 503);
  }
  function run(id, action) {
    const promise = (lanes.get(id) || Promise.resolve()).catch(() => {}).then(action); lanes.set(id, promise);
    void promise.finally(() => { if (lanes.get(id) === promise) lanes.delete(id); }).catch(() => {}); return promise;
  }
  async function progress(s, atMs) {
    if (!s) return;
    if (s.starter && !s.starter.complete) { industry.starter(s.ownerID, s.starter.stationID); s.starter.complete = true; save(s); }
    if (!s.job) {
      if (!s.plan?.enabled || s.paused || atMs < s.nextCheckAtMs) return;
      const availability = [], assessed = []; let candidate = null;
      for (let offset = 0; offset < s.plan.orders.length; offset++) {
        const index = (s.plan.cursor + offset) % s.plan.orders.length, order = s.plan.orders[index];
        const stock = industry.stock(s.ownerID, s.stationID, order.recipe.productTypeID);
        if (stock >= order.targetStock) { availability.push({ blueprintID: order.blueprintID, status: "stock_target_met", stock }); continue; }
        const result = await industry.assess(s.ownerID, s.stationID, order);
        const row = { blueprintID: order.blueprintID, stock, status: result.status, errors: result.errors, profit: result.profit };
        availability.push(row);
        assessed.push({ index, order, result, row, profit: result.profit, timeSeconds: result.summary?.timeSeconds });
      }
      const ranked = assessed.sort(compareProductionPriority);
      s.selection = { strategy: "profit_per_hour", checkedAtMs: atMs, selectedBlueprintID: null, candidates: [] };
      for (const choice of ranked.filter(c => c.result.ready)) {
        const serial = s.nextSerial, jobID = hash(`manufacturing:${s.ownerID}:${serial}`);
        const result = await industry.prepare(s.ownerID, s.stationID, choice.order, { jobID, serial });
        if (!result.ready) { Object.assign(choice.row, { status: result.status, errors: result.errors, profit: result.profit }); Object.assign(choice.result,{ready:false,status:result.status}); continue; }
        choice.profit=result.summary.profit;choice.timeSeconds=result.summary.timeSeconds;choice.row.profit=choice.profit;
        // A still-profitable quote may have lost first place while being
        // refreshed. No native effect has started: try the stronger option.
        if(ranked.some(other=>other!==choice&&other.result.ready&&compareProductionPriority(other,choice)<0))continue;
        candidate = { jobID, serial, phase: "installing", intent: result.intent,
          summary: { ...result.summary, priority: productionPriority({ profit: result.summary.profit, timeSeconds: result.summary.timeSeconds }) } };
        s.selection.selectedBlueprintID = choice.order.blueprintID;
        s.plan.cursor = (choice.index + 1) % s.plan.orders.length; s.nextSerial++; break;
      }
      s.selection.candidates=ranked.slice().sort(compareProductionPriority).map(c=>({blueprintID:c.order.blueprintID,productTypeID:c.order.recipe.productTypeID,
        name:c.order.recipe.name,ready:c.result.ready,status:c.result.status,stock:c.row.stock,targetStock:c.order.targetStock,...productionPriority(c)}));
      s.availability = availability;
      if (!candidate) { s.status = availability.every(a => a.status === "stock_target_met") ? "stock_target_met" : availability.find(a => a.status !== "stock_target_met")?.status || "waiting_for_materials";
        s.nextCheckAtMs = atMs + 5000; save(s); return; }
      s.job = candidate; s.status = "installing"; save(s);
    }
    for (let step = 0; step < 4 && s.job; step++) {
      const job = s.job;
      if (job.phase === "installing") {
        const result = await industry.install(job);
        if (result.deferred) {
          s.availability = [{ blueprintID: job.summary.blueprintID, stock: industry.stock(s.ownerID,s.stationID,job.summary.productTypeID), status: result.status, profit: result.profit }];
          s.job = null; s.status = result.status; s.nextCheckAtMs = atMs + 5000; save(s); return;
        }
        if (result.rejected) { job.rejected = true; job.outcome = result.errorMsg; if(result.errorMsg !== "INSUFFICIENT_FUNDS")s.plan.enabled = false; s.status = result.errorMsg === "INSUFFICIENT_FUNDS" ? "insufficient_funds" : "installation_rejected"; job.phase = "acknowledging"; }
        else { job.phase = "building"; job.endDate = job.intent.jobRecord.endDate; s.totalFeesPaid = Math.round((s.totalFeesPaid + job.summary.cost) * 100) / 100; s.status = "building"; }
        delete job.recoveryError; save(s);
      } else if (job.phase === "building") {
        const native = industry.inspect(job); job.endDate = native.endDate;
        if (native.status < 3) { if (s.status !== "building") { s.status = "building"; save(s); } return; }
        job.phase = "delivering"; s.status = "delivering"; save(s);
      } else if (job.phase === "delivering") {
        const result = industry.deliver(job);
        if (!result.delivered && !result.cancelled) return;
        job.outcome = result.delivered ? "delivered" : "cancelled";
        if (result.delivered) { job.experienceGained = progression.award(s, "manufacturing"); s.completedBatches++; s.produced[job.summary.productTypeID] = (s.produced[job.summary.productTypeID] || 0) + job.summary.quantity; }
        else { s.plan.enabled = false; s.status = "job_cancelled"; }
        s.history.unshift({ jobID: job.jobID, nativeJobID: job.intent.jobID, completedAtMs: atMs, outcome: job.outcome,
          name: job.summary.name, productTypeID: job.summary.productTypeID, quantity: result.delivered ? job.summary.quantity : 0, cost: job.summary.cost, priority: job.summary.priority, experienceGained: job.experienceGained || 0 });
        s.history = s.history.slice(0, 20); job.phase = "acknowledging"; delete job.recoveryError; save(s);
      } else {
        industry.acknowledge(job); const failed = job.rejected || job.outcome === "cancelled"; s.job = null;
        if (!failed) s.status = s.paused ? "paused" : s.plan.enabled ? "ready" : "stopped";
        s.nextCheckAtMs = failed ? atMs + 5000 : atMs; save(s); return;
      }
    }
  }
  function snapshot(id) {
    if (!enabled) return { enabled: false, revision: 0, manufacturing: null };
    check(); const s = load(id);
    let job = s?.job ? clone(s.job) : null;
    if (job) { job.nativeJobID = job.intent.jobID; delete job.intent; }
    return { enabled: true, revision: s?.revision || 0, manufacturing: s ? { ...s, receipts: undefined, job,
      station: industry.station(s.stationID), skill: progression.profile(s, "manufacturing"), equipment: require("./crewEquipmentState").forOwner(id, "manufacturing") } : null, commandCapacityRemaining: 1024 - Object.keys(s?.receipts || {}).length };
  }
  function submit(id, input) { return run(id, async () => {
    check(); const command = normalize(input), key = hash(command.commandID), atMs = now(); let s = load(id);
    const prior = s?.receipts[key]; if (prior) { if (prior !== command.fingerprint) fail("CREW_COMMAND_REUSED", "This order ID describes another order."); return { ...snapshot(id), replayed: true }; }
    if ((s?.revision || 0) !== command.expectedRevision) fail("CREW_REVISION_CONFLICT", "Manufacturing work changed. Refresh before issuing another order.");
    if (Object.keys(s?.receipts || {}).length >= 1024 - (command.type === "stop" ? 0 : 1)) fail("CREW_COMMAND_CAPACITY", "The manufacturing order ledger is full.");
    if (["starter", "start"].includes(command.type)) {
      if (!crew(id)?.crew) fail("CREW_NOT_FOUND", "Establish a crew first.", 404);
      const station = industry.station(command.payload.stationID);
      if (!station) fail("CREW_STATION_INVALID", "Choose an NPC station with a factory.", 400);
      const catalog = industry.catalog(id, station.stationID);
      if (!s) {
        if (Object.keys(repo.read(TABLE, "/").data).length >= 128) fail("CREW_CAPACITY", "The manufacturing registry is full.", 503);
        s = { version: 1, ownerID: id, revision: 0, nextSerial: 1, stationID: station.stationID, systemID: station.solarSystemID,
          receipts: {}, history: [], produced: {}, completedBatches: 0, totalFeesPaid: 0, job: null, plan: null, paused: false,
          nextCheckAtMs: atMs, status: "ready", roster: [{ actorID: `manufacturing:${id}:member:0`, name: "Nia Halen", role: "Production chief" },
            { actorID: `manufacturing:${id}:member:1`, name: "Bram Seth", role: "Assembly technician" }] };
      }
      if (command.type === "starter") {
        if (s.starter && s.starter.stationID !== station.stationID) fail("CREW_STARTER_ALREADY_ASSIGNED", "The one-time starter blueprints were assigned to another station.");
        if (!s.starter) s.starter = { stationID: station.stationID, complete: false };
      } else {
        if (s.job || s.plan?.enabled) fail("CREW_BUSY", "Stop the current queue and let its accepted job finish first.");
        const orders = command.payload.orders.map(o => { const recipe = catalog.find(r => r.blueprintID === o.blueprintID);
          if (!recipe) fail("CREW_CARGO_INVALID", "Choose owned ammo or module blueprints at this factory.", 400);
          return { ...o, recipe: industry.describe(id, station.stationID, o.blueprintID, o.runs) }; });
        s.stationID = station.stationID; s.systemID = station.solarSystemID; s.plan = { stationID: station.stationID, enabled: true, cursor: 0, orders }; delete s.selection;
        s.paused = false; s.nextCheckAtMs = atMs; s.status = "ready";
      }
    } else {
      if (!s?.plan?.enabled) fail("CREW_NOT_FOUND", "There is no active manufacturing queue.", 404);
      if (command.type === "pause") { if (s.paused) fail("CREW_ALREADY_PAUSED", "New manufacturing jobs are already paused."); s.paused = true; }
      else { if (command.type === "resume" && !s.paused) fail("CREW_NOT_PAUSED", "The manufacturing queue is not paused.");
        if (command.type === "stop") s.plan.enabled = false; s.paused = false; s.nextCheckAtMs = atMs; if (!s.job && !s.plan.enabled) s.status = "stopped"; }
    }
    s.receipts[key] = command.fingerprint; save(s); await progress(s, atMs); return { ...snapshot(id), replayed: false };
  }); }
  async function tick({ budgetMs = 4 } = {}) {
    if (!enabled || ticking) return { processed: 0, errors: [] }; ticking = true;
    try {
      check(); const ids = [...active], errors = [], started = performance.now(); let processed = 0;
      for (let i = 0; i < Math.min(ids.length, 8); i++) {
        if (i && performance.now() - started >= budgetMs) break;
        const id = ids[(cursor + i) % ids.length]; if (lanes.has(id)) { processed++; continue; }
        try { await run(id, () => progress(load(id), now())); } catch (e) {
          errors.push({ ownerID: id, code: e.code || "CREW_RETRY_PENDING" });
          try { const s = load(id); if (s?.job && !s.job.recoveryError) { s.job.recoveryError = "Manufacturing is awaiting confirmation. The saved job will retry."; save(s); } } catch { /* retain durable intent */ }
        }
        processed++;
      }
      cursor = ids.length ? (cursor + processed) % ids.length : 0; return { processed, errors };
    } finally { ticking = false; }
  }
  function universeFacts({ ownerID } = {}) {
    if (!enabled) return { actors: [], recentEvents: [] }; check(); const rows = ownerID ? [load(ownerID)].filter(Boolean) : Object.values(repo.read(TABLE, "/").data);
    return { actors: rows.flatMap(s => s.roster.map(p => ({ ...p, ownerID: s.ownerID, kind: "crew_member", source: "manufacturing_crews", crewID: `manufacturing:${s.ownerID}`,
      crewName: "Manufacturing crew", stationID: s.stationID, systemID: s.systemID, activity: s.job?.recoveryError ? "awaiting_confirmation" : s.job ? "manufacturing" : s.paused ? "paused" : s.status,
      representation: "virtual", physicalEntityID: null, skill: progression.profile(s, "manufacturing") }))), recentEvents: rows.flatMap(s => s.history.filter(h => h.outcome === "delivered").map(h => ({
        eventID: `manufacturing:${h.jobID}:completed`, type: "goods_manufactured", source: "manufacturing_crews", ownerID: s.ownerID, crewID: `manufacturing:${s.ownerID}`,
        stationID: s.stationID, occurredAtMs: h.completedAtMs, productTypeID: h.productTypeID, quantity: h.quantity }))) };
  }
  return { enabled, snapshot, submit, tick, universeFacts, catalog(id, stationID) { check(); if (!crew(id)?.crew) fail("CREW_NOT_FOUND", "Establish a crew first.", 404); return industry.catalog(id, stationID); },
    drain: () => Promise.allSettled([...lanes.values()]) };
}
module.exports = { TABLE, createManufacturingCrewService };
