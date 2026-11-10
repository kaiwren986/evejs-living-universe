"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");
const securityBindings = require("../../contentPacks/securityMissionBinding");
const { buildLegacyTemplate } = require("./capturedSecurityLegacyScenes");

const {
  applyDungeonContentPacks,
  initializeContentPacks,
} = require(path.join(__dirname, "../../contentPacks/contentPackManager"));
const {
  mergeClientContentPayload,
  readCoreDungeonAuthorityPayload,
} = require(path.join(__dirname, "./dungeonAuthorityPayload"));
const {
  applyCuratedHackableContent,
} = require(path.join(__dirname, "./dungeonCuratedHackableContent"));
const {
  isDisabledMissionIdentifier,
  isDisabledMissionSourceURL,
  isDisabledMissionTemplateIdentifier,
  productionMissionPolicy,
} = require(path.join(__dirname, "../../config/productionMissionPolicy"));

let cache = null;
const BANNED_DUNGEON_TEMPLATE_IDS = new Set(
  productionMissionPolicy.disabledMissions
    .flatMap(({ templateIDs }) => templateIDs)
    .map((templateID) => templateID.toLowerCase()),
);
const BANNED_SOURCE_MISSION_IDS = new Set(
  productionMissionPolicy.disabledMissions.flatMap(({ missionID, templateIDs }) => [
    String(missionID),
    ...templateIDs.map((templateID) => templateID.split(":").pop().toLowerCase()),
  ]),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Adapted from ciefa/evejs-ciefa-fork 84136a92a1958118af2f9bc2888012a699fe2434.
// Existing getters below still return mutable copies. Audited read-only callers
// share one detached, deeply frozen view of each authority record. Rebuilding
// the authority creates new record identities, retiring the old weak entries.
const readOnlyViews = new WeakMap();

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function readOnlyView(record) {
  if (!record) return null;
  if (!readOnlyViews.has(record)) readOnlyViews.set(record, freezeDeep(clone(record)));
  return readOnlyViews.get(record);
}

function normalizeObject(value) {
  return value && typeof value === "object" ? value : {};
}

// Universe planning only needs a small, stable subset of a dungeon template
// to choose a candidate and evaluate its spawn policy.  Full templates carry
// client room graphs, environment geometry, and population materialization
// data (often tens of KB each), so cloning every member of a candidate family
// on the player-entry path is prohibitively expensive.  These descriptors are
// built once with the authority cache, are deliberately immutable, and never
// expose the mutable internal full-template records.
const EMPTY_TEMPLATE_SELECTION_DESCRIPTORS = Object.freeze([]);

function copySelectionScalar(value) {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

function copySelectionArray(value) {
  return Object.freeze((Array.isArray(value) ? value : [])
    .map(copySelectionScalar));
}

function buildSelectionSpawnQueryEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return Object.freeze({
    spawnQuery: copySelectionScalar(value.spawnQuery),
  });
}

function buildTemplateSelectionDescriptor(template = {}) {
  const source = template && typeof template === "object" ? template : {};
  const archetype = normalizeObject(source.archetype);
  const metadata = normalizeObject(source.metadata);
  const populationHints = normalizeObject(source.populationHints);
  const encounter = buildSelectionSpawnQueryEntry(populationHints.encounter);
  const encounters = Object.freeze((Array.isArray(populationHints.encounters)
    ? populationHints.encounters
    : [])
    .map(buildSelectionSpawnQueryEntry)
    .filter(Boolean));
  const selectionPopulationHints = {};
  if (encounter) {
    selectionPopulationHints.encounter = encounter;
  }
  if (encounters.length > 0) {
    selectionPopulationHints.encounters = encounters;
  }

  const descriptor = {
    templateID: copySelectionScalar(source.templateID),
    source: copySelectionScalar(source.source),
    siteFamily: copySelectionScalar(source.siteFamily),
    siteKind: copySelectionScalar(source.siteKind),
    sourceDungeonID: copySelectionScalar(source.sourceDungeonID),
    archetypeID: copySelectionScalar(source.archetypeID),
    dungeonNameID: copySelectionScalar(source.dungeonNameID),
    missionBriefingID: copySelectionScalar(source.missionBriefingID),
    difficulty: copySelectionScalar(source.difficulty),
    resolvedName: copySelectionScalar(source.resolvedName),
    name: copySelectionScalar(source.name),
    siteVariant: copySelectionScalar(source.siteVariant),
    siteTier: copySelectionScalar(source.siteTier),
    factionKey: copySelectionScalar(source.factionKey),
    factionID: copySelectionScalar(source.factionID),
    faction: copySelectionScalar(source.faction),
    factionName: copySelectionScalar(source.factionName),
    pirateFaction: copySelectionScalar(source.pirateFaction),
    npcFaction: copySelectionScalar(source.npcFaction),
    factionScope: copySelectionScalar(source.factionScope),
    dedRating: copySelectionScalar(source.dedRating),
    randomSpawnEligible: source.randomSpawnEligible === true,
    sourceMissionID: copySelectionScalar(source.sourceMissionID),
    missionID: copySelectionScalar(source.missionID),
    sourceUrl: copySelectionScalar(source.sourceUrl),
    sourceURL: copySelectionScalar(source.sourceURL),
    archetype: Object.freeze({
      location: copySelectionScalar(archetype.location),
    }),
    metadata: Object.freeze({
      factionKey: copySelectionScalar(metadata.factionKey),
      faction: copySelectionScalar(metadata.faction),
      factionName: copySelectionScalar(metadata.factionName),
    }),
    adminMetadata: Object.freeze({
      sourceUrl: copySelectionScalar(
        source.adminMetadata && source.adminMetadata.sourceUrl,
      ),
      sourceURL: copySelectionScalar(
        source.adminMetadata && source.adminMetadata.sourceURL,
      ),
    }),
    populationHints: Object.freeze(selectionPopulationHints),
    wormholeShatteredOnly: source.wormholeShatteredOnly === true,
    wormholeShatteredAlso: source.wormholeShatteredAlso === true,
    securityBands: copySelectionArray(source.securityBands),
    securityBandSourceRefs: copySelectionArray(source.securityBandSourceRefs),
  };
  // Absence is significant here: the wormhole authority treats a declared
  // empty class array as an explicit "never in wormholes" restriction, while
  // an omitted field is allowed to fall through to its family/name rules.
  if (Array.isArray(source.wormholeClasses)) {
    descriptor.wormholeClasses = copySelectionArray(source.wormholeClasses);
  }
  return Object.freeze(descriptor);
}

function isBannedDungeonTemplateID(templateID) {
  const normalizedTemplateID = String(templateID || "").trim().toLowerCase();
  return isDisabledMissionTemplateIdentifier(normalizedTemplateID) ||
    isDisabledMissionSourceURL(normalizedTemplateID) ||
    isDisabledMissionIdentifier(normalizedTemplateID);
}

function isBannedDungeonTemplateRecord(record = null, fallbackTemplateID = "") {
  const sourceMissionID = String(record && record.sourceMissionID || "")
    .trim()
    .toLowerCase();
  return isBannedDungeonTemplateID(fallbackTemplateID) ||
    isBannedDungeonTemplateID(record && record.templateID) ||
    isBannedDungeonTemplateID(record && record.sourceMissionID) ||
    isDisabledMissionIdentifier(record && record.missionID) ||
    BANNED_SOURCE_MISSION_IDS.has(sourceMissionID) ||
    [
      record && record.sourceUrl,
      record && record.sourceURL,
      record && record.adminMetadata && record.adminMetadata.sourceUrl,
      record && record.adminMetadata && record.adminMetadata.sourceURL,
    ].some(isDisabledMissionSourceURL);
}

function sanitizePayload(payload = {}) {
  const templatesByID = Object.fromEntries(
    Object.entries(payload.templatesByID || {}).filter(([templateID, template]) =>
      !isBannedDungeonTemplateRecord(template, templateID)),
  );
  const availableTemplateIDs = new Set(Object.keys(templatesByID));
  const indexes = {};
  for (const [indexName, rawIndex] of Object.entries(payload.indexes || {})) {
    const sanitizedIndex = {};
    for (const [key, rawTemplateIDs] of Object.entries(normalizeObject(rawIndex))) {
      if (Array.isArray(rawTemplateIDs)) {
        const templateIDs = rawTemplateIDs.filter((templateID) =>
          !isBannedDungeonTemplateID(templateID) &&
          availableTemplateIDs.has(String(templateID)));
        if (templateIDs.length > 0) {
          sanitizedIndex[key] = templateIDs;
        }
        continue;
      }
      if (
        !isBannedDungeonTemplateID(rawTemplateIDs) &&
        availableTemplateIDs.has(String(rawTemplateIDs))
      ) {
        sanitizedIndex[key] = rawTemplateIDs;
      }
    }
    if (Object.keys(sanitizedIndex).length > 0) {
      indexes[indexName] = sanitizedIndex;
    }
  }
  return {
    ...payload,
    counts: {
      ...payload.counts,
      templateCount: Object.keys(templatesByID).length,
    },
    templatesByID,
    indexes,
  };
}

function buildCache() {
  const payload = sanitizePayload(
    applyCuratedHackableContent(
      applyDungeonContentPacks(
        readCoreDungeonAuthorityPayload(),
        initializeContentPacks(),
      ),
    ),
  );
  const templatesByID = new Map();
  const securityMissionBindingsByID = new Map();
  const templatesBySourceDungeonID = new Map();
  const templatesBySource = new Map();
  const templatesByFamily = new Map();
  const templatesByDungeonNameID = new Map();
  const templatesByArchetypeID = new Map();
  const templatesByResourceTypeID = new Map();
  const templateSelectionDescriptorsByID = new Map();
  const templateSelectionDescriptorsByFamily = new Map();
  const archetypesByID = new Map();
  const clientDungeonsByID = new Map();
  const objectiveChainsByID = new Map();
  const objectiveTypesByID = new Map();
  const spawnProfilesByFamily = new Map();

  for (const [templateID, template] of Object.entries(payload.templatesByID || {})) {
    if (isBannedDungeonTemplateRecord(template, templateID)) {
      continue;
    }
    const isSecurityAlias = securityBindings.isSecurityMissionAlias(template, templateID);
    if (isSecurityAlias) {
      const receipts = payload.meta && payload.meta.installedContentPacks || [];
      if (!securityBindings.isInstalledSecurityMissionBinding(template) || !receipts.some((receipt) =>
        ["id", "version", "packSha256", "payloadSha256"].every((key) => receipt[key] === template._contentPack[key]))) continue;
      securityBindings.validateSecurityMissionBinding(template, templateID);
      const mission = template.securityMission;
      if (securityMissionBindingsByID.has(mission.missionID)) throw new Error(`CONTENT_PACK_INVALID: duplicate Security mission ${mission.missionID}`);
      securityMissionBindingsByID.set(mission.missionID, freezeDeep(clone({
        templateID, missionID: mission.missionID, dungeonID: mission.dungeonID,
        agentLevel: mission.agentLevel,
        factionID: mission.nativeMission.factionID || 0,
        corporationID: mission.nativeMission.corporationID || 0,
        agentTypeID: mission.nativeMission.agentTypeID || 0,
        nativeKillMission: mission.nativeMission.killMission,
        rewards: mission.rewards, standings: mission.standings,
        baselineEvidence: mission.validationTODOs.filter((todo) =>
          /^\/securityMission\/(rewards|standings)\/[^/]+$/.test(todo.fieldPath) &&
          todo.value === mission[todo.fieldPath.split("/")[2]]?.[todo.fieldPath.split("/")[3]])
          .map(({ fieldPath, evidenceClass }) => ({ fieldPath, evidenceClass })),
        _contentPack: template._contentPack,
      })));
    }
    const normalizedTemplate = {
      ...template,
      templateID,
      source: String(template && template.source || "").trim().toLowerCase() || "unknown",
      siteFamily: String(template && template.siteFamily || "").trim().toLowerCase() || "unknown",
      sourceDungeonID:
        template && template.sourceDungeonID != null
          ? toInt(template.sourceDungeonID, 0)
          : null,
      archetypeID:
        template && template.archetypeID != null
          ? toInt(template.archetypeID, 0)
          : null,
    };
    templatesByID.set(templateID, normalizedTemplate);
    if (isSecurityAlias) {
      // Runtime lookup only. Legacy scenes cannot enter admission/selection indexes.
      const legacy = buildLegacyTemplate(normalizedTemplate);
      if (legacy) templatesByID.set(legacy.templateID, legacy);
    }
    const selectionDescriptor = buildTemplateSelectionDescriptor(normalizedTemplate);
    templateSelectionDescriptorsByID.set(templateID, selectionDescriptor);

    if (!isSecurityAlias && normalizedTemplate.sourceDungeonID && normalizedTemplate.sourceDungeonID > 0) {
      templatesBySourceDungeonID.set(normalizedTemplate.sourceDungeonID, normalizedTemplate);
    }

    if (!templatesBySource.has(normalizedTemplate.source)) {
      templatesBySource.set(normalizedTemplate.source, []);
    }
    templatesBySource.get(normalizedTemplate.source).push(normalizedTemplate);

    if (!templatesByFamily.has(normalizedTemplate.siteFamily)) {
      templatesByFamily.set(normalizedTemplate.siteFamily, []);
    }
    templatesByFamily.get(normalizedTemplate.siteFamily).push(normalizedTemplate);

    if (!templateSelectionDescriptorsByFamily.has(normalizedTemplate.siteFamily)) {
      templateSelectionDescriptorsByFamily.set(normalizedTemplate.siteFamily, []);
    }
    templateSelectionDescriptorsByFamily.get(normalizedTemplate.siteFamily).push(selectionDescriptor);

    if (toInt(normalizedTemplate.dungeonNameID, 0) > 0) {
      const dungeonNameID = toInt(normalizedTemplate.dungeonNameID, 0);
      if (!templatesByDungeonNameID.has(dungeonNameID)) {
        templatesByDungeonNameID.set(dungeonNameID, []);
      }
      templatesByDungeonNameID.get(dungeonNameID).push(normalizedTemplate);
    }

    if (normalizedTemplate.archetypeID && normalizedTemplate.archetypeID > 0) {
      if (!templatesByArchetypeID.has(normalizedTemplate.archetypeID)) {
        templatesByArchetypeID.set(normalizedTemplate.archetypeID, []);
      }
      templatesByArchetypeID.get(normalizedTemplate.archetypeID).push(normalizedTemplate);
    }

    const resourceComposition =
      normalizedTemplate &&
      normalizedTemplate.resourceComposition &&
      typeof normalizedTemplate.resourceComposition === "object"
        ? normalizedTemplate.resourceComposition
        : {};
    const resourceTypeIDs = [
      ...(Array.isArray(resourceComposition.oreTypeIDs) ? resourceComposition.oreTypeIDs : []),
      ...(Array.isArray(resourceComposition.gasTypeIDs) ? resourceComposition.gasTypeIDs : []),
      ...(Array.isArray(resourceComposition.iceTypeIDs) ? resourceComposition.iceTypeIDs : []),
    ]
      .map((entry) => toInt(entry, 0))
      .filter((entry) => entry > 0);
    for (const resourceTypeID of [...new Set(resourceTypeIDs)]) {
      if (!templatesByResourceTypeID.has(resourceTypeID)) {
        templatesByResourceTypeID.set(resourceTypeID, []);
      }
      templatesByResourceTypeID.get(resourceTypeID).push(normalizedTemplate);
    }
  }

  const rawArchetypesByID =
    payload.clientData &&
    payload.clientData.tables &&
    payload.clientData.tables.archetypesByID
      ? payload.clientData.tables.archetypesByID
      : {};
  for (const [archetypeID, archetype] of Object.entries(rawArchetypesByID)) {
    archetypesByID.set(toInt(archetypeID, 0), archetype);
  }

  const rawDungeonsByID =
    payload.clientData &&
    payload.clientData.tables &&
    payload.clientData.tables.dungeonsByID
      ? payload.clientData.tables.dungeonsByID
      : {};
  for (const [dungeonID, dungeon] of Object.entries(rawDungeonsByID)) {
    clientDungeonsByID.set(toInt(dungeonID, 0), dungeon);
  }

  const rawObjectiveChainsByID =
    payload.clientData &&
    payload.clientData.tables &&
    payload.clientData.tables.objectiveChainsByID
      ? payload.clientData.tables.objectiveChainsByID
      : {};
  for (const [objectiveChainID, objectiveChain] of Object.entries(rawObjectiveChainsByID)) {
    objectiveChainsByID.set(toInt(objectiveChainID, 0), clone(objectiveChain));
  }

  const rawObjectiveTypesByID =
    payload.clientData &&
    payload.clientData.tables &&
    payload.clientData.tables.objectiveTypesByID
      ? payload.clientData.tables.objectiveTypesByID
      : {};
  for (const [objectiveTypeID, objectiveType] of Object.entries(rawObjectiveTypesByID)) {
    objectiveTypesByID.set(toInt(objectiveTypeID, 0), clone(objectiveType));
  }

  const rawSpawnProfiles =
    payload &&
    payload.spawnProfiles &&
    payload.spawnProfiles.families &&
    typeof payload.spawnProfiles.families === "object"
      ? payload.spawnProfiles.families
      : {};
  for (const [family, profile] of Object.entries(rawSpawnProfiles)) {
    const normalizedFamily = String(family || "").trim().toLowerCase();
    if (!normalizedFamily || !profile || typeof profile !== "object") {
      continue;
    }
    spawnProfilesByFamily.set(normalizedFamily, clone(profile));
  }

  for (const [family, descriptors] of templateSelectionDescriptorsByFamily.entries()) {
    templateSelectionDescriptorsByFamily.set(family, Object.freeze([...descriptors]));
  }

  return {
    payload,
    templatesByID,
    securityMissionBindingsByID,
    templatesBySourceDungeonID,
    templatesBySource,
    templatesByFamily,
    templatesByDungeonNameID,
    templatesByArchetypeID,
    templatesByResourceTypeID,
    templateSelectionDescriptorsByID,
    templateSelectionDescriptorsByFamily,
    archetypesByID,
    clientDungeonsByID,
    objectiveChainsByID,
    objectiveTypesByID,
    spawnProfilesByFamily,
  };
}

function ensureCache() {
  if (!cache) {
    cache = buildCache();
  }
  return cache;
}

function clearCache() {
  cache = null;
}

function getPayload() {
  return clone(ensureCache().payload);
}

// Editor browsing needs small scalar projections, not a clone of the entire
// authority (including every NPC population and graph) on each request.
function projectEditorCatalog(current) {
  const positiveID = value => Number.isSafeInteger(value) && value > 0;
  const record = value => value && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" ? value.slice(0, 256) : "";
  return {
    dungeons: [...current.clientDungeonsByID].filter(([id, row]) => positiveID(id) && record(row) &&
        !isBannedDungeonTemplateID(`client-dungeon:${id}`))
      .map(([id, row]) => ({ dungeonID: id, dungeonNameID: positiveID(row.dungeonNameID) ? row.dungeonNameID : null,
        dungeonName: text(current.templatesBySourceDungeonID.get(id)?.resolvedName),
        factionID: positiveID(row.factionID) ? row.factionID : null,
        archetypeID: positiveID(row.archetypeID) ? row.archetypeID : null })),
    archetypes: [...current.archetypesByID].filter(([id, row]) => positiveID(id) && record(row))
      .map(([id, row]) => [text(row.name) || text(row.label) || `Archetype ${id}`, id]),
  };
}

function getEditorCatalog() {
  return projectEditorCatalog(ensureCache());
}

function initializeDungeonAuthority() {
  ensureCache();
}

function getTemplateByID(templateID) {
  if (isBannedDungeonTemplateID(templateID)) {
    return null;
  }
  const template = ensureCache().templatesByID.get(String(templateID || "").trim());
  return template ? clone(template) : null;
}

// These small immutable descriptors belong to this authority generation. They
// neither clone room graphs on offers nor outlive a content-cache rebuild.
function getSecurityMissionBinding(missionID) {
  return ensureCache().securityMissionBindingsByID.get(toInt(missionID, 0)) || null;
}

function listSecurityMissionBindings() {
  return [...ensureCache().securityMissionBindingsByID.values()];
}

function getTemplateByIDReadOnly(templateID) {
  if (isBannedDungeonTemplateID(templateID)) return null;
  return readOnlyView(ensureCache().templatesByID.get(String(templateID || "").trim()));
}

// Selection descriptors are cache-owned immutable values.  Callers that need
// rooms, environment state, or population details must explicitly hydrate the
// chosen template through getTemplateByID instead.
function getTemplateSelectionDescriptorByID(templateID) {
  if (isBannedDungeonTemplateID(templateID)) {
    return null;
  }
  return ensureCache().templateSelectionDescriptorsByID.get(
    String(templateID || "").trim(),
  ) || null;
}

function getClientDungeonTemplate(sourceDungeonID) {
  const template = ensureCache().templatesBySourceDungeonID.get(toInt(sourceDungeonID, 0));
  return template ? clone(template) : null;
}

function getClientDungeonTemplateReadOnly(sourceDungeonID) {
  return readOnlyView(ensureCache().templatesBySourceDungeonID.get(toInt(sourceDungeonID, 0)));
}

function hasClientDungeonTemplate(sourceDungeonID) {
  return ensureCache().templatesBySourceDungeonID.has(toInt(sourceDungeonID, 0));
}

function listTemplatesByFamily(siteFamily) {
  const normalizedFamily = String(siteFamily || "").trim().toLowerCase();
  return clone(ensureCache().templatesByFamily.get(normalizedFamily) || []);
}

function listTemplateSelectionDescriptorsByFamily(siteFamily) {
  const normalizedFamily = String(siteFamily || "").trim().toLowerCase();
  return ensureCache().templateSelectionDescriptorsByFamily.get(normalizedFamily) ||
    EMPTY_TEMPLATE_SELECTION_DESCRIPTORS;
}

function listTemplatesBySource(source) {
  const normalizedSource = String(source || "").trim().toLowerCase();
  return clone(ensureCache().templatesBySource.get(normalizedSource) || []);
}

function listTemplatesByDungeonNameID(dungeonNameID) {
  return clone(
    ensureCache().templatesByDungeonNameID.get(toInt(dungeonNameID, 0)) || [],
  );
}

function listTemplatesByArchetypeID(archetypeID) {
  return clone(
    ensureCache().templatesByArchetypeID.get(toInt(archetypeID, 0)) || [],
  );
}

function listTemplatesByResourceTypeID(resourceTypeID) {
  return clone(
    ensureCache().templatesByResourceTypeID.get(toInt(resourceTypeID, 0)) || [],
  );
}

// Fresh arrays retain the list API's ordering and independent membership;
// records in these explicitly read-only variants must not be modified.
function listTemplatesByFamilyReadOnly(siteFamily) {
  return (ensureCache().templatesByFamily.get(String(siteFamily || "").trim().toLowerCase()) || []).map(readOnlyView);
}

function listTemplatesByDungeonNameIDReadOnly(dungeonNameID) {
  return (ensureCache().templatesByDungeonNameID.get(toInt(dungeonNameID, 0)) || []).map(readOnlyView);
}

function listTemplatesByArchetypeIDReadOnly(archetypeID) {
  return (ensureCache().templatesByArchetypeID.get(toInt(archetypeID, 0)) || []).map(readOnlyView);
}

function listTemplatesByResourceTypeIDReadOnly(resourceTypeID) {
  return (ensureCache().templatesByResourceTypeID.get(toInt(resourceTypeID, 0)) || []).map(readOnlyView);
}

function getArchetypeByID(archetypeID) {
  const archetype = ensureCache().archetypesByID.get(toInt(archetypeID, 0));
  return archetype ? clone(archetype) : null;
}

function getClientDungeonByID(dungeonID) {
  const dungeon = ensureCache().clientDungeonsByID.get(toInt(dungeonID, 0));
  return dungeon ? clone(dungeon) : null;
}

function getObjectiveChainByID(objectiveChainID) {
  const objectiveChain = ensureCache().objectiveChainsByID.get(toInt(objectiveChainID, 0));
  return objectiveChain ? clone(objectiveChain) : null;
}

function getObjectiveTypeByID(objectiveTypeID) {
  const objectiveType = ensureCache().objectiveTypesByID.get(toInt(objectiveTypeID, 0));
  return objectiveType ? clone(objectiveType) : null;
}

function getSpawnProfile(siteFamily) {
  const normalizedFamily = String(siteFamily || "").trim().toLowerCase();
  const profile = ensureCache().spawnProfilesByFamily.get(normalizedFamily) || null;
  return profile ? clone(profile) : null;
}

function getSpawnProfileReadOnly(siteFamily) {
  return readOnlyView(ensureCache().spawnProfilesByFamily.get(String(siteFamily || "").trim().toLowerCase()));
}

function listUniverseSpawnFamilies() {
  return [...ensureCache().spawnProfilesByFamily.keys()].sort((left, right) => left.localeCompare(right));
}

function getCoverage() {
  return clone(ensureCache().payload.coverage || {});
}

module.exports = {
  _testing: { projectEditorCatalog },
  getSecurityMissionBinding,
  listSecurityMissionBindings,
  clearCache,
  getCoverage,
  getArchetypeByID,
  getClientDungeonByID,
  getClientDungeonTemplate,
  getClientDungeonTemplateReadOnly,
  hasClientDungeonTemplate,
  initializeDungeonAuthority,
  getObjectiveChainByID,
  getObjectiveTypeByID,
  getPayload,
  getEditorCatalog,
  getSpawnProfile,
  getSpawnProfileReadOnly,
  getTemplateByID,
  getTemplateByIDReadOnly,
  getTemplateSelectionDescriptorByID,
  isBannedDungeonTemplateID,
  isBannedDungeonTemplateRecord,
  listUniverseSpawnFamilies,
  listTemplatesByArchetypeID,
  listTemplatesByArchetypeIDReadOnly,
  listTemplatesByDungeonNameID,
  listTemplatesByDungeonNameIDReadOnly,
  listTemplatesByFamily,
  listTemplatesByFamilyReadOnly,
  listTemplateSelectionDescriptorsByFamily,
  listTemplatesByResourceTypeID,
  listTemplatesByResourceTypeIDReadOnly,
  listTemplatesBySource,
  sanitizePayload,
  mergeClientContentPayload,
};
