"use strict";

const {
  toFiniteNumber,
} = require("../../../common/numbers");

// The Disruptive Lance (Lancer Dreadnought superweapon, effect 11691
// `debuffLance`) leaves a timed debuff on everything its beam cuts through.
// `doomsdayAppliedDBuffDuration` (5412) = 60,000 ms carries how long it lasts,
// but the SDE carries no description of what it *does*: effect 11691 has no
// modifierInfo and there is no dbuff collection behind it. CCP describe the
// content in prose instead — "Ships struck by the disruptive lance beam will
// have their warp/jump drives disabled, tether/docking disabled, and experience
// a 50% reduction to incoming remote repair, all for 60 seconds"
// (eveonline.com/news/view/new-lancer-dreadnoughts), with the Viridian patch
// notes adding stargate use to the list. The 50% figure is the one number here
// that has no SDE attribute to read, so it lives as a constant.
//
// This module is deliberately dependency-free: the state it owns is read by the
// warp, stargate, docking, tethering and remote-assistance gates, which live in
// four different files that must not end up requiring each other.

const DISRUPTIVE_LANCE_REMOTE_REPAIR_MULTIPLIER = 0.5;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// The debuff refreshes rather than stacks: a second lance landing on the same
// ship extends the window to whichever expiry is later, exactly as the
// superweapon immobility and no-jump locks on the firing ship already do.
function applyDisruptiveLanceDebuff(entity, options = {}) {
  const durationMs = Math.max(0, toFiniteNumber(options.durationMs, 0));
  if (!entity || durationMs <= 0) {
    return false;
  }

  const nowMs = toFiniteNumber(options.nowMs, Date.now());
  entity.disruptiveLanceDebuffUntilMs = Math.max(
    toFiniteNumber(entity.disruptiveLanceDebuffUntilMs, 0),
    nowMs + durationMs,
  );
  entity.disruptiveLanceRemoteRepairMultiplier = clamp(
    toFiniteNumber(
      options.remoteRepairMultiplier,
      DISRUPTIVE_LANCE_REMOTE_REPAIR_MULTIPLIER,
    ),
    0,
    1,
  );
  entity.disruptiveLanceDebuffSourceID = Math.trunc(
    toFiniteNumber(options.sourceEntityID, 0),
  );
  return true;
}

function isEntityDisruptiveLanceDebuffed(entity, nowMs = Date.now()) {
  return (
    toFiniteNumber(entity && entity.disruptiveLanceDebuffUntilMs, 0) >
    toFiniteNumber(nowMs, Date.now())
  );
}

function getDisruptiveLanceDebuffExpiryMs(entity) {
  return toFiniteNumber(entity && entity.disruptiveLanceDebuffUntilMs, 0);
}

// 1 means "no reduction". Callers multiply their repair amount by this, so an
// undebuffed target must read exactly 1 rather than 0.
function getDisruptiveLanceRemoteRepairMultiplier(entity, nowMs = Date.now()) {
  if (!isEntityDisruptiveLanceDebuffed(entity, nowMs)) {
    return 1;
  }
  return clamp(
    toFiniteNumber(
      entity && entity.disruptiveLanceRemoteRepairMultiplier,
      DISRUPTIVE_LANCE_REMOTE_REPAIR_MULTIPLIER,
    ),
    0,
    1,
  );
}

function clearDisruptiveLanceDebuff(entity) {
  if (!entity) {
    return false;
  }
  entity.disruptiveLanceDebuffUntilMs = 0;
  entity.disruptiveLanceRemoteRepairMultiplier = 1;
  entity.disruptiveLanceDebuffSourceID = 0;
  return true;
}

module.exports = {
  DISRUPTIVE_LANCE_REMOTE_REPAIR_MULTIPLIER,
  applyDisruptiveLanceDebuff,
  clearDisruptiveLanceDebuff,
  getDisruptiveLanceDebuffExpiryMs,
  getDisruptiveLanceRemoteRepairMultiplier,
  isEntityDisruptiveLanceDebuffed,
};
