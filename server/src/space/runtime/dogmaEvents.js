"use strict";

// Dogma events: the one
// way Server raises OnDamageMessage, OnTarget, OnModuleAttributeChanges,
// OnGodmaShipEffect, OnGodmaFlushLocation, OnJamStart/OnJamEnd (OnJamEnd is
// the client's name for OnJamStop) and OnMultiEvent.
//
// For a session in space each event is collected by its scene, unstamped, as
// the (name, ...args) tuple godma.OnMultiEvent dispatches with its time
// (godma.py:206-252), and the next doPostTick sends it: the third element of
// the session's character batch, or one OnMultiEvent when it has none that
// tick (scene/destinyHistory.js, dispatch/batchDelivery.js). An event raised
// inside Evolve N leaves in doPostTick(N); one raised between ticks, in the
// next tick's. Its own times (a cycle's start, its duration) travel in its
// arguments as raised.
//
// A session no Destiny tick reaches (docked, or between scenes) has no
// character batch: its events leave at once, each as it always did.

const path = require("path");
const runtimeEntryDirname = path.resolve(__dirname, "..");
const {
  buildOnMultiEventPayloadFromPairs,
} = require(path.join(runtimeEntryDirname, "../services/_shared/godmaMultiEvent"));

// The scene a session is an Observer of, loaded on first use (the runtime
// pulls in the store).
function sceneForSession(session) {
  try {
    const runtime = require("../runtime");
    return runtime && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  } catch (_) {
    return null;
  }
}

function eventFileTime(session, whenMs = null) {
  const { resolveSessionNotificationFileTime } = require("./sessionNotificationTime");
  return resolveSessionNotificationFileTime(session, whenMs);
}

// Collects [event, time] pairs for `session`'s next doPostTick. Returns true
// when its scene took them.
function collect(session, pairs) {
  const scene = sceneForSession(session);
  return Boolean(
    scene &&
    typeof scene.queueDogmaEvent === "function" &&
    scene.queueDogmaEvent(session, pairs),
  );
}

// One Dogma event: what `session.sendNotification(name, idType, args)` sent
// before Dogma events joined the character batch. options.time: the event's
// file time (the pair's key); options.whenMs: its sim time, when no file time
// is given (default now); options.idType: the direct notification's id type,
// for a session with no scene.
// A batch of attribute changes as Tranquility puts it among the (event, time)
// pairs: each change its own pair, keyed by the change's own time, never an
// OnModuleAttributeChanges event wrapping the list ("Mine one cycle of asteroid
// with miner one and survey module fitted", 501:
// (('OnModuleAttributeChange', ..., 18, t, 256.3, 261.3, t'), t)).
// godma.OnMultiEvent_ files the singular ones as attribute changes and its
// BroadcastFilteredMAC keeps the last of each item's attribute in a moment
// (godma.py:212-252); a wrapper is scattered whole, past that filter. Null
// where the list is not one of changes.
function attributeChangePairs(argList, time) {
  const list = argList[0];
  const changes = Array.isArray(list)
    ? list
    : list && list.type === "list" && Array.isArray(list.items) ? list.items : null;
  if (!changes || changes.length === 0) {
    return null;
  }
  const pairs = changes.map((change) => {
    const items = change && change.type === "tuple" && Array.isArray(change.items) ? change.items : change;
    return Array.isArray(items) && items[0] === "OnModuleAttributeChange"
      ? [items, items[4] === undefined || items[4] === null ? time : items[4]]
      : null;
  });
  return pairs.every(Boolean) ? pairs : null;
}

function queueDogmaEvent(session, name, args = [], options = {}) {
  if (!session || typeof name !== "string") {
    return false;
  }
  const argList = Array.isArray(args) ? args : [args];
  const time = options.time !== undefined && options.time !== null
    ? options.time
    : eventFileTime(session, options.whenMs === undefined ? null : options.whenMs);
  const pairs = (name === "OnModuleAttributeChanges" && attributeChangePairs(argList, time)) ||
    [[[name, ...argList], time]];
  if (collect(session, pairs)) {
    return true;
  }
  if (typeof session.sendNotification !== "function") {
    return false;
  }
  session.sendNotification(name, options.idType || "clientID", argList);
  return true;
}

// Dogma events already built as OnMultiEvent pairs: [{ event, time }] or
// [event, time], `event` a (name, ...args) tuple. What sendOnMultiEvent sent
// before Dogma events joined the character batch.
function queueDogmaEventPairs(session, eventPairs) {
  if (!session) {
    return false;
  }
  const pairs = (Array.isArray(eventPairs) ? eventPairs : [])
    .filter(Boolean)
    .map((entry) => (Array.isArray(entry)
      ? [entry[0], entry[1]]
      : [entry.event || entry.subEvent, entry.time]))
    .filter(([event]) => Boolean(event));
  if (pairs.length === 0) {
    return false;
  }
  // The scene's collector reads a plain (name, ...args) tuple.
  const plainPairs = pairs.map(([event, time]) => [
    event && event.type === "tuple" && Array.isArray(event.items) ? event.items : event,
    time,
  ]);
  if (plainPairs.every(([event]) => Array.isArray(event)) && collect(session, plainPairs)) {
    return true;
  }
  if (typeof session.sendNotification !== "function") {
    return false;
  }
  session.sendNotification("OnMultiEvent", "clientID", buildOnMultiEventPayloadFromPairs(
    pairs.map(([event, time]) => ({ event, time })),
  ));
  return true;
}

module.exports = {
  queueDogmaEvent,
  queueDogmaEventPairs,
};
