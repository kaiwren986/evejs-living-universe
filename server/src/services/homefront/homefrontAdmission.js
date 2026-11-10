"use strict";
const worldData = require("../../space/worldData");
const dungeon = require("../dungeon/dungeonRuntime");
const fleet = () => require("../fleets/fleetRuntime");
const crimewatch = () => require("../security/crimewatchState");
const character = (session) =>
  Number(session.characterID || session.charid || 0);
const fleetID = (characterID) =>
  Number(fleet().getFleetForCharacter(characterID)?.fleetID || 0);
function isExordium(systemID) {
  return Number(worldData.getSolarSystemByID(systemID)?.regionID) === 10001004;
}
function owner(instance) {
  return (
    dungeon.getInstance(instance.instanceID)?.environmentState
      ?.homefrontAdmission || null
  );
}
function outsider(instance, session) {
  const claim = owner(instance);
  if (!claim) return false;
  const characterID = character(session);
  const ownerFleetID = fleetID(claim.characterID);
  return ownerFleetID
    ? fleetID(characterID) !== ownerFleetID
    : characterID !== claim.characterID;
}
function preflight(instance, session, now = Date.now()) {
  if (!require("./homefrontRuntime").isSite(instance)) return null;
  const outside = outsider(instance, session);
  if (outside && isExordium(instance.solarSystemID))
    return "This Homefront operation is occupied by another fleet.";
  if (
    outside &&
    crimewatch().getSafetyLevel(character(session), now) ===
      crimewatch().SAFETY_LEVEL_FULL
  )
    return "Entering another fleet's Homefront operation is a suspect action. Change your safety setting to enter.";
  return null;
}
function claim(instance, session, now = Date.now()) {
  if (!require("./homefrontRuntime").isSite(instance)) return;
  const ship = require("../../space/runtime")
    .getSceneForSession(session)
    ?.getShipEntityForSession(session);
  if (ship) require("./homefrontCargo").cleanup(ship);
  // Keeper's gate activation is synchronous: no await separates preflight,
  // successful movement and this durable first-activation claim.
  if (!owner(instance))
    dungeon.mergeEnvironmentStateDurably(
      instance.instanceID,
      {
        homefrontAdmission: {
          characterID: character(session),
          fleetID: fleetID(character(session)),
          claimedAtMs: now,
        },
      },
      { nowMs: now },
    );
  else if (outsider(instance, session)) {
    const result = crimewatch().recordHomefrontIntrusion(
      character(session),
      instance.solarSystemID,
      now,
    );
    if (!result.success) throw new Error(result.errorMsg);
  }
  const scene = require("../../space/runtime").getSceneForSession(session);
  if (scene) syncGates(scene, instance);
}

function gateFields(instance) {
  if (!require("./homefrontRuntime").isSite(instance)) return {};
  return {
    // appConst.dungeonKeySoftLockOwnerSuspect. Exordium denies outsiders rather
    // than offering a suspect action in its protected space.
    dunKeyLock: isExordium(instance.solarSystemID) ? 0 : 5,
    dunOwnerLock: owner(instance)?.characterID || null,
  };
}

function syncGates(scene, instance) {
  const fields = gateFields(instance);
  const changed = [];
  for (const entity of scene.staticEntitiesByID.values()) {
    if (
      entity.kind !== "siteAccelerationGate" ||
      entity.dungeonSiteInstanceID !== instance.instanceID
    )
      continue;
    if (
      entity.dunKeyLock === fields.dunKeyLock &&
      entity.dunOwnerLock === fields.dunOwnerLock
    )
      continue;
    Object.assign(entity, fields);
    changed.push(entity);
  }
  if (changed.length) scene.broadcastSlimItemChanges(changed);
}

function syncOwnership(scene, instance, ships, now) {
  const current = owner(instance);
  const currentFleetID = current ? fleetID(current.characterID) : 0;
  const present =
    current &&
    ships.some(
      (ship) =>
        require("./homefrontRuntime").character(ship) === current.characterID,
    );
  const arriving =
    current &&
    [...scene.dynamicEntities.values()].some(
      (entity) =>
        require("./homefrontRuntime").character(entity) ===
          current.characterID &&
        entity.dungeonCurrentInstanceID === instance.instanceID &&
        require("../../space/destiny/simulation/warpPhase").isEntityInActiveWarp(
          entity,
        ),
    );
  if (!present && !arriving && (current || ships.length)) {
    const candidates = [...ships].sort(
      (left, right) =>
        require("./homefrontRuntime").character(left) -
        require("./homefrontRuntime").character(right),
    );
    const successor =
      candidates.find(
        (ship) =>
          currentFleetID &&
          fleetID(require("./homefrontRuntime").character(ship)) ===
            currentFleetID,
      ) || candidates[0];
    const characterID = successor
      ? require("./homefrontRuntime").character(successor)
      : 0;
    dungeon.mergeEnvironmentStateDurably(
      instance.instanceID,
      {
        homefrontAdmission: characterID
          ? { characterID, fleetID: fleetID(characterID), claimedAtMs: now }
          : null,
      },
      { nowMs: now },
    );
  }
  syncGates(scene, instance);
}

module.exports = {
  isExordium,
  owner,
  outsider,
  preflight,
  claim,
  gateFields,
  syncOwnership,
};
