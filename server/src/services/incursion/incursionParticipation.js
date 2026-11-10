"use strict";

// Fleet competition and completion-time qualification are shared by reviewed
// encounter versions. Their frozen policy, contribution and presence owners
// provide the facts; this pure decision creates no awards or world objects.
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
function fail(code) { const error = new Error(code); error.code = code; throw error; }

function finalize(state, present, nowMs) {
  if (state.status === "completed") return state;
  if (state.status !== "ready" || !Array.isArray(present) || !Number.isSafeInteger(nowMs) || nowMs < state.startedAtMs) fail("INCURSION_COMPLETION_INVALID");
  const scores = {};
  for (const fleets of Object.values(state.contributions)) for (const [fleetID, facts] of Object.entries(fleets)) {
    scores[fleetID] = (scores[fleetID] || 0) + facts.damage;
  }
  const winner = Object.keys(scores).filter(id => scores[id] > 0)
    .sort((a, b) => scores[b] - scores[a] || Number(a) - Number(b))[0] || null;
  const valid = new Map();
  for (const pilot of present) {
    if (!positive(pilot.characterID) || !nonnegative(pilot.fleetID) ||
        typeof pilot.activeShip !== "boolean" || typeof pilot.cloaked !== "boolean") fail("INCURSION_PRESENCE_INVALID");
    if (valid.has(pilot.characterID)) fail("INCURSION_PRESENCE_DUPLICATE");
    valid.set(pilot.characterID, pilot);
  }
  const recipients = [], disqualified = [];
  const participantIDs = [...new Set([...Object.keys(state.contributions).map(Number), ...valid.keys()])].sort((a, b) => a - b);
  for (const characterID of participantIDs) {
    const pilot = valid.get(characterID);
    const facts = state.contributions[characterID]?.[winner];
    const refuse = (reason, data) => disqualified.push({ characterID, reason, ...(data === undefined ? {} : { data }) });
    if (!pilot) { refuse("departed"); continue; }
    if (!pilot.fleetID) { refuse("not-in-fleet"); continue; }
    if (!pilot.activeShip) { refuse("invalid-group", pilot.groupID || 29); continue; }
    if (pilot.cloaked) { refuse("cloaked"); continue; }
    if (winner && String(pilot.fleetID) !== winner) { refuse("not-best-fleet"); continue; }
    if (!facts) { refuse("low-contribution"); continue; }
    const repair = Object.entries(facts.repairs).reduce((total, [targetID, value]) => {
      const target = valid.get(Number(targetID));
      return total + (target && String(target.fleetID) === winner &&
        state.contributions[targetID]?.[winner]?.damage > 0 ? value : 0);
    }, 0);
    if (facts.damage + repair >= state.policy.participation.minimumAppliedContribution) recipients.push(characterID);
    else refuse("low-contribution");
  }
  state.participantIDs = participantIDs;
  state.status = "completed";
  state.completion = { completedAtMs: nowMs, winnerFleetID: winner ? Number(winner) : null,
    fleetDamage: scores, recipients: recipients.sort((a, b) => a - b), disqualified,
    presence: [...valid.values()].sort((a, b) => a.characterID - b.characterID) };
  return state;
}

function policy() {
  return {
    version: 1,
    authority: "ccp-damage-or-logistics-with-bounded-emulator-eligibility-policy",
    minimumAppliedContribution: 1,
    winner: "highest-applied-damage-fleet",
    tie: "lowest-numeric-fleet-id",
    presence: "active-uncloaked-ship-at-completion",
    membership: "same-fleet-at-effect-and-completion",
    repair: "actual-hp-restored-to-same-fleet-damage-contributor",
    radiusMeters: 250000,
    qualification: "Damage or logistics is required by CCP's August2017 notes. The exact HP threshold, tie rule, membership snapshot, range and logistics association are explicit versioned emulator policy.",
  };
}

module.exports = { finalize, policy };
