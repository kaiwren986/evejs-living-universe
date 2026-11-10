"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  currentFileTime,
  normalizeBigInt,
  normalizeNumber,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const CHARACTER_ENERGY_STATE_TABLE = "characterEnergyState";
const CHARACTER_ENERGY_STATE_VERSION = 1;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCharacterID(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : 0;
}

function characterPath(characterID) {
  return `/characters/${String(characterID)}`;
}

function normalizeStorageTimestamp(value) {
  return normalizeBigInt(value, currentFileTime()).toString();
}

function normalizeStorageState(rawState = {}) {
  const source = rawState && typeof rawState === "object" ? rawState : {};
  return {
    energyLevel: normalizeNumber(
      source.energyLevel ?? source._energyLevel,
      0,
    ),
    lastRechargeTickTimestamp: normalizeStorageTimestamp(
      source.lastRechargeTickTimestamp ?? source._lastRechargeTickTimestamp,
    ),
    energyIncreasePerRechargeTick: normalizeNumber(
      source.energyIncreasePerRechargeTick ??
        source._energyIncreasePerRechargeTick,
      4.4,
    ),
    rechargeTickPeriod: normalizeNumber(
      source.rechargeTickPeriod ?? source._rechargeTickPeriod,
      3600,
    ),
    minEnergyLevel: normalizeNumber(
      source.minEnergyLevel ?? source._minEnergyLevel,
      0,
    ),
    quiescentEnergyLevel: normalizeNumber(
      source.quiescentEnergyLevel ?? source._quiescentEnergyLevel,
      100,
    ),
    updatedAtFiletime: currentFileTime().toString(),
  };
}

function readCharacterEnergyTable() {
  const result = database.read(CHARACTER_ENERGY_STATE_TABLE, "/");
  if (result.success && result.data && typeof result.data === "object") {
    return cloneValue({
      _meta: {
        version: CHARACTER_ENERGY_STATE_VERSION,
        ...(result.data._meta && typeof result.data._meta === "object"
          ? result.data._meta
          : {}),
      },
      characters:
        result.data.characters && typeof result.data.characters === "object"
          ? result.data.characters
          : {},
    });
  }

  return {
    _meta: {
      version: CHARACTER_ENERGY_STATE_VERSION,
    },
    characters: {},
  };
}

function readCharacterEnergyState(characterID) {
  const normalizedCharacterID = normalizeCharacterID(characterID);
  if (!normalizedCharacterID) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }

  const result = database.read(
    CHARACTER_ENERGY_STATE_TABLE,
    characterPath(normalizedCharacterID),
  );
  if (!result.success) {
    return result.errorMsg === "ENTRY_NOT_FOUND"
      ? { success: true, data: null }
      : { success: false, errorMsg: result.errorMsg || "READ_ERROR" };
  }
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return { success: false, errorMsg: "INVALID_CHARACTER_ENERGY_STATE" };
  }
  return { success: true, data: cloneValue(result.data) };
}

function getCharacterEnergyState(characterID) {
  const result = readCharacterEnergyState(characterID);
  return result.success ? result.data : null;
}

function writeCharacterEnergyState(characterID, rawState) {
  const normalizedCharacterID = normalizeCharacterID(characterID);
  if (!normalizedCharacterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const writeMetaResult = database.write(
    CHARACTER_ENERGY_STATE_TABLE,
    "/_meta/version",
    CHARACTER_ENERGY_STATE_VERSION,
  );
  if (!writeMetaResult || !writeMetaResult.success) {
    return {
      success: false,
      errorMsg: writeMetaResult && writeMetaResult.errorMsg
        ? writeMetaResult.errorMsg
        : "WRITE_ERROR",
    };
  }

  const writeResult = database.write(
    CHARACTER_ENERGY_STATE_TABLE,
    characterPath(normalizedCharacterID),
    normalizeStorageState(rawState),
  );
  if (!writeResult || !writeResult.success) {
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg
        ? writeResult.errorMsg
        : "WRITE_ERROR",
    };
  }

  return {
    success: true,
  };
}

function restoreCharacterEnergyState(characterID, previous) {
  const id = normalizeCharacterID(characterID);
  if (!id) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  const restored = previous === null
    ? database.remove(CHARACTER_ENERGY_STATE_TABLE, characterPath(id))
    : database.write(CHARACTER_ENERGY_STATE_TABLE, characterPath(id), cloneValue(previous), { force: true });
  if (!restored.success && restored.errorMsg !== "ENTRY_NOT_FOUND") return restored;
  return database.flushTableSync(CHARACTER_ENERGY_STATE_TABLE);
}

function flushCharacterEnergyState() {
  return database.flushTableSync(CHARACTER_ENERGY_STATE_TABLE);
}

module.exports = {
  CHARACTER_ENERGY_STATE_TABLE,
  readCharacterEnergyTable,
  readCharacterEnergyState,
  getCharacterEnergyState,
  writeCharacterEnergyState,
  restoreCharacterEnergyState,
  flushCharacterEnergyState,
};
