"use strict";

// Mission and site access: the gameplay gates on private mission (dungeon)
// instances, and the dungeon room tracking of a pilot landing in one. With
// visibility as Grid bubble membership, none
// of this decides visibility any more: a mission pocket is separated by its
// place, and every Observer of its Grid bubble sees it. What stays are the
// gameplay gates that ask "may this pilot act on that instance": target lock,
// warp-to and loot, and the room tracking
// a warp landing commits.

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  entityIDsEqual,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  isAbyssalRoomEntityDeliveryHidden,
} = require("../abyssalRoomEntity");
const {
  persistShipEntity,
} = require("../entitySpacePersistence");
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  SCENE_KIND_ABYSSAL,
  getSceneKeyForSession,
} = require("../sceneIdentity");

// What canSessionSeeDungeonScope decides from: a Ball's scope, resolved
// without the session. The other shapes carry an ID: { kind: "instance",
// instanceID } and { kind: "abyssal", interactionScope }.
// The AIR Civilian Astero, a tutorial hull that is its owner's alone.
const AIR_CIVILIAN_ASTERO_TYPE_ID = 58745;

function isOwnerScopedAirTutorialShip(entity) {
  return Boolean(
    entity &&
    entity.kind === "ship" &&
    toInt(entity.typeID, 0) === AIR_CIVILIAN_ASTERO_TYPE_ID
  );
}

const DUNGEON_SCOPE_PUBLIC = Object.freeze({ kind: "public" });
const DUNGEON_SCOPE_REJECTED = Object.freeze({ kind: "rejected" });

// A raw identity field set to something that is no id.
function hasMalformedIdentity(entity, fieldName) {
  return Boolean(
    Object.hasOwn(entity, fieldName) &&
    entity[fieldName] !== null &&
    entity[fieldName] !== undefined &&
    normalizePersistentEntityID(entity[fieldName]) === null
  );
}

module.exports = {

// A Ball whose scope is malformed (conflicting or unreadable instance, site
// or abyssal identity) is refused when it is materialised (AddBall), where it
// used to be hidden from every Observer.
hasMalformedScope(entity) {
    if (!entity || typeof entity !== "object") {
      return false;
    }
    if (resolveEntityInteractionScope(entity).valid !== true) {
      return true;
    }
    return [
      "dungeonSiteID",
      "dungeonSiteInstanceID",
      "dungeonCurrentInstanceID",
    ].some((fieldName) => hasMalformedIdentity(entity, fieldName));
  },

persistAcceptedDungeonTrackingContext(entity) {
    return persistShipEntity(entity);
  },

commitAcceptedPilotWarpDungeonContext(entity, options = {}) {
    const session = entity && entity.session;
    if (!entity || !session || !session._space) {
      const error = new Error("PILOT_WARP_DUNGEON_CONTEXT_SESSION_INVALID");
      error.code = "PILOT_WARP_DUNGEON_CONTEXT_SESSION_INVALID";
      throw error;
    }
    const rawDestinationInstanceID = options.destinationStaticInstanceID;
    const hasDestinationInstanceID =
      rawDestinationInstanceID !== null &&
      rawDestinationInstanceID !== undefined;
    const destinationStaticInstanceID = normalizePersistentEntityID(
      rawDestinationInstanceID,
    );
    if (hasDestinationInstanceID && destinationStaticInstanceID === null) {
      const error = new Error("PILOT_WARP_DUNGEON_CONTEXT_ID_INVALID");
      error.code = "PILOT_WARP_DUNGEON_CONTEXT_ID_INVALID";
      throw error;
    }
    const requestedRoomKey = String(
      options.destinationDungeonRoomKey || "",
    ).trim();
    const rawDestinationSiteID = options.destinationDungeonSiteID;
    const hasDestinationSiteID =
      rawDestinationSiteID !== null && rawDestinationSiteID !== undefined;
    const destinationDungeonSiteID = normalizePersistentEntityID(
      rawDestinationSiteID,
    );
    if (hasDestinationSiteID && destinationDungeonSiteID === null) {
      const error = new Error("PILOT_WARP_DUNGEON_SITE_ID_INVALID");
      error.code = "PILOT_WARP_DUNGEON_SITE_ID_INVALID";
      throw error;
    }
    if (
      destinationStaticInstanceID === null &&
      (requestedRoomKey || destinationDungeonSiteID !== null)
    ) {
      const error = new Error("PILOT_WARP_DUNGEON_CONTEXT_IDENTITY_MIXED");
      error.code = "PILOT_WARP_DUNGEON_CONTEXT_IDENTITY_MIXED";
      throw error;
    }
    const destinationContextOptions = {
      ...(requestedRoomKey ? { roomKey: requestedRoomKey } : {}),
      ...(destinationDungeonSiteID !== null
        ? { siteID: destinationDungeonSiteID }
        : {}),
    };
    const destinationResolution = destinationStaticInstanceID === null
      ? null
      : this.resolveAuthorizedDestinationDungeonContext(
          session,
          destinationStaticInstanceID,
          destinationContextOptions,
        );
    if (
      destinationStaticInstanceID !== null &&
      (
        !destinationResolution ||
        !entityIDsEqual(
          destinationResolution.instanceID,
          destinationStaticInstanceID,
        )
      )
    ) {
      const error = new Error("PILOT_WARP_DUNGEON_CONTEXT_NOT_AUTHORIZED");
      error.code = "PILOT_WARP_DUNGEON_CONTEXT_NOT_AUTHORIZED";
      throw error;
    }

    const currentInstanceID = normalizePersistentEntityID(
      entity.dungeonCurrentInstanceID,
    );
    const currentRoomKey = String(entity.dungeonCurrentRoomKey || "").trim();
    const currentSiteID = normalizePersistentEntityID(
      entity.dungeonCurrentSiteID,
    );
    const roomKey = destinationResolution
      ? String(
          requestedRoomKey ||
          destinationResolution.roomKey ||
          (
            currentInstanceID !== null &&
            entityIDsEqual(currentInstanceID, destinationStaticInstanceID)
              ? currentRoomKey
              : ""
          ) ||
          "room:entry",
        ).trim() || "room:entry"
      : "";
    const resolvedSiteID = destinationResolution
      ? normalizePersistentEntityID(destinationResolution.siteID)
      : null;
    const alreadyCurrent = destinationStaticInstanceID === null
      ? (
          currentInstanceID === null &&
          normalizePersistentEntityID(entity.dungeonCurrentDungeonID) === null &&
          !currentRoomKey
        )
      : (
          currentInstanceID !== null &&
          entityIDsEqual(currentInstanceID, destinationStaticInstanceID) &&
          currentRoomKey === roomKey &&
          (
            resolvedSiteID === null
              ? currentSiteID === null
              : currentSiteID !== null &&
                entityIDsEqual(currentSiteID, resolvedSiteID)
          )
        );
    if (alreadyCurrent) {
      return {
        changed: false,
        destinationStaticInstanceID,
      };
    }

    const dungeonTrackingRuntime = lazyRequire(
      "../services/dungeon/dungeonTrackingRuntime",
    );
    const nowMs = toFiniteNumber(
      options.nowMs,
      this.getCurrentSimTimeMs(),
    );
    const roomPosition = options.roomPosition &&
      typeof options.roomPosition === "object"
      ? options.roomPosition
      : entity.position;
    const persistAcceptedContext = () => {
      let persistenceResult;
      try {
        persistenceResult = this.persistAcceptedDungeonTrackingContext(entity);
      } catch (error) {
        log.warn(
          `[SpaceRuntime] Accepted dungeon context persistence threw char=${toInt(session.characterID, 0)} instance=${String(destinationStaticInstanceID || 0)}: ${error.message}`,
        );
        return;
      }
      if (
        persistenceResult &&
        persistenceResult.success !== true &&
        persistenceResult.skipped !== true
      ) {
        log.warn(
          `[SpaceRuntime] Accepted dungeon context awaits persistence retry char=${toInt(session.characterID, 0)} instance=${String(destinationStaticInstanceID || 0)} error=${persistenceResult.errorMsg || "SHIP_PERSISTENCE_FAILED"}`,
        );
      }
    };

    if (destinationResolution) {
      dungeonTrackingRuntime.enterDungeonRoomForSession(
        this,
        session,
        destinationResolution.instance,
        roomKey,
        {
          nowMs,
          roomPosition,
          siteID: resolvedSiteID,
        },
      );
      persistAcceptedContext();
      dungeonTrackingRuntime.sendEnteringDungeonRoomNotification(
        session,
        destinationResolution.instance,
        roomKey,
        { roomPosition },
      );
    } else {
      const exitingDungeonID = normalizePersistentEntityID(
        entity.dungeonCurrentDungeonID,
      );
      dungeonTrackingRuntime.clearShipCurrentDungeonRoom(entity, { nowMs });
      persistAcceptedContext();
      if (exitingDungeonID !== null) {
        dungeonTrackingRuntime.sendExitingDungeonNotification(
          session,
          exitingDungeonID,
        );
      }
    }
    return {
      changed: true,
      destinationStaticInstanceID,
      roomKey: roomKey || null,
      siteID: resolvedSiteID,
    };
  },

// `verdictOnly` is for callers that only need the yes/no. It skips the deep
  // clone of the instance record and, in exchange, the resolution carries no
  // `instance`. Any caller that reads resolution.instance must leave it unset.
  resolveDungeonInstanceVisibilityForSession(session, instanceID, options = {}) {
    const policy = lazyRequire(
      "../services/dungeon/dungeonVisibilityPolicy.js",
    );
    if (
      !policy ||
      typeof policy.resolveDungeonInstanceVisibilityForSession !== "function"
    ) {
      return null;
    }
    const verdictOnly = Boolean(options && options.verdictOnly === true);
    const resolution = policy.resolveDungeonInstanceVisibilityForSession(
      session,
      instanceID,
      { systemID: this.systemID, verdictOnly },
    );
    if (resolution) {
      return resolution;
    }
    // Occupancy grace: a cleared site is terminal in the runtime the instant its last NPC pops, but it
    // stays on grid until the pilots in it leave. While its teardown is parked the pocket still has to
    // resolve, or the site, its props and its fresh wrecks go dark under the players still sitting in
    // them. The parked teardown is the only thing that opens this door, and only for that instance.
    if (!this.hasParkedDungeonSiteTeardownForInstance(instanceID)) {
      return null;
    }
    return policy.resolveDungeonInstanceVisibilityForSession(
      session,
      instanceID,
      {
        systemID: this.systemID,
        allowTeardownGraceLifecycle: true,
        verdictOnly,
      },
    );
  },

hasParkedDungeonSiteTeardownForInstance(instanceID) {
    const pending = this._dungeonUniversePendingSiteTeardowns;
    if (!(pending instanceof Map) || pending.size <= 0) {
      return false;
    }
    const siteService = lazyRequire(
      "../services/dungeon/dungeonUniverseSiteService.js",
    );
    return Boolean(
      siteService &&
      typeof siteService.hasPendingSiteTeardownForInstance === "function" &&
      siteService.hasPendingSiteTeardownForInstance(this, instanceID),
    );
  },

// "Purged" means the instance record is gone entirely, which is what a universe
  // reconcile does when it replaces a site: it deletes the row and mints a new
  // instanceID under the same siteKey. Deliberately not "terminal" -- a terminal
  // instance inside its occupancy grace still resolves for the pilot landing in it,
  // and must keep authorizing. This is the same test releaseSurvivorsStrandedByPurgedInstances
  // calls purged, so there is one definition of the word; getInstanceRef is the
  // read-only variant, because this runs per tick and the snapshot's deep clone
  // would be thrown away unread.
  isPurgedDungeonInstance(instanceID) {
    const numericInstanceID = Math.max(0, toInt(instanceID, 0));
    if (numericInstanceID <= 0) {
      return false;
    }
    const dungeonRuntime = lazyRequire("../services/dungeon/dungeonRuntime");
    if (!dungeonRuntime || typeof dungeonRuntime.getInstanceRef !== "function") {
      return false;
    }
    return !dungeonRuntime.getInstanceRef(numericInstanceID);
  },

resolveAuthorizedDestinationStaticInstanceID(session, instanceID) {
    const resolution = this.resolveDungeonInstanceVisibilityForSession(
      session,
      instanceID,
    );
    return resolution ? resolution.instanceID : null;
  },

resolveAuthorizedDestinationDungeonContext(
    session,
    instanceID,
    options = {},
  ) {
    const resolution = this.resolveDungeonInstanceVisibilityForSession(
      session,
      instanceID,
    );
    if (!resolution) {
      return null;
    }
    const instance = resolution.instance;
    const canonicalSiteID = normalizePersistentEntityID(
      instance && instance.metadata && instance.metadata.siteID,
    );
    const hasRequestedSiteID = Boolean(
      Object.hasOwn(options, "siteID") &&
      options.siteID !== null &&
      options.siteID !== undefined
    );
    const requestedSiteID = hasRequestedSiteID
      ? normalizePersistentEntityID(options.siteID)
      : null;
    if (
      hasRequestedSiteID &&
      (
        requestedSiteID === null ||
        canonicalSiteID === null ||
        !entityIDsEqual(requestedSiteID, canonicalSiteID)
      )
    ) {
      return null;
    }

    const requestedRoomKey = String(options.roomKey || "").trim();
    if (requestedRoomKey) {
      const roomStatesByKey = instance && instance.roomStatesByKey;
      if (
        !roomStatesByKey ||
        typeof roomStatesByKey !== "object" ||
        !Object.hasOwn(roomStatesByKey, requestedRoomKey)
      ) {
        return null;
      }
    }

    return {
      ...resolution,
      roomKey: requestedRoomKey || null,
      siteID: canonicalSiteID,
    };
  },

resolveDedicatedSiteStaticInstanceIDForSession(session, options = {}) {
    const hasExplicitOverride = Object.prototype.hasOwnProperty.call(
      options || {},
      "dedicatedSiteStaticInstanceIDOverride",
    );
    const overrideInstanceID = normalizePersistentEntityID(
      options.dedicatedSiteStaticInstanceIDOverride,
    );
    if (hasExplicitOverride) {
      if (overrideInstanceID === null) {
        return null;
      }
      return this.resolveAuthorizedDestinationStaticInstanceID(
        session,
        overrideInstanceID,
      );
    }

    const egoEntity = this.getShipEntityForSession(session);
    const currentInstanceID = normalizePersistentEntityID(
      egoEntity && egoEntity.dungeonCurrentInstanceID,
    );
    return currentInstanceID === null
      ? null
      : this.resolveAuthorizedDestinationStaticInstanceID(
          session,
          currentInstanceID,
        );
  },

// An AIR Civilian Astero is its owner's alone: only the character that owns
// it may lock, board or take it over (main hid it from everyone else too;
// with visibility as Grid bubble membership the gates are what remain). A
// hull whose owner, or AIR owner tag, is malformed or disagrees is nobody's.
isAirTutorialShipOwner(session, entity) {
    const shipOwnerCharacterID = normalizePersistentEntityID(entity && entity.ownerID);
    if (shipOwnerCharacterID === null) {
      return false;
    }
    if (
      Object.hasOwn(entity, "airNpeOwnerCharacterID") &&
      entity.airNpeOwnerCharacterID !== null &&
      entity.airNpeOwnerCharacterID !== undefined
    ) {
      const airOwnerCharacterID = normalizePersistentEntityID(entity.airNpeOwnerCharacterID);
      if (airOwnerCharacterID === null || !entityIDsEqual(airOwnerCharacterID, shipOwnerCharacterID)) {
        return false;
      }
    }
    const sessionCharacterID = this.resolveExactSessionCharacterID(session);
    return sessionCharacterID !== null && entityIDsEqual(shipOwnerCharacterID, sessionCharacterID);
  },

resolveExactSessionCharacterID(session) {
    if (!session || typeof session !== "object") {
      return null;
    }
    let resolvedCharacterID = null;
    for (const fieldName of ["characterID", "charID", "charid"]) {
      if (!Object.hasOwn(session, fieldName)) {
        continue;
      }
      const rawCandidate = session[fieldName];
      if (
        rawCandidate === null ||
        rawCandidate === undefined ||
        String(rawCandidate).trim() === ""
      ) {
        continue;
      }
      const candidate = normalizePersistentEntityID(rawCandidate);
      if (candidate === null) {
        return null;
      }
      if (
        resolvedCharacterID !== null &&
        !entityIDsEqual(resolvedCharacterID, candidate)
      ) {
        return null;
      }
      resolvedCharacterID = candidate;
    }
    return resolvedCharacterID;
  },

canSessionSeeDungeonScopedEntity(session, entity, options = {}) {
    if (!entity || isAbyssalRoomEntityDeliveryHidden(entity)) {
      return false;
    }
    if (isOwnerScopedAirTutorialShip(entity) && !this.isAirTutorialShipOwner(session, entity)) {
      return false;
    }
    const interactionScope = resolveEntityInteractionScope(entity);
    return this.canSessionSeeDungeonScope(
      session,
      this.resolveDungeonScopeForEntity(entity, interactionScope),
      options,
    );
  },

// The Ball's half of canSessionSeeDungeonScopedEntity, after its abyssal-room
  // check: everything that does not depend on the session, resolved to one of
  // the DUNGEON_SCOPE_* shapes.
  resolveDungeonScopeForEntity(entity, interactionScope) {
    if (!interactionScope.valid) {
      return DUNGEON_SCOPE_REJECTED;
    }
    // Rats and mineable rocks live in the shared world.  They can be spawned
    // by a mission/dungeon controller, but that controller's private access
    // list is not an ownership list for the NPCs or resources it materializes.
    // AIR and Abyssal retain their separate scene/owner boundaries; this only
    // removes the accidental character permission from ordinary site content.
    if (
      isSharedPveTarget(entity) &&
      !interactionScope.hasAirScope &&
      !interactionScope.hasAbyssalScope
    ) {
      return DUNGEON_SCOPE_PUBLIC;
    }
    const rawAbyssalInstanceID = interactionScope.abyssalInstanceID;
    if (this.sceneKind === SCENE_KIND_ABYSSAL) {
      return { kind: "abyssal", interactionScope };
    }
    const isAttachedPlayerShip = entity.kind === "ship" && Boolean(entity.session);
    const rawPlayerShipPresentationInstanceID =
      entity.kind === "ship"
        ? (
            entity.mode === "WARP"
              ? (
                  (entity.warpDestination &&
                    entity.warpDestination.destinationStaticInstanceID) ??
                  entity.dungeonCurrentInstanceID ??
                  rawAbyssalInstanceID
                )
              : entity.dungeonCurrentInstanceID ?? rawAbyssalInstanceID
          )
        : null;
    const rawGenericInstanceID =
      entity.dungeonSiteInstanceID ?? rawAbyssalInstanceID;
    const hasRawGenericInstanceID = rawGenericInstanceID !== null &&
      rawGenericInstanceID !== undefined;
    if (isAttachedPlayerShip && hasRawGenericInstanceID) {
      const genericInstanceID = normalizePersistentEntityID(
        rawGenericInstanceID,
      );
      const playerShipInstanceID = normalizePersistentEntityID(
        rawPlayerShipPresentationInstanceID,
      );
      if (
        genericInstanceID === null ||
        playerShipInstanceID === null ||
        !entityIDsEqual(genericInstanceID, playerShipInstanceID)
      ) {
        return DUNGEON_SCOPE_REJECTED;
      }
    }
    const rawInstanceID = isAttachedPlayerShip
      ? rawPlayerShipPresentationInstanceID
      : rawGenericInstanceID ?? rawPlayerShipPresentationInstanceID;
    const hasRawInstanceID = rawInstanceID !== null &&
      rawInstanceID !== undefined;
    const hasRawDungeonSiteID = Boolean(
      Object.hasOwn(entity, "dungeonSiteID") &&
      entity.dungeonSiteID !== null &&
      entity.dungeonSiteID !== undefined
    );
    if (
      hasRawDungeonSiteID &&
      normalizePersistentEntityID(entity.dungeonSiteID) === null
    ) {
      return DUNGEON_SCOPE_REJECTED;
    }
    let hasPlayerDungeonTrackingContext = false;
    if (entity.kind === "ship") {
      for (const [fieldName, normalizeIdentity] of [
        ["dungeonCurrentDungeonID", normalizePersistentEntityID],
        ["dungeonCurrentRoomID", normalizeNonNegativeInt64],
        ["dungeonCurrentSiteID", normalizePersistentEntityID],
      ]) {
        if (
          !Object.hasOwn(entity, fieldName) ||
          entity[fieldName] === null ||
          entity[fieldName] === undefined
        ) {
          continue;
        }
        hasPlayerDungeonTrackingContext = true;
        if (normalizeIdentity(entity[fieldName]) === null) {
          return DUNGEON_SCOPE_REJECTED;
        }
      }
      hasPlayerDungeonTrackingContext = Boolean(
        hasPlayerDungeonTrackingContext ||
        String(entity.dungeonCurrentRoomKey || "").trim() ||
        Array.isArray(entity.dungeonCurrentRoomPosition)
      );
    }
    const hasDungeonContentMarker = Boolean(
      entity.dungeonMaterializedSiteContent === true ||
      entity.dungeonMaterializedContainer === true ||
      entity.dungeonSiteContentBonus === true ||
      entity.dungeonSiteContentFailureExplodes === true ||
      entity.dungeonSiteContentPersistsAfterResponse === true ||
      [
        "dungeonEncounterKey",
        "dungeonSiteContentKey",
        "dungeonSiteContentRole",
        "dungeonSiteContentAnalyzer",
        "dungeonSiteContentTrigger",
        "dungeonSiteContentLootProfile",
        "dungeonSiteContentHackingDifficulty",
      ].some((fieldName) => String(entity[fieldName] || "").trim()) ||
      Array.isArray(entity.dungeonSiteContentExplicitLoot) ||
      Array.isArray(entity.dungeonSiteContentLootTags)
    );
    const instanceID = normalizePersistentEntityID(rawInstanceID);
    if (hasRawInstanceID && instanceID === null) {
      return DUNGEON_SCOPE_REJECTED;
    }
    if (instanceID === null) {
      return (
        hasDungeonContentMarker ||
        hasRawDungeonSiteID ||
        hasPlayerDungeonTrackingContext
      )
        ? DUNGEON_SCOPE_REJECTED
        : DUNGEON_SCOPE_PUBLIC;
    }
    return { kind: "instance", instanceID };
  },

// The session's half.
  canSessionSeeDungeonScope(session, dungeonScope, options = {}) {
    switch (dungeonScope.kind) {
      case "public":
        return true;
      case "abyssal": {
        const { interactionScope } = dungeonScope;
        const sessionInteractionScope = resolveEntityInteractionScope(session);
        const sceneInstanceID = normalizePersistentEntityID(
          this.instanceID ??
          (this.sceneDescriptor && this.sceneDescriptor.instanceID),
        );
        const entityInstanceID = interactionScope.abyssalInstanceID;
        const sessionSceneKey = getSceneKeyForSession(session);
        const sessionInstanceID = normalizePersistentEntityID(
          (session && session._space && session._space.instanceID) ??
          (session && session.spaceInstanceID),
        );
        return Boolean(
          sessionInteractionScope.valid === true &&
          sessionInteractionScope.hasAbyssalScope === true &&
          interactionScope.hasAbyssalScope === true &&
          sceneInstanceID !== null &&
          entityInstanceID !== null &&
          sessionInteractionScope.abyssalInstanceID !== null &&
          sessionInteractionScope.hasAbyssalRoomScope === true &&
          interactionScope.hasAbyssalRoomScope === true &&
          sessionInteractionScope.abyssalRoomIndex !== null &&
          interactionScope.abyssalRoomIndex !== null &&
          entityIDsEqual(sceneInstanceID, entityInstanceID) &&
          entityIDsEqual(
            sceneInstanceID,
            sessionInteractionScope.abyssalInstanceID,
          ) &&
          entityIDsEqual(
            sessionInteractionScope.abyssalRoomIndex,
            interactionScope.abyssalRoomIndex,
          ) &&
          (!sessionSceneKey || sessionSceneKey === this.sceneKey) &&
          (sessionInstanceID === null || entityIDsEqual(sceneInstanceID, sessionInstanceID))
        );
      }
      case "instance": {
        const { instanceID } = dungeonScope;
        // Reads the verdict and nothing else, so it takes the no-clone path.
        const resolution = this.resolveDungeonInstanceVisibilityForSession(
          session,
          instanceID,
          { verdictOnly: true },
        );
        if (!resolution) {
          return false;
        }
        if (!resolution.isPrivate) {
          return true;
        }

        const activeInstanceID = this.resolveDedicatedSiteStaticInstanceIDForSession(
          session,
          options,
        );
        return (
          activeInstanceID !== null &&
          entityIDsEqual(activeInstanceID, instanceID)
        );
      }
      default:
        return false;
    }
  },
};
