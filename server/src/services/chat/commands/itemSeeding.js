"use strict";

// Item and ship seeding chat commands: /ship and /giveme (a hull into the hangar), /giveitem and
// /item, /create and /createitem (an item into the station hangar or the active ship's
// cargo), /minerals, /container1 (a random test kit), /gmships
// (every unpublished ship), /prop (the propulsion modules) and /gmweapons (weapons and their
// ammunition, granted in batches by a background job), with the seed plans, their caches and
// the hangar grant helpers.

const path = require("path");

const {
  spawnShipInHangarForSession,
  giveItemToHangarForSession,
} = require("../../character/characterState");
const {
  removeInventoryItem,
  findItemById,
  isCapsuleTypeID,
  SHIP_CATEGORY_ID,
  getInventoryItemUnitVolume,
  listContainerItems,
  ITEM_FLAGS,
  grantItemToCharacterLocation,
  CLIENT_INVENTORY_STACK_LIMIT,
  listOwnedItems,
} = require("../../inventory/itemStore");
const {
  resolveShipByName,
  getUnpublishedShipTypes,
} = require("../shipTypeRegistry");
const {
  resolveItemByTypeID,
  resolveItemByName,
} = require("../../inventory/itemTypeRegistry");
const {
  getTypeAttributeValue,
  typeHasEffectName,
} = require("../../fitting/liveFittingState");
const {
  getShipFittingSnapshot,
} = require("../../../_secondary/fitting/fittingRuntime");
const {
  readStaticRows,
  TABLE,
} = require("../../_shared/referenceData");
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  handledResult,
  getFeedbackChannel,
} = require(path.join(__dirname, "./commandReplies"));
const {
  splitTrailingAmount,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commandArguments"));
const {
  formatSuggestions,
} = require(path.join(__dirname, "./commandSuggestions"));
const {
  isSpaceSessionReady,
} = require(path.join(__dirname, "./commandSessionLocation"));
const {
  syncStationHangarChangesToSession,
  grantStationHangarBatchAndSyncSession,
  syncInventoryChangesToSession,
} = require(path.join(__dirname, "./commandInventorySync"));
const {
  dedupeItemTypes,
  sortItemTypesByName,
} = require(path.join(__dirname, "./commandItemTypes"));
const { buildList } = require(path.join(__dirname, "../../_shared/serviceHelpers"));

const CONTAINER1_CONTAINER_CATEGORY_ID = 2;
const CONTAINER1_CONTAINER_GROUP_IDS = new Set([12, 340, 448, 649]);
const CONTAINER1_MINERAL_TYPE_COUNT = 10;
const CONTAINER1_ORE_TYPE_COUNT = 12;
const CONTAINER1_GEAR_TYPE_COUNT = 16;
const CONTAINER1_MINERAL_QUANTITY_MIN = 1_000;
const CONTAINER1_MINERAL_QUANTITY_MAX = 25_000;
const CONTAINER1_ORE_QUANTITY_MIN = 100;
const CONTAINER1_ORE_QUANTITY_MAX = 2_500;
const PROPULSION_MODULE_GROUP_ID = 46;
const PROPULSION_MODULE_CATEGORY_ID = 7;
const PROPULSION_FACTION_PREFIXES = Object.freeze([
  "Domination",
  "Federation Navy",
  "Republic Fleet",
  "Shadow Serpentis",
  "True Sansha",
  "Thukker Modified",
]);
const PROPULSION_OFFICER_PREFIXES = Object.freeze([
  "Asine's",
  "Brynn's",
  "Cormack's",
  "Gara's",
  "Gotan's",
  "Hakim's",
  "Mizuro's",
  "Nija's",
  "Ramaku's",
  "Setele's",
  "Sila's",
  "Tobias'",
  "Tuvan's",
  "Usaras'",
]);

let cachedPropulsionCommandTypes = null;

let cachedGmWeaponsSeedPlan = null;
let cachedMineralsSeedPlan = null;
const activeGmWeaponsJobs = new Map();

const GM_WEAPONS_BATCH_SIZE = 96;
const GM_WEAPONS_MODULE_QUANTITY = 100;
const GM_WEAPONS_AMMO_QUANTITY = 5000;
const MINERALS_SEED_QUANTITY = 5_000_000;
// Slash commands run synchronously on the packet dispatcher. Bound the rows a
// single create request can materialize so a huge safe-integer quantity cannot
// monopolize the server while being split for the client's signed-int stacks.
const CREATE_COMMAND_MAX_SPLIT_STACKS = 64;
const CREATE_COMMAND_MAX_SINGLETON_ITEMS = 64;
// Mirrors itemStore's default singleton categories: ships (6) and blueprints (9).
const CREATE_COMMAND_SINGLETON_CATEGORY_IDS = new Set([6, 9]);

function isTechTwoPropulsionName(name) {
  return /\b(?:Afterburner|Microwarpdrive) II$/i.test(String(name || "").trim());
}

function startsWithAnyPrefix(name, prefixes) {
  const text = String(name || "").trim();
  return prefixes.some((prefix) => text.startsWith(prefix));
}

function getNumericTypeAttributeValue(typeID, attributeName, fallback = 0) {
  const numeric = Number(getTypeAttributeValue(Number(typeID) || 0, attributeName));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isNonTechOneVariant(row) {
  const typeID = Number(row && row.typeID) || 0;
  const techLevel = getNumericTypeAttributeValue(typeID, "techLevel", 0);
  const metaGroupID = getNumericTypeAttributeValue(
    typeID,
    "metaGroupID",
    Number(row && row.metaGroupID) || 0,
  );
  return (
    techLevel >= 2 ||
    metaGroupID > 1 ||
    /abyssal/i.test(String(row && row.name || ""))
  );
}

function isCombatWeaponType(row) {
  const typeID = Number(row && row.typeID) || 0;
  const groupName = String(row && row.groupName || "").trim().toLowerCase();
  if (!typeID || groupName.includes("mining") || groupName.includes("gas cloud")) {
    return false;
  }

  return (
    typeHasEffectName(typeID, "turretFitted") ||
    typeHasEffectName(typeID, "launcherFitted")
  );
}

function collectChargeGroupIDsForType(typeID) {
  const chargeGroupIDs = new Set();
  for (let index = 1; index <= 5; index += 1) {
    const groupID = getNumericTypeAttributeValue(typeID, `chargeGroup${index}`, 0);
    if (groupID > 0) {
      chargeGroupIDs.add(groupID);
    }
  }
  return chargeGroupIDs;
}

function isPublishedMineralRow(row) {
  const typeID = Number(row && row.typeID) || 0;
  const groupID = Number(row && row.groupID) || 0;
  const name = String(row && row.name || "").trim();
  if (typeID <= 0 || groupID !== 18 || row.published === false) {
    return false;
  }

  return !/\bunused\b/i.test(name);
}

function isPublishedOreRow(row) {
  const typeID = Number(row && row.typeID) || 0;
  const categoryID = Number(row && row.categoryID) || 0;
  const groupName = String(row && row.groupName || "").trim().toLowerCase();
  const name = String(row && row.name || "").trim().toLowerCase();
  if (typeID <= 0 || categoryID !== 25 || row.published === false) {
    return false;
  }

  if (
    groupName.includes("ice") ||
    groupName.includes("decorative") ||
    groupName.includes("non-interactable") ||
    /\bunused\b/i.test(name)
  ) {
    return false;
  }

  return true;
}

function isContainer1ContainerRow(row) {
  return Boolean(
    row &&
    Number(row.categoryID) === CONTAINER1_CONTAINER_CATEGORY_ID &&
    CONTAINER1_CONTAINER_GROUP_IDS.has(Number(row.groupID) || 0),
  );
}

function isContainer1GearRow(row) {
  const typeID = Number(row && row.typeID) || 0;
  const name = String(row && row.name || "").trim();
  return Boolean(
    typeID > 0 &&
    Number(row && row.categoryID) === 7 &&
    row.published !== false &&
    name &&
    !/blueprint|mutaplasmid|\bunused\b/i.test(name),
  );
}

function getContainer1RandomInt(randomFn, minimum, maximum) {
  const min = Math.ceil(Number(minimum) || 0);
  const max = Math.max(min, Math.floor(Number(maximum) || min));
  let randomValue = 0;
  try {
    randomValue = Number(
      typeof randomFn === "function" ? randomFn() : Math.random(),
    );
  } catch (error) {
    randomValue = 0;
  }
  const normalized = Number.isFinite(randomValue)
    ? Math.min(0.9999999999999999, Math.max(0, randomValue))
    : 0;
  return min + Math.floor(normalized * ((max - min) + 1));
}

function selectContainer1RandomTypes(itemTypes, count, randomFn) {
  const shuffled = [...(Array.isArray(itemTypes) ? itemTypes : [])];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = getContainer1RandomInt(randomFn, 0, index);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled.slice(0, Math.min(shuffled.length, Math.max(0, count)));
}

function getContainer1SeedPlan(randomFn = Math.random) {
  const rows = readStaticRows(TABLE.ITEM_TYPES) || [];
  const containerTypes = dedupeItemTypes(
    rows
      .filter(isContainer1ContainerRow)
      .map((row) => resolveItemByTypeID(row.typeID))
      .filter(Boolean),
  ).sort(sortItemTypesByName);
  const mineralTypes = selectContainer1RandomTypes(
    dedupeItemTypes(
      rows
        .filter(isPublishedMineralRow)
        .map((row) => resolveItemByTypeID(row.typeID))
        .filter(Boolean),
    ),
    CONTAINER1_MINERAL_TYPE_COUNT,
    randomFn,
  );
  const oreTypes = selectContainer1RandomTypes(
    dedupeItemTypes(
      rows
        .filter(isPublishedOreRow)
        .map((row) => resolveItemByTypeID(row.typeID))
        .filter(Boolean),
    ),
    CONTAINER1_ORE_TYPE_COUNT,
    randomFn,
  );
  const gearTypes = selectContainer1RandomTypes(
    dedupeItemTypes(
      rows
        .filter(isContainer1GearRow)
        .map((row) => resolveItemByTypeID(row.typeID))
        .filter(Boolean),
    ),
    CONTAINER1_GEAR_TYPE_COUNT,
    randomFn,
  );

  return {
    containerTypes,
    mineralTypes,
    oreTypes,
    gearTypes,
    entries: [
      ...containerTypes.map((itemType) => ({
        itemType,
        quantity: 1,
        options: {
          individualItems: true,
          singleton: 0,
        },
      })),
      ...mineralTypes.map((itemType) => ({
        itemType,
        quantity: getContainer1RandomInt(
          randomFn,
          CONTAINER1_MINERAL_QUANTITY_MIN,
          CONTAINER1_MINERAL_QUANTITY_MAX,
        ),
      })),
      ...oreTypes.map((itemType) => ({
        itemType,
        quantity: getContainer1RandomInt(
          randomFn,
          CONTAINER1_ORE_QUANTITY_MIN,
          CONTAINER1_ORE_QUANTITY_MAX,
        ),
      })),
      ...gearTypes.map((itemType) => ({
        itemType,
        quantity: 1,
        options: {
          individualItems: true,
          singleton: 0,
        },
      })),
    ],
  };
}

function getMineralsSeedPlan() {
  if (cachedMineralsSeedPlan) {
    return cachedMineralsSeedPlan;
  }

  const rows = readStaticRows(TABLE.ITEM_TYPES) || [];
  const mineralTypes = dedupeItemTypes(
    rows
      .filter(isPublishedMineralRow)
      .map((row) => resolveItemByTypeID(row.typeID))
      .filter(Boolean),
  ).sort(sortItemTypesByName);
  const oreTypes = dedupeItemTypes(
    rows
      .filter(isPublishedOreRow)
      .map((row) => resolveItemByTypeID(row.typeID))
      .filter(Boolean),
  ).sort(sortItemTypesByName);

  cachedMineralsSeedPlan = {
    mineralTypes,
    oreTypes,
    allTypeIDs: new Set([
      ...mineralTypes.map((itemType) => Number(itemType.typeID) || 0),
      ...oreTypes.map((itemType) => Number(itemType.typeID) || 0),
    ]),
    entries: [
      ...mineralTypes.map((itemType) => ({
        itemType,
        quantity: MINERALS_SEED_QUANTITY,
      })),
      ...oreTypes.map((itemType) => ({
        itemType,
        quantity: MINERALS_SEED_QUANTITY,
      })),
    ],
  };
  return cachedMineralsSeedPlan;
}

function getGmWeaponsSeedPlan() {
  if (cachedGmWeaponsSeedPlan) {
    return cachedGmWeaponsSeedPlan;
  }

  const rows = readStaticRows(TABLE.ITEM_TYPES) || [];
  const weaponTypes = dedupeItemTypes(
    rows
      .filter((row) => Number(row.categoryID) === 7)
      .filter((row) => row.published !== false)
      .filter((row) => !/blueprint/i.test(String(row.name || "")))
      .filter((row) => isCombatWeaponType(row))
      .filter((row) => isNonTechOneVariant(row))
      .map((row) => resolveItemByTypeID(row.typeID))
      .filter(Boolean),
  ).sort(sortItemTypesByName);

  const chargeGroupIDs = new Set();
  for (const weaponType of weaponTypes) {
    for (const chargeGroupID of collectChargeGroupIDsForType(weaponType.typeID)) {
      chargeGroupIDs.add(chargeGroupID);
    }
  }

  const ammoTypes = dedupeItemTypes(
    rows
      .filter((row) => Number(row.categoryID) === 8)
      .filter((row) => row.published !== false)
      .filter((row) => !/blueprint/i.test(String(row.name || "")))
      .filter((row) => chargeGroupIDs.has(Number(row.groupID) || 0))
      .filter((row) => isNonTechOneVariant(row))
      .map((row) => resolveItemByTypeID(row.typeID))
      .filter(Boolean),
  ).sort(sortItemTypesByName);

  cachedGmWeaponsSeedPlan = {
    weaponTypes,
    ammoTypes,
    entries: [
      ...weaponTypes.map((itemType) => ({
        itemType,
        quantity: GM_WEAPONS_MODULE_QUANTITY,
        kind: "weapon",
      })),
      ...ammoTypes.map((itemType) => ({
        itemType,
        quantity: GM_WEAPONS_AMMO_QUANTITY,
        kind: "ammo",
      })),
    ],
  };
  return cachedGmWeaponsSeedPlan;
}

function removeStationHangarBatchAndSyncSession(session, stationID, itemIDs = []) {
  const changes = [];
  for (const rawItemID of Array.isArray(itemIDs) ? itemIDs : []) {
    const itemID = Number(rawItemID) || 0;
    if (itemID <= 0) {
      continue;
    }
    const removeResult = removeInventoryItem(itemID, {
      removeContents: true,
    });
    if (!removeResult.success) {
      return removeResult;
    }
    changes.push(...((removeResult.data && removeResult.data.changes) || []));
  }

  if (changes.length > 0) {
    syncStationHangarChangesToSession(session, stationID, changes);
  }

  return {
    success: true,
    data: {
      changes,
    },
  };
}

function continueGmWeaponsSeedJob(job, chatHub) {
  if (!job) {
    return;
  }

  try {
    const nextEntries = job.entries.slice(
      job.nextIndex,
      job.nextIndex + GM_WEAPONS_BATCH_SIZE,
    );
    if (nextEntries.length === 0) {
      activeGmWeaponsJobs.delete(job.characterID);
      chatHub.sendSystemMessage(
        job.session,
        [
          `Completed /gmweapons for station ${job.stationID}.`,
          `Added ${job.weaponTypeCount} weapon stacks x${GM_WEAPONS_MODULE_QUANTITY} and ${job.ammoTypeCount} ammo stacks x${GM_WEAPONS_AMMO_QUANTITY}.`,
          job.sample ? `Sample: ${job.sample}.` : null,
        ].filter(Boolean).join(" "),
        job.feedbackChannel,
      );
      return;
    }

    const grantResult = grantStationHangarBatchAndSyncSession(
      job.session,
      job.stationID,
      nextEntries,
    );
    if (!grantResult.success) {
      throw new Error(grantResult.errorMsg || "WRITE_ERROR");
    }

    job.nextIndex += nextEntries.length;
    setImmediate(() => continueGmWeaponsSeedJob(job, chatHub));
  } catch (error) {
    activeGmWeaponsJobs.delete(job.characterID);
    chatHub.sendSystemMessage(
      job.session,
      ` /gmweapons failed after ${job.nextIndex}/${job.entries.length} grants: ${error.message}`.trim(),
      job.feedbackChannel,
    );
  }
}

function getPropulsionCommandItemTypes() {
  if (cachedPropulsionCommandTypes) {
    return cachedPropulsionCommandTypes;
  }

  const rows = readStaticRows(TABLE.ITEM_TYPES) || [];
  cachedPropulsionCommandTypes = rows
    .filter((row) => Number(row.groupID) === PROPULSION_MODULE_GROUP_ID)
    .filter((row) => Number(row.categoryID) === PROPULSION_MODULE_CATEGORY_ID)
    .filter((row) => row.published !== false)
    .filter((row) => /afterburner|microwarpdrive/i.test(String(row.name || "")))
    .filter((row) => !/blueprint|mutaplasmid/i.test(String(row.name || "")))
    .filter((row) => {
      const name = String(row.name || "").trim();
      return (
        isTechTwoPropulsionName(name) ||
        startsWithAnyPrefix(name, PROPULSION_FACTION_PREFIXES) ||
        startsWithAnyPrefix(name, PROPULSION_OFFICER_PREFIXES)
      );
    })
    .map((row) => resolveItemByName(String(row.name || "").trim()))
    .filter((lookup) => lookup && lookup.success && lookup.match)
    .map((lookup) => lookup.match)
    .filter((itemType, index, list) =>
      list.findIndex((candidate) => Number(candidate.typeID) === Number(itemType.typeID)) === index,
    )
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));

  return cachedPropulsionCommandTypes;
}

function handleShipSpawn(commandLabel, session, argumentText, chatHub, options) {
  if (!argumentText) {
    return handledResult(
      chatHub,
      session,
      options,
      `Usage: /${commandLabel} <ship name|typeID>`,
    );
  }

  const shipLookup = resolveShipByName(argumentText);
  if (!shipLookup.success) {
    const message =
      shipLookup.errorMsg === "SHIP_NOT_FOUND"
        ? `Ship not found: ${argumentText}.${formatSuggestions(shipLookup.suggestions)}`
        : `Ship name is ambiguous: ${argumentText}.${formatSuggestions(shipLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  const spawnResult = spawnShipInHangarForSession(session, shipLookup.match);
  if (!spawnResult.success) {
    let message = "Ship spawn failed.";
    if (spawnResult.errorMsg === "DOCK_REQUIRED") {
      message = "You must be docked before spawning ships into your hangar.";
    } else if (spawnResult.errorMsg === "CHARACTER_NOT_SELECTED") {
      message = "Select a character before spawning ships.";
    }
    return handledResult(chatHub, session, options, message);
  }

  return handledResult(
    chatHub,
    session,
    options,
    `${shipLookup.match.name}${shipLookup.match.published === false ? " [unpublished]" : ""} was added to your ship hangar. /${commandLabel} only spawns the hull for now; board it manually from the hangar.`,
  );
}

function handleGiveItemCommand(session, argumentText, chatHub, options) {
  // Share /create's cargo capacity checks and inventory synchronization in space.
  if (isSpaceSessionReady(session)) {
    return handleCreateItemCommand(session, argumentText, chatHub, options, "giveitem");
  }
  const trimmedArgument = String(argumentText || "").trim();
  if (!trimmedArgument) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /giveitem <item name|typeID> [amount]",
    );
  }

  let itemLookup = resolveItemByName(trimmedArgument);
  let normalizedAmount = 1;

  if (!itemLookup.success) {
    const splitLookup = splitTrailingAmount(trimmedArgument);
    if (splitLookup.lookupText && splitLookup.amount !== null) {
      const splitMatch = resolveItemByName(splitLookup.lookupText);
      if (splitMatch.success) {
        itemLookup = splitMatch;
        normalizedAmount = normalizePositiveInteger(Math.trunc(splitLookup.amount));
      }
    }
  }

  if (!normalizedAmount) {
    return handledResult(
      chatHub,
      session,
      options,
      "Item amount must be a positive whole number.",
    );
  }

  if (!Number.isSafeInteger(normalizedAmount)) {
    return handledResult(
      chatHub,
      session,
      options,
      "Item amount is too large. Use a positive whole number up to 9,007,199,254,740,991.",
    );
  }

  if (!itemLookup.success) {
    const message =
      itemLookup.errorMsg === "ITEM_NOT_FOUND"
        ? `Item not found: ${trimmedArgument}.${formatSuggestions(itemLookup.suggestions)}`
        : `Item name is ambiguous: ${trimmedArgument}.${formatSuggestions(itemLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  const giveResult = giveItemToHangarForSession(
    session,
    itemLookup.match,
    normalizedAmount,
  );
  if (!giveResult.success) {
    let message = "Item grant failed.";
    if (giveResult.errorMsg === "DOCK_REQUIRED") {
      message = "You must be docked before using /giveitem.";
    } else if (giveResult.errorMsg === "CHARACTER_NOT_SELECTED") {
      message = "Select a character before using /giveitem.";
    } else if (giveResult.errorMsg === "ITEM_TYPE_NOT_FOUND") {
      message = `Item type not found: ${trimmedArgument}.`;
    } else if (giveResult.errorMsg === "ITEM_QUANTITY_OUT_OF_RANGE") {
      message =
        "Item amount is too large for a safe inventory operation. Use a positive whole number up to 9,007,199,254,740,991.";
    }
    return handledResult(chatHub, session, options, message);
  }

  const changedItems = Array.isArray(giveResult.data.items) ? giveResult.data.items : [];
  const stackMode =
    changedItems.length === 1 && Number(changedItems[0].singleton || 0) === 0;
  const summary = stackMode
    ? `${normalizedAmount.toLocaleString("en-US")}x ${itemLookup.match.name}`
    : `${itemLookup.match.name} x${normalizedAmount.toLocaleString("en-US")}`;
  const splitNote =
    giveResult.data &&
    giveResult.data.stackSplitApplied === true &&
    changedItems.length > 1
      ? ` Split across ${changedItems.length.toLocaleString("en-US")} client-safe stacks to respect the inventory wire limit.`
      : "";

  return handledResult(
    chatHub,
    session,
    options,
    `${summary}${itemLookup.match.published === false ? " [unpublished]" : ""} was added to your station hangar.${splitNote}`,
  );
}

// Undocked, retail /create delivers into the active ship's cargo hold: the
// V24.01 module tester creates ammo with /create in space and loads it through
// LoadAmmoTypeToModule, which only lists flagCargo (devtools svc_modtest.py:266
// and clientDogmaLocation.py:976). Cargo loading must fit the hold -- dna.py's
// CreateShip_GML falls back to a 999,999,999 m3 Cockroach when a hull does not
// fit -- and the item spawner refuses a capsule outright (svc_invtools.py:89).
// An assembled hull is never ordinary cargo (invBroker _validateShipBayMove),
// so hulls arrive packaged. Everything is checked before any row is written,
// so a refusal leaves no items and sends no notifications.
function createItemInActiveShipCargo(session, itemType, quantity) {
  return createItemInShipCargo(
    session,
    normalizePositiveInteger(session._space && session._space.shipID),
    itemType,
    quantity,
  );
}

// The same for a ship named by its number (/load's target), docked or in space.
function createItemInShipCargo(session, shipID, itemType, quantity) {
  const shipItem = shipID ? findItemById(shipID) : null;
  if (!shipItem) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }
  if (isCapsuleTypeID(shipItem.typeID)) {
    return { success: false, errorMsg: "CAPSULE_HAS_NO_CARGO" };
  }

  const createsHull = Number(itemType.categoryID) === SHIP_CATEGORY_ID;
  const createsSingleton =
    !createsHull &&
    CREATE_COMMAND_SINGLETON_CATEGORY_IDS.has(Number(itemType.categoryID));
  // Measure the hold the way invBroker GetCapacity and cargo moves do.
  const requiredVolume =
    getInventoryItemUnitVolume({
      typeID: itemType.typeID,
      singleton: createsSingleton ? 1 : 0,
    }) * quantity;
  const snapshot = getShipFittingSnapshot(session.characterID, shipID, {
    shipItem,
    reason: "chat.create",
  });
  const capacity =
    Number(snapshot && snapshot.resourceState && snapshot.resourceState.cargoCapacity) || 0;
  const usedVolume = listContainerItems(null, shipID, ITEM_FLAGS.CARGO_HOLD).reduce(
    (sum, item) => {
      const units =
        Number(item.singleton) === 1
          ? 1
          : Math.max(0, Number(item.stacksize ?? item.quantity ?? 0) || 0);
      return sum + Math.max(0, getInventoryItemUnitVolume(item)) * units;
    },
    0,
  );
  const freeVolume = Math.max(0, capacity - usedVolume);
  if (requiredVolume > freeVolume + 1e-7) {
    return {
      success: false,
      errorMsg: "NOT_ENOUGH_CARGO_SPACE",
      data: { requiredVolume, freeVolume },
    };
  }

  const grantResult = grantItemToCharacterLocation(
    session.characterID,
    shipID,
    ITEM_FLAGS.CARGO_HOLD,
    itemType,
    quantity,
    createsHull ? { singleton: 0 } : {},
  );
  if (grantResult.success) {
    syncInventoryChangesToSession(session, grantResult.data && grantResult.data.changes);
  }
  return grantResult;
}

function handleCreateItemCommand(session, argumentText, chatHub, options, commandName = "createitem") {
  const slashCommand = `/${String(commandName || "createitem").trim() || "createitem"}`;
  const trimmedArgument = String(argumentText || "").trim();
  if (!trimmedArgument) {
    return handledResult(
      chatHub,
      session,
      options,
      `Usage: ${slashCommand} <item name|typeID> [amount]`,
    );
  }

  let itemLookup = resolveItemByName(trimmedArgument);
  let normalizedAmount = 1;

  if (!itemLookup.success) {
    const splitLookup = splitTrailingAmount(trimmedArgument);
    if (splitLookup.lookupText && splitLookup.amount !== null) {
      const splitMatch = resolveItemByName(splitLookup.lookupText);
      if (splitMatch.success) {
        itemLookup = splitMatch;
        normalizedAmount = normalizePositiveInteger(Math.trunc(splitLookup.amount));
      }
    }
  }

  if (!normalizedAmount) {
    return handledResult(
      chatHub,
      session,
      options,
      "Item amount must be a positive whole number.",
    );
  }

  if (!Number.isSafeInteger(normalizedAmount)) {
    return handledResult(
      chatHub,
      session,
      options,
      "Item amount is too large. Use a positive whole number up to 9,007,199,254,740,991.",
    );
  }

  if (!itemLookup.success) {
    const message =
      itemLookup.errorMsg === "ITEM_NOT_FOUND"
        ? `Item not found: ${trimmedArgument}.${formatSuggestions(itemLookup.suggestions)}`
        : `Item name is ambiguous: ${trimmedArgument}.${formatSuggestions(itemLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  // A hull is created packaged, docked as in space: the client's fitting spawner makes a ship with
  // "/createitem <shipTypeID> 1" and then assembles the item it answers (devtools svc_fittingspawner.py 62 to 63),
  // and the multifit window's GM: Give all creates the packaged hulls it counts as missing
  // (multiFitWnd.py 494 to 509, missingItemsPopup.GiveOrLoadAllGM's "/create <typeID> <qty>").
  const createsHull = Number(itemLookup.match.categoryID) === SHIP_CATEGORY_ID;
  const createsSingletonItems = !createsHull && CREATE_COMMAND_SINGLETON_CATEGORY_IDS.has(
    Number(itemLookup.match.categoryID),
  );
  const maximumAmount = createsSingletonItems
    ? CREATE_COMMAND_MAX_SINGLETON_ITEMS
    : CLIENT_INVENTORY_STACK_LIMIT * CREATE_COMMAND_MAX_SPLIT_STACKS;
  if (normalizedAmount > maximumAmount) {
    const limitDescription = createsSingletonItems
      ? `${CREATE_COMMAND_MAX_SINGLETON_ITEMS.toLocaleString("en-US")} individual items`
      : `${maximumAmount.toLocaleString("en-US")} units (${CREATE_COMMAND_MAX_SPLIT_STACKS} client-safe stacks)`;
    return handledResult(
      chatHub,
      session,
      options,
      `Item amount is too large for one ${slashCommand} operation. ${itemLookup.match.name} is limited to ${limitDescription}.`,
    );
  }

  const giveResult = isSpaceSessionReady(session)
    ? createItemInActiveShipCargo(session, itemLookup.match, normalizedAmount)
    : giveItemToHangarForSession(session, itemLookup.match, normalizedAmount, createsHull ? { singleton: 0 } : {});
  if (!giveResult.success) {
    let message = "Item creation failed.";
    if (giveResult.errorMsg === "DOCK_REQUIRED") {
      message = `You must be docked or in space before using ${slashCommand}.`;
    } else if (giveResult.errorMsg === "CHARACTER_NOT_SELECTED") {
      message = `Select a character before using ${slashCommand}.`;
    } else if (giveResult.errorMsg === "SHIP_NOT_FOUND") {
      message = `Your current ship could not be found for ${slashCommand}.`;
    } else if (giveResult.errorMsg === "CAPSULE_HAS_NO_CARGO") {
      message = `A capsule has no cargo hold. Board a ship or dock before using ${slashCommand}.`;
    } else if (giveResult.errorMsg === "NOT_ENOUGH_CARGO_SPACE") {
      const formatM3 = (value) =>
        Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
      message =
        `Not enough cargo space for ${normalizedAmount.toLocaleString("en-US")}x ${itemLookup.match.name}: ` +
        `it needs ${formatM3(giveResult.data.requiredVolume)} m3 and your cargo hold has ` +
        `${formatM3(giveResult.data.freeVolume)} m3 free.`;
    } else if (giveResult.errorMsg === "ITEM_TYPE_NOT_FOUND") {
      message = `Item type not found: ${trimmedArgument}.`;
    } else if (giveResult.errorMsg === "ITEM_QUANTITY_OUT_OF_RANGE") {
      message =
        "Item amount is too large for a safe inventory operation. Use a positive whole number up to 9,007,199,254,740,991.";
    }
    return handledResult(chatHub, session, options, message);
  }

  const changedItems = Array.isArray(giveResult.data.items) ? giveResult.data.items : [];
  const firstItemID = Number(changedItems[0] && changedItems[0].itemID) || 0;
  if (!firstItemID) {
    return handledResult(chatHub, session, options, "Item creation failed.");
  }

  if (commandName === "giveitem") {
    return handledResult(
      chatHub,
      session,
      options,
      `${normalizedAmount.toLocaleString("en-US")}x ${itemLookup.match.name} was added to your ship's cargo hold.`,
    );
  }

  return {
    handled: true,
    message: firstItemID,
  };
}

// /load <me|shipID> <name|typeID> [amount]: retail's GM item spawner for ROLE_GML, beside /create's for
// ROLE_WORLDMOD (devtools menu_implant.py 159 to 163, svc_invtools.py 141 to 146, multiFitWnd.LoadAllGM). It puts
// the items in a ship's cargo hold and answers their numbers as a list, which the client indexes
// (SlashCmd('/load me %d %d' % (t, q))[0]). "me" is the pilot's active ship, docked or in space: /unload me, its
// counterpart, lists session.shipid's inventory (svc_slash.py cmd_unload), and dna.CreateShip_GML moves what
// "/load me" answered from the active ship to the hangar when docked and jettisons it in space. A number is that
// ship of the pilot's (dna.CreateShip_GML's where=shipID, a hauler it assembled for the purpose). What does not fit
// the hold is not created (CreateShip_GML: "you can't squeeze a ... into your current ship's cargohold"); the
// reason goes to chat. A hull arrives packaged, as in /create.
function handleLoadCommand(session, argumentText, chatHub, options) {
  const trimmed = String(argumentText || "").trim();
  const usage = "Usage: /load <me|shipID> <item name|typeID> [amount]";
  const spaceAt = trimmed.search(/\s/);
  if (!trimmed || spaceAt < 0) {
    return handledResult(chatHub, session, options, usage);
  }
  const target = trimmed.slice(0, spaceAt).toLowerCase();
  const itemText = trimmed.slice(spaceAt + 1).trim();
  if (!session || !session.characterID) {
    return handledResult(chatHub, session, options, "Select a character before using /load.");
  }
  let shipID = 0;
  if (target === "me") {
    shipID = normalizePositiveInteger(
      (session._space && session._space.shipID) || session.shipID || session.shipid,
    );
  } else if (/^\d+$/.test(target)) {
    shipID = normalizePositiveInteger(Number(target));
  } else {
    return handledResult(chatHub, session, options, usage);
  }
  const shipItem = shipID ? findItemById(shipID) : null;
  const shipType = shipItem ? resolveItemByTypeID(Number(shipItem.typeID)) : null;
  if (
    !shipItem ||
    Number(shipItem.ownerID) !== Number(session.characterID) ||
    !shipType ||
    Number(shipType.categoryID) !== SHIP_CATEGORY_ID
  ) {
    return handledResult(chatHub, session, options, `No ship of yours to load: ${target}.`);
  }

  let itemLookup = resolveItemByName(itemText);
  let amount = 1;
  if (!itemLookup.success) {
    const split = splitTrailingAmount(itemText);
    if (split.lookupText && split.amount !== null) {
      const splitMatch = resolveItemByName(split.lookupText);
      if (splitMatch.success) {
        itemLookup = splitMatch;
        amount = normalizePositiveInteger(Math.trunc(split.amount));
      }
    }
  }
  if (!amount || !Number.isSafeInteger(amount)) {
    return handledResult(chatHub, session, options, "Item amount must be a positive whole number.");
  }
  if (!itemLookup.success) {
    const message =
      itemLookup.errorMsg === "ITEM_NOT_FOUND"
        ? `Item not found: ${itemText}.${formatSuggestions(itemLookup.suggestions)}`
        : `Item name is ambiguous: ${itemText}.${formatSuggestions(itemLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }
  const createsHull = Number(itemLookup.match.categoryID) === SHIP_CATEGORY_ID;
  const createsSingletonItems = !createsHull && CREATE_COMMAND_SINGLETON_CATEGORY_IDS.has(
    Number(itemLookup.match.categoryID),
  );
  const maximumAmount = createsSingletonItems
    ? CREATE_COMMAND_MAX_SINGLETON_ITEMS
    : CLIENT_INVENTORY_STACK_LIMIT * CREATE_COMMAND_MAX_SPLIT_STACKS;
  if (amount > maximumAmount) {
    return handledResult(chatHub, session, options, `Item amount is too large for one /load: ${itemLookup.match.name} is limited to ${maximumAmount.toLocaleString("en-US")}.`);
  }

  const giveResult = createItemInShipCargo(session, shipID, itemLookup.match, amount);
  if (!giveResult.success) {
    let message = "Item creation failed.";
    if (giveResult.errorMsg === "CAPSULE_HAS_NO_CARGO") {
      message = "A capsule has no cargo hold. Board a ship before using /load.";
    } else if (giveResult.errorMsg === "NOT_ENOUGH_CARGO_SPACE") {
      const formatM3 = (value) =>
        Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
      message =
        `Not enough cargo space for ${amount.toLocaleString("en-US")}x ${itemLookup.match.name}: ` +
        `it needs ${formatM3(giveResult.data.requiredVolume)} m3 and the cargo hold has ` +
        `${formatM3(giveResult.data.freeVolume)} m3 free.`;
    } else if (giveResult.errorMsg === "SHIP_NOT_FOUND") {
      message = "The ship to load could not be found.";
    }
    return handledResult(chatHub, session, options, message);
  }
  const itemIDs = (Array.isArray(giveResult.data && giveResult.data.items) ? giveResult.data.items : [])
    .map((item) => Number(item && item.itemID) || 0)
    .filter((itemID) => itemID > 0);
  return {
    handled: true,
    message: buildList(itemIDs),
  };
}

function handleMineralsCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /minerals.",
    );
  }

  const stationID = Number(getDockedLocationID(session) || 0) || 0;
  if (stationID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be docked before using /minerals.",
    );
  }

  const plan = getMineralsSeedPlan();
  if (!plan.entries.length) {
    return handledResult(
      chatHub,
      session,
      options,
      "No published mineral or ore types matched the /minerals filter in local reference data.",
    );
  }

  const existingItemIDs = listOwnedItems(Number(session.characterID) || 0, {
    locationID: stationID,
    flagID: ITEM_FLAGS.HANGAR,
  })
    .filter((item) => plan.allTypeIDs.has(Number(item && item.typeID) || 0))
    .map((item) => Number(item && item.itemID) || 0)
    .filter((itemID) => itemID > 0);

  const clearResult = removeStationHangarBatchAndSyncSession(
    session,
    stationID,
    existingItemIDs,
  );
  if (!clearResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Mineral and ore reset failed while clearing existing test stocks.",
    );
  }

  const grantResult = grantStationHangarBatchAndSyncSession(
    session,
    stationID,
    plan.entries,
  );
  if (!grantResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Mineral and ore grant failed.",
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    [
      `Re-seeded ${plan.mineralTypes.length.toLocaleString("en-US")} mineral stacks and ${plan.oreTypes.length.toLocaleString("en-US")} ore stacks in your station hangar.`,
      `Each stack now uses ${MINERALS_SEED_QUANTITY.toLocaleString("en-US")} units so the retail reprocessing UI stays stable.`,
      "Existing mineral/ore test stocks in the current station hangar were replaced. Includes published raw/compressed ore families and excludes ice plus decorative/non-interactable asteroid rows.",
    ].join(" "),
  );
}

function handleContainer1Command(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using .container1.",
    );
  }

  const stationID = Number(getDockedLocationID(session) || 0) || 0;
  if (stationID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be docked before using .container1.",
    );
  }

  const plan = getContainer1SeedPlan();
  if (plan.containerTypes.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No container types matched the .container1 filter in local reference data.",
    );
  }

  const grantResult = grantStationHangarBatchAndSyncSession(
    session,
    stationID,
    plan.entries,
  );
  if (!grantResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `.container1 test-kit grant failed: ${grantResult.errorMsg || "WRITE_ERROR"}.`,
    );
  }

  const unpublishedContainers = plan.containerTypes.filter(
    (itemType) => itemType && itemType.published === false,
  ).length;
  return handledResult(
    chatHub,
    session,
    options,
    [
      `Added the .container1 test kit to your station item hangar: ${plan.containerTypes.length} packaged container types, ${plan.mineralTypes.length} random mineral stacks, ${plan.oreTypes.length} random ore stacks, and ${plan.gearTypes.length} random packaged gear items.`,
      unpublishedContainers > 0
        ? `Containers include ${unpublishedContainers} unpublished/internal edge-case types.`
        : null,
      "Existing items were not removed.",
    ].filter(Boolean).join(" "),
  );
}

function handleGmShipsCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /gmships.",
    );
  }

  if (!isDockedSession(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be docked before using /gmships.",
    );
  }

  const unpublishedShips = getUnpublishedShipTypes();
  if (unpublishedShips.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No unpublished ship types are available in local reference data.",
    );
  }

  const createdShips = [];
  for (const shipType of unpublishedShips) {
    const spawnResult = spawnShipInHangarForSession(session, shipType);
    if (!spawnResult.success) {
      let message = "GM ship bulk spawn failed.";
      if (spawnResult.errorMsg === "DOCK_REQUIRED") {
        message = "You must be docked before using /gmships.";
      } else if (spawnResult.errorMsg === "CHARACTER_NOT_SELECTED") {
        message = "Select a character before using /gmships.";
      }
      return handledResult(chatHub, session, options, message);
    }
    createdShips.push(spawnResult.ship);
  }

  const sampleNames = unpublishedShips
    .slice(0, 5)
    .map((shipType) => `${shipType.name}(${shipType.typeID})`)
    .join(", ");

  return handledResult(
    chatHub,
    session,
    options,
    [
      `Added ${createdShips.length}/${unpublishedShips.length} unpublished ships to your hangar.`,
      sampleNames ? `Sample: ${sampleNames}.` : null,
    ].filter(Boolean).join(" "),
  );
}

function handlePropCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /prop.",
    );
  }

  if (!isDockedSession(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be docked before using /prop.",
    );
  }

  const propulsionTypes = getPropulsionCommandItemTypes();
  if (propulsionTypes.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No propulsion module types matched the /prop filter in local reference data.",
    );
  }

  const createdItems = [];
  for (const itemType of propulsionTypes) {
    const giveResult = giveItemToHangarForSession(session, itemType, 1);
    if (!giveResult.success) {
      let message = "Propulsion module grant failed.";
      if (giveResult.errorMsg === "DOCK_REQUIRED") {
        message = "You must be docked before using /prop.";
      } else if (giveResult.errorMsg === "CHARACTER_NOT_SELECTED") {
        message = "Select a character before using /prop.";
      } else if (giveResult.errorMsg === "ITEM_TYPE_NOT_FOUND") {
        message = `A /prop item type could not be resolved: ${itemType.name}.`;
      }
      return handledResult(chatHub, session, options, message);
    }
    createdItems.push(...(Array.isArray(giveResult.data.items) ? giveResult.data.items : []));
  }

  const sampleNames = propulsionTypes
    .slice(0, 8)
    .map((itemType) => `${itemType.name}(${itemType.typeID})`)
    .join(", ");

  return handledResult(
    chatHub,
    session,
    options,
    [
      `Added ${createdItems.length}/${propulsionTypes.length} propulsion modules to your station hangar.`,
      "Included: T2, faction, and officer afterburners/microwarpdrives.",
      sampleNames ? `Sample: ${sampleNames}.` : null,
    ].filter(Boolean).join(" "),
  );
}

function handleGmWeaponsCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /gmweapons.",
    );
  }

  const stationID = Number(getDockedLocationID(session) || 0) || 0;
  if (stationID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be docked before using /gmweapons.",
    );
  }

  if (activeGmWeaponsJobs.has(Number(session.characterID))) {
    const existingJob = activeGmWeaponsJobs.get(Number(session.characterID));
    return handledResult(
      chatHub,
      session,
      options,
      `A /gmweapons seed job is already running (${existingJob.nextIndex}/${existingJob.entries.length} grants queued).`,
    );
  }

  const plan = getGmWeaponsSeedPlan();
  if (!plan.entries.length) {
    return handledResult(
      chatHub,
      session,
      options,
      "No non-T1 weapon or ammo types matched the /gmweapons filter in local reference data.",
    );
  }

  const sample = plan.weaponTypes
    .slice(0, 6)
    .map((itemType) => `${itemType.name}(${itemType.typeID})`)
    .join(", ");

  const job = {
    session,
    characterID: Number(session.characterID) || 0,
    stationID,
    feedbackChannel: getFeedbackChannel(options),
    entries: plan.entries,
    nextIndex: 0,
    weaponTypeCount: plan.weaponTypes.length,
    ammoTypeCount: plan.ammoTypes.length,
    sample,
  };
  activeGmWeaponsJobs.set(job.characterID, job);
  setImmediate(() => continueGmWeaponsSeedJob(job, chatHub));

  return handledResult(
    chatHub,
    session,
    options,
    [
      `Started /gmweapons in the background for station ${stationID}.`,
      `Queue: ${plan.weaponTypes.length} weapon stacks x${GM_WEAPONS_MODULE_QUANTITY} and ${plan.ammoTypes.length} ammo stacks x${GM_WEAPONS_AMMO_QUANTITY}.`,
      sample ? `Sample: ${sample}.` : null,
    ].filter(Boolean).join(" "),
  );
}

module.exports = {
  getContainer1SeedPlan,
  getGmWeaponsSeedPlan,
  getPropulsionCommandItemTypes,
  handleShipSpawn,
  handleGiveItemCommand,
  handleCreateItemCommand,
  handleLoadCommand,
  handleMineralsCommand,
  handleContainer1Command,
  handleGmShipsCommand,
  handlePropCommand,
  handleGmWeaponsCommand,
};
