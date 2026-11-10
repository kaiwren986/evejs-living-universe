"use strict";

const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function online(item) {
  const state = item && item.spaceState;
  return Boolean(state && state.onlineState === "online" && Number(state.online) === 1 &&
    state.anchorState === "anchored" && !(item.conditionState && item.conditionState.incapacitated));
}

function validAllianceID(corporationID) {
  const corporations = require("../corporation/corporationState");
  const corporation = corporations.getCorporationRecord(corporationID);
  const allianceID = id(corporation && !corporation.deleted && corporation.allianceID);
  const alliance = allianceID && corporations.getAllianceRecord(allianceID);
  return alliance && !alliance.deleted && corporations.getAllianceCorporationIDs(allianceID).includes(corporationID)
    ? allianceID : 0;
}

function resolveTargetIdentity(entity) {
  const inventory = require("../inventory/itemStore");
  const characters = require("../character/characterState");
  const sourceID = id(entity && entity.session && entity.session.characterID) ||
    id(entity && entity.pilotCharacterID) || id(entity && entity.characterID);
  const stored = inventory.findItemById(id(entity && entity.itemID));
  const character = characters.getCharacterRecord(sourceID || id(stored && stored.ownerID));
  if (character && !character.isDeleted && !character.deletedAt) {
    const corporationID = id(character.corporationID);
    return { characterID: id(character.characterID || sourceID || stored.ownerID), corporationID,
      allianceID: validAllianceID(corporationID), securityStatus: Number(character.securityStatus ?? character.securityRating) || 0 };
  }
  const corporationID = id(stored && stored.ownerID);
  const corporation = corporationID && require("../corporation/corporationState").getCorporationRecord(corporationID);
  return corporation && !corporation.deleted
    ? { characterID: 0, corporationID, allianceID: validAllianceID(corporationID), securityStatus: null }
    : null;
}

function getTowerContacts(tower, allianceID, settings) {
  const runtime = require("../corporation/corporationRuntimeState");
  const source = settings.useAllianceStandings && allianceID
    ? runtime.getAllianceRuntime(allianceID) : runtime.getCorporationRuntime(tower.ownerID);
  return source && source.contacts || {};
}

function resolveContactStanding(contacts, identity) {
  // The client exposes contact standings but not the private sentry precedence.
  // An explicit pilot entry overrides corporation, then alliance; absent = 0.
  for (const contactID of [identity.characterID, identity.corporationID, identity.allianceID]) {
    if (contactID && Object.prototype.hasOwnProperty.call(contacts, String(contactID))) {
      const row = contacts[String(contactID)];
      return Number(row && row.relationshipID) || 0;
    }
  }
  return 0;
}

function evaluateSentryTargetPolicy(context, identity, facts = {}) {
  if (!identity || identity.corporationID === Number(context.tower.ownerID) ||
      (context.allianceID && identity.allianceID === context.allianceID)) return null;
  const settings = context.settings;
  if (settings.war && facts.atWar) return "war";
  // moonmining.py:1123-1126 hides standing/security thresholds in highsec.
  if (!context.highSecurity && settings.standing !== null && settings.standing !== undefined &&
      resolveContactStanding(context.contacts, identity) < settings.standing) return "standing";
  if (!context.highSecurity && settings.securityStatus !== null && settings.securityStatus !== undefined &&
      Number.isFinite(identity.securityStatus) && identity.securityStatus < settings.securityStatus) return "securityStatus";
  // A timer alone is not proof of a security drop. Only an actual persisted
  // security-penalty receipt can drive the client's statusDrop setting.
  const drop = facts.securityStatusDrop;
  if (settings.statusDrop && drop && Number(drop.expiresAtMs) > context.nowMs &&
      Number(drop.atMs) <= context.nowMs && Number(drop.nextSecurityStatus) < Number(drop.previousSecurityStatus) &&
      Number(drop.systemID) === Number(context.systemID)) return "securityStatusDrop";
  return null;
}

function candidateVisible(entity, towerEntity) {
  return Boolean(entity && entity.kind === "ship" && !entity.destroyed && !entity.destroying &&
    !["destroyed", "destroying"].includes(entity.destructionState) &&
    !entity.isCloaked && !entity.cloaked && !entity.pendingDock &&
    !(entity.mode === "WARP" && Number(entity.effectStamp) >= 0) &&
    canEntitiesInteractLocally(towerEntity, entity));
}

function squaredDistance(left, right) {
  if (!left || !right || !left.position || !right.position) return Infinity;
  return ["x", "y", "z"].reduce((total, key) => total + (Number(left.position[key]) - Number(right.position[key])) ** 2, 0);
}

function createStarbaseDefenseController(deps = {}) {
  const sceneStates = new WeakMap();
  const getItems = deps.getItems || ((scene) => {
    const now = Date.now();
    return require("../inventory/itemStore").listStarbaseItems({ systemID: scene.systemID })
      .filter((item) => Number(item.locationID) === Number(scene.systemID) && Number(item.flagID) === 0 &&
        (!Number.isFinite(Number(item.expiresAtMs)) || Number(item.expiresAtMs) > now));
  });
  const identityFor = deps.identityFor || resolveTargetIdentity;
  const allianceFor = deps.allianceFor || ((tower) => validAllianceID(Number(tower.ownerID)));
  const contactsFor = deps.contactsFor || getTowerContacts;
  const crimewatchFor = deps.crimewatchFor || ((characterID, nowMs) =>
    require("../security/crimewatchState").getCharacterCrimewatchState(characterID, nowMs));
  const warFor = deps.warFor || ((tower, identity, nowMs) => identity.characterID &&
    require("../corporation/warRuntimeState").findActiveWarBetweenCharacterAndCorporation(
      identity.characterID, tower.ownerID, { nowMs },
    ));
  const highSecurityFor = deps.highSecurityFor || ((scene) => require("../security/crimewatchState").isHighSecuritySystem(scene.system));

  function release(scene, adapter, controller, batteryID, reason) {
    adapter.stopBattery(scene, batteryID, { reason, automaticOnly: true });
    controller.assignments.delete(batteryID);
  }

  function tickScene(scene, nowMs, options = {}) {
    if (!scene || !(scene.dynamicEntities instanceof Map)) return { towers: 0, candidates: 0, assignments: 0 };
    const adapter = options.adapter || deps.adapter || require("./starbaseDefenseRuntime");
    let states = sceneStates.get(scene);
    if (!states) sceneStates.set(scene, states = new Map());
    const items = getItems(scene);
    const byID = new Map(items.map((item) => [id(item.itemID), item]));
    const batteriesByTower = new Map();
    for (const item of items) {
      const towerID = id(item.spaceState && item.spaceState.controlTowerID || item.controlTowerID);
      const profile = towerID && adapter.getBatteryProfile(item);
      if (!towerID || !profile || profile.passive) continue;
      if (!batteriesByTower.has(towerID)) batteriesByTower.set(towerID, []);
      batteriesByTower.get(towerID).push(item);
    }
    // Snapshot physical candidates once per scene pulse. Policy facts are then
    // calculated once per tower, not by every battery independently.
    // No battery means no physical-candidate work, including after the last
    // battery is removed. The cleanup below still releases old assignments.
    const sceneCandidates = batteriesByTower.size
      ? [...scene.dynamicEntities.values()].filter((entity) => entity && entity.kind === "ship") : [];
    const identities = new Map();
    const activeTowers = new Set();
    const result = { towers: 0, candidates: 0, assignments: 0 };
    for (const [towerID, batteries] of batteriesByTower) {
      const tower = byID.get(towerID);
      const towerEntity = scene.getEntityByID(towerID);
      if (!tower || Number(tower.groupID) !== 365 || !online(tower) || !towerEntity ||
          towerEntity.destroyed || towerEntity.destroying ||
          ["destroyed", "destroying"].includes(towerEntity.destructionState)) continue;
      activeTowers.add(towerID);
      result.towers += 1;
      let controller = states.get(towerID);
      if (!controller) states.set(towerID, controller = { assignments: new Map() });
      const settings = require("./starbaseAccessRuntime").normalizeStarbaseAccessState(tower.spaceState.starbaseAccessState).sentry;
      const allianceID = allianceFor(tower);
      const context = { tower, allianceID, settings, contacts: contactsFor(tower, allianceID, settings),
        highSecurity: highSecurityFor(scene), nowMs, systemID: scene.systemID };
      const eligible = [];
      for (const entity of sceneCandidates) {
        if (!candidateVisible(entity, towerEntity)) continue;
        if (!identities.has(entity)) identities.set(entity, identityFor(entity));
        const identity = identities.get(entity);
        if (!identity) continue;
        const crimewatch = identity.characterID && settings.statusDrop ? crimewatchFor(identity.characterID, nowMs) : null;
        const reason = evaluateSentryTargetPolicy(context, identity, {
          atWar: settings.war && warFor(tower, identity, nowMs),
          securityStatusDrop: crimewatch && crimewatch.securityStatusDrop,
        });
        if (reason) eligible.push({ entity, reason });
      }
      eligible.sort((a, b) => squaredDistance(a.entity, towerEntity) - squaredDistance(b.entity, towerEntity) || id(a.entity.itemID) - id(b.entity.itemID));
      result.candidates += eligible.length;
      const eligibleByID = new Map(eligible.map((row) => [id(row.entity.itemID), row]));
      const liveBatteries = new Set();
      for (const battery of batteries) {
        const batteryID = id(battery.itemID);
        const entity = scene.getEntityByID(batteryID);
        const manual = entity && adapter.isBatteryManuallyControlled(entity);
        const validation = adapter.validateBatteryOperation(batteryID);
        if (!entity || entity.destroyed || entity.destroying ||
            ["destroyed", "destroying"].includes(entity.destructionState) ||
            manual || !validation || !validation.success) {
          if (controller.assignments.has(batteryID)) release(scene, adapter, controller, batteryID, manual ? "manualControl" : "batteryUnavailable");
          continue;
        }
        liveBatteries.add(batteryID);
        const previousID = controller.assignments.get(batteryID);
        if (previousID && !eligibleByID.has(previousID)) release(scene, adapter, controller, batteryID, "targetIneligible");
        const preferred = controller.assignments.get(batteryID);
        const choices = preferred ? [eligibleByID.get(preferred), ...eligible.filter((row) => id(row.entity.itemID) !== preferred)] : eligible;
        let assigned = false;
        for (const choice of choices) {
          const targetID = id(choice.entity.itemID);
          const activation = adapter.activateBattery(scene, batteryID, targetID, { nowMs, automatic: true });
          if (activation && (activation.success || activation.errorMsg === "TARGET_LOCK_PENDING")) {
            controller.assignments.set(batteryID, targetID);
            assigned = true;
            result.assignments += 1;
            break;
          }
          release(scene, adapter, controller, batteryID, activation && activation.errorMsg || "targetUnavailable");
        }
        if (!assigned && controller.assignments.has(batteryID)) release(scene, adapter, controller, batteryID, "noTarget");
      }
      for (const batteryID of [...controller.assignments.keys()]) {
        if (!liveBatteries.has(batteryID)) release(scene, adapter, controller, batteryID, "batteryRemoved");
      }
    }
    for (const [towerID, controller] of states) {
      if (activeTowers.has(towerID)) continue;
      for (const batteryID of [...controller.assignments.keys()]) release(scene, adapter, controller, batteryID, "towerUnavailable");
      states.delete(towerID);
    }
    return result;
  }

  function forgetStructure(scene, itemID) {
    const states = sceneStates.get(scene);
    if (!states) return;
    const adapter = deps.adapter || require("./starbaseDefenseRuntime");
    for (const [towerID, controller] of states) {
      for (const batteryID of [...controller.assignments.keys()]) {
        if (towerID === Number(itemID) || batteryID === Number(itemID)) {
          release(scene, adapter, controller, batteryID, "structureDestroyed");
        }
      }
      if (towerID === Number(itemID)) states.delete(towerID);
    }
  }

  return { tickScene, forgetStructure, getControllerCount: (scene) => sceneStates.get(scene)?.size || 0 };
}

const runtime = createStarbaseDefenseController();
module.exports = { tickScene: runtime.tickScene, forgetStructure: runtime.forgetStructure, createStarbaseDefenseController,
  evaluateSentryTargetPolicy, resolveContactStanding };
