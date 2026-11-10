"use strict";
// Executed only with the caller's attested disposable store environment.
const assert = require("node:assert/strict");
const database = require("../../src/gameStore"), items = require("../../src/services/inventory/itemStore"), wallet = require("../../src/services/account/walletState");
const { createCrewEquipmentPayment } = require("../../src/services/crew/crewEquipmentEconomy");
const { createCrewEquipmentService } = require("../../src/services/crew/crewEquipmentService");
const id = 95001;
(async () => {
  if (process.argv[2] === "interrupt") require("./manufacturingCrewFixture").fundManufacturingPilot(database, items, id, 10000);
  const processWallet = process.argv[2] === "wallet-recover";
  if (processWallet) await require("../../src/services/account/walletCommandAuthority").enableWalletAuthorityProcess();
  const payment = createCrewEquipmentPayment();
  if (process.argv[2] === "interrupt") { const debit = payment.debit; payment.debit = async (...args) => { await debit(...args); throw Error("supplier reply lost after durable debit"); }; }
  const service = createCrewEquipmentService({ repo: require("../../src/gameStore/tableRepository").createTableRepository("service:crew-equipment"), payment, now: () => 1000,
    economy: { funds: () => ({ netSales: 10000, mineralSpent: 0, refiningTax: 0, factoryFees: 0, walletBalance: wallet.getCharacterWallet(id).balance, walletReserve: 1000 }),
      assess: async () => ({ candidates: [{ role: "mining", incrementalProfitPerHour: 1000 }] }) } });
  if (process.argv[2] === "interrupt") await assert.rejects(service.submit(id, { commandID: "recovery-start", expectedRevision: 0, type: "start", payload: { budgetISK: 10000, walletReserve: 1000, workingCapitalISK: 1000, reinvestPercent: 25, maxPaybackHours: 24 } }), /reply lost/);
  else assert.deepEqual((await service.tick()).errors, []);
  const s = service.snapshot(id).equipment;
  if (processWallet) {
    assert.equal((await createCrewEquipmentPayment().debit(id, s.history[0])).duplicate, true);
    const owned = database.readPersisted("walletAuthorityState", `/character:${id}`).data;
    assert.ok(owned.crewEquipmentWalletReceipts["crew-equipment:mining:1"]);
  }
  const result = { balance: wallet.getCharacterWallet(id).balance, tier: s.tiers.mining, spent: s.totalSpent, pending: Boolean(s.job), purchases: s.history.length };
  await service.drain(); if (processWallet) await require("../../src/services/account/walletCommandAuthority").shutdownWalletAuthorityProcess();
  clearInterval(require.cache[require.resolve("../../src/space/runtime")]?.exports?._tickHandle);
  await database.shutdown("equipment-process-recovery"); require("../../src/gameStore/sqliteStore").close(); await require("../../src/utils/rotatingLog").closeAll();
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; });
