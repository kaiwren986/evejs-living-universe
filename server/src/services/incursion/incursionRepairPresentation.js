"use strict";

// The HP owners can accept a repair before its durability fence succeeds.
// Readers in that process must retain the prior health presentation, including
// login/ballpark readers of the updated cache. A fresh process reads durable HP.
// This is a visibility hold, never another health or persistence authority.
const holds = new Map();
const healthKeys = ["shieldCharge", "armorDamage", "damage"];
function hold(request, target, before) {
  const next = { pulseID: request.pulseID, proof: request.proof,
    typeID: target.typeID, ownerID: target.ownerID,
    before: Object.fromEntries(healthKeys.map(key => [key, before[key]])) };
  const current = holds.get(request.targetID);
  if (current && (current.pulseID !== next.pulseID || current.proof !== next.proof ||
      current.typeID !== next.typeID || current.ownerID !== next.ownerID ||
      healthKeys.some(key => current.before[key] !== next.before[key])))
    throw new Error("INCURSION_SUPPORT_PRESENTATION_CONFLICT");
  holds.set(request.targetID, next);
}
function release(request) {
  const current = holds.get(request.targetID);
  if (current?.pulseID === request.pulseID && current.proof === request.proof) holds.delete(request.targetID);
}
function condition(record, fallback = record?.conditionState) {
  const current = holds.get(Number(record?.itemID || record?.entityID));
  if (!current || Number(record?.typeID) !== current.typeID || Number(record?.ownerID) !== current.ownerID) return fallback;
  // Capacitor and heat retain their own live owners while shield HP is held.
  return { ...fallback, ...current.before };
}
module.exports = { hold, release, condition };
