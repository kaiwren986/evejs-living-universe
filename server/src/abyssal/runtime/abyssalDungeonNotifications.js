"use strict";

const crypto = require("node:crypto");
const { normalizeText } = require("../domain/abyssalValueUtils");

// Preserve timer anchoring, durable handoff and the exact client notification envelopes.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toAbyssalExpiryFileTime(ports, expiresAtMs) {
  const {
    FILETIME_TICKS_PER_MS, FILETIME_UNIX_EPOCH_OFFSET,
  } = ports;
  return (
    BigInt(Math.max(0, toInt(expiresAtMs, 0))) * FILETIME_TICKS_PER_MS +
    FILETIME_UNIX_EPOCH_OFFSET
  );
}

function isAbyssalTimerAnchored(ports, timerState) {
  if (!timerState || typeof timerState !== "object") {
    return false;
  }
  const anchorState = normalizeText(timerState.anchorState, "");
  if (anchorState === "pending_room1_entry_notification") {
    return false;
  }
  if (anchorState === "anchored_room1_entry_notification") {
    return true;
  }
  if (anchorState === "anchored_run_admission") {
    return true;
  }
  const startedAtMs = toInt(timerState.startedAtMs, 0);
  const expiresAtMs = toInt(timerState.expiresAtMs, 0);
  return startedAtMs > 0 && expiresAtMs > startedAtMs;
}

function restoreAbyssalTimerDeadlineAfterRestart(ports,
  pocketState,
  deps = ports.getDependencies(),
) {
  const {
    cloneValue, resolvePlaceholderDurationMs,
  } = ports;
  if (!pocketState || typeof pocketState !== "object") {
    return pocketState;
  }
  const timerState = pocketState.timerState && typeof pocketState.timerState === "object"
    ? cloneValue(pocketState.timerState)
    : null;
  if (timerState && isAbyssalTimerAnchored(ports, timerState)) {
    return pocketState;
  }

  const durationMs = Math.max(
    1,
    toInt(
      timerState && timerState.durationMs,
      resolvePlaceholderDurationMs(pocketState, deps),
    ),
  );
  const provisionalStartedAtMs = toInt(
    timerState && timerState.provisionalStartedAtMs,
    toInt(
      timerState && timerState.preparedAtMs,
      toInt(timerState && timerState.startedAtMs, toInt(pocketState.activatedAtMs, 0)),
    ),
  );
  const provisionalExpiresAtMs = toInt(
    timerState && timerState.provisionalExpiresAtMs,
    toInt(
      timerState && timerState.expiresAtMs,
      provisionalStartedAtMs > 0 ? provisionalStartedAtMs + durationMs : 0,
    ),
  );
  if (
    provisionalStartedAtMs <= 0 ||
    provisionalExpiresAtMs <= provisionalStartedAtMs
  ) {
    return pocketState;
  }

  return {
    ...cloneValue(pocketState),
    timerState: {
      ...cloneValue(timerState || {}),
      preparedAtMs: toInt(
        timerState && timerState.preparedAtMs,
        provisionalStartedAtMs,
      ),
      provisionalStartedAtMs,
      provisionalExpiresAtMs,
      startedAtMs: 0,
      durationMs,
      expiresAtMs: provisionalExpiresAtMs,
      anchorState: "pending_room1_entry_notification",
      anchoredAtMs: 0,
      anchorPhase: "restart-recovery-pending-client-handoff",
      anchorReason: "awaiting-first-successful-expiry-notification-handoff",
      expired: false,
    },
  };
}

function refreshAbyssalRunArtifactExpiryAtTimerAnchor(ports,
  pocketState,
  expiresAtMs,
  deps = ports.getDependencies(),
) {
  const {
    buildPlaceholderRoomState, listAbyssalRoomBootstrapEntityIDs, getPocketScene,
    listUniquePositiveInts,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const roomState = buildPlaceholderRoomState(pocketState);
  const itemIDs = [];
  for (let roomIndex = 1; roomIndex <= roomState.implementedRooms; roomIndex += 1) {
    itemIDs.push(...listAbyssalRoomBootstrapEntityIDs(pocketState, roomIndex));
  }
  const scene = getPocketScene(pocketState, deps);
  let inventoryUpdatedCount = 0;
  let runtimeUpdatedCount = 0;
  for (const itemID of listUniquePositiveInts(itemIDs)) {
    const item = typeof deps.findItemById === "function" ? deps.findItemById(itemID) : null;
    if (item && Number.isFinite(Number(item.expiresAtMs)) && Number(item.expiresAtMs) > 0) {
      if (typeof deps.updateInventoryItem === "function") {
        const updateResult = deps.updateInventoryItem(itemID, (currentItem) => ({
          ...currentItem,
          expiresAtMs,
        }));
        if (updateResult && updateResult.success) {
          inventoryUpdatedCount += 1;
        }
      } else {
        item.expiresAtMs = expiresAtMs;
        inventoryUpdatedCount += 1;
      }
    }
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(itemID)
      : null;
    if (entity && Number.isFinite(Number(entity.expiresAtMs)) && Number(entity.expiresAtMs) > 0) {
      entity.expiresAtMs = expiresAtMs;
      runtimeUpdatedCount += 1;
    }
  }
  return {
    runID,
    trackedItemCount: listUniquePositiveInts(itemIDs).length,
    inventoryUpdatedCount,
    runtimeUpdatedCount,
  };
}

function anchorAbyssalTimerAtExpiryNotification(ports,
  pocketState,
  anchorAtMs,
  deps = ports.getDependencies(),
  phase = "entry",
) {
  const {
    cloneValue, resolvePlaceholderDurationMs, getActivePocketStateByInstanceID, updatePocketState,
    log,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  const activePocketState = runID > 0
    ? getActivePocketStateByInstanceID(runID) || pocketState
    : pocketState;
  const timerState = activePocketState && activePocketState.timerState;
  if (!timerState || runID <= 0) {
    return { success: false, reason: "TIMER_STATE_UNAVAILABLE", pocketState: activePocketState };
  }
  if (isAbyssalTimerAnchored(ports, timerState)) {
    return {
      success: true,
      anchored: false,
      reason: "ALREADY_ANCHORED",
      pocketState: activePocketState,
      timerState: cloneValue(timerState),
    };
  }
  const notificationHandoffAtMs = Math.max(
    0,
    toInt(anchorAtMs, toInt(deps.now(), 0)),
  );
  const durationMs = Math.max(1, toInt(
    timerState.durationMs,
    resolvePlaceholderDurationMs(activePocketState, deps),
  ));
  const authoritativeStartedAtMs = notificationHandoffAtMs;
  const provisionalExpiresAtMs = toInt(
    timerState.provisionalExpiresAtMs,
    toInt(timerState.expiresAtMs, authoritativeStartedAtMs + durationMs),
  );
  const authoritativeExpiresAtMs = provisionalExpiresAtMs > 0
    ? Math.min(authoritativeStartedAtMs + durationMs, provisionalExpiresAtMs)
    : authoritativeStartedAtMs + durationMs;
  if (
    authoritativeStartedAtMs <= 0 ||
    authoritativeExpiresAtMs <= authoritativeStartedAtMs
  ) {
    return {
      success: false,
      anchored: false,
      reason: "AUTHORITATIVE_TIMER_DEADLINE_UNAVAILABLE",
      pocketState: activePocketState,
      timerState: cloneValue(timerState),
    };
  }
  const nextTimerState = {
    ...cloneValue(timerState),
    preparedAtMs: toInt(
      timerState.preparedAtMs,
      toInt(timerState.startedAtMs, authoritativeStartedAtMs),
    ),
    provisionalStartedAtMs: toInt(
      timerState.provisionalStartedAtMs,
      toInt(timerState.startedAtMs, authoritativeStartedAtMs),
    ),
    provisionalExpiresAtMs: toInt(provisionalExpiresAtMs, authoritativeExpiresAtMs),
    startedAtMs: authoritativeStartedAtMs,
    durationMs,
    expiresAtMs: authoritativeExpiresAtMs,
    anchorState: "anchored_expiry_notification",
    anchoredAtMs: authoritativeStartedAtMs,
    anchorPhase: normalizeText(phase, "entry"),
    anchorReason: "first-successful-expiry-notification-handoff",
    notificationHandoffAtMs,
  };
  const updatedPocketState = updatePocketState(runID, {
    timerState: cloneValue(nextTimerState),
  }) || {
    ...cloneValue(activePocketState),
    timerState: cloneValue(nextTimerState),
  };
  const artifactExpiryRefresh = refreshAbyssalRunArtifactExpiryAtTimerAnchor(ports,
    updatedPocketState,
    nextTimerState.expiresAtMs,
    deps,
  );
  log.info(
    `[AbyssalTimerAnchor] run=${runID} phase=${nextTimerState.anchorPhase} ` +
      `preparedAtMs=${nextTimerState.preparedAtMs} anchoredAtMs=${nextTimerState.anchoredAtMs} ` +
      `durationMs=${durationMs} expiresAtMs=${nextTimerState.expiresAtMs} ` +
      `notificationHandoffAtMs=${notificationHandoffAtMs} ` +
      `provisionalLeadMs=${Math.max(0, notificationHandoffAtMs - nextTimerState.provisionalStartedAtMs)} ` +
      `inventoryExpiryUpdatedCount=${artifactExpiryRefresh.inventoryUpdatedCount} ` +
      `runtimeExpiryUpdatedCount=${artifactExpiryRefresh.runtimeUpdatedCount} ` +
      `status=anchored reason=first-successful-expiry-notification-handoff`,
  );
  return {
    success: true,
    anchored: true,
    reason: "ANCHORED",
    pocketState: updatedPocketState,
    timerState: nextTimerState,
    artifactExpiryRefresh,
  };
}

function getAbyssalContentID(ports, pocketState) {
  const persistedContentID = normalizeText(
    pocketState && (pocketState.contentID || pocketState.contentUUID),
    "",
  );
  if (persistedContentID) {
    return persistedContentID;
  }

  // Runs created before content UUIDs were persisted must still speak the same
  // UUID-shaped client contract as newly created runs. Deriving the value from
  // the immutable run identity also keeps relog/restart notifications stable.
  const legacyRunIdentity = [
    toInt(pocketState && pocketState.instanceID, 0),
    toInt(pocketState && pocketState.traceItemID, 0),
    toInt(pocketState && pocketState.characterID, 0),
  ].join(":");
  const bytes = crypto
    .createHash("sha256")
    .update(`evejs:abyssal-content:${legacyRunIdentity}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveAbyssalCacheObjectiveState(ports, roomEntry) {
  const lifecycleState = normalizeText(roomEntry && roomEntry.cacheLifecycleState, "");
  if (lifecycleState === "structure_destroyed_reward_materializing") {
    return "destroyed";
  }
  if (
    lifecycleState === "structure_destroyed_loot_container_spawned" ||
    roomEntry && roomEntry.cacheRewardMaterialized === true
  ) {
    return "completed";
  }
  if (
    toInt(roomEntry && roomEntry.cacheItemID, 0) > 0 ||
    toInt(roomEntry && roomEntry.cacheStructureItemID, 0) > 0
  ) {
    return "present";
  }
  return "absent";
}

function buildAbyssalDungeonTrackingState(ports,
  pocketState,
  deps = ports.getDependencies(),
  event = "status",
  overrides = {},
) {
  const {
    cloneValue, buildPlaceholderRoomState, listUniquePositiveInts, getPlaceholderRoomEntry,
    getContentProfile, resolveAbyssalEnvironmentRoomProfileForPocket,
    describeAbyssalEnvironmentSource, normalizeLowerText, calculateAbyssalRemainingDuration,
  } = ports;
  const roomState = buildPlaceholderRoomState(pocketState);
  const roomIndex = toInt(roomState.currentRoomIndex, 1);
  const currentRoomEntry = getPlaceholderRoomEntry(pocketState, roomIndex);
  const contentProfile = getContentProfile(pocketState) || {};
  const environmentRoomProfile =
    resolveAbyssalEnvironmentRoomProfileForPocket(pocketState, roomIndex) || {};
  const roomEntries = Object.values(roomState.roomStatesByIndex || {});
  const expiryAt = toInt(
    pocketState && pocketState.timerState && pocketState.timerState.expiresAtMs,
    0,
  );
  const nowMs = toInt(deps && typeof deps.now === "function" ? deps.now() : Date.now(), 0);
  const previousNotificationState =
    pocketState && pocketState.dungeonTrackingState &&
    pocketState.dungeonTrackingState.notificationState &&
    typeof pocketState.dungeonTrackingState.notificationState === "object"
      ? pocketState.dungeonTrackingState.notificationState
      : {};
  return {
    runID: toInt(pocketState && pocketState.instanceID, 0),
    contentID: getAbyssalContentID(ports, pocketState),
    roomIndex,
    totalPockets: toInt(roomState.implementedRooms, 3),
    pocketsCompleted: roomEntries.filter((entry) => entry && entry.objectiveComplete === true).length,
    targetsRemaining: listUniquePositiveInts(
      currentRoomEntry && currentRoomEntry.objectiveRelevantNpcItemIDs,
    ).length,
    cacheObjectiveState: resolveAbyssalCacheObjectiveState(ports, currentRoomEntry),
    dungeonID: toInt(environmentRoomProfile.volumetricCloudDungeonID, 0),
    roomID: toInt(environmentRoomProfile.dungeonRoomID, 0),
    nebulaGraphicID: toInt(environmentRoomProfile.nebulaGraphicID, 0),
    cloudDungeonID: toInt(environmentRoomProfile.volumetricCloudDungeonID, 0),
    cloudObjectTypeID: toInt(environmentRoomProfile.volumetricCloudObjectTypeID, 0),
    cloudDunObjectID: toInt(environmentRoomProfile.volumetricCloudDunObjectID, 0),
    environmentSource: describeAbyssalEnvironmentSource(environmentRoomProfile),
    weatherType: normalizeLowerText(
      environmentRoomProfile.weatherType,
      contentProfile.weatherType,
    ),
    expiryAt,
    remainingDuration: calculateAbyssalRemainingDuration({
      nowMs,
      deadlineAtMs: expiryAt,
    }),
    event: normalizeText(event, "status"),
    updatedAtMs: nowMs,
    clientCloudApplication: "UNVERIFIED",
    notificationState: {
      ...cloneValue(previousNotificationState),
      ...(overrides.notificationState && typeof overrides.notificationState === "object"
        ? cloneValue(overrides.notificationState)
        : {}),
    },
    ...cloneValue(overrides.state || {}),
  };
}

function refreshAbyssalDungeonTrackingState(ports,
  pocketState,
  deps = ports.getDependencies(),
  event = "status",
  overrides = {},
) {
  const {
    cloneValue, getActivePocketStateByInstanceID, log, updatePocketStateBestEffort,
  } = ports;
  const activePocketState =
    pocketState && pocketState.instanceID
      ? getActivePocketStateByInstanceID(pocketState.instanceID) || pocketState
      : pocketState;
  if (!activePocketState || toInt(activePocketState.instanceID, 0) <= 0) {
    return null;
  }
  const state = buildAbyssalDungeonTrackingState(ports, activePocketState, deps, event, overrides);
  updatePocketStateBestEffort(
    state.runID,
    { dungeonTrackingState: cloneValue(state) },
    deps,
  );
  log.info(
    `[AbyssalDungeonTracking] run=${state.runID} room=${state.roomIndex} ` +
      `event=${state.event} pocketsCompleted=${state.pocketsCompleted} ` +
      `targetsRemaining=${state.targetsRemaining} cacheState=${state.cacheObjectiveState} ` +
      `expiry=${state.expiryAt}`,
  );
  return state;
}

function sendAbyssalContentFinishedNotification(ports,
  session,
  pocketState,
  deps = ports.getDependencies(),
  options = {},
) {
  const {
    buildPlaceholderRoomState, logAbyssalEnvironmentPacketComparison, ABYSSAL_TIMER_TYPE_NORMAL_PVE,
  } = ports;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  if (!session || typeof session.sendNotification !== "function" || runID <= 0) {
    return { sent: false, duplicate: false, reason: "FINISHED_NOTIFICATION_UNAVAILABLE" };
  }
  const contentID = getAbyssalContentID(ports, pocketState);
  const receiptKey = `${runID}:${contentID}:${ABYSSAL_TIMER_TYPE_NORMAL_PVE}`;
  const existingState =
    session.abyssalDungeonTrackingNotificationState &&
    typeof session.abyssalDungeonTrackingNotificationState === "object"
      ? session.abyssalDungeonTrackingNotificationState
      : {};
  if (existingState.finishedReceiptKey === receiptKey) {
    return { sent: false, duplicate: true, reason: "ALREADY_SENT" };
  }
  try {
    session.sendNotification(
      "OnAbyssalContentFinished",
      "charid",
      [contentID, ABYSSAL_TIMER_TYPE_NORMAL_PVE],
      { retailBroadcastEnvelope: true },
    );
  } catch (error) {
    return {
      sent: false,
      duplicate: false,
      reason: normalizeText(error && error.message, "FINISHED_NOTIFICATION_SEND_FAILED"),
    };
  }
  const sentAtMs = toInt(deps.now(), 0);
  session.abyssalDungeonTrackingNotificationState = {
    ...existingState,
    runID,
    finishedReceiptKey: receiptKey,
    finishedSentAtMs: sentAtMs,
  };
  const trackingUpdate = {
    notificationState: {
      finishedNotification: "OnAbyssalContentFinished",
      finishedRoute: "broadcast:charid",
      finishedSentAtMs: sentAtMs,
    },
  };
  if (options.markPocketsCompleted !== false) {
    trackingUpdate.state = {
      pocketsCompleted: buildPlaceholderRoomState(pocketState).implementedRooms,
    };
  }
  refreshAbyssalDungeonTrackingState(ports,
    pocketState,
    deps,
    normalizeText(options.trackingEvent, "content_finished"),
    trackingUpdate,
  );
  logAbyssalEnvironmentPacketComparison(
    session,
    "OnAbyssalContentFinished",
    "charid",
    "(str,int)",
  );
  return { sent: true, duplicate: false, reason: "SENT", sentAtMs, contentID };
}

function sendAbyssalDungeonExitNotification(ports, session, previousDungeonID, options = {}) {
  const {
    listUniquePositiveInts, log, logAbyssalEnvironmentPacketComparison,
    getAbyssalEnvironmentNotificationState, recordAbyssalEnvironmentSequenceEvent,
  } = ports;
  const numericDungeonID = toInt(previousDungeonID, 0);
  if (!session || typeof session.sendNotification !== "function" || numericDungeonID <= 0) {
    return { sent: false, duplicate: false, reason: "EXIT_NOTIFICATION_UNAVAILABLE" };
  }
  const runID = toInt(session.abyssalInstanceID, 0);
  const existingState = getAbyssalEnvironmentNotificationState(session, runID);
  const exitedDungeonIDs = new Set(listUniquePositiveInts(existingState.exitedDungeonIDs));
  if (exitedDungeonIDs.has(numericDungeonID)) {
    return { sent: false, duplicate: true, reason: "ALREADY_SENT" };
  }
  try {
    session.sendNotification(
      "OnExitingDungeon",
      "shipid",
      [numericDungeonID],
      { retailBroadcastEnvelope: true },
    );
  } catch (error) {
    log.warn(
      `[AbyssalClientEnvironment] phase=exit instance=${runID} ` +
        `roomDungeonID=${numericDungeonID} notification=OnExitingDungeon ` +
        `notificationSent=false clientApplication=UNVERIFIED ` +
        `reason=${normalizeText(error && error.message, "SEND_FAILED")}`,
    );
    return {
      sent: false,
      duplicate: false,
      reason: "EXIT_NOTIFICATION_SEND_FAILED",
    };
  }
  exitedDungeonIDs.add(numericDungeonID);
  const sentAtMs = toInt((options.deps || ports.getDependencies()).now(), Date.now());
  session.abyssalDungeonNotificationState = {
    ...existingState,
    exitedDungeonIDs: [...exitedDungeonIDs],
  };
  logAbyssalEnvironmentPacketComparison(session, "OnExitingDungeon", "shipid", "(int)");
  log.info(
    `[AbyssalClientEnvironment] phase=exit instance=${runID} ` +
      `roomDungeonID=${numericDungeonID} notification=OnExitingDungeon ` +
      `notificationSent=true clientApplication=UNVERIFIED`,
  );
  if (options.pocketState) {
    recordAbyssalEnvironmentSequenceEvent(
      options.pocketState,
      session,
      options.roomIndex,
      normalizeText(options.sequenceEvent, "exit-notification"),
      options.deps || ports.getDependencies(),
      { dungeonID: numericDungeonID },
    );
  }
  return {
    sent: true,
    duplicate: false,
    reason: "SENT",
    dungeonID: numericDungeonID,
    sentAtMs,
  };
}

function sendAbyssalLocationExitNotification(ports, session, runIDValue, roomIndex, options = {}) {
  const {
    log, logAbyssalEnvironmentPacketComparison, getAbyssalEnvironmentNotificationState,
  } = ports;
  const runID = toInt(runIDValue, 0);
  const locationID = toInt(roomIndex, 0);
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    runID <= 0 ||
    toInt(session.abyssalInstanceID, 0) !== runID ||
    locationID <= 0
  ) {
    return { sent: false, duplicate: false, reason: "ABYSSAL_LOCATION_EXIT_UNAVAILABLE" };
  }
  const state = getAbyssalEnvironmentNotificationState(session, runID);
  const exitedLocationIDs = new Set(state.exitedAbyssalLocationIDs);
  if (exitedLocationIDs.has(locationID)) {
    return { sent: false, duplicate: true, reason: "ALREADY_SENT" };
  }
  try {
    session.sendNotification(
      "OnAbyssalLocationExited",
      "charid",
      [],
      { retailBroadcastEnvelope: true },
    );
  } catch (error) {
    log.warn(
      `[AbyssalClientEnvironment] phase=${normalizeText(options.phase, "exit")} ` +
        `instance=${runID} room=${locationID} notification=OnAbyssalLocationExited ` +
        `notificationSent=false clientApplication=UNVERIFIED ` +
        `reason=${normalizeText(error && error.message, "SEND_FAILED")}`,
    );
    return { sent: false, duplicate: false, reason: "ABYSSAL_LOCATION_EXIT_SEND_FAILED" };
  }
  const sentAtMs = toInt((options.deps || ports.getDependencies()).now(), Date.now());
  exitedLocationIDs.add(locationID);
  session.abyssalDungeonNotificationState = {
    ...state,
    exitedAbyssalLocationIDs: [...exitedLocationIDs],
    exitedAtMsByLocation: {
      ...state.exitedAtMsByLocation,
      [locationID]: sentAtMs,
    },
  };
  logAbyssalEnvironmentPacketComparison(session, "OnAbyssalLocationExited", "charid", "()");
  log.info(
    `[AbyssalClientEnvironment] phase=${normalizeText(options.phase, "exit")} ` +
      `instance=${runID} room=${locationID} notification=OnAbyssalLocationExited ` +
      `notificationSent=true route=broadcast:charid outerEnvelope=retail-transfer-mode ` +
      `clientApplication=UNVERIFIED`,
  );
  return { sent: true, duplicate: false, reason: "SENT", locationID, sentAtMs };
}

function markAbyssalDungeonRoomWithoutGenericNotification(ports,
  scene,
  session,
  pocketState,
  deps = ports.getDependencies(),
  roomIndex = null,
) {
  const {
    buildPlaceholderRoomState, resolveRoomOriginPosition,
  } = ports;
  const tracking = deps && deps.dungeonTrackingRuntime;
  const shipEntity =
    scene && typeof scene.getShipEntityForSession === "function"
      ? scene.getShipEntityForSession(session)
      : scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(toInt(session && (session.shipID || session.shipid), 0))
        : null;
  if (!tracking || typeof tracking.markShipCurrentDungeonRoom !== "function" || !shipEntity) {
    return false;
  }
  const resolvedRoomIndex = toInt(
    roomIndex,
    buildPlaceholderRoomState(pocketState).currentRoomIndex,
  );
  return tracking.markShipCurrentDungeonRoom(
    shipEntity,
    pocketState.instance,
    resolvedRoomIndex === 1 ? "room:entry" : `room:${resolvedRoomIndex}`,
    {
      siteID: pocketState.traceItemID,
      roomPosition: resolveRoomOriginPosition(pocketState, resolvedRoomIndex),
    },
  );
}

function validateExpiryNotification(ports, work) {
  const {
    getActivePocketStateByInstanceID, resolveAbyssalRunDeadlineMs, classifyAbyssalRunDeadline,
    syncExpiredAbyssalPocketState,
  } = ports;
  const {
    session, pocketState, deps, options,
  } = work;
  const runID = toInt(pocketState && pocketState.instanceID, 0);
  if (!session || typeof session.sendNotification !== "function" || runID <= 0) {
    return { sent: false, duplicate: false, reason: "EXPIRY_NOTIFICATION_UNAVAILABLE" };
  }
  const notificationHandoffAtMs = toInt(deps.now(), 0);
  const currentPocketState = getActivePocketStateByInstanceID(runID) || pocketState;
  const currentTimerState = currentPocketState && currentPocketState.timerState;
  if (!currentTimerState) {
    return { sent: false, duplicate: false, reason: "TIMER_STATE_UNAVAILABLE" };
  }
  const timerAlreadyAnchored = isAbyssalTimerAnchored(ports, currentTimerState);
  const pendingDeadlineMs = resolveAbyssalRunDeadlineMs({
    anchored: timerAlreadyAnchored,
    expiresAtMs: currentTimerState.expiresAtMs,
    provisionalExpiresAtMs: currentTimerState.provisionalExpiresAtMs,
  });
  if (pendingDeadlineMs <= 0) {
    return { sent: false, duplicate: false, reason: "EXPIRY_TIMER_ANCHOR_FAILED" };
  }
  if (classifyAbyssalRunDeadline({
    nowMs: notificationHandoffAtMs,
    deadlineAtMs: pendingDeadlineMs,
  }).expired) {
    syncExpiredAbyssalPocketState(
      currentPocketState,
      notificationHandoffAtMs,
      deps,
      session,
    );
    return { sent: false, duplicate: false, reason: "ABYSSAL_TIMER_EXPIRED" };
  }
  Object.assign(work, { runID, notificationHandoffAtMs, currentPocketState, currentTimerState, timerAlreadyAnchored });
}

function prepareDurableExpiryNotification(ports, work) {
  const {
    cloneValue, getActivePocketStateByInstanceID, classifyAbyssalRunDeadline,
    syncExpiredAbyssalPocketState, AbyssalPocketPersistenceError,
    ensureAbyssalPocketPersistenceReady,
  } = ports;
  const {
    session, pocketState, deps, options, runID, notificationHandoffAtMs, currentPocketState,
    currentTimerState, timerAlreadyAnchored,
  } = work;
  let anchorResult;
  try {
    anchorResult = timerAlreadyAnchored
      ? {
          success: true,
          anchored: false,
          reason: "ALREADY_ANCHORED",
          pocketState: currentPocketState,
          timerState: cloneValue(currentTimerState),
        }
      : anchorAbyssalTimerAtExpiryNotification(ports,
          currentPocketState,
          notificationHandoffAtMs,
          deps,
          normalizeText(options.phase, "entry"),
        );
  } catch (error) {
    if (!(error instanceof AbyssalPocketPersistenceError)) {
      throw error;
    }
    return {
      sent: false,
      duplicate: false,
      reason: "ABYSSAL_TIMER_ANCHOR_PERSIST_FAILED",
      persistenceErrorMsg: normalizeText(
        error && (error.code || error.message),
        "ABYSSAL_RUN_STATE_PERSIST_FAILED",
      ),
    };
  }
  if (!anchorResult || anchorResult.success !== true) {
    return {
      sent: false,
      duplicate: false,
      reason: normalizeText(anchorResult && anchorResult.reason, "EXPIRY_TIMER_ANCHOR_FAILED"),
    };
  }
  const activePocketState = anchorResult.pocketState ||
    getActivePocketStateByInstanceID(runID) || currentPocketState;
  const persistenceReady = ensureAbyssalPocketPersistenceReady(activePocketState, deps);
  if (!persistenceReady || persistenceReady.success !== true) {
    return {
      sent: false,
      duplicate: false,
      reason: "ABYSSAL_TIMER_ANCHOR_PERSIST_FAILED",
      persistenceErrorMsg: normalizeText(
        persistenceReady && persistenceReady.persistenceErrorMsg,
        normalizeText(persistenceReady && persistenceReady.errorMsg, "ABYSSAL_RUN_STATE_PERSIST_FAILED"),
      ),
    };
  }
  const expiresAtMs = toInt(anchorResult.timerState && anchorResult.timerState.expiresAtMs, 0);
  if (classifyAbyssalRunDeadline({
    nowMs: notificationHandoffAtMs,
    deadlineAtMs: expiresAtMs,
  }).expired) {
    syncExpiredAbyssalPocketState(activePocketState, notificationHandoffAtMs, deps, session);
    return { sent: false, duplicate: false, reason: "ABYSSAL_TIMER_EXPIRED" };
  }
  Object.assign(work, { activePocketState, anchorResult, expiresAtMs });
}

function publishExpiryNotification(ports, work) {
  const {
    logAbyssalEnvironmentPacketComparison,
  } = ports;
  const {
    session, pocketState, deps, options, runID, notificationHandoffAtMs, currentPocketState,
    currentTimerState, timerAlreadyAnchored, activePocketState, anchorResult, expiresAtMs,
  } = work;
  const receiptKey = `${runID}:${expiresAtMs}`;
  const existingState =
    session.abyssalDungeonTrackingNotificationState &&
    typeof session.abyssalDungeonTrackingNotificationState === "object"
      ? session.abyssalDungeonTrackingNotificationState
      : {};
  if (existingState.expiryReceiptKey === receiptKey) {
    return {
      sent: false,
      duplicate: true,
      reason: "ALREADY_SENT",
      sentAtMs: toInt(existingState.expirySentAtMs, 0),
    };
  }
  const expiryFileTime = toAbyssalExpiryFileTime(ports, expiresAtMs);
  try {
    session.sendNotification(
      "OnAddExpiryDurationForAbyssalContent",
      "charid",
      [expiryFileTime],
      { retailBroadcastEnvelope: true },
    );
  } catch (error) {
    return {
      sent: false,
      duplicate: false,
      reason: normalizeText(error && error.message, "EXPIRY_NOTIFICATION_SEND_FAILED"),
    };
  }
  const sentAtMs = notificationHandoffAtMs;
  session.abyssalDungeonTrackingNotificationState = {
    ...existingState,
    runID,
    expiryReceiptKey: receiptKey,
    expirySentAtMs: sentAtMs,
    expiryFileTime: expiryFileTime.toString(),
  };
  refreshAbyssalDungeonTrackingState(ports, activePocketState, deps, normalizeText(options.phase, "entry"), {
    notificationState: {
      expiryNotification: "OnAddExpiryDurationForAbyssalContent",
      expiryRoute: "broadcast:charid",
      expirySentAtMs: sentAtMs,
      expiryFileTime: expiryFileTime.toString(),
    },
  });
  logAbyssalEnvironmentPacketComparison(
    session,
    "OnAddExpiryDurationForAbyssalContent",
    "charid",
    "(int64)",
  );
  return {
    sent: true,
    duplicate: false,
    reason: "SENT",
    sentAtMs,
    expiresAtMs: toInt(anchorResult && anchorResult.timerState && anchorResult.timerState.expiresAtMs, expiresAtMs),
    expiryFileTime,
    timerAnchored: anchorResult.anchored === true,
  };
}

function sendAbyssalExpiryDurationNotification(ports, session, pocketState, deps = ports.getDependencies(), options = {}) {
  const work = { session, pocketState, deps, options };
  const validation = validateExpiryNotification(ports, work);
  if (validation) return validation;
  const preparation = prepareDurableExpiryNotification(ports, work);
  if (preparation) return preparation;
  return publishExpiryNotification(ports, work);
}

function createAbyssalDungeonNotifications(ports) {
  return {
    toAbyssalExpiryFileTime: toAbyssalExpiryFileTime.bind(null, ports),
    isAbyssalTimerAnchored: isAbyssalTimerAnchored.bind(null, ports),
    restoreAbyssalTimerDeadlineAfterRestart: restoreAbyssalTimerDeadlineAfterRestart.bind(null, ports),
    refreshAbyssalRunArtifactExpiryAtTimerAnchor: refreshAbyssalRunArtifactExpiryAtTimerAnchor.bind(null, ports),
    anchorAbyssalTimerAtExpiryNotification: anchorAbyssalTimerAtExpiryNotification.bind(null, ports),
    getAbyssalContentID: getAbyssalContentID.bind(null, ports),
    resolveAbyssalCacheObjectiveState: resolveAbyssalCacheObjectiveState.bind(null, ports),
    buildAbyssalDungeonTrackingState: buildAbyssalDungeonTrackingState.bind(null, ports),
    refreshAbyssalDungeonTrackingState: refreshAbyssalDungeonTrackingState.bind(null, ports),
    sendAbyssalExpiryDurationNotification: sendAbyssalExpiryDurationNotification.bind(null, ports),
    sendAbyssalContentFinishedNotification: sendAbyssalContentFinishedNotification.bind(null, ports),
    sendAbyssalDungeonExitNotification: sendAbyssalDungeonExitNotification.bind(null, ports),
    sendAbyssalLocationExitNotification: sendAbyssalLocationExitNotification.bind(null, ports),
    markAbyssalDungeonRoomWithoutGenericNotification: markAbyssalDungeonRoomWithoutGenericNotification.bind(null, ports),
  };
}

module.exports = { createAbyssalDungeonNotifications };
