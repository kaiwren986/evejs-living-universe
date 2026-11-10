"use strict";

const ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION = 1;
const ABYSSAL_CONTENT_PROFILE_REFERENCE_SCHEMA_VERSION = 2;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function getContentProfile({}, source) {
  return source && source.contentProfile && typeof source.contentProfile === "object"
    ? source.contentProfile
    : null;
}

function buildPersistedAbyssalContentProfile({
  cloneValue,
}, contentProfile) {
  if (
    !contentProfile ||
    typeof contentProfile !== "object" ||
    contentProfile.debugFallback === true ||
    toInt(contentProfile.filamentTypeID, 0) <= 0 ||
    !normalizeText(contentProfile.definitionID, "") ||
    !normalizeText(contentProfile.hullMode, "")
  ) {
    return cloneValue(contentProfile);
  }
  return {
    abyssalContentProfileReferenceSchemaVersion:
      contentProfile.contentGeneration
        ? ABYSSAL_CONTENT_PROFILE_REFERENCE_SCHEMA_VERSION : 1,
    filamentTypeID: toInt(contentProfile.filamentTypeID, 0),
    definitionID: normalizeText(contentProfile.definitionID, ""),
    hullMode: normalizeText(contentProfile.hullMode, ""),
    authoredCaptureID: normalizeText(
      contentProfile.authoredCaptureID,
      normalizeText(
        contentProfile.authoredContentSelection &&
          contentProfile.authoredContentSelection.captureID,
        "",
      ),
    ),
    observedNpcSpawnSelectionSeed: normalizeText(
      contentProfile.observedNpcSpawnSelectionSeed,
      "",
    ),
    ...(contentProfile.contentGeneration
      ? { contentGeneration: cloneValue(contentProfile.contentGeneration) } : {}),
  };
}

function isPersistedAbyssalContentProfileReference({}, contentProfile) {
  return Boolean(
    contentProfile &&
    typeof contentProfile === "object" &&
    Object.hasOwn(contentProfile, "abyssalContentProfileReferenceSchemaVersion")
  );
}

function rehydratePersistedAbyssalContentProfile({
  isPersistedAbyssalContentProfileReference,
  cloneValue,
  resolvePersistedFilamentDefinition,
},
  reference,
  fallbackProfile = null,
) {
  if (!isPersistedAbyssalContentProfileReference(reference)) {
    return cloneValue(reference);
  }
  const schema = Number(reference.abyssalContentProfileReferenceSchemaVersion);
  if (schema !== 1 && schema !== ABYSSAL_CONTENT_PROFILE_REFERENCE_SCHEMA_VERSION) {
    throw new Error("ABYSSAL_CONTENT_REFERENCE_VERSION_UNSUPPORTED");
  }
  if (toInt(reference.filamentTypeID, 0) <= 0 ||
      !normalizeText(reference.definitionID) || !normalizeText(reference.hullMode)) {
    throw new Error("ABYSSAL_PERSISTED_CONTENT_PROFILE_REFERENCE_UNRESOLVED");
  }
  if (
    schema === 1 &&
    fallbackProfile &&
    typeof fallbackProfile === "object" &&
    !isPersistedAbyssalContentProfileReference(fallbackProfile) &&
    toInt(fallbackProfile.filamentTypeID, 0) ===
      toInt(reference.filamentTypeID, 0) &&
    normalizeText(fallbackProfile.definitionID, "") ===
      normalizeText(reference.definitionID, "") &&
    !fallbackProfile.contentGeneration &&
    normalizeText(fallbackProfile.hullMode) === normalizeText(reference.hullMode) &&
    normalizeText(fallbackProfile.authoredCaptureID,
      normalizeText(fallbackProfile.authoredContentSelection?.captureID)) ===
      normalizeText(reference.authoredCaptureID) &&
    normalizeText(fallbackProfile.observedNpcSpawnSelectionSeed) ===
      normalizeText(reference.observedNpcSpawnSelectionSeed)
  ) {
    return fallbackProfile;
  }
  const resolution = resolvePersistedFilamentDefinition({
    abyssalContentProfileReferenceSchemaVersion: schema,
    filamentTypeID: toInt(reference.filamentTypeID, 0),
    definitionID: normalizeText(reference.definitionID, ""),
    hullMode: normalizeText(reference.hullMode, ""),
    authoredCaptureID:
      normalizeText(reference.authoredCaptureID, "") || undefined,
    observedNpcSpawnSelectionSeed:
      normalizeText(reference.observedNpcSpawnSelectionSeed, "") || undefined,
    ...(schema === 2 ? { contentGeneration: cloneValue(reference.contentGeneration) } : {}),
  });
  if (resolution && resolution.success !== true && resolution.errorCode) {
    throw new Error(resolution.errorCode);
  }
  const definition = resolution && resolution.success === true
    ? resolution.definition
    : null;
  if (
    !definition ||
    toInt(definition.filamentTypeID, 0) !== toInt(reference.filamentTypeID, 0) ||
    normalizeText(definition.hullMode) !== normalizeText(reference.hullMode) ||
    normalizeText(definition.definitionID, "") !==
      normalizeText(reference.definitionID, "")
  ) {
    throw new Error("ABYSSAL_PERSISTED_CONTENT_PROFILE_REFERENCE_UNRESOLVED");
  }
  return definition;
}

function buildPersistedAbyssalRuntimeState({
  now,
  buildPersistedAbyssalContentProfile,
  getContentProfile,
  cloneValue,
},
  pocketState,
  nowMs = now(),
) {
  const persistablePocketState = {
    ...pocketState,
    contentProfile: buildPersistedAbyssalContentProfile(
      getContentProfile(pocketState),
    ),
  };
  delete persistablePocketState.instance;
  const persisted = cloneValue(persistablePocketState) || {};
  const roomStatesByIndex =
    persisted.roomState &&
    persisted.roomState.roomStatesByIndex &&
    typeof persisted.roomState.roomStatesByIndex === "object"
      ? persisted.roomState.roomStatesByIndex
      : {};
  for (const roomEntry of Object.values(roomStatesByIndex)) {
    if (roomEntry && typeof roomEntry === "object") {
      delete roomEntry.environmentalMechanicsLastCheckedAtMs;
    }
  }
  return {
    schemaVersion: ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION,
    persistedAtMs: toInt(nowMs, now()),
    pocketState: persisted,
  };
}

function getAbyssalPocketPersistenceVersion({}, pocketState) {
  return Math.max(0, toInt(pocketState && pocketState.persistenceVersion, 0));
}

function buildAbyssalPocketMutationSignature({
  buildPersistedAbyssalRuntimeState,
}, pocketState) {
  const comparable = buildPersistedAbyssalRuntimeState(pocketState, 0).pocketState;
  delete comparable.persistenceVersion;
  return JSON.stringify(comparable);
}

function readPersistedAbyssalPocketStateFromInstance({
  cloneValue,
  isPersistedAbyssalContentProfileReference,
  rehydratePersistedAbyssalContentProfile,
}, instance) {
  const runtimeState =
    instance &&
    instance.environmentState &&
    instance.environmentState.abyssalRuntimeState;
  const pocketState =
    runtimeState &&
    runtimeState.pocketState &&
    typeof runtimeState.pocketState === "object"
      ? runtimeState.pocketState
      : null;
  if (!pocketState) {
    return null;
  }
  const clonedPocketState = cloneValue(pocketState);
  if (
    isPersistedAbyssalContentProfileReference(
      clonedPocketState.contentProfile,
    )
  ) {
    clonedPocketState.contentProfile =
      rehydratePersistedAbyssalContentProfile(
        clonedPocketState.contentProfile,
        instance && instance.metadata && instance.metadata.contentProfile,
      );
  }
  return clonedPocketState;
}

function verifyPersistedAbyssalPocketState({
  readPersistedAbyssalPocketStateFromInstance,
  getAbyssalPocketPersistenceVersion,
  buildPersistedAbyssalRuntimeState,
},
  expectedPocketState,
  persistedInstance,
) {
  const persistedPocketState =
    readPersistedAbyssalPocketStateFromInstance(persistedInstance);
  if (!persistedPocketState) {
    return {
      success: false,
      errorMsg: "ABYSSAL_POCKET_PERSISTENCE_READBACK_UNAVAILABLE",
    };
  }
  const expectedVersion = getAbyssalPocketPersistenceVersion(
    expectedPocketState,
  );
  const persistedVersion = getAbyssalPocketPersistenceVersion(
    persistedPocketState,
  );
  if (persistedVersion !== expectedVersion) {
    return {
      success: false,
      errorMsg: "ABYSSAL_POCKET_PERSISTENCE_VERSION_MISMATCH",
      expectedVersion,
      persistedVersion,
    };
  }
  const expectedSignature = JSON.stringify(
    buildPersistedAbyssalRuntimeState(expectedPocketState, 0).pocketState,
  );
  const persistedSignature = JSON.stringify(
    buildPersistedAbyssalRuntimeState(persistedPocketState, 0).pocketState,
  );
  if (persistedSignature !== expectedSignature) {
    return {
      success: false,
      errorMsg: "ABYSSAL_POCKET_PERSISTENCE_READBACK_MISMATCH",
      expectedVersion,
      persistedVersion,
    };
  }
  return {
    success: true,
    persistedPocketState,
    expectedVersion,
    persistedVersion,
  };
}

function createAbyssalRuntimeStateCodec({
  cloneValue,
  resolvePersistedFilamentDefinition,
  now = () => Date.now(),
} = {}) {
  if (typeof cloneValue !== "function") {
    throw new TypeError("cloneValue dependency is required");
  }
  if (typeof resolvePersistedFilamentDefinition !== "function") {
    throw new TypeError("resolvePersistedFilamentDefinition dependency is required");
  }
  if (typeof now !== "function") {
    throw new TypeError("now dependency must be a function");
  }
  const ports = {
    cloneValue,
    resolvePersistedFilamentDefinition,
    now,
  };
  ports.getContentProfile = getContentProfile.bind(null, ports);
  ports.buildPersistedAbyssalContentProfile = buildPersistedAbyssalContentProfile.bind(null, ports);
  ports.isPersistedAbyssalContentProfileReference = isPersistedAbyssalContentProfileReference.bind(null, ports);
  ports.rehydratePersistedAbyssalContentProfile = rehydratePersistedAbyssalContentProfile.bind(null, ports);
  ports.buildPersistedAbyssalRuntimeState = buildPersistedAbyssalRuntimeState.bind(null, ports);
  ports.getAbyssalPocketPersistenceVersion = getAbyssalPocketPersistenceVersion.bind(null, ports);
  ports.buildAbyssalPocketMutationSignature = buildAbyssalPocketMutationSignature.bind(null, ports);
  ports.readPersistedAbyssalPocketStateFromInstance = readPersistedAbyssalPocketStateFromInstance.bind(null, ports);
  ports.verifyPersistedAbyssalPocketState = verifyPersistedAbyssalPocketState.bind(null, ports);
  Object.freeze(ports);
  return {
    buildAbyssalPocketMutationSignature: ports.buildAbyssalPocketMutationSignature,
    buildPersistedAbyssalContentProfile: ports.buildPersistedAbyssalContentProfile,
    buildPersistedAbyssalRuntimeState: ports.buildPersistedAbyssalRuntimeState,
    getAbyssalPocketPersistenceVersion: ports.getAbyssalPocketPersistenceVersion,
    isPersistedAbyssalContentProfileReference: ports.isPersistedAbyssalContentProfileReference,
    readPersistedAbyssalPocketStateFromInstance: ports.readPersistedAbyssalPocketStateFromInstance,
    rehydratePersistedAbyssalContentProfile: ports.rehydratePersistedAbyssalContentProfile,
    verifyPersistedAbyssalPocketState: ports.verifyPersistedAbyssalPocketState,
  };
}

module.exports = {
  ABYSSAL_CONTENT_PROFILE_REFERENCE_SCHEMA_VERSION,
  ABYSSAL_RUNTIME_STATE_SCHEMA_VERSION,
  createAbyssalRuntimeStateCodec,
};
