"use strict";

// Authored New Eden research-program issuance, not scientific remuneration or
// a debit from another player's/corporation's wallet. Monetary activation is
// explicit; retained requests keep their original amount and wallet identity.
const TABLE = "projectDiscoveryState";
const DAY_MS = 86400000;
const MAX_PENDING = 1024;
// Adapted from Locksmith Coffee Edition (AGPL-3.0); authored local reward rules.
// Retained-client constants support the presentation; local sampling and admission
// remain EveJS policy rather than recovered private retail server logic.
// CCP Flow Cytometry reward model:
// covid resultbanner/results pass a sample at PAR 0.5; common iskmultipliers
// pays 500/800/1000 ISK per accuracy percent above 70%/90% (exoplanets
// rewardview reads the accuracy rating, result.player.score); the rating
// tops out at 99% (99,000 ISK, 89 XP per sample); the first ten samples of
// each UTC day pay double XP (gotBonusXP); MAX_TASKS_PER_MINUTE is five.
const PAR = 0.5;
const MAX_ACCURACY = 0.99;
const XP_PER_ACCURACY = 90;
const BONUS_SAMPLES = 10;
const ISK_MULTIPLIERS = Object.freeze([500, 800, 1000]);
const MIN_TASK_MS = 12000;
// Covid leveluprewards CRATES and tiers TIERS (projectdiscovery.common): one
// crate per rank gained, Superior from rank 25 (covid rewards
// get_loot_crate_type), plus the tier item at each milestone rank. Apparel is
// [female, male] by genderID; the client's rank-125 tuple lists the men's coat
// first, corrected here. The three blueprints are CCP's 1-run copies.
const RANK_CRATE = 55358;
const SUPERIOR_RANK_CRATE = 55359;
const SUPERIOR_FROM_RANK = 25;
const TIERS = Object.freeze({5:[54714,54830],10:[54949,54948],25:[54944,54943],50:[45486],75:[55295],
  100:[40458,40462],125:[40460,40464],150:[45487],175:[55296],200:[55627,55636],250:[54965,54966],
  350:[54927,54926],500:[45528],650:[55294]});
const BLUEPRINT_COPIES = new Set([45486,45487,45528]);
const RANK_REWARD_BATCH = 25;
const fail = code => { throw Error(`DISCOVERY_${code}`); };
const clone = value => structuredClone(value);
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
function policy(env = process.env, {classificationOnly = false} = {}) {
  const enabled = env.EVEJS_DISCOVERY_REWARDS === "1";
  // XP admission does not consume money settings while issuance is disabled.
  // Settlement callers retain strict monetary validation, including old grants.
  const monetary = !classificationOnly || enabled;
  const setting = (name, fallback, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!integer(value) || value > max) fail("REWARD_CONFIG_INVALID");
    return value;
  };
  // Per-sample ISK is CCP's accuracy formula, not a setting. The program cap
  // is a server safety valve; the task cap is CCP's daily sample limit, here
  // bounded by the 64 authored plots (each may pay once per character/day,
  // because a submission reveals that plot's solution).
  return { enabled,
    globalCents: monetary ? setting("EVEJS_DISCOVERY_DAILY_ISK_CAP", 100000000, 100000000) * 100 : 0,
    taskCap: setting("EVEJS_DISCOVERY_DAILY_TASK_CAP", 64, 64) };
}
// Preserve EveJS's local rank curve; rankFor is its exact inverse. This curve
// is not a claim about the private retail rank progression captured in logs.
function totalNeededXp(rank) { return (rank - 1) * rank * 50; }
function rankFor(experience) {
  let rank = Math.max(1, Math.floor((1 + Math.sqrt(1 + experience / 12.5)) / 2));
  while (totalNeededXp(rank + 1) <= experience) rank += 1;
  while (rank > 1 && totalNeededXp(rank) > experience) rank -= 1;
  return rank;
}
function accuracyRating(state) {
  const count = state.classificationCount, total = state.classificationScoreTotal;
  if (!integer(count, 1) || typeof total !== "number" || !Number.isFinite(total) || total < 0) return 0;
  return Math.min(MAX_ACCURACY, total / count);
}
function iskForAccuracy(accuracy) {
  const percent = Math.round(Math.min(MAX_ACCURACY, Math.max(0, accuracy)) * 10000) / 100;
  const multiplier = percent > 90 ? ISK_MULTIPLIERS[2] : percent > 70 ? ISK_MULTIPLIERS[1] : ISK_MULTIPLIERS[0];
  return Math.round(percent * multiplier);
}
function rewardedToday(state, now = Date.now()) {
  const previous = state?.rewardDay, day = Math.floor(now / DAY_MS);
  return previous?.day === day && Array.isArray(previous.keys) ? previous.keys.length : 0;
}
function remainingBonusSamples(state, now = Date.now()) {
  return Math.max(0, BONUS_SAMPLES - rewardedToday(state, now));
}
// Call after the submission's own score is in classificationCount/scoreTotal.
function classify(state, task, score, skipped, now = Date.now(), env = process.env) {
  const reward = {version:1, xp:0, isk:0, status:"none"};
  if (skipped || task.tutorial || !(score >= PAR) || task.rewardPolicy !== 1 ||
      !integer(task.issuedAtMs, 1) || now - task.issuedAtMs < MIN_TASK_MS) return reward;
  const p = policy(env, {classificationOnly:true}), day = Math.floor(now / DAY_MS);
  const previous = state.rewardDay;
  if (previous && (!integer(previous.day) || !Array.isArray(previous.keys) ||
      previous.keys.length > 64 || new Set(previous.keys).size !== previous.keys.length ||
      previous.keys.some(key => typeof key !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(key)))) fail("REWARD_STATE_INVALID");
  if (previous && previous.day > day) return reward; // clock rollback cannot reset a budget
  const keys = previous?.day === day ? previous.keys.slice() : [];
  if (keys.length >= p.taskCap || keys.includes(task.key)) return reward;
  const accuracy = accuracyRating(state), bonus = keys.length < BONUS_SAMPLES;
  const xp = Math.floor(XP_PER_ACCURACY * accuracy) * (bonus ? 2 : 1);
  if (!integer(state.experience) || !integer(state.experience + xp)) fail("REWARD_STATE_INVALID");
  keys.push(task.key);
  state.rewardDay = {day, keys};
  const previousRank = rankFor(state.experience);
  state.experience += xp;
  state.rank = rankFor(state.experience);
  if (state.rank > previousRank) reward.rankUp = [previousRank, state.rank];
  reward.xp = xp;
  reward.bonus = bonus;
  reward.bonusAfter = Math.max(0, BONUS_SAMPLES - keys.length);
  const amountCents = iskForAccuracy(accuracy) * 100;
  if (p.enabled && amountCents > 0 && p.globalCents > 0) {
    Object.assign(reward, {status:"prepared", amountCents,
      commandID:`discovery:v1:${task.id}`, sequence:state.sequence});
  }
  return reward;
}
function isPending(state) {
  return state?.last?.reward?.version === 1 &&
    ["prepared", "paid", "refused"].includes(state.last.reward.status);
}
function createRewards(ports) {
  const {store, characters, wallet} = ports;
  const now = () => (ports.now || Date.now)();
  const env = () => ports.env || process.env;
  const flush = table => { if (store.flushTablesSync([table])?.success !== true) fail("REWARD_PERSIST_PENDING"); };
  function character(characterID) {
    // A failed previous checkpoint may have updated owner RAM. It is never
    // permission to acknowledge a wallet receipt until this barrier succeeds.
    flush("characters");
    const record = characters.getCharacterRecord(characterID);
    if (!record?.projectDiscovery) fail("REWARD_CHARACTER_MISSING");
    return clone(record.projectDiscovery);
  }
  function update(characterID, taskID, commandID, apply) {
    const result = characters.updateCharacterRecord(characterID, record => {
      const state = clone(record.projectDiscovery);
      if (state?.last?.task?.id !== taskID || state.last.reward?.commandID !== commandID)
        fail("REWARD_BINDING_CHANGED");
      apply(state.last.reward);
      return {...record, projectDiscovery:state};
    });
    if (result?.success !== true) fail("REWARD_SAVE_PENDING");
    flush("characters");
  }
  function program() {
    store.ensureTable(TABLE);
    flush(TABLE);
    const result = store.read(TABLE, "/program");
    if (!result?.success) {
      if (result?.errorMsg !== "ENTRY_NOT_FOUND") fail("REWARD_BUDGET_READ_FAILED");
      return {version:1, day:Math.floor(now()/DAY_MS), paidCents:0,
        lifetimeIssuedCents:"0", lifetimePayments:0, pending:{}};
    }
    const value = clone(result.data);
    if (value?.version !== 1 || !integer(value.day) || !integer(value.paidCents) ||
        !integer(value.lifetimePayments) || !/^(0|[1-9][0-9]*)$/.test(value.lifetimeIssuedCents) ||
        !value.pending || Object.getPrototypeOf(value.pending) !== Object.prototype || Object.keys(value.pending).length > MAX_PENDING)
      fail("REWARD_BUDGET_INVALID");
    const day = Math.floor(now()/DAY_MS);
    if (day < value.day) fail("REWARD_CLOCK_REVERSED");
    if (day > value.day) { value.day = day; value.paidCents = 0; }
    return value;
  }
  function persist(value) {
    if (store.write(TABLE,"/program",value,{force:true})?.success !== true) fail("REWARD_BUDGET_WRITE_PENDING");
    flush(TABLE);
  }
  function binding(row, characterID, taskID, reward) {
    if (!row || row.characterID !== characterID || row.taskID !== taskID ||
        row.commandID !== reward.commandID || row.amountCents !== reward.amountCents)
      fail("REWARD_BINDING_CHANGED");
  }
  function reserve(characterID, taskID, reward) {
    const value = program(), old = value.pending[taskID];
    if (old) { binding(old, characterID, taskID, reward); persist(value); return true; }
    let reserved = 0;
    for (const row of Object.values(value.pending)) {
      if (!integer(row.amountCents,1) || row.amountCents > 10000000 || !["reserved","paid","refused"].includes(row.status))
        fail("REWARD_BUDGET_INVALID");
      // Every unresolved payment remains a liability across midnight. A lost
      // reply cannot free yesterday's grant into today's unreserved issuance.
      if (row.status === "reserved") reserved += row.amountCents;
    }
    if (Object.keys(value.pending).length >= MAX_PENDING ||
        value.paidCents + reserved + reward.amountCents > policy(env()).globalCents) return false;
    value.pending[taskID] = {characterID,taskID,commandID:reward.commandID,
      amountCents:reward.amountCents,status:"reserved"};
    persist(value);
    return true;
  }
  function outcome(characterID, taskID, reward, payment) {
    const value = program(), row = value.pending[taskID];
    binding(row,characterID,taskID,reward);
    if (row.status === "reserved") {
      row.status = payment ? "paid" : "refused";
      if (payment) {
        row.payment = payment;
        if (payment.day === value.day) value.paidCents += reward.amountCents;
        value.lifetimeIssuedCents = String(BigInt(value.lifetimeIssuedCents) + BigInt(reward.amountCents));
        value.lifetimePayments += 1;
      }
    } else if (row.status !== (payment ? "paid" : "refused") ||
        JSON.stringify(row.payment || null) !== JSON.stringify(payment || null)) fail("REWARD_OUTCOME_CHANGED");
    persist(value);
  }
  async function settle(characterID) {
    let state = character(characterID);
    if (!isPending(state)) return state;
    const taskID = state.last.task.id;
    let reward = state.last.reward;
    if (!integer(reward.amountCents,1) || reward.amountCents > 10000000 || !integer(reward.sequence,1) ||
        reward.commandID !== `discovery:v1:${taskID}` ||
        taskID !== `evejs-pd-v1-${characterID}-${reward.sequence}`) fail("REWARD_BINDING_CHANGED");
    if (reward.status === "prepared") {
      if (!reserve(characterID, taskID, reward)) {
        update(characterID,taskID,reward.commandID,r=>{r.status="complete";r.reason="daily_program_limit";});
        return character(characterID);
      }
      let result;
      try { result = await wallet.adjustCharacterBalanceAsync(characterID,reward.amountCents/100,{
        idempotencyKey:reward.commandID,requireExactCredit:true,
        // Retained appConst.refProjectDiscoveryReward = 125.
        entryTypeID:125,ownerID1:characterID,ownerID2:0,referenceID:reward.sequence,
        accountKey:1000,currency:1,description:`New Eden research grant ${taskID}`,
        economicActivity:{operating_revenue:String(reward.amountCents)},
      },{commandID:reward.commandID,idempotencyKey:reward.commandID,
        source:"project-discovery-research-program"});
      } catch (_) { fail("REWARD_PAYMENT_PENDING"); }
      state = character(characterID); // do not retain a stale character across IPC
      if (state.last?.task?.id !== taskID || state.last.reward?.commandID !== reward.commandID)
        fail("REWARD_BINDING_CHANGED");
      if (result?.fingerprintMismatch === true) fail("REWARD_RECEIPT_CONFLICT");
      if (result?.success === true) {
        if (Number(result.journalEntry?.ownerID1) !== characterID ||
            Number(result.journalEntry?.ownerID2) !== 0 || Number(result.journalEntry?.entryTypeID) !== 125 ||
            Number(result.journalEntry?.referenceID) !== reward.sequence ||
            Number(result.journalEntry?.accountKey) !== 1000 || Number(result.journalEntry?.currency) !== 1 ||
            Math.round(Number(result.journalEntry?.amount)*100) !== reward.amountCents) fail("REWARD_CREDIT_MISMATCH");
        if (Math.round(Number(result.delta)*100) !== reward.amountCents ||
            !integer(Number(result.journalEntry?.transactionID),1)) fail("REWARD_CREDIT_MISMATCH");
        let paidAtMs;
        try { paidAtMs = Number((BigInt(result.journalEntry.transactionDate)-116444736000000000n)/10000n); }
        catch (_) { fail("REWARD_CREDIT_MISMATCH"); }
        if (!integer(paidAtMs,1) || paidAtMs > now()) fail("REWARD_CREDIT_MISMATCH");
        const payment={transactionID:result.journalEntry.transactionID,day:Math.floor(paidAtMs/DAY_MS)};
        outcome(characterID,taskID,reward,payment);
        update(characterID,taskID,reward.commandID,r=>{r.status="paid";r.isk=r.amountCents/100;r.payment=payment;});
      } else if (["WALLET_LIMIT", "DISCOVERY_WALLET_RECEIPT_LIMIT"].includes(result?.errorMsg)) {
        outcome(characterID,taskID,reward,null);
        update(characterID,taskID,reward.commandID,r=>{r.status="refused";r.reason=result.errorMsg.toLowerCase();});
      } else fail("REWARD_PAYMENT_PENDING");
      state = character(characterID);
      reward = state.last.reward;
    }
    // The current wallet keeps discovery: economic receipts permanently. The
    // prepared intent and exact amount survive an ambiguous wallet reply; replay
    // remains safe even after the process command receipt is evicted. A durable
    // paid/refused marker precedes budget cleanup, so a crash cannot book twice.
    update(characterID,taskID,reward.commandID,()=>{});
    const value = program(), row = value.pending[taskID];
    if (row) {
      binding(row,characterID,taskID,reward);
      if (!["paid","refused"].includes(row.status)) fail("REWARD_OUTCOME_CHANGED");
      delete value.pending[taskID]; persist(value);
    }
    update(characterID,taskID,reward.commandID,r=>{r.status="complete";});
    return character(characterID);
  }
  return {settle};
}
function rankGrants(rank, genderID) {
  const grants = [{typeID:rank < SUPERIOR_FROM_RANK ? RANK_CRATE : SUPERIOR_RANK_CRATE}];
  const tier = TIERS[rank];
  if (tier) {
    const typeID = tier.length === 1 ? tier[0] : tier[genderID === 0 ? 0 : 1];
    grants.push(BLUEPRINT_COPIES.has(typeID) ? {typeID, blueprintRuns:1} : {typeID});
  }
  return grants;
}
// Crate type IDs and the milestone rank a submission's rank-up earned, for
// its saved reply (the covid client derives its own display from the rank).
function rankUpView(reward) {
  const [from, to] = Array.isArray(reward?.rankUp) ? reward.rankUp : [0, 0];
  const crates = [];
  let tier = null;
  for (let rank = from + 1; rank <= to && crates.length < RANK_REWARD_BATCH; rank++) {
    crates.push(rank < SUPERIOR_FROM_RANK ? RANK_CRATE : SUPERIOR_RANK_CRATE);
    if (TIERS[rank]) tier = rank;
  }
  return {crates, tier};
}
function createRankRewards({characters, tokens, store, log}) {
  const flush = () => { if (store.flushTablesSync(["characters"])?.success !== true) fail("REWARD_PERSIST_PENDING"); };
  // Delivers every rank above rankRewardedThrough, oldest first, to the
  // redeem queue. Each item has its own permanent receipt keyed by character,
  // rank and type, so a retry after any failure or replay never mints twice;
  // the marker advances only after all of that rank's tokens commit.
  function settle(characterID) {
    // A previous marker write may still be in owner RAM after a failed flush.
    // Reassert its durability even when no ranks appear outstanding in RAM.
    flush();
    const record = characters.getCharacterRecord(characterID);
    const state = record?.projectDiscovery;
    if (!state || !integer(state.experience)) return [];
    const target = Math.min(integer(state.rank, 1) ? state.rank : 1, rankFor(state.experience));
    const through = integer(state.rankRewardedThrough, 1) ? state.rankRewardedThrough : 1;
    const genderID = Number(record.gender) === 0 ? 0 : 1, granted = [];
    for (let rank = through + 1; rank <= Math.min(target, through + RANK_REWARD_BATCH); rank++) {
      for (const grant of rankGrants(rank, genderID)) {
        try {
          tokens.grantOnce(characterID, {...grant, quantity:1,
            receiptKey:`discovery:v1:${characterID}:rank:${rank}:${grant.typeID}`,
            label:`Project Discovery analyst rank ${rank}`,
            description:`New Eden research program reward for reaching analyst rank ${rank}.`});
        } catch (error) {
          log?.warn?.(`[ProjectDiscovery] rank ${rank} reward for ${characterID} pending: ${error?.message || error}`);
          fail("REWARD_RANK_PENDING");
        }
        granted.push({rank, ...grant});
      }
      const result = characters.updateCharacterRecord(characterID, current => ({...current,
        projectDiscovery:{...current.projectDiscovery,
          rankRewardedThrough:Math.max(rank, current.projectDiscovery?.rankRewardedThrough || 1)}}));
      if (result?.success !== true) fail("REWARD_SAVE_PENDING");
      flush();
    }
    return granted;
  }
  return {settle};
}
let nativeRank;
function getNativeRankRewards() {
  if (!nativeRank) nativeRank = createRankRewards({characters:require("./characterState"),
    tokens:require("../newEdenStore/rewardRedeemTokens"),store:require("../../gameStore"),
    log:require("../../utils/logger")});
  return nativeRank;
}
let native;
function getNative() {
  if (!native) native = createRewards({store:require("../../gameStore"),
    characters:require("./characterState"),wallet:require("../account/walletState")});
  return native;
}
module.exports = {classify,isPending,policy,createRewards,getNative,totalNeededXp,rankFor,
  accuracyRating,iskForAccuracy,remainingBonusSamples,rankGrants,rankUpView,createRankRewards,getNativeRankRewards,
  constants:{PAR,MAX_ACCURACY,XP_PER_ACCURACY,BONUS_SAMPLES,ISK_MULTIPLIERS,MIN_TASK_MS,
    RANK_CRATE,SUPERIOR_RANK_CRATE,SUPERIOR_FROM_RANK,TIERS}};
