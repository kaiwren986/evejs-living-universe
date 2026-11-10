"use strict";

const TYPE_ABYSSAL_TRACE = 48964;

const ABYSSAL_TRACE_GAME_MODE_ID = Object.freeze({
  // Current EVE client abyss.game_mode.GameModeID values.
  SOLO: 1,
  COOP: 2,
  TWO_PLAYER: 3,
  UNCONFIRMED_FALLBACK: 1,
});

const ABYSSAL_GATE_ACTIVATION_STATE = Object.freeze({
  UNAVAILABLE: 0,
  AVAILABLE: 1,
});

function toInt(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback;
}

function resolveAbyssalTraceGameModeID(state = {}) {
  const shipClass = String(state.shipClass || "").trim().toLowerCase();
  const requiredFilaments = toInt(state.requiredFilaments, 0);
  const maxShips = toInt(state.maxShips, 0);
  const activateForFleet = state.activateForFleet === true;
  if (
    shipClass === "frigate" ||
    (requiredFilaments === 3 && maxShips === 3 && activateForFleet)
  ) {
    return ABYSSAL_TRACE_GAME_MODE_ID.COOP;
  }
  if (
    shipClass === "destroyer" ||
    (requiredFilaments === 2 && maxShips === 2 && activateForFleet)
  ) {
    return ABYSSAL_TRACE_GAME_MODE_ID.TWO_PLAYER;
  }
  if (
    shipClass === "cruiser" ||
    (requiredFilaments === 1 && maxShips === 1 && !activateForFleet)
  ) {
    return ABYSSAL_TRACE_GAME_MODE_ID.SOLO;
  }
  return ABYSSAL_TRACE_GAME_MODE_ID.UNCONFIRMED_FALLBACK;
}

function buildAbyssalTracePresentationState(state = {}) {
  return {
    gameModeID: resolveAbyssalTraceGameModeID(state),
    abyssFilamentTypeID: toInt(
      state.abyssFilamentTypeID,
      toInt(state.filamentTypeID, 0),
    ),
    activationState: toInt(
      state.activationState,
      ABYSSAL_GATE_ACTIVATION_STATE.AVAILABLE,
    ),
    isAbyssGateOpen: state.isAbyssGateOpen === undefined
      ? true
      : state.isAbyssGateOpen === true,
  };
}

function applyAbyssalTracePresentationState(entity, state = {}) {
  if (!entity) {
    return entity;
  }
  const presentationState = buildAbyssalTracePresentationState(state);
  entity.gameModeID = presentationState.gameModeID;
  entity.abyssFilamentTypeID = presentationState.abyssFilamentTypeID;
  entity.activationState = presentationState.activationState;
  entity.isAbyssGateOpen = presentationState.isAbyssGateOpen;
  entity.dungeonGateState = presentationState.isAbyssGateOpen ? "open" : "locked";
  return entity;
}

function applyAbyssalGatePresentationState(entity, state = {}) {
  if (!entity) {
    return entity;
  }
  const isOpen = state.isAbyssGateOpen === true || state.open === true;
  entity.isAbyssGateOpen = isOpen;
  entity.evejsAbyssalConduitOpen = isOpen;
  entity.animationState = isOpen ? 1 : 0;
  entity.dungeonMaterializedGate = true;
  entity.dungeonGateState = isOpen ? "open" : "locked";
  const openedAtMs = toInt(state.openedAtMs, toInt(state.conduitOpenedAtMs, 0));
  entity.evejsAbyssalConduitOpenedAtMs = openedAtMs > 0 ? openedAtMs : null;
  const gateActivationRange = toInt(state.gateActivationRange, 0);
  if (gateActivationRange > 0) {
    entity.gateActivationRange = gateActivationRange;
  }
  return entity;
}

module.exports = {
  ABYSSAL_GATE_ACTIVATION_STATE,
  ABYSSAL_TRACE_GAME_MODE_ID,
  TYPE_ABYSSAL_TRACE,
  applyAbyssalGatePresentationState,
  applyAbyssalTracePresentationState,
  buildAbyssalTracePresentationState,
  resolveAbyssalTraceGameModeID,
};
