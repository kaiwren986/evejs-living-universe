"use strict";

// Scene-owned, transient restrictions. Persistent feature intent is owned by
// the domain using the link; this projection never survives a scene teardown.
function blocksShipAction(entity, action) {
  const restriction = entity && entity.linkWithShipRestriction;
  return Boolean(restriction && restriction[action] === true);
}
function clampShipLinkMaxVelocity(entity, value) {
  const raw = entity?.linkWithShipRestriction?.maxSpeed;
  const limit = Number(raw);
  return raw != null && Number.isFinite(limit) && limit >= 0 ? Math.min(value, limit) : value;
}

module.exports = { blocksShipAction, clampShipLinkMaxVelocity };
