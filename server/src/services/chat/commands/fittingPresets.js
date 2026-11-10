"use strict";

// Fitting preset chat commands: /laser, /lasers, /hybrids, /railgun, /projectiles, /autocannon,
// /rocket, /light, /heavy and /torp (a hull with one rack of a weapon, propulsion and charges) and
// /lesmis (a mixed heavy missile and pulse laser fit), with the preset table, the fit planning
// that keeps every planned module online, and granting, fitting and boarding the ship.

const path = require("path");

const {
  getActiveShipRecord,
  activateShipForSession,
  spawnShipInHangarForSession,
} = require("../../character/characterState");
const {
  moveItemTypeFromCharacterLocation,
  ITEM_FLAGS,
} = require("../../inventory/itemStore");
const {
  resolveShipByName,
} = require("../shipTypeRegistry");
const {
  resolveItemByTypeID,
  resolveItemByName,
} = require("../../inventory/itemTypeRegistry");
const {
  buildShipResourceState,
  selectAutoFitFlagForType,
  validateFitForShip,
  isChargeCompatibleWithModule,
  listFittedItems,
} = require("../../fitting/liveFittingState");
const {
  readStaticRows,
  TABLE,
} = require("../../_shared/referenceData");
const {
  getDockedLocationID,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizeCommandName,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commandArguments"));
const {
  syncInventoryChangesToSession,
  grantStationHangarBatchAndSyncSession,
} = require(path.join(__dirname, "./commandInventorySync"));
const {
  dedupeItemTypes,
  sortItemTypesByName,
} = require(path.join(__dirname, "./commandItemTypes"));

const LASER_COMMAND_SHIP_NAME = "Apocalypse Navy Issue";
const LASER_COMMAND_TURRET_NAME = "Dual Heavy Beam Laser II";
const LASER_COMMAND_TURRET_COUNT = 8;
const LASER_COMMAND_MWD_NAME = "500MN Microwarpdrive II";
const LASER_COMMAND_MIN_CRYSTALS_PER_TYPE = 5;
const HYBRIDS_COMMAND_SHIP_NAME = "Rokh";
const HYBRIDS_COMMAND_TURRET_NAME = "Caldari Navy 350mm Railgun";
const HYBRIDS_COMMAND_TURRET_COUNT = 8;
const HYBRIDS_COMMAND_CHARGES_PER_TYPE = 500;
const PROJECTILES_COMMAND_SHIP_NAME = "Maelstrom";
const PROJECTILES_COMMAND_TURRET_NAME = "1200mm Heavy 'Jolt' Artillery I";
const PROJECTILES_COMMAND_TURRET_COUNT = 6;
const PROJECTILES_COMMAND_CHARGES_PER_TYPE = 500;
const AUTOCANNON_COMMAND_SHIP_NAME = "Tempest Fleet Issue";
const AUTOCANNON_COMMAND_TURRET_NAME = "800mm Repeating Cannon II";
const AUTOCANNON_COMMAND_TURRET_COUNT = 6;
const AUTOCANNON_COMMAND_CHARGES_PER_TYPE = 500;
const ROCKET_COMMAND_SHIP_NAME = "Kestrel";
const ROCKET_COMMAND_LAUNCHER_NAME = "Rocket Launcher II";
const ROCKET_COMMAND_LAUNCHER_COUNT = 4;
const ROCKET_COMMAND_MWD_NAME = "5MN Microwarpdrive II";
const ROCKET_COMMAND_MISSILES_PER_TYPE = 1000;
const LIGHT_COMMAND_SHIP_NAME = "Corax";
const LIGHT_COMMAND_LAUNCHER_NAME = "Caldari Navy Light Missile Launcher";
const LIGHT_COMMAND_LAUNCHER_COUNT = 7;
const LIGHT_COMMAND_MWD_NAME = "5MN Microwarpdrive II";
const LIGHT_COMMAND_MISSILES_PER_TYPE = 900;
const HEAVY_COMMAND_SHIP_NAME = "Drake";
const HEAVY_COMMAND_LAUNCHER_NAME = "Heavy Missile Launcher II";
const HEAVY_COMMAND_LAUNCHER_COUNT = 6;
const HEAVY_COMMAND_MWD_NAME = "50MN Microwarpdrive II";
const HEAVY_COMMAND_MISSILES_PER_TYPE = 450;
const TORP_COMMAND_SHIP_NAME = "Raven Navy Issue";
const TORP_COMMAND_LAUNCHER_NAME = "Caldari Navy Torpedo Launcher";
const TORP_COMMAND_LAUNCHER_COUNT = 7;
const TORP_COMMAND_MWD_NAME = "500MN Microwarpdrive II";
const TORP_COMMAND_MISSILES_PER_TYPE = 650;
const LESMIS_COMMAND_SHIP_NAME = "Typhoon Fleet Issue";
const LESMIS_COMMAND_LAUNCHER_NAME = "Heavy Missile Launcher II";
const LESMIS_COMMAND_TURRET_NAME = "Mega Pulse Laser II";
const LESMIS_COMMAND_LAUNCHER_COUNT = 4;
const LESMIS_COMMAND_TURRET_COUNT = 4;
const LESMIS_COMMAND_MISSILES_PER_TYPE = 1000;

const SINGLE_RACK_COMMAND_PRESETS = Object.freeze({
  laser: Object.freeze({
    shipName: LASER_COMMAND_SHIP_NAME,
    propulsionName: LASER_COMMAND_MWD_NAME,
    moduleName: LASER_COMMAND_TURRET_NAME,
    moduleCount: LASER_COMMAND_TURRET_COUNT,
    chargeQuantity: LASER_COMMAND_MIN_CRYSTALS_PER_TYPE,
    moduleFailureLabel: "turret",
    chargeKindLabel: "compatible L crystal",
    totalChargeLabel: "crystals",
  }),
  hybrids: Object.freeze({
    shipName: HYBRIDS_COMMAND_SHIP_NAME,
    propulsionName: LASER_COMMAND_MWD_NAME,
    moduleName: HYBRIDS_COMMAND_TURRET_NAME,
    moduleCount: HYBRIDS_COMMAND_TURRET_COUNT,
    chargeQuantity: HYBRIDS_COMMAND_CHARGES_PER_TYPE,
    moduleFailureLabel: "turret",
    chargeKindLabel: "compatible L hybrid charge",
    totalChargeLabel: "rounds",
  }),
  projectiles: Object.freeze({
    shipName: PROJECTILES_COMMAND_SHIP_NAME,
    propulsionName: LASER_COMMAND_MWD_NAME,
    moduleName: PROJECTILES_COMMAND_TURRET_NAME,
    moduleCount: PROJECTILES_COMMAND_TURRET_COUNT,
    chargeQuantity: PROJECTILES_COMMAND_CHARGES_PER_TYPE,
    moduleFailureLabel: "turret",
    chargeKindLabel: "compatible L projectile charge",
    totalChargeLabel: "rounds",
  }),
  autocannon: Object.freeze({
    shipName: AUTOCANNON_COMMAND_SHIP_NAME,
    propulsionName: LASER_COMMAND_MWD_NAME,
    moduleName: AUTOCANNON_COMMAND_TURRET_NAME,
    moduleCount: AUTOCANNON_COMMAND_TURRET_COUNT,
    chargeQuantity: AUTOCANNON_COMMAND_CHARGES_PER_TYPE,
    moduleFailureLabel: "turret",
    chargeKindLabel: "compatible L projectile charge",
    totalChargeLabel: "rounds",
  }),
  rocket: Object.freeze({
    shipName: ROCKET_COMMAND_SHIP_NAME,
    propulsionName: ROCKET_COMMAND_MWD_NAME,
    moduleName: ROCKET_COMMAND_LAUNCHER_NAME,
    moduleCount: ROCKET_COMMAND_LAUNCHER_COUNT,
    chargeQuantity: ROCKET_COMMAND_MISSILES_PER_TYPE,
    moduleFailureLabel: "launcher",
    chargeKindLabel: "compatible rocket",
    totalChargeLabel: "rockets",
  }),
  light: Object.freeze({
    shipName: LIGHT_COMMAND_SHIP_NAME,
    propulsionName: LIGHT_COMMAND_MWD_NAME,
    moduleName: LIGHT_COMMAND_LAUNCHER_NAME,
    moduleCount: LIGHT_COMMAND_LAUNCHER_COUNT,
    chargeQuantity: LIGHT_COMMAND_MISSILES_PER_TYPE,
    moduleFailureLabel: "launcher",
    chargeKindLabel: "compatible light missile",
    totalChargeLabel: "missiles",
  }),
  heavy: Object.freeze({
    shipName: HEAVY_COMMAND_SHIP_NAME,
    propulsionName: HEAVY_COMMAND_MWD_NAME,
    moduleName: HEAVY_COMMAND_LAUNCHER_NAME,
    moduleCount: HEAVY_COMMAND_LAUNCHER_COUNT,
    chargeQuantity: HEAVY_COMMAND_MISSILES_PER_TYPE,
    moduleFailureLabel: "launcher",
    chargeKindLabel: "compatible heavy missile",
    totalChargeLabel: "missiles",
  }),
  torp: Object.freeze({
    shipName: TORP_COMMAND_SHIP_NAME,
    propulsionName: TORP_COMMAND_MWD_NAME,
    moduleName: TORP_COMMAND_LAUNCHER_NAME,
    moduleCount: TORP_COMMAND_LAUNCHER_COUNT,
    chargeQuantity: TORP_COMMAND_MISSILES_PER_TYPE,
    moduleFailureLabel: "launcher",
    chargeKindLabel: "compatible torpedo",
    totalChargeLabel: "torpedoes",
  }),
});

let cachedLesmisHeavyMissileTypes = null;

function buildPlannedFittedModuleItem(charID, shipItem, itemType, flagID, itemID) {
  return {
    itemID,
    typeID: Number(itemType && itemType.typeID) || 0,
    groupID: Number(itemType && itemType.groupID) || 0,
    categoryID: Number(itemType && itemType.categoryID) || 0,
    flagID: Number(flagID) || 0,
    locationID: Number(shipItem && shipItem.itemID) || 0,
    ownerID: Number(charID) || 0,
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    itemName: String(itemType && itemType.name || ""),
    moduleState: {
      online: true,
    },
  };
}

function canPlannedModulesStayOnline(charID, shipItem, plannedModules) {
  const resourceState = buildShipResourceState(charID, shipItem, {
    fittedItems: plannedModules,
  });
  return {
    resourceState,
    success:
      resourceState.cpuLoad <= resourceState.cpuOutput + 1e-6 &&
      resourceState.powerLoad <= resourceState.powerOutput + 1e-6,
  };
}

function tryPlanNextModuleFit(charID, shipItem, itemType, fittedItems) {
  const nextFlagID = selectAutoFitFlagForType(
    shipItem,
    fittedItems,
    Number(itemType && itemType.typeID) || 0,
  );
  if (!nextFlagID) {
    return {
      success: false,
      errorMsg: "NO_SLOT_AVAILABLE",
    };
  }

  const probeItem = buildPlannedFittedModuleItem(
    charID,
    shipItem,
    itemType,
    nextFlagID,
    -1000 - fittedItems.length,
  );
  const validation = validateFitForShip(
    charID,
    shipItem,
    probeItem,
    nextFlagID,
    fittedItems,
  );
  if (!validation.success && validation.errorMsg !== "SKILL_REQUIRED") {
    return validation;
  }

  const plannedItems = [...fittedItems, probeItem];
  const resourceCheck = canPlannedModulesStayOnline(charID, shipItem, plannedItems);
  if (!resourceCheck.success) {
    return {
      success: false,
      errorMsg:
        resourceCheck.resourceState.cpuLoad > resourceCheck.resourceState.cpuOutput + 1e-6
          ? "NOT_ENOUGH_CPU"
          : "NOT_ENOUGH_POWER",
      data: {
        resourceState: resourceCheck.resourceState,
      },
    };
  }

  return {
    success: true,
    data: {
      flagID: nextFlagID,
      plannedItems,
      resourceState: resourceCheck.resourceState,
    },
  };
}

function getCompatibleModuleChargeTypes(moduleTypeID, filterFn = null) {
  const numericModuleTypeID = Number(moduleTypeID) || 0;
  if (numericModuleTypeID <= 0) {
    return [];
  }

  const rows = readStaticRows(TABLE.ITEM_TYPES) || [];
  return dedupeItemTypes(
    rows
      .filter((row) => Number(row && row.categoryID) === 8)
      .filter((row) => row.published !== false)
      .filter((row) => !/blueprint/i.test(String(row && row.name || "")))
      .map((row) => resolveItemByTypeID(row.typeID))
      .filter(Boolean)
      .filter((itemType) => isChargeCompatibleWithModule(numericModuleTypeID, itemType.typeID))
      .filter((itemType) => typeof filterFn !== "function" || filterFn(itemType)),
  ).sort(sortItemTypesByName);
}

function getCompatibleLaserCrystalTypes(moduleTypeID) {
  return getCompatibleModuleChargeTypes(moduleTypeID);
}

function getCompatibleLesmisHeavyMissileTypes(moduleTypeID) {
  if (cachedLesmisHeavyMissileTypes) {
    return cachedLesmisHeavyMissileTypes;
  }

  cachedLesmisHeavyMissileTypes = getCompatibleModuleChargeTypes(
    moduleTypeID,
    (itemType) =>
      /^(Inferno|Mjolnir|Nova|Scourge)(?: (Fury|Precision))? Heavy Missile$/i.test(
        String(itemType && itemType.name || "").trim(),
      ),
  );

  return cachedLesmisHeavyMissileTypes;
}

function resolveSingleRackCommandPreset(commandName) {
  const normalized = normalizeCommandName(commandName);
  if (normalized === "laser" || normalized === "lasers") {
    return SINGLE_RACK_COMMAND_PRESETS.laser;
  }

  if (
    normalized === "railgun" ||
    normalized === "hybrid" ||
    normalized === "hybrids" ||
    normalized === "hyrbids"
  ) {
    return SINGLE_RACK_COMMAND_PRESETS.hybrids;
  }

  if (
    normalized === "autocannon" ||
    normalized === "projectile" ||
    normalized === "projectiles" ||
    normalized === "projectule"
  ) {
    return normalized === "autocannon"
      ? SINGLE_RACK_COMMAND_PRESETS.autocannon
      : SINGLE_RACK_COMMAND_PRESETS.projectiles;
  }

  if (
    normalized === "rocket" ||
    normalized === "light" ||
    normalized === "heavy" ||
    normalized === "torp"
  ) {
    return SINGLE_RACK_COMMAND_PRESETS[normalized] || null;
  }

  return null;
}

function buildPresetSingleRackCommandPlan(charID, shipItem, preset) {
  const propulsionType = resolveItemByName(
    String(preset && preset.propulsionName || LASER_COMMAND_MWD_NAME),
  );
  if (!propulsionType || !propulsionType.success || !propulsionType.match) {
    return {
      success: false,
      errorMsg: "RACK_COMMAND_MWD_NOT_FOUND",
    };
  }

  const moduleType = resolveItemByName(String(preset && preset.moduleName || ""));
  if (!moduleType || !moduleType.success || !moduleType.match) {
    return {
      success: false,
      errorMsg: "RACK_COMMAND_MODULE_NOT_FOUND",
    };
  }

  const baseFit = tryPlanNextModuleFit(charID, shipItem, propulsionType.match, []);
  if (!baseFit.success) {
    return {
      success: false,
      errorMsg: baseFit.errorMsg || "RACK_COMMAND_MWD_FIT_FAILED",
    };
  }

  let plannedItems = baseFit.data.plannedItems.slice();
  let latestResourceState = baseFit.data.resourceState;
  const moduleCount = Number(preset && preset.moduleCount) || 0;
  for (let index = 0; index < moduleCount; index += 1) {
    const nextFit = tryPlanNextModuleFit(
      charID,
      shipItem,
      moduleType.match,
      plannedItems,
    );
    if (!nextFit.success) {
      return {
        success: false,
        errorMsg: nextFit.errorMsg || "RACK_COMMAND_MODULE_FIT_FAILED",
        data: {
          fittedModuleCount: index,
        },
      };
    }

    plannedItems = nextFit.data.plannedItems;
    latestResourceState = nextFit.data.resourceState;
  }

  const chargeTypes = getCompatibleModuleChargeTypes(moduleType.match.typeID);
  if (chargeTypes.length === 0) {
    return {
      success: false,
      errorMsg: "RACK_COMMAND_CHARGES_NOT_FOUND",
    };
  }

  const totalChargeVolume = chargeTypes.reduce(
    (sum, itemType) =>
      sum +
      ((Number(itemType && itemType.volume) || 0) * (Number(preset && preset.chargeQuantity) || 0)),
    0,
  );
  if (totalChargeVolume > latestResourceState.cargoCapacity + 1e-6) {
    return {
      success: false,
      errorMsg: "RACK_COMMAND_CARGO_TOO_SMALL",
      data: {
        requiredVolume: totalChargeVolume,
        cargoCapacity: latestResourceState.cargoCapacity,
      },
    };
  }

  return {
    success: true,
    data: {
      propulsionType: propulsionType.match,
      moduleType: moduleType.match,
      moduleCount,
      plannedItems,
      resourceState: latestResourceState,
      chargeTypes,
    },
  };
}

function buildLesmisCommandPlan(charID, shipItem) {
  const propulsionType = resolveItemByName(LASER_COMMAND_MWD_NAME);
  if (!propulsionType || !propulsionType.success || !propulsionType.match) {
    return {
      success: false,
      errorMsg: "LESMIS_COMMAND_MWD_NOT_FOUND",
    };
  }

  const launcherType = resolveItemByName(LESMIS_COMMAND_LAUNCHER_NAME);
  if (!launcherType || !launcherType.success || !launcherType.match) {
    return {
      success: false,
      errorMsg: "LESMIS_COMMAND_LAUNCHER_NOT_FOUND",
    };
  }

  const turretType = resolveItemByName(LESMIS_COMMAND_TURRET_NAME);
  if (!turretType || !turretType.success || !turretType.match) {
    return {
      success: false,
      errorMsg: "LESMIS_COMMAND_TURRET_NOT_FOUND",
    };
  }

  const baseFit = tryPlanNextModuleFit(charID, shipItem, propulsionType.match, []);
  if (!baseFit.success) {
    return {
      success: false,
      errorMsg: baseFit.errorMsg || "LESMIS_COMMAND_MWD_FIT_FAILED",
    };
  }

  let plannedItems = baseFit.data.plannedItems.slice();
  let latestResourceState = baseFit.data.resourceState;
  for (let index = 0; index < LESMIS_COMMAND_LAUNCHER_COUNT; index += 1) {
    const nextFit = tryPlanNextModuleFit(
      charID,
      shipItem,
      launcherType.match,
      plannedItems,
    );
    if (!nextFit.success) {
      return {
        success: false,
        errorMsg: nextFit.errorMsg || "LESMIS_COMMAND_LAUNCHER_FIT_FAILED",
        data: {
          fittedLauncherCount: index,
        },
      };
    }

    plannedItems = nextFit.data.plannedItems;
    latestResourceState = nextFit.data.resourceState;
  }

  for (let index = 0; index < LESMIS_COMMAND_TURRET_COUNT; index += 1) {
    const nextFit = tryPlanNextModuleFit(
      charID,
      shipItem,
      turretType.match,
      plannedItems,
    );
    if (!nextFit.success) {
      return {
        success: false,
        errorMsg: nextFit.errorMsg || "LESMIS_COMMAND_TURRET_FIT_FAILED",
        data: {
          fittedTurretCount: index,
        },
      };
    }

    plannedItems = nextFit.data.plannedItems;
    latestResourceState = nextFit.data.resourceState;
  }

  const crystalTypes = getCompatibleLaserCrystalTypes(turretType.match.typeID);
  const missileTypes = getCompatibleLesmisHeavyMissileTypes(launcherType.match.typeID);
  if (missileTypes.length === 0) {
    return {
      success: false,
      errorMsg: "LESMIS_COMMAND_MISSILES_NOT_FOUND",
    };
  }

  const crystalVolume = crystalTypes.reduce(
    (sum, itemType) =>
      sum +
      ((Number(itemType && itemType.volume) || 0) * LASER_COMMAND_MIN_CRYSTALS_PER_TYPE),
    0,
  );
  const missileVolume = missileTypes.reduce(
    (sum, itemType) =>
      sum +
      ((Number(itemType && itemType.volume) || 0) * LESMIS_COMMAND_MISSILES_PER_TYPE),
    0,
  );
  const totalCargoVolume = crystalVolume + missileVolume;
  if (totalCargoVolume > latestResourceState.cargoCapacity + 1e-6) {
    return {
      success: false,
      errorMsg: "LESMIS_COMMAND_CARGO_TOO_SMALL",
      data: {
        requiredVolume: totalCargoVolume,
        cargoCapacity: latestResourceState.cargoCapacity,
      },
    };
  }

  return {
    success: true,
    data: {
      propulsionType: propulsionType.match,
      launcherType: launcherType.match,
      turretType: turretType.match,
      launcherCount: LESMIS_COMMAND_LAUNCHER_COUNT,
      turretCount: LESMIS_COMMAND_TURRET_COUNT,
      plannedItems,
      resourceState: latestResourceState,
      crystalTypes,
      missileTypes,
    },
  };
}

function fitGrantedItemTypeToShip(
  session,
  stationID,
  shipItem,
  itemType,
  count,
  chatHub,
  options,
) {
  const numericCount = normalizePositiveInteger(count, 1);
  let fittedCount = 0;
  let latestResourceState = null;

  for (let index = 0; index < numericCount; index += 1) {
    const fittedItems = listFittedItems(session.characterID, shipItem.itemID);
    const nextFit = tryPlanNextModuleFit(
      session.characterID,
      shipItem,
      itemType,
      fittedItems,
    );
    if (!nextFit.success) {
      break;
    }

    const moveResult = moveItemTypeFromCharacterLocation(
      session.characterID,
      stationID,
      ITEM_FLAGS.HANGAR,
      shipItem.itemID,
      nextFit.data.flagID,
      itemType.typeID,
      1,
    );
    if (!moveResult.success) {
      return {
        success: false,
        errorMsg: moveResult.errorMsg || "LASER_COMMAND_MOVE_FAILED",
      };
    }

    syncInventoryChangesToSession(session, moveResult.data && moveResult.data.changes);
    fittedCount += 1;
    latestResourceState = nextFit.data.resourceState;
  }

  return {
    success: true,
    data: {
      fittedCount,
      resourceState: latestResourceState,
    },
  };
}

function moveGrantedItemTypeToShipCargo(session, stationID, shipItem, itemType, quantity) {
  const moveResult = moveItemTypeFromCharacterLocation(
    session.characterID,
    stationID,
    ITEM_FLAGS.HANGAR,
    shipItem.itemID,
    ITEM_FLAGS.CARGO_HOLD,
    itemType.typeID,
    quantity,
  );
  if (!moveResult.success) {
    return moveResult;
  }

  syncInventoryChangesToSession(session, moveResult.data && moveResult.data.changes);
  return moveResult;
}

function boardStoredShipLikeHangarBoard(session, stationID, shipItem, options = {}) {
  const serviceManager = options && options.serviceManager;
  const shipService =
    serviceManager && typeof serviceManager.lookup === "function"
      ? serviceManager.lookup("ship")
      : null;

  if (shipService && typeof shipService.callMethod === "function") {
    shipService.callMethod(
      "BoardStoredShip",
      [stationID, shipItem.itemID],
      session,
      null,
    );

    const activeShip = getActiveShipRecord(session.characterID);
    return {
      success: Boolean(activeShip && Number(activeShip.itemID) === Number(shipItem.itemID)),
      activeShip,
      errorMsg:
        activeShip && Number(activeShip.itemID) === Number(shipItem.itemID)
          ? null
          : "BOARD_STORED_SHIP_FAILED",
    };
  }

  const activationResult = activateShipForSession(session, shipItem.itemID, {
    emitNotifications: true,
    logSelection: false,
  });
  return {
    success: activationResult.success === true,
    activeShip: activationResult.activeShip || getActiveShipRecord(session.characterID),
    errorMsg: activationResult.errorMsg || null,
  };
}

function handlePresetSingleRackCommand(session, chatHub, options, preset, commandName) {
  const slashCommand = `/${String(commandName || "").trim()}`;
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      `Select a character before using ${slashCommand}.`,
    );
  }

  const stationID = Number(getDockedLocationID(session) || 0);
  if (stationID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      `You must be docked before using ${slashCommand}.`,
    );
  }

  const shipType = resolveShipByName(String(preset && preset.shipName || ""));
  if (!shipType || !shipType.success || !shipType.match) {
    return handledResult(
      chatHub,
      session,
      options,
      `Ship type not found for ${slashCommand}: ${String(preset && preset.shipName || "")}.`,
    );
  }

  const spawnResult = spawnShipInHangarForSession(session, shipType.match);
  if (!spawnResult.success || !spawnResult.ship) {
    return handledResult(
      chatHub,
      session,
      options,
      `Failed to spawn the ${slashCommand} hull in your station hangar.`,
    );
  }

  const shipItem = spawnResult.ship;
  const planResult = buildPresetSingleRackCommandPlan(session.characterID, shipItem, preset);
  if (!planResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Unable to build the ${slashCommand} fit: ${planResult.errorMsg}.`,
    );
  }

  const fitPlan = planResult.data;
  const grantEntries = [
    {
      itemType: fitPlan.propulsionType,
      quantity: 1,
    },
    {
      itemType: fitPlan.moduleType,
      quantity: fitPlan.moduleCount,
    },
    ...fitPlan.chargeTypes.map((itemType) => ({
      itemType,
      quantity: Number(preset && preset.chargeQuantity) || 0,
    })),
];
  const grantResult = grantStationHangarBatchAndSyncSession(
    session,
    stationID,
    grantEntries,
  );
  if (!grantResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Unable to seed the ${slashCommand} modules and ammo: ${grantResult.errorMsg || "WRITE_ERROR"}.`,
    );
  }

  const propulsionFitResult = fitGrantedItemTypeToShip(
    session,
    stationID,
    shipItem,
    fitPlan.propulsionType,
    1,
    chatHub,
    options,
  );
  if (!propulsionFitResult.success || propulsionFitResult.data.fittedCount !== 1) {
    return handledResult(
      chatHub,
      session,
      options,
      `The ${slashCommand} hull spawned, but the MWD fit failed: ${propulsionFitResult.errorMsg || "FIT_FAILED"}.`,
    );
  }

  const moduleFitResult = fitGrantedItemTypeToShip(
    session,
    stationID,
    shipItem,
    fitPlan.moduleType,
    fitPlan.moduleCount,
    chatHub,
    options,
  );
  if (!moduleFitResult.success || moduleFitResult.data.fittedCount !== fitPlan.moduleCount) {
    return handledResult(
      chatHub,
      session,
      options,
      `The ${slashCommand} hull spawned, but the ${String(preset && preset.moduleFailureLabel || "module")} fit failed: ${moduleFitResult.errorMsg || "FIT_FAILED"}.`,
    );
  }

  for (const chargeType of fitPlan.chargeTypes) {
    const cargoMoveResult = moveGrantedItemTypeToShipCargo(
      session,
      stationID,
      shipItem,
      chargeType,
      Number(preset && preset.chargeQuantity) || 0,
    );
    if (!cargoMoveResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `The ${slashCommand} hull spawned, but cargo seeding failed on ${chargeType.name}: ${cargoMoveResult.errorMsg || "MOVE_FAILED"}.`,
      );
    }
  }

  const finalResourceState = buildShipResourceState(
    session.characterID,
    shipItem,
  );
  return handledResult(
    chatHub,
    session,
    options,
    [
      `${shipType.match.name} was added to your ship hangar as ship ${shipItem.itemID}.`,
      `Fitted 1x ${fitPlan.propulsionType.name} and ${moduleFitResult.data.fittedCount}x ${fitPlan.moduleType.name}.`,
      `Loaded cargo with ${(Number(preset && preset.chargeQuantity) || 0).toLocaleString("en-US")} of each ${String(preset && preset.chargeKindLabel || "compatible charge")} (${fitPlan.chargeTypes.length} types, ${(fitPlan.chargeTypes.length * (Number(preset && preset.chargeQuantity) || 0)).toLocaleString("en-US")} total ${String(preset && preset.totalChargeLabel || "charges")}).`,
      `Remaining fitting: ${(finalResourceState.cpuOutput - finalResourceState.cpuLoad).toFixed(2)} CPU, ${(finalResourceState.powerOutput - finalResourceState.powerLoad).toFixed(2)} PG.`,
    ].join(" "),
  );
}

function handleLesmisCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /lesmis.",
    );
  }

  const stationID = Number(getDockedLocationID(session) || 0);
  if (stationID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be docked before using /lesmis.",
    );
  }

  const shipType = resolveShipByName(LESMIS_COMMAND_SHIP_NAME);
  if (!shipType || !shipType.success || !shipType.match) {
    return handledResult(
      chatHub,
      session,
      options,
      `Ship type not found for /lesmis: ${LESMIS_COMMAND_SHIP_NAME}.`,
    );
  }

  const spawnResult = spawnShipInHangarForSession(session, shipType.match);
  if (!spawnResult.success || !spawnResult.ship) {
    return handledResult(
      chatHub,
      session,
      options,
      "Failed to spawn the /lesmis hull in your station hangar.",
    );
  }

  const shipItem = spawnResult.ship;
  const planResult = buildLesmisCommandPlan(session.characterID, shipItem);
  if (!planResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Unable to build the /lesmis fit: ${planResult.errorMsg}.`,
    );
  }

  const fitPlan = planResult.data;
  const grantEntries = [
    {
      itemType: fitPlan.propulsionType,
      quantity: 1,
    },
    {
      itemType: fitPlan.launcherType,
      quantity: fitPlan.launcherCount,
    },
    {
      itemType: fitPlan.turretType,
      quantity: fitPlan.turretCount,
    },
    ...fitPlan.crystalTypes.map((itemType) => ({
      itemType,
      quantity: LASER_COMMAND_MIN_CRYSTALS_PER_TYPE,
    })),
    ...fitPlan.missileTypes.map((itemType) => ({
      itemType,
      quantity: LESMIS_COMMAND_MISSILES_PER_TYPE,
    })),
  ];

  const grantResult = grantStationHangarBatchAndSyncSession(
    session,
    stationID,
    grantEntries,
  );
  if (!grantResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Unable to seed the /lesmis fit and ammo: ${grantResult.errorMsg || "WRITE_ERROR"}.`,
    );
  }

  const propulsionFitResult = fitGrantedItemTypeToShip(
    session,
    stationID,
    shipItem,
    fitPlan.propulsionType,
    1,
    chatHub,
    options,
  );
  if (!propulsionFitResult.success || propulsionFitResult.data.fittedCount !== 1) {
    return handledResult(
      chatHub,
      session,
      options,
      `The /lesmis hull spawned, but the MWD fit failed: ${propulsionFitResult.errorMsg || "FIT_FAILED"}.`,
    );
  }

  const launcherFitResult = fitGrantedItemTypeToShip(
    session,
    stationID,
    shipItem,
    fitPlan.launcherType,
    fitPlan.launcherCount,
    chatHub,
    options,
  );
  if (
    !launcherFitResult.success ||
    launcherFitResult.data.fittedCount !== fitPlan.launcherCount
  ) {
    return handledResult(
      chatHub,
      session,
      options,
      `The /lesmis hull spawned, but the launcher fit failed: ${launcherFitResult.errorMsg || "FIT_FAILED"}.`,
    );
  }

  const turretFitResult = fitGrantedItemTypeToShip(
    session,
    stationID,
    shipItem,
    fitPlan.turretType,
    fitPlan.turretCount,
    chatHub,
    options,
  );
  if (!turretFitResult.success || turretFitResult.data.fittedCount !== fitPlan.turretCount) {
    return handledResult(
      chatHub,
      session,
      options,
      `The /lesmis hull spawned, but the turret fit failed: ${turretFitResult.errorMsg || "FIT_FAILED"}.`,
    );
  }

  for (const crystalType of fitPlan.crystalTypes) {
    const cargoMoveResult = moveGrantedItemTypeToShipCargo(
      session,
      stationID,
      shipItem,
      crystalType,
      LASER_COMMAND_MIN_CRYSTALS_PER_TYPE,
    );
    if (!cargoMoveResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `The /lesmis hull spawned, but laser crystal cargo seeding failed on ${crystalType.name}: ${cargoMoveResult.errorMsg || "MOVE_FAILED"}.`,
      );
    }
  }

  for (const missileType of fitPlan.missileTypes) {
    const cargoMoveResult = moveGrantedItemTypeToShipCargo(
      session,
      stationID,
      shipItem,
      missileType,
      LESMIS_COMMAND_MISSILES_PER_TYPE,
    );
    if (!cargoMoveResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `The /lesmis hull spawned, but missile cargo seeding failed on ${missileType.name}: ${cargoMoveResult.errorMsg || "MOVE_FAILED"}.`,
      );
    }
  }

  const activationResult = boardStoredShipLikeHangarBoard(
    session,
    stationID,
    shipItem,
    options,
  );
  if (!activationResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `The /lesmis ship was spawned and fitted, but boarding it failed: ${activationResult.errorMsg || "BOARD_FAILED"}.`,
    );
  }

  const finalResourceState = buildShipResourceState(
    session.characterID,
    shipItem,
  );
  return handledResult(
    chatHub,
    session,
    options,
    [
      `${shipType.match.name} was added to your ship hangar as ship ${shipItem.itemID}.`,
      `Fitted 1x ${fitPlan.propulsionType.name}, ${launcherFitResult.data.fittedCount}x ${fitPlan.launcherType.name}, and ${turretFitResult.data.fittedCount}x ${fitPlan.turretType.name}.`,
      `Loaded cargo with ${LASER_COMMAND_MIN_CRYSTALS_PER_TYPE} of each compatible L crystal and ${LESMIS_COMMAND_MISSILES_PER_TYPE.toLocaleString("en-US")} of each compatible T1/T2 heavy missile type (${fitPlan.missileTypes.length} missile types).`,
      `Boarded your client into the new Typhoon in station.`,
      `Remaining fitting: ${(finalResourceState.cpuOutput - finalResourceState.cpuLoad).toFixed(2)} CPU, ${(finalResourceState.powerOutput - finalResourceState.powerLoad).toFixed(2)} PG.`,
    ].join(" "),
  );
}

module.exports = {
  resolveSingleRackCommandPreset,
  handlePresetSingleRackCommand,
  handleLesmisCommand,
};
