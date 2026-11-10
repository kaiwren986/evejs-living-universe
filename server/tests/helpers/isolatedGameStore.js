"use strict";
// Must run before any product import. Never copies or opens the player's store.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createIsolatedGameStore({ activate = true } = {}) {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-crew-test-"));
  const dataDir = path.join(storeRoot, "data");
  fs.mkdirSync(dataDir);
  const attestation = path.join(storeRoot, ".evejs-test-store-attestation.json");
  fs.writeFileSync(attestation, JSON.stringify({ schemaVersion: 1, kind: "evejs-test-store",
    createdBy: "server/tests/helpers/isolatedGameStore.js", storeRoot, dataDir }));
  const env = {
    EVEJS_GAMESTORE_DATA_DIR: dataDir, EVEJS_TEST_STORE_ROOT: storeRoot,
    EVEJS_TEST_STORE_ATTESTATION: attestation, EVEJS_TEST_STORE_ISOLATED: "1",
    EVEJS_GAMESTORE_OWNER_ROLE: "standalone", EVEJS_DATA_ROOT: path.join(storeRoot, "runtime"),
  };
  if (activate) Object.assign(process.env, env);
  function writeStatic(table, data) {
    if (!/^[A-Za-z0-9]+$/.test(table)) throw new Error("Invalid fixture table");
    fs.mkdirSync(path.join(dataDir, table), { recursive: true });
    fs.writeFileSync(path.join(dataDir, table, "data.json"), JSON.stringify(data));
  }
  return { storeRoot, dataDir, env, writeStatic, cleanup() {
    // Delete only this helper's attested, direct temporary-directory child.
    const actual = fs.realpathSync(storeRoot);
    const parent = fs.realpathSync(os.tmpdir());
    const marker = JSON.parse(fs.readFileSync(attestation));
    if (path.dirname(actual) !== parent || !path.basename(actual).startsWith("evejs-crew-test-") ||
        marker.storeRoot !== storeRoot || marker.createdBy !== "server/tests/helpers/isolatedGameStore.js") {
      throw new Error("Refusing cleanup of an unrecognized test store");
    }
    fs.rmSync(actual, { recursive: true });
  } };
}
module.exports = { createIsolatedGameStore };
