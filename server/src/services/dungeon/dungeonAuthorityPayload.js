"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("node:path");

const {
  readStaticJsonTable,
} = require(path.join(__dirname, "../_shared/staticJsonTableReader"));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizePayload(payload = {}) {
  return {
    version: toInt(payload.version, 0),
    generatedAt: String(payload.generatedAt || "").trim(),
    source: normalizeObject(payload.source),
    counts: normalizeObject(payload.counts),
    meta: normalizeObject(payload.meta),
    sourcePriorities: normalizeObject(payload.sourcePriorities),
    sourceConfidence: normalizeObject(payload.sourceConfidence),
    spawnProfiles: normalizeObject(payload.spawnProfiles),
    coverage: normalizeObject(payload.coverage),
    clientData: normalizeObject(payload.clientData),
    templatesByID: normalizeObject(payload.templatesByID),
    indexes: normalizeObject(payload.indexes),
  };
}

function mergeClientContentValue(baseValue, overlayValue) {
  if (overlayValue === undefined) {
    return clone(baseValue);
  }
  if (Array.isArray(overlayValue)) {
    return clone(overlayValue);
  }
  if (overlayValue && typeof overlayValue === "object") {
    const baseObject = baseValue && typeof baseValue === "object" && !Array.isArray(baseValue)
      ? baseValue
      : {};
    return Object.fromEntries(
      [...new Set([...Object.keys(baseObject), ...Object.keys(overlayValue)])]
        .map((key) => [key, mergeClientContentValue(baseObject[key], overlayValue[key])]),
    );
  }
  return overlayValue;
}

function mergeClientContentPayload(authorityPayload = {}, clientContentPayload = {}) {
  const base = normalizePayload(authorityPayload);
  const schema = String(clientContentPayload && clientContentPayload.schema || "").trim();
  const clientBuild = toInt(
    clientContentPayload && clientContentPayload.source && clientContentPayload.source.clientBuild,
    0,
  );
  const overlayTemplates = normalizeObject(clientContentPayload && clientContentPayload.templatesByID);
  if (schema !== "evejs.dungeon-client-content.v1" || clientBuild <= 0) {
    return base;
  }

  const templatesByID = { ...base.templatesByID };
  const appliedTemplateIDs = [];
  const suppressedTemplateIDs = [];
  for (const [templateID, overlayTemplate] of Object.entries(overlayTemplates)) {
    if (!overlayTemplate || typeof overlayTemplate !== "object") {
      continue;
    }
    const baseTemplate = templatesByID[templateID] || {};
    const basePriority = toInt(baseTemplate && baseTemplate.sourcePriority, 0);
    const overlayPriority = toInt(overlayTemplate && overlayTemplate.sourcePriority, 0);
    if (overlayTemplate.overwriteExisting === true) {
      templatesByID[templateID] = clone(overlayTemplate);
      appliedTemplateIDs.push(templateID);
      continue;
    }
    if (
      basePriority > overlayPriority &&
      overlayTemplate.mergeExistingRegardlessOfPriority !== true
    ) {
      suppressedTemplateIDs.push(templateID);
      continue;
    }
    templatesByID[templateID] = mergeClientContentValue(baseTemplate, overlayTemplate);
    appliedTemplateIDs.push(templateID);
  }

  return {
    ...base,
    counts: {
      ...base.counts,
      templateCount: Object.keys(templatesByID).length,
      clientContentTemplateCount: appliedTemplateIDs.length,
      clientContentSuppressedTemplateCount: suppressedTemplateIDs.length,
    },
    meta: {
      ...base.meta,
      clientContent: {
        schema,
        clientBuild,
        source: clone(clientContentPayload.source || {}),
        counts: clone(clientContentPayload.counts || {}),
        appliedTemplateIDs: appliedTemplateIDs.sort(),
        suppressedTemplateIDs: suppressedTemplateIDs.sort(),
      },
    },
    templatesByID,
  };
}

function readRequiredTable(tableName, options = {}) {
  const result = readStaticJsonTable(tableName, { dataDir: options.dataDir });
  if (result.success) {
    return result.data;
  }
  const error = new Error(
    `CONTENT_PACK_DUNGEON_BASE_UNAVAILABLE: could not read ${tableName} from ` +
      `${result.filePath || "the target game store"}: ` +
      `${result.error && result.error.message || "READ_ERROR"}`,
  );
  error.code = "CONTENT_PACK_DUNGEON_BASE_UNAVAILABLE";
  error.cause = result.error;
  error.filePath = result.filePath;
  throw error;
}

function readCoreDungeonAuthorityPayload(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "dungeonBasePayload")) {
    return clone(options.dungeonBasePayload);
  }
  return mergeClientContentPayload(
    readRequiredTable("dungeonAuthority", options),
    readRequiredTable("dungeonClientContent", options),
  );
}

module.exports = {
  mergeClientContentPayload,
  normalizePayload,
  readCoreDungeonAuthorityPayload,
};
