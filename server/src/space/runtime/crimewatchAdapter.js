"use strict";

module.exports = {
  evaluateCrimewatchOffensiveAggression,
  evaluateEmpireUntargetedOffensiveActivation,
  recordCrimewatchOffensiveAggression,
  resolveSessionCrimewatchDockingRestriction,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");

function recordCrimewatchOffensiveAggression(scene, attackerEntity, targetEntity, nowMs) {
  if (!scene || !attackerEntity || !targetEntity) {
    return null;
  }
  if (targetEntity.homefrontKey)
    require("../../services/homefront/homefrontHooks").runtime.noteAggression(
      scene,
      attackerEntity,
      targetEntity,
      nowMs,
    );

  try {
    const crimewatchState = lazyRequire("../services/security/crimewatchState");
    if (
      crimewatchState &&
      typeof crimewatchState.recordHighSecCriminalAggression === "function"
    ) {
      return crimewatchState.recordHighSecCriminalAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    }
  } catch (error) {
    log.warn(`[SpaceRuntime] Crimewatch activation hook failed: ${error.message}`);
  }

  return null;
}

function evaluateCrimewatchOffensiveAggression(
  scene,
  attackerEntity,
  targetEntity,
  nowMs,
) {
  if (!scene || !attackerEntity || !targetEntity) {
    return { success: true, data: { reason: "NON_TARGETED_ACTION" } };
  }
  try {
    const crimewatchState = lazyRequire("../services/security/crimewatchState");
    if (
      crimewatchState &&
      typeof crimewatchState.evaluateOffensiveAggression === "function"
    ) {
      return crimewatchState.evaluateOffensiveAggression(
        scene,
        attackerEntity,
        targetEntity,
        nowMs,
      );
    }
  } catch (error) {
    log.warn(
      `[SpaceRuntime] Crimewatch activation preflight failed: ${error.message}`,
    );
    return { success: false, errorMsg: "CRIMEWATCH_PREFLIGHT_FAILED" };
  }
  return { success: true, data: { reason: "CRIMEWATCH_UNAVAILABLE" } };
}

// Retail treats an untargeted offensive area effect with a range attribute as
// a red-safety action everywhere in Empire space.  There is no target to pass
// through evaluateOffensiveAggression, so keep this activation-only decision
// beside the ordinary exported Crimewatch adapter. Per-object consequences
// are still evaluated and committed separately for every entity the wave hits.
function evaluateEmpireUntargetedOffensiveActivation(
  scene,
  attackerEntity,
) {
  if (!scene || !attackerEntity) {
    return { success: false, errorMsg: "ENTITY_NOT_FOUND" };
  }
  const attackerCharacterID = toInt(
    attackerEntity.session &&
      (
        attackerEntity.session.characterID ||
        attackerEntity.session.charid ||
        attackerEntity.session.charID
      ),
    toInt(
      attackerEntity.characterID ?? attackerEntity.pilotCharacterID,
      0,
    ),
  );
  // Native NPC area effects do not have a player safety setting.
  if (attackerCharacterID <= 0) {
    return {
      success: true,
      data: { reason: "NON_PLAYER_ATTACKER" },
    };
  }

  try {
    const crimewatchState = lazyRequire("../services/security/crimewatchState");
    if (
      !crimewatchState ||
      typeof crimewatchState.getSafetyLevel !== "function" ||
      typeof crimewatchState.isHighSecuritySystem !== "function"
    ) {
      return { success: false, errorMsg: "CRIMEWATCH_PREFLIGHT_FAILED" };
    }
    const rawSecurity = Math.max(
      0,
      Math.min(1, toFiniteNumber(scene.system && scene.system.security, 0)),
    );
    const isEmpireSpace =
      crimewatchState.isHighSecuritySystem(scene.system) || rawSecurity > 0;
    const safetyLevel = crimewatchState.getSafetyLevel(attackerCharacterID);
    const requiredSafetyLevel = crimewatchState.SAFETY_LEVEL_NONE;
    const safetyAllows =
      !isEmpireSpace || safetyLevel <= requiredSafetyLevel;
    return {
      success: safetyAllows,
      errorMsg: safetyAllows ? null : "SafetyActivated",
      data: {
        reason: isEmpireSpace
          ? "EMPIRE_UNTARGETED_AREA_AGGRESSION"
          : "NOT_EMPIRE_SPACE",
        attackerCharacterID,
        requiredSafetyLevel,
        safetyLevel,
      },
    };
  } catch (error) {
    log.warn(
      `[SpaceRuntime] Crimewatch untargeted activation preflight failed: ${error.message}`,
    );
    return { success: false, errorMsg: "CRIMEWATCH_PREFLIGHT_FAILED" };
  }
}

// Retail refuses a docking request outright while the pilot carries a weapons
// timer, and this server extends the same refusal to the criminal timer. The
// authoritative recheck lives in `dockSession`; this activation-time gate is
// what turns the request away immediately instead of after the approach.
function resolveSessionCrimewatchDockingRestriction(session, nowMs) {
  const characterID = toInt(
    session && (session.characterID || session.charid),
    0,
  );
  if (characterID <= 0) {
    return null;
  }
  try {
    const crimewatchState = lazyRequire("../services/security/crimewatchState");
    if (!crimewatchState) {
      return null;
    }
    if (
      typeof crimewatchState.hasActiveWeaponTimer === "function" &&
      crimewatchState.hasActiveWeaponTimer(characterID, nowMs)
    ) {
      return "WEAPONS_TIMER_ACTIVE";
    }
    if (
      typeof crimewatchState.isCriminallyFlagged === "function" &&
      crimewatchState.isCriminallyFlagged(characterID, nowMs)
    ) {
      return "CRIMINAL_TIMER_ACTIVE";
    }
  } catch (error) {
    log.warn(
      `[SpaceRuntime] Crimewatch docking preflight failed: ${error.message}`,
    );
  }
  return null;
}
