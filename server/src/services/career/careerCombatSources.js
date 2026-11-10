"use strict";

// Combat career goals read committed terminal outcomes. Session affiliation,
// client counters and damage assists are not evidence of a final blow.
const database = require("../../gameStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { readDurablePath } = require("./careerOwnerReads");
const FACTIONS = new Set([500001, 500002, 500003, 500004, 500010, 500011]);
const HULL_GROUPS = new Set([25, 420, 26]);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
function filetime(value) {
  try {
    const time = Number((BigInt(value || 0) - 116444736000000000n) / 10000n);
    return Number.isSafeInteger(time) && time > 0 ? time : 0;
  } catch (_) { return 0; }
}
function isSupported(source) {
  return source?.kind === "fw-membership" || source?.kind === "combat-kills" &&
    ["npc", "player"].includes(source.victim) &&
    (source.attackerGroupID === undefined || [25, 420, 26].includes(source.attackerGroupID)) &&
    (source.factionWarfare === undefined || source.factionWarfare === true && source.victim === "player");
}

function addOutcome(metrics, key, killID, atMs, firstOnly = true) {
  let metric = metrics.get(key);
  if (!metric) metrics.set(key, (metric = { ids: new Set(), updatedAtMs: 0 }));
  if (firstOnly && metric.ids.has(killID)) return;
  metric.ids.add(killID);
  metric.updatedAtMs = Math.max(metric.updatedAtMs, atMs);
}

function killHistory(characterID, context) {
  const histories = context.careerKillHistories ||= new Map();
  if (histories.has(characterID)) return histories.get(characterID);
  const result = database.readPersistedKillmailsForCharacter(characterID);
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_COMBAT_SOURCE_UNAVAILABLE");
  const metrics = new Map();
  for (const kill of Object.values(result.data || {})) {
    const killID = positive(kill?.killID);
    if (!killID || positive(kill.finalCharacterID) !== characterID) continue;
    const victim = resolveItemByTypeID(positive(kill.victimShipTypeID));
    const category = Number(victim?.categoryID);
    const atMs = filetime(kill.killTime);
    if (kill.careerNpcShip === true && category === 11 &&
        [undefined, null, 0, "0"].includes(kill.victimCharacterID)) {
      // General NPC totals take the latest matching timestamp, including
      // duplicate IDs. Hull goals retain the first qualifying record instead.
      addOutcome(metrics, "npc-kills", killID, atMs, false);
    }
    const npc = kill.careerNpcShip === true && !positive(kill.victimCharacterID) && category === 11;
    const player = positive(kill.victimCharacterID) && positive(kill.victimCharacterID) !== characterID &&
      kill.careerNpcShip !== true && category === 6 && Number(victim.groupID) !== 29;
    if (!npc && !player) continue;
    const hull = Number(resolveItemByTypeID(positive(kill.careerFinalShipTypeID || kill.finalShipTypeID))?.groupID);
    const groups = HULL_GROUPS.has(hull) ? [0, hull] : [0];
    const kind = npc ? "npc" : "player";
    for (const group of groups) addOutcome(metrics, `${kind}:${group}:all`, killID, atMs);
    if (player && positive(kill.careerFwFinalBlowCharacterID) === characterID &&
        require("../achievement/achievementRuntime").areFactionWarfareEnemies(
          positive(kill.careerFwFinalBlowFactionID), positive(kill.careerFwVictimFactionID))) {
      for (const group of groups) addOutcome(metrics, `player:${group}:fw`, killID, atMs);
    }
  }
  histories.set(characterID, metrics);
  return metrics;
}

function privateKillEvidence(characterID, record, context) {
  const evidence = context.careerPrivateKillEvidence ||= new Map();
  if (!evidence.has(characterID)) {
    const ledger = require("./careerEventLedger");
    const character = record || require("../character/characterState").getCharacterRecord(characterID);
    const metrics = new Map();
    for (const key of ["abyssal:npc-kills", ...[...HULL_GROUPS].map(group => `abyssal:npc-kills-by-hull:${group}`)]) {
      metrics.set(key, ledger.observe(characterID, key, character));
    }
    evidence.set(characterID, metrics);
  }
  return evidence.get(characterID);
}

function observeNpcKills(characterID, record, context = {}) {
  const id = positive(characterID);
  if (!id) return null;
  const metric = killHistory(id, context).get("npc-kills");
  const privateKills = privateKillEvidence(id, record, context).get("abyssal:npc-kills");
  return { kind: "npc-kills", id: "npc-kills:v1",
    progress: (metric?.ids.size || 0) + (privateKills?.progress || 0),
    updatedAtMs: Math.max(metric?.updatedAtMs || 0, privateKills?.updatedAtMs || 0) };
}

function observe(characterID, record, definition, context = {}) {
  const id = positive(characterID), source = definition?.source;
  if (!id || !isSupported(source)) return null;
  if (source.kind === "fw-membership") {
    const character = readDurablePath("characters", `/${id}`, context, "CAREER_COMBAT_SOURCE_UNAVAILABLE");
    const history = character?.careerFwEnlistment;
    const direct = positive(character?.directFactionID);
    // Racial ancestry or an NPC corporation's ordinary faction field is not
    // militia enrollment. Only explicit direct/war affiliation qualifies.
    const enrolled = FACTIONS.has(direct) || FACTIONS.has(positive(character?.warFactionID ?? character?.warfactionid));
    return { kind: source.kind, id: "fw-membership:v1", progress: enrolled ||
      FACTIONS.has(positive(history?.factionID)) && positive(history?.enlistedAtMs) ? 1 : 0,
      updatedAtMs: positive(history?.enlistedAtMs) };
  }
  const metric = killHistory(id, context).get(
    `${source.victim}:${source.attackerGroupID || 0}:${source.factionWarfare ? "fw" : "all"}`,
  );
  const abyssal = source.victim === "npc" && source.attackerGroupID
    ? privateKillEvidence(id, record, context).get(`abyssal:npc-kills-by-hull:${source.attackerGroupID}`) : null;
  return { kind: source.kind,
    id: `combat-kills:${source.victim}:${source.attackerGroupID || 0}:${source.factionWarfare ? "fw" : "all"}:v1`,
    progress: (metric?.ids.size || 0) + (abyssal?.progress || 0),
    updatedAtMs: Math.max(metric?.updatedAtMs || 0, abyssal?.updatedAtMs || 0) };
}
function snapshotFactionWarfareFinalBlow(record) {
  if (!(Number(record?.finalDamageDone) > 0)) return null;
  const characterID = positive(record.finalCharacterID), victimID = positive(record.victimCharacterID);
  const type = resolveItemByTypeID(positive(record.victimShipTypeID));
  if (!characterID || !victimID || characterID === victimID || Number(type?.categoryID) !== 6 ||
      Number(type.groupID) === 29) return null;
  const characters = require("../character/characterState");
  const attacker = characters.getCharacterRecord(characterID), victim = characters.getCharacterRecord(victimID);
  const factionID = positive(attacker?.warFactionID ?? attacker?.warfactionid);
  const victimFactionID = positive(victim?.warFactionID ?? victim?.warfactionid);
  return require("../achievement/achievementRuntime").areFactionWarfareEnemies(factionID, victimFactionID)
    ? { characterID, factionID, victimFactionID } : null;
}

function snapshotAttackHull(scene, attacker) {
  if (!scene?.getEntityByID || !attacker) return null;
  const source = scene.getEntityByID(attacker.itemID);
  if (!source || source.destroyed || source.kind !== attacker.kind || Number(source.typeID) !== Number(attacker.typeID) ||
      Number(source.ownerID) !== Number(attacker.ownerID)) return null;
  let ship = source;
  if (["drone", "fighter"].includes(source.kind)) {
    const controllerID = positive(source.controllerID);
    if (!controllerID || controllerID !== positive(attacker.controllerID) ||
        positive(source.launcherID) !== positive(attacker.launcherID)) return null;
    ship = scene.getEntityByID(controllerID);
    if (!ship || !require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(source, ship)) return null;
  }
  if (!ship || ship.kind !== "ship" || ship.nativeNpc === true || ship.destroyed) return null;
  const characterID = positive(ship.pilotCharacterID) || positive(ship.characterID) ||
    positive(ship.session?.characterID || ship.session?.charid);
  if (!characterID || source !== ship && positive(source.ownerID) !== characterID) return null;
  const record = require("../inventory/itemStore").findShipItemById(ship.itemID);
  if (!record || Number(record.ownerID) !== characterID || Number(record.typeID) !== Number(ship.typeID) ||
      !require("../character/characterState").getCharacterRecord(characterID)) return null;
  return Object.freeze({ characterID, shipID: positive(ship.itemID), shipTypeID: positive(ship.typeID) });
}
module.exports = { observe, observeNpcKills, supports: isSupported, isSupported, snapshotFactionWarfareFinalBlow, snapshotAttackHull };
