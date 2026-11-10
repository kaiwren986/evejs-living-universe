"use strict";

// Typed exploration observations come from completed server travel, scanning
// and dungeon-entry handlers. The AIR gateway only reads these facts.
const database = require("../../gameStore");
const world = require("../../space/worldData");
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const SPACE_CLASSES = new Set(["high", "low", "null", "wormhole"]);

function securityClass(solarSystemID) {
  const system = world.getSolarSystemByID(positive(solarSystemID));
  if (!system) return null;
  if (require("../exploration/wormholes/wormholeSpaceAuthority").getWormholeSpaceProfile(system.solarSystemID).isWormholeSpace)
    return "wormhole";
  const security = Number(system.security);
  return security >= 0.45 ? "high" : security > 0 ? "low" : "null";
}
function supports(source) {
  return source?.kind === "visited-regions" && ["high", "low", "null"].includes(source.securityClass);
}
function observe(characterID, record, definition, context = {}) {
  const source = definition?.source;
  if (!supports(source) || !positive(characterID)) return null;
  const persisted = context.careerMapVisits ||= database.readPersisted("mapTelemetry", "/");
  if (!persisted?.success) throw new Error(persisted?.errorMsg || "CAREER_VISITS_UNAVAILABLE");
  const visits = persisted.data?.visitsByCharacterID?.[String(characterID)]?.systems || {};
  const regions = new Set();
  let updatedAtMs = 0;
  for (const [id, visit] of Object.entries(visits)) {
    if (!positive(visit?.visits) || positive(visit?.solarSystemID) !== positive(id)) continue;
    const system = world.getSolarSystemByID(positive(id));
    if (!system || securityClass(system.solarSystemID) !== source.securityClass || !positive(system.regionID)) continue;
    regions.add(Number(system.regionID));
    updatedAtMs = Math.max(updatedAtMs, positive(visit.lastDateTimeMs));
  }
  return { kind: source.kind, id: `visited-regions:${source.securityClass}:v1`,
    progress: regions.size, updatedAtMs };
}
function stageStargateJump(record, characterID, transitionID, solarSystemID, options = {}) {
  if (typeof transitionID !== "string" || !transitionID || !positive(solarSystemID))
    return { success: false, errorMsg: "CAREER_GATE_IDENTITY_REQUIRED" };
  return require("./careerEventLedger").stageCharacter(record, characterID, {
    kind: "gate-jump", id: transitionID, solarSystemID: positive(solarSystemID),
  }, options);
}
function flush(table) {
  try { return database.flushTableSync(table) || { success: false, errorMsg: "CAREER_GATE_FLUSH_FAILED" }; }
  catch (error) { return { success: false, errorMsg: error.message || "CAREER_GATE_FLUSH_FAILED" }; }
}
function prepareGateArrival(characterID, intent) {
  const characters = require("../character/characterState"), character = positive(characterID);
  if (!character || !positive(intent?.shipID) || !positive(intent.sourceSystemID) ||
      !positive(intent.destinationSystemID) || typeof intent.transitionID !== "string" || !intent.transitionID ||
      intent.transitionID.length > 512 || Number(intent.sourceSystemID) === Number(intent.destinationSystemID) ||
      !world.getSolarSystemByID(intent.sourceSystemID) || !world.getSolarSystemByID(intent.destinationSystemID))
    return { success: false, errorMsg: "CAREER_GATE_INTENT_INVALID" };
  const before = characters.getCharacterRecord(character, { expectedLocationTransitionReason: "stargate-jump" });
  if (!before) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  if (database.isTransientPath("characters", `/${character}`) || database.isTransientPath("items", `/${intent.shipID}`))
    return { success: true, skipped: true };
  if (before.careerPendingGateArrival) return { success: false, errorMsg: "CAREER_GATE_ALREADY_PENDING" };
  const ledger = require("./careerEventLedger");
  try {
    if (ledger.isSaturated(character, "gate-jumps")) return { success: true, skipped: true };
  } catch (error) { return { success: false, errorMsg: error.message }; }
  // Capacity, malformed ledgers and conflicting transition IDs must refuse
  // before detaching the source ship. The pending v2 intent reserves one slot.
  const possible = stageStargateJump(before, character, intent.transitionID, positive(intent.destinationSystemID));
  if (!possible?.success) return possible;
  if (possible.data.duplicate) return { success: false, errorMsg: "CAREER_GATE_ALREADY_COMPLETED" };
  const inventory = require("../inventory/itemStore");
  const proof = inventory.getShipSpaceMoveReceipt({ ...intent, characterID: character });
  if (!proof?.success) return proof;
  if (proof.found) return { success: false, errorMsg: "CAREER_GATE_ALREADY_COMPLETED" };
  const ship = inventory.findShipItemById(intent.shipID);
  if (Number(before.shipID) !== positive(intent.shipID) || Number(ship?.ownerID) !== character || Number(ship?.flagID) !== 0 ||
      Number(ship?.locationID) !== positive(intent.sourceSystemID) || Number(ship?.spaceState?.systemID) !== positive(intent.sourceSystemID))
    return { success: false, errorMsg: "CAREER_GATE_SOURCE_CHANGED" };
  const written = characters.updateCharacterRecord(character, current => ({ ...current,
    careerPendingGateArrival: { version: 2, characterID: character, transitionID: intent.transitionID,
      shipID: positive(intent.shipID), sourceSystemID: positive(intent.sourceSystemID),
      destinationSystemID: positive(intent.destinationSystemID) },
  }));
  if (!written?.success) return written;
  const durable = flush("characters");
  if (!durable.success) {
    const rollback = characters.updateCharacterRecord(character, () => before);
    return rollback?.success ? durable : { success: false, errorMsg: "CAREER_GATE_PREPARE_ROLLBACK_FAILED" };
  }
  return { success: true, identity: characters.peekCharacterRecord(character).careerPendingGateArrival };
}
function reconcileGateArrival(characterID) {
  const characters = require("../character/characterState"), character = positive(characterID);
  const raw = character && characters.peekCharacterRecord(character), pending = raw?.careerPendingGateArrival;
  if (!pending) return { success: true, changed: false };
  if (database.isTransientPath("characters", `/${character}`) || database.isTransientPath("items", `/${pending.shipID}`))
    return { success: true, changed: false, skipped: true };
  if (![1, 2].includes(pending.version) || positive(pending.characterID) !== character || !positive(pending.shipID) ||
      !positive(pending.sourceSystemID) || !positive(pending.destinationSystemID) ||
      typeof pending.transitionID !== "string" || !pending.transitionID)
    return { success: false, errorMsg: "CAREER_GATE_INTENT_INVALID" };
  // Resolve the item owner's outbox before interpreting location. A refused
  // flush can have journaled a destination which a later owner will recover.
  const itemBarrier = flush("items");
  const persisted = database.readPersisted("items", `/${pending.shipID}`);
  if (!persisted?.success && persisted?.errorMsg !== "ENTRY_NOT_FOUND")
    return persisted || { success: false, errorMsg: "CAREER_GATE_SHIP_READ_FAILED" };
  const ship = persisted?.success && persisted.data;
  const atDestination = Number(ship?.ownerID) === character && Number(ship?.flagID) === 0 &&
    Number(ship?.locationID) === pending.destinationSystemID && Number(ship?.spaceState?.systemID) === pending.destinationSystemID;
  const proof = pending.version === 2 ? require("../inventory/itemStore").getShipSpaceMoveReceipt(pending) : null;
  if (proof && !proof.success) return proof;
  if (!itemBarrier.success) {
    // A lost acknowledgement can follow the actual item commit. Continue
    // presenting that accepted arrival while retaining the intent; otherwise
    // leave a retryable failure for the next owner to resolve after its barrier.
    const arrived = pending.version === 2 ? proof.found : atDestination;
    return { ...itemBarrier, arrived, pending: true };
  }
  const destination = pending.version === 2 ? proof.found : atDestination;
  if (pending.version === 2 && !destination) {
    // Module shutdown can synchronously publish another career observation
    // after preparation and before the inventory move. Its read must not retire
    // the very handoff still owned by this connected retail session.
    const registry = require("../chat/sessionRegistry"), live = registry.findSessionByCharacterID(character);
    const active = live?._transitionState;
    if (registry.isRegisteredSession(live) && live.socket && !live.socket.destroyed && !live._characterControlDisconnected &&
        active?.kind === "stargate-jump" && active.transitionID === pending.transitionID)
      return { success: true, changed: false, pending: true };
  }
  const source = Number(ship?.ownerID) === character && Number(ship?.flagID) === 0 &&
    Number(ship?.locationID) === pending.sourceSystemID && Number(ship?.spaceState?.systemID) === pending.sourceSystemID;
  // Old v1 intents did not retain historical movement proof. Once their body
  // moved or disappeared, retire that obsolete intent without inventing credit.
  const retiredLegacy = pending.version === 1 && !destination && !source;
  const before = characters.getCharacterRecord(character, { expectedLocationTransitionReason: "stargate-jump" });
  let next = { ...before };
  if (destination) {
    const staged = stageStargateJump(next, character, pending.transitionID, pending.destinationSystemID,
      pending.version === 2 ? { nowMs: proof.data.completedAtMs } : {});
    if (!staged?.success) return staged;
    next = { ...staged.data.record };
    if (Number(next.shipID) === pending.shipID && atDestination) {
      const system = world.getSolarSystemByID(pending.destinationSystemID);
      Object.assign(next, { stationID: null, structureID: null, solarSystemID: pending.destinationSystemID,
        constellationID: system?.constellationID || next.constellationID, regionID: system?.regionID || next.regionID });
    }
  }
  delete next.careerPendingGateArrival;
  const written = characters.updateCharacterRecord(character, () => next,
    { expectedLocationTransitionReason: "stargate-jump" });
  if (!written?.success) return written;
  const durable = flush("characters");
  if (!durable.success) {
    const rollback = characters.updateCharacterRecord(character, () => before);
    return rollback?.success ? { ...durable, arrived: destination, pending: true }
      : { success: false, errorMsg: "CAREER_GATE_ARRIVAL_ROLLBACK_FAILED", arrived: destination, pending: true };
  }
  if (retiredLegacy) require("../../utils/logger").warn(`[Career] Retired unprovable legacy gate arrival char=${character} transition=${pending.transitionID}; no travel credit granted`);
  if (destination) require("./careerEventLedger").publishCommitted(character);
  return { success: true, changed: true, arrived: destination, retiredLegacy };
}
function recordResolvedWormholes(characterID, solarSystemID, signatureIDs, options = {}) {
  const runtime = require("../exploration/signatures/signatureRuntime");
  for (const targetID of new Set(signatureIDs || [])) {
    const site = runtime.resolveSiteByTargetID(solarSystemID, targetID, options);
    if (site?.family !== "wormhole" || site.siteKind !== "signature" ||
        !positive(site.pairID) || !positive(site.endpointID)) continue;
    const result = require("./careerEventLedger").record(characterID, {
      kind: "signature-resolved", id: `wormhole:${solarSystemID}:${site.pairID}:${site.endpointID}`,
      solarSystemID: positive(solarSystemID), instanceID: positive(site.endpointID), family: "wormhole",
    });
    if (!result?.success) return result || { success: false, errorMsg: "CAREER_SCAN_WRITE_FAILED" };
  }
  return { success: true };
}
function recordSiteEntry(characterID, instance, roomKey, solarSystemID) {
  if (String(roomKey) !== "room:entry" || !positive(instance?.instanceID)) return { success: true };
  const actual = require("../dungeon/dungeonRuntime").getInstance(instance.instanceID);
  if (!actual || actual.templateID !== instance.templateID ||
      Number(actual.solarSystemID) !== Number(solarSystemID) || actual.siteKind !== "signature" ||
      !["gas", "combat"].includes(actual.siteFamily) || actual.instanceScope === "private" ||
      actual.ownership?.visibilityScope === "private" || actual.ownership?.missionOwnerCharacterID ||
      actual.metadata?.missionRuntime === true || actual.metadata?.privateOperation === true ||
      actual.runtimeFlags?.missionRuntime === true) return { success: true };
  return require("./careerEventLedger").record(characterID, {
    kind: "site-entry", id: `dungeon:${actual.instanceID}`, solarSystemID: positive(actual.solarSystemID),
    instanceID: positive(actual.instanceID), family: actual.siteFamily, siteKind: "signature",
  });
}

module.exports = { observe, supports, securityClass, stageStargateJump, prepareGateArrival, reconcileGateArrival,
  recordResolvedWormholes, recordSiteEntry, SPACE_CLASSES };
