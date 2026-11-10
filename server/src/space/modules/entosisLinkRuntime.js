"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

// Entosis Link (effect 6063 `entosisLink`, guid effects.EntosisBeam).
//
// Six published types, all one shape: group 1313, high slot, one fitted per
// ship, Strontium Clathrates per cycle, and a very long cycle (300 s on the T1
// and the four Modified variants, 120 s on the T2).
//
// The module contract and the sovereignty capture clock deliberately meet in
// this file. The generic module runtime still owns capacitor, fuel, locks and
// range; sovCaptureState owns the durable score and claim transition. Keeping
// that boundary explicit prevents a session-supplied allianceID from becoming
// capture authority.
//
//   effectCategoryID 2 (activeTarget)  -> a locked target is required
//   rangeAttributeID 54 (maxRange)     -> 20 km (T1/Noir./Spectre Fleet's/
//                                        Affirmative.), 24 km (Pandemic
//                                        SPHERE), 50 km (T2)
//
// Before this file the module activated with no target at all, dropped any
// requested targetID to 0, and never checked range — the same shape as the
// Passive Targeter bug in family 3 of the module audit.
//
// Effect 6063 is `isOffensive: false` in Dogma, so an SCC-owned neutral Hub is
// not fed through Crimewatch's illegal-aggression path. Retail still applies a
// weapon timer and breaks tether when sovereignty capture is committed; the
// scene runtime handles those two consequences separately.
const path = require("path");

const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));

const GROUP_ENTOSIS_LINK = 1313;
const EFFECT_ID_ENTOSIS_LINK = 6063;
const EFFECT_NAME_ENTOSIS_LINK = "entosislink";
const EFFECT_GUID_ENTOSIS_LINK = "effects.entosisbeam";
const TYPE_SOVEREIGNTY_HUB = 32458;
const TYPE_SOVEREIGNTY_COMMAND_NODE = 34832;
const OWNER_SCC = 1000132;

const CAPTURE_KIND_NEUTRAL_HUB = "neutralHub";
const CAPTURE_KIND_OWNED_HUB = "ownedHub";
const CAPTURE_KIND_COMMAND_NODE = "commandNode";

const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
// Surface-to-surface range comparisons carry the same 1 m grace the weapon
// path uses, so a target sitting exactly on the range boundary is in range.
const RANGE_GRACE_METERS = 1;

let captureStateOverride = null;
let campaignStateOverride = null;
let corporationStateOverride = null;
let sovereigntyStateOverride = null;
let characterStateOverride = null;

function getCaptureState() {
  if (captureStateOverride) {
    return captureStateOverride;
  }
  try {
    return require(path.join(
      __dirname,
      "../../services/sovereignty/sovCaptureState",
    ));
  } catch (error) {
    if (
      error &&
      error.code === "MODULE_NOT_FOUND" &&
      String(error.message || "").includes("sovCaptureState")
    ) {
      return null;
    }
    throw error;
  }
}

function getCampaignState() {
  if (campaignStateOverride) {
    return campaignStateOverride;
  }
  try {
    return require(path.join(
      __dirname,
      "../../services/sovereignty/sovCampaignState",
    ));
  } catch (error) {
    if (
      error &&
      error.code === "MODULE_NOT_FOUND" &&
      String(error.message || "").includes("sovCampaignState")
    ) {
      return null;
    }
    throw error;
  }
}

function getCorporationState() {
  if (corporationStateOverride) {
    return corporationStateOverride;
  }
  return require(path.join(
    __dirname,
    "../../services/corporation/corporationState",
  ));
}

function getCharacterState() {
  if (characterStateOverride) {
    return characterStateOverride;
  }
  return require(path.join(
    __dirname,
    "../../services/character/characterState",
  ));
}

function getSovereigntyState() {
  if (sovereigntyStateOverride) {
    return sovereigntyStateOverride;
  }
  return require(path.join(
    __dirname,
    "../../services/sovereignty/sovState",
  ));
}

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isEntosisLinkEffect(effectRecord, moduleItem = null) {
  if (toInt(effectRecord && effectRecord.effectID, 0) === EFFECT_ID_ENTOSIS_LINK) {
    return true;
  }
  if (normalizeText(effectRecord && effectRecord.name) === EFFECT_NAME_ENTOSIS_LINK) {
    return true;
  }
  if (normalizeText(effectRecord && effectRecord.guid) === EFFECT_GUID_ENTOSIS_LINK) {
    return true;
  }
  return toInt(moduleItem && moduleItem.groupID, 0) === GROUP_ENTOSIS_LINK;
}

function isEntosisLinkEffectState(effectState) {
  return Boolean(effectState && effectState.entosisLinkEffect === true);
}

// True while the entity runs an Entosis Link: an activation wrote the effect
// state and nothing has deactivated it. Docking, tethering, ejecting and the
// remote assistance a capital receives all read this.
function hasActiveEntosisLinkEffect(entity) {
  if (
    !entity ||
    !entity.activeModuleEffects ||
    typeof entity.activeModuleEffects.values !== "function"
  ) {
    return false;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (
      isEntosisLinkEffectState(effectState) &&
      toFiniteNumber(effectState.deactivatedAtMs, 0) <= 0
    ) {
      return true;
    }
  }
  return false;
}

function isSyntheticModuleContractEntity(entity) {
  // entosisLinkParity uses unpiloted native entities to exercise Dogma, fuel,
  // range and cycle behavior without a corporation fixture. This is not a
  // server-authoritative capsuleer and cannot contribute capture progress.
  return Boolean(
    entity &&
    entity.nativeNpc === true &&
    toInt(entity.characterID ?? entity.pilotCharacterID, 0) <= 0 &&
    toInt(entity.corporationID, 0) <= 0
  );
}

function resolvePersistedCaptureAllianceID(entity) {
  const corporationID = toInt(entity && entity.corporationID, 0);
  const characterID = toInt(
    entity && (entity.characterID ?? entity.pilotCharacterID),
    0,
  );
  if (corporationID <= 0 || characterID <= 0) {
    return null;
  }
  const corporationState = getCorporationState();
  const characterState = getCharacterState();
  const character =
    characterState && typeof characterState.peekCharacterRecord === "function"
      ? characterState.peekCharacterRecord(characterID)
      : null;
  if (
    !character ||
    Boolean(character.deleted) ||
    character.isDeleted === true ||
    character.deletedAt ||
    toInt(character.corporationID, 0) !== corporationID
  ) {
    return null;
  }
  const corporation = corporationState.getCorporationRecord(corporationID);
  const allianceID = toInt(corporation && corporation.allianceID, 0);
  if (
    !corporation ||
    corporation.deleted === true ||
    corporation.deletedAt ||
    allianceID <= 0
  ) {
    return null;
  }
  const alliance = corporationState.getAllianceRecord(allianceID);
  if (
    !alliance ||
    alliance.deleted === true ||
    alliance.deletedAt ||
    !corporationState.getAllianceCorporationIDs(allianceID).includes(corporationID)
  ) {
    return null;
  }
  return allianceID;
}

function resolveNeutralHubTarget(scene, targetEntity) {
  if (
    !scene ||
    !targetEntity ||
    targetEntity.kind !== "structure" ||
    toInt(targetEntity.typeID, 0) !== TYPE_SOVEREIGNTY_HUB ||
    toInt(targetEntity.ownerID, 0) !== OWNER_SCC ||
    toInt(targetEntity.corporationID, 0) !== OWNER_SCC ||
    toInt(targetEntity.allianceID, 0) > 0
  ) {
    return null;
  }

  const solarSystemID = toInt(scene.systemID, 0);
  const targetID = toInt(targetEntity.itemID, 0);
  const sovereigntyState = getSovereigntyState();
  const system = sovereigntyState.getSystemState(solarSystemID);
  if (
    !system ||
    toInt(system.claimStructureID, 0) === targetID ||
    toInt(system.infrastructureHubID, 0) === targetID
  ) {
    return null;
  }
  const structure = (Array.isArray(system.structures) ? system.structures : [])
    .find((candidate) => toInt(candidate && candidate.itemID, 0) === targetID);
  if (
    !structure ||
    toInt(structure.typeID, 0) !== TYPE_SOVEREIGNTY_HUB ||
    toInt(structure.ownerID, 0) !== OWNER_SCC ||
    toInt(structure.corporationID, 0) !== OWNER_SCC ||
    toInt(structure.allianceID, 0) > 0
  ) {
    return null;
  }
  return {
    captureKind: CAPTURE_KIND_NEUTRAL_HUB,
    solarSystemID,
    targetID,
    structure,
    campaignEpoch: null,
    campaignTargetID: null,
  };
}

function resolveOwnedHubTarget(scene, targetEntity) {
  if (
    !scene ||
    !targetEntity ||
    targetEntity.kind !== "structure" ||
    toInt(targetEntity.typeID, 0) !== TYPE_SOVEREIGNTY_HUB
  ) {
    return null;
  }

  const solarSystemID = toInt(scene.systemID, 0);
  const targetID = toInt(targetEntity.itemID, 0);
  const sovereigntyState = getSovereigntyState();
  const system = sovereigntyState.getSystemState(solarSystemID);
  const structure = (Array.isArray(system && system.structures)
    ? system.structures
    : []
  ).find((candidate) => toInt(candidate && candidate.itemID, 0) === targetID);
  const defenderAllianceID = toInt(
    structure && structure.allianceID || system && system.allianceID,
    0,
  );
  const defenderCorporationID = toInt(
    structure && structure.corporationID || system && system.corporationID,
    0,
  );
  if (
    !system ||
    !structure ||
    toInt(structure.typeID, 0) !== TYPE_SOVEREIGNTY_HUB ||
    toInt(system.claimStructureID, 0) !== targetID ||
    toInt(system.infrastructureHubID, 0) !== targetID ||
    defenderAllianceID <= 0 ||
    defenderCorporationID <= 0 ||
    toInt(system.allianceID, 0) !== defenderAllianceID
  ) {
    return null;
  }
  return {
    captureKind: CAPTURE_KIND_OWNED_HUB,
    solarSystemID,
    targetID,
    structure,
    defenderAllianceID,
    campaignEpoch: null,
    campaignTargetID: targetID,
  };
}

function resolveCommandNodeTarget(scene, targetEntity) {
  if (
    !scene ||
    !targetEntity ||
    targetEntity.kind !== "structure" ||
    toInt(targetEntity.typeID, 0) !== TYPE_SOVEREIGNTY_COMMAND_NODE
  ) {
    return null;
  }

  const solarSystemID = toInt(scene.systemID, 0);
  const targetID = toInt(targetEntity.itemID, 0);
  const sovereigntyState = getSovereigntyState();
  const system = sovereigntyState.getSystemState(solarSystemID);
  const structure = (Array.isArray(system && system.structures)
    ? system.structures
    : []
  ).find((candidate) => toInt(candidate && candidate.itemID, 0) === targetID);
  const flags = structure && structure.devFlags || {};
  const campaignEpoch = String(flags.campaignEpoch || "");
  const campaignTargetID = toInt(flags.campaignTargetID, 0);
  if (
    !structure ||
    toInt(structure.typeID, 0) !== TYPE_SOVEREIGNTY_COMMAND_NODE ||
    flags.sovereigntyCommandNode !== true ||
    !campaignEpoch ||
    campaignTargetID <= 0
  ) {
    return null;
  }

  // The physical node alone is not authority. Fence it against the durable
  // source campaign so a node left behind by a crash or a completed campaign
  // cannot be reactivated from a stale scene ball.
  const campaignState = getCampaignState();
  const projection =
    campaignState && typeof campaignState.getSovereigntyCampaignProjection === "function"
      ? campaignState.getSovereigntyCampaignProjection({ targetID: campaignTargetID })
      : null;
  const commandNodes = Array.isArray(projection && projection.commandNodes)
    ? projection.commandNodes
    : [];
  if (
    !projection ||
    projection.status !== "active" ||
    String(projection.campaignEpoch || "") !== campaignEpoch ||
    !commandNodes.some((node) =>
      toInt(node && node.nodeID, 0) === targetID &&
      toInt(node && node.solarSystemID, 0) === solarSystemID
    )
  ) {
    return null;
  }
  return {
    captureKind: CAPTURE_KIND_COMMAND_NODE,
    solarSystemID,
    targetID,
    structure,
    defenderAllianceID: toInt(projection.defenderAllianceID, 0),
    campaignEpoch,
    campaignTargetID,
  };
}

function resolveEntosisCaptureTarget(scene, targetEntity) {
  return (
    resolveNeutralHubTarget(scene, targetEntity) ||
    resolveOwnedHubTarget(scene, targetEntity) ||
    resolveCommandNodeTarget(scene, targetEntity)
  );
}

function hasCaptureContract(captureTarget) {
  if (!captureTarget) {
    return false;
  }
  if (captureTarget.captureKind === CAPTURE_KIND_NEUTRAL_HUB) {
    const captureState = getCaptureState();
    return Boolean(
      captureState &&
      typeof captureState.registerEntosisWarmup === "function" &&
      typeof captureState.beginEntosisScoring === "function" &&
      typeof captureState.stopEntosisScoring === "function"
    );
  }
  const campaignState = getCampaignState();
  if (captureTarget.captureKind === CAPTURE_KIND_OWNED_HUB) {
    return Boolean(
      campaignState &&
      typeof campaignState.registerOwnedHubEntosisWarmup === "function" &&
      typeof campaignState.beginOwnedHubEntosisScoring === "function" &&
      typeof campaignState.stopOwnedHubEntosisScoring === "function"
    );
  }
  return Boolean(
    captureTarget.captureKind === CAPTURE_KIND_COMMAND_NODE &&
    campaignState &&
    typeof campaignState.registerCommandNodeEntosisWarmup === "function" &&
    typeof campaignState.beginCommandNodeEntosisScoring === "function" &&
    typeof campaignState.stopCommandNodeEntosisScoring === "function"
  );
}

function captureTargetMatchesEffect(captureTarget, effectState) {
  if (!captureTarget || !effectState) {
    return false;
  }
  return (
    captureTarget.captureKind === String(effectState.entosisCaptureKind || "") &&
    captureTarget.solarSystemID === toInt(effectState.entosisCaptureSolarSystemID, 0) &&
    captureTarget.targetID === toInt(
      effectState.entosisCaptureTargetID || effectState.targetID,
      0,
    ) &&
    String(captureTarget.campaignEpoch || "") ===
      String(effectState.entosisCampaignEpoch || "") &&
    toInt(captureTarget.campaignTargetID, 0) ===
      toInt(effectState.entosisCampaignTargetID, 0)
  );
}

function buildCaptureCallOptions(captureTarget, effectState, allianceID, nowMs) {
  const common = {
    linkID: toInt(effectState && effectState.moduleID, 0),
    allianceID: toInt(allianceID, 0),
    nowMs,
  };
  if (captureTarget.captureKind === CAPTURE_KIND_COMMAND_NODE) {
    return {
      ...common,
      nodeID: captureTarget.targetID,
      campaignEpoch: captureTarget.campaignEpoch,
    };
  }
  return {
    ...common,
    solarSystemID: captureTarget.solarSystemID,
    targetID: captureTarget.targetID,
  };
}

function callCapturePhase(phase, captureTarget, effectState, allianceID, nowMs) {
  const options = buildCaptureCallOptions(
    captureTarget,
    effectState,
    allianceID,
    nowMs,
  );
  if (captureTarget.captureKind === CAPTURE_KIND_NEUTRAL_HUB) {
    const captureState = getCaptureState();
    const method = {
      register: "registerEntosisWarmup",
      begin: "beginEntosisScoring",
      stop: "stopEntosisScoring",
    }[phase];
    return captureState && typeof captureState[method] === "function"
      ? captureState[method](options)
      : null;
  }
  const campaignState = getCampaignState();
  const method = captureTarget.captureKind === CAPTURE_KIND_OWNED_HUB
    ? {
        register: "registerOwnedHubEntosisWarmup",
        begin: "beginOwnedHubEntosisScoring",
        stop: "stopOwnedHubEntosisScoring",
      }[phase]
    : {
        register: "registerCommandNodeEntosisWarmup",
        begin: "beginCommandNodeEntosisScoring",
        stop: "stopCommandNodeEntosisScoring",
      }[phase];
  return campaignState && typeof campaignState[method] === "function"
    ? campaignState[method](options)
    : null;
}

function resolveEntosisLinkRangeMeters({
  moduleItem,
  effectRecord,
  shipItem = null,
  chargeItem = null,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalLocationModifierSources = null,
} = {}) {
  // Read the live map rather than the raw type so hull and skill modifiers
  // reach the range. No published skill or hull bonus touches maxRange on this
  // family today — the capitals' only entosis modifiers are the x5 duration and
  // the remote-assistance impedance — but the family's own numbers should not
  // be the one place that bypasses the dogma pipeline.
  const attributes = shipItem
    ? buildLiveModuleAttributeMap(
      shipItem,
      moduleItem,
      chargeItem,
      skillMap,
      fittedItems,
      activeModuleContexts,
      Array.isArray(additionalLocationModifierSources)
        ? { additionalLocationModifierSources }
        : {},
    )
    : null;
  const rangeAttributeID =
    toInt(effectRecord && effectRecord.rangeAttributeID, 0) || ATTRIBUTE_MAX_RANGE;
  return Math.max(0, toFiniteNumber(attributes && attributes[rangeAttributeID], 0));
}

function measureSurfaceDistance(scene, entity, targetEntity, nowMs) {
  if (!scene || typeof scene.getEntitySurfaceState !== "function") {
    return { available: false, surfaceDistance: 0 };
  }
  const state = scene.getEntitySurfaceState(entity, targetEntity);
  return {
    available: Boolean(state && state.available),
    surfaceDistance: toFiniteNumber(state && state.surfaceDistance, 0),
  };
}

function resolveEntosisLinkActivation({
  scene = null,
  entity = null,
  moduleItem = null,
  effectRecord = null,
  chargeItem = null,
  shipItem = null,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalLocationModifierSources = null,
  targetID = 0,
  nowMs = 0,
  isTargetLocked = null,
} = {}) {
  if (!isEntosisLinkEffect(effectRecord, moduleItem)) {
    return { matched: false };
  }
  if (!scene || !entity || !moduleItem) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }

  const rangeMeters = resolveEntosisLinkRangeMeters({
    moduleItem,
    effectRecord,
    shipItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    additionalLocationModifierSources,
  });
  if (rangeMeters <= 0) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }

  const normalizedTargetID = toInt(targetID, 0);
  if (normalizedTargetID <= 0) {
    return { matched: true, success: false, errorMsg: "TARGET_REQUIRED" };
  }
  const targetEntity = scene.getEntityByID(normalizedTargetID);
  if (!targetEntity || targetEntity === entity) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  if (typeof isTargetLocked === "function" && !isTargetLocked(entity, normalizedTargetID)) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_LOCKED" };
  }

  const distance = measureSurfaceDistance(scene, entity, targetEntity, nowMs);
  if (!distance.available) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  if (distance.surfaceDistance > rangeMeters + RANGE_GRACE_METERS) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      data: {
        rangeMeters,
        surfaceDistanceMeters: distance.surfaceDistance,
      },
    };
  }

  const syntheticModuleContract = isSyntheticModuleContractEntity(entity);
  let captureTarget = null;
  let allianceID = null;
  if (!syntheticModuleContract) {
    captureTarget = resolveEntosisCaptureTarget(scene, targetEntity);
    if (!captureTarget) {
      return {
        matched: true,
        success: false,
        errorMsg: "ENTOSIS_TARGET_NOT_CAPTURABLE",
      };
    }
    allianceID = resolvePersistedCaptureAllianceID(entity);
    if (!allianceID) {
      return {
        matched: true,
        success: false,
        errorMsg: "ALLIANCE_MEMBERSHIP_REQUIRED",
      };
    }
    if (!hasCaptureContract(captureTarget)) {
      return {
        matched: true,
        success: false,
        errorMsg: "SOVEREIGNTY_CAPTURE_UNAVAILABLE",
      };
    }
  }

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      rangeMeters,
      captureTarget,
      allianceID,
    },
    effectStatePatch: {
      entosisLinkEffect: true,
      entosisRangeMeters: rangeMeters,
      entosisCaptureEnabled: !syntheticModuleContract,
      entosisCaptureAllianceID: allianceID,
      entosisCaptureSolarSystemID:
        captureTarget && captureTarget.solarSystemID || 0,
      entosisCaptureTargetID: captureTarget && captureTarget.targetID || 0,
      entosisCaptureKind:
        captureTarget && captureTarget.captureKind || null,
      entosisCampaignEpoch:
        captureTarget && captureTarget.campaignEpoch || null,
      entosisCampaignTargetID:
        captureTarget && captureTarget.campaignTargetID || 0,
      entosisScoringStarted: false,
    },
  };
}

function registerEntosisLinkWarmup({ scene, entity, effectState, nowMs = 0 } = {}) {
  if (!isEntosisLinkEffectState(effectState) || effectState.entosisCaptureEnabled !== true) {
    return { success: true, data: { captureEnabled: false } };
  }
  const allianceID = resolvePersistedCaptureAllianceID(entity);
  const targetEntity = scene && scene.getEntityByID(
    toInt(effectState.entosisCaptureTargetID || effectState.targetID, 0),
  );
  const captureTarget = resolveEntosisCaptureTarget(scene, targetEntity);
  if (
    !allianceID ||
    !captureTarget ||
    !captureTargetMatchesEffect(captureTarget, effectState) ||
    allianceID !== toInt(effectState.entosisCaptureAllianceID, 0)
  ) {
    return { success: false, errorMsg: "ENTOSIS_CAPTURE_AUTHORITY_CHANGED" };
  }
  if (!hasCaptureContract(captureTarget)) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_UNAVAILABLE" };
  }
  const result = callCapturePhase(
    "register",
    captureTarget,
    effectState,
    allianceID,
    nowMs,
  );
  if (!result || result.success === false) {
    return {
      success: false,
      errorMsg: result && result.errorMsg || "ENTOSIS_WARMUP_FAILED",
    };
  }
  effectState.entosisWarmupRegisteredAtMs = Math.max(0, toFiniteNumber(nowMs, 0));
  return { success: true, data: { captureEnabled: true, allianceID, captureTarget } };
}

function stopEntosisLinkCapture({ scene = null, effectState = null, nowMs = 0 } = {}) {
  if (!isEntosisLinkEffectState(effectState) || effectState.entosisCaptureEnabled !== true) {
    return { success: true, data: { captureEnabled: false } };
  }
  const captureTarget = {
    captureKind: String(effectState.entosisCaptureKind || ""),
    solarSystemID:
      toInt(effectState.entosisCaptureSolarSystemID, 0) ||
      toInt(scene && scene.systemID, 0),
    targetID: toInt(
      effectState.entosisCaptureTargetID || effectState.targetID,
      0,
    ),
    campaignEpoch: effectState.entosisCampaignEpoch || null,
    campaignTargetID: toInt(effectState.entosisCampaignTargetID, 0) || null,
  };
  if (!hasCaptureContract(captureTarget)) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_UNAVAILABLE" };
  }
  const result = callCapturePhase(
    "stop",
    captureTarget,
    effectState,
    toInt(effectState.entosisCaptureAllianceID, 0),
    nowMs,
  );
  effectState.entosisScoringStarted = false;
  if (!result || result.success === false) {
    return {
      success: false,
      errorMsg: result && result.errorMsg || "ENTOSIS_STOP_FAILED",
    };
  }
  return { success: true, data: { captureEnabled: true } };
}

// Every completed module cycle re-checks activation authority, target, lock and
// range. The first completed cycle ends the warmup and starts scoring; module
// activation itself never advances the sovereignty clock.
function executeEntosisLinkCycle({
  scene = null,
  entity = null,
  effectState = null,
  nowMs = 0,
  isTargetLocked = null,
} = {}) {
  if (!isEntosisLinkEffectState(effectState)) {
    return { success: true, data: {} };
  }
  if (!scene || !entity) {
    return { success: false, stopReason: "entosisLink" };
  }

  const targetID = toInt(effectState.targetID, 0);
  if (targetID <= 0) {
    return { success: false, stopReason: "target" };
  }
  const targetEntity = scene.getEntityByID(targetID);
  if (!targetEntity) {
    return { success: false, stopReason: "target" };
  }
  if (typeof isTargetLocked === "function" && !isTargetLocked(entity, targetID)) {
    return { success: false, stopReason: "target" };
  }

  const rangeMeters = Math.max(0, toFiniteNumber(effectState.entosisRangeMeters, 0));
  if (rangeMeters <= 0) {
    return { success: false, stopReason: "entosisLink" };
  }
  const distance = measureSurfaceDistance(scene, entity, targetEntity, nowMs);
  if (!distance.available) {
    return { success: false, stopReason: "target" };
  }
  if (distance.surfaceDistance > rangeMeters + RANGE_GRACE_METERS) {
    return { success: false, stopReason: "range" };
  }

  let captureScoringStarted = false;
  if (effectState.entosisCaptureEnabled === true) {
    const allianceID = resolvePersistedCaptureAllianceID(entity);
    const captureTarget = resolveEntosisCaptureTarget(scene, targetEntity);
    if (
      !allianceID ||
      !captureTarget ||
      !captureTargetMatchesEffect(captureTarget, effectState) ||
      allianceID !== toInt(effectState.entosisCaptureAllianceID, 0)
    ) {
      return { success: false, stopReason: "entosisCaptureAuthority" };
    }
    if (effectState.entosisScoringStarted !== true) {
      if (!hasCaptureContract(captureTarget)) {
        return { success: false, stopReason: "entosisCapture" };
      }
      const result = callCapturePhase(
        "begin",
        captureTarget,
        effectState,
        allianceID,
        nowMs,
      );
      if (!result || result.success === false) {
        return {
          success: false,
          stopReason: "entosisCapture",
          errorMsg: result && result.errorMsg || "ENTOSIS_SCORING_FAILED",
        };
      }
      effectState.entosisScoringStarted = true;
      effectState.entosisScoringStartedAtMs = Math.max(0, toFiniteNumber(nowMs, 0));
      captureScoringStarted = true;
    }
  }

  return {
    success: true,
    data: {
      targetEntity,
      surfaceDistanceMeters: distance.surfaceDistance,
      captureScoringStarted,
    },
  };
}

function captureTickChanged(result, captureKind = null) {
  const data = result && result.data;
  if (!result || result.success === false) {
    return false;
  }
  if (
    result.completed === true ||
    result.transitioned === true ||
    result.created === true ||
    data && data.changed === true ||
    toInt(data && data.completedTargets, 0) > 0 ||
    toInt(data && data.tickedCampaigns, 0) > 0
  ) {
    return true;
  }
  // A command-node settlement removes the captured structure and authors a
  // replacement even when the overall campaign is not yet complete.
  return Boolean(
    captureKind === CAPTURE_KIND_COMMAND_NODE &&
    data &&
    toInt(data.nodeID, 0) > 0 &&
    data.scoresByTeam
  );
}

function listSceneEntosisCaptureEffects(scene) {
  const effects = [];
  const entities = scene && scene.dynamicEntities instanceof Map
    ? scene.dynamicEntities.values()
    : [];
  for (const entity of entities) {
    if (!(entity && entity.activeModuleEffects instanceof Map)) {
      continue;
    }
    for (const effectState of entity.activeModuleEffects.values()) {
      if (
        isEntosisLinkEffectState(effectState) &&
        effectState.entosisCaptureEnabled === true
      ) {
        effects.push(effectState);
      }
    }
  }
  return effects;
}

function getCommandNodeWireSignature(campaignState, campaignTargetID, nodeID) {
  if (
    !campaignState ||
    typeof campaignState.getSovereigntyCampaignProjection !== "function"
  ) {
    return null;
  }
  const projection = campaignState.getSovereigntyCampaignProjection({
    targetID: campaignTargetID,
  });
  const node = (Array.isArray(projection && projection.commandNodes)
    ? projection.commandNodes
    : []
  ).find((candidate) => toInt(candidate && candidate.nodeID, 0) === nodeID);
  const capture = node && node.entosisCapture;
  if (!capture) {
    return node ? "node:no-capture" : "node:missing";
  }
  return JSON.stringify({
    controllingTeamID: capture.controllingTeamID ?? null,
    scoringTeamID: capture.scoringTeamID ?? null,
    scoringRate: toFiniteNumber(capture.scoringRate, 0),
    isBlocked: capture.isBlocked === true,
  });
}

function getOwnedHubWireSignature(campaignState, solarSystemID, targetID, nowMs) {
  if (
    !campaignState ||
    typeof campaignState.getOwnedHubCaptureProjection !== "function"
  ) {
    return null;
  }
  const projection = campaignState.getOwnedHubCaptureProjection({
    solarSystemID,
    targetID,
    nowMs,
  });
  if (!projection) {
    return "hub:missing";
  }
  return JSON.stringify({
    phase: projection.phase || null,
    controllingTeamID: projection.controllingTeamID ?? null,
    scoringTeamID: projection.scoringTeamID ?? null,
    scoringRate: toFiniteNumber(projection.scoringRate, 0),
    isBlocked: projection.isBlocked === true,
  });
}

function tickSovereigntyCaptureForScene(scene, nowMs = 0) {
  const results = [];
  let available = false;
  let changed = false;
  let firstFailure = null;
  const captureState = getCaptureState();
  if (captureState && typeof captureState.tickSovereigntyCapture === "function") {
    available = true;
    const result = captureState.tickSovereigntyCapture({
      solarSystemID: toInt(scene && scene.systemID, 0),
      nowMs,
    });
    results.push({ captureKind: CAPTURE_KIND_NEUTRAL_HUB, result });
    if (result && result.success === false) {
      firstFailure = firstFailure || result;
    }
    changed = captureTickChanged(result, CAPTURE_KIND_NEUTRAL_HUB) || changed;
  }

  const campaignState = getCampaignState();
  if (campaignState) {
    available = true;
    const solarSystemID = toInt(scene && scene.systemID, 0);
    const sovereigntyState = getSovereigntyState();
    const system = sovereigntyState.getSystemState(solarSystemID);
    const hubTargetIDs = new Set(
      (Array.isArray(system && system.structures) ? system.structures : [])
        .filter((structure) =>
          toInt(structure && structure.typeID, 0) === TYPE_SOVEREIGNTY_HUB &&
          toInt(structure && structure.itemID, 0) > 0 &&
          (
            toInt(system && system.claimStructureID, 0) ===
              toInt(structure.itemID, 0) ||
            toInt(system && system.infrastructureHubID, 0) ===
              toInt(structure.itemID, 0)
          )
        )
        .map((structure) => toInt(structure.itemID, 0)),
    );

    if (typeof campaignState.tickSovereigntyCampaigns === "function") {
      for (const targetID of hubTargetIDs) {
        const result = campaignState.tickSovereigntyCampaigns({ targetID, nowMs });
        results.push({ captureKind: "campaign", targetID, result });
        if (result && result.success === false) {
          firstFailure = firstFailure || result;
        }
        changed = captureTickChanged(result, "campaign") || changed;
      }
    }

    const captureTargets = new Map();
    for (const effectState of listSceneEntosisCaptureEffects(scene)) {
      // Activation and the whole first module cycle are warmup-only. Do not
      // let the scene clock turn a fresh node's neutral midpoint into idle
      // defender progress while the link is still warming up. Partial scores
      // that were already regenerating are discovered from persistence below.
      if (effectState.entosisScoringStarted !== true) {
        continue;
      }
      const captureKind = String(effectState.entosisCaptureKind || "");
      if (
        captureKind !== CAPTURE_KIND_OWNED_HUB &&
        captureKind !== CAPTURE_KIND_COMMAND_NODE
      ) {
        continue;
      }
      const targetID = toInt(
        effectState.entosisCaptureTargetID || effectState.targetID,
        0,
      );
      const targetEntity = scene && scene.getEntityByID(targetID);
      const captureTarget = resolveEntosisCaptureTarget(scene, targetEntity);
      if (!captureTargetMatchesEffect(captureTarget, effectState)) {
        continue;
      }
      const key = `${captureKind}:${targetID}:${String(
        captureTarget.campaignEpoch || "",
      )}`;
      captureTargets.set(key, captureTarget);
    }

    // Daily vulnerability transitions and defensive Hub regeneration remain
    // live after the last ship effect disappears. The persisted score/rate is
    // authority; scene entities are only a client presentation cache.
    for (const targetID of hubTargetIDs) {
      if (typeof campaignState.ensureOwnedHubVulnerability === "function") {
        const ensured = campaignState.ensureOwnedHubVulnerability({
          solarSystemID,
          targetID,
          nowMs,
        });
        results.push({ captureKind: "ownedHubWindow", targetID, result: ensured });
        if (ensured && ensured.success === false) {
          firstFailure = firstFailure || ensured;
        }
        changed = captureTickChanged(ensured, "ownedHubWindow") || changed;
      }
      const projection =
        typeof campaignState.getOwnedHubCaptureProjection === "function"
          ? campaignState.getOwnedHubCaptureProjection({
              solarSystemID,
              targetID,
              nowMs,
            })
          : null;
      const needsIdleTick = Boolean(
        projection &&
        (projection.phase === "vulnerable" || projection.phase === "overtime") &&
        Number(projection.scoreAtLastUpdateTime) < 1 &&
        Number(projection.scoringRate) !== 0
      );
      if (needsIdleTick) {
        captureTargets.set(`${CAPTURE_KIND_OWNED_HUB}:${targetID}:`, {
          captureKind: CAPTURE_KIND_OWNED_HUB,
          solarSystemID,
          targetID,
          campaignEpoch: null,
          campaignTargetID: targetID,
        });
      }
    }

    // A stopped command-node link persists the defensive regeneration rate.
    // Continue only partial/explicitly-regenerating nodes; brand-new nodes
    // start at the neutral midpoint with rate zero and must not self-complete.
    const refreshedSystem = sovereigntyState.getSystemState(solarSystemID);
    for (const structure of Array.isArray(refreshedSystem && refreshedSystem.structures)
      ? refreshedSystem.structures
      : []) {
      if (toInt(structure && structure.typeID, 0) !== TYPE_SOVEREIGNTY_COMMAND_NODE) {
        continue;
      }
      const flags = structure.devFlags || {};
      const capture = structure.entosisCapture || {};
      const targetID = toInt(structure.itemID, 0);
      const campaignTargetID = toInt(flags.campaignTargetID, 0);
      const campaignEpoch = String(flags.campaignEpoch || "");
      const partialScore = toFiniteNumber(capture.scoreAtLastUpdateTime, 0.5);
      const regenerating = Math.abs(toFiniteNumber(capture.scoringRate, 0)) > 1e-12;
      const wasContested = Boolean(
        capture.isBlocked === true || capture.scoringTeamID != null,
      );
      if (
        targetID <= 0 ||
        campaignTargetID <= 0 ||
        !campaignEpoch ||
        (
          !regenerating &&
          !wasContested &&
          Math.abs(partialScore - 0.5) <= 1e-12
        )
      ) {
        continue;
      }
      const projection =
        typeof campaignState.getSovereigntyCampaignProjection === "function"
          ? campaignState.getSovereigntyCampaignProjection({
              targetID: campaignTargetID,
            })
          : null;
      const projectionNode = (Array.isArray(projection && projection.commandNodes)
        ? projection.commandNodes
        : []
      ).find((node) =>
        toInt(node && node.nodeID, 0) === targetID &&
        toInt(node && node.solarSystemID, 0) === solarSystemID
      );
      if (
        !projectionNode ||
        projection.status !== "active" ||
        String(projection.campaignEpoch || "") !== campaignEpoch
      ) {
        continue;
      }
      captureTargets.set(
        `${CAPTURE_KIND_COMMAND_NODE}:${targetID}:${campaignEpoch}`,
        {
          captureKind: CAPTURE_KIND_COMMAND_NODE,
          solarSystemID,
          targetID,
          campaignEpoch,
          campaignTargetID,
        },
      );
    }

    for (const captureTarget of captureTargets.values()) {
      const captureKind = captureTarget.captureKind;
      const targetID = captureTarget.targetID;
      const method = captureKind === CAPTURE_KIND_OWNED_HUB
        ? "tickOwnedHubCapture"
        : "tickCommandNodeCapture";
      if (typeof campaignState[method] !== "function") {
        continue;
      }
      const options = captureKind === CAPTURE_KIND_OWNED_HUB
        ? {
            solarSystemID: captureTarget.solarSystemID,
            targetID: captureTarget.targetID,
            nowMs,
          }
        : {
            nodeID: captureTarget.targetID,
            campaignEpoch: captureTarget.campaignEpoch,
            nowMs,
          };
      const beforeWireSignature = captureKind === CAPTURE_KIND_COMMAND_NODE
        ? getCommandNodeWireSignature(
            campaignState,
            captureTarget.campaignTargetID,
            captureTarget.targetID,
          )
        : getOwnedHubWireSignature(
            campaignState,
            captureTarget.solarSystemID,
            captureTarget.targetID,
            nowMs,
          );
      const result = campaignState[method](options);
      const afterWireSignature = captureKind === CAPTURE_KIND_COMMAND_NODE
        ? getCommandNodeWireSignature(
            campaignState,
            captureTarget.campaignTargetID,
            captureTarget.targetID,
          )
        : getOwnedHubWireSignature(
            campaignState,
            captureTarget.solarSystemID,
            captureTarget.targetID,
            nowMs,
          );
      results.push({ captureKind, targetID, result });
      if (result && result.success === false) {
        firstFailure = firstFailure || result;
      }
      changed = captureTickChanged(result, captureKind) || changed;
      changed = Boolean(
        beforeWireSignature !== afterWireSignature,
      ) || changed;
    }
  }

  if (firstFailure) {
    return {
      success: false,
      errorMsg: firstFailure.errorMsg || "SOVEREIGNTY_CAPTURE_TICK_FAILED",
      data: { available, changed, results },
    };
  }
  return { success: true, data: { available, changed, results } };
}

module.exports = {
  GROUP_ENTOSIS_LINK,
  EFFECT_ID_ENTOSIS_LINK,
  isEntosisLinkEffect,
  isEntosisLinkEffectState,
  hasActiveEntosisLinkEffect,
  resolveEntosisLinkActivation,
  registerEntosisLinkWarmup,
  stopEntosisLinkCapture,
  executeEntosisLinkCycle,
  tickSovereigntyCaptureForScene,
  resolveEntosisLinkRangeMeters,
  _testing: {
    captureTargetMatchesEffect,
    resolveEntosisCaptureTarget,
    resolvePersistedCaptureAllianceID,
    resolveNeutralHubTarget,
    setCaptureStateOverride(value) {
      captureStateOverride = value || null;
    },
    setCampaignStateOverride(value) {
      campaignStateOverride = value || null;
    },
    setCorporationStateOverride(value) {
      corporationStateOverride = value || null;
    },
    setCharacterStateOverride(value) {
      characterStateOverride = value || null;
    },
    setSovereigntyStateOverride(value) {
      sovereigntyStateOverride = value || null;
    },
  },
};
