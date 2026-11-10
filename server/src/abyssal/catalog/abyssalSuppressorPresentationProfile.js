"use strict";

const SHORT_RANGE_SUPPRESSOR_FX_TYPE_ID = 47_437;
const SHORT_RANGE_SUPPRESSOR_FX_PROFILE_ID =
  "abyssal:environment:suppressor:short-range-fx-v1";
const SHORT_RANGE_SUPPRESSOR_FX_EFFECT_NAME = "effects.TriGlavianBS01a";
const MEDIUM_RANGE_SUPPRESSOR_FX_TYPE_ID = 47_438;
const MEDIUM_RANGE_SUPPRESSOR_FX_PROFILE_ID =
  "abyssal:environment:suppressor:medium-range-fx-v1";
const MEDIUM_RANGE_SUPPRESSOR_FX_EFFECT_NAME = "effects.TriGlavianBS01a";

const SHORT_RANGE_SUPPRESSOR_PRESENTATION_PROFILE = Object.freeze({
  profileID: SHORT_RANGE_SUPPRESSOR_FX_PROFILE_ID,
  typeID: SHORT_RANGE_SUPPRESSOR_FX_TYPE_ID,
  effectName: SHORT_RANGE_SUPPRESSOR_FX_EFFECT_NAME,
  sourceMode: "self",
  targetMode: "self",
  durationMs: 2_000,
  repeat: 1_000,
  graphicInfo: Object.freeze({
    trackTargets: false,
    hitRange: 15_000,
    candidateTypeListId: 46,
  }),
  presentationEnabled: true,
  sourceEvidence: Object.freeze([
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt:19801",
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt:19923",
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt:46525",
  ]),
});

const MEDIUM_RANGE_SUPPRESSOR_PRESENTATION_PROFILE = Object.freeze({
  profileID: MEDIUM_RANGE_SUPPRESSOR_FX_PROFILE_ID,
  typeID: MEDIUM_RANGE_SUPPRESSOR_FX_TYPE_ID,
  effectName: MEDIUM_RANGE_SUPPRESSOR_FX_EFFECT_NAME,
  sourceMode: "self",
  targetMode: "self",
  durationMs: 2_000,
  repeat: 1_000,
  graphicInfo: Object.freeze({
    trackTargets: false,
    hitRange: 40_000,
    candidateTypeListId: 46,
  }),
  presentationEnabled: true,
  sourceEvidence: Object.freeze([
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt:71707",
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt:71784",
    "CAPTURED_RETAIL:docs/tqlogs.zip:TQTranquilAbyssal5.txt:106590",
  ]),
});

const SUPPRESSOR_PRESENTATION_PROFILES_BY_TYPE_ID = new Map([
  [SHORT_RANGE_SUPPRESSOR_FX_TYPE_ID, SHORT_RANGE_SUPPRESSOR_PRESENTATION_PROFILE],
  [MEDIUM_RANGE_SUPPRESSOR_FX_TYPE_ID, MEDIUM_RANGE_SUPPRESSOR_PRESENTATION_PROFILE],
]);

function validateAbyssalSuppressorPresentationProfile(profile) {
  if (!profile || typeof profile !== "object") {
    return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_FX_PROFILE_MISSING" };
  }
  const expected = SUPPRESSOR_PRESENTATION_PROFILES_BY_TYPE_ID.get(Number(profile.typeID));
  if (!expected || profile.presentationEnabled !== true) {
    return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_FX_TYPE_UNSUPPORTED" };
  }
  if (
    String(profile.profileID || "") !== expected.profileID ||
    String(profile.effectName || "") !== expected.effectName ||
    profile.sourceMode !== "self" ||
    profile.targetMode !== "self"
  ) {
    return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_FX_IDENTITY_INVALID" };
  }
  const graphicInfo = profile.graphicInfo;
  if (
    Number(profile.durationMs) !== expected.durationMs ||
    Number(profile.repeat) !== expected.repeat ||
    !graphicInfo ||
    graphicInfo.trackTargets !== false ||
    Number(graphicInfo.hitRange) !== expected.graphicInfo.hitRange ||
    Number(graphicInfo.candidateTypeListId) !== expected.graphicInfo.candidateTypeListId
  ) {
    return { success: false, errorMsg: "ABYSSAL_SUPPRESSOR_FX_CAPTURE_FIELDS_INVALID" };
  }
  return { success: true };
}

function getAbyssalSuppressorPresentationProfileByTypeID(typeID) {
  const profile = SUPPRESSOR_PRESENTATION_PROFILES_BY_TYPE_ID.get(Number(typeID)) || null;
  return validateAbyssalSuppressorPresentationProfile(profile).success ? profile : null;
}

function buildAbyssalSuppressorStartFxOptions(
  runtimeEntityID,
  timing = {},
  typeID = SHORT_RANGE_SUPPRESSOR_FX_TYPE_ID,
) {
  const profile = getAbyssalSuppressorPresentationProfileByTypeID(
    typeID,
  );
  const numericRuntimeEntityID = Number(runtimeEntityID);
  if (!profile || !Number.isSafeInteger(numericRuntimeEntityID) || numericRuntimeEntityID <= 0) {
    return null;
  }
  return {
    shipID: numericRuntimeEntityID,
    moduleID: numericRuntimeEntityID,
    moduleTypeID: profile.typeID,
    targetID: null,
    chargeTypeID: null,
    isOffensive: false,
    start: true,
    active: true,
    duration: profile.durationMs,
    repeat: profile.repeat,
    startTime: timing.startTime,
    timeFromStart: timing.timeFromStart === undefined ? 0 : timing.timeFromStart,
    graphicInfo: {
      ...profile.graphicInfo,
    },
  };
}

module.exports = {
  SHORT_RANGE_SUPPRESSOR_FX_EFFECT_NAME,
  SHORT_RANGE_SUPPRESSOR_FX_PROFILE_ID,
  SHORT_RANGE_SUPPRESSOR_FX_TYPE_ID,
  SHORT_RANGE_SUPPRESSOR_PRESENTATION_PROFILE,
  MEDIUM_RANGE_SUPPRESSOR_FX_EFFECT_NAME,
  MEDIUM_RANGE_SUPPRESSOR_FX_PROFILE_ID,
  MEDIUM_RANGE_SUPPRESSOR_FX_TYPE_ID,
  MEDIUM_RANGE_SUPPRESSOR_PRESENTATION_PROFILE,
  buildAbyssalSuppressorStartFxOptions,
  getAbyssalSuppressorPresentationProfileByTypeID,
  validateAbyssalSuppressorPresentationProfile,
};
