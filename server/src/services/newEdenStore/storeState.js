"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const {
  toNumber,
} = require("../../common/numbers");

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const licenseLifecycle = require("./licenseLifecycle");
const AUTHORITY_TABLE = "newEdenStore";
const RUNTIME_TABLE = "newEdenStoreRuntime";
const ACCOUNTS_TABLE = "accounts";
const CHARACTERS_TABLE = "characters";
const FILETIME_TICKS_PER_DAY = 864000000000n;
const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;
const DEFAULT_OMEGA_EXPIRY_FILETIME = "157469184000000000";
const DEFAULT_PURCHASE_LOG_LIMIT = 500;
const MAX_FULFILLMENT_RECEIPTS = 512;
const FAST_CHECKOUT_SUCCESS_RESPONSE = "OK";
const NEW_EDEN_STORE_CLIENT_TESTING_PROFILE = Object.freeze({
  fakeChinaFunnelEnabled: false,
  fakeBuyPlexOfferUrl: "",
  useShellExecuteToBuyPlexOffer: true,
});

let cachedState = null;

function toPositiveInteger(value, fallback = 0) {
  const numeric = toNumber(value, fallback);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function toBooleanString(value, fallback = false) {
  return value ? "1" : fallback ? "1" : "0";
}

function toBigInt(value, fallback = 0n) {
  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && value.trim() !== "") {
      return BigInt(value);
    }
  } catch (error) {
    return fallback;
  }
  return fallback;
}

function currentFileTime() {
  return BigInt(Date.now()) * 10000n + FILETIME_UNIX_EPOCH_OFFSET;
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function readTable(tableName) {
  const result = database.read(tableName, "/");
  if (!result.success) {
    return {};
  }
  return ensureObject(result.data);
}

function normalizeStoreConfig(rawConfig = {}) {
  const source = ensureObject(rawConfig);
  const enabled = config.newEdenStoreEnabled !== undefined
    ? Boolean(config.newEdenStoreEnabled)
    : source.enabled !== false;
  const normalized = {
    enabled,
    fastCheckoutEnabled:
      enabled &&
      (config.newEdenStoreFastCheckoutEnabled !== undefined
        ? Boolean(config.newEdenStoreFastCheckoutEnabled)
        : source.fastCheckoutEnabled !== false),
    fakeCashPurchasesEnabled:
      enabled &&
      (config.newEdenStoreFakeCashPurchasesEnabled !== undefined
        ? Boolean(config.newEdenStoreFakeCashPurchasesEnabled)
        : source.fakeCashPurchasesEnabled !== false),
    fakeFastCheckoutResponse: FAST_CHECKOUT_SUCCESS_RESPONSE,
    ...NEW_EDEN_STORE_CLIENT_TESTING_PROFILE,
    centsPerPlex: Math.max(
      1,
      Math.trunc(
        toNumber(
          config.newEdenStoreCentsPerPlex !== undefined
            ? config.newEdenStoreCentsPerPlex
            : source.centsPerPlex,
          100,
        ),
      ),
    ),
    defaultCashTaxRatePoints: Math.max(
      0,
      Math.trunc(
        toNumber(
          config.newEdenStoreDefaultCashTaxRatePoints !== undefined
            ? config.newEdenStoreDefaultCashTaxRatePoints
            : source.defaultCashTaxRatePoints,
          0,
        ),
      ),
    ),
    purchaseLogLimit: Math.max(
      10,
      Math.trunc(
        toNumber(
          config.newEdenStorePurchaseLogLimit !== undefined
            ? config.newEdenStorePurchaseLogLimit
            : source.purchaseLogLimit,
          DEFAULT_PURCHASE_LOG_LIMIT,
        ),
      ),
    ),
  };

  return normalized;
}

function normalizeTrainingSlots(rawValue) {
  const source = ensureObject(rawValue);
  const normalized = {};
  for (const [slotKey, expiryValue] of Object.entries(source)) {
    const slot = toPositiveInteger(slotKey, 0);
    if (!slot) {
      continue;
    }
    const expiryString = String(expiryValue || "").trim();
    if (expiryString === "") {
      continue;
    }
    normalized[String(slot)] = expiryString;
  }
  return normalized;
}

function normalizeRedeemTokens(rawValue) {
  return ensureArray(rawValue)
    .map((token) => {
      const source = ensureObject(token);
      const tokenID = toPositiveInteger(source.tokenID, 0);
      const typeID = toPositiveInteger(source.typeID, 0);
      const quantity = Math.max(1, Math.trunc(toNumber(source.quantity, 1)));
      if (!tokenID || !typeID || quantity <= 0) {
        return null;
      }
      return {
        tokenID,
        massTokenID: toPositiveInteger(source.massTokenID, 0),
        typeID,
        quantity,
        stationID: toPositiveInteger(source.stationID, 0),
        dateTime:
          typeof source.dateTime === "string" && source.dateTime.trim() !== ""
            ? source.dateTime.trim()
            : "0",
        expireDateTime:
          typeof source.expireDateTime === "string" && source.expireDateTime.trim() !== ""
            ? source.expireDateTime.trim()
            : "0",
        label: typeof source.label === "string" ? source.label : "",
        description: typeof source.description === "string" ? source.description : "",
        blueprintRuns: Math.max(0, Math.trunc(toNumber(source.blueprintRuns, 0))),
        blueprintMaterialLevel: Math.trunc(toNumber(source.blueprintMaterialLevel, 0)),
        blueprintProductivityLevel: Math.trunc(toNumber(source.blueprintProductivityLevel, 0)),
        soulbound: Boolean(source.soulbound),
        available:
          source.available === undefined || source.available === null
            ? true
            : Boolean(source.available),
        addedByContext: Math.trunc(toNumber(source.addedByContext, 0)),
        addedByExtra: source.addedByExtra === undefined ? null : cloneValue(source.addedByExtra),
        ...(source.campaignGrant ? { campaignGrant: cloneValue(source.campaignGrant) } : {}),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.dateTime !== right.dateTime) {
        return String(left.dateTime).localeCompare(String(right.dateTime));
      }
      return left.tokenID - right.tokenID;
    });
}

function normalizeFulfillmentReceipts(rawValue) {
  return ensureArray(rawValue)
    .map((receipt) => {
      const source = ensureObject(receipt);
      const idempotencyKey = String(source.idempotencyKey || "").trim();
      const fingerprint = String(source.fingerprint || "").trim();
      if (!idempotencyKey || !fingerprint) {
        return null;
      }
      return {
        idempotencyKey,
        fingerprint,
        result: cloneValue(source.result || null),
        completedAt:
          typeof source.completedAt === "string" && source.completedAt.trim() !== ""
            ? source.completedAt.trim()
            : null,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_FULFILLMENT_RECEIPTS);
}

function normalizeRuntimeAccount(rawValue) {
  const source = ensureObject(rawValue);
  return {
    omegaExpiryFileTime:
      typeof source.omegaExpiryFileTime === "string" &&
      source.omegaExpiryFileTime.trim() !== ""
        ? source.omegaExpiryFileTime.trim()
        : null,
    multiCharacterTrainingSlots: normalizeTrainingSlots(
      source.multiCharacterTrainingSlots,
    ),
    redeemTokens: normalizeRedeemTokens(source.redeemTokens),
    campaignTrailRewards: cloneValue(ensureObject(source.campaignTrailRewards)),
    dailyLoginCampaign: normalizeDailyLoginCampaign(source.dailyLoginCampaign),
    gallenteElectionLogin: cloneValue(ensureObject(source.gallenteElectionLogin)),
    loginCampaignProgress: cloneValue(ensureObject(source.loginCampaignProgress)),
    campaignRedemptions: cloneValue(ensureObject(source.campaignRedemptions)),
    careerProgramClaims: cloneValue(ensureObject(source.careerProgramClaims)),
    licenseLifecycle: source.licenseLifecycle == null ? null : cloneValue(source.licenseLifecycle),
    campaignTokenSequence: toPositiveInteger(source.campaignTokenSequence, 0),
    loginMilestone: normalizeLoginMilestone(source.loginMilestone),
    fulfillmentReceipts: normalizeFulfillmentReceipts(
      source.fulfillmentReceipts,
    ),
    updatedAt:
      typeof source.updatedAt === "string" && source.updatedAt.trim() !== ""
        ? source.updatedAt.trim()
        : null,
  };
}

function normalizeDailyLoginCampaign(rawValue) {
  const source = ensureObject(rawValue);
  const day = Math.trunc(toNumber(source.day, 0));
  return {
    day: day >= 0 && day <= 15 ? day : 0,
    lastClaimReset: typeof source.lastClaimReset === "string" ? source.lastClaimReset : "",
  };
}

function normalizeLoginMilestone(rawValue) {
  const source = ensureObject(rawValue);
  return {
    onlineMilliseconds: Math.max(
      0,
      Math.trunc(toNumber(source.onlineMilliseconds, 0)),
    ),
    achieved: Boolean(source.achieved),
    claimed: Boolean(source.claimed),
  };
}

function buildFastCheckoutOffersConfigString(fastCheckoutOffers = []) {
  const tuples = ensureArray(fastCheckoutOffers).map((offer) => [
    Math.max(0, Math.trunc(toNumber(offer && offer.quantity, 0))),
    String(offer && offer.currency ? offer.currency : ""),
    Number(toNumber(offer && offer.price, 0).toFixed(2)),
  ]);
  return JSON.stringify(tuples);
}

function hasLegacyStoreOffers(state) {
  if (!state || !state.indexes || !(state.indexes.legacyOffersByStore instanceof Map)) {
    return false;
  }
  for (const offersByID of state.indexes.legacyOffersByStore.values()) {
    if (offersByID instanceof Map && offersByID.size > 0) {
      return true;
    }
  }
  return false;
}

function loadStoreState() {
  if (cachedState) {
    return cachedState;
  }

  const authority = readTable(AUTHORITY_TABLE);
  const runtime = readTable(RUNTIME_TABLE);
  const accounts = readTable(ACCOUNTS_TABLE);
  const characters = readTable(CHARACTERS_TABLE);
  const normalizedConfig = normalizeStoreConfig(authority.config);
  const stores = ensureObject(authority.stores);
  const publicOffers = ensureObject(authority.publicOffers);
  const fastCheckout = ensureObject(authority.fastCheckout);
  const fastCheckoutOffers = ensureArray(fastCheckout.offers);
  const quickPayTokens = ensureObject(fastCheckout.tokensByID);
  const runtimeAccounts = ensureObject(runtime.accounts);
  const completedPurchases = ensureObject(runtime.completedPurchases);
  const purchaseLog = ensureArray(runtime.purchaseLog);

  const legacyOffersByStore = new Map();
  const legacyOffersByStoreOfferID = new Map();
  const publicOffersByID = new Map();
  const fastCheckoutOffersByID = new Map();
  const quickPayTokensByID = new Map();
  const characterAccountByID = new Map();
  const accountCharacterIDs = new Map();
  const runtimeAccountsByID = new Map();

  for (const [storeID, rawStore] of Object.entries(stores)) {
    const normalizedStoreID = String(storeID);
    const store = {
      storeID: toPositiveInteger(rawStore && rawStore.storeID, toPositiveInteger(storeID, 4)),
      name: String(rawStore && rawStore.name ? rawStore.name : "New Eden Store"),
      categories: ensureArray(rawStore && rawStore.categories).map((entry) => cloneValue(entry)),
      products: ensureArray(rawStore && rawStore.products).map((entry) => cloneValue(entry)),
      offers: ensureArray(rawStore && rawStore.offers).map((entry) => cloneValue(entry)),
    };
    stores[normalizedStoreID] = store;
    legacyOffersByStore.set(normalizedStoreID, new Map());
    legacyOffersByStoreOfferID.set(normalizedStoreID, new Map());
    for (const offer of store.offers) {
      legacyOffersByStore.get(normalizedStoreID).set(String(offer.id), offer);
      if (offer && offer.storeOfferID) {
        legacyOffersByStoreOfferID
          .get(normalizedStoreID)
          .set(String(offer.storeOfferID), offer);
      }
    }
  }

  for (const [storeOfferID, offer] of Object.entries(publicOffers)) {
    publicOffersByID.set(String(storeOfferID), cloneValue(offer));
  }

  for (const offer of fastCheckoutOffers) {
    const offerID = toPositiveInteger(offer && offer.id, 0);
    if (!offerID) {
      continue;
    }
    fastCheckoutOffersByID.set(String(offerID), cloneValue(offer));
  }

  for (const [tokenID, token] of Object.entries(quickPayTokens)) {
    const normalizedTokenID = toPositiveInteger(tokenID, 0);
    if (!normalizedTokenID) {
      continue;
    }
    quickPayTokensByID.set(String(normalizedTokenID), cloneValue(token));
  }

  for (const [characterID, character] of Object.entries(characters)) {
    const normalizedCharacterID = toPositiveInteger(characterID, 0);
    const accountID = toPositiveInteger(character && character.accountId, 0);
    if (normalizedCharacterID && accountID) {
      characterAccountByID.set(String(normalizedCharacterID), accountID);
      const accountKey = String(accountID);
      if (!accountCharacterIDs.has(accountKey)) {
        accountCharacterIDs.set(accountKey, []);
      }
      accountCharacterIDs.get(accountKey).push(normalizedCharacterID);
    }
  }

  for (const characterIDs of accountCharacterIDs.values()) {
    characterIDs.sort((left, right) => left - right);
  }

  for (const [accountID, runtimeAccount] of Object.entries(runtimeAccounts)) {
    const normalizedAccountID = toPositiveInteger(accountID, 0);
    if (!normalizedAccountID) {
      continue;
    }
    runtimeAccountsByID.set(
      String(normalizedAccountID),
      normalizeRuntimeAccount(runtimeAccount),
    );
  }

  cachedState = {
    authority,
    runtime,
    accounts,
    characters,
    config: normalizedConfig,
    indexes: {
      stores,
      legacyOffersByStore,
      legacyOffersByStoreOfferID,
      publicOffersByID,
      fastCheckoutOffers,
      fastCheckoutOffersByID,
      quickPayTokens,
      quickPayTokensByID,
      characterAccountByID,
      accountCharacterIDs,
      runtimeAccountsByID,
      completedPurchases,
      purchaseLog,
    },
  };

  return cachedState;
}

function resetStoreCaches() {
  cachedState = null;
}

function getStoreConfig() {
  return cloneValue(loadStoreState().config);
}

function getLegacyCatalog(storeID = 4) {
  const state = loadStoreState();
  const normalizedStoreID = String(toPositiveInteger(storeID, 4));
  const store = state.indexes.stores[normalizedStoreID];
  if (!store) {
    return {
      storeID: toPositiveInteger(storeID, 4),
      name: "New Eden Store",
      categories: [],
      products: [],
      offers: [],
    };
  }
  return cloneValue(store);
}

function findLegacyOffer(storeID, offerID) {
  const state = loadStoreState();
  const offersByID = state.indexes.legacyOffersByStore.get(
    String(toPositiveInteger(storeID, 4)),
  );
  if (!offersByID) {
    return null;
  }
  return cloneValue(offersByID.get(String(toPositiveInteger(offerID, 0))) || null);
}

function findLegacyOfferByStoreOfferID(storeID, storeOfferID) {
  const state = loadStoreState();
  const offersByStoreOfferID = state.indexes.legacyOffersByStoreOfferID.get(
    String(toPositiveInteger(storeID, 4)),
  );
  if (!offersByStoreOfferID) {
    return null;
  }
  return cloneValue(
    offersByStoreOfferID.get(String(storeOfferID || "").trim()) || null,
  );
}

function findPublicOffer(storeOfferID) {
  const state = loadStoreState();
  return cloneValue(
    state.indexes.publicOffersByID.get(String(storeOfferID || "").trim()) || null,
  );
}

function findPublicOfferForLegacyOffer(storeID, offerID) {
  const legacyOffer = findLegacyOffer(storeID, offerID);
  if (!legacyOffer || !legacyOffer.storeOfferID) {
    return null;
  }
  return findPublicOffer(legacyOffer.storeOfferID);
}

function getFastCheckoutOffers() {
  return cloneValue(loadStoreState().indexes.fastCheckoutOffers);
}

function findFastCheckoutOffer(offerID) {
  const state = loadStoreState();
  return cloneValue(
    state.indexes.fastCheckoutOffersByID.get(
      String(toPositiveInteger(offerID, 0)),
    ) || null,
  );
}

function getQuickPayTokens() {
  return cloneValue(loadStoreState().indexes.quickPayTokens);
}

function findQuickPayToken(tokenID) {
  const state = loadStoreState();
  return cloneValue(
    state.indexes.quickPayTokensByID.get(String(toPositiveInteger(tokenID, 0))) ||
      null,
  );
}

function buildClientGlobalConfigEntries() {
  const state = loadStoreState();
  const hasLegacyOffers = hasLegacyStoreOffers(state);
  const hasFastCheckoutOffers = state.indexes.fastCheckoutOffers.length > 0;
  return [
    [
      "fake_fast_checkout_enabled",
      toBooleanString(state.config.fastCheckoutEnabled && hasFastCheckoutOffers),
    ],
    ["fake_fast_checkout_response", state.config.fakeFastCheckoutResponse],
    [
      "fake_fast_checkout_plex_offers",
      buildFastCheckoutOffersConfigString(state.indexes.fastCheckoutOffers),
    ],
    ["fake_vgs_enabled", toBooleanString(state.config.enabled && hasLegacyOffers)],
    [
      "fake_china_funnel_enabled",
      toBooleanString(state.config.fakeChinaFunnelEnabled),
    ],
    ["fake_buy_plex_offer_url", state.config.fakeBuyPlexOfferUrl],
    [
      "use_shell_execute_to_buy_plex_offer",
      toBooleanString(state.config.useShellExecuteToBuyPlexOffer, true),
    ],
  ];
}

function resolveCharacterAccountID(characterID) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return 0;
  }

  let state = loadStoreState();
  const cachedAccountID = state.indexes.characterAccountByID.get(
    String(normalizedCharacterID),
  );
  if (cachedAccountID) {
    return cachedAccountID;
  }

  resetStoreCaches();
  state = loadStoreState();
  return state.indexes.characterAccountByID.get(String(normalizedCharacterID)) || 0;
}

function resolveStoreCharacterID(characterID, accountID = 0) {
  let state = loadStoreState();
  const explicitCharacterID = toPositiveInteger(characterID, 0);
  if (
    explicitCharacterID &&
    state.indexes.characterAccountByID.has(String(explicitCharacterID))
  ) {
    return explicitCharacterID;
  }

  if (explicitCharacterID) {
    resetStoreCaches();
    state = loadStoreState();
    if (state.indexes.characterAccountByID.has(String(explicitCharacterID))) {
      return explicitCharacterID;
    }
  }

  const normalizedAccountID = toPositiveInteger(accountID, 0);
  if (!normalizedAccountID) {
    return 0;
  }

  const characterIDs =
    state.indexes.accountCharacterIDs.get(String(normalizedAccountID)) || [];
  return toPositiveInteger(characterIDs[0], 0);
}

function readRuntimeAccount(accountID) {
  const state = loadStoreState();
  return cloneValue(
    state.indexes.runtimeAccountsByID.get(String(toPositiveInteger(accountID, 0))) ||
      normalizeRuntimeAccount({}),
  );
}

function writeRuntimeAccount(accountID, nextRuntimeAccount) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  if (!numericAccountID) {
    return null;
  }
  const normalized = normalizeRuntimeAccount({
    ...ensureObject(nextRuntimeAccount),
    updatedAt: new Date().toISOString(),
  });
  const result = commitRuntimeAccount(numericAccountID, normalized);
  return result.success ? result.data : null;
}

function commitRuntimeAccount(accountID, account, notify = true) {
  const previous = readRuntimeAccount(accountID);
  let next;
  try {
    next = { ...account, licenseLifecycle: licenseLifecycle.plan(previous, account, getConfiguredOmegaExpiryFileTime()) };
  } catch (error) { return { success: false, errorMsg: error.message }; }
  const result = database.write(RUNTIME_TABLE, `/accounts/${accountID}`, next);
  resetStoreCaches();
  if (!result.success) return result;
  const committed = database.flushTableSync(RUNTIME_TABLE);
  if (!committed.success) return committed;
  if (notify) licenseLifecycle.signalAccount(accountID);
  return { success: true, data: cloneValue(next) };
}

// Reward callers commit tokens and their idempotency receipts in one account
// write. Return persistence errors so they cannot acknowledge a failed delivery.
function writeRewardAccount(accountID, account) {
  const id = toPositiveInteger(accountID, 0);
  if (!id) return { success: false, errorMsg: "INVALID_ACCOUNT_ID" };
  return commitRuntimeAccount(id, account);
}

function listLicenseAccountIDs() {
  const state = loadStoreState();
  return [...new Set([...state.indexes.runtimeAccountsByID.keys(),
    ...Object.values(state.accounts).map(account => account?.id ?? account?.accountID)])]
    .map(value => toPositiveInteger(value, 0)).filter(Boolean).sort((a, b) => a - b);
}
function reconcileLicenseAccount(accountID) {
  const id = toPositiveInteger(accountID, 0);
  if (!id) return { success: false, errorMsg: "INVALID_ACCOUNT_ID" };
  return commitRuntimeAccount(id, readRuntimeAccount(id), false);
}
function acknowledgeLicenseNotice(accountID, revision) {
  const id = toPositiveInteger(accountID, 0), account = readRuntimeAccount(id);
  if (!id || !account.licenseLifecycle || !Number.isSafeInteger(revision)) return { success: false, errorMsg: "INVALID_LICENSE_NOTICE" };
  const outbox = account.licenseLifecycle.outbox;
  if (outbox.some(event => event.revision === revision)) {
    // Only this owner removes an outbox entry; unrelated callers cannot inject
    // an acknowledgment through a stale copy passed to writeRuntimeAccount.
    account.licenseLifecycle.outbox = outbox.filter(event => event.revision !== revision);
    const result = database.write(RUNTIME_TABLE, `/accounts/${id}`, account);
    resetStoreCaches();
    if (!result.success) return result;
  }
  return database.flushTableSync(RUNTIME_TABLE);
}

function computeFutureFileTime(durationDays, currentValue) {
  const days = Math.max(0, Math.trunc(toNumber(durationDays, 0)));
  const baseFileTime = toBigInt(currentValue, 0n);
  const now = currentFileTime();
  const start = baseFileTime > now ? baseFileTime : now;
  return (start + BigInt(days) * FILETIME_TICKS_PER_DAY).toString();
}

function getConfiguredOmegaExpiryFileTime() {
  return config.omegaLicenseEnabled === false
    ? 0n
    : toBigInt(DEFAULT_OMEGA_EXPIRY_FILETIME, 0n);
}

function getEffectiveOmegaExpiryFileTime(runtimeExpiry) {
  const runtime = toBigInt(runtimeExpiry, 0n);
  const configured = getConfiguredOmegaExpiryFileTime();
  return runtime > configured ? runtime : configured;
}

function resolveOmegaLicenseState(accountID) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  const runtimeAccount = readRuntimeAccount(numericAccountID);
  const runtimeExpiry = toBigInt(runtimeAccount.omegaExpiryFileTime, 0n);
  const configuredExpiry = getConfiguredOmegaExpiryFileTime();
  const effectiveExpiry = getEffectiveOmegaExpiryFileTime(runtimeExpiry);
  const now = currentFileTime();

  if (effectiveExpiry > now) {
    return {
      hasLicense: true,
      expiryFileTime: effectiveExpiry.toString(),
      source: runtimeExpiry >= configuredExpiry && runtimeExpiry > 0n
        ? "runtime"
        : "config",
      lastModifiedFileTime: runtimeAccount.licenseLifecycle?.lastModifiedFileTime || licenseLifecycle.INITIAL_MODIFIED,
    };
  }

  return {
    hasLicense: false,
    expiryFileTime: null,
    source: "none",
    lastModifiedFileTime: runtimeAccount.licenseLifecycle?.lastModifiedFileTime || licenseLifecycle.INITIAL_MODIFIED,
  };
}

function getOmegaTrainingHistory(accountID) {
  const account = readRuntimeAccount(accountID), saved = account.licenseLifecycle;
  const currentExpiry = getEffectiveOmegaExpiryFileTime(account.omegaExpiryFileTime).toString();
  return require("../skills/omegaTrainingIntervals").planHistory(saved?.history,
    saved?.expiryFileTime || currentExpiry, currentExpiry, currentFileTime().toString());
}

function grantOmegaDaysToAccount(accountID, durationDays) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  if (!numericAccountID) {
    return null;
  }
  const runtimeAccount = readRuntimeAccount(numericAccountID);
  const expiryFileTime = computeFutureFileTime(
    durationDays,
    getEffectiveOmegaExpiryFileTime(runtimeAccount.omegaExpiryFileTime),
  );
  const nextRuntimeAccount = {
    ...runtimeAccount,
    omegaExpiryFileTime: expiryFileTime,
  };
  if (!writeRuntimeAccount(numericAccountID, nextRuntimeAccount)) return null;
  return {
    accountID: numericAccountID,
    expiryFileTime,
  };
}

function applyRuntimeAccountFulfillmentOnce(
  accountID,
  idempotencyKey,
  fingerprint,
  applyGrant,
) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  const normalizedKey = String(idempotencyKey || "").trim();
  const normalizedFingerprint = String(fingerprint || "").trim();
  if (!numericAccountID) {
    return { success: false, errorMsg: "ACCOUNT_NOT_FOUND" };
  }
  if (!normalizedKey || !normalizedFingerprint || typeof applyGrant !== "function") {
    return { success: false, errorMsg: "INVALID_FULFILLMENT_RECEIPT" };
  }

  const runtimeAccount = readRuntimeAccount(numericAccountID);
  const existing = normalizeFulfillmentReceipts(
    runtimeAccount.fulfillmentReceipts,
  ).find((receipt) => receipt.idempotencyKey === normalizedKey);
  if (existing) {
    if (existing.fingerprint !== normalizedFingerprint) {
      return {
        success: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENCY_KEY_REUSED",
      };
    }
    const committed = database.flushTableSync(RUNTIME_TABLE);
    if (!committed.success) return committed;
    licenseLifecycle.signalAccount(numericAccountID);
    return {
      success: true,
      duplicate: true,
      data: cloneValue(existing.result),
    };
  }

  const applied = applyGrant(cloneValue(runtimeAccount));
  if (!applied || applied.success !== true || !applied.account) {
    return applied || { success: false, errorMsg: "FULFILLMENT_WRITE_FAILED" };
  }
  const receipt = {
    idempotencyKey: normalizedKey,
    fingerprint: normalizedFingerprint,
    result: cloneValue(applied.data || null),
    completedAt: new Date().toISOString(),
  };
  const written = writeRuntimeAccount(numericAccountID, {
    ...applied.account,
    fulfillmentReceipts: [
      receipt,
      ...normalizeFulfillmentReceipts(runtimeAccount.fulfillmentReceipts)
        .filter((candidate) => candidate.idempotencyKey !== normalizedKey),
    ].slice(0, MAX_FULFILLMENT_RECEIPTS),
  });
  if (!written) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
  return {
    success: true,
    duplicate: false,
    data: cloneValue(applied.data || null),
  };
}

function grantOmegaDaysToAccountIdempotent(
  accountID,
  durationDays,
  idempotencyKey,
) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  const days = Math.max(0, Math.trunc(toNumber(durationDays, 0)));
  const fingerprint = JSON.stringify({
    kind: "omega",
    accountID: numericAccountID,
    durationDays: days,
  });
  return applyRuntimeAccountFulfillmentOnce(
    numericAccountID,
    idempotencyKey,
    fingerprint,
    (runtimeAccount) => {
      const expiryFileTime = computeFutureFileTime(
        days,
        getEffectiveOmegaExpiryFileTime(runtimeAccount.omegaExpiryFileTime),
      );
      return {
        success: true,
        account: {
          ...runtimeAccount,
          omegaExpiryFileTime: expiryFileTime,
        },
        data: {
          accountID: numericAccountID,
          expiryFileTime,
        },
      };
    },
  );
}

function getBaseTrainingSlotsForAccount(accountID) {
  const state = loadStoreState();
  const normalizedAccountID = toPositiveInteger(accountID, 0);
  if (!normalizedAccountID) {
    return {};
  }
  for (const account of Object.values(state.accounts)) {
    if (toPositiveInteger(account && account.id, 0) !== normalizedAccountID) {
      continue;
    }
    return normalizeTrainingSlots(account && account.multiCharacterTrainingSlots);
  }
  return {};
}

function getTrainingSlotsForAccount(accountID) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  const baseSlots = getBaseTrainingSlotsForAccount(numericAccountID);
  const runtimeAccount = readRuntimeAccount(numericAccountID);
  const runtimeSlots = normalizeTrainingSlots(
    runtimeAccount && runtimeAccount.multiCharacterTrainingSlots,
  );
  const nextSlots = {
    ...baseSlots,
  };
  for (const [slotKey, expiryValue] of Object.entries(runtimeSlots)) {
    const previous = toBigInt(nextSlots[slotKey], 0n);
    const next = toBigInt(expiryValue, 0n);
    nextSlots[slotKey] = (next > previous ? next : previous).toString();
  }
  return nextSlots;
}

function getNextMctSlotKey(trainingSlots) {
  const slotEntries = Object.entries(trainingSlots)
    .map(([slotKey, expiryValue]) => ({
      slotKey: String(slotKey),
      slot: toPositiveInteger(slotKey, 0),
      expiry: toBigInt(expiryValue, 0n),
    }))
    .filter((entry) => entry.slot >= 2)
    .sort((left, right) => {
      if (left.expiry === right.expiry) {
        return left.slot - right.slot;
      }
      return left.expiry < right.expiry ? -1 : 1;
    });

  if (slotEntries.length === 0) {
    return "2";
  }
  return slotEntries[0].slotKey;
}

function grantMctDaysToAccount(accountID, durationDays, slotCount = 1) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  const slotsToGrant = Math.max(1, Math.trunc(toNumber(slotCount, 1)));
  if (!numericAccountID) {
    return null;
  }
  const runtimeAccount = readRuntimeAccount(numericAccountID);
  const mergedSlots = getTrainingSlotsForAccount(numericAccountID);
  const grantedSlots = [];

  for (let index = 0; index < slotsToGrant; index += 1) {
    const slotKey = getNextMctSlotKey(mergedSlots);
    const expiryFileTime = computeFutureFileTime(durationDays, mergedSlots[slotKey]);
    mergedSlots[slotKey] = expiryFileTime;
    grantedSlots.push({
      slot: Number(slotKey),
      expiryFileTime,
    });
  }

  const nextRuntimeAccount = {
    ...runtimeAccount,
    multiCharacterTrainingSlots: {
      ...normalizeTrainingSlots(runtimeAccount.multiCharacterTrainingSlots),
      ...mergedSlots,
    },
  };
  if (!writeRuntimeAccount(numericAccountID, nextRuntimeAccount)) return null;
  return {
    accountID: numericAccountID,
    grantedSlots,
    slots: cloneValue(mergedSlots),
  };
}

function grantMctDaysToAccountIdempotent(
  accountID,
  durationDays,
  slotCount,
  idempotencyKey,
) {
  const numericAccountID = toPositiveInteger(accountID, 0);
  const days = Math.max(0, Math.trunc(toNumber(durationDays, 0)));
  const slotsToGrant = Math.max(1, Math.trunc(toNumber(slotCount, 1)));
  const fingerprint = JSON.stringify({
    kind: "mct",
    accountID: numericAccountID,
    durationDays: days,
    slotCount: slotsToGrant,
  });
  return applyRuntimeAccountFulfillmentOnce(
    numericAccountID,
    idempotencyKey,
    fingerprint,
    (runtimeAccount) => {
      const mergedSlots = {
        ...getTrainingSlotsForAccount(numericAccountID),
      };
      const grantedSlots = [];
      for (let index = 0; index < slotsToGrant; index += 1) {
        const slotKey = getNextMctSlotKey(mergedSlots);
        const expiryFileTime = computeFutureFileTime(days, mergedSlots[slotKey]);
        mergedSlots[slotKey] = expiryFileTime;
        grantedSlots.push({
          slot: Number(slotKey),
          expiryFileTime,
        });
      }
      return {
        success: true,
        account: {
          ...runtimeAccount,
          multiCharacterTrainingSlots: {
            ...normalizeTrainingSlots(runtimeAccount.multiCharacterTrainingSlots),
            ...mergedSlots,
          },
        },
        data: {
          accountID: numericAccountID,
          grantedSlots,
          slots: cloneValue(mergedSlots),
        },
      };
    },
  );
}

function appendPurchaseLog(entry = {}) {
  const state = loadStoreState();
  const configState = state.config;
  const nextEntry = {
    id:
      typeof entry.id === "string" && entry.id.trim() !== ""
        ? entry.id.trim()
        : `purchase-${Date.now()}`,
    completedAt:
      typeof entry.completedAt === "string" && entry.completedAt.trim() !== ""
        ? entry.completedAt.trim()
        : new Date().toISOString(),
    ...cloneValue(entry),
  };
  const nextLog = [
    nextEntry,
    ...ensureArray(state.runtime.purchaseLog),
  ].slice(0, configState.purchaseLogLimit);
  database.write(RUNTIME_TABLE, "/purchaseLog", nextLog);
  resetStoreCaches();
  return nextEntry;
}

function markPurchaseCompleted(purchaseKey, payload = {}) {
  const normalizedKey = String(purchaseKey || "").trim();
  if (!normalizedKey) {
    return null;
  }
  const state = loadStoreState();
  const nextRecord = {
    completedAt: new Date().toISOString(),
    ...cloneValue(payload),
  };
  const nextCompletedPurchases = {
    ...ensureObject(state.runtime.completedPurchases),
    [normalizedKey]: nextRecord,
  };
  database.write(RUNTIME_TABLE, "/completedPurchases", nextCompletedPurchases);
  resetStoreCaches();
  return cloneValue(nextRecord);
}

function getCompletedPurchase(purchaseKey) {
  const state = loadStoreState();
  return cloneValue(
    ensureObject(state.runtime.completedPurchases)[String(purchaseKey || "").trim()] ||
      null,
  );
}

function finalizePurchaseOnce(purchaseKey, payload = {}) {
  const normalizedKey = String(purchaseKey || "").trim();
  if (!normalizedKey) {
    return { success: false, errorMsg: "PURCHASE_KEY_REQUIRED" };
  }
  const state = loadStoreState();
  const completedPurchases = ensureObject(state.runtime.completedPurchases);
  const existing = completedPurchases[normalizedKey];
  if (existing) {
    return {
      success: true,
      duplicate: true,
      data: cloneValue(existing),
    };
  }

  const completedAt = new Date().toISOString();
  const completedRecord = {
    completedAt,
    ...cloneValue(payload),
  };
  const logEntry = {
    id: normalizedKey,
    completedAt,
    ...cloneValue(payload),
  };
  const nextRuntime = {
    ...cloneValue(state.runtime),
    completedPurchases: {
      ...completedPurchases,
      [normalizedKey]: completedRecord,
    },
    purchaseLog: [
      logEntry,
      ...ensureArray(state.runtime.purchaseLog)
        .filter((entry) => String(entry && entry.id || "") !== normalizedKey),
    ].slice(0, state.config.purchaseLogLimit),
  };
  const writeResult = database.write(RUNTIME_TABLE, "/", nextRuntime);
  if (!writeResult || writeResult.success !== true) {
    return writeResult || { success: false, errorMsg: "WRITE_ERROR" };
  }
  const flushResult = database.flushTableSync(RUNTIME_TABLE);
  if (!flushResult || flushResult.success !== true) {
    return flushResult || { success: false, errorMsg: "FLUSH_ERROR" };
  }
  resetStoreCaches();
  return {
    success: true,
    duplicate: false,
    data: cloneValue(completedRecord),
  };
}

function getEditorSnapshot() {
  const state = loadStoreState();
  return {
    generatedAt: new Date().toISOString(),
    authority: cloneValue(state.authority),
    runtime: cloneValue(state.runtime),
    config: cloneValue(state.config),
  };
}

function saveEditorAuthority(nextAuthority, options = {}) {
  const authorityValue = ensureObject(nextAuthority);
  const runtimeValue = options.runtime ? cloneValue(ensureObject(options.runtime)) : null;
  const changedAccounts = [];
  if (runtimeValue) {
    runtimeValue.accounts = { ...ensureObject(runtimeValue.accounts) };
    const previous = ensureObject(loadStoreState().runtime.accounts);
    for (const key of new Set([...Object.keys(previous), ...Object.keys(runtimeValue.accounts)])) {
      const id = toPositiveInteger(key, 0);
      if (!id) continue;
      const next = ensureObject(runtimeValue.accounts[key]);
      runtimeValue.accounts[key] = { ...next, licenseLifecycle: licenseLifecycle.plan(previous[key], next, getConfiguredOmegaExpiryFileTime()) };
      changedAccounts.push(id);
    }
  }
  const authorityWrite = database.write(AUTHORITY_TABLE, "/", authorityValue);
  if (!authorityWrite.success) throw new Error(authorityWrite.errorMsg);
  if (runtimeValue) {
    const runtimeWrite = database.write(RUNTIME_TABLE, "/", runtimeValue);
    if (!runtimeWrite.success) throw new Error(runtimeWrite.errorMsg);
  }
  resetStoreCaches();
  const flushed = database.flushTablesSync(runtimeValue ? [AUTHORITY_TABLE, RUNTIME_TABLE] : [AUTHORITY_TABLE]);
  if (!flushed.success) throw new Error(flushed.errorMsg || "STORE_EDITOR_WRITE_FAILED");
  for (const id of changedAccounts) licenseLifecycle.signalAccount(id);
  return getEditorSnapshot();
}

module.exports = {
  getOmegaTrainingHistory,
  listLicenseAccountIDs,
  reconcileLicenseAccount,
  acknowledgeLicenseNotice,
  appendPurchaseLog,
  buildClientGlobalConfigEntries,
  computeFutureFileTime,
  findFastCheckoutOffer,
  findLegacyOffer,
  findLegacyOfferByStoreOfferID,
  findPublicOffer,
  findPublicOfferForLegacyOffer,
  findQuickPayToken,
  finalizePurchaseOnce,
  getCompletedPurchase,
  getEditorSnapshot,
  getFastCheckoutOffers,
  getLegacyCatalog,
  getQuickPayTokens,
  getStoreConfig,
  getTrainingSlotsForAccount,
  grantMctDaysToAccount,
  grantMctDaysToAccountIdempotent,
  grantOmegaDaysToAccount,
  grantOmegaDaysToAccountIdempotent,
  markPurchaseCompleted,
  readRuntimeAccount,
  resetStoreCaches,
  resolveCharacterAccountID,
  resolveOmegaLicenseState,
  resolveStoreCharacterID,
  saveEditorAuthority,
  writeRuntimeAccount,
  writeRewardAccount,
};
