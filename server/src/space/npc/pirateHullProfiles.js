"use strict";

// Resolves "a <faction> <hull class> pirate" to a concrete NPC profile.
//
// Content packs built from the client extraction know which pirate faction a
// site belongs to and, by reconstruction, which hull classes a wave carries, but
// they never assert exact ship types. The engine owns that decision: given the
// faction and hull class it picks a profile from the faction's standard pool
// (or the commander pool for commander-grade spawns), deterministically when a
// seed is supplied so a persisted site re-spawns the same ships after a restart.

const path = require("path");

const npcData = require(path.join(__dirname, "./npcData"));
const {
  npcProfileHasDamageableHull,
} = require(path.join(__dirname, "./npcHullDamageability"));

const STANDARD_POOL_QUERY_BY_FACTION = Object.freeze({
  angels: "angels_standard",
  blood: "blood_standard",
  guristas: "guristas_standard",
  sanshas: "sanshas_standard",
  serpentis: "serpentis_standard",
  // Rogue drone anomalies use the deadspace drone catalogue (Alvi, Alvior,
  // Alvum, Alvatis, Alvus), not the asteroid-belt drones.
  rogue_drones: "rogue_drones_deadspace_pve",
  // Sleepers (Emergent frigates, Awakened cruisers, Sleepless battleships).
  sleepers: "sleepers_deadspace",
});

// Same faction commander pools the belt-rat runtime uses; rogue drones use the
// Sentient commander pool.
const COMMANDER_POOL_QUERY_BY_FACTION = Object.freeze({
  angels: "domination",
  blood: "dark blood",
  guristas: "dread guristas",
  sanshas: "true sansha",
  serpentis: "shadow serpentis",
  rogue_drones: "rogue_drones_sentient_commanders",
});

const HULL_CLASSES = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]);

const candidateCache = new Map();

function hashText(value) {
  let state = 0x811c9dc5;
  const text = String(value == null ? "" : value);
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return state >>> 0;
}

function normalizeKey(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function normalizeHullClass(value) {
  return normalizeKey(value).replace(/[\s_-]+/g, "");
}

// Hull-class membership by profile text, the same rule the belt-rat runtime
// applies so both spawn paths agree on what "a cruiser" is.
function profileMatchesHullClass(profile, hullClass) {
  const normalizedHullClass = normalizeHullClass(hullClass);
  if (!normalizedHullClass) {
    return false;
  }
  const haystack = [
    profile && profile.profileID,
    profile && profile.name,
    profile && profile.description,
    profile && profile.shipNameTemplate,
    ...(Array.isArray(profile && profile.aliases) ? profile.aliases : []),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (normalizedHullClass === "battlecruiser") {
    return /(^|[^a-z])battle\s*cruiser([^a-z]|$)/.test(haystack);
  }
  if (normalizedHullClass === "cruiser") {
    // "battlecruiser" contains "cruiser"; keep the classes disjoint.
    return /(^|[^a-z])cruiser([^a-z]|$)/.test(haystack) &&
      !/(^|[^a-z])battle\s*cruiser([^a-z]|$)/.test(haystack);
  }
  const pattern = new RegExp(`(^|[^a-z])${normalizedHullClass}([^a-z]|$)`);
  return pattern.test(haystack);
}

function listPoolCandidates(poolQuery, hullClass) {
  const cacheKey = `${normalizeKey(poolQuery)}|${normalizeHullClass(hullClass)}`;
  if (candidateCache.has(cacheKey)) {
    return candidateCache.get(cacheKey);
  }
  const poolResult = npcData.resolveNpcSpawnPool(poolQuery);
  const pool = poolResult && poolResult.success === true ? poolResult.data : null;
  const entries = Array.isArray(pool && pool.entries) ? pool.entries : [];
  const candidates = [];
  for (const entry of entries) {
    const profileID = String(entry && entry.profileID || "").trim();
    const weight = Math.max(0, Number(entry && entry.weight) || 0);
    if (!profileID || weight <= 0) {
      continue;
    }
    const profile = npcData.getNpcProfile(profileID);
    if (!profile || !profileMatchesHullClass(profile, hullClass)) {
      continue;
    }
    if (!npcProfileHasDamageableHull(profile)) {
      continue;
    }
    candidates.push({ profileID, weight });
  }
  candidates.sort((left, right) => left.profileID.localeCompare(right.profileID));
  candidateCache.set(cacheKey, Object.freeze(candidates));
  return candidates;
}

function pickWeighted(candidates, seedText) {
  if (candidates.length <= 0) {
    return null;
  }
  const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = (hashText(seedText) / 4294967296) * total;
  for (const entry of candidates) {
    roll -= entry.weight;
    if (roll < 0) {
      return entry.profileID;
    }
  }
  return candidates[candidates.length - 1].profileID;
}

// Returns a profile ID for the faction/hull, or null when the faction has no
// pool for it. Commander-grade spawns prefer the commander pool and fall back
// to the standard pool of the same hull class.
function resolveFactionHullProfileID(factionKey, hullClass, options = {}) {
  const normalizedFaction = normalizeKey(factionKey);
  const standardPool = STANDARD_POOL_QUERY_BY_FACTION[normalizedFaction];
  if (!standardPool || !HULL_CLASSES.includes(normalizeKey(hullClass))) {
    return null;
  }
  const seedText = String(options.seed == null ? `${normalizedFaction}:${hullClass}` : options.seed);
  if (options.commander === true) {
    const commanderPool = COMMANDER_POOL_QUERY_BY_FACTION[normalizedFaction];
    const commanderPick = commanderPool ? pickWeighted(listPoolCandidates(commanderPool, hullClass), seedText) : null;
    if (commanderPick) {
      return commanderPick;
    }
  }
  return pickWeighted(listPoolCandidates(standardPool, hullClass), seedText);
}

// Spawn-entry adapter: a pack entry carrying factionKey + hullClass resolves to
// a concrete profile query; anything else returns null so callers keep their
// own fallbacks.
function resolveSpawnEntryProfileQuery(entry, options = {}) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const factionKey = normalizeKey(entry.factionKey || entry.npcFactionKey);
  const hullClass = normalizeKey(entry.hullClass);
  if (!factionKey || !hullClass) {
    return null;
  }
  const profileID = resolveFactionHullProfileID(factionKey, hullClass, {
    seed: options.seed != null ? options.seed : (entry.key || `${factionKey}:${hullClass}`),
    commander: entry.commander === true,
  });
  if (profileID) {
    return profileID;
  }
  return STANDARD_POOL_QUERY_BY_FACTION[factionKey] || null;
}

function clearCacheForTests() {
  candidateCache.clear();
}

module.exports = {
  COMMANDER_POOL_QUERY_BY_FACTION,
  HULL_CLASSES,
  STANDARD_POOL_QUERY_BY_FACTION,
  clearCacheForTests,
  listPoolCandidates,
  profileMatchesHullClass,
  resolveFactionHullProfileID,
  resolveSpawnEntryProfileQuery,
};
