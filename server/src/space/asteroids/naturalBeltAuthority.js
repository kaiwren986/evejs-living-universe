"use strict";

const catalogue = require("./naturalBeltComposition.json");

// This native table supplies composition only. It does not describe individual
// rock coordinates, visual shells, radius, ore units or respawn timing.
function getBeltComposition(beltID) {
  const raw = catalogue.countsByBeltID[String(Number(beltID))];
  if (!raw) return null;
  const counts = Object.entries(raw).map(([typeID, count]) => ({ typeID: Number(typeID), count }));
  return {
    version: catalogue.schema,
    sourceSha256: catalogue.source.resourceSha256,
    clientBuild: catalogue.source.clientBuild,
    counts,
    totalCount: counts.reduce((sum, row) => sum + row.count, 0),
  };
}

module.exports = { getBeltComposition };
