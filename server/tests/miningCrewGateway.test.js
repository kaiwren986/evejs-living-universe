"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore");
const store = createIsolatedGameStore();
const { seedMiningStatic, createFiniteScenes } = require("./helpers/miningCrewFixture"); seedMiningStatic(store);
process.env.EVEJS_WEB_GATEWAY_TOKEN = "mining-test-token";
const test = require("node:test"), assert = require("node:assert/strict");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore");
const { seedPilot } = require("./helpers/crewFixture"); seedPilot(database, items);
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewService } = require("../src/services/crew/crewService");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createMiningCrewService } = require("../src/services/crew/miningCrewService");
const { createMiningCrewResources } = require("../src/services/crew/miningCrewResources");
const { createCrewGatewayHarness } = require("./helpers/crewGatewayHarness");
const worldData = require("../src/space/worldData"), scenes = createFiniteScenes(); scenes.add(40001, 1000);
let clock = 0, server, base;
const service = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock, legMs: 1000 });
const miners = createMiningCrewService({ repo: createTableRepository("service:crew-mining"),
  resources: createMiningCrewResources({ worldData, items, sceneForSystem: scenes.sceneForSystem }),
  crew: id => service.snapshot(id), now: () => clock, travelMs: 1000, cycleMs: 1000 });
service.submit(90001, { commandID: "gateway:create", expectedRevision: 0, type: "create", payload: { name: "Mining logistics" } });
const harness = createCrewGatewayHarness(service, miners), uri = "/_evejs-web/v1/crew/mining";
const headers = { "x-evejs-web-token": "mining-test-token" };
const identity = "accountID=1&characterID=90001";
const get = (path, options = {}) => fetch(base + path, options);
const post = (command, extra = {}) => get(uri + "/orders", { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra },
  body: JSON.stringify({ accountID: 1, characterID: 90001, command }) });
test.before(async () => { server = harness.app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await harness.close();
  assert.equal((await database.shutdown("mining-gateway-tests")).success, true); require("../src/gameStore/sqliteStore").close();
  await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });
test("mining endpoints retain token, character scope, JSON and origin protections", async () => {
  assert.equal((await get(uri + "?" + identity)).status, 401);
  assert.equal((await get(uri + "?accountID=2&characterID=90001", { headers })).status, 403);
  assert.equal((await get(uri + "/sites?" + identity + "&homeStationID=garbage", { headers })).status, 400);
  assert.equal((await post({}, { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await post({}, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post({ commandID: 123, type: "start", payload: {}, expectedRevision: 0 })).status, 400);
});
test("ore orders, native deliveries and all four people cross the serialized owner bridge", async () => {
  let result = await get(uri + "/sites?" + identity + "&homeStationID=60000001", { headers });
  assert.equal(result.status, 200); assert.equal((await result.json()).sites[0].ores[0].name, "Veldspar");
  const command = { commandID: "gateway:mine", expectedRevision: 0, type: "start", payload: { homeStationID: 60000001, beltID: 40001, typeID: 1230 } };
  result = await post(command, { origin: base }); assert.equal(result.status, 200); assert.equal((await result.json()).mining.job.phase, "outbound");
  assert.equal((await (await post(command)).json()).replayed, true);
  for (clock = 1000; clock <= 3000; clock += 1000) assert.deepEqual(miners.tick({ budgetMs: 1000 }).errors, []);
  const state = await (await get(uri + "?" + identity, { headers })).json(); assert.equal(state.mining.totalDelivered, 1000);
  assert.equal(items.listContainerItems(90001, 60000001, 4).find(i => i.typeID === 1230).quantity, 1000);
  const universe = (await (await get("/_evejs-web/v1/crew/universe?" + identity, { headers })).json()).universe;
  assert.equal(universe.actors.length, 4); assert.equal(new Set(universe.actors.map(a => a.actorID)).size, 4);
  assert.equal(universe.recentEvents[0].type, "ore_delivered");
});
