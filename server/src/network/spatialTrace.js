"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { extractEntityIDsFromPayload } = require("./syncLedger");

const TRACE_SCHEMA = "evejs.spatial-flight-recorder";
const TRACE_SCHEMA_VERSION = 1;
function parseFilter(value) {
  if (value instanceof Set) {
    return new Set([...value].map((entry) => String(entry).trim()).filter(Boolean));
  }
  if (Array.isArray(value)) {
    return new Set(value.map((entry) => String(entry).trim()).filter(Boolean));
  }
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function buildConfiguration(options = {}) {
  const requested = options.enabled === true;
  const outputPath = String(options.outputPath || "").trim();
  const scenarioId = String(options.scenarioId || "unlabeled").trim() || "unlabeled";
  const configurationError = requested && !outputPath
    ? "EVEJS_SPATIAL_TRACE_PATH is required when spatial tracing is enabled"
    : null;
  return {
    requested,
    enabled: requested && !configurationError,
    outputPath: outputPath ? path.resolve(outputPath) : null,
    scenarioId,
    scenarioFilters: parseFilter(options.scenarioFilters),
    systemFilters: parseFilter(options.systemFilters),
    sessionFilters: parseFilter(options.sessionFilters),
    entityFilters: parseFilter(options.entityFilters),
    configurationError,
  };
}

function configurationFromEnvironment() {
  return buildConfiguration({
    enabled: process.env.EVEJS_SPATIAL_TRACE === "1",
    outputPath: process.env.EVEJS_SPATIAL_TRACE_PATH,
    scenarioId: process.env.EVEJS_SPATIAL_TRACE_SCENARIO,
    scenarioFilters: process.env.EVEJS_SPATIAL_TRACE_SCENARIO_FILTER,
    systemFilters: process.env.EVEJS_SPATIAL_TRACE_SYSTEM_IDS,
    sessionFilters: process.env.EVEJS_SPATIAL_TRACE_SESSION_IDS,
    entityFilters: process.env.EVEJS_SPATIAL_TRACE_ENTITY_IDS,
  });
}

function createRuntimeState(configuration) {
  return {
    configuration,
    started: false,
    failed: false,
    failureCount: 0,
    lastError: null,
    outputFd: null,
    eventSequence: 0,
    nextGroupSequence: 1,
    nextActionSequence: 1,
    nextNotificationSequence: 1,
    nextPacketSequence: 1,
    nextDestructionSequence: 1,
    runId: typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex"),
    relatedEntityIds: new Set(configuration.entityFilters),
    destructionBySourceEntityId: new Map(),
    destructionByReplacementEntityId: new Map(),
    lastSnapshotByEntityId: new Map(),
  };
}

let runtimeState = createRuntimeState(configurationFromEnvironment());
let notificationContextByPayload = new WeakMap();
let updateTraceContextByUpdate = new WeakMap();

function isEnabled() {
  return runtimeState.configuration.enabled === true && runtimeState.failed !== true;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function encodeLosslessValue(value, seen = new WeakMap(), valuePath = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return { $type: "Number", value: "NaN" };
    }
    if (value === Infinity) {
      return { $type: "Number", value: "Infinity" };
    }
    if (value === -Infinity) {
      return { $type: "Number", value: "-Infinity" };
    }
    if (Object.is(value, -0)) {
      return { $type: "Number", value: "-0" };
    }
    return value;
  }
  if (typeof value === "bigint") {
    return { $type: "BigInt", value: value.toString(10) };
  }
  if (value === undefined) {
    return { $type: "Undefined" };
  }
  if (typeof value === "symbol") {
    return { $type: "Symbol", value: String(value.description || "") };
  }
  if (typeof value === "function") {
    return { $type: "Function", name: String(value.name || "") };
  }
  if (Buffer.isBuffer(value)) {
    return {
      $type: "Buffer",
      encoding: "base64",
      byteLength: value.length,
      sha256: sha256(value),
      data: value.toString("base64"),
    };
  }
  if (value instanceof Date) {
    return { $type: "Date", value: value.toISOString() };
  }
  if (typeof value !== "object") {
    return { $type: "Unknown", value: String(value) };
  }
  if (seen.has(value)) {
    return { $type: "Reference", path: seen.get(value) };
  }
  seen.set(value, valuePath);
  if (Array.isArray(value)) {
    return value.map((entry, index) => (
      encodeLosslessValue(entry, seen, `${valuePath}[${index}]`)
    ));
  }
  if (value instanceof Map) {
    return {
      $type: "Map",
      entries: [...value.entries()].map(([key, entry], index) => [
        encodeLosslessValue(key, seen, `${valuePath}.entries[${index}][0]`),
        encodeLosslessValue(entry, seen, `${valuePath}.entries[${index}][1]`),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      $type: "Set",
      values: [...value].map((entry, index) => (
        encodeLosslessValue(entry, seen, `${valuePath}.values[${index}]`)
      )),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const view = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return {
      $type: value.constructor && value.constructor.name
        ? value.constructor.name
        : "ArrayBufferView",
      encoding: "base64",
      byteLength: view.length,
      sha256: sha256(view),
      data: view.toString("base64"),
    };
  }
  const normalized = {};
  for (const key of Object.keys(value)) {
    normalized[key] = encodeLosslessValue(
      value[key],
      seen,
      `${valuePath}.${key}`,
    );
  }
  return normalized;
}

function appendRecord(record) {
  if (!isEnabled()) {
    return null;
  }
  try {
    const candidateSequence = runtimeState.eventSequence + 1;
    const encoded = encodeLosslessValue({
      ...record,
      eventSequence: candidateSequence,
    });
    if (runtimeState.outputFd === null) {
      runtimeState.outputFd = fs.openSync(
        runtimeState.configuration.outputPath,
        "a",
      );
    }
    const line = Buffer.from(`${JSON.stringify(encoded)}\n`, "utf8");
    let offset = 0;
    while (offset < line.length) {
      const written = fs.writeSync(
        runtimeState.outputFd,
        line,
        offset,
        line.length - offset,
        null,
      );
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("spatial trace append made no forward progress");
      }
      offset += written;
    }
    runtimeState.eventSequence = candidateSequence;
    return encoded;
  } catch (error) {
    markFailed(error);
    return null;
  }
}

function markFailed(error) {
  if (runtimeState.outputFd !== null) {
    try {
      fs.closeSync(runtimeState.outputFd);
    } catch (_closeError) {
      // ignored: the original trace failure remains authoritative and must stay fail-open.
    }
    runtimeState.outputFd = null;
  }
  runtimeState.failed = true;
  runtimeState.failureCount += 1;
  runtimeState.lastError = error && error.message
    ? String(error.message)
    : String(error);
}

function failOpen(fn, fallback) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      markFailed(error);
      return fallback;
    }
  };
}

function getSessionId(session) {
  const value = session && session.clientID;
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? String(Math.trunc(Number(value)))
    : null;
}

function getShipId(session) {
  const value = session && session._space && session._space.shipID !== undefined
    ? session._space.shipID
    : session && session.shipID;
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.trunc(Number(value))
    : null;
}

function getSystemId(scene, session) {
  const value = scene && scene.systemID !== undefined
    ? scene.systemID
    : session && session._space && session._space.systemID !== undefined
      ? session._space.systemID
      : session && (session.solarsystemid2 || session.solarsystemid);
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.trunc(Number(value))
    : null;
}

function uniqueEntityIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )];
}

function extractTraceEntityIds(payload) {
  const entityIds = extractEntityIDsFromPayload(payload);
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) {
    return uniqueEntityIds(entityIds);
  }
  const name = payload[0];
  const args = payload[1];
  if (name === "OnSpecialFX") {
    entityIds.push(args[0], args[3]);
  } else if (name === "FollowBall" || name === "Orbit") {
    entityIds.push(args[0], args[1]);
  } else if (name === "LaunchMissile") {
    entityIds.push(args[0], args[1]);
  }
  return uniqueEntityIds(entityIds);
}

function matchesFilters({
  scene = null,
  session = null,
  entityIds = [],
  entityScoped = false,
  global = false,
} = {}) {
  if (!isEnabled()) {
    return false;
  }
  const configuration = runtimeState.configuration;
  if (
    configuration.scenarioFilters.size > 0 &&
    !configuration.scenarioFilters.has(configuration.scenarioId)
  ) {
    return false;
  }
  if (global) {
    return true;
  }
  const systemId = getSystemId(scene, session);
  if (
    configuration.systemFilters.size > 0 &&
    (systemId === null || !configuration.systemFilters.has(String(systemId)))
  ) {
    return false;
  }
  const sessionId = getSessionId(session);
  if (
    session &&
    configuration.sessionFilters.size > 0 &&
    (sessionId === null || !configuration.sessionFilters.has(sessionId))
  ) {
    return false;
  }
  if (entityScoped && configuration.entityFilters.size > 0) {
    const candidates = uniqueEntityIds(entityIds);
    if (!candidates.some((entityId) => (
      runtimeState.relatedEntityIds.has(String(entityId))
    ))) {
      return false;
    }
  }
  return true;
}

function resolveClock(scene, options = {}) {
  let simulationTimeMs = options.simulationTimeMs;
  if (simulationTimeMs === undefined && scene && typeof scene.getCurrentSimTimeMs === "function") {
    simulationTimeMs = scene.getCurrentSimTimeMs();
  }
  if (simulationTimeMs === null || !Number.isFinite(Number(simulationTimeMs))) {
    simulationTimeMs = null;
  } else {
    simulationTimeMs = Number(simulationTimeMs);
  }

  let destinyStamp = options.destinyStamp;
  if (
    destinyStamp === undefined &&
    simulationTimeMs !== null &&
    scene &&
    typeof scene.nextDestinyStamp === "number"
  ) {
    destinyStamp = scene.nextDestinyStamp;
  }
  if (destinyStamp === null || !Number.isFinite(Number(destinyStamp))) {
    destinyStamp = null;
  } else {
    destinyStamp = Math.trunc(Number(destinyStamp)) >>> 0;
  }

  const tickValue = options.simulationTick !== undefined
    ? options.simulationTick
    : scene && scene._activeTickSequence;
  const simulationTick = tickValue !== null &&
    Number.isSafeInteger(Number(tickValue)) && Number(tickValue) >= 0
    ? Math.trunc(Number(tickValue))
    : null;
  return { simulationTick, simulationTimeMs, destinyStamp };
}

function observerSnapshot(session) {
  if (!session) {
    return null;
  }
  const sessionId = getSessionId(session);
  return {
    traceId: sessionId ? `session:${sessionId}` : null,
    clientId: sessionId === null ? null : Number(sessionId),
    shipId: getShipId(session),
  };
}

function emitEvent(event, {
  scene = null,
  session = null,
  entityIds = [],
  entityScoped = false,
  clock = {},
  correlation = {},
  data = {},
  global = false,
} = {}) {
  if (!matchesFilters({ scene, session, entityIds, entityScoped, global })) {
    return null;
  }
  if (!runtimeState.started && event !== "trace.started") {
    const configuration = runtimeState.configuration;
    const startedAtMs = Date.now();
    const started = appendRecord({
      schema: TRACE_SCHEMA,
      schemaVersion: TRACE_SCHEMA_VERSION,
      runId: runtimeState.runId,
      event: "trace.started",
      scenarioId: configuration.scenarioId,
      wallTimeIso: new Date(startedAtMs).toISOString(),
      wallTimeUnixMs: startedAtMs,
      monotonicNs: process.hrtime.bigint().toString(10),
      simulationTick: null,
      simulationTimeMs: null,
      destinyStamp: null,
      systemId: null,
      observer: null,
      entityIds: [],
      correlation: {},
      data: {
        outputFormat: "append-only-ndjson",
        byteDomain: "privacy-safe-destiny-notification-inner-marshal",
        filters: {
          scenarios: [...configuration.scenarioFilters],
          systems: [...configuration.systemFilters],
          sessions: [...configuration.sessionFilters],
          entities: [...configuration.entityFilters],
        },
      },
    });
    if (!started) {
      return null;
    }
    runtimeState.started = true;
  }

  const wallTimeUnixMs = Date.now();
  const resolvedClock = resolveClock(scene, clock);
  return appendRecord({
    schema: TRACE_SCHEMA,
    schemaVersion: TRACE_SCHEMA_VERSION,
    runId: runtimeState.runId,
    event: String(event),
    scenarioId: runtimeState.configuration.scenarioId,
    wallTimeIso: new Date(wallTimeUnixMs).toISOString(),
    wallTimeUnixMs,
    monotonicNs: process.hrtime.bigint().toString(10),
    simulationTick: resolvedClock.simulationTick,
    simulationTimeMs: resolvedClock.simulationTimeMs,
    destinyStamp: resolvedClock.destinyStamp,
    systemId: getSystemId(scene, session),
    observer: observerSnapshot(session),
    entityIds: uniqueEntityIds(entityIds),
    correlation,
    data,
  });
}

function copyVector(value) {
  if (!value || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  const result = {};
  for (const key of ["x", "y", "z", "w"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      result[key] = value[key];
    }
  }
  return result;
}

function snapshotEntity(scene, entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  const entityId = Number(entity.itemID);
  const sceneMember = Boolean(
    scene &&
    scene.dynamicEntities instanceof Map &&
    Number.isSafeInteger(entityId) &&
    scene.dynamicEntities.get(entityId) === entity,
  );
  return {
    entityId: Number.isSafeInteger(entityId) ? entityId : entity.itemID,
    kind: entity.kind === undefined ? null : entity.kind,
    typeId: entity.typeID === undefined ? null : entity.typeID,
    position: copyVector(entity.position),
    velocity: copyVector(entity.velocity),
    direction: copyVector(entity.direction),
    heading: entity.heading && typeof entity.heading === "object"
      ? copyVector(entity.heading)
      : entity.heading === undefined ? null : entity.heading,
    targetPoint: copyVector(entity.targetPoint),
    mode: entity.mode === undefined ? null : entity.mode,
    effectStamp: entity.effectStamp === undefined ? null : entity.effectStamp,
    radius: entity.radius === undefined ? null : entity.radius,
    lifecycle: {
      alive: entity.alive === undefined ? null : entity.alive,
      moribund: entity.moribund === undefined ? null : entity.moribund,
      destroyed: entity.destroyed === undefined ? null : entity.destroyed,
      pendingRemoval: entity.pendingRemoval === undefined ? null : entity.pendingRemoval,
      destroyedAt: entity.destroyedAt === undefined ? null : entity.destroyedAt,
      sceneMember,
      derivedAlive:
        sceneMember &&
        entity.alive !== false &&
        entity.moribund !== true &&
        entity.destroyed !== true &&
        entity.pendingRemoval !== true &&
        !(Number.isFinite(Number(entity.destroyedAt)) && Number(entity.destroyedAt) > 0),
    },
    systemId: entity.systemID === undefined
      ? getSystemId(scene, null)
      : entity.systemID,
    bubbleId: entity.bubbleID === undefined ? null : entity.bubbleID,
    publicGridKey: entity.publicGridKey === undefined ? null : entity.publicGridKey,
    launcherId: entity.launcherID === undefined ? null : entity.launcherID,
  };
}

function rememberSnapshot(entityId, snapshot) {
  const numericId = Number(entityId);
  if (Number.isSafeInteger(numericId) && numericId > 0 && snapshot) {
    runtimeState.lastSnapshotByEntityId.set(numericId, snapshot);
  }
}

function recordSimulationState(scene, simulationTimeMs) {
  if (!isEnabled() || !scene || !(scene.dynamicEntities instanceof Map)) {
    return 0;
  }
  let count = 0;
  for (const entity of scene.dynamicEntities.values()) {
    const entityId = Number(entity && entity.itemID);
    if (!matchesFilters({ scene, entityIds: [entityId], entityScoped: true })) {
      continue;
    }
    const snapshot = snapshotEntity(scene, entity);
    rememberSnapshot(entityId, snapshot);
    if (emitEvent("simulation.entity-state", {
      scene,
      entityIds: [entityId],
      entityScoped: true,
      clock: { simulationTimeMs },
      data: { snapshot },
    })) {
      count += 1;
    }
  }
  return count;
}

function recordEntitySpawn(scene, entity, options = {}) {
  if (!isEnabled() || !scene || !entity) {
    return null;
  }
  const entityId = Number(entity.itemID);
  const parentId = Number(entity.launcherID);
  const destruction = Number.isSafeInteger(parentId)
    ? runtimeState.destructionBySourceEntityId.get(parentId) || null
    : null;
  if (destruction) {
    runtimeState.relatedEntityIds.add(String(entityId));
    runtimeState.destructionByReplacementEntityId.set(entityId, destruction);
    destruction.replacementEntityId = entityId;
  }
  const snapshot = snapshotEntity(scene, entity);
  rememberSnapshot(entityId, snapshot);
  return emitEvent(destruction ? "wreck.created" : "entity.spawned", {
    scene,
    entityIds: destruction ? [parentId, entityId] : [entityId],
    entityScoped: true,
    correlation: destruction ? { destructionId: destruction.destructionId } : {},
    data: {
      snapshot,
      broadcastRequested: options.broadcast !== false,
      replacementForEntityId: destruction ? parentId : null,
    },
  });
}

function recordWreckRecordCreated(scene, wreckRecord, details = {}) {
  if (!isEnabled() || !scene || !wreckRecord) {
    return null;
  }
  const sourceEntityId = Number(
    wreckRecord.sourceEntityID !== undefined
      ? wreckRecord.sourceEntityID
      : wreckRecord.launcherID,
  );
  const wreckEntityId = Number(
    wreckRecord.wreckID !== undefined
      ? wreckRecord.wreckID
      : wreckRecord.itemID,
  );
  if (
    !Number.isSafeInteger(sourceEntityId) || sourceEntityId <= 0 ||
    !Number.isSafeInteger(wreckEntityId) || wreckEntityId <= 0 ||
    !matchesFilters({
      scene,
      entityIds: [sourceEntityId, wreckEntityId],
      entityScoped: true,
    })
  ) {
    return null;
  }
  let destruction = runtimeState.destructionBySourceEntityId.get(sourceEntityId);
  if (!destruction) {
    destruction = {
      destructionId: `destruction:${runtimeState.nextDestructionSequence++}`,
      sourceEntityId,
      replacementEntityId: wreckEntityId,
      terminalSnapshot: null,
      wreckRecordSnapshot: null,
    };
    runtimeState.destructionBySourceEntityId.set(sourceEntityId, destruction);
  }
  destruction.replacementEntityId = wreckEntityId;
  runtimeState.relatedEntityIds.add(String(wreckEntityId));
  runtimeState.destructionByReplacementEntityId.set(wreckEntityId, destruction);
  const spatialState = wreckRecord.spaceState &&
    typeof wreckRecord.spaceState === "object"
    ? wreckRecord.spaceState
    : wreckRecord;
  const snapshot = snapshotEntity(scene, {
    itemID: wreckEntityId,
    kind: "wreck",
    typeID: wreckRecord.typeID,
    position: spatialState.position,
    velocity: spatialState.velocity,
    direction: spatialState.direction,
    heading: spatialState.heading,
    targetPoint: spatialState.targetPoint,
    mode: spatialState.mode,
    effectStamp: spatialState.effectStamp,
    radius: spatialState.radius !== undefined
      ? spatialState.radius
      : spatialState.spaceRadius,
    systemID: wreckRecord.systemID !== undefined
      ? wreckRecord.systemID
      : wreckRecord.locationID,
    launcherID: sourceEntityId,
  });
  destruction.wreckRecordSnapshot = snapshot;
  rememberSnapshot(wreckEntityId, snapshot);
  return emitEvent("wreck.record-created", {
    scene,
    entityIds: [sourceEntityId, wreckEntityId],
    entityScoped: true,
    correlation: { destructionId: destruction.destructionId },
    data: {
      sourceEntityId,
      replacementEntityId: wreckEntityId,
      persistenceKind: String(details.persistenceKind || "unspecified"),
      snapshot,
    },
  });
}

function recordTerminalState(scene, entity, options = {}) {
  if (!isEnabled() || !scene || !entity) {
    return null;
  }
  const effectId = Number(options.terminalDestructionEffectID);
  if (!Number.isSafeInteger(effectId) || effectId <= 0) {
    return null;
  }
  const entityId = Number(entity.itemID);
  if (!matchesFilters({ scene, entityIds: [entityId], entityScoped: true })) {
    return null;
  }
  const snapshot = snapshotEntity(scene, entity);
  rememberSnapshot(entityId, snapshot);
  let context = runtimeState.destructionBySourceEntityId.get(entityId);
  if (!context) {
    context = {
      destructionId: `destruction:${runtimeState.nextDestructionSequence++}`,
      sourceEntityId: entityId,
      replacementEntityId: null,
      terminalSnapshot: null,
      wreckRecordSnapshot: null,
    };
    runtimeState.destructionBySourceEntityId.set(entityId, context);
  }
  context.terminalSnapshot = snapshot;
  const destructionId = context.destructionId;
  return emitEvent("destruction.terminal-state", {
    scene,
    entityIds: [entityId],
    entityScoped: true,
    clock: {
      simulationTimeMs: options.nowMs,
      destinyStamp: scene && scene.nextDestinyStamp,
    },
    correlation: { destructionId },
    data: {
      terminalDestructionEffectId: effectId,
      snapshot,
      authoredPositionPresent: false,
    },
  });
}

function extractPayloadUpdates(payloadTuple) {
  const listValue = Array.isArray(payloadTuple) ? payloadTuple[0] : null;
  const entries = listValue && listValue.type === "list" && Array.isArray(listValue.items)
    ? listValue.items
    : Array.isArray(listValue) ? listValue : [];
  return entries
    .filter((entry) => Array.isArray(entry) && Array.isArray(entry[1]))
    .map((entry, index) => ({
      index,
      stamp: Number(entry[0]) >>> 0,
      payload: entry[1],
    }));
}

function buildFallbackNotificationContext(session, payloadTuple) {
  const updates = extractPayloadUpdates(payloadTuple);
  const entityIds = uniqueEntityIds(updates.flatMap((update) => (
    extractTraceEntityIds(update.payload)
  )));
  if (!matchesFilters({
    session,
    entityIds,
    entityScoped: runtimeState.configuration.entityFilters.size > 0,
  })) {
    return null;
  }
  const notificationId = `notification:${runtimeState.nextNotificationSequence++}`;
  return {
    scene: null,
    sessionId: getSessionId(session),
    notificationId,
    groupIds: [],
    actionContexts: [],
    entityIds,
    simulationTimeMs: null,
    simulationTick: null,
    destinyStamp: null,
    fallbackActions: updates.map((update) => ({
      name: update.payload[0],
      stamp: update.stamp,
      entityIds: extractTraceEntityIds(update.payload),
      payload: update.payload,
    })),
  };
}

function recordSerializedNotification(session, payloadTuple, buffer) {
  if (!isEnabled() || !Buffer.isBuffer(buffer)) {
    return null;
  }
  const linkedContext = payloadTuple && typeof payloadTuple === "object"
    ? notificationContextByPayload.get(payloadTuple) || null
    : null;
  if (linkedContext && payloadTuple && typeof payloadTuple === "object") {
    notificationContextByPayload.delete(payloadTuple);
  }
  const context = linkedContext || buildFallbackNotificationContext(session, payloadTuple);
  if (!context) {
    return null;
  }
  const packetId = `packet:${runtimeState.nextPacketSequence++}`;
  const packetContext = { ...context, packetId };
  const event = emitEvent("destiny.notification.serialized", {
    scene: context.scene,
    session,
    entityIds: context.entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: context.simulationTimeMs,
      simulationTick: context.simulationTick,
      destinyStamp: context.destinyStamp,
    },
    correlation: {
      notificationId: context.notificationId,
      packetId,
      groupIds: context.groupIds,
      actionIds: context.actionContexts.map((entry) => entry.actionId).filter(Boolean),
    },
    data: {
      byteDomain: "destiny-notification-inner-marshal",
      bytes: buffer,
      actions: context.actionContexts.map((entry, index) => ({
        actionId: entry.actionId,
        orderInNotification: index,
        name: entry.name,
        stamp: entry.stamp,
        entityIds: entry.entityIds,
      })),
      fallbackActions: context.fallbackActions || null,
      correlationComplete:
        context.actionContexts.length > 0 &&
        context.actionContexts.every((entry) => Boolean(entry.actionId)),
    },
  });
  return event ? packetContext : null;
}

function recordNotificationSent(session, context, details = {}) {
  if (!isEnabled() || !context) {
    return null;
  }
  return emitEvent("destiny.notification.sent", {
    scene: context.scene,
    session,
    entityIds: context.entityIds,
    entityScoped: false,
    clock: {
      simulationTimeMs: context.simulationTimeMs,
      simulationTick: context.simulationTick,
      destinyStamp: context.destinyStamp,
    },
    correlation: {
      notificationId: context.notificationId,
      packetId: context.packetId,
      groupIds: context.groupIds,
      actionIds: context.actionContexts.map((entry) => entry.actionId).filter(Boolean),
    },
    data: {
      outerMarshalByteLength: details.outerMarshalByteLength,
      bodyByteLength: details.bodyByteLength,
      framedByteLength: details.framedByteLength,
      encrypted: details.encrypted === true,
      socketWriteAccepted: details.socketWriteAccepted === true
        ? true
        : details.socketWriteAccepted === false
          ? false
          : null,
      deliveryClaimed: false,
    },
  });
}

// One Destiny batch: a Grid bubble's, shared by its Observers,
// or one Observer's character batch, as doPostTick sends it.
function recordDestinyBatch(scene, details = {}) {
  if (!isEnabled()) {
    return null;
  }
  const sessions = Array.isArray(details.sessions) ? details.sessions : [];
  return emitEvent("destiny.batch.sent", {
    scene,
    session: sessions.length === 1 ? sessions[0] : null,
    entityIds: uniqueEntityIds(details.entityIds || []),
    entityScoped: false,
    global: sessions.length !== 1,
    clock: {
      simulationTimeMs: details.simulationTimeMs,
      simulationTick: scene && scene._activeTickSequence,
      destinyStamp: details.destinyStamp,
    },
    data: {
      batch: details.batch,
      bubbleID: details.bubbleID === undefined ? null : details.bubbleID,
      sessionIds: sessions.map(getSessionId).filter(Boolean),
      waitForBubble: details.waitForBubble === true,
      actionCount: details.actionCount,
      encodedByteLength: details.encodedByteLength,
    },
  });
}

function complete(details = {}) {
  if (!isEnabled()) {
    return null;
  }
  const completed = emitEvent("trace.completed", {
    global: true,
    data: details,
  });
  if (completed && runtimeState.outputFd !== null) {
    try {
      fs.fsyncSync(runtimeState.outputFd);
      fs.closeSync(runtimeState.outputFd);
      runtimeState.outputFd = null;
    } catch (error) {
      markFailed(error);
    }
  }
  return completed;
}

function closeCurrentOutput() {
  if (runtimeState.outputFd === null) {
    return;
  }
  try {
    fs.closeSync(runtimeState.outputFd);
  } catch (_error) {
    // ignored: reconfiguration is test-only; the replacement recorder remains fail-open.
  }
  runtimeState.outputFd = null;
}

function configureForTesting(options = {}) {
  closeCurrentOutput();
  runtimeState = createRuntimeState(buildConfiguration(options));
  notificationContextByPayload = new WeakMap();
  updateTraceContextByUpdate = new WeakMap();
  return getStatus();
}

function resetForTesting() {
  closeCurrentOutput();
  runtimeState = createRuntimeState(configurationFromEnvironment());
  notificationContextByPayload = new WeakMap();
  updateTraceContextByUpdate = new WeakMap();
  return getStatus();
}

function getStatus() {
  const configuration = runtimeState.configuration;
  return {
    requested: configuration.requested,
    enabled: isEnabled(),
    outputPath: configuration.outputPath,
    scenarioId: configuration.scenarioId,
    configurationError: configuration.configurationError,
    started: runtimeState.started,
    failed: runtimeState.failed,
    failureCount: runtimeState.failureCount,
    lastError: runtimeState.lastError,
    eventSequence: runtimeState.eventSequence,
    runId: runtimeState.runId,
  };
}

module.exports = {
  TRACE_SCHEMA,
  TRACE_SCHEMA_VERSION,
  complete: failOpen(complete, null),
  encodeLosslessValue,
  getStatus,
  isEnabled,
  recordDestinyBatch: failOpen(recordDestinyBatch, null),
  recordEntitySpawn: failOpen(recordEntitySpawn, null),
  recordNotificationSent: failOpen(recordNotificationSent, null),
  recordSerializedNotification: failOpen(recordSerializedNotification, null),
  recordSimulationState: failOpen(recordSimulationState, 0),
  recordTerminalState: failOpen(recordTerminalState, null),
  recordWreckRecordCreated: failOpen(recordWreckRecordCreated, null),
  snapshotEntity: failOpen(snapshotEntity, null),
  _testing: {
    configure: configureForTesting,
    getStatus,
    reset: resetForTesting,
  },
};
