"use strict";
function seedRefiningStatic(store) {
  require("./miningCrewFixture").seedMiningStatic(store);
  store.writeStatic("itemTypes", { types: [
    { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01, basePrice: 2, published: true },
    { typeID: 35, name: "Pyerite", groupID: 18, categoryID: 4, volume: 0.01, basePrice: 8, published: true },
    { typeID: 1230, name: "Veldspar", groupID: 462, categoryID: 25, volume: 0.1, portionSize: 100, published: true },
    { typeID: 1228, name: "Scordite", groupID: 460, categoryID: 25, volume: 0.15, portionSize: 100, published: true },
  ] });
  store.writeStatic("stations", { stations: [1, 2, 3, 99].map(id => ({ stationID: 60000000 + id,
    stationName: `Station ${id}`, solarSystemID: id, reprocessingEfficiency: id === 99 ? 0 : 0.5,
    reprocessingStationsTake: 0.05, corporationID: 0 })) });
  store.writeStatic("reprocessingStatic", { reprocessingTypes: [
    { typeID: 1230, name: "Veldspar", groupID: 462, categoryID: 25, reprocessingFamily: "ore", portionSize: 100,
      isRefinable: true, materials: [{ materialTypeID: 34, quantity: 400 }] },
    { typeID: 1228, name: "Scordite", groupID: 460, categoryID: 25, reprocessingFamily: "ore", portionSize: 100,
      isRefinable: true, materials: [{ materialTypeID: 34, quantity: 150 }, { materialTypeID: 35, quantity: 90 }] },
  ] });
  store.writeStatic("reprocessingClientRandomizedMaterials", { types: [] });
}
function fundPilot(database, items, id = 90001, balance = 100000) {
  require("./crewFixture").seedPilot(database, items, id);
  const record = database.read("characters", `/${id}`).data;
  database.write("characters", `/${id}`, { ...record, balance });
  if (!database.flushTableSync("characters").success) throw new Error("Pilot balance fixture failed");
}
module.exports = { seedRefiningStatic, fundPilot };
