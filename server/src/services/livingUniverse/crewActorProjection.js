"use strict";
const progression = require("../crew/crewProgression");

// Crew persistence is authoritative. Universe/UI projections never write a
// second copy of people, routes or cargo and cannot settle an economic effect.
function projectCrew(state) {
  if (!state) return { actors: [], recentEvents: [] };
  const policy = state.standingOrder;
  const paused = policy?.paused || state.job?.pausedAtMs != null;
  const activity = state.job?.recoveryError || state.pendingReceiptCleanup?.length ? "awaiting_confirmation" : paused ? "paused" : state.job ? state.job.cargo ? "hauling" : policy?.enabled ? "returning" : "travelling"
    : policy?.enabled ? policy.followProduction ? policy.status : "waiting_for_stock" : "docked";
  return {
    actors: state.roster.map((person, index) => ({
      actorID: person.actorID || `crew:${state.ownerID}:member:${index}`, kind: "crew_member", source: "crews", crewID: `crew:${state.ownerID}`,
      name: person.name, role: person.role, ownerID: state.ownerID, crewName: state.name,
      employerCorporationID: state.employerCorporationID || null,
      systemID: state.systemID, stationID: state.job ? null : state.stationID,
      representation: "virtual", physicalEntityID: null, activity, skill: progression.profile(state, "hauling"),
      destinationStationID: state.job?.destinationStationID || null,
      standingOrderID: policy?.enabled ? policy.orderID : null,
    })),
    recentEvents: state.history.map((trip) => ({
      eventID: `crew:${trip.jobID}:completed`, source: "crews", crewID: `crew:${state.ownerID}`, ownerID: state.ownerID,
      type: trip.cargo ? "cargo_delivered" : "crew_arrived", occurredAtMs: trip.completedAtMs,
      stationID: trip.destinationStationID, automatic: Boolean(trip.automaticOrderID),
      cargo: trip.cargo ? { typeID: trip.cargo.typeID, quantity: trip.cargo.quantity } : null,
    })),
  };
}
module.exports = { projectCrew };
