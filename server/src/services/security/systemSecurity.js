"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const HIGH_SECURITY_SYSTEM_CUTOFF = 0.45;

function getSolarSystemPseudoSecurity(system) {
  const security = Math.max(
    0,
    Math.min(1, toFiniteNumber(system && system.security, 0)),
  );
  if (security > 0 && security < 0.05) {
    return 0.05;
  }
  return security;
}

function isHighSecuritySystem(system) {
  return getSolarSystemPseudoSecurity(system) >= HIGH_SECURITY_SYSTEM_CUTOFF;
}

function isLowSecuritySystem(system) {
  const security = getSolarSystemPseudoSecurity(system);
  return security > 0 && security < HIGH_SECURITY_SYSTEM_CUTOFF;
}

module.exports = {
  HIGH_SECURITY_SYSTEM_CUTOFF,
  getSolarSystemPseudoSecurity,
  isHighSecuritySystem,
  isLowSecuritySystem,
};
