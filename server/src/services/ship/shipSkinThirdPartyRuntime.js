"use strict";
const state = require("./shipSkinState");
const { randomUUID } = require("node:crypto");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const catalogue = require("./shipSkinStoreAuthority");
const TABLE_NAME = "shipSkinThirdPartyRuntime";
const JOB_TYPE = "skinr.market", binding = createDurableSchedulerBinding(), locks = new Map();
let nowProvider = null, marketNoticeSink = null;
function now() { return nowProvider ? nowProvider() : Date.now(); }
function root() { return { version: 1, licenses: {}, grants: {}, mutations: {}, operations: {}, listings: {}, requests: {}, componentStock: {}, fees: { ISK: "0", PLEX: "0" }, ...state.read(TABLE_NAME) }; }
function grantShipSkinLicense(characterID, hex, quantity, receiptID) {
  if (!state.positive(characterID) || !/^[a-f0-9]{64}$/.test(hex || "") || !state.positive(quantity, 5000) || !state.requestKey(receiptID)) return state.fail("INVALID_SKIN_GRANT", 400);
  const next = root(), fingerprint = state.fingerprint([characterID, hex, quantity]);
  if (next.grants[receiptID]) return next.grants[receiptID] === fingerprint ? { success: true, duplicate: true } : state.fail("SKIN_GRANT_CONFLICT");
  const key = `${characterID}:${hex}`;
  const license = next.licenses[key] ||= { characterID, hex, activated: false, unactivated: 0, escrowed: 0, firstAcquiredMs: Date.now() };
  if (!Number.isSafeInteger(license.unactivated + quantity)) return state.fail("SKIN_QUANTITY_OVERFLOW");
  license.unactivated += quantity;
  next.grants[receiptID] = fingerprint;
  state.write(TABLE_NAME, next);
  return { success: true, license: state.cloneValue(license) };
}
function getOwnedShipSkinLicenses(characterID) { return Object.values(root().licenses).filter(row => row.characterID === characterID && (row.activated || row.unactivated > 0 || row.escrowed > 0)); }
function getShipSkinLicense(characterID, hex) { return root().licenses[`${characterID}:${hex}`] || null; }
function activateShipSkinLicense(characterID, hex, requestID) {
  if (!state.requestKey(requestID) || !state.positive(characterID) || !/^[a-f0-9]{64}$/.test(hex || "")) return state.fail("INVALID_SKIN_ACTIVATION", 400);
  const next = root(), key = `${characterID}:${requestID}`, fingerprint = state.fingerprint(["activate", hex]);
  if (next.mutations[key]) return next.mutations[key] === fingerprint ? { success: true, duplicate: true } : state.fail("SKINR_REQUEST_CONFLICT");
  const license = next.licenses[`${characterID}:${hex}`];
  if (!license) return state.fail("SKINR_LICENSE_NOT_FOUND", 404);
  const duplicate = license.activated;
  if (!duplicate && !license.unactivated) return state.fail("SKINR_NO_TRANSFERABLE_QUANTITY");
  if (!duplicate) { license.unactivated--; license.activated = true; }
  next.mutations[key] = fingerprint;
  state.write(TABLE_NAME, next);
  return { success: true, duplicate, license: state.cloneValue(license) };
}
function getAppliedShipSkin(shipID) {
  const ship = require("../inventory/itemStore").findShipItemById(shipID), application = ship?.skinrApplication;
  if (!application || application.characterID !== Number(ship.ownerID) || !getShipSkinLicense(application.characterID, application.hex)?.activated) return null;
  const design = require("./shipSkinDraftRuntime").getShipSkinDesign(application.hex);
  return design?.layout.ship_type.sequential === Number(ship.typeID) ? { ...application, shipID: Number(shipID), layout: design.layout } : null;
}
function applyShipSkinLicense(characterID, hex, shipID, requestID, unapply = false) {
  if (!state.requestKey(requestID) || !state.positive(shipID) || !state.positive(characterID) || !/^[a-f0-9]{64}$/.test(hex || "")) return state.fail("INVALID_SKIN_APPLICATION", 400);
  const inventory = require("../inventory/itemStore");
  const cosmetics = () => require("./shipCosmeticsState");
  const clearConventional = () => state.check(cosmetics().applySkinToShip(shipID, null, { characterID, durable: true, preserveSkinrApplication: true }));
  const publishApplication = () => require("../../_secondary/express/publicGatewayNotices").getPublicGateway()?.publishShipStateSetNotice(shipID, characterID);
  const receiptKey = `skinr-app:${characterID}:${requestID}`, fingerprint = { characterID, hex, shipID, unapply };
  const prior = inventory.getIdempotentGrantReceipt(receiptKey, { requireDurable: true });
  if (prior.success && prior.found) {
    if (state.fingerprint(prior.data.fingerprint) !== state.fingerprint(fingerprint)) return state.fail("SKINR_REQUEST_CONFLICT");
    const current = inventory.findShipItemById(shipID);
    // The item receipt may commit before conventional cleanup or observer
    // delivery. Match the exact application generation, since a later apply
    // can select the same design. Legacy rows without a receipt cannot prove
    // that their cleanup belongs to this request and remain untouched.
    const matches = unapply ? !current?.skinrApplication : current?.skinrApplication?.characterID === characterID && current.skinrApplication.hex === hex && current.skinrApplication.receiptKey === receiptKey;
    if (Number(current?.ownerID) === characterID && matches) {
      // A conventional replacement can commit its paint before clearing the
      // item application. Replay may clear only the exact paint it superseded.
      if (!unapply && Object.hasOwn(prior.data.metadata || {}, "supersededConventionalSkin") &&
        state.fingerprint(prior.data.metadata.supersededConventionalSkin) === state.fingerprint(cosmetics().getAppliedSkinRecord(shipID))) clearConventional();
      publishApplication();
    }
    return { success: true, duplicate: true };
  }
  if (prior.ambiguous) throw new Error(prior.errorMsg);
  const design = require("./shipSkinDraftRuntime").getShipSkinDesign(hex);
  if (!design || !getShipSkinLicense(characterID, hex)?.activated) return state.fail("ACTIVATED_LICENSE_NOT_FOUND", 404);
  const ship = inventory.findShipItemById(shipID);
  if (!ship || Number(ship.ownerID) !== characterID) return state.fail("SHIP_NOT_OWNED", 403);
  if (Number(ship.typeID) !== design.layout.ship_type.sequential) return state.fail("SKIN_SHIP_TYPE_MISMATCH");
  const session = require("../chat/sessionRegistry").findSessionByCharacterID(characterID);
  const dockedLocation = Number(session?.stationID || session?.stationid || session?.structureID);
  if (!session || !(Number(session._space?.shipID || session.shipID) === shipID || dockedLocation && Number(ship.locationID) === dockedLocation && Number(ship.flagID) === 4)) return state.fail("SHIP_NOT_CONTROLLED", 403);
  // Keep conventional paint until replacement commits. Clearing it before a
  // rejected item write would turn a failed application into a visible unapply.
  // An interrupted replacement may leave superseded conventional state behind;
  // clear that before removing the matching third-party application as well.
  if (unapply && ship.skinrApplication?.hex === hex) clearConventional();
  const result = inventory.setShipSkinrApplicationIdempotent(shipID, characterID, unapply ? null : hex, {
    receiptKey, fingerprint, expectedHex: unapply ? hex : null, requiredTypeID: design.layout.ship_type.sequential,
    receiptMetadata: { supersededConventionalSkin: cosmetics().getAppliedSkinRecord(shipID) },
  });
  if (!result.success) {
    if (result.ambiguous) throw new Error(result.errorMsg);
    return state.fail(result.errorMsg);
  }
  if (!unapply && !result.duplicate) clearConventional();
  if (!result.duplicate) publishApplication();
  return { success: true, duplicate: result.duplicate };
}
function market() { return require("./shipSkinMarketAuthority"); }
function wallet() { return require("../account/walletState"); }
function moneyBalance(actor, currency) {
  const balance = wallet().getCharacterWallet(actor);
  return currency === "ISK" ? Math.round(Number(balance?.balance || 0) * 100) : Number(balance?.plexBalance || 0);
}
function ownedLicense(next, actor, hex) {
  return next.licenses[`${actor}:${hex}`] ||= { characterID: actor, hex, activated: false, unactivated: 0, escrowed: 0, firstAcquiredMs: now() };
}
function lock(key, callback) {
  const previous = locks.get(key) || Promise.resolve(), current = previous.catch(() => {}).then(callback);
  locks.set(key, current);
  return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
}
function notifyTransaction(op) { try { marketNoticeSink?.(op); } catch (_error) { /* Durable status remains available if a stream disconnects. */ } }
function getTransaction(actor, id) { const op = root().operations[id]; return op?.characterID === actor ? op : null; }
function updateOperation(id, patch) {
  const next = root(); Object.assign(next.operations[id], patch, { updatedMs: now() }); state.write(TABLE_NAME, next); return next.operations[id];
}
async function scheduleOperation(op) {
  if (["completed", "refused"].includes(op.state) || !binding.get()) return;
  await binding.get().schedule({ jobID: `skinr:market:${op.id}`, type: JOB_TYPE, dueAtMs: now(), payload: { operationID: op.id } });
}
async function scheduleListing(listing) {
  if (listing.catalogue || listing.state !== "active" || !binding.get()) return;
  await binding.get().schedule({ jobID: `skinr:listing:${listing.id}:expire`, type: JOB_TYPE, dueAtMs: listing.expiresMs, payload: { listingID: listing.id } });
}
function closeListing(next, listing, reason) {
  if (listing.state !== "active") return;
  const license = ownedLicense(next, listing.characterID, listing.hex);
  if (license.escrowed < listing.remaining) throw new Error("SKINR_LISTING_ESCROW_INVARIANT");
  license.escrowed -= listing.remaining; license.unactivated += listing.remaining;
  listing.remaining = 0; listing.state = reason;
}
function maintainCatalogue(next) {
  const revision = catalogue.getShipSkinStoreRevision();
  let changed = false;
  if (revision && next.catalogue?.revision !== revision) {
    const sellerID = catalogue.getShipSkinStoreSellerID(), installedMs = now();
    for (const offer of catalogue.listShipSkinStoreSeedSpecs()) {
      const id = catalogue.getShipSkinStoreListingID(offer.hex), previous = next.listings[id];
      if (previous) {
        if (!previous.catalogue || previous.hex !== offer.hex) throw new Error("SKINR_CATALOGUE_LISTING_ID_COLLISION");
        continue; // Existing stock and sold-out rows survive upgrades/restarts.
      }
      next.listings[id] = { id, characterID: sellerID, hex: offer.hex, catalogue: true, catalogueIndex: offer.index,
        durationSeconds: offer.durationSeconds, currency: offer.currency, price: offer.price, remaining: offer.quantity,
        target: { kind: "public" }, branded: false, taxPercent: 0, createdMs: installedMs,
        expiresMs: installedMs + offer.durationSeconds * 1000 - offer.index, state: "active" };
    }
    next.catalogue = { revision, installedMs }; changed = true;
  }
  const active = Object.values(next.listings).filter(row => row.catalogue && row.state === "active");
  if (active.some(row => row.expiresMs - now() <= catalogue.getShipSkinStoreRenewBeforeMs())) {
    const renewedMs = now();
    for (const row of active) row.expiresMs = renewedMs + row.durationSeconds * 1000 - row.catalogueIndex;
    changed = true;
  }
  return changed;
}
function maintainListings() {
  const next = root(), notices = []; let changed = maintainCatalogue(next);
  for (const listing of Object.values(next.listings)) if (!listing.catalogue && listing.state === "active" &&
      (listing.expiresMs <= now() || listing.branded && !market().canBrand(listing.characterID, listing.target))) {
    notices.push({ kind: "license-change", characterID: listing.characterID, hex: listing.hex, previousLicense: state.cloneValue(next.licenses[`${listing.characterID}:${listing.hex}`]) });
    closeListing(next, listing, listing.expiresMs <= now() ? "expired" : "authorization-revoked"); changed = true;
  }
  if (changed) { state.write(TABLE_NAME, next); for (const notice of notices) notifyTransaction(notice); }
}
async function admit(actor, kind, payload, requestID, prepare) {
  if (!state.positive(actor) || !state.requestKey(requestID)) return state.fail("INVALID_MARKET_REQUEST", 400);
  return lock(`admit:${actor}`, async () => {
    const fingerprint = state.fingerprint([kind, payload]), key = `${actor}:${requestID}`;
    const previous = root().requests[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint) return state.fail("SKINR_REQUEST_CONFLICT");
      const op = root().operations[previous.id]; await scheduleOperation(op);
      return { success: true, transactionID: op.id, duplicate: true };
    }
    if (!binding.get()) return state.fail("SKINR_MARKET_SCHEDULER_UNAVAILABLE", 503);
    maintainListings();
    const next = root(), prepared = prepare(next);
    if (!prepared.success) return prepared;
    const id = randomUUID().replaceAll("-", "");
    const op = { id, kind, characterID: actor, state: "pending", createdMs: now(), updatedMs: now(), ...prepared.operation };
    next.operations[id] = op; next.requests[key] = { id, fingerprint };
    state.write(TABLE_NAME, next); await scheduleOperation(op);
    return { success: true, transactionID: id };
  });
}
async function initiateListing(actor, payload, requestID) {
  return admit(actor, "create", payload, requestID, next => {
    const { hex, quantity, currency, price, durationSeconds } = payload;
    const target = market().validateTarget(actor, payload.target);
    if (!target.success) return target;
    const policy = market().getShipSkinMarketPolicy(), branded = market().canBrand(actor, target.target);
    if (!state.positive(quantity, policy.quantity.maximum) || !["ISK", "PLEX"].includes(currency) || !Number.isSafeInteger(price) || price < policy.price.minimumWholeAmount * (currency === "ISK" ? 100 : 1) || price / (currency === "ISK" ? 100 : 1) > policy.price.maximumWholeAmount || !Number.isSafeInteger(price * quantity)) return state.fail("INVALID_LISTING_PRICE_OR_QUANTITY", 400);
    const license = next.licenses[`${actor}:${hex}`];
    if (!license || license.unactivated < quantity || !require("./shipSkinDraftRuntime").getShipSkinDesign(hex)) return state.fail("SKINR_NO_TRANSFERABLE_QUANTITY", 412);
    const limit = require("./shipSkinSkillPolicy").getCharacterShipSkinLimits(actor).maxConcurrentListings;
    if (Object.values(next.listings).filter(row => !row.catalogue && row.characterID === actor && ["active", "creating"].includes(row.state)).length >= limit) return state.fail("SKINR_LISTING_LIMIT", 403);
    const brokerFee = market().getBrokerFee(durationSeconds, branded);
    if (brokerFee === null) return state.fail("INVALID_LISTING_DURATION", 400);
    if (moneyBalance(actor, "ISK") < brokerFee * 100) return state.fail("SKINR_BROKER_FUNDS_INSUFFICIENT", 403);
    const listingID = randomUUID().replaceAll("-", "");
    const licenseBefore = state.cloneValue(license);
    license.unactivated -= quantity; license.escrowed += quantity;
    next.listings[listingID] = { id: listingID, characterID: actor, hex, currency, price, remaining: quantity,
      target: target.target, branded, taxPercent: market().getTaxPercent(actor, branded), createdMs: now(),
      expiresMs: now() + durationSeconds * 1000, state: "creating" };
    return { success: true, operation: { listingID, hex, brokerFee: brokerFee * 100, noticeBefore: [{ characterID: actor, license: licenseBefore }] } };
  });
}
async function initiatePurchase(actor, payload, requestID) {
  return admit(actor, "purchase", payload, requestID, next => {
    const listing = next.listings[payload.listingID], quantity = state.positive(payload.quantity, 0xffffffff);
    if (!listing || listing.state !== "active" || !market().canView(actor, listing)) return state.fail("SKINR_LISTING_NOT_FOUND", 404);
    if (!listing.catalogue && listing.characterID === actor) return state.fail("SKINR_CANNOT_BUY_OWN_LISTING", 423);
    if (!quantity) return state.fail("INVALID_PURCHASE_QUANTITY", 400);
    if (listing.remaining < quantity) return state.fail("SKINR_LISTING_QUANTITY_UNAVAILABLE", 412);
    const policy = market().getShipSkinMarketPolicy();
    if (payload.buyerFeesVersion !== policy.buyerFeesVersion) return state.fail("SKINR_BUYER_FEE_VERSION_CHANGED");
    const design = require("./shipSkinDraftRuntime").getShipSkinDesign(listing.hex);
    const unitBuyerFee = market().getBuyerFee(design?.tier, listing.branded);
    if (unitBuyerFee === null || !Number.isSafeInteger(listing.price * quantity) || !Number.isSafeInteger(unitBuyerFee * quantity)) return state.fail("INVALID_PURCHASE_TOTAL", 400);
    const gross = listing.price * quantity, buyerFee = unitBuyerFee * quantity;
    if (moneyBalance(actor, listing.currency) < gross) return state.fail("SKINR_BUYER_FUNDS_INSUFFICIENT", 403);
    if (require("../corporation/lpWalletState").getCharacterWalletLPBalance(actor, policy.evermarkIssuerCorporationID) < buyerFee) return state.fail("SKINR_EVERMARKS_INSUFFICIENT", 403);
    const tax = Number((BigInt(gross) * BigInt(listing.taxPercent) + (listing.currency === "PLEX" ? 99n : 50n)) / 100n);
    const noticeBefore = [{ characterID: actor, license: state.cloneValue(next.licenses[`${actor}:${listing.hex}`] || null) }];
    if (!listing.catalogue) noticeBefore.push({ characterID: listing.characterID, license: state.cloneValue(next.licenses[`${listing.characterID}:${listing.hex}`]) });
    listing.remaining -= quantity;
    return { success: true, operation: { listingID: listing.id, listingSnapshot: { ...state.cloneValue(listing), remaining: quantity }, sellerID: listing.characterID, noticeBefore,
      hex: listing.hex, catalogue: listing.catalogue === true, quantity, currency: listing.currency, gross, tax, sellerNet: gross - tax, buyerFee,
      issuerCorporationID: policy.evermarkIssuerCorporationID } };
  });
}
function getComponentOffers() {
  const { TABLE, readStaticTable } = require("../_shared/referenceData");
  const authority = require("./shipSkinComponentAuthority"), next = root();
  return (readStaticTable(TABLE.SHIP_SKIN_COMPONENT_LISTING_AUTHORITY).listings || []).flatMap(raw => {
    const id = String(raw.listingID || "").replaceAll("-", "").toLowerCase();
    const mapping = authority.getShipSkinComponentItemByTypeID(Number(raw.componentItemTypeID));
    const currency = String(raw.currency || "PLEX").toUpperCase(), quantity = Number(raw.quantity ?? -1), bundleSize = state.positive(raw.bundleSize || 1, 5000);
    const scaledPrice = Number(raw.price) * (currency === "ISK" ? 100 : 1), price = Math.round(scaledPrice), saleEndMs = Number(raw.saleEndMs || Date.UTC(2100, 0, 1));
    if (!/^[a-f0-9]{32}$/.test(id) || /^0+$/.test(id) || !mapping || !["ISK", "PLEX"].includes(currency) || !Number.isSafeInteger(price) || price < 0 || Math.abs(price - scaledPrice) > Number.EPSILON * Math.max(1, Math.abs(scaledPrice)) * 4 || !bundleSize || !Number.isSafeInteger(quantity) || quantity < -1 || !Number.isSafeInteger(saleEndMs) || saleEndMs <= now() || quantity >= 0 && (next.componentStock[id] || 0) >= quantity) return [];
    return [{ id, componentItemTypeID: Number(raw.componentItemTypeID), componentID: mapping.componentID, licenseType: mapping.licenseType,
      licenseUsesGranted: Math.max(1, mapping.licenseUsesGranted), currency, price, quantity, bundleSize, saleEndMs,
      discountPercent: Math.max(0, Math.min(100, Number(raw.discountPercent) || 0)) }];
  });
}
async function initiateComponentPurchase(actor, payload, requestID) {
  return admit(actor, "component", payload, requestID, next => {
    const offer = getComponentOffers().find(row => row.id === payload.offerID), quantity = state.positive(payload.quantity, 5000);
    if (!offer) return state.fail("SKINR_COMPONENT_OFFER_NOT_FOUND", 404);
    if (!quantity || !Number.isSafeInteger(offer.price * quantity)) return state.fail("INVALID_COMPONENT_PURCHASE_QUANTITY", 400);
    if (offer.quantity >= 0 && (next.componentStock[offer.id] || 0) + quantity > offer.quantity) return state.fail("SKINR_COMPONENT_OFFER_QUANTITY_UNAVAILABLE", 412);
    if (payload.immediatelyActivate && offer.licenseType === "infinite" && (quantity !== 1 || offer.bundleSize !== 1 || require("./shipSkinComponentRuntime").getInfiniteShipSkinComponentLicense(actor, offer.componentID))) return state.fail("INFINITE_LICENSE_ALREADY_OWNED_OR_INVALID_QUANTITY");
    if (payload.immediatelyActivate && offer.licenseType === "infinite" && Object.values(next.operations).some(op => op.kind === "component" &&
      !["completed", "refused"].includes(op.state) && op.characterID === actor && op.immediatelyActivate && op.offer?.licenseType === "infinite" && op.offer.componentID === offer.componentID)) return state.fail("INFINITE_LICENSE_PURCHASE_PENDING");
    const character = require("../character/characterState").getCharacterRecord(actor);
    const deliveryLocationID = Number(character?.stationID || character?.structureID);
    if (!payload.immediatelyActivate && !deliveryLocationID) return state.fail("SKINR_COMPONENT_ITEM_DELIVERY_REQUIRES_DOCK", 403);
    const gross = offer.price * quantity;
    if (moneyBalance(actor, offer.currency) < gross) return state.fail("SKINR_BUYER_FUNDS_INSUFFICIENT", 403);
    next.componentStock[offer.id] = (next.componentStock[offer.id] || 0) + quantity;
    return { success: true, operation: { offerID: offer.id, offer, quantity, currency: offer.currency, gross,
      immediatelyActivate: payload.immediatelyActivate === true, deliveryLocationID,
      grantQuantity: offer.bundleSize * quantity, grantCapacity: offer.bundleSize * quantity * offer.licenseUsesGranted } };
  });
}
function cancelListing(actor, id, requestID) {
  if (!state.requestKey(requestID)) return state.fail("INVALID_MARKET_REQUEST", 400);
  const next = root(), key = `${actor}:${requestID}`, fingerprint = state.fingerprint(["cancel", id]);
  if (next.mutations[key]) return next.mutations[key] === fingerprint ? { success: true, duplicate: true } : state.fail("SKINR_REQUEST_CONFLICT");
  const listing = next.listings[id];
  if (!listing || listing.catalogue || listing.characterID !== actor) return state.fail("SKINR_LISTING_NOT_FOUND", 404);
  if (listing.state === "creating") return state.fail("SKINR_LISTING_NOT_READY");
  closeListing(next, listing, "cancelled"); next.mutations[key] = fingerprint;
  state.write(TABLE_NAME, next); return { success: true };
}
async function money(actor, currency, amount, key) {
  if (!amount) return { success: true };
  const options = { idempotencyKey: key, reason: "SKINR marketplace", requireSufficientFunds: true, requireExactCredit: true };
  // A rejected refund may become payable after wallet capacity changes. Its
  // logical wallet idempotency key still fences successful credits; a fresh
  // transport command lets the owner reconsider a previous refusal.
  const metadata = { ...(key.endsWith(":refund") ? {} : { commandID: key }), source: "skinr-market" };
  return currency === "PLEX"
    ? wallet().adjustCharacterPlexBalanceAsync(actor, amount, { ...options, categoryMessageID: 1021276 }, metadata)
    : wallet().adjustCharacterBalanceAsync(actor, amount / 100, { ...options, entryType: wallet().JOURNAL_ENTRY_TYPE.MARKET_TRANSACTION }, metadata);
}
function definitive(result) { return ["INSUFFICIENT_FUNDS", "WALLET_LIMIT", "CHARACTER_NOT_FOUND"].includes(result?.errorMsg); }
function lpMoney(op, amount, key) {
  return amount ? require("../corporation/lpWalletState").adjustCharacterWalletLPBalanceDurable(op.characterID, op.issuerCorporationID, amount,
    { idempotencyKey: key, requireSufficientFunds: true }) : { success: true };
}
function collectFee(next, currency, amount) { next.fees[currency] = (BigInt(next.fees[currency] || "0") + BigInt(amount)).toString(); }
async function abortOperation(op, errorMsg) {
  op = updateOperation(op.id, { state: "aborting", errorMsg });
  if (op.paid) state.check(await money(op.characterID, op.kind === "create" ? "ISK" : op.currency,
    op.kind === "create" ? op.brokerFee : op.gross, `skinr:${op.id}:refund`));
  if (op.lpPaid) state.check(lpMoney(op, op.buyerFee, `skinr:${op.id}:lp-refund`));
  const next = root(), listing = next.listings[op.listingID];
  if (op.kind === "create") {
    listing.state = "active"; closeListing(next, listing, "refused");
  } else if (op.kind === "purchase") {
    if (op.catalogue) { listing.remaining += op.quantity; listing.state = "active"; }
    else if (listing.state === "active" && listing.expiresMs > now() && (!listing.branded || market().canBrand(listing.characterID, listing.target))) listing.remaining += op.quantity;
    else { const license = ownedLicense(next, op.sellerID, op.hex); license.escrowed -= op.quantity; license.unactivated += op.quantity; }
  } else if (op.kind === "component") next.componentStock[op.offerID] -= op.quantity;
  Object.assign(next.operations[op.id], { state: "refused", updatedMs: now() });
  state.write(TABLE_NAME, next); notifyTransaction(next.operations[op.id]);
  return { success: true, refused: true };
}
async function settleOperation(id) {
  return lock(id, async () => {
    let op = root().operations[id];
    if (!op || ["completed", "refused"].includes(op.state)) return { success: true, duplicate: true };
    if (op.state === "aborting") return abortOperation(op, op.errorMsg);
    if (!op.paid) {
      const result = await money(op.characterID, op.kind === "create" ? "ISK" : op.currency,
        -(op.kind === "create" ? op.brokerFee : op.gross), `skinr:${id}:debit`);
      if (!result.success) { if (definitive(result)) return abortOperation(op, result.errorMsg); throw new Error(result.errorMsg || "SKINR_MARKET_DEBIT_PENDING"); }
      op = updateOperation(id, { paid: true });
    }
    if (op.kind === "create") {
      const next = root(), listing = next.listings[op.listingID];
      if (listing.expiresMs <= now() || listing.branded && !market().canBrand(listing.characterID, listing.target)) return abortOperation(op, "SKINR_LISTING_NO_LONGER_VALID");
      listing.state = "active"; collectFee(next, "ISK", op.brokerFee);
      Object.assign(next.operations[id], { state: "completed", updatedMs: now() });
      state.write(TABLE_NAME, next); await scheduleListing(listing); notifyTransaction(next.operations[id]); return { success: true };
    }
    if (op.kind === "purchase") {
      if (!op.lpPaid) {
        const result = lpMoney(op, -op.buyerFee, `skinr:${id}:lp-debit`);
        if (!result.success) { if (definitive(result)) return abortOperation(op, result.errorMsg); throw new Error(result.errorMsg || "SKINR_MARKET_LP_PENDING"); }
        op = updateOperation(id, { lpPaid: true });
      }
      if (!op.catalogue && !op.sellerPaid) {
        const result = await money(op.sellerID, op.currency, op.sellerNet, `skinr:${id}:credit`);
        if (!result.success) { if (definitive(result)) return abortOperation(op, result.errorMsg); throw new Error(result.errorMsg || "SKINR_MARKET_CREDIT_PENDING"); }
        op = updateOperation(id, { sellerPaid: true });
      }
      const next = root(), seller = op.catalogue ? null : ownedLicense(next, op.sellerID, op.hex), buyer = ownedLicense(next, op.characterID, op.hex);
      next.operations[id].noticeBefore = [{ characterID: op.characterID, license: state.cloneValue(buyer) }];
      if (seller) next.operations[id].noticeBefore.push({ characterID: op.sellerID, license: state.cloneValue(seller) });
      if (seller && seller.escrowed < op.quantity || !Number.isSafeInteger(buyer.unactivated + op.quantity)) throw new Error("SKINR_PURCHASE_CUSTODY_INVARIANT");
      if (seller) seller.escrowed -= op.quantity;
      buyer.unactivated += op.quantity; collectFee(next, op.currency, op.catalogue ? op.gross : op.tax); collectFee(next, "EVERMARKS", op.buyerFee);
      Object.assign(next.operations[id], { state: "completed", updatedMs: now() });
      const listing = next.listings[op.listingID];
      if (!listing.remaining && !Object.values(next.operations).some(other => other.listingID === listing.id && !["completed", "refused"].includes(other.state))) listing.state = "filled";
      state.write(TABLE_NAME, next); notifyTransaction(next.operations[id]); return { success: true };
    }
    if (op.kind === "component") {
      let granted;
      if (op.immediatelyActivate) granted = require("./shipSkinComponentRuntime").grantShipSkinComponentLicenseOnce(op.characterID, op.offer.componentID, op.offer.licenseType, op.grantCapacity, `skinr:${id}:component-output`);
      else {
        const custody = require("../inventory/itemCustody");
        granted = custody.transfer({ items: { typeID: op.offer.componentItemTypeID, quantity: op.grantQuantity },
          from: null, to: custody.custodyRef.ownerLocation(op.characterID, op.deliveryLocationID, 4), actor: op.characterID,
          reason: custody.CUSTODY_REASON.SKIN_COMPONENT_STORE_GRANT, idempotencyKey: `skinr:${id}:component-item-output` });
        if (granted.success && !granted.duplicate) require("../raffles/raffleInventory").notifyInventoryChangesToCharacter(op.characterID, granted.data?.changes || []);
      }
      if (!granted.success) {
        if (granted.ambiguous) throw new Error(granted.errorMsg);
        return abortOperation(op, granted.errorMsg);
      }
      const next = root(); collectFee(next, op.currency, op.gross);
      Object.assign(next.operations[id], { state: "completed", updatedMs: now() });
      state.write(TABLE_NAME, next); notifyTransaction(next.operations[id]); return { success: true };
    }
    throw new Error("SKINR_MARKET_OPERATION_UNKNOWN");
  });
}
async function reconcileMarket() {
  maintainListings(); const next = root();
  for (const listing of Object.values(next.listings)) await scheduleListing(listing);
  const active = Object.values(next.listings).filter(row => row.catalogue && row.state === "active");
  if (active.length && binding.get()) await binding.get().schedule({ jobID: "skinr:catalogue:renew", type: JOB_TYPE,
    dueAtMs: Math.min(...active.map(row => row.expiresMs)) - catalogue.getShipSkinStoreRenewBeforeMs(), payload: { catalogue: true } });
  for (const op of Object.values(next.operations)) await scheduleOperation(op);
}
module.exports = { TABLE_NAME, JOB_TYPE, grantShipSkinLicense, getOwnedShipSkinLicenses, getShipSkinLicense,
  activateShipSkinLicense, applyShipSkinLicense, getAppliedShipSkin,
  unapplyShipSkinLicense: (actor, hex, ship, key) => applyShipSkinLicense(actor, hex, ship, key, true),
  initiateListing, initiatePurchase, initiateComponentPurchase, getComponentOffers, cancelListing, settleOperation, reconcile: reconcileMarket,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind,
  setNowProvider: provider => { nowProvider = provider; },
  setMarketNoticeSink: sink => { const previous = marketNoticeSink; marketNoticeSink = sink; return previous; },
  getTransaction, getOwnedTransactions: actor => Object.values(root().operations).filter(op => op.characterID === actor),
  getListings: actor => { maintainListings(); return Object.values(root().listings).filter(listing => listing.state === "active" && listing.remaining > 0 && market().canView(actor, listing)); },
  getOwnedListings: actor => { maintainListings(); return Object.values(root().listings).filter(listing => !listing.catalogue && listing.characterID === actor && listing.state === "active" && listing.remaining > 0); },
  getListing: (actor, id) => { maintainListings(); const listing = root().listings[id]; return listing && market().canView(actor, listing) ? listing : null; },
  handleJob: job => job.payload.operationID ? settleOperation(job.payload.operationID) : job.payload.catalogue ? reconcileMarket() : (maintainListings(), { success: true }),
  getMarketAudit: root };
