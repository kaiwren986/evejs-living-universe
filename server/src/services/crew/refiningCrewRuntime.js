"use strict";
let service;
function getDefaultRefiningCrewService() {
  if (!service) {
    const config = require("../../config");
    const { createTableRepository } = require("../../gameStore/tableRepository");
    const { createRefiningCrewService } = require("./refiningCrewService");
    const { createRefiningCrewInventory } = require("./refiningCrewInventory");
    service = createRefiningCrewService({ repo: createTableRepository("service:crew-refining"),
      inventory: createRefiningCrewInventory({ items: require("../inventory/itemStore"), worldData: require("../../space/worldData"),
        notify(ownerID, changes) {
          const session = require("../chat/sessionRegistry").findSessionByCharacterID(ownerID);
          if (session) require("../character/characterState").emitItemsChangedBatchForSession(session, changes);
        } }), crew: id => require("./crewRuntime").getDefaultCrewService().snapshot(id),planning:require("./crewResourcePlanning").getDefaultResourcePlanning(),
      enabled: config.crewOperationsEnabled === true, cycleMs: config.crewRefiningCycleMs, batchM3: config.crewRefiningBatchM3 });
  }
  return service;
}
async function drainRefiningCrews() { if (service) await service.drain(); }
module.exports = { getDefaultRefiningCrewService, drainRefiningCrews };
