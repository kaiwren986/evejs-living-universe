"use strict";

// Call with an authoritative inventory record, never a client request or a
// loose scene entity. The dungeon materializer persists these spaceState fields.
// Native mission cargo hulls retain their real type, so type/group classification
// alone cannot identify their live-presence and loot admission requirements.
function isMaterializedMissionCargoContainer(item) {
  const state = item && item.spaceState;
  return Boolean(state && state.dungeonMaterializedContainer === true &&
    ["mission_rescue", "mission_fetch"].includes(state.dungeonSiteContentRole) &&
    Number(state.dungeonSiteInstanceID) > 0);
}

module.exports = { isMaterializedMissionCargoContainer };
