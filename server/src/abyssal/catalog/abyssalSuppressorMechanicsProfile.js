"use strict";

const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("./abyssalContentAuthority");

const SHORT_RANGE_SUPPRESSOR_TYPE_ID = 47_437;
const MEDIUM_RANGE_SUPPRESSOR_TYPE_ID = 47_438;
const SHORT_RANGE_SUPPRESSOR_DOGMA_EFFECT_ID = 7_057;
const SHORT_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID = 46;
const MEDIUM_RANGE_SUPPRESSOR_DOGMA_EFFECT_ID = 7_057;
const MEDIUM_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID = 46;

const RESOLVED_TARGET_TYPE_LIST = Object.freeze({
  includedCategoryIDs: Object.freeze([8, 18, 87]),
  includedGroupIDs: Object.freeze([1_997]),
  includedTypeIDs: Object.freeze([]),
  excludedCategoryIDs: Object.freeze([]),
  excludedGroupIDs: Object.freeze([]),
  excludedTypeIDs: Object.freeze([48_262, 48_263, 48_264, 48_265]),
});

const SUPPRESSOR_TARGET_POLICY = Object.freeze({
  playerCombatDrones: true,
  playerMiningDrones: true,
  logisticsDrones: true,
  fighters: true,
  fighterSupportCraft: true,
  bombs: true,
  playerMissiles: true,
  npcMissiles: true,
  defenderMissiles: true,
  probes: true,
  deployables: false,
  abyssalDroneEntities: true,
  excludedAbyssalDroneTypeIDs: RESOLVED_TARGET_TYPE_LIST.excludedTypeIDs,
  allRogueDroneNpcs: false,
  triglavianNpcs: false,
  ordinaryPlayerShips: false,
  participantShip: false,
  requiresTargetLock: false,
  requiresHostility: false,
  targetLimit: null,
  selection: "all-eligible-in-range",
  serverIterationOrder: "distance-ascending-then-runtime-id",
  rangeBoundary: "inclusive",
});

const RESOLVED_TARGET_CLASSES = Object.freeze([
  "deployed-charge-entities",
  "drones",
  "fighters",
  "abyssal-drone-entities-except-48262-through-48265",
]);

const SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE = Object.freeze({
  profileID: "abyssal:environment:suppressor:short-range-v1",
  contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
  typeID: SHORT_RANGE_SUPPRESSOR_TYPE_ID,
  name: "Short-Range Deviant Automata Suppressor",
  role: "deviant-automata-suppressor",
  presentationRadiusMeters: 7_500,
  mechanicsRangeMeters: 15_000,
  activationDurationMs: 2_000,
  damage: Object.freeze({
    em: 0,
    explosive: 30,
    kinetic: 0,
    thermal: 30,
  }),
  dogmaEffectID: SHORT_RANGE_SUPPRESSOR_DOGMA_EFFECT_ID,
  targetTypeListID: SHORT_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID,
  targetPolicy: SUPPRESSOR_TARGET_POLICY,
  resolvedTargetTypeList: RESOLVED_TARGET_TYPE_LIST,
  resolvedTargetClasses: RESOLVED_TARGET_CLASSES,
  mechanicsEnabled: true,
  sourceEvidence: Object.freeze([
    "LOCAL_STATIC_DATA:typeDogma:47437",
    "LOCAL_STATIC_DATA:dogmaEffect:7057",
    "LOCAL_STATIC_DATA:clientTypeLists:46",
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt",
    "PUBLIC_STATIC_DATA:https://ref-data.everef.net/types/47437",
    "EXTERNAL_IMPLEMENTATION:docs/AbyssalEngine.zip:abyssal/engine/fields.js",
  ]),
});

const MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE = Object.freeze({
  profileID: "abyssal:environment:suppressor:medium-range-v1",
  contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
  typeID: MEDIUM_RANGE_SUPPRESSOR_TYPE_ID,
  name: "Medium-Range Deviant Automata Suppressor",
  role: "deviant-automata-suppressor",
  presentationRadiusMeters: 7_500,
  mechanicsRangeMeters: 40_000,
  activationDurationMs: 2_000,
  damage: Object.freeze({
    em: 0,
    explosive: 10,
    kinetic: 0,
    thermal: 10,
  }),
  dogmaEffectID: MEDIUM_RANGE_SUPPRESSOR_DOGMA_EFFECT_ID,
  targetTypeListID: MEDIUM_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID,
  targetPolicy: SUPPRESSOR_TARGET_POLICY,
  resolvedTargetTypeList: RESOLVED_TARGET_TYPE_LIST,
  resolvedTargetClasses: RESOLVED_TARGET_CLASSES,
  mechanicsEnabled: true,
  sourceEvidence: Object.freeze([
    "LOCAL_STATIC_DATA:typeDogma:47438",
    "LOCAL_STATIC_DATA:dogmaEffect:7057",
    "LOCAL_STATIC_DATA:clientTypeLists:46",
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt:71707",
    "EXTERNAL_IMPLEMENTATION:docs/AbyssalEngine.zip:abyssal/engine/fields.js",
  ]),
});

const SUPPRESSOR_MECHANICS_PROFILES_BY_TYPE_ID = new Map([
  [SHORT_RANGE_SUPPRESSOR_TYPE_ID, SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE],
  [MEDIUM_RANGE_SUPPRESSOR_TYPE_ID, MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE],
]);

function sortedValues(set) {
  return [...(set instanceof Set ? set : [])].sort((left, right) => left - right);
}

function validateResolvedTargetTypeList(liveTypeList) {
  if (!liveTypeList) {
    return {
      success: false,
      errorMsg: "ABYSSAL_SUPPRESSOR_TARGET_TYPE_LIST_UNAVAILABLE",
    };
  }
  for (const field of [
    "includedCategoryIDs",
    "includedGroupIDs",
    "includedTypeIDs",
    "excludedCategoryIDs",
    "excludedGroupIDs",
    "excludedTypeIDs",
  ]) {
    const expected = RESOLVED_TARGET_TYPE_LIST[field];
    const actual = sortedValues(liveTypeList[field]);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return {
        success: false,
        errorMsg: "ABYSSAL_SUPPRESSOR_TARGET_TYPE_LIST_MISMATCH",
        field,
        expected: [...expected],
        actual,
      };
    }
  }
  return {
    success: true,
    typeListID: SHORT_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID,
  };
}

function getAbyssalSuppressorMechanicsProfileByTypeID(typeID) {
  return SUPPRESSOR_MECHANICS_PROFILES_BY_TYPE_ID.get(Number(typeID)) || null;
}

module.exports = {
  SHORT_RANGE_SUPPRESSOR_TYPE_ID,
  MEDIUM_RANGE_SUPPRESSOR_TYPE_ID,
  SHORT_RANGE_SUPPRESSOR_DOGMA_EFFECT_ID,
  SHORT_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID,
  MEDIUM_RANGE_SUPPRESSOR_DOGMA_EFFECT_ID,
  MEDIUM_RANGE_SUPPRESSOR_TARGET_TYPE_LIST_ID,
  RESOLVED_TARGET_TYPE_LIST,
  SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE,
  MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE,
  getAbyssalSuppressorMechanicsProfileByTypeID,
  validateResolvedTargetTypeList,
};
