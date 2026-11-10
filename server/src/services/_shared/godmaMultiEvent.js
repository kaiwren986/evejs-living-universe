"use strict";

/**
 * godmaMultiEvent — build Tranquility-shape godma sub-events and batch them into
 * a single `OnMultiEvent` notification.
 *
 * Decoded from a real TQ client capture (see
 * doc/PARITY_FITTING_NOTIFICATION_SEQUENCE.md). TQ delivers the dogma recalc
 * caused by a fit/unfit as ONE `OnMultiEvent` (idtype clientID) whose arg is a
 * list of `(subEvent, time)` pairs. Sub-event tuple shapes:
 *
 *   ('OnModuleAttributeChange', ownerID, itemID, attributeID, time, newValue, oldValue, time)
 *   ('OnGodmaShipEffect', itemID, effectID, time, isStart, shouldStart,
 *       [itemID, ownerID, shipID, None, None, [], effectID, None], None, duration, repeat, None)
 *
 * These are marshal TUPLEs ({type:"tuple"}), nested inside a marshal LIST.
 */

function tuple(items) {
  return { type: "tuple", items };
}

function list(items) {
  return { type: "list", items };
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ('OnModuleAttributeChange', ownerID, itemID, attributeID, time, newValue, oldValue, time)
function buildModuleAttributeChangeEvent(ownerID, itemID, attributeID, newValue, oldValue, time) {
  return tuple([
    "OnModuleAttributeChange",
    toNum(ownerID),
    toNum(itemID),
    toNum(attributeID),
    time,
    Number.isFinite(Number(newValue)) ? Number(newValue) : newValue,
    Number.isFinite(Number(oldValue)) ? Number(oldValue) : oldValue,
    time,
  ]);
}

// ('OnGodmaShipEffect', itemID, effectID, time, isStart, shouldStart,
//   [itemID, ownerID, shipID, None, None, [], effectID, None], None, duration, repeat, None)
function buildGodmaShipEffectEvent(itemID, ownerID, shipID, effectID, time, options = {}) {
  const isStart = options.isStart ? 1 : 0;
  const shouldStart = options.shouldStart ? 1 : 0;
  const duration = options.duration === undefined || options.duration === null ? -1 : toNum(options.duration, -1);
  const repeat =
    typeof options.repeat === "number"
      ? toNum(options.repeat, 0)
      : options.repeat === true;
  const targetID = options.targetID === undefined || options.targetID === null
    ? null
    : toNum(options.targetID, 0);
  const environment = tuple([
    toNum(itemID),
    toNum(ownerID),
    toNum(shipID),
    targetID,
    null,
    list([]),
    toNum(effectID),
    null,
  ]);
  return tuple([
    "OnGodmaShipEffect",
    toNum(itemID),
    toNum(effectID),
    time,
    isStart,
    shouldStart,
    environment,
    options.effectStartTime === undefined ? null : options.effectStartTime,
    duration,
    repeat,
    null,
  ]);
}

function buildOnMultiEventPayloadFromPairs(eventPairs) {
  const pairs = (Array.isArray(eventPairs) ? eventPairs : [])
    .filter(Boolean)
    .map((entry) => tuple([entry.event || entry.subEvent || entry[0], entry.time ?? entry[1]]));
  return [list(pairs)];
}

// OnMultiEvent arg = [ (subEvent, time), (subEvent, time), ... ] (single list arg).
function buildOnMultiEventPayload(subEvents, time) {
  return buildOnMultiEventPayloadFromPairs(
    (Array.isArray(subEvents) ? subEvents : [])
      .filter(Boolean)
      .map((subEvent) => ({ event: subEvent, time })),
  );
}

// The Dogma events of an OnMultiEvent: for a session in space,
// collected and sent from its scene's next doPostTick with its character
// batch (space/runtime/dogmaEvents.js); for one no Destiny tick reaches, one
// OnMultiEvent now.
function sendOnMultiEvent(session, subEvents, time) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  const events = (Array.isArray(subEvents) ? subEvents : []).filter(Boolean);
  if (events.length === 0) {
    return false;
  }
  return require("../../space/runtime/dogmaEvents").queueDogmaEventPairs(
    session,
    events.map((event) => ({ event, time })),
  );
}

function sendOnMultiEventPairs(session, eventPairs) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  const pairs = (Array.isArray(eventPairs) ? eventPairs : [])
    .filter((entry) => entry && (entry.event || entry.subEvent || entry[0]));
  if (pairs.length === 0) {
    return false;
  }
  return require("../../space/runtime/dogmaEvents").queueDogmaEventPairs(session, pairs);
}

module.exports = {
  buildModuleAttributeChangeEvent,
  buildGodmaShipEffectEvent,
  buildOnMultiEventPayload,
  buildOnMultiEventPayloadFromPairs,
  sendOnMultiEvent,
  sendOnMultiEventPairs,
};
