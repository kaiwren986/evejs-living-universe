"use strict";
const { getSessionCorporationRoleMask } = require("./corporationRoleChecks");
const { getPersistedCorporationAuthority } = require("./corporationAuthority");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { peekCharacterRecord } = require("../character/characterState");
const { getCorporationRecord, isNpcCorporationID } = require("./corporationState");

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildBoundObjectResponse,
  buildDbRowset,
  buildFiletimeLong,
  buildPythonSet,
  currentFileTime,
  resolveBoundNodeId,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  CORP_ROLE_CAN_RENT_OFFICE,
  CORP_ROLE_DIRECTOR,
  getCorporationRuntime,
  getCorporationOffices,
  getOfficesAtStation,
  normalizePositiveInteger,
  updateRuntimeState,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  notifyOfficeBillRefresh,
  notifyOfficeRentItemChange,
  notifyOfficeRentalChange,
  notifyOfficeUnrentItemChange,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  getStationRecord,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  listOwnedItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const { throwWrappedUserError } = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildNotEnoughMoneyUserErrorValues,
} = require(path.join(__dirname, "../account/walletState"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_SERVICE_ID,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  STRUCTURE_SETTING_ID,
} = require(path.join(__dirname, "../structure/structureServiceAuthority"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "../structure/structurePayloads"));
const {
  getProfileSettingValueForStructure,
} = require(path.join(__dirname, "../structure/structureProfilesState"));
const assetSafetyState = require(path.join(
  __dirname,
  "../structure/structureAssetSafetyState",
));
const {
  addOfficeRentalPeriod,
  cancelOfficeRentalBillsForOffice,
} = require(path.join(__dirname, "./officeRentalBilling"));
const officeImpoundReleaseState = require(path.join(
  __dirname,
  "./officeImpoundReleaseState",
));
const officeRentalSettlementState = require(path.join(
  __dirname,
  "./officeRentalSettlementState",
));

const MAX_STRUCTURE_OFFICE_RENTAL_COST = 1000000000;
const IMPOUND_RELEASE_FEE_FACTOR = 0.5;
const OFFICE_RENTAL_PERIOD_DAYS = 30;
const FILETIME_TICKS_PER_DAY = 24n * 60n * 60n * 10000000n;
const OFFICE_ROWSET_COLUMNS = [
  ["leaseID", 20],
  ["stationID", 20],
  ["rentorID", 3],
  ["startDate", 64],
  ["rentalPeriod", 2],
  ["rentalPrice", 6],
  ["billID", 3],
  ["dueDate", 64],
  ["officeID", 20],
  ["stationTypeID", 3],
  ["solarsystemID", 20],
];

function resolveCorporationID(session) {
  return (session && (session.corporationID || session.corpid)) || 0;
}

// Where the session is docked. A session in space has neither of these, and
// its locationid is the solar system, which is no place for an office.
function resolveSessionLocationID(session) {
  if (!session) {
    return null;
  }
  return normalizePositiveInteger(
    session.structureID ||
      session.structureid ||
      session.stationID ||
      session.stationid,
    null,
  );
}

function resolveBoundStationID(session, serviceManager) {
  if (!session || !serviceManager || typeof serviceManager.getBoundObjectParams !== "function") {
    return null;
  }
  const boundObjectID =
    typeof session.currentBoundObjectID === "string" ? session.currentBoundObjectID : "";
  if (!boundObjectID) {
    return null;
  }
  const boundParams = serviceManager.getBoundObjectParams(boundObjectID);
  if (Array.isArray(boundParams)) {
    return normalizePositiveInteger(boundParams[0], null);
  }
  if (boundParams && typeof boundParams === "object") {
    return normalizePositiveInteger(
      boundParams.stationID ||
        boundParams.stationid ||
        boundParams.structureID ||
        boundParams.structureid ||
        boundParams.locationID ||
        boundParams.locationid ||
        boundParams.value,
      null,
    );
  }
  return normalizePositiveInteger(boundParams, null);
}

// The place an office call acts on: the bound object's station, or the one the
// session is docked in. No argument names it. The client's RentOffice sends the
// price, GetPriceQuote the corporation and GetItemsFromImpound the quoted
// price, and it reaches another station only through an object bound to it.
function resolveStationID(session, serviceManager = null) {
  return resolveBoundStationID(session, serviceManager) || resolveSessionLocationID(session);
}

function getStructureDisplayName(structure, fallbackID) {
  return (
    (structure && (structure.itemName || structure.name)) ||
    `Structure ${normalizePositiveInteger(
      structure && structure.structureID,
      fallbackID,
    )}`
  );
}

function normalizeStructureOfficeRentalCost(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, Math.min(MAX_STRUCTURE_OFFICE_RENTAL_COST, numericValue));
}

function resolveOfficeLocationContext(session, serviceManager = null) {
  const stationID = resolveStationID(session, serviceManager);
  const stationRecord = stationID ? getStationRecord(session, stationID) : null;
  const structure =
    stationRecord && stationRecord.isStructure
      ? structureState.getStructureByID(stationRecord.structureID || stationRecord.stationID)
      : null;
  // getStationRecord answers a default station for an ID it does not know, so
  // station is null unless the ID is an NPC station's or a structure's.
  const isStationOrStructure = Boolean(structure || worldData.getStationByID(stationID));
  return {
    stationID,
    station: isStationOrStructure ? stationRecord : null,
    structure,
  };
}

// Null where there is no station or structure to quote a price for.
function getOfficeRentalCost(session, serviceManager = null) {
  const { station, structure } = resolveOfficeLocationContext(session, serviceManager);
  if (!station) {
    return null;
  }
  if (!structure) {
    return Number((station && station.officeRentalCost) || 0);
  }

  return normalizeStructureOfficeRentalCost(
    getProfileSettingValueForStructure(
      structure,
      STRUCTURE_SETTING_ID.CORP_RENT_OFFICE,
      {
        session,
        defaultValue: 0,
      },
    ),
  );
}

function ensureStructureOfficeAccess(session, structure) {
  if (!structure) {
    return;
  }
  if (characterHasStructureService(session, structure, STRUCTURE_SERVICE_ID.OFFICES)) {
    return;
  }
  throwWrappedUserError("StructureCorpOfficesDenied", {
    structureName: getStructureDisplayName(structure, structure.structureID),
  });
}

function getStructureOwnerCorporationID(structure) {
  return normalizePositiveInteger(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
}

function getStationOwnerCorporationID(stationID) {
  const station = getStationRecord(null, stationID);
  return normalizePositiveInteger(
    station && (station.corporationID || station.ownerID),
    0,
  );
}

function throwNotEnoughOfficeRentMoney(amount, balance) {
  throwWrappedUserError(
    "NotEnoughMoney",
    buildNotEnoughMoneyUserErrorValues(amount, balance),
  );
}

function getSessionCorpRoleMask(session) {
  return getSessionCorporationRoleMask(session);
}

function sessionHasDirectorRole(session) {
  if (!getPersistedCorporationAuthority(session)) return false;
  const roleMask = getSessionCorpRoleMask(session);
  return (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR;
}

function sessionCanRentOffice(session) {
  if (!getPersistedCorporationAuthority(session)) return false;
  const roleMask = getSessionCorpRoleMask(session);
  return (
    (roleMask & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR ||
    (roleMask & CORP_ROLE_CAN_RENT_OFFICE) === CORP_ROLE_CAN_RENT_OFFICE
  );
}

function ensureCanRentOffice(session) {
  if (sessionCanRentOffice(session)) {
    return;
  }
  throwWrappedUserError("CrpAccessDenied");
}

function ensureCanUnrentOffice(session) {
  if (sessionHasDirectorRole(session)) {
    return;
  }
  throwWrappedUserError("CrpAccessDenied");
}

function normalizeFileTime(value, fallback = currentFileTime()) {
  try {
    const fileTime = BigInt(String(value || fallback));
    return fileTime > 0n ? fileTime : fallback;
  } catch (_error) {
    return fallback;
  }
}

function resolveOfficeStartDate(office) {
  const explicitStartDate =
    office && (office.startDate || office.rentalStartDate || office.leaseStartDate);
  if (explicitStartDate) {
    return normalizeFileTime(explicitStartDate);
  }
  const dueDate = office && (office.dueDate || office.expiryDate);
  if (dueDate) {
    const normalizedDueDate = normalizeFileTime(dueDate, 0n);
    const periodTicks = BigInt(OFFICE_RENTAL_PERIOD_DAYS) * FILETIME_TICKS_PER_DAY;
    if (normalizedDueDate > periodTicks) {
      return normalizedDueDate - periodTicks;
    }
  }
  return currentFileTime();
}

function resolveOfficeDueDate(office, startDate) {
  const explicitDueDate = office && (office.dueDate || office.expiryDate);
  if (explicitDueDate) {
    return normalizeFileTime(explicitDueDate);
  }
  return addOfficeRentalPeriod(startDate);
}

function resolveClientOfficeID(office) {
  return normalizePositiveInteger(
    office && office.itemID,
    normalizePositiveInteger(office && office.officeID, 0),
  );
}

function buildOfficeRowset(offices) {
  return buildDbRowset(
    OFFICE_ROWSET_COLUMNS,
    offices.map((office) => {
      const startDate = resolveOfficeStartDate(office);
      const dueDate = resolveOfficeDueDate(office, startDate);
      return {
        leaseID: normalizePositiveInteger(
          office && office.leaseID,
          normalizePositiveInteger(office && office.officeID, 0),
        ),
        stationID: normalizePositiveInteger(office && office.stationID, 0),
        rentorID: normalizePositiveInteger(office && office.corporationID, 0),
        startDate: buildFiletimeLong(startDate),
        rentalPeriod: OFFICE_RENTAL_PERIOD_DAYS,
        rentalPrice: Number(office && office.rentalCost ? office.rentalCost : 0),
        billID: normalizePositiveInteger(office && office.billID, null),
        dueDate: buildFiletimeLong(dueDate),
        officeID: resolveClientOfficeID(office),
        stationTypeID: normalizePositiveInteger(
          office && (office.stationTypeID || office.typeID),
          0,
        ),
        solarsystemID: normalizePositiveInteger(office && office.solarSystemID, 0),
      };
    }),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function listStationOffices(stationID) {
  return getOfficesAtStation(stationID);
}

function isActiveOffice(office) {
  return Boolean(office) && !office.impounded;
}

function listActiveStationOffices(stationID) {
  return listStationOffices(stationID).filter(isActiveOffice);
}

function officeHasCorporationAssets(corporationID, office) {
  const officeLocationIDs = new Set([
    normalizePositiveInteger(office && office.officeID, 0),
    normalizePositiveInteger(office && office.officeFolderID, 0),
    normalizePositiveInteger(office && office.itemID, 0),
  ].filter((locationID) => locationID > 0));
  if (!corporationID || officeLocationIDs.size === 0) {
    return false;
  }

  const items = listOwnedItems(corporationID);
  const itemByID = new Map(
    items
      .map((item) => [normalizePositiveInteger(item && item.itemID, 0), item])
      .filter(([itemID]) => itemID > 0),
  );
  for (const item of items) {
    let locationID = normalizePositiveInteger(item && item.locationID, 0);
    const visited = new Set();
    while (locationID > 0 && !visited.has(locationID)) {
      if (officeLocationIDs.has(locationID)) {
        return true;
      }
      visited.add(locationID);
      const parent = itemByID.get(locationID);
      locationID = normalizePositiveInteger(parent && parent.locationID, 0);
    }
  }
  return false;
}

function getStationOfficeRentalCost(stationID) {
  const station = getStationRecord(null, stationID);
  return Number((station && station.officeRentalCost) || 0);
}

function getImpoundReleasePriceForStation(stationID) {
  return Math.max(0, getStationOfficeRentalCost(stationID) * IMPOUND_RELEASE_FEE_FACTOR);
}

function queueOfficeBillRefresh(session, corporationID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, 0);
  if (!session || !numericCorporationID) {
    return;
  }
  if (!session._pendingOfficeBillRefreshCorporationIDs) {
    session._pendingOfficeBillRefreshCorporationIDs = new Set();
  }
  session._pendingOfficeBillRefreshCorporationIDs.add(numericCorporationID);
}

class OfficeManagerService extends BaseService {
  constructor() {
    super("officeManager");
  }

  Handle_MachoResolveObject() {
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session, kwargs) {
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetMyCorporationsOffices(args, session) {
    const corporationID = resolveCorporationID(session);
    if (!getPersistedCorporationAuthority(session)) {
      const character = peekCharacterRecord(resolveSessionCharacterID(session));
      const corporation = getCorporationRecord(corporationID);
      // Personal inventory loads this collection for NPC pilots too. They
      // have no player-corporation office access, but still need an empty tree.
      if (
        character && !character.isDeleted && !character.deletedAt &&
        corporation && !corporation.deleted && isNpcCorporationID(corporationID) &&
        Number(character.corporationID) === Number(corporationID)
      ) {
        return buildOfficeRowset([]);
      }
      throwWrappedUserError("CrpAccessDenied");
    }
    const offices = getCorporationOffices(corporationID).filter(isActiveOffice);
    log.debug(`[OfficeManager] GetMyCorporationsOffices(${corporationID}) -> ${offices.length}`);
    return buildOfficeRowset(offices);
  }

  Handle_GetCorporationsWithOffices(args, session) {
    const stationID = resolveStationID(session, this.serviceManager);
    return buildPythonSet(listActiveStationOffices(stationID).map((office) => office.corporationID));
  }

  Handle_PrimeOfficeItem(args, session) {
    return null;
  }

  Handle_GetPriceQuote(args, session) {
    const cost = getOfficeRentalCost(session, this.serviceManager);
    // Tranquility's price is a Python long: its answer in the recording of an
    // office rented is the long 100113, and the client hands that long back
    // to RentOffice. It is made this server's wire long, which the marshaller
    // sends as a long and the web gateway hands on with its type (a bare
    // BigInt goes through the gateway as a string of digits). Where there is
    // no station there is no price, as before.
    return Number.isSafeInteger(cost) ? { type: "long", value: BigInt(cost) } : cost;
  }

  async Handle_RentOffice(args, session) {
    const corporationID = resolveCorporationID(session);
    const { stationID, station, structure } = resolveOfficeLocationContext(
      session,
      this.serviceManager,
    );
    // No office is rented where there is no NPC station and no structure.
    if (!corporationID || !stationID || !station) {
      return false;
    }
    ensureCanRentOffice(session);
    const corporationRuntime = getCorporationRuntime(corporationID);
    if (!corporationRuntime) {
      return false;
    }
    const existingOfficeAtLocation = Object.values(corporationRuntime.offices || {}).find(
      (office) => Number(office.stationID) === Number(stationID) && isActiveOffice(office),
    );
    if (
      existingOfficeAtLocation &&
      !officeRentalSettlementState.hasPendingOfficeRental(corporationID, stationID)
    ) {
      return false;
    }
    ensureStructureOfficeAccess(session, structure);
    const rentalCost = getOfficeRentalCost(session, this.serviceManager);
    const ownerCorporationID = structure
      ? getStructureOwnerCorporationID(structure)
      : getStationOwnerCorporationID(stationID);
    const rentResult = await officeRentalSettlementState.rentCorporationOffice({
      corporationID,
      stationID,
      ownerCorporationID,
      rentalCost,
      solarSystemID: normalizePositiveInteger(station && station.solarSystemID, null),
      stationTypeID: normalizePositiveInteger(station && station.stationTypeID, null),
    });
    if (!rentResult || rentResult.success !== true) {
      if (rentResult && rentResult.errorMsg === "INSUFFICIENT_FUNDS") {
        const balance =
          rentResult.data && rentResult.data.balance !== undefined
            ? rentResult.data.balance
            : 0;
        throwNotEnoughOfficeRentMoney(rentalCost, balance);
      }
      throwWrappedUserError("CustomNotify", {
        notify: "Office rental settlement is pending. Please try again shortly.",
      });
    }
    if (rentResult.alreadyRented || !rentResult.data || !rentResult.data.office) {
      return false;
    }
    const changedOffice = rentResult.data.office;
    notifyOfficeRentItemChange(corporationID, changedOffice);
    notifyOfficeRentalChange(corporationID, changedOffice);
    queueOfficeBillRefresh(session, corporationID);
    // Tranquility answers a rent None, after its two notices of the office.
    // (What it answers where nothing is rented is in no recording: the False
    // of the ways out above is this server's own.)
    return null;
  }

  Handle_UnrentOffice(args, session) {
    const corporationID = resolveCorporationID(session);
    const { stationID, structure } = resolveOfficeLocationContext(session, this.serviceManager);
    if (!corporationID || !stationID) {
      return null;
    }
    ensureCanUnrentOffice(session);
    const changedOffices = [];
    updateRuntimeState((runtimeTable) => {
      const corporationRuntime = runtimeTable.corporations[String(corporationID)];
      if (!corporationRuntime || !corporationRuntime.offices) {
        return runtimeTable;
      }
      for (const [officeID, office] of Object.entries(corporationRuntime.offices)) {
        if (Number(office.stationID) === Number(stationID) && isActiveOffice(office)) {
          const officeSnapshot = { ...office };
          if (structure) {
            const safetyResult = assetSafetyState.moveCorporationOfficeAssetsToSafety(
              corporationID,
              structure,
              office,
              { session },
            );
            if (!safetyResult.success) {
              log.warn(
                `[OfficeManager] Structure office asset-safety handoff failed corporation=${corporationID} office=${officeID}: ${safetyResult.errorMsg}`,
              );
              continue;
            }
          } else if (officeHasCorporationAssets(corporationID, office)) {
            office.impounded = true;
            const impoundedAt = String(currentFileTime());
            office.expiryDate = impoundedAt;
            office.dueDate = impoundedAt;
            changedOffices.push({
              office: officeSnapshot,
              emitUnrentItemChange: false,
            });
            continue;
          }
          changedOffices.push({
            office: officeSnapshot,
            emitUnrentItemChange: !structure,
          });
          delete corporationRuntime.offices[officeID];
        }
      }
      return runtimeTable;
    });
    for (const change of changedOffices) {
      if (change.emitUnrentItemChange) {
        notifyOfficeUnrentItemChange(corporationID, change.office);
      }
      notifyOfficeRentalChange(corporationID, change.office);
      cancelOfficeRentalBillsForOffice(corporationID, change.office.stationID);
      queueOfficeBillRefresh(session, corporationID);
    }
    return null;
  }

  Handle_GetEmptyOfficeCount(args, session) {
    const { stationID, structure } = resolveOfficeLocationContext(session, this.serviceManager);
    if (structure) {
      return null;
    }
    return Math.max(0, 24 - listActiveStationOffices(stationID).length);
  }

  Handle_HasCorpImpoundedItems(args, session) {
    if (!getPersistedCorporationAuthority(session)) throwWrappedUserError("CrpAccessDenied");
    const corporationID = resolveCorporationID(session);
    const stationID = resolveStationID(session, this.serviceManager);
    const offices = getCorporationOffices(corporationID);
    if (offices.some((office) => Number(office.stationID) === Number(stationID) && isActiveOffice(office))) {
      return false;
    }
    return offices.some(
      (office) =>
        Number(office.stationID) === Number(stationID) && Boolean(office.impounded),
    );
  }

  Handle_GetImpoundReleasePrice(args, session) {
    if (!getPersistedCorporationAuthority(session)) throwWrappedUserError("CrpAccessDenied");
    const corporationID = resolveCorporationID(session);
    const stationID = resolveStationID(session, this.serviceManager);
    const office = getCorporationOffices(corporationID).find(
      (entry) =>
        Number(entry.stationID) === Number(stationID) && Boolean(entry.impounded),
    );
    return office ? getImpoundReleasePriceForStation(stationID) : 0;
  }

  async Handle_GetItemsFromImpound(args, session) {
    ensureCanUnrentOffice(session);
    const corporationID = resolveCorporationID(session);
    const stationID = resolveStationID(session, this.serviceManager);
    const releasePrice = getImpoundReleasePriceForStation(stationID);
    const hasImpoundedOffice = getCorporationOffices(corporationID).some(
      (office) =>
        Number(office.stationID) === Number(stationID) && Boolean(office.impounded),
    );
    if (!hasImpoundedOffice) {
      return null;
    }
    const releaseResult = await officeImpoundReleaseState.releaseImpoundedOfficeAssets(
      corporationID,
      stationID,
      releasePrice,
    );
    if (!releaseResult || releaseResult.success !== true) {
      const balance =
        releaseResult &&
        releaseResult.data &&
        releaseResult.data.balance !== undefined
          ? releaseResult.data.balance
          : 0;
      throwNotEnoughOfficeRentMoney(releasePrice, balance);
    }
    return null;
  }

  Handle_TrashImpoundedOffice(args, session) {
    ensureCanUnrentOffice(session);
    const corporationID = resolveCorporationID(session);
    const stationID = resolveStationID(session, this.serviceManager);
    if (officeImpoundReleaseState.hasPendingImpoundRelease(corporationID, stationID)) {
      return null;
    }
    const removedOffices = [];
    updateRuntimeState((runtimeTable) => {
      const corporationRuntime = runtimeTable.corporations[String(corporationID)];
      if (!corporationRuntime || !corporationRuntime.offices) {
        return runtimeTable;
      }
      for (const [officeID, office] of Object.entries(corporationRuntime.offices)) {
        if (Number(office.stationID) === Number(stationID) && office.impounded) {
          removedOffices.push({ ...office });
          delete corporationRuntime.offices[officeID];
        }
      }
      return runtimeTable;
    });
    for (const office of removedOffices) {
      notifyOfficeRentalChange(corporationID, office);
    }
    return null;
  }

  afterCallResponse(method, session) {
    if ((method !== "RentOffice" && method !== "UnrentOffice") || !session) {
      return;
    }
    const pendingRefreshes = session._pendingOfficeBillRefreshCorporationIDs;
    if (!pendingRefreshes) {
      return;
    }
    session._pendingOfficeBillRefreshCorporationIDs = null;
    for (const corporationID of pendingRefreshes) {
      notifyOfficeBillRefresh(corporationID);
    }
  }
}

module.exports = OfficeManagerService;
