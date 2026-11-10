"use strict";

// InterdictionVolumes: one per solar system, owned by its scene, the
// list of its warp disruption spheres and the tests a warp asks of them.
//
// A sphere joins the list when it comes up and leaves it when it goes:
//   - a dictor's Warp Disrupt Probe: its Ball joins the scene (launched, or
//     made again from its stored item when the scene loads) and leaves it
//     (expired, destroyed);
//   - a heavy interdictor's Warp Disruption Field Generator in sphere mode:
//     switched on (the ship joins as the sphere's source) and off (the field
//     effect gone; the volume is dropped at the next look, or when the ship
//     leaves the scene);
//   - a mobile warp disruptor: its Ball joins the scene (launched, or made
//     again from its stored item) with its stored state, which follows the
//     anchoring (setVolumeState) until it is cleared, expires or is
//     destroyed.
// Nothing here scans or copies space items: every look costs one pass over
// this system's spheres.
//
// Each sphere keeps its own clock: a field is read on the game clock
// (`nowMs`, the scene's sim time), a probe's lifetime and a mobile warp
// disruptor's anchoring and decay on the wall clock (`wallclockNowMs`).
// A look `for` an entity skips spheres outside its interaction scope, and an
// entity immune to spheres (warpBubbleImmune) is in none and crosses none.

const path = require("path");

const {
  canEntitiesInteractLocally,
} = require(path.join(__dirname, "../../space/destiny/identity/interactionScope.js"));
const interdictionProbeRuntime = require(path.join(__dirname, "./interdictionProbeRuntime"));
const warpDisruptFieldGeneratorRuntime = require(path.join(
  __dirname,
  "./warpDisruptFieldGeneratorRuntime",
));

// The mobile warp disruptor's own rules (its state, its type, immunity) live
// in its runtime, which requires this file's callers: required when first
// used.
function mobileRuntime() {
  return require(path.join(__dirname, "./mobileWarpDisruptorRuntime"));
}

const KIND = Object.freeze({
  PROBE: "interdictionProbe",
  FIELD: "warpDisruptFieldGenerator",
  MOBILE: "mobileWarpDisruptor",
  FIXED: "fixed",
});

// Warp outcome: a sphere
// stops a warp when its path meets it within this distance before the
// landing point, and drags it when the path extended this far past the
// landing point meets it.
const SPHERE_REACH_METERS = 500_000;

// A warp path this short or shorter is degenerate: it meets no sphere.
const DEGENERATE_PATH_METERS = 1;

// Two crossings this close along the path are a tie, settled by the lower
// disruptorID.
const TIE_TOLERANCE_METERS = 1e-6;

// A stop or drag's landing point is nudged along the line to hold it inside
// the surface: the nudge search looks at most this far past the entry,
// and never past the closest approach, and returns a passing step within that
// limit, not necessarily the smallest. Only the chord walk
// (firstAcceptedChordDistance) lands further in.
const LANDING_NUDGE_LIMIT_METERS = 1;

// The chord walk stops after testing this many distinct points. With none
// passing by then, the unnudged entry
// point stands, as when no point on the stretch passes.
const CHORD_WALK_BUDGET = 65_536;

// A double's bit pattern, read as an unsigned integer: for non-negative
// doubles its order is their numeric order, and consecutive integers are
// neighbouring doubles. The chord walk counts distances this way.
const distanceFloat = new Float64Array(1);
const distanceBits = new BigUint64Array(distanceFloat.buffer);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toReal(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readPosition(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  for (const candidate of [source.spaceState && source.spaceState.position, source.position, source]) {
    if (
      candidate &&
      Number.isFinite(Number(candidate.x)) &&
      Number.isFinite(Number(candidate.y)) &&
      Number.isFinite(Number(candidate.z))
    ) {
      return { x: Number(candidate.x), y: Number(candidate.y), z: Number(candidate.z) };
    }
  }
  return null;
}

function isVector(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.itemID === undefined &&
    Number.isFinite(Number(value.x)) &&
    Number.isFinite(Number(value.y)) &&
    Number.isFinite(Number(value.z)),
  );
}

function hasWarpDisruptFieldEffect(entity) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return false;
  }
  for (const effectState of entity.activeModuleEffects.values()) {
    if (toInt(effectState && effectState.groupID, 0) === warpDisruptFieldGeneratorRuntime.GROUP_WARP_DISRUPT_FIELD_GENERATOR) {
      return true;
    }
  }
  return false;
}

// How far along the line from `from` (unit direction u) its forward ray first
// meets `sphere`'s edge, or null: when `from` is inside the sphere (its
// surface counts), when the line misses it, or when the sphere lies behind.
//
// With C the sphere's centre and r its radius, the half-chord comes from C's
// perpendicular offset from the line, not from
// along² − (|C − from|² − r²): on a long warp those two
// terms are both near along² and cancel, leaving the entry up to kilometres
// short.
function lineEntryDistance(from, ux, uy, uz, sphere) {
  const cx = sphere.position.x - from.x;
  const cy = sphere.position.y - from.y;
  const cz = sphere.position.z - from.z;
  const radius = sphere.rangeMeters;
  if (((cx * cx) + (cy * cy) + (cz * cz)) <= (radius * radius)) {
    return null;
  }
  const along = (cx * ux) + (cy * uy) + (cz * uz);
  // The component of C − from across u.
  const px = cx - (along * ux);
  const py = cy - (along * uy);
  const pz = cz - (along * uz);
  const halfChordSquared = (radius * radius) - ((px * px) + (py * py) + (pz * pz));
  if (halfChordSquared < 0) {
    return null;
  }
  // From outside, both crossings lie on the same side: a negative entry is
  // a sphere behind the ship.
  const entryDistance = along - Math.sqrt(halfChordSquared);
  return entryDistance >= 0 ? entryDistance : null;
}

function pointAlong(from, ux, uy, uz, distance) {
  return {
    x: from.x + (ux * distance),
    y: from.y + (uy * distance),
    z: from.z + (uz * distance),
  };
}

// Inside a sphere's own test (findVolumeContaining): the surface counts.
function isWithinSphere(point, sphere) {
  return Math.hypot(
    point.x - sphere.position.x,
    point.y - sphere.position.y,
    point.z - sphere.position.z,
  ) <= sphere.rangeMeters;
}

// Returns a step in [0, limit] that `accepts` accepts, found by doubling then
// halving, or null when the doubling accepts none. Rounding can make
// `accepts` pass at a step and fail at a later one, so the step returned is
// not necessarily the smallest that passes: it may lie anywhere up to `limit`
// past one. `firstStep` must be positive, or the doubling never grows.
//
// The halving ends once the gap is at most `firstStep`, or once its midpoint
// rounds onto an end: the two ends are then neighbouring doubles, and no step
// lies between them. That second stop bounds the loop when `firstStep` is
// smaller than the gap between neighbouring doubles near the answer, which
// happens at scales under 0.5 m. Each pass otherwise moves one end to a
// double strictly between the two, so the doubles left between them always
// shrink.
function smallestAcceptedStep(accepts, firstStep, limit) {
  if (accepts(0)) {
    return 0;
  }
  let rejected = 0;
  let accepted = null;
  for (let step = firstStep; step <= limit; step *= 2) {
    if (accepts(step)) {
      accepted = step;
      break;
    }
    rejected = step;
  }
  if (accepted === null) {
    if (!(limit > rejected) || !accepts(limit)) {
      return null;
    }
    accepted = limit;
  }
  while (accepted - rejected > firstStep) {
    const middle = (rejected + accepted) / 2;
    if (middle === rejected || middle === accepted) {
      break;
    }
    if (accepts(middle)) {
      accepted = middle;
    } else {
      rejected = middle;
    }
  }
  return accepted;
}

function bitsOfDistance(distance) {
  distanceFloat[0] = distance;
  return distanceBits[0];
}

function distanceOfBits(bits) {
  distanceBits[0] = bits;
  return distanceFloat[0];
}

function isSamePoint(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

// Walks the line from `entryDistance` up to and including `closestDistance`
// for the first representable distance whose point Inside a sphere's test
// accepts, testing at most CHORD_WALK_BUDGET distinct points. Returns
// { distance, pointsTested, exhausted }: `distance` is that first distance,
// or null when none passes or the budget runs out first, and `exhausted` says
// the budget ran out with points on the stretch still untested. Both
// distances are non-negative, with entryDistance ≤ closestDistance, so the
// walk never leaves the chord's near half.
//
// It goes through every representable distance in that stretch, but tests
// each point on the line once: a run of distances that round to the same
// point is skipped, since its points are the one already tested. Each
// coordinate of pointAlong only moves one way as the distance grows (rounding
// is monotone), so once a point differs from the last, every point further on
// does too, and the first distance where it differs is found by doubling,
// then halving, over the doubles between. So the walk tests one point per
// distinct point on the stretch, up to its budget. How many distinct points a
// stretch holds is set by its finest coordinate, whose rounding step shrinks
// as the coordinate nears 0. Where every coordinate is around 1e11 m or more,
// the near-grazing sweeps' walks test at most about 6,000 points; where any
// coordinate of the points is near 0, neighbouring points can lie about
// 1e-11 m apart, so a stretch under a metre can hold 1e10 points or more, and
// only the budget bounds the walk.
function firstAcceptedChordDistance(from, ux, uy, uz, sphere, entryDistance, closestDistance) {
  // Math.max turns −0 into +0, whose bits sort first.
  const endBits = bitsOfDistance(Math.max(0, closestDistance));
  let lastBits = bitsOfDistance(Math.max(0, entryDistance));
  let lastPoint = pointAlong(from, ux, uy, uz, distanceOfBits(lastBits));
  let pointsTested = 0;
  const differsAt = (bits) => !isSamePoint(pointAlong(from, ux, uy, uz, distanceOfBits(bits)), lastPoint);
  while (lastBits < endBits) {
    // Doubling: `same` holds lastPoint, `differs` holds a different point.
    let same = lastBits;
    let differs = null;
    for (let gap = 1n; differs === null; gap *= 2n) {
      const probe = lastBits + gap < endBits ? lastBits + gap : endBits;
      if (differsAt(probe)) {
        differs = probe;
      } else if (probe === endBits) {
        // Every point left on the stretch is the one already tested.
        return { distance: null, pointsTested, exhausted: false };
      } else {
        same = probe;
      }
    }
    if (pointsTested >= CHORD_WALK_BUDGET) {
      // Another point is left on the stretch, but the budget is spent.
      return { distance: null, pointsTested, exhausted: true };
    }
    // Halving: down to neighbouring doubles, `differs` the first new point.
    while (differs - same > 1n) {
      const middle = same + ((differs - same) / 2n);
      if (differsAt(middle)) {
        differs = middle;
      } else {
        same = middle;
      }
    }
    const distance = distanceOfBits(differs);
    const point = pointAlong(from, ux, uy, uz, distance);
    pointsTested += 1;
    if (isWithinSphere(point, sphere)) {
      return { distance, pointsTested, exhausted: false };
    }
    lastBits = differs;
    lastPoint = point;
  }
  return { distance: null, pointsTested, exhausted: false };
}

// The point a stop or drag lands at: where the warp line enters `sphere`,
// `entryDistance` from `from`, held inside the surface. The exact entry
// point rounds to either side of the surface far from the origin, and Inside
// a sphere must count the ship as inside where it lands. The point always
// stays on the chord's near half, between the entry and the line's closest
// approach to the centre (the chord's deepest point):
//   - First, it is nudged inward along the line by a step that Inside a
//     sphere's test accepts, within LANDING_NUDGE_LIMIT_METERS of the entry
//     and never past the closest approach. The search returns a passing step
//     within that limit, not necessarily the smallest.
//   - When that search finds no step, it walks every representable distance
//     from the entry to the closest approach, that point included, and takes
//     the first whose point the test accepts (firstAcceptedChordDistance),
//     testing at most CHORD_WALK_BUDGET distinct points. That point may lie
//     more than 1 m from the entry, but never past the closest approach.
//   - Only when the walk finds no passing point does the unnudged entry point
//     stand, which may lie just outside: when no point on that stretch passes
//     (a line that misses the sphere by rounding), or when the budget runs
//     out first.
// Returns { landingPoint, landingDistanceMeters, chordWalk }: chordWalk is
// null when the walk didn't run, else its { pointsTested, exhausted }.
function landInside(from, ux, uy, uz, sphere, entryDistance) {
  const entryPoint = pointAlong(from, ux, uy, uz, entryDistance);
  const scaleMeters = Math.max(
    Math.abs(entryPoint.x),
    Math.abs(entryPoint.y),
    Math.abs(entryPoint.z),
    sphere.rangeMeters,
  );
  // Number.MIN_VALUE keeps the first step positive, as smallestAcceptedStep
  // needs: a sphere smaller than about 1e-308 m would make
  // scaleMeters · EPSILON round to 0.
  const roundingStep = Math.max(scaleMeters * Number.EPSILON, Number.MIN_VALUE);
  // How far along the line the closest approach lies past the entry.
  const closestDistance =
    ((sphere.position.x - from.x) * ux) +
    ((sphere.position.y - from.y) * uy) +
    ((sphere.position.z - from.z) * uz);
  const halfChord = Math.max(0, closestDistance - entryDistance);
  const accepts = (step) => isWithinSphere(pointAlong(from, ux, uy, uz, entryDistance + step), sphere);
  const alongStep = smallestAcceptedStep(
    accepts,
    roundingStep,
    Math.min(LANDING_NUDGE_LIMIT_METERS, halfChord),
  );
  let landingDistance = alongStep === null ? null : entryDistance + alongStep;
  let chordWalk = null;
  if (landingDistance === null) {
    const walk = firstAcceptedChordDistance(from, ux, uy, uz, sphere, entryDistance, closestDistance);
    chordWalk = { pointsTested: walk.pointsTested, exhausted: walk.exhausted };
    landingDistance = walk.distance;
  }
  if (landingDistance === null) {
    return { landingPoint: entryPoint, landingDistanceMeters: entryDistance, chordWalk };
  }
  return {
    landingPoint: pointAlong(from, ux, uy, uz, landingDistance),
    landingDistanceMeters: landingDistance,
    chordWalk,
  };
}

// Whether a crossing `entryDistance` along the path into `sphere` beats the
// best so far: the smaller distance, and on a tie the lower disruptorID.
function isBetterCrossing(entryDistance, sphere, best) {
  if (!best) {
    return true;
  }
  if (Math.abs(entryDistance - best.entryDistance) <= TIE_TOLERANCE_METERS) {
    return toInt(sphere.disruptorID, 0) < toInt(best.sphere.disruptorID, 0);
  }
  return entryDistance < best.entryDistance;
}

class InterdictionVolumes {
  constructor(systemID = 0) {
    this.systemID = toInt(systemID, 0);
    this.volumes = new Map();
    this.nextFixedVolumeID = -1;
  }

  get size() {
    return this.volumes.size;
  }

  // Adds a sphere; returns its volume ID (the sphere's item ID, or for a
  // field the heavy interdictor's), or null when `source` is no sphere.
  //   addVolume(position, { rangeMeters, ... }): a sphere at a fixed point.
  //   addVolume(probe Ball or its stored item): a dictor's probe.
  //   addVolume(mobile disruptor's stored item, { entity }): a mobile warp
  //     disruptor, its state read from the item (as a scene loading reads
  //     it), `entity` its Ball when it has one.
  //   addVolume(heavy interdictor's ship): its field, while it runs.
  // Adding a sphere already in the list replaces it.
  addVolume(source, options = {}) {
    const volume = this.buildVolume(source, options);
    if (!volume) {
      return null;
    }
    this.volumes.set(volume.volumeID, volume);
    return volume.volumeID;
  }

  buildVolume(source, options) {
    if (isVector(source)) {
      const rangeMeters = Math.max(0, toReal(options.rangeMeters, 0));
      if (rangeMeters <= 0) {
        return null;
      }
      const volumeID = toInt(options.volumeID, 0) || this.nextFixedVolumeID--;
      return {
        volumeID,
        kind: KIND.FIXED,
        scopeSource: options.scopeSource || null,
        candidate: {
          disruptorID: volumeID,
          typeID: toInt(options.typeID, 0),
          ownerID: toInt(options.ownerID, 0),
          position: readPosition(source),
          rangeMeters,
          source: options.source || KIND.FIXED,
        },
      };
    }
    if (!source || typeof source !== "object") {
      return null;
    }
    const itemID = toInt(source.itemID, 0);
    if (itemID <= 0) {
      return null;
    }
    if (interdictionProbeRuntime.isWarpDisruptionProbeType(source)) {
      return { volumeID: itemID, kind: KIND.PROBE, source, scopeSource: source };
    }
    const mobile = mobileRuntime();
    if (mobile.isMobileWarpDisruptorType(source)) {
      const state = mobile.getMobileWarpDisruptorStateFromItem(source);
      if (!state) {
        return null;
      }
      const typeID = toInt(source.typeID, 0);
      return {
        volumeID: itemID,
        kind: KIND.MOBILE,
        state,
        record: source,
        scopeSource: options.entity || source,
        typeID,
        ownerID: toInt(source.ownerID, 0),
        // Its Ball's position while it has one (the Ball is where the
        // sphere is), else the stored item's.
        positionSource: options.entity || null,
        position: readPosition(source),
        rangeMeters: toReal(state.rangeMeters, mobile.getWarpDisruptionRangeMetersForType(typeID)),
      };
    }
    if (source.activeModuleEffects instanceof Map || options.kind === KIND.FIELD) {
      return { volumeID: itemID, kind: KIND.FIELD, source, scopeSource: source };
    }
    return null;
  }

  removeVolume(volumeID) {
    return this.volumes.delete(toInt(volumeID, 0));
  }

  hasVolume(volumeID) {
    return this.volumes.has(toInt(volumeID, 0));
  }

  // A mobile warp disruptor's state changed (anchored and onlined): the
  // volume reads the new state from now on.
  setVolumeState(volumeID, state) {
    const volume = this.volumes.get(toInt(volumeID, 0));
    if (!volume || volume.kind !== KIND.MOBILE || !state) {
      return false;
    }
    volume.state = state;
    if (Number.isFinite(Number(state.rangeMeters)) && Number(state.rangeMeters) > 0) {
      volume.rangeMeters = Number(state.rangeMeters);
    }
    return true;
  }

  // The sphere a volume is now, or null while it is down (a probe expired, a
  // disruptor still anchoring, a field off). A field whose generator effect
  // is gone has been switched off for good: its volume is dropped.
  resolveVolume(volume, clocks) {
    switch (volume.kind) {
      case KIND.FIXED:
        return volume.candidate;
      case KIND.PROBE:
        // A probe's lifetime is on the wall clock, as its item records it
        // (interdictionProbeRuntime): read it there.
        return interdictionProbeRuntime.buildActiveWarpDisruptorCandidate(volume.source, {
          nowMs: clocks.wallclockNowMs,
        });
      case KIND.FIELD: {
        if (!hasWarpDisruptFieldEffect(volume.source)) {
          this.volumes.delete(volume.volumeID);
          return null;
        }
        return warpDisruptFieldGeneratorRuntime.buildActiveWarpDisruptorCandidate(volume.source, {
          nowMs: clocks.nowMs,
        });
      }
      case KIND.MOBILE: {
        const mobile = mobileRuntime();
        if (mobile.isAbyssalRestrictedWarpDisruptor(volume.record, volume.state)) {
          return null;
        }
        if (!mobile.isActiveWarpDisruptorState(volume.state, clocks.wallclockNowMs)) {
          return null;
        }
        const position = readPosition(volume.positionSource) || volume.position;
        if (!position || !(volume.rangeMeters > 0)) {
          return null;
        }
        return {
          disruptorID: volume.volumeID,
          typeID: volume.typeID,
          ownerID: volume.ownerID,
          position,
          rangeMeters: volume.rangeMeters,
        };
      }
      default:
        return null;
    }
  }

  // Every sphere up now, as `options.for` (an entity) sees spheres: its
  // interaction scope. Clocks: `nowMs` (game), `wallclockNowMs` (wall).
  listActive(options = {}) {
    const clocks = {
      nowMs: toReal(options.nowMs, Date.now()),
      wallclockNowMs: toReal(options.wallclockNowMs, Date.now()),
    };
    const viewer = options.for || null;
    const active = [];
    for (const volume of [...this.volumes.values()]) {
      if (viewer && volume.scopeSource && !canEntitiesInteractLocally(viewer, volume.scopeSource)) {
        continue;
      }
      const candidate = this.resolveVolume(volume, clocks);
      if (candidate) {
        active.push(candidate);
      }
    }
    return active;
  }

  // Whether `options.for` is immune to spheres.
  isImmune(entity) {
    return Boolean(entity && mobileRuntime().isEntityWarpBubbleImmune(entity));
  }

  // The nearest sphere up now with `position` inside it (its surface
  // included), with its distance, or null.
  findVolumeContaining(position, options = {}) {
    const point = readPosition(position);
    if (!point || this.isImmune(options.for)) {
      return null;
    }
    let closest = null;
    for (const sphere of this.listActive(options)) {
      const distance = Math.hypot(
        point.x - sphere.position.x,
        point.y - sphere.position.y,
        point.z - sphere.position.z,
      );
      if (distance > sphere.rangeMeters) {
        continue;
      }
      if (!closest || distance < closest.distanceMeters) {
        closest = { ...sphere, distanceMeters: distance };
      }
    }
    return closest;
  }

  // Warp outcome:
  // the one sphere up now that stops or drags a warp from the ship at `start`
  // to its landing point `landing` (the destination after warp-at-range), and
  // where the warp lands instead; or null. As `options.for` sees spheres.
  //
  // With d the distance from the ship to the landing point, and t the
  // distance along the warp line from the ship to where the line first meets
  // a sphere's edge:
  //   - stop: t ≤ d and d − t ≤ 500 km; it lands at the entry point;
  //   - drag: d < t ≤ d + 500 km, on the line extended past the landing
  //     point; it lands at that crossing;
  //   - nothing: met more than 500 km before the landing point, or not met
  //     at all (off the line, behind the ship).
  // Only the landing end counts: a sphere near the start of the warp and far
  // from its landing point is flown through.
  // Either landing point is held inside the sphere's surface (landInside),
  // so Inside a sphere counts the ship as inside where it lands. It
  // stays on the line between the entry and the line's closest approach to
  // the centre, normally within 1 m of the entry. The 1 m search may land
  // past an earlier passing point, anywhere within its 1 m limit; where it
  // finds none, the chord walk takes the first point on that stretch, by
  // every representable distance, that passes, within its budget of points,
  // so the point may lie further along. The one exception: when no point on
  // that stretch passes, a line that misses the sphere by rounding, or the
  // budget runs out first, the unnudged entry point stands, which may lie
  // just outside.
  // A sphere the ship starts inside (its surface counts) is ignored: that is
  // Inside a sphere's question. Any stop beats any drag; among either, the
  // smallest t wins, and a tie goes to the lower disruptorID. The call reads
  // the spheres and changes nothing.
  resolveWarpOutcome(start, landing, options = {}) {
    if (this.isImmune(options.for)) {
      return null;
    }
    const from = readPosition(start);
    const to = readPosition(landing);
    if (!from || !to) {
      return null;
    }
    const pathX = to.x - from.x;
    const pathY = to.y - from.y;
    const pathZ = to.z - from.z;
    const pathLength = Math.sqrt((pathX * pathX) + (pathY * pathY) + (pathZ * pathZ));
    if (!(pathLength > DEGENERATE_PATH_METERS)) {
      return null;
    }
    const ux = pathX / pathLength;
    const uy = pathY / pathLength;
    const uz = pathZ / pathLength;
    let stop = null;
    let drag = null;
    for (const sphere of this.listActive(options)) {
      const entryDistance = lineEntryDistance(from, ux, uy, uz, sphere);
      if (entryDistance === null) {
        continue;
      }
      let kind = null;
      if (entryDistance <= pathLength) {
        if (pathLength - entryDistance <= SPHERE_REACH_METERS) {
          kind = "stop";
        }
      } else if (entryDistance <= pathLength + SPHERE_REACH_METERS) {
        kind = "drag";
      }
      if (kind === "stop" && isBetterCrossing(entryDistance, sphere, stop)) {
        stop = { sphere, entryDistance };
      } else if (kind === "drag" && isBetterCrossing(entryDistance, sphere, drag)) {
        drag = { sphere, entryDistance };
      }
    }
    const winner = stop || drag;
    if (!winner) {
      return null;
    }
    const { sphere, entryDistance } = winner;
    const { landingPoint, landingDistanceMeters } = landInside(from, ux, uy, uz, sphere, entryDistance);
    return {
      kind: stop ? "stop" : "drag",
      disruptorID: sphere.disruptorID,
      typeID: sphere.typeID,
      ownerID: sphere.ownerID,
      position: { ...sphere.position },
      rangeMeters: sphere.rangeMeters,
      landingPoint,
      landingDistanceMeters,
    };
  }
}

function createInterdictionVolumes(systemID) {
  return new InterdictionVolumes(systemID);
}

module.exports = {
  KIND,
  SPHERE_REACH_METERS,
  InterdictionVolumes,
  createInterdictionVolumes,
};
