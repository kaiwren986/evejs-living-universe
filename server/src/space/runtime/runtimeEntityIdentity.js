"use strict";

module.exports = {
  allocateRuntimeEntityID,
  applyRuntimeEntitySpawnMetadata,
};

const state = require("./state");
const {
  toInt,
} = require("../../common/numbers");

function applyRuntimeEntitySpawnMetadata(entity, metadata = null) {
  if (!entity || !metadata || typeof metadata !== "object") return entity;
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    entity[key] = value && typeof value === "object"
      ? structuredClone(value)
      : value;
  }
  return entity;
}

function allocateRuntimeEntityID(preferredItemID = null) {
  const numericPreferred = toInt(preferredItemID, 0);
  if (numericPreferred > 0) {
    state.nextRuntimeEntityID = Math.max(state.nextRuntimeEntityID, numericPreferred + 1);
    return numericPreferred;
  }

  const allocated = state.nextRuntimeEntityID;
  state.nextRuntimeEntityID += 1;
  return allocated;
}
