"use strict";
let service;
function getDefaultManufacturingCrewService() {
  if (!service) {
    const config = require("../../config");
    const { createTableRepository } = require("../../gameStore/tableRepository");
    service = require("./manufacturingCrewService").createManufacturingCrewService({
      repo: createTableRepository("service:crew-manufacturing"), enabled: config.crewOperationsEnabled === true,
      industry: require("./manufacturingCrewIndustry").createManufacturingCrewIndustry({ items: require("../inventory/itemStore"), worldData: require("../../space/worldData") }),
      crew: id => require("./crewRuntime").getDefaultCrewService().snapshot(id) });
  }
  return service;
}
async function drainManufacturingCrews() { if (service) await service.drain(); }
module.exports = { getDefaultManufacturingCrewService, drainManufacturingCrews };
