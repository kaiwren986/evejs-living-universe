"use strict";

// Whole-ship fitting operations of the inventory broker (invbroker): applying a saved fitting
// from inventory (FitFitting), moving a ship's whole fitting to the hangar (StripFitting) and
// destroying a fitting's items (DestroyFitting). These are InvBrokerService methods, moved
// here as they were; invBrokerService.js puts them back on the class prototype, so `this` is
// the service and they call the broker's other methods as before. Moving a single module in
// or out of a slot is the broker's ordinary item move and stays in invBrokerService.js.

const path = require("path");

const {
  buildList,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  isShipFittingFlag,
  listFittedItems,
  resolveFitOnlineState,
  SLOT_FAMILY_FLAGS,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  ITEM_FLAGS,
  listContainerItems,
  findItemById,
  findShipItemById,
  removeInventoryItem,
  updateInventoryItem,
} = require(path.join(__dirname, "../itemStore"));
const {
  isStructureServiceSlotFlag,
} = require(path.join(__dirname, "../../structure/structureServiceModules"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  findCharacterShip,
  emitStripFittingDogmaMultiEventForSession,
  emitItemsChangedBatchForSession,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const runtime = require(path.join(__dirname, "../../../space/runtime"));
const worldData = require(path.join(__dirname, "../../../space/worldData"));
const {
  getShipFittingSnapshot,
} = require(path.join(__dirname, "../../../_secondary/fitting/fittingRuntime"));
const {
  throwWrappedUserError,
} = require(path.join(
  __dirname,
  "../../../common/machoErrors",
));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../itemTypeRegistry"));
const {
  ICE_PRODUCT_GROUP_ID,
} = require(path.join(__dirname, "../fuelBayInventory"));
const { createFitRefusalLog } = require("./fitRefusalNotice");

const CHARGE_CATEGORY_ID = 8;
const IMPLANT_CATEGORY_ID = 20;
// Fit refusals that count modules across the whole ship, so a module swapped
// out of another slot can clear them.
const FIT_FITTING_SHIP_WIDE_LIMIT_ERRORS = new Set([
  "MAX_TYPE_FITTED",
  "MAX_GROUP_FITTED",
  "NO_TURRET_HARDPOINTS",
  "NO_LAUNCHER_HARDPOINTS",
]);

module.exports = {
  _extractFitFittingEntryPairs(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    if (value instanceof Map) {
      return [...value.entries()];
    }

    if (value.type === "dict" && Array.isArray(value.entries)) {
      return value.entries;
    }

    if (
      (value.type === "objectex1" || value.type === "objectex2") &&
      Array.isArray(value.dict)
    ) {
      return value.dict;
    }

    if (
      value.type === "object" &&
      value.args &&
      value.args.type === "dict" &&
      Array.isArray(value.args.entries)
    ) {
      return value.args.entries;
    }

    return null;
  },

  _appendFitFittingItemsByType(byType, rawTypeID, rawItemIDs) {
    const typeID = this._normalizeInventoryId(unwrapMarshalValue(rawTypeID), 0);
    if (typeID <= 0) {
      return;
    }

    const unwrappedItemIDs = unwrapMarshalValue(rawItemIDs);
    const itemIDs = (Array.isArray(unwrappedItemIDs) ? unwrappedItemIDs : [unwrappedItemIDs])
      .map((entry) => this._normalizeInventoryId(unwrapMarshalValue(entry), 0))
      .filter((entry) => entry > 0);
    if (itemIDs.length <= 0) {
      return;
    }

    const existingItemIDs = byType.get(typeID) || [];
    for (const itemID of itemIDs) {
      if (!existingItemIDs.includes(itemID)) {
        existingItemIDs.push(itemID);
      }
    }
    byType.set(typeID, existingItemIDs);
  },

  _normalizeFitFittingItemsByType(value) {
    const byType = new Map();
    const rawEntryPairs = this._extractFitFittingEntryPairs(value);
    if (Array.isArray(rawEntryPairs)) {
      for (const [rawTypeID, rawItemIDs] of rawEntryPairs) {
        this._appendFitFittingItemsByType(byType, rawTypeID, rawItemIDs);
      }

      return byType;
    }

    const unwrapped = unwrapMarshalValue(value);
    const unwrappedEntryPairs =
      unwrapped && typeof unwrapped === "object" && Array.isArray(unwrapped.dict)
        ? unwrapped.dict
        : null;
    if (Array.isArray(unwrappedEntryPairs)) {
      for (const [rawTypeID, rawItemIDs] of unwrappedEntryPairs) {
        this._appendFitFittingItemsByType(byType, rawTypeID, rawItemIDs);
      }

      return byType;
    }

    const source =
      unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
        ? unwrapped
        : {};

    for (const [rawTypeID, rawItemIDs] of Object.entries(source)) {
      this._appendFitFittingItemsByType(byType, rawTypeID, rawItemIDs);
    }

    return byType;
  },

  _normalizeFitFittingModulesByFlag(value) {
    const unwrapped = unwrapMarshalValue(value);
    const payload =
      unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
        ? unwrapped
        : {};
    const source =
      payload.modulesByFlag &&
      typeof payload.modulesByFlag === "object" &&
      !Array.isArray(payload.modulesByFlag)
        ? payload.modulesByFlag
        : payload;

    return Object.entries(source)
      .map(([rawFlagID, rawTypeID]) => ({
        flagID: this._normalizeInventoryId(rawFlagID, 0),
        typeID: this._normalizeInventoryId(rawTypeID, 0),
      }))
      .filter((entry) => entry.flagID > 0 && entry.typeID > 0)
      .sort((left, right) => {
        const leftRank = this._rankFitFittingSlotApplyOrder(left.flagID);
        const rightRank = this._rankFitFittingSlotApplyOrder(right.flagID);
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return left.flagID - right.flagID;
      });
  },

  // Apply order for one fit: subsystems first (they decide how many slots the
  // hull even has), then rigs, then everything else by flagID. Rigs and
  // subsystems are exactly the families moduleParticipatesInOnlineState()
  // excludes - always-on passives that draw no CPU/powergrid of their own but
  // can raise the ship's output (Ancillary Current Router, Processor
  // Overclocking Unit). The per-move online gate judges every module against
  // the fit as it stands at that moment, so a grid-raising rig applied after
  // its consumers leaves them stamped offline over grid the finished fit does
  // supply. Low slots (11-18) already precede med/high under plain flagID
  // order, so the lo-slot contributors (Reactor Control Unit, Co-Processor)
  // reach their consumers in time without needing a tier of their own.
  _rankFitFittingSlotApplyOrder(flagID) {
    if (SLOT_FAMILY_FLAGS.subsystem.includes(flagID)) {
      return 0;
    }
    if (SLOT_FAMILY_FLAGS.rig.includes(flagID)) {
      return 1;
    }
    return 2;
  },

  // What already sits in a slot a saved fit wants: the fitted module, plus any
  // charge loaded into it (charges share the module's flagID).
  _findFitFittingSlotOccupant(fittedItemsSnapshot, flagID) {
    const inSlot = (fittedItemsSnapshot || []).filter(
      (item) => item && Number(item.flagID) === Number(flagID),
    );
    const module = inSlot.find(
      (item) => this._normalizeInventoryId(item.categoryID, 0) !== CHARGE_CATEGORY_ID,
    );
    if (!module) {
      return null;
    }
    return {
      module,
      charges: inSlot.filter((item) => item !== module),
    };
  },

  // The retail client never strips a ship before FitFitting: it sends the fit
  // over whatever is fitted and expects the server to swap it in. Only high,
  // mid and low slots are swapped, and only while docked, into the hangar the
  // ship sits in. Rigs are never moved -- unfitting one destroys it, and the
  // client has already decided about rigs (FitRigs / ShipHasRigsAlready)
  // before it calls. Subsystems change the slot layout and are not swapped.
  _canDisplaceFitFittingSlot(session, shipRecord, flagID) {
    const numericFlagID = Number(flagID);
    if (
      !SLOT_FAMILY_FLAGS.high.includes(numericFlagID) &&
      !SLOT_FAMILY_FLAGS.med.includes(numericFlagID) &&
      !SLOT_FAMILY_FLAGS.low.includes(numericFlagID)
    ) {
      return false;
    }
    const dockedLocationID = getDockedLocationID(session) || 0;
    return (
      isDockedSession(session) &&
      dockedLocationID > 0 &&
      this._normalizeInventoryId(shipRecord && shipRecord.locationID, 0) === dockedLocationID
    );
  },

  // Moves a slot's occupant (module first, then its charges) to the hangar
  // the ship is docked in. Returns the row changes and snapshot entries of
  // whatever did move; when moduleMoved is false the slot is still occupied and
  // the caller must not fit.
  _displaceFitFittingSlotOccupant(session, shipRecord, occupant) {
    const destination = {
      locationID: shipRecord.locationID,
      flagID: ITEM_FLAGS.HANGAR,
    };
    const changes = [];
    const movedItems = [];
    for (const item of [...occupant.charges, occupant.module]) {
      const sourceItemDescriptor = this._findTransferSourceItem(
        item.itemID,
        shipRecord.itemID,
      );
      const moveResult = sourceItemDescriptor
        ? this._moveSourceItemToDestination(session, sourceItemDescriptor, destination)
        : { success: false, errorMsg: "ITEM_NOT_FOUND" };
      if (!moveResult.success) {
        log.warn(
          `[InvBroker] FitFitting could not move itemID=${item.itemID} typeID=${item.typeID} ` +
            `out of flagID=${item.flagID} error=${moveResult.errorMsg}`,
        );
        if (item === occupant.module) {
          return { changes, movedItems, moduleMoved: false };
        }
        continue;
      }
      movedItems.push(item);
      changes.push(...((moveResult.data && moveResult.data.changes) || []));
    }
    return { changes, movedItems, moduleMoved: true };
  },

  _requeueFitFittingSourceStack(candidateItemIDs, itemID, originalSourceItem) {
    if (!Array.isArray(candidateItemIDs) || !originalSourceItem) {
      return;
    }

    const sourceAfterMove = findItemById(itemID);
    if (
      !sourceAfterMove ||
      Number(sourceAfterMove.singleton) === 1 ||
      this._getStackableQuantity(sourceAfterMove) <= 0 ||
      this._normalizeInventoryId(sourceAfterMove.itemID, 0) !==
        this._normalizeInventoryId(originalSourceItem.itemID, 0) ||
      this._normalizeInventoryId(sourceAfterMove.typeID, 0) !==
        this._normalizeInventoryId(originalSourceItem.typeID, 0) ||
      this._normalizeInventoryId(sourceAfterMove.ownerID, 0) !==
        this._normalizeInventoryId(originalSourceItem.ownerID, 0) ||
      this._normalizeInventoryId(sourceAfterMove.locationID, 0) !==
        this._normalizeInventoryId(originalSourceItem.locationID, 0) ||
      this._normalizeInventoryId(sourceAfterMove.flagID, 0) !==
        this._normalizeInventoryId(originalSourceItem.flagID, 0)
    ) {
      return;
    }

    const normalizedItemID = this._normalizeInventoryId(itemID, 0);
    if (
      !candidateItemIDs.some(
        (candidateID) => this._normalizeInventoryId(candidateID, 0) === normalizedItemID,
      )
    ) {
      candidateItemIDs.unshift(normalizedItemID);
    }
  },

  _normalizeFitFittingQuantitiesByType(value, key) {
    const unwrapped = unwrapMarshalValue(value);
    const payload =
      unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
        ? unwrapped
        : {};
    // A named key (e.g. "dronesByType") selects a nested quantities map. When it
    // is provided but absent, the source is empty — NOT the whole payload, which
    // would misread an unrelated dict (e.g. a bare modulesByFlag {flag: typeID})
    // as quantities. Only the key-less call (cargoItemsByType) uses the payload
    // itself as the quantities map.
    const source = key
      ? (Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : {})
      : payload;
    const entryPairs = this._extractFitFittingEntryPairs(source);
    const pairs = Array.isArray(entryPairs)
      ? entryPairs
      : Object.entries(
        source && typeof source === "object" && !Array.isArray(source)
          ? source
          : {},
      );
    const quantitiesByType = new Map();

    for (const [rawTypeID, rawQuantity] of pairs) {
      const typeID = this._normalizeInventoryId(unwrapMarshalValue(rawTypeID), 0);
      const quantity = Math.max(0, Number(unwrapMarshalValue(rawQuantity)) || 0);
      if (typeID <= 0 || quantity <= 0) {
        continue;
      }
      quantitiesByType.set(typeID, (quantitiesByType.get(typeID) || 0) + Math.trunc(quantity));
    }

    return [...quantitiesByType.entries()]
      .map(([typeID, quantity]) => ({ typeID, quantity }))
      .sort((left, right) => left.typeID - right.typeID);
  },

  _getFitFittingDestinationOwnerID(session, shipRecord, destinationFlagID) {
    const destination = {
      locationID: shipRecord && shipRecord.itemID,
      flagID: destinationFlagID,
    };
    const structureDestination = this._getStructureForOwnerBayDestination(destination);
    const structureOwnerID = this._getStructureInventoryOwnerID(structureDestination);
    return structureOwnerID > 0 ? structureOwnerID : this._getCharacterId(session);
  },

  _getFitFittingExistingDestinationQuantity(session, shipRecord, destinationFlagID, typeID) {
    const ownerID = this._getFitFittingDestinationOwnerID(
      session,
      shipRecord,
      destinationFlagID,
    );
    const normalizedTypeID = this._normalizeInventoryId(typeID, 0);
    if (!shipRecord || ownerID <= 0 || normalizedTypeID <= 0) {
      return 0;
    }

    return listContainerItems(ownerID, shipRecord.itemID, destinationFlagID)
      .filter((item) => Number(item && item.typeID) === normalizedTypeID)
      .reduce(
        (sum, item) =>
          sum + (
            Number(item && item.singleton) === 1
              ? 1
              : Math.max(1, Number(item && (item.stacksize ?? item.quantity ?? 1)) || 1)
          ),
        0,
      );
  },

  // The per-move gate above weighs each module against the fit as it stood when
  // that module landed, which makes it order-sensitive by construction: nothing
  // applied later that raises CPU/powergrid output can retroactively rescue a
  // module already stamped offline. Sorting the passives to the front of a
  // FitFitting apply covers the cases we know of; this pass is what makes the
  // invariant hold whatever order a client sends, so that once FitFitting
  // returns a module is offline only if the FINAL fit cannot power it.
  //
  // Only ever brings modules ON, and only ones this same call fitted - a module
  // the player deliberately took offline earlier must stay offline. Because it
  // reverses a decision made by the very predicate that made it, re-evaluated
  // against an output that only grew, it cannot produce a state the offline
  // gate would reject. Candidates are walked in ascending flagID so a genuinely
  // over-budget fit still leaves the overflow offline (EVE parity) in a stable
  // slot order rather than in whatever order the client listed the slots.
  _reonlineFitFittingModules(session, shipRecord, fittedModuleIDs) {
    const shipID = this._normalizeInventoryId(shipRecord && shipRecord.itemID, 0);
    if (shipID <= 0 || !Array.isArray(fittedModuleIDs) || fittedModuleIDs.length <= 0) {
      return [];
    }

    const candidateIDs = new Set(
      fittedModuleIDs
        .map((itemID) => this._normalizeInventoryId(itemID, 0))
        .filter((itemID) => itemID > 0),
    );
    const charID = this._getCharacterId(session);
    // One live read of the finished fit; the loop keeps it in step itself so
    // each candidate is weighed against the load the previous one just added.
    const fittedItems = listFittedItems(charID, shipID);
    const candidates = fittedItems
      .filter(
        (item) =>
          candidateIDs.has(this._normalizeInventoryId(item && item.itemID, 0)) &&
          // An absent moduleState means implicitly online; only an explicit
          // false is a decision, and only the CPU/powergrid gate above makes
          // one during a fit. Structure service slots are excluded there too -
          // their online state is fuel-gated, not resource-gated.
          !isStructureServiceSlotFlag(this._normalizeInventoryId(item.flagID, 0)) &&
          item.moduleState &&
          item.moduleState.online === false,
      )
      .sort((left, right) => (Number(left.flagID) || 0) - (Number(right.flagID) || 0));

    const changes = [];
    for (const candidate of candidates) {
      const candidateID = this._normalizeInventoryId(candidate.itemID, 0);
      const decision = resolveFitOnlineState(charID, shipRecord, candidate, fittedItems);
      if (!decision.applies || decision.online !== true) {
        continue;
      }

      const updateResult = updateInventoryItem(candidateID, (currentItem) => ({
        ...currentItem,
        moduleState: {
          ...(currentItem.moduleState || {}),
          online: true,
        },
      }));
      if (!updateResult || updateResult.success !== true) {
        log.warn(
          `[InvBroker] fitted module re-online failed ship=${shipID} item=${candidateID} error=${updateResult && updateResult.errorMsg || "UNKNOWN"}`,
        );
        continue;
      }

      const candidateIndex = fittedItems.findIndex(
        (item) => this._normalizeInventoryId(item && item.itemID, 0) === candidateID,
      );
      if (candidateIndex >= 0) {
        fittedItems[candidateIndex] = updateResult.data;
      }

      log.debug(
        `[InvBroker] fitted module brought online ship=${shipID} item=${candidateID}`,
      );
      changes.push({
        previousData: updateResult.previousData || candidate,
        item: updateResult.data,
      });
    }

    return changes;
  },

  _validateDestroyFittingHostAccess(session, boundContext, item) {
    const boundInventoryID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    if (
      boundInventoryID <= 0 ||
      this._normalizeInventoryId(item && item.locationID, 0) !== boundInventoryID
    ) {
      return { success: false, errorMsg: "FITTING_HOST_NOT_BOUND" };
    }

    // Structure rigs are corporation-owned.  Accept them only through the live
    // controlled-structure binding, never through a globally-known structure ID.
    if (
      boundContext &&
      boundContext.kind === "controlledStructureInventory" &&
      this._isControlledStructureInventoryID(session, boundInventoryID)
    ) {
      return this._getStructureFitHostRecord(session, boundInventoryID)
        ? { success: true, accessKind: "controlledStructure" }
        : { success: false, errorMsg: "FITTING_HOST_NOT_FOUND" };
    }

    if (!boundContext || boundContext.kind !== "shipInventory") {
      return { success: false, errorMsg: "FITTING_HOST_NOT_AUTHORIZED" };
    }

    const characterID = this._getCharacterId(session);
    const shipRecord = findCharacterShip(characterID, boundInventoryID);
    if (
      !shipRecord ||
      this._normalizeInventoryId(item && item.ownerID, 0) !== characterID
    ) {
      return { success: false, errorMsg: "FITTING_HOST_NOT_AUTHORIZED" };
    }

    const destroyDestination = {
      locationID: shipRecord.locationID,
      flagID: ITEM_FLAGS.HANGAR,
    };
    if (isDockedSession(session)) {
      const dockedLocationID = this._normalizeInventoryId(getDockedLocationID(session), 0);
      if (
        dockedLocationID <= 0 ||
        this._normalizeInventoryId(shipRecord.locationID, 0) !== dockedLocationID
      ) {
        return { success: false, errorMsg: "FITTING_HOST_NOT_LOCAL" };
      }

      const dockedStructureAccess =
        this._validateDockedStructureFittingServiceAccess(
          session,
          shipRecord,
          item,
          destroyDestination,
        );
      return { ...dockedStructureAccess, accessKind: "dockedShip" };
    }

    const sessionSpace = session && session._space;
    const activeShipID = this._normalizeInventoryId(sessionSpace && sessionSpace.shipID, 0);
    const systemID = this._normalizeInventoryId(sessionSpace && sessionSpace.systemID, 0);
    const shipEntity = runtime.getEntity(session, boundInventoryID);
    if (
      activeShipID !== boundInventoryID ||
      systemID <= 0 ||
      this._normalizeInventoryId(shipRecord.locationID, 0) !== systemID ||
      !shipEntity ||
      this._normalizeInventoryId(shipEntity.systemID, 0) !== systemID
    ) {
      return { success: false, errorMsg: "FITTING_HOST_NOT_LOCAL" };
    }

    const fittingServiceAccess = this._validateInSpaceFittingServiceAccess(
      session,
      shipRecord,
      item,
      destroyDestination,
    );
    return { ...fittingServiceAccess, accessKind: "inSpaceShip" };
  },

  _buildDockedHangarLocationContext(locationID) {
    const numericLocationID = this._normalizeInventoryId(locationID, 0);
    if (numericLocationID <= 0) {
      return null;
    }
    if (this._getStructureForInventoryID(numericLocationID)) {
      return ["Structure", numericLocationID, "StructureItemHangar"];
    }
    if (worldData.getStationByID(numericLocationID)) {
      return ["Station", numericLocationID, "StationHangar"];
    }
    return null;
  },

  _emitStripFittingMoveChanges(session, changes = []) {
    const normalizedChanges = (Array.isArray(changes) ? changes : [])
      .filter((change) => change && change.item);
    for (const change of normalizedChanges) {
      emitItemsChangedBatchForSession(session, [change], {
        idType: "charid",
        locationContext: this._buildDockedHangarLocationContext(
          change.item && change.item.locationID,
        ),
      });
    }
  },

  Handle_StripFitting(args, session) {
    this._traceInventory("StripFitting", session, { args });
    const boundContext = this._getBoundContext(session);
    const shipRecord = this._getShipInventoryRecord(session, boundContext);

    if (!shipRecord) {
      log.warn(`[InvBroker] StripFitting failed: could not resolve ship record from bound context`);
      return null;
    }

    const charID = this._getCharacterId(session);
    const fittedItems = listFittedItems(charID, shipRecord.itemID);
    log.debug(`[InvBroker] StripFitting shipID=${shipRecord.itemID} locationID=${shipRecord.locationID} fittedCount=${fittedItems.length}`);

    if (fittedItems.length === 0) {
      return null;
    }

    const previousFittingSnapshot = getShipFittingSnapshot(charID, shipRecord.itemID, {
      shipItem: shipRecord,
      forceRefresh: true,
      reason: "invbroker.strip-fitting.before",
    });

    const firstNonChargeFittedItem = fittedItems.find((fittedItem) => (
      fittedItem &&
      !SLOT_FAMILY_FLAGS.rig.includes(fittedItem.flagID) &&
      this._normalizeInventoryId(fittedItem.categoryID, 0) !== CHARGE_CATEGORY_ID
    ));
    if (firstNonChargeFittedItem) {
      const fittingServiceAccess = this._validateInSpaceFittingServiceAccess(
        session,
        shipRecord,
        firstNonChargeFittedItem,
        {
          locationID: shipRecord.locationID,
          flagID: ITEM_FLAGS.HANGAR,
        },
      );
      if (!fittingServiceAccess.success) {
        log.debug(
          `[InvBroker] StripFitting rejected before moving items shipID=${shipRecord.itemID} error=${fittingServiceAccess.errorMsg}`,
        );
        this._throwInSpaceFittingAccessError(
          fittingServiceAccess.errorMsg,
          fittingServiceAccess.tooFar,
        );
      }
    }

    // Stripping takes every module's cargo bonus away at once, so the hold is
    // judged against the ship as it will be with all of them gone.
    const stripCargoOverflow = this._getCargoOverflowWithoutFittedItems(
      session,
      shipRecord,
      fittedItems.filter((fittedItem) => (
        fittedItem && !SLOT_FAMILY_FLAGS.rig.includes(fittedItem.flagID)
      )),
      0,
      previousFittingSnapshot,
    );
    if (stripCargoOverflow) {
      log.debug(
        `[InvBroker] StripFitting rejected before moving items shipID=${shipRecord.itemID} — the cargo hold would be left at ${stripCargoOverflow.used} of ${stripCargoOverflow.capacityAfter}`,
      );
      this._throwUnfitCargoOverflowUserError(stripCargoOverflow);
    }

    const allChanges = [];
    let movedCount = 0;

    for (const fittedItem of fittedItems) {
      if (SLOT_FAMILY_FLAGS.rig.includes(fittedItem.flagID)) {
        continue;
      }

      const fittingServiceAccess = this._validateInSpaceFittingServiceAccess(
        session,
        shipRecord,
        fittedItem,
        {
          locationID: shipRecord.locationID,
          flagID: ITEM_FLAGS.HANGAR,
        },
      );
      if (!fittingServiceAccess.success) {
        log.debug(
          `[InvBroker] StripFitting rejected itemID=${fittedItem.itemID} error=${fittingServiceAccess.errorMsg}`,
        );
        this._throwInSpaceFittingAccessError(
          fittingServiceAccess.errorMsg,
          fittingServiceAccess.tooFar,
        );
      }

      const sourceItemDescriptor = this._findTransferSourceItem(
        fittedItem.itemID,
        shipRecord.itemID,
      );
      const moveResult = this._moveSourceItemToDestination(
        session,
        sourceItemDescriptor,
        {
          locationID: shipRecord.locationID,
          flagID: ITEM_FLAGS.HANGAR,
        },
      );
      if (!moveResult.success) {
        log.warn(`[InvBroker] StripFitting failed to move itemID=${fittedItem.itemID} typeID=${fittedItem.typeID} flagID=${fittedItem.flagID} error=${moveResult.errorMsg}`);
        continue;
      }

      movedCount += 1;
      allChanges.push(...((moveResult.data && moveResult.data.changes) || []));
    }

    if (movedCount <= 0) {
      return null;
    }

    this._emitStripFittingMoveChanges(session, allChanges);
    this._refreshBallparkShipPresentation(session, allChanges);
    this._refreshBallparkInventoryPresentation(session, allChanges);

    const dogmaChanges = allChanges.slice();
    setImmediate(() => {
      emitStripFittingDogmaMultiEventForSession(session, shipRecord.itemID, dogmaChanges, {
        previousSnapshot: previousFittingSnapshot,
        shipItem: shipRecord,
      });
    });

    return true;
  },

  Handle_DestroyFitting(args, session) {
    this._traceInventory("DestroyFitting", session, { args });
    const boundContext = this._getBoundContext(session);
    const boundInventoryID = this._normalizeInventoryId(
      boundContext && boundContext.inventoryID,
      0,
    );
    const itemID = this._normalizeInventoryId(args && args.length > 0 ? args[0] : 0, 0);
    if (itemID <= 0) {
      log.warn(`[InvBroker] DestroyFitting failed: invalid itemID`);
      return null;
    }

    const item = findItemById(itemID);
    if (!item) {
      log.warn(`[InvBroker] DestroyFitting failed: itemID=${itemID} not found`);
      return null;
    }

    if (!SLOT_FAMILY_FLAGS.rig.includes(item.flagID)) {
      log.debug(`[InvBroker] DestroyFitting rejected: itemID=${itemID} flagID=${item.flagID} is not a rig slot`);
      return null;
    }
    const fittingHostAccess = this._validateDestroyFittingHostAccess(
      session,
      boundContext,
      item,
    );
    if (!fittingHostAccess.success) {
      log.debug(
        `[InvBroker] DestroyFitting rejected: itemID=${itemID} locationID=${item.locationID} ` +
          `boundInventoryID=${boundInventoryID || 0} error=${fittingHostAccess.errorMsg}`,
      );
      if (fittingHostAccess.accessKind === "inSpaceShip") {
        this._throwInSpaceFittingAccessError(
          fittingHostAccess.errorMsg,
          fittingHostAccess.tooFar,
        );
      }
      if (fittingHostAccess.accessKind === "dockedShip") {
        this._throwDockedStructureFittingAccessError(fittingHostAccess.errorMsg);
      }
      return null;
    }

    // Destroying a cargo rig shrinks the hold just as unfitting one does.
    const destroyCargoOverflow = this._getCargoOverflowWithoutFittedItems(
      session,
      findShipItemById(item.locationID),
      [item],
    );
    if (destroyCargoOverflow) {
      log.debug(
        `[InvBroker] DestroyFitting rejected: itemID=${itemID} — the cargo hold would be left at ${destroyCargoOverflow.used} of ${destroyCargoOverflow.capacityAfter}`,
      );
      this._throwUnfitCargoOverflowUserError(destroyCargoOverflow);
    }

    log.debug(`[InvBroker] DestroyFitting itemID=${itemID} flagID=${item.flagID}`);
    const removeResult = removeInventoryItem(itemID, { removeContents: false });
    if (!removeResult.success) {
      log.warn(`[InvBroker] DestroyFitting failed to remove itemID=${itemID} error=${removeResult.errorMsg}`);
      return null;
    }

    const changes = (removeResult.data && removeResult.data.changes) || [];
    this._emitInventoryMoveChanges(session, changes);
    this._refreshBallparkShipPresentation(session, changes);
    this._refreshBallparkInventoryPresentation(session, changes);
    return null;
  },

  _fitFittingQuantityItemsToShipBay({
    session,
    shipRecord,
    sourceLocationID,
    itemsByType,
    entriesByType,
    destinationFlagID,
    itemLabel,
    allChanges,
    missingByType,
    isItemAllowed = null,
    settledSpaceLootSourceIDs = null,
  } = {}) {
    if (
      !shipRecord ||
      !(itemsByType instanceof Map) ||
      !Array.isArray(entriesByType) ||
      !Array.isArray(allChanges) ||
      !(missingByType instanceof Map)
    ) {
      return 0;
    }

    let fittedCount = 0;
    for (const entry of entriesByType) {
      const candidateItemIDs = itemsByType.get(entry.typeID) || [];
      const requestedQuantity = Math.max(0, Number(entry.quantity) || 0);
      const existingQuantity = this._getFitFittingExistingDestinationQuantity(
        session,
        shipRecord,
        destinationFlagID,
        entry.typeID,
      );
      let remainingQuantity = Math.max(0, requestedQuantity - existingQuantity);

      while (remainingQuantity > 0 && candidateItemIDs.length > 0) {
        const itemID = candidateItemIDs.shift();
        const sourceItemDescriptor = this._findTransferSourceItem(itemID, sourceLocationID);
        const item = sourceItemDescriptor && sourceItemDescriptor.item
          ? sourceItemDescriptor.item
          : null;
        if (
          !item ||
          Number(item.typeID) !== entry.typeID ||
          (
            typeof isItemAllowed === "function" &&
            !isItemAllowed(item)
          )
        ) {
          continue;
        }

        const destination = {
          locationID: shipRecord.itemID,
          flagID: destinationFlagID,
        };
        const shipServiceAccess = this._validateShipServiceTransferAccess(
          session,
          item,
          destination,
        );
        if (!shipServiceAccess.success) {
          log.debug(
            `[InvBroker] FitFitting rejected ${itemLabel} itemID=${itemID} shipService=${shipServiceAccess.shipID} error=${shipServiceAccess.errorMsg}`,
          );
          this._throwShipServiceAccessError(shipServiceAccess.errorMsg);
        }
        const fittingServiceAccess = this._validateInSpaceFittingServiceAccess(
          session,
          shipRecord,
          item,
          destination,
        );
        if (!fittingServiceAccess.success) {
          log.debug(
            `[InvBroker] FitFitting rejected ${itemLabel} itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${fittingServiceAccess.errorMsg}`,
          );
          this._throwInSpaceFittingAccessError(
            fittingServiceAccess.errorMsg,
            fittingServiceAccess.tooFar,
          );
        }
        const dockedStructureFittingAccess = this._validateDockedStructureFittingServiceAccess(
          session,
          shipRecord,
          item,
          destination,
        );
        if (!dockedStructureFittingAccess.success) {
          log.debug(
            `[InvBroker] FitFitting rejected ${itemLabel} itemID=${itemID} structure=${dockedStructureFittingAccess.structureID} destination=${destination.locationID}:${destination.flagID} error=${dockedStructureFittingAccess.errorMsg}`,
          );
          this._throwDockedStructureFittingAccessError(dockedStructureFittingAccess.errorMsg);
        }
        const shipBayValidation = this._validateShipBayMove(
          session,
          shipRecord,
          item,
          destination,
        );
        if (!shipBayValidation.success) {
          continue;
        }

        const availableQuantity = Number(item.singleton) === 1
          ? 1
          : Math.max(1, Number(item.stacksize ?? item.quantity ?? 1) || 1);
        const moveQuantity = Math.min(remainingQuantity, availableQuantity);
        const capacityCheck = this._checkCapacityForMove(
          session,
          { kind: "shipInventory", inventoryID: shipRecord.itemID, flagID: destinationFlagID },
          destination,
          item,
          moveQuantity,
        );
        if (!capacityCheck.success) {
          continue;
        }

        const sourceTakeAuthorization =
          this._ensureFitFittingSourceTakeAuthorized(
            session,
            sourceItemDescriptor,
            destination,
            settledSpaceLootSourceIDs,
          );

        let moveResult = null;
        try {
          moveResult = this._moveSourceItemToDestination(
            session,
            sourceItemDescriptor,
            destination,
            moveQuantity,
          );
        } catch (error) {
          this._compensatePlayerSpaceContainerTheft(
            session,
            sourceTakeAuthorization && sourceTakeAuthorization.settlement,
          );
          throw error;
        }
        if (!moveResult.success) {
          this._compensatePlayerSpaceContainerTheft(
            session,
            sourceTakeAuthorization && sourceTakeAuthorization.settlement,
          );
          continue;
        }

        this._commitPlayerSpaceContainerTheft(
          session,
          sourceTakeAuthorization && sourceTakeAuthorization.settlement,
        );
        if (
          settledSpaceLootSourceIDs instanceof Set &&
          sourceTakeAuthorization &&
          sourceTakeAuthorization.authoritativeSourceLocationID > 0
        ) {
          settledSpaceLootSourceIDs.add(
            sourceTakeAuthorization.authoritativeSourceLocationID,
          );
        }

        allChanges.push(...((moveResult.data && moveResult.data.changes) || []));
        remainingQuantity -= moveQuantity;
        fittedCount += moveQuantity;
      }

      if (remainingQuantity > 0) {
        missingByType.set(
          entry.typeID,
          (missingByType.get(entry.typeID) || 0) + remainingQuantity,
        );
      }
    }

    return fittedCount;
  },

  _preflightFitFittingSourceAccess(
    session,
    itemsByType,
    sourceLocationID,
    destinationContainerID,
  ) {
    if (!(itemsByType instanceof Map)) {
      return { success: false, errorMsg: "SOURCE_ITEMS_INVALID" };
    }
    const seen = new Set();
    for (const candidateItemIDs of itemsByType.values()) {
      for (const itemID of Array.isArray(candidateItemIDs) ? candidateItemIDs : []) {
        const numericItemID = this._normalizeInventoryId(itemID, 0);
        if (numericItemID <= 0 || seen.has(numericItemID)) {
          continue;
        }
        seen.add(numericItemID);
        const sourceItemDescriptor = this._findTransferSourceItem(
          numericItemID,
          sourceLocationID,
        );
        const access = this._validateDeclaredTransferSourceAccess(
          session,
          sourceItemDescriptor,
          sourceLocationID,
          destinationContainerID,
        );
        if (!access.success) {
          return {
            ...access,
            itemID: numericItemID,
          };
        }

        const destination = {
          locationID: destinationContainerID,
          flagID: ITEM_FLAGS.CARGO_HOLD,
        };
        const mobileDepotAccess =
          this._validateMobileDepotCargoTransferAccess(
            session,
            sourceItemDescriptor.item,
            destination,
          );
        if (!mobileDepotAccess.success) {
          return {
            ...mobileDepotAccess,
            accessKind: "mobileDepot",
            itemID: numericItemID,
          };
        }
        const mobileTractorUnitAccess =
          this._validateMobileTractorUnitCargoTransferAccess(
            session,
            sourceItemDescriptor.item,
            destination,
          );
        if (!mobileTractorUnitAccess.success) {
          return {
            ...mobileTractorUnitAccess,
            accessKind: "mobileTractorUnit",
            itemID: numericItemID,
          };
        }

        const authoritativeSourceLocationID =
          this._getAuthoritativeTransferSourceLocationID(
            sourceItemDescriptor,
          );
        const lootAccess = this._evaluatePlayerSpaceContainerLootMove(
          session,
          authoritativeSourceLocationID,
          destination,
        );
        if (!lootAccess.success) {
          return {
            ...lootAccess,
            accessKind: "spaceLoot",
            containerID: authoritativeSourceLocationID,
            itemID: numericItemID,
          };
        }
      }
    }
    return { success: true };
  },

  _ensureFitFittingSourceTakeAuthorized(
    session,
    sourceItemDescriptor,
    destination,
    settledSpaceLootSourceIDs,
  ) {
    const item = sourceItemDescriptor && sourceItemDescriptor.item;
    const mobileDepotAccess = this._validateMobileDepotCargoTransferAccess(
      session,
      item,
      destination,
    );
    if (!mobileDepotAccess.success) {
      this._throwMobileDepotCargoAccessError(
        mobileDepotAccess.errorMsg,
      );
    }
    const mobileTractorUnitAccess =
      this._validateMobileTractorUnitCargoTransferAccess(
        session,
        item,
        destination,
      );
    if (!mobileTractorUnitAccess.success) {
      this._throwMobileTractorUnitCargoAccessError(
        mobileTractorUnitAccess.errorMsg,
      );
    }

    const authoritativeSourceLocationID =
      this._getAuthoritativeTransferSourceLocationID(sourceItemDescriptor);
    if (
      settledSpaceLootSourceIDs instanceof Set &&
      settledSpaceLootSourceIDs.has(authoritativeSourceLocationID)
    ) {
      return {
        authoritativeSourceLocationID,
        settlement: null,
        alreadyCommitted: true,
      };
    }

    const lootEvaluation = this._evaluatePlayerSpaceContainerLootMove(
      session,
      authoritativeSourceLocationID,
      destination,
    );
    if (!lootEvaluation.success) {
      throwWrappedUserError(
        lootEvaluation.errorMsg || "SafetyActivated",
        {},
      );
    }
    const settlement = this._ensurePlayerSpaceContainerTheftSettled(
      session,
      lootEvaluation,
    );
    return {
      authoritativeSourceLocationID,
      settlement,
      alreadyCommitted: false,
    };
  },

  // Publishes everything a FitFitting apply has already committed. The apply
  // persists each module as it goes, so this must also run when it is cut
  // short by a UserError -- otherwise the rows that did move are live in the
  // store with the client still drawing them in the source hangar, which reads
  // to the player as a frozen ship list and an unopenable ship inventory.
  // Same contract as _finalizeMultiAddBatch (175c462d).
  _finalizeFitFittingBatch(session, allChanges, context = {}) {
    const emittedCount = this._emitFittingMoveChanges(session, allChanges, {
      previousModuleAttributeSnapshots:
        context.previousModuleAttributeSnapshots,
      previousShipFittingSnapshot: context.previousShipFittingSnapshot,
    });
    const fittedCount = Number(context.fittedCount) || 0;
    if (fittedCount > 0 && emittedCount <= 0) {
      // Invariant: a counted fit owes the client at least one row delta.
      // Reaching here means the apply mutated the store and told nobody, which
      // is indistinguishable from a dead Fit button in the UI. warn, not debug.
      log.warn(
        `[InvBroker] FitFitting emitted no client change despite fitted=${fittedCount} ` +
          `shipID=${context.shipID} source=${context.sourceLocationID} ` +
          `changes=${Array.isArray(allChanges) ? allChanges.length : 0} ` +
          `withItem=${(Array.isArray(allChanges) ? allChanges : []).filter((change) => change && change.item).length}` +
          `${context.aborted ? " aborted=true" : ""}`,
      );
    }
    return emittedCount;
  },

  Handle_FitFitting(args, session, kwargs) {
    this._traceInventory("FitFitting", session, { args, kwargs });
    const shipID = this._normalizeInventoryId(args && args.length > 0 ? args[0] : 0, 0);
    const sourceLocationID = this._normalizeInventoryId(
      args && args.length > 3 ? args[3] : this._getStationId(session),
      this._getStationId(session),
    );
    const itemsByType = this._normalizeFitFittingItemsByType(
      args && args.length > 2 ? args[2] : {},
    );
    const modulesByFlag = this._normalizeFitFittingModulesByFlag(
      args && args.length > 4 ? args[4] : {},
    );
    const cargoItemsByType = this._normalizeFitFittingQuantitiesByType(
      args && args.length > 5 ? args[5] : {},
      null,
    );
    const fitRigs =
      args && args.length > 6
        ? Boolean(unwrapMarshalValue(args[6]))
        : true;
    const dronesByType = this._normalizeFitFittingQuantitiesByType(
      args && args.length > 4 ? args[4] : {},
      "dronesByType",
    );
    const chargesByType = this._normalizeFitFittingQuantitiesByType(
      args && args.length > 4 ? args[4] : {},
      "chargesByType",
    );
    const fightersByType = this._normalizeFitFittingQuantitiesByType(
      args && args.length > 4 ? args[4] : {},
      "fightersByTypeID",
    );
    const iceByType = this._normalizeFitFittingQuantitiesByType(
      args && args.length > 4 ? args[4] : {},
      "iceByType",
    );
    const implantsByType = this._normalizeFitFittingQuantitiesByType(
      args && args.length > 4 ? args[4] : {},
      "implantsByTypeID",
    );
    const shipRecord =
      findCharacterShip(this._getCharacterId(session), shipID) ||
      findShipItemById(shipID) ||
      this._getStructureFitHostRecord(session, shipID);
    const fittedItemsSnapshot = shipRecord
      ? this._listFittedItemsForFitHost(session, shipRecord)
        .map((item) => ({ ...item }))
      : [];
    const missingByType = new Map();
    const fitRefusals = createFitRefusalLog((typeID) => {
      const itemType = resolveItemByTypeID(typeID);
      return (itemType && itemType.name) || `type ${typeID}`;
    });
    const allChanges = [];
    const settledSpaceLootSourceIDs = new Set();
    let fittedCount = 0;
    let previousModuleAttributeSnapshots = null;
    let attemptedModuleAttributeCapture = false;

    log.debug(
      `[InvBroker] FitFitting shipID=${shipID} source=${sourceLocationID} moduleSlots=${modulesByFlag.length} cargoTypes=${cargoItemsByType.length} fitRigs=${fitRigs} droneTypes=${dronesByType.length} chargeTypes=${chargesByType.length} fighterTypes=${fightersByType.length} iceTypes=${iceByType.length} implantTypes=${implantsByType.length}`,
    );

    if (
      !shipRecord ||
      (
        modulesByFlag.length <= 0 &&
        cargoItemsByType.length <= 0 &&
        dronesByType.length <= 0 &&
        chargesByType.length <= 0 &&
        fightersByType.length <= 0 &&
        iceByType.length <= 0 &&
        implantsByType.length <= 0
      )
    ) {
      return buildList([]);
    }

    // The "before" side of the client's fitting-window deltas has to predate
    // this apply's first move. Leaving it to the peek inside
    // emitFittingTransactionForSession does not work here: the drone, cargo,
    // charge and fighter legs below check capacity against a non-fitting
    // destination, which rebuilds the ship fitting snapshot and re-caches it —
    // from the ship as it stands with every module already fitted. The peek
    // would then diff that against itself and swallow the whole delta set, so a
    // fit with powergrid rigs leaves the client painting the unrigged
    // powerOutput until some later single-module fit pushes a fresh value.
    // Taken here rather than at the first module move so a fit that only fills
    // the drone bay or cargo hold is covered too.
    const previousShipFittingSnapshot = getShipFittingSnapshot(
      this._getCharacterId(session),
      shipRecord.itemID,
      {
        shipItem: shipRecord,
        forceRefresh: true,
        reason: "invbroker.fit-fitting.before",
      },
    );

    if (
      this._isPendingStructureUnanchorContainerInventoryID(sourceLocationID)
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }
    for (const candidateItemIDs of itemsByType.values()) {
      if (
        candidateItemIDs.some((itemID) =>
          this._isPendingStructureUnanchorContainerInventoryID(itemID),
        )
      ) {
        this._throwPendingStructureUnanchorContainerInventoryError();
      }
    }
    const sourceAccessPreflight = this._preflightFitFittingSourceAccess(
      session,
      itemsByType,
      sourceLocationID,
      shipRecord.itemID,
    );
    if (!sourceAccessPreflight.success) {
      log.debug(
        `[InvBroker] FitFitting rejected itemID=${sourceAccessPreflight.itemID || 0} source=${sourceLocationID} container=${sourceAccessPreflight.containerID || 0} error=${sourceAccessPreflight.errorMsg}`,
      );
      if (
        sourceAccessPreflight.errorMsg === "CONTAINER_NOT_VISIBLE" ||
        sourceAccessPreflight.errorMsg === "CONTAINER_TOO_FAR" ||
        String(sourceAccessPreflight.errorMsg || "").startsWith("CUSTOMS_OFFICE_") ||
        String(sourceAccessPreflight.errorMsg || "").startsWith("ABYSSAL_REWARD_")
      ) {
        this._throwSpaceContainerScopeAccessError(
          sourceAccessPreflight.errorMsg,
          sourceAccessPreflight.side === "destination" ? "add" : "loot",
        );
      }
      if (sourceAccessPreflight.accessKind === "mobileDepot") {
        this._throwMobileDepotCargoAccessError(
          sourceAccessPreflight.errorMsg,
        );
      }
      if (sourceAccessPreflight.accessKind === "mobileTractorUnit") {
        this._throwMobileTractorUnitCargoAccessError(
          sourceAccessPreflight.errorMsg,
        );
      }
      if (sourceAccessPreflight.accessKind === "spaceLoot") {
        throwWrappedUserError(
          sourceAccessPreflight.errorMsg || "SafetyActivated",
          {},
        );
      }
      return buildList([]);
    }

    // The modules this call actually lands in a fitting slot, in apply order.
    // The post-loop re-online pass reconsiders exactly these and nothing else.
    const fittedModuleIDs = [];
    // A slot can be refused because of a module this same fit swaps out of
    // another slot later on (one-per-ship modules, turret and launcher
    // hardpoints). Such a slot goes back to the end of the list and is tried
    // again; it only counts as missing once nothing has been swapped out since
    // its last try.
    const slotApplyQueue = [...modulesByFlag];
    const swappedOutCountAtRetry = new Map();
    let swappedOutCount = 0;

    try {
      for (const entry of slotApplyQueue) {
        if (!fitRigs && SLOT_FAMILY_FLAGS.rig.includes(entry.flagID)) {
          continue;
        }
        const slotAlreadySatisfied = fittedItemsSnapshot.some(
          (item) =>
            Number(item && item.flagID) === Number(entry.flagID) &&
            Number(item && item.typeID) === Number(entry.typeID),
        );
        if (slotAlreadySatisfied) {
          continue;
        }
        const occupant = this._findFitFittingSlotOccupant(
          fittedItemsSnapshot,
          entry.flagID,
        );
        if (occupant && SLOT_FAMILY_FLAGS.rig.includes(entry.flagID)) {
          // Only reachable with fitRigs on a strategic cruiser: the client
          // withholds fitRigs from any other ship whose rigs differ. The fitted
          // rig stays, and the fit's rig is not "missing" -- it may well be in
          // the hangar, and the buy box would offer to sell it again.
          log.debug(
            `[InvBroker] FitFitting kept fitted rig itemID=${occupant.module.itemID} ` +
              `typeID=${occupant.module.typeID} flagID=${entry.flagID} fitTypeID=${entry.typeID}`,
          );
          continue;
        }
        let displaceOccupant =
          Boolean(occupant) &&
          this._canDisplaceFitFittingSlot(session, shipRecord, entry.flagID);
        const candidateItemIDs = itemsByType.get(entry.typeID) || [];
        const shipWideLimitRefusedItemIDs = [];
        let fitted = false;
        let finalFitRefusal = null;

        while (candidateItemIDs.length > 0) {
          const itemID = candidateItemIDs.shift();
          const sourceItemDescriptor = this._findTransferSourceItem(itemID, sourceLocationID);
          const item = sourceItemDescriptor && sourceItemDescriptor.item
            ? sourceItemDescriptor.item
            : null;
          if (!item || Number(item.typeID) !== entry.typeID) {
            continue;
          }

          const destination = {
            locationID: shipRecord.itemID,
            flagID: entry.flagID,
          };
          const shipServiceAccess = this._validateShipServiceTransferAccess(
            session,
            item,
            destination,
          );
          if (!shipServiceAccess.success) {
            log.debug(
              `[InvBroker] FitFitting rejected itemID=${itemID} shipService=${shipServiceAccess.shipID} error=${shipServiceAccess.errorMsg}`,
            );
            this._throwShipServiceAccessError(shipServiceAccess.errorMsg);
          }
          const fittingServiceAccess = this._validateInSpaceFittingServiceAccess(
            session,
            shipRecord,
            item,
            destination,
          );
          if (!fittingServiceAccess.success) {
            log.debug(
              `[InvBroker] FitFitting rejected itemID=${itemID} destination=${destination.locationID}:${destination.flagID} error=${fittingServiceAccess.errorMsg}`,
            );
            this._throwInSpaceFittingAccessError(
              fittingServiceAccess.errorMsg,
              fittingServiceAccess.tooFar,
            );
          }
          const dockedStructureFittingAccess = this._validateDockedStructureFittingServiceAccess(
            session,
            shipRecord,
            item,
            destination,
          );
          if (!dockedStructureFittingAccess.success) {
            log.debug(
              `[InvBroker] FitFitting rejected itemID=${itemID} structure=${dockedStructureFittingAccess.structureID} destination=${destination.locationID}:${destination.flagID} error=${dockedStructureFittingAccess.errorMsg}`,
            );
            this._throwDockedStructureFittingAccessError(dockedStructureFittingAccess.errorMsg);
          }
          // Judge the fit as if the slot were already empty when its occupant
          // is about to be swapped out; nothing moves unless this passes.
          const fitValidation = this._validateFittingMove(
            session,
            shipRecord,
            item,
            destination,
            displaceOccupant
              ? fittedItemsSnapshot.filter(
                (fittedItem) =>
                  fittedItem !== occupant.module &&
                  !occupant.charges.includes(fittedItem),
              )
              : fittedItemsSnapshot,
          );
          finalFitRefusal = fitValidation.success ? null : fitValidation;
          if (!fitValidation.success) {
            if (FIT_FITTING_SHIP_WIDE_LIMIT_ERRORS.has(fitValidation.errorMsg)) {
              shipWideLimitRefusedItemIDs.push(itemID);
            }
            continue;
          }
          const shipBayValidation = this._validateShipBayMove(
            session,
            shipRecord,
            item,
            destination,
          );
          if (!shipBayValidation.success) {
            continue;
          }
          const capacityCheck = this._checkCapacityForMove(
            session,
            { kind: "shipInventory", inventoryID: shipRecord.itemID, flagID: entry.flagID },
            destination,
            item,
            1,
          );
          if (!capacityCheck.success) {
            continue;
          }

          const sourceTakeAuthorization =
            this._ensureFitFittingSourceTakeAuthorized(
              session,
              sourceItemDescriptor,
              destination,
              settledSpaceLootSourceIDs,
            );

          if (!attemptedModuleAttributeCapture) {
            attemptedModuleAttributeCapture = true;
            previousModuleAttributeSnapshots = this._captureFittingModuleAttributeState(
              session,
              shipRecord.itemID,
            );
          }
          if (displaceOccupant) {
            displaceOccupant = false;
            const displacement = this._displaceFitFittingSlotOccupant(
              session,
              shipRecord,
              occupant,
            );
            allChanges.push(...displacement.changes);
            for (const movedItem of displacement.movedItems) {
              fittedItemsSnapshot.splice(fittedItemsSnapshot.indexOf(movedItem), 1);
            }
            if (!displacement.moduleMoved) {
              this._compensatePlayerSpaceContainerTheft(
                session,
                sourceTakeAuthorization && sourceTakeAuthorization.settlement,
              );
              break;
            }
            swappedOutCount += 1;
          }
          let moveResult = null;
          try {
            moveResult = this._moveSourceItemToDestination(
              session,
              sourceItemDescriptor,
              destination,
              this._resolveAppliedMoveQuantity(item, destination, 1),
            );
          } catch (error) {
            this._compensatePlayerSpaceContainerTheft(
              session,
              sourceTakeAuthorization && sourceTakeAuthorization.settlement,
            );
            throw error;
          }
          if (!moveResult.success) {
            this._compensatePlayerSpaceContainerTheft(
              session,
              sourceTakeAuthorization && sourceTakeAuthorization.settlement,
            );
            continue;
          }

          const serviceModuleMoveResult = this._syncStructureServiceModuleMove(
            session,
            item,
            destination,
          );
          if (!serviceModuleMoveResult.success) {
            this._compensatePlayerSpaceContainerTheft(
              session,
              sourceTakeAuthorization && sourceTakeAuthorization.settlement,
            );
            continue;
          }

          this._commitPlayerSpaceContainerTheft(
            session,
            sourceTakeAuthorization && sourceTakeAuthorization.settlement,
          );
          if (
            settledSpaceLootSourceIDs instanceof Set &&
            sourceTakeAuthorization &&
            sourceTakeAuthorization.authoritativeSourceLocationID > 0
          ) {
            settledSpaceLootSourceIDs.add(
              sourceTakeAuthorization.authoritativeSourceLocationID,
            );
          }

          const movedItemID =
            this._resolveMovedItemID(moveResult, itemID, destination) || itemID;
          const movedItem = findItemById(movedItemID) || item;
          fittedItemsSnapshot.push({
            itemID: movedItemID,
            typeID: movedItem.typeID,
            flagID: entry.flagID,
            locationID: shipRecord.itemID,
            categoryID: movedItem.categoryID,
            groupID: movedItem.groupID,
          });
          allChanges.push(...((moveResult.data && moveResult.data.changes) || []));
          allChanges.push(
            ...this._resolveShipModuleFitOnlineChanges(session, item, destination),
          );
          if (isShipFittingFlag(entry.flagID)) {
            fittedModuleIDs.push(movedItemID);
          }
          this._requeueFitFittingSourceStack(candidateItemIDs, itemID, item);
          fittedCount += 1;
          fitted = true;
          break;
        }

        if (
          !fitted &&
          shipWideLimitRefusedItemIDs.length > 0 &&
          swappedOutCountAtRetry.get(entry) !== swappedOutCount
        ) {
          swappedOutCountAtRetry.set(entry, swappedOutCount);
          candidateItemIDs.unshift(...shipWideLimitRefusedItemIDs);
          slotApplyQueue.push(entry);
          continue;
        }
        if (!fitted) {
          missingByType.set(entry.typeID, (missingByType.get(entry.typeID) || 0) + 1);
          fitRefusals.record(entry.typeID, finalFitRefusal);
        }
      }

      // Runs here rather than after the bay legs below: cargo, drones, charges,
      // fighters and implants never touch powergrid or CPU, so the fit's
      // resource budget is already final at this point.
      allChanges.push(
        ...this._reonlineFitFittingModules(session, shipRecord, fittedModuleIDs),
      );

      fittedCount += this._fitFittingQuantityItemsToShipBay({
        session,
        shipRecord,
        sourceLocationID,
        itemsByType,
        entriesByType: cargoItemsByType,
        destinationFlagID: ITEM_FLAGS.CARGO_HOLD,
        itemLabel: "cargo item",
        allChanges,
        missingByType,
        settledSpaceLootSourceIDs,
      });
      fittedCount += this._fitFittingQuantityItemsToShipBay({
        session,
        shipRecord,
        sourceLocationID,
        itemsByType,
        entriesByType: dronesByType,
        destinationFlagID: ITEM_FLAGS.DRONE_BAY,
        itemLabel: "drone",
        allChanges,
        missingByType,
        settledSpaceLootSourceIDs,
      });
      fittedCount += this._fitFittingQuantityItemsToShipBay({
        session,
        shipRecord,
        sourceLocationID,
        itemsByType,
        entriesByType: iceByType,
        destinationFlagID: ITEM_FLAGS.CARGO_HOLD,
        itemLabel: "ice product",
        allChanges,
        missingByType,
        settledSpaceLootSourceIDs,
        isItemAllowed: (item) => {
          const typeRecord = resolveItemByTypeID(item && item.typeID) || {};
          return Number(item && (item.groupID || typeRecord.groupID)) === ICE_PRODUCT_GROUP_ID;
        },
      });
      fittedCount += this._fitFittingQuantityItemsToShipBay({
        session,
        shipRecord,
        sourceLocationID,
        itemsByType,
        entriesByType: implantsByType,
        destinationFlagID: ITEM_FLAGS.CARGO_HOLD,
        itemLabel: "implant",
        allChanges,
        missingByType,
        settledSpaceLootSourceIDs,
        isItemAllowed: (item) => {
          const typeRecord = resolveItemByTypeID(item && item.typeID) || {};
          return Number(item && (item.categoryID || typeRecord.categoryID)) === IMPLANT_CATEGORY_ID;
        },
      });
      fittedCount += this._fitFittingQuantityItemsToShipBay({
        session,
        shipRecord,
        sourceLocationID,
        itemsByType,
        entriesByType: fightersByType,
        destinationFlagID: ITEM_FLAGS.FIGHTER_BAY,
        itemLabel: "fighter",
        allChanges,
        missingByType,
        settledSpaceLootSourceIDs,
      });
      fittedCount += this._fitFittingQuantityItemsToShipBay({
        session,
        shipRecord,
        sourceLocationID,
        itemsByType,
        entriesByType: chargesByType,
        destinationFlagID: ITEM_FLAGS.CARGO_HOLD,
        itemLabel: "charge",
        allChanges,
        missingByType,
        settledSpaceLootSourceIDs,
      });
    } catch (error) {
      // A mid-apply UserError (ship-service, in-space fitting, docked-structure
      // access) aborts the loop, but every module already moved above is
      // committed to the store. Publish those deltas before the error
      // propagates, or the client keeps listing them in the hangar while the
      // ship really holds them.
      if (allChanges.length > 0) {
        this._finalizeFitFittingBatch(session, allChanges, {
          shipID,
          sourceLocationID,
          fittedCount,
          previousModuleAttributeSnapshots,
          previousShipFittingSnapshot,
          aborted: true,
        });
      }
      throw error;
    }

    if (fittedCount > 0) {
      this._finalizeFitFittingBatch(session, allChanges, {
        shipID,
        sourceLocationID,
        fittedCount,
        previousModuleAttributeSnapshots,
        previousShipFittingSnapshot,
      });
    }

    fitRefusals.notify(session, missingByType);
    return buildList(
      [...missingByType.entries()]
        .sort(([leftTypeID], [rightTypeID]) => leftTypeID - rightTypeID)
        .map(([typeID, quantity]) => ({
          type: "tuple",
          items: [typeID, quantity],
        })),
    );
  },
};
