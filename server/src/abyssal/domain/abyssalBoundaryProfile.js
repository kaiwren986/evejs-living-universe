"use strict";

const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("../catalog/abyssalContentAuthority");

const ABYSSAL_BOUNDARY_PROFILE_ID =
  "abyssal:environment:unstable-depths:boundary-damage-v1";

const ABYSSAL_BOUNDARY_EVIDENCE = Object.freeze({
  sourceName: "retail-captured",
  tickIntervalMs: "retail-captured",
  perimeterRadius: "official-ccp-150km-diameter",
  distanceCurve: "derived-retail-capture",
  interceptAppliedDamage: "derived-retail-capture",
  slopeAppliedDamagePerKilometre: "derived-retail-capture",
  variance: "retail-observed-provisional-model",
  rawDamageType: "unknown",
  terminalExposure: "golden-engine-15-second-continuous-exposure",
  // The profile carries lethalDistanceMeters: null. Retail shows no fixed lethal
  // distance - destruction is driven by continuous exposure time, not depth - so
  // this stays untagged-by-value and explicitly tagged here as not implemented.
  // Every profile field gets an evidence entry; silent absence is not a tag.
  lethalDistanceMeters: "unknown-not-implemented",
});

const UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE = Object.freeze({
  profileID: ABYSSAL_BOUNDARY_PROFILE_ID,
  contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
  authorityFacets: Object.freeze({
    t0TranquilPolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:t0-tranquil-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      perimeterRadiusMeters: 75_000,
      tickIntervalMs: 1_000,
      evidenceRefs: Object.freeze([
        "server/src/space/abyssal/abyssalBoundaryProfile.js",
        "server/tests/runtime.abyssalBoundary.test.js",
        "server/tests/abyssalBoundaryMechanicsController.test.js",
      ]),
    }),
    tier1CalmPolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:tier1-calm-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      perimeterRadiusMeters: 75_000,
      tickIntervalMs: 1_000,
      evidenceRefs: Object.freeze([
        "server/src/space/abyssal/abyssalBoundaryProfile.js",
        "server/tests/runtime.abyssalBoundary.test.js",
        "server/tests/abyssalBoundaryMechanicsController.test.js",
      ]),
    }),
    tier2AgitatedPolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:tier2-agitated-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      perimeterRadiusMeters: 75_000,
      tickIntervalMs: 1_000,
      evidenceRefs: Object.freeze([
        "server/src/space/abyssal/abyssalBoundaryProfile.js",
        "server/tests/runtime.abyssalBoundary.test.js",
        "server/tests/abyssalBoundaryMechanicsController.test.js",
      ]),
    }),
    tier3FiercePolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:tier3-fierce-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      perimeterRadiusMeters: 75_000,
      tickIntervalMs: 1_000,
      evidenceRefs: Object.freeze([
        "server/src/space/abyssal/abyssalBoundaryProfile.js",
        "server/tests/runtime.abyssalBoundary.test.js",
        "server/tests/abyssalBoundaryMechanicsController.test.js",
      ]),
    }),
    tier4RagingPolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:tier4-raging-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      perimeterRadiusMeters: 75_000,
      tickIntervalMs: 1_000,
      evidenceRefs: Object.freeze([
        "server/src/space/abyssal/abyssalBoundaryProfile.js",
        "server/tests/runtime.abyssalBoundary.test.js",
        "server/tests/abyssalBoundaryMechanicsController.test.js",
      ]),
    }),
    tier5ChaoticPolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:tier5-chaotic-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      perimeterRadiusMeters: 75_000,
      tickIntervalMs: 1_000,
      evidenceRefs: Object.freeze([
        "server/src/space/abyssal/abyssalBoundaryProfile.js",
        "server/tests/runtime.abyssalBoundary.test.js",
        "server/tests/abyssalBoundaryMechanicsController.test.js",
      ]),
    }),
    tier6CataclysmicPolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:tier6-cataclysmic-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      perimeterRadiusMeters: 75_000,
      tickIntervalMs: 1_000,
      evidenceRefs: Object.freeze([
        "server/src/space/abyssal/abyssalBoundaryProfile.js",
        "server/tests/runtime.abyssalBoundary.test.js",
        "server/tests/abyssalBoundaryMechanicsController.test.js",
      ]),
    }),
    t0DarkPolicy: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:t0-dark-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
      evidenceRefs: Object.freeze([
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt",
        "doc/abyssal/t0-dark-retail-layout-audit.md",
      ]),
    }),
    damageModel: Object.freeze({
      profileID: `${ABYSSAL_BOUNDARY_PROFILE_ID}:damage-model`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
      evidenceRefs: Object.freeze([
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt",
        "server/tests/abyssalBoundaryProfile.test.js",
      ]),
    }),
  }),
  sourceName: "Unstable Abyssal Depths",
  perimeterRadiusMeters: 75_000,
  perimeterFallbackRadiusMeters: 75_000,
  tickIntervalMs: 1_000,
  interceptAppliedDamage: 10.55,
  slopeAppliedDamagePerKilometre: 10.24,
  varianceModel: "bounded-uniform-multiplier",
  // The capture proves variance but not its distribution or amplitude. Ten
  // percent is a conservative, replaceable provisional bound.
  varianceFraction: 0.10,
  terminalExposureMs: 15_000,
  terminalAppliedDamage: Number.MAX_SAFE_INTEGER,
  lethalDistanceMeters: null,
  evidence: ABYSSAL_BOUNDARY_EVIDENCE,
  notes: Object.freeze([
    "The source label and one-second cadence are retail-captured.",
    "The 75 km radius follows CCP's documented 150 km-diameter border zone.",
    "Captured Perimeter lights radius fields are presentation parameters, not damage-radius authority.",
    "The linear applied-damage curve is derived from one retail capture and is not retail-exact.",
    "Damage is already-resolved post-mitigation damage because the raw damage vector is unknown.",
    "Variance is observed in retail but the bounded uniform amplitude is provisional.",
    "There is no fixed lethal distance; the golden engine proves terminal destruction after 15 seconds of continuous exposure.",
  ]),
});

function calculateBoundaryBaseAppliedDamage(
  depthOutsideMeters,
  profile = UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
) {
  const depthKilometres = Math.max(0, Number(depthOutsideMeters) || 0) / 1_000;
  return (
    Number(profile.interceptAppliedDamage) +
    Number(profile.slopeAppliedDamagePerKilometre) * depthKilometres
  );
}

function resolveBoundaryVarianceMultiplier(
  profile = UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
  nextRandom = null,
) {
  const varianceFraction = Math.max(0, Number(profile.varianceFraction) || 0);
  if (
    varianceFraction <= 0 ||
    profile.varianceModel === "disabled" ||
    typeof nextRandom !== "function"
  ) {
    return 1;
  }
  const sampled = Math.min(1, Math.max(0, Number(nextRandom()) || 0));
  return 1 + ((sampled * 2) - 1) * varianceFraction;
}

module.exports = {
  ABYSSAL_BOUNDARY_PROFILE_ID,
  ABYSSAL_BOUNDARY_EVIDENCE,
  UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
  calculateBoundaryBaseAppliedDamage,
  resolveBoundaryVarianceMultiplier,
};
