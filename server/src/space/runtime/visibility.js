"use strict";

// Pure visibility helpers. Visibility itself is Grid bubble membership
// (scene/visibility.js); what is left here is the partition box key, the
// cloak ownership rule, and the classes of static Ball the initial ballpark
// bootstrap sends after SetState.

module.exports = {
  buildPublicGridKey,
  canSessionSeeCloakedEntity,
  getPublicGridAxisIndex,
  isBootstrapSiteStaticVisibilityEntity,
  isDedicatedSiteStaticVisibilityEntity,
  isIncrementalStaticVisibilityEntity,
  isOwnerLaunchedMissileVisibleToSession,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  GRID_BUBBLE_BOX_METERS: PUBLIC_GRID_BOX_METERS,
} = require(path.join(runtimeEntryDirname, "./destiny/visibility/gridBubbles.js"));
const {
  sessionMatchesIdentity,
} = require("./sessionIdentity");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  cloneVector,
} = require("../../common/vector");

function getPublicGridAxisIndex(value) {
  return Math.floor(toFiniteNumber(value, 0) / PUBLIC_GRID_BOX_METERS);
}

function buildPublicGridKeyFromIndices(xIndex, yIndex, zIndex) {
  return `${toInt(xIndex, 0)}:${toInt(yIndex, 0)}:${toInt(zIndex, 0)}`;
}

function buildPublicGridKey(position) {
  const resolvedPosition = cloneVector(position);
  return buildPublicGridKeyFromIndices(
    getPublicGridAxisIndex(resolvedPosition.x),
    getPublicGridAxisIndex(resolvedPosition.y),
    getPublicGridAxisIndex(resolvedPosition.z),
  );
}

function isOwnerLaunchedMissileVisibleToSession(session, entity) {
  if (!session || !session._space || !entity || entity.kind !== "missile") {
    return false;
  }
  return toInt(entity.sourceShipID, 0) === toInt(session._space.shipID, 0);
}

function isBubbleScopedStaticEntity(entity) {
  return entity && entity.staticVisibilityScope === "bubble";
}

function isPublicGridScopedStaticEntity(entity) {
  if (!entity) {
    return false;
  }
  const scope = String(entity.staticVisibilityScope || "").trim().toLowerCase();
  return scope === "grid" || scope === "publicgrid" || scope === "public_grid";
}

function isSiteWideStaticVisibilityEntity(entity) {
  return Boolean(
    entity &&
    entity.dungeonMaterializedSiteContent === true &&
    String(entity.staticVisibilityScope || "").trim().toLowerCase() === "site"
  );
}

function isIncrementalStaticVisibilityEntity(entity) {
  return (
    isBubbleScopedStaticEntity(entity) ||
    isPublicGridScopedStaticEntity(entity) ||
    isSiteWideStaticVisibilityEntity(entity)
  );
}

function isDedicatedSiteStaticVisibilityEntity(entity) {
  return (
    entity &&
    entity.dungeonMaterializedSiteContent === true &&
    isBubbleScopedStaticEntity(entity)
  );
}

function isBootstrapSiteStaticVisibilityEntity(entity) {
  return (
    isDedicatedSiteStaticVisibilityEntity(entity) ||
    isSiteWideStaticVisibilityEntity(entity)
  );
}

function canSessionSeeCloakedEntity(session, entity) {
  if (!session || !session._space || !entity) {
    return false;
  }
  const entityID = toInt(entity && entity.itemID, 0);
  if (entityID <= 0) {
    return false;
  }
  if (toInt(session._space.shipID, 0) === entityID) {
    return true;
  }
  return Boolean(entity.session && sessionMatchesIdentity(session, entity.session));
}
