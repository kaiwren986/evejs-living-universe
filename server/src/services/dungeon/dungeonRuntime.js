"use strict";

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));
const { isDeepStrictEqual } = require("util");

const dungeonAuthority = require(path.join(__dirname, "./dungeonAuthority"));
const runtimeState = require(path.join(__dirname, "./dungeonRuntimeState"));

const instanceChangeListeners = new Set();
let runtimeTicker = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function cloneObjectiveStateForComparison(value = {}) {
  const objectiveState =
    value && typeof value === "object" && !Array.isArray(value)
      ? cloneValue(value)
      : {};
  if (
    objectiveState.metadata &&
    typeof objectiveState.metadata === "object" &&
    !Array.isArray(objectiveState.metadata)
  ) {
    delete objectiveState.metadata.lastAdvancedAtMs;
    delete objectiveState.metadata.lastProgressionAtMs;
  }
  return objectiveState;
}

function normalizeOwnership(options = {}) {
  const sharedWithCharacterIDs = [...new Set((Array.isArray(options.sharedWithCharacterIDs)
    ? options.sharedWithCharacterIDs
    : [])
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))].sort((left, right) => left - right);
  return {
    visibilityScope: normalizeText(options.visibilityScope, "public").toLowerCase(),
    characterID: Math.max(0, toInt(options.characterID, 0)) || null,
    corporationID: Math.max(0, toInt(options.corporationID, 0)) || null,
    fleetID: Math.max(0, toInt(options.fleetID, 0)) || null,
    missionOwnerCharacterID: Math.max(0, toInt(options.missionOwnerCharacterID, 0)) || null,
    sharedWithCharacterIDs,
    metadata:
      options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata)
        ? cloneValue(options.metadata)
        : {},
  };
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value) && value.length >= 3) {
    return {
      x: Number(value[0]) || 0,
      y: Number(value[1]) || 0,
      z: Number(value[2]) || 0,
    };
  }
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    z: Number(value.z) || 0,
  };
}

function emitInstanceChange(changeType, beforeInstance, afterInstance, extra = {}) {
  if (instanceChangeListeners.size <= 0) {
    return;
  }

  const before = beforeInstance ? cloneValue(beforeInstance) : null;
  const after = afterInstance ? cloneValue(afterInstance) : null;
  const payload = {
    changeType: normalizeText(changeType, "updated").toLowerCase(),
    instanceID:
      Math.max(0, toInt(after && after.instanceID, 0)) ||
      Math.max(0, toInt(before && before.instanceID, 0)) ||
      null,
    solarSystemID:
      Math.max(0, toInt(after && after.solarSystemID, 0)) ||
      Math.max(0, toInt(before && before.solarSystemID, 0)) ||
      null,
    previousSolarSystemID: Math.max(0, toInt(before && before.solarSystemID, 0)) || null,
    before,
    after,
    metadata:
      extra && typeof extra === "object" && !Array.isArray(extra)
        ? cloneValue(extra)
        : {},
  };

  for (const listener of [...instanceChangeListeners]) {
    try {
      listener(payload);
    } catch (error) {
      // Listener failures should not break the runtime mutation path.
      log.debug(`[DungeonRuntime] instance change listener failed: ${error && error.message}`);
    }
  }
}

function registerInstanceChangeListener(listener) {
  if (typeof listener !== "function") {
    return false;
  }
  instanceChangeListeners.add(listener);
  return true;
}

function unregisterInstanceChangeListener(listener) {
  return instanceChangeListeners.delete(listener);
}

function normalizeConnections(template) {
  if (Array.isArray(template && template.connections)) {
    return template.connections
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => cloneValue(entry));
  }
  if (template && template.connections && typeof template.connections === "object") {
    return Object.entries(template.connections)
      .filter(([, entry]) => entry && typeof entry === "object")
      .map(([connectionKey, entry]) => ({
        connectionKey,
        ...cloneValue(entry),
      }));
  }
  return [];
}

function normalizeRoomKey(value, fallback = "") {
  const normalized = normalizeText(value, "");
  if (!normalized) {
    return fallback;
  }
  if (normalized.includes(":")) {
    return normalized;
  }
  if (normalized.toLowerCase() === "entry") {
    return "room:entry";
  }
  return `room:${normalized}`;
}

function normalizeGateKey(value, fallback = "") {
  const normalized = normalizeText(value, "");
  if (!normalized) {
    return fallback;
  }
  if (normalized.includes(":")) {
    return normalized;
  }
  return `gate:${normalized}`;
}

function normalizeStateValue(value, fallback) {
  const normalized = normalizeText(value, "").toLowerCase();
  return normalized || fallback;
}

function normalizeRecordCollection(value, keyField) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => cloneValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, entry]) => entry && typeof entry === "object")
      .map(([recordKey, entry]) => ({
        [keyField]: recordKey,
        ...cloneValue(entry),
      }));
  }
  return [];
}

function resolveRoomKeyFromDefinition(definition, index, fallback = "") {
  const raw = definition && typeof definition === "object" ? definition : {};
  const explicitKey =
    raw.roomKey ||
    raw.key ||
    raw.roomID ||
    raw.roomId ||
    raw.roomObjectID ||
    raw.objectID ||
    raw.pocketID ||
    raw.pocketId ||
    "";
  const fallbackKey =
    normalizeText(fallback, "") ||
    (index === 0 ? "room:entry" : `room:mission_${index + 1}`);
  return normalizeRoomKey(explicitKey, fallbackKey);
}

function collectTemplateRoomDefinitions(template) {
  const sceneProfile =
    template &&
    template.siteSceneProfile &&
    typeof template.siteSceneProfile === "object"
      ? template.siteSceneProfile
      : {};
  const rooms = [];
  const roomIndexByKey = new Map();
  const addRoom = (definition, source, index, fallbackKey = "") => {
    const raw = definition && typeof definition === "object" ? definition : {};
    const roomKey = resolveRoomKeyFromDefinition(raw, index, fallbackKey);
    if (!roomKey) {
      return;
    }
    const entry = {
      ...cloneValue(raw),
      roomKey,
      source: normalizeText(raw.source, source) || source,
      sourceIndex: Math.max(0, toInt(raw.sourceIndex, index)),
    };
    const existingIndex = roomIndexByKey.get(roomKey);
    if (existingIndex != null) {
      rooms[existingIndex] = {
        ...rooms[existingIndex],
        ...entry,
        metadata: {
          ...normalizeObject(rooms[existingIndex] && rooms[existingIndex].metadata),
          ...normalizeObject(entry.metadata),
        },
      };
      return;
    }
    roomIndexByKey.set(roomKey, rooms.length);
    rooms.push(entry);
  };

  const explicitEntryRoomKey = normalizeRoomKey(
    template && template.entryRoomKey,
    "",
  );
  const entryRoomKey = explicitEntryRoomKey || "room:entry";
  addRoom({
    roomKey: entryRoomKey,
    label: "Entry Pocket",
    stage: "entry",
    initialState: "active",
    nodeGraphID:
      template &&
      template.clientObjectives &&
      Number(template.clientObjectives.nodeGraphID) > 0
        ? Number(template.clientObjectives.nodeGraphID)
        : null,
  }, explicitEntryRoomKey ? "template.entryRoomKey" : "derived_entry", 0, entryRoomKey);

  const environmentTemplates =
    template &&
    template.environmentTemplates &&
    typeof template.environmentTemplates === "object"
      ? template.environmentTemplates
      : null;
  const roomTemplates =
    environmentTemplates &&
    environmentTemplates.roomTemplates &&
    typeof environmentTemplates.roomTemplates === "object"
      ? environmentTemplates.roomTemplates
      : {};
  const orderedRoomObjectIDs = Object.keys(roomTemplates)
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0)
    .sort((left, right) => left - right);
  orderedRoomObjectIDs.forEach((roomObjectID, index) => {
    addRoom({
      roomKey: `room:${roomObjectID}`,
      stage: "room",
      pocketID: roomObjectID,
      metadata: {
        roomTemplate: cloneValue(roomTemplates[String(roomObjectID)] || {}),
      },
    }, "environmentTemplates.roomTemplates", index + 1, `room:${roomObjectID}`);
  });

  normalizeRecordCollection(sceneProfile.roomProfiles, "roomKey")
    .forEach((roomProfile, index) => {
      addRoom(roomProfile, "siteSceneProfile.roomProfiles", index, null);
    });

  normalizeRecordCollection(template && template.rooms, "roomKey")
    .forEach((room, index) => {
      addRoom(room, "template.rooms", index, null);
    });

  return rooms;
}

function listOrderedTemplateRoomKeys(template) {
  return collectTemplateRoomDefinitions(template)
    .map((entry) => normalizeText(entry && entry.roomKey, ""))
    .filter(Boolean);
}

function buildDefaultRoomStates(template, nowMs, options = {}) {
  const explicitRoomStates =
    options.roomStatesByKey && typeof options.roomStatesByKey === "object"
      ? cloneValue(options.roomStatesByKey)
      : null;
  if (explicitRoomStates) {
    return explicitRoomStates;
  }

  const roomStatesByKey = {};
  for (const room of collectTemplateRoomDefinitions(template)) {
    const roomKey = normalizeText(room && room.roomKey, "");
    if (!roomKey || roomStatesByKey[roomKey]) {
      continue;
    }
    const state = normalizeStateValue(
      room && (room.initialState || room.state),
      roomKey === "room:entry" ? "active" : "pending",
    );
    const stage = normalizeText(
      room && room.stage,
      roomKey === "room:entry" ? "entry" : "room",
    );
    const pocketID = Math.max(
      0,
      toInt(
        room && (room.pocketID || room.pocketId || room.roomID || room.roomId || room.objectID),
        0,
      ),
    ) || null;
    const nodeGraphID = Math.max(0, toInt(room && room.nodeGraphID, 0)) || null;
    roomStatesByKey[roomKey] = {
      roomKey,
      state,
      stage,
      pocketID,
      nodeGraphID,
      activatedAtMs: state === "active" ? nowMs : 0,
      completedAtMs: 0,
      lastUpdatedAtMs: nowMs,
      spawnedEntityIDs: [],
      counters: {},
      label: normalizeText(room && room.label, "") || null,
      metadata: {
        seededFromTemplate: true,
        source: normalizeText(room && room.source, "") || null,
        sourceIndex: Math.max(0, toInt(room && room.sourceIndex, 0)),
        role: normalizeText(room && room.role, "") || null,
        rawRoomProfile: cloneValue(room),
      },
    };
  }

  const explicitEntryRoomKey = normalizeRoomKey(
    template && template.entryRoomKey,
    "",
  );
  const entryRoomKey = explicitEntryRoomKey || "room:entry";
  if (!roomStatesByKey[entryRoomKey]) {
    roomStatesByKey[entryRoomKey] = {
      roomKey: entryRoomKey,
      state: "active",
      stage: "entry",
      pocketID: null,
      nodeGraphID:
        template &&
        template.clientObjectives &&
        Number(template.clientObjectives.nodeGraphID) > 0
          ? Number(template.clientObjectives.nodeGraphID)
          : null,
      activatedAtMs: nowMs,
      completedAtMs: 0,
      lastUpdatedAtMs: nowMs,
      spawnedEntityIDs: [],
      counters: {},
      metadata: {
        seededFromTemplate: true,
        source: explicitEntryRoomKey ? "template.entryRoomKey" : "derived_entry",
      },
    };
  }

  return roomStatesByKey;
}

function resolveDestinationRoomKey(connection, orderedRoomKeys, index) {
  const explicitDestinationRoomKey = normalizeRoomKey(
    connection && (
      connection.destinationRoomKey ||
      connection.toRoomKey ||
      connection.destination ||
      ""
    ),
    "",
  );
  if (explicitDestinationRoomKey) {
    return explicitDestinationRoomKey;
  }
  const toObjectID = toInt(connection && connection.toObjectID, 0);
  const objectDestinationRoomKey = toObjectID > 0 ? `room:${toObjectID}` : null;
  if (objectDestinationRoomKey && orderedRoomKeys.includes(objectDestinationRoomKey)) {
    return objectDestinationRoomKey;
  }
  if (orderedRoomKeys.length > 1) {
    return orderedRoomKeys[Math.min(index + 1, orderedRoomKeys.length - 1)];
  }
  return "room:entry";
}

function collectTemplateGateDefinitions(template) {
  const orderedRoomKeys = listOrderedTemplateRoomKeys(template);
  const sceneProfile =
    template &&
    template.siteSceneProfile &&
    typeof template.siteSceneProfile === "object"
      ? template.siteSceneProfile
      : {};
  const gates = [];
  const gateIndexByKey = new Map();
  const addGate = (definition, source, index) => {
    const raw = definition && typeof definition === "object" ? definition : {};
    const fromObjectID = toInt(raw.fromObjectID || raw.dungeonObjectID || raw.dunObjectID, 0);
    const gateKey = normalizeGateKey(
      raw.gateKey ||
      raw.key ||
      raw.connectionKey ||
      fromObjectID ||
      index + 1,
      `gate:${index + 1}`,
    );
    if (!gateKey) {
      return;
    }
    const destinationRoomKey = resolveDestinationRoomKey(raw, orderedRoomKeys, index);
    const entry = {
      ...cloneValue(raw),
      gateKey,
      destinationRoomKey,
      source: normalizeText(raw.source, source) || source,
      sourceIndex: Math.max(0, toInt(raw.sourceIndex, index)),
      fromObjectID: fromObjectID || null,
      toObjectID: toInt(raw.toObjectID, 0) || null,
    };
    const existingIndex = gateIndexByKey.get(gateKey);
    if (existingIndex != null) {
      gates[existingIndex] = {
        ...gates[existingIndex],
        ...entry,
        metadata: {
          ...normalizeObject(gates[existingIndex] && gates[existingIndex].metadata),
          ...normalizeObject(entry.metadata),
        },
      };
      return;
    }
    gateIndexByKey.set(gateKey, gates.length);
    gates.push(entry);
  };

  normalizeConnections(template)
    .forEach((connection, index) => addGate(connection, "connections", index));
  normalizeRecordCollection(sceneProfile.gateProfiles, "gateKey")
    .forEach((gateProfile, index) => addGate(gateProfile, "siteSceneProfile.gateProfiles", index));
  normalizeRecordCollection(template && template.gates, "gateKey")
    .forEach((gate, index) => addGate(gate, "template.gates", index));
  return gates;
}

function isEveSurvivalTemplate(template) {
  const templateID = normalizeText(template && template.templateID, "").toLowerCase();
  const source = normalizeText(template && template.source, "").toLowerCase();
  return templateID.startsWith("eve-survival:") || source.includes("eve-survival");
}

function resolveDefaultGateState(template, gateKey, destinationRoomKey) {
  if (destinationRoomKey === "room:entry") {
    return "unlocked";
  }
  const normalizedGateKey = normalizeText(gateKey, "").toLowerCase();
  const siteFamily = normalizeText(template && template.siteFamily, "").toLowerCase();
  if (
    siteFamily === "mission" &&
    isEveSurvivalTemplate(template) &&
    normalizedGateKey === "gate:entry"
  ) {
    return "unlocked";
  }
  return "locked";
}

function buildDefaultGateStates(template, nowMs, options = {}) {
  const explicitGateStates =
    options.gateStatesByKey && typeof options.gateStatesByKey === "object"
      ? cloneValue(options.gateStatesByKey)
      : null;
  if (explicitGateStates) {
    return explicitGateStates;
  }

  const gateStatesByKey = {};
  collectTemplateGateDefinitions(template).forEach((gate, index) => {
    const gateKey = normalizeText(gate && gate.gateKey, `gate:${index + 1}`);
    const destinationRoomKey = normalizeText(gate && gate.destinationRoomKey, "") || null;
    const fromObjectID = toInt(gate && gate.fromObjectID, 0);
    const toObjectID = toInt(gate && gate.toObjectID, 0);
    const defaultState = resolveDefaultGateState(template, gateKey, destinationRoomKey);
    const state = normalizeStateValue(gate && (gate.initialState || gate.state), defaultState);
    gateStatesByKey[gateKey] = {
      gateKey,
      state,
      usesCount: 0,
      unlockedAtMs: state === "unlocked" ? nowMs : 0,
      lastUsedAtMs: 0,
      destinationRoomKey,
      allowedShipGroupIDs: [],
      allowedShipTypeIDs: [],
      metadata: {
        seededFromTemplate: true,
        connectionIndex: Math.max(0, toInt(gate && gate.connectionIndex, index)),
        connectionKey: gate && gate.connectionKey ? gate.connectionKey : null,
        source: normalizeText(gate && gate.source, "") || null,
        sourceIndex: Math.max(0, toInt(gate && gate.sourceIndex, index)),
        fromObjectID: fromObjectID || null,
        toObjectID: toObjectID || null,
        inferredDestinationRoomKey: destinationRoomKey,
        allowedShipsList: toInt(gate && gate.allowedShipsList, 0) || null,
        allowedRaces: Array.isArray(gate && gate.allowedRaces)
          ? cloneValue(gate.allowedRaces)
          : [],
        keyLock: toInt(gate && gate.keyLock, 0) || null,
        requiredItemTypeID: toInt(gate && gate.requiredItemTypeID, 0) || null,
        requiredItemQuantity: toInt(gate && gate.requiredItemQuantity, 0) || null,
        rawGateProfile: cloneValue(gate),
      },
    };
  });

  return gateStatesByKey;
}

function ensureTemplateRuntimeState(instanceID, options = {}) {
  const existing = requireInstance(instanceID);
  const template = requireTemplate(existing.templateID);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const existingRoomStates =
    existing.roomStatesByKey && typeof existing.roomStatesByKey === "object"
      ? existing.roomStatesByKey
      : {};
  const existingGateStates =
    existing.gateStatesByKey && typeof existing.gateStatesByKey === "object"
      ? existing.gateStatesByKey
      : {};
  const defaultRoomStates = buildDefaultRoomStates(template, nowMs);
  const defaultGateStates = buildDefaultGateStates(template, nowMs);
  const roomPatch = {};
  const gatePatch = {};

  for (const [roomKey, roomState] of Object.entries(defaultRoomStates)) {
    if (existingRoomStates[roomKey]) {
      continue;
    }
    roomPatch[roomKey] = cloneValue(roomState);
  }

  for (const [gateKey, gateState] of Object.entries(defaultGateStates)) {
    const currentGateState = normalizeObject(existingGateStates[gateKey]);
    if (!existingGateStates[gateKey]) {
      gatePatch[gateKey] = cloneValue(gateState);
      continue;
    }
    const currentDestinationRoomKey = normalizeText(currentGateState.destinationRoomKey, "");
    const defaultDestinationRoomKey = normalizeText(gateState.destinationRoomKey, "");
    const currentState = normalizeText(currentGateState.state, "").toLowerCase();
    const defaultState = normalizeText(gateState.state, "").toLowerCase();
    const needsDestinationRoomKey =
      !currentDestinationRoomKey &&
      !!defaultDestinationRoomKey;
    const needsStateRepair =
      !currentState ||
      (
        currentState === "locked" &&
        defaultState === "unlocked" &&
        Math.max(0, toInt(currentGateState.usesCount, 0)) <= 0
      );
    if (!needsDestinationRoomKey && !needsStateRepair) {
      continue;
    }
    gatePatch[gateKey] = {
      ...cloneValue(gateState),
      ...cloneValue(currentGateState),
      destinationRoomKey: needsDestinationRoomKey
        ? defaultDestinationRoomKey || null
        : currentDestinationRoomKey || null,
      state: needsStateRepair
        ? defaultState || currentState || "locked"
        : currentState || defaultState || "locked",
      unlockedAtMs: needsStateRepair && defaultState === "unlocked"
        ? Math.max(0, toInt(currentGateState.unlockedAtMs, 0)) || nowMs
        : Math.max(0, toInt(currentGateState.unlockedAtMs, 0)),
      metadata: {
        ...normalizeObject(gateState.metadata),
        ...normalizeObject(currentGateState.metadata),
        inferredDestinationRoomKey: needsDestinationRoomKey
          ? defaultDestinationRoomKey || null
          : normalizeText(
            currentGateState.metadata && currentGateState.metadata.inferredDestinationRoomKey,
            "",
          ) || defaultDestinationRoomKey || null,
      },
    };
  }

  if (Object.keys(roomPatch).length <= 0 && Object.keys(gatePatch).length <= 0) {
    return existing;
  }

  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    target.roomStatesByKey = {
      ...normalizeObject(target.roomStatesByKey),
      ...cloneValue(roomPatch),
    };
    target.gateStatesByKey = {
      ...normalizeObject(target.gateStatesByKey),
      ...cloneValue(gatePatch),
    };
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  });

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: "ensureTemplateRuntimeState",
    roomKeys: Object.keys(roomPatch),
    gateKeys: Object.keys(gatePatch),
  });
  return updated;
}

function buildDefaultObjectiveState(template, nowMs, options = {}) {
  const explicitObjectiveState =
    options.objectiveState && typeof options.objectiveState === "object"
      ? cloneValue(options.objectiveState)
      : null;
  if (explicitObjectiveState) {
    return explicitObjectiveState;
  }

  const clientObjectives =
    template &&
    template.clientObjectives &&
    typeof template.clientObjectives === "object"
      ? template.clientObjectives
      : null;
  const objectiveMetadata =
    template &&
    template.objectiveMetadata &&
    typeof template.objectiveMetadata === "object"
      ? template.objectiveMetadata
      : null;
  const objectiveChain =
    objectiveMetadata &&
    objectiveMetadata.objectiveChain &&
    typeof objectiveMetadata.objectiveChain === "object"
      ? objectiveMetadata.objectiveChain
      : null;
  const seededObjectives = Array.isArray(objectiveChain && objectiveChain.objectives)
    ? objectiveChain.objectives
    : [];
  const seededCurrentObjective = seededObjectives.find((objective) => (
    objective && (objective.startActive === 1 || objective.startActive === true)
  )) || seededObjectives[0] || null;
  return {
    state: clientObjectives ? "seeded" : "pending",
    currentNodeID:
      clientObjectives && Number(clientObjectives.nodeGraphID) > 0
        ? Number(clientObjectives.nodeGraphID)
        : null,
    currentObjectiveID:
      clientObjectives && Number(clientObjectives.objectiveChainID) > 0
        ? Number(clientObjectives.objectiveChainID)
        : null,
    currentObjectiveKey:
      seededCurrentObjective && seededCurrentObjective.key
        ? String(seededCurrentObjective.key)
        : null,
    currentObjectiveTypeID:
      seededCurrentObjective && Number(seededCurrentObjective.objectiveType) > 0
        ? Number(seededCurrentObjective.objectiveType)
        : null,
    completedObjectiveIDs: [],
    completedNodeIDs: [],
    counters: {},
    metadata: {
      seededFromTemplate: true,
      objectivesID: toInt(template && template.objectivesID, 0) || null,
      objectiveChainID:
        clientObjectives && Number(clientObjectives.objectiveChainID) > 0
          ? Number(clientObjectives.objectiveChainID)
          : null,
      nodeGraphID:
        clientObjectives && Number(clientObjectives.nodeGraphID) > 0
          ? Number(clientObjectives.nodeGraphID)
          : null,
      blackboardParameters:
        clientObjectives && Array.isArray(clientObjectives.blackboardParameters)
          ? cloneValue(clientObjectives.blackboardParameters)
          : [],
      objectiveSummary: objectiveChain
        ? {
          name: normalizeText(objectiveChain.name, "") || null,
          tags: Array.isArray(objectiveChain.tags) ? cloneValue(objectiveChain.tags) : [],
          objectiveKeys: seededObjectives
            .map((objective) => normalizeText(objective && objective.key, ""))
            .filter(Boolean),
        }
        : null,
      objectiveTypeIDs:
        objectiveMetadata && Array.isArray(objectiveMetadata.objectiveTypeIDs)
          ? cloneValue(objectiveMetadata.objectiveTypeIDs)
          : [],
      nodeTypeIDs:
        objectiveMetadata && Array.isArray(objectiveMetadata.nodeTypeIDs)
          ? cloneValue(objectiveMetadata.nodeTypeIDs)
          : [],
      seededAtMs: nowMs,
    },
  };
}

function buildDefaultEnvironmentState(template, nowMs, options = {}) {
  const explicitEnvironmentState =
    options.environmentState && typeof options.environmentState === "object"
      ? cloneValue(options.environmentState)
      : null;
  if (explicitEnvironmentState) {
    return explicitEnvironmentState;
  }

  const environmentTemplates =
    template &&
    template.environmentTemplates &&
    typeof template.environmentTemplates === "object"
      ? template.environmentTemplates
      : null;
  return {
    seededAtMs: nowMs,
    templates: environmentTemplates ? cloneValue(environmentTemplates) : null,
  };
}

function dungeonError(code, message = code) {
  const error = new Error(String(message || code || "DUNGEON_ERROR"));
  error.dungeonError = String(code || "DUNGEON_ERROR");
  return error;
}


function commitRuntimeStateMutation(mutator, options = {}) {
  const result = runtimeState.mutateState(mutator, options);
  if (
    !result ||
    result.success !== true ||
    (options.durable === true && result.durable !== true)
  ) {
    const errorMsg = String(
      result && result.errorMsg || "DUNGEON_RUNTIME_STATE_WRITE_FAILED",
    );
    const error = dungeonError(
      "DUNGEON_RUNTIME_STATE_WRITE_FAILED",
      `Dungeon runtime state mutation was not committed: ${errorMsg}`,
    );
    // The mutation result already owns its diagnostic snapshots. Serializing it
    // again would join the entire dungeon table into one potentially huge string.
    error.persistenceResult = result || null;
    throw error;
  }
  return result;
}

function requireTemplate(templateID, options = {}) {
  const normalizedTemplateID = normalizeText(templateID, "");
  if (!normalizedTemplateID) {
    throw dungeonError("DUNGEON_TEMPLATE_REQUIRED");
  }
  const template = options.readOnly === true
    ? dungeonAuthority.getTemplateByIDReadOnly(normalizedTemplateID)
    : dungeonAuthority.getTemplateByID(normalizedTemplateID);
  if (!template) {
    throw dungeonError("DUNGEON_TEMPLATE_NOT_FOUND", `Unknown dungeon template: ${normalizedTemplateID}`);
  }
  return template;
}

function requireInstance(instanceID) {
  const instance = runtimeState.getInstanceSnapshot(instanceID);
  if (!instance) {
    throw dungeonError("DUNGEON_INSTANCE_NOT_FOUND", `Unknown dungeon instance: ${instanceID}`);
  }
  return instance;
}

function buildInstanceRecordFromOptions(instanceID, template, options = {}, nowMs = Date.now()) {
  const solarSystemID = Math.max(0, toInt(options.solarSystemID, 0));
  if (solarSystemID <= 0) {
    throw dungeonError("DUNGEON_SOLAR_SYSTEM_REQUIRED");
  }

  const siteKey = normalizeText(options.siteKey, "") || null;
  const ownership = normalizeOwnership(options.ownership || options);
  const lifecycleState = normalizeText(options.lifecycleState, "seeded").toLowerCase();
  const createdAtMs = nowMs;
  const activatedAtMs = Math.max(0, toInt(options.activatedAtMs, createdAtMs));
  const expiresAtMs = Math.max(0, toInt(options.expiresAtMs, 0));
  const despawnAtMs = Math.max(0, toInt(options.despawnAtMs, 0));
  const instanceScope = normalizeText(options.instanceScope, "shared").toLowerCase();
  const position = normalizePosition(options.position);
  const roomStatesByKey = buildDefaultRoomStates(template, nowMs, options);
  const gateStatesByKey = buildDefaultGateStates(template, nowMs, options);
  const objectiveState = buildDefaultObjectiveState(template, nowMs, options);
  const environmentState = buildDefaultEnvironmentState(template, nowMs, options);

  return {
    instanceID,
    templateID: template.templateID,
    solarSystemID,
    siteKey,
    lifecycleState,
    lifecycleReason: normalizeText(options.lifecycleReason, "") || null,
    instanceScope,
    siteFamily: normalizeText(options.siteFamily, template.siteFamily || "unknown").toLowerCase(),
    siteKind: normalizeText(options.siteKind, template.siteKind || "unknown").toLowerCase(),
    siteOrigin: normalizeText(options.siteOrigin, template.siteOrigin || "unknown").toLowerCase(),
    source: normalizeText(template.source, "unknown").toLowerCase(),
    sourceDungeonID: template.sourceDungeonID || null,
    archetypeID: template.archetypeID || null,
    factionID: template.factionID || null,
    difficulty: template.difficulty || null,
    entryObjectTypeID: template.entryObjectTypeID || null,
    dungeonNameID: template.dungeonNameID || null,
    position,
    ownership,
    timers: {
      createdAtMs,
      activatedAtMs,
      expiresAtMs,
      despawnAtMs,
      lastUpdatedAtMs: nowMs,
    },
    roomStatesByKey,
    gateStatesByKey,
    objectiveState,
    hazardState:
      options.hazardState && typeof options.hazardState === "object"
        ? cloneValue(options.hazardState)
        : {},
    environmentState,
    spawnState: {
      ...(options.spawnState && typeof options.spawnState === "object"
        ? cloneValue(options.spawnState)
        : {}),
      // Persist the rock layout with every new instance before materialization.
      // Unversioned saved instances retain their old ordinal resource identities.
      miningRockAllocationVersion: 1,
    },
    runtimeFlags:
      options.runtimeFlags && typeof options.runtimeFlags === "object"
        ? cloneValue(options.runtimeFlags)
        : {},
    metadata:
      options.metadata && typeof options.metadata === "object"
        ? cloneValue(options.metadata)
        : {},
  };
}

function peekNextInstanceID() {
  return runtimeState.getNextInstanceSequence();
}

function createInstance(options = {}) {
  const template = requireTemplate(options.templateID);
  const siteKey = normalizeText(options.siteKey, "") || null;
  if (siteKey) {
    const existing = runtimeState.findInstanceSummaryBySiteKey(siteKey);
    if (existing && runtimeState.isActiveLifecycleState(existing.lifecycleState)) {
      throw dungeonError(
        "DUNGEON_SITE_KEY_IN_USE",
        `Active dungeon instance already exists for site key ${siteKey}`,
      );
    }
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  let createdInstanceID = 0;

  commitRuntimeStateMutation((table) => {
    const nextInstanceID = Math.max(1, toInt(table.nextInstanceSequence, 1));
    table.nextInstanceSequence = nextInstanceID + 1;
    createdInstanceID = nextInstanceID;
    table.instancesByID[String(nextInstanceID)] = buildInstanceRecordFromOptions(
      nextInstanceID,
      template,
      options,
      nowMs,
    );
    return table;
  });

  const created = runtimeState.getInstanceSnapshot(createdInstanceID);
  emitInstanceChange("created", null, created, {
    source: "createInstance",
  });
  return created;
}

function definitionsMatchActiveUniverseInstance(instance, definition, template) {
  if (!instance || !definition || !template) {
    return false;
  }
  if (!runtimeState.isActiveLifecycleState(instance.lifecycleState)) {
    return false;
  }
  if (normalizeText(instance.templateID, "") !== normalizeText(template.templateID, "")) {
    return false;
  }
  if (normalizeText(instance.siteKey, "") !== normalizeText(definition.siteKey, "")) {
    return false;
  }
  const existingHash = normalizeText(instance.metadata && instance.metadata.definitionHash, "");
  const desiredHash = normalizeText(definition.metadata && definition.metadata.definitionHash, "");
  if (!existingHash || existingHash !== desiredHash) {
    return false;
  }
  return true;
}

function normalizeTextFilterSet(values = []) {
  const entries = Array.isArray(values) ? values : [values];
  const normalized = [...new Set(entries
    .map((entry) => normalizeText(entry, "").toLowerCase())
    .filter(Boolean))];
  return normalized.length > 0 ? new Set(normalized) : null;
}

// Candidate C (web-companion starvation fix): a conservative no-op fast path
// for reconcileUniverseSeededInstances.
//
// The mutator in reconcileUniverseSeededInstances runs inside
// runtimeState.mutateState, which clones, normalizes, and diffs the ENTIRE
// global instance table on every call — O(all instances), even when nothing
// about the target system changed. Cold system entry (undock/jump/login) calls
// this twice per wake, synchronously on the world event loop, so the block
// grows as more systems get instantiated over a play session (measured ~340ms
// per pass at 10k global instances). That growing, load-independent stall is a
// direct cause of intermittent web-companion connection trouble.
//
// This helper decides — using ONLY the per-target-system index (O(target), not
// O(global)) and the SAME predicates the mutator uses — whether this reconcile
// would change nothing. If so it returns the identical counts the mutator would
// have produced with zero writes, and the caller skips mutateState entirely.
// It is deliberately CONSERVATIVE: any condition it cannot verify exactly
// returns null, and the unchanged full path runs. It never mutates state, and a
// reconcile that creates/replaces/removes anything always falls through.
function tryUniverseReconcileNoOpFastPath({
  normalizedDefinitions,
  desiredBySiteKey,
  templatesByID,
  targetedSystemIDs,
  siteFamilyFilter,
  spawnFamilyFilter,
  siteOriginFilter,
  preserveSiteKeys,
}) {
  if (process.env.EVEJS_DISABLE_DUNGEON_NOOP_FASTPATH === "1") {
    return null; // temporary kill switch for A/B isolation during verification
  }
  // Only the system-scoped shape the cold-entry callers use is fast-pathed;
  // an unscoped reconcile (whole table) is left to the full path.
  if (!(targetedSystemIDs instanceof Set) || targetedSystemIDs.size === 0) {
    return null;
  }
  // Gather the target systems' universe-seeded instances through the index,
  // applying the SAME universeSeeded + family + site-origin filters the
  // mutator applies. `spawnFamilyKey` is a canonical scalar in each summary;
  // if an older/foreign summary ever lacks it, decline rather than guess.
  const existingBySiteKey = new Map();
  for (const systemID of targetedSystemIDs) {
    const summaries = runtimeState.listInstanceSummariesBySystem(systemID);
    for (const instance of summaries) {
      if (!(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)) {
        continue;
      }
      if (
        siteFamilyFilter &&
        !siteFamilyFilter.has(normalizeText(instance.siteFamily, "").toLowerCase())
      ) {
        continue;
      }
      if (spawnFamilyFilter) {
        const instanceSpawnFamilyKey = normalizeText(instance.spawnFamilyKey, "").toLowerCase();
        if (!instanceSpawnFamilyKey) {
          return null;
        }
        if (!spawnFamilyFilter.has(instanceSpawnFamilyKey)) {
          continue;
        }
      }
      if (
        siteOriginFilter &&
        !siteOriginFilter.has(normalizeText(instance.siteOrigin, "").toLowerCase())
      ) {
        continue;
      }
      const siteKey = normalizeText(instance.siteKey, "");
      if (!siteKey) {
        continue;
      }
      if (existingBySiteKey.has(siteKey)) {
        // Duplicate active site key in a target system — ambiguous against the
        // mutator's last-wins scan. Decline rather than guess.
        return null;
      }
      existingBySiteKey.set(siteKey, instance);
    }
  }

  // A removal happens for any existing site key that is neither desired nor
  // preserved — that is a change, so not a no-op.
  for (const siteKey of existingBySiteKey.keys()) {
    if (!desiredBySiteKey.has(siteKey) && !preserveSiteKeys.has(siteKey)) {
      return null;
    }
  }

  // Every desired definition must map to an existing instance that is either
  // preserved or a template/hash/lifecycle match; anything else is a
  // create/replace, so not a no-op. Counts mirror the mutator exactly.
  const preservedInstanceIDs = [];
  let retainedCount = 0;
  for (const definition of normalizedDefinitions) {
    const template = templatesByID.get(definition.templateID);
    if (!template) {
      // The mutator skips a desired with no template (no create); match that.
      continue;
    }
    const existing = existingBySiteKey.get(definition.siteKey) || null;
    if (!existing) {
      return null; // would create
    }
    if (preserveSiteKeys.has(definition.siteKey)) {
      retainedCount += 1;
      preservedInstanceIDs.push(existing.instanceID);
      continue;
    }
    if (definitionsMatchActiveUniverseInstance(existing, definition, template)) {
      retainedCount += 1;
      continue;
    }
    return null; // would replace
  }

  // Proven no-op: byte-identical to the mutator's return with zero writes.
  return {
    desiredCount: normalizedDefinitions.length,
    createdCount: 0,
    retainedCount,
    preservedCount: preservedInstanceIDs.length,
    preservedInstanceIDs,
    replacedCount: 0,
    removedCount: 0,
  };
}

function settleEventSiteBeforeRemoval(instance) {
  const pending = Object.values(instance?.spawnState?.electionHacks || {}).some(row => !row.acknowledged) ||
    Object.values(instance?.spawnState?.fabricator?.kills || {}).some(row => !row.acknowledged) ||
    Object.keys(instance?.spawnState?.siteHazardDamageEventsByID || {}).length > 0 ||
    Object.values(instance?.spawnState?.hackingContainers || {}).some(row =>
      Object.values(row?.outcomes || {}).some(receipt => receipt.outcome === "won" &&
        receipt.successEffectsDelivered !== true && receipt.careerWin));
  if (!pending) return true;
  try {
    require("../seasons/eventHooks").depot.beforePurge(instance);
    require("../seasons/eventHooks").fabricator.beforePurge(instance);
    require("../exploration/hackingContainerState").beforePurge(instance);
    require("./siteHazardOutcomes").beforePurge(instance);
    const latest = runtimeState.getInstanceRef(instance.instanceID);
    if (Object.values(latest?.spawnState?.electionHacks || {}).some(row => !row.acknowledged) ||
        Object.values(latest?.spawnState?.fabricator?.kills || {}).some(row => !row.acknowledged)) {
      throw new Error("Event credit remains pending");
    }
    return true;
  } catch (error) {
    log.warn(`[Dungeon] Retaining event site ${instance.instanceID}: ${error.message}`);
    return false;
  }
}

function reconcileUniverseSeededInstances(definitions = [], options = {}) {
  const normalizedDefinitions = (Array.isArray(definitions) ? definitions : [])
    .filter((definition) => definition && definition.templateID && definition.siteKey)
    .map((definition) => ({
      ...cloneValue(definition),
      solarSystemID: Math.max(0, toInt(definition.solarSystemID, 0)),
      siteKey: normalizeText(definition.siteKey, ""),
      templateID: normalizeText(definition.templateID, ""),
    }))
    .filter((definition) => definition.solarSystemID > 0 && definition.siteKey && definition.templateID);

  const targetedSystemIDs = new Set(
    (Array.isArray(options.systemIDs) ? options.systemIDs : normalizedDefinitions.map((definition) => definition.solarSystemID))
      .map((entry) => Math.max(0, toInt(entry, 0)))
      .filter((entry) => entry > 0),
  );
  const siteFamilyFilter = normalizeTextFilterSet(options.siteFamilyFilter || []);
  const spawnFamilyFilter = normalizeTextFilterSet(options.spawnFamilyFilter || []);
  const siteOriginFilter = normalizeTextFilterSet(options.siteOriginFilter || []);
  const preserveSiteKeys = new Set(
    (Array.isArray(options.preserveSiteKeys) ? options.preserveSiteKeys : [])
      .map((entry) => normalizeText(entry, ""))
      .filter(Boolean),
  );
  const desiredBySiteKey = new Map(
    normalizedDefinitions.map((definition) => [definition.siteKey, definition]),
  );
  const templatesByID = new Map();
  for (const definition of normalizedDefinitions) {
    if (!templatesByID.has(definition.templateID)) {
      templatesByID.set(definition.templateID, requireTemplate(definition.templateID, { readOnly: true }));
    }
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));

  // Candidate C fast path: if this reconcile changes nothing, skip the O(global)
  // clone/normalize/diff inside mutateState. Returns null (falls through) unless
  // it can PROVE the reconcile is a no-op with the same predicates below.
  const noOpResult = tryUniverseReconcileNoOpFastPath({
    normalizedDefinitions,
    desiredBySiteKey,
    templatesByID,
    targetedSystemIDs,
    siteFamilyFilter,
    spawnFamilyFilter,
    siteOriginFilter,
    preserveSiteKeys,
  });
  if (noOpResult) {
    return noOpResult;
  }

  // Inspect references only for candidate event sites. An unchanged reconcile
  // returns above without cloning sites or opening reward documents. Failed
  // settlements preserve their own site, including after event shutdown.
  for (const templateID of ["evejs-election:fabricator:replay",
    "evejs-election:iteration-depot:highsec", "evejs-election:iteration-depot:vault"]) {
    for (const summary of runtimeState.listInstanceSummariesByTemplate(templateID)) {
      if (!summary.runtimeFlags?.universeSeeded || preserveSiteKeys.has(summary.siteKey) ||
          (targetedSystemIDs.size && !targetedSystemIDs.has(summary.solarSystemID)) ||
          (siteFamilyFilter && !siteFamilyFilter.has(normalizeText(summary.siteFamily, "").toLowerCase())) ||
          (spawnFamilyFilter && !spawnFamilyFilter.has(summary.spawnFamilyKey)) ||
          (siteOriginFilter && !siteOriginFilter.has(normalizeText(summary.siteOrigin, "").toLowerCase()))) continue;
      const desired = desiredBySiteKey.get(summary.siteKey);
      if (desired && definitionsMatchActiveUniverseInstance(summary, desired, templatesByID.get(desired.templateID))) continue;
      if (!settleEventSiteBeforeRemoval(runtimeState.getInstanceRef(summary.instanceID))) preserveSiteKeys.add(summary.siteKey);
    }
  }

  const removedBefore = [];
  const createdAfter = [];
  const retainedInstanceIDs = [];
  const preservedInstanceIDs = [];
  let replacedInstances = 0;
  const targetedInstanceIDs = targetedSystemIDs.size > 0 ? new Set() : null;
  if (targetedInstanceIDs) {
    for (const systemID of targetedSystemIDs) {
      for (const summary of runtimeState.listInstanceSummariesBySystem(systemID)) {
        targetedInstanceIDs.add(String(summary.instanceID));
      }
    }
  }

  commitRuntimeStateMutation((table) => {
    const instancesByID = table.instancesByID || {};
    const existingBySiteKey = new Map();
    // Reading a copy-on-write slot clones its full instance. Object.entries
    // therefore cloned every system before the destination filter ran. Keep
    // the original key order, but open only destination slots for scoped work.
    for (const instanceID of Object.keys(instancesByID)) {
      if (targetedInstanceIDs && !targetedInstanceIDs.has(instanceID)) {
        continue;
      }
      const rawInstance = instancesByID[instanceID];
      const instance = runtimeState.normalizeInstanceRecord({
        ...rawInstance,
        instanceID: toInt(rawInstance && rawInstance.instanceID, toInt(instanceID, 0)),
      });
      if (!(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)) {
        continue;
      }
      if (
        siteFamilyFilter &&
        !siteFamilyFilter.has(normalizeText(instance.siteFamily, "").toLowerCase())
      ) {
        continue;
      }
      const instanceSpawnFamilyKey = runtimeState.resolveInstanceSpawnFamilyKey(instance);
      if (
        spawnFamilyFilter &&
        !spawnFamilyFilter.has(instanceSpawnFamilyKey)
      ) {
        continue;
      }
      if (
        siteOriginFilter &&
        !siteOriginFilter.has(normalizeText(instance.siteOrigin, "").toLowerCase())
      ) {
        continue;
      }
      if (
        targetedSystemIDs.size > 0 &&
        !targetedSystemIDs.has(Math.max(0, toInt(instance.solarSystemID, 0)))
      ) {
        continue;
      }
      existingBySiteKey.set(instance.siteKey, instance);
    }

    for (const [siteKey, instance] of existingBySiteKey.entries()) {
      if (!desiredBySiteKey.has(siteKey) && !preserveSiteKeys.has(siteKey)) {
        removedBefore.push(cloneValue(instance));
        delete instancesByID[String(instance.instanceID)];
      }
    }

    let nextInstanceSequence = Math.max(1, toInt(table.nextInstanceSequence, 1));
    for (const definition of normalizedDefinitions) {
      const template = templatesByID.get(definition.templateID);
      if (!template) {
        continue;
      }
      const existing = existingBySiteKey.get(definition.siteKey) || null;
      if (existing && preserveSiteKeys.has(definition.siteKey)) {
        retainedInstanceIDs.push(existing.instanceID);
        preservedInstanceIDs.push(existing.instanceID);
        continue;
      }
      if (existing && definitionsMatchActiveUniverseInstance(existing, definition, template)) {
        retainedInstanceIDs.push(existing.instanceID);
        continue;
      }
      if (existing) {
        removedBefore.push(cloneValue(existing));
        delete instancesByID[String(existing.instanceID)];
        replacedInstances += 1;
      }
      const nextInstanceID = nextInstanceSequence;
      nextInstanceSequence += 1;
      const created = buildInstanceRecordFromOptions(
        nextInstanceID,
        template,
        definition,
        nowMs,
      );
      instancesByID[String(nextInstanceID)] = created;
      createdAfter.push(cloneValue(created));
    }
    table.nextInstanceSequence = nextInstanceSequence;
    return table;
  });

  for (const removed of removedBefore) {
    emitInstanceChange("removed", removed, null, {
      source: "reconcileUniverseSeededInstances",
    });
  }
  for (const created of createdAfter) {
    emitInstanceChange("created", null, created, {
      source: "reconcileUniverseSeededInstances",
    });
  }

  return {
    desiredCount: normalizedDefinitions.length,
    createdCount: createdAfter.length,
    retainedCount: retainedInstanceIDs.length,
    preservedCount: preservedInstanceIDs.length,
    preservedInstanceIDs,
    replacedCount: replacedInstances,
    removedCount: Math.max(0, removedBefore.length - replacedInstances),
  };
}

function rotateUniversePersistentInstances(rotations = [], options = {}) {
  const normalizedRotations = (Array.isArray(rotations) ? rotations : [])
    .map((entry) => {
      const existingInstance = entry && entry.existingInstance && typeof entry.existingInstance === "object"
        ? cloneValue(entry.existingInstance)
        : null;
      const nextDefinition = entry && entry.nextDefinition && typeof entry.nextDefinition === "object"
        ? cloneValue(entry.nextDefinition)
        : null;
      return {
        existingInstance,
        nextDefinition,
      };
    })
    .filter((entry) => (
      entry.existingInstance &&
      Math.max(0, toInt(entry.existingInstance.instanceID, 0)) > 0 &&
      entry.nextDefinition &&
      normalizeText(entry.nextDefinition.templateID, "") &&
      normalizeText(entry.nextDefinition.siteKey, "")
    ));

  const readyRotations = normalizedRotations.filter(entry =>
    settleEventSiteBeforeRemoval(runtimeState.getInstanceRef(entry.existingInstance.instanceID)));
  normalizedRotations.splice(0, normalizedRotations.length, ...readyRotations);

  if (normalizedRotations.length <= 0) {
    return {
      rotatedCount: 0,
      createdCount: 0,
      removedCount: 0,
    };
  }

  const templatesByID = new Map();
  for (const rotation of normalizedRotations) {
    const templateID = normalizeText(rotation.nextDefinition.templateID, "");
    if (!templatesByID.has(templateID)) {
      templatesByID.set(templateID, requireTemplate(templateID));
    }
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const removedBefore = [];
  const createdAfter = [];

  commitRuntimeStateMutation((table) => {
    const instancesByID = table.instancesByID || {};
    let nextInstanceSequence = Math.max(1, toInt(table.nextInstanceSequence, 1));
    for (const rotation of normalizedRotations) {
      const existingInstanceID = Math.max(0, toInt(rotation.existingInstance.instanceID, 0));
      const existingRaw = instancesByID[String(existingInstanceID)];
      if (!existingRaw) {
        continue;
      }
      const existing = runtimeState.normalizeInstanceRecord({
        ...existingRaw,
        instanceID: toInt(existingRaw && existingRaw.instanceID, existingInstanceID),
      });
      removedBefore.push(cloneValue(existing));
      delete instancesByID[String(existing.instanceID)];

      const template = templatesByID.get(normalizeText(rotation.nextDefinition.templateID, ""));
      if (!template) {
        continue;
      }
      const nextInstanceID = nextInstanceSequence;
      nextInstanceSequence += 1;
      const created = buildInstanceRecordFromOptions(
        nextInstanceID,
        template,
        rotation.nextDefinition,
        nowMs,
      );
      instancesByID[String(nextInstanceID)] = created;
      createdAfter.push(cloneValue(created));
    }
    table.nextInstanceSequence = nextInstanceSequence;
    return table;
  });

  for (const removed of removedBefore) {
    emitInstanceChange("removed", removed, null, {
      source: "rotateUniversePersistentInstances",
    });
  }
  for (const created of createdAfter) {
    emitInstanceChange("created", null, created, {
      source: "rotateUniversePersistentInstances",
    });
  }

  return {
    rotatedCount: createdAfter.length,
    createdCount: createdAfter.length,
    removedCount: removedBefore.length,
  };
}

function activateRoom(instanceID, roomKey, options = {}) {
  const existing = requireInstance(instanceID);
  const normalizedRoomKey = normalizeText(roomKey, "");
  if (!normalizedRoomKey) {
    throw dungeonError("DUNGEON_ROOM_KEY_REQUIRED");
  }
  const roomState = existing.roomStatesByKey && existing.roomStatesByKey[normalizedRoomKey];
  if (!roomState) {
    throw dungeonError("DUNGEON_ROOM_NOT_FOUND", `Unknown dungeon room ${normalizedRoomKey}`);
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return upsertRoomState(instanceID, normalizedRoomKey, {
    state: "active",
    activatedAtMs: roomState.activatedAtMs || nowMs,
    stage: normalizeText(options.stage, roomState.stage || "room"),
    pocketID: options.pocketID != null ? toInt(options.pocketID, 0) || null : roomState.pocketID,
  }, { nowMs });
}

function completeRoom(instanceID, roomKey, options = {}) {
  const existing = requireInstance(instanceID);
  const normalizedRoomKey = normalizeText(roomKey, "");
  if (!normalizedRoomKey) {
    throw dungeonError("DUNGEON_ROOM_KEY_REQUIRED");
  }
  const roomState = existing.roomStatesByKey && existing.roomStatesByKey[normalizedRoomKey];
  if (!roomState) {
    throw dungeonError("DUNGEON_ROOM_NOT_FOUND", `Unknown dungeon room ${normalizedRoomKey}`);
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return upsertRoomState(instanceID, normalizedRoomKey, {
    state: "completed",
    completedAtMs: nowMs,
    stage: normalizeText(options.stage, roomState.stage || "room"),
  }, { nowMs });
}

function unlockGate(instanceID, gateKey, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return upsertGateState(instanceID, gateKey, {
    state: "unlocked",
    unlockedAtMs: nowMs,
    destinationRoomKey:
      options.destinationRoomKey != null
        ? normalizeText(options.destinationRoomKey, "") || null
        : undefined,
  }, { nowMs });
}

function recordGateUse(instanceID, gateKey, options = {}) {
  const existing = requireInstance(instanceID);
  const normalizedGateKey = normalizeText(gateKey, "");
  if (!normalizedGateKey) {
    throw dungeonError("DUNGEON_GATE_KEY_REQUIRED");
  }
  const gateState = existing.gateStatesByKey && existing.gateStatesByKey[normalizedGateKey];
  if (!gateState) {
    throw dungeonError("DUNGEON_GATE_NOT_FOUND", `Unknown dungeon gate ${normalizedGateKey}`);
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return upsertGateState(instanceID, normalizedGateKey, {
    state: normalizeText(options.state, gateState.state || "used"),
    usesCount: Math.max(0, toInt(gateState.usesCount, 0)) + 1,
    lastUsedAtMs: nowMs,
    destinationRoomKey:
      options.destinationRoomKey != null
        ? normalizeText(options.destinationRoomKey, "") || null
        : gateState.destinationRoomKey || null,
  }, { nowMs });
}

function advanceObjective(instanceID, patch = {}, options = {}) {
  const existing = requireInstance(instanceID);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const normalizedPatch = patch && typeof patch === "object" ? cloneValue(patch) : {};
  if (normalizedPatch.completedObjectiveID != null) {
    const completedObjectiveID = Math.max(0, toInt(normalizedPatch.completedObjectiveID, 0));
    delete normalizedPatch.completedObjectiveID;
    const currentCompleted = Array.isArray(existing.objectiveState && existing.objectiveState.completedObjectiveIDs)
      ? existing.objectiveState.completedObjectiveIDs
      : [];
    normalizedPatch.completedObjectiveIDs = [...new Set([
      ...currentCompleted.map((entry) => toInt(entry, 0)).filter((entry) => entry > 0),
      ...(completedObjectiveID > 0 ? [completedObjectiveID] : []),
    ])].sort((left, right) => left - right);
  }
  if (normalizedPatch.completedNodeID != null) {
    const completedNodeID = Math.max(0, toInt(normalizedPatch.completedNodeID, 0));
    delete normalizedPatch.completedNodeID;
    const currentCompleted = Array.isArray(existing.objectiveState && existing.objectiveState.completedNodeIDs)
      ? existing.objectiveState.completedNodeIDs
      : [];
    normalizedPatch.completedNodeIDs = [...new Set([
      ...currentCompleted.map((entry) => toInt(entry, 0)).filter((entry) => entry > 0),
      ...(completedNodeID > 0 ? [completedNodeID] : []),
    ])].sort((left, right) => left - right);
  }
  if (!normalizedPatch.state) {
    normalizedPatch.state = "in_progress";
  }
  const nextObjectiveState = {
    ...(existing.objectiveState && typeof existing.objectiveState === "object"
      ? existing.objectiveState
      : {}),
    ...normalizedPatch,
  };
  if (
    isDeepStrictEqual(
      cloneObjectiveStateForComparison(existing.objectiveState),
      cloneObjectiveStateForComparison(nextObjectiveState),
    )
  ) {
    return existing;
  }
  if (!normalizedPatch.metadata || typeof normalizedPatch.metadata !== "object") {
    normalizedPatch.metadata = {};
  }
  normalizedPatch.metadata.lastAdvancedAtMs = nowMs;
  return mergeObjectiveState(instanceID, normalizedPatch, { nowMs });
}

function upsertRoomState(instanceID, roomKey, patch = {}, options = {}) {
  const existing = requireInstance(instanceID);
  const normalizedRoomKey = normalizeText(roomKey, "");
  if (!normalizedRoomKey) {
    throw dungeonError("DUNGEON_ROOM_KEY_REQUIRED");
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));

  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    target.roomStatesByKey = target.roomStatesByKey || {};
    target.roomStatesByKey[normalizedRoomKey] = {
      ...(target.roomStatesByKey[normalizedRoomKey] || {}),
      ...(patch && typeof patch === "object" ? cloneValue(patch) : {}),
      roomKey: normalizedRoomKey,
      lastUpdatedAtMs: nowMs,
    };
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  });

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: "upsertRoomState",
    roomKey: normalizedRoomKey,
  });
  return updated;
}

function upsertGateState(instanceID, gateKey, patch = {}, options = {}) {
  const existing = requireInstance(instanceID);
  const normalizedGateKey = normalizeText(gateKey, "");
  if (!normalizedGateKey) {
    throw dungeonError("DUNGEON_GATE_KEY_REQUIRED");
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));

  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    target.gateStatesByKey = target.gateStatesByKey || {};
    target.gateStatesByKey[normalizedGateKey] = {
      ...(target.gateStatesByKey[normalizedGateKey] || {}),
      ...(patch && typeof patch === "object" ? cloneValue(patch) : {}),
      gateKey: normalizedGateKey,
      lastUsedAtMs:
        patch && patch.lastUsedAtMs != null
          ? Math.max(0, toInt(patch.lastUsedAtMs, nowMs))
          : (
            target.gateStatesByKey[normalizedGateKey] &&
            target.gateStatesByKey[normalizedGateKey].lastUsedAtMs
          ) || 0,
    };
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  });

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: "upsertGateState",
    gateKey: normalizedGateKey,
  });
  return updated;
}

function mergeObjectiveState(instanceID, patch = {}, options = {}) {
  const existing = requireInstance(instanceID);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));

  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    target.objectiveState = {
      ...(target.objectiveState || {}),
      ...(patch && typeof patch === "object" ? cloneValue(patch) : {}),
    };
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  });

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: "mergeObjectiveState",
  });
  return updated;
}

function setLifecycleState(instanceID, lifecycleState, options = {}) {
  const existing = requireInstance(instanceID);
  const normalizedLifecycleState = normalizeText(lifecycleState, "").toLowerCase();
  if (!normalizedLifecycleState) {
    throw dungeonError("DUNGEON_LIFECYCLE_STATE_REQUIRED");
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    target.lifecycleState = normalizedLifecycleState;
    target.lifecycleReason = normalizeText(options.lifecycleReason, "") || target.lifecycleReason || null;
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    if (normalizedLifecycleState === "active" && !target.timers.activatedAtMs) {
      target.timers.activatedAtMs = nowMs;
    }
    if (normalizedLifecycleState === "completed") {
      target.timers.completedAtMs = Math.max(0, toInt(options.completedAtMs, nowMs));
    }
    if (normalizedLifecycleState === "failed") {
      target.timers.failedAtMs = Math.max(0, toInt(options.failedAtMs, nowMs));
    }
    if (normalizedLifecycleState === "despawned") {
      target.timers.despawnAtMs = Math.max(0, toInt(options.despawnAtMs, nowMs));
    }
    if (options.expiresAtMs != null) {
      target.timers.expiresAtMs = Math.max(0, toInt(options.expiresAtMs, 0));
    }
    return table;
  });

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: "setLifecycleState",
  });
  return updated;
}

// Mark a site instance's objective as explicitly satisfied (idempotent). The completion check
// (dungeonUniverseSiteService.isEncounterCompletionSatisfied) treats this as done regardless of
// remaining encounters — the setter for non-kill objective modes: interactable objects (approach/
// hack/destroy) and mining quantity reached. Encounter-clear remains the fallback when unset.
function markInstanceObjectiveSatisfied(instanceID, options = {}) {
  const existing = requireInstance(instanceID);
  if (Math.max(0, toInt(existing.objectiveSatisfiedAtMs, 0)) > 0) {
    return existing;
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    const reason = normalizeText(options.reason, "") || null;
    target.objectiveSatisfiedAtMs = nowMs;
    target.objectiveSatisfiedReason = reason;
    target.metadata =
      target.metadata && typeof target.metadata === "object" && !Array.isArray(target.metadata)
        ? target.metadata
        : {};
    target.metadata.objectiveSatisfiedAtMs = nowMs;
    target.metadata.objectiveSatisfiedReason = reason;
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  });
  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: "markInstanceObjectiveSatisfied",
  });
  return updated;
}

function purgeInstance(instanceID) {
  const existing = requireInstance(instanceID);
  require("../seasons/eventHooks").depot.beforePurge(existing);
  require("../seasons/eventHooks").fabricator.beforePurge(existing);
  require("../exploration/hackingContainerState").beforePurge(existing);
  require("./siteHazardOutcomes").beforePurge(existing);
  commitRuntimeStateMutation((table) => {
    delete table.instancesByID[String(existing.instanceID)];
    return table;
  });
  emitInstanceChange("removed", existing, null, {
    source: "purgeInstance",
  });
  return true;
}

function purgeInstances(instanceIDs = [], options = {}) {
  const normalizedInstanceIDs = [...new Set((Array.isArray(instanceIDs) ? instanceIDs : [instanceIDs])
    .map((entry) => Math.max(0, toInt(entry, 0)))
    .filter((entry) => entry > 0))];
  if (normalizedInstanceIDs.length <= 0) {
    return {
      removedCount: 0,
      removedInstanceIDs: [],
    };
  }

  const readyIDs = normalizedInstanceIDs.filter(id => settleEventSiteBeforeRemoval(runtimeState.getInstanceRef(id)));
  normalizedInstanceIDs.splice(0, normalizedInstanceIDs.length, ...readyIDs);
  const removed = [];
  commitRuntimeStateMutation((table) => {
    const instancesByID = table.instancesByID || {};
    for (const instanceID of normalizedInstanceIDs) {
      const rawInstance = instancesByID[String(instanceID)];
      if (!rawInstance) {
        continue;
      }
      const instance = runtimeState.normalizeInstanceRecord({
        ...rawInstance,
        instanceID: toInt(rawInstance && rawInstance.instanceID, instanceID),
      });
      removed.push(cloneValue(instance));
      delete instancesByID[String(instance.instanceID)];
    }
    return table;
  });

  const source = normalizeText(options.source, "purgeInstances");
  for (const instance of removed) {
    emitInstanceChange("removed", instance, null, { source });
  }

  return {
    removedCount: removed.length,
    removedInstanceIDs: removed.map((instance) => instance.instanceID),
  };
}

function purgeShadowProviderInstances(options = {}) {
  const providerFilter = normalizeText(options.providerID, "").toLowerCase() || null;
  const siteFamilyFilter = normalizeText(options.siteFamily, "").toLowerCase() || null;
  const siteOriginFilter = normalizeText(options.siteOrigin, "").toLowerCase() || null;
  const removed = [];
  const retainedInstanceIDs = new Set();
  // Resolve reward carriers outside the dungeon mutation. Reward owners may
  // themselves persist state and must not run inside its copy-on-write pass.
  for (const instance of Object.values(runtimeState.loadState().instancesByID || {})) {
    if (instance.runtimeFlags?.shadowProviderSite === true && !settleEventSiteBeforeRemoval(instance)) {
      retainedInstanceIDs.add(instance.instanceID);
    }
  }

  commitRuntimeStateMutation((table) => {
    const instancesByID = table.instancesByID || {};
    for (const [instanceID, rawInstance] of Object.entries(instancesByID)) {
      if (retainedInstanceIDs.has(toInt(instanceID, 0))) continue;
      const instance = runtimeState.normalizeInstanceRecord({
        ...rawInstance,
        instanceID: toInt(rawInstance && rawInstance.instanceID, toInt(instanceID, 0)),
      });
      if (!(instance.runtimeFlags && instance.runtimeFlags.shadowProviderSite === true)) {
        continue;
      }
      if (
        providerFilter &&
        normalizeText(instance && instance.metadata && instance.metadata.providerID, "").toLowerCase() !== providerFilter
      ) {
        continue;
      }
      if (siteFamilyFilter && normalizeText(instance.siteFamily, "").toLowerCase() !== siteFamilyFilter) {
        continue;
      }
      if (siteOriginFilter && normalizeText(instance.siteOrigin, "").toLowerCase() !== siteOriginFilter) {
        continue;
      }
      removed.push(cloneValue(instance));
      delete instancesByID[String(instance.instanceID)];
    }
    return table;
  });

  for (const instance of removed) {
    emitInstanceChange("removed", instance, null, {
      source: "purgeShadowProviderInstances",
    });
  }

  return {
    removedCount: removed.length,
    removedInstanceIDs: removed.map((instance) => instance.instanceID),
  };
}

function getInstance(instanceID) {
  return runtimeState.getInstanceSnapshot(instanceID);
}


function getPersistedInstance(instanceID) {
  const result = runtimeState.readPersistedInstanceSnapshot(instanceID);
  if (!result || result.success !== true) {
    throw dungeonError(
      "DUNGEON_DURABLE_READ_FAILED",
      String(result && result.errorMsg || "DUNGEON_DURABLE_READ_FAILED"),
    );
  }
  return result.data ? cloneValue(result.data) : null;
}

// Live cache entry, not a copy. See runtimeState.getInstanceRef: read-only, and
// only for callers that drop the record instead of mutating or retaining it.
function getInstanceRef(instanceID) {
  return runtimeState.getInstanceRef(instanceID);
}

function getInstanceSummary(instanceID) {
  return runtimeState.getInstanceSummary(instanceID);
}

function isPrivateMissionInstance(instance) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    return false;
  }
  const ownership = normalizeObject(instance.ownership);
  const isPrivate =
    normalizeText(instance.instanceScope, "").toLowerCase() === "private" ||
    normalizeText(ownership.visibilityScope, "").toLowerCase() === "private";
  const isMission =
    normalizeText(instance.siteKind, "").toLowerCase() === "mission" ||
    normalizeObject(instance.runtimeFlags).missionRuntime === true ||
    normalizeObject(instance.metadata).missionRuntime === true;
  return isPrivate && isMission;
}

// A private mission remains undiscoverable through the normal dungeon/signature
// listings.  Once a character has independently acquired a valid route to the
// pocket (for example, a fleet member or a perfect combat-probe result), record
// that character explicitly so the ordinary visibility and gate checks can be
// used for the rest of the instance lifetime.
function grantCharacterMissionAccess(instanceID, characterID, options = {}) {
  const existing = requireInstance(instanceID);
  const normalizedCharacterID = Math.max(0, toInt(characterID, 0));
  if (
    normalizedCharacterID <= 0 ||
    !runtimeState.isActiveLifecycleState(existing.lifecycleState) ||
    !isPrivateMissionInstance(existing)
  ) {
    return null;
  }

  const existingOwnership = normalizeOwnership(existing.ownership);
  if (
    [existingOwnership.characterID, existingOwnership.missionOwnerCharacterID]
      .some((ownerID) => Math.max(0, toInt(ownerID, 0)) === normalizedCharacterID) ||
    existingOwnership.sharedWithCharacterIDs.includes(normalizedCharacterID)
  ) {
    return existing;
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const source = normalizeText(options.source, "acquired").toLowerCase();
  runtimeState.mutateState((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target || !isPrivateMissionInstance(target)) {
      return table;
    }
    const ownership = normalizeOwnership(target.ownership);
    ownership.sharedWithCharacterIDs = [...new Set([
      ...ownership.sharedWithCharacterIDs,
      normalizedCharacterID,
    ])].sort((left, right) => left - right);
    ownership.metadata = {
      ...normalizeObject(ownership.metadata),
      accessGrantsByCharacterID: {
        ...normalizeObject(
          ownership.metadata && ownership.metadata.accessGrantsByCharacterID,
        ),
        [String(normalizedCharacterID)]: {
          grantedAtMs: nowMs,
          source,
        },
      },
    };
    target.ownership = ownership;
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  });

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    characterID: normalizedCharacterID,
    source: `access:${source}`,
  });
  return updated;
}

function findInstanceBySiteKey(siteKey, options = {}) {
  const summary = runtimeState.findInstanceSummaryBySiteKey(siteKey);
  if (!summary) {
    return null;
  }
  if (
    options.activeOnly === true &&
    !runtimeState.isActiveLifecycleState(summary.lifecycleState)
  ) {
    return null;
  }
  return options.full === true
    ? runtimeState.getInstanceSnapshot(summary.instanceID)
    : summary;
}

function listInstancesBySystem(solarSystemID, options = {}) {
  const summaries = runtimeState.listInstanceSummariesBySystem(solarSystemID, options);
  if (options.full !== true) {
    return summaries;
  }
  return summaries
    .map((summary) => runtimeState.getInstanceSnapshot(summary.instanceID))
    .filter(Boolean);
}

function listActiveInstancesBySystem(solarSystemID, options = {}) {
  return listInstancesBySystem(solarSystemID, {
    ...options,
    activeOnly: true,
  });
}

function listInstancesByTemplate(templateID, options = {}) {
  const summaries = runtimeState.listInstanceSummariesByTemplate(templateID, options);
  if (options.full !== true) {
    return summaries;
  }
  return summaries
    .map((summary) => runtimeState.getInstanceSnapshot(summary.instanceID))
    .filter(Boolean);
}

function listInstancesByFamily(siteFamily, options = {}) {
  const summaries = runtimeState.listInstanceSummariesByFamily(siteFamily, options);
  if (options.full !== true) {
    return summaries;
  }
  return summaries
    .map((summary) => runtimeState.getInstanceSnapshot(summary.instanceID))
    .filter(Boolean);
}

function listInstancesByLifecycle(lifecycleState, options = {}) {
  const summaries = runtimeState.listInstanceSummariesByLifecycle(lifecycleState, options);
  if (options.full !== true) {
    return summaries;
  }
  return summaries
    .map((summary) => runtimeState.getInstanceSnapshot(summary.instanceID))
    .filter(Boolean);
}

function mergeStateField(instanceID, fieldName, patch = {}, options = {}) {
  const existing = requireInstance(instanceID);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const normalizedPatch = patch && typeof patch === "object" ? cloneValue(patch) : {};

  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    target[fieldName] = {
      ...(target[fieldName] && typeof target[fieldName] === "object" ? target[fieldName] : {}),
      ...normalizedPatch,
    };
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  }, options.durable === true
    ? {
        durable: true,
        force: options.force === true || options.forceWrite === true,
        forceInstanceID: existing.instanceID,
      }
    : {});

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: `merge:${fieldName}`,
  });
  return updated;
}

function mergeHazardState(instanceID, patch = {}, options = {}) {
  return mergeStateField(instanceID, "hazardState", patch, options);
}

function mergeEnvironmentState(instanceID, patch = {}, options = {}) {
  return mergeStateField(instanceID, "environmentState", patch, options);
}

function mergeEnvironmentStateDurably(instanceID, patch = {}, options = {}) {
  return mergeStateField(instanceID, "environmentState", patch, {
    ...options,
    durable: true,
  });
}

function mergeSpawnState(instanceID, patch = {}, options = {}) {
  return mergeStateField(instanceID, "spawnState", patch, options);
}

function synchronizeInstancePosition(instanceID, position, options = {}) {
  const existing = requireInstance(instanceID);
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const normalizedPosition = normalizePosition(position);

  commitRuntimeStateMutation((table) => {
    const target = table.instancesByID[String(existing.instanceID)];
    if (!target) {
      return table;
    }
    target.position = normalizedPosition;
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    return table;
  });

  const updated = runtimeState.getInstanceSnapshot(existing.instanceID);
  emitInstanceChange("updated", existing, updated, {
    source: "synchronizeInstancePosition",
  });
  return updated;
}

function tickRuntime(options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const emitChanges = options.emitChanges !== false;
  const hasSystemFilter = Array.isArray(options.systemIDs);
  const targetedSystemIDs = hasSystemFilter
    ? [...new Set(options.systemIDs
      .map((entry) => Math.max(0, toInt(entry, 0)))
      .filter((entry) => entry > 0))]
    : null;
  if (hasSystemFilter && targetedSystemIDs.length <= 0) {
    return {
      expiredCount: 0,
      expiredInstanceIDs: [],
      nextExpiryAtMs: runtimeState.getNextActiveExpiryAtMs(),
    };
  }
  const universePersistentOnly = options.universePersistentOnly === true;
  const excludeUniversePersistent = options.excludeUniversePersistent === true;
  const nextExpiryAtMs = runtimeState.getNextActiveExpiryAtMs({
    universePersistentOnly,
  });
  if (nextExpiryAtMs <= 0 || nextExpiryAtMs > nowMs) {
    return {
      expiredCount: 0,
      expiredInstanceIDs: [],
      nextExpiryAtMs,
    };
  }

  const expiredSummaries = runtimeState.listExpiredActiveInstanceSummaries(nowMs, {
    excludeUniversePersistent,
    systemIDs: hasSystemFilter ? targetedSystemIDs : undefined,
    universePersistentOnly,
  });

  if (expiredSummaries.length <= 0) {
    return {
      expiredCount: 0,
      expiredInstanceIDs: [],
      nextExpiryAtMs,
    };
  }

  const beforeByID = emitChanges
    ? new Map(
      expiredSummaries.map((summary) => [summary.instanceID, runtimeState.getInstanceSnapshot(summary.instanceID)]),
    )
    : null;
  const expiredInstanceIDs = [];
  commitRuntimeStateMutation((table) => {
    for (const summary of expiredSummaries) {
      const target = table.instancesByID[String(summary.instanceID)];
      if (!target) {
        continue;
      }
      target.lifecycleState = "despawned";
      target.lifecycleReason =
        normalizeText(options.lifecycleReason, "") ||
        normalizeText(target.lifecycleReason, "") ||
        "expired";
      target.timers = target.timers || {};
      target.timers.lastUpdatedAtMs = nowMs;
      target.timers.despawnAtMs = Math.max(
        0,
        toInt(target.timers.despawnAtMs, 0),
        nowMs,
      );
      expiredInstanceIDs.push(summary.instanceID);
    }
    return table;
  });

  if (emitChanges) {
    for (const instanceID of expiredInstanceIDs) {
      emitInstanceChange(
        "updated",
        beforeByID.get(instanceID) || null,
        runtimeState.getInstanceSnapshot(instanceID),
        {
          source: "tickRuntime",
          transition: "expired",
        },
      );
    }
  }

  return {
    expiredCount: expiredInstanceIDs.length,
    expiredInstanceIDs,
    nextExpiryAtMs,
  };
}

function listUniversePersistentTerminalInstances(options = {}) {
  const instanceIDs = runtimeState.listUniversePersistentTerminalInstanceIDs();
  const full = options.full === true;
  return instanceIDs
    .map((instanceID) => (full ? getInstance(instanceID) : getInstanceSummary(instanceID)))
    .filter(Boolean);
}

function startTicker(options = {}) {
  if (runtimeTicker) {
    return runtimeTicker;
  }
  const intervalMs = Math.max(250, toInt(options.intervalMs, 1000));
  runtimeTicker = setInterval(() => {
    const systemIDs = typeof options.systemIDsProvider === "function"
      ? options.systemIDsProvider()
      : options.systemIDs;
    tickRuntime({
      excludeUniversePersistent: true,
      systemIDs: Array.isArray(systemIDs) ? systemIDs : undefined,
    });
  }, intervalMs);
  if (typeof runtimeTicker.unref === "function") {
    runtimeTicker.unref();
  }
  return runtimeTicker;
}

function stopTicker() {
  if (runtimeTicker) {
    clearInterval(runtimeTicker);
    runtimeTicker = null;
  }
}

function clearRuntimeCache() {
  runtimeState.clearRuntimeCache();
}

function resetRuntimeForTests() {
  stopTicker();
  runtimeState.resetRuntimeStateForTests();
}

module.exports = {
  clearRuntimeCache,
  createInstance,
  activateRoom,
  advanceObjective,
  completeRoom,
  ensureTemplateRuntimeState,
  findInstanceBySiteKey,
  grantCharacterMissionAccess,
  getInstance,
  getPersistedInstance,
  getInstanceRef,
  getInstanceSummary,
  listActiveInstancesBySystem,
  listInstancesByLifecycle,
  listInstancesByFamily,
  listInstancesBySystem,
  listInstancesByTemplate,
  listUniversePersistentTerminalInstances,
  mergeEnvironmentState,
  mergeEnvironmentStateDurably,
  mergeHazardState,
  mergeObjectiveState,
  mergeSpawnState,
  peekNextInstanceID,
  purgeInstance,
  purgeInstances,
  purgeShadowProviderInstances,
  registerInstanceChangeListener,
  reconcileUniverseSeededInstances,
  rotateUniversePersistentInstances,
  recordGateUse,
  resetRuntimeForTests,
  startTicker,
  setLifecycleState,
  markInstanceObjectiveSatisfied,
  stopTicker,
  synchronizeInstancePosition,
  tickRuntime,
  unlockGate,
  unregisterInstanceChangeListener,
  upsertGateState,
  upsertRoomState,
};
