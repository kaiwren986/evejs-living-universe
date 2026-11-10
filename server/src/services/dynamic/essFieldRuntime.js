"use strict";

const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const SPACE_RUNTIME_MODULE_PATH = require.resolve("../../space/runtime");
const hudIcons = require("../../space/modules/hudIconRuntime");
const { isReadyForDestiny } = require("../../space/runtime/destinyDeliveryEligibility");

// Pinned 3396210 spaceComponentsByType[55914]; the larger cloak/deployment
// limits also match CCP's September 2025 / October 2024 patch notes.
const ESS_FIELD_RADIUS_METERS = 75_000;
const ESS_CLOAK_EXCLUSION_METERS = 500_000;
const ESS_LOBBY_CLOAK_EXCLUSION_METERS = 102_706;
const ESS_DEPLOYABLE_EXCLUSION_METERS = 1_000_000;
const ESS_FIELD_HUD_KEY = "ess-field";

function ensureFieldVisual(bank) {
  bank.presentationSpecialFx ||= new Map();
  if (bank.presentationSpecialFx.has(ESS_FIELD_HUD_KEY)) return;
  // The native WarpDisruptFieldGenerating effect reads graphicInfo.range.
  // Keep this decorative effect out of the module and interdiction owners:
  // the ESS site rule must continue to apply to nullified ships as well.
  bank.presentationSpecialFx.set(ESS_FIELD_HUD_KEY, {
    guid: "effects.WarpDisruptFieldGenerating",
    typeID: bank.typeID,
    durationMs: 10_000,
    repeat: 2_147_483_647,
    forceFreshAcquireSpecialFxReplay: true,
    essFieldVisual: true,
    essFieldRadiusMeters: ESS_FIELD_RADIUS_METERS,
  });
}

function syncFieldHud(scene, entity, nowMs) {
  const bank = findBankInRange(scene, entity, ESS_FIELD_RADIUS_METERS);
  const previous = entity.hudIconStates?.get(ESS_FIELD_HUD_KEY);
  if (previous && previous.sourceBallID === bank?.itemID) return;
  const session = entity.session;
  const ready = isReadyForDestiny(session);
  const notify = (state, active) => {
    if (ready) require("../../space/runtime/hudIconStates")
      .notifyHudEwarStateToSession(session, state, active);
  };
  if (previous) {
    hudIcons.removeHudIconState(entity, previous);
    notify(previous, false);
  }
  if (!bank) return;
  // The client's effectEssWarpScramble maps to warpScrambler, not the
  // targeted module's warpScramblerMWD. OnEwarStart drives the buff bar.
  const state = hudIcons.buildHudIconState({
    key: ESS_FIELD_HUD_KEY,
    kind: hudIcons.HUD_ICON_KIND_FIELD,
    sourceBallID: bank.itemID,
    moduleID: bank.itemID,
    targetBallID: entity.itemID,
    jammingType: "warpScrambler",
    startedAtMs: nowMs,
  });
  hudIcons.upsertHudIconState(entity, state);
  notify(state, true);
}

function distance(left, right) {
  const a = left && (left.position || left.spaceState?.position);
  const b = right && (right.position || right.spaceState?.position);
  if (!a || !b || ![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function sites(scene) {
  if (!scene || scene.sceneKind !== "solarSystem") return [];
  return require("../../space/encounterSurveillanceSystem").listSystemEssSites(scene);
}

function findBankInRange(scene, entity, radius, strict = false) {
  return sites(scene).find(({ bank }) => bank && canEntitiesInteractLocally(entity, bank) &&
    (strict ? distance(entity, bank) < radius : distance(entity, bank) <= radius))?.bank || null;
}

function isEntityWarpBlocked(scene, entity) {
  // This is a site rule, including nullified ships; it is not an ordinary
  // interdiction sphere and does not alter a warp already in flight.
  return Boolean(findBankInRange(scene, entity, ESS_FIELD_RADIUS_METERS));
}

function cloakBlocker(scene, entity) {
  for (const { bank, gate } of sites(scene)) {
    if (!bank || !canEntitiesInteractLocally(entity, bank)) continue;
    if (distance(entity, bank) <= ESS_CLOAK_EXCLUSION_METERS) return bank;
    if (gate && distance(entity, gate) <= ESS_LOBBY_CLOAK_EXCLUSION_METERS) return gate;
  }
  return null;
}

function resolveModuleRestriction(scene, entity, effect = {}) {
  const name = String(effect.name || effect.effectName || "").toLowerCase();
  const cloaking = effect.cloakModuleEffect === true || effect.cloaking === true || name.startsWith("cloaking");
  if (cloaking && cloakBlocker(scene, entity)) return "ESS_CLOAK_RESTRICTED";
  const movement = name === "modulebonusmicrowarpdrive" || name === "microwarpdrive" ||
    effect.microJumpDriveEffect === true || name.startsWith("microjump");
  const cyno = effect.cynosuralGeneration === true || name === "cynosuralgeneration";
  if ((movement || cyno) && isEntityWarpBlocked(scene, entity)) {
    return cyno ? "ESS_CYNOSURAL_RESTRICTED" : "ESS_PROPULSION_RESTRICTED";
  }
  return null;
}

function sceneForEntity(entity) {
  if (!entity?.sceneKey) return null;
  // Field checks are also used by passive custody/admission helpers. Asking
  // about a detached entity must not initialize a world or create a scene.
  const runtime = require.cache[SPACE_RUNTIME_MODULE_PATH]?.exports;
  const scene = runtime?.scenes?.get(entity.sceneKey);
  return scene && scene.getEntityByID(entity.itemID) === entity ? scene : null;
}

function isEntityFilamentBlocked(entity) {
  return isEntityWarpBlocked(sceneForEntity(entity), entity);
}

function resolveDeploymentRestriction(scene, entity, position = null) {
  const deployed = position && entity ? { ...entity, position } : entity;
  return findBankInRange(scene, deployed, ESS_DEPLOYABLE_EXCLUSION_METERS, true)
    ? { success: false, blocked: true, errorMsg: "ESS_DEPLOYABLE_RESTRICTED" }
    : null;
}

function resolveShipDeploymentRestriction(systemID, shipID, position = null) {
  const runtime = require.cache[SPACE_RUNTIME_MODULE_PATH]?.exports;
  const scene = runtime?.scenes?.get(`solar-system:${Number(systemID)}`);
  return scene ? resolveDeploymentRestriction(scene, scene.getEntityByID(shipID), position) : null;
}

function enforceEntity(scene, entity, nowMs) {
  if (!entity || entity.kind !== "ship") return;
  syncFieldHud(scene, entity, nowMs);
  const blocker = cloakBlocker(scene, entity);
  if (blocker && (entity.cloaked || entity.isCloaked || Number(entity.cloakMode) > 0)) {
    scene.forceDecloakEntity(entity, blocker, { reason: "essField", nowMs });
  }
  for (const effect of [...(entity.activeModuleEffects?.values() || [])]) {
    const restriction = resolveModuleRestriction(scene, entity, effect);
    if (!restriction) continue;
    const generic = effect.isGeneric === true || effect.cloakModuleEffect === true ||
      effect.microJumpDriveEffect === true || effect.cynosuralGeneration === true;
    const session = entity.session;
    const options = { reason: "essField", nowMs };
    if (session) {
      const method = generic ? "finalizeGenericModuleDeactivation" : "finalizePropulsionModuleDeactivation";
      scene[method](session, effect.moduleID, options);
    } else {
      const shutdown = require("../../space/runtime/moduleEffectShutdown");
      const method = generic ? "finalizeGenericModuleDeactivationWithoutSession" : "finalizePropulsionModuleDeactivationWithoutSession";
      shutdown[method](scene, entity, effect, options);
    }
  }
}

function tickScene(scene) {
  if (!sites(scene).length) return;
  const nowMs = scene.getCurrentSimTimeMs();
  for (const entity of scene.dynamicEntities.values()) enforceEntity(scene, entity, nowMs);
}

module.exports = {
  ensureFieldVisual,
  ESS_FIELD_RADIUS_METERS,
  ESS_CLOAK_EXCLUSION_METERS,
  ESS_LOBBY_CLOAK_EXCLUSION_METERS,
  ESS_DEPLOYABLE_EXCLUSION_METERS,
  isEntityWarpBlocked,
  isEntityFilamentBlocked,
  isEntityInField: isEntityFilamentBlocked,
  resolveModuleRestriction,
  resolveDeploymentRestriction,
  resolveShipDeploymentRestriction,
  enforceEntity,
  tickScene,
};
