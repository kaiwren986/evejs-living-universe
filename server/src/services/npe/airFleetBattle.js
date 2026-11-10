"use strict";

// The fleet battle around AIR chapter 1.2's lesson (combat site, template 9105). Tranquility's
// server graph 686 writes each lesson step to a dungeon behaviour blackboard
// (SPAWN_UNIDENTIFIED_FLEET, FRIGATES_DESTROYED, WEB_ACTIVATED, CRUISER_WEBBED, ECM_ACTIVATED);
// what Tranquility's behaviours do with them is not in the client data. From those same steps
// this plays what the scene shows there:
//  - the fleet lands with a few of its ships burning, hit in the attack on the cloning facility;
//  - Balin's armed ships and the hostile reinforcements (group 4130, not on the overview) fight
//    each other in the background, from the frigate lesson on (combat.battle.duels): the
//    reinforcements land and hold through the client's arrival scene and its camera shots;
//  - once the pilot has webbed the cruiser, three of the fleet's ships close on it;
//  - from the battleship step the battleships hold the last transport, the Bowhead III, with
//    their scramblers and webs, and it warps away once the pilot's ECM has broken their lock.
// All of it is ordinary NPC orders and the hulls' own weapons. airCombatPolicy keeps every ship
// of the battle above its damage floor: they burn, nobody dies of it, and the lesson's hostiles
// are still the pilot's kills. The frigate and the cruiser keep their station for the pilot and
// fire only back at it once attacked (airCombatRuntime); the battleships' lethal attack after
// the ECM is the lesson's own.
const log = () => require("../../utils/logger");
const npcs = () => require("../../space/npc/npcService");
const contract = () => require("../dungeon/dungeonAuthority").getTemplateByID("evejs.air-tutorial:9105")?.airEncounter;

// Burning on landing, by companion slot (airEncounterRuntime companionSpecs: escort:N is the
// first site's escort N). Damage as fractions, as a ship's conditionState keeps it.
const SCARS = Object.freeze({
  "escort:8": Object.freeze({ shieldCharge: 0.3, armorDamage: 0.9, damage: 0.4 }), // a Nestor
  "escort:4": Object.freeze({ shieldCharge: 0.2, armorDamage: 0.95, damage: 0.45 }), // the Firetail
  "escort:1": Object.freeze({ shieldCharge: 0.4, armorDamage: 0.8, damage: 0.3 }), // the Bowhead II
  "escort:5": Object.freeze({ shieldCharge: 0.6, armorDamage: 0.45, damage: 0 }), // the Orca, smoking
});
// Each reinforcement and the armed companion it fights, both ways.
const DUELS = Object.freeze([
  ["hostile:reinforcement:0", "escort:8"], // Megathron, Nestor
  ["hostile:reinforcement:1", "escort:9"], // Megathron, Nestor
  ["hostile:reinforcement:2", "escort:10"], // Scorpion, Nestor
  ["hostile:reinforcement:3", "escort:11"], // Gnosis, Nestor
  ["hostile:reinforcement:4", "escort:7"], // Gnosis, Osprey
  ["hostile:reinforcement:5", "escort:6"], // Ferox, Cormorant
  ["hostile:reinforcement:6", "escort:3"], // Moa, Brutix
]);
// Inside the duellists' optimal range (28.75 km for all of them).
const DUEL_ORBIT_METERS = 20000;
const CRUISER = "hostile:cruiser";
const BATTLESHIPS = Object.freeze(["hostile:battleship:0", "hostile:battleship:1"]);
const HELD_TRANSPORT = "escort:0"; // the battleships' prey, the Bowhead III
const CLOSING_ON_CRUISER = Object.freeze(["escort:3", "escort:4", "escort:12"]); // Brutix, Firetail, Nestor
const CLOSING_ORBIT_METERS = 5000;

function actor(scene, site, key) {
  return scene.getDynamicEntities().find(entity => entity.airNpeOwnerCharacterID === site.ownership.characterID && entity.airNpeInstanceID === site.instanceID && entity.airEncounterSlot === key);
}
function hasCompletedDeparture(current, instanceID, key) {
  const receipt = current?.encounter?.combat?.battle?.departures?.[key];
  return key === HELD_TRANSPORT && receipt?.status === "complete" && receipt.runID === current.runID && receipt.instanceID === instanceID;
}
// Called only at the NPC owner's observed WarpOff completion boundary, before it
// retires the actor. AIR owns the durable receipt; a refused commit must throw so
// the existing controller can retry without losing the still-live actor.
function recordCompletedDeparture(scene, entity, controller) {
  if (entity?.nativeNpc !== true || entity.airEncounterSlot !== HELD_TRANSPORT) return false;
  const jobs = require("./airEncounterJobs");
  const characterID = entity.airNpeOwnerCharacterID, current = jobs.state(characterID);
  const instanceID = entity.airNpeInstanceID;
  const site = require("../dungeon/dungeonRuntime").getInstance(instanceID);
  if (!(characterID > 0) || current?.status !== "active" || current.phaseGraphID !== 686 || !current.runID ||
      current.encounter?.sites?.[2433]?.instanceID !== instanceID || !current.encounter.combat?.deaths?.ship ||
      site?.ownership?.characterID !== characterID || site.lifecycleState !== "active" ||
      site.metadata?.operationKey !== `air:${current.runID}:encounter:2433` ||
      scene.getEntityByID(entity.itemID) !== entity || npcs().getControllerByEntityID(entity.itemID) !== controller ||
      controller.manualOrder?.type !== "warpOff" || controller.warpOffOrdered !== true || controller.warpOffSeenLeaving !== true) return false;
  if (String(entity.mode || "").toUpperCase() === "WARP" || scene.hasQueuedMovementChange(entity)) {
    throw new Error("AIR_DEPARTURE_MOVEMENT_PENDING");
  }
  if (!hasCompletedDeparture(current, instanceID, HELD_TRANSPORT)) jobs.update(characterID, value => {
    const battle = value.encounter.combat.battle ||= {};
    battle.departures ||= {};
    battle.departures[HELD_TRANSPORT] = {
      status: "complete", runID: value.runID, instanceID, entityID: entity.itemID, completedAtMs: jobs.now(),
    };
    return value;
  });
  return true;
}
function orbitFor(hostile) {
  return contract()?.hostileProfiles?.find(profile => profile.shipTypeID === hostile.typeID)?.orbitDistanceMeters || DUEL_ORBIT_METERS;
}
// Given as a ship warps in, the order waits for the warp to end (afterWarp).
function engage(source, target, orbitDistanceMeters, movementMode = "orbit") {
  if (!source || !target) return;
  const result = npcs().issueManualOrder(source.itemID, { type: "attack", targetID: target.itemID, allowWeapons: true, movementMode, orbitDistanceMeters, keepLock: true, afterWarp: true });
  if (!result?.success) log().warn(`[AirFleetBattle] ${source.airEncounterSlot} -> ${target.airEncounterSlot} refused: ${result?.errorMsg}`);
}

// The burning ships: worn to their scar, never healed back from more damage.
function scar(scene, site) {
  const health = require("../../space/runtime/shipHealthState");
  for (const [key, wound] of Object.entries(SCARS)) {
    const ship = actor(scene, site, key);
    if (!ship) continue;
    const condition = ship.conditionState || {};
    const next = {
      ...condition,
      shieldCharge: Math.min(condition.shieldCharge ?? 1, wound.shieldCharge),
      armorDamage: Math.max(condition.armorDamage || 0, wound.armorDamage),
      damage: Math.max(condition.damage || 0, wound.damage),
    };
    if (["shieldCharge", "armorDamage", "damage"].every(field => next[field] === (condition[field] ?? (field === "shieldCharge" ? 1 : 0)))) continue;
    ship.conditionState = next;
    health.broadcastDamageStateChange(scene, ship);
  }
}

// Every order the lesson's progress (airCombatRuntime state) calls for, given again after each
// step and after a relog: an NPC keeps a repeated order as it is.
function apply(scene, site, combat) {
  if (!scene || !site || combat?.deaths?.pod?.status === "complete") return;
  const alive = key => !combat.destroyed?.[key];
  const cruiser = actor(scene, site, CRUISER);
  const closing = Boolean(combat.webbed && cruiser && alive(CRUISER));
  for (const [hostileKey, shipKey] of combat?.battle?.duels ? DUELS : []) {
    const hostile = actor(scene, site, hostileKey), ship = actor(scene, site, shipKey);
    if (!hostile || !ship || !alive(hostileKey)) continue;
    engage(hostile, ship, DUEL_ORBIT_METERS);
    if (!(closing && CLOSING_ON_CRUISER.includes(shipKey))) engage(ship, hostile, DUEL_ORBIT_METERS);
  }
  if (closing) for (const key of CLOSING_ON_CRUISER) engage(actor(scene, site, key), cruiser, CLOSING_ORBIT_METERS);
  const transport = actor(scene, site, HELD_TRANSPORT);
  if (combat.battle?.battleships && !combat.deaths) {
    for (const key of BATTLESHIPS) {
      const battleship = actor(scene, site, key);
      // From their station: the transport lies within their reach there, and the pilot's
      // lesson, the ECM and their attack after it, is fought at that station.
      if (battleship) engage(battleship, transport, orbitFor(battleship), "hold");
    }
  }
  // Freed by the ECM, the last transport warps away (warpOff: it is removed once landed).
  if (combat.deaths?.ship && transport && !hasCompletedDeparture(require("./airEncounterJobs").state(site.ownership.characterID), site.instanceID, HELD_TRANSPORT) && npcs().getControllerByEntityID(transport.itemID)?.manualOrder?.type !== "warpOff") {
    const result = npcs().issueManualOrder(transport.itemID, { type: "warpOff", awayFromPosition: actor(scene, site, BATTLESHIPS[0])?.position || null });
    if (!result?.success) log().warn(`[AirFleetBattle] ${HELD_TRANSPORT} escape refused: ${result?.errorMsg}`);
  }
}

module.exports = { scar, apply, hasCompletedDeparture, recordCompletedDeparture, SCARS, DUELS, HELD_TRANSPORT };
