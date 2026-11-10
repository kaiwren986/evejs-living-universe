"use strict";

const { randomBytes } = require("node:crypto");
const state = require("./shipSkinState");
const drafts = require("./shipSkinDraftRuntime");
const components = require("./shipSkinComponentRuntime");
const authority = require("./shipSkinComponentAuthority");
const { getShipSkinSequencingPolicy, getShipSkinSequencingTerms } = require("./shipSkinSequencingAuthority");
const { getCharacterShipSkinLimits } = require("./shipSkinSkillPolicy");
const rights = require("./shipSkinThirdPartyRuntime");
const inventory = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const wallet = require("../account/walletState");
const { PLEX_LOG_CATEGORY } = require("../account/plexVaultLogState");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const TABLE_NAME = "shipSkinSequencingRuntime", JOB_TYPE = "skinr.sequencing";
const binding = createDurableSchedulerBinding(), locks = new Map();
let noticeSink = null;
let nowProvider = null;
function getNow() { return nowProvider ? nowProvider() : Date.now(); }
function root() { return { version: 1, nextEscrow: 0, jobs: {}, requests: {}, ...state.read(TABLE_NAME) }; }
function getJob(id) { return root().jobs[id] || null; }
function ownedJob(actor, id) { const job = getJob(id); return job?.characterID === actor ? job : null; }
function change(id, patch) { const next = root(); Object.assign(next.jobs[id], patch); state.write(TABLE_NAME, next); return next.jobs[id]; }
function locked(id, callback) {
  const prior = locks.get(id) || Promise.resolve();
  const current = prior.catch(() => {}).then(callback);
  locks.set(id, current);
  return current.finally(() => { if (locks.get(id) === current) locks.delete(id); });
}
function notify(kind, job) { try { noticeSink?.(kind, job); } catch (_error) { /* A committed result remains queryable after notice delivery fails. */ } }
async function schedule(job) {
  if (!binding.get() || ["completed", "refused"].includes(job.state)) return;
  const lane = job.completionMode === "early" ? `early:${job.early.requestID}` : job.state === "running" ? "complete" : "install";
  await binding.get().schedule({ jobID: `skinr:${job.id}:${lane}`, type: JOB_TYPE,
    dueAtMs: lane === "complete" ? job.plannedCompletionMs : getNow(), payload: { id: job.id } });
}
function prepareResources(actor, layout, kinds, quantity) {
  const counts = new Map(), selected = new Map();
  for (const slot of layout.slots) {
    const id = slot.configuration.coating?.coating.sequential || slot.configuration.pattern.pattern.sequential;
    counts.set(id, (counts.get(id) || 0) + quantity);
  }
  for (const kind of kinds || []) {
    const component = authority.resolveComponentIdentifier(kind.component);
    if (!component || Boolean(kind.infinite) === Boolean(Number(kind.finite))) return state.fail("COMPONENT_LICENSES_UNAVAILABLE");
    const selection = selected.get(component.componentID) || {};
    const licenseType = kind.infinite ? "infinite" : "finite";
    if (selection[licenseType] || !counts.has(component.componentID)) return state.fail("COMPONENT_LICENSES_UNAVAILABLE");
    selection[licenseType] = kind;
    selected.set(component.componentID, selection);
  }
  if (counts.size !== selected.size) return state.fail("COMPONENT_LICENSES_UNAVAILABLE");
  const requests = [], required = {};
  for (const [componentID, count] of counts) {
    const selection = selected.get(componentID), component = authority.getShipSkinComponent(componentID);
    if (!selection) return state.fail("COMPONENT_LICENSES_UNAVAILABLE");
    const finite = Number(selection.finite?.finite || 0), infinite = count - finite;
    // The native editor chooses rights per slot, then groups by component and
    // license type. A reused component can consume both finite and infinite
    // rights, with binders required only for the remaining infinite uses.
    if (finite > count || finite % quantity || (selection.infinite ? infinite <= 0 : infinite !== 0)) return state.fail("COMPONENT_LICENSES_UNAVAILABLE");
    if ((finite && (components.getFiniteShipSkinComponentLicense(actor, componentID)?.capacity || 0) < finite) ||
      (infinite && !components.getInfiniteShipSkinComponentLicense(actor, componentID))) return state.fail("COMPONENT_LICENSES_INSUFFICIENT");
    if (finite) requests.push({ componentID, quantity: finite, licenseType: "finite" });
    if (infinite) {
      requests.push({ componentID, quantity: 1, licenseType: "infinite" });
      const binder = component.sequenceBinder;
      if (!state.positive(binder?.typeID) || !state.positive(binder?.count)) return state.fail("SKINR_BINDER_POLICY_MISSING", 503);
      required[binder.typeID] = (required[binder.typeID] || 0) + binder.count * infinite;
    }
  }
  const character = require("../character/characterState").getCharacterRecord(actor);
  const location = Number(character?.stationID || character?.structureID || character?.activeShipID);
  const items = inventory.listOwnedItems(actor).filter(item => Number(item.locationID) === location && [4, 5].includes(Number(item.flagID))).sort((a, b) => a.itemID - b.itemID);
  const binders = [];
  for (const [typeID, total] of Object.entries(required)) {
    let remaining = total;
    for (const item of items.filter(item => Number(item.typeID) === Number(typeID))) {
      const quantity = Math.min(remaining, Number(item.quantity));
      if (quantity > 0) binders.push({ itemID: Number(item.itemID), quantity, locationID: Number(item.locationID), flagID: Number(item.flagID) });
      remaining -= quantity;
      if (!remaining) break;
    }
    if (remaining) return state.fail("SKINR_BINDERS_INSUFFICIENT");
  }
  return { success: true, requests: requests.sort((a, b) => a.componentID - b.componentID), binders };
}
async function initiate(actor, request, requestID) {
  return locked(`actor:${actor}`, async () => {
    if (!state.positive(actor) || !state.requestKey(requestID)) return state.fail("INVALID_SEQUENCING_REQUEST", 400);
    const quantity = state.positive(request.licenses, 5000);
    const fingerprint = state.fingerprint([request.name, request.line_name, request.layout, request.licenses, request.component_licenses]);
    let next = root(), prior = next.requests[`${actor}:${requestID}`];
    if (prior) {
      if (prior.fingerprint !== fingerprint) return state.fail("SEQUENCING_REQUEST_CONFLICT");
      const job = getJob(prior.id); await schedule(job); return { success: true, job, duplicate: true };
    }
    const design = drafts.validateDesign(actor, request);
    if (!design.success) return design;
    if (!binding.get()) return state.fail("SKINR_SCHEDULER_UNAVAILABLE", 503);
    const limits = getCharacterShipSkinLimits(actor);
    if (!quantity || quantity > limits.maxRuns) return state.fail("SKINR_RUN_LIMIT", 400);
    const accountID = require("../newEdenStore/storeState").resolveCharacterAccountID(actor);
    if (!require("../subscription/subscriptionState").getSubscriptionState(accountID).isSubscribed) {
      const requirements = require("../fitting/liveFittingState").getRequiredSkillRequirements(design.design.layout.ship_type.sequential);
      const { isSkillLevelRestrictedForClone } = require("../skills/training/skillCloneRestrictions");
      if (!requirements.length || requirements.some(row => isSkillLevelRestrictedForClone(row.skillTypeID, row.level, { cloneGrade: 0 }))) return state.fail("SKINR_HULL_REQUIRES_OMEGA", 403);
    }
    if (Object.values(next.jobs).filter(job => job.characterID === actor && !["completed", "refused"].includes(job.state)).length >= limits.maxConcurrentJobs) return state.fail("SKINR_JOB_LIMIT", 403);
    const resources = prepareResources(actor, design.design.layout, request.component_licenses, quantity);
    if (!resources.success) return resources;
    const policy = getShipSkinSequencingPolicy();
    const unitPrice = policy.tierPricing.find(row => row.tier === design.design.tier)?.plex;
    const seconds = policy.tierDurations.find(row => row.tier === design.design.tier)?.seconds;
    if (!state.positive(unitPrice) || !state.positive(seconds)) return state.fail("SKINR_TIER_POLICY_MISSING", 503);
    const { price, durationMs } = getShipSkinSequencingTerms(design.design.tier, quantity, limits.durationBonusPercent, policy);
    if ((wallet.getCharacterWallet(actor)?.plexBalance || 0) < price) return state.fail("SKINR_PLEX_INSUFFICIENT");
    const id = randomBytes(16).toString("hex");
    const hex = drafts.retainShipSkinDesign(design.design);
    const job = { id, characterID: actor, hex, design: design.design, quantity, price,
      durationMs,
      earlyPricing: policy.earlyCompletionPricing, requests: resources.requests, binders: resources.binders,
      escrowLocationID: 9700000000000 + ++next.nextEscrow, state: "pending", createdMs: getNow() };
    next.jobs[id] = job; next.requests[`${actor}:${requestID}`] = { id, fingerprint };
    state.write(TABLE_NAME, next);
    await schedule(job);
    return { success: true, job };
  });
}
function binderMove(job, binder, index, action) {
  const fromEscrow = action !== "stage";
  const result = custody.transfer({ items: { itemID: fromEscrow ? binder.stagedID : binder.itemID, quantity: binder.quantity },
    from: custody.custodyRef.ownerLocation(job.characterID, fromEscrow ? job.escrowLocationID : binder.locationID, fromEscrow ? 0 : binder.flagID),
    to: action === "consume" ? custody.custodyRef.void() : custody.custodyRef.ownerLocation(job.characterID, fromEscrow ? binder.locationID : job.escrowLocationID, fromEscrow ? binder.flagID : 0),
    actor: job.characterID, reason: custody.CUSTODY_REASON[`SKIN_BINDER_${action === "consume" ? "CONSUME" : action === "stage" ? "STAGE" : "RETURN"}`],
    idempotencyKey: `skinr:${job.id}:binder:${index}:${action}` });
  if (result.success && !result.duplicate) require("../raffles/raffleInventory").notifyInventoryChangesToCharacter(job.characterID, result.data?.changes || []);
  return result;
}
async function refuse(job, errorMsg, failureReason = job.failureReason || 4) {
  job = change(job.id, { state: "aborting", errorMsg, failureReason });
  for (let i = 0; i < job.binders.length; i++) if (job.binders[i].stagedID) state.check(binderMove(job, job.binders[i], i, "return"));
  const reservation = state.read(components.TABLE_NAME).reservations?.[`${job.characterID}:skinr:${job.id}`];
  if (reservation) state.check(components.rollbackShipSkinComponentLicenses(job.characterID, `skinr:${job.id}`));
  job = change(job.id, { state: "refused" }); notify("Failed", job); return state.fail(errorMsg);
}
async function charge(actor, amount, key) {
  if (!amount) return { success: true };
  return wallet.adjustCharacterPlexBalanceAsync(actor, -amount, { idempotencyKey: key, categoryMessageID: PLEX_LOG_CATEGORY.SKINR,
    reason: "SKINR sequencing", requireSufficientFunds: true }, { commandID: key, source: "skinr-sequencing" });
}
async function complete(job) {
  state.check(rights.grantShipSkinLicense(job.characterID, job.hex, job.quantity, `skinr:${job.id}:output`));
  job = change(job.id, { state: "completed", completedMs: getNow() }); notify("Completed", job);
  return { success: true, job };
}
async function settle(id) {
  return locked(id, async () => {
    let job = getJob(id);
    if (!job) return state.fail("SKINR_JOB_NOT_FOUND", 404);
    if (["completed", "refused"].includes(job.state)) return { success: true, job, duplicate: true };
    if (job.state === "aborting") return refuse(job, job.errorMsg);
    if (job.state === "pending") {
      const reserved = components.reserveShipSkinComponentLicenses(job.characterID, job.requests, `skinr:${id}`);
      if (!reserved.success) return refuse(job, reserved.errorMsg);
      for (let i = 0; i < job.binders.length; i++) {
        if (job.binders[i].stagedID) continue;
        const result = binderMove(job, job.binders[i], i, "stage");
        if (!result.success) {
          if (result.ambiguous) throw new Error(result.errorMsg);
          return refuse(job, result.errorMsg, 3);
        }
        job.binders[i].stagedID = Number(result.data.item.itemID);
        job = change(id, { binders: job.binders });
      }
      const paid = await charge(job.characterID, job.price, `skinr:${id}:charge`);
      if (!paid.success) {
        if (["INSUFFICIENT_FUNDS", "INSUFFICIENT_PLEX", "INSUFFICIENT_PLEX_BALANCE"].includes(paid.errorMsg)) return refuse(job, paid.errorMsg, 1);
        throw new Error(paid.errorMsg || "SKINR_CHARGE_PENDING");
      }
      job = change(id, { state: "funded" });
    }
    if (job.state === "funded") {
      for (let i = 0; i < job.binders.length; i++) state.check(binderMove(job, job.binders[i], i, "consume"));
      state.check(components.commitShipSkinComponentLicenses(job.characterID, `skinr:${id}`));
      job = change(id, { state: "running", startedMs: getNow(), plannedCompletionMs: getNow() + job.durationMs });
      await schedule(job); notify("Started", job);
    }
    if (job.completionMode === "early") {
      const paid = await charge(job.characterID, job.early.price, `skinr:${id}:early:${job.early.requestID}`);
      if (!paid.success) {
        if (!["INSUFFICIENT_FUNDS", "INSUFFICIENT_PLEX", "INSUFFICIENT_PLEX_BALANCE"].includes(paid.errorMsg)) throw new Error(paid.errorMsg || "SKINR_EARLY_CHARGE_PENDING");
        job = change(id, { completionMode: null, early: { ...job.early, refused: true } });
        if (job.plannedCompletionMs <= getNow()) return complete(job);
        await schedule(job); return state.fail(paid.errorMsg);
      }
      return complete(job);
    }
    if (job.state === "running" && job.plannedCompletionMs <= getNow()) return complete(job);
    return { success: true, job };
  });
}
function getEarlyCompletionPrice(job, now = getNow()) {
  if (job.plannedCompletionMs <= now) return 0;
  const seconds = Math.ceil((job.plannedCompletionMs - now) / 1000);
  return job.earlyPricing.find(row => (row.remainingGreaterSeconds < 0 || seconds > row.remainingGreaterSeconds) && (row.remainingLesserOrEqualSeconds < 0 || seconds <= row.remainingLesserOrEqualSeconds))?.plex ?? null;
}
async function completeEarly(actor, id, requestID) {
  if (!state.requestKey(requestID)) return state.fail("INVALID_EARLY_REQUEST", 400);
  const result = await locked(id, async () => {
    let job = ownedJob(actor, id);
    if (!job) return state.fail("SKINR_JOB_NOT_FOUND", 404);
    if (job.state === "completed") return { success: true, job, duplicate: true };
    if (job.state !== "running") return state.fail("SKINR_JOB_NOT_RUNNING");
    if (job.early?.requestID === requestID && job.early.refused) return state.fail("SKINR_EARLY_REFUSED");
    if (job.completionMode === "early") return job.early.requestID === requestID ? { success: true } : state.fail("SKINR_EARLY_PENDING");
    const price = getEarlyCompletionPrice(job);
    if (price === null) return state.fail("SKINR_EARLY_POLICY_MISSING", 503);
    job = change(id, { completionMode: "early", early: { requestID, price } });
    await schedule(job); return { success: true };
  });
  return !result.success || result.job ? result : settle(id);
}
async function reconcile() { for (const job of Object.values(root().jobs)) await schedule(job); }
module.exports = { TABLE_NAME, JOB_TYPE, initiate, settle, completeEarly, getEarlyCompletionPrice, getJob, ownedJob,
  getFirstSequencedMs: hex => Object.values(root().jobs).filter(job => job.hex === hex && job.state === "completed").reduce((earliest, job) => earliest ? Math.min(earliest, job.completedMs) : job.completedMs, null),
  setNowProvider: provider => { nowProvider = provider; }, getActiveJobs: actor => Object.values(root().jobs).filter(job => job.characterID === actor && !["completed", "refused"].includes(job.state)),
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind, reconcile,
  handleJob: job => settle(job.payload.id), setNoticeSink: sink => { const previous = noticeSink; noticeSink = sink; return previous; } };
