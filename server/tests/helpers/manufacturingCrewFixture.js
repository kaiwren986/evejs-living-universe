"use strict";
function seedManufacturingStatic(store) {
  require("./refiningCrewFixture").seedRefiningStatic(store);
  store.writeStatic("itemTypes", { types: [
    { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01, basePrice: 2, published: true },
    { typeID: 35, name: "Pyerite", groupID: 18, categoryID: 4, volume: 0.01, basePrice: 8, published: true },
    { typeID: 1230, name: "Veldspar", groupID: 462, categoryID: 25, volume: 0.1, portionSize: 100, published: true },
    { typeID: 1228, name: "Scordite", groupID: 460, categoryID: 25, volume: 0.15, portionSize: 100, published: true },
    { typeID: 1130, name: "Iron Charge S Blueprint", groupID: 89, categoryID: 9, volume: 0.01, published: true },
    { typeID: 21858, name: "1MN Civilian Afterburner Blueprint", groupID: 126, categoryID: 9, volume: 0.01, published: true },
    { typeID: 215, name: "Iron Charge S", groupID: 85, categoryID: 8, volume: 0.002, basePrice: 2, published: true },
    { typeID: 21857, name: "1MN Civilian Afterburner", groupID: 46, categoryID: 7, volume: 5, basePrice: 100, published: true },
    { typeID: 3380, name: "Industry", groupID: 268, categoryID: 16, volume: 0.01, published: true },
  ] });
  store.writeStatic("skillTypes", { skills: [{ typeID: 3380, name: "Industry", skillRank: 1, published: true, groupID: 268 }] });
  store.writeStatic("industryBlueprints", { blueprintDefinitions: [
    { blueprintTypeID: 1130, blueprintName: "Iron Charge S Blueprint", productTypeID: 215, productName: "Iron Charge S", productCategoryID: 8,
      maxProductionLimit: 600, published: true, activities: { manufacturing: { time: 2, materials: [{ typeID: 34, quantity: 27 }, { typeID: 35, quantity: 21 }], products: [{ typeID: 215, quantity: 100 }], skills: [{ typeID: 3380, level: 1 }] } } },
    { blueprintTypeID: 21858, blueprintName: "1MN Civilian Afterburner Blueprint", productTypeID: 21857, productName: "1MN Civilian Afterburner", productCategoryID: 7,
      maxProductionLimit: 600, published: true, activities: { manufacturing: { time: 2, materials: [{ typeID: 34, quantity: 67 }], products: [{ typeID: 21857, quantity: 1 }], skills: [{ typeID: 3380, level: 1 }] } } },
  ] });
  store.writeStatic("industryFacilities", { npcFacilityProfiles: [1, 2, 3, 99].map(id => ({ facilityID: 60000000 + id,
    solarSystemID: id, regionID: 1, typeID: 1529, ownerID: 1000035, supportsFactory: id !== 99,
    supportsLaboratory: false, manufacturingFactor: 1 })) });
}
function fundManufacturingPilot(database, items, id = 90001, balance = 100000) {
  for (const table of ["dungeonRuntimeState", "killmails", "mapTelemetry", "missionRuntimeState", "mail"]) { database.ensureTable(table); database.flushTableSync(table); }
  require("./refiningCrewFixture").fundPilot(database, items, id, balance);
  const granted = require("../../src/services/skills/skillState").grantCharacterSkillLevels(id, [{ typeID: 3380, level: 1 }]);
  if (!Array.isArray(granted) || !granted.some(skill => skill.typeID === 3380 && skill.skillLevel === 1)) throw new Error("Industry I fixture failed");
  database.flushTablesSync(["skills", "characters", "items"]);
}
module.exports = { seedManufacturingStatic, fundManufacturingPilot };
