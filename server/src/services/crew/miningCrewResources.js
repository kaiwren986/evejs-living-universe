"use strict";

const { CrewError } = require("./crewService");
// Uses the same finite rock owner as ship/NPC mining. No timer grants ore.
function createMiningCrewResources({ worldData, sceneForSystem, items, notify = () => {} }) {
  const mining = require("../mining/miningRuntimeState");
  const commits = require("../mining/miningCargoCommits");
  const pending = (message = "Mining cargo is awaiting durable confirmation.") => {
    throw new CrewError("CREW_CUSTODY_PENDING", message, 503);
  };
  function station(id) { return worldData.getStationByID(id); }
  function belt(id) { return worldData.getAsteroidBeltByID(id); }
  function rocks(systemID, beltID) {
    const scene = sceneForSystem(systemID);
    if (!scene || scene.systemID !== systemID) pending("The assigned mining system is unavailable.");
    const cache = mining.ensureSceneMiningState(scene);
    const result = [];
    for (const state of cache.byEntityID.values()) {
      if (state.beltID !== beltID || state.yieldKind !== "ore") continue;
      const entity = scene.getEntityByID(state.entityID);
      if (!entity && state.remainingQuantity > 0) continue;
      if (entity && !mining.shouldPersistMineableState(entity)) continue;
      const current = mining.getMineableState(scene, state.entityID);
      if (!current) pending();
      result.push(current);
    }
    return result.sort((a, b) => a.entityID - b.entityID);
  }
  function sites(homeStationID) {
    const home = station(homeStationID);
    if (!home) throw new CrewError("CREW_STATION_INVALID", "Choose a known home station.", 400);
    return worldData.getAsteroidBeltsForSystem(home.solarSystemID).slice(0, 128).map(site => {
      const totals = new Map();
      for (const rock of rocks(home.solarSystemID, site.itemID)) {
        const type = items.getItemMetadata(rock.yieldTypeID);
        if (!totals.has(rock.yieldTypeID)) totals.set(rock.yieldTypeID, { typeID: rock.yieldTypeID,
          name: type?.name || type?.itemName || `Ore ${rock.yieldTypeID}`, remainingQuantity: 0, unitVolume: rock.unitVolume });
        totals.get(rock.yieldTypeID).remainingQuantity += rock.remainingQuantity;
      }
      return { beltID: site.itemID, name: site.itemName || site.name || `Belt ${site.itemID}`, systemID: home.solarSystemID, ores: [...totals.values()] };
    });
  }
  return { station, belt, sites,
    prepare(state) {
      const rock = rocks(state.systemID, state.plan.beltID).find(rock => rock.yieldTypeID === state.plan.typeID && rock.remainingQuantity > 0);
      if (!rock) return null;
      const quantity = Math.min(rock.remainingQuantity, Math.floor(state.job.batchM3 / rock.unitVolume),state.job.quantityLimit||Number.MAX_SAFE_INTEGER);
      if (quantity < 1) throw new CrewError("CREW_CARGO_CAPACITY", "One unit of this ore exceeds the mining hold.", 400);
      return { resourceID: rock.entityID, state: JSON.parse(JSON.stringify(rock)), quantity };
    },
    extract(state) {
      const job = state.job, allocation = job.allocation;
      const result = commits.commitCrewExtraction({ ownerID: state.ownerID, locationID: state.escrowLocationID,
        serial: job.serial, jobID: job.jobID, systemID: state.systemID, resourceID: allocation.resourceID,
        state: allocation.state, quantity: allocation.quantity, atMs: job.extractionAtMs });
      if (!result.success) {
        if (result.notAccepted && result.errorMsg === "MINING_RESOURCE_COMMIT_STALE") return { retry: true };
        pending();
      }
      // Observe the committed owner state; never apply another mining delta.
      const scene = sceneForSystem(state.systemID);
      if (!mining.getMineableState(scene, allocation.resourceID)) pending();
      return { itemID: result.data.itemID, typeID: result.data.state.yieldTypeID,
        quantity: result.data.transferred, volumeM3: result.data.transferred * result.data.state.unitVolume,
        name: items.getItemMetadata(result.data.state.yieldTypeID)?.name || `Ore ${result.data.state.yieldTypeID}` };
    },
    unload(state) {
      const job = state.job, cargo = job.cargo, receiptKey = `crew-mining:${job.jobID}:unload`;
      const prior = items.getIdempotentGrantReceipt(receiptKey, { requireDurable: true });
      if (!prior.success) pending();
      if (!prior.found) {
        const item = items.findItemById(cargo.itemID);
        if (!item || item.ownerID !== state.ownerID || item.locationID !== state.escrowLocationID || item.flagID !== 5 ||
            item.typeID !== cargo.typeID || item.quantity !== cargo.quantity || item.custodyReservation) {
          throw new CrewError("CREW_CUSTODY_CONFLICT", "The mining load changed before delivery. It is held for recovery.");
        }
      }
      const result = items.moveItemToLocationIdempotent(cargo.itemID, state.plan.homeStationID, 4, null, {
        receiptKey, fingerprint: { ownerID: state.ownerID, itemID: cargo.itemID, typeID: cargo.typeID,
          quantity: cargo.quantity, source: state.escrowLocationID, destination: state.plan.homeStationID, flag: 4 } });
      if (!result.success || result.durable !== true) pending();
      if (result.data?.changes?.length) { try { notify(state.ownerID, result.data.changes); } catch { /* inventory refresh converges */ } }
    },
    acknowledge(jobID) {
      const result = items.acknowledgeMiningCrewTransfer(jobID);
      if (!result.success || result.durable !== true) pending();
    },
  };
}
module.exports = { createMiningCrewResources };
