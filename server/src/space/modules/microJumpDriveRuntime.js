"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MAX_GROUP_ACTIVE = getAttributeIDByNames("maxGroupActive") || 763;
const ATTRIBUTE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const ATTRIBUTE_MJD_JUMP_RANGE = getAttributeIDByNames("mjdJumpRange") || 2066;
// "range effected by mjfg scoop" — 6000 m on the Command Destroyer generator,
// 10000 m on the capital one.
const ATTRIBUTE_MJFG_RADIUS = getAttributeIDByNames("mjfgRadius") || 2067;
// "The maximum number of ships that can be jumped per activation" — 24 and 50.
// CCP's own patch notes say "25 capsuleer ships" and "50 extra sub-capitals":
// the attribute counts the passengers, the prose counts the boosher too.
const ATTRIBUTE_MJD_SHIP_JUMP_CAP = getAttributeIDByNames("mjdShipJumpCap") || 2832;
// "The maximum number of capital ships that can be jumped per activation" — 4,
// declared only by the Capital Micro Jump Field Generator, and counted
// separately from the sub-capital budget.
const ATTRIBUTE_MJD_CAPITAL_SHIP_JUMP_CAP =
  getAttributeIDByNames("mjdCapitalShipJumpCap") || 5686;
// "determines how long ships are warp scrambled for after having been jumped.
// If set to zero, no warp scrambling will occur. Value is in milliseconds" —
// 5000 on the capital generator and absent everywhere else.
const ATTRIBUTE_MJD_POST_ACTIVATION_SCRAM_DURATION =
  getAttributeIDByNames("mjdPostActivationScramDuration") || 5687;
// "Security status restriction, preventing ships from entering high sec and
// modules from being activated." Both field generators declare it; no plain
// Micro Jump Drive does, which is why Bastion + MJD is a high-sec mission
// staple and booshing is not.
const ATTRIBUTE_DISALLOW_IN_HIGH_SEC = getAttributeIDByNames("disallowInHighSec") || 1970;

const STANDARD_MICRO_JUMP_DRIVE_GROUP_ID = 1189;
const CAPITAL_MICRO_JUMP_DRIVE_GROUP_ID = 4769;
const DEFAULT_STANDARD_MJD_JUMP_DISTANCE_METERS = 100_000;
const DEFAULT_CAPITAL_MJD_JUMP_DISTANCE_METERS = 250_000;

const EFFECT_MICRO_JUMP_DRIVE = "microjumpdrive";
const EFFECT_MICRO_JUMP_PORTAL_DRIVE = "microjumpportaldrive";
const EFFECT_MICRO_JUMP_PORTAL_DRIVE_CAPITAL = "microjumpportaldrivecapital";

// The two field-generator effects are one class in the client
// (BaseMicroJumpPortalDrive declares both effect IDs) and behave identically
// apart from the numbers their types declare.
const MICRO_JUMP_FIELD_EFFECT_NAMES = new Set([
  EFFECT_MICRO_JUMP_PORTAL_DRIVE,
  EFFECT_MICRO_JUMP_PORTAL_DRIVE_CAPITAL,
]);

const MICRO_JUMP_EFFECT_NAMES = new Set([
  EFFECT_MICRO_JUMP_DRIVE,
  ...MICRO_JUMP_FIELD_EFFECT_NAMES,
]);

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function normalizeEffectName(effectRecord) {
  return String(effectRecord && effectRecord.name || "").trim().toLowerCase();
}

function normalizeVectorLike(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const x = toFiniteNumber(value.x, 0);
  const y = toFiniteNumber(value.y, 0);
  const z = toFiniteNumber(value.z, 0);
  const length = Math.sqrt((x * x) + (y * y) + (z * z));
  if (!(length > 0)) {
    return null;
  }
  return { x: x / length, y: y / length, z: z / length };
}

function resolveMicroJumpDistanceMeters(moduleItem, moduleAttributes) {
  const explicitJumpDistance = Math.max(
    0,
    roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_MJD_JUMP_RANGE], 0), 3),
  );
  if (explicitJumpDistance > 0) {
    return explicitJumpDistance;
  }

  const moduleGroupID = toInt(moduleItem && moduleItem.groupID, 0);
  if (moduleGroupID === CAPITAL_MICRO_JUMP_DRIVE_GROUP_ID) {
    return DEFAULT_CAPITAL_MJD_JUMP_DISTANCE_METERS;
  }
  if (moduleGroupID === STANDARD_MICRO_JUMP_DRIVE_GROUP_ID) {
    return DEFAULT_STANDARD_MJD_JUMP_DISTANCE_METERS;
  }
  return DEFAULT_STANDARD_MJD_JUMP_DISTANCE_METERS;
}

// The jump follows where the ship is POINTING, and the heading is fixed the
// moment the module is activated: "During this time, the ship can not
// voluntarily change its direction"
// (https://wiki.eveuniversity.org/Propulsion_equipment), and every module
// description reads "jumps the ship forward 100km in the direction it is
// facing". Both halves matter — reading the live heading at the cycle boundary
// instead let a ship activate pointing one way, turn, and land somewhere else
// entirely.
function resolveMicroJumpHeading(entity, callbacks = {}) {
  const facing = normalizeVectorLike(entity && entity.direction);
  if (facing) {
    return facing;
  }
  const derived = callbacks.getCurrentAlignmentDirection
    ? callbacks.getCurrentAlignmentDirection(entity, entity && entity.direction)
    : null;
  return normalizeVectorLike(derived) || { x: 1, y: 0, z: 0 };
}

function resolveMicroJumpDriveActivation({
  entity = null,
  moduleItem,
  effectRecord,
  chargeItem = null,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  callbacks = {},
} = {}) {
  const effectName = normalizeEffectName(effectRecord);
  if (!MICRO_JUMP_EFFECT_NAMES.has(effectName)) {
    return { matched: false };
  }

  if (!moduleItem || !shipItem) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const moduleAttributes = buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
  );
  if (!moduleAttributes) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const rawDurationMs = toFiniteNumber(
    moduleAttributes[ATTRIBUTE_DURATION],
    moduleAttributes[ATTRIBUTE_SPEED],
  );
  const durationAttributeID =
    toFiniteNumber(moduleAttributes[ATTRIBUTE_DURATION], 0) > 0
      ? ATTRIBUTE_DURATION
      : ATTRIBUTE_SPEED;
  const jumpDistanceMeters = resolveMicroJumpDistanceMeters(
    moduleItem,
    moduleAttributes,
  );
  if (jumpDistanceMeters <= 0) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const isFieldGenerator = MICRO_JUMP_FIELD_EFFECT_NAMES.has(effectName);
  const fieldRadiusMeters = isFieldGenerator
    ? Math.max(0, roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_MJFG_RADIUS], 0), 3))
    : 0;

  if (
    toFiniteNumber(moduleAttributes[ATTRIBUTE_DISALLOW_IN_HIGH_SEC], 0) > 0 &&
    typeof callbacks.isHighSecuritySpace === "function" &&
    callbacks.isHighSecuritySpace(entity) === true
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "MODULE_DISALLOWED_IN_HIGH_SEC",
    };
  }

  return {
    matched: true,
    success: true,
    data: {
      runtimeAttrs: {
        capNeed: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_CAPACITOR_NEED], 0), 6),
        ),
        durationMs: Math.max(1, roundNumber(rawDurationMs, 3)),
        durationAttributeID,
        reactivationDelayMs: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0), 3),
        ),
        maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
        weaponFamily: null,
        attributeOverrides: {
          ...moduleAttributes,
        },
      },
      effectStatePatch: {
        microJumpDriveEffect: true,
        microJumpDistanceMeters: jumpDistanceMeters,
        microJumpHeading: resolveMicroJumpHeading(entity, callbacks),
        microJumpJumpFxGuid: "effects.MicroJumpDriveJump",
        forceFreshAcquireSpecialFxReplay: true,
        suppressStopSpecialFx: true,
        microJumpFieldEffect: isFieldGenerator,
        microJumpFieldRadiusMeters: fieldRadiusMeters,
        microJumpFieldShipCap: isFieldGenerator
          ? Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MJD_SHIP_JUMP_CAP], 0))
          : 0,
        microJumpFieldCapitalShipCap: isFieldGenerator
          ? Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MJD_CAPITAL_SHIP_JUMP_CAP], 0))
          : 0,
        microJumpPostActivationScramMs: isFieldGenerator
          ? Math.max(
            0,
            roundNumber(
              toFiniteNumber(moduleAttributes[ATTRIBUTE_MJD_POST_ACTIVATION_SCRAM_DURATION], 0),
              3,
            ),
          )
          : 0,
      },
    },
  };
}

// Who a Micro Jump Field Generator takes with it. Every rule here is stated by
// the module's own description or by CCP:
//
//   "The micro jump field only affects capsuleer-piloted ships and will not
//    move certain ship types, including; Capital Ships, Freighters, and
//    Industrial Command Ships." (type 37479 description)
//   "Warp scramblers prevent the boosher or its targets from being jumped. Any
//    target that is scrammed will not be jumped."
//    (https://wiki.eveuniversity.org/Propulsion_equipment)
//   "Ships which are in an invulnerable state can't be booshed. Some example
//    states are ... the short invulnerability time enjoyed by a ship which has
//    just dropped out of warp." (same)
//
// The capital generator lifts the hull-class rule for up to
// mjdCapitalShipJumpCap capitals, counted against a separate budget: "This can
// move ships which are in siege! ... The number of capital ships moved is
// counted separately from the non-capital ships."
// (https://www.eveonline.com/news/view/equinox-expansion-notes)
function collectMicroJumpFieldPassengers(scene, entity, effectState, callbacks = {}) {
  const radiusMeters = Math.max(
    0,
    toFiniteNumber(effectState && effectState.microJumpFieldRadiusMeters, 0),
  );
  if (radiusMeters <= 0 || typeof callbacks.listShipEntitiesInRange !== "function") {
    return { passengers: [], skipped: [] };
  }

  const candidates = callbacks.listShipEntitiesInRange(entity, radiusMeters);
  const sourceID = toInt(entity && entity.itemID, 0);
  // Both budgets count only passengers. The boosher itself always moves and is
  // never charged against either, which is how CCP's "25 capsuleer ships"
  // reconciles with the SDE's mjdShipJumpCap of 24.
  let remainingShipBudget = Math.max(
    0,
    toInt(effectState && effectState.microJumpFieldShipCap, 0),
  );
  let remainingCapitalBudget = Math.max(
    0,
    toInt(effectState && effectState.microJumpFieldCapitalShipCap, 0),
  );

  const passengers = [];
  const skipped = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || toInt(candidate.itemID, 0) === sourceID) {
      continue;
    }
    if (candidate.kind !== "ship") {
      skipped.push({ targetID: toInt(candidate.itemID, 0), reason: "notShip" });
      continue;
    }
    // "only affects capsuleer-piloted ships": native NPC hulls carry
    // pilotCharacterID 0, every player ship carries its pilot's characterID.
    if (toInt(candidate.pilotCharacterID, 0) <= 0) {
      skipped.push({ targetID: toInt(candidate.itemID, 0), reason: "notCapsuleer" });
      continue;
    }
    if (
      typeof callbacks.isMicroJumpDriveBlocked === "function" &&
      callbacks.isMicroJumpDriveBlocked(candidate) === true
    ) {
      skipped.push({ targetID: toInt(candidate.itemID, 0), reason: "scram" });
      continue;
    }

    const isCapitalHull =
      typeof callbacks.isCapitalClassShipEntity === "function" &&
      callbacks.isCapitalClassShipEntity(candidate) === true;
    if (isCapitalHull) {
      if (remainingCapitalBudget <= 0) {
        skipped.push({ targetID: toInt(candidate.itemID, 0), reason: "hullClass" });
        continue;
      }
      remainingCapitalBudget -= 1;
    } else {
      if (remainingShipBudget <= 0) {
        skipped.push({ targetID: toInt(candidate.itemID, 0), reason: "shipCap" });
        continue;
      }
      remainingShipBudget -= 1;
    }
    passengers.push(candidate);
  }

  return { passengers, skipped };
}

function buildJumpDestination(position, heading, distanceMeters) {
  return {
    x: toFiniteNumber(position && position.x, 0) + (heading.x * distanceMeters),
    y: toFiniteNumber(position && position.y, 0) + (heading.y * distanceMeters),
    z: toFiniteNumber(position && position.z, 0) + (heading.z * distanceMeters),
  };
}

function broadcastMicroJumpFx(scene, effectState, sourceEntity, jumpedEntity, destination) {
  if (!effectState || !effectState.microJumpJumpFxGuid) {
    return;
  }
  scene.broadcastSpecialFx(
    jumpedEntity.itemID,
    effectState.microJumpJumpFxGuid,
    {
      moduleID: effectState.moduleID,
      moduleTypeID: effectState.typeID,
      start: true,
      active: false,
      duration: 1,
      // MicroJumpDriveJump.__init__ does `self.position = trigger.graphicInfo`
      // and Prepare() spawns a client ball there, so this list is the arrival
      // point the client draws the flash at. A null graphicInfo makes the
      // client log and draw nothing.
      graphicInfo: [
        toFiniteNumber(destination.x, 0),
        toFiniteNumber(destination.y, 0),
        toFiniteNumber(destination.z, 0),
      ],
    },
    jumpedEntity,
  );
}

function executeMicroJumpDriveCycle({
  scene,
  entity,
  effectState,
  nowMs,
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return {
      success: false,
      stopReason: "module",
    };
  }
  if (
    typeof callbacks.isMicroJumpDriveBlocked === "function" &&
    callbacks.isMicroJumpDriveBlocked(entity)
  ) {
    return {
      success: false,
      stopReason: "scram",
      errorMsg: "MICRO_JUMP_DRIVE_BLOCKED",
    };
  }

  // The heading was frozen at activation; fall back to the live one only for
  // effect states created before that field existed (the Mobile Micro Jump Unit
  // path builds a synthetic state of its own).
  const direction =
    normalizeVectorLike(effectState.microJumpHeading) ||
    resolveMicroJumpHeading(entity, callbacks);
  const jumpDistanceMeters = Math.max(
    0,
    toFiniteNumber(effectState.microJumpDistanceMeters, 0),
  );
  const destination = buildJumpDestination(entity.position, direction, jumpDistanceMeters);


  // Passengers are picked off the boosher's PRE-jump position: the field is
  // measured where the generator fires, not where it lands.
  const isFieldGenerator = effectState.microJumpFieldEffect === true;
  const { passengers, skipped } = isFieldGenerator
    ? collectMicroJumpFieldPassengers(scene, entity, effectState, callbacks)
    : { passengers: [], skipped: [] };

  if (callbacks.breakEntityStructureTether) {
    callbacks.breakEntityStructureTether(scene, entity, {
      nowMs,
      reason: "MICRO_JUMP_DRIVE",
    });
  }

  const teleportResult = scene.teleportDynamicEntityToPoint(entity, destination, {
    direction,
  });
  if (!teleportResult || teleportResult.success !== true) {
    return {
      success: false,
      stopReason: "movement",
      errorMsg: teleportResult && teleportResult.errorMsg
        ? teleportResult.errorMsg
        : "DYNAMIC_ENTITY_NOT_FOUND",
    };
  }

  broadcastMicroJumpFx(scene, effectState, entity, entity, destination);

  // Everything the field takes is translated by the SAME displacement vector,
  // which is what preserves the formation: "All ships teleported will retain
  // their movement direction and velocity in the new location."
  const jumpedEntityIDs = [toInt(entity.itemID, 0)];
  const movedPassengers = [];
  for (const passenger of passengers) {
    const passengerDestination = buildJumpDestination(
      passenger.position,
      direction,
      jumpDistanceMeters,
    );
    if (callbacks.breakEntityStructureTether) {
      callbacks.breakEntityStructureTether(scene, passenger, {
        nowMs,
        reason: "MICRO_JUMP_FIELD_GENERATOR",
      });
    }
    const passengerTeleport = scene.teleportDynamicEntityToPoint(
      passenger,
      passengerDestination,
      // A passenger keeps its own heading; only its position moves. The
      // direction has to be passed explicitly — the teleport command hands it
      // straight to normalizeVector, which reads .x off it before its own
      // fallback can apply.
      { direction: passenger.direction },
    );
    if (!passengerTeleport || passengerTeleport.success !== true) {
      skipped.push({
        targetID: toInt(passenger.itemID, 0),
        reason: passengerTeleport && passengerTeleport.errorMsg
          ? passengerTeleport.errorMsg
          : "TELEPORT_FAILED",
      });
      continue;
    }
    movedPassengers.push(passenger);
    jumpedEntityIDs.push(toInt(passenger.itemID, 0));
    broadcastMicroJumpFx(scene, effectState, entity, passenger, passengerDestination);
    if (typeof callbacks.recordOffensiveAggression === "function") {
      callbacks.recordOffensiveAggression(entity, passenger, nowMs);
    }
  }

  // "After the jump completes, all ships moved by the jump are scrammed for 5
  // seconds and unable to be moved again by MJD / MJFG until the effect
  // expires." Declared only by the Capital Micro Jump Field Generator, so a
  // zero here is the sub-capital generator's correct answer, not a gap.
  const postActivationScramMs = Math.max(
    0,
    toFiniteNumber(effectState.microJumpPostActivationScramMs, 0),
  );
  if (
    postActivationScramMs > 0 &&
    typeof callbacks.applyPostMicroJumpWarpScramble === "function"
  ) {
    callbacks.applyPostMicroJumpWarpScramble(
      [entity, ...movedPassengers],
      postActivationScramMs,
      nowMs,
    );
  }

  return {
    success: true,
    data: {
      stopReason: "cycle",
      destination,
      direction,
      jumpedEntityIDs,
      passengers: movedPassengers,
      skipped,
    },
  };
}

module.exports = {
  MICRO_JUMP_EFFECT_NAMES,
  MICRO_JUMP_FIELD_EFFECT_NAMES,
  resolveMicroJumpDriveActivation,
  executeMicroJumpDriveCycle,
  collectMicroJumpFieldPassengers,
};
