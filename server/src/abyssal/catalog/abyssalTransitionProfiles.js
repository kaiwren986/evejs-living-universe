"use strict";

const { T0_DARK_VARIANT_BLUEPRINTS } = require("./t0DarkDevMenuCatalog");

const {
  cloneValue,
  deepFreeze,
} = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("./abyssalContentAuthority");
const {
  SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS,
} = require("./abyssalTraceProfiles");

const TRANSITION_POLICY_AUTHORITATIVE_CAPTURED = "authoritative-captured";
const TRANSITION_POLICY_EXPERIMENTAL = "experimental";
const EVIDENCE_STATUS_CAPTURED_RETAIL = "captured-retail";
const T0_DARK_LAYOUT_SET_ID = "abyssal:t0:dark:run:retail-capture-001";
const T0_DARK_TRANSITION_PROFILE_SET_ID = "abyssal:t0:dark:transition-set:v1";
const T0_DARK_COMPATIBLE_LAYOUT_SET_IDS = new Set([
  T0_DARK_LAYOUT_SET_ID,
  ...T0_DARK_VARIANT_BLUEPRINTS.map(
    (variant) => `abyssal:t0:dark:run:${variant.variantID}-v1`,
  ),
]);

const T0_DARK_TRANSITION_PROFILES = deepFreeze({
  profileSetID: T0_DARK_TRANSITION_PROFILE_SET_ID,
  contentAuthority: ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
  layoutSetID: T0_DARK_LAYOUT_SET_ID,
  transitionPolicy: TRANSITION_POLICY_AUTHORITATIVE_CAPTURED,
  evidenceStatus: EVIDENCE_STATUS_CAPTURED_RETAIL,
  evidence: {
    sourceFile: "TQTranquilAbyssal5.txt",
    sourceSegment: "2026-07-15T23:20:22--2026-07-15T23:28:56",
    timestampResolutionMs: 1_000,
  },
  profiles: {
    entry: {
      transitionProfileID: "abyssal:t0:dark:transition:entry-v1",
      transitionType: "entry",
      evidenceStatus: EVIDENCE_STATUS_CAPTURED_RETAIL,
      durationMs: SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS,
      phases: [
        "validated",
        "departure-started",
        "departure-presenting",
        "ship-repositioned",
        "destination-delivered",
        "arrival-presenting",
        "destination-active",
        "complete",
      ],
      departureSpecialFx: [{
        effectKey: "jump_out_abyssal",
        effectName: "effects.JumpOutAbyssal",
        includeStopInSameUpdate: true,
        graphicInfo: ["destination-system-id", "destination-nebula-graphic-id"],
      }],
      arrivalSpecialFx: [{
        effectKey: "abyssal_reentry_splash",
        effectName: "effects.AbyssalReentrySplash",
      }],
      notifications: [
        { name: "SessionChange", phase: "ship-repositioned" },
        { name: "OnEnteringDungeonRoom", phase: "destination-delivered" },
        { name: "OnAbyssalLocationEntered", phase: "destination-delivered" },
      ],
      sceneChangePhase: "departure-presenting",
      destinationDeliveryPhase: "destination-delivered",
      npcActivationPhase: "destination-active",
    },
    "room-transfer": {
      transitionProfileID: "abyssal:t0:dark:transition:room-transfer-v1",
      transitionType: "room-transfer",
      evidenceStatus: EVIDENCE_STATUS_CAPTURED_RETAIL,
      durationMs: 7_000,
      phases: [
        "validated",
        "source-quiesced",
        "departure-presentation-sent",
        "departure-window",
        "room-notifications-sent",
        "source-removal-committed",
        "destination-position-committed",
        "destination-delivery-committed",
        "destination-presentation-delivered",
        "destination-controllers-activated",
        "complete",
      ],
      departureSpecialFx: [{
        effectKey: "jump_out_abyssal_between",
        effectName: "effects.JumpOutAbyssalBetween",
        includeStopInSameUpdate: true,
        targetRole: "source-transfer-conduit",
        chargeRole: "destination-transfer-conduit",
      }],
      arrivalSpecialFx: [],
      notifications: [
        { name: "OnEnteringDungeonRoom", phase: "room-notifications-sent" },
        { name: "OnExitingDungeon", phase: "room-notifications-sent" },
        { name: "RemoveBalls+AddBalls2", phase: "destination-presentation-delivered" },
        { name: "SetBallPosition", phase: "destination-presentation-delivered" },
        { name: "OnAbyssalLocationEntered", phase: "destination-presentation-delivered" },
        { name: "OnAbyssalLocationExited", phase: "destination-presentation-delivered" },
      ],
      sceneChangePhase: "departure-window",
      destinationDeliveryPhase: "destination-presentation-delivered",
      npcActivationPhase: "destination-controllers-activated",
    },
    "final-exit": {
      transitionProfileID: "abyssal:t0:dark:transition:final-exit-v1",
      transitionType: "final-exit",
      evidenceStatus: EVIDENCE_STATUS_CAPTURED_RETAIL,
      durationMs: 4_500,
      phases: [
        "validated",
        "mechanics-paused",
        "departure-started",
        "departure-presenting",
        "session-change",
        "kspace-bootstrap",
        "arrival-presenting",
        "run-cleanup",
        "complete",
      ],
      departureSpecialFx: [{
        effectKey: "jump_out_abyssal",
        effectName: "effects.JumpOutAbyssal",
        includeStopInSameUpdate: true,
        graphicInfo: ["destination-system-id", null],
      }],
      arrivalSpecialFx: [{
        effectKey: "abyssal_reentry_splash",
        effectName: "effects.AbyssalReentrySplash",
      }],
      notifications: [
        { name: "OnExitingDungeon", phase: "departure-presenting" },
        { name: "OnAbyssalLocationExited", phase: "departure-presenting" },
        { name: "SessionChange", phase: "session-change" },
      ],
      sceneChangePhase: "departure-presenting",
      destinationDeliveryPhase: "kspace-bootstrap",
      npcActivationPhase: "not-applicable",
    },
  },
});

function getT0DarkTransitionProfileSet() {
  return cloneValue(T0_DARK_TRANSITION_PROFILES);
}

function resolveTransitionProfileSetForLayout(layoutSetID) {
  const normalizedLayoutSetID = String(layoutSetID || "").trim();
  if (!T0_DARK_COMPATIBLE_LAYOUT_SET_IDS.has(normalizedLayoutSetID)) return null;
  const profileSet = getT0DarkTransitionProfileSet();
  profileSet.layoutSetID = normalizedLayoutSetID;
  profileSet.sourceLayoutSetID = T0_DARK_LAYOUT_SET_ID;
  return profileSet;
}

function resolveTransitionProfile(profileSet, transitionType) {
  const normalizedType = String(transitionType || "").trim().toLowerCase();
  const profile = profileSet && profileSet.profiles && profileSet.profiles[normalizedType];
  return profile ? cloneValue(profile) : null;
}

function validateTransitionProfileSet(profileSet) {
  const errors = [];
  if (!profileSet || profileSet.transitionPolicy !== TRANSITION_POLICY_AUTHORITATIVE_CAPTURED) {
    errors.push("authoritative captured transition policy is missing");
  }
  for (const transitionType of ["entry", "room-transfer", "final-exit"]) {
    const profile = resolveTransitionProfile(profileSet, transitionType);
    if (!profile) {
      errors.push(`missing ${transitionType} transition profile`);
      continue;
    }
    if (profile.evidenceStatus !== EVIDENCE_STATUS_CAPTURED_RETAIL) {
      errors.push(`${transitionType} transition is not captured-retail`);
    }
    if (!(Number(profile.durationMs) > 0)) {
      errors.push(`${transitionType} transition duration is invalid`);
    }
    if (!Array.isArray(profile.phases) || profile.phases.at(-1) !== "complete") {
      errors.push(`${transitionType} transition phases are incomplete`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  EVIDENCE_STATUS_CAPTURED_RETAIL,
  T0_DARK_LAYOUT_SET_ID,
  T0_DARK_TRANSITION_PROFILE_SET_ID,
  T0_DARK_COMPATIBLE_LAYOUT_SET_IDS,
  T0_DARK_TRANSITION_PROFILES,
  TRANSITION_POLICY_AUTHORITATIVE_CAPTURED,
  TRANSITION_POLICY_EXPERIMENTAL,
  getT0DarkTransitionProfileSet,
  resolveTransitionProfile,
  resolveTransitionProfileSetForLayout,
  validateTransitionProfileSet,
};
