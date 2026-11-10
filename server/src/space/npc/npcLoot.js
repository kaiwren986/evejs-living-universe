"use strict";

const path = require("path");

const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../../services/_shared/referenceData"));
const {
  ITEM_FLAGS,
  grantItemToCharacterLocation,
  restoreInventoryItemChangesAtomic,
} = require(path.join(__dirname, "../../services/inventory/itemStore"));
const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const { createRng, random } = require(path.join(__dirname, "../../common/random"));
const {
  isBlueprintCopyRewardType,
  resolveBlueprintLootCopyState,
  ensureGrantedBlueprintCopyState,
} = require("../../services/inventory/blueprintRewardState");
const {
  getNpcBlueprintLootSources,
  resolveNpcBlueprintLootMetadata,
} = require("./npcBlueprintLootSources");

const EXCLUDED_GROUP_NAMES = new Set([
  "wreck",
]);

const RULE_AMMO_GROUP_NAMES = new Set([
  "projectile ammo",
  "hybrid charge",
  "frequency crystal",
  "light missile",
  "heavy missile",
  "cruise missile",
  "rocket",
  "torpedo",
  "heavy assault missile",
]);

const RULE_MODULE_GROUP_NAMES = new Set([
  "energy weapon",
  "hybrid weapon",
  "projectile weapon",
  "missile launcher light",
  "missile launcher rapid light",
  "missile launcher heavy",
  "missile launcher heavy assault",
  "missile launcher cruise",
  "missile launcher rocket",
  "missile launcher torpedo",
  "armor repair unit",
  "armor plate",
  "armor hardener",
  "armor coating",
  "energized armor membrane",
  "shield booster",
  "shield extender",
  "shield hardener",
  "shield resistance amplifier",
  "capacitor recharger",
  "capacitor battery",
  "capacitor booster",
  "capacitor power relay",
  "capacitor flux coil",
  "shield power relay",
  "shield flux coil",
  "propulsion module",
]);

const RULE_UTILITY_GROUP_NAMES = new Set([
  "armor repair unit",
  "armor plate",
  "armor hardener",
  "armor coating",
  "energized armor membrane",
  "shield booster",
  "shield extender",
  "shield hardener",
  "shield resistance amplifier",
  "capacitor recharger",
  "capacitor battery",
  "capacitor booster",
  "capacitor power relay",
  "capacitor flux coil",
  "shield power relay",
  "shield flux coil",
  "propulsion module",
]);

const RULE_TRASH_GROUP_NAMES = new Set([
  "salvaged materials",
]);

const SPECIAL_GRADE_NAME_PATTERNS = [
  /\bdread guristas\b/i,
  /\bdomination\b/i,
  /\bdark blood\b/i,
  /\btrue sansha/i,
  /\bshadow serpentis\b/i,
  /\bofficer\b/i,
  /\boverseer\b/i,
  /\bdeadspace\b/i,
  /\bcommander\b/i,
  /\bblueprint\b/i,
  /\bmutaplasmid\b/i,
  /\babyssal\b/i,
  /\barch angel\b/i,
  /\bguardian\b/i,
  /\bimperial navy\b/i,
  /\bcaldari navy\b/i,
  /\bfederation navy\b/i,
  /\brepublic fleet\b/i,
  /\bnavy\b/i,
  /\bguristas\b/i,
  /\bserpentis\b/i,
  /\bblood\b/i,
  /\bsansha/i,
  /\bfleet\b/i,
  /\bshadow\b/i,
  /\bpolarized\b/i,
  /\bconcord\b/i,
  /\bthukker\b/i,
  /\bsisters\b/i,
  /\bmordu/i,
  /\bammatar\b/i,
  /\bkhanid\b/i,
  /\baugmented\b/i,
  /\bintegrated\b/i,
  /\bmodified\b/i,
  /\b[abcx]-type\b/i,
  /\bcivilian\b/i,
  /\bsyndicate\b/i,
  /\bsmuggler/i,
  /\bcosmos\b/i,
  /\bfestival\b/i,
  /\bevent\b/i,
];

let cachedGenericLootPool = null;
let cachedGenericLootPoolByTypeID = null;
let cachedRuleCandidatePools = null;
let cachedNpcDataModule = null;
let cachedNpcSourceTypes = null;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric >= 0 ? numeric : fallback;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function getNpcDataModule() {
  if (!cachedNpcDataModule) {
    cachedNpcDataModule = require(path.join(__dirname, "npcData"));
  }
  return cachedNpcDataModule;
}

function chooseRandomEntry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  return entries[Math.floor(random() * entries.length)] || null;
}

function chooseWeightedEntry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  let totalWeight = 0;
  for (const entry of entries) {
    totalWeight += Math.max(1, toPositiveInt(entry && entry.weight, 1));
  }
  if (totalWeight <= 0) {
    return chooseRandomEntry(entries);
  }

  let roll = random() * totalWeight;
  for (const entry of entries) {
    roll -= Math.max(1, toPositiveInt(entry && entry.weight, 1));
    if (roll < 0) {
      return entry;
    }
  }

  return entries[entries.length - 1] || null;
}

function getGenericLootPool() {
  if (cachedGenericLootPool) {
    return cachedGenericLootPool;
  }

  cachedGenericLootPool = readStaticRows(TABLE.ITEM_TYPES)
    .filter((entry) => (
      entry &&
      toPositiveInt(entry.typeID, 0) > 0 &&
      String(entry.name || "").trim().length > 0 &&
      entry.published !== false &&
      !EXCLUDED_GROUP_NAMES.has(String(entry.groupName || "").trim().toLowerCase())
    ));
  cachedGenericLootPoolByTypeID = new Map(
    cachedGenericLootPool.map((entry) => [toPositiveInt(entry && entry.typeID, 0), entry]),
  );

  return cachedGenericLootPool;
}

function getGenericLootPoolByTypeID() {
  if (!(cachedGenericLootPoolByTypeID instanceof Map)) {
    getGenericLootPool();
  }
  return cachedGenericLootPoolByTypeID instanceof Map
    ? cachedGenericLootPoolByTypeID
    : new Map();
}

function clearRuleCandidateCache() {
  cachedRuleCandidatePools = null;
}

function isLikelyStackable(itemType) {
  const categoryID = toPositiveInt(itemType && itemType.categoryID, 0);
  return categoryID === 4 || categoryID === 5 || categoryID === 8 || categoryID === 17 || categoryID === 25;
}

function isDamageableChargeType(itemType) {
  return (
    toPositiveInt(itemType && itemType.categoryID, 0) === 8 &&
    Number(getTypeAttributeValue(itemType && itemType.typeID, "crystalsGetDamaged")) > 0
  );
}

// Charges a pilot keeps rather than expends: laser and mining crystals, and the
// scripts that swap a module's mode. A gun burns ammo every cycle, so a stack of
// 200 rounds is a plausible drop; a crystal is refitted and reused, so the same
// selector's range turns into two dozen of an item nobody needs two of.
//
// crystalsGetDamaged alone is not the test. It marks a crystal that wears out,
// which is true of the T2, faction and mining crystals but false for the plain
// T1 frequency crystals (Radio S, Microwave S, ...) -- those never degrade at
// all, so they are the *least* consumable charges in the game and would slip
// through. Every group whose name ends in "crystal" or "script" is reusable, and
// no expendable group is named that way, so the group name carries the rest.
const REUSABLE_CHARGE_GROUP_NAME_PATTERN = /(?:crystal|script)$/;

// A drop is meant to be a handful of spares, not a resupply.
const REUSABLE_CHARGE_MAX_QUANTITY = 4;

function isReusableChargeType(itemType) {
  if (toPositiveInt(itemType && itemType.categoryID, 0) !== 8) {
    return false;
  }
  if (isDamageableChargeType(itemType)) {
    return true;
  }
  return REUSABLE_CHARGE_GROUP_NAME_PATTERN.test(
    normalizeLowerText(itemType && itemType.groupName),
  );
}

function resolveLootSingleton(itemType, authoredSingleton = null) {
  if (isBlueprintCopyRewardType(itemType)) {
    return 2;
  }
  if (isLikelyStackable(itemType)) {
    return isDamageableChargeType(itemType) && authoredSingleton === true;
  }
  // Generated modules have no fitted state and should arrive packaged. Keep
  // explicit singleton choices for authored loot and other item categories.
  return authoredSingleton === null
    ? toPositiveInt(itemType && itemType.categoryID, 0) !== 7
    : authoredSingleton === true;
}

function resolveExplicitLootItemType(typeID) {
  const normalizedTypeID = toPositiveInt(typeID, 0);
  if (normalizedTypeID <= 0) {
    return null;
  }

  return getGenericLootPoolByTypeID().get(normalizedTypeID) || null;
}

function isSpecialGradeItem(itemType) {
  const text = `${itemType && itemType.name || ""} ${itemType && itemType.groupName || ""}`;
  if (SPECIAL_GRADE_NAME_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  // Names miss some grades, e.g. storyline modules ("Small 'Settler' Shield Booster"); the
  // type's meta group names them all (2 Tech II, 3 storyline, 4 faction, 5 officer, 6 deadspace).
  return Number(getTypeAttributeValue(toPositiveInt(itemType && itemType.typeID, 0), "metaGroupID")) > 1;
}

function isTechTwoItem(itemType) {
  return /\bII\b/.test(String(itemType && itemType.name || ""));
}

function isBlueprintType(itemType) {
  return (
    toPositiveInt(itemType && itemType.categoryID, 0) === 9 ||
    normalizeLowerText(itemType && itemType.groupName).includes("blueprint") ||
    normalizeLowerText(itemType && itemType.name).includes("blueprint")
  );
}

function selectorAllowsSpecialGrade(selector = {}) {
  const grade = normalizeLowerText(selector.grade || selector.tier);
  return (
    selector.allowSpecialGrade === true ||
    ["faction", "commander", "deadspace", "officer", "special"].includes(grade)
  );
}

function normalizeSelectorList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeLowerText(entry))
      .filter(Boolean);
  }
  const normalized = normalizeLowerText(value);
  return normalized ? [normalized] : [];
}

function normalizeSelectorNumberList(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => toPositiveInt(entry, 0))
    .filter((entry) => entry > 0);
}

function itemMatchesTextFilters(itemType, selector = {}) {
  const itemName = normalizeLowerText(itemType && itemType.name);
  const groupName = normalizeLowerText(itemType && itemType.groupName);
  const itemText = `${itemName} ${groupName}`;
  const nameIncludes = [
    ...normalizeSelectorList(selector.nameIncludes),
    ...normalizeSelectorList(selector.itemNameIncludes),
  ];
  if (
    nameIncludes.length > 0 &&
    !nameIncludes.some((needle) => itemText.includes(needle))
  ) {
    return false;
  }

  const nameExcludes = [
    ...normalizeSelectorList(selector.nameExcludes),
    ...normalizeSelectorList(selector.itemNameExcludes),
  ];
  if (
    nameExcludes.length > 0 &&
    nameExcludes.some((needle) => itemText.includes(needle))
  ) {
    return false;
  }

  const groupNames = normalizeSelectorList(selector.groupNames || selector.groupName);
  if (groupNames.length > 0 && !groupNames.includes(groupName)) {
    return false;
  }

  const categoryIDs = normalizeSelectorNumberList(selector.categoryIDs || selector.categoryID);
  if (
    categoryIDs.length > 0 &&
    !categoryIDs.includes(toPositiveInt(itemType && itemType.categoryID, 0))
  ) {
    return false;
  }

  return true;
}

function isRuleEligibleBaseItem(itemType, selector = {}) {
  return (
    itemType &&
    toPositiveInt(itemType.typeID, 0) > 0 &&
    normalizeText(itemType.name) &&
    itemType.published !== false &&
    !isBlueprintType(itemType) &&
    (selectorAllowsSpecialGrade(selector) || !isSpecialGradeItem(itemType)) &&
    !isTechTwoItem(itemType)
  );
}

function hasAnyPattern(value, patterns) {
  const text = normalizeLowerText(value);
  return patterns.some((pattern) => pattern.test(text));
}

function ammoMatchesSizeBand(itemType, sizeBand) {
  const normalizedSizeBand = normalizeLowerText(sizeBand);
  if (!normalizedSizeBand) {
    return true;
  }

  const name = normalizeLowerText(itemType && itemType.name);
  const groupName = normalizeLowerText(itemType && itemType.groupName);
  if (normalizedSizeBand === "small") {
    return (
      /\b(s|small)\b$/.test(name) ||
      groupName.includes("light missile") ||
      groupName.includes("rocket")
    );
  }
  if (normalizedSizeBand === "medium") {
    return (
      /\b(m|medium)\b$/.test(name) ||
      groupName.includes("heavy missile") ||
      groupName.includes("heavy assault missile")
    );
  }
  if (normalizedSizeBand === "large") {
    return (
      /\b(l|large)\b$/.test(name) ||
      groupName.includes("cruise missile") ||
      groupName.includes("torpedo")
    );
  }
  return true;
}

function moduleMatchesSizeBand(itemType, sizeBand) {
  const normalizedSizeBand = normalizeLowerText(sizeBand);
  if (!normalizedSizeBand) {
    return true;
  }

  const text = `${itemType && itemType.name || ""} ${itemType && itemType.groupName || ""}`;
  if (normalizedSizeBand === "small") {
    return hasAnyPattern(text, [
      /\bsmall\b/i,
      /\blight\b/i,
      /\brocket\b/i,
      /\b125mm\b/i,
      /\b150mm\b/i,
      /\b200mm\b/i,
      /\b1mn\b/i,
      /\bmicro\b/i,
    ]);
  }
  if (normalizedSizeBand === "medium") {
    return hasAnyPattern(text, [
      /\bmedium\b/i,
      /\bheavy\b/i,
      /\bassault\b/i,
      /\b250mm\b/i,
      /\b350mm\b/i,
      /\b425mm\b/i,
      /\b10mn\b/i,
    ]);
  }
  if (normalizedSizeBand === "large") {
    return hasAnyPattern(text, [
      /\blarge\b/i,
      /\bcruise\b/i,
      /\btorpedo\b/i,
      /\b650mm\b/i,
      /\b720mm\b/i,
      /\b800mm\b/i,
      /\b1200mm\b/i,
      /\b1400mm\b/i,
      /\bmega\b/i,
      /\b100mn\b/i,
    ]);
  }
  return true;
}

function itemMatchesLootSelector(itemType, selector = {}) {
  if (!isRuleEligibleBaseItem(itemType, selector)) {
    return false;
  }
  if (!itemMatchesTextFilters(itemType, selector)) {
    return false;
  }

  const kind = normalizeLowerText(selector.kind || selector.type || "any");
  const groupName = normalizeLowerText(itemType.groupName);
  const categoryID = toPositiveInt(itemType.categoryID, 0);

  if (kind === "ammo" || kind === "charge") {
    return (
      categoryID === 8 &&
      RULE_AMMO_GROUP_NAMES.has(groupName) &&
      ammoMatchesSizeBand(itemType, selector.sizeBand)
    );
  }

  if (kind === "module") {
    return (
      categoryID === 7 &&
      RULE_MODULE_GROUP_NAMES.has(groupName) &&
      moduleMatchesSizeBand(itemType, selector.sizeBand)
    );
  }

  if (kind === "utility" || kind === "tank") {
    return (
      categoryID === 7 &&
      RULE_UTILITY_GROUP_NAMES.has(groupName) &&
      moduleMatchesSizeBand(itemType, selector.sizeBand)
    );
  }

  if (kind === "trash" || kind === "salvage") {
    return (
      (
        RULE_TRASH_GROUP_NAMES.has(groupName) ||
        /^metal scraps$/i.test(String(itemType.name || ""))
      ) &&
      !/skill|skin|blueprint|plex|extractor|injector|biomass/i.test(String(itemType.name || ""))
    );
  }

  return true;
}

function getRuleSelectorCacheKey(selector = {}) {
  return JSON.stringify({
    kind: normalizeLowerText(selector.kind || selector.type || "any"),
    sizeBand: normalizeLowerText(selector.sizeBand),
    tier: normalizeLowerText(selector.tier || "low"),
    grade: normalizeLowerText(selector.grade),
    allowSpecialGrade: selector.allowSpecialGrade === true,
    nameIncludes: [
      ...normalizeSelectorList(selector.nameIncludes),
      ...normalizeSelectorList(selector.itemNameIncludes),
    ],
    nameExcludes: [
      ...normalizeSelectorList(selector.nameExcludes),
      ...normalizeSelectorList(selector.itemNameExcludes),
    ],
    groupNames: normalizeSelectorList(selector.groupNames || selector.groupName),
    categoryIDs: normalizeSelectorNumberList(selector.categoryIDs || selector.categoryID),
  });
}

function getRuleCandidatePool(selector = {}) {
  if (!(cachedRuleCandidatePools instanceof Map)) {
    cachedRuleCandidatePools = new Map();
  }

  const cacheKey = getRuleSelectorCacheKey(selector);
  if (cachedRuleCandidatePools.has(cacheKey)) {
    return cachedRuleCandidatePools.get(cacheKey);
  }

  const pool = getGenericLootPool()
    .filter((itemType) => itemMatchesLootSelector(itemType, selector));
  cachedRuleCandidatePools.set(cacheKey, pool);
  return pool;
}

function rollQuantity(minimum, maximum) {
  const minQuantity = Math.max(1, toPositiveInt(minimum, 1));
  const maxQuantity = Math.max(minQuantity, toPositiveInt(maximum, minQuantity));
  return minQuantity + Math.floor(random() * ((maxQuantity - minQuantity) + 1));
}

// The authored ranges are written for ammo and are right for it. Rather than
// splitting every ammo selector in the data into ammo and crystal variants --
// an edit that would have to be redone on every content drop -- clamp the one
// item kind the range does not suit, at the point the quantity is rolled.
function rollLootQuantity(itemType, minimum, maximum) {
  if (!isReusableChargeType(itemType)) {
    return rollQuantity(minimum, maximum);
  }
  const authoredMax = Math.max(1, toPositiveInt(maximum, toPositiveInt(minimum, 1)));
  return rollQuantity(1, Math.min(authoredMax, REUSABLE_CHARGE_MAX_QUANTITY));
}

function buildLootBlueprintStates(itemType, entrySpec, quantity, source) {
  const hasRunMetadata = ["runsRemaining", "licensedRuns", "blueprintRuns", "licensedRunsMin", "licensedRunsMax"]
    .some((field) => entrySpec[field] !== undefined && entrySpec[field] !== null);
  const spec = hasRunMetadata ? entrySpec : {
    ...(resolveNpcBlueprintLootMetadata(itemType.typeID, source) || {}),
    ...entrySpec,
  };
  return Array.from({ length: quantity }, () => resolveBlueprintLootCopyState(itemType, spec, source));
}

function buildExplicitLootEntry(entrySpec = {}, source = {}) {
  const itemType = resolveExplicitLootItemType(entrySpec.typeID);
  if (!itemType) {
    return null;
  }

  const minQuantity = Math.max(
    1,
    toPositiveInt(
      entrySpec.minQuantity,
      toPositiveInt(entrySpec.quantity, 1),
    ),
  );
  const maxQuantity = Math.max(
    minQuantity,
    toPositiveInt(entrySpec.maxQuantity, minQuantity),
  );
  const singleton = resolveLootSingleton(
    itemType,
    typeof entrySpec.singleton === "boolean" ? entrySpec.singleton : null,
  );

  const quantity = singleton && singleton !== 2
    ? 1
    : rollLootQuantity(itemType, minQuantity, maxQuantity);
  const blueprintStates = singleton === 2
    ? buildLootBlueprintStates(itemType, entrySpec, quantity, source)
    : null;
  return {
    itemType,
    typeID: itemType.typeID,
    name: itemType.name,
    quantity,
    singleton,
    ...(blueprintStates ? { blueprintState: blueprintStates[0], blueprintStates } : {}),
  };
}

function buildRuleLootEntry(itemType, selector = {}, lootTable = {}) {
  if (!itemType) {
    return null;
  }

  const singleton = resolveLootSingleton(
    itemType,
    typeof selector.singleton === "boolean" ? selector.singleton : null,
  );
  // Packaging does not make modules use the bulk ammo/material drop counts.
  const bulkQuantity = isLikelyStackable(itemType) || selector.singleton === false;
  const quantity = singleton
    ? 1
    : rollLootQuantity(
      itemType,
      selector.minQuantity ?? selector.quantityMin ?? (bulkQuantity ? lootTable.stackableMinQuantity : 1),
      selector.maxQuantity ?? selector.quantityMax ?? (bulkQuantity ? lootTable.stackableMaxQuantity : 1),
    );

  return {
    itemType,
    typeID: itemType.typeID,
    name: itemType.name,
    quantity,
    singleton,
  };
}

function rollExplicitLootEntries(lootTable = null, source = {}) {
  if (!lootTable || typeof lootTable !== "object") {
    return [];
  }

  const lootEntries = [];
  const guaranteedEntries = Array.isArray(lootTable.guaranteedEntries)
    ? lootTable.guaranteedEntries
    : [];
  for (const entrySpec of guaranteedEntries) {
    const lootEntry = buildExplicitLootEntry(entrySpec, source);
    if (lootEntry) {
      lootEntries.push(lootEntry);
    }
  }

  const weightedEntries = (Array.isArray(lootTable.entries) ? lootTable.entries : [])
    .filter((entry) => toPositiveInt(entry && entry.typeID, 0) > 0);
  if (weightedEntries.length === 0) {
    return lootEntries;
  }

  const minEntries = toNonNegativeInt(lootTable.minEntries, 1);
  const maxEntries = Math.max(minEntries, toNonNegativeInt(lootTable.maxEntries, minEntries));
  const entryCount = minEntries + Math.floor(random() * ((maxEntries - minEntries) + 1));
  const allowDuplicates = lootTable.allowDuplicates === true;
  const candidateEntries = [...weightedEntries];

  for (let index = 0; index < entryCount; index += 1) {
    if (candidateEntries.length === 0) {
      break;
    }

    const chosenSpec = chooseWeightedEntry(candidateEntries);
    if (!chosenSpec) {
      continue;
    }

    const lootEntry = buildExplicitLootEntry(chosenSpec, source);
    if (lootEntry) {
      lootEntries.push(lootEntry);
    }

    if (!allowDuplicates) {
      const chosenIndex = candidateEntries.indexOf(chosenSpec);
      if (chosenIndex >= 0) {
        candidateEntries.splice(chosenIndex, 1);
      }
    }
  }

  return lootEntries;
}

function rollRequiredLootEntries(lootTable = null, source = {}) {
  if (!lootTable || typeof lootTable !== "object") {
    return [];
  }
  const requiredDrops = Array.isArray(lootTable.requiredDrops)
    ? lootTable.requiredDrops
    : [];
  const entries = [];
  for (const entrySpec of requiredDrops) {
    const lootEntry = buildExplicitLootEntry(entrySpec, source);
    if (lootEntry) {
      entries.push(lootEntry);
    }
  }
  return entries;
}

function getBaseRuleID(lootTable = null) {
  return normalizeText(lootTable && (
    lootTable.baseRuleID ||
    lootTable.baseLootTableID
  ));
}

function resolveBaseLootTable(baseRuleID) {
  const normalizedBaseRuleID = normalizeText(baseRuleID);
  if (!normalizedBaseRuleID) {
    return null;
  }
  const npcData = getNpcDataModule();
  return npcData && typeof npcData.getNpcLootTable === "function"
    ? npcData.getNpcLootTable(normalizedBaseRuleID)
    : null;
}

function rollRuleLootEntries(lootTable = null) {
  if (!lootTable || typeof lootTable !== "object") {
    return [];
  }

  const emptyChance = Math.max(0, Math.min(1, Number(lootTable.emptyChance) || 0));
  if (emptyChance > 0 && random() < emptyChance) {
    return [];
  }

  const selectors = (Array.isArray(lootTable.selectors) ? lootTable.selectors : [])
    .filter((selector) => selector && typeof selector === "object");
  if (selectors.length === 0) {
    return [];
  }

  const minEntries = toNonNegativeInt(lootTable.minEntries, 0);
  const maxEntries = Math.max(minEntries, toNonNegativeInt(lootTable.maxEntries, minEntries));
  const entryCount = minEntries + Math.floor(random() * ((maxEntries - minEntries) + 1));
  if (entryCount <= 0) {
    return [];
  }

  const allowDuplicates = lootTable.allowDuplicates === true;
  const lootEntries = [];
  const usedTypeIDs = new Set();
  let candidateSelectors = selectors
    .map((selector) => ({
      selector,
      weight: Math.max(1, toPositiveInt(selector.weight, 1)),
      pool: getRuleCandidatePool(selector),
    }))
    .filter((entry) => entry.pool.length > 0);

  for (let index = 0; index < entryCount; index += 1) {
    if (candidateSelectors.length === 0) {
      break;
    }

    const selected = chooseWeightedEntry(candidateSelectors);
    if (!selected) {
      break;
    }

    const availablePool = allowDuplicates
      ? selected.pool
      : selected.pool.filter((itemType) => !usedTypeIDs.has(toPositiveInt(itemType && itemType.typeID, 0)));
    if (availablePool.length <= 0) {
      candidateSelectors = candidateSelectors.filter((entry) => entry !== selected);
      index -= 1;
      continue;
    }

    const itemType = chooseRandomEntry(availablePool);
    const lootEntry = buildRuleLootEntry(itemType, selected.selector, lootTable);
    if (!lootEntry) {
      continue;
    }
    usedTypeIDs.add(toPositiveInt(lootEntry.typeID, 0));
    lootEntries.push(lootEntry);
  }

  return lootEntries;
}

function rollNpcLootEntriesInternal(lootTable = null, visitedBaseRuleIDs = new Set(), source = {}) {
  const pool = getGenericLootPool();
  if (!lootTable || pool.length === 0) {
    return [];
  }

  const baseRuleID = getBaseRuleID(lootTable);
  const baseEntries = [];
  if (baseRuleID && !visitedBaseRuleIDs.has(baseRuleID)) {
    visitedBaseRuleIDs.add(baseRuleID);
    baseEntries.push(...rollNpcLootEntriesInternal(
      resolveBaseLootTable(baseRuleID),
      visitedBaseRuleIDs,
      source,
    ));
  }

  const requiredEntries = rollRequiredLootEntries(lootTable, source);
  if (baseRuleID) {
    return [
      ...baseEntries,
      ...requiredEntries,
    ];
  }

  if (
    normalizeLowerText(lootTable.mode) === "rule" ||
    Array.isArray(lootTable.selectors)
  ) {
    return [
      ...rollRuleLootEntries(lootTable),
      ...requiredEntries,
    ];
  }

  const hasExplicitLootEntries =
    Array.isArray(lootTable.entries) &&
    lootTable.entries.length > 0;
  const hasGuaranteedLootEntries =
    Array.isArray(lootTable.guaranteedEntries) &&
    lootTable.guaranteedEntries.length > 0;
  if (hasExplicitLootEntries || hasGuaranteedLootEntries) {
    return [
      ...rollExplicitLootEntries(lootTable, source),
      ...requiredEntries,
    ];
  }
  if (
    lootTable.disableRandomLoot === true ||
    (
      toNonNegativeInt(lootTable.minEntries, 1) === 0 &&
      toNonNegativeInt(lootTable.maxEntries, 1) === 0
    )
  ) {
    return requiredEntries;
  }

  const minEntries = toPositiveInt(lootTable.minEntries, 1);
  const maxEntries = Math.max(minEntries, toPositiveInt(lootTable.maxEntries, minEntries));
  const entryCount = minEntries + Math.floor(random() * ((maxEntries - minEntries) + 1));
  const lootEntries = [];
  // Malformed authored metadata is a content error even if this roll happens
  // to pick a non-blueprint. Missing metadata uses the owner's fallback policy.
  if (["runsRemaining", "licensedRuns", "blueprintRuns", "licensedRunsMin", "licensedRunsMax"]
    .some((field) => lootTable[field] !== undefined && lootTable[field] !== null)) {
    const blueprintType = pool.find(isBlueprintCopyRewardType);
    if (blueprintType) resolveBlueprintLootCopyState(blueprintType, lootTable, source);
  }

  for (let index = 0; index < entryCount; index += 1) {
    const itemType = chooseRandomEntry(pool);
    if (!itemType) {
      continue;
    }

    const stackableMinQuantity = toPositiveInt(lootTable.stackableMinQuantity, 1);
    const stackableMaxQuantity = Math.max(
      stackableMinQuantity,
      toPositiveInt(lootTable.stackableMaxQuantity, stackableMinQuantity),
    );
    const singleton = resolveLootSingleton(itemType);
    const quantity = !singleton && isLikelyStackable(itemType)
      ? rollLootQuantity(itemType, stackableMinQuantity, stackableMaxQuantity)
      : 1;

    lootEntries.push({
      itemType,
      typeID: itemType.typeID,
      name: itemType.name,
      quantity,
      singleton,
      ...(singleton === 2 ? {
        blueprintState: buildLootBlueprintStates(itemType, lootTable, 1, source)[0],
      } : {}),
    });
  }

  return [
    ...lootEntries,
    ...requiredEntries,
  ];
}

function rollNpcLootEntries(lootTable = null, options = {}) {
  const source = { ...(options.source || {}) };
  source.random = options.random || source.random ||
    (source.seed !== undefined && source.seed !== null ? createRng(source.seed) : random);
  source.lootTableID = source.lootTableID || lootTable && lootTable.lootTableID;
  if (Number(source.npcTypeID) > 0 && (!source.npcTypeName || !source.npcGroupName)) {
    if (!cachedNpcSourceTypes) {
      cachedNpcSourceTypes = new Map(readStaticRows(TABLE.ITEM_TYPES)
        .map((entry) => [Number(entry.typeID), entry]));
    }
    const npcType = cachedNpcSourceTypes.get(Number(source.npcTypeID));
    if (npcType) {
      source.npcTypeName = source.npcTypeName || npcType.name;
      source.npcGroupName = source.npcGroupName || npcType.groupName;
    }
  }
  const entries = rollNpcLootEntriesInternal(lootTable, new Set(), source);
  const authoredTypeIDs = new Set([...entries.map((entry) => Number(entry.typeID)),
    ...["entries", "guaranteedEntries", "requiredDrops"]
    .flatMap((field) => Array.isArray(lootTable && lootTable[field]) ? lootTable[field] : [])
    .map((entry) => Number(entry.typeID))]);
  for (const record of getNpcBlueprintLootSources(source)) {
    const candidates = record.rewards.filter((entry) => !authoredTypeIDs.has(Number(entry.typeID)));
    if (candidates.length === 0 || (record.chance < 1 && source.random() >= record.chance)) continue;
    const selected = candidates.length === 1 ? candidates[0]
      : candidates[Math.min(candidates.length - 1, Math.floor(source.random() * candidates.length))];
    const entry = buildExplicitLootEntry(selected, source);
    if (entry) entries.push({ ...entry, blueprintSourceID: record.sourceID });
  }
  return entries;
}

function seedNpcShipLoot(characterID, shipID, lootTable = null, options = {}) {
  const lootEntries = rollNpcLootEntries(lootTable, options);
  const changes = [];
  const copyItemIDs = [];
  const compensate = (failure) => {
    // Grant changes retain exact pre-merge rows, so compensation restores old
    // stack quantities and removes only inventory created by this invocation.
    const restored = restoreInventoryItemChangesAtomic(changes);
    if (!restored.success) return { ...failure, ambiguous: true,
      compensationError: restored.errorMsg || "NPC_LOOT_COMPENSATION_FAILED" };
    if (copyItemIDs.length > 0) {
      const industry = require("../../services/industry/industryRuntimeState");
      const database = require("../../gameStore");
      let removed = true;
      for (const itemID of copyItemIDs) {
        if (!industry.removeBlueprintState(itemID)) removed = false;
      }
      const flushed = database.flushTableSync("industryBlueprintState");
      if (!removed || !flushed || !flushed.success) return { ...failure, ambiguous: true,
        compensationError: "NPC_LOOT_BLUEPRINT_COMPENSATION_FAILED" };
    }
    return failure;
  };

  for (const lootEntry of lootEntries) {
    const grantResult = grantItemToCharacterLocation(
      characterID,
      shipID,
      ITEM_FLAGS.CARGO_HOLD,
      lootEntry.itemType,
      lootEntry.quantity,
      {
        singleton: lootEntry.singleton,
        transient: options.transient === true,
      },
    );
    if (!grantResult.success) {
      return compensate(grantResult);
    }
    changes.push(...((grantResult.data && grantResult.data.changes) || []));

    if (lootEntry.singleton === 2) {
      copyItemIDs.push(...grantResult.data.items.map((item) => item.itemID));
      for (const [index, item] of grantResult.data.items.entries()) {
        const copyStateResult = ensureGrantedBlueprintCopyState(
          [item],
          lootEntry.blueprintStates && lootEntry.blueprintStates[index] || lootEntry.blueprintState,
        );
        if (!copyStateResult.success) {
          return compensate(copyStateResult);
        }
      }
    }
  }

  return {
    success: true,
    data: {
      lootEntries: lootEntries.map((entry) => ({
        typeID: entry.typeID,
        name: entry.name,
        quantity: entry.quantity,
      })),
      changes,
    },
  };
}

module.exports = {
  rollNpcLootEntries,
  seedNpcShipLoot,
  _testing: {
    clearRuleCandidateCache,
    getRuleCandidatePool,
    itemMatchesLootSelector,
  },
};
