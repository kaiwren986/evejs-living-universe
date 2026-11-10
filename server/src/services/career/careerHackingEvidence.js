"use strict";

// Only the production analyzer/core handler writes this character-owned ledger.
// UI start-game requests and client telemetry cannot mint hacking progress.
const characters = require("../character/characterState");
const database = require("../../gameStore");
const dungeonRuntime = require("../dungeon/dungeonRuntime");
const dungeonAuthority = require("../dungeon/dungeonAuthority");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");

const LIMIT = 8192;
const FIELD = "careerHackingEvidence";
const SOURCE = Object.freeze({ kind: "module-hacks", id: "module-hacks:v1" });
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const text = value => String(value || "").toLowerCase();
const keyFor = (instanceID, objectID) => `site:${instanceID}:object:${objectID}`;

function readLedger(record) {
  const stored = record && record[FIELD];
  if (stored === undefined) return {};
  if (!stored || stored.version !== 1 || !stored.receipts || typeof stored.receipts !== "object" ||
      Array.isArray(stored.receipts) || Object.keys(stored.receipts).length > LIMIT) return null;
  for (const [key, receipt] of Object.entries(stored.receipts)) {
    if (!receipt || key !== keyFor(positive(receipt.instanceID), positive(receipt.objectID)) ||
        !positive(receipt.instanceID) || !positive(receipt.objectID) || !positive(receipt.shipID) ||
        !positive(receipt.moduleTypeID) || !positive(receipt.completedAtMs) ||
        !["data", "relic"].includes(receipt.analyzer) || receipt.provenance !== "server-analyzer" ||
        typeof receipt.templateID !== "string" || !receipt.templateID) return null;
    if ((receipt.solarSystemID !== undefined || receipt.securityClass !== undefined) &&
        (!positive(receipt.solarSystemID) || !["high", "low", "null", "wormhole"].includes(receipt.securityClass))) return null;
  }
  return stored.receipts;
}

function observe(characterID, options = {}) {
  const record = characters.peekCharacterRecord(positive(characterID));
  if (!record) return null;
  const receipts = readLedger(record);
  if (!receipts) return null;
  const filter = options.securityClass;
  if (filter !== undefined && !["high", "low", "null", "wormhole"].includes(filter)) return null;
  const matches = Object.values(receipts).filter(receipt => filter === undefined || receipt.securityClass === filter);
  return { ...SOURCE, ...(filter ? { id: `module-hacks:${filter}:v1` } : {}), progress: matches.length,
    updatedAtMs: matches.reduce((latest, receipt) => Math.max(latest, receipt.completedAtMs), 0) };
}

// A number for a content key, the same for the same key (the server's FNV-1a text hash),
// placed above 2^40, where no client dungeon object ID (six or seven digits) can meet it.
function contentKeyObjectID(contentKey) {
  return 2 ** 40 + require("../../common/random").hashSeed(contentKey);
}

function eligibleTarget(attempt, session) {
  if (attempt?.serverAnalyzer !== true || attempt.depotBoard === true || attempt.completed === true) return null;
  const characterID = positive(resolveSessionCharacterID(session));
  if (!characterID || positive(resolveSessionCharacterID(attempt.session)) !== characterID) return null;
  const target = attempt.target, entity = target?.entity, scene = target?.scene;
  const analyzer = text(entity?.dungeonSiteContentAnalyzer);
  if (!scene || !entity || entity.homefrontKey || entity.dungeonMaterializedContainer !== true ||
      entity.dungeonMaterializedSiteContent !== true || !["data", "relic"].includes(analyzer) ||
      positive(entity.itemID) !== positive(attempt.targetID)) return null;
  const liveEntity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(entity.itemID)
    : scene.staticEntitiesByID?.get(entity.itemID) || scene.dynamicEntities?.get(entity.itemID);
  if (liveEntity !== entity) return null;
  const instanceID = positive(entity.dungeonSiteInstanceID);
  let objectID = positive(entity.dungeonSourceObjectID || entity.dunObjectID);
  const instance = instanceID && dungeonRuntime.getInstance(instanceID);
  // Authored container identity survives rematerialization; item IDs and scene
  // generations do not. Only an installed template's actual data/relic object
  // can earn a receipt, never an arbitrary scene container with copied flags.
  const template = instance && dungeonAuthority.getTemplateByID(instance.templateID);
  // Career agent missions are mission sites, but their data and relic containers count: the
  // Explorer's Data and Relic Training Sites (parts 3 and 4) and the Business chain's Balancing
  // the Books (4 and 7 of 10). Other mission sites do not.
  const careerAgentSite = template?.populationHints?.source === "career_agents";
  const containers = template?.populationHints?.containers || [];
  let container = objectID ? containers.find(candidate => (
    positive(candidate.dunObjectID || candidate.objectID) === objectID && text(candidate.analyzer) === analyzer
  )) : null;
  if (!container && !objectID && careerAgentSite && entity.dungeonSiteContentKey) {
    // A container the career agents pack adds without a client dungeon object (Balancing the
    // Books (4 of 10)) is identified by its content key, the identity the site's own state keeps
    // it under; the template must have such a container of this role and analyzer.
    container = containers.find(candidate => !positive(candidate.dunObjectID || candidate.objectID) &&
      text(candidate.analyzer) === analyzer && text(candidate.role) === text(entity.dungeonSiteContentRole));
    if (container) objectID = contentKeyObjectID(entity.dungeonSiteContentKey);
  }
  if (!instance || !objectID || instance.metadata?.homefront === true ||
      positive(instance.solarSystemID) !== positive(scene.systemID)) return null;
  if (!careerAgentSite && (!["data", "relic"].includes(text(instance.siteFamily)) ||
      text(instance.siteKind) !== "signature" || instance.runtimeFlags?.missionRuntime === true ||
      instance.metadata?.missionRuntime === true || instance.ownership?.missionOwnerCharacterID)) return null;
  if (!container || (!careerAgentSite && !["data", "relic"].includes(text(template.siteFamily))) ||
      template.populationHints?.homefront === true ||
      require("../seasons/eventHooks").depot.getRecord(entity)) return null;
  const shipID = positive(attempt.shipID), currentShipID = positive(session?._space?.shipID || session?.shipid || session?.shipID);
  if (!shipID || shipID !== currentShipID || !positive(attempt.moduleTypeID)) return null;
  const fittedAnalyzer = require("../inventory/itemStore").listContainerItems(characterID, shipID).some(item => (
    positive(item.typeID) === positive(attempt.moduleTypeID) && Number(item.flagID) >= 11 &&
    Number(item.flagID) <= 34 && item.moduleState?.online === true
  ));
  if (!fittedAnalyzer) return null;
  if ((analyzer === "data" ? 0 : 1) !== Number(attempt.gameType)) return null;
  const securityClass = require("./careerExplorationSources").securityClass(instance.solarSystemID);
  if (!securityClass) return null;
  return { characterID, instanceID, objectID, analyzer, shipID, moduleTypeID: positive(attempt.moduleTypeID),
    templateID: String(instance.templateID), solarSystemID: positive(instance.solarSystemID), securityClass };
}

function flush() {
  try { return database.flushTableSync("characters") || { success: false, errorMsg: "CAREER_HACK_FLUSH_FAILED" }; }
  catch (error) { return { success: false, errorMsg: error.message || "CAREER_HACK_FLUSH_FAILED" }; }
}

function prepareWin(attempt, session, options = {}) {
  const target = eligibleTarget(attempt, session);
  if (!target) return { success: true, eligible: false };
  const completedAtMs = positive(Math.trunc(Number(options.nowMs))) ||
    positive(Math.trunc(require("../../space/runtime/runtimeClock").getWallclockNowMs()));
  return { success: true, eligible: true, prepared: {
    version: 1, ...target, completedAtMs, provenance: "server-analyzer",
  } };
}

function isPreparedWin(prepared) {
  return Boolean(prepared && prepared.version === 1 && prepared.provenance === "server-analyzer" &&
    ["characterID", "instanceID", "objectID", "shipID", "moduleTypeID", "completedAtMs"]
      .every(key => positive(prepared[key])) && ["data", "relic"].includes(prepared.analyzer) &&
    typeof prepared.templateID === "string" && prepared.templateID.trim().length > 0 &&
    ((prepared.solarSystemID === undefined && prepared.securityClass === undefined) ||
      (positive(prepared.solarSystemID) && ["high", "low", "null", "wormhole"].includes(prepared.securityClass))));
}

// Only a server-prepared payload retained in the dungeon outcome carrier may
// enter here. Recovery deliberately does not require its pilot/module to still
// be on grid: that authority was checked when the winning turn was prepared.
function commitPreparedWin(prepared) {
  if (!isPreparedWin(prepared)) return { success: false, errorMsg: "CAREER_HACK_PREPARED_WIN_INVALID" };
  const target = {
    ...Object.fromEntries(["characterID", "instanceID", "objectID", "analyzer", "shipID", "moduleTypeID", "templateID"]
      .map(key => [key, prepared[key]])),
    // Retain geography from preparation, never the pilot's later location.
    // Older durable wins have no geography and remain general-only evidence.
    ...(prepared.securityClass !== undefined
      ? { solarSystemID: positive(prepared.solarSystemID), securityClass: prepared.securityClass } : {}),
  };
  const record = characters.getCharacterRecord(target.characterID), receipts = readLedger(record);
  if (!record) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  if (!receipts) return { success: false, errorMsg: "CAREER_HACK_LEDGER_INVALID" };
  const key = keyFor(target.instanceID, target.objectID), existing = receipts[key];
  if (existing && (existing.templateID !== target.templateID || existing.analyzer !== target.analyzer))
    return { success: false, errorMsg: "CAREER_HACK_RECEIPT_CONFLICT" };
  if (!existing && Object.keys(receipts).length >= LIMIT)
    return { success: false, errorMsg: "CAREER_HACK_RECEIPT_CAPACITY" };
  if (!existing) {
    const { characterID, ...identity } = target;
    const written = characters.updateCharacterRecord(characterID, current => ({ ...current,
      [FIELD]: { version: 1, receipts: { ...receipts,
        [key]: { ...identity, completedAtMs: prepared.completedAtMs, provenance: "server-analyzer" } } },
    }));
    if (!written?.success) return written || { success: false, errorMsg: "CAREER_HACK_WRITE_FAILED" };
  }
  // Even duplicate requests must cross the durability barrier. An earlier
  // failed flush is not acknowledged merely because its cache entry exists.
  const durable = flush();
  if (!durable.success) {
    if (!existing) {
      const restored = characters.updateCharacterRecord(target.characterID, () => record);
      if (!restored?.success) return { success: false, errorMsg: "CAREER_HACK_ROLLBACK_FAILED", ambiguous: true };
    }
    return durable;
  }
  return { success: true, eligible: true, duplicate: Boolean(existing), characterID: target.characterID };
}

function commitWin(attempt, session, options = {}) {
  const result = prepareWin(attempt, session, options);
  return result.eligible ? commitPreparedWin(result.prepared) : result;
}

module.exports = { observe, prepareWin, isPreparedWin, commitPreparedWin, commitWin };
