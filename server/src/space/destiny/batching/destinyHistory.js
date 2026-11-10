"use strict";

// The one stamped action list and its histories (retail: carbon-destiny v2.1.1
// _ticker.py, _parkupdatebatcher.py).
//
// Retail keeps one system history: every Ballpark action and every Destiny
// update is queued in call order, stamped with the next Destiny tick when it
// is queued (`nextDestinyStamp`), and nothing changes the stamp afterwards.
// The Movement queue is the same list. A Destiny tick's doPreTick, as
// retail's Ticker.tick (_ticker.py:59-131), applies each queued Ballpark
// action (a movement change, a cloak) in call order, an action that throws
// skipped (applyQueue); then the scene runs the Grid bubble update;
// then every update is routed (routeApplied), in call order, by the
// memberships that update left:
//
//   - about a visible Ball: to the history of the Ball's Grid bubble (or of
//     the bubble the update names, CloakBall's old one);
//   - about a cloaked Ball, or meant for one Observer (SetState, the uncloak
//     add, its own items): to that Observer's character history;
//   - a global Ball's add or removal: to every Grid bubble's history.
//
// What is queued with a tick's stamp while its list applies (an applied
// action's own updates) is held with the list's updates, in call order, and
// routed with them; what is queued with it from then to its doPostTick lands
// in that tick's histories at once; what is stamped with the next tick waits
// for it. Every entry goes on the wire with the stamp it was queued with:
// nothing restamps it. It is always the tick that routes it (the scene
// stamps what it queues before its Evolve-only first tick with the tick
// after it); one that is not is reported through onStampMismatch,
// still with its own stamp.
//
// A character history is its in-front inserts (SetState, the uncloak add;
// the later first), then the items queued to go ahead of the tick's bubble
// entries (beforeBubbleEntries, in call order: what retail adds to a
// character history before its update_bubbles, such as a drone's
// OnDroneStateChange ahead of the drone's add), then its Grid bubble entries
// and exits (deletions then additions), then its other items. doPostTick takes
// the batches: one per Observer with a character history, and one per Grid
// bubble with a history and an Observer, shared by every Observer of the
// bubble, owner included. The delivery order and waitForBubble are
// retail's lane split (parkUpdateBatcher.buildParkUpdateDeliveryPlan): the
// character singlecasts first, each flagged waitForBubble exactly when its
// Observer also gets a bubble batch, then the bubble narrowcasts. An
// empty history sends nothing.
//
// Dogma events never enter the list: they are
// collected per Observer as they are raised (collectDogma), unstamped, and
// doPostTick sends them as the third element of the Observer's character
// batch, or as one OnMultiEvent when it has none that tick (takeBatches'
// multiEvents).
//
// Pure: no scene, no session I/O. The scene supplies the resolver.

const path = require("path");
const {
  buildParkUpdateDeliveryPlan,
} = require(path.join(__dirname, "./parkUpdateBatcher"));
const {
  isDogmaEvent,
} = require(path.join(__dirname, "../protocol/eventClasses"));

// The Ballpark actions retail's system history collapses when one is queued
// twice in a row, identical (same Ball, stamp and arguments): the 30 that
// carbon-destiny's Actions adds (python/destiny/net/server/_actions.py
// _add_to_system_history, "No use adding the same action twice in a row"),
// AddBallsToPark under its wire name AddBalls2. A Gameplay event (an
// OnSpecialFX, a slim item change) is never collapsed: two identical effects
// in a row are two effects.
const COLLAPSIBLE_BALLPARK_ACTIONS = Object.freeze(new Set([
  "AddBalls2",
  "BallNotGlobal",
  "CloakBall",
  "EntityWarpIn",
  "FollowBall",
  "GotoDirection",
  "GotoPoint",
  "LaunchMissile",
  "Orbit",
  "RemoveGlobalBall",
  "SetBallAgility",
  "SetBallAngularAgility",
  "SetBallAngularVelocity",
  "SetBallFree",
  "SetBallHarmonic",
  "SetBallInteractive",
  "SetBallMass",
  "SetBallMassive",
  "SetBallPosition",
  "SetBallRadius",
  "SetBallRotation",
  "SetBallTroll",
  "SetBallVelocity",
  "SetMaxAngularSpeed",
  "SetMaxAngularVelocity",
  "SetMaxSpeed",
  "SetSpeedFraction",
  "Stop",
  "UncloakBall",
  "WarpTo",
]));

function isCollapsibleBallparkAction(entry) {
  return Array.isArray(entry.payload) && COLLAPSIBLE_BALLPARK_ACTIONS.has(entry.payload[0]);
}

function createDestinyHistory() {
  return {
    // The one stamped list, in call order, until a doPreTick takes it.
    list: [],
    // The last update queued (for the collapse of consecutive identical
    // Ballpark actions); an applied action resets it.
    lastUpdate: null,
    // From a tick's applyQueue to its doPostTick: { stamp, resolve, bubbles,
    // isLive, held }; `held` is the list's updates, in call order, until
    // routeApplied routes them (null from then on).
    routing: null,
    // This tick's histories: bubbleID -> [[stamp, payload]].
    bubbles: new Map(),
    // observer key -> { session, front, early, transitions, items }.
    characters: new Map(),
    // observer key -> { session, events: [[event, time]] }: the Dogma events
    // raised since the last doPostTick, in raise order.
    dogma: new Map(),
  };
}

function sameValue(left, right) {
  if (left === right) {
    return true;
  }
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return typeof left === "number" && typeof right === "number" && Number.isNaN(left) && Number.isNaN(right);
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !sameValue(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function sameTarget(left, right) {
  return left.ball === right.ball &&
    left.bubble === right.bubble &&
    left.observer === right.observer &&
    left.everyBubble === right.everyBubble;
}

function sameUpdate(left, right) {
  return Boolean(left && right) &&
    left.stamp === right.stamp &&
    left.inFront === right.inFront &&
    left.beforeBubbleEntries === right.beforeBubbleEntries &&
    sameTarget(left.target, right.target) &&
    sameValue(left.payload, right.payload);
}

function characterOf(history, key, session) {
  let character = history.characters.get(key);
  if (!character) {
    character = { session, front: [], early: [], transitions: [], items: [] };
    history.characters.set(key, character);
  } else if (session) {
    character.session = session;
  }
  return character;
}

function appendBubble(history, bubble, entry) {
  const list = history.bubbles.get(bubble);
  if (list) {
    list.push(entry);
  } else {
    history.bubbles.set(bubble, [entry]);
  }
}

// Every Grid bubble with an Observer: a global Ball's update.
function appendEveryBubble(history, tuple) {
  const bubbles = history.routing.bubbles();
  for (const bubble of bubbles) {
    appendBubble(history, bubble, tuple);
  }
  return bubbles.length > 0;
}

// Routes one update into this tick's histories. Returns false when dropped
// (a Ball no longer in the park, or no Grid bubble to put it in).
function route(history, entry) {
  const routing = history.routing;
  if (entry.stamp !== routing.stamp && typeof routing.onStampMismatch === "function") {
    routing.onStampMismatch(entry, routing.stamp);
  }
  const tuple = [entry.stamp, entry.payload];
  const target = entry.target;
  if (target.everyBubble === true) {
    return appendEveryBubble(history, tuple);
  }
  let destination;
  if (target.observer !== undefined) {
    destination = { observer: target.observer, session: target.session };
  } else if (target.bubble !== undefined && target.bubble !== null) {
    destination = { bubble: target.bubble };
  } else {
    destination = routing.resolve(target);
  }
  if (!destination) {
    return false;
  }
  if (destination.everyBubble === true) {
    return appendEveryBubble(history, tuple);
  }
  if (destination.observer !== undefined) {
    const character = characterOf(history, destination.observer, destination.session);
    if (entry.inFront === true) {
      character.front.unshift(tuple);
    } else if (entry.beforeBubbleEntries === true) {
      character.early.push(tuple);
    } else {
      character.items.push(tuple);
    }
    return true;
  }
  if (destination.bubble === undefined || destination.bubble === null) {
    return false;
  }
  appendBubble(history, destination.bubble, tuple);
  return true;
}

// Queues a Ballpark action: { stamp, ball, label, apply }. doPreTick runs
// `apply`, in call order, if the Ball is still in the park.
function queueAction(history, action) {
  history.list.push({ kind: "action", ...action });
  history.lastUpdate = null;
  return true;
}

// Queues an update: { stamp, target, payload, inFront, beforeBubbleEntries }. `target` is
// { ball } (its Grid bubble), { ball, bubble } (that bubble, even once the
// Ball has left the park: a destruction effect), { observer, session }
// (that Observer's character history) or { everyBubble: true }. Returns false
// when it is a Ballpark action collapsed into the identical one queued right
// before it, or refused: a Dogma event is never a stamped entry.
function queueUpdate(history, update) {
  const entry = { kind: "update", ...update, target: update.target || {} };
  if (Array.isArray(entry.payload) && isDogmaEvent(entry.payload[0])) {
    return false;
  }
  if (isCollapsibleBallparkAction(entry) && sameUpdate(history.lastUpdate, entry)) {
    return false;
  }
  history.lastUpdate = entry;
  if (history.routing && entry.stamp === history.routing.stamp) {
    if (Array.isArray(history.routing.held)) {
      history.routing.held.push(entry);
    } else {
      route(history, entry);
    }
    return true;
  }
  history.list.push(entry);
  return true;
}

// The Grid bubble update's lists for one Observer: its character history's
// middle segment, deletions then additions, built in doPreTick.
function setTransitions(history, key, session, updates) {
  const character = characterOf(history, key, session);
  for (const update of updates) {
    character.transitions.push([update.stamp, update.payload]);
  }
}

// doPreTick, first (retail's _pre_update_bubbles, _ticker.py:104-121):
// takes the list and applies each Ballpark action in call order, an action
// about a Ball no longer in the park skipped, one that throws skipped and
// reported. Every update, the list's and those the actions queue as
// they apply with this tick's stamp, is held, in call order, for
// routeApplied. options: { stamp, resolve(target) -> { bubble } | { observer,
// session } | { everyBubble: true } | null, bubbles() -> every Grid bubble
// with an Observer, isLive(ball), onError(entry, error),
// onStampMismatch(entry, stamp) for an entry stamped with another tick }.
// Routing stays open until takeBatches.
function applyQueue(history, options) {
  const isLive = typeof options.isLive === "function" ? options.isLive : () => true;
  const result = { applied: 0, routed: 0, dropped: 0, failed: 0 };
  history.routing = {
    stamp: options.stamp,
    onStampMismatch: options.onStampMismatch,
    resolve: options.resolve,
    bubbles: typeof options.bubbles === "function" ? options.bubbles : () => [],
    isLive,
    held: [],
    result,
  };
  const list = history.list;
  history.list = [];
  for (const entry of list) {
    if (entry.kind === "action") {
      history.lastUpdate = null;
      if (!isLive(entry.ball)) {
        result.dropped += 1;
        continue;
      }
      try {
        entry.apply();
        result.applied += 1;
      } catch (error) {
        result.failed += 1;
        if (typeof options.onError === "function") {
          options.onError(entry, error);
        }
      }
      continue;
    }
    history.routing.held.push(entry);
  }
  return result;
}

// doPreTick, after the Grid bubble update (retail's _apply_history,
// _ticker.py:79-102, 123-131): routes the held updates in call order, each
// by the memberships the update left (an update about a Ball no longer in
// the park dropped, unless it names its bubble). From here to doPostTick an
// update queued with this tick's stamp is routed at once. Returns the
// tick's { applied, routed, dropped, failed }.
function routeApplied(history) {
  const routing = history.routing;
  if (!routing || !Array.isArray(routing.held)) {
    return routing && routing.result ? routing.result : { applied: 0, routed: 0, dropped: 0, failed: 0 };
  }
  const { result, isLive, held } = routing;
  routing.held = null;
  for (const entry of held) {
    if (
      entry.target.ball !== undefined &&
      (entry.target.bubble === undefined || entry.target.bubble === null) &&
      !isLive(entry.target.ball)
    ) {
      result.dropped += 1;
      continue;
    }
    if (route(history, entry)) {
      result.routed += 1;
    } else {
      result.dropped += 1;
    }
  }
  return result;
}

// Collects Dogma events for one Observer: `events` are [event, time] pairs,
// `event` the (name, ...args) tuple OnMultiEvent dispatches (godma.py:206-
// 252). They leave with the next doPostTick, unstamped.
function collectDogma(history, key, session, events) {
  const pairs = (Array.isArray(events) ? events : []).filter((pair) => (
    Array.isArray(pair) && Array.isArray(pair[0]) && typeof pair[0][0] === "string"
  ));
  if (key === null || key === undefined || pairs.length === 0) {
    return false;
  }
  let collected = history.dogma.get(key);
  if (!collected) {
    collected = { session, events: [] };
    history.dogma.set(key, collected);
  } else if (session) {
    collected.session = session;
  }
  collected.events.push(...pairs);
  return true;
}

// Whether an Observer has a collected Dogma event that `match(event)`
// accepts, still waiting for the next doPostTick.
function hasCollectedDogma(history, key, match) {
  const collected = history.dogma.get(key);
  return Boolean(collected && collected.events.some(([event]) => match(event)));
}

// doPostTick: the tick's batches, in delivery order, and the histories
// cleared. options.observers: [{ key, session, bubble }], each Observer of
// the scene as doPreTick's bubble update left it; a character history whose
// Observer is not among them (it left, or has no SetState yet) is dropped.
// Returns { deliveries: [{ kind, bubble, sessions, keys, state,
// waitForBubble, dogma }], multiEvents: [{ key, session, events }] },
// `state` the [[stamp, payload]] list: an Observer's collected Dogma events
// ride its character batch (`dogma`), and those of an Observer with no
// character batch, or no SetState yet, are its one OnMultiEvent.
function takeBatches(history, options = {}) {
  const observers = Array.isArray(options.observers) ? options.observers : [];
  const byClient = new Map();
  const byKey = new Map();
  let nextClient = 1;
  for (const observer of observers) {
    const clientID = nextClient;
    nextClient += 1;
    byClient.set(clientID, observer);
    byKey.set(observer.key, clientID);
  }

  const bubbleHistories = [];
  for (const [bubble, state] of history.bubbles) {
    if (state.length === 0) {
      continue;
    }
    const clientIDs = observers
      .filter((observer) => observer.bubble === bubble)
      .map((observer) => byKey.get(observer.key));
    if (clientIDs.length > 0) {
      bubbleHistories.push({ bubbleID: bubble, clientIDs, state });
    }
  }
  const characterHistories = [];
  const dogmaByClient = new Map();
  const dogma = history.dogma;
  for (const [key, character] of history.characters) {
    const clientID = byKey.get(key);
    const state = [...character.front, ...character.early, ...character.transitions, ...character.items];
    if (clientID === undefined || state.length === 0) {
      continue;
    }
    characterHistories.push({ clientID, state });
    // An Observer with no SetState yet (an undocking pilot) gets its Dogma
    // events as one OnMultiEvent, as TQ's undock does.
    if (dogma.has(key) && byClient.get(clientID).setStateSent !== false) {
      dogmaByClient.set(clientID, dogma.get(key).events);
      dogma.delete(key);
    }
  }
  const multiEvents = [...dogma].map(([key, collected]) => ({
    key,
    session: collected.session,
    events: collected.events,
  }));

  const plan = buildParkUpdateDeliveryPlan({ bubbleHistories, characterHistories });
  const deliveries = plan.deliveryOrder.map((delivery) => {
    const members = delivery.clients.map((clientID) => byClient.get(clientID));
    const character = delivery.kind === "character";
    return {
      kind: character ? "character" : "bubble",
      bubble: character ? members[0].bubble : delivery.bubbleID,
      keys: members.map((member) => member.key),
      sessions: members.map((member) => member.session),
      state: delivery.state,
      waitForBubble: delivery.waitForBubble,
      dogma: character ? dogmaByClient.get(delivery.clients[0]) || null : null,
    };
  });

  // A bubble's batch goes to its Observers as one narrowcast: the plan's two
  // (those with and without a character batch) carry the same object.
  const merged = [];
  const bubbleIndex = new Map();
  for (const delivery of deliveries) {
    if (delivery.kind === "bubble" && bubbleIndex.has(delivery.bubble)) {
      const into = merged[bubbleIndex.get(delivery.bubble)];
      into.keys.push(...delivery.keys);
      into.sessions.push(...delivery.sessions);
      continue;
    }
    if (delivery.kind === "bubble") {
      bubbleIndex.set(delivery.bubble, merged.length);
    }
    merged.push(delivery);
  }

  history.bubbles = new Map();
  history.characters = new Map();
  history.dogma = new Map();
  history.routing = null;
  history.lastUpdate = null;
  return { deliveries: merged, multiEvents };
}

// A session that left takes its character history with it. Returns the
// Dogma events collected for it, for the caller to hand over.
function dropObserver(history, key) {
  history.characters.delete(key);
  const collected = history.dogma.get(key);
  history.dogma.delete(key);
  return collected ? collected.events : [];
}

module.exports = {
  applyQueue,
  collectDogma,
  createDestinyHistory,
  dropObserver,
  hasCollectedDogma,
  queueAction,
  queueUpdate,
  routeApplied,
  sameValue,
  setTransitions,
  takeBatches,
};
