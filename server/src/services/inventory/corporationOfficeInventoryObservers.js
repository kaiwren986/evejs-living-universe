"use strict";

/**
 * Corporation office hangar change fan-out, reachable from outside invbroker.
 *
 * A corporation division hangar is shared state with private state's plumbing.
 * The client caches a division's contents from the List it made when the hangar
 * was opened and only ever revises that cache from an OnItemChange; its refresh
 * and its search both read the cache rather than the server. So a member whose
 * client is told nothing sees a stale division until they relog -- refreshing
 * cannot help them, because refreshing does not ask.
 *
 * invBrokerService already fans a change out to the other members watching a
 * division, but only for the moves it handles itself. Every other writer -- an
 * industry job delivering into a division, a contract settling, reprocessing
 * outputs landing, a sell order taking goods into escrow -- notified only the
 * acting character, so a two-member corporation saw two different hangars.
 *
 * This module is the seam: invbroker registers its live instance here, and the
 * other writers publish through `fanCorporationOfficeInventoryChanges` after
 * their own per-session sync. Keeping the projection and the authorization in
 * invbroker rather than copying them was deliberate -- see
 * `_projectCorporationOfficeInventoryChange`, which decides what an observer
 * allowed only one endpoint of a cross-division move may be told. A second
 * implementation of that rule is a second chance to leak a division name.
 */

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));

let observerSource = null;

/**
 * Record the live invbroker instance. Called from its constructor; the bound
 * contexts the fan-out walks are that instance's own state, so there is
 * nothing useful to publish through before it exists.
 */
function registerCorporationOfficeObserverSource(service) {
  if (
    !service ||
    typeof service._emitInventoryChangesToBoundCorporationOfficeObservers !==
      "function"
  ) {
    return false;
  }
  observerSource = service;
  return true;
}

/**
 * Normalize a change to the shape the fan-out reads.
 *
 * Grant and settlement helpers across the tree spell the old-value dictionary
 * `previousState`; invbroker and the notification builders spell it
 * `previousData`. The fan-out reads `previousData`, and a change that arrives
 * with only `previousState` would otherwise look like it had no previous
 * endpoint at all -- which is exactly the case that decides whether an
 * observer is told a removal or a creation.
 */
function normalizeChange(change) {
  if (!change || typeof change !== "object") {
    return null;
  }
  if (change.previousData || !change.previousState) {
    return change;
  }
  return { ...change, previousData: change.previousState };
}

/**
 * Every distinct owner named by a batch, on either endpoint of a move.
 *
 * The fan-out filters one corporation per call, so a batch that moves a
 * character's goods and a corporation's in the same breath -- a contract
 * settling, a reprocess drawing corporation ore into a character's output --
 * has to be published once per owner.
 *
 * Owners are read off the changes rather than taken from the caller on
 * purpose. A corporation hangar item's ownerID IS the corporation, so the
 * batch already carries the answer; asking the caller instead invites the one
 * bug this seam exists to avoid, a settlement naming the acting character's
 * corporation for goods owned by a different one. Owners that are not
 * corporations cost a lookup and match no office.
 */
function collectCandidateOwnerIDs(changes) {
  const owners = new Set();
  for (const change of changes) {
    for (const itemState of [change.item, change.previousData]) {
      const ownerID = Number(itemState && itemState.ownerID) || 0;
      if (ownerID > 0) {
        owners.add(ownerID);
      }
    }
  }
  return [...owners];
}

/**
 * Fan inventory changes out to the other corporation members watching the
 * affected division hangars.
 *
 * Publishes nothing on its own account: a change that does not name a
 * corporation hangar flag, or whose owner holds no office at that location, is
 * dropped by the fan-out. Callers pass their whole change list rather than
 * pre-filtering it.
 *
 * @param {object[]} changes           inventory changes, as the grant helpers build them
 * @param {object}   [options]
 * @param {object}   [options.actorSession]   session that caused the change, excluded from the fan-out
 * @param {object[]} [options.excludeSessions] sessions the writer already synced itself, also excluded
 * @param {number}   [options.corporationID]  publish for this corporation only, instead of every owner named
 * @param {boolean}  [options.emitItemsChangedBatch] batch the rows instead of one notification each
 * @returns {number} observer notifications sent, counted once per corporation published
 */
function fanCorporationOfficeInventoryChanges(changes = [], options = {}) {
  if (!observerSource) {
    return 0;
  }
  const normalizedChanges = (Array.isArray(changes) ? changes : [])
    .map(normalizeChange)
    .filter(Boolean);
  if (normalizedChanges.length <= 0) {
    return 0;
  }

  const corporationIDs = options.corporationID
    ? [Number(options.corporationID) || 0].filter((id) => id > 0)
    : collectCandidateOwnerIDs(normalizedChanges);

  let recipientCount = fanStarbaseInventoryChanges(normalizedChanges, options);
  for (const corporationID of corporationIDs) {
    try {
      recipientCount +=
        observerSource._emitInventoryChangesToBoundCorporationOfficeObservers(
          options.actorSession || null,
          normalizedChanges,
          {
            corporationID,
            excludeSessions: Array.isArray(options.excludeSessions) ? options.excludeSessions : [],
            emitItemsChangedBatch: options.emitItemsChangedBatch === true,
            maxRowsPerNotification: options.maxRowsPerNotification,
          },
        ) || 0;
    } catch (error) {
      // Every caller reaches this after its own state is durable. A broken
      // observer connection must not turn a committed delivery into a failure,
      // and one corporation's bad session must not cost the next one its rows.
      log.warn(
        `[CorpOfficeObservers] fan-out failed for corporation ${corporationID}: ${
          error && error.message
        }`,
      );
    }
  }
  return recipientCount;
}

// Industry and fuel settlements can originate remotely, without an actor on
// the POS grid. Reuse the live broker's bound-inventory projection and per-
// division authority; never broadcast raw corporation contents to a scene.
function fanStarbaseInventoryChanges(changes = [], options = {}) {
  if (!observerSource || typeof observerSource._emitInventoryChangesToBoundSpaceObservers !== "function") return 0;
  const inventory = require("./itemStore");
  const storage = require("../starbase/starbaseInventoryRuntime");
  const normalized = (Array.isArray(changes) ? changes : []).map(normalizeChange).filter(Boolean);
  const systemIDs = new Set();
  for (const change of normalized) {
    for (const state of [change.item, change.previousData]) {
      const container = state && inventory.findItemById(state.locationID);
      if (storage.isStarbaseStorage(container)) systemIDs.add(Number(container.spaceState?.systemID) || 0);
    }
  }
  if (systemIDs.size === 0) return 0;
  const representatives = new Map();
  for (const session of require("../chat/sessionRegistry").getSessions()) {
    const systemID = Number(session?._space?.systemID) || 0;
    if (systemID > 0 && systemIDs.has(systemID) && !representatives.has(systemID)) representatives.set(systemID, session);
  }
  const excludeSessions = [...(options.excludeSessions || []), options.actorSession].filter(Boolean);
  let recipients = 0;
  for (const session of representatives.values()) {
    try {
      recipients += observerSource._emitInventoryChangesToBoundSpaceObservers(session, normalized,
        { ...options, includeActor: true, excludeSessions }) || 0;
    } catch (error) {
      log.warn(`[StarbaseInventoryObservers] settlement fan-out failed: ${error.message}`);
    }
  }
  return recipients;
}

module.exports = {
  registerCorporationOfficeObserverSource,
  fanCorporationOfficeInventoryChanges,
  fanStarbaseInventoryChanges,
};
