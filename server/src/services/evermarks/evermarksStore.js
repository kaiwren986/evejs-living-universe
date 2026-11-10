"use strict";

const path = require("path");

const {
  EVERMARK_ISSUER_CORP_ID,
} = require(path.join(__dirname, "../corporation/lpWalletState"));
const {
  HERALDRY_CORPORATION_ID,
} = require("./evermarksConstants");
const {
  getHeraldryOfferByID,
  listAllHeraldryOffers,
} = require("./evermarksCatalog");
const {
  getOwnedShipLogoEntitlementByTypeID,
} = require("./evermarksEntitlements");
const {
  prepareEvermarkPurchase,
  settleEvermarkPurchase,
} = require("./evermarkPurchaseState");
const {
  buildLpStoreOfferKeyVal,
} = require(path.join(__dirname, "../loyalty/lpStoreOfferCatalog"));

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function buildOfferKeyVal(offer, characterID = 0) {
  void characterID;
  return buildLpStoreOfferKeyVal(offer, HERALDRY_CORPORATION_ID);
}

function listHeraldryOffersForCharacter(characterID, corpID = HERALDRY_CORPORATION_ID) {
  const numericCorpID = normalizePositiveInteger(corpID, HERALDRY_CORPORATION_ID);
  if (numericCorpID !== HERALDRY_CORPORATION_ID) {
    return [];
  }

  const numericCharacterID = normalizePositiveInteger(characterID, 0);
  return listAllHeraldryOffers().map((offer) =>
    buildOfferKeyVal(offer, numericCharacterID),
  );
}

function takeHeraldryOfferForCharacter(session, corpID, offerID, numberOfOffers = 1) {
  const numericCharacterID = normalizePositiveInteger(
    session && session.characterID,
    0,
  );
  const numericCorpID = normalizePositiveInteger(corpID, HERALDRY_CORPORATION_ID);
  const numericOfferID = normalizePositiveInteger(offerID, 0);
  const numericNumberOfOffers = normalizePositiveInteger(numberOfOffers, 1);

  if (!numericCharacterID) {
    return {
      success: false,
      errorMsg: "INVALID_CHARACTER",
    };
  }
  if (numericCorpID !== HERALDRY_CORPORATION_ID) {
    return {
      success: false,
      errorMsg: "INVALID_STORE",
    };
  }
  if (numericNumberOfOffers !== 1) {
    return {
      success: false,
      errorMsg: "INVALID_QUANTITY",
    };
  }

  const offer = getHeraldryOfferByID(numericOfferID);
  if (!offer || normalizePositiveInteger(offer.corpID, 0) !== numericCorpID) {
    return {
      success: false,
      errorMsg: "OFFER_NOT_FOUND",
    };
  }
  if (Array.isArray(offer.reqItems) && offer.reqItems.length > 0) {
    return {
      success: false,
      errorMsg: "REQ_ITEMS_UNSUPPORTED",
    };
  }
  if (getOwnedShipLogoEntitlementByTypeID(numericCharacterID, offer.typeID)) {
    return {
      success: false,
      errorMsg: "ALREADY_OWNED",
    };
  }

  const prepared = prepareEvermarkPurchase({
    characterID: numericCharacterID,
    offer,
  });
  if (!prepared.success) {
    return prepared;
  }
  return settleEvermarkPurchase(numericCharacterID);
}

module.exports = {
  EVERMARK_ISSUER_CORP_ID,
  HERALDRY_CORPORATION_ID,
  buildOfferKeyVal,
  listHeraldryOffersForCharacter,
  takeHeraldryOfferForCharacter,
};
