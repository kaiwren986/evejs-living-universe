"use strict";
module.exports = [
  { key: "crewRefiningCycleMs", defaultValue: 30000, envVar: "EVEJS_CREW_REFINING_CYCLE_MS", envType: "number", valueType: "number",
    integer: true, minValue: 1000, maxValue: 3600000, description: ["Time spent refining one reserved ore stack."], validValues: "Integer milliseconds from 1000 to 3600000." },
  { key: "crewRefiningBatchM3", defaultValue: 1000, envVar: "EVEJS_CREW_REFINING_BATCH_M3", envType: "number", valueType: "number",
    integer: true, minValue: 1, maxValue: 1000, description: ["Largest whole ore stack accepted by an automated refining crew."], validValues: "Integer cubic metres from 1 to 1000." },
  { key: "crewMiningTravelMs", defaultValue: 30000, envVar: "EVEJS_CREW_MINING_TRAVEL_MS", envType: "number", valueType: "number",
    integer: true, minValue: 1000, maxValue: 3600000, description: ["Travel time between a mining crew's home station and a belt in the same system."], validValues: "Integer milliseconds from 1000 to 3600000." },
  { key: "crewMiningCycleMs", defaultValue: 60000, envVar: "EVEJS_CREW_MINING_CYCLE_MS", envType: "number", valueType: "number",
    integer: true, minValue: 1000, maxValue: 3600000, description: ["Time spent extracting one mining crew load from a finite rock."], validValues: "Integer milliseconds from 1000 to 3600000." },
  { key: "crewMiningBatchM3", defaultValue: 100, envVar: "EVEJS_CREW_MINING_BATCH_M3", envType: "number", valueType: "number",
    integer: true, minValue: 1, maxValue: 1000, description: ["Mining crew hold size. Each load fits a courier's 1000 cubic metre hold."], validValues: "Integer cubic metres from 1 to 1000." },
  { key: "crewOperationsEnabled", defaultValue: false, envVar: "EVEJS_CREW_OPERATIONS_ENABLED",
    envType: "boolean", valueType: "boolean", description: ["Enable persistent courier/mining crews and X-Command orders. Mining also requires miningEnabled and asteroidFieldsEnabled."], validValues: "true or false." },
  { key: "crewTravelLegMs", defaultValue: 30000, envVar: "EVEJS_CREW_TRAVEL_LEG_MS", envType: "number", valueType: "number",
    integer: true, minValue: 1000, maxValue: 3600000, description: ["Virtual courier time per system crossing plus a final docking interval. Each accepted journey retains its configured leg duration across restart and pause."], validValues: "Integer milliseconds from 1000 to 3600000." },
];
