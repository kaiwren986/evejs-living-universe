"use strict";

// The Movement queue (its step is the Destiny tick; it is the one stamped
// action list, scene/destinyHistory.js).
//
// Retail changes a Ball's movement only at the start of a Destiny tick: every
// order, speed change or warp made since the last tick waits in the one list,
// and DoPreTick applies it in call order before Evolve moves every Ball.
// EveJS does the same: a movement command made at any other time adds itself
// to the list as a Ballpark action and returns; the next Destiny tick's
// doPreTick (runtime/destinyTick.js) applies the list in the order the changes
// were made, so for each Ball the last change wins. A queued change
// runs the command again from the top, so it checks the Ball's state as it is
// then and queues its updates to Observers from the applied state, stamped
// nextDestinyStamp, which is the tick being run.
//
// Only removing a Ball takes effect at once. Changes queued for a Ball that has
// since left the scene are dropped.

const {
  createDestinyTickOutput,
} = require("../destinyTick");

// The labels of the queued movement changes that are warp orders
// (destiny/commands/warpCommands.js): what main called a pending warp.
const WARP_ORDER_LABELS = new Set([
  "warpToPoint",
  "warpDynamicEntityToPoint",
  "forceStartPendingWarp",
  "startSessionlessWarpIngress",
]);

// The movement values a ship's modules and skills derive (mass, agility, max
// speed and so on), which Dogma may change at any moment of a tick.
const SHIP_MOTION_FIELDS = Object.freeze([
  "mass",
  "inertia",
  "maxVelocity",
  "alignTime",
  "agilitySeconds",
  "maxAccelerationTime",
  "radius",
]);

function captureShipMotion(entity) {
  const values = {};
  for (const field of SHIP_MOTION_FIELDS) {
    values[field] = entity ? entity[field] : undefined;
  }
  return values;
}

function shipMotionDiffers(left, right) {
  return SHIP_MOTION_FIELDS.some((field) => !Object.is(left[field], right[field]));
}

function writeShipMotion(entity, values) {
  for (const field of SHIP_MOTION_FIELDS) {
    if (!Object.is(entity[field], values[field])) {
      entity[field] = values[field];
    }
  }
}

module.exports = {

// A Ball added to the scene joins the movement at the start of the next
// Destiny tick. Until then nothing moves it, and what is done to it (a new
// drone set to orbit its ship, say) is how it is added, so it applies at once.
markBallJoiningMovement(entity) {
    if (!entity) {
      return;
    }
    if (!(this._joiningMovementBalls instanceof Set)) {
      this._joiningMovementBalls = new Set();
    }
    this._joiningMovementBalls.add(entity);
  },

isBallJoiningMovement(entity) {
    return this._joiningMovementBalls instanceof Set &&
      this._joiningMovementBalls.has(entity);
  },

// Adds a movement change for `entity` to the queue, to be applied at the start
// of the next Destiny tick. Returns false when the change must be applied
// now instead: while the queue itself is being applied, a queued command runs
// through here again and must go on to change the Ball; and a Ball that has
// not joined the movement yet takes it at once.
queueMovementChange(entity, label, applyChange) {
    if (
      this._applyingMovementQueue === true ||
      !entity ||
      this.isBallJoiningMovement(entity)
    ) {
      return false;
    }
    if (!(this._movementQueueCounts instanceof Map)) {
      this._movementQueueCounts = new Map();
    }
    this.queueBallparkAction(entity, String(label || "movement"), applyChange);
    this._movementQueueCounts.set(
      entity,
      (this._movementQueueCounts.get(entity) || 0) + 1,
    );
    if (WARP_ORDER_LABELS.has(label)) {
      if (!(this._queuedWarpOrderBalls instanceof Set)) {
        this._queuedWarpOrderBalls = new Set();
      }
      this._queuedWarpOrderBalls.add(entity);
    }
    return true;
  },

// Whether changes wait in the queue for `entity`. A command that would skip
// itself because the Ball already does what it asks must not when a change is
// still waiting: the Ball will not be doing it by the time this one applies.
hasQueuedMovementChange(entity) {
    return Boolean(
      this._applyingMovementQueue !== true &&
      entity &&
      this._movementQueueCounts instanceof Map &&
      this._movementQueueCounts.has(entity)
    );
  },

// Whether a warp order waits in the queue for `entity`: it starts to warp at
// the next Destiny tick. Its other orders (an approach, a stop) do not count.
hasQueuedWarpOrder(entity) {
    return Boolean(
      this._applyingMovementQueue !== true &&
      entity &&
      this._queuedWarpOrderBalls instanceof Set &&
      this._queuedWarpOrderBalls.has(entity)
    );
  },

// Whether a movement change to `entity` made now waits for the next Destiny
// tick: it does unless the queue is being applied, or the Ball has not joined
// the movement yet.
movementChangesWait(entity) {
    return Boolean(
      entity &&
      this._applyingMovementQueue !== true &&
      !this.isBallJoiningMovement(entity),
    );
  },

captureShipMotion(entity) {
    return captureShipMotion(entity);
  },

// Takes what Dogma derived for a ship on a stand-in (`derived`, made with
// Object.create(entity) so it reads through to the ship): every value but the
// derived movement values, which wait (queueShipMotionChange), and the
// commanded speed, which is the pilot's and only ever restored by Dogma.
adoptDerivedShipState(entity, derived) {
    for (const [key, value] of Object.entries(derived)) {
      if (!SHIP_MOTION_FIELDS.includes(key) && key !== "speedFraction") {
        entity[key] = value;
      }
    }
  },

// A ship's derived movement values (a module, a web, a skill) are now `after`.
// They wait for the next Destiny tick, where the queue writes them and calls
// `onApplied(before)` with the values they replaced, to tell Observers. Until
// then the ship's Dogma has them as pendingShipMotion. Returns false, with
// nothing queued, when they need not wait (movementChangesWait) or nothing
// changes.
queueShipMotionChange(entity, after, onApplied) {
    if (!this.movementChangesWait(entity)) {
      return false;
    }
    const current = entity.pendingShipMotion || captureShipMotion(entity);
    if (!shipMotionDiffers(current, after)) {
      return false;
    }
    entity.pendingShipMotion = after;
    return this.queueMovementChange(entity, "shipMotion", () => {
      // For each Ball the last change wins: values a later change replaced
      // (queued, or written at once) are skipped.
      if (entity.pendingShipMotion !== after) {
        return;
      }
      delete entity.pendingShipMotion;
      const before = captureShipMotion(entity);
      writeShipMotion(entity, after);
      if (typeof onApplied === "function") {
        onApplied(before);
      }
    });
  },

// Derived movement values written at once (the queue is being applied, or the
// Ball is joining) replace any still waiting.
dropPendingShipMotion(entity) {
    if (entity && entity.pendingShipMotion) {
      delete entity.pendingShipMotion;
    }
  },

// What the running Destiny tick hands the Gameplay tick after it (the
// belt rats a warp landing wakes). Outside a Destiny tick, what is built here
// joins the next tick's output.
getDestinyTickOutput() {
    if (this._destinyTickFrame && this._destinyTickFrame.output) {
      return this._destinyTickFrame.output;
    }
    if (!this._pendingDestinyTickOutput) {
      this._pendingDestinyTickOutput = createDestinyTickOutput();
    }
    return this._pendingDestinyTickOutput;
  },

hasPendingMovementQueue() {
    const history = this._destinyHistory;
    return Boolean(history && history.list.some((entry) => entry.kind === "action"));
  },

// A cloak is a Ballpark action like a movement change (retail's CloakBall):
// it applies in call order with the list, before the Grid bubble update of
// the tick that applies it, which then lists the Ball nowhere, and its
// CloakBall, routed after that update, reaches everyone who could see the
// Ball, in the bubble it was cloaked in. Returns false when it must apply
// now: while the list is being applied, or for a Ball that has not joined
// the movement yet.
queueCloakChange(entity, applyChange) {
    if (
      this._applyingMovementQueue === true ||
      !entity ||
      this.isBallJoiningMovement(entity)
    ) {
      return false;
    }
    if (!Array.isArray(this._pendingCloakChanges)) {
      this._pendingCloakChanges = [];
    }
    const entry = { entity, cancelled: false };
    this._pendingCloakChanges.push(entry);
    this.queueBallparkAction(entity, "cloak", () => {
      this._pendingCloakChanges = this._pendingCloakChanges.filter((candidate) => candidate !== entry);
      if (!entry.cancelled) {
        applyChange();
      }
    });
    return true;
  },

// Drops the cloaks waiting for `entity` (an uncloak before the cloak applied).
// Returns how many were dropped.
dropQueuedCloakChanges(entity) {
    let dropped = 0;
    for (const entry of Array.isArray(this._pendingCloakChanges) ? this._pendingCloakChanges : []) {
      if (entry.entity === entity && !entry.cancelled) {
        entry.cancelled = true;
        dropped += 1;
      }
    }
    return dropped;
  },

// The Destiny tick's doPreTick (runtime/destinyTick.js), first: Balls added
// since the last tick join, what was built for the Gameplay tick outside a
// tick joins this tick's output, and the one list's Ballpark actions are
// applied in call order, its updates held until the Grid bubble update has
// run (scene/destinyHistory.js routeDestinyTickQueue).
applyDestinyTickQueue(frame = null) {
    if (this._joiningMovementBalls instanceof Set) {
      this._joiningMovementBalls.clear();
    }
    const pendingOutput = this._pendingDestinyTickOutput;
    if (pendingOutput && frame && frame.output) {
      this._pendingDestinyTickOutput = null;
      for (const [key, entries] of Object.entries(pendingOutput)) {
        if (Array.isArray(frame.output[key])) {
          frame.output[key].push(...entries);
        }
      }
    }
    this._movementQueueCounts = new Map();
    this._queuedWarpOrderBalls = new Set();
    this._applyingMovementQueue = true;
    try {
      return this.applyDestinyTickList(frame);
    } finally {
      this._applyingMovementQueue = false;
    }
  },

};
