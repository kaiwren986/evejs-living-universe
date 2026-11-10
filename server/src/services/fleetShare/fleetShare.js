"use strict";

// Fleet share (doc/FLEET_SHARES.md): who shares a fleet share of an NPC
// bounty or a mission reward, and how a reward divides among them. It holds
// no state, changes nothing it reads, and sends nothing.

const path = require("path");
const randomSource = require("../../common/random");

// Fleets → Fleet membership, read at each call: required lazily and called as
// a property of the module's exports, never taken at load.
function getFleetMemberCharacterIDs(characterID) {
  const fleetRuntime = require(path.join(__dirname, "../fleets/fleetRuntime"));
  return fleetRuntime.getFleetMemberCharacterIDs(characterID);
}

// A pilot's character ID as a number, or null when it is not a positive
// integer (a numeric string is read as its number).
function toPilotID(characterID) {
  if (typeof characterID !== "number" && typeof characterID !== "string") {
    return null;
  }
  const pilotID = typeof characterID === "string" && characterID.trim() === ""
    ? NaN
    : Number(characterID);
  return Number.isSafeInteger(pilotID) && pilotID > 0 ? pilotID : null;
}

// The other members of the pilot's fleet: each member ID once, the pilot left
// out, in ascending character ID.
function otherFleetMembers(pilotID) {
  const others = new Set(getFleetMemberCharacterIDs(pilotID));
  others.delete(pilotID);
  return [...others].sort((left, right) => left - right);
}

// Bounty sharers: the final-blow pilot, then each other member of their fleet
// whose ship is in the NPC's Grid bubble now, in ascending character ID.
// Without a scene or a Grid bubble (null options included), the final-blow
// pilot alone.
function resolveBountySharers(finalBlowCharacterID, options) {
  const { scene, gridBubbleID } = options || {};
  const pilotID = toPilotID(finalBlowCharacterID);
  if (pilotID === null) {
    return [];
  }
  if (!scene || gridBubbleID === null || gridBubbleID === undefined) {
    return [pilotID];
  }
  const onGrid = new Set(
    scene.getSessionsInBubble(gridBubbleID).map((session) => session.characterID),
  );
  return [pilotID, ...otherFleetMembers(pilotID).filter((memberID) => onGrid.has(memberID))];
}

// The most other members who share a mission reward with the completing pilot.
const MISSION_SHARERS_OTHERS_CAP = 9;

// `count` of `candidates` picked uniformly at random (every subset of that
// size equally likely), by a partial Fisher-Yates shuffle over a copy. Each
// draw's index is clamped into range, so a `random` value outside [0, 1)
// never yields a missing or repeated candidate.
function pickUniformly(candidates, count, random) {
  const pool = [...candidates];
  for (let index = 0; index < count; index += 1) {
    const remaining = pool.length - index;
    const draw = Math.floor(random() * remaining);
    const offset = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), remaining - 1) : 0;
    const swapIndex = index + offset;
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, count);
}

// Mission sharers: the completing pilot, then the other members of their
// fleet, anywhere, in ascending character ID. When more than 9 others
// qualify, 9 are picked uniformly at random, drawing only on `random`.
function resolveMissionSharers(completerCharacterID, { random = randomSource.random } = {}) {
  const pilotID = toPilotID(completerCharacterID);
  if (pilotID === null) {
    return [];
  }
  const others = otherFleetMembers(pilotID);
  if (others.length <= MISSION_SHARERS_OTHERS_CAP) {
    return [pilotID, ...others];
  }
  const picked = pickUniformly(others, MISSION_SHARERS_OTHERS_CAP, random);
  return [pilotID, ...picked.sort((left, right) => left - right)];
}

// How many of each Even split unit make one: ISK splits to the cent, LP to
// the whole point. Standings ("exact") are not rounded.
const UNITS_PER_ONE = Object.freeze({ cent: 100, point: 1 });

// The parts of `amount` split `count` ways: [the first part, each other part].
// Each other part is `amount ÷ count` rounded down to the unit, and the first
// takes the remainder. An amount on the unit's grid is counted in whole units,
// so a float such as 100.01 × 100 = 10001.000000000002 splits exactly.
function splitParts(amount, count, unit) {
  const unitsPerOne = UNITS_PER_ONE[unit];
  if (unitsPerOne === undefined) {
    const part = amount / count;
    return [amount - part * (count - 1), part];
  }
  const scaled = amount * unitsPerOne;
  const nearest = Math.round(scaled);
  const units = Math.abs(scaled - nearest) < 1e-6 ? nearest : scaled;
  const partUnits = Math.floor(units / count);
  return [(units - partUnits * (count - 1)) / unitsPerOne, partUnits / unitsPerOne];
}

// Even split: one `{ characterID, amount }` part per recipient, in the order
// given, the first (the earner) taking any remainder; `unit` is "cent" (ISK),
// "point" (LP) or "exact" (standings).
function splitEvenly(amount, recipientIDs, unit) {
  if (!Array.isArray(recipientIDs) || recipientIDs.length === 0) {
    return [];
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || !(amount > 0)) {
    return recipientIDs.map((characterID) => ({ characterID, amount: 0 }));
  }
  const [firstPart, otherPart] = splitParts(amount, recipientIDs.length, unit);
  return recipientIDs.map((characterID, index) => ({
    characterID,
    amount: index === 0 ? firstPart : otherPart,
  }));
}

module.exports = {
  resolveBountySharers,
  resolveMissionSharers,
  splitEvenly,
};
