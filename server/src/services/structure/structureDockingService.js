"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  extractDictEntries,
  normalizeNumber,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const transitions = require(path.join(__dirname, "../../space/transitions"));
const structureState = require(path.join(__dirname, "./structureState"));
const {
  buildUndockContrabandWarningArguments,
} = require(path.join(__dirname, "../security/contrabandInspectionRuntime"));

const USER_ERROR_LOCALIZATION_LABEL = 101;
const SHIP_TOO_LARGE_LABEL = "UI/Station/StationManagment/ShipTooLarge";

function normalizePositiveInt(value, fallback = 0) {
  const numericValue = normalizeNumber(value, fallback);
  return Number.isInteger(numericValue) && numericValue > 0
    ? numericValue
    : fallback;
}

function getSessionShipID(session) {
  return normalizePositiveInt(
    session &&
      (
        (session._space && session._space.shipID) ||
        session.activeShipID ||
        session.shipID ||
        session.shipid
      ),
    0,
  );
}

function getKwargValue(kwargs, key) {
  for (const [entryKey, entryValue] of extractDictEntries(kwargs)) {
    // Was String(entryKey), which resolves a Buffer key only because Buffer.toString
    // defaults to utf8 -- it returns "[object Object]" for the {type,value} forms the
    // decoder also produces. strVal handles all of them. See the note on
    // accountService.extractKwarg.
    if (strVal(entryKey) === String(key)) {
      return entryValue;
    }
  }
  if (
    kwargs &&
    typeof kwargs === "object" &&
    !Array.isArray(kwargs) &&
    Object.prototype.hasOwnProperty.call(kwargs, key)
  ) {
    return kwargs[key];
  }
  return null;
}

function buildDockingApproachUserErrorValues(dockingDebug = null) {
  const distance = Math.max(
    0,
    Math.round(Number(dockingDebug && dockingDebug.dockingDistance) || 0),
  );
  return { distance };
}

function throwDockingDenied(errorMsg = "", context = {}) {
  switch (String(errorMsg || "").trim()) {
    case "DOCKING_APPROACH_REQUIRED":
      throwWrappedUserError(
        "DockingApproach",
        buildDockingApproachUserErrorValues(context && context.dockingDebug),
      );
      break;
    case "SHIP_TOO_LARGE_FOR_STRUCTURE":
      throwWrappedUserError("DockingRequestDenied", {
        reason: [USER_ERROR_LOCALIZATION_LABEL, SHIP_TOO_LARGE_LABEL],
      });
      break;
    case "STRUCTURE_DOCKING_DENIED":
      throwWrappedUserError("DockingRequestDenied", {
        reason: "Structure docking access denied.",
      });
      break;
    case "DOCKING_DISALLOWED_BY_MODULE":
      throwWrappedUserError("DockingRequestDenied", {
        reason: "You cannot dock while a module that prevents docking is active.",
      });
      break;
    case "STRUCTURE_DOCKING_UNAVAILABLE":
      throwWrappedUserError("DockingRequestDenied", {
        reason: "Structure docking is unavailable.",
      });
      break;
    case "SHIP_EXCLUDED_FROM_STRUCTURE":
      throwWrappedUserError("DockingRequestDenied", {
        reason: "This ship cannot dock at this structure.",
      });
      break;
    case "CRIMINAL_TIMER_ACTIVE":
      throwWrappedUserError("CustomInfo", {
        info: "Docking is disabled while the criminal timer is active.",
      });
      break;
    case "NOT_IN_SPACE":
    case "SHIP_NOT_FOUND":
    case "SCENE_NOT_FOUND":
      throwWrappedUserError("DeniedShipChanged");
      break;
    case "STRUCTURE_NOT_FOUND":
    case "STATION_NOT_FOUND":
      throwWrappedUserError("TargetingAttemptCancelled");
      break;
    default:
      throwWrappedUserError("DockingRequestDenied", {
        reason: "Docking request denied.",
      });
      break;
  }
}

class StructureDockingService extends BaseService {
  constructor() {
    super("structureDocking");
  }

  Handle_Dock(args, session) {
    const structureID = normalizePositiveInt(args && args[0], 0);
    const requestedShipID = normalizePositiveInt(args && args[1], 0);
    const activeShipID = getSessionShipID(session);

    log.info(
      `[StructureDocking] Dock char=${session && session.characterID} structure=${structureID} ship=${requestedShipID || activeShipID || 0}`,
    );

    if (requestedShipID > 0 && activeShipID > 0 && requestedShipID !== activeShipID) {
      throwWrappedUserError("DeniedShipChanged");
    }

    const structure = structureState.getStructureByID(structureID, {
      refresh: false,
    });
    if (!structure) {
      throwDockingDenied("STRUCTURE_NOT_FOUND");
    }

    const dockCheck = structureState.canCharacterDockAtStructure(session, structure, {
      shipTypeID: session && session.shipTypeID,
    });
    if (!dockCheck.success) {
      throwDockingDenied(dockCheck.errorMsg);
    }

    if (spaceRuntime.isDockingDisallowedByModules(session)) {
      throwDockingDenied("DOCKING_DISALLOWED_BY_MODULE");
    }

    if (!spaceRuntime.canDockAtStation(session, structureID)) {
      const dockingDebug = spaceRuntime.getDockingDebugState(session, structureID);
      spaceRuntime.followBall(session, structureID, 2500, {
        dockingTargetID: structureID,
      });
      throwDockingDenied("DOCKING_APPROACH_REQUIRED", { dockingDebug });
    }

    const result = spaceRuntime.acceptDocking(session, structureID);
    if (!result || !result.success) {
      throwDockingDenied(result && result.errorMsg);
    }

    return null;
  }

  Handle_Undock(args, session, kwargs) {
    const structureID = normalizePositiveInt(args && args[0], 0);
    const requestedShipID = normalizePositiveInt(args && args[1], 0);
    const activeShipID = getSessionShipID(session);
    const ignoreContraband = Boolean(
      normalizeNumber(getKwargValue(kwargs, "ignoreContraband"), 0),
    );

    log.info(
      `[StructureDocking] Undock char=${session && session.characterID} structure=${structureID} ship=${requestedShipID || activeShipID || 0}`,
    );

    if (
      structureID > 0 &&
      normalizePositiveInt(session && (session.structureID || session.structureid), 0) > 0 &&
      structureID !== normalizePositiveInt(session && (session.structureID || session.structureid), 0)
    ) {
      throwWrappedUserError("DeniedShipChanged");
    }

    if (requestedShipID > 0 && activeShipID > 0 && requestedShipID !== activeShipID) {
      throwWrappedUserError("DeniedShipChanged");
    }

    const result = transitions.undockSession(session, {
      ignoreContraband,
      warnOnContraband: true,
    });
    if (!result || !result.success) {
      if (result && result.errorMsg === "SHIP_CONTRABAND_WARNING_UNDOCK") {
        // structureDocking.py Undock shows this dialog and, on OK, calls
        // Undock again with ignoreContraband set. Nothing has been changed yet.
        log.info(
          `[StructureDocking] Undock held for the contraband warning char=${session && session.characterID}`,
        );
        throwWrappedUserError(
          ...buildUndockContrabandWarningArguments(
            result.data && result.data.contraband,
          ),
        );
      }
      log.warn(
        `[StructureDocking] Undock failed for char=${session && session.characterID}: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}`,
      );
      if (result && result.errorMsg === "STRATEGIC_CRUISER_FIT_INCOMPLETE") {
        throwWrappedUserError("CustomNotify", {
          notify:
            "A strategic cruiser requires a valid Core, Defensive, Offensive, " +
            "and Propulsion subsystem fit before it can undock.",
        });
      }
      return null;
    }

    return null;
  }
}

module.exports = StructureDockingService;
