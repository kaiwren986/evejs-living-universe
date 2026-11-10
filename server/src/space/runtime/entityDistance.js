"use strict";

module.exports = {
  getEntityCenterDistance,
  getEntitySurfaceDistance,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  getEntitySurfaceDistance: getDestinyEntitySurfaceDistance,
} = require(path.join(runtimeEntryDirname, "./destiny/projection/range.js"));
const {
  distance,
} = require("../../common/vector");

function getEntityCenterDistance(sourceEntity, targetEntity) {
  if (!sourceEntity || !targetEntity) {
    return Number.POSITIVE_INFINITY;
  }
  return distance(sourceEntity.position, targetEntity.position);
}

function getEntitySurfaceDistance(sourceEntity, targetEntity) {
  return getDestinyEntitySurfaceDistance(sourceEntity, targetEntity);
}
