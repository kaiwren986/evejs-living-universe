"use strict";

// A narrow metadata input for explicit, whole-item space-loot owner changes.
// It cannot replace arbitrary customInfo, grant fleet rights or retain a
// corporation-property marker after the item becomes character-owned.
const AFFILIATION_KEYS = ["corporationID", "lootRightCorpID", "allianceID", "warFactionID"];
const ALLOWED_KEYS = new Set(["rightsSnapshotVersion", "abandoned", "lootRightFleetID", ...AFFILIATION_KEYS]);

function normalizeOwnerTransferLootInfo(value) {
  if (value === undefined || value === null) return { success: true, info: null };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !ALLOWED_KEYS.has(key)) ||
      value.rightsSnapshotVersion !== 1 || typeof value.abandoned !== "boolean" || value.lootRightFleetID !== null ||
      AFFILIATION_KEYS.some((key) => Object.hasOwn(value, key) &&
        (!Number.isSafeInteger(value[key]) || value[key] <= 0)) ||
      value.lootRightCorpID !== value.corporationID) {
    return { success: false, errorMsg: "INVALID_OWNER_TRANSFER_LOOT_INFO" };
  }
  return { success: true, info: {
    rightsSnapshotVersion: 1, abandoned: value.abandoned, lootRightFleetID: null,
    ...Object.fromEntries(AFFILIATION_KEYS.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])),
  } };
}

function replaceOwnerTransferLootInfo(customInfo, info) {
  let parsed;
  const raw = String(customInfo || "");
  try { parsed = raw.trim() ? JSON.parse(raw) : {}; }
  catch (_) { return { success: false, errorMsg: "OWNER_TRANSFER_LOOT_METADATA_UNREADABLE" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { success: false, errorMsg: "OWNER_TRANSFER_LOOT_METADATA_UNREADABLE" };
  }
  // Preserve every unrelated JSON value. An opaque legacy string is refused
  // rather than discarded or silently repurposed as a new metadata envelope.
  return { success: true, customInfo: JSON.stringify({ ...parsed, evejsLoot: { ...info } }) };
}

module.exports = { normalizeOwnerTransferLootInfo, replaceOwnerTransferLootInfo };
