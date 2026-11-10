"use strict";

module.exports = {
  applyPostMicroJumpWarpScramble,
  hasPostMicroJumpWarpScramble,
  isCapitalClassShipEntity,
  isEntityMicroJumpDriveBlocked,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  getTypeDogmaAttributeValueByID,
} = require("./typeAttributeLookup");

// A Micro Jump Field Generator will not move "Capital Ships, Freighters, and
// Industrial Command Ships" (type 37479's own description), and the Capital
// Micro Jump Field Generator counts capitals against a separate budget
// (attribute 5686). `isCapitalSize` (1785) is the SDE's own declaration of the
// first two: cross-tabbed across every published ship type it selects exactly
// 56 hulls — Titan, Supercarrier, Carrier, Command Carrier, Dreadnought, Lancer
// Dreadnought, Force Auxiliary, Capital Industrial Ship, Freighter and Jump
// Freighter — which is the whole capital + freighter set and nothing else.
//
// The Orca and Porpoise are the one part of the description the SDE does not
// cover: group 941 Industrial Command Ship declares no isCapitalSize and shares
// no other attribute with the 56 (checked by intersecting their attribute maps
// against a Myrmidon, Merlin, Bifrost, Machariel, Paladin, Scimitar and
// Coercer — the intersection is empty). The group is named in the module
// description, has exactly two published members, and there is no data-driven
// alternative, so it is listed here rather than guessed at.
const ATTRIBUTE_IS_CAPITAL_SIZE = getAttributeIDByNames("isCapitalSize") || 1785;

const GROUP_INDUSTRIAL_COMMAND_SHIP = 941;

function isCapitalClassShipEntity(entity) {
  if (!entity || entity.kind !== "ship") {
    return false;
  }
  if (toInt(entity.groupID, 0) === GROUP_INDUSTRIAL_COMMAND_SHIP) {
    return true;
  }
  return toFiniteNumber(
    getTypeDogmaAttributeValueByID(
      toInt(entity.typeID, 0),
      ATTRIBUTE_IS_CAPITAL_SIZE,
      0,
    ),
    0,
  ) > 0;
}

// "After the jump completes, all ships moved by the jump are scrammed for 5
// seconds and unable to be moved again by MJD / MJFG until the effect expires."
// (https://www.eveonline.com/news/view/equinox-expansion-notes). Only the
// Capital Micro Jump Field Generator declares mjdPostActivationScramDuration,
// so only it applies this.
//
// It is deliberately NOT routed through hostileModuleRuntime's incoming-effect
// aggregate: that state is rebuilt from live module effect states every time it
// recomputes, and this scramble has no module behind it. A timestamp on the
// entity is read by the two gates that matter — warping and being booshed
// again — and expires on its own.
function applyPostMicroJumpWarpScramble(scene, entities, durationMs, nowMs) {
  const normalizedDurationMs = Math.max(0, toFiniteNumber(durationMs, 0));
  if (normalizedDurationMs <= 0) {
    return 0;
  }
  const startMs = toFiniteNumber(
    nowMs,
    scene && typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : Date.now(),
  );
  const untilMs = startMs + normalizedDurationMs;
  let applied = 0;
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity || entity.kind !== "ship") {
      continue;
    }
    entity.postMicroJumpScrambleUntilMs = Math.max(
      toFiniteNumber(entity.postMicroJumpScrambleUntilMs, 0),
      untilMs,
    );
    applied += 1;
  }
  return applied;
}

function hasPostMicroJumpWarpScramble(entity, nowMs = Date.now()) {
  return toFiniteNumber(entity && entity.postMicroJumpScrambleUntilMs, 0) >
    toFiniteNumber(nowMs, Date.now());
}

// A warp scrambler blocks a Micro Jump Drive and a warp disruptor does not —
// that split lives in hostileModuleRuntime's `scram` definition. The capital
// field generator's post-jump scramble has to answer the same question
// ("unable to be moved again by MJD / MJFG until the effect expires"), so both
// sources are read here and every gate uses this rather than the bare
// hostile-module predicate.
function isEntityMicroJumpDriveBlocked(entity, nowMs = Date.now()) {
  return (
    require("../../services/spaceComponents/shipLinkRestrictions").blocksShipAction(entity, "blocksMicroJump") ||
    hostileModuleRuntime.isMicroJumpDriveBlocked(entity) ||
    hasPostMicroJumpWarpScramble(entity, nowMs)
  );
}

Object.assign(module.exports, {
  ATTRIBUTE_IS_CAPITAL_SIZE,
  GROUP_INDUSTRIAL_COMMAND_SHIP,
});
