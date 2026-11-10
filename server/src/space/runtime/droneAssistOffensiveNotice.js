"use strict";

module.exports = {
  isDroneAssistEligibleTargetedOffensiveEffect,
  noteDroneAssistSuccessfulOffensiveCycle,
  noteDroneAssistTargetedOffensiveAction,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  buildWeaponModuleSnapshot,
  isChargeOptionalTurretWeapon,
  isMissileWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
} = require(path.join(runtimeEntryDirname, "./combat/weaponDogma"));
const {
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");

function isDroneAssistEligibleTargetedOffensiveEffect(effectState) {
  return Boolean(
    effectState &&
      toInt(effectState.targetID, 0) > 0 &&
      effectState.smartbombEffect !== true &&
      effectState.pointDefenseEffect !== true &&
      effectState.jammerBurstEffect !== true &&
      effectState.autoTargetingMissileEffect !== true &&
      !isVortonWeaponFamily(effectState.weaponFamily) &&
      effectState.superweaponEffect !== true,
  );
}

function noteDroneAssistTargetedOffensiveAction(
  scene,
  assistedShipEntity,
  effectState,
  nowMs,
) {
  if (
    !scene ||
    typeof scene.getEntityByID !== "function" ||
    !assistedShipEntity ||
    !isDroneAssistEligibleTargetedOffensiveEffect(effectState)
  ) {
    return 0;
  }

  const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
  if (!targetEntity) {
    return 0;
  }

  try {
    const droneRuntime = lazyRequire("../services/drone/droneRuntime");
    if (
      !droneRuntime ||
      typeof droneRuntime.noteAssistedPilotOffensiveAction !== "function"
    ) {
      return 0;
    }
    return toInt(
      droneRuntime.noteAssistedPilotOffensiveAction(
        scene,
        assistedShipEntity,
        targetEntity,
        nowMs,
      ),
      0,
    );
  } catch (error) {
    log.warn(`[SpaceRuntime] Drone Assist offensive-action hook failed: ${error.message}`);
    return 0;
  }
}

function noteDroneAssistSuccessfulOffensiveCycle(
  scene,
  assistedShipEntity,
  effectState,
  cycleResult,
  cycleKind,
  nowMs,
) {
  if (!cycleResult || cycleResult.success !== true) {
    return 0;
  }

  const cycleData = cycleResult.data || null;
  const completedRelevantAction =
    (cycleKind === "turret" && Boolean(cycleData && cycleData.shotResult)) ||
    (cycleKind === "missile" && Boolean(cycleData && cycleData.missileEntity)) ||
    cycleKind === "jammer" ||
    cycleKind === "hostile";
  if (!completedRelevantAction) {
    return 0;
  }

  return noteDroneAssistTargetedOffensiveAction(
    scene,
    assistedShipEntity,
    effectState,
    nowMs,
  );
}
