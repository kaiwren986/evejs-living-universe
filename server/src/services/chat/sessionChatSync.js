"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));

const SCOPED_CHAT_SESSION_KEYS = new Set([
  "corpid",
  "allianceid",
  "warfactionid",
  "fleetid",
]);
const LOCAL_CHAT_SESSION_KEYS = new Set([
  "solarsystemid2",
  "solarsystemid",
]);
// A presence refresh re-publishes what a character's presence actually
// carries: the `eve_user_data` element (corpid, allianceid, warfactionid,
// role) and the local-membership row. Only keys that appear in one of those
// payloads belong here, so `fleetid` does not: fleet membership is expressed
// by MUC room membership, and syncSessionScopedRoomMembership already
// announces the join to every occupant. Refreshing on it sent the joining
// pilot an `unavailable` for the fleet room milliseconds after putting them
// in it, which the client reads as "you left" and acts on by closing the
// fleet chat window (CATEGORY_FLEET is absent from its UNCLOSABLE_CHAT_WNDS),
// and which races the newcomer back out of the other members' rosters.
const CHAT_PRESENCE_SESSION_KEYS = new Set([
  "corpid",
  "allianceid",
  "warfactionid",
  "role",
  "corprole",
]);

function getChangeKeys(changes) {
  if (!changes) {
    return [];
  }

  if (Array.isArray(changes)) {
    return changes
      .map((entry) => (
        Array.isArray(entry) && entry.length > 0 ? String(entry[0]) : ""
      ))
      .filter(Boolean);
  }

  if (typeof changes === "object") {
    return Object.keys(changes);
  }

  return [];
}

function hasMatchingKey(changeKeys, candidates) {
  return changeKeys.some((key) => candidates.has(String(key)));
}

function getScopedAutoJoinKinds(changeKeys) {
  const normalizedKeys = new Set(changeKeys.map((key) => String(key)));
  const joinKinds = [];

  if (normalizedKeys.has("corpid")) {
    joinKinds.push("corp");
  }
  if (normalizedKeys.has("allianceid")) {
    joinKinds.push("alliance");
  }
  if (normalizedKeys.has("fleetid")) {
    joinKinds.push("fleet");
  }
  if (normalizedKeys.has("warfactionid")) {
    joinKinds.push("faction");
  }

  return joinKinds;
}

function normalizePositiveInteger(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0
    ? numericValue
    : fallback;
}

function getLocalPreviousSolarSystemID(changes) {
  if (!changes || typeof changes !== "object") {
    return 0;
  }

  const solarsystemid2Change = changes.solarsystemid2;
  if (Array.isArray(solarsystemid2Change)) {
    return normalizePositiveInteger(solarsystemid2Change[0], 0);
  }

  const solarsystemidChange = changes.solarsystemid;
  if (Array.isArray(solarsystemidChange)) {
    return normalizePositiveInteger(solarsystemidChange[0], 0);
  }

  return 0;
}

function synchronizeSessionChatState(session, changes) {
  const changeKeys = getChangeKeys(changes);
  if (!session || changeKeys.length === 0) {
    return {
      localSynced: false,
      scopedSynced: false,
      presenceRefreshed: false,
    };
  }

  const shouldSyncLocal = hasMatchingKey(changeKeys, LOCAL_CHAT_SESSION_KEYS);
  const shouldSyncScoped = hasMatchingKey(changeKeys, SCOPED_CHAT_SESSION_KEYS);
  const shouldRefreshPresence = hasMatchingKey(
    changeKeys,
    CHAT_PRESENCE_SESSION_KEYS,
  );

  if (!shouldSyncLocal && !shouldSyncScoped && !shouldRefreshPresence) {
    return {
      localSynced: false,
      scopedSynced: false,
      presenceRefreshed: false,
    };
  }

  let localSynced = false;
  let scopedSynced = false;
  let presenceRefreshed = false;

  try {
    if (shouldSyncLocal) {
      const chatHub = require(path.join(__dirname, "./chatHub"));
      if (typeof chatHub.moveLocalSession === "function") {
        localSynced = Boolean(
          chatHub.moveLocalSession(session, getLocalPreviousSolarSystemID(changes)),
        );
      }
    }

    if (shouldSyncScoped) {
      const { syncSessionScopedRoomMembership } = require(path.join(
        __dirname,
        "./xmppStubServer",
      ));
      if (typeof syncSessionScopedRoomMembership === "function") {
        scopedSynced = Boolean(
          syncSessionScopedRoomMembership(session, {
            autoJoinKinds: getScopedAutoJoinKinds(changeKeys),
          }),
        );
      }
    }

    if (shouldRefreshPresence) {
      const chatHub = require(path.join(__dirname, "./chatHub"));
      if (typeof chatHub.refreshSessionChatRolePresence === "function") {
        presenceRefreshed = Boolean(
          chatHub.refreshSessionChatRolePresence(session),
        );
      }
    }
  } catch (error) {
    log.debug(
      `[ChatSync] Skipped post-session-change chat sync: ${error.message}`,
    );
  }

  return {
    localSynced,
    scopedSynced,
    presenceRefreshed,
  };
}

module.exports = {
  LOCAL_CHAT_SESSION_KEYS,
  synchronizeSessionChatState,
  SCOPED_CHAT_SESSION_KEYS,
  CHAT_PRESENCE_SESSION_KEYS,
  getScopedAutoJoinKinds,
};
