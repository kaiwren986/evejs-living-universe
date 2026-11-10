"use strict";

const catalog = require("./beltV1Geometry.json");
const originalNativeSource = "74f806cf931de135e2ef4fe1ad2edd2795948bafb4438b815320fb2f8990f520";
const skips = new Map();
if (catalog.version !== 1 || catalog.source.algorithmSha256 !==
    "f54224d744d69d416f9a0c2716f3ad9663f65f007f9739d8203aff3f91096264") {
  throw new Error("BELT_V1_GEOMETRY_AUTHORITY_INVALID");
}
for (const [skip, systems] of Object.entries(catalog.systemsBySkip)) {
  if (!Number.isSafeInteger(Number(skip)) || Number(skip) < 0) throw new Error("BELT_V1_GEOMETRY_AUTHORITY_INVALID");
  for (const systemID of systems) {
    if (!Number.isSafeInteger(systemID) || skips.has(systemID)) throw new Error("BELT_V1_GEOMETRY_AUTHORITY_INVALID");
    skips.set(systemID, Number(skip));
  }
}

function getOriginalGeometryRngSkip(systemID, generation) {
  const knownSource = generation?.source === "native-belt-counts"
    ? generation.sourceSha256 === originalNativeSource
    : generation?.source === "legacy-systemID" && generation.sourceSha256 === null;
  if (generation?.version !== 1 || !knownSource || !skips.has(Number(systemID))) {
    throw new Error(`BELT_V1_GEOMETRY_AUTHORITY_UNKNOWN: ${systemID}`);
  }
  return skips.get(Number(systemID));
}

function getOriginalGeometry(systemID, beltID, generation) {
  const geometryRngSkip = getOriginalGeometryRngSkip(systemID, generation);
  const origin = catalog.beltOriginsBySystemID[String(Number(systemID))]?.find(row => row[0] === Number(beltID));
  if (!origin || !origin.slice(1).every(Number.isFinite) || origin.length !== 4) {
    throw new Error(`BELT_V1_GEOMETRY_AUTHORITY_UNKNOWN: ${systemID}:${beltID}`);
  }
  return { geometryRngSkip, fieldOrigin: { x: origin[1], y: origin[2], z: origin[3] } };
}

module.exports = { getOriginalGeometryRngSkip, getOriginalGeometry };
