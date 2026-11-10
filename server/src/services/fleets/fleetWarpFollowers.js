"use strict";

const crypto = require("crypto");
const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  normalizeNumber,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const fleetRuntime = require(path.join(__dirname, "./fleetRuntime"));
const {
  resolveFormationSettings,
  computeFleetWarpPointLandingPoints,
  computeFleetWarpFormationPoints,
} = require(path.join(__dirname, "./fleetWarpFormation.js"));
const dungeonRuntime = require(path.join(__dirname, "../dungeon/dungeonRuntime"));
const {
  canSessionAccessDungeonInstance,
  isPrivateDungeonInstance,
  normalizeDungeonInstanceID,
} = require(path.join(__dirname, "../dungeon/dungeonVisibilityPolicy"));
const {
  grantAcquiredMissionAccess,
} = require(path.join(__dirname, "../dungeon/missionAccessGrants"));
const {
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));

// The private mission pocket a fleet warp carries its members into: the
// commander's destination instance, when it is private and the commander may
// enter it. A fleet warp shares only a route the commander has; null when
// there is no such pocket.
function resolveCommanderMissionInstanceID(commanderSession, instanceID) {
  const numericInstanceID = normalizeDungeonInstanceID(instanceID);
  if (numericInstanceID === null) {
    return null;
  }
  try {
    const instance = dungeonRuntime.getInstance(numericInstanceID);
    return instance &&
      isPrivateDungeonInstance(instance) &&
      canSessionAccessDungeonInstance(commanderSession, instance)
      ? numericInstanceID
      : null;
  } catch (error) {
    log.warn(
      `[FleetWarp] Fleet warp mission lookup failed instance=${numericInstanceID}: ${error.message}`,
    );
    return null;
  }
}

// Pull the issuing commander's fleet/wing/squad along on a fleet warp. The
// commander has already been warped through the normal path; this warps every
// subordinate member who is in the same solar system and accepts fleet warp to
// the same destination, each computing their own warp-in for their own ship.
function warpFleetFollowers(commanderSession, leaderResult, options = {}) {
  const commanderCharID = normalizeNumber(
    commanderSession &&
      (commanderSession.characterID || commanderSession.charID),
    0,
  );
  if (commanderCharID <= 0) {
    return 0;
  }

  const leaderPendingWarp =
    leaderResult && leaderResult.data && typeof leaderResult.data === "object"
      ? leaderResult.data
      : null;
  // Form the fleet's requested landing plan before individual bubble and
  // immunity checks. A caught commander must not redirect immune members.
  const pendingWarp = leaderPendingWarp && leaderPendingWarp.requested &&
    typeof leaderPendingWarp.requested === "object"
    ? { ...leaderPendingWarp, ...leaderPendingWarp.requested }
    : leaderPendingWarp;
  const targetEntityID = pendingWarp
    ? normalizeNumber(pendingWarp.targetEntityID, 0)
    : 0;
  const rawDestination =
    pendingWarp &&
    pendingWarp.rawDestination &&
    typeof pendingWarp.rawDestination === "object"
      ? pendingWarp.rawDestination
      : null;
  const stopDistance = pendingWarp
    ? normalizeNumber(pendingWarp.stopDistance, 0)
    : 0;
  const destinationDungeonOptions = pendingWarp
    ? {
        ...(pendingWarp.destinationStaticInstanceID !== null &&
        pendingWarp.destinationStaticInstanceID !== undefined
          ? {
              destinationStaticInstanceID:
                pendingWarp.destinationStaticInstanceID,
            }
          : {}),
        ...(String(pendingWarp.destinationDungeonRoomKey || "").trim()
          ? {
              destinationDungeonRoomKey: String(
                pendingWarp.destinationDungeonRoomKey,
              ).trim(),
            }
          : {}),
        ...(pendingWarp.destinationDungeonSiteID !== null &&
        pendingWarp.destinationDungeonSiteID !== undefined
          ? {
              destinationDungeonSiteID:
                pendingWarp.destinationDungeonSiteID,
            }
          : {}),
      }
    : {};
  if (targetEntityID <= 0 && !rawDestination) {
    return 0;
  }

  const minimumRange = normalizeNumber(options.minimumRange, 0);
  const commanderSystemID = normalizeNumber(
    commanderSession &&
      (commanderSession.solarsystemid2 || commanderSession.solarsystemid),
    0,
  );

  let followers = [];
  try {
    followers = fleetRuntime.collectFleetWarpFollowers(commanderCharID) || [];
  } catch (error) {
    log.warn(
      `[FleetWarp] Fleet warp follower lookup failed for char=${commanderCharID}: ${error.message}`,
    );
    return 0;
  }

  // This service's established command scope pulls eligible members in the
  // commander's system; each follower still runs the normal warp checks.
  const eligibleFollowers = followers.filter((follower) => {
    const followerSession = follower && follower.session;
    if (!followerSession) {
      return false;
    }
    const followerSystemID = normalizeNumber(
      followerSession.solarsystemid2 || followerSession.solarsystemid,
      0,
    );
    return !(
      commanderSystemID > 0 &&
      followerSystemID > 0 &&
      followerSystemID !== commanderSystemID
    );
  });

  const sharedMissionInstanceID = resolveCommanderMissionInstanceID(
    commanderSession,
    destinationDungeonOptions.destinationStaticInstanceID,
  );

  const commanderGeneration = commanderSession && commanderSession._space;
  const associationToken =
    leaderResult &&
    leaderResult.success === true &&
    leaderResult.redundant !== true
      ? crypto.randomUUID()
      : "";
  const associationTokenPrefix = associationToken
    ? associationToken.replace(/-/g, "").slice(0, 8)
    : "";
  const landingRotationFraction = associationTokenPrefix
    ? Number.parseInt(associationTokenPrefix, 16) / 0x1_0000_0000
    : 0;
  const formationPoints = resolveFleetWarpFormationPoints(
    commanderSession,
    eligibleFollowers,
    {
      landingRotationFraction,
      pendingWarp,
      leaderWarpJitter: leaderResult && leaderResult.warpJitter,
      formationSettings: options.formationSettings,
    },
  );

  let warpedCount = 0;
  for (const follower of eligibleFollowers) {
    const followerSession = follower.session;
    const followerGeneration = followerSession && followerSession._space;
    const formationPoint = formationPoints.get(
      normalizeNumber(follower.characterID, 0),
    );
    if (sharedMissionInstanceID !== null && !isDockedSession(followerSession)) {
      // The commander's fleet warp is the member's route into the private
      // mission pocket, as a warp to a fleet member is (Beyonce's
      // "fleet_member_warp"), so record it before the member's warp asks
      // whether it may enter. A docked member cannot warp, so the fleet warp
      // is no route for them and grants them nothing.
      grantAcquiredMissionAccess(
        followerSession,
        sharedMissionInstanceID,
        "fleet_warp",
      );
    }

    let followerResult = null;
    if (formationPoint) {
      // The leader already resolved the target geometry. Followers consume
      // that command-scoped landing anchor (or an explicit formation slot)
      // directly instead of independently resolving the target again.
      followerResult = spaceRuntime.warpToPoint(followerSession, formationPoint, {
        ...destinationDungeonOptions,
        stopDistance: 0,
        ...(targetEntityID > 0 ? { targetEntityID } : {}),
      });
    } else if (targetEntityID > 0) {
      followerResult = spaceRuntime.warpToEntity(
        followerSession,
        targetEntityID,
        { ...destinationDungeonOptions, minimumRange },
      );
    } else if (rawDestination) {
      followerResult = spaceRuntime.warpToPoint(followerSession, rawDestination, {
        ...destinationDungeonOptions,
        minimumRange,
        stopDistance,
      });
    }

    if (followerResult && followerResult.success) {
      warpedCount += 1;
      if (associationToken && followerResult.redundant !== true) {
        try {
          spaceRuntime.associateSuccessfulFleetWarpFollower(
            commanderSession,
            followerSession,
            associationToken,
            {
              leaderGeneration: commanderGeneration,
              leaderResult,
              followerGeneration,
              followerResult,
            },
          );
        } catch (error) {
          log.warn(
            `[FleetWarp] Fleet warp association failed for char=${normalizeNumber(
              follower && follower.characterID,
              0,
            )}: ${error.message}`,
          );
        }
      }
      notifyFleetWarpRemoteMessage(followerSession, targetEntityID, commanderCharID);
    }
  }

  if (warpedCount > 0) {
    log.info(
      `[FleetWarp] Fleet warp pulled ${warpedCount} member(s) for commander char=${commanderCharID}` +
        `${formationPoints.size > 0 ? ` with a shared landing plan` : ""}`,
    );
  }
  return warpedCount;
}

// Resolve per-follower landing points around the commander's already-resolved
// landing anchor. Standard POINT/no-settings warps use a compact collision-
// aware cloud; explicit offset formations retain their requested geometry.
// The commander's landing is jittered like every warp; the anchor is that
// landing before its jitter (`context.leaderWarpJitter`, the offset its
// warpToPoint reports), since each member's own warp jitters again.
function resolveFleetWarpFormationPoints(commanderSession, followers, context = {}) {
  const empty = new Map();
  const settings = resolveFormationSettings(context.formationSettings);
  const pendingWarp = context.pendingWarp || null;
  const leaderWarpJitter = context.leaderWarpJitter || null;
  const anchorPoint =
    pendingWarp &&
    pendingWarp.targetPoint &&
    typeof pendingWarp.targetPoint === "object"
      ? {
          x: normalizeNumber(pendingWarp.targetPoint.x, 0) -
            normalizeNumber(leaderWarpJitter && leaderWarpJitter.x, 0),
          y: normalizeNumber(pendingWarp.targetPoint.y, 0) -
            normalizeNumber(leaderWarpJitter && leaderWarpJitter.y, 0),
          z: normalizeNumber(pendingWarp.targetPoint.z, 0) -
            normalizeNumber(leaderWarpJitter && leaderWarpJitter.z, 0),
        }
      : null;
  if (!anchorPoint || followers.length === 0) {
    return empty;
  }

  const scene = spaceRuntime.getSceneForSession(commanderSession);
  const getShipEntity =
    scene && typeof scene.getShipEntityForSession === "function"
      ? (targetSession) => scene.getShipEntityForSession(targetSession)
      : null;

  const commanderEntity = getShipEntity ? getShipEntity(commanderSession) : null;
  const commanderPosition = commanderEntity && commanderEntity.position;
  const warpDirection = commanderPosition
    ? {
        x: normalizeNumber(anchorPoint.x, 0) - normalizeNumber(commanderPosition.x, 0),
        y: normalizeNumber(anchorPoint.y, 0) - normalizeNumber(commanderPosition.y, 0),
        z: normalizeNumber(anchorPoint.z, 0) - normalizeNumber(commanderPosition.z, 0),
      }
    : null;

  // Stable slot order so a member always lands in the same formation slot.
  const orderedFollowers = followers
    .map((follower) => {
      const followerEntity = getShipEntity
        ? getShipEntity(follower.session)
        : null;
      return {
        characterID: normalizeNumber(follower.characterID, 0),
        position: followerEntity && followerEntity.position,
        radius: normalizeNumber(followerEntity && followerEntity.radius, 0),
      };
    })
    .sort((left, right) => left.characterID - right.characterID);

  if (!settings || settings.formationType === 0) {
    return computeFleetWarpPointLandingPoints({
      anchorPoint,
      anchorRadius: normalizeNumber(commanderEntity && commanderEntity.radius, 0),
      warpDirection,
      followers: orderedFollowers,
      rotationFraction: normalizeNumber(context.landingRotationFraction, 0),
    });
  }

  return computeFleetWarpFormationPoints({
    anchorPoint,
    warpDirection,
    anchorPosition: commanderPosition,
    formationType: settings.formationType,
    spacingMeters: settings.spacingMeters,
    sizeMeters: settings.sizeMeters,
    followers: orderedFollowers,
  });
}

// eveexceptions.const.UE_OWNERID: the client formats (UE_OWNERID, ownerID) as
// the owner's name.
const UE_OWNERID = 2;

// Tell a pulled member's client a fleet warp is in progress so it cancels its
// local autopilot navigation and updates the warp-destination cache
// (spaceMgr/autopilot OnRemoteMessage('FleetWarp') handlers in the client).
// The client also shows the FleetWarp message, "Following {leader} in warp",
// and names the leader from (UE_OWNERID, characterID) (eveCfg.__prepdict); a
// plain JS array marshals as that tuple.
function notifyFleetWarpRemoteMessage(session, celestialID, leaderCharID) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  const entries = [];
  if (normalizeNumber(celestialID, 0) > 0) {
    entries.push(["celestialID", normalizeNumber(celestialID, 0)]);
  }
  if (normalizeNumber(leaderCharID, 0) > 0) {
    entries.push(["leader", [UE_OWNERID, normalizeNumber(leaderCharID, 0)]]);
  }
  const warpInfoDict = { type: "dict", entries };
  try {
    session.sendNotification("OnRemoteMessage", "clientID", [
      "FleetWarp",
      warpInfoDict,
    ]);
  } catch (error) {
    log.warn(
      `[FleetWarp] Fleet warp remote message failed for char=${session && session.characterID}: ${error.message}`,
    );
  }
}

module.exports = {
  warpFleetFollowers,
};
