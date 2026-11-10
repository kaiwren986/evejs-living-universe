"use strict";

// Reinforcement of player Customs Offices and Orbital Skyhooks: the stage an
// orbital is in after damage, its exit time, its repair, what the client is
// shown, and the owner notifications. planetOrbitalState owns the records and
// calls in here; nothing here writes the store.
//
// Customs Office (EVE University, Player Owned Customs Office): one cycle. At
// 25% shield it becomes invulnerable (entityConst STATE_SHIELD_REINFORCE 12,
// with orbitalTimestamp, which inSpaceBracket.py:1610 and
// selectedItemTimers.py:76 count down) until 24 to 48 hours later, ending within
// an hour of the owner's reinforce hour; then it can be shot to destruction.
// InterBus offices have no reinforcement.
//
// Orbital Skyhook (client orbitalSkyhook/const.py; Equinox: one reinforcement
// cycle): shield vulnerable 210 -> armor reinforce 211 (invulnerable) -> armor
// vulnerable 212 -> hull vulnerable 214 -> destroyed. The armor timer runs at
// least REINFORCE_DURATION_ARMOR_DEFAULT (129600 s) and ends at the first owner
// exit hour after that, within an hour either way: the four reinforced skyhooks
// in the TQ capture LOGS\Tutorial\nullexplored.lsw (2026-10-27) ran 38.1 to
// 46.2 h and exited at 03:55, 11:24, 11:51 and 15:09. DEFAULT_EXIT_HOUR is 12.
//
// Both repair to full when nobody has shot them for DEFAULT_REPAIR_TIMER (900 s)
// after their timer ends, which starts a fresh cycle (the repair rule for the
// Customs Office is the skyhook's, as no source gives one).

const HOUR_MS = 60 * 60 * 1000;
const STATE_SHIELD_REINFORCE = 12;
const CUSTOMS_REINFORCE_SHIELD = 0.25;
const CUSTOMS_MIN_REINFORCE_MS = 24 * HOUR_MS;
const SKYHOOK_STATE = Object.freeze({
  SHIELD_VULNERABLE: 210,
  ARMOR_REINFORCE: 211,
  ARMOR_VULNERABLE: 212,
  HULL_REINFORCE: 213,
  HULL_VULNERABLE: 214,
});
const SKYHOOK_MIN_REINFORCE_MS = 129_600 * 1000;
const SKYHOOK_DEFAULT_EXIT_HOUR = 12;
const REPAIR_MS = 900 * 1000;
const EXIT_JITTER_MS = HOUR_MS;

const TYPE_CUSTOMS_OFFICE = 2233;
const TYPE_ORBITAL_SKYHOOK = 81080;

const NOTIFICATION = Object.freeze({
  ORBITAL_ATTACKED: 93,
  ORBITAL_REINFORCED: 94,
  SKYHOOK_ONLINE: 281,
  SKYHOOK_LOST_SHIELD: 282,
  SKYHOOK_UNDER_ATTACK: 283,
  SKYHOOK_DESTROYED: 284,
  SKYHOOK_DEPLOYED: 285,
});

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function msToFiletime(ms) {
  return (BigInt(Math.trunc(ms)) * 10000n + 116444736000000000n).toString();
}

function isSkyhook(record) {
  return toInt(record && record.typeID, 0) === TYPE_ORBITAL_SKYHOOK;
}

// A player office reinforces; the NPC InterBus offices (and any office still
// owned by the NPC default owner) do not.
function reinforces(record, npcOwnerID) {
  if (!record || record.destroyedAtMs) return false;
  if (isSkyhook(record)) return true;
  return toInt(record.typeID, 0) === TYPE_CUSTOMS_OFFICE &&
    toInt(record.ownerID, 0) !== toInt(npcOwnerID, -1) &&
    toInt(record.ownerID, 0) >= 90_000_000;
}

function normalizeReinforcement(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    stage: String(source.stage || "shield"),
    startedAtMs: toInt(source.startedAtMs, 0) || null,
    endsAtMs: toInt(source.endsAtMs, 0) || null,
    exitedAtMs: toInt(source.exitedAtMs, 0) || null,
    lastDamageAtMs: toInt(source.lastDamageAtMs, 0) || null,
    attackNotifiedStage: source.attackNotifiedStage ? String(source.attackNotifiedStage) : null,
  };
}

// The first moment at or after earliestMs that falls within an hour either way
// of the owner's exit hour (UTC).
function resolveExitMs(earliestMs, exitHour, rng = Math.random) {
  const hour = Math.max(0, Math.min(23, toInt(exitHour, SKYHOOK_DEFAULT_EXIT_HOUR)));
  const jitter = Math.round((rng() * 2 - 1) * EXIT_JITTER_MS);
  const day = new Date(earliestMs);
  let candidate = Date.UTC(
    day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0,
  ) + jitter;
  while (candidate < earliestMs) {
    candidate += 24 * HOUR_MS;
  }
  return candidate;
}

function resolveReinforceHour(record) {
  return toInt(record && record.reinforceHour, isSkyhook(record) ? SKYHOOK_DEFAULT_EXIT_HOUR : 18);
}

function layerOf(condition) {
  if (condition.shieldCharge > 0) return "shield";
  if (condition.armorDamage < 1) return "armor";
  return "hull";
}

function isLayerWhole(condition, layer) {
  if (layer === "shield") return condition.shieldCharge >= 1;
  if (layer === "armor") return condition.armorDamage <= 0;
  return condition.damage <= 0;
}

// The next record and what happened, for one applied hit.
// before/after: { shieldCharge, armorDamage, damage } (armorDamage and damage
// are fractions lost). Returns { record, preventDestroy, events[] }.
function applyDamage(record, before, after, nowMs, options = {}) {
  const events = [];
  if (!reinforces(record, options.npcOwnerID)) {
    return { record: { ...record, conditionState: after }, preventDestroy: false, events };
  }
  const rng = typeof options.rng === "function" ? options.rng : Math.random;
  const reinforcement = normalizeReinforcement(record.reinforcement);
  const invulnerable = isSkyhook(record)
    ? reinforcement.stage === "armor_reinforce"
    : reinforcement.stage === "reinforced";
  if (invulnerable) {
    return { record: { ...record, conditionState: before }, preventDestroy: true, events };
  }

  let condition = { ...after };
  let next = { ...record };
  let preventDestroy = false;
  const stageBefore = reinforcement.stage;
  reinforcement.lastDamageAtMs = nowMs;

  if (isSkyhook(record)) {
    if (stageBefore === "shield" && condition.shieldCharge <= 0) {
      // Shields gone: armor reinforce, armor and hull untouched by this hit.
      condition = { shieldCharge: 0, armorDamage: before.armorDamage, damage: before.damage };
      reinforcement.stage = "armor_reinforce";
      reinforcement.startedAtMs = nowMs;
      reinforcement.endsAtMs = resolveExitMs(
        nowMs + SKYHOOK_MIN_REINFORCE_MS, resolveReinforceHour(record), rng,
      );
      reinforcement.exitedAtMs = null;
      preventDestroy = true;
      events.push({ kind: "skyhook-lost-shield" });
    } else if (stageBefore === "armor_vulnerable" && condition.armorDamage >= 1) {
      reinforcement.stage = "hull_vulnerable";
    }
  } else if (stageBefore === "shield" && condition.shieldCharge <= CUSTOMS_REINFORCE_SHIELD) {
    condition = {
      shieldCharge: CUSTOMS_REINFORCE_SHIELD,
      armorDamage: before.armorDamage,
      damage: before.damage,
    };
    reinforcement.stage = "reinforced";
    reinforcement.startedAtMs = nowMs;
    reinforcement.endsAtMs = resolveExitMs(
      nowMs + CUSTOMS_MIN_REINFORCE_MS, resolveReinforceHour(record), rng,
    );
    reinforcement.exitedAtMs = null;
    preventDestroy = true;
    next.stateBeforeReinforce = toInt(record.state, 0);
    next.state = STATE_SHIELD_REINFORCE;
    next.stateStartedAtMs = reinforcement.startedAtMs;
    next.stateEndsAtMs = reinforcement.endsAtMs;
    events.push({ kind: "orbital-reinforced" });
  }

  // One under-attack notice per aggression: a new one only when the layer
  // being shot was whole or the stage changed since the last notice (the
  // rule Upwell structures follow, structureState shouldNotifyStructureUnderAttack).
  const layer = layerOf(before);
  if (
    reinforcement.stage === stageBefore &&
    (isLayerWhole(before, layer) || reinforcement.attackNotifiedStage !== stageBefore)
  ) {
    reinforcement.attackNotifiedStage = stageBefore;
    events.push({ kind: isSkyhook(record) ? "skyhook-under-attack" : "orbital-attacked" });
  }

  next.conditionState = condition;
  next.reinforcement = reinforcement;
  return { record: next, preventDestroy, events };
}

// Timer exits and repairs that are due. Returns { record, changed, events[],
// nextDueMs } where nextDueMs is when to look again (or null).
function advance(record, nowMs) {
  if (!record || !record.reinforcement || record.destroyedAtMs) {
    return { record, changed: false, events: [], nextDueMs: null };
  }
  const reinforcement = normalizeReinforcement(record.reinforcement);
  let next = { ...record };
  let changed = false;
  const events = [];
  const invulnerable = reinforcement.stage === "armor_reinforce" || reinforcement.stage === "reinforced";
  if (invulnerable && reinforcement.endsAtMs && reinforcement.endsAtMs <= nowMs) {
    reinforcement.stage = isSkyhook(record) ? "armor_vulnerable" : "vulnerable";
    reinforcement.exitedAtMs = reinforcement.endsAtMs;
    reinforcement.attackNotifiedStage = null;
    if (!isSkyhook(record)) {
      next.state = toInt(record.stateBeforeReinforce, 0);
      next.stateStartedAtMs = null;
      next.stateEndsAtMs = null;
      delete next.stateBeforeReinforce;
    }
    changed = true;
    events.push({ kind: "reinforcement-ended" });
  }
  const repairable = ["armor_vulnerable", "hull_vulnerable", "vulnerable"].includes(reinforcement.stage);
  const quietSinceMs = Math.max(
    toInt(reinforcement.exitedAtMs, 0),
    toInt(reinforcement.lastDamageAtMs, 0),
  );
  if (repairable && quietSinceMs && quietSinceMs + REPAIR_MS <= nowMs) {
    next.conditionState = { shieldCharge: 1, armorDamage: 0, damage: 0 };
    next.reinforcement = null;
    return { record: next, changed: true, events: [...events, { kind: "repaired" }], nextDueMs: null };
  }
  next.reinforcement = reinforcement;
  let nextDueMs = null;
  if (reinforcement.stage === "armor_reinforce" || reinforcement.stage === "reinforced") {
    nextDueMs = reinforcement.endsAtMs;
  } else if (repairable && quietSinceMs) {
    nextDueMs = quietSinceMs + REPAIR_MS;
  }
  return { record: next, changed, events, nextDueMs };
}

function getDueMs(record) {
  return advance(record, -Infinity).nextDueMs;
}

// The skyhook's slim fields: skyhook_state, skyhook_timer (start, end, paused)
// in ms while a timer runs (the slim builder sends FILETIMEs), and
// skyhook_damage [shield, armor, hull]
// remaining while it is damaged (skyhookBracket.py:57-95; the TQ capture
// carries skyhook_damage=[~0, 1.0, 1.0] beside state 211).
function getSkyhookPresentation(record, operating) {
  if (!operating) {
    return { skyhook_state: 0, skyhook_timer: null, skyhook_damage: null };
  }
  const reinforcement = record && record.reinforcement
    ? normalizeReinforcement(record.reinforcement)
    : null;
  const stage = reinforcement ? reinforcement.stage : "shield";
  const state = {
    shield: SKYHOOK_STATE.SHIELD_VULNERABLE,
    armor_reinforce: SKYHOOK_STATE.ARMOR_REINFORCE,
    armor_vulnerable: SKYHOOK_STATE.ARMOR_VULNERABLE,
    hull_vulnerable: SKYHOOK_STATE.HULL_VULNERABLE,
  }[stage] || SKYHOOK_STATE.SHIELD_VULNERABLE;
  const timer = stage === "armor_reinforce" && reinforcement.startedAtMs && reinforcement.endsAtMs
    ? [reinforcement.startedAtMs, reinforcement.endsAtMs, null]
    : null;
  const condition = record && record.conditionState || {};
  const shield = clamp01(condition.shieldCharge, 1);
  const armor = 1 - clamp01(condition.armorDamage, 0);
  const hull = 1 - clamp01(condition.damage, 0);
  const damaged = shield < 1 || armor < 1 || hull < 1;
  return {
    skyhook_state: state,
    skyhook_timer: timer,
    skyhook_damage: damaged ? [shield, armor, hull] : null,
  };
}

// The data each client formatter reads (notificationUtil.py:730-769 for 93/94,
// notifications/common/formatters/skyhook.py for 281-285).
function buildNotification(kind, record, context = {}) {
  const planetID = toInt(record.planetID, 0);
  const planetTypeID = toInt(context.planetTypeID, 0);
  const aggressor = context.attacker || {};
  const aggressorID = toInt(aggressor.characterID, 0) || null;
  const aggressorCorpID = toInt(aggressor.corporationID, 0) || null;
  const aggressorAllianceID = toInt(aggressor.allianceID, 0) || null;
  const condition = record.conditionState || {};
  if (kind === "orbital-attacked" || kind === "orbital-reinforced") {
    const data = {
      typeID: toInt(record.typeID, 0),
      planetID,
      planetTypeID,
      solarSystemID: toInt(record.solarSystemID, 0),
      aggressorID,
      aggressorCorpID,
      aggressorAllianceID,
    };
    if (kind === "orbital-attacked") {
      data.shieldLevel = clamp01(condition.shieldCharge, 1);
      return { typeID: NOTIFICATION.ORBITAL_ATTACKED, data };
    }
    const reinforcement = normalizeReinforcement(record.reinforcement);
    data.reinforceExitTime = { type: "long", value: msToFiletime(reinforcement.endsAtMs) };
    return { typeID: NOTIFICATION.ORBITAL_REINFORCED, data };
  }
  const base = {
    itemID: toInt(record.itemID, 0),
    typeID: TYPE_ORBITAL_SKYHOOK,
    solarsystemID: toInt(record.solarSystemID, 0),
    planetID,
    skyhookShowInfoData: ["showinfo", TYPE_ORBITAL_SKYHOOK, toInt(record.itemID, 0)],
    planetShowInfoData: ["showinfo", planetTypeID, planetID],
  };
  if (kind === "skyhook-under-attack") {
    return {
      typeID: NOTIFICATION.SKYHOOK_UNDER_ATTACK,
      data: {
        ...base,
        shieldPercentage: 100 * clamp01(condition.shieldCharge, 1),
        armorPercentage: 100 * (1 - clamp01(condition.armorDamage, 0)),
        hullPercentage: 100 * (1 - clamp01(condition.damage, 0)),
        isActive: context.isActive !== false,
        charID: aggressorID,
        corpName: context.aggressorCorpName || null,
        corpLinkData: ["showinfo", 2, aggressorCorpID],
        allianceID: aggressorAllianceID,
        ...(aggressorAllianceID ? {
          allianceName: context.aggressorAllianceName || null,
          allianceLinkData: ["showinfo", 16159, aggressorAllianceID],
        } : {}),
      },
    };
  }
  if (kind === "skyhook-lost-shield") {
    const reinforcement = normalizeReinforcement(record.reinforcement);
    const nowMs = toInt(context.nowMs, Date.now());
    return {
      typeID: NOTIFICATION.SKYHOOK_LOST_SHIELD,
      data: {
        ...base,
        timeLeft: { type: "long", value: String(BigInt(Math.max(0, reinforcement.endsAtMs - nowMs)) * 10000n) },
        timestamp: { type: "long", value: msToFiletime(reinforcement.endsAtMs) },
        vulnerableTime: { type: "long", value: String(BigInt(REPAIR_MS) * 10000n) },
      },
    };
  }
  if (kind === "skyhook-destroyed") {
    return { typeID: NOTIFICATION.SKYHOOK_DESTROYED, data: base };
  }
  if (kind === "skyhook-online") {
    return { typeID: NOTIFICATION.SKYHOOK_ONLINE, data: base };
  }
  if (kind === "skyhook-deployed") {
    const ownerCorpID = toInt(record.corporationID || record.ownerID, 0);
    return {
      typeID: NOTIFICATION.SKYHOOK_DEPLOYED,
      data: {
        ...base,
        ownerCorpName: context.ownerCorpName || null,
        ownerCorpLinkData: ["showinfo", 2, ownerCorpID],
        timeLeft: { type: "long", value: String(BigInt(Math.max(0, toInt(context.timeLeftMs, 0))) * 10000n) },
      },
    };
  }
  return null;
}

module.exports = {
  STATE_SHIELD_REINFORCE,
  SKYHOOK_STATE,
  SKYHOOK_MIN_REINFORCE_MS,
  SKYHOOK_DEFAULT_EXIT_HOUR,
  CUSTOMS_REINFORCE_SHIELD,
  REPAIR_MS,
  NOTIFICATION,
  reinforces,
  resolveExitMs,
  applyDamage,
  advance,
  getDueMs,
  getSkyhookPresentation,
  buildNotification,
};
