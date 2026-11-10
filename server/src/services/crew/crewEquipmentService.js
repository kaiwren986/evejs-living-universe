"use strict";
const { createHash } = require("node:crypto");
const gear = require("./crewEquipmentState");
const { TABLE, ROLES, CATALOG, invalid } = gear;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const money = value => Number.isFinite(value) && value >= 0 && value <= 1e12 && Math.abs(value * 100 - Math.round(value * 100)) < 0.0001;
const round = value => Math.round(value * 100) / 100;
function fail(code, message, status = 409) { const error = Error(message); Object.assign(error, { code, status }); throw error; }
function exact(value, keys) { return value && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join(); }
function validPlan(plan) {
  return plan && typeof plan.enabled === "boolean" && money(plan.budgetISK) && plan.budgetISK > 0 && money(plan.walletReserve) && money(plan.workingCapitalISK) &&
    Number.isSafeInteger(plan.reinvestPercent) && plan.reinvestPercent >= 1 && plan.reinvestPercent <= 50 && Number.isSafeInteger(plan.maxPaybackHours) && plan.maxPaybackHours >= 1 && plan.maxPaybackHours <= 168;
}
function createCrewEquipmentService({ repo, economy, payment, enabled = true, now = Date.now }) {
  let initialized = false, cursor = 0, tickWork = null; const lanes = new Map(), active = new Set();
  function validate(s, id) {
    if (!s || s.version !== 1 || s.ownerID !== id || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !validPlan(s.plan) ||
        !Array.isArray(s.history) || s.history.length > 9 || !s.receipts || Array.isArray(s.receipts) || Object.keys(s.receipts).length > 1024 || !money(s.totalSpent) || !Number.isSafeInteger(s.nextCheckAtMs)) invalid();
    const tiers = gear.tiers(s); let spent = 0;
    for (const role of ROLES) for (let tier = 1; tier <= tiers[role]; tier++) {
      const rows = s.history.filter(row => row.role === role && row.tier === tier && row.cost === CATALOG[role].costs[tier - 1]); if (rows.length !== 1) invalid(); spent += rows[0].cost;
    }
    if (s.history.length !== Object.values(tiers).reduce((a, b) => a + b, 0) || spent !== s.totalSpent) invalid();
    if (s.job && (!ROLES.includes(s.job.role) || s.job.tier !== tiers[s.job.role] + 1 || s.job.tier > 3 || s.job.cost !== CATALOG[s.job.role].costs[s.job.tier - 1] || !money(s.job.minimumBalance))) invalid();
  }
  function check() {
    if (!enabled) fail("CREW_DISABLED", "Crew equipment is disabled.", 503);
    if (!initialized) {
      repo.ensureTable(TABLE); const root = repo.read(TABLE, "/");
      if (!root.success || !root.data || Array.isArray(root.data) || Object.keys(root.data).length > 128) invalid();
      for (const [id, s] of Object.entries(root.data)) { validate(s, Number(id)); if (s.plan.enabled || s.job) active.add(Number(id)); }
      initialized = true;
    }
    if (repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Equipment records are awaiting confirmation.", 503);
  }
  function load(id) { const row = repo.read(TABLE, `/${id}`); if (!row.success) { if (row.errorMsg === "ENTRY_NOT_FOUND") return null; invalid(); } validate(row.data, id); return clone(row.data); }
  function save(s) {
    validate(s, s.ownerID); s.revision++;
    if (repo.write(TABLE, `/${s.ownerID}`, clone(s))?.success !== true || repo.flushTableSync(TABLE)?.success !== true) fail("CREW_STORE_UNAVAILABLE", "Equipment records are awaiting confirmation.", 503);
    if (s.plan.enabled || s.job) active.add(s.ownerID); else active.delete(s.ownerID);
  }
  function run(id, action) { const promise = (lanes.get(id) || Promise.resolve()).catch(() => {}).then(action); lanes.set(id, promise); void promise.finally(() => { if (lanes.get(id) === promise) lanes.delete(id); }).catch(() => {}); return promise; }
  function funds(s) {
    const value = economy.funds(s.ownerID);
    if (![value.netSales, value.mineralSpent, value.refiningTax, value.factoryFees, value.walletBalance, value.walletReserve].every(money)) invalid();
    const operatingProfit = round(Math.max(0, value.netSales - value.mineralSpent - value.refiningTax - value.factoryFees));
    return { ...value, operatingProfit, profitAllowance: round(Math.max(0, Math.floor(operatingProfit * s.plan.reinvestPercent) / 100 - s.totalSpent)),
      budgetRemaining: round(Math.max(0, s.plan.budgetISK - s.totalSpent)) };
  }
  async function progress(s, at) {
    if (!s) return;
    if (!s.job) {
      if (!s.plan.enabled || at < s.nextCheckAtMs) return;
      const assessment = await economy.assess(s.ownerID, clone(s.tiers));
      const funding = funds(s), workingCapital = Math.max(s.plan.workingCapitalISK, assessment.workingCapitalISK || 0);
      const minimumBalance = round(Math.max(s.plan.walletReserve, funding.walletReserve) + workingCapital);
      const allowance = Math.min(funding.profitAllowance, funding.budgetRemaining, round(funding.walletBalance - minimumBalance));
      const candidates = assessment.candidates || [];
      if (candidates.some(row => !ROLES.includes(row.role) || !Number.isFinite(row.incrementalProfitPerHour) || row.incrementalProfitPerHour <= 0)) invalid();
      const ranked = candidates.filter(row => s.tiers[row.role] < 3).map(row => ({ ...row, tier: s.tiers[row.role] + 1, cost: CATALOG[row.role].costs[s.tiers[row.role]] }))
        .map(row => ({ ...row, paybackHours: row.cost / row.incrementalProfitPerHour })).sort((a, b) => a.paybackHours - b.paybackHours || ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
      const choice = !funding.pending && ranked.find(row => row.cost <= allowance && row.paybackHours <= s.plan.maxPaybackHours);
      s.assessment = { checkedAtMs: at, operatingProfit: funding.operatingProfit, allowance: Math.max(0, allowance), workingCapitalISK: workingCapital, candidates: ranked };
      if (!choice) {
        s.status = funding.pending ? "settlement_pending" : !ranked.length ? assessment.status || "waiting_for_useful_work" : ranked.every(row => row.paybackHours > s.plan.maxPaybackHours) ? "payback_too_long" : "saving_for_upgrade";
        s.nextCheckAtMs = at + 10000; save(s); return;
      }
      s.job = { role: choice.role, tier: choice.tier, cost: choice.cost, minimumBalance, paybackHours: choice.paybackHours, acceptedAtMs: at }; s.status = "installing"; save(s);
    }
    const job = s.job, result = await payment.debit(s.ownerID, clone(job));
    if (!result.success) {
      if (!["INSUFFICIENT_FUNDS", "WALLET_RESERVE"].includes(result.errorMsg)) fail("CREW_CUSTODY_PENDING", "Equipment payment is awaiting confirmation.", 503);
      s.job = null; s.status = "wallet_reserve"; s.nextCheckAtMs = at + 10000; save(s); return;
    }
    s.tiers[job.role] = job.tier; s.totalSpent = round(s.totalSpent + job.cost);
    s.history.unshift({ ...job, installedAtMs: at }); s.job = null; s.status = s.plan.enabled ? "ready" : "stopped"; s.nextCheckAtMs = at + 60000; save(s);
  }
  function snapshot(id) {
    if (!enabled) return { enabled: false, revision: 0, equipment: null };
    check(); const s = load(id);
    return { enabled: true, revision: s?.revision || 0, equipment: s ? { ...s, receipts: undefined, funding: funds(s), upgrades: ROLES.map(role => ({ role, ...gear.profile(s, role) })) } : null };
  }
  function submit(id, input) { return run(id, async () => {
    check(); if (!Number.isSafeInteger(id) || id <= 0) fail("CREW_OWNER_INVALID", "Select a valid pilot.", 400);
    if (!exact(input, ["commandID", "expectedRevision", "type", "payload"]) || typeof input.commandID !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.commandID) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !["start", "stop"].includes(input.type) ||
        !exact(input.payload, input.type === "start" ? ["budgetISK", "walletReserve", "workingCapitalISK", "reinvestPercent", "maxPaybackHours"] : []) || (input.type === "start" && !validPlan({ ...input.payload, enabled: true }))) fail("CREW_COMMAND_INVALID", "Choose a valid reinvestment budget, reserve, profit share and payback limit.", 400);
    let s = load(id); const key = hash(input.commandID), fingerprint = hash(JSON.stringify(input));
    if (s?.receipts[key]) { if (s.receipts[key] !== fingerprint) fail("CREW_COMMAND_REUSED", "This order ID describes another policy."); return { ...snapshot(id), replayed: true }; }
    if ((s?.revision || 0) !== input.expectedRevision) fail("CREW_REVISION_CONFLICT", "Equipment changed. Refresh before issuing another order.");
    if (Object.keys(s?.receipts || {}).length >= 1024 - (input.type === "stop" ? 0 : 1)) fail("CREW_COMMAND_CAPACITY", "The equipment order ledger is full.");
    if (!s) { if (Object.keys(repo.read(TABLE, "/").data).length >= 128) fail("CREW_CAPACITY", "The equipment registry is full.", 503); if (input.type !== "start") fail("CREW_NOT_FOUND", "Set a reinvestment policy first.", 404); s = { version: 1, ownerID: id, revision: 0, tiers: Object.fromEntries(ROLES.map(role => [role, 0])), totalSpent: 0, history: [], receipts: {}, job: null, nextCheckAtMs: now(), plan: { ...input.payload, enabled: true }, status: "ready" }; }
    if (input.type === "start") s.plan = { ...input.payload, enabled: true }; else s.plan.enabled = false;
    s.receipts[key] = fingerprint; s.nextCheckAtMs = now(); s.status = s.plan.enabled ? "ready" : "stopped"; save(s); await progress(s, now()); return snapshot(id);
  }); }
  function tick() {
    if (!enabled || tickWork) return Promise.resolve({ processed: 0, errors: [] });
    const promise = (async () => {
      check(); const ids = [...active], errors = []; let processed = 0;
      for (; processed < Math.min(8, ids.length); processed++) {
        const id = ids[(cursor + processed) % ids.length];
        try { await run(id, () => progress(load(id), now())); } catch (error) { errors.push({ ownerID: id, code: error.code || "CREW_RETRY_PENDING" }); }
      }
      cursor = ids.length ? (cursor + processed) % ids.length : 0; return { processed, errors };
    })();
    tickWork = promise; void promise.finally(() => { if (tickWork === promise) tickWork = null; }).catch(() => {}); return promise;
  }
  return { enabled, snapshot, submit, tick, drain: async () => { if (tickWork) await tickWork; await Promise.allSettled([...lanes.values()]); } };
}
module.exports = { createCrewEquipmentService };
