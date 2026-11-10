"use strict";

// Current client moonmining.py:1271-1348 retains these configuration RPCs,
// but ShowProduction:515-538 no longer builds a reactor/link graph. Keep the
// supported configuration durable without pretending modern industry recipes
// or modern moon-ore fractions are historical POS production authority.
const { GROUP_SILO, GROUP_REACTOR, isProductionStorage } = require("./starbaseStorageKinds");
const inventory = () => require("../inventory/itemStore");
const number = (value) => Number(value) || 0;
const fail = (errorMsg) => ({ success: false, errorMsg });
const ok = (data) => ({ success: true, data });
const GROUP_HARVESTER = 416;
const CONFIG_ROLE = 9007199254740992n;

function isProductionStructure(item) {
  return number(item?.categoryID) === 23 &&
    [GROUP_SILO, GROUP_HARVESTER, GROUP_REACTOR].includes(number(item.groupID));
}

function typeAttribute(typeID, attributeID) {
  const { readStaticTable, TABLE } = require("../_shared/referenceData");
  return number(readStaticTable(TABLE.TYPE_DOGMA)?.typesByTypeID?.[typeID]?.attributes?.[attributeID]);
}

function getProductionState(item) {
  const value = item?.spaceState?.starbaseModuleState?.production || {};
  return {
    version: 1,
    provisionTypeID: Number.isSafeInteger(Number(value.provisionTypeID)) && number(value.provisionTypeID) > 0
      ? number(value.provisionTypeID) : null,
    links: (Array.isArray(value.links) ? value.links : []).filter((link) =>
      Array.isArray(link) && link.length === 3 && link.every((id) => Number.isSafeInteger(id) && id > 0))
      .map((link) => [...link]),
    nextCycleAtMs: number(value.nextCycleAtMs) || null,
    lastCycleAtMs: number(value.lastCycleAtMs) || null,
    cyclesCompleted: Math.max(0, Math.trunc(number(value.cyclesCompleted))),
    status: String(value.status || "unconfigured"),
    lastError: value.lastError ? String(value.lastError) : null,
    authorityFingerprint: String(value.authorityFingerprint || ""),
  };
}

function requireTower(session, towerID, mutation = false) {
  // moonmining.py:88,1226-1233 reads the moon while opening management and
  // closes the window on UserError. Resolve persisted authority here so that
  // inventory range is applied only to mutations; reads still require the
  // same corporation, anchored tower and visible local scene below.
  const result = require("./starbaseAccessRuntime").getTowerConfiguration(session, towerID, {
    authority: require("../corporation/corporationAuthority").getPersistedCorporationAuthority(session),
  });
  if (!result.success) return result;
  const { tower, authority } = result.data;
  if (mutation && !authority.isCEO && !authority.isDirector &&
      !require("../corporation/corporationAuthority").corporationAuthorityHasRole(authority, CONFIG_ROLE)) {
    return fail("STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED");
  }
  if (require("./starbaseDefenseRuntime").hasUnavailableHealth(tower) ||
      require("./starbaseReinforcementRuntime").isReinforced(tower.itemID)) {
    return fail("STARBASE_PRODUCTION_TOWER_UNAVAILABLE");
  }
  const access = require("./starbaseInventoryRuntime").validateStarbaseInventoryAccess(
    session, tower, { allowOffline: true, maxDistanceMeters: mutation ? 30000 : Infinity },
  );
  return access.success ? result : access;
}

function isAssociated(tower, item) {
  return isProductionStructure(item) && number(item.ownerID) === number(tower.ownerID) &&
    number(item.locationID) === number(tower.locationID) && number(item.flagID) === 0 &&
    number(item.spaceState?.controlTowerID) === number(tower.itemID) &&
    item.spaceState?.anchorState === "anchored" && item.spaceState?.isFree !== true &&
    !require("./starbaseDefenseRuntime").hasUnavailableHealth(item);
}

function withProduction(item, production) {
  return { ...item, spaceState: { ...item.spaceState, starbaseModuleState: {
    ...item.spaceState?.starbaseModuleState, production,
  } } };
}

function canSiloStoreType(silo, typeID) {
  const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(typeID);
  if (!type) return false;
  const group = typeAttribute(silo.typeID, 629);
  const second = typeAttribute(silo.typeID, 1846);
  // moonmining.py:1282-1292; specialized silos restrict cargo groups.
  const groups = group > 0 ? [group, second].filter(Boolean) : [427, 429, 428, 711, 18];
  return groups.includes(number(type.groupID));
}

function getProductionPorts(tower, item, authority = require("./starbaseProductionAuthority").getProductionAuthority()) {
  const provision = getProductionState(item).provisionTypeID;
  if (item.groupID === GROUP_SILO) return { inputs: provision ? [provision] : [], outputs: provision ? [provision] : [] };
  if (item.groupID === GROUP_HARVESTER) {
    const moon = authority.getMoon(tower.spaceState?.moonID, tower.locationID);
    if (!moon) return { errorMsg: "STARBASE_LEGACY_MOON_AUTHORITY_MISSING" };
    const resource = moon.resources.find((row) => row.typeID === provision);
    return resource ? { inputs: [], outputs: [provision], resource } : { inputs: [], outputs: [] };
  }
  const loaded = inventory().listContainerItems(null, item.itemID, 0);
  const reaction = loaded.length === 1 && loaded[0].ownerID === item.ownerID &&
    !loaded[0].custodyReservation && number(loaded[0].stacksize) === 1 && authority.getReaction(loaded[0].typeID);
  if (!reaction || ![typeAttribute(item.typeID, 842), typeAttribute(item.typeID, 843)].includes(number(loaded[0]?.groupID))) {
    return { errorMsg: "STARBASE_LEGACY_REACTION_AUTHORITY_MISSING" };
  }
  return { inputs: reaction.inputs.map((row) => row.typeID), outputs: reaction.outputs.map((row) => row.typeID), reaction, loaded: loaded[0] };
}

function publishConfiguration(session, towerID, result) {
  if (!result.success) return result;
  const scene = require("../../space/runtime").getSceneForSession(session);
  try {
  const changes = result.changes || result.data?.changes || [];
  for (const change of changes) {
    const entity = scene?.getEntityByID(number(change.item?.itemID));
    if (entity && change.item?.spaceState) {
      entity.spaceState = structuredClone(change.item.spaceState);
      entity.starbaseModuleState = structuredClone(change.item.spaceState.starbaseModuleState || {});
    }
  }
  // The current callback only tests towerID and ignores structures (1352-1356).
  // Do not invent a removed wire representation for legacy graph rows.
  for (const observer of new Set([session, ...(scene?.sessions?.values() || [])])) {
    if (observer?.sendNotification && require("./starbaseAccessRuntime").getTowerConfiguration(observer, towerID).success) {
      observer.sendNotification("OnMoonProcessChange", "clientID", [towerID, []]);
    }
  }
  } catch (error) {
    require("../../utils/logger").warn(`[StarbaseProduction] Configuration committed; presentation will recover on refresh: ${error.message}`);
  }
  // Presentation errors cannot prevent arming an already committed graph.
  try {
    const tower = inventory().findItemById(towerID);
    if (getProductionState(tower).links.length) require("./starbaseProductionCycles").reconcileTowerProduction(towerID, { scene });
  } catch (error) {
    require("../../utils/logger").warn(`[StarbaseProduction] Configuration scheduling will recover on restart: ${error.message}`);
  }
  return result;
}

function changeStructureProvisionType(session, towerID, itemID, provisionTypeID) {
  const context = requireTower(session, towerID, true);
  if (!context.success) return context;
  const { tower } = context.data;
  const item = inventory().findItemById(number(itemID));
  if (!isAssociated(tower, item)) return fail("STARBASE_PRODUCTION_STRUCTURE_INVALID");
  if (item.spaceState.onlineState !== "offline") return fail("STARBASE_PRODUCTION_MUST_BE_OFFLINE");
  if (number(item.groupID) === GROUP_HARVESTER && provisionTypeID != null) {
    const moon = require("./starbaseProductionAuthority").getProductionAuthority().getMoon(tower.spaceState?.moonID, tower.locationID);
    if (!moon) return fail("STARBASE_LEGACY_MOON_AUTHORITY_MISSING");
    if (!moon.resources.some((row) => row.typeID === number(provisionTypeID))) return fail("STARBASE_PRODUCTION_PROVISION_INVALID");
    if (inventory().listSystemSpaceItems(tower.locationID).some((row) => row.itemID !== item.itemID &&
        isAssociated(tower, row) && row.groupID === GROUP_HARVESTER && getProductionState(row).provisionTypeID === number(provisionTypeID))) {
      return fail("STARBASE_PRODUCTION_HARVESTER_DUPLICATE");
    }
  }
  if (number(item.groupID) === GROUP_REACTOR) return fail("STARBASE_LEGACY_REACTION_AUTHORITY_MISSING");
  if (provisionTypeID != null && (!Number.isSafeInteger(Number(provisionTypeID)) || number(provisionTypeID) <= 0 ||
      (item.groupID === GROUP_SILO && !canSiloStoreType(item, number(provisionTypeID))))) return fail("STARBASE_PRODUCTION_PROVISION_INVALID");
  const chosen = provisionTypeID == null ? null : number(provisionTypeID);
  const contents = inventory().listContainerItems(null, item.itemID, null);
  if (contents.some((row) => number(row.typeID) !== chosen)) return fail("STARBASE_PRODUCTION_CONTENTS_CONFLICT");
  const state = getProductionState(tower);
  state.links = state.links.filter(([from, to]) => from !== item.itemID && to !== item.itemID);
  state.nextCycleAtMs = null;
  const moduleState = { ...getProductionState(item), provisionTypeID: chosen };
  return publishConfiguration(session, tower.itemID,
    inventory().updateInventoryItemsAtomic([tower.itemID, item.itemID], (current) =>
      withProduction(current, current.itemID === tower.itemID ? state : moduleState)));
}

function linkResourceForTower(session, towerID, rawLinks) {
  const context = requireTower(session, towerID, true);
  if (!context.success) return context;
  const { tower } = context.data;
  if (!Array.isArray(rawLinks) || rawLinks.length > 1024) return fail("STARBASE_PRODUCTION_LINK_INVALID");
  const links = [];
  const outgoing = new Set();
  const incoming = new Set();
  const graph = new Map();
  for (const row of rawLinks) {
    if (!Array.isArray(row) || row.length !== 3 || !row.every((id) => Number.isSafeInteger(Number(id)) && number(id) > 0)) {
      return fail("STARBASE_PRODUCTION_LINK_INVALID");
    }
    const [fromID, toID, typeID] = row.map(Number);
    const from = inventory().findItemById(fromID);
    const to = inventory().findItemById(toID);
    if (fromID === toID || !isAssociated(tower, from) || !isAssociated(tower, to)) return fail("STARBASE_PRODUCTION_LINK_INVALID");
    const source = getProductionPorts(tower, from), destination = getProductionPorts(tower, to);
    if (source.errorMsg || destination.errorMsg) return fail(source.errorMsg || destination.errorMsg);
    if (!source.outputs.includes(typeID) || !destination.inputs.includes(typeID)) return fail("STARBASE_PRODUCTION_LINK_TYPE_MISMATCH");
    const sourceKey = `${fromID}:${typeID}`;
    const destinationKey = `${toID}:${typeID}`;
    if (outgoing.has(sourceKey) || incoming.has(destinationKey)) return fail("STARBASE_PRODUCTION_LINK_DUPLICATE");
    outgoing.add(sourceKey); incoming.add(destinationKey);
    graph.set(fromID, [...(graph.get(fromID) || []), toID]); links.push([fromID, toID, typeID]);
  }
  const visiting = new Set(), visited = new Set();
  const cycle = (node) => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) if (cycle(next)) return true;
    visiting.delete(node); visited.add(node); return false;
  };
  if ([...graph.keys()].some(cycle)) return fail("STARBASE_PRODUCTION_LINK_CYCLE");
  links.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  return publishConfiguration(session, tower.itemID,
    inventory().updateInventoryItemsAtomic([tower.itemID], (current) => withProduction(current,
      { ...getProductionState(current), links, nextCycleAtMs: null })));
}

function validateProductionInventoryAccess(session, itemOrID, operation = "viewput") {
  const runtime = require("./starbaseInventoryRuntime");
  const access = runtime.validateStarbaseInventoryAccess(session, itemOrID, { allowOffline: true });
  if (!access.success) return access;
  const { item, tower } = access.data;
  if (!isProductionStorage(item)) return fail("STARBASE_PRODUCTION_STRUCTURE_INVALID");
  if (item.spaceState.onlineState !== "offline") return fail("STARBASE_PRODUCTION_MUST_BE_OFFLINE");
  if (require("./starbaseDefenseRuntime").hasUnavailableHealth(item) ||
      require("./starbaseDefenseRuntime").hasUnavailableHealth(tower) ||
      require("./starbaseReinforcementRuntime").isReinforced(tower.itemID)) return fail("STARBASE_PRODUCTION_TOWER_UNAVAILABLE");
  return runtime.hasMaintenanceInventoryPermission(session, tower, item.itemID, operation)
    ? access : fail("STARBASE_PRODUCTION_ACCESS_DENIED");
}

function getProductionCapacity(item) {
  return isProductionStorage(item)
    ? Math.max(0, number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(item.typeID)?.capacity)) : 0;
}

function validateProductionDeposit(item, destination, quantity, projected = null) {
  const silo = inventory().findItemById(number(destination?.locationID));
  if (!isProductionStorage(silo)) return ok(null);
  if (silo.groupID === GROUP_REACTOR) {
    const valid = item && item.categoryID === 24 && number(destination.flagID) === 0 &&
      [typeAttribute(silo.typeID, 842), typeAttribute(silo.typeID, 843)].includes(item.groupID) &&
      require("./starbaseProductionAuthority").getProductionAuthority().getReaction(item.typeID);
    if (!valid) return fail("STARBASE_LEGACY_REACTION_AUTHORITY_MISSING");
    if (silo.spaceState?.onlineState !== "offline") return fail("STARBASE_PRODUCTION_MUST_BE_OFFLINE");
    const contents = (projected || inventory().listContainerItems(null, silo.itemID, null)).filter((row) => row.itemID !== item.itemID);
    const units = quantity == null ? number(item.stacksize) : number(quantity);
    return (quantity === undefined || units === 1) && contents.length === 0 ? ok(null) : fail("STARBASE_PRODUCTION_CAPACITY");
  }
  if (!item || number(destination.flagID) !== 0 || number(item.typeID) !== getProductionState(silo).provisionTypeID ||
      !canSiloStoreType(silo, item.typeID)) return fail("STARBASE_PRODUCTION_PROVISION_INVALID");
  if (silo.spaceState?.onlineState !== "offline") return fail("STARBASE_PRODUCTION_MUST_BE_OFFLINE");
  if (quantity !== undefined) {
    const units = (row) => number(row.singleton) === 1 ? 1 : number(row.stacksize ?? row.quantity);
    const volume = (row) => Math.max(0, number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(row.typeID)?.volume));
    const contents = projected || inventory().listContainerItems(null, silo.itemID, null);
    const used = contents.filter((row) => row.itemID !== item.itemID).reduce((sum, row) => sum + units(row) * volume(row), 0);
    if (used + (quantity == null ? units(item) : number(quantity)) * volume(item) > getProductionCapacity(silo) + 1e-7) {
      return fail("STARBASE_PRODUCTION_CAPACITY");
    }
  }
  return ok(null);
}

function validateProductionBatch(moves) {
  const projected = new Map();
  for (const { item, destination, quantity } of moves) {
    if (!isProductionStorage(inventory().findItemById(number(destination?.locationID)))) continue;
    const key = number(destination.locationID);
    const contents = projected.get(key) || inventory().listContainerItems(null, key, null);
    const result = validateProductionDeposit(item, destination, quantity, contents);
    if (!result.success) return result;
    const units = quantity == null ? (number(item.singleton) === 1 ? 1 : number(item.stacksize ?? item.quantity)) : number(quantity);
    projected.set(key, [...contents.filter((row) => row.itemID !== item.itemID), { ...item, quantity: units, stacksize: units }]);
  }
  return ok(null);
}

function getMoonForTower(session, towerID) {
  const context = requireTower(session, towerID);
  if (!context.success) return context;
  const moon = require("../ship/controlTowerRuntime").getControlTowerMoon(context.data.tower);
  if (!moon?.moonID) return fail("CONTROL_TOWER_MOON_REQUIRED");
  const profile = require("./starbaseProductionAuthority").getProductionAuthority().getMoon(moon.moonID, context.data.tower.locationID);
  // Never substitute current moon ore fractions for historical abundance.
  return ok([moon.moonID, profile ? profile.resources.map((row) => [row.typeID, row.abundance]) : null]);
}

function runProcessCycle(session, towerID) {
  const context = requireTower(session, towerID, true);
  if (!context.success) return context;
  let role;
  try { role = BigInt(session.role || 0); } catch { role = 0n; }
  if ((role & 18014398509481984n) === 0n) return fail("STARBASE_PRODUCTION_GM_REQUIRED");
  return require("./starbaseProductionCycles").reconcileTowerProduction(towerID, { force: true,
    scene: require("../../space/runtime").getSceneForSession(session) });
}

function executeProductionCommand(session, text) {
  const [action, rawTowerID, ...args] = String(text || "").trim().split(/\s+/);
  const towerID = Number(rawTowerID);
  const usage = "Server diagnostic: /pos production status|cycle <towerID>; provision <towerID> <moduleID> <typeID|none>; link <towerID> <fromID> <toID> <typeID>; unlink <towerID> <fromID> <typeID>; clear <towerID>.";
  if (!Number.isSafeInteger(towerID) || towerID <= 0 || !["status", "cycle", "provision", "link", "unlink", "clear"].includes(action)) {
    return { success: false, message: usage };
  }
  const context = requireTower(session, towerID, action !== "status");
  if (!context.success) return { success: false, message: `Production access denied: ${context.errorMsg}.` };
  const { tower } = context.data;
  let result;
  if (action === "status" && args.length === 0) {
    const authority = require("./starbaseProductionAuthority").getProductionAuthority();
    const modules = inventory().listSystemSpaceItems(tower.locationID).filter((row) => isAssociated(tower, row))
      .map((row) => ({ itemID: row.itemID, typeID: row.typeID, provisionTypeID: getProductionState(row).provisionTypeID }));
    return { success: true, message: `Server-only production diagnostic; current client has no editable production graph. ${JSON.stringify({
      towerID, authority: { datasetVersion: authority.datasetVersion, authorityClass: authority.authorityClass,
        reactionCount: authority.reactionCount, moonCount: authority.moonCount }, state: getProductionState(tower), modules: modules.slice(0, 40),
      moreModules: Math.max(0, modules.length - 40),
    })}` };
  } else if (action === "cycle" && args.length === 0) {
    result = runProcessCycle(session, towerID);
  } else if (action === "provision" && args.length === 2 && Number.isSafeInteger(Number(args[0]))) {
    result = changeStructureProvisionType(session, towerID, Number(args[0]), args[1] === "none" ? null : Number(args[1]));
  } else if (action === "link" && args.length === 3 && args.every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) {
    const [from, to, typeID] = args.map(Number);
    const links = getProductionState(tower).links.filter(([source, , type]) => source !== from || type !== typeID);
    result = linkResourceForTower(session, towerID, [...links, [from, to, typeID]]);
  } else if (action === "unlink" && args.length === 2 && args.every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) {
    const [from, typeID] = args.map(Number);
    result = linkResourceForTower(session, towerID, getProductionState(tower).links.filter(([source, , type]) => source !== from || type !== typeID));
  } else if (action === "clear" && args.length === 0) {
    result = linkResourceForTower(session, towerID, []);
  } else return { success: false, message: usage };
  if (result.success) require("./posGmState").logPosGmAction(session, `production-${action}`, tower);
  if (result.errorMsg === "STARBASE_PRODUCTION_WRITE_ERROR") return { success: false,
    message: "Production persistence failed. Check /pos production status <towerID> before forcing another cycle; automatic recovery uses the saved checkpoint." };
  return { success: result.success,
    message: result.success ? `Server production ${action} completed for tower ${towerID}.` : `Production ${action} refused: ${result.errorMsg}. No production output was created by this request.` };
}

function unavailableProcess(session, towerID) {
  const context = requireTower(session, towerID, true);
  if (!context.success) return context;
  return fail("STARBASE_PRODUCTION_INFO_PAYLOAD_UNVERIFIED");
}

function requireProductionResult(result) {
  if (result?.success) return result.data;
  const messages = {
    STARBASE_LEGACY_REACTION_AUTHORITY_MISSING: "Legacy POS reaction recipes are not available in the pinned data. This reactor cannot be configured.",
    STARBASE_LEGACY_MOON_AUTHORITY_MISSING: "No verified historical POS moon-material abundance is available for this moon. Harvesting cannot be configured.",
    STARBASE_LEGACY_PRODUCTION_UNAVAILABLE: "Legacy POS production is not available: historical recipes, moon abundance and the removed production interface have not been restored. No cycle was run.",
    STARBASE_PRODUCTION_INFO_PAYLOAD_UNVERIFIED: "The historical production-info RPC payload is unavailable in this client build. Use /pos production status <towerID> for server diagnostics.",
    STARBASE_PRODUCTION_MUST_BE_OFFLINE: "Offline this starbase production structure before changing its material type.",
    STARBASE_PRODUCTION_CONTENTS_CONFLICT: "Empty the silo before changing its stored material type.",
    STARBASE_PRODUCTION_PROVISION_INVALID: "This material cannot be stored in that silo.",
    STARBASE_PRODUCTION_LINK_INVALID: "Production links must connect valid structures belonging to this control tower.",
    STARBASE_PRODUCTION_LINK_TYPE_MISMATCH: "Both linked silos must be configured for the same material.",
    STARBASE_PRODUCTION_LINK_DUPLICATE: "A material may have only one source and one destination at each production connection.",
    STARBASE_PRODUCTION_LINK_CYCLE: "Production links cannot form a circular chain.",
    STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED: "You need the Config Starbase Equipment corporation role to configure production.",
    STARBASE_PRODUCTION_ACCESS_DENIED: "Your corporation roles do not permit access to this starbase silo.",
    STARBASE_PRODUCTION_CAPACITY: "There is not enough space in the silo for these materials.",
    STARBASE_PRODUCTION_GM_REQUIRED: "Only a Game Master may force a starbase production cycle.",
    STARBASE_PRODUCTION_WRITE_ERROR: "Production persistence failed. Check /pos production status <towerID> before forcing another cycle; automatic recovery uses the saved checkpoint.",
    STARBASE_PRODUCTION_HARVESTER_DUPLICATE: "This tower already has a harvester configured for that moon material.",
  };
  require("../../common/machoErrors").throwWrappedUserError("CustomNotify", {
    notify: messages[result?.errorMsg] || "You cannot access this control tower's production configuration from your current corporation, location or structure state.",
  });
}

module.exports = { isProductionStructure, isProductionStorage, getProductionState, canSiloStoreType,
  changeStructureProvisionType, linkResourceForTower, getMoonForTower,
  unavailableProcess, requireProductionResult, validateProductionInventoryAccess,
  getProductionCapacity, validateProductionDeposit, validateProductionBatch,
  getProductionPorts, isAssociated, typeAttribute, withProduction, runProcessCycle, executeProductionCommand };
