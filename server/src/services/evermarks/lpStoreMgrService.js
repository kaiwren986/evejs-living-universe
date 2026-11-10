"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildBoundObjectResponse,
  buildList,
  resolveBoundNodeId,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const structureState = require(path.join(
  __dirname,
  "../structure/structureState",
));
const {
  STRUCTURE_SERVICE_ID,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "../structure/structurePayloads"));
const {
  HERALDRY_CORPORATION_ID,
  listHeraldryOffersForCharacter,
  takeHeraldryOfferForCharacter,
} = require("./evermarksStore");
const {
  hasStaticLpStoreOffers,
  getStaticLpStoreOfferRecord,
  listStaticLpStoreOffers,
} = require(path.join(__dirname, "../loyalty/lpStoreOfferCatalog"));
const {
  getDockedLocationID,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  prepareLpStorePurchase,
  settleLpStorePurchase,
} = require("./lpStorePurchaseState");
const {
  corporationAuthorityHasRole,
  getPersistedCorporationAuthority,
} = require(path.join(__dirname, "../corporation/corporationAuthority"));
const {
  CORP_ROLE_DIRECTOR,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));

const ERROR_MESSAGES = Object.freeze({
  ACCESS_DENIED: "You do not have permission to spend your corporation's funds.",
  ALREADY_OWNED: "You already own that emblem.",
  AK_UNSUPPORTED: "That offer requires unsupported currency.",
  CHARACTER_NOT_FOUND: "Character data is unavailable for this purchase.",
  CORPORATION_NOT_FOUND: "Corporation data is unavailable for this purchase.",
  INSUFFICIENT_EVERMARKS: "You do not have enough EverMarks.",
  INSUFFICIENT_ISK: "You do not have enough ISK.",
  INSUFFICIENT_LP: "You do not have enough loyalty points.",
  INSUFFICIENT_REQUIRED_ITEMS: "You do not have the required items for that offer.",
  INVALID_CHARACTER: "Character data is unavailable for this purchase.",
  INVALID_QUANTITY: "Heraldry offers can only be purchased one at a time.",
  INVALID_STORE: "That LP store is not available.",
  ITEM_GRANT_FAILED: "LP store purchase delivery failed.",
  LICENSE_NOT_FOUND: "That Heraldry emblem could not be resolved.",
  LOYALTY_STORE_UNAVAILABLE: "That loyalty store service is not available.",
  OFFER_NOT_FOUND: "That offer is no longer available.",
  PURCHASE_ALREADY_PENDING: "Another LP store purchase is still being processed.",
  REQ_ITEMS_UNSUPPORTED: "That offer requires unsupported extra items.",
});

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function throwStoreError(errorMsg) {
  throwWrappedUserError("CustomNotify", {
    notify:
      ERROR_MESSAGES[String(errorMsg || "").toUpperCase()] ||
      "LP store purchase failed.",
  });
}

function getSessionStructureID(session) {
  for (const candidate of [
    session && session.structureID,
    session && session.structureid,
  ]) {
    const structureID = normalizePositiveInteger(candidate, 0);
    if (structureID) {
      return structureID;
    }
  }
  return 0;
}

function ensureStructureLoyaltyStoreAccess(session) {
  const structureID = getSessionStructureID(session);
  if (!structureID) {
    return;
  }

  const structure = structureState.getStructureByID(structureID, {
    refresh: false,
  });
  if (
    !structure ||
    !characterHasStructureService(
      session,
      structure,
      STRUCTURE_SERVICE_ID.LOYALTY_STORE,
    )
  ) {
    throwStoreError("LOYALTY_STORE_UNAVAILABLE");
  }
}

function resolveSessionCharacterID(session) {
  return normalizePositiveInteger(
    session && (session.characterID || session.charid),
    0,
  );
}

function normalizeStaticOfferQuantity(value, fallback = 1) {
  return normalizePositiveInteger(value, fallback);
}

function getItemStore() {
  return require(path.join(__dirname, "../inventory/itemStore"));
}

function resolveInventoryNotificationItem(change) {
  if (!change || typeof change !== "object") {
    return null;
  }
  if (change.item && typeof change.item === "object") {
    return change.item;
  }
  if (change.removed === true && change.previousData) {
    const {
      buildRemovedItemNotificationState,
    } = getItemStore();
    return buildRemovedItemNotificationState(change.previousData);
  }
  return null;
}

function getSyncInventoryItemForSession() {
  const characterState = require(path.join(__dirname, "../character/characterState"));
  return typeof characterState.syncInventoryItemForSession === "function"
    ? characterState.syncInventoryItemForSession
    : null;
}

function getCharacterSessions(characterID, excludedSession = null) {
  const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
  const recipients = new Set();
  for (const candidateSession of sessionRegistry.getSessions()) {
    if (
      candidateSession &&
      candidateSession !== excludedSession &&
      resolveSessionCharacterID(candidateSession) === characterID &&
      typeof candidateSession.sendNotification === "function"
    ) {
      recipients.add(candidateSession);
    }
  }
  return [...recipients];
}

function syncInventoryChangesToSession(session, changes = []) {
  const syncInventoryItemForSession = getSyncInventoryItemForSession();
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    typeof syncInventoryItemForSession !== "function"
  ) {
    return;
  }

  for (const change of changes) {
    const notificationItem = resolveInventoryNotificationItem(change);
    if (!notificationItem) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      notificationItem,
      change.previousData || change.previousState || {},
      { emitCfgLocation: true },
    );
  }
}

function notifyStaticLpStoreInventoryChanges(session, characterID, changes = []) {
  const normalizedChanges = Array.isArray(changes) ? changes : [];
  if (normalizedChanges.length === 0) {
    return;
  }

  for (const recipientSession of getCharacterSessions(characterID, session)) {
    syncInventoryChangesToSession(recipientSession, normalizedChanges);
  }

  if (
    !session ||
    resolveSessionCharacterID(session) !== characterID ||
    typeof session.sendNotification !== "function"
  ) {
    return;
  }

  syncInventoryChangesToSession(session, normalizedChanges);
}

async function takeStaticOfferForCharacter(
  session,
  corpID,
  offerID,
  numberOfOffers = 1,
  payer = {},
) {
  const characterID = resolveSessionCharacterID(session);
  const normalizedCorpID = normalizePositiveInteger(corpID, 0);
  const normalizedOfferID = normalizePositiveInteger(offerID, 0);
  const normalizedNumberOfOffers = normalizeStaticOfferQuantity(numberOfOffers, 1);
  if (!characterID) {
    return {
      success: false,
      errorMsg: "INVALID_CHARACTER",
    };
  }
  if (!normalizedCorpID || !hasStaticLpStoreOffers(normalizedCorpID)) {
    return {
      success: false,
      errorMsg: "INVALID_STORE",
    };
  }

  const offer = getStaticLpStoreOfferRecord(normalizedCorpID, normalizedOfferID);
  if (!offer || normalizePositiveInteger(offer.typeID, 0) <= 0) {
    return {
      success: false,
      errorMsg: "OFFER_NOT_FOUND",
    };
  }
  if (normalizePositiveInteger(offer.akCost, 0) > 0) {
    return {
      success: false,
      errorMsg: "AK_UNSUPPORTED",
    };
  }

  const locationID = normalizePositiveInteger(getDockedLocationID(session), 0);
  if (!locationID) {
    return {
      success: false,
      errorMsg: "INVALID_STORE",
    };
  }

  const prepared = prepareLpStorePurchase({
    payerCorporationID: payer.payerCorporationID,
    accountKey: payer.accountKey,
    characterID,
    corpID: normalizedCorpID,
    locationID,
    offer,
    numberOfOffers: normalizedNumberOfOffers,
  });
  if (!prepared.success) {
    return prepared;
  }
  const settled = await settleLpStorePurchase(characterID);
  if (!settled || settled.success !== true) {
    const error = new Error(
      settled && settled.errorMsg || "LP store purchase settlement deferred",
    );
    error.code = settled && settled.ambiguous === true
      ? "LP_STORE_PURCHASE_OUTCOME_AMBIGUOUS"
      : "LP_STORE_PURCHASE_SETTLEMENT_PENDING";
    throw error;
  }
  if (settled.rejected !== true) {
    notifyStaticLpStoreInventoryChanges(
      session,
      characterID,
      settled.data && settled.data.inventoryChanges,
    );
  }
  return settled;
}

function takeOffer(args, session, payer = {}) {
  const corpID = Array.isArray(args) && args.length > 0 ? args[0] : HERALDRY_CORPORATION_ID;
  const offerID = Array.isArray(args) && args.length > 1 ? args[1] : 0;
  const numberOfOffers = Array.isArray(args) && args.length > 2 ? args[2] : 1;
  const normalizedCorpID = normalizePositiveInteger(corpID, HERALDRY_CORPORATION_ID);
  const result = normalizedCorpID === HERALDRY_CORPORATION_ID
    ? takeHeraldryOfferForCharacter(
      session,
      normalizedCorpID,
      offerID,
      numberOfOffers,
    )
    : takeStaticOfferForCharacter(
      session,
      normalizedCorpID,
      offerID,
      numberOfOffers,
      payer,
    );
  const finalize = (settledResult) => {
    if (
      !settledResult ||
      settledResult.success !== true ||
      settledResult.rejected === true
    ) {
      throwStoreError(settledResult && settledResult.errorMsg);
    }
    return true;
  };
  if (result && typeof result.then === "function") {
    return result.then(finalize).catch((error) => {
      if (error && error.name === "MachoWrappedException") {
        throw error;
      }
      log.warn(
        `[LPStoreMgr] purchase settlement deferred char=` +
          `${resolveSessionCharacterID(session)}: ${error.message}`,
      );
      return true;
    });
  }
  return finalize(result);
}

class LPStoreMgrService extends BaseService {
  constructor() {
    super("LPStoreMgr");
  }

  Handle_MachoResolveObject() {
    log.debug("[LPStoreMgr] MachoResolveObject");
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session, kwargs) {
    log.debug("[LPStoreMgr] MachoBindObject");
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetAvailableOffersFromCorp(args, session) {
    log.debug("[LPStoreMgr] GetAvailableOffersFromCorp");
    ensureStructureLoyaltyStoreAccess(session);
    const corpID = Array.isArray(args) && args.length > 0
      ? normalizePositiveInteger(args[0], HERALDRY_CORPORATION_ID)
      : HERALDRY_CORPORATION_ID;
    let offers;
    if (corpID === HERALDRY_CORPORATION_ID) {
      offers = listHeraldryOffersForCharacter(
        session && session.characterID,
        corpID,
      );
    } else if (hasStaticLpStoreOffers(corpID)) {
      offers = listStaticLpStoreOffers(corpID);
    } else {
      offers = listHeraldryOffersForCharacter(
        session && session.characterID,
        corpID,
      );
    }
    return buildList(offers);
  }

  Handle_TakeOfferForCharacter(args, session) {
    log.debug("[LPStoreMgr] TakeOfferForCharacter");
    ensureStructureLoyaltyStoreAccess(session);
    return takeOffer(args, session);
  }

  Handle_TakeOfferForCorporation(args, session) {
    log.debug("[LPStoreMgr] TakeOfferForCorporation");
    ensureStructureLoyaltyStoreAccess(session);
    const corpID = Array.isArray(args) && args.length > 0
      ? normalizePositiveInteger(args[0], 0)
      : 0;
    if (!corpID || corpID === HERALDRY_CORPORATION_ID) {
      throwStoreError("INVALID_STORE");
    }
    // Retail only offers corporation funding to a Director: V24.01's
    // lpStoreSvc.CanCharacterUseCorpWallets is `session.corprole & corpRoleDirector`, and
    // it refuses the Heraldry store outright. That one test also settles the ISK half --
    // a Director's session role mask already carries every Account Take bit that
    // eve.common.lib.corporations.ValidateCorpWalletDivisionAccess looks for, so a
    // per-division check could not reject a caller who got this far.
    const authority = getPersistedCorporationAuthority(session);
    if (!corporationAuthorityHasRole(authority, CORP_ROLE_DIRECTOR)) {
      log.warn(
        `[LPStoreMgr] TakeOfferForCorporation denied: not a director ` +
          `char=${resolveSessionCharacterID(session)} store=${corpID}`,
      );
      throwStoreError("ACCESS_DENIED");
    }
    // The client sends no division. It prices the offer against
    // wallet.GetCorpWealth(session.corpAccountKey), so the debit has to leave that same
    // division or the confirmation the player accepted was against a different balance.
    return takeOffer(args, session, {
      payerCorporationID: authority.corporationID,
      accountKey: normalizeCorporationWalletKey(
        session && (session.corpAccountKey ?? session.corpaccountkey),
      ),
    });
  }
}

module.exports = LPStoreMgrService;
