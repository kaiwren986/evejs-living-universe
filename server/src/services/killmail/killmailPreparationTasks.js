"use strict";

// Pure killmail enrichment shared by the synchronous compatibility path and
// the post-combat worker. Everything needed from mutable server state is
// supplied in `options`, so worker execution never reaches into a live scene
// or a service-owned table.

const path = require("node:path");
const { performance } = require("node:perf_hooks");

const {
  toPublicSolarSystemID,
} = require("../../abyssal").engineSupport.hostLocation;

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.trunc(numericValue) : fallback;
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = normalizeInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeNullableNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return typeof value === "string" ? value : String(value);
}

function currentFiletimeString() {
  return (
    BigInt(Date.now()) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET
  ).toString();
}

function normalizeFiletimeString(value, fallback = null) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return fallback || currentFiletimeString();
}

function escapeXmlAttribute(value) {
  return normalizeText(value, "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatSecurityStatusText(value) {
  const numericValue = normalizeNullableNumber(value, null);
  if (numericValue === null) {
    return "0.0";
  }
  return (Math.round(numericValue * 10) / 10).toFixed(1);
}

function buildBlobAttackerEntry(attacker = {}) {
  const attributes = [
    ["c", normalizePositiveInteger(attacker.characterID, null)],
    ["r", normalizePositiveInteger(attacker.corporationID, null)],
    ["a", normalizePositiveInteger(attacker.allianceID, null)],
    ["f", normalizePositiveInteger(attacker.factionID, null)],
    ["s", normalizePositiveInteger(attacker.shipTypeID, null)],
    ["w", normalizePositiveInteger(attacker.weaponTypeID, null)],
    ["d", Math.max(0, normalizeInteger(attacker.damageDone, 0))],
    ["t", formatSecurityStatusText(attacker.securityStatus)],
  ]
    .filter(([, attributeValue]) =>
      attributeValue !== null && attributeValue !== undefined)
    .map(([name, attributeValue]) =>
      ` ${name}="${escapeXmlAttribute(attributeValue)}"`)
    .join("");
  return `<a${attributes} />`;
}

function buildBlobItemEntry(item = {}, depth = 0) {
  const attributes = [
    ["t", normalizePositiveInteger(item.typeID, null)],
    ["f", normalizeInteger(item.flag, 0)],
    ["s", normalizeInteger(item.singleton, 0)],
    ["d", Math.max(0, normalizeInteger(item.qtyDropped, 0))],
    ["x", Math.max(0, normalizeInteger(item.qtyDestroyed, 0))],
  ]
    .filter(([, attributeValue]) =>
      attributeValue !== null && attributeValue !== undefined)
    .map(([name, attributeValue]) =>
      ` ${name}="${escapeXmlAttribute(attributeValue)}"`)
    .join("");
  const contents =
    depth === 0 && Array.isArray(item.contents)
      ? item.contents
          .map((contentItem) => buildBlobItemEntry(contentItem, depth + 1))
          .join("")
      : "";
  return `<i${attributes}>${contents}</i>`;
}

function buildKillBlob({ attackers = [], items = [] } = {}) {
  const attackerSection = `<attackers>${attackers
    .map((attacker) => buildBlobAttackerEntry(attacker))
    .join("")}</attackers>`;
  const itemSection = `<items>${items
    .map((item) => buildBlobItemEntry(item))
    .join("")}</items>`;
  return `${attackerSection}${itemSection}`;
}

function normalizeAttackerEntry(entry = {}) {
  return {
    characterID: normalizePositiveInteger(entry.characterID, null),
    corporationID: normalizePositiveInteger(entry.corporationID, null),
    allianceID: normalizePositiveInteger(entry.allianceID, null),
    factionID: normalizePositiveInteger(entry.factionID, null),
    shipTypeID: normalizePositiveInteger(entry.shipTypeID, null),
    weaponTypeID: normalizePositiveInteger(entry.weaponTypeID, null),
    damageDone: Math.max(0, normalizeNumber(entry.damageDone, 0)),
    securityStatus: normalizeNullableNumber(entry.securityStatus, null),
  };
}

function normalizeItemEntry(entry = {}, depth = 0) {
  return {
    typeID: normalizePositiveInteger(entry.typeID, null),
    flag: normalizeInteger(entry.flag, 0),
    singleton: normalizeInteger(entry.singleton, 0),
    qtyDropped: Math.max(0, normalizeInteger(entry.qtyDropped, 0)),
    qtyDestroyed: Math.max(0, normalizeInteger(entry.qtyDestroyed, 0)),
    contents:
      depth < 1 && Array.isArray(entry.contents)
        ? entry.contents.map((contentEntry) =>
            normalizeItemEntry(contentEntry, depth + 1))
        : [],
  };
}

function getBasePrice(typeID, basePrices = {}) {
  const price = basePrices[String(normalizePositiveInteger(typeID, 0) || 0)];
  return Math.max(0, normalizeNumber(price, 0));
}

function sumKillmailItemValue(items = [], valueSelector = "all", basePrices = {}) {
  return items.reduce((sum, item) => {
    const qtyDropped = Math.max(0, normalizeInteger(item && item.qtyDropped, 0));
    const qtyDestroyed = Math.max(
      0,
      normalizeInteger(item && item.qtyDestroyed, 0),
    );
    const quantity =
      valueSelector === "destroyed"
        ? qtyDestroyed
        : valueSelector === "dropped"
          ? qtyDropped
          : qtyDropped + qtyDestroyed;
    return (
      sum +
      getBasePrice(item && item.typeID, basePrices) * quantity +
      sumKillmailItemValue(
        Array.isArray(item && item.contents) ? item.contents : [],
        valueSelector,
        basePrices,
      )
    );
  }, 0);
}

function uniquePositiveIntegers(values = []) {
  return [...new Set(values
    .map((value) => normalizePositiveInteger(value, null))
    .filter(Boolean))];
}

// ⚠ A CORPORATION / ALLIANCE KILL LOG IS CAPSULEER AND STRUCTURE KILLS ONLY.
//
// This server writes a killmail for NPC and drone victims too, so filing every
// record under each attacker's corporation filled the corp kill log with rats
// shot on a mission, which TQ never shows there. A kill only reaches an owner
// kill log when the victim was a capsuleer, or an asset owned by a player
// corporation (a structure has no victimCharacterID but does carry its owner
// corporation). NPC corporation IDs live in [1000000, 2000000) and faction and
// other NPC owner IDs sit below that, so a player-corporation victim is the one
// case that survives when there is no victim character.
const PLAYER_OWNER_MIN_ID = 2000000;

function isOwnerKillLogVictim(record) {
  if (normalizePositiveInteger(record && record.victimCharacterID, null)) {
    return true;
  }
  const victimCorporationID =
    normalizePositiveInteger(record && record.victimCorporationID, 0) || 0;
  return victimCorporationID >= PLAYER_OWNER_MIN_ID;
}

function buildKillmailProjection(record) {
  const attackers = Array.isArray(record && record.attackers)
    ? record.attackers
    : [];
  return {
    finalCharacterID: normalizePositiveInteger(record && record.finalCharacterID, null),
    victimCharacterID: normalizePositiveInteger(record && record.victimCharacterID, null),
    victimCorporationID: normalizePositiveInteger(record && record.victimCorporationID, null),
    victimAllianceID: normalizePositiveInteger(record && record.victimAllianceID, null),
    warID: normalizePositiveInteger(record && record.warID, null),
    entersOwnerKillLog: isOwnerKillLogVictim(record),
    attackerCorporationIDs: uniquePositiveIntegers([
      record && record.finalCorporationID,
      ...attackers.map((attacker) => attacker && attacker.corporationID),
    ]),
    attackerAllianceIDs: uniquePositiveIntegers([
      record && record.finalAllianceID,
      ...attackers.map((attacker) => attacker && attacker.allianceID),
    ]),
  };
}

function prepareKillmailRecord(record = {}, options = {}) {
  const startedAtMs = performance.now();
  const killID = normalizePositiveInteger(options.killID ?? record.killID, null);
  if (!killID) {
    throw new Error("prepareKillmailRecord requires a positive killID");
  }
  const basePrices = options.basePrices && typeof options.basePrices === "object"
    ? options.basePrices
    : {};
  const normalizedAttackers = Array.isArray(record.attackers)
    ? record.attackers.map((entry) => normalizeAttackerEntry(entry))
    : [];
  const normalizedItems = Array.isArray(record.items)
    ? record.items.map((entry) => normalizeItemEntry(entry))
    : [];
  const normalizedRecord = {
    killID,
    killTime: normalizeFiletimeString(record.killTime, options.fallbackKillTime),
    solarSystemID: toPublicSolarSystemID(record.solarSystemID, null),
    moonID: normalizePositiveInteger(record.moonID, null),
    victimCharacterID: normalizePositiveInteger(record.victimCharacterID, null),
    victimCorporationID: normalizePositiveInteger(record.victimCorporationID, null),
    victimAllianceID: normalizePositiveInteger(record.victimAllianceID, null),
    victimFactionID: normalizePositiveInteger(record.victimFactionID, null),
    victimShipTypeID: normalizePositiveInteger(record.victimShipTypeID, null),
    victimDamageTaken: Math.max(0, normalizeNumber(record.victimDamageTaken, 0)),
    finalCharacterID: normalizePositiveInteger(record.finalCharacterID, null),
    finalCorporationID: normalizePositiveInteger(record.finalCorporationID, null),
    finalAllianceID: normalizePositiveInteger(record.finalAllianceID, null),
    finalFactionID: normalizePositiveInteger(record.finalFactionID, null),
    finalShipTypeID: normalizePositiveInteger(record.finalShipTypeID, null),
    finalWeaponTypeID: normalizePositiveInteger(record.finalWeaponTypeID, null),
    finalSecurityStatus: normalizeNullableNumber(record.finalSecurityStatus, null),
    finalDamageDone: Math.max(0, normalizeNumber(record.finalDamageDone, 0)),
    warID: normalizePositiveInteger(record.warID, null),
    iskLost: normalizeNumber(
      record.iskLost,
      getBasePrice(record.victimShipTypeID, basePrices) +
        sumKillmailItemValue(normalizedItems, "all", basePrices),
    ),
    iskDestroyed: normalizeNumber(
      record.iskDestroyed,
      getBasePrice(record.victimShipTypeID, basePrices) +
        sumKillmailItemValue(normalizedItems, "destroyed", basePrices),
    ),
    bountyClaimed: normalizeNullableNumber(record.bountyClaimed, null),
    loyaltyPoints: normalizeNullableNumber(record.loyaltyPoints, null),
    killRightSupplied: normalizePositiveInteger(record.killRightSupplied, null),
    attackers: normalizedAttackers,
    items: normalizedItems,
  };
  normalizedRecord.killBlob = normalizeText(
    record.killBlob,
    buildKillBlob({
      attackers: normalizedAttackers,
      items: normalizedItems,
    }),
  );
  // Server-only evidence captured at destruction. It is deliberately absent
  // from the public killmail payload and survives worker preparation/restart.
  if (normalizePositiveInteger(record.achievementFwWinnerCharacterID, null)) {
    normalizedRecord.achievementFwWinnerCharacterID = normalizePositiveInteger(record.achievementFwWinnerCharacterID, null);
  }
  if (record.careerNpcShip === true) normalizedRecord.careerNpcShip = true;
  if (normalizePositiveInteger(record.careerFwFinalBlowCharacterID, null))
    normalizedRecord.careerFwFinalBlowCharacterID = normalizePositiveInteger(record.careerFwFinalBlowCharacterID, null);
  if (normalizePositiveInteger(record.careerFinalShipTypeID, null))
    normalizedRecord.careerFinalShipTypeID = normalizePositiveInteger(record.careerFinalShipTypeID, null);
  for (const field of ["careerFwFinalBlowFactionID", "careerFwVictimFactionID"]) {
    if (normalizePositiveInteger(record[field], null))
      normalizedRecord[field] = normalizePositiveInteger(record[field], null);
  }

  return {
    record: normalizedRecord,
    projection: buildKillmailProjection(normalizedRecord),
    prepareMs: performance.now() - startedAtMs,
  };
}

module.exports = {
  buildKillmailProjection,
  isOwnerKillLogVictim,
  prepareKillmailRecord,
};
