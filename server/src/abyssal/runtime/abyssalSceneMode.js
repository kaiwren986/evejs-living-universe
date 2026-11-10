"use strict";
const { normalizeLowerText, normalizeText, toInt } = require("../domain/abyssalRuntimeValues");

function isAbyssalIsolatedScenesEnabled(ports) {
  return true;
}

function normalizeAbyssalSceneMode(ports, value) {
  const {
    ABYSSAL_SCENE_MODE_ISOLATED,
    ABYSSAL_SCENE_MODE_LEGACY,
  } = ports;
  const normalized = normalizeLowerText(value, "");
  if (normalized === ABYSSAL_SCENE_MODE_ISOLATED || normalized === "isolated-scene") {
    return ABYSSAL_SCENE_MODE_ISOLATED;
  }
  if (normalized === ABYSSAL_SCENE_MODE_LEGACY || normalized === "legacy") {
    return ABYSSAL_SCENE_MODE_LEGACY;
  }
  return "";
}

function getConfiguredAbyssalSceneModeSource(ports) {
  return "built-in";
}

function resolveAbyssalSceneModeState(ports, pocketState = null, deps = ports.getDependencies()) {
  const {
    ABYSSAL_SCENE_MODE_ISOLATED,
    ABYSSAL_SCENE_MODE_LEGACY,
  } = ports;
  const metadata =
    pocketState && pocketState.instance && pocketState.instance.metadata &&
    typeof pocketState.instance.metadata === "object"
      ? pocketState.instance.metadata
      : {};
  const explicitMode = normalizeAbyssalSceneMode(ports,
    pocketState && pocketState.sceneMode || metadata.sceneMode,
  );
  const explicitSceneKey = normalizeText(
    pocketState && pocketState.sceneKey || metadata.sceneKey,
    "",
  );
  const explicitSource = normalizeText(
    pocketState && pocketState.sceneModeSource || metadata.sceneModeSource,
    "persisted",
  );
  const rawInstanceID = pocketState && pocketState.instanceID;
  const instanceID = Number.isSafeInteger(Number(rawInstanceID)) && Number(rawInstanceID) > 0
    ? Number(rawInstanceID)
    : 0;
  const inferredSceneKey = instanceID > 0 ? `abyssal-run:${instanceID}` : "";
  if (explicitMode) {
    if (explicitMode === ABYSSAL_SCENE_MODE_ISOLATED) {
      if (inferredSceneKey) {
        return {
          sceneMode: ABYSSAL_SCENE_MODE_ISOLATED,
          mode: "isolated-scene",
          // A persisted scene key is never an alias. The live run identity is
          // authoritative, so malformed and cross-run values are repaired to
          // the one canonical key before any scene lookup or session attach.
          sceneKey: inferredSceneKey,
          source: explicitSource,
          persisted: true,
          ambiguous: false,
          canonicalized: explicitSceneKey !== inferredSceneKey,
        };
      }
      return {
        sceneMode: ABYSSAL_SCENE_MODE_LEGACY,
        mode: ABYSSAL_SCENE_MODE_LEGACY,
        sceneKey: "",
        source: "persisted-isolated-invalid-instance",
        persisted: true,
        ambiguous: true,
        canonicalized: false,
      };
    }
    return {
      sceneMode: explicitMode,
      mode: ABYSSAL_SCENE_MODE_LEGACY,
      sceneKey: "",
      source: explicitSource,
      persisted: true,
      ambiguous: false,
      canonicalized: false,
    };
  }
  if (explicitSceneKey.startsWith("abyssal-run:")) {
    if (inferredSceneKey && explicitSceneKey === inferredSceneKey) {
      return {
        sceneMode: ABYSSAL_SCENE_MODE_ISOLATED,
        mode: "isolated-scene",
        sceneKey: inferredSceneKey,
        source: "migration-scene-key",
        persisted: false,
        ambiguous: false,
        canonicalized: false,
      };
    }
    return {
      sceneMode: ABYSSAL_SCENE_MODE_LEGACY,
      mode: ABYSSAL_SCENE_MODE_LEGACY,
      sceneKey: "",
      source: "migration-invalid-scene-key",
      persisted: false,
      ambiguous: true,
      canonicalized: false,
    };
  }
  if (
    explicitSceneKey.startsWith("solar-system:") ||
    pocketState && pocketState.legacySameSystem === true ||
    metadata.legacySameSystem === true
  ) {
    return {
      sceneMode: ABYSSAL_SCENE_MODE_LEGACY,
      mode: ABYSSAL_SCENE_MODE_LEGACY,
      sceneKey: "",
      source: "migration-legacy-marker",
      persisted: false,
      ambiguous: false,
      canonicalized: false,
    };
  }

  const runtime = deps;
  if (
    inferredSceneKey &&
    runtime &&
    typeof runtime.hasScene === "function" &&
    runtime.hasScene(inferredSceneKey)
  ) {
    return {
      sceneMode: ABYSSAL_SCENE_MODE_ISOLATED,
      mode: "isolated-scene",
      sceneKey: inferredSceneKey,
      source: "migration-existing-scene",
      persisted: false,
      ambiguous: false,
      canonicalized: false,
    };
  }

  if (pocketState) {
    return {
      sceneMode: ABYSSAL_SCENE_MODE_LEGACY,
      mode: ABYSSAL_SCENE_MODE_LEGACY,
      sceneKey: "",
      source: "migration-ambiguous-legacy",
      persisted: false,
      ambiguous: true,
      canonicalized: false,
    };
  }

  const isolated = isAbyssalIsolatedScenesEnabled(ports);
  return {
    sceneMode: isolated ? ABYSSAL_SCENE_MODE_ISOLATED : ABYSSAL_SCENE_MODE_LEGACY,
    mode: isolated ? "isolated-scene" : ABYSSAL_SCENE_MODE_LEGACY,
    sceneKey: "",
    source: getConfiguredAbyssalSceneModeSource(ports),
    persisted: false,
    ambiguous: false,
    canonicalized: false,
  };
}

function usesIsolatedAbyssalScene(ports, pocketState = null, deps = ports.getDependencies()) {
  const {
    ABYSSAL_SCENE_MODE_ISOLATED,
  } = ports;
  return resolveAbyssalSceneModeState(ports, pocketState, deps).sceneMode === ABYSSAL_SCENE_MODE_ISOLATED;
}

function logRecoveredAbyssalSceneMode(ports, pocketState, deps = ports.getDependencies()) {
  const {
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
    log,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  if (
    runID <= 0 ||
    ports.hasDedupeKey(
      ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.RECOVERED_SCENE_MODE,
      runID,
    )
  ) {
    return;
  }
  ports.recordDedupeKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.RECOVERED_SCENE_MODE,
    runID,
  );
  const state = resolveAbyssalSceneModeState(ports, pocketState, deps);
  log.info(
    `[AbyssalSceneMode] run=${runID} mode=${state.mode} ` +
      `source=${state.persisted ? "persisted" : state.source} state=recovered ` +
      `sceneKey=${normalizeText(state.sceneKey, "none")}`,
  );
}

function logAmbiguousAbyssalSceneMode(ports, pocketState, modeState) {
  const {
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE,
    log,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  if (
    runID <= 0 ||
    !modeState ||
    modeState.ambiguous !== true ||
    ports.hasDedupeKey(
      ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.AMBIGUOUS_SCENE_MODE,
      runID,
    )
  ) {
    return;
  }
  ports.recordDedupeKey(
    ABYSSAL_DIAGNOSTIC_DEDUPE_SCOPE.AMBIGUOUS_SCENE_MODE,
    runID,
  );
  log.warn(
    `[AbyssalSceneMode] run=${runID} state=migration-ambiguous ` +
      `selected=${modeState.mode} warning=ABYSSAL_SCENE_MODE_AMBIGUOUS ` +
      `action=preserve-legacy-avoid-mixed-scene-content`,
  );
}

function validateAbyssalIsolatedSceneRuntime(ports, pocketState, deps = ports.getDependencies()) {
  if (!usesIsolatedAbyssalScene(ports, pocketState, deps)) {
    return {
      success: true,
      enabled: false,
      descriptor: null,
    };
  }

  const runtime = deps;
  if (!runtime) {
    return {
      success: false,
      enabled: true,
      errorMsg: "ABYSSAL_ISOLATED_SCENE_RUNTIME_MISSING",
    };
  }
  if (typeof runtime.normalizeSceneDescriptor !== "function") {
    return {
      success: false,
      enabled: true,
      errorMsg: "ABYSSAL_ISOLATED_SCENE_DESCRIPTOR_UNSUPPORTED",
    };
  }
  if (typeof runtime.buildAbyssalSceneKey !== "function") {
    return {
      success: false,
      enabled: true,
      errorMsg: "ABYSSAL_ISOLATED_SCENE_KEY_UNSUPPORTED",
    };
  }

  const descriptor = buildAbyssalSceneDescriptor(ports, pocketState, deps);
  if (!descriptor) {
    return {
      success: false,
      enabled: true,
      errorMsg: "ABYSSAL_ISOLATED_SCENE_DESCRIPTOR_INVALID",
    };
  }
  if (toInt(descriptor.locationID, 0) <= 0) {
    return {
      success: false,
      enabled: true,
      errorMsg: "ABYSSAL_ISOLATED_SCENE_LOCATION_INVALID",
    };
  }
  if (!normalizeText(descriptor.sceneKey, "")) {
    return {
      success: false,
      enabled: true,
      errorMsg: "ABYSSAL_ISOLATED_SCENE_KEY_INVALID",
    };
  }

  return {
    success: true,
    enabled: true,
    descriptor,
  };
}

function buildAbyssalSceneDescriptor(ports, pocketState, deps = ports.getDependencies()) {
  const {
    ABYSSAL_SCENE_MODE_ISOLATED,
  } = ports;
  const runtime = deps;
  const instanceID = toInt(pocketState && pocketState.instanceID, 0);
  const sceneModeState = resolveAbyssalSceneModeState(ports, pocketState, deps);
  if (
    sceneModeState.sceneMode !== ABYSSAL_SCENE_MODE_ISOLATED ||
    !runtime ||
    instanceID <= 0 ||
    typeof runtime.normalizeSceneDescriptor !== "function"
  ) {
    return null;
  }
  const storedLocationID = toInt(
    pocketState && (pocketState.abyssalLocationID || pocketState.locationID),
    0,
  );
  const locationID = storedLocationID > 0
    ? storedLocationID
    : (
        typeof runtime.allocateAbyssalLocationID === "function"
          ? runtime.allocateAbyssalLocationID(instanceID)
          : 0
      );
  const canonicalSceneKey = `abyssal-run:${instanceID}`;
  const descriptor = runtime.normalizeSceneDescriptor({
    sceneKind: "abyssal",
    sceneKey: canonicalSceneKey,
    instanceID,
    locationID,
    solarSystemID: toInt(pocketState && pocketState.solarSystemID, 0),
    sourceSolarSystemID: toInt(
      pocketState && pocketState.sourceSolarSystemID,
      toInt(pocketState && pocketState.solarSystemID, 0),
    ),
  });
  if (
    !descriptor ||
    normalizeText(descriptor.sceneKey, "") !== canonicalSceneKey ||
    toInt(descriptor.instanceID, 0) !== instanceID
  ) {
    return null;
  }
  return descriptor;
}

function getPocketScene(ports, pocketState, deps = ports.getDependencies()) {
  const runtime = deps;
  const systemID = toInt(pocketState && pocketState.solarSystemID, 0);
  if (!runtime || typeof runtime.ensureScene !== "function" || systemID <= 0) {
    return null;
  }
  if (usesIsolatedAbyssalScene(ports, pocketState, deps)) {
    const descriptor = buildAbyssalSceneDescriptor(ports, pocketState, deps);
    if (descriptor) {
      return runtime.ensureScene(descriptor);
    }
    // Isolated mode is an authority boundary. A missing or invalid descriptor
    // must not silently route pocket operations into the shared numeric host
    // scene, where unrelated K-space entities may have the same IDs.
    return null;
  }
  return runtime.ensureScene(systemID);
}

function createAbyssalSceneMode(ports) {
  return {
    isAbyssalIsolatedScenesEnabled: isAbyssalIsolatedScenesEnabled.bind(null, ports),
    normalizeAbyssalSceneMode: normalizeAbyssalSceneMode.bind(null, ports),
    getConfiguredAbyssalSceneModeSource: getConfiguredAbyssalSceneModeSource.bind(null, ports),
    resolveAbyssalSceneModeState: resolveAbyssalSceneModeState.bind(null, ports),
    usesIsolatedAbyssalScene: usesIsolatedAbyssalScene.bind(null, ports),
    logRecoveredAbyssalSceneMode: logRecoveredAbyssalSceneMode.bind(null, ports),
    logAmbiguousAbyssalSceneMode: logAmbiguousAbyssalSceneMode.bind(null, ports),
    validateAbyssalIsolatedSceneRuntime: validateAbyssalIsolatedSceneRuntime.bind(null, ports),
    buildAbyssalSceneDescriptor: buildAbyssalSceneDescriptor.bind(null, ports),
    getPocketScene: getPocketScene.bind(null, ports),
  };
}

module.exports = { createAbyssalSceneMode };
