"use strict";

const { CrewError } = require("./crewService");

function createCrewInventory({ items, notify = () => {} }) {
  function inspect(ownerID, stationID, itemID, capacityM3) {
    const item = items.findItemById(itemID);
    if (!item || item.ownerID !== ownerID || item.locationID !== stationID || item.flagID !== 4 || item.singleton !== 0 ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.categoryID === 6 || item.custodyReservation) {
      throw new CrewError("CREW_CARGO_INVALID", "Choose one packaged stack in the crew's station hangar.", 400);
    }
    const volume = items.getInventoryItemUnitVolume(item);
    if (!Number.isFinite(volume) || volume <= 0 || item.quantity * volume > capacityM3) {
      throw new CrewError("CREW_CARGO_CAPACITY", `This stack exceeds the crew's ${capacityM3} m³ hold.`, 400);
    }
    return { itemID, typeID: item.typeID, name: item.itemName || `Type ${item.typeID}`, quantity: item.quantity, volumeM3: item.quantity * volume };
  }
  function move(state, job, phase) {
    const source = phase === "reserve" ? job.sourceStationID : state.escrowLocationID;
    const destination = phase === "reserve" ? state.escrowLocationID : job.destinationStationID;
    const flag = phase === "reserve" ? 5 : 4;
    const receiptKey = `crew:${job.jobID}:${phase}`;
    const itemID = phase === "reserve" ? job.cargo.itemID : job.cargo.custodyItemID || job.cargo.itemID;
    const prior = items.getIdempotentGrantReceipt(receiptKey, { requireDurable: true });
    if (!prior.success) throw new CrewError("CREW_CUSTODY_PENDING", "Cargo custody is pending. Retry the same order.", 503);
    if (!prior.found) {
      const item = items.findItemById(itemID);
      if (!item || item.ownerID !== state.ownerID || item.locationID !== source || item.typeID !== job.cargo.typeID ||
          item.quantity !== (phase === "reserve" ? job.cargo.sourceQuantity || job.cargo.quantity : job.cargo.quantity) || item.flagID !== (phase === "reserve" ? 4 : 5) || item.custodyReservation) {
        throw new CrewError("CREW_CUSTODY_CONFLICT", "Cargo changed before custody could be confirmed. The job is held for recovery.");
      }
    }
    const result = items.moveItemToLocationIdempotent(itemID, destination, flag, job.cargo.sourceQuantity && phase === "reserve" ? job.cargo.quantity : null, {
      receiptKey, fingerprint: { ownerID: state.ownerID, itemID, typeID: job.cargo.typeID,
        quantity: job.cargo.quantity, source, destination, flag },
    });
    if (!result.success || result.durable !== true) throw new CrewError("CREW_CUSTODY_PENDING", "Cargo custody is pending. Retry the same order.", 503);
    if (phase === "reserve" && job.cargo.sourceQuantity) {
      const held = (result.data.committedChanges || result.data.changes).find(change => !change.removed && change.item?.locationID === destination && change.item?.flagID === flag)?.item;
      if (!held || held.quantity !== job.cargo.quantity) throw new CrewError("CREW_CUSTODY_PENDING", "Cargo custody is pending.", 503);
      job.cargo.custodyItemID = held.itemID;
    }
    // The owner mutation and its receipt are already durable. Notification failure
    // must not turn a successful delivery into a repeated inventory mutation.
    if (result.data?.changes?.length) {
      try { notify(state.ownerID, result.data.changes); } catch { /* next inventory refresh converges */ }
    }
    return result;
  }
  return { inspect, move,
    acknowledge(jobID) {
      const result = items.acknowledgeCrewCargoTransfer(jobID);
      if (!result?.success || result.durable !== true) throw new CrewError("CREW_CUSTODY_PENDING", "Inventory acknowledgement is pending. The next trip will wait.", 503);
    },
    stock(ownerID, stationID, typeID) {
      return items.listContainerItems(ownerID, stationID, 4).filter(item=>item.typeID===typeID&&item.singleton===0&&!item.custodyReservation)
        .reduce((sum,item)=>sum+Math.max(0,item.quantity),0);
    },
    selectSupply(ownerID, stationID, typeID, sourceReserve, capacityM3, quantityLimit = Number.MAX_SAFE_INTEGER) {
      const stacks = items.listContainerItems(ownerID, stationID, 4)
        .filter((item) => item.typeID === typeID && item.singleton === 0 && !item.custodyReservation && Number.isSafeInteger(item.quantity) && item.quantity > 0);
      const total = stacks.reduce((sum, item) => Math.min(Number.MAX_SAFE_INTEGER, sum + item.quantity), 0);
      for (const item of stacks.sort((left, right) => left.itemID - right.itemID)) {
        const volume = items.getInventoryItemUnitVolume(item);
        if (!Number.isFinite(volume) || volume <= 0) continue;
        const quantity = Math.min(item.quantity, total - sourceReserve, Math.floor(capacityM3 / volume), quantityLimit);
        if (quantity <= 0) continue;
        try {
          const description = inspect(ownerID, stationID, item.itemID, Number.MAX_VALUE);
          return quantity === item.quantity ? description : { ...description, quantity, volumeM3: quantity * volume, sourceQuantity: item.quantity };
        }
        catch (error) { if (!["CREW_CARGO_INVALID", "CREW_CARGO_CAPACITY"].includes(error.code)) throw error; }
      }
      return null;
    },
    list(ownerID, stationID) {
    return items.listContainerItems(ownerID, stationID, 4).filter((item) => item.singleton === 0)
      .slice(0, 200).flatMap((item) => { try { return [inspect(ownerID, stationID, item.itemID, 1000)]; } catch { return []; } });
  } };
}
module.exports = { createCrewInventory };
