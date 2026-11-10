"use strict";

// Combat career goals read committed terminal outcomes. Session affiliation,
// client counters and damage assists are not evidence of a final blow.
const database = require("../../gameStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const FACTIONS = new Set([500001, 500002, 500003, 500004, 500010, 500011]);
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
function persisted(table, context) {
  if (Object.hasOwn(context, table)) return context[table];
  const result = database.readPersisted(table, "/");
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_COMBAT_SOURCE_UNAVAILABLE");
  return context[table] = result.data || {};
}
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
function observe(characterID, record, definition, context = {}) {
  const id = positive(characterID), source = definition?.source;
  if (!id || !isSupported(source)) return null;
  if (source.kind === "fw-membership") {
    const character = persisted("characters", context)[String(id)];
    const history = character?.careerFwEnlistment;
    const direct = positive(character?.directFactionID);
    // Racial ancestry or an NPC corporation's ordinary faction field is not
    // militia enrollment. Only explicit direct/war affiliation qualifies.
    const enrolled = FACTIONS.has(direct) || FACTIONS.has(positive(character?.warFactionID ?? character?.warfactionid));
    return { kind: source.kind, id: "fw-membership:v1", progress: enrolled ||
      FACTIONS.has(positive(history?.factionID)) && positive(history?.enlistedAtMs) ? 1 : 0,
      updatedAtMs: positive(history?.enlistedAtMs) };
  }
  const ids = new Set();
  let updatedAtMs = 0;
  for (const kill of Object.values(persisted("killmails", context).records || {})) {
    const killID = positive(kill?.killID);
    if (!killID || ids.has(killID) || positive(kill.finalCharacterID) !== id) continue;
    const victim = resolveItemByTypeID(positive(kill.victimShipTypeID));
    if (source.victim === "npc") {
      if (kill.careerNpcShip !== true || positive(kill.victimCharacterID) || Number(victim?.categoryID) !== 11) continue;
    } else {
      if (!positive(kill.victimCharacterID) || positive(kill.victimCharacterID) === id ||
          kill.careerNpcShip === true || Number(victim?.categoryID) !== 6 ||
          Number(victim.groupID) === 29) continue;
      if (source.factionWarfare && (positive(kill.careerFwFinalBlowCharacterID) !== id ||
          !require("../achievement/achievementRuntime").areFactionWarfareEnemies(
            positive(kill.careerFwFinalBlowFactionID), positive(kill.careerFwVictimFactionID)))) continue;
    }
    if (source.attackerGroupID && Number(resolveItemByTypeID(positive(kill.careerFinalShipTypeID || kill.finalShipTypeID))?.groupID) !== source.attackerGroupID) continue;
    ids.add(killID);
    updatedAtMs = Math.max(updatedAtMs, filetime(kill.killTime));
  }
  const abyssal = source.victim === "npc" && source.attackerGroupID
    ? require("./careerEventLedger").observe(id, `abyssal:npc-kills-by-hull:${source.attackerGroupID}`) : null;
  return { kind: source.kind,
    id: `combat-kills:${source.victim}:${source.attackerGroupID || 0}:${source.factionWarfare ? "fw" : "all"}:v1`,
    progress: ids.size + (abyssal?.progress || 0), updatedAtMs: Math.max(updatedAtMs, abyssal?.updatedAtMs || 0) };
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
module.exports = { observe, supports: isSupported, isSupported, snapshotFactionWarfareFinalBlow, snapshotAttackHull };
