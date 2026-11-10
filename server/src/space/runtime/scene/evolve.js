"use strict";

const { WARP_TRANSMISSION_RECEIPT } = require("../../destiny/commands/warpTransmissionReceipt");

// The scene's Evolve (three passes, two slots): the evolve phase of every
// Destiny tick (runtime/destinyTick.js).
// The engine is destiny/simulation/evolve.js; this table hands it the scene's
// free Balls and answers its hooks with the scene's gameplay:
//
//   rebox            the partition box and Grid bubble label of a Ball that
//                    moved at least sqrt(0.1) m: a warping
//                    Ball like any other
//   onMissileHit     the interim hit until Collision handling in
//                    Evolve: damage applied at once, the missile and any
//                    destroyed target removed (moribund inside Evolve)
//   onProximityFuse  a bomb whose fuse meets a target this tick detonates
//                    (bombRuntime.onProximityFuse)
//   removeBall       an expired missile, or one whose target is gone
//   stopFollowers    RealWarp's StopAllFollowers: every follower of
//                    the ship entering warp, per kind (stopAllFollowers)
//   onWarpActivated  the gameplay around a ship entering warp (modules off,
//                    the warp FX for the watchers)
//   onWarpDropped    the gameplay around a ship leaving warp (dungeon room
//                    tracking, NPC wake, persistence); nothing is sent for
//                    the warp itself, and its exit and entries are
//                    ordinary Grid bubble changes
//
// A Ball removed while Evolve runs goes moribund:
// unregisterDynamicEntity marks it and keeps the removal's options, every
// pass skips it, and bringOutTheDeads removes it at the top of the next
// Gameplay tick's gameplay, before any section reads the park; a hit
// missile, moribund for its delay, that many Destiny ticks later.

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const evolveEngine = require(path.join(
  runtimeEntryDirname,
  "./destiny/simulation/evolve.js",
));
const {
  readWarpDestination,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpDescription.js"));
const {
  isFreeBallEntity,
  isFreeBallInteractive,
} = require(path.join(runtimeEntryDirname, "./destiny/stream/ballEncoding.js"));
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  persistShipEntity,
  shouldPersistShipEntityAtTick,
} = require("../entitySpacePersistence");
const {
  deactivateWarpUnsafeActiveModulesForWarpStart,
} = require("../moduleEffectShutdown");
const {
  applyMissileHit,
  removeMissileWithoutHit,
} = require("../missileEntity");
const bombRuntime = require("../../modules/bombRuntime");
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  logMovementDebug,
  logWarpDebug,
} = require("../runtimeDebugInstrumentation");
const {
  toInt,
  toFiniteNumber,
} = require("../../../common/numbers");
const {
  canEntitiesInteractLocally,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const {
  queueOrApplyMovementChange,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/movementQueueing.js"));
const {
  listCommandBurstForceFields,
} = require("../forceFieldContainment");
const {
  buildNonEnablingMassDemotionAction, // INTERIM: until Collision handling in Evolve
} = require(path.join(runtimeEntryDirname, "./destiny/stream/actions.js")); // INTERIM: until Collision handling in Evolve

// What a force field's push changes on a ship.
const FORCE_FIELD_CORRECTION_FIELDS = Object.freeze([
  "mode",
  "speedFraction",
  "targetPoint",
  "targetEntityID",
  "effectStamp",
  "warpDestination",
]);

function isMoribund(entity) {
  return Boolean(entity && entity.isMoribund === true);
}

// Whether the last Evolve moved the Ball: it leaves the Ball's previous
// position and velocity beside the new ones.
function movedInLastEvolve(entity) {
  const position = entity.position;
  const oldPosition = entity.oldPosition;
  const velocity = entity.velocity;
  const oldVelocity = entity.oldVelocity;
  return Boolean(
    !position || !oldPosition || !velocity || !oldVelocity ||
    position.x !== oldPosition.x || position.y !== oldPosition.y || position.z !== oldPosition.z ||
    velocity.x !== oldVelocity.x || velocity.y !== oldVelocity.y || velocity.z !== oldVelocity.z
  );
}

module.exports = {

// The scene's persistent Evolve state: the moribund list and whether Evolve
// is running.
getDestinyPark() {
    if (!this._destinyPark) {
      this._destinyPark = {
        inEvolve: false,
        moribundBalls: [],
        log,
      };
    }
    return this._destinyPark;
  },

isEvolving() {
    return Boolean(this._destinyPark && this._destinyPark.inEvolve === true);
  },

// The free Balls Evolve moves: those that have joined the movement (a Ball
// added since the last doPreTick joins at the next), in the scene's order.
collectEvolveBalls() {
    const balls = [];
    for (const entity of this.dynamicEntities.values()) {
      if (
        !entity ||
        isMoribund(entity) ||
        this.isBallJoiningMovement(entity) ||
        !isFreeBallEntity(entity)
      ) {
        continue;
      }
      balls.push(entity);
    }
    return balls;
  },

// The evolve phase of a Destiny tick (runtime/destinyTick.js): one Evolve
// over every free Ball, exactly 1 s, numbered by the tick being run.
evolveDestinyTick(frame) {
    const now = toFiniteNumber(frame && frame.simTimeMs, this.getCurrentSimTimeMs());
    const park = this.getDestinyPark();
    park.balls = this.collectEvolveBalls();
    park.currentTime = toInt(frame && frame.stamp, this.nextDestinyStamp);
    park.endSimTimeMs = now;
    park.getBall = (id) => (id === null || id === undefined ? null : this.getEntityByID(id));
    park.rebox = (ball) => this.reboxBall(ball);
    park.isInDeadBubble = () => false;
    park.removeBall = (ball, details) => this.removeMissileWithoutHit(ball, details, now);
    park.onMissileHit = (missileBall, target, sweep) => this.resolveMissileHit(
      missileBall,
      target,
      sweep,
      now,
    );
    park.onProximityFuse = (ball, sweep) => this.resolveProximityFuse(ball, sweep, now);
    park.stopFollowers = (ball, details) => this.stopAllFollowers(ball, details);
    park.onWarpActivated = (ball) => this.handleWarpActivated(ball, frame);
    park.onWarpDropped = (ball, details) => this.handleWarpDropped(ball, frame, details);
    const result = evolveEngine.evolve(park);
    this.startPendingCompanionWarps();
    this.sendDueMidWarpTransmissions(park.balls, now);
    // A ship Evolve moved is saved at most once an interval, until it has
    // been saved at rest. One that has not moved since is not rewritten (main
    // saved from its tick only a ship whose movement changed).
    for (const entity of park.balls) {
      if (entity.kind !== "ship" || isMoribund(entity)) {
        continue;
      }
      if (movedInLastEvolve(entity)) {
        entity.spaceStateMovedSinceSave = true;
      }
      if (
        entity.spaceStateMovedSinceSave === true &&
        shouldPersistShipEntityAtTick(entity, now)
      ) {
        const saved = persistShipEntity(entity);
        if (saved && saved.success === true) {
          entity.spaceStateMovedSinceSave = false;
        }
      }
    }
    return result;
  },

// A pilot's message armed for the middle of its warp into a dungeon room
// (handleWarpActivated), once that time has come.
sendDueMidWarpTransmissions(balls, now) {
    let tracking = null;
    for (const entity of balls) {
      if (entity.kind !== "ship" || !entity.session) continue;
      try {
        tracking = tracking || lazyRequire("../services/dungeon/dungeonTrackingRuntime");
        if (tracking.hasPendingMidWarpTransmission(entity)) tracking.sendDueMidWarpTransmission(entity, now);
      } catch (error) {
        log.warn(`[SpaceRuntime] Dungeon mid-warp message failed for system=${this.systemID}: ${error.message}`);
      }
    }
  },

// BringOutTheDeads: every Ball that went moribund inside Evolve and whose
// delay has passed (a missile's hit keeps it two ticks) is removed, with
// the removal it asked for. Runs at the top of each Destiny tick and of each
// Gameplay tick's gameplay, never inside Evolve; either way the tick about
// to run is nextDestinyStamp.
bringOutTheDeads() {
    const park = this.getDestinyPark();
    return evolveEngine.bringOutTheDeads(park, (entity, options) => {
      entity.isMoribund = false;
      if (this.dynamicEntities.get(entity.itemID) !== entity) {
        return;
      }
      this.unregisterDynamicEntity(entity, options && options.removal ? options.removal : {});
    }, this.nextDestinyStamp);
  },

// A removal asked for while Evolve runs: the Ball goes moribund, and its
// removal waits for bringOutTheDeads. One with a delay (a missile's hit)
// stays in its Grid bubble for the delay: as retail's RemoveBall does
// at the mark, its followers fly on or stop now, and the engine
// stops it and makes it non-massive, so an Observer that acquires it in the
// window gets a stopped Ball, never a LaunchMissile. Returns true when it
// waits.
deferRemovalWhileEvolving(entity, options = {}) {
    if (!this.isEvolving() || !entity) {
      return false;
    }
    const delayed = Number(options.delay) > 0 && !isMoribund(entity);
    if (delayed) {
      this.stopAllFollowers(entity);
    }
    evolveEngine.removeBall(this.getDestinyPark(), entity, {
      delay: options.delay,
      removal: { ...options, delay: 0 },
    });
    if (delayed) {
      entity.massive = false;
      delete entity.launchPresentationSnapshot;
    }
    return true;
  },

// clean_up_followers, at the start of doPreTick: a Ball following or
// orbiting a Ball in another Grid bubble stops.
cleanUpDestinyFollowers() {
    return evolveEngine.cleanUpFollowers([...this.dynamicEntities.values()], {
      getBall: (id) => this.getEntityByID(id),
      gridBubbleOf: (entity) => this.getGridBubbleIDForEntity(entity),
      stop: (entity) => this.stopShipEntity(entity, {
        reason: "followTargetInOtherGridBubble",
      }),
    });
  },

// Drones whose controller left their Grid bubble stop and disconnect, at the
// start of doPreTick after clean_up_followers (droneRuntime
// stopDronesOfDepartedControllers).
stopDronesOfDepartedControllers() {
    const droneRuntime = lazyRequire("../services/drone/droneRuntime");
    return droneRuntime && typeof droneRuntime.stopDronesOfDepartedControllers === "function"
      ? droneRuntime.stopDronesOfDepartedControllers(this)
      : 0;
  },

// StopAllFollowers (Ballpark.cpp L5420-L5473 at v2.1.1), which
// retail's RealWarp, RemoveBall and CloakBall each run first: a missile aimed
// at `leader`, or an interactive Ball orbiting it, flies on along its own
// velocity; every other Ball following or orbiting it stops. Interactive is
// the IS_INTERACTIVE flag the Observers' clients were given
// (isFreeBallInteractive). Each client's Destiny does the same on its own
// RealWarp, RemoveBalls or CloakBall, so nothing is sent.
//
// Inside Evolve (RealWarp) and while the queue applies (a queued CloakBall)
// the change is made at once. A removal between ticks (RemoveBall) queues it
// for the next doPreTick, before the Evolve its clients' RemoveBalls
// precedes; by then a follower given a new order is left alone.
// RealWarp's call passes `options.tickStart` (the Evolve's tick-start slots,
// by Ball): a redirected follower flies on along its tick-start velocity, as
// on every client. Returns the itemIDs redirected and stopped at once.
stopAllFollowers(leader, options = {}) {
    const tickStart = options && options.tickStart instanceof Map ? options.tickStart : null;
    const leaderID = leader && leader.itemID;
    const result = { redirected: [], stopped: [] };
    if (leaderID === null || leaderID === undefined) {
      return result;
    }
    for (const entity of [...this.dynamicEntities.values()]) {
      if (!evolveEngine.isFollowerOf(entity, leaderID)) {
        continue;
      }
      const apply = () => {
        if (
          this.dynamicEntities.get(entity.itemID) !== entity ||
          !evolveEngine.isFollowerOf(entity, leaderID)
        ) {
          return null;
        }
        const outcome = evolveEngine.stopFollower(
          entity,
          isFreeBallInteractive,
          tickStart ? tickStart.get(entity) : null,
        );
        if (entity.kind === "missile") {
          entity.massive = false;
          // The launch snapshot holds only while the missile has its launch
          // target: an Observer acquiring it later gets the flyoff, not a
          // LaunchMissile at a Ball that is gone.
          delete entity.launchPresentationSnapshot;
        }
        logMovementDebug(`stopAllFollowers.${outcome}`, entity, { leaderID });
        return outcome;
      };
      if (
        !this.isEvolving() &&
        typeof this.queueMovementChange === "function" &&
        this.queueMovementChange(entity, "stopAllFollowers", apply)
      ) {
        continue;
      }
      const outcome = apply();
      if (outcome) {
        result[outcome].push(entity.itemID);
      }
    }
    return result;
  },

// The force-field boundary as a Gameplay-tick check (until Collision handling
// in Evolve makes a field a Ball): each ship's move over the last Evolve (old
// slot to current slot) is tested against the fields; a ship that crossed
// into one it may not enter gets its harmonic now and its push out queued for
// the next Destiny tick, which writes both slots.
checkForceFieldBoundaries(nowMs) {
    const forceFields = listCommandBurstForceFields(this);
    let pushed = 0;
    for (const entity of this.dynamicEntities.values()) {
      if (!entity || entity.kind !== "ship" || isMoribund(entity)) {
        continue;
      }
      if (
        forceFields.length === 0 &&
        Number(entity.destinyHarmonic ?? entity.harmonic ?? -1) === -1
      ) {
        continue;
      }
      const boundary = lazyRequire("../services/starbase/starbaseForceFieldBoundary");
      const corrected = { ...entity };
      const result = boundary.enforceForceFieldMovement(
        this,
        corrected,
        entity.oldPosition || entity.position,
        { changed: true },
        {
          forceFields,
          canInteract: canEntitiesInteractLocally,
          nowMs,
        },
      );
      entity.destinyHarmonic = corrected.destinyHarmonic;
      entity.harmonic = corrected.harmonic;
      if (!result || !result.forceFieldBlocked) {
        continue;
      }
      const correction = {};
      for (const field of FORCE_FIELD_CORRECTION_FIELDS) {
        if (!Object.is(corrected[field], entity[field])) {
          correction[field] = corrected[field];
        }
      }
      const position = { ...corrected.position };
      const velocity = { ...corrected.velocity };
      queueOrApplyMovementChange(this, entity, "forceFieldCorrection", nowMs, (atMs) => {
        Object.assign(entity, correction);
        evolveEngine.setBallPosition(entity, position);
        evolveEngine.setBallVelocity(entity, velocity);
        boundary.publishForceFieldBoundaryCorrection(this, entity, atMs, result);
      });
      pushed += 1;
    }
    return pushed;
  },

// The interim missile hit (until Collision handling in Evolve), at retail's
// dispatch site in pass 3.
resolveMissileHit(missileBall, target, sweep, nowMs) {
    return applyMissileHit(this, missileBall, target, { sweep, nowMs });
  },

// A Ball with a proximity fuse, once Evolve has moved it through its tick
// chord sweep = { from, to }: a bomb detonates when its fuse meets a target.
// bombRuntime decides what the fuse meets and
// removes the bomb itself.
resolveProximityFuse(ball, sweep, nowMs) {
    return bombRuntime.onProximityFuse(this, ball, sweep, nowMs);
  },

// A missile Evolve removes with no hit: its flight time is up or
// its target is gone.
removeMissileWithoutHit(missileBall, details = {}, nowMs) {
    return removeMissileWithoutHit(this, missileBall, {
      reason: details && details.reason,
      nowMs,
    });
  },

// After an Evolve: a ship that enters warp in the next tick (aligned, by the slot that tick
// reads) takes the companions told to warp with it (the AIR rescue fleet) along: they get
// their warp orders for that tick, aligned, and enter warp in the same tick on the same curve.
startPendingCompanionWarps() {
    if (!(this.pendingCompanionWarpShips instanceof Set)) {
      return;
    }
    for (const entity of [...this.pendingCompanionWarpShips]) {
      if (!entity.pendingCompanionWarp || this.getEntityByID(entity.itemID) !== entity) {
        this.pendingCompanionWarpShips.delete(entity);
        continue;
      }
      if (!evolveEngine.isAlignedForWarp(entity)) {
        continue;
      }
      this.pendingCompanionWarpShips.delete(entity);
      const pending = entity.pendingCompanionWarp;
      delete entity.pendingCompanionWarp;
      try {
        lazyRequire("../services/dungeon/dungeonUniverseSiteService").airEncounterPorts.warpCompanionsAligned(this, entity, pending);
      } catch (error) {
        log.warn(`[SpaceRuntime] Companion warp failed for system=${this.systemID}: ${error.message}`);
      }
    }
  },

// A ship entered warp in this tick's Evolve.
handleWarpActivated(entity, frame) {
    const now = toFiniteNumber(frame && frame.simTimeMs, this.getCurrentSimTimeMs());
    const destination = readWarpDestination(entity);
    if (entity.warpDestination) {
      entity.warpDestination.activatedAtMs = now;
      entity.warpDestination.origin = { ...entity.oldPosition };
    }
    deactivateWarpUnsafeActiveModulesForWarpStart(this, entity, now, {
      reason: "warpStart",
    });
    try {
      const HackingMgrService = lazyRequire("../services/exploration/hackingMgrService");
      if (HackingMgrService && typeof HackingMgrService.handleShipWarpStarted === "function") {
        HackingMgrService.handleShipWarpStarted(this, entity);
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] Hacking warp-start cleanup failed for system=${this.systemID}: ${error.message}`);
    }
    if (entity.session) {
      try {
        // The middle of this warp: half its flight time (Ballpark::SetupWarpConstants).
        const warp = evolveEngine.setupWarpConstants(entity.warpFactor, entity.warpDistance);
        const midWarpAtMs = now + ((warp.accelTime + Math.max(0, warp.cruiseTime) + warp.decelTime) * 500);
        lazyRequire("../services/dungeon/dungeonTrackingRuntime").armMidWarpTransmission(this, entity, destination, midWarpAtMs);
      } catch (error) {
        log.warn(`[SpaceRuntime] Dungeon mid-warp message failed for system=${this.systemID}: ${error.message}`);
      }
    }
    // Companions told to warp with this ship (the AIR rescue fleet) normally entered warp in the
    // same tick (startPendingCompanionWarps); one still pending warps in now, a tick behind.
    if (entity.pendingCompanionWarp) {
      const pending = entity.pendingCompanionWarp;
      delete entity.pendingCompanionWarp;
      try {
        lazyRequire("../services/dungeon/dungeonUniverseSiteService").airEncounterPorts.warpCompanions(this, entity, pending);
      } catch (error) {
        log.warn(`[SpaceRuntime] Companion warp failed for system=${this.systemID}: ${error.message}`);
      }
    }
    // Nothing is sent here: the warp is the WarpTo every Observer already
    // has, and its effects.Warping went with the order (TQ sends one per
    // warp order, at the order's stamp).
    persistShipEntity(entity);
    logMovementDebug("warp.started", entity, {
      effectStamp: entity.effectStamp,
      warpDistance: entity.warpDistance,
      targetEntityID: destination.targetEntityID || null,
    });
  },

// The dungeon room a pilot's warp landed in (or left), as the warp order
// named it: gameplay tracking, not visibility (scene/missionAccess.js).
commitWarpLandingDungeonContext(entity, destination, nowMs) {
    try {
      this.commitAcceptedPilotWarpDungeonContext(entity, {
        destinationStaticInstanceID: destination.destinationStaticInstanceID ?? null,
        destinationDungeonRoomKey: destination.destinationDungeonRoomKey || null,
        destinationDungeonSiteID: destination.destinationDungeonSiteID ?? null,
        [WARP_TRANSMISSION_RECEIPT]: destination[WARP_TRANSMISSION_RECEIPT],
        nowMs,
        roomPosition: entity.position,
      });
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Warp landing dungeon context failed for ship=${entity && entity.itemID}: ${error.message}`,
      );
    }
  },

// A ship left warp in this tick's Evolve: stopped at the drop, one step past
// it. Gameplay settles the landing; nothing about the warp is sent.
handleWarpDropped(entity, frame, details = {}) {
    const now = toFiniteNumber(frame && frame.simTimeMs, this.getCurrentSimTimeMs());
    const output = this.getDestinyTickOutput();
    const destination = readWarpDestination(entity);
    entity.warpDestination = null;
    // Native NPC initial ingress has a landing fallback for cold recovery;
    // once the Ball lands, subsequent AI warps must persist their own pose.
    delete entity.nativeNpcInitialWarpLanding;
    // INTERIM: until Collision handling in Evolve. Every
    // INTERIM: client's Destiny makes the ship massive at its drop
    // INTERIM: (carbon-destiny v2.1.1 Ballpark.cpp L4334, L4359), and
    // INTERIM: a massive ship bounces off a station Server flies it
    // INTERIM: through. Queued inside Evolve N, the demotion carries
    // INTERIM: N + 1: each client applies it before its first massive
    // INTERIM: Gradient (L470 runs before the drop at L483).
    if (entity.kind === "ship") { // INTERIM: until Collision handling in Evolve
      this.queueBallHistory(entity, [{ payload: buildNonEnablingMassDemotionAction(entity.itemID) }]); // INTERIM: until Collision handling in Evolve
    } // INTERIM: until Collision handling in Evolve
    if (details.overrun === true) {
      log.warn(`[SpaceRuntime] Ship stuck in extended warp: ${entity.itemID} put at its exit point`);
    }
    require("../destinyMovementEngine").recordCharacterWarpCompleted(entity.session);
    if (entity.session && isReadyForDestiny(entity.session)) {
      // A warp too short for its mid-warp message's tick: it goes before the landing's.
      try {
        lazyRequire("../services/dungeon/dungeonTrackingRuntime").sendDueMidWarpTransmission(entity, now, { landing: true });
      } catch (error) {
        log.warn(`[SpaceRuntime] Dungeon mid-warp message failed for system=${this.systemID}: ${error.message}`);
      }
      this.commitWarpLandingDungeonContext(entity, destination, now);
      output.beltRatArrivalEvents.push({
        session: entity.session,
        entity,
        nowMs: now,
        targetEntityID: toInt(destination.targetEntityID, 0),
      });
    } else if (!entity.session) {
      try {
        const npcService = lazyRequire("./npc");
        if (npcService && typeof npcService.wakeNpcController === "function") {
          const deferredWakeAtMs = toFiniteNumber(entity.deferNpcWarpCompletionWakeUntilMs, 0);
          entity.deferNpcWarpCompletionWakeUntilMs = 0;
          if (deferredWakeAtMs <= now) {
            npcService.wakeNpcController(entity.itemID, now);
          } else {
            // The deferred wake was estimated from a warp run down to a near
            // stop; the Ball leaves warp sooner, near its own speed. A
            // controller scheduled for that estimate (or its batch's common
            // wake, a little later) is woken after the two-tick grace the
            // estimate allowed (npcRuntime's NPC_WARP_WAKE_GRACE_TICKS), never
            // later. A parked controller, which another runtime drives, is
            // left asleep.
            const controller = typeof npcService.getControllerByEntityID === "function"
              ? npcService.getControllerByEntityID(entity.itemID)
              : null;
            const scheduledAtMs = toFiniteNumber(controller && controller.nextThinkAtMs, 0);
            if (scheduledAtMs >= deferredWakeAtMs && scheduledAtMs - deferredWakeAtMs <= 60_000) {
              const landingGraceMs = 2 * (toFiniteNumber(this._tickIntervalMs, 0) || 1000);
              npcService.wakeNpcController(
                entity.itemID,
                Math.min(deferredWakeAtMs, now + landingGraceMs),
              );
            }
          }
        }
      } catch (error) {
        log.warn(`[SpaceRuntime] NPC warp completion wake failed: ${error.message}`);
      }
    }
    persistShipEntity(entity);
    logWarpDebug("warp.completed", entity, {
      completionStamp: this.nextDestinyStamp,
      targetEntityID: destination.targetEntityID || null,
    });
  },
};
