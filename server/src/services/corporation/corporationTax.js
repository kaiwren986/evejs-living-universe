"use strict";

// Corporation tax: the rules only. Each payout path (mission rewards, NPC
// bounties, LP faucets) asks this module how much of a payout its corporation
// withholds and whether the corporation is credited, then does its own
// crediting with its own idempotency keys. Nothing here touches a wallet.

const path = require("path");

const {
  clamp,
  toFiniteNumber,
  toPositiveInt,
} = require(path.join(__dirname, "../../common/numbers"));
const {
  peekCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCorporationRecord,
  isNpcCorporationID,
} = require(path.join(__dirname, "./corporationState"));

const CORPORATION_TAX_CURRENCY = Object.freeze({
  ISK: "ISK",
  LP: "LP",
});

// appConst.minCorporationTaxAmount: corporation tax is only withheld from a
// payout of at least 100,000 ISK, and each payout is measured on its own.
const MIN_CORPORATION_TAX_ISK = 100000.0;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// LP is whole, so the tax is rounded down and the fraction stays with the
// member. CCP documents no LP rounding rule; this is the choice that never
// takes more than the rate. The product is first rounded to 6 places so float noise such as
// 56.99999999999999 (0.57 * 100) doesn't floor a whole LP away.
function roundLoyaltyPointTax(value) {
  return Math.floor(Math.round((Number(value) || 0) * 1e6) / 1e6);
}

function toWholeLoyaltyPoints(value) {
  return Math.trunc(Number(value) || 0);
}

const RULES_BY_CURRENCY = Object.freeze({
  [CORPORATION_TAX_CURRENCY.ISK]: {
    minimum: MIN_CORPORATION_TAX_ISK,
    rate: (profile) => profile.taxRate,
    amount: roundMoney,
    roundTax: roundMoney,
  },
  [CORPORATION_TAX_CURRENCY.LP]: {
    // LP has no minimum: the client names one for ISK tax (ISKTaxRateDescription)
    // and none for LP (LPTaxRateDescription), so every LP payout is taxed.
    minimum: 0,
    // NPC corporations do not tax LP, whatever rate their record holds. CCP's
    // notes only describe the LP rate a player corporation sets.
    rate: (profile) => (profile.isNPC === true ? 0 : profile.loyaltyPointTaxRate),
    amount: toWholeLoyaltyPoints,
    roundTax: roundLoyaltyPointTax,
  },
});

function toRate(value) {
  return clamp(toFiniteNumber(value, 0), 0, 1);
}

// The member's current corporation and its rates. Payout paths decide when to
// read it (missions lock it in when the settlement is prepared) and keep what
// they read, so a retry pays what was locked in.
function resolveCorporationTaxProfile(characterID) {
  const characterRecord = peekCharacterRecord(characterID);
  const corporationID = toPositiveInt(characterRecord && characterRecord.corporationID, 0);
  if (!corporationID) {
    return { corporationID: 0, isNPC: false, taxRate: 0, loyaltyPointTaxRate: 0 };
  }
  const corporationRecord = getCorporationRecord(corporationID);
  return {
    corporationID,
    isNPC: isNpcCorporationID(corporationID) === true,
    taxRate: toRate(corporationRecord && corporationRecord.taxRate),
    loyaltyPointTaxRate: toRate(corporationRecord && corporationRecord.loyaltyPointTaxRate),
  };
}

function computeCorporationTax(profile, currency, gross) {
  const rules = RULES_BY_CURRENCY[currency];
  const amount = rules.amount(gross);
  const tax = amount >= rules.minimum ? rules.roundTax(amount * rules.rate(profile)) : 0;
  return {
    gross: amount,
    tax,
    net: rules.amount(amount - tax),
    corporationID: profile.corporationID,
    credit: tax > 0 && corporationReceivesTax(profile),
  };
}

// NPC corporation tax is withheld from the member but is a sink on
// Tranquility: the NPC corporation is never credited.
function corporationReceivesTax(profile) {
  return toPositiveInt(profile && profile.corporationID, 0) > 0 && profile.isNPC !== true;
}

// A member still pays the tax when the corporation can't receive it: the
// credit is skipped (with a warning) and the tax becomes a sink.
const UNPAYABLE_CORPORATION_TAX_ERRORS = new Set(["CORPORATION_NOT_FOUND"]);

function isUnpayableCorporationTaxError(errorMsg) {
  return UNPAYABLE_CORPORATION_TAX_ERRORS.has(errorMsg);
}

// The client's GetDerivedTransactions yaml-parses a journal description, and a
// top-level {taxRefType: [corporationID, taxAmount]} key is what makes it draw
// the corporation tax row and restore the pre-tax amount on the payout row.
// Alone it is the whole description (missions); `into` appends it as one more
// top-level key of an existing YAML mapping (the bounty NBL: description).
function buildCorporationTaxDescription(taxRefType, corporationID, taxAmount, options = {}) {
  const amount = options.reversal === true ? -taxAmount : taxAmount;
  const key = `${taxRefType}: [${corporationID}, ${amount}]`;
  return options.into ? `${options.into}\n${key}` : key;
}

module.exports = {
  CORPORATION_TAX_CURRENCY,
  MIN_CORPORATION_TAX_ISK,
  buildCorporationTaxDescription,
  computeCorporationTax,
  corporationReceivesTax,
  isUnpayableCorporationTaxError,
  resolveCorporationTaxProfile,
};
