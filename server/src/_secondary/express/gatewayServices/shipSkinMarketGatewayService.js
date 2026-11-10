"use strict";
const { createSkinGatewayService } = require("./shipSkinGatewayHelpers");
const { getShipSkinProtoRoot } = require("./shipSkinGatewayProto");
const { encodePayload, timestampFromMs } = require("./gatewayServiceHelpers");
const { licenseAttributes } = require("./shipSkinThirdPartyGatewayService");
const runtime = require("../../../services/ship/shipSkinThirdPartyRuntime");
const authority = require("../../../services/ship/shipSkinMarketAuthority");
const components = require("../../../services/ship/shipSkinComponentAuthority");
const drafts = require("../../../services/ship/shipSkinDraftRuntime");
const state = require("../../../services/ship/shipSkinState");
const { getCharacterRecord } = require("../../../services/character/characterState");
const { getCorporationRecord } = require("../../../services/corporation/corporationState");
const PREFIX = "eve_public.cosmetic.market.";
function createShipSkinMarketGatewayService(context = {}) {
  const handlers = {}, root = getShipSkinProtoRoot(), centsPerPlex = context.plexGatewayCentsPerPlex || 100;
  const id = hex => ({ uuid: Buffer.from(hex, "hex") });
  const isk = amount => ({ units: Math.trunc(amount / 100), nanos: (amount % 100) * 10000000 });
  const price = (currency, amount) => currency === "ISK" ? { isk: isk(amount) } : { plex: { total_in_cents: (BigInt(amount) * BigInt(centsPerPlex)).toString() } };
  const target = value => value.kind === "public" ? { public: true } : { [value.kind]: { sequential: value.id } };
  const lpFee = amount => ({ loyalty_points: { amount, associated_corporation: { sequential: authority.getShipSkinMarketPolicy().evermarkIssuerCorporationID } } });
  function listingEntry(listing) {
    return { id: id(listing.id), attributes: { seller: { sequential: listing.characterID }, created: timestampFromMs(listing.createdMs),
      expires: timestampFromMs(listing.expiresMs), ...price(listing.currency, listing.price),
      skin: { character: { sequential: listing.characterID }, skin: { hex: listing.hex } }, quantity: listing.remaining,
      target: target(listing.target), branded: listing.branded } };
  }
  function componentEntry(offer) { return { id: id(offer.id), attributes: { sale_end: timestampFromMs(offer.saleEndMs), ...price(offer.currency, offer.price),
    component_item: { sequential: offer.componentItemTypeID }, bundle_size: offer.bundleSize, discount_percent: offer.discountPercent } }; }
  function transactionAttributes(op) {
    const listing = op.listingSnapshot || runtime.getListing(op.characterID, op.listingID);
    const details = op.kind === "create" ? { creating_skin_listing: { character: { sequential: op.characterID }, skin: { hex: op.hex } } }
      : op.kind === "purchase" ? { purchasing_skin: listingEntry(listing) } : { purchasing_component: componentEntry(op.offer) };
    return { last_updated: timestampFromMs(op.updatedMs), status: op.state === "completed" ? 3 : op.state === "refused" ? 2 : 1, details };
  }
  function publishLicense(actor, hex, before = null) {
    const row = runtime.getShipSkinLicense(actor, hex);
    if (!row) return;
    const type = "eve_public.cosmetic.ship.skin.thirdparty.license.api.UpdatedNotice";
    const current = licenseAttributes(row);
    context.publishGatewayNotice?.(type, encodePayload(root.lookupType(type), { id: { character: { sequential: actor }, skin: { hex } }, attributes: current,
      previous_attributes: before ? licenseAttributes(before) : { ...current, activated: false, unactivated: 0, escrowed: 0 } }), { character: actor });
  }
  runtime.setMarketNoticeSink(op => {
    if (op.kind === "license-change") { publishLicense(op.characterID, op.hex, op.previousLicense); return; }
    const type = `${PREFIX}transaction.api.Transaction${op.state === "completed" ? "Succeeded" : "Failed"}Notice`;
    context.publishGatewayNotice?.(type, encodePayload(root.lookupType(type), { transaction: id(op.id) }), { character: op.characterID });
    for (const previous of op.noticeBefore || []) publishLicense(previous.characterID, op.hex, previous.license);
    if (op.kind === "component" && op.immediatelyActivate && op.state === "completed") {
      const type = "eve_public.cosmetic.ship.skin.thirdparty.component.license.api.GrantedNotice";
      context.publishGatewayNotice?.(type, encodePayload(root.lookupType(type), { kind: { component: components.buildComponentIdentifier(op.offer.componentID),
        ...(op.offer.licenseType === "infinite" ? { infinite: true } : { finite: op.grantCapacity }) } }), { character: op.characterID });
    }
  });
  function quoteTarget(request) { return authority.normalizeTarget(request.target) || null; }
  handlers[`${PREFIX}api.GetBrokerFeesRequest`] = (request, { characterID }) => {
    const selected = quoteTarget(request);
    if (!selected) return state.fail("INVALID_LISTING_TARGET", 400);
    const branded = authority.canBrand(characterID, selected);
    const rows = authority.getShipSkinMarketPolicy().listingDurations.map(row => ({ duration: { seconds: row.seconds }, broker_fee: { fee: isk((branded ? 0 : row.brokerFeeIsk) * 100) } }));
    return { payload: { broker_fees_per_duration: rows, broker_fees: rows.map(row => ({ ...row.broker_fee, duration: row.duration })) } };
  };
  handlers[`${PREFIX}api.GetTaxRateRequest`] = (request, { characterID }) => {
    const selected = quoteTarget(request);
    if (!selected) return state.fail("INVALID_LISTING_TARGET", 400);
    const rate = authority.getTaxPercent(characterID, authority.canBrand(characterID, selected)) / 100;
    return { payload: { tax_rate: { units: Math.trunc(rate), nanos: Math.round((rate % 1) * 1e9) } } };
  };
  handlers[`${PREFIX}api.GetBuyerFeeRequest`] = (request, { characterID }) => {
    const design = drafts.getShipSkinDesign(request.skin?.hex), selected = quoteTarget(request);
    if (!design) return state.fail("SKIN_DESIGN_NOT_FOUND", 404);
    if (!selected) return state.fail("INVALID_LISTING_TARGET", 400);
    return { payload: { buyer_fee: lpFee(authority.getBuyerFee(design.tier, authority.canBrand(characterID, selected))) } };
  };
  handlers[`${PREFIX}api.GetBuyerFeesDefinitionRequest`] = () => ({ payload: {
    buyer_fees_version: authority.getShipSkinMarketPolicy().buyerFeesVersion,
    buyer_fees: authority.getShipSkinMarketPolicy().buyerFeesByTier.map(row => ({ skin_tier: { level: row.tier }, default_fee: lpFee(row.defaultEvermarks), branded_fee: lpFee(row.brandedEvermarks) })),
  } });
  handlers[`${PREFIX}skin.listing.api.InitiateCreateListingRequest`] = async (request, { characterID, requestID }) => {
    if (Number(request.skin?.character?.sequential) !== characterID) return state.fail("SKINR_LICENSE_NOT_OWNED", 403);
    const currencies = ["price_isk", "price_plex"].filter(name => Object.hasOwn(request, name));
    if (currencies.length !== 1 || Number(request.duration?.nanos || 0)) return state.fail("INVALID_LISTING_PRICE_OR_DURATION", 400);
    const currency = currencies[0] === "price_isk" ? "ISK" : "PLEX";
    const units = Number(request.price_isk?.units || 0), nanos = Number(request.price_isk?.nanos || 0);
    if (currency === "ISK" && (!Number.isSafeInteger(units) || units < 0 || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1000000000 || nanos % 10000000)) return state.fail("INVALID_ISK_PRECISION", 400);
    const plexCents = currency === "PLEX" ? BigInt(request.price_plex.total_in_cents.toString()) : 0n;
    if (plexCents < 0n || plexCents % BigInt(centsPerPlex) || plexCents / BigInt(centsPerPlex) > BigInt(Number.MAX_SAFE_INTEGER)) return state.fail("INVALID_PLEX_PRECISION", 400);
    const amount = currency === "PLEX" ? Number(plexCents / BigInt(centsPerPlex)) : units * 100 + nanos / 10000000;
    const result = await runtime.initiateListing(characterID, { hex: request.skin?.skin?.hex, quantity: Number(request.quantity),
      currency, price: amount, durationSeconds: Number(request.duration?.seconds), target: request.target }, requestID);
    return result.success ? { payload: { transaction: id(result.transactionID) } } : result;
  };
  handlers[`${PREFIX}skin.listing.api.InitiatePurchaseListingRequest`] = async (request, { characterID, requestID }) => {
    const result = await runtime.initiatePurchase(characterID, { listingID: drafts.uuid(request.listing?.uuid), quantity: Number(request.quantity), buyerFeesVersion: request.buyer_fees_version }, requestID);
    return result.success ? { payload: { transaction: id(result.transactionID) } } : result;
  };
  handlers[`${PREFIX}skin.listing.api.CancelListingRequest`] = (request, { characterID, requestID }) => {
    const listingID = drafts.uuid(request.listing?.uuid), listing = runtime.getListing(characterID, listingID);
    const before = listing && runtime.getShipSkinLicense(characterID, listing.hex);
    const result = runtime.cancelListing(characterID, listingID, requestID);
    if (result.success && !result.duplicate && listing) publishLicense(characterID, listing.hex, before);
    return result;
  };
  handlers[`${PREFIX}skin.listing.api.GetAllOwnedRequest`] = (_request, { characterID }) => ({ payload: { listings: runtime.getOwnedListings(characterID).map(listingEntry) } });
  handlers[`${PREFIX}skin.listing.api.GetRequest`] = (request, { characterID }) => {
    const listing = runtime.getListing(characterID, drafts.uuid(request.listing?.uuid));
    return listing ? { payload: { listing: listingEntry(listing) } } : state.fail("SKINR_LISTING_NOT_FOUND", 404);
  };
  handlers[`${PREFIX}skin.listing.api.GetAllRequest`] = (request, { characterID }) => {
    const pageSize = Number(request.page?.size || 12), order = Number(request.order?.field || 1), ascending = request.order?.ascending === true;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || order !== 1) return state.fail("INVALID_MARKET_PAGE_OR_ORDER", 400);
    const shipTypes = (request.filter?.ship_type_filter?.ship_types || []).map(row => Number(row.sequential));
    if (shipTypes.some(type => !state.positive(type))) return state.fail("INVALID_SHIP_TYPE_FILTER", 400);
    const selected = request.listing_target || { public: {} }, kinds = ["public", "my_corporation", "my_alliance", "my_character", "all"].filter(name => Object.hasOwn(selected, name));
    if (kinds.length !== 1) return state.fail("INVALID_LISTING_TARGET_FILTER", 400);
    const kind = kinds[0], memberFilter = Number(selected[kind]?.required_membership || 0);
    if (!Number.isInteger(memberFilter) || memberFilter < 0 || memberFilter > 3) return state.fail("INVALID_SELLER_MEMBERSHIP_FILTER", 400);
    const corporationID = Number(getCharacterRecord(characterID)?.corporationID), allianceID = Number(getCorporationRecord(corporationID)?.allianceID);
    let listings = runtime.getListings(characterID).filter(listing => {
      if (shipTypes.length && !shipTypes.includes(Number(drafts.getShipSkinDesign(listing.hex)?.layout.ship_type.sequential))) return false;
      if (kind === "all") return true;
      if (kind === "public") return listing.target.kind === "public";
      if (kind === "my_character") return listing.target.kind === "character" && listing.target.id === characterID;
      const corporate = kind === "my_corporation";
      if (listing.target.kind !== (corporate ? "corporation" : "alliance") || listing.target.id !== (corporate ? corporationID : allianceID)) return false;
      const sellerCorp = Number(getCharacterRecord(listing.characterID)?.corporationID);
      const belongs = corporate ? sellerCorp === corporationID : Number(getCorporationRecord(sellerCorp)?.allianceID) === allianceID;
      return memberFilter === 1 ? listing.branded : memberFilter === 2 ? belongs : memberFilter === 3 ? !belongs : true;
    });
    const direction = ascending ? 1 : -1;
    const compare = (a, b) => direction * (a.expiresMs - b.expiresMs || a.id.localeCompare(b.id));
    listings.sort(compare);
    const query = state.fingerprint([characterID, [...new Set(shipTypes)].sort((a, b) => a - b), kind, memberFilter, ascending]);
    if (request.page?.token) {
      let cursor;
      try { if (request.page.token.length > 400) throw new Error(); cursor = JSON.parse(Buffer.from(request.page.token, "base64url")); } catch (_error) { return state.fail("INVALID_MARKET_PAGE_TOKEN", 400); }
      if (cursor.query !== query || !Number.isSafeInteger(cursor.expiresMs) || !/^[a-f0-9]{32}$/.test(cursor.id || "")) return state.fail("INVALID_MARKET_PAGE_TOKEN", 400);
      listings = listings.filter(listing => compare(listing, cursor) > 0);
    }
    const page = listings.slice(0, pageSize), last = page.at(-1);
    return { payload: { listings: page.map(listingEntry), ...(listings.length > pageSize ? { next_page: { token: Buffer.from(JSON.stringify({ query, expiresMs: last.expiresMs, id: last.id })).toString("base64url") } } : {}) } };
  };
  handlers[`${PREFIX}transaction.api.GetAllRequest`] = (_request, { characterID }) => ({ payload: { transactions: runtime.getOwnedTransactions(characterID).map(op => id(op.id)) } });
  handlers[`${PREFIX}transaction.api.GetRequest`] = (request, { characterID }) => {
    const op = runtime.getTransaction(characterID, drafts.uuid(request.transaction?.uuid));
    return op ? { payload: { status: transactionAttributes(op) } } : state.fail("SKINR_TRANSACTION_NOT_FOUND", 404);
  };
  handlers[`${PREFIX}component.listing.api.GetAllRequest`] = () => ({ payload: { listings: runtime.getComponentOffers().map(componentEntry) } });
  handlers[`${PREFIX}component.listing.api.InitiatePurchaseListingRequest`] = async (request, { characterID, requestID }) => {
    const result = await runtime.initiateComponentPurchase(characterID, { offerID: drafts.uuid(request.listing?.uuid), quantity: Number(request.quantity), immediatelyActivate: request.immediately_activate === true }, requestID);
    return result.success ? { payload: { transaction: id(result.transactionID), immediately_activate: request.immediately_activate === true } } : result;
  };
  return createSkinGatewayService("ship-skin-market", handlers);
}
module.exports = { createShipSkinMarketGatewayService };
