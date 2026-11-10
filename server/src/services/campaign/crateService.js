"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const { createRng } = require("../../common/random");

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const { throwWrappedUserError } = require(path.join(__dirname, "../../common/machoErrors"));
const {
  syncInventoryItemForSession,
  updateCharacterRecord,
} = require(path.join(
  __dirname,
  "../character/characterState",
));
const {
  ITEM_FLAGS,
  consumeInventoryItemQuantity,
  consumeInventoryItemStacksAtomic,
  findItemById,
  grantItemsToOwnerLocation,
  restoreInventoryItemChangesAtomic,
  transferItemToOwnerLocation,
} = require(path.join(__dirname, "../inventory/itemStore"));
const { resolveItemByTypeID } = require(path.join(
  __dirname,
  "../inventory/itemTypeRegistry",
));
const { unwrapMarshalValue } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const {
  OWNER_SCOPE,
  findFittingByID,
  saveFitting,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingStore"));
const {
  grantCharacterSkillLevels,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  emitSkillSessionState,
} = require(path.join(__dirname, "../skills/training/skillQueueNotifications"));

const GROUP_REWARD_CRATE = 1194;
const GROUP_STRONG_BOX = 1818;
const TYPE_TRITANIUM = 34;
const TYPE_GURISTAS_PRODUCTION_STRONG_BOX = 43697;
const TYPE_HARVESTER_MINING_DRONE_BLUEPRINT = 43934;
const electionCrates = require("../seasons/gallenteCrateRewards");
const {
  ensureGrantedBlueprintCopyState,
  isBlueprintCopyRewardType,
  resolveBlueprintLootCopyState,
} = require("../inventory/blueprintRewardState");
const MAX_MULTI_OPEN = 30;
const PENDING_CRATE_LOOT_FLAG_ID = 0;
let nextPendingLocationID = -9000000000000;
const pendingLootByItemID = new Map();
const pendingSkillBundlesByCrateID = new Map();
const pendingFittingsByCrateID = new Map();

function toInt(value, fallback = 0) {
  const numeric = Number(unwrapMarshalValue(value));
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function throwNotify(message) {
  throwWrappedUserError("CustomNotify", {
    notify: String(message || "That crate cannot be opened right now."),
  });
}

function getSessionCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
}

function getStackQuantity(item) {
  if (!item) {
    return 0;
  }
  if (toInt(item.singleton, 0) > 0) {
    return 1;
  }
  return Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
}

function getTypeName(typeID) {
  const typeRecord = resolveItemByTypeID(typeID);
  return String(typeRecord && typeRecord.name ? typeRecord.name : "");
}

function isSupportedCrateItem(item) {
  if (!item) {
    return false;
  }
  const groupID = toInt(item.groupID, 0);
  if (groupID === GROUP_REWARD_CRATE || groupID === GROUP_STRONG_BOX) {
    return true;
  }
  const name = String(item.itemName || getTypeName(item.typeID));
  return /\b(crate|gift box|strong box)\b/i.test(name) && groupID > 0;
}

function normalizeLootEntry(rawEntry) {
  const source = Array.isArray(rawEntry)
    ? { typeID: rawEntry[0], quantity: rawEntry[1], singleton: rawEntry[2] }
    : rawEntry && typeof rawEntry === "object"
      ? rawEntry
      : null;
  if (!source) {
    return null;
  }
  const typeID = toPositiveInt(source.typeID || source.itemTypeID, 0);
  const quantity = Math.max(1, toInt(source.quantity ?? source.stacksize, 1));
  const itemType = resolveItemByTypeID(typeID);
  if (!typeID || !itemType) {
    return null;
  }
  const entry = {
    typeID,
    quantity,
  };
  if (source.singleton !== undefined && source.singleton !== null) {
    entry.singleton = Math.max(0, toInt(source.singleton, 0));
  }
  if (Number(itemType.categoryID) === 9) {
    // Reward blueprints are copies unless the authored crate explicitly
    // requests an original. Quantity counts separate copies, never their runs.
    entry.singleton = source.original === true || !isBlueprintCopyRewardType(itemType) ? 1 : 2;
    if (entry.singleton === 1) {
      entry.original = true;
    } else {
      const blueprintSpec = {
        ...source,
        materialEfficiency: source.materialEfficiency ?? source.blueprintMaterialLevel,
        timeEfficiency: source.timeEfficiency ?? source.blueprintProductivityLevel,
      };
      // Parsing and previewing a crate must never roll its rewards. Resolve
      // explicit runs now to catch invalid metadata before any inventory write;
      // source policies and random fallback are selected per copy at grant time.
      try {
        if (["runsRemaining", "licensedRuns", "blueprintRuns"].some((key) => (
          source[key] !== undefined && source[key] !== null
        ))) {
          const blueprintState = resolveBlueprintLootCopyState(itemType, blueprintSpec);
          entry.blueprintRuns = blueprintState.runsRemaining;
          entry.materialEfficiency = blueprintState.materialEfficiency;
          entry.timeEfficiency = blueprintState.timeEfficiency;
        } else {
          for (const key of ["materialEfficiency", "timeEfficiency", "licensedRunsMin", "licensedRunsMax"]) {
            if (blueprintSpec[key] !== undefined && blueprintSpec[key] !== null) {
              entry[key] = blueprintSpec[key];
            }
          }
        }
      } catch (error) {
        if (!["BLUEPRINT_LOOT_RUNS_REQUIRED", "INVALID_BLUEPRINT_RUNS"].includes(error.code)) {
          throw error;
        }
        // Dropping this entry would let custom loot fall back to another reward
        // or consume the crate after delivering only its remaining entries.
        throwNotify("The crate blueprint reward has invalid licensed runs. The crate was not consumed.");
      }
    }
  }
  return entry;
}

function normalizeSkillGrantEntry(rawEntry) {
  const source = Array.isArray(rawEntry)
    ? { typeID: rawEntry[0], level: rawEntry[1] }
    : rawEntry && typeof rawEntry === "object"
      ? rawEntry
      : null;
  if (!source) {
    return null;
  }
  const typeID = toPositiveInt(source.typeID || source.skillTypeID, 0);
  const level = Math.max(
    1,
    Math.min(5, toInt(source.level ?? source.toLevel ?? source.trainedSkillLevel, 1)),
  );
  if (!typeID) {
    return null;
  }
  return {
    typeID,
    level,
  };
}

function normalizeSkillBundleEntry(rawEntry, fallbackSkillBundleID = 0) {
  const source = rawEntry && typeof rawEntry === "object" ? rawEntry : null;
  if (!source) {
    return null;
  }
  const skillBundleID = toPositiveInt(
    source.skillBundleID || source.bundleID || source.id,
    fallbackSkillBundleID,
  );
  if (!skillBundleID) {
    return null;
  }
  const rawSkills =
    source.skills ||
    source.skillLevels ||
    source.skillGrants ||
    source.grants ||
    [];
  const skills = (Array.isArray(rawSkills) ? rawSkills : [])
    .map(normalizeSkillGrantEntry)
    .filter(Boolean);
  const freeSkillPoints = Math.max(
    0,
    toInt(
      source.freeSkillPoints ??
        source.skillPoints ??
        source.unallocatedSkillPoints ??
        source.sp,
      0,
    ),
  );
  return {
    skillBundleID,
    freeSkillPoints,
    skills,
  };
}

function parseCustomLoot(item) {
  const customInfo = String(item && item.customInfo ? item.customInfo : "").trim();
  if (!customInfo) {
    return [];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(customInfo);
  } catch (_error) {
    // ignored: customInfo that is not JSON holds no custom loot
    return [];
  }
  const rawLoot =
    (parsed && parsed.evejsCrateLoot) ||
    (parsed && parsed.crateLoot) ||
    (parsed && parsed.loot);
  const entries = Array.isArray(rawLoot) ? rawLoot : [];
  return entries.map(normalizeLootEntry).filter(Boolean);
}

function parseCustomSkillBundles(item) {
  const customInfo = String(item && item.customInfo ? item.customInfo : "").trim();
  if (!customInfo) {
    return [];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(customInfo);
  } catch (_error) {
    // ignored: customInfo that is not JSON holds no skill bundles
    return [];
  }
  const rawBundles =
    (parsed && parsed.evejsCrateSkillBundles) ||
    (parsed && parsed.skillBundles) ||
    (parsed && parsed.skillBundle);
  if (!rawBundles) {
    return [];
  }
  if (Array.isArray(rawBundles)) {
    return rawBundles.map((entry) => normalizeSkillBundleEntry(entry)).filter(Boolean);
  }
  if (typeof rawBundles === "object") {
    if (
      rawBundles.skillBundleID ||
      rawBundles.bundleID ||
      rawBundles.id ||
      rawBundles.freeSkillPoints ||
      rawBundles.skillPoints ||
      rawBundles.skills
    ) {
      return [normalizeSkillBundleEntry(rawBundles)].filter(Boolean);
    }
    return Object.entries(rawBundles)
      .map(([skillBundleID, entry]) =>
        normalizeSkillBundleEntry(entry, toPositiveInt(skillBundleID, 0)),
      )
      .filter(Boolean);
  }
  return [];
}

function normalizeFittingID(rawEntry) {
  if (typeof rawEntry === "number" || typeof rawEntry === "string") {
    return toPositiveInt(rawEntry, 0);
  }
  const source = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  return toPositiveInt(source.fittingID || source.id, 0);
}

function parseCustomFittingIDs(item) {
  const customInfo = String(item && item.customInfo ? item.customInfo : "").trim();
  if (!customInfo) {
    return [];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(customInfo);
  } catch (_error) {
    // ignored: customInfo that is not JSON holds no fitting IDs
    return [];
  }
  const rawFittings =
    (parsed && parsed.evejsCrateFittings) ||
    (parsed && parsed.crateFittings) ||
    (parsed && parsed.fittings);
  const entries = Array.isArray(rawFittings) ? rawFittings : [rawFittings];
  return [...new Set(entries.map(normalizeFittingID).filter(Boolean))];
}

function buildFallbackLoot(item) {
  // Authored crate reward pools are not shipped in the SDE/client source dump.
  // Keep the fallback deliberately small and deterministic; tests and fixtures
  // can override it through item customInfo without creating broad content data.
  const crateTypeID = toPositiveInt(item && item.typeID, 0);
  return [{
    typeID: TYPE_TRITANIUM,
    quantity: 100 + (crateTypeID % 25),
  }];
}

function selectSourceCrateLoot(item, crateOffset = 0) {
  if (Number(item.typeID) !== TYPE_GURISTAS_PRODUCTION_STRONG_BOX) return null;
  // A one-run Harvester BPC is a reported reward from this box. No measured
  // retail probability is available: 5% is deliberately emulator tuning.
  // Seed each unit separately so preview, single-open, stack-open and restart
  // select the same reward for that unit without consuming random draws.
  const unit = Math.max(1, getStackQuantity(item) - crateOffset);
  const random = createRng(`crate-loot:${item.itemID}:${unit}`);
  if (random() >= 0.05) return buildFallbackLoot(item);
  return [{
    typeID: TYPE_HARVESTER_MINING_DRONE_BLUEPRINT,
    quantity: 1,
    licensedRuns: 1,
    materialEfficiency: 0,
    timeEfficiency: 0,
  }];
}

function selectCrateLoot(item, crateOffset = 0) {
  const customLoot = parseCustomLoot(item);
  return customLoot.length > 0 ? customLoot :
    selectSourceCrateLoot(item, crateOffset) || electionCrates.roll(item.typeID) || buildFallbackLoot(item);
}

function openElectionCrates(item, characterID, quantity, session) {
  // Deliver directly to the crate's original location in the same inventory
  // commit as consumption. Closing the reveal window or restarting cannot lose
  // rewards in the generic crate service's in-memory pending staging area.
  const loot = aggregateLootEntries(Array.from({length:quantity},()=>electionCrates.roll(item.typeID)).flat());
  const result = consumeInventoryItemStacksAtomic([{
    itemID:item.itemID, quantity, expectedQuantity:getStackQuantity(item),
    expectedOwnerID:characterID, expectedTypeID:item.typeID,
    expectedLocationID:item.locationID, expectedFlagID:item.flagID,
  }], {producedStacks:loot.map(entry=>({...entry,ownerID:characterID,
    locationID:item.locationID,flagID:item.flagID}))});
  if (!result.success) throwNotify("The election crate could not be opened. No items were exchanged.");
  const changes=result.changes || result.data?.changes || [];
  syncInventoryChanges(session,changes);
  const outputs=changes.filter(change=>!change.removed && change.item.typeID!==item.typeID).map(change=>change.item);
  for (const output of outputs) pendingLootByItemID.set(output.itemID,{characterID,delivered:true});
  return loot.map(entry=>[outputs.find(output=>output.typeID===entry.typeID).itemID,entry.typeID,entry.quantity]);
}

function aggregateLootEntries(entries = []) {
  const aggregate = new Map();
  for (const entry of entries) {
    const normalized = normalizeLootEntry(entry);
    if (!normalized) {
      continue;
    }
    const key = JSON.stringify([
      normalized.typeID, normalized.singleton || 0, normalized.original === true,
      normalized.blueprintRuns || 0, normalized.materialEfficiency,
      normalized.timeEfficiency, normalized.licensedRunsMin,
      normalized.licensedRunsMax,
    ]);
    const current = aggregate.get(key) || {
      ...normalized,
      quantity: 0,
    };
    current.quantity += normalized.quantity;
    aggregate.set(key, current);
  }
  return [...aggregate.values()];
}

function toGrantEntries(entries = []) {
  return entries
    .map(normalizeLootEntry)
    .filter(Boolean)
    .map((entry) => ({
      itemType: entry.typeID,
      quantity: entry.quantity,
      options: {
        singleton: entry.singleton || 0,
      },
    }));
}

function buildLootResponseItems(items = []) {
  return items
    .filter(Boolean)
    .map((item) => [
      toPositiveInt(item.itemID, 0),
      toPositiveInt(item.typeID, 0),
      getStackQuantity(item),
    ])
    .filter(([itemID, typeID, quantity]) => itemID > 0 && typeID > 0 && quantity > 0);
}

function syncInventoryChanges(session, changes = []) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(session, change.item, change.previousData || {}, {
      emitCfgLocation: false,
    });
  }
}

function validateOwnedCrate(itemID, session) {
  const characterID = getSessionCharacterID(session);
  if (!characterID) {
    throwNotify("You need an active character to open crates.");
  }
  const item = findItemById(itemID);
  if (!item || toPositiveInt(item.ownerID, 0) !== characterID) {
    throwNotify("That crate could not be found.");
  }
  if (!isSupportedCrateItem(item)) {
    throwNotify("That item is not a crate.");
  }
  if (getStackQuantity(item) <= 0) {
    throwNotify("That crate stack is empty.");
  }
  return {
    characterID,
    item,
  };
}

function rememberPendingLoot(items, context) {
  for (const item of items) {
    const itemID = toPositiveInt(item && item.itemID, 0);
    if (!itemID) {
      continue;
    }
    pendingLootByItemID.set(itemID, {
      characterID: context.characterID,
      crateItemID: context.crateItemID,
      crateTypeID: context.crateTypeID,
      pendingLocationID: context.pendingLocationID,
      destinationID: context.destinationID,
      destinationFlagID: context.destinationFlagID,
    });
  }
}

function rememberPendingSkillBundles(crateItem, characterID) {
  const bundles = parseCustomSkillBundles(crateItem);
  if (bundles.length === 0) {
    return;
  }
  const key = `${characterID}:${toPositiveInt(crateItem && crateItem.itemID, 0)}`;
  const byBundleID = new Map();
  for (const bundle of bundles) {
    byBundleID.set(bundle.skillBundleID, bundle);
  }
  pendingSkillBundlesByCrateID.set(key, byBundleID);
}

function takePendingSkillBundle(characterID, crateID, skillBundleID) {
  const key = `${characterID}:${crateID}`;
  const byBundleID = pendingSkillBundlesByCrateID.get(key);
  if (!byBundleID) {
    return null;
  }
  const bundle = byBundleID.get(skillBundleID) || null;
  if (!bundle) {
    return null;
  }
  byBundleID.delete(skillBundleID);
  if (byBundleID.size === 0) {
    pendingSkillBundlesByCrateID.delete(key);
  }
  return bundle;
}

function rememberPendingFittings(crateItem, characterID) {
  const fittingIDs = parseCustomFittingIDs(crateItem);
  if (fittingIDs.length === 0) {
    return;
  }
  const key = `${characterID}:${toPositiveInt(crateItem && crateItem.itemID, 0)}`;
  const pending = pendingFittingsByCrateID.get(key) || new Map();
  for (const fittingID of fittingIDs) {
    pending.set(fittingID, (pending.get(fittingID) || 0) + 1);
  }
  pendingFittingsByCrateID.set(key, pending);
}

function hasPendingFitting(characterID, crateID, fittingID) {
  const pending = pendingFittingsByCrateID.get(`${characterID}:${crateID}`);
  return Boolean(pending && (pending.get(fittingID) || 0) > 0);
}

function consumePendingFitting(characterID, crateID, fittingID) {
  const key = `${characterID}:${crateID}`;
  const pending = pendingFittingsByCrateID.get(key);
  const remaining = pending && (pending.get(fittingID) || 0);
  if (!pending || remaining <= 0) {
    return false;
  }
  if (remaining === 1) {
    pending.delete(fittingID);
  } else {
    pending.set(fittingID, remaining - 1);
  }
  if (pending.size === 0) {
    pendingFittingsByCrateID.delete(key);
  }
  return true;
}

function applySkillBundleToCharacter(session, characterID, bundle) {
  const changedSkills = grantCharacterSkillLevels(characterID, bundle.skills || []);
  let freeSkillPoints = null;
  if (bundle.freeSkillPoints > 0) {
    const updateResult = updateCharacterRecord(characterID, (record) => ({
      ...record,
      freeSkillPoints:
        Math.max(0, toInt(record && record.freeSkillPoints, 0)) +
        bundle.freeSkillPoints,
    }));
    if (!updateResult.success) {
      throwNotify("That skill bundle could not be claimed.");
    }
    freeSkillPoints = toInt(updateResult.data && updateResult.data.freeSkillPoints, 0);
  }

  emitSkillSessionState(session, characterID, changedSkills, {
    freeSkillPoints: freeSkillPoints === null ? undefined : freeSkillPoints,
  });
  if (session && typeof session.sendNotification === "function") {
    session.sendNotification("OnSkillBundleInjected", "clientID", [
      changedSkills.length,
      bundle.freeSkillPoints,
    ]);
  }
  return {
    changedSkillCount: changedSkills.length,
    freeSkillPoints: bundle.freeSkillPoints,
  };
}

function isPendingLootItem(item, session) {
  if (!item) {
    return false;
  }
  const characterID = getSessionCharacterID(session);
  if (!characterID || toPositiveInt(item.ownerID, 0) !== characterID) {
    return false;
  }
  const locationID = toInt(item.locationID, 0);
  if (locationID >= 0 || toInt(item.flagID, 0) !== PENDING_CRATE_LOOT_FLAG_ID) {
    return false;
  }
  const pending = pendingLootByItemID.get(toPositiveInt(item.itemID, 0));
  return !pending || pending.characterID === characterID;
}

function normalizeDestinationFromPending(itemID, destinationID, destinationFlagID) {
  const pending = pendingLootByItemID.get(toPositiveInt(itemID, 0));
  if (!pending) {
    return {
      destinationID: toPositiveInt(destinationID, 0),
      destinationFlagID: toInt(destinationFlagID, ITEM_FLAGS.HANGAR),
    };
  }
  const requestedDestinationID = toPositiveInt(destinationID, pending.destinationID);
  const requestedFlagID = toInt(destinationFlagID, pending.destinationFlagID);
  if (
    requestedDestinationID !== pending.destinationID ||
      requestedFlagID !== pending.destinationFlagID
  ) {
    throwNotify("That crate loot has a different claim destination.");
  }
  return {
    destinationID: pending.destinationID,
    destinationFlagID: pending.destinationFlagID,
  };
}

function buildCrateLootSource(item) {
  return {
    kind: "crate",
    crateTypeID: item.typeID,
    crateTypeName: getTypeName(item.typeID),
    // Roll again from the same source after a grant rollback. Inventory IDs
    // allocated during an unsuccessful grant must not change the reward stats.
    seed: `crate-blueprints:${item.itemID}:${getStackQuantity(item)}`,
  };
}

function grantLootToLocation({
  characterID,
  destinationID,
  destinationFlagID,
  lootEntries,
  source = {},
}) {
  const normalizedEntries = materializeLootEntries(lootEntries, source);
  // Keep this grant, blueprint initialization and the caller's crate consume
  // synchronous. Plain inventory writes debounce the same items-table snapshot;
  // the blueprint fence flushes only industryBlueprintState. There must be no
  // yield or items-table fence before consumption/rollback completes, otherwise
  // a restart could retain both the reward and its unconsumed source crate.
  const grantResult = grantItemsToOwnerLocation(
    characterID,
    destinationID,
    destinationFlagID,
    toGrantEntries(normalizedEntries),
  );
  if (!grantResult.success) {
    throwNotify("The crate rewards could not be created.");
  }
  const data = grantResult.data || {};
  const remainingCopies = (data.items || []).filter((item) => Number(item.singleton) === 2);
  for (const entry of normalizedEntries.filter((entry) => entry.blueprintRuns > 0)) {
    const copyItems = remainingCopies.filter((item) => item.typeID === entry.typeID)
      .slice(0, entry.quantity);
    const initialized = copyItems.length === entry.quantity && ensureGrantedBlueprintCopyState(
      copyItems,
      {
        runsRemaining: entry.blueprintRuns,
        materialEfficiency: entry.materialEfficiency,
        timeEfficiency: entry.timeEfficiency,
      },
    );
    if (!initialized || !initialized.success) {
      rollbackCrateGrant(data);
      throwNotify("The crate blueprint copies could not be created. The crate was not consumed.");
    }
    for (const item of copyItems) {
      remainingCopies.splice(remainingCopies.indexOf(item), 1);
    }
  }
  return data;
}

function materializeLootEntries(lootEntries, source = {}) {
  return lootEntries.map(normalizeLootEntry).filter(Boolean).flatMap((entry, entryIndex) => {
    const itemType = resolveItemByTypeID(entry.typeID);
    if (entry.singleton !== 2 || !isBlueprintCopyRewardType(itemType)) return [entry];
    let spec = entry;
    // A source record establishes the run count for this particular box, not
    // every Harvester copy. The box's full random reward pool is not available.
    // https://forums.eveonline.com/t/41004/2
    if (!entry.blueprintRuns && entry.licensedRunsMin === undefined && entry.licensedRunsMax === undefined &&
        Number(source.crateTypeID) === TYPE_GURISTAS_PRODUCTION_STRONG_BOX &&
        entry.typeID === TYPE_HARVESTER_MINING_DRONE_BLUEPRINT) {
      spec = {
        ...entry,
        licensedRuns: 1,
        materialEfficiency: entry.materialEfficiency ?? 0,
        timeEfficiency: entry.timeEfficiency ?? 0,
      };
    }
    return Array.from({ length: entry.quantity }, (_unused, copyIndex) => {
      const state = resolveBlueprintLootCopyState(itemType, spec, {
        ...source,
        ...(source.seed === undefined ? {} : { seed: `${source.seed}:${entryIndex}:${copyIndex}` }),
      });
      return {
        typeID: entry.typeID,
        singleton: 2,
        quantity: 1,
        blueprintRuns: state.runsRemaining,
        materialEfficiency: state.materialEfficiency,
        timeEfficiency: state.timeEfficiency,
      };
    });
  });
}

function rollbackCrateGrant(grant) {
  const result = restoreInventoryItemChangesAtomic(grant.changes || []);
  if (!result.success) {
    throwNotify("The crate reward inventory could not be restored.");
  }
  const copies = (grant.items || []).filter((item) => Number(item.singleton) === 2);
  if (copies.length > 0) {
    const { removeBlueprintState } = require("../industry/industryRuntimeState");
    for (const item of copies) {
      removeBlueprintState(item.itemID);
    }
  }
}

class CrateService extends BaseService {
  constructor() {
    super("crateService");
  }

  Handle_GetCrateLocation(args, session) {
    const itemID = toPositiveInt(args && args[0], 0);
    const { item } = validateOwnedCrate(itemID, session);
    return [
      toPositiveInt(item.locationID, 0),
      toInt(item.flagID, ITEM_FLAGS.HANGAR),
    ];
  }

  Handle_OpenCrate(args, session) {
    const itemID = toPositiveInt(args && args[0], 0);
    const { characterID, item } = validateOwnedCrate(itemID, session);
    if (electionCrates.getPool(item.typeID)) return openElectionCrates(item,characterID,1,session);
    const destinationID = toPositiveInt(item.locationID, 0);
    const destinationFlagID = toInt(item.flagID, ITEM_FLAGS.HANGAR);
    if (!destinationID) {
      throwNotify("That crate does not have a valid reward destination.");
    }

    const pendingLocationID = nextPendingLocationID;
    nextPendingLocationID -= 1;
    const lootEntries = selectCrateLoot(item);
    const pendingGrant = grantLootToLocation({
      characterID,
      destinationID: pendingLocationID,
      destinationFlagID: PENDING_CRATE_LOOT_FLAG_ID,
      lootEntries,
      source: buildCrateLootSource(item),
    });

    const consumeResult = consumeInventoryItemQuantity(item.itemID, 1);
    if (!consumeResult.success) {
      rollbackCrateGrant(pendingGrant);
      throwNotify("The crate could not be consumed.");
    }
    syncInventoryChanges(session, consumeResult.data && consumeResult.data.changes);

    rememberPendingSkillBundles(item, characterID);
    rememberPendingFittings(item, characterID);
    rememberPendingLoot(pendingGrant.items || [], {
      characterID,
      crateItemID: item.itemID,
      crateTypeID: item.typeID,
      pendingLocationID,
      destinationID,
      destinationFlagID,
    });
    return buildLootResponseItems(pendingGrant.items || []);
  }

  Handle_PeekInsideFixedCrate(args, session) {
    const itemID = toPositiveInt(args && args[0], 0);
    const { item } = validateOwnedCrate(itemID, session);
    // A random crate has possible outcomes, not a guaranteed preview roll.
    const pool=electionCrates.getPool(item.typeID);
    if(pool) return pool.map(entry=>[entry.typeID,1,""]);
    return selectCrateLoot(item).map((entry) => [
      entry.typeID,
      entry.quantity,
      "",
    ]);
  }

  Handle_ClaimLoot(args, session) {
    const itemID = toPositiveInt(args && args[0], 0);
    const item = findItemById(itemID);
    const delivered=pendingLootByItemID.get(itemID);
    if(delivered?.delivered && delivered.characterID===getSessionCharacterID(session)) return null;
    if (!isPendingLootItem(item, session)) {
      throwNotify("That crate reward is no longer available.");
    }
    const {
      destinationID,
      destinationFlagID,
    } = normalizeDestinationFromPending(itemID, args && args[1], args && args[2]);
    if (!destinationID) {
      throwNotify("That crate reward does not have a valid destination.");
    }

    const moveResult = transferItemToOwnerLocation(
      item.itemID,
      getSessionCharacterID(session),
      destinationID,
      destinationFlagID,
    );
    if (!moveResult.success) {
      throwNotify("That crate reward could not be claimed.");
    }
    pendingLootByItemID.delete(item.itemID);
    syncInventoryChanges(session, moveResult.data && moveResult.data.changes);
    return null;
  }

  Handle_ClaimLootFromCrateStack(args, session) {
    const itemID = toPositiveInt(args && args[0], 0);
    const requestedQuantity = Math.min(
      MAX_MULTI_OPEN,
      Math.max(1, toInt(args && args[1], 1)),
    );
    const { characterID, item } = validateOwnedCrate(itemID, session);
    if (electionCrates.getPool(item.typeID)) {
      const count=Math.min(requestedQuantity,getStackQuantity(item));
      openElectionCrates(item,characterID,count,session);
      return [count,requestedQuantity];
    }
    const destinationID = toPositiveInt(item.locationID, 0);
    const destinationFlagID = toInt(item.flagID, ITEM_FLAGS.HANGAR);
    if (!destinationID) {
      throwNotify("That crate does not have a valid reward destination.");
    }

    const cratesToOpen = Math.min(requestedQuantity, getStackQuantity(item));
    const lootEntries = aggregateLootEntries(
      Array.from({ length: cratesToOpen }, (_unused, index) => selectCrateLoot(item, index)).flat(),
    );
    const grantResult = grantLootToLocation({
      characterID,
      destinationID,
      destinationFlagID,
      lootEntries,
      source: buildCrateLootSource(item),
    });

    const consumeResult = consumeInventoryItemQuantity(item.itemID, cratesToOpen);
    if (!consumeResult.success) {
      rollbackCrateGrant(grantResult);
      throwNotify("The crate stack could not be consumed.");
    }

    syncInventoryChanges(session, consumeResult.data && consumeResult.data.changes);
    syncInventoryChanges(session, grantResult.changes || []);
    return [cratesToOpen, requestedQuantity];
  }

  Handle_ClaimSkillBundle(args, session) {
    const crateID = toPositiveInt(args && args[0], 0);
    const skillBundleID = toPositiveInt(args && args[1], 0);
    const characterID = getSessionCharacterID(session);
    if (!characterID || !crateID || !skillBundleID) {
      return null;
    }
    const bundle = takePendingSkillBundle(characterID, crateID, skillBundleID);
    if (!bundle) {
      return null;
    }
    return applySkillBundleToCharacter(session, characterID, bundle);
  }

  Handle_ClaimFitting(args, session) {
    const crateID = toPositiveInt(args && args[0], 0);
    const fittingID = toPositiveInt(args && args[1], 0);
    const characterID = getSessionCharacterID(session);
    if (!characterID || !crateID || !fittingID) {
      return null;
    }
    if (!hasPendingFitting(characterID, crateID, fittingID)) {
      return null;
    }
    const fitting = findFittingByID(fittingID);
    if (!fitting) {
      return null;
    }
    const saveResult = saveFitting(characterID, {
      shipTypeID: fitting.shipTypeID,
      name: fitting.name || `Crate Fitting ${fittingID}`,
      description: fitting.description || "",
      fitData: cloneValue(fitting.fitData || []),
    }, OWNER_SCOPE.CHARACTER);
    if (!saveResult.success) {
      return null;
    }
    consumePendingFitting(characterID, crateID, fittingID);
    return saveResult.data.fittingID;
  }
}

module.exports = CrateService;
module.exports._testing = {
  GROUP_REWARD_CRATE,
  GROUP_STRONG_BOX,
  MAX_MULTI_OPEN,
  PENDING_CRATE_LOOT_FLAG_ID,
  aggregateLootEntries,
  materializeLootEntries,
  isSupportedCrateItem,
  parseCustomLoot,
  parseCustomSkillBundles,
  parseCustomFittingIDs,
  selectCrateLoot,
  resetForTests() {
    nextPendingLocationID = -9000000000000;
    pendingLootByItemID.clear();
    pendingSkillBundlesByCrateID.clear();
    pendingFittingsByCrateID.clear();
  },
};
