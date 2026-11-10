"use strict";

const { contract } = require("../../services/dungeon/visionsSceneRuntime");

const SCREEN_TYPES = new Set([93944, 93947]);
const FULL_RESONANCE = Object.freeze({ em: 1, thermal: 1, kinetic: 1, explosive: 1 });
const AUTHORED_SCREEN_RESONANCES = Object.freeze({
  shield: FULL_RESONANCE, armor: FULL_RESONANCE, structure: FULL_RESONANCE,
});

function resolveAuthoredLayerResonances(instance, template, source, target) {
  const policy = contract(template);
  const instanceID = Number(instance?.instanceID);
  const caldari = require("../../services/dungeon/visionsCaldariRuntime");
  const admitted = caldari.policy(instance, template);
  const protectedCivilian = admitted && target?.nativeNpc === true && Number(target.typeID) === 93937 &&
    /^protected-civilian-[1-5]$/.test(target.dungeonSiteContentKey || "") &&
    target.dungeonEncounterKey === `instance:${instanceID}:protected-civilians` &&
    Number(target.dungeonSiteInstanceID) === instanceID &&
    Number(source?.dungeonCurrentInstanceID || source?.dungeonSiteInstanceID) === instanceID;
  if (protectedCivilian) {
    const progress = caldari.state(instance);
    return progress?.phase === "protect" && progress.clock.ownerPresent === true &&
      admitted.actors?.civilianResonance === 1 ? AUTHORED_SCREEN_RESONANCES : null;
  }
  // Native ENEMY_FLEET_VULNERABLE begins only after the protection narrative.
  // Previously accepted 1.0.0 scenes retain their existing combat contract.
  if (admitted && caldari.state(instance)?.phase !== "destroy") return null;
  if (!policy || policy.missionID !== 17184 || Number(template.sourceDungeonID) !== 14098 ||
      !policy.authoredVulnerableEncounterKeys?.includes("federation-screen") ||
      !(instanceID > 0) || String(instance.templateID) !== String(template.templateID) ||
      !["seeded", "active", "paused"].includes(instance.lifecycleState) ||
      target?.nativeNpc !== true || !SCREEN_TYPES.has(Number(target.typeID)) ||
      Number(target.dungeonSiteInstanceID) !== instanceID ||
      Number(source?.dungeonCurrentInstanceID || source?.dungeonSiteInstanceID) !== instanceID ||
      target.dungeonEncounterKey !== `instance:${instanceID}:federation-screen`) return null;
  // Retail shows these ten screen actors taking weapon damage and dying, but
  // the native static types are immune. Their actual server resistance tuning
  // is unrecovered. This explicit scene policy is authored playability tuning.
  return AUTHORED_SCREEN_RESONANCES;
}

function resolveLayerResonanceOverrides(scene, source, target) {
  if (target?.nativeNpc !== true || ![93937, ...SCREEN_TYPES].includes(Number(target.typeID)) ||
      !(Number(target.dungeonSiteInstanceID) > 0) ||
      scene?.getEntityByID?.(source?.itemID) !== source ||
      scene?.getEntityByID?.(target.itemID) !== target) return null;
  const instance = require("../../services/dungeon/dungeonRuntime").getInstance(target.dungeonSiteInstanceID);
  if (!instance || Number(instance.solarSystemID) !== Number(scene.systemID)) return null;
  const template = require("../../services/dungeon/dungeonAuthority").getTemplateByID(instance.templateID);
  return resolveAuthoredLayerResonances(instance, template, source, target);
}

module.exports = { resolveAuthoredLayerResonances, resolveLayerResonanceOverrides };
