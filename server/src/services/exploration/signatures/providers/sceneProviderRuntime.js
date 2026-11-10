"use strict";

const {
  toInt,
} = require("../../../../common/numbers");

const path = require("path");

function shouldLoadScene(options = {}) {
  return options && (
    options.loadScene === true ||
    options.materializeScene === true
  );
}

function resolveScene(systemID, options = {}) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID <= 0) {
    return null;
  }

  const providedScene = options && options.scene;
  if (
    providedScene &&
    toInt(providedScene.systemID, 0) === numericSystemID
  ) {
    return providedScene;
  }

  const runtime = require(path.join(__dirname, "../../../../space/runtime"));
  if (!runtime || typeof runtime !== "object") {
    return null;
  }

  if (shouldLoadScene(options)) {
    return typeof runtime.ensureScene === "function"
      ? runtime.ensureScene(numericSystemID)
      : null;
  }

  return runtime.scenes instanceof Map
    ? runtime.scenes.get(numericSystemID) || null
    : null;
}

module.exports = {
  resolveScene,
};
