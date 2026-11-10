"use strict";

// A ship's rack heat as the client is told it: three attributes of the ship,
// and the heat part of the ship's state (GetAllInfo's shipState, ship.Board's
// answer).
//
// Each rack's heat is an attribute of the ship: heatHi (1175), heatMed (1176)
// and heatLow (1177). Tranquility lists the three among a ship's attributes in
// space and docked, 0.0 for a cold rack (every ship its client's godma printed
// as it loaded it has them), and the client builds its racks' heat from them
// (HeatAttribute.__init__). The first of a rack's entry in the state is the
// same number: a Caracal's attributes read 1176: 17.142716090505385 where its
// state's entry does.
//
// Each rack's entry is the ship's own, as the client's shared dogma code builds
// it (shipDogmaItem.GetHeatStates, heatAttribute.GetHeatMessage): the heat the
// rack holds, its capacity, the incoming heat, the ship's heat generation
// multiplier, the rack's dissipation rate and the time. Every state the retail
// client was handed in the recordings agrees with the ship type's attributes: a
// frigate's racks read (0.0, 100.0, 0, 1.0, 0.01, time), a cruiser's
// (0.0, 100.0, 0, 0.75, 0.01, time), a structure's (0.0, 0.0, 0, 1.0, 0.0, time),
// and a Caracal's medium rack sixteen seconds after it stopped heating
// (17.142716090505385, 100.0, 0, 0.75, 0.01, time).

const FILETIME_TICKS_PER_MS = 10000n;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;

const HEAT_ATTRIBUTE_MED = 1176;
const HEAT_ATTRIBUTE_LOW = 1177;
const HEAT_ATTRIBUTE_HI = 1175;
const ATTRIBUTE_HEAT_GENERATION_MULTIPLIER = 1224;
// Each rack's heat attribute beside the ship's attributes for that rack's
// capacity and its dissipation rate, in the order Tranquility's dict prints.
const RACK_HEAT_ATTRIBUTES = Object.freeze([
  Object.freeze({ heatID: HEAT_ATTRIBUTE_MED, capacityID: 1199, dissipationID: 1196 }),
  Object.freeze({ heatID: HEAT_ATTRIBUTE_LOW, capacityID: 1200, dissipationID: 1198 }),
  Object.freeze({ heatID: HEAT_ATTRIBUTE_HI, capacityID: 1178, dissipationID: 1179 }),
]);
// What the static data gives an item that declares none of these: no capacity,
// no dissipation, and a multiplier of 1. A structure is such an item.
const DEFAULT_HEAT_CAPACITY = 0;
const DEFAULT_HEAT_DISSIPATION_RATE = 0;
const DEFAULT_HEAT_GENERATION_MULTIPLIER = 1;

function currentFileTime() {
  return BigInt(Date.now()) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET;
}

// Tranquility's four are floats whatever they hold, and a whole number left
// plain goes out as an integer.
function real(value) {
  return { type: "real", value };
}

function readAttribute(shipAttributes, attributeID, fallback) {
  const value = Number(shipAttributes && shipAttributes[attributeID]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The three heat attributes of a ship, by attribute ID. `rackHeat` is what each
 * rack holds, by the rack's heat attribute ({ heat }); a rack it says nothing
 * of is cold, and so is every rack without it.
 */
function buildShipRackHeatAttributes(rackHeat = null) {
  const worked = {};
  for (const rack of RACK_HEAT_ATTRIBUTES) {
    const heat = Number(rackHeat && rackHeat[rack.heatID] && rackHeat[rack.heatID].heat);
    worked[rack.heatID] = Number.isFinite(heat) && heat > 0 ? heat : 0;
  }
  return worked;
}

function buildRackHeatStateTuple(rack, shipAttributes, rackHeat, timestamp) {
  const held = (rackHeat && rackHeat[rack.heatID]) || null;
  const incomingHeat = Math.max(0, Number(held && held.incomingHeat) || 0);
  return [
    // The ship's own attribute, so that the two are one number.
    real(Math.max(0, readAttribute(shipAttributes, rack.heatID, 0))),
    real(readAttribute(shipAttributes, rack.capacityID, DEFAULT_HEAT_CAPACITY)),
    // The integer 0 where nothing is heating the rack, as Tranquility's prints.
    incomingHeat > 0 ? real(incomingHeat) : 0,
    real(readAttribute(
      shipAttributes,
      ATTRIBUTE_HEAT_GENERATION_MULTIPLIER,
      DEFAULT_HEAT_GENERATION_MULTIPLIER,
    )),
    real(readAttribute(shipAttributes, rack.dissipationID, DEFAULT_HEAT_DISSIPATION_RATE)),
    timestamp,
  ];
}

/**
 * The heat part of a ship's state.
 *
 * `shipAttributes` is the ship's attributes by attribute ID, as the same answer
 * gives them, each rack's heat among them (buildShipRackHeatAttributes).
 * `options.rackHeat` says what is heating each rack, by the rack's heat
 * attribute ({ incomingHeat }), for a ship in space; without it nothing is.
 * `options.timestamp` is the time of the answer.
 */
function buildShipHeatStateDict(shipAttributes, options = {}) {
  const timestamp = options.timestamp === undefined ? currentFileTime() : options.timestamp;
  return {
    type: "dict",
    entries: RACK_HEAT_ATTRIBUTES.map((rack) => [
      rack.heatID,
      buildRackHeatStateTuple(rack, shipAttributes, options.rackHeat || null, timestamp),
    ]),
  };
}

module.exports = {
  buildShipHeatStateDict,
  buildShipRackHeatAttributes,
};
