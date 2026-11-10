"use strict";

// Planetary import and export in the inventory broker (invbroker): moving commodities between a
// customs office and a planet's launchpad (ImportExportWithPlanet), with the customs tax charged
// to the character's wallet. These are InvBrokerService methods, moved here as they were;
// invBrokerService.js puts them back on the class prototype, so `this` is the service.

const path = require("path");

const {
  unwrapMarshalValue,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  ITEM_FLAGS,
  findItemById,
} = require(path.join(__dirname, "../itemStore"));
const {
  throwWrappedUserError,
} = require(path.join(
  __dirname,
  "../../../common/machoErrors",
));
const planetStaticData = require(path.join(
  __dirname,
  "../../planet/planetStaticData",
));
const {
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../../account/walletState"));
const planetRuntimeStore = require(path.join(
  __dirname,
  "../../planet/planetRuntimeStore",
));
const planetOrbitalState = require(path.join(
  __dirname,
  "../../planet/planetOrbitalState",
));
const planetCostCalculator = require(path.join(
  __dirname,
  "../../planet/planetCostCalculator",
));
const planetaryCustomsSettlementState = require(path.join(
  __dirname,
  "../../planet/planetaryCustomsSettlementState",
));

const USER_ERROR_FORMAT_OWNER_ID = 2; // eveexceptions.const.UE_OWNERID

module.exports = {
  _normalizeCommodityDict(value) {
    const rawValue = unwrapMarshalValue(value);
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      return {};
    }

    const commodities = {};
    for (const [rawKey, rawQuantity] of Object.entries(rawValue)) {
      const key = this._normalizeInventoryId(rawKey, 0);
      const quantity = this._normalizeQuantityArg(rawQuantity);
      if (key > 0 && quantity > 0) {
        commodities[String(key)] = (commodities[String(key)] || 0) + quantity;
      }
    }
    return commodities;
  },

  _buildPIImportCommoditiesFromItems(importData, customsOfficeID, characterID) {
    const importItemQuantities = this._normalizeCommodityDict(importData);
    const commodities = {};
    const items = [];
    for (const [rawItemID, quantity] of Object.entries(importItemQuantities)) {
      const itemID = this._normalizeInventoryId(rawItemID, 0);
      const item = findItemById(itemID);
      if (
        !item ||
        this._normalizeInventoryId(item.ownerID, 0) !== characterID ||
        this._normalizeInventoryId(item.locationID, 0) !== customsOfficeID ||
        this._normalizeInventoryId(item.flagID, 0) !== ITEM_FLAGS.HANGAR
      ) {
        throwWrappedUserError("CannotImportCommoditiesNotFound");
      }

      const availableQuantity = this._normalizeInventoryId(
        item.singleton === 1 ? 1 : item.stacksize ?? item.quantity,
        0,
      );
      if (availableQuantity < quantity) {
        throwWrappedUserError("CannotImportCommoditiesNotFound");
      }

      const typeID = this._normalizeInventoryId(item.typeID, 0);
      if (!planetStaticData.canPutTypeInCustomsOffice(typeID)) {
        throwWrappedUserError("CannotImportCommoditiesNotFound");
      }
      commodities[String(typeID)] = (commodities[String(typeID)] || 0) + quantity;
      items.push({ itemID, typeID, quantity });
    }
    return { commodities, items };
  },

  _throwNotEnoughMoney(requiredAmount, currentBalance) {
    throwWrappedUserError(
      "NotEnoughMoney",
      buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance),
    );
  },

  _ensurePIWalletCanCover(characterID, amount) {
    const normalizedAmount = Number(amount) || 0;
    if (!(normalizedAmount > 0)) {
      return;
    }

    const wallet = getCharacterWallet(characterID);
    if (!wallet) {
      throwWrappedUserError("CustomNotify", {
        notify: "Cannot charge PI wallet: character wallet not found.",
      });
    }
    if (wallet.balance < normalizedAmount) {
      this._throwNotEnoughMoney(normalizedAmount, wallet.balance);
    }
  },

  async Handle_ImportExportWithPlanet(args, session) {
    const boundContext = this._getBoundContext(session);
    const customsOfficeID = this._normalizeInventoryId(
      boundContext && (boundContext.inventoryID ?? boundContext.locationID),
      0,
    );
    const characterID = this._getCharacterId(session);
    const spaceportPinID = this._normalizeInventoryId(
      unwrapMarshalValue(args && args.length > 0 ? args[0] : 0),
      0,
    );
    const importData = args && args.length > 1 ? args[1] : {};
    const exportData = args && args.length > 2 ? args[2] : {};
    const clientTaxRate = Number(unwrapMarshalValue(args && args.length > 3 ? args[3] : null));

    this._traceInventory("ImportExportWithPlanet", session, {
      customsOfficeID,
      spaceportPinID,
      clientTaxRate,
    });

    if (customsOfficeID <= 0 || spaceportPinID <= 0) {
      throwWrappedUserError("CannotImportEndpointNotFound");
    }

    const customsOffice = this._getPlanetaryCustomsOfficeRecord(customsOfficeID);
    if (!customsOffice) throwWrappedUserError("CannotImportEndpointNotFound");
    const presenceError = this._getCustomsOfficePresenceAccessError(session, customsOffice);
    if (presenceError) this._throwSpaceContainerScopeAccessError(presenceError);

    const colony = planetRuntimeStore.getColonyByPin(characterID, spaceportPinID);
    if (!colony) {
      throwWrappedUserError("CannotImportEndpointNotFound");
    }

    if (
      !customsOffice ||
      this._normalizeInventoryId(customsOffice.planetID, 0) !==
        this._normalizeInventoryId(colony.planetID, 0)
    ) {
      throwWrappedUserError("CannotImportEndpointNotFound");
    }

    const currentTaxRate = planetOrbitalState.getTaxRate(customsOfficeID, session);
    if (currentTaxRate === null) {
      throwWrappedUserError("PortStandingCheckFail", {
        corpName: [
          USER_ERROR_FORMAT_OWNER_ID,
          this._normalizeInventoryId(customsOffice.ownerID, 0),
        ],
      });
    }
    if (
      !Number.isFinite(clientTaxRate) ||
      Math.abs(clientTaxRate - currentTaxRate) > 0.000001
    ) {
      throwWrappedUserError("TaxChanged");
    }

    const importInfo = this._buildPIImportCommoditiesFromItems(
      importData,
      customsOfficeID,
      characterID,
    );
    const exportCommodities = this._normalizeCommodityDict(exportData);
    if (
      Object.keys(exportCommodities).some(
        (typeID) => !planetStaticData.canPutTypeInCustomsOffice(typeID),
      )
    ) {
      throwWrappedUserError("CannotExportCommodities");
    }
    const preview = planetRuntimeStore.previewSpaceportImportExport({
      planetID: colony.planetID,
      ownerID: characterID,
      spaceportPinID,
      importCommodities: importInfo.commodities,
      exportCommodities,
    });
    if (!preview.success) {
      throwWrappedUserError(preview.errorMsg || "CannotImportEndpointNotFound");
    }

    const importTax = planetCostCalculator.calculateImportTax(
      preview.spaceportPin && preview.spaceportPin.typeID,
      preview.importCommodities,
      currentTaxRate,
    );
    const exportTax = planetCostCalculator.calculateExportTax(
      preview.spaceportPin && preview.spaceportPin.typeID,
      preview.exportCommodities,
      currentTaxRate,
    );
    this._ensurePIWalletCanCover(characterID, importTax + exportTax);

    const prepared = planetaryCustomsSettlementState.preparePlanetaryCustomsSettlement({
      characterID,
      planetID: colony.planetID,
      spaceportPinID,
      customsOfficeID,
      customsOfficeOwnerID: this._normalizeInventoryId(customsOffice.ownerID, 0),
      importInputs: importInfo.items.map((entry) => ({
        ...entry,
        ownerID: characterID,
        locationID: customsOfficeID,
        flagID: ITEM_FLAGS.HANGAR,
      })),
      importCommodities: preview.importCommodities,
      exportCommodities: preview.exportCommodities,
      importTax,
      exportTax,
      taxRate: currentTaxRate,
    });
    if (!prepared || prepared.success !== true) {
      throwWrappedUserError("CustomNotify", {
        notify: `Cannot start planetary customs transfer: ${
          prepared && prepared.errorMsg || "settlement persistence failed"
        }.`,
      });
    }

    const settlement = await planetaryCustomsSettlementState
      .settlePlanetaryCustomsSettlement(characterID, {
        preferredSession: session,
      });
    const errorMsg = settlement && settlement.errorMsg;
    if (settlement && settlement.success === true && settlement.rejected !== true) {
      return null;
    }
    if (errorMsg === "INSUFFICIENT_FUNDS") {
      const wallet = getCharacterWallet(characterID);
      this._throwNotEnoughMoney(
        importTax + exportTax,
        wallet ? wallet.balance : 0,
      );
    }
    if (errorMsg === "CannotImportCommoditiesNotFound") {
      throwWrappedUserError(errorMsg);
    }
    if (errorMsg === "CannotExportCommodities") {
      throwWrappedUserError(errorMsg);
    }
    throwWrappedUserError("CustomNotify", {
      notify: `Cannot complete planetary customs transfer: ${
        errorMsg || "settlement failed"
      }.`,
    });
  },
};
