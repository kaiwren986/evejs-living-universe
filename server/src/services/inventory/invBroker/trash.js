"use strict";

// Trash in the inventory broker (invbroker): destroying items the player trashes
// (TrashItems), which items may be trashed and from where (including a director trashing from
// a corporation hangar), the command identity that makes a repeated TrashItems call safe, and
// the no-op TakeOutTrash. These are InvBrokerService methods, moved here as they were;
// invBrokerService.js puts them back on the class prototype, so `this` is the service.

const crypto = require("crypto");
const path = require("path");

const {
  CORP_ROLE_DIRECTOR,
} = require(path.join(__dirname, "../../corporation/corporationRuntimeState"));
const {
  isShipFittingFlag,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  trashInventoryItemsMany,
} = require(path.join(__dirname, "../itemStore"));

const CANNOT_TRASH_ERROR = "CannotTrashItem";
const TRASH_MANY_NOTIFICATION_ROW_LIMIT = 500;
const TRASH_MANY_COMMAND_SCHEMA_VERSION = 1;

function buildTrashManyCommandIdentity(actorID, requestedLocationID, itemIDs = []) {
  const canonicalItemIDs = [...new Set(
    (Array.isArray(itemIDs) ? itemIDs : [])
      .map((itemID) => Number(itemID))
      .filter((itemID) => Number.isFinite(itemID) && itemID > 0)
      .map((itemID) => Math.trunc(itemID)),
  )].sort((left, right) => left - right);
  const command = {
    schemaVersion: TRASH_MANY_COMMAND_SCHEMA_VERSION,
    actorID: Math.trunc(Number(actorID) || 0),
    requestedLocationID: Math.trunc(Number(requestedLocationID) || 0),
    removeContents: true,
    itemIDs: canonicalItemIDs,
  };
  const requestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(command))
    .digest("hex");
  return {
    canonicalItemIDs,
    receiptKey:
      `inventory:trash-many:v${TRASH_MANY_COMMAND_SCHEMA_VERSION}:` +
      `${command.actorID}:${requestHash}`,
    fingerprint: {
      schemaVersion: TRASH_MANY_COMMAND_SCHEMA_VERSION,
      actorID: command.actorID,
      requestedLocationID: command.requestedLocationID,
      removeContents: true,
      requestedCount: canonicalItemIDs.length,
      requestHash,
    },
  };
}

module.exports = {
  _isSessionCorporationDirector(session) {
    const roleMask = this._getSessionCorpRoleMask(session);
    return (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR;
  },

  _getDirectLocalCorporationHangarTrashContext(session, item) {
    const context = this._getDirectLocalCorporationHangarItemContext(
      session,
      item,
    );
    if (
      !context ||
      !context.takeAllowed ||
      !this._isSessionCorporationDirector(session)
    ) {
      return null;
    }
    return context;
  },

  _isInventoryItemTrashable(session, item, requestedLocationID = 0) {
    if (!item || typeof item !== "object") {
      return false;
    }

    const characterID = this._getCharacterId(session);
    const itemID = this._normalizeInventoryId(item.itemID, 0);
    const ownerID = this._normalizeInventoryId(item.ownerID, 0);
    const activeShipID = this._getShipId(session);
    const normalizedRequestedLocationID = this._normalizeInventoryId(
      requestedLocationID,
      0,
    );
    if (itemID <= 0 || normalizedRequestedLocationID <= 0) {
      return false;
    }

    // Retail lets a CEO/director trash a corporation-owned item only when it
    // is directly in the current station's office division and that director
    // also has the division's Hangar Take role.  This intentionally does not
    // turn ordinary corporation access into destructive access.
    const corporationHangarContext = ownerID === characterID
      ? null
      : this._getDirectLocalCorporationHangarTrashContext(session, item);
    if (ownerID !== characterID && !corporationHangarContext) {
      return false;
    }

    if (itemID === activeShipID) {
      return false;
    }

    if (isShipFittingFlag(item.flagID)) {
      return false;
    }

    // Personal Assets can trash owned station inventory from anywhere. Session
    // location is irrelevant; only actual in-space custody must block deletion.
    if (
      this._getInventoryItemAncestorChain(itemID).some((ancestor) =>
        this._isPersistedSpaceInventoryRecord(ancestor)
      )
    ) {
      return false;
    }

    // The client sends the item's IMMEDIATE container, not its root. See
    // invItemFunctions.TrashInvItems: it asks invCache.GetStationIDOfItem()
    // first, and that returns None unless item.locationID is itself a station
    // or a known structure (GetStationIDandOfficeIDOfItem ends in
    // `return (None, None)`), so it falls back to `invItems[0].locationID`.
    // Anything one level in -- cargo hold, ore hold, drone bay, a container in
    // the hangar -- therefore arrives as the ship or container id, and a
    // root-only comparison refused every one of them with CannotTrashItem.
    // Accepting the direct location as well mirrors what
    // _isTransferSourceLocationMatch already does for moves; it widens nothing,
    // because ownership and the in-space custody check above are what actually
    // authorize the deletion.
    const directLocationID = this._normalizeInventoryId(item.locationID, 0);
    return (
      directLocationID === normalizedRequestedLocationID ||
      this._resolveInventoryRootLocationID(item) === normalizedRequestedLocationID ||
      (
        corporationHangarContext &&
        corporationHangarContext.stationID === normalizedRequestedLocationID
      )
    );
  },

  Handle_TrashItems(args, session) {
    const itemIDs = this._normalizeItemIdList(args && args.length > 0 ? args[0] : []);
    const requestedLocationID = this._normalizeInventoryId(
      args && args.length > 1 ? args[1] : this._getStationId(session),
      this._getStationId(session),
    );

    if (itemIDs.length === 0) {
      return null;
    }

    const actorID = this._getCharacterId(session);
    const commandIdentity = buildTrashManyCommandIdentity(
      actorID,
      requestedLocationID,
      itemIDs,
    );
    this._traceInventory("TrashItems", session, {
      itemCount: commandIdentity.canonicalItemIDs.length,
      requestedLocationID,
      operationKey: commandIdentity.receiptKey,
    });
    log.debug(
      `[InvBroker] TrashItems bulk requested key=${commandIdentity.receiptKey} ` +
      `items=${commandIdentity.canonicalItemIDs.length}`,
    );

    const removeResult = trashInventoryItemsMany(itemIDs, {
      removeContents: true,
      receiptKey: commandIdentity.receiptKey,
      fingerprint: commandIdentity.fingerprint,
      requireDurable: false,
      receiptMetadata: {
        actorID,
        requestedLocationID,
        source: "invBroker.TrashItems",
      },
      preflight: ({ requestedItems, orderedRemovalItems }) => {
        // This is the command's sole authorization gate. It receives the
        // complete, detached removal plan before any row is staged.
        if (
          requestedItems.some((item) =>
            this._getPendingStructureUnanchorContainerAncestor(item),
          )
        ) {
          this._throwPendingStructureUnanchorContainerInventoryError();
        }
        // Keep a deletion to one owning principal. Personal roots retain their
        // existing remote-assets behavior; corporation roots must each pass
        // the narrower director + local office-division rule. The complete
        // removal plan must remain owned by that same principal so a container
        // can never recursively destroy another owner's contents.
        const requestedOwnerIDs = new Set(
          requestedItems.map((item) => this._normalizeInventoryId(
            item && item.ownerID,
            0,
          )),
        );
        if (requestedOwnerIDs.size !== 1) {
          return { success: false, errorMsg: CANNOT_TRASH_ERROR };
        }
        const [authorizedOwnerID] = requestedOwnerIDs;
        if (
          authorizedOwnerID <= 0 ||
          orderedRemovalItems.some((item) => (
            this._normalizeInventoryId(item && item.ownerID, 0) !== authorizedOwnerID ||
            this._isPersistedSpaceInventoryRecord(item) ||
            (
              this._isAuditLogSecureContainerRecord(item) &&
              this._normalizeSecureContainerAuditLog(
                this._readSecureContainerState(item),
              ).length > 0
            )
          ))
        ) {
          return { success: false, errorMsg: CANNOT_TRASH_ERROR };
        }
        if (
          requestedItems.some((item) =>
            !this._isInventoryItemTrashable(
              session,
              item,
              requestedLocationID,
            ),
          )
        ) {
          return { success: false, errorMsg: CANNOT_TRASH_ERROR };
        }
        for (const item of requestedItems) {
          this._ensureAuditContainerItemUnlocked(item);
          this._ensureSecureContainerGeneralAccess(session, item.itemID);
        }
        return { success: true };
      },
    });
    if (!removeResult.success) {
      log.warn(
        `[InvBroker] TrashItems bulk rejected key=${commandIdentity.receiptKey} ` +
        `requested=${commandIdentity.canonicalItemIDs.length} ` +
        `error=${removeResult.errorMsg || "UNKNOWN"}`,
      );
      return [CANNOT_TRASH_ERROR];
    }

    const resultData = removeResult.data || {};
    if (removeResult.duplicate === true) {
      log.info(
        `[InvBroker] TrashItems bulk replay key=${commandIdentity.receiptKey} ` +
        `requested=${Number(resultData.requestedCount) || 0} ` +
        `removed=${Number(resultData.removedCount) || 0}`,
      );
      return null;
    }

    const allChanges = Array.isArray(resultData.changes)
      ? resultData.changes
      : [];
    this._emitInventoryMoveChanges(session, allChanges, {
      emitItemsChangedBatch: true,
      emitCfgLocation: true,
      maxRowsPerNotification: TRASH_MANY_NOTIFICATION_ROW_LIMIT,
    });
    this._refreshBallparkShipPresentation(session, allChanges);
    this._refreshBallparkInventoryPresentation(session, allChanges);

    const timings = resultData.timings || {};
    log.info(
      `[InvBroker] TrashItems bulk committed key=${commandIdentity.receiptKey} ` +
      `requested=${Number(resultData.requestedCount) || 0} ` +
      `removed=${Number(resultData.removedCount) || 0} ` +
      `projectionVersion=${Number(resultData.mutationVersion) || 0} ` +
      `planningMs=${Number(timings.planningMs || 0).toFixed(2)} ` +
      `commitMs=${Number(timings.commitMs || 0).toFixed(2)} ` +
      `totalMs=${Number(timings.totalMs || 0).toFixed(2)}`,
    );
    return null;
  },

  Handle_TakeOutTrash(args, session, kwargs) {
    this._traceInventory("TakeOutTrash", session, { args, kwargs });
    log.debug("[InvBroker] TakeOutTrash");
    return null;
  },
};
