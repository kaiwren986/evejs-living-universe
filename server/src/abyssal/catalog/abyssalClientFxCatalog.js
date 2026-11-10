"use strict";

// Pure data used by the Abyssal manager. Playback belongs to the outer space
// runtime; keeping profile lookup here prevents catalog reads from importing it.
const ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY = "whiteout";

const ABYSSAL_CLIENT_EFFECTS = Object.freeze([
  { key: "whiteout", guid: "effects.WhiteOut", aliases: ["white_out", "effects.whiteout"], start: { duration: 60_000, active: false }, stop: { start: false, active: false } },
  { key: "capsule_flare", guid: "effects.CapsuleFlare", aliases: ["capsuleflare", "effects.capsuleflare"], start: { duration: 4_000, active: false }, stop: { start: false, active: false } },
  { key: "jump_in", guid: "effects.JumpIn", aliases: ["jumpin", "effects.jumpin"], start: { duration: 5_000, active: false }, stop: { start: false, active: false } },
  { key: "jump_drive_in", guid: "effects.JumpDriveIn", aliases: ["jumpdrivein", "effects.jumpdrivein"], start: { duration: 5_000, active: false }, stop: { start: false, active: false } },
  { key: "jump_drive_in_bo", guid: "effects.JumpDriveInBO", aliases: ["jumpdriveinbo", "black_ops_jump_in", "effects.jumpdriveinbo"], start: { duration: 5_000, active: false }, stop: { start: false, active: false } },
  { key: "microjump", guid: "effects.MicroJumpDriveEngage", aliases: ["mjd", "micro_jump", "microjumpdriveengage", "effects.microjumpdriveengage"], start: { duration: 4_500, active: false }, stop: { start: false, active: false } },
  { key: "jump_out_abyssal", guid: "effects.JumpOutAbyssal", aliases: ["abyssal_jump_out", "jumpoutabyssal", "effects.jumpoutabyssal"], start: { active: false }, stop: { start: false, active: false } },
  { key: "jump_out_abyssal_between", guid: "effects.JumpOutAbyssalBetween", aliases: ["abyssal_jump_between", "jumpoutabyssalbetween", "effects.jumpoutabyssalbetween"], start: { active: false }, stop: { start: false, active: false } },
  { key: "abyssal_reentry_splash", guid: "effects.AbyssalReentrySplash", aliases: ["reentry_splash", "abyssalreentrysplash", "effects.abyssalreentrysplash"], start: { active: false }, stop: { start: false, active: false } },
]);

function normalizeEffectToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^effects\./, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const EFFECTS_BY_TOKEN = new Map();
for (const effect of ABYSSAL_CLIENT_EFFECTS) {
  for (const candidate of [effect.key, effect.guid, ...effect.aliases]) {
    EFFECTS_BY_TOKEN.set(normalizeEffectToken(candidate), effect);
  }
}

function listAbyssalCalmDarkProbeEffects() {
  return [...ABYSSAL_CLIENT_EFFECTS];
}

function listAbyssalCalmDarkProbeEffectKeys() {
  return ABYSSAL_CLIENT_EFFECTS.map((effect) => effect.key);
}

function resolveAbyssalCalmDarkProbeEffect(value) {
  return EFFECTS_BY_TOKEN.get(normalizeEffectToken(value)) || null;
}

module.exports = {
  ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY,
  listAbyssalCalmDarkProbeEffectKeys,
  listAbyssalCalmDarkProbeEffects,
  resolveAbyssalCalmDarkProbeEffect,
};
