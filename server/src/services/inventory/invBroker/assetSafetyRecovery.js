"use strict";

// Native inventory entry points for safety recovery. Ordinary Add/MultiAdd stay
// synchronous; only a recognized safety source takes this async settlement path.
const recovery = require("../../structure/structureAssetSafetyRecovery");
const state = require("../../structure/structureAssetSafetyState");
const { unwrapMarshalValue } = require("../../_shared/serviceHelpers");
const { buildMarshalRealMoney } = require("../../account/walletState");
const { findItemById, ITEM_FLAGS } = require("../itemStore");
const { isCargoContainerType, isSecureCargoContainerType } = require("../../ship/cargoContainerRuntime");
const { getCharacterRecord, getActiveShipRecord } = require("../../character/characterState");
const { getPersistedCorporationAuthority } = require("../../corporation/corporationAuthority");
const sessionRegistry = require("../../chat/sessionRegistry");
const { throwWrappedUserError } = require("../../../common/machoErrors");
const log = require("../../../utils/logger");

function refuse(notify) { throwWrappedUserError("CustomNotify", { notify }); }
const quantityOf = (item) => Number(item.singleton) === 1 ? 1 : Number(item.stacksize ?? item.quantity);

module.exports = {
  _getAssetSafetyAncestorWrap(inventoryID) {
    const visited = new Set();
    let id = Number(inventoryID);
    while (id && !visited.has(id)) {
      visited.add(id);
      const wrap = state.getWrapByID(id, { refresh: false });
      if (wrap) return wrap;
      id = Number(findItemById(id)?.locationID || 0);
    }
    return null;
  },

  _getDeliveredAssetSafetyWrapItem(session, inventoryID) {
    const wrap = state.getWrapByID(inventoryID, { refresh: false });
    const item = state.getDeliveredWrapItem(inventoryID);
    return item && item.locationID === this._getStationId(session) &&
      state.sessionCanManageWrap(session, wrap) ? item : null;
  },

  _getAccessibleAssetSafetyInventoryWrap(session, inventoryID) {
    const wrap = this._getAssetSafetyAncestorWrap(inventoryID);
    if (!wrap || !this._getDeliveredAssetSafetyWrapItem(session, wrap.assetWrapID)) return null;
    if (Number(inventoryID) === Number(wrap.assetWrapID)) return wrap;
    const container = findItemById(inventoryID);
    if (!recovery.isOrdinarySourceContainer(container)) return null;
    try { recovery.sourcePath(container, wrap); }
    catch (error) { return null; }
    return wrap;
  },

  _startAssetSafetyRecovery() {
    recovery.registerInventoryValidator((operation) => {
      const stored = getCharacterRecord(operation.actorID);
      const ship = getActiveShipRecord(operation.actorID);
      const liveSession = sessionRegistry.findSessionByCharacterID(operation.actorID);
      // This is continuation of an already authorized durable operation, not a
      // new login. Read current inventory/session authority again after restart.
      let session = liveSession || {
        ...stored, characterID: operation.actorID, charid: operation.actorID,
        activeShipID: Number(ship?.itemID || 0), shipID: Number(ship?.itemID || 0),
      };
      const destinationCorporationID = operation.itemLegs.find(leg =>
        Number(leg.destination.ownerID) > 0 && Number(leg.destination.ownerID) !== operation.actorID)?.destination.ownerID;
      const corporationID = operation.payer?.kind === "corp" ? operation.payer.ownerID : destinationCorporationID;
      if (corporationID && stored && Number(stored.corporationID) === Number(corporationID) && !liveSession) {
        const roles = require("../../corporation/corporationRuntimeState").getCorporationSessionRoleState(
          Number(stored?.corporationID), operation.actorID);
        session = { ...session, ...roles, corpAccountKey: roles.accountKey, corpaccountkey: roles.accountKey };
      }
      if (!stored || Number(this._getStationId(session)) !== Number(operation.wrapItem.locationID)) {
        refuse("Remain docked at the delivered asset safety wrap while recovering items.");
      }
      recovery.validatePayer(operation, session);
      const roots = operation.itemLegs.filter((leg) => leg.status !== "committed").map((leg) => {
        recovery.validateSourcePath(operation, leg);
        const current = findItemById(leg.sourceItem.itemID);
        if (!current || Number(current.ownerID) !== Number(operation.sourceOwnerID || operation.actorID) ||
            Number(current.locationID) !== Number(leg.sourceItem.locationID) ||
            Number(current.flagID) !== Number(leg.sourceItem.flagID) ||
            quantityOf(current) !== quantityOf(leg.sourceItem) ||
            recovery.fingerprintTree(current.itemID) !== leg.treeFingerprint) {
          refuse("An item changed while asset safety recovery was pending.");
        }
        return { item: current, quantity: leg.quantity };
      });
      const destinations = this._validateAssetSafetyRecoveryDestinations(session, operation.boundContext,
        roots, operation.requestedFlag, operation.explicitFlagProvided);
      for (const leg of operation.itemLegs.filter((entry) => entry.status !== "committed")) {
        const destination = destinations[leg.sourceItem.itemID];
        if (!destination || destination.locationID !== leg.destination.locationID ||
            Number(destination.ownerID) !== Number(leg.destination.ownerID || operation.actorID) ||
            destination.flagID !== leg.destination.flagID) {
          refuse("The asset safety recovery destination changed.");
        }
      }
    });
    recovery.recoverPendingWithdrawals().catch((error) =>
      log.warn(`[InvBroker] Asset safety recovery remains pending: ${error.message}`));
  },

  _hasAssetSafetyRecoverySource(itemIDs) {
    return itemIDs.some((itemID) => Boolean(recovery.findSourceWrap(findItemById(itemID))));
  },

  async Handle_GetPriceForItems(args, session) {
    const itemIDs = unwrapMarshalValue(args?.[0]);
    const context = this._getBoundContext(session);
    await recovery.ready();
    const priced = recovery.quote(Number(context?.inventoryID || 0), itemIDs, session);
    return buildMarshalRealMoney(priced.amount, 0);
  },

  _validateAssetSafetyRecoveryDestinations(session, boundContext, roots, requestedFlag, explicitFlagProvided) {
    if (!boundContext) refuse("Select a destination for recovered asset safety items.");
    const destinations = {};
    const reserved = new Map();
    for (const { item, quantity } of roots) {
      const destination = this._resolveDestinationForMove(session, boundContext, item, requestedFlag, explicitFlagProvided);
      const ownerID = this._getCharacterId(session);
      const target = destination && findItemById(destination.locationID);
      const hangar = destination && destination.locationID === this._getStationId(session) &&
        destination.flagID === ITEM_FLAGS.HANGAR;
      const cargo = target && Number(target.ownerID) === ownerID &&
        Number(target.itemID) === Number(this._getShipId(session)) && destination.flagID === ITEM_FLAGS.CARGO_HOLD;
      const container = target && Number(target.ownerID) === ownerID && isCargoContainerType(target) &&
        !isSecureCargoContainerType(target) && destination.flagID === 0;
      const sourceWrap = recovery.findSourceWrap(item);
      const corporateSource = sourceWrap?.ownerKind === "corp";
      const office = destination && this._getCorporationOffice(session, destination.locationID);
      const division = destination && this._getCorporationOfficeDivisionDestinationContext(session, destination);
      const corporationAuthority = office && division?.accessAllowed ? getPersistedCorporationAuthority(session) : null;
      // The destination owns deposited items, independently of the source
      // wrap's owner and fee payer (native BaseInvContainer's one-way move).
      const corporationDivision = office && division?.accessAllowed &&
        Number(division.stationID) === Number(this._getStationId(session)) &&
        corporationAuthority?.characterID === ownerID &&
        corporationAuthority?.corporationID === Number(division.corporationID) &&
        this._isCorporationHangarFlag(destination.flagID);
      const personal = (hangar || cargo || container) && this._isCharacterOwnedMoveDestination(session, destination);
      if ((!personal && !corporationDivision) ||
          recovery.findSourceWrap(target) ||
          this._getInventoryCustodyAccessError(session, {
            locationID: destination.locationID, flagID: destination.flagID,
          }, { direction: "put" })) {
        refuse(corporateSource ? "Corporation asset safety withdrawal is currently unavailable."
          : "Recover asset safety items to your hangar, active cargo, an ordinary personal container or an accessible corporation office division.");
      }
      if (corporationDivision) this._ensureCorporationOfficeDivisionDestinationAccess(session, destination);
      this._ensureItemMoveInvariant({ sourceKind: "inventory", item }, destination);
      this._ensureSecureContainerTransferAccess(session, item, destination);
      const ship = cargo ? target : null;
      const bay = this._validateShipBayMove(session, ship, item, destination);
      if (!bay.success) this._throwShipBayMoveUserError(bay, item);
      const key = `${destination.locationID}:${destination.flagID}`;
      const capacity = this._checkCapacityForMove(session, boundContext, destination, item, quantity, reserved.get(key) || 0);
      if (!capacity.success) {
        throwWrappedUserError(capacity.errorMsg, this._buildCapacityMoveUserErrorValues(capacity, item));
      }
      reserved.set(key, (reserved.get(key) || 0) + this._getItemMoveVolume(item, quantity));
      destinations[item.itemID] = { ...destination, ownerID: corporationDivision ? Number(division.corporationID) : ownerID };
    }
    return destinations;
  },

  async _recoverAssetSafetyItems(session, boundContext, itemIDs, sourceLocationID,
    requestedQuantity, requestedFlag, explicitFlagProvided, single) {
    await recovery.ready();
    const items = itemIDs.map((itemID) => findItemById(itemID));
    const wrap = recovery.findSourceWrap(items[0]);
    if (!wrap) refuse("This asset safety selection is not available.");
    if (items.some(item => !item || Number(item.locationID) !== Number(sourceLocationID))) {
      refuse("The selected items are not in that asset safety source container.");
    }
    if (!single && requestedQuantity !== null && requestedQuantity !== undefined) {
      refuse("Recover partial asset safety stacks one at a time.");
    }
    const quantities = Object.fromEntries(items.map((item) => [item.itemID,
      requestedQuantity === null || requestedQuantity === undefined ? quantityOf(item) : Number(requestedQuantity)]));
    const priced = recovery.quote(wrap.assetWrapID, itemIDs, session, quantities);
    const destinations = this._validateAssetSafetyRecoveryDestinations(session, boundContext,
      priced.roots, requestedFlag, explicitFlagProvided);
    const result = await recovery.withdraw(wrap.assetWrapID, itemIDs, session, {
      quantities, destinations, boundContext, requestedFlag, explicitFlagProvided, sourceLocationID: Number(sourceLocationID),
    }, (fresh) => this._validateAssetSafetyRecoveryDestinations(session, boundContext,
      fresh.roots, requestedFlag, explicitFlagProvided));
    return single ? result.itemIDs[0] : true;
  },
};
