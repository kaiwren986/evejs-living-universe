"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  getCharacterRecord,
  getActiveShipRecord,
} = require(path.join(__dirname, "../character/characterState"));
const standingRuntime = require(path.join(
  __dirname,
  "../character/standingRuntime",
));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  ITEM_FLAGS,
  CLIENT_INVENTORY_STACK_LIMIT,
  findItemById,
  getItemMetadata,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  GROUP_AUDIT_LOG_SECURE_CONTAINER,
} = require(path.join(__dirname, "../ship/cargoContainerRuntime"));
const {
  floorAfterNormalizing,
} = require(path.join(__dirname, "../_shared/floatPrecision"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  getAttributeIDByNames,
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  applyDogmaModifierGroups,
  getActiveImplantCharacterModifierEntries,
} = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));
const {
  getDockedLocationID,
  getDockedLocationKind,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  getStationRecord,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  getStructureByID,
} = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_SERVICE_ID,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "../structure/structurePayloads"));
const {
  getFacilityTaxRate,
} = require(path.join(__dirname, "../industry/industryFacilityState"));
const {
  canTakeFromCorporationHangarDivision,
  canTakeFromOwnerLocation,
  canViewOwnerLocation,
  getSessionCharacterID,
  getSessionCorporationID,
} = require(path.join(__dirname, "../industry/industryAccess"));
const {
  getCorporationOfficeByInventoryID,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  prepareReprocessingSettlement,
  settleReprocessingSettlement,
} = require("./reprocessingSettlementState");
const {
  ATTRIBUTE_GAS_DECOMPRESSION_EFFICIENCY_BONUS,
  ATTRIBUTE_REFINING_YIELD_MUTATOR,
  DEFAULT_STATION_REPROCESSING_EFFICIENCY,
  DEFAULT_STATION_REPROCESSING_TAX,
  NPC_STANDING_TAX_ZERO_POINT,
  STRUCTURE_DEFAULT_GAS_DECOMPRESSION_EFFICIENCY,
  STRUCTURE_DEFAULT_REPROCESSING_EFFICIENCY,
  TYPE_GAS_DECOMPRESSION_EFFICIENCY,
  TYPE_REPROCESSING,
  TYPE_REPROCESSING_EFFICIENCY,
  TYPE_SCRAPMETAL_PROCESSING,
} = require("./reprocessingConstants");
const {
  getAdjustedAveragePrice,
  getCompressionSourceTypeIDs,
  getCompressedTypeID,
  getReprocessingRigProfile,
  getReprocessingProfile,
  getStructureReprocessingProfile,
  getTypeMaterials,
  getTypeRandomizedMaterials,
  hasTypeMaterials,
  isCompressedType,
  isCompressibleType,
  pickRandomizedMaterialTypesByWeight,
  typeHasRandomizedMaterials,
  getAverageRandomizedMaterialsPerBatch,
} = require("./reprocessingStaticData");
const {
  getReprocessingFacilityRigTypeIDs,
} = require("./reprocessingFacilityState");

const ATTRIBUTE_REFINING_YIELD_PERCENTAGE_CHAR =
  getAttributeIDByNames("refiningYieldPercentageChar") || 378;
const AUDIT_LOG_RETENTION_TICKS = 21n * 24n * 60n * 60n * 10000000n;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function round2(value) {
  return Number(toFiniteNumber(value, 0).toFixed(2));
}

function isClientSafeRecoverableQuantity(value) {
  return (
    Number.isFinite(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= CLIENT_INVENTORY_STACK_LIMIT
  );
}

function getInventoryQuantity(item) {
  if (!item) {
    return 0;
  }
  return toInt(
    item.singleton === 1 ? 1 : item.stacksize ?? item.quantity,
    item.singleton === 1 ? 1 : 0,
  );
}

function isLockedAuditLogContainerEntryOrDescendant(rootItem) {
  let item = rootItem;
  const seen = new Set();

  while (item) {
    const itemID = toInt(item.itemID, 0);
    if (itemID <= 0 || seen.has(itemID)) {
      return false;
    }
    seen.add(itemID);

    const parent = findItemById(toInt(item.locationID, 0));
    if (!parent) {
      return false;
    }
    const parentMetadata = getItemMetadata(
      toInt(parent.typeID, 0),
      parent.itemName,
    );
    const parentGroupID = toInt(
      parent.groupID,
      toInt(parentMetadata && parentMetadata.groupID, 0),
    );
    if (
      toInt(item.flagID, 0) === ITEM_FLAGS.LOCKED &&
      parentGroupID === GROUP_AUDIT_LOG_SECURE_CONTAINER
    ) {
      return true;
    }

    item = parent;
  }

  return false;
}

function containsRetainedAuditLogContainer(rootItem, nowFiletime = currentFileTime()) {
  const pending = rootItem ? [rootItem] : [];
  const seen = new Set();
  const cutoff = nowFiletime - AUDIT_LOG_RETENTION_TICKS;
  while (pending.length > 0) {
    const item = pending.pop();
    const itemID = toInt(item && item.itemID, 0);
    if (itemID <= 0 || seen.has(itemID)) {
      continue;
    }
    seen.add(itemID);
    const metadata = getItemMetadata(
      toInt(item && item.typeID, 0),
      item && item.itemName,
    );
    if (
      toInt(item && item.groupID, toInt(metadata && metadata.groupID, 0)) ===
      GROUP_AUDIT_LOG_SECURE_CONTAINER
    ) {
      const state =
        item &&
        item.secureContainerState &&
        typeof item.secureContainerState === "object" &&
        !Array.isArray(item.secureContainerState)
          ? item.secureContainerState
          : {};
      const hasRetainedEntry = (Array.isArray(state.auditLog)
        ? state.auditLog
        : []).some((entry) => {
        try {
          return BigInt(String(entry && entry.logDate || "0")) >= cutoff;
        } catch (error) {
          // ignored: an audit entry with an unreadable date is not retained (false)
          return false;
        }
      });
      if (hasRetainedEntry) {
        return true;
      }
    }
    pending.push(...listContainerItems(null, itemID, null));
  }
  return false;
}

function getSkillLevel(skillMap, skillTypeID) {
  const numericSkillTypeID = toInt(skillTypeID, 0);
  if (numericSkillTypeID <= 0 || !(skillMap instanceof Map)) {
    return 0;
  }
  const record = skillMap.get(numericSkillTypeID);
  if (!record) {
    return 0;
  }
  return Math.max(
    0,
    toInt(
      record.effectiveSkillLevel ??
        record.trainedSkillLevel ??
        record.skillLevel,
      0,
    ),
  );
}

function getSkillBonusMultiplier(skillMap, skillTypeID) {
  const numericSkillTypeID = toInt(skillTypeID, 0);
  if (numericSkillTypeID <= 0) {
    return 1;
  }
  const level = getSkillLevel(skillMap, numericSkillTypeID);
  if (level <= 0) {
    return 1;
  }
  const percentagePerLevel = toFiniteNumber(
    getTypeAttributeValue(numericSkillTypeID, ATTRIBUTE_REFINING_YIELD_MUTATOR),
    0,
  );
  return 1 + ((level * percentagePerLevel) / 100);
}

function typeHasSpecialReprocessingSkillBonuses(typeID) {
  const profile = getReprocessingProfile(typeID);
  return Boolean(profile && toInt(profile.reprocessingSkillType, 0) > 0);
}

function getActiveReprocessingImplantMultiplier(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return null;
  }

  const entries = getActiveImplantCharacterModifierEntries(numericCharacterID)
    .filter((entry) => (
      toInt(entry && entry.modifiedAttributeID, 0) ===
        ATTRIBUTE_REFINING_YIELD_PERCENTAGE_CHAR
    ));
  if (entries.length <= 0) {
    return 1;
  }

  const characterAttributes = {
    [ATTRIBUTE_REFINING_YIELD_PERCENTAGE_CHAR]: 100,
  };
  applyDogmaModifierGroups(characterAttributes, entries);
  return Math.max(
    0,
    toFiniteNumber(
      characterAttributes[ATTRIBUTE_REFINING_YIELD_PERCENTAGE_CHAR],
      100,
    ) / 100,
  );
}

function getLegacyReprocessingImplantMultiplier(implants = []) {
  let multiplier = 1;
  for (const implant of Array.isArray(implants) ? implants : []) {
    const implantTypeID = toInt(implant && (implant.typeID ?? implant.itemID), 0);
    if (implantTypeID <= 0) {
      continue;
    }
    const implantBonus = toFiniteNumber(
      getTypeAttributeValue(implantTypeID, ATTRIBUTE_REFINING_YIELD_MUTATOR),
      0,
    );
    if (implantBonus > 0) {
      multiplier *= 1 + (implantBonus / 100);
    }
  }
  return multiplier;
}

function getReprocessingSkillMultiplierForType(typeID, skillMap, implants = []) {
  if (typeHasSpecialReprocessingSkillBonuses(typeID)) {
    const profile = getReprocessingProfile(typeID);
    let multiplier =
      getSkillBonusMultiplier(skillMap, TYPE_REPROCESSING) *
      getSkillBonusMultiplier(skillMap, TYPE_REPROCESSING_EFFICIENCY) *
      getSkillBonusMultiplier(skillMap, profile && profile.reprocessingSkillType);
    return multiplier * getLegacyReprocessingImplantMultiplier(implants);
  }

  return getSkillBonusMultiplier(skillMap, TYPE_SCRAPMETAL_PROCESSING);
}

function getGasDecompressionCharacterEfficiency(skillMap) {
  const level = getSkillLevel(skillMap, TYPE_GAS_DECOMPRESSION_EFFICIENCY);
  if (level <= 0) {
    return 0;
  }
  const bonusPerLevelPercent = toFiniteNumber(
    getTypeAttributeValue(
      TYPE_GAS_DECOMPRESSION_EFFICIENCY,
      ATTRIBUTE_GAS_DECOMPRESSION_EFFICIENCY_BONUS,
    ),
    0,
  );
  return Math.max(0, (level * bonusPerLevelPercent) / 100);
}

// An in-space compression facility's reach is a property of the compressor
// module, not of the pilot, so it is resolved from the module's own live
// `maxRange` in `space/runtime.js#resolveCompressionFacilityRangeMeters`.
// Fleet Compression Logistics reaches it there through ordinary dogma
// (effect 8372), so there is no skill-only form of this number.

function resolveReprocessingContext(session) {
  const characterID = getSessionCharacterID(session);
  if (characterID <= 0) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const dockedLocationID = toInt(getDockedLocationID(session), 0);
  if (dockedLocationID <= 0) {
    return {
      success: false,
      errorMsg: "NOT_DOCKED",
    };
  }

  const dockedKind = getDockedLocationKind(session);
  const stationRecord = getStationRecord(session, dockedLocationID);
  const structure =
    dockedKind === "structure"
      ? getStructureByID(dockedLocationID, { refresh: false })
      : null;
  if (dockedKind === "structure") {
    if (
      !characterHasStructureService(
        session,
        structure,
        STRUCTURE_SERVICE_ID.REPROCESSING,
      )
    ) {
      return {
        success: false,
        errorMsg: "REPROCESSING_OFFLINE",
      };
    }
  }

  const characterRecord = getCharacterRecord(characterID) || {};
  return {
    success: true,
    data: {
      characterID,
      corporationID: getSessionCorporationID(session),
      dockedLocationID,
      dockedKind,
      stationRecord,
      structure,
      skillMap: getCachedCharacterSkillMap(characterID),
      implants: Array.isArray(characterRecord.implants) ? characterRecord.implants : [],
      standing: standingRuntime.resolveBestStandingValue(
        characterID,
        stationRecord && stationRecord.ownerID,
      ).standing,
    },
  };
}

function resolveStructureSecurityBand(context) {
  if (!context || context.dockedKind !== "structure") {
    return null;
  }

  const solarSystemID = toInt(
    context.structure && context.structure.solarSystemID,
    context.stationRecord && context.stationRecord.solarSystemID,
  );
  const solarSystem = worldData.getSolarSystemByID(solarSystemID);
  const security = toFiniteNumber(
    solarSystem && solarSystem.security,
    toFiniteNumber(context.stationRecord && context.stationRecord.security, 0),
  );
  if (security >= 0.45) {
    return "high";
  }
  if (security > 0) {
    return "low";
  }
  return "null";
}

function resolveStructureReprocessingProfile(context) {
  if (!context || context.dockedKind !== "structure") {
    return null;
  }
  const structureTypeID = toInt(
    context.structure && context.structure.typeID,
    context.stationRecord && context.stationRecord.stationTypeID,
  );
  return getStructureReprocessingProfile(structureTypeID);
}

function resolveStructureRigProfiles(context) {
  if (!context || context.dockedKind !== "structure") {
    return [];
  }

  const facilityID = toInt(context.dockedLocationID, 0);
  const structureProfile = resolveStructureReprocessingProfile(context);
  const rigSize = Math.max(
    0,
    toInt(
      structureProfile && structureProfile.rigSize,
      0,
    ),
  );
  return getReprocessingFacilityRigTypeIDs(facilityID)
    .map((typeID) => getReprocessingRigProfile(typeID))
    .filter((profile) => profile && (rigSize <= 0 || profile.rigSize === rigSize));
}

function resolveStructureRigEfficiency(context, reprocessingProfile) {
  if (!context || context.dockedKind !== "structure" || !reprocessingProfile) {
    return null;
  }

  const yieldClass = String(reprocessingProfile.reprocessingFamily || "").trim();
  if (yieldClass !== "ore" && yieldClass !== "moon_ore" && yieldClass !== "ice") {
    return null;
  }

  const securityBand = resolveStructureSecurityBand(context) || "high";
  let best = null;
  for (const rigProfile of resolveStructureRigProfiles(context)) {
    if (!Array.isArray(rigProfile.yieldClasses) || !rigProfile.yieldClasses.includes(yieldClass)) {
      continue;
    }
    const securityMultiplier = toFiniteNumber(
      rigProfile.securityMultipliers && rigProfile.securityMultipliers[securityBand],
      1,
    );
    const efficiency = rigProfile.refiningYieldMultiplierBase * securityMultiplier;
    if (!best || efficiency > best.efficiency) {
      best = {
        rigProfile,
        securityBand,
        efficiency,
      };
    }
  }
  return best;
}

function getStationEfficiencyForTypeID(context, typeID) {
  if (!context) {
    return DEFAULT_STATION_REPROCESSING_EFFICIENCY;
  }

  if (context.dockedKind === "structure") {
    const reprocessingProfile = getReprocessingProfile(typeID);
    const structureProfile = resolveStructureReprocessingProfile(context);
    let efficiency = STRUCTURE_DEFAULT_REPROCESSING_EFFICIENCY;
    if (reprocessingProfile) {
      const rigResult = resolveStructureRigEfficiency(context, reprocessingProfile);
      if (rigResult && rigResult.efficiency > 0) {
        efficiency = rigResult.efficiency;
      }
      if (structureProfile && (reprocessingProfile.reprocessingFamily === "ore" ||
        reprocessingProfile.reprocessingFamily === "moon_ore" ||
        reprocessingProfile.reprocessingFamily === "ice")) {
        efficiency *= 1 + (
          toFiniteNumber(structureProfile.reprocessingYieldBonusPercent, 0) / 100
        );
      }
    }
    return Math.max(0, Math.min(1, efficiency));
  }

  const profile = getReprocessingProfile(typeID);
  return Math.max(
    0,
    Math.min(
      1,
      toFiniteNumber(
        context.stationRecord && context.stationRecord.reprocessingEfficiency,
        profile ? DEFAULT_STATION_REPROCESSING_EFFICIENCY : DEFAULT_STATION_REPROCESSING_EFFICIENCY,
      ),
    ),
  );
}

function getStationTaxRate(context) {
  if (!context) {
    return DEFAULT_STATION_REPROCESSING_TAX;
  }

  if (context.dockedKind === "structure") {
    return Math.max(
      0,
      Math.min(
        1,
        toFiniteNumber(
          getFacilityTaxRate(
            context.dockedLocationID,
            context.structure
              ? {
                facilityID: context.dockedLocationID,
                ownerID: toInt(context.structure.ownerCorpID || context.structure.ownerID, 0),
                tax: 0,
              }
              : {
                facilityID: context.dockedLocationID,
                ownerID: toInt(context.stationRecord && context.stationRecord.ownerID, 0),
                tax: 0,
              },
          ),
          0,
        ),
      ),
    );
  }

  const baseTax = Math.max(
    0,
    Math.min(
      1,
      toFiniteNumber(
        context.stationRecord && context.stationRecord.reprocessingStationsTake,
        DEFAULT_STATION_REPROCESSING_TAX,
      ),
    ),
  );
  const standing = Math.max(0, toFiniteNumber(context.standing, 0));
  if (standing <= 0) {
    return baseTax;
  }
  const reductionScale = Math.max(
    0,
    1 - Math.min(standing, NPC_STANDING_TAX_ZERO_POINT) / NPC_STANDING_TAX_ZERO_POINT,
  );
  return round2(baseTax * reductionScale);
}

function getReprocessingYieldForType(context, typeID) {
  const stationEfficiency = getStationEfficiencyForTypeID(context, typeID);
  const activeImplantMultiplier = getActiveReprocessingImplantMultiplier(
    context && context.characterID,
  );
  let characterMultiplier = getReprocessingSkillMultiplierForType(
    typeID,
    context && context.skillMap,
    activeImplantMultiplier !== null ? [] : context && context.implants,
  );
  if (activeImplantMultiplier !== null) {
    characterMultiplier *= activeImplantMultiplier;
  }
  return Math.max(0, Math.min(1, stationEfficiency * characterMultiplier));
}

function getStructureGasDecompressionEfficiency(context) {
  if (!context || context.dockedKind !== "structure") {
    return 0;
  }
  const structureProfile = resolveStructureReprocessingProfile(context);
  return Math.max(
    0,
    Math.min(
      1,
      toFiniteNumber(
        structureProfile && structureProfile.gasDecompressionEfficiencyBase,
        STRUCTURE_DEFAULT_GAS_DECOMPRESSION_EFFICIENCY,
      ) +
        toFiniteNumber(
          structureProfile && structureProfile.gasDecompressionEfficiencyBonusAdd,
          0,
        ),
    ),
  );
}

function isRefinableType(itemType) {
  const profile = getReprocessingProfile(itemType && itemType.typeID);
  return Boolean(profile && profile.isRefinable === true);
}

function isRecyclableType(itemType) {
  const profile = getReprocessingProfile(itemType && itemType.typeID);
  return Boolean(profile && profile.isRecyclable === true);
}

function buildFixedRecoverables(item, stationsTake, portions, efficiency) {
  const recoverables = [];
  if (!item || !portions) {
    return {
      recoverables,
      totalISKCost: 0,
    };
  }

  let totalISKCost = 0;
  for (const material of getTypeMaterials(item.typeID)) {
    const quantity = Math.max(0, toInt(material.quantity, 0) * portions);
    if (quantity > Number.MAX_SAFE_INTEGER) {
      return {
        errorMsg: "REPROCESSING_SPLIT_REQUIRED",
      };
    }
    // Rounding down to whole units is the correct rule here, but the product
    // must lose its binary noise first: `efficiency` is a chain of
    // `1 + pct/100` skill terms, so 200 units at a 0.575 yield arrives as
    // 114.99999999999999 and a bare floor pays out 114 instead of 115.
    const clientQuantity = Math.max(0, floorAfterNormalizing(quantity * efficiency));
    const unrecoverableQuantity = Math.max(0, quantity - clientQuantity);
    if (
      !isClientSafeRecoverableQuantity(clientQuantity) ||
      !isClientSafeRecoverableQuantity(unrecoverableQuantity)
    ) {
      return {
        errorMsg: "REPROCESSING_SPLIT_REQUIRED",
      };
    }
    const taxQuantity = clientQuantity * stationsTake;
    const iskCost = round2(getAdjustedAveragePrice(material.materialTypeID) * taxQuantity);
    totalISKCost += iskCost;
    recoverables.push({
      typeID: toInt(material.materialTypeID, 0),
      client: clientQuantity,
      unrecoverable: unrecoverableQuantity,
      iskCost,
    });
  }

  return {
    recoverables,
    totalISKCost: round2(totalISKCost),
  };
}

function buildPreviewRandomizedRecoverables(item, stationsTake, portions, efficiency, includeRecoverables) {
  const recoverables = [];
  if (!item || !portions || !typeHasRandomizedMaterials(item.typeID)) {
    return {
      recoverables,
      totalISKCost: 0,
    };
  }

  const expectedMarketValuePerBatch = Object.entries(
    getAverageRandomizedMaterialsPerBatch(item.typeID),
  ).reduce(
    (sum, [materialTypeID, averageQuantity]) =>
      sum + getAdjustedAveragePrice(materialTypeID) * toFiniteNumber(averageQuantity, 0),
    0,
  );
  const totalISKCost = round2(portions * expectedMarketValuePerBatch * stationsTake * efficiency);

  if (!includeRecoverables) {
    return {
      recoverables,
      totalISKCost,
    };
  }

  for (const material of getTypeRandomizedMaterials(item.typeID)) {
    const averageQuantity = ((material.quantityMin + material.quantityMax) / 2) * portions;
    const maxQuantity = Math.max(0, toInt(material.quantityMax, 0) * portions);
    if (maxQuantity > Number.MAX_SAFE_INTEGER) {
      return {
        errorMsg: "REPROCESSING_SPLIT_REQUIRED",
      };
    }
    const maxClientQuantity = Math.max(0, floorAfterNormalizing(maxQuantity * efficiency));
    const maxUnrecoverableQuantity = Math.max(0, Math.round(maxQuantity - maxClientQuantity));
    if (
      !isClientSafeRecoverableQuantity(maxClientQuantity) ||
      !isClientSafeRecoverableQuantity(maxUnrecoverableQuantity)
    ) {
      return {
        errorMsg: "REPROCESSING_SPLIT_REQUIRED",
      };
    }
    const clientQuantity = Math.max(0, floorAfterNormalizing(averageQuantity * efficiency));
    const unrecoverableQuantity = Math.max(0, Math.round(averageQuantity - clientQuantity));
    if (
      !isClientSafeRecoverableQuantity(clientQuantity) ||
      !isClientSafeRecoverableQuantity(unrecoverableQuantity)
    ) {
      return {
        errorMsg: "REPROCESSING_SPLIT_REQUIRED",
      };
    }
    recoverables.push({
      typeID: toInt(material.materialTypeID, 0),
      client: clientQuantity,
      unrecoverable: unrecoverableQuantity,
      iskCost: 0,
    });
  }

  return {
    recoverables,
    totalISKCost,
  };
}

function buildReprocessingQuoteForItem(item, context, options = {}) {
  if (isLockedAuditLogContainerEntryOrDescendant(item)) {
    return {
      errorMsg: "ITEM_IS_LOCKED",
    };
  }
  if (containsRetainedAuditLogContainer(item)) {
    return {
      errorMsg: "AUDIT_LOG_RETAINED",
    };
  }
  const profile = getReprocessingProfile(toInt(item && item.typeID, 0));
  const quantity = getInventoryQuantity(item);
  if (!profile || quantity <= 0) {
    return null;
  }

  const portionSize = Math.max(1, toInt(profile.portionSize, 1));
  const portions = Math.floor(quantity / portionSize);
  const leftOvers = quantity % portionSize;
  const quantityToProcess = quantity - leftOvers;
  const stationsTake = getStationTaxRate(context);
  const efficiency = getReprocessingYieldForType(context, profile.typeID);
  const includeRecoverablesFromRandomizedOutputs =
    options.includeRecoverablesFromRandomizedOutputs === true;

  let recoverableResult = buildFixedRecoverables(
    item,
    stationsTake,
    portions,
    efficiency,
  );
  if (recoverableResult && recoverableResult.errorMsg) {
    return recoverableResult;
  }
  if (recoverableResult.recoverables.length <= 0 && typeHasRandomizedMaterials(profile.typeID)) {
    recoverableResult = buildPreviewRandomizedRecoverables(
      item,
      stationsTake,
      portions,
      efficiency,
      includeRecoverablesFromRandomizedOutputs,
    );
  }

  return {
    itemID: toInt(item && item.itemID, 0),
    typeID: profile.typeID,
    quantityToProcess,
    leftOvers,
    portions,
    numPortions: portions,
    efficiency,
    recoverables: Array.isArray(recoverableResult.recoverables)
      ? recoverableResult.recoverables
      : [],
    totalISKCost: round2(recoverableResult.totalISKCost),
    stationTax: stationsTake,
    stationEfficiency: getStationEfficiencyForTypeID(context, profile.typeID),
    itemType: resolveItemByTypeID(profile.typeID) || {
      typeID: profile.typeID,
      name: profile.name,
      groupID: profile.groupID,
      categoryID: profile.categoryID,
      portionSize: profile.portionSize,
    },
  };
}

function buildReprocessingOptionsForTypes(typeIDs = []) {
  const optionsByTypeID = new Map();
  for (const rawTypeID of Array.isArray(typeIDs) ? typeIDs : []) {
    const typeID = toInt(rawTypeID, 0);
    if (typeID <= 0 || optionsByTypeID.has(typeID)) {
      continue;
    }
    const itemType = resolveItemByTypeID(typeID);
    optionsByTypeID.set(typeID, {
      isRecyclable: isRecyclableType(itemType),
      isRefinable: isRefinableType(itemType),
    });
  }
  return optionsByTypeID;
}

function resolveAccessibleInventoryItem(session, itemReference) {
  const itemID = toInt(itemReference && (itemReference.itemID ?? itemReference), 0);
  if (itemID <= 0) {
    return null;
  }

  const item = findItemById(itemID);
  if (!item) {
    return null;
  }

  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const ownerID = toInt(item.ownerID, 0);
  if (ownerID === characterID) {
    return item;
  }
  const office = getCorporationOfficeByInventoryID(ownerID, item.locationID);
  const accessLocationID = office ? toInt(office.stationID, item.locationID) : item.locationID;
  // Reprocessing corporation ore is taking it out of a corporation hangar, so
  // the gate is that division's Hangar Take role. canTakeFromOwnerLocation also
  // demands Factory Manager, which belongs to running corporation industry jobs
  // and would refuse a member who holds exactly the take role the division
  // needs. Flags with no mapped take role fall back to the industry rule rather
  // than being silently opened.
  const divisionAccess = canTakeFromCorporationHangarDivision(
    session,
    ownerID,
    accessLocationID,
    item.flagID,
  );
  const mayTake = divisionAccess === null
    ? canTakeFromOwnerLocation(session, ownerID, accessLocationID, item.flagID)
    : divisionAccess;
  if (ownerID === corporationID && mayTake) {
    return item;
  }
  return null;
}

function buildReprocessingQuotesForItems(session, itemReferences = [], options = {}) {
  const contextResult = resolveReprocessingContext(session);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const quotesByItemID = new Map();
  for (const itemReference of Array.isArray(itemReferences) ? itemReferences : []) {
    const item = resolveAccessibleInventoryItem(session, itemReference);
    const itemID = toInt(item && item.itemID, 0);
    if (!item || itemID <= 0 || quotesByItemID.has(itemID)) {
      continue;
    }
    const quote = buildReprocessingQuoteForItem(item, contextResult.data, options);
    if (quote && quote.errorMsg) {
      return {
        success: false,
        errorMsg: quote.errorMsg,
      };
    }
    if (quote) {
      quotesByItemID.set(itemID, quote);
    }
  }

  return {
    success: true,
    data: {
      context: contextResult.data,
      quotesByItemID,
    },
  };
}

function mergeQuantityByType(targetMap, typeID, quantity) {
  const numericTypeID = toInt(typeID, 0);
  const numericQuantity = Math.max(0, toInt(quantity, 0));
  if (numericTypeID <= 0 || numericQuantity <= 0) {
    return;
  }
  targetMap.set(numericTypeID, (targetMap.get(numericTypeID) || 0) + numericQuantity);
}

function randomIntegerInclusive(minValue, maxValue) {
  const min = Math.max(0, toInt(minValue, 0));
  const max = Math.max(min, toInt(maxValue, min));
  return min + Math.floor(Math.random() * ((max - min) + 1));
}

function buildExecutedRecoverables(item, quote) {
  if (!item || !quote || quote.portions <= 0) {
    return [];
  }
  if (!typeHasRandomizedMaterials(item.typeID)) {
    return Array.isArray(quote.recoverables) ? quote.recoverables : [];
  }

  const pickedMaterials = pickRandomizedMaterialTypesByWeight(item.typeID, quote.portions);
  return pickedMaterials.map(({ material, numOutputPortions }) => {
    let quantity = 0;
    for (let index = 0; index < numOutputPortions; index += 1) {
      quantity += randomIntegerInclusive(material.quantityMin, material.quantityMax);
    }
    const clientQuantity = Math.max(0, floorAfterNormalizing(quantity * quote.efficiency));
    const unrecoverableQuantity = Math.max(0, Math.round(quantity - clientQuantity));
    return {
      typeID: toInt(material.materialTypeID, 0),
      client: clientQuantity,
      unrecoverable: unrecoverableQuantity,
      iskCost: 0,
    };
  });
}

function resolveReprocessingOutputTarget(session, context, sampleItem, options = {}) {
  const explicitOutputLocationID =
    options.outputLocationID === null || options.outputLocationID === undefined
      ? null
      : toInt(options.outputLocationID, 0);
  const explicitOutputFlagID =
    options.outputFlagID === null || options.outputFlagID === undefined
      ? null
      : toInt(options.outputFlagID, ITEM_FLAGS.HANGAR);
  const explicitOwnerID =
    options.ownerID === null || options.ownerID === undefined
      ? null
      : toInt(options.ownerID, 0);
  if (!sampleItem) {
    return {
      success: false,
      errorMsg: "OUTPUT_LOCATION_INVALID",
    };
  }

  if (explicitOutputLocationID === null && explicitOutputFlagID === null) {
    const ownerID = toInt(sampleItem.ownerID, 0);
    if (
      explicitOwnerID !== null &&
      explicitOwnerID > 0 &&
      explicitOwnerID !== ownerID
    ) {
      return {
        success: false,
        errorMsg: "OUTPUT_LOCATION_INVALID",
      };
    }
    return {
      success: true,
      data: {
        ownerID,
        locationID: toInt(sampleItem.locationID, 0),
        flagID: toInt(sampleItem.flagID, ITEM_FLAGS.HANGAR),
      },
    };
  }

  const dockedLocationID = toInt(context && context.dockedLocationID, 0);
  const outputLocationID = explicitOutputLocationID;
  const outputFlagID = explicitOutputFlagID === null ? ITEM_FLAGS.HANGAR : explicitOutputFlagID;
  if (outputLocationID === dockedLocationID && outputFlagID === ITEM_FLAGS.HANGAR) {
    const ownerID = getSessionCharacterID(session);
    if (
      explicitOwnerID !== null &&
      explicitOwnerID > 0 &&
      explicitOwnerID !== ownerID
    ) {
      return {
        success: false,
        errorMsg: "OUTPUT_LOCATION_INVALID",
      };
    }
    return {
      success: true,
      data: {
        ownerID,
        locationID: outputLocationID,
        flagID: ITEM_FLAGS.HANGAR,
      },
    };
  }

  const corporationID = getSessionCorporationID(session);
  const office = getCorporationOfficeByInventoryID(corporationID, outputLocationID);
  if (
    office &&
    toInt(office.stationID, 0) === dockedLocationID &&
    canViewOwnerLocation(session, corporationID, office.stationID, outputFlagID)
  ) {
    const ownerID = corporationID;
    if (
      explicitOwnerID !== null &&
      explicitOwnerID > 0 &&
      explicitOwnerID !== ownerID
    ) {
      return {
        success: false,
        errorMsg: "OUTPUT_LOCATION_INVALID",
      };
    }
    return {
      success: true,
      data: {
        ownerID,
        locationID: outputLocationID,
        flagID: outputFlagID,
      },
    };
  }

  return {
    success: false,
    errorMsg: "OUTPUT_LOCATION_INVALID",
  };
}

async function reprocessItems(session, options = {}) {
  const itemReferences = Array.isArray(options.itemIDs) ? options.itemIDs : [];
  const fromLocationID = toInt(options.fromLocationID, 0);
  const contextResult = resolveReprocessingContext(session);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const activeShip = getActiveShipRecord(contextResult.data.characterID);
  const activeShipID = toInt(activeShip && activeShip.itemID, 0);
  for (const itemReference of itemReferences) {
    const itemID = toInt(itemReference && (itemReference.itemID ?? itemReference), 0);
    if (itemID > 0 && itemID === activeShipID) {
      return {
        success: false,
        errorMsg: "ACTIVE_SHIP",
      };
    }
  }

  const items = [];
  for (const itemReference of itemReferences) {
    const item = resolveAccessibleInventoryItem(session, itemReference);
    if (!item) {
      continue;
    }
    if (fromLocationID > 0 && toInt(item.locationID, 0) !== fromLocationID) {
      continue;
    }
    items.push(item);
  }
  if (items.length <= 0) {
    return {
      success: true,
      data: {
        processedItemIDs: [],
        outputByTypeID: {},
        inputChanges: [],
        outputChanges: [],
        reprocessedEvents: [],
        outputLocationID: fromLocationID || contextResult.data.dockedLocationID,
        outputFlagID: ITEM_FLAGS.HANGAR,
        context: contextResult.data,
      },
    };
  }

  const targetResult = resolveReprocessingOutputTarget(
    session,
    contextResult.data,
    items[0],
    options,
  );
  if (!targetResult.success || !targetResult.data) {
    return targetResult;
  }

  const processedItemIDs = [];
  const outputByTypeID = new Map();
  const reprocessedEvents = [];
  const quotes = [];
  let totalISKCost = 0;

  for (const item of items) {
    const quote = buildReprocessingQuoteForItem(item, contextResult.data, {
      includeRecoverablesFromRandomizedOutputs: false,
    });
    if (!quote) {
      continue;
    }
    if (quote.errorMsg) {
      return {
        success: false,
        errorMsg: quote.errorMsg,
      };
    }
    if (quote.quantityToProcess <= 0 || quote.portions <= 0) {
      continue;
    }
    quotes.push({ item, quote });
    totalISKCost += quote.totalISKCost;
  }

  if (quotes.length <= 0) {
    return {
      success: true,
      data: {
        processedItemIDs: [],
        outputByTypeID: {},
        inputChanges: [],
        outputChanges: [],
        reprocessedEvents: [],
        outputLocationID: targetResult.data.locationID,
        outputFlagID: targetResult.data.flagID,
        context: contextResult.data,
      },
    };
  }

  const normalizedTotalISKCost = round2(totalISKCost);
  if (normalizedTotalISKCost > 0) {
    const wallet = getCharacterWallet(contextResult.data.characterID);
    const currentBalance = Number(wallet && wallet.balance) || 0;
    if (normalizedTotalISKCost - currentBalance > 0.0001) {
      return {
        success: false,
        errorMsg: "INSUFFICIENT_FUNDS",
        errorValues: buildNotEnoughMoneyUserErrorValues(
          normalizedTotalISKCost,
          currentBalance,
        ),
      };
    }

  }

  for (const { item, quote } of quotes) {
    const executedRecoverables = buildExecutedRecoverables(item, quote);
    for (const recoverable of executedRecoverables) {
      mergeQuantityByType(outputByTypeID, recoverable.typeID, recoverable.client);
    }
    reprocessedEvents.push({
      characterID: contextResult.data.characterID,
      solarSystemID: toInt(
        contextResult.data.structure && contextResult.data.structure.solarSystemID,
        contextResult.data.stationRecord && contextResult.data.stationRecord.solarSystemID,
      ),
      dockedKind: contextResult.data.dockedKind,
      dockedLocationID: contextResult.data.dockedLocationID,
      inputTypeID: toInt(item.typeID, 0),
      quantity: Math.max(0, toInt(quote.quantityToProcess, 0)),
      outputs: executedRecoverables
        .map((recoverable) => ({
          outputTypeID: toInt(recoverable.typeID, 0),
          quantity: Math.max(0, toInt(recoverable.client, 0)),
        }))
        .filter((entry) => entry.outputTypeID > 0 && entry.quantity > 0),
    });
    processedItemIDs.push(item.itemID);
  }

  const ownerCorporationID = contextResult.data.dockedKind === "structure"
    ? toInt(
        contextResult.data.structure &&
          (contextResult.data.structure.ownerCorpID || contextResult.data.structure.ownerID),
        0,
      )
    : 0;
  const prepared = prepareReprocessingSettlement({
    characterID: contextResult.data.characterID,
    facilityLocationID: contextResult.data.dockedLocationID,
    ownerCorporationID,
    totalCost: normalizedTotalISKCost,
    walletDescription: "Reprocessing tax",
    inputs: quotes.map(({ item, quote }) => ({
      itemID: toInt(item.itemID, 0),
      typeID: toInt(item.typeID, 0),
      quantity: Math.max(0, toInt(quote.quantityToProcess, 0)),
      ownerID: toInt(item.ownerID, 0),
      locationID: toInt(item.locationID, 0),
      flagID: toInt(item.flagID, 0),
      item,
    })),
    outputs: [...outputByTypeID.entries()].map(([typeID, quantity]) => ({
      typeID,
      quantity,
    })),
    outputTarget: targetResult.data,
    processedItemIDs,
    outputByTypeID: Object.fromEntries(outputByTypeID.entries()),
    reprocessedEvents,
  });
  if (!prepared || prepared.success !== true) {
    return prepared || {
      success: false,
      errorMsg: "REPROCESSING_SETTLEMENT_PREPARE_FAILED",
    };
  }
  const settlementResult = await settleReprocessingSettlement(
    contextResult.data.characterID,
    {
      preferredSession: session,
      publishGatewayNotice: options.publishGatewayNotice,
    },
  );
  if (!settlementResult || settlementResult.success !== true) {
    return settlementResult || {
      success: false,
      errorMsg: "REPROCESSING_SETTLEMENT_FAILED",
    };
  }
  if (settlementResult.rejected === true) {
    const wallet = getCharacterWallet(contextResult.data.characterID);
    return {
      success: false,
      errorMsg: settlementResult.errorMsg || "REPROCESSING_REJECTED",
      errorValues:
        settlementResult.errorMsg === "INSUFFICIENT_FUNDS"
          ? buildNotEnoughMoneyUserErrorValues(
              normalizedTotalISKCost,
              Number(wallet && wallet.balance) || 0,
            )
          : undefined,
    };
  }
  if (!settlementResult.data) {
    return { success: false, errorMsg: "REPROCESSING_SETTLEMENT_RESULT_MISSING" };
  }

  return {
    success: true,
    data: {
      ...settlementResult.data,
      context: contextResult.data,
    },
  };
}

function throwReprocessingError(errorMsg, values = {}) {
  switch (String(errorMsg || "")) {
    case "ITEM_IS_LOCKED":
      throwWrappedUserError("ItemIsLocked");
      break;
    case "ACTIVE_SHIP":
      throwWrappedUserError("CannotReprocessActive");
      break;
    case "REPROCESSING_SPLIT_REQUIRED":
      throwWrappedUserError("ReprocessingPleaseSplit");
      break;
    case "INSUFFICIENT_FUNDS":
      throwWrappedUserError(
        "NotEnoughMoney",
        buildNotEnoughMoneyUserErrorValues(
          values.amount,
          values.balance,
        ),
      );
      break;
    case "REPROCESSING_OFFLINE":
      throwWrappedUserError("StructureReprocessingDenied");
      break;
    case "NOT_DOCKED":
      throwWrappedUserError("CustomNotify", {
        notify: "You must be docked to use reprocessing.",
      });
      break;
    case "OUTPUT_LOCATION_INVALID":
      throwWrappedUserError("CustomNotify", {
        notify: "The selected output location cannot receive reprocessing output.",
      });
      break;
    case "AUDIT_LOG_RETAINED":
      throwWrappedUserError("CustomNotify", {
        notify:
          "The Audit Log Secure Container cannot be reprocessed because it " +
          "has an audit log entry less than three weeks old.",
      });
      break;
    default:
      throwWrappedUserError("CustomNotify", {
        notify: `Reprocessing failed (${String(values.settlementError || errorMsg || "UNKNOWN")}).`,
      });
      break;
  }
}

module.exports = {
  buildReprocessingOptionsForTypes,
  buildReprocessingQuoteForItem,
  buildReprocessingQuotesForItems,
  getGasDecompressionCharacterEfficiency,
  getReprocessingYieldForType,
  resolveAccessibleInventoryItem,
  getStationEfficiencyForTypeID,
  getStationTaxRate,
  getStructureGasDecompressionEfficiency,
  reprocessItems,
  resolveReprocessingContext,
  throwReprocessingError,
  TYPE_GAS_DECOMPRESSION_EFFICIENCY,
};
