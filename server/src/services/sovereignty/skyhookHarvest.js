"use strict";

const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

// Projection is deterministic: reads do not move the persisted cycle boundary.
// Mutations settle this projection before changing stock or activation.
function settleSkyhookHarvest(skyhook, nowMs = getWallclockNowMs()) {
  for (const simulation of skyhook.reagentSimulations || []) {
    const definition = (skyhook.reagentDefinitions || []).find(
      (entry) => entry.reagentTypeID === simulation.reagentTypeID,
    );
    if (!definition) continue;
    const periodMs = definition.cyclePeriodSeconds * 1000;
    if (!(periodMs > 0) || nowMs < simulation.lastCycleMs) continue;
    if (!skyhook.active || skyhook.destroyed) {
      simulation.lastCycleMs = nowMs;
      continue;
    }
    const cycles = Math.floor((nowMs - simulation.lastCycleMs) / periodMs);
    if (!cycles) continue;
    const harvested = cycles * definition.amountPerCycle;
    const secured = Math.floor(harvested *
      Math.min(100, Math.max(0, definition.securedPercentage)) / 100);
    const secureTotal = simulation.securedStock + secured;
    const surplusTotal = simulation.unsecuredStock + harvested - secured;
    simulation.securedStock = Math.min(definition.securedCapacity, secureTotal);
    simulation.unsecuredStock = Math.min(definition.unsecuredCapacity, surplusTotal);
    let overflow = secureTotal + surplusTotal - simulation.securedStock - simulation.unsecuredStock;
    const toSecure = Math.min(overflow, definition.securedCapacity - simulation.securedStock);
    simulation.securedStock += toSecure;
    overflow -= toSecure;
    simulation.unsecuredStock += Math.min(overflow,
      definition.unsecuredCapacity - simulation.unsecuredStock);
    simulation.lastCycleMs += cycles * periodMs;
  }
  return skyhook;
}

module.exports = { settleSkyhookHarvest };
