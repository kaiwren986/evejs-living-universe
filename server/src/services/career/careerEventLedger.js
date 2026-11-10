"use strict";

// Server owners submit accepted gameplay facts. There is no RPC which accepts
// these counters from a client. Receipts and totals share the character owner
// checkpoint, and owners with a settlement intent retain it until this commits.
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const characters = require("../character/characterState");
const database = require("../../gameStore");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const FIELD = "careerActivityEvidence", LIMIT = 65536;
const SOCIAL = ["chat", "fleet", "corporation", "mail", "contact", "duel-challenge"];
const EWAR = ["web", "paint", "warp-disrupt", "warp-scramble", "weapon-disrupt"];
const EFFECTS = ["nosferatu", "neutralizer", "shield-repair", "armor-repair", ...EWAR];
const ORE_LIMITS = { 457: 4000, 458: 14000, 459: 16000, 460: 30000, 462: 49000 };
const CAPS = Object.freeze({
  "gate-jumps": 100, "scanned-wormholes": 15,
  "entered-gas-signatures": 15, "entered-combat-signatures": 15,
  "blueprint-purchased": 1,
  ...Object.fromEntries(Object.entries(ORE_LIMITS).map(([id, limit]) => [`reprocessed-ore:${id}`, limit])),
  ...Object.fromEntries(SOCIAL.map(action => [`social:${action}`, 1])),
  "economy:bounty-earned": 500000000, "economy:mission-lp-earned": 500, "economy:lp-spent": 300,
  "abyssal:entry": 1, "abyssal:completion": 5, "abyssal:triglavian-kill": 30,
  "abyssal:npc-kills": 300,
  ...Object.fromEntries([25, 420, 26].map(group => [`abyssal:npc-kills-by-hull:${group}`, 75])),
  "effect:nosferatu": 250000, "effect:neutralizer": 2000000,
  "effect:shield-repair": 2500000, "effect:armor-repair": 2500000,
  ...Object.fromEntries(EWAR.map(effect => [`effect:${effect}`, 300000])),
});
const events = new EventEmitter();
function id(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0; }
function integer(value) { return Number.isSafeInteger(value) && value > 0 ? value : 0; }
function failure(errorMsg) { return { success: false, errorMsg }; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function metricsFor(event) {
  if (!event || typeof event.id !== "string" || !event.id || event.id.length > 512) return null;
  let metric, amount = 1;
  switch (event.kind) {
    case "gate-jump":
      if (!id(event.solarSystemID)) return null;
      metric = "gate-jumps"; break;
    case "signature-resolved":
      if (!id(event.solarSystemID) || !id(event.instanceID) || event.family !== "wormhole") return null;
      metric = "scanned-wormholes"; break;
    case "site-entry":
      if (!id(event.solarSystemID) || !id(event.instanceID) ||
          !(event.siteKind === "signature" || event.family === "combat" && event.siteKind === "anomaly") ||
          !["gas", "combat"].includes(event.family)) return null;
      metric = `entered-${event.family}-signatures`; break;
    case "reprocess":
      if (!Object.hasOwn(ORE_LIMITS, event.oreGroupID) || !integer(event.amount)) return null;
      metric = `reprocessed-ore:${event.oreGroupID}`; amount = event.amount; break;
    case "blueprint-purchase": metric = "blueprint-purchased"; break;
    case "social":
      if (!SOCIAL.includes(event.action)) return null;
      metric = `social:${event.action}`; break;
    case "economy":
      if (!["bounty-earned", "mission-lp-earned", "lp-spent"].includes(event.action)) return null;
      amount = event.action === "bounty-earned" ? integer(event.amountCents) : integer(event.amount);
      if (!amount) return null;
      metric = `economy:${event.action}`; break;
    case "abyssal":
      if (!Number.isInteger(event.tier) || event.tier < 0 || event.tier > 6 ||
          !["entry", "completion", "triglavian-kill", "npc-kill"].includes(event.action) ||
          ["entry", "completion"].includes(event.action) && event.tier !== 0) return null;
      if (event.action === "npc-kill") {
        if (event.attackerGroupID !== undefined && ![25, 420, 26].includes(event.attackerGroupID)) return null;
        metric = event.attackerGroupID === undefined ? "abyssal:npc-kills"
          : `abyssal:npc-kills-by-hull:${event.attackerGroupID}`;
      } else metric = `abyssal:${event.action}`;
      break;
    case "combat-effect":
      if (!EFFECTS.includes(event.effect)) return null;
      metric = `effect:${event.effect}`;
      // Keep sub-unit effects without rounding every cycle up. Public goal
      // progress is whole seconds, HP or GJ, derived from this fixed-point sum.
      amount = EWAR.includes(event.effect) ? integer(event.durationMs)
        : Number.isFinite(event.amount) && event.amount > 0 ? Math.floor(event.amount * 1000 + 1e-7) : 0;
      if (!integer(amount)) return null;
      break;
    default: return null;
  }
  return { metric, amount, facts: Object.fromEntries(
    ["solarSystemID", "instanceID", "family", "siteKind", "oreGroupID", "action", "effect", "tier", "attackerGroupID"]
      .filter(key => event[key] !== undefined).map(key => [key, event[key]])),
  };
}
function ledgerFor(record) {
  const value = record?.[FIELD];
  if (value === undefined) return { version: 1, receipts: {}, metrics: {} };
  if (!value || value.version !== 1 || !value.receipts || !value.metrics ||
      Array.isArray(value.receipts) || Array.isArray(value.metrics) ||
      typeof value.receipts !== "object" || typeof value.metrics !== "object" ||
      Object.keys(value.receipts).length > LIMIT) throw new Error("CAREER_EVENT_LEDGER_INVALID");
  for (const [metric, entry] of Object.entries(value.metrics)) {
    if (!Object.hasOwn(CAPS, metric) || !entry || !Number.isSafeInteger(entry.value) ||
        entry.value < 0 || entry.value > CAPS[metric] || !integer(entry.updatedAtMs))
      throw new Error("CAREER_EVENT_LEDGER_INVALID");
  }
  return value;
}
function stageCharacter(record, characterID, event, options = {}) {
  const character = id(characterID), contribution = metricsFor(event);
  if (!record || !character || !contribution) return failure("CAREER_EVENT_INVALID");
  if (record.characterID !== undefined && Number(record.characterID) !== character)
    return failure("CAREER_EVENT_CHARACTER_MISMATCH");
  let ledger;
  try { ledger = ledgerFor(record); } catch (error) { return failure(error.message); }
  const key = hash(`${event.kind}:${event.id}`), fingerprint = hash(JSON.stringify(contribution));
  const previous = ledger.receipts[key];
  if (previous) return previous.fingerprint === fingerprint
    ? { success: true, data: { record, duplicate: true, changed: false } }
    : failure("CAREER_EVENT_RECEIPT_CONFLICT");
  const { metric, amount } = contribution;
  const existing = ledger.metrics[metric];
  if ((existing?.value || 0) >= CAPS[metric])
    return { success: true, data: { record, saturated: true, changed: false } };
  const gate = record.careerPendingGateArrival;
  const reservedGate = gate?.version === 2 && id(gate.characterID) === character && id(gate.shipID) &&
    id(gate.sourceSystemID) && id(gate.destinationSystemID) && Number(gate.sourceSystemID) !== Number(gate.destinationSystemID) &&
    typeof gate.transitionID === "string" &&
    gate.transitionID.length > 0 && gate.transitionID.length <= 512;
  const completingGate = reservedGate && event.kind === "gate-jump" && event.id === gate.transitionID &&
    Number(event.solarSystemID) === Number(gate.destinationSystemID);
  if (Object.keys(ledger.receipts).length >= LIMIT - (reservedGate && !completingGate ? 1 : 0))
    return failure("CAREER_EVENT_CAPACITY");
  const atMs = integer(options.nowMs) || Math.max(1, Math.trunc(getWallclockNowMs()));
  return { success: true, data: { changed: true, duplicate: false, record: { ...record,
    [FIELD]: { version: 1,
      receipts: { ...ledger.receipts, [key]: { fingerprint, atMs } },
      metrics: { ...ledger.metrics, [metric]: { value: Math.min(CAPS[metric], (existing?.value || 0) + amount),
        updatedAtMs: Math.max(existing?.updatedAtMs || 0, atMs) } },
    },
  } } };
}
function publishCommitted(characterID) {
  try { events.emit("committed", { characterID: id(characterID) }); }
  catch (error) { require("../../utils/logger").warn(`[Career] committed gameplay awaits projection: ${error.message}`); }
}
function record(characterID, event, options = {}) {
  const character = id(characterID), before = character && characters.getCharacterRecord(character);
  if (!before) return failure("CHARACTER_NOT_FOUND");
  const staged = stageCharacter(before, character, event, options);
  if (!staged.success) return staged;
  if (staged.data.changed) {
    const written = characters.updateCharacterRecord(character, () => staged.data.record);
    if (!written?.success) return written || failure("CAREER_EVENT_WRITE_FAILED");
  }
  let flushed;
  try { flushed = database.flushTableSync("characters"); }
  catch (error) { flushed = failure(error.message || "CAREER_EVENT_FLUSH_FAILED"); }
  if (!flushed?.success) {
    if (staged.data.changed && !characters.updateCharacterRecord(character, () => before)?.success)
      return { ...failure("CAREER_EVENT_ROLLBACK_FAILED"), ambiguous: true };
    return flushed || failure("CAREER_EVENT_FLUSH_FAILED");
  }
  if (options.publish !== false) publishCommitted(character);
  return { success: true, duplicate: staged.data.duplicate === true, changed: staged.data.changed === true,
    saturated: staged.data.saturated === true };
}
function supports(source) {
  return source?.kind === "career-event" && typeof source.metric === "string" && Object.hasOwn(CAPS, source.metric);
}
function isSaturated(characterID, metric) {
  if (!Object.hasOwn(CAPS, metric)) return false;
  const record = characters.getCharacterRecord(id(characterID));
  return Boolean(record && (ledgerFor(record).metrics[metric]?.value || 0) >= CAPS[metric]);
}
function observe(characterID, metric, record = null) {
  if (!Object.hasOwn(CAPS, metric)) return null;
  const character = id(characterID), current = record || (character && characters.getCharacterRecord(character));
  if (!current) return null;
  const entry = ledgerFor(current).metrics[metric];
  const scale = metric.startsWith("effect:") ? 1000 : metric === "economy:bounty-earned" ? 100 : 1;
  return { kind: "career-event", id: `${character}:career-event:${metric}:v1`,
    progress: Math.floor((entry?.value || 0) / scale), updatedAtMs: entry?.updatedAtMs || 0 };
}
module.exports = { record, stageCharacter, publishCommitted, observe, supports, isSaturated, events };
