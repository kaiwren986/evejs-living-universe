"use strict";

const BaseService = require("../baseService");
const authority = require("./dungeonEditorAuthority");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { currentFileTime, extractDictEntries } = require("../_shared/serviceHelpers");
const { strVal } = require("../../network/tcp/utils/marshal");
const { throwWrappedUserError } = require("../../common/machoErrors");
const contexts = new WeakMap();

function isAuthorized(session) {
  const characterID = resolveSessionCharacterID(session);
  const accountID = Number(session?.userid || session?.accountID);
  if (!characterID || !Number.isSafeInteger(accountID) || accountID <= 0 || session?.socket?.destroyed || session?._characterControlDisconnected) return false;
  const character = require("../character/characterState").peekCharacterRecord(characterID);
  if (!character || character.deletedAt || character.isDeleted || Number(character.accountID ?? character.accountId) !== accountID) return false;
  const account = Object.values(require("../login/accountStore").readAccountsTable())
    .find(row => Number(row?.accountID ?? row?.id ?? row?.userID) === accountID);
  const { buildPersistedAccountRoleRecord, normalizeRoleValue, ROLE_CONTENT } = require("../account/accountRoleProfiles");
  return Boolean(account && !account.banned && (normalizeRoleValue(buildPersistedAccountRoleRecord(account).role, 0n) & ROLE_CONTENT));
}

function fail(message) { throwWrappedUserError("CustomNotify", { notify: message }); }
function roomArgument(args, kwargs) {
  const entry = extractDictEntries(kwargs).find(([key]) => strVal(key) === "roomID");
  return entry ? entry[1] : kwargs && Object.hasOwn(kwargs, "roomID") ? kwargs.roomID : args?.[1];
}

class DungeonLevelEditorService extends BaseService {
  constructor(manager, session, objectID) {
    super("dungeonLevelEditor");
    this.serviceManager = manager; this.owner = session; this.objectID = objectID;
    this.characterID = resolveSessionCharacterID(session); this.accountID = Number(session.userid || session.accountID);
    this.closed = false; this.dungeonID = null; this.roomID = null; this.selection = [];
  }
  callMethod(method, ...args) {
    const name = BaseService.normalizeMethodName(method);
    if (typeof this[`Handle_${name}`] !== "function") fail("This dungeon editor action is not implemented; browsing cannot modify or publish dungeon content.");
    return super.callMethod(name, ...args);
  }
  assertOwner(session) {
    if (this.closed || session !== this.owner || session?.currentBoundObjectID !== this.objectID ||
        resolveSessionCharacterID(session) !== this.characterID || Number(session.userid || session.accountID) !== this.accountID || !isAuthorized(session))
      fail("This dungeon editor binding is unavailable to this session.");
  }
  canReleaseBoundObject(_id, options) { return options?.session === this.owner; }
  onBoundObjectReleased() {
    this.closed = true; this.selection = []; this.dungeonID = null; this.roomID = null;
    if (contexts.get(this.owner) === this) contexts.delete(this.owner);
  }
  Handle_Bind(_args, session) { this.assertOwner(session); return null; }
  Handle_GetCurrentlyEditedRoomID(_args, session) { this.assertOwner(session); return this.roomID; }
  Handle_EditDungeon(args, session, kwargs) {
    this.assertOwner(session);
    const dungeonID = authority.positiveID(args?.[0]);
    const rooms = authority.getRooms(dungeonID), requested = roomArgument(args, kwargs);
    const roomID = requested == null ? rooms[0]?.[0] : authority.positiveID(requested);
    if (!dungeonID || !roomID || !rooms.some(([id]) => id === roomID)) fail("No installed room belongs to that dungeon selection.");
    this.dungeonID = dungeonID; this.roomID = roomID; this.selection = []; return null;
  }
  Handle_GotoRoom(args, session) {
    this.assertOwner(session);
    const roomID = authority.positiveID(args?.[0]);
    if (!authority.getRooms(this.dungeonID).some(([id]) => id === roomID)) fail("That room does not belong to this dungeon.");
    this.roomID = roomID; this.selection = []; return null;
  }
  Handle_ObjectSelection(args, session) {
    this.assertOwner(session);
    const ids = args?.[0];
    const available = authority.getRoomObjectIDs(this.dungeonID, this.roomID);
    if (!Array.isArray(ids) || ids.length > 256 || ids.some(id => !authority.positiveID(id) || !available.has(id))) fail("Selection must contain installed objects from the current room.");
    this.selection = [...new Set(ids)]; return null;
  }
  Handle_Reset(_args, session) { this.assertOwner(session); this.selection = []; this.roomID = null; this.dungeonID = null; return null; }
  Handle_PlayDungeon(_args, session) { this.assertOwner(session); fail("Dungeon editor playtests are not implemented. This binding provides read-only browsing."); }
  Handle_SaveRoom(_args, session) { this.assertOwner(session); fail("Dungeon editor publishing is not implemented. Author content through versioned content packs."); }
}

function getLevelEditor(manager, session, ownerService) {
  if (!isAuthorized(session) || !manager) return null;
  let editor = contexts.get(session);
  if (editor && (editor.closed || editor.characterID !== resolveSessionCharacterID(session) ||
      editor.accountID !== Number(session.userid || session.accountID) || editor.serviceManager !== manager ||
      editor.boundObjectOwnerService !== ownerService)) {
    editor.serviceManager.unregisterBoundObject(editor.objectID, { session });
    editor = null;
  }
  if (!editor) {
    const objectID = `N=${require("../../config").proxyNodeId}:${require("../../config").getNextBoundId()}`;
    editor = new DungeonLevelEditorService(manager, session, objectID); contexts.set(session, editor);
    editor.boundObjectOwnerService = ownerService;
  }
  const time = currentFileTime(); editor.refID = time > (editor.refID || 0n) ? time : editor.refID + 1n;
  manager.registerBoundObject(editor.objectID, editor, editor.refID, session);
  session._boundObjectIDs = { ...session._boundObjectIDs, dungeonLevelEditor: editor.objectID };
  session.lastBoundObjectID = editor.objectID;
  return { type: "substruct", value: { type: "substream", value: [editor.objectID, editor.refID] } };
}

function forgetSession(session) {
  const editor = contexts.get(session);
  if (editor) editor.serviceManager.unregisterBoundObject(editor.objectID, { session });
}
module.exports = { isAuthorized, getLevelEditor, forgetSession };
