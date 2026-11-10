"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const database = require("../../gameStore");
const schedule = require("./eventSchedule");
const TABLE = "eventLifecycle";
const JOB_TYPE = "events.deadline";
const durableScheduler = require("../_shared/durableSchedulerBinding").createDurableSchedulerBinding({
  message: "Event deadlines require a scheduler.",
});

function read(id) {
  const result = database.read(TABLE, `/${id}`);
  if (!result.success && result.errorMsg !== "ENTRY_NOT_FOUND") throw new Error(`Event lifecycle read failed: ${result.errorMsg}`);
  return result.data || {};
}
function write(id, value) {
  const previous = database.read(TABLE, `/${id}`).data;
  const result = database.write(TABLE, `/${id}`, structuredClone(value));
  if (!result.success) throw new Error(`Event lifecycle write failed: ${result.errorMsg}`);
  const flushed = database.flushTableSync(TABLE);
  if (!flushed.success) {
    if (previous) database.write(TABLE, `/${id}`, previous);
    else database.remove(TABLE, `/${id}`);
    throw new Error(`Event lifecycle flush failed: ${flushed.errorMsg}`);
  }
}

function candidateTotals() {
  const totals = { roden: 0, moreau: 0, tenzin: 0 };
  let participants = 0;
  const rows = database.read("campaignTrailProgress", "/");
  if (!rows.success) throw new Error(`Election tally read failed: ${rows.errorMsg}`);
  for (const progress of Object.values(rows.data || {})) {
    if (progress?.seasonID !== 900128 || !Object.hasOwn(totals, progress.candidateKey)) continue;
    totals[progress.candidateKey] += Math.max(0, Math.min(1500, Number(progress.points) || 0));
    participants++;
  }
  const highest = Math.max(...Object.values(totals));
  const leaders = highest > 0 ? Object.keys(totals).filter(key => totals[key] === highest).sort() : [];
  return { totals, participants, leaders, winner: leaders.length === 1 ? leaders[0] : null,
    outcome: !leaders.length ? "no-votes" : leaders.length === 1 ? "winner" : "tie" };
}

// Called before any progress mutation as well as by the scheduler. This fences
// late claims even if the server was offline at the deadline or dispatch lags.
function concludeIfDue(nowMs = getWallclockNowMs()) {
  const old = read(schedule.ELECTION);
  if (old.conclusion) return old.conclusion;
  const event = schedule.get(schedule.ELECTION);
  if (!event?.enabled || require("../../config").campaignTrailEnabled !== true || nowMs < event.endsAtMs) return null;
  const conclusion = { ...candidateTotals(), endsAtMs: event.endsAtMs,
    traderEndsAtMs: event.traderEndsAtMs, recordedAtMs: nowMs,
    scheduleSnapshot: event,
    policy: "claimed-points-at-deadline; shared-tie; no-votes-no-winner" };
  write(schedule.ELECTION, { ...old, conclusion });
  return conclusion;
}

function revision(event) {
  return require("node:crypto").createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 16);
}
function jobsFor(event) {
  if (!event?.enabled || require("../../config").campaignTrailEnabled !== true) return [];
  if (event.id === schedule.ELECTION) event = read(event.id).conclusion?.scheduleSnapshot || event;
  return [["start", event.startsAtMs], ["end", event.endsAtMs], ["traders-close", event.traderEndsAtMs]]
    .filter(([kind]) => kind !== "traders-close" || event.traderGraceDays > 0)
    .map(([boundary, dueAtMs]) => ({ jobID: `event:${event.id}:${revision(event)}:${boundary}`, type: JOB_TYPE,
      dueAtMs, payload: { eventID: event.id, revision: revision(event), boundary } }));
}
function inspect(nowMs = getWallclockNowMs()) {
  const config = require("../../config");
  return Object.keys(config.eventSchedules || {}).map(id => {
    const event = schedule.get(id), stored = read(id);
    return { ...event, phase: stored.conclusion ? (nowMs < stored.conclusion.traderEndsAtMs ? "trader-grace" : "closed") : schedule.phase(id, nowMs),
      ...stored, ...(id === schedule.ELECTION ? { candidateTotals: stored.conclusion || candidateTotals() } : {}) };
  });
}
function inspectCharacter(characterID) {
  if (!Number.isSafeInteger(characterID) || characterID <= 0) throw new Error("Character ID must be a positive integer.");
  const progress = database.read("campaignTrailProgress", `/${characterID}`).data || null;
  const accountID = progress ? require("../newEdenStore/storeState").resolveCharacterAccountID(characterID) : 0;
  const receipts = accountID ? database.read("newEdenStoreRuntime", `/accounts/${accountID}/campaignTrailRewards`).data || {} : {};
  const claimableMilestones = progress ? require("./campaignTrailCatalog").getRewards(progress)
    .filter(reward => progress.points >= reward.points && !progress.claimedRewards?.[reward.points])
    .map(reward => ({ points: reward.points, typeID: reward.typeID,
      deliveryAlreadyInitiated: Boolean(receipts[`900128:${characterID}:${reward.receiptKey ?? reward.points}`]) })) : [];
  return { characterID, progress, claimableMilestones,
    homefrontPending: database.read("homefrontReplay", `/pending/${characterID}`).data || {},
    fwPending: database.read("fwOpenReplay", `/pending/${characterID}`).data || {} };
}
async function reconcileDurableEventJobs() {
  await require("./eventHooks").recovery.recoverPending();
  concludeIfDue();
  const scheduler = durableScheduler.get();
  if (!scheduler) return { scheduled: 0 };
  const current = typeof scheduler.list === "function" ? await scheduler.list() : [];
  const dead = require("../scheduler/scheduledJobStates").isDeadLetteredJob;
  let scheduled = 0;
  for (const id of Object.keys(require("../../config").eventSchedules || {})) {
    for (const job of jobsFor(schedule.get(id))) {
      if (read(id).deadlines?.[job.jobID]) continue;
      const existing = current.find(row => row.jobID === job.jobID);
      if (!existing || dead(existing)) await scheduler.schedule(job);
      scheduled++;
    }
  }
  return { scheduled };
}
async function handleDurableEventDeadline(job, options = {}) {
  const event = schedule.get(job?.payload?.eventID);
  if (!event) return { stale: true };
  const expected = jobsFor(event).find(row => row.jobID === job.jobID);
  if (!expected || job.payload.revision !== expected.payload.revision) return { stale: true };
  const nowMs = options.nowMs ?? getWallclockNowMs();
  if (nowMs < expected.dueAtMs) throw new Error("Event deadline fired early.");
  concludeIfDue(nowMs);
  const old = read(event.id);
  if (event.id === schedule.ELECTION && job.payload.boundary !== "traders-close") {
    // The captured client's OnSeasonStarted refetches season + progress. Its
    // OnSeasonEnded clears the season outright, hiding retained manual claims.
    for (const session of require("../chat/sessionRegistry").getSessions()) {
      if (!(session.characterID || session.charid)) continue;
      try { session.sendNotification?.("OnSeasonStarted", "charid", []); }
      catch (error) { require("../../utils/logger").warn(`[Events] Presentation refresh deferred until reconnect: ${error.message}`); }
    }
  }
  if (!old.deadlines?.[job.jobID]) write(event.id, { ...old, deadlines: { ...old.deadlines, [job.jobID]: nowMs } });
  return { eventID: event.id, phase: schedule.phase(event.id, nowMs) };
}
module.exports = { TABLE, JOB_TYPE, read, candidateTotals, concludeIfDue, inspect, inspectCharacter, jobsFor,
  // The shared binding owns the scheduler slot; see durableSchedulerBinding.js.
  bindDurableScheduler: durableScheduler.bind, unbindDurableScheduler: durableScheduler.unbind,
  reconcileDurableEventJobs, handleDurableEventDeadline };
