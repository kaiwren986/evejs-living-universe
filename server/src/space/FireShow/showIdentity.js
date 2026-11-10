"use strict";

// Server-authored transient identity; ordinary transient NPCs retain rewards.
function isFireShowShip(entity) {
  return Boolean(entity && entity.kind === "ship" && entity.nativeNpc === true &&
    entity.transient === true && entity.npcEntityType === "fireShow");
}

module.exports = { isFireShowShip };
