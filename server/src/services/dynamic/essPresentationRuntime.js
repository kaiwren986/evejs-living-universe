"use strict";

const {
  SCENE_KIND_SOLAR_SYSTEM,
  buildSolarSystemSceneKey,
} = require("../../space/runtime/sceneIdentity");

const ESS_TYPE_ID = 55914;
const PRESENTATION_FIELDS = ["reserveUnlocked", "reserveLinkCount", "mainLinkCount"];
const SPACE_RUNTIME_MODULE_PATH = require.resolve("../../space/runtime");

function linkCount(linkedCharacters) {
  const values = linkedCharacters instanceof Set
    ? [...linkedCharacters]
    : Array.isArray(linkedCharacters) ? linkedCharacters : [];
  return new Set(values.map(Number).filter(value => Number.isSafeInteger(value) && value > 0)).size;
}

function presentationFor(bankState) {
  return {
    reserveUnlocked: Number(bankState?.reserveBankPulsesRemaining) > 0,
    reserveLinkCount: linkCount(bankState?.reserveLinkedCharacterIDs),
    mainLinkCount: bankState?.mainBankLink ? 1 : 0,
  };
}

// This is a scene projection of already committed bank state. Packet builders
// read only the entity fields; they never discover banks or read the store.
function refreshScene(scene, bankState, options = {}) {
  if (!scene || scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM ||
      bankState && Number(bankState.solarSystemID) !== Number(scene.systemID)) return 0;
  let refreshed = 0;
  for (const entity of scene.staticEntities || []) {
    if (Number(entity.typeID) !== ESS_TYPE_ID || entity.airNpeOwnerCharacterID ||
        entity.airNpeInstanceID || entity.staticVisibilityScope !== "publicgrid") continue;
    const currentState = Number(bankState?.essID) === Number(entity.itemID) ? bankState : null;
    const next = presentationFor(currentState);
    const changed = PRESENTATION_FIELDS.some(field => entity[field] !== next[field]);
    if (!changed && !entity._essPresentationPending) continue;
    Object.assign(entity, next);
    refreshed += 1;
    if (options.broadcast === false) {
      entity._essPresentationPending = false;
      continue;
    }
    // A failed queue remains dirty for the next refresh. Retrying a slim-state
    // update is harmless and cannot change the durable money/link records.
    entity._essPresentationPending = true;
    if (scene.broadcastSlimItemChanges([entity]) > 0) entity._essPresentationPending = false;
  }
  return refreshed;
}

function refreshSystem(systemID, bankState) {
  // Offline settlement must not boot the space singleton, its timer or scenes
  // merely to publish an animation to a system with no loaded observers.
  const runtime = require.cache[SPACE_RUNTIME_MODULE_PATH]?.exports;
  const scene = runtime?.scenes?.get(buildSolarSystemSceneKey(systemID));
  return scene ? refreshScene(scene, bankState) : 0;
}

module.exports = { refreshScene, refreshSystem };
