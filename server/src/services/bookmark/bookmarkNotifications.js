"use strict";

const path = require("path");

const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const runtime = require(path.join(__dirname, "./bookmarkRuntimeState"));
const access = require(path.join(__dirname, "./bookmarkRuntimeAccess"));
const {
  ACCESS_NONE,
  BOOKMARKS_ADDED,
  BOOKMARKS_MOVED,
  BOOKMARKS_REMOVED,
  BOOKMARKS_UPDATED,
  FOLDER_UPDATED,
  SUBFOLDER_ADDED,
  SUBFOLDER_REMOVED,
  SUBFOLDER_UPDATED,
} = require(path.join(__dirname, "./bookmarkConstants"));
const {
  buildBookmarkIDSet,
  buildBookmarkPayload,
  buildBookmarkText,
  buildFolderUpdateTuple,
  buildSubfolderPayload,
} = require(path.join(__dirname, "./bookmarkPayloads"));
const {
  buildDict,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

// ---------------------------------------------------------------------------
// Pure update-tuple builders
//
// Each returns the [target, updateType, updateArgs] triple the client unpacks
// in bookmarkSvc.OnSharedBookmarksFolderUpdated. They are the single source of
// truth for the broadcast payload shape (the notify* helpers below send these),
// and are exported so payload-parity tests can assert the unicode-safe shape
// directly. Bookmark lists are wrapped as marshal lists so the client iterates
// `for bm in updateArgs`.
// ---------------------------------------------------------------------------

function buildBookmarksAddedUpdate(folderID, bookmarks) {
  return buildFolderUpdateTuple(
    folderID,
    BOOKMARKS_ADDED,
    buildList((Array.isArray(bookmarks) ? bookmarks : []).map(buildBookmarkPayload)),
  );
}

function buildBookmarksUpdatedUpdate(folderID, bookmarks) {
  return buildFolderUpdateTuple(
    folderID,
    BOOKMARKS_UPDATED,
    buildList((Array.isArray(bookmarks) ? bookmarks : []).map(buildBookmarkPayload)),
  );
}

function buildBookmarksRemovedUpdate(folderID, bookmarkIDs) {
  return buildFolderUpdateTuple(folderID, BOOKMARKS_REMOVED, buildBookmarkIDSet(bookmarkIDs));
}

function buildBookmarksMovedUpdate(oldFolderID, newFolderID, bookmarks) {
  return buildFolderUpdateTuple(oldFolderID, BOOKMARKS_MOVED, [
    buildList((Array.isArray(bookmarks) ? bookmarks : []).map(buildBookmarkPayload)),
    Number(oldFolderID) || 0,
    Number(newFolderID) || 0,
  ]);
}

function buildFolderUpdatedUpdate(folderID, folderName, description) {
  return buildFolderUpdateTuple(folderID, FOLDER_UPDATED, [
    buildBookmarkText(folderName, 40, ""),
    buildBookmarkText(description, 3900, ""),
  ]);
}

function buildSubfolderAddedUpdate(folderID, subfolder) {
  return buildFolderUpdateTuple(folderID, SUBFOLDER_ADDED, buildSubfolderPayload(subfolder));
}

function buildSubfolderUpdatedUpdate(folderID, subfolderID, subfolderName) {
  return buildFolderUpdateTuple(folderID, SUBFOLDER_UPDATED, [
    Number(subfolderID) || 0,
    buildBookmarkText(subfolderName, 40, ""),
  ]);
}

function buildSubfolderRemovedUpdate(folderID, subfolderID) {
  return buildFolderUpdateTuple(folderID, SUBFOLDER_REMOVED, Number(subfolderID) || 0);
}

function getCharacterID(session) {
  return Number(session && session.characterID) || 0;
}

function getActiveFolderView(characterID, folderID) {
  try {
    const view = runtime.getFolderInfo(characterID, folderID);
    return view && view.isActive ? view : null;
  } catch (error) {
    // ignored: a folder that cannot be read has no active view (null)
    return null;
  }
}

function collectRecipientSessions(folderIDs = [], excludeCharacterID = 0) {
  const normalizedFolderIDs = [...new Set((Array.isArray(folderIDs) ? folderIDs : [folderIDs]).map((folderID) => Number(folderID) || 0).filter((folderID) => folderID > 0))];
  if (normalizedFolderIDs.length <= 0) {
    return [];
  }
  return sessionRegistry.getSessions().filter((session) => {
    const characterID = getCharacterID(session);
    if (!characterID || characterID === excludeCharacterID) {
      return false;
    }
    return normalizedFolderIDs.some((folderID) => getActiveFolderView(characterID, folderID));
  });
}

/**
 * Snapshot active shared-folder recipients before an operation removes their
 * known-folder records. The snapshot is sent only after the caller confirms
 * that its mutation succeeded.
 */
function captureFolderRecipients(folderIDs, options = {}) {
  return collectRecipientSessions(folderIDs, Number(options.excludeCharacterID || 0));
}

function sendFolderUpdated(folderIDs, updateTuple, excludeCharacterID = 0) {
  const recipients = collectRecipientSessions(folderIDs, excludeCharacterID);
  if (recipients.length <= 0) {
    return;
  }
  for (const session of recipients) {
    session.sendNotification("OnSharedBookmarksFolderUpdated", "clientID", [[updateTuple]]);
  }
}

function notifyBookmarksAdded(folderID, bookmarks, options = {}) {
  if (!Array.isArray(bookmarks) || bookmarks.length <= 0) {
    return;
  }
  sendFolderUpdated(
    [folderID],
    buildBookmarksAddedUpdate(folderID, bookmarks),
    Number(options.excludeCharacterID || 0),
  );
}

function notifyBookmarksUpdated(folderID, bookmarks, options = {}) {
  if (!Array.isArray(bookmarks) || bookmarks.length <= 0) {
    return;
  }
  sendFolderUpdated(
    [folderID],
    buildBookmarksUpdatedUpdate(folderID, bookmarks),
    Number(options.excludeCharacterID || 0),
  );
}

function notifyBookmarksRemoved(folderID, bookmarkIDs, options = {}) {
  if (!Array.isArray(bookmarkIDs) || bookmarkIDs.length <= 0) {
    return;
  }
  sendFolderUpdated(
    [folderID],
    buildBookmarksRemovedUpdate(folderID, bookmarkIDs),
    Number(options.excludeCharacterID || 0),
  );
}

function notifyBookmarksMoved(oldFolderID, newFolderID, bookmarks, options = {}) {
  if (!Array.isArray(bookmarks) || bookmarks.length <= 0) {
    return;
  }
  sendFolderUpdated(
    [oldFolderID, newFolderID],
    buildBookmarksMovedUpdate(oldFolderID, newFolderID, bookmarks),
    Number(options.excludeCharacterID || 0),
  );
}

function notifyFolderUpdated(folderID, folder, options = {}) {
  sendFolderUpdated(
    [folderID],
    buildFolderUpdatedUpdate(folderID, folder && folder.folderName, folder && folder.description),
    Number(options.excludeCharacterID || 0),
  );
}

function notifySubfolderAdded(folderID, subfolder, options = {}) {
  sendFolderUpdated(
    [folderID],
    buildSubfolderAddedUpdate(folderID, subfolder),
    Number(options.excludeCharacterID || 0),
  );
}

function notifySubfolderUpdated(folderID, subfolderID, subfolderName, options = {}) {
  sendFolderUpdated(
    [folderID],
    buildSubfolderUpdatedUpdate(folderID, subfolderID, subfolderName),
    Number(options.excludeCharacterID || 0),
  );
}

function notifySubfolderRemoved(folderID, subfolderID, options = {}) {
  sendFolderUpdated(
    [folderID],
    buildSubfolderRemovedUpdate(folderID, subfolderID),
    Number(options.excludeCharacterID || 0),
  );
}

function notifyFolderDeleted(folderID, options = {}) {
  const recipients = Array.isArray(options.recipients)
    ? options.recipients
    : collectRecipientSessions([folderID], Number(options.excludeCharacterID || 0));
  for (const session of recipients) {
    session.sendNotification("OnSharedBookmarksFolderDeleted", "clientID", [Number(folderID) || 0]);
  }
}

// ---------------------------------------------------------------------------
// Shared-folder access changes
//
// The client keeps every known folder (active or not) in bookmarkSvc.foldersNew
// with its accessLevel. When a folder edit, an access-group membership change
// or a group deletion changes what a character may do with a shared folder,
// the client must be told: OnSharedBookmarksFoldersAccessLost([folderIDs])
// drops the folder and its cached bookmarks, and
// OnSharedBookmarksFoldersAccessChanged({folderID: accessLevel}) updates the
// level that gates the add/edit/delete controls (bookmarkSvc.py:332-347).
// ---------------------------------------------------------------------------

/**
 * Snapshot the shared-folder access level of every online character for the
 * folders they know. Taken before a mutation; pass the result to
 * notifyFolderAccessChanges after it succeeds.
 */
function captureFolderAccess(options = {}) {
  // options.characterIDs limits the snapshot to those pilots, for changes that
  // can only affect them (their own corporation or alliance moved).
  const onlyCharacterIDs = Array.isArray(options && options.characterIDs)
    ? new Set(options.characterIDs.map(Number).filter((value) => value > 0))
    : null;
  const snapshot = new Map();
  for (const session of sessionRegistry.getSessions()) {
    const characterID = getCharacterID(session);
    if (!characterID || (onlyCharacterIDs && !onlyCharacterIDs.has(Number(characterID)))) {
      continue;
    }
    let entry = snapshot.get(characterID);
    if (!entry) {
      const levels = new Map();
      for (const known of access.listKnownFoldersForCharacter(characterID)) {
        if (!known.folder || known.folder.isPersonal) {
          continue;
        }
        levels.set(
          Number(known.folder.folderID),
          access.resolveFolderAccessLevel(characterID, known.folder.folderID),
        );
      }
      entry = { levels, sessions: [] };
      snapshot.set(characterID, entry);
    }
    entry.sessions.push(session);
  }
  return snapshot;
}

/**
 * Compare a snapshot from captureFolderAccess with the current access levels
 * and push AccessLost / AccessChanged to the affected characters' sessions.
 */
function notifyFolderAccessChanges(snapshot, options = {}) {
  if (!(snapshot instanceof Map)) {
    return [];
  }
  const excludeCharacterID = Number(options.excludeCharacterID || 0);
  const sent = [];
  for (const [characterID, entry] of snapshot) {
    if (characterID === excludeCharacterID || !entry || entry.levels.size <= 0) {
      continue;
    }
    const lostFolderIDs = [];
    const changed = [];
    for (const [folderID, previousLevel] of entry.levels) {
      const currentLevel = access.resolveFolderAccessLevel(characterID, folderID);
      if (currentLevel <= ACCESS_NONE) {
        lostFolderIDs.push(folderID);
      } else if (currentLevel !== previousLevel) {
        changed.push([folderID, currentLevel]);
      }
    }
    if (lostFolderIDs.length <= 0 && changed.length <= 0) {
      continue;
    }
    for (const session of entry.sessions) {
      if (!session || typeof session.sendNotification !== "function") {
        continue;
      }
      if (lostFolderIDs.length > 0) {
        session.sendNotification(
          "OnSharedBookmarksFoldersAccessLost",
          "clientID",
          [buildList(lostFolderIDs)],
        );
      }
      if (changed.length > 0) {
        session.sendNotification(
          "OnSharedBookmarksFoldersAccessChanged",
          "clientID",
          [buildDict(changed)],
        );
      }
    }
    sent.push({ characterID, lostFolderIDs, changed });
  }
  return sent;
}

module.exports = {
  buildBookmarksAddedUpdate,
  buildBookmarksMovedUpdate,
  buildBookmarksRemovedUpdate,
  buildBookmarksUpdatedUpdate,
  buildFolderUpdatedUpdate,
  captureFolderAccess,
  captureFolderRecipients,
  buildSubfolderAddedUpdate,
  buildSubfolderRemovedUpdate,
  buildSubfolderUpdatedUpdate,
  notifyBookmarksAdded,
  notifyBookmarksMoved,
  notifyBookmarksRemoved,
  notifyBookmarksUpdated,
  notifyFolderAccessChanges,
  notifyFolderDeleted,
  notifyFolderUpdated,
  notifySubfolderAdded,
  notifySubfolderRemoved,
  notifySubfolderUpdated,
};
