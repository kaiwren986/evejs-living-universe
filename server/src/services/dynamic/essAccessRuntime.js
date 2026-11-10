"use strict";

const { throwWrappedUserError } = require("../../common/machoErrors");
const { matchesTypeList } = require("../inventory/typeListAuthority");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");

const ESS_GATE_ALLOWED_SHIPS_LIST = 372;
const ESS_GATE_ACTIVATION_RANGE_METERS = 2_500;
// Only this module can mark a warp as an admitted ESS gate transit. The
// generic dungeonGateTransit flag alone cannot skip the ESS entrance.
const admittedGateTransit = Symbol("admitted ESS acceleration gate transit");

function distance(left, right) {
  if (!left || !right) return Infinity;
  const delta = ["x", "y", "z"].map(axis => Number(left[axis]) - Number(right[axis]));
  return delta.every(Number.isFinite) ? Math.hypot(...delta) : Infinity;
}

function listSites(scene) {
  return require("../../space/encounterSurveillanceSystem").listSystemEssSites(scene);
}

function isEssAccelerationGate(scene, entity) {
  return Boolean(entity && listSites(scene).some(site => site.gate === entity));
}

function gateInteractionLimit(gate, ship) {
  const range = Number(gate.gateActivationRange) || ESS_GATE_ACTIVATION_RANGE_METERS;
  return Math.max(ESS_GATE_ACTIVATION_RANGE_METERS,
    range + Math.max(0, Number(gate.radius) || 0) + Math.max(0, Number(ship.radius) || 0));
}

function activateGateForSession(session, gateEntityOrID) {
  const spaceRuntime = require("../../space/runtime");
  const scene = spaceRuntime.getSceneForSession(session);
  const gateID = Number(typeof gateEntityOrID === "object" ? gateEntityOrID?.itemID : gateEntityOrID);
  const gate = scene?.getEntityByID(gateID);
  const site = scene && listSites(scene).find(candidate => candidate.gate === gate);
  if (!site) throwWrappedUserError("DeniedTargetAttemptFailed");

  const ship = scene.getShipEntityForSession(session);
  if (!ship || ship.kind !== "ship" || ship._pendingDestruction || ship.pendingDock) {
    throwWrappedUserError("DeniedShipChanged");
  }
  if (ship.mode === "WARP") throwWrappedUserError("ShipInWarp");
  if (ship.cloaked || ship.isCloaked || !canEntitiesInteractLocally(ship, gate)) {
    throwWrappedUserError("DeniedTargetAttemptFailed");
  }
  const range = Number(gate.gateActivationRange) || ESS_GATE_ACTIVATION_RANGE_METERS;
  if (distance(ship.position, gate.position) > gateInteractionLimit(gate, ship)) {
    throwWrappedUserError("DunGateTooFarAway", { maxdist: Math.round(range) });
  }
  const type = resolveItemByTypeID(ship.typeID);
  if (!type || !matchesTypeList(type, ESS_GATE_ALLOWED_SHIPS_LIST)) {
    throwWrappedUserError("DunShipCannotWarp");
  }
  const point = site.warpInPosition || site.bank.essWarpInPosition;
  if (!point || !Number.isFinite(distance(point, site.bank.position))) {
    throwWrappedUserError("DeniedTargetAttemptFailed");
  }
  const result = spaceRuntime.warpToPoint(session, point, {
    stopDistance: 0,
    dungeonGateTransit: true,
    missionGateEffectSourceID: gate.itemID,
    [admittedGateTransit]: { scene, ship, gate, session, attachment: session._space },
  });
  if (!result?.success) {
    throwWrappedUserError("CustomInfo", { info: "Your ship cannot activate the ESS acceleration gate right now." });
  }
  return null;
}

function resolveWarpLanding(ship, point, options) {
  const destination = Object.fromEntries(["x", "y", "z"].map(axis => [axis,
    Number(point?.[axis]) + (Number(options.warpJitter?.[axis]) || 0),
  ]));
  const length = distance(ship.position, destination);
  const stopDistance = Math.max(0, Number(options.stopDistance) || 0);
  if (!Number.isFinite(length) || !length || !stopDistance) return destination;
  return Object.fromEntries(["x", "y", "z"].map(axis => [axis,
    destination[axis] - (destination[axis] - Number(ship.position[axis])) * stopDistance / length,
  ]));
}

function evaluateEssDeadspaceWarp(scene, ship, point, options = {}) {
  if (!ship || ship.kind !== "ship" || ship.npc === true || ship.nativeNpc === true) {
    return { action: "allow" };
  }
  const landing = resolveWarpLanding(ship, point, options);
  for (const site of listSites(scene)) {
    if (!canEntitiesInteractLocally(ship, site.bank)) continue;
    const transit = options[admittedGateTransit];
    // Movement commands may be queued. A later ship/scene attachment must not
    // inherit another hull's already-validated gate admission.
    if (transit && transit.scene === scene && transit.ship === ship && transit.gate === site.gate &&
      transit.session._space === transit.attachment && scene.getShipEntityForSession(transit.session) === ship &&
      distance(ship.position, site.gate.position) <= gateInteractionLimit(site.gate, ship)) continue;
    const radius = Number(site.bank.essDeadspaceRadiusMeters) || 1_000_000_000;
    const lobbyRadius = Number(site.bank.essEntryLobbyRadiusMeters) || 1_000_000;
    const isInLobby = position => distance(position, site.beacon.position) <= lobbyRadius;
    const siteDestinations = [point, landing].filter(position => distance(position, site.bank.position) <= radius);
    if (!siteDestinations.length) continue;
    if (distance(ship.position, site.bank.position) <= radius && !isInLobby(ship.position)) {
      return { action: "block", errorMsg: "DunCannotWarpWithinComplex" };
    }
    // The entry lobby is open space. A ship inside the bank's deadspace must
    // leave the complex before returning to it; everybody else may warp to
    // the entrance. Check the actual landing as well as the named destination
    // so a long warp-at range cannot turn an entry warp into a bank shortcut.
    if (siteDestinations.every(isInLobby)) continue;
    return {
      action: "clamp",
      point: { ...site.beacon.position },
      targetEntityID: site.beacon.itemID,
    };
  }
  return { action: "allow" };
}

module.exports = {
  ESS_GATE_ALLOWED_SHIPS_LIST,
  ESS_GATE_ACTIVATION_RANGE_METERS,
  activateGateForSession,
  evaluateEssDeadspaceWarp,
  isEssAccelerationGate,
};
