"use strict";

const { randomInt } = require("node:crypto");
const catalog = require("./gallenteCratePools.json");
const replayBoosters = new Set([
  ...catalog.pools[92161], ...catalog.pools[92181],
].map(entry => entry.typeID));

function getPool(typeID) {
  return catalog.pools[typeID] || null;
}

function roll(typeID) {
  const pool = getPool(typeID);
  return pool ? [{ typeID: pool[randomInt(pool.length)].typeID, quantity: 1 }] : null;
}

// Election rewards remain usable after earning stops; normal duration, slots,
// skills and side effects still apply. Other events retain their expiry policy.
function ignoresInjectionDeadline(typeID) {
  return replayBoosters.has(Number(typeID));
}

module.exports = { getPool, roll, ignoresInjectionDeadline };
