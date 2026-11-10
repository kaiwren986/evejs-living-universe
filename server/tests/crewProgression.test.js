"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const progression = require("../src/services/crew/crewProgression");

test("progression has five bounded levels and increasing experience thresholds", () => {
  for (const [level, xp] of progression.THRESHOLDS.entries()) {
    const state = { progression: { version: 1, xp } }, skill = progression.profile(state, "mining");
    assert.equal(skill.level, level); assert.equal(skill.timeReductionPercent, level * 3);
    assert.equal(progression.duration(60000, state, "mining"), 60000 - level * 1800);
    if (xp) assert.equal(progression.profile({ progression: { version: 1, xp: xp - 1 } }, "mining").level, level - 1);
  }
  const master = { progression: { version: 1, xp: 1500 } };
  assert.equal(progression.award(master, "mining"), 0); assert.equal(progression.profile(master, "mining").nextLevelXP, null);
  assert.equal(progression.duration(1, master, "mining"), 1);
});

test("progression migrates saved work once while ignoring empty courier journeys", () => {
  for (const skill of ["mining", "refining", "manufacturing"])
    assert.equal(progression.profile({ completedDeliveries: 30, completedBatches: 30 }, skill).xp, 300);
  const state = { standingOrder: { orderID: "current", completedDeliveries: 12 }, history: [
    { cargo: { quantity: 1 }, automaticOrderID: "current" }, { cargo: { quantity: 1 }, automaticOrderID: "old" }, { cargo: null },
  ] };
  progression.ensure(state, "hauling"); assert.equal(state.progression.xp, 130);
  state.standingOrder.completedDeliveries = 1000;
  assert.equal(progression.profile(state, "hauling").xp, 130);
  assert.equal(progression.profile({ completedBatches: Number.MAX_SAFE_INTEGER }, "manufacturing").xp, 1500);
});

test("progression rejects damaged XP or forged saved multipliers", () => {
  for (const saved of [null, { version: 2, xp: 0 }, { version: 1, xp: -1 }, { version: 1, xp: 1501 },
    { version: 1, xp: 0.1 }, { version: 1, xp: "100" }, { version: 1, xp: 0, durationBasisPoints: 1 }])
    assert.throws(() => progression.profile({ progression: saved }, "mining"), { code: "CREW_STATE_INVALID" });
});

test("progression profiles do not write to authoritative records", () => {
  const legacy = { completedBatches: 10 }; assert.equal(progression.profile(legacy, "refining").xp, 100);
  assert.equal(legacy.progression, undefined);
  const current = { progression: { version: 1, xp: 90 } }, view = progression.profile(current, "refining");
  view.xp = 1500; view.durationBasisPoints = 1;
  assert.equal(progression.profile(current, "refining").xp, 90);
});

test("trade progression uses bounded ten-percent skill steps without changing work skills", () => {
  for (const role of ["buying", "selling"]) for (const [level, xp] of progression.THRESHOLDS.entries()) {
    const state = { progression: { version: 1, xp } }, skill = progression.profile(state, role);
    assert.equal(skill.timeReductionPercent, level * 10); assert.equal(skill.perLevelReductionPercent, 10);
    assert.equal(progression.duration(10000, state, role), 10000 - level * 1000);
    assert.equal(progression.duration(5000, state, role), 5000 - level * 500);
  }
  assert.equal(progression.profile({ progression: { version: 1, xp: 1500 } }, "manufacturing").timeReductionPercent, 15);
});

test("trade progression credits saved successful trade counters once and caps mastery", () => {
  const seller = { completedSales: 60, completedBatches: 0 }, buyer = { completedPurchases: 1, completedBatches: 900 };
  progression.ensure(seller, "selling"); progression.ensure(buyer, "buying");
  assert.equal(seller.progression.xp, 600); assert.equal(buyer.progression.xp, 10);
  seller.completedSales = 1000; assert.equal(progression.profile(seller, "selling").xp, 600);
  assert.equal(progression.profile({ completedPurchases: Number.MAX_SAFE_INTEGER }, "buying").xp, 1500);
});
