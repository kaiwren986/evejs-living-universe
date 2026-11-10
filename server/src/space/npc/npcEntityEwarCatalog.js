"use strict";

// NPC "entity" EWAR — driven by SDE dogma ATTRIBUTES on the rat hull, not by fitted modules
// or hull dogma effects. Classic mission rats (e.g. Blood/Sansha/Serpentis/Angel/Guristas
// frigates) carry EWAR as `entity*Chance` attributes with companion range/duration/strength
// attributes, but NO corresponding dogma *effect* — so the existing fitted-module and
// hull-effect synthesis paths (npcEquipment.getNpcHostileModules) find nothing.
//
// This catalog maps each entity-EWAR attribute family to (a) the activation-chance attribute,
// (b) the effective-range attribute, and (c) an NPC effect name the hostile/jammer runtimes
// already understand (hostileModuleRuntime.HOSTILE_EFFECT_DEFINITIONS_BY_NAME /
// jammerModuleRuntime). The synthesizer builds a hull-effect module item per present family and
// stamps the effective range + activation chance directly onto it, so the existing dogma
// runtimes resolve the actual strength off the entity's own attributes (e.g. web speedFactor
// -75, scram strength 2) at their SDE-authored magnitude.
//
// `effectName` MUST name an effect record that exists in the SDE, not just a key the dispatch
// tables happen to carry: the synthesizer hands that record to the activation lane and the lane
// reads the family's range and cycle off its `rangeAttributeID` / `durationAttributeID`. See
// npcEquipment.getNpcEntityEwarModules and doc/archive/audit-drafts/npc-ewar-enable.md.
//
// CYCLE TIME IS NOT THIS CATALOG'S BUSINESS. The engine reads a module's cycle from
// `effectRecord.durationAttributeID`, resolved against the module's own attribute map — which
// for a synthetic hull-effect module IS the rat hull's map. Every entity-EWAR effect in the SDE
// already points at the family's own duration attribute, so nothing needs to be handed over:
//
//   effect                            duration  range  falloff
//   modifyTargetSpeed2 (575)            513      514      -
//   warpScrambleForEntity (563)         505      103      -
//   entityTargetPaint (1879)            945      941     954
//   entitySensorDampen (1878)           943      938     950
//   npcEntityTrackingDisruptor (6846)  2515     2516      -
//   entityECMFalloff (6695)             929      936      -
//   entityEnergyNeutralizerFalloff      942       98      -
//
// An earlier revision resolved a `durationMs` here and stamped it onto the module item as
// `_npcEntityEwarDurationMs`, where nothing read it and nothing could: the runtime never looks
// at the module item for a cycle. It has been removed rather than wired up.
//
// Attribute IDs verified against tools/DataSync/source_json/eve-online-static-data-3396210-jsonl
// (dogmaAttributes.jsonl) and cross-checked against the golden logs (e.g. type 17061 scram 0.25 /
// web 0.35; type 24941 tracking-disruptor 0.12). No synthetic data: every value comes from the
// SDE hull attributes at runtime via getTypeAttributeMap.

// Numeric dogma attributeIDs (SDE 3396210). Only attributes this file READS belong here — a
// constant named in a catalog is not a reader, and two rounds of this audit have been spent
// chasing attributes that were named here and consumed nowhere.
const ATTR = Object.freeze({
  // web (stasis) — target-speed reduction
  modifyTargetSpeedChance: 512,
  modifyTargetSpeedRange: 514,
  // warp scramble
  entityWarpScrambleChance: 504,
  warpScrambleRange: 103,
  // energy neutralizer. Two range conventions: the entity flavour (937) that the five
  // `entityCapacitorDrainAmount` rats carry, and the module flavour (98) that the SDE's own
  // `entityEnergyNeutralizerFalloff` effect record binds and that the two `energyNeutralizerAmount`
  // rats (27792, 36941) carry. Tried in that order.
  energyNeutralizerEntityChance: 931,
  entityCapacitorDrainMaxRange: 937,
  energyNeutralizerRangeOptimal: 98,
  // tracking disruptor
  npcTrackingDisruptorActivationChance: 933,
  npcTrackingDisruptorRange: 2516,
  // sensor dampener
  entitySensorDampenChance: 932, // paired with entitySensorDampen* companions
  entitySensorDampenMaxRange: 938,
  // target painter — chance follows the "...DurationChance" convention (935), NOT 940.
  // Verified against the golden logs: type 24787 paints (effects.TargetPaint) and carries
  // entityTargetPaintDurationChance=0.15 + range/duration, but no attribute 940.
  entityTargetPaintChance: 935,
  entityTargetPaintMaxRange: 941,
  // ECM (jam)
  ecmEntityChance: 930,
  entityRemoteECMChanceOfActivation: 1664,
});

// One entry per EWAR family the entity attributes can express. `effectName` MUST be a key the
// hostile/jammer runtime already maps (see hostileModuleRuntime.js:263+, jammerModuleRuntime.js).
// `chanceAttrIDs` are tried in order (families with two chance conventions). `rangeAttrIDs` give
// the effective range used by the NPC-side approach gate.
const ENTITY_EWAR_FAMILIES = Object.freeze([
  Object.freeze({
    // `modifyTargetSpeed2` (575), NOT `remoteWebifierEntity` (6690). 6690 is the stasis
    // webifier DRONE effect — carried by exactly seven types, all of them drones (Warrior
    // SW-300, Valkyrie SW-600, Berserker SW-900 and the three -I variants) — and it binds
    // range → 54 and duration → 73, the hull's turret optimal and turret cycle. 575 is the
    // entity flavour and binds range → 514, duration → 513, discharge → 515: exactly the
    // attributes this catalog reads by hand. Naming 6690 is where family 39's "the entity
    // web runs at the rat's turret optimal and turret cycle" reading came from; it was a
    // property of the effect record the catalog chose, not of the runtime.
    family: "web",
    effectName: "modifytargetspeed2",
    chanceAttrIDs: [ATTR.modifyTargetSpeedChance],
    rangeAttrIDs: [ATTR.modifyTargetSpeedRange],
  }),
  Object.freeze({
    family: "scram",
    effectName: "warpscrambleforentity",
    chanceAttrIDs: [ATTR.entityWarpScrambleChance],
    rangeAttrIDs: [ATTR.warpScrambleRange],
  }),
  Object.freeze({
    // `entityEnergyNeutralizerFalloff` (6691), NOT `entityCapacitatorDrain`. The latter is a
    // fabricated name: the SDE has no effect record for it, so it resolves to nothing and the
    // synthesizer can build no module from it. 6691 is the SDE's own entity neutralizer and
    // binds duration -> 942 `energyNeutralizerDuration`, which all seven affected rats declare.
    // Its range binds to 98 `energyNeutralizerRangeOptimal` — the module flavour — which only
    // 27792 and 36941 declare; the five `entityCapacitorDrainAmount` carriers use 937 instead,
    // hence the two-candidate range list. `entitycapacitatordrain` stays in the hostile dispatch
    // table: it is harmless there and other suites pin it.
    family: "neut",
    effectName: "entityenergyneutralizerfalloff",
    chanceAttrIDs: [ATTR.energyNeutralizerEntityChance],
    rangeAttrIDs: [
      ATTR.entityCapacitorDrainMaxRange,
      ATTR.energyNeutralizerRangeOptimal,
    ],
  }),
  Object.freeze({
    family: "trackingDisrupt",
    effectName: "npcentitytrackingdisruptor",
    chanceAttrIDs: [ATTR.npcTrackingDisruptorActivationChance],
    rangeAttrIDs: [ATTR.npcTrackingDisruptorRange],
  }),
  Object.freeze({
    family: "sensorDamp",
    effectName: "entitysensordampen",
    chanceAttrIDs: [ATTR.entitySensorDampenChance],
    rangeAttrIDs: [ATTR.entitySensorDampenMaxRange],
  }),
  Object.freeze({
    family: "paint",
    effectName: "entitytargetpaint",
    chanceAttrIDs: [ATTR.entityTargetPaintChance],
    rangeAttrIDs: [ATTR.entityTargetPaintMaxRange],
  }),
  Object.freeze({
    family: "ecm",
    effectName: "entityecmfalloff",
    chanceAttrIDs: [ATTR.entityRemoteECMChanceOfActivation, ATTR.ecmEntityChance],
    rangeAttrIDs: [], // ECM range resolves from the entity's ecm range/falloff attributes
  }),
]);

function readAttr(attributeMap, attributeID) {
  if (!attributeMap || !attributeID) {
    return 0;
  }
  const value = Number(attributeMap[attributeID]);
  return Number.isFinite(value) ? value : 0;
}

// Returns both the value and the attribute it came from: the synthesizer needs the attribute ID
// so it can bind the family's effect record to the range attribute this hull actually declares.
function readFirstAttr(attributeMap, attributeIDs = []) {
  for (const attributeID of attributeIDs) {
    const value = readAttr(attributeMap, attributeID);
    if (value > 0) {
      return { value, attributeID };
    }
  }
  return { value: 0, attributeID: 0 };
}

// Given a rat hull's attribute map, return the list of active entity-EWAR family specs it carries
// (activation chance > 0). Each result:
// { family, effectName, activationChance, rangeMeters, rangeAttributeID }.
// `rangeMeters === 0` means "let the runtime resolve range from module attributes".
function resolveEntityEwarSpecs(attributeMap) {
  if (!attributeMap || typeof attributeMap !== "object") {
    return [];
  }
  const specs = [];
  for (const familySpec of ENTITY_EWAR_FAMILIES) {
    const chance = readFirstAttr(attributeMap, familySpec.chanceAttrIDs).value;
    if (!(chance > 0)) {
      continue;
    }
    const range = readFirstAttr(attributeMap, familySpec.rangeAttrIDs);
    specs.push({
      family: familySpec.family,
      effectName: familySpec.effectName,
      activationChance: Math.min(1, Math.max(0, chance)),
      rangeMeters: range.value,
      rangeAttributeID: range.attributeID,
    });
  }
  return specs;
}

module.exports = {
  ATTR,
  ENTITY_EWAR_FAMILIES,
  resolveEntityEwarSpecs,
};
