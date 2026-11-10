"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveDataDir } = require("../../gameStore/storeRoot");

const SAFE_TABLE_NAME = /^[A-Za-z0-9_]+$/;

function staticJsonTablePath(tableName, options = {}) {
  const normalizedTableName = String(tableName || "").trim();
  if (!SAFE_TABLE_NAME.test(normalizedTableName)) {
    throw new TypeError(`invalid static table name: ${normalizedTableName}`);
  }
  const dataDir = options.dataDir
    ? path.resolve(options.dataDir)
    : resolveDataDir();
  return path.join(dataDir, normalizedTableName, "data.json");
}

function readStaticJsonTable(tableName, options = {}) {
  let filePath;
  try {
    filePath = staticJsonTablePath(tableName, options);
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      throw new SyntaxError("Unexpected end of JSON input");
    }
    return {
      data: JSON.parse(raw),
      filePath,
      success: true,
    };
  } catch (error) {
    return {
      data: null,
      error,
      filePath: filePath || null,
      success: false,
    };
  }
}

module.exports = {
  readStaticJsonTable,
  staticJsonTablePath,
};
