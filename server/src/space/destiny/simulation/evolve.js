"use strict";

// Evolve: retail's three passes over two slots per Ball. Adapted from
// carbonengine/destiny v2.1.1 (Ballpark.cpp Evolve, EvolveBehaviorForBall,
// GotoThrust, EvolveFollow, EvolveMissile, EvolveOrbit (old style),
// EvolveStop, EvolveWarp, WarpTo, RealWarp, EntityWarpIn, SetupWarpConstants,
// WarpDistance, Integrate, RemoveBall, BringOutTheDeads); MIT terms are in
// simulation/README.md.
//
// Every Ball carries two slots for position, velocity and direction:
//
//   current  position / velocity / direction: what everything outside Evolve
//            reads, constant between Destiny ticks;
//   scratch  oldPosition / oldVelocity / oldDirection: pass 2 writes the
//            Ball's next state there, pass 3 swaps it in, after which it holds
//            the previous tick's state.
//
// One Evolve, run once per Destiny tick with dt = 1 s whatever the clock:
//
//   pass 1  behaviour: each Ball's acceleration from the current slots as the
//           Movement queue left them (mode STOP, GOTO, FOLLOW, ORBIT, WARP or
//           MISSILE, with retail's effectStamp); a missile past its flight
//           time that reached this Evolve; the
//           dead-bubble skip point (every Ball answers live: a scaffold);
//           then each warp activation's StopAllFollowers, by retail's ID
//           order;
//   seam    collision: per massive Ball, from the tick-start slots and pass
//           1's accelerations, one acceleration back plus a contact list
//           (retail's Gradient site; a placeholder until Evolve handles
//           collisions);
//   pass 2  integrate each Ball exactly 1 s into its scratch slot; a warping
//           Ball takes the closed-form warp curve instead;
//   pass 3  swap the slots; re-box a Ball that moved at least sqrt(0.1) m;
//           dispatch each moved missile's hit; hand each Ball with
//           a proximity fuse its tick chord; remove each missile whose
//           flight time ends inside the next Evolve; the warp
//           drops; the warp activations. Every hook runs inside the pass-3
//           guard (runPassThreeHook), removeBall included.
//
// A Ball removed inside Evolve only goes moribund: every pass skips
// it, and bringOutTheDeads removes it outside Evolve.
//
// The park handed to evolve() is plain data plus hooks, so this module never
// reaches into a scene:
//
//   balls           the free Balls, in visit order
//   currentTime     the Destiny tick being evolved (N; the counter becomes N
//                   at its end)
//   endSimTimeMs    the sim time this tick's Evolve ends at (missile expiry)
//   getBall(id)     any Ball by id (targets may be non-free)
//   hooks, each optional: isInDeadBubble, collide, rebox, onMissileHit,
//   onProximityFuse, removeBall, onWarpActivated, onWarpDropped,
//   stopFollowers, log

const {
  integrateCarbonMotion,
} = require("./carbonIntegration");
const {
  DESTINY_TICK_INTERVAL_MS: DESTINY_TICK_MS,
} = require("../constants");

const DESTINY_FRICTION = 1_000_000;
const DESTINY_TICK_SECONDS = DESTINY_TICK_MS / 1000;
const ONE_AU_IN_METERS = 149_597_870_700;
const REBOX_MIN_MOVE_SQUARED = 0.1;
const MAX_ALIGN_TICKS = 180;
const MISSILE_LAUNCH_THRUST_MS = 800;
const WARP_TO_GOTO_DISTANCE_SQUARED = 1e10;
const WARP_FACTOR_TO_AU_PER_SECOND = 0.001;
const WARP_FACTOR_TO_ACCELERATION = 1 / 1000;
const WARP_FACTOR_TO_DECELERATION = 1 / 3000;
const WARP_MAX_DECELERATION = 2.0;
const WARP_DROPOUT_SPEED_MAX = 100;
const ORBITAL_PRECESSION = 0.001;
const ORBIT_GOTO_SCALE = 10 * ONE_AU_IN_METERS;
// EvolveStop without dynamical orientation: v.y = (v.y - 0.07 v.y) / 1.07.
const STOP_Y_DAMPING = 0.93 / 1.07;
// Server's own heading turn (retail's dynamical orientation is off).
const TURN_ALIGNMENT_RADIANS = 4 * (Math.PI / 180);

function finite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function vec(x, y, z) {
  return { x, y, z };
}

function copy(v) {
  return v ? vec(finite(v.x), finite(v.y), finite(v.z)) : vec(0, 0, 0);
}

function add(a, b) {
  return vec(a.x + b.x, a.y + b.y, a.z + b.z);
}

function sub(a, b) {
  return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

function scale(a, s) {
  return vec(a.x * s, a.y * s, a.z * s);
}

function dot(a, b) {
  return (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
}

function cross(a, b) {
  return vec(
    (a.y * b.z) - (a.z * b.y),
    (a.z * b.x) - (a.x * b.z),
    (a.x * b.y) - (a.y * b.x),
  );
}

function length(a) {
  return Math.sqrt(dot(a, a));
}

function unit(a, fallback = null) {
  const l = length(a);
  if (l > 0 && Number.isFinite(l)) {
    return scale(a, 1 / l);
  }
  return fallback ? copy(fallback) : vec(0, 0, 0);
}

function isFiniteVector(v) {
  return Boolean(
    v &&
    Number.isFinite(Number(v.x)) &&
    Number.isFinite(Number(v.y)) &&
    Number.isFinite(Number(v.z)),
  );
}

function truncate7(value) {
  return Math.trunc(value * 10_000_000) / 10_000_000;
}

// ---------------------------------------------------------------------------
// Slots

// A new Ball: its old slot is where it was one tick ago at its
// velocity.
function seedBallSlots(ball, dt = DESTINY_TICK_SECONDS) {
  if (!ball) {
    return ball;
  }
  const position = copy(ball.position);
  const velocity = copy(ball.velocity);
  ball.position = position;
  ball.velocity = velocity;
  ball.direction = unit(copy(ball.direction), vec(1, 0, 0));
  ball.oldPosition = sub(position, scale(velocity, dt));
  ball.oldVelocity = copy(velocity);
  ball.oldDirection = copy(ball.direction);
  return ball;
}

function hasSlots(ball) {
  return Boolean(ball && ball.oldPosition && ball.oldVelocity);
}

// SetBallPosition: both slots.
function setBallPosition(ball, position) {
  ball.position = copy(position);
  ball.oldPosition = copy(position);
  return ball;
}

// SetBallVelocity: both slots, and the heading snaps to it.
function setBallVelocity(ball, velocity) {
  ball.velocity = copy(velocity);
  ball.oldVelocity = copy(velocity);
  if (length(ball.velocity) > 0) {
    ball.direction = unit(ball.velocity);
    ball.oldDirection = copy(ball.direction);
  }
  return ball;
}

// ---------------------------------------------------------------------------
// Ball state

function modeOf(ball) {
  return String(ball && ball.mode || "STOP").toUpperCase();
}

function isMoribund(ball) {
  return Boolean(ball && ball.isMoribund === true);
}

function isCloaked(ball) {
  return Boolean(
    ball &&
    (ball.isCloaked === true || finite(ball.isCloaked, 0) > 0 || finite(ball.cloakMode, 0) > 0),
  );
}

// Retail's Ball::IsWarpish / IsAligningForWarp / IsWarping.
function isWarpish(ball) {
  return modeOf(ball) === "WARP";
}

function isAligningForWarp(ball) {
  return isWarpish(ball) && finite(ball.effectStamp, -1) < 0;
}

function isWarping(ball) {
  return isWarpish(ball) && finite(ball.effectStamp, -1) >= 0;
}

// m in Integrate: mass * agility. A Ball without them (a wreck, a container)
// gets one second of agility.
function inertialMass(ball) {
  const mass = finite(ball && ball.mass, 0);
  const agility = finite(ball && ball.inertia, 0);
  // Retail's agility defaults to 1 (Ball::Ball): a Ball given only a mass
  // (a tractored wreck's SetBallMass) has m = mass.
  const official = mass * (agility > 0 ? agility : 1);
  if (official > 0) {
    return official;
  }
  const agilitySeconds = finite(ball && ball.agilitySeconds, 0);
  return Math.max(agilitySeconds, 1) * DESTINY_FRICTION;
}

function cruiseSpeed(ball) {
  return Math.max(0, finite(ball.speedFraction, 0)) * Math.max(0, finite(ball.maxVelocity, 0));
}

// Ballpark::Stop: mode STOP, the follow cleared, the warp left.
function stopBall(ball) {
  ball.mode = "STOP";
  ball.targetEntityID = null;
  ball.effectStamp = 0;
  ball.warpDistance = 0;
}

// Ballpark::GotoDirection (Ballpark.cpp L4487-L4509 at v2.1.1): GotoPoint at
// 1e17 m along the direction, which stops whatever the Ball did and keeps its
// speed fraction unless that was 0 (L4533-L4554). A Ball at rest has no
// direction to fly on along: it stops (an assumption; retail's Normalize of a
// zero vector is not in the published source). The point is taken from
// `from`, retail's mNewPos at the call (default the Ball's position).
function gotoDirection(ball, direction, from = ball.position) {
  const along = unit(copy(direction));
  stopBall(ball);
  if (!(length(along) > 0)) {
    return;
  }
  ball.mode = "GOTO";
  ball.targetPoint = add(copy(from), scale(along, 1e17));
  if (!(finite(ball.speedFraction, 0) > 0)) {
    ball.speedFraction = 1;
  }
}

// Whether `ball` follows, orbits or is aimed at the Ball `leaderID`: one of
// retail's mFollowers (FOLLOW, ORBIT, MISSILE; Server has no FORMATION).
function isFollowerOf(ball, leaderID) {
  const mode = modeOf(ball);
  return Boolean(
    ball &&
    (mode === "FOLLOW" || mode === "ORBIT" || mode === "MISSILE") &&
    !isMoribund(ball) &&
    leaderID !== null &&
    leaderID !== undefined &&
    ball.itemID !== leaderID &&
    finite(ball.targetEntityID, 0) === finite(leaderID, 0)
  );
}

// StopAllFollowers for one follower (Ballpark.cpp L5458-L5471 at v2.1.1): a
// missile, or an interactive Ball in ORBIT, flies on along its own velocity
// (GotoDirection(f, f->mNewVel)), a missile without collisions from then on;
// every other follower stops. `isInteractive` is the Ball's IS_INTERACTIVE
// flag as its Observers' clients have it. `slot` is the follower's mNewPos
// and mNewVel at the call when they are no longer its current slot: a
// RealWarp's call, made in pass 1 on retail, where they are the tick-start
// values. Returns "redirected" or "stopped".
function stopFollower(ball, isInteractive, slot = null) {
  const mode = modeOf(ball);
  if (mode === "MISSILE" || (mode === "ORBIT" && isInteractive(ball) === true)) {
    if (mode === "MISSILE") {
      ball.isMassive = false;
    }
    gotoDirection(
      ball,
      slot && slot.velocity ? slot.velocity : ball.velocity,
      slot && slot.position ? slot.position : ball.position,
    );
    return "redirected";
  }
  stopBall(ball);
  return "stopped";
}

// StopAllFollowers (Ballpark.cpp L5420-L5473 at v2.1.1), which
// retail's RealWarp, RemoveBall and CloakBall each run first: every follower
// of `leaderID` among `balls`, per kind (stopFollower). It is a side effect
// of those calls, not an action: each client's Destiny runs the same code at
// the same stamp, so nothing is sent. Returns the Balls redirected and
// stopped.
function stopAllFollowers(balls, leaderID, options = {}) {
  const isInteractive = typeof options.isInteractive === "function"
    ? options.isInteractive
    : () => false;
  const tickStart = options.tickStart instanceof Map ? options.tickStart : null;
  const result = { redirected: [], stopped: [] };
  for (const ball of balls) {
    if (isFollowerOf(ball, leaderID)) {
      result[stopFollower(ball, isInteractive, tickStart && tickStart.get(ball))].push(ball);
    }
  }
  return result;
}

// Whether Ball ID `a` comes after `b` in retail's visit order: mFreeBalls is
// a std::map keyed by ball ID (carbon-destiny Ballpark.h L60), so every
// Evolve pass, on the server and on every client, visits in ascending ID.
function visitedAfter(a, b) {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return finite(a, 0) > finite(b, 0);
  }
}

// ---------------------------------------------------------------------------
// Behaviour (pass 1)

// Ballpark::Integrate: the exact solution of m dv/dt = m a - k v over t, as
// Server's integrateCarbonMotion has it.
function integrate(position, velocity, acceleration, mass, t = DESTINY_TICK_SECONDS) {
  return integrateCarbonMotion(position, velocity, acceleration, mass, DESTINY_FRICTION, t);
}

// Ballpark::GotoThrust: full thrust toward the point, tapered inside the
// homing zone speedFraction * maxVel * dt unless a missile past launch.
function gotoThrust(ball, point, missile = false, dt = DESTINY_TICK_SECONDS) {
  const toward = sub(point, ball.position);
  const l2 = dot(toward, toward);
  if (!(l2 > 0)) {
    return vec(0, 0, 0);
  }
  const zone = cruiseSpeed(ball) * dt;
  const maxThrust = (DESTINY_FRICTION * cruiseSpeed(ball)) / inertialMass(ball);
  const direction = scale(toward, 1 / Math.sqrt(l2));
  if (!missile && l2 < zone * zone) {
    const c = l2 / (zone * zone);
    return scale(direction, maxThrust * c * c);
  }
  return scale(direction, maxThrust);
}

// Ballpark::EvolveFollow's goto point: the target's position plus the
// standoff (follow range plus both radii) along the line back to the Ball.
function standoffPoint(ball, targetPosition, target, range) {
  const delta = sub(ball.position, targetPosition);
  const d = length(delta);
  const r = finite(range, 0) + finite(ball.radius, 0) + finite(target.radius, 0);
  if (!(d > 0)) {
    return add(targetPosition, vec(r, 0, 0));
  }
  return add(targetPosition, scale(delta, r / d));
}

// The orbital axis, precessing once per tick, seeded by the Ball id's low
// 16 bits (DefaultOrbitalNormal), each component truncated to 7 digits.
function orbitalAxis(ball, currentTime) {
  let low = 0;
  try {
    low = Number(BigInt(String(ball.itemID).replace(/n$/, "")) & 0xffffn);
  } catch {
    low = Math.trunc(finite(ball.itemID, 0)) & 0xffff;
  }
  const phi1 = currentTime * ORBITAL_PRECESSION;
  const phi2 = low + (currentTime * ORBITAL_PRECESSION);
  return vec(
    truncate7(Math.cos(phi1) * Math.cos(phi2)),
    truncate7(Math.sin(phi2)),
    truncate7(Math.sin(phi1) * Math.cos(phi2)),
  );
}

// Ballpark::EvolveOrbit, old style (the engine's default, Server's
// orbit as it was).
function orbitAcceleration(ball, target, currentTime) {
  const maxThrust = (DESTINY_FRICTION * cruiseSpeed(ball)) / inertialMass(ball);
  const r = finite(ball.orbitDistance, finite(ball.followRange, 0)) +
    finite(ball.radius, 0) + finite(target.radius, 0);
  const rawTo = sub(target.position, ball.position);
  const dist = length(rawTo);
  let toVector = dist > 0 ? scale(rawTo, 1 / dist) : vec(0, 0, 1);
  const radial = unit(cross(orbitalAxis(ball, currentTime), toVector));
  const toComp = (dist * dist) - (r * r);
  if (toComp >= 0 && dist > 0) {
    const radComp = (r * Math.sqrt(toComp)) / dist;
    toVector = unit(add(scale(toVector, toComp / dist), scale(radial, radComp)));
  }
  const radialFactor = truncate7(Math.exp(-((r - dist) * (r - dist)) / 40_000));
  const cosA = -dot(toVector, radial);
  const discriminant = 1 + (radialFactor * radialFactor * ((cosA * cosA) - 1));
  let transverse = discriminant > 0
    ? (radialFactor * cosA) + Math.sqrt(discriminant)
    : radialFactor * cosA;
  transverse *= (dist - r) >= 0 ? 1 : -1;
  return scale(add(scale(radial, radialFactor), scale(toVector, transverse)), maxThrust);
}

// Ball::IsAlignedForWarp, read from the current slot (the previous Evolve's
// state): heading within |1 - cos| < 0.01 and faster than 75 % of max speed,
// or aligning for more than MAX_ALIGN_TICKS.
function isAlignedForWarp(ball) {
  if (!isAligningForWarp(ball)) {
    return false;
  }
  const speed2 = dot(ball.velocity, ball.velocity);
  const maxVelocity = finite(ball.maxVelocity, 0);
  if (speed2 > 0.5625 * maxVelocity * maxVelocity) {
    const cosine = dot(unit(ball.velocity), unit(sub(ball.targetPoint, ball.position)));
    if (Math.abs(1 - cosine) < 0.01) {
      return true;
    }
  }
  return Math.abs(finite(ball.effectStamp, -1)) > MAX_ALIGN_TICKS;
}

// Ballpark::RealWarp: the goto point moves back toward the Ball by the
// minimum range, the warp starts at this tick, its length is kept.
function realWarp(ball, currentTime) {
  const minRange = Math.max(0, finite(ball.warpMinRange, 0));
  const back = unit(sub(ball.position, ball.targetPoint));
  ball.targetPoint = add(ball.targetPoint, scale(back, minRange));
  ball.effectStamp = currentTime;
  ball.warpDistance = length(sub(ball.targetPoint, ball.position));
}

// ---------------------------------------------------------------------------
// Warp

// Ballpark::SetupWarpConstants for warp factor w (mAU/s) over D metres.
function setupWarpConstants(warpFactor, warpDistance) {
  const w = Math.max(1, finite(warpFactor, 1));
  const D = Math.max(0, finite(warpDistance, 0));
  const topSpeed = w * WARP_FACTOR_TO_AU_PER_SECOND * ONE_AU_IN_METERS;
  const acceleration = w * WARP_FACTOR_TO_ACCELERATION;
  const deceleration = Math.min(w * WARP_FACTOR_TO_DECELERATION, WARP_MAX_DECELERATION);
  const speed = Math.min(
    topSpeed,
    ((D + 1) * acceleration * deceleration) / (acceleration + deceleration),
  );
  const accelTime = Math.log(speed / acceleration) / acceleration;
  const cruiseTime = (D / speed) - (1 / acceleration) - (1 / deceleration) + (1 / speed);
  const decelTime = Math.log(speed / deceleration) / deceleration;
  return {
    speed,
    acceleration,
    deceleration,
    accelTime,
    cruiseTime,
    decelTime,
    accelDistance: speed / acceleration,
    cruiseDistance: speed * cruiseTime,
    decelDistance: (speed / deceleration) - 1,
  };
}

// Ballpark::WarpDistance: the Ball's position and velocity t seconds into the
// warp, closed-form, measured back from the goto point along the line to it.
function warpDistance(ball, position, velocity, t) {
  const constants = setupWarpConstants(ball.warpFactor, ball.warpDistance);
  const {
    speed: S,
    acceleration: A,
    deceleration: Dc,
    accelTime,
    cruiseTime,
    decelTime,
    accelDistance,
    cruiseDistance,
    decelDistance,
  } = constants;
  const goto = copy(ball.targetPoint);
  const direction = unit(sub(goto, position), ball.direction || vec(1, 0, 0));
  const total = accelDistance + cruiseDistance + decelDistance;
  let speed;
  let x;
  let dropped = false;
  if (t < accelTime) {
    speed = Math.max(A * Math.exp(A * t), length(velocity));
    x = Math.exp(A * t);
  } else if ((t - accelTime) < cruiseTime) {
    speed = S;
    x = (S * (t - accelTime)) + accelDistance;
  } else if ((t - cruiseTime - accelTime) < decelTime + 1) {
    const decay = Math.exp(-Dc * (t - cruiseTime - accelTime));
    speed = S * decay;
    x = (S / Dc) - ((S / Dc) * decay) + accelDistance + cruiseDistance;
    dropped = speed < Math.min(finite(ball.maxVelocity, 0) / 2, WARP_DROPOUT_SPEED_MAX);
  } else {
    // "Ship stuck in extended warp": at the exit point, stopped.
    return { position: goto, velocity: vec(0, 0, 0), dropped: true, overrun: true };
  }
  return {
    position: sub(goto, scale(direction, total - x)),
    velocity: scale(direction, speed),
    dropped,
    overrun: false,
  };
}

function vectorsEqual(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

// Ballpark::WarpTo, as DoPreTick applies it. Returns what happened:
// { ignored } for NaN, { exitWarp } for a GotoPoint under 100 km (the caller
// posts OnExitWarp), { noop } for the same destination while already in warp
// mode (the align count is not restarted), { warp } otherwise.
function warpTo(ball, destination, options = {}) {
  if (!isFiniteVector(destination)) {
    return { ignored: true };
  }
  const dst = copy(destination);
  const minRange = Math.max(0, finite(options.minRange, 0));
  let warpFactor = finite(options.warpFactor, 0);
  if (warpFactor <= 0) {
    warpFactor = 1;
  }
  const delta = sub(ball.position, dst);
  if (dot(delta, delta) < WARP_TO_GOTO_DISTANCE_SQUARED) {
    ball.mode = "GOTO";
    ball.targetEntityID = null;
    ball.targetPoint = dst;
    return { exitWarp: true };
  }
  if (isWarpish(ball) && vectorsEqual(ball.targetPoint, dst)) {
    return { noop: true };
  }
  stopBall(ball);
  ball.targetPoint = dst;
  ball.effectStamp = -1;
  ball.followRange = 0;
  ball.warpMinRange = minRange;
  ball.warpFactor = warpFactor;
  ball.warpDistance = 0;
  ball.mode = "WARP";
  return { warp: true };
}

// Ballpark::EntityWarpIn: a warp with no align, its curve faked to have
// started five ticks ago, at 1 AU/s. As retail, the velocity points along the
// destination vector itself.
function entityWarpIn(ball, destination, options = {}) {
  const result = warpTo(ball, destination, { minRange: 0, warpFactor: options.warpFactor });
  if (!isWarpish(ball)) {
    return result;
  }
  const currentTime = Math.trunc(finite(options.currentTime, 0));
  realWarp(ball, currentTime);
  ball.velocity = scale(unit(copy(destination)), ONE_AU_IN_METERS);
  ball.effectStamp = Math.max(currentTime - 5, 0);
  ball.warpDistance = length(sub(ball.position, ball.targetPoint));
  return { warp: true, warpIn: true };
}

// ---------------------------------------------------------------------------
// Heading (Server's own)

function agilitySeconds(ball) {
  return Math.max(inertialMass(ball) / DESTINY_FRICTION, 0.05);
}

function slerp(current, target, fraction, radians) {
  if (fraction <= 0) {
    return current;
  }
  if (fraction >= 1) {
    return target;
  }
  const sinTotal = Math.sin(radians);
  if (!Number.isFinite(sinTotal) || Math.abs(sinTotal) < 0.000001) {
    return unit(add(scale(current, 1 - fraction), scale(target, fraction)), target);
  }
  return unit(add(
    scale(current, Math.sin((1 - fraction) * radians) / sinTotal),
    scale(target, Math.sin(fraction * radians) / sinTotal),
  ), target);
}

// Turns the heading toward `desired` by Server's per-tick turn rate; a Ball
// near rest snaps to it.
function turnHeading(ball, desired) {
  const current = unit(copy(ball.direction), desired);
  const target = unit(desired, current);
  const radians = Math.acos(Math.max(-1, Math.min(1, dot(current, target))));
  const maxVelocity = finite(ball.maxVelocity, 0);
  const speedFraction = maxVelocity > 0 ? length(ball.velocity) / maxVelocity : 0;
  if (!Number.isFinite(radians) || radians <= TURN_ALIGNMENT_RADIANS || speedFraction <= 0.1) {
    return target;
  }
  const degreesPerSecond = Math.max(0.75, Math.min(12, 75 / agilitySeconds(ball))) * 10;
  const degrees = (radians * 180) / Math.PI;
  const fraction = Math.max(0.001, Math.min(1, degreesPerSecond / Math.max(degrees, 0.001)));
  return slerp(current, target, fraction, radians);
}

// ---------------------------------------------------------------------------
// Removal

function moribundList(park) {
  if (!Array.isArray(park.moribundBalls)) {
    park.moribundBalls = [];
  }
  return park.moribundBalls;
}

// Ballpark::RemoveBall (Ballpark.cpp L5475-L5543 at v2.1.1). Inside Evolve
// it only marks the Ball moribund, stamped currentTime + delay (ticks); the
// sweep removes it once that stamp has passed. Like retail's RemoveBall, it
// stops the Ball and makes it non-massive at the mark, whatever the delay:
// a Ball with a delay stays in its Grid bubble for it, and moves, collides
// and is aimed at nothing.
// Outside Evolve, `options.remove` removes it at once and a delay is set
// back to 0 (only a missile's hit, inside Evolve, asks for one). Returns
// "moribund" or "removed".
function removeBall(park, ball, options = {}) {
  const delay = Math.max(0, Math.trunc(finite(options.delay, 0)));
  if (park.inEvolve === true) {
    if (!isMoribund(ball)) {
      ball.isMoribund = true;
      stopBall(ball);
      ball.isMassive = false;
      moribundList(park).push({
        ball,
        options,
        effectStamp: Math.trunc(finite(park.currentTime, 0)) + delay,
      });
    }
    return "moribund";
  }
  if (typeof options.remove === "function") {
    options.remove(ball, options);
  }
  return "removed";
}

// Ballpark::BringOutDeadBalls (L5712-L5769 at v2.1.1): removes, through
// `remove(ball, options)`, every moribund Ball whose stamp is before
// `currentTime`, the number of the tick about to run (retail's
// mEffectStamp - mCurrentTime < 0): a Ball marked in Evolve N with no delay
// goes at N + 1, one with a delay of d at N + 1 + d. Retail also erases up
// to 7 Balls per sweep as much as 2 ticks early (mMoribundBallRemovalBuffer,
// L111-L112), which would cancel a delay of 1 or 2; Server takes no such
// buffer (a missile hit's delay is fixed). With no
// `currentTime` every moribund Ball goes. Never inside Evolve. Returns how
// many.
function bringOutTheDeads(park, remove, currentTime) {
  if (park.inEvolve === true) {
    return 0;
  }
  const list = moribundList(park);
  const now = currentTime === undefined || currentTime === null
    ? Infinity
    : finite(currentTime, Infinity);
  const due = [];
  const kept = [];
  for (const entry of list) {
    if (finite(entry.effectStamp, -Infinity) < now) {
      due.push(entry);
    } else {
      kept.push(entry);
    }
  }
  list.length = 0;
  list.push(...kept);
  for (const entry of due) {
    remove(entry.ball, entry.options);
  }
  return due.length;
}

// ---------------------------------------------------------------------------
// Refusals and follower clean-up

// What the engine refuses: a Follow or Orbit whose target is missing,
// moribund, cloaked or in another Grid bubble, or with a NaN argument.
// Returns the reason or null.
function refuseFollowOrOrbit(ball, target, range, options = {}) {
  if (!Number.isFinite(Number(range))) {
    return "nan-argument";
  }
  if (!target) {
    return "target-missing";
  }
  const moribund = typeof options.isMoribund === "function" ? options.isMoribund : isMoribund;
  if (moribund(target)) {
    return "target-moribund";
  }
  const cloaked = typeof options.isCloaked === "function" ? options.isCloaked : isCloaked;
  if (cloaked(target)) {
    return "target-cloaked";
  }
  const gridBubbleOf = typeof options.gridBubbleOf === "function"
    ? options.gridBubbleOf
    : null;
  if (gridBubbleOf) {
    const mine = gridBubbleOf(ball);
    const theirs = gridBubbleOf(target);
    if (mine !== null && mine !== undefined && theirs !== null && theirs !== undefined && mine !== theirs) {
      return "target-other-bubble";
    }
  }
  return null;
}

// clean_up_followers, at the start of doPreTick: every Ball following
// or orbiting a Ball in another Grid bubble gets a Stop. Returns how many.
function cleanUpFollowers(balls, options = {}) {
  let stopped = 0;
  for (const ball of balls) {
    const mode = modeOf(ball);
    if ((mode !== "FOLLOW" && mode !== "ORBIT") || isMoribund(ball)) {
      continue;
    }
    const target = options.getBall(ball.targetEntityID);
    if (!target) {
      continue;
    }
    const mine = options.gridBubbleOf(ball);
    const theirs = options.gridBubbleOf(target);
    if (mine !== null && mine !== undefined && theirs !== null && theirs !== undefined && mine !== theirs) {
      options.stop(ball);
      stopped += 1;
    }
  }
  return stopped;
}

// ---------------------------------------------------------------------------
// The interim missile hit, until Evolve handles collisions: retail's
// CollideTwoSpheres over the missile's and the target's two committed slots
// (their tick chords), with
// Potential's collision radius, the missile's radius plus the target's
// (Ballpark.cpp L2792-L2821, Collision.cpp L106-L133 at v2.1.1). Retail's
// lead aims from the tick-start velocity, so a target that turns inside the
// tick is passed at up to a few hundred metres; the summed radius is what
// connects.
//
// Exported for the scene's hooks: Ball A's
// chord fromA → toA against Ball B's fromB → toB over one tick, hitting when
// they pass within `radius`. Returns { hit, impactTimeSeconds, reason }.

function sweptImpact(fromA, toA, fromB, toB, radius, seconds = DESTINY_TICK_SECONDS) {
  const collisionRadius = Math.max(1, finite(radius, 0));
  const relativeStart = sub(fromA, fromB);
  const relativeVelocity = scale(
    sub(sub(toA, fromA), sub(toB, fromB)),
    1 / seconds,
  );
  const a = dot(relativeVelocity, relativeVelocity);
  const b = 2 * dot(relativeStart, relativeVelocity);
  const c = dot(relativeStart, relativeStart) - (collisionRadius * collisionRadius);
  if (c <= 0) {
    return { hit: true, impactTimeSeconds: 0, reason: "already-inside-radius" };
  }
  if (a <= 1e-9) {
    return { hit: false };
  }
  const discriminant = (b * b) - (4 * a * c);
  if (discriminant < 0) {
    return { hit: false };
  }
  const root = Math.sqrt(discriminant);
  const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)]
    .filter((time) => time >= -1e-6 && time <= seconds + 1e-6);
  if (candidates.length === 0) {
    return { hit: false };
  }
  return {
    hit: true,
    impactTimeSeconds: Math.max(0, Math.min(seconds, Math.min(...candidates))),
    reason: "relative-sweep",
  };
}

// ---------------------------------------------------------------------------
// Evolve

function hook(park, name) {
  return typeof park[name] === "function" ? park[name] : null;
}

// Evolve's hooks run gameplay (a hit's damage and destruction, a warp's
// landing and start, its followers' change), so each call is contained per Ball, as the queue
// contains each action: a throw is logged at error with its Ball and
// tick, and Evolve goes on for every other Ball. A park with no logger still
// gets the line on stderr; nothing is swallowed silently.
function runPassThreeHook(park, name, ball, call) {
  try {
    call();
    return true;
  } catch (error) {
    const id = ball && ball.itemID !== undefined ? ball.itemID : "?";
    const line =
      `[Evolve] tick ${Math.trunc(finite(park.currentTime, 0))}: ${name} failed for ball=${id}: ` +
      `${error && error.stack ? error.stack : error}`;
    if (park.log && typeof park.log.error === "function") {
      park.log.error(line);
    } else {
      process.stderr.write(`${line}\n`);
    }
    return false;
  }
}

// Whether a Ball takes part in collision: free, not cloaked, not warping,
// and not moribund: a Ball removed earlier in this Evolve (a
// target a hit destroyed) takes part in nothing more in it.
function isMassiveBall(park, ball) {
  if (isMoribund(ball)) {
    return false;
  }
  const custom = hook(park, "isMassive");
  if (custom) {
    return custom(ball) === true;
  }
  return ball.isMassive !== false && !isCloaked(ball) && !isWarping(ball);
}

function getTarget(park, ball) {
  const target = park.getBall(ball.targetEntityID);
  return target && !isMoribund(target) && isFiniteVector(target.position)
    ? target
    : null;
}

// A removal Evolve decides (an expired missile, one whose target has gone),
// through the scene's removeBall hook inside the guard; the Ball goes
// moribund whether the hook removed it, left it alive, or threw.
function requestRemoval(park, ball, reason) {
  const remove = hook(park, "removeBall");
  if (remove) {
    runPassThreeHook(park, "removeBall", ball, () => remove(ball, { reason }));
  }
  if (!isMoribund(ball)) {
    removeBall(park, ball, { reason });
  }
}

// Pass 1 for one Ball: its acceleration, from the current slots. A Ball it
// removes (a missile whose target has gone) goes on `removals`, applied
// after the pass, so the visit order changes nothing.
function behaviour(park, ball, currentTime, activations, removals) {
  switch (modeOf(ball)) {
    case "GOTO":
      return gotoThrust(ball, copy(ball.targetPoint || ball.position));
    case "FOLLOW": {
      const target = getTarget(park, ball);
      if (!target) {
        stopBall(ball);
        return vec(0, 0, 0);
      }
      ball.targetPoint = standoffPoint(ball, target.position, target, ball.followRange);
      return gotoThrust(ball, ball.targetPoint);
    }
    case "ORBIT": {
      const target = getTarget(park, ball);
      if (!target) {
        stopBall(ball);
        return vec(0, 0, 0);
      }
      const acceleration = orbitAcceleration(ball, target, currentTime);
      ball.targetPoint = add(ball.position, scale(acceleration, ORBIT_GOTO_SCALE));
      return acceleration;
    }
    case "MISSILE": {
      const target = getTarget(park, ball);
      if (!target) {
        removals.push([ball, "target-missing"]);
        return null;
      }
      const elapsedMs = (currentTime - finite(ball.effectStamp, currentTime)) * DESTINY_TICK_MS;
      if (elapsedMs <= MISSILE_LAUNCH_THRUST_MS) {
        return gotoThrust(ball, copy(ball.targetPoint || target.position));
      }
      const delta = sub(ball.position, target.position);
      const d = length(delta);
      const maxVelocity = finite(ball.maxVelocity, 0);
      const lead = maxVelocity > 0 ? d / maxVelocity : 0;
      const led = add(target.position, scale(copy(target.velocity), lead));
      const r = finite(ball.followRange, 0) + finite(ball.radius, 0) + finite(target.radius, 0);
      ball.targetPoint = d > 0
        ? add(led, scale(delta, r / d))
        : add(target.position, vec(r, 0, 0));
      return gotoThrust(ball, ball.targetPoint, true);
    }
    case "WARP": {
      if (isWarping(ball)) {
        return vec(0, 0, 0);
      }
      if (isAlignedForWarp(ball)) {
        realWarp(ball, currentTime);
        activations.push(ball);
        return vec(0, 0, 0);
      }
      ball.effectStamp = finite(ball.effectStamp, -1) - 1;
      return gotoThrust(ball, copy(ball.targetPoint));
    }
    default:
      return vec(0, 0, 0);
  }
}

function headingFor(ball, acceleration, nextVelocity) {
  const mode = modeOf(ball);
  if (mode === "MISSILE") {
    return unit(nextVelocity, ball.direction || vec(1, 0, 0));
  }
  if (isWarpish(ball)) {
    return turnHeading(ball, unit(sub(ball.targetPoint, ball.position), ball.direction));
  }
  if (length(acceleration) > 0) {
    return turnHeading(ball, unit(acceleration));
  }
  return unit(copy(ball.direction), vec(1, 0, 0));
}

function evolve(park) {
  const dt = DESTINY_TICK_SECONDS;
  const currentTime = Math.trunc(finite(park.currentTime, 0));
  const balls = Array.from(park.balls || []);
  const isInDeadBubble = hook(park, "isInDeadBubble");
  const collide = hook(park, "collide");
  const accelerations = new Map();
  const tickStart = new Map();
  // Whether each Ball's acceleration was worked in STOP: EvolveStop's y
  // damping runs at the Ball's own pass-1 visit, so a follower stopped after
  // it (RealWarp's StopAllFollowers) is not damped in that tick.
  const stoppedAtVisit = new Map();
  const activations = [];
  const drops = [];
  park.inEvolve = true;
  try {
    for (const ball of balls) {
      if (!hasSlots(ball)) {
        seedBallSlots(ball, dt);
      }
    }

    // Pass 1: behaviour, from the current slots. Its removals (an expired
    // missile, one whose target has gone) are made after the pass, so every
    // Ball visited in it sees the same park whatever the order.
    const live = [];
    const removals = [];
    for (const ball of balls) {
      if (isMoribund(ball)) {
        continue;
      }
      if (!isWarping(ball) && isInDeadBubble && isInDeadBubble(ball) === true) {
        continue;
      }
      tickStart.set(ball, { position: copy(ball.position), velocity: copy(ball.velocity) });
      // A missile's flight time: it flies no Evolve whose end
      // passes it, whatever its mode (a missile whose target cloaked flies
      // on in GOTO). Pass 3 of the Evolve before has normally removed it;
      // this catches one that reaches such an Evolve some other way.
      if (
        ball.kind === "missile" &&
        finite(ball.expiresAtMs, 0) > 0 &&
        finite(park.endSimTimeMs, 0) > finite(ball.expiresAtMs, 0)
      ) {
        removals.push([ball, "expired"]);
        continue;
      }
      const acceleration = behaviour(park, ball, currentTime, activations, removals);
      if (acceleration === null || isMoribund(ball)) {
        continue;
      }
      accelerations.set(ball, acceleration);
      stoppedAtVisit.set(ball, modeOf(ball) === "STOP");
      live.push(ball);
    }
    for (const [ball, reason] of removals) {
      requestRemoval(park, ball, reason);
    }

    // RealWarp's StopAllFollowers, which retail runs at the warping Ball's
    // pass-1 visit (EvolveWarp, Ballpark.cpp L936, L4148), where every Ball's
    // mNewPos and mNewVel are its tick-start values: a redirected follower
    // flies on along its tick-start velocity. Retail visits in ascending ID
    // order, on the server and on every client, so the activation tick
    // depends on the IDs: a follower with a
    // smaller ID than the warper was visited first and integrates the
    // old-mode acceleration it stored (mLastG); one with a greater ID is
    // visited after the call and flies its new mode (STOP, or GOTO along its
    // velocity) in this tick already. Server makes the call here, after pass
    // 1, and re-works the acceleration of each follower retail visits after the
    // warper, so its result still does not depend on its own visit order.
    // Several activations go in ascending ID order, as retail's.
    const stopFollowers = hook(park, "stopFollowers");
    if (stopFollowers) {
      const warpers = [...activations].sort((a, b) => (
        visitedAfter(a.itemID, b.itemID) ? 1 : visitedAfter(b.itemID, a.itemID) ? -1 : 0
      ));
      for (const warper of warpers) {
        const followers = live.filter((ball) => isFollowerOf(ball, warper.itemID));
        runPassThreeHook(park, "stopFollowers", warper, () => stopFollowers(warper, { tickStart }));
        for (const follower of followers) {
          if (
            isMoribund(follower) ||
            isFollowerOf(follower, warper.itemID) ||
            !visitedAfter(follower.itemID, warper.itemID)
          ) {
            continue;
          }
          const acceleration = behaviour(park, follower, currentTime, [], []);
          if (acceleration !== null) {
            accelerations.set(follower, acceleration);
            stoppedAtVisit.set(follower, modeOf(follower) === "STOP");
          }
        }
      }
    }

    // The collision seam, at retail's Gradient site: per massive Ball, from
    // tick-start slots and pass 1's accelerations. Until collision handling
    // lands it is the placeholder, which changes nothing.
    for (const ball of live) {
      if (isMoribund(ball) || !isMassiveBall(park, ball)) {
        continue;
      }
      if (collide) {
        const answer = collide(ball, {
          acceleration: accelerations.get(ball),
          position: tickStart.get(ball).position,
          velocity: tickStart.get(ball).velocity,
          accelerations,
          tickStart,
        });
        if (answer && isFiniteVector(answer.acceleration)) {
          accelerations.set(ball, copy(answer.acceleration));
        }
        if (answer && Array.isArray(answer.contacts)) {
          ball.lastContacts = answer.contacts;
        }
      }
    }

    // Pass 2: integrate exactly 1 s into the scratch slot.
    for (const ball of live) {
      if (isMoribund(ball)) {
        continue;
      }
      const acceleration = accelerations.get(ball);
      let p = copy(ball.position);
      let v = copy(ball.velocity);
      if (isWarping(ball)) {
        const t = (currentTime - finite(ball.effectStamp, currentTime)) * dt;
        const warp = warpDistance(ball, p, v, t);
        p = warp.position;
        v = warp.velocity;
        ball.oldDirection = unit(sub(ball.targetPoint, ball.position), ball.direction);
        if (warp.dropped) {
          // The drop: stopped, and one ordinary step from the drop point, so
          // the swap leaves the drop point as the old slot. Retail's warp
          // exit is a Stop, which keeps the warp's fraction of 1.0, as the
          // client's own Evolve does.
          stopBall(ball);
          ball.position = copy(p);
          ball.velocity = copy(v);
          const step = integrate(p, v, vec(0, 0, 0), inertialMass(ball), dt);
          p = step.position;
          v = step.velocity;
          drops.push({ ball, overrun: warp.overrun });
        }
      } else {
        if (stoppedAtVisit.get(ball) === true) {
          v = vec(v.x, v.y * STOP_Y_DAMPING, v.z);
        }
        const step = integrate(p, v, acceleration, inertialMass(ball), dt);
        p = step.position;
        v = step.velocity;
        ball.oldDirection = headingFor(ball, acceleration, v);
      }
      ball.oldPosition = p;
      ball.oldVelocity = v;
    }

    // Pass 3: swap, re-box what moved, then each moved missile's hit.
    const rebox = hook(park, "rebox");
    const movedMissiles = [];
    for (const ball of live) {
      if (isMoribund(ball)) {
        continue;
      }
      const position = ball.position;
      const velocity = ball.velocity;
      const direction = ball.direction;
      ball.position = ball.oldPosition;
      ball.velocity = ball.oldVelocity;
      ball.direction = ball.oldDirection || direction;
      ball.oldPosition = position;
      ball.oldVelocity = velocity;
      ball.oldDirection = direction;
      const moved = sub(ball.position, ball.oldPosition);
      if (dot(moved, moved) < REBOX_MIN_MOVE_SQUARED) {
        continue;
      }
      if (rebox) {
        runPassThreeHook(park, "rebox", ball, () => rebox(ball));
      }
      if (modeOf(ball) === "MISSILE") {
        movedMissiles.push(ball);
      }
    }
    const onMissileHit = hook(park, "onMissileHit");
    const swapped = new Set(live);
    for (const missileBall of movedMissiles) {
      if (isMoribund(missileBall)) {
        continue;
      }
      const target = getTarget(park, missileBall);
      if (!target || !isMassiveBall(park, target)) {
        continue;
      }
      const targetStart = swapped.has(target) && !isMoribund(target)
        ? target.oldPosition
        : target.position;
      const sweep = sweptImpact(
        missileBall.oldPosition,
        missileBall.position,
        targetStart,
        target.position,
        finite(missileBall.radius, 0) + finite(target.radius, 0),
        dt,
      );
      if (!sweep.hit) {
        continue;
      }
      if (onMissileHit) {
        runPassThreeHook(park, "onMissileHit", missileBall, () => onMissileHit(missileBall, target, sweep));
      }
      // A missile whose hit threw goes too, or it would hit (and throw)
      // again every tick.
      if (!isMoribund(missileBall)) {
        removeBall(park, missileBall, { reason: "hit" });
      }
    }
    // Proximity fuses, once this tick's hits are in: every live Ball with a
    // fuse range is handed its tick chord, and the hook decides what the
    // fuse meets and removes the Ball itself. A Ball a hit made moribund
    // above is skipped; one whose hook threw goes, or it would fuse (and
    // throw) again every tick.
    const onProximityFuse = hook(park, "onProximityFuse");
    if (onProximityFuse) {
      for (const ball of live) {
        if (isMoribund(ball) || !(finite(ball.proximityFuseRange, 0) > 0)) {
          continue;
        }
        const sweep = { from: copy(ball.oldPosition), to: copy(ball.position) };
        const ok = runPassThreeHook(park, "onProximityFuse", ball, () => onProximityFuse(ball, sweep));
        if (!ok && !isMoribund(ball)) {
          removeBall(park, ball, { reason: "proximity-fuse" });
        }
      }
    }
    // A missile's flight time, once this tick's hits are in: one
    // whose next Evolve would end past it is removed now, so its removal is
    // stamped with that tick and reaches every client before the client's
    // own Evolve of it, which has no flight time and would collide a missile
    // Server never hits. It flies the same
    // Evolves as before; pass 1 still removes one that reaches such an
    // Evolve some other way.
    const nextEndSimTimeMs = finite(park.endSimTimeMs, 0) + DESTINY_TICK_MS;
    for (const ball of live) {
      if (
        ball.kind === "missile" &&
        !isMoribund(ball) &&
        finite(ball.expiresAtMs, 0) > 0 &&
        nextEndSimTimeMs > finite(ball.expiresAtMs, 0)
      ) {
        requestRemoval(park, ball, "expired");
      }
    }
    for (const { ball, overrun } of drops) {
      if (dot(ball.velocity, ball.velocity) < REBOX_MIN_MOVE_SQUARED && rebox) {
        runPassThreeHook(park, "rebox", ball, () => rebox(ball));
      }
      const onWarpDropped = hook(park, "onWarpDropped");
      if (onWarpDropped) {
        runPassThreeHook(park, "onWarpDropped", ball, () => onWarpDropped(ball, { overrun }));
      }
    }
    // The activation callbacks, once every Ball has moved (the followers
    // were dealt with after pass 1).
    for (const ball of activations) {
      const onWarpActivated = hook(park, "onWarpActivated");
      if (onWarpActivated) {
        runPassThreeHook(park, "onWarpActivated", ball, () => onWarpActivated(ball));
      }
    }
  } finally {
    park.inEvolve = false;
  }
  return {
    evolved: accelerations.size,
    activations: activations.length,
    drops: drops.length,
  };
}

module.exports = {
  bringOutTheDeads,
  cleanUpFollowers,
  entityWarpIn,
  evolve,
  gotoDirection,
  isAlignedForWarp,
  isAligningForWarp,
  isFollowerOf,
  isWarping,
  isWarpish,
  refuseFollowOrOrbit,
  removeBall,
  seedBallSlots,
  setBallPosition,
  setBallVelocity,
  setupWarpConstants,
  stopAllFollowers,
  stopBall,
  stopFollower,
  sweptImpact,
  warpDistance,
  warpTo,
};
