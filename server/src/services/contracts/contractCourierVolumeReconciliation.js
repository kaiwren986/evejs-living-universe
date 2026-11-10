"use strict";

// Repair published courier packages only from their still-intact escrow. The
// manifest is evidence of what belongs in a package, not a source of volume:
// that comes from the actual inventory rows and their packaging state.
function reconcilePublishedCourierVolumes(deps, { contractID = null } = {}) {
  const result = { scanned: 0, reconciled: 0, unchanged: 0, skipped: [], failures: [] };
  const requestedID = contractID === null ? null : Number(contractID);
  const records = deps.listContractRecords();
  const wrapReferences = new Map();
  for (const record of records) {
    if (Number(record && record.type) !== 3 || ![0, 1].includes(Number(record.status))) continue;
    const wrapID = Number(record.plasticWrapItemID);
    if (Number.isSafeInteger(wrapID) && wrapID > 0) {
      wrapReferences.set(wrapID, (wrapReferences.get(wrapID) || 0) + 1);
    }
  }

  for (const record of records) {
    const id = Number(record && record.contractID);
    if (requestedID !== null && id !== requestedID) continue;
    if (Number(record && record.type) !== 3 || ![0, 1].includes(Number(record.status))) continue;
    result.scanned += 1;
    const skip = (reason) => result.skipped.push({ contractID: id, reason });
    const fail = (reason, ambiguous = false) => result.failures.push({ contractID: id, reason, ambiguous });

    try {
      if (!Number.isSafeInteger(id) || id <= 0) {
        skip("INVALID_CONTRACT_ID");
        continue;
      }
      if (deps.getPendingContractSettlement(id)) {
        skip("CONTRACT_OPERATION_PENDING");
        continue;
      }
      const escrowID = deps.getContractEscrowLocationID(id);
      if (!escrowID || Number(record.packageLocationID || record.escrowLocationID) !== escrowID ||
          Number(record.escrowLocationID) !== escrowID) {
        skip("ESCROW_LOCATION_MISMATCH");
        continue;
      }
      const wrapID = Number(record.plasticWrapItemID);
      if (wrapReferences.get(wrapID) !== 1) {
        skip("WRAP_REFERENCE_AMBIGUOUS");
        continue;
      }
      const wrap = deps.findItemById(wrapID);
      if (!wrap || Number(wrap.typeID) !== 3468 || Number(wrap.singleton) !== 1) {
        skip("WRAP_MISSING_OR_INVALID");
        continue;
      }
      const wrapOwnerID = Number(wrap.ownerID);
      if (!Number.isSafeInteger(wrapOwnerID) || wrapOwnerID <= 0 ||
          (Number(record.status) === 0 &&
            (wrapOwnerID !== Number(record.issuerOwnerID) ||
             Number(wrap.locationID) !== escrowID || Number(wrap.flagID) !== 0))) {
        skip("WRAP_CUSTODY_MISMATCH");
        continue;
      }
      if (!Array.isArray(record.packageItems) || record.packageItems.length === 0) {
        skip("MANIFEST_MISSING_OR_EMPTY");
        continue;
      }
      const manifest = new Map();
      let invalid = false;
      for (const row of record.packageItems) {
        const itemID = Number(row && row.itemID);
        const typeID = Number(row && row.itemTypeID);
        const quantity = Number(row && row.quantity);
        if (!Number.isSafeInteger(itemID) || itemID <= 0 || itemID === wrapID ||
            !Number.isSafeInteger(typeID) || typeID <= 0 ||
            !Number.isSafeInteger(quantity) || quantity <= 0 || manifest.has(itemID)) {
          invalid = true;
          break;
        }
        manifest.set(itemID, { typeID, quantity });
      }
      if (invalid) {
        skip("MANIFEST_INVALID");
        continue;
      }
      const contents = deps.listContainerItems(null, escrowID, null);
      if (!Array.isArray(contents)) {
        skip("ESCROW_UNAVAILABLE");
        continue;
      }
      // Wraps in escrow have the issuer's owner ID and are not contents. Any
      // other unexpected escrow row makes a partial calculation unsafe.
      const items = contents.filter((item) => Number(item && item.itemID) !== wrapID);
      if (items.length !== manifest.size) {
        skip("ESCROW_MANIFEST_MISMATCH");
        continue;
      }
      let total = 0;
      let itemError = "ESCROW_MANIFEST_MISMATCH";
      for (const item of items) {
        const itemID = Number(item && item.itemID);
        const expected = manifest.get(itemID);
        const singleton = Number(item && item.singleton) > 0;
        const quantity = singleton ? 1 : Number(item && (item.stacksize ?? item.quantity));
        if (!expected || Number(item.typeID) !== expected.typeID ||
            Number(item.ownerID) !== 1 || Number(item.locationID) !== escrowID || Number(item.flagID) !== 0 ||
            quantity !== expected.quantity || (singleton && Number(item.stacksize) !== 1)) {
          invalid = true;
          break;
        }
        manifest.delete(itemID);
        const metadata = deps.getItemMetadata(expected.typeID);
        if (!metadata || metadata.volume === null || metadata.volume === undefined ||
            !Number.isFinite(Number(metadata.volume)) || Number(metadata.volume) < 0) {
          itemError = "ITEM_TYPE_VOLUME_UNAVAILABLE";
          invalid = true;
          break;
        }
        const unit = deps.getInventoryItemUnitVolume(item);
        if (!Number.isFinite(unit) || unit < 0) {
          itemError = "ITEM_VOLUME_INVALID";
          invalid = true;
          break;
        }
        total += unit * quantity;
      }
      if (invalid || manifest.size !== 0) {
        skip(itemError);
        continue;
      }
      const centiVolume = Math.max(1, Math.round(total * 100));
      if (!Number.isSafeInteger(centiVolume) || centiVolume > 2147483648) {
        skip("VOLUME_NOT_REPRESENTABLE");
        continue;
      }
      const volume = centiVolume / 100;
      if (record.courierVolumeReconciliationVersion === 1 &&
          Number(record.volume) === volume && Number(wrap.quantity) === -centiVolume &&
          Number(wrap.plasticWrapVolume) === volume) {
        result.unchanged += 1;
        continue;
      }
      // Fence the wrap before publishing the total. If either write is
      // uncertain, the missing version marker makes the next pass retry both.
      const updatedWrap = deps.setPlasticWrapVolumeDurably(wrapID, volume);
      if (!updatedWrap || updatedWrap.success !== true || updatedWrap.durable !== true) {
        fail(updatedWrap && updatedWrap.errorMsg || "WRAP_WRITE_FAILED", Boolean(updatedWrap && updatedWrap.ambiguous));
        continue;
      }
      const updatedRecord = deps.putContractRecordDurably({
        ...record,
        volume,
        courierVolumeReconciliationVersion: 1,
      });
      if (!updatedRecord || updatedRecord.success !== true) {
        fail(updatedRecord && updatedRecord.errorMsg || "CONTRACT_WRITE_FAILED", Boolean(updatedRecord && updatedRecord.ambiguous));
        continue;
      }
      result.reconciled += 1;
    } catch (error) {
      fail(String(error && error.message || error), true);
    }
  }
  return result;
}

module.exports = { reconcilePublishedCourierVolumes };
