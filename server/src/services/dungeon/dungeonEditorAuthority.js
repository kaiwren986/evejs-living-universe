"use strict";

const authority = require("./dungeonAuthority");
const { listItemTypes } = require("../inventory/itemTypeRegistry");
const { buildDict, buildList } = require("../_shared/serviceHelpers");
const positiveID = value => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
let palette = null;

function getCatalog() {
  const catalog = authority.getEditorCatalog();
  catalog.dungeons = catalog.dungeons.filter(row => positiveID(row.dungeonID)).sort((a, b) => a.dungeonID - b.dungeonID);
  if (catalog.dungeons.length > 20000) throw new Error("DUNGEON_EDITOR_CATALOG_LIMIT");
  return { ...catalog, factions: [...new Set(catalog.dungeons.map(row => row.factionID).filter(positiveID))].sort((a, b) => a - b) };
}

function getInstalledRooms(dungeonID) {
  if (!positiveID(dungeonID)) return { rooms: [], template: null };
  const template = authority.getClientDungeonTemplateReadOnly(dungeonID);
  if (!template || authority.isBannedDungeonTemplateID(template.templateID)) return { rooms: [], template: null };
  // Objective chains are not rooms. Only actual installed layout records have
  // the identity needed by the native room selector.
  const rooms = (Array.isArray(template.rooms) ? template.rooms : [])
    .filter(room => room && typeof room === "object" && !Array.isArray(room) && positiveID(room.roomID));
  return { rooms, template };
}

function getRooms(dungeonID) {
  return getInstalledRooms(dungeonID).rooms
    .map(room => [room.roomID, ([room.label, room.name, room.roomKey]
      .find(value => typeof value === "string" && value) || `Room ${room.roomID}`).slice(0, 256)]);
}

function getRoomObjectIDs(dungeonID, roomID) {
  const { rooms, template } = getInstalledRooms(dungeonID);
  const room = rooms.find(row => row.roomID === roomID);
  if (!room) return new Set();
  const ids = new Set();
  const lists = [room.objects, ...Object.values(template.populationHints || {})];
  for (const list of lists) if (Array.isArray(list)) for (const row of list) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    // Every explicit selector must agree. A room-local list can omit both,
    // while shared population lists need an exact room identity.
    const hasRoomID = row.roomID != null, hasRoomKey = row.roomKey != null;
    if (hasRoomID && row.roomID !== roomID || hasRoomKey && row.roomKey !== room.roomKey ||
        !hasRoomID && !hasRoomKey && list !== room.objects) continue;
    const id = positiveID(row.dunObjectID ?? row.objectID);
    if (id) ids.add(id);
  }
  return ids;
}

function getPalette() {
  if (!palette) {
    const groups = new Map();
    const categories = new Set([2, 3, 6, 11, 18, 22, 23, 25, 40, 46, 65, 87]);
    for (const item of listItemTypes()) {
      if (!positiveID(item.typeID) || !positiveID(item.groupID) || !categories.has(item.categoryID) || !item.name) continue;
      if (!groups.has(item.groupID)) groups.set(item.groupID, { name: item.groupName || `Group ${item.groupID}`, types: [] });
      groups.get(item.groupID).types.push([item.typeID, item.name]);
    }
    palette = [...groups].sort(([a], [b]) => a - b).map(([id, group]) =>
      [[id, group.name], group.types.sort(([a], [b]) => a - b)]);
  }
  // Native GetGroupTypes consumes tuple-keyed dictionaries and (id,name)
  // lists, not the donor's unrelated objective/environment table dictionary.
  return buildDict(palette.map(([key, rows]) => [[...key], buildList(rows.map(row => [...row]))]));
}

module.exports = { positiveID, getCatalog, getRooms, getRoomObjectIDs, getPalette };
