"use strict";

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  normalizeNumber,
  normalizeText,
  buildKeyVal,
  extractDictEntries,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const accessGroupStore = require(path.join(__dirname, "./accessGroupStore"));
const bookmarkRuntime = require(path.join(__dirname, "../bookmark/bookmarkRuntimeState"));
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { peekCharacterRecord } = require("./characterState");
const { getCorporationRecord, getAllianceRecord } = require("../corporation/corporationState");
const {
  buildBookmarkText,
} = require(path.join(__dirname, "../bookmark/bookmarkPayloads"));

/**
 * Owner Group Manager Service
 *
 * Access-group (ownerGroups) system used by the ACL bookmarks UI.
 * Method names match the client's expectations from accessGroupsController.py:
 *   Create, Delete, GetMyGroups, GetMembers, GetMembersForMultipleGroups,
 *   GetGroupsMany, GetGroup, AddMembers, DeleteMembers,
 *   UpdateMembershipTypes, UpdateName, UpdateDescription
 */

const MEMBERSHIP_TYPE_NONE = -1;
const MEMBERSHIP_TYPE_MEMBER = 0;
const MEMBERSHIP_TYPE_MANAGER = 1;
const MEMBERSHIP_TYPE_ADMIN = 2;
const MEMBERSHIP_TYPE_EXCLUDED = 3;
const GROUP_PERMISSION_MESSAGE = "You do not have permission to manage this access group.";

function getGroupMembershipType(group, characterID) {
  const numericCharacterID = normalizeNumber(characterID, 0);
  if (!group || numericCharacterID <= 0) {
    return MEMBERSHIP_TYPE_NONE;
  }
  const membershipTypes =
    group.membershipTypes && typeof group.membershipTypes === "object"
      ? group.membershipTypes
      : {};
  if (Object.prototype.hasOwnProperty.call(membershipTypes, String(numericCharacterID))) {
    return normalizeNumber(membershipTypes[String(numericCharacterID)], MEMBERSHIP_TYPE_NONE);
  }
  if (Array.isArray(group.admins) && group.admins.map(Number).includes(numericCharacterID)) {
    return MEMBERSHIP_TYPE_ADMIN;
  }
  if (Array.isArray(group.members) && group.members.map(Number).includes(numericCharacterID)) {
    return MEMBERSHIP_TYPE_MEMBER;
  }
  return MEMBERSHIP_TYPE_NONE;
}

/** Refuse a mutating group action unless the caller has the required role. */
function requireGroupMembership(session, groupID, minimumMembershipType) {
  const characterID = resolveSessionCharacterID(session);
  const character = peekCharacterRecord(characterID);
  const group = bookmarkRuntime.getAccessGroup(groupID);
  const membershipType = getGroupMembershipType(group, characterID);
  const legacyGroup = accessGroupStore.getGroup(groupID);
  const legacyMembershipType = legacyGroup && accessGroupStore.getMembers(groupID)
    .find((entry) => entry.memberID === characterID)?.membershipType;
  const hasRequiredMembership = (value) => value === MEMBERSHIP_TYPE_ADMIN ||
    (minimumMembershipType === MEMBERSHIP_TYPE_MANAGER && value === MEMBERSHIP_TYPE_MANAGER);
  // Membership values are an enum, not an increasing privilege level: Excluded
  // is 3. Corporation/system lists are generated membership lists, never editable.
  if (
    !character || character.isDeleted || character.deletedAt ||
    !group || Number(group.creatorID) === 1 || getCorporationRecord(group.creatorID) ||
    !hasRequiredMembership(membershipType) ||
    (legacyGroup && (
      Number(legacyGroup.creatorID) !== Number(group.creatorID) ||
      !hasRequiredMembership(legacyMembershipType) || legacyMembershipType !== membershipType
    ))
  ) {
    throwWrappedUserError("CustomNotify", { notify: GROUP_PERMISSION_MESSAGE });
  }
  return group;
}

function requireMemberChanges(session, groupID, memberIDs, membershipType, removing = false) {
  const group = requireGroupMembership(session, groupID, MEMBERSHIP_TYPE_MANAGER);
  const characterID = resolveSessionCharacterID(session);
  const actorType = getGroupMembershipType(group, characterID);
  const currentTypes = new Map(bookmarkRuntime.getAccessGroupMembers(groupID)
    .map((entry) => [entry.memberID, entry.membershipType]));
  const legacyTypes = new Map(accessGroupStore.getMembers(groupID)
    .map((entry) => [entry.memberID, entry.membershipType]));
  for (const rawMemberID of memberIDs) {
    const memberID = Number(rawMemberID);
    const nextType = removing ? null : Number(membershipType instanceof Map ? membershipType.get(memberID) : membershipType);
    const currentType = currentTypes.get(memberID);
    if (
      !Number.isSafeInteger(memberID) || memberID < 0 ||
      (!removing && ![MEMBERSHIP_TYPE_MEMBER, MEMBERSHIP_TYPE_MANAGER, MEMBERSHIP_TYPE_ADMIN, MEMBERSHIP_TYPE_EXCLUDED].includes(nextType)) ||
      (!removing && (nextType === MEMBERSHIP_TYPE_ADMIN || nextType === MEMBERSHIP_TYPE_MANAGER) &&
        (memberID === 0 || getCorporationRecord(memberID) || getAllianceRecord(memberID))) ||
      (actorType === MEMBERSHIP_TYPE_MANAGER && (
        (!removing && (nextType === MEMBERSHIP_TYPE_ADMIN || nextType === MEMBERSHIP_TYPE_MANAGER)) ||
        ([currentType, legacyTypes.get(memberID)].some((type) =>
          type === MEMBERSHIP_TYPE_ADMIN || type === MEMBERSHIP_TYPE_MANAGER) && memberID !== characterID)
      ))
    ) {
      throwWrappedUserError("CustomNotify", { notify: GROUP_PERMISSION_MESSAGE });
    }
  }
  return group;
}

/**
 * Build a group KeyVal matching client expectations:
 *   groupID, creatorID, name, description, membershipType
 */
function buildGroupKeyVal(group, characterID = 0) {
  const numericCharacterID = normalizeNumber(characterID, 0);
  const membershipTypes =
    group && group.membershipTypes && typeof group.membershipTypes === "object"
      ? group.membershipTypes
      : {};
  const admins = Array.isArray(group && group.admins)
    ? group.admins.map(Number).filter((memberID) => memberID > 0)
    : [];
  const members = Array.isArray(group && group.members)
    ? group.members.map(Number).filter((memberID) => memberID > 0)
    : [];
  const membershipType = Object.prototype.hasOwnProperty.call(
    membershipTypes,
    String(numericCharacterID),
  )
    ? normalizeNumber(membershipTypes[String(numericCharacterID)], -1)
    : admins.includes(numericCharacterID)
      ? 2
      : members.includes(numericCharacterID)
        ? 0
        : normalizeNumber(group && group.membershipType, -1);

  return buildKeyVal([
    ["groupID", group.groupID],
    ["creatorID", group.creatorID],
    ["name", buildBookmarkText(group.name, 100, "")],
    ["description", buildBookmarkText(group.description, 3900, "")],
    ["membershipType", membershipType],
    ["admins", { type: "list", items: admins }],
  ]);
}

/**
 * Build a member KeyVal matching client expectations:
 *   memberID, membershipType
 */
function buildMemberKeyVal(member) {
  return buildKeyVal([
    ["memberID", member.memberID],
    ["membershipType", member.membershipType != null ? member.membershipType : 0],
  ]);
}

class OwnerGroupManagerService extends BaseService {
  constructor() {
    super("ownerGroupManager");
  }

  Handle_GetMyGroups(args, session) {
    const charID = normalizeNumber(session && session.characterID, 0);
    log.debug(`[OwnerGroupManager] GetMyGroups char=${charID}`);

    // A reader with no acting character (e.g. a sov-hub access-group probe) has
    // no groups; answer with an empty iterable rather than resolving a runtime
    // character.
    if (charID <= 0) {
      return [];
    }

    // ACL bookmark access groups live in the centralized bookmark runtime, which
    // also mints the per-corporation default group on first access. The client
    // iterates `for g in remoteSvc.GetMyGroups()`, so return a plain list of the
    // KeyVal group payloads.
    const groups = bookmarkRuntime.listGroupsForCharacter(charID);
    return groups.map((group) => buildGroupKeyVal(group, charID));
  }

  Handle_GetGroup(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    log.debug(`[OwnerGroupManager] GetGroup char=${charID} group=${groupID}`);

    const group = bookmarkRuntime.getGroupForCharacter(charID, groupID);
    if (!group) return null;
    return buildGroupKeyVal(group, charID);
  }

  Handle_GetMembers(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    log.debug(`[OwnerGroupManager] GetMembers char=${charID} group=${groupID}`);

    const group = bookmarkRuntime.getGroupForCharacter(charID, groupID);
    const members = group ? bookmarkRuntime.getAccessGroupMembers(groupID) : [];
    return { type: "list", items: members.map(buildMemberKeyVal) };
  }

  Handle_GetMembersForMultipleGroups(args, session) {
    const charID = session && session.characterID;
    const groupIDs = args && Array.isArray(args[0]) ? args[0] : [];
    log.debug(
      `[OwnerGroupManager] GetMembersForMultipleGroups char=${charID} groups=${JSON.stringify(groupIDs)}`,
    );
    if (groupIDs.length === 0) {
      return { type: "dict", entries: [] };
    }

    const allowedGroupIDs = new Set(
      bookmarkRuntime.getGroupsManyForCharacter(charID, groupIDs)
        .map((group) => Number(group.groupID)),
    );
    const entries = groupIDs
      .map((groupID) => Number(groupID))
      .filter((groupID) => allowedGroupIDs.has(groupID))
      .map((groupID) => [
        groupID,
        {
          type: "list",
          items: bookmarkRuntime.getAccessGroupMembers(groupID).map(buildMemberKeyVal),
        },
      ]);
    return { type: "dict", entries };
  }

  Handle_GetGroupsMany(args, session) {
    const charID = session && session.characterID;
    const groupIDs = args && Array.isArray(args[0]) ? args[0] : [];
    log.debug(
      `[OwnerGroupManager] GetGroupsMany char=${charID} groups=${JSON.stringify(groupIDs)}`,
    );

    const groups = bookmarkRuntime.getGroupsManyForCharacter(charID, groupIDs);
    return {
      type: "list",
      items: groups.map((group) => buildGroupKeyVal(group, charID)),
    };
  }

  Handle_GetPublicGroupInfo(args, session) {
    return this.Handle_GetGroup(args, session);
  }

  Handle_SearchGroups(args, session) {
    return this.Handle_GetMyGroups(args, session);
  }

  Handle_GetMyGroupsAndMembers(args, session) {
    const charID = session && session.characterID;
    const groups = bookmarkRuntime.listGroupsForCharacter(charID);
    const groupIDs = groups.map((group) => group.groupID);
    const membersByGroupID = this.Handle_GetMembersForMultipleGroups([groupIDs], session);
    return {
      groups: {
        type: "list",
        items: groups.map((group) => buildGroupKeyVal(group, charID)),
      },
      membersByGroupID,
    };
  }

  Handle_GetMyGroupsToUseForBookmarks(args, session) {
    return this.Handle_GetMyGroups(args, session);
  }

  // Client calls: remoteSvc.Create(name, description)
  Handle_Create(args, session) {
    const charID = resolveSessionCharacterID(session);
    const character = peekCharacterRecord(charID);
    if (!character || character.isDeleted || character.deletedAt) {
      throwWrappedUserError("CustomNotify", { notify: GROUP_PERMISSION_MESSAGE });
    }
    const name = normalizeText(args && args[0], "New Group");
    const description = normalizeText(args && args[1], "");
    log.info(`[OwnerGroupManager] Create char=${charID} name="${name}"`);

    // Structure-profile ACLs still consume accessGroups while shared bookmarks
    // consume bookmarkGroups. Keep one player-created group mirrored into both
    // stores with the same id so either feature can use the picker result.
    const legacyGroup = accessGroupStore.createGroup(charID, name, description);
    let group;
    try {
      group = bookmarkRuntime.createAccessGroup(charID, name, description, {
        groupID: legacyGroup.groupID,
      });
    } catch (error) {
      accessGroupStore.removeGroup(legacyGroup.groupID);
      throw error;
    }
    return buildGroupKeyVal(group, charID);
  }

  // Client calls: remoteSvc.Delete(groupID)
  Handle_Delete(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    log.info(`[OwnerGroupManager] Delete char=${charID} group=${groupID}`);

    requireGroupMembership(session, groupID, MEMBERSHIP_TYPE_ADMIN);
    accessGroupStore.removeGroup(groupID);
    bookmarkRuntime.deleteAccessGroup(groupID);
    return null;
  }

  Handle_CreateGroup(args, session) {
    return this.Handle_Create(args, session);
  }

  Handle_DeleteGroup(args, session) {
    this.Handle_Delete(args, session);
    return true;
  }

  // Client calls: remoteSvc.UpdateName(groupID, newName)
  Handle_UpdateName(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    const newName = normalizeText(args && args[1], "");
    log.info(`[OwnerGroupManager] UpdateName char=${charID} group=${groupID} name="${newName}"`);

    requireGroupMembership(session, groupID, MEMBERSHIP_TYPE_ADMIN);
    accessGroupStore.updateName(groupID, newName);
    bookmarkRuntime.updateAccessGroup(groupID, { name: newName });
    return null;
  }

  // Client calls: remoteSvc.UpdateDescription(groupID, newDesc)
  Handle_UpdateDescription(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    const newDesc = normalizeText(args && args[1], "");
    log.info(`[OwnerGroupManager] UpdateDescription char=${charID} group=${groupID}`);

    requireGroupMembership(session, groupID, MEMBERSHIP_TYPE_ADMIN);
    accessGroupStore.updateDescription(groupID, newDesc);
    bookmarkRuntime.updateAccessGroup(groupID, { description: newDesc });
    return null;
  }

  // Client calls: remoteSvc.AddMembers(groupID, {memberID: membershipType, ...})
  // Returns list of [memberID, reason] failures
  Handle_AddMembers(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    // args[1] is a dict {memberID: membershipType}
    const raw = args && args[1];
    const membershipDict = {};

    if (raw && typeof raw === "object") {
      if (raw.type === "dict" && Array.isArray(raw.entries)) {
        for (const [key, val] of raw.entries) {
          membershipDict[Number(key)] = Number(val);
        }
      } else if (Array.isArray(raw)) {
        // fallback: array of [memberID, membershipType]
        for (const entry of raw) {
          if (Array.isArray(entry) && entry.length >= 2) {
            membershipDict[Number(entry[0])] = Number(entry[1]);
          }
        }
      } else {
        // Plain JS object
        for (const [key, val] of Object.entries(raw)) {
          membershipDict[Number(key)] = Number(val);
        }
      }
    }

    log.info(
      `[OwnerGroupManager] AddMembers char=${charID} group=${groupID} members=${JSON.stringify(membershipDict)}`,
    );

    requireMemberChanges(session, groupID, Object.keys(membershipDict),
      new Map(Object.entries(membershipDict).map(([memberID, type]) => [Number(memberID), type])));
    const failed = accessGroupStore.addMembers(groupID, membershipDict);
    if (failed.length <= 0) {
      bookmarkRuntime.addAccessGroupMembers(groupID, membershipDict);
    }
    return { type: "list", items: failed };
  }

  // Client calls: remoteSvc.DeleteMembers(groupID, memberIDsList)
  // Returns list of [memberID, reason] failures
  Handle_DeleteMembers(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    const memberIDs = args && Array.isArray(args[1]) ? args[1].map(Number) : [];
    log.info(
      `[OwnerGroupManager] DeleteMembers char=${charID} group=${groupID} members=${JSON.stringify(memberIDs)}`,
    );

    requireMemberChanges(session, groupID, memberIDs, null, true);
    const failed = accessGroupStore.deleteMembers(groupID, memberIDs);
    if (failed.length <= 0) {
      bookmarkRuntime.deleteAccessGroupMembers(groupID, memberIDs);
    }
    return { type: "list", items: failed };
  }

  Handle_RemoveMembers(args, session) {
    return this.Handle_DeleteMembers(args, session);
  }

  // Client calls: remoteSvc.UpdateMembershipTypes(groupID, memberIDs, membershipType)
  // Returns list of [memberID, reason] failures
  Handle_UpdateMembershipTypes(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    const memberIDs = args && Array.isArray(args[1]) ? args[1].map(Number) : [];
    const membershipType = normalizeNumber(args && args[2], 0);
    log.info(
      `[OwnerGroupManager] UpdateMembershipTypes char=${charID} group=${groupID} members=${JSON.stringify(memberIDs)} type=${membershipType}`,
    );

    requireMemberChanges(session, groupID, memberIDs, membershipType);
    const failed = accessGroupStore.updateMembershipTypes(groupID, memberIDs, membershipType);
    if (failed.length <= 0) {
      bookmarkRuntime.updateAccessGroupMembershipTypes(
        groupID,
        memberIDs,
        membershipType,
      );
    }
    return { type: "list", items: failed };
  }

  Handle_UpdateMemberships(args) {
    return Array.isArray(args && args[0]) ? args[0] : [];
  }

  // Client calls: remoteSvc.GetGroupLogs(groupID)
  Handle_GetGroupLogs(args, session) {
    const charID = session && session.characterID;
    const groupID = normalizeNumber(args && args[0], 0);
    log.debug(`[OwnerGroupManager] GetGroupLogs char=${charID} group=${groupID}`);
    return { type: "list", items: [] };
  }
}

module.exports = OwnerGroupManagerService;
