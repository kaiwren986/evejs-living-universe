"use strict";

// Item and character info in the dogma service: what the client asks for to show a ship, a
// character or an item and its attributes. GetAllInfo answers the client's request at login
// and after a ship or location change with the character, ship, fitting, charge and structure
// state; ShipGetInfo, CharGetInfo and ItemGetInfo describe one ship, character or item; and
// GetCharacterAttributes, QueryAllAttributesForItem, QueryAttributeValue and
// FullyDescribeAttribute answer questions about attribute values. These are DogmaService
// methods, moved here as they were; dogmaService.js puts them back on the class prototype, so
// `this` is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../../_shared/referenceData"));
const {
  resolveShipByTypeID,
} = require(path.join(
  __dirname,
  "../../chat/shipTypeRegistry",
));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../inventory/itemTypeRegistry"));
const {
  getActiveShipRecord,
  findCharacterShip,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  getShipConditionState,
  SHIP_CATEGORY_ID,
  findItemById,
  listContainerItems,
  updateInventoryItem,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const {
  getCharacterSkills,
  SKILL_FLAG_ID,
} = require(path.join(__dirname, "../../skills/skillState"));
const {
  buildSystemWideEffectsPayloadForSystem,
  buildEmptySystemWideEffectsPayload,
} = require(path.join(
  __dirname,
  "../../exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  getFittedModuleItems,
  getLoadedChargeByFlag,
  buildModuleStatusSnapshot,
  buildCharacterTargetingState,
  getTypeDogmaAttributes,
  getDogmaAttributeDefaultValue,
  isShipFittingFlag,
  listFittedItemsForLocation,
  applyModifierGroups,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  getShipFittingSnapshot,
  invalidateShipFittingSnapshot,
} = require(path.join(
  __dirname,
  "../../../_secondary/fitting/fittingRuntime",
));
const {
  ensureShipFittingInventoryParity,
} = require(path.join(__dirname, "../../fitting/fittingIntegrity"));
const {
  resolveCharacterIndustryAttributes,
} = require(path.join(__dirname, "../brain/providers/industryBrainProvider"));
const {
  applyActiveImplantAttributeBonuses,
} = require(path.join(__dirname, "../implants/activeImplantModifiers"));
const {
  applyClientTrainingSpeedScale,
} = require(path.join(__dirname, "../../skills/training/skillTrainingSpeed"));
const {
  ATTRIBUTE_MAX_JUMP_CLONES,
  ATTRIBUTE_CLONE_JUMP_COOLDOWN,
  getCharacterCloneLimit,
  getCharacterCloneJumpCooldownHours,
} = require(path.join(__dirname, "../../station/jumpCloneRules"));
const {
  buildBootstrapCharacterBrain,
  buildCharacterBrainDefinitionSet,
} = require(path.join(__dirname, "../brain/characterBrainRuntime"));
const {
  buildWeaponBankStateDict,
} = require(path.join(__dirname, "../../moduleGrouping/moduleGroupingRuntime"));
const {
  buildShipHeatStateDict,
} = require(path.join(__dirname, "../activationHeatState"));
const {
  readShipConditionAmounts,
} = require(path.join(__dirname, "../shipConditionAmounts"));
const {
  readCharacterOwnAttributes,
} = require(path.join(__dirname, "../../character/characterOwnAttributes"));
const {
  collectCharacterModifierAttributes,
} = require(path.join(__dirname, "../../../space/combat/weaponDogma"));
const {
  normalizeNumber,
  currentFileTime,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  isDockedSession,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  syncStructureServiceModuleState,
} = require(path.join(__dirname, "../../structure/structureServiceModules"));
const worldData = require(path.join(__dirname, "../../../space/worldData"));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));
const {
  ATTRIBUTE_PILOT_SECURITY_STATUS,
  ATTRIBUTE_MASS,
  ATTRIBUTE_CAPACITY,
  ATTRIBUTE_MAX_LOCKED_TARGETS,
  ATTRIBUTE_VOLUME,
  ATTRIBUTE_RADIUS,
  ATTRIBUTE_MODULE_REPAIR_RATE,
  ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER,
  DBTYPE_I4,
  DBTYPE_I8,
} = require(path.join(__dirname, "./shared"));

function recordSpaceBootstrapTrace(session, event, details = {}) {
  if (
    !session ||
    !log.isVerboseDebugEnabled() ||
    !spaceRuntime ||
    typeof spaceRuntime.recordSessionJumpTimingTrace !== "function"
  ) {
    return false;
  }
  return (
    spaceRuntime.recordSessionJumpTimingTrace(session, event, details) === true
  );
}

const ATTRIBUTE_CHARISMA = 164;
const ATTRIBUTE_INTELLIGENCE = 165;
const ATTRIBUTE_MEMORY = 166;
const ATTRIBUTE_PERCEPTION = 167;
const ATTRIBUTE_WILLPOWER = 168;
const ATTRIBUTE_MANUFACTURE_SLOT_LIMIT = 196;
const ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER = 219;
const ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED = 385;
const ATTRIBUTE_COPY_SPEED_PERCENT = 387;
const ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED = 398;
const ATTRIBUTE_MAX_LABORATORY_SLOTS = 467;
const ATTRIBUTE_INVENTION_RESEARCH_SPEED = 1959;
const ATTRIBUTE_REACTION_TIME_MULTIPLIER = 2662;
const ATTRIBUTE_REACTION_SLOT_LIMIT = 2664;
const LIVE_SPACE_TUPLE_CHARGE_PROFILES = new Set([
  "login",
  "stargate",
  "solar",
  "solarWarm",
  "transition",
  "undock",
]);
const STRUCTURE_ACTIVATION_ATTRIBUTE_VALUES = Object.freeze({
  2: 0,
  276: 0,
  1168: 0,
  1175: 0,
  1176: 0,
  1177: 0,
  1178: 0,
  1179: 0,
  1196: 0,
  1198: 0,
  1199: 0,
  1200: 0,
  1224: 1,
});
const CHARACTER_TYPE_ID = 1373;
// The pilot's drone attributes a ship's item does not list: maxActiveDrones,
// droneControlDistance (_buildShipAttributeDict).
const PILOT_DRONE_ATTRIBUTE_IDS = Object.freeze([352, 458]);
const CHARACTER_GROUP_ID = 1;
const CHARACTER_CATEGORY_ID = 3;
const FLAG_PILOT = 57;
const DBTYPE_R8 = 0x05;
const DBTYPE_BOOL = 0x0b;
const INSTANCE_ROW_DESCRIPTOR_COLUMNS = [
  ["instanceID", DBTYPE_I8],
  ["online", DBTYPE_BOOL],
  ["damage", DBTYPE_R8],
  ["charge", DBTYPE_R8],
  ["skillPoints", DBTYPE_I4],
  ["armorDamage", DBTYPE_R8],
  ["shieldCharge", DBTYPE_R8],
  ["incapacitated", DBTYPE_BOOL],
];

module.exports = {
  _getSessionSpaceSystemID(session) {
    if (!session || isDockedSession(session)) {
      return 0;
    }
    for (const candidate of [
      session.solarsystemid2,
      session.solarsystemid,
      session.locationid,
      session.locationID,
    ]) {
      const numeric = Math.trunc(normalizeNumber(candidate, 0));
      if (numeric > 0) {
        return numeric;
      }
    }
    return 0;
  },

  _resolveActiveShipLocationID(session, shipMetadata = {}, fallback = 0) {
    const metadataLocationID = Math.trunc(
      normalizeNumber(shipMetadata && shipMetadata.locationID, 0),
    );
    const spaceSystemID = this._getSessionSpaceSystemID(session);
    if (spaceSystemID > 0) {
      return metadataLocationID === spaceSystemID
        ? metadataLocationID
        : spaceSystemID;
    }
    if (metadataLocationID > 0) {
      return metadataLocationID;
    }
    return this._coalesce(shipMetadata && shipMetadata.locationID, fallback);
  },

  _resolveActiveShipFlagID(session, shipMetadata = {}, fallback = 4) {
    const spaceSystemID = this._getSessionSpaceSystemID(session);
    if (spaceSystemID > 0) {
      return 0;
    }
    return this._coalesce(shipMetadata && shipMetadata.flagID, fallback);
  },

  _normalizeControlledStructureFittingOwners(shipContext) {
    if (!shipContext || shipContext.controllingStructure !== true) {
      return 0;
    }
    const shipID = Number(shipContext.shipID) || 0;
    const ownerID = Number(
      shipContext.shipMetadata && shipContext.shipMetadata.ownerID,
    ) || 0;
    if (shipID <= 0 || ownerID <= 0) {
      return 0;
    }

    let normalizedCount = 0;
    for (const item of listFittedItemsForLocation(shipID)) {
      if (!item || Number(item.ownerID) === ownerID) {
        continue;
      }
      const updateResult = updateInventoryItem(item.itemID, (currentItem) => ({
        ...currentItem,
        ownerID,
      }));
      if (updateResult.success) {
        normalizedCount += 1;
      } else {
        log.warn(
          `[DogmaIM] Failed to normalize controlled structure fitting owner ` +
          `structure=${shipID} item=${Number(item.itemID) || 0} ` +
          `error=${updateResult.errorMsg || "UNKNOWN_ERROR"}`,
        );
      }
    }
    if (normalizedCount > 0) {
      log.info(
        `[DogmaIM] Normalized controlled structure fitting owners ` +
        `structure=${shipID} owner=${ownerID} items=${normalizedCount}`,
      );
    }
    return normalizedCount;
  },

  _toBoolArg(value, fallback = true) {
    if (value === undefined) {
      return fallback;
    }
    if (value === null) {
      return fallback;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    if (typeof value === "object") {
      if (value.type === "bool") {
        return Boolean(value.value);
      }
      if (value.type === "none") {
        return fallback;
      }
    }
    return fallback;
  },

  _buildInstanceRowDescriptor() {
    return {
      type: "objectex1",
      header: [
        { type: "token", value: "blue.DBRowDescriptor" },
        [INSTANCE_ROW_DESCRIPTOR_COLUMNS],
      ],
      list: [],
      dict: [],
    };
  },

  _buildPackedInstanceRow({
    itemID,
    online = false,
    damage = 0.0,
    charge = 0.0,
    skillPoints = 0,
    armorDamage = 0.0,
    shieldCharge = 0.0,
    incapacitated = false,
  }) {
    return {
      type: "packedrow",
      header: this._buildInstanceRowDescriptor(),
      columns: INSTANCE_ROW_DESCRIPTOR_COLUMNS,
      fields: {
        instanceID: itemID,
        online,
        damage,
        charge,
        skillPoints,
        armorDamage,
        shieldCharge,
        incapacitated,
      },
    };
  },

  _buildCharacterAttributes(charData = {}, characterID = null) {
    const source = charData.characterAttributes || {};
    const charID = Number(
      characterID ?? charData.characterID ?? charData.charID ?? charData.charid ?? 0,
    ) || 0;
    const securityStatus = Number(
      charData.securityStatus ?? charData.securityRating ?? source.securityStatus ?? 0,
    );
    const characterTargetingState = buildCharacterTargetingState(
      charID,
      {
        characterAttributes: source,
      },
    );
    const industryAttributes = resolveCharacterIndustryAttributes(charID);
    const naniteRepairAttributes =
      this._resolveCharacterNaniteRepairAttributes(charID);
    // Scale the learning attributes by skillTrainingSpeed so the godma-driven
    // Character Sheet and training-time displays match server SP accrual.
    return applyClientTrainingSpeedScale(applyActiveImplantAttributeBonuses({
      ...readCharacterOwnAttributes(source),
      [ATTRIBUTE_MAX_LOCKED_TARGETS]: Number(
        characterTargetingState.maxLockedTargets ?? source[ATTRIBUTE_MAX_LOCKED_TARGETS] ?? 0,
      ),
      [1174]: require("../../starbase/starbaseControlRuntime").getStarbaseControlAmount(charID),
      [ATTRIBUTE_MAX_JUMP_CLONES]: Number(
        source[ATTRIBUTE_MAX_JUMP_CLONES] ?? getCharacterCloneLimit(charID),
      ),
      [ATTRIBUTE_CLONE_JUMP_COOLDOWN]: Number(
        source[ATTRIBUTE_CLONE_JUMP_COOLDOWN] ?? getCharacterCloneJumpCooldownHours(charID),
      ),
      [ATTRIBUTE_MANUFACTURE_SLOT_LIMIT]: Number(
        source[ATTRIBUTE_MANUFACTURE_SLOT_LIMIT] ??
          industryAttributes[ATTRIBUTE_MANUFACTURE_SLOT_LIMIT],
      ),
      [ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER]: Number(
        source[ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER] ??
          industryAttributes[ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER],
      ),
      [ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED]: Number(
        source[ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED] ??
          industryAttributes[ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED],
      ),
      [ATTRIBUTE_COPY_SPEED_PERCENT]: Number(
        source[ATTRIBUTE_COPY_SPEED_PERCENT] ??
          industryAttributes[ATTRIBUTE_COPY_SPEED_PERCENT],
      ),
      [ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED]: Number(
        source[ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED] ??
          industryAttributes[ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED],
      ),
      [ATTRIBUTE_MAX_LABORATORY_SLOTS]: Number(
        source[ATTRIBUTE_MAX_LABORATORY_SLOTS] ??
          industryAttributes[ATTRIBUTE_MAX_LABORATORY_SLOTS],
      ),
      [ATTRIBUTE_INVENTION_RESEARCH_SPEED]: Number(
        source[ATTRIBUTE_INVENTION_RESEARCH_SPEED] ??
          industryAttributes[ATTRIBUTE_INVENTION_RESEARCH_SPEED],
      ),
      [ATTRIBUTE_REACTION_TIME_MULTIPLIER]: Number(
        source[ATTRIBUTE_REACTION_TIME_MULTIPLIER] ??
          industryAttributes[ATTRIBUTE_REACTION_TIME_MULTIPLIER],
      ),
      [ATTRIBUTE_REACTION_SLOT_LIMIT]: Number(
        source[ATTRIBUTE_REACTION_SLOT_LIMIT] ??
          industryAttributes[ATTRIBUTE_REACTION_SLOT_LIMIT],
      ),
      [ATTRIBUTE_MODULE_REPAIR_RATE]: Number(
        source[ATTRIBUTE_MODULE_REPAIR_RATE] ??
          naniteRepairAttributes.moduleRepairRate,
      ),
      [ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER]: Number(
        source[ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER] ??
          naniteRepairAttributes.repairCostMultiplier,
      ),
      [ATTRIBUTE_PILOT_SECURITY_STATUS]: Number.isFinite(securityStatus)
        ? securityStatus
        : 0,
    }, charID > 0 ? charID : charData));
  },

  _buildCharacterBaseAttributes(charData = {}) {
    const typeID = Number(charData.typeID || CHARACTER_TYPE_ID) || CHARACTER_TYPE_ID;
    const source =
      charData.characterAttributes && typeof charData.characterAttributes === "object"
        ? charData.characterAttributes
        : {};
    const attributes = Object.fromEntries(
      Object.entries(getTypeDogmaAttributes(typeID))
        .map(([attributeID, value]) => [Number(attributeID), Number(value)])
        .filter(
          ([attributeID, value]) =>
            Number.isInteger(attributeID) && Number.isFinite(value),
        ),
    );

    for (const [attributeID, value] of Object.entries(source)) {
      const numericAttributeID = Number(attributeID);
      const numericValue = Number(value);
      if (!Number.isInteger(numericAttributeID) || !Number.isFinite(numericValue)) {
        continue;
      }
      attributes[numericAttributeID] = numericValue;
    }

    const namedPrimaryAttributes = [
      [ATTRIBUTE_CHARISMA, source.charisma ?? charData.charisma ?? 20],
      [ATTRIBUTE_INTELLIGENCE, source.intelligence ?? charData.intelligence ?? 20],
      [ATTRIBUTE_MEMORY, source.memory ?? charData.memory ?? 20],
      [ATTRIBUTE_PERCEPTION, source.perception ?? charData.perception ?? 20],
      [ATTRIBUTE_WILLPOWER, source.willpower ?? charData.willpower ?? 20],
    ];
    for (const [attributeID, value] of namedPrimaryAttributes) {
      const numericValue = Number(value);
      if (Number.isFinite(numericValue)) {
        attributes[attributeID] = numericValue;
      }
    }

    return attributes;
  },

  // The whole character as this server reckons it: its type's attributes, what
  // its record has, and what its skills, its implants and its ship's fitting
  // give it.
  _buildWholeCharacterAttributes(
    charData = {},
    characterID = null,
    session = null,
    options = {},
  ) {
    const charID = Number(
      characterID ?? charData.characterID ?? charData.charID ?? charData.charid ?? 0,
    ) || 0;
    const source =
      charData.characterAttributes && typeof charData.characterAttributes === "object"
        ? charData.characterAttributes
        : {};
    const attributes = this._buildCharacterBaseAttributes(charData);
    const directCharacterModifierEntries = buildCharacterBrainDefinitionSet(charID)
      .characterEffects
      .filter(
        (effectDefinition) =>
          String(effectDefinition && effectDefinition.modifierType || "M") === "M",
      )
      .map((effectDefinition) => ({
        modifiedAttributeID: Number(effectDefinition && effectDefinition.targetAttributeID) || 0,
        operation: Number(effectDefinition && effectDefinition.operation) || 0,
        value: Number(effectDefinition && effectDefinition.value),
        stackingPenalized: false,
      }))
      .filter(
        (modifierEntry) =>
          modifierEntry.modifiedAttributeID > 0 &&
          Number.isFinite(modifierEntry.value),
      );
    if (directCharacterModifierEntries.length > 0) {
      applyModifierGroups(attributes, directCharacterModifierEntries);
    }

    const sessionShipID = Number(
      session && (session.activeShipID ?? session.shipID ?? session.shipid),
    ) || 0;
    const activeShip =
      (sessionShipID > 0 && findCharacterShip(charID, sessionShipID)) ||
      getActiveShipRecord(charID) ||
      null;
    if (activeShip) {
      const fittingSnapshot = getShipFittingSnapshot(charID, activeShip.itemID, {
        shipItem: activeShip,
        reason: "dogma.ship-modified-char-attrs",
        ...this._getFittingContextSnapshotOptions(
          options.fittingContext,
          charID,
          activeShip.itemID,
        ),
      });
      if (fittingSnapshot) {
        const ownerModifierAttributes = collectCharacterModifierAttributes(
          fittingSnapshot.skillMap,
          fittingSnapshot.fittedItems,
          fittingSnapshot.assumedActiveModuleContexts,
        );
        for (const [attributeID, value] of Object.entries(
          ownerModifierAttributes || {},
        )) {
          const numericAttributeID = Number(attributeID);
          const numericValue = Number(value);
          if (!Number.isInteger(numericAttributeID) || !Number.isFinite(numericValue)) {
            continue;
          }
          attributes[numericAttributeID] = numericValue;
        }
      }
    }

    const characterTargetingState = buildCharacterTargetingState(
      charID,
      {
        characterAttributes: source,
      },
    );
    const industryAttributes = resolveCharacterIndustryAttributes(charID);
    const securityStatus = Number(
      charData.securityStatus ?? charData.securityRating ?? source.securityStatus ?? 0,
    );
    const naniteRepairAttributes =
      this._resolveCharacterNaniteRepairAttributes(charID);

    attributes[ATTRIBUTE_MAX_LOCKED_TARGETS] = Number(
      characterTargetingState.maxLockedTargets ?? attributes[ATTRIBUTE_MAX_LOCKED_TARGETS] ?? 0,
    );
    attributes[ATTRIBUTE_MAX_JUMP_CLONES] = Number(
      source[ATTRIBUTE_MAX_JUMP_CLONES] ??
        attributes[ATTRIBUTE_MAX_JUMP_CLONES] ??
        getCharacterCloneLimit(charID),
    );
    attributes[ATTRIBUTE_CLONE_JUMP_COOLDOWN] = Number(
      source[ATTRIBUTE_CLONE_JUMP_COOLDOWN] ??
        attributes[ATTRIBUTE_CLONE_JUMP_COOLDOWN] ??
        getCharacterCloneJumpCooldownHours(charID),
    );
    attributes[ATTRIBUTE_MANUFACTURE_SLOT_LIMIT] = Number(
      source[ATTRIBUTE_MANUFACTURE_SLOT_LIMIT] ??
        industryAttributes[ATTRIBUTE_MANUFACTURE_SLOT_LIMIT] ??
        attributes[ATTRIBUTE_MANUFACTURE_SLOT_LIMIT] ??
        0,
    );
    attributes[ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER] = Number(
      source[ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER] ??
        industryAttributes[ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER] ??
        attributes[ATTRIBUTE_MANUFACTURE_TIME_MULTIPLIER] ??
        0,
    );
    attributes[ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED] = Number(
      source[ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED] ??
        industryAttributes[ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED] ??
        attributes[ATTRIBUTE_MANUFACTURING_TIME_RESEARCH_SPEED] ??
        0,
    );
    attributes[ATTRIBUTE_COPY_SPEED_PERCENT] = Number(
      source[ATTRIBUTE_COPY_SPEED_PERCENT] ??
        industryAttributes[ATTRIBUTE_COPY_SPEED_PERCENT] ??
        attributes[ATTRIBUTE_COPY_SPEED_PERCENT] ??
        0,
    );
    attributes[ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED] = Number(
      source[ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED] ??
        industryAttributes[ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED] ??
        attributes[ATTRIBUTE_MINERAL_NEED_RESEARCH_SPEED] ??
        0,
    );
    attributes[ATTRIBUTE_MAX_LABORATORY_SLOTS] = Number(
      source[ATTRIBUTE_MAX_LABORATORY_SLOTS] ??
        industryAttributes[ATTRIBUTE_MAX_LABORATORY_SLOTS] ??
        attributes[ATTRIBUTE_MAX_LABORATORY_SLOTS] ??
        0,
    );
    attributes[ATTRIBUTE_INVENTION_RESEARCH_SPEED] = Number(
      source[ATTRIBUTE_INVENTION_RESEARCH_SPEED] ??
        industryAttributes[ATTRIBUTE_INVENTION_RESEARCH_SPEED] ??
        attributes[ATTRIBUTE_INVENTION_RESEARCH_SPEED] ??
        0,
    );
    attributes[ATTRIBUTE_REACTION_TIME_MULTIPLIER] = Number(
      source[ATTRIBUTE_REACTION_TIME_MULTIPLIER] ??
        industryAttributes[ATTRIBUTE_REACTION_TIME_MULTIPLIER] ??
        attributes[ATTRIBUTE_REACTION_TIME_MULTIPLIER] ??
        0,
    );
    attributes[ATTRIBUTE_REACTION_SLOT_LIMIT] = Number(
      source[ATTRIBUTE_REACTION_SLOT_LIMIT] ??
        industryAttributes[ATTRIBUTE_REACTION_SLOT_LIMIT] ??
        attributes[ATTRIBUTE_REACTION_SLOT_LIMIT] ??
        0,
    );
    attributes[ATTRIBUTE_MODULE_REPAIR_RATE] = Number(
      source[ATTRIBUTE_MODULE_REPAIR_RATE] ??
        attributes[ATTRIBUTE_MODULE_REPAIR_RATE] ??
        naniteRepairAttributes.moduleRepairRate,
    );
    attributes[ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER] = Number(
      source[ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER] ??
        attributes[ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER] ??
        naniteRepairAttributes.repairCostMultiplier,
    );
    attributes[ATTRIBUTE_PILOT_SECURITY_STATUS] = Number.isFinite(securityStatus)
      ? securityStatus
      : 0;

    return attributes;
  },

  // The character's attributes that its ship's fitting modifies, and no
  // others: those the fitting changes in the reckoning of what skills and
  // fitting give a character, each at the value that reckoning gives it.
  _buildShipModifiedCharacterAttributes(
    charData = {},
    characterID = null,
    session = null,
    options = {},
  ) {
    const charID = Number(
      characterID ?? charData.characterID ?? charData.charID ?? charData.charid ?? 0,
    ) || 0;
    const sessionShipID = Number(
      session && (session.activeShipID ?? session.shipID ?? session.shipid),
    ) || 0;
    // The ship the session names, where it names one. A pilot that controls a
    // structure names the structure, which is no ship of its own: nothing is
    // said then.
    const activeShip = sessionShipID > 0
      ? findCharacterShip(charID, sessionShipID)
      : getActiveShipRecord(charID);
    if (!activeShip) {
      return {};
    }
    const fittingSnapshot = getShipFittingSnapshot(charID, activeShip.itemID, {
      shipItem: activeShip,
      reason: "dogma.ship-modified-char-attrs",
      ...this._getFittingContextSnapshotOptions(
        options.fittingContext,
        charID,
        activeShip.itemID,
      ),
    });
    if (!fittingSnapshot) {
      return {};
    }
    const withFitting = collectCharacterModifierAttributes(
      fittingSnapshot.skillMap,
      fittingSnapshot.fittedItems,
      fittingSnapshot.assumedActiveModuleContexts,
    ) || {};
    const withoutFitting = collectCharacterModifierAttributes(
      fittingSnapshot.skillMap,
      [],
      [],
    ) || {};
    const modified = {};
    for (const [attributeID, value] of Object.entries(withFitting)) {
      if (Number(value) !== Number(withoutFitting[attributeID])) {
        modified[attributeID] = Number(value);
      }
    }
    return modified;
  },

  _buildShipModifiedCharacterAttributeDict(
    charData = {},
    characterID = null,
    session = null,
    options = {},
  ) {
    const attributes = this._buildShipModifiedCharacterAttributes(
      charData,
      characterID,
      session,
      options,
    );
    // The client's godma lays these over the character (godma.py
    // ProcessAllInfo), and they are marked as the character's item is.
    return {
      type: "dict",
      ...this._getCharacterAttributeWireKinds(charData, attributes),
      entries: Object.entries(attributes).map(([attributeID, value]) => [
        Number(attributeID),
        value,
      ]),
    };
  },

  // How a character's attribute values go on the wire. They are floats
  // whatever they hold, as Tranquility's are, but for its own five where
  // nothing is added to them: its client prints {385: 1.0, 4: 0.0, 389: 100.0,
  // ..., 164: 19, 165: 20} for a character with no implant, and 164: 25.0,
  // 165: 26.0 for one with 6 added to each. The five are the integers the
  // character's record has; a modified one is the float the reckoning gives.
  // Marks for the marshaller (marshal.js): the values are the numbers they were.
  _getCharacterAttributeWireKinds(charData = {}, attributes = {}) {
    const ownAttributes = readCharacterOwnAttributes(charData.characterAttributes);
    const integerKeys = Object.keys(ownAttributes)
      .map(Number)
      .filter((attributeID) => attributes[attributeID] === ownAttributes[attributeID]);
    return {
      realValues: true,
      ...(integerKeys.length > 0 ? { integerKeys } : {}),
    };
  },

  _buildCharacterAttributeDict(charData = {}, characterID = null) {
    const attributes = this._buildCharacterAttributes(charData, characterID);
    return {
      type: "dict",
      ...this._getCharacterAttributeWireKinds(charData, attributes),
      entries: Object.entries(attributes).map(([attributeID, value]) => [
        Number(attributeID),
        value,
      ]),
    };
  },

  // What a character's item lists, which is not all this server reckons of a
  // character. Tranquility's, as its client's godma printed it at three logins,
  // lists 68 attributes: every one of its type's own (62), the type's mass,
  // capacity, volume and radius (4: 0.0, 38: 0.0, 161: 1.0, 162: 1.0), and two
  // that its type has not and its skills give it (190 corporationMemberLimit:
  // 20.0, 352 maxActiveDrones: 4.0). It lists nothing that its type has not and
  // nothing gives it (no maxJumpClones, no cloneJumpCoolDown), and not the
  // pilot's security status (2610), which is the ship's: a pilot's ship lists
  // 2610: 0.0012499609375 and the same pilot's character item has none.
  //
  // An attribute the type has not is taken for given by nothing where it holds
  // the attribute's own default.
  _buildCharacterItemAttributes(
    charData = {},
    characterID = null,
    session = null,
    options = {},
  ) {
    const typeID = Number(charData.typeID || CHARACTER_TYPE_ID) || CHARACTER_TYPE_ID;
    const typeAttributes = getTypeDogmaAttributes(typeID);
    const typeRow = resolveItemByTypeID(typeID) || {};
    const rowFigures = {
      [ATTRIBUTE_MASS]: Number(typeRow.mass),
      [ATTRIBUTE_CAPACITY]: Number(typeRow.capacity),
      [ATTRIBUTE_VOLUME]: Number(typeRow.volume),
      [ATTRIBUTE_RADIUS]: Number(typeRow.radius),
    };
    const reckoned = {
      ...this._buildWholeCharacterAttributes(charData, characterID, session, options),
    };
    // What the item listed before it listed the whole character, with the
    // values it had: the five among them. Where it has no number (its industry
    // figures, for a character that has none) the whole character's stands.
    for (const [attributeID, value] of Object.entries(
      this._buildCharacterAttributes(charData, characterID),
    )) {
      if (Number.isFinite(value)) {
        reckoned[attributeID] = value;
      }
    }
    const listed = {};
    for (const [attributeID, figure] of Object.entries(rowFigures)) {
      if (Number.isFinite(figure)) {
        listed[attributeID] = figure;
      }
    }
    for (const [attributeID, value] of Object.entries(reckoned)) {
      const numericAttributeID = Number(attributeID);
      if (
        !Number.isFinite(value) ||
        numericAttributeID === ATTRIBUTE_PILOT_SECURITY_STATUS
      ) {
        continue;
      }
      if (
        !(attributeID in typeAttributes) &&
        value === getDogmaAttributeDefaultValue(numericAttributeID)
      ) {
        continue;
      }
      listed[attributeID] = value;
    }
    return listed;
  },

  _buildCharacterItemAttributeDict(
    charData = {},
    characterID = null,
    session = null,
    options = {},
  ) {
    const attributes = this._buildCharacterItemAttributes(
      charData,
      characterID,
      session,
      options,
    );
    return {
      type: "dict",
      ...this._getCharacterAttributeWireKinds(charData, attributes),
      entries: Object.entries(attributes).map(([attributeID, value]) => [
        Number(attributeID),
        value,
      ]),
    };
  },

  _buildShipAttributeDict(charData = {}, shipData = {}, session = null, options = {}) {
    const attributes = this._buildShipAttributes(
      charData,
      shipData,
      session,
      options,
    );
    // The pilot's drone attributes, maxActiveDrones (352) and
    // droneControlDistance (458), ride on this server's ship for its own drone
    // rules (liveFittingState CHAR_DOMAIN_SHIP_ATTRIBUTE_ALLOWLIST), but they
    // are the character's: the skills and hull traits that give them modify
    // the pilot (their modifiers' domain is charID), and the client reads them
    // off the character. No ship in Tranquility's answers lists them: 18 ship
    // entries in the GetAllInfo answers of ten recordings, of a Capsule, a
    // Reaper and a Venture (which has a drone bay), and none has either. So a
    // ship's item lists neither, but where its type has it.
    const typeAttributes = getTypeDogmaAttributes(Number(shipData && shipData.typeID));
    for (const attributeID of PILOT_DRONE_ATTRIBUTE_IDS) {
      if (!(String(attributeID) in typeAttributes)) {
        delete attributes[attributeID];
      }
    }
    // A ship's attribute values are floats whatever they hold, as Tranquility's
    // are (dogmaService._getAttributeWireKinds).
    return this._buildAttributeValueDict(attributes, { realValues: true });
  },

  _buildChargeSublocationRow({
    locationID,
    flagID,
    typeID,
    quantity,
  }) {
    return {
      type: "object",
      name: "util.Row",
      args: {
        type: "dict",
        entries: [
          ["header", ["instanceID", "flagID", "typeID", "quantity"]],
          ["line", [locationID, flagID, typeID, quantity]],
        ],
      },
    };
  },

  _buildChargeStateDict(charID, shipID, options = {}) {
    const chargesByFlag = this._buildChargeSublocationData(charID, shipID, options);
    // The ship is named even when nothing is loaded: Tranquility's whole
    // answers for a ship with no charges read {shipID: {}} (a capsule's
    // GetAllInfo, and Board for a ship with three modules and no charges).
    return {
      type: "dict",
      entries: [[
        shipID,
        {
          type: "dict",
          entries: chargesByFlag.map((entry) => [
            entry.flagID,
            this._buildChargeSublocationRow({
              locationID: shipID,
              flagID: entry.flagID,
              typeID: entry.typeID,
              quantity: entry.quantity,
            }),
          ]),
        },
      ]],
    };
  },

  _findInventoryItemContext(requestedItemID, session, options = {}) {
    const includeAttributes = options.includeAttributes !== false;
    const charID = this._getCharID(session);
    if (Array.isArray(requestedItemID) && requestedItemID.length >= 3) {
      const [shipID, flagID, typeID] = requestedItemID;
      const controlledBattery = require("../../starbase/starbaseControlRuntime").getControlledBatteryContext(session, Number(shipID));
      if (controlledBattery && Number(flagID) !== 27) return null;
      const chargeItem = controlledBattery
        ? listContainerItems(null, Number(shipID), Number(flagID)).find((row) => Number(row.categoryID) === 8)
        : getLoadedChargeByFlag(charID, Number(shipID), Number(flagID));
      if (
        chargeItem &&
        Number(chargeItem.typeID) === Number(typeID)
      ) {
        return {
          itemID: requestedItemID,
          typeID: Number(typeID),
          item: chargeItem,
          attributes: includeAttributes
            ? this._buildInventoryItemAttributes(chargeItem, session)
            : undefined,
          baseAttributes: includeAttributes
            ? this._buildInventoryItemAttributes(chargeItem)
            : undefined,
        };
      }
      return null;
    }
    const numericItemID = Number.parseInt(String(requestedItemID), 10) || 0;
    if (numericItemID <= 0) {
      return null;
    }
    const item = findItemById(numericItemID);
    if (
      !item ||
      (Number(item.ownerID) !== charID &&
        !require("../../starbase/starbaseControlRuntime").getControlledBatteryContext(session, item) &&
        !require("../../starbase/starbaseControlRuntime").getVisibleOwnedTower(session, item)) ||
      Number(item.categoryID) === SHIP_CATEGORY_ID
    ) {
      return null;
    }
    return {
      itemID: item.itemID,
      typeID: Number(item.typeID),
      item,
      attributes: includeAttributes
        ? this._buildInventoryItemAttributes(item, session)
        : undefined,
      baseAttributes: includeAttributes
        ? this._buildInventoryItemAttributes(item)
        : undefined,
    };
  },

  _buildShipBaseAttributes(shipData = {}) {
    const payload = readStaticTable(TABLE.SHIP_DOGMA_ATTRIBUTES);
    const shipTypeID = Number(shipData.typeID);
    const staticEntry =
      Number.isInteger(shipTypeID) &&
      payload &&
      payload.shipAttributesByTypeID &&
      typeof payload.shipAttributesByTypeID === "object"
        ? payload.shipAttributesByTypeID[String(shipTypeID)] || null
        : null;
    const staticAttributes =
      staticEntry && staticEntry.attributes && typeof staticEntry.attributes === "object"
        ? staticEntry.attributes
        : null;
    const attributes = staticAttributes
      ? Object.fromEntries(
          Object.entries(staticAttributes)
            .map(([attributeID, value]) => [Number(attributeID), Number(value)])
            .filter(
              ([attributeID, value]) =>
                Number.isInteger(attributeID) && Number.isFinite(value),
            ),
        )
      : {};
    const shipMetadata =
      Number.isInteger(shipTypeID) && shipTypeID > 0
        ? resolveShipByTypeID(shipTypeID)
        : null;
    const resolvedMass = Number(shipData.mass ?? (shipMetadata && shipMetadata.mass));
    if (!(ATTRIBUTE_MASS in attributes) && Number.isFinite(resolvedMass)) {
      attributes[ATTRIBUTE_MASS] = resolvedMass;
    }
    const resolvedCapacity = Number(
      shipData.capacity ?? (shipMetadata && shipMetadata.capacity),
    );
    if (!(ATTRIBUTE_CAPACITY in attributes) && Number.isFinite(resolvedCapacity)) {
      attributes[ATTRIBUTE_CAPACITY] = resolvedCapacity;
    }
    const resolvedVolume = Number(shipData.volume ?? (shipMetadata && shipMetadata.volume));
    if (!(ATTRIBUTE_VOLUME in attributes) && Number.isFinite(resolvedVolume)) {
      attributes[ATTRIBUTE_VOLUME] = resolvedVolume;
    }
    const resolvedRadius = Number(shipData.radius ?? (shipMetadata && shipMetadata.radius));
    if (!(ATTRIBUTE_RADIUS in attributes) && Number.isFinite(resolvedRadius)) {
      attributes[ATTRIBUTE_RADIUS] = resolvedRadius;
    }
    return attributes;
  },

  _resolveItemAttributeContext(requestedItemID, session) {
    const charID = this._getCharID(session);
    const charData = this._getCharacterRecord(session) || {};
    const tupleItemID = Array.isArray(requestedItemID) ? requestedItemID[0] : requestedItemID;
    const numericItemID =
      Number.parseInt(String(tupleItemID), 10) || this._getShipID(session);
    const skillRecord =
      getCharacterSkills(charID).find(
        (skill) =>
          skill.itemID === numericItemID ||
          skill.itemID === Number.parseInt(String(requestedItemID), 10),
      ) || null;
    if (numericItemID === charID) {
      const attributes = this._buildCharacterAttributes(charData, charID);
      return {
        itemID: charID,
        typeID: Number(charData.typeID || CHARACTER_TYPE_ID),
        attributes,
        baseAttributes: { ...attributes },
      };
    }
    if (skillRecord) {
      return {
        itemID: skillRecord.itemID,
        typeID: Number(skillRecord.typeID),
        attributes: {},
        baseAttributes: {},
      };
    }
    const inventoryContext = this._findInventoryItemContext(requestedItemID, session);
    if (inventoryContext) {
      return inventoryContext;
    }
    const controlledStructureShip = this._getControlledStructureShipMetadata(session);
    if (
      controlledStructureShip &&
      Number(controlledStructureShip.itemID) === numericItemID
    ) {
      const attributes = this._buildInventoryItemAttributes(
        controlledStructureShip,
        session,
      );
      return {
        itemID: controlledStructureShip.itemID,
        typeID: Number(controlledStructureShip.typeID),
        attributes,
        baseAttributes: { ...attributes },
      };
    }
    const shipRecord =
      findCharacterShip(charID, numericItemID) ||
      this._getActiveShipRecord(session) ||
      this._getShipMetadata(session);
    const attributes = this._buildShipAttributes(charData, shipRecord || {}, session);
    return {
      itemID: shipRecord && shipRecord.itemID ? shipRecord.itemID : numericItemID,
      typeID: Number(shipRecord && shipRecord.typeID),
      attributes,
      baseAttributes: this._buildShipBaseAttributes(shipRecord || {}),
    };
  },

  _formatDebugValue(value, fallback = "[n/a]") {
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return fallback;
      }
      return String(value);
    }
    if (typeof value === "boolean") {
      return value ? "True" : "False";
    }
    return String(value);
  },

  _buildActivationState(charID, shipID, shipRecord = null, options = {}) {
    // The ship's attributes are worked out once, for the two parts that are
    // read from them: the ship's own row and the racks' heat.
    const shipAttributes = this._buildShipStateAttributes(charID, shipRecord, options);
    return [
      this._buildShipState(charID, shipID, shipRecord, { ...options, shipAttributes }),
      options.includeCharges === false
        ? this._buildEmptyDict()
        : this._buildChargeStateDict(charID, shipID, options),
      buildWeaponBankStateDict(shipID, { characterID: charID }),
      // Each rack's entry is the ship's own (activationHeatState.js): its heat,
      // capacity, multiplier and dissipation rate from those attributes, and
      // what is heating it from the ship's rack where the ship is in space.
      buildShipHeatStateDict(shipAttributes, {
        timestamp: currentFileTime(),
        rackHeat: options.session
          ? spaceRuntime.getShipRackHeat(options.session, shipID)
          : null,
      }),
    ];
  },

  // The active ship's attributes as the answer's own shipInfo has them, for the
  // parts of the ship's state that are read from them; null where there is no
  // ship record. A controlled structure's are built another way than a ship's.
  _buildShipStateAttributes(charID, shipRecord, options = {}) {
    if (!shipRecord) {
      return null;
    }
    return options.includeAllFittingOwners === true
      ? this._buildInventoryItemAttributes(shipRecord, options.session || null, {
          fittingContext: options.fittingContext,
          includeQuantityAttribute: false,
        })
      : this._buildShipAttributes(
          { characterID: charID },
          shipRecord,
          options.session || null,
          { fittingContext: options.fittingContext, heatAtMs: options.heatAtMs },
        );
  },

  _getCharacterItemLocationID(session, options = {}) {
    const allowShipLocation = options.allowShipLocation !== false;
    if (
      !allowShipLocation ||
      (session && session._deferredDockedShipSessionChange)
    ) {
      return this._getLocationID(session);
    }
    return this._getShipID(session);
  },

  _buildCharacterInfoDict(charID, charData, locationID, options = {}) {
    return {
      type: "dict",
      entries: this._buildCharacterInfoEntries(charID, charData, locationID, options),
    };
  },

  _buildCharacterInfoEntries(charID, charData, locationID, options = {}) {
    return [
      [
        charID,
        this._buildCommonGetInfoEntry({
          itemID: charID,
          typeID: charData.typeID || CHARACTER_TYPE_ID,
          ownerID: charID,
          locationID,
          flagID: FLAG_PILOT,
          groupID: CHARACTER_GROUP_ID,
          categoryID: CHARACTER_CATEGORY_ID,
          quantity: -1,
          singleton: 1,
          stacksize: 1,
          description: "character",
          attributes: this._buildCharacterItemAttributeDict(
            charData,
            charID,
            options.session || null,
            options,
          ),
        }),
      ],
    ];
  },

  // What GetAllInfo says of the character's attributes that its ship modifies.
  // Tranquility's, in 82 answers as its client logged them, is None in 70, and
  // in 12
  //   <KeyVal: {'attributes': {212: 1.1804337950307635}, 'wallclockTime': ..., 'time': ...}>
  // three fields and one attribute. The 12 are every answer of one ship, whose
  // three ballistic controls raise its pilot's missile damage (1.07 thrice
  // over, with the stacking penalty); the ship alone was asked for in each, in
  // space and docked. It is no item entry: there is no row in it.
  _buildShipModifiedCharacterAttributeInfo(
    charID,
    charData,
    session = null,
    options = {},
  ) {
    const attributes = this._buildShipModifiedCharacterAttributeDict(
      charData,
      charID,
      session,
      options,
    );
    if (attributes.entries.length === 0) {
      return null;
    }
    const { time, wallclockTime } = this._getInfoEntryClocks(session);
    return {
      type: "object",
      name: "util.KeyVal",
      args: {
        type: "dict",
        entries: [
          ["attributes", attributes],
          ["wallclockTime", wallclockTime],
          ["time", time],
        ],
      },
    };
  },

  _buildCharacterBrain(charID, session = null) {
    return buildBootstrapCharacterBrain(charID, 0, {
      shipID:
        session && (
          session.activeShipID ??
          session.shipID ??
          session.shipid
        ),
      structureID:
        session && (
          session.structureid ??
          session.structureID ??
          session.structureId
        ),
    });
  },

  _getDockedStructureRecord(session) {
    const structureID = Number(
      session && (session.structureid || session.structureID),
    ) || 0;
    if (structureID <= 0) {
      return null;
    }
    return worldData.getStructureByID(structureID) || null;
  },

  _buildStructureInfoDict(structure, session = null, options = {}) {
    if (!structure) {
      return this._buildEmptyDict();
    }
    const structureItem = this._buildStructureControlShipMetadata(structure);
    if (!structureItem) {
      return this._buildEmptyDict();
    }
    const structureAttributes = this._buildInventoryItemAttributes(
      structureItem,
      session,
      {
        includeQuantityAttribute: false,
      },
    );
    if (options.includeActivationAttributes === true) {
      Object.assign(structureAttributes, STRUCTURE_ACTIVATION_ATTRIBUTE_VALUES);
    }
    return {
      type: "dict",
      entries: [[
        structureItem.itemID,
        this._buildCommonGetInfoEntry({
          itemID: structureItem.itemID,
          typeID: structureItem.typeID,
          ownerID: structureItem.ownerID,
          locationID: structureItem.locationID,
          flagID: structureItem.flagID,
          groupID: structureItem.groupID,
          categoryID: structureItem.categoryID,
          quantity: structureItem.quantity,
          singleton: structureItem.singleton,
          stacksize: structureItem.stacksize,
          customInfo: structureItem.customInfo,
          description: "structure",
          attributes: this._buildAttributeValueDict(structureAttributes, {
            realValues: true,
          }),
          session,
        }),
      ]],
    };
  },

  _shouldDeferLoginShipFittingBootstrap(session) {
    void session;
    return false;
  },

  _shouldPrimeLoginShipInfoChargeSublocations(session, options = {}) {
    if (!session || !session._space) {
      return false;
    }
    if (options.controllingStructure !== true && isDockedSession(session)) {
      return false;
    }
    return LIVE_SPACE_TUPLE_CHARGE_PROFILES.has(
      String(session._space.loginChargeHydrationProfile || ""),
    );
  },

  _shouldPrimeDockedLoginShipInfoChargeSublocations(session) {
    // Retail identifies a fitted charge by the (shipID, flagID, chargeTypeID)
    // tuple while DOCKED as well as in space. Golden trace
    // "Topping Up Ammo from cargo direct to fitting while docked.txt":
    //   line 357 — "godma  Attribute quantity of module (1054768634001L, 28, 222)
    //               changed from 57 to 80 value I had was 57"
    // The docked client's godma already held the charge under its TUPLE key
    // before the LoadAmmo, so docked hydration must seed that key. The same
    // 1073-line docked trace contains no real itemID for the loaded charge at
    // all.
    return isDockedSession(session) === true;
  },

  // In-space only, by design and not by accident: the pending batch is parked on
  // session._space and _flushPostGetAllInfoChargeQuantityRefresh reads it from
  // there. A docked session has no _space, and does not need this — its tuple
  // seed already carries attribute 805. Callers gate on liveSpaceLoginTuplePrime
  // so this early return is a guard, not the thing that disables docked.
  _queuePostGetAllInfoChargeQuantityRefresh(session, charID, shipID, options = {}) {
    if (!session || !session._space) {
      return 0;
    }
    const changes = this._buildLoadedChargeTupleQuantityChanges(
      session,
      charID,
      shipID,
      options,
    );
    if (changes.length <= 0) {
      delete session._space.pendingDogmaGetAllInfoChargeQuantityRefresh;
      return 0;
    }
    session._space.pendingDogmaGetAllInfoChargeQuantityRefresh = changes;
    return changes.length;
  },

  _shouldIncludeLoginShipInfoLoadedCharges(session) {
    // ⚠️ DO NOT change this to `return false`. It has been flipped to false and
    // reverted three times, each time breaking the docked fitting window. Read
    // this whole comment before touching it — the argument for false is
    // superficially convincing and is wrong.
    //
    // Docked normal fitting and its warning pass consume the ACTUAL loaded
    // charge rows in the module slots. Keep those real charge items in shipInfo
    // docked-only. Live-space HUD authority is tuple-backed.
    //
    // Why the client forces this — the shipped client mixes two identity models
    // in one call path, and we do not get to pick which:
    //
    //   shipfitting/fittingDogmaLocationUtil.py:64
    //     chargesByFlag[module.flagID] = module.itemID   <- key is the REAL itemID,
    //                                                       read from the dogma model
    //   shipfitting/fittingDogmaLocationUtil.py:179-182
    //     if godma.GetItem(shipID) is not None:
    //         GAV = dogmaLocation.GetGodmaAttributeValue <- DOCKED reads from GODMA
    //   shipfitting/fittingDogmaLocationUtil.py:305-307
    //     GetNumChargesFullyLoaded -> GAV(chargeKey, attributeVolume)
    //
    // So while docked, godma must resolve the charge under the same real itemID
    // the dogma model handed out. Return false and godmarowset.__getitem__ raises
    // `KeyError: <chargeItemID>` the moment a player hovers the DPS readout in the
    // fitting window. In space godma has no ship item, GAV stays on the dogma
    // location, and the tuple model is fine — hence docked-only, not always-true.
    //
    // Why the "retail is tuple-keyed" argument does not overturn this: the trace
    // cited for it, "Topping Up Ammo from cargo direct to fitting while docked"
    // (D:\SSDSync\EveBadStuff\LOGS\, not in this repo), is a TOP-UP capture from
    // an already-logged-in client. It contains ZERO GetAllInfo calls — verified,
    // not assumed — so it cannot show what login seeds. Tuple-keyed attribute-805
    // updates and a real login row are not in conflict; we send both, and
    // 1d0139d2's docked tuple prime is kept.
    //
    // Full argument, the golden log's contents, and what evidence would actually
    // change this decision: doc/DOCKED_FITTED_CHARGE_IDENTITY.md
    //
    // Guarded by fittingResourceSkillParity: "docked GetAllInfo seeds loaded
    // charges under both their tuple and real identity" (EW-0603).
    return isDockedSession(session) === true;
  },

  _buildShipState(charID, shipID, shipRecord = null, options = {}) {
    const shipCondition = getShipConditionState(shipRecord);
    // The ship's own row has amounts, and the same ones the ship's attributes have
    // in the answer beside it (shipConditionAmounts.js). A controlled structure's
    // attributes are built another way, and its row reads them from there:
    // Tranquility's row for one is [structureID, False, 0.0, 100000.0, 0, 0.0,
    // 2400000.0, False] beside its attributes 18: 100000.0 and 264: 2400000.0.
    const shipAttributes =
      options.shipAttributes === undefined
        ? this._buildShipStateAttributes(charID, shipRecord, options)
        : options.shipAttributes;
    const shipAmounts = shipAttributes
      ? readShipConditionAmounts(shipAttributes)
      : shipCondition;
    const fittedItems =
      options.includeFittedItems === false
        ? []
        : this._isFittingContextMatch(
            options.fittingContext,
            charID,
            shipID,
            options,
          )
          ? options.fittingContext.moduleItems
        : options.includeAllFittingOwners === true
          ? listContainerItems(null, shipID, null)
            .filter((item) => item && isShipFittingFlag(item.flagID))
            .filter((item) => Number(item.categoryID) !== 8)
            .sort((left, right) => (
              (Number(left && left.flagID) || 0) - (Number(right && right.flagID) || 0) ||
              (Number(left && left.itemID) || 0) - (Number(right && right.itemID) || 0)
            ))
          : getFittedModuleItems(charID, shipID);
    return {
      type: "dict",
      entries: [
        [
          shipID,
          this._buildPackedInstanceRow({
            itemID: shipID,
            damage: shipAmounts.damage,
            charge: shipAmounts.charge,
            armorDamage: shipAmounts.armorDamage,
            shieldCharge: shipAmounts.shieldCharge,
            incapacitated: shipCondition.incapacitated,
          }),
        ],
        // The pilot's own row carries nothing: [charID, False, 0.0, 0.0, 0, 0.0, 0.0,
        // False] in every whole answer of Tranquility's (two of GetAllInfo, one of Board).
        [
          charID,
          this._buildPackedInstanceRow({
            itemID: charID,
          }),
        ],
        ...fittedItems.map((item) => [
          item.itemID,
          this._buildPackedInstanceRow(buildModuleStatusSnapshot(item)),
        ]),
      ],
    };
  },

  Handle_GetCharacterAttributes(args, session) {
    log.debug("[DogmaIM] GetCharacterAttributes");
    return this._buildCharacterAttributeDict(
      this._getCharacterRecord(session) || {},
      this._getCharID(session),
    );
  },

  Handle_GetAllInfo(args, session) {
    log.debug("[DogmaIM] GetAllInfo");
    const startedAtMs = Date.now();
    const charID = this._getCharID(session);
    const charData = this._getCharacterRecord(session) || {};
    const shipContext = this._getCurrentDogmaShipContext(session);
    const shipID = shipContext.shipID;
    const shipMetadata = shipContext.shipMetadata;
    this._normalizeControlledStructureFittingOwners(shipContext);
    if (shipContext.controllingStructure) {
      const syncResult = syncStructureServiceModuleState(shipID);
      if (!syncResult || syncResult.success !== true) {
        log.warn(
          `[DogmaIM] GetAllInfo structure service sync failed structure=${shipID} error=${syncResult && syncResult.errorMsg || "UNKNOWN"}`,
        );
      } else if (
        Array.isArray(syncResult.fuelCycleChanges) &&
        syncResult.fuelCycleChanges.length > 0
      ) {
        this._syncInventoryChanges(session, syncResult.fuelCycleChanges);
      }
    }
    const ownerID = charID;
    const locationID = this._getLocationID(session);
    const getCharInfo = this._toBoolArg(args && args[0], true);
    const getShipInfo = this._toBoolArg(args && args[1], true);
    const getStructureInfo = this._toBoolArg(
      args && args[2],
      Boolean(session && (session.structureid || session.structureID)),
    );
    let fittingContext = null;
    const getFittingContext = () => {
      if (!getShipInfo) {
        return null;
      }
      if (!fittingContext) {
        fittingContext = this._buildFittingHydrationContext(
          charID,
          shipID,
          shipMetadata,
          {
            includeAllFittingOwners: shipContext.controllingStructure,
          },
        );
      }
      return fittingContext;
    };
    if (getShipInfo && !shipContext.controllingStructure) {
      const fittingParityResult = ensureShipFittingInventoryParity(
        charID,
        shipContext.shipRecord || shipID,
        {
          logFailures: true,
        },
      );
      if (
        fittingParityResult &&
        fittingParityResult.data &&
        Array.isArray(fittingParityResult.data.changes) &&
        fittingParityResult.data.changes.length > 0
      ) {
        invalidateShipFittingSnapshot(charID, shipID, {
          shipItem: shipContext.shipRecord || shipMetadata,
        });
        this._syncInventoryChanges(session, fittingParityResult.data.changes, {
          fittingContext: getFittingContext(),
        });
      }
    }
    fittingContext = getFittingContext();
    const includeDockedShipInfoBootstrap =
      getShipInfo &&
      !getCharInfo &&
      isDockedSession(session);
    // The ship alone asked for, in space: an undock, a jump, or a change of ship
    // (eject, a pod after a loss, boarding).
    const spaceShipOnlyPrime =
      getShipInfo &&
      !getCharInfo &&
      !getStructureInfo &&
      !shipContext.controllingStructure &&
      !isDockedSession(session);
    const includeOptionalDogmaBootstrap =
      getShipInfo && (
        getCharInfo ||
        getStructureInfo ||
        shipContext.controllingStructure ||
        includeDockedShipInfoBootstrap ||
        spaceShipOnlyPrime
      );
    const includeDockedCharInfo = includeDockedShipInfoBootstrap;
    const includeCharInfo = getCharInfo || includeDockedCharInfo;
    const deferLoginShipFittingBootstrap =
      getShipInfo && this._shouldDeferLoginShipFittingBootstrap(session);
    // Two independent reasons to seed tuple charge rows into shipInfo. They are
    // kept apart on purpose: only the live-space/controlled-structure one has
    // ever suppressed shipModifiedCharAttribs/locationInfo, and the docked one
    // must not inherit that suppression.
    const liveSpaceLoginTuplePrime =
      getShipInfo && (
        shipContext.controllingStructure ||
        this._shouldPrimeLoginShipInfoChargeSublocations(session, {
          controllingStructure: false,
        })
      );
    const dockedLoginTuplePrime =
      getShipInfo &&
      !shipContext.controllingStructure &&
      this._shouldPrimeDockedLoginShipInfoChargeSublocations(session);
    const primeLoginShipInfoChargeSublocations =
      liveSpaceLoginTuplePrime || dockedLoginTuplePrime;
    const includeLoginShipInfoLoadedCharges =
      getShipInfo &&
      !shipContext.controllingStructure &&
      this._shouldIncludeLoginShipInfoLoadedCharges(session);
    // Wherever the ship is primed: Tranquility says it of a ship asked for
    // alone, in space and docked.
    const includeShipModifiedCharAttribs = getShipInfo;
    const characterLocationID = this._getCharacterItemLocationID(session, {
      allowShipLocation: getShipInfo,
    });
    const resolvedShipLocationID = this._resolveActiveShipLocationID(
      session,
      shipMetadata,
      locationID,
    );
    const resolvedShipFlagID = this._resolveActiveShipFlagID(
      session,
      shipMetadata,
      4,
    );
    const locationInfo = this._buildEmptyDict();
    const getAllInfoLocationInfo =
      getCharInfo && getShipInfo && !liveSpaceLoginTuplePrime
        ? locationInfo
        : null;
    const dockedStructureRecord = getStructureInfo
      ? this._getDockedStructureRecord(session)
      : null;
    const shipInfoEntry = getShipInfo
      ? (
        this._getCachedDockedItemInfoEntry(session, shipID, shipMetadata) ||
        this._buildCommonGetInfoEntry({
          itemID: shipID,
          typeID: shipMetadata.typeID,
          ownerID: shipMetadata.ownerID || ownerID,
          locationID: resolvedShipLocationID,
          flagID: resolvedShipFlagID,
          groupID: shipMetadata.groupID,
          categoryID: shipMetadata.categoryID,
          quantity:
            shipMetadata.quantity === undefined ||
            shipMetadata.quantity === null
              ? -1
              : shipMetadata.quantity,
          singleton:
            shipMetadata.singleton === undefined ||
            shipMetadata.singleton === null
              ? 1
              : shipMetadata.singleton,
          stacksize:
            shipMetadata.stacksize === undefined ||
            shipMetadata.stacksize === null
              ? 1
              : shipMetadata.stacksize,
          customInfo: shipContext.controllingStructure
            ? ""
            : (shipMetadata.customInfo || null),
          preserveNullCustomInfo: !shipContext.controllingStructure,
          description: shipContext.controllingStructure ? "structure" : "ship",
          attributes: shipContext.controllingStructure
            ? this._buildInventoryItemAttributeDict(shipMetadata, session, {
                fittingContext,
                includeQuantityAttribute: false,
              })
            : this._buildShipAttributeDict(charData, shipMetadata, session, {
                fittingContext,
                heatAtMs: startedAtMs,
              }),
          session,
        })
      )
      : null;
    if (getShipInfo && shipInfoEntry) {
      this._cacheDockedItemInfoEntry(session, shipID, shipMetadata, shipInfoEntry);
    }
    const shipInventoryInfoEntries = getShipInfo
      ? this._buildShipInventoryInfoEntries(
          charID,
          shipID,
          shipMetadata.ownerID || ownerID,
          resolvedShipLocationID,
          session,
          {
            includeFittedItems: !deferLoginShipFittingBootstrap,
            includeLoadedCharges: includeLoginShipInfoLoadedCharges,
            includeChargeSublocations: primeLoginShipInfoChargeSublocations,
            includeAllFittingOwners: shipContext.controllingStructure,
            controlledStructure: shipContext.controllingStructure,
            includeFittedItemQuantityAttribute: !shipContext.controllingStructure,
            fittingContext,
          },
        )
      : [];
    const shipInfoTupleChargeEntries = shipInventoryInfoEntries.filter(
      (entry) => Array.isArray(Array.isArray(entry) ? entry[0] : null),
    ).length;
    // liveSpaceLoginTuplePrime, NOT primeLoginShipInfoChargeSublocations. The
    // refresh is queued on session._space and flushed from the post-GetAllInfo
    // hook, which is also in-space only, so a docked session could never do
    // either — gating on the combined flag made the docked case look supported
    // when _queuePostGetAllInfoChargeQuantityRefresh was already returning 0 on
    // !session._space.
    //
    // Docked does not need it and must not have it. The docked tuple seed built
    // by _shouldPrimeDockedLoginShipInfoChargeSublocations already carries the
    // count on attribute 805, and this refresh only republishes the current
    // value against itself (newValue === oldValue). Golden "Topping Up Ammo from
    // cargo direct to fitting while docked.txt" contains no such follow-up
    // batch, so emitting one docked would be extra traffic retail never sends.
    if (
      !shipContext.controllingStructure &&
      liveSpaceLoginTuplePrime &&
      shipInfoTupleChargeEntries > 0
    ) {
      this._queuePostGetAllInfoChargeQuantityRefresh(session, charID, shipID, {
        includeAllFittingOwners: shipContext.controllingStructure,
        fittingContext,
      });
    } else if (session && session._space) {
      delete session._space.pendingDogmaGetAllInfoChargeQuantityRefresh;
    }
    log.debug(
      `[DogmaIM] GetAllInfo shipInfo entries=${shipInventoryInfoEntries.length} ` +
      `tupleCharges=${shipInfoTupleChargeEntries} ` +
      `loadedCharges=${includeLoginShipInfoLoadedCharges ? 1 : 0} ` +
      `deferredFitting=${deferLoginShipFittingBootstrap ? 1 : 0} ` +
      `loginTuplePrime=${primeLoginShipInfoChargeSublocations ? 1 : 0} ` +
      `docked=${isDockedSession(session) ? 1 : 0}`,
    );
    // The live V24.01 client's util.KeyVal RAISES AttributeError on any MISSING top-level
    // GetAllInfo key. On undock, godma.ProcessAllInfo reads `allInfo.charInfo` and
    // MakeShipActive reads `allInfo.shipState`; an omitted key throws and the entire undock
    // dogma pass dies (no module cycling, no own-ship damage). DO NOT omit these keys; it
    // re-breaks undock (regressed by d525d116 "Match golden protocol return payloads").
    //
    // Tranquility does not omit them either. The golden captures only look as if it does:
    // the client's log cuts each logged line at about 2,600 characters, which falls inside
    // shipInfo for any ship with fittings, before these keys. The two (False, True, None)
    // answers in space that are logged whole (a capsule after "Eject from Ship and Board
    // ship", and "Getting Killed to POD") carry activeShipID, charInfo {} and the four-part
    // shipState. So the ship's state goes with the ship whenever the ship is asked for.
    // With a null shipState the client asks ship.Board again after a change of ship in
    // space (clientDogmaLocation._MakeShipActive), a call it does not make on Tranquility.
    const optionalDogmaBootstrapEntries = [
      ["activeShipID", shipID],
      [
        "shipState",
        includeOptionalDogmaBootstrap
          ? this._buildActivationState(charID, shipID, shipContext.shipRecord, {
              includeFittedItems: !deferLoginShipFittingBootstrap,
              includeAllFittingOwners: shipContext.controllingStructure,
              fittingContext,
              session,
              // The ship's heat as it is at the answer's own time, the one number
              // its attributes above have.
              heatAtMs: startedAtMs,
              // Tuple charge sublocations are retail's docked identity too, so
              // the docked shipState charge dict must be populated (golden
              // line 357: the docked client's godma already knew the tuple).
              includeCharges: true,
            })
          : null,
      ],
    ];
    const result = {
      type: "object",
      name: "util.KeyVal",
      args: {
        type: "dict",
        entries: [
          [
            "systemWideEffectsOnShip",
            buildSystemWideEffectsPayloadForSystem(
              Number(session && (session.solarsystemid2 || session.solarsystemid)) || 0,
            ) || buildEmptySystemWideEffectsPayload(),
          ],
          [
            "shipModifiedCharAttribs",
            includeShipModifiedCharAttribs
              ? this._buildShipModifiedCharacterAttributeInfo(
                  charID,
                  charData,
                  session,
                  {
                    fittingContext,
                  },
                )
              : null,
          ],
          [
            "structureInfo",
            dockedStructureRecord
              ? this._buildStructureInfoDict(dockedStructureRecord, session, {
                  includeActivationAttributes: !shipContext.controllingStructure,
                })
              : this._buildEmptyDict(),
          ],
          ["locationInfo", getAllInfoLocationInfo],
          [
            "shipInfo",
            getShipInfo
              ? {
                  type: "dict",
                  entries: [[shipID, shipInfoEntry], ...shipInventoryInfoEntries],
                }
              : this._buildEmptyDict(),
          ],
          // Keep the first five fields in the order emitted by the controlled-structure
          // golden capture. These compatibility fields remain present after them because the
          // live V24.01 client raises AttributeError when activeShipID/shipState/charInfo are
          // absent during undock processing.
          ...optionalDogmaBootstrapEntries,
          [
            "charInfo",
            includeCharInfo
              ? [
                  this._buildCharacterInfoDict(
                    charID,
                    charData,
                    characterLocationID,
                    { session, fittingContext },
                  ),
                  // The client seeds charBrain exclusively from charInfo, and without it
                  // docked MakeShipActive later crashes in RemoveBrainEffects while switching ships.
                  this._buildCharacterBrain(charID, session),
                ]
              // Tranquility's value where the ship alone is primed in space is an empty
              // dict (the two whole answers named above). No whole answer shows the
              // value for a controlled structure, so that case is left as it was.
              : spaceShipOnlyPrime
                ? this._buildEmptyDict()
                : null,
          ],
        ],
      },
    };
    const elapsedMs = Date.now() - startedAtMs;
    const shipState = getShipInfo
      ? result.args.entries.find((entry) => entry[0] === "shipState")?.[1]
      : null;
    const shipStateEntries =
      shipState && Array.isArray(shipState) && shipState[0] && shipState[0].type === "dict"
        ? shipState[0].entries.length
        : 0;
    const chargeStateEntries =
      shipState && Array.isArray(shipState) && shipState[1] && shipState[1].type === "dict"
        ? shipState[1].entries.length
        : 0;
    recordSpaceBootstrapTrace(session, "dogma-get-all-info", {
      charID,
      shipID,
      elapsedMs,
      getCharInfo,
      getShipInfo,
      includeCharInfo,
      includeDockedCharInfo,
      shipInfoEntries: 1 + shipInventoryInfoEntries.length,
      shipStateEntries,
      chargeStateEntries,
      tupleCharges: shipInfoTupleChargeEntries,
      loadedCharges: includeLoginShipInfoLoadedCharges === true,
      deferredFitting: deferLoginShipFittingBootstrap === true,
      loginTuplePrime: primeLoginShipInfoChargeSublocations === true,
      docked: isDockedSession(session) === true,
    });
    if (elapsedMs >= 100) {
      log.info(
        `[DogmaIM] GetAllInfo took ${elapsedMs}ms ship=${shipID} ` +
        `shipInfoEntries=${1 + shipInventoryInfoEntries.length} shipStateEntries=${shipStateEntries} ` +
        `chargeStateEntries=${chargeStateEntries} deferredFitting=${deferLoginShipFittingBootstrap ? 1 : 0}`,
      );
    }
    return result;
  },

  Handle_ShipGetInfo(args, session) {
    log.debug("[DogmaIM] ShipGetInfo");
    const shipContext = this._getCurrentDogmaShipContext(session);
    const shipID = shipContext.shipID;
    const shipMetadata = shipContext.shipMetadata;
    this._normalizeControlledStructureFittingOwners(shipContext);
    const ownerID = shipMetadata.ownerID || this._getCharID(session);
    const locationID = this._resolveActiveShipLocationID(
      session,
      shipMetadata,
      this._getLocationID(session),
    );
    const entry = this._buildCommonGetInfoEntry({
      itemID: shipID,
      typeID: shipMetadata.typeID,
      ownerID,
      locationID,
      flagID: this._resolveActiveShipFlagID(session, shipMetadata, 4),
      groupID: shipMetadata.groupID,
      categoryID: shipMetadata.categoryID,
      quantity:
        shipMetadata.quantity === undefined || shipMetadata.quantity === null
          ? -1
          : shipMetadata.quantity,
      singleton:
        shipMetadata.singleton === undefined || shipMetadata.singleton === null
          ? 1
          : shipMetadata.singleton,
      stacksize:
        shipMetadata.stacksize === undefined || shipMetadata.stacksize === null
          ? 1
          : shipMetadata.stacksize,
      customInfo: shipContext.controllingStructure
        ? ""
        : (shipMetadata.customInfo || null),
      preserveNullCustomInfo: !shipContext.controllingStructure,
      description: shipContext.controllingStructure ? "structure" : "ship",
      attributes: shipContext.controllingStructure
        ? this._buildInventoryItemAttributeDict(shipMetadata, session, {
            includeQuantityAttribute: false,
          })
        : this._buildShipAttributeDict(
            this._getCharacterRecord(session) || {},
            shipMetadata,
            session,
          ),
      session,
    });
    return { type: "dict", entries: [[shipID, entry]] };
  },

  Handle_CharGetInfo(args, session) {
    log.debug("[DogmaIM] CharGetInfo");
    const charID = this._getCharID(session);
    const charData = this._getCharacterRecord(session) || {};
    const characterLocationID = this._getCharacterItemLocationID(session);
    return this._buildCharacterInfoDict(charID, charData, characterLocationID, {
      session,
    });
  },

  Handle_ItemGetInfo(args, session) {
    const requestedItemID = args && args.length > 0 ? args[0] : this._getShipID(session);
    log.debug(`[DogmaIM] ItemGetInfo(itemID=${requestedItemID})`);
    const charID = this._getCharID(session);
    const charData = this._getCharacterRecord(session) || {};
    const skillRecord =
      getCharacterSkills(charID).find(
        (skill) => skill.itemID === requestedItemID || skill.itemID === Number.parseInt(String(requestedItemID), 10),
      ) || null;
    const numericItemID = Number.parseInt(String(requestedItemID), 10) || this._getShipID(session);
    const shipRecord = findCharacterShip(charID, numericItemID);
    const isCharacter = numericItemID === charID;
    if (skillRecord) {
      return this._buildCommonGetInfoEntry({
        itemID: skillRecord.itemID,
        typeID: skillRecord.typeID,
        ownerID: skillRecord.ownerID || charID,
        locationID: this._coalesce(skillRecord.locationID, charID),
        flagID: skillRecord.flagID ?? SKILL_FLAG_ID,
        groupID: skillRecord.groupID,
        categoryID: skillRecord.categoryID,
        quantity: 1,
        singleton: 1,
        stacksize: 1,
        description: skillRecord.itemName || "skill",
        session,
      });
    }
    const inventoryContext = this._findInventoryItemContext(
      requestedItemID,
      session,
      {
        includeAttributes: false,
      },
    );
    if (inventoryContext && inventoryContext.item) {
      const item = inventoryContext.item;
      const cachedEntry = this._getCachedDockedItemInfoEntry(
        session,
        requestedItemID,
        item,
      );
      if (cachedEntry) {
        return cachedEntry;
      }
      const entry = this._buildCommonGetInfoEntry({
        itemID: Array.isArray(requestedItemID) ? requestedItemID : item.itemID,
        typeID: item.typeID,
        ownerID: item.ownerID || charID,
        locationID: item.locationID,
        flagID: item.flagID,
        groupID: item.groupID,
        categoryID: item.categoryID,
        quantity: item.quantity,
        singleton: item.singleton,
        stacksize: item.stacksize,
        customInfo: item.customInfo || "",
        description: item.itemName || "item",
        activeEffects: this._buildInventoryItemActiveEffects(item, session),
        attributes: this._buildInventoryItemAttributeDict(item, session),
        session,
      });
      this._cacheDockedItemInfoEntry(session, requestedItemID, item, entry);
      return entry;
    }
    const shipContext = this._getCurrentDogmaShipContext(session);
    if (
      shipContext.controllingStructure &&
      numericItemID === Number(shipContext.shipID)
    ) {
      const cachedEntry = this._getCachedDockedItemInfoEntry(
        session,
        requestedItemID,
        shipContext.shipMetadata,
      );
      if (cachedEntry) {
        return cachedEntry;
      }
      const entry = this._buildCommonGetInfoEntry({
        itemID: shipContext.shipID,
        typeID: shipContext.shipMetadata.typeID,
        ownerID: shipContext.shipMetadata.ownerID || charID,
        locationID: this._resolveActiveShipLocationID(
          session,
          shipContext.shipMetadata,
          this._getLocationID(session),
        ),
        flagID: this._resolveActiveShipFlagID(
          session,
          shipContext.shipMetadata,
          0,
        ),
        groupID: shipContext.shipMetadata.groupID,
        categoryID: shipContext.shipMetadata.categoryID,
        quantity:
          shipContext.shipMetadata.quantity === undefined ||
          shipContext.shipMetadata.quantity === null
            ? -1
            : shipContext.shipMetadata.quantity,
        singleton:
          shipContext.shipMetadata.singleton === undefined ||
          shipContext.shipMetadata.singleton === null
            ? 1
            : shipContext.shipMetadata.singleton,
        stacksize:
          shipContext.shipMetadata.stacksize === undefined ||
          shipContext.shipMetadata.stacksize === null
            ? 1
            : shipContext.shipMetadata.stacksize,
        customInfo: shipContext.shipMetadata.customInfo || "",
        description: "item",
        attributes: this._buildInventoryItemAttributeDict(
          shipContext.shipMetadata,
          session,
        ),
        session,
      });
      this._cacheDockedItemInfoEntry(
        session,
        requestedItemID,
        shipContext.shipMetadata,
        entry,
      );
      return entry;
    }
    const itemID = isCharacter
      ? charID
      : shipRecord
        ? shipRecord.itemID
        : this._getShipID(session);
    const ownerID = charID;
    const locationID = this._getLocationID(session);
    const shipMetadata = shipRecord || this._getActiveShipRecord(session) || this._getShipMetadata(session);
    const characterLocationID = this._getCharacterItemLocationID(session);
    return this._buildCommonGetInfoEntry({
      itemID,
      typeID: isCharacter ? (charData.typeID || 1373) : shipMetadata.typeID,
      ownerID,
      locationID: isCharacter
        ? characterLocationID
        : this._resolveActiveShipLocationID(session, shipMetadata, locationID),
      flagID: isCharacter
        ? FLAG_PILOT
        : this._resolveActiveShipFlagID(session, shipMetadata, 4),
      groupID: isCharacter ? 1 : shipMetadata.groupID,
      categoryID: isCharacter ? 3 : shipMetadata.categoryID,
      quantity: isCharacter
        ? -1
        : (
            shipMetadata.quantity === undefined || shipMetadata.quantity === null
              ? -1
              : shipMetadata.quantity
          ),
      singleton: isCharacter
        ? 1
        : (
            shipMetadata.singleton === undefined || shipMetadata.singleton === null
              ? 1
              : shipMetadata.singleton
          ),
      stacksize: isCharacter
        ? 1
        : (
            shipMetadata.stacksize === undefined || shipMetadata.stacksize === null
              ? 1
              : shipMetadata.stacksize
          ),
      customInfo: isCharacter ? "" : (shipMetadata.customInfo || ""),
      description: "item",
      attributes: isCharacter
        ? this._buildCharacterItemAttributeDict(
            charData,
            this._getCharID(session),
            session,
          )
        : this._buildShipAttributeDict(charData, shipMetadata, session),
      session,
    });
  },

  Handle_QueryAllAttributesForItem(args, session) {
    const requestedItemID = args && args.length > 0 ? args[0] : this._getShipID(session);
    log.debug(`[DogmaIM] QueryAllAttributesForItem(itemID=${requestedItemID})`);
    const context = this._resolveItemAttributeContext(requestedItemID, session);
    return this._buildAttributeValueDict(context.attributes);
  },

  Handle_QueryAttributeValue(args, session) {
    const requestedItemID = args && args.length > 0 ? args[0] : this._getShipID(session);
    const attributeID = args && args.length > 1 ? Number(args[1]) : null;
    log.debug(
      `[DogmaIM] QueryAttributeValue(itemID=${requestedItemID}, attributeID=${attributeID})`,
    );
    if (!Number.isInteger(attributeID)) {
      return null;
    }
    const context = this._resolveItemAttributeContext(requestedItemID, session);
    return Object.prototype.hasOwnProperty.call(context.attributes, attributeID)
      ? context.attributes[attributeID]
      : null;
  },

  Handle_FullyDescribeAttribute(args, session) {
    const requestedItemID = args && args.length > 0 ? args[0] : this._getShipID(session);
    const attributeID = args && args.length > 1 ? Number(args[1]) : null;
    const reason = args && args.length > 2 ? args[2] : "";
    log.debug(
      `[DogmaIM] FullyDescribeAttribute(itemID=${requestedItemID}, attributeID=${attributeID})`,
    );
    const context = this._resolveItemAttributeContext(requestedItemID, session);
    const serverValue = Number.isInteger(attributeID)
      ? context.attributes[attributeID]
      : undefined;
    const baseValue = Number.isInteger(attributeID)
      ? context.baseAttributes[attributeID]
      : undefined;
    return {
      type: "list",
      items: [
        `Item ID:${this._formatDebugValue(context.itemID)}`,
        `Reason:${this._formatDebugValue(reason, "")}`,
        `Server value:${this._formatDebugValue(serverValue)}`,
        `Base value:${this._formatDebugValue(baseValue)}`,
        "Attribute modification graph:",
        "  No server-side modifier graph is implemented in EveJS Elysian yet.",
      ],
    };
  },
};
