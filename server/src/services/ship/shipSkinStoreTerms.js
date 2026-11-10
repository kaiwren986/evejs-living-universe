"use strict";
const { readStaticTable, TABLE } = require("../_shared/referenceData");
const { positive, fail } = require("./shipSkinState");

function storePriceFromDisplay(value, currency) {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match || text.length > 128 || !["ISK", "PLEX"].includes(currency)) return null;
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const fraction = match[2] || "";
  let units = BigInt(match[1] + fraction);
  const shift = (currency === "ISK" ? 2 : 0) + exponent - fraction.length;
  if (shift >= 0) units *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (units % divisor) return null;
    units /= divisor;
  }
  return units > 0 && units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : null;
}
function formatStorePrice(price, currency) {
  if (currency !== "ISK") return String(price);
  const cents = BigInt(price);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
function validateStoreTerms(terms) {
  const { price, currency, quantity, sourceListingID } = terms || {};
  const policy = readStaticTable(TABLE.SHIP_SKIN_MARKET_AUTHORITY);
  if (!policy.price || !policy.quantity) return fail("SKINR_MARKET_AUTHORITY_MISSING", 503);
  if (!positive(quantity, policy.quantity.maximum) || !["ISK", "PLEX"].includes(currency) ||
      !Number.isSafeInteger(price) || price < policy.price.minimumWholeAmount * (currency === "ISK" ? 100 : 1) ||
      price / (currency === "ISK" ? 100 : 1) > policy.price.maximumWholeAmount || !Number.isSafeInteger(price * quantity)) {
    return fail("INVALID_LISTING_PRICE_OR_QUANTITY", 400);
  }
  if (sourceListingID !== undefined && !/^[a-f0-9]{32}$/.test(sourceListingID)) return fail("INVALID_SKINR_SOURCE_LISTING", 400);
  return { success: true };
}
function termsFromStoreDocument(store) {
  if (!store || typeof store !== "object") return fail("SKINR_STORE_TERMS_REQUIRED", 400);
  const currency = store.currency;
  const price = storePriceFromDisplay(store.price, currency);
  const listingID = store.source?.listing_id;
  if (typeof listingID !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(listingID) ||
      !/^[a-f0-9]{64}$/.test(store.source?.skinr_id || "")) return fail("INVALID_SKINR_SOURCE_LISTING", 400);
  const terms = { price, currency, quantity: store.quantity, sourceListingID: listingID.replaceAll("-", ""), source: structuredClone(store.source) };
  const checked = validateStoreTerms(terms);
  return checked.success ? { success: true, terms } : checked;
}
module.exports = { storePriceFromDisplay, formatStorePrice, validateStoreTerms, termsFromStoreDocument };
