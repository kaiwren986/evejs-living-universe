"use strict";

// Role-mask and location semantics only. Membership and assignment authority
// remain with corporationAuthority/corpRegistryRuntime; this module has no store
// dependency so every service can read session permissions the same way.
function parseCorporationRoleMask(value, fallback = 0n) {
  try {
    if (value && typeof value === "object" && (value.type === "long" || value.type === "int")) {
      return parseCorporationRoleMask(value.value, fallback);
    }
    let mask;
    if (typeof value === "bigint") mask = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) mask = BigInt(value);
    else if (typeof value === "string" && /^\d+$/.test(value.trim())) mask = BigInt(value.trim());
    else return fallback;
    return mask >= 0n && mask <= 0x7fffffffffffffffn ? mask : fallback;
  } catch (_) {
    return fallback;
  }
}

function getSessionCorporationRoleMask(session) {
  // A canonical zero is authoritative. OR-ing aliases, or using || here,
  // resurrects permissions after a role is revoked. Legacy sessions without a
  // canonical field may still supply one of the compatibility fields.
  return parseCorporationRoleMask(session && (session.corprole ?? session.corpRole ?? session.rolesAtAll));
}

function getCorporationRolesAtLocation(roleState, locationID) {
  if (!roleState) return 0n;
  const globalRoles = parseCorporationRoleMask(
    roleState.rolesAtAll ?? roleState.corprole ?? roleState.corpRole,
  );
  const location = Number(locationID);
  // Build 3396210 basesession.Session.RecalculateDependantAttributes:
  // HQ wins when HQ and base coincide; space and Upwell sessions (no
  // stationid) use Other. Remote inventory/industry callers pass their target.
  const localField = Number.isSafeInteger(location) && location > 0 && location === Number(roleState.hqID)
    ? "rolesAtHQ"
    : Number.isSafeInteger(location) && location > 0 && location === Number(roleState.baseID)
      ? "rolesAtBase" : "rolesAtOther";
  return globalRoles | parseCorporationRoleMask(roleState[localField]);
}

module.exports = {
  parseCorporationRoleMask,
  getSessionCorporationRoleMask,
  getCorporationRolesAtLocation,
};
