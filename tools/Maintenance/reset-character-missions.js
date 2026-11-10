#!/usr/bin/env node
"use strict";

/**
 * reset-character-missions.js  (offline maintenance command)
 *
 * Wipe ALL characters' agent-mission runtime state (offered + accepted missions, storyline/epic-arc
 * progress) so every character returns to a clean mission slate. Run this while the server is stopped
 * (the server reads the persisted mission state on boot). Safe to run repeatedly.
 *
 * Direct native usage: node tools/Maintenance/reset-character-missions.js
 * Recommended usage: run ResetMissions.bat in this directory.
 */

const path = require("path");

// Mission state persists in the gameStore-backed missionRuntimeState table; honour the same data dir the
// server uses so the reset writes where the server will read it.
if (!process.env.EVEJS_GAMESTORE_DATA_DIR) {
  process.env.EVEJS_GAMESTORE_DATA_DIR = path.join(
    __dirname,
    "..",
    "..",
    "_local",
    "gameStore",
    "data",
  );
}
// This script is an explicit offline writer. Set the role before the mission
// service can import GameStore transitively.
process.env.EVEJS_GAMESTORE_OWNER_ROLE = "maintenance";

function requireSuccess(result, operation) {
  if (!result || result.success !== true) {
    const error = new Error(
      `${operation} failed: ${result && (
        result.errorMsg || result.code
      ) || "unknown error"}`,
    );
    error.code = result && (result.code || result.errorMsg) ||
      "GAMESTORE_MAINTENANCE_OPERATION_FAILED";
    throw error;
  }
  return result;
}

async function main() {
  let database = null;
  let failure = null;
  let clearedCount = 0;
  try {
    database = require(path.join(
      __dirname,
      "..",
      "..",
      "server",
      "src",
      "gameStore",
    ));
    database.acquirePersistenceOwnerLease({ recover: true });
    const missionRuntimeState = require(path.join(
      __dirname,
      "..",
      "..",
      "server",
      "src",
      "services",
      "agent",
      "missionRuntimeState",
    ));

    requireSuccess(
      missionRuntimeState.mutateState((state) => {
        clearedCount = Object.keys(
          (state && state.charactersByID) || {},
        ).length;
        state.charactersByID = {};
        state.nextMissionSequence = 1;
        return true;
      }),
      "reset mission runtime state",
    );
    requireSuccess(
      database.flushTablesSync(["missionRuntimeState"]),
      "flush mission runtime state",
    );
    const persisted = requireSuccess(
      database.readPersisted("missionRuntimeState", "/"),
      "verify mission runtime state",
    ).data;
    if (
      !persisted ||
      persisted.nextMissionSequence !== 1 ||
      Object.keys(persisted.charactersByID || {}).length !== 0
    ) {
      const error = new Error(
        "durable mission runtime state did not match the requested reset",
      );
      error.code = "GAMESTORE_DURABLE_VERIFICATION_FAILED";
      throw error;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (database) {
      try {
        requireSuccess(
          await database.shutdown("reset-character-missions"),
          "GameStore shutdown",
        );
      } catch (shutdownError) {
        if (failure) {
          const combined = new Error(
            `${failure.message}; GameStore shutdown also failed: ${shutdownError.message}`,
            { cause: failure },
          );
          combined.code = failure.code || shutdownError.code;
          combined.shutdownError = shutdownError;
          failure = combined;
        } else {
          failure = shutdownError;
        }
      }
    }
  }
  if (failure) throw failure;

  process.stdout.write(
    `Reset agent-mission state for ${clearedCount} character(s) - clean slate.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
