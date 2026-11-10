"use strict";

// The checkpoint describes the upgrades and resources that actually ran during
// the preceding interval. Configuration changes settle that interval first;
// they must never bill yesterday using today's priority or skyhook population.
const HOUR_MS = 3_600_000;
const EPSILON = 1e-8;
const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function normalizeFuelState(value) {
  if (!value || value.version !== 1) return null;
  return {
    version: 1,
    settledAtMs: nonnegative(value.settledAtMs),
    paidTypeIDs: [...new Set((value.paidTypeIDs || []).map(Number))],
    fractionalByTypeID: Object.fromEntries(Object.entries(value.fractionalByTypeID || {})
      .map(([key, amount]) => [key, Math.min(1 - Number.EPSILON, nonnegative(amount))])),
    resources: { power: nonnegative(value.resources?.power), workforce: nonnegative(value.resources?.workforce) },
    upgrades: Array.isArray(value.upgrades) ? structuredClone(value.upgrades) : [],
    runningTypeIDs: Array.isArray(value.runningTypeIDs) ? value.runningTypeIDs.map(Number) : [],
    ...(value.runningSinceByTypeID && typeof value.runningSinceByTypeID === "object" ? {
      runningSinceByTypeID: Object.fromEntries(Object.entries(value.runningSinceByTypeID)
        .map(([key, since]) => [key, nonnegative(since)])),
    } : {}),
  };
}

// When each running upgrade started running: kept while it keeps running, set
// to the settle time when it starts, dropped when it stops. The site supply
// waits a first respawn after this (patch 23.01).
function buildRunningSince(previous, runningTypeIDs, settledAtMs) {
  const before = previous && previous.runningSinceByTypeID || {};
  const wasRunning = new Set(previous ? previous.runningTypeIDs : []);
  // A Hub with no checkpoint yet (seeded or older data), and an upgrade already
  // running in a checkpoint written before this record existed, have run for
  // long enough: 0. Only a start seen against an earlier checkpoint waits.
  return Object.fromEntries(runningTypeIDs.map((typeID) => [
    String(typeID),
    !previous || wasRunning.has(typeID)
      ? nonnegative(before[String(typeID)])
      : settledAtMs,
  ]));
}

function checkpointUpgrades(installations, definitions) {
  return installations.map((installation) => {
    const definition = definitions.get(Number(installation.typeID));
    if (!definition) return null;
    const entry = { typeID: Number(installation.typeID), online: Boolean(installation.online) };
    for (const key of ["powerRequired", "workforceRequired", "powerProduced", "workforceProduced",
      "fuelTypeID", "fuelConsumptionPerHour", "fuelStartupCost"]) entry[key] = nonnegative(definition[key]);
    return entry;
  }).filter(Boolean);
}

function allocate(upgrades, resources, ledger, paid, payStartup, fractions = {}) {
  let power = nonnegative(resources.power);
  let workforce = nonnegative(resources.workforce);
  let powerAllocated = 0;
  let workforceAllocated = 0;
  const runningTypeIDs = [];
  const rates = {};
  for (const upgrade of upgrades) {
    if (!upgrade.online || powerAllocated + upgrade.powerRequired > power ||
      workforceAllocated + upgrade.workforceRequired > workforce) continue;
    const fuelKey = String(upgrade.fuelTypeID);
    const requiresPayment = upgrade.fuelTypeID > 0 && upgrade.fuelStartupCost > 0;
    if (requiresPayment && !paid.has(upgrade.typeID)) {
      if (!payStartup || nonnegative(ledger[fuelKey]?.amount) - nonnegative(fractions[fuelKey]) < upgrade.fuelStartupCost) continue;
      ledger[fuelKey] = { amount: ledger[fuelKey].amount - upgrade.fuelStartupCost };
      paid.add(upgrade.typeID);
    }
    if (upgrade.fuelTypeID > 0 && upgrade.fuelConsumptionPerHour > 0 &&
      !(nonnegative(ledger[fuelKey]?.amount) > 0)) continue;
    runningTypeIDs.push(upgrade.typeID);
    powerAllocated += upgrade.powerRequired;
    workforceAllocated += upgrade.workforceRequired;
    power += upgrade.powerProduced;
    workforce += upgrade.workforceProduced;
    if (upgrade.fuelTypeID > 0 && upgrade.fuelConsumptionPerHour > 0) {
      rates[fuelKey] = nonnegative(rates[fuelKey]) + upgrade.fuelConsumptionPerHour;
    }
  }
  return { runningTypeIDs, rates, powerAllocated, workforceAllocated };
}

function selectRunningUpgrades(upgrades, resources, fuelByTypeID, fuelState) {
  return allocate(upgrades, resources, structuredClone(fuelByTypeID || {}),
    new Set(fuelState?.paidTypeIDs || []), false, fuelState?.fractionalByTypeID);
}

function nextExhaustionMs(rates, ledger, fractions) {
  let duration = Infinity;
  for (const [key, rate] of Object.entries(rates)) {
    duration = Math.min(duration,
      Math.max(0, nonnegative(ledger[key]?.amount) - nonnegative(fractions[key])) * HOUR_MS / rate);
  }
  return duration;
}

function settleHubFuel({ fuelByTypeID, fuelState, upgrades, resources, nowMs }) {
  const ledger = structuredClone(fuelByTypeID || {});
  const previous = normalizeFuelState(fuelState);
  const endMs = Math.max(nonnegative(nowMs), previous?.settledAtMs || 0);
  const paid = new Set(previous?.paidTypeIDs || []);
  const fractions = { ...(previous?.fractionalByTypeID || {}) };
  let remainingMs = previous ? endMs - previous.settledAtMs : 0;
  // Every exhaustion removes a fuel type from the running set. Reallocation can
  // also start an affordable lower-priority upgrade and debit its startup once.
  // Process the actual exhaustion instant so other fuel types stop burning when
  // their power/workforce producer disappears, even after a long downtime.
  while (previous && remainingMs > EPSILON) {
    const running = allocate(previous.upgrades, previous.resources, ledger, paid, true, fractions);
    const segmentMs = Math.min(remainingMs, nextExhaustionMs(running.rates, ledger, fractions));
    if (!Object.keys(running.rates).length) break;
    for (const [key, rate] of Object.entries(running.rates)) {
      const available = nonnegative(ledger[key]?.amount);
      const consumed = nonnegative(fractions[key]) + rate * segmentMs / HOUR_MS;
      if (consumed + EPSILON >= available) {
        ledger[key] = { amount: 0 };
        fractions[key] = 0;
      } else {
        const units = Math.floor(consumed + EPSILON);
        ledger[key] = { amount: available - units };
        fractions[key] = Math.max(0, consumed - units);
      }
    }
    remainingMs -= segmentMs;
  }
  // An explicit off/on creates a fresh activation. A low-power interruption or
  // empty fuel bay preserves payment and recovers without another startup cost.
  const enabled = new Set(upgrades.filter((entry) => entry.online).map((entry) => entry.typeID));
  for (const typeID of paid) if (!enabled.has(typeID)) paid.delete(typeID);
  const running = allocate(upgrades, resources, ledger, paid, true, fractions);
  const next = {
    version: 1, settledAtMs: endMs, paidTypeIDs: [...paid],
    fractionalByTypeID: fractions,
    resources: { power: nonnegative(resources.power), workforce: nonnegative(resources.workforce) },
    upgrades: structuredClone(upgrades), runningTypeIDs: running.runningTypeIDs,
    runningSinceByTypeID: buildRunningSince(previous, running.runningTypeIDs, endMs),
  };
  if (previous && !upgrades.some((entry) => entry.online && entry.fuelTypeID > 0 &&
    (entry.fuelConsumptionPerHour > 0 || entry.fuelStartupCost > 0)) && !Object.keys(running.rates).length &&
    !previous.upgrades.some((entry) => previous.runningTypeIDs.includes(entry.typeID) && entry.fuelConsumptionPerHour > 0) &&
    JSON.stringify({ ...next, settledAtMs: previous.settledAtMs }) === JSON.stringify(previous)) {
    next.settledAtMs = previous.settledAtMs;
  }
  const exhaustionMs = nextExhaustionMs(running.rates, ledger, fractions);
  return {
    fuelByTypeID: ledger, fuelState: next, runningTypeIDs: running.runningTypeIDs,
    nextDueAtMs: Number.isFinite(exhaustionMs) ? Math.ceil(endMs + Math.min(60_000, exhaustionMs)) : null,
    changed: JSON.stringify(ledger) !== JSON.stringify(fuelByTypeID || {}) || JSON.stringify(next) !== JSON.stringify(fuelState || null),
    observableChanged: JSON.stringify(ledger) !== JSON.stringify(fuelByTypeID || {}) ||
      JSON.stringify(running.runningTypeIDs) !== JSON.stringify(previous?.runningTypeIDs || []) ||
      JSON.stringify(next.resources) !== JSON.stringify(previous?.resources),
  };
}

module.exports = { checkpointUpgrades, normalizeFuelState, selectRunningUpgrades, settleHubFuel };
