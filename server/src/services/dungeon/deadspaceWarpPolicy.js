"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

// Deadspace (mission-pocket) warp restriction — TQ parity.
//
// Real EVE deadspace does not let a pilot warp between pockets: acceleration gates are the only
// way in and between rooms, and warping to a fleet member/bookmark/celestial *inside* the same
// complex "does not engage the warp drive". Warping OUT (to a real celestial/station/gate) is
// always allowed. This module enforces both halves so gates actually matter:
//
//   (A) In-pocket restriction: while the ship is inside a dungeon site, block any player warp
//       whose destination lies within that site's spatial region — EXCEPT the gate transit
//       itself (flagged via options.dungeonGateTransit) and warps out (destination far from the
//       site). This blocks room-to-room warps and gate-skipping.
//   (B) Warp-in redirect: a warp from OUTSIDE toward a gated dungeon site (e.g. a fleet member
//       deep in a mission pocket) is redirected to the first-room acceleration gate. Ungated
//       sites remain directly warpable.
//
// Spatial model (parity shortcut, per the "shortcuts OK" latitude): a dungeon site occupies a
// sphere of radius DEADSPACE_SITE_RADIUS_METERS around the instance's anchor position. Mission
// pockets sit ~5.5e9 m off a celestial while their rooms span only ~3e7 m from the anchor, so a
// ~1e9 m (≈0.0067 AU) radius contains every room yet excludes the parent celestial and unrelated
// grids. Landmark/scenery sites are open-space destinations, not deadspace pockets, and therefore
// do not participate. No new spatial index; uses the ship's dungeonCurrent* fields + dungeonRuntime
// instances.

const path = require("path");

// Radius around a dungeon instance anchor that counts as "inside the site".
const DEADSPACE_SITE_RADIUS_METERS = 1_000_000_000; // ~0.0067 AU

function pointFromVector(vector) {
  if (!vector) {
    return null;
  }
  if (Array.isArray(vector)) {
    return { x: toFiniteNumber(vector[0], 0), y: toFiniteNumber(vector[1], 0), z: toFiniteNumber(vector[2], 0) };
  }
  if (typeof vector === "object") {
    return { x: toFiniteNumber(vector.x, 0), y: toFiniteNumber(vector.y, 0), z: toFiniteNumber(vector.z, 0) };
  }
  return null;
}

function distanceMeters(a, b) {
  if (!a || !b) {
    return Infinity;
  }
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function requireDungeonRuntime() {
  try {
    return require(path.join(__dirname, "../../services/dungeon/dungeonRuntime"));
  } catch (_error) {
    // ignored: the dungeon runtime is not loaded in this process; null means no dungeon checks
    return null;
  }
}

// The in-space anchor of a dungeon instance (the site position the rooms are placed around).
function resolveInstanceAnchor(instance) {
  if (!instance) {
    return null;
  }
  const anchor = pointFromVector(instance.position);
  if (anchor) {
    return anchor;
  }
  const metadataPosition =
    instance.metadata && instance.metadata.position ? pointFromVector(instance.metadata.position) : null;
  return metadataPosition;
}

// Static landmarks are open-space scenery, even though the site adapter represents them as
// dungeon runtime instances for scanner/materialization parity. Giving them a deadspace capture
// sphere can hijack warps to nearby celestials or stations.
function usesDeadspaceWarpRestriction(instance) {
  if (!instance) {
    return false;
  }
  const siteFamily = String(instance.siteFamily || "").trim().toLowerCase();
  const siteKind = String(instance.siteKind || "").trim().toLowerCase();
  return siteFamily !== "landmark" && siteKind !== "static";
}

// Is a destination point inside a dungeon instance's site region?
function isPointInsideInstance(point, instance) {
  const anchor = resolveInstanceAnchor(instance);
  if (!point || !anchor) {
    return false;
  }
  return distanceMeters(point, anchor) <= DEADSPACE_SITE_RADIUS_METERS;
}

// Evaluate a warp against the deadspace policy.
// Returns one of:
//   { action: "allow" }                              — no restriction applies
//   { action: "block", errorMsg }                    — reject the warp
//   { action: "clamp", point, ...dungeonContext }    — redirect the warp to the entry gate
//
// options.dungeonGateTransit === true bypasses the in-pocket block (the gate warp itself).
function evaluateDeadspaceWarp(entity, destinationPoint, options = {}) {
  const point = pointFromVector(destinationPoint);
  if (!entity || !point) {
    return { action: "allow" };
  }
  if (options.dungeonGateTransit === true || options.ignoreDeadspaceWarpRestriction === true) {
    return { action: "allow" };
  }
  // Deadspace warp rules apply to capsuleer ships only. NPC warps (mining fleets, belt rats,
  // response squads) route through the same warpToPoint and must never be clamped/blocked.
  if (entity.nativeNpc === true || entity.npc === true || entity.kind !== "ship") {
    return { action: "allow" };
  }

  const dungeonRuntime = requireDungeonRuntime();
  const currentInstanceID = Math.max(0, toInt(entity.dungeonCurrentInstanceID, 0));

  // (A) Ship is inside a pocket — block warps that stay inside the same site.
  if (currentInstanceID > 0 && dungeonRuntime && typeof dungeonRuntime.getInstance === "function") {
    const instance = dungeonRuntime.getInstance(currentInstanceID);
    if (usesDeadspaceWarpRestriction(instance) && isPointInsideInstance(point, instance)) {
      return {
        action: "block",
        errorMsg: "DunCannotWarpWithinComplex",
        siteInstanceID: currentInstanceID,
      };
    }
    // destination outside the current site → a warp OUT → allowed (fall through to clamp check for
    // a *different* site, though that is rare from inside a pocket).
  }

  // (B) Warp-in clamp: destination lands inside a dungeon site the ship is NOT currently in.
  if (dungeonRuntime && typeof dungeonRuntime.listActiveInstancesBySystem === "function") {
    const systemID = Math.max(0, toInt(entity.systemID, 0));
    if (systemID > 0) {
      let containing = null;
      try {
        const instances = dungeonRuntime.listActiveInstancesBySystem(systemID, { full: true }) || [];
        for (const instance of instances) {
          if (Math.max(0, toInt(instance && instance.instanceID, 0)) === currentInstanceID) {
            continue;
          }
          if (!usesDeadspaceWarpRestriction(instance)) {
            continue;
          }
          if (isPointInsideInstance(point, instance)) {
            containing = instance;
            break;
          }
        }
      } catch (_error) {
        containing = null;
      }
      if (containing) {
        let entryWarpTarget = null;
        if (typeof options.resolveDungeonEntryWarpTarget === "function") {
          try {
            entryWarpTarget = options.resolveDungeonEntryWarpTarget(containing);
          } catch (_error) {
            return {
              action: "block",
              errorMsg: "DUNGEON_ENTRY_WARP_TARGET_UNAVAILABLE",
              siteInstanceID: Math.max(0, toInt(containing.instanceID, 0)),
            };
          }
        }
        const warpInPoint = pointFromVector(
          entryWarpTarget && entryWarpTarget.point,
        );
        if (warpInPoint) {
          return {
            action: "clamp",
            point: warpInPoint,
            siteInstanceID: Math.max(0, toInt(containing.instanceID, 0)),
            destinationDungeonRoomKey: String(
              entryWarpTarget.destinationDungeonRoomKey || "",
            ).trim() || null,
            destinationDungeonSiteID:
              entryWarpTarget.destinationDungeonSiteID ?? null,
            targetEntityID: entryWarpTarget.targetEntityID ?? null,
          };
        }
      }
    }
  }

  return { action: "allow" };
}

// Legacy deterministic site anchor retained for callers that need the spatial
// origin. Incoming player warps no longer use it as a substitute for a gate.
function resolveSiteWarpInPoint(instance) {
  return resolveInstanceAnchor(instance);
}

module.exports = {
  DEADSPACE_SITE_RADIUS_METERS,
  evaluateDeadspaceWarp,
  isPointInsideInstance,
  resolveInstanceAnchor,
  resolveSiteWarpInPoint,
};
