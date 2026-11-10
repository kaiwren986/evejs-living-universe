"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildBoundObjectResponse,
  buildDict,
  buildKeyVal,
  buildRow,
  buildRowset,
  extractList,
  normalizeNumber,
  resolveBoundNodeId,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  ITEM_FLAGS,
  buildRemovedItemNotificationState,
  listStarbaseItems,
  listContainerItems,
  removeInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const planetOrbitalState = require("./planetOrbitalState");
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));

const STARBASE_USAGE_COLUMNS = ["structureID", "viewput", "viewputtake", "use"];

function getStarbaseAccessRuntime() {
  return require("../starbase/starbaseAccessRuntime");
}

function requireStarbaseConfigurationResult(result) {
  if (result && result.success) return result.data;
  const code = String(result && result.errorMsg || "UNKNOWN_ERROR");
  const messages = {
    STARBASE_INVENTORY_TOO_FAR: "Move inside the active control tower shield, or within 2,500 meters of the tower, to manage it.",
    CONTAINER_NOT_VISIBLE: "You must be in space near this control tower to manage it.",
    STARBASE_INVENTORY_OFFLINE: "The control tower must be anchored before it can be managed.",
    STARBASE_PASSWORD_REQUIRED: "Enter a password for the control tower force field.",
    STARBASE_PASSWORD_INVALID: "The force field password must contain between 1 and 50 characters.",
    STARBASE_SETTINGS_INVALID: "The starbase settings contain an invalid value.",
    STARBASE_PERMISSION_INVALID: "The selected starbase access permission is invalid.",
    STARBASE_ALLIANCE_REQUIRED: "Your corporation must belong to an alliance to use alliance access or standings.",
    CONTROL_TOWER_NOT_FOUND: "The control tower could not be found.",
  };
  throwWrappedUserError("CustomNotify", {
    notify: messages[code] || formatStarbaseAnchorError(code),
  });
}

function normalizeUsageFlags(value) {
  const source = unwrapMarshalValue(value);
  const columns = extractList(source && (source.header || source.columns));
  return extractList(source).map((rawRow) => {
    const row = unwrapMarshalValue(rawRow);
    const line = Array.isArray(row) ? row : row && row.line;
    if (!Array.isArray(line)) return row;
    const header = columns.length > 0 ? columns : STARBASE_USAGE_COLUMNS;
    return Object.fromEntries(header.map((column, index) => [column, line[index]]));
  });
}

function startControlTowerAnchorTransition(
  session,
  itemID,
  effectName,
  options = {},
) {
  const item = require(path.join(__dirname, "../inventory/itemStore"))
    .findItemById(itemID);
  if (item && Number(item.categoryID) === 23 && Number(item.groupID) !== 365) {
    return require(path.join(__dirname, "../starbase/starbaseModuleRuntime"))
      .startAnchorTransition(session, itemID, effectName, options);
  }
  return require(path.join(__dirname, "../ship/controlTowerRuntime"))
    .startControlTowerAnchorTransition(session, itemID, effectName);
}

function getControlTowerMoon(itemID) {
  return require(path.join(__dirname, "../ship/controlTowerRuntime"))
    .getControlTowerMoon(itemID);
}

function formatStarbaseAnchorError(errorMsg) {
  switch (String(errorMsg || "")) {
    case "STARBASE_INDUSTRY_JOBS_ACTIVE":
      return "Cancel or deliver the assembly array's industry jobs before unanchoring it.";
    case "CONTROL_TOWER_REINFORCED":
      return "The control tower is reinforced. Wait until its reinforcement timer ends before changing its state.";
    case "CONTROL_TOWER_INCAPACITATED":
    case "MODULE_INCAPACITATED":
      return "This starbase structure is incapacitated or being destroyed and cannot change state.";
    case "CONTROL_TOWER_CHARTER_UNAVAILABLE":
      return "A control tower cannot be anchored in this system because its sovereign faction does not issue a Starbase Charter.";
    case "CONTROL_TOWER_CHARTER_REQUIRED":
      return "You must have at least one Starbase Charter for this system's sovereign faction in your active ship's cargo hold to anchor a control tower. The charter will not be consumed when anchoring.";
    case "STARBASE_PLAYER_CORPORATION_REQUIRED":
      return "Starbase structures can only be managed by members of a player corporation.";
    case "CONTROL_TOWER_OWNER_REQUIRED":
    case "STARBASE_CORPORATION_OWNER_REQUIRED":
      return "You must belong to the corporation that owns this starbase structure.";
    case "STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED":
      return "You need the Config Starbase Equipment corporation role to manage this starbase structure.";
    case "ANCHORING_SKILL_REQUIRED":
      return "You need Anchoring I to anchor or unanchor this starbase structure.";
    case "CONTROL_TOWER_MOON_REQUIRED":
      return "A control tower must be anchored near a moon.";
    case "CONTROL_TOWER_TOO_FAR_FROM_MOON":
      return "The control tower is too far from the nearest moon to be anchored.";
    case "CONTROL_TOWER_MOON_OCCUPIED":
      return "Another control tower is already anchored at this moon.";
    case "CONTROL_TOWER_HAS_DEPENDENT_MODULES":
      return "All starbase structures must be unanchored before the control tower can be unanchored.";
    case "STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM":
      return "Starbase structures cannot be anchored in this solar system.";
    case "STARBASE_SOVEREIGNTY_REQUIRED":
      return "Your alliance must hold sovereignty in this solar system to anchor this structure.";
    case "STARBASE_SOVEREIGNTY_LEVEL_REQUIRED":
      return "Your alliance's strategic sovereignty level is too low to anchor this structure.";
    case "STARBASE_SOVEREIGNTY_UPGRADE_REQUIRED":
      return "Your alliance must install the required sovereignty industry upgrade before anchoring this structure.";
    case "STARBASE_MODULE_TOO_CLOSE_TO_FORCE_FIELD":
      return "This structure is too close to the control tower force field.";
    case "STARBASE_MODULE_OUTSIDE_FORCE_FIELD":
      return "This structure must be anchored completely inside the control tower force field.";
    case "STARBASE_MODULE_TOO_FAR_FROM_CONTROL_TOWER":
    case "CONTROL_TOWER_NOT_FOUND":
      return "This structure must be placed within its control tower's permitted range.";
    case "STARBASE_MODULE_TOO_CLOSE_TO_STRUCTURE":
      return "This structure overlaps another anchored starbase structure.";
    case "STARBASE_GROUP_ANCHOR_LIMIT_REACHED":
      return "The solar system already has the maximum number of structures of this type.";
    case "STARBASE_STRUCTURE_TOO_FAR":
      return "Move within 2,500 meters of this structure, or manage it while your ship is inside the control tower force field.";
    case "TARGET_TOO_FAR":
      return "Move within 30,000 meters of the control tower before changing its anchored state.";
    default:
      return "Unable to change that starbase structure's anchored state.";
  }
}

function getCurrentBoundObjectReference(service, session) {
  const serviceName = service && service.name;
  const state =
    session &&
    session._boundObjectState &&
    serviceName &&
    session._boundObjectState[serviceName];
  if (
    !state ||
    typeof state.objectID !== "string" ||
    typeof state.boundAtFileTime !== "bigint"
  ) {
    return null;
  }
  return [state.objectID, state.boundAtFileTime];
}

function extractItemID(args) {
  const unwrapped = unwrapMarshalValue(Array.isArray(args) ? args[0] : args);
  if (Array.isArray(unwrapped)) {
    return Math.trunc(normalizeNumber(unwrapped[0], 0));
  }
  return Math.trunc(normalizeNumber(unwrapped, 0));
}

function normalizeAnchorPosition(value) {
  const unwrapped = unwrapMarshalValue(value);
  const source = Array.isArray(unwrapped)
    ? { x: unwrapped[0], y: unwrapped[1], z: unwrapped[2] }
    : unwrapped;
  if (
    !source ||
    ![source.x, source.y, source.z].every((coordinate) => (
      Number.isFinite(Number(coordinate))
    ))
  ) {
    return null;
  }
  return {
    x: Number(source.x),
    y: Number(source.y),
    z: Number(source.z),
  };
}

function extractAnchorPosition(args) {
  const unwrapped = unwrapMarshalValue(args);
  return Array.isArray(unwrapped) && unwrapped.length > 1
    ? normalizeAnchorPosition(unwrapped[1])
    : null;
}

function refreshOrbitalScene(record, session = null) {
  const systemID = Number(
    record && record.solarSystemID ||
      session && session._space && session._space.systemID ||
      session && (session.solarsystemid2 || session.solarsystemid) ||
      0,
  ) || 0;
  const itemID = Number(record && record.itemID) || 0;
  if (!systemID || !itemID) {
    return;
  }

  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(systemID, itemID);
  if (!spawnResult || !spawnResult.success) {
    log.warn(
      `[PosMgr] Failed to refresh orbital ${itemID} in system ${systemID}: ${spawnResult ? spawnResult.errorMsg : "UNKNOWN"}`,
    );
  }
}

function syncRemovedInventoryChanges(session, changes = []) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || change.removed !== true || !change.previousData) {
      continue;
    }
    const removedState = buildRemovedItemNotificationState(change.previousData);
    if (!removedState) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      removedState,
      change.previousData,
      { emitCfgLocation: true },
    );
  }
}

function consumeOrbitalUpgradeHold(itemID, session = null) {
  const contents = listContainerItems(
    null,
    itemID,
    ITEM_FLAGS.SPECIALIZED_MATERIAL_BAY,
  );
  let consumed = 0;
  for (const item of contents) {
    const removeResult = removeInventoryItem(item.itemID, { removeContents: true });
    if (!removeResult.success) {
      log.warn(
        `[PosMgr] Failed to consume upgrade material itemID=${item.itemID}: ${removeResult.errorMsg || "UNKNOWN"}`,
      );
      continue;
    }
    consumed += 1;
    syncRemovedInventoryChanges(
      session,
      removeResult.data && removeResult.data.changes,
    );
  }
  return consumed;
}

function normalizePositiveInteger(value) {
  const numericValue = normalizeNumber(value, 0);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }
  return Math.trunc(numericValue);
}

function firstPresentValue(record, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function normalizeControlTowerRow(row) {
  const unwrapped = unwrapMarshalValue(row);
  if (Array.isArray(unwrapped)) {
    const typeID = normalizePositiveInteger(unwrapped[0]);
    const structureID = normalizePositiveInteger(unwrapped[1]);
    const solarSystemID = normalizePositiveInteger(unwrapped[2]);
    return typeID && structureID && solarSystemID
      ? [typeID, structureID, solarSystemID]
      : null;
  }

  if (!unwrapped || typeof unwrapped !== "object") {
    return null;
  }

  const typeID = normalizePositiveInteger(firstPresentValue(unwrapped, [
    "typeID",
    "typeId",
    "type_id",
    "towerTypeID",
    "controlTowerTypeID",
  ]));
  const structureID = normalizePositiveInteger(firstPresentValue(unwrapped, [
    "structureID",
    "structureId",
    "structure_id",
    "itemID",
    "itemId",
    "towerID",
    "towerId",
    "controlTowerID",
  ]));
  const solarSystemID = normalizePositiveInteger(firstPresentValue(unwrapped, [
    "solarSystemID",
    "solarSystemId",
    "solar_system_id",
    "solarsystemID",
    "solarsystemid",
    "systemID",
    "systemId",
  ]));

  return typeID && structureID && solarSystemID
    ? [typeID, structureID, solarSystemID]
    : null;
}

function normalizeControlTowerRows(rows) {
  const normalizedRows = [];
  for (const row of extractList(unwrapMarshalValue(rows))) {
    const normalizedRow = normalizeControlTowerRow(row);
    if (normalizedRow) {
      normalizedRows.push(normalizedRow);
    }
  }
  return normalizedRows;
}

function listSessionControlTowerRows({ session } = {}, items = null) {
  const corporationID = normalizePositiveInteger(
    session && (session.corporationID || session.corporationid || session.corpid),
  );
  if (!corporationID) {
    return [];
  }
  const storedItems = items === null ? listStarbaseItems({ groupID: 365 }) : items;
  const sourceItems = Array.isArray(storedItems)
    ? storedItems
    : storedItems && typeof storedItems === "object"
      ? Object.values(storedItems)
      : [];
  return sourceItems
    .filter((item) => {
      const state = item && item.spaceState || {};
      const anchorState = String(state.anchorState || "").toLowerCase();
      const isAnchored = state.isAnchored === true ||
        normalizePositiveInteger(state.isAnchored) === 1;
      return normalizePositiveInteger(item && item.ownerID) === corporationID &&
        normalizePositiveInteger(item && item.categoryID) === 23 &&
        normalizePositiveInteger(item && item.groupID) === 365 &&
        normalizePositiveInteger(item && item.flagID) === 0 &&
        normalizePositiveInteger(state.systemID || item.locationID) > 0 &&
        (isAnchored || ["anchored", "anchoring", "unanchoring"].includes(anchorState));
    })
    .map((item) => [
      normalizePositiveInteger(item.typeID),
      normalizePositiveInteger(item.itemID),
      normalizePositiveInteger(item.spaceState.systemID || item.locationID),
    ])
    .sort((left, right) => left[1] - right[1]);
}

class PosMgrService extends BaseService {
  constructor(options = {}) {
    super("posMgr");
    this.controlTowerProvider = typeof options.controlTowerProvider === "function"
      ? options.controlTowerProvider
      : Array.isArray(options.controlTowers)
        ? null
        : listSessionControlTowerRows;
    this.controlTowerRows = Array.isArray(options.controlTowers)
      ? options.controlTowers
      : [];
    this.starbaseAccessRuntime = options.starbaseAccessRuntime || null;
  }

  _getStarbaseAccessRuntime() {
    return this.starbaseAccessRuntime || getStarbaseAccessRuntime();
  }

  Handle_GetTowerSentrySettings(args, session) {
    const { tower, config } = requireStarbaseConfigurationResult(
      this._getStarbaseAccessRuntime().getTowerConfiguration(session, extractItemID(args)),
    );
    const sentry = config.sentry;
    const allianceID = this._getStarbaseAccessRuntime().getTowerAllianceID(tower);
    // moonmining.py:541-542 both tuple-unpacks this Row and reads its ['line'].
    return buildRow(["standing", "status", "statusDrop", "war", "standingOwnerID"], [
      sentry.standing,
      sentry.securityStatus,
      sentry.statusDrop,
      sentry.war,
      sentry.useAllianceStandings && allianceID ? allianceID : tower.ownerID,
    ]);
  }

  Handle_SetTowerSentrySettings(args, session) {
    const [towerID, standing, securityStatus, statusDrop, war, useAllianceStandings] = unwrapMarshalValue(args);
    requireStarbaseConfigurationResult(this._getStarbaseAccessRuntime().setTowerSentrySettings(
      session, towerID, { standing, securityStatus, statusDrop, war, useAllianceStandings },
    ));
    return null;
  }

  Handle_GetTowerNotificationSettings(args, session) {
    const { config } = requireStarbaseConfigurationResult(
      this._getStarbaseAccessRuntime().getTowerConfiguration(session, extractItemID(args)),
    );
    return buildKeyVal(Object.entries(config.notifications));
  }

  Handle_SetTowerNotifications(args, session) {
    const [towerID, showInCalendar, sendFuelNotifications] = unwrapMarshalValue(args);
    requireStarbaseConfigurationResult(this._getStarbaseAccessRuntime().setTowerNotifications(
      session, towerID, { showInCalendar, sendFuelNotifications },
    ));
    return null;
  }

  async Handle_SetTowerPassword(args, session) {
    const [towerID, password, allowCorp, allowAlliance] = unwrapMarshalValue(args);
    const options = {};
    if (allowCorp !== undefined) options.allowCorp = allowCorp;
    if (allowAlliance !== undefined) options.allowAlliance = allowAlliance;
    requireStarbaseConfigurationResult(await this._getStarbaseAccessRuntime().setTowerPassword(
      session, towerID, password, options,
    ));
    // The settings are already saved. A failed force-field refresh must not
    // report the save as failed, or blame an anchoring change nobody made.
    const refresh = require("../ship/controlTowerRuntime").reconcileControlTowerForceField(towerID);
    if (!refresh || refresh.success !== true) {
      log.warn(
        `[PosMgr] SetTowerPassword saved tower=${towerID} but the force field refresh failed: ` +
        `${refresh && refresh.errorMsg || "UNKNOWN_ERROR"}`,
      );
    }
    return null;
  }

  Handle_GetStarbasePermissions(args, session) {
    const permissions = requireStarbaseConfigurationResult(
      this._getStarbaseAccessRuntime().getStarbasePermissions(session, extractItemID(args)),
    );
    // moonmining.py:703-708 requires a mapping plus a rowset supporting Index().
    return [
      buildDict(Object.entries(permissions.deployFlags)),
      buildRowset(STARBASE_USAGE_COLUMNS, permissions.usageFlags.map((row) => (
        // Rowset constructs its RowClass instances directly from each line.
        // A bare JavaScript array marshals as a Python tuple, leaving the
        // resulting util.Row immutable.  StructureAccess.ComboChange mutates
        // these rows with setattr(), so each line must be an explicit list.
        { type: "list", items: STARBASE_USAGE_COLUMNS.map((column) => row[column]) }
      ))),
    ];
  }

  Handle_SetStarbasePermissions(args, session) {
    const [towerID, deployFlags, usageFlags] = unwrapMarshalValue(args);
    requireStarbaseConfigurationResult(this._getStarbaseAccessRuntime().setStarbasePermissions(
      session, towerID, deployFlags, normalizeUsageFlags(usageFlags),
    ));
    return null;
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    void args;
    void session;
    void kwargs;
    log.debug("[PosMgr] MachoResolveObject");
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session, kwargs) {
    log.debug("[PosMgr] MachoBindObject");
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetControlTowers(args, session, kwargs) {
    void kwargs;
    let sourceRows = this.controlTowerRows;
    if (this.controlTowerProvider) {
      try {
        sourceRows = this.controlTowerProvider({ args, session, service: this });
      } catch (error) {
        log.warn(`[PosMgr] GetControlTowers provider failed: ${error.message}`);
        sourceRows = [];
      }
    }

    const rows = normalizeControlTowerRows(sourceRows);
    log.debug(`[PosMgr] GetControlTowers -> ${rows.length} row(s)`);
    return rows;
  }

  Handle_GetConsumptionFactor(args, session) {
    const itemID = extractItemID(args);
    void session;
    // The current client multiplies every static control-tower resource row by
    // this value when rendering Processes -> Fuel. EveOffline currently models
    // the standard fixed hourly burn without sovereignty fuel discounts, so
    // the neutral multiplier is authoritative for the implemented runtime.
    log.debug(
      `[PosMgr] GetConsumptionFactor itemID=${itemID || "unknown"} -> 1`,
    );
    return 1.0;
  }

  Handle_AssumeStructureControl(args, session) {
    const control = require("../starbase/starbaseControlRuntime");
    const itemID = extractItemID(args);
    control.requireStarbaseControlResult(control.assumeStructureControl(session, itemID));
    try {
      new (require("../dogma/dogmaService"))().primeControlledStarbaseBattery(session, itemID);
    } catch (error) {
      control.relinquishStructureControl(session, itemID);
      throw error;
    }
    return null;
  }

  Handle_RelinquishStructureControl(args, session) {
    const control = require("../starbase/starbaseControlRuntime");
    control.requireStarbaseControlResult(control.relinquishStructureControl(session, extractItemID(args)));
    return null;
  }

  Handle_AnchorStructure(args, session) {
    const itemID = extractItemID(args);
    const requestedPosition = extractAnchorPosition(args);
    log.info(
      `[PosMgr] AnchorStructure itemID=${itemID || "unknown"}` +
      (requestedPosition
        ? ` position=${requestedPosition.x},${requestedPosition.y},${requestedPosition.z}`
        : ""),
    );
    const result = startControlTowerAnchorTransition(
      session,
      itemID,
      "anchorDropForStructures",
      { requestedPosition },
    );
    if (!result.success) {
      log.warn(
        `[PosMgr] AnchorStructure failed itemID=${itemID}: ` +
        `${result.errorMsg || "UNKNOWN_ERROR"}`,
      );
      throwWrappedUserError("CustomNotify", {
        notify: formatStarbaseAnchorError(result.errorMsg),
      });
    }
    return result.success
      ? getCurrentBoundObjectReference(this, session)
      : null;
  }

  Handle_UnanchorStructure(args, session) {
    const itemID = extractItemID(args);
    log.info(`[PosMgr] UnanchorStructure itemID=${itemID || "unknown"}`);
    const result = startControlTowerAnchorTransition(
      session,
      itemID,
      "anchorLiftForStructures",
    );
    if (!result.success) {
      log.warn(
        `[PosMgr] UnanchorStructure failed itemID=${itemID}: ` +
        `${result.errorMsg || "UNKNOWN_ERROR"}`,
      );
      throwWrappedUserError("CustomNotify", {
        notify: formatStarbaseAnchorError(result.errorMsg),
      });
    }
    return null;
  }

  Handle_GetMoonForTower(args, session) {
    const production = require("../starbase/starbaseProductionRuntime");
    return production.requireProductionResult(production.getMoonForTower(session, extractItemID(args)));
  }

  Handle_ChangeStructureProvisionType(args, session) {
    const [towerID, itemID, provisionTypeID] = unwrapMarshalValue(args);
    const production = require("../starbase/starbaseProductionRuntime");
    production.requireProductionResult(production.changeStructureProvisionType(session, towerID, itemID, provisionTypeID));
    return null;
  }

  Handle_LinkResourceForTower(args, session) {
    const [towerID, links] = unwrapMarshalValue(args);
    const production = require("../starbase/starbaseProductionRuntime");
    production.requireProductionResult(production.linkResourceForTower(session, towerID,
      extractList(links).map((row) => extractList(row))));
    return true;
  }

  Handle_RunMoonProcessCycleforTower(args, session) {
    const production = require("../starbase/starbaseProductionRuntime");
    production.requireProductionResult(production.runProcessCycle(session, extractItemID(args)));
    return null;
  }

  Handle_GetMoonProcessInfoForTower(args, session) {
    const production = require("../starbase/starbaseProductionRuntime");
    return production.requireProductionResult(production.unavailableProcess(session, extractItemID(args)));
  }

  Handle_AnchorOrbital(args, session) {
    const itemID = extractItemID(args);
    log.info(`[PosMgr] AnchorOrbital itemID=${itemID || "unknown"}`);
    const result = planetOrbitalState.anchorOrbital(itemID, session);
    if (!result.success) {
      log.warn(
        `[PosMgr] AnchorOrbital failed itemID=${itemID}: ${result.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return null;
    }
    refreshOrbitalScene(result.data, session);
    return null;
  }

  Handle_UnanchorOrbital(args, session) {
    const itemID = extractItemID(args);
    log.info(`[PosMgr] UnanchorOrbital itemID=${itemID || "unknown"}`);
    const result = planetOrbitalState.unanchorOrbital(itemID, session);
    if (!result.success) {
      log.warn(
        `[PosMgr] UnanchorOrbital failed itemID=${itemID}: ${result.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return null;
    }
    refreshOrbitalScene(result.data, session);
    return null;
  }

  Handle_OnlineOrbital(args, session) {
    const itemID = extractItemID(args);
    log.info(`[PosMgr] OnlineOrbital itemID=${itemID || "unknown"}`);
    const result = planetOrbitalState.onlineOrbital(itemID, session);
    if (!result.success) {
      log.warn(
        `[PosMgr] OnlineOrbital failed itemID=${itemID}: ${result.errorMsg || "UNKNOWN_ERROR"}`,
      );
      return null;
    }
    const consumedCount = consumeOrbitalUpgradeHold(itemID, session);
    if (consumedCount > 0) {
      log.info(`[PosMgr] Consumed ${consumedCount} upgrade material stack(s) for orbital ${itemID}`);
    }
    refreshOrbitalScene(result.data, session);
    return null;
  }
}

PosMgrService._testing = {
  extractAnchorPosition,
  extractItemID,
  consumeOrbitalUpgradeHold,
  formatStarbaseAnchorError,
  getCurrentBoundObjectReference,
  getControlTowerMoon,
  normalizeControlTowerRow,
  normalizeControlTowerRows,
  normalizeAnchorPosition,
  listSessionControlTowerRows,
};

module.exports = PosMgrService;
