"use strict";

const crypto = require("node:crypto");
const config = require("../../config");
const log = require("../../utils/logger");
const store = require("./customsInspectionCaseStore");
const authorityRuntime = require("./customsInspectionAuthority");
const { evaluateCandidate } = require("./customsInspectionEvaluator");
const inspection = require("./contrabandInspectionRuntime");
const penalty = require("./contrabandPenaltyState");
const custody = require("../inventory/contrabandItemCustody");
const itemStore = require("../inventory/itemStore");
const presentation = require("./customsInspectionPresentation");
const enforcement = require("./customsInspectionEnforcement");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { subscribe } = require("../inventory/itemMutationEvents");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");

const DURABLE_CASE_JOB_TYPE = "customs.case-resume";
const lanes = new Map();
const admissions = new Set();
const prompts = new Map();
const activeItemIDs = new Set();
const pendingTrackedQuantities = new Map();
const pendingTrackedRevisions = new Map();
const schedulerBinding = createDurableSchedulerBinding({
  message: "Customs scheduler requires schedule",
  afterUnbind() {
    enforcement.releaseAll();
    for (const record of store.listCases({ activeOnly: true })) cancelPrompt(record);
  },
});
const bindDurableScheduler = schedulerBinding.bind;
const unbindDurableScheduler = schedulerBinding.unbind;
let nowProvider = Date.now;
const now = () => Number(nowProvider());

function runtimeScene() { return require("../../space/runtime"); }
function owningSession(record) {
  const session = presentation.getCharacterSession(record.characterID);
  const scene = session && runtimeScene().getSceneForSession(session);
  return session && scene && scene.sceneKey === record.sceneKey &&
    Number(session._space.shipID) === record.shipID &&
    scene.dynamicEntities.get(record.shipID)?.session === session ? session : null;
}
function check(result) {
  if (!result || !result.success) throw new Error(result && result.errorMsg || "CUSTOMS_OWNER_COMMAND_FAILED");
  return result.data;
}
function save(record, changes) {
  return store.saveCase({ ...record, ...changes, updatedAtMs: now() });
}
function serialize(caseID, action) {
  const previous = lanes.get(caseID) || Promise.resolve();
  const current = previous.catch(() => null).then(action);
  lanes.set(caseID, current);
  void current.finally(() => {
    if (lanes.get(caseID) === current) lanes.delete(caseID);
  }).catch(() => null);
  return current;
}
function buildJob(record, dueAtMs = record.dueAtMs) {
  return { jobID: `customs-case:${record.caseID}`, type: DURABLE_CASE_JOB_TYPE,
    dueAtMs, payload: { caseID: record.caseID } };
}
async function schedule(record, dueAtMs = record.dueAtMs) {
  const scheduler = schedulerBinding.get();
  if (scheduler && !store.TERMINAL_STATES.has(record.state)) {
    await scheduler.schedule(buildJob(record, dueAtMs));
  }
}
function kick(record) {
  const work = schedule(record).catch((error) => log.warn(`[Customs] schedule ${record.caseID}: ${error.message}`));
  admissions.add(work);
  void work.finally(() => admissions.delete(work));
}
function cancelPrompt(record) {
  const entry = prompts.get(record.caseID);
  if (entry) {
    presentation.cancelCasePrompt(entry.session, record.caseID);
    prompts.delete(record.caseID);
  }
}
function terminal(record, state, reason) {
  cancelPrompt(record);
  enforcement.release(record.caseID);
  const result = save(record, { state, reason, resolvedAtMs: now() });
  pendingTrackedQuantities.delete(record.caseID);
  pendingTrackedRevisions.delete(record.caseID);
  activeItemIDs.clear();
  for (const active of store.listCases({ activeOnly: true })) {
    activeItemIDs.add(active.shipID);
    for (const entry of active.entries || []) activeItemIDs.add(entry.itemID);
  }
  return result;
}
function readConfig() {
  return {
    enabled: config.customsInspectionEnabled !== false,
    scanDelayMs: Number(config.customsInspectionScanDelayMs) || 0,
    promptTimeoutSeconds: Number(config.customsInspectionPromptTimeoutSeconds) || 60,
  };
}

function registerArrival(session, options = {}) {
  const characterID = resolveSessionCharacterID(session);
  const scene = options.scene || session && runtimeScene().getSceneForSession(session);
  const shipID = Number(session && session._space && session._space.shipID);
  const gateID = Number(options.gateID);
  const transitionID = String(options.transitionID || "");
  if (!characterID || !shipID || !scene || !gateID || !transitionID ||
      scene.dynamicEntities.get(shipID)?.session !== session) {
    return { success: false, errorMsg: "CUSTOMS_ARRIVAL_CONTEXT_REQUIRED" };
  }
  const configSnapshot = readConfig();
  if (!configSnapshot.enabled) return { success: true, data: { eligible: false, reason: "disabled" } };
  const authorityResult = authorityRuntime.resolveArrivalAuthority(scene, gateID);
  if (!authorityResult || !authorityResult.success) return authorityResult;
  const authority = authorityResult.data;
  if (!authority || authority.eligible === false) return { success: true, data: authority };
  const caseID = crypto.createHash("sha256").update([
    transitionID, characterID, shipID, gateID, authority.revision,
  ].join(":")).digest("hex").slice(0, 32);
  const existing = store.getCase(caseID);
  if (existing) {
    // A prior synchronous flush may have failed after the owner accepted the
    // intent in memory. A duplicate arrival must retry durability and admission.
    store.saveCase(existing);
    activeItemIDs.add(existing.shipID);
    for (const entry of existing.entries || []) activeItemIDs.add(entry.itemID);
    kick(existing);
    return { success: true, idempotent: true, data: existing };
  }
  const arrivedAtMs = options.nowMs ?? now();
  const record = store.saveCase({
    caseID, transitionID, characterID, shipID, gateID, systemID: Number(scene.systemID),
    sceneKey: scene.sceneKey, factionID: authority.factionID, securityLevel: authority.security,
    authority, configSnapshot, seed: crypto.createHash("sha256").update(`${caseID}:${authority.scannerID}`).digest("hex"),
    entries: inspection.buildContrabandEntries(characterID, shipID, authority, { allCargoHolds: true }),
    smugglingChance: inspection.resolveCharacterSmugglingChance(characterID),
    state: "queued", arrivedAtMs, dueAtMs: arrivedAtMs + configSnapshot.scanDelayMs,
    receipts: {},
  });
  for (const entry of record.entries) activeItemIDs.add(entry.itemID);
  activeItemIDs.add(record.shipID);
  kick(record);
  return { success: true, data: record };
}

function startPrompt(record) {
  if (prompts.has(record.caseID) || record.state !== "awaiting-answer") return;
  const session = owningSession(record);
  if (!session) return;
  const entry = { session };
  prompts.set(record.caseID, entry);
  void presentation.promptCase(session, record).then((answer) => answerCase(session, record.caseID, answer))
    .catch((error) => {
      if (error.code !== "CUSTOMS_PROMPT_CANCELLED") log.warn(`[Customs] prompt ${record.caseID}: ${error.message}`);
    }).finally(() => { if (prompts.get(record.caseID) === entry) prompts.delete(record.caseID); });
}

function goodsRemain(record) {
  return (record.detectedEntries || []).some((entry) => {
    const result = custody.revalidateItem({ characterID: record.characterID, itemID: entry.itemID,
      typeID: entry.typeID, locationID: entry.item.locationID, flagID: entry.item.flagID,
      quantity: record.trackedQuantityByItemID?.[entry.itemID] ?? entry.quantity,
      singleton: entry.item.singleton });
    return result && result.success && result.data.quantity > 0;
  });
}

function trackedConfiscationQuantities(record) {
  return Object.fromEntries((record.detectedEntries || []).map((entry) => [
    entry.itemID, record.trackedQuantityByItemID?.[entry.itemID] ?? entry.quantity,
  ]));
}

function trackedCustodyRevisions(record) {
  return Object.fromEntries((record.detectedEntries || []).filter((entry) =>
    Number(entry.item.inventoryCustodyRevision) > 0).map((entry) => [
    entry.itemID, record.trackedCustodyRevisionByItemID?.[entry.itemID] ?? entry.item.inventoryCustodyRevision,
  ]));
}

function mergeTrackedQuantities(record, incoming = {}) {
  const tracked = { ...(record.trackedQuantityByItemID || {}) };
  const pending = pendingTrackedQuantities.get(record.caseID) || {};
  for (const entry of record.entries || []) {
    const limits = [tracked[entry.itemID], pending[entry.itemID], incoming[entry.itemID]]
      .filter((quantity) => quantity !== undefined);
    if (limits.length) tracked[entry.itemID] = Math.min(entry.quantity, ...limits);
  }
  return tracked;
}

function mergeTrackedRevisions(record, incoming = {}) {
  const revisions = { ...(record.trackedCustodyRevisionByItemID || {}) };
  const pending = pendingTrackedRevisions.get(record.caseID) || {};
  for (const entry of record.detectedEntries || []) {
    const initial = Number(entry.item.inventoryCustodyRevision) || 0;
    if (!initial) continue;
    revisions[entry.itemID] = Math.max(initial, revisions[entry.itemID] || 0,
      pending[entry.itemID] || 0, incoming[entry.itemID] || 0);
  }
  return revisions;
}

function persistTrackedQuantities(record, incoming, incomingRevisions) {
  const tracked = mergeTrackedQuantities(record, incoming);
  const revisions = mergeTrackedRevisions(record, incomingRevisions);
  // Keep observed reductions until both owners accept them. Replenishment
  // cannot undo a prior snapshot just because its case write was rejected.
  pendingTrackedQuantities.set(record.caseID, tracked);
  pendingTrackedRevisions.set(record.caseID, revisions);
  let ownerError = null;
  if (record.operationID) {
    try {
      // Fence an independent penalty retry even if the following case save
      // fails. The penalty owner keeps this cap separate from approved units.
      check(penalty.updateContrabandConfiscationLimits(record.operationID,
        trackedConfiscationQuantities({ ...record, trackedQuantityByItemID: tracked }),
        trackedCustodyRevisions({ ...record, trackedCustodyRevisionByItemID: revisions })));
    } catch (error) { ownerError = error; }
  }
  const saved = save(record, { trackedQuantityByItemID: tracked, trackedCustodyRevisionByItemID: revisions });
  if (ownerError) throw ownerError;
  pendingTrackedQuantities.delete(record.caseID);
  pendingTrackedRevisions.delete(record.caseID);
  return saved;
}

function flushPendingTrackedQuantities(record) {
  return pendingTrackedQuantities.has(record.caseID)
    ? persistTrackedQuantities(record, pendingTrackedQuantities.get(record.caseID),
      pendingTrackedRevisions.get(record.caseID))
    : record;
}

function observeTrackedCustody(record, snapshots) {
  let changed = pendingTrackedQuantities.has(record.caseID);
  const tracked = mergeTrackedQuantities(record);
  const revisions = mergeTrackedRevisions(record);
  for (const entry of record.entries || []) {
    if (!snapshots.has(entry.itemID)) continue;
    const item = snapshots.get(entry.itemID);
    const previousRevision = revisions[entry.itemID] || 0;
    const revision = Number(item && item.inventoryCustodyRevision) || 0;
    // A delayed duplicate is already covered by the newer acknowledged row.
    if (previousRevision && revision && revision < previousRevision) continue;
    const unseenMutation = previousRevision && item && (!revision || revision > previousRevision + 1);
    if (previousRevision && revision > previousRevision) {
      revisions[entry.itemID] = revision;
      changed = true;
    }
    const sameCustody = item && Number(item.ownerID) === record.characterID &&
      Number(item.locationID) === Number(entry.item.locationID) &&
      Number(item.flagID) === Number(entry.item.flagID) && Number(item.typeID) === entry.typeID &&
      Number(item.singleton) === Number(entry.item.singleton);
    const quantity = Math.max(0, Math.min(tracked[entry.itemID] ?? entry.quantity,
      sameCustody && !unseenMutation ? item.quantity : 0));
    if (quantity !== (tracked[entry.itemID] ?? entry.quantity)) {
      tracked[entry.itemID] = quantity;
      changed = true;
    }
  }
  return changed ? persistTrackedQuantities(record, tracked, revisions) : record;
}

function refreshTrackedCustody(record) {
  const snapshots = new Map((record.entries || []).map((entry) => {
    const item = itemStore.findItemById(entry.itemID);
    return [entry.itemID, item ? { ...item, quantity: Number(item.stacksize ?? item.quantity) } : null];
  }));
  return observeTrackedCustody(flushPendingTrackedQuantities(record), snapshots);
}

function preserveSurrenderApproval(record) {
  if (record.surrenderApprovedQuantityByItemID) return record;
  const settlement = penalty.getPendingContrabandPenalty(record.operationID);
  // Recovery of an older accepted case must retain the penalty owner's
  // original approval, including an approval whose first removal failed.
  const approved = settlement && settlement.confiscationDisposition === "requested"
    ? Object.fromEntries(settlement.itemLegs.map((leg) => [
      leg.itemID, leg.confiscationLimit ?? leg.quantity,
    ]))
    : trackedConfiscationQuantities(record);
  return save(record, { surrenderApprovedQuantityByItemID: approved });
}

function sendNotices(record, settlement) {
  if (record.receipts.notification) return record;
  const notifications = require("../notifications/notificationState");
  const options = {
    typeID: presentation.CUSTOMS_NOTIFICATION_TYPE_ID, senderID: record.factionID,
    data: presentation.buildCustomsNotificationData(record),
    idempotencyKey: `customs-case:${record.caseID}:inspection`, emitLive: false,
  };
  const result = notifications.createNotification(record.characterID, options);
  // The notification owner uses durable idempotent identities; its inbox is the
  // recoverable delivery record even while the pilot is disconnected.
  if (!result || result.success === false) throw new Error("CUSTOMS_NOTIFICATION_FAILED");
  const database = require("../../gameStore");
  check(database.flushTableSync(notifications.NOTIFICATIONS_TABLE));
  check(notifications.createNotification(record.characterID, { ...options, emitLive: true }));
  check(database.flushTableSync(notifications.NOTIFICATIONS_TABLE));
  const standingsData = presentation.buildNpcStandingsLostData(settlement.standingResult);
  if (standingsData.length) {
    const standingsOptions = {
      typeID: presentation.NPC_STANDINGS_LOST_NOTIFICATION_TYPE_ID,
      senderID: record.factionID, data: standingsData,
      idempotencyKey: `customs-case:${record.caseID}:standings`, emitLive: false,
    };
    check(notifications.createNotification(record.characterID, standingsOptions));
    check(database.flushTableSync(notifications.NOTIFICATIONS_TABLE));
    check(notifications.createNotification(record.characterID, { ...standingsOptions, emitLive: true }));
    check(database.flushTableSync(notifications.NOTIFICATIONS_TABLE));
  }
  return save(store.getCase(record.caseID), { receipts: {
    ...store.getCase(record.caseID).receipts, notification: result.notificationID || true,
    sanctions: { chargedFine: settlement.chargedFine, standingLoss: settlement.standingLoss },
  } });
}

async function resumeInternal(caseID) {
  let record = store.getCase(caseID);
  if (!record || store.TERMINAL_STATES.has(record.state)) return record;
  record = refreshTrackedCustody(record);
  if (record.state === "queued") {
    if (now() < record.dueAtMs) { await schedule(record); return record; }
    const session = owningSession(record);
    if (!session) return terminal(record, "ineligible", "left-scene-before-scan");
    const currentAuthority = authorityRuntime.resolveArrivalAuthority(runtimeScene().getSceneForSession(session), record.gateID);
    if (!currentAuthority.success || !currentAuthority.data.eligible ||
        !currentAuthority.data.officerIDs.includes(record.authority.scannerID)) {
      return terminal(record, "ineligible", "officer-left-scene-before-scan");
    }
    // The officer observes cargo when the scan becomes due. Keep the captured
    // law revision, but never detect goods discarded during the arrival grace.
    record = save(record, {
      entries: inspection.buildContrabandEntries(record.characterID, record.shipID,
        record.authority, { allCargoHolds: true }),
      trackedQuantityByItemID: {},
    });
    for (const entry of record.entries) activeItemIDs.add(entry.itemID);
    const evaluation = evaluateCandidate({ seed: record.seed, scanChance: record.authority.scanChance,
      detectionChance: record.authority.detectionChance, smugglingChance: record.smugglingChance,
      entries: record.entries });
    if (!evaluation.selected) return terminal(record, "not-selected", "scan-selection");
    const detectedEntries = evaluation.detectedEntries || [];
    if (!detectedEntries.length) return terminal(record, "clean", "no-detected-contraband");
    for (const entry of detectedEntries) {
      entry.item = check(itemStore.trackItemCustodyRevision(entry.itemID));
    }
    const tagged = new Map(detectedEntries.map((entry) => [entry.itemID, entry]));
    record = save(record, { state: "sanctions", detectedEntries,
      entries: record.entries.map((entry) => tagged.get(entry.itemID) || entry),
      trackedCustodyRevisionByItemID: Object.fromEntries(detectedEntries.map((entry) => [
        entry.itemID, entry.item.inventoryCustodyRevision,
      ])),
      operationID: `customs-case:${caseID}`, dueAtMs: now(),
      totalFine: Math.round(detectedEntries.reduce((sum, entry) => sum + entry.fine, 0) * 100) / 100,
      standingLoss: detectedEntries.reduce((sum, entry) => sum + entry.standingLoss, 0),
      lostList: detectedEntries.map((entry) => ({ typeID: entry.typeID, quantity: entry.quantity,
        fine: entry.fine, penalty: entry.standingLoss })),
      shouldConfiscate: true,
      shouldAttack: detectedEntries.some((entry) => record.securityLevel >= entry.attackMinSec),
    });
  }
  if (record.operationID) {
    check(penalty.prepareContrabandPenalty({ operationID: record.operationID,
      characterID: record.characterID, shipID: record.shipID, authority: record.authority,
      entries: record.detectedEntries, totalFine: record.totalFine,
      standingLoss: record.standingLoss, deferConfiscation: true }));
    if (record.state === "surrendering") {
      record = preserveSurrenderApproval(store.getCase(caseID));
      // A requested custody leg may resume in settleContrabandPenalty itself.
      // Apply the latest monotone custody caps before that owner can remove
      // anything, keeping the immutable approval separate from replacement
      // cargo that appeared while an accepted surrender was being retried.
      check(penalty.updateContrabandConfiscationLimits(record.operationID,
        trackedConfiscationQuantities(record), trackedCustodyRevisions(record)));
    }
    const settlement = check(await penalty.settleContrabandPenalty(record.operationID));
    record = store.getCase(caseID);
    if (!record.receipts.notification) {
      const delta = (settlement.standingResult?.data?.appliedChanges ||
        settlement.standingResult?.appliedChanges || [])
        .filter((entry) => Number(entry.fromID) === record.factionID)
        .reduce((sum, entry) => sum + Math.abs(entry.standing - entry.previousStanding), 0);
      record = save(record, { standingDivision: 1, lostList: record.lostList.map((entry) => ({
        ...entry, penalty: record.standingLoss > 0 ? delta *
          (record.detectedEntries.find((detected) => detected.typeID === entry.typeID)?.standingLoss || 0) /
          record.standingLoss : 0,
      })) });
    }
    record = sendNotices(store.getCase(caseID), settlement);
  }
  record = store.getCase(caseID);
  if (record.requestedTerminal) {
    if (record.operationID) check(await penalty.finishContrabandPenaltyWithoutConfiscation(record.operationID));
    return terminal(store.getCase(caseID), record.requestedTerminal, record.reason);
  }
  if (record.state === "sanctions") {
    record = save(record, { state: record.shouldAttack ? "enforcing" : "awaiting-answer",
      answerDeadlineMs: now() + record.configSnapshot.promptTimeoutSeconds * 1000,
      dueAtMs: now() + record.configSnapshot.promptTimeoutSeconds * 1000 });
  }
  if (record.state === "surrendering") {
    record = preserveSurrenderApproval(record);
    check(penalty.updateContrabandConfiscationLimits(record.operationID,
      trackedConfiscationQuantities(record), trackedCustodyRevisions(record)));
    const settlement = check(await penalty.requestContrabandConfiscation(record.operationID,
      record.receipts.confiscationRequested ? {} : {
        quantitiesByItemID: record.surrenderApprovedQuantityByItemID,
      }));
    record = save(store.getCase(caseID), { receipts: { ...store.getCase(caseID).receipts, confiscationRequested: true } });
    return terminal(save(store.getCase(caseID), { confiscation: settlement }), "surrendered", "client-surrender");
  }
  if (record.state === "awaiting-answer") {
    if (!goodsRemain(record)) {
      check(await penalty.finishContrabandPenaltyWithoutConfiscation(record.operationID));
      return terminal(store.getCase(caseID), "evaded", "tracked-cargo-discarded");
    }
    if (now() >= record.answerDeadlineMs) {
      cancelPrompt(record);
      record = save(record, { state: "enforcing", reason: "answer-timeout",
        dueAtMs: now() + 5000 });
    } else {
      startPrompt(record);
      await schedule(record, Math.min(record.answerDeadlineMs, now() + 5000));
      return record;
    }
  }
  if (record.state === "enforcing") {
    if (!goodsRemain(record)) {
      check(await penalty.finishContrabandPenaltyWithoutConfiscation(record.operationID));
      return terminal(store.getCase(caseID), "evaded", "tracked-cargo-discarded");
    }
    const session = owningSession(record);
    if (session) {
      const scene = runtimeScene().getSceneForSession(session);
      const result = enforcement.acquire(record, scene);
      // No operational officer at the gate right now (destroyed, or not yet
      // respawned) is not an end condition: the case keeps enforcing and
      // rechecks in five seconds. Failing the job would park it instead.
      if (!result.success && result.errorMsg !== "CUSTOMS_OFFICERS_UNAVAILABLE") {
        throw new Error(result.errorMsg);
      }
      if (result.success && !record.receipts.threat) {
        if (presentation.sendCustomsRemoteMessage(record, "chatDefaultCustomsThreat", session)) {
          record = save(record, { receipts: { ...record.receipts, threat: true } });
        }
      }
    }
    record = save(store.getCase(caseID), { dueAtMs: now() + 5000 });
    await schedule(record);
  }
  return store.getCase(caseID);
}

function resumeCase(caseID) { return serialize(caseID, () => resumeInternal(caseID)); }
function answerCase(session, caseID, answer) {
  return serialize(caseID, async () => {
    let record = store.getCase(caseID);
    if (!record || resolveSessionCharacterID(session) !== record.characterID) {
      return { success: false, errorMsg: "CUSTOMS_CASE_NOT_OWNER" };
    }
    if (typeof answer !== "boolean") return { success: false, errorMsg: "CUSTOMS_ANSWER_REQUIRED" };
    if (store.TERMINAL_STATES.has(record.state) || record.state !== "awaiting-answer") {
      return { success: true, idempotent: true, data: record };
    }
    record = refreshTrackedCustody(record);
    if (owningSession(record) !== session || record.requestedTerminal || now() >= record.answerDeadlineMs) {
      return { success: false, errorMsg: "CUSTOMS_CASE_NOT_PRESENT" };
    }
    cancelPrompt(record);
    record = save(record, { state: answer ? "surrendering" : "enforcing", answer,
      ...(answer ? { surrenderApprovedQuantityByItemID: trackedConfiscationQuantities(record) } : {}),
      answeredAtMs: now(), dueAtMs: now() + 5000 });
    try { return { success: true, data: await resumeInternal(caseID) }; }
    catch (error) { kick(store.getCase(caseID)); throw error; }
  });
}

function requestEnd(record, state, reason) {
  if (store.TERMINAL_STATES.has(record.state)) return;
  cancelPrompt(record);
  enforcement.release(record.caseID);
  if (record.state === "queued") { terminal(record, state === "destroyed" ? state : "ineligible", reason); return; }
  // Once surrender is accepted its custody command must finish; departure
  // cannot replace that persisted irreversible decision with a waiver.
  if (record.state === "surrendering") { kick(record); return; }
  record = save(record, { requestedTerminal: state, reason, dueAtMs: now() });
  kick(record);
}
function handleSceneDeparture(session, options = {}) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID) return;
  for (const record of store.listCases({ characterID, activeOnly: true })) {
    const sceneKey = options.sceneKey || session._space && session._space.sceneKey;
    const shipID = Number(options.shipID || session._space && session._space.shipID);
    if (sceneKey && record.sceneKey !== sceneKey || shipID && record.shipID !== shipID) continue;
    requestEnd(record, "evaded", options.lifecycleReason || "scene-departure");
  }
}
function handleShipDestroyed(shipID) {
  for (const record of store.listCases({ activeOnly: true })) {
    if (record.shipID === Number(shipID)) requestEnd(record, "destroyed", "ship-destroyed");
  }
}
function handleSceneDisposed(sceneKey) {
  for (const record of store.listCases({ activeOnly: true })) {
    if (record.sceneKey === sceneKey) {
      cancelPrompt(record);
      enforcement.release(record.caseID);
    }
  }
}
function handleSessionDisconnected(session) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID) return;
  for (const record of store.listCases({ characterID, activeOnly: true })) {
    if (prompts.get(record.caseID)?.session === session) cancelPrompt(record);
    const currentSession = owningSession(record);
    if (!currentSession || currentSession === session) enforcement.release(record.caseID);
  }
}
function handleSessionAttached(session) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID) return;
  for (const record of store.listCases({ characterID, activeOnly: true })) {
    if (owningSession(record) === session) {
      activeItemIDs.add(record.shipID);
      for (const entry of record.entries || []) activeItemIDs.add(entry.itemID);
      void resumeCase(record.caseID).catch((error) => {
        log.warn(`[Customs] resume ${record.caseID}: ${error.message}`);
        kick(store.getCase(record.caseID));
      });
    }
  }
}
subscribe((itemIDs, snapshots) => {
  if (itemIDs && !itemIDs.some((itemID) => activeItemIDs.has(itemID))) return;
  try {
    for (let record of store.listCases({ activeOnly: true })) {
      try {
        record = observeTrackedCustody(record, snapshots);
        if (!itemStore.findItemById(record.shipID)) {
          requestEnd(record, "destroyed", "ship-destroyed");
          continue;
        }
        if (!["sanctions", "awaiting-answer", "enforcing"].includes(record.state)) continue;
        if (!goodsRemain(record)) requestEnd(record, "evaded", "tracked-cargo-discarded");
      } catch (error) { log.warn(`[Customs] cargo observer ${record.caseID}: ${error.message}`); }
    }
  } catch (error) { log.warn(`[Customs] cargo observer: ${error.message}`); }
}, (ids) => ids ? ids.filter((id) => activeItemIDs.has(Number(id))) : [...activeItemIDs]);

async function reconcileDurableCases() {
  const records = store.listCases({ activeOnly: true });
  for (const record of records) {
    activeItemIDs.add(record.shipID);
    for (const entry of record.entries || []) activeItemIDs.add(entry.itemID);
    await schedule(record, ["sanctions", "surrendering"].includes(record.state) || record.requestedTerminal
      ? now() : record.dueAtMs);
  }
  return { scheduled: schedulerBinding.get() ? records.length : 0, pending: records.length };
}
async function handleDurableCase(job) {
  const caseID = String(job && job.payload && job.payload.caseID || "");
  if (!caseID) throw new Error("CUSTOMS_JOB_INVALID");
  return resumeCase(caseID);
}
async function idle() {
  while (lanes.size || admissions.size) {
    await Promise.allSettled([...lanes.values(), ...admissions]);
  }
}
function setNowProviderForTesting(provider) {
  const previous = nowProvider;
  nowProvider = provider;
  return () => { nowProvider = previous; };
}
module.exports = { DURABLE_CASE_JOB_TYPE, registerArrival, resumeCase, answerCase,
  handleSceneDeparture, handleShipDestroyed, handleSessionDisconnected, handleSessionAttached,
  handleSceneDisposed,
  bindDurableScheduler, unbindDurableScheduler, reconcileDurableCases, handleDurableCase,
  getCase: store.getCase, listCases: store.listCases, idle, setNowProviderForTesting };
