"use strict";
const path = require("path");
const { toInt } = require("../../common/numbers");
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const { matchesTypeList } = require("../inventory/typeListAuthority");
const ESS_LINKABLE_TYPES_LIST = 231;
const ESS_MAX_LINK_DISTANCE_METERS = 10_000;

function getCharacterID(session = null) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function toReal(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getSessionShipID(session = null) {
  return toInt(
    session && (
      (session._space && session._space.shipID) ||
      session.shipID ||
      session.shipid ||
      session.activeShipID
    ),
    0,
  );
}

function hasSpaceValidationContext(session = null) {
  return Boolean(session && session._space && getSessionShipID(session) > 0);
}

function getEntityPosition(entity = null) {
  const source =
    entity && entity.position ||
    entity && entity.spaceState && entity.spaceState.position ||
    null;
  if (
    !source ||
    !Number.isFinite(Number(source.x)) ||
    !Number.isFinite(Number(source.y)) ||
    !Number.isFinite(Number(source.z))
  ) {
    return null;
  }
  return {
    x: toReal(source.x, 0),
    y: toReal(source.y, 0),
    z: toReal(source.z, 0),
  };
}

function getDistance(left = null, right = null) {
  const leftPosition = getEntityPosition(left);
  const rightPosition = getEntityPosition(right);
  if (!leftPosition || !rightPosition) {
    return Infinity;
  }
  const dx = leftPosition.x - rightPosition.x;
  const dy = leftPosition.y - rightPosition.y;
  const dz = leftPosition.z - rightPosition.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function buildTypeContext(entity = null) {
  return {
    typeID: toInt(entity && entity.typeID, 0),
    groupID: toInt(entity && entity.groupID, 0),
    categoryID: toInt(entity && entity.categoryID, 0),
  };
}

function validateExistingBankLinks(state, characterID, bankName) {
  if (!state || !toInt(state.essID, 0)) {
    return "LINK_ERROR_SYSTEM_OFFLINE";
  }
  if (bankName === "main") {
    if (state.reserveLinkedCharacterIDs.has(characterID)) {
      return "LINK_ERROR_ALREADY_LINKED";
    }
    if (state.mainBankLink) {
      return state.mainBankLink.characterID === characterID
        ? "LINK_ERROR_ALREADY_LINKED"
        : "LINK_ERROR_LINK_OCCUPIED";
    }
  }
  if (bankName === "reserve") {
    if (state.mainBankLink && state.mainBankLink.characterID === characterID) {
      return "LINK_ERROR_ALREADY_LINKED";
    }
    if (state.reserveLinkedCharacterIDs.has(characterID)) {
      return "LINK_ERROR_ALREADY_LINKED";
    }
  }
  return null;
}

function validateEssLinkEligibility(session, state, bankName) {
  const characterID = getCharacterID(session);
  if (!characterID) return "LINK_ERROR_NO_BALLPARK";
  return validateExistingBankLinks(state, characterID, bankName) || validatePresence(session, state);
}
function validatePresence(session, state, expectedShipID = 0) {
  if (!hasSpaceValidationContext(session)) return "LINK_ERROR_NO_BALLPARK";
  if (expectedShipID && getSessionShipID(session) !== Number(expectedShipID)) return "LINK_ERROR_INVALID_SHIP_TYPE";
  if (!state?.essID) return "LINK_ERROR_SYSTEM_OFFLINE";
  const scene = spaceRuntime.getSceneForSession(session);
  if (scene && Number(scene.systemID) !== Number(state.solarSystemID)) return "LINK_ERROR_NOT_ON_GRID";
  if (!scene || typeof scene.getEntityByID !== "function") {
    return "LINK_ERROR_NO_BALLPARK";
  }

  const shipEntity = scene.getEntityByID(getSessionShipID(session));
  if (!shipEntity || shipEntity.kind !== "ship" || shipEntity.mode === "WARP" || shipEntity.cloaked || shipEntity.isCloaked || shipEntity._pendingDestruction) {
    return "LINK_ERROR_INVALID_SHIP_TYPE";
  }
  if (!matchesTypeList(buildTypeContext(shipEntity), ESS_LINKABLE_TYPES_LIST)) {
    return "LINK_ERROR_INVALID_SHIP_TYPE";
  }

  const essEntity = scene.getEntityByID(state.essID);
  if (
    !essEntity ||
    !canEntitiesInteractLocally(shipEntity, essEntity)
  ) {
    return "LINK_ERROR_NOT_ON_GRID";
  }

  if (getDistance(shipEntity, essEntity) > ESS_MAX_LINK_DISTANCE_METERS) {
    return "LINK_ERROR_OUT_OF_RANGE";
  }
  return null;
}


module.exports = { validateEssLinkEligibility, validatePresence, getSessionShipID, ESS_LINKABLE_TYPES_LIST, ESS_MAX_LINK_DISTANCE_METERS };
