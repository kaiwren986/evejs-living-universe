"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Client environment metadata, ordered notification delivery and bounded retries.
// Sessions and the injected pending-work registry own all retained state.
function recordAbyssalEnvironmentSequenceEvent({
  getDependencies,
  cloneValue,
  log,
},
  pocketState,
  session,
  roomIndex,
  event,
  deps = getDependencies(),
  details = {},
) {
  const runID = toInt(
    pocketState && pocketState.instanceID,
    toInt(session && session.abyssalInstanceID, 0),
  );
  if (!session || runID <= 0) {
    return null;
  }
  const existing =
    session.abyssalEnvironmentSequence &&
    typeof session.abyssalEnvironmentSequence === "object" &&
    toInt(session.abyssalEnvironmentSequence.runID, 0) === runID
      ? session.abyssalEnvironmentSequence
      : { runID, nextStep: 1, nextStepByRoom: {}, events: [] };
  const numericRoomIndex = toInt(roomIndex, 0);
  const nextStepByRoom =
    existing.nextStepByRoom && typeof existing.nextStepByRoom === "object"
      ? existing.nextStepByRoom
      : {};
  const step = Math.max(1, toInt(nextStepByRoom[numericRoomIndex], 1));
  const entry = {
    runID,
    roomIndex: numericRoomIndex,
    step,
    event: normalizeText(event, "unknown"),
    timestamp: toInt(deps && deps.now && deps.now(), Date.now()),
    ...cloneValue(details),
  };
  session.abyssalEnvironmentSequence = {
    runID,
    nextStep: Math.max(1, toInt(existing.nextStep, 1)) + 1,
    nextStepByRoom: {
      ...cloneValue(nextStepByRoom),
      [numericRoomIndex]: step + 1,
    },
    events: [
      ...(Array.isArray(existing.events) ? existing.events : []),
      entry,
    ],
  };
  log.info(
    `[AbyssalEnvironmentSequence] run=${runID} instance=${runID} room=${entry.roomIndex} ` +
      `step=${step} event=${entry.event} timestamp=${entry.timestamp}`,
  );
  return entry;
}

function buildAbyssalClientEnvironmentSelection({
  getDependencies,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getContentProfile,
  resolveAbyssalEnvironmentRoomProfileForPocket,
  buildAbyssalSceneDescriptor,
  usesIsolatedAbyssalScene,
  getAbyssalContentID,
  describeAbyssalEnvironmentSource,
  normalizeLowerText,
  getResolvedWeatherState,
  getObjectPosition,
  resolveRoomOriginPosition,
},
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = clampRoomIndex(
    toInt(options.roomIndex, toInt(roomState && roomState.currentRoomIndex, 0)),
    roomState.implementedRooms,
  );
  const contentProfile = getContentProfile(pocketState) || {};
  const profile = resolveAbyssalEnvironmentRoomProfileForPocket(pocketState, roomIndex);
  const descriptor = buildAbyssalSceneDescriptor(pocketState, deps);
  const expectedSceneKey = normalizeText(descriptor && descriptor.sceneKey, "");
  const sessionSceneKey = normalizeText(
    session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
    "",
  );
  if (
    !usesIsolatedAbyssalScene(pocketState, deps) ||
    !profile ||
    !expectedSceneKey ||
    sessionSceneKey !== expectedSceneKey
  ) {
    return null;
  }
  return {
    runID: toInt(pocketState && pocketState.instanceID, 0),
    contentID: getAbyssalContentID(pocketState),
    sceneKey: expectedSceneKey,
    locationID: toInt(descriptor && descriptor.locationID, 0),
    roomIndex,
    difficultyTier: toInt(contentProfile.tier, 0),
    abyssalLocationID: roomIndex,
    nebulaGraphicID: toInt(profile.nebulaGraphicID, 0),
    profileID: normalizeText(profile.profileID, ""),
    variant: normalizeText(profile.layoutVariant, ""),
    environmentSource: describeAbyssalEnvironmentSource(profile),
    weatherType: normalizeLowerText(profile.weatherType, contentProfile.weatherType),
    resolvedMechanicalWeatherID: toInt(
      getResolvedWeatherState(pocketState) && getResolvedWeatherState(pocketState).weatherTypeID,
      0,
    ),
    resolvedVisualWeatherID: toInt(profile.weatherObjectTypeID, 0),
    sceneCubeResource: normalizeText(profile.sceneCubeResource, ""),
    cloudResource: normalizeText(profile.volumetricCloudResource, ""),
    volumetricCloudDungeonID: toInt(profile.volumetricCloudDungeonID, 0),
    volumetricCloudObjectTypeID: toInt(profile.volumetricCloudObjectTypeID, 0),
    volumetricCloudDunObjectID: toInt(profile.volumetricCloudDunObjectID, 0),
    dungeonRoomID: toInt(profile.dungeonRoomID, 0),
    roomOrigin: getObjectPosition(resolveRoomOriginPosition(pocketState, roomIndex)),
    nearFieldResource: normalizeText(profile.nearFieldResource, ""),
    lensFlareResource: normalizeText(profile.lensFlareResource, ""),
    gradientResource: normalizeText(profile.gradientResource, "") || null,
    weatherObjectTypeID: toInt(profile.weatherObjectTypeID, 0),
    selectedAtMs: toInt(deps.now(), 0),
    notificationSentAtMs: 0,
    notification: "OnEnteringDungeonRoom",
    notificationSent: false,
    clientApplication: "UNVERIFIED",
    blockReason: "",
    recipientCount: 0,
  };
}

function buildAbyssalDungeonRoomNotificationPayload({}, selection) {
  const origin = selection && selection.roomOrigin;
  return [
    toInt(selection && selection.volumetricCloudDungeonID, 0),
    toInt(selection && selection.dungeonRoomID, 0),
    {
      type: "tuple",
      items: [
        { type: "real", value: Number(origin && origin.x) || 0 },
        { type: "real", value: Number(origin && origin.y) || 0 },
        { type: "real", value: Number(origin && origin.z) || 0 },
      ],
    },
    null,
    null,
  ];
}

function buildAbyssalLocationEnteredNotificationPayload({
  buildDict,
}, selection) {
  return [buildDict([
    ["difficulty_tier", toInt(selection && selection.difficultyTier, 0)],
    ["content_id", normalizeText(
      selection && selection.contentID,
      String(toInt(selection && selection.runID, 0)),
    )],
    ["location_id", toInt(selection && selection.abyssalLocationID, 0)],
    ["nebula_graphic_id", toInt(selection && selection.nebulaGraphicID, 0)],
  ])];
}

function getAbyssalClientEnvironmentPrerequisites({
  getDependencies,
  listAbyssalRoomBootstrapEntityIDs,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  isAbyssalHostLocationID,
},
  pocketState,
  session,
  selection,
  deps = getDependencies(),
  options = {},
) {
  const runtime = deps;
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  const sessionSceneKey = normalizeText(
    session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
    "",
  );
  const expectedSceneKey = normalizeText(selection && selection.sceneKey, "");
  const ego = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid), toInt(pocketState && pocketState.shipID, 0)),
  );
  const egoEntity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(ego)
    : null;
  const activeShipID = toInt(
    pocketState && pocketState.shipID,
    toInt(session && (session.shipID || session.shipid), 0),
  );
  const roomEntityIDs = listAbyssalRoomBootstrapEntityIDs(
    pocketState,
    toInt(selection && selection.roomIndex, 0),
  );
  const roomEntry = getPlaceholderRoomEntry(
    pocketState,
    toInt(selection && selection.roomIndex, 0),
  );
  const requiredRoomEntityIDs = listUniquePositiveInts([
    roomEntry && roomEntry.originMarkerItemID,
    roomEntry && roomEntry.conduitItemID,
    ...listUniquePositiveInts(roomEntry && roomEntry.hostileEntityIDs),
  ]);
  const missingRoomEntityIDs =
    scene && typeof scene.getEntityByID === "function"
      ? roomEntityIDs.filter((entityID) => !scene.getEntityByID(entityID))
      : [...roomEntityIDs];
  const missingRequiredSceneEntityIDs =
    scene && typeof scene.getEntityByID === "function"
      ? requiredRoomEntityIDs.filter((entityID) => !scene.getEntityByID(entityID))
      : [...requiredRoomEntityIDs];
  const visibleEntities =
    scene && typeof scene.getVisibleEntitiesForSession === "function"
      ? scene.getVisibleEntitiesForSession(session)
      : (
        scene && typeof scene.getEntityByID === "function"
          ? roomEntityIDs.map((entityID) => scene.getEntityByID(entityID)).filter(Boolean)
          : []
      );
  const visibleEntityIDs = new Set(
    (Array.isArray(visibleEntities) ? visibleEntities : [])
      .map((entity) => toInt(entity && entity.itemID, 0))
      .filter((entityID) => entityID > 0),
  );
  const visibleRoomEntityCount = roomEntityIDs.filter((entityID) =>
    visibleEntityIDs.has(entityID)
  ).length;
  const missingRequiredRoomEntityIDs = requiredRoomEntityIDs.filter((entityID) =>
    !visibleEntityIDs.has(entityID)
  );
  const deliveredEntityIDs = listUniquePositiveInts(options && options.deliveredEntityIDs);
  const deliveredEntityIDSet = new Set(deliveredEntityIDs);
  const hasDeliveryEvidence = Array.isArray(options && options.deliveredEntityIDs);
  const allowPreDeliveryTransitionNotification =
    options && options.allowPreDeliveryTransitionNotification === true;
  const missingRequiredDeliveryEntityIDs = hasDeliveryEvidence
    ? requiredRoomEntityIDs.filter((entityID) => !deliveredEntityIDSet.has(entityID))
    : [];
  const system = scene && scene.system
    ? scene.system
    : (
      deps && deps.worldData && typeof deps.worldData.getSolarSystemByID === "function"
        ? deps.worldData.getSolarSystemByID(toInt(session && session.locationid, 0))
        : null
    );
  const sessionLocation = toInt(session && session.locationid, 0);
  const sessionSolarSystem = toInt(session && session.solarsystemid, 0);
  const sessionSolarSystem2 = toInt(session && session.solarsystemid2, 0);
  const expectedLocationID = toInt(selection && selection.locationID, 0);
  const systemLocationID = toInt(system && system.solarSystemID, 0);
  return {
    scene,
    sceneAttached: Boolean(
      scene &&
      expectedSceneKey &&
      sessionSceneKey === expectedSceneKey &&
      normalizeText(scene.sceneKey, expectedSceneKey) === expectedSceneKey
    ),
    setStateDelivered: Boolean(session && session._space && session._space.initialStateSent === true),
    ego,
    egoValid: Boolean(scene && ego > 0 && egoEntity),
    activeShipID,
    egoMatchesActiveShip: Boolean(ego > 0 && activeShipID > 0 && ego === activeShipID),
    roomEntitiesReady: Boolean(roomEntityIDs.length > 0 && missingRoomEntityIDs.length === 0),
    roomSetStateEvidenceValid: Boolean(
      requiredRoomEntityIDs.length > 0 &&
      (
        hasDeliveryEvidence
          ? missingRequiredDeliveryEntityIDs.length === 0
          : allowPreDeliveryTransitionNotification
            ? missingRequiredSceneEntityIDs.length === 0
            : missingRequiredRoomEntityIDs.length === 0
      )
    ),
    hasDeliveryEvidence,
    preDeliveryTransition: allowPreDeliveryTransitionNotification,
    deliveredEntityIDs,
    missingRequiredDeliveryEntityIDs,
    roomEntityCount: roomEntityIDs.length,
    requiredRoomEntityCount: requiredRoomEntityIDs.length,
    visibleSlimCount: visibleEntityIDs.size,
    visibleRoomEntityCount,
    missingRoomEntityIDs,
    missingRequiredSceneEntityIDs,
    missingRequiredRoomEntityIDs,
    hostLocationValid: expectedLocationID > 0 && isAbyssalHostLocationID(expectedLocationID),
    locationIdentityValid: Boolean(
      expectedLocationID > 0 &&
      sessionLocation === expectedLocationID &&
      sessionSolarSystem === expectedLocationID &&
      sessionSolarSystem2 === expectedLocationID &&
      systemLocationID === expectedLocationID
    ),
    solItemValid: Boolean(system && systemLocationID === expectedLocationID),
    sessionLocation,
    sessionSolarSystem,
    sessionSolarSystem2,
    sceneKey: sessionSceneKey,
    solItemTypeID: system ? 5 : 0,
    solItemGroupID: system ? 5 : 0,
    solItemCategoryID: system ? 2 : 0,
  };
}

function listAbyssalClientEnvironmentPrerequisiteBlockers({}, prerequisites) {
  return [
    ["setStateDelivered", prerequisites && prerequisites.setStateDelivered],
    ["egoValid", prerequisites && prerequisites.egoValid],
    ["roomSetStateEvidenceValid", prerequisites && prerequisites.roomSetStateEvidenceValid],
    ["sceneAttached", prerequisites && prerequisites.sceneAttached],
    ["hostLocationValid", prerequisites && prerequisites.hostLocationValid],
    ["locationIdentityValid", prerequisites && prerequisites.locationIdentityValid],
    ["solItemValid", prerequisites && prerequisites.solItemValid],
  ]
    .filter(([, ready]) => ready !== true)
    .map(([name]) => name);
}

function logAbyssalClientEnvironmentPrerequisiteFailure({
  listAbyssalClientEnvironmentPrerequisiteBlockers,
  log,
},
  selection,
  prerequisites,
  phase,
  reason,
) {
  const blockers = listAbyssalClientEnvironmentPrerequisiteBlockers(prerequisites);
  log.info(
    `[AbyssalClientEnvironmentPrerequisites] phase=${normalizeText(phase, "entry")} ` +
      `instance=${toInt(selection && selection.runID, 0)} ` +
      `room=${toInt(selection && selection.roomIndex, 0)} ` +
      `ready=false blockers=${blockers.join(",") || "none"} ` +
      `setStateDelivered=${prerequisites.setStateDelivered} ego=${prerequisites.ego} ` +
      `egoValid=${prerequisites.egoValid} activeShipID=${prerequisites.activeShipID} ` +
      `egoMatchesActiveShip=${prerequisites.egoMatchesActiveShip} ` +
      `visibleSlimCount=${prerequisites.visibleSlimCount} ` +
      `visibleRoomEntityCount=${prerequisites.visibleRoomEntityCount} ` +
      `roomEntityCount=${prerequisites.roomEntityCount} ` +
      `requiredRoomEntityCount=${prerequisites.requiredRoomEntityCount} ` +
      `roomEntitiesReady=${prerequisites.roomEntitiesReady} ` +
      `missingRoomEntityIDs=${prerequisites.missingRoomEntityIDs.join(",") || "none"} ` +
      `missingRequiredRoomEntityIDs=${prerequisites.missingRequiredRoomEntityIDs.join(",") || "none"} ` +
      `hasDeliveryEvidence=${prerequisites.hasDeliveryEvidence} ` +
      `missingRequiredDeliveryEntityIDs=${prerequisites.missingRequiredDeliveryEntityIDs.join(",") || "none"} ` +
      `sceneAttached=${prerequisites.sceneAttached} ` +
      `hostLocationValid=${prerequisites.hostLocationValid} ` +
      `locationIdentityValid=${prerequisites.locationIdentityValid} ` +
      `solItemValid=${prerequisites.solItemValid} ` +
      `sessionLocation=${prerequisites.sessionLocation} ` +
      `sessionSolarSystem=${prerequisites.sessionSolarSystem} ` +
      `sessionSolarSystem2=${prerequisites.sessionSolarSystem2} ` +
      `sceneKey=${prerequisites.sceneKey || "none"} ` +
      `reason=${normalizeText(reason, "ENVIRONMENT_PREREQUISITES_NOT_READY")}`,
  );
}

function getAbyssalEnvironmentNotificationState({
  cloneValue,
  listUniquePositiveInts,
}, session, runID) {
  const existing =
    session &&
    session.abyssalDungeonNotificationState &&
    typeof session.abyssalDungeonNotificationState === "object" &&
    toInt(session.abyssalDungeonNotificationState.runID, 0) === runID
      ? cloneValue(session.abyssalDungeonNotificationState)
      : {};
  return {
    ...existing,
    runID,
    exitedDungeonIDs: listUniquePositiveInts(existing.exitedDungeonIDs),
    enteredAbyssalLocationIDs: listUniquePositiveInts(existing.enteredAbyssalLocationIDs),
    exitedAbyssalLocationIDs: listUniquePositiveInts(existing.exitedAbyssalLocationIDs),
    enteredAtMsByLocation:
      existing.enteredAtMsByLocation && typeof existing.enteredAtMsByLocation === "object"
        ? { ...existing.enteredAtMsByLocation }
        : {},
    exitedAtMsByLocation:
      existing.exitedAtMsByLocation && typeof existing.exitedAtMsByLocation === "object"
        ? { ...existing.exitedAtMsByLocation }
        : {},
  };
}

function logAbyssalEnvironmentPacketComparison({
  PROXY_NODE_ID,
  log,
}, session, eventName, idType, argumentTypes) {
  const fields = [
    ["messageClass", "Notification", "Notification", "true"],
    ["notificationMode", "broadcast/scatter", "broadcast/scatter", "true"],
    ["sourceAddressType", "Node", "Node", "true"],
    ["sourceNodeID", "dynamic", String(PROXY_NODE_ID), "semantic"],
    ["destinationAddressType", "BroadCast", "BroadCast", "true"],
    ["broadcastKey", eventName, eventName, "true"],
    ["narrowcast", "empty-list", "empty-list", "true"],
    ["idType", idType, idType, "true"],
    ["objectID", "None", "None", "true"],
    ["userID", "opaque-in-capture", String(toInt(session && session.userid, 0) || "None"), "unverified"],
    ["callID", "None", "None", "true"],
    ["sequence", "dynamic", "session-sequence", "semantic"],
    ["payloadEnvelope", "(0,(1,args))", "(0,(1,args))", "true"],
    ["argumentContainer", "tuple", "tuple", "true"],
    ["argumentTypes", argumentTypes, argumentTypes, "true"],
  ];
  for (const [field, retail, evejs, match] of fields) {
    log.info(
      `[AbyssalEnvironmentPacket] event=${eventName} field=${field} ` +
        `retail=${retail} evejs=${evejs} match=${match}`,
    );
  }
}

function selectAbyssalClientEnvironmentForSession({
  getDependencies,
  buildAbyssalClientEnvironmentSelection,
  cloneValue,
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  getAbyssalClientEnvironmentPrerequisites,
  logAbyssalClientEnvironmentPrerequisiteFailure,
  buildAbyssalDungeonRoomNotificationPayload,
  log,
  recordAbyssalClientEnvironmentDelivery,
},
  pocketState,
  session,
  deps = getDependencies(),
  reason = "room-entry",
  options = {},
) {
  const selection = buildAbyssalClientEnvironmentSelection(
    pocketState,
    session,
    deps,
    options,
  );
  if (!selection) {
    return {
      selected: false,
      duplicate: false,
      notification: "OnEnteringDungeonRoom",
      clientApplication: "UNVERIFIED",
      reason: "PROFILE_OR_SCENE_NOT_APPLICABLE",
    };
  }
  const existing =
    session && session.abyssalClientEnvironment &&
    typeof session.abyssalClientEnvironment === "object"
      ? session.abyssalClientEnvironment
      : null;
  const duplicate = Boolean(
    existing &&
    toInt(existing.runID, 0) === selection.runID &&
    normalizeText(existing.sceneKey, "") === selection.sceneKey &&
    toInt(existing.roomIndex, 0) === selection.roomIndex &&
    normalizeText(existing.profileID, "") === selection.profileID,
  );
  if (duplicate && existing.notificationSent === true) {
    return {
      selected: true,
      duplicate: true,
      notification: "OnEnteringDungeonRoom",
      clientApplication: "UNVERIFIED",
      reason: "ALREADY_SENT",
      state: cloneValue(existing),
    };
  }
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !selection.roomOrigin
  ) {
    return {
      selected: false,
      duplicate: false,
      notification: "OnEnteringDungeonRoom",
      clientApplication: "UNVERIFIED",
      reason: "ENVIRONMENT_NOTIFICATION_UNAVAILABLE",
    };
  }
  const cloudDungeonID = toInt(selection.volumetricCloudDungeonID, 0);
  const dungeonRoomID = toInt(selection.dungeonRoomID, 0);
  if (cloudDungeonID <= 0 && dungeonRoomID <= 0) {
    return {
      selected: false,
      skipped: true,
      duplicate: false,
      notification: "OnEnteringDungeonRoom",
      clientApplication: "NOT_APPLICABLE",
      reason: OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
      state: cloneValue(selection),
    };
  }
  if (cloudDungeonID <= 0 || dungeonRoomID <= 0) {
    return {
      selected: false,
      skipped: false,
      duplicate: false,
      notification: "OnEnteringDungeonRoom",
      clientApplication: "UNVERIFIED",
      reason: "ENVIRONMENT_NOTIFICATION_UNAVAILABLE",
      state: cloneValue(selection),
    };
  }
  const prerequisites = getAbyssalClientEnvironmentPrerequisites(
    pocketState,
    session,
    selection,
    deps,
    options,
  );
  if (
    prerequisites.setStateDelivered !== true ||
    prerequisites.egoValid !== true ||
    prerequisites.roomSetStateEvidenceValid !== true ||
    prerequisites.sceneAttached !== true ||
    prerequisites.hostLocationValid !== true ||
    prerequisites.locationIdentityValid !== true ||
    prerequisites.solItemValid !== true
  ) {
    logAbyssalClientEnvironmentPrerequisiteFailure(
      selection,
      prerequisites,
      options.phase,
      reason,
    );
    return {
      selected: false,
      duplicate: false,
      notification: "OnEnteringDungeonRoom",
      clientApplication: "UNVERIFIED",
      reason: "ENVIRONMENT_PREREQUISITES_NOT_READY",
      prerequisites,
    };
  }
  try {
    session.sendNotification(
      "OnEnteringDungeonRoom",
      "shipid",
      buildAbyssalDungeonRoomNotificationPayload(selection),
      { retailBroadcastEnvelope: true },
    );
  } catch (error) {
    log.warn(
      `[AbyssalClientEnvironment] phase=${normalizeText(options.phase, reason)} ` +
        `instance=${selection.runID} room=${selection.roomIndex} ` +
        `notificationSent=false clientApplication=UNVERIFIED ` +
        `reason=${normalizeText(error && error.message, "SEND_FAILED")}`,
    );
    return {
      selected: false,
      duplicate: false,
      notification: "OnEnteringDungeonRoom",
      clientApplication: "UNVERIFIED",
      reason: "ENVIRONMENT_NOTIFICATION_SEND_FAILED",
      prerequisites,
    };
  }
  return recordAbyssalClientEnvironmentDelivery(
    pocketState, session, deps, selection, prerequisites, duplicate, reason, options,
  );
}

function updateAbyssalClientEnvironmentDeliveryState({
  cloneValue,
  getActivePocketStateByInstanceID,
  updatePocketStateBestEffort,
  getDependencies,
}, pocketState, session, state) {
  if (session) {
    session.abyssalClientEnvironmentDelivery = cloneValue(state);
  }
  const runID = toInt(state && state.runID, toInt(pocketState && pocketState.instanceID, 0));
  if (runID > 0 && getActivePocketStateByInstanceID(runID)) {
    updatePocketStateBestEffort(
      runID,
      { clientEnvironmentDeliveryState: cloneValue(state) },
      getDependencies(),
    );
  }
  return state;
}

function queueAbyssalClientEnvironmentDelivery({
  getDependencies,
  buildAbyssalClientEnvironmentSelection,
  cloneValue,
  abyssalPendingWorkRegistry,
  updateAbyssalClientEnvironmentDeliveryState,
  log,
},
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  const selection = buildAbyssalClientEnvironmentSelection(pocketState, session, deps);
  if (!selection) {
    return { queued: false, reason: "PROFILE_OR_SCENE_NOT_APPLICABLE" };
  }
  const existing =
    session && session.abyssalClientEnvironmentDelivery &&
    typeof session.abyssalClientEnvironmentDelivery === "object"
      ? session.abyssalClientEnvironmentDelivery
      : null;
  if (
    existing &&
    toInt(existing.runID, 0) === selection.runID &&
    toInt(existing.roomIndex, 0) === selection.roomIndex &&
    normalizeText(existing.profileID, "") === selection.profileID &&
    ["pending", "sent", "confirmed_by_server_ordering"].includes(existing.status)
  ) {
    return { queued: true, duplicate: true, state: cloneValue(existing) };
  }
  const token = abyssalPendingWorkRegistry.allocateClientEnvironmentDeliveryToken();
  const phase = normalizeText(options.phase, "entry");
  const state = {
    status: "pending",
    token,
    runID: selection.runID,
    sceneKey: selection.sceneKey,
    roomIndex: selection.roomIndex,
    profileID: selection.profileID,
    phase,
    previousDungeonID: toInt(options.previousDungeonID, 0),
    activateNpcControllers: options.activateNpcControllers === true,
    queuedAtMs: toInt(deps.now(), 0),
    notificationSentAtMs: 0,
    exitNotificationSentAtMs: 0,
    abyssalLocationEnteredSentAtMs: 0,
    abyssalLocationExitedSentAtMs: 0,
    confirmedAtMs: 0,
    entrySceneAttached: false,
    entrySetStateDelivered: false,
    entrySceneDelivered: false,
    entryEnvironmentSent: false,
    entryAbyssalLocationEntered: false,
    entryExpiryDurationSent: false,
    entrySplashSent: false,
    entrySplashScheduled: false,
    entrySplashComplete: false,
    entryNpcControllersActivated: false,
    entryNpcActivationDegraded: false,
    entryComplete: false,
    delayedRetryScheduled: false,
    delayedRetryCompleted: false,
    lastReadyTrigger: "",
    clientApplication: "UNVERIFIED",
  };
  updateAbyssalClientEnvironmentDeliveryState(pocketState, session, state);
  log.info(
    `[AbyssalClientEnvironment] phase=${phase} instance=${selection.runID} ` +
      `room=${selection.roomIndex} deliveryStatus=pending ` +
      `notificationSent=false clientApplication=UNVERIFIED sceneKey=${selection.sceneKey}`,
  );
  return { queued: true, duplicate: false, state: cloneValue(state) };
}

function scheduleBoundedAbyssalClientEnvironmentRetry({
  ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS,
  updateAbyssalClientEnvironmentDeliveryState,
  cloneValue,
  getActivePocketStateByInstanceID,
  flushPendingAbyssalEntryReadyWork,
  log,
},
  pocketState,
  session,
  deps,
  pending,
) {
  if (
    !pending ||
    pending.delayedRetryScheduled === true ||
    !deps ||
    typeof deps.scheduleTimeout !== "function"
  ) {
    return pending;
  }
  const token = toInt(pending.token, 0);
  const runID = toInt(pending.runID, 0);
  const roomIndex = toInt(pending.roomIndex, 0);
  const sceneKey = normalizeText(pending.sceneKey, "");
  const scheduledState = {
    ...pending,
    delayedRetryScheduled: true,
    delayedRetryScheduledAtMs: toInt(deps.now(), 0),
    delayedRetryDelayMs: ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS,
  };
  updateAbyssalClientEnvironmentDeliveryState(pocketState, session, scheduledState);
  deps.scheduleTimeout(() => {
    const current =
      session && session.abyssalClientEnvironmentDelivery &&
      typeof session.abyssalClientEnvironmentDelivery === "object"
        ? cloneValue(session.abyssalClientEnvironmentDelivery)
        : null;
    const currentSceneKey = normalizeText(
      session && (session.spaceSceneKey || (session._space && session._space.sceneKey)),
      "",
    );
    if (
      !current ||
      current.status !== "pending" ||
      toInt(current.token, 0) !== token ||
      toInt(current.runID, 0) !== runID ||
      toInt(current.roomIndex, 0) !== roomIndex ||
      normalizeText(current.sceneKey, "") !== sceneKey ||
      currentSceneKey !== sceneKey
    ) {
      return;
    }
    const activePocketState = getActivePocketStateByInstanceID(runID);
    if (!activePocketState) {
      return;
    }
    const retryState = {
      ...current,
      delayedRetryCompleted: true,
      delayedRetryCompletedAtMs: toInt(deps.now(), 0),
    };
    updateAbyssalClientEnvironmentDeliveryState(activePocketState, session, retryState);
    const result = flushPendingAbyssalEntryReadyWork(
      activePocketState,
      session,
      deps,
      {
        trigger: "post-setstate-delayed",
        allowDelayedRetry: false,
      },
    );
    log.info(
      `[AbyssalClientEnvironment] phase=${normalizeText(current.phase, "entry")} ` +
        `instance=${runID} room=${roomIndex} delayedRetry=true ` +
        `success=${Boolean(result && result.success === true)} ` +
        `reason=${normalizeText(result && result.reason, "none")}`,
    );
  }, ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS);
  log.info(
    `[AbyssalClientEnvironment] phase=${normalizeText(pending.phase, "entry")} ` +
      `instance=${runID} room=${roomIndex} delayedRetryScheduled=true ` +
      `delayMs=${ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS}`,
  );
  return scheduledState;
}

function flushPendingAbyssalClientEnvironmentDelivery({
  getDependencies,
  flushPendingAbyssalEntryReadyWork,
},
  pocketState,
  session,
  deps = getDependencies(),
  options = {},
) {
  return flushPendingAbyssalEntryReadyWork(pocketState, session, deps, options);
}

function clearAbyssalClientEnvironmentForSession({
  getDependencies,
  cloneValue,
  getActivePocketStateByInstanceID,
  updatePocketStateBestEffort,
  log,
},
  pocketState,
  session,
  destinationScene,
  deps = getDependencies(),
  reason = "exit",
) {
  const previous =
    session && session.abyssalClientEnvironment &&
    typeof session.abyssalClientEnvironment === "object"
      ? cloneValue(session.abyssalClientEnvironment)
      : null;
  const instanceID = toInt(pocketState && pocketState.instanceID, toInt(previous && previous.runID, 0));
  if (session) {
    delete session.abyssalClientEnvironment;
    delete session.abyssalClientEnvironmentDelivery;
    delete session.abyssalDungeonNotificationState;
  }
  if (instanceID > 0 && getActivePocketStateByInstanceID(instanceID)) {
    updatePocketStateBestEffort(
      instanceID,
      {
        clientEnvironmentState: null,
        clientEnvironmentDeliveryState: null,
      },
      deps,
    );
  }
  if (previous) {
    log.info(
      `[AbyssalClientEnvironment] environment metadata cleared ` +
        `instance=${instanceID} oldProfile=${normalizeText(previous.profileID, "none")} ` +
        `destinationScene=${normalizeText(destinationScene, "none")} ` +
        `reason=${normalizeText(reason, "exit")} notificationState=cleared ` +
        `clientApplication=UNVERIFIED`,
    );
  }
  return {
    cleared: Boolean(previous),
    previous,
    notification: "selection_cleared",
    clientApplication: "UNVERIFIED",
  };
}

function usesAuthoredAbyssalEnvironmentNotification({
  getDependencies,
  buildAbyssalClientEnvironmentSelection,
},
  pocketState,
  session,
  deps = getDependencies(),
) {
  return Boolean(buildAbyssalClientEnvironmentSelection(pocketState, session, deps));
}

function recordAbyssalClientEnvironmentDelivery({
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  cloneValue,
  updatePocketStateBestEffort,
  logAbyssalEnvironmentPacketComparison,
  log,
  recordAbyssalEnvironmentSequenceEvent,
}, pocketState, session, deps, selection, prerequisites, duplicate, reason, options) {
  const nextSelection = {
    ...selection,
    notificationSentAtMs: toInt(deps.now(), 0),
    notificationSent: true,
    notificationRoute: "broadcast:shipid",
    notificationOuterEnvelopeMode: "retail-transfer-mode",
    clientApplication: "UNVERIFIED",
    recipientCount: 1,
  };
  const selectedRoomEntry = getPlaceholderRoomEntry(pocketState, selection.roomIndex);
  const cloudBallItemID = listUniquePositiveInts(
    selectedRoomEntry && selectedRoomEntry.environmentalObjectItemIDs,
  ).find((itemID) => {
    const item = deps.findItemById(itemID);
    return toInt(item && item.typeID, 0) === selection.volumetricCloudObjectTypeID;
  }) || 0;
  nextSelection.cloudBallItemID = cloudBallItemID;
  session.abyssalClientEnvironment = cloneValue(nextSelection);
  updatePocketStateBestEffort(
    selection.runID,
    { clientEnvironmentState: cloneValue(nextSelection) },
    deps,
  );
  logAbyssalEnvironmentPacketComparison(
    session,
    "OnEnteringDungeonRoom",
    "shipid",
    "(int,int,tuple[float,float,float],None,None)",
  );
  log.info(
    `[AbyssalClientEnvironment] phase=${normalizeText(options.phase, reason)} ` +
      `instance=${selection.runID} room=${selection.roomIndex} ` +
      `setStateDelivered=${prerequisites.setStateDelivered} egoValid=${prerequisites.egoValid} ` +
      `egoMatchesActiveShip=${prerequisites.egoMatchesActiveShip} ` +
      `roomEntitiesReady=${prerequisites.roomEntitiesReady} roomEntityCount=${prerequisites.roomEntityCount} ` +
      `sceneAttached=${prerequisites.sceneAttached} hostLocationValid=${prerequisites.hostLocationValid} ` +
      `locationIdentityValid=${prerequisites.locationIdentityValid} solItemValid=${prerequisites.solItemValid} ` +
      `notificationSent=true clientApplication=UNVERIFIED ` +
      `sessionLocation=${prerequisites.sessionLocation} ` +
      `sessionSolarSystem=${prerequisites.sessionSolarSystem} ` +
      `sessionSolarSystem2=${prerequisites.sessionSolarSystem2} sceneKey=${prerequisites.sceneKey || "none"} ` +
      `solItem.typeID=${prerequisites.solItemTypeID} solItem.groupID=${prerequisites.solItemGroupID} ` +
      `solItem.categoryID=${prerequisites.solItemCategoryID} ` +
      `roomDungeonID=${selection.volumetricCloudDungeonID} roomID=${selection.dungeonRoomID} ` +
      `profile=${selection.profileID} expectedSceneCube=${selection.sceneCubeResource} ` +
      `expectedCloud=${selection.cloudResource} recipientCount=1 ` +
      `selectionReason=${normalizeText(reason, "room-entry")} duplicate=${duplicate}`,
  );
  log.info(
    `[AbyssalCloudEnvironment] run=${selection.runID} room=${selection.roomIndex} ` +
      `dungeonID=${selection.volumetricCloudDungeonID} ` +
      `cloudTypeID=${selection.volumetricCloudObjectTypeID} ` +
      `dunObjectID=${selection.volumetricCloudDunObjectID} cloudBallItemID=${cloudBallItemID} ` +
      `notification=${normalizeText(options.phase, "entry") === "transfer" ? "AddBalls" : "SetState"} ` +
      `notificationSent=${cloudBallItemID > 0} clientApplication=UNVERIFIED`,
  );
  recordAbyssalEnvironmentSequenceEvent(
    pocketState,
    session,
    selection.roomIndex,
    normalizeText(options.sequenceEvent, "enter-notification"),
    deps,
    {
      dungeonID: selection.volumetricCloudDungeonID,
      dungeonRoomID: selection.dungeonRoomID,
    },
  );
  return {
    selected: true,
    duplicate,
    notification: "OnEnteringDungeonRoom",
    clientApplication: "UNVERIFIED",
    reason: "SENT",
    state: cloneValue(nextSelection),
    prerequisites,
  };
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalClientEnvironment({
  getDependencies,
  cloneValue,
  log,
  buildPlaceholderRoomState,
  clampRoomIndex,
  getContentProfile,
  resolveAbyssalEnvironmentRoomProfileForPocket,
  buildAbyssalSceneDescriptor,
  usesIsolatedAbyssalScene,
  getAbyssalContentID,
  describeAbyssalEnvironmentSource,
  normalizeLowerText,
  getResolvedWeatherState,
  getObjectPosition,
  resolveRoomOriginPosition,
  buildDict,
  listAbyssalRoomBootstrapEntityIDs,
  getPlaceholderRoomEntry,
  listUniquePositiveInts,
  isAbyssalHostLocationID,
  PROXY_NODE_ID,
  OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
  updatePocketStateBestEffort,
  getActivePocketStateByInstanceID,
  abyssalPendingWorkRegistry,
  ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS,
  flushPendingAbyssalEntryReadyWork,
}) {

  const ports = {
    getDependencies,
    cloneValue,
    log,
    buildPlaceholderRoomState,
    clampRoomIndex,
    getContentProfile,
    resolveAbyssalEnvironmentRoomProfileForPocket,
    buildAbyssalSceneDescriptor,
    usesIsolatedAbyssalScene,
    getAbyssalContentID,
    describeAbyssalEnvironmentSource,
    normalizeLowerText,
    getResolvedWeatherState,
    getObjectPosition,
    resolveRoomOriginPosition,
    buildDict,
    listAbyssalRoomBootstrapEntityIDs,
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    isAbyssalHostLocationID,
    PROXY_NODE_ID,
    OPTIONAL_CLOUD_PRESENTATION_NOT_AUTHORED,
    updatePocketStateBestEffort,
    getActivePocketStateByInstanceID,
    abyssalPendingWorkRegistry,
    ABYSSAL_POST_SETSTATE_ENVIRONMENT_RETRY_DELAY_MS,
    flushPendingAbyssalEntryReadyWork,
  };
  ports.recordAbyssalEnvironmentSequenceEvent = recordAbyssalEnvironmentSequenceEvent.bind(null, ports);
  ports.buildAbyssalClientEnvironmentSelection = buildAbyssalClientEnvironmentSelection.bind(null, ports);
  ports.buildAbyssalDungeonRoomNotificationPayload = buildAbyssalDungeonRoomNotificationPayload.bind(null, ports);
  ports.buildAbyssalLocationEnteredNotificationPayload = buildAbyssalLocationEnteredNotificationPayload.bind(null, ports);
  ports.getAbyssalClientEnvironmentPrerequisites = getAbyssalClientEnvironmentPrerequisites.bind(null, ports);
  ports.listAbyssalClientEnvironmentPrerequisiteBlockers = listAbyssalClientEnvironmentPrerequisiteBlockers.bind(null, ports);
  ports.logAbyssalClientEnvironmentPrerequisiteFailure = logAbyssalClientEnvironmentPrerequisiteFailure.bind(null, ports);
  ports.getAbyssalEnvironmentNotificationState = getAbyssalEnvironmentNotificationState.bind(null, ports);
  ports.logAbyssalEnvironmentPacketComparison = logAbyssalEnvironmentPacketComparison.bind(null, ports);
  ports.selectAbyssalClientEnvironmentForSession = selectAbyssalClientEnvironmentForSession.bind(null, ports);
  ports.updateAbyssalClientEnvironmentDeliveryState = updateAbyssalClientEnvironmentDeliveryState.bind(null, ports);
  ports.queueAbyssalClientEnvironmentDelivery = queueAbyssalClientEnvironmentDelivery.bind(null, ports);
  ports.scheduleBoundedAbyssalClientEnvironmentRetry = scheduleBoundedAbyssalClientEnvironmentRetry.bind(null, ports);
  ports.flushPendingAbyssalClientEnvironmentDelivery = flushPendingAbyssalClientEnvironmentDelivery.bind(null, ports);
  ports.clearAbyssalClientEnvironmentForSession = clearAbyssalClientEnvironmentForSession.bind(null, ports);
  ports.usesAuthoredAbyssalEnvironmentNotification = usesAuthoredAbyssalEnvironmentNotification.bind(null, ports);
  ports.recordAbyssalClientEnvironmentDelivery = recordAbyssalClientEnvironmentDelivery.bind(null, ports);
  Object.freeze(ports);
  return Object.freeze({
    recordAbyssalEnvironmentSequenceEvent: ports.recordAbyssalEnvironmentSequenceEvent,
    buildAbyssalClientEnvironmentSelection: ports.buildAbyssalClientEnvironmentSelection,
    buildAbyssalDungeonRoomNotificationPayload: ports.buildAbyssalDungeonRoomNotificationPayload,
    buildAbyssalLocationEnteredNotificationPayload: ports.buildAbyssalLocationEnteredNotificationPayload,
    getAbyssalClientEnvironmentPrerequisites: ports.getAbyssalClientEnvironmentPrerequisites,
    listAbyssalClientEnvironmentPrerequisiteBlockers: ports.listAbyssalClientEnvironmentPrerequisiteBlockers,
    logAbyssalClientEnvironmentPrerequisiteFailure: ports.logAbyssalClientEnvironmentPrerequisiteFailure,
    getAbyssalEnvironmentNotificationState: ports.getAbyssalEnvironmentNotificationState,
    logAbyssalEnvironmentPacketComparison: ports.logAbyssalEnvironmentPacketComparison,
    selectAbyssalClientEnvironmentForSession: ports.selectAbyssalClientEnvironmentForSession,
    updateAbyssalClientEnvironmentDeliveryState: ports.updateAbyssalClientEnvironmentDeliveryState,
    queueAbyssalClientEnvironmentDelivery: ports.queueAbyssalClientEnvironmentDelivery,
    scheduleBoundedAbyssalClientEnvironmentRetry: ports.scheduleBoundedAbyssalClientEnvironmentRetry,
    flushPendingAbyssalClientEnvironmentDelivery: ports.flushPendingAbyssalClientEnvironmentDelivery,
    clearAbyssalClientEnvironmentForSession: ports.clearAbyssalClientEnvironmentForSession,
    usesAuthoredAbyssalEnvironmentNotification: ports.usesAuthoredAbyssalEnvironmentNotification,
  });
}

module.exports = Object.freeze({ createAbyssalClientEnvironment });
