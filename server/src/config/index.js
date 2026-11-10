"use strict";

const path = require("path");
const definitions = require("./schema");
const { createConfigManager } = require("./manager");

module.exports = createConfigManager({
  rootDir: path.resolve(__dirname, "../../.."),
  schemaDefinitions: definitions,
});
