"use strict";

// Module repair in the dogma service: repairing damaged fitted modules with nanite repair
// paste, one module or several at once (InitiateModuleRepair, InitiateModuleRepairMany), and
// finishing or stopping the repair (StopModuleRepair). The paste is taken from the ship when a
// repair starts, and the repairs in progress are kept on the session. These are DogmaService
// methods, moved here as they were; dogmaService.js puts them back on the class prototype, so
// `this` is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(
  __dirname,
  "../../../common/machoErrors",
));
const {
  syncDamageStateAttributesForSession,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  ITEM_FLAGS,
  findItemById,
  listContainerItems,
  updateInventoryItem,
  consumeInventoryItemQuantity,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const {
  extractList,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));
const {
  getTypeMaterials,
} = require(path.join(__dirname, "../../reprocessing/reprocessingStaticData"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../inventory/itemTypeRegistry"));
const {
  clampRatio,
} = require(path.join(__dirname, "./shared"));

const CATEGORY_MODULE = 7;

const CATEGORY_STRUCTURE_MODULE = 66;

const TYPE_NANITE_REPAIR_PASTE = 28668;

/** evetypes.GetBasePrice and GetPortionSize, 0 where the type has none. */
function typeBasePrice(typeID) {
  const type = resolveItemByTypeID(typeID);
  return Number(type && type.basePrice) || 0;
}
function typePortionSize(typeID) {
  const type = resolveItemByTypeID(typeID);
  return Number(type && type.portionSize) || 0;
}

/**
 * inventoryUtil.GetComputedBasePrice (9 to 33): a type's worth by its materials, each material's base price over its
 * portion size cut to a whole number, times the quantity of it, times the quantity asked over the material's portion
 * size (the client's loop reads each material's portion size into the name the type's was in); a type with no
 * materials its own base price, times the quantity over its portion size. Cut to a whole number.
 */
function getComputedBasePrice(typeID, quantity = null) {
  let portionSize = typePortionSize(typeID);
  if (portionSize === 0) {
    portionSize = 1;
  }
  const asked = quantity === null || quantity === undefined ? portionSize : quantity;
  const materials = getTypeMaterials(typeID);
  let price = 0;
  if (materials.length > 0) {
    for (const material of materials) {
      portionSize = typePortionSize(material.materialTypeID);
      if (portionSize === 0) {
        continue;
      }
      const costPerUnit = Math.trunc(typeBasePrice(material.materialTypeID) / portionSize);
      price += material.quantity * costPerUnit * (asked / portionSize);
    }
  } else {
    price = typeBasePrice(typeID) * (asked / portionSize);
  }
  return Math.trunc(price);
}

/**
 * baseDogmaLocation.FindNumUnitsToRepairModule (1948 to 1958), the paste a module's repair takes, which the client's
 * rack shows on its Repair entry (shipmodulebutton.GetMenu 504, activeShipController.GetNumUnitsToRepairModule): the
 * type's computed worth over its hit points is a hit point's, times the damage and the character's
 * shipBrokenModuleRepairCostMultiplier, over the paste's base price, rounded up. A type of no worth takes none.
 */
function findNumUnitsToRepairModule(damageHP, hp, typeID, repairCostMultiplier) {
  const basePrice = getComputedBasePrice(typeID, 1);
  if (basePrice === 0) {
    return 0;
  }
  const costToRepair = damageHP * (basePrice / hp) * repairCostMultiplier;
  return Math.ceil(costToRepair / typeBasePrice(TYPE_NANITE_REPAIR_PASTE));
}

module.exports = {
  _getModuleRepairRuntimeMap(session) {
    if (!session || typeof session !== "object") {
      return null;
    }
    if (!(session._dogmaModuleRepairs instanceof Map)) {
      session._dogmaModuleRepairs = new Map();
    }
    return session._dogmaModuleRepairs;
  },

  _getNaniteRepairPasteQuantity(item) {
    return Math.max(0, Number(item && (item.stacksize ?? item.quantity)) || 0);
  },

  _listNaniteRepairPasteStacks(charID, shipID) {
    return listContainerItems(charID, shipID, ITEM_FLAGS.CARGO_HOLD)
      .filter(
        (item) =>
          Number(item && item.typeID) === TYPE_NANITE_REPAIR_PASTE &&
          this._getNaniteRepairPasteQuantity(item) > 0,
      )
      .sort((left, right) => (Number(left.itemID) || 0) - (Number(right.itemID) || 0));
  },

  _consumeNaniteRepairPaste(session, charID, shipID, requiredUnits) {
    const units = Math.max(0, Math.ceil(Number(requiredUnits) || 0));
    if (units <= 0) {
      return {
        success: true,
        changes: [],
      };
    }
    const stacks = this._listNaniteRepairPasteStacks(charID, shipID);
    const availableUnits = stacks.reduce(
      (total, stack) => total + this._getNaniteRepairPasteQuantity(stack),
      0,
    );
    if (availableUnits < units) {
      return {
        success: false,
        errorMsg: "NOT_ENOUGH_NANITE_REPAIR_PASTE",
      };
    }

    let remainingUnits = units;
    const changes = [];
    for (const stack of stacks) {
      if (remainingUnits <= 0) {
        break;
      }
      const consumeUnits = Math.min(
        remainingUnits,
        this._getNaniteRepairPasteQuantity(stack),
      );
      const consumeResult = consumeInventoryItemQuantity(stack.itemID, consumeUnits, {
        reason: "nanite-module-repair",
      });
      if (!consumeResult || consumeResult.success !== true) {
        return {
          success: false,
          errorMsg: consumeResult && consumeResult.errorMsg
            ? consumeResult.errorMsg
            : "WRITE_ERROR",
        };
      }
      if (consumeResult.data && Array.isArray(consumeResult.data.changes)) {
        changes.push(...consumeResult.data.changes);
      }
      remainingUnits -= consumeUnits;
    }
    this._syncInventoryChanges(session, changes);
    return {
      success: true,
      changes,
    };
  },

  _resolveModuleRepairContext(session, moduleID) {
    const numericModuleID = Number(moduleID) || 0;
    const charID = this._getCharID(session);
    const shipID = this._getShipID(session);
    const moduleItem = findItemById(numericModuleID);
    if (
      !session ||
      !session._space ||
      numericModuleID <= 0 ||
      charID <= 0 ||
      shipID <= 0
    ) {
      return {
        success: false,
        errorMsg: "NOT_IN_SPACE",
        moduleItem,
      };
    }
    if (
      !moduleItem ||
      Number(moduleItem.ownerID) !== charID ||
      Number(moduleItem.locationID) !== shipID
    ) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
        moduleItem,
      };
    }
    const categoryID = Number(moduleItem.categoryID) || 0;
    if (categoryID !== CATEGORY_MODULE && categoryID !== CATEGORY_STRUCTURE_MODULE) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
        moduleItem,
      };
    }
    if (spaceRuntime.getActiveModuleEffect(session, numericModuleID)) {
      return {
        success: false,
        errorMsg: "MODULE_ACTIVE",
        moduleItem,
      };
    }
    const hp = this._getItemStructureHitpoints(moduleItem.typeID);
    const damageRatio = clampRatio(
      moduleItem.moduleState && moduleItem.moduleState.damage,
      0,
    );
    const damageHP = hp * damageRatio;
    if (hp <= 0 || damageHP <= 0) {
      return {
        success: false,
        errorMsg: "NOT_DAMAGED",
        moduleItem,
      };
    }
    const naniteRepairAttributes =
      this._resolveCharacterNaniteRepairAttributes(charID);
    // The paste the client's rack says the repair takes (FindNumUnitsToRepairModule), by the multiplier the
    // character's attributes give it (itemInfo, ATTRIBUTE_SHIP_BROKEN_MODULE_REPAIR_COST_MULTIPLIER).
    const pasteUnits = findNumUnitsToRepairModule(
      damageHP,
      hp,
      moduleItem.typeID,
      naniteRepairAttributes.repairCostMultiplier,
    );
    return {
      success: true,
      data: {
        charID,
        shipID,
        moduleID: numericModuleID,
        moduleItem,
        hp,
        damageRatio,
        damageHP,
        pasteUnits,
        moduleRepairRate: naniteRepairAttributes.moduleRepairRate,
      },
    };
  },

  _startModuleRepair(session, moduleID, options = {}) {
    const context = this._resolveModuleRepairContext(session, moduleID);
    if (!context.success) {
      return context;
    }
    const data = context.data;
    const repairMap = this._getModuleRepairRuntimeMap(session);
    if (repairMap && repairMap.has(data.moduleID)) {
      return {
        success: true,
        data,
      };
    }
    const consumeResult = this._consumeNaniteRepairPaste(
      session,
      data.charID,
      data.shipID,
      data.pasteUnits,
    );
    if (!consumeResult.success) {
      return consumeResult;
    }
    if (repairMap) {
      repairMap.set(data.moduleID, {
        ...data,
        startedAtMs: Date.now(),
        consumedPasteUnits: data.pasteUnits,
        source: options.source || "single",
      });
    }
    return {
      success: true,
      data,
    };
  },

  _finishModuleRepair(session, moduleID) {
    const numericModuleID = Number(moduleID) || 0;
    const repairMap = this._getModuleRepairRuntimeMap(session);
    const repairState =
      repairMap && numericModuleID > 0
        ? repairMap.get(numericModuleID) || null
        : null;
    if (!repairState) {
      return {
        success: false,
        errorMsg: "MODULE_NOT_REPAIRING",
      };
    }
    const moduleItem = findItemById(numericModuleID);
    if (!moduleItem) {
      repairMap.delete(numericModuleID);
      return {
        success: false,
        errorMsg: "MODULE_NOT_FOUND",
      };
    }
    const hp = this._getItemStructureHitpoints(moduleItem.typeID);
    const currentDamageRatio = clampRatio(
      moduleItem.moduleState && moduleItem.moduleState.damage,
      0,
    );
    const currentDamageHP = hp * currentDamageRatio;
    const elapsedMs = Math.max(0, Date.now() - (Number(repairState.startedAtMs) || Date.now()));
    const repairHP = Math.min(
      currentDamageHP,
      (elapsedMs / 60000) * Math.max(0, Number(repairState.moduleRepairRate) || 0),
    );
    const nextDamageHP = Math.max(0, currentDamageHP - repairHP);
    const nextDamageRatio = hp > 0 ? clampRatio(nextDamageHP / hp, 0) : 0;
    const updateResult = updateInventoryItem(numericModuleID, (currentItem) => ({
      ...currentItem,
      moduleState: {
        ...(currentItem.moduleState || {}),
        damage: nextDamageRatio,
        incapacitated:
          nextDamageRatio >= 1
            ? true
            : (currentItem.moduleState && currentItem.moduleState.incapacitated) === true &&
              nextDamageRatio > 0,
      },
    }));
    repairMap.delete(numericModuleID);
    if (!updateResult.success) {
      return updateResult;
    }
    syncDamageStateAttributesForSession(
      session,
      updateResult.data,
      updateResult.previousData || {},
    );
    return updateResult;
  },

  Handle_InitiateModuleRepair(args, session) {
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const result = this._startModuleRepair(session, itemID, {
      source: "single",
    });
    if (result.success) {
      log.debug(
        `[DogmaIM] InitiateModuleRepair accepted itemID=${itemID} ` +
        `pasteUnits=${result.data && result.data.pasteUnits || 0}`,
      );
      return true;
    }
    log.debug(
      `[DogmaIM] InitiateModuleRepair rejected itemID=${itemID} error=${result.errorMsg}`,
    );
    if (result.errorMsg === "NOT_ENOUGH_NANITE_REPAIR_PASTE") {
      throwWrappedUserError("NotEnoughRepairMaterialToFinishAllRepairs");
    }
    return false;
  },

  Handle_InitiateModuleRepairMany(args, session) {
    const moduleIDs = extractList(args && args.length > 0 ? args[0] : [])
      .map((itemID) => Number(itemID) || 0)
      .filter((itemID) => itemID > 0);
    const success = [];
    const missingCharges = [];
    const failed = [];
    for (const itemID of moduleIDs) {
      const result = this._startModuleRepair(session, itemID, {
        source: "many",
      });
      if (result.success) {
        success.push(itemID);
      } else if (result.errorMsg === "NOT_ENOUGH_NANITE_REPAIR_PASTE") {
        missingCharges.push(itemID);
      } else {
        failed.push(itemID);
      }
    }
    log.debug(
      `[DogmaIM] InitiateModuleRepairMany success=${success.length} ` +
      `missingCharges=${missingCharges.length} failed=${failed.length}`,
    );
    return [success, missingCharges, failed];
  },

  Handle_StopModuleRepair(args, session) {
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const result = this._finishModuleRepair(session, itemID);
    if (!result.success) {
      log.debug(
        `[DogmaIM] StopModuleRepair rejected itemID=${itemID} error=${result.errorMsg}`,
      );
      return false;
    }
    log.debug(`[DogmaIM] StopModuleRepair accepted itemID=${itemID}`);
    return true;
  },
};
