"use strict";

const {
  deepFreeze,
  normalizeText,
} = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("./abyssalContentAuthority");
const {
  resolveAbyssalTraceGameModeID,
} = require("../domain/abyssalGatePresentation");
const {
  MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
} = require("../domain/abyssalGateActivationPolicy");

const SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID =
  "abyssal:entrance-trace-retail-v1";
const SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS = 5_000;
const T0_DARK_TRACE_PROFILE_ID = "abyssal:trace:t0-dark:retail-captured-v1";
const T0_DARK_FILAMENT_TYPE_ID = 56132;
const T0_TRANQUIL_FILAMENT_TYPE_IDS = Object.freeze([
  56131,
  T0_DARK_FILAMENT_TYPE_ID,
  56133,
  56134,
  56136,
]);

const ABYSSAL_TRACE_LIFECYCLE_PHASE = Object.freeze({
  CREATED: "created",
  ACTIVE: "active",
  RETURNED: "returned",
  REMOVED: "removed",
});

const SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE = deepFreeze({
  traceProfileID: SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID,
  contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
  // This shared contract generalizes the captured Tranquil presentation and
  // lifecycle to supported EveJS filaments; it is not evidence that every tier
  // has been independently retail-captured.
  authorityFacets: {
    t0TranquilBaselineContract: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:t0-tranquil-baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      scope: Object.freeze([
        "durable_trace_lifecycle",
        "filament_identity_publication",
        "entry_transition",
        "return_and_cleanup",
      ]),
      evidenceRefs: [
        "server/src/space/abyssal/abyssalTraceProfiles.js",
        "server/tests/keeperService.abyssalTrace.test.js",
        "server/tests/runtime.abyssalTrace.test.js",
      ],
    },
    tier1CalmBaselineContract: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:tier1-calm-baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      scope: Object.freeze([
        "durable_trace_lifecycle",
        "filament_identity_publication",
        "entry_transition",
        "return_and_cleanup",
      ]),
      evidenceRefs: [
        "server/src/space/abyssal/abyssalTraceProfiles.js",
        "server/tests/keeperService.abyssalTrace.test.js",
        "server/tests/runtime.abyssalTrace.test.js",
      ],
    },
    tier2AgitatedBaselineContract: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:tier2-agitated-baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      scope: Object.freeze([
        "durable_trace_lifecycle",
        "filament_identity_publication",
        "entry_transition",
        "return_and_cleanup",
      ]),
      evidenceRefs: [
        "server/src/space/abyssal/abyssalTraceProfiles.js",
        "server/tests/keeperService.abyssalTrace.test.js",
        "server/tests/runtime.abyssalTrace.test.js",
      ],
    },
    tier3FierceBaselineContract: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:tier3-fierce-baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      scope: Object.freeze([
        "durable_trace_lifecycle",
        "filament_identity_publication",
        "entry_transition",
        "return_and_cleanup",
      ]),
      evidenceRefs: [
        "server/src/space/abyssal/abyssalTraceProfiles.js",
        "server/tests/keeperService.abyssalTrace.test.js",
        "server/tests/runtime.abyssalTrace.test.js",
      ],
    },
    tier4RagingBaselineContract: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:tier4-raging-baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      scope: Object.freeze([
        "durable_trace_lifecycle",
        "filament_identity_publication",
        "entry_transition",
        "return_and_cleanup",
      ]),
      evidenceRefs: [
        "server/src/space/abyssal/abyssalTraceProfiles.js",
        "server/tests/keeperService.abyssalTrace.test.js",
        "server/tests/runtime.abyssalTrace.test.js",
      ],
    },
    tier5ChaoticBaselineContract: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:tier5-chaotic-baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      scope: Object.freeze([
        "durable_trace_lifecycle",
        "filament_identity_publication",
        "entry_transition",
        "return_and_cleanup",
      ]),
      evidenceRefs: [
        "server/src/space/abyssal/abyssalTraceProfiles.js",
        "server/tests/keeperService.abyssalTrace.test.js",
        "server/tests/runtime.abyssalTrace.test.js",
      ],
    },
    tier6CataclysmicBaselineContract: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:tier6-cataclysmic-baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      scope: Object.freeze([
        "durable_trace_lifecycle",
        "filament_identity_publication",
        "entry_transition",
        "return_and_cleanup",
      ]),
      evidenceRefs: [
        "server/src/space/abyssal/abyssalTraceProfiles.js",
        "server/tests/keeperService.abyssalTrace.test.js",
        "server/tests/runtime.abyssalTrace.test.js",
      ],
    },
    t0DarkBaselineContract: {
      profileID: `${T0_DARK_TRACE_PROFILE_ID}:baseline-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      evidenceRefs: [
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt",
        "doc/abyssal/t0-dark-trace-lifecycle-audit.md",
      ],
    },
    t0DarkObservedContract: {
      profileID: `${T0_DARK_TRACE_PROFILE_ID}:observed-contract`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
      scope: Object.freeze([
        "created_identity_and_slim_state",
        "active_identity_and_transition_presentation",
        "returned_identity_and_closed_presentation",
        "non_interactive_trace_publication",
      ]),
      excludedPolicyFacets: Object.freeze([
        "server_activation_range",
        "returned_activation_rejection",
        "post_return_lifetime",
      ]),
      evidenceRefs: [
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt",
        "doc/abyssal/t0-dark-trace-lifecycle-audit.md#captured-lifecycle",
      ],
    },
    t0DarkIdentityPresentation: {
      profileID: `${T0_DARK_TRACE_PROFILE_ID}:identity-presentation`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
      evidenceRefs: [
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt",
        "doc/abyssal/t0-dark-trace-lifecycle-audit.md",
      ],
    },
    interactionPolicy: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:interaction-policy`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      capturedNonInteractivePublication: true,
      serverActivationRangeMeters:
        MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
      returnedActivationRejectionCaptured: false,
      evidenceRefs: [
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt:no-SetBallInteractive-or-component_activate",
        "doc/abyssal/t0-dark-trace-lifecycle-audit.md#visibility-interaction-and-expiry",
      ],
    },
    postReturnLifetime: {
      profileID: `${SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID}:post-return-lifetime`,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
      evidenceRefs: [
        "docs/tqlogs.zip:TQTranquilAbyssal5.txt:capture-ended-before-removal",
        "doc/abyssal/t0-dark-trace-lifecycle-audit.md#visibility-interaction-and-expiry",
      ],
    },
  },
  typeID: 48964,
  groupID: 1991,
  categoryID: 2,
  ownerID: 1,
  radiusMeters: 500,
  gameModeID: 1,
  initialState: {
    lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED,
    controllerActivationStateDefault: 0,
    slimFields: {
      activationState: 0,
    },
    omittedSlimFields: [
      "gameModeID",
      "abyssFilamentTypeID",
      "activityState",
      "isAbyssGateOpen",
      "component_activate",
    ],
    ballInteractive: false,
  },
  manualEntryAvailableState: {
    lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    slimFields: {
      activationState: 1,
      isAbyssGateOpen: true,
    },
    ballInteractive: false,
  },
  activatingState: {
    lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE,
    slimFields: {
      gameModeID: 1,
      abyssFilamentTypeID: T0_DARK_FILAMENT_TYPE_ID,
      activationState: 1,
      isAbyssGateOpen: true,
    },
    controllerEvent: "Activated",
    controllerEventArgument: 1,
    departureEffect: "effects.JumpOutAbyssal",
    ballInteractive: false,
  },
  returnedState: {
    lifecyclePhase: ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED,
    slimFields: {
      gameModeID: 1,
      abyssFilamentTypeID: T0_DARK_FILAMENT_TYPE_ID,
      activationState: 2,
      isAbyssGateOpen: false,
    },
    controllerEvent: null,
    ballInteractive: false,
  },
  spawnOffsetPolicy: {
    kind: "captured-fixed-source-vector",
    vectorMeters: {
      x: -96.8582763671875,
      y: -166.0657196044922,
      z: 141.95849609375,
    },
    capturedCenterDistanceMeters: 238.980257640207,
    orientationAuthority: "single-capture-only",
  },
  returnOffsetPolicy: {
    kind: "captured-direction-with-surface-clearance",
    unitVector: {
      x: -0.801265782397662,
      y: 0.215535072076203,
      z: 0.558137166052608,
    },
    surfaceDistanceMeters: 5000,
    capturedCenterDistanceMeters: 5701.99998536107,
  },
  interaction: {
    serverActivationRangeMeters:
      MAX_GATE_ACTIVATION_SURFACE_DISTANCE_METERS,
    componentActivateEmitted: false,
    setBallInteractiveEmitted: false,
  },
  transitionPresentation: {
    presentationID: "retail-abyssal-entry",
    supportsActivationSlimUpdate: true,
    supportsControllerActivation: true,
    supportsDepartureEffect: true,
    departureEffectKey: "jump_out_abyssal",
    departureEffectGuid: "effects.JumpOutAbyssal",
    transitionDelayMs: SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS,
    authority: "TQTranquilAbyssal5.txt captured entry transition",
  },
  automaticActivation: {
    enabled: true,
    delayMs: 1000,
    authority: "single-capture-approximately-one-second-after-initial-publication",
  },
  postReturnLifetime: {
    defaultMs: 60000,
    minimumMs: 15001,
    maximumMs: 20 * 60 * 1000,
    authority: "provisional-capture-ended-before-removal",
  },
  evidenceStatus: "captured-t0-retail-generalized",
  evidenceSource: "docs/tqlogs.zip:TQTranquilAbyssal1-5.txt",
  implementationStatus: "shared-retail-compatible-not-retail-exact",
});

function toInt(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
}

function resolveAbyssalTraceProfile(source = null) {
  const state = source && typeof source === "object" ? source : {};
  const contentProfile = state.contentProfile && typeof state.contentProfile === "object"
    ? state.contentProfile
    : {};
  const requestedProfileID = normalizeText(
    state.traceProfileID || contentProfile.traceProfileID,
  );
  const filamentTypeID = toInt(
    state.filamentTypeID,
    toInt(contentProfile.filamentTypeID, 0),
  );
  if (
    requestedProfileID === SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID ||
    requestedProfileID === T0_DARK_TRACE_PROFILE_ID ||
    (
      !requestedProfileID &&
      T0_TRANQUIL_FILAMENT_TYPE_IDS.includes(filamentTypeID)
    )
  ) {
    return SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE;
  }
  return null;
}

function resolveAbyssalTraceTransitionPresentation(source = null) {
  const profile = resolveAbyssalTraceProfile(source);
  const presentation =
    profile &&
    profile.transitionPresentation &&
    typeof profile.transitionPresentation === "object"
      ? profile.transitionPresentation
      : null;
  return presentation &&
    normalizeText(presentation.presentationID) === "retail-abyssal-entry"
    ? presentation
    : null;
}

function normalizeAbyssalTraceLifecyclePhase(value, fallback = ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED) {
  const normalized = normalizeText(value).toLowerCase();
  return Object.values(ABYSSAL_TRACE_LIFECYCLE_PHASE).includes(normalized)
    ? normalized
    : fallback;
}

function getAbyssalTracePhaseDefinition(profile, phase) {
  if (!profile) {
    return null;
  }
  const normalizedPhase = normalizeAbyssalTraceLifecyclePhase(phase);
  if (normalizedPhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE) {
    return profile.activatingState;
  }
  if (normalizedPhase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED) {
    return profile.returnedState;
  }
  return profile.initialState;
}

function buildAbyssalTraceSlimState(source = null) {
  const profile = resolveAbyssalTraceProfile(source);
  if (!profile) {
    return null;
  }
  const phase = normalizeAbyssalTraceLifecyclePhase(source && source.lifecyclePhase);
  const definition = getAbyssalTracePhaseDefinition(profile, phase);
  const state = source && typeof source === "object" ? source : {};
  const contentProfile = state.contentProfile && typeof state.contentProfile === "object"
    ? state.contentProfile
    : {};
  const filamentTypeID = toInt(
    state.filamentTypeID,
    toInt(contentProfile.filamentTypeID, 0),
  );
  const manualEntryAvailable = Boolean(
    phase === ABYSSAL_TRACE_LIFECYCLE_PHASE.CREATED &&
    state.activateForFleet === true
  );
  const slimFields = {
    ...(definition && definition.slimFields || {}),
    ...(manualEntryAvailable && profile.manualEntryAvailableState &&
      profile.manualEntryAvailableState.slimFields || {}),
  };
  if (state.activateForFleet === true) {
    slimFields.gameModeID = resolveAbyssalTraceGameModeID(state);
  }
  if (
    (
      phase === ABYSSAL_TRACE_LIFECYCLE_PHASE.ACTIVE ||
      phase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED ||
      manualEntryAvailable
    ) &&
    filamentTypeID > 0
  ) {
    slimFields.abyssFilamentTypeID = filamentTypeID;
  }
  return {
    profile,
    phase,
    definition,
    slimFields,
  };
}

function clearCapturedTraceSlimFields(entity) {
  for (const fieldName of [
    "gameModeID",
    "abyssFilamentTypeID",
    "activationState",
    "activityState",
    "isAbyssGateOpen",
    "poseID",
    "component_activate",
    "activate_comp_durationSeconds",
    "gateActivationRange",
    "dunObjectID",
    "dunObjectNameID",
    "dunPosition",
    "dunRotation",
    "dungeonObjectID",
  ]) {
    delete entity[fieldName];
  }
}

function applyAbyssalTraceProfileToEntity(entity, source = null) {
  const state = buildAbyssalTraceSlimState(source);
  if (!entity || !state) {
    return entity;
  }
  const { profile, phase, definition, slimFields } = state;
  clearCapturedTraceSlimFields(entity);
  entity.typeID = profile.typeID;
  entity.slimTypeID = profile.typeID;
  entity.slimGroupID = profile.groupID;
  entity.slimCategoryID = profile.categoryID;
  entity.ownerID = profile.ownerID;
  entity.slimName = "";
  entity.suppressSlimGraphicID = true;
  entity.ballInteractive = definition.ballInteractive === true;
  entity.suppressBallInteractiveUpdate = true;
  entity.dungeonMaterializedGate = false;
  entity.evejsAbyssalTraceProfileID = profile.traceProfileID;
  entity.evejsAbyssalTraceLifecyclePhase = phase;
  entity.dungeonGateState = slimFields.isAbyssGateOpen === true ? "open" : "locked";
  if (
    phase === ABYSSAL_TRACE_LIFECYCLE_PHASE.RETURNED &&
    toInt(source && source.removalDeadlineMs, 0) > 0
  ) {
    entity.expiresAtMs = toInt(source.removalDeadlineMs, 0);
  }
  Object.assign(entity, slimFields);
  return entity;
}

function resolveAbyssalTracePostReturnLifetimeMs(profile) {
  const policy = profile && profile.postReturnLifetime;
  if (!policy) {
    return 0;
  }
  const configured = toInt(policy.defaultMs, 0);
  return Math.min(
    Math.max(configured, toInt(policy.minimumMs, 1)),
    Math.max(toInt(policy.maximumMs, configured), toInt(policy.minimumMs, 1)),
  );
}

function resolveAbyssalTraceAutomaticActivationDelayMs(profile) {
  const policy = profile && profile.automaticActivation;
  if (!policy || policy.enabled !== true) {
    return null;
  }
  return Math.max(0, toInt(policy.delayMs, 0));
}

module.exports = {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE,
  SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE_ID,
  SHARED_ABYSSAL_ENTRANCE_TRANSITION_DELAY_MS,
  T0_DARK_FILAMENT_TYPE_ID,
  // Retain the old export as an object alias for downstream compatibility.
  T0_DARK_RETAIL_CAPTURED_TRACE_PROFILE: SHARED_ABYSSAL_ENTRANCE_TRACE_PROFILE,
  T0_DARK_TRACE_PROFILE_ID,
  T0_TRANQUIL_FILAMENT_TYPE_IDS,
  applyAbyssalTraceProfileToEntity,
  buildAbyssalTraceSlimState,
  getAbyssalTracePhaseDefinition,
  normalizeAbyssalTraceLifecyclePhase,
  resolveAbyssalTraceAutomaticActivationDelayMs,
  resolveAbyssalTracePostReturnLifetimeMs,
  resolveAbyssalTraceProfile,
  resolveAbyssalTraceTransitionPresentation,
};
