"use strict";

// EveJS RPG fork: builds the real combat site for a contract.
//
// A contract site is an ordinary EveJS dungeon instance. It borrows a
// single-room pirate "Hideaway" template for scenery and replaces the contents
// per contract through spawnState.populationHints: our waves, a named boss that
// is the objective target, and a strongbox. EveJS's own site service then
// spawns it when the pilot warps in, tracks the kills and retires the site.

const path = require("path");

const dungeonRuntime = require(path.join(__dirname, "../../services/dungeon/dungeonRuntime"));
const bookmarkRuntime = require(path.join(__dirname, "../../services/bookmark/bookmarkRuntimeState"));
const bookmarkNotifications = require(path.join(__dirname, "../../services/bookmark/bookmarkNotifications"));
const { TYPE_SOLAR_SYSTEM } = require(path.join(__dirname, "../../services/bookmark/bookmarkConstants"));
const log = require(path.join(__dirname, "../../utils/logger"));

const SITE_ID_BASE = 6800000000000; // dungeonUniverseSiteService MANUAL_DUNGEON_SITE_ID_BASE
const ROOM = "room:entry_pocket";
const SITE_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;
const BOSS_KEY = "boss";
// Our own spawn family. Without it the instance looks like a stray universe
// "combat" site and EveJS's background reconcile (dungeonRuntime family
// filter) deletes it; no reconcile job is ever named this, so it is left alone.
const SPAWN_FAMILY = "rpg_contract";

function populationHints(contract) {
  const { forces, cache } = contract.facts;
  const { story } = contract;
  const encounters = forces.waves.map((wave, index) => ({
    key: `wave_${index + 1}`,
    label: `Wave ${index + 1}`,
    supported: true,
    spawnQuery: wave[0].profileID,
    amount: wave.length,
    trigger: index === 0 ? "on_load" : "wave_cleared",
    ...(index === 0 ? {} : { prerequisiteKey: `wave_${index}` }),
    waveIndex: index + 1,
    roomKey: ROOM,
    spawnEntries: wave.map((unit, slot) => ({ key: `wave_${index + 1}_${slot + 1}`, profileID: unit.profileID })),
  }));
  encounters.push({
    key: "leader",
    label: story.bossName,
    supported: true,
    spawnQuery: forces.boss.profileID,
    amount: 1 + forces.escorts.length,
    trigger: "wave_cleared",
    prerequisiteKey: `wave_${forces.waves.length}`,
    waveIndex: forces.waves.length + 1,
    roomKey: ROOM,
    spawnEntries: [
      { key: BOSS_KEY, profileID: forces.boss.profileID, slimName: story.bossName, objectiveTarget: true },
      ...forces.escorts.map((unit, slot) => ({ key: `escort_${slot + 1}`, profileID: unit.profileID })),
    ],
  });
  return {
    source: "evejs_rpg_contract",
    siteFamily: "combat",
    siteKind: "anomaly",
    encounters,
    containers: cache.length ? [{
      role: "cargo",
      typeNameCandidates: ["Cargo Container"],
      label: `${story.bossName}'s Strongbox`,
      count: 1,
      explicitLoot: cache.map(({ typeID, quantity }) => ({ typeID, quantity })),
    }] : [],
    // Only the leader's death completes the job; the rest of the pack is optional.
    completion: { mode: "objective_target_destroyed", objectiveTargets: [{ key: BOSS_KEY }] },
  };
}

function siteKey(characterID, contract) {
  return `rpg-contract:${characterID}:${contract.id}`;
}

/**
 * Create the site and its bookmark. Safe to call again for the same contract:
 * an existing active site is reused.
 * @returns {{instanceID: number, siteID: number, bookmarkID: number|null, bookmarkFolderID: number|null, bookmarkInstanceID: number|null}}
 */
function createSite(characterID, contract) {
  const key = siteKey(characterID, contract);
  let instance = dungeonRuntime.findInstanceBySiteKey(key, { full: true });
  // A site built before the family tag existed is exposed to the reconcile: rebuild it.
  if (instance && instance.lifecycleState === "active" && instance.metadata?.spawnFamilyKey !== SPAWN_FAMILY) {
    dungeonRuntime.purgeInstance(instance.instanceID);
    instance = null;
  }
  if (!instance || instance.lifecycleState !== "active") {
    const siteID = SITE_ID_BASE + dungeonRuntime.peekNextInstanceID();
    const nowMs = Date.now();
    instance = dungeonRuntime.createInstance({
      templateID: contract.facts.templateID,
      solarSystemID: contract.facts.systemID,
      siteKey: key,
      lifecycleState: "active",
      instanceScope: "private",
      ownership: { characterID, visibilityScope: "private" },
      siteFamily: "combat",
      siteKind: "anomaly",
      siteOrigin: "authored_operation",
      position: contract.facts.position,
      nowMs,
      activatedAtMs: nowMs,
      expiresAtMs: nowMs + SITE_LIFETIME_MS,
      spawnState: { siteID, label: contract.story.siteName, entryObjectTypeID: null, populationHints: populationHints(contract) },
      runtimeFlags: { universeSeeded: true, universePersistent: false, lazyMaterialized: false, manualSpawn: true },
      metadata: {
        providerID: "rpgContract",
        siteID,
        label: contract.story.siteName,
        manualSpawn: true,
        requestedByCharacterID: characterID,
        rpgContractID: contract.id,
        rpgContractCharacterID: characterID,
        spawnFamilyKey: SPAWN_FAMILY,
      },
      durable: true,
    });
  }

  let bookmarkID = contract.bookmarkID || null;
  let bookmarkFolderID = contract.bookmarkFolderID || null;
  // A bookmark made before the site link existed (or for an older instance) is replaced.
  if (bookmarkID && Number(contract.bookmarkInstanceID) !== Number(instance.instanceID)) {
    removeBookmark(characterID, contract);
    bookmarkID = null;
  }
  if (!bookmarkID) {
    try {
      // The pilot's own default folder: the client already shows it, so the
      // new location appears in People & Places straight away.
      const folder = bookmarkRuntime.ensureDefaultPersonalFolder(characterID);
      const created = bookmarkRuntime.createBookmark(characterID, {
        folderID: folder.folderID,
        memo: `${contract.story.title}: ${contract.story.siteName}`,
        note: `Contract from ${contract.story.clientName}. Target: ${contract.story.bossName}.`,
        itemID: contract.facts.systemID,
        typeID: TYPE_SOLAR_SYSTEM,
        locationID: contract.facts.systemID,
        x: contract.facts.position.x,
        y: contract.facts.position.y,
        z: contract.facts.position.z,
        // missionInstanceID is what the warp handler (beyonceService CmdWarpToStuff)
        // reads to spawn the site's contents and put the pilot inside its private
        // pocket. Without it the pilot arrives at an empty point in space.
        metadata: { role: "rpgContract", rpgContractID: contract.id, missionInstanceID: instance.instanceID },
      });
      bookmarkID = Number(created?.bookmark?.bookmarkID) || null;
      bookmarkFolderID = Number(created?.bookmark?.folderID || folder.folderID) || null;
      if (bookmarkID) bookmarkNotifications.notifyBookmarksAdded(bookmarkFolderID, [created.bookmark]);
    } catch (error) {
      log.warn(`[Contracts] bookmark for ${contract.id} failed: ${error.message}`);
    }
  }
  return {
    instanceID: instance.instanceID,
    siteID: Number(instance.metadata?.siteID) || 0,
    bookmarkID,
    bookmarkFolderID,
    bookmarkInstanceID: bookmarkID ? instance.instanceID : null,
  };
}

function removeBookmark(characterID, contract) {
  if (!contract.bookmarkID || !contract.bookmarkFolderID) return;
  try {
    const removed = bookmarkRuntime.deleteBookmarks(characterID, contract.bookmarkFolderID, [contract.bookmarkID]);
    bookmarkNotifications.notifyBookmarksRemoved(contract.bookmarkFolderID, Array.isArray(removed) ? removed : [contract.bookmarkID]);
  } catch (error) {
    log.warn(`[Contracts] could not remove bookmark ${contract.bookmarkID}: ${error.message}`);
  }
}

// Used when a contract is abandoned. A completed site is left alone: EveJS
// retires it on its own timer, which keeps the strongbox lootable.
function removeSite(characterID, contract) {
  removeBookmark(characterID, contract);
  if (!contract.instanceID) return;
  try {
    dungeonRuntime.purgeInstance(contract.instanceID);
  } catch (error) {
    log.warn(`[Contracts] could not purge site ${contract.instanceID}: ${error.message}`);
  }
}

function objectiveMet(instance) {
  return Number(instance?.objectiveSatisfiedAtMs) > 0;
}

module.exports = { createSite, removeSite, removeBookmark, objectiveMet, populationHints, BOSS_KEY };
