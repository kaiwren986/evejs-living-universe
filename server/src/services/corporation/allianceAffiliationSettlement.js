"use strict";

// This journal shares the alliance store and its existing lifecycle/snapshots.
// It records an obligation before any membership projection changes. Recovery
// rolls forward; it never replaces whole old tables over unrelated new writes.
const db = require("../../gameStore");
const JOURNAL = "affiliationChangesByCorporation";
const clone = value => structuredClone(value);
const owner = () => require("./corporationState");
let applying = false;
const fail = errorMsg => ({ success: false, errorMsg });
function root() {
  const read = db.read("alliances", "/");
  if (!read.success && ["TABLE_NOT_FOUND", "ENTRY_NOT_FOUND"].includes(read.errorMsg)) return {};
  if (!read.success) throw new Error(read.errorMsg || "ALLIANCE_STORE_UNAVAILABLE");
  return read.data || {};
}
function pending() { return root()[JOURNAL] || {}; }
function writeAlliances(value) {
  const written = db.write("alliances", "/", value);
  if (written.success) owner().invalidateAffiliationIndexes();
  return written;
}
function fence(table) {
  return db.flushTableSync(table) || fail("AFFILIATION_FLUSH_FAILED");
}
function settle(intent) {
  // A refused/ambiguous prepare flush may have retained only cached intent.
  // Re-fence it before effects, including when this is a same-process retry.
  const prepared = fence("alliances");
  if (!prepared.success) return prepared;
  const state = owner(), corporation = state.getCorporationRecord(intent.corporationID);
  if (!corporation) return fail("CORPORATION_NOT_FOUND");
  const current = Number(corporation.allianceID) || null;
  if (current !== intent.previousAllianceID && current !== intent.allianceID) return fail("AFFILIATION_MEMBERSHIP_CHANGED");
  const alliances = clone(root());
  if (intent.allianceID && !alliances.records?.[intent.allianceID]) return fail("ALLIANCE_NOT_FOUND");
  for (const alliance of Object.values(alliances.records || {})) {
    alliance.memberCorporationIDs = (Array.isArray(alliance.memberCorporationIDs) ? alliance.memberCorporationIDs : [])
      .filter(id => Number(id) !== intent.corporationID);
  }
  const next = alliances.records?.[intent.allianceID];
  if (next) next.memberCorporationIDs = [...new Set([...next.memberCorporationIDs.map(id => {
    const numeric = Number(id);
    return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
  }).filter(Boolean), intent.corporationID])]
    .sort((a, b) => a - b);
  const allianceWrite = writeAlliances(alliances);
  if (!allianceWrite.success) return allianceWrite;
  // Shared bookmark access granted to the old alliance is resolved through the
  // corporation record, so snapshot the members' access before it changes.
  let bookmarkAccessBefore = null;
  try {
    bookmarkAccessBefore = require("../bookmark/bookmarkNotifications").captureFolderAccess({
      characterIDs: state.getCharacterIDsInCorporation(intent.corporationID),
    });
  } catch (_error) {
    bookmarkAccessBefore = null;
  }
  const corporationWrite = state.setCorporationRecord({ ...corporation, allianceID: intent.allianceID });
  if (!corporationWrite.success) return corporationWrite;
  // Membership may have changed while an earlier attempt was interrupted.
  // Include new members and never pull a former member back into this corp.
  const affectedCharacterIDs = state.getCharacterIDsInCorporation(intent.corporationID);
  for (const characterID of affectedCharacterIDs) {
    const updated = state.setCharacterAffiliation(characterID, intent.corporationID, intent.allianceID);
    if (!updated.success) return updated;
  }
  for (const table of ["alliances", "corporations", "characters"]) {
    const flushed = fence(table);
    if (!flushed.success) return flushed;
  }
  const beforeAck = clone(root()), acknowledged = clone(beforeAck);
  delete acknowledged[JOURNAL][intent.corporationID];
  const ack = writeAlliances(acknowledged);
  if (!ack.success) return ack;
  let flushed;
  try { flushed = fence("alliances"); }
  catch (error) { writeAlliances(beforeAck); throw error; }
  if (!flushed.success) { writeAlliances(beforeAck); return flushed; }
  // The legacy client rebinds and clears its membership cache on allianceid.
  // Publish only after every projection and the acknowledgement are durable.
  state.synchronizeCorporationSessionAffiliationBestEffort(affectedCharacterIDs, intent.allianceID);
  if (bookmarkAccessBefore && bookmarkAccessBefore.size > 0) {
    try {
      require("../bookmark/bookmarkNotifications").notifyFolderAccessChanges(bookmarkAccessBefore);
    } catch (_error) {
      // The durable alliance change stands; the folder list refreshes on relog.
    }
  }
  return { success: true, data: { corporationID: intent.corporationID, allianceID: intent.allianceID, affectedCharacterIDs } };
}
function reconcile(corporationID = null) {
  if (applying) return { success: true };
  applying = true;
  try {
    const entries = Object.values(pending()).filter(intent => !corporationID || intent.corporationID === Number(corporationID));
    if (entries.length && !db.mayMutateTable("alliances")) return fail("ALLIANCE_AFFILIATION_PENDING");
    for (const intent of entries) {
      const result = settle(intent);
      if (!result.success) return result;
    }
    return { success: true };
  } catch (error) { return fail(error.message); }
  finally { applying = false; }
}
function change(corporationID, allianceID) {
  if (applying) return fail("ALLIANCE_AFFILIATION_REENTRANT");
  const recovered = reconcile(corporationID);
  if (!recovered.success) return recovered;
  applying = true;
  try {
    const state = owner(), corporation = state.getCorporationRecord(corporationID);
    if (!corporation) return fail("CORPORATION_NOT_FOUND");
    const nextID = Number(allianceID) > 0 ? Math.trunc(Number(allianceID)) : null;
    const alliances = clone(state.ensureAlliancesInitialized());
    if (nextID && !alliances.records[nextID]) return fail("ALLIANCE_NOT_FOUND");
    const affectedCharacterIDs = state.getCharacterIDsInCorporation(corporation.corporationID);
    const previousID = Number(corporation.allianceID) || null;
    // A coherent retry is successful. Older partial writes (before journaling)
    // are repaired even when the corporation already names the destination.
    const characters = db.read("characters", "/");
    if (!characters.success) return characters;
    const coherent = previousID === nextID && affectedCharacterIDs.every(id =>
      (Number(characters.data[id]?.allianceID) || null) === nextID &&
      (nextID ? Number(characters.data[id]?.allianceMemberStartDate) > 0 : !Number(characters.data[id]?.allianceMemberStartDate))) &&
      Object.values(alliances.records).every(alliance =>
        (Array.isArray(alliance.memberCorporationIDs) ? alliance.memberCorporationIDs : []).some(
          id => Number(id) === corporation.corporationID) === (Number(alliance.allianceID) === nextID));
    if (coherent) {
      for (const table of ["alliances", "corporations", "characters"]) {
        const flushed = fence(table);
        if (!flushed.success) return flushed;
      }
      state.synchronizeCorporationSessionAffiliationBestEffort(affectedCharacterIDs, nextID);
      return { success: true, duplicate: true, data: { corporationID: corporation.corporationID, allianceID: nextID, affectedCharacterIDs } };
    }
    const intent = { version: 1, corporationID: corporation.corporationID,
      previousAllianceID: previousID, allianceID: nextID };
    alliances[JOURNAL] = { ...(alliances[JOURNAL] || {}), [corporation.corporationID]: intent };
    const written = writeAlliances(alliances);
    if (!written.success) return written;
    return settle(intent);
  } catch (error) { return fail(error.message); }
  finally { applying = false; }
}
function reconcileForCharacter(characterID) {
  const record = db.read("characters", `/${Number(characterID)}`);
  return record.success && Number(record.data?.corporationID) > 0
    ? reconcile(Number(record.data.corporationID)) : { success: true };
}
module.exports = { JOURNAL, change, reconcile, reconcileForCharacter };
