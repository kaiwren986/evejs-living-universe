"use strict";

// Health owners carry durable outcomes. The incursion encounter consumes them;
// this carrier never decides fleet eligibility or publishes economic progress.
const crypto = require("node:crypto");
const database = require("../../gameStore");
const items = require("./itemStore");
const ITEM_KEY = "__evejsIncursionCombatOutcomes";
const NPC_KEY = "incursionOutcomes";
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const clone = value => structuredClone(value);
function storageKey(eventID) { return crypto.createHash("sha256").update(eventID).digest("hex"); }
function normalizeCompletionTaxProfiles(profiles, presence) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles) || !Array.isArray(presence)) {
    throw new Error("INCURSION_COMPLETION_TAX_SNAPSHOT_INVALID");
  }
  const ids = presence.map(row => row.characterID);
  if (ids.some(id => !positive(id)) || new Set(ids).size !== ids.length ||
      Object.keys(profiles).length !== ids.length || Object.keys(profiles).some(key => !ids.includes(Number(key)) || String(Number(key)) !== key)) {
    throw new Error("INCURSION_COMPLETION_TAX_SNAPSHOT_INVALID");
  }
  return Object.fromEntries([...ids].sort((a, b) => a - b).map(id => {
    const profile = profiles[id];
    if (!profile || typeof profile !== "object" || Array.isArray(profile) ||
        Object.keys(profile).sort().join(",") !== "corporationID,isNPC,loyaltyPointTaxRate,taxRate" ||
        !integer(profile.corporationID) || typeof profile.isNPC !== "boolean" ||
        !Number.isFinite(profile.taxRate) || profile.taxRate < 0 || profile.taxRate > 1 ||
        !Number.isFinite(profile.loyaltyPointTaxRate) || profile.loyaltyPointTaxRate < 0 || profile.loyaltyPointTaxRate > 1) {
      throw new Error("INCURSION_COMPLETION_TAX_SNAPSHOT_INVALID");
    }
    return [id, { corporationID: profile.corporationID, isNPC: profile.isNPC,
      taxRate: profile.taxRate, loyaltyPointTaxRate: profile.loyaltyPointTaxRate }];
  }));
}
function normalizeEvent(event) {
  if (!event || typeof event.eventID !== "string" || !event.eventID || event.eventID.length > 512 ||
      typeof event.operationID !== "string" || !/^[A-Za-z0-9:_-]{1,180}$/.test(event.operationID) ||
      !positive(event.instanceID) || !["damage", "repair"].includes(event.kind) ||
      !integer(event.characterID) || !integer(event.fleetID) ||
      !Number.isFinite(event.amount) || event.amount < 0 ||
      typeof event.targetKey !== "string" || !event.targetKey || event.targetKey.length > 180 ||
      !positive(event.targetEntityID) || !positive(event.targetTypeID) || !integer(event.targetCharacterID) ||
      !integer(event.sourceShipID) || !integer(event.moduleID) || !positive(event.atMs) ||
      event.destroyed !== undefined && typeof event.destroyed !== "boolean" ||
      event.kind === "repair" && (!positive(event.characterID) || !positive(event.sourceShipID) || !positive(event.moduleID) || !positive(event.targetCharacterID) || !(event.amount > 0))) {
    throw new Error("INCURSION_COMBAT_EVENT_INVALID");
  }
  const hasPresence = event.completionPresence !== undefined, hasWallTime = event.completionWallTimeMs !== undefined;
  let completion = {};
  if (hasPresence || hasWallTime || event.completionTaxProfiles !== undefined) {
    if (event.kind !== "damage" || !hasPresence || !hasWallTime || !positive(event.completionWallTimeMs) ||
        !Array.isArray(event.completionPresence) || event.completionPresence.length > 4096) throw new Error("INCURSION_COMPLETION_SNAPSHOT_INVALID");
    const seen = new Set();
    const presence = event.completionPresence.map(row => {
      if (!row || !positive(row.characterID) || seen.has(row.characterID) || !integer(row.fleetID) ||
          typeof row.activeShip !== "boolean" || typeof row.cloaked !== "boolean" || !positive(row.groupID)) {
        throw new Error("INCURSION_COMPLETION_SNAPSHOT_INVALID");
      }
      seen.add(row.characterID);
      return { characterID: row.characterID, fleetID: row.fleetID, activeShip: row.activeShip, cloaked: row.cloaked, groupID: row.groupID };
    }).sort((a, b) => a.characterID - b.characterID);
    completion = { completionPresence: presence, completionWallTimeMs: event.completionWallTimeMs,
      ...(event.completionTaxProfiles === undefined ? {} : {
        completionTaxProfiles: normalizeCompletionTaxProfiles(event.completionTaxProfiles, presence),
      }) };
  }
  let death = {};
  if (event.deathPosition !== undefined) {
    if (event.kind !== "damage" || event.destroyed !== true || !(event.amount > 0) || !hasWallTime ||
        !event.deathPosition || ["x", "y", "z"].some(axis => !Number.isFinite(event.deathPosition[axis]))) {
      throw new Error("INCURSION_DEATH_POSITION_INVALID");
    }
    death = { deathPosition: Object.fromEntries(["x", "y", "z"].map(axis => [axis, event.deathPosition[axis]])) };
  }
  return { eventID: event.eventID, operationID: event.operationID, instanceID: event.instanceID,
    kind: event.kind, characterID: event.characterID, fleetID: event.fleetID, amount: event.amount,
    targetKey: event.targetKey, targetEntityID: event.targetEntityID, targetTypeID: event.targetTypeID,
    targetCharacterID: event.targetCharacterID, sourceShipID: event.sourceShipID, moduleID: event.moduleID,
    atMs: event.atMs, destroyed: event.destroyed === true, ...completion, ...death };
}
function rollback(entity, previousConditionState) {
  if (entity && previousConditionState) entity.conditionState = clone(previousConditionState);
}
function commitNpcDamage(options = {}) {
  return require("../../space/npc/nativeNpcService").commitIncursionDamageOutcome(options);
}
function commitPlayerRepair({ targetEntity, event, changedEntities = [], previousConditionState, careerOutcome = null } = {}) {
  try {
    const normalized = normalizeEvent(event);
    if (normalized.kind !== "repair" || !previousConditionState || !targetEntity ||
        targetEntity.nativeNpc === true || targetEntity.kind !== "ship" ||
        Number(targetEntity.itemID) !== normalized.targetEntityID ||
        Number(targetEntity.typeID) !== normalized.targetTypeID ||
        Number(targetEntity.characterID || targetEntity.pilotCharacterID || targetEntity.session?.characterID) !== normalized.targetCharacterID) {
      throw new Error("INCURSION_REPAIR_TARGET_MISMATCH");
    }
    const source = items.findShipItemById(normalized.sourceShipID), module = items.findItemById(normalized.moduleID);
    const target = items.findShipItemById(normalized.targetEntityID);
    if (Number(source?.ownerID) !== normalized.characterID || Number(target?.ownerID) !== normalized.targetCharacterID ||
        Number(module?.ownerID) !== normalized.characterID || Number(module?.locationID) !== normalized.sourceShipID ||
        module.moduleState?.online !== true || !((module.flagID >= 11 && module.flagID <= 34) || (module.flagID >= 92 && module.flagID <= 99))) {
      throw new Error("INCURSION_REPAIR_OWNER_MISMATCH");
    }
    const after = targetEntity.conditionState || {};
    const actualAmount = Math.max(0, (Number(after.shieldCharge) - Number(previousConditionState.shieldCharge)) * (Number(targetEntity.shieldCapacity) || 0)) +
      Math.max(0, (Number(previousConditionState.armorDamage) - Number(after.armorDamage)) * (Number(targetEntity.armorHP) || 0)) +
      Math.max(0, (Number(previousConditionState.damage) - Number(after.damage)) * (Number(targetEntity.structureHP) || 0));
    if (!Number.isFinite(actualAmount) || actualAmount <= 0 || Math.abs(normalized.amount - actualAmount) > Math.max(1e-6, actualAmount * 1e-9)) {
      throw new Error("INCURSION_REPAIR_AMOUNT_MISMATCH");
    }
    const entities = [...new Map([...changedEntities, targetEntity].map(entity => [Number(entity.itemID), entity])).values()];
    const conditionUpdates = entities.map(entity => {
      const item = items.findShipItemById(entity.itemID);
      if (!item || entity.nativeNpc === true || entity.kind !== "ship" ||
          ![normalized.sourceShipID, normalized.targetEntityID].includes(Number(entity.itemID)) ||
          Number(item.ownerID) !== (Number(entity.itemID) === normalized.targetEntityID ? normalized.targetCharacterID : normalized.characterID)) {
        throw new Error("INCURSION_REPAIR_ITEM_MISMATCH");
      }
      return { itemID: Number(entity.itemID), ownerID: Number(item.ownerID), typeID: Number(item.typeID), conditionState: entity.conditionState };
    });
    const result = items.commitIncursionCombatOutcome({ event: normalized, conditionUpdates, careerOutcome });
    if (!result?.success && result?.accepted !== true) rollback(targetEntity, previousConditionState);
    if (result?.duplicate) targetEntity.conditionState = clone(items.findShipItemById(normalized.targetEntityID)?.conditionState || result.receipt.conditionState);
    return result;
  } catch (error) {
    rollback(targetEntity, previousConditionState);
    return { success: false, handled: true, errorMsg: error.message };
  }
}
function persisted(table, key) {
  const result = database.readPersisted(table, `/${key}`);
  if (result?.success) return { success: true, data: result.data || {} };
  if (["ENTRY_NOT_FOUND", "SQLITE_TABLE_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result?.errorMsg)) return { success: true, data: {} };
  return result || { success: false, errorMsg: "INCURSION_COMBAT_READ_FAILED" };
}
function listPending({ instanceID } = {}) {
  if (instanceID !== undefined && !positive(instanceID)) return { success: false, errorMsg: "INCURSION_INSTANCE_INVALID" };
  const rows = [];
  for (const [table, carrier] of [["npcEntities", "npc"], ["items", "items"]]) {
    const result = database.readPersistedIncursionPending(table, instanceID);
    if (!result.success) return result;
    for (const receipt of result.data) rows.push({ ...receipt, carrier });
  }
  rows.sort((a, b) => a.event.atMs - b.event.atMs || a.event.eventID.localeCompare(b.event.eventID));
  return { success: true, data: rows };
}
function acknowledge(eventID) {
  if (typeof eventID !== "string" || !eventID) return { success: false, errorMsg: "INCURSION_EVENT_INVALID" };
  const key = storageKey(eventID);
  let found = false;
  for (const [table, collection] of [["npcEntities", NPC_KEY], ["items", ITEM_KEY]]) {
    const result = database.read(table, `/${collection}/${key}`);
    if (!result.success) continue;
    const receipt = result.data;
    if (receipt?.event?.eventID !== eventID) return { success: false, errorMsg: "INCURSION_COMBAT_RECEIPT_CONFLICT" };
    found = true;
    if (table === "items") {
      const saved = items.acknowledgeIncursionCombatOutcome(eventID);
      if (!saved.success) return saved;
    } else {
      if (receipt.acknowledged !== true) {
        const saved = database.write(table, `/${collection}/${key}`, { ...receipt, acknowledged: true });
        if (!saved.success) return saved;
      }
      const flushed = database.flushTableSync(table);
      if (!flushed.success) return { ...flushed, errorMsg: "INCURSION_COMBAT_ACK_PENDING" };
    }
  }
  return found ? { success: true } : { success: false, errorMsg: "INCURSION_COMBAT_RECEIPT_NOT_FOUND" };
}
// Acknowledgement and actor cleanup do not erase the health owner's proof.
// Physical drop consumers must read this owner, rather than trusting a copied
// encounter retirement or the disappearance of a live NPC.
function readNpcOutcome(eventID) {
  if (typeof eventID !== "string" || !eventID || eventID.length > 512) return { success: false, errorMsg: "INCURSION_EVENT_INVALID" };
  const flushed = database.flushTableSync("npcEntities");
  if (!flushed.success) return flushed;
  const result = persisted("npcEntities", `${NPC_KEY}/${storageKey(eventID)}`);
  if (!result.success) return result;
  if (!result.data.event) return { success: true, found: false };
  if (result.data.version !== 1 || result.data.event.eventID !== eventID) return { success: false, errorMsg: "INCURSION_COMBAT_RECEIPT_CONFLICT" };
  return { success: true, found: true, data: clone(result.data) };
}
function fence() {
  try { return database.flushTablesSync(["npcEntities", "items"]); }
  catch (error) { return { success: false, errorMsg: error.message }; }
}
module.exports = { normalizeEvent, normalizeCompletionTaxProfiles, storageKey, commitNpcDamage, commitPlayerRepair,
  listPending, readNpcOutcome, acknowledge, fence, ITEM_KEY, NPC_KEY };
