"use strict";

// "What kind of Abyssal thing is this inventory item, and which run owns it?"
//
// Five closely-related classifiers lived inline in space/runtime.js. They all do
// the same thing - parse an item's custom info and look for an evejsAbyssal*
// marker - so they are collected here as one coherent concern.
//
// PURITY: the item-custom-info parser is injected rather than imported, because
// it is generic inventory plumbing that lives in space/runtime.js today. That
// keeps this module free of any dependency on the runtime, so it stays out of the
// space/runtime <-> abyssal cycle. resolveEntityInteractionScope is imported
// directly - it is a leaf module under space/destiny with no onward imports.

const path = require("path");

const {
  resolveEntityInteractionScope,
} = require("../../space/destiny/identity/interactionScope.js");

// Filament traces are identified by group as well as by marker, because a trace
// that has never been deployed carries no custom info yet. Mirrors
// GROUP_FILAMENT_TRACE in abyssalMgrService and groupID in abyssalTraceProfiles.
const GROUP_FILAMENT_TRACE = 1991;

// Runtime artifacts are all shaped the same way: one marker key, one kind label.
// Order matters - the first match wins, matching the original if-chain.
const RUNTIME_ARTIFACT_MARKERS = Object.freeze([
  ["evejsAbyssalRewardCache", "reward_cache"],
  ["evejsAbyssalExtractionNode", "extraction_node"],
  ["evejsAbyssalEnvironmentalObject", "environmental_object"],
  ["evejsAbyssalJettisonContainer", "jettison_container"],
]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function positiveInt(value) {
  return Math.max(0, toInt(value, 0));
}

function readMarker(parsed, key) {
  return parsed && parsed[key] && typeof parsed[key] === "object" ? parsed[key] : null;
}

function createAbyssalInventoryClassifier({ parseInventoryCustomInfo }) {
  if (typeof parseInventoryCustomInfo !== "function") {
    throw new TypeError(
      "createAbyssalInventoryClassifier requires a parseInventoryCustomInfo function",
    );
  }

  // A pocket marker is explicitly NOT a trace, even though a trace item can carry
  // both markers during a transition. The marker check has to come first.
  function isInventoryAbyssalTrace(item) {
    if (!item) {
      return false;
    }
    const parsed = parseInventoryCustomInfo(item);
    if (readMarker(parsed, "evejsAbyssalPocketMarker")) {
      return false;
    }
    if (readMarker(parsed, "evejsAbyssalTrace")) {
      return true;
    }
    return toInt(item.groupID, 0) === GROUP_FILAMENT_TRACE;
  }

  function getInventoryAbyssalPocketMarkerInfo(item) {
    return item ? readMarker(parseInventoryCustomInfo(item), "evejsAbyssalPocketMarker") : null;
  }

  function getInventoryAbyssalPlayerCompanionInfo(item) {
    return item
      ? readMarker(parseInventoryCustomInfo(item), "evejsAbyssalPlayerCompanion")
      : null;
  }

  function getInventoryAbyssalRuntimeArtifactInfo(item) {
    if (!item) {
      return null;
    }
    const parsed = parseInventoryCustomInfo(item);
    for (const [markerKey, kind] of RUNTIME_ARTIFACT_MARKERS) {
      const info = readMarker(parsed, markerKey);
      if (info) {
        return { kind, info };
      }
    }
    return null;
  }

  // Precedence: player companion, then pocket marker, then runtime artifact.
  function resolveTaggedOwnership(item) {
    const companionInfo = getInventoryAbyssalPlayerCompanionInfo(item);
    if (companionInfo) {
      const instanceID = positiveInt(companionInfo.instanceID);
      return {
        instanceID,
        roomIndex: positiveInt(companionInfo.roomIndex),
        kind: "player_companion",
        // Companions always carry an explicit invalid flag; the other kinds only
        // gain one when their instance is missing. Preserved as-is.
        invalid: Boolean(companionInfo.invalid === true || instanceID <= 0),
      };
    }

    const markerInfo = getInventoryAbyssalPocketMarkerInfo(item);
    if (markerInfo) {
      const instanceID = positiveInt(markerInfo.instanceID);
      return {
        instanceID,
        roomIndex: positiveInt(markerInfo.roomIndex),
        kind: "pocket_marker",
        ...(instanceID <= 0 ? { invalid: true } : {}),
      };
    }

    const artifact = getInventoryAbyssalRuntimeArtifactInfo(item);
    if (artifact && artifact.info) {
      const instanceID = positiveInt(artifact.info.instanceID);
      return {
        instanceID,
        roomIndex: positiveInt(artifact.info.roomIndex),
        kind: artifact.kind,
        ...(instanceID <= 0 ? { invalid: true } : {}),
      };
    }

    return null;
  }

  // A persisted interaction scope can supply ownership the markers lack, but a
  // disagreement between the two is treated as invalid rather than resolved -
  // acting on a contested item would touch the wrong run.
  function getInventoryAbyssalRunOwnership(item) {
    const ownership = resolveTaggedOwnership(item);
    const persistedScope = resolveEntityInteractionScope(item);
    if (!persistedScope.hasAbyssalScope && !persistedScope.hasAbyssalRoomScope) {
      return ownership;
    }

    const scopedInstanceID = positiveInt(persistedScope.abyssalInstanceID);
    const scopedRoomIndex = positiveInt(persistedScope.abyssalRoomIndex);
    const conflictsWithTaggedOwnership = Boolean(
      ownership && (
        (ownership.instanceID > 0 && scopedInstanceID > 0 &&
          ownership.instanceID !== scopedInstanceID) ||
        (ownership.roomIndex > 0 && scopedRoomIndex > 0 &&
          ownership.roomIndex !== scopedRoomIndex)
      ),
    );

    return {
      instanceID: ownership && ownership.instanceID > 0 ? ownership.instanceID : scopedInstanceID,
      roomIndex: ownership && ownership.roomIndex > 0 ? ownership.roomIndex : scopedRoomIndex,
      kind: ownership && ownership.kind ? ownership.kind : "player_launched_entity",
      invalid: Boolean(
        ownership && ownership.invalid === true ||
        persistedScope.valid !== true ||
        conflictsWithTaggedOwnership
      ),
    };
  }

  return {
    isInventoryAbyssalTrace,
    getInventoryAbyssalPocketMarkerInfo,
    getInventoryAbyssalPlayerCompanionInfo,
    getInventoryAbyssalRuntimeArtifactInfo,
    getInventoryAbyssalRunOwnership,
  };
}

module.exports = {
  GROUP_FILAMENT_TRACE,
  RUNTIME_ARTIFACT_MARKERS,
  createAbyssalInventoryClassifier,
};
