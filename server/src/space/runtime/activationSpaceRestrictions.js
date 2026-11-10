"use strict";

module.exports = {
  isCovertCynosuralModuleType,
  resolveAbyssalCloakActivationRestriction,
  resolveAbyssalCynosuralActivationRestriction,
  resolveAbyssalTeleportRestriction,
  resolveAbyssalWarpActivationRestriction,
  resolveCynosuralActivationSpaceRestriction,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  resolveRestrictionCharacterID,
  resolveRestrictionShipID,
  resolveActiveRunPocketState,
  buildRunRestriction,
  resolveAbyssalRunActivationRestriction,
} = require("../../abyssal").engineSupport.activationRules;
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  getAbyssalMgrServiceModule,
} = require("./abyssalServicePort");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  getAbyssalRuntimeSceneAuthority,
  getAbyssalSessionSceneAuthority,
} = require("./sceneIdentity");
const {
  getSystemSecurityClass,
} = require("./systemSecurityBand");
const {
  getTypeDogmaAttributeValueByID,
} = require("./typeAttributeLookup");
const abyssalRoomEntityModule = require("./abyssalRoomEntity");

function resolveAbyssalCloakActivationRestriction(session, entity = null) {
  const abyssalMgrService = getAbyssalMgrServiceModule();
  const sceneAuthority = getAbyssalSessionSceneAuthority(session);
  if (
    abyssalMgrService &&
    typeof abyssalMgrService.isAbyssalRestrictionBypassAllowed === "function" &&
    abyssalMgrService.isAbyssalRestrictionBypassAllowed({
      session,
      restriction: "cloak_activation",
    })
  ) {
    return null;
  }

  const characterID = toInt(
    session && (
      session.characterID ||
      session.charID ||
      session.charid
    ),
    0,
  );
  if (
    abyssalMgrService &&
    characterID > 0 &&
    typeof abyssalMgrService.isCharacterInActiveAbyssalRun === "function" &&
    abyssalMgrService.isCharacterInActiveAbyssalRun(characterID)
  ) {
    return {
      blocked: true,
      characterID,
      shipID: toInt(entity && entity.itemID, toInt(session && session.shipID, 0)),
      reason: "ABYSSAL_ACTIVE_RUN",
      errorMsg: "ABYSSAL_CLOAK_RESTRICTED",
    };
  }

  const shipID = toInt(entity && entity.itemID, toInt(session && session.shipID, 0));
  if (
    abyssalMgrService &&
    shipID > 0 &&
    typeof abyssalMgrService.isShipInActiveAbyssalRun === "function" &&
    abyssalMgrService.isShipInActiveAbyssalRun(shipID)
  ) {
    return {
      blocked: true,
      characterID,
      shipID,
      reason: "ABYSSAL_ACTIVE_RUN",
      errorMsg: "ABYSSAL_CLOAK_RESTRICTED",
    };
  }

  if (sceneAuthority) {
    return {
      blocked: true,
      characterID,
      shipID,
      instanceID: sceneAuthority.instanceID,
      reason: "ABYSSAL_SCENE_AUTHORITY",
      errorMsg: "ABYSSAL_CLOAK_RESTRICTED",
    };
  }

  return null;
}

// A covert cyno is the SDE's own exception, marked by attribute 1252 `isCovert`
// ("Uses Covert Cynosural Field Technology"), declared 1 on 28646 alone. The
// V24 client reads exactly that attribute to size the module's tactical
// overlay ring (parklife/tactical.py:749), so it is the game's covert
// predicate rather than a typeID list.
const MODULE_ATTRIBUTE_IS_COVERT = getAttributeIDByNames("isCovert") || 1252;

function isCovertCynosuralModuleType(moduleTypeID) {
  return toFiniteNumber(
    getTypeDogmaAttributeValueByID(
      toInt(moduleTypeID, 0),
      MODULE_ATTRIBUTE_IS_COVERT,
      0,
    ),
    0,
  ) > 0;
}

// Two rules TQ enforces server-side rather than through dogma — neither cyno
// type carries `disallowInHighSec` (1970), and no effect declares a jammer row:
//
//   * High security space. EVE University's System security page lists
//     "Cynosural fields cannot create beacons for jump drives" among the
//     high-sec rules; low sec and null are both fine.
//     https://wiki.eveuniversity.org/System_security
//   * A Cynosural System Jammer. The jammer's own in-game description is
//     "Creates a system-wide inhibitor field which prevents cynosural
//     generators except covert cynosural generators from functioning", and
//     CCP Rise's industrial cyno FAQ answers "can it be lit in cyno jammed
//     systems?" with "No".
//     https://forums.eveonline.com/t/chaos-era-continues-cyno-update/182197
//
// The jammer stops a module *starting a new cycle*; fields already burning are
// left alone, which is why this is an activation gate and not a tick sweep.
// `isSolarSystemCynoJammed` is the same predicate beyonceService already gates
// the jump *destination* on, with the same covert exemption.
function resolveCynosuralActivationSpaceRestriction(scene, moduleItem) {
  const systemID = toInt(scene && scene.systemID, 0);
  if (systemID <= 0) {
    return null;
  }

  if (getSystemSecurityClass(worldData.getSolarSystemByID(systemID)) === 2) {
    return {
      blocked: true,
      systemID,
      reason: "HIGH_SECURITY_SPACE",
      errorMsg: "MODULE_DISALLOWED_IN_HIGHSEC",
    };
  }

  if (isCovertCynosuralModuleType(moduleItem && moduleItem.typeID)) {
    return null;
  }

  if (require("../../services/incursion/incursionSystemEffects").blocksCyno(systemID)) {
    return { blocked: true, systemID, reason: "INCURSION_SYSTEM_JAMMER", errorMsg: "CYNOSURAL_FIELD_JAMMED" };
  }

  const { isSolarSystemCynoJammed } = lazyRequire(
    "../services/sovereignty/sovSuppressionState",
  );
  if (typeof isSolarSystemCynoJammed === "function" && isSolarSystemCynoJammed(systemID)) {
    return {
      blocked: true,
      systemID,
      reason: "CYNOSURAL_SYSTEM_JAMMER",
      errorMsg: "CYNOSURAL_FIELD_JAMMED",
    };
  }

  return null;
}

function resolveAbyssalCynosuralActivationRestriction(session, entity = null, scene = null) {
  return resolveAbyssalRunActivationRestriction({
    abyssalMgrService: getAbyssalMgrServiceModule(),
    session,
    entity,
    sceneAuthority:
      getAbyssalSessionSceneAuthority(session) ||
      getAbyssalRuntimeSceneAuthority(scene),
    restriction: "cynosural_activation",
    errorMsg: "CYNOSURAL_FIELD_NOT_ALLOWED_IN_ABYSSAL_DEADSPACE",
    preferEntityShipID: true,
  });
}

function resolveAbyssalWarpActivationRestriction(session) {
  return resolveAbyssalRunActivationRestriction({
    abyssalMgrService: getAbyssalMgrServiceModule(),
    session,
    sceneAuthority: getAbyssalSessionSceneAuthority(session),
    restriction: "warp",
    errorMsg: "ABYSSAL_WARP_RESTRICTED",
  });
}

function resolveAbyssalTeleportRestriction(
  session,
  entity = null,
  scene = null,
  options = {},
) {
  const ABYSSAL_TELEPORT_TRANSITION_BYPASS = abyssalRoomEntityModule.ABYSSAL_TELEPORT_TRANSITION_BYPASS;
  if (options && options[ABYSSAL_TELEPORT_TRANSITION_BYPASS] === true) {
    return null;
  }

  const abyssalMgrService = getAbyssalMgrServiceModule();
  const sceneAuthority =
    getAbyssalSessionSceneAuthority(session) ||
    getAbyssalRuntimeSceneAuthority(scene);
  const characterID = resolveRestrictionCharacterID(session, entity, {
    entityFallback: true,
  });
  const shipID = resolveRestrictionShipID(session, entity, { preferEntity: true });
  const pocketState = resolveActiveRunPocketState(
    abyssalMgrService,
    characterID,
    shipID,
  );
  // Teleport alone narrows the scene-authority case to player ships: an NPC may
  // still be teleported inside an Abyssal scene, a pilot may not. This is why
  // teleport composes the primitives rather than using the shared cyno/warp shape.
  const isPlayerShip = Boolean(
    session ||
    entity && entity.session ||
    entity && entity.kind === "ship" && characterID > 0,
  );
  return buildRunRestriction({
    characterID,
    shipID,
    pocketState,
    sceneAuthority: isPlayerShip ? sceneAuthority : null,
    errorMsg: "ABYSSAL_TELEPORT_RESTRICTED",
  });
}

Object.assign(module.exports, {
  MODULE_ATTRIBUTE_IS_COVERT,
});
