"use strict";

const crypto = require("node:crypto");

function probability(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
}

function deterministicUnit(seed, lane) {
  const digest = crypto.createHash("sha256")
    .update(`${String(seed)}:${String(lane)}`)
    .digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function evaluateCandidate(candidate = {}) {
  const scanChance = probability(candidate.scanChance);
  const selectionRoll = deterministicUnit(candidate.seed, "selection");
  const selected = selectionRoll < scanChance;
  const detectionChance = probability(candidate.detectionChance);
  const smugglingChance = probability(candidate.smugglingChance);
  // Keep the implant's existing evade-roll boundary, but give every stack its
  // own lane independently of the officer's decision to inspect this arrival.
  const detectedEntries = [];
  const checkedEntries = [];
  if (selected) {
    const seenItemIDs = new Set();
    const entries = [...(Array.isArray(candidate.entries) ? candidate.entries : [])]
      .sort((left, right) => Number(left.itemID) - Number(right.itemID));
    for (const entry of entries) {
      const itemID = Number(entry && entry.itemID);
      const typeID = Number(entry && entry.typeID);
      if (!Number.isSafeInteger(itemID) || itemID <= 0 ||
          !Number.isSafeInteger(typeID) || typeID <= 0 || seenItemIDs.has(itemID)) {
        continue;
      }
      seenItemIDs.add(itemID);
      const detectionRoll = deterministicUnit(candidate.seed, `detect:${itemID}`);
      const smugglingRoll = deterministicUnit(candidate.seed, `smuggle:${itemID}`);
      const detected = detectionRoll < detectionChance && smugglingRoll >= smugglingChance;
      const checked = {
        ...JSON.parse(JSON.stringify(entry)),
        detectionRoll,
        detectionChance,
        smugglingRoll,
        smugglingChance,
        detected,
      };
      checkedEntries.push(checked);
      if (detected) {
        detectedEntries.push(checked);
      }
    }
  }
  // Entries already carry the inventory owner's quantity and rounded fine.
  // Preserve that policy and current summed per-stack standing loss. Do not
  // apply the donor's negative-balance or per-type standing transformation.
  const totalFine = roundMoney(detectedEntries.reduce((sum, entry) => (
    sum + Math.max(0, Number(entry.fine) || 0)
  ), 0));
  const standingLoss = detectedEntries.reduce((sum, entry) => (
    sum + Math.max(0, Number(entry.standingLoss) || 0)
  ), 0);
  const byTypeID = new Map();
  for (const entry of detectedEntries) {
    const current = byTypeID.get(entry.typeID) || {
      typeID: entry.typeID,
      quantity: 0,
      fine: 0,
      standingLoss: 0,
    };
    current.quantity += Math.max(0, Number(entry.quantity) || 0);
    current.fine = roundMoney(current.fine + Math.max(0, Number(entry.fine) || 0));
    current.standingLoss += Math.max(0, Number(entry.standingLoss) || 0);
    byTypeID.set(entry.typeID, current);
  }
  return {
    selected,
    selectionRoll,
    scanChance,
    detectionChance,
    smugglingChance,
    detected: detectedEntries.length > 0,
    checkedEntries,
    detectedEntries,
    lostList: [...byTypeID.values()].sort((left, right) => left.typeID - right.typeID),
    totalFine,
    standingLoss,
  };
}

function evaluateBatch(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
    caseID: candidate.caseID,
    seed: candidate.seed,
    result: evaluateCandidate(candidate),
  }));
}

module.exports = { deterministicUnit, evaluateBatch, evaluateCandidate };
