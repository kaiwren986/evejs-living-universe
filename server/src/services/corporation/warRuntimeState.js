"use strict";

const path = require("path");
const { isDeepStrictEqual } = require("node:util");

const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  cloneValue,
  ensureRuntimeInitialized,
  getCorporationDivisionNames,
  normalizeBoolean,
  normalizePositiveInteger,
  updateRuntimeState,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  notifyWarChanged,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  getAllianceCorporationIDs,
  getAllianceRecord,
  getCharacterIDsInCorporation,
  getCorporationRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  BILL_TYPE_WAR,
  createBill,
  getBillRecord,
  listDueBills,
  markBillProcessed,
  tryAutoPayBill,
} = require(path.join(__dirname, "../account/billRuntimeState"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const warNotificationCenter = require(path.join(
  __dirname,
  "./warNotificationCenter",
));

const FILETIME_TICKS_PER_HOUR = 36000000000n;
const FILETIME_TICKS_PER_DAY = FILETIME_TICKS_PER_HOUR * 24n;
const FILETIME_TICKS_PER_WEEK = FILETIME_TICKS_PER_DAY * 7n;
const WAR_SPOOLUP = 24n * FILETIME_TICKS_PER_HOUR;
const WAR_COOLDOWN = FILETIME_TICKS_PER_DAY;
const FORCED_PEACE_PERIOD = FILETIME_TICKS_PER_WEEK * 2n;
const COST_OF_WAR = 100000000;
const CONCORD_CORPORATION_ID = 1000125;
const PEACE_REASON_HQ_REMOVED = 1;
const PEACE_REASON_HQ_OWNER_LEFT_ALLIANCE = 2;
const PEACE_REASON_CORP_LEFT_ALLIANCE = 3;
const PEACE_REASON_UNPAID_BILL = 5;
const ENDED_WARHQ_GONE = 3;
const ENDED_CORP_DELETED = 5;
const ENDED_RETRACTED = 6;
const ENDED_HQ_OWNER_LEFT = 9;
const ENDED_UNPAID_BILL = 10;
const ENDED_LEFT_ALLIANCE = 12;
const ENDED_ALLIANCE_DELETED = 13;
const ENDED_WAR_HQ_SYSTEM_SECURITY_DROP = 15;
const WAR_NEGOTIATION_STATE_NEW = 0;
const WAR_NEGOTIATION_STATE_RETRACTED = 3;
const WAR_NEGOTIATION_EXPIRY = FILETIME_TICKS_PER_DAY;
const MUTUAL_WAR_INVITE_EXPIRY = FILETIME_TICKS_PER_DAY * 7n;
let warIndexesDirty = true;
let warIndexesCache = null;

function appendWarIndexEntry(indexMap, key, war) {
  if (!key) {
    return;
  }
  if (!indexMap.has(key)) {
    indexMap.set(key, []);
  }
  indexMap.get(key).push(war);
}

function markWarIndexesDirty() {
  warIndexesDirty = true;
  warIndexesCache = null;
}

function ensureWarIndexes() {
  if (!warIndexesDirty && warIndexesCache) {
    return warIndexesCache;
  }

  const runtimeTable = ensureRuntimeInitialized();
  const warsAsc = Object.values(runtimeTable.wars || {})
    .map((war) => cloneValue(war))
    .sort((left, right) => Number(left.warID) - Number(right.warID));
  const warsDesc = warsAsc.slice().sort((left, right) => Number(right.warID) - Number(left.warID));
  const byOwner = new Map();
  const byStructure = new Map();

  for (const war of warsAsc) {
    appendWarIndexEntry(byOwner, normalizePositiveInteger(war && war.declaredByID, null), war);
    appendWarIndexEntry(byOwner, normalizePositiveInteger(war && war.againstID, null), war);
    appendWarIndexEntry(byStructure, normalizePositiveInteger(war && war.warHQID, null), war);
    for (const allyID of Object.keys((war && war.allies) || {})) {
      appendWarIndexEntry(byOwner, normalizePositiveInteger(allyID, null), war);
    }
  }

  warIndexesCache = {
    warsAsc,
    warsDesc,
    byOwner,
    byStructure,
  };
  warIndexesDirty = false;
  return warIndexesCache;
}

function getWarRecord(warID) {
  const runtimeTable = ensureRuntimeInitialized();
  const record = runtimeTable.wars && runtimeTable.wars[String(warID)];
  return record ? cloneValue(record) : null;
}

function listAllWars() {
  return cloneValue(ensureWarIndexes().warsAsc);
}

function listAllWarsDescending() {
  return cloneValue(ensureWarIndexes().warsDesc);
}

function listWarsForOwner(ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID) {
    return [];
  }
  return cloneValue(ensureWarIndexes().byOwner.get(numericOwnerID) || []);
}

function listWarsForStructure(structureID) {
  const numericStructureID = normalizePositiveInteger(structureID, null);
  if (!numericStructureID) {
    return [];
  }
  return cloneValue(ensureWarIndexes().byStructure.get(numericStructureID) || []);
}

function msToFileTime(ms) {
  const numericMs = Number(ms);
  const effectiveMs = Number.isFinite(numericMs) ? Math.trunc(numericMs) : Date.now();
  return BigInt(effectiveMs) * 10000n + 116444736000000000n;
}

function normalizeFiletimeBigInt(value, fallback = 0n) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  try {
    return BigInt(String(value));
  } catch (_error) {
    return fallback;
  }
}

function getCharacterStateService() {
  return require(path.join(__dirname, "../character/characterState"));
}

function getStructureStateService() {
  return require(path.join(__dirname, "../structure/structureState"));
}

function getWorldDataService() {
  return require(path.join(__dirname, "../../space/worldData"));
}

function normalizeNowFiletime(options = {}) {
  const explicitFiletime =
    options.nowFiletime !== undefined && options.nowFiletime !== null
      ? options.nowFiletime
      : options.nowFileTime;
  if (explicitFiletime !== undefined && explicitFiletime !== null) {
    return normalizeFiletimeBigInt(explicitFiletime, currentFileTime());
  }
  if (options.nowMs !== undefined) {
    return msToFileTime(options.nowMs);
  }
  return currentFileTime();
}

function isWarStartedAt(war, now) {
  return normalizeFiletimeBigInt(war && war.timeStarted, 0n) <= now;
}

function isWarFinishedAt(war, now) {
  const finishedAt = normalizeFiletimeBigInt(war && war.timeFinished, 0n);
  return finishedAt > 0n && finishedAt <= now;
}

function isWarActiveAt(war, now) {
  return Boolean(war && isWarStartedAt(war, now) && !isWarFinishedAt(war, now));
}

function isWarFinishedOrFinishing(war) {
  return Boolean(war && war.timeFinished);
}

function isAggressiveBillableWar(war) {
  return Boolean(
    war &&
      !normalizeBoolean(war.mutual, false) &&
      normalizePositiveInteger(war.declaredByID, null) &&
      normalizePositiveInteger(war.againstID, null),
  );
}

function createNextWarBill(war, baseDueFiletime) {
  const declaredByID = normalizePositiveInteger(war && war.declaredByID, null);
  const againstID = normalizePositiveInteger(war && war.againstID, null);
  const warID = normalizePositiveInteger(war && war.warID, null);
  if (!declaredByID || !againstID || !warID) {
    return null;
  }
  const dueDateTime = normalizeFiletimeBigInt(baseDueFiletime, currentFileTime()) +
    FILETIME_TICKS_PER_WEEK;
  return createBill({
    billTypeID: BILL_TYPE_WAR,
    amount: COST_OF_WAR,
    debtorID: declaredByID,
    creditorID: CONCORD_CORPORATION_ID,
    dueDateTime: dueDateTime.toString(),
    externalID: againstID,
    externalID2: warID,
  });
}

function getStructureOwnerCorporationID(structure) {
  return normalizePositiveInteger(
    structure && (structure.ownerCorpID || structure.ownerID),
    null,
  );
}

function isHighSecurityWarHQ(structure) {
  const worldData = getWorldDataService();
  const system = worldData.getSolarSystemByID(
    normalizePositiveInteger(structure && structure.solarSystemID, 0),
  );
  const security = Number(system && system.security);
  return Number.isFinite(security) && security >= 0.45;
}

function isDockableUpwellWarHQ(structure) {
  if (!structure || structure.destroyedAt) {
    return false;
  }
  const structureState = getStructureStateService();
  const typeRecord = structureState.getStructureTypeByID(structure.typeID);
  return Boolean(
    typeRecord &&
      normalizePositiveInteger(typeRecord.categoryID, 0) === 65 &&
      typeRecord.dockable === true,
  );
}

function ownerExists(ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  return Boolean(
    numericOwnerID &&
      (getCorporationRecord(numericOwnerID) || getAllianceRecord(numericOwnerID)),
  );
}

function resolveWarHQStructure(war) {
  const warHQID = normalizePositiveInteger(war && war.warHQID, null);
  if (!warHQID) {
    return null;
  }
  try {
    return getStructureStateService().getStructureByID(warHQID, { refresh: false });
  } catch (_error) {
    // ignored: no structure state (null) means the war HQ is unknown
    return null;
  }
}

function ensurePeaceTreatyRuntime(runtimeTable) {
  runtimeTable.peaceTreaties =
    runtimeTable.peaceTreaties && typeof runtimeTable.peaceTreaties === "object"
      ? runtimeTable.peaceTreaties
      : {};
  runtimeTable._meta =
    runtimeTable._meta && typeof runtimeTable._meta === "object"
      ? runtimeTable._meta
      : {};
  runtimeTable._meta.nextTreatyID =
    normalizePositiveInteger(runtimeTable._meta.nextTreatyID, 1) || 1;
}

function hasPeaceTreaty(runtimeTable, warID, ownerID, otherOwnerID, reason) {
  return Object.values(runtimeTable.peaceTreaties || {}).some(
    (treaty) =>
      Number(treaty && treaty.warID) === Number(warID) &&
      Number(treaty && treaty.ownerID) === Number(ownerID) &&
      Number(treaty && treaty.otherOwnerID) === Number(otherOwnerID) &&
      Number(treaty && treaty.peaceReason) === Number(reason),
  );
}

function createPeaceTreatyRecord(runtimeTable, {
  warID,
  ownerID,
  otherOwnerID,
  peaceReason,
  now,
} = {}) {
  const numericWarID = normalizePositiveInteger(warID, null);
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  const numericOtherOwnerID = normalizePositiveInteger(otherOwnerID, null);
  if (!numericWarID || !numericOwnerID || !numericOtherOwnerID) {
    return;
  }
  ensurePeaceTreatyRuntime(runtimeTable);
  if (
    hasPeaceTreaty(
      runtimeTable,
      numericWarID,
      numericOwnerID,
      numericOtherOwnerID,
      peaceReason,
    )
  ) {
    return;
  }
  const treatyID = runtimeTable._meta.nextTreatyID;
  runtimeTable._meta.nextTreatyID += 1;
  runtimeTable.peaceTreaties[String(treatyID)] = {
    treatyID,
    warID: numericWarID,
    ownerID: numericOwnerID,
    otherOwnerID: numericOtherOwnerID,
    peaceReason,
    createdDate: now.toString(),
    expiryDate: (now + FORCED_PEACE_PERIOD).toString(),
  };
}

function collectWarOwnerCharacterIDs(ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID) {
    return [];
  }
  if (getAllianceRecord(numericOwnerID)) {
    return getAllianceCorporationIDs(numericOwnerID).flatMap((corporationID) =>
      getCharacterIDsInCorporation(corporationID),
    );
  }
  return getCharacterIDsInCorporation(numericOwnerID);
}

function collectWarNotificationRecipients(war) {
  const recipients = new Set();
  for (const ownerID of [
    normalizePositiveInteger(war && war.declaredByID, null),
    normalizePositiveInteger(war && war.againstID, null),
    ...Object.keys((war && war.allies) || {}).map((allyID) =>
      normalizePositiveInteger(allyID, null),
    ),
  ]) {
    for (const characterID of collectWarOwnerCharacterIDs(ownerID)) {
      recipients.add(characterID);
    }
  }
  return [...recipients].sort((left, right) => left - right);
}

function getStructureWarHQName(structure) {
  return String(
    (structure && (structure.itemName || structure.name)) ||
      `Structure ${normalizePositiveInteger(structure && structure.structureID, 0)}`,
  );
}

function createWarHQRemovedNotifications(war, structure, now) {
  const recipients = collectWarNotificationRecipients(war);
  if (recipients.length <= 0) {
    return;
  }
  const senderID = normalizePositiveInteger(war && war.declaredByID, 0) || 0;
  const data = {
    warID: normalizePositiveInteger(war && war.warID, 0) || 0,
    declaredByID: normalizePositiveInteger(war && war.declaredByID, 0) || 0,
    againstID: normalizePositiveInteger(war && war.againstID, 0) || 0,
    timeDeclared: warNotificationCenter.filetimeLongData(war && war.timeDeclared, now),
    timeStarted: warNotificationCenter.filetimeLongData(war && war.timeStarted, now),
    timeFinished: warNotificationCenter.filetimeLongData(war && war.timeFinished, now),
    warHQ: getStructureWarHQName(structure),
    warHQ_IdType: [
      normalizePositiveInteger(structure && structure.structureID, 0) || 0,
      normalizePositiveInteger(structure && structure.typeID, 0) || 0,
    ],
  };
  for (const characterID of recipients) {
    createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.WAR_HQ_REMOVED_FROM_SPACE,
      senderID,
      groupID: NOTIFICATION_GROUP.WAR,
      processed: false,
      data,
    });
  }
}

// Fan a war-lifecycle center row out to every member of the defending owner,
// picking the corp- vs alliance-defender notification type. The aggressor is the
// sender, and the data always carries the war owners (the client renders
// againstName/declaredByName from them); `extraData` adds type-specific fields.
function notifyWarDefenderMembers(
  war,
  corpTypeID,
  allianceTypeID,
  extraData = {},
  options = {},
) {
  const againstID = normalizePositiveInteger(war && war.againstID, null);
  const declaredByID = normalizePositiveInteger(war && war.declaredByID, null);
  if (!againstID || !declaredByID) {
    return [];
  }
  const recipients = collectWarOwnerCharacterIDs(againstID);
  if (!recipients.length) {
    return [];
  }
  const typeID = getAllianceRecord(againstID) ? allianceTypeID : corpTypeID;
  const data = {
    declaredByID,
    againstID,
    ...extraData,
  };
  const results = [];
  for (const characterID of recipients) {
    results.push(createNotification(characterID, {
      typeID,
      senderID: declaredByID,
      groupID: NOTIFICATION_GROUP.WAR,
      processed: false,
      data,
      requireDurable: options.requireDurable === true,
      idempotencyKey: options.idempotencyKeyPrefix
        ? `${options.idempotencyKeyPrefix}:${typeID}:${characterID}`
        : undefined,
    }));
  }
  return results;
}

// CorpWarDeclaredMsg (27) / AllWarDeclaredMsg (5): war was declared, so every
// member of the defending owner is told who declared it. The ParamWarOwnersWithCost
// formatter renders a cost clause only when `cost` is truthy; the defender is
// informed at no cost, so cost is 0.
function createWarDeclaredNotifications(war, options = {}) {
  return notifyWarDefenderMembers(
    war,
    NOTIFICATION_TYPE.CORP_WAR_DECLARED,
    NOTIFICATION_TYPE.ALL_WAR_DECLARED,
    { cost: 0 },
    options,
  );
}

// DeclareWar (typeID 121): the aggressor side of a war declaration — every member
// of the declaring owner is told that one of their own (charID) declared war on
// the defender. Distinct from the defender's CorpWar/AllWarDeclaredMsg, so the two
// do not overlap. The client renders charName/entityName/defenderName from charID/
// entityID/defenderID. Only emitted when a declaring character is known (genuine
// corp/alliance declarations, not system- or vote-created wars).
function createWarDeclarationActorNotifications(war, declaredByCharacterID, options = {}) {
  const declaredByID = normalizePositiveInteger(war && war.declaredByID, null);
  const againstID = normalizePositiveInteger(war && war.againstID, null);
  const charID = normalizePositiveInteger(declaredByCharacterID, null);
  if (!declaredByID || !againstID || !charID) {
    return [];
  }
  const recipients = collectWarOwnerCharacterIDs(declaredByID);
  if (!recipients.length) {
    return [];
  }
  const data = {
    defenderID: againstID,
    entityID: declaredByID,
    charID,
  };
  const results = [];
  for (const characterID of recipients) {
    results.push(createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.DECLARE_WAR,
      senderID: charID,
      groupID: NOTIFICATION_GROUP.WAR,
      processed: false,
      data,
      requireDurable: options.requireDurable === true,
      idempotencyKey: options.idempotencyKeyPrefix
        ? `${options.idempotencyKeyPrefix}:${NOTIFICATION_TYPE.DECLARE_WAR}:${characterID}`
        : undefined,
    }));
  }
  return results;
}

function emitWarDeclarationNotifications(war, declaredByCharacterID, requireDurable = false) {
  const options = {
    idempotencyKeyPrefix: war.creationKey ? `war-declaration-notice:${war.creationKey}` : "",
    requireDurable,
  };
  notifyWarChanged(null, cloneValue(war));
  const results = [
    ...createWarDeclaredNotifications(war, options),
    ...createWarDeclarationActorNotifications(war, declaredByCharacterID, options),
  ];
  if (!normalizeBoolean(war.mutual, false)) {
    const structure = resolveWarHQStructure(war);
    results.push(...warNotificationCenter.notifyModernWarDeclared(war, { ...options, structure }));
    results.push(...warNotificationCenter.notifyWarDeclaredV2(war, { ...options, structure }));
  }
  if (requireDurable && (results.some(result => result?.success !== true) ||
      require("../../gameStore").flushTableSync("notifications")?.success !== true)) {
    throw Error("WAR_DECLARATION_NOTIFICATIONS_PENDING");
  }
}

// CorpWarSurrenderMsg (29) / AllWarSurrenderMsg (6): a surrender was accepted and
// the war ended. Uses the ParamWarOwners shape (no cost), same defender-side
// recipient as the declared/retracted notices.
function createWarSurrenderNotifications(war, options = {}) {
  notifyWarDefenderMembers(
    war,
    NOTIFICATION_TYPE.CORP_WAR_SURRENDER,
    NOTIFICATION_TYPE.ALL_WAR_SURRENDER,
    {},
    options,
  );
}

const MASTER_WALLET_ACCOUNT_KEY = 1000;

// An aggressive war's first week is paid when it is declared, from the
// declaring corporation's master wallet (for an alliance, its executor's): the
// declare window's cost page (UI/Corporations/Wars/WarDeclareCost) and the war
// bills tooltip call it the first week's pre-payment, and the weekly bill
// covers week two on. The journal entry is refWarFee, naming the defender. A
// wallet that cannot pay refuses the declaration: the result carries the
// NotEnoughMoneyCorp values and no war is made.
async function chargeWarDeclarationFee({ payerCorporationID, againstID, commandID = null } = {}) {
  const payerID = normalizePositiveInteger(payerCorporationID, null);
  const defenderID = normalizePositiveInteger(againstID, null);
  if (!payerID || !defenderID) {
    return { success: false, errorMsg: "INVALID_WAR_FEE_PAYER" };
  }
  const { JOURNAL_ENTRY_TYPE } = require(path.join(__dirname, "../account/walletState"));
  const corporationWallet = require(path.join(__dirname, "./corpWalletState"));
  const result = await corporationWallet.adjustCorporationWalletDivisionBalanceAsync(
    payerID,
    MASTER_WALLET_ACCOUNT_KEY,
    -COST_OF_WAR,
    {
      entryTypeID: JOURNAL_ENTRY_TYPE.WAR_FEE,
      ownerID1: payerID,
      ownerID2: CONCORD_CORPORATION_ID,
      referenceID: defenderID,
      description: `War declaration fee against ${defenderID}`,
      ...(commandID ? { idempotencyKey: commandID } : {}),
    },
    { source: "war-declaration-fee", ...(commandID ? { commandID, idempotencyKey: commandID } : {}) },
  );
  if (result && result.success) {
    return result;
  }
  if (result && result.errorMsg === "INSUFFICIENT_FUNDS") {
    const corporation = getCorporationRecord(payerID);
    return {
      ...result,
      userError: {
        owner: String(corporation && corporation.corporationName || payerID),
        amount: COST_OF_WAR,
        division: String(getCorporationDivisionNames(payerID)[8] || "Master Wallet"),
        balance: Number(result.data && result.data.balance || 0),
      },
    };
  }
  return result || { success: false, errorMsg: "WAR_FEE_FAILED" };
}

function createWarRecord({
  declaredByID,
  againstID,
  warHQ = null,
  mutual = false,
  reward = 0,
  createdFromWarID = null,
  billID = null,
  openForAllies = false,
  timeDeclared = null,
  timeStarted = null,
  timeFinished = null,
  declaredByCharacterID = null,
  creationKey = null,
  requireDurable = false,
} = {}) {
  const attackerID = normalizePositiveInteger(declaredByID, null);
  const defenderID = normalizePositiveInteger(againstID, null);
  if (!attackerID || !defenderID || attackerID === defenderID) {
    return null;
  }

  const key = String(creationKey || "").trim();
  const creationRequest = key ? {
    declaredByID: attackerID, againstID: defenderID,
    warHQID: normalizePositiveInteger(warHQ, null), billID: normalizePositiveInteger(billID, null),
    timeDeclared: String(timeDeclared), mutual: normalizeBoolean(mutual, false) ? 1 : 0,
    declaredByCharacterID: normalizePositiveInteger(declaredByCharacterID, null),
  } : null;
  if (key) {
    const previous = Object.values(ensureRuntimeInitialized().wars || {}).find(war => war.creationKey === key);
    if (previous) {
      if (!isDeepStrictEqual(previous.creationRequest, creationRequest)) throw Error("WAR_CREATION_KEY_CONFLICT");
      if (requireDurable && require("../../gameStore").flushTableSync("corporationRuntime")?.success !== true) {
        throw Error("WAR_DECLARATION_FLUSH_PENDING");
      }
      emitWarDeclarationNotifications(previous, declaredByCharacterID, requireDurable);
      return cloneValue(previous);
    }
  }

  let nextWarID = null;
  const writeResult = updateRuntimeState((runtimeTable) => {
    if (key) runtimeTable = cloneValue(runtimeTable);
    nextWarID = normalizePositiveInteger(runtimeTable._meta.nextWarID, 1) || 1;
    runtimeTable._meta.nextWarID = nextWarID + 1;
    const declaredAt = timeDeclared ? BigInt(String(timeDeclared)) : currentFileTime();
    const startedAt =
      timeStarted !== null && timeStarted !== undefined
        ? BigInt(String(timeStarted))
        : normalizeBoolean(mutual, false)
          ? declaredAt
          : declaredAt + WAR_SPOOLUP;
    runtimeTable.wars[String(nextWarID)] = {
      warID: nextWarID,
      ...(key ? { creationKey: key, creationRequest } : {}),
      declaredByID: attackerID,
      againstID: defenderID,
      warHQID: normalizePositiveInteger(warHQ, null),
      timeDeclared: declaredAt.toString(),
      timeStarted: startedAt.toString(),
      timeFinished:
        timeFinished !== null && timeFinished !== undefined
          ? String(timeFinished)
          : null,
      retracted: null,
      retractedBy: null,
      billID: normalizePositiveInteger(billID, null),
      mutual: normalizeBoolean(mutual, false) ? 1 : 0,
      fightingLegalNotified: normalizeBoolean(mutual, false) ? 1 : 0,
      openForAllies: normalizeBoolean(openForAllies, false) ? 1 : 0,
      allies: {},
      createdFromWarID: normalizePositiveInteger(createdFromWarID, null),
      reward: Number(reward || 0),
    };
    return runtimeTable;
  });
  if (writeResult && writeResult.success) {
    markWarIndexesDirty();
  }
  if (requireDurable && (writeResult?.success !== true ||
      require("../../gameStore").flushTableSync("corporationRuntime")?.success !== true)) {
    throw Error("WAR_DECLARATION_FLUSH_PENDING");
  }
  const nextRecord = getWarRecord(nextWarID);
  if (nextRecord) {
    emitWarDeclarationNotifications(nextRecord, declaredByCharacterID, requireDurable);
  }
  return nextRecord;
}

// Alliance departures do not declare another war. TQ creates a distinct war row
// whose legal-combat dates and direct provenance come from the alliance war.
// Keep that write here, beside the war ID allocator/index invalidation, so a
// durable departure retry cannot allocate a second copy or accidentally emit the
// normal declaration notifications.
function createInheritedWarRecord({
  operationID,
  sourceWar,
  allianceID,
  corporationID,
  timeFinished,
} = {}) {
  const normalizedOperationID = String(operationID || "").trim();
  const sourceWarID = normalizePositiveInteger(sourceWar && sourceWar.warID, null);
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (
    !normalizedOperationID ||
    !sourceWarID ||
    !numericAllianceID ||
    !numericCorporationID
  ) {
    return { success: false, errorMsg: "INVALID_INHERITED_WAR" };
  }

  const allianceIsAggressor =
    normalizePositiveInteger(sourceWar.declaredByID, null) === numericAllianceID;
  const allianceIsDefender =
    normalizePositiveInteger(sourceWar.againstID, null) === numericAllianceID;
  if (allianceIsAggressor === allianceIsDefender) {
    return { success: false, errorMsg: "INHERITED_WAR_SOURCE_MISMATCH" };
  }

  const declaredByID = allianceIsAggressor
    ? numericCorporationID
    : normalizePositiveInteger(sourceWar.declaredByID, null);
  const againstID = allianceIsDefender
    ? numericCorporationID
    : normalizePositiveInteger(sourceWar.againstID, null);
  if (!declaredByID || !againstID || declaredByID === againstID) {
    return { success: false, errorMsg: "INVALID_INHERITED_WAR_OWNERS" };
  }

  const inheritanceKey = `${normalizedOperationID}:principal:${sourceWarID}`;
  const declaredAt = normalizeFiletimeBigInt(
    sourceWar.timeDeclared,
    currentFileTime(),
  );
  const startedAt = normalizeFiletimeBigInt(sourceWar.timeStarted, declaredAt);
  const inheritedFinish = Object.prototype.hasOwnProperty.call(
    arguments[0] || {},
    "timeFinished",
  )
    ? timeFinished
    : sourceWar.timeFinished;
  let nextWarID = null;
  let duplicate = false;
  let fingerprintError = null;
  const writeResult = updateRuntimeState((runtimeTable) => {
    runtimeTable.wars =
      runtimeTable.wars && typeof runtimeTable.wars === "object"
        ? runtimeTable.wars
        : {};
    const existing = Object.values(runtimeTable.wars).find(
      (war) => String(war && war.inheritanceKey || "") === inheritanceKey,
    );
    if (existing) {
      if (
        normalizePositiveInteger(existing.createdFromWarID, null) !== sourceWarID ||
        normalizePositiveInteger(existing.inheritedFromAllianceID, null) !==
          numericAllianceID ||
        normalizePositiveInteger(existing.declaredByID, null) !== declaredByID ||
        normalizePositiveInteger(existing.againstID, null) !== againstID ||
        String(existing.timeDeclared) !== declaredAt.toString() ||
        String(existing.timeStarted) !== startedAt.toString() ||
        normalizeBoolean(existing.mutual, false) !==
          normalizeBoolean(sourceWar.mutual, false)
      ) {
        fingerprintError = "INHERITED_WAR_OPERATION_CONFLICT";
        return runtimeTable;
      }
      nextWarID = normalizePositiveInteger(existing.warID, null);
      duplicate = true;
      return runtimeTable;
    }

    nextWarID = normalizePositiveInteger(runtimeTable._meta.nextWarID, 1) || 1;
    runtimeTable._meta.nextWarID = nextWarID + 1;
    runtimeTable.wars[String(nextWarID)] = {
      warID: nextWarID,
      declaredByID,
      againstID,
      // A defender-side copy keeps the unchanged aggressor and its HQ. An
      // attacker-side copy cannot point at an alliance-mate's structure: the
      // inherited war is guaranteed through its paid cycle even when that HQ
      // belongs to a corporation which remains in the alliance.
      warHQID: allianceIsDefender
        ? normalizePositiveInteger(sourceWar.warHQID, null)
        : null,
      timeDeclared: declaredAt.toString(),
      timeStarted: startedAt.toString(),
      timeFinished:
        inheritedFinish !== null && inheritedFinish !== undefined
          ? normalizeFiletimeBigInt(inheritedFinish, 0n).toString()
          : null,
      retracted: sourceWar.retracted ? String(sourceWar.retracted) : null,
      retractedBy: normalizePositiveInteger(sourceWar.retractedBy, null),
      billID: null,
      mutual: normalizeBoolean(sourceWar.mutual, false) ? 1 : 0,
      fightingLegalNotified: normalizeBoolean(
        sourceWar.fightingLegalNotified,
        false,
      ) ? 1 : 0,
      openForAllies: normalizeBoolean(sourceWar.openForAllies, false) ? 1 : 0,
      allies:
        sourceWar.allies && typeof sourceWar.allies === "object"
          ? cloneValue(sourceWar.allies)
          : {},
      createdFromWarID: sourceWarID,
      sourceCreatedFromWarID: normalizePositiveInteger(
        sourceWar.createdFromWarID,
        null,
      ),
      inheritedFromAllianceID: numericAllianceID,
      inheritedWarHQID: normalizePositiveInteger(sourceWar.warHQID, null),
      inheritanceOperationID: normalizedOperationID,
      inheritanceKey,
      reward: Number(sourceWar.reward || 0),
    };
    return runtimeTable;
  });
  if (fingerprintError) {
    return { success: false, errorMsg: fingerprintError };
  }
  if (!writeResult || writeResult.success !== true || !nextWarID) {
    return {
      success: false,
      errorMsg: (writeResult && writeResult.errorMsg) || "INHERITED_WAR_WRITE_FAILED",
    };
  }
  markWarIndexesDirty();
  const war = getWarRecord(nextWarID);
  if (!duplicate && war) {
    notifyWarChanged(null, cloneValue(war));
  }
  return {
    success: true,
    duplicate,
    data: { war },
  };
}

// CorpWarRetractedMsg (30) / AllWarRetractedMsg (7): a war was retracted by the
// aggressor, so every member of the defending owner is told. ParamWarOwners shape
// (no cost).
function createWarRetractedNotifications(war) {
  notifyWarDefenderMembers(
    war,
    NOTIFICATION_TYPE.CORP_WAR_RETRACTED,
    NOTIFICATION_TYPE.ALL_WAR_RETRACTED,
  );
}

function updateWarRecord(warID, updater) {
  const numericWarID = normalizePositiveInteger(warID, null);
  if (!numericWarID) {
    return null;
  }
  const previousRecord = getWarRecord(numericWarID);
  const writeResult = updateRuntimeState((runtimeTable) => {
    const currentRecord = runtimeTable.wars && runtimeTable.wars[String(numericWarID)];
    if (!currentRecord) {
      return runtimeTable;
    }
    const nextRecord =
      typeof updater === "function"
        ? updater(cloneValue(currentRecord)) || currentRecord
        : currentRecord;
    runtimeTable.wars[String(numericWarID)] = nextRecord;
    return runtimeTable;
  });
  if (writeResult && writeResult.success) {
    markWarIndexesDirty();
  }
  const nextRecord = getWarRecord(numericWarID);
  if (previousRecord || nextRecord) {
    notifyWarChanged(cloneValue(previousRecord), cloneValue(nextRecord));
  }
  // CorpWarRetractedMsg (30) / AllWarRetractedMsg (7): emit once, on the
  // transition into the retracted state.
  if (
    nextRecord &&
    nextRecord.retracted &&
    !(previousRecord && previousRecord.retracted)
  ) {
    createWarRetractedNotifications(nextRecord);
    if (normalizeBoolean(nextRecord.mutual, false)) {
      warNotificationCenter.notifyMutualWarRetracted(nextRecord);
    }
  }
  return nextRecord;
}

function endWarWithReason(warID, options = {}) {
  const numericWarID = normalizePositiveInteger(warID, null);
  if (!numericWarID) {
    return null;
  }
  const now = normalizeNowFiletime(options);
  const finishAt =
    options.finishAtFiletime !== undefined && options.finishAtFiletime !== null
      ? normalizeFiletimeBigInt(options.finishAtFiletime, now)
      : options.cooldown
        ? now + WAR_COOLDOWN
        : now;
  const peaceReason =
    options.peaceReason === null || options.peaceReason === undefined
      ? null
      : Number(options.peaceReason);
  let endReason =
    options.endReason === null || options.endReason === undefined
      ? null
      : Number(options.endReason);
  if (endReason === null && options.retracted) {
    endReason = ENDED_RETRACTED;
  }
  let changed = null;
  const writeResult = updateRuntimeState((runtimeTable) => {
    runtimeTable.wars =
      runtimeTable.wars && typeof runtimeTable.wars === "object"
        ? runtimeTable.wars
        : {};
    const war = runtimeTable.wars[String(numericWarID)];
    if (!war || war.timeFinished) {
      return runtimeTable;
    }
    const previousWar = cloneValue(war);
    war.timeFinished = finishAt.toString();
    if (endReason !== null) {
      war.endReason = endReason;
    }
    if (options.retracted) {
      war.retracted = now.toString();
      war.retractedBy = normalizePositiveInteger(options.retractedBy, null);
      war.retractedByCharacterID = normalizePositiveInteger(
        options.retractedByCharacterID,
        null,
      );
    }
    if (peaceReason !== null) {
      ensurePeaceTreatyRuntime(runtimeTable);
      createPeaceTreatyRecord(runtimeTable, {
        warID: war.warID,
        ownerID: war.declaredByID,
        otherOwnerID: war.againstID,
        peaceReason,
        now,
      });
      createPeaceTreatyRecord(runtimeTable, {
        warID: war.warID,
        ownerID: war.againstID,
        otherOwnerID: war.declaredByID,
        peaceReason,
        now,
      });
    }
    changed = {
      previousWar,
      nextWar: cloneValue(war),
    };
    return runtimeTable;
  });
  if (!writeResult || !writeResult.success || !changed) {
    return null;
  }
  markWarIndexesDirty();
  notifyWarChanged(changed.previousWar, changed.nextWar);
  if (changed.nextWar.retracted && !changed.previousWar.retracted) {
    createWarRetractedNotifications(changed.nextWar);
    if (normalizeBoolean(changed.nextWar.mutual, false)) {
      warNotificationCenter.notifyMutualWarRetracted(changed.nextWar);
    }
  }
  if (options.hqRemovedStructure) {
    createWarHQRemovedNotifications(changed.nextWar, options.hqRemovedStructure, now);
  }
  if (endReason === ENDED_WAR_HQ_SYSTEM_SECURITY_DROP) {
    warNotificationCenter.notifyWarEndedHqSecurityDrop(
      changed.nextWar,
      options.hqRemovedStructure || resolveWarHQStructure(changed.nextWar),
      { endDate: changed.nextWar.timeFinished },
    );
  } else if (endReason === ENDED_UNPAID_BILL) {
    warNotificationCenter.notifyWarRetractedByConcord(changed.nextWar, {
      endDate: changed.nextWar.timeFinished,
    });
  } else if (
    endReason === ENDED_CORP_DELETED ||
    endReason === ENDED_ALLIANCE_DELETED ||
    endReason === ENDED_HQ_OWNER_LEFT
  ) {
    warNotificationCenter.notifyWarConcordInvalidates(changed.nextWar, {
      created: changed.nextWar.timeFinished,
    });
    warNotificationCenter.notifyWarInvalid(changed.nextWar, {
      endDate: changed.nextWar.timeFinished,
    });
  }
  return cloneValue(changed.nextWar);
}

function endWarsForLostWarHQ(structure, options = {}) {
  const structureID = normalizePositiveInteger(
    structure && structure.structureID,
    null,
  );
  if (!structureID) {
    return [];
  }
  const now = options.nowFiletime
    ? normalizeFiletimeBigInt(options.nowFiletime, currentFileTime())
    : options.nowMs !== undefined
      ? msToFileTime(options.nowMs)
      : currentFileTime();
  const cooldownEnd = now + WAR_COOLDOWN;
  const changedWars = [];
  const writeResult = updateRuntimeState((runtimeTable) => {
    runtimeTable.wars =
      runtimeTable.wars && typeof runtimeTable.wars === "object"
        ? runtimeTable.wars
        : {};
    ensurePeaceTreatyRuntime(runtimeTable);
    for (const war of Object.values(runtimeTable.wars)) {
      if (
        !war ||
        normalizePositiveInteger(war.warHQID, null) !== structureID ||
        normalizeBoolean(war.mutual, false) ||
        war.timeFinished
      ) {
        continue;
      }
      const previousWar = cloneValue(war);
      war.timeFinished = cooldownEnd.toString();
      war.endReason = ENDED_WARHQ_GONE;
      createPeaceTreatyRecord(runtimeTable, {
        warID: war.warID,
        ownerID: war.declaredByID,
        otherOwnerID: war.againstID,
        peaceReason: PEACE_REASON_HQ_REMOVED,
        now,
      });
      createPeaceTreatyRecord(runtimeTable, {
        warID: war.warID,
        ownerID: war.againstID,
        otherOwnerID: war.declaredByID,
        peaceReason: PEACE_REASON_HQ_REMOVED,
        now,
      });
      changedWars.push({
        previousWar,
        nextWar: cloneValue(war),
      });
    }
    return runtimeTable;
  });
  if (!writeResult || !writeResult.success || changedWars.length <= 0) {
    return [];
  }
  markWarIndexesDirty();
  for (const { previousWar, nextWar } of changedWars) {
    notifyWarChanged(previousWar, nextWar);
    createWarHQRemovedNotifications(nextWar, structure, now);
  }
  return changedWars.map(({ nextWar }) => cloneValue(nextWar));
}

function findWarForBill(bill) {
  const billID = normalizePositiveInteger(bill && bill.billID, null);
  if (!billID) {
    return null;
  }
  const warID = normalizePositiveInteger(bill && bill.externalID2, null);
  const directWar = warID ? getWarRecord(warID) : null;
  if (directWar && Number(directWar.billID) === billID) {
    return directWar;
  }
  return listAllWars().find((war) => Number(war && war.billID) === billID) || null;
}

function renewPaidWarBill(war, bill) {
  const nextBill = createNextWarBill(war, bill && bill.dueDateTime);
  updateWarRecord(war.warID, (record) => ({
    ...record,
    billID: nextBill ? nextBill.billID : null,
  }));
  markBillProcessed(bill.billID, "renewed", {
    renewedBillID: nextBill ? nextBill.billID : 0,
  });
  return {
    billID: bill.billID,
    warID: war.warID,
    action: "renewed",
    renewedBillID: nextBill ? nextBill.billID : 0,
  };
}

function defaultUnpaidWarBill(war, bill, now) {
  const endedWar = endWarWithReason(war.warID, {
    nowFiletime: now,
    endReason: ENDED_UNPAID_BILL,
    peaceReason: PEACE_REASON_UNPAID_BILL,
  });
  if (!endedWar) {
    return {
      billID: bill.billID,
      warID: war.warID,
      action: "blocked",
    };
  }
  markBillProcessed(bill.billID, "defaulted");
  return {
    billID: bill.billID,
    warID: war.warID,
    action: "defaulted",
  };
}

async function processDueWarBills(options = {}) {
  const now = normalizeNowFiletime(options);
  const targetBillID = normalizePositiveInteger(options.billID, null);
  const dueBills = listDueBills({
    nowFileTime: now,
    billTypeID: BILL_TYPE_WAR,
  }).filter((bill) => !targetBillID || Number(bill.billID) === targetBillID);
  const processed = [];

  for (const dueBill of dueBills) {
    const war = findWarForBill(dueBill);
    if (!war) {
      const pendingDeclaration = Object.values(ensureRuntimeInitialized().warDeclarations || {})
        .some(operation => operation?.status === "pending" && operation.operationID &&
          dueBill.creationKey === `war-declaration:${operation.operationID}:bill`);
      if (pendingDeclaration) throw Error("WAR_DECLARATION_PENDING");
      markBillProcessed(dueBill.billID, "orphaned");
      processed.push({
        billID: dueBill.billID,
        action: "orphaned",
      });
      continue;
    }

    if (
      !isAggressiveBillableWar(war) ||
      isWarFinishedOrFinishing(war) ||
      Number(war.billID) !== Number(dueBill.billID)
    ) {
      markBillProcessed(dueBill.billID, "inactive");
      processed.push({
        billID: dueBill.billID,
        warID: war.warID,
        action: "inactive",
      });
      continue;
    }

    let bill = dueBill;
    if (!bill.paid) {
      await tryAutoPayBill(bill.billID);
      bill = getBillRecord(bill.billID) || dueBill;
    }

    if (bill.paid) {
      processed.push(renewPaidWarBill(war, bill));
      continue;
    }

    processed.push(defaultUnpaidWarBill(war, bill, now));
  }

  return {
    processedCount: processed.length,
    processed,
  };
}

// The lifecycle passes below run on every war read, and updateRuntimeState
// clones and rewrites the whole corporation runtime table. Check the cached
// table first and only take the write when some record is actually due.
function someRuntimeRecord(collectionName, predicate) {
  const collection = ensureRuntimeInitialized()[collectionName];
  return Boolean(
    collection &&
      typeof collection === "object" &&
      Object.values(collection).some(predicate),
  );
}

function isMutualWarInviteExpired(invite, now) {
  const sentDate = normalizeFiletimeBigInt(invite && invite.sentDate, 0n);
  return sentDate > 0n && sentDate + MUTUAL_WAR_INVITE_EXPIRY <= now;
}

function isWarNegotiationExpired(negotiation, now) {
  if (
    !negotiation ||
    Number(negotiation.negotiationState) !== WAR_NEGOTIATION_STATE_NEW
  ) {
    return false;
  }
  const createdDateTime = normalizeFiletimeBigInt(
    negotiation.createdDateTime,
    0n,
  );
  return createdDateTime > 0n && createdDateTime + WAR_NEGOTIATION_EXPIRY <= now;
}

function isPeaceTreatyExpired(treaty, now) {
  const expiryDate = normalizeFiletimeBigInt(treaty && treaty.expiryDate, 0n);
  return expiryDate > 0n && expiryDate <= now;
}

function isAllyContractFinished(ally, now) {
  const timeFinished = normalizeFiletimeBigInt(ally && ally.timeFinished, 0n);
  return timeFinished > 0n && timeFinished <= now;
}

function hasFinishedAllyContract(war, now) {
  return Boolean(
    war &&
      war.allies &&
      typeof war.allies === "object" &&
      Object.values(war.allies).some((ally) => isAllyContractFinished(ally, now)),
  );
}

function isWarEnteringFightingLegal(war, now) {
  return Boolean(
    war &&
      !normalizeBoolean(war.mutual, false) &&
      !war.fightingLegalNotified &&
      isWarStartedAt(war, now) &&
      !isWarFinishedAt(war, now),
  );
}

function expireMutualWarInvites(now) {
  if (
    !someRuntimeRecord("mutualWarInvites", (invite) =>
      isMutualWarInviteExpired(invite, now))
  ) {
    return 0;
  }
  let removedCount = 0;
  updateRuntimeState((runtimeTable) => {
    runtimeTable.mutualWarInvites =
      runtimeTable.mutualWarInvites &&
      typeof runtimeTable.mutualWarInvites === "object"
        ? runtimeTable.mutualWarInvites
        : {};
    for (const [key, invite] of Object.entries(runtimeTable.mutualWarInvites)) {
      if (isMutualWarInviteExpired(invite, now)) {
        warNotificationCenter.notifyMutualWarExpired({
          declaredByID: normalizePositiveInteger(invite && invite.fromOwnerID, 0) || 0,
          againstID: normalizePositiveInteger(invite && invite.toOwnerID, 0) || 0,
        }, { numDays: 7 });
        delete runtimeTable.mutualWarInvites[key];
        removedCount += 1;
      }
    }
    return runtimeTable;
  });
  return removedCount;
}

function expireWarNegotiations(now) {
  if (
    !someRuntimeRecord("warNegotiations", (negotiation) =>
      isWarNegotiationExpired(negotiation, now))
  ) {
    return 0;
  }
  let retractedCount = 0;
  updateRuntimeState((runtimeTable) => {
    runtimeTable.warNegotiations =
      runtimeTable.warNegotiations &&
      typeof runtimeTable.warNegotiations === "object"
        ? runtimeTable.warNegotiations
        : {};
    for (const negotiation of Object.values(runtimeTable.warNegotiations)) {
      if (isWarNegotiationExpired(negotiation, now)) {
        negotiation.negotiationState = WAR_NEGOTIATION_STATE_RETRACTED;
        negotiation.timeRetracted = now.toString();
        retractedCount += 1;
      }
    }
    return runtimeTable;
  });
  return retractedCount;
}

function expirePeaceTreaties(now) {
  if (
    !someRuntimeRecord("peaceTreaties", (treaty) =>
      isPeaceTreatyExpired(treaty, now))
  ) {
    return 0;
  }
  let removedCount = 0;
  updateRuntimeState((runtimeTable) => {
    runtimeTable.peaceTreaties =
      runtimeTable.peaceTreaties && typeof runtimeTable.peaceTreaties === "object"
        ? runtimeTable.peaceTreaties
        : {};
    for (const [key, treaty] of Object.entries(runtimeTable.peaceTreaties)) {
      if (isPeaceTreatyExpired(treaty, now)) {
        delete runtimeTable.peaceTreaties[key];
        removedCount += 1;
      }
    }
    return runtimeTable;
  });
  return removedCount;
}

function expireWarAllies(now) {
  if (!someRuntimeRecord("wars", (war) => hasFinishedAllyContract(war, now))) {
    return 0;
  }
  const changedWars = [];
  const writeResult = updateRuntimeState((runtimeTable) => {
    runtimeTable.wars =
      runtimeTable.wars && typeof runtimeTable.wars === "object"
        ? runtimeTable.wars
        : {};
    for (const war of Object.values(runtimeTable.wars)) {
      if (!war || !war.allies || typeof war.allies !== "object") {
        continue;
      }
      const previousWar = cloneValue(war);
      let changed = false;
      for (const [allyID, ally] of Object.entries(war.allies)) {
        if (isAllyContractFinished(ally, now)) {
          warNotificationCenter.notifyAllyContractCancelled(war, allyID, ally);
          delete war.allies[allyID];
          changed = true;
        }
      }
      if (changed) {
        changedWars.push({
          previousWar,
          nextWar: cloneValue(war),
        });
      }
    }
    return runtimeTable;
  });
  if (!writeResult || !writeResult.success || changedWars.length <= 0) {
    return 0;
  }
  markWarIndexesDirty();
  for (const { previousWar, nextWar } of changedWars) {
    notifyWarChanged(previousWar, nextWar);
  }
  return changedWars.length;
}

function notifyWarsEnteringFightingLegal(now) {
  if (!someRuntimeRecord("wars", (war) => isWarEnteringFightingLegal(war, now))) {
    return 0;
  }
  const changedWars = [];
  const writeResult = updateRuntimeState((runtimeTable) => {
    runtimeTable.wars =
      runtimeTable.wars && typeof runtimeTable.wars === "object"
        ? runtimeTable.wars
        : {};
    for (const war of Object.values(runtimeTable.wars)) {
      if (!isWarEnteringFightingLegal(war, now)) {
        continue;
      }
      war.fightingLegalNotified = 1;
      changedWars.push(cloneValue(war));
    }
    return runtimeTable;
  });
  if (!writeResult || !writeResult.success || changedWars.length <= 0) {
    return 0;
  }
  for (const war of changedWars) {
    warNotificationCenter.notifyWarFightingLegal(war);
  }
  return changedWars.length;
}

function inferDeletedOwnerEndReason(ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, 0);
  return numericOwnerID >= 99000000 ? ENDED_ALLIANCE_DELETED : ENDED_CORP_DELETED;
}

function resolveWarHQEndReason(war, structure) {
  if (!structure || structure.destroyedAt || !isDockableUpwellWarHQ(structure)) {
    return {
      endReason: ENDED_WARHQ_GONE,
      peaceReason: PEACE_REASON_HQ_REMOVED,
      cooldown: true,
      hqRemovedStructure: structure || null,
    };
  }

  if (!isHighSecurityWarHQ(structure)) {
    return {
      endReason: ENDED_WAR_HQ_SYSTEM_SECURITY_DROP,
      peaceReason: PEACE_REASON_HQ_REMOVED,
      cooldown: true,
      hqRemovedStructure: structure,
    };
  }

  const declaredByID = normalizePositiveInteger(war && war.declaredByID, null);
  const ownerCorporationID = getStructureOwnerCorporationID(structure);
  const declaredByAlliance = getAllianceRecord(declaredByID);
  if (declaredByAlliance) {
    const ownerCorporation = getCorporationRecord(ownerCorporationID);
    if (
      !ownerCorporation ||
      Number(ownerCorporation.allianceID || 0) !== Number(declaredByID)
    ) {
      return {
        endReason: ENDED_HQ_OWNER_LEFT,
        peaceReason: PEACE_REASON_HQ_OWNER_LEFT_ALLIANCE,
        cooldown: true,
      };
    }
    return null;
  }

  if (ownerCorporationID !== declaredByID) {
    return {
      endReason: ENDED_HQ_OWNER_LEFT,
      peaceReason: PEACE_REASON_HQ_REMOVED,
      cooldown: true,
    };
  }

  return null;
}

function endWarsForDeletedOwners(now) {
  let endedCount = 0;
  for (const war of listAllWars()) {
    if (!isAggressiveBillableWar(war) || isWarFinishedOrFinishing(war)) {
      continue;
    }
    const declaredByID = normalizePositiveInteger(war.declaredByID, null);
    const againstID = normalizePositiveInteger(war.againstID, null);
    if (!ownerExists(declaredByID)) {
      if (
        endWarWithReason(war.warID, {
          nowFiletime: now,
          endReason: inferDeletedOwnerEndReason(declaredByID),
        })
      ) {
        endedCount += 1;
      }
      continue;
    }
    if (!ownerExists(againstID)) {
      if (
        endWarWithReason(war.warID, {
          nowFiletime: now,
          endReason: inferDeletedOwnerEndReason(againstID),
        })
      ) {
        endedCount += 1;
      }
    }
  }
  return endedCount;
}

function endWarsForInvalidWarHQs(now) {
  const structureState = getStructureStateService();
  let endedCount = 0;
  for (const war of listAllWars()) {
    if (!isAggressiveBillableWar(war) || isWarFinishedOrFinishing(war)) {
      continue;
    }
    const warHQID = normalizePositiveInteger(war.warHQID, null);
    if (!warHQID) {
      continue;
    }
    const structure = structureState.getStructureByID(warHQID, { refresh: false });
    const endState = resolveWarHQEndReason(war, structure);
    if (!endState) {
      continue;
    }
    const endedWar = endWarWithReason(war.warID, {
      nowFiletime: now,
      endReason: endState.endReason,
      peaceReason: endState.peaceReason,
      cooldown: endState.cooldown,
      hqRemovedStructure: endState.hqRemovedStructure,
    });
    if (endedWar) {
      endedCount += 1;
    }
  }
  return endedCount;
}

function createLeavingCorporationPeaceTreaties(corporationID, allianceID, now) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericCorporationID || !numericAllianceID) {
    return 0;
  }
  let createdCount = 0;
  updateRuntimeState((runtimeTable) => {
    runtimeTable.wars =
      runtimeTable.wars && typeof runtimeTable.wars === "object"
        ? runtimeTable.wars
        : {};
    ensurePeaceTreatyRuntime(runtimeTable);
    for (const war of Object.values(runtimeTable.wars)) {
      if (!isAggressiveBillableWar(war) || isWarFinishedOrFinishing(war)) {
        continue;
      }
      let counterpartyID = null;
      if (Number(war.declaredByID) === numericAllianceID) {
        counterpartyID = normalizePositiveInteger(war.againstID, null);
      } else if (Number(war.againstID) === numericAllianceID) {
        counterpartyID = normalizePositiveInteger(war.declaredByID, null);
      }
      if (!counterpartyID) {
        continue;
      }
      const beforeCount = Object.keys(runtimeTable.peaceTreaties || {}).length;
      createPeaceTreatyRecord(runtimeTable, {
        warID: war.warID,
        ownerID: numericCorporationID,
        otherOwnerID: counterpartyID,
        peaceReason: PEACE_REASON_CORP_LEFT_ALLIANCE,
        now,
      });
      createPeaceTreatyRecord(runtimeTable, {
        warID: war.warID,
        ownerID: counterpartyID,
        otherOwnerID: numericCorporationID,
        peaceReason: PEACE_REASON_CORP_LEFT_ALLIANCE,
        now,
      });
      createdCount += Math.max(
        0,
        Object.keys(runtimeTable.peaceTreaties || {}).length - beforeCount,
      );
    }
    return runtimeTable;
  });
  return createdCount;
}

function handleCorporationLeftAlliance({
  corporationID,
  allianceID,
  nowFiletime = currentFileTime(),
} = {}) {
  const now = normalizeFiletimeBigInt(nowFiletime, currentFileTime());
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericCorporationID || !numericAllianceID) {
    return {
      endedCount: 0,
      treatyCount: 0,
      inheritedAllyCount: 0,
    };
  }

  let endedCount = 0;
  let inheritedAllyCount = 0;
  for (const war of listAllWars()) {
    const allianceAlly = war && war.allies && war.allies[String(numericAllianceID)];
    if (
      !isWarFinishedOrFinishing(war) &&
      isAllyActiveAt(allianceAlly, now)
    ) {
      warNotificationCenter.notifyWarInherited(war, {
        allianceID: numericAllianceID,
        quitterID: numericCorporationID,
        opponentID: normalizePositiveInteger(war && war.declaredByID, 0) || 0,
        isAlly: true,
      });
      inheritedAllyCount += 1;
    }

    const createdFromWarID = normalizePositiveInteger(war && war.createdFromWarID, null);
    if (
      createdFromWarID &&
      isAggressiveBillableWar(war) &&
      !isWarFinishedOrFinishing(war) &&
      (Number(war.declaredByID) === numericCorporationID ||
        Number(war.againstID) === numericCorporationID)
    ) {
      if (
        endWarWithReason(war.warID, {
          nowFiletime: now,
          endReason: ENDED_LEFT_ALLIANCE,
          peaceReason: PEACE_REASON_CORP_LEFT_ALLIANCE,
        })
      ) {
        warNotificationCenter.notifyWarInherited(war, {
          allianceID: numericAllianceID,
          quitterID: numericCorporationID,
          opponentID:
            Number(war.declaredByID) === numericCorporationID
              ? normalizePositiveInteger(war.againstID, 0) || 0
              : normalizePositiveInteger(war.declaredByID, 0) || 0,
        });
        endedCount += 1;
      }
      continue;
    }

    if (
      !isAggressiveBillableWar(war) ||
      isWarFinishedOrFinishing(war) ||
      Number(war.declaredByID) !== numericAllianceID
    ) {
      continue;
    }
    const warHQID = normalizePositiveInteger(war.warHQID, null);
    if (!warHQID) {
      continue;
    }
    const structure = getStructureStateService().getStructureByID(warHQID, {
      refresh: false,
    });
    if (getStructureOwnerCorporationID(structure) !== numericCorporationID) {
      continue;
    }
    if (
      endWarWithReason(war.warID, {
        nowFiletime: now,
        endReason: ENDED_HQ_OWNER_LEFT,
        peaceReason: PEACE_REASON_HQ_OWNER_LEFT_ALLIANCE,
        cooldown: true,
      })
    ) {
      endedCount += 1;
    }
  }

  return {
    endedCount,
    inheritedAllyCount,
    treatyCount: createLeavingCorporationPeaceTreaties(
      numericCorporationID,
      numericAllianceID,
      now,
    ),
  };
}

function handleCorporationJoinedAlliance({
  corporationID,
  allianceID,
  nowFiletime = currentFileTime(),
} = {}) {
  const now = normalizeFiletimeBigInt(nowFiletime, currentFileTime());
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericCorporationID || !numericAllianceID) {
    return { notified: false, adoptedCount: 0 };
  }
  const hasLiveAllianceWar = listWarsForOwner(numericAllianceID).some(
    (war) => war && !isWarFinishedAt(war, now),
  );
  let notified = false;
  if (hasLiveAllianceWar) {
    warNotificationCenter.notifyCorporationJoinedAllianceAtWar({
      allianceID: numericAllianceID,
      corporationID: numericCorporationID,
    });
    notified = true;
  }
  let adoptedCount = 0;
  for (const war of listAllWars()) {
    if (!war || isWarFinishedAt(war, now)) {
      continue;
    }
    const principalWar =
      Number(war.declaredByID) === numericCorporationID ||
      Number(war.againstID) === numericCorporationID;
    const allyWar = isAllyActiveAt(
      war.allies && war.allies[String(numericCorporationID)],
      now,
    );
    if (!principalWar && !allyWar) {
      continue;
    }
    warNotificationCenter.notifyWarAdopted(war, {
      allianceID: numericAllianceID,
      isAlly: allyWar && !principalWar,
    });
    adoptedCount += 1;
  }
  return { notified, adoptedCount };
}

function processWarLifecycle(options = {}) {
  const now = normalizeNowFiletime(options);
  return {
    billing: {
      deferredToScheduler: true,
      processedCount: 0,
      processed: [],
    },
    expiredMutualInvites: expireMutualWarInvites(now),
    expiredNegotiations: expireWarNegotiations(now),
    expiredPeaceTreaties: expirePeaceTreaties(now),
    expiredAllyWars: expireWarAllies(now),
    fightingLegalWars: notifyWarsEnteringFightingLegal(now),
    deletedOwnerWars: endWarsForDeletedOwners(now),
    invalidWarHQWars: endWarsForInvalidWarHQs(now),
  };
}

function resolveCharacterWarEntityIDs(characterID) {
  const characterState = getCharacterStateService();
  const character =
    characterState && typeof characterState.getCharacterRecord === "function"
      ? characterState.getCharacterRecord(characterID)
      : null;
  const entityIDs = new Set();
  const corporationID = normalizePositiveInteger(
    character && character.corporationID,
    null,
  );
  const allianceID = normalizePositiveInteger(
    character && character.allianceID,
    null,
  );
  if (corporationID) {
    entityIDs.add(corporationID);
  }
  if (allianceID) {
    entityIDs.add(allianceID);
  }
  return entityIDs;
}

function resolveCorporationWarEntityIDs(corporationID) {
  const normalizedCorporationID = normalizePositiveInteger(
    corporationID,
    null,
  );
  const corporation = normalizedCorporationID
    ? getCorporationRecord(normalizedCorporationID)
    : null;
  const entityIDs = new Set();
  if (!corporation || Boolean(corporation.deleted)) {
    return entityIDs;
  }
  entityIDs.add(normalizedCorporationID);
  const allianceID = normalizePositiveInteger(corporation.allianceID, null);
  if (allianceID) {
    entityIDs.add(allianceID);
  }
  return entityIDs;
}

function isAllyActiveAt(ally, now) {
  if (!ally) {
    return false;
  }
  const timeStarted = normalizeFiletimeBigInt(ally.timeStarted, 0n);
  const timeFinished = normalizeFiletimeBigInt(ally.timeFinished, 0n);
  return timeStarted <= now && (timeFinished === 0n || timeFinished > now);
}

// Coffee Edition's owner-index lookup avoids cloning every unrelated war for
// each offensive cycle, while retaining the historical first matching war.
function warsForEntities(entityIDs) {
  const index = ensureWarIndexes();
  const selected = new Map();
  for (const ownerID of entityIDs) {
    for (const war of index.byOwner.get(ownerID) || []) selected.set(war.warID, war);
  }
  return [...selected.values()].sort((left, right) => Number(left.warID) - Number(right.warID));
}

function findActiveWarBetweenWarEntities(leftEntityIDs, rightEntityIDs, options = {}) {
  const now = normalizeNowFiletime(options);
  const left = leftEntityIDs instanceof Set ? leftEntityIDs : new Set(leftEntityIDs || []);
  const right = rightEntityIDs instanceof Set ? rightEntityIDs : new Set(rightEntityIDs || []);
  if (left.size <= 0 || right.size <= 0) {
    return null;
  }

  for (const war of warsForEntities(left)) {
    if (!isWarActiveAt(war, now)) {
      continue;
    }
    const declaredByID = normalizePositiveInteger(war.declaredByID, null);
    const againstID = normalizePositiveInteger(war.againstID, null);
    const leftIsAggressor = left.has(declaredByID);
    const rightIsAggressor = right.has(declaredByID);
    const leftIsDefender = left.has(againstID);
    const rightIsDefender = right.has(againstID);
    if (
      (leftIsAggressor && rightIsDefender) ||
      (leftIsDefender && rightIsAggressor)
    ) {
      return {
        warID: war.warID,
        war: cloneValue(war),
        relationship: "declared-war",
      };
    }

    const activeAllyIDs = Object.entries(war.allies || {})
      .filter(([, ally]) => isAllyActiveAt(ally, now))
      .map(([allyID]) => normalizePositiveInteger(allyID, null))
      .filter(Boolean);
    const leftIsAlly = activeAllyIDs.some((allyID) => left.has(allyID));
    const rightIsAlly = activeAllyIDs.some((allyID) => right.has(allyID));
    if (
      (leftIsAggressor && rightIsAlly) ||
      (rightIsAggressor && leftIsAlly)
    ) {
      return {
        warID: war.warID,
        war: cloneValue(war),
        relationship: "ally-war",
      };
    }
  }

  return null;
}

function findActiveWarBetweenCharacters(attackerCharacterID, targetCharacterID, options = {}) {
  const attackerID = normalizePositiveInteger(attackerCharacterID, null);
  const targetID = normalizePositiveInteger(targetCharacterID, null);
  if (!attackerID || !targetID || attackerID === targetID) {
    return null;
  }
  return findActiveWarBetweenWarEntities(
    resolveCharacterWarEntityIDs(attackerID),
    resolveCharacterWarEntityIDs(targetID),
    options,
  );
}

// Corporation-owned space property cannot be represented by a target
// character. Resolve the corporation (and its alliance) directly so war
// legality stays attached to the actual property principal.
function findActiveWarBetweenCharacterAndCorporation(
  attackerCharacterID,
  targetCorporationID,
  options = {},
) {
  const attackerID = normalizePositiveInteger(attackerCharacterID, null);
  const corporationID = normalizePositiveInteger(targetCorporationID, null);
  if (!attackerID || !corporationID) {
    return null;
  }
  return findActiveWarBetweenWarEntities(
    resolveCharacterWarEntityIDs(attackerID),
    resolveCorporationWarEntityIDs(corporationID),
    options,
  );
}

function hasActiveWarForCharacter(characterID, options = {}) {
  const normalizedCharacterID = normalizePositiveInteger(characterID, null);
  if (!normalizedCharacterID) {
    return false;
  }

  const now = normalizeNowFiletime(options);
  for (const ownerID of resolveCharacterWarEntityIDs(normalizedCharacterID)) {
    for (const war of listWarsForOwner(ownerID)) {
      if (!isWarActiveAt(war, now)) {
        continue;
      }
      if (
        normalizePositiveInteger(war.declaredByID, null) === ownerID ||
        normalizePositiveInteger(war.againstID, null) === ownerID ||
        isAllyActiveAt(war.allies && war.allies[String(ownerID)], now)
      ) {
        return true;
      }
    }
  }
  return false;
}

function areCharactersLegalWarOpponents(attackerCharacterID, targetCharacterID, options = {}) {
  return Boolean(
    findActiveWarBetweenCharacters(attackerCharacterID, targetCharacterID, options),
  );
}

module.exports = {
  areCharactersLegalWarOpponents,
  createInheritedWarRecord,
  chargeWarDeclarationFee,
  createWarRecord,
  createWarSurrenderNotifications,
  endWarWithReason,
  endWarsForLostWarHQ,
  findActiveWarBetweenCharacterAndCorporation,
  findActiveWarBetweenCharacters,
  hasActiveWarForCharacter,
  getWarRecord,
  handleCorporationJoinedAlliance,
  handleCorporationLeftAlliance,
  listAllWars,
  listAllWarsDescending,
  listWarsForStructure,
  listWarsForOwner,
  processDueWarBills,
  processWarLifecycle,
  updateWarRecord,
  _testing: {
    FILETIME_TICKS_PER_WEEK,
    resetWarIndexes: markWarIndexesDirty,
  },
};
