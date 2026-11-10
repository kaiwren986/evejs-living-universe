"use strict";

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { createImageEdgeRuntime } = require(path.join(
  __dirname,
  "../../edge/image/imageEdgeRuntime",
));
const { buildCorporationLogoProjection } = require(path.join(
  __dirname,
  "imageRequestResolver",
));

let runtime = null;
let startRequested = false;
let unregisterShutdownHook = null;

function readProjectionTable(tableName) {
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    const error = new Error(
      `image edge could not read ${tableName} for its corporation-logo projection: ` +
        `${result.errorMsg || "READ_FAILED"}`,
    );
    error.code = "IMAGE_EDGE_PROJECTION_READ_FAILED";
    throw error;
  }
  return result.data;
}

function buildCurrentCorporationLogoProjection() {
  const projection = buildCorporationLogoProjection(
    readProjectionTable("factions"),
    readProjectionTable("corporations"),
  );
  if (projection.factionIDs.length === 0) {
    const error = new Error(
      "image edge corporation-logo projection contains no factions",
    );
    error.code = "IMAGE_EDGE_PROJECTION_EMPTY";
    throw error;
  }
  return projection;
}

function getRuntime() {
  if (!runtime) {
    runtime = createImageEdgeRuntime({
      corporationLogoProjectionProvider: buildCurrentCorporationLogoProjection,
    });
  }
  return runtime;
}

module.exports = {
  enabled: true,
  serviceName: "imageServer",
  exec() {
    const owner = getRuntime();
    if (!unregisterShutdownHook) {
      unregisterShutdownHook = database.registerShutdownHook(
        "image-edge",
        () => owner.shutdown(),
      );
    }
    if (!startRequested) {
      startRequested = true;
      void owner.start().then((status) => {
        log.debug(
          `image edge process pid=${status.pid} listening on ` +
            `http://${status.address.host}:${status.address.port}/`,
        );
      }).catch((error) => {
        log.err(`[ImageEdge] startup failed: ${error.message}`);
      });
    }
    return owner;
  },
  __testing: {
    buildCurrentCorporationLogoProjection,
    getRuntime,
  },
};
