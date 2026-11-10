"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore"); const store = createIsolatedGameStore();
const { seedManufacturingStatic, fundManufacturingPilot } = require("./helpers/manufacturingCrewFixture"); seedManufacturingStatic(store);
process.env.EVEJS_WEB_GATEWAY_TOKEN = "manufacturing-test-token";
const test = require("node:test"), assert = require("node:assert/strict");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore"); fundManufacturingPilot(database, items);
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewService } = require("../src/services/crew/crewService");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createManufacturingCrewService } = require("../src/services/crew/manufacturingCrewService");
const { createManufacturingCrewIndustry } = require("../src/services/crew/manufacturingCrewIndustry");
const { createCrewGatewayHarness } = require("./helpers/crewGatewayHarness");
let server, base, clock = 0;
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(require("../src/space/worldData")), character: id => database.read("characters", `/${id}`).data });
courier.submit(90001, { commandID: "create", expectedRevision: 0, type: "create", payload: { name: "Manufacturing gateway" } });
const factory = createManufacturingCrewService({ repo: createTableRepository("service:crew-manufacturing"),
  industry: createManufacturingCrewIndustry({ items, worldData: require("../src/space/worldData"), profitability: require("./helpers/nativeIndustryProfitFixture") }), crew: id => courier.snapshot(id), now: () => clock });
const harness = createCrewGatewayHarness(courier, null, null, factory), uri = "/_evejs-web/v1/crew/manufacturing", identity = "accountID=1&characterID=90001";
const headers = { "x-evejs-web-token": "manufacturing-test-token" };
const post = (command, extra = {}) => fetch(base + uri + "/orders", { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra },
  body: JSON.stringify({ accountID: 1, characterID: 90001, command }) });
test.before(async () => { server = harness.app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await harness.close(); await factory.drain();
  clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle); await new Promise(resolve => setImmediate(resolve));
  await database.shutdown("manufacturing-gateway-tests"); require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });
test("manufacturing APIs retain authorization, origin and strict JSON envelopes", async () => {
  assert.equal((await fetch(base + uri + "?" + identity)).status, 401);
  assert.equal((await fetch(base + uri + "?accountID=2&characterID=90001", { headers })).status, 403);
  assert.equal((await fetch(base + uri + "/catalog?" + identity + "&stationID=invalid", { headers })).status, 400);
  assert.equal((await post({}, { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await post({}, { "content-type": "text/plain" })).status, 403);
  assert.equal((await post({ commandID: 123, expectedRevision: 0, type: "starter", payload: {} })).status, 400);
});
test("starter blueprints, queued native jobs and people cross serialized owner IPC", async () => {
  const starter = { commandID: "starter", expectedRevision: 0, type: "starter", payload: { stationID: 60000001 } };
  let response = await post(starter, { origin: base }); assert.equal(response.status, 200); let data = await response.json();
  assert.equal((await (await post(starter)).json()).replayed, true);
  const catalog = (await (await fetch(base + uri + "/catalog?" + identity + "&stationID=60000001", { headers })).json()).blueprints;
  assert.equal(catalog.length, 2);
  response = await post({ commandID: "start", expectedRevision: data.revision, type: "start", payload: {
    stationID: 60000001, orders: [{ blueprintID: catalog.find(b => b.productTypeID === 21857).blueprintID, runs: 1, targetStock: 1 }] } });
  assert.equal(response.status, 200); data = await response.json(); assert.equal(data.manufacturing.job.phase, "building");
  require("../src/services/industry/industryRuntimeState").markIndustryJobReady(data.manufacturing.job.nativeJobID);
  clock = 1000; assert.deepEqual((await factory.tick()).errors, []);
  const snapshot = await (await fetch(base + uri + "?" + identity, { headers })).json(); assert.equal(snapshot.manufacturing.produced[21857], 1);
  const universe = (await (await fetch(base + "/_evejs-web/v1/crew/universe?" + identity, { headers })).json()).universe;
  assert.equal(universe.actors.length, 4); assert.equal(universe.recentEvents[0].type, "goods_manufactured");
});
