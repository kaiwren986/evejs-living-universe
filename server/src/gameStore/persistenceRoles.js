"use strict";

const ROLE = Object.freeze({
  WORLD: "world",
  WALLET: "wallet",
  SCHEDULER: "scheduler",
  MAINTENANCE: "maintenance",
  READER: "reader",
  STANDALONE: "standalone",
});

const TABLE_ROLE = Object.freeze({
  walletAuthorityState: ROLE.WALLET,
  scheduledJobs: ROLE.SCHEDULER,
});

const UNRESTRICTED_ROLES = new Set([
  ROLE.STANDALONE,
  ROLE.MAINTENANCE,
]);
const CONFIGURED_ROLES = new Set(Object.values(ROLE));

function normalizeRole(value, fallback = ROLE.READER) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function configuredRole(env = process.env) {
  const configured = String(env.EVEJS_GAMESTORE_OWNER_ROLE || "").trim();
  if (configured) {
    const role = normalizeRole(configured, ROLE.READER);
    if (!CONFIGURED_ROLES.has(role)) {
      const error = new Error(
        `unknown EVEJS_GAMESTORE_OWNER_ROLE: ${JSON.stringify(configured)}`,
      );
      error.code = "GAMESTORE_PROCESS_ROLE_INVALID";
      error.processRole = role;
      throw error;
    }
    return role;
  }

  // The isolated runner attests a disposable copy of the store before loading
  // GameStore. Preserve the broad standalone surface there so focused tests
  // and their child fixtures can exercise all owners without masquerading as
  // a production process. Everywhere else, an unlabelled import is passive:
  // admin/reporting code must opt into a maintenance role before it can mutate
  // or recover durable state.
  return env.EVEJS_TEST_STORE_ISOLATED === "1"
    ? ROLE.STANDALONE
    : ROLE.READER;
}

function ownerRoleForTable(table) {
  return TABLE_ROLE[String(table || "")] || ROLE.WORLD;
}

function roleMayMutateTable(role, table) {
  const normalizedRole = normalizeRole(role);
  if (UNRESTRICTED_ROLES.has(normalizedRole)) {
    return true;
  }
  if (normalizedRole === ROLE.READER) {
    return false;
  }
  return normalizedRole === ownerRoleForTable(table);
}

// Every table without a dedicated owner in TABLE_ROLE belongs to `world`, so a
// process that may not mutate an unlisted table may not drive world simulation
// at all. Loops that touch the broad world surface — the space runtime tick,
// startup expiry sweeps — ask this instead of picking one table to probe.
function roleMayDriveWorldState(role) {
  const normalizedRole = normalizeRole(role);
  return UNRESTRICTED_ROLES.has(normalizedRole) || normalizedRole === ROLE.WORLD;
}

function assertRoleMayMutateTable(role, table, operation = "mutate") {
  const normalizedRole = normalizeRole(role);
  if (roleMayMutateTable(normalizedRole, table)) {
    return true;
  }
  const error = new Error(
    `gameStore process role ${normalizedRole} may not ${operation} ${table}; ` +
      `durable owner is ${ownerRoleForTable(table)}`,
  );
  error.code = "GAMESTORE_PROCESS_OWNERSHIP_VIOLATION";
  error.ownerRole = ownerRoleForTable(table);
  error.processRole = normalizedRole;
  error.table = String(table || "");
  throw error;
}

function tablesOwnedByRole(role, tables = []) {
  const normalizedRole = normalizeRole(role);
  return [...tables].filter((table) =>
    roleMayMutateTable(normalizedRole, table));
}

module.exports = {
  ROLE,
  TABLE_ROLE,
  assertRoleMayMutateTable,
  configuredRole,
  normalizeRole,
  ownerRoleForTable,
  roleMayDriveWorldState,
  roleMayMutateTable,
  tablesOwnedByRole,
};
