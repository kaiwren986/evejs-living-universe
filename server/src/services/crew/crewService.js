"use strict";

const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { projectCrew } = require("../livingUniverse/crewActorProjection");
const progression = require("./crewProgression");
const equipment = require("./crewEquipmentState");
const TABLE = "crewRuntime";
const MAX_CREWS = 128;
const MAX_RECEIPTS = 1024;
const AUTOMATION_POLL_MS = 5000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(value).digest("hex");

class CrewError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new CrewError(code, message, status); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function normalizeCommand(input) {
  if (!exact(input, ["commandID", "expectedRevision", "type", "payload"]) ||
      typeof input.commandID !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.commandID) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    fail("CREW_COMMAND_INVALID", "The order is invalid.", 400);
  }
  let payload;
  switch (input.type) {
    case "create":
      if (!exact(input.payload, ["name"]) || typeof input.payload.name !== "string" ||
          !input.payload.name.trim() || input.payload.name.trim().length > 40 || /[\x00-\x1f]/u.test(input.payload.name)) {
        fail("CREW_COMMAND_INVALID", "Choose a crew name between 1 and 40 characters.", 400);
      }
      payload = { name: input.payload.name.trim() }; break;
    case "travel":
    case "deliver": {
      const keys = input.type === "deliver" ? ["destinationStationID", "itemID"] : ["destinationStationID"];
      if (!exact(input.payload, keys) || !keys.every((key) => positive(input.payload[key]))) {
        fail("CREW_COMMAND_INVALID", "Choose a station and, for delivery, one cargo stack.", 400);
      }
      payload = Object.fromEntries(keys.map((key) => [key, input.payload[key]])); break;
    }
    case "automate": {
      const keys = ["sourceStationID", "destinationStationID", "typeID", "sourceReserve", ...(input.payload && Object.hasOwn(input.payload, "typeIDs") ? ["typeIDs"] : []), ...(input.payload && Object.hasOwn(input.payload, "followProduction") ? ["followProduction"] : [])];
      if (!exact(input.payload, keys) || !keys.slice(0, 3).every((key) => positive(input.payload[key])) ||
          !Number.isSafeInteger(input.payload.sourceReserve) || input.payload.sourceReserve < 0 ||
          (keys.includes("followProduction") && typeof input.payload.followProduction !== "boolean") ||
          (keys.includes("typeIDs") && (!Array.isArray(input.payload.typeIDs) || !input.payload.typeIDs.length || input.payload.typeIDs.length > 8 ||
            !input.payload.typeIDs.every(positive) || new Set(input.payload.typeIDs).size !== input.payload.typeIDs.length || input.payload.typeIDs[0] !== input.payload.typeID))) {
        fail("CREW_COMMAND_INVALID", "Choose two stations, a cargo type and a nonnegative source reserve.", 400);
      }
      payload = Object.fromEntries(keys.map((key) => [key, input.payload[key]])); break;
    }
    case "prioritize":
      if (!exact(input.payload, ["enabled"]) || typeof input.payload.enabled !== "boolean") fail("CREW_COMMAND_INVALID", "Choose whether the supply route follows production.", 400);
      payload = { enabled: input.payload.enabled }; break;
    case "pause": case "resume": case "stop":
      if (!exact(input.payload, [])) fail("CREW_COMMAND_INVALID", "This order takes no options.", 400);
      payload = {}; break;
    default: fail("CREW_COMMAND_INVALID", "That crew order is not supported.", 400);
  }
  const command = { commandID: input.commandID, expectedRevision: input.expectedRevision, type: input.type, payload };
  return { ...command, fingerprint: hash(JSON.stringify(command)) };
}

// All dependencies are injected. Importing this module starts no timers or store.
function createCrewService({ repo, inventory, world, character, planning, enabled = true, now = Date.now, legMs = 30000 }) {
  if (!repo || !inventory || !world || typeof character !== "function" || !Number.isSafeInteger(legMs) || legMs < 1) {
    throw new TypeError("Crew service requires a repository, inventory, world, character provider and positive leg duration");
  }
  let initialized = false, cursor = 0;
  const active = new Set();
  const prepared = new Map();
  let preparing = null, planningCursor = 0;
  function check() {
    if (!enabled) fail("CREW_DISABLED", "Crew operations are disabled.", 503);
    if (!initialized) {
      repo.ensureTable(TABLE);
      const result = repo.read(TABLE, "/");
      if (!result.success) fail("CREW_STORE_UNAVAILABLE", "Crew records could not be read.", 503);
      const rows = Object.entries(result.data);
      if (rows.length > MAX_CREWS) fail("CREW_CAPACITY", "The crew registry exceeds its capacity.", 503);
      for (const [id, row] of rows) {
        validateState(row, Number(id));
        if (row.job || row.standingOrder?.enabled || row.pendingReceiptCleanup?.length) active.add(Number(id));
      }
      initialized = true;
    }
    // A previous uncertain write must be durable before a subsequent effect.
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Crew records are pending. Retry the same order.", 503);
  }
  function validateState(row, ownerID) {
    progression.validate(row?.progression);
    if (!row || row.version !== 1 || row.ownerID !== ownerID || !Number.isSafeInteger(row.revision) ||
        !row.receipts || typeof row.receipts !== "object" || Array.isArray(row.receipts) || Object.keys(row.receipts).length > MAX_RECEIPTS ||
        !Array.isArray(row.history) || row.history.length > 20 || !positive(row.stationID) || !positive(row.systemID) ||
        !positive(row.escrowLocationID) || row.escrowLocationID !== 8_600_000_000_000_000 + ownerID) {
      fail("CREW_STATE_INVALID", "Crew state needs recovery; no cargo was moved.", 503);
    }
    if (!Array.isArray(row.roster) || row.roster.length < 1 || row.roster.length > 16 || row.roster.some((person) =>
      !person || typeof person.name !== "string" || typeof person.role !== "string" ||
      (person.actorID !== undefined && (typeof person.actorID !== "string" || !person.actorID.startsWith(`crew:${ownerID}:member:`)))) ||
      new Set(row.roster.map((person, index) => person.actorID || `crew:${ownerID}:member:${index}`)).size !== row.roster.length) {
      fail("CREW_STATE_INVALID", "Crew member identities need recovery.", 503);
    }
    if (row.job && (!Array.isArray(row.job.route) || row.job.route.length < 1 || row.job.route.length > 33 ||
        !row.job.route.every(positive) || !Number.isSafeInteger(row.job.legIndex) || row.job.legIndex < 0 ||
        row.job.legIndex >= row.job.route.length || !["reserving", "travelling", "delivering"].includes(row.job.phase) ||
        !positive(row.job.legMs) || !Number.isSafeInteger(row.job.nextAtMs) ||
        row.systemID !== row.job.route[row.job.legIndex] || !/^[a-f0-9]{64}$/.test(row.job.jobID) ||
        !positive(row.job.sourceStationID) || !positive(row.job.destinationStationID) ||
        (row.job.pausedAtMs !== null && !Number.isSafeInteger(row.job.pausedAtMs)) ||
        (row.job.type === "deliver" && (!row.job.cargo || !positive(row.job.cargo.itemID) || !positive(row.job.cargo.quantity) || !positive(row.job.cargo.typeID))))) {
      fail("CREW_STATE_INVALID", "The saved crew route needs recovery.", 503);
    }
    if (row.job) {
      const job = row.job;
      if (job.cargo && ((job.cargo.sourceQuantity !== undefined && (!positive(job.cargo.sourceQuantity) || job.cargo.sourceQuantity < job.cargo.quantity)) ||
          (job.cargo.custodyItemID !== undefined && !positive(job.cargo.custodyItemID)))) fail("CREW_STATE_INVALID", "The saved partial cargo needs recovery.", 503);
      if (!["travel", "deliver"].includes(job.type) || !Number.isSafeInteger(job.startedAtMs) || job.nextAtMs < job.startedAtMs ||
          row.stationID !== job.sourceStationID || world.station(job.sourceStationID)?.solarSystemID !== job.route[0] ||
          world.station(job.destinationStationID)?.solarSystemID !== job.route[job.route.length - 1] ||
          (job.phase === "reserving" && (job.type !== "deliver" || job.legIndex !== 0)) ||
          (job.phase === "delivering" && job.legIndex !== job.route.length - 1) ||
          (job.pausedAtMs !== null && job.phase !== "travelling")) {
        fail("CREW_STATE_INVALID", "The saved crew custody or route needs recovery.", 503);
      }
    }
    if (row.standingOrder) {
      const order = row.standingOrder;
      if (order.followProduction !== undefined && typeof order.followProduction !== "boolean") fail("CREW_STATE_INVALID", "The supply policy needs recovery.", 503);
      if (!/^[a-f0-9]{64}$/.test(order.orderID) || typeof order.enabled !== "boolean" || typeof order.paused !== "boolean" ||
          !positive(order.sourceStationID) || !positive(order.destinationStationID) || order.sourceStationID === order.destinationStationID ||
          !positive(order.typeID) || !Number.isSafeInteger(order.sourceReserve) || order.sourceReserve < 0 ||
          !positive(order.nextJobSerial) || !Number.isSafeInteger(order.completedDeliveries) || order.completedDeliveries < 0 ||
          !Number.isSafeInteger(order.nextCheckAtMs)) fail("CREW_STATE_INVALID", "The saved standing order needs recovery.", 503);
      if (order.typeIDs && (!Array.isArray(order.typeIDs) || !order.typeIDs.length || order.typeIDs.length > 8 || !order.typeIDs.every(positive) ||
          new Set(order.typeIDs).size !== order.typeIDs.length || order.typeIDs[0] !== order.typeID ||
          !Number.isSafeInteger(order.typeCursor || 0) || (order.typeCursor || 0) < 0 || (order.typeCursor || 0) >= order.typeIDs.length)) fail("CREW_STATE_INVALID", "The mixed supply route needs recovery.", 503);
    }
    if (row.pendingReceiptCleanup && (!Array.isArray(row.pendingReceiptCleanup) || row.pendingReceiptCleanup.length > 1 ||
        !row.pendingReceiptCleanup.every((id) => /^[a-f0-9]{64}$/.test(id)))) {
      fail("CREW_STATE_INVALID", "Crew inventory acknowledgements need recovery.", 503);
    }
  }
  function load(ownerID) {
    if (!positive(ownerID) || !positive(8_600_000_000_000_000 + ownerID)) fail("CREW_OWNER_INVALID", "Select a valid character.", 400);
    const result = repo.read(TABLE, `/${ownerID}`);
    if (!result.success) {
      if (result.errorMsg === "ENTRY_NOT_FOUND") return null;
      fail("CREW_STORE_UNAVAILABLE", "Crew records could not be read.", 503);
    }
    validateState(result.data, ownerID);
    const state = clone(result.data); progression.ensure(state, "hauling"); return state;
  }
  function save(state) {
    progression.ensure(state, "hauling");
    state.roster = state.roster.map((person, index) => ({ ...person, actorID: person.actorID || `crew:${state.ownerID}:member:${index}` }));
    validateState(state, state.ownerID);
    state.revision += 1;
    if (repo.write(TABLE, `/${state.ownerID}`, clone(state))?.success !== true) {
      fail("CREW_STORE_UNAVAILABLE", "Crew records are pending. Retry the same order.", 503);
    }
    if (state.job || state.standingOrder?.enabled || state.pendingReceiptCleanup?.length) active.add(state.ownerID); else active.delete(state.ownerID);
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Crew records are pending. Retry the same order.", 503);
  }
  function advance(state, atMs) {
    const job = state.job;
    if (!job || job.pausedAtMs !== null) return;
    if (job.phase === "reserving") {
      inventory.move(state, job, "reserve");
      job.phase = "travelling";
      // Travel begins only after custody is confirmed, including on recovery.
      job.startedAtMs = atMs;
      job.nextAtMs = atMs + job.legMs;
      delete job.recoveryError;
      save(state);
    }
    // Routes include a station departure/arrival interval even within one system.
    let transitions = 0;
    while (job.phase === "travelling" && job.nextAtMs <= atMs && transitions++ < 8) {
      if (job.legIndex < job.route.length - 1) {
        job.legIndex += 1;
        state.systemID = job.route[job.legIndex];
        job.nextAtMs += job.legMs;
      } else {
        job.phase = "delivering";
      }
      save(state);
    }
    if (job.phase === "delivering") {
      if (job.cargo) inventory.move(state, job, "deliver");
      const experienceGained = job.cargo ? progression.award(state, "hauling") : 0;
      state.stationID = job.destinationStationID;
      state.systemID = job.route[job.route.length - 1];
      state.history.unshift({ jobID: job.jobID, type: job.type, sourceStationID: job.sourceStationID,
        destinationStationID: job.destinationStationID, cargo: job.cargo, completedAtMs: job.nextAtMs,
        automaticOrderID: job.automaticOrderID || null, experienceGained, ...(job.priority ? { priority: clone(job.priority) } : {}) });
      state.history = state.history.slice(0, 20);
      if (job.cargo) state.pendingReceiptCleanup = [job.jobID];
      if (job.cargo && state.standingOrder?.orderID === job.automaticOrderID) state.standingOrder.completedDeliveries += 1;
      state.job = null;
      if (state.standingOrder && !state.standingOrder.enabled) state.standingOrder.status = "stopped";
      save(state);
    }
  }
  function drainCleanup(state) {
    if (!state.pendingReceiptCleanup?.length) return;
    inventory.acknowledge(state.pendingReceiptCleanup[0]);
    state.pendingReceiptCleanup = [];
    save(state);
  }
  function buildJob(state, type, destinationStationID, cargo, jobID, atMs, automaticOrderID = null) {
    const destination = world.station(destinationStationID);
    if (!destination) fail("CREW_STATION_INVALID", "Choose a known NPC station.", 400);
    if (destination.stationID === state.stationID) fail("CREW_SAME_STATION", "The crew is already at that station.");
    const route = world.route(state.systemID, destination.solarSystemID);
    if (!Array.isArray(route) || route.length < 1 || route.length > 33 || !route.every(positive) ||
        route[0] !== state.systemID || route[route.length - 1] !== destination.solarSystemID) {
      fail("CREW_ROUTE_UNAVAILABLE", "No route within 32 jumps connects these stations.");
    }
    const gear = equipment.forOwner(state.ownerID, "hauling");
    const tripLegMs = equipment.duration(progression.duration(legMs, state, "hauling"), gear);
    return { jobID, type, automaticOrderID, sourceStationID: state.stationID, destinationStationID: destination.stationID,
      route: [...route], legIndex: 0, phase: cargo ? "reserving" : "travelling", cargo,
      pausedAtMs: null, startedAtMs: atMs, legMs: tripLegMs, nextAtMs: atMs + tripLegMs, skillAtStart: progression.profile(state, "hauling"), equipmentAtStart: gear };
  }
  function runStandingOrder(state, atMs) {
    const order = state.standingOrder;
    if (!order?.enabled || order.paused || state.job || order.nextCheckAtMs > atMs) return;
    let type, destination, cargo = null;
    let decision = null;
    if (order.followProduction) {
      const cached = prepared.get(state.ownerID); prepared.delete(state.ownerID);
      if (!cached || cached.revision !== state.revision) {
        order.status = "waiting_for_production_plan"; order.nextCheckAtMs = atMs + 1000; save(state); return;
      }
      decision = planning?.recheckCourier ? planning.recheckCourier(state, cached.decision) : cached.decision;
      order.priority = decision.priority;
      if (!decision.choice) { order.status = decision.status; order.nextCheckAtMs = atMs + AUTOMATION_POLL_MS; save(state); return; }
    }
    if (state.stationID !== order.sourceStationID) {
      type = "travel"; destination = order.sourceStationID;
    } else {
      const types = decision ? [decision.choice.typeID] : order.typeIDs || [order.typeID];
      for (let offset = 0; offset < types.length; offset++) {
        const index = (decision ? offset : (order.typeCursor || 0) + offset) % types.length;
        cargo = inventory.selectSupply(state.ownerID, order.sourceStationID, types[index], order.sourceReserve, state.capacityM3 * equipment.forOwner(state.ownerID, "hauling").capacityMultiplier, decision?.choice.quantity);
        if (cargo) { if (order.typeIDs) order.typeCursor = (order.typeIDs.indexOf(types[index]) + 1) % order.typeIDs.length; break; }
      }
      if (!cargo) {
        order.status = "waiting_for_stock"; order.nextCheckAtMs = atMs + AUTOMATION_POLL_MS; save(state); return;
      }
      type = "deliver"; destination = order.destinationStationID;
    }
    const jobID = hash(`${order.orderID}:${order.nextJobSerial}`);
    const job = buildJob(state, type, destination, cargo, jobID, atMs, order.orderID);
    if (decision) job.priority = clone(decision.priority);
    order.nextJobSerial += 1;
    order.status = cargo ? "hauling" : "returning";
    order.nextCheckAtMs = atMs;
    state.job = job;
    save(state);
    advance(state, atMs);
  }
  function progress(state, atMs) {
    drainCleanup(state);
    advance(state, atMs);
    drainCleanup(state);
    runStandingOrder(state, atMs);
  }
  function snapshot(ownerID) {
    if (!enabled) return { enabled: false, planningEnabled: false, serverNowMs: now(), crew: null, cargo: [], history: [] };
    check();
    const state = load(ownerID);
    if (!state) return { enabled: true, planningEnabled: Boolean(planning), revision: 0, serverNowMs: now(), crew: null, cargo: [], history: [] };
    const { receipts, escrowLocationID, version, pendingReceiptCleanup, ...publicState } = state;
    if (publicState.standingOrder) publicState.standingOrder = { ...publicState.standingOrder,
      sourceStation: world.station(publicState.standingOrder.sourceStationID), destinationStation: world.station(publicState.standingOrder.destinationStationID) };
    if (publicState.job) publicState.job = { ...publicState.job,
      sourceStation: world.station(publicState.job.sourceStationID), destinationStation: world.station(publicState.job.destinationStationID),
      routeSystems: publicState.job.route.map((id) => world.system(id)) };
    return { enabled: true, planningEnabled: Boolean(planning), serverNowMs: now(), revision: state.revision,
      crew: { ...publicState, confirmationPending: Boolean(state.pendingReceiptCleanup?.length),
        station: world.station(state.stationID), system: world.system(state.systemID), skill: progression.profile(state, "hauling"), equipment: equipment.forOwner(ownerID, "hauling"), capacityM3: state.capacityM3 * equipment.forOwner(ownerID, "hauling").capacityMultiplier },
      cargo: state.job ? [] : inventory.list(ownerID, state.stationID),
      history: state.history.map((trip) => ({ ...trip, destinationStation: world.station(trip.destinationStationID) })),
      commandCapacityRemaining: MAX_RECEIPTS - Object.keys(receipts).length };
  }
  function submit(ownerID, rawCommand) {
    check();
    const command = normalizeCommand(rawCommand);
    let state = load(ownerID);
    const receiptID = hash(command.commandID);
    const existing = state?.receipts[receiptID];
    if (existing) {
      if (existing.fingerprint !== command.fingerprint) fail("CREW_COMMAND_REUSED", "This order ID was already used for a different order.");
      progress(state, now());
      return { replayed: true, ...snapshot(ownerID) };
    }
    if (command.expectedRevision !== (state?.revision || 0)) fail("CREW_REVISION_CONFLICT", "Crew state changed. Refresh before issuing this order.");
    if (state && Object.keys(state.receipts).length >= MAX_RECEIPTS) fail("CREW_RECEIPT_CAPACITY", "The crew order journal is full. Existing jobs can still finish.");
    if (state && (command.type === "automate" || (state.standingOrder?.enabled && command.type !== "stop")) &&
        Object.keys(state.receipts).length >= MAX_RECEIPTS - 1) {
      fail("CREW_RECEIPT_CAPACITY", "The order journal is nearly full. One slot is reserved to stop automation.");
    }
    if (state && command.type === "pause" && Object.keys(state.receipts).length >= MAX_RECEIPTS - 1) {
      fail("CREW_RECEIPT_CAPACITY", "The crew order journal is nearly full. Let the current journey finish.");
    }
    const atMs = now();
    if (command.type === "create") {
      if (state) fail("CREW_ALREADY_EXISTS", "This character already has a founding crew.");
      if (Object.keys(repo.read(TABLE, "/").data).length >= MAX_CREWS) fail("CREW_CAPACITY", "The crew registry is full.");
      const pilot = character(ownerID);
      const stationID = Number(pilot?.stationID ?? pilot?.stationid);
      const station = world.station(stationID);
      if (!station) fail("CREW_DOCK_REQUIRED", "Dock at an NPC station to establish your crew.");
      state = { version: 1, ownerID, revision: 0, name: command.payload.name, stationID,
        systemID: station.solarSystemID, escrowLocationID: 8_600_000_000_000_000 + ownerID,
        capacityM3: 1000, employerCorporationID: Number(pilot?.corporationID || pilot?.corporationId || 0) || null,
        roster: [{ name: "Mara Venn", role: "Navigator" }, { name: "Ilan Roe", role: "Cargo specialist" }],
        createdAtMs: atMs, receipts: {}, history: [], job: null };
    } else {
      if (!state) fail("CREW_NOT_FOUND", "Establish a crew first.", 404);
      if (!["stop", "pause"].includes(command.type)) drainCleanup(state);
      if (command.type === "prioritize") {
        if (!state.standingOrder?.enabled) fail("CREW_AUTOMATION_NOT_FOUND", "This crew has no active standing order.");
        if (command.payload.enabled && !planning) fail("CREW_DISABLED", "Production supply planning is unavailable.", 503);
        state.standingOrder.followProduction = command.payload.enabled;
        state.standingOrder.nextCheckAtMs = atMs; prepared.delete(ownerID);
      } else if (command.type === "pause" || command.type === "resume") {
        advance(state, atMs);
        if (command.type !== "pause" || !state.standingOrder?.enabled) drainCleanup(state);
        const automatic = state.standingOrder?.enabled;
        if (!automatic && (!state.job || state.job.phase !== "travelling")) fail("CREW_NOT_TRAVELLING", "There is no travelling crew to control.");
        const paused = automatic ? state.standingOrder.paused : state.job.pausedAtMs !== null;
        if (command.type === "pause") {
          if (paused) fail("CREW_ALREADY_PAUSED", "The crew is already paused.");
          if (state.job) state.job.pausedAtMs = atMs;
          if (automatic) { state.standingOrder.paused = true; state.standingOrder.status = "paused"; }
        } else {
          if (!paused) fail("CREW_NOT_PAUSED", "The crew is not paused.");
          if (state.job) { state.job.nextAtMs += Math.max(0, atMs - state.job.pausedAtMs); state.job.pausedAtMs = null; }
          if (automatic) { state.standingOrder.paused = false; state.standingOrder.status = "scheduled"; state.standingOrder.nextCheckAtMs = atMs; }
        }
      } else if (command.type === "stop") {
        if (!state.standingOrder?.enabled) fail("CREW_AUTOMATION_NOT_FOUND", "This crew has no active standing order.");
        state.standingOrder.enabled = false; state.standingOrder.paused = false;
        state.standingOrder.status = state.job ? "finishing_current_trip" : "stopped";
        if (state.job && state.job.pausedAtMs !== null) {
          state.job.nextAtMs += Math.max(0, atMs - state.job.pausedAtMs); state.job.pausedAtMs = null;
        }
      } else {
        if (state.job) fail("CREW_BUSY", "Finish the current journey before assigning another.");
        if (state.standingOrder?.enabled) fail("CREW_AUTOMATION_ACTIVE", "Stop the standing order before assigning another task.");
        if (command.type === "automate") {
          if (command.payload.followProduction && !planning) fail("CREW_DISABLED", "Production supply planning is unavailable.", 503);
          const source = world.station(command.payload.sourceStationID);
          const destination = world.station(command.payload.destinationStationID);
          if (!source || !destination) fail("CREW_STATION_INVALID", "Choose known NPC stations.", 400);
          if (source.stationID === destination.stationID) fail("CREW_SAME_STATION", "Choose different source and destination stations.");
          // Validate both the pickup and outbound routes before persisting policy.
          if (state.stationID !== source.stationID) buildJob(state, "travel", source.stationID, null, hash("validate"), atMs);
          buildJob({ ...state, stationID: source.stationID, systemID: source.solarSystemID }, "travel", destination.stationID, null, hash("validate"), atMs);
          state.standingOrder = { ...command.payload, orderID: hash(`${ownerID}:${command.commandID}:standing`),
            enabled: true, paused: false, status: "scheduled", nextJobSerial: 1, completedDeliveries: 0, nextCheckAtMs: atMs };
        } else {
          const cargo = command.type === "deliver" ? inventory.inspect(ownerID, state.stationID, command.payload.itemID, state.capacityM3 * equipment.forOwner(ownerID, "hauling").capacityMultiplier) : null;
          state.job = buildJob(state, command.type, command.payload.destinationStationID, cargo, hash(`${ownerID}:${command.commandID}`), atMs);
        }
      }
    }
    // Intent + receipt share one row and one durable fence before inventory effects.
    state.receipts[receiptID] = { fingerprint: command.fingerprint, acceptedAtMs: atMs, type: command.type };
    save(state);
    progress(state, atMs);
    return { replayed: false, ...snapshot(ownerID) };
  }
  function tick({ limit = 8, budgetMs = 4 } = {}) {
    if (!enabled) return { processed: 0, errors: [] };
    check();
    const ids = [...active];
    const errors = [];
    const started = performance.now();
    let processed = 0;
    for (let index = 0; index < Math.min(ids.length, Math.max(1, Math.min(8, limit))); index++) {
      if (index && performance.now() - started >= budgetMs) break;
      const ownerID = ids[(cursor + index) % ids.length];
      try { progress(load(ownerID), now()); } catch (error) {
        const code = error.code || "CREW_RETRY_PENDING";
        errors.push({ ownerID, code });
        try {
          const state = load(ownerID);
          if (state?.job && state.job.recoveryError?.code !== code) {
            state.job.recoveryError = { code,
              message: error instanceof CrewError ? error.message : "The crew is waiting for cargo confirmation." };
            save(state);
          }
        } catch { /* retain the original durable intent for the next pass */ }
      }
      processed += 1;
    }
    cursor = ids.length ? (cursor + processed) % ids.length : 0;
    return { processed, errors };
  }
  function universeFacts({ ownerID } = {}) {
    if (!enabled) return { actors: [], recentEvents: [] };
    check();
    const states = ownerID ? [load(ownerID)].filter(Boolean) : Object.values(repo.read(TABLE, "/").data).map(clone);
    const facts = states.map(projectCrew);
    return { actors: facts.flatMap((fact) => fact.actors), recentEvents: facts.flatMap((fact) => fact.recentEvents) };
  }
  function plan({ budgetMs = 4, limit = 8 } = {}) {
    if (!enabled || !planning) return Promise.resolve({ processed: 0, errors: [] });
    if (preparing) return preparing;
    const promise = (async () => {
      check(); const ids = [...active], started = performance.now(), errors = []; let processed = 0, visited = 0;
      for (; visited < ids.length && processed < Math.max(1, Math.min(8, limit)); visited++) {
        if (processed && performance.now() - started >= budgetMs) break;
        const id = ids[(planningCursor + visited) % ids.length], state = load(id), order = state.standingOrder;
        if (state.job || state.pendingReceiptCleanup?.length || !order?.enabled || order.paused || !order.followProduction || now() < order.nextCheckAtMs) continue;
        try {
          const decision = await planning.courier(state, state.capacityM3 * equipment.forOwner(id, "hauling").capacityMultiplier);
          if (load(id).revision === state.revision) prepared.set(id, { revision: state.revision, decision });
        } catch (error) { errors.push({ ownerID: id, code: error.code || "CREW_RESOURCE_PLAN_PENDING" }); }
        processed++;
      }
      planningCursor = ids.length ? (planningCursor + visited) % ids.length : 0;
      return { processed, errors };
    })();
    preparing = promise; void promise.finally(() => { if (preparing === promise) preparing = null; }).catch(() => {}); return promise;
  }
  return Object.freeze({ snapshot, submit, tick, plan, drain: () => preparing || Promise.resolve(), universeFacts, searchStations: (query) => world.searchStations(query), enabled });
}

module.exports = { TABLE, CrewError, createCrewService, normalizeCommand };
