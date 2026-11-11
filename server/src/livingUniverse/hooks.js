"use strict";

// Living Universe: the one module stock files require for pilot identity.
//
// The pilots are the mod's own (server/src/space/npc/ambientTraffic); this file
// is the narrow door stock code uses to ask "is this character one of them, and
// what is its record". Each function is cheap for ordinary characters (one
// range check) and returns nothing while the mod is off, so the edits in stock
// files stay one-line calls.

const PILOT_ID_MIN = 2120000000;
const PILOT_ID_MAX = 2120020000;

function directory() {
  return require("../space/npc/ambientTraffic/livingUniversePilotDirectory");
}

function inPilotRange(characterID) {
  const id = Number(characterID);
  return id > PILOT_ID_MIN && id <= PILOT_ID_MAX;
}

/** A character-style record for a pilot, or null for anyone else. */
function pilotRecord(characterID) {
  return inPilotRange(characterID) ? directory().getPilotRecord(characterID) || null : null;
}

/** True for a character that is currently one of the mod's pilots. */
function isPilotID(characterID) {
  return Boolean(pilotRecord(characterID));
}

/** The [ownerID, ownerName, typeID, gender, ownerNameID] row config.GetMultiOwnersEx returns. */
function ownerRow(characterID) {
  const pilot = pilotRecord(characterID);
  return pilot ? [pilot.characterID, pilot.characterName, pilot.typeID || 1373, pilot.gender ? 1 : 0, null] : null;
}

module.exports = { isPilotID, pilotRecord, ownerRow };
