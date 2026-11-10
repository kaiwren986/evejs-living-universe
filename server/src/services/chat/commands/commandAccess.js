"use strict";

// Chat command access: whether the caller has the staff view role that unlocks the staff
// debug commands and help text.

const {
  normalizeRoleValue,
  ROLEMASK_VIEW,
} = require("../../account/accountRoleProfiles");

function hasStaffDebugRole(session) {
  const roleMask = normalizeRoleValue(
    session && (
      session.accountRole ??
      session.role ??
      session.rolesAtAll
    ),
    0n,
  );
  return (roleMask & ROLEMASK_VIEW) !== 0n;
}

module.exports = {
  hasStaffDebugRole,
};
