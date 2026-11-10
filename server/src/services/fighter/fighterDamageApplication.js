"use strict";

// Fighter weapons combine missile signature/speed application with gun falloff.
function rangeMultiplier(distance, optimal, falloff) {
  const excess = Math.max(0, distance - optimal);
  return excess === 0 ? 1 : falloff > 0 ? 0.5 ** ((excess / falloff) ** 2) : 0;
}

function scaleDamage(vector, factor) {
  return Object.fromEntries(
    ["em", "thermal", "kinetic", "explosive"].map((key) => [
      key,
      Math.max(0, Number(vector && vector[key]) || 0) * factor,
    ]),
  );
}

function targetCoefficient(snapshot, target, defaultValue) {
  const id = snapshot.targetResistanceAttributeID;
  if (!id) return 1;
  const value =
    target &&
    target.passiveDerivedState &&
    target.passiveDerivedState.attributes &&
    target.passiveDerivedState.attributes[id];
  const resolved = value ?? defaultValue(id);
  return Number.isFinite(Number(resolved)) ? Math.max(0, Number(resolved)) : 1;
}

function bombDamage(vector, count, signature, explosionRadius) {
  const application =
    explosionRadius > 0
      ? Math.min(1, Math.max(0, signature) / explosionRadius)
      : 1;
  return scaleDamage(vector, Math.max(0, count) * application);
}

module.exports = {
  rangeMultiplier,
  scaleDamage,
  targetCoefficient,
  bombDamage,
};
