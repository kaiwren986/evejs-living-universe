"use strict";

const runtime = require("../../../space/runtime");
const { destroyCombatEntity, isRuntimeEntityDestroyingOrDestroyed } = require("../../../space/runtime/combatDestruction");
const { canEntitiesInteractLocally } = require("../../../space/destiny/identity/interactionScope");
const { hasStaffDebugRole } = require("./commandAccess");
const { handledResult } = require("./commandReplies");
const { finishNativeGmCompanionRetirement } = require("./nativeCompanionRetirement");

// gridutils and tournamentRefereeTools use /heal <entityID> 0 to destroy,
// rather than repair, an entity. Keep it on the normal destruction owner.
function handleNativeDestroyCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!hasStaffDebugRole(session)) return reply("Destructive /heal requires a staff/admin role.");
  const match = /^(\d+)\s+0$/.exec(String(argumentText || "").trim());
  const id = match && Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return reply("Usage: /heal <entityID> 0");
  const scene = runtime.getSceneForSession(session), ego = scene && scene.getShipEntityForSession(session);
  const entity = scene && scene.getEntityByID(id);
  if (!ego || !entity || !canEntitiesInteractLocally(ego, entity) ||
      !scene.getVisibleEntitiesForSession(session).includes(entity) || isRuntimeEntityDestroyingOrDestroyed(entity)) {
    return reply("Destruction target is not available in your local scene.");
  }
  const result = destroyCombatEntity(scene, entity, {
    destructionReason: "gm-command", skipInsurance: true, insuranceSuppressedReason: "gm-command",
    destructionNowMs: scene.getCurrentSimTimeMs(),
  });
  finishNativeGmCompanionRetirement(scene, entity, result);
  return reply(result.success ? `Destroyed entity ${id}.` : `Destruction refused: ${result.errorMsg || "UNKNOWN"}.`);
}

module.exports = { handleNativeDestroyCommand };
