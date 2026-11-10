"use strict";
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { CrewError } = require("./crewService");
const progression = require("./crewProgression");
const equipment = require("./crewEquipmentState");
const TABLE = "miningCrewRuntime", MAX_ROWS = 128, MAX_RECEIPTS = 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const positive = n => Number.isSafeInteger(n) && n > 0;
const fail = (code, message, status = 409) => { throw new CrewError(code, message, status); };
const exact = (object, keys) => object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).sort().join() === [...keys].sort().join();
function normalize(input) {
  if (!exact(input, ["commandID", "expectedRevision", "type", "payload"]) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(input.commandID) || typeof input.commandID !== "string" ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !["start", "pause", "resume", "stop", "prioritize"].includes(input.type)) fail("CREW_COMMAND_INVALID", "The mining order is invalid.", 400);
  const keys = input.type === "start" ? ["homeStationID", "beltID", "typeID", ...(Object.hasOwn(input.payload||{},"followProduction")?["followProduction"]:[])] : input.type === "prioritize" ? ["enabled"] : [];
  if (!exact(input.payload, keys) || (input.type === "start" && (!["homeStationID","beltID","typeID"].every(key=>positive(input.payload[key])) || (keys.includes("followProduction")&&typeof input.payload.followProduction!=="boolean"))) ||
      (input.type === "prioritize" && typeof input.payload.enabled !== "boolean")) fail("CREW_COMMAND_INVALID", "Choose a home station, belt, ore and a valid production-following option.", 400);
  const command = { commandID: input.commandID, expectedRevision: input.expectedRevision, type: input.type,
    payload: Object.fromEntries(keys.map(key => [key, input.payload[key]])) };
  return { ...command, fingerprint: hash(JSON.stringify(command)) };
}

// One independent mining team per pilot. All effects follow a durable intent.
function createMiningCrewService({ repo, resources, crew, planning, enabled = true, now = Date.now,
  travelMs = 30000, cycleMs = 60000, batchM3 = 100 }) {
  if (!repo || !resources || typeof crew !== "function" || ![travelMs, cycleMs].every(positive) ||
      !Number.isFinite(batchM3) || batchM3 <= 0 || batchM3 > 1000) throw new TypeError("Invalid mining crew dependencies or timing");
  let initialized = false, cursor = 0, planningCursor=0, preparing=null;
  const active = new Set(), prepared=new Map();
  function validate(state, id) {
    progression.validate(state?.progression);
    const invalid = () => fail("CREW_STATE_INVALID", "The saved mining crew needs recovery.", 503);
    if (!state || state.version !== 1 || state.ownerID !== id || !positive(id) || state.escrowLocationID !== 8_500_000_000_000_000 + id ||
        !positive(state.escrowLocationID) || !Number.isSafeInteger(state.revision) || state.revision < 0 || !positive(state.nextSerial) ||
        !positive(state.systemID) || typeof state.paused !== "boolean" ||
        !exact(state.roster?.[0], ["actorID", "name", "role"]) || state.roster.length !== 2 ||
        state.roster.some((p, index) => p.actorID !== `mining:${id}:member:${index}` || typeof p.name !== "string" || typeof p.role !== "string") ||
        !state.receipts || typeof state.receipts !== "object" || Array.isArray(state.receipts) || Object.keys(state.receipts).length > MAX_RECEIPTS ||
        !Array.isArray(state.history) || state.history.length > 20 ||
        ![state.totalMined, state.totalDelivered, state.completedDeliveries].every(n => Number.isSafeInteger(n) && n >= 0) ||
        state.totalDelivered > state.totalMined || !state.plan || typeof state.plan.enabled !== "boolean" ||
        ![state.plan.homeStationID, state.plan.beltID, state.plan.typeID].every(positive) || (state.plan.followProduction!==undefined&&typeof state.plan.followProduction!=="boolean") ||
        resources.station(state.plan.homeStationID)?.solarSystemID !== state.systemID || resources.belt(state.plan.beltID)?.solarSystemID !== state.systemID) invalid();
    if (state.job) {
      const j = state.job;
      if (!/^[a-f0-9]{64}$/.test(j.jobID) || !positive(j.serial) || j.serial >= state.nextSerial ||
          !["outbound", "working", "extracting", "returning", "unloading", "acknowledging"].includes(j.phase) ||
          !positive(j.travelMs) || !positive(j.cycleMs) || !Number.isFinite(j.batchM3) || j.batchM3 <= 0 || j.batchM3 > 1000 ||
          !Number.isSafeInteger(j.nextAtMs) || (j.pausedAtMs !== null && !Number.isSafeInteger(j.pausedAtMs)) ||
          (j.phase === "extracting" && (!positive(j.allocation?.resourceID) || !positive(j.allocation.quantity) ||
            j.allocation.state?.yieldKind !== "ore" || j.allocation.state.yieldTypeID !== state.plan.typeID ||
            j.allocation.state.entityID !== j.allocation.resourceID || j.allocation.state.beltID !== state.plan.beltID ||
            !positive(j.allocation.state.originalQuantity) || !positive(j.allocation.state.remainingQuantity) ||
            j.allocation.state.remainingQuantity > j.allocation.state.originalQuantity ||
            !Number.isFinite(j.allocation.state.unitVolume) || j.allocation.state.unitVolume <= 0 ||
            j.allocation.quantity * j.allocation.state.unitVolume > j.batchM3 + 1e-9 ||
            j.allocation.quantity > j.allocation.state.remainingQuantity || !Number.isSafeInteger(j.extractionAtMs))) ||
          (["unloading", "acknowledging"].includes(j.phase) && !j.cargo) ||
          (j.quantityLimit!==undefined&&!positive(j.quantityLimit)) || (j.cargo && (![j.cargo.itemID, j.cargo.typeID, j.cargo.quantity].every(positive) ||
            j.cargo.typeID !== state.plan.typeID || !Number.isFinite(j.cargo.volumeM3) || j.cargo.volumeM3 <= 0 || j.cargo.volumeM3 > j.batchM3 + 1e-9))) invalid();
    }
  }
  function check() {
    if (!enabled) fail("CREW_DISABLED", "Crew operations are disabled.", 503);
    if (!initialized) {
      repo.ensureTable(TABLE);
      const root = repo.read(TABLE, "/");
      if (!root.success || !root.data || Array.isArray(root.data)) fail("CREW_STORE_UNAVAILABLE", "Mining records could not be read.", 503);
      if (Object.keys(root.data).length > MAX_ROWS) fail("CREW_CAPACITY", "The mining registry is full.", 503);
      for (const [id, row] of Object.entries(root.data)) { validate(row, Number(id)); if (row.job || row.plan.enabled) active.add(Number(id)); }
      initialized = true;
    }
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Mining records are pending. Retry the same order.", 503);
  }
  function load(id) {
    if (!positive(id) || !positive(8_500_000_000_000_000 + id)) fail("CREW_OWNER_INVALID", "Select a valid pilot.", 400);
    const row = repo.read(TABLE, `/${id}`);
    if (!row.success) {
      if (row.errorMsg === "ENTRY_NOT_FOUND") return null;
      fail("CREW_STORE_UNAVAILABLE", "Mining records could not be read.", 503);
    }
    validate(row.data, id); const state = clone(row.data); progression.ensure(state, "mining"); return state;
  }
  function save(state) {
    progression.ensure(state, "mining");
    validate(state, state.ownerID); state.revision++;
    if (repo.write(TABLE, `/${state.ownerID}`, clone(state))?.success !== true) {
      fail("CREW_STORE_UNAVAILABLE", "Mining records are pending. Retry the same order.", 503);
    }
    if (state.job || state.plan.enabled) active.add(state.ownerID); else active.delete(state.ownerID);
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Mining records are pending. Retry the same order.", 503);
  }
  function progress(state, atMs) {
    if (!state) return;
    if (!state.job) {
      if (!state.plan.enabled || state.paused) return;
      if(state.plan.followProduction){
        if(atMs<(state.nextCheckAtMs||0))return;
        const result=prepared.get(state.ownerID);prepared.delete(state.ownerID);
        if(!result||result.revision!==state.revision){state.status="waiting_for_production_plan";state.nextCheckAtMs=atMs+1000;save(state);return;}
        const decision=result.decision;state.priority=decision.priority;
        if(!decision.choice){state.status=decision.status;state.nextCheckAtMs=atMs+10000;save(state);return;}
        state.plan.beltID=decision.choice.beltID;state.plan.typeID=decision.choice.typeID;state.plan.oreName=decision.choice.name;
        state.quantityLimit=decision.choice.quantity;
      }
      const serial = state.nextSerial++;
      const gear = equipment.forOwner(state.ownerID, "mining");
      const workMs = equipment.duration(progression.duration(cycleMs, state, "mining"), gear);
      state.job = { jobID: hash(`mining:${state.ownerID}:${serial}`), serial, phase: "outbound", cargo: null,
        nextAtMs: atMs + travelMs, pausedAtMs: null, travelMs, cycleMs: workMs, batchM3, skillAtStart: progression.profile(state, "mining"), equipmentAtStart: gear,
        ...(state.plan.followProduction?{quantityLimit:state.quantityLimit,priority:state.priority}: {}) };delete state.quantityLimit;
      state.status = "outbound"; save(state); return;
    }
    // A bounded pass advances one batch, never simulates an offline backlog.
    for (let step = 0; step < 6 && state.job; step++) {
      const job = state.job;
      if (["outbound", "working", "returning"].includes(job.phase)) {
        if (state.paused || atMs < job.nextAtMs) return;
        if (job.phase === "outbound") { job.phase = "working"; job.nextAtMs = atMs + job.cycleMs; }
        else if (job.phase === "working") {
          const allocation = resources.prepare(state);
          if (!allocation) {
            if(!state.plan.followProduction)state.plan.enabled = false; state.status = "depleted"; job.phase = "returning"; job.nextAtMs = atMs + job.travelMs;
          } else { job.allocation = allocation; job.extractionAtMs = atMs; job.phase = "extracting"; }
        } else if (!job.cargo) { state.job = null; if (state.status !== "depleted") state.status = "stopped"; save(state); return; }
        else job.phase = "unloading";
        if (state.status !== "depleted") state.status = job.phase;
        save(state);
      } else if (job.phase === "extracting") {
        const result = resources.extract(state);
        if (result.retry) { delete job.allocation; job.phase = "working"; job.nextAtMs = atMs + job.cycleMs; }
        else {
          job.cargo = result; state.totalMined += result.quantity; delete job.allocation;
          job.phase = "returning"; job.nextAtMs = atMs + job.travelMs;
        }
        state.status = job.phase; delete job.recoveryError; save(state);
        return;
      } else if (job.phase === "unloading") {
        resources.unload(state);
        const experienceGained = progression.award(state, "mining");
        state.totalDelivered += job.cargo.quantity; state.completedDeliveries++;
        state.history.unshift({ jobID: job.jobID, cargo: job.cargo, homeStationID: state.plan.homeStationID,
          beltID: state.plan.beltID, completedAtMs: atMs, priority:job.priority, experienceGained }); state.history = state.history.slice(0, 20);
        job.phase = "acknowledging"; state.status = "confirming_delivery"; delete job.recoveryError; save(state);
      } else {
        resources.acknowledge(job.jobID); state.job = null;
        state.status = state.plan.enabled ? state.paused ? "paused" : "ready" : "stopped"; save(state); return;
      }
    }
  }
  function snapshot(id) {
    if (!enabled) return { enabled: false, revision: 0, mining: null };
    check(); const state = load(id);
    return { enabled: true, planningEnabled:Boolean(planning), revision: state?.revision || 0, mining: state ? { ...state, receipts: undefined,
      homeStation: resources.station(state.plan.homeStationID), belt: resources.belt(state.plan.beltID), skill: progression.profile(state, "mining"), equipment: equipment.forOwner(id, "mining") } : null,
      commandCapacityRemaining: MAX_RECEIPTS - Object.keys(state?.receipts || {}).length,
      settings: { travelMs, cycleMs, batchM3 } };
  }
  function submit(id, input) {
    check(); const command = normalize(input), atMs = now(), receiptID = hash(command.commandID);
    let state = load(id);
    const prior = state?.receipts[receiptID];
    if (prior) {
      if (prior.fingerprint !== command.fingerprint) fail("CREW_COMMAND_REUSED", "This order ID already describes another order.");
      return { ...snapshot(id), replayed: true };
    }
    if ((state?.revision || 0) !== command.expectedRevision) fail("CREW_REVISION_CONFLICT", "Mining work changed. Refresh before issuing another order.");
    // Reserve the final receipt for stopping a standing mining order.
    if (Object.keys(state?.receipts || {}).length >= MAX_RECEIPTS - (command.type === "stop" ? 0 : 1)) fail("CREW_COMMAND_CAPACITY", "The mining order ledger is full.");
    if (command.type === "start") {
      if(command.payload.followProduction&&!planning)fail("CREW_DISABLED","Production resource planning is unavailable.",503);
      if (state?.job || state?.plan.enabled) fail("CREW_BUSY", "Stop the current mining assignment and let its crew return first.");
      const parent = crew(id)?.crew;
      if (!parent) fail("CREW_NOT_FOUND", "Establish your courier crew before assigning miners.", 404);
      const home = resources.station(command.payload.homeStationID), belt = resources.belt(command.payload.beltID);
      if (!home || !belt || belt.solarSystemID !== home.solarSystemID) fail("CREW_STATION_INVALID", "Choose a belt in the home station's system.", 400);
      const ore = resources.sites(home.stationID).find(s => s.beltID === belt.itemID)?.ores.find(o => o.typeID === command.payload.typeID);
      if (!ore || ore.remainingQuantity <= 0 || ore.unitVolume > batchM3) fail("CREW_CARGO_INVALID", "Choose available ore that fits the mining hold.", 400);
      if (!state) {
        if (Object.keys(repo.read(TABLE, "/").data).length >= MAX_ROWS) fail("CREW_CAPACITY", "The mining registry is full.", 503);
        state = { version: 1, ownerID: id, revision: 0, nextSerial: 1, escrowLocationID: 8_500_000_000_000_000 + id,
          employerCorporationID: parent.employerCorporationID || 0,
          roster: [{ actorID: `mining:${id}:member:0`, name: "Sera Holt", role: "Mining foreman" },
            { actorID: `mining:${id}:member:1`, name: "Oren Vale", role: "Ore tender" }], receipts: {}, history: [],
          totalMined: 0, totalDelivered: 0, completedDeliveries: 0, job: null };
      }
      state.plan = { ...command.payload, oreName: ore.name, enabled: true }; state.systemID = home.solarSystemID;
      state.paused = false; state.status = "ready";
    } else {
      if (!state || (!state.plan.enabled && command.type !== "stop")) fail("CREW_NOT_FOUND", "There is no active mining assignment.", 404);
      if(command.type==="prioritize"){
        if(command.payload.enabled&&!planning)fail("CREW_DISABLED","Production resource planning is unavailable.",503);
        state.plan.followProduction=command.payload.enabled;state.nextCheckAtMs=atMs;prepared.delete(id);
      } else if (command.type === "stop") {
        if (!state.plan.enabled) fail("CREW_AUTOMATION_NOT_FOUND", "The mining order is already stopped.");
        state.plan.enabled = false;
        if (state.job && ["outbound", "working"].includes(state.job.phase)) {
          state.job.phase = "returning"; state.job.nextAtMs = atMs + state.job.travelMs; state.job.pausedAtMs = null;
        }
        if (state.job?.pausedAtMs !== null && state.job?.pausedAtMs !== undefined) {
          state.job.nextAtMs += Math.max(0, atMs - state.job.pausedAtMs); state.job.pausedAtMs = null;
        }
        state.paused = false; state.status = state.job ? "finishing_current_trip" : "stopped";
      } else if (command.type === "pause") {
        if (state.paused) fail("CREW_ALREADY_PAUSED", "The miners are already paused.");
        state.paused = true; if (state.job) state.job.pausedAtMs = atMs;
      } else {
        if (!state.paused) fail("CREW_NOT_PAUSED", "The miners are not paused.");
        state.paused = false;
        if (state.job) { state.job.nextAtMs += Math.max(0, atMs - state.job.pausedAtMs); state.job.pausedAtMs = null; }
      }
    }
    state.receipts[receiptID] = { fingerprint: command.fingerprint, acceptedAtMs: atMs };
    save(state); progress(state, atMs); return { ...snapshot(id), replayed: false };
  }
  function tick({ limit = 8, budgetMs = 4 } = {}) {
    if (!enabled) return { processed: 0, errors: [] };
    check(); const ids = [...active], errors = [], started = performance.now(); let processed = 0;
    for (let index = 0; index < Math.min(ids.length, Math.max(1, Math.min(8, limit))); index++) {
      if (index && performance.now() - started >= budgetMs) break;
      const id = ids[(cursor + index) % ids.length];
      try { progress(load(id), now()); } catch (error) {
        errors.push({ ownerID: id, code: error.code || "CREW_RETRY_PENDING" });
        try { const state = load(id); if (state?.job && !state.job.recoveryError) {
          state.job.recoveryError = "Mining cargo is awaiting confirmation. The saved load will retry."; save(state);
        } } catch { /* retain durable intent */ }
      }
      processed++;
    }
    cursor = ids.length ? (cursor + processed) % ids.length : 0; return { processed, errors };
  }
  function universeFacts({ ownerID } = {}) {
    if (!enabled) return { actors: [], recentEvents: [] };
    check(); const rows = ownerID ? [load(ownerID)].filter(Boolean) : Object.values(repo.read(TABLE, "/").data);
    return { actors: rows.flatMap(state => state.roster.map(person => ({ ...person, ownerID: state.ownerID, crewID: `mining:${state.ownerID}`,
      kind: "crew_member", source: "mining_crews", crewName: "Mining crew",
      employerCorporationID: state.employerCorporationID, systemID: state.systemID,
      stationID: state.job && state.job.phase !== "acknowledging" ? null : state.plan.homeStationID,
      destinationStationID: state.plan.homeStationID, activity: state.job?.recoveryError ? "awaiting_confirmation" : state.paused ? "paused" :
        state.job?.phase === "working" || state.job?.phase === "extracting" ? "mining" : state.job?.phase || state.status,
      representation: "virtual", physicalEntityID: null, skill: progression.profile(state, "mining") }))),
      recentEvents: rows.flatMap(state => state.history.map(trip => ({ eventID: `mining:${trip.jobID}:delivered`,
        type: "ore_delivered", source: "mining_crews", ownerID: state.ownerID, crewID: `mining:${state.ownerID}`, occurredAtMs: trip.completedAtMs,
        stationID: trip.homeStationID, cargo: trip.cargo }))) };
  }
  function plan({budgetMs=4,limit=8}={}){
    if(!enabled||!planning)return Promise.resolve({processed:0,errors:[]});
    if(preparing)return preparing;
    const promise=(async()=>{
      check();const ids=[...active],started=performance.now(),errors=[];let processed=0,visited=0;
      for(;visited<ids.length&&processed<Math.min(8,limit);visited++){
        if(processed&&performance.now()-started>=budgetMs)break;
        const id=ids[(planningCursor+visited)%ids.length],state=load(id);
        if(state.job||state.paused||!state.plan.enabled||!state.plan.followProduction||now()<(state.nextCheckAtMs||0))continue;
        try{const decision=await planning.mining(state,batchM3);if(load(id).revision===state.revision)prepared.set(id,{revision:state.revision,decision});}
        catch(e){errors.push({ownerID:id,code:e.code||"CREW_RESOURCE_PLAN_PENDING"});}
        processed++;
      }
      planningCursor=ids.length?(planningCursor+visited)%ids.length:0;return{processed,errors};
    })();
    preparing=promise;void promise.finally(()=>{if(preparing===promise)preparing=null;}).catch(()=>{});return promise;
  }
  return Object.freeze({ enabled, snapshot, submit, tick, plan, drain:()=>preparing||Promise.resolve(), universeFacts, sites(id, homeStationID) {
    check(); if (!crew(id)?.crew) fail("CREW_NOT_FOUND", "Establish a crew first.", 404); return resources.sites(homeStationID);
  } });
}
module.exports = { TABLE, createMiningCrewService };
