"use strict";

const path = require("path");

// Phase 0 / 0.C: bounty domain state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const database = require(path.join(__dirname, "../../gameStore"));
const repo = createTableRepository("service:bounty", { strict: true });
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

const TABLE_NAME = "killRights";
const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const DEFAULT_KILL_RIGHT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const KILL_RIGHT_SUSPECT_TIMER_MS = 15 * 60 * 1000;
const DURABLE_PURCHASE_JOB_TYPE = "kill-right.purchase";
const DURABLE_PURCHASE_JOB_PREFIX = "kill-right-purchase:";
const purchaseLanes = new Map();
let durableScheduler = null;

function publishDefaultActivation(data) {
  const activationEffects = require(path.join(
    __dirname,
    "./killRightActivationEffects",
  ));
  return activationEffects.publishPurchasedKillRight(data, {
    durationMs: KILL_RIGHT_SUSPECT_TIMER_MS,
    filetimeToMs,
  });
}

let activationPublisher = publishDefaultActivation;

function getWalletState() {
  return require(path.join(__dirname, "../account/walletState"));
}

const ERROR = Object.freeze({
  NO_VALID_KILL_RIGHT: "NO_VALID_KILL_RIGHT",
  KILL_RIGHT_EXPIRED: "KILL_RIGHT_EXPIRED",
  KILL_RIGHT_NOT_FOR_SALE: "KILL_RIGHT_NOT_FOR_SALE",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PURCHASE_PENDING: "PURCHASE_PENDING",
});

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.round(numeric * 100) / 100);
}

function filetimeFromMs(ms = Date.now()) {
  return (
    BigInt(Math.max(0, Math.trunc(Number(ms) || 0))) * FILETIME_TICKS_PER_MS +
    FILETIME_UNIX_EPOCH_OFFSET
  ).toString();
}

function filetimeToMs(value, fallback = 0) {
  try {
    const rawValue =
      value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")
        ? value.value
        : value;
    const filetime = BigInt(rawValue);
    if (filetime <= FILETIME_UNIX_EPOCH_OFFSET) {
      return fallback;
    }
    return Number((filetime - FILETIME_UNIX_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS);
  } catch (error) {
    return fallback;
  }
}

function normalizeRestrictedTo(value) {
  if (value === null || value === undefined || value === "open") {
    return null;
  }
  const numericValue = toInteger(value, 0);
  return numericValue > 0 ? numericValue : null;
}

function emptyState() {
  return {
    nextKillRightID: 1,
    nextActivationID: 1,
    nextPurchaseID: 1,
    rights: {},
    activations: {},
    purchases: {},
  };
}

function normalizeKillRight(record = {}, fallbackID = 0) {
  const killRightID = toInteger(record.killRightID, toInteger(fallbackID, 0));
  const createdAt = String(record.createdAt || currentFileTime());
  const expiryTime = String(
    record.expiryTime ||
      filetimeFromMs(filetimeToMs(createdAt, Date.now()) + DEFAULT_KILL_RIGHT_EXPIRY_MS),
  );
  const price =
    record.price === null || record.price === undefined
      ? null
      : normalizeMoney(record.price, 0);

  return {
    killRightID,
    fromID: toInteger(record.fromID, 0),
    toID: toInteger(record.toID, 0),
    expiryTime,
    price,
    restrictedTo: normalizeRestrictedTo(record.restrictedTo),
    createdAt,
    soldAt: record.soldAt ? String(record.soldAt) : null,
    saleCancelledAt: record.saleCancelledAt ? String(record.saleCancelledAt) : null,
    usedAt: record.usedAt ? String(record.usedAt) : null,
    usedBy: toInteger(record.usedBy, 0) || null,
    expiredAt: record.expiredAt ? String(record.expiredAt) : null,
    revokedAt: record.revokedAt ? String(record.revokedAt) : null,
    pendingPurchaseID: toInteger(record.pendingPurchaseID, 0) || null,
  };
}

function normalizeActivation(record = {}, fallbackID = 0) {
  const activationID = toInteger(record.activationID, toInteger(fallbackID, 0));
  return {
    activationID,
    killRightID: toInteger(record.killRightID, 0),
    fromID: toInteger(record.fromID, 0),
    toID: toInteger(record.toID, 0),
    activatorID: toInteger(record.activatorID, 0),
    activatedAt: String(record.activatedAt || currentFileTime()),
    expiresAt: String(record.expiresAt || filetimeFromMs(Date.now() + KILL_RIGHT_SUSPECT_TIMER_MS)),
    pricePaid: normalizeMoney(record.pricePaid, 0),
    activationKind: String(record.activationKind || "activate"),
  };
}

function normalizePurchase(record = {}, fallbackID = 0) {
  const purchaseID = toInteger(record.purchaseID, toInteger(fallbackID, 0));
  const killRightID = toInteger(record.killRightID, 0);
  const buyerID = toInteger(record.buyerID, 0);
  const sellerID = toInteger(record.sellerID, 0);
  const activationID = toInteger(record.activationID, 0);
  if (
    purchaseID <= 0 ||
    killRightID <= 0 ||
    buyerID <= 0 ||
    sellerID <= 0 ||
    activationID <= 0
  ) {
    return null;
  }
  return {
    purchaseID,
    killRightID,
    buyerID,
    sellerID,
    targetID: toInteger(record.targetID, 0),
    activationID,
    price: normalizeMoney(record.price, 0),
    paymentApplied: Boolean(record.paymentApplied),
    activationApplied: Boolean(record.activationApplied),
    activatedAt: record.activatedAt ? String(record.activatedAt) : null,
    expiresAt: record.expiresAt ? String(record.expiresAt) : null,
    paymentCommandID: String(
      record.paymentCommandID ||
        `${DURABLE_PURCHASE_JOB_PREFIX}${purchaseID}:payment`,
    ),
    createdAt: String(record.createdAt || currentFileTime()),
  };
}

function normalizeState(rawState = {}) {
  const state = rawState && typeof rawState === "object"
    ? cloneValue(rawState)
    : {};
  const normalized = emptyState();
  normalized.nextKillRightID = Math.max(1, toInteger(state.nextKillRightID, 1));
  normalized.nextActivationID = Math.max(1, toInteger(state.nextActivationID, 1));
  normalized.nextPurchaseID = Math.max(1, toInteger(state.nextPurchaseID, 1));

  const sourceRights =
    state.rights && typeof state.rights === "object"
      ? state.rights
      : state.killRights && typeof state.killRights === "object"
        ? state.killRights
        : {};
  for (const [killRightID, record] of Object.entries(sourceRights)) {
    const normalizedRecord = normalizeKillRight(record, killRightID);
    if (
      normalizedRecord.killRightID > 0 &&
      normalizedRecord.fromID > 0 &&
      normalizedRecord.toID > 0
    ) {
      normalized.rights[String(normalizedRecord.killRightID)] = normalizedRecord;
      normalized.nextKillRightID = Math.max(
        normalized.nextKillRightID,
        normalizedRecord.killRightID + 1,
      );
    }
  }

  const sourceActivations =
    state.activations && typeof state.activations === "object"
      ? state.activations
      : {};
  for (const [activationID, record] of Object.entries(sourceActivations)) {
    const normalizedActivation = normalizeActivation(record, activationID);
    if (
      normalizedActivation.activationID > 0 &&
      normalizedActivation.killRightID > 0 &&
      normalizedActivation.toID > 0 &&
      normalizedActivation.activatorID > 0
    ) {
      normalized.activations[String(normalizedActivation.activationID)] = normalizedActivation;
      normalized.nextActivationID = Math.max(
        normalized.nextActivationID,
        normalizedActivation.activationID + 1,
      );
    }
  }


  const sourcePurchases =
    state.purchases && typeof state.purchases === "object"
      ? state.purchases
      : {};
  for (const [purchaseID, record] of Object.entries(sourcePurchases)) {
    const normalizedPurchase = normalizePurchase(record, purchaseID);
    if (!normalizedPurchase) {
      continue;
    }
    normalized.purchases[String(normalizedPurchase.purchaseID)] = normalizedPurchase;
    normalized.nextPurchaseID = Math.max(
      normalized.nextPurchaseID,
      normalizedPurchase.purchaseID + 1,
    );
    normalized.nextActivationID = Math.max(
      normalized.nextActivationID,
      normalizedPurchase.activationID + 1,
    );
  }

  return normalized;
}

function readState() {
  const result = repo.read(TABLE_NAME, "/");
  if (!result.success) {
    return emptyState();
  }
  return normalizeState(result.data);
}

function writeState(state) {
  return repo.write(TABLE_NAME, "/", normalizeState(state));
}

function normalizeNowMs(nowMs = Date.now()) {
  return Math.max(0, toInteger(nowMs, Date.now()));
}

function isKillRightExpired(record, nowMs = Date.now()) {
  return filetimeToMs(record && record.expiryTime, 0) <= normalizeNowMs(nowMs);
}

function markExpiredRight(record, nowMs = Date.now()) {
  if (
    !record ||
    record.usedAt ||
    record.revokedAt ||
    record.expiredAt ||
    record.pendingPurchaseID
  ) {
    return false;
  }
  if (!isKillRightExpired(record, nowMs)) {
    return false;
  }
  record.expiredAt = filetimeFromMs(nowMs);
  record.price = null;
  record.restrictedTo = null;
  return true;
}

function expireRightsInState(state, nowMs = Date.now()) {
  const normalizedNowMs = normalizeNowMs(nowMs);
  const expired = [];
  for (const record of Object.values(state && state.rights || {})) {
    if (markExpiredRight(record, normalizedNowMs)) {
      expired.push(cloneValue(record));
    }
  }
  return expired;
}

function isKillRightUsable(record, nowMs = Date.now()) {
  return Boolean(
    record &&
      record.killRightID > 0 &&
      record.fromID > 0 &&
      record.toID > 0 &&
      !record.usedAt &&
      !record.expiredAt &&
      !record.revokedAt &&
      !isKillRightExpired(record, nowMs),
  );
}

function getKillRight(killRightID) {
  const state = readState();
  const expired = expireRightsInState(state);
  if (expired.length > 0) {
    writeState(state);
  }
  const record = state.rights[String(toInteger(killRightID, 0))];
  return record ? cloneValue(record) : null;
}

function listActiveKillRights(nowMs = Date.now()) {
  const state = readState();
  const expired = expireRightsInState(state, nowMs);
  if (expired.length > 0) {
    writeState(state);
  }
  return Object.values(state.rights)
    .filter((record) => isKillRightUsable(record, nowMs))
    .sort((left, right) => left.killRightID - right.killRightID)
    .map((record) => cloneValue(record));
}

function expireKillRights(nowMs = Date.now()) {
  const state = readState();
  const expired = expireRightsInState(state, nowMs);
  if (expired.length === 0) {
    return {
      success: true,
      expired: [],
    };
  }
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    expired,
  };
}

function findActiveKillRightBetween(fromID, toID, nowMs = Date.now()) {
  const numericFromID = toInteger(fromID, 0);
  const numericToID = toInteger(toID, 0);
  if (numericFromID <= 0 || numericToID <= 0) {
    return null;
  }
  const state = readState();
  const record = Object.values(state.rights)
    .filter((candidate) => (
      candidate.fromID === numericFromID &&
      candidate.toID === numericToID &&
      isKillRightUsable(candidate, nowMs)
    ))
    .sort((left, right) => left.killRightID - right.killRightID)[0];
  return record ? cloneValue(record) : null;
}

function createKillRight({
  fromID,
  toID,
  expiryTime = null,
  expiryMs = DEFAULT_KILL_RIGHT_EXPIRY_MS,
  nowMs = Date.now(),
} = {}) {
  const numericFromID = toInteger(fromID, 0);
  const numericToID = toInteger(toID, 0);
  if (numericFromID <= 0 || numericToID <= 0 || numericFromID === numericToID) {
    return {
      success: false,
      errorMsg: ERROR.NO_VALID_KILL_RIGHT,
    };
  }

  const state = readState();
  const killRightID = state.nextKillRightID;
  const createdAt = filetimeFromMs(nowMs);
  const record = normalizeKillRight({
    killRightID,
    fromID: numericFromID,
    toID: numericToID,
    expiryTime: expiryTime || filetimeFromMs(nowMs + Math.max(0, toInteger(expiryMs, expiryMs))),
    createdAt,
  });
  state.nextKillRightID = killRightID + 1;
  state.rights[String(killRightID)] = record;
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    data: cloneValue(record),
  };
}

function createKillRightForCriminalAggression({
  fromID,
  toID,
  expiryTime = null,
  expiryMs = DEFAULT_KILL_RIGHT_EXPIRY_MS,
  nowMs = Date.now(),
} = {}) {
  const numericFromID = toInteger(fromID, 0);
  const numericToID = toInteger(toID, 0);
  if (numericFromID <= 0 || numericToID <= 0 || numericFromID === numericToID) {
    return {
      success: false,
      errorMsg: ERROR.NO_VALID_KILL_RIGHT,
    };
  }

  const state = readState();
  const existingRecord = Object.values(state.rights)
    .filter((record) => (
      record.fromID === numericFromID &&
      record.toID === numericToID &&
      isKillRightUsable(record, nowMs)
    ))
    .sort((left, right) => left.killRightID - right.killRightID)[0];
  if (existingRecord) {
    return {
      success: true,
      created: false,
      data: cloneValue(existingRecord),
    };
  }

  const killRightID = state.nextKillRightID;
  const createdAt = filetimeFromMs(nowMs);
  const record = normalizeKillRight({
    killRightID,
    fromID: numericFromID,
    toID: numericToID,
    expiryTime: expiryTime || filetimeFromMs(nowMs + Math.max(0, toInteger(expiryMs, expiryMs))),
    createdAt,
  });
  state.nextKillRightID = killRightID + 1;
  state.rights[String(killRightID)] = record;
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    created: true,
    data: cloneValue(record),
  };
}

function listMyKillRights(characterID, nowMs = Date.now()) {
  const numericCharacterID = toInteger(characterID, 0);
  if (numericCharacterID <= 0) {
    return [];
  }
  return listActiveKillRights(nowMs).filter(
    (record) => record.fromID === numericCharacterID || record.toID === numericCharacterID,
  );
}

function hasSaleAccess(record, validOwnerIDs = []) {
  if (
    !record ||
    record.pendingPurchaseID ||
    record.price === null ||
    record.price === undefined
  ) {
    return false;
  }
  if (record.restrictedTo === null || record.restrictedTo === undefined) {
    return true;
  }
  const validSet = new Set(
    (Array.isArray(validOwnerIDs) ? validOwnerIDs : [])
      .map((value) => toInteger(value, 0))
      .filter((value) => value > 0),
  );
  return validSet.has(toInteger(record.restrictedTo, 0));
}

function listAvailableKillRightsOnCharacters(toIDs = [], validOwnerIDs = [], nowMs = Date.now()) {
  const targetIDs = new Set(
    (Array.isArray(toIDs) ? toIDs : [toIDs])
      .map((value) => toInteger(value, 0))
      .filter((value) => value > 0),
  );
  if (targetIDs.size === 0) {
    return [];
  }
  return listActiveKillRights(nowMs).filter(
    (record) => targetIDs.has(record.toID) && hasSaleAccess(record, validOwnerIDs),
  );
}

function sellKillRight(killRightID, ownerID, price, restrictedTo = null, options = {}) {
  const state = readState();
  const numericKillRightID = toInteger(killRightID, 0);
  const numericOwnerID = toInteger(ownerID, 0);
  const nowMs = normalizeNowMs(options.nowMs);
  const record = state.rights[String(numericKillRightID)];
  if (
    !record ||
    record.fromID !== numericOwnerID ||
    record.usedAt ||
    record.revokedAt ||
    record.pendingPurchaseID
  ) {
    return {
      success: false,
      errorMsg: ERROR.NO_VALID_KILL_RIGHT,
    };
  }
  if (record.expiredAt) {
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }
  if (isKillRightExpired(record, nowMs)) {
    markExpiredRight(record, nowMs);
    writeState(state);
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }

  const updatedRecord = normalizeKillRight({
    ...record,
    price: normalizeMoney(price, 0),
    restrictedTo: normalizeRestrictedTo(restrictedTo),
    soldAt: filetimeFromMs(nowMs),
    saleCancelledAt: null,
  });
  state.rights[String(numericKillRightID)] = updatedRecord;
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    data: cloneValue(updatedRecord),
  };
}

function cancelSellKillRight(killRightID, ownerID, toID = null, options = {}) {
  const state = readState();
  const numericKillRightID = toInteger(killRightID, 0);
  const numericOwnerID = toInteger(ownerID, 0);
  const numericToID = toInteger(toID, 0);
  const nowMs = normalizeNowMs(options.nowMs);
  const record = state.rights[String(numericKillRightID)];
  if (
    !record ||
    record.fromID !== numericOwnerID ||
    record.usedAt ||
    record.revokedAt ||
    record.pendingPurchaseID ||
    (numericToID > 0 && record.toID !== numericToID)
  ) {
    return {
      success: false,
      errorMsg: ERROR.NO_VALID_KILL_RIGHT,
    };
  }
  if (record.expiredAt) {
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }
  if (isKillRightExpired(record, nowMs)) {
    markExpiredRight(record, nowMs);
    writeState(state);
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }

  const updatedRecord = normalizeKillRight({
    ...record,
    price: null,
    restrictedTo: null,
    saleCancelledAt: filetimeFromMs(nowMs),
  });
  state.rights[String(numericKillRightID)] = updatedRecord;
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    data: cloneValue(updatedRecord),
  };
}

function appendActivation(state, record, activatorID, options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const activationID = state.nextActivationID;
  const activation = normalizeActivation({
    activationID,
    killRightID: record.killRightID,
    fromID: record.fromID,
    toID: record.toID,
    activatorID,
    activatedAt: filetimeFromMs(nowMs),
    expiresAt: filetimeFromMs(nowMs + KILL_RIGHT_SUSPECT_TIMER_MS),
    pricePaid: normalizeMoney(options.pricePaid, 0),
    activationKind: options.activationKind || "activate",
  });
  state.nextActivationID = activationID + 1;
  state.activations[String(activationID)] = activation;
  return activation;
}

function activateOwnedKillRight(killRightID, activatorID, options = {}) {
  const state = readState();
  const numericKillRightID = toInteger(killRightID, 0);
  const numericActivatorID = toInteger(activatorID, 0);
  const nowMs = normalizeNowMs(options.nowMs);
  const record = state.rights[String(numericKillRightID)];
  if (
    !record ||
    record.fromID !== numericActivatorID ||
    record.usedAt ||
    record.revokedAt ||
    record.pendingPurchaseID
  ) {
    return {
      success: false,
      errorMsg: ERROR.NO_VALID_KILL_RIGHT,
    };
  }
  if (record.expiredAt) {
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }
  if (isKillRightExpired(record, nowMs)) {
    markExpiredRight(record, nowMs);
    writeState(state);
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }

  const activation = appendActivation(state, record, numericActivatorID, {
    nowMs,
    pricePaid: 0,
    activationKind: "activate",
  });
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    data: {
      killRight: cloneValue(record),
      activation: cloneValue(activation),
    },
  };
}

function buyKillRight(killRightID, buyerID, validOwnerIDs = [], expectedPrice = null, options = {}) {
  const state = readState();
  const numericKillRightID = toInteger(killRightID, 0);
  const numericBuyerID = toInteger(buyerID, 0);
  const nowMs = normalizeNowMs(options.nowMs);
  const record = state.rights[String(numericKillRightID)];
  if (!record || record.usedAt || record.revokedAt || record.pendingPurchaseID) {
    return {
      success: false,
      errorMsg: ERROR.NO_VALID_KILL_RIGHT,
    };
  }
  if (record.expiredAt) {
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }
  if (isKillRightExpired(record, nowMs)) {
    markExpiredRight(record, nowMs);
    writeState(state);
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }
  if (!hasSaleAccess(record, validOwnerIDs)) {
    return {
      success: false,
      errorMsg: record.price === null ? ERROR.KILL_RIGHT_NOT_FOR_SALE : ERROR.NO_VALID_KILL_RIGHT,
    };
  }

  const normalizedExpectedPrice =
    expectedPrice === null || expectedPrice === undefined
      ? record.price
      : normalizeMoney(expectedPrice, 0);
  if (record.price !== normalizedExpectedPrice) {
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_NOT_FOR_SALE,
    };
  }

  if (typeof options.paymentCallback === "function" && record.price > 0) {
    const paymentResult = options.paymentCallback(cloneValue(record));
    if (!paymentResult || !paymentResult.success) {
      return {
        success: false,
        errorMsg: ERROR.PAYMENT_FAILED,
        paymentErrorMsg: paymentResult && paymentResult.errorMsg,
      };
    }
  }

  const activation = appendActivation(state, record, numericBuyerID, {
    nowMs,
    pricePaid: record.price,
    activationKind: "buy",
  });
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    data: {
      killRight: cloneValue(record),
      activation: cloneValue(activation),
    },
  };
}

function flushKillRightState() {
  database.flushTableAsync(TABLE_NAME);
}

function runPurchaseSerialized(killRightID, operation) {
  const laneKey = String(toInteger(killRightID, 0));
  const previous = purchaseLanes.get(laneKey) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  purchaseLanes.set(laneKey, current);
  void current.finally(() => {
    if (purchaseLanes.get(laneKey) === current) {
      purchaseLanes.delete(laneKey);
    }
  }).catch(() => null);
  return current;
}

function listPendingKillRightPurchases() {
  return Object.values(readState().purchases || {})
    .map((purchase) => normalizePurchase(purchase, purchase && purchase.purchaseID))
    .filter(Boolean)
    .sort((left, right) => left.purchaseID - right.purchaseID);
}

function getPendingKillRightPurchase(purchaseID) {
  return normalizePurchase(
    readState().purchases[String(toInteger(purchaseID, 0))],
    purchaseID,
  );
}

function prepareKillRightPurchase(
  killRightID,
  buyerID,
  validOwnerIDs = [],
  expectedPrice = null,
  options = {},
) {
  const state = readState();
  const numericKillRightID = toInteger(killRightID, 0);
  const numericBuyerID = toInteger(buyerID, 0);
  const nowMs = normalizeNowMs(options.nowMs);
  const existingPurchase = Object.values(state.purchases || {}).find((purchase) =>
    toInteger(purchase && purchase.killRightID, 0) === numericKillRightID);
  if (existingPurchase) {
    if (toInteger(existingPurchase.buyerID, 0) === numericBuyerID) {
      return {
        success: true,
        existing: true,
        data: normalizePurchase(existingPurchase, existingPurchase.purchaseID),
      };
    }
    return { success: false, errorMsg: ERROR.PURCHASE_PENDING };
  }

  const record = state.rights[String(numericKillRightID)];
  if (!record || record.usedAt || record.revokedAt || record.pendingPurchaseID) {
    return { success: false, errorMsg: ERROR.NO_VALID_KILL_RIGHT };
  }
  if (record.expiredAt) {
    return { success: false, errorMsg: ERROR.KILL_RIGHT_EXPIRED };
  }
  if (isKillRightExpired(record, nowMs)) {
    markExpiredRight(record, nowMs);
    writeState(state);
    flushKillRightState();
    return { success: false, errorMsg: ERROR.KILL_RIGHT_EXPIRED };
  }
  if (!hasSaleAccess(record, validOwnerIDs)) {
    return {
      success: false,
      errorMsg: record.price === null
        ? ERROR.KILL_RIGHT_NOT_FOR_SALE
        : ERROR.NO_VALID_KILL_RIGHT,
    };
  }
  const normalizedExpectedPrice =
    expectedPrice === null || expectedPrice === undefined
      ? record.price
      : normalizeMoney(expectedPrice, 0);
  if (record.price !== normalizedExpectedPrice) {
    return { success: false, errorMsg: ERROR.KILL_RIGHT_NOT_FOR_SALE };
  }

  const purchaseID = state.nextPurchaseID;
  const activationID = state.nextActivationID;
  const purchase = normalizePurchase({
    purchaseID,
    killRightID: record.killRightID,
    buyerID: numericBuyerID,
    sellerID: record.fromID,
    targetID: record.toID,
    activationID,
    price: record.price,
    paymentApplied: record.price <= 0,
    activationApplied: false,
    activatedAt: null,
    expiresAt: null,
    paymentCommandID: `${DURABLE_PURCHASE_JOB_PREFIX}${purchaseID}:payment`,
    createdAt: filetimeFromMs(nowMs),
  }, purchaseID);
  state.nextPurchaseID = purchaseID + 1;
  state.nextActivationID = activationID + 1;
  state.purchases[String(purchaseID)] = purchase;
  record.pendingPurchaseID = purchaseID;
  state.rights[String(record.killRightID)] = normalizeKillRight(record);
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  flushKillRightState();
  return { success: true, data: cloneValue(purchase) };
}

function abandonKillRightPurchase(purchaseID) {
  const state = readState();
  const purchase = normalizePurchase(
    state.purchases[String(toInteger(purchaseID, 0))],
    purchaseID,
  );
  if (!purchase) {
    return true;
  }
  const record = state.rights[String(purchase.killRightID)];
  if (record && record.pendingPurchaseID === purchase.purchaseID) {
    record.pendingPurchaseID = null;
  }
  delete state.purchases[String(purchase.purchaseID)];
  const writeResult = writeState(state);
  if (writeResult.success) {
    flushKillRightState();
  }
  return Boolean(writeResult.success);
}

function checkpointKillRightPurchase(purchaseID, patch = {}) {
  const state = readState();
  const current = normalizePurchase(
    state.purchases[String(toInteger(purchaseID, 0))],
    purchaseID,
  );
  if (!current) {
    return false;
  }
  state.purchases[String(current.purchaseID)] = normalizePurchase({
    ...current,
    ...patch,
  }, current.purchaseID);
  const writeResult = writeState(state);
  if (writeResult.success) {
    flushKillRightState();
  }
  return Boolean(writeResult.success);
}

function finalizeKillRightPurchase(
  purchaseID,
  nowMs = Date.now(),
  publisherOverride = null,
) {
  let state = readState();
  let purchase = normalizePurchase(
    state.purchases[String(toInteger(purchaseID, 0))],
    purchaseID,
  );
  if (!purchase || !purchase.paymentApplied) {
    return { success: false, errorMsg: "PURCHASE_NOT_PAID" };
  }
  let activation = normalizeActivation(
    state.activations[String(purchase.activationID)],
    purchase.activationID,
  );
  if (!purchase.activationApplied) {
    const record = state.rights[String(purchase.killRightID)];
    if (
      !record ||
      record.pendingPurchaseID !== purchase.purchaseID ||
      record.fromID !== purchase.sellerID ||
      record.toID !== purchase.targetID
    ) {
      return { success: false, errorMsg: "PURCHASE_LOCK_LOST" };
    }
    const activatedAtMs = normalizeNowMs(nowMs);
    activation = normalizeActivation({
      activationID: purchase.activationID,
      killRightID: purchase.killRightID,
      fromID: purchase.sellerID,
      toID: purchase.targetID,
      activatorID: purchase.buyerID,
      activatedAt: filetimeFromMs(activatedAtMs),
      expiresAt: filetimeFromMs(activatedAtMs + KILL_RIGHT_SUSPECT_TIMER_MS),
      pricePaid: purchase.price,
      activationKind: "buy",
    }, purchase.activationID);
    state.activations[String(activation.activationID)] = activation;
    record.pendingPurchaseID = null;
    state.rights[String(record.killRightID)] = normalizeKillRight(record);
    purchase = normalizePurchase({
      ...purchase,
      activationApplied: true,
      activatedAt: activation.activatedAt,
      expiresAt: activation.expiresAt,
    }, purchase.purchaseID);
    state.purchases[String(purchase.purchaseID)] = purchase;
    const activationWrite = writeState(state);
    if (!activationWrite.success) {
      return activationWrite;
    }
    flushKillRightState();
  }
  if (!activation) {
    return { success: false, errorMsg: "PURCHASE_ACTIVATION_MISSING" };
  }
  const result = {
    success: true,
    data: {
      killRight: cloneValue(state.rights[String(purchase.killRightID)]),
      activation: cloneValue(activation),
      purchase: cloneValue(purchase),
    },
  };
  const publisher = typeof publisherOverride === "function"
    ? publisherOverride
    : activationPublisher;
  if (publisher) {
    publisher(cloneValue(result.data));
  }
  state = readState();
  if (state.purchases[String(purchase.purchaseID)]) {
    delete state.purchases[String(purchase.purchaseID)];
    const finalizeWrite = writeState(state);
    if (!finalizeWrite.success) {
      return finalizeWrite;
    }
    flushKillRightState();
  }
  return result;
}

async function settlePendingKillRightPurchaseInternal(purchaseID, options = {}) {
  let purchase = getPendingKillRightPurchase(purchaseID);
  if (!purchase) {
    return { success: true, alreadySettled: true, data: null };
  }
  if (!purchase.paymentApplied) {
    const walletState = getWalletState();
    const paymentResult = await walletState.transferCharacterBalanceAsync(
      purchase.buyerID,
      purchase.sellerID,
      purchase.price,
      {
        description: `Kill right activation ${purchase.killRightID}`,
        entryTypeID: walletState.JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
      },
      {
        commandID: purchase.paymentCommandID,
        idempotencyKey: purchase.paymentCommandID,
        source: "kill-right-purchase-payment",
      },
    );
    if (!paymentResult || paymentResult.success !== true) {
      if (
        paymentResult &&
        ["INSUFFICIENT_FUNDS", "CHARACTER_NOT_FOUND"].includes(paymentResult.errorMsg)
      ) {
        abandonKillRightPurchase(purchase.purchaseID);
      }
      return {
        success: false,
        errorMsg: ERROR.PAYMENT_FAILED,
        paymentErrorMsg: paymentResult && paymentResult.errorMsg,
      };
    }
    if (!checkpointKillRightPurchase(purchase.purchaseID, {
      paymentApplied: true,
    })) {
      return { success: false, errorMsg: "PAYMENT_CHECKPOINT_FAILED" };
    }
    purchase = getPendingKillRightPurchase(purchase.purchaseID);
    if (!purchase) {
      return { success: false, errorMsg: "PAYMENT_CHECKPOINT_MISSING" };
    }
  }
  return finalizeKillRightPurchase(
    purchase.purchaseID,
    options.nowMs,
    options.publisher,
  );
}

function settlePendingKillRightPurchase(purchaseID, options = {}) {
  const purchase = getPendingKillRightPurchase(purchaseID);
  if (!purchase) {
    return Promise.resolve({ success: true, alreadySettled: true, data: null });
  }
  return runPurchaseSerialized(purchase.killRightID, () =>
    settlePendingKillRightPurchaseInternal(purchase.purchaseID, options));
}

function buildDurableKillRightPurchaseJob(purchase) {
  const normalized = normalizePurchase(purchase, purchase && purchase.purchaseID);
  return normalized ? {
    jobID: `${DURABLE_PURCHASE_JOB_PREFIX}${normalized.purchaseID}`,
    type: DURABLE_PURCHASE_JOB_TYPE,
    dueAtMs: Date.now(),
    payload: { purchaseID: normalized.purchaseID },
  } : null;
}

async function schedulePendingKillRightPurchase(purchase) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildDurableKillRightPurchaseJob(purchase);
  if (job) {
    await durableScheduler.schedule(job);
  }
  return job;
}

async function buyKillRightAsync(
  killRightID,
  buyerID,
  validOwnerIDs = [],
  expectedPrice = null,
  options = {},
) {
  return runPurchaseSerialized(killRightID, async () => {
    const prepared = prepareKillRightPurchase(
      killRightID,
      buyerID,
      validOwnerIDs,
      expectedPrice,
      options,
    );
    if (!prepared.success || !prepared.data) {
      return prepared;
    }
    void schedulePendingKillRightPurchase(prepared.data).catch(() => null);
    return settlePendingKillRightPurchaseInternal(prepared.data.purchaseID, {
      nowMs: options.nowMs,
      publisher: options.publisher,
    });
  });
}

function registerActivationPublisher(publisher) {
  activationPublisher = typeof publisher === "function"
    ? publisher
    : publishDefaultActivation;
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("kill right scheduler requires a schedule function");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

async function handleDurableKillRightPurchase(job = {}) {
  const purchaseID = toInteger(job.payload && job.payload.purchaseID, 0);
  if (purchaseID <= 0) {
    throw new Error("kill right purchase job is invalid");
  }
  const result = await settlePendingKillRightPurchase(purchaseID);
  if (!result || result.success !== true) {
    if (
      result &&
      result.errorMsg === ERROR.PAYMENT_FAILED &&
      ["INSUFFICIENT_FUNDS", "CHARACTER_NOT_FOUND"].includes(result.paymentErrorMsg)
    ) {
      return { purchaseID, paymentFailed: true };
    }
    throw new Error(result && result.errorMsg || "kill right purchase failed");
  }
  return result;
}

async function reconcileDurableKillRightPurchases() {
  const pending = listPendingKillRightPurchases();
  if (!durableScheduler) {
    return { scheduled: 0, pending: pending.length };
  }
  await Promise.all(pending.map((purchase) =>
    schedulePendingKillRightPurchase(purchase)));
  return { scheduled: pending.length, pending: pending.length };
}

function markKillRightUsed(killRightID, usedBy = null, options = {}) {
  const state = readState();
  const numericKillRightID = toInteger(killRightID, 0);
  const record = state.rights[String(numericKillRightID)];
  if (!record || record.usedAt || record.revokedAt || record.pendingPurchaseID) {
    return {
      success: false,
      errorMsg: ERROR.NO_VALID_KILL_RIGHT,
    };
  }
  const nowMs = normalizeNowMs(options.nowMs);
  if (record.expiredAt) {
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }
  if (isKillRightExpired(record, nowMs)) {
    markExpiredRight(record, nowMs);
    writeState(state);
    return {
      success: false,
      errorMsg: ERROR.KILL_RIGHT_EXPIRED,
    };
  }
  const updatedRecord = normalizeKillRight({
    ...record,
    usedAt: filetimeFromMs(nowMs),
    usedBy: toInteger(usedBy, 0) || null,
  });
  state.rights[String(numericKillRightID)] = updatedRecord;
  const writeResult = writeState(state);
  if (!writeResult.success) {
    return writeResult;
  }
  return {
    success: true,
    data: cloneValue(updatedRecord),
  };
}

function readActiveActivationsForTarget(toID, nowMs = Date.now()) {
  const targetID = toInteger(toID, 0);
  if (targetID <= 0) {
    return [];
  }
  const state = readState();
  const expired = expireRightsInState(state, nowMs);
  if (expired.length > 0) {
    writeState(state);
  }
  return Object.values(state.activations)
    .filter((activation) => (
      activation.toID === targetID &&
      isKillRightUsable(state.rights[String(activation.killRightID)], nowMs) &&
      filetimeToMs(activation.expiresAt, 0) > nowMs
    ))
    .sort((left, right) => left.activationID - right.activationID)
    .map((activation) => cloneValue(activation));
}

function resetStateForTests() {
  writeState(emptyState());
}

module.exports = {
  DEFAULT_KILL_RIGHT_EXPIRY_MS,
  DURABLE_PURCHASE_JOB_TYPE,
  ERROR,
  KILL_RIGHT_SUSPECT_TIMER_MS,
  activateOwnedKillRight,
  bindDurableScheduler,
  buildDurableKillRightPurchaseJob,
  buyKillRight,
  buyKillRightAsync,
  cancelSellKillRight,
  createKillRight,
  createKillRightForCriminalAggression,
  expireKillRights,
  filetimeFromMs,
  filetimeToMs,
  findActiveKillRightBetween,
  getKillRight,
  handleDurableKillRightPurchase,
  isKillRightExpired,
  listActiveKillRights,
  listAvailableKillRightsOnCharacters,
  listPendingKillRightPurchases,
  listMyKillRights,
  markKillRightUsed,
  readActiveActivationsForTarget,
  readState,
  reconcileDurableKillRightPurchases,
  registerActivationPublisher,
  sellKillRight,
  settlePendingKillRightPurchase,
  unbindDurableScheduler,
  writeState,
  _testing: {
    emptyState,
    filetimeToMs,
    normalizeState,
    prepareKillRightPurchase,
    resetStateForTests,
  },
};
