"use strict";

const database = require("../../gameStore");
const { PROXY_NODE_ID } = require("../../network/protocolProfile");
const FLEET = require("./fleetConstants");
const sharedIdentity = require("../_shared/identityAllocator");
const BASE = PROXY_NODE_ID * FLEET.NODEID_MOD;
// The supported client binds fleetObjectHandler with the fleetID as opaque
// parameters (eveMoniker.GetFleet / Moniker.__ResolveImpl). Node resolution is
// explicit MachoResolveObject, not fleetID // NODEID_MOD; our bound OID carries
// PROXY_NODE_ID independently. Crossing serial 999 therefore does not reroute.
// Leave room for the default native wing/squad identities created with a fleet.
const MAX_SERIAL = Math.floor((Number.MAX_SAFE_INTEGER - BASE - FLEET.SQUADID_MOD - 1) / FLEET.FLEETID_MOD);

function checked(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "FLEET_IDENTITY_UNAVAILABLE");
  return result.data;
}
function read(table, path) {
  const result = database.read(table, path);
  if (result?.success) return result.data;
  if (["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND", "SQLITE_TABLE_NOT_FOUND"].includes(result?.errorMsg)) return undefined;
  return checked(result);
}
function serialForFleetID(value) {
  if (!Number.isSafeInteger(value) || value <= BASE) return 0;
  // A conservative floor also covers older trusted IDs that did not land on
  // this allocator's exact stride. The next emitted wire ID is above them.
  return Math.floor((value - BASE) / FLEET.FLEETID_MOD);
}

// Old fleets were volatile, but their accepted incursion facts survive restart.
// Adopt those identities before the first upgraded allocation, including health
// outcomes not yet projected into the encounter. Never change their scores or
// reinterpret the membership stored in an already frozen completion.
function retainedFleetSerialHighWaterMark() {
  let high = 0;
  const consider = value => { high = Math.max(high, serialForFleetID(value)); };
  const presence = rows => {
    for (const row of Array.isArray(rows) ? rows : []) consider(row?.fleetID);
  };
  for (const operation of Object.values(read("incursionReplay", "/operations") || {})) {
    for (const facts of Object.values(operation?.contributions || {})) {
      for (const id of Object.keys(facts || {})) consider(Number(id));
    }
    presence(operation?.completion?.presence);
    consider(operation?.completion?.winnerFleetID);
    for (const id of Object.keys(operation?.completion?.fleetDamage || {})) consider(Number(id));
  }
  for (const [table, path] of [["npcEntities", "/incursionOutcomes"], ["items", "/__evejsIncursionCombatOutcomes"]]) {
    for (const receipt of Object.values(read(table, path) || {})) {
      consider(receipt?.event?.fleetID);
      presence(receipt?.event?.completionPresence);
    }
  }
  return high;
}

function reserveFleetSerial(minimumSerial = 1) {
  if (!Number.isSafeInteger(minimumSerial) || minimumSerial < 1) throw new Error("FLEET_IDENTITY_INVALID");
  return sharedIdentity.reserveFleetSerial(Math.max(minimumSerial, retainedFleetSerialHighWaterMark() + 1), MAX_SERIAL);
}

module.exports = { reserveFleetSerial, retainedFleetSerialHighWaterMark, serialForFleetID };
