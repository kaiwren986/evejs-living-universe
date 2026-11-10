"use strict";

// Frozen normalized records are shared only with audited read-only callers.
// Public getCharacterRecord still returns a private JSON clone as before.
const entries = new Map();

function freezeRecord(record) {
  function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  }
  return freeze(JSON.parse(JSON.stringify(record)));
}

function readCachedCharacterRecord(characterID, rawRecord, inputVersion) {
  const entry = entries.get(String(characterID));
  return entry && entry.rawRecord === rawRecord && entry.inputVersion === inputVersion
    ? entry.record : null;
}

function rememberCharacterRecord(characterID, rawRecord, inputVersion, normalizedRecord) {
  const record = freezeRecord(normalizedRecord);
  entries.set(String(characterID), { rawRecord, inputVersion, record });
  return record;
}

function forgetCharacterRecord(characterID) {
  if (characterID === undefined) entries.clear();
  else entries.delete(String(characterID));
}

module.exports = { freezeRecord, readCachedCharacterRecord, rememberCharacterRecord, forgetCharacterRecord };
