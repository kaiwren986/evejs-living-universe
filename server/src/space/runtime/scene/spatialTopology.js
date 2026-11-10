"use strict";

// The scene's Grid bubbles: retail's label on the level-0 partition boxes
// (destiny/visibility/gridBubbles.js), one for every Ball of the park, static
// and dynamic. A Ball's `bubbleID` is its Grid bubble and `publicGridKey` its
// box. They are written by AddBall (a Ball entering the park), by RemoveBall,
// and by a re-box: Evolve's pass 3 for a Ball that moved at least sqrt(0.1)
// m, and a teleport. So gameplay between ticks already reads the new bubble;
// what Observers are told about it waits for the next doPreTick's bubble
// update (scene/visibility.js).

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const gridBubbles = require(path.join(
  runtimeEntryDirname,
  "./destiny/visibility/gridBubbles.js",
));
const {
  getEntityMapKey,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  isAbyssalRoomEntityAwaitingRelease,
  isAbyssalRoomEntityDeliveryHidden,
} = require("../abyssalRoomEntity");
const {
  logBubbleDebug,
  summarizeBubbleEntity,
} = require("../runtimeDebugInstrumentation");
const {
  isEntityCloaked,
} = require("../shipCloak");
const {
  toInt,
} = require("../../../common/numbers");

module.exports = {

getAllVisibleEntities() {
    return [...this.staticEntities, ...this.dynamicEntities.values()];
  },

getGridBubbles() {
    if (!this._gridBubbles) {
      this._gridBubbles = gridBubbles.createGridBubbles();
    }
    return this._gridBubbles;
  },

// Whether a Ball of the scene is in the park, so in a Grid bubble. Abyssal
// content prewarmed for a later room is not: it joins at its room's
// transition (releaseAbyssalRoomEntities).
isBallInGridBubbles(entity) {
    const ballID = getEntityMapKey(entity && entity.itemID);
    return ballID !== null && gridBubbles.hasBall(this.getGridBubbles(), ballID);
  },

// Whether a Ball of the scene is placed as the Grid bubbles want it: in the
// park, or, for abyssal content awaiting its room's release (prewarmed, or
// pending its transition), held out of it (reboxBall), to join at the
// release. A check that a Ball is registered in its scene asks this, not
// isBallInGridBubbles.
isBallPlacedInGridBubbles(entity) {
    if (!entity || !this.isSceneBall(entity)) {
      return false;
    }
    return this.isBallInGridBubbles(entity) || isAbyssalRoomEntityAwaitingRelease(entity);
  },

// AddBall and the re-box: puts the Ball in its box and gives it that box's
// Grid bubble. A Ball whose room is not delivered yet stays out.
reboxBall(entity) {
    const ballID = getEntityMapKey(entity && entity.itemID);
    if (ballID === null || !entity.position) {
      return null;
    }
    if (isAbyssalRoomEntityDeliveryHidden(entity)) {
      return null;
    }
    const park = this.getGridBubbles();
    const previousBubbleID = entity.bubbleID === undefined ? null : entity.bubbleID;
    const bubbleID = gridBubbles.reboxBall(park, ballID, entity.position);
    entity.publicGridKey = gridBubbles.boxKeyForPosition(park, entity.position);
    entity.bubbleID = bubbleID;
    if (previousBubbleID !== bubbleID) {
      logBubbleDebug("bubble.entity_entered", {
        systemID: this.systemID,
        entity: summarizeBubbleEntity(entity),
        previousBubbleID,
        bubbleID,
      });
    }
    return bubbleID;
  },

// Abyssal room content whose delivery state changed: content released for
// its room's transition is an AddBall, retired or prewarmed content a
// RemoveBall.
syncAbyssalRoomEntityGridBubbles(entities) {
    for (const entity of Array.isArray(entities) ? entities : []) {
      if (!entity || !this.isSceneBall(entity)) {
        continue;
      }
      if (isAbyssalRoomEntityDeliveryHidden(entity)) {
        if (this.isBallInGridBubbles(entity)) {
          this.removeBallFromGridBubbles(entity);
        }
      } else {
        this.reboxBall(entity);
      }
    }
  },

// RemoveBall: out of its box and its Grid bubble at once.
removeBallFromGridBubbles(entity) {
    const ballID = getEntityMapKey(entity && entity.itemID);
    if (ballID === null) {
      return null;
    }
    // A global or cloaked Ball is in no list, its removal included: the
    // bubble update must not take it for an ordinary one once it is gone.
    if (entity && (this.isGlobalBall(entity) || isEntityCloaked(entity))) {
      if (!(this._gridBubbleUnlistedRemovals instanceof Set)) {
        this._gridBubbleUnlistedRemovals = new Set();
      }
      this._gridBubbleUnlistedRemovals.add(ballID);
    }
    const left = gridBubbles.removeBall(this.getGridBubbles(), ballID);
    if (entity) {
      entity.bubbleID = null;
      entity.publicGridKey = null;
    }
    if (left !== null) {
      logBubbleDebug("bubble.entity_removed", {
        systemID: this.systemID,
        entity: summarizeBubbleEntity(entity),
        previousBubbleID: left,
      });
    }
    return left;
  },

// The Grid bubble a Ball is in now, or null.
getGridBubbleIDForEntity(entity) {
    const ballID = getEntityMapKey(entity && entity.itemID);
    if (ballID === null) {
      return null;
    }
    return gridBubbles.bubbleOf(this.getGridBubbles(), ballID);
  },

// The Grid bubble a Ball put at `position` now would join, or null when it
// would get a fresh one. Writes nothing.
getGridBubbleIDForPosition(position) {
    if (!position) {
      return null;
    }
    const park = this.getGridBubbles();
    const key = gridBubbles.boxKeyForPosition(park, position);
    const box = park.boxes.get(key);
    if (box && box.bubble !== null) {
      return box.bubble;
    }
    const [x, y, z] = key.split(":").map(Number);
    for (const [i, j, k] of gridBubbles.NEIGHBOUR_OFFSETS) {
      const neighbour = park.boxes.get(`${x + i}:${y + j}:${z + k}`);
      if (neighbour && neighbour.bubble !== null) {
        return neighbour.bubble;
      }
    }
    return null;
  },

getGridBubbleIDForSession(session) {
    return this.getGridBubbleIDForEntity(this.getShipEntityForSession(session));
  },

// The Balls of a Grid bubble now (marked +1 or 0), as scene entities.
getEntitiesInGridBubble(bubbleID) {
    if (bubbleID === null || bubbleID === undefined) {
      return [];
    }
    const entities = [];
    for (const ballID of gridBubbles.membersOf(this.getGridBubbles(), bubbleID)) {
      const entity = this.getEntityByID(ballID);
      if (entity) {
        entities.push(entity);
      }
    }
    return entities;
  },

// { id, entityIDs } for a Grid bubble with Balls in it, or null.
getBubbleByID(bubbleID) {
    const numericBubbleID = toInt(bubbleID, 0);
    if (!numericBubbleID) {
      return null;
    }
    const members = gridBubbles.membersOf(this.getGridBubbles(), numericBubbleID);
    if (members.length === 0) {
      return null;
    }
    return {
      id: numericBubbleID,
      entityIDs: new Set(members),
    };
  },

getBubbleForSession(session) {
    return this.getBubbleByID(this.getGridBubbleIDForSession(session));
  },

getDynamicEntitiesInBubble(bubbleID) {
    return this.getEntitiesInGridBubble(bubbleID).filter((entity) => (
      this.dynamicEntities.get(entity.itemID) === entity
    ));
  },

getStaticEntitiesInBubble(bubbleID) {
    return this.getEntitiesInGridBubble(bubbleID).filter((entity) => (
      this.staticEntitiesByID.get(getEntityMapKey(entity.itemID)) === entity
    ));
  },

getShipsInBubble(bubbleID) {
    return this.getDynamicEntitiesInBubble(bubbleID).filter(
      (entity) => entity && entity.kind === "ship",
    );
  },

// The sessions whose own Ball is in the Grid bubble now.
getSessionsInBubble(bubbleID) {
    const numericBubbleID = toInt(bubbleID, 0);
    if (!numericBubbleID) {
      return [];
    }
    const sessions = [];
    for (const session of this.sessions.values()) {
      if (this.getGridBubbleIDForSession(session) === numericBubbleID) {
        sessions.push(session);
      }
    }
    return sessions;
  },

// The partition box key of a Ball (its public-grid key).
getPublicGridKeyForEntity(entity) {
    if (!entity) {
      return null;
    }
    if (entity.publicGridKey) {
      return String(entity.publicGridKey);
    }
    return gridBubbles.boxKeyForPosition(this.getGridBubbles(), entity.position || null);
  },
};
