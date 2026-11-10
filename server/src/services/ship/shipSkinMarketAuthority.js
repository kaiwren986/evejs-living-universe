"use strict";
const { TABLE, readStaticTable } = require("../_shared/referenceData");
const { cloneValue, positive, fail } = require("./shipSkinState");
const { getCharacterRecord } = require("../character/characterState");
const { getCorporationRecord, getAllianceRecord } = require("../corporation/corporationState");
const { canCharacterEditCorporationColorPalette } = require("../corporation/corpColorsState");
const { getCharacterShipSkinLimits } = require("./shipSkinSkillPolicy");
function getShipSkinMarketPolicy() {
  const policy = readStaticTable(TABLE.SHIP_SKIN_MARKET_AUTHORITY);
  if (!policy.listingDurations?.length || !policy.buyerFeesVersion || !policy.buyerFeesByTier?.length) throw new Error("SKINR_MARKET_AUTHORITY_MISSING");
  return cloneValue(policy);
}
function normalizeTarget(raw) {
  if (!raw) return { kind: "public" };
  const names = ["public", "character", "corporation", "alliance"].filter(name => Object.hasOwn(raw, name));
  if (names.length !== 1) return null;
  const kind = names[0];
  if (kind === "public") return raw.public === true ? { kind } : null;
  const id = positive(raw[kind]?.sequential);
  return id ? { kind, id } : null;
}
function isBranded(target) { return ["corporation", "alliance"].includes(target?.kind); }
function canBrand(actor, target) {
  const character = getCharacterRecord(actor), corporationID = Number(character?.corporationID);
  if (!isBranded(target) || !corporationID || !canCharacterEditCorporationColorPalette(actor, corporationID)) return false;
  return target.kind === "corporation" ? corporationID === target.id : Number(getCorporationRecord(corporationID)?.allianceID) === target.id;
}
function canView(actor, listing) {
  const target = listing.target;
  if (actor === listing.characterID || target.kind === "public") return true;
  if (target.kind === "character") return target.id === actor;
  const character = getCharacterRecord(actor), corporationID = Number(character?.corporationID);
  return target.kind === "corporation" ? corporationID === target.id : Number(getCorporationRecord(corporationID)?.allianceID) === target.id;
}
function validateTarget(actor, raw) {
  const target = normalizeTarget(raw);
  if (!target || target.kind === "character" && !getCharacterRecord(target.id)) return fail("INVALID_LISTING_TARGET", 400);
  if (target.kind === "corporation" && !getCorporationRecord(target.id) || target.kind === "alliance" && !getAllianceRecord(target.id)) return fail("INVALID_LISTING_TARGET", 400);
  return { success: true, target };
}
function getBrokerFee(seconds, branded = false) {
  const duration = getShipSkinMarketPolicy().listingDurations.find(row => row.seconds === seconds);
  return duration ? branded ? 0 : duration.brokerFeeIsk : null;
}
function getTaxPercent(actor, branded = false) {
  if (branded) return 0;
  const policy = getShipSkinMarketPolicy();
  return Math.max(policy.minimumTaxPercent, policy.baseTaxPercent - getCharacterShipSkinLimits(actor).taxReductionPercent);
}
function getBuyerFee(tier, branded = false) {
  const row = getShipSkinMarketPolicy().buyerFeesByTier.find(row => row.tier === tier);
  return row ? branded ? row.brandedEvermarks : row.defaultEvermarks : null;
}
module.exports = { getShipSkinMarketPolicy, normalizeTarget, validateTarget, canBrand, canView, isBranded, getBrokerFee, getTaxPercent, getBuyerFee };
