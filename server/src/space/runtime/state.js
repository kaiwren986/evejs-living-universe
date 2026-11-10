"use strict";

module.exports = {};


const SYNTHETIC_RUNTIME_ENTITY_ID_START = 4_200_000_000_000_000;

const DEFAULT_PASSIVE_SHIELD_RECHARGE_ENABLED = true;

let passiveShieldRechargeEnabled = DEFAULT_PASSIVE_SHIELD_RECHARGE_ENABLED;

let nextRuntimeEntityID = SYNTHETIC_RUNTIME_ENTITY_ID_START;

// The exported properties below are the live state: every reader and writer goes
// through state.<name>. The declarations above only supply their starting values.
Object.assign(module.exports, {
  DEFAULT_PASSIVE_SHIELD_RECHARGE_ENABLED,
  SYNTHETIC_RUNTIME_ENTITY_ID_START,
  nextRuntimeEntityID,
  passiveShieldRechargeEnabled,
});
