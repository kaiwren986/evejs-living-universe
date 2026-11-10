"use strict";
const { toInt, normalizeText, listUniquePositiveInts } = require("../domain/abyssalRuntimeValues");

function sceneHasDynamicEntity(ports, scene, entityID) {
  const numericEntityID = toInt(entityID, 0);
  return Boolean(
    scene &&
      scene.dynamicEntities instanceof Map &&
      scene.dynamicEntities.has(numericEntityID)
  );
}

// Whether the scene has placed the Ball in its Grid bubbles: in a bubble,
// or, for a room's content not yet released (prewarmed), held out of them
// until its transition.
function sceneBubbleHasEntity(ports, scene, entityID) {
  const numericEntityID = toInt(entityID, 0);
  if (
    !scene ||
    typeof scene.isBallPlacedInGridBubbles !== "function" ||
    typeof scene.getEntityByID !== "function" ||
    numericEntityID <= 0
  ) {
    return false;
  }
  return scene.isBallPlacedInGridBubbles(scene.getEntityByID(numericEntityID));
}

function getReadOnlySolarSystemScene(ports, runtime, systemID) {
  const numericSystemID = toInt(systemID, 0);
  if (!runtime || numericSystemID <= 0) {
    return null;
  }
  if (typeof runtime.getSceneByDescriptor === "function") {
    return runtime.getSceneByDescriptor({
      sceneKind: "solarSystem",
      solarSystemID: numericSystemID,
      locationID: numericSystemID,
    });
  }
  return null;
}

function collectAbyssalNpcSceneRegistrationDiagnostics(ports, scene, sceneDescriptor, hostileEntityIDs, deps = ports.getDependencies()) {
  const {
    buildSlimItemObject,
  } = ports;
  const runtime = deps;
  const npcService = deps;
  const hostScene = getReadOnlySolarSystemScene(ports,
    runtime,
    sceneDescriptor && sceneDescriptor.locationID,
  );
  const diagnostics = {
    missingRunDynamic: [],
    missingRunBubble: [],
    wrongRunScene: [],
    hostDynamic: [],
    hostBubble: [],
    foundScene: [],
    controllerMissing: [],
    controllerWrongScene: [],
    controllerNotPaused: [],
    controllerTickMissing: [],
    slimMissing: [],
  };
  const expectedSceneKey = normalizeText(sceneDescriptor && sceneDescriptor.sceneKey, "");
  const canReadController =
    npcService && typeof npcService.getNpcServiceControllerByEntityID === "function";
  for (const hostileEntityID of listUniquePositiveInts(hostileEntityIDs)) {
    const sceneEntity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(hostileEntityID)
        : null;
    if (!sceneHasDynamicEntity(ports, scene, hostileEntityID)) {
      diagnostics.missingRunDynamic.push(hostileEntityID);
    }
    if (!sceneBubbleHasEntity(ports, scene, hostileEntityID)) {
      diagnostics.missingRunBubble.push(hostileEntityID);
    }
    if (sceneEntity && expectedSceneKey && sceneEntity.sceneKey && sceneEntity.sceneKey !== expectedSceneKey) {
      diagnostics.wrongRunScene.push(`${hostileEntityID}:${normalizeText(sceneEntity.sceneKey, "none")}`);
    }
    if (sceneHasDynamicEntity(ports, hostScene, hostileEntityID)) {
      diagnostics.hostDynamic.push(hostileEntityID);
    }
    if (sceneBubbleHasEntity(ports, hostScene, hostileEntityID)) {
      diagnostics.hostBubble.push(hostileEntityID);
    }
    if (runtime && typeof runtime.findSceneContainingDynamicEntity === "function") {
      const foundScene = runtime.findSceneContainingDynamicEntity(hostileEntityID);
      const foundSceneKey = normalizeText(foundScene && foundScene.sceneKey, "");
      if (foundSceneKey && foundSceneKey !== expectedSceneKey) {
        diagnostics.foundScene.push(`${hostileEntityID}:${foundSceneKey}`);
      }
    }
    if (canReadController) {
      const controller = npcService.getNpcServiceControllerByEntityID(hostileEntityID);
      if (!controller) {
        diagnostics.controllerMissing.push(hostileEntityID);
      } else if (expectedSceneKey && controller.sceneKey && controller.sceneKey !== expectedSceneKey) {
        diagnostics.controllerWrongScene.push(`${hostileEntityID}:${normalizeText(controller.sceneKey, "none")}`);
      } else {
        const controllerPaused = controller.controllerPaused === true ||
          controller.controllerLifecycleState === "materialized_paused";
        if (!controllerPaused) {
          diagnostics.controllerNotPaused.push(hostileEntityID);
        }
        if (!Number.isFinite(Number(controller.nextThinkAtMs))) {
          diagnostics.controllerTickMissing.push(hostileEntityID);
        }
      }
    }
    if (!sceneEntity || !buildSlimItemObject(sceneEntity)) {
      diagnostics.slimMissing.push(hostileEntityID);
    }
  }
  const failed = Object.values(diagnostics).some((values) => Array.isArray(values) && values.length > 0);
  return {
    success: !failed,
    diagnostics,
  };
}

function formatAbyssalNpcSceneRegistrationDiagnostics(ports, diagnostics = {}) {
  return [
    `missingRunDynamic=${(diagnostics.missingRunDynamic || []).join(",") || "none"}`,
    `missingRunBubble=${(diagnostics.missingRunBubble || []).join(",") || "none"}`,
    `wrongRunScene=${(diagnostics.wrongRunScene || []).join(",") || "none"}`,
    `hostDynamic=${(diagnostics.hostDynamic || []).join(",") || "none"}`,
    `hostBubble=${(diagnostics.hostBubble || []).join(",") || "none"}`,
    `foundScene=${(diagnostics.foundScene || []).join(",") || "none"}`,
    `controllerMissing=${(diagnostics.controllerMissing || []).join(",") || "none"}`,
    `controllerWrongScene=${(diagnostics.controllerWrongScene || []).join(",") || "none"}`,
    `controllerNotPaused=${(diagnostics.controllerNotPaused || []).join(",") || "none"}`,
    `controllerTickMissing=${(diagnostics.controllerTickMissing || []).join(",") || "none"}`,
    `slimMissing=${(diagnostics.slimMissing || []).join(",") || "none"}`,
  ].join(" ");
}

function resolveEntityBubbleForScene(ports, scene, entityOrID) {
  const entityID = toInt(
    entityOrID && typeof entityOrID === "object" ? entityOrID.itemID : entityOrID,
    0,
  );
  const dynamicEntity = scene && scene.dynamicEntities instanceof Map
    ? scene.dynamicEntities.get(entityID) || null
    : null;
  const entity = dynamicEntity || (
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null
  );
  const entityBubbleID = toInt(entity && entity.bubbleID, 0);
  const bubble = entityBubbleID > 0 && scene && typeof scene.getBubbleByID === "function"
    ? scene.getBubbleByID(entityBubbleID)
    : null;
  const sceneBubbleID = toInt(bubble && bubble.bubbleID, toInt(bubble && bubble.id, 0));
  const bubbleRegistered = Boolean(
    bubble &&
      bubble.entityIDs instanceof Set &&
      bubble.entityIDs.has(entityID),
  );
  return {
    entityID,
    entity,
    entityBubbleID,
    sceneBubbleID,
    bubble,
    bubbleRegistered,
  };
}

function createAbyssalSceneDiagnostics(ports) {
  return {
    sceneHasDynamicEntity: sceneHasDynamicEntity.bind(null, ports),
    sceneBubbleHasEntity: sceneBubbleHasEntity.bind(null, ports),
    getReadOnlySolarSystemScene: getReadOnlySolarSystemScene.bind(null, ports),
    collectAbyssalNpcSceneRegistrationDiagnostics: collectAbyssalNpcSceneRegistrationDiagnostics.bind(null, ports),
    formatAbyssalNpcSceneRegistrationDiagnostics: formatAbyssalNpcSceneRegistrationDiagnostics.bind(null, ports),
    resolveEntityBubbleForScene: resolveEntityBubbleForScene.bind(null, ports),
  };
}

module.exports = { createAbyssalSceneDiagnostics };
