"use strict";

module.exports = {
  getDisplayedSecurityForStartupLoading,
  getSecurityStatusIconKey,
  getSolarSystemPseudoSecurity,
  getSystemSecurityClass,
  isHazardousSecurityTransition,
};

const {
  clamp,
  toFiniteNumber,
} = require("../../common/numbers");

function getSolarSystemPseudoSecurity(system) {
  const security = clamp(toFiniteNumber(system && system.security, 0), 0, 1);
  if (security > 0 && security < 0.05) {
    return 0.05;
  }

  return security;
}

function getSystemSecurityClass(system) {
  const security = getSolarSystemPseudoSecurity(system);
  if (security <= 0) {
    return 0;
  }
  if (security < 0.45) {
    return 1;
  }
  return 2;
}

function getSecurityStatusIconKey(system) {
  const securityTenths = clamp(
    Math.round(getSolarSystemPseudoSecurity(system) * 10),
    0,
    10,
  );
  const whole = Math.floor(securityTenths / 10);
  const tenths = securityTenths % 10;
  return `SEC_${whole}_${tenths}`;
}

function getDisplayedSecurityForStartupLoading(system) {
  return Math.round(getSolarSystemPseudoSecurity(system) * 10) / 10;
}

function isHazardousSecurityTransition(sourceSystem, destinationSystem) {
  const sourceSecurityClass = getSystemSecurityClass(sourceSystem);
  const destinationSecurityClass = getSystemSecurityClass(destinationSystem);
  return (
    (sourceSecurityClass === 2 && destinationSecurityClass !== 2) ||
    (sourceSecurityClass === 1 && destinationSecurityClass === 0)
  );
}
