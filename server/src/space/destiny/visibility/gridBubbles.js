"use strict";

// Grid bubbles: retail's label on the level-0 partition boxes, and the
// +1/-1 marks that doPreTick turns into entered and left lists.
//
// Retail (carbon-destiny v2.1.1):
//
// - A Grid bubble is a label on occupied level-0 boxes, 7,864,320 m wide.
//   A Ball takes its own box's label, else the first of the 26 touching boxes
//   with one (Box::NearbyBubbles, looping x, y, z from -1 to 1), else a fresh
//   id, never reused (Ballpark::InsertInBoxes). A box exists only while a Ball
//   is in it, so a box released empty forgets its label. Nothing merges,
//   splits or re-centres bubbles.
// - The only writers are a moved Ball's re-box in Evolve, AddBall and
//   RemoveBall. Each change marks the Ball +1 in its new bubble and -1 in its
//   old (AddToBubble): a -1 in the new bubble becomes 0, an uncommitted +1 in
//   the old is deleted.
// - Once per tick, in doPreTick, additionsAndDeletions reads the marks: every
//   bubble with an Observer gets one shared list (its +1s added, its -1s
//   removed); an Observer whose bubble changed gets its own diff of the old
//   and new bubble, all deletions then all additions; a bubble with no
//   Observer builds nothing. The marks then commit (CopyBubbles): +1
//   becomes 0, -1 goes, an empty bubble goes (PyAdditionsAndDeletions,
//   Thunkers.cpp:2568-2892; CopyBubbles, Ballpark.cpp:6158-6218).
//
// One Server choice beside retail: an Observer's diff is taken against the
// bubble its client was last told about (the last additionsAndDeletions, or
// its SetState), where retail keeps the Ball's previous bubble, which two
// changes between two calls would make an intermediate one.
//
// Ball ids are whatever the caller keys Balls by; they are compared with
// Map semantics.

const GRID_BUBBLE_BOX_METERS = 7864320;

// Retail's loop order: x outer, then y, then z, each -1, 0, 1, self skipped.
const NEIGHBOUR_OFFSETS = Object.freeze((() => {
  const offsets = [];
  for (let i = -1; i < 2; i += 1) {
    for (let j = -1; j < 2; j += 1) {
      for (let k = -1; k < 2; k += 1) {
        if (i !== 0 || j !== 0 || k !== 0) {
          offsets.push([i, j, k]);
        }
      }
    }
  }
  return offsets;
})());

function createGridBubbles(options = {}) {
  return {
    boxMeters: Number(options.boxMeters) > 0
      ? Number(options.boxMeters)
      : GRID_BUBBLE_BOX_METERS,
    // boxKey -> { bubble, balls: Set }
    boxes: new Map(),
    // bubble id -> Map(ballID -> mark: +1 entered, 0 member, -1 left)
    bubbles: new Map(),
    // ballID -> { box, bubble }
    balls: new Map(),
    // Observer id -> the bubble its client was last told about (null: none)
    observers: new Map(),
    nextBubbleID: 1,
  };
}

function axisIndex(value, boxMeters) {
  const numeric = Number(value);
  return Math.floor((Number.isFinite(numeric) ? numeric : 0) / boxMeters);
}

function boxIndicesOf(park, position) {
  const source = position || {};
  return [
    axisIndex(source.x, park.boxMeters),
    axisIndex(source.y, park.boxMeters),
    axisIndex(source.z, park.boxMeters),
  ];
}

function boxKeyOf(indices) {
  return `${indices[0]}:${indices[1]}:${indices[2]}`;
}

// The partition box key of a position (the scene's public-grid key).
function boxKeyForPosition(park, position) {
  return boxKeyOf(boxIndicesOf(park, position));
}

function marksFor(park, bubble) {
  let marks = park.bubbles.get(bubble);
  if (!marks) {
    marks = new Map();
    park.bubbles.set(bubble, marks);
  }
  return marks;
}

// AddToBubble: the Ball leaves `from` and enters `to` (either may be null).
function moveMarks(park, ballID, from, to) {
  if (from !== null && from !== undefined) {
    const marks = park.bubbles.get(from);
    if (marks && marks.has(ballID)) {
      if (marks.get(ballID) > 0) {
        marks.delete(ballID);
      } else {
        marks.set(ballID, -1);
      }
    }
  }
  if (to !== null && to !== undefined) {
    const marks = marksFor(park, to);
    if (marks.get(ballID) === -1) {
      marks.set(ballID, 0);
    } else if (!marks.has(ballID)) {
      marks.set(ballID, 1);
    }
  }
}

function leaveBox(park, record, ballID) {
  if (!record || record.box === null) {
    return;
  }
  const box = park.boxes.get(record.box);
  if (box) {
    box.balls.delete(ballID);
    if (box.balls.size === 0) {
      park.boxes.delete(record.box);
    }
  }
  record.box = null;
}

// Box::NearbyBubbles: the first labelled touching box in loop order.
function nearbyBubble(park, indices) {
  for (const [i, j, k] of NEIGHBOUR_OFFSETS) {
    const box = park.boxes.get(boxKeyOf([indices[0] + i, indices[1] + j, indices[2] + k]));
    if (box && box.bubble !== null) {
      return box.bubble;
    }
  }
  return null;
}

// Ballpark::InsertInBoxes: puts the Ball in the box at `position` and gives
// it that box's bubble. Returns its bubble.
function insert(park, ballID, position) {
  let record = park.balls.get(ballID);
  if (!record) {
    record = { box: null, bubble: null };
    park.balls.set(ballID, record);
  }
  const indices = boxIndicesOf(park, position);
  const key = boxKeyOf(indices);
  if (record.box === key && record.bubble !== null) {
    return record.bubble;
  }
  // Out of its old box first, so a box it was alone in is no false
  // neighbour.
  leaveBox(park, record, ballID);
  let box = park.boxes.get(key);
  if (!box) {
    box = { bubble: null, balls: new Set() };
    park.boxes.set(key, box);
  }
  if (box.bubble === null) {
    box.bubble = nearbyBubble(park, indices);
    if (box.bubble === null) {
      box.bubble = park.nextBubbleID;
      park.nextBubbleID += 1;
    }
  }
  box.balls.add(ballID);
  record.box = key;
  if (record.bubble !== box.bubble) {
    moveMarks(park, ballID, record.bubble, box.bubble);
    record.bubble = box.bubble;
  }
  return record.bubble;
}

// AddBall, and Evolve pass 3's re-box of a Ball that moved: the Ball into
// the box of `position` (an AddBall of a Ball already in re-boxes it).
function reboxBall(park, ballID, position) {
  return insert(park, ballID, position);
}

// RemoveBall: out of its box and its bubble at once.
function removeBall(park, ballID) {
  const record = park.balls.get(ballID);
  if (!record) {
    return null;
  }
  const left = record.bubble;
  leaveBox(park, record, ballID);
  moveMarks(park, ballID, left, null);
  park.balls.delete(ballID);
  return left;
}

function hasBall(park, ballID) {
  return park.balls.has(ballID);
}

// The bubble a Ball is in now (retail's newBubbleId), or null.
function bubbleOf(park, ballID) {
  const record = park.balls.get(ballID);
  return record ? record.bubble : null;
}

function marksOf(park, bubble) {
  return park.bubbles.get(bubble) || new Map();
}

// The Balls in a bubble now: marked +1 or 0.
function membersOf(park, bubble) {
  const members = [];
  for (const [ballID, mark] of marksOf(park, bubble)) {
    if (mark >= 0) {
      members.push(ballID);
    }
  }
  return members;
}

// The Balls a client told about `bubble` at the last commit knows: marked 0
// or -1 (left since, and not yet removed).
function knownMembersOf(park, bubble) {
  const members = [];
  for (const [ballID, mark] of marksOf(park, bubble)) {
    if (mark <= 0) {
      members.push(ballID);
    }
  }
  return members;
}

// The bubble a Ball was in at the last commit: where its mark is 0 or -1.
function committedBubbleOf(park, ballID) {
  const record = park.balls.get(ballID);
  if (record && record.bubble !== null) {
    const mark = marksOf(park, record.bubble).get(ballID);
    if (mark === 0) {
      return record.bubble;
    }
  }
  for (const [bubble, marks] of park.bubbles) {
    if (marks.get(ballID) === -1) {
      return bubble;
    }
  }
  return null;
}

// An Observer is { id, ball }: the id is whose client it is (a session),
// the ball its own Ball, which a ship swap changes. A bare id stands for
// { id, ball: id }.
function normalizeObserver(observer) {
  return observer && typeof observer === "object"
    ? { id: observer.id, ball: observer.ball }
    : { id: observer, ball: observer };
}

// The bubble an Observer's client was last told about, or null.
function knownBubbleOf(park, observerID) {
  return park.observers.has(observerID) ? park.observers.get(observerID) : null;
}

// SetState told the Observer everything `bubble` (default its own Ball's)
// held at the last commit (knownMembersOf): its next lists continue from
// there.
function setObserverBaseline(park, observer, bubble) {
  const { id, ball } = normalizeObserver(observer);
  const resolved = bubble === undefined ? bubbleOf(park, ball) : bubble;
  park.observers.set(id, resolved === undefined ? null : resolved);
}

// The Observer has left (its session detached): nothing is known for it.
function forgetObserver(park, observerID) {
  park.observers.delete(observerID);
}

function listed(options, ballID) {
  return typeof options.isListed === "function" ? options.isListed(ballID) !== false : true;
}

// Whether a Ball was listed when the marks last committed: what an
// Observer's client was told about its old bubble. A Ball cloaked since is
// unlisted now but was listed then (options.wasListed).
function wasListed(options, ballID) {
  return typeof options.wasListed === "function"
    ? options.wasListed(ballID) !== false
    : listed(options, ballID);
}

// PopulateAddDelForBubble: a bubble's shared list from its marks.
function bubbleList(park, bubble, options) {
  const added = [];
  const removed = [];
  for (const [ballID, mark] of marksOf(park, bubble)) {
    if (mark === 0 || !listed(options, ballID)) {
      continue;
    }
    (mark > 0 ? added : removed).push(ballID);
  }
  return { added, removed };
}

// An Observer that changed bubble: what its client was told its old bubble
// held that the new one does not list (deletions), and what the new one
// lists that the old did not hold (additions). Like retail, it names no Ball
// by id: an own Ball that crossed with the Observer is in both bubbles, so in
// neither list, while one its client was never told about (the capsule of an
// eject or a ship death, boxed in the new bubble) is an addition. A Ball
// listed in the old bubble at the last commit and unlisted
// now (it cloaked this tick) is a deletion: the Observer gets its new
// bubble's batch, not the old one's CloakBall.
function observerDiff(park, oldBubble, newBubble, options) {
  const oldMarks = oldBubble === null ? new Map() : marksOf(park, oldBubble);
  const newMarks = newBubble === null ? new Map() : marksOf(park, newBubble);
  const removed = [];
  for (const [id, mark] of oldMarks) {
    if (mark > 0 || !wasListed(options, id)) {
      continue;
    }
    if (!(newMarks.has(id) && newMarks.get(id) >= 0 && listed(options, id))) {
      removed.push(id);
    }
  }
  const added = [];
  for (const [id, mark] of newMarks) {
    if (mark < 0 || !listed(options, id)) {
      continue;
    }
    if (!(oldMarks.has(id) && oldMarks.get(id) <= 0)) {
      added.push(id);
    }
  }
  return { removed, added };
}

// CopyBubbles: +1 becomes 0, -1 goes, an empty bubble goes.
function commit(park) {
  for (const [bubble, marks] of park.bubbles) {
    for (const [ballID, mark] of marks) {
      if (mark > 0) {
        marks.set(ballID, 0);
      } else if (mark < 0) {
        marks.delete(ballID);
      }
    }
    if (marks.size === 0) {
      park.bubbles.delete(bubble);
    }
  }
}

// PyAdditionsAndDeletions + CopyBubbles, once per Destiny tick in doPreTick.
//
// options.observers: the Observers, each { id, ball } (normalizeObserver);
// options.isListed(ballID): false for a Ball no list carries (a global Ball,
// a cloaked one); options.wasListed(ballID): whether it was listed at the
// last commit (default isListed), for the deletions of an Observer's diff.
//
// Returns { bubbles: Map(bubble -> { added, removed }) for every bubble with
// an Observer, observers: Map(id -> { shared: true, bubble } or
// { shared: false, bubble, oldBubble, removed, added }) }. A shared list is
// the bubble's, one object for all its Observers; a diff names the
// Observer's own Ball only when it is new to the Observer's client.
function additionsAndDeletions(park, options = {}) {
  const observers = (options.observers || [])
    .map(normalizeObserver)
    .filter((observer) => park.balls.has(observer.ball));
  const bubbles = new Map();
  for (const observer of observers) {
    const bubble = park.balls.get(observer.ball).bubble;
    if (bubble !== null && !bubbles.has(bubble)) {
      bubbles.set(bubble, bubbleList(park, bubble, options));
    }
  }
  const perObserver = new Map();
  for (const observer of observers) {
    const bubble = park.balls.get(observer.ball).bubble;
    const known = knownBubbleOf(park, observer.id);
    if (known !== null && known === bubble && park.bubbles.has(known)) {
      perObserver.set(observer.id, { shared: true, bubble });
    } else {
      perObserver.set(observer.id, {
        shared: false,
        bubble,
        oldBubble: known,
        ...observerDiff(park, known, bubble, options),
      });
    }
  }
  for (const observer of observers) {
    park.observers.set(observer.id, park.balls.get(observer.ball).bubble);
  }
  commit(park);
  return { bubbles, observers: perObserver };
}

module.exports = {
  GRID_BUBBLE_BOX_METERS,
  NEIGHBOUR_OFFSETS,
  additionsAndDeletions,
  boxKeyForPosition,
  bubbleOf,
  committedBubbleOf,
  createGridBubbles,
  forgetObserver,
  hasBall,
  knownBubbleOf,
  knownMembersOf,
  marksOf,
  membersOf,
  normalizeObserver,
  reboxBall,
  removeBall,
  setObserverBaseline,
};
