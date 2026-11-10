"use strict";

// Packaging in the inventory broker (invbroker): assembling a packaged cargo container
// (AssembleCargoContainer, with its ship cargo capacity check) and breaking a plastic wrap
// (BreakPlasticWrap, which refuses courier packages). These are InvBrokerService methods, moved
// here as they were; invBrokerService.js puts them back on the class prototype, so `this` is the
// service.

const path = require("path");

const {
  ITEM_FLAGS,
  assembleInventoryItem,
  findItemById,
  findShipItemById,
  getInventoryItemUnitVolume,
} = require(path.join(__dirname, "../itemStore"));
const {
  evaluateCumulativeCapacity,
} = require(path.join(__dirname, "../cargoLootAuthority"));
const {
  unwrapMarshalValue,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  isDockedSession,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  throwWrappedUserError,
} = require(path.join(
  __dirname,
  "../../../common/machoErrors",
));
const {
  isCargoContainerType,
} = require(path.join(__dirname, "../../ship/cargoContainerRuntime"));
const {
  buildCrpAccessDeniedInsufficientRolesValues,
} = require(path.join(__dirname, "../../structure/structureServiceAuthority"));

// inventorycommon/const.py: typePlasticWrap = 3468. Matches the type
// contractRuntimeState mints courier packages as.
const PLASTIC_WRAP_TYPE_ID = 3468;

module.exports = {
  _preflightCargoContainerAssemblyCapacity(session, shipID, item) {
    const numericShipID = this._normalizeInventoryId(shipID, 0);
    if (numericShipID <= 0 || !item) {
      return { success: true, requiredVolume: 0 };
    }

    const packagedUnitVolume = Math.max(
      0,
      getInventoryItemUnitVolume(item),
    );
    const assembledUnitVolume = Math.max(
      0,
      getInventoryItemUnitVolume({
        ...item,
        singleton: 1,
        quantity: -1,
        stacksize: 1,
      }),
    );
    const requiredVolume = Math.max(
      0,
      assembledUnitVolume - packagedUnitVolume,
    );
    if (requiredVolume <= 1e-7) {
      return {
        success: true,
        requiredVolume,
        packagedUnitVolume,
        assembledUnitVolume,
      };
    }

    const capacityInfo = this._calculateCapacity(
      session,
      {
        inventoryID: numericShipID,
        locationID: numericShipID,
        flagID: ITEM_FLAGS.CARGO_HOLD,
        kind: "shipInventory",
        ownerID: this._getCharacterId(session),
      },
      ITEM_FLAGS.CARGO_HOLD,
    );
    const capacityEntries =
      capacityInfo &&
      capacityInfo.args &&
      capacityInfo.args.type === "dict" &&
      Array.isArray(capacityInfo.args.entries)
        ? capacityInfo.args.entries
        : [];
    const capacity =
      Number(
        (capacityEntries.find(([key]) => key === "capacity") || [])[1],
      ) || 0;
    const used =
      Number((capacityEntries.find(([key]) => key === "used") || [])[1]) || 0;
    const capacityCheck = evaluateCumulativeCapacity({
      capacity,
      used,
      requiredVolume,
    });

    return {
      ...capacityCheck,
      errorMsg: capacityCheck.success ? null : "NotEnoughCargoSpace",
      packagedUnitVolume,
      assembledUnitVolume,
    };
  },

  Handle_AssembleCargoContainer(args, session, kwargs) {
    this._traceInventory("AssembleCargoContainer", session, { args, kwargs });
    const itemID = this._normalizeInventoryId(
      unwrapMarshalValue(
        this._extractKwarg(kwargs, "itemID") ??
          (args && args.length > 0 ? args[0] : 0),
      ),
      0,
    );
    const item = findItemById(itemID);
    const characterID = this._getCharacterId(session);
    const dockedLocationID = this._getStationId(session);

    log.debug(
      `[InvBroker] AssembleCargoContainer item=${itemID} ` +
      `char=${characterID} dockedLocation=${dockedLocationID}`,
    );

    if (
      !item ||
      itemID <= 0 ||
      characterID <= 0 ||
      dockedLocationID <= 0 ||
      !isDockedSession(session)
    ) {
      return null;
    }
    const ownerID = this._normalizeInventoryId(item.ownerID, 0);
    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    const ownedByCharacter = ownerID === characterID;
    const ownedByCorporation = corporationID > 0 && ownerID === corporationID;
    if (!ownedByCharacter && !ownedByCorporation) {
      throwWrappedUserError("ItemNotYours");
    }
    if (!isCargoContainerType(item)) {
      return null;
    }
    if (this._normalizeInventoryId(item.singleton, 0) !== 0) {
      return null;
    }

    const itemLocationID = this._normalizeInventoryId(item.locationID, 0);
    const itemFlagID = this._normalizeInventoryId(item.flagID, 0);
    const inPersonalHangar =
      ownedByCharacter &&
      itemLocationID === dockedLocationID &&
      itemFlagID === ITEM_FLAGS.HANGAR;
    const containingShip =
      itemFlagID === ITEM_FLAGS.CARGO_HOLD
        ? findShipItemById(itemLocationID)
        : null;
    const inDockedOwnedShipCargo = Boolean(
      ownedByCharacter &&
      containingShip &&
      this._normalizeInventoryId(containingShip.ownerID, 0) === characterID &&
      this._normalizeInventoryId(containingShip.locationID, 0) ===
        dockedLocationID &&
      this._normalizeInventoryId(containingShip.flagID, 0) === ITEM_FLAGS.HANGAR,
    );

    const corporationHangarContext = ownedByCorporation
      ? this._getDirectLocalCorporationHangarItemContext(session, item)
      : null;
    if (ownedByCorporation) {
      if (!corporationHangarContext) {
        return null;
      }
      if (!corporationHangarContext.takeAllowed) {
        throwWrappedUserError(
          "CrpAccessDenied",
          buildCrpAccessDeniedInsufficientRolesValues(),
        );
      }
    }
    const inLocalCorporationHangar = Boolean(corporationHangarContext);
    if (
      !inPersonalHangar &&
      !inDockedOwnedShipCargo &&
      !inLocalCorporationHangar
    ) {
      return null;
    }

    if (inDockedOwnedShipCargo) {
      const capacityCheck = this._preflightCargoContainerAssemblyCapacity(
        session,
        itemLocationID,
        item,
      );
      if (!capacityCheck.success) {
        throwWrappedUserError(
          "NotEnoughCargoSpace",
          this._buildCapacityMoveUserErrorValues(capacityCheck, item),
        );
      }
    }

    const requestedName = String(
      unwrapMarshalValue(
        this._extractKwarg(kwargs, "name") ??
          (args && args.length > 1 ? args[1] : ""),
      ) ?? "",
    )
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 100);
    const assemblyResult = assembleInventoryItem(itemID, {
      itemName: requestedName,
      resetInstanceState: true,
    });
    if (!assemblyResult.success || !assemblyResult.data) {
      log.warn(
        `[InvBroker] AssembleCargoContainer failed item=${itemID}: ` +
        `${assemblyResult.errorMsg || "WRITE_ERROR"}`,
      );
      return null;
    }

    this._emitInventoryMoveChanges(
      session,
      assemblyResult.data.changes,
    );
    this._emitSetLabelCfgDataChanged(
      session,
      assemblyResult.data.assembledItem.itemID,
      assemblyResult.data.assembledItem.itemName,
    );
    log.info(
      `[InvBroker] AssembleCargoContainer assembled ` +
      `item=${assemblyResult.data.assembledItem.itemID} source=${itemID} ` +
      `split=${assemblyResult.data.split === true} ` +
      `location=${itemLocationID} flag=${itemFlagID}`,
    );
    return null;
  },

  // Retail's "Break Contract" menu entry (menusvc.py OfferBreakContract ->
  // invItemFunctions.Break) calls this as a ZERO-ARG method on the wrap's own
  // bound inventory — GetInventoryFromId(itemID).BreakPlasticWrap() — so the
  // target is the bound context, not an argument, and the client discards the
  // return value entirely. It is offered for any singleton typeID-3468 item
  // sitting directly in the docked personal hangar, with no ownership check of
  // its own: the server is the only thing gating who may break what.
  //
  // EveJS does not model the package as a container. A courier wrap is a marker
  // item (contractRuntimeState.createPlasticWrap) that rides in the acceptor's
  // hangar while the contents stay in the contract escrow location
  // (packageLocationID === escrowLocationID), so there is nothing inside the
  // wrap to spill out. Both courier terminal legs already deliver those contents
  // and delete the wrap — complete-courier hands them to the issuer,
  // fail-courier hands them to the acceptor at the wrap's own location — so no
  // flow strands a wrap with unreachable contents and there is no unwrap for
  // this handler to perform. Deleting the wrap on its own would be actively
  // harmful: complete-courier refuses without an intact wrap. Refuse with a
  // reason instead of answering a successful empty response.
  Handle_BreakPlasticWrap(args, session, kwargs) {
    this._traceInventory("BreakPlasticWrap", session, { args, kwargs });
    const boundContext = this._getBoundContext(session);
    const rawArgs = Array.isArray(args) ? args : [];
    const wrapItemID = this._normalizeInventoryId(
      this._extractKwarg(kwargs, "itemID") ??
        (rawArgs.length > 0 ? rawArgs[0] : null) ??
        (boundContext && boundContext.inventoryID),
      0,
    );
    const wrapItem = wrapItemID > 0 ? findItemById(wrapItemID) : null;

    log.debug(
      `[InvBroker] BreakPlasticWrap itemID=${wrapItemID} bound=${JSON.stringify(boundContext)}`,
    );

    if (!wrapItem || this._normalizeInventoryId(wrapItem.typeID, 0) !== PLASTIC_WRAP_TYPE_ID) {
      log.debug(
        `[InvBroker] BreakPlasticWrap rejected itemID=${wrapItemID} error=NOT_A_PLASTIC_WRAP`,
      );
      throwWrappedUserError("CustomNotify", {
        notify: "That item is not a courier package.",
      });
    }
    if (
      this._normalizeInventoryId(wrapItem.ownerID, 0) !==
      this._normalizeInventoryId(this._getCharacterId(session), 0)
    ) {
      log.debug(
        `[InvBroker] BreakPlasticWrap rejected itemID=${wrapItemID} owner=${wrapItem.ownerID} error=ITEM_NOT_YOURS`,
      );
      throwWrappedUserError("ItemNotYours");
    }

    log.info(
      `[InvBroker] BreakPlasticWrap refused itemID=${wrapItemID} location=${wrapItem.locationID}:${wrapItem.flagID} error=COURIER_PACKAGE_NOT_BREAKABLE`,
    );
    throwWrappedUserError("CustomNotify", {
      notify:
        "A courier package can only be opened through its contract. Deliver it at " +
        "the destination station, or fail the contract to have the contents " +
        "returned to you where the package is.",
    });
    return null;
  },
};
