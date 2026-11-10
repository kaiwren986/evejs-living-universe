"use strict";
function seedMiningStatic(store) {
  const { seedStatic } = require("./crewFixture"); seedStatic(store);
  store.writeStatic("itemTypes", { types: [
    { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01, published: true },
    { typeID: 1230, name: "Veldspar", groupID: 462, categoryID: 25, volume: 0.1, published: true },
  ] });
  store.writeStatic("asteroidBelts", { belts: Array.from({ length: 20 }, (_, index) => ({ itemID: 40001 + index,
    itemName: `Finite Veldspar belt ${index + 1}`, solarSystemID: 1, typeID: 15, kind: "asteroidBelt" })) });
}
function createFiniteScenes() {
  const mining = require("../../src/services/mining/miningRuntimeState");
  const { createTableRepository } = require("../../src/gameStore/tableRepository");
  const repo = createTableRepository("service:mining");
  const scene = { systemID: 1, staticEntities: [],
    _miningRuntimeState: { byEntityID: new Map(), persistedByEntityID: {} },
    getEntityByID(id) { return this.staticEntities.find(entity => entity.itemID === id); },
    removeStaticEntity(id) { this.staticEntities = this.staticEntities.filter(entity => entity.itemID !== id); },
  };
  function add(beltID, quantity = 2500, typeID = 1230) {
    const entityID = beltID + 100000;
    const persisted = mining.readPersistedSystemEntities(1)[String(entityID)];
    const state = persisted || { version: 1, entityID, visualTypeID: typeID, beltID, fieldStyleID: "fixture",
      yieldTypeID: typeID, yieldKind: "ore", unitVolume: typeID === 1228 ? 0.15 : 0.1, originalQuantity: quantity,
      remainingQuantity: quantity, originalRadius: 100, updatedAtMs: 0 };
    repo.ensureTable("miningRuntimeState");
    if (!persisted && (!mining.writePersistedSystemEntity(1, entityID, state) || !repo.flushTableSync("miningRuntimeState").success)) throw new Error("Finite rock fixture failed");
    scene._miningRuntimeState.byEntityID.set(entityID, structuredClone(state));
    scene._miningRuntimeState.persistedByEntityID[String(entityID)] = structuredClone(state);
    if (state.remainingQuantity > 0) scene.staticEntities.push({ itemID: entityID, beltID, systemID: 1,
      typeID: state.visualTypeID, categoryID: 25, groupID: typeID === 1228 ? 460 : 462, kind: "asteroid", radius: 100 });
    return entityID;
  }
  return { scene, add, sceneForSystem(id) { if (id !== 1) throw new Error("Unknown fixture system"); return scene; } };
}
module.exports = { seedMiningStatic, createFiniteScenes };
