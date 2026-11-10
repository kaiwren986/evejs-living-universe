"use strict";

const database = require("../../gameStore");
const orbitals = require("./planetOrbitalState");
const items = require("../inventory/itemStore");
const mobile = require("../inventory/mobileItemCustody");
const customs = require("../inventory/planetaryCustomsItemCustody");
const clone = value => JSON.parse(JSON.stringify(value));
const fail = errorMsg => ({ success: false, errorMsg });
const retries = new Map();
const log = require("../../utils/logger");
const {
  corporationAuthorityHasRole,
  getPersistedCorporationAuthority,
} = require("../corporation/corporationAuthority");
const { CORP_ROLE_STATION_MANAGER } = require("../structure/structureServiceAuthority");

function resolveDeploymentAuthority(session, options = {}) {
  const authority = getPersistedCorporationAuthority(session);
  if (!authority || (!authority.isCEO &&
      !corporationAuthorityHasRole(authority, CORP_ROLE_STATION_MANAGER))) {
    return fail("SKYHOOK_DEPLOYMENT_REQUIRES_STATION_MANAGER");
  }
  const ownerID = Number(options.ownerID) || authority.corporationID;
  if (ownerID !== authority.corporationID) return fail("SKYHOOK_OWNER_MUST_BE_CORPORATION");
  return { success: true, data: { characterID: authority.characterID,
    corporationID: authority.corporationID, ownerID: authority.corporationID,
    allianceID: Number(authority.corporation.allianceID) || 0,
    warFactionID: Number(authority.corporation.warFactionID) || 0 } };
}

function validateDeploymentContext(session, context) {
  const { isDockedSession } = require("../structure/structureLocation");
  const runtime = require("../../space/runtime");
  const { buildSolarSystemSceneKey, normalizeSceneDescriptor } = require("../../space/runtime/sceneIdentity");
  if (isDockedSession(session) || !session?._space ||
      Number(session._space.systemID) !== Number(context.systemID) ||
      Number(session._space.shipID) !== Number(context.shipID)) return fail("SKYHOOK_DEPLOYMENT_REQUIRES_ACTIVE_SHIP_IN_SPACE");
  const scene = runtime.getSceneForSession(session);
  const descriptor = scene && normalizeSceneDescriptor(scene.sceneDescriptor || scene);
  const ship = scene?.getEntityByID?.(context.shipID);
  const { hasPrivateScope } = require("./planetOrbitalPlacement");
  if (!descriptor || descriptor.sceneKind !== "solarSystem" ||
      descriptor.solarSystemID !== Number(context.systemID) ||
      descriptor.sceneKey !== buildSolarSystemSceneKey(context.systemID) ||
      Number(scene.systemID) !== Number(context.systemID) ||
      (scene.sceneKind && scene.sceneKind !== "solarSystem") ||
      (scene.sceneKey && scene.sceneKey !== descriptor.sceneKey) ||
      hasPrivateScope(scene) || !ship || ship.destroyed || hasPrivateScope(ship) ||
      (ship.sceneKey && ship.sceneKey !== descriptor.sceneKey) ||
      (ship.sceneKind && ship.sceneKind !== "solarSystem") ||
      !ship.position || !["x", "y", "z"].every(axis => Number.isFinite(Number(ship.position[axis])))) {
    return fail("SKYHOOK_DEPLOYMENT_REQUIRES_ACTIVE_SHIP_IN_SPACE");
  }
  if (ship.mode === "WARP") return fail("SKYHOOK_DEPLOYMENT_SHIP_IN_WARP");
  return { success: true };
}

function retry(systemID) {
  if (retries.has(systemID)) return;
  const timer = setTimeout(() => {
    retries.delete(systemID);
    try {
      const result = reconcileForSystem(systemID);
      if (!result.success) retry(systemID);
    } catch (error) {
      log.warn(`[SkyhookReplacement] recovery failed system=${systemID}: ${error.message}`);
      retry(systemID);
    }
  }, 1000);
  timer.unref?.();
  retries.set(systemID, timer);
}

function save(intent) {
  const state = clone(orbitals.readState());
  state.replacementsByPlanet[String(intent.planetID)] = clone(intent);
  return orbitals.writeState(state);
}

function snapshotCargo(officeIDs) {
  return officeIDs.flatMap(officeID => items.listContainerItems(null, officeID)
    .map(cargo => ({ itemID: cargo.itemID, ownerID: cargo.ownerID,
      quantity: cargo.singleton === 1 ? 1 : Number(cargo.stacksize ?? cargo.quantity),
      sourceLocationID: officeID, flagID: cargo.flagID, previousData: clone(cargo) })));
}

function snapshotPISettings(intent) {
  // Prefer the corporation's POCO over a leftover NPC office if recovering an
  // old planet with duplicate offices. Damage and reinforcement are not PI settings.
  const records = intent.officeIDs.map(id => orbitals.getOrbitalByID(id, { refresh: false }))
    .filter(record => record && !orbitals.isOrbitalRecordDestroyed(record))
    .sort((left, right) =>
      Number(Number(right.ownerID) === Number(intent.context.ownerID)) -
      Number(Number(left.ownerID) === Number(intent.context.ownerID)) || left.itemID - right.itemID);
  const record = records[0];
  if (!record) return null;
  return Object.fromEntries(["taxRates", "standingLevel", "allowAlliance", "allowStandings", "aclGroupID"]
    .map(key => [key, clone(record[key])]));
}

function plan(item, context, spawnState) {
  const { hasPrivateScope } = require("./planetOrbitalPlacement");
  if (hasPrivateScope(item) || hasPrivateScope(spawnState)) return fail("SKYHOOK_REQUIRES_PUBLIC_SOLAR_SYSTEM");
  const planetID = orbitals.findNearestPlanetID(context.systemID, spawnState.position);
  if (!planetID) return fail("PLANET_NOT_FOUND");
  const existing = orbitals.readState().replacementsByPlanet[String(planetID)];
  if (existing && !existing.completed) {
    return existing.sourceItem.itemID === item.itemID
      ? { success: true, data: clone(existing) } : fail("PLANET_DEPLOYMENT_IN_PROGRESS");
  }
  const records = orbitals.listOrbitalsForPlanet(planetID)
    .filter(record => !orbitals.isOrbitalRecordDestroyed(record))
    .filter(record => {
      const backing = items.findItemById(record.itemID);
      return !hasPrivateScope(backing) && !hasPrivateScope(backing?.spaceState);
    });
  if (records.some(record => Number(record.groupID) !== orbitals.GROUP_PLANETARY_CUSTOMS_OFFICES)) {
    return fail("PLANET_ALREADY_HAS_ORBITAL");
  }
  if (records.some(record => ![orbitals.DEFAULT_CUSTOMS_OFFICE_OWNER_ID, context.corporationID].includes(Number(record.ownerID)))) {
    return fail("PLANET_HAS_HOSTILE_CUSTOMS_OFFICE");
  }
  const officeIDs = records.length ? records.map(record => Number(record.itemID))
    : [orbitals.buildDefaultCustomsOfficeItemID(planetID)];
  const pending = require("./planetaryCustomsSettlementState").listPendingPlanetaryCustomsSettlements();
  if (pending.some(settlement => officeIDs.includes(Number(settlement.customsOfficeID)))) {
    return fail("CUSTOMS_SETTLEMENT_IN_PROGRESS");
  }
  // A synthesized office must remain present across reload while the hook is
  // onlining; the new orbital row would otherwise suppress its lazy creation.
  for (const officeID of officeIDs) {
    if (!orbitals.ensureRuntimeOrbitalRecord(officeID)) return fail("WRITE_ERROR");
  }
  const intent = { phase: "deploying", planetID, systemID: context.systemID, sourceItem: clone(item),
    context: clone(context), spawnState: clone(spawnState), officeIDs,
    key: `skyhook-replace:${planetID}:${item.itemID}:${Date.now()}`,
    cargo: [], completed: false };
  const planet = require("../../space/worldData").getCelestialByID(planetID);
  const placement = require("./planetOrbitalPlacement");
  const position = placement.buildOrbitalPosition(planet, item);
  intent.spawnState = { ...spawnState, position, targetPoint: { ...position },
    orbitalPositionVersion: placement.POSITION_VERSION };
  return save(intent) ? { success: true, data: intent } : fail("WRITE_ERROR");
}

function resume(intent, nowMs = Date.now()) {
  const saved = orbitals.readState().replacementsByPlanet[String(intent.planetID)];
  if (saved?.key === intent.key) {
    const current = clone(saved);
    for (const key of Object.keys(intent)) delete intent[key];
    Object.assign(intent, current);
  }
  if (intent.completed) return save(intent)
    ? { success: true, data: { itemID: intent.launchedItemID } } : fail("WRITE_ERROR");
  const cancelled = cancelUntouchedInvalidSource(intent);
  if (cancelled) return cancelled;
  const context = intent.context;
  if (!intent.launchedItemID) {
    const result = mobile.deployFromShip({ item: intent.sourceItem, ownerID: context.ownerID,
      shipID: context.shipID, systemID: context.systemID, actor: context.characterID,
      reason: require("../inventory/itemCustody").CUSTODY_REASON.SKYHOOK_DEPLOY,
      idempotencyKey: `${intent.key}:deploy` });
    if (!result.success) return result;
    if (result.durable !== true) return fail("DEPLOYMENT_NOT_DURABLE");
    const moved = require("../_shared/settlementCustodyRecovery").resolveCustodyResultItem(result);
    const launched = moved && items.findItemById(moved.itemID);
    if (!launched || Number(launched.locationID) !== intent.systemID || Number(launched.typeID) !== 81080)
      return fail("LAUNCHED_ITEM_NOT_FOUND");
    intent.launchedItemID = Number(launched.itemID);
    if (!save(intent)) return fail("WRITE_ERROR");
  }
  if (!intent.deploymentPrepared) {
    const launched = items.findItemById(intent.launchedItemID);
    if (!launched) return fail("LAUNCHED_ITEM_NOT_FOUND");
    // Legacy repair operates on an existing live hook. Never rewind its space
    // state; new deployment placement is committed once before publication.
    if (!intent.legacy && (!launched.spaceState || intent.phase === "deploying")) {
      const update = items.updateInventoryItem(intent.launchedItemID, current => ({ ...current,
        ownerID: context.ownerID, locationID: intent.systemID, flagID: 0, singleton: 1,
        spaceState: intent.spawnState, createdAtMs: current.createdAtMs || nowMs }));
      if (!update.success) return update;
    }
    const flush = database.flushTableSync(items.ITEMS_TABLE);
    if (!flush.success) return flush;
    const record = orbitals.ensureOrbitalForItem(items.findItemById(intent.launchedItemID), { ...context,
      solarSystemID: intent.systemID, planetID: intent.planetID,
      state: orbitals.ORBITAL_STATE.UNANCHORED });
    if (!record) return fail("WRITE_ERROR");
    const state = clone(orbitals.readState());
    intent.deploymentPrepared = true;
    if (intent.phase === "deploying") {
      intent.phase = "onlining";
      intent.onliningStartedAtMs = nowMs;
      intent.onliningEndsAtMs = nowMs + orbitals.getOrbitalTransitionMs(
        orbitals.TYPE_ORBITAL_SKYHOOK, orbitals.ORBITAL_STATE.ONLINING);
      state.orbitalsByID[String(intent.launchedItemID)] = { ...record,
        skyhookActivationStarted: true, state: orbitals.ORBITAL_STATE.ONLINING,
        stateStartedAtMs: intent.onliningStartedAtMs, stateEndsAtMs: intent.onliningEndsAtMs };
    }
    state.replacementsByPlanet[String(intent.planetID)] = clone(intent);
    if (!orbitals.writeState(state)) return fail("WRITE_ERROR");
  }
  let record = orbitals.getOrbitalByID(intent.launchedItemID, { refresh: false });
  const launched = items.findItemById(intent.launchedItemID);
  if (!launched || !record || orbitals.isOrbitalRecordDestroyed(record)) {
    // Destruction is terminal even after partial finalization. Receipt-backed
    // cargo already moved belongs to that loss; release surviving old offices
    // with their remaining goods, without replaying or recreating lost cargo.
    const state = clone(orbitals.readState());
    delete state.replacementsByPlanet[String(intent.planetID)];
    return orbitals.writeState(state) ? { success: true, cancelled: true } : fail("WRITE_ERROR");
  }
  if (intent.phase === "onlining") {
    // A previous failed flush may have left this phase only in the cache. Both
    // waiting paths must make the deadline durable before exposing the build.
    if (!save(intent)) return fail("WRITE_ERROR");
    if (nowMs < intent.onliningEndsAtMs) {
      return { success: true, pending: true, data: { itemID: intent.launchedItemID,
        sourceItemID: intent.sourceItem.itemID, orbital: record } };
    }
    const pending = require("./planetaryCustomsSettlementState").listPendingPlanetaryCustomsSettlements();
    if (pending.some(settlement => intent.officeIDs.includes(Number(settlement.customsOfficeID)))) {
      return { success: true, pending: true, data: { itemID: intent.launchedItemID } };
    }
    // Capture the latest goods and settings only at completion. The phase and
    // frozen manifest are durable before the first custody move locks the office.
    intent.cargo = snapshotCargo(intent.officeIDs);
    intent.piSettings = snapshotPISettings(intent);
    intent.phase = "finalizing";
  }
  // Also flush a failed checkpoint retry before trusting cached phase/manifest.
  // Phase-less intents already have a frozen manifest from the previous version.
  if (!save(intent)) return fail("WRITE_ERROR");
  for (const leg of intent.cargo) {
    const result = customs.relocateOfficeCargo({ ...leg, actorID: context.characterID,
      sourceFlagID: leg.flagID, destinationFlagID: leg.flagID,
      destinationLocationID: intent.launchedItemID, idempotencyKey: `${intent.key}:cargo:${leg.itemID}` });
    if (!result.success) return result;
    if (result.durable !== true) return fail("CUSTOMS_CARGO_NOT_DURABLE");
  }
  for (const officeID of intent.officeIDs) {
    if (items.listContainerItems(null, officeID).length) return fail("CUSTOMS_CARGO_CHANGED");
    const retired = orbitals.markOrbitalDestroyed(officeID);
    if (!retired.success) return retired;
    if (items.findItemById(officeID)) {
      const removed = items.removeInventoryItem(officeID, { removeContents: false });
      if (!removed.success) return removed;
      const durable = database.flushTableSync(items.ITEMS_TABLE);
      if (!durable.success) return durable;
    }
  }
  intent.completed = true;
  const state = clone(orbitals.readState());
  state.replacementsByPlanet[String(intent.planetID)] = clone(intent);
  record = orbitals.getOrbitalByID(intent.launchedItemID, { refresh: false });
  state.orbitalsByID[String(intent.launchedItemID)] = intent.legacy ? record : { ...record,
    ...(intent.piSettings || {}), skyhookActivationStarted: true, state: orbitals.ORBITAL_STATE.IDLE,
    stateStartedAtMs: null, stateEndsAtMs: null };
  if (!orbitals.writeState(state)) { intent.completed = false; return fail("WRITE_ERROR"); }
  const onlineRecord = orbitals.ensureOrbitalForItem(items.findItemById(intent.launchedItemID));
  return { success: true, data: { itemID: intent.launchedItemID,
    sourceItemID: intent.sourceItem.itemID, orbital: onlineRecord } };
}

function cancelUntouchedInvalidSource(intent) {
  if (intent.legacy || intent.launchedItemID) return null;
  const source = items.findItemById(intent.sourceItem.itemID);
  if (source && Number(source.typeID) === 81080 &&
      Number(source.ownerID) === Number(intent.sourceItem.ownerID) &&
      Number(source.locationID) === Number(intent.sourceItem.locationID) &&
      Number(source.flagID) === Number(intent.sourceItem.flagID) &&
      (source.singleton === 1 || Number(source.stacksize ?? source.quantity) > 0)) return null;
  // Only a saga with no custody reservation at all can be abandoned. A lost
  // checkpoint may hide a committed deployment or an ambiguous reserved move.
  const custody = require("../inventory/itemCustody");
  for (const key of [`${intent.key}:deploy`, ...intent.cargo.map(leg => `${intent.key}:cargo:${leg.itemID}`)]) {
    const result = custody.getCommittedReceipt(key);
    if (!result.success || result.ambiguous || result.receipt || result.committed) return null;
  }
  const state = clone(orbitals.readState());
  if (state.replacementsByPlanet[String(intent.planetID)]?.key !== intent.key) return fail("REPLACEMENT_INTENT_CHANGED");
  delete state.replacementsByPlanet[String(intent.planetID)];
  if (!orbitals.writeState(state)) return fail("WRITE_ERROR");
  log.warn(`[SkyhookReplacement] cancelled untouched deployment planet=${intent.planetID}: source hull left cargo`);
  return { success: true, cancelled: true };
}

// The customs office is gone once the skyhook finishes onlining. The client's
// OnSkyhookFirstActivation(skyhookID, planetID) closes an open import/export
// window for that planet with the SkyhookReplacingPoco dialog
// (importExportUI.py:422) and drops the cached skyhook data and theft state
// (sovereigntyResourceSvc.py:77). No retail capture of this event exists, so
// the audience is chosen from those handlers: every session in the system
// (a customs window needs the pilot there) plus the owner corporation's
// members elsewhere (their skyhook lists). One notification per session.
function notifySkyhookFirstActivation(intent, sessions) {
  const skyhookID = Number(intent.launchedItemID) || 0;
  const planetID = Number(intent.planetID) || 0;
  const systemID = Number(intent.systemID) || 0;
  const ownerID = Number(intent.context && intent.context.ownerID) || 0;
  if (!skyhookID || !planetID) return 0;
  let sent = 0;
  for (const candidate of sessions.getSessions()) {
    if (!candidate || typeof candidate.sendNotification !== "function") continue;
    const sessionSystemID = Number(candidate.solarsystemid2 || candidate.solarsystemid ||
      (candidate._space && candidate._space.systemID)) || 0;
    const corporationID = Number(candidate.corporationID || candidate.corpid) || 0;
    if ((systemID > 0 && sessionSystemID === systemID) || (ownerID > 0 && corporationID === ownerID)) {
      candidate.sendNotification("OnSkyhookFirstActivation", "clientID", [skyhookID, planetID]);
      sent += 1;
    }
  }
  return sent;
}

function publish(intent, session) {
  const runtime = require("../../space/runtime");
  const scene = session ? runtime.getSceneForSession(session) : runtime.scenes.get(intent.systemID);
  if (scene && intent.completed) for (const officeID of intent.officeIDs) {
    const removed = scene.staticEntitiesByID.has(officeID) ? scene.removeStaticEntity(officeID)
      : scene.getEntityByID(officeID) ? scene.removeDynamicEntity(officeID) : null;
    if (removed && !removed.success) return removed;
  }
  if (scene && !scene.getEntityByID(intent.launchedItemID)) {
    const spawned = runtime.spawnDynamicInventoryEntity(intent.systemID, intent.launchedItemID);
    if (!spawned || !spawned.success) return spawned || fail("SPACE_SPAWN_FAILED");
  } else if (scene && intent.completed && typeof scene.refreshInventoryBackedEntityPresentation === "function") {
    const refreshed = scene.refreshInventoryBackedEntityPresentation(intent.launchedItemID);
    if (refreshed && !refreshed.success) return refreshed;
  }
  // Rebind/list responses are authoritative; notify the launching ship's cargo
  // using the ordinary inventory delta, including split-stack quantities.
  const character = require("../character/characterState");
  const sessions = require("../chat/sessionRegistry");
  for (const leg of intent.completed ? intent.cargo : []) {
    const recipient = session && Number(session.characterID || session.charid) === Number(leg.ownerID)
      ? session : sessions.findSessionByCharacterID(leg.ownerID);
    const moved = items.findItemById(leg.itemID);
    if (recipient && moved && leg.previousData)
      character.emitItemsChangedBatchForSession(recipient, [{ item: moved, previousData: leg.previousData }]);
  }
  const source = items.findItemById(intent.sourceItem.itemID);
  const actorSession = session || sessions.findSessionByCharacterID(intent.context.characterID);
  if (!intent.onliningPresentationCompleted && actorSession && source && source.itemID !== intent.launchedItemID)
    character.syncInventoryItemForSession(actorSession, source, intent.sourceItem);
  const launched = items.findItemById(intent.launchedItemID);
  if (!intent.onliningPresentationCompleted && actorSession)
    character.syncInventoryItemForSession(actorSession, launched, intent.sourceItem, { emitCfgLocation: true });
  if (intent.completed) require("../sovereignty/skyhookRuntime").publishSkyhookState(intent.systemID);
  if (intent.completed && !intent.presentationCompleted) notifySkyhookFirstActivation(intent, sessions);
  if (intent.completed) intent.presentationCompleted = true;
  else intent.onliningPresentationCompleted = true;
  return save(intent) ? { success: true } : fail("WRITE_ERROR");
}

function deploy(session, item, context, spawnState) {
  try {
    const authority = resolveDeploymentAuthority(session, context);
    if (!authority.success) return authority;
    if (Number(context.characterID) !== authority.data.characterID ||
        Number(context.corporationID) !== authority.data.corporationID) return fail("INVALID_SESSION");
    context = { ...context, ...authority.data };
    const presence = validateDeploymentContext(session, context);
    if (!presence.success) return presence;
    const planned = plan(item, context, { ...spawnState, corporationID: context.corporationID,
      allianceID: context.allianceID, warFactionID: context.warFactionID });
    if (!planned.success) return planned;
    const result = resume(planned.data);
    if (result.cancelled) return fail("SKYHOOK_SOURCE_HULL_CHANGED");
    if (result.success) {
      const presented = publish(planned.data, session);
      if (!presented.success) { retry(context.systemID); return presented; }
      if (result.pending) retry(context.systemID);
    } else retry(context.systemID);
    return result;
  } catch (error) {
    log.warn(`[SkyhookReplacement] deployment failed system=${context.systemID}: ${error.message}`);
    retry(context.systemID);
    return fail("SKYHOOK_REPLACEMENT_FAILED");
  }
}

function reconcileForSystem(systemID, options = {}) {
  const failures = [];
  const noteFailure = (intent, result) => {
    const errorMsg = result?.errorMsg || "SKYHOOK_REPLACEMENT_FAILED";
    failures.push({ planetID: Number(intent.planetID), errorMsg });
    log.warn(`[SkyhookReplacement] recovery pending planet=${intent.planetID} system=${systemID}: ${errorMsg}`);
    retry(systemID);
  };
  // Old deployments could leave a same-corporation/NPC office and its cargo
  // behind. Reuse the same receipt-backed saga without redeploying the skyhook.
  const records = orbitals.listOrbitalsForSystem(systemID);
  for (const hook of records.filter(record => Number(record.typeID) === 81080 &&
    !orbitals.isOrbitalRecordDestroyed(record) &&
    [orbitals.ORBITAL_STATE.IDLE, orbitals.ORBITAL_STATE.OPERATING].includes(Number(record.state)))) {
    const saved = orbitals.readState().replacementsByPlanet[String(hook.planetID)];
    if (saved && !saved.completed) continue;
    const placement = require("./planetOrbitalPlacement");
    const item = items.findItemById(hook.itemID);
    if (!item || !item.spaceState || placement.hasPrivateScope(item) || placement.hasPrivateScope(item.spaceState)) continue;
    const offices = records.filter(record => Number(record.planetID) === Number(hook.planetID) &&
      Number(record.groupID) === 1025 && !orbitals.isOrbitalRecordDestroyed(record) &&
      [1000148, Number(hook.ownerID)].includes(Number(record.ownerID)) &&
      !placement.hasPrivateScope(items.findItemById(record.itemID)) &&
      !placement.hasPrivateScope(items.findItemById(record.itemID)?.spaceState));
    const defaultID = orbitals.buildDefaultCustomsOfficeItemID(hook.planetID);
    const officeIDs = [...new Set([...offices.map(record => Number(record.itemID)),
      ...(items.listContainerItems(null, defaultID).length ? [defaultID] : [])])];
    if (!officeIDs.length) continue;
    const pending = require("./planetaryCustomsSettlementState").listPendingPlanetaryCustomsSettlements();
    if (pending.some(settlement => officeIDs.includes(Number(settlement.customsOfficeID)))) continue;
    const intent = { legacy: true, completed: false, planetID: hook.planetID,
      systemID: Number(systemID), sourceItem: clone(item), launchedItemID: hook.itemID,
      context: { ownerID: hook.ownerID, corporationID: hook.corporationID,
        characterID: require("../corporation/corporationState").getCorporationRecord(hook.ownerID)?.ceoID || hook.ownerID },
      spawnState: clone(item.spaceState), officeIDs,
      key: `skyhook-legacy:${hook.planetID}:${hook.itemID}:${Date.now()}`,
      cargo: officeIDs.flatMap(officeID => items.listContainerItems(null, officeID).map(cargo => ({
        itemID: cargo.itemID, ownerID: cargo.ownerID, quantity: cargo.singleton === 1 ? 1 : Number(cargo.stacksize ?? cargo.quantity),
        sourceLocationID: officeID, flagID: cargo.flagID, previousData: clone(cargo),
      }))) };
    if (!save(intent)) noteFailure(intent, fail("WRITE_ERROR"));
  }
  const pending = Object.values(orbitals.readState().replacementsByPlanet || {})
    .filter(intent => (!intent.completed || !intent.presentationCompleted) && Number(intent.systemID) === Number(systemID));
  for (const intent of pending) {
    try {
      const copy = clone(intent);
      const result = resume(copy, options.nowMs ?? Date.now());
      if (!result.success) { noteFailure(intent, result); continue; }
      if (result.cancelled) continue;
      if (!options.suppressPresentation) {
        const presented = publish(copy);
        if (!presented.success) noteFailure(intent, presented);
      } else retry(systemID);
      if (result.pending) retry(systemID);
    } catch (error) {
      noteFailure(intent, fail(error.message));
    }
  }
  return failures.length ? { success: false, errorMsg: failures[0].errorMsg, failures }
    : { success: true };
}

module.exports = { deploy, reconcileForSystem, resolveDeploymentAuthority, scheduleRecovery: retry, _testing: { plan, resume, publish,
  clearRetries() { for (const timer of retries.values()) clearTimeout(timer); retries.clear(); } } };
