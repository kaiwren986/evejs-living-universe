"use strict";

// Secure containers in the inventory broker (invbroker): setting, checking and recovering a
// container's passwords (HasExistingPasswordSet, SetPassword, RetrievePassword, EnterPassword)
// and an audit log container's configuration, item locks and log (the ALSC calls). These are
// InvBrokerService methods, moved here as they were; invBrokerService.js puts them back on the
// class prototype, so `this` is the service. The container state and the password gate that
// ordinary item moves also use stay in invBrokerService.js.

const path = require("path");

const {
  ITEM_FLAGS,
  findItemById,
  updateInventoryItemsAtomic,
} = require(path.join(__dirname, "../itemStore"));
const {
  isSecureCargoContainerType,
  stripLegacySecureContainerStateFromCustomInfo,
  GROUP_AUDIT_LOG_SECURE_CONTAINER,
  SCC_PASSWORD_TYPE_GENERAL,
  SCC_PASSWORD_TYPE_CONFIG,
  ALSC_PASSWORD_NEEDED_TO_LOCK,
  ALSC_PASSWORD_NEEDED_TO_UNLOCK,
  ALSC_PASSWORD_NEEDED_TO_VIEW_AUDIT_LOG,
  ALSC_CONFIG_MASK,
  SECURE_CONTAINER_PASSWORD_MAX_LENGTH,
  SECURE_CONTAINER_PASSWORD_MIN_LENGTH,
} = require(path.join(__dirname, "../../ship/cargoContainerRuntime"));
const {
  buildFiletimeLong,
  buildRowset,
  normalizeBigInt,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  CORP_ROLE_DIRECTOR,
} = require(path.join(__dirname, "../../corporation/corporationRuntimeState"));
const {
  throwWrappedUserError,
} = require(path.join(
  __dirname,
  "../../../common/machoErrors",
));
const log = require(path.join(__dirname, "../../../utils/logger"));

const CORP_ROLE_EQUIPMENT_CONFIG = 2199023255552n;
const USER_ERROR_FORMAT_OWNER_ID = 2;
const ALSC_ACTION_LOCK = 7;
const ALSC_ACTION_UNLOCK = 8;
const ALSC_ACTION_SET_PASSWORD = 5;
const ALSC_ACTION_ENTER_PASSWORD = 9;
const ALSC_ACTION_CONFIGURE = 10;
const ALSC_AUDIT_LOG_HEADER = [
  "logID",
  "inventoryMgrLocationID",
  "locationID",
  "flagID",
  "actionID",
  "arg1",
  "arg2",
  "logDate",
  "actorID",
  "status",
];
const ALSC_AUDIT_LOG_ROWSET_NAME = "eve.common.script.sys.rowset.Rowset";
const ALSC_AUDIT_LOG_PAGE_SIZE = 100;

module.exports = {
  _getSecureCargoContainerRecord(containerID) {
    const numericContainerID = this._normalizeInventoryId(containerID, 0);
    if (numericContainerID <= 0) {
      return null;
    }
    const item = findItemById(numericContainerID);
    return item && isSecureCargoContainerType(item) ? item : null;
  },

  _getBoundSecureCargoContainer(session) {
    const boundContext = this._getBoundContext(session);
    return boundContext
      ? this._getSecureCargoContainerRecord(boundContext.inventoryID)
      : null;
  },

  _getBoundSecureContainerPasswordTarget(session, passwordType) {
    const boundContext = this._getBoundContext(session);
    if (!boundContext) {
      return null;
    }
    const secureChain = this._getInventoryItemAncestorChain(
      boundContext.inventoryID,
    ).filter((item) => isSecureCargoContainerType(item));
    if (secureChain.length === 0) {
      return null;
    }
    if (passwordType === SCC_PASSWORD_TYPE_CONFIG) {
      return this._getSecureCargoContainerRecord(boundContext.inventoryID);
    }
    return secureChain.find(
      (item) =>
        this._secureContainerNeedsGeneralPassword(item) &&
        !this._isSecureContainerPasswordAuthorized(
          session,
          item,
          SCC_PASSWORD_TYPE_GENERAL,
        ),
    ) || secureChain[0];
  },

  _normalizeSecureContainerPasswordType(value) {
    const passwordType = this._normalizeInventoryId(
      unwrapMarshalValue(value),
      0,
    );
    return passwordType === SCC_PASSWORD_TYPE_GENERAL ||
      passwordType === SCC_PASSWORD_TYPE_CONFIG
      ? passwordType
      : 0;
  },

  _normalizeSecureContainerPasswordText(value) {
    const unwrapped = unwrapMarshalValue(value);
    if (Buffer.isBuffer(unwrapped)) {
      return unwrapped.toString("utf8");
    }
    return unwrapped === null || unwrapped === undefined
      ? ""
      : String(unwrapped);
  },

  _authorizeSecureContainerPassword(session, item, passwordType) {
    const store = this._getSecureContainerAuthorizationStore(session, true);
    if (!store || !item) {
      return;
    }
    const state = this._readSecureContainerState(item);
    const { revisionKey } = this._getSecureContainerPasswordFields(passwordType);
    const key = this._getSecureContainerAuthorizationKey(
      item.itemID,
      passwordType,
    );
    store[key] = Number(state[revisionKey]);
  },

  _hasSecureContainerAdministrationAuthority(session, item) {
    if (!session || !item) {
      return false;
    }
    const characterID = this._normalizeInventoryId(
      this._getCharacterId(session),
      0,
    );
    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    const ownerID = this._normalizeInventoryId(item.ownerID, 0);
    if (characterID > 0 && ownerID === characterID) {
      return true;
    }
    if (corporationID <= 0 || ownerID !== corporationID) {
      return false;
    }
    const roleMask = this._getSessionCorpRoleMask(session);
    return (
      (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR ||
      (roleMask & CORP_ROLE_EQUIPMENT_CONFIG) === CORP_ROLE_EQUIPMENT_CONFIG
    );
  },

  _throwSecureContainerAdministrationDenied(session, item) {
    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    const ownerID = this._normalizeInventoryId(item && item.ownerID, 0);
    if (corporationID > 0 && ownerID === corporationID) {
      throwWrappedUserError("PermissionDeniedNeedEquipRole", {
        corp: [USER_ERROR_FORMAT_OWNER_ID, ownerID],
      });
    }
    throwWrappedUserError("ItemNotYours");
  },

  _ensureSecureContainerConfigurationAccess(session, item) {
    if (!item) {
      return;
    }
    const state = this._readSecureContainerState(item);
    if (
      state.configPassword &&
      this._isSecureContainerPasswordProtectionActive(item, state)
    ) {
      if (
        !this._isSecureContainerPasswordAuthorized(
          session,
          item,
          SCC_PASSWORD_TYPE_CONFIG,
        )
      ) {
        throwWrappedUserError("SCConfigPasswordRequired");
      }
      const corporationID = this._normalizeInventoryId(
        this._getCorporationId(session),
        0,
      );
      if (
        corporationID > 0 &&
        this._normalizeInventoryId(item.ownerID, 0) === corporationID &&
        !this._hasSecureContainerAdministrationAuthority(session, item)
      ) {
        this._throwSecureContainerAdministrationDenied(session, item);
      }
      return;
    }
    if (!this._hasSecureContainerAdministrationAuthority(session, item)) {
      this._throwSecureContainerAdministrationDenied(session, item);
    }
  },

  _ensureAuditContainerActionPassword(session, item, configFlag) {
    if (!this._isAuditLogSecureContainerRecord(item)) {
      return;
    }
    const state = this._readSecureContainerState(item);
    if (
      (state.alscConfig & configFlag) === 0 ||
      !state.generalPassword ||
      !this._isSecureContainerPasswordProtectionActive(item, state) ||
      this._isSecureContainerPasswordAuthorized(
        session,
        item,
        SCC_PASSWORD_TYPE_GENERAL,
      )
    ) {
      return;
    }
    throwWrappedUserError("SCGeneralPasswordRequired");
  },

  _ensureAuditContainerLockAuthority(session, item) {
    const corporationID = this._normalizeInventoryId(
      this._getCorporationId(session),
      0,
    );
    if (
      corporationID > 0 &&
      this._normalizeInventoryId(item && item.ownerID, 0) === corporationID &&
      !this._hasSecureContainerAdministrationAuthority(session, item)
    ) {
      this._throwSecureContainerAdministrationDenied(session, item);
    }
  },

  _setAuditContainerItemLocks(session, itemIDs, locked) {
    const container = this._getBoundSecureCargoContainer(session);
    if (!this._isAuditLogSecureContainerRecord(container)) {
      return null;
    }
    this._ensureAuditContainerActionPassword(
      session,
      container,
      locked
        ? ALSC_PASSWORD_NEEDED_TO_LOCK
        : ALSC_PASSWORD_NEEDED_TO_UNLOCK,
    );
    this._ensureAuditContainerLockAuthority(session, container);

    const targetFlagID = locked ? ITEM_FLAGS.LOCKED : ITEM_FLAGS.UNLOCKED;
    const candidates = this._normalizeItemIdList(itemIDs)
      .map((itemID) => findItemById(itemID))
      .filter(
        (item) =>
          item &&
          this._normalizeInventoryId(item.locationID, 0) ===
            this._normalizeInventoryId(container.itemID, 0) &&
          (
            locked
              ? this._normalizeInventoryId(item.flagID, 0) !== ITEM_FLAGS.LOCKED
              : this._normalizeInventoryId(item.flagID, 0) === ITEM_FLAGS.LOCKED
          ),
      );
    if (candidates.length === 0) {
      return null;
    }

    const actionID = locked ? ALSC_ACTION_LOCK : ALSC_ACTION_UNLOCK;
    const nextState = this._appendSecureContainerAuditEntriesToState(
      container,
      this._readSecureContainerState(container),
      candidates.map((item) =>
        this._buildSecureContainerAuditEntry(
          container,
          session,
          actionID,
          item.typeID,
          Math.max(1, this._getStackableQuantity(item)),
          true,
        ),
      ),
    );
    const desiredItems = new Map([
      [
        this._normalizeInventoryId(container.itemID, 0),
        {
          ...container,
          customInfo: stripLegacySecureContainerStateFromCustomInfo(
            container.customInfo,
          ),
          secureContainerState: nextState,
        },
      ],
      ...candidates.map((item) => [
        this._normalizeInventoryId(item.itemID, 0),
        { ...item, flagID: targetFlagID },
      ]),
    ]);
    const updateResult = updateInventoryItemsAtomic(
      [...desiredItems.keys()],
      (currentItem) =>
        desiredItems.get(this._normalizeInventoryId(currentItem.itemID, 0)),
    );
    if (!updateResult.success) {
      throwWrappedUserError("CustomNotify", {
        notify: `Unable to ${locked ? "lock" : "unlock"} the selected items.`,
      });
    }
    this._emitInventoryMoveChanges(
      session,
      updateResult.data && updateResult.data.changes,
    );
    return null;
  },

  Handle_HasExistingPasswordSet(args, session) {
    const passwordType = this._normalizeSecureContainerPasswordType(
      args && args.length > 0 ? args[0] : 0,
    );
    this._traceInventory("HasExistingPasswordSet", session, { passwordType });
    const item = this._getBoundSecureContainerPasswordTarget(
      session,
      passwordType,
    );
    if (!item || !passwordType) {
      return false;
    }
    const state = this._readSecureContainerState(item);
    const { passwordKey } =
      this._getSecureContainerPasswordFields(passwordType);
    return Boolean(state[passwordKey]);
  },

  Handle_SetPassword(args, session) {
    const passwordType = this._normalizeSecureContainerPasswordType(
      args && args.length > 0 ? args[0] : 0,
    );
    this._traceInventory("SetPassword", session, { passwordType });
    const item = this._getBoundSecureCargoContainer(session);
    if (!item || !passwordType) {
      return null;
    }
    if (!this._hasSecureContainerAdministrationAuthority(session, item)) {
      this._throwSecureContainerAdministrationDenied(session, item);
    }

    const oldPassword = this._normalizeSecureContainerPasswordText(
      args && args.length > 1 ? args[1] : null,
    );
    const newPassword = this._normalizeSecureContainerPasswordText(
      args && args.length > 2 ? args[2] : null,
    );
    if (newPassword.length < SECURE_CONTAINER_PASSWORD_MIN_LENGTH) {
      throwWrappedUserError("MinThreeLetters");
    }
    if (newPassword.length > SECURE_CONTAINER_PASSWORD_MAX_LENGTH) {
      throwWrappedUserError("CustomNotify", {
        notify: "Container passwords may contain at most 16 characters.",
      });
    }

    const state = this._readSecureContainerState(item);
    const {
      passwordKey,
      revisionKey,
    } = this._getSecureContainerPasswordFields(passwordType);
    if (state[passwordKey] && oldPassword !== state[passwordKey]) {
      throwWrappedUserError("CustomNotify", {
        notify: "The old container password is incorrect.",
      });
    }
    if (newPassword === state[passwordKey]) {
      this._authorizeSecureContainerPassword(session, item, passwordType);
      return null;
    }

    const updateResult = this._updateSecureContainerState(
      item.itemID,
      (currentState) => {
        const nextState = {
          ...currentState,
          [passwordKey]: newPassword,
          [revisionKey]:
            Math.max(
              0,
              Math.trunc(Number(currentState[revisionKey]) || 0),
            ) + 1,
        };
        return this._appendSecureContainerAuditEntriesToState(
          item,
          nextState,
          this._buildSecureContainerAuditEntry(
            item,
            session,
            ALSC_ACTION_SET_PASSWORD,
            passwordType,
            0,
            true,
          ),
        );
      },
    );
    if (!updateResult.success || !updateResult.data) {
      log.warn(
        `[InvBroker] SetPassword failed item=${item.itemID} ` +
        `type=${passwordType} error=${updateResult.errorMsg || "WRITE_ERROR"}`,
      );
      throwWrappedUserError("CustomNotify", {
        notify: "Unable to save the container password.",
      });
    }

    this._authorizeSecureContainerPassword(
      session,
      updateResult.data,
      passwordType,
    );
    log.debug(
      `[InvBroker] SetPassword item=${item.itemID} type=${passwordType} ` +
      `revision=${updateResult.data.secureContainerState[revisionKey]}`,
    );
    return null;
  },

  Handle_RetrievePassword(args, session) {
    const passwordType = this._normalizeSecureContainerPasswordType(
      args && args.length > 0 ? args[0] : 0,
    );
    this._traceInventory("RetrievePassword", session, { passwordType });
    const item = this._getBoundSecureCargoContainer(session);
    if (!item || !passwordType) {
      return null;
    }
    if (!this._hasSecureContainerAdministrationAuthority(session, item)) {
      this._throwSecureContainerAdministrationDenied(session, item);
    }
    const state = this._readSecureContainerState(item);
    const { passwordKey } =
      this._getSecureContainerPasswordFields(passwordType);
    return state[passwordKey] || null;
  },

  Handle_EnterPassword(args, session) {
    const passwordType = this._normalizeSecureContainerPasswordType(
      args && args.length > 0 ? args[0] : 0,
    );
    this._traceInventory("EnterPassword", session, { passwordType });
    const item = this._getBoundSecureContainerPasswordTarget(
      session,
      passwordType,
    );
    if (!item || !passwordType) {
      return false;
    }
    const providedPassword = this._normalizeSecureContainerPasswordText(
      args && args.length > 1 ? args[1] : null,
    );
    const state = this._readSecureContainerState(item);
    const { passwordKey } =
      this._getSecureContainerPasswordFields(passwordType);
    const accepted =
      !state[passwordKey] || providedPassword === state[passwordKey];
    this._appendSecureContainerAuditEntries(
      item,
      session,
      this._buildSecureContainerAuditEntry(
        item,
        session,
        ALSC_ACTION_ENTER_PASSWORD,
        passwordType,
        0,
        accepted,
      ),
    );
    if (!accepted) {
      return false;
    }
    this._authorizeSecureContainerPassword(session, item, passwordType);
    return true;
  },

  Handle_ALSCConfigGet(args, session) {
    this._traceInventory("ALSCConfigGet", session);
    const item = this._getBoundSecureCargoContainer(session);
    if (
      !item ||
      this._normalizeInventoryId(item.groupID, 0) !==
        GROUP_AUDIT_LOG_SECURE_CONTAINER
    ) {
      return 0;
    }
    this._ensureSecureContainerConfigurationAccess(session, item);
    return this._readSecureContainerState(item).alscConfig;
  },

  Handle_ALSCConfigSet(args, session) {
    const requestedConfig =
      Math.max(
        0,
        Math.trunc(
          Number(
            unwrapMarshalValue(
              args && args.length > 0 ? args[0] : 0,
            ),
          ) || 0,
        ),
      ) & ALSC_CONFIG_MASK;
    this._traceInventory("ALSCConfigSet", session, {
      config: requestedConfig,
    });
    const item = this._getBoundSecureCargoContainer(session);
    if (
      !item ||
      this._normalizeInventoryId(item.groupID, 0) !==
        GROUP_AUDIT_LOG_SECURE_CONTAINER
    ) {
      return null;
    }
    this._ensureSecureContainerConfigurationAccess(session, item);
    const currentConfig = this._readSecureContainerState(item).alscConfig;
    if (currentConfig === requestedConfig) {
      return null;
    }
    const updateResult = this._updateSecureContainerState(
      item.itemID,
      (currentState) =>
        this._appendSecureContainerAuditEntriesToState(
          item,
          {
            ...currentState,
            alscConfig: requestedConfig,
          },
          this._buildSecureContainerAuditEntry(
            item,
            session,
            ALSC_ACTION_CONFIGURE,
            currentConfig,
            requestedConfig,
            true,
          ),
        ),
    );
    if (!updateResult.success) {
      log.warn(
        `[InvBroker] ALSCConfigSet failed item=${item.itemID} ` +
        `error=${updateResult.errorMsg || "WRITE_ERROR"}`,
      );
      throwWrappedUserError("CustomNotify", {
        notify: "Unable to save the container configuration.",
      });
    }
    return null;
  },

  Handle_ALSCLockItems(args, session) {
    const itemIDs = this._normalizeItemIdList(
      args && args.length > 0 ? args[0] : [],
    );
    this._traceInventory("ALSCLockItems", session, {
      count: itemIDs.length,
    });
    return this._setAuditContainerItemLocks(session, itemIDs, true);
  },

  Handle_ALSCUnlockItems(args, session) {
    const itemIDs = this._normalizeItemIdList(
      args && args.length > 0 ? args[0] : [],
    );
    this._traceInventory("ALSCUnlockItems", session, {
      count: itemIDs.length,
    });
    return this._setAuditContainerItemLocks(session, itemIDs, false);
  },

  Handle_ALSCLogGet(args, session) {
    const container = this._getBoundSecureCargoContainer(session);
    this._traceInventory("ALSCLogGet", session);
    if (!this._isAuditLogSecureContainerRecord(container)) {
      return buildRowset(
        ALSC_AUDIT_LOG_HEADER,
        [],
        ALSC_AUDIT_LOG_ROWSET_NAME,
      );
    }
    this._ensureAuditContainerActionPassword(
      session,
      container,
      ALSC_PASSWORD_NEEDED_TO_VIEW_AUDIT_LOG,
    );

    const state = this._readSecureContainerState(container);
    const auditLog = this._normalizeSecureContainerAuditLog(state);
    this._updateSecureContainerState(
      container.itemID,
      (currentState) => ({
        ...currentState,
        auditLog,
        nextAuditLogID: Math.max(
          auditLog.reduce(
            (highest, entry) => Math.max(highest, entry.logID),
            0,
          ) + 1,
          Math.trunc(Number(currentState.nextAuditLogID) || 1),
          1,
        ),
      }),
    );

    const fromDate = normalizeBigInt(
      unwrapMarshalValue(args && args.length > 0 ? args[0] : null),
      0n,
    );
    const fromLogID = Math.max(
      0,
      Math.trunc(
        Number(
          unwrapMarshalValue(args && args.length > 1 ? args[1] : 0),
        ) || 0,
      ),
    );
    const forward =
      args && args.length > 2
        ? Boolean(unwrapMarshalValue(args[2]))
        : true;
    const filtered = auditLog.filter((entry) => {
      const entryDate = normalizeBigInt(entry.logDate, 0n);
      if (fromDate > 0n) {
        if (forward) {
          return (
            entryDate > fromDate ||
            (entryDate === fromDate && entry.logID > fromLogID)
          );
        }
        return (
          entryDate < fromDate ||
          (entryDate === fromDate && entry.logID < fromLogID)
        );
      }
      if (fromLogID <= 0) {
        return true;
      }
      return forward
        ? entry.logID >= fromLogID
        : entry.logID <= fromLogID;
    });
    filtered.sort(
      forward
        ? (left, right) => left.logID - right.logID
        : (left, right) => right.logID - left.logID,
    );
    return buildRowset(
      ALSC_AUDIT_LOG_HEADER,
      filtered.slice(0, ALSC_AUDIT_LOG_PAGE_SIZE).map((entry) => [
        entry.logID,
        entry.inventoryMgrLocationID,
        entry.locationID,
        entry.flagID,
        entry.actionID,
        entry.arg1,
        entry.arg2,
        buildFiletimeLong(entry.logDate),
        entry.actorID,
        entry.status,
      ]),
      ALSC_AUDIT_LOG_ROWSET_NAME,
    );
  },
};
