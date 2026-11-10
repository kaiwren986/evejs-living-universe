"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore");
const store = createIsolatedGameStore();
const { seedStatic, seedPilot } = require("./helpers/crewFixture");
seedStatic(store);
const test = require("node:test");
const assert = require("node:assert/strict");
const database = require("../src/gameStore");
const items = require("../src/services/inventory/itemStore");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewService, CrewError } = require("../src/services/crew/crewService");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createCrewGatewayHarness } = require("./helpers/crewGatewayHarness");
const cargoID = seedPilot(database, items);
let atMs = 1000, server, base, failReservation = false;
const inventory = createCrewInventory({ items });
const service = createCrewService({ repo: createTableRepository("service:crew"), inventory: { ...inventory, move(...args) {
  const result = inventory.move(...args);
  if (failReservation && args[2] === "reserve") { failReservation = false; throw new CrewError("CREW_CUSTODY_PENDING", "Retry cargo confirmation.", 503); }
  return result;
} },
  planning: {courier: async()=>({status:"stock_target_met",choice:null,priority:null})},
  world: createCrewWorld(require("../src/space/worldData")), character: (id) => database.read("characters", `/${id}`).data, legMs: 1000, now: () => atMs });
const harness = createCrewGatewayHarness(service);
const previousToken = process.env.EVEJS_WEB_GATEWAY_TOKEN;
process.env.EVEJS_WEB_GATEWAY_TOKEN = "crew-test-token";
test.before(async () => {
  server = harness.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await harness.close();
  assert.equal((await database.shutdown("crew-gateway-tests")).success, true);
  require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup();
  if (previousToken === undefined) delete process.env.EVEJS_WEB_GATEWAY_TOKEN; else process.env.EVEJS_WEB_GATEWAY_TOKEN = previousToken;
});
const get = (url, options = {}) => fetch(base + url, { signal: AbortSignal.timeout(5000), ...options });
const headers = { "x-evejs-web-token": "crew-test-token", "content-type": "application/json" };
const uri = "/_evejs-web/v1/crew";
const post = (command, additions = {}) => get(uri + "/orders", { method: "POST", headers: { ...headers, ...additions },
  body: JSON.stringify({ accountID: 1, characterID: 90001, command }) });

test("X-Command serves local assets with a restrictive content policy", async () => {
  const page = await get("/x-command"); assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await page.text(), /Establish your founding crew/);
  for (const asset of ["app.js", "style.css"]) assert.equal((await get(`/x-command/${asset}`)).status, 200);
});
test("gateway requires its token and a matching account/character pair", async () => {
  assert.equal((await get(uri + "?accountID=1&characterID=90001")).status, 401);
  assert.equal((await get(uri + "?accountID=2&characterID=90001", { headers })).status, 403);
  assert.equal((await get(uri + "?accountID=1&characterID=99999", { headers })).status, 404);
  assert.equal((await get(uri + "?characterID=90001", { headers })).status, 400);
});
test("mutating orders refuse cross-origin and non-JSON submissions", async () => {
  const command = { commandID: "gateway:create", expectedRevision: 0, type: "create", payload: { name: "Gateway crew" } };
  assert.equal((await post(command, { origin: "https://elsewhere.invalid" })).status, 403);
  assert.equal((await post(command, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(command, { "content-type": "text/plain" })).status, 403);
  assert.equal(service.snapshot(90001).crew, null);
});
test("invalid orders preserve their 400 status across serialized IPC errors", async () => {
  assert.equal((await post({ commandID: 123, expectedRevision: 0, type: "create", payload: { name: "Invalid" } })).status, 400);
});
test("orders cross the owner bridge and deliver native cargo while the pilot is online", async () => {
  const command = { commandID: "gateway:create", expectedRevision: 0, type: "create", payload: { name: "Gateway crew" } };
  let response = await post(command, { origin: base }); assert.equal(response.status, 200);
  let data = await response.json(); assert.equal(data.crew.name, "Gateway crew");
  response = await get(uri + "/stations?accountID=1&characterID=90001&q=Station", { headers });
  assert.equal((await response.json()).stations.length, 4);
  const delivery = { commandID: "gateway:delivery", expectedRevision: data.revision, type: "deliver",
    payload: { destinationStationID: 60000003, itemID: cargoID } };
  failReservation = true;
  response = await post(delivery); assert.equal(response.status, 503);
  response = await post(delivery); assert.equal(response.status, 200); assert.equal((await response.json()).crew.job.phase, "travelling");
  assert.equal((await (await post(delivery)).json()).replayed, true);
  atMs = 5000; assert.equal(service.tick({ budgetMs: 1000 }).errors.length, 0);
  data = await (await get(uri + "?accountID=1&characterID=90001", { headers })).json();
  assert.equal(data.crew.job, null); assert.equal(data.history.length, 1);
  assert.equal(items.findItemById(cargoID).locationID, 60000003);
});
test("universe observation and standing orders cross the same authorized owner bridge", async () => {
  assert.equal((await get(uri + "/universe?accountID=2&characterID=90001", { headers })).status, 403);
  const response = await get(uri + "/universe?accountID=1&characterID=90001", { headers });
  const facts = (await response.json()).universe;
  assert.equal(facts.actors.length, 2);
  assert.ok(facts.recentEvents.some((event) => event.type === "cargo_delivered"));
  const current = service.snapshot(90001);
  const order = { commandID: "gateway:standing", expectedRevision: current.revision, type: "automate",
    payload: { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 34, sourceReserve: 0 } };
  assert.equal((await post(order)).status, 200);
  assert.equal(service.snapshot(90001).crew.standingOrder.enabled, true);
  assert.equal((await post(order)).status, 200);
});

test("courier priority controls retain token, ownership, origin, revision and strict payload protections",async()=>{
  const current=service.snapshot(90001),command={commandID:"gateway:courier-priority",expectedRevision:current.revision,type:"prioritize",payload:{enabled:true}};
  assert.equal((await get(uri+"/orders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountID:1,characterID:90001,command})})).status,401);
  assert.equal((await get(uri+"/orders",{method:"POST",headers,body:JSON.stringify({accountID:2,characterID:90001,command})})).status,403);
  assert.equal((await post(command,{origin:"https://elsewhere.invalid"})).status,403);
  assert.equal((await post({...command,payload:{enabled:"true"}})).status,400);
  assert.equal((await post({...command,expectedRevision:0})).status,409);
  const result=await post(command,{origin:base});assert.equal(result.status,200);assert.equal((await result.json()).crew.standingOrder.followProduction,true);
  assert.equal((await post(command)).status,200);assert.equal((await post({...command,payload:{enabled:false}})).status,409);
});
