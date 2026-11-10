"use strict";

module.exports = {
  hasKnownNativeControllerSceneRematerializer,
  hasValidDungeonNativeSceneOwner,
  storedNativeRecordBelongsToSolarSystemScene,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const nativeNpcStore = require(path.join(runtimeEntryDirname, "./npc/nativeNpcStore"));
const {
  toInt,
} = require("../../common/numbers");
const {
  SCENE_KIND_SOLAR_SYSTEM,
  normalizeSceneText,
} = require("./sceneIdentity");

function storedNativeRecordBelongsToSolarSystemScene(record, scene) {
  if (!record || !scene) {
    return false;
  }
  const systemID = toInt(scene.systemID, 0);
  if (systemID <= 0 || toInt(record.systemID, toInt(record.locationID, 0)) !== systemID) {
    return false;
  }

  const recordSceneKind = normalizeSceneText(record.sceneKind, "").toLowerCase();
  if (
    recordSceneKind &&
    recordSceneKind !== SCENE_KIND_SOLAR_SYSTEM.toLowerCase()
  ) {
    return false;
  }
  const recordSceneKey = normalizeSceneText(record.sceneKey, "");
  return !recordSceneKey || recordSceneKey === normalizeSceneText(scene.sceneKey, "");
}

// General NPC startup only knows how to rebuild startup/operator presence, and
// dungeon startup only knows how to rehydrate fully-owned site content. Mining,
// GM/ad-hoc, and AIR NPE controllers have no scene-created rematerializer, so
// retaining their store rows after the exact scene is released would orphan
// their entity/module/cargo authority indefinitely.
function hasValidDungeonNativeSceneOwner(record) {
  if (!record || record.dungeonMaterializedSiteContent !== true) {
    return false;
  }
  const scopeResolution = nativeNpcStore.validateStoredEntityScopeMetadata(record);
  const metadata = scopeResolution && scopeResolution.data && scopeResolution.data.metadata;
  return Boolean(
    scopeResolution &&
      scopeResolution.success === true &&
      metadata &&
      toInt(metadata.dungeonSiteID, 0) > 0 &&
      toInt(metadata.dungeonSiteInstanceID, 0) > 0
  );
}

function hasKnownNativeControllerSceneRematerializer(
  controllerRecord,
  entityRecord,
  scene,
) {
  if (
    !storedNativeRecordBelongsToSolarSystemScene(controllerRecord, scene) ||
    !storedNativeRecordBelongsToSolarSystemScene(entityRecord, scene)
  ) {
    return false;
  }
  if (
    normalizeSceneText(controllerRecord.startupRuleID, "") ||
    normalizeSceneText(controllerRecord.operatorKind, "")
  ) {
    return true;
  }
  return hasValidDungeonNativeSceneOwner(entityRecord);
}
