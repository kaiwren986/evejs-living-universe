"use strict";

/**
 * User Service — "userSvc"
 *
 * Handles account-level queries such as redeem tokens and reporting bots.
 */

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const database = require(path.join(__dirname, "../../gameStore"));
const {
  buildDbRowset,
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  currentFileTime,
  extractDictEntries,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const {
  DEFAULT_MCT_EXPIRY_FILETIME,
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  ITEM_FLAGS,
  getItemMetadata,
  grantItemToCharacterLocation,
  removeInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  adjustCharacterBalanceAsync,
  buildMarshalRealMoney,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  EVERMARK_ISSUER_CORP_ID,
  adjustCharacterWalletLPBalance,
} = require(path.join(__dirname, "../corporation/lpWalletState"));
const {
  notifyFreeSkillPointsChanged,
  notifyMultipleCharacterTrainingUpdated,
} = require(path.join(__dirname, "../skills/training/skillQueueNotifications"));
const {
  disconnectCharacterSession,
} = require(path.join(__dirname, "../_shared/sessionDisconnect"));
const {
  computeFutureFileTime,
  getTrainingSlotsForAccount,
  readRuntimeAccount,
  writeRuntimeAccount,
} = require(path.join(__dirname, "../newEdenStore/storeState"));

const DEFAULT_MCT_GRANT_DAYS = 30;
const OLD_ACCOUNT_CREATE_FILETIME = "132000000000000000";
const LOCAL_QA_REDEEM_TOKEN_BASE = 700000000;
const redeemClaimLanes = new Map();
const TYPE_THAT_GIVES_ISK = 52996;
const TYPE_THAT_GIVES_HERALDRY_LP = 73277;
const MULTIPLE_CHARACTER_TRAINING_TOKEN_TYPE_IDS = new Set([
  34133, // Multiple Pilot Training Certificate
  63188, // Multiple Pilot Training (soulbound redeem entitlement)
]);
const REDEEM_TOKEN_COLUMNS = Object.freeze([
  ["tokenID", 0x03],
  ["massTokenID", 0x03],
  ["typeID", 0x03],
  ["quantity", 0x03],
  ["blueprintRuns", 0x03],
  ["blueprintMaterialLevel", 0x03],
  ["blueprintProductivityLevel", 0x03],
  ["label", 0x82],
  ["description", 0x82],
  ["dateTime", 0x40],
  ["expireDateTime", 0x40],
  ["availableDateTime", 0x40],
  ["stationID", 0x14],
  ["soulbound", 0x03],
]);
const SKILLPOINT_REDEEM_AMOUNTS = Object.freeze({
  54652: 1000,
  54653: 2500,
  63303: 4000,
  63304: 4500,
  54650: 5000,
  63305: 5500,
  63306: 6000,
  63307: 6500,
  63308: 7000,
  54654: 7500,
  63309: 8000,
  63310: 9000,
  52520: 10000,
  63311: 11000,
  63312: 12000,
  63313: 13000,
  63314: 14000,
  63315: 15000,
  63316: 16000,
  63317: 17000,
  63318: 18000,
  63623: 19000,
  63624: 20000,
  63319: 21000,
  63320: 22000,
  63321: 23000,
  63322: 24000,
  49756: 25000,
  63323: 27000,
  63324: 28000,
  63325: 29000,
  57003: 30000,
  63326: 31000,
  63327: 32000,
  63328: 33000,
  63329: 34000,
  63330: 35000,
  63331: 42000,
  63332: 43000,
  63333: 44000,
  63334: 45000,
  63335: 46000,
  63336: 47000,
  63337: 48000,
  63338: 49000,
  49809: 50000,
  63339: 51000,
  63340: 52000,
  63824: 75000,
  49810: 100000,
  63825: 125000,
  54648: 150000,
  43680: 250000,
  52269: 500000,
  89839: 648000,
  52270: 750000,
  52318: 750000,
  52263: 1000000,
  56707: 1620000,
});

function getAccountRecordByUserID(userID) {
  const result = database.read("accounts", "/");
  const accounts = result.success && result.data ? result.data : {};

  for (const [username, account] of Object.entries(accounts)) {
    if (Number(account && account.id) === Number(userID || 0)) {
      return {
        username,
        account,
      };
    }
  }

  return null;
}

function buildDefaultTrainingSlots() {
  return {
    2: DEFAULT_MCT_EXPIRY_FILETIME,
    3: DEFAULT_MCT_EXPIRY_FILETIME,
  };
}

function getAccountIDFromSession(session) {
  return Number(session && (session.userid || session.userID || session.accountID)) || 0;
}

function getCharacterIDFromSession(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function getCharacterStateRuntime() {
  return require(path.join(__dirname, "../character/characterState"));
}

function getExpertSystemCatalogRuntime() {
  return require(path.join(__dirname, "../skills/expertSystems/expertSystemCatalog"));
}

function getExpertSystemRuntime() {
  return require(path.join(__dirname, "../skills/expertSystems/expertSystemRuntime"));
}

function getMergedTrainingSlots(accountID) {
  return getTrainingSlotsForAccount(accountID);
}

// The slots as the client of a character in the AIR tutorial is told them: one more. The client
// counts slots against the character selection data it cached at login, and when it finds them
// all in use, its "Train Skills" reloads the queue from the server and drops the skill just added
// (skillQueueSvc.OnClientQueueModified). The account keeps its licensed training-slot limit:
// a valid tutorial activation preempts only the busy slots it needs; saving a
// paused queue never does (skillQueueRuntime.saveQueue).
//
// Only running queues are listed. The client reads every entry as an active queue: the
// activation dialog labels it AdditionalQueueActive with an Extend button, the character
// sheet's plexPanel draws it green, and skillQueueSvc.IsAllCharacterTrainingSlotsUsed counts
// 1 + len(slots) queues. TQ answers {} for an account without MCT (GetMultiCharactersTrainingSlots
// retval={} in every golden login log). An expired queue keeps its key in the account record so
// a later activation still picks it first (selectTrainingSlot).
function getSessionTrainingSlots(session) {
  const now = currentFileTime();
  const slots = Object.fromEntries(
    Object.entries(getMergedTrainingSlots(getAccountIDFromSession(session)))
      .filter(([, expiry]) => toFileTimeBigInt(expiry, 0n) > now),
  );
  const characterID = Number(session && (session.characterID || session.charid)) || 0;
  if (characterID > 0 && require(path.join(__dirname, "../npe/airNpeRuntime")).isTutorialActive(characterID)) {
    let slot = 2;
    while (Object.prototype.hasOwnProperty.call(slots, String(slot))) slot += 1;
    slots[String(slot)] = DEFAULT_MCT_EXPIRY_FILETIME;
  }
  return slots;
}

function buildTrainingSlotList(trainingSlots) {
  return {
    type: "list",
    items: Object.entries(trainingSlots)
      .map(([slot, expiry]) => [
        Number(slot),
        buildFiletimeLong(expiry),
      ])
      .sort((left, right) => left[0] - right[0]),
  };
}

function getKwargValue(kwargs, key, fallback = undefined) {
  for (const [entryKey, entryValue] of extractDictEntries(kwargs)) {
    // A decoded dict key keeps the form the wire used. Eleven of the fifteen keys
    // read through here sit outside the marshal string table and arrived as raw
    // Buffers, so a raw comparison dropped them; `description`, `quantity`,
    // `typeID` and `userID` are in the table and happened to match. See the note
    // on accountService.extractKwarg.
    if (strVal(entryKey) === key) {
      return entryValue;
    }
  }
  return fallback;
}

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizeFileTimeString(value, fallback = "0") {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
    return normalizeFileTimeString(value.value, fallback);
  }
  if (typeof value === "bigint") {
    return value > 0n ? value.toString() : fallback;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return fallback;
}

function toFileTimeBigInt(value, fallback = 0n) {
  try {
    return BigInt(normalizeFileTimeString(value, fallback.toString()));
  } catch (error) {
    return fallback;
  }
}

function normalizeRedeemTokenRecord(token) {
  const source = token && typeof token === "object" ? token : {};
  const tokenID = normalizePositiveInteger(source.tokenID, 0);
  const typeID = normalizePositiveInteger(source.typeID, 0);
  const quantity = Math.max(1, Math.trunc(Number(source.quantity || 1) || 1));
  if (!tokenID || !typeID) {
    return null;
  }
  return {
    tokenID,
    massTokenID: normalizePositiveInteger(source.massTokenID, 0),
    typeID,
    quantity,
    ...(source.campaignGrant ? { campaignGrant: { ...source.campaignGrant } } : {}),
    ...(source.projectDiscoveryGrant ? { projectDiscoveryGrant: { ...source.projectDiscoveryGrant } } : {}),
    stationID: normalizePositiveInteger(source.stationID, 0),
    dateTime: normalizeFileTimeString(source.dateTime, "0"),
    expireDateTime: normalizeFileTimeString(source.expireDateTime, "0"),
    availableDateTime: normalizeFileTimeString(source.availableDateTime, "0"),
    label: typeof source.label === "string" ? source.label : "",
    description: typeof source.description === "string" ? source.description : "",
    blueprintRuns: Math.max(0, Math.trunc(Number(source.blueprintRuns || 0) || 0)),
    blueprintMaterialLevel: Math.trunc(Number(source.blueprintMaterialLevel || 0) || 0),
    blueprintProductivityLevel: Math.trunc(Number(source.blueprintProductivityLevel || 0) || 0),
    soulbound: Boolean(source.soulbound),
    available:
      source.available === undefined || source.available === null
        ? true
        : Boolean(source.available),
    addedByContext: Math.trunc(Number(source.addedByContext || 0) || 0),
    addedByExtra: source.addedByExtra === undefined ? null : source.addedByExtra,
  };
}

function getRedeemTokensForAccount(accountID) {
  return (readRuntimeAccount(accountID).redeemTokens || [])
    .map(normalizeRedeemTokenRecord)
    .filter(Boolean);
}

function writeRedeemTokensForAccount(accountID, tokens) {
  const runtimeAccount = readRuntimeAccount(accountID);
  const normalizedTokens = (Array.isArray(tokens) ? tokens : [])
    .map(normalizeRedeemTokenRecord)
    .filter(Boolean);
  const written = writeRuntimeAccount(accountID, {
    ...runtimeAccount,
    redeemTokens: normalizedTokens,
  });
  return written ? normalizedTokens : null;
}

function buildRedeemTokenPayload(token) {
  const normalized = normalizeRedeemTokenRecord(token);
  if (!normalized) {
    return null;
  }
  const blueprintInfo = normalized.blueprintRuns > 0
    ? buildKeyVal([
        ["isCopy", true],
        ["runs", normalized.blueprintRuns],
        ["materialEfficiency", normalized.blueprintMaterialLevel],
        ["timeEfficiency", normalized.blueprintProductivityLevel],
      ])
    : null;
  return buildKeyVal([
    ["tokenID", normalized.tokenID],
    ["massTokenID", normalized.massTokenID],
    ["typeID", normalized.typeID],
    ["quantity", normalized.quantity],
    ["stationID", normalized.stationID],
    [
      "dateTime",
      buildFiletimeLong(normalized.dateTime !== "0" ? normalized.dateTime : currentFileTime().toString()),
    ],
    [
      "expireDateTime",
      normalized.expireDateTime !== "0"
        ? buildFiletimeLong(normalized.expireDateTime)
        : 0,
    ],
    ["label", normalized.label],
    ["description", normalized.description],
    ["blueprintRuns", normalized.blueprintRuns],
    ["blueprintInfo", blueprintInfo],
    ["soulbound", normalized.soulbound],
    ["isAutoInject", isAutoInjectedRedeemToken(normalized)],
  ]);
}

function buildRedeemTokenRow(token) {
  const normalized = normalizeRedeemTokenRecord(token);
  if (!normalized) {
    return null;
  }
  const dateTime = toFileTimeBigInt(normalized.dateTime, currentFileTime());
  const expireDateTime = toFileTimeBigInt(normalized.expireDateTime, 0n);
  const availableDateTime = toFileTimeBigInt(normalized.availableDateTime, dateTime);
  return {
    tokenID: normalized.tokenID,
    massTokenID:
      normalized.massTokenID && normalized.massTokenID !== normalized.tokenID
        ? normalized.massTokenID
        : null,
    typeID: normalized.typeID,
    quantity: normalized.quantity,
    blueprintRuns: normalized.blueprintRuns,
    blueprintMaterialLevel: normalized.blueprintMaterialLevel,
    blueprintProductivityLevel: normalized.blueprintProductivityLevel,
    label: { type: "wstring", value: normalized.label },
    description: { type: "wstring", value: normalized.description },
    dateTime,
    expireDateTime: expireDateTime > 0n ? expireDateTime : null,
    availableDateTime: availableDateTime > 0n ? availableDateTime : dateTime,
    stationID: normalized.stationID || null,
    soulbound: normalized.soulbound ? 1 : 0,
  };
}

function buildRedeemTokenRowset(tokens) {
  return buildDbRowset(
    REDEEM_TOKEN_COLUMNS,
    (Array.isArray(tokens) ? tokens : []).map(buildRedeemTokenRow).filter(Boolean),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function getSkillPointRedeemAmount(typeID) {
  return SKILLPOINT_REDEEM_AMOUNTS[normalizePositiveInteger(typeID, 0)] || 0;
}

function getSkillPointsToRedeem(token) {
  return getSkillPointRedeemAmount(token && token.typeID) *
    Math.max(1, normalizeInteger(token && token.quantity, 1));
}

function isIskRedeemToken(typeID) {
  return normalizePositiveInteger(typeID, 0) === TYPE_THAT_GIVES_ISK;
}

function isHeraldryLpRedeemToken(typeID) {
  return normalizePositiveInteger(typeID, 0) === TYPE_THAT_GIVES_HERALDRY_LP;
}

function isAutoInjectedRedeemToken(token) {
  const typeID = normalizePositiveInteger(token && token.typeID, 0);
  return Boolean(
    (token && token.soulbound)
      || getSkillPointRedeemAmount(typeID) > 0
      || isIskRedeemToken(typeID)
      || isHeraldryLpRedeemToken(typeID)
      || isExpertSystemRedeemToken(typeID),
  );
}

function isExpertSystemRedeemToken(typeID) {
  const catalog = getExpertSystemCatalogRuntime();
  return Boolean(
    catalog &&
      typeof catalog.isExpertSystemType === "function" &&
      catalog.isExpertSystemType(typeID),
  );
}

function generateRedeemTokenID(existingTokens) {
  const maxExisting = Math.max(
    0,
    ...(Array.isArray(existingTokens) ? existingTokens : [])
      .flatMap((token) => [token && token.tokenID, token && token.massTokenID])
      .map((value) => Number(value) || 0),
  );
  if (maxExisting >= LOCAL_QA_REDEEM_TOKEN_BASE) {
    return maxExisting + 1;
  }
  return LOCAL_QA_REDEEM_TOKEN_BASE + (Date.now() % 100000000);
}

function resolveRedeemDestinationID(session, characterID, useHomeStation = false) {
  const character = characterID ? getCharacterRecord(characterID) : null;
  if (useHomeStation) {
    return (
      normalizePositiveInteger(character && character.homeStationID, 0) ||
      normalizePositiveInteger(character && character.cloneStationID, 0) ||
      normalizePositiveInteger(session && (session.homeStationID || session.homestationid), 0) ||
      normalizePositiveInteger(session && (session.cloneStationID || session.clonestationid), 0) ||
      normalizePositiveInteger(session && (session.stationid || session.stationID), 0)
    );
  }
  return (
    normalizePositiveInteger(session && (session.stationid || session.stationID), 0) ||
    normalizePositiveInteger(session && (session.structureid || session.structureID), 0) ||
    normalizePositiveInteger(character && character.stationID, 0) ||
    normalizePositiveInteger(character && character.structureID, 0) ||
    normalizePositiveInteger(character && character.homeStationID, 0)
  );
}

function extractRequestedRedeemTokens(value) {
  const unwrapped = unwrapMarshalValue(value);
  const sourceList = Array.isArray(unwrapped) ? unwrapped : [];
  return sourceList
    .map((entry) => {
      if (Array.isArray(entry)) {
        return {
          tokenID: normalizePositiveInteger(entry[0], 0),
          massTokenID: normalizePositiveInteger(entry[1], 0),
          typeID: normalizePositiveInteger(entry[2], 0),
        };
      }
      const source = entry && typeof entry === "object" ? entry : {};
      return {
        tokenID: normalizePositiveInteger(source.tokenID, 0),
        massTokenID: normalizePositiveInteger(source.massTokenID, 0),
        typeID: normalizePositiveInteger(source.typeID, 0),
      };
    })
    .filter((entry) => entry.tokenID || entry.massTokenID);
}

function tokenMatchesRequest(token, request) {
  return Boolean(
    token &&
      request &&
      (
        (request.tokenID && Number(token.tokenID) === Number(request.tokenID)) ||
        (request.massTokenID && Number(token.massTokenID) === Number(request.massTokenID))
      ),
  );
}

function buildCreatedItemPayload(item) {
  return buildDict([
    ["itemID", Number(item && item.itemID) || 0],
    ["typeID", Number(item && item.typeID) || 0],
    ["quantity", Number(item && (item.stacksize || item.quantity)) || 1],
    ["stationID", Number(item && item.locationID) || 0],
  ]);
}

function buildRedeemErrorPayload(message, data = {}) {
  return buildKeyVal([
    ["msg", message],
    ["dict", buildDict(Object.entries(data))],
  ]);
}

function syncInventoryItemChange(session, item, previousState = {}) {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  if (
    characterState &&
    typeof characterState.syncInventoryItemForSession === "function"
  ) {
    characterState.syncInventoryItemForSession(session, item, previousState);
  }
}

function selectTrainingSlot(trainingSlots, requestedTrainingID) {
  // The client offers two extra queues, trainingIDs 2 and 3.
  const requestedSlot = Number(requestedTrainingID) || 0;
  if (requestedSlot === 2 || requestedSlot === 3) {
    return String(requestedSlot);
  }

  // No trainingID is the dialog's "Activate" button: open a queue that is not
  // running before extending one that is.
  const now = currentFileTime();
  for (const slot of ["2", "3"]) {
    if (BigInt(String(trainingSlots[slot] || "0")) <= now) {
      return slot;
    }
  }

  return Object.entries(trainingSlots)
    .map(([slot, expiry]) => ({
      slot: String(slot),
      numericSlot: Number(slot) || 0,
      expiry: BigInt(String(expiry || "0")),
    }))
    .filter((entry) => entry.numericSlot >= 2)
    .sort((left, right) => {
      if (left.expiry === right.expiry) {
        return left.numericSlot - right.numericSlot;
      }
      return left.expiry < right.expiry ? -1 : 1;
    })[0]?.slot || "2";
}

function grantTrainingDays(accountID, trainingID, durationDays = DEFAULT_MCT_GRANT_DAYS) {
  const numericAccountID = Number(accountID) || 0;
  if (!numericAccountID) {
    return buildDefaultTrainingSlots();
  }

  const currentSlots = getMergedTrainingSlots(numericAccountID);
  const slotKey = selectTrainingSlot(currentSlots, trainingID);
  const runtimeAccount = readRuntimeAccount(numericAccountID);
  const runtimeSlots = {
    ...(runtimeAccount && runtimeAccount.multiCharacterTrainingSlots
      ? runtimeAccount.multiCharacterTrainingSlots
      : {}),
  };
  runtimeSlots[slotKey] = computeFutureFileTime(durationDays, currentSlots[slotKey]);
  writeRuntimeAccount(numericAccountID, {
    ...runtimeAccount,
    multiCharacterTrainingSlots: runtimeSlots,
  });
  return getMergedTrainingSlots(numericAccountID);
}

function grantRedeemSkillPoints(characterID, token) {
  const skillPoints = getSkillPointsToRedeem(token);
  if (!skillPoints) {
    return {
      success: false,
      errorMsg: "INVALID_SKILLPOINT_REDEEM_TYPE",
    };
  }
  const characterState = getCharacterStateRuntime();
  if (!characterState || typeof characterState.updateCharacterRecord !== "function") {
    return {
      success: false,
      errorMsg: "CHARACTER_STATE_UNAVAILABLE",
    };
  }
  const updateResult = characterState.updateCharacterRecord(characterID, (record) => ({
    ...record,
    freeSkillPoints: Math.max(0, normalizeInteger(record && record.freeSkillPoints, 0)) +
      skillPoints,
  }));
  if (!updateResult.success) {
    return updateResult;
  }
  notifyFreeSkillPointsChanged(
    characterID,
    Math.max(0, normalizeInteger((updateResult.data || {}).freeSkillPoints, 0)),
  );
  return {
    success: true,
    data: {
      skillPoints,
      freeSkillPoints: Math.max(0, normalizeInteger((updateResult.data || {}).freeSkillPoints, 0)),
    },
  };
}

async function grantRedeemIsk(characterID, token) {
  const iskAmount = Math.max(0, normalizeInteger(token && token.quantity, 0));
  if (!iskAmount) {
    return {
      success: false,
      errorMsg: "INVALID_ISK_REDEEM_AMOUNT",
    };
  }
  const creditResult = await adjustCharacterBalanceAsync(characterID, iskAmount, {
    idempotencyKey: `redeem-token:${normalizePositiveInteger(token && token.tokenID, 0)}:isk:${characterID}`,
    referenceID: normalizePositiveInteger(token && token.tokenID, 0),
    reason: "Redeem token",
    description: "Redeem token",
  });
  if (!creditResult.success) {
    return creditResult;
  }
  return {
    success: true,
    data: {
      iskAmount,
    },
  };
}

function grantRedeemHeraldryLp(characterID, token) {
  const lpAmount = Math.max(0, normalizeInteger(token && token.quantity, 0));
  if (!lpAmount) {
    return {
      success: false,
      errorMsg: "INVALID_HERALDRY_LP_REDEEM_AMOUNT",
    };
  }
  const creditResult = adjustCharacterWalletLPBalance(
    characterID,
    EVERMARK_ISSUER_CORP_ID,
    lpAmount,
    {
      changeType: "redeem",
    },
  );
  if (!creditResult.success) {
    return creditResult;
  }
  return {
    success: true,
    data: {
      lpAmount,
      previousAmount: Number(creditResult.data && creditResult.data.previousAmount) || 0,
      amount: Number(creditResult.data && creditResult.data.amount) || 0,
    },
  };
}

function installRedeemExpertSystem(characterID, token, session) {
  const catalog = getExpertSystemCatalogRuntime();
  const runtime = getExpertSystemRuntime();
  if (
    !catalog ||
    typeof catalog.getExpertSystemByTypeID !== "function" ||
    !runtime ||
    typeof runtime.installExpertSystemForCharacter !== "function"
  ) {
    return {
      success: false,
      errorMsg: "EXPERT_SYSTEM_RUNTIME_UNAVAILABLE",
    };
  }
  const expertSystem = catalog.getExpertSystemByTypeID(token && token.typeID);
  if (!expertSystem) {
    return {
      success: false,
      errorMsg: "EXPERT_SYSTEM_NOT_FOUND",
    };
  }
  const quantity = Math.max(1, normalizeInteger(token && token.quantity, 1));
  const durationDays = Math.max(1, normalizeInteger(expertSystem.durationDays, 7)) * quantity;
  return runtime.installExpertSystemForCharacter(characterID, token.typeID, {
    durationDays,
    grantReason: "redeem",
    session,
    sourceItemID: normalizePositiveInteger(token && token.tokenID, 0),
  });
}

function isMultipleCharacterTrainingRedeemToken(token) {
  return Boolean(
    token &&
    token.soulbound &&
    MULTIPLE_CHARACTER_TRAINING_TOKEN_TYPE_IDS.has(
      normalizePositiveInteger(token.typeID, 0),
    )
  );
}

function buildRedeemIskBalance(characterID) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return null;
  }
  const wallet = getCharacterWallet(normalizedCharacterID);
  return wallet ? buildMarshalRealMoney(wallet.balance) : null;
}

function buildRedeemResult(session, options = {}) {
  const stationID = options.stationID !== undefined
    ? options.stationID
    : Number(session && (
        session.stationid ||
        session.stationID ||
        session.structureid ||
        session.structureID
      )) || null;
  const characterID =
    normalizePositiveInteger(options.characterID, 0) ||
    getCharacterIDFromSession(session) ||
    null;
  return {
    type: "dict",
    entries: [
      ["errors", { type: "list", items: [] }],
      ["itemsCreated", { type: "list", items: [] }],
      ["activated_licenses", { type: "list", items: [] }],
      ["isk_rewarded", 0],
      ["isk_balance", buildRedeemIskBalance(characterID)],
      ["skillpoints", 0],
      ["stationID", stationID],
      ["charID", characterID],
    ],
  };
}

class UserService extends BaseService {
  constructor() {
    super("userSvc");
  }

  /**
   * GetRedeemTokens — returns tokens available to redeem
   *
   * Called during login and whenever OnRedeemingQueueUpdated is received.
   * This client expects the same packed CRowset returned by Tranquility.
   */
  Handle_GetRedeemTokens(args, session, kwargs) {
    log.debug("[UserService] GetRedeemTokens called");
    const now = currentFileTime();
    const accountID = getAccountIDFromSession(session);
    const activeTokens = getRedeemTokensForAccount(accountID).filter((token) => {
      if (!token.available) {
        return false;
      }
      if (token.campaignGrant) return !require("../campaign/loginCampaignRuntime").isExpired(token);
      const expiry = toFileTimeBigInt(token.expireDateTime, 0n);
      return expiry <= 0n || expiry > now;
    });
    if (activeTokens.length !== getRedeemTokensForAccount(accountID).length) {
      writeRedeemTokensForAccount(accountID, activeTokens);
    }
    return buildRedeemTokenRowset(activeTokens);
  }

  Handle_GetMultiCharactersTrainingSlots(args, session) {
    log.debug("[userSvc] GetMultiCharactersTrainingSlots called");
    const configuredSlots = getSessionTrainingSlots(session);

    return {
      type: "dict",
      entries: Object.entries(configuredSlots).map(([slot, expiry]) => [
        Number(slot),
        buildFiletimeLong(expiry),
      ]),
    };
  }

  Handle_GetUpdatedMultiCharacterTraining(args, session) {
    log.debug("[userSvc] GetUpdatedMultiCharacterTraining called");
    return buildTrainingSlotList(getSessionTrainingSlots(session));
  }

  Handle_ActivateMultiTraining(args, session, kwargs, callContext = null) {
    const accountID = getAccountIDFromSession(session);
    // Native Activate supplies None; Extend supplies the queue's own ID.
    const rawItemIDs = unwrapMarshalValue(args && args[0]);
    const itemID = normalizePositiveInteger(
      Array.isArray(rawItemIDs) ? rawItemIDs[0] : rawItemIDs,
      0,
    );
    const trainingID = getKwargValue(kwargs, "trainingID", null);
    const result = require("./mctCertificateActivation").activate(itemID, trainingID, session, callContext);
    if (!result.success) log.info(`[userSvc] ActivateMultiTraining denied user=${accountID} itemID=${itemID}: ${result.errorMsg}`);
    return buildTrainingSlotList(getMergedTrainingSlots(accountID));
  }

  Handle_ActivateSoulboundMultiTraining(args, session, kwargs) {
    const requestedTokens = extractRequestedRedeemTokens(args && args[1]);
    const trainingID =
      (args && args.length > 2 ? args[2] : undefined) ??
      getKwargValue(kwargs, "trainingID", null);
    const accountID = getAccountIDFromSession(session);
    const currentTokens = getRedeemTokensForAccount(accountID);
    const certificates = new Map();
    for (const request of requestedTokens) {
      const token = currentTokens.find((candidate) => tokenMatchesRequest(candidate, request));
      if (isMultipleCharacterTrainingRedeemToken(token)) {
        certificates.set(Number(token.tokenID), token);
      }
    }
    const certificateCount = [...certificates.values()].reduce(
      (total, token) => total + Math.max(1, Number(token.quantity) || 1),
      0,
    );
    if (certificateCount <= 0) {
      log.info(
        `[userSvc] ActivateSoulboundMultiTraining denied user=${accountID}: no queued MCT certificate`,
      );
      return buildTrainingSlotList(getMergedTrainingSlots(accountID));
    }

    const durationDays = certificateCount * DEFAULT_MCT_GRANT_DAYS;
    log.info(
      `[userSvc] ActivateSoulboundMultiTraining user=${accountID} trainingID=${trainingID || "next"} days=${durationDays}`,
    );
    const result = buildTrainingSlotList(grantTrainingDays(accountID, trainingID, durationDays));
    writeRedeemTokensForAccount(
      accountID,
      currentTokens.filter((token) => !certificates.has(Number(token.tokenID))),
    );
    notifyMultipleCharacterTrainingUpdated(accountID);
    return result;
  }

  Handle_InvalidateMultiCharacterTrainingCache() {
    log.debug("[userSvc] InvalidateMultiCharacterTrainingCache called");
    return true;
  }

  Handle_ClaimRedeemTokens(args, session, kwargs) {
    const accountID = getAccountIDFromSession(session);
    const characterID = normalizePositiveInteger(args?.[1], 0) || getCharacterIDFromSession(session);
    const claim = async () => {
      const consumedTokenIDs = new Set();
      try {
        return await this._claimRedeemTokens(args, session, kwargs, accountID, characterID, consumedTokenIDs);
      } finally {
        // Preserve earlier successes even if a later grant throws. Read the
        // queue again so rewards enqueued during wallet I/O are retained.
        if (consumedTokenIDs.size > 0) {
          const remaining = getRedeemTokensForAccount(accountID)
            .filter((token) => !consumedTokenIDs.has(Number(token.tokenID)));
          if (!writeRedeemTokensForAccount(accountID, remaining)) {
            throw new Error("REDEEM_TOKEN_WRITE_FAILED");
          }
        }
      }
    };
    const previous = redeemClaimLanes.get(accountID) || Promise.resolve();
    const next = previous.then(claim, claim);
    redeemClaimLanes.set(accountID, next);
    return next.finally(() => {
      if (redeemClaimLanes.get(accountID) === next) {
        redeemClaimLanes.delete(accountID);
      }
    });
  }

  async _claimRedeemTokens(args, session, kwargs, accountID, characterID, consumedTokenIDs) {
    const requestedTokens = extractRequestedRedeemTokens(args && args[0]);
    const tokenCount = requestedTokens.length;
    log.info(`[userSvc] ClaimRedeemTokens tokenCount=${tokenCount}`);
    if (tokenCount === 0) {
      return buildRedeemResult(session, {
        characterID: normalizePositiveInteger(
          args && args.length > 1 ? args[1] : 0,
          0,
        ),
      });
    }

    const useHomeStation = Boolean(getKwargValue(kwargs, "useHomeStation", false));
    const destinationID = resolveRedeemDestinationID(session, characterID, useHomeStation);
    const currentTokens = getRedeemTokensForAccount(accountID);
    const errors = [];
    const itemsCreated = [];
    let iskRewarded = 0;
    let skillPointsRewarded = 0;
    for (const request of requestedTokens) {
      const token = currentTokens.find((candidate) => tokenMatchesRequest(candidate, request));
      if (!token || consumedTokenIDs.has(Number(token.tokenID))) {
        errors.push([
          request.tokenID || request.massTokenID,
          buildRedeemErrorPayload("RedeemTokenNotFound"),
        ]);
        continue;
      }
      if (!characterID) {
        errors.push([
          token.tokenID,
          buildRedeemErrorPayload("RedeemNoCharacter", { itemTypeID: token.typeID }),
        ]);
        continue;
      }

      if (token.campaignGrant || token.projectDiscoveryGrant) {
        try {
          const delivered = await require("../campaign/loginCampaignRedemption").redeem(
            accountID, token, characterID, destinationID, session,
          );
          if (!delivered.success) throw new Error(delivered.errorMsg);
          if (!delivered.duplicate) {
            skillPointsRewarded += delivered.data.skillpoints;
            iskRewarded += delivered.data.isk;
            for (const item of delivered.data.items) itemsCreated.push(buildCreatedItemPayload(item));
          }
        } catch (error) {
          errors.push([token.tokenID, buildRedeemErrorPayload("RedeemCampaignRewardFailed", { reason: error.message })]);
        }
        continue;
      }

      if (getSkillPointRedeemAmount(token.typeID) > 0) {
        const grantResult = grantRedeemSkillPoints(characterID, token);
        if (!grantResult.success) {
          errors.push([
            token.tokenID,
            buildRedeemErrorPayload("RedeemSkillPointsFailed", {
              itemTypeID: token.typeID,
              reason: grantResult.errorMsg || "UNKNOWN",
            }),
          ]);
          continue;
        }
        skillPointsRewarded += Number(grantResult.data.skillPoints) || 0;
        consumedTokenIDs.add(Number(token.tokenID));
        continue;
      }

      if (isIskRedeemToken(token.typeID)) {
        const grantResult = await grantRedeemIsk(characterID, token);
        if (!grantResult.success) {
          errors.push([
            token.tokenID,
            buildRedeemErrorPayload("RedeemIskFailed", {
              itemTypeID: token.typeID,
              reason: grantResult.errorMsg || "UNKNOWN",
            }),
          ]);
          continue;
        }
        iskRewarded += Number(grantResult.data.iskAmount) || 0;
        consumedTokenIDs.add(Number(token.tokenID));
        continue;
      }

      if (isHeraldryLpRedeemToken(token.typeID)) {
        const grantResult = grantRedeemHeraldryLp(characterID, token);
        if (!grantResult.success) {
          errors.push([
            token.tokenID,
            buildRedeemErrorPayload("RedeemHeraldryLpFailed", {
              itemTypeID: token.typeID,
              reason: grantResult.errorMsg || "UNKNOWN",
            }),
          ]);
          continue;
        }
        consumedTokenIDs.add(Number(token.tokenID));
        continue;
      }

      if (isExpertSystemRedeemToken(token.typeID)) {
        const installResult = installRedeemExpertSystem(characterID, token, session);
        if (!installResult.success) {
          errors.push([
            token.tokenID,
            buildRedeemErrorPayload("RedeemExpertSystemFailed", {
              itemTypeID: token.typeID,
              reason: installResult.errorMsg || "UNKNOWN",
            }),
          ]);
          continue;
        }
        consumedTokenIDs.add(Number(token.tokenID));
        continue;
      }

      if (token.soulbound) {
        errors.push([
          token.tokenID,
          buildRedeemErrorPayload("RedeemAutoInjectUnsupported", {
            itemTypeID: token.typeID,
          }),
        ]);
        continue;
      }

      if (!destinationID) {
        errors.push([
          token.tokenID,
          buildRedeemErrorPayload("RedeemNoDestination", { itemTypeID: token.typeID }),
        ]);
        continue;
      }
      const grantResult = grantItemToCharacterLocation(
        characterID,
        destinationID,
        ITEM_FLAGS.HANGAR,
        token.typeID,
        token.quantity,
        {
          singleton: token.blueprintRuns > 0 ? 2 : undefined,
          customInfo: token.label || token.description || "",
        },
      );
      if (!grantResult.success) {
        errors.push([
          token.tokenID,
          buildRedeemErrorPayload("RedeemItemGrantFailed", {
            itemTypeID: token.typeID,
            reason: grantResult.errorMsg || "UNKNOWN",
          }),
        ]);
        continue;
      }
      const grantedItems = (grantResult.data && grantResult.data.items) || [];
      if (Number(getItemMetadata(token.typeID).categoryID) === 9) {
        const { initializeBlueprintState } = require(path.join(
          __dirname,
          "../industry/industryRuntimeState",
        ));
        const initializationResults = grantedItems.map((item) => (
          initializeBlueprintState(item.itemID, {
            typeID: token.typeID,
            original: token.blueprintRuns <= 0,
            runsRemaining: token.blueprintRuns,
            materialEfficiency: token.blueprintMaterialLevel,
            timeEfficiency: token.blueprintProductivityLevel,
          })
        ));
        const failedInitialization = initializationResults.find((result) => (
          !result || result.success !== true
        ));
        if (failedInitialization) {
          for (const item of grantedItems) {
            removeInventoryItem(item.itemID, { removeContents: false });
          }
          errors.push([
            token.tokenID,
            buildRedeemErrorPayload("RedeemItemGrantFailed", {
              itemTypeID: token.typeID,
              reason:
                failedInitialization.errorMsg ||
                "BLUEPRINT_STATE_INITIALIZATION_FAILED",
            }),
          ]);
          continue;
        }
      }
      consumedTokenIDs.add(Number(token.tokenID));
      for (const item of grantedItems) {
        itemsCreated.push(buildCreatedItemPayload(item));
      }
      if (session && Number(session.characterID || session.charid || 0) === Number(characterID)) {
        for (const change of (grantResult.data && grantResult.data.changes) || []) {
          syncInventoryItemChange(
            session,
            change.item,
            change.previousState || change.previousData || {},
          );
        }
      }
    }

    return {
      type: "dict",
      entries: [
        ["errors", { type: "list", items: errors }],
        ["itemsCreated", { type: "list", items: itemsCreated }],
        ["activated_licenses", { type: "list", items: [] }],
        ["isk_rewarded", iskRewarded],
        ["isk_balance", buildRedeemIskBalance(characterID)],
        ["skillpoints", skillPointsRewarded],
        ["stationID", destinationID || null],
        ["charID", characterID || null],
      ],
    };
  }

  Handle_CreateRedeemTokenQA(args, session, kwargs) {
    const accountID =
      normalizePositiveInteger(getKwargValue(kwargs, "userID", 0), 0) ||
      getAccountIDFromSession(session);
    const typeID = normalizePositiveInteger(getKwargValue(kwargs, "typeID", 0), 0);
    const quantity = Math.max(1, Math.trunc(Number(getKwargValue(kwargs, "quantity", 1)) || 1));
    if (!accountID || !typeID) {
      return false;
    }

    const currentTokens = getRedeemTokensForAccount(accountID);
    const tokenID = generateRedeemTokenID(currentTokens);
    const token = normalizeRedeemTokenRecord({
      tokenID,
      massTokenID: tokenID,
      typeID,
      quantity,
      stationID: 0,
      dateTime: currentFileTime().toString(),
      expireDateTime: normalizeFileTimeString(getKwargValue(kwargs, "expiry", "0"), "0"),
      label: String(getKwargValue(kwargs, "label", "") || ""),
      description: String(getKwargValue(kwargs, "description", "") || ""),
      blueprintRuns: getKwargValue(kwargs, "blueprintRuns", 0),
      blueprintMaterialLevel: getKwargValue(kwargs, "blueprintMaterialLevel", 0),
      blueprintProductivityLevel: getKwargValue(kwargs, "blueprintProductivityLevel", 0),
      soulbound: Boolean(getKwargValue(kwargs, "soulbound", false)),
      available: getKwargValue(kwargs, "available", true),
      addedByContext: getKwargValue(kwargs, "addedByContext", 0),
      addedByExtra: getKwargValue(kwargs, "addedByExtra", null),
    });
    writeRedeemTokensForAccount(accountID, [...currentTokens, token]);
    log.info(
      `[userSvc] CreateRedeemTokenQA user=${accountID} token=${tokenID} type=${typeID} qty=${quantity}`,
    );
    return buildRedeemTokenPayload(token);
  }

  Handle_ReverseRedeem(args) {
    log.info(`[userSvc] ReverseRedeem itemID=${args && args.length ? args[0] : "?"}`);
    return true;
  }

  Handle_TrashRedeemTokens(args, session) {
    const requestedTokens = extractRequestedRedeemTokens(args && args[0]);
    const tokenCount = requestedTokens.length;
    log.info(`[userSvc] TrashRedeemTokens tokenCount=${tokenCount}`);
    if (tokenCount > 0) {
      const accountID = getAccountIDFromSession(session);
      if (!accountID) return false;
      const account = readRuntimeAccount(accountID);
      if (Object.values(account.campaignRedemptions || {}).some(operation => operation.state === "pending" &&
          requestedTokens.some(request => tokenMatchesRequest(operation.token, request)))) return false;
      const remainingTokens = getRedeemTokensForAccount(accountID).filter(
        (token) => !requestedTokens.some((request) => tokenMatchesRequest(token, request)),
      );
      require("../campaign/loginCampaignRuntime").save(accountID, { ...account, redeemTokens: remainingTokens });
    }
    return true;
  }

  Handle_ActivateCharacterReSculpt(args, session) {
    try {
      return require("../character/characterResculpt").activate(
        unwrapMarshalValue(args && args[0]), session,
      );
    } catch (error) {
      log.warn(`[userSvc] Re-sculpt activation pending: ${error.message}`);
      return false;
    }
  }

  Handle_CastUpvote() {
    log.debug("[userSvc] CastUpvote called");
    return true;
  }

  Handle_CastDownvote(args) {
    const feedback = args && args.length > 0 ? String(args[0] || "") : "";
    log.debug(`[userSvc] CastDownvote called feedbackLength=${feedback.length}`);
    return true;
  }

  Handle_ReportBot(args, session) {
    log.info(
      `[userSvc] ReportBot reporter=${getCharacterIDFromSession(session)} target=${args && args.length ? args[0] : "?"}`,
    );
    return true;
  }

  Handle_ReportISKSpammer(args, session) {
    log.info(
      `[userSvc] ReportISKSpammer reporter=${getCharacterIDFromSession(session)} target=${args && args.length ? args[0] : "?"}`,
    );
    return true;
  }

  Handle_GetCreateDate(args, session) {
    const characterID = getCharacterIDFromSession(session);
    const character = characterID ? getCharacterRecord(characterID) : null;
    return buildFiletimeLong(
      character && character.createDateTime
        ? character.createDateTime
        : OLD_ACCOUNT_CREATE_FILETIME,
    );
  }

  Handle_GetSessionPlaytimeMinutes() {
    return 0;
  }

  Handle_GetUserName(args, session) {
    const userID = Number(args && args.length > 0 ? args[0] : getAccountIDFromSession(session)) || 0;
    const accountRecord = getAccountRecordByUserID(userID);
    return accountRecord ? accountRecord.username : `user-${userID || "local"}`;
  }

  Handle_GetUserToken(args, session) {
    const accountID = getAccountIDFromSession(session);
    const characterID = getCharacterIDFromSession(session);
    return `evejs-local-token-${accountID || "0"}-${characterID || "0"}`;
  }

  Handle_UserLogOffCharacter(args, session) {
    log.info(
      `[userSvc] UserLogOffCharacter user=${session ? session.userid : "?"} char=${session ? session.characterID : "?"}`,
    );

    if (!session || !session.characterID) {
      return true;
    }

    const characterID = Number(session.characterID || 0);
    const disconnectResult = disconnectCharacterSession(session, {
      broadcast: true,
      clearSession: true,
    });
    if (!disconnectResult.success) {
      log.warn(
        `[userSvc] Failed to disconnect char=${characterID}: ${disconnectResult.errorMsg}`,
      );
    }

    return true;
  }
}

UserService.getSkillPointRedeemAmount = getSkillPointRedeemAmount;
module.exports = UserService;
