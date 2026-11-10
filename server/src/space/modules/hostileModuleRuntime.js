"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));
const {
  getActiveImplantLocationModifierSources,
  getActiveImplantShipModifierEntries,
} = require(path.join(
  __dirname,
  "../../services/dogma/implants/activeImplantModifiers",
));
const {
  canEntitiesInteractLocally,
} = require(path.join(__dirname, "../destiny/identity/interactionScope"));
const {
  SKILL_GUNNERY,
  filterProjectedWeaponModifierEntries,
} = require(path.join(__dirname, "./projectedWeaponModifiers"));

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_MAX_TARGET_RANGE = getAttributeIDByNames("maxTargetRange") || 76;
const ATTRIBUTE_MAX_LOCKED_TARGETS = getAttributeIDByNames("maxLockedTargets") || 192;
const ATTRIBUTE_SCAN_RESOLUTION = getAttributeIDByNames("scanResolution") || 564;
const ATTRIBUTE_FALLOFF_EFFECTIVENESS =
  getAttributeIDByNames("falloffEffectiveness") || 2044;
const ATTRIBUTE_MAX_GROUP_ACTIVE = getAttributeIDByNames("maxGroupActive") || 763;
const ATTRIBUTE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const ATTRIBUTE_SPEED_FACTOR = getAttributeIDByNames("speedFactor") || 20;
const ATTRIBUTE_SIGNATURE_RADIUS_BONUS =
  getAttributeIDByNames("signatureRadiusBonus") || 554;
const ATTRIBUTE_MAX_TARGET_RANGE_BONUS =
  getAttributeIDByNames("maxTargetRangeBonus") || 309;
const ATTRIBUTE_SCAN_RESOLUTION_BONUS =
  getAttributeIDByNames("scanResolutionBonus") || 566;
const ATTRIBUTE_MAX_RANGE_BONUS = getAttributeIDByNames("maxRangeBonus") || 351;
const ATTRIBUTE_FALLOFF_BONUS = getAttributeIDByNames("falloffBonus") || 349;
const ATTRIBUTE_TRACKING_SPEED_BONUS =
  getAttributeIDByNames("trackingSpeedBonus") || 767;
const ATTRIBUTE_MISSILE_VELOCITY_BONUS =
  getAttributeIDByNames("missileVelocityBonus") || 547;
const ATTRIBUTE_EXPLOSION_DELAY_BONUS =
  getAttributeIDByNames("explosionDelayBonus") || 596;
const ATTRIBUTE_AOE_VELOCITY_BONUS =
  getAttributeIDByNames("aoeVelocityBonus") || 847;
const ATTRIBUTE_AOE_CLOUD_SIZE_BONUS =
  getAttributeIDByNames("aoeCloudSizeBonus") || 848;
const ATTRIBUTE_WARP_SCRAMBLE_STATUS =
  getAttributeIDByNames("warpScrambleStatus") || 104;
const ATTRIBUTE_WARP_SCRAMBLE_STRENGTH =
  getAttributeIDByNames("warpScrambleStrength") || 105;
// The NPC-behaviour flavour of a scrambler carries its strength here instead.
// `behaviorWarpScramble` (6745) modifies warpScrambleStatus by 2509, not by 105, and
// the 127 rats that carry it — Drifters, Triglavians, faction-warfare navy hulls,
// Dragonaurs, Carousing pirates — declare no `warpScrambleStrength` at all.
const ATTRIBUTE_BEHAVIOR_WARP_SCRAMBLE_STRENGTH =
  getAttributeIDByNames("behaviorWarpScrambleStrength") || 2509;
// Ordered candidates for "how many points does this scramble apply". First NON-ZERO
// wins, for the reason spelled out on `resolveHostileStrengthValue`.
const WARP_SCRAMBLE_STRENGTH_ATTRIBUTE_IDS = Object.freeze([
  ATTRIBUTE_WARP_SCRAMBLE_STRENGTH,
  ATTRIBUTE_BEHAVIOR_WARP_SCRAMBLE_STRENGTH,
]);
const ATTRIBUTE_ENERGY_NEUTRALIZER_AMOUNT =
  getAttributeIDByNames("energyNeutralizerAmount") || 97;
// The entity-EWAR flavour of a neutralizer carries its magnitude here instead:
// "Amount of capacitor drained by NPC from target". Five published Blood Raider
// rats declare it and declare no `energyNeutralizerAmount` at all.
const ATTRIBUTE_ENTITY_CAPACITOR_DRAIN_AMOUNT =
  getAttributeIDByNames("entityCapacitorDrainAmount") || 946;
const ATTRIBUTE_POWER_TRANSFER_AMOUNT =
  getAttributeIDByNames("powerTransferAmount") || 90;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_EXPLOSION_DELAY = getAttributeIDByNames("explosionDelay") || 281;
const ATTRIBUTE_AOE_VELOCITY = getAttributeIDByNames("aoeVelocity") || 653;
const ATTRIBUTE_AOE_CLOUD_SIZE = getAttributeIDByNames("aoeCloudSize") || 654;
const ATTRIBUTE_SIGNATURE_RADIUS = getAttributeIDByNames("signatureRadius") || 552;
const ATTRIBUTE_TRACKING_SPEED = getAttributeIDByNames("trackingSpeed") || 160;
const ATTRIBUTE_WEAPON_FALLOFF = getAttributeIDByNames("falloff") || 158;
const ATTRIBUTE_ENERGY_WARFARE_RESISTANCE =
  getAttributeIDByNames("energyWarfareResistance") || 2045;
const ATTRIBUTE_WEAPON_DISRUPTION_RESISTANCE =
  getAttributeIDByNames("weaponDisruptionResistance") || 2113;
const ATTRIBUTE_TARGET_PAINTER_RESISTANCE =
  getAttributeIDByNames("targetPainterResistance") || 2114;
const ATTRIBUTE_STASIS_WEBIFIER_RESISTANCE =
  getAttributeIDByNames("stasisWebifierResistance") || 2115;
const ATTRIBUTE_SENSOR_DAMPENER_RESISTANCE =
  getAttributeIDByNames("sensorDampenerResistance") || 2112;
const ATTRIBUTE_ENERGY_NEUTRALIZER_SIGNATURE_RESOLUTION =
  getAttributeIDByNames("energyNeutralizerSignatureResolution") || 2451;
const ATTRIBUTE_NOS_OVERRIDE = getAttributeIDByNames("nosOverride") || 1945;
const ATTRIBUTE_ENTITY_TARGET_JAM = getAttributeIDByNames("entityTargetJam") || 928;

const DOGMA_OP_MOD_ADD = 2;
const DOGMA_OP_POST_MUL = 4;
const DOGMA_OP_POST_PERCENT = 6;
const PERSISTENT_SPECIAL_FX_WINDOW_MS = 12 * 60 * 60 * 1000;
const EFFECT_SHIP_MODULE_FOCUSED_WARP_SCRAMBLING_SCRIPT = 6848;
const EFFECT_SHIP_MODULE_FOCUSED_WARP_DISRUPTION_SCRIPT = 6849;
const SCRIPTED_HIC_GATE_SCRAMBLE_EFFECT_IDS = new Set([
  EFFECT_SHIP_MODULE_FOCUSED_WARP_SCRAMBLING_SCRIPT,
  EFFECT_SHIP_MODULE_FOCUSED_WARP_DISRUPTION_SCRIPT,
]);

const HOSTILE_FAMILY_WEB = "stasisWebifier";
const HOSTILE_FAMILY_PAINT = "targetPainter";
const HOSTILE_FAMILY_SCRAM = "warpScrambler";
const HOSTILE_FAMILY_DISRUPT = "warpDisruptor";
const HOSTILE_FAMILY_FIGHTER_TACKLE = "fighterTackle";
const HOSTILE_FAMILY_NEUT = "energyNeutralizer";
const HOSTILE_FAMILY_NOS = "energyNosferatu";
const HOSTILE_FAMILY_SENSOR_DAMP = "sensorDampener";
const HOSTILE_FAMILY_TRACKING_DISRUPT = "trackingDisruptor";
const HOSTILE_FAMILY_GUIDANCE_DISRUPT = "guidanceDisruptor";
const HOSTILE_FAMILY_TARGET_JAM = "concordTargetJam";

const BASE_HOSTILE_DEFINITIONS = Object.freeze({
  fighterTackle: Object.freeze({
    family: HOSTILE_FAMILY_FIGHTER_TACKLE,
    jammingType: "fighterTackle",
    modifierAttributeID: ATTRIBUTE_MAX_VELOCITY,
    modifierOperation: DOGMA_OP_POST_PERCENT,
    resistanceAttributeID: ATTRIBUTE_STASIS_WEBIFIER_RESISTANCE,
    stackingPenalized: true,
    affectsTargetDerivedState: true,
  }),
  web: Object.freeze({
    family: HOSTILE_FAMILY_WEB,
    jammingType: "webify",
    strengthAttributeID: ATTRIBUTE_SPEED_FACTOR,
    modifierAttributeID: ATTRIBUTE_MAX_VELOCITY,
    modifierOperation: DOGMA_OP_POST_PERCENT,
    resistanceAttributeID: ATTRIBUTE_STASIS_WEBIFIER_RESISTANCE,
    stackingPenalized: true,
    usesFalloff: true,
    affectsTargetDerivedState: true,
  }),
  paint: Object.freeze({
    family: HOSTILE_FAMILY_PAINT,
    jammingType: "ewTargetPaint",
    strengthAttributeID: ATTRIBUTE_SIGNATURE_RADIUS_BONUS,
    modifierAttributeID: ATTRIBUTE_SIGNATURE_RADIUS,
    modifierOperation: DOGMA_OP_POST_PERCENT,
    resistanceAttributeID: ATTRIBUTE_TARGET_PAINTER_RESISTANCE,
    stackingPenalized: true,
    usesFalloff: true,
    affectsTargetDerivedState: true,
  }),
  sensorDamp: Object.freeze({
    family: HOSTILE_FAMILY_SENSOR_DAMP,
    jammingType: "ewRemoteSensorDamp",
    resistanceAttributeID: ATTRIBUTE_SENSOR_DAMPENER_RESISTANCE,
    stackingPenalized: true,
    usesFalloff: true,
    affectsTargetDerivedState: true,
    moduleModifierSpecs: Object.freeze([
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_MAX_TARGET_RANGE_BONUS,
        modifiedAttributeID: ATTRIBUTE_MAX_TARGET_RANGE,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_SCAN_RESOLUTION_BONUS,
        modifiedAttributeID: ATTRIBUTE_SCAN_RESOLUTION,
        operation: DOGMA_OP_POST_PERCENT,
      }),
    ]),
  }),
  targetJam: Object.freeze({
    family: HOSTILE_FAMILY_TARGET_JAM,
    // Effect 3710 has no display name, icon or GUID in the pinned SDE. Keep it
    // out of the ordinary ECM/hostile HUD lanes instead of inventing a client
    // jamming type for it; the target-slot Dogma delta is its presentation.
    jammingType: "",
    stackingPenalized: false,
    usesFalloff: true,
    affectsTargetDerivedState: true,
    strictEffectRangeBinding: true,
    usesNpcActivationChance: true,
    moduleModifierSpecs: Object.freeze([
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_ENTITY_TARGET_JAM,
        modifiedAttributeID: ATTRIBUTE_MAX_LOCKED_TARGETS,
        operation: DOGMA_OP_POST_MUL,
        // Every current carrier deliberately declares zero: dropping zero as
        // an "empty" modifier would erase the entire effect.
        allowZeroValue: true,
      }),
    ]),
  }),
  scram: Object.freeze({
    family: HOSTILE_FAMILY_SCRAM,
    jammingType: "warpScramblerMWD",
    strengthAttributeID: ATTRIBUTE_WARP_SCRAMBLE_STRENGTH,
    modifierAttributeID: ATTRIBUTE_WARP_SCRAMBLE_STATUS,
    modifierOperation: DOGMA_OP_MOD_ADD,
    stackingPenalized: false,
    usesFalloff: true,
    affectsTargetDerivedState: true,
    blocksMicrowarpdrive: true,
    blocksMicroJumpDrive: true,
  }),
  disrupt: Object.freeze({
    family: HOSTILE_FAMILY_DISRUPT,
    jammingType: "warpScrambler",
    strengthAttributeID: ATTRIBUTE_WARP_SCRAMBLE_STRENGTH,
    modifierAttributeID: ATTRIBUTE_WARP_SCRAMBLE_STATUS,
    modifierOperation: DOGMA_OP_MOD_ADD,
    stackingPenalized: false,
    usesFalloff: true,
    affectsTargetDerivedState: true,
  }),
  neut: Object.freeze({
    family: HOSTILE_FAMILY_NEUT,
    jammingType: "ewEnergyNeut",
    strengthAttributeID: ATTRIBUTE_ENERGY_NEUTRALIZER_AMOUNT,
    strengthAttributeIDs: Object.freeze([
      ATTRIBUTE_ENERGY_NEUTRALIZER_AMOUNT,
      ATTRIBUTE_ENTITY_CAPACITOR_DRAIN_AMOUNT,
    ]),
    resistanceAttributeID: ATTRIBUTE_ENERGY_WARFARE_RESISTANCE,
    signatureResolutionAttributeID: ATTRIBUTE_ENERGY_NEUTRALIZER_SIGNATURE_RESOLUTION,
    stackingPenalized: false,
    usesFalloff: true,
    affectsTargetDerivedState: false,
  }),
  nos: Object.freeze({
    family: HOSTILE_FAMILY_NOS,
    jammingType: "ewEnergyVampire",
    strengthAttributeID: ATTRIBUTE_POWER_TRANSFER_AMOUNT,
    resistanceAttributeID: ATTRIBUTE_ENERGY_WARFARE_RESISTANCE,
    signatureResolutionAttributeID: ATTRIBUTE_ENERGY_NEUTRALIZER_SIGNATURE_RESOLUTION,
    nosOverrideAttributeID: ATTRIBUTE_NOS_OVERRIDE,
    stackingPenalized: false,
    usesFalloff: true,
    affectsTargetDerivedState: false,
  }),
  trackingDisrupt: Object.freeze({
    family: HOSTILE_FAMILY_TRACKING_DISRUPT,
    jammingType: "ewTrackingDisrupt",
    strengthAttributeID: ATTRIBUTE_TRACKING_SPEED_BONUS,
    resistanceAttributeID: ATTRIBUTE_WEAPON_DISRUPTION_RESISTANCE,
    stackingPenalized: true,
    usesFalloff: true,
    affectsTargetDerivedState: false,
    // weaponDisruptionUtil.GetTrackingDisruptionAttributes() keys the
    // categoryShip rows on invConst.typeGunnery — the same key the Remote
    // Tracking Computer uses in the opposite direction. Its categoryEntity /
    // categoryDrone / categoryFighter rows carry no key, which is why an item
    // declaring no required skill at all is never filtered.
    moduleModifierSpecs: Object.freeze([
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_MAX_RANGE_BONUS,
        modifiedAttributeID: ATTRIBUTE_MAX_RANGE,
        operation: DOGMA_OP_POST_PERCENT,
        requiredSkillTypeID: SKILL_GUNNERY,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_FALLOFF_BONUS,
        modifiedAttributeID: ATTRIBUTE_WEAPON_FALLOFF,
        operation: DOGMA_OP_POST_PERCENT,
        requiredSkillTypeID: SKILL_GUNNERY,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_TRACKING_SPEED_BONUS,
        modifiedAttributeID: ATTRIBUTE_TRACKING_SPEED,
        operation: DOGMA_OP_POST_PERCENT,
        requiredSkillTypeID: SKILL_GUNNERY,
      }),
    ]),
    chargeModifierSpecs: Object.freeze([
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_MISSILE_VELOCITY_BONUS,
        modifiedAttributeID: ATTRIBUTE_MAX_VELOCITY,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_EXPLOSION_DELAY_BONUS,
        modifiedAttributeID: ATTRIBUTE_EXPLOSION_DELAY,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_AOE_VELOCITY_BONUS,
        modifiedAttributeID: ATTRIBUTE_AOE_VELOCITY,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_AOE_CLOUD_SIZE_BONUS,
        modifiedAttributeID: ATTRIBUTE_AOE_CLOUD_SIZE,
        operation: DOGMA_OP_POST_PERCENT,
      }),
    ]),
  }),
  guidanceDisrupt: Object.freeze({
    family: HOSTILE_FAMILY_GUIDANCE_DISRUPT,
    jammingType: "ewGuidanceDisrupt",
    strengthAttributeID: ATTRIBUTE_MISSILE_VELOCITY_BONUS,
    resistanceAttributeID: ATTRIBUTE_WEAPON_DISRUPTION_RESISTANCE,
    stackingPenalized: true,
    usesFalloff: true,
    affectsTargetDerivedState: false,
    chargeModifierSpecs: Object.freeze([
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_MISSILE_VELOCITY_BONUS,
        modifiedAttributeID: ATTRIBUTE_MAX_VELOCITY,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_EXPLOSION_DELAY_BONUS,
        modifiedAttributeID: ATTRIBUTE_EXPLOSION_DELAY,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_AOE_VELOCITY_BONUS,
        modifiedAttributeID: ATTRIBUTE_AOE_VELOCITY,
        operation: DOGMA_OP_POST_PERCENT,
      }),
      Object.freeze({
        sourceAttributeID: ATTRIBUTE_AOE_CLOUD_SIZE_BONUS,
        modifiedAttributeID: ATTRIBUTE_AOE_CLOUD_SIZE,
        operation: DOGMA_OP_POST_PERCENT,
      }),
    ]),
  }),
});

const HOSTILE_EFFECT_DEFINITIONS_BY_NAME = Object.freeze({
  remotewebifierfalloff: BASE_HOSTILE_DEFINITIONS.web,
  remotewebifierentity: BASE_HOSTILE_DEFINITIONS.web,
  modifytargetspeed2: BASE_HOSTILE_DEFINITIONS.web,
  npcbehaviorwebifier: BASE_HOSTILE_DEFINITIONS.web,
  structuredecreasetargetspeed: BASE_HOSTILE_DEFINITIONS.web,
  structuremoduleeffectstasiswebifier: BASE_HOSTILE_DEFINITIONS.web,

  remotetargetpaintfalloff: BASE_HOSTILE_DEFINITIONS.paint,
  remotetargetpaintentity: BASE_HOSTILE_DEFINITIONS.paint,
  entitytargetpaint: BASE_HOSTILE_DEFINITIONS.paint,
  behaviortargetpainter: BASE_HOSTILE_DEFINITIONS.paint,
  structureewtargetpaint: BASE_HOSTILE_DEFINITIONS.paint,
  structuremoduleeffecttargetpainter: BASE_HOSTILE_DEFINITIONS.paint,

  targetmaxtargetrangeandscanresolutionbonushostile: BASE_HOSTILE_DEFINITIONS.sensorDamp,
  remotesensordampfalloff: BASE_HOSTILE_DEFINITIONS.sensorDamp,
  remotesensordampentity: BASE_HOSTILE_DEFINITIONS.sensorDamp,
  sensorboosttargetedhostile: BASE_HOSTILE_DEFINITIONS.sensorDamp,
  entitysensordampen: BASE_HOSTILE_DEFINITIONS.sensorDamp,
  behaviorsensordampener: BASE_HOSTILE_DEFINITIONS.sensorDamp,
  structuretargetmaxtargetrangeandscanresolutionbonushostile: BASE_HOSTILE_DEFINITIONS.sensorDamp,
  structuremoduleeffectremotesensordampener: BASE_HOSTILE_DEFINITIONS.sensorDamp,

  concordtargetjam: BASE_HOSTILE_DEFINITIONS.targetJam,

  warpscrambleblockmwdwithnpceffect: BASE_HOSTILE_DEFINITIONS.scram,
  warpscrambletargetmwdblockactivationforentity: BASE_HOSTILE_DEFINITIONS.scram,
  warpscrambleforentity: BASE_HOSTILE_DEFINITIONS.scram,
  shipmodulefocusedwarpscramblingscript: BASE_HOSTILE_DEFINITIONS.scram,
  structurewarpscrambleblockmwdwithnpceffect: BASE_HOSTILE_DEFINITIONS.scram,
  behaviorwarpscramble: BASE_HOSTILE_DEFINITIONS.scram,

  warpdisrupt: BASE_HOSTILE_DEFINITIONS.disrupt,
  // Both legacy POS point/scram batteries use this SDE effect. It modifies
  // warpScrambleStrength only; unlike the explicit MWD-blocking effects above,
  // neither its modifiers nor battery dogma establish propulsion suppression.
  warpscrambleforstructure: BASE_HOSTILE_DEFINITIONS.disrupt,
  shipmodulefocusedwarpdisruptionscript: BASE_HOSTILE_DEFINITIONS.disrupt,

  fighterabilitywarpdisruption: BASE_HOSTILE_DEFINITIONS.disrupt,
  fighterabilityenergyneutralizer: BASE_HOSTILE_DEFINITIONS.neut,
  fighterabilitystasiswebifier: BASE_HOSTILE_DEFINITIONS.web,
  fighterabilitytackle: BASE_HOSTILE_DEFINITIONS.fighterTackle,

  energyneutralizerfalloff: BASE_HOSTILE_DEFINITIONS.neut,
  npcbehaviorenergyneutralizer: BASE_HOSTILE_DEFINITIONS.neut,
  structureenergyneutralizerfalloff: BASE_HOSTILE_DEFINITIONS.neut,
  // The anchorable starbase battery flavour. Its own effect record carries
  // rangeAttributeID 98, so optimal, duration and amount all resolve through the
  // shared machinery; the other four starbase EWAR batteries reach this table
  // through the ship-module effects they share, and this one has its own name.
  starbaseenergyneutralizerfalloff: BASE_HOSTILE_DEFINITIONS.neut,
  // Not an SDE effect: the synthetic name `npcEntityEwarCatalog` gives a rat that
  // expresses a neutralizer purely as `energyNeutralizerEntityChance` attributes.
  entitycapacitatordrain: BASE_HOSTILE_DEFINITIONS.neut,
  entityenergyneutralizerfalloff: BASE_HOSTILE_DEFINITIONS.neut,

  energynosferatufalloff: BASE_HOSTILE_DEFINITIONS.nos,
  npcbehaviorenergynosferatu: BASE_HOSTILE_DEFINITIONS.nos,

  npcbehaviortrackingdisruptor: BASE_HOSTILE_DEFINITIONS.trackingDisrupt,
  npcentitytrackingdisruptor: BASE_HOSTILE_DEFINITIONS.trackingDisrupt,
  shipmoduletrackingdisruptor: BASE_HOSTILE_DEFINITIONS.trackingDisrupt,
  structuremoduleeffectweapondisruption: BASE_HOSTILE_DEFINITIONS.trackingDisrupt,

  npcbehaviorguidancedisruptor: BASE_HOSTILE_DEFINITIONS.guidanceDisrupt,
  guidancedisrupt: BASE_HOSTILE_DEFINITIONS.guidanceDisrupt,
  shipmoduleguidancedisruptor: BASE_HOSTILE_DEFINITIONS.guidanceDisrupt,
});

function isCloakedTargetEntity(entity) {
  return toInt(
    entity && (
      entity.isCloaked ??
      entity.cloakMode ??
      entity.cloaked
    ),
    0,
  ) > 0;
}

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, toFiniteNumber(value, min)));
}

function normalizeEffectName(effectRecord) {
  return String(effectRecord && effectRecord.name || "").trim().toLowerCase();
}

function resolveHostileDefinition(effectRecord) {
  return HOSTILE_EFFECT_DEFINITIONS_BY_NAME[normalizeEffectName(effectRecord)] || null;
}

// Shared with the NPC approach gate so it uses the activation lane's range bindings.
// Adapted from ciefa/evejs-ciefa-fork 97cf914b9 (EVE-198).
function resolveHostileReach(definition, effectRecord, attributeMap) {
  const strict = Boolean(definition && definition.strictEffectRangeBinding === true);
  return {
    range: getPreferredAttributeValue(
      attributeMap,
      strict
        ? [effectRecord && effectRecord.rangeAttributeID]
        : [effectRecord && effectRecord.rangeAttributeID, ATTRIBUTE_MAX_RANGE],
      0,
    ),
    falloff: getPreferredAttributeValue(
      attributeMap,
      strict
        ? [effectRecord && effectRecord.falloffAttributeID]
        : [effectRecord && effectRecord.falloffAttributeID, ATTRIBUTE_FALLOFF_EFFECTIVENESS],
      0,
    ),
  };
}

function resolveSourceCharacterID(entity) {
  return toInt(
    entity && (
      entity.characterID ??
      entity.pilotCharacterID ??
      (entity.session && (entity.session.characterID || entity.session.charid))
    ),
    0,
  );
}

function resolvePersistentRepeat(durationMs) {
  const cycleMs = Math.max(1, toFiniteNumber(durationMs, 1000));
  return Math.max(1, Math.ceil(PERSISTENT_SPECIAL_FX_WINDOW_MS / cycleMs));
}

function getPreferredAttributeValue(attributeMap, preferredAttributeIDs = [], fallback = 0) {
  for (const attributeID of preferredAttributeIDs) {
    const numericAttributeID = toInt(attributeID, 0);
    if (numericAttributeID <= 0) {
      continue;
    }
    const value = toFiniteNumber(attributeMap && attributeMap[numericAttributeID], NaN);
    if (Number.isFinite(value)) {
      return {
        value,
        attributeID: numericAttributeID,
      };
    }
  }
  return {
    value: toFiniteNumber(fallback, 0),
    attributeID: 0,
  };
}

// A family's magnitude can live on more than one attribute: the module flavour and
// the entity flavour of the same effect name off different SDE attributes. Take the
// first candidate the type actually carries a value on. A materialized zero for an
// attribute the type never declared must not shadow the one that holds the value —
// `getPreferredAttributeValue` stops at the first FINITE reading, which is right for
// a range or a duration and wrong for a strength, where absent and zero mean the
// same thing.
function resolveHostileStrengthValue(attributeMap, definition) {
  const candidateAttributeIDs = Array.isArray(definition && definition.strengthAttributeIDs)
    ? definition.strengthAttributeIDs
    : [definition && definition.strengthAttributeID];
  for (const attributeID of candidateAttributeIDs) {
    const numericAttributeID = toInt(attributeID, 0);
    if (numericAttributeID <= 0) {
      continue;
    }
    const value = toFiniteNumber(attributeMap && attributeMap[numericAttributeID], 0);
    if (Math.abs(value) > 1e-9) {
      return value;
    }
  }
  return 0;
}

function buildHostileModifierEntries(attributeMap, modifierSpecs = [], stackingPenalized = false) {
  const entries = [];
  for (const modifierSpec of Array.isArray(modifierSpecs) ? modifierSpecs : []) {
    const sourceAttributeID = toInt(modifierSpec && modifierSpec.sourceAttributeID, 0);
    const modifiedAttributeID = toInt(modifierSpec && modifierSpec.modifiedAttributeID, 0);
    const operation = toInt(modifierSpec && modifierSpec.operation, -1);
    if (sourceAttributeID <= 0 || modifiedAttributeID <= 0 || operation < 0) {
      continue;
    }
    const value = toFiniteNumber(attributeMap && attributeMap[sourceAttributeID], NaN);
    if (
      !Number.isFinite(value) ||
      (
        Math.abs(value) <= 1e-9 &&
        !(modifierSpec && modifierSpec.allowZeroValue === true)
      )
    ) {
      continue;
    }
    const requiredSkillTypeID = toInt(modifierSpec && modifierSpec.requiredSkillTypeID, 0);
    entries.push(Object.freeze({
      modifiedAttributeID,
      operation,
      value: roundNumber(value, 6),
      stackingPenalized: stackingPenalized === true,
      ...(requiredSkillTypeID > 0 ? { requiredSkillTypeID } : {}),
    }));
  }
  return Object.freeze(entries);
}

function buildTargetHostileStateKey(sourceBallID, moduleID, targetBallID) {
  return [
    toInt(sourceBallID, 0),
    toInt(moduleID, 0),
    toInt(targetBallID, 0),
  ].join(":");
}

function ensureTargetHostileState(targetEntity, create = false) {
  if (!targetEntity || typeof targetEntity !== "object") {
    return null;
  }
  if (!targetEntity.hostileModuleState && create) {
    targetEntity.hostileModuleState = {
      incomingEffects: new Map(),
      modifierEntries: Object.freeze([]),
      weaponModuleModifierEntries: Object.freeze([]),
      weaponChargeModifierEntries: Object.freeze([]),
      aggregateSignature: "",
      warpScrambleStatus: 0,
      microwarpdriveBlocked: false,
      microJumpDriveBlocked: false,
      targetLockSuppressed: false,
    };
  }
  return targetEntity.hostileModuleState && targetEntity.hostileModuleState.incomingEffects instanceof Map
    ? targetEntity.hostileModuleState
    : null;
}

function getEntityPassiveAttributeValue(entity, attributeID, fallback = 0) {
  const attributes =
    entity &&
    entity.passiveDerivedState &&
    entity.passiveDerivedState.attributes &&
    typeof entity.passiveDerivedState.attributes === "object"
      ? entity.passiveDerivedState.attributes
      : null;
  const numericAttributeID = toInt(attributeID, 0);
  if (attributes && Number.isFinite(Number(attributes[numericAttributeID]))) {
    return Number(attributes[numericAttributeID]);
  }
  return toFiniteNumber(fallback, 0);
}

function resolveTargetResistanceMultiplier(targetEntity, resistanceAttributeID) {
  if (toInt(resistanceAttributeID, 0) <= 0) {
    return 1;
  }
  // Unit 108 is an inverse absolute percent: 1 applies fully, 0 is fully resisted.
  return roundNumber(clamp(
    getEntityPassiveAttributeValue(targetEntity, resistanceAttributeID, 1),
    0,
    1,
  ), 6);
}

// `toFiniteNumber(Infinity, 0)` is 0, so folding the range read straight into
// it collapsed an unmeasurable distance to POINT BLANK — a neut or web at full
// strength from any range, the fail-open mirror of the tractor beam's
// fail-closed bug. Keep the two cases it conflated apart. A wired reader that
// answers non-finite means the pair genuinely cannot be measured this tick, and
// an effect that cannot be placed has to be refused rather than applied at zero
// metres. An absent reader says something different: every production caller
// wires one, so only a harness that does not gate on range at all reaches that
// branch, and it keeps the old zero.
function readCallbackSurfaceDistanceMeters(callbacks, sourceEntity, targetEntity) {
  if (!callbacks || typeof callbacks.getEntitySurfaceDistance !== "function") {
    return 0;
  }
  const reported = Number(
    callbacks.getEntitySurfaceDistance(sourceEntity, targetEntity),
  );
  return Number.isFinite(reported) ? Math.max(0, reported) : Number.NaN;
}

function resolveHostileRangeMultiplier(effectState, sourceEntity, targetEntity, callbacks = {}) {
  const surfaceDistance = readCallbackSurfaceDistanceMeters(
    callbacks,
    sourceEntity,
    targetEntity,
  );
  if (!Number.isFinite(surfaceDistance)) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance: Infinity,
    };
  }
  const optimalRangeMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.hostileMaxRangeMeters, 0),
  );
  const falloffMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.hostileFalloffMeters, 0),
  );

  if (surfaceDistance <= optimalRangeMeters + 1) {
    return {
      success: true,
      multiplier: 1,
      surfaceDistance,
    };
  }
  if (falloffMeters <= 0) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance,
    };
  }

  const distanceIntoFalloff = surfaceDistance - optimalRangeMeters;
  if (distanceIntoFalloff > falloffMeters + 1) {
    return {
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      stopReason: "target",
      surfaceDistance,
    };
  }

  const normalizedDistance = distanceIntoFalloff / Math.max(falloffMeters, 1);
  return {
    success: true,
    multiplier: roundNumber(0.5 ** (normalizedDistance ** 2), 6),
    surfaceDistance,
  };
}

function resolveEnergyWarfareMultiplier(effectState, targetEntity, rangeMultiplier) {
  const resistanceMultiplier = resolveTargetResistanceMultiplier(
    targetEntity,
    effectState && effectState.hostileResistanceAttributeID,
  );
  const signatureResolution = Math.max(
    0,
    toFiniteNumber(effectState && effectState.hostileEnergySignatureResolution, 0),
  );
  const targetSignatureRadius = Math.max(
    0,
    toFiniteNumber(targetEntity && targetEntity.signatureRadius, 0),
  );
  const signatureMultiplier =
    signatureResolution > 0 && targetSignatureRadius > 0
      ? Math.min(1, targetSignatureRadius / signatureResolution)
      : 1;
  return roundNumber(
    Math.max(rangeMultiplier, 0) *
      Math.max(resistanceMultiplier, 0) *
      Math.max(signatureMultiplier, 0),
    6,
  );
}

function buildHostileTargetRecord(sourceEntity, effectState, targetEntity, nowMs, rangeMultiplier) {
  return Object.freeze({
    key: buildTargetHostileStateKey(
      sourceEntity && sourceEntity.itemID,
      effectState && effectState.moduleID,
      targetEntity && targetEntity.itemID,
    ),
    sourceBallID: toInt(sourceEntity && sourceEntity.itemID, 0),
    moduleID: toInt(effectState && effectState.moduleID, 0),
    effectID: toInt(effectState && effectState.effectID, 0),
    moduleTypeID: toInt(effectState && effectState.typeID, 0),
    moduleGroupID: toInt(effectState && effectState.groupID, 0),
    chargeTypeID: toInt(effectState && effectState.chargeTypeID, 0),
    targetBallID: toInt(targetEntity && targetEntity.itemID, 0),
    family: String(effectState && effectState.hostileFamily || ""),
    jammingType: String(effectState && effectState.hostileJammingType || ""),
    startedAtMs: Math.max(0, toFiniteNumber(nowMs, Date.now())),
    expiresAtMs: Math.max(
      0,
      toFiniteNumber(nowMs, Date.now()) +
        Math.max(1, toFiniteNumber(effectState && effectState.durationMs, 1000)),
    ),
    rangeMultiplier: roundNumber(rangeMultiplier, 6),
    modifierAttributeID: toInt(effectState && effectState.hostileModifierAttributeID, 0),
    modifierOperation: toInt(effectState && effectState.hostileModifierOperation, -1),
    modifierValue: roundNumber(toFiniteNumber(effectState && effectState.hostileStrengthValue, 0), 6),
    moduleModifierEntries: Object.freeze(
      (Array.isArray(effectState && effectState.hostileModuleModifierEntries)
        ? effectState.hostileModuleModifierEntries
        : []
      ).map((entry) => Object.freeze({ ...entry })),
    ),
    chargeModifierEntries: Object.freeze(
      (Array.isArray(effectState && effectState.hostileChargeModifierEntries)
        ? effectState.hostileChargeModifierEntries
        : []
      ).map((entry) => Object.freeze({ ...entry })),
    ),
    resistanceAttributeID: toInt(effectState && effectState.hostileResistanceAttributeID, 0),
    energySignatureResolution: Math.max(
      0,
      roundNumber(toFiniteNumber(effectState && effectState.hostileEnergySignatureResolution, 0), 6),
    ),
    scrambleStrength: roundNumber(
      toFiniteNumber(effectState && effectState.hostileWarpScrambleStrength, 0),
      6,
    ),
    stackingPenalized: effectState && effectState.hostileStackingPenalized === true,
    affectsTargetDerivedState: effectState && effectState.hostileAffectsTargetDerivedState === true,
    blocksMicrowarpdrive: effectState && effectState.hostileBlocksMicrowarpdrive === true,
    blocksMicroJumpDrive: effectState && effectState.hostileBlocksMicroJumpDrive === true,
    nosOverride: effectState && effectState.hostileNosOverride === true,
    activationChance: roundNumber(
      clamp(effectState && effectState.hostileActivationChance, 0, 1),
      6,
    ),
  });
}

function buildAggregateSignature(
  entries,
  warpScrambleStatus,
  microwarpdriveBlocked,
  microJumpDriveBlocked,
  targetLockSuppressed,
) {
  return JSON.stringify({
    entries: (Array.isArray(entries) ? entries : []).map((entry) => ({
      attribute: toInt(entry && entry.modifiedAttributeID, 0),
      operation: toInt(entry && entry.operation, 0),
      value: roundNumber(entry && entry.value, 6),
      stackingPenalized: entry && entry.stackingPenalized === true,
    })),
    warpScrambleStatus: roundNumber(warpScrambleStatus, 6),
    microwarpdriveBlocked: microwarpdriveBlocked === true,
    microJumpDriveBlocked: microJumpDriveBlocked === true,
    targetLockSuppressed: targetLockSuppressed === true,
  });
}

function recomputeTargetAggregateState(targetEntity) {
  const targetState = ensureTargetHostileState(targetEntity, false);
  if (!targetState) {
    return {
      changed: false,
      modifierEntries: [],
      weaponModuleModifierEntries: [],
      weaponChargeModifierEntries: [],
      warpScrambleStatus: 0,
      microwarpdriveBlocked: false,
      microJumpDriveBlocked: false,
      targetLockSuppressed: false,
    };
  }

  const modifierEntries = [];
  const weaponModuleModifierEntries = [];
  const weaponChargeModifierEntries = [];
  let warpScrambleStatus = 0;
  let microwarpdriveBlocked = false;
  let microJumpDriveBlocked = false;
  let targetLockSuppressed = false;

  for (const record of targetState.incomingEffects.values()) {
    if (!record) {
      continue;
    }

    if (
      record.family === HOSTILE_FAMILY_WEB ||
      record.family === HOSTILE_FAMILY_PAINT ||
      record.family === HOSTILE_FAMILY_FIGHTER_TACKLE
    ) {
      const resistanceMultiplier = resolveTargetResistanceMultiplier(
        targetEntity,
        record.resistanceAttributeID,
      );
      const value = roundNumber(
        record.modifierValue *
          Math.max(record.rangeMultiplier, 0) *
          Math.max(resistanceMultiplier, 0),
        6,
      );
      if (Math.abs(value) > 1e-6) {
        modifierEntries.push({
          modifiedAttributeID: record.modifierAttributeID,
          operation: record.modifierOperation,
          value,
          stackingPenalized: record.stackingPenalized === true,
        });
      }
      if (record.family !== HOSTILE_FAMILY_FIGHTER_TACKLE) continue;
    }

    if (record.family === HOSTILE_FAMILY_SENSOR_DAMP) {
      const resistanceMultiplier = resolveTargetResistanceMultiplier(
        targetEntity,
        record.resistanceAttributeID,
      );
      const scaledMultiplier =
        Math.max(record.rangeMultiplier, 0) *
        Math.max(resistanceMultiplier, 0);
      for (const entry of record.moduleModifierEntries || []) {
        const value = roundNumber(
          toFiniteNumber(entry && entry.value, 0) * scaledMultiplier,
          6,
        );
        if (Math.abs(value) <= 1e-6) {
          continue;
        }
        modifierEntries.push({
          modifiedAttributeID: toInt(entry && entry.modifiedAttributeID, 0),
          operation: toInt(entry && entry.operation, -1),
          value,
          stackingPenalized: entry && entry.stackingPenalized === true,
        });
      }
      continue;
    }

    if (record.family === HOSTILE_FAMILY_TARGET_JAM) {
      // concordTargetJam is not strength-vs-sensor ECM. Its pinned modifier is
      // targetID.maxLockedTargets PostMul entityTargetJam, and all 13 carriers
      // declare that multiplier as exactly zero. Falloff controls whether the
      // cycle lands; it must not scale a zero multiplier back toward anything.
      for (const entry of record.moduleModifierEntries || []) {
        const modifiedAttributeID = toInt(entry && entry.modifiedAttributeID, 0);
        const operation = toInt(entry && entry.operation, -1);
        const value = toFiniteNumber(entry && entry.value, NaN);
        if (modifiedAttributeID <= 0 || operation < 0 || !Number.isFinite(value)) {
          continue;
        }
        modifierEntries.push({
          modifiedAttributeID,
          operation,
          value: roundNumber(value, 6),
          stackingPenalized: false,
        });
        if (
          modifiedAttributeID === ATTRIBUTE_MAX_LOCKED_TARGETS &&
          operation === DOGMA_OP_POST_MUL &&
          Math.abs(value) <= 1e-9
        ) {
          targetLockSuppressed = true;
        }
      }
      continue;
    }

    if (
      record.family === HOSTILE_FAMILY_SCRAM ||
      record.family === HOSTILE_FAMILY_DISRUPT ||
      record.family === HOSTILE_FAMILY_FIGHTER_TACKLE
    ) {
      const value = roundNumber(
        record.scrambleStrength * Math.max(record.rangeMultiplier, 0),
        6,
      );
      if (Math.abs(value) > 1e-6) {
        modifierEntries.push({
          modifiedAttributeID: ATTRIBUTE_WARP_SCRAMBLE_STATUS,
          operation: DOGMA_OP_MOD_ADD,
          value,
          stackingPenalized: false,
        });
        warpScrambleStatus += value;
      }
      microwarpdriveBlocked = microwarpdriveBlocked || record.blocksMicrowarpdrive === true;
      microJumpDriveBlocked = microJumpDriveBlocked || record.blocksMicroJumpDrive === true;
      continue;
    }

    if (
      record.family === HOSTILE_FAMILY_TRACKING_DISRUPT ||
      record.family === HOSTILE_FAMILY_GUIDANCE_DISRUPT
    ) {
      const resistanceMultiplier = resolveTargetResistanceMultiplier(
        targetEntity,
        record.resistanceAttributeID,
      );
      const scaledMultiplier =
        Math.max(record.rangeMultiplier, 0) *
        Math.max(resistanceMultiplier, 0);
      for (const entry of record.moduleModifierEntries || []) {
        const value = roundNumber(
          toFiniteNumber(entry && entry.value, 0) * scaledMultiplier,
          6,
        );
        if (Math.abs(value) <= 1e-6) {
          continue;
        }
        const requiredSkillTypeID = toInt(entry && entry.requiredSkillTypeID, 0);
        weaponModuleModifierEntries.push({
          modifiedAttributeID: toInt(entry && entry.modifiedAttributeID, 0),
          operation: toInt(entry && entry.operation, -1),
          value,
          stackingPenalized: entry && entry.stackingPenalized === true,
          ...(requiredSkillTypeID > 0 ? { requiredSkillTypeID } : {}),
        });
      }
      for (const entry of record.chargeModifierEntries || []) {
        const value = roundNumber(
          toFiniteNumber(entry && entry.value, 0) * scaledMultiplier,
          6,
        );
        if (Math.abs(value) <= 1e-6) {
          continue;
        }
        const requiredSkillTypeID = toInt(entry && entry.requiredSkillTypeID, 0);
        weaponChargeModifierEntries.push({
          modifiedAttributeID: toInt(entry && entry.modifiedAttributeID, 0),
          operation: toInt(entry && entry.operation, -1),
          value,
          stackingPenalized: entry && entry.stackingPenalized === true,
          ...(requiredSkillTypeID > 0 ? { requiredSkillTypeID } : {}),
        });
      }
    }
  }

  const nextSignature = buildAggregateSignature(
    modifierEntries,
    warpScrambleStatus,
    microwarpdriveBlocked,
    microJumpDriveBlocked,
    targetLockSuppressed,
  );
  const changed = nextSignature !== String(targetState.aggregateSignature || "");
  targetState.modifierEntries = Object.freeze(
    modifierEntries.map((entry) => Object.freeze({ ...entry })),
  );
  targetState.weaponModuleModifierEntries = Object.freeze(
    weaponModuleModifierEntries.map((entry) => Object.freeze({ ...entry })),
  );
  targetState.weaponChargeModifierEntries = Object.freeze(
    weaponChargeModifierEntries.map((entry) => Object.freeze({ ...entry })),
  );
  targetState.aggregateSignature = nextSignature;
  targetState.warpScrambleStatus = roundNumber(warpScrambleStatus, 6);
  targetState.microwarpdriveBlocked = microwarpdriveBlocked;
  targetState.microJumpDriveBlocked = microJumpDriveBlocked;
  targetState.targetLockSuppressed = targetLockSuppressed;
  return {
    changed,
    modifierEntries: targetState.modifierEntries,
    weaponModuleModifierEntries: targetState.weaponModuleModifierEntries,
    weaponChargeModifierEntries: targetState.weaponChargeModifierEntries,
    warpScrambleStatus: targetState.warpScrambleStatus,
    microwarpdriveBlocked,
    microJumpDriveBlocked,
    targetLockSuppressed,
  };
}

function collectModifierEntriesForTarget(targetEntity) {
  const targetState = ensureTargetHostileState(targetEntity, false);
  if (!targetState || !Array.isArray(targetState.modifierEntries)) {
    return [];
  }
  return [...targetState.modifierEntries];
}

// `weaponModuleItem` is the weapon the caller is about to build a snapshot for;
// it decides whether a skill-keyed entry applies. Omitting it keeps every entry.
function collectWeaponModifierEntriesForTarget(targetEntity, weaponModuleItem = null) {
  const targetState = ensureTargetHostileState(targetEntity, false);
  if (!targetState) {
    return {
      moduleEntries: [],
      chargeEntries: [],
    };
  }
  return {
    moduleEntries: filterProjectedWeaponModifierEntries(
      Array.isArray(targetState.weaponModuleModifierEntries)
        ? targetState.weaponModuleModifierEntries
        : [],
      weaponModuleItem,
    ),
    chargeEntries: filterProjectedWeaponModifierEntries(
      Array.isArray(targetState.weaponChargeModifierEntries)
        ? targetState.weaponChargeModifierEntries
        : [],
      weaponModuleItem,
    ),
  };
}

function upsertTargetHostileRecord(targetEntity, record) {
  const targetState = ensureTargetHostileState(targetEntity, true);
  const previousRecord = targetState.incomingEffects.get(record.key) || null;
  targetState.incomingEffects.set(record.key, record);
  return {
    changed:
      !previousRecord ||
      previousRecord.rangeMultiplier !== record.rangeMultiplier ||
      previousRecord.startedAtMs !== record.startedAtMs ||
      previousRecord.expiresAtMs !== record.expiresAtMs,
    previousRecord,
    record,
  };
}

function removeTargetHostileRecord(targetEntity, sourceEntity, effectState) {
  const targetState = ensureTargetHostileState(targetEntity, false);
  if (!targetState) {
    return null;
  }
  const key = buildTargetHostileStateKey(
    sourceEntity && sourceEntity.itemID,
    effectState && effectState.moduleID,
    targetEntity && targetEntity.itemID,
  );
  const existing = targetState.incomingEffects.get(key) || null;
  if (!existing) {
    return null;
  }
  targetState.incomingEffects.delete(key);
  return existing;
}

function resolveHostileModuleActivation({
  scene,
  entity,
  moduleItem,
  effectRecord,
  chargeItem = null,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalDirectModifierEntries = null,
  options = {},
  callbacks = {},
} = {}) {
  const definition = resolveHostileDefinition(effectRecord);
  if (!definition) {
    return { matched: false };
  }

  if (!scene || !entity || !moduleItem || !shipItem) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const normalizedTargetID = toInt(options.targetID, 0);
  if (normalizedTargetID <= 0) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_REQUIRED",
    };
  }

  const targetEntity =
    callbacks.getEntityByID && typeof callbacks.getEntityByID === "function"
      ? callbacks.getEntityByID(normalizedTargetID)
      : scene.getEntityByID(normalizedTargetID);
  if (
    !targetEntity ||
    (targetEntity.kind !== "ship" && !["array", "dread"].includes(targetEntity.homefrontRole)) ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }
  if (isCloakedTargetEntity(targetEntity)) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  if (
    !callbacks.isEntityLockedTarget ||
    callbacks.isEntityLockedTarget(entity, normalizedTargetID) !== true
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_LOCKED",
    };
  }

  const characterID = resolveSourceCharacterID(entity);
  const moduleAttributes = buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    {
      additionalLocationModifierSources:
        characterID > 0
          ? getActiveImplantLocationModifierSources(characterID)
          : [],
      additionalShipModifierEntries:
        characterID > 0
          ? getActiveImplantShipModifierEntries(characterID)
          : [],
      additionalDirectModifierEntries: Array.isArray(
        additionalDirectModifierEntries,
      )
        ? additionalDirectModifierEntries
        : [],
    },
  );
  if (!moduleAttributes) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const durationResolution = getPreferredAttributeValue(
    moduleAttributes,
    [
      effectRecord && effectRecord.durationAttributeID,
      ATTRIBUTE_DURATION,
      ATTRIBUTE_SPEED,
    ],
    1000,
  );
  const { range: rangeResolution, falloff: falloffResolution } = resolveHostileReach(
    definition,
    effectRecord,
    moduleAttributes,
  );
  const dischargeResolution = getPreferredAttributeValue(
    moduleAttributes,
    [
      effectRecord && effectRecord.dischargeAttributeID,
      ATTRIBUTE_CAPACITOR_NEED,
    ],
    0,
  );
  const activationChanceResolution = definition.usesNpcActivationChance === true
    ? getPreferredAttributeValue(
        moduleAttributes,
        [effectRecord && effectRecord.npcActivationChanceAttributeID],
        0,
      )
    : { value: 1, attributeID: 0 };
  const rawDurationMs = durationResolution.value;
  const durationAttributeID =
    durationResolution.attributeID > 0 ? durationResolution.attributeID : ATTRIBUTE_SPEED;
  const moduleModifierEntries = buildHostileModifierEntries(
    moduleAttributes,
    definition.moduleModifierSpecs,
    definition.stackingPenalized === true,
  );
  const chargeModifierEntries = buildHostileModifierEntries(
    moduleAttributes,
    definition.chargeModifierSpecs,
    definition.stackingPenalized === true,
  );

  const effectStatePatch = {
    hostileModuleEffect: true,
    hostileFamily: definition.family,
    hostileJammingType: String(definition.jammingType || ""),
    hostileMaxRangeMeters: Math.max(
      0,
      roundNumber(rangeResolution.value, 3),
    ),
    hostileFalloffMeters: Math.max(
      0,
      roundNumber(falloffResolution.value, 3),
    ),
    hostileStrengthValue: roundNumber(
      resolveHostileStrengthValue(moduleAttributes, definition),
      6,
    ),
    hostileModifierAttributeID: Math.max(0, toInt(definition.modifierAttributeID, 0)),
    hostileModifierOperation: toInt(definition.modifierOperation, -1),
    hostileModuleModifierEntries: moduleModifierEntries,
    hostileChargeModifierEntries: chargeModifierEntries,
    hostileResistanceAttributeID: Math.max(0, toInt(definition.resistanceAttributeID, 0)),
    hostileWarpScrambleStrength: roundNumber(
      resolveHostileStrengthValue(moduleAttributes, {
        strengthAttributeIDs: WARP_SCRAMBLE_STRENGTH_ATTRIBUTE_IDS,
      }),
      6,
    ),
    hostileEnergySignatureResolution: Math.max(
      0,
      roundNumber(
        toFiniteNumber(moduleAttributes[ATTRIBUTE_ENERGY_NEUTRALIZER_SIGNATURE_RESOLUTION], 0),
        6,
      ),
    ),
    hostileNosOverride: toFiniteNumber(
      moduleAttributes[ATTRIBUTE_NOS_OVERRIDE],
      0,
    ) > 0,
    hostileStackingPenalized: definition.stackingPenalized === true,
    hostileAffectsTargetDerivedState: definition.affectsTargetDerivedState === true,
    hostileActivationChance: roundNumber(
      clamp(activationChanceResolution.value, 0, 1),
      6,
    ),
    hostileActivationChanceAttributeID: Math.max(
      0,
      toInt(activationChanceResolution.attributeID, 0),
    ),
    hostileBlocksMicrowarpdrive: definition.blocksMicrowarpdrive === true,
    hostileBlocksMicroJumpDrive: definition.blocksMicroJumpDrive === true,
    forceFreshAcquireSpecialFxReplay: true,
    repeat: resolvePersistentRepeat(rawDurationMs),
  };

  const rangeResult = resolveHostileRangeMultiplier(
    effectStatePatch,
    entity,
    targetEntity,
    callbacks,
  );
  if (!rangeResult.success) {
    return {
      matched: true,
      success: false,
      errorMsg: rangeResult.errorMsg || "TARGET_OUT_OF_RANGE",
      stopReason: rangeResult.stopReason || "target",
    };
  }

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      rangeMultiplier: rangeResult.multiplier,
      runtimeAttrs: {
        capNeed: Math.max(
          0,
          roundNumber(dischargeResolution.value, 6),
        ),
        durationMs: Math.max(1, roundNumber(rawDurationMs, 3)),
        durationAttributeID,
        reactivationDelayMs: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0), 3),
        ),
        maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
        weaponFamily: null,
        attributeOverrides: {
          ...moduleAttributes,
        },
      },
      effectStatePatch,
    },
  };
}

function applyHostileModuleState({
  scene,
  sourceEntity,
  targetEntity,
  effectState,
  nowMs,
} = {}) {
  if (!scene || !sourceEntity || !targetEntity || !effectState) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const record = buildHostileTargetRecord(
    sourceEntity,
    effectState,
    targetEntity,
    nowMs,
    1,
  );
  const targetState = ensureTargetHostileState(targetEntity, true);
  const previousRecord = targetState.incomingEffects.get(record.key) || null;
  targetState.incomingEffects.set(record.key, record);
  const aggregateResult = recomputeTargetAggregateState(targetEntity);
  return {
    success: true,
    data: {
      targetEntity,
      previousRecord,
      record,
      aggregateChanged: aggregateResult.changed,
    },
  };
}

function refreshHostileModuleState({
  scene,
  sourceEntity,
  targetEntity,
  effectState,
  nowMs,
  callbacks = {},
} = {}) {
  if (!scene || !sourceEntity || !targetEntity || !effectState) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
      stopReason: "module",
    };
  }

  measureCareerHostileDuration({ scene, entity: sourceEntity, effectState, nowMs, callbacks });

  const rangeResult = resolveHostileRangeMultiplier(
    effectState,
    sourceEntity,
    targetEntity,
    callbacks,
  );
  if (!rangeResult.success) {
    return rangeResult;
  }

  if (effectState.hostileFamily === HOSTILE_FAMILY_TARGET_JAM) {
    const activationChance = clamp(effectState.hostileActivationChance, 0, 1);
    // A zero PostMul has no meaningful magnitude to attenuate. Treat the
    // standard hostile falloff multiplier as the cycle's electronic success
    // chance instead: at optimal the hull's attr930 chance is unchanged, at one
    // falloff it is halved, and a successful cycle still applies the SDE's exact
    // zero multiplier.
    const applicationChance = clamp(
      activationChance * Math.max(rangeResult.multiplier, 0),
      0,
      1,
    );
    const randomRoll = applicationChance >= 1
      ? 0
      : clamp(
          callbacks && typeof callbacks.random === "function"
            ? callbacks.random()
            : Math.random(),
          0,
          1,
        );
    const effectApplied = applicationChance > 0 && randomRoll < applicationChance;
    if (!effectApplied) {
      const removedRecord = removeTargetHostileRecord(
        targetEntity,
        sourceEntity,
        effectState,
      );
      const aggregateResult = recomputeTargetAggregateState(targetEntity);
      return {
        success: true,
        data: {
          targetEntity,
          record: null,
          removedRecord,
          recordChanged: Boolean(removedRecord),
          aggregateChanged: aggregateResult.changed,
          multiplier: rangeResult.multiplier,
          activationChance: roundNumber(activationChance, 6),
          applicationChance: roundNumber(applicationChance, 6),
          randomRoll: roundNumber(randomRoll, 6),
          effectApplied: false,
        },
      };
    }
  }

  const record = buildHostileTargetRecord(
    sourceEntity,
    effectState,
    targetEntity,
    nowMs,
    rangeResult.multiplier,
  );
  const upsertResult = upsertTargetHostileRecord(targetEntity, record);
  const aggregateResult = recomputeTargetAggregateState(targetEntity);
  const effectiveMultiplier = Math.max(record.rangeMultiplier, 0) *
    Math.max(resolveTargetResistanceMultiplier(targetEntity, record.resistanceAttributeID), 0);
  const effectiveMagnitude = [HOSTILE_FAMILY_SCRAM, HOSTILE_FAMILY_DISRUPT].includes(record.family)
    ? Math.abs(record.scrambleStrength) : Math.max(Math.abs(record.modifierValue),
      ...(record.moduleModifierEntries || []).map(entry => Math.abs(entry.value || 0)));
  require("../../services/inventory/careerCombatOutcomes").startEwar(
    sourceEntity, targetEntity, effectState, record, effectiveMultiplier * effectiveMagnitude > 1e-6, scene,
  );
  return {
    success: true,
    data: {
      targetEntity,
      record,
      recordChanged: upsertResult.changed,
      aggregateChanged: aggregateResult.changed,
      multiplier: rangeResult.multiplier,
      activationChance: roundNumber(
        clamp(effectState.hostileActivationChance, 0, 1),
        6,
      ),
      applicationChance: effectState.hostileFamily === HOSTILE_FAMILY_TARGET_JAM
        ? roundNumber(
            clamp(
              effectState.hostileActivationChance * Math.max(rangeResult.multiplier, 0),
              0,
              1,
            ),
            6,
          )
        : 1,
      effectApplied: true,
    },
  };
}

function removeHostileModuleState({
  targetEntity,
  sourceEntity,
  effectState,
  scene,
  nowMs,
} = {}) {
  if (!targetEntity || !sourceEntity || !effectState) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }
  if (scene && Number.isFinite(nowMs)) {
    require("../../services/inventory/careerCombatOutcomes").finishEwar(
      scene, sourceEntity, targetEntity, effectState, nowMs,
      canEntitiesInteractLocally(sourceEntity, targetEntity),
    );
  }
  delete effectState.careerEwarSpan;
  const removedRecord = removeTargetHostileRecord(targetEntity, sourceEntity, effectState);
  const aggregateResult = recomputeTargetAggregateState(targetEntity);
  return {
    success: true,
    data: {
      removedRecord,
      targetEntity,
      aggregateChanged: aggregateResult.changed,
      becameMicrowarpdriveBlocked: aggregateResult.microwarpdriveBlocked,
      becameMicroJumpDriveBlocked: aggregateResult.microJumpDriveBlocked,
    },
  };
}

function measureCareerHostileDuration({ scene, entity, effectState, nowMs, callbacks = {} } = {}) {
  if (!effectState?.careerEwarSpan) return { success: true };
  const target = scene?.getEntityByID(effectState.targetID);
  const range = target && resolveHostileRangeMultiplier(effectState, entity, target, callbacks);
  const valid = Boolean(target && !isCloakedTargetEntity(target) && canEntitiesInteractLocally(entity, target) &&
    callbacks.isEntityLockedTarget?.(entity, target.itemID) === true && range?.success && range.multiplier > 0 &&
    resolveTargetResistanceMultiplier(target, effectState.hostileResistanceAttributeID) > 0);
  return require("../../services/inventory/careerCombatOutcomes").measureEwar(
    scene, entity, target, effectState, nowMs, valid,
  );
}

function resolveNosTransferAllowed(sourceEntity, targetEntity, effectState, callbacks = {}) {
  if (effectState && effectState.hostileNosOverride === true) {
    return true;
  }
  const sourceCapAmount = callbacks.getEntityCapacitorAmount
    ? callbacks.getEntityCapacitorAmount(sourceEntity)
    : 0;
  const targetCapAmount = callbacks.getEntityCapacitorAmount
    ? callbacks.getEntityCapacitorAmount(targetEntity)
    : 0;
  return sourceCapAmount + 1e-6 < targetCapAmount;
}

function executeHostileModuleCycle({
  scene,
  session,
  entity,
  effectState,
  nowMs,
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return {
      success: false,
      stopReason: "module",
    };
  }

  const targetEntity =
    callbacks.getEntityByID && typeof callbacks.getEntityByID === "function"
      ? callbacks.getEntityByID(toInt(effectState.targetID, 0))
      : scene.getEntityByID(toInt(effectState.targetID, 0));
  if (
    !targetEntity ||
    (effectState.hostileFamily === HOSTILE_FAMILY_FIGHTER_TACKLE
      ? !["drone", "fighter"].includes(targetEntity.kind)
      : targetEntity.kind !== "ship" && !["array", "dread"].includes(targetEntity.homefrontRole)) ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }
  if (isCloakedTargetEntity(targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }

  if (
    !callbacks.isEntityLockedTarget ||
    callbacks.isEntityLockedTarget(entity, effectState.targetID) !== true
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_LOCKED",
      stopReason: "target",
    };
  }

  const refreshResult = refreshHostileModuleState({
    scene,
    sourceEntity: entity,
    targetEntity,
    effectState,
    nowMs,
    callbacks,
  });
  if (!refreshResult.success) {
    return refreshResult;
  }

  if (effectState.hostileFamily === HOSTILE_FAMILY_NEUT) {
    const career = require("../../services/inventory/careerCombatOutcomes");
    const outcome = career.begin(entity, targetEntity, effectState, "neutralizer", nowMs);
    if (outcome?.duplicate) return { success: true, data: { targetEntity, appliedAmount: 0, duplicate: true } };
    const warfareMultiplier = resolveEnergyWarfareMultiplier(
      effectState,
      targetEntity,
      refreshResult.data.multiplier,
    );
    const requestedAmount = Math.max(
      0,
      toFiniteNumber(effectState.hostileStrengthValue, 0),
    ) * Math.max(warfareMultiplier, 0);
    const targetCapCapacity = Math.max(
      0,
      toFiniteNumber(targetEntity && targetEntity.capacitorCapacity, 0),
    );
    const previousTargetChargeAmount = callbacks.getEntityCapacitorAmount
      ? callbacks.getEntityCapacitorAmount(targetEntity)
      : 0;
    const appliedAmount = Math.min(previousTargetChargeAmount, requestedAmount);
    if (targetCapCapacity > 0 && appliedAmount > 0 && callbacks.setEntityCapacitorRatio) {
      callbacks.setEntityCapacitorRatio(
        targetEntity,
        (previousTargetChargeAmount - appliedAmount) / targetCapCapacity,
      );
      const committed = career.commit(outcome, "neutralizer", appliedAmount, nowMs, [entity, targetEntity]);
      if (!committed?.success) {
        callbacks.setEntityCapacitorRatio(targetEntity, previousTargetChargeAmount / targetCapCapacity);
        return { ...committed, stopReason: "persistence" };
      }
      if ((!committed.handled || !committed.sealedItemIDs?.includes(Number(targetEntity.itemID))) &&
          callbacks.persistEntityCapacitorRatio) {
        callbacks.persistEntityCapacitorRatio(targetEntity);
      }
      if (targetEntity.session && callbacks.notifyCapacitorChangeToSession) {
        callbacks.notifyCapacitorChangeToSession(
          targetEntity.session,
          targetEntity,
          nowMs,
          previousTargetChargeAmount,
        );
      }
    }
    if (targetEntity.homefrontRole === "array")
      require("../../services/homefront/homefrontHooks").runtime.noteContribution(
        scene,
        entity,
        targetEntity,
        appliedAmount,
        "neutralize",
        nowMs,
      );
    return {
      success: true,
      data: {
        targetEntity,
        multiplier: warfareMultiplier,
        appliedAmount: roundNumber(appliedAmount, 6),
        aggregateChanged: refreshResult.data.aggregateChanged,
      },
    };
  }

  if (effectState.hostileFamily === HOSTILE_FAMILY_NOS) {
    const career = require("../../services/inventory/careerCombatOutcomes");
    const outcome = career.begin(entity, targetEntity, effectState, "nosferatu", nowMs);
    if (outcome?.duplicate) return { success: true, data: { targetEntity, appliedAmount: 0, duplicate: true } };
    const warfareMultiplier = resolveEnergyWarfareMultiplier(
      effectState,
      targetEntity,
      refreshResult.data.multiplier,
    );
    if (!resolveNosTransferAllowed(entity, targetEntity, effectState, callbacks)) {
      return {
        success: true,
        data: {
          targetEntity,
          multiplier: warfareMultiplier,
          appliedAmount: 0,
          aggregateChanged: refreshResult.data.aggregateChanged,
        },
      };
    }

    const targetCapCapacity = Math.max(
      0,
      toFiniteNumber(targetEntity && targetEntity.capacitorCapacity, 0),
    );
    const sourceCapCapacity = Math.max(
      0,
      toFiniteNumber(entity && entity.capacitorCapacity, 0),
    );
    const previousTargetChargeAmount = callbacks.getEntityCapacitorAmount
      ? callbacks.getEntityCapacitorAmount(targetEntity)
      : 0;
    const previousSourceChargeAmount = callbacks.getEntityCapacitorAmount
      ? callbacks.getEntityCapacitorAmount(entity)
      : 0;
    const requestedAmount = Math.max(
      0,
      toFiniteNumber(effectState.hostileStrengthValue, 0),
    ) * Math.max(warfareMultiplier, 0);
    const transferableAmount = Math.max(
      0,
      Math.min(
        requestedAmount,
        previousTargetChargeAmount,
        Math.max(0, sourceCapCapacity - previousSourceChargeAmount),
      ),
    );

    if (
      transferableAmount > 0 &&
      callbacks.setEntityCapacitorRatio
    ) {
      if (targetCapCapacity > 0) {
        callbacks.setEntityCapacitorRatio(
          targetEntity,
          (previousTargetChargeAmount - transferableAmount) / targetCapCapacity,
        );
      }
      if (sourceCapCapacity > 0) {
        callbacks.setEntityCapacitorRatio(
          entity,
          (previousSourceChargeAmount + transferableAmount) / sourceCapCapacity,
        );
      }
      const committed = career.commit(outcome, "nosferatu", transferableAmount, nowMs, [targetEntity, entity]);
      if (!committed?.success) {
        if (targetCapCapacity > 0) callbacks.setEntityCapacitorRatio(targetEntity, previousTargetChargeAmount / targetCapCapacity);
        if (sourceCapCapacity > 0) callbacks.setEntityCapacitorRatio(entity, previousSourceChargeAmount / sourceCapCapacity);
        return { ...committed, stopReason: "persistence" };
      }
      if (targetCapCapacity > 0) {
        if ((!committed.handled || !committed.sealedItemIDs?.includes(Number(targetEntity.itemID))) &&
            callbacks.persistEntityCapacitorRatio) {
          callbacks.persistEntityCapacitorRatio(targetEntity);
        }
        if (targetEntity.session && callbacks.notifyCapacitorChangeToSession) {
          callbacks.notifyCapacitorChangeToSession(
            targetEntity.session,
            targetEntity,
            nowMs,
            previousTargetChargeAmount,
          );
        }
      }
      if (sourceCapCapacity > 0) {
        if ((!committed.handled || !committed.sealedItemIDs?.includes(Number(entity.itemID))) &&
            callbacks.persistEntityCapacitorRatio) {
          callbacks.persistEntityCapacitorRatio(entity);
        }
        if (session && callbacks.notifyCapacitorChangeToSession) {
          callbacks.notifyCapacitorChangeToSession(
            session,
            entity,
            nowMs,
            previousSourceChargeAmount,
          );
        }
      }
    }

    return {
      success: true,
      data: {
        targetEntity,
        multiplier: warfareMultiplier,
        appliedAmount: roundNumber(transferableAmount, 6),
        aggregateChanged: refreshResult.data.aggregateChanged,
      },
    };
  }

  return {
    success: true,
    data: {
      targetEntity,
      multiplier: refreshResult.data.multiplier,
      aggregateChanged: refreshResult.data.aggregateChanged,
      effectApplied: refreshResult.data.effectApplied !== false,
      activationChance: refreshResult.data.activationChance,
      applicationChance: refreshResult.data.applicationChance,
      randomRoll: refreshResult.data.randomRoll,
    },
  };
}

// Net warp scramble on a ship. The derived attribute is already the whole sum:
// incoming points and scrams add to it, and a ship's own warp core strength
// subtracts (a Warp Core Stabilizer contributes -2 while it runs). Prefer it,
// and fall back to the per-target tally only when the ship has no derived value
// at all.
//
// Do not add the two together — the derived attribute already contains the
// incoming contribution, so summing them counts every point twice.
//
// Nothing further is needed for the TQ rule: a scrambler is +2 and a disruptor
// +1, so -2 clears exactly one scrambler or two disruptors, while a warp
// disruption field generator is +100 and stays far out of reach.
function getEntityWarpScrambleStatus(entity) {
  if (
    entity?.dungeonCurrentInstanceID &&
    require("../../services/homefront/homefrontHooks").runtime.isWarpBlocked(
      entity,
    )
  )
    return 1000;
  const passiveValue = getEntityPassiveAttributeValue(entity, ATTRIBUTE_WARP_SCRAMBLE_STATUS, NaN);
  const targetState = ensureTargetHostileState(entity, false);
  if (["drone", "fighter"].includes(entity && entity.kind)) {
    // Companion operational maps retain intrinsic points only. Their movement
    // refresh is deferred, so read projected points from the live aggregate.
    return roundNumber((Number.isFinite(passiveValue) ? passiveValue : 0) +
      (targetState ? targetState.warpScrambleStatus : 0), 6);
  }
  if (Number.isFinite(passiveValue)) {
    return roundNumber(passiveValue, 6);
  }
  return targetState ? roundNumber(targetState.warpScrambleStatus, 6) : 0;
}

function isEntityWarpScrambled(entity) {
  return getEntityWarpScrambleStatus(entity) > 0;
}

function isMicrowarpdriveBlocked(entity) {
  const targetState = ensureTargetHostileState(entity, false);
  return Boolean(targetState && targetState.microwarpdriveBlocked === true);
}

function isMicroJumpDriveBlocked(entity) {
  const targetState = ensureTargetHostileState(entity, false);
  return Boolean(targetState && targetState.microJumpDriveBlocked === true);
}

function isTargetLockSuppressed(entity) {
  const targetState = ensureTargetHostileState(entity, false);
  return Boolean(targetState && targetState.targetLockSuppressed === true);
}

function hasScriptedHicGateScramble(entity) {
  const targetState = ensureTargetHostileState(entity, false);
  if (!targetState) {
    return false;
  }
  for (const record of targetState.incomingEffects.values()) {
    if (
      record &&
      SCRIPTED_HIC_GATE_SCRAMBLE_EFFECT_IDS.has(toInt(record.effectID, 0)) &&
      Math.max(0, toFiniteNumber(record.rangeMultiplier, 0)) > 0
    ) {
      return true;
    }
  }
  return false;
}

module.exports = {
  measureCareerHostileDuration,
  HOSTILE_FAMILY_WEB,
  HOSTILE_FAMILY_PAINT,
  HOSTILE_FAMILY_SCRAM,
  HOSTILE_FAMILY_DISRUPT,
  HOSTILE_FAMILY_FIGHTER_TACKLE,
  HOSTILE_FAMILY_NEUT,
  HOSTILE_FAMILY_NOS,
  HOSTILE_FAMILY_SENSOR_DAMP,
  HOSTILE_FAMILY_TRACKING_DISRUPT,
  HOSTILE_FAMILY_GUIDANCE_DISRUPT,
  HOSTILE_FAMILY_TARGET_JAM,
  resolveHostileDefinition,
  resolveHostileReach,
  resolveHostileModuleActivation,
  resolveTargetResistanceMultiplier,
  refreshHostileModuleState,
  applyHostileModuleState,
  removeHostileModuleState,
  executeHostileModuleCycle,
  recomputeTargetAggregateState,
  collectModifierEntriesForTarget,
  collectWeaponModifierEntriesForTarget,
  getEntityWarpScrambleStatus,
  isEntityWarpScrambled,
  isMicrowarpdriveBlocked,
  isMicroJumpDriveBlocked,
  isTargetLockSuppressed,
  hasScriptedHicGateScramble,
};
