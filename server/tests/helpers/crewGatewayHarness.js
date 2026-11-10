"use strict";
// Disposable scenario gateway: real crew/inventory owner, fixture account identity.
const express = require("express");
const { mountEvejsWebGateway } = require("../../src/_secondary/express/evejsWebGateway");
const { createGatewayAuthorityBridge } = require("../../src/edge/gateway/gatewayAuthorityBridge");
const { createRemoteGatewayRuntime } = require("../../src/edge/gateway/remoteGatewayRuntime");
const { GATEWAY_RUNTIME_METHODS } = require("../../src/edge/gateway/gatewayRuntimeProtocol");
const { serializeError, deserializeError } = require("../../src/services/_shared/orderedProcessProtocol");
const { createActorDirectory } = require("../../src/services/livingUniverse/actorDirectory");

function createCrewGatewayHarness(service, miners, refiners, manufacturers, sellers, buyers, equipment) {
  const universe = createActorDirectory();
  universe.register("crews", (query) => service.universeFacts(query));
  if (miners) universe.register("miners", query => miners.universeFacts(query));
  if (refiners) universe.register("refiners", query => refiners.universeFacts(query));
  if (manufacturers) universe.register("manufacturers", query => manufacturers.universeFacts(query));
  if (sellers) universe.register("sellers", query => sellers.universeFacts(query));
  if (buyers) universe.register("buyers", query => buyers.universeFacts(query));
  const pilot = { accountID: 1, characterID: 90001, characterName: "Local test pilot" };
  const runtime = {
    ...Object.fromEntries(GATEWAY_RUNTIME_METHODS.map((method) => [method, () => ({})])),
    dependencies: Object.fromEntries(["serviceManager", "gameStore", "skillQueue", "skillSheet", "planetaryInteraction", "onlinePresence", "characterControl", "characterEvents", "market"].map((key) => [key, true])),
    listAccounts: () => [{ accountID: 1, username: "Local scenario" }],
    getAccountByID: (id) => Number(id) === 1 ? { accountID: 1, username: "Local scenario" } : null,
    listCharacters: (id) => Number(id) === 1 ? [pilot] : [],
    getCharacter: (id) => Number(id) === pilot.characterID ? pilot : null,
    isCharacterOnline: () => true,
    getCharacterControlStatus: () => ({ controlState: "retail_client" }),
    claimBrowserControl: () => { throw new Error("Crew orders must not claim pilot control"); },
    subscribeCharacterEvents: () => () => {},
    shutdown() {},
    getCrewSnapshot: (id) => service.snapshot(id),
    getCrewUniverse: (id) => universe.snapshot({ ownerID: id }),
    submitCrewCommand: (id, command) => service.submit(id, command),
    searchCrewStations: (query) => service.searchStations(query),
    ...(miners ? {
      getMiningCrewSnapshot: id => miners.snapshot(id),
      submitMiningCrewCommand: (id, command) => miners.submit(id, command),
      getMiningCrewSites: (id, homeStationID) => miners.sites(id, homeStationID),
    } : {}),
    ...(refiners ? {
      getRefiningCrewSnapshot: id => refiners.snapshot(id),
      submitRefiningCrewCommand: (id, command) => refiners.submit(id, command),
      getRefiningCrewOptions: (id, stationID) => refiners.options(id, stationID,
        miners?.snapshot(id).mining?.plan.homeStationID === stationID ? miners.snapshot(id).mining.plan.typeID : null),
    } : {}),
    ...(manufacturers ? {
      getManufacturingCrewSnapshot: id => manufacturers.snapshot(id),
      submitManufacturingCrewCommand: (id, command) => manufacturers.submit(id, command),
      getManufacturingCrewCatalog: (id, stationID) => manufacturers.catalog(id, stationID),
    } : {}),
  };
  const bridge = createGatewayAuthorityBridge({ gatewayRuntime: runtime, sendCommand: async () => ({}) });
  if (sellers) Object.assign(runtime, {
    getSellingCrewSnapshot: id => sellers.snapshot(id), submitSellingCrewCommand: (id, command) => sellers.submit(id, command),
    getSellingCrewCatalog: (id, stationID) => sellers.catalog(id, stationID),
  });
  if (buyers) Object.assign(runtime, {
    getBuyingCrewSnapshot:id=>buyers.snapshot(id),submitBuyingCrewCommand:(id,command)=>buyers.submit(id,command),getBuyingCrewCatalog:(id,stationID)=>buyers.catalog(id,stationID),
  });
  if (equipment) Object.assign(runtime, { getCrewEquipmentSnapshot: id => equipment.snapshot(id), submitCrewEquipmentCommand: (id, command) => equipment.submit(id, command) });
  const remote = createRemoteGatewayRuntime({ dependencies: runtime.dependencies,
    requestOwner: async (command, payload) => {
      try {
        const result = await bridge.handleRequest(command, JSON.parse(JSON.stringify(payload)), { generation: 1 });
        return JSON.parse(JSON.stringify(result ?? null));
      } catch (error) { throw deserializeError(JSON.parse(JSON.stringify(serializeError(error)))); }
    },
  });
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  mountEvejsWebGateway(app, { gatewayRuntime: remote.runtime });
  return { app, bridge, remote, async close() { await remote.runtime.shutdown(); await bridge.shutdown(); } };
}
module.exports = { createCrewGatewayHarness };
