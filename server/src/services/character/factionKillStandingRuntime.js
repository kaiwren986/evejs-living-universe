"use strict";

// Faction standing loss when a player destroys a faction NPC (TQ parity).
//
// Mechanic (calibrated against two independent golden mission logs — AlluringEmanationsLevel1 and
// GoneBerserkLevel1; see tools/TQMissionLogDecoder/docs/COMBAT_MISSION_GAPS.md):
//   - Killing a faction NPC lowers the killer's standing with that NPC's faction ONLY. The golden
//     logs emit exactly one OnNPCStandingChange per combat kill — (500010, new, old) — with NO
//     derived propagation to allies or enemies. (The positive agent/corp OnNPCStandingChange lines
//     later in the same logs are mission-COMPLETION rewards, a separate mechanic.) So we apply the
//     direct hit only, with { disableDerived: true }.
//   - The applied raw modification is a FIXED per-entity base value. CCP's true per-entity table is
//     unpublished and not in the SDE; we use one golden-log-calibrated value uniformly. Both
//     golden kills reproduce -0.00006875 exactly via new = S + (10 + S) * base:
//       Alluring:    (10 - 1.6405272743884327) * -0.00006875 -> -1.6411019881383184  (log match)
//       GoneBerserk: (10 - 1.6416766623766341) * -0.00006875 -> -1.6422512971060956  (log match)
//   - The (10 + S) distance-to-floor scaling lives in standingRuntime.calculateStandingsByRawChange.
//   - Debounced per (character, faction, system) on a 10-minute window: only one kill's loss lands
//     per window (matches TQ, where a mission's many same-faction kills produce a single hit).
//
// This module owns only the trigger + debounce; the standing math lives in standingRuntime.

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const standingRuntime = require(path.join(__dirname, "./standingRuntime"));
const {
  resolveExactAbyssalNpcOutcomeContext,
  shouldSuppressResolvedAbyssalNpcOutcome,
} = require(path.join(__dirname, "../_shared/abyssalNpcOutcomePolicy"));

const EVENT_STANDING_COMBAT_AGGRESSION = 76;
const DEBOUNCE_WINDOW_MS = 10 * 60 * 1000;
const FACTION_STANDING_LOSS_PER_KILL_RAW = -0.00006875;

// (characterID:factionID:systemID) -> last-applied wall-clock ms. In-memory: a restart clears the
// debounce (worst case one extra hit lands), which is harmless for a 10-minute window.
const lastAppliedByKey = new Map();

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

// Resolve the NPC's faction: rats carry it as warFactionID (npcPresentation); fall back to the
// corp -> faction mapping. Non-faction entities (warFactionID 0, e.g. EoM) resolve to 0 -> skipped.
function resolveVictimFactionID(victimEntity) {
  const direct = toPositiveInt(victimEntity && victimEntity.warFactionID, 0)
    || toPositiveInt(victimEntity && victimEntity.factionID, 0);
  if (direct) {
    return direct;
  }
  const corporationID = toPositiveInt(victimEntity && victimEntity.corporationID, 0);
  if (corporationID) {
    return toPositiveInt(standingRuntime.getOwnerFactionID(corporationID), 0);
  }
  return 0;
}

// Apply faction-standing loss for one NPC kill. Returns a small result object or null when nothing
// was applied (disabled, non-faction victim, no killer, or debounced within the window).
function recordNpcFactionStandingLoss(victimEntity = {}, killerCharacterID, options = {}) {
  if (config.factionStandingLossOnKillEnabled !== true) {
    return null;
  }
  const characterID = toPositiveInt(killerCharacterID, 0);
  if (!characterID) {
    return null;
  }
  const abyssalContext = resolveExactAbyssalNpcOutcomeContext(victimEntity);
  if (shouldSuppressResolvedAbyssalNpcOutcome(
    abyssalContext,
    "suppressStandings",
  )) {
    return {
      applied: false,
      suppressed: true,
      reason: abyssalContext.invalidAbyssalOutcomeAuthority
        ? "ABYSSAL_NPC_AUTHORITY_INVALID"
        : "ABYSSAL_NPC_POLICY",
      characterID,
      abyssalRunID: abyssalContext.runID,
      abyssalRoomIndex: abyssalContext.roomIndex,
    };
  }
  const factionID = resolveVictimFactionID(victimEntity);
  if (!factionID) {
    return null;
  }
  const systemID = toPositiveInt(
    options.systemID,
    toPositiveInt(victimEntity && victimEntity.systemID, 0),
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.trunc(Number(options.nowMs)) : Date.now();

  // Debounce per (character, faction, system) on a 10-minute window.
  const key = `${characterID}:${factionID}:${systemID}`;
  const lastMs = lastAppliedByKey.get(key);
  if (Number.isFinite(lastMs) && nowMs - lastMs < DEBOUNCE_WINDOW_MS) {
    return { applied: false, debounced: true, characterID, factionID, systemID };
  }

  const rawChange = FACTION_STANDING_LOSS_PER_KILL_RAW;

  let result;
  try {
    result = standingRuntime.applyStandingChanges(
      characterID,
      [
        {
          ownerID: factionID,
          rawChange,
          eventTypeID: EVENT_STANDING_COMBAT_AGGRESSION,
          applySocial: false, // standing LOSS is not reduced by the Social skill
          msg: "Combat aggression",
          int_1: toPositiveInt(victimEntity && victimEntity.typeID, null),
        },
      ],
      // Golden logs show a single-faction hit with no derived propagation for combat kills.
      { disableDerived: true },
    );
  } catch (error) {
    // Best-effort: a standing-apply failure must never break the kill pipeline.
    log.debug(`[FactionKillStanding] standing loss for character ${characterID} with faction ${factionID} failed: ${error && error.message}`);
    return null;
  }

  if (!result || result.success !== true) {
    return null;
  }
  lastAppliedByKey.set(key, nowMs);
  return {
    applied: true,
    characterID,
    factionID,
    systemID,
    rawChange,
    changes: result.appliedChanges || result.data || null,
  };
}

// Living Universe: standing gain with the victim faction's enemies (from the
// mod, on the stock debounce map: "gain:" keys hold the last-applied ms).
const npcStandingsAuthority = require(path.join(__dirname, "./npcStandingsAuthority"));
const factionState = require(path.join(__dirname, "../faction/factionState"));
const ENEMY_RELATION_MAX_STANDING = -1;
const ENEMY_FACTION_GAIN_LIMIT = 2;

function enemySourceRank(relation) {
  return String(relation && relation.source || "") === "executiveEnemyFaction" ? 0 : 1;
}
// Resident track R1 (config-gated, NOT TQ parity): the same kill grants a small standing gain
// with the victim faction's designated enemies, giving residents a combat path to repair or build
// empire standing by hunting pirates. Applied per enemy faction with the same 10-minute
// (character, faction, system) debounce idiom as the loss path, using a "gain:"-prefixed key so
// gain and loss windows never suppress each other. Returns applied results, or null.
function recordNpcFactionStandingGains(victimEntity = {}, killerCharacterID, options = {}) {
  if (config.factionStandingGainOnKillEnabled !== true) {
    return null;
  }
  const characterID = toPositiveInt(killerCharacterID, 0);
  if (!characterID) {
    return null;
  }
  const victimFactionID = resolveVictimFactionID(victimEntity);
  if (!victimFactionID) {
    return null;
  }
  const rawChange = Number(config.factionStandingGainPerKillRaw);
  if (!Number.isFinite(rawChange) || rawChange <= 0) {
    return null;
  }
  const systemID = toPositiveInt(
    options.systemID,
    toPositiveInt(victimEntity && victimEntity.systemID, 0),
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.trunc(Number(options.nowMs)) : Date.now();

  let enemyFactionIDs;
  try {
    enemyFactionIDs = npcStandingsAuthority.getRelationsForOwner(victimFactionID)
      .filter((relation) => (
        Number.isFinite(relation && relation.standing) &&
        relation.standing <= ENEMY_RELATION_MAX_STANDING &&
        factionState.isFactionID(toPositiveInt(relation && relation.toID, 0))
      ))
      .sort((left, right) => (
        (left.standing - right.standing) ||
        (enemySourceRank(left) - enemySourceRank(right)) ||
        (toPositiveInt(left.toID, 0) - toPositiveInt(right.toID, 0))
      ))
      .slice(0, ENEMY_FACTION_GAIN_LIMIT)
      .map((relation) => toPositiveInt(relation.toID, 0))
      .filter(Boolean);
  } catch (error) {
    return null;
  }
  if (!enemyFactionIDs.length) {
    return null;
  }

  const applied = [];
  for (const enemyFactionID of enemyFactionIDs) {
    const key = `gain:${characterID}:${enemyFactionID}:${systemID}`;
    const lastMs = lastAppliedByKey.get(key);
    if (Number.isFinite(lastMs) && nowMs - lastMs < DEBOUNCE_WINDOW_MS) {
      continue;
    }
    let result;
    try {
      result = standingRuntime.applyStandingChanges(
        characterID,
        [
          {
            ownerID: enemyFactionID,
            rawChange,
            eventTypeID: EVENT_STANDING_COMBAT_AGGRESSION,
            applySocial: false,
            msg: "Combat assistance",
            int_1: toPositiveInt(victimEntity && victimEntity.typeID, null),
          },
        ],
        { disableDerived: true },
      );
    } catch (error) {
      // Best-effort: a standing-apply failure must never break the kill pipeline.
      continue;
    }
    if (!result || result.success !== true) {
      continue;
    }
    lastAppliedByKey.set(key, nowMs);
    applied.push({
      factionID: enemyFactionID,
      rawChange,
      changes: result.appliedChanges || result.data || null,
    });
  }
  if (!applied.length) {
    return null;
  }
  return {
    applied: true,
    characterID,
    victimFactionID,
    systemID,
    gains: applied,
  };
}

// Test/maintenance hook.
function _resetDebounce() {
  lastAppliedByKey.clear();
}

module.exports = {
  recordNpcFactionStandingLoss,
  recordNpcFactionStandingGains, // Living Universe
  resolveVictimFactionID,
  DEBOUNCE_WINDOW_MS,
  _resetDebounce,
};
