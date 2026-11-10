"use strict";

const incrementalMetadata = Symbol("dungeonRuntimeIndexes");
const MAX_ARRAY_INDEX = 0xffff_ffff;

function lowerBound(values, value, compare) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compare(values[middle], value) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

const compareIDs = (left, right) => left - right;
const compareExpiry = (left, right) => (
  left.expiresAtMs - right.expiresAtMs || left.instanceID - right.instanceID
);

function removeSorted(values, value, compare) {
  const index = lowerBound(values, value, compare);
  if (index < values.length && compare(values[index], value) === 0) {
    values.splice(index, 1);
  }
}

function addSorted(values, value, compare) {
  const index = lowerBound(values, value, compare);
  if (index >= values.length || compare(values[index], value) !== 0) {
    values.splice(index, 0, value);
  }
}

function updateMembership(index, beforeKey, afterKey, instanceID) {
  if (beforeKey === afterKey) return;
  if (beforeKey !== null) {
    const members = index.get(String(beforeKey));
    if (members) {
      removeSorted(members, instanceID, compareIDs);
      if (members.length === 0) index.delete(String(beforeKey));
    }
  }
  if (afterKey !== null) {
    const key = String(afterKey);
    let members = index.get(key);
    if (!members) index.set(key, (members = []));
    addSorted(members, instanceID, compareIDs);
  }
}

function expiryEntry(instance, metadata, universeOnly = false) {
  if (
    !instance ||
    !metadata.isActiveLifecycleState(instance.lifecycleState) ||
    (universeOnly && !metadata.isUniversePersistentInstance(instance))
  ) return null;
  const expiresAtMs = instance.timers.expiresAtMs;
  return expiresAtMs > 0 ? { instanceID: instance.instanceID, expiresAtMs } : null;
}

function updateExpiry(values, before, after) {
  if ((!before && !after) || (before && after && compareExpiry(before, after) === 0)) {
    return;
  }
  if (before) removeSorted(values, before, compareExpiry);
  if (after) addSorted(values, after, compareExpiry);
}

// Object.values visits array-index keys numerically, then other keys in insertion
// order. Site-key lookup historically chooses the first active member in that
// order, or the final member when they are all terminal.
function compareSiteMembers(metadata, left, right) {
  const leftIsIndex = left < MAX_ARRAY_INDEX;
  const rightIsIndex = right < MAX_ARRAY_INDEX;
  if (leftIsIndex && rightIsIndex) return left - right;
  if (leftIsIndex !== rightIsIndex) return leftIsIndex ? -1 : 1;
  return metadata.insertionOrder.get(left) - metadata.insertionOrder.get(right);
}

function buildPendingSiteHazardEntry(instance) {
  if (!instance) return null;
  const pendingEvents = Object.values(instance?.spawnState?.siteHazardDamageEventsByID || {})
    .filter(event => event.status !== "delivered");
  // Old mine intents were saved before their shared outbox entry. Include
  // those frozen victims in this same index so cold admission can recover them.
  pendingEvents.push(...require("./fracturedLegacySceneActions").pendingMineEvents(instance));
  return pendingEvents.length > 0 ? { instanceID: instance.instanceID, pendingEvents } : null;
}

function listPendingSiteHazardEntries(cache) {
  const metadata = cache[incrementalMetadata];
  return [...cache.pendingSiteHazardEntriesByID.values()]
    .sort((left, right) => compareSiteMembers(metadata, left.instanceID, right.instanceID));
}

function initializeIncrementalIndexes(cache, dependencies) {
  const metadata = {
    ...dependencies,
    insertionOrder: new Map(),
    nextInsertionOrder: 0,
    siteMembers: new Map(),
  };
  cache.pendingSiteHazardEntriesByID = new Map();
  for (const key of Object.keys(cache.state.instancesByID || {})) {
    const instance = cache.state.instancesByID[key];
    const hazardEntry = buildPendingSiteHazardEntry(instance);
    if (hazardEntry) cache.pendingSiteHazardEntriesByID.set(instance.instanceID, hazardEntry);
    metadata.insertionOrder.set(instance.instanceID, metadata.nextInsertionOrder++);
    if (!instance.siteKey) continue;
    let members = metadata.siteMembers.get(instance.siteKey);
    if (!members) metadata.siteMembers.set(instance.siteKey, (members = []));
    members.push(instance.instanceID);
  }
  cache[incrementalMetadata] = metadata;
  return cache;
}

// The caller supplies normalized, canonical instance IDs and calls this only
// after the complete persistence operation succeeds. New/reinserted string-key
// rows appear in changes in their final insertion order. Unchanged memberships
// never touch their arrays, so an ordinary spawn update does no global index work.
function updateIncrementalIndexes(cache, changes, nextState) {
  const metadata = cache[incrementalMetadata];
  const affectedSites = new Set();
  const reorderedSites = new Set();

  for (const [key, change] of changes) {
    const { before, after } = change;
    const instanceID = Number(key);
    const beforeActive = Boolean(before && metadata.isActiveLifecycleState(before.lifecycleState));
    const afterActive = Boolean(after && metadata.isActiveLifecycleState(after.lifecycleState));
    const beforeSite = before && before.siteKey || null;
    const afterSite = after && after.siteKey || null;
    const siteMembershipChanged = beforeSite !== afterSite || change.orderChanged === true;

    if (siteMembershipChanged && beforeSite) {
      const members = metadata.siteMembers.get(beforeSite);
      if (members) {
        const index = members.indexOf(instanceID);
        if (index >= 0) members.splice(index, 1);
        if (members.length === 0) metadata.siteMembers.delete(beforeSite);
      }
      reorderedSites.add(beforeSite);
      affectedSites.add(beforeSite);
    }
    if (!after) metadata.insertionOrder.delete(instanceID);
    else if (!before || change.orderChanged === true) {
      metadata.insertionOrder.set(instanceID, metadata.nextInsertionOrder++);
    }

    if (after) {
      cache.instancesByID.set(instanceID, after);
      cache.summariesByID.set(instanceID, metadata.buildInstanceSummary(after));
    } else {
      cache.instancesByID.delete(instanceID);
      cache.summariesByID.delete(instanceID);
    }
    const hazardEntry = after && buildPendingSiteHazardEntry(after);
    if (hazardEntry) cache.pendingSiteHazardEntriesByID.set(instanceID, hazardEntry);
    else cache.pendingSiteHazardEntriesByID.delete(instanceID);

    updateMembership(cache.instanceIDsBySystem,
      before ? before.solarSystemID : null, after ? after.solarSystemID : null, instanceID);
    updateMembership(cache.activeInstanceIDsBySystem,
      beforeActive ? before.solarSystemID : null, afterActive ? after.solarSystemID : null, instanceID);
    updateMembership(cache.instanceIDsByTemplate,
      before ? before.templateID : null, after ? after.templateID : null, instanceID);
    updateMembership(cache.instanceIDsByFamily,
      before ? before.siteFamily : null, after ? after.siteFamily : null, instanceID);
    updateMembership(cache.instanceIDsByLifecycle,
      before ? before.lifecycleState : null, after ? after.lifecycleState : null, instanceID);
    updateExpiry(cache.activeExpiringEntries,
      expiryEntry(before, metadata), expiryEntry(after, metadata));
    updateExpiry(cache.activeUniversePersistentExpiringEntries,
      expiryEntry(before, metadata, true), expiryEntry(after, metadata, true));

    const beforeTerminal = Boolean(before && !beforeActive && metadata.isUniversePersistentInstance(before));
    const afterTerminal = Boolean(after && !afterActive && metadata.isUniversePersistentInstance(after));
    if (beforeTerminal !== afterTerminal) {
      if (beforeTerminal) removeSorted(cache.universePersistentTerminalInstanceIDs, instanceID, compareIDs);
      if (afterTerminal) addSorted(cache.universePersistentTerminalInstanceIDs, instanceID, compareIDs);
    }

    if (siteMembershipChanged && afterSite) {
      let members = metadata.siteMembers.get(afterSite);
      if (!members) metadata.siteMembers.set(afterSite, (members = []));
      members.push(instanceID);
      reorderedSites.add(afterSite);
      affectedSites.add(afterSite);
    } else if (beforeActive !== afterActive && afterSite) {
      affectedSites.add(afterSite);
    }
  }

  for (const siteKey of reorderedSites) {
    const members = metadata.siteMembers.get(siteKey);
    if (members) members.sort((left, right) => compareSiteMembers(metadata, left, right));
  }
  for (const siteKey of affectedSites) {
    const members = metadata.siteMembers.get(siteKey);
    if (!members || members.length === 0) {
      cache.instanceIDBySiteKey.delete(siteKey);
      continue;
    }
    const active = members.find((id) => metadata.isActiveLifecycleState(cache.instancesByID.get(id).lifecycleState));
    cache.instanceIDBySiteKey.set(siteKey, active === undefined ? members[members.length - 1] : active);
  }
  cache.nextActiveExpiryAtMs = cache.activeExpiringEntries[0]?.expiresAtMs || 0;
  cache.nextUniversePersistentActiveExpiryAtMs = cache.activeUniversePersistentExpiringEntries[0]?.expiresAtMs || 0;
  cache.state = nextState;
  return cache;
}

module.exports = {
  buildPendingSiteHazardEntry,
  listPendingSiteHazardEntries,
  initializeIncrementalIndexes,
  updateIncrementalIndexes,
};
