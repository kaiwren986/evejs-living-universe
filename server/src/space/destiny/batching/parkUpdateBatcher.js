"use strict";

const path = require("path");

// Park batching behavior is adapted from carbonengine/destiny v3.1.1.
// Copyright (c) 2026 CCP Games; MIT terms are in batching/README.md.
const {
  DESTINY_NOTIFICATION_NAME,
} = require(path.join(__dirname, "../delivery/michelleContract"));

// CCP's ParkUpdateBatcher tells Michelle how many Destiny batches a client
// must wait for in the current tick. The target client does not expose that
// value on its live Michelle tuple, so these counts remain planner metadata.
const CLIENT_UPDATE_COUNT_THIS_TICK = Object.freeze({
  NONE: 0,
  ONE: 1,
  TWO: 2,
});

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeClientID(value) {
  return toInt(value, 0);
}

function normalizeClientIDs(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const clientID = normalizeClientID(value);
    if (clientID <= 0 || seen.has(clientID)) {
      continue;
    }
    seen.add(clientID);
    result.push(clientID);
  }
  return result;
}

function hasState(state) {
  return Array.isArray(state)
    ? state.length > 0
    : state !== undefined && state !== null && state !== false;
}

function buildDelivery(kind, clients, state, waitForBubble, updateCount, meta = {}) {
  return {
    kind,
    clients: normalizeClientIDs(clients),
    notificationName: DESTINY_NOTIFICATION_NAME,
    state,
    waitForBubble: waitForBubble === true,
    updateCount: toInt(updateCount, CLIENT_UPDATE_COUNT_THIS_TICK.ONE),
    ...meta,
  };
}

function normalizeBubbleHistories(bubbleHistories) {
  return (Array.isArray(bubbleHistories) ? bubbleHistories : [])
    .filter((entry) => entry && hasState(entry.state))
    .map((entry) => ({
      // A Grid bubble id as the park labels it (destiny/visibility/gridBubbles.js).
      bubbleID: entry.bubbleID,
      clientIDs: normalizeClientIDs(entry.clientIDs),
      state: entry.state,
    }))
    .filter((entry) => entry.clientIDs.length > 0);
}

function normalizeCharacterHistories(characterHistories) {
  return (Array.isArray(characterHistories) ? characterHistories : [])
    .filter((entry) => entry && hasState(entry.state))
    .map((entry) => ({
      characterID: toInt(entry.characterID, 0),
      clientID: normalizeClientID(entry.clientID),
      state: entry.state,
    }))
    .filter((entry) => entry.clientID > 0);
}

// Direct port of the official lane split. It returns a pure delivery plan;
// runtime dispatch remains the sole network adapter.
function buildParkUpdateDeliveryPlan(options = {}) {
  const bubbleHistories = normalizeBubbleHistories(options.bubbleHistories);
  const characterHistories = normalizeCharacterHistories(
    options.characterHistories,
  );
  const clientsWithCharacterHistory = new Set(
    characterHistories.map((entry) => entry.clientID),
  );
  const clientsWaitingForBubble = new Set();
  const singleBatchNarrowcasts = [];
  const dualBatchNarrowcasts = [];
  const singlecasts = [];

  for (const bubble of bubbleHistories) {
    const dualClients = [];
    const singleClients = [];
    for (const clientID of bubble.clientIDs) {
      if (clientsWithCharacterHistory.has(clientID)) {
        dualClients.push(clientID);
      } else {
        singleClients.push(clientID);
      }
      clientsWaitingForBubble.add(clientID);
    }

    if (singleClients.length > 0) {
      singleBatchNarrowcasts.push(buildDelivery(
        "bubble-single-batch",
        singleClients,
        bubble.state,
        false,
        CLIENT_UPDATE_COUNT_THIS_TICK.ONE,
        { bubbleID: bubble.bubbleID },
      ));
    }
    if (dualClients.length > 0) {
      dualBatchNarrowcasts.push(buildDelivery(
        "bubble-dual-batch",
        dualClients,
        bubble.state,
        false,
        CLIENT_UPDATE_COUNT_THIS_TICK.TWO,
        { bubbleID: bubble.bubbleID },
      ));
    }
  }

  for (const character of characterHistories) {
    const waitForBubble = clientsWaitingForBubble.has(character.clientID);
    singlecasts.push(buildDelivery(
      "character",
      [character.clientID],
      character.state,
      waitForBubble,
      waitForBubble
        ? CLIENT_UPDATE_COUNT_THIS_TICK.TWO
        : CLIENT_UPDATE_COUNT_THIS_TICK.ONE,
      { characterID: character.characterID },
    ));
  }

  return {
    clientsWaitingForBubble,
    clientsWithCharacterHistory,
    singlecasts,
    singleBatchNarrowcasts,
    dualBatchNarrowcasts,
    deliveryOrder: [
      ...singlecasts,
      ...singleBatchNarrowcasts,
      ...dualBatchNarrowcasts,
    ],
  };
}

module.exports = {
  CLIENT_UPDATE_COUNT_THIS_TICK,
  DESTINY_NOTIFICATION_NAME,
  buildParkUpdateDeliveryPlan,
};
