"use strict";

// DATA ROOT
//
// Where this install keeps the files the server writes while it runs, so none of them land
// under server/src:
//
//   <dataRoot>/gameStore/   the game store (data, SQLite, content packs)
//   <dataRoot>/logs/        server and diagnostic logs
//   <dataRoot>/certs/       generated TLS certificates and keys
//   <dataRoot>/chat/        chat server data
//   <dataRoot>/images/      generated images
//   <dataRoot>/skinr/       portable SKINR design files
//
// EVEJS_DATA_ROOT sets it; the Docker image sets /var/lib/evejs. The default is <repo>/_local,
// the native install's data folder. This module requires nothing but path, so any writer can
// ask without loading config or the store.

const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEFAULT_DATA_ROOT = path.join(REPO_ROOT, "_local");

const DATA_ROOT_AREAS = Object.freeze({
  gameStore: "gameStore",
  logs: "logs",
  certs: "certs",
  chat: "chat",
  images: "images",
  skinr: "skinr",
});

// The data root: EVEJS_DATA_ROOT resolved against the working directory, else <repo>/_local.
function resolveDataRoot(env = process.env) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  return configured ? path.resolve(configured) : DEFAULT_DATA_ROOT;
}

// A path inside one area of the data root, e.g. resolveDataRootPath("logs", "server.log").
function resolveDataRootPath(area, ...segments) {
  if (!Object.prototype.hasOwnProperty.call(DATA_ROOT_AREAS, area)) {
    throw new Error(
      `unknown data root area "${area}"; expected one of ${Object.keys(DATA_ROOT_AREAS).join(", ")}`,
    );
  }
  return path.join(resolveDataRoot(), DATA_ROOT_AREAS[area], ...segments);
}

module.exports = {
  DATA_ROOT_AREAS,
  DEFAULT_DATA_ROOT,
  REPO_ROOT,
  resolveDataRoot,
  resolveDataRootPath,
};
