"use strict";
const { toInt } = require("../domain/abyssalRuntimeValues");

function buildErrorList(ports, errors) {
  const {
    buildList,
    ABYSS_ERROR,
  } = ports;
  return buildList(
    (Array.isArray(errors) ? errors : [])
      .map(([code, args]) => [
        toInt(code, ABYSS_ERROR.UNKNOWN_ERROR),
        Array.isArray(args) ? args : [],
      ]),
  );
}

function throwAbyssError(ports, errors) {
  const {
    throwWrappedUserError,
  } = ports;
  throwWrappedUserError("AbyssError", {
    errors: buildErrorList(ports, errors),
  });
}

function throwGateRejected(ports) {
  const {
    throwWrappedUserError,
  } = ports;
  throwWrappedUserError("DeniedTargetAttemptFailed");
}

function throwCustomNotify(ports, message) {
  const {
    throwWrappedUserError,
  } = ports;
  throwWrappedUserError("CustomNotify", {
    notify: String(message || "").trim() || "Action unavailable.",
  });
}

function buildAbyssErrorArgs(ports, code, details = {}) {
  const {
    CLIENT_ABYSS_ERROR,
  } = ports;
  const normalized = details && typeof details === "object" ? details : {};
  switch (toInt(code, CLIENT_ABYSS_ERROR.UNKNOWN_ERROR)) {
    // ProximityRestriction(distance=<client constant>, type=args[0])
    case CLIENT_ABYSS_ERROR.PROXIMITY_RESTRICTION:
      return [toInt(normalized.blockerTypeID, 0)];
    // ItemNotReachable(type=args[0])
    case CLIENT_ABYSS_ERROR.ITEM_NOT_REACHABLE:
      return [toInt(normalized.filamentTypeID, 0)];
    // AdditionalFilamentsNeeded(amount=args[0])
    case CLIENT_ABYSS_ERROR.INVALID_KEY_AMOUNT:
      return [toInt(normalized.requiredQuantity, 0)];
    // ProximityEntrance(distance=args[0])
    case CLIENT_ABYSS_ERROR.PROXIMITY_ENTRANCE:
      return [toInt(normalized.maximumDistanceMeters, 0)];
    default:
      return [];
  }
}

function buildAbyssErrorFromValidationError(ports, validationError) {
  const {
    CLIENT_ABYSS_ERROR,
  } = ports;
  // `toInt(null, fallback)` is 0, not the fallback, so a missing code has to be
  // caught before it reaches toInt -- 0 is not a code the client can render.
  const rawCode = validationError && validationError.code;
  const code = rawCode == null
    ? CLIENT_ABYSS_ERROR.UNKNOWN_ERROR
    : toInt(rawCode, CLIENT_ABYSS_ERROR.UNKNOWN_ERROR) ||
      CLIENT_ABYSS_ERROR.UNKNOWN_ERROR;
  return [[code, buildAbyssErrorArgs(ports, code, validationError && validationError.details)]];
}

function createAbyssalProtocolErrors(ports) {
  return {
    buildErrorList: buildErrorList.bind(null, ports),
    throwAbyssError: throwAbyssError.bind(null, ports),
    throwGateRejected: throwGateRejected.bind(null, ports),
    throwCustomNotify: throwCustomNotify.bind(null, ports),
    buildAbyssErrorArgs: buildAbyssErrorArgs.bind(null, ports),
    buildAbyssErrorFromValidationError: buildAbyssErrorFromValidationError.bind(null, ports),
  };
}

module.exports = { createAbyssalProtocolErrors };
