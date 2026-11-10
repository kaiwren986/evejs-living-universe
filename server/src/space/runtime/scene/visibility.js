"use strict";

// Visibility is Grid bubble membership: an Observer is told about
// exactly the non-cloaked Balls of its own Grid bubble plus the global Balls,
// with no range, scope or per-Observer filter beyond cloak ownership, and no
// stored per-Observer set. The bubbles themselves are spatialTopology.js.
//
// Once per Destiny tick, in doPreTick (runtime/destinyTick.js), the bubble
// update turns the +1/-1 marks into one shared entered and left list per
// Grid bubble with an Observer, and a diff for an Observer whose own bubble
// changed, all deletions then all additions, and
// commits the marks. Between two bubble updates an Observer's client knows
// exactly what its last update (or its SetState) told it: the Balls whose
// mark committed in the bubble it was told about (canSessionSeeDynamicEntity),
// which is what every gameplay send routes by until one stamped action list,
// one batch per Grid bubble and one per Observer, puts those sends in the
// Grid bubble histories.
//
// Global Balls (celestials, stations, stargates, Upwell structures, beacons,
// public anchored customs offices and skyhooks) are in SetState and broadcast
// on add and remove, never in a list; every update about one goes to every
// Grid bubble (scene/destinyHistory.js). A global's removal is RemoveBalls to every
// Observer: the client we ship against has no handler for the global-removal
// actions. A change of a Ball's global status (refreshBallGlobalStatus) is
// told to every Observer once.

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const gridBubbles = require(path.join(
  runtimeEntryDirname,
  "./destiny/visibility/gridBubbles.js",
));
const {
  getEntityMapKey,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  buildModePresentationUpdates,
} = require(path.join(runtimeEntryDirname, "./destiny/presentation/mode.js"));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
const destinyHistoryList = require(path.join(
  runtimeEntryDirname,
  "./destiny/batching/destinyHistory.js",
));
const {
  buildPackagedActionUpdate,
} = require(path.join(runtimeEntryDirname, "./destiny/batching/packagedAction.js"));
const {
  isAwaitingUndockEntry,
  isAwaitingUndockSetState,
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  toInt,
} = require("../../../common/numbers");
const {
  isEntityCloaked,
} = require("../shipCloak");
const {
  magnitude,
} = require("../../../common/vector");
const {
  canSessionSeeCloakedEntity,
} = require("../visibility");
const {
  isPublicPlanetOrbital,
} = require(path.join(runtimeEntryDirname, "../services/planet/planetOrbitalPlacement"));

// The orbitals the orbital rule covers: customs offices and skyhooks.
const GLOBAL_ORBITAL_GROUP_IDS = new Set([1025, 4736]);

// The heading a GOTO Ball is commanded along: toward its goto point.
function getCommandDirection(entity, fallback = { x: 1, y: 0, z: 0 }) {
  if (entity && entity.targetPoint && entity.position) {
    const dx = entity.targetPoint.x - entity.position.x;
    const dy = entity.targetPoint.y - entity.position.y;
    const dz = entity.targetPoint.z - entity.position.z;
    const length = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
    if (length > 0) {
      return { x: dx / length, y: dy / length, z: dz / length };
    }
  }
  const direction = entity && entity.direction ? entity.direction : fallback;
  return { x: direction.x, y: direction.y, z: direction.z };
}

// The static rule: a static Ball that is not a global. An explicit isGlobal
// wins; otherwise containers, wrecks, dungeon content and any static with a
// gameplay scope (site objects, scoped scenery, asteroids) are Grid bubble
// members, and every other static Ball (celestials, stations, stargates,
// Upwell structures, beacons, the scene's own customs offices) is global.
// Upwell structures are on every overview in their system (TQ), as main
// had them; starbase towers are inventory Balls, not statics.
// The seasonal "system" beacons carry isGlobal: true in their catalogs, so
// their scope does not make them members.
function isStaticBubbleMember(entity) {
  if (!entity) {
    return true;
  }
  if (entity.isGlobal === true) {
    return false;
  }
  if (entity.isGlobal === false) {
    return true;
  }
  return Boolean(
    entity.kind === "container" ||
    entity.kind === "wreck" ||
    String(entity.staticVisibilityScope || "").trim() ||
    entity.dungeonMaterializedSiteContent === true ||
    (entity.dungeonSiteInstanceID !== null && entity.dungeonSiteInstanceID !== undefined)
  );
}

// Whether a dynamic Ball falls under the orbital rule: an inventory-backed
// customs office or skyhook. The rule itself is upstream release 261018.1's
// isPublicPlanetOrbital, which made such an orbital visible throughout its
// solar system: global while it is not destroyed, is not unanchoring or
// unanchored (orbital state -3, -2), and has no private scope.
function isGlobalOrbitalCandidate(entity) {
  return Boolean(
    entity &&
    entity.kind === "orbital" &&
    GLOBAL_ORBITAL_GROUP_IDS.has(Number(entity.groupID))
  );
}

// The global status each Ball's Observers were last told, per scene, keyed by
// the Ball itself so a Ball that leaves the scene takes its entry with it.
function knownGlobalStatuses(scene) {
  if (!(scene._ballGlobalStatus instanceof WeakMap)) {
    scene._ballGlobalStatus = new WeakMap();
  }
  return scene._ballGlobalStatus;
}

// The Balls whose global status changed since the last bubble update: Map
// ballID -> whether it is global now.
function globalStatusChanges(scene) {
  if (!(scene._gridBubbleGlobalChangedSinceUpdate instanceof Map)) {
    scene._gridBubbleGlobalChangedSinceUpdate = new Map();
  }
  return scene._gridBubbleGlobalChangedSinceUpdate;
}

function sessionObserverID(session) {
  return session && session.clientID !== undefined && session.clientID !== null
    ? `client:${session.clientID}`
    : null;
}

module.exports = {

// A global Ball: in every Observer's park, never in a list. A static Ball by
// the static rule, an inventory-backed customs office or skyhook by the
// orbital rule, any other Ball by its own isGlobal.
isGlobalBall(entity) {
    const ballID = getEntityMapKey(entity && entity.itemID);
    if (ballID === null) {
      return false;
    }
    if (this.staticEntitiesByID.get(ballID) === entity) {
      return !isStaticBubbleMember(entity);
    }
    if (isGlobalOrbitalCandidate(entity)) {
      return isPublicPlanetOrbital(entity);
    }
    return entity.isGlobal === true;
  },

// Records the global status a Ball's Observers have now, unless one is
// recorded already: a refresh records it before it changes the Ball's
// fields, so refreshBallGlobalStatus has a status to compare with.
rememberBallGlobalStatus(entity) {
    if (!entity || !this.isSceneBall(entity)) {
      return;
    }
    const known = knownGlobalStatuses(this);
    if (!known.has(entity)) {
      known.set(entity, this.isGlobalBall(entity));
    }
  },

// A change of a Ball's global status, told to every Observer once, in the
// next Destiny tick's batches:
// - becoming global is one add to every park, and nothing leaves: the
//   Ball's Grid bubble's Observers keep it, as retail does;
// - ceasing to be global is a removal from every park except its own Grid
//   bubble's, which keeps it, queued by the next bubble update.
// Nothing is sent when the status is unchanged or was never recorded.
// Returns whether the status changed.
refreshBallGlobalStatus(entityID) {
    const entity = this.getEntityByID(entityID);
    if (!entity || !this.isSceneBall(entity)) {
      return false;
    }
    const known = knownGlobalStatuses(this);
    const wasGlobal = known.get(entity);
    const isGlobal = this.isGlobalBall(entity);
    known.set(entity, isGlobal);
    if (wasGlobal === undefined || wasGlobal === isGlobal) {
      return false;
    }
    const ballID = getEntityMapKey(entity.itemID);
    const changes = globalStatusChanges(this);
    if (isGlobal) {
      // A removal still waiting for the bubble update is dropped: the Ball
      // is global again before any Observer lost it.
      changes.set(ballID, true);
      this.broadcastAddBalls([entity]);
    } else {
      changes.set(ballID, false);
    }
    return true;
  },

// Whether a Ball is in this scene's park.
isSceneBall(entity) {
    const ballID = getEntityMapKey(entity && entity.itemID);
    if (ballID === null) {
      return false;
    }
    return this.dynamicEntities.get(ballID) === entity ||
      this.staticEntitiesByID.get(ballID) === entity;
  },

// An Observer: a session whose client has its SetState, or that undocked and
// waits for it (beginUndockEntry), and whose own Ball is in the park.
// { id, ball } as gridBubbles.js takes it.
getGridBubbleObserver(session) {
    const id = sessionObserverID(session);
    if (
      id === null ||
      !(isReadyForDestiny(session) || isAwaitingUndockSetState(session)) ||
      this.sessions.get(session.clientID) !== session
    ) {
      return null;
    }
    const egoEntity = this.getShipEntityForSession(session);
    const ball = getEntityMapKey(egoEntity && egoEntity.itemID);
    if (ball === null || !gridBubbles.hasBall(this.getGridBubbles(), ball)) {
      return null;
    }
    return { id, ball, session, egoEntity };
  },

listGridBubbleObservers() {
    const observers = [];
    for (const session of this.sessions.values()) {
      const observer = this.getGridBubbleObserver(session);
      if (observer) {
        observers.push(observer);
      }
    }
    return observers;
  },

// The bubble a session's client was last told about (its last bubble
// update, or its SetState), or null.
getKnownGridBubbleIDForSession(session) {
    const id = sessionObserverID(session);
    return id === null ? null : gridBubbles.knownBubbleOf(this.getGridBubbles(), id);
  },

// SetState told the session everything its own Ball's Grid bubble held at the
// last commit: its next bubble update continues from there.
markGridBubbleStateSent(session) {
    const id = sessionObserverID(session);
    const egoEntity = this.getShipEntityForSession(session);
    const ball = getEntityMapKey(egoEntity && egoEntity.itemID);
    if (id === null || ball === null) {
      return;
    }
    gridBubbles.setObserverBaseline(
      this.getGridBubbles(),
      { id, ball },
      gridBubbles.bubbleOf(this.getGridBubbles(), ball),
    );
    // SetState names the ego: an eject's capsule awaits no add.
    if (session._space) {
      delete session._space.awaitedEgoAddID;
    }
  },

forgetGridBubbleObserver(session) {
    const id = sessionObserverID(session);
    if (id !== null) {
      gridBubbles.forgetObserver(this.getGridBubbles(), id);
    }
  },

// Whether a Ball goes in no list: a global, or cloaked (its owner has it as
// its ego; everyone else lost it at CloakBall and gets it back at uncloak).
isGridBubbleListedBall(ballID) {
    if (
      this._gridBubbleUnlistedRemovals instanceof Set &&
      this._gridBubbleUnlistedRemovals.has(ballID)
    ) {
      return false;
    }
    const entity = this.getEntityByID(ballID);
    if (!entity) {
      return true;
    }
    return !this.isGlobalBall(entity) && !isEntityCloaked(entity);
  },

// Bubble visibility for one session and one Ball, as the session's client
// knows it now: the ego; a global; or a Ball not cloaked from it whose mark
// committed in the bubble the session was last told about. This is what a
// send about the Ball routes by.
canSessionSeeDynamicEntity(session, entity) {
    if (!session || !session._space || !entity || !this.isSceneBall(entity)) {
      return false;
    }
    if (session._space.sceneKey && this.sceneKey && session._space.sceneKey !== this.sceneKey) {
      return false;
    }
    const ballID = getEntityMapKey(entity.itemID);
    if (ballID !== null && ballID === getEntityMapKey(session._space.shipID)) {
      return true;
    }
    if (isEntityCloaked(entity) && !canSessionSeeCloakedEntity(session, entity)) {
      return false;
    }
    if (this.isGlobalBall(entity)) {
      return true;
    }
    const known = this.getKnownGridBubbleIDForSession(session);
    return known !== null &&
      gridBubbles.committedBubbleOf(this.getGridBubbles(), ballID) === known;
  },

// Gameplay's question, not the client's: whether a Ball is on the session's
// grid now. Gameplay reads a Ball's Grid bubble from its AddBall on, before
// the next bubble update tells any client (retail's AddToBubble
// marks it +1 at once), so a Ball spawned this tick in the bubble of
// the session's own Ball is on its grid already. A check made for a client
// call reads this; a send routes by canSessionSeeDynamicEntity.
// `options.throughCloak` asks where the Ball is, cloaked or not, rather than
// whether the session may see it: a fleet warp's recipients.
isOnSessionGrid(session, entity, options = {}) {
    if (this.canSessionSeeDynamicEntity(session, entity)) {
      return true;
    }
    if (!session || !session._space || !entity || !this.isSceneBall(entity)) {
      return false;
    }
    if (session._space.sceneKey && this.sceneKey && session._space.sceneKey !== this.sceneKey) {
      return false;
    }
    if (
      !(options && options.throughCloak === true) &&
      isEntityCloaked(entity) &&
      !canSessionSeeCloakedEntity(session, entity)
    ) {
      return false;
    }
    const park = this.getGridBubbles();
    const egoEntity = this.getShipEntityForSession(session);
    const egoBallID = getEntityMapKey(egoEntity && egoEntity.itemID);
    const ballID = getEntityMapKey(entity.itemID);
    if (egoBallID === null || ballID === null) {
      return false;
    }
    const bubbleID = gridBubbles.bubbleOf(park, egoBallID);
    return bubbleID !== null && gridBubbles.bubbleOf(park, ballID) === bubbleID;
  },

canSessionSeeStaticEntityForSession(session, entity) {
    return this.canSessionSeeDynamicEntity(session, entity);
  },

// What a session would get in a SetState now: its own Ball, the Balls whose
// mark committed in its own Ball's Grid bubble (those that entered since come
// with the next bubble update), not cloaked from it, and every global Ball.
getVisibleEntitiesForSession(session) {
    return this.listSessionBubbleEntities(session, gridBubbles.knownMembersOf);
  },

// Gameplay's question for a whole SetState, as isOnSessionGrid is for one
// Ball: what a SetState requested now will carry. The request is built by
// the next doPreTick after its bubble update commits the marks
// (destinyHistory.requestSetState), so it carries every Ball in the ego's
// Grid bubble now, one that entered this tick included.
getSessionGridEntities(session) {
    return this.listSessionBubbleEntities(session, gridBubbles.membersOf);
  },

// The ego, the global Balls, and the Balls `membersOf(park, bubble)` names
// in the ego's Grid bubble that are not cloaked from the session.
listSessionBubbleEntities(session, membersOf) {
    const egoEntity = this.getShipEntityForSession(session);
    if (!session || !session._space || !egoEntity) {
      return [];
    }
    const park = this.getGridBubbles();
    const egoBallID = getEntityMapKey(egoEntity.itemID);
    const bubbleID = gridBubbles.bubbleOf(park, egoBallID);
    const visible = [];
    const seen = new Set();
    const take = (entity) => {
      const ballID = getEntityMapKey(entity && entity.itemID);
      if (ballID === null || seen.has(ballID)) {
        return;
      }
      seen.add(ballID);
      visible.push(entity);
    };
    for (const entity of this.staticEntities) {
      if (this.isGlobalBall(entity)) {
        take(entity);
      }
    }
    if (bubbleID !== null) {
      for (const ballID of membersOf(park, bubbleID)) {
        const entity = this.getEntityByID(ballID);
        if (!entity || this.isGlobalBall(entity)) {
          continue;
        }
        if (isEntityCloaked(entity) && !canSessionSeeCloakedEntity(session, entity)) {
          continue;
        }
        take(entity);
      }
    }
    for (const entity of this.dynamicEntities.values()) {
      if (this.isGlobalBall(entity)) {
        take(entity);
      }
    }
    take(egoEntity);
    return visible;
  },

getVisibleDynamicEntitiesForSession(session) {
    return this.getVisibleEntitiesForSession(session).filter((entity) => (
      this.dynamicEntities.get(entity.itemID) === entity
    ));
  },

getVisibleStaticEntitiesForSession(session) {
    return this.getVisibleEntitiesForSession(session).filter((entity) => (
      this.dynamicEntities.get(entity.itemID) !== entity
    ));
  },

// The cloak rule alone: a cloaked Ball reaches only its owner.
filterBallparkEntitiesForSession(session, entities) {
    if (!Array.isArray(entities) || entities.length === 0) {
      return [];
    }
    return entities.filter((entity) => (
      !entity ||
      !isEntityCloaked(entity) ||
      canSessionSeeCloakedEntity(session, entity)
    ));
  },

// Uncloak's AddBallsToPark: every other Observer whose client
// is told about the Ball's Grid bubble gets it back at the front of its
// character history, built once for all of them.
acquireDynamicEntitiesForRelevantSessions(entities, options = {}) {
    let deliveredSessionCount = 0;
    let deliveredEntityCount = 0;
    const builtBySet = new Map();
    for (const session of this.sessions.values()) {
      if (!isReadyForDestiny(session)) {
        continue;
      }
      const ego = getEntityMapKey(session._space && session._space.shipID);
      const visible = (entities || []).filter((entity) => (
        entity &&
        getEntityMapKey(entity.itemID) !== ego &&
        this.canSessionSeeDynamicEntity(session, entity)
      ));
      if (visible.length === 0) {
        continue;
      }
      const setKey = visible.map((entity) => getEntityMapKey(entity.itemID)).join(",");
      if (!builtBySet.has(setKey)) {
        builtBySet.set(setKey, this.buildGridBubbleAddUpdates(visible, this.nextDestinyStamp));
      }
      const built = builtBySet.get(setKey);
      if (built.length === 0) {
        continue;
      }
      if (this.queueCharacterHistory(session, built, { inFront: true }) !== null) {
        deliveredSessionCount += 1;
        deliveredEntityCount += visible.length;
      }
    }
    return { deliveredSessionCount, deliveredEntityCount };
  },

// Whether this update gives `observer` its own Ball: a ship change made it
// the ego before its client was given it (space/transitions.js: an eject's
// capsule, ejectSession; a hull launched or spawned for the pilot and
// boarded in the same call, boardSpaceShip). The mark is consumed
// by the add, or dropped once the session's ego is another Ball.
takeAwaitedEgoAdd(observer, addedIDs) {
    const space = observer && observer.session && observer.session._space;
    if (!space || space.awaitedEgoAddID === undefined) {
      return false;
    }
    if (getEntityMapKey(space.awaitedEgoAddID) !== observer.ball) {
      delete space.awaitedEgoAddID;
      return false;
    }
    if (!addedIDs.includes(observer.ball)) {
      return false;
    }
    delete space.awaitedEgoAddID;
    return true;
  },

// The bubble update of a Destiny tick's doPreTick (runtime/destinyTick.js):
// PyAdditionsAndDeletions over the marks, then the commit. Each Observer's
// entries and exits go to its character history, stamped with the
// tick being run: an Observer whose bubble is unchanged gets its
// bubble's shared list, marshalled once per bubble as PackagedActions; one
// whose bubble changed gets its own packaged AddBalls and a plain RemoveBalls
// (_parkupdatebatcher.py:247-320). Returns what it built, per
// Observer: { session, removedIDs, addedIDs }.
updateGridBubbles(frame = null) {
    const park = this.getGridBubbles();
    // An Observer whose SetState this tick builds gets no lists: its SetState,
    // built after this update, carries what the update commits. An undocking
    // pilot's first lists come first: its SetState waits for them.
    const observers = this.listGridBubbleObservers().filter((observer) => (
      typeof this.hasPendingSetState !== "function" ||
      !this.hasPendingSetState(observer.session) ||
      isAwaitingUndockEntry(observer.session)
    ));
    // A Ball that cloaked since the last update was listed then: an
    // Observer leaving its bubble drops it in its diff.
    const cloakedSinceUpdate = this._gridBubbleCloakedSinceUpdate instanceof Set
      ? this._gridBubbleCloakedSinceUpdate
      : new Set();
    // A Ball whose global status changed since the last update is in no
    // Observer's diff deletions: its change of status tells every Observer
    // (refreshBallGlobalStatus), once.
    const globalChanged = globalStatusChanges(this);
    const lists = gridBubbles.additionsAndDeletions(park, {
      observers,
      isListed: (ballID) => this.isGridBubbleListedBall(ballID),
      wasListed: (ballID) => (
        !globalChanged.has(ballID) &&
        (this.isGridBubbleListedBall(ballID) || cloakedSinceUpdate.has(ballID))
      ),
    });
    const stamp = frame && Number.isFinite(Number(frame.stamp))
      ? Number(frame.stamp)
      : this.nextDestinyStamp;
    const built = [];
    const sharedTransitions = new Map();
    const history = this.getDestinyHistory();
    for (const observer of observers) {
      // An undocking pilot's first lists are its bubble's Balls alone, as on
      // TQ: no prime values behind the AddBalls2.
      const undockEntry = isAwaitingUndockEntry(observer.session);
      if (undockEntry) {
        this.noteUndockEntry(observer.session, stamp);
      }
      const own = lists.observers.get(observer.id);
      if (!own) {
        continue;
      }
      const list = own.shared ? lists.bubbles.get(own.bubble) : own;
      if (!list) {
        continue;
      }
      // Server's choice: an Observer's own Ball is never in its lists. Its
      // client has it from SetState, or from the park a board found it in;
      // except an ego its client has not been given (an eject's capsule, a
      // hull launched and boarded in one call), which it gets in
      // this add like every other Observer (the client's wannaBeEgo, the
      // same-scene swap's exception), whether the list is its
      // bubble's or its own diff.
      const awaitedEgo = this.takeAwaitedEgoAdd(observer, list.added);
      const removedIDs = list.removed.filter((ballID) => ballID !== observer.ball);
      const addedIDs = list.added.filter((ballID) => ballID !== observer.ball || awaitedEgo);
      if (removedIDs.length === 0 && addedIDs.length === 0) {
        continue;
      }
      const shared = own.shared === true &&
        removedIDs.length === list.removed.length &&
        addedIDs.length === list.added.length;
      let transitions;
      if (shared && sharedTransitions.has(own.bubble)) {
        transitions = sharedTransitions.get(own.bubble);
      } else {
        transitions = this.buildGridBubbleTransitions(removedIDs, addedIDs, stamp, {
          packageRemovals: shared,
          addOnly: undockEntry,
        });
        if (shared) {
          sharedTransitions.set(own.bubble, transitions);
        }
      }
      destinyHistoryList.setTransitions(history, observer.id, observer.session, transitions);
      built.push({ session: observer.session, removedIDs, addedIDs });
    }
    this.queueCeasedGlobalBallRemovals(observers, stamp);
    globalChanged.clear();
    // Sessions that left forget what they were told.
    const present = new Set(observers.map((observer) => observer.id));
    for (const id of [...park.observers.keys()]) {
      const clientID = String(id).replace(/^client:/, "");
      if (!present.has(id) && ![...this.sessions.values()].some((session) => (
        String(session.clientID) === clientID
      ))) {
        gridBubbles.forgetObserver(park, id);
      }
    }
    // The unlisted removals and the cloaks are committed.
    if (this._gridBubbleUnlistedRemovals instanceof Set) {
      this._gridBubbleUnlistedRemovals.clear();
    }
    cloakedSinceUpdate.clear();
    return built;
  },

// The bubble update's half of ceasing to be global (BallNotGlobal is
// a RemoveBall everywhere but the Ball's own bubble): each Ball that ceased
// to be global since the last update, and is not global again, is removed
// from the history of every Grid bubble with an Observer except its own,
// whose Observers keep it as a member, at the stamp of this update.
queueCeasedGlobalBallRemovals(observers, stamp) {
    const park = this.getGridBubbles();
    const bubbles = new Set();
    for (const observer of observers) {
      const bubble = gridBubbles.bubbleOf(park, observer.ball);
      if (bubble !== null && bubble !== undefined) {
        bubbles.add(bubble);
      }
    }
    for (const [ballID, isGlobal] of globalStatusChanges(this)) {
      const entity = this.getEntityByID(ballID);
      if (isGlobal || !entity || this.isGlobalBall(entity)) {
        continue;
      }
      const ownBubble = gridBubbles.bubbleOf(park, ballID);
      const removal = [destiny.buildRemoveBallsPayload([ballID])];
      for (const bubble of bubbles) {
        if (bubble !== ownBubble) {
          this.queueBallHistory(ballID, removal, { bubble, stamp });
        }
      }
    }
  },

// One list's entries and exits, as its Observers' character histories carry
// them (a destruction effect is a Grid bubble history entry at the same
// stamp): the RemoveBalls (packaged when the list
// is a bubble's shared one), then the AddBalls (always packaged), then what
// the added Balls need (their modes, prime, active effects, LaunchMissile),
// all at `stamp`.
buildGridBubbleTransitions(removedIDs, addedIDs, stamp, options = {}) {
    const updates = [];
    if (removedIDs.length > 0) {
      const removal = { stamp, payload: destiny.buildRemoveBallsPayload(removedIDs) };
      updates.push(options.packageRemovals === true
        ? buildPackagedActionUpdate(stamp, [removal])
        : removal);
    }
    const added = addedIDs
      .map((ballID) => this.getEntityByID(ballID))
      .filter(Boolean);
    if (added.length > 0) {
      const [addBalls, ...rest] = this.buildGridBubbleAddUpdates(added, stamp);
      if (addBalls) {
        updates.push(buildPackagedActionUpdate(stamp, [addBalls]), ...(options.addOnly === true ? [] : rest));
      }
    }
    return updates;
  },

buildModeUpdates(entity, stamp = this.nextDestinyStamp) {
    return buildModePresentationUpdates({
      entity,
      stamp,
      destiny,
      getCommandDirection,
      magnitude,
      toInt,
    });
  },
};
