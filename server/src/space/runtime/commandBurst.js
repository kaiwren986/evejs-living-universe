"use strict";

module.exports = {
  buildCommandBurstDbuffStateEntriesForSession,
  buildCommandBurstDbuffStateSignature,
  clearCommandBurstHudRefreshSignature,
  dispatchCommandBurstPulse,
  executeCommandBurstCycle,
  isCommandBurstClientSynchronizedModuleItem,
  isCommandBurstHighSecuritySystem,
  isCommandBurstRecipientEligible,
  isCommandBurstWeaponTimerExempt,
  isHighsecNeutralCommandBurstRecipientRestricted,
  notifyActiveCommandBurstHudStatesToSession,
  notifyCommandBurstDbuffStateToSession,
  notifyCommandBurstHudStateToSession,
  notifyFleetBoostedToSession,
  recordCommandBurstWeaponTimer,
  requestCommandBurstHudStateRefresh,
  resolveCommandBurstEntityIdentity,
  resolveCommandBurstFactionWarfareSide,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  buildDbuffPresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/specialFxPayloads.js",
));
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const hudIconRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hudIconRuntime",
));
const structureTethering = require(path.join(
  runtimeEntryDirname,
  "./structureTethering",
));
const {
  captureFittedGenericModuleAttributeSnapshots,
  notifyFittedGenericModuleAttributeDiffToSession,
} = require("./attributeChangeNotification");
const {
  isReadyForDestiny,
} = require("./destinyDeliveryEligibility");
const {
  getEntityRuntimeLoadedCharge,
} = require("./entityDogmaView");
const {
  persistDynamicEntity,
} = require("./entitySpacePersistence");
const {
  isShipInsideForceField,
} = require("./forceFieldContainment");
const {
  consumeTurretAmmoCharge,
} = require("./loadedChargeState");
const {
  queueCommandBurstReloadState,
} = require("./moduleChargeReload");
const {
  isMiningModuleItem,
} = require("./moduleHeat");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  normalizeTraceValue,
} = require("./runtimeDebugInstrumentation");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");
const {
  isEntityCloaked,
  isEntityStargateJumpCloaked,
} = require("./shipCloak");
const {
  breakEntityStructureTether,
} = require("./structureTether");

// Keep fitted-module Dogma notifications aligned with the authoritative
// command-burst consumers as each family is brought online. Mining modules and
// armor/hull repairers, shield boosters, propulsion/tackle, EWAR, and
// exploration modules currently have complete activation plus refresh paths.
const COMMAND_BURST_CLIENT_SYNC_REQUIRED_SKILL_IDS = Object.freeze(new Set([
  3386, // Mining
  16281, // Ice Harvesting
  25544, // Gas Cloud Harvesting
  3393, // Repair Systems (armor and hull repairers)
  16069, // Remote Armor Repair Systems
  24568, // Capital Remote Armor Repair Systems
  3416, // Shield Operation
  3422, // Shield Emission Systems
  24571, // Capital Shield Emission Systems
  3435, // Propulsion Jamming
  3450, // Afterburner
  3454, // High Speed Maneuvering
  3427, // Electronic Warfare
  3433, // Sensor Linking
  3434, // Weapon Disruption
  19921, // Target Painting
  21718, // Hacking
  13278, // Archaeology
  25863, // Salvaging
  3412, // Astrometrics
]));

function isCommandBurstClientSynchronizedModuleItem(moduleItem) {
  const typeID = toInt(moduleItem && moduleItem.typeID, 0);
  if (typeID <= 0) {
    return false;
  }
  if (isMiningModuleItem(moduleItem)) {
    return true;
  }
  return getRequiredSkillRequirements(typeID).some((requirement) => (
    COMMAND_BURST_CLIENT_SYNC_REQUIRED_SKILL_IDS.has(
      toInt(requirement && requirement.skillTypeID, 0),
    )
  ));
}

function buildCommandBurstDbuffStateSignature(entries = []) {
  return JSON.stringify(
    (Array.isArray(entries) ? entries : []).map((entry) => {
      const collectionID = toInt(Array.isArray(entry) ? entry[0] : 0, 0);
      const stateEntry = Array.isArray(entry) ? entry[1] : null;
      const value = Array.isArray(stateEntry)
        ? roundNumber(stateEntry[0], 6)
        : null;
      const expiry =
        Array.isArray(stateEntry) && stateEntry.length > 1
          ? normalizeTraceValue(stateEntry[1])
          : null;
      return [collectionID, value, expiry];
    }),
  );
}

function clearCommandBurstHudRefreshSignature(session) {
  if (!session || !session._space) {
    return false;
  }
  delete session._space.lastCommandBurstHudDbuffSignature;
  delete session._space.lastCommandBurstHudDbuffRawDispatchStamp;
  return true;
}

function requestCommandBurstHudStateRefresh(
  scene,
  session,
  entity,
  whenMs = null,
  options = {},
) {
  if (!scene || !session || !entity || !isReadyForDestiny(session)) {
    return false;
  }

  const rawNowMs =
    whenMs === undefined || whenMs === null
      ? scene.getCurrentSimTimeMs()
      : toFiniteNumber(whenMs, scene.getCurrentSimTimeMs());
  const entries = buildCommandBurstDbuffStateEntriesForSession(
    session,
    entity,
    rawNowMs,
  );
  const signature = buildCommandBurstDbuffStateSignature(entries);
  const rawDispatchStamp = scene.nextDestinyStamp;

  if (session._space && options.force !== true) {
    const previousSignature =
      typeof session._space.lastCommandBurstHudDbuffSignature === "string"
        ? session._space.lastCommandBurstHudDbuffSignature
        : null;
    const previousRawDispatchStamp =
      toInt(session._space.lastCommandBurstHudDbuffRawDispatchStamp, 0) >>> 0;
    if (
      previousSignature === signature &&
      previousRawDispatchStamp === (rawDispatchStamp >>> 0)
    ) {
      return false;
    }
  }

  // The ego's dbuff state is for this one Observer: its character history.
  scene.queueCharacterHistory(
    session,
    buildDbuffPresentationUpdates({
      stamp: rawDispatchStamp,
      entityID: entity.itemID,
      dbuffState: entries,
    }),
  );
  if (session._space) {
    session._space.lastCommandBurstHudDbuffSignature = signature;
    session._space.lastCommandBurstHudDbuffRawDispatchStamp = rawDispatchStamp >>> 0;
  }
  return true;
}

function notifyCommandBurstHudStateToSession(
  scene,
  session,
  hudState,
  active,
  options = {},
) {
  void hudState;
  void active;
  return requestCommandBurstHudStateRefresh(
    scene,
    session,
    options.egoEntity || null,
    options.whenMs,
    options,
  );
}

function notifyActiveCommandBurstHudStatesToSession(
  scene,
  session,
  egoEntity,
  nowMs = null,
) {
  if (!scene || !session || !egoEntity || !isReadyForDestiny(session)) {
    return 0;
  }

  const activeHudStates = hudIconRuntime.listActiveHudIconStates(
    egoEntity,
    nowMs === undefined || nowMs === null
      ? scene.getCurrentSimTimeMs()
      : toFiniteNumber(nowMs, scene.getCurrentSimTimeMs()),
    { kind: hudIconRuntime.HUD_ICON_KIND_COMMAND_BURST },
  );
  if (activeHudStates.length <= 0) {
    clearCommandBurstHudRefreshSignature(session);
    return 0;
  }

  requestCommandBurstHudStateRefresh(
    scene,
    session,
    egoEntity,
    nowMs,
    {
      force: true,
      reason: "command-burst-bootstrap",
    },
  );
  return activeHudStates.length;
}

function buildCommandBurstDbuffStateEntriesForSession(
  session,
  entity,
  whenMs = null,
) {
  if (!session || !entity) {
    return [];
  }

  const nowMs =
    whenMs === undefined || whenMs === null
      ? session && session._space && Number.isFinite(Number(session._space.simTimeMs))
        ? Number(session._space.simTimeMs)
        : Date.now()
      : toFiniteNumber(
        whenMs,
        session && session._space && Number.isFinite(Number(session._space.simTimeMs))
          ? Number(session._space.simTimeMs)
          : Date.now(),
      );

  const entries = commandBurstRuntime.buildClientDbuffStateEntries(entity, {
    nowMs,
    buildExpiry(expiryMs) {
      return buildFiletimeLong(resolveSessionNotificationFileTime(session, expiryMs));
    },
  });
  const withHomefrontWeather = require("../../services/homefront/homefrontHooks").weather.mergeClientDbuffState(
    entity,
    entries,
  );
  return entity.voidReplayElectrical
    ? require("../../services/activity/voidReplayWeather").mergeClientDbuffState(entity, withHomefrontWeather)
    : withHomefrontWeather;
}

function notifyCommandBurstDbuffStateToSession(
  scene,
  session,
  entity,
  whenMs = null,
  options = {},
) {
  return requestCommandBurstHudStateRefresh(
    scene,
    session,
    entity,
    whenMs,
    options,
  );
}

function notifyFleetBoostedToSession(session, moduleTypeID, numBoosted) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    (session.socket && session.socket.destroyed)
  ) {
    return false;
  }

  const normalizedModuleTypeID = toInt(moduleTypeID, 0);
  if (normalizedModuleTypeID <= 0) {
    return false;
  }

  session.sendNotification("OnFleetBoosted", "clientID", [
    normalizedModuleTypeID,
    Math.max(0, toInt(numBoosted, 0)),
  ]);
  return true;
}

const COMMAND_BURST_FW_ALLIED_SIDES = Object.freeze(new Map([
  [500001, "caldari-amarr"],
  [500003, "caldari-amarr"],
  [500002, "gallente-minmatar"],
  [500004, "gallente-minmatar"],
]));

function isCommandBurstHighSecuritySystem(system) {
  const security = Math.max(
    0,
    Math.min(1, toFiniteNumber(system && system.security, 0)),
  );
  return security >= 0.5;
}

function resolveCommandBurstEntityIdentity(entity) {
  return {
    characterID: toInt(
      entity && entity.session && (
        entity.session.characterID ||
        entity.session.charID ||
        entity.session.charid
      ),
      toInt(entity && (entity.characterID ?? entity.pilotCharacterID), 0),
    ),
    corporationID: toInt(
      entity && entity.session && (
        entity.session.corporationID ||
        entity.session.corpid
      ),
      toInt(entity && entity.corporationID, 0),
    ),
    allianceID: toInt(
      entity && entity.session && (
        entity.session.allianceID ||
        entity.session.allianceid
      ),
      toInt(entity && entity.allianceID, 0),
    ),
    warFactionID: toInt(
      entity && entity.session && (
        entity.session.warFactionID ||
        entity.session.warfactionid
      ),
      toInt(entity && entity.warFactionID, 0),
    ),
  };
}

function resolveCommandBurstFactionWarfareSide(warFactionID) {
  const normalizedFactionID = toInt(warFactionID, 0);
  if (normalizedFactionID <= 0) {
    return null;
  }
  return COMMAND_BURST_FW_ALLIED_SIDES.get(normalizedFactionID) ||
    `faction:${normalizedFactionID}`;
}

function isHighsecNeutralCommandBurstRecipientRestricted(context = {}) {
  const scene = context.scene || null;
  const sourceIdentity = resolveCommandBurstEntityIdentity(
    context.sourceEntity,
  );
  const targetIdentity = resolveCommandBurstEntityIdentity(
    context.targetEntity,
  );
  if (
    !scene ||
    sourceIdentity.characterID <= 0 ||
    targetIdentity.characterID <= 0 ||
    sourceIdentity.characterID === targetIdentity.characterID
  ) {
    return false;
  }

  const isHighSecuritySystem =
    typeof context.isHighSecuritySystem === "function"
      ? context.isHighSecuritySystem
      : isCommandBurstHighSecuritySystem;
  if (
    typeof isHighSecuritySystem !== "function" ||
    isHighSecuritySystem(scene.system) !== true
  ) {
    return false;
  }

  const nowMs = Math.max(
    0,
    toFiniteNumber(
      context.nowMs,
      typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    ),
  );
  const crimewatchState = lazyRequire("../services/security/crimewatchState");
  const getCharacterCrimewatchState =
    typeof context.getCharacterCrimewatchState === "function"
      ? context.getCharacterCrimewatchState
      : crimewatchState && crimewatchState.getCharacterCrimewatchState;
  const targetCrimewatchState =
    typeof getCharacterCrimewatchState === "function"
      ? getCharacterCrimewatchState(targetIdentity.characterID, nowMs)
      : null;
  if (
    toFiniteNumber(
      targetCrimewatchState && targetCrimewatchState.pvpTimerExpiresAtMs,
      0,
    ) <= nowMs
  ) {
    return false;
  }

  const warRuntimeState = lazyRequire("../services/corporation/warRuntimeState");
  const hasActiveWarForCharacter =
    typeof context.hasActiveWarForCharacter === "function"
      ? context.hasActiveWarForCharacter
      : warRuntimeState && warRuntimeState.hasActiveWarForCharacter;
  const targetHasNormalWar =
    typeof hasActiveWarForCharacter === "function" &&
    hasActiveWarForCharacter(targetIdentity.characterID, { nowMs }) === true;
  const sameCorporation =
    sourceIdentity.corporationID > 0 &&
    sourceIdentity.corporationID === targetIdentity.corporationID;
  const sameAlliance =
    sourceIdentity.allianceID > 0 &&
    sourceIdentity.allianceID === targetIdentity.allianceID;
  const neutralNormalWar =
    targetHasNormalWar &&
    !sameCorporation &&
    !sameAlliance;

  const targetFactionWarfareSide = resolveCommandBurstFactionWarfareSide(
    targetIdentity.warFactionID,
  );
  const sourceFactionWarfareSide = resolveCommandBurstFactionWarfareSide(
    sourceIdentity.warFactionID,
  );
  const neutralFactionWar =
    targetFactionWarfareSide !== null &&
    sourceFactionWarfareSide !== targetFactionWarfareSide;

  return neutralNormalWar || neutralFactionWar;
}

function isCommandBurstRecipientEligible(
  scene,
  sourceEntity,
  targetEntity,
  nowMs,
) {
  if (
    !targetEntity ||
    isEntityCloaked(targetEntity) ||
    structureTethering.isEntityStructureTethered(targetEntity) ||
    isShipInsideForceField(scene, targetEntity, nowMs)
  ) {
    return false;
  }
  return !isHighsecNeutralCommandBurstRecipientRestricted({
    scene,
    sourceEntity,
    targetEntity,
    nowMs,
  });
}

function isCommandBurstWeaponTimerExempt(sourceEntity) {
  return Boolean(
    sourceEntity &&
    sourceEntity.nativeNpc === true &&
    sourceEntity.remoteRepairShowTransient === true &&
    toInt(sourceEntity.remoteRepairBurstAffinityGroupID, 0) > 0
  );
}

function recordCommandBurstWeaponTimer(
  scene,
  sourceEntity,
  nowMs,
  options = {},
) {
  if (isCommandBurstWeaponTimerExempt(sourceEntity)) {
    return {
      success: true,
      data: {
        applied: false,
        dryRun: options.dryRun === true,
        exempt: true,
      },
    };
  }

  try {
    const crimewatchState = lazyRequire("../services/security/crimewatchState");
    if (
      crimewatchState &&
      typeof crimewatchState.recordWeaponTimer === "function"
    ) {
      const result = crimewatchState.recordWeaponTimer(
        scene,
        sourceEntity,
        nowMs,
        {
          dryRun: options.dryRun === true,
        },
      );
      if (
        result &&
        result.success === true &&
        result.data &&
        result.data.notificationError
      ) {
        log.warn(
          `[SpaceRuntime] Command burst weapon timer client sync failed ` +
          `for entity=${toInt(sourceEntity && sourceEntity.itemID, 0)}: ` +
          `${result.data.notificationError}`,
        );
      }
      return result;
    }
  } catch (error) {
    log.warn(
      `[SpaceRuntime] Command burst weapon timer failed for entity=${toInt(sourceEntity && sourceEntity.itemID, 0)}: ${error.message}`,
    );
    return {
      success: false,
      errorMsg: "COMMAND_BURST_WEAPON_TIMER_FAILED",
    };
  }
  return {
    success: false,
    errorMsg: "COMMAND_BURST_WEAPON_TIMER_UNAVAILABLE",
  };
}

function dispatchCommandBurstPulse(
  scene,
  sourceEntity,
  effectState,
  nowMs,
  sourceSession = null,
) {
  if (!scene || !sourceEntity || !effectState) {
    return {
      success: false,
      stopReason: "module",
      data: {
        recipients: [],
      },
    };
  }

  const weaponTimerResult = recordCommandBurstWeaponTimer(
    scene,
    sourceEntity,
    nowMs,
  );
  if (!weaponTimerResult || weaponTimerResult.success !== true) {
    return {
      success: false,
      stopReason: "crimewatch",
      errorMsg:
        weaponTimerResult && weaponTimerResult.errorMsg ||
        "COMMAND_BURST_WEAPON_TIMER_FAILED",
      data: {
        recipients: [],
      },
    };
  }
  if (
    sourceSession &&
    isEntityStargateJumpCloaked(sourceEntity) &&
    typeof scene.cancelStargateJumpCloak === "function"
  ) {
    scene.cancelStargateJumpCloak(sourceSession, "module", { nowMs });
  }
  if (breakEntityStructureTether(scene, sourceEntity, {
    nowMs,
    reason: "COMMAND_BURST_PULSE",
  })) {
    persistDynamicEntity(sourceEntity);
  }

  const recipients = commandBurstRuntime.resolveCommandBurstRecipients(
    scene,
    sourceEntity,
    effectState,
    nowMs,
    {
      isRecipientEligible: (source, target, commandNowMs) =>
        isCommandBurstRecipientEligible(
          scene,
          source,
          target,
          commandNowMs,
        ),
    },
  );
  const commandBurstGraphicInfo =
    Math.max(0, toFiniteNumber(effectState.commandBurstRangeMeters, 0)) > 0
      ? {
          // Retail command burst sphere FX are range-scaled; omitting this
          // falls back to ship-bounds sizing and produces the tiny center-glow
          // symptom instead of the large expanding sphere pulse.
          graphicRadius: Math.max(0, toFiniteNumber(effectState.commandBurstRangeMeters, 0)),
          radius: Math.max(0, toFiniteNumber(effectState.commandBurstRangeMeters, 0)),
        }
      : null;

  if (effectState.commandBurstSourceFxGuid) {
    scene.broadcastSpecialFx(
      sourceEntity.itemID,
      effectState.commandBurstSourceFxGuid,
      {
        moduleID: effectState.moduleID,
        moduleTypeID: effectState.typeID,
        chargeTypeID: effectState.chargeTypeID || null,
        start: true,
        active: false,
        // Let the client use the burst effect's authored duration. Forcing
        // `duration: 1` collapses the activation to ~1 ms and makes the pulse
        // effectively invisible even though the correct asset loads.
        graphicInfo: commandBurstGraphicInfo,
      },
      sourceEntity,
    );
  }

  for (const recipient of recipients) {
    const deliveryTimeMs = Math.max(
      toFiniteNumber(nowMs, 0),
      typeof scene.getCurrentSimTimeMs === "function"
        ? toFiniteNumber(scene.getCurrentSimTimeMs(), 0)
        : 0,
    );
    const recipientSession =
      recipient && recipient.session && isReadyForDestiny(recipient.session)
        ? recipient.session
        : null;
    const beforeModuleAttributes = recipientSession
      ? captureFittedGenericModuleAttributeSnapshots(recipient, {
          session: recipientSession,
          nowMs: deliveryTimeMs,
          moduleFilter: isCommandBurstClientSynchronizedModuleItem,
        })
      : new Map();
    const applyResult = commandBurstRuntime.applyTimedCommandBurstToEntity(
      recipient,
      effectState.commandBurstDbuffValues,
      effectState.commandBurstBuffDurationMs,
      nowMs,
    );
    if (typeof scene.indexCommandBurstExpiry === "function") {
      scene.indexCommandBurstExpiry(recipient);
    }
    if (effectState.commandBurstTargetFxGuid) {
      scene.broadcastSpecialFx(
        recipient.itemID,
        effectState.commandBurstTargetFxGuid,
        {
          moduleID: effectState.moduleID,
          moduleTypeID: effectState.typeID,
          targetID: sourceEntity.itemID,
          chargeTypeID: effectState.chargeTypeID || null,
          start: true,
          active: false,
          // Same client-side pulse timing rule as the source burst sphere.
        },
        recipient,
      );
    }

    if (applyResult.changed && recipient && recipient.kind === "ship") {
      scene.refreshShipEntityDerivedState(recipient, {
        session: recipient.session || null,
        broadcast: true,
        notifyTargeting: true,
        notifyGenericModuleAttributes: false,
      });
    }

    if (
      applyResult.changed &&
      recipient.session &&
      typeof recipient.session.sendNotification === "function"
    ) {
      notifyCommandBurstDbuffStateToSession(
        scene,
        recipient.session,
        recipient,
        nowMs,
        {
          reason: "command-burst-apply",
        },
      );
      if (recipientSession) {
        const afterModuleAttributes = captureFittedGenericModuleAttributeSnapshots(
          recipient,
          {
            session: recipientSession,
            nowMs: deliveryTimeMs,
            moduleFilter: isCommandBurstClientSynchronizedModuleItem,
          },
        );
        notifyFittedGenericModuleAttributeDiffToSession(
          recipientSession,
          beforeModuleAttributes,
          afterModuleAttributes,
          deliveryTimeMs,
        );
      }
    }
  }

  notifyFleetBoostedToSession(
    sourceSession || sourceEntity.session || null,
    effectState.typeID,
    recipients.length,
  );

  return {
    success: true,
    data: {
      recipients,
    },
  };
}

function executeCommandBurstCycle(
  scene,
  session,
  entity,
  moduleItem,
  effectState,
  nowMs,
  options = {},
) {
  if (!scene || !entity || !moduleItem || !effectState) {
    return { success: false, stopReason: "module" };
  }

  if (isShipInsideForceField(scene, entity, nowMs)) {
    return { success: false, stopReason: "forceField" };
  }

  // A Phenomena Generator carries its warfare buffs on the module and burns
  // isotopes rather than charges, so there is nothing to load or consume here.
  const carriesOwnBuffs = effectState.commandBurstCarriesOwnBuffs === true;
  const chargeItem = carriesOwnBuffs
    ? null
    : getEntityRuntimeLoadedCharge(entity, moduleItem);
  if (!carriesOwnBuffs && !chargeItem) {
    return { success: false, stopReason: "ammo" };
  }

  if (options.weaponTimerPreflightPassed !== true) {
    const weaponTimerPreflight = recordCommandBurstWeaponTimer(
      scene,
      entity,
      nowMs,
      { dryRun: true },
    );
    if (!weaponTimerPreflight || weaponTimerPreflight.success !== true) {
      return {
        success: false,
        stopReason: "crimewatch",
        errorMsg:
          weaponTimerPreflight && weaponTimerPreflight.errorMsg ||
          "COMMAND_BURST_WEAPON_TIMER_FAILED",
      };
    }
  }

  const consumeResult = carriesOwnBuffs
    ? { success: true }
    : consumeTurretAmmoCharge(
      entity,
      moduleItem,
      chargeItem,
      nowMs,
    );
  if (!consumeResult.success) {
    return {
      success: false,
      stopReason: consumeResult.stopReason || "ammo",
    };
  }

  const pulseResult = dispatchCommandBurstPulse(
    scene,
    entity,
    effectState,
    nowMs,
    session,
  );
  if (!pulseResult.success) {
    return pulseResult;
  }

  let reloadState = null;
  let stopReason = null;
  if (
    consumeResult.data &&
    consumeResult.data.depleted === true
  ) {
    reloadState = queueCommandBurstReloadState(
      scene,
      session,
      entity,
      moduleItem,
      effectState,
      nowMs,
    );
    if (!reloadState) {
      stopReason = "ammo";
    }
  }

  return {
    success: true,
    data: {
      recipients:
        pulseResult.data && Array.isArray(pulseResult.data.recipients)
          ? pulseResult.data.recipients
          : [],
      reloadState,
      stopReason,
    },
  };
}

Object.assign(module.exports, {
  COMMAND_BURST_CLIENT_SYNC_REQUIRED_SKILL_IDS,
  COMMAND_BURST_FW_ALLIED_SIDES,
});
