"use strict";

const { TABLE, readStaticTable } = require("../_shared/referenceData");
const { resolveFixtureIdentity, FIXTURE_ROLE } = require("../_shared/fixtureIdentities");
const { cloneValue } = require("../../common/clone");
const { createHash } = require("node:crypto");
function authority() { return readStaticTable(TABLE.SHIP_SKIN_STORE_AUTHORITY); }
function getShipSkinStoreRevision() { return authority().source?.donorSha256 || null; }
function getShipSkinStoreSellerID() { return resolveFixtureIdentity(FIXTURE_ROLE.GM).characterID; }
function getShipSkinStoreDesign(hex) {
  const row = authority().designsByHex?.[hex];
  return row ? { ...cloneValue(row), version: 1, characterID: getShipSkinStoreSellerID() } : null;
}
function listShipSkinStoreSeedSpecs() {
  const table = authority();
  return (table.catalogueOrder || []).map((hex, index) => ({ hex, index, ...cloneValue(table.designsByHex[hex].seed) }));
}
function getShipSkinStoreRenewBeforeMs() { return Number(authority().policy?.renewBeforeSeconds || 86400) * 1000; }
function getShipSkinStoreListingID(hex) { return createHash("sha256").update(`skinr:catalogue:v1:${hex}`).digest("hex").slice(0, 32); }
module.exports = { getShipSkinStoreRevision, getShipSkinStoreSellerID, getShipSkinStoreDesign, listShipSkinStoreSeedSpecs, getShipSkinStoreListingID, getShipSkinStoreRenewBeforeMs };
