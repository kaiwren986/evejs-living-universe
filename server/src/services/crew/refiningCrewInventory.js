"use strict";
const { CrewError } = require("./crewService");
function createRefiningCrewInventory({ items, worldData, notify = () => {} }) {
  const runtime = require("../reprocessing/reprocessingRuntime");
  const recipes = require("../reprocessing/reprocessingStaticData");
  const settlements = require("../reprocessing/reprocessingSettlementState");
  const pending = () => { throw new CrewError("CREW_CUSTODY_PENDING", "Refining settlement is awaiting confirmation. The saved batch will retry.", 503); };
  function recipe(ownerID, stationID, typeID, quantity) {
    const profile = recipes.getReprocessingProfile(typeID);
    if (profile?.reprocessingFamily !== "ore" || profile.categoryID !== 25 || !profile.isRefinable ||
        profile.randomizedMaterials.length || !profile.materials.length || profile.materials.some(m => items.getItemMetadata(m.materialTypeID)?.groupID !== 18)) {
      throw new CrewError("CREW_CARGO_INVALID", "Choose ordinary ore with a fixed mineral recipe.", 400);
    }
    const context = runtime.resolveCrewReprocessingContext(ownerID, stationID);
    if (!context.success) throw new CrewError("CREW_STATION_INVALID", "Choose an NPC station with refining facilities.", 400);
    const quote = runtime.buildReprocessingQuoteForItem({ itemID: 0, typeID, singleton: 0, quantity: quantity || profile.portionSize,
      stacksize: quantity || profile.portionSize }, context.data);
    if (!quote || quote.errorMsg || !quote.quantityToProcess) throw new CrewError("CREW_CARGO_INVALID", "This ore needs a complete refining portion.", 400);
    const outputs = quote.recoverables.filter(entry => entry.client > 0).map(entry => ({ typeID: entry.typeID,
      quantity: entry.client, name: items.getItemMetadata(entry.typeID).name }));
    if (!outputs.length) throw new CrewError("CREW_CARGO_INVALID", "This batch would recover no minerals.", 400);
    return { typeID, name: profile.name, portionSize: profile.portionSize, quantityToProcess: quote.quantityToProcess,
      leftOvers: quote.leftOvers, efficiency: quote.efficiency, stationTax: quote.stationTax, totalCost: quote.totalISKCost, outputs };
  }
  function move(state, returning = false) {
    const job = state.job, cargo = job.cargo, quantity = returning ? job.rejected ? cargo.quantity : job.quote.leftOvers : cargo.quantity;
    if (!quantity) return;
    const source = returning ? state.escrowLocationID : state.plan.stationID;
    const destination = returning ? state.plan.stationID : state.escrowLocationID, flag = returning ? 4 : 5;
    const receiptKey = `crew-refine:${job.jobID}:${returning ? "return" : "reserve"}`;
    const prior = items.getIdempotentGrantReceipt(receiptKey, { requireDurable: true });
    if (!prior.success) pending();
    if (!returning && cargo.inputs) {
      const result = items.exchangeInventoryItemStacksIdempotent(cargo.inputs.map(input => ({
        itemID: input.itemID, quantity: input.quantity, expectedQuantity: input.sourceQuantity,
        expectedOwnerID: state.ownerID, expectedTypeID: cargo.typeID, expectedLocationID: source, expectedFlagID: 4,
      })), [{ ownerID: state.ownerID, locationID: destination, flagID: flag, typeID: cargo.typeID, quantity }], {
        receiptKey, fingerprint: { ownerID: state.ownerID, source, destination, flag, typeID: cargo.typeID, quantity, inputs: cargo.inputs },
      });
      if (!result.success || result.durable !== true) pending();
      const held = (result.data.committedChanges || result.data.changes).find(change => !change.removed && change.item?.locationID === destination && change.item?.flagID === flag && change.item?.typeID === cargo.typeID)?.item;
      if (!held || held.quantity !== quantity) pending();
      cargo.custodyItemID = held.itemID;
      if (result.data.changes.length) { try { notify(state.ownerID, result.data.changes); } catch { /* inventory refresh converges */ } }
      return;
    }
    const itemID = returning ? cargo.custodyItemID || cargo.itemID : cargo.itemID;
    if (!prior.found) {
      const item = items.findItemById(itemID);
      if (!item || item.ownerID !== state.ownerID || item.locationID !== source || item.flagID !== (returning ? 5 : 4) ||
          item.typeID !== cargo.typeID || item.quantity !== quantity || item.custodyReservation || item.singleton !== 0) {
        throw new CrewError("CREW_CUSTODY_CONFLICT", "The refining input changed before custody could be confirmed.");
      }
    }
    const result = items.moveItemToLocationIdempotent(itemID, destination, flag, null, { receiptKey,
      fingerprint: { ownerID: state.ownerID, itemID, typeID: cargo.typeID, quantity, source, destination, flag } });
    if (!result.success || result.durable !== true) pending();
    if (result.data?.changes?.length) { try { notify(state.ownerID, result.data.changes); } catch { /* inventory refresh converges */ } }
  }
  return { station: id => worldData.getStationByID(id), recipe,
    balance: id => require("../account/walletState").getCharacterWallet(id)?.balance || 0,
    options(ownerID, stationID, extraTypeID) {
      if (!(Number(worldData.getStationByID(stationID)?.reprocessingEfficiency) > 0)) throw new CrewError("CREW_STATION_INVALID", "Choose an NPC station with refining facilities.", 400);
      const types = [...new Set([extraTypeID, ...items.listContainerItems(ownerID, stationID, 4).map(item => item.typeID)])].filter(Boolean).slice(0, 100);
      return types.flatMap(id => { try { return [recipe(ownerID, stationID, id)]; } catch (error) { if (error.code === "CREW_CARGO_INVALID") return []; throw error; } });
    },
    select(state, capacityM3, quantityLimit = Number.MAX_SAFE_INTEGER) {
      const stacks = items.listContainerItems(state.ownerID, state.plan.stationID, 4).filter(item => item.typeID === state.plan.typeID &&
        item.singleton === 0 && !item.custodyReservation && Number.isSafeInteger(item.quantity) && item.quantity > 0);
      const total = stacks.reduce((sum, item) => sum + item.quantity, 0);
      for (const item of stacks.sort((a, b) => a.itemID - b.itemID)) {
        const volume = items.getInventoryItemUnitVolume(item);
        if (!Number.isFinite(volume) || volume <= 0 || total - item.quantity < state.plan.oreReserve || item.quantity * volume > capacityM3 || item.quantity>quantityLimit) continue;
        let quote; try { quote = recipe(state.ownerID, state.plan.stationID, item.typeID, item.quantity); }
        catch (error) { if (error.code === "CREW_CARGO_INVALID") continue; throw error; }
        return { cargo: { itemID: item.itemID, typeID: item.typeID, quantity: item.quantity }, quote };
      }
      // A full portion may span mining leftovers, or sit inside a stack larger
      // than the refinery. Freeze a bounded input selection; custody consumes
      // and consolidates precisely that batch in one durable inventory receipt.
      const candidates = stacks.slice(0, 32);
      if (!candidates.length) return null;
      const portion = recipe(state.ownerID, state.plan.stationID, state.plan.typeID).portionSize;
      const volume = items.getInventoryItemUnitVolume(candidates[0]);
      if (!Number.isFinite(volume) || volume <= 0) return null;
      const available = Math.min(total - state.plan.oreReserve, candidates.reduce((n, item) => n + item.quantity, 0), Math.floor(capacityM3 / volume),quantityLimit);
      const quantity = Math.floor(available / portion) * portion;
      if (quantity < portion) return null;
      let remaining = quantity;
      const inputs = [];
      for (const item of candidates) {
        const take = Math.min(item.quantity, remaining);
        if (take > 0) inputs.push({ itemID: item.itemID, quantity: take, sourceQuantity: item.quantity });
        remaining -= take;
        if (!remaining) break;
      }
      return { cargo: { itemID: inputs[0].itemID, typeID: state.plan.typeID, quantity, inputs },
        quote: recipe(state.ownerID, state.plan.stationID, state.plan.typeID, quantity) };
    },
    reserve: state => move(state),
    returnRemainder: state => move(state, true),
    async settle(state) {
      const job = state.job, quote = job.quote;
      const prepared = settlements.prepareReprocessingSettlement({ characterID: state.ownerID, facilityLocationID: state.plan.stationID,
        crewOrder: { jobID: job.jobID, serial: job.serial }, ownerCorporationID: 0, totalCost: quote.totalCost,
        walletDescription: "Crew refining tax", inputs: [{ itemID: job.cargo.custodyItemID || job.cargo.itemID, typeID: job.cargo.typeID,
          quantity: quote.quantityToProcess, ownerID: state.ownerID, locationID: state.escrowLocationID, flagID: 5 }],
        outputs: quote.outputs, outputTarget: { ownerID: state.ownerID, locationID: state.plan.stationID, flagID: 4 },
        outputByTypeID: Object.fromEntries(quote.outputs.map(entry => [entry.typeID, entry.quantity])),
        reprocessedEvents: [{ characterID: state.ownerID, solarSystemID: state.systemID, dockedKind: "station",
          dockedLocationID: state.plan.stationID, inputTypeID: job.cargo.typeID, quantity: quote.quantityToProcess,
          outputs: quote.outputs.map(entry => ({ outputTypeID: entry.typeID, quantity: entry.quantity })) }] });
      if (!prepared.success) pending();
      if (prepared.completed) return prepared.result;
      const result = await settlements.settleReprocessingSettlement(state.ownerID);
      if (!result.success) pending();
      const completed = settlements.getCrewReprocessingResult(state.ownerID, job.jobID, job.serial);
      if (!completed) pending();
      return completed;
    },
    acknowledge(state) {
      const result = settlements.acknowledgeCrewReprocessing(state.ownerID, state.job.jobID, state.job.serial);
      if (!result.success) pending();
    },
  };
}
module.exports = { createRefiningCrewInventory };
