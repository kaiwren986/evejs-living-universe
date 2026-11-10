"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

// Persisted R&D projects, one per (character, research agent).
//
// The record mirrors the shape CCP themselves persist and publish through ESI
// (GET /characters/{id}/agents_research): agent_id, skill_type_id, started_at,
// points_per_day, remainder_points. Points are therefore NOT ticked -- they are
// banked into remainderPoints at each re-anchor and accrue from startedAtMs at
// pointsPerDay in between, which is what lets them "accrue whether you are logged
// on or not" across downtime.

const path = require("path");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));

const repo = createTableRepository("service:agent", { strict: true });

const RESEARCH_RUNTIME_TABLE = "researchRuntimeState";

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  const normalized = Math.trunc(numericValue);
  return normalized > 0 ? normalized : fallback;
}

function createDefaultState() {
  return {
    version: 1,
    charactersByID: {},
  };
}

function createDefaultCharacterState(characterID) {
  return {
    characterID: toPositiveInteger(characterID, 0),
    projectsByAgentID: {},
    nextPurchaseSequence: 1,
  };
}

function normalizeProject(rawProject, agentID) {
  const normalizedAgentID = toPositiveInteger(agentID, 0);
  const source = rawProject && typeof rawProject === "object" ? rawProject : {};
  return {
    agentID: normalizedAgentID,
    skillTypeID: toPositiveInteger(source.skillTypeID, 0),
    startedAtMs: toPositiveInteger(source.startedAtMs, 0),
    remainderPoints: Math.max(0, toFiniteNumber(source.remainderPoints, 0)),
    pointsPerDay: Math.max(0, toFiniteNumber(source.pointsPerDay, 0)),
    // When the next optional mission may be offered. The agent offers one a day,
    // with a 12-23h cool-down after each completion.
    missionAvailableAtMs: Math.max(0, toPositiveInteger(source.missionAvailableAtMs, 0)),
    // A datacore purchase that has had its research points taken but has not yet
    // been settled in ISK and items. Written before any side effect so a crash
    // mid-purchase can be finished with the same idempotency keys instead of
    // charging twice or granting twice.
    pendingPurchase: normalizePendingPurchase(source.pendingPurchase),
  };
}

function normalizePendingPurchase(rawPurchase) {
  if (!rawPurchase || typeof rawPurchase !== "object") {
    return null;
  }
  const sequence = toPositiveInteger(rawPurchase.sequence, 0);
  const quantity = toPositiveInteger(rawPurchase.quantity, 0);
  const datacoreTypeID = toPositiveInteger(rawPurchase.datacoreTypeID, 0);
  const locationID = toPositiveInteger(rawPurchase.locationID, 0);
  if (!sequence || !quantity || !datacoreTypeID || !locationID) {
    return null;
  }
  return {
    sequence,
    quantity,
    datacoreTypeID,
    locationID,
    researchPointCost: Math.max(0, toFiniteNumber(rawPurchase.researchPointCost, 0)),
    iskCost: Math.max(0, toFiniteNumber(rawPurchase.iskCost, 0)),
    // Settlement bookkeeping: how often the ISK and item legs have been tried, and
    // when, so a wallet that is unreachable is retried on a timer rather than on
    // every read.
    attempts: Math.max(0, Math.trunc(toFiniteNumber(rawPurchase.attempts, 0))),
    lastAttemptAtMs: toPositiveInteger(rawPurchase.lastAttemptAtMs, 0),
  };
}

function ensureCharacterState(state, characterID) {
  const key = String(toPositiveInteger(characterID, 0));
  const existing = state.charactersByID[key];
  if (!existing || typeof existing !== "object") {
    state.charactersByID[key] = createDefaultCharacterState(characterID);
    return state.charactersByID[key];
  }

  existing.characterID =
    toPositiveInteger(existing.characterID, 0) || toPositiveInteger(characterID, 0);
  if (!existing.projectsByAgentID || typeof existing.projectsByAgentID !== "object") {
    existing.projectsByAgentID = {};
  }
  if (toPositiveInteger(existing.nextPurchaseSequence, 0) <= 0) {
    existing.nextPurchaseSequence = 1;
  }
  for (const agentID of Object.keys(existing.projectsByAgentID)) {
    existing.projectsByAgentID[agentID] = normalizeProject(
      existing.projectsByAgentID[agentID],
      agentID,
    );
  }
  return existing;
}

function getMutableState() {
  const result = repo.read(RESEARCH_RUNTIME_TABLE, "/");
  let state =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : null;

  if (!state) {
    state = createDefaultState();
    repo.write(RESEARCH_RUNTIME_TABLE, "/", state);
    return state;
  }

  let mutated = false;
  if (toPositiveInteger(state.version, 0) !== 1) {
    state.version = 1;
    mutated = true;
  }
  if (!state.charactersByID || typeof state.charactersByID !== "object") {
    state.charactersByID = {};
    mutated = true;
  }
  for (const characterID of Object.keys(state.charactersByID)) {
    const before = JSON.stringify(state.charactersByID[characterID]);
    ensureCharacterState(state, characterID);
    if (JSON.stringify(state.charactersByID[characterID]) !== before) {
      mutated = true;
    }
  }

  if (mutated) {
    repo.write(RESEARCH_RUNTIME_TABLE, "/", state);
  }
  return state;
}

function mutateState(mutator) {
  const state = getMutableState();
  const result = typeof mutator === "function" ? mutator(state) : state;
  const writeResult = repo.write(RESEARCH_RUNTIME_TABLE, "/", state);
  if (!writeResult || writeResult.success === false) {
    return {
      success: false,
      errorMsg: (writeResult && writeResult.errorMsg) || "WRITE_FAILED",
    };
  }
  return { success: true, data: cloneValue(result) };
}

function listProjects(characterID) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return [];
  }
  const state = getMutableState();
  const characterState = state.charactersByID[String(normalizedCharacterID)];
  if (!characterState || typeof characterState !== "object") {
    return [];
  }
  return Object.entries(characterState.projectsByAgentID || {})
    .map(([agentID, project]) => normalizeProject(project, agentID))
    .filter((project) => project.agentID > 0 && project.skillTypeID > 0)
    .sort((left, right) => left.agentID - right.agentID);
}

function getProject(characterID, agentID) {
  const normalizedAgentID = toPositiveInteger(agentID, 0);
  return (
    listProjects(characterID).find(
      (project) => project.agentID === normalizedAgentID,
    ) || null
  );
}

function countProjects(characterID) {
  return listProjects(characterID).length;
}

function saveProject(characterID, project) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  const normalizedProject = normalizeProject(project, project && project.agentID);
  if (!normalizedCharacterID || !normalizedProject.agentID) {
    return { success: false, errorMsg: "RESEARCH_PROJECT_INVALID" };
  }
  return mutateState((state) => {
    const characterState = ensureCharacterState(state, normalizedCharacterID);
    characterState.projectsByAgentID[String(normalizedProject.agentID)] =
      normalizedProject;
    return normalizedProject;
  });
}

// "All points will be lost when the connection is broken." Cancelling drops the
// record outright; there is nothing to carry forward.
function deleteProject(characterID, agentID) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  const normalizedAgentID = toPositiveInteger(agentID, 0);
  if (!normalizedCharacterID || !normalizedAgentID) {
    return { success: false, errorMsg: "RESEARCH_PROJECT_INVALID" };
  }
  return mutateState((state) => {
    const characterState = ensureCharacterState(state, normalizedCharacterID);
    delete characterState.projectsByAgentID[String(normalizedAgentID)];
    return true;
  });
}

// Monotonic per character, so a datacore purchase can carry a stable idempotency
// key into item custody and survive a crash mid-settlement without double-granting.
function claimPurchaseSequence(characterID) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return 0;
  }
  let claimed = 0;
  mutateState((state) => {
    const characterState = ensureCharacterState(state, normalizedCharacterID);
    claimed = toPositiveInteger(characterState.nextPurchaseSequence, 1);
    characterState.nextPurchaseSequence = claimed + 1;
    return claimed;
  });
  return claimed;
}

function resetCharacterState(characterID) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return { success: false, errorMsg: "RESEARCH_PROJECT_INVALID" };
  }
  return mutateState((state) => {
    delete state.charactersByID[String(normalizedCharacterID)];
    return true;
  });
}

module.exports = {
  RESEARCH_RUNTIME_TABLE,
  claimPurchaseSequence,
  countProjects,
  normalizePendingPurchase,
  deleteProject,
  getProject,
  listProjects,
  normalizeProject,
  resetCharacterState,
  saveProject,
};
