"use strict";

const { createCrewService } = require("./crewService");
const { createCrewInventory } = require("./crewInventory");

function createCrewWorld(worldData) {
  return {
    station: (stationID) => worldData.getStationByID(stationID) || null,
    system: (systemID) => worldData.getSolarSystemByID(systemID) || null,
    searchStations(query) {
      const text = String(query || "").trim().toLowerCase().slice(0, 80);
      if (text.length < 2) return [];
      return worldData.getSolarSystems().flatMap((system) => worldData.getStationsForSystem(system.solarSystemID))
        .filter((station) => String(station.stationID) === text || String(station.stationName || station.name).toLowerCase().includes(text))
        .slice(0, 30).map((station) => ({ stationID: station.stationID, stationName: station.stationName || station.name, solarSystemID: station.solarSystemID }));
    },
    route(source, destination) {
      const previous = new Map([[source, null]]), queue = [{ systemID: source, depth: 0 }];
      for (let index = 0; index < queue.length && index < 10000; index++) {
        const { systemID, depth } = queue[index];
        if (systemID === destination) {
          const route = [];
          for (let current = destination; current !== null; current = previous.get(current)) route.unshift(current);
          return route;
        }
        if (depth >= 32) continue;
        for (const gate of worldData.getStargatesForSystem(systemID)) {
          const target = gate.destinationSolarSystemID;
          if (Number.isSafeInteger(target) && target > 0 && !previous.has(target)) {
            previous.set(target, systemID); queue.push({ systemID: target, depth: depth + 1 });
          }
        }
      }
      return [];
    },
  };
}

let defaultService = null, timer = null, courierTick = null;
function getDefaultCrewService() {
  if (!defaultService) {
    const config = require("../../config");
    const { createTableRepository } = require("../../gameStore/tableRepository");
    defaultService = createCrewService({
      repo: createTableRepository("service:crew"),
      inventory: createCrewInventory({ items: require("../inventory/itemStore"), notify(ownerID, changes) {
        const session = require("../chat/sessionRegistry").findSessionByCharacterID(ownerID);
        if (session) require("../character/characterState").emitItemsChangedBatchForSession(session, changes);
      } }),
      world: createCrewWorld(require("../../space/worldData")),
      character: (id) => require("../character/characterState").getCharacterRecord(id),
      planning: require("./crewResourcePlanning").getDefaultResourcePlanning(),
      enabled: config.crewOperationsEnabled === true, legMs: config.crewTravelLegMs,
    });
  }
  return defaultService;
}
function tickCourierCrews() {
  if (courierTick) return Promise.resolve({ processed: 0, errors: [] });
  const promise = (async () => {
    const service = getDefaultCrewService(), planned = await service.plan(), result = service.tick();
    return { ...result, errors: [...planned.errors, ...result.errors] };
  })();
  courierTick = promise; void promise.finally(() => { if (courierTick === promise) courierTick = null; }).catch(() => {}); return promise;
}
function startCrewOperations() {
  const service = getDefaultCrewService();
  if (!service.enabled || timer) return;
  const log = require("../../utils/logger");
  let lastError = "";
  let refiningError = "";
  let manufacturingError = "";
  let sellingError = "";
  let buyingError = "";
  let miningError = "";
  let courierError = "";
  let equipmentError = "";
  timer = setInterval(() => {
    try {
      const result = { errors: [] };
      try {
        void require("./crewEquipmentRuntime").getDefaultCrewEquipmentService().tick().then(result => {
          const error = JSON.stringify(result.errors); if (result.errors.length && error !== equipmentError) log.warn(`[CrewEquipment] Recovery pending: ${error}`); equipmentError = error;
        }).catch(error => { const code = error.code || error.message; if (code !== equipmentError) log.warn(`[CrewEquipment] ${code}`); equipmentError = code; });
      } catch (error) { result.errors.push({ scope: "equipment", code: error.code || error.message }); }
      try {
        void require("./buyingCrewRuntime").getDefaultBuyingCrewService().tick().then(result => {
          const error=JSON.stringify(result.errors);if(result.errors.length&&error!==buyingError)log.warn(`[BuyingCrew] Recovery pending: ${error}`);buyingError=error;
        }).catch(error=>{const code=error.code||error.message;if(code!==buyingError)log.warn(`[BuyingCrew] ${code}`);buyingError=code;});
      }catch(error){result.errors.push({scope:"buying",code:error.code||error.message});}
      try {
        void require("./sellingCrewRuntime").getDefaultSellingCrewService().tick().then(result => {
          const error = JSON.stringify(result.errors);
          if (result.errors.length && error !== sellingError) log.warn(`[SellingCrew] Recovery pending: ${error}`);
          sellingError = error;
        }).catch(error => { const code = error.code || error.message; if (code !== sellingError) log.warn(`[SellingCrew] ${code}`); sellingError = code; });
      } catch (error) { result.errors.push({ scope: "selling", code: error.code || error.message }); }
      try {
        void require("./manufacturingCrewRuntime").getDefaultManufacturingCrewService().tick().then(result => {
          const error = JSON.stringify(result.errors);
          if (result.errors.length && error !== manufacturingError) log.warn(`[ManufacturingCrew] Recovery pending: ${error}`);
          manufacturingError = error;
        }).catch(error => {
          const code = error.code || error.message;
          if (code !== manufacturingError) log.warn(`[ManufacturingCrew] ${code}`); manufacturingError = code;
        });
      } catch (error) { result.errors.push({ scope: "manufacturing", code: error.code || error.message }); }
      try {
        void require("./refiningCrewRuntime").getDefaultRefiningCrewService().tick().then(result => {
          const error = JSON.stringify(result.errors);
          if (result.errors.length && error !== refiningError) log.warn(`[RefiningCrew] Recovery pending: ${error}`);
          refiningError = error;
        }).catch(error => {
          const code = error.code || error.message;
          if (code !== refiningError) log.warn(`[RefiningCrew] ${code}`);
          refiningError = code;
        });
      } catch (error) { result.errors.push({ scope: "refining", code: error.code || error.message }); }
      try{
        void require("./miningCrewRuntime").tickMiningCrews().then(result=>{const error=JSON.stringify(result.errors);if(result.errors.length&&error!==miningError)log.warn(`[MiningCrew] Recovery pending: ${error}`);miningError=error;})
          .catch(error=>{const code=error.code||error.message;if(code!==miningError)log.warn(`[MiningCrew] ${code}`);miningError=code;});
      }catch(error){result.errors.push({scope:"mining",code:error.code||error.message});}
      void tickCourierCrews().then(result => {
        const error = JSON.stringify(result.errors);
        if (result.errors.length && error !== courierError) log.warn(`[Crew] Recovery pending: ${error}`);
        courierError = error;
      }).catch(error => { const code = error.code || error.message; if (code !== courierError) log.warn(`[Crew] ${code}`); courierError = code; });
      const error = JSON.stringify(result.errors);
      if (result.errors.length && error !== lastError) log.warn(`[Crew] Recovery pending: ${error}`);
      lastError = error;
    } catch (error) {
      const code = error.code || error.message;
      if (code !== lastError) log.warn(`[Crew] ${code}`);
      lastError = code;
    }
  }, 1000);
  timer.unref();
  require("../../gameStore").registerShutdownHook("crew-operations", stopCrewOperations);
}
async function stopCrewOperations() { if (timer) clearInterval(timer); timer = null; if (courierTick) await courierTick; if (defaultService) await defaultService.drain(); await Promise.all([
  require("./miningCrewRuntime").drainMiningCrews(),require("./refiningCrewRuntime").drainRefiningCrews(), require("./manufacturingCrewRuntime").drainManufacturingCrews(), require("./sellingCrewRuntime").drainSellingCrews(), require("./buyingCrewRuntime").drainBuyingCrews(), require("./crewEquipmentRuntime").drainCrewEquipment()]); }
module.exports = { createCrewWorld, getDefaultCrewService, tickCourierCrews, startCrewOperations, stopCrewOperations };
