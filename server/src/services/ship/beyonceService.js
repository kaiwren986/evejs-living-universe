"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const crypto = require("crypto");
const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const {
  recordSyncLedgerEvent,
} = require(path.join(__dirname, "../../network/syncLedger"));
const {
  buildBoundObjectResponse,
  extractDictEntries,
  normalizeNumber,
  normalizeText,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  normalizePersistentEntityID,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/entityID",
));
const {
  isAbyssalHostLocationID,
} = require("../../abyssal").engineSupport.hostLocation;
const worldData = require(path.join(__dirname, "../../space/worldData"));
const mobileAnalysisBeaconRuntime = require(path.join(__dirname, "./mobileAnalysisBeaconRuntime"));
const mobileMicroJumpUnitRuntime = require(path.join(__dirname, "./mobileMicroJumpUnitRuntime"));
const mobileSiphonUnitRuntime = require(path.join(__dirname, "./mobileSiphonUnitRuntime"));
const {
  jumpSessionViaStargate,
  jumpSessionToSolarSystem,
  jumpSessionToCynosuralBeacon,
} = require(path.join(__dirname, "../../space/transitions"));
const {
  buildCynoArrivalSpawnState: buildFleetCynoArrivalSpawnState,
} = require("../../space/cynoArrivalSpawnState");
const {
  consumeFuelFromShipStorage,
  getFuelQuantityFromStacks,
  getFuelStacksForShipStorage,
} = require(path.join(__dirname, "../../space/modules/sharedFuelRuntime"));
const {
  getActiveShipRecord,
  findCharacterShip,
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  buildEffectiveItemAttributeMap,
  buildShipResourceState,
  getDogmaAttributeDefaultValue,
  getTypeDogmaAttributes,
  isEffectivelyOnlineModule,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  buildConduitPassengerPlans,
  executeCynosuralConduitPassengerJumps,
  resolveConduitJumpActivation,
} = require(path.join(__dirname, "../_shared/conduitJumpRuntime"));
const {
  floorAfterNormalizing,
} = require(path.join(__dirname, "../_shared/floatPrecision"));
const {
  applyJumpTimersBestEffort,
  hasActiveJumpActivation,
  resolveJumpFatigueMultiplier,
  resolveJumpThroughFatigueMultiplier,
} = require(path.join(__dirname, "../_shared/jumpTimerRuntime"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  flushPendingCommandSessionEffects,
} = require(path.join(__dirname, "../chat/commandSessionEffects"));
const {
  getCynoJammerOnlineSimTime,
  isSolarSystemCynoJammed,
} = require(path.join(__dirname, "../sovereignty/sovSuppressionState"));
const {
  TYPE_PHAROLUX_CYNO_BEACON,
} = require(path.join(__dirname, "../sovereignty/sovUpgradeSupport"));
const fleetRuntime = require(path.join(__dirname, "../fleets/fleetRuntime"));
const {
  resolveFormationSettings,
  computeFleetWarpPointLandingPoints,
  computeFleetWarpFormationPoints,
} = require(path.join(__dirname, "../fleets/fleetWarpFormation.js"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
} = require(path.join(__dirname, "../structure/structureConstants"));
const planetRuntimeStore = require(path.join(__dirname, "../planet/planetRuntimeStore"));
const bookmarkRuntime = require(path.join(__dirname, "../bookmark/bookmarkRuntimeState"));
const bookmarkNotifications = require(path.join(__dirname, "../bookmark/bookmarkNotifications"));
const {
  buildBookmarkReplyTuple,
} = require(path.join(__dirname, "../bookmark/bookmarkPayloads"));
const {
  resolveLocationBookmarkTarget,
} = require(path.join(__dirname, "../bookmark/bookmarkTargetResolver"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  ROLEMASK_VIEW,
  normalizeRoleValue,
} = require(path.join(__dirname, "../account/accountRoleProfiles"));
const signatureRuntime = require(path.join(
  __dirname,
  "../exploration/signatures/signatureRuntime",
));
const probeScanWarpAuthority = require(path.join(
  __dirname,
  "../exploration/probes/probeScanWarpAuthority",
));
const dungeonRuntime = require(path.join(
  __dirname,
  "../dungeon/dungeonRuntime",
));
const {
  canSessionAccessDungeonInstance,
  resolveDungeonInstanceVisibilityForSession,
  isPrivateDungeonInstance,
  normalizeDungeonInstanceID,
} = require(path.join(
  __dirname,
  "../dungeon/dungeonVisibilityPolicy",
));
const operationSiteRuntime = require(path.join(
  __dirname,
  "../dungeon/operationSiteRuntime",
));
function getAbyssalMgrService() {
  return require("../../abyssal").beyonceIntegration;
}

const USER_ERROR_LOCALIZATION_LABEL = 101;
const STARGATE_CLOSED_LABEL = "UI/GateIcons/GateClosed";
const STARGATE_TOO_FAR_LABEL = "UI/Menusvc/MenuHints/NotWithingMaxJumpDist";
const CRIMEWATCH_WARP_BLOCKED_MESSAGE = "Warp is disabled while the criminal timer is active.";
const ABYSSAL_WARP_BLOCKED_MESSAGE = "You cannot warp out of Abyssal Deadspace.";
const ABYSSAL_FLEET_MEMBER_WARP_BLOCKED_MESSAGE =
  "You cannot warp to a fleet member inside Abyssal Deadspace.";
const ABYSSAL_JUMP_BRIDGE_BLOCKED_MESSAGE =
  "You cannot use jump drives or jump bridges inside Abyssal Deadspace.";
const ABYSSAL_BOOKMARK_BLOCKED_MESSAGE =
  "You cannot create or use bookmarks inside Abyssal Deadspace.";
const SHIP_IMMOBILE_WARP_BLOCKED_MESSAGE =
  "Your ship cannot warp while an active module is preventing movement.";
const SHARED_BOOKMARK_DELAY_MS = 2 * 60 * 1000;
const DUNGEON_INSTANCE_WARP_SUBJECTS = Object.freeze(new Set([
  "epinstance",
  "externalDungeon",
]));
const WARP_SUBJECT_OPERATION_DUNGEON = "operationDungeon";
const WARP_SUBJECT_MOON_MINING_POINT = "moonMiningPoint";
const LIGHT_YEAR_METERS = 9460730472580800;
const ATTRIBUTE_JUMP_DRIVE_CONSUMPTION_TYPE = 866;
const ATTRIBUTE_JUMP_DRIVE_RANGE = 867;
const ATTRIBUTE_JUMP_DRIVE_CONSUMPTION_AMOUNT = 868;
const ATTRIBUTE_JUMP_PORTAL_CONSUMPTION_MASS_FACTOR = 1001;
const ATTRIBUTE_JUMP_PORTAL_ADDITIONAL_CONSUMPTION = 2793;
const ATTRIBUTE_JUMP_PORTAL_PASSENGER_REQUIRED_ATTRIBUTE_ID = 3318;
const ATTRIBUTE_IS_TITAN_JUMP_PORTAL_PASSENGER = 3319;
const ATTRIBUTE_IS_BLACKOPS_JUMP_PORTAL_PASSENGER = 3320;
const ATTRIBUTE_IS_INDUSTRIAL_JUMP_PORTAL_PASSENGER = 3325;
const ATTRIBUTE_USES_COVERT_CYNO = 1252;
const ATTRIBUTE_USES_INDUSTRIAL_CYNO = 2826;
const ATTRIBUTE_MASS = 4;
// Which jump drives may lock onto which cynosural field. The rule exists only
// as prose on the two generators — 28646 "Generates an undetectable cynosural
// field which only Black Ops jump drives can lock on to", 52694 "Industrial
// Cynosural Fields are specifically attuned to support the jump drives of Jump
// Freighters and the Rorqual" — and both name a ship *class*. There is no
// ship-side dogma marker to read instead: `isCovert` (1252) is declared by four
// types (the covert generator, the Covert Mobile Cynosural Beacon and the two
// covert field entities) and `isIndustrialCyno` (2826) by two (the industrial
// generator and its field); no ship carries either and no effect projects them.
// So the gate is the group list the descriptions name, and nothing else.
const SHIP_GROUP_BLACK_OPS = 898;
const SHIP_GROUP_CAPITAL_INDUSTRIAL_SHIP = 883;
const SHIP_GROUP_JUMP_FREIGHTER = 902;
const COVERT_CYNO_JUMP_SHIP_GROUP_IDS = Object.freeze(new Set([
  SHIP_GROUP_BLACK_OPS,
]));
const INDUSTRIAL_CYNO_JUMP_SHIP_GROUP_IDS = Object.freeze(new Set([
  SHIP_GROUP_CAPITAL_INDUSTRIAL_SHIP,
  SHIP_GROUP_JUMP_FREIGHTER,
]));
const FLEET_BRIDGE_ACTIVATION_RANGE_METERS = 2500;
const MOVEMENT_COMMAND_THROTTLE_MS = 1000;
const EVE_TIME_TICKS_PER_MS = 10000;
const TYPE_JUMP_PORTAL_GENERATOR = 23953;
const TYPE_COVERT_JUMP_PORTAL_GENERATOR = 28652;
const TYPE_INDUSTRIAL_JUMP_PORTAL_GENERATOR = 63140;
const TYPE_CYNOSURAL_FIELD = 21094;
const TYPE_COVERT_CYNOSURAL_FIELD = 28650;
const TYPE_INDUSTRIAL_CYNOSURAL_FIELD = 52696;
const TYPE_MOBILE_CYNOSURAL_BEACON = 57319;
const TYPE_HIGHSEC_AUTHORIZED_MOBILE_CYNOSURAL_BEACON = 58906;
const TYPE_COVERT_MOBILE_CYNOSURAL_BEACON = 59630;
const TYPE_MOBILE_CYNOSURAL_FIELD = 59631;
const JUMP_PORTAL_EFFECT_STANDARD = "jumpPortalGeneration";
const JUMP_PORTAL_EFFECT_COVERT = "jumpPortalGenerationBO";
const MOBILE_CYNOSURAL_BEACON_TYPES = Object.freeze(new Set([
  TYPE_MOBILE_CYNOSURAL_BEACON,
  TYPE_HIGHSEC_AUTHORIZED_MOBILE_CYNOSURAL_BEACON,
  TYPE_COVERT_MOBILE_CYNOSURAL_BEACON,
]));
const JUMP_PORTAL_MASS_FACTOR_BY_TYPE_ID = Object.freeze({
  [TYPE_JUMP_PORTAL_GENERATOR]: 1.5e-9,
  [TYPE_COVERT_JUMP_PORTAL_GENERATOR]: 2e-7,
  [TYPE_INDUSTRIAL_JUMP_PORTAL_GENERATOR]: 1e-9,
});

// The dungeon a just-accepted warp is heading for, told to the pilot as TQ
// does (dungeonTrackingRuntime.notifyDistributionDungeonWarp).
function notifyDistributionDungeonForWarp(session, result) {
  const pendingWarp = result && result.data && typeof result.data === "object" ? result.data : null;
  const requested = pendingWarp && pendingWarp.requested && typeof pendingWarp.requested === "object"
    ? pendingWarp.requested
    : null;
  const instanceID = normalizeNumber(
    (requested && requested.destinationStaticInstanceID) ||
      (pendingWarp && pendingWarp.destinationStaticInstanceID),
    0,
  );
  if (instanceID <= 0) {
    return false;
  }
  try {
    return require("../dungeon/dungeonTrackingRuntime").notifyDistributionDungeonWarp(session, instanceID);
  } catch (error) {
    log.warn(`[Beyonce] OnDistributionDungeonEntered failed for instance=${instanceID}: ${error.message}`);
    return false;
  }
}

function getKwargValue(kwargs, key) {
  const entries = extractDictEntries(kwargs);
  // String(entryKey) resolves a Buffer key only because Buffer.toString defaults to
  // utf8, and yields "[object Object]" for the {type, value} forms the decoder also
  // produces. See the note on accountService.extractKwarg.
  const match = entries.find(
    ([entryKey]) => unwrapMarshalValue(entryKey) === String(key),
  );
  if (match) {
    return match[1];
  }

  // Real client calls arrive as a marshaled dict ({ type: "dict", entries }),
  // handled above. Internal/test callers sometimes pass a plain object, so fall
  // back to a direct property lookup the same way machoNet's getKwarg does.
  if (
    kwargs &&
    typeof kwargs === "object" &&
    !Array.isArray(kwargs) &&
    Object.prototype.hasOwnProperty.call(kwargs, key)
  ) {
    return kwargs[key];
  }

  return null;
}

function buildDockingApproachUserErrorValues(dockingDebug = null) {
  const distance = Math.max(
    0,
    Math.round(Number(dockingDebug && dockingDebug.dockingDistance) || 0),
  );
  return { distance };
}

function getBookmarkSubfolderID(kwargs) {
  return normalizeNumber(getKwargValue(kwargs, "subfolderID"), 0) || null;
}

function extractDungeonInstanceID(rawTarget) {
  const numericTarget = normalizeDungeonInstanceID(rawTarget);
  if (numericTarget !== null) {
    return numericTarget;
  }

  if (!rawTarget || typeof rawTarget !== "object") {
    return 0;
  }

  const candidates = [];
  for (const key of [
    "instanceID",
    "dungeonInstanceID",
    "permanentID",
    "permanent_id",
    "permanent",
    "value",
    "_value",
  ]) {
    if (Object.prototype.hasOwnProperty.call(rawTarget, key)) {
      candidates.push(rawTarget[key]);
    }
  }

  if (
    (rawTarget.type === "objectex1" || rawTarget.type === "objectex2") &&
    Array.isArray(rawTarget.header)
  ) {
    const headerArgs = Array.isArray(rawTarget.header[1])
      ? rawTarget.header[1]
      : [];
    candidates.push(...headerArgs);
    if (
      rawTarget.header.length > 2 &&
      rawTarget.header[2] &&
      rawTarget.header[2].type === "dict" &&
      Array.isArray(rawTarget.header[2].entries)
    ) {
      for (const [, value] of rawTarget.header[2].entries) {
        candidates.push(value);
      }
    }
  }

  for (const candidate of candidates) {
    const numericCandidate = normalizeDungeonInstanceID(candidate);
    if (numericCandidate !== null) {
      return numericCandidate;
    }
  }

  return 0;
}

function filetimeToMs(filetimeStr) {
  if (filetimeStr == null) {
    return 0;
  }
  try {
    const EVE_EPOCH_OFFSET_MS = 11644473600000n;
    return Number(BigInt(filetimeStr) / 10000n - EVE_EPOCH_OFFSET_MS);
  } catch (_) {
    // ignored: an unreadable FILETIME counts as 0
    return 0;
  }
}

function isBookmarkDelayed(bookmark, charID) {
  if (!bookmark || !bookmark.creatorID) {
    return false;
  }
  if (Number(bookmark.creatorID) === Number(charID)) {
    return false;
  }

  const createdMs = filetimeToMs(bookmark.created);
  if (createdMs <= 0) {
    return false;
  }

  return Date.now() - createdMs < SHARED_BOOKMARK_DELAY_MS;
}

function resolveBookmarkAnyStore(session, bookmarkID) {
  const charID = session && session.characterID;
  const runtimeBookmark = bookmarkRuntime.getBookmarkForCharacter(charID, bookmarkID, {
    requireActive: true,
  });
  if (!runtimeBookmark) {
    return null;
  }
  const bookmark = runtimeBookmark.bookmark || runtimeBookmark;
  // Shared (group) folders hide freshly-created bookmarks from non-creators for
  // a short window so the author can correct mistakes before others warp to it.
  if (isBookmarkDelayed(bookmark, charID)) {
    log.info(
      `[Beyonce] Bookmark ${bookmarkID} is still in the shared delay window for char=${charID}`,
    );
    return null;
  }
  return bookmark;
}

function hasBeyonceViewRole(session) {
  if (!session || typeof session !== "object") {
    return false;
  }

  const roleMask = normalizeRoleValue(
    session.role ?? session.accountRole ?? session.accountRoles,
    0n,
  );
  return (roleMask & ROLEMASK_VIEW) !== 0n;
}

function resolveBookmarkAlignTarget(session, bookmarkID) {
  const bookmark = resolveBookmarkAnyStore(session, bookmarkID);
  return normalizeNumber(bookmark && bookmark.itemID, 0);
}

function addBookmarkToFolder(charID, folderID, bookmarkOpts) {
  let created;
  try {
    created = bookmarkRuntime.createBookmark(charID, { ...bookmarkOpts, folderID });
  } catch (error) {
    if (error && error.bookmarkError) {
      throwWrappedUserError(error.bookmarkError);
    }
    throw error;
  }
  bookmarkNotifications.notifyBookmarksAdded(folderID, [created.bookmark], {
    excludeCharacterID: charID,
  });
  return buildBookmarkReplyTuple(created.bookmark);
}

function resolveBookmarkTargetForSession(session, bookmarkID, options = {}) {
  const bookmarkInfo = bookmarkRuntime.getBookmarkForCharacter(
    session && session.characterID,
    bookmarkID,
    options,
  );
  if (!bookmarkInfo) {
    return null;
  }
  const target = bookmarkRuntime.resolveBookmarkTarget(bookmarkID);
  return target ? { ...target, bookmarkInfo } : null;
}

function isDockedStructureObserverSession(session) {
  return Boolean(
    !session?._space &&
      Number(session && (session.structureID || session.structureid)) > 0 &&
      Number(session && (session.solarsystemid || session.solarsystemid2)) > 0,
  );
}

function summarizeRecentDestinyLedgerEvents(session, limit = 12) {
  return (Array.isArray(session && session._syncLedgerEvents)
    ? session._syncLedgerEvents
    : [])
    .filter((entry) => (
      entry &&
      (
        String(entry.event || "").startsWith("destiny.") ||
        (
          entry.event === "packet.sent" &&
          entry.details &&
          entry.details.destiny
        )
      )
    ))
    .slice(-Math.max(1, normalizeNumber(limit, 12)))
    .map((entry) => {
      const details = entry.details || {};
      const updateSummary = details.updates || details.destiny || {};
      return {
        ts: entry.ts || null,
        seq: normalizeNumber(entry.seq, 0),
        event: String(entry.event || "unknown"),
        stamp: details.stamp ?? null,
        rawDispatchStamp: details.rawDispatchStamp ?? null,
        packetSeq: details.packetSeq ?? null,
        updateNames: Array.isArray(updateSummary.uniqueNames)
          ? updateSummary.uniqueNames
          : [],
      };
    });
}

function bootstrapSessionBallpark(session, options = {}) {
  if (isDockedStructureObserverSession(session)) {
    return spaceRuntime.bootstrapDockedStructureView(session, options);
  }

  const locationBeforeRecovery = getSessionSolarSystemID(session);
  const recoveryResult = recoverAbyssalHostSessionBeforeBeyonceBind(session);
  const locationAfterRecovery = getSessionSolarSystemID(session);
  if (
    isAbyssalHostLocationID(locationBeforeRecovery) &&
    isAbyssalHostLocationID(locationAfterRecovery) &&
    !(
      recoveryResult &&
      (
        recoveryResult.recovered === true ||
        recoveryResult.evacuated === true ||
        recoveryResult.activeRunBound === true
      )
    )
  ) {
    log.warn(
      `[BeyonceBootstrap] unresolved abyssal host location ` +
        `char=${normalizeNumber(session && session.characterID, 0)} location=${locationAfterRecovery} ` +
        `reason=${String(recoveryResult && recoveryResult.reason || "NO_RECOVERY_RESULT")}`,
    );
    throwWrappedUserError("CustomInfo", {
      info: "Abyssal recovery is still resolving your space location. Please reconnect shortly.",
    });
  }
  const setStatePreviouslyDelivered = Boolean(
    session && session._space && session._space.initialStateSent === true
  );
  spaceRuntime.markBeyonceBound(session);
  const activeAbyssalRecovery = Boolean(
    recoveryResult &&
      recoveryResult.evacuated !== true &&
      (recoveryResult.recovered === true || recoveryResult.activeRunBound === true)
  );
  const routedBootstrapMode = String(recoveryResult && recoveryResult.route || "").trim();
  const bootstrapMode = !activeAbyssalRecovery
    ? "active-bind"
    : setStatePreviouslyDelivered
      ? "active-bind"
      : ["fresh-entry", "active-bind", "relog-recovery"].includes(routedBootstrapMode)
        ? routedBootstrapMode
        : (
          (recoveryResult && recoveryResult.recovered === true) ||
          (session && session._abyssalBootstrapMode === "relog-recovery")
        )
        ? "relog-recovery"
        : "fresh-entry";
  let guardedBootstrapResult = null;
  let bootstrapResult = null;
  let abyssalMgrService = null;
  if (activeAbyssalRecovery) {
    abyssalMgrService = require("../../abyssal").beyonceIntegration;
    guardedBootstrapResult =
      abyssalMgrService &&
      typeof abyssalMgrService.ensureClientReadyBallparkPrimed === "function"
        ? abyssalMgrService.ensureClientReadyBallparkPrimed(session, { mode: bootstrapMode })
        : {
            primed: false,
            reason: "GUARDED_BOOTSTRAP_UNAVAILABLE",
            validationReason: "GUARDED_BOOTSTRAP_UNAVAILABLE",
          };
    bootstrapResult = Boolean(guardedBootstrapResult && guardedBootstrapResult.primed === true);
  } else {
    bootstrapResult = spaceRuntime.ensureInitialBallpark(session, options);
  }
  if (
    bootstrapMode === "fresh-entry" &&
    bootstrapResult !== true &&
    abyssalMgrService &&
    typeof abyssalMgrService.rollbackFreshEntryBootstrapForBeyonce === "function"
  ) {
    const rollbackReason = String(
      guardedBootstrapResult &&
        (guardedBootstrapResult.validationReason || guardedBootstrapResult.reason) ||
        "FRESH_ENTRY_SETSTATE_FAILED",
    );
    const rollbackResult = abyssalMgrService.rollbackFreshEntryBootstrapForBeyonce(
      session,
      rollbackReason,
    );
    if (rollbackResult && rollbackResult.evacuated === true) {
      spaceRuntime.markBeyonceBound(session);
      bootstrapResult = spaceRuntime.ensureInitialBallpark(session, options);
    }
  }
  const scene =
    typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  const ego =
    scene && typeof scene.getShipEntityForSession === "function"
      ? scene.getShipEntityForSession(session)
      : null;
  const slimCount =
    scene && typeof scene.getVisibleEntitiesForSession === "function"
      ? scene.getVisibleEntitiesForSession(session).length
      : 0;
  const valid = Boolean(bootstrapResult && scene && ego);
  const validationReason = valid
    ? "VALID"
    : !bootstrapResult
      ? String(
          guardedBootstrapResult &&
            (guardedBootstrapResult.validationReason || guardedBootstrapResult.reason) ||
            "INITIAL_BALLPARK_BOOTSTRAP_FAILED",
        )
      : !scene
        ? "POST_BOOTSTRAP_SCENE_NOT_FOUND"
        : !ego
          ? "POST_BOOTSTRAP_EGO_NOT_FOUND"
          : "POST_BOOTSTRAP_VALIDATION_FAILED";
  log.info(
    `[BeyonceBootstrap] mode=${bootstrapMode} ` +
      `char=${normalizeNumber(session && session.characterID, 0)} ` +
      `run=${normalizeNumber(guardedBootstrapResult && guardedBootstrapResult.runID, 0)} ` +
      `room=${normalizeNumber(guardedBootstrapResult && guardedBootstrapResult.roomIndex, 0)} ` +
      `sceneKey=${session && session._space && session._space.sceneKey || session && session.spaceSceneKey || "none"} ` +
      `ship=${normalizeNumber(session && (session.shipID || session.shipid || session.activeShipID), 0)} ` +
      `ego=${ego ? normalizeNumber(ego.itemID, 0) : 0} ` +
      `setStateSlimCount=${normalizeNumber(
        guardedBootstrapResult && guardedBootstrapResult.setStateSlimCount,
        slimCount,
      )} ` +
      `participantShipCount=${normalizeNumber(
        guardedBootstrapResult && guardedBootstrapResult.participantShipCount,
        ego ? 1 : 0,
      )} ` +
      `visibleRoomEntityCount=${normalizeNumber(
        guardedBootstrapResult && guardedBootstrapResult.visibleRoomEntityCount,
        0,
      )} ` +
      `expectedRoomEntityCount=${normalizeNumber(
        guardedBootstrapResult && guardedBootstrapResult.expectedRoomEntityCount,
        0,
      )} ` +
      `stalePriorRoomEntityCount=${normalizeNumber(
        guardedBootstrapResult && guardedBootstrapResult.stalePriorRoomEntityCount,
        0,
      )} ` +
      `foreignRunEntityCount=${normalizeNumber(
        guardedBootstrapResult && guardedBootstrapResult.foreignRunEntityCount,
        0,
      )} ` +
      `recipientMember=${Boolean(guardedBootstrapResult && guardedBootstrapResult.recipientMember)} ` +
      `layoutMatches=${Boolean(guardedBootstrapResult && guardedBootstrapResult.layoutMatches)} ` +
      `route=${String(recoveryResult && recoveryResult.route || "none")} ` +
      `bootstrapToken=${normalizeNumber(recoveryResult && recoveryResult.bootstrapToken, 0)} ` +
      `setStatePreviouslyDelivered=${setStatePreviouslyDelivered} ` +
      `valid=${valid} reason=${validationReason}`,
  );
  if (!valid) {
    throwWrappedUserError("CustomInfo", {
      info: "Your space location could not be restored yet. Please reconnect shortly.",
    });
  }
  completeAbyssalEntryReadyAfterBallparkBootstrap(session);
  completeAbyssalKSpaceArrivalAfterBallparkBootstrap(session);
  return bootstrapResult;
}

function prepareSessionBallpark(session) {
  if (
    isDockedStructureObserverSession(session)
  ) {
    return spaceRuntime.prepareDockedStructureView(session);
  }

  return bootstrapSessionBallpark(session, {
    allowDeferredJumpBootstrapVisuals: true,
  });
}

function getSessionSolarSystemID(session) {
  return normalizeNumber(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    0,
  );
}

function recoverAbyssalHostSessionBeforeBeyonceBind(session) {
  if (!isAbyssalHostLocationID(getSessionSolarSystemID(session))) {
    return null;
  }
  try {
    const AbyssalMgrService = require("../../abyssal").beyonceIntegration;
    if (
      AbyssalMgrService &&
      typeof AbyssalMgrService.recoverAbyssalSessionStateForBeyonce === "function"
    ) {
      const result = AbyssalMgrService.recoverAbyssalSessionStateForBeyonce(session);
      log.info(
        `[Beyonce] Abyssal pre-bind route char=${normalizeNumber(session && session.characterID, 0)} ` +
          `location=${getSessionSolarSystemID(session)} recovered=${Boolean(result && result.recovered === true)} ` +
          `evacuated=${Boolean(result && result.evacuated === true)} ` +
          `activeRunBound=${Boolean(result && result.activeRunBound === true)} ` +
          `route=${String(result && result.route || "relog-recovery")} ` +
          `bootstrapToken=${normalizeNumber(result && result.bootstrapToken, 0)} ` +
          `reason=${String(result && result.reason || "none")}`,
      );
      return result;
    }
  } catch (error) {
    log.warn(
      `[Beyonce] Abyssal pre-bind recovery failed ` +
        `char=${normalizeNumber(session && session.characterID, 0)} reason=${error && error.message || "UNKNOWN"}`,
    );
  }
  return null;
}

function completeAbyssalEntryReadyAfterBallparkBootstrap(session) {
  if (!isAbyssalHostLocationID(getSessionSolarSystemID(session))) {
    return null;
  }
  try {
    const AbyssalMgrService = require("../../abyssal").beyonceIntegration;
    if (
      AbyssalMgrService &&
      typeof AbyssalMgrService.completeAbyssalEntryReadyForBeyonce === "function"
    ) {
      const result = AbyssalMgrService.completeAbyssalEntryReadyForBeyonce(session);
      log.info(
        `[Beyonce] Abyssal post-SetState entry readiness ` +
          `char=${normalizeNumber(session && session.characterID, 0)} ` +
          `location=${getSessionSolarSystemID(session)} ` +
          `success=${Boolean(result && result.success === true)} ` +
          `deferred=${Boolean(result && result.deferred === true)} ` +
          `reason=${String(result && result.reason || "none")}`,
      );
      return result;
    }
  } catch (error) {
    log.warn(
      `[Beyonce] Abyssal post-SetState entry readiness failed ` +
        `char=${normalizeNumber(session && session.characterID, 0)} ` +
        `reason=${error && error.message || "UNKNOWN"}`,
    );
  }
  return null;
}

function completeAbyssalKSpaceArrivalAfterBallparkBootstrap(session) {
  try {
    const AbyssalMgrService = require("../../abyssal").beyonceIntegration;
    if (
      AbyssalMgrService &&
      typeof AbyssalMgrService.completeAbyssalKSpaceArrivalForBeyonce === "function"
    ) {
      const result = AbyssalMgrService.completeAbyssalKSpaceArrivalForBeyonce(session);
      if (result) {
        log.info(
          `[Beyonce] Abyssal K-space post-SetState arrival ` +
            `char=${normalizeNumber(session && session.characterID, 0)} ` +
            `location=${getSessionSolarSystemID(session)} ` +
            `success=${Boolean(result.success === true)} ` +
            `scheduled=${Boolean(result.scheduled === true)} ` +
            `reason=${String(result.reason || "none")}`,
        );
      }
      return result;
    }
  } catch (error) {
    log.warn(
      `[Beyonce] Abyssal K-space post-SetState arrival failed ` +
        `char=${normalizeNumber(session && session.characterID, 0)} ` +
        `reason=${error && error.message || "UNKNOWN"}`,
    );
  }
  return null;
}

function getSessionCharacterID(session) {
  return operationSiteRuntime.getCharacterID(session);
}

function normalizeInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  const numeric = normalizeInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function cloneVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  const source = value && typeof value === "object" ? value : fallback;
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function vectorMagnitude(vector) {
  return Math.sqrt(
    (toFiniteNumber(vector && vector.x, 0) ** 2) +
      (toFiniteNumber(vector && vector.y, 0) ** 2) +
      (toFiniteNumber(vector && vector.z, 0) ** 2),
  );
}

function throwCynoNotify(message) {
  throwWrappedUserError("CustomNotify", {
    notify: String(message || "The cynosural beacon cannot be used right now."),
  });
}


function throwIfJumpActivationActive(session) {
  if (hasActiveJumpActivation(session && session.characterID)) {
    throwCynoNotify(
      "You cannot use a jump drive, jump bridge, or jump portal while your jump activation cooldown is active.",
    );
  }
}

function getSolarSystemDistanceLy(sourceSolarSystemID, destinationSolarSystemID) {
  const sourceSystem = worldData.getSolarSystemByID(sourceSolarSystemID);
  const destinationSystem = worldData.getSolarSystemByID(destinationSolarSystemID);
  if (
    !sourceSystem ||
      !destinationSystem ||
      !sourceSystem.position ||
      !destinationSystem.position
  ) {
    return null;
  }

  const distanceMeters = vectorMagnitude(subtractVectors(
    sourceSystem.position,
    destinationSystem.position,
  ));
  return distanceMeters / LIGHT_YEAR_METERS;
}

function syncInventoryChanges(session, changes = []) {
  if (!session || typeof syncInventoryItemForSession !== "function") {
    return;
  }
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(session, change.item, change.previousData || {}, {
      emitCfgLocation: false,
    });
  }
}

function getResourceAttributes(resourceState) {
  return resourceState && resourceState.attributes && typeof resourceState.attributes === "object"
    ? resourceState.attributes
    : {};
}

function getEntitySurfaceDistanceMeters(leftEntity, rightEntity) {
  if (!leftEntity || !rightEntity) {
    return Number.POSITIVE_INFINITY;
  }
  const centerDistance = vectorMagnitude(subtractVectors(
    cloneVector(leftEntity.position),
    cloneVector(rightEntity.position),
  ));
  const leftRadius = Math.max(0, toFiniteNumber(leftEntity.radius, 0));
  const rightRadius = Math.max(0, toFiniteNumber(rightEntity.radius, 0));
  return Math.max(0, centerDistance - leftRadius - rightRadius);
}

function getRequiredPortalPassengerAttributeForField(fieldTypeID) {
  const normalizedFieldTypeID = normalizePositiveInt(fieldTypeID, TYPE_CYNOSURAL_FIELD);
  if (normalizedFieldTypeID === TYPE_COVERT_CYNOSURAL_FIELD) {
    return ATTRIBUTE_IS_BLACKOPS_JUMP_PORTAL_PASSENGER;
  }
  if (normalizedFieldTypeID === TYPE_INDUSTRIAL_CYNOSURAL_FIELD) {
    return ATTRIBUTE_IS_INDUSTRIAL_JUMP_PORTAL_PASSENGER;
  }
  return ATTRIBUTE_IS_TITAN_JUMP_PORTAL_PASSENGER;
}

function isMobileCynoBeaconDeployableType(typeID) {
  return MOBILE_CYNOSURAL_BEACON_TYPES.has(normalizePositiveInt(typeID, 0));
}

function typeHasDogmaFlag(typeID, attributeID) {
  const attributes = getTypeDogmaAttributes(normalizePositiveInt(typeID, 0));
  return toFiniteNumber(attributes && attributes[attributeID], 0) > 0;
}

function resolveKnownCynoAnchorFieldTypeID(typeID, fallback = 0) {
  const normalizedTypeID = normalizePositiveInt(typeID, 0);
  if (
    normalizedTypeID === TYPE_CYNOSURAL_FIELD ||
      normalizedTypeID === TYPE_COVERT_CYNOSURAL_FIELD ||
      normalizedTypeID === TYPE_INDUSTRIAL_CYNOSURAL_FIELD
  ) {
    return normalizedTypeID;
  }
  if (
    normalizedTypeID === TYPE_MOBILE_CYNOSURAL_BEACON ||
      normalizedTypeID === TYPE_HIGHSEC_AUTHORIZED_MOBILE_CYNOSURAL_BEACON
  ) {
    return TYPE_CYNOSURAL_FIELD;
  }
  if (normalizedTypeID === TYPE_COVERT_MOBILE_CYNOSURAL_BEACON) {
    return TYPE_COVERT_CYNOSURAL_FIELD;
  }
  if (normalizedTypeID === TYPE_MOBILE_CYNOSURAL_FIELD) {
    if (typeHasDogmaFlag(normalizedTypeID, ATTRIBUTE_USES_COVERT_CYNO)) {
      return TYPE_COVERT_CYNOSURAL_FIELD;
    }
    if (typeHasDogmaFlag(normalizedTypeID, ATTRIBUTE_USES_INDUSTRIAL_CYNO)) {
      return TYPE_INDUSTRIAL_CYNOSURAL_FIELD;
    }
    return TYPE_CYNOSURAL_FIELD;
  }
  return fallback;
}

function resolveDeployableBeaconFieldTypeID(deployableEntity, fieldEntity) {
  const deployableTypeID = normalizePositiveInt(deployableEntity && deployableEntity.typeID, 0);
  if (deployableTypeID > 0) {
    if (!isMobileCynoBeaconDeployableType(deployableTypeID)) {
      throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
    }
    return resolveKnownCynoAnchorFieldTypeID(deployableTypeID, TYPE_CYNOSURAL_FIELD);
  }

  const fieldTypeID = normalizePositiveInt(fieldEntity && fieldEntity.typeID, 0);
  const resolvedFieldTypeID = resolveKnownCynoAnchorFieldTypeID(fieldTypeID, 0);
  if (fieldTypeID > 0 && resolvedFieldTypeID <= 0) {
    throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
  }
  return resolvedFieldTypeID || TYPE_CYNOSURAL_FIELD;
}

function isDeployableCynoAnchorType(typeID) {
  const normalizedTypeID = normalizePositiveInt(typeID, 0);
  return (
    normalizedTypeID === TYPE_MOBILE_CYNOSURAL_FIELD ||
      isMobileCynoBeaconDeployableType(normalizedTypeID)
  );
}

function resolveJumpPortalMassFactor(moduleItem, moduleAttributes) {
  const dogmaValue = toFiniteNumber(
    moduleAttributes && moduleAttributes[ATTRIBUTE_JUMP_PORTAL_CONSUMPTION_MASS_FACTOR],
    0,
  );
  if (dogmaValue > 0) {
    return dogmaValue;
  }
  const typeID = normalizePositiveInt(moduleItem && moduleItem.typeID, 0);
  return Math.max(0, toFiniteNumber(JUMP_PORTAL_MASS_FACTOR_BY_TYPE_ID[typeID], 0));
}

// A type only lists a dogma attribute where it differs from the SDE's default,
// so an absent row means "the default", not zero. That distinction is the whole
// mechanic here: `isTitanJumpPortalPassenger` (3319) defaults to **1** and is
// declared — as 0 — by exactly the fifty hulls CCP bars from a titan bridge
// (every capital, supercapital, jump freighter and the Rorqual). Every ordinary
// subcapital carries no row at all, so reading a missing row as 0 refused the
// entire fleet and a titan bridge could be opened but never used.
// `isBlackOpsJumpPortalPassenger` (3320) and `isIndustrialJumpPortalPassenger`
// (3325) default to 0 and are declared as 1 by their eligible hulls, so they are
// unaffected by the fallback and stay exactly as restrictive as before.
function isEligibleJumpPortalPassenger(
  passengerAttributes,
  requiredPassengerAttributeID,
) {
  const attributeID = normalizePositiveInt(requiredPassengerAttributeID, 0);
  if (attributeID <= 0) {
    return false;
  }
  const declared = passengerAttributes
    ? passengerAttributes[attributeID]
    : undefined;
  if (declared !== undefined && declared !== null) {
    return toFiniteNumber(declared, 0) > 0;
  }
  const defaultValue = getDogmaAttributeDefaultValue(attributeID);
  return Number.isFinite(defaultValue) && defaultValue > 0;
}

function resolveBridgePortalModule(bridgeCharacterID, bridgeShip, fieldTypeID) {
  const bridgeResourceState = buildShipResourceState(bridgeCharacterID, bridgeShip);
  const requiredPassengerAttributeID =
    getRequiredPortalPassengerAttributeForField(fieldTypeID);
  const fittedItems = Array.isArray(bridgeResourceState.fittedItems)
    ? bridgeResourceState.fittedItems
    : [];
  for (const fittedItem of fittedItems) {
    if (!isEffectivelyOnlineModule(fittedItem)) {
      continue;
    }
    const moduleAttributes = buildEffectiveItemAttributeMap(fittedItem);
    const modulePassengerAttributeID = normalizePositiveInt(
      moduleAttributes[ATTRIBUTE_JUMP_PORTAL_PASSENGER_REQUIRED_ATTRIBUTE_ID],
      0,
    );
    if (modulePassengerAttributeID !== requiredPassengerAttributeID) {
      continue;
    }
    const portalMassFactor = resolveJumpPortalMassFactor(
      fittedItem,
      moduleAttributes,
    );
    if (portalMassFactor <= 0) {
      throwCynoNotify(
        "That jump portal generator is missing its portal fuel mass factor.",
      );
    }
    return {
      bridgeResourceState,
      moduleAttributes,
      portalMassFactor,
      portalModuleItem: fittedItem,
      requiredPassengerAttributeID,
      additionalConsumption: Math.max(
        0,
        toFiniteNumber(
          moduleAttributes[ATTRIBUTE_JUMP_PORTAL_ADDITIONAL_CONSUMPTION],
          0,
        ),
      ),
    };
  }
  throwCynoNotify(
    "Your ship is not fitted with an online jump portal generator for that cynosural field.",
  );
}

function getBridgePortalEffectName(portalModuleItem) {
  const typeID = normalizePositiveInt(portalModuleItem && portalModuleItem.typeID, 0);
  return typeID === TYPE_COVERT_JUMP_PORTAL_GENERATOR
    ? JUMP_PORTAL_EFFECT_COVERT
    : JUMP_PORTAL_EFFECT_STANDARD;
}

function fieldTypeRequiresCovertCompatibility(fieldTypeID) {
  return normalizePositiveInt(fieldTypeID, 0) === TYPE_COVERT_CYNOSURAL_FIELD;
}

function fieldTypeRequiresIndustrialCompatibility(fieldTypeID) {
  return normalizePositiveInt(fieldTypeID, 0) === TYPE_INDUSTRIAL_CYNOSURAL_FIELD;
}

function resolveShipGroupID(shipItem) {
  const direct = normalizePositiveInt(shipItem && shipItem.groupID, 0);
  if (direct > 0) {
    return direct;
  }
  const typeRecord = resolveItemByTypeID(
    normalizePositiveInt(shipItem && (shipItem.typeID || shipItem.shipTypeID), 0),
  );
  return normalizePositiveInt(typeRecord && typeRecord.groupID, 0);
}

function canShipJumpToCovertCynosuralField(shipItem) {
  return COVERT_CYNO_JUMP_SHIP_GROUP_IDS.has(resolveShipGroupID(shipItem));
}

function canShipJumpToIndustrialCynosuralField(shipItem) {
  return INDUSTRIAL_CYNO_JUMP_SHIP_GROUP_IDS.has(resolveShipGroupID(shipItem));
}

// `options.portalBridge` marks the two *bridge* entry points, where the ship
// does not travel and the covert / industrial compatibility of the far-end
// cynosural field is decided by the fitted Jump Portal Generator rather than by
// the hull. `resolveBridgePortalModule` enforces that immediately afterwards,
// matching the module's own `jumpPortalPassengerRequiredAttributeID` (3318)
// against the field type: the Covert Jump Portal Generator declares 3320 and
// only fits Black Ops, the Industrial one declares 3325 and only fits the
// Rorqual. On the four *jump* entry points the ship does travel, and the rule
// that applies is the one the two generator descriptions state: only a Black
// Ops jump drive locks a covert field, only a Jump Freighter's or the
// Rorqual's locks an industrial one.
function resolveActiveShipAndJumpDriveForCyno(
  session,
  destinationSolarSystemID,
  fieldTypeID,
  options = {},
) {
  const characterID = normalizePositiveInt(session && session.characterID, 0);
  const activeShip = getActiveShipRecord(characterID);
  if (!activeShip) {
    throwCynoNotify("You need an active ship to use a cynosural beacon.");
  }
  if (require("../spaceComponents/shipLinkRestrictions").blocksShipAction(spaceRuntime.getEntity(session, activeShip.itemID), "blocksJumpOrDock")) {
    throwCynoNotify("A running ship link prevents jumping.");
  }
  const portalBridge = options.portalBridge === true;

  const resourceState = buildShipResourceState(characterID, activeShip);
  const attributes =
    resourceState && resourceState.attributes && typeof resourceState.attributes === "object"
      ? resourceState.attributes
      : {};
  const jumpRangeLy = toFiniteNumber(attributes[ATTRIBUTE_JUMP_DRIVE_RANGE], 0);
  const fuelTypeID = normalizePositiveInt(
    attributes[ATTRIBUTE_JUMP_DRIVE_CONSUMPTION_TYPE],
    0,
  );
  const fuelAmountPerLy = toFiniteNumber(
    attributes[ATTRIBUTE_JUMP_DRIVE_CONSUMPTION_AMOUNT],
    0,
  );

  if (jumpRangeLy <= 0 || fuelTypeID <= 0 || fuelAmountPerLy <= 0) {
    throwCynoNotify("Your ship is not capable of jumping to a cynosural beacon.");
  }
  // The compatibility is the hull's ship class, not a dogma row: see
  // COVERT_CYNO_JUMP_SHIP_GROUP_IDS. Reading `isCovert` / `isIndustrialCyno`
  // off the ship — as this did — is always false, because both are markers on
  // the generator, the deployable beacon and the field entity, so a Black Ops
  // could not jump to a covert field and a Rorqual could not jump to an
  // industrial one. Both refusals still fire for every other hull.
  if (
    !portalBridge &&
      fieldTypeRequiresCovertCompatibility(fieldTypeID) &&
      !canShipJumpToCovertCynosuralField(activeShip)
  ) {
    throwCynoNotify("Your ship cannot jump to covert cynosural fields.");
  }
  if (
    !portalBridge &&
      fieldTypeRequiresIndustrialCompatibility(fieldTypeID) &&
      !canShipJumpToIndustrialCynosuralField(activeShip)
  ) {
    throwCynoNotify("Your ship cannot jump to industrial cynosural fields.");
  }

  const sourceSolarSystemID = getSessionSolarSystemID(session);
  const distanceLy = getSolarSystemDistanceLy(sourceSolarSystemID, destinationSolarSystemID);
  if (distanceLy === null) {
    throwCynoNotify("The distance to that cynosural beacon could not be calculated.");
  }
  if (distanceLy <= 0) {
    throwCynoNotify("You are already in that solar system.");
  }
  if (distanceLy > jumpRangeLy + 0.000001) {
    throwCynoNotify("That cynosural beacon is outside your jump range.");
  }

  return {
    activeShip,
    distanceLy,
    fuelTypeID,
    // jumpDriveConsumptionAmount (868) reaches this multiplication through a
    // chain of PostPercent bonuses — Jump Fuel Conservation, the jump-freighter
    // hull bonus, the online-module bonus — so a rate that is exact in decimal
    // arrives as a float that is a hair low: a Black Ops hull's 700 becomes
    // 489.99999999999994 at Jump Fuel Conservation III rather than 490.
    // Truncating that bills the pilot short, which is the Liquid Ozone defect
    // wearing a different attribute. Normalize the product before flooring.
    fuelQuantity: Math.max(0, floorAfterNormalizing(distanceLy * fuelAmountPerLy)),
    jumpRangeLy,
    resourceState,
  };
}

async function jumpCynosuralAnchorAndPassengers(session, destinationSolarSystemID, options, passengerOptions, anchorTimerOptions) {
  let conduitPassengerResult = null;
  let passengerJumps = null;
  let jumpResult;
  let resolveAnchorTransfer;
  const anchorTransferred = new Promise((resolve) => { resolveAnchorTransfer = resolve; });
  try {
    jumpResult = await jumpSessionToCynosuralBeacon(session, destinationSolarSystemID, {
      ...options,
      onDepartureAccepted: () => {
        if (passengerOptions) {
          passengerJumps = executeCynosuralConduitPassengerJumps({
            ...passengerOptions,
            waitForAnchorTransfer: () => anchorTransferred,
          });
        }
      },
    });
    if (jumpResult.success) applyJumpTimersBestEffort(session, anchorTimerOptions);
  } finally {
    // Departure effects run together, but no passenger may cross before the
    // anchor's paid transfer succeeds. An abort or fuel failure releases the
    // waiters with a refusal, and the anchor's timers start before they resume.
    resolveAnchorTransfer(Boolean(jumpResult && jumpResult.success));
    if (passengerJumps) conduitPassengerResult = await passengerJumps;
  }
  return { jumpResult, conduitPassengerResult };
}

function assertJumpFuelAvailable(session, activeShip, shipEntity, fuelTypeID, fuelQuantity) {
  const fuelEntity = shipEntity || { kind: "ship", itemID: activeShip.itemID };
  const stacks = getFuelStacksForShipStorage(fuelEntity, fuelTypeID, {
    resolveCharacterID: () => normalizePositiveInt(session && session.characterID, 0),
  });
  if (getFuelQuantityFromStacks(stacks) < fuelQuantity) {
    throwCynoNotify("Your ship does not have enough jump fuel.");
  }
}

function consumeJumpFuel(session, activeShip, shipEntity, fuelTypeID, fuelQuantity) {
  const quantity = normalizeInt(fuelQuantity, 0);
  if (quantity <= 0) {
    return {
      consumedQuantity: 0,
      changes: [],
    };
  }

  const fuelEntity = shipEntity || {
    kind: "ship",
    itemID: normalizePositiveInt(activeShip && activeShip.itemID, 0),
  };
  const fuelResult = consumeFuelFromShipStorage(
    fuelEntity,
    fuelTypeID,
    quantity,
    {
      resolveCharacterID: () => normalizePositiveInt(session && session.characterID, 0),
    },
  );
  if (!fuelResult.success) {
    throwCynoNotify("Your ship does not have enough jump fuel.");
  }
  syncInventoryChanges(session, fuelResult.changes);
  return fuelResult;
}

function calculateBridgeFuelQuantity({
  distanceLy,
  passengerMass,
  portalMassFactor,
  fuelAmountPerLy,
  additionalConsumption,
}) {
  const rawQuantity =
    Math.max(0, toFiniteNumber(distanceLy, 0)) *
    Math.max(0, toFiniteNumber(passengerMass, 0)) *
    Math.max(0, toFiniteNumber(portalMassFactor, 0)) *
    Math.max(0, toFiniteNumber(fuelAmountPerLy, 0)) +
    Math.max(0, toFiniteNumber(additionalConsumption, 0));
  return Math.max(0, Math.ceil(rawQuantity));
}

function consumeBridgeFuel(bridgeCharacterID, bridgeShip, bridgeEntity, fuelTypeID, fuelQuantity) {
  const quantity = normalizeInt(fuelQuantity, 0);
  if (quantity <= 0) {
    return {
      consumedQuantity: 0,
      changes: [],
    };
  }

  const fuelEntity = bridgeEntity || {
    kind: "ship",
    itemID: normalizePositiveInt(bridgeShip && bridgeShip.itemID, 0),
  };
  const fuelResult = consumeFuelFromShipStorage(
    fuelEntity,
    fuelTypeID,
    quantity,
    {
      resolveCharacterID: () => normalizePositiveInt(bridgeCharacterID, 0),
    },
  );
  if (!fuelResult.success) {
    throwCynoNotify("The bridge ship does not have enough jump portal fuel.");
  }
  const bridgeSession = sessionRegistry.findSessionByCharacterID(bridgeCharacterID);
  if (bridgeSession) {
    syncInventoryChanges(bridgeSession, fuelResult.changes);
  }
  return fuelResult;
}

function ensureFleetMembership(session) {
  const fleetID = normalizePositiveInt(session && session.fleetid, 0);
  if (fleetID <= 0) {
    throwWrappedUserError("FleetNotInFleet");
  }
  const fleet = fleetRuntime.getFleetByID(fleetID);
  if (!fleet || !(fleet.members instanceof Map)) {
    throwWrappedUserError("FleetNotInFleet");
  }
  const characterID = normalizePositiveInt(session && session.characterID, 0);
  if (characterID <= 0 || !fleet.members.has(characterID)) {
    throwWrappedUserError("FleetNotInFleet");
  }
  return fleet;
}

function getSceneEntityBySystemID(systemID, entityID) {
  const numericSystemID = normalizePositiveInt(systemID, 0);
  const numericEntityID = normalizePositiveInt(entityID, 0);
  if (
    numericSystemID <= 0 ||
      numericEntityID <= 0 ||
      !(spaceRuntime.scenes instanceof Map)
  ) {
    return null;
  }
  const scene = spaceRuntime.scenes.get(numericSystemID);
  return scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(numericEntityID)
    : null;
}

function getStructureByID(structureID) {
  const numericStructureID = normalizePositiveInt(structureID, 0);
  return numericStructureID > 0
    ? structureState.getStructureByID(numericStructureID, { refresh: false }) ||
      require("../starbase/starbaseTravelRuntime").getEndpoint(numericStructureID)
    : null;
}

function isPharoluxStructure(structure) {
  return Boolean(
    structure &&
      (normalizePositiveInt(structure.typeID, 0) === TYPE_PHAROLUX_CYNO_BEACON ||
        (structure.legacyStarbase === true && Number(structure.typeID) === 27673)) &&
      !structure.destroyedAt,
  );
}

function isStructureCynoBeaconServiceOnline(structure) {
  return normalizeInt(
    structure &&
      structure.serviceStates &&
      structure.serviceStates[String(STRUCTURE_SERVICE_ID.CYNO_BEACON)],
    STRUCTURE_SERVICE_STATE.OFFLINE,
  ) === STRUCTURE_SERVICE_STATE.ONLINE;
}

function buildStructureCynoAnchorEntity(structure, fallbackEntity = null) {
  return {
    ...(fallbackEntity && typeof fallbackEntity === "object" ? fallbackEntity : {}),
    itemID: normalizePositiveInt(
      structure && (structure.structureID || structure.itemID),
      normalizePositiveInt(fallbackEntity && fallbackEntity.itemID, 0),
    ),
    structureID: normalizePositiveInt(
      structure && (structure.structureID || structure.itemID),
      normalizePositiveInt(fallbackEntity && fallbackEntity.structureID, 0),
    ),
    typeID: normalizePositiveInt(
      structure && structure.typeID,
      normalizePositiveInt(fallbackEntity && fallbackEntity.typeID, TYPE_PHAROLUX_CYNO_BEACON),
    ),
    itemName:
      (structure && (structure.itemName || structure.name)) ||
      (fallbackEntity && (fallbackEntity.itemName || fallbackEntity.name)) ||
      "Pharolux Cyno Beacon",
    name:
      (structure && (structure.name || structure.itemName)) ||
      (fallbackEntity && (fallbackEntity.name || fallbackEntity.itemName)) ||
      "Pharolux Cyno Beacon",
    position: cloneVector(
      (structure && structure.position) ||
        (fallbackEntity && fallbackEntity.position),
    ),
    radius: Math.max(
      0,
      toFiniteNumber(
        structure && structure.radius,
        toFiniteNumber(fallbackEntity && fallbackEntity.radius, 0),
      ),
    ),
  };
}

function resolveFleetBridgeDestination(destinationSolarSystemID, beaconID) {
  const destinationEntity = getSceneEntityBySystemID(destinationSolarSystemID, beaconID);
  const entityTypeID = normalizePositiveInt(destinationEntity && destinationEntity.typeID, 0);
  const entityFieldTypeID = resolveKnownCynoAnchorFieldTypeID(entityTypeID, 0);
  if (entityFieldTypeID > 0) {
    if (
      isSolarSystemCynoJammed(destinationSolarSystemID) &&
        entityFieldTypeID !== TYPE_COVERT_CYNOSURAL_FIELD
    ) {
      throwCynoNotify("That solar system is cynosural jammed.");
    }
    const isDeployableAnchor = isDeployableCynoAnchorType(entityTypeID);
    return {
      anchorEntity: destinationEntity,
      anchorFallbackName: isDeployableAnchor
        ? "Mobile Cynosural Beacon"
        : "Cynosural Field",
      anchorType: isDeployableAnchor
        ? "fleetDeployableCynoBeacon"
        : "fleetModuleCynoBeacon",
      fieldTypeID: entityFieldTypeID,
      kind: isDeployableAnchor
        ? "fleetDeployableCynoBeacon"
        : "fleetModuleCynoBeacon",
    };
  }

  const structure = getStructureByID(beaconID);
  if (isPharoluxStructure(structure)) {
    const structureSolarSystemID = normalizePositiveInt(structure.solarSystemID, 0);
    if (
      structureSolarSystemID !== normalizePositiveInt(destinationSolarSystemID, 0)
    ) {
      throwCynoNotify("That fleet bridge is no longer available.");
    }
    if (!isStructureCynoBeaconServiceOnline(structure)) {
      throwCynoNotify("That cynosural beacon service is offline.");
    }
    if (isSolarSystemCynoJammed(destinationSolarSystemID)) {
      throwCynoNotify("That solar system is cynosural jammed.");
    }
    return {
      anchorEntity: buildStructureCynoAnchorEntity(structure, destinationEntity),
      anchorFallbackName: "Pharolux Cyno Beacon",
      anchorType: "structureCynoBeacon",
      fieldTypeID: TYPE_CYNOSURAL_FIELD,
      kind: "structureCynoBeacon",
      structure,
    };
  }

  throwCynoNotify("That fleet bridge is no longer available.");
}

function resolveFleetModuleBeacon(args, session) {
  const beaconOwnerCharID = normalizePositiveInt(Array.isArray(args) ? args[0] : null, 0);
  const requestedBeaconID = normalizePositiveInt(Array.isArray(args) ? args[1] : null, 0);
  const requestedSolarSystemID = normalizePositiveInt(Array.isArray(args) ? args[2] : null, 0);
  const fleet = ensureFleetMembership(session);
  const entry = fleet.activeModuleBeacons instanceof Map
    ? fleet.activeModuleBeacons.get(beaconOwnerCharID)
    : null;
  if (!Array.isArray(entry)) {
    throwCynoNotify("That fleet cynosural beacon is no longer available.");
  }

  const destinationSolarSystemID = normalizePositiveInt(entry[0], 0);
  const beaconID = normalizePositiveInt(entry[1], 0);
  const fieldTypeID = normalizePositiveInt(entry[2], TYPE_CYNOSURAL_FIELD);
  if (
    requestedSolarSystemID > 0 &&
      requestedSolarSystemID !== destinationSolarSystemID
  ) {
    throwCynoNotify("That fleet cynosural beacon is not in the requested solar system.");
  }
  if (requestedBeaconID > 0 && requestedBeaconID !== beaconID) {
    throwCynoNotify("That fleet cynosural beacon is no longer available.");
  }
  if (destinationSolarSystemID <= 0 || beaconID <= 0) {
    throwCynoNotify("That fleet cynosural beacon is no longer available.");
  }
  if (destinationSolarSystemID === getSessionSolarSystemID(session)) {
    throwCynoNotify("You are already in that solar system.");
  }
  if (
    isSolarSystemCynoJammed(destinationSolarSystemID) &&
      fieldTypeID !== TYPE_COVERT_CYNOSURAL_FIELD
  ) {
    throwCynoNotify("That solar system is cynosural jammed.");
  }

  const fieldEntity = getSceneEntityBySystemID(destinationSolarSystemID, beaconID);
  if (!fieldEntity) {
    throwCynoNotify("That fleet cynosural beacon is no longer available.");
  }
  const entityTypeID = normalizePositiveInt(fieldEntity.typeID, fieldTypeID);
  if (entityTypeID !== fieldTypeID) {
    throwCynoNotify("That fleet cynosural beacon is no longer available.");
  }

  return {
    beaconID,
    beaconOwnerCharID,
    destinationSolarSystemID,
    fieldEntity,
    fieldTypeID,
    fleet,
  };
}

function resolveFleetDeployableBeacon(args, session) {
  const deployableID = normalizePositiveInt(Array.isArray(args) ? args[0] : null, 0);
  const requestedSolarSystemID = normalizePositiveInt(Array.isArray(args) ? args[1] : null, 0);
  const requestedBeaconID = normalizePositiveInt(Array.isArray(args) ? args[2] : null, 0);
  if (deployableID <= 0) {
    throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
  }

  const fleet = ensureFleetMembership(session);
  const entry = fleet.activeDeployableBeacons instanceof Map
    ? fleet.activeDeployableBeacons.get(deployableID)
    : null;
  if (!Array.isArray(entry)) {
    throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
  }

  const destinationSolarSystemID = normalizePositiveInt(entry[0], 0);
  const beaconID = normalizePositiveInt(entry[1], 0);
  const ownerID = normalizePositiveInt(entry[2], 0);
  if (
    requestedSolarSystemID > 0 &&
      requestedSolarSystemID !== destinationSolarSystemID
  ) {
    throwCynoNotify("That fleet deployable cynosural beacon is not in the requested solar system.");
  }
  if (requestedBeaconID > 0 && requestedBeaconID !== beaconID) {
    throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
  }
  if (destinationSolarSystemID <= 0 || beaconID <= 0) {
    throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
  }
  if (destinationSolarSystemID === getSessionSolarSystemID(session)) {
    throwCynoNotify("You are already in that solar system.");
  }

  const deployableEntity = getSceneEntityBySystemID(destinationSolarSystemID, deployableID);
  const fieldEntity = getSceneEntityBySystemID(destinationSolarSystemID, beaconID);
  if (!deployableEntity && !fieldEntity) {
    throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
  }
  const anchorEntity = fieldEntity || deployableEntity;
  const anchorTypeID = normalizePositiveInt(anchorEntity && anchorEntity.typeID, 0);
  if (
    anchorTypeID > 0 &&
      resolveKnownCynoAnchorFieldTypeID(anchorTypeID, 0) <= 0
  ) {
    throwCynoNotify("That fleet deployable cynosural beacon is no longer available.");
  }

  const fieldTypeID = resolveDeployableBeaconFieldTypeID(
    deployableEntity,
    fieldEntity || deployableEntity,
  );
  if (
    isSolarSystemCynoJammed(destinationSolarSystemID) &&
      fieldTypeID !== TYPE_COVERT_CYNOSURAL_FIELD
  ) {
    throwCynoNotify("That solar system is cynosural jammed.");
  }

  return {
    beaconID,
    deployableEntity,
    deployableID,
    destinationSolarSystemID,
    fieldEntity: anchorEntity,
    fieldTypeID,
    fleet,
    ownerID,
  };
}

function resolveFleetBridgePassengerJump(args, session) {
  const otherCharID = normalizePositiveInt(Array.isArray(args) ? args[0] : null, 0);
  const otherShipID = normalizePositiveInt(Array.isArray(args) ? args[1] : null, 0);
  const requestedBeaconID = normalizePositiveInt(Array.isArray(args) ? args[2] : null, 0);
  const requestedSolarSystemID = normalizePositiveInt(Array.isArray(args) ? args[3] : null, 0);
  if (otherCharID <= 0 || otherShipID <= 0) {
    throwCynoNotify("That fleet bridge is no longer available.");
  }

  const fleet = ensureFleetMembership(session);
  const bridgeMember = fleet.members instanceof Map
    ? fleet.members.get(otherCharID)
    : null;
  if (!bridgeMember) {
    throwWrappedUserError("FleetNotInFleet");
  }

  const bridge = fleetRuntime.getActiveBridgeForCharacter(
    session && session.characterID,
    otherShipID,
  );
  const destinationSolarSystemID = normalizePositiveInt(
    Array.isArray(bridge) ? bridge[0] : null,
    0,
  );
  const beaconID = normalizePositiveInt(Array.isArray(bridge) ? bridge[1] : null, 0);
  if (
    !bridge ||
      destinationSolarSystemID <= 0 ||
      beaconID <= 0 ||
      (requestedSolarSystemID > 0 && requestedSolarSystemID !== destinationSolarSystemID) ||
      (requestedBeaconID > 0 && requestedBeaconID !== beaconID)
  ) {
    throwCynoNotify("That fleet bridge is no longer available.");
  }

  const bridgeDestination = resolveFleetBridgeDestination(
    destinationSolarSystemID,
    beaconID,
  );
  const fieldEntity = bridgeDestination.anchorEntity;
  const fieldTypeID = bridgeDestination.fieldTypeID;

  const bridgeEntity = spaceRuntime.getEntity(session, otherShipID);
  if (!bridgeEntity) {
    throwCynoNotify("That fleet bridge is no longer available.");
  }
  const bridgeOwnerID = normalizePositiveInt(
    bridgeEntity.ownerID || bridgeEntity.charID || otherCharID,
    otherCharID,
  );
  if (bridgeOwnerID !== otherCharID) {
    throwCynoNotify("That fleet bridge is no longer available.");
  }
  const bridgeMemberShipID = normalizePositiveInt(bridgeMember.shipID, 0);
  if (bridgeMemberShipID > 0 && bridgeMemberShipID !== otherShipID) {
    throwCynoNotify("That fleet bridge is no longer available.");
  }

  const passengerShip = getActiveShipRecord(session && session.characterID);
  const passengerShipID = normalizePositiveInt(passengerShip && passengerShip.itemID, 0);
  if (passengerShipID <= 0) {
    throwCynoNotify("You need an active ship to use a fleet bridge.");
  }
  if (passengerShipID === otherShipID) {
    throwCynoNotify("You cannot jump through your own fleet bridge.");
  }
  const passengerEntity = spaceRuntime.getEntity(session, passengerShipID);
  if (!passengerEntity) {
    throwCynoNotify("You need to be in space to use a fleet bridge.");
  }
  if (require("../spaceComponents/shipLinkRestrictions").blocksShipAction(passengerEntity, "blocksJumpOrDock")) {
    throwCynoNotify("A running ship link prevents jumping.");
  }
  const bridgeDistanceMeters = getEntitySurfaceDistanceMeters(
    passengerEntity,
    bridgeEntity,
  );
  if (bridgeDistanceMeters > FLEET_BRIDGE_ACTIVATION_RANGE_METERS) {
    throwCynoNotify("You are too far away from the fleet bridge.");
  }

  const bridgeShip = findCharacterShip(otherCharID, otherShipID);
  if (!bridgeShip) {
    throwCynoNotify("That fleet bridge is no longer available.");
  }
  const portal = resolveBridgePortalModule(otherCharID, bridgeShip, fieldTypeID);
  const passengerResourceState = buildShipResourceState(
    session && session.characterID,
    passengerShip,
  );
  const passengerAttributes = getResourceAttributes(passengerResourceState);
  if (!isEligibleJumpPortalPassenger(
    passengerAttributes,
    portal.requiredPassengerAttributeID,
  )) {
    throwCynoNotify("Your ship cannot use that jump portal.");
  }

  const sourceSolarSystemID = getSessionSolarSystemID(session);
  const distanceLy = getSolarSystemDistanceLy(sourceSolarSystemID, destinationSolarSystemID);
  if (distanceLy === null) {
    throwCynoNotify("The distance to that fleet bridge could not be calculated.");
  }
  if (distanceLy <= 0) {
    throwCynoNotify("You are already in that solar system.");
  }

  const bridgeAttributes = getResourceAttributes(portal.bridgeResourceState);
  const fuelTypeID = normalizePositiveInt(
    bridgeAttributes[ATTRIBUTE_JUMP_DRIVE_CONSUMPTION_TYPE],
    0,
  );
  const fuelAmountPerLy = toFiniteNumber(
    bridgeAttributes[ATTRIBUTE_JUMP_DRIVE_CONSUMPTION_AMOUNT],
    0,
  );
  if (fuelTypeID <= 0 || fuelAmountPerLy <= 0) {
    throwCynoNotify("The bridge ship does not have valid jump portal fuel data.");
  }

  const passengerMass = Math.max(
    0,
    toFiniteNumber(passengerAttributes[ATTRIBUTE_MASS], 0),
    toFiniteNumber(passengerEntity.mass, 0),
    toFiniteNumber(passengerShip.mass, 0),
  );
  if (passengerMass <= 0) {
    throwCynoNotify("Your ship mass could not be calculated for the jump portal.");
  }

  return {
    beaconID,
    bridgeDistanceMeters,
    bridgeEntity,
    bridgeOwnerCharID: otherCharID,
    bridgeShip,
    destinationSolarSystemID,
    distanceLy,
    fieldEntity,
    fieldTypeID,
    bridgeDestination,
    fuelAmountPerLy,
    fuelQuantity: calculateBridgeFuelQuantity({
      distanceLy,
      passengerMass,
      portalMassFactor: portal.portalMassFactor,
      fuelAmountPerLy,
      additionalConsumption: portal.additionalConsumption,
    }),
    fuelTypeID,
    // Two multipliers, one from each party: the passenger's own hull class
    // (1971) and the bridge provider's (1972). CCP's Phoebe Travel Change
    // Update states the portal-side reduction "multiplies with other similar
    // bonuses", so they compose rather than one replacing the other.
    // https://www.eveonline.com/news/view/phoebe-travel-change-update
    jumpFatigueMultiplier:
      resolveJumpFatigueMultiplier(passengerResourceState) *
      resolveJumpThroughFatigueMultiplier(portal.bridgeResourceState),
    passengerEntity,
    passengerMass,
    passengerShip,
    portal,
  };
}

function notifyGroupJumpAnchor(session, destinationSolarSystemID, numPassengers = 0) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification("OnGroupJumpAnchorActivated", "clientID", [
    normalizePositiveInt(destinationSolarSystemID, 0),
    Math.max(0, normalizeInt(numPassengers, 0)),
  ]);
}

function throwConduitAnchorFailure(planResult) {
  const reason = String(planResult && planResult.anchorBlockReason || "");
  if (reason === "cloaked") {
    throwCynoNotify("Your ship cannot perform a conduit jump while cloaked.");
  }
  if (reason === "warp-scrambled") {
    throwCynoNotify("Your ship cannot perform a conduit jump while warp disrupted.");
  }
  if (reason === "transition") {
    throwCynoNotify("Your ship cannot perform a conduit jump while already in transition.");
  }
  if (reason === "industrial-core") {
    throwCynoNotify("Your ship cannot perform a conduit jump while its Industrial Core is active.");
  }
  throwCynoNotify("Your ship cannot perform a conduit jump.");
}

function resolveOperationDungeonWarpPoint(session, siteID) {
  const numericSiteID = normalizeNumber(siteID, 0);
  if (numericSiteID <= 0) {
    return null;
  }

  const record = operationSiteRuntime.resolveOperationSpawnpointRecord(
    getSessionCharacterID(session),
    numericSiteID,
  );
  if (!record || !record.solarSystemID) {
    return null;
  }

  const sessionSystemID = getSessionSolarSystemID(session);
  if (
    sessionSystemID > 0 &&
    Number(record.solarSystemID) > 0 &&
    sessionSystemID !== Number(record.solarSystemID)
  ) {
    return null;
  }

  return {
    x: normalizeNumber(record.position && record.position.x, 0),
    y: normalizeNumber(record.position && record.position.y, 0),
    z: normalizeNumber(record.position && record.position.z, 0),
  };
}

function buildScanSiteWarpPoint(site) {
  if (site && site.actualPosition && typeof site.actualPosition === "object") {
    return {
      x: normalizeNumber(site.actualPosition.x, 0),
      y: normalizeNumber(site.actualPosition.y, 0),
      z: normalizeNumber(site.actualPosition.z, 0),
    };
  }

  if (Array.isArray(site && site.position)) {
    return {
      x: normalizeNumber(site.position[0], 0),
      y: normalizeNumber(site.position[1], 0),
      z: normalizeNumber(site.position[2], 0),
    };
  }

  return null;
}

function ensureUniverseSiteContentsMaterialized(scene, siteOrEntity, options = {}) {
  if (!scene) {
    return null;
  }
  try {
    const dungeonUniverseSiteService = require(path.join(
      __dirname,
      "../dungeon/dungeonUniverseSiteService",
    ));
    return dungeonUniverseSiteService.ensureSiteContentsMaterialized(scene, siteOrEntity, options);
  } catch (error) {
    log.warn(
      `[Beyonce] Failed to materialize universe site contents in system=${normalizeNumber(scene && scene.systemID, 0)}: ${error.message}`,
    );
    return null;
  }
}

function maybeMaterializeMissionBookmarkTarget(session, bookmarkTarget) {
  const metadata =
    bookmarkTarget &&
    bookmarkTarget.metadata &&
    typeof bookmarkTarget.metadata === "object"
      ? bookmarkTarget.metadata
      : (
        bookmarkTarget &&
        bookmarkTarget.bookmarkInfo &&
        bookmarkTarget.bookmarkInfo.bookmark &&
        bookmarkTarget.bookmarkInfo.bookmark.metadata &&
        typeof bookmarkTarget.bookmarkInfo.bookmark.metadata === "object"
      )
        ? bookmarkTarget.bookmarkInfo.bookmark.metadata
        : {};
  const missionInstanceID = normalizeNumber(metadata.missionInstanceID, 0);
  if (missionInstanceID <= 0) {
    return null;
  }
  const scene = spaceRuntime.getSceneForSession(session);
  return ensureUniverseSiteContentsMaterialized(scene, {
    instanceID: missionInstanceID,
  }, {
    spawnEncounters: true,
    broadcast: true,
    session,
  });
}

function isActiveUniverseSiteInstance(instance) {
  const lifecycleState = String(instance && instance.lifecycleState || "")
    .trim()
    .toLowerCase();
  const siteKind = String(instance && instance.siteKind || "")
    .trim()
    .toLowerCase();
  return Boolean(
    instance &&
    instance.runtimeFlags &&
    instance.runtimeFlags.universeSeeded === true &&
    instance.runtimeFlags.generatedMining !== true &&
    (siteKind === "anomaly" || siteKind === "signature") &&
    (lifecycleState === "seeded" || lifecycleState === "active" || lifecycleState === "paused"),
  );
}

function maybeMaterializeUniverseSiteInstanceTarget(session, instanceID) {
  const numericInstanceID = normalizeDungeonInstanceID(instanceID);
  if (numericInstanceID === null) {
    return null;
  }

  const scene = spaceRuntime.getSceneForSession(session);
  if (!scene) {
    return null;
  }

  const instance = dungeonRuntime.getInstance(numericInstanceID);
  if (!isActiveUniverseSiteInstance(instance)) {
    return null;
  }

  const sessionSystemID = getSessionSolarSystemID(session);
  const instanceSystemID = normalizeNumber(instance && instance.solarSystemID, 0);
  if (sessionSystemID > 0 && instanceSystemID > 0 && sessionSystemID !== instanceSystemID) {
    return null;
  }

  const materialized = ensureUniverseSiteContentsMaterialized(scene, {
    instanceID: numericInstanceID,
  }, {
    spawnEncounters: true,
    broadcast: true,
    session,
  });
  if (!materialized || materialized.success !== true) {
    return null;
  }

  const siteID = normalizeNumber(
    materialized.data && materialized.data.siteID,
    normalizeNumber(instance && instance.metadata && instance.metadata.siteID, 0),
  );
  if (siteID <= 0) {
    return null;
  }

  const entity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(siteID)
      : null;
  if (!entity) {
    return null;
  }

  return {
    entityID: siteID,
    instanceID: numericInstanceID,
    materialized,
  };
}

function resolveScanWarpTarget(session, targetID) {
  const systemID = getSessionSolarSystemID(session);
  if (systemID <= 0) {
    return null;
  }

  const site = signatureRuntime.resolveSiteByTargetID(systemID, targetID, {
    loadScene: true,
  });
  if (!site) {
    return null;
  }
  const scene = spaceRuntime.getSceneForSession(session);
  ensureUniverseSiteContentsMaterialized(scene, site, {
    spawnEncounters: true,
    broadcast: true,
    session,
  });

  const entityID = normalizeNumber(
    site.itemID || site.endpointID || site.siteID,
    0,
  );
  if (entityID > 0) {
    const entity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    if (entity) {
      return {
        kind: "entity",
        entityID,
        instanceID: normalizeDungeonInstanceID(
          site.instanceID || site.dungeonSiteInstanceID,
        ),
        site,
      };
    }
  }

  const point = buildScanSiteWarpPoint(site);
  if (point) {
    return {
      kind: "point",
      point,
      instanceID: normalizeDungeonInstanceID(
        site.instanceID || site.dungeonSiteInstanceID,
      ),
      site,
    };
  }

  return null;
}

function grantAcquiredMissionAccess(session, instanceID, source) {
  const numericInstanceID = normalizeDungeonInstanceID(instanceID);
  if (numericInstanceID === null) {
    return true;
  }
  try {
    const instance = dungeonRuntime.getInstance(numericInstanceID);
    if (!instance || !isPrivateDungeonInstance(instance)) {
      return Boolean(instance);
    }
    if (canSessionAccessDungeonInstance(session, instance)) {
      return true;
    }
    const characterID = normalizeNumber(
      session && (session.characterID || session.charID || session.charid),
      0,
    );
    const updated = dungeonRuntime.grantCharacterMissionAccess(
      numericInstanceID,
      characterID,
      { source },
    );
    return canSessionAccessDungeonInstance(session, updated);
  } catch (error) {
    log.warn(
      `[Beyonce] Failed to grant acquired mission access char=${normalizeNumber(
        session && session.characterID,
        0,
      )} instance=${numericInstanceID} source=${source}: ${error.message}`,
    );
    return false;
  }
}

function resolveFleetMemberWarpTarget(session, targetCharacterID) {
  const sourceCharacterID = normalizeNumber(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
  const numericTargetCharacterID = normalizeNumber(targetCharacterID, 0);
  if (sourceCharacterID <= 0 || numericTargetCharacterID <= 0) {
    return null;
  }

  const fleet = fleetRuntime.getFleetForCharacter(sourceCharacterID);
  if (!fleet || !fleetRuntime.getMemberRecord(fleet, numericTargetCharacterID)) {
    return null;
  }

  const targetSession = sessionRegistry.findSessionByCharacterID(
    numericTargetCharacterID,
  );
  if (!targetSession) {
    return null;
  }

  const abyssalMgrService = getAbyssalMgrService();
  if (
    typeof abyssalMgrService.isCharacterInActiveAbyssalRun === "function" &&
    abyssalMgrService.isCharacterInActiveAbyssalRun(numericTargetCharacterID)
  ) {
    return {
      kind: "blocked",
      reason: "ABYSSAL_TARGET",
      targetSession,
    };
  }

  const sourceSystemID = normalizeNumber(
    session && (session.solarsystemid2 || session.solarsystemid),
    0,
  );
  const targetSystemID = normalizeNumber(
    targetSession.solarsystemid2 || targetSession.solarsystemid,
    0,
  );
  if (
    sourceSystemID > 0 &&
    targetSystemID > 0 &&
    sourceSystemID !== targetSystemID
  ) {
    return null;
  }

  const targetScene = spaceRuntime.getSceneForSession(targetSession);
  const targetShipEntity =
    targetScene && typeof targetScene.getShipEntityForSession === "function"
      ? targetScene.getShipEntityForSession(targetSession)
      : null;
  const targetShipID = normalizeNumber(
    targetShipEntity && targetShipEntity.itemID,
    normalizeNumber(targetSession.shipID || targetSession.shipid, 0),
  );
  const destinationStaticInstanceID = normalizeDungeonInstanceID(
    targetShipEntity && targetShipEntity.dungeonCurrentInstanceID,
  );
  const destinationDungeonRoomKey = String(
    targetShipEntity && targetShipEntity.dungeonCurrentRoomKey || "",
  ).trim() || null;
  const destinationDungeonSiteID = normalizePersistentEntityID(
    targetShipEntity && targetShipEntity.dungeonCurrentSiteID,
  );
  if (destinationStaticInstanceID !== null) {
    grantAcquiredMissionAccess(
      session,
      destinationStaticInstanceID,
      "fleet_member_warp",
    );
  }
  if (targetShipID > 0) {
    return {
      destinationDungeonRoomKey,
      destinationDungeonSiteID,
      kind: "entity",
      entityID: targetShipID,
      destinationStaticInstanceID,
    };
  }
  if (
    targetShipEntity &&
    targetShipEntity.position &&
    typeof targetShipEntity.position === "object"
  ) {
    return {
      destinationDungeonRoomKey,
      destinationDungeonSiteID,
      kind: "point",
      point: targetShipEntity.position,
      destinationStaticInstanceID,
    };
  }

  return null;
}

function getActiveAbyssalRunForSession(session) {
  const abyssalMgrService = getAbyssalMgrService();
  const characterID = normalizeNumber(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
  if (
    characterID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
  ) {
    const activeRun = abyssalMgrService.getActiveAbyssalRunForCharacterID(characterID);
    if (activeRun) {
      return activeRun;
    }
  }

  const shipID = normalizeNumber(
    session && (
      (session._space && session._space.shipID) ||
      session.shipID ||
      session.shipid ||
      session.shipId ||
      session.activeShipID
    ),
    0,
  );
  if (
    shipID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForShipID === "function"
  ) {
    return abyssalMgrService.getActiveAbyssalRunForShipID(shipID);
  }

  return null;
}

function resolveAbyssalSessionActionAuthority(session) {
  const activeRun = getActiveAbyssalRunForSession(session);
  if (activeRun) {
    return {
      activeRun,
      instanceID: normalizeNumber(activeRun.instanceID, 0),
      source: "active-run",
    };
  }

  const sceneSources = [
    session && session._space,
    session && session._space && session._space.sceneDescriptor,
    session && {
      sceneKind: session.spaceSceneKind,
      sceneKey: session.spaceSceneKey,
      instanceID: session.spaceInstanceID,
    },
  ];
  for (const source of sceneSources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    const sceneKind = String(source.sceneKind || "").trim().toLowerCase();
    const sceneKey = String(source.sceneKey || "").trim();
    const sceneKeyMatch = /^abyssal-run:([1-9]\d*)$/.exec(sceneKey);
    if (sceneKind !== "abyssal" && !sceneKeyMatch) {
      continue;
    }
    return {
      activeRun: null,
      instanceID: normalizeNumber(
        source.instanceID,
        normalizeNumber(sceneKeyMatch && sceneKeyMatch[1], 0),
      ),
      source: "scene",
    };
  }

  const systemID = getSessionSolarSystemID(session);
  if (isAbyssalHostLocationID(systemID)) {
    return {
      activeRun: null,
      instanceID: 0,
      source: "reserved-host",
    };
  }
  return null;
}

function resolveAbyssalJumpBridgeRestriction(session, action = "jump") {
  const authority = resolveAbyssalSessionActionAuthority(session);
  if (!authority) {
    return null;
  }
  const abyssalMgrService = getAbyssalMgrService();
  const bypassAllowed = Boolean(
    typeof abyssalMgrService.isAbyssalRestrictionBypassAllowed === "function" &&
      abyssalMgrService.isAbyssalRestrictionBypassAllowed({
        session,
        restriction: "jump_bridge",
      })
  );
  if (bypassAllowed) {
    return null;
  }
  return {
    action: String(action || "jump"),
    characterID: normalizeNumber(
      session && (session.characterID || session.charID || session.charid),
      0,
    ),
    shipID: normalizeNumber(
      session && session._space && session._space.shipID,
      normalizeNumber(session && (session.shipID || session.shipid), 0),
    ),
    instanceID: authority.instanceID,
    source: authority.source,
  };
}

function assertAbyssalJumpBridgeActionAllowed(session, action) {
  const restriction = resolveAbyssalJumpBridgeRestriction(session, action);
  if (!restriction) {
    return;
  }
  log.info(
    `[AbyssalMgr] Jump/bridge blocked inside Abyssal run ` +
      `char=${restriction.characterID} ship=${restriction.shipID} ` +
      `instance=${restriction.instanceID} action=${restriction.action} ` +
      `authority=${restriction.source}`,
  );
  throwWrappedUserError("CustomInfo", {
    info: ABYSSAL_JUMP_BRIDGE_BLOCKED_MESSAGE,
  });
}

function throwAbyssalWarpBlockedError() {
  throwWrappedUserError("CustomInfo", {
    info: ABYSSAL_WARP_BLOCKED_MESSAGE,
  });
}

function throwAbyssalFleetMemberWarpBlockedError() {
  throwWrappedUserError("CustomInfo", {
    info: ABYSSAL_FLEET_MEMBER_WARP_BLOCKED_MESSAGE,
  });
}

function assertAbyssalBookmarkCreationAllowed(session) {
  const activeAbyssalRun = getActiveAbyssalRunForSession(session);
  const sceneKey = String(
    session && session._space && session._space.sceneKey ||
      session && session.spaceSceneKey ||
      "",
  ).trim();
  const hasAbyssalSceneAuthority = Boolean(
    String(session && session._space && session._space.sceneKind || "").trim() === "abyssal" ||
    /^abyssal-run:\d+$/.test(sceneKey)
  );
  const hasAbyssalHostAuthority = isAbyssalHostLocationID(
    getSessionSolarSystemID(session),
  );
  if (
    !activeAbyssalRun &&
    !hasAbyssalSceneAuthority &&
    !hasAbyssalHostAuthority
  ) {
    return;
  }
  throwWrappedUserError("CustomInfo", {
    info: ABYSSAL_BOOKMARK_BLOCKED_MESSAGE,
  });
}

class BeyonceService extends BaseService {
  _structureSelfDestruct(args, session, abort) {
    const owner = require("../structure/structureSelfDestructRuntime");
    let result;
    try {
      result = abort ? owner.abortStructureSelfDestruct(session, Number(args?.[0]))
        : owner.startStructureSelfDestruct(session, Number(args?.[0]));
    } catch (error) {
      log.warn(`[Beyonce] structure self-destruct failed: ${error.message}`);
      throwWrappedUserError("CustomInfo", { info: "The structure could not be configured. Try again." });
    }
    if (!result.success) {
      log.warn(`[Beyonce] structure self-destruct refused: ${result.errorMsg}`);
      if (result.errorMsg === "STRUCTURE_ACCESS_DENIED")
        throwWrappedUserError("CrpAccessDenied", { reason: "Insufficient roles" });
      const messages = {
        STRUCTURE_OUT_OF_CONFIGURE_RANGE: "You must be within 5,000 m of the structure to configure it.",
        STRUCTURE_CONFIGURE_DISTANCE_UNAVAILABLE: "The structure must be visible in your current space view to configure it.",
        STRUCTURE_SELF_DESTRUCT_NOT_SUPPORTED: "This structure cannot self-destruct.",
        STRUCTURE_SELF_DESTRUCT_TOO_LATE: "The structure's self-destruct countdown has expired.",
        STRUCTURE_SELF_DESTRUCT_SCHEDULER_UNAVAILABLE: "Structure self-destruct is temporarily unavailable. Try again.",
        STRUCTURE_NOT_FOUND: "The structure is no longer available.",
        STRUCTURE_DESTROYED: "The structure is no longer available.",
      };
      throwWrappedUserError("CustomInfo", { info: messages[result.errorMsg] || "The structure could not be configured. Try again." });
    }
    return null;
  }

  Handle_CmdSelfDestructStructure(args, session) {
    return this._structureSelfDestruct(args, session, false);
  }

  Handle_CmdAbortSelfDestructStructure(args, session) {
    return this._structureSelfDestruct(args, session, true);
  }

  constructor() {
    super("beyonce");
    this.reuseBoundObjectForSession = true;
  }

  _getMovementThrottleNowMs() {
    const overrideNowMs = Number(this._movementThrottleNowMs);
    return Number.isFinite(overrideNowMs) && overrideNowMs >= 0
      ? overrideNowMs
      : Date.now();
  }

  _normalizeMovementThrottlePart(value) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return String(Math.round(numericValue * 1000) / 1000);
    }
    return String(value || "");
  }

  _buildMovementThrottleKey(commandName, parts = []) {
    return [
      String(commandName || "movement"),
      ...parts.map((part) => this._normalizeMovementThrottlePart(part)),
    ].join(":");
  }

  _throwThrottleGeneric(remainingMs) {
    throwWrappedUserError("ThrottleGeneric", {
      remainingTime: Math.max(
        1,
        Math.ceil(Math.max(0, Number(remainingMs) || 0) * EVE_TIME_TICKS_PER_MS),
      ),
    });
  }

  _enforceMovementCommandThrottle(session, commandName, parts = []) {
    if (!session || typeof session !== "object") {
      return;
    }
    const nowMs = this._getMovementThrottleNowMs();
    const key = this._buildMovementThrottleKey(commandName, parts);
    if (!(session._beyonceMovementCommandThrottle instanceof Map)) {
      session._beyonceMovementCommandThrottle = new Map();
    }
    const throttleState = session._beyonceMovementCommandThrottle;
    const expiresAtMs = Number(throttleState.get(key)) || 0;
    if (expiresAtMs > nowMs) {
      this._throwThrottleGeneric(expiresAtMs - nowMs);
    }

    throttleState.set(key, nowMs + MOVEMENT_COMMAND_THROTTLE_MS);
    if (throttleState.size > 64) {
      for (const [entryKey, entryExpiresAtMs] of throttleState.entries()) {
        if ((Number(entryExpiresAtMs) || 0) <= nowMs) {
          throttleState.delete(entryKey);
        }
      }
    }
  }

  _throwStargateJumpUserError(errorMsg = "") {
    switch (String(errorMsg || "").trim()) {
      case "NOT_IN_SPACE":
      case "SHIP_NOT_FOUND":
      case "SHIP_ID_MISMATCH":
      case "WRONG_SOLAR_SYSTEM":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "STARGATE_NOT_FOUND":
      case "STARGATE_DESTINATION_MISMATCH":
        throwWrappedUserError("TargetingAttemptCancelled");
        break;
      case "TOO_FAR_FROM_STARGATE":
        throwWrappedUserError("CustomInfo", {
          info: [USER_ERROR_LOCALIZATION_LABEL, STARGATE_TOO_FAR_LABEL],
        });
        break;
      case "STARGATE_NOT_ACTIVE":
        throwWrappedUserError("CustomInfo", {
          info: [USER_ERROR_LOCALIZATION_LABEL, STARGATE_CLOSED_LABEL],
        });
        break;
      case "STARGATE_JUMP_IN_PROGRESS":
        throwWrappedUserError("CustomInfo", {
          info: "Stargate jump already in progress.",
        });
        break;
      case "STARGATE_JUMP_BLOCKED_BY_SCRIPTED_HIC":
        throwWrappedUserError("CustomInfo", {
          info: "Capital ships cannot use stargates while affected by a focused Heavy Interdictor disruption script.",
        });
        break;
      case "WEAPONS_TIMER_ACTIVE":
        throwWrappedUserError("CustomInfo", {
          info: "You cannot jump until your weapons timer expires.",
        });
        break;
      case "CRIMINAL_TIMER_ACTIVE":
        throwWrappedUserError("CustomInfo", {
          info: "You cannot jump while you are criminally flagged.",
        });
        break;
      default:
        throwWrappedUserError("CustomInfo", {
          info: "The stargate jump could not be completed.",
        });
        break;
    }
  }

  _throwWarpFailureUserError(errorMsg = "") {
    switch (String(errorMsg || "").trim()) {
      case "CRIMINAL_TIMER_ACTIVE":
        throwWrappedUserError("CustomInfo", {
          info: CRIMEWATCH_WARP_BLOCKED_MESSAGE,
        });
        break;
      case "WARP_DISRUPTED_BY_BUBBLE":
        throwWrappedUserError("WarpDisrupted");
        break;
      case "WARP_SCRAMBLED":
        throwWrappedUserError("CustomNotify", {
          notify: "You cannot warp because you are warp scrambled.",
        });
        break;
      case "WARP_BLOCKED_BY_CLOAK":
        throwWrappedUserError("CustomNotify", {
          notify: "You cannot warp while cloaked. Deactivate your cloaking device first.",
        });
        break;
      case "SHIP_IMMOBILE":
        throwWrappedUserError("CustomNotify", {
          notify: SHIP_IMMOBILE_WARP_BLOCKED_MESSAGE,
        });
        break;
      case "DUNGEON_INSTANCE_NOT_AUTHORIZED":
        throwWrappedUserError("CustomNotify", {
          notify: "You have not scanned that site down, so you cannot warp to it yet.",
        });
        break;
      case "":
        break;
      default:
        // Every reason spaceRuntime can refuse a warp for used to fall through
        // here, which meant the ship simply did not move and the client was
        // told nothing at all -- the reason went to the server log and nowhere
        // else. A generic message is worse than a specific one and far better
        // than silence.
        throwWrappedUserError("CustomNotify", {
          notify: "You cannot warp there right now.",
        });
        break;
    }
  }

  Handle_GetFormations(args, session) {
    // Docked structure exterior view is a view toggle, not a fresh space login.
    // The stock client may return to hangar without re-fetching hangar state,
    // so prepare a fresh exterior observer cache here and send the real
    // ballpark bootstrap only once Michelle completes MachoBindObject.
    const startedAtMs = Date.now();
    const prepared = prepareSessionBallpark(session);
    const elapsedMs = Date.now() - startedAtMs;
    if (
      typeof spaceRuntime.recordSessionJumpTimingTrace === "function"
    ) {
      spaceRuntime.recordSessionJumpTimingTrace(session, "beyonce-get-formations", {
        elapsedMs,
        prepared: prepared === true,
      });
    }
    if (elapsedMs >= 100) {
      log.info(`[Beyonce] GetFormations prepareSessionBallpark took ${elapsedMs}ms`);
    }

    const formations = [
      [
        "Diamond",
        [
          [100.0, 0.0, 0.0],
          [0.0, 100.0, 0.0],
          [-100.0, 0.0, 0.0],
          [0.0, -100.0, 0.0],
        ],
      ],
      [
        "Arrow",
        [
          [100.0, 0.0, -50.0],
          [50.0, 0.0, 0.0],
          [-100.0, 0.0, -50.0],
          [-50.0, 0.0, 0.0],
        ],
      ],
    ];
    return buildCachedMethodCallResult(formations, {
      serviceName: this.name,
      method: "GetFormations",
      versionCheck: "run",
      proxyCache: true,
    });
  }

  Handle_AdminGetBubbleID(args, session) {
    const itemID = normalizeNumber(args && args[0], 0);
    if (itemID <= 0) {
      return null;
    }

    if (!hasBeyonceViewRole(session)) {
      log.warn(
        `[Beyonce] AdminGetBubbleID denied for non-view session userId=${session && session.userid}`,
      );
      return null;
    }

    const bubbleID = spaceRuntime.getBubbleIDForEntity(session, itemID);
    log.debug(
      `[Beyonce] AdminGetBubbleID item=${itemID} -> ${bubbleID == null ? "null" : bubbleID}`,
    );
    return bubbleID;
  }

  Handle_GetCapacityOfSiphon(args, session) {
    void session;
    const itemID = normalizeNumber(args && args[0], 0);
    return mobileSiphonUnitRuntime.buildSiphonCapacityKeyVal(itemID);
  }

  Handle_UpdateStateRequest(args, session) {
    void args;
    const startedAtMs = Date.now();
    const dockedStructureObserver = isDockedStructureObserverSession(session);
    const initialStateSent = Boolean(
      session && session._space && session._space.initialStateSent,
    );
    const classification = dockedStructureObserver
      ? "docked-structure-refresh"
      : initialStateSent
        ? "recovery"
        : "bootstrap";
    const recentDestinyEvents = summarizeRecentDestinyLedgerEvents(session);
    const requestRecord = recordSyncLedgerEvent(
      session,
      "destiny.client.update-state-request",
      {
        kind: "destiny",
        classification,
        signal: classification === "recovery"
          ? "client-requested-state-recovery"
          : "client-requested-state-bootstrap",
        evidenceBoundary: "client-request-observed-no-rendered-jolt-proof",
        dockedStructureObserver,
        initialStateSent,
        beyonceBound: Boolean(
          session && session._space && session._space.beyonceBound,
        ),
        recentDestinyEvents,
      },
    );
    const requestLogMessage =
      `[Beyonce] Client UpdateStateRequest classification=${classification} ` +
      `char=${session && session.characterID ? session.characterID : 0} ` +
      `ship=${session && session._space ? session._space.shipID || 0 : 0} ` +
      `system=${session && session._space ? session._space.systemID || 0 : 0}`;
    if (classification === "recovery") {
      log.warn(requestLogMessage);
    } else {
      log.info(requestLogMessage);
    }
    const recordOutcome = (pathName) => recordSyncLedgerEvent(
      session,
      "destiny.client.update-state-response",
      {
        kind: "destiny",
        requestSeq: requestRecord.seq,
        classification,
        path: pathName,
        elapsedMs: Date.now() - startedAtMs,
      },
    );

    if (dockedStructureObserver) {
      bootstrapSessionBallpark(session, {
        allowDeferredJumpBootstrapVisuals: true,
      });
      const elapsedMs = Date.now() - startedAtMs;
      if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
        spaceRuntime.recordSessionJumpTimingTrace(session, "beyonce-update-state-request", {
          elapsedMs,
          dockedStructureObserver: true,
        });
      }
      recordOutcome("docked-structure-bootstrap");
      return null;
    }

    spaceRuntime.markBeyonceBound(session);
    const scene = spaceRuntime.getSceneForSession(session);
    const egoEntity = scene && scene.getShipEntityForSession(session);
    if (
      scene &&
      egoEntity &&
      session &&
      session._space &&
      session._space.initialStateSent
    ) {
      scene.sendStateRefresh(session);
      recordOutcome("recovery-set-state");
      return null;
    }

    bootstrapSessionBallpark(session, {
      allowDeferredJumpBootstrapVisuals: true,
    });
    const elapsedMs = Date.now() - startedAtMs;
    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(session, "beyonce-update-state-request", {
        elapsedMs,
        dockedStructureObserver: false,
      });
    }
    if (elapsedMs >= 100) {
      log.info(`[Beyonce] UpdateStateRequest bootstrap took ${elapsedMs}ms`);
    }
    recordOutcome("ballpark-bootstrap");
    return null;
  }

  Handle_GetCynoJammerState(args, session) {
    return getCynoJammerOnlineSimTime(getSessionSolarSystemID(session));
  }

  _jumpToFleetModuleBeacon(args, session, options = {}) {
    assertAbyssalJumpBridgeActionAllowed(
      session,
      options.groupAnchor === true
        ? "group-jump-to-fleet-module-beacon"
        : "jump-to-fleet-module-beacon",
    );
    const {
      beaconID,
      beaconOwnerCharID,
      destinationSolarSystemID,
      fieldEntity,
      fieldTypeID,
    } = resolveFleetModuleBeacon(args, session);
    const {
      activeShip,
      distanceLy,
      fuelTypeID,
      fuelQuantity,
      resourceState,
    } = resolveActiveShipAndJumpDriveForCyno(
      session,
      destinationSolarSystemID,
      fieldTypeID,
    );
    const shipEntity = spaceRuntime.getEntity(session, activeShip.itemID);
    throwIfJumpActivationActive(session);
    let consumedFuelQuantity = fuelQuantity;
    let conduitPlan = null;
    let conduitActivation = null;
    if (options.groupAnchor === true) {
      conduitActivation = resolveConduitJumpActivation(
        resourceState,
        distanceLy,
      );
      if (!conduitActivation.success) {
        throwCynoNotify("Your ship is not capable of performing a conduit jump.");
      }
      consumedFuelQuantity = conduitActivation.fuelQuantity;
      conduitPlan = buildConduitPassengerPlans({
        fleet: ensureFleetMembership(session),
        anchorSession: session,
        anchorEntity: shipEntity,
        destinationSolarSystemID,
        requiredPassengerAttributeID:
          conduitActivation.requiredPassengerAttributeID,
        passengerLimit: conduitActivation.passengerLimit,
        buildSpawnState: ({ passengerEntity, passengerShip }) =>
          buildFleetCynoArrivalSpawnState(
            fieldEntity,
            passengerShip,
            passengerEntity,
          ),
      });
      if (!conduitPlan.success) {
        throwConduitAnchorFailure(conduitPlan);
      }
    }
    assertJumpFuelAvailable(
      session,
      activeShip,
      shipEntity,
      fuelTypeID,
      consumedFuelQuantity,
    );
    let fuelResult;
    return (async () => {
      const { jumpResult, conduitPassengerResult } = await jumpCynosuralAnchorAndPassengers(session, destinationSolarSystemID, {
        beforeTransfer: () => {
          fuelResult = consumeJumpFuel(session, activeShip, shipEntity, fuelTypeID, consumedFuelQuantity);
        },
        spawnStateOverride: buildFleetCynoArrivalSpawnState(
          fieldEntity,
          activeShip,
          shipEntity,
        ),
      }, options.groupAnchor === true ? {
        plans: conduitPlan && Array.isArray(conduitPlan.plans) ? conduitPlan.plans : [],
        anchorCharacterID: session && session.characterID,
        destinationSolarSystemID,
        distanceLy,
        logPrefix: "Beyonce",
      } : null, {
        distanceLy,
        jumpFatigueMultiplier: resolveJumpFatigueMultiplier(resourceState),
      });
      if (!jumpResult.success) {
        log.warn(
          `[Beyonce] fleet module cyno jump failed char=${session && session.characterID} ` +
            `beaconOwner=${beaconOwnerCharID} beacon=${beaconID}: ${jumpResult.errorMsg}`,
        );
        throwCynoNotify("The fleet cynosural beacon session change failed.");
      }
      if (options.groupAnchor === true) {
        notifyGroupJumpAnchor(session, destinationSolarSystemID, conduitPassengerResult.successCount);
      }

      log.info(
        `[Beyonce] char=${session && session.characterID} jumped fleetModuleCyno ` +
          `beaconOwner=${beaconOwnerCharID} beacon=${beaconID} type=${fieldTypeID} ` +
          `destination=${destinationSolarSystemID} fuelType=${fuelTypeID} ` +
          `fuel=${fuelResult.consumedQuantity || 0} distanceLy=${distanceLy.toFixed(6)} ` +
          `conduitPassengers=${conduitPassengerResult ? conduitPassengerResult.successCount : 0} ` +
          `conduitLimit=${conduitActivation ? conduitActivation.passengerLimit : 0}`,
      );
      return jumpResult.data.boundResult || true;
    })();
  }

  _jumpToFleetDeployableBeacon(args, session, options = {}) {
    assertAbyssalJumpBridgeActionAllowed(
      session,
      options.groupAnchor === true
        ? "group-jump-to-fleet-deployable-beacon"
        : "jump-to-fleet-deployable-beacon",
    );
    const {
      beaconID,
      deployableID,
      destinationSolarSystemID,
      fieldEntity,
      fieldTypeID,
      fleet,
      ownerID,
    } = resolveFleetDeployableBeacon(args, session);
    const {
      activeShip,
      distanceLy,
      fuelTypeID,
      fuelQuantity,
      resourceState,
    } = resolveActiveShipAndJumpDriveForCyno(
      session,
      destinationSolarSystemID,
      fieldTypeID,
    );
    const shipEntity = spaceRuntime.getEntity(session, activeShip.itemID);
    throwIfJumpActivationActive(session);
    let consumedFuelQuantity = fuelQuantity;
    let conduitPlan = null;
    let conduitActivation = null;
    const spawnOptions = {
      anchorType: "fleetDeployableCynoBeacon",
      fallbackName: "Mobile Cynosural Beacon",
    };
    if (options.groupAnchor === true) {
      conduitActivation = resolveConduitJumpActivation(
        resourceState,
        distanceLy,
      );
      if (!conduitActivation.success) {
        throwCynoNotify("Your ship is not capable of performing a conduit jump.");
      }
      consumedFuelQuantity = conduitActivation.fuelQuantity;
      conduitPlan = buildConduitPassengerPlans({
        fleet,
        anchorSession: session,
        anchorEntity: shipEntity,
        destinationSolarSystemID,
        requiredPassengerAttributeID:
          conduitActivation.requiredPassengerAttributeID,
        passengerLimit: conduitActivation.passengerLimit,
        buildSpawnState: ({ passengerEntity, passengerShip }) =>
          buildFleetCynoArrivalSpawnState(
            fieldEntity,
            passengerShip,
            passengerEntity,
            spawnOptions,
          ),
      });
      if (!conduitPlan.success) {
        throwConduitAnchorFailure(conduitPlan);
      }
    }
    assertJumpFuelAvailable(
      session,
      activeShip,
      shipEntity,
      fuelTypeID,
      consumedFuelQuantity,
    );
    let fuelResult;
    return (async () => {
      const { jumpResult, conduitPassengerResult } = await jumpCynosuralAnchorAndPassengers(session, destinationSolarSystemID, {
        beforeTransfer: () => {
          fuelResult = consumeJumpFuel(session, activeShip, shipEntity, fuelTypeID, consumedFuelQuantity);
        },
        spawnStateOverride: buildFleetCynoArrivalSpawnState(
          fieldEntity,
          activeShip,
          shipEntity,
          spawnOptions,
        ),
      }, options.groupAnchor === true ? {
        plans: conduitPlan && Array.isArray(conduitPlan.plans) ? conduitPlan.plans : [],
        anchorCharacterID: session && session.characterID,
        destinationSolarSystemID,
        distanceLy,
        logPrefix: "Beyonce",
      } : null, {
        distanceLy,
        jumpFatigueMultiplier: resolveJumpFatigueMultiplier(resourceState),
      });
      if (!jumpResult.success) {
        log.warn(
          `[Beyonce] fleet deployable cyno jump failed char=${session && session.characterID} ` +
            `deployable=${deployableID} beacon=${beaconID}: ${jumpResult.errorMsg}`,
        );
        throwCynoNotify("The fleet deployable cynosural beacon session change failed.");
      }
      if (options.groupAnchor === true) {
        notifyGroupJumpAnchor(session, destinationSolarSystemID, conduitPassengerResult.successCount);
      }

      log.info(
        `[Beyonce] char=${session && session.characterID} jumped fleetDeployableCyno ` +
          `deployable=${deployableID} beacon=${beaconID} owner=${ownerID} type=${fieldTypeID} ` +
          `destination=${destinationSolarSystemID} fuelType=${fuelTypeID} ` +
          `fuel=${fuelResult.consumedQuantity || 0} distanceLy=${distanceLy.toFixed(6)} ` +
          `conduitPassengers=${conduitPassengerResult ? conduitPassengerResult.successCount : 0} ` +
          `conduitLimit=${conduitActivation ? conduitActivation.passengerLimit : 0}`,
      );
      return jumpResult.data.boundResult || true;
    })();
  }

  Handle_CmdJumpToFleetModuleBeacon(args, session) {
    return this._jumpToFleetModuleBeacon(args, session);
  }

  Handle_CmdGroupJumpToFleetModuleBeacon(args, session) {
    return this._jumpToFleetModuleBeacon(args, session, {
      groupAnchor: true,
    });
  }

  Handle_CmdBridgeToFleetModuleBeacon(args, session) {
    assertAbyssalJumpBridgeActionAllowed(
      session,
      "bridge-to-fleet-module-beacon",
    );
    const {
      beaconID,
      beaconOwnerCharID,
      destinationSolarSystemID,
      fieldTypeID,
    } = resolveFleetModuleBeacon(args, session);
    const {
      activeShip,
      distanceLy,
      fuelTypeID,
      fuelQuantity,
    } = resolveActiveShipAndJumpDriveForCyno(
      session,
      destinationSolarSystemID,
      fieldTypeID,
      { portalBridge: true },
    );
    const portal = resolveBridgePortalModule(
      session && session.characterID,
      activeShip,
      fieldTypeID,
    );
    const activationResult = spaceRuntime.activateGenericModule(
      session,
      portal.portalModuleItem,
      getBridgePortalEffectName(portal.portalModuleItem),
      {
        repeat: 1,
      },
    );
    if (!activationResult.success) {
      if (activationResult.errorMsg === "NOT_ENOUGH_CAPACITOR") {
        throwCynoNotify("The bridge ship does not have enough capacitor to activate the jump portal.");
      }
      if (activationResult.errorMsg === "NO_FUEL") {
        throwCynoNotify("The bridge ship does not have enough jump portal activation fuel.");
      }
      if (activationResult.errorMsg === "MODULE_ALREADY_ACTIVE") {
        throwCynoNotify("That jump portal generator is already active.");
      }
      throwCynoNotify("The jump portal generator could not be activated.");
    }
    const effectState =
      activationResult.data && activationResult.data.effectState
        ? activationResult.data.effectState
        : null;
    if (effectState) {
      effectState.autoDeactivateAtCycleEnd = true;
      effectState.consequenceDelivery = "managed";
      effectState.jumpPortalBridgeMode = {
        fleetID: session && session.fleetid,
        shipID: activeShip.itemID,
        solarsystemID: destinationSolarSystemID,
        itemID: beaconID,
      };
    }
    fleetRuntime.setBridgeMode(
      session.fleetid,
      activeShip.itemID,
      destinationSolarSystemID,
      beaconID,
      true,
    );
    notifyGroupJumpAnchor(session, destinationSolarSystemID, 0);
    log.info(
      `[Beyonce] char=${session && session.characterID} opened fleet module bridge ` +
        `ship=${activeShip.itemID} beaconOwner=${beaconOwnerCharID} beacon=${beaconID} ` +
        `destination=${destinationSolarSystemID} portalModule=${portal.portalModuleItem.itemID} ` +
        `portalType=${portal.portalModuleItem.typeID} fuelType=${fuelTypeID} ` +
        `portalEffect=${effectState ? effectState.effectName : getBridgePortalEffectName(portal.portalModuleItem)} ` +
        `activationCap=${effectState ? effectState.capNeed || 0 : 0} ` +
        `activationFuelType=${effectState ? effectState.fuelTypeID || 0 : 0} ` +
        `activationFuel=${effectState ? effectState.fuelPerActivation || 0 : 0} ` +
        `passengerFuelEstimate=${fuelQuantity} distanceLy=${distanceLy.toFixed(6)}`,
    );
    return true;
  }

  Handle_CmdJumpThroughFleet(args, session) {
    assertAbyssalJumpBridgeActionAllowed(session, "jump-through-fleet-bridge");
    const bridgeJump = resolveFleetBridgePassengerJump(args, session);
    throwIfJumpActivationActive(session);
    const fuelResult = consumeBridgeFuel(
      bridgeJump.bridgeOwnerCharID,
      bridgeJump.bridgeShip,
      bridgeJump.bridgeEntity,
      bridgeJump.fuelTypeID,
      bridgeJump.fuelQuantity,
    );
    const jumpResult = jumpSessionToSolarSystem(
      session,
      bridgeJump.destinationSolarSystemID,
      {
        spawnStateOverride: buildFleetCynoArrivalSpawnState(
          bridgeJump.fieldEntity,
          bridgeJump.passengerShip,
          bridgeJump.passengerEntity,
          {
            anchorType: bridgeJump.bridgeDestination.anchorType,
            fallbackName: bridgeJump.bridgeDestination.anchorFallbackName,
          },
        ),
      },
    );
    if (!jumpResult.success) {
      log.warn(
        `[Beyonce] fleet bridge passenger jump failed char=${session && session.characterID} ` +
          `bridgeChar=${bridgeJump.bridgeOwnerCharID} beacon=${bridgeJump.beaconID}: ` +
          jumpResult.errorMsg,
      );
      throwCynoNotify("The fleet bridge session change failed.");
    }
    applyJumpTimersBestEffort(session, {
      distanceLy: bridgeJump.distanceLy,
      jumpFatigueMultiplier: bridgeJump.jumpFatigueMultiplier,
    });
    log.info(
      `[Beyonce] char=${session && session.characterID} jumped through fleet bridge ` +
        `bridgeChar=${bridgeJump.bridgeOwnerCharID} bridgeShip=${bridgeJump.bridgeShip.itemID} ` +
        `beacon=${bridgeJump.beaconID} target=${bridgeJump.bridgeDestination.kind} ` +
        `type=${bridgeJump.fieldTypeID} ` +
        `destination=${bridgeJump.destinationSolarSystemID} fuelType=${bridgeJump.fuelTypeID} ` +
        `fuel=${fuelResult.consumedQuantity || 0} passengerMass=${bridgeJump.passengerMass} ` +
        `rangeMeters=${bridgeJump.bridgeDistanceMeters.toFixed(2)} ` +
        `distanceLy=${bridgeJump.distanceLy.toFixed(6)}`,
    );
    return jumpResult.data.boundResult || true;
  }

  Handle_CmdJumpToFleetDeployableBeacon(args, session) {
    return this._jumpToFleetDeployableBeacon(args, session);
  }

  Handle_CmdGroupJumpToFleetDeployableBeacon(args, session) {
    return this._jumpToFleetDeployableBeacon(args, session, {
      groupAnchor: true,
    });
  }

  Handle_CmdBridgeToFleetDeployableBeacon(args, session) {
    assertAbyssalJumpBridgeActionAllowed(
      session,
      "bridge-to-fleet-deployable-beacon",
    );
    const {
      beaconID,
      deployableEntity,
      deployableID,
      destinationSolarSystemID,
      fieldTypeID,
      ownerID,
    } = resolveFleetDeployableBeacon(args, session);
    const {
      activeShip,
      distanceLy,
      fuelTypeID,
      fuelQuantity,
    } = resolveActiveShipAndJumpDriveForCyno(
      session,
      destinationSolarSystemID,
      fieldTypeID,
      { portalBridge: true },
    );
    const portal = resolveBridgePortalModule(
      session && session.characterID,
      activeShip,
      fieldTypeID,
    );
    const activationResult = spaceRuntime.activateGenericModule(
      session,
      portal.portalModuleItem,
      getBridgePortalEffectName(portal.portalModuleItem),
      {
        repeat: 1,
      },
    );
    if (!activationResult.success) {
      if (activationResult.errorMsg === "NOT_ENOUGH_CAPACITOR") {
        throwCynoNotify("The bridge ship does not have enough capacitor to activate the jump portal.");
      }
      if (activationResult.errorMsg === "NO_FUEL") {
        throwCynoNotify("The bridge ship does not have enough jump portal activation fuel.");
      }
      if (activationResult.errorMsg === "MODULE_ALREADY_ACTIVE") {
        throwCynoNotify("That jump portal generator is already active.");
      }
      throwCynoNotify("The jump portal generator could not be activated.");
    }
    const bridgeItemID = deployableEntity ? deployableID : beaconID;
    const effectState =
      activationResult.data && activationResult.data.effectState
        ? activationResult.data.effectState
        : null;
    if (effectState) {
      effectState.autoDeactivateAtCycleEnd = true;
      effectState.consequenceDelivery = "managed";
      effectState.jumpPortalBridgeMode = {
        fleetID: session && session.fleetid,
        shipID: activeShip.itemID,
        solarsystemID: destinationSolarSystemID,
        itemID: bridgeItemID,
      };
    }
    fleetRuntime.setBridgeMode(
      session.fleetid,
      activeShip.itemID,
      destinationSolarSystemID,
      bridgeItemID,
      true,
    );
    notifyGroupJumpAnchor(session, destinationSolarSystemID, 0);
    log.info(
      `[Beyonce] char=${session && session.characterID} opened fleet deployable bridge ` +
        `ship=${activeShip.itemID} deployable=${deployableID} beacon=${beaconID} ` +
        `bridgeItem=${bridgeItemID} owner=${ownerID} destination=${destinationSolarSystemID} ` +
        `portalModule=${portal.portalModuleItem.itemID} portalType=${portal.portalModuleItem.typeID} ` +
        `fuelType=${fuelTypeID} ` +
        `portalEffect=${effectState ? effectState.effectName : getBridgePortalEffectName(portal.portalModuleItem)} ` +
        `activationCap=${effectState ? effectState.capNeed || 0 : 0} ` +
        `activationFuelType=${effectState ? effectState.fuelTypeID || 0 : 0} ` +
        `activationFuel=${effectState ? effectState.fuelPerActivation || 0 : 0} ` +
        `passengerFuelEstimate=${fuelQuantity} distanceLy=${distanceLy.toFixed(6)}`,
    );
    return true;
  }

  Handle_CallComponentFromClient(args, session, kwargs) {
    const itemID = normalizeNumber(unwrapMarshalValue(args && args[0]), 0);
    const componentName = normalizeText(unwrapMarshalValue(args && args[1]), "");
    const methodName = normalizeText(unwrapMarshalValue(args && args[2]), "");

    if (componentName === "towGameObjective") {
      if (!Number.isSafeInteger(itemID) || itemID <= 0 ||
        !["RequestStartTowing", "RequestStopTowing"].includes(methodName)) {
        throwWrappedUserError("CustomNotify", { notify: "TOW_GAME_OBJECTIVE_INVALID_REQUEST" });
      }
      const tow = require("../spaceComponents/towGameObjectiveRuntime");
      const scene = spaceRuntime.getSceneForSession(session);
      const result = methodName === "RequestStartTowing"
        ? tow.startTowing(scene, session, itemID) : tow.stopTowing(scene, session, itemID);
      if (!result.success) throwWrappedUserError("CustomNotify", { notify: result.errorMsg });
      return null;
    }

    if (componentName === "linkWithShip" && (!Number.isSafeInteger(itemID) || itemID <= 0 ||
        !["InitiateLink", "InitiateLinkQuick"].includes(methodName))) {
      throwWrappedUserError("CustomNotify", { notify: "LINK_WITH_SHIP_INVALID_REQUEST" });
    }

    if (componentName === "itemTrader" && methodName === "ProcessTrade") {
      return require("../seasons/eventHooks").outreach.processTradeFromClient(session, itemID, {
        recipeID: unwrapMarshalValue(getKwargValue(kwargs, "recipeID")),
        multiplier: unwrapMarshalValue(getKwargValue(kwargs, "multiplier")),
        inputISK: unwrapMarshalValue(getKwargValue(kwargs, "inputISK")),
      });
    }

    if (componentName === "orbitalSkyhook") {
      const skyhookRuntime = require("../sovereignty/skyhookRuntime");
      if (methodName === "IsCharacterAuthorised") {
        return skyhookRuntime.isCharacterAuthorised(session, itemID);
      }
      if (methodName === "ExtractReagentsToShip") {
        return skyhookRuntime.extractReagentsToShip(session, itemID, args[3], args[4]);
      }
    }

    if (
      componentName === "microJumpDriver" &&
      methodName === "StartMicroJumpDriveForShip"
    ) {
      const result = mobileMicroJumpUnitRuntime.startMobileMicroJumpDriveForShip(
        session,
        itemID,
      );
      if (!result || result.success !== true) {
        log.info(
          `[Beyonce] CallComponentFromClient rejected component=${componentName} method=${methodName} item=${itemID} char=${session && session.characterID} reason=${result ? result.errorMsg : "UNKNOWN"}`,
        );
      }
      return null;
    }

    if (
      componentName === "linkWithShip" &&
      (methodName === "InitiateLink" || methodName === "InitiateLinkQuick")
    ) {
      const component = spaceRuntime.getSceneForSession(session)?.getEntityByID(itemID);
      const authored = component && require("../_shared/clientSpaceComponentRules")
        .getLinkWithShipComponentAttributes(component.typeID);
      if (!authored) throwWrappedUserError("CustomNotify", { notify: "LINK_WITH_SHIP_COMPONENT_NOT_AUTHORED" });
      if (!mobileAnalysisBeaconRuntime.isMobileAnalysisBeaconType(component.typeID)) {
        const scene = spaceRuntime.getSceneForSession(session);
        const links = require("../spaceComponents/linkWithShipRuntime");
        // Silo hydration can precede insertion into the scene. Rebind only
        // the live, domain-marked silo; its owner validates persisted identity.
        if (component.evejsSkyhookReagentSilo === true) links.bindComponent(scene, component,
          (pilot, options) => require("../sovereignty/skyhookRaidRuntime").startRaidLink(pilot, itemID, options));
        const result = links.initiateLink(scene, session, itemID,
          { quick: methodName === "InitiateLinkQuick" });
        if (!result.success) throwWrappedUserError("CustomNotify", { notify: result.errorMsg });
        return null;
      }
      const result = mobileAnalysisBeaconRuntime.initiateMobileAnalysisBeaconLink(
        session,
        itemID,
        { quick: methodName === "InitiateLinkQuick" },
      );
      if (!result || result.success !== true) {
        log.info(
          `[Beyonce] CallComponentFromClient rejected component=${componentName} method=${methodName} item=${itemID} char=${session && session.characterID} reason=${result ? result.errorMsg : "UNKNOWN"}`,
        );
      }
      return null;
    }

    log.info(
      `[Beyonce] Unsupported CallComponentFromClient component=${componentName} method=${methodName} item=${itemID} char=${session && session.characterID}`,
    );
    return null;
  }

  Handle_CmdGotoDirection(args, session) {
    const x = normalizeNumber(args && args[0], 0);
    const y = normalizeNumber(args && args[1], 0);
    const z = normalizeNumber(args && args[2], 0);
    this._enforceMovementCommandThrottle(session, "CmdGotoDirection", [x, y, z]);

    log.info(
      `[Beyonce] CmdGotoDirection char=${session && session.characterID} dir=(${x}, ${y}, ${z})`,
    );
    spaceRuntime.gotoDirection(session, { x, y, z }, {
      commandSource: "CmdGotoDirection",
      ownerLocallyPredictsHeading: false,
    });
    return null;
  }

  Handle_CmdSteerDirection(args, session) {
    const x = normalizeNumber(args && args[0], 0);
    const y = normalizeNumber(args && args[1], 0);
    const z = normalizeNumber(args && args[2], 0);
    this._enforceMovementCommandThrottle(session, "CmdSteerDirection", [x, y, z]);

    log.info(
      `[Beyonce] CmdSteerDirection char=${session && session.characterID} dir=(${x}, ${y}, ${z})`,
    );
    spaceRuntime.gotoDirection(session, { x, y, z }, {
      commandSource: "CmdSteerDirection",
      ownerLocallyPredictsHeading: true,
    });
    return null;
  }

  Handle_CmdGotoPoint(args, session) {
    const x = normalizeNumber(args && args[0], 0);
    const y = normalizeNumber(args && args[1], 0);
    const z = normalizeNumber(args && args[2], 0);
    this._enforceMovementCommandThrottle(session, "CmdGotoPoint", [x, y, z]);

    log.info(
      `[Beyonce] CmdGotoPoint char=${session && session.characterID} point=(${x}, ${y}, ${z})`,
    );
    spaceRuntime.gotoPoint(session, { x, y, z });
    return null;
  }

  Handle_CmdGotoBookmark(args, session) {
    const bookmarkID = normalizeNumber(args && args[0], 0);
    const bookmark = resolveBookmarkAnyStore(session, bookmarkID);
    log.info(
      `[Beyonce] CmdGotoBookmark char=${session && session.characterID} bookmark=${bookmarkID}`,
    );
    if (!bookmark) {
      throwWrappedUserError("BookmarkNotAvailable");
    }

    const targetID = normalizeNumber(bookmark.itemID, 0);
    if (targetID > 0) {
      const scene = spaceRuntime.getSceneForSession(session);
      const entity =
        scene && typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(targetID)
          : null;
      if (entity) {
        spaceRuntime.followBall(session, targetID, 0);
        return null;
      }
    }

    const point = {
      x: normalizeNumber(bookmark.x, 0),
      y: normalizeNumber(bookmark.y, 0),
      z: normalizeNumber(bookmark.z, 0),
    };
    if (point.x !== 0 || point.y !== 0 || point.z !== 0) {
      spaceRuntime.gotoPoint(session, point, {
        commandSource: "CmdGotoBookmark",
      });
      return null;
    }

    throwWrappedUserError("BookmarkNotAvailable");
  }

  Handle_CmdAlignTo(args, session, kwargs) {
    const positionalTargetID = normalizeNumber(args && args[0], 0);
    const kwargTargetID = normalizeNumber(getKwargValue(kwargs, "dstID"), 0);
    const bookmarkID = normalizeNumber(getKwargValue(kwargs, "bookmarkID"), 0);
    const targetID =
      positionalTargetID ||
      kwargTargetID ||
      resolveBookmarkAlignTarget(session, bookmarkID);
    log.info(
      `[Beyonce] CmdAlignTo char=${session && session.characterID} target=${targetID} bookmark=${bookmarkID}`,
    );

    if (targetID > 0) {
      spaceRuntime.alignTo(session, targetID);
      return null;
    }

    if (bookmarkID > 0) {
      const bookmark = resolveBookmarkAnyStore(session, bookmarkID);
      if (bookmark) {
        const point = {
          x: normalizeNumber(bookmark.x, 0),
          y: normalizeNumber(bookmark.y, 0),
          z: normalizeNumber(bookmark.z, 0),
        };
        if (point.x !== 0 || point.y !== 0 || point.z !== 0) {
          spaceRuntime.gotoPoint(session, point, {
            commandSource: "CmdAlignToBookmark",
          });
          return null;
        }
      }
    }

    spaceRuntime.alignTo(session, targetID);
    return null;
  }

  Handle_CmdFollowBall(args, session) {
    const targetID = normalizeNumber(args && args[0], 0);
    const range = normalizeNumber(args && args[1], 0);
    this._enforceMovementCommandThrottle(session, "CmdFollowBall", [targetID, range]);
    log.info(
      `[Beyonce] CmdFollowBall char=${session && session.characterID} target=${targetID} range=${range}`,
    );
    if (targetID > 0 && range <= 50) {
      const dockingDebug = spaceRuntime.getDockingDebugState(session, targetID);
      if (dockingDebug) {
        log.info(`[Beyonce] CmdFollowBall dockingState=${JSON.stringify(dockingDebug)}`);
      }
    }

    spaceRuntime.followBall(session, targetID, range);
    return null;
  }

  Handle_CmdOrbit(args, session) {
    const targetID = normalizeNumber(args && args[0], 0);
    const range = normalizeNumber(args && args[1], 0);
    this._enforceMovementCommandThrottle(session, "CmdOrbit", [targetID, range]);
    log.info(
      `[Beyonce] CmdOrbit char=${session && session.characterID} target=${targetID} range=${range}`,
    );
    spaceRuntime.orbit(session, targetID, range);
    return null;
  }

  Handle_CmdSetSpeedFraction(args, session) {
    const fraction = normalizeNumber(args && args[0], 0);
    log.info(
      `[Beyonce] CmdSetSpeedFraction char=${session && session.characterID} fraction=${fraction}`,
    );
    spaceRuntime.setSpeedFraction(session, fraction);
    return null;
  }

  Handle_CmdStop(args, session) {
    this._enforceMovementCommandThrottle(session, "CmdStop");
    log.info(`[Beyonce] CmdStop char=${session && session.characterID}`);
    const activeWarp = this._isSessionShipInActiveWarp(session);
    spaceRuntime.stop(session);
    if (activeWarp) {
      this._notifyShipInWarpRemoteMessage(session);
    }
    return null;
  }

  Handle_CmdAbandonLoot(args, session) {
    const unwrappedItemIDs = unwrapMarshalValue(args && args[0]);
    const itemIDs = Array.isArray(unwrappedItemIDs)
      ? unwrappedItemIDs
      : unwrappedItemIDs !== null && unwrappedItemIDs !== undefined
        ? [unwrappedItemIDs]
        : [];
    log.info(
      `[Beyonce] CmdAbandonLoot char=${session && session.characterID} count=${itemIDs.length}`,
    );
    spaceRuntime.abandonInventoryLootForSession(session, itemIDs);
    return null;
  }

  Handle_CmdFleetTagTarget(args, session) {
    const itemID = normalizeNumber(args && args[0], 0);
    const tag = args && args.length > 1 ? args[1] : null;
    log.info(
      `[Beyonce] CmdFleetTagTarget char=${session && session.characterID} item=${itemID} tag=${tag === null || tag === undefined ? "<clear>" : String(tag)}`,
    );
    fleetRuntime.setFleetTargetTag(session, itemID, tag);
    return null;
  }

  Handle_CmdWarpToStuff(args, session, kwargs) {
    const warpType = String(args && args[0] ? args[0] : "");
    const rawTarget = args && args.length > 1 ? args[1] : null;
    const numericTarget = normalizeNumber(rawTarget, 0);
    const minimumRange = normalizeNumber(getKwargValue(kwargs, "minRange"), 0);
    // The client sets fleet=True for "Warp Fleet/Wing/Squad" commands
    // (movementFunctions.WarpFleet -> michelle.CmdWarpToStuff(..., fleet=True)).
    const fleetWarpRequested = Boolean(getKwargValue(kwargs, "fleet"));

    log.info(
      `[Beyonce] CmdWarpToStuff char=${session && session.characterID} type=${warpType} target=${numericTarget || rawTarget} minRange=${minimumRange}${fleetWarpRequested ? " fleet=1" : ""}`,
    );

    const activeAbyssalRun = getActiveAbyssalRunForSession(session);
    const abyssalMgrService = getAbyssalMgrService();
    const abyssalRestrictionBypassAllowed =
      typeof abyssalMgrService.isAbyssalRestrictionBypassAllowed === "function" &&
      abyssalMgrService.isAbyssalRestrictionBypassAllowed({
        session,
        restriction: "warp",
      });
    if (activeAbyssalRun && !abyssalRestrictionBypassAllowed) {
      log.info(
        `[AbyssalMgr] Warp blocked inside Abyssal run char=${session && session.characterID} ` +
          `ship=${normalizeNumber(session && session.shipID, 0)} ` +
          `instance=${normalizeNumber(activeAbyssalRun.instanceID, 0)} ` +
          `warpType=${warpType || "item"} target=${numericTarget || rawTarget || 0}`,
      );
      throwAbyssalWarpBlockedError();
    }

    if (this._isSessionShipWarping(session)) {
      this._notifyShipInWarpRemoteMessage(session);
      return null;
    }

    let result = null;
    if (warpType === "scan" && rawTarget !== null && rawTarget !== undefined) {
      const scanTarget = resolveScanWarpTarget(session, rawTarget);
      // A site the pilot has scanned to 100% is one they are allowed into, and
      // this is the only place that says so. The grant used to live solely in
      // the numeric-target arm below, which is unreachable whenever
      // resolveScanWarpTarget finds the site -- and it always does, because it
      // materialises the site itself. The result was that scanning a signature
      // down to 100% still left you unable to warp to it.
      const completedScanForTarget =
        probeScanWarpAuthority.resolveCompletedScanWarpTarget(
          session,
          rawTarget,
          { systemID: getSessionSolarSystemID(session) },
        );
      if (
        scanTarget &&
        completedScanForTarget &&
        completedScanForTarget.destinationStaticInstanceID !== null
      ) {
        grantAcquiredMissionAccess(
          session,
          completedScanForTarget.destinationStaticInstanceID,
          "combat_probe_scan",
        );
      }
      if (scanTarget && scanTarget.kind === "entity") {
        result = spaceRuntime.warpToEntity(session, scanTarget.entityID, {
          minimumRange,
          ...(scanTarget.instanceID !== null
            ? { destinationStaticInstanceID: scanTarget.instanceID }
            : {}),
        });
      } else if (scanTarget && scanTarget.kind === "point") {
        result = spaceRuntime.warpToPoint(session, scanTarget.point, {
          minimumRange,
          stopDistance: minimumRange,
          ...(scanTarget.instanceID !== null
            ? { destinationStaticInstanceID: scanTarget.instanceID }
            : {}),
        });
      } else if (numericTarget > 0) {
        const completedScanTarget =
          probeScanWarpAuthority.resolveCompletedScanWarpTarget(
            session,
            numericTarget,
            { systemID: getSessionSolarSystemID(session) },
          );
        if (completedScanTarget) {
          if (completedScanTarget.destinationStaticInstanceID !== null) {
            grantAcquiredMissionAccess(
              session,
              completedScanTarget.destinationStaticInstanceID,
              "combat_probe_scan",
            );
          }
          result = spaceRuntime.warpToPoint(session, completedScanTarget.point, {
            minimumRange,
            stopDistance: minimumRange,
            ...(completedScanTarget.destinationStaticInstanceID !== null
              ? {
                  ...(completedScanTarget.destinationDungeonRoomKey
                    ? {
                        destinationDungeonRoomKey:
                          completedScanTarget.destinationDungeonRoomKey,
                      }
                    : {}),
                  ...(completedScanTarget.destinationDungeonSiteID !== null
                    ? {
                        destinationDungeonSiteID:
                          completedScanTarget.destinationDungeonSiteID,
                      }
                    : {}),
                  destinationStaticInstanceID:
                    completedScanTarget.destinationStaticInstanceID,
                }
              : {}),
          });
        } else {
          result = {
            success: false,
            errorMsg: "SCAN_TARGET_NOT_FOUND",
          };
        }
      } else {
        result = {
          success: false,
          errorMsg: "SCAN_TARGET_NOT_FOUND",
        };
      }
    } else if (warpType === WARP_SUBJECT_MOON_MINING_POINT && numericTarget > 0) {
      // The client identifies this destination by its moon ID, while the
      // runtime scene exposes the canonical point as a separate beacon entity.
      // Resolve only through the packaged authority and keep it system-local;
      // no caller-supplied coordinates may turn this into cross-system warp.
      const moonMiningPoint = worldData.getMoonMiningPointByMoonID(numericTarget);
      if (!moonMiningPoint || moonMiningPoint.solarSystemID !== getSessionSolarSystemID(session)) {
        result = {
          success: false,
          errorMsg: "MOON_MINING_POINT_NOT_FOUND",
        };
      } else {
        result = spaceRuntime.warpToEntity(session, moonMiningPoint.beaconID, {
          minimumRange,
        });
      }
    } else if (warpType === "launch" && numericTarget > 0) {
      const launch = planetRuntimeStore.getLaunch(
        numericTarget,
        session && session.characterID,
      );
      if (launch) {
        const launchItemID = normalizeNumber(launch.itemID || launch.launchID, 0);
        if (launchItemID > 0) {
          result = spaceRuntime.warpToEntity(session, launchItemID, { minimumRange });
        }
        if (!result || !result.success) {
          result = spaceRuntime.warpToPoint(session, {
            x: normalizeNumber(launch.x, 0),
            y: normalizeNumber(launch.y, 0),
            z: normalizeNumber(launch.z, 0),
          }, {
            minimumRange,
            stopDistance: minimumRange,
          });
        }
      } else {
        result = spaceRuntime.warpToEntity(session, numericTarget, { minimumRange });
      }
    } else if (warpType === WARP_SUBJECT_OPERATION_DUNGEON) {
      const operationPoint = resolveOperationDungeonWarpPoint(session, numericTarget);
      const operation = operationSiteRuntime.resolveOperationSpawnpointRecord(getSessionCharacterID(session), numericTarget);
      const instanceID = Number(operation?.dungeonInstanceID || 0);
      const visibility = instanceID ? resolveDungeonInstanceVisibilityForSession(session, instanceID, { systemID: getSessionSolarSystemID(session) }) : null;
      if (operationPoint && (!instanceID || visibility)) {
        result = spaceRuntime.warpToPoint(session, operationPoint, {
          minimumRange,
          stopDistance: minimumRange,
          ...(instanceID ? { destinationStaticInstanceID: instanceID, destinationDungeonSiteID: visibility.instance.spawnState.siteID } : {}),
        });
      } else {
        result = {
          success: false,
          errorMsg: "OPERATION_SITE_NOT_FOUND",
        };
      }
    } else if (DUNGEON_INSTANCE_WARP_SUBJECTS.has(warpType)) {
      const dungeonInstanceID = extractDungeonInstanceID(rawTarget);
      const materializedInstanceTarget = maybeMaterializeUniverseSiteInstanceTarget(
        session,
        dungeonInstanceID,
      );
      if (materializedInstanceTarget) {
        result = spaceRuntime.warpToEntity(
          session,
          materializedInstanceTarget.entityID,
          {
            minimumRange,
            destinationStaticInstanceID:
              materializedInstanceTarget.instanceID,
          },
        );
      } else {
        result = {
          success: false,
          errorMsg: "DUNGEON_INSTANCE_NOT_FOUND",
        };
      }
    } else if (warpType === "char" && numericTarget > 0) {
      const fleetMemberTarget = resolveFleetMemberWarpTarget(session, numericTarget);
      if (fleetMemberTarget && fleetMemberTarget.kind === "blocked") {
        log.info(
          `[AbyssalMgr] Fleet warp to Abyssal runner blocked char=${session && session.characterID} ` +
            `targetChar=${numericTarget} reason=${fleetMemberTarget.reason || "ABYSSAL_TARGET"}`,
        );
        throwAbyssalFleetMemberWarpBlockedError();
      } else if (fleetMemberTarget && fleetMemberTarget.kind === "entity") {
        result = spaceRuntime.warpToEntity(
          session,
          fleetMemberTarget.entityID,
          {
            minimumRange,
            ...(fleetMemberTarget.destinationStaticInstanceID !== null
              ? {
                  ...(fleetMemberTarget.destinationDungeonRoomKey
                    ? {
                        destinationDungeonRoomKey:
                          fleetMemberTarget.destinationDungeonRoomKey,
                      }
                    : {}),
                  ...(fleetMemberTarget.destinationDungeonSiteID !== null
                    ? {
                        destinationDungeonSiteID:
                          fleetMemberTarget.destinationDungeonSiteID,
                      }
                    : {}),
                  destinationStaticInstanceID:
                    fleetMemberTarget.destinationStaticInstanceID,
                }
              : {}),
          },
        );
      } else if (fleetMemberTarget && fleetMemberTarget.kind === "point") {
        result = spaceRuntime.warpToPoint(session, fleetMemberTarget.point, {
          minimumRange,
          stopDistance: minimumRange,
          ...(fleetMemberTarget.destinationStaticInstanceID !== null
            ? {
                ...(fleetMemberTarget.destinationDungeonRoomKey
                  ? {
                      destinationDungeonRoomKey:
                        fleetMemberTarget.destinationDungeonRoomKey,
                    }
                  : {}),
                ...(fleetMemberTarget.destinationDungeonSiteID !== null
                  ? {
                      destinationDungeonSiteID:
                        fleetMemberTarget.destinationDungeonSiteID,
                    }
                  : {}),
                destinationStaticInstanceID:
                  fleetMemberTarget.destinationStaticInstanceID,
              }
            : {}),
        });
      } else {
        result = {
          success: false,
          errorMsg: "FLEET_MEMBER_WARP_TARGET_NOT_FOUND",
        };
      }
    } else if ((warpType === "item" || !warpType) && numericTarget > 0) {
      const scene = spaceRuntime.getSceneForSession(session);
      const entity =
        scene && typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(numericTarget)
          : null;
      if (
        entity &&
        (
          entity.signalTrackerUniverseSeededSite === true ||
          String(entity.kind || "").trim() === "missionSite"
        )
      ) {
        ensureUniverseSiteContentsMaterialized(scene, {
          siteID: numericTarget,
        }, {
          spawnEncounters: true,
          broadcast: true,
          session,
        });
      }
      const materializedInstanceTarget = entity
        ? null
        : maybeMaterializeUniverseSiteInstanceTarget(session, numericTarget);
      const destinationStaticInstanceID = normalizeDungeonInstanceID(
        materializedInstanceTarget
          ? materializedInstanceTarget.instanceID
          : entity && (
              entity.dungeonSiteInstanceID ||
              entity.airNpeInstanceID ||
              (entity.kind === "ship"
                ? entity.dungeonCurrentInstanceID
                : null)
            ),
      );
      const destinationDungeonRoomKey = destinationStaticInstanceID !== null &&
        entity && entity.kind === "ship"
        ? String(entity.dungeonCurrentRoomKey || "").trim() || null
        : null;
      const destinationDungeonSiteID = destinationStaticInstanceID !== null
        ? normalizePersistentEntityID(
            entity && entity.kind === "ship"
              ? entity.dungeonCurrentSiteID
              : entity && entity.dungeonSiteID,
          )
        : null;
      result = spaceRuntime.warpToEntity(
        session,
        materializedInstanceTarget
          ? materializedInstanceTarget.entityID
          : numericTarget,
        {
          minimumRange,
          ...(destinationStaticInstanceID !== null
            ? {
                ...(destinationDungeonRoomKey
                  ? { destinationDungeonRoomKey }
                  : {}),
                ...(destinationDungeonSiteID !== null
                  ? { destinationDungeonSiteID }
                  : {}),
                destinationStaticInstanceID,
              }
            : {}),
        },
      );
    } else if (warpType === "bookmark" && numericTarget > 0) {
      const bookmark = resolveBookmarkAnyStore(session, numericTarget);
      if (!bookmark) {
        throwWrappedUserError("BookmarkNotAvailable");
      }

      const bookmarkMetadata =
        bookmark.metadata && typeof bookmark.metadata === "object"
          ? bookmark.metadata
          : {};
      const missionInstanceID = normalizeNumber(
        bookmarkMetadata.missionInstanceID,
        0,
      );
      const missionMaterialization = missionInstanceID > 0
        ? maybeMaterializeMissionBookmarkTarget(session, bookmark)
        : null;
      const scopedBookmarkFailed = Boolean(
        missionInstanceID > 0 &&
        (!missionMaterialization || missionMaterialization.success !== true)
      );
      const destinationDungeonOptions = missionInstanceID > 0
        ? { destinationStaticInstanceID: missionInstanceID }
        : {};
      const materializedSiteID = normalizeNumber(
        missionMaterialization &&
          missionMaterialization.data &&
          missionMaterialization.data.siteID,
        0,
      );
      const bookmarkItemID = materializedSiteID ||
        normalizeNumber(bookmark.itemID, 0);
      if (scopedBookmarkFailed) {
        result = {
          success: false,
          errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
        };
      }
      if (bookmarkItemID > 0) {
        if (!scopedBookmarkFailed) {
          result = spaceRuntime.warpToEntity(session, bookmarkItemID, {
            ...destinationDungeonOptions,
            minimumRange,
          });
        }
        if ((!result || !result.success) &&
          !scopedBookmarkFailed &&
          (
            normalizeNumber(bookmark.x, 0) !== 0 ||
            normalizeNumber(bookmark.y, 0) !== 0 ||
            normalizeNumber(bookmark.z, 0) !== 0
          )
        ) {
          result = spaceRuntime.warpToPoint(session, {
            x: normalizeNumber(bookmark.x, 0),
            y: normalizeNumber(bookmark.y, 0),
            z: normalizeNumber(bookmark.z, 0),
          }, {
            ...destinationDungeonOptions,
            minimumRange,
            stopDistance: minimumRange,
          });
        }
      } else if (!scopedBookmarkFailed) {
        result = spaceRuntime.warpToPoint(session, {
          x: normalizeNumber(bookmark.x, 0),
          y: normalizeNumber(bookmark.y, 0),
          z: normalizeNumber(bookmark.z, 0),
        }, {
          ...destinationDungeonOptions,
          minimumRange,
          stopDistance: minimumRange,
        });
      }
    } else if (
      rawTarget &&
      typeof rawTarget === "object" &&
      rawTarget.x !== undefined &&
      rawTarget.y !== undefined &&
      rawTarget.z !== undefined
    ) {
      result = spaceRuntime.warpToPoint(session, rawTarget, {
        minimumRange,
        stopDistance: minimumRange,
      });
    } else {
      result = {
        success: false,
        errorMsg: "UNSUPPORTED_WARP_TARGET",
      };
    }

    if (!result || !result.success) {
      log.warn(
        `[Beyonce] CmdWarpToStuff failed for char=${session && session.characterID}: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}`,
      );
      this._throwWarpFailureUserError(result && result.errorMsg);
    } else {
      notifyDistributionDungeonForWarp(session, result);
      if (fleetWarpRequested) {
        this._warpFleetFollowers(session, result, {
          minimumRange,
          formationSettings: getKwargValue(kwargs, "fleetFormationSettings"),
        });
      }
    }

    return null;
  }

  // Pull the issuing commander's fleet/wing/squad along on a fleet warp. The
  // commander has already been warped through the normal path; this warps every
  // subordinate member who is in the same solar system and accepts fleet warp to
  // the same destination, each computing their own warp-in for their own ship.
  _warpFleetFollowers(commanderSession, leaderResult, options = {}) {
    const commanderCharID = normalizeNumber(
      commanderSession &&
        (commanderSession.characterID || commanderSession.charID),
      0,
    );
    if (commanderCharID <= 0) {
      return 0;
    }

    const leaderPendingWarp =
      leaderResult && leaderResult.data && typeof leaderResult.data === "object"
        ? leaderResult.data
        : null;
    // Form the fleet's requested landing plan before individual bubble and
    // immunity checks. A caught commander must not redirect immune members.
    const pendingWarp = leaderPendingWarp && leaderPendingWarp.requested &&
      typeof leaderPendingWarp.requested === "object"
      ? { ...leaderPendingWarp, ...leaderPendingWarp.requested }
      : leaderPendingWarp;
    const targetEntityID = pendingWarp
      ? normalizeNumber(pendingWarp.targetEntityID, 0)
      : 0;
    const rawDestination =
      pendingWarp &&
      pendingWarp.rawDestination &&
      typeof pendingWarp.rawDestination === "object"
        ? pendingWarp.rawDestination
        : null;
    const stopDistance = pendingWarp
      ? normalizeNumber(pendingWarp.stopDistance, 0)
      : 0;
    const destinationDungeonOptions = pendingWarp
      ? {
          ...(pendingWarp.destinationStaticInstanceID !== null &&
          pendingWarp.destinationStaticInstanceID !== undefined
            ? {
                destinationStaticInstanceID:
                  pendingWarp.destinationStaticInstanceID,
              }
            : {}),
          ...(String(pendingWarp.destinationDungeonRoomKey || "").trim()
            ? {
                destinationDungeonRoomKey: String(
                  pendingWarp.destinationDungeonRoomKey,
                ).trim(),
              }
            : {}),
          ...(pendingWarp.destinationDungeonSiteID !== null &&
          pendingWarp.destinationDungeonSiteID !== undefined
            ? {
                destinationDungeonSiteID:
                  pendingWarp.destinationDungeonSiteID,
              }
            : {}),
        }
      : {};
    if (targetEntityID <= 0 && !rawDestination) {
      return 0;
    }

    const minimumRange = normalizeNumber(options.minimumRange, 0);
    const commanderSystemID = normalizeNumber(
      commanderSession &&
        (commanderSession.solarsystemid2 || commanderSession.solarsystemid),
      0,
    );

    let followers = [];
    try {
      followers = fleetRuntime.collectFleetWarpFollowers(commanderCharID) || [];
    } catch (error) {
      log.warn(
        `[Beyonce] Fleet warp follower lookup failed for char=${commanderCharID}: ${error.message}`,
      );
      return 0;
    }

    // This service's established command scope pulls eligible members in the
    // commander's system; each follower still runs the normal warp checks.
    const eligibleFollowers = followers.filter((follower) => {
      const followerSession = follower && follower.session;
      if (!followerSession) {
        return false;
      }
      const followerSystemID = normalizeNumber(
        followerSession.solarsystemid2 || followerSession.solarsystemid,
        0,
      );
      return !(
        commanderSystemID > 0 &&
        followerSystemID > 0 &&
        followerSystemID !== commanderSystemID
      );
    });

    const commanderGeneration = commanderSession && commanderSession._space;
    const associationToken =
      leaderResult &&
      leaderResult.success === true &&
      leaderResult.redundant !== true
        ? crypto.randomUUID()
        : "";
    const associationTokenPrefix = associationToken
      ? associationToken.replace(/-/g, "").slice(0, 8)
      : "";
    const landingRotationFraction = associationTokenPrefix
      ? Number.parseInt(associationTokenPrefix, 16) / 0x1_0000_0000
      : 0;
    const formationPoints = this._resolveFleetWarpFormationPoints(
      commanderSession,
      eligibleFollowers,
      {
        landingRotationFraction,
        pendingWarp,
        leaderWarpJitter: leaderResult && leaderResult.warpJitter,
        formationSettings: options.formationSettings,
      },
    );

    let warpedCount = 0;
    for (const follower of eligibleFollowers) {
      const followerSession = follower.session;
      const followerGeneration = followerSession && followerSession._space;
      const formationPoint = formationPoints.get(
        normalizeNumber(follower.characterID, 0),
      );

      let followerResult = null;
      if (formationPoint) {
        // The leader already resolved the target geometry. Followers consume
        // that command-scoped landing anchor (or an explicit formation slot)
        // directly instead of independently resolving the target again.
        followerResult = spaceRuntime.warpToPoint(followerSession, formationPoint, {
          ...destinationDungeonOptions,
          stopDistance: 0,
          ...(targetEntityID > 0 ? { targetEntityID } : {}),
        });
      } else if (targetEntityID > 0) {
        followerResult = spaceRuntime.warpToEntity(
          followerSession,
          targetEntityID,
          { ...destinationDungeonOptions, minimumRange },
        );
      } else if (rawDestination) {
        followerResult = spaceRuntime.warpToPoint(followerSession, rawDestination, {
          ...destinationDungeonOptions,
          minimumRange,
          stopDistance,
        });
      }

      if (followerResult && followerResult.success) {
        warpedCount += 1;
        if (associationToken && followerResult.redundant !== true) {
          try {
            spaceRuntime.associateSuccessfulFleetWarpFollower(
              commanderSession,
              followerSession,
              associationToken,
              {
                leaderGeneration: commanderGeneration,
                leaderResult,
                followerGeneration,
                followerResult,
              },
            );
          } catch (error) {
            log.warn(
              `[Beyonce] Fleet warp association failed for char=${normalizeNumber(
                follower && follower.characterID,
                0,
              )}: ${error.message}`,
            );
          }
        }
        this._notifyFleetWarpRemoteMessage(followerSession, targetEntityID);
      }
    }

    if (warpedCount > 0) {
      log.info(
        `[Beyonce] Fleet warp pulled ${warpedCount} member(s) for commander char=${commanderCharID}` +
          `${formationPoints.size > 0 ? ` with a shared landing plan` : ""}`,
      );
    }
    return warpedCount;
  }

  // Resolve per-follower landing points around the commander's already-resolved
  // landing anchor. Standard POINT/no-settings warps use a compact collision-
  // aware cloud; explicit offset formations retain their requested geometry.
  // The commander's landing is jittered like every warp; the anchor is that
  // landing before its jitter (`context.leaderWarpJitter`, the offset its
  // warpToPoint reports), since each member's own warp jitters again.
  _resolveFleetWarpFormationPoints(commanderSession, followers, context = {}) {
    const empty = new Map();
    const settings = resolveFormationSettings(context.formationSettings);
    const pendingWarp = context.pendingWarp || null;
    const leaderWarpJitter = context.leaderWarpJitter || null;
    const anchorPoint =
      pendingWarp &&
      pendingWarp.targetPoint &&
      typeof pendingWarp.targetPoint === "object"
        ? {
            x: normalizeNumber(pendingWarp.targetPoint.x, 0) -
              normalizeNumber(leaderWarpJitter && leaderWarpJitter.x, 0),
            y: normalizeNumber(pendingWarp.targetPoint.y, 0) -
              normalizeNumber(leaderWarpJitter && leaderWarpJitter.y, 0),
            z: normalizeNumber(pendingWarp.targetPoint.z, 0) -
              normalizeNumber(leaderWarpJitter && leaderWarpJitter.z, 0),
          }
        : null;
    if (!anchorPoint || followers.length === 0) {
      return empty;
    }

    const scene = spaceRuntime.getSceneForSession(commanderSession);
    const getShipEntity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? (targetSession) => scene.getShipEntityForSession(targetSession)
        : null;

    const commanderEntity = getShipEntity ? getShipEntity(commanderSession) : null;
    const commanderPosition = commanderEntity && commanderEntity.position;
    const warpDirection = commanderPosition
      ? {
          x: normalizeNumber(anchorPoint.x, 0) - normalizeNumber(commanderPosition.x, 0),
          y: normalizeNumber(anchorPoint.y, 0) - normalizeNumber(commanderPosition.y, 0),
          z: normalizeNumber(anchorPoint.z, 0) - normalizeNumber(commanderPosition.z, 0),
        }
      : null;

    // Stable slot order so a member always lands in the same formation slot.
    const orderedFollowers = followers
      .map((follower) => {
        const followerEntity = getShipEntity
          ? getShipEntity(follower.session)
          : null;
        return {
          characterID: normalizeNumber(follower.characterID, 0),
          position: followerEntity && followerEntity.position,
          radius: normalizeNumber(followerEntity && followerEntity.radius, 0),
        };
      })
      .sort((left, right) => left.characterID - right.characterID);

    if (!settings || settings.formationType === 0) {
      return computeFleetWarpPointLandingPoints({
        anchorPoint,
        anchorRadius: normalizeNumber(commanderEntity && commanderEntity.radius, 0),
        warpDirection,
        followers: orderedFollowers,
        rotationFraction: normalizeNumber(context.landingRotationFraction, 0),
      });
    }

    return computeFleetWarpFormationPoints({
      anchorPoint,
      warpDirection,
      anchorPosition: commanderPosition,
      formationType: settings.formationType,
      spacingMeters: settings.spacingMeters,
      sizeMeters: settings.sizeMeters,
      followers: orderedFollowers,
    });
  }

  // Tell a pulled member's client a fleet warp is in progress so it cancels its
  // local autopilot navigation and updates the warp-destination cache
  // (spaceMgr/autopilot OnRemoteMessage('FleetWarp') handlers in the client).
  _notifyFleetWarpRemoteMessage(session, celestialID) {
    if (!session || typeof session.sendNotification !== "function") {
      return;
    }
    const warpInfoDict = {
      type: "dict",
      entries:
        normalizeNumber(celestialID, 0) > 0
          ? [["celestialID", normalizeNumber(celestialID, 0)]]
          : [],
    };
    try {
      session.sendNotification("OnRemoteMessage", "clientID", [
        "FleetWarp",
        warpInfoDict,
      ]);
    } catch (error) {
      log.warn(
        `[Beyonce] Fleet warp remote message failed for char=${session && session.characterID}: ${error.message}`,
      );
    }
  }

  _notifyShipInWarpRemoteMessage(session) {
    if (!session || typeof session.sendNotification !== "function") {
      return false;
    }
    try {
      session.sendNotification("OnRemoteMessage", "clientID", [
        "ShipInWarp",
        null,
      ]);
      return true;
    } catch (error) {
      log.warn(
        `[Beyonce] ShipInWarp remote message failed for char=${session && session.characterID}: ${error.message}`,
      );
      return false;
    }
  }

  _isSessionShipInActiveWarp(session) {
    const scene = spaceRuntime.getSceneForSession(session);
    const entity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
    return Boolean(
      entity &&
      entity.mode === "WARP" &&
      Number(entity.effectStamp) >= 0,
    );
  }

  _isSessionShipWarping(session) {
    const scene = spaceRuntime.getSceneForSession(session);
    const entity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
    return Boolean(
      entity && entity.mode === "WARP",
    );
  }

  Handle_CmdWarpToStuffAutopilot(args, session) {
    const targetID = normalizeNumber(args && args[0], 0);
    log.info(
      `[Beyonce] CmdWarpToStuffAutopilot char=${session && session.characterID} target=${targetID}`,
    );
    const activeAbyssalRun = getActiveAbyssalRunForSession(session);
    if (activeAbyssalRun) {
      log.info(
        `[AbyssalMgr] Warp-out prevented char=${session && session.characterID} ` +
          `ship=${normalizeNumber(session && session.shipID, 0)} ` +
          `instance=${normalizeNumber(activeAbyssalRun.instanceID, 0)} ` +
          `warpType=autopilot target=${targetID}`,
      );
      throwAbyssalWarpBlockedError();
    }
    const result = spaceRuntime.warpToEntity(session, targetID, { minimumRange: 10000 });
    if (!result || !result.success) {
      log.warn(
        `[Beyonce] CmdWarpToStuffAutopilot failed for char=${session && session.characterID}: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}`,
      );
      this._throwWarpFailureUserError(result && result.errorMsg);
    }
    return null;
  }

  Handle_CmdDock(args, session) {
    if (require("./breacherPodDeathRuntime").isShipDeathPending(session?._space?.shipID)) {
      throwWrappedUserError("DockingRequestDenied", { reason: "Your ship is being destroyed." });
    }
    const stationID = normalizeNumber(args && args[0], 0);
    log.info(
      `[Beyonce] CmdDock char=${session && session.characterID} station=${stationID}`,
    );
    const dockingDebug = spaceRuntime.getDockingDebugState(session, stationID);
    if (dockingDebug) {
      log.info(`[Beyonce] CmdDock state=${JSON.stringify(dockingDebug)}`);
    }

    if (spaceRuntime.isDockingDisallowedByModules(session)) {
      log.info(
        `[Beyonce] CmdDock denied by active module for char=${session && session.characterID} station=${stationID}`,
      );
      throwWrappedUserError("DockingRequestDenied", {
        reason: "You cannot dock while a module that prevents docking is active.",
      });
    }

    if (!spaceRuntime.canDockAtStation(session, stationID)) {
      log.info(
        `[Beyonce] CmdDock converting to docking approach for char=${session && session.characterID} station=${stationID}`,
      );
      // The ship is flown at the station, and the server docks it when it
      // arrives: Tranquility answers DockingApproach and the client asks
      // nothing more. A pilot who does ask again while still out of range is
      // answered the same way and sent the same order again (the one recording
      // of a second DockingApproach answer has a second GotoPoint after it).
      const approaching = spaceRuntime.startDockingApproach(session, stationID);
      if (!approaching) {
        log.info(
          `[Beyonce] CmdDock could not start a docking approach for char=${session && session.characterID} station=${stationID}`,
        );
      }
      throwWrappedUserError(
        "DockingApproach",
        buildDockingApproachUserErrorValues(dockingDebug),
      );
    }

    const result = spaceRuntime.acceptDocking(session, stationID);
    if (!result.success) {
      log.warn(
        `[Beyonce] CmdDock failed for char=${session && session.characterID}: ${result.errorMsg}`,
      );
      if (result.errorMsg === "DOCKING_DISALLOWED_BY_MODULE") {
        throwWrappedUserError("DockingRequestDenied", {
          reason: "You cannot dock while a module that prevents docking is active.",
        });
      }
      if (result.errorMsg === "WEAPONS_TIMER_ACTIVE") {
        throwWrappedUserError("DockingRequestDenied", {
          reason: "You cannot dock until your weapons timer expires.",
        });
      }
      if (result.errorMsg === "CRIMINAL_TIMER_ACTIVE") {
        throwWrappedUserError("DockingRequestDenied", {
          reason: "You cannot dock while you are criminally flagged.",
        });
      }
      return null;
    }

    // None, as Tranquility answers every dock it takes (seventeen in seventeen recordings, among them
    // Missions/Done/Combat/Cargo Delivery.txt, GoneBerserkLevel1.txt and L1 For the Honor of Rouvenor.txt: the
    // CallRsp's stream is None; the nineteen others refused, DockingApproach among them). The
    // client takes no answer from it (movementFunctions.py RealDock, through sessionMgr.PerformSessionChange).
    return null;
  }

  Handle_CmdStargateJump(args, session) {
    const fromStargateID = normalizeNumber(args && args[0], 0);
    const toStargateID = normalizeNumber(args && args[1], 0);
    const requestedShipID =
      args && args.length > 2 ? normalizeNumber(args[2], 0) : 0;
    const activeShipID = normalizeNumber(
      session && (
        session.shipID ||
        session.shipid ||
        session.activeShipID ||
        (session._space && session._space.shipID)
      ),
      0,
    );
    log.info(
      `[Beyonce] CmdStargateJump char=${session && session.characterID} from=${fromStargateID} to=${toStargateID} ship=${requestedShipID || activeShipID || 0}`,
    );
    if (
      requestedShipID > 0 &&
      activeShipID > 0 &&
      requestedShipID !== activeShipID
    ) {
      log.warn(
        `[Beyonce] CmdStargateJump rejected ship mismatch char=${session && session.characterID} requested=${requestedShipID} active=${activeShipID}`,
      );
      this._throwStargateJumpUserError("SHIP_ID_MISMATCH");
    }

    const result = jumpSessionViaStargate(session, fromStargateID, toStargateID);
    if (!result.success) {
      log.warn(
        `[Beyonce] CmdStargateJump failed for char=${session && session.characterID}: ${result.errorMsg}`,
      );
      this._throwStargateJumpUserError(result.errorMsg);
    }

    // None, as Tranquility answers every jump it takes (sixteen in eight recordings, among them Archive/Autopilot thru
    // a few systems.txt and Missions/Done/Combat/AvengeAFallenComradeLevel1.txt: the CallRsp's stream is None). The
    // client takes no answer from it (autopilot.py 358, gateJumpSvc.py 124, through
    // sessionMgr.PerformSessionChange).
    return null;
  }

  Handle_BookmarkLocation(args, session, kwargs) {
    assertAbyssalBookmarkCreationAllowed(session);
    const charID = session && session.characterID;
    const itemID = normalizeNumber(args && args[0], 0);
    const folderID = normalizeNumber(args && args[1], 0);
    const name = normalizeText(args && args[2], "");
    const comment = normalizeText(args && args[3], "");
    const expiryMode = normalizeNumber(args && args[4], 0);
    const subfolderID = getBookmarkSubfolderID(kwargs);
    const scene = spaceRuntime.getSceneForSession(session);
    const target = resolveLocationBookmarkTarget(itemID, session, scene);

    if (!target) {
      throwWrappedUserError("BookmarkNotAvailable");
    }

    return addBookmarkToFolder(charID, folderID, {
      folderID,
      memo: name,
      note: comment,
      expiryMode,
      subfolderID,
      creatorID: charID,
      ...target,
    });
  }

  Handle_BookmarkScanResult(args, session, kwargs) {
    assertAbyssalBookmarkCreationAllowed(session);
    const charID = session && session.characterID;
    const locationID = normalizeNumber(args && args[0], 0);
    const name = normalizeText(args && args[1], "");
    const comment = normalizeText(args && args[2], "");
    // The client sends the scan result's own ID, its label ("ABC-123"): scanSvc.GetScannedDownMenu's bookmarkData.id,
    // bookmarkLocationWindow.py 226, bookmarkSvc.ACLBookmarkScanResult 629. A number is taken as a site's, as before.
    const rawResultID = args && args[3];
    const resultID = typeof rawResultID === "number" ? rawResultID : normalizeText(rawResultID, "").trim();
    const folderID = normalizeNumber(args && args[4], 0);
    const expiryMode = normalizeNumber(args && args[5], 0);
    const subfolderID = getBookmarkSubfolderID(kwargs);
    const target = bookmarkRuntime.resolveScanBookmarkTarget(locationID, resultID);
    if (!target) {
      throwWrappedUserError("BookmarkNotAvailable");
    }

    return addBookmarkToFolder(charID, folderID, {
      folderID,
      memo: name,
      note: comment,
      expiryMode,
      subfolderID,
      creatorID: charID,
      ...target,
    });
  }

  Handle_MachoResolveObject(args, session) {
    const bindParameter = args && args[0];
    void bindParameter;
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    const startedAtMs = Date.now();
    const response = buildBoundObjectResponse(this, args, session, kwargs);
    const responseBuiltMs = Date.now() - startedAtMs;
    const dockedStructureObserverSession = isDockedStructureObserverSession(session);
    // Space login is race-sensitive: if the bind reply reaches the client
    // before the first AddBalls2/SetState bootstrap, the inflight HUD can open
    // against an empty ego-ball state and only recover later via Michelle's
    // missing-module redraw path.
    const bootstrapStartedAtMs = Date.now();
    const bootstrapResult = bootstrapSessionBallpark(session, {
      force: dockedStructureObserverSession,
      reset: Boolean(
        dockedStructureObserverSession &&
          session &&
          session._structureViewSpace &&
          session._structureViewSpace.pendingBallparkBind === true
      ),
    });
    const bootstrapElapsedMs = Date.now() - bootstrapStartedAtMs;
    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(session, "beyonce-bind", {
        responseBuiltMs,
        bootstrapElapsedMs,
        dockedStructureObserver: dockedStructureObserverSession,
        bootstrapResult: bootstrapResult === true,
      });
    }
    if (responseBuiltMs >= 100 || bootstrapElapsedMs >= 100) {
      log.info(
        `[Beyonce] MachoBindObject responseBuiltMs=${responseBuiltMs} ` +
        `bootstrapMs=${bootstrapElapsedMs} dockedStructureObserver=${dockedStructureObserverSession ? 1 : 0}`,
      );
    }
    return response;
  }

  // Cmd* methods can only be invoked on an already-bound beyonce object, so an
  // inbound one is proof the client's binding is still live no matter what the
  // server's own beyonceBound flag says. The handshake methods (MachoResolveObject,
  // MachoBindObject, GetFormations, UpdateStateRequest) carry no such proof and
  // must not heal — MachoResolveObject in particular arrives before the bind.
  callMethod(method, args, session, kwargs, callContext = null) {
    const normalizedMethod = BaseService.normalizeMethodName(method);
    if (normalizedMethod.startsWith("Cmd")) {
      // The native cyno tunnel has no movement-cancel path after departure.
      // Keep new commands behind the handoff until its source scene retires.
      if (session && session._transitionState && session._transitionState.kind === "cynosural-jump") {
        throwCynoNotify("Your ship is already jumping.");
      }
      this._recoverStrandedBeyonceBinding(session, normalizedMethod);
    }
    return super.callMethod(method, args, session, kwargs, callContext);
  }

  _recoverStrandedBeyonceBinding(session, methodName) {
    if (!session || !session._space) {
      return;
    }
    // Healthy sessions already have the bootstrap, so this is a no-op for them.
    // Only a session still waiting on the initial ballpark can be stranded.
    if (session._space.initialStateSent === true) {
      return;
    }
    // A bootstrap already in flight will set initialStateSent on its own.
    if (session._space.initialBallparkBootstrapInProgress === true) {
      return;
    }

    // session._space is replaced wholesale on every attach, so this flag resets
    // per space generation and a burst of commands only logs once.
    if (session._space.strandedBindingRecoveryLogged !== true) {
      session._space.strandedBindingRecoveryLogged = true;
      log.warn(
        `[SpaceBootstrap] Beyonce ${methodName} arrived while the session could not ` +
          `receive destiny updates; recovering the beyonce binding ` +
          `client=${normalizeNumber(session.clientID, 0)} ` +
          `char=${normalizeNumber(session.characterID, 0)} ` +
          `ship=${normalizeNumber(session._space.shipID, 0)} ` +
          `system=${normalizeNumber(session._space.systemID, 0)}`,
      );
    }

    spaceRuntime.markBeyonceBound(session);
    // allowDeferredJumpBootstrapVisuals:false keeps this out of the deferred branch
    // that sends only the visual half and returns without setting initialStateSent;
    // force:true bypasses the already-bootstrapped early return. ensureInitialBallpark
    // validates the scene against the session's solar system itself.
    spaceRuntime.ensureInitialBallpark(session, {
      allowDeferredJumpBootstrapVisuals: false,
      force: true,
    });
  }

  afterCallResponse(methodName, session) {
    if (methodName === "MachoBindObject") {
      flushPendingCommandSessionEffects(session);
      return;
    }

    if (methodName === "CmdStargateJump") {
      flushPendingCommandSessionEffects(session);
    }
  }
}

BeyonceService._testing = {
  resolveAbyssalJumpBridgeRestriction,
  resolveAbyssalSessionActionAuthority,
};

module.exports = BeyonceService;
