"use strict";

// Transport and teleport chat commands: /tr (move a character, ship or entity to another
// entity, a bookmark, an agent, a location, coordinates or an offset), /tele (to another
// character), /solar (to a solar system) and /dock (back to the home station), with the
// target and destination resolution and the local channel move feedback they share.

const path = require("path");

const sessionRegistry = require("../sessionRegistry");
const {
  isLocalChatRoomName,
} = require("../channelRules");
const itemStore = require("../../inventory/itemStore");
const {
  resolveDirectWorldTransportDestination,
  resolveStoredTransportDestination,
} = require("../../eveOffline/transportLocationResolver");
const {
  resolveSolarSystemByName,
} = require("../solarSystemRegistry");
const {
  jumpSessionToSolarSystem,
  jumpSessionToStation,
  jumpSessionToDockableLocation,
} = require("../../../space/transitions");
const worldData = require("../../../space/worldData");
const spaceRuntime = require("../../../space/runtime");
const {
  ONE_AU_IN_METERS,
  findSafeWarpOriginAnchor,
} = require("../../../space/npc/npcWarpOrigins");
const AbyssalMgrService = require("../../../abyssal").chatIntegration;
const {
  getAgentLocationWrap,
} = require(path.join(__dirname, "../../agent/agentMissionRuntime"));
const {
  getAgentByID,
} = require(path.join(__dirname, "../../agent/agentAuthority"));
const bookmarkRuntime = require(path.join(__dirname, "../../bookmark/bookmarkRuntimeState"));
const {
  getFeedbackChannel,
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commandArguments"));
const {
  formatSuggestions,
} = require(path.join(__dirname, "./commandSuggestions"));
const {
  resolveCharacterTargetDescriptor,
  formatCharacterTargetLabel,
} = require(path.join(__dirname, "./characterTargets"));
const {
  getSessionDockedStationID,
  getSessionCurrentSolarSystemID,
  isSpaceSessionReady,
  resolveSessionShipEntity,
} = require(path.join(__dirname, "./commandSessionLocation"));
const {
  cloneSpaceVector,
  addVectors,
} = require(path.join(__dirname, "./spaceVectors"));

function isLocalFeedbackChannel(channelName) {
  if (!channelName) {
    return false;
  }

  return isLocalChatRoomName(channelName);
}

function getPostLocalMoveFeedbackOptions(options) {
  const feedbackChannel = getFeedbackChannel(options);
  if (!isLocalFeedbackChannel(feedbackChannel)) {
    return options;
  }

  return {
    ...options,
    feedbackChannel: null,
  };
}

function flushPendingLocalChannelSync(chatHub, session) {
  if (
    !chatHub ||
    !session ||
    typeof chatHub.moveLocalSession !== "function"
  ) {
    return;
  }

  const pending = session._pendingLocalChannelSync || null;
  if (!pending) {
    return;
  }

  session._pendingLocalChannelSync = null;
  chatHub.moveLocalSession(session, pending.previousChannelID);
}

function parseTransportVectorTag(token, prefix) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return null;
  }

  const normalizedPrefix = `${String(prefix || "").toLowerCase()}=`;
  if (!trimmed.toLowerCase().startsWith(normalizedPrefix)) {
    return null;
  }

  const parts = trimmed.slice(normalizedPrefix.length).split(",");
  if (parts.length !== 3) {
    return null;
  }

  const values = parts.map((value) => Number(String(value || "").trim()));
  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    x: values[0],
    y: values[1],
    z: values[2],
  };
}

function parseTransportCoordinateTriplet(tokens) {
  if (!Array.isArray(tokens) || tokens.length !== 3) {
    return null;
  }

  const values = tokens.map((value) => Number(String(value || "").trim()));
  if (values.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return {
    x: values[0],
    y: values[1],
    z: values[2],
  };
}

function getSessionTransportEntity(session) {
  if (!session || !session._space) {
    return null;
  }

  return spaceRuntime.getEntity(
    session,
    session._space && session._space.shipID,
  );
}

function buildTransportPointAnchor(entity, fallbackSystemID = null) {
  if (!entity) {
    return null;
  }

  const systemID =
    normalizePositiveInteger(entity.systemID || entity.solarSystemID) ||
    normalizePositiveInteger(fallbackSystemID);
  if (!systemID) {
    return null;
  }

  return {
    kind: "point",
    systemID,
    point: cloneSpaceVector(entity.position),
    direction: cloneSpaceVector(entity.direction, { x: 1, y: 0, z: 0 }),
    label:
      entity.stationName ||
      entity.stargateName ||
      entity.celestialName ||
      entity.name ||
      `${entity.kind || "entity"} ${entity.itemID || ""}`.trim(),
  };
}

function getSessionTransportAnchor(session) {
  if (!session) {
    return null;
  }

  const dockedStationID = getSessionDockedStationID(session);
  if (dockedStationID) {
    const station = worldData.getStationByID(dockedStationID);
    return {
      kind: "station",
      stationID: dockedStationID,
      label:
        (station && station.stationName) ||
        `station ${dockedStationID}`,
    };
  }

  const shipEntity = getSessionTransportEntity(session);
  if (shipEntity) {
    const shipAnchor = buildTransportPointAnchor(
      shipEntity,
      getSessionCurrentSolarSystemID(session),
    );
    return shipAnchor
      ? {
          ...shipAnchor,
          label:
            session.characterName ||
            session.userName ||
            shipAnchor.label,
        }
      : null;
  }

  const solarSystemID = getSessionCurrentSolarSystemID(session);
  if (!solarSystemID) {
    return null;
  }

  const solarSystem = worldData.getSolarSystemByID(solarSystemID);
  return {
    kind: "solarSystem",
    solarSystemID,
    label:
      (solarSystem && solarSystem.solarSystemName) ||
      `solar system ${solarSystemID}`,
  };
}

function resolveTransportSceneEntity(scene, entityID) {
  if (!scene || !entityID) {
    return null;
  }

  return scene.getEntityByID(entityID) || null;
}

function findStaticTransportAnchorByID(entityID) {
  const numericEntityID = normalizePositiveInteger(entityID);
  if (!numericEntityID) {
    return null;
  }

  const stargate = worldData.getStargateByID(numericEntityID);
  if (stargate) {
    return buildTransportPointAnchor(stargate, stargate.solarSystemID);
  }

  for (const solarSystem of worldData.getSolarSystems()) {
    const match = worldData.getStaticSceneForSystem(solarSystem.solarSystemID).find(
      (candidate) => Number(candidate && candidate.itemID) === numericEntityID,
    );
    if (match) {
      if (match.stationID) {
        return {
          kind: "station",
          stationID: numericEntityID,
          label:
            match.stationName ||
            `station ${numericEntityID}`,
        };
      }
      return buildTransportPointAnchor(match, solarSystem.solarSystemID);
    }
  }

  return null;
}

function resolveTransportTargetDescriptor(requestSession, targetToken) {
  const normalizedToken = String(targetToken || "").trim().toLowerCase();
  if (!normalizedToken) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  if (normalizedToken === "me") {
    if (!requestSession || !requestSession.characterID) {
      return {
        success: false,
        errorMsg: "CHARACTER_NOT_SELECTED",
      };
    }
    return {
      success: true,
      data: {
        kind: "session",
        session: requestSession,
        label: "me",
      },
    };
  }

  const numericTargetID = normalizePositiveInteger(targetToken);
  if (!numericTargetID) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  const targetSession = sessionRegistry.findSessionByCharacterID(numericTargetID);
  if (targetSession) {
    return {
      success: true,
      data: {
        kind: "session",
        session: targetSession,
        label: `character ${numericTargetID}`,
      },
    };
  }

  const requestScene = requestSession
    ? spaceRuntime.getSceneForSession(requestSession)
    : null;
  const entity = resolveTransportSceneEntity(requestScene, numericTargetID);
  if (
    entity &&
    requestScene &&
    requestScene.dynamicEntities instanceof Map &&
    requestScene.dynamicEntities.has(numericTargetID)
  ) {
    return {
      success: true,
      data: {
        kind: "entity",
        entity,
        scene: requestScene,
        systemID: requestScene.systemID,
        label: `${entity.kind || "entity"} ${numericTargetID}`,
      },
    };
  }

  return {
    success: false,
    errorMsg: "TARGET_NOT_FOUND",
  };
}

function resolveTransportPointContext(session, targetDescriptor) {
  const sessionAnchor = getSessionTransportAnchor(session);
  if (sessionAnchor) {
    if (sessionAnchor.kind === "point") {
      return sessionAnchor;
    }
    if (sessionAnchor.kind === "solarSystem") {
      return {
        kind: "point",
        systemID: sessionAnchor.solarSystemID,
        point: null,
        direction: { x: 1, y: 0, z: 0 },
      };
    }
    if (sessionAnchor.kind === "station") {
      const station = worldData.getStationByID(sessionAnchor.stationID);
      if (station) {
        return {
          kind: "point",
          systemID: normalizePositiveInteger(station.solarSystemID),
          point: null,
          direction: { x: 1, y: 0, z: 0 },
        };
      }
    }
  }

  if (targetDescriptor && targetDescriptor.kind === "session") {
    const targetAnchor = getSessionTransportAnchor(targetDescriptor.session);
    if (targetAnchor) {
      if (targetAnchor.kind === "point") {
        return targetAnchor;
      }
      if (targetAnchor.kind === "solarSystem") {
        return {
          kind: "point",
          systemID: targetAnchor.solarSystemID,
          point: null,
          direction: { x: 1, y: 0, z: 0 },
        };
      }
      if (targetAnchor.kind === "station") {
        const station = worldData.getStationByID(targetAnchor.stationID);
        if (station) {
          return {
            kind: "point",
            systemID: normalizePositiveInteger(station.solarSystemID),
            point: null,
            direction: { x: 1, y: 0, z: 0 },
          };
        }
      }
    }
  }

  if (targetDescriptor && targetDescriptor.kind === "entity") {
    return buildTransportPointAnchor(
      targetDescriptor.entity,
      targetDescriptor.systemID,
    );
  }

  return null;
}

function findAgentTransportEntity(agentRecord) {
  const agentID = normalizePositiveInteger(agentRecord && agentRecord.agentID);
  const solarSystemID = normalizePositiveInteger(
    agentRecord && agentRecord.solarSystemID,
  );
  if (!agentID || !solarSystemID) {
    return null;
  }

  const scene =
    spaceRuntime.scenes instanceof Map
      ? spaceRuntime.scenes.get(solarSystemID)
      : null;
  if (!scene) {
    return null;
  }

  const directEntity = resolveTransportSceneEntity(scene, agentID);
  if (directEntity) {
    return directEntity;
  }

  for (const collectionName of ["dynamicEntities", "staticEntities"]) {
    const collection = scene[collectionName];
    if (!(collection instanceof Map)) {
      continue;
    }
    const match = [...collection.values()].find((entity) => (
      normalizePositiveInteger(entity && (entity.agentID || entity.ownerID)) === agentID
    ));
    if (match) {
      return match;
    }
  }

  return null;
}

function resolveAgentTransportDestination(agentID) {
  const agentRecord = getAgentByID(agentID);
  if (!agentRecord) {
    return null;
  }

  const agentName = String(agentRecord.ownerName || `agent ${agentID}`).trim();
  const locationWrap = getAgentLocationWrap(agentID);
  const stationID = normalizePositiveInteger(
    locationWrap && locationWrap.locationID,
  );
  const station = worldData.getStationByID(stationID);
  if (station) {
    return {
      kind: "station",
      stationID,
      label: `${agentName} at ${station.stationName || `station ${stationID}`}`,
    };
  }

  const solarSystemID = normalizePositiveInteger(
    (locationWrap && (locationWrap.solarsystemID || locationWrap.locationID)) ||
      agentRecord.solarSystemID,
  );
  const point = locationWrap && ["x", "y", "z"].every(
    (axis) => Number.isFinite(Number(locationWrap[axis])),
  )
    ? {
        x: Number(locationWrap.x),
        y: Number(locationWrap.y),
        z: Number(locationWrap.z),
      }
    : null;
  if (solarSystemID && point) {
    return {
      kind: "point",
      systemID: solarSystemID,
      point,
      label: agentName,
    };
  }

  const liveEntity = findAgentTransportEntity(agentRecord);
  const liveAnchor = liveEntity
    ? buildTransportPointAnchor(liveEntity, solarSystemID)
    : null;
  return liveAnchor
    ? {
        ...liveAnchor,
        label: agentName,
      }
    : null;
}

function formatTransportBookmarkLabel(bookmark, bookmarkID) {
  const memo = String(bookmark && bookmark.memo || "").trim();
  return memo
    ? `bookmark ${memo} (${bookmarkID})`
    : `bookmark ${bookmarkID}`;
}

function resolveTransportBookmarkDestination(
  session,
  targetDescriptor,
  bookmarkID,
) {
  const characterID = normalizePositiveInteger(session && session.characterID);
  const numericBookmarkID = normalizePositiveInteger(bookmarkID);
  if (!characterID || !numericBookmarkID) {
    return null;
  }

  const bookmarkInfo = bookmarkRuntime.getBookmarkForCharacter(
    characterID,
    numericBookmarkID,
  );
  if (!bookmarkInfo || !bookmarkInfo.bookmark) {
    return null;
  }

  const target = bookmarkRuntime.resolveBookmarkTarget(numericBookmarkID);
  if (!target) {
    return null;
  }
  const label = formatTransportBookmarkLabel(
    bookmarkInfo.bookmark,
    numericBookmarkID,
  );

  if (target.kind === "point" && target.point) {
    const systemID = normalizePositiveInteger(target.locationID);
    if (!worldData.getSolarSystemByID(systemID)) {
      return null;
    }
    const pointContext = resolveTransportPointContext(session, targetDescriptor);
    return {
      kind: "point",
      systemID,
      point: cloneSpaceVector(target.point),
      direction: cloneSpaceVector(
        pointContext && pointContext.direction,
        { x: 1, y: 0, z: 0 },
      ),
      label,
    };
  }

  if (target.kind === "item") {
    const itemDestination = resolveKnownTransportLocationID(
      session,
      targetDescriptor,
      target.itemID,
    );
    return itemDestination
      ? {
          ...itemDestination,
          label,
        }
      : null;
  }

  return null;
}

function resolveWorldTransportLocationID(session, targetDescriptor, numericID) {
  if (!numericID) {
    return null;
  }

  const directWorldDestination = resolveDirectWorldTransportDestination(
    numericID,
    {
      getSolarSystemByID: worldData.getSolarSystemByID,
      getStationByID: worldData.getStationByID,
      getStructureByID: worldData.getStructureByID,
      buildPointAnchor: buildTransportPointAnchor,
    },
  );
  if (directWorldDestination) {
    return directWorldDestination;
  }

  const candidateScenes = [];
  const requestScene = session ? spaceRuntime.getSceneForSession(session) : null;
  if (requestScene) {
    candidateScenes.push(requestScene);
  }

  if (targetDescriptor && targetDescriptor.kind === "session") {
    const targetScene = spaceRuntime.getSceneForSession(targetDescriptor.session);
    if (targetScene && !candidateScenes.includes(targetScene)) {
      candidateScenes.push(targetScene);
    }
  }

  for (const scene of candidateScenes) {
    const entity = resolveTransportSceneEntity(scene, numericID);
    if (!entity) {
      continue;
    }
    if (entity.stationID) {
      return {
        kind: "station",
        stationID: numericID,
        label:
          entity.stationName ||
          `station ${numericID}`,
      };
    }
    return buildTransportPointAnchor(entity, scene.systemID);
  }

  const staticAnchor = findStaticTransportAnchorByID(numericID);
  if (staticAnchor) {
    return staticAnchor;
  }

  return null;
}

function resolveStoredItemTransportAnchor(item) {
  const spaceState = item && item.spaceState;
  const systemID = normalizePositiveInteger(
    spaceState && (spaceState.systemID || item.locationID),
  );
  if (!systemID || !spaceState || !spaceState.position) {
    return null;
  }

  return buildTransportPointAnchor(
    {
      ...spaceState,
      itemID: item.itemID,
      name: item.itemName,
      systemID,
    },
    systemID,
  );
}

function resolveKnownTransportLocationID(session, targetDescriptor, numericID) {
  const storedDestination = resolveStoredTransportDestination(numericID, {
    resolveWorldLocation: (locationID) =>
      resolveWorldTransportLocationID(session, targetDescriptor, locationID),
    findItemById: itemStore.findItemById,
    resolveItemAnchor: resolveStoredItemTransportAnchor,
  });
  if (storedDestination) {
    return storedDestination;
  }

  return resolveAgentTransportDestination(numericID);
}

function parseTransportBookmarkID(token) {
  const match = String(token || "")
    .trim()
    .match(/^(?:bookmark|bm)[:=](\d+)$/i);
  return match ? normalizePositiveInteger(match[1]) : 0;
}

function resolveTransportLocationToken(session, targetDescriptor, token) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) {
    return null;
  }

  if (normalizedToken.toLowerCase() === "me") {
    const anchor = getSessionTransportAnchor(session);
    return anchor
      ? {
          ...anchor,
          label: "me",
        }
      : null;
  }

  const explicitBookmarkID = parseTransportBookmarkID(normalizedToken);
  if (explicitBookmarkID) {
    return resolveTransportBookmarkDestination(
      session,
      targetDescriptor,
      explicitBookmarkID,
    );
  }

  const numericID = normalizePositiveInteger(normalizedToken);
  if (!numericID) {
    return null;
  }

  return (
    resolveKnownTransportLocationID(session, targetDescriptor, numericID) ||
    resolveTransportBookmarkDestination(
      session,
      targetDescriptor,
      numericID,
    )
  );
}

function withTransportOffset(destination, offsetVector) {
  if (
    !destination ||
    !destination.point ||
    (destination.kind !== "point" && destination.kind !== "structure")
  ) {
    return null;
  }

  return {
    ...destination,
    kind: "point",
    point: addVectors(destination.point, offsetVector),
  };
}

function formatTransportTargetLabel(targetDescriptor) {
  if (!targetDescriptor) {
    return "target";
  }

  if (targetDescriptor.kind === "session") {
    const targetSession = targetDescriptor.session;
    if (targetDescriptor.label === "me") {
      return "me";
    }
    return (
      (targetSession && targetSession.characterName) ||
      targetDescriptor.label ||
      `character ${targetSession && targetSession.characterID || "?"}`
    );
  }

  return targetDescriptor.label || "entity";
}

function formatTransportDestinationLabel(destination) {
  if (!destination) {
    return "destination";
  }

  if (destination.kind === "point") {
    if (destination.label) {
      return destination.label;
    }
    const point = destination.point || { x: 0, y: 0, z: 0 };
    return `(${point.x}, ${point.y}, ${point.z})`;
  }

  return destination.label || destination.kind;
}

function formatTransportTransitionError(result, fallback) {
  const errorMsg = result && result.errorMsg;
  if (errorMsg === "SHIP_NOT_FOUND") {
    return "Active ship not found for this character.";
  }
  if (errorMsg === "CHARACTER_NOT_SELECTED") {
    return "Select a character before using /tr.";
  }
  if (errorMsg === "SOLAR_SYSTEM_NOT_FOUND") {
    return "Solar-system transport target was not found.";
  }
  if (errorMsg === "STATION_NOT_FOUND") {
    return "Station transport target was not found.";
  }
  if (errorMsg === "SOLAR_JUMP_IN_PROGRESS" || errorMsg === "STATION_JUMP_IN_PROGRESS") {
    return "A transport is already in progress for this character.";
  }
  return fallback;
}

function buildTransportDestinationFromSession(session) {
  if (!session || !session.characterID) {
    return null;
  }

  const anchor = getSessionTransportAnchor(session);
  if (anchor) {
    return anchor;
  }

  const solarSystemID = getSessionCurrentSolarSystemID(session);
  if (!solarSystemID) {
    return null;
  }

  const solarSystem = worldData.getSolarSystemByID(solarSystemID);
  return {
    kind: "solarSystem",
    solarSystemID,
    label:
      (solarSystem && solarSystem.solarSystemName) ||
      `solar system ${solarSystemID}`,
  };
}

function executeSessionTransportTarget(
  requestSession,
  targetDescriptor,
  destination,
  chatHub,
  options,
) {
  const targetLabel = formatTransportTargetLabel(targetDescriptor);
  const destinationLabel = formatTransportDestinationLabel(destination);
  const targetSession = targetDescriptor && targetDescriptor.session;
  if (!targetSession || !targetSession.characterID) {
    return handledResult(
      chatHub,
      requestSession,
      options,
      "Transport target session is not available.",
    );
  }

  let crossedLocationBoundary = false;

  if (destination.kind === "solarSystem") {
    const result = jumpSessionToSolarSystem(
      targetSession,
      destination.solarSystemID,
      // A GM transport is not a jump the pilot made.
      { countsTowardJumpGoal: false },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        requestSession,
        options,
        formatTransportTransitionError(
          result,
          `Failed to transport ${targetLabel} to ${destinationLabel}.`,
        ),
      );
    }
    crossedLocationBoundary = true;
  } else if (destination.kind === "station") {
    const result = jumpSessionToStation(
      targetSession,
      destination.stationID,
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        requestSession,
        options,
        formatTransportTransitionError(
          result,
          `Failed to transport ${targetLabel} to ${destinationLabel}.`,
        ),
      );
    }
    crossedLocationBoundary = true;
  } else if (destination.kind === "structure") {
    const result = jumpSessionToDockableLocation(
      targetSession,
      destination.structureID,
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        requestSession,
        options,
        formatTransportTransitionError(
          result,
          `Failed to transport ${targetLabel} to ${destinationLabel}.`,
        ),
      );
    }
    crossedLocationBoundary = true;
  } else if (destination.kind === "point") {
    const destinationSystemID = normalizePositiveInteger(destination.systemID);
    if (!destinationSystemID || !destination.point) {
      return handledResult(
        chatHub,
        requestSession,
        options,
        "Point transport is missing a valid solar-system location.",
      );
    }

    const currentTargetSystemID = getSessionCurrentSolarSystemID(targetSession);
    const currentTargetStationID = getSessionDockedStationID(targetSession);
    if (
      currentTargetStationID ||
      !targetSession._space ||
      currentTargetSystemID !== destinationSystemID
    ) {
      const jumpResult = jumpSessionToSolarSystem(
        targetSession,
        destinationSystemID,
        // A GM transport is not a jump the pilot made.
        { countsTowardJumpGoal: false },
      );
      if (!jumpResult.success) {
        return handledResult(
          chatHub,
          requestSession,
          options,
          formatTransportTransitionError(
            jumpResult,
            `Failed to transport ${targetLabel} to ${destinationLabel}.`,
          ),
        );
      }
      crossedLocationBoundary = true;
    }

    const teleportResult = spaceRuntime.teleportSessionShipToPoint(
      targetSession,
      destination.point,
      {
        direction: destination.direction,
        refreshOwnerSession: true,
      },
    );
    if (!teleportResult.success) {
      return handledResult(
        chatHub,
        requestSession,
        options,
        teleportResult.errorMsg === "NOT_IN_SPACE"
          ? `Failed to transport ${targetLabel}: target is not in space.`
          : `Failed to teleport ${targetLabel} in space.`,
      );
    }
  } else {
    return handledResult(
      chatHub,
      requestSession,
      options,
      `Unsupported /tr destination: ${destination.kind}.`,
    );
  }

  if (targetSession === requestSession && crossedLocationBoundary) {
    if (destination.kind !== "station" && destination.kind !== "structure") {
      const destinationSystemID =
        destination.kind === "solarSystem"
          ? destination.solarSystemID
          : destination.kind === "point"
            ? destination.systemID
            : normalizePositiveInteger(
              (worldData.getStationByID(destination.stationID) || {}).solarSystemID,
            );
      const destinationSystem = worldData.getSolarSystemByID(destinationSystemID);
      reconcileSolarTargetSessionIdentity(requestSession, destinationSystem);
    }
    flushPendingLocalChannelSync(chatHub, requestSession);
    return handledResult(
      chatHub,
      requestSession,
      getPostLocalMoveFeedbackOptions(options),
      `Transported ${targetLabel} to ${destinationLabel}.`,
    );
  }

  return handledResult(
    chatHub,
    requestSession,
    options,
    `Transported ${targetLabel} to ${destinationLabel}.`,
  );
}

function reconcileSolarTargetSessionIdentity(session, solarSystem) {
  if (
    !session ||
    !solarSystem ||
    typeof session.sendSessionChange !== "function"
  ) {
    return false;
  }

  const targetSolarSystemID =
    normalizePositiveInteger(solarSystem.solarSystemID) || null;
  const targetConstellationID =
    normalizePositiveInteger(solarSystem.constellationID) || null;
  const targetRegionID =
    normalizePositiveInteger(solarSystem.regionID) || null;

  if (!targetSolarSystemID) {
    return false;
  }

  const sessionChanges = {};
  const applyChange = (key, nextValue, aliases) => {
    const previousValue = normalizePositiveInteger(
      aliases.map((alias) => session[alias]).find((value) => value !== undefined),
    );
    const normalizedNextValue = normalizePositiveInteger(nextValue);
    if (previousValue === normalizedNextValue) {
      return;
    }

    for (const alias of aliases) {
      session[alias] = normalizedNextValue;
    }
    sessionChanges[key] = [previousValue, normalizedNextValue];
  };

  applyChange("solarsystemid2", targetSolarSystemID, ["solarsystemid2"]);
  applyChange("solarsystemid", targetSolarSystemID, ["solarsystemid"]);
  applyChange("locationid", targetSolarSystemID, ["locationid"]);

  if (targetConstellationID) {
    applyChange("constellationid", targetConstellationID, [
      "constellationid",
      "constellationID",
    ]);
  }

  if (targetRegionID) {
    applyChange("regionid", targetRegionID, [
      "regionid",
      "regionID",
    ]);
  }

  if (Object.keys(sessionChanges).length === 0) {
    return false;
  }

  session.sendSessionChange(sessionChanges);
  return true;
}

function handleSolarTeleport(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /solar.",
    );
  }

  if (!argumentText) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /solar <system name>",
    );
  }

  const lookup = resolveSolarSystemByName(argumentText);
  if (!lookup.success) {
    const message =
      lookup.errorMsg === "SOLAR_SYSTEM_NOT_FOUND"
        ? `Solar system not found: ${argumentText}.${formatSuggestions(lookup.suggestions)}`
        : `Solar system name is ambiguous: ${argumentText}.${formatSuggestions(lookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  const abortResult =
    AbyssalMgrService &&
    typeof AbyssalMgrService.abortAbyssalRunForAdministrativeTransition === "function"
      ? AbyssalMgrService.abortAbyssalRunForAdministrativeTransition(
        session,
        `staff-solar:${lookup.match.solarSystemID}`,
      )
      : null;
  if (abortResult && abortResult.success === false) {
    return handledResult(
      chatHub,
      session,
      options,
      `Solar-system jump failed: active Abyssal run could not be aborted (${abortResult.errorMsg || "UNKNOWN_ERROR"}).`,
    );
  }

  // A GM jump command is not a jump the pilot made.
  const result = jumpSessionToSolarSystem(session, lookup.match.solarSystemID, {
    countsTowardJumpGoal: false,
  });
  if (!result.success) {
    let message = "Solar-system jump failed.";
    if (result.errorMsg === "SHIP_NOT_FOUND") {
      message = "Active ship not found for this character.";
    } else if (result.errorMsg === "CHARACTER_NOT_SELECTED") {
      message = "Select a character before using /solar.";
    } else if (result.errorMsg === "SOLAR_SYSTEM_NOT_FOUND") {
      message = `Solar system not found: ${lookup.match.solarSystemName}.`;
    } else if (result.errorMsg === "SOLAR_JUMP_IN_PROGRESS") {
      message = "A solar-system jump is already in progress for this character.";
    }

    return handledResult(chatHub, session, options, message);
  }

  const spawnState = result.data && result.data.spawnState;
  const targetSolarSystem =
    (result.data && result.data.solarSystem) ||
    worldData.getSolarSystemByID(lookup.match.solarSystemID);
  const anchorText = spawnState
    ? ` near ${spawnState.anchorType} ${spawnState.anchorName}`
    : "";

  // The transition path should already send the correct full location identity.
  // Keep a command-side backstop here so /solar does not depend exclusively on
  // later session hydration if region/constellation drift again.
  reconcileSolarTargetSessionIdentity(session, targetSolarSystem);

  // Move Local before emitting feedback so slash responses do not land in the
  // new system while the client is still joined to the previous room.
  flushPendingLocalChannelSync(chatHub, session);

  return handledResult(
    chatHub,
    session,
    getPostLocalMoveFeedbackOptions(options),
    `Teleported to ${lookup.match.solarSystemName} (${lookup.match.solarSystemID})${anchorText}.`,
  );
}

function handleTransportCommand(session, argumentText, chatHub, options) {
  const usage = "Usage: /tr <me|characterID|entityID> <destination|bookmark=bookmarkID|pos=x,y,z|offset=x,y,z>";
  const tokens = String(argumentText || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) {
    return handledResult(chatHub, session, options, usage);
  }

  const targetResult = resolveTransportTargetDescriptor(session, tokens[0]);
  if (!targetResult.success) {
    const message =
      targetResult.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /tr."
        : targetResult.errorMsg === "TARGET_NOT_FOUND"
          ? `Transport target not found: ${tokens[0]}.`
          : usage;
    return handledResult(chatHub, session, options, message);
  }

  const targetDescriptor = targetResult.data;
  const destinationTokens = tokens
    .slice(1)
    .filter((token) => String(token || "").trim().toLowerCase() !== "noblock");
  if (destinationTokens.length === 0) {
    return handledResult(chatHub, session, options, usage);
  }

  let destination = null;
  const directPos = parseTransportVectorTag(destinationTokens[0], "pos");
  const directOffset = parseTransportVectorTag(destinationTokens[0], "offset");
  if (directPos) {
    if (destinationTokens.length !== 1) {
      return handledResult(chatHub, session, options, usage);
    }
    const pointContext = resolveTransportPointContext(session, targetDescriptor);
    if (!pointContext || !pointContext.systemID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Could not resolve a solar-system context for /tr pos=...",
      );
    }
    destination = {
      kind: "point",
      systemID: pointContext.systemID,
      point: directPos,
      direction: cloneSpaceVector(
        pointContext.direction,
        { x: 1, y: 0, z: 0 },
      ),
    };
  } else if (directOffset) {
    if (destinationTokens.length !== 1) {
      return handledResult(chatHub, session, options, usage);
    }
    const anchor =
      targetDescriptor.kind === "session"
        ? getSessionTransportAnchor(targetDescriptor.session)
        : buildTransportPointAnchor(
          targetDescriptor.entity,
          targetDescriptor.systemID,
        );
    destination = withTransportOffset(anchor, directOffset);
    if (!destination) {
      return handledResult(
        chatHub,
        session,
        options,
        "Could not apply /tr offset=... because the target has no in-space anchor.",
      );
    }
  } else {
    const coordinateTriplet = parseTransportCoordinateTriplet(destinationTokens);
    if (coordinateTriplet) {
      const pointContext = resolveTransportPointContext(session, targetDescriptor);
      if (!pointContext || !pointContext.systemID) {
        return handledResult(
          chatHub,
          session,
          options,
          "Could not resolve a solar-system context for raw /tr coordinates.",
        );
      }
      destination = {
        kind: "point",
        systemID: pointContext.systemID,
        point: coordinateTriplet,
        direction: cloneSpaceVector(
          pointContext.direction,
          { x: 1, y: 0, z: 0 },
        ),
      };
    } else {
      const offsetToken = parseTransportVectorTag(
        destinationTokens[destinationTokens.length - 1],
        "offset",
      );
      const baseTokens = offsetToken
        ? destinationTokens.slice(0, -1)
        : destinationTokens;
      if (baseTokens.length !== 1) {
        return handledResult(chatHub, session, options, usage);
      }

      const baseDestination = resolveTransportLocationToken(
        session,
        targetDescriptor,
        baseTokens[0],
      );
      if (!baseDestination) {
        return handledResult(
          chatHub,
          session,
          options,
          `Transport destination not found: ${baseTokens[0]}.`,
        );
      }

      if (offsetToken) {
        destination = withTransportOffset(baseDestination, offsetToken);
        if (!destination) {
          return handledResult(
            chatHub,
            session,
            options,
            "Could not apply /tr offset=... to that destination.",
          );
        }
      } else {
        destination = baseDestination;
      }
    }
  }

  const targetLabel = formatTransportTargetLabel(targetDescriptor);
  const destinationLabel = formatTransportDestinationLabel(destination);

  if (targetDescriptor.kind === "session") {
    return executeSessionTransportTarget(
      session,
      targetDescriptor,
      destination,
      chatHub,
      options,
    );
  }

  if (destination.kind !== "point" || !destination.point) {
    return handledResult(
      chatHub,
      session,
      options,
      "Runtime entity /tr currently supports only in-space point moves.",
    );
  }

  if (
    normalizePositiveInteger(destination.systemID) !==
    normalizePositiveInteger(targetDescriptor.systemID)
  ) {
    return handledResult(
      chatHub,
      session,
      options,
      "Runtime entities can only be moved within their current solar system.",
    );
  }

  const entityMoveResult = targetDescriptor.scene.teleportDynamicEntityToPoint(
    targetDescriptor.entity,
    destination.point,
    {
      direction: destination.direction,
      refreshOwnerSession: false,
    },
  );
  if (!entityMoveResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Failed to transport ${targetLabel}.`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Transported ${targetLabel} to ${destinationLabel}.`,
  );
}

function handleFetchCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!require("./commandAccess").hasStaffDebugRole(session)) return reply("/fetch requires a staff/admin role.");
  const target = String(argumentText || "").trim();
  const itemID = /^\d+$/.test(target) ? Number(target) : 0;
  const scene = spaceRuntime.getSceneForSession(session);
  if (!Number.isSafeInteger(itemID) || itemID <= 0 || !scene || !scene.dynamicEntities.has(itemID)) {
    return reply("Usage: /fetch <local dynamic entityID> (enter space first)");
  }
  // svc_gridutils.py fetches cans and wrecks to the caller before looting.
  return handleTransportCommand(session, `${itemID} me`, chatHub, options);
}

function handleTeleCommand(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /tele.",
    );
  }

  const targetToken = String(argumentText || "").trim();
  if (!targetToken) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /tele <character name|characterID>",
    );
  }

  const targetResult = resolveCharacterTargetDescriptor(session, targetToken);
  if (!targetResult.success || !targetResult.data) {
    return handledResult(
      chatHub,
      session,
      options,
      targetResult.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /tele."
        : `Character not found: ${targetToken}.`,
    );
  }

  const targetDescriptor = targetResult.data;
  if (!targetDescriptor.session || !targetDescriptor.session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      `${formatCharacterTargetLabel(targetDescriptor)} is not currently connected.`,
    );
  }

  const destination = buildTransportDestinationFromSession(targetDescriptor.session);
  if (!destination) {
    return handledResult(
      chatHub,
      session,
      options,
      `Could not resolve a live location for ${formatCharacterTargetLabel(targetDescriptor)}.`,
    );
  }

  return executeSessionTransportTarget(
    session,
    {
      kind: "session",
      session,
      label: "me",
    },
    destination,
    chatHub,
    options,
  );
}

function handleHomeDock(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /dock.",
    );
  }

  const homeStationID = Number(
    session.homeStationID ||
    session.homestationid ||
    session.cloneStationID ||
    session.clonestationid ||
    0,
  ) || 0;

  if (!homeStationID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Home station is not set for this character.",
    );
  }

  if (
    Number(session.stationid || session.stationID || 0) === homeStationID
  ) {
    return handledResult(
      chatHub,
      session,
      options,
      `Already docked at home station ${homeStationID}.`,
    );
  }

  const result = jumpSessionToStation(session, homeStationID);
  if (!result.success) {
    let message = "Dock command failed.";
    if (result.errorMsg === "SHIP_NOT_FOUND") {
      message = "Active ship not found for this character.";
    } else if (result.errorMsg === "CHARACTER_NOT_SELECTED") {
      message = "Select a character before using /dock.";
    } else if (result.errorMsg === "STATION_NOT_FOUND") {
      message = `Home station not found: ${homeStationID}.`;
    } else if (result.errorMsg === "STATION_JUMP_IN_PROGRESS") {
      message = "A dock transition is already in progress for this character.";
    }

    return handledResult(chatHub, session, options, message);
  }

  const station = result.data && result.data.station;
  flushPendingLocalChannelSync(chatHub, session);
  return handledResult(
    chatHub,
    session,
    getPostLocalMoveFeedbackOptions(options),
    `Docked at ${station ? station.stationName : `station ${homeStationID}`}.`,
  );
}

function formatDistanceAu(distanceMeters) {
  return (Number(distanceMeters || 0) / ONE_AU_IN_METERS).toFixed(1);
}

function handleDeadwarpCommand(session, argumentText, chatHub, options) {
  if (String(argumentText || "").trim()) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /deadwarp",
    );
  }
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /deadwarp.",
    );
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const shipEntity = resolveSessionShipEntity(session);
  if (!scene || !shipEntity) {
    return handledResult(
      chatHub,
      session,
      options,
      "Active ship was not found in space.",
    );
  }

  const originAnchor = findSafeWarpOriginAnchor(scene, shipEntity, {
    clearanceMeters: ONE_AU_IN_METERS,
    minDistanceMeters: ONE_AU_IN_METERS * 2,
    maxDistanceMeters: ONE_AU_IN_METERS * 4,
    stepMeters: ONE_AU_IN_METERS / 2,
  });

  const warpRequestResult = scene.warpToPoint(session, originAnchor.position, {
    ignoreCrimewatchCheck: true,
  });
  if (!warpRequestResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Deadwarp failed: ${warpRequestResult.errorMsg || "WARP_REQUEST_FAILED"}.`,
    );
  }

  const activationResult = scene.forceStartPendingWarp(shipEntity, {
    nowMs: scene.getCurrentSimTimeMs(),
  });
  if (!activationResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Deadwarp failed: ${activationResult.errorMsg || "WARP_ACTIVATION_FAILED"}.`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Deadwarp started to a safe point ${formatDistanceAu(originAnchor.distanceMeters)} AU away.`,
  );
}

module.exports = {
  handleSolarTeleport,
  handleTransportCommand,
  handleFetchCommand,
  handleTeleCommand,
  handleHomeDock,
  handleDeadwarpCommand,
};
