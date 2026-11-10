"use strict";

function maintenanceFenceError(message, code = "PERSISTENCE_OWNER_STALE", details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeMaintenanceFence(value) {
  if (!value || typeof value !== "object") {
    throw maintenanceFenceError(
      "Config Editor requires an acquired maintenance owner fence",
      "PERSISTENCE_OWNER_FENCE_REQUIRED",
    );
  }
  const ownerRole = String(value.ownerRole || value.role || "").trim();
  const instanceId = String(
    value.instanceId || value.ownerInstanceId || "",
  ).trim();
  const epoch = Number(
    value.epoch === undefined ? value.ownerEpoch : value.epoch,
  );
  if (ownerRole !== "maintenance") {
    throw maintenanceFenceError(
      `Config Editor requires the maintenance owner role, not ${ownerRole || "an empty role"}`,
      "PERSISTENCE_OWNER_ROLE_INVALID",
    );
  }
  if (!instanceId) {
    throw maintenanceFenceError(
      "Config Editor maintenance fence has no instance id",
      "PERSISTENCE_OWNER_INSTANCE_INVALID",
    );
  }
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw maintenanceFenceError(
      "Config Editor maintenance fence has an invalid epoch",
      "PERSISTENCE_OWNER_EPOCH_INVALID",
    );
  }
  return { ownerRole, epoch, instanceId };
}

/**
 * Revalidate the exact exclusive maintenance fence on the caller's writable
 * SQLite connection. Call this as the first statement in a BEGIN IMMEDIATE
 * callback: that writer lock prevents a successor from advancing the durable
 * epoch between this check and the authoritative application-row writes.
 */
function assertMaintenanceFenceInTransaction(db, ownerFence, nowMs = Date.now()) {
  if (!db || db.inTransaction !== true) {
    throw maintenanceFenceError(
      "Config Editor maintenance fence must be checked inside a SQLite transaction",
      "PERSISTENCE_OWNER_TRANSACTION_REQUIRED",
    );
  }
  const fence = normalizeMaintenanceFence(ownerFence);
  const checkedAt = Number(nowMs);
  if (!Number.isFinite(checkedAt)) {
    throw new TypeError("Config Editor maintenance fence check requires a finite timestamp.");
  }
  const stored = db.prepare(
    `SELECT epoch, instance_id, active, exclusive, lease_expires_at
     FROM _persistence_owners WHERE owner_role = ?`,
  ).get(fence.ownerRole);
  if (
    !stored ||
    stored.active !== 1 ||
    stored.exclusive !== 1 ||
    stored.epoch !== fence.epoch ||
    stored.instance_id !== fence.instanceId ||
    stored.lease_expires_at <= checkedAt
  ) {
    throw maintenanceFenceError(
      `Config Editor maintenance owner epoch ${fence.epoch} is stale, inactive, non-exclusive, or expired`,
      "PERSISTENCE_OWNER_STALE",
      {
        ownerRole: fence.ownerRole,
        ownerEpoch: fence.epoch,
        leaseExpiresAt: stored ? stored.lease_expires_at : null,
      },
    );
  }
  return { ...fence, leaseExpiresAt: stored.lease_expires_at };
}

module.exports = {
  assertMaintenanceFenceInTransaction,
};
