"use strict";

const presentation = require("./incursionPresentation");
const { fingerprint } = require("./incursionLifecycleContract");
const sessionState = new WeakMap();
const influenceQueues = new WeakMap();
const systemOf = session => session.solarsystemid2 !== undefined
  ? Number(session.solarsystemid2) || 0 : Number(session.solarsystemid || session._space?.systemID) || 0;
const authenticated = session => Number(session.characterID || session.charid) > 0;
function sendInfluence(session, tale) {
  const systemID = systemOf(session), characterID = Number(session.characterID || session.charid);
  const send = () => {
    if (!authenticated(session) || Number(session.characterID || session.charid) !== characterID || systemOf(session) !== systemID) return;
    const current = require("./incursionLifecycle").getTale(tale.taleID);
    if (current && presentation.isPrepared(current)) session.sendNotification?.("OnInfluenceUpdate", "charid",
      [current.taleID, presentation.influenceData(current)]);
  };
  if (tale.policy.sites?.enabled) {
    const runtime = require.cache[require.resolve("../../space/runtime")]?.exports;
    const scene = runtime?.scenes?.get(systemID);
    // Agency constructs its child list from the client's ballpark. The
    // invalidation must follow this observer's beacon birth/removal batch.
    if (scene?.sessions?.get(session.clientID) === session && scene.afterDestinyBatch) {
      const tickets = influenceQueues.get(session) || new Map(); influenceQueues.set(session, tickets);
      const ticket = { revision: tale.revision, minimumStamp: Math.max(scene.historyStamp(), scene.nextBubbleUpdateStamp()) };
      tickets.set(tale.taleID, ticket);
      const afterBatch = () => {
        if (tickets.get(tale.taleID) !== ticket) return;
        const current = require("./incursionLifecycle").getTale(tale.taleID);
        if (!authenticated(session) || Number(session.characterID || session.charid) !== characterID || systemOf(session) !== systemID ||
            !current || current.revision !== ticket.revision || !presentation.isPrepared(current)) {
          tickets.delete(tale.taleID); return;
        }
        if (scene.destinyTickDriver.destinyTick < ticket.minimumStamp) { scene.afterDestinyBatch(session, afterBatch); return; }
        try { send(); tickets.delete(tale.taleID); }
        catch (error) {
          // A queued write is not delivered yet. Keep its dirty ticket and
          // retry on the next observed batch; newer revisions supersede it.
          if (!ticket.warned) require("../../utils/logger").warn(`[Incursion] Influence delivery pending: ${error.message}`);
          ticket.warned = true; scene.afterDestinyBatch(session, afterBatch);
        }
      };
      if (scene.afterDestinyBatch(session, afterBatch)) return;
      tickets.delete(tale.taleID);
    }
  }
  send();
}

function sendSession(session, systemID = systemOf(session), { direct = false } = {}) {
  if (!session?.sendNotification) return false;
  if (!direct && !authenticated(session)) return false;
  if (!direct && systemOf(session) !== systemID) return false;
  const next = presentation.forSystem(systemID);
  const previous = sessionState.get(session);
  // The native removal consumer does not validate taleID. Always remove the
  // remembered current tale BEFORE installing a replacement; never broadcast it.
  if (previous && previous.taleID !== next?.taleID) {
    session.sendNotification("OnTaleRemove", "solarsystemid2", [previous.taleID, 2, previous.templateID]);
    sessionState.delete(session);
  }
  if (!next) return false;
  // Phase lives in map/journal reports, not the native flight snapshot. A
  // phase-only revision must invalidate Agency without replaying entry audio.
  const token = fingerprint([next.taleID, systemID, next.boss, next.influence.graceMinutes,
    next.influence.decayPerHour, next.policy.presentation]);
  if (previous?.token === token) return true;
  const chat = require("../../_secondary/chat/chatRuntime");
  if (next.policy.presentation.hasChat) chat.ensureIncursionChannel(next.taleID);
  session.sendNotification("OnTaleData", "charid", [systemID, presentation.buildSystemTalesDict(systemID)]);
  sessionState.set(session, { token, taleID: next.taleID, revision: next.revision,
    templateID: next.policy.presentation.templateID, systemID });
  return true;
}

function reconcile() {
  const lifecycle = require("./incursionLifecycle");
  const sessions = require("../chat/sessionRegistry").getSessions();
  let acknowledged = 0;
  for (const tale of lifecycle.listTales().filter(presentation.isEnabled)) {
    if (!lifecycle.prepareProjection(tale.taleID, tale.revision)) continue;
    const current = lifecycle.getTale(tale.taleID);
    if (current.revision !== tale.revision) continue;
    require("./incursionSystemEffects").refreshLoadedScenes();
    // Projection preparation is durable before notices. Consumers only read
    // current revision/terminal state, so historical slot/projection intents
    // cannot resurrect a tale after downtime.
    for (const session of sessions) sendSession(session);
    if (current.publication?.acknowledgedRevision !== current.revision) {
      // Agency has no OnTaleData invalidation listener. Its influence listener
      // safely ignores unrelated tale IDs in the in-flight panel.
      for (const session of sessions.filter(authenticated)) sendInfluence(session, current);
    }
    if (lifecycle.acknowledgeProjection(current.taleID, current.revision)) acknowledged++;
  }
  return { acknowledged };
}
module.exports = { reconcile, sendSession, systemOf, forgetSession: session => {
  sessionState.delete(session); influenceQueues.get(session)?.clear(); influenceQueues.delete(session);
} };
