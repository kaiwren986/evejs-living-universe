"use strict";

const { handledResult } = require("./commandReplies");
const { hasStaffDebugRole } = require("./commandAccess");
const { buildDict } = require("../../_shared/serviceHelpers");
const { canEntitiesInteractLocally } = require("../../../space/destiny/identity/interactionScope");
const { requireEntityID } = require("../../../space/destiny/identity/entityID");

function handleReportDesyncCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("/reportdesync requires a staff/admin role.");
  if (String(argumentText || "").trim()) return reply("Usage: /reportdesync");
  const scene = require("../../../space/runtime").getSceneForSession(session);
  const ego = scene && scene.getShipEntityForSession(session);
  if (!ego) return reply("Enter space before using /reportdesync.");
  // svc_console.py compares this six-value vector against each client Ball at
  // bp.currentTime. The time is Evolve's counter, not wall-clock milliseconds.
  const rows = scene.getVisibleEntitiesForSession(session)
    .filter((entity) => !entity.removed && !entity.destroyed && canEntitiesInteractLocally(ego, entity))
    .map((entity) => [requireEntityID(entity.itemID), [
      entity.position.x, entity.position.y, entity.position.z,
      entity.velocity?.x || 0, entity.velocity?.y || 0, entity.velocity?.z || 0,
    ]]);
  return { ...reply(`Reported ${rows.length} visible balls at Destiny tick ${scene.destinyTick}.`),
    returnValue: [buildDict(rows), scene.destinyTick] };
}

module.exports = { handleReportDesyncCommand };
