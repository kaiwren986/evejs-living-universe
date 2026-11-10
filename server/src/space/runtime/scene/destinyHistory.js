"use strict";

// The scene's one stamped action list and its batches (one batch per Grid
// bubble per tick; the list itself is
// destiny/batching/destinyHistory.js).
//
// Nothing sends a Destiny update directly. Gameplay, commands, transitions and
// the Beyonce handlers queue history entries, stamped `nextDestinyStamp` when
// queued:
//
//   queueBallHistory(entity, updates)     about one Ball: its Grid bubble's
//                                         history (its owner's character
//                                         history while it is cloaked)
//   queueBubbleHistory(updates)           each update about the Ball its
//                                         payload names, as above
//   queueCharacterHistory(session, ...)   one Observer only
//   queueEveryBubbleHistory(updates)      every Grid bubble (a global Ball's
//                                         add or removal)
//   queueBallparkAction(entity, ...)      a Ballpark action (a movement
//                                         change, a cloak) doPreTick applies
//   requestSetState(session, build)       a SetState, built by the next
//                                         doPreTick and put at the front of
//                                         the Observer's character history
//   queueDogmaEvent(session, events)      Dogma events for one Observer,
//                                         collected, never stamped
//                                         (runtime/dogmaEvents.js)
//
// What is queued inside Evolve N carries N + 1 and leaves with tick N + 1
// (retail sets stamp_for_system at DoPreTick, so what Evolve queues belongs
// to the next tick: _baseticker.py:23-46); a Dogma event raised there leaves
// with doPostTick(N). A Gameplay event
// (destiny/protocol/eventClasses.js) is queued like any update about its Ball;
// the list refuses a Dogma event.
//
// A Destiny tick then runs them (runtime/destinyTick.js), in retail's order
// (_ticker.py:59-131): in doPreTick the list's Ballpark actions are applied
// in call order, its updates held; the Grid bubble update (scene/
// visibility.js) gives each Observer its entries and exits; the held
// updates are routed in call order, and the requested SetStates built;
// doPostTick sends one batch per Grid bubble with a history and one per
// Observer with a character history (dispatch/batchDelivery.js). Membership,
// for routing and for a bubble batch's recipients, is what doPreTick's bubble
// update left: a session that connects between ticks gets nothing until its
// SetState, and one that leaves takes its character history with it.

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const destinyHistory = require(path.join(
  runtimeEntryDirname,
  "./destiny/batching/destinyHistory.js",
));
const gridBubbles = require(path.join(
  runtimeEntryDirname,
  "./destiny/visibility/gridBubbles.js",
));
const {
  deliverDestinyBatches,
} = require(path.join(runtimeEntryDirname, "./destiny/dispatch/batchDelivery.js"));
const {
  getEntityMapKey,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  getPayloadPrimaryEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/protocol/payloadIdentity.js"));
const {
  sendDogmaMultiEvent,
} = require(path.join(runtimeEntryDirname, "./destiny/dispatch/batchDelivery.js"));
// The cloak rule, loaded on first use (shipCloak pulls in the store).
function isEntityCloaked(entity) {
  return require("../shipCloak").isEntityCloaked(entity);
}

// The Observer key of a session, as the Grid bubbles name it (visibility.js).
function observerKey(session) {
  return session && session.clientID !== undefined && session.clientID !== null
    ? `client:${session.clientID}`
    : null;
}

// An update as queued: { stamp, payload } or a bare payload ([name, args]).
function payloadOf(update) {
  if (Array.isArray(update) && typeof update[0] === "string") {
    return update;
  }
  return update && Array.isArray(update.payload) ? update.payload : null;
}

function payloadsOf(updates) {
  return (Array.isArray(updates) ? updates : [updates])
    .map(payloadOf)
    .filter(Boolean);
}

module.exports = {

getDestinyHistory() {
    if (!this._destinyHistory) {
      this._destinyHistory = destinyHistory.createDestinyHistory();
    }
    return this._destinyHistory;
  },

destinyObserverKey(session) {
    return observerKey(session);
  },

// The stamp an entry queued now carries, the tick whose doPreTick will route
// it: nextDestinyStamp, except inside Evolve N, where the counter still reads
// N and what is queued belongs to tick N + 1, and before the
// scene's first tick, which is Evolve only: what is queued then
// belongs to the tick after it.
historyStamp() {
    const stamp = this.nextDestinyStamp;
    if (typeof this.isEvolving === "function" && this.isEvolving()) {
      return stamp + 1;
    }
    const driver = this.destinyTickDriver;
    return driver && driver.lastTickSimTimeMs === null ? stamp + 1 : stamp;
  },

// The stamp of the next Grid bubble update's lists, where a removal made now
// reaches its Observers: while a tick's list applies, that tick's (its
// bubble update runs next); from its bubble update to its doPostTick, the
// next tick's.
nextBubbleUpdateStamp() {
    const history = this._destinyHistory;
    const routing = history && history.routing;
    if (!routing) {
      return this.historyStamp();
    }
    return Array.isArray(routing.held) ? routing.stamp : routing.stamp + 1;
  },

// Updates about one Ball (an entity or its id), to its Grid bubble's history.
// options.bubble: the bubble to use instead of the Ball's own (CloakBall goes
// to the bubble the Ball was cloaked in; a removed Ball's destruction effect
// to the bubble it left). options.stamp: the stamp to carry instead of
// historyStamp() (a destruction effect carries its removal's). Returns the
// stamp they carry.
// options.preserveTarget captures the current visibility destination so a
// terminal update survives removal. Cloaked/global events keep their normal
// stamp; an ordinary visible Ball uses its committed bubble and removal stamp.
queueBallHistory(entityOrID, updates, options = {}) {
    const ballID = getEntityMapKey(
      entityOrID && typeof entityOrID === "object" ? entityOrID.itemID : entityOrID,
    );
    const hasExplicitStamp = options.stamp !== undefined && options.stamp !== null && Number.isFinite(Number(options.stamp));
    let stamp = hasExplicitStamp ? Number(options.stamp) : this.historyStamp();
    if (ballID === null) {
      return null;
    }
    let target = options.bubble === undefined || options.bubble === null
      ? { ball: ballID }
      : { ball: ballID, bubble: options.bubble };
    if (options.preserveTarget === true) {
      const entity = this.getEntityByID(ballID);
      if (!entity) return null;
      // Capture the same visibility classes as applyDestinyTickList's resolver.
      // A lethal removal must not turn a cloaked owner's update into a public
      // bubble event or narrow a global Ball's update to its spatial bubble.
      if (isEntityCloaked(entity)) {
        const owner = entity.session || null;
        const key = observerKey(owner);
        if (key === null) return null;
        target = { observer: key, session: owner };
      } else if (this.isGlobalBall(entity)) {
        target = { everyBubble: true };
      } else {
        const bubble = gridBubbles.committedBubbleOf(this.getGridBubbles(), ballID);
        if (bubble === null || bubble === undefined) return null;
        target = { ball: ballID, bubble };
        // Ordinary removals wait for the next bubble update. Global removals
        // and an owner's character events keep the normal history stamp.
        if (!hasExplicitStamp) stamp = this.nextBubbleUpdateStamp();
      }
    }
    const history = this.getDestinyHistory();
    for (const payload of payloadsOf(updates)) {
      destinyHistory.queueUpdate(history, { stamp, target, payload });
    }
    return stamp;
  },

// Updates each about the Ball its payload names, each to that Ball's Grid
// bubble's history. An update that names no Ball goes to every bubble.
queueBubbleHistory(updates, options = {}) {
    const stamp = this.historyStamp();
    const history = this.getDestinyHistory();
    for (const payload of payloadsOf(updates)) {
      const ballID = getEntityMapKey(getPayloadPrimaryEntityID(payload));
      destinyHistory.queueUpdate(history, {
        stamp,
        target: ballID === null
          ? { everyBubble: true }
          : (options.bubble === undefined || options.bubble === null
            ? { ball: ballID }
            : { ball: ballID, bubble: options.bubble }),
        payload,
      });
    }
    return stamp;
  },

// Updates for one Observer only. options.inFront: at the front of its
// character history (SetState, the uncloak add). options.beforeBubbleEntries:
// after those, ahead of the tick's Grid bubble entries and exits, in call
// order (a drone's OnDroneStateChange ahead of the drone's add). Returns the
// stamp they carry, or null for a session that is no Observer of this scene.
queueCharacterHistory(session, updates, options = {}) {
    const key = observerKey(session);
    if (key === null || (this.sessions instanceof Map && this.sessions.get(session.clientID) !== session)) {
      return null;
    }
    const stamp = this.historyStamp();
    const history = this.getDestinyHistory();
    const payloads = payloadsOf(updates);
    const ordered = options.inFront === true ? [...payloads].reverse() : payloads;
    for (const payload of ordered) {
      destinyHistory.queueUpdate(history, {
        stamp,
        target: { observer: key, session },
        payload,
        inFront: options.inFront === true,
        beforeBubbleEntries: options.beforeBubbleEntries === true,
      });
    }
    return stamp;
  },

// Dogma events for one Observer: `events` are [event, time]
// pairs, `event` the (name, ...args) tuple godma.OnMultiEvent dispatches.
// Collected, unstamped, and sent by the next doPostTick with the Observer's
// character batch, or as one OnMultiEvent. Returns false for a session that
// is no Observer of this scene (runtime/dogmaEvents.js sends those itself).
queueDogmaEvent(session, events) {
    const key = observerKey(session);
    if (key === null || !(this.sessions instanceof Map) || this.sessions.get(session.clientID) !== session) {
      return false;
    }
    return destinyHistory.collectDogma(this.getDestinyHistory(), key, session, events);
  },

// Whether `session` has a collected Dogma event that `match(event)` accepts,
// `event` the (name, ...args) tuple, still to leave with the next doPostTick.
hasQueuedDogmaEvent(session, match) {
    const key = observerKey(session);
    if (key === null || typeof match !== "function") {
      return false;
    }
    return destinyHistory.hasCollectedDogma(this.getDestinyHistory(), key, match);
  },

// Updates for every Grid bubble: a global Ball's add or removal.
queueEveryBubbleHistory(updates) {
    const stamp = this.historyStamp();
    const history = this.getDestinyHistory();
    for (const payload of payloadsOf(updates)) {
      destinyHistory.queueUpdate(history, { stamp, target: { everyBubble: true }, payload });
    }
    return stamp;
  },

// A Ballpark action (a movement change, a cloak): applied by the next
// doPreTick in call order, if the Ball is still in the scene.
queueBallparkAction(entity, label, apply) {
    const ballID = getEntityMapKey(entity && entity.itemID);
    destinyHistory.queueAction(this.getDestinyHistory(), {
      stamp: this.historyStamp(),
      ball: ballID,
      label: String(label || "action"),
      apply: () => {
        if (this.getEntityByID(ballID) !== entity) {
          return;
        }
        apply();
      },
    });
    return true;
  },

// A SetState for `session`: `build(stamp)` returns its updates, SetState
// first, and runs in the next doPreTick after the list applied and the Grid
// bubble update, so the state is the park as the last Evolve left it with
// this tick's actions applied, and the memberships that update committed,
// stamped with the tick that sends it. A later request
// replaces an earlier one.
requestSetState(session, build) {
    const key = observerKey(session);
    if (key === null || typeof build !== "function") {
      return false;
    }
    if (!(this._pendingSetStates instanceof Map)) {
      this._pendingSetStates = new Map();
    }
    this._pendingSetStates.set(key, { session, build });
    return true;
  },

hasPendingSetState(session) {
    const key = observerKey(session);
    return key !== null &&
      this._pendingSetStates instanceof Map &&
      this._pendingSetStates.has(key);
  },

// doPreTick, after the bubble update and the routing: the requested
// SetStates, each at the front of its Observer's character history (index
// 0, ahead of an uncloak's add routed before it).
buildPendingSetStates(frame) {
    if (!(this._pendingSetStates instanceof Map) || this._pendingSetStates.size === 0) {
      return 0;
    }
    const requests = [...this._pendingSetStates.values()];
    this._pendingSetStates = new Map();
    let built = 0;
    for (const { session, build } of requests) {
      if (!session || this.sessions.get(session.clientID) !== session) {
        continue;
      }
      let updates;
      try {
        updates = build(frame.stamp);
      } catch (error) {
        log.warn(
          `[SpaceRuntime] SetState for char=${session.characterID} failed in system=${this.systemID}: ` +
          `${error && error.stack ? error.stack : error}`,
        );
        continue;
      }
      const payloads = payloadsOf(updates || []);
      if (payloads.length === 0) {
        continue;
      }
      this.queueCharacterHistory(session, [payloads[0]], { inFront: true });
      if (payloads.length > 1) {
        this.queueCharacterHistory(session, payloads.slice(1));
      }
      built += 1;
    }
    return built;
  },

// The Observers of this scene, as doPreTick's bubble update left them, an
// undocking pilot's with no SetState yet among them.
listDestinyBatchObservers() {
    return this.listGridBubbleObservers().map((observer) => ({
      key: observer.id,
      session: observer.session,
      bubble: this.getKnownGridBubbleIDForSession(observer.session),
      setStateSent: Boolean(observer.session._space && observer.session._space.initialStateSent),
    })).filter((observer) => observer.bubble !== null && observer.bubble !== undefined);
  },

// doPreTick, first: the list's Ballpark actions applied in call order, its
// updates (and those the actions queue) held for routeDestinyTickQueue.
applyDestinyTickList(frame) {
    const park = this.getGridBubbles();
    return destinyHistory.applyQueue(this.getDestinyHistory(), {
      stamp: frame.stamp,
      resolve: (target) => {
        const entity = this.getEntityByID(target.ball);
        if (!entity) {
          return null;
        }
        if (isEntityCloaked(entity)) {
          // Only its owner hears of a cloaked Ball (retail _ticker.py:97-102).
          const owner = entity.session || null;
          const key = observerKey(owner);
          return key === null ? null : { observer: key, session: owner };
        }
        if (this.isGlobalBall(entity)) {
          // A global Ball is in every Observer's park, so every update
          // about it goes to every Grid bubble: on TQ a stargate's slim
          // item change reaches a pilot mid-warp, far from the gate.
          return { everyBubble: true };
        }
        const bubble = gridBubbles.bubbleOf(park, getEntityMapKey(entity.itemID));
        return bubble === null || bubble === undefined ? null : { bubble };
      },
      bubbles: () => [...new Set(this.listDestinyBatchObservers().map((observer) => observer.bubble))],
      // A moribund Ball is gone: the sweep at the top of the
      // tick removes it first, except a hit missile kept for its delay,
      // about which nothing more is applied or routed.
      isLive: (ballID) => {
        if (ballID === null || ballID === undefined) {
          return true;
        }
        const entity = this.getEntityByID(ballID);
        return Boolean(entity) && entity.isMoribund !== true;
      },
      onStampMismatch: (entry, stamp) => {
        log.warn(
          `[SpaceRuntime] system=${this.systemID}: a ${entry.payload && entry.payload[0]} queued for Destiny tick ` +
          `${entry.stamp} is routed by tick ${stamp}; it keeps its own stamp`,
        );
      },
      onError: (entry, error) => {
        log.warn(
          `[SpaceRuntime] Queued ${entry.label || "action"} failed for system=${this.systemID} ` +
          `entity=${entry.ball}: ${error && error.stack ? error.stack : error}`,
        );
      },
    });
  },

// doPreTick, after the Grid bubble update: the held updates routed in call
// order into tick `frame.stamp`'s histories, each by the memberships that
// update left (a cloaked Ball's to its owner), then the requested SetStates.
// Returns the tick's { applied, routed, dropped, failed }.
routeDestinyTickQueue(frame) {
    const result = destinyHistory.routeApplied(this.getDestinyHistory());
    if (frame) {
      this.buildPendingSetStates(frame);
    }
    return result;
  },

// doPostTick: the tick's batches, sent; then what was asked to follow an
// Observer's batch (afterDestinyBatch).
sendDestinyBatches(frame) {
    const { deliveries, multiEvents } = destinyHistory.takeBatches(this.getDestinyHistory(), {
      stamp: frame.stamp,
      observers: this.listDestinyBatchObservers(),
    });
    const result = deliverDestinyBatches(this, deliveries, frame.stamp, multiEvents);
    this.recoverFailedDestinySends(result.failedSessions);
    this.runAfterDestinyBatch();
    return result;
  },

// An Observer that missed a batch has a park the server no longer knows:
// the updates it missed are gone, and its Grid bubble baseline (set when its
// last SetState was built) may name what it never got. A fresh SetState,
// built by the next doPreTick, is its new baseline; until then its bubble
// update gives it no lists (scene/visibility.js updateGridBubbles).
recoverFailedDestinySends(sessions) {
    let requested = 0;
    for (const session of Array.isArray(sessions) ? sessions : []) {
      if (!session || !(this.sessions instanceof Map) || this.sessions.get(session.clientID) !== session) {
        continue;
      }
      if (this.sendStateRefresh(session)) {
        requested += 1;
        log.warn(
          `[SpaceRuntime] char=${session.characterID} missed a Destiny batch in system=${this.systemID}; ` +
          "a fresh SetState follows on the next tick",
        );
      }
    }
    return requested;
  },

// `fn` runs in the next doPostTick, right after the batches are sent, if
// `session` is still an Observer of this scene: for a direct notification
// that must reach the client after its SetState and is neither a Destiny
// update nor a Dogma event (the HUD's OnEwarStart reseed). With
// options.runIfLeft, `fn` runs even when the session left first, as it
// leaves: for work that must not be lost (a jettison's cargo move notice).
afterDestinyBatch(session, fn, options = {}) {
    const key = observerKey(session);
    if (key === null || typeof fn !== "function") {
      return false;
    }
    if (!(this._afterDestinyBatch instanceof Map)) {
      this._afterDestinyBatch = new Map();
    }
    const pending = this._afterDestinyBatch.get(key) || { session, fns: [] };
    pending.session = session;
    pending.fns.push({ fn, runIfLeft: options.runIfLeft === true });
    this._afterDestinyBatch.set(key, pending);
    return true;
  },

runAfterDestinyBatch() {
    if (!(this._afterDestinyBatch instanceof Map) || this._afterDestinyBatch.size === 0) {
      return 0;
    }
    const pending = [...this._afterDestinyBatch];
    this._afterDestinyBatch = new Map();
    let ran = 0;
    for (const [, { session, fns }] of pending) {
      const stillHere = Boolean(
        session && this.sessions instanceof Map && this.sessions.get(session.clientID) === session,
      );
      ran += this.runAfterBatchWork(session, fns.filter((entry) => stillHere || entry.runIfLeft));
    }
    return ran;
  },

runAfterBatchWork(session, entries) {
    let ran = 0;
    for (const { fn } of entries) {
      try {
        fn();
        ran += 1;
      } catch (error) {
        log.warn(
          `[SpaceRuntime] After-batch work for char=${session && session.characterID} failed in system=${this.systemID}: ` +
          `${error && error.stack ? error.stack : error}`,
        );
      }
    }
    return ran;
  },

// A session that left this scene takes its character history with it. The
// Dogma events collected for it still reach it, as one OnMultiEvent now: no
// later doPostTick of this scene carries them. It is the one send outside
// doPostTick, with the after-batch work asked to run even if it left.
dropDestinyObserver(session) {
    const key = observerKey(session);
    if (key === null) {
      return;
    }
    const dogma = destinyHistory.dropObserver(this.getDestinyHistory(), key);
    if (dogma.length > 0) {
      sendDogmaMultiEvent(session, dogma);
    }

    if (this._pendingSetStates instanceof Map) {
      this._pendingSetStates.delete(key);
    }
    if (this._afterDestinyBatch instanceof Map) {
      const pending = this._afterDestinyBatch.get(key);
      this._afterDestinyBatch.delete(key);
      if (pending) {
        this.runAfterBatchWork(session, pending.fns.filter((entry) => entry.runIfLeft));
      }
    }
  },
};
