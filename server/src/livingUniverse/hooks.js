"use strict";

// Living Universe: the only module upstream files require.
//
// Each function is a cheap no-op until the population has started, so a hook in
// a core file costs one range check for ordinary characters and nothing breaks
// when the mod is off. Keep upstream edits to one-line calls into this file.

const PILOT_ID_MIN = 2120000000;
const PILOT_ID_MAX = 2120020000;

function isPilotID(characterID) {
  const id = Number(characterID);
  return id > PILOT_ID_MIN && id <= PILOT_ID_MAX;
}

function universe() {
  return require("./index");
}

/** A character-style record for a pilot, or null for anyone else. */
function pilotRecord(characterID) {
  return isPilotID(characterID) ? universe().getPilotRecord(characterID) : null;
}

/** The [ownerID, ownerName, typeID, gender, ownerNameID] row config.GetMultiOwnersEx returns. */
function ownerRow(characterID) {
  const pilot = pilotRecord(characterID);
  return pilot ? [pilot.characterID, pilot.characterName, pilot.typeID || 1373, pilot.gender ? 1 : 0, null] : null;
}

/** Local chat member entries for the pilots in space in a system (chatRuntime's gateway shape). */
function localMembers(solarSystemID, classification) {
  return universe().listPilotsInSystem(solarSystemID).map((pilot) => ({
    character: { sequential: pilot.characterID },
    corporation: { sequential: pilot.corporationID },
    alliance: pilot.allianceID ? { sequential: pilot.allianceID } : null,
    no_alliance: !pilot.allianceID,
    faction: pilot.warFactionID ? { sequential: pilot.warFactionID } : null,
    no_faction: !pilot.warFactionID,
    classification,
  }));
}

module.exports = { isPilotID, pilotRecord, ownerRow, localMembers };
