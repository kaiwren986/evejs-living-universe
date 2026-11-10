"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const {
  toNumber,
} = require("../../common/numbers");

const path = require("node:path");

const {
  getCharacterRecord,
  resolveHomeStationInfo,
} = require(path.join(__dirname, "../character/characterState"));
const {
  findFastCheckoutOffer,
  findLegacyOffer,
  findPublicOffer,
  getCompletedPurchase,
  getStoreConfig,
  resolveCharacterAccountID,
  resolveStoreCharacterID,
} = require("./storeState");
const purchaseSettlement = require("./storePurchaseSettlementState");

function toPositiveInteger(value, fallback = 0) {
  const numeric = toNumber(value, fallback);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function buildPurchaseKey(parts = []) {
  return parts
    .map((part) => String(part === undefined || part === null ? "" : part).trim())
    .join("::");
}

function buildRequestScopedSuffix(value) {
  return String(value || "").trim();
}

function resolveLegacyPurchaseCharacters({
  payerCharacterID = 0,
  targetCharacterID = 0,
  accountID = 0,
  session = null,
} = {}) {
  const normalizedAccountID = toPositiveInteger(
    accountID,
    toPositiveInteger(session && (session.userid || session.userID), 0),
  );
  const sessionCharacterID = toPositiveInteger(
    session && (session.characterID || session.charid),
    0,
  );
  const resolvedPayerCharacterID = resolveStoreCharacterID(
    payerCharacterID || sessionCharacterID,
    normalizedAccountID,
  );
  const resolvedTargetCharacterID = resolveStoreCharacterID(
    targetCharacterID || resolvedPayerCharacterID,
    normalizedAccountID,
  ) || resolvedPayerCharacterID;

  return {
    payerCharacterID: resolvedPayerCharacterID,
    targetCharacterID: resolvedTargetCharacterID,
    accountID: normalizedAccountID,
  };
}

function resolveDeliveryLocationID(characterID) {
  const characterRecord = getCharacterRecord(characterID);
  if (!characterRecord) {
    return 0;
  }
  if (characterRecord.structureID) {
    return Number(characterRecord.structureID);
  }
  if (characterRecord.stationID) {
    return Number(characterRecord.stationID);
  }
  const homeStationInfo = resolveHomeStationInfo(characterRecord);
  return Number(homeStationInfo.homeStationID || 60003760) || 60003760;
}

function buildReceiptPayload(offer, quantity, paymentMethod, paymentIdentifier) {
  const publicOffer = cloneValue(offer) || {};
  const itemQuantity = Math.max(1, Math.trunc(toNumber(quantity, 1)));
  const itemName = String(publicOffer.name || "Store offer");
  const plexPriceInCents = Math.max(
    0,
    Math.trunc(toNumber(publicOffer.plexPriceInCents, 0) * itemQuantity),
  );
  const currencyAmountInCents = Math.max(
    0,
    Math.trunc(toNumber(publicOffer.currencyAmountInCents, 0) * itemQuantity),
  );
  const catalogAmountInCents = publicOffer.currencyCode
    ? currencyAmountInCents
    : plexPriceInCents;

  return {
    order: {
      offer: { store_offer: String(publicOffer.storeOfferID || "") },
      quantity: itemQuantity,
      cost: {
        catalog_amount_in_cents: catalogAmountInCents,
        tax_amount_in_cents: 0,
        total_amount_in_cents: catalogAmountInCents,
        tax_rate_points: 0,
        currency: publicOffer.currencyCode || "PLX",
      },
    },
    payment_identifier: {
      sequential: Math.max(1, Math.trunc(toNumber(paymentIdentifier, Date.now()))),
    },
    payment_method: paymentMethod,
    description: itemName,
    items: [{ name: itemName, quantity: itemQuantity }],
  };
}

function getRepeatedResult(purchaseKey) {
  const completed = purchaseKey ? getCompletedPurchase(purchaseKey) : null;
  return completed
    ? { success: true, repeated: true, completed }
    : null;
}

async function prepareAndSettle(options) {
  const prepared = purchaseSettlement.prepareStorePurchaseSettlement(options);
  if (!prepared || prepared.success !== true) {
    return prepared || { success: false, errorMsg: "PURCHASE_PREPARE_FAILED" };
  }
  const settled = await purchaseSettlement.settleStorePurchaseSettlement(
    prepared.data.operationID,
  );
  if (!settled || settled.success !== true) {
    return settled || { success: false, errorMsg: "PURCHASE_SETTLEMENT_FAILED" };
  }
  if (settled.rejected === true) {
    return { success: false, errorMsg: settled.errorMsg || "PURCHASE_REJECTED" };
  }
  const completed = settled.data || getCompletedPurchase(prepared.data.purchaseKey);
  if (!completed) {
    return { success: false, ambiguous: true, errorMsg: "PURCHASE_RESULT_MISSING" };
  }
  return {
    success: true,
    repeated: prepared.duplicate === true || settled.alreadySettled === true,
    purchaseKey: prepared.data.purchaseKey,
    completed,
  };
}

async function grantFulfillmentToCharacter(
  characterID,
  fulfillment,
  quantity,
  options = {},
) {
  const operationID = String(options.idempotencyKey || "").trim();
  if (!operationID) {
    return { success: false, errorMsg: "IDEMPOTENCY_KEY_REQUIRED" };
  }
  return purchaseSettlement.applyFulfillmentToCharacter(
    characterID,
    fulfillment,
    quantity,
    {
      operationID,
      accountID: toPositiveInteger(
        options.accountID,
        resolveCharacterAccountID(characterID),
      ),
      deliveryLocationID: toPositiveInteger(
        options.deliveryLocationID,
        resolveDeliveryLocationID(characterID),
      ),
      reason: options.reason,
    },
  );
}

async function purchaseLegacyOffer({
  storeID = 4,
  offerID,
  currency = "PLX",
  quantity = 1,
  characterID,
  targetCharacterID = 0,
  accountID = 0,
  session = null,
}) {
  const configState = getStoreConfig();
  if (!configState.enabled) {
    return { success: false, errorMsg: "STORE_DISABLED" };
  }
  const legacyOffer = findLegacyOffer(storeID, offerID);
  if (!legacyOffer) {
    return { success: false, errorMsg: "OFFER_NOT_FOUND" };
  }
  const purchaseCharacters = resolveLegacyPurchaseCharacters({
    payerCharacterID: characterID,
    targetCharacterID,
    accountID,
    session,
  });
  const payerCharacterID = purchaseCharacters.payerCharacterID;
  const fulfillmentCharacterID = purchaseCharacters.targetCharacterID;
  if (!getCharacterRecord(payerCharacterID) || !getCharacterRecord(fulfillmentCharacterID)) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }

  const normalizedCurrency = String(currency || "").trim().toUpperCase();
  const normalizedQuantity = Math.max(1, Math.trunc(toNumber(quantity, 1)));
  const pricing = Array.isArray(legacyOffer.offerPricings)
    ? legacyOffer.offerPricings.find(
        (entry) => String(entry && entry.currency || "").trim().toUpperCase() ===
          normalizedCurrency,
      )
    : null;
  if (!pricing || normalizedCurrency !== "PLX") {
    return { success: false, errorMsg: "UNSUPPORTED_CURRENCY" };
  }
  const totalPlexCost = Math.max(
    0,
    Math.trunc(toNumber(pricing.price, 0) * normalizedQuantity),
  );
  const targetAccountID = resolveCharacterAccountID(fulfillmentCharacterID);
  const settled = await prepareAndSettle({
    channel: "legacy",
    payerCharacterID,
    characterID: fulfillmentCharacterID,
    accountID: targetAccountID,
    quantity: normalizedQuantity,
    totalPlexCost,
    deliveryLocationID: resolveDeliveryLocationID(fulfillmentCharacterID),
    fulfillment: legacyOffer.fulfillment,
    reason: `New Eden Store purchase: ${legacyOffer.name} x${normalizedQuantity}`,
    response: {
      offerID: legacyOffer.id,
      storeOfferID: legacyOffer.storeOfferID || null,
      currency: normalizedCurrency,
      payerAccountID: resolveCharacterAccountID(payerCharacterID),
    },
  });
  return settled.success
    ? { success: true, repeated: settled.repeated, data: cloneValue(settled.completed.result) }
    : settled;
}

async function purchaseFastCheckoutOffer({
  offerID,
  characterID,
  purchaseTraceID = "",
  journeyID = "",
}) {
  const configState = getStoreConfig();
  if (!configState.enabled) {
    return { success: false, errorMsg: "STORE_DISABLED" };
  }
  if (!configState.fastCheckoutEnabled) {
    return { success: false, errorMsg: "FAST_CHECKOUT_DISABLED" };
  }
  const offer = findFastCheckoutOffer(offerID);
  if (!offer || !offer.storeOfferID) {
    return { success: false, errorMsg: "OfferNotAvailable" };
  }
  const publicOffer = findPublicOffer(offer.storeOfferID);
  if (!publicOffer) {
    return { success: false, errorMsg: "OfferNotAvailable" };
  }

  const requestScope = [purchaseTraceID, journeyID]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("|");
  const purchaseKey = requestScope
    ? buildPurchaseKey(["fast-checkout", characterID, offerID, requestScope])
    : "";
  const repeated = getRepeatedResult(purchaseKey);
  if (repeated) {
    return {
      success: true,
      repeated: true,
      data: cloneValue(repeated.completed.result),
      receipt: cloneValue(repeated.completed.receipt || null),
    };
  }

  const receipt = buildReceiptPayload(publicOffer, 1, 1, Date.now());
  const settled = await prepareAndSettle({
    purchaseKey,
    channel: "fast-checkout",
    payerCharacterID: characterID,
    characterID,
    accountID: resolveCharacterAccountID(characterID),
    quantity: 1,
    totalPlexCost: 0,
    deliveryLocationID: resolveDeliveryLocationID(characterID),
    fulfillment: publicOffer.fulfillment,
    reason: `Fast checkout purchase: ${publicOffer.name}`,
    response: {
      offerID,
      storeOfferID: publicOffer.storeOfferID,
      message: configState.fakeFastCheckoutResponse,
      receipt,
      payerAccountID: resolveCharacterAccountID(characterID),
    },
  });
  return settled.success
    ? {
        success: true,
        repeated: settled.repeated,
        data: cloneValue(settled.completed.result),
        receipt: cloneValue(settled.completed.receipt || receipt),
      }
    : settled;
}

async function purchasePublicCashOffer({
  storeOfferID,
  characterID,
  quantity = 1,
  paymentMethod = 11,
  purchaseKeySuffix = "",
}) {
  const configState = getStoreConfig();
  if (!configState.enabled) {
    return { success: false, errorMsg: "STORE_DISABLED" };
  }
  if (!configState.fakeCashPurchasesEnabled) {
    return { success: false, errorMsg: "PURCHASE_DISABLED" };
  }
  const publicOffer = findPublicOffer(storeOfferID);
  if (!publicOffer) {
    return { success: false, errorMsg: "OFFER_NOT_FOUND" };
  }
  const normalizedQuantity = Math.max(1, Math.trunc(toNumber(quantity, 1)));
  const requestScope = buildRequestScopedSuffix(purchaseKeySuffix);
  const purchaseKey = requestScope
    ? buildPurchaseKey([
        "cash",
        characterID,
        publicOffer.storeOfferID,
        normalizedQuantity,
        requestScope,
      ])
    : "";
  const repeated = getRepeatedResult(purchaseKey);
  if (repeated) {
    return {
      success: true,
      repeated: true,
      data: cloneValue(repeated.completed.result || repeated.completed),
    };
  }

  const receipt = buildReceiptPayload(
    publicOffer,
    normalizedQuantity,
    paymentMethod,
    Date.now(),
  );
  const settled = await prepareAndSettle({
    purchaseKey,
    channel: "cash",
    payerCharacterID: characterID,
    characterID,
    accountID: resolveCharacterAccountID(characterID),
    quantity: normalizedQuantity,
    totalPlexCost: 0,
    deliveryLocationID: resolveDeliveryLocationID(characterID),
    fulfillment: publicOffer.fulfillment,
    reason: `Fake cash purchase: ${publicOffer.name}`,
    response: {
      storeOfferID: publicOffer.storeOfferID,
      receipt,
      payerAccountID: resolveCharacterAccountID(characterID),
    },
  });
  return settled.success
    ? {
        success: true,
        repeated: settled.repeated,
        data: cloneValue(settled.completed.result),
      }
    : settled;
}

async function purchasePlexVaultOffer({
  storeOfferID,
  characterID,
  quantity = 1,
  purchaseKeySuffix = "",
}) {
  const configState = getStoreConfig();
  if (!configState.enabled) {
    return { success: false, errorMsg: "STORE_DISABLED" };
  }
  const publicOffer = findPublicOffer(storeOfferID);
  if (!publicOffer) {
    return { success: false, errorMsg: "OFFER_NOT_FOUND" };
  }
  const normalizedQuantity = Math.max(1, Math.trunc(toNumber(quantity, 1)));
  const requestScope = buildRequestScopedSuffix(purchaseKeySuffix);
  const purchaseKey = requestScope
    ? buildPurchaseKey([
        "plex-vault",
        characterID,
        publicOffer.storeOfferID,
        normalizedQuantity,
        requestScope,
      ])
    : "";
  const repeated = getRepeatedResult(purchaseKey);
  if (repeated) {
    return {
      success: true,
      repeated: true,
      data: cloneValue(repeated.completed.result || repeated.completed),
    };
  }

  const totalPlexCost = Math.max(
    0,
    Math.trunc(
      toNumber(publicOffer.plexPriceInCents, 0) * normalizedQuantity /
        configState.centsPerPlex,
    ),
  );
  const settled = await prepareAndSettle({
    purchaseKey,
    channel: "plex-vault",
    payerCharacterID: characterID,
    characterID,
    accountID: resolveCharacterAccountID(characterID),
    quantity: normalizedQuantity,
    totalPlexCost,
    deliveryLocationID: resolveDeliveryLocationID(characterID),
    fulfillment: publicOffer.fulfillment,
    reason: `PLEX Vault purchase: ${publicOffer.name} x${normalizedQuantity}`,
    response: {
      storeOfferID: publicOffer.storeOfferID,
      payerAccountID: resolveCharacterAccountID(characterID),
    },
  });
  return settled.success
    ? {
        success: true,
        repeated: settled.repeated,
        data: cloneValue(settled.completed.result),
      }
    : settled;
}

module.exports = {
  buildPurchaseKey,
  buildReceiptPayload,
  grantFulfillmentToCharacter,
  purchaseFastCheckoutOffer,
  purchaseLegacyOffer,
  purchasePlexVaultOffer,
  purchasePublicCashOffer,
};
