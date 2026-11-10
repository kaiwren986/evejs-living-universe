"use strict";

const { resolveEntityInteractionScope } = require("../../destiny/identity/interactionScope");

function resolveAbyssalNpcBoundaryDirection(scene, entity, controller) {
  const boundary = entity && entity.evejsAbyssalNpcBoundary;
  if (!boundary) {
    controller.avoidingAbyssalBoundary = false;
    return null;
  }
  const scope = resolveEntityInteractionScope(entity);
  const position = entity && entity.position;
  const origin = boundary && boundary.origin;
  const radius = Number(boundary && boundary.radiusMeters);
  if (
    !scope.valid || !scope.hasAbyssalRoomScope ||
    Number(scope.abyssalInstanceID) !== boundary.runID ||
    Number(scope.abyssalRoomIndex) !== boundary.roomIndex ||
    !scene || scene.sceneKey !== `abyssal-run:${boundary.runID}` ||
    entity.sceneKey !== scene.sceneKey ||
    !(scene.dynamicEntities instanceof Map) ||
    scene.dynamicEntities.get(entity.itemID) !== entity ||
    entity.hiddenDuringAbyssalPrewarm === true ||
    !position || !origin ||
    ![position.x, position.y, position.z, origin.x, origin.y, origin.z].every(Number.isFinite) ||
    !Number.isFinite(radius) || radius <= 0
  ) {
    controller.avoidingAbyssalBoundary = false;
    return null;
  }

  const offset = {
    x: position.x - origin.x,
    y: position.y - origin.y,
    z: position.z - origin.z,
  };
  const distance = Math.hypot(offset.x, offset.y, offset.z);
  const velocity = entity.velocity || {};
  const speed = Math.max(
    Number(entity.maxVelocity) || 0,
    Math.hypot(Number(velocity.x) || 0, Number(velocity.y) || 0, Number(velocity.z) || 0),
  );
  // Leave room to turn before reaching the perimeter. Hysteresis keeps an
  // orbit from alternating commands at the edge. This changes steering only:
  // inertia, bumps and fast targets can still carry an NPC outside the room.
  const clearance = Math.min(radius * 0.2, Math.max(2_000, speed * 2));
  const safeDistance = radius - clearance * (controller.avoidingAbyssalBoundary ? 2 : 1);
  controller.avoidingAbyssalBoundary = distance > safeDistance;
  if (!controller.avoidingAbyssalBoundary || distance <= 0) {
    return null;
  }
  return { x: -offset.x / distance, y: -offset.y / distance, z: -offset.z / distance };
}

module.exports = { resolveAbyssalNpcBoundaryDirection };
