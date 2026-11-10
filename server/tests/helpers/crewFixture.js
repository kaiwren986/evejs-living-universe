"use strict";
function seedStatic(store) {
  store.writeStatic("itemTypes", { types: [{ typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01, published: true }] });
  store.writeStatic("solarSystems", { solarSystems: [1, 2, 3, 99].map((solarSystemID) => ({ solarSystemID, solarSystemName: `System ${solarSystemID}`, security: 0.9 })) });
  store.writeStatic("stations", { stations: [1, 2, 3, 99].map((id) => ({ stationID: 60000000 + id, stationName: `Station ${id}`, solarSystemID: id })) });
  store.writeStatic("stargates", { stargates: [
    { itemID: 11, solarSystemID: 1, destinationSolarSystemID: 2 },
    { itemID: 12, solarSystemID: 2, destinationSolarSystemID: 1 },
    { itemID: 13, solarSystemID: 2, destinationSolarSystemID: 3 },
    { itemID: 14, solarSystemID: 3, destinationSolarSystemID: 2 },
  ] });
  for (const [table, key] of Object.entries({ stationTypes: "stationTypes", stargateTypes: "stargateTypes", celestials: "celestials",
    asteroidBelts: "belts", moonMiningPoints: "points", movementAttributes: "types", shipTypes: "ships", typeDogma: "types" })) store.writeStatic(table, { [key]: [] });
  store.writeStatic("moonMiningPoints", {});
}
function seedPilot(database, items, ownerID = 90001) {
  database.ensureTable("characters"); database.ensureTable("items");
  const written = database.write("characters", `/${ownerID}`, { characterID: ownerID, accountID: 1,
    characterName: "Local test pilot", stationID: 60000001, solarSystemID: 1 });
  if (!written.success) throw new Error(written.errorMsg);
  const granted = items.grantItemToOwnerLocation(ownerID, 60000001, 4,
    { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01 }, 1000);
  if (!granted.success) throw new Error(JSON.stringify(granted));
  if (!database.flushTablesSync(["characters", "items"]).success) throw new Error("Fixture flush failed");
  return granted.data.items[0].itemID;
}
module.exports = { seedStatic, seedPilot };
