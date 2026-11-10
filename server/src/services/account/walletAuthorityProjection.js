"use strict";

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

// Ledger lists the authority mirrors here. The owner process ships them either
// in full (startup snapshot, first publish for an owner, or whenever a diff is
// not provably safe) or as a `<field>Delta` describing the entries prepended
// since the previous publish. Shipping the full list on every wallet command is
// what made market activity degrade with a character's transaction count.
const HISTORY_FIELDS = Object.freeze([
  "walletJournal",
  "marketTransactions",
  "plexVaultTransactions",
]);
const HISTORY_FIELD_KEYS = new Set([
  ...HISTORY_FIELDS,
  ...HISTORY_FIELDS.map((fieldName) => `${fieldName}Delta`),
]);

let generation = 0;
let sequence = 0;
const characters = new Map();
const corporations = new Map();

function resolveHistoryField(existing, entry, fieldName) {
  if (Array.isArray(entry[fieldName])) {
    return cloneValue(entry[fieldName]);
  }
  const retained = Array.isArray(existing && existing[fieldName])
    ? existing[fieldName]
    : null;
  const delta = entry[`${fieldName}Delta`];
  if (delta && typeof delta === "object" && !Array.isArray(delta)) {
    const prepend = Array.isArray(delta.prepend) ? cloneValue(delta.prepend) : [];
    const keep = Math.max(0, Math.trunc(Number(delta.keep) || 0));
    return [...prepend, ...(retained || []).slice(0, keep)];
  }
  // Field omitted entirely: the owner is telling us nothing changed.
  return retained === null ? undefined : retained;
}

function mergeCharacterProjection(existing, entry) {
  const merged = {};
  for (const key of Object.keys(entry)) {
    if (HISTORY_FIELD_KEYS.has(key)) {
      continue;
    }
    merged[key] = cloneValue(entry[key]);
  }
  for (const fieldName of HISTORY_FIELDS) {
    const resolved = resolveHistoryField(existing, entry, fieldName);
    if (resolved !== undefined) {
      merged[fieldName] = resolved;
    }
  }
  return merged;
}

function publishCommittedProjection(message = {}) {
  const incomingGeneration = Math.max(0, Math.trunc(Number(message.generation) || 0));
  const incomingSequence = Math.max(0, Math.trunc(Number(message.sequence) || 0));
  let generationAdvanced = false;
  if (incomingGeneration < generation) {
    return false;
  }
  if (incomingGeneration > generation) {
    generation = incomingGeneration;
    sequence = 0;
    generationAdvanced = true;
  }
  if (incomingSequence <= sequence) {
    if (!generationAdvanced || incomingSequence !== 0) {
      return incomingSequence === sequence;
    }
  }

  for (const entry of Array.isArray(message.characters) ? message.characters : []) {
    const characterID = Math.trunc(Number(entry && entry.characterID) || 0);
    if (characterID > 0) {
      characters.set(
        characterID,
        mergeCharacterProjection(characters.get(characterID) || null, entry),
      );
    }
  }
  for (const entry of Array.isArray(message.corporations) ? message.corporations : []) {
    const corporationID = Math.trunc(Number(entry && entry.corporationID) || 0);
    if (corporationID > 0) {
      corporations.set(corporationID, cloneValue(entry));
    }
  }
  sequence = incomingSequence;
  return true;
}

function getCharacterProjection(characterID) {
  const entry = characters.get(Math.trunc(Number(characterID) || 0));
  return entry ? cloneValue(entry) : null;
}

// Balance-only view for the many callers that never look at the ledger lists.
// Cloning the whole projection to read four numbers is the same O(history) cost
// on the read side that the delta protocol removed from the write side.
function getCharacterBalanceProjection(characterID) {
  const entry = characters.get(Math.trunc(Number(characterID) || 0));
  if (!entry) {
    return null;
  }
  return {
    characterID: entry.characterID,
    balance: entry.balance,
    aurBalance: entry.aurBalance,
    plexBalance: entry.plexBalance,
    balanceChange: entry.balanceChange,
  };
}

function getCorporationProjection(corporationID) {
  const entry = corporations.get(Math.trunc(Number(corporationID) || 0));
  return entry ? cloneValue(entry) : null;
}

function getDiagnostics() {
  return Object.freeze({
    characterCount: characters.size,
    corporationCount: corporations.size,
    generation,
    sequence,
  });
}

function resetForTests() {
  generation = 0;
  sequence = 0;
  characters.clear();
  corporations.clear();
}

module.exports = {
  getCharacterBalanceProjection,
  getCharacterProjection,
  getCorporationProjection,
  getDiagnostics,
  publishCommittedProjection,
  _resetForTests: resetForTests,
};
