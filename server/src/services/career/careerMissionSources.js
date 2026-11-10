"use strict";

// Mission evidence is staged inside the mission owner's completion checkpoint.
// It outlives the 128-entry journal without retaining another mission snapshot.
const { readDurablePath } = require("./careerOwnerReads");
// A career agent's chain: one metric per part ("career-agent-<division>-<part>"), each done once.
const CAREER_AGENT_CAPS = Object.fromEntries(Object.entries(require("../agent/careerAgentMissions").listChainLengths())
  .flatMap(([divisionID, length]) => Array.from({ length }, (_, index) => [`career-agent-${divisionID}-${index + 1}`, 1])));
const CAPS = Object.freeze({ "security-level-1": 20, distribution: 20, mining: 20,
  "bloodstained-stars": 20, "mission-lp": 500, ...CAREER_AGENT_CAPS });
const FIELD = "careerProgramMissionEvidence";
// The persisted bloodstained-stars metric now counts every validated epic arc.
// Retaining its key preserves saved progress and paid claim identities.
const safe = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const clone = value => structuredClone(value);
function readLedger(character) {
  const ledger = character?.[FIELD];
  if (ledger === undefined) return { version: 1, counts: {}, updatedAtMs: {}, receipts: {} };
  if (!ledger || ledger.version !== 1 || !ledger.counts || !ledger.updatedAtMs || !ledger.receipts ||
      Array.isArray(ledger.receipts) || Object.keys(ledger.receipts).length > 1024) return null;
  for (const [metric, value] of Object.entries(ledger.counts)) {
    if (!CAPS[metric] || !Number.isSafeInteger(value) || value < 0 || value > CAPS[metric]) return null;
  }
  return clone(ledger);
}
function stageCompletion(characterState, characterID, agent, mission, nowMs = Date.now()) {
  const id = safe(characterID), sequence = safe(mission?.missionSequence), agentID = safe(agent?.agentID);
  if (!id || safe(characterState?.characterID) !== id || !sequence || !agentID ||
      safe(mission?.agentID) !== agentID || mission.runtimeStatus !== "accepted" ||
      mission.placeholder !== false || mission.gmCompleted === true) return { success: true, changed: false };
  const native = require("../agent/missionAuthority").getMissionByID(mission.contentID);
  if (!native) return { success: true, changed: false };
  const metrics = {};
  // Keep the persisted metric name so earned progress and paid claims retain
  // their identity. All installed, validated epic arcs qualify for the generic
  // native "Epic Arc Missions" goals.
  if (native.isEpicArc === true && Number(native.epicArcID) > 0) metrics["bloodstained-stars"] = 1;
  if (Number(agent.agentTypeID) === 2 && native.isEpicArc !== true && native.isStoryline !== true &&
      native.isGenericStoryline !== true && native.isResearch !== true && mission.importantMission !== true) {
    const kind = String(agent.missionKind || "").toLowerCase();
    if (["security", "encounter"].includes(kind) && Number(agent.level) === 1) metrics["security-level-1"] = 1;
    if (["courier", "distribution"].includes(kind)) metrics.distribution = 1;
    if (kind === "mining") metrics.mining = 1;
    const lp = safe(mission.rewards?.loyaltyPoints);
    if (lp && safe(agent.corporationID) !== 1000419) metrics["mission-lp"] = lp;
  }
  const careerPart = Number(agent.agentTypeID) === 12
    ? require("../agent/careerAgentMissions").getChainPart(agent, mission.contentID) : null;
  if (careerPart) metrics[`career-agent-${careerPart.divisionID}-${careerPart.part}`] = 1;
  if (!Object.keys(metrics).length) return { success: true, changed: false };
  const ledger = readLedger(characterState);
  if (!ledger) return { success: false, errorMsg: "CAREER_MISSION_EVIDENCE_INVALID" };
  const receiptID = `${agentID}:${sequence}`;
  const existing = ledger.receipts[receiptID];
  if (existing) {
    if (String(existing.contentID) !== String(mission.contentID)) return { success: false, errorMsg: "CAREER_MISSION_SOURCE_CONFLICT" };
    return { success: true, changed: false, duplicate: true };
  }
  const increments = Object.entries(metrics).filter(([metric]) => (ledger.counts[metric] || 0) < CAPS[metric]);
  if (!increments.length) return { success: true, changed: false };
  if (Object.keys(ledger.receipts).length >= 1024) return { success: false, errorMsg: "CAREER_MISSION_EVIDENCE_CAPACITY" };
  const time = safe(Math.trunc(nowMs)) || 1;
  ledger.receipts[receiptID] = { contentID: mission.contentID, completedAtMs: time };
  for (const [metric, amount] of increments) {
    ledger.counts[metric] = Math.min(CAPS[metric], (ledger.counts[metric] || 0) + amount);
    ledger.updatedAtMs[metric] = Math.max(ledger.updatedAtMs[metric] || 0, time);
  }
  characterState[FIELD] = ledger;
  return { success: true, changed: true };
}
function observe(characterID, record, definition, context = {}) {
  const metric = definition.source?.metric;
  if (!CAPS[metric]) return null;
  const character = readDurablePath("missionRuntimeState", `/charactersByID/${characterID}`,
    context, "CAREER_MISSION_SOURCE_UNAVAILABLE");
  if (character && safe(character.characterID) !== safe(characterID)) return null;
  const ledgers = context.careerMissionLedgers ||= new Map();
  if (!ledgers.has(characterID)) ledgers.set(characterID, readLedger(character));
  const ledger = ledgers.get(characterID);
  if (!ledger) throw new Error("CAREER_MISSION_EVIDENCE_INVALID");
  return { kind: "mission-evidence", id: `mission-evidence:${metric}:v1`,
    progress: ledger.counts[metric] || 0, updatedAtMs: ledger.updatedAtMs[metric] || 0 };
}
function supports(source) { return source?.kind === "mission-evidence" && Object.hasOwn(CAPS, source.metric); }
module.exports = { observe, stageCompletion, supports, CAPS };
