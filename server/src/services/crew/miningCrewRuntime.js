"use strict";
let service,pendingTick;
function getDefaultMiningCrewService() {
  if (!service) {
    const config = require("../../config");
    const { createTableRepository } = require("../../gameStore/tableRepository");
    const { createMiningCrewService } = require("./miningCrewService");
    const { createMiningCrewResources } = require("./miningCrewResources");
    service = createMiningCrewService({ repo: createTableRepository("service:crew-mining"),
      resources: createMiningCrewResources({ worldData: require("../../space/worldData"), items: require("../inventory/itemStore"),
        sceneForSystem: id => require("../../space/runtime").ensureScene(id),
        notify(ownerID, changes) {
          const session = require("../chat/sessionRegistry").findSessionByCharacterID(ownerID);
          if (session) require("../character/characterState").emitItemsChangedBatchForSession(session, changes);
        } }),
      crew: id => require("./crewRuntime").getDefaultCrewService().snapshot(id),planning:require("./crewResourcePlanning").getDefaultResourcePlanning(),
      enabled: config.crewOperationsEnabled === true && config.miningEnabled === true && config.asteroidFieldsEnabled === true,
      travelMs: config.crewMiningTravelMs,
      cycleMs: config.crewMiningCycleMs, batchM3: config.crewMiningBatchM3 });
  }
  return service;
}
function tickMiningCrews(){
  if(pendingTick)return Promise.resolve({processed:0,errors:[]});
  const promise=(async()=>{const service=getDefaultMiningCrewService();const planned=await service.plan();const result=service.tick();return{...result,errors:[...planned.errors,...result.errors]};})();
  pendingTick=promise;void promise.finally(()=>{if(pendingTick===promise)pendingTick=null;}).catch(()=>{});return promise;
}
async function drainMiningCrews(){if(pendingTick)await pendingTick;if(service)await service.drain();}
module.exports = { getDefaultMiningCrewService,tickMiningCrews,drainMiningCrews };
