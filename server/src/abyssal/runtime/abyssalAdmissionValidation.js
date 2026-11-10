"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function evaluateAbyssalShipActivationState(ports, context, shipEntity, session, deps, options = {}) {
  const now = toInt(options.nowMs, toInt(deps && deps.now && deps.now(), Date.now()));

  const systemID = toInt(context && context.systemID, 0);

  const shipID = toInt(context && context.shipID, toInt(shipEntity && shipEntity.itemID, 0));

  const baseDetails = { shipID, solarSystemID: systemID };
  const work = { context, shipEntity, session, deps, options, now, systemID, shipID, baseDetails };
  for (const inspect of [inspectActivationLocation, inspectActivationDungeon, inspectActivationShipEffects]) {
    const blocked = inspect(ports, work);
    if (blocked) return blocked;
  }
  return inspectActivationCrimewatch(ports, work);
}

function inspectActivationLocation(ports, work) {
  const {
    isAbyssalHostLocationID,
    buildAbyssalShipStateBlock,
    VOID_SYSTEM_ID_MIN,
    VOID_SYSTEM_ID_MAX,
    SOLAR_SYSTEM_ZARZAKH,
  } = ports;
  const { systemID, baseDetails, session, now, deps, shipID } = work;
  if (isAbyssalHostLocationID(systemID)) {
    return buildAbyssalShipStateBlock("SHIP_IN_ABYSSAL_SYSTEM", baseDetails);
  }

  if (systemID >= VOID_SYSTEM_ID_MIN && systemID <= VOID_SYSTEM_ID_MAX) {
    return buildAbyssalShipStateBlock("VOID_SPACE_DISALLOWED", baseDetails);
  }

  if (systemID === SOLAR_SYSTEM_ZARZAKH) {
    return buildAbyssalShipStateBlock("BANNED_SOLAR_SYSTEM", baseDetails);
  }

  const sessionChangeDeadlineMs = Math.max(
    toInt(session && session.nextSessionChangeMs, 0),
    toInt(session && session.nextSessionChange, 0),
  );

  if ((session && session._transitionState) || sessionChangeDeadlineMs > now) {
    return buildAbyssalShipStateBlock("SESSION_CHANGE_IN_PROGRESS", {
      ...baseDetails,
      sessionChangeDeadlineMs,
    });
  }

  const selfDestructRuntime = deps && (
    deps.selfDestructRuntime ||
    (typeof deps.getSelfDestructRuntime === "function"
      ? deps.getSelfDestructRuntime()
      : null)
  );

  if (
    (typeof deps.isShipSelfDestructing === "function" && deps.isShipSelfDestructing(shipID)) ||
    (selfDestructRuntime &&
    typeof selfDestructRuntime.isShipSelfDestructing === "function" &&
    selfDestructRuntime.isShipSelfDestructing(shipID))
  ) {
    return buildAbyssalShipStateBlock("SHIP_SELF_DESTRUCTING", baseDetails);
  }
  Object.assign(work, {  });
  return null;
}

function inspectActivationDungeon(ports, work) {
  const {
    normalizeLowerText,
    buildAbyssalShipStateBlock,
  } = ports;
  const { deps, session, shipEntity, baseDetails } = work;
  const runtime = deps;

  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;

  const shipDungeonInstanceID = Math.max(
    0,
    toInt(shipEntity && shipEntity.dungeonCurrentInstanceID, 0),
    toInt(shipEntity && shipEntity.dungeonSiteInstanceID, 0),
    toInt(shipEntity && shipEntity.dungeonInstanceID, 0),
    toInt(shipEntity && shipEntity.siteInstanceID, 0),
  );

  const sessionDungeonInstanceID = Math.max(
    0,
    toInt(session && session.dungeonCurrentInstanceID, 0),
    toInt(session && session.dungeonSiteInstanceID, 0),
    toInt(session && session.dungeonInstanceID, 0),
    toInt(session && session._space && session._space.dungeonCurrentInstanceID, 0),
    toInt(session && session._space && session._space.dungeonSiteInstanceID, 0),
    toInt(session && session._space && session._space.dungeonInstanceID, 0),
  );

  const sceneKind = normalizeLowerText(
    scene && (scene.sceneKind || scene.kind || scene.locationKind),
    "",
  );

  const sceneDungeonInstanceID = Math.max(
    0,
    toInt(scene && scene.dungeonCurrentInstanceID, 0),
    toInt(scene && scene.dungeonSiteInstanceID, 0),
    toInt(scene && scene.dungeonInstanceID, 0),
  );

  if (shipDungeonInstanceID > 0 || sessionDungeonInstanceID > 0) {
    return buildAbyssalShipStateBlock("SHIP_IN_DUNGEON", {
      ...baseDetails,
      dungeonInstanceID: Math.max(shipDungeonInstanceID, sessionDungeonInstanceID),
      dungeonAuthority: shipDungeonInstanceID > 0 ? "SHIP_TRACKING" : "SESSION_TRACKING",
    });
  }

  if (
    sceneDungeonInstanceID > 0 ||
    ["dungeon", "deadspace", "mission", "mission-dungeon", "mission-deadspace"]
      .includes(sceneKind)
  ) {
    return buildAbyssalShipStateBlock("SHIP_IN_DUNGEON", {
      ...baseDetails,
      dungeonInstanceID: sceneDungeonInstanceID,
      dungeonAuthority: "SCENE_TRACKING",
      sceneKind,
    });
  }

  const tracking = deps && deps.dungeonTrackingRuntime;

  if (
    scene &&
    tracking &&
    typeof tracking.resolveCurrentDungeonForSession === "function"
  ) {
    let currentDungeon = null;
    try {
      currentDungeon = tracking.resolveCurrentDungeonForSession(scene, session) || null;
    } catch (error) {
      return buildAbyssalShipStateBlock("DUNGEON_AUTHORITY_UNAVAILABLE", {
        ...baseDetails,
        authorityError: normalizeText(error && error.message, "DUNGEON_AUTHORITY_FAILED"),
      });
    }
    if (currentDungeon) {
      return buildAbyssalShipStateBlock("SHIP_IN_DUNGEON", {
        ...baseDetails,
        dungeonInstanceID: toInt(
          currentDungeon.instance && currentDungeon.instance.instanceID,
          0,
        ),
        dungeonAuthority: "DUNGEON_TRACKING_RUNTIME",
      });
    }
  }
  Object.assign(work, { runtime, scene });
  return null;
}

function inspectActivationShipEffects(ports, work) {
  const {
    toReal,
    buildAbyssalShipStateBlock,
    isAbyssalShipInsideForceField,
    getAbyssalShipCloakMode,
    isEntityWarpScrambled,
    hasActiveAbyssalCynosuralGeneration,
  } = ports;
  const { scene, shipEntity, deps, baseDetails, runtime, now } = work;
  if (isAbyssalShipInsideForceField(scene, shipEntity, deps)) {
    return buildAbyssalShipStateBlock("SHIP_IN_FORCE_FIELD", baseDetails);
  }

  if (getAbyssalShipCloakMode(shipEntity) > 0) {
    return buildAbyssalShipStateBlock("SHIP_IS_CLOAKED", baseDetails);
  }

  const undockInvulnerable = runtime && typeof runtime.isEntityUndockInvulnerable === "function"
    ? runtime.isEntityUndockInvulnerable(shipEntity, now)
    : Boolean(
      shipEntity &&
      (
        shipEntity.undockInvulnerabilityActive === true ||
        toReal(shipEntity.undockInvulnerabilityUntilMs, 0) > now ||
        shipEntity.timedInvulnerabilityActive === true ||
        toReal(shipEntity.timedInvulnerabilityUntilMs, 0) > now
      )
    );

  if (
    undockInvulnerable ||
    shipEntity && (
      shipEntity.invulnerable === true ||
      shipEntity.isInvulnerable === true ||
      toReal(shipEntity.invulnerableUntilMs, 0) > now ||
      toReal(shipEntity.tacticalReclonerInvulnerableUntilMs, 0) > now
    )
  ) {
    return buildAbyssalShipStateBlock("SHIP_IS_INVULNERABLE", baseDetails);
  }

  if (
    typeof deps.isEntityStructureTethered === "function" &&
    deps.isEntityStructureTethered(shipEntity)
  ) {
    return buildAbyssalShipStateBlock("SHIP_IS_TETHERED", {
      ...baseDetails,
      structureID: toInt(shipEntity.structureTether.structureID, 0),
    });
  }

  if (
    shipEntity &&
    (
      normalizeText(shipEntity.mode, "").toUpperCase() === "WARP"
    )
  ) {
    return buildAbyssalShipStateBlock("SHIP_IN_WARP", baseDetails);
  }

  if (
    isEntityWarpScrambled(shipEntity) ||
    deps.isEntityFilamentBlocked?.(shipEntity) === true
  ) {
    return buildAbyssalShipStateBlock("SHIP_IS_WARP_SCRAMBLED", baseDetails);
  }

  if (hasActiveAbyssalCynosuralGeneration(shipEntity)) {
    return buildAbyssalShipStateBlock("SHIP_HAS_CYNO_ACTIVE", baseDetails);
  }
  Object.assign(work, {  });
  return null;
}

function inspectActivationCrimewatch(ports, work) {
  const {
    buildAbyssalShipStateBlock,
  } = ports;
  const { deps, context, now, options, baseDetails } = work;
  const crimewatch = deps && deps.crimewatchState &&
    typeof deps.crimewatchState.getCharacterCrimewatchState === "function"
      ? deps.crimewatchState.getCharacterCrimewatchState(
        toInt(context && context.characterID, 0),
        now,
      ) || null
      : null;

  if (crimewatch && toInt(crimewatch.pvpTimerExpiresAtMs, 0) > now) {
    return buildAbyssalShipStateBlock("PVP_TIMER_ACTIVE", {
      ...baseDetails,
      pvpTimerExpiresAtMs: toInt(crimewatch.pvpTimerExpiresAtMs, 0),
    });
  }

  const securityPolicy = options.securityPolicy && typeof options.securityPolicy === "object"
    ? options.securityPolicy
    : null;

  if (securityPolicy && securityPolicy.suspectRequired === true) {
    if (
      !deps.crimewatchState ||
      typeof deps.crimewatchState.getCharacterCrimewatchState !== "function" ||
      typeof deps.crimewatchState.setCharacterCrimewatchDebugState !== "function"
    ) {
      return buildAbyssalShipStateBlock("SUSPECT_TIMER_HOOK_UNAVAILABLE", baseDetails);
    }
    const safetyLevel = crimewatch && crimewatch.safetyLevel != null
      ? toInt(crimewatch.safetyLevel, 2)
      : deps && deps.crimewatchState &&
          typeof deps.crimewatchState.getSafetyLevel === "function"
        ? toInt(
          deps.crimewatchState.getSafetyLevel(toInt(context && context.characterID, 0)),
          2,
        )
        : 2;
    const safetyLevelFull = toInt(
      deps && deps.crimewatchState && deps.crimewatchState.SAFETY_LEVEL_FULL,
      2,
    );
    if (safetyLevel === safetyLevelFull) {
      return buildAbyssalShipStateBlock("SAFETY_ENGAGED", {
        ...baseDetails,
        safetyLevel,
      });
    }
  }

  return null;
}

function validateAbyssalEntranceDeployment(ports, args, session, deps = ports.getDependencies()) {
  const {
    getSessionContext,
    resolveActivateForFleet,
    resetPersistedAbyssalRunsAfterServerRestart,
    ensureSystemStalePlaceholderCleanup,
    ABYSS_ERROR,
    buildValidationError,
  } = ports;
  const context = {
    ...getSessionContext(session),
    activateForFleet: resolveActivateForFleet(args),
  };

  resetPersistedAbyssalRunsAfterServerRestart(context.systemID, deps, "server-restart-reset", session);

  ensureSystemStalePlaceholderCleanup(context.systemID, deps, "entrance-deployment");

  if (context.characterID <= 0 || context.systemID <= 0) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.SHIP_NOT_IN_SPACE, {
        reason: "CHARACTER_NOT_IN_SPACE",
      }),
    };
  }
  const work = { args, session, deps, context };
  for (const validate of [
    validateDeploymentShip,
    validateDeploymentFilamentIdentity,
    resolveDeploymentFilamentDefinition,
    validateDeploymentFleetAndSecurity,
  ]) {
    const rejected = validate(ports, work);
    if (rejected) return rejected;
  }
  return validateDeploymentPlacement(ports, work);
}

function validateDeploymentShip(ports, work) {
  const {
    ABYSS_ERROR,
    ABYSS_ERROR_KIND,
    buildValidationError,
    resolveExistingActiveRunConflict,
    resolveShipClassProfile,
    getGroupID,
    getGroupName,
  } = ports;
  const { context, deps, session } = work;
  const activeRunConflict = resolveExistingActiveRunConflict(context, deps);

  if (activeRunConflict) {
    return {
      success: false,
      error: buildValidationError(
        ABYSS_ERROR.UNKNOWN_ERROR,
        {
          reason: activeRunConflict.reason,
          traceItemID: toInt(
            activeRunConflict.traceState && activeRunConflict.traceState.traceItemID,
            0,
          ),
          instanceID: toInt(
            activeRunConflict.pocketState && activeRunConflict.pocketState.instanceID,
            0,
          ),
        },
        ABYSS_ERROR_KIND.ACTIVE_RUN_CONFLICT,
      ),
    };
  }

  const shipItem = deps.findItemById(context.shipID);

  const shipEntity = context.shipID > 0
    ? deps.getEntity(session, context.shipID)
    : null;

  if (!shipItem || !shipEntity) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.SHIP_NOT_IN_SPACE, {
        reason: "SHIP_NOT_IN_SPACE",
        shipID: context.shipID,
      }),
    };
  }

  const shipProfile = resolveShipClassProfile(shipItem, deps);

  if (!shipProfile) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.INVALID_SHIP_CLASS, {
        shipTypeID: toInt(shipItem.typeID, 0),
        shipGroupID: getGroupID(shipItem, deps),
        shipGroupName: getGroupName(shipItem, deps),
      }),
    };
  }
  Object.assign(work, { shipItem, shipEntity, shipProfile });
  return null;
}

function validateDeploymentFilamentIdentity(ports, work) {
  const {
    ABYSS_ERROR,
    buildValidationError,
    getGroupID,
    resolveFilamentItemID,
    isAbyssalFilamentItem,
  } = ports;
  const { args, deps, context } = work;
  const filamentItemID = resolveFilamentItemID(args, deps);

  const filamentItem = deps.findItemById(filamentItemID);

  if (!filamentItem) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.FILAMENT_NOT_FOUND, {
        filamentItemID,
      }),
    };
  }

  if (!isAbyssalFilamentItem(filamentItem, deps)) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.INVALID_FILAMENT_TYPE, {
        filamentItemID,
        filamentTypeID: toInt(filamentItem.typeID, 0),
        filamentGroupID: getGroupID(filamentItem, deps),
      }),
    };
  }

  const filamentOwnerMismatch = ![context.characterID, context.corporationID]
    .includes(toInt(filamentItem.ownerID, 0));

  const filamentUnreachable =
    toInt(filamentItem.locationID, 0) !== context.shipID ||
    toInt(filamentItem.flagID, 0) !== deps.ITEM_FLAGS.CARGO_HOLD;

  if (filamentOwnerMismatch || filamentUnreachable) {
    return {
      success: false,
      error: buildValidationError(
        filamentOwnerMismatch
          ? ABYSS_ERROR.INVALID_OWNER
          : ABYSS_ERROR.FILAMENT_NOT_REACHABLE,
        {
          reason: filamentOwnerMismatch
            ? "FILAMENT_OWNER_MISMATCH"
            : "FILAMENT_NOT_IN_SHIP_CARGO",
          filamentItemID,
          filamentTypeID: toInt(filamentItem.typeID, 0),
          ownerID: toInt(filamentItem.ownerID, 0),
          locationID: toInt(filamentItem.locationID, 0),
          flagID: toInt(filamentItem.flagID, 0),
        },
      ),
    };
  }
  Object.assign(work, { filamentItemID, filamentItem });
  return null;
}

function resolveDeploymentFilamentDefinition(ports, work) {
  const {
    ABYSS_ERROR,
    ABYSS_ERROR_KIND,
    buildValidationError,
    resolveTypeRecord,
    resolveFilamentContentDefinition,
    getItemQuantity,
  } = ports;
  const { filamentItem, deps, shipProfile, filamentItemID } = work;
  const filamentType = resolveTypeRecord(filamentItem, deps);

  const filamentDefinitionResolution = resolveFilamentContentDefinition(
    filamentType,
    shipProfile,
    deps,
    filamentItemID,
  );

  if (!filamentDefinitionResolution || !filamentDefinitionResolution.success) {
    return {
      success: false,
      error: buildValidationError(
        ABYSS_ERROR.UNSUPPORTED_FILAMENT_DEFINITION,
        {
          reason: normalizeText(
            filamentDefinitionResolution && filamentDefinitionResolution.errorMsg,
            "UNSUPPORTED_FILAMENT_DEFINITION",
          ),
          filamentItemID,
          filamentTypeID: toInt(filamentItem.typeID, 0),
          filamentName: normalizeText(filamentType && filamentType.name, ""),
          shipClass: normalizeText(shipProfile && shipProfile.key, ""),
        },
        ABYSS_ERROR_KIND.UNSUPPORTED_FILAMENT_DEFINITION,
      ),
    };
  }

  const filamentDefinition = filamentDefinitionResolution.definition;

  const resolvedShipProfile = {
    ...shipProfile,
    requiredFilaments: Math.max(
      1,
      toInt(
        filamentDefinition && filamentDefinition.requiredFilaments,
        toInt(shipProfile && shipProfile.fallbackRequiredFilaments, shipProfile.requiredFilaments),
      ),
    ),
  };

  if (getItemQuantity(filamentItem) < resolvedShipProfile.requiredFilaments) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.INVALID_FILAMENT_AMOUNT, {
        filamentItemID,
        availableQuantity: getItemQuantity(filamentItem),
        requiredQuantity: resolvedShipProfile.requiredFilaments,
      }),
    };
  }
  Object.assign(work, { filamentType, filamentDefinition, resolvedShipProfile });
  return null;
}

function validateDeploymentFleetAndSecurity(ports, work) {
  const {
    toReal,
    ABYSS_ERROR,
    buildValidationError,
    isFleetRequiredForAbyssalShipProfile,
    resolveAuthoritativeAbyssalFleetMembership,
    resolveAbyssalSecurityPolicy,
  } = ports;
  const { resolvedShipProfile, context, deps, filamentDefinition } = work;
  const fleetRequired = isFleetRequiredForAbyssalShipProfile(resolvedShipProfile);

  // The client flag is advisory and forgeable. Authoritative hull/filament rules
  // select the mode: small hulls require a fleet; cruiser mode remains solo.
  context.activateForFleet = fleetRequired;

  let fleetMembership = null;

  if (fleetRequired) {
    fleetMembership = resolveAuthoritativeAbyssalFleetMembership(context, deps);
    if (fleetMembership.success !== true) {
      return {
        success: false,
        error: buildValidationError(ABYSS_ERROR.FLEET_STATE_INVALID, {
          fleetID: context.fleetID,
          shipClass: resolvedShipProfile.key,
          requiredFilaments: resolvedShipProfile.requiredFilaments,
          reason: fleetMembership.reason,
          authorityError: normalizeText(fleetMembership.errorMsg, ""),
        }),
      };
    }
  }

  const solarSystem = deps.worldData.getSolarSystemByID(context.systemID);

  if (!solarSystem) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.UNKNOWN_ERROR, {
        reason: "SOLAR_SYSTEM_NOT_FOUND",
        systemID: context.systemID,
      }),
    };
  }

  const securityPolicy = resolveAbyssalSecurityPolicy(
    filamentDefinition && filamentDefinition.tier,
    solarSystem.security,
  );

  if (securityPolicy.allowed !== true) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.SECURITY_RESTRICTED_SYSTEM, {
        reason: securityPolicy.reason,
        solarSystemID: context.systemID,
        security: toReal(solarSystem.security, 0),
        tier: toInt(filamentDefinition && filamentDefinition.tier, 0),
      }),
    };
  }
  Object.assign(work, { fleetMembership, solarSystem, securityPolicy });
  return null;
}

function validateDeploymentPlacement(ports, work) {
  const {
    toReal,
    ABYSS_ERROR,
    buildValidationError,
    buildDeployStateFromShipEntity,
    findPlacementConflict,
    MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS,
  } = ports;
  const { context, shipEntity, session, deps, securityPolicy, filamentDefinition, shipItem, resolvedShipProfile, filamentItem, filamentType, solarSystem, fleetMembership } = work;
  const shipStateBlock = evaluateAbyssalShipActivationState(
    ports,     context,
    shipEntity,
    session,
    deps,
    { securityPolicy },
  );

  if (shipStateBlock) {
    return {
      success: false,
      error: buildValidationError(shipStateBlock.code, shipStateBlock.details),
    };
  }

  const spawnState = buildDeployStateFromShipEntity(context, shipEntity, filamentDefinition);

  if (!spawnState) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.UNKNOWN_ERROR, {
        reason: "DEPLOY_POSITION_UNAVAILABLE",
        shipID: context.shipID,
      }),
    };
  }

  const placementConflict = findPlacementConflict(
    session,
    context,
    shipEntity,
    deps,
  );

  if (placementConflict) {
    return {
      success: false,
      error: buildValidationError(ABYSS_ERROR.TOO_CLOSE_TO_OBJECT, {
        reason: placementConflict.errorMsg,
        blockerItemID: toInt(
          placementConflict.blocker && placementConflict.blocker.itemID,
          0,
        ),
        blockerTypeID: toInt(
          placementConflict.blocker && placementConflict.blocker.typeID,
          0,
        ),
        distanceMeters: Math.trunc(toReal(placementConflict.distance, 0)),
        surfaceDistanceMeters: Math.trunc(toReal(placementConflict.surfaceDistance, 0)),
        minimumDistanceMeters: MIN_DISTANCE_FROM_DISALLOWED_OBJECTS_METERS,
      }),
    };
  }

  return {
    success: true,
    data: {
      context,
      shipItem,
      shipEntity,
      shipProfile: resolvedShipProfile,
      filamentItem,
      filamentType,
      filamentDefinition,
      spawnState,
      solarSystem,
      securityPolicy,
      fleetMembership,
    },
  };
}

function createAbyssalAdmissionValidation(ports) {
  return {
    evaluateAbyssalShipActivationState: evaluateAbyssalShipActivationState.bind(null, ports),
    validateAbyssalEntranceDeployment: validateAbyssalEntranceDeployment.bind(null, ports),
  };
}

module.exports = { createAbyssalAdmissionValidation };
