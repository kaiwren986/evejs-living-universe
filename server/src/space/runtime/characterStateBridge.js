"use strict";

module.exports = {
  getCharacterStateService,
  resolveActiveShipRecord,
  resolveCharacterRecord,
  resolveCharacterRecordReadOnly,
  resolveChargeDogmaPrimeEntry,
  syncInventoryChangesToSession,
};

const {
  lazyRequire,
} = require("./runtimeModuleBoundary");

function getCharacterStateService() {
  return lazyRequire("../services/character/characterState");
}

function resolveCharacterRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function resolveCharacterRecordReadOnly(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.readSharedCharacterRecord === "function"
    ? characterState.readSharedCharacterRecord(characterID)
    : null;
}

function resolveActiveShipRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getActiveShipRecord === "function"
    ? characterState.getActiveShipRecord(characterID)
    : null;
}

function resolveChargeDogmaPrimeEntry(item, options = {}) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.buildChargeDogmaPrimeEntry === "function"
    ? characterState.buildChargeDogmaPrimeEntry(item, options)
    : null;
}

function syncInventoryChangesToSession(session, changes = []) {
  const characterState = getCharacterStateService();
  if (
    !session ||
    !characterState ||
    typeof characterState.syncInventoryItemForSession !== "function"
  ) {
    return;
  }

  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    characterState.syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: true,
      },
    );
  }
}
