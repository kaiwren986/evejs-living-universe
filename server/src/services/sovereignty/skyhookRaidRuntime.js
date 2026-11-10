"use strict";

const { randomUUID } = require("node:crypto");
const log = require("../../utils/logger");
const modern = require("./sovModernState");
const { settleSkyhookHarvest } = require("./skyhookHarvest");
const orbitalState = require("../planet/planetOrbitalState");
const itemStore = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const linkRuntime = require("../spaceComponents/linkWithShipRuntime");
const { getStructureLocatorProfile, rotateVectorByRotation } = require("../structure/structureLocatorGeometry");
const { peekCharacterRecord } = require("../character/characterState");
const { createNotification } = require("../notifications/notificationState");
const { NOTIFICATION_TYPE, NOTIFICATION_GROUP } = require("../notifications/notificationConstants");
const sessionRegistry = require("../chat/sessionRegistry");
const worldData = require("../../space/worldData");
const { getWallclockNowMs, toFileTimeFromMs } = require("../../space/runtime/runtimeClock");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const { SILO_TYPE_ID, SKYHOOK_TYPE_ID, SILO_LINK_RULES,
  RAID_WINDOW_MS, SILO_SHIELD_LINK_THRESHOLD, isWindowOpen, sampleNextWindow } = require("./skyhookRaidRules");

const DURABLE_RAID_JOB_TYPE = "skyhook.raid-resume";
const schedulerBinding = createDurableSchedulerBinding({ requires: ["schedule", "cancel"] });
const admissions = new Set();
const sceneVersions = new WeakMap();
const sceneRetryAtMs = new WeakMap();
let revision = 0;
function space() { return require("../../space/runtime"); }
function database() { return require("../../gameStore"); }
function requireSuccess(result) {
  if (!result || !result.success) throw new Error(result && result.errorMsg || "SKYHOOK_OWNER_COMMAND_FAILED");
  return result.data;
}
function read(id) { return modern.getRaidSkyhook(Number(id)); }
function change(id, mutation) {
  const result = modern.mutateSkyhookRaid(id, mutation);
  revision += 1;
  return result;
}
function fingerprint(item) {
  return item ? [item.itemID, item.typeID, item.createdAtMs || 0, item.ownerID, item.locationID].join(":") : "";
}
function hasDeployedParent(record) {
  const item = itemStore.findItemById(record.skyhookID);
  return Boolean(item && item.typeID === SKYHOOK_TYPE_ID && item.flagID === 0 &&
    item.locationID === record.solarSystemID && Number(item.ownerID) === Number(record.corporationID) &&
    !record.destroyed);
}
function isParentPresent(record) {
  return hasDeployedParent(record) && fingerprint(itemStore.findItemById(record.skyhookID)) === record.raid.parentFingerprint;
}
function parentIsLiveInScene(record, scene) {
  const parent = scene && scene.getEntityByID(record.skyhookID);
  return Boolean(parent && parent.typeID === SKYHOOK_TYPE_ID &&
    Number(parent.ownerID) === Number(record.corporationID) && !parent.destroyed &&
    Number(parent.conditionState?.damage || 0) < 1 &&
    scene.systemID === record.solarSystemID && scene.sceneKind === "solarSystem" && !Number(scene.instanceID));
}
function siloPosition(record) {
  const item = itemStore.findItemById(record.skyhookID);
  const orbital = orbitalState.getOrbitalByID(record.skyhookID);
  const parentPosition = item && item.spaceState && item.spaceState.position;
  const locator = getStructureLocatorProfile(SKYHOOK_TYPE_ID)?.directionalLocators.find((entry) => entry.name === "siloPlacement");
  if (!parentPosition || !locator) throw new Error("SKYHOOK_SILO_GEOMETRY_AUTHORITY_MISSING");
  const offset = rotateVectorByRotation(locator.position, orbital && orbital.dunRotation || [0, 0, 0]);
  return Object.fromEntries(["x", "y", "z"].map((axis) => [axis, Number(parentPosition[axis]) + offset[axis]]));
}
function mintSpace(ownerID, systemID, typeID, key, reason, options) {
  return custody.transfer({ to: { kind: custody.CUSTODY_REF_KIND.IN_SPACE,
    ownerID, locationID: systemID, flagID: 0 }, actor: ownerID, reason,
  items: { typeID, quantity: 1, options }, idempotencyKey: key });
}
function receiptItemID(result) {
  const data = result && result.data;
  return Number(data && (data.item?.itemID || data.items?.[0]?.itemID || data.receipt?.resultData?.itemIDs?.[0])) || 0;
}
function initializeRecord(record) {
  const item = itemStore.findItemById(record.skyhookID);
  if (!item || item.typeID !== SKYHOOK_TYPE_ID || item.flagID !== 0 || record.destroyed) return record;
  if (record.raid && record.raid.parentFingerprint === fingerprint(item) && !record.raid.closed) return record;
  if (record.raid?.pendingSettlement) throw new Error("SKYHOOK_OLD_RAID_SETTLEMENT_PENDING");
  const generation = randomUUID();
  const position = siloPosition(record);
  change(record.skyhookID, (next) => {
    next.raid = { schemaVersion: 1, generation, parentFingerprint: fingerprint(item),
      siloID: null, siloReceiptKey: `skyhook-silo:${next.skyhookID}:${generation}`,
      position, shieldCharge: 1, activeLink: null, pendingSettlement: null,
      completedLink: null, lastSettlement: null, windowStartedMs: null, closed: false };
  });
  return read(record.skyhookID);
}
function ensureSilo(record) {
  if (!record.raid || record.raid.closed || record.destroyed) return record;
  if (!record.raid.siloID) {
    const result = mintSpace(record.corporationID, record.solarSystemID, SILO_TYPE_ID,
      record.raid.siloReceiptKey, custody.CUSTODY_REASON.SKYHOOK_SILO_CREATE, {
        position: record.raid.position, itemName: "Skyhook Reagent Silo",
        customInfo: JSON.stringify({ evejsSkyhookSilo: { skyhookID: record.skyhookID, generation: record.raid.generation } }),
      });
    requireSuccess(result);
    const siloID = receiptItemID(result);
    if (!siloID || !itemStore.findItemById(siloID)) throw new Error("SKYHOOK_SILO_RECEIPT_ITEM_MISSING");
    change(record.skyhookID, (next) => { next.raid.siloID = siloID; });
    record = read(record.skyhookID);
  }
  return record;
}
function parseInfo(item) {
  try { return JSON.parse(item && item.customInfo || "{}"); } catch (_) { return {}; }
}
function hydrateSilo(entity, item) {
  const marker = parseInfo(item).evejsSkyhookSilo;
  if (!marker || Number(item.typeID) !== SILO_TYPE_ID) return entity;
  const record = read(marker.skyhookID);
  if (!record || !record.raid || record.raid.closed || record.destroyed ||
      record.raid.generation !== marker.generation || Number(record.raid.siloID) !== Number(item.itemID)) return null;
  const fitting = require("../fitting/liveFittingState");
  entity.evejsSkyhookReagentSilo = true;
  entity.parentID = record.skyhookID;
  entity.component_skyhookReagentSilo_skyhookID = record.skyhookID;
  entity.component_linkWithShip = [null, linkRuntime.IDLE, null, null];
  entity.shieldCapacity = Number(fitting.getTypeAttributeValue(SILO_TYPE_ID, "shieldCapacity")) || 0;
  entity.armorHP = Number(fitting.getTypeAttributeValue(SILO_TYPE_ID, "armorHP")) || 1;
  entity.structureHP = Number(fitting.getTypeAttributeValue(SILO_TYPE_ID, "hp")) || 1;
  entity.shieldRechargeRate = 0;
  entity.conditionState = { shieldCharge: record.raid.shieldCharge, armorDamage: 0, damage: 0 };
  entity.isEmpty = false;
  return entity;
}
function isSealedRaidContainer(item) { return parseInfo(item).evejsSkyhookRaid?.sealed === true; }
function spawnItem(scene, itemID) {
  const existing = scene.getEntityByID(itemID);
  if (existing) return existing;
  const item = itemStore.findItemById(itemID);
  const entity = item && require("../../space/runtime/inventorySpaceEntity").buildRuntimeSpaceEntityFromItem(
    item, scene.systemID, scene.getCurrentSimTimeMs(),
  );
  if (!entity) throw new Error("SKYHOOK_SPACE_ITEM_UNAVAILABLE");
  requireSuccess(scene.spawnDynamicEntity(entity, { broadcast: true }));
  return scene.getEntityByID(itemID);
}
function jobID(record) { return `skyhook-raid:${record.skyhookID}:${record.raid.generation}`; }
function nextDue(record) {
  const now = getWallclockNowMs();
  const raid = record.raid;
  if (raid.pendingSettlement) return Math.max(now, raid.pendingSettlement.retryAtMs || now);
  if (record.destroyed || raid.closed) return null;
  if (!raid.siloID) return now;
  const due = [];
  const window = record.theftVulnerability;
  if (window.startMs > now) due.push(window.startMs);
  else if (raid.windowStartedMs !== window.startMs) due.push(now);
  due.push(window.endMs > now ? window.endMs : now);
  if (raid.completedLink) due.push(raid.completedLink.resetAtMs);
  if (raid.windowNotice && !raid.windowNotice.completed) due.push(now);
  if (raid.activeLink) {
    const scene = space().scenes.get(raid.activeLink.sceneKey);
    const entry = scene && linkRuntime.getLink(scene, raid.siloID);
    if (!entry || entry.domain.linkID !== raid.activeLink.linkID) due.push(now);
    else {
      const factor = Math.max(0.1, Number(scene.getTimeDilation()) || 1);
      const sim = scene.getCurrentSimTimeMs();
      due.push(now + Math.max(1, Math.ceil((entry.completeAtSimMs - sim) / factor)));
      for (const [wave, offset] of raid.activeLink.friendly ? [[0, 0]] : [[0, 0], [1, 120000], [2, 300000]]) {
        if (!raid.activeLink.alerts[String(wave)]?.completed) {
          due.push(now + Math.max(0, Math.ceil((entry.startedAtSimMs + offset - sim) / factor)));
        }
      }
    }
  }
  return Math.max(now, Math.min(...due));
}
async function schedule(record) {
  const scheduler = schedulerBinding.get();
  if (!scheduler || !record?.raid) return;
  const dueAtMs = nextDue(record);
  if (dueAtMs === null) return scheduler.cancel(jobID(record));
  return scheduler.schedule({ jobID: jobID(record), type: DURABLE_RAID_JOB_TYPE, dueAtMs,
    payload: { skyhookID: record.skyhookID, generation: record.raid.generation } });
}
function kick(id) {
  const task = Promise.resolve().then(() => schedule(read(id))).catch((error) => log.warn(`[SkyhookRaid] scheduling ${id}: ${error.message}`));
  admissions.add(task);
  void task.finally(() => admissions.delete(task));
}
function getSystemDistanceWithin(origin, destination, maximum) {
  if (!(origin > 0) || !(destination > 0)) return null;
  if (origin === destination) return 0;
  const seen = new Set([origin]);
  let frontier = [origin];
  for (let distance = 1; distance <= maximum; distance += 1) {
    const next = [];
    for (const systemID of frontier) for (const gate of worldData.getStargatesForSystem(systemID)) {
      const neighbor = Number(gate.destinationSolarSystemID);
      if (!neighbor || seen.has(neighbor)) continue;
      if (neighbor === destination) return distance;
      seen.add(neighbor);
      next.push(neighbor);
    }
    frontier = next;
  }
  return null;
}
function ownerRecipients(record, maximum) {
  return [...new Set(sessionRegistry.getSessions().filter((session) => {
    const character = peekCharacterRecord(Number(session.characterID));
    const systemID = Number(session._space?.systemID || session.solarsystemid2 || session.solarsystemid);
    return character && !character.deletedAt && Number(character.corporationID) === Number(record.corporationID) &&
      getSystemDistanceWithin(record.solarSystemID, systemID, maximum) !== null;
  }).map((session) => Number(session.characterID)))].sort((a, b) => a - b);
}
// Link alerts go to every pilot nearby, not only the owner: Equinox notes,
// "a notification to all players in the solar system, and after 2 minutes, all
// pilots 1 jump away, and finally, after 5 minutes ... all pilots within 2
// jumps"; 2024-10 notes, a friendly theft "will immediately alert everyone
// within 2 jumps"; the client headers read "Nearby Skyhook Theft ...". The
// linker is left out.
function nearbyRecipients(record, maximum, linkerCharacterID) {
  return [...new Set(sessionRegistry.getSessions().filter((session) => {
    const characterID = Number(session.characterID);
    const character = peekCharacterRecord(characterID);
    const systemID = Number(session._space?.systemID || session.solarsystemid2 || session.solarsystemid);
    return character && !character.deletedAt && characterID !== Number(linkerCharacterID) &&
      getSystemDistanceWithin(record.solarSystemID, systemID, maximum) !== null;
  }).map((session) => Number(session.characterID)))].sort((a, b) => a - b);
}
function deliverAlert(record, entry, wave) {
  const link = record.raid.activeLink;
  if (!link || link.alerts[String(wave)]?.completed) return;
  if (!link.alerts[String(wave)]) {
    const recipients = nearbyRecipients(record, link.friendly ? 2 : wave, link.characterID);
    change(record.skyhookID, (next) => {
      next.raid.activeLink.alerts[String(wave)] = { recipients, completed: false };
    });
    record = read(record.skyhookID);
  }
  const alert = record.raid.activeLink.alerts[String(wave)];
  for (const characterID of alert.recipients) {
    const options = { typeID: NOTIFICATION_TYPE.SKYHOOK_LINK_STARTED, senderID: link.characterID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      idempotencyKey: `skyhook-link:${link.linkID}:${wave}:${characterID}`,
      data: { planetID: record.planetID, characterID: link.characterID,
        // A FILETIME long: the client's {[datetime]linkTime} cannot format a
        // string, and the whole body then shows its raw placeholders
        // (formatters/skyhook.py SkyhookLinkStarted; real client, 2026-11-07).
        linkTime: { type: "long", value: String(toFileTimeFromMs(link.startedAtMs)) }, reminderNumber: wave,
        remainingMinutes: Math.max(0, Math.ceil((entry.completeAtSimMs - entry.scene.getCurrentSimTimeMs()) / 60000)) } };
    requireSuccess(createNotification(characterID, { ...options, emitLive: false }));
    requireSuccess(database().flushTableSync("notifications"));
    requireSuccess(createNotification(characterID, { ...options, emitLive: true }));
    requireSuccess(database().flushTableSync("notifications"));
  }
  change(record.skyhookID, (next) => {
    if (next.raid.activeLink?.linkID === link.linkID) next.raid.activeLink.alerts[String(wave)].completed = true;
  });
}
function deliverWindowNotice(record) {
  if (!record.raid.windowNotice || record.raid.windowNotice.completed) return;
  const planet = worldData.getCelestialByID(record.planetID);
  for (const characterID of record.raid.windowNotice.recipients) {
    const options = { typeID: NOTIFICATION_TYPE.SKYHOOK_THEFT_VULNERABILITY_STARTED,
      senderID: record.corporationID, groupID: NOTIFICATION_GROUP.STRUCTURES,
      idempotencyKey: `skyhook-window:${record.skyhookID}:${record.raid.generation}:${record.raid.windowNotice.startMs}:${characterID}`,
      data: { itemID: record.skyhookID, typeID: SKYHOOK_TYPE_ID, solarsystemID: record.solarSystemID,
        planetID: record.planetID, skyhookShowInfoData: ["showinfo", SKYHOOK_TYPE_ID, record.skyhookID],
        planetShowInfoData: ["showinfo", planet?.typeID || 0, record.planetID] } };
    requireSuccess(createNotification(characterID, { ...options, emitLive: false }));
    requireSuccess(database().flushTableSync("notifications"));
    requireSuccess(createNotification(characterID, { ...options, emitLive: true }));
    requireSuccess(database().flushTableSync("notifications"));
  }
  change(record.skyhookID, (next) => { next.raid.windowNotice.completed = true; });
}
function validateLink(record, entry) {
  const current = read(record.skyhookID);
  if (!current || current.raid?.generation !== record.raid.generation ||
      current.raid.activeLink?.linkID !== entry.domain.linkID) return "SKYHOOK_LINK_GENERATION_CHANGED";
  if (!isParentPresent(current)) return "SKYHOOK_PARENT_CHANGED";
  if (!parentIsLiveInScene(current, entry.scene)) return "SKYHOOK_PARENT_SCENE_CHANGED";
  if (current.raid.activeLink.corporationID !== current.corporationID) return "SKYHOOK_OWNER_CHANGED";
  if (!isWindowOpen(current, getWallclockNowMs())) return "SKYHOOK_VULNERABILITY_ENDED";
  return null;
}
function breakPersistedLink(id, linkID, reason) {
  change(id, (record) => {
    if (record.raid.activeLink?.linkID !== linkID) return;
    record.raid.lastBrokenLink = { ...record.raid.activeLink, reason, brokenAtMs: getWallclockNowMs() };
    record.raid.activeLink = null;
  });
  kick(id);
}
function startRaidLink(session, siloID, options = {}) {
  const scene = session && space().getSceneForSession(session);
  const component = scene && scene.getEntityByID(Number(siloID));
  if (!component?.evejsSkyhookReagentSilo) return { success: false, errorMsg: "SKYHOOK_SILO_NOT_FOUND" };
  const record = read(component.parentID);
  if (!record || !record.raid || record.raid.siloID !== Number(siloID) || !isParentPresent(record) || !parentIsLiveInScene(record, scene)) {
    return { success: false, errorMsg: "SKYHOOK_PARENT_CHANGED" };
  }
  const now = getWallclockNowMs();
  if (!isWindowOpen(record, now)) return { success: false, errorMsg: "SKYHOOK_NOT_RAID_VULNERABLE" };
  settleSkyhookHarvest(record, now);
  if (!record.reagentSimulations.some((row) => row.unsecuredStock > 0)) return { success: false, errorMsg: "SKYHOOK_SURPLUS_EMPTY" };
  if (record.raid.shieldCharge > SILO_SHIELD_LINK_THRESHOLD) return { success: false, errorMsg: "SKYHOOK_SILO_SHIELD_TOO_HIGH" };
  if (record.raid.activeLink) return { success: false, errorMsg: "LINK_WITH_SHIP_ALREADY_LINKED" };
  if (record.raid.pendingSettlement) return { success: false, errorMsg: "SKYHOOK_RAID_SETTLEMENT_PENDING" };
  const friendly = require("./skyhookRuntime").isCharacterAuthorised(session, record.skyhookID);
  const prepared = linkRuntime.prepareLink(scene, session, component, SILO_LINK_RULES,
    { ...options, durationMs: friendly ? SILO_LINK_RULES.friendlyDurationMs : SILO_LINK_RULES.linkDurationMs });
  if (!prepared.success) return prepared;
  const entry = prepared.data;
  const linkID = randomUUID();
  change(record.skyhookID, (next) => {
    if (next.raid.activeLink || next.raid.pendingSettlement) throw new Error("SKYHOOK_RAID_BUSY");
    settleSkyhookHarvest(next, now);
    next.raid.activeLink = { linkID, characterID: entry.characterID, shipID: entry.ship.itemID,
      friendly, startedAtMs: now, startedAtSimMs: entry.startedAtSimMs,
      completeAtSimMs: entry.completeAtSimMs, sceneKey: scene.sceneKey,
      corporationID: next.corporationID, alerts: {} };
    next.raid.completedLink = null;
  });
  try {
    requireSuccess(linkRuntime.activateLink(entry, { linkID,
      validate: () => validateLink(record, entry),
      onBreak: (reason) => breakPersistedLink(record.skyhookID, linkID, reason),
      onComplete: () => completeRaid(record.skyhookID, linkID, entry),
    }));
    requireSuccess(require("../security/crimewatchState").recordPvpActivity(scene, entry.ship, now));
    try { deliverAlert(read(record.skyhookID), entry, 0); }
    catch (error) { log.warn(`[SkyhookRaid] alert ${linkID} awaits durable retry: ${error.message}`); }
    return { success: true, data: { linkID, friendly, completeAtSimMs: entry.completeAtSimMs } };
  } catch (error) {
    if (linkRuntime.getLink(scene, siloID)) linkRuntime.breakLink(scene, siloID, "link-admission-failed");
    else breakPersistedLink(record.skyhookID, linkID, "link-admission-failed");
    throw error;
  } finally { kick(record.skyhookID); }
}
function completeRaid(id, linkID, entry) {
  const record = read(id);
  if (!record || record.raid?.activeLink?.linkID !== linkID) return;
  const invalid = validateLink(record, entry);
  if (invalid || entry.scene.getCurrentSimTimeMs() < entry.completeAtSimMs) throw new Error(invalid || "SKYHOOK_LINK_INCOMPLETE");
  const now = getWallclockNowMs();
  change(id, (next) => {
    settleSkyhookHarvest(next, now);
    const amounts = next.reagentSimulations.filter((row) => row.unsecuredStock > 0)
      .map((row) => ({ typeID: row.reagentTypeID, quantity: row.unsecuredStock }));
    if (!amounts.length) throw new Error("SKYHOOK_SURPLUS_EMPTY");
    next.raid.pendingSettlement = { settlementID: linkID, state: "prepared", amounts,
      characterID: entry.characterID, solarSystemID: next.solarSystemID,
      generation: next.raid.generation, position: { ...next.raid.position },
      containerID: null, preparedAtMs: now, retryAtMs: now,
      containerReceiptKey: `skyhook-raid-container:${linkID}` };
    next.raid.completedLink = { linkID, resetAtMs: now + 10000 };
    next.raid.activeLink = null;
  });
  try { settleRaidReceipt(id); }
  catch (error) { log.warn(`[SkyhookRaid] settlement ${linkID} awaits durable retry: ${error.message}`); }
  finally { kick(id); }
}
function settleRaidReceipt(id) {
  let record = read(id);
  let pending = record?.raid?.pendingSettlement;
  if (!pending) return { success: true, unchanged: true };
  // A failed synchronous owner flush can leave a staged phase in the cache.
  // Reaffirm that phase before any cross-owner grant or unseal operation.
  requireSuccess(database().flushTableSync("sovereignty"));
  if (pending.state === "prepared") {
    const result = mintSpace(pending.characterID, pending.solarSystemID, 23,
      pending.containerReceiptKey, custody.CUSTODY_REASON.SKYHOOK_RAID_CONTAINER_CREATE, {
        position: { ...pending.position, x: pending.position.x + 100 },
        itemName: "Orbital Skyhook Reagents",
        customInfo: JSON.stringify({ evejsLoot: { abandoned: true },
          evejsSkyhookRaid: { skyhookID: id, settlementID: pending.settlementID, sealed: true } }),
      });
    requireSuccess(result);
    const containerID = receiptItemID(result);
    if (!containerID) throw new Error("SKYHOOK_RAID_CONTAINER_RECEIPT_MISSING");
    if (!pending.containerID) {
      change(id, (next) => { next.raid.pendingSettlement.containerID = containerID; });
      pending = read(id).raid.pendingSettlement;
    }
    // A disappeared receipt-backed container is never replaced. If loot has
    // already committed, its loss still consumes the reserved stock exactly once.
    const container = itemStore.findItemById(containerID);
    const consumedAmounts = [];
    for (const amount of pending.amounts) {
      const key = `skyhook-raid-loot:${pending.settlementID}:${amount.typeID}`;
      const receipt = custody.getCommittedReceipt(key);
      requireSuccess(receipt);
      if (receipt.committed) { consumedAmounts.push(amount); continue; }
      if (!container) continue;
      requireSuccess(custody.transfer({ to: { kind: custody.CUSTODY_REF_KIND.CONTAINER,
        ownerID: pending.characterID, locationID: containerID, flagID: itemStore.ITEM_FLAGS.CARGO_HOLD },
      actor: pending.characterID, reason: custody.CUSTODY_REASON.SKYHOOK_RAID_REAGENTS_GRANT,
      items: { typeID: amount.typeID, quantity: amount.quantity }, idempotencyKey: key }));
      consumedAmounts.push(amount);
    }
    change(id, (next) => {
      const settlement = next.raid.pendingSettlement;
      if (settlement.settlementID !== pending.settlementID || settlement.state !== "prepared") return;
      settleSkyhookHarvest(next, getWallclockNowMs());
      settlement.consumedAmounts = consumedAmounts;
      settlement.deliveryLost = !container;
      for (const amount of consumedAmounts) {
        const simulation = next.reagentSimulations.find((row) => row.reagentTypeID === amount.typeID);
        if (!simulation || simulation.unsecuredStock < amount.quantity) throw new Error("SKYHOOK_RESERVED_STOCK_CHANGED");
        simulation.unsecuredStock -= amount.quantity;
      }
      settlement.state = "stock-committed";
      settlement.stockCommittedAtMs = getWallclockNowMs();
    });
    record = read(id);
    pending = record.raid.pendingSettlement;
  }
  if (pending.state === "stock-committed") {
    const container = itemStore.findItemById(pending.containerID);
    if (container) {
      const info = parseInfo(container);
      info.evejsSkyhookRaid.sealed = false;
      requireSuccess(itemStore.updateInventoryItem(container.itemID, (item) => ({ ...item,
        customInfo: JSON.stringify(info), expiresAtMs: pending.stockCommittedAtMs + 7200000,
      })));
      requireSuccess(database().flushTableSync("items"));
    }
    change(id, (next) => {
      next.raid.lastSettlement = { ...next.raid.pendingSettlement,
        state: container ? "completed" : "delivered-container-lost", completedAtMs: getWallclockNowMs() };
      next.raid.pendingSettlement = null;
      next.theftVulnerability = sampleNextWindow(orbitalState.getOrbitalByID(id)?.reinforceHour, getWallclockNowMs());
    });
    const scene = space().scenes.get(`solar-system:${pending.solarSystemID}`);
    if (scene && container) spawnItem(scene, container.itemID);
    require("./skyhookRuntime").publishSkyhookState(pending.solarSystemID);
    require("./skyhookRuntime").publishReagents(read(id));
  }
  return { success: true, data: read(id).raid.lastSettlement };
}
function processRecord(id, owningScene = null) {
  let record = read(id);
  if (!record?.raid) return;
  if (record.raid.pendingSettlement) { settleRaidReceipt(id); record = read(id); }
  const scene = owningScene || space().scenes.get(`solar-system:${record.solarSystemID}`);
  const entry = scene && linkRuntime.getLink(scene, record.raid.siloID);
  if (record.raid.activeLink) {
    if (!entry || entry.domain.linkID !== record.raid.activeLink.linkID) {
      breakPersistedLink(id, record.raid.activeLink.linkID, "pilot-or-owning-scene-absent");
    } else {
      linkRuntime.reevaluateLink(scene, record.raid.siloID);
      record = read(id);
      if (record.raid.activeLink) {
        const elapsed = scene.getCurrentSimTimeMs() - entry.startedAtSimMs;
        for (const [wave, offset] of record.raid.activeLink.friendly ? [[0, 0]] : [[0, 0], [1, 120000], [2, 300000]]) {
          if (elapsed >= offset) deliverAlert(read(id), entry, wave);
        }
      }
    }
    record = read(id);
  }
  if (record.destroyed || !isParentPresent(record)) return cleanupRecord(record, scene);
  const now = getWallclockNowMs();
  if (record.theftVulnerability.endMs <= now) {
    change(id, (next) => {
      next.theftVulnerability = sampleNextWindow(orbitalState.getOrbitalByID(id)?.reinforceHour, now);
      next.raid.windowStartedMs = null;
    });
    require("./skyhookRuntime").publishSkyhookState(record.solarSystemID);
  } else if (isWindowOpen(record, now) && record.raid.windowStartedMs !== record.theftVulnerability.startMs) {
    const recipients = ownerRecipients(record, 2);
    change(id, (next) => {
      next.raid.windowStartedMs = next.theftVulnerability.startMs;
      next.raid.windowNotice = { startMs: next.theftVulnerability.startMs, recipients, completed: false };
      next.raid.shieldCharge = 1;
    });
    if (scene) { const silo = scene.getEntityByID(record.raid.siloID); if (silo) silo.conditionState.shieldCharge = 1; }
    require("./skyhookRuntime").publishSkyhookState(record.solarSystemID);
  }
  record = read(id);
  deliverWindowNotice(record);
  if (record.raid.completedLink && now >= record.raid.completedLink.resetAtMs) {
    change(id, (next) => { next.raid.completedLink = null; });
    // Durable bookkeeping expires on wall time. The shared scene owner alone
    // resets the live completion projection on its simulation clock/TiDi.
  }
}
function cleanupRecord(record, scene) {
  if (record.raid.activeLink) {
    if (scene && linkRuntime.getLink(scene, record.raid.siloID)) linkRuntime.breakLink(scene, record.raid.siloID, "parent-destroyed-or-replaced");
    else breakPersistedLink(record.skyhookID, record.raid.activeLink.linkID, "parent-destroyed-or-replaced");
  }
  if (record.raid.pendingSettlement) settleRaidReceipt(record.skyhookID);
  const silo = itemStore.findItemById(record.raid.siloID);
  if (silo) {
    if (scene?.getEntityByID(silo.itemID)) requireSuccess(scene.removeDynamicEntity(silo.itemID));
    requireSuccess(custody.transfer({ from: { kind: custody.CUSTODY_REF_KIND.IN_SPACE,
      ownerID: silo.ownerID, locationID: silo.locationID, flagID: 0 }, to: { kind: custody.CUSTODY_REF_KIND.VOID },
    items: { itemID: silo.itemID }, actor: silo.ownerID,
    reason: custody.CUSTODY_REASON.SPACE_ENTITY_DESTROY, idempotencyKey: `skyhook-silo-remove:${record.raid.generation}` }));
    requireSuccess(database().flushTableSync("items"));
  }
  if (!record.raid.closed) change(record.skyhookID, (next) => { next.raid.closed = true; });
}
function reconcileScene(scene) {
  if (scene.sceneKind !== "solarSystem" || Number(scene.instanceID || 0) !== 0) return;
  if (!database().mayMutateTable("sovereignty")) return;
  if (!sceneVersions.has(scene) && ![...scene.staticEntities.values(), ...scene.dynamicEntities.values()]
      .some((entity) => entity.typeID === SKYHOOK_TYPE_ID || entity.evejsSkyhookReagentSilo)) {
    sceneVersions.set(scene, `${orbitalState.getDeployedSkyhookRevision()}:${revision}`);
    return;
  }
  for (let record of modern.listRaidSkyhooks().filter((row) => row.solarSystemID === scene.systemID)) {
    if (record.destroyed || record.raid && !isParentPresent(record)) {
      if (record.raid) cleanupRecord(record, scene);
      if (!hasDeployedParent(record)) continue;
      record = read(record.skyhookID);
    }
    record = ensureSilo(initializeRecord(record));
    if (!record.raid || record.raid.closed) continue;
    spawnItem(scene, record.raid.siloID);
    // Pending cross-owner work belongs to the scheduler's retry/backoff lane.
    // Rehydrating its scene must not repeatedly restart settlement retries.
    if (!record.raid.pendingSettlement) {
      processRecord(record.skyhookID, scene);
      if (!read(record.skyhookID).raid.pendingSettlement) kick(record.skyhookID);
    }
  }
  sceneVersions.set(scene, `${orbitalState.getDeployedSkyhookRevision()}:${revision}`);
}
function tickScene(scene) {
  if (scene.sceneKind !== "solarSystem" || Number(scene.instanceID || 0) !== 0) return;
  const now = getWallclockNowMs();
  if (now < (sceneRetryAtMs.get(scene) || 0)) return;
  try {
    const version = `${orbitalState.getDeployedSkyhookRevision()}:${revision}`;
    if (sceneVersions.get(scene) !== version) reconcileScene(scene);
    // The shared space tick owns generic links independently of raid retries.
    sceneRetryAtMs.delete(scene);
  } catch (error) {
    // A durable owner failure retains its intent and receipts. It must not
    // abort the shared space tick or let the pending container become visible.
    sceneRetryAtMs.set(scene, now + 1000);
    for (const record of modern.listRaidSkyhooks()) if (record.solarSystemID === scene.systemID &&
      !record.raid?.pendingSettlement) kick(record.skyhookID);
    log.warn(`[SkyhookRaid] scene ${scene.sceneKey} awaits durable retry: ${error.message}`);
  }
}
async function handleDurableRaid(job) {
  let record = read(job.payload.skyhookID);
  if (!record?.raid || record.raid.generation !== job.payload.generation) return { stale: true };
  if (!record.destroyed && isParentPresent(record)) record = ensureSilo(record);
  processRecord(record.skyhookID);
  await schedule(read(record.skyhookID));
}
async function reconcileDurableRaids() {
  let scheduled = 0;
  for (let record of modern.listRaidSkyhooks()) {
    if (record.raid && !isParentPresent(record)) {
      processRecord(record.skyhookID);
      record = read(record.skyhookID);
    }
    if (!record.destroyed) record = ensureSilo(initializeRecord(record));
    if (!record.raid) continue;
    processRecord(record.skyhookID);
    await schedule(read(record.skyhookID));
    scheduled += 1;
  }
  return { scheduled };
}
function applySiloDamage(entity, result) {
  if (!entity.evejsSkyhookReagentSilo || !result?.success) return false;
  const record = read(entity.parentID);
  if (!record || record.raid?.siloID !== entity.itemID) throw new Error("SKYHOOK_SILO_GENERATION_CHANGED");
  entity.conditionState.armorDamage = 0;
  entity.conditionState.damage = 0;
  result.data.destroyed = false;
  result.data.afterConditionState = { ...entity.conditionState };
  change(record.skyhookID, (next) => { next.raid.shieldCharge = Math.max(0, Math.min(1, entity.conditionState.shieldCharge)); });
  return true;
}
function blocksSiloDamage(entity) {
  return Boolean(entity?.evejsSkyhookReagentSilo && !isWindowOpen(read(entity.parentID), getWallclockNowMs()));
}
function handleParentDestroyed(id, scene) {
  try { processRecord(id, scene); return { success: true }; }
  catch (error) {
    log.warn(`[SkyhookRaid] destroyed parent ${id} awaits durable cleanup: ${error.message}`);
    kick(id);
    return { success: false, errorMsg: error.message };
  }
}
// GM time skip (owner ruling 2026-11-07: hybrid with time forwarding): the
// skyhook's next theft window opens in `seconds` and runs its normal two hours.
// Opening, notices, links and the next sampled window all stay with
// processRecord.
function adminSetTheftWindow(id, seconds) {
  const record = read(id);
  if (!record || !record.raid || record.destroyed) return { success: false, errorMsg: "SKYHOOK_NOT_FOUND" };
  const startMs = getWallclockNowMs() + Math.max(0, Number(seconds) || 0) * 1000;
  change(id, (next) => {
    next.theftVulnerability = { startMs, endMs: startMs + RAID_WINDOW_MS };
    next.raid.windowStartedMs = null;
  });
  require("./skyhookRuntime").publishSkyhookState(record.solarSystemID);
  kick(id);
  return { success: true, data: read(id).theftVulnerability };
}
async function idle() { while (admissions.size) await Promise.allSettled([...admissions]); }

module.exports = { DURABLE_RAID_JOB_TYPE, startRaidLink, settleRaidReceipt, adminSetTheftWindow,
  reconcileScene, tickScene, processRecord, hydrateSilo, isSealedRaidContainer,
  blocksSiloDamage, applySiloDamage, getSystemDistanceWithin, ownerRecipients, nearbyRecipients,
  handleParentDestroyed,
  handleDurableRaid, reconcileDurableRaids, idle,
  bindDurableScheduler: schedulerBinding.bind, unbindDurableScheduler: schedulerBinding.unbind };
