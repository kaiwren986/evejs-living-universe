"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore"); const store = createIsolatedGameStore();
const { seedRefiningStatic, fundPilot } = require("./helpers/refiningCrewFixture"); seedRefiningStatic(store);
process.env.EVEJS_WEB_GATEWAY_TOKEN = "refining-test-token";
const test = require("node:test"), assert = require("node:assert/strict");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore"); fundPilot(database, items);
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewService } = require("../src/services/crew/crewService");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createRefiningCrewService } = require("../src/services/crew/refiningCrewService");
const { createRefiningCrewInventory } = require("../src/services/crew/refiningCrewInventory");
const { createCrewGatewayHarness } = require("./helpers/crewGatewayHarness");
let clock = 0, server, base;
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(require("../src/space/worldData")), character: id => database.read("characters", `/${id}`).data });
courier.submit(90001, { commandID: "create", expectedRevision: 0, type: "create", payload: { name: "Refinery gateway" } });
const refinery = createRefiningCrewService({ repo: createTableRepository("service:crew-refining"),
  inventory: createRefiningCrewInventory({ items, worldData: require("../src/space/worldData") }),
  crew: id => courier.snapshot(id), now: () => clock, cycleMs: 1000 });
items.grantItemToOwnerLocation(90001, 60000001, 4, 1230, 1000);
const harness = createCrewGatewayHarness(courier, null, refinery), uri = "/_evejs-web/v1/crew/refining", identity = "accountID=1&characterID=90001";
const headers = { "x-evejs-web-token": "refining-test-token" };
const post = (command, extra = {}) => fetch(base + uri + "/orders", { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra },
  body: JSON.stringify({ accountID: 1, characterID: 90001, command }) });
test.before(async () => { server = harness.app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await harness.close(); await refinery.drain();
  clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle); await new Promise(resolve => setImmediate(resolve));
  await database.shutdown("refining-gateway-tests"); require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });
test("refining endpoints preserve authorization, origin, JSON and command validation across IPC", async () => {
  assert.equal((await fetch(base + uri + "?" + identity)).status, 401);
  assert.equal((await fetch(base + uri + "?accountID=2&characterID=90001", { headers })).status, 403);
  assert.equal((await fetch(base + uri + "/options?" + identity + "&stationID=garbage", { headers })).status, 400);
  assert.equal((await post({}, { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await post({}, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post({ commandID: 123, expectedRevision: 0, type: "start", payload: {} })).status, 400);
});
test("native quotes, refinery commands and persistent people cross the actual edge-owner protocol", async () => {
  const recipes = await (await fetch(base + uri + "/options?" + identity + "&stationID=60000001", { headers })).json();
  assert.equal(recipes.recipes[0].outputs[0].quantity, 200); assert.equal(recipes.recipes[0].totalCost, 20);
  const command = { commandID: "refine", expectedRevision: 0, type: "start", payload: { stationID: 60000001, typeID: 1230, oreReserve: 0 } };
  let response = await post(command, { origin: base }); assert.equal(response.status, 200); assert.equal((await response.json()).refining.job.phase, "working");
  assert.equal((await (await post(command)).json()).replayed, true);
  clock = 1000; assert.deepEqual((await refinery.tick()).errors, []);
  const state = await (await fetch(base + uri + "?" + identity, { headers })).json(); assert.equal(state.refining.totalOreProcessed, 1000);
  const universe = (await (await fetch(base + "/_evejs-web/v1/crew/universe?" + identity, { headers })).json()).universe;
  assert.equal(universe.actors.length, 4); assert.equal(universe.recentEvents[0].type, "ore_refined");
});
