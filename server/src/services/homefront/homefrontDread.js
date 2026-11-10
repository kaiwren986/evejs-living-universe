"use strict";

const engine = require("./homefrontEngine");
const {
  getEntityMaxHealthLayers,
  getEntityCurrentHealthLayers,
  applyResolvedDamageAmountToEntity,
} = require("../../space/combat/damage");
const {
  broadcastDamageStateChange,
} = require("../../space/runtime/shipHealthState");
const { toFileTimeFromMs } = require("../../space/runtime/runtimeClock");
const {
  DESTRUCTION_EFFECT_EXPLOSION,
} = require("../../space/runtime/combatDestruction");

const SIEGE_MS = 90000;
// Client dread dogma: entitySuperWeaponLanceAllRaces has a 10-second duration.
// Damage is authored to exhaust the objective over three complete sieges.
const SHOT_MS = 10000;
const SHOTS_PER_SIEGE = SIEGE_MS / SHOT_MS;
const TOTAL_SHOTS = 3 * SHOTS_PER_SIEGE;

function broadcastSpecialEffect(
  scene,
  dread,
  guid,
  target,
  now,
  duration,
  start = true,
) {
  scene.broadcastSpecialFx(
    dread.itemID,
    guid,
    {
      moduleID: dread.itemID,
      moduleTypeID: dread.typeID,
      targetID: target?.itemID || null,
      isOffensive: Boolean(target),
      start,
      active: start,
      duration,
      repeat: 0,
      startTime: toFileTimeFromMs(now),
    },
    dread,
  );
}

function tick(scene, config, state, entities, now) {
  const dread = entities.find((entity) => entity.homefrontRole === "dread");
  const base = entities.find((entity) => entity.homefrontRole === "objective");
  if (!dread || !base || state.status !== "active") return;
  if (state.phase !== "siege") {
    if (dread.capacitorChargeRatio < 1) return;
    state.phase = "siege";
    state.phaseEndsAtMs = state.elapsedMs + SIEGE_MS;
  }
  const elapsed = Math.max(
    0,
    Math.min(SIEGE_MS, state.elapsedMs - (state.phaseEndsAtMs - SIEGE_MS)),
  );
  const shots = state.charges * SHOTS_PER_SIEGE + Math.floor(elapsed / SHOT_MS);
  if (shots > (state.dreadShotsApplied || 0)) {
    const maximum = getEntityMaxHealthLayers(base);
    const current = getEntityCurrentHealthLayers(base, maximum);
    const total = maximum.shield + maximum.armor + maximum.structure;
    const remaining = total * (1 - Math.min(TOTAL_SHOTS, shots) / TOTAL_SHOTS);
    const amount = Math.max(
      0,
      current.shield + current.armor + current.structure - remaining,
    );
    if (amount > 0) {
      const damage = applyResolvedDamageAmountToEntity(base, amount);
      if (!damage.success)
        throw new Error(`Homefront dread damage failed: ${damage.errorMsg}`);
      state.health[base.homefrontKey] = { ...base.conditionState };
      broadcastDamageStateChange(scene, base);
    }
    state.dreadShotsApplied = shots;
  }
  if (elapsed >= SIEGE_MS) {
    if (state.charges >= 2) {
      const removed = scene.removeStaticEntity(base.itemID, {
        broadcast: true,
        nowMs: now,
        terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
      });
      if (!removed?.success)
        throw new Error("Homefront dread could not destroy the enemy base");
      state.resolved[base.homefrontKey] = true;
    }
    broadcastSpecialEffect(
      scene,
      dread,
      "effects.SiegeMode",
      null,
      now,
      0,
      false,
    );
    state.charges++;
    state.phase = "active";
    dread.capacitorChargeRatio = 0;
    state.capacitors.dread = 0;
    delete dread.homefrontSiegeFxPulse;
    if (state.charges === 3) engine.complete(state);
    return;
  }
  const pulse = `${state.charges}:${Math.floor(elapsed / SHOT_MS)}`;
  if (dread.homefrontSiegeFxPulse !== pulse) {
    // Transient marker: rematerializing during siege restores presentation,
    // while durable damage progress prevents duplicate damage on reload.
    broadcastSpecialEffect(
      scene,
      dread,
      "effects.SiegeMode",
      null,
      now,
      SIEGE_MS - elapsed,
    );
    broadcastSpecialEffect(
      scene,
      dread,
      `effects.SuperWeaponLance${config.empire}`,
      base,
      now,
      SHOT_MS,
    );
    dread.homefrontSiegeFxPulse = pulse;
  }
}

module.exports = { tick };
