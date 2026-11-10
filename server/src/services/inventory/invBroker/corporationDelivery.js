"use strict";

// Corporation delivery in the inventory broker (invbroker): delivering items from a station
// hangar into a corporation office's hangar division (DeliverToCorpHangar) and handing items
// from a corporation hangar to a corporation member (DeliverToCorpMember). These are
// InvBrokerService methods, moved here as they were; invBrokerService.js puts them back on the
// class prototype, so `this` is the service. The item move, custody and access checks they use
// stay in invBrokerService.js.

const path = require("path");

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
  buildCrpAccessDeniedInsufficientRolesValues,
} = require(path.join(__dirname, "../../structure/structureServiceAuthority"));
const {
  getCorporationMember,
} = require(path.join(__dirname, "../../corporation/corporationRuntimeState"));
const {
  ITEM_FLAGS,
} = require(path.join(__dirname, "../itemStore"));
const {
  canTakeFromCorporationHangarForInventory,
} = require(path.join(__dirname, "./corporationHangarTakeAccess"));
const deliveryItemCustody = require(path.join(__dirname, "../deliveryItemCustody"));
const itemCustody = require(path.join(__dirname, "../itemCustody"));
const {
  buildOwnerTransferIdempotencyKey,
} = require(path.join(__dirname, "./ownerTransferIdempotencyKey"));

module.exports = {
  _resolveCorporationOfficeForInventory(session, officeOrLocationID = null) {
    return (
      this._getCorporationOffice(session, officeOrLocationID) ||
      this._getCorporationOfficeAtLocation(session, officeOrLocationID)
    );
  },

  _isMarshalListLike(value) {
    return (
      Array.isArray(value) ||
      Boolean(value && value.type === "list" && Array.isArray(value.items))
    );
  },

  Handle_DeliverToCorpHangar(args, session, kwargs) {
    this._traceInventory("DeliverToCorpHangar", session, { args, kwargs });
    const boundContext = this._getBoundContext(session);
    const rawArgs = Array.isArray(args) ? args : [];
    const hasClientCallShape =
      rawArgs.length >= 6 ||
      (
        rawArgs.length >= 3 &&
        this._isMarshalListLike(rawArgs[2]) &&
        !this._isMarshalListLike(rawArgs[0])
      );
    const rawItemIDs =
      this._extractKwarg(kwargs, "itemIDs") ??
      this._extractKwarg(kwargs, "items") ??
      (hasClientCallShape ? rawArgs[2] : rawArgs.length > 0 ? rawArgs[0] : args);
    const itemIDs = this._normalizeItemIdList(rawItemIDs);
    const officeOrLocationID =
      this._extractKwarg(kwargs, "officeID") ??
      this._extractKwarg(kwargs, "locationID") ??
      (hasClientCallShape
        ? rawArgs[1]
        : rawArgs.length > 1
          ? rawArgs[1]
          : null) ??
      (boundContext && boundContext.inventoryID);
    const corporationOffice = this._resolveCorporationOfficeForInventory(
      session,
      officeOrLocationID,
    );
    const explicitFlag =
      this._extractKwarg(kwargs, "flag") ??
      this._extractKwarg(kwargs, "divisionFlag") ??
      (hasClientCallShape
        ? rawArgs[5]
        : rawArgs.length > 2
          ? rawArgs[2]
          : null) ??
      (boundContext && boundContext.flagID);
    const destinationFlag = this._isCorporationHangarFlag(explicitFlag)
      ? this._normalizeInventoryId(explicitFlag, 0)
      : 115;
    const moveQuantity = this._normalizeQuantityArg(
      this._extractKwarg(kwargs, "qty") ??
        this._extractKwarg(kwargs, "quantity") ??
        (hasClientCallShape ? rawArgs[3] : null),
    );
    let sourceLocationID = this._normalizeInventoryId(
      this._extractKwarg(kwargs, "sourceLocationID") ??
        this._extractKwarg(kwargs, "fromLocationID") ??
        this._extractKwarg(kwargs, "stationID") ??
        (hasClientCallShape
          ? rawArgs[0]
          : rawArgs.length > 1
            ? rawArgs[1]
            : null) ??
        this._getStationId(session),
      this._getStationId(session),
    );
    const allChanges = [];
    let movedCount = 0;
    // Same defect MultiAdd carried before 1c4465b2: the move loop below used to
    // `continue` past a failed hand-off with nothing recorded, so a delivery
    // that dropped every item still answered a successful empty response.
    // Record each skip here and report the batch once, below.
    const skipReasons = [];
    let firstSkip = null;
    const recordSkip = (skippedItemID, reason, context = {}) => {
      const skipErrorMsg = context.errorMsg ? String(context.errorMsg) : "";
      skipReasons.push(
        `${skippedItemID}:${reason}${skipErrorMsg ? `(${skipErrorMsg})` : ""}`,
      );
      firstSkip = firstSkip || {
        itemID: skippedItemID,
        reason,
        errorMsg: skipErrorMsg,
        item: context.item || null,
      };
    };

    log.debug(
      `[InvBroker] DeliverToCorpHangar itemCount=${itemIDs.length} officeOrLocationID=${String(officeOrLocationID)} flag=${destinationFlag}`,
    );

    if (!corporationOffice || itemIDs.length === 0) {
      return null;
    }
    if (
      sourceLocationID ===
      this._normalizeInventoryId(corporationOffice.officeID, 0)
    ) {
      sourceLocationID = this._getStationId(session);
    }
    const currentDockedLocationID = this._normalizeInventoryId(
      this._getStationId(session),
      0,
    );
    const currentCorporationOffice = this._getCorporationOfficeAtLocation(
      session,
      currentDockedLocationID,
    );
    if (
      !isDockedSession(session) ||
      currentDockedLocationID <= 0 ||
      this._normalizeInventoryId(corporationOffice.stationID, 0) !==
        currentDockedLocationID ||
      !currentCorporationOffice ||
      this._normalizeInventoryId(currentCorporationOffice.officeID, 0) !==
        this._normalizeInventoryId(corporationOffice.officeID, 0) ||
      sourceLocationID !== currentDockedLocationID
    ) {
      log.debug(
        `[InvBroker] DeliverToCorpHangar rejected office=${corporationOffice.officeID} source=${sourceLocationID} current=${currentDockedLocationID} error=REMOTE_LOCATION`,
      );
      return null;
    }
    if (
      this._isPendingStructureUnanchorContainerInventoryID(sourceLocationID) ||
      itemIDs.some((itemID) =>
        this._isPendingStructureUnanchorContainerInventoryID(itemID),
      )
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }

    const preparedSources = [];
    for (const itemID of itemIDs) {
      const sourceItemDescriptor = this._findTransferSourceItem(
        itemID,
        sourceLocationID,
      );
      const sourceItem = sourceItemDescriptor && sourceItemDescriptor.item;
      if (!sourceItem) {
        return null;
      }
      this._ensureAuditContainerItemUnlocked(sourceItem);
      this._ensureSecureContainerGeneralAccess(session, sourceItem.locationID);
      if (this._getPendingStructureUnanchorContainerAncestor(sourceItem)) {
        this._throwPendingStructureUnanchorContainerInventoryError();
      }
      const sourceAccess = this._validateDeclaredTransferSourceAccess(
        session,
        sourceItemDescriptor,
        sourceLocationID,
        corporationOffice.officeID,
      );
      if (!sourceAccess.success) {
        log.debug(
          `[InvBroker] DeliverToCorpHangar rejected itemID=${itemID} container=${sourceAccess.containerID || 0} error=${sourceAccess.errorMsg}`,
        );
        if (
          sourceAccess.errorMsg === "CONTAINER_NOT_VISIBLE" ||
          sourceAccess.errorMsg === "CONTAINER_TOO_FAR" ||
          String(sourceAccess.errorMsg || "").startsWith("ABYSSAL_REWARD_")
        ) {
          this._throwSpaceContainerScopeAccessError(sourceAccess.errorMsg);
        }
        return null;
      }
      if (
        this._resolveInventoryRootLocationID(sourceItem) !==
          currentDockedLocationID ||
        !this._canTakeFromCorporationHangarSourceAncestry(
          session,
          sourceItemDescriptor,
        )
      ) {
        return null;
      }
      const sourceOwnerID = this._normalizeInventoryId(sourceItem.ownerID, 0);
      if (
        sourceOwnerID !== this._normalizeInventoryId(this._getCharacterId(session), 0) &&
        sourceOwnerID !== this._normalizeInventoryId(this._getCorporationId(session), 0)
      ) {
        return null;
      }
      // The custody check leaves a fleet hangar or ship maintenance bay that
      // holds the item directly to this check, the one Add and FitFitting make.
      const shipServiceAccess = this._validateShipServiceTransferAccess(
        session,
        sourceItem,
        {
          locationID: corporationOffice.officeID,
          flagID: destinationFlag,
        },
      );
      if (!shipServiceAccess.success) {
        log.debug(
          `[InvBroker] DeliverToCorpHangar rejected itemID=${itemID} shipService=${shipServiceAccess.shipID} error=${shipServiceAccess.errorMsg}`,
        );
        this._throwShipServiceAccessError(shipServiceAccess.errorMsg);
      }
      preparedSources.push({ itemID, sourceItemDescriptor });
    }

    const destinationOfficeID = this._normalizeInventoryId(
      corporationOffice.officeID,
      0,
    );
    try {
      for (const { itemID, sourceItemDescriptor } of preparedSources) {
        const moveResult = this._moveSourceItemToDestination(
          session,
          sourceItemDescriptor,
          {
            locationID: destinationOfficeID,
            flagID: destinationFlag,
          },
          moveQuantity,
        );
        if (!moveResult.success) {
          // Parity with Handle_Add and MultiAdd, which warn on this exact
          // condition. A custody refusal here is invisible otherwise.
          log.warn(
            `[InvBroker] DeliverToCorpHangar move failed itemID=${itemID} destination=${destinationOfficeID}:${destinationFlag} error=${moveResult.errorMsg}`,
          );
          recordSkip(itemID, "MOVE_FAILED", {
            item: sourceItemDescriptor.item,
            errorMsg: moveResult.errorMsg,
          });
          continue;
        }

        movedCount += 1;
        allChanges.push(...((moveResult.data && moveResult.data.changes) || []));
      }
    } catch (error) {
      // A mid-batch UserError (move invariant, secure-container access) aborts
      // the loop, but every item already delivered above is committed to the
      // store. Publish those deltas before the error propagates, or the client
      // keeps listing them in the character hangar (175c462d).
      if (movedCount > 0) {
        this._finalizeCorpDeliveryBatch(session, allChanges, {
          rpc: "DeliverToCorpHangar",
          movedCount,
          batchSize: preparedSources.length,
          sourceLocationID,
          destinationInventoryID: destinationOfficeID,
          destinationFlagID: destinationFlag,
          aborted: true,
        });
      }
      throw error;
    } finally {
      // Every skip inside the loop is silent on its own. Emit one line for the
      // whole batch so a delivery that drops items still names each item and
      // why. In a finally so a mid-loop UserError does not discard the reasons
      // collected for the items ahead of it.
      if (skipReasons.length > 0) {
        log.warn(
          `[InvBroker] DeliverToCorpHangar skipped ${skipReasons.length}/${preparedSources.length} moved=${movedCount} source=${sourceLocationID} office=${destinationOfficeID} flag=${destinationFlag} reasons=[${skipReasons.join(", ")}]`,
        );
      }
    }

    if (movedCount <= 0) {
      // Reaching `return null` here answers CallRsp(None) — a successful empty
      // response the client discards without showing anything, so a delivery
      // that moved nothing looked to the player like it worked.
      this._throwCorpDeliveryZeroMoveUserError(
        firstSkip,
        "None of the selected items could be delivered to the corporation hangar.",
      );
      return null;
    }

    this._finalizeCorpDeliveryBatch(session, allChanges, {
      rpc: "DeliverToCorpHangar",
      movedCount,
      batchSize: preparedSources.length,
      sourceLocationID,
      destinationInventoryID: destinationOfficeID,
      destinationFlagID: destinationFlag,
    });
    return true;
  },

  // Publishes everything a corp-delivery batch has already committed. The batch
  // persists each item as it goes, so this must also run when it is cut short by
  // a UserError. Same contract as _finalizeMultiAddBatch.
  _finalizeCorpDeliveryBatch(session, allChanges, context = {}) {
    const normalizedChanges = Array.isArray(allChanges) ? allChanges : [];
    const rowDeltaCount = normalizedChanges.filter(
      (change) => change && change.item,
    ).length;
    const movedCount = Number(context.movedCount) || 0;
    if (movedCount > 0 && rowDeltaCount <= 0) {
      // Invariant: a counted delivery owes the client at least one row delta.
      // Reaching here means the batch mutated the store and told nobody, which
      // is indistinguishable from a dead menu click in the UI. Warn (never
      // debug) — this is the signature of a move that silently did nothing.
      log.warn(
        `[InvBroker] ${context.rpc || "CorpDelivery"} emitted no client change despite moved=${movedCount}/${Number(context.batchSize) || 0} ` +
          `source=${context.sourceLocationID} destination=${context.destinationInventoryID}:${String(context.destinationFlagID)} ` +
          `changes=${normalizedChanges.length} ` +
          `reason=${normalizedChanges.length > 0 ? "no-row-delta (items already at destination?)" : "empty-change-list"}` +
          `${context.aborted ? " aborted=true" : ""}`,
      );
    }
    this._emitInventoryMoveChanges(session, normalizedChanges);
    this._refreshBallparkShipPresentation(session, normalizedChanges);
    this._refreshBallparkInventoryPresentation(session, normalizedChanges);
    return rowDeltaCount;
  },

  // A corp delivery that moved nothing must not answer a successful empty
  // response. Retail has no delivery-specific UserError — the client ignores
  // both RPCs' return values entirely and only shows a failure when the call
  // raises (DeliverToCorpHangarFolder / _DeliverToCorpMemberID in
  // invItemFunctions.py) — so raise whichever dedicated error names the
  // blocking condition, and a plain notify for the ones that have none. Same
  // contract as _throwMultiAddZeroMoveUserError.
  _throwCorpDeliveryZeroMoveUserError(firstSkip, notify) {
    const reason = String((firstSkip && firstSkip.reason) || "");
    const errorMsg = String((firstSkip && firstSkip.errorMsg) || "");

    if (reason === "CORP_HANGAR_TAKE_DENIED") {
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }
    if (errorMsg === "UNANCHORED_STRUCTURE_HULL_REQUIRES_SCOOP") {
      this._throwUnanchoredStructureHullInventoryError();
    }
    if (errorMsg === "STRUCTURE_UNANCHOR_CONTAINER_PENDING") {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }

    throwWrappedUserError("CustomNotify", { notify });
  },

  // Retail's "Deliver corp stuff to -> Corporation member / Myself" menu
  // (menusvc.py OfferDeliverToCorp -> invItemFunctions._DeliverToCorpMemberID):
  //   DeliverToCorpMember(corporationMemberID, stationID, itemIDs, qty,
  //                       ownerID, flagID)
  // Two asymmetries with DeliverToCorpHangar are load-bearing: argument one is
  // the TARGET character (session.charid for "Myself"), and argument six is the
  // SOURCE flag, not a destination division. The client sends no source location
  // at all, so it is derived from (ownerID, stationID, flagID) below. The client
  // discards the return value and surfaces a failure only when the call raises,
  // so every refusal here throws.
  Handle_DeliverToCorpMember(args, session, kwargs) {
    this._traceInventory("DeliverToCorpMember", session, { args, kwargs });
    const rawArgs = Array.isArray(args) ? args : [];
    const targetCharacterID = this._normalizeInventoryId(
      this._extractKwarg(kwargs, "characterID") ??
        this._extractKwarg(kwargs, "memberID") ??
        (rawArgs.length > 0 ? rawArgs[0] : null),
      0,
    );
    const stationID = this._normalizeInventoryId(
      this._extractKwarg(kwargs, "stationID") ??
        this._extractKwarg(kwargs, "locationID") ??
        (rawArgs.length > 1 ? rawArgs[1] : null),
      0,
    );
    const itemIDs = this._normalizeItemIdList(
      this._extractKwarg(kwargs, "itemIDs") ??
        this._extractKwarg(kwargs, "items") ??
        (rawArgs.length > 2 ? rawArgs[2] : null),
    );
    const moveQuantity = this._normalizeQuantityArg(
      this._extractKwarg(kwargs, "qty") ??
        this._extractKwarg(kwargs, "quantity") ??
        (rawArgs.length > 3 ? rawArgs[3] : null),
    );
    const declaredOwnerID = this._normalizeInventoryId(
      this._extractKwarg(kwargs, "ownerID") ??
        (rawArgs.length > 4 ? rawArgs[4] : null),
      0,
    );
    const sourceFlagID = this._normalizeInventoryId(
      this._extractKwarg(kwargs, "flag") ??
        this._extractKwarg(kwargs, "flagID") ??
        (rawArgs.length > 5 ? rawArgs[5] : null),
      0,
    );
    const characterID = this._normalizeInventoryId(
      this._getCharacterId(session),
      0,
    );
    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    const dockedLocationID = this._normalizeInventoryId(
      this._getStationId(session),
      0,
    );

    log.debug(
      `[InvBroker] DeliverToCorpMember itemCount=${itemIDs.length} target=${targetCharacterID} station=${stationID} owner=${declaredOwnerID} sourceFlag=${sourceFlagID}`,
    );

    if (itemIDs.length === 0) {
      return null;
    }
    if (
      !isDockedSession(session) ||
      dockedLocationID <= 0 ||
      stationID !== dockedLocationID
    ) {
      // The client raises this locally when the item has no station; a stale
      // menu that reaches the server has to answer with the same thing.
      throwWrappedUserError("CanOnlyDoInStations");
    }
    if (
      targetCharacterID <= 0 ||
      corporationID <= 0 ||
      !getCorporationMember(corporationID, targetCharacterID)
    ) {
      log.debug(
        `[InvBroker] DeliverToCorpMember rejected target=${targetCharacterID} corporation=${corporationID} error=NOT_A_CORP_MEMBER`,
      );
      throwWrappedUserError("CustomNotify", {
        notify: "That character is not a member of your corporation.",
      });
    }
    // OfferDeliverToCorp only offers this menu for corporation-owned items
    // sitting in a corp office division or in corp deliveries.
    const isCorpHangarSource = this._isCorporationHangarFlag(sourceFlagID);
    const isCorpDeliveriesSource = sourceFlagID === ITEM_FLAGS.CORP_DELIVERIES;
    if (declaredOwnerID !== corporationID || (!isCorpHangarSource && !isCorpDeliveriesSource)) {
      log.debug(
        `[InvBroker] DeliverToCorpMember rejected owner=${declaredOwnerID} sourceFlag=${sourceFlagID} error=UNSUPPORTED_SOURCE`,
      );
      throwWrappedUserError("CustomNotify", {
        notify:
          "Only corporation hangar or corporation delivery items can be delivered to a corporation member.",
      });
    }
    const corporationOffice = this._getCorporationOfficeAtLocation(
      session,
      dockedLocationID,
    );
    if (
      (isCorpHangarSource && !corporationOffice) ||
      (
        isCorpHangarSource
          ? !canTakeFromCorporationHangarForInventory(
              session,
              corporationID,
              dockedLocationID,
              sourceFlagID,
            )
          // Corp Deliveries answers to the same roles as taking from it.
          : Boolean(
              this._getInventoryCustodyAccessError(
                session,
                { locationID: dockedLocationID, flagID: sourceFlagID },
                { direction: "take" },
              ),
            )
      )
    ) {
      log.debug(
        `[InvBroker] DeliverToCorpMember rejected station=${dockedLocationID} sourceFlag=${sourceFlagID} error=CORP_HANGAR_TAKE_DENIED`,
      );
      throwWrappedUserError(
        "CrpAccessDenied",
        buildCrpAccessDeniedInsufficientRolesValues(),
      );
    }
    const sourceLocationID = isCorpHangarSource
      ? this._normalizeInventoryId(corporationOffice.officeID, 0)
      : dockedLocationID;
    if (
      this._isPendingStructureUnanchorContainerInventoryID(sourceLocationID) ||
      itemIDs.some((itemID) =>
        this._isPendingStructureUnanchorContainerInventoryID(itemID),
      )
    ) {
      this._throwPendingStructureUnanchorContainerInventoryError();
    }

    const allChanges = [];
    let movedCount = 0;
    const skipReasons = [];
    let firstSkip = null;
    const recordSkip = (skippedItemID, reason, context = {}) => {
      const skipErrorMsg = context.errorMsg ? String(context.errorMsg) : "";
      skipReasons.push(
        `${skippedItemID}:${reason}${skipErrorMsg ? `(${skipErrorMsg})` : ""}`,
      );
      firstSkip = firstSkip || {
        itemID: skippedItemID,
        reason,
        errorMsg: skipErrorMsg,
        item: context.item || null,
      };
    };

    try {
      for (const itemID of itemIDs) {
        const sourceItemDescriptor = this._findTransferSourceItem(
          itemID,
          sourceLocationID,
        );
        const sourceItem = sourceItemDescriptor && sourceItemDescriptor.item;
        if (!sourceItem) {
          recordSkip(itemID, "SOURCE_ITEM_NOT_FOUND");
          continue;
        }
        this._ensureAuditContainerItemUnlocked(sourceItem);
        this._ensureSecureContainerGeneralAccess(session, sourceItem.locationID);
        if (this._getPendingStructureUnanchorContainerAncestor(sourceItem)) {
          this._throwPendingStructureUnanchorContainerInventoryError();
        }
        const sourceAccess = this._validateDeclaredTransferSourceAccess(
          session,
          sourceItemDescriptor,
          sourceLocationID,
          sourceLocationID,
        );
        if (!sourceAccess.success) {
          recordSkip(itemID, "SOURCE_ACCESS_DENIED", {
            item: sourceItem,
            errorMsg: sourceAccess.errorMsg,
          });
          continue;
        }
        if (
          this._normalizeInventoryId(sourceItem.ownerID, 0) !== corporationID ||
          this._normalizeInventoryId(sourceItem.flagID, 0) !== sourceFlagID
        ) {
          recordSkip(itemID, "SOURCE_BUCKET_MISMATCH", { item: sourceItem });
          continue;
        }
        if (
          !this._canTakeFromCorporationHangarSourceAncestry(
            session,
            sourceItemDescriptor,
          )
        ) {
          recordSkip(itemID, "CORP_HANGAR_TAKE_DENIED", { item: sourceItem });
          continue;
        }

        const destination = {
          locationID: dockedLocationID,
          flagID: ITEM_FLAGS.HANGAR,
        };
        this._ensureItemMoveInvariant(sourceItemDescriptor, destination);
        // Always a cross-owner hand-off (corp -> member), so it rides the
        // delivery custody seam with a per-operation key — a state-derived key
        // would replay the first delivery's receipt on every later one.
        const moveResult = deliveryItemCustody.transferItem({
          item: sourceItem,
          ownerID: targetCharacterID,
          locationID: dockedLocationID,
          flagID: ITEM_FLAGS.HANGAR,
          quantity: moveQuantity,
          actor: characterID,
          reason: itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
          idempotencyKey: buildOwnerTransferIdempotencyKey(),
        });
        if (!moveResult || !moveResult.success) {
          log.warn(
            `[InvBroker] DeliverToCorpMember move failed itemID=${itemID} target=${targetCharacterID} destination=${dockedLocationID}:${ITEM_FLAGS.HANGAR} error=${moveResult && moveResult.errorMsg}`,
          );
          recordSkip(itemID, "MOVE_FAILED", {
            item: sourceItem,
            errorMsg: moveResult && moveResult.errorMsg,
          });
          continue;
        }

        movedCount += 1;
        allChanges.push(...((moveResult.data && moveResult.data.changes) || []));
      }
    } catch (error) {
      if (movedCount > 0) {
        this._finalizeCorpDeliveryBatch(session, allChanges, {
          rpc: "DeliverToCorpMember",
          movedCount,
          batchSize: itemIDs.length,
          sourceLocationID,
          destinationInventoryID: dockedLocationID,
          destinationFlagID: ITEM_FLAGS.HANGAR,
          aborted: true,
        });
      }
      throw error;
    } finally {
      if (skipReasons.length > 0) {
        log.warn(
          `[InvBroker] DeliverToCorpMember skipped ${skipReasons.length}/${itemIDs.length} moved=${movedCount} target=${targetCharacterID} source=${sourceLocationID}:${sourceFlagID} reasons=[${skipReasons.join(", ")}]`,
        );
      }
    }

    if (movedCount <= 0) {
      this._throwCorpDeliveryZeroMoveUserError(
        firstSkip,
        "None of the selected items could be delivered to that corporation member.",
      );
      return null;
    }

    this._finalizeCorpDeliveryBatch(session, allChanges, {
      rpc: "DeliverToCorpMember",
      movedCount,
      batchSize: itemIDs.length,
      sourceLocationID,
      destinationInventoryID: dockedLocationID,
      destinationFlagID: ITEM_FLAGS.HANGAR,
    });
    return true;
  },
};
