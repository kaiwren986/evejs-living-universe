"use strict";
const { getSessionCorporationRoleMask } = require("../../corporation/corporationRoleChecks");

// Module operation in the dogma service: what a pilot does with fitted modules. Activate and
// Deactivate start and stop a module's effect, including the kinds that launch something
// (survey and interdiction probes, warp disruption fields), analyzers hacking a site, anchoring
// cargo containers and control towers, starbase modules and structure services.
// SetModuleOnline and TakeModuleOffline put a module online or offline and ShipOnlineModules
// lists the online ones; LoadAmmo and UnloadAmmo load and unload charges, for one module or a
// weapon group; LaunchProbes launches scan probes. These are DogmaService methods, moved here as
// they were; dogmaService.js puts them back on the class prototype, so `this` is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));

/**
 * What NotEnoughCpu and NotEnoughPower are raised with (baseDogma.UserError, eve/common/script/dogma/baseDogma.py 28
 * to 49): the module's need, the ship's output less its load without the module, and the ship's whole output.
 */
function onlineShortfall(output, load, need) {
  const total = Number(output) || 0;
  return { require: Number(need) || 0, remaining: total - (Number(load) || 0), total };
}
const {
  throwWrappedUserError,
} = require(path.join(
  __dirname,
  "../../../common/machoErrors",
));
const {
  findCharacterShip,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  ITEM_FLAGS,
  findItemById,
  listContainerItems,
  moveItemToLocation,
  removeInventoryItem,
  updateInventoryItem,
  mergeItemStacks,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../inventory/itemTypeRegistry"));
const HackingMgrService = require(path.join(
  __dirname,
  "../../exploration/hackingMgrService",
));
const {
  getAttributeIDByNames,
  getFittedModuleItems,
  getLoadedChargeByFlag,
  getModuleChargeCapacity,
  isEffectivelyOnlineModule,
  isChargeCompatibleWithModule,
  isShipFittingFlag,
  buildEffectiveItemAttributeMap,
  getTypeDogmaAttributes,
  getTypeAttributeValue,
  listFittedItemsForLocation,
  typeHasEffectName,
  getMissingRequiredSkills,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  getShipFittingSnapshot,
  refreshShipFittingSnapshot,
  invalidateShipFittingSnapshot,
  listShipFittingAttributeChanges,
  getCargoOverflowWithoutItems,
} = require(path.join(
  __dirname,
  "../../../_secondary/fitting/fittingRuntime",
));
const {
  buildModuleAttributeChangeEvent,
  buildGodmaShipEffectEvent,
  sendOnMultiEvent,
} = require(path.join(__dirname, "../../_shared/godmaMultiEvent"));
const {
  applyActiveImplantLocationModifiersToAttributes,
} = require(path.join(__dirname, "../implants/activeImplantModifiers"));
const probeRuntimeState = require(path.join(
  __dirname,
  "../../exploration/probes/probeRuntimeState",
));
const probeScanRuntime = require(path.join(
  __dirname,
  "../../exploration/probes/probeScanRuntime",
));
const probeSceneRuntime = require(path.join(
  __dirname,
  "../../exploration/probes/probeSceneRuntime",
));
const surveyProbeRuntime = require(path.join(
  __dirname,
  "../../exploration/probes/surveyProbeRuntime",
));
const interdictionProbeRuntime = require(path.join(
  __dirname,
  "../../ship/interdictionProbeRuntime",
));
const warpDisruptFieldGeneratorRuntime = require(path.join(
  __dirname,
  "../../ship/warpDisruptFieldGeneratorRuntime",
));
const {
  getMasterModuleID: getWeaponBankMasterModuleID,
  getModulesInBank,
  destroyWeaponBankAndNotify,
} = require(path.join(__dirname, "../../moduleGrouping/moduleGroupingRuntime"));
const {
  extractDictEntries,
  extractList,
  normalizeNumber,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  consumeStructureServiceModuleOnlineFuel,
  isStructureDamagedForServiceOnline,
  isStructureServiceModuleItem,
  syncStructureServiceModuleState,
} = require(path.join(__dirname, "../../structure/structureServiceModules"));
const {
  buildCrpAccessDeniedInsufficientRolesValues,
  characterCanDisableStructureServiceModule,
} = require(path.join(__dirname, "../../structure/structureServiceAuthority"));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));
// inventorycommon/const.py flagCorpSAG1 (corpFlagByDivision[0]), the corporation hangar's first division; the
// divisions' query roles (corpHangarQueryRolesByFlag: corpRoleHangarCanQuery1 to 7) and corpRoleDirector.
const FIRST_CORP_HANGAR_DIVISION_FLAG = 115;
const CORP_HANGAR_DIVISION_QUERY_ROLE_BY_FLAG = new Map([
  [115, 1048576n],
  [116, 2097152n],
  [117, 4194304n],
  [118, 8388608n],
  [119, 16777216n],
  [120, 33554432n],
  [121, 67108864n],
]);
const CORP_ROLE_DIRECTOR = 1n;
const {
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../../space/destiny/identity/interactionScope.js",
));
const {
  resolveAbyssalPlayerLaunchScope,
} = require(path.join(__dirname, "../../_shared/abyssalPlayerLaunchScope"));
const {
  GROUP_SCAN_PROBE_LAUNCHER,
  ANALYZER_EFFECT_NAME,
  EFFECT_ONLINE,
  summarizeModuleItemForLog,
} = require(path.join(__dirname, "./shared"));

const ATTRIBUTE_MAX_GROUP_ONLINE =
  getAttributeIDByNames("maxGroupOnline") || 978;
const SCANNER_PROBE_CATEGORY_ID = 8;
const GROUP_SCANNER_PROBE = 479;
const GROUP_SURVEY_PROBE_LAUNCHER =
  surveyProbeRuntime.GROUP_SURVEY_PROBE_LAUNCHER;
const ATTRIBUTE_EXPLOSION_DELAY =
  getAttributeIDByNames("explosionDelay") || 281;
const GROUP_INTERDICTION_SPHERE_LAUNCHER =
  interdictionProbeRuntime.GROUP_INTERDICTION_SPHERE_LAUNCHER;
const GROUP_WARP_DISRUPT_FIELD_GENERATOR =
  warpDisruptFieldGeneratorRuntime.GROUP_WARP_DISRUPT_FIELD_GENERATOR;
const ANALYZER_HACKING_SKILL_TYPE_ID = 21718;
const ANALYZER_ARCHAEOLOGY_SKILL_TYPE_ID = 13278;
const ANALYZER_GAME_TYPE_HACKING = 0;
const ANALYZER_GAME_TYPE_ARCHEOLOGY = 1;
const ATTRIBUTE_VIRUS_COHERENCE =
  getAttributeIDByNames("virusCoherence") || 1909;
const ATTRIBUTE_VIRUS_STRENGTH =
  getAttributeIDByNames("virusStrength") || 1910;
const ATTRIBUTE_VIRUS_ELEMENT_SLOTS =
  getAttributeIDByNames("virusElementSlots", "virusUtilityElementSlots") || 1911;
const ATTRIBUTE_ACCESS_DIFFICULTY_BONUS =
  getAttributeIDByNames("accessDifficultyBonus") || 902;
const ATTRIBUTE_HACKING_TIER_DIFFICULTY =
  getAttributeIDByNames("tierDifficulty") || 1919;
const ANALYZER_ACCESS_BONUS_DIFFICULTY_DIVISOR = 5;
const HACKING_STATE_BEING_HACKED = 1;
const HACKING_STATE_HACKED = 2;
const ATTRIBUTE_MODULE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const ONLINE_CAPACITOR_CHARGE_RATIO = 95;
const ONLINE_CAPACITOR_REMAINDER_RATIO = 5;
const USER_ERROR_GROUP_ID = 7;

function summarizeRuntimeEffectForLog(effect) {
  if (!effect || typeof effect !== "object") {
    return null;
  }
  return {
    effectID: Number(effect.effectID) || 0,
    effectName: String(effect.effectName || ""),
    targetID: Number(effect.targetID) || 0,
    repeat: Number(effect.repeat) || 0,
    durationMs: Number(effect.durationMs) || 0,
    startedAtMs: Number(effect.startedAtMs) || 0,
    pendingDeactivation: effect.pendingDeactivation === true,
    isGeneric: effect.isGeneric === true,
  };
}

function extractKeyValEntries(value) {
  if (
    value &&
    typeof value === "object" &&
    value.name === "util.KeyVal" &&
    value.args &&
    value.args.type === "dict" &&
    Array.isArray(value.args.entries)
  ) {
    return value.args.entries;
  }
  return extractDictEntries(value);
}

function buildAmmoLoadRequest(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const itemID = Math.trunc(Number(value) || 0);
    return itemID > 0 ? { itemID, typeID: 0, quantity: null } : null;
  }
  if (typeof value === "string") {
    const itemID = Math.trunc(Number(value) || 0);
    return itemID > 0 ? { itemID, typeID: 0, quantity: null } : null;
  }
  if (Array.isArray(value)) {
    const numericValues = value.map((entry) => Math.trunc(normalizeNumber(entry, 0)));
    if (numericValues.length === 0) {
      return null;
    }
    if (numericValues.length === 1) {
      return numericValues[0] > 0
        ? { itemID: numericValues[0], typeID: 0, quantity: null }
        : null;
    }
    if (numericValues.length === 2) {
      return numericValues[0] > 0
        ? {
            itemID: 0,
            typeID: numericValues[0],
            quantity: numericValues[1] > 0 ? numericValues[1] : null,
          }
        : null;
    }
    // Charge sublocation tuples commonly end with the charge typeID.
    return numericValues[numericValues.length - 1] > 0
      ? {
          itemID: 0,
          typeID: numericValues[numericValues.length - 1],
          quantity: numericValues.length > 1 && numericValues[1] > 0
            ? numericValues[1]
            : null,
        }
      : null;
  }
  if (value && typeof value === "object" && value.type === "packedrow" && value.fields) {
    return buildAmmoLoadRequest(value.fields);
  }
  if (value && typeof value === "object" && value.type === "list") {
    return buildAmmoLoadRequest(extractList(value));
  }
  if (value && typeof value === "object") {
    const mapped = {};
    for (const [key, entryValue] of extractKeyValEntries(value)) {
      mapped[String(key)] = entryValue;
    }
    const source = Object.keys(mapped).length > 0 ? mapped : value;
    let itemID = 0;
    let typeID = 0;
    let quantity = null;
    if (Array.isArray(source.itemID)) {
      const tupleRequest = buildAmmoLoadRequest(source.itemID);
      itemID = tupleRequest ? tupleRequest.itemID || 0 : 0;
      typeID = tupleRequest ? tupleRequest.typeID || 0 : 0;
      quantity = tupleRequest ? tupleRequest.quantity : null;
    } else {
      itemID = Math.trunc(normalizeNumber(
        source.itemID ??
          source.chargeItemID ??
          source.chargeID,
        0,
      ));
      typeID = Math.trunc(normalizeNumber(
        source.typeID ??
          source.chargeTypeID ??
          source.ammoTypeID,
        0,
      ));
      quantity = Math.trunc(normalizeNumber(
        source.quantity ??
          source.qty ??
          source.chargeQty ??
          source.stacksize,
        0,
      )) || null;
    }
    if (itemID <= 0 && typeID <= 0) {
      return null;
    }
    return {
      itemID: itemID > 0 ? itemID : 0,
      typeID: typeID > 0 ? typeID : 0,
      quantity,
    };
  }
  return null;
}

function normalizeAmmoLoadRequests(rawValue) {
  const listValues = extractList(rawValue);
  const sourceValues = listValues.length > 0 ? listValues : [rawValue];
  const requests = [];
  const seen = new Set();
  for (const sourceValue of sourceValues) {
    const request = buildAmmoLoadRequest(sourceValue);
    if (!request) {
      continue;
    }
    const dedupeKey = `${request.itemID || 0}:${request.typeID || 0}:${request.quantity || 0}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    requests.push(request);
  }
  return requests;
}

function extractSequenceValues(value) {
  if (Array.isArray(value)) {
    return value;
  }
  const listValues = extractList(value);
  if (listValues.length > 0) {
    return listValues;
  }
  if (
    value &&
    typeof value === "object" &&
    value.type === "tuple" &&
    Array.isArray(value.items)
  ) {
    return value.items;
  }
  if (
    value &&
    typeof value === "object" &&
    value.type === "substream"
  ) {
    return extractSequenceValues(value.value);
  }
  return [];
}

function summarizeAmmoLoadRequests(requests = []) {
  return requests.map((request) => (
    request.itemID > 0
      ? `item:${request.itemID}`
      : `type:${request.typeID}${request.quantity ? `x${request.quantity}` : ""}`
  ));
}

function typeHasDogmaAttribute(typeID, attributeID) {
  const attributes = getTypeDogmaAttributes(typeID);
  return Object.prototype.hasOwnProperty.call(
    attributes || {},
    String(attributeID),
  );
}

function resolveMaxGroupOnlineLimit(moduleItem, fittedItems = []) {
  const groupID = Number(moduleItem && moduleItem.groupID) || 0;
  if (groupID <= 0) {
    return null;
  }
  let maxGroupOnline = null;
  let limitingTypeID = 0;
  for (const fittedItem of Array.isArray(fittedItems) ? fittedItems : []) {
    if (Number(fittedItem && fittedItem.groupID) !== groupID) {
      continue;
    }
    if (!typeHasDogmaAttribute(fittedItem && fittedItem.typeID, ATTRIBUTE_MAX_GROUP_ONLINE)) {
      continue;
    }
    const attributes = buildEffectiveItemAttributeMap(fittedItem);
    const value = Number(attributes[ATTRIBUTE_MAX_GROUP_ONLINE]);
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    const normalizedValue = Math.trunc(value);
    if (maxGroupOnline === null || normalizedValue < maxGroupOnline) {
      maxGroupOnline = normalizedValue;
      limitingTypeID = Number(fittedItem && fittedItem.typeID) || 0;
    }
  }
  if (maxGroupOnline === null) {
    return null;
  }
  const onlineGroupCount = (Array.isArray(fittedItems) ? fittedItems : [])
    .filter((fittedItem) =>
      Number(fittedItem && fittedItem.groupID) === groupID &&
      isEffectivelyOnlineModule(fittedItem)
    ).length;
  return {
    groupID,
    maxGroupOnline,
    onlineGroupCount,
    limitingTypeID,
  };
}

module.exports = {
  _resolveProbeLaunchPosition(session, shipID) {
    const numericShipID = Number(shipID) || this._getShipID(session);
    const scene = spaceRuntime.getSceneForSession(session);
    const shipEntity =
      (scene &&
        typeof scene.getShipEntityForSession === "function" &&
        scene.getShipEntityForSession(session)) ||
      (scene &&
        typeof scene.getEntityByID === "function" &&
        scene.getEntityByID(numericShipID)) ||
      null;
    const rawPosition =
      (shipEntity &&
        (shipEntity.position || shipEntity.destination || shipEntity.pos)) ||
      null;
    if (Array.isArray(rawPosition)) {
      return {
        x: Number(rawPosition[0]) || 0,
        y: Number(rawPosition[1]) || 0,
        z: Number(rawPosition[2]) || 0,
      };
    }
    return {
      x: Number(rawPosition && rawPosition.x) || 0,
      y: Number(rawPosition && rawPosition.y) || 0,
      z: Number(rawPosition && rawPosition.z) || 0,
    };
  },

  _resolveValidatedProbeLaunchContext(
    session,
    moduleID,
    requestedCount = 1,
    options = {},
  ) {
    const normalizedModuleID = Number(moduleID) || 0;
    const launchToCapacity = options && options.launchToCapacity === true;
    let normalizedRequestedCount = Math.max(1, Number(requestedCount) || 1);
    const shipID = this._getShipID(session);
    const charID = this._getCharID(session);
    const systemID = Number(
      (session && session.solarsystemid2) ||
      (session && session.solarsystemid) ||
      (session && session._space && session._space.systemID) ||
      0,
    ) || 0;
    const moduleItem = findItemById(normalizedModuleID);
    if (
      !session ||
      !session._space ||
      charID <= 0 ||
      shipID <= 0 ||
      systemID <= 0
    ) {
      this._throwProbeLaunchUserError("NOT_IN_SPACE", moduleItem);
    }
    if (
      !moduleItem ||
      Number(moduleItem.ownerID) !== charID ||
      Number(moduleItem.locationID) !== shipID
    ) {
      this._throwProbeLaunchUserError("MODULE_NOT_FOUND", moduleItem);
    }
    if (Number(moduleItem.groupID) !== GROUP_SCAN_PROBE_LAUNCHER) {
      this._throwProbeLaunchUserError("INVALID_LAUNCHER", moduleItem);
    }
    if (!isEffectivelyOnlineModule(moduleItem)) {
      this._throwProbeLaunchUserError("MODULE_NOT_ONLINE", moduleItem);
    }

    const launchShipEntity = spaceRuntime.getEntity(session, shipID);
    const launchScene = typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
    const launchScope = resolveAbyssalPlayerLaunchScope(
      session,
      launchShipEntity,
      launchScene,
    );
    if (launchScope.valid !== true) {
      this._throwProbeLaunchUserError(
        "ABYSSAL_LAUNCH_SCOPE_INVALID",
        moduleItem,
      );
    }

    const removedGhostProbes = probeRuntimeState.removeInvalidCharacterProbes(charID, {
      systemID,
      nowMs: Date.now(),
    });
    if (removedGhostProbes.length > 0) {
      log.debug(
        `[DogmaIM] Purged ${removedGhostProbes.length} invalid persisted probe record(s) ` +
        `before launch for charID=${charID} systemID=${systemID}`,
      );
    }
    const removedExpiredProbes = probeRuntimeState.removeExpiredCharacterProbes(charID, {
      systemID,
      nowMs: Date.now(),
    });
    if (removedExpiredProbes.length > 0) {
      log.debug(
        `[DogmaIM] Purged ${removedExpiredProbes.length} expired persisted probe record(s) ` +
        `before launch for charID=${charID} systemID=${systemID}`,
      );
    }

    const loadedCharge = getLoadedChargeByFlag(charID, shipID, moduleItem.flagID);
    if (!loadedCharge) {
      this._throwProbeLaunchUserError("NO_CHARGES", moduleItem);
    }
    if (
      Number(loadedCharge.categoryID) !== SCANNER_PROBE_CATEGORY_ID ||
      Number(loadedCharge.groupID) !== GROUP_SCANNER_PROBE
    ) {
      this._throwProbeLaunchUserError("INVALID_CHARGE", moduleItem);
    }
    if (!isChargeCompatibleWithModule(moduleItem.typeID, loadedCharge.typeID)) {
      this._throwProbeLaunchUserError("INCOMPATIBLE_CHARGE", moduleItem);
    }

    // NOTE: the community patch also gated launch on the probe type's required
    // skills here. Fitting/loading already enforces the same requirements via
    // validateFitForShip (liveFittingState), so this launch-time repeat only
    // rejected flows that inject charges directly. Left out pending a decision.

    const loadedChargeQuantity = Math.max(
      0,
      Number(loadedCharge.stacksize ?? loadedCharge.quantity ?? 0) || 0,
    );
    if (!launchToCapacity && loadedChargeQuantity < normalizedRequestedCount) {
      this._throwProbeLaunchUserError("NOT_ENOUGH_CHARGES", moduleItem);
    }

    const probeLaunchCapState = probeRuntimeState.getCharacterProbeLaunchCapState(
      charID,
      systemID,
      {
        launchScope,
        scopeMetadata: launchScope.metadata,
      },
    );
    if (probeLaunchCapState.valid !== true) {
      this._throwProbeLaunchUserError(
        probeLaunchCapState.errorMsg || "ABYSSAL_LAUNCH_SCOPE_INVALID",
        moduleItem,
      );
    }
    const activeProbeCount = probeLaunchCapState.activeProbeCount;
    if (launchToCapacity) {
      normalizedRequestedCount = Math.min(
        loadedChargeQuantity,
        Math.max(0, probeRuntimeState.MAX_ACTIVE_PROBES - activeProbeCount),
      );
      if (normalizedRequestedCount <= 0) {
        this._throwProbeLaunchUserError("TOO_MANY_ACTIVE_PROBES", moduleItem);
      }
    }
    if ((activeProbeCount + normalizedRequestedCount) > probeRuntimeState.MAX_ACTIVE_PROBES) {
      this._throwProbeLaunchUserError("TOO_MANY_ACTIVE_PROBES", moduleItem);
    }

    return {
      moduleItem,
      loadedCharge,
      requestedCount: normalizedRequestedCount,
      shipID,
      charID,
      systemID,
      launchScope,
    };
  },

  _throwProbeLaunchUserError(errorMsg = "", moduleItem = null) {
    switch (String(errorMsg || "").trim()) {
      case "NO_CHARGES":
        throwWrappedUserError("NoCharges", {
          launcher: this._buildUserErrorTypeValue(moduleItem && moduleItem.typeID),
        });
        break;
      case "TOO_MANY_ACTIVE_PROBES":
        this._throwCustomNotifyUserError("You cannot control more than eight active probes.");
        break;
      case "NOT_ENOUGH_CHARGES":
        this._throwCustomNotifyUserError("You do not have enough loaded scanner probes.");
        break;
      case "NOT_IN_SPACE":
      case "MODULE_NOT_FOUND":
      case "SHIP_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "MODULE_NOT_ONLINE":
        this._throwCustomNotifyUserError(`${this._resolveModuleDisplayName(moduleItem)} is offline.`);
        break;
      case "INVALID_LAUNCHER":
        this._throwCustomNotifyUserError("That module cannot launch scanner probes.");
        break;
      case "INVALID_CHARGE":
        this._throwCustomNotifyUserError("The loaded charge is not a valid scanner probe.");
        break;
      case "INCOMPATIBLE_CHARGE":
        this._throwCustomNotifyUserError("That scanner probe does not fit in this probe launcher.");
        break;
      case "ABYSSAL_LAUNCH_SCOPE_INVALID":
        this._throwCustomNotifyUserError(
          "Unable to launch scanner probes while the Abyssal room scope is unresolved.",
        );
        break;
      case "MISSING_REQUIRED_SKILL":
        this._throwCustomNotifyUserError("You do not meet the skill requirements for that scanner probe.");
        break;
      default:
        this._throwCustomNotifyUserError("Unable to launch probes.");
        break;
    }
  },

  _resolveValidatedSurveyProbeLaunchContext(session, moduleID) {
    const normalizedModuleID = Number(moduleID) || 0;
    const shipID = this._getShipID(session);
    const charID = this._getCharID(session);
    const moduleItem = findItemById(normalizedModuleID);
    if (
      !moduleItem ||
      Number(moduleItem.ownerID) !== charID ||
      Number(moduleItem.locationID) !== shipID
    ) {
      this._throwSurveyProbeLaunchUserError("MODULE_NOT_FOUND", moduleItem);
    }
    if (Number(moduleItem.groupID) !== GROUP_SURVEY_PROBE_LAUNCHER) {
      this._throwSurveyProbeLaunchUserError("INVALID_LAUNCHER", moduleItem);
    }
    if (!isEffectivelyOnlineModule(moduleItem)) {
      this._throwSurveyProbeLaunchUserError("MODULE_NOT_ONLINE", moduleItem);
    }
    const loadedCharge = getLoadedChargeByFlag(
      charID,
      shipID,
      Number(moduleItem.flagID) || 0,
    );
    const validation = surveyProbeRuntime.validateSurveyProbeLaunchContext(
      session,
      moduleItem,
      loadedCharge,
    );
    if (!validation || validation.success !== true) {
      this._throwSurveyProbeLaunchUserError(
        validation && validation.errorMsg,
        moduleItem,
      );
    }
    return {
      moduleItem,
      loadedCharge,
      shipID,
      charID,
      systemID: Number(
        validation &&
        validation.data &&
        validation.data.context &&
        validation.data.context.systemID,
      ) || 0,
    };
  },

  _throwSurveyProbeLaunchUserError(errorMsg = "", moduleItem = null) {
    switch (String(errorMsg || "").trim()) {
      case "NO_CHARGES":
        throwWrappedUserError("NoCharges", {
          launcher: this._buildUserErrorTypeValue(moduleItem && moduleItem.typeID),
        });
        break;
      case "NOT_IN_SPACE":
      case "MODULE_NOT_FOUND":
      case "SHIP_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "MODULE_NOT_ONLINE":
        this._throwCustomNotifyUserError(`${this._resolveModuleDisplayName(moduleItem)} is offline.`);
        break;
      case "INVALID_LAUNCHER":
        this._throwCustomNotifyUserError("That module cannot launch survey probes.");
        break;
      case "INVALID_CHARGE":
        this._throwCustomNotifyUserError("The loaded charge is not a valid survey probe.");
        break;
      case "INCOMPATIBLE_CHARGE":
        this._throwCustomNotifyUserError("That survey probe does not fit in this launcher.");
        break;
      case "SURVEY_DURATION_UNAVAILABLE":
      case "SURVEY_RANGE_UNAVAILABLE":
      case "SURVEY_VELOCITY_UNAVAILABLE":
        this._throwCustomNotifyUserError("The survey probe's scan profile is unavailable.");
        break;
      case "SURVEY_PROBE_POSITION_UNAVAILABLE":
        this._throwCustomNotifyUserError("Unable to resolve a launch direction for the survey probe.");
        break;
      case "SURVEY_PROBE_NOTIFY_FAILED":
        this._throwCustomNotifyUserError("Unable to initialize the survey probe tracker.");
        break;
      case "ABYSSAL_LAUNCH_SCOPE_INVALID":
        this._throwCustomNotifyUserError("Survey probes cannot be launched in this space.");
        break;
      default:
        this._throwCustomNotifyUserError("Unable to launch survey probe.");
        break;
    }
  },

  _launchSurveyProbeFromContext(session, probeContext = null) {
    const moduleItem = probeContext && probeContext.moduleItem;
    const loadedCharge = probeContext && probeContext.loadedCharge;
    const charID = Number(probeContext && probeContext.charID) || this._getCharID(session);
    const shipID = Number(probeContext && probeContext.shipID) || this._getShipID(session);
    const systemID = Number(probeContext && probeContext.systemID) || Number(
      session && (session.solarsystemid2 || session.solarsystemid),
    ) || 0;

    const launchResult = surveyProbeRuntime.launchSurveyProbeFromModule(
      session,
      moduleItem,
      loadedCharge,
    );
    if (!launchResult || launchResult.success !== true) {
      this._throwSurveyProbeLaunchUserError(
        launchResult && launchResult.errorMsg,
        moduleItem,
      );
    }

    const launchedProbeID = Number(launchResult.data && launchResult.data.itemID) || 0;
    const consumeResult = this._consumeLoadedProbeCharge(
      session,
      charID,
      shipID,
      moduleItem,
      1,
    );
    if (!consumeResult.success) {
      surveyProbeRuntime.removeSurveyProbe(
        launchedProbeID,
        systemID,
        "charge-consume-failed",
        {
          session,
          notifySession: session,
        },
      );
      this._throwSurveyProbeLaunchUserError(consumeResult.errorMsg, moduleItem);
    }

    const commitResult = surveyProbeRuntime.markSurveyProbeChargeConsumed(
      launchedProbeID,
      { session },
    );
    if (!commitResult || commitResult.success !== true) {
      surveyProbeRuntime.removeSurveyProbe(
        launchedProbeID,
        systemID,
        "charge-consume-commit-failed",
        {
          session,
          notifySession: session,
        },
      );
      this._throwSurveyProbeLaunchUserError(
        commitResult && commitResult.errorMsg,
        moduleItem,
      );
    }

    const remainingQuantity = Math.max(
      0,
      Number(consumeResult.data && consumeResult.data.remainingQuantity) || 0,
    );
    return {
      launchedProbeID,
      chargeTypeID: Number(loadedCharge && loadedCharge.typeID) || 0,
      remainingQuantity,
    };
  },

  _resolveValidatedInterdictionProbeLaunchContext(session, moduleID) {
    const normalizedModuleID = Number(moduleID) || 0;
    const shipID = this._getShipID(session);
    const charID = this._getCharID(session);
    const moduleItem = findItemById(normalizedModuleID);
    const loadedCharge = moduleItem
      ? getLoadedChargeByFlag(charID, shipID, moduleItem.flagID)
      : null;
    if (!moduleItem) {
      this._throwInterdictionProbeLaunchUserError("MODULE_NOT_FOUND", moduleItem);
    }
    if (Number(moduleItem.groupID) !== GROUP_INTERDICTION_SPHERE_LAUNCHER) {
      this._throwInterdictionProbeLaunchUserError("INVALID_LAUNCHER", moduleItem);
    }
    if (!isEffectivelyOnlineModule(moduleItem)) {
      this._throwInterdictionProbeLaunchUserError("MODULE_NOT_ONLINE", moduleItem);
    }

    const validation = interdictionProbeRuntime.validateInterdictionProbeLaunchContext(
      session,
      moduleItem,
      loadedCharge,
    );
    if (!validation || validation.success !== true) {
      this._throwInterdictionProbeLaunchUserError(
        validation && validation.errorMsg,
        moduleItem,
      );
    }
    const contextData = validation.data || {};
    return {
      moduleItem,
      loadedCharge,
      shipID,
      charID,
      systemID:
        contextData.context && Number(contextData.context.systemID) > 0
          ? Number(contextData.context.systemID)
          : Number(
            (session && session.solarsystemid2) ||
            (session && session.solarsystemid) ||
            (session && session._space && session._space.systemID) ||
            0,
          ) || 0,
    };
  },

  _throwInterdictionProbeLaunchUserError(errorMsg = "", moduleItem = null) {
    const normalizedError = String(errorMsg || "").trim();
    switch (normalizedError) {
      case "NO_CHARGES":
        throwWrappedUserError("NoCharges", {
          launcher: this._buildUserErrorTypeValue(moduleItem && moduleItem.typeID),
        });
        break;
      case "NOT_IN_SPACE":
      case "MODULE_NOT_FOUND":
      case "SHIP_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "MODULE_NOT_ONLINE":
        this._throwCustomNotifyUserError(`${this._resolveModuleDisplayName(moduleItem)} is offline.`);
        break;
      case "INVALID_LAUNCHER":
        this._throwCustomNotifyUserError("That module cannot launch warp disrupt probes.");
        break;
      case "INVALID_CHARGE":
        this._throwCustomNotifyUserError("The loaded charge is not a valid warp disrupt probe.");
        break;
      case "INTERDICTION_PROBE_POSITION_UNAVAILABLE":
        this._throwCustomNotifyUserError("Unable to resolve a launch position for the warp disrupt probe.");
        break;
      case "ABYSSAL_LAUNCH_SCOPE_INVALID":
        this._throwCustomNotifyUserError(
          "Unable to launch warp disrupt probes while the Abyssal room scope is unresolved.",
        );
        break;
      default:
        if (normalizedError) {
          this._throwCustomNotifyUserError(normalizedError);
        }
        this._throwCustomNotifyUserError("Unable to launch warp disrupt probe.");
        break;
    }
  },

  _launchInterdictionProbeFromContext(session, probeContext = null) {
    const moduleItem = probeContext && probeContext.moduleItem
      ? probeContext.moduleItem
      : null;
    const loadedCharge = probeContext && probeContext.loadedCharge
      ? probeContext.loadedCharge
      : null;
    const charID = Number(probeContext && probeContext.charID) || this._getCharID(session);
    const shipID = Number(probeContext && probeContext.shipID) || this._getShipID(session);
    const systemID = Number(probeContext && probeContext.systemID) || Number(
      (session && session.solarsystemid2) ||
      (session && session.solarsystemid) ||
      (session && session._space && session._space.systemID) ||
      0,
    ) || 0;

    const launchResult = interdictionProbeRuntime.launchInterdictionProbeFromModule(
      session,
      moduleItem,
      loadedCharge,
    );
    if (!launchResult || launchResult.success !== true) {
      this._throwInterdictionProbeLaunchUserError(
        launchResult && launchResult.errorMsg,
        moduleItem,
      );
    }

    const launchedItemID = Number(launchResult.data && launchResult.data.itemID) || 0;
    const consumeResult = this._consumeLoadedProbeCharge(
      session,
      charID,
      shipID,
      moduleItem,
      1,
    );
    if (!consumeResult.success) {
      if (launchedItemID > 0) {
        interdictionProbeRuntime.removeInterdictionProbe(
          launchedItemID,
          systemID,
          "charge-consume-failed",
          { session },
        );
      }
      this._throwInterdictionProbeLaunchUserError(consumeResult.errorMsg, moduleItem);
    }

    const remainingQuantity = Math.max(
      0,
      Number(consumeResult && consumeResult.data && consumeResult.data.remainingQuantity) || 0,
    );
    return {
      launchedProbeID: launchedItemID,
      chargeTypeID: Number(loadedCharge && loadedCharge.typeID) || 0,
      remainingQuantity,
    };
  },

  _resolveValidatedWarpDisruptFieldGeneratorContext(session, moduleItem) {
    const shipID = this._getShipID(session);
    const charID = this._getCharID(session);
    const systemID = Number(
      (session && session.solarsystemid2) ||
      (session && session.solarsystemid) ||
      (session && session._space && session._space.systemID) ||
      0,
    ) || 0;
    const loadedCharge = moduleItem
      ? getLoadedChargeByFlag(charID, shipID, moduleItem.flagID)
      : null;

    if (!session || !session._space || charID <= 0 || shipID <= 0 || systemID <= 0) {
      this._throwWarpDisruptFieldGeneratorUserError("NOT_IN_SPACE", moduleItem);
    }
    if (!moduleItem || Number(moduleItem.locationID) !== shipID) {
      this._throwWarpDisruptFieldGeneratorUserError("MODULE_NOT_FOUND", moduleItem);
    }
    if (Number(moduleItem.groupID) !== GROUP_WARP_DISRUPT_FIELD_GENERATOR) {
      this._throwWarpDisruptFieldGeneratorUserError("INVALID_MODULE", moduleItem);
    }
    if (!isEffectivelyOnlineModule(moduleItem)) {
      this._throwWarpDisruptFieldGeneratorUserError("MODULE_NOT_ONLINE", moduleItem);
    }

    const restriction = warpDisruptFieldGeneratorRuntime.getActivationRestriction(
      systemID,
      moduleItem,
      loadedCharge,
    );
    if (restriction) {
      this._throwWarpDisruptFieldGeneratorUserError(restriction, moduleItem);
    }

    return {
      moduleItem,
      loadedCharge,
      charID,
      shipID,
      systemID,
    };
  },

  _throwWarpDisruptFieldGeneratorUserError(errorMsg = "", moduleItem = null) {
    switch (String(errorMsg || "").trim()) {
      case "NOT_IN_SPACE":
      case "MODULE_NOT_FOUND":
      case "SHIP_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "MODULE_NOT_ONLINE":
        this._throwCustomNotifyUserError(`${this._resolveModuleDisplayName(moduleItem)} is offline.`);
        break;
      case "INVALID_MODULE":
      case "INVALID_WARP_DISRUPT_FIELD_GENERATOR":
        this._throwCustomNotifyUserError("That module cannot create a warp disruption field.");
        break;
      case "WARP_DISRUPT_FIELD_GENERATOR_SCRIPT_UNSUPPORTED":
        this._throwCustomNotifyUserError("That Warp Disruption Field Generator script is not supported.");
        break;
      case "INVALID_WARP_DISRUPT_FIELD_GENERATOR_CHARGE":
        this._throwCustomNotifyUserError("The loaded charge is not valid for this warp disruption field mode.");
        break;
      case "SOLAR_SYSTEM_DATA_UNAVAILABLE":
        this._throwCustomNotifyUserError("Solar system data is unavailable for this warp disruption field.");
        break;
      case "WARP_DISRUPTION_FIELD_DISALLOWED_IN_EMPIRE":
        this._throwCustomNotifyUserError("Warp Disruption Fields cannot be used in high or low security space.");
        break;
      case "WARP_DISRUPTION_FIELD_DISALLOWED_IN_ZARZAKH":
        this._throwCustomNotifyUserError("Warp Disruption Fields cannot be used in Zarzakh.");
        break;
      case "WARP_DISRUPTION_FIELD_RANGE_UNAVAILABLE":
        this._throwCustomNotifyUserError("Warp disruption field range is unavailable for this module.");
        break;
      default:
        this._throwCustomNotifyUserError("Unable to activate warp disruption field generator.");
        break;
    }
  },

  _launchProbesFromContext(session, probeContext = null) {
    const moduleItem = probeContext && probeContext.moduleItem
      ? probeContext.moduleItem
      : null;
    const loadedCharge = probeContext && probeContext.loadedCharge
      ? probeContext.loadedCharge
      : null;
    const requestedCount = Math.max(
      1,
      Number(probeContext && probeContext.requestedCount) || 1,
    );
    const shipID = Number(probeContext && probeContext.shipID) || this._getShipID(session);
    const charID = Number(probeContext && probeContext.charID) || this._getCharID(session);
    const systemID = Number(probeContext && probeContext.systemID) || Number(
      (session && session.solarsystemid2) ||
      (session && session.solarsystemid) ||
      (session && session._space && session._space.systemID) ||
      0,
    ) || 0;

    const launchShipEntity = spaceRuntime.getEntity(session, shipID);
    const launchScene = typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
    const launchScope = resolveAbyssalPlayerLaunchScope(
      session,
      launchShipEntity,
      launchScene,
    );
    if (launchScope.valid !== true) {
      this._throwProbeLaunchUserError(
        "ABYSSAL_LAUNCH_SCOPE_INVALID",
        moduleItem,
      );
    }

    const probeLaunchCapState = probeRuntimeState.getCharacterProbeLaunchCapState(
      charID,
      systemID,
      {
        launchScope,
        scopeMetadata: launchScope.metadata,
      },
    );
    if (probeLaunchCapState.valid !== true) {
      this._throwProbeLaunchUserError(
        probeLaunchCapState.errorMsg || "ABYSSAL_LAUNCH_SCOPE_INVALID",
        moduleItem,
      );
    }
    if (
      (probeLaunchCapState.activeProbeCount + requestedCount) >
      probeRuntimeState.MAX_ACTIVE_PROBES
    ) {
      this._throwProbeLaunchUserError("TOO_MANY_ACTIVE_PROBES", moduleItem);
    }

    const consumeResult = this._consumeLoadedProbeCharge(
      session,
      charID,
      shipID,
      moduleItem,
      requestedCount,
    );
    if (!consumeResult.success) {
      this._throwProbeLaunchUserError(consumeResult.errorMsg, moduleItem);
    }

    const launchPosition = this._resolveProbeLaunchPosition(session, shipID);
    const probeTypeAttributes = getTypeDogmaAttributes(
      Number(loadedCharge && loadedCharge.typeID) || 0,
    );
    const expiryDelayMs = Math.max(
      0,
      Number(probeTypeAttributes[String(ATTRIBUTE_EXPLOSION_DELAY)]) || 0,
    );
    const launchedProbes = probeRuntimeState.launchCharacterProbes(
      charID,
      systemID,
      Number(loadedCharge && loadedCharge.typeID) || 0,
      requestedCount,
      {
        nowMs: Date.now(),
        position: launchPosition,
        shipID,
        launcherItemID: Number(moduleItem && moduleItem.itemID) || 0,
        launcherFlagID: Number(moduleItem && moduleItem.flagID) || 0,
        launchScope,
        scopeMetadata: launchScope.metadata,
        // Probe expiry is authored in milliseconds in attribute 281.  Keep the
        // runtime's one-hour fallback only when the type has no authored value.
        expirySeconds:
          expiryDelayMs > 0
            ? Math.max(1, Math.round(expiryDelayMs / 1000))
            : probeScanRuntime.DEFAULT_PROBE_EXPIRY_SECONDS,
      },
    );
    if (launchedProbes.length !== requestedCount) {
      probeSceneRuntime.removeProbeEntitiesForSession(
        session,
        launchedProbes.map((probe) => Number(probe && probe.probeID) || 0),
      );
      probeRuntimeState.removeCharacterProbes(
        charID,
        launchedProbes.map((probe) => Number(probe && probe.probeID) || 0),
        { nowMs: Date.now() },
      );
      this._throwProbeLaunchUserError("TOO_MANY_ACTIVE_PROBES", moduleItem);
    }

    probeSceneRuntime.ensureProbeEntitiesForSession(session, launchedProbes, {
      ownerID: charID,
    });
    for (const probe of launchedProbes) {
      session.sendNotification("OnNewProbe", "clientID", [
        probeScanRuntime.buildProbeKeyVal(probe),
      ]);
    }
    return {
      launchedProbes,
      chargeTypeID: Number(loadedCharge && loadedCharge.typeID) || 0,
      remainingQuantity: Math.max(
        0,
        Number(consumeResult && consumeResult.data && consumeResult.data.remainingQuantity) || 0,
      ),
    };
  },

  _consumeLoadedProbeCharge(session, charID, shipID, moduleItem, quantity = 1) {
    const numericCharID = Number(charID) || this._getCharID(session);
    const numericShipID = Number(shipID) || this._getShipID(session);
    const numericQuantity = Math.max(1, Number(quantity) || 1);
    if (!moduleItem || numericCharID <= 0 || numericShipID <= 0) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }

    const chargeItem = getLoadedChargeByFlag(
      numericCharID,
      numericShipID,
      Number(moduleItem.flagID) || 0,
    );
    if (!chargeItem) {
      return {
        success: false,
        errorMsg: "NO_CHARGES",
      };
    }

    const availableQuantity = Math.max(
      0,
      Number(chargeItem.stacksize ?? chargeItem.quantity ?? 0) || 0,
    );
    if (availableQuantity <= 0) {
      return {
        success: false,
        errorMsg: "NO_CHARGES",
      };
    }
    if (availableQuantity < numericQuantity) {
      return {
        success: false,
        errorMsg: "NOT_ENOUGH_CHARGES",
      };
    }

    const previousChargeState = this._captureChargeStateSnapshot(
      numericCharID,
      numericShipID,
      moduleItem.flagID,
    );
    const previousChargeItem = this._captureChargeItemSnapshot(
      numericCharID,
      numericShipID,
      moduleItem.flagID,
    );

    let mutationResult = null;
    if (availableQuantity === numericQuantity) {
      mutationResult = removeInventoryItem(chargeItem.itemID, {
        removeContents: true,
      });
    } else {
      mutationResult = updateInventoryItem(chargeItem.itemID, (currentItem) => ({
        ...currentItem,
        quantity: availableQuantity - numericQuantity,
        stacksize: availableQuantity - numericQuantity,
        singleton: 0,
      }));
    }
    if (!mutationResult || mutationResult.success !== true) {
      return {
        success: false,
        errorMsg: mutationResult && mutationResult.errorMsg ? mutationResult.errorMsg : "WRITE_ERROR",
      };
    }

    if (mutationResult.data && Array.isArray(mutationResult.data.changes)) {
      this._syncInventoryChanges(session, mutationResult.data.changes);
    } else {
      this._syncInventoryChanges(session, [{
        previousData: mutationResult.previousData || {},
        item: mutationResult.data || null,
      }]);
    }

    const nextChargeState = this._captureChargeStateSnapshot(
      numericCharID,
      numericShipID,
      moduleItem.flagID,
    );
    const nextChargeItem = this._captureChargeItemSnapshot(
      numericCharID,
      numericShipID,
      moduleItem.flagID,
    );
    this._notifyChargeQuantityTransition(
      session,
      numericCharID,
      numericShipID,
      moduleItem.flagID,
      previousChargeState,
      nextChargeState,
      {
        previousChargeItem,
        nextChargeItem,
      },
    );
    this._notifyWeaponModuleAttributeTransition(
      session,
      moduleItem,
      previousChargeItem,
      nextChargeItem,
    );

    return {
      success: true,
      data: {
        chargeTypeID: Number(chargeItem.typeID) || 0,
        remainingQuantity: Math.max(
          0,
          Number(nextChargeState && nextChargeState.quantity) || 0,
        ),
      },
    };
  },

  Handle_ShipOnlineModules(args, session) {
    log.debug("[DogmaIM] ShipOnlineModules");
    const charID = this._getCharID(session);
    const shipID = this._getShipID(session);
    return {
      type: "list",
      items: getFittedModuleItems(charID, shipID)
        .filter((item) => isEffectivelyOnlineModule(item))
        .map((item) => item.itemID),
    };
  },

  _isAnalyzerModuleActivation(moduleItem, effectName) {
    const normalizedEffectName = String(effectName || "").trim();
    const typeID = Number(moduleItem && moduleItem.typeID) || 0;
    return (
      normalizedEffectName === ANALYZER_EFFECT_NAME &&
      typeID > 0 &&
      Number(moduleItem && moduleItem.categoryID) === 7 &&
      typeHasEffectName(typeID, ANALYZER_EFFECT_NAME)
    );
  },

  _getEntityPosition(entity) {
    if (!entity || typeof entity !== "object") {
      return null;
    }
    if (entity.position && typeof entity.position === "object") {
      return {
        x: normalizeNumber(entity.position.x, 0),
        y: normalizeNumber(entity.position.y, 0),
        z: normalizeNumber(entity.position.z, 0),
      };
    }
    const x = normalizeNumber(entity.x, Number.NaN);
    const y = normalizeNumber(entity.y, Number.NaN);
    const z = normalizeNumber(entity.z, Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }
    return { x, y, z };
  },

  _getEntityRadiusMeters(entity) {
    return Math.max(
      0,
      normalizeNumber(
        entity && (entity.radius ?? entity.spaceRadius ?? entity.interactionRadius),
        0,
      ),
    );
  },

  _getEntitySurfaceDistanceMeters(sourceEntity, targetEntity) {
    const sourcePosition = this._getEntityPosition(sourceEntity);
    const targetPosition = this._getEntityPosition(targetEntity);
    if (!sourcePosition || !targetPosition) {
      return Number.POSITIVE_INFINITY;
    }
    const dx = sourcePosition.x - targetPosition.x;
    const dy = sourcePosition.y - targetPosition.y;
    const dz = sourcePosition.z - targetPosition.z;
    const centerDistance = Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
    return Math.max(
      0,
      centerDistance -
        this._getEntityRadiusMeters(sourceEntity) -
        this._getEntityRadiusMeters(targetEntity),
    );
  },

  _isLockedTarget(sourceEntity, targetID) {
    const normalizedTargetID = Number(targetID) || 0;
    if (!sourceEntity || normalizedTargetID <= 0) {
      return false;
    }
    const lockedTargets = sourceEntity.lockedTargets;
    if (lockedTargets instanceof Map || lockedTargets instanceof Set) {
      return lockedTargets.has(normalizedTargetID);
    }
    if (Array.isArray(lockedTargets)) {
      return lockedTargets.map((entry) => Number(entry) || 0).includes(normalizedTargetID);
    }
    return false;
  },

  _resolveAnalyzerModuleKind(moduleItem) {
    const typeID = Number(moduleItem && moduleItem.typeID) || 0;
    const typeRecord = resolveItemByTypeID(typeID);
    const typeName = String(
      (moduleItem && moduleItem.itemName) ||
        (typeRecord && (typeRecord.name || typeRecord.typeName)) ||
        "",
    ).toLowerCase();
    const requiredSkillIDs = new Set(
      [
        getTypeAttributeValue(typeID, "requiredSkill1"),
        getTypeAttributeValue(typeID, "requiredSkill2"),
      ]
        .map((value) => Number(value) || 0)
        .filter((value) => value > 0),
    );
    const requiresHacking = requiredSkillIDs.has(ANALYZER_HACKING_SKILL_TYPE_ID);
    const requiresArchaeology = requiredSkillIDs.has(ANALYZER_ARCHAEOLOGY_SKILL_TYPE_ID);

    if (
      (requiresHacking && requiresArchaeology) ||
      typeName.includes("integrated analyzer")
    ) {
      return "integrated";
    }
    if (requiresArchaeology || typeName.includes("relic analyzer")) {
      return "relic";
    }
    if (requiresHacking || typeName.includes("data analyzer")) {
      return "data";
    }
    return "unknown";
  },

  _resolveAnalyzerTargetKind(targetEntity) {
    const normalized = String(
      targetEntity &&
        (
          targetEntity.dungeonSiteContentAnalyzer ||
          targetEntity.hackingAnalyzer ||
          targetEntity.analyzer
        ) ||
        "",
    ).trim().toLowerCase();
    if (normalized.includes("relic") || normalized.includes("archaeolog")) {
      return "relic";
    }
    if (normalized.includes("data") || normalized.includes("hack")) {
      return "data";
    }
    return "";
  },

  _isAnalyzerCompatibleWithTarget(moduleKind, targetKind) {
    if (!targetKind) {
      return moduleKind === "data" || moduleKind === "relic" || moduleKind === "integrated";
    }
    if (moduleKind === "integrated") {
      return targetKind === "data" || targetKind === "relic";
    }
    return moduleKind === targetKind;
  },

  _resolveAnalyzerDifficulty(targetEntity) {
    const authored = [targetEntity?.dungeonSiteContentHackingDifficulty,
      targetEntity?.hackingDifficulty, targetEntity?.difficulty]
      .find(value => value !== null && value !== undefined && value !== "");
    const rawDifficulty = authored ?? getTypeDogmaAttributes(Number(targetEntity?.typeID))?.[ATTRIBUTE_HACKING_TIER_DIFFICULTY];
    const numericDifficulty = normalizeNumber(rawDifficulty, Number.NaN);
    if (Number.isFinite(numericDifficulty) && numericDifficulty >= 0) {
      return Math.max(0, Math.min(5, Math.trunc(numericDifficulty)));
    }
    switch (String(rawDifficulty || "").trim().toLowerCase()) {
      case "trivial":
      case "very_easy":
      case "very easy":
      case "low":
        return 1;
      case "easy":
        return 2;
      case "medium":
      case "moderate":
      case "normal":
        return 3;
      case "hard":
      case "difficult":
      case "high":
        return 4;
      case "very_hard":
      case "very hard":
      case "hardest":
      case "severe":
        return 5;
      case "extreme":
      case "critical":
        return 5;
      default:
        return 1;
    }
  },

  _resolveAnalyzerAccessDifficultyBonusPercent(session, moduleItem) {
    const characterID = this._getCharID(session);
    const effectiveAttributes = applyActiveImplantLocationModifiersToAttributes(
      buildEffectiveItemAttributeMap(moduleItem),
      moduleItem,
      characterID,
    );
    const rawBonus = normalizeNumber(
      effectiveAttributes[ATTRIBUTE_ACCESS_DIFFICULTY_BONUS],
      0,
    );
    return Number.isFinite(rawBonus) ? Math.max(0, Number(rawBonus.toFixed(6))) : 0;
  },

  _resolveAnalyzerEffectiveDifficulty(session, moduleItem, targetEntity) {
    const baseDifficulty = this._resolveAnalyzerDifficulty(targetEntity);
    const accessDifficultyBonusPercent =
      this._resolveAnalyzerAccessDifficultyBonusPercent(session, moduleItem);
    const effectiveDifficulty = Math.max(
      0,
      baseDifficulty -
        (accessDifficultyBonusPercent / ANALYZER_ACCESS_BONUS_DIFFICULTY_DIVISOR),
    );
    return {
      difficulty: Number(effectiveDifficulty.toFixed(6)),
      baseDifficulty,
      accessDifficultyBonusPercent,
    };
  },

  _resolveAnalyzerVirusStats(session, moduleItem) {
    const effectiveAttributes = this._resolveAnalyzerLiveModuleAttributes(
      session,
      moduleItem,
    );
    const rawCoherence = Number(effectiveAttributes[ATTRIBUTE_VIRUS_COHERENCE]);
    const rawStrength = Number(effectiveAttributes[ATTRIBUTE_VIRUS_STRENGTH]);
    const baseCoherence = Math.max(
      1,
      Math.round(Number.isFinite(rawCoherence) ? rawCoherence : 40),
    );
    const baseStrength = Math.max(
      1,
      Math.round(Number.isFinite(rawStrength) ? rawStrength : 20),
    );
    const slots = Math.max(
      0,
      Math.round(
        Number(effectiveAttributes[ATTRIBUTE_VIRUS_ELEMENT_SLOTS]) || 0,
      ),
    );
    // No hand-rolled skill bonus here. Hacking (21718) and Archaeology (13278) each declare
    // `virusCoherenceBonus` 10 and effect 5435, which turns it into `10 x skillLevel`; effects 5433
    // and 5437 then ModAdd that onto `virusCoherence` for every module on the ship requiring the
    // matching skill. `_resolveModuleShipDogmaAttributeMap` runs that dogma, so adding
    // `skillLevel * 10` again here would double it.
    return {
      coherence: baseCoherence,
      strength: baseStrength,
      slots,
    };
  },

  _resolveAnalyzerHackingContext(session, moduleItem, targetID) {
    const normalizedTargetID = Number(targetID) || 0;
    if (!session || !session._space) {
      return { success: false, errorMsg: "NOT_IN_SPACE" };
    }
    if (normalizedTargetID <= 0) {
      return { success: false, errorMsg: "TARGET_REQUIRED" };
    }
    const scene =
      typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
    if (!scene || typeof scene.getShipEntityForSession !== "function") {
      return { success: false, errorMsg: "SHIP_NOT_FOUND" };
    }
    const sourceEntity = scene.getShipEntityForSession(session);
    if (!sourceEntity) {
      return { success: false, errorMsg: "SHIP_NOT_FOUND" };
    }
    const targetEntity =
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(normalizedTargetID)
        : null;
    if (
      !targetEntity ||
      !canEntitiesInteractLocally(sourceEntity, targetEntity)
    ) {
      return { success: false, errorMsg: "TARGET_NOT_FOUND" };
    }
    if (!this._isLockedTarget(sourceEntity, normalizedTargetID)) {
      return { success: false, errorMsg: "TARGET_NOT_LOCKED" };
    }
    const hackingContainerState = require("../../exploration/hackingContainerState");
    const isHackableContainer = hackingContainerState.isHackable(targetEntity);
    if (!isHackableContainer) {
      return { success: false, errorMsg: "ANALYZER_TARGET_INVALID" };
    }
    const hackingState = hackingContainerState.getState(targetEntity);
    if (hackingState === hackingContainerState.LOCKED) {
      return { success: false, errorMsg: "ANALYZER_TARGET_LOCKED" };
    }
    if (hackingContainerState.isDestroyed(targetEntity)) {
      return { success: false, errorMsg: "ANALYZER_TARGET_DESTROYED" };
    }
    if (hackingState === HACKING_STATE_HACKED) {
      return { success: false, errorMsg: "ANALYZER_TARGET_ALREADY_HACKED" };
    }
    if (hackingState === HACKING_STATE_BEING_HACKED) {
      return { success: false, errorMsg: "ANALYZER_TARGET_BUSY" };
    }
    const maxRangeMeters = this._resolveModuleActivationRangeMeters(session, moduleItem);
    if (!Number.isFinite(maxRangeMeters) || maxRangeMeters <= 0) {
      return { success: false, errorMsg: "ANALYZER_RANGE_UNAVAILABLE" };
    }
    if (
      this._getEntitySurfaceDistanceMeters(sourceEntity, targetEntity) > maxRangeMeters + 1
    ) {
      return { success: false, errorMsg: "TARGET_OUT_OF_RANGE" };
    }

    const moduleKind = this._resolveAnalyzerModuleKind(moduleItem);
    const targetKind = this._resolveAnalyzerTargetKind(targetEntity) || moduleKind;
    if (!this._isAnalyzerCompatibleWithTarget(moduleKind, targetKind)) {
      return { success: false, errorMsg: "ANALYZER_TYPE_MISMATCH" };
    }
    const virusStats = this._resolveAnalyzerVirusStats(session, moduleItem);
    const difficultyStats = this._resolveAnalyzerEffectiveDifficulty(
      session,
      moduleItem,
      targetEntity,
    );
    return {
      success: true,
      data: {
        targetID: normalizedTargetID,
        targetEntity,
        moduleTypeID: Number(moduleItem && moduleItem.typeID) || 0,
        moduleItemID: Number(moduleItem && moduleItem.itemID) || 0,
        gameType:
          targetKind === "relic"
            ? ANALYZER_GAME_TYPE_ARCHEOLOGY
            : ANALYZER_GAME_TYPE_HACKING,
        difficulty: difficultyStats.difficulty,
        baseDifficulty: difficultyStats.baseDifficulty,
        accessDifficultyBonusPercent: difficultyStats.accessDifficultyBonusPercent,
        coherence: virusStats.coherence,
        strength: virusStats.strength,
        slots: virusStats.slots,
        maxRangeMeters,
      },
    };
  },

  _buildModuleTargetOutOfRangeUserErrorValues(context = {}) {
    const session = context.session || null;
    const moduleItem = context.moduleItem || null;
    const rangeDecision =
      context.errorData &&
      context.errorData.rangeDecision &&
      typeof context.errorData.rangeDecision === "object"
        ? context.errorData.rangeDecision
        : null;
    const targetID = Number(context.targetID) || 0;
    const scene =
      session && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
    const sourceEntity =
      scene && typeof scene.getShipEntityForSession === "function"
        ? scene.getShipEntityForSession(session)
        : null;
    const targetEntity =
      scene && targetID > 0 && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(targetID)
        : null;
    const authoredDesiredRange = rangeDecision
      ? Number(rangeDecision.desiredRange)
      : Number.NaN;
    const desiredRange = Number.isFinite(authoredDesiredRange)
      ? Math.max(0, authoredDesiredRange)
      : Math.max(
          0,
          Number(this._resolveModuleActivationRangeMeters(session, moduleItem)) || 0,
        );
    const authoredActualDistance = rangeDecision
      ? Number(rangeDecision.actualDistance)
      : Number.NaN;
    const actualDistance = Number.isFinite(authoredActualDistance)
      ? Math.max(0, authoredActualDistance)
      : this._getEntitySurfaceDistanceMeters(sourceEntity, targetEntity);
    const targetName = this._buildUserErrorTypeValue(targetEntity && targetEntity.typeID);
    const shipType = this._buildUserErrorTypeValue(sourceEntity && sourceEntity.typeID);

    return {
      desiredRange,
      targetName:
        targetName ||
        this._resolveEntityDisplayName(targetEntity, "That target"),
      shipType,
      actualDistance: Number.isFinite(actualDistance)
        ? Math.max(0, actualDistance)
        : 0,
    };
  },

  _buildModuleTargetTooFarUserErrorValues(context = {}) {
    const session = context.session || null;
    const moduleItem = context.moduleItem || null;
    const rangeDecision =
      context.errorData &&
      context.errorData.rangeDecision &&
      typeof context.errorData.rangeDecision === "object"
        ? context.errorData.rangeDecision
        : null;
    const targetID = Number(context.targetID) || 0;
    const scene =
      session && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
    const targetEntity =
      scene && targetID > 0 && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(targetID)
        : null;
    const authoredDesiredRange =
      rangeDecision && rangeDecision.desiredRange != null
        ? Number(rangeDecision.desiredRange)
        : Number.NaN;
    const distance = Number.isFinite(authoredDesiredRange)
      ? Math.max(0, authoredDesiredRange)
      : Math.max(
          0,
          Number(this._resolveModuleActivationRangeMeters(session, moduleItem)) || 0,
        );
    const targetname = this._buildUserErrorTypeValue(targetEntity && targetEntity.typeID);
    const module = Math.max(
      0,
      Math.trunc(Number(moduleItem && moduleItem.typeID) || 0),
    );

    return {
      distance,
      targetname,
      module,
    };
  },

  _formatCargoContainerAnchorUserError(errorMsg = "") {
    switch (String(errorMsg || "")) {
      case "ITEM_NOT_FOUND":
        return "That container is no longer available.";
      case "ITEM_NOT_ANCHORABLE_CONTAINER":
        return "That type of container cannot be anchored.";
      case "INVALID_SESSION":
      case "CONTAINER_NOT_IN_SPACE":
      case "SHIP_NOT_VISIBLE":
      case "CONTAINER_NOT_VISIBLE":
      case "INVALID_SPACE_POSITION":
        return "You must be in space near that container.";
      case "TARGET_TOO_FAR":
        return "You must be within 2,500 meters of the container.";
      case "CONTAINER_OWNER_REQUIRED":
        return "You must own the container to anchor or unanchor it.";
      case "ANCHORING_SKILL_REQUIRED":
        return "You need the required Anchoring skill to do that.";
      case "SOLAR_SYSTEM_DATA_UNAVAILABLE":
        return "Solar system security data is unavailable.";
      case "SOLAR_SYSTEM_SECURITY_TOO_HIGH":
        return "Secure containers can only be anchored in 0.7 security space or lower.";
      case "CONTAINER_ANCHOR_TRANSITION_IN_PROGRESS":
        return "That container is already anchoring or unanchoring.";
      case "CONTAINER_ALREADY_ANCHORED":
        return "That container is already anchored.";
      case "CONTAINER_NOT_ANCHORED":
        return "That container is not anchored.";
      default:
        return "Unable to change that container's anchored state.";
    }
  },

  _handleCargoContainerAnchorActivation(itemID, effectName, session) {
    // Loaded lazily because the cargo runtime also owns space-scene interactions.
    const {
      startSecureContainerAnchorTransition,
    } = require(path.join(__dirname, "../../ship/cargoContainerRuntime"));
    const result = startSecureContainerAnchorTransition(
      session,
      itemID,
      effectName,
    );
    if (!result.success) {
      log.warn(
        `[DogmaIM] Container anchor activation rejected itemID=${itemID} ` +
        `effect=${effectName} error=${result.errorMsg}`,
      );
      this._throwCustomNotifyUserError(
        this._formatCargoContainerAnchorUserError(result.errorMsg),
      );
    }
    return 1;
  },

  _formatControlTowerAnchorUserError(errorMsg = "") {
    switch (String(errorMsg || "")) {
      case "CONTROL_TOWER_REINFORCED":
        return "The control tower is reinforced. Wait until its reinforcement timer ends before changing its state.";
      case "CONTROL_TOWER_INCAPACITATED":
        return "This control tower is incapacitated or being destroyed and cannot change state.";
      case "ITEM_NOT_FOUND":
        return "That control tower is no longer available.";
      case "ITEM_NOT_CONTROL_TOWER":
      case "ITEM_NOT_ANCHORABLE_CONTROL_TOWER":
        return "That structure cannot be anchored as a control tower.";
      case "INVALID_SESSION":
      case "CONTROL_TOWER_NOT_IN_SPACE":
      case "SHIP_NOT_VISIBLE":
      case "CONTROL_TOWER_NOT_VISIBLE":
        return "You must be in space near that control tower.";
      case "TARGET_TOO_FAR":
        return "You must be within 30,000 meters of the control tower.";
      case "CONTROL_TOWER_OWNER_REQUIRED":
        return "You must belong to the corporation that owns the control tower.";
      case "STARBASE_PLAYER_CORPORATION_REQUIRED":
        return "Control towers can only be managed by members of a player corporation.";
      case "STARBASE_CORPORATION_OWNER_REQUIRED":
        return "You must belong to the corporation that owns the control tower.";
      case "STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED":
        return "You need the Config Starbase Equipment corporation role to manage a control tower.";
      case "ANCHORING_SKILL_REQUIRED":
        return "You need Anchoring I to anchor or unanchor a control tower.";
      case "CONTROL_TOWER_CHARTER_UNAVAILABLE":
        return "A control tower cannot be anchored in this system because its sovereign faction does not issue a Starbase Charter.";
      case "STARBASE_SYSTEM_UNAVAILABLE":
        return "The solar system's anchoring rules could not be determined.";
      case "STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM":
        return "Starbase structures cannot be anchored in this solar system.";
      case "STARBASE_SECURITY_TOO_HIGH":
        return "This control tower cannot be anchored in a solar system with this security level.";
      case "STARBASE_SECURITY_TOO_LOW":
        return "This control tower cannot be anchored in a solar system with this security level.";
      case "STARBASE_SOVEREIGNTY_REQUIRED":
        return "Your alliance must hold sovereignty in this solar system to anchor this structure.";
      case "STARBASE_SOVEREIGNTY_UPGRADE_REQUIRED":
        return "Your alliance must hold this system and have the required infrastructure upgrade online and powered to anchor or online this structure.";
      case "STARBASE_SOVEREIGNTY_LEVEL_REQUIRED":
        return "Your alliance's strategic sovereignty level is too low to anchor this structure.";
      case "CONTROL_TOWER_MOON_REQUIRED":
        return "A control tower must be anchored near a moon.";
      case "CONTROL_TOWER_TOO_FAR_FROM_MOON":
        return "The control tower is too far from the nearest moon to be anchored.";
      case "CONTROL_TOWER_MOON_OCCUPIED":
        return "Another control tower is already anchored at this moon.";
      case "CONTROL_TOWER_ANCHOR_TRANSITION_IN_PROGRESS":
        return "That control tower is already anchoring or unanchoring.";
      case "CONTROL_TOWER_ALREADY_ANCHORED":
        return "That control tower is already anchored.";
      case "CONTROL_TOWER_NOT_ANCHORED":
        return "That control tower is not anchored.";
      case "CONTROL_TOWER_MUST_BE_OFFLINE":
        return "The control tower must be offline before it can be unanchored.";
      case "CONTROL_TOWER_HAS_DEPENDENT_MODULES":
        return "All starbase structures must be unanchored before the control tower can be unanchored.";
      default:
        return "Unable to change that control tower's anchored state.";
    }
  },

  _handleControlTowerAnchorActivation(itemID, effectName, session) {
    const {
      startControlTowerAnchorTransition,
    } = require(path.join(__dirname, "../../ship/controlTowerRuntime"));
    const result = startControlTowerAnchorTransition(
      session,
      itemID,
      effectName,
    );
    if (!result.success) {
      log.warn(
        `[DogmaIM] Control tower anchor activation rejected itemID=${itemID} ` +
        `effect=${effectName} error=${result.errorMsg}`,
      );
      this._throwCustomNotifyUserError(
        this._formatControlTowerAnchorUserError(result.errorMsg),
      );
    }
    return 1;
  },

  _formatControlTowerOnlineUserError(errorMsg = "") {
    switch (String(errorMsg || "")) {
      case "CONTROL_TOWER_REINFORCED":
        return "The control tower is reinforced. Wait until its reinforcement timer ends before changing its state.";
      case "CONTROL_TOWER_INCAPACITATED":
        return "This control tower is incapacitated or being destroyed and cannot change state.";
      case "ITEM_NOT_FOUND":
        return "That control tower is no longer available.";
      case "ITEM_NOT_CONTROL_TOWER":
      case "ITEM_NOT_ONLINEABLE_CONTROL_TOWER":
      case "INVALID_CONTROL_TOWER_ONLINE_EFFECT":
        return "That structure cannot be put online as a control tower.";
      case "INVALID_SESSION":
      case "CONTROL_TOWER_NOT_IN_SPACE":
      case "SHIP_NOT_VISIBLE":
      case "CONTROL_TOWER_NOT_VISIBLE":
        return "You must be in space near that control tower.";
      case "TARGET_TOO_FAR":
        return "You must be within 30,000 meters of the control tower.";
      case "CONTROL_TOWER_OWNER_REQUIRED":
        return "You must belong to the corporation that owns the control tower.";
      case "STARBASE_PLAYER_CORPORATION_REQUIRED":
        return "Control towers can only be managed by members of a player corporation.";
      case "STARBASE_CORPORATION_OWNER_REQUIRED":
        return "You must belong to the corporation that owns the control tower.";
      case "STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED":
        return "You need the Config Starbase Equipment corporation role to manage a control tower.";
      case "CONTROL_TOWER_NOT_ANCHORED":
        return "The control tower must finish anchoring before it can be put online.";
      case "CONTROL_TOWER_FUEL_REQUIRED":
        return "The control tower fuel bay needs at least one hour of the correct fuel blocks before it can be put online.";
      case "CONTROL_TOWER_CHARTER_REQUIRED":
        return "The control tower fuel bay needs the sovereign faction's starbase charter before it can be put online in high-security space.";
      case "CONTROL_TOWER_CHARTER_UNAVAILABLE":
        return "This system's sovereign faction does not issue a Starbase Charter, so the control tower cannot be put online here.";
      case "CONTROL_TOWER_FUEL_CONFIGURATION_UNAVAILABLE":
        return "The required fuel type for that control tower could not be determined.";
      default:
        return "Unable to change that control tower's online state.";
    }
  },

  _handleControlTowerOnlineActivation(itemID, session) {
    const {
      startControlTowerOnlineTransition,
    } = require(path.join(__dirname, "../../ship/controlTowerRuntime"));
    const result = startControlTowerOnlineTransition(
      session,
      itemID,
      "onlineForStructures",
    );
    if (!result.success) {
      log.warn(
        `[DogmaIM] Control tower online activation rejected itemID=${itemID} ` +
        `error=${result.errorMsg}`,
      );
      this._throwCustomNotifyUserError(
        this._formatControlTowerOnlineUserError(result.errorMsg),
      );
    }
    return 1;
  },

  _formatStarbaseModuleUserError(errorMsg = "", data = null) {
    switch (String(errorMsg || "")) {
      case "MODULE_INCAPACITATED":
        return "This starbase structure is incapacitated or being destroyed and cannot change state.";
      case "STARBASE_PLAYER_CORPORATION_REQUIRED":
        return "Starbase structures can only be managed by members of a player corporation.";
      case "STARBASE_CORPORATION_OWNER_REQUIRED":
        return "You must belong to the corporation that owns this starbase structure.";
      case "STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED":
        return "You need the Config Starbase Equipment corporation role to manage this starbase structure.";
      case "ANCHORING_SKILL_REQUIRED":
        return "You need Anchoring I to anchor or unanchor this starbase structure.";
      case "CONTROL_TOWER_NOT_FOUND":
        return "This structure must be placed within its control tower's permitted range.";
      case "STARBASE_MODULE_TOO_CLOSE_TO_FORCE_FIELD":
        return "This structure is too close to the control tower force field.";
      case "STARBASE_MODULE_OUTSIDE_FORCE_FIELD":
        return "This structure must be anchored completely inside the control tower force field.";
      case "STARBASE_MODULE_TOO_FAR_FROM_CONTROL_TOWER":
        return "This structure is too far from the control tower.";
      case "STARBASE_MODULE_TOO_CLOSE_TO_STRUCTURE":
        return "This structure overlaps another anchored starbase structure.";
      case "STARBASE_GROUP_ANCHOR_LIMIT_REACHED":
        return "The solar system already has the maximum number of structures of this type.";
      case "STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM":
        return "Starbase structures cannot be anchored in this solar system.";
      case "STARBASE_SECURITY_TOO_HIGH":
      case "STARBASE_SECURITY_TOO_LOW":
        return "This structure cannot be anchored in a solar system with this security level.";
      case "STARBASE_SOVEREIGNTY_REQUIRED":
        return "Your alliance must hold sovereignty in this solar system to anchor this structure.";
      case "STARBASE_SOVEREIGNTY_UPGRADE_REQUIRED":
        return "Your alliance must hold this system and have the required infrastructure upgrade online and powered to anchor or online this structure.";
      case "STARBASE_SOVEREIGNTY_LEVEL_REQUIRED":
        return "Your alliance's strategic sovereignty level is too low to anchor this structure.";
      case "CONTROL_TOWER_NOT_ONLINE":
        return "The associated control tower must be online first.";
      case "STARBASE_MODULE_NOT_ANCHORED":
        return "This starbase structure must finish anchoring before it can be put online.";
      case "STARBASE_MODULE_MUST_BE_OFFLINE":
        return "This starbase structure must be offline before it can be unanchored.";
      case "STARBASE_INDUSTRY_JOBS_ACTIVE":
        return "Cancel or deliver the assembly array's industry jobs before unanchoring it.";
      case "STARBASE_CPU_INSUFFICIENT": {
        const required = Number(data && data.requiredCpu);
        const available = Number(data && data.availableCpu);
        return data && Number.isFinite(required) && Number.isFinite(available)
          ? `This structure requires ${required} tf of CPU, but the control tower only has ${Math.max(0, available)} tf available.`
          : "The control tower does not have enough CPU available to online this structure.";
      }
      case "STARBASE_POWERGRID_INSUFFICIENT": {
        const required = Number(data && data.requiredPowergrid);
        const available = Number(data && data.availablePowergrid);
        return data && Number.isFinite(required) && Number.isFinite(available)
          ? `This structure requires ${required} MW of powergrid, but the control tower only has ${Math.max(0, available)} MW available.`
          : "The control tower does not have enough powergrid available to online this structure.";
      }
      case "STARBASE_STRUCTURE_TOO_FAR":
        return "Move within 2,500 meters of this structure, or manage it while your ship is inside the control tower force field.";
      default:
        return "Unable to change that starbase structure's state.";
    }
  },

  _buildModuleReactivationUserErrorValues(session, moduleItem) {
    const numericModuleID = Number(moduleItem && moduleItem.itemID) || 0;
    const numericTypeID = Number(moduleItem && moduleItem.typeID) || 0;
    const scene = spaceRuntime.getSceneForSession(session);
    const shipEntity = scene ? scene.getShipEntityForSession(session) : null;
    const nowMs =
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? Number(scene.getCurrentSimTimeMs()) || Date.now()
        : Date.now();
    const lockUntilMs =
      shipEntity &&
      shipEntity.moduleReactivationLocks instanceof Map
        ? Number(shipEntity.moduleReactivationLocks.get(numericModuleID)) || 0
        : 0;
    const moduleAttributes =
      moduleItem && numericTypeID > 0
        ? buildEffectiveItemAttributeMap(moduleItem)
        : null;
    const fullDelayMs = Math.max(
      0,
      Number(
        moduleAttributes && moduleAttributes[ATTRIBUTE_MODULE_REACTIVATION_DELAY] !== undefined
          ? moduleAttributes[ATTRIBUTE_MODULE_REACTIVATION_DELAY]
          : getTypeAttributeValue(numericTypeID, "moduleReactivationDelay"),
      ) || 0,
    );
    const remainingDelayMs = Math.max(0, lockUntilMs - nowMs);
    const timeSinceLastStopMs = Math.max(0, fullDelayMs - remainingDelayMs);
    // Two client consumers read this dict, and they want different things.
    //
    // The message body (UI/Messages/2307) is "{item} fails to activate as it is
    // still recovering from its last period of operation and will be for the
    // next {[timeinterval]delay.writtenForm}", so it substitutes `item` and
    // `delay` -- neither of which was sent, which is why the client drew the
    // raw template text at the player. `delay` is how much longer the module is
    // unavailable, so it is the remaining lock rather than the time served.
    //
    // shipmodulebutton.SetReactivationTime reads `itemID` and
    // `timeSinceLastStop` instead, to seed the button's cooldown ring
    // (GetSimTime() - timeSinceLastStop * MSEC). Those keep their existing
    // names, units and meaning: milliseconds, counted from the last stop. That
    // lookup sits inside a bare `except Exception: pass`, so dropping either
    // key loses the ring silently rather than raising.
    //
    // localization's time formatter reads a float as seconds and an integer as
    // raw blue time, and marshalEncode picks int or real from Number.isInteger
    // -- so a whole-second remainder would otherwise be read as ~100 ns and
    // render as no time at all. Pin the float.
    return {
      item: this._buildUserErrorTypeValue(numericTypeID),
      delay: { type: "real", value: remainingDelayMs / 1000 },
      itemID: numericModuleID,
      timeSinceLastStop: timeSinceLastStopMs,
    };
  },

  _buildEffectCrowdedOutValues(session, moduleItem) {
    const numericTypeID = Number(moduleItem && moduleItem.typeID) || 0;
    const numericGroupID = Number(moduleItem && moduleItem.groupID) || 0;
    const scene = spaceRuntime.getSceneForSession(session);
    const shipEntity = scene ? scene.getShipEntityForSession(session) : null;
    const count =
      shipEntity &&
      shipEntity.activeModuleEffects instanceof Map
        ? [...shipEntity.activeModuleEffects.values()].filter(
          (effectState) => Number(effectState && effectState.groupID) === numericGroupID,
        ).length
        : 0;
    return {
      module: numericTypeID,
      count,
    };
  },

  _throwModuleOnlineUserError(errorMsg = "", moduleItem = null, data = null) {
    switch (String(errorMsg || "").trim()) {
      // OnlineHasSkillPrerequisites: "Unable to bring {item} online. This action requires having learned the
      // following skills: {requiredSkills}." Skills as UI/SkillQueue/Skills/SkillNameAndLevel ("{name} : Level n").
      case "SKILL_REQUIRED": {
        const names = (Array.isArray(data && data.missingSkills) ? data.missingSkills : []).map((requirement) => {
          const skillTypeID = Number(requirement && requirement.skillTypeID) || 0;
          const skillName = String((resolveItemByTypeID(skillTypeID) || {}).name || skillTypeID);
          return `${skillName} : Level ${Number(requirement && requirement.requiredLevel) || 0}`;
        });
        throwWrappedUserError("OnlineHasSkillPrerequisites", {
          item: Number(moduleItem && moduleItem.typeID) || 0,
          requiredSkills: names.join(", "),
        });
        break;
      }
      case "MODULE_NOT_FOUND":
      case "SHIP_NOT_FOUND":
      case "NOT_IN_SPACE":
        throwWrappedUserError("DeniedShipChanged");
        break;
      // The game's own refusal for an online the ship cannot feed (baseDogma.UserError, baseDogma.py 28 to 49):
      // NotEnoughCpu or NotEnoughPower with the module by type, its need, what is left and the whole output, the
      // client's dialogs' parameters.
      case "NOT_ENOUGH_CPU":
      case "NOT_ENOUGH_POWER": {
        const typeID = Number(moduleItem && moduleItem.typeID) || 0;
        const shortfall = data && typeof data === "object" ? data : {};
        throwWrappedUserError(String(errorMsg).trim() === "NOT_ENOUGH_CPU" ? "NotEnoughCpu" : "NotEnoughPower", {
          moduleName: this._buildUserErrorTypeValue(typeID),
          moduleType: typeID,
          require: Number(shortfall.require) || 0,
          remaining: Number(shortfall.remaining) || 0,
          total: Number(shortfall.total) || 0,
        });
        break;
      }
      case "NOT_ENOUGH_CAPACITOR":
        throwWrappedUserError("NotEnoughCapacitorForOnline", {
          module: Number(moduleItem && moduleItem.typeID) || 0,
          have: 0,
          need: ONLINE_CAPACITOR_CHARGE_RATIO / 100,
        });
        break;
      case "NOT_ENOUGH_FUEL":
        this._throwCustomNotifyUserError(
          "There is not enough fuel in the structure fuel bay to online that service module.",
        );
        break;
      case "MAX_GROUP_ONLINE":
        throwWrappedUserError("CannotOnlineReachedMaxGroupOnline", {
          type: this._buildUserErrorTypeValue(moduleItem && moduleItem.typeID),
          group: [
            USER_ERROR_GROUP_ID,
            Number(
              (data && data.groupID) ||
                (moduleItem && moduleItem.groupID),
            ) || 0,
          ],
          maxGroupOnline: Math.max(
            0,
            Math.trunc(Number(data && data.maxGroupOnline) || 0),
          ),
        });
        break;
      case "STRUCTURE_DAMAGED":
        this._throwCustomNotifyUserError(
          "Service modules cannot be onlined while the structure is damaged.",
        );
        break;
      case "STRUCTURE_SERVICE_TOO_CLOSE":
        this._throwCustomNotifyUserError(
          "That navigation service cannot be onlined because another Upwell structure is too close.",
        );
        break;
      case "STRUCTURE_SERVICE_REQUIRES_SOV_UPGRADE":
        this._throwCustomNotifyUserError(
          this._formatStructureServiceRequiresSovUpgradeError(data),
        );
        break;
      case "CRP_ACCESS_DENIED":
        throwWrappedUserError(
          "CrpAccessDenied",
          buildCrpAccessDeniedInsufficientRolesValues(),
        );
        break;
      case "CARGO_WOULD_OVERFLOW": {
        const cubicMetres = (value) => Number((Number(value) || 0).toFixed(2));
        this._throwCustomNotifyUserError(
          "That module cannot be put offline while the cargo hold is this full. The hold " +
            `carries ${cubicMetres(data && data.used)} m3 and the ship ` +
            `would be left with room for ${cubicMetres(data && data.capacityAfter)} m3. ` +
            "Move some cargo out first.",
        );
        break;
      }
      default:
        this._throwCustomNotifyUserError(
          `Failed to change the online state for ${this._resolveModuleDisplayName(moduleItem)}.`,
        );
        break;
    }
  },

  _formatStructureServiceRequiresSovUpgradeError(data = null) {
    const requiredUpgradeTypeID = Math.max(
      0,
      Math.trunc(Number(data && data.requiredUpgradeTypeID) || 0),
    );
    const upgradeType = requiredUpgradeTypeID > 0
      ? resolveItemByTypeID(requiredUpgradeTypeID)
      : null;
    const upgradeName = upgradeType && upgradeType.name
      ? String(upgradeType.name)
      : "the required sovereignty hub upgrade";
    return `That service module requires ${upgradeName} to be online in this solar system.`;
  },

  _throwModuleActivationUserError(errorMsg = "", context = {}) {
    const normalizedErrorMsg = String(errorMsg || "").trim();
    const session = context.session || null;
    const moduleItem = context.moduleItem || null;
    const moduleName = this._resolveModuleDisplayName(moduleItem);

    switch (normalizedErrorMsg) {
      case "NOT_IN_SPACE":
      case "SHIP_NOT_FOUND":
      case "MODULE_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "TARGET_SELF":
        throwWrappedUserError("DeniedTargetSelf");
        break;
      case "SOURCE_WARPING":
        throwWrappedUserError("DeniedTargetSelfWarping");
        break;
      case "TARGET_WARPING": {
        const targetID = Number(context.targetID) || 0;
        const scene = session ? spaceRuntime.getSceneForSession(session) : null;
        const targetEntity =
          scene && targetID > 0 && typeof scene.getEntityByID === "function"
            ? scene.getEntityByID(targetID)
            : null;
        this._throwTargetingUserError(normalizedErrorMsg, {
          targetTypeID:
            Number(context.errorData && context.errorData.targetTypeID) ||
            Number(targetEntity && targetEntity.typeID) || 0,
        });
        break;
      }
      case "TARGET_NOT_FOUND":
        throwWrappedUserError("DeniedActivateTargetNotPresent");
        break;
      case "HOMEFRONT_DREAD_IN_SIEGE":
        this._throwCustomNotifyUserError(
          require("../../homefront/homefrontMessages").DREAD_SIEGE_MESSAGE,
        );
        break;
      case "TARGET_NOT_DAMAGEABLE":
        // Not DeniedActivateTargetNotPresent: the target is present, locked and
        // orbitable. It simply has no health envelope for a weapon to work on,
        // which is authored-data breakage rather than anything the pilot did.
        this._throwCustomNotifyUserError(
          `${moduleName} cannot damage that target: it has no shield, armor or structure hit points.`,
        );
        break;
      case "TARGET_OUT_OF_RANGE":
        if (String(context.effectName || "").trim().toLowerCase() === "mininglaser") {
          throwWrappedUserError(
            "TargetTooFar",
            this._buildModuleTargetTooFarUserErrorValues(context),
          );
        }
        throwWrappedUserError(
          "TargetNotWithinRangeGeneric",
          this._buildModuleTargetOutOfRangeUserErrorValues(context),
        );
        break;
      case "MODULE_ALREADY_ACTIVE":
        throwWrappedUserError("EffectAlreadyActive2", {
          modulename: this._buildUserErrorTypeValue(moduleItem && moduleItem.typeID),
        });
        break;
      case "MODULE_REACTIVATING":
        throwWrappedUserError(
          "ModuleReactivationDelayed2",
          this._buildModuleReactivationUserErrorValues(session, moduleItem),
        );
        break;
      case "NO_AMMO":
        throwWrappedUserError("NoCharges", {
          launcher: this._buildUserErrorTypeValue(moduleItem && moduleItem.typeID),
        });
        break;
      case "MAX_GROUP_ACTIVE":
        throwWrappedUserError(
          "EffectCrowdedOut",
          this._buildEffectCrowdedOutValues(session, moduleItem),
        );
        break;
      case "TARGET_REQUIRED":
        this._throwCustomNotifyUserError("You need an active target to activate that module.");
        break;
      case "TARGET_NOT_LOCKED":
        this._throwCustomNotifyUserError("That target is not locked.");
        break;
      // cargoScanResistance (188) is 100% on the five Blockade Runners, the
      // Boobook, the Cenotaph and the Tholos. TQ does not eat the cycle for
      // this: the module simply refuses to start.
      case "TARGET_RESISTS_SCAN":
        this._throwCustomNotifyUserError("That ship is resistant to your scan.");
        break;
      case "TARGET_TETHERED":
        this._throwCustomNotifyUserError("That target is tethered and cannot be affected by this module.");
        break;
      case "MODULE_NOT_ONLINE":
        this._throwCustomNotifyUserError(`${moduleName} is offline.`);
        break;
      case "MODULE_INCAPACITATED":
        this._throwCustomNotifyUserError(`${moduleName} is too damaged to activate.`);
        break;
      case "NOT_ENOUGH_CAPACITOR":
        this._throwCustomNotifyUserError("You do not have enough capacitor to activate that module.");
        break;
      case "CLOAK_PROXIMITY_BLOCKED":
        this._throwCustomNotifyUserError(
          "You are too close to another object to activate your cloaking device.",
        );
        break;
      case "CLOAK_TARGET_LOCKED":
        this._throwCustomNotifyUserError(
          "Your ship is already target locked and cannot activate a cloaking device.",
        );
        break;
      case "CLOAK_WARP_BLOCKED":
        this._throwCustomNotifyUserError(
          "You cannot activate that cloaking device while warping.",
        );
        break;
      // TQ raises CantCloakModuleActive here: a running module whose cycle
      // cannot be cut short (gas cloud harvesters, siege/bastion, doomsdays,
      // cynos, micro jump drives) has to finish before a cloak can engage.
      case "CLOAK_MODULE_ACTIVE":
        this._throwCustomNotifyUserError(
          "You cannot activate a cloaking device while a module that cannot be " +
            "deactivated early is still running.",
        );
        break;
      case "MODULE_CLOAKED":
        this._throwCustomNotifyUserError("You cannot activate modules while cloaked.");
        break;
      case "ABYSSAL_CLOAK_RESTRICTED":
        this._throwCustomNotifyUserError("You cannot cloak inside Abyssal Deadspace.");
        break;
      case "ESS_CLOAK_RESTRICTED":
        this._throwCustomNotifyUserError("Cloaking devices cannot be activated this close to the ESS.");
        break;
      case "ESS_PROPULSION_RESTRICTED":
        this._throwCustomNotifyUserError("Microwarpdrives and micro jump drives cannot be used inside the ESS field.");
        break;
      case "ESS_CYNOSURAL_RESTRICTED":
        this._throwCustomNotifyUserError("Cynosural fields cannot be lit inside the ESS field.");
        break;
      case "ANALYZER_TARGET_INVALID":
        this._throwCustomNotifyUserError("That target cannot be hacked with this analyzer.");
        break;
      case "ANALYZER_TYPE_MISMATCH":
        this._throwCustomNotifyUserError("That analyzer is not compatible with this container.");
        break;
      case "ANALYZER_TARGET_ALREADY_HACKED":
        this._throwCustomNotifyUserError("That container has already been hacked.");
        break;
      case "ANALYZER_TARGET_BUSY":
        this._throwCustomNotifyUserError("That container is already being hacked.");
        break;
      case "ANALYZER_TARGET_LOCKED":
        this._throwCustomNotifyUserError("That container is sealed and cannot be hacked again.");
        break;
      case "ANALYZER_TARGET_DESTROYED":
        this._throwCustomNotifyUserError("That container has been destroyed.");
        break;
      case "ANALYZER_RANGE_UNAVAILABLE":
        this._throwCustomNotifyUserError("Unable to determine this analyzer's activation range.");
        break;
      case "NO_FUEL":
        this._throwCustomNotifyUserError("You do not have enough fuel to activate that module.");
        break;
      // Both spellings are live: the Micro Jump Field Generator gate emits
      // MODULE_DISALLOWED_IN_HIGH_SEC and the cynosural gate the shorter form.
      case "MODULE_DISALLOWED_IN_HIGHSEC":
      case "MODULE_DISALLOWED_IN_HIGH_SEC":
        throwWrappedUserError("CantInHighSecSpace");
        break;
      case "CYNOSURAL_FIELD_JAMMED":
        this._throwCustomNotifyUserError(
          "A cynosural system jammer is preventing cynosural fields from forming in this solar system.",
        );
        break;
      case "ACTIVE_INDUSTRIAL_CORE_REQUIRED":
        this._throwCustomNotifyUserError(
          "An active industrial core is required to activate that module.",
        );
        break;
      case "WARP_SCRAMBLED":
        this._throwCustomNotifyUserError("You cannot warp because you are warp scrambled.");
        break;
      case "MICROWARPDRIVE_BLOCKED":
        this._throwCustomNotifyUserError(
          "That module cannot be activated while you are warp scrambled.",
        );
        break;
      case "MICRO_JUMP_DRIVE_BLOCKED":
        this._throwCustomNotifyUserError(
          "That module cannot be activated while you are warp scrambled.",
        );
        break;
      case "SHIP_IMMOBILE":
        this._throwCustomNotifyUserError(
          "That module cannot be activated while your ship is immobilized.",
        );
        break;
      case "MAX_VELOCITY_ACTIVATION_LIMIT":
        this._throwCustomNotifyUserError("You are moving too fast to activate that module.");
        break;
      case "NO_ACTIVATABLE_EFFECT":
      case "UNSUPPORTED_EFFECT":
      case "UNSUPPORTED_MODULE":
        this._throwCustomNotifyUserError(`${moduleName} cannot be activated.`);
        break;
      case "CANNOT_ACTIVATE_IN_WARP":
        throwWrappedUserError("DeniedActivateInWarp");
        break;
      case "MODULE_RESTRICTED_IN_LOWSEC":
        this._throwCustomNotifyUserError(
          "That module cannot be activated in the current security band.",
        );
        break;
      case "TARGET_POINT_REQUIRED":
        this._throwCustomNotifyUserError("You must choose a point in space for that module.");
        break;
      default:
        this._throwCustomNotifyUserError(
          `Failed to activate ${moduleName}: ${normalizedErrorMsg || "unknown error"}.`,
        );
        break;
    }
  },

  _throwModuleDeactivationUserError(errorMsg = "", moduleItem = null) {
    switch (String(errorMsg || "").trim()) {
      case "NOT_IN_SPACE":
      case "SHIP_NOT_FOUND":
      case "MODULE_NOT_FOUND":
        throwWrappedUserError("DeniedShipChanged");
        break;
      case "MODULE_NOT_ACTIVE":
        this._throwCustomNotifyUserError(`${this._resolveModuleDisplayName(moduleItem)} is not active.`);
        break;
      default:
        this._throwCustomNotifyUserError(
          `Failed to deactivate ${this._resolveModuleDisplayName(moduleItem)}.`,
        );
        break;
    }
  },

  _expandGroupedModuleIDs(shipID, rawModuleIDs) {
    const normalizedModuleIDs = extractSequenceValues(rawModuleIDs);
    const requestedModuleIDs =
      normalizedModuleIDs.length > 0
        ? normalizedModuleIDs
        : Array.isArray(rawModuleIDs)
          ? rawModuleIDs
          : [rawModuleIDs];
    const expandedModuleIDs = [];
    const seenModuleIDs = new Set();
    for (const requestedModuleID of requestedModuleIDs) {
      const numericModuleID = Number(requestedModuleID) || 0;
      if (numericModuleID <= 0) {
        continue;
      }
      const bankModuleIDs = getModulesInBank(shipID, numericModuleID);
      const nextModuleIDs =
        Array.isArray(bankModuleIDs) && bankModuleIDs.length > 0
          ? bankModuleIDs
          : [numericModuleID];
      for (const moduleID of nextModuleIDs) {
        const numericExpandedModuleID = Number(moduleID) || 0;
        if (numericExpandedModuleID <= 0 || seenModuleIDs.has(numericExpandedModuleID)) {
          continue;
        }
        seenModuleIDs.add(numericExpandedModuleID);
        expandedModuleIDs.push(numericExpandedModuleID);
      }
    }
    return expandedModuleIDs;
  },

  _buildGroupedUnloadTargets(charID, shipID, rawModuleIDs, quantity = null) {
    const normalizedQuantity =
      quantity === null || quantity === undefined
        ? null
        : Math.max(0, Math.trunc(Number(quantity) || 0));
    const expandedModuleIDs = this._expandGroupedModuleIDs(shipID, rawModuleIDs);
    if (normalizedQuantity === null) {
      return expandedModuleIDs.map((moduleID) => ({
        moduleID,
        quantity: null,
      }));
    }

    const normalizedRequestedModuleIDs = extractSequenceValues(rawModuleIDs);
    const requestedModuleIDs =
      normalizedRequestedModuleIDs.length > 0
        ? normalizedRequestedModuleIDs
        : Array.isArray(rawModuleIDs)
          ? rawModuleIDs
          : [rawModuleIDs];
    if (requestedModuleIDs.length !== 1 || expandedModuleIDs.length <= 1) {
      return expandedModuleIDs.map((moduleID) => ({
        moduleID,
        quantity: normalizedQuantity,
      }));
    }

    let remainingQuantity = normalizedQuantity;
    const unloadTargets = [];
    for (const moduleID of expandedModuleIDs) {
      if (remainingQuantity <= 0) {
        break;
      }
      const moduleItem = findItemById(moduleID);
      if (!moduleItem) {
        continue;
      }
      const chargeItem = getLoadedChargeByFlag(charID, shipID, moduleItem.flagID);
      const availableQuantity = Number(
        chargeItem && (chargeItem.stacksize || chargeItem.quantity),
      ) || 0;
      if (availableQuantity <= 0) {
        continue;
      }
      const unloadQuantity = Math.min(remainingQuantity, availableQuantity);
      unloadTargets.push({
        moduleID,
        quantity: unloadQuantity,
      });
      remainingQuantity -= unloadQuantity;
    }

    if (unloadTargets.length > 0) {
      return unloadTargets;
    }
    return expandedModuleIDs.map((moduleID) => ({
      moduleID,
      quantity: normalizedQuantity,
    }));
  },

  // options.refuseCargoOverflow is set for the pilot's own offline request: a
  // module that enlarges the cargo hold then stays online while the hold
  // carries more than the ship would be left with.
  _setModuleOnlineState(shipID, moduleID, online, session, options = {}) {
    const charID = this._getCharID(session);
    const numericShipID = Number(shipID) || this._getShipID(session);
    const numericModuleID = Number(moduleID) || 0;
    const moduleItem = findItemById(numericModuleID);
    const structureShipRecord = this._getStructureShipMetadataByID(numericShipID);
    const isStructureHost = Boolean(structureShipRecord);
    const moduleOwnerID = Number(moduleItem && moduleItem.ownerID) || 0;
    const structureOwnerID = Number(
      structureShipRecord &&
      (structureShipRecord.ownerCorpID || structureShipRecord.ownerID),
    ) || 0;
    const moduleOwnedForHost =
      moduleOwnerID === charID ||
      (isStructureHost && structureOwnerID > 0 && moduleOwnerID === structureOwnerID);
    if (
      !moduleItem ||
      !moduleOwnedForHost ||
      Number(moduleItem.locationID) !== numericShipID
    ) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    const previousOnline = isEffectivelyOnlineModule(moduleItem);
    const nextOnline = Boolean(online);
    const inSpace = Boolean(session && session._space);
    if (!nextOnline) {
      const bankMasterID = getWeaponBankMasterModuleID(
        numericShipID,
        numericModuleID,
      );
      if (bankMasterID > 0) {
        destroyWeaponBankAndNotify(session, numericShipID, bankMasterID, {
          characterID: charID,
          skipOfflineValidation: true,
        });
      }
    }
    const shipRecord =
      findCharacterShip(charID, numericShipID) ||
      structureShipRecord ||
      this._getActiveShipRecord(session) ||
      null;
    const shipStateSource = shipRecord || {
      itemID: numericShipID,
      typeID: this._getShipTypeID(session),
    };
    const previousFittingSnapshot = getShipFittingSnapshot(charID, numericShipID, {
      shipItem: shipStateSource,
      fittedItems: isStructureHost
        ? listFittedItemsForLocation(numericShipID)
        : undefined,
      reason: "dogma.online.before",
    });
    if (
      !nextOnline &&
      previousOnline &&
      isStructureHost &&
      isStructureServiceModuleItem(moduleItem) &&
      !characterCanDisableStructureServiceModule(
        session,
        moduleItem,
        structureShipRecord,
      )
    ) {
      return {
        success: false,
        errorMsg: "CRP_ACCESS_DENIED",
      };
    }
    if (
      !nextOnline &&
      previousOnline &&
      !isStructureHost &&
      options.refuseCargoOverflow === true
    ) {
      const cargoOverflow = getCargoOverflowWithoutItems(
        previousFittingSnapshot,
        [numericModuleID],
      );
      if (cargoOverflow) {
        return {
          success: false,
          errorMsg: "CARGO_WOULD_OVERFLOW",
          data: cargoOverflow,
        };
      }
    }
    if (nextOnline && !previousOnline) {
      const maxGroupOnlineLimit = resolveMaxGroupOnlineLimit(
        moduleItem,
        previousFittingSnapshot && previousFittingSnapshot.fittedItems,
      );
      if (
        maxGroupOnlineLimit &&
        maxGroupOnlineLimit.onlineGroupCount >= maxGroupOnlineLimit.maxGroupOnline
      ) {
        return {
          success: false,
          errorMsg: "MAX_GROUP_ONLINE",
          data: maxGroupOnlineLimit,
        };
      }
      const onlineCandidate =
        previousFittingSnapshot &&
        previousFittingSnapshot.buildOnlineCandidateResourceState(moduleItem);
      const resourceState =
        onlineCandidate && onlineCandidate.baselineResourceState;
      const moduleResourceLoad =
        onlineCandidate && onlineCandidate.moduleResourceLoad;
      if (!resourceState || !moduleResourceLoad) {
        return {
          success: false,
          errorMsg: "MODULE_NOT_FOUND",
        };
      }
      // A module fitted without its skills (liveFittingState.validateFitForShip) cannot come online: the online
      // effect's own refusal (dogma online.py OnlineEffect.Start, OnlineHasSkillPrerequisites).
      const missingSkills = getMissingRequiredSkills(charID, moduleItem.typeID);
      if (missingSkills.length > 0) {
        return {
          success: false,
          errorMsg: "SKILL_REQUIRED",
          data: { missingSkills },
        };
      }
      // (With what the game's refusal says: the module's need, what the ship has left without it, and its whole
      // output. baseDogma.UserError, eve/common/script/dogma/baseDogma.py 28 to 49.)
      if (onlineCandidate.cpuAfter > resourceState.cpuOutput + 1e-6) {
        return {
          success: false,
          errorMsg: "NOT_ENOUGH_CPU",
          data: onlineShortfall(resourceState.cpuOutput, resourceState.cpuLoad, moduleResourceLoad.cpuLoad),
        };
      }
      if (onlineCandidate.powerAfter > resourceState.powerOutput + 1e-6) {
        return {
          success: false,
          errorMsg: "NOT_ENOUGH_POWER",
          data: onlineShortfall(resourceState.powerOutput, resourceState.powerLoad, moduleResourceLoad.powerLoad),
        };
      }
      if (inSpace && !isStructureHost) {
        const capacitorState = spaceRuntime.getShipCapacitorState(session);
        if (
          !capacitorState ||
          !Number.isFinite(Number(capacitorState.ratio)) ||
          Number(capacitorState.ratio) < (ONLINE_CAPACITOR_CHARGE_RATIO / 100)
        ) {
          return {
            success: false,
            errorMsg: "NOT_ENOUGH_CAPACITOR",
          };
        }
      }
    }
    let fuelConsumptionChanges = [];
    if (
      nextOnline &&
      !previousOnline &&
      isStructureHost &&
      isStructureServiceModuleItem(moduleItem)
    ) {
      if (isStructureDamagedForServiceOnline(structureShipRecord)) {
        return {
          success: false,
          errorMsg: "STRUCTURE_DAMAGED",
        };
      }
      const fuelResult = consumeStructureServiceModuleOnlineFuel(
        numericShipID,
        moduleItem,
      );
      if (!fuelResult || fuelResult.success !== true) {
        return {
          success: false,
          errorMsg:
            fuelResult && fuelResult.errorMsg
              ? fuelResult.errorMsg
              : "NOT_ENOUGH_FUEL",
          data: fuelResult || null,
        };
      }
      fuelConsumptionChanges = Array.isArray(fuelResult.changes)
        ? fuelResult.changes
        : [];
    }
    if (!nextOnline && inSpace) {
      const overloadEffect = spaceRuntime.getOverloadModuleEffect(
        session,
        numericModuleID,
      );
      if (overloadEffect) {
        spaceRuntime.stopOverloadModule(
          session,
          moduleItem,
          overloadEffect.effectID,
          { refreshDerivedState: false, immediate: true },
        );
      }
      const activeEffect = spaceRuntime.getActiveModuleEffect(session, numericModuleID);
      if (activeEffect) {
        if (activeEffect.isGeneric) {
          spaceRuntime.deactivateGenericModule(session, numericModuleID, {
            reason: "offline",
            deferUntilCycle: false,
          });
        } else {
          spaceRuntime.deactivatePropulsionModule(session, numericModuleID, {
            reason: "offline",
          });
        }
      }
    }
    const updateResult = updateInventoryItem(numericModuleID, (currentItem) => ({
      ...currentItem,
      moduleState: {
        ...(currentItem.moduleState || {}),
        online: nextOnline,
      },
    }));
    if (!updateResult.success) {
      return updateResult;
    }
    if (isStructureHost && isStructureServiceModuleItem(updateResult.data)) {
      const syncResult = syncStructureServiceModuleState(numericShipID);
      if (!syncResult || syncResult.success !== true) {
        log.warn(
          `[DogmaIM] structure service module sync failed structure=${numericShipID} module=${numericModuleID} error=${syncResult && syncResult.errorMsg || "UNKNOWN"}`,
        );
      } else {
        if (
          Array.isArray(syncResult.fuelCycleChanges) &&
          syncResult.fuelCycleChanges.length > 0
        ) {
          this._syncInventoryChanges(session, syncResult.fuelCycleChanges);
        }
        if (syncResult.data && syncResult.data.solarSystemID) {
          spaceRuntime.syncStructureSceneState(syncResult.data.solarSystemID, {
            reason: "structureServiceModuleState",
          });
        }
      }
    }
    this._syncInventoryChanges(session, fuelConsumptionChanges);
    invalidateShipFittingSnapshot(charID, numericShipID, {
      shipItem: shipStateSource,
    });
    const refreshedShipStateSource =
      findCharacterShip(charID, numericShipID) ||
      this._getStructureShipMetadataByID(numericShipID) ||
      this._getActiveShipRecord(session) ||
      shipStateSource;
    const nextFittingSnapshot = refreshShipFittingSnapshot(charID, numericShipID, {
      shipItem: refreshedShipStateSource,
      reason: "dogma.online.after",
    });
    // TQ parity: an online/offline toggle is delivered as ONE OnMultiEvent that
    // batches the module's isOnline flip + the ship fitting-resource recalc
    // (powerLoad/cpuLoad/slotsLeft) + the module's online effect start/stop.
    // Decoded from a real Tranquility capture (L6196→L6390; see
    // doc/PARITY_FITTING_NOTIFICATION_SEQUENCE.md). No item move is sent — the
    // module stays in its slot.
    const onlineToggleTime = this._sessionFileTime(session);
    const onlineToggleSubEvents = [];
    const isOnlineAttributeID = getAttributeIDByNames("isOnline");
    if (isOnlineAttributeID && previousOnline !== nextOnline) {
      onlineToggleSubEvents.push(
        buildModuleAttributeChangeEvent(
          charID,
          numericModuleID,
          isOnlineAttributeID,
          nextOnline ? 1 : 0,
          previousOnline ? 1 : 0,
          onlineToggleTime,
        ),
      );
    }
    if (previousFittingSnapshot && nextFittingSnapshot) {
      for (const change of listShipFittingAttributeChanges(
        previousFittingSnapshot,
        nextFittingSnapshot,
      )) {
        onlineToggleSubEvents.push(
          buildModuleAttributeChangeEvent(
            charID,
            numericShipID,
            change.attributeID,
            change.nextValue,
            change.previousValue,
            onlineToggleTime,
          ),
        );
      }
    }
    onlineToggleSubEvents.push(
      buildGodmaShipEffectEvent(
        numericModuleID,
        charID,
        numericShipID,
        EFFECT_ONLINE,
        onlineToggleTime,
        { isStart: nextOnline ? 1 : 0, shouldStart: nextOnline ? 1 : 0 },
      ),
    );
    sendOnMultiEvent(session, onlineToggleSubEvents, onlineToggleTime);
    log.debug(
      `[DogmaIM] SetModuleOnlineState applied shipID=${numericShipID} ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(updateResult.data))} ` +
      `previousOnline=${previousOnline === true} nextOnline=${nextOnline} ` +
      `inSpace=${inSpace}`,
    );
    if (inSpace) {
      if (nextOnline && !previousOnline) {
        spaceRuntime.setShipCapacitorRatio(
          session,
          ONLINE_CAPACITOR_REMAINDER_RATIO / 100,
        );
      }
      spaceRuntime.refreshShipDerivedState(session, {
        broadcast: true,
      });
    }
    return {
      success: true,
      data: updateResult.data,
    };
  },

  _resolveUnloadDestination(destination, session, shipID) {
    const numericShipID = Number(shipID) || this._getShipID(session);
    const destinationValues = extractSequenceValues(destination);
    if (destinationValues.length > 0) {
      let locationID = Number(destinationValues[0]) || 0;
      const flagID = Number(destinationValues[2]) || ITEM_FLAGS.HANGAR;
      // Virtual container IDs (10004 = hangar, 10014 = structure) must be
      // resolved to the player's actual docked station/structure ID so items
      // are stored at the correct location rather than the abstract constant.
      if (locationID === 10004 || locationID === 10014) {
        locationID = getDockedLocationID(session) || this._getLocationID(session);
      }
      // The middle value is the owner the client names (invControllers AddItems 515 to 517: the pilot where the
      // flag is flagHangar, else the container's owner): the corporation for its hangar, the office, which
      // StationCorpHangar's UnloadAmmoToContainer names as (officeID, the office's owner, the division's flag).
      return {
        locationID,
        flagID,
        office: this._getSessionCorporationOffice(session, locationID),
        ownerID: this._resolveUnloadDestinationOwnerID(session, locationID, destinationValues[1]),
      };
    }
    const numericDestination = Number(destination) || 0;
    if (numericDestination === numericShipID) {
      return {
        locationID: numericShipID,
        flagID: ITEM_FLAGS.CARGO_HOLD,
      };
    }
    // An office of the session's corporation named alone: clientDogmaLocation.UnloadModuleToContainer
    // (1077 to 1104) names the container's item and no flag before the module goes into a division
    // (UnloadAmmo(ship, module, officeID), then Add with the division's flag). Which division a loaded
    // module's charges land in no recording shows; here the first, the corporation's.
    const office = this._getSessionCorporationOffice(session, numericDestination);
    if (office) {
      return {
        locationID: numericDestination,
        flagID: FIRST_CORP_HANGAR_DIVISION_FLAG,
        office,
        ownerID: this._getSessionCorporationID(session),
      };
    }
    return {
      locationID: numericDestination || this._getLocationID(session),
      flagID: ITEM_FLAGS.HANGAR,
    };
  },

  _getSessionCorporationID(session) {
    return Number(session && (session.corporationID || session.corpid)) || 0;
  },

  // The session's corporation's office whose inventory this is (an office's itemID is its inventory), or null.
  _getSessionCorporationOffice(session, inventoryID) {
    const corporationID = this._getSessionCorporationID(session);
    const numericInventoryID = Number(inventoryID) || 0;
    if (corporationID <= 0 || numericInventoryID <= 0) {
      return null;
    }
    const { getCorporationOfficeByInventoryID } = require(path.join(
      __dirname,
      "../../corporation/corporationRuntimeState",
    ));
    return getCorporationOfficeByInventoryID(corporationID, numericInventoryID) || null;
  },

  // The owner an unloaded charge takes: the corporation where the call names it and the place is the
  // corporation's (its office, or a container of its own); otherwise the charge keeps its owner (null).
  _resolveUnloadDestinationOwnerID(session, locationID, namedOwnerID) {
    const corporationID = this._getSessionCorporationID(session);
    if (corporationID <= 0 || (Number(namedOwnerID) || 0) !== corporationID) {
      return null;
    }
    if (this._getSessionCorporationOffice(session, locationID)) {
      return corporationID;
    }
    const container = findItemById(Number(locationID) || 0);
    return container && Number(container.ownerID) === corporationID ? corporationID : null;
  },

  // A division of the office takes what the session may see in it, as invBroker's Add into a division
  // checks (_hasLocalCorporationOfficeDivisionQueryAccess): Director, or the division's query role. A flag
  // that is no division is refused.
  _canPutIntoCorporationOfficeDivision(session, flagID) {
    const requiredRole = CORP_HANGAR_DIVISION_QUERY_ROLE_BY_FLAG.get(Number(flagID) || 0);
    if (!requiredRole) {
      return false;
    }
    const roleMask = getSessionCorporationRoleMask(session);
    return (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR || (roleMask & requiredRole) === requiredRole;
  },

  _resolveAmmoLocationID(ammoLocationID, session, shipID) {
    const numericShipID = Number(shipID) || this._getShipID(session);
    const numericLocationID = Number(ammoLocationID) || numericShipID;
    if (numericLocationID === 10004 || numericLocationID === 10014) {
      return getDockedLocationID(session) || this._getLocationID(session) || numericLocationID;
    }
    return numericLocationID;
  },

  // --- where an ammunition call may reach -----------------------------------
  // LoadAmmo and UnloadAmmo name a ship, and a place the charges come from or go
  // to. The client only ever names the ship it is flying, or the structure it
  // controls, and places beside it. Nothing held a call to them: the owner
  // checks in the handlers pass for anything of the caller's own, wherever it
  // is, so a pilot could load from and unload to any station, and into any
  // ship or slot.

  // The ship is the one the session is flying. A call naming any other, or from
  // a session flying none, is refused; a call naming none acts on the session's.
  _resolveAmmoCallShipID(args, session) {
    // _getShipID answers a placeholder ship for a session with none of its own.
    const fliesAShip = Number(
      session && (session.activeShipID || session.shipID || session.shipid),
    ) > 0;
    const sessionShipID = fliesAShip ? Number(this._getShipID(session)) || 0 : 0;
    const namedShipID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    if (sessionShipID <= 0 || (namedShipID > 0 && namedShipID !== sessionShipID)) {
      throwWrappedUserError("ShipNotHere");
    }
    return sessionShipID;
  },

  // A place for charges is in reach when it is that ship, the station or
  // structure the session is docked in, or something of the pilot's own (or of
  // its corporation) that sits directly in one of those: a container in the
  // hangar or in the hold.
  // UnloadAmmo alone (options.office) may also reach the office of the session's corporation in the station or
  // structure it is docked in: the corporation's hangar, which the client unloads into (AddItems 509 to 517). LoadAmmo
  // does not take from it here, as nothing here checks the division's take role.
  _assertAmmoPlaceInReach(locationID, session, shipID, options = {}) {
    const numericLocationID = Number(locationID) || 0;
    const dockedLocationID = getDockedLocationID(session);
    const isBesideTheSession = (candidateID) => (
      candidateID > 0 &&
      (candidateID === shipID || candidateID === dockedLocationID)
    );
    if (isBesideTheSession(numericLocationID)) {
      return;
    }
    const office = options && options.office;
    if (
      office &&
      !office.impounded &&
      Number(dockedLocationID) > 0 &&
      Number(office.stationID) === Number(dockedLocationID)
    ) {
      return;
    }
    const container = numericLocationID > 0 ? findItemById(numericLocationID) : null;
    const containerOwnerID = Number(container && container.ownerID) || 0;
    const corporationID =
      Number(session && (session.corporationID || session.corpid)) || 0;
    if (
      container &&
      containerOwnerID > 0 &&
      (containerOwnerID === this._getCharID(session) || containerOwnerID === corporationID) &&
      isBesideTheSession(Number(container.locationID) || 0)
    ) {
      return;
    }
    throwWrappedUserError("GenericTooFarAway");
  },

  _normalizeEffectName(rawEffectName) {
    if (typeof rawEffectName === "string") {
      return rawEffectName;
    }
    if (Buffer.isBuffer(rawEffectName)) {
      return rawEffectName.toString("utf8");
    }
    if (rawEffectName === undefined || rawEffectName === null) {
      return "";
    }
    return String(rawEffectName);
  },

  _normalizeActivationEffectName(rawEffectName) {
    const normalized = this._normalizeEffectName(rawEffectName).trim().toLowerCase();
    switch (normalized) {
      case "online":
        return "online";
      case "901":
      case "onlineforstructures":
      case "effectonlineforstructures":
      case "effects.structureonline":
        return "onlineForStructures";
      case "dohacking":
        return "doHacking";
      case "usemissiles":
        return "useMissiles";
      case "anchordrop":
      case "effects.anchordrop":
        return "anchorDrop";
      case "anchorlift":
      case "effects.anchorlift":
        return "anchorLift";
      case "1022":
      case "effectanchordropforstructures":
      case "anchordropforstructures":
        return "anchorDropForStructures";
      case "1023":
      case "effectanchorliftforstructures":
      case "anchorliftforstructures":
        return "anchorLiftForStructures";
      case "modulebonusafterburner":
      case "effectmodulebonusafterburner":
      case "effects.afterburner":
      case "dogmaxp.afterburner":
      case "afterburner":
        return "moduleBonusAfterburner";
      case "modulebonusmicrowarpdrive":
      case "effectmodulebonusmicrowarpdrive":
      case "effects.microwarpdrive":
      case "dogmaxp.microwarpdrive":
      case "microwarpdrive":
      case "mwd":
        return "moduleBonusMicrowarpdrive";
      default:
        return normalized;
    }
  },

  _resolveAmmoSourceStacks(charID, ammoLocationID, sourceFlagID, chargeTypeID, chargeRequests = []) {
    const explicitItemIDs = new Set(
      chargeRequests
        .map((request) => Number(request && request.itemID) || 0)
        .filter((itemID) => itemID > 0),
    );
    const requestedTypeIDs = new Set(
      chargeRequests
        .map((request) => Number(request && request.typeID) || 0)
        .filter((typeID) => typeID > 0),
    );
    const normalizedChargeTypeID = Number(chargeTypeID) || 0;
    const locationItems = listContainerItems(charID, ammoLocationID, sourceFlagID)
      .filter((item) => Number(item.typeID) === normalizedChargeTypeID)
      .filter((item) => (Number(item.stacksize || item.quantity || 0) || 0) > 0);
    if (explicitItemIDs.size > 0) {
      const explicitMatches = locationItems
        .filter((item) => explicitItemIDs.has(Number(item.itemID) || 0))
        .sort((left, right) => (Number(left.itemID) || 0) - (Number(right.itemID) || 0));
      if (explicitMatches.length > 0) {
        return explicitMatches;
      }
      if (requestedTypeIDs.size > 0 && !requestedTypeIDs.has(normalizedChargeTypeID)) {
        return [];
      }
    }
    if (requestedTypeIDs.size > 0 && !requestedTypeIDs.has(normalizedChargeTypeID)) {
      return [];
    }
    return locationItems.sort(
      (left, right) => (Number(left.itemID) || 0) - (Number(right.itemID) || 0),
    );
  },

  // A LoadAmmo covering several launchers (a weapon group) shares the charges out
  // evenly rather than filling launchers in turn, and loads nothing when it cannot
  // give every launcher at least one more; the client's message for that is
  // CannotLoadNotEnoughCharges. Runs before anything moves, so a refused reload
  // leaves every launcher as it was. Returns chargeTypeID -> level to fill to; a
  // single launcher gets no entry and keeps the plain fill-to-capacity.
  _resolveGroupedLoadAmmoLevels(moduleIDs, context) {
    const {
      shipID,
      inventoryOwnerID,
      sourceOwnerID,
      ammoLocationID,
      sourceFlagID,
      chargeRequests,
    } = context;
    const modulesByChargeTypeID = new Map();
    const requestedChargeTypeID = this._resolveRequestedAmmoTypeID(
      sourceOwnerID,
      ammoLocationID,
      sourceFlagID,
      chargeRequests,
    );
    for (const moduleID of moduleIDs) {
      const moduleItem = findItemById(moduleID);
      if (
        !moduleItem ||
        Number(moduleItem.ownerID) !== inventoryOwnerID ||
        Number(moduleItem.locationID) !== shipID
      ) {
        continue;
      }
      const existingCharge = getLoadedChargeByFlag(inventoryOwnerID, shipID, moduleItem.flagID);
      const chargeTypeID =
        requestedChargeTypeID > 0
          ? requestedChargeTypeID
          : Number(existingCharge && existingCharge.typeID) || 0;
      if (chargeTypeID <= 0 || !isChargeCompatibleWithModule(moduleItem.typeID, chargeTypeID)) {
        continue;
      }
      if (!modulesByChargeTypeID.has(chargeTypeID)) {
        modulesByChargeTypeID.set(chargeTypeID, []);
      }
      modulesByChargeTypeID.get(chargeTypeID).push(moduleItem);
    }
    const levels = new Map();
    for (const [chargeTypeID, moduleItems] of modulesByChargeTypeID) {
      if (moduleItems.length <= 1) {
        continue;
      }
      const reserveQuantity = this._resolveAmmoSourceStacks(
        sourceOwnerID,
        ammoLocationID,
        sourceFlagID,
        chargeTypeID,
        chargeRequests,
      ).reduce((sum, item) => sum + (Number(item.stacksize || item.quantity || 0) || 0), 0);
      const { level, heldQuantities, capacity } = this.resolveGroupedReloadLevel(
        moduleItems,
        chargeTypeID,
        reserveQuantity,
        inventoryOwnerID,
        shipID,
      );
      const wantsCharges = heldQuantities.some((held) => held < capacity);
      const gainsCharges = heldQuantities.some((held) => held < level);
      if (reserveQuantity > 0 && wantsCharges && !gainsCharges) {
        log.info(
          `[DogmaIM] LoadAmmo: ${reserveQuantity}x typeID=${chargeTypeID} cannot be shared across ${moduleItems.length} grouped modules (held=[${heldQuantities}])`,
        );
        throwWrappedUserError("CannotLoadNotEnoughCharges");
      }
      levels.set(chargeTypeID, level);
    }
    return levels;
  },

  // The hold of the ship the first charge named lies in (not a slot: a loaded charge is no source); the cargo where
  // none named is in the ship.
  _resolveAmmoSourceHoldFlag(shipID, chargeRequests = []) {
    for (const request of chargeRequests) {
      const item = findItemById(Number(request && request.itemID) || 0);
      if (item && Number(item.locationID) === Number(shipID) && !isShipFittingFlag(Number(item.flagID))) {
        return Number(item.flagID) || ITEM_FLAGS.CARGO_HOLD;
      }
    }
    return ITEM_FLAGS.CARGO_HOLD;
  },

  _resolveRequestedAmmoTypeID(charID, ammoLocationID, sourceFlagID, chargeRequests = []) {
    for (const request of chargeRequests) {
      const itemID = Number(request && request.itemID) || 0;
      if (itemID <= 0) {
        continue;
      }
      const candidate = findItemById(itemID);
      if (
        candidate &&
        Number(candidate.ownerID) === charID
      ) {
        if (
          Number(candidate.locationID) === ammoLocationID &&
          Number(candidate.flagID) === sourceFlagID
        ) {
          return Number(candidate.typeID) || 0;
        }
        if (Number(candidate.typeID) > 0) {
          return Number(candidate.typeID) || 0;
        }
      }
    }
    for (const request of chargeRequests) {
      const typeID = Number(request && request.typeID) || 0;
      if (typeID > 0) {
        return typeID;
      }
    }
    return 0;
  },

  Handle_Activate(args, session) {
    const requestedItemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const effectName = this._normalizeActivationEffectName(
      args && args.length > 1 ? args[1] : "",
    );
    const targetID = args && args.length > 2 ? args[2] : null;
    const repeat = args && args.length > 3 ? args[3] : null;
    const requestedItem = findItemById(requestedItemID);
    const groupedMasterModuleID =
      requestedItem &&
      Number(requestedItem.categoryID) === 7
        ? getWeaponBankMasterModuleID(
          Number(requestedItem.locationID) || this._getShipID(session),
          requestedItemID,
        )
        : 0;
    const itemID = groupedMasterModuleID || requestedItemID;
    const item = groupedMasterModuleID > 0
      ? findItemById(itemID)
      : requestedItem;
    log.debug(
      `[DogmaIM] Activate(itemID=${itemID}, effect=${effectName}, target=${String(targetID)}, repeat=${String(repeat)}) ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} inSpace=${Boolean(session && session._space)}`,
    );
    if (effectName === "onlineForStructures") {
      if (
        requestedItem &&
        Number(requestedItem.categoryID) === 23 &&
        Number(requestedItem.groupID) !== 365
      ) {
        const result = require(path.join(
          __dirname,
          "../../starbase/starbaseModuleRuntime",
        )).setOnlineState(session, requestedItemID, true);
        if (!result.success) {
          this._throwCustomNotifyUserError(
            this._formatStarbaseModuleUserError(result.errorMsg, result.data),
          );
        }
        return 1;
      }
      return this._handleControlTowerOnlineActivation(
        requestedItemID,
        session,
      );
    }
    if (effectName === "online") {
      const shipID = Number(item && item.locationID) || this._getShipID(session);
      const result = this._setModuleOnlineState(shipID, itemID, true, session);
      if (!result.success) {
        log.warn(
          `[DogmaIM] Activate online rejected itemID=${itemID} shipID=${shipID} error=${result.errorMsg}`,
        );
        this._throwModuleOnlineUserError(result.errorMsg, item, result.data);
      }
      return 1;
    }
    if (effectName === "anchorDrop" || effectName === "anchorLift") {
      if (
        requestedItem &&
        Number(requestedItem.categoryID) === 23 &&
        Number(requestedItem.groupID) === 365
      ) {
        return this._handleControlTowerAnchorActivation(
          requestedItemID,
          effectName === "anchorDrop"
            ? "anchorDropForStructures"
            : "anchorLiftForStructures",
          session,
        );
      }
      return this._handleCargoContainerAnchorActivation(
        requestedItemID,
        effectName,
        session,
      );
    }
    if (
      effectName === "anchorDropForStructures" ||
      effectName === "anchorLiftForStructures"
    ) {
      if (
        requestedItem &&
        Number(requestedItem.categoryID) === 23 &&
        Number(requestedItem.groupID) !== 365
      ) {
        const result = require(path.join(
          __dirname,
          "../../starbase/starbaseModuleRuntime",
        )).startAnchorTransition(session, requestedItemID, effectName);
        if (!result.success) {
          this._throwCustomNotifyUserError(
            this._formatStarbaseModuleUserError(result.errorMsg, result.data),
          );
        }
        return 1;
      }
      return this._handleControlTowerAnchorActivation(
        requestedItemID,
        effectName,
        session,
      );
    }
    if (item && Number(item.categoryID) === 23) {
      const control = require("../../starbase/starbaseControlRuntime");
      const result = control.activateControlledBattery(session, itemID, effectName, Number(targetID));
      if (!result.success && !String(result.errorMsg || "").startsWith("STARBASE_")) {
        this._throwModuleActivationUserError(result.errorMsg, { session, moduleItem: item, effectName, ...(result.data || {}) });
      }
      control.requireStarbaseControlResult(result);
      return 1;
    }
    if (!item || !isEffectivelyOnlineModule(item)) {
      log.warn(
        `[DogmaIM] Activate rejected itemID=${itemID} effect=${effectName} error=MODULE_NOT_ONLINE`,
      );
      this._throwModuleActivationUserError("MODULE_NOT_ONLINE", {
        session,
        moduleItem: item || requestedItem,
        effectName,
      });
    }
    // Propulsion modules (AB/MWD) use the dedicated propulsion path which
    // applies speed/mass bonuses.  All other activatable modules use the
    // generic path that provides cycle timing for the HUD radial ring.
    const isPropulsion =
      effectName === "moduleBonusAfterburner" ||
      effectName === "moduleBonusMicrowarpdrive";
    const isProbeLauncherActivation =
      effectName === "useMissiles" &&
      item &&
      Number(item.groupID) === GROUP_SCAN_PROBE_LAUNCHER;
    const isSurveyProbeLauncherActivation =
      effectName === "useMissiles" &&
      item &&
      Number(item.groupID) === GROUP_SURVEY_PROBE_LAUNCHER;
    const isInterdictionProbeLauncherActivation =
      effectName === "useMissiles" &&
      item &&
      Number(item.groupID) === GROUP_INTERDICTION_SPHERE_LAUNCHER;
    const isWarpDisruptFieldGeneratorActivation =
      item &&
      Number(item.groupID) === GROUP_WARP_DISRUPT_FIELD_GENERATOR &&
      warpDisruptFieldGeneratorRuntime.isWarpDisruptFieldGeneratorActivation(
        item,
        effectName,
      );
    const isAnalyzerActivation = this._isAnalyzerModuleActivation(item, effectName);
    const probeLaunchContext = isProbeLauncherActivation
      ? this._resolveValidatedProbeLaunchContext(session, itemID, 1, {
          // Retail treats clicking the fitted core/combat launcher as the same
          // launch-to-cap action exposed by the Probe Scanner window.
          launchToCapacity: true,
        })
      : null;
    const surveyProbeLaunchContext = isSurveyProbeLauncherActivation
      ? this._resolveValidatedSurveyProbeLaunchContext(session, itemID)
      : null;
    const interdictionProbeLaunchContext = isInterdictionProbeLauncherActivation
      ? this._resolveValidatedInterdictionProbeLaunchContext(session, itemID)
      : null;
    if (isWarpDisruptFieldGeneratorActivation) {
      this._resolveValidatedWarpDisruptFieldGeneratorContext(session, item);
    }
    const analyzerHackingContext = isAnalyzerActivation
      ? this._resolveAnalyzerHackingContext(session, item, targetID)
      : null;
    if (analyzerHackingContext && analyzerHackingContext.success !== true) {
      log.debug(
        `[DogmaIM] Activate analyzer rejected itemID=${itemID} target=${String(targetID)} ` +
        `error=${analyzerHackingContext.errorMsg}`,
      );
      this._throwModuleActivationUserError(analyzerHackingContext.errorMsg, {
        session,
        moduleItem: item || requestedItem,
        targetID,
        effectName,
      });
    }
    if (isProbeLauncherActivation) {
      this._refreshScannerProbeLauncherClientState(
        session,
        Number(item && item.locationID) || this._getShipID(session),
        item,
        {
          forceRuntimeSync: true,
        },
      );
    }
    const activationRepeat =
      isProbeLauncherActivation ||
      isSurveyProbeLauncherActivation ||
      isInterdictionProbeLauncherActivation ||
      isAnalyzerActivation
        ? 1
        : repeat;
    const result = isPropulsion
      ? spaceRuntime.activatePropulsionModule(session, item, effectName, {
          targetID,
          repeat: activationRepeat,
        })
      : spaceRuntime.activateGenericModule(session, item, effectName, {
          targetID,
          repeat: activationRepeat,
        });
    if (!result.success) {
      log.warn(
        `[DogmaIM] Activate rejected itemID=${itemID} effect=${effectName} error=${result.errorMsg}`,
      );
      this._throwModuleActivationUserError(result.errorMsg, {
        session,
        moduleItem: item || requestedItem,
        targetID,
        effectName,
        errorData: result.data || null,
      });
    }
    if (isProbeLauncherActivation) {
      if (result && result.data && result.data.effectState) {
        // CCP parity: scan-probe launchers are still a one-shot server cycle,
        // but the client button/radial behaves much better when the wire
        // contract stays on the launcher's normal repeatable cycle shape.
        // Keep the server-side auto-stop, but do not collapse the live client
        // effect row down to repeat=0.
        result.data.effectState.autoDeactivateAtCycleEnd = true;
        result.data.effectState.consequenceDelivery = "managed";
        result.data.effectState.repeat = 1;
        result.data.effectState.stopReason = "cycle";
      }
      try {
        this._launchProbesFromContext(session, probeLaunchContext);
        this._refreshScannerProbeLauncherClientState(
          session,
          Number(item && item.locationID) || this._getShipID(session),
          item,
          {
            forceRuntimeSync: true,
          },
        );
      } catch (error) {
        spaceRuntime.deactivateGenericModule(session, itemID, {
          reason: "probe-launch-failed",
        });
        throw error;
      }
    }
    if (isSurveyProbeLauncherActivation) {
      if (result && result.data && result.data.effectState) {
        result.data.effectState.autoDeactivateAtCycleEnd = true;
        result.data.effectState.consequenceDelivery = "managed";
        result.data.effectState.repeat = 1;
        result.data.effectState.stopReason = "cycle";
      }
      try {
        this._launchSurveyProbeFromContext(
          session,
          surveyProbeLaunchContext,
        );
      } catch (error) {
        spaceRuntime.deactivateGenericModule(session, itemID, {
          reason: "survey-probe-launch-failed",
        });
        throw error;
      }
    }
    if (isInterdictionProbeLauncherActivation) {
      if (result && result.data && result.data.effectState) {
        result.data.effectState.autoDeactivateAtCycleEnd = true;
        result.data.effectState.consequenceDelivery = "managed";
        result.data.effectState.repeat = 1;
        result.data.effectState.stopReason = "cycle";
      }
      try {
        this._launchInterdictionProbeFromContext(
          session,
          interdictionProbeLaunchContext,
        );
      } catch (error) {
        spaceRuntime.deactivateGenericModule(session, itemID, {
          reason: "interdiction-probe-launch-failed",
        });
        throw error;
      }
    }
    if (isAnalyzerActivation && analyzerHackingContext && analyzerHackingContext.success === true) {
      const contextData = analyzerHackingContext.data || {};
      try {
        const hackingMgr = new HackingMgrService();
        hackingMgr.startAnalyzerAttempt(session, contextData);
        if (result && result.data && result.data.effectState) {
          result.data.effectState.autoDeactivateAtCycleEnd = true;
          result.data.effectState.consequenceDelivery = "managed";
          result.data.effectState.repeat = 1;
          result.data.effectState.stopReason = "cycle";
        }
      } catch (error) {
        spaceRuntime.deactivateGenericModule(session, itemID, {
          reason: "analyzer-hacking-start-failed",
        });
        throw error;
      }
    }
    log.debug(
      `[DogmaIM] Activate accepted itemID=${itemID} effect=${effectName} ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} ` +
      `runtime=${JSON.stringify(
        summarizeRuntimeEffectForLog(
          session && session._space
            ? spaceRuntime.getActiveModuleEffect(session, itemID)
            : null,
        ),
      )}`,
    );
    if (session?._space && [1957, 30328].includes(Number(item.typeID))) {
      const target = spaceRuntime.getSceneForSession(session)?.getEntityByID(Number(targetID));
      require("../../nodegraph/nodeGraphEvents").publish(session, "inventory.module-activated", { typeID: item.typeID, target });
    }
    return 1;
  },

  Handle_Deactivate(args, session) {
    const requestedItemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const effectName = this._normalizeActivationEffectName(
      args && args.length > 1 ? args[1] : "",
    );
    const requestedItem = findItemById(requestedItemID);
    const groupedMasterModuleID =
      requestedItem &&
      Number(requestedItem.categoryID) === 7
        ? getWeaponBankMasterModuleID(
          Number(requestedItem.locationID) || this._getShipID(session),
          requestedItemID,
        )
        : 0;
    const itemID = groupedMasterModuleID || requestedItemID;
    const item = groupedMasterModuleID > 0
      ? findItemById(itemID)
      : requestedItem;
    log.debug(
      `[DogmaIM] Deactivate(itemID=${itemID}, effect=${effectName}) ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} inSpace=${Boolean(session && session._space)}`,
    );
    if (effectName === "onlineForStructures") {
      if (
        requestedItem &&
        Number(requestedItem.categoryID) === 23 &&
        Number(requestedItem.groupID) !== 365
      ) {
        const result = require(path.join(
          __dirname,
          "../../starbase/starbaseModuleRuntime",
        )).setOnlineState(session, requestedItemID, false);
        if (!result.success) {
          this._throwCustomNotifyUserError(
            this._formatStarbaseModuleUserError(result.errorMsg, result.data),
          );
        }
        return 1;
      }
      const {
        setControlTowerOffline,
      } = require(path.join(__dirname, "../../ship/controlTowerRuntime"));
      const result = setControlTowerOffline(session, requestedItemID);
      if (!result.success) {
        log.warn(
          `[DogmaIM] Control tower offline activation rejected itemID=${requestedItemID} ` +
          `error=${result.errorMsg}`,
        );
        this._throwCustomNotifyUserError(
          this._formatControlTowerOnlineUserError(result.errorMsg),
        );
      }
      return 1;
    }
    if (effectName === "online") {
      const item = findItemById(itemID);
      const shipID = Number(item && item.locationID) || this._getShipID(session);
      const result = this._setModuleOnlineState(shipID, itemID, false, session, {
        refuseCargoOverflow: true,
      });
      if (!result.success) {
        log.warn(
          `[DogmaIM] Deactivate online rejected itemID=${itemID} shipID=${shipID} error=${result.errorMsg}`,
        );
        this._throwModuleOnlineUserError(result.errorMsg, item, result.data);
      }
      return 1;
    }
    const isPropulsion =
      effectName === "moduleBonusAfterburner" ||
      effectName === "moduleBonusMicrowarpdrive";
    if (item && Number(item.categoryID) === 23) {
      const control = require("../../starbase/starbaseControlRuntime");
      control.requireStarbaseControlResult(control.deactivateControlledBattery(session, itemID, effectName));
      return 1;
    }
    const result = isPropulsion
      ? spaceRuntime.deactivatePropulsionModule(session, itemID, {
          reason: "manual",
        })
      : spaceRuntime.deactivateGenericModule(session, itemID, {
          reason: "manual",
        });
    if (!result.success) {
      log.warn(
        `[DogmaIM] Deactivate rejected itemID=${itemID} effect=${effectName} error=${result.errorMsg}`,
      );
      this._throwModuleDeactivationUserError(result.errorMsg, item || requestedItem);
    }
    log.debug(
      `[DogmaIM] Deactivate accepted itemID=${itemID} effect=${effectName} ` +
      `module=${JSON.stringify(summarizeModuleItemForLog(item))} ` +
      `runtime=${JSON.stringify(
        summarizeRuntimeEffectForLog(
          session && session._space
            ? spaceRuntime.getActiveModuleEffect(session, itemID)
            : null,
        ),
      )}`,
    );
    return 1;
  },

  Handle_SetModuleOnline(args, session) {
    const shipID = args && args.length > 0 ? args[0] : this._getShipID(session);
    const moduleID = args && args.length > 1 ? args[1] : null;
    log.debug(`[DogmaIM] SetModuleOnline(shipID=${shipID}, moduleID=${moduleID})`);
    const result = this._setModuleOnlineState(shipID, moduleID, true, session);
    if (!result.success) {
      log.debug(`[DogmaIM] SetModuleOnline rejected moduleID=${moduleID} error=${result.errorMsg}`);
      this._throwModuleOnlineUserError(
        result.errorMsg,
        findItemById(moduleID),
        result.data,
      );
    }
    return null;
  },

  Handle_TakeModuleOffline(args, session) {
    const shipID = args && args.length > 0 ? args[0] : this._getShipID(session);
    const moduleID = args && args.length > 1 ? args[1] : null;
    log.debug(`[DogmaIM] TakeModuleOffline(shipID=${shipID}, moduleID=${moduleID})`);
    const result = this._setModuleOnlineState(shipID, moduleID, false, session, {
      refuseCargoOverflow: true,
    });
    if (!result.success) {
      this._throwModuleOnlineUserError(
        result.errorMsg,
        findItemById(moduleID),
        result.data,
      );
    }
    return null;
  },

  Handle_LaunchProbes(args, session) {
    const moduleID = args && args.length > 0
      ? Number(args[0]) || 0
      : 0;
    const requestedCount = Math.max(
      1,
      Number(args && args.length > 1 ? args[1] : 1) || 1,
    );
    const shipID = this._getShipID(session);
    const charID = this._getCharID(session);
    const systemID = Number(
      (session && session.solarsystemid2) ||
      (session && session.solarsystemid) ||
      (session && session._space && session._space.systemID) ||
      0,
    ) || 0;
    log.info(
      `[DogmaIM] LaunchProbes(moduleID=${moduleID}, requestedCount=${requestedCount}, shipID=${shipID}, charID=${charID}, systemID=${systemID})`,
    );
    const probeLaunchContext = this._resolveValidatedProbeLaunchContext(
      session,
      moduleID,
      requestedCount,
    );
    this._launchProbesFromContext(session, probeLaunchContext);
    return null;
  },

  Handle_LoadAmmo(args, session) {
    const shipID = this._resolveAmmoCallShipID(args, session);
    const rawModuleIDs = args && args.length > 1 ? args[1] : [];
    const rawChargeItemIDs = args && args.length > 2 ? args[2] : [];
    const rawAmmoLocationID = args && args.length > 3 ? Number(args[3]) || shipID : shipID;
    const ammoLocationID = this._resolveAmmoLocationID(rawAmmoLocationID, session, shipID);
    this._assertAmmoPlaceInReach(ammoLocationID, session, shipID);
    const charID = this._getCharID(session);
    const inventoryOwnerID = this._getDogmaInventoryOwnerID(session, shipID);
    const sourceOwnerID = this._getDogmaInventoryOwnerID(session, ammoLocationID);
    const moduleIDs = this._expandGroupedModuleIDs(shipID, rawModuleIDs);
    const chargeRequests = normalizeAmmoLoadRequests(rawChargeItemIDs);
    log.info(
      `[DogmaIM] LoadAmmo(shipID=${shipID}, modules=[${moduleIDs}], charges=[${summarizeAmmoLoadRequests(chargeRequests)}], ammoLocationID=${ammoLocationID})`,
    );
    // Where the charges lie: the hangar where the pilot is docked, or a hold of the ship. The client names the ship
    // for every hold of it (DropLoadChargeToModule: chargeItems[0].locationID, then LoadChargesToModule's LoadAmmo),
    // so the hold is the one the charges named lie in, and the cargo where none named lies in one.
    const sourceFlagID = ammoLocationID === shipID
      ? this._resolveAmmoSourceHoldFlag(shipID, chargeRequests)
      : ITEM_FLAGS.HANGAR;
    // One docked fitting refresh for the whole call instead of one per source
    // stack inside the per-module loop, mirroring Handle_UnloadAmmo. Retail
    // sends zero fitting rows for a docked top-up.
    const deferredDockedFittingChanges = [];
    const groupedLevels = this._resolveGroupedLoadAmmoLevels(
      moduleIDs.map((value) => Number(value) || 0).filter((value) => value > 0),
      {
        shipID,
        inventoryOwnerID,
        sourceOwnerID,
        ammoLocationID,
        sourceFlagID,
        chargeRequests,
      },
    );
    try {
      for (const moduleID of moduleIDs.map((value) => Number(value) || 0).filter((value) => value > 0)) {
        const moduleItem = findItemById(moduleID);
        if (
          !moduleItem ||
          Number(moduleItem.ownerID) !== inventoryOwnerID ||
          Number(moduleItem.locationID) !== shipID
        ) {
          log.warn(
            `[DogmaIM] LoadAmmo: module ${moduleID} not found or not owned (owner=${moduleItem && moduleItem.ownerID}, loc=${moduleItem && moduleItem.locationID}, inventoryOwnerID=${inventoryOwnerID}, charID=${charID}, shipID=${shipID})`,
          );
          continue;
        }
        const previousChargeState = this._captureChargeStateSnapshot(
          inventoryOwnerID,
          shipID,
          moduleItem.flagID,
        );
        const previousChargeItem = this._captureChargeItemSnapshot(
          inventoryOwnerID,
          shipID,
          moduleItem.flagID,
        );
        try {
          let existingCharge = getLoadedChargeByFlag(
            inventoryOwnerID,
            shipID,
            moduleItem.flagID,
          );
          let activeChargeTypeID = existingCharge ? Number(existingCharge.typeID) || 0 : 0;
          let requestedChargeTypeID = this._resolveRequestedAmmoTypeID(
            sourceOwnerID,
            ammoLocationID,
            sourceFlagID,
            chargeRequests,
          );
          if (requestedChargeTypeID <= 0 && activeChargeTypeID > 0) {
            requestedChargeTypeID = activeChargeTypeID;
          }
          if (requestedChargeTypeID <= 0) {
            log.warn(
              `[DogmaIM] LoadAmmo: no valid charge found for module ${moduleID} (flag=${moduleItem.flagID}) in location ${ammoLocationID} requests=[${summarizeAmmoLoadRequests(chargeRequests)}]`,
            );
            continue;
          }
          const chargeTypeID = requestedChargeTypeID;
          if (!isChargeCompatibleWithModule(moduleItem.typeID, chargeTypeID)) {
            log.warn(
              `[DogmaIM] LoadAmmo: incompatible charge typeID=${chargeTypeID} for module ${moduleID} typeID=${moduleItem.typeID}`,
            );
            continue;
          }
          const moduleCapacity = groupedLevels.has(chargeTypeID)
            ? groupedLevels.get(chargeTypeID)
            : getModuleChargeCapacity(moduleItem.typeID, chargeTypeID);
          const existingQuantity = existingCharge
            ? Number(existingCharge.stacksize || existingCharge.quantity || 0) || 0
            : 0;
          const resolvedChargeSources = this._resolveAmmoSourceStacks(
            sourceOwnerID,
            ammoLocationID,
            sourceFlagID,
            chargeTypeID,
            chargeRequests,
          );
          // Resolved once per module: this now composes the module against its host's dogma, and
          // the four places below used to ask for it three separate times per module.
          const moduleReloadTimeMs = this._getModuleReloadTimeMs(session, moduleItem);
          if (session && session._space && moduleReloadTimeMs > 0) {
            if (
              existingCharge &&
              activeChargeTypeID === chargeTypeID &&
              existingQuantity >= moduleCapacity
            ) {
              continue;
            }
            if (
              resolvedChargeSources.length === 0 &&
              !(existingCharge && activeChargeTypeID === chargeTypeID)
            ) {
              log.warn(
                `[DogmaIM] LoadAmmo: no source stacks resolved for reload module ${moduleID} typeID=${chargeTypeID} in location ${ammoLocationID}`,
              );
              continue;
            }
            this._queuePendingModuleReload(session, moduleItem, {
              action: "load",
              shipID,
              chargeTypeID,
              ammoLocationID,
              sourceFlagID,
              inventoryOwnerID,
              sourceOwnerID,
              sourceItemIDs: resolvedChargeSources.map((item) => item.itemID),
              reloadTimeMs: moduleReloadTimeMs,
              targetQuantity: groupedLevels.get(chargeTypeID),
            });
            continue;
          }
          if (existingCharge && activeChargeTypeID !== chargeTypeID) {
            const unloadResult = this._moveLoadedChargeToDestination(
              existingCharge,
              ammoLocationID,
              sourceFlagID,
            );
            if (unloadResult.success) {
              this._syncInventoryChanges(session, unloadResult.data.changes, {
                deferredDockedFittingChanges,
              });
            }
            existingCharge = null;
            activeChargeTypeID = 0;
          }
          // Re-read current charge state after potential unload so that modules
          // with capacity 1 (crystals, lenses, scripts) correctly compute the
          // needed quantity instead of using the stale pre-unload count.
          const currentChargeQuantity = existingCharge
            ? Number(existingCharge.stacksize || existingCharge.quantity || 0) || 0
            : 0;
          let neededQuantity = Math.max(0, moduleCapacity - currentChargeQuantity);
          if (neededQuantity <= 0) {
            continue;
          }
          if (resolvedChargeSources.length === 0) {
            log.warn(
              `[DogmaIM] LoadAmmo: no source stacks resolved for module ${moduleID} typeID=${chargeTypeID} in location ${ammoLocationID}`,
            );
            continue;
          }
          // Docked reload announcement. Golden "Topping Up Ammo from cargo direct
          // to fitting while docked.txt" line 284, 141 ms after the LoadAmmo
          // CallReq and BEFORE the source stack decrement at line 294:
          //   OnChargeBeingLoadedToModule ([1054768633986L], 222, 5000)
          // Deliberately NOT accompanied by a nextActivationTime push: golden's
          // seven notifications contain none, and announcing one here makes the
          // module button unresponsive for the whole cycle (see
          // _announcePendingModuleReload). Golden also applies the quantity
          // synchronously with the call, so the reload time is a client-side
          // animation hint only — nothing is deferred or scheduled.
          if (isDockedSession(session) && moduleReloadTimeMs > 0) {
            this._notifyChargeBeingLoadedToModule(
              session,
              [moduleItem.itemID],
              chargeTypeID,
              moduleReloadTimeMs,
            );
          }
          for (const sourceCharge of resolvedChargeSources) {
            if (neededQuantity <= 0) {
              break;
            }
            const chargeItem = findItemById(sourceCharge.itemID);
            if (
              !chargeItem ||
              Number(chargeItem.ownerID) !== sourceOwnerID ||
              Number(chargeItem.flagID) !== sourceFlagID ||
              Number(chargeItem.locationID) !== ammoLocationID ||
              Number(chargeItem.typeID) !== chargeTypeID
            ) {
              continue;
            }
            const availableQuantity = Number(chargeItem.stacksize || chargeItem.quantity || 0) || 0;
            if (availableQuantity <= 0) {
              continue;
            }
            const moveQuantity = Math.min(neededQuantity, availableQuantity);
            const moveResult =
              existingCharge && activeChargeTypeID === chargeTypeID
                ? mergeItemStacks(
                  chargeItem.itemID,
                  existingCharge.itemID,
                  moveQuantity,
                )
                : moveItemToLocation(
                  chargeItem.itemID,
                  shipID,
                  moduleItem.flagID,
                  moveQuantity,
                );
            if (!moveResult.success) {
              log.warn(
                `[DogmaIM] LoadAmmo: move failed for charge ${chargeItem.itemID} -> module flag ${moduleItem.flagID}: ${moveResult.errorMsg}`,
              );
              continue;
            }
            log.info(
              `[DogmaIM] LoadAmmo: loaded ${moveQuantity}x typeID=${chargeTypeID} into module ${moduleID} (flag=${moduleItem.flagID})`,
            );
            neededQuantity -= moveQuantity;
            this._syncInventoryChanges(session, moveResult.data.changes, {
              deferredDockedFittingChanges,
            });
            if (existingCharge && activeChargeTypeID === chargeTypeID) {
              existingCharge = findItemById(existingCharge.itemID) || existingCharge;
            } else if (!existingCharge) {
              existingCharge = getLoadedChargeByFlag(
                inventoryOwnerID,
                shipID,
                moduleItem.flagID,
              );
              activeChargeTypeID = existingCharge ? Number(existingCharge.typeID) || 0 : 0;
            }
          }
        } finally {
          const nextChargeState = this._captureChargeStateSnapshot(
            inventoryOwnerID,
            shipID,
            moduleItem.flagID,
          );
          const nextChargeItem = this._captureChargeItemSnapshot(
            inventoryOwnerID,
            shipID,
            moduleItem.flagID,
          );
          this._notifyChargeQuantityTransition(
            session,
            charID,
            shipID,
            moduleItem.flagID,
            previousChargeState,
            nextChargeState,
            {
              previousChargeItem,
              nextChargeItem,
            },
          );
          this._notifyWeaponModuleAttributeTransition(
            session,
            moduleItem,
            previousChargeItem,
            nextChargeItem,
          );
          const shouldForceScannerProbeRuntimeSync =
            session &&
            session._space &&
            Number(moduleItem && moduleItem.groupID) === GROUP_SCAN_PROBE_LAUNCHER;
          this._refreshScannerProbeLauncherClientState(
            session,
            shipID,
            moduleItem,
            {
              forceRuntimeSync: shouldForceScannerProbeRuntimeSync,
            },
          );
        }
      }
    } finally {
      this._refreshDockedFittingState(session, deferredDockedFittingChanges);
    }
    return null;
  },

  Handle_UnloadAmmo(args, session) {
    const shipID = this._resolveAmmoCallShipID(args, session);
    const rawModuleIDs = args && args.length > 1 ? args[1] : [];
    const destination = args && args.length > 2 ? args[2] : shipID;
    const quantity = args && args.length > 3 ? Number(args[3]) || null : null;
    const charID = this._getCharID(session);
    const inventoryOwnerID = this._getDogmaInventoryOwnerID(session, shipID);
    const resolvedDestination = this._resolveUnloadDestination(destination, session, shipID);
    // UnloadModuleToContainer names the scalar Trade inventory before Add.
    // Single-charge AddItems instead uses UnloadAmmoToContainer, which sends
    // (tradeID, offeringActorID, None) directly, with no later inventory Add.
    const tradeMgr = this.serviceManager?.lookup("trademgr");
    const inventoryTrade = tradeMgr?.getInventoryTrade(resolvedDestination.locationID, session);
    if (inventoryTrade) {
      const destinationValues = extractSequenceValues(destination);
      const nativeChargeDestination = destinationValues.length === 3 &&
        Number(destinationValues[0]) === inventoryTrade.tradeContainerID &&
        Number(destinationValues[1]) === charID && destinationValues[2] === null;
      if ((destinationValues.length > 0 && !nativeChargeDestination) ||
          resolvedDestination.flagID !== ITEM_FLAGS.HANGAR) {
        throwWrappedUserError("CustomNotify", { notify: "Unload into the trade container by its inventory ID." });
      }
    } else {
      this._assertAmmoPlaceInReach(resolvedDestination.locationID, session, shipID, {
        office: resolvedDestination.office,
      });
    }
    // The flag is the caller's too. A slot is never where an unloaded charge
    // goes: that would put it into another module with none of LoadAmmo's checks.
    if (isShipFittingFlag(resolvedDestination.flagID)) {
      throwWrappedUserError("CantMoveChargesBetweenModules");
    }
    if (
      resolvedDestination.office &&
      !this._canPutIntoCorporationOfficeDivision(session, resolvedDestination.flagID)
    ) {
      log.debug(
        `[DogmaIM] UnloadAmmo into office ${resolvedDestination.locationID} flag=${resolvedDestination.flagID} refused: ` +
        `corprole=${String(session && session.corprole)} rolesAtAll=${String(session && session.rolesAtAll)} ` +
        `corpRole=${String(session && session.corpRole)}`,
      );
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }
    const unloadTargets = this._buildGroupedUnloadTargets(
      inventoryOwnerID,
      shipID,
      rawModuleIDs,
      quantity,
    );
    if (inventoryTrade) {
      // Preflight the whole group before staging anything. Partial rollback to
      // an occupied tuple-backed slot needs a durable merge, outside this unit.
      for (const target of unloadTargets) {
        const module = findItemById(target.moduleID);
        if (!module || Number(module.ownerID) !== inventoryOwnerID || Number(module.locationID) !== shipID) continue;
        const charge = getLoadedChargeByFlag(inventoryOwnerID, shipID, module.flagID);
        if (!charge) continue;
        if (target.quantity !== null && target.quantity !== undefined &&
            Number(target.quantity) !== Number(charge.stacksize ?? charge.quantity)) {
          throwWrappedUserError("CustomNotify", { notify: "Unload the whole charge stack into trade; partial fitted-charge trade is not available yet." });
        }
        tradeMgr._validateOfferedItem(charge, session, shipID);
      }
    }
    log.debug(
      `[DogmaIM] UnloadAmmo(shipID=${shipID}, moduleCount=${unloadTargets.length}, destination=${JSON.stringify({
        locationID: resolvedDestination.locationID,
        flagID: resolvedDestination.flagID,
        ...(resolvedDestination.ownerID ? { ownerID: resolvedDestination.ownerID } : {}),
      })})`,
    );
    // One docked fitting refresh for the whole call instead of one per module.
    const deferredDockedFittingChanges = [];
    // What the call answers: the stack each module's charges went to, in order. The client's FitCharges
    // (fittingSlotController.py 150 to 153) takes the first as the stack it then loads from, at the
    // destination (`chargeItem.itemID = itemID[0]`), so a charge dragged from one slot to another loads from
    // where it was put. Nothing unloaded answers None, as Tranquility answered a module put into the cargo
    // with no charge loaded (UnloadAmmo(ship, module, ship): None).
    const unloadedToItemIDs = [];
    try {
      for (const unloadTarget of unloadTargets) {
        const moduleID = Number(unloadTarget && unloadTarget.moduleID) || 0;
        if (moduleID <= 0) {
          continue;
        }
        const moduleItem = findItemById(moduleID);
        if (
          !moduleItem ||
          Number(moduleItem.ownerID) !== inventoryOwnerID ||
          Number(moduleItem.locationID) !== shipID
        ) {
          continue;
        }
        if (typeHasEffectName(moduleItem.typeID, "rigSlot")) {
          log.debug(
            `[DogmaIM] UnloadAmmo skipping rig module moduleID=${moduleID} typeID=${moduleItem.typeID} — rigs cannot be unloaded`,
          );
          continue;
        }
        const chargeItem = getLoadedChargeByFlag(
          inventoryOwnerID,
          shipID,
          moduleItem.flagID,
        );
        if (!chargeItem) {
          continue;
        }
        const previousChargeState = this._captureChargeStateSnapshot(
          inventoryOwnerID,
          shipID,
          moduleItem.flagID,
        );
        const previousChargeItem = this._captureChargeItemSnapshot(
          inventoryOwnerID,
          shipID,
          moduleItem.flagID,
        );
        try {
          const unloadResult = inventoryTrade
            ? { success: true, data: tradeMgr.addInventoryTradeItems(
                inventoryTrade.tradeContainerID, [chargeItem.itemID], shipID,
                unloadTarget.quantity, session, { chargeTransitionsManaged: true },
              ) }
            : this._moveLoadedChargeToDestination(
                chargeItem, resolvedDestination.locationID, resolvedDestination.flagID,
                unloadTarget.quantity, { ownerID: resolvedDestination.ownerID || null },
              );
          if (!unloadResult.success) {
            continue;
          }
          const landed = (unloadResult.data.changes || []).find((change) =>
            change &&
            change.item &&
            Number(change.item.locationID) === Number(resolvedDestination.locationID) &&
            Number(change.item.flagID) === Number(resolvedDestination.flagID) &&
            Number(change.item.typeID) === Number(chargeItem.typeID) &&
            Number(change.item.stacksize ?? change.item.quantity) > 0);
          if (landed) unloadedToItemIDs.push(Number(landed.item.itemID));
          if (inventoryTrade) {
            // TradeMgr publishes the real escrow row to both participants.
            // The existing finally below retires the source's charge tuple.
            deferredDockedFittingChanges.push(...unloadResult.data.changes);
          } else {
            this._syncInventoryChanges(session, unloadResult.data.changes, { deferredDockedFittingChanges });
          }
        } finally {
          const nextChargeState = this._captureChargeStateSnapshot(
            inventoryOwnerID,
            shipID,
            moduleItem.flagID,
          );
          const nextChargeItem = this._captureChargeItemSnapshot(
            inventoryOwnerID,
            shipID,
            moduleItem.flagID,
          );
          this._notifyChargeQuantityTransition(
            session,
            charID,
            shipID,
            moduleItem.flagID,
            previousChargeState,
            nextChargeState,
            {
              previousChargeItem,
              nextChargeItem,
            },
          );
          this._notifyWeaponModuleAttributeTransition(
            session,
            moduleItem,
            previousChargeItem,
            nextChargeItem,
          );
          const shouldForceScannerProbeRuntimeSync =
            session &&
            session._space &&
            Number(moduleItem && moduleItem.groupID) === GROUP_SCAN_PROBE_LAUNCHER;
          this._refreshScannerProbeLauncherClientState(
            session,
            shipID,
            moduleItem,
            {
              forceRuntimeSync: shouldForceScannerProbeRuntimeSync,
            },
          );
        }
      }
    } finally {
      this._refreshDockedFittingState(session, deferredDockedFittingChanges);
    }
    return unloadedToItemIDs.length > 0 ? { type: "list", items: unloadedToItemIDs } : null;
  },
};
