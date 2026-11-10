"use strict";

// Static side of R&D: which science specialty fields each research agent offers,
// and which datacore a field yields. Both are generated from the SDE by
// tools/DatabaseCreator/build-research-field-authority.js -- see that file for
// provenance. Nothing here is authored by hand.

const path = require("path");

const {
  readStaticJsonTable,
} = require(path.join(__dirname, "../_shared/staticJsonTableReader"));

const RESEARCH_FIELD_TABLE = "researchFieldAuthority";

let cache = null;

function toPositiveInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  const normalized = Math.trunc(numericValue);
  return normalized > 0 ? normalized : fallback;
}

function buildEmptyCache(error = null) {
  return {
    loaded: true,
    error,
    researchFieldsByAgentID: new Map(),
    datacoreTypeIDBySkillTypeID: new Map(),
    fieldNamesBySkillTypeID: new Map(),
  };
}

function ensureCache() {
  if (cache) {
    return cache;
  }

  const result = readStaticJsonTable(RESEARCH_FIELD_TABLE);
  if (!result.success || !result.data || typeof result.data !== "object") {
    cache = buildEmptyCache(result.error || new Error("RESEARCH_FIELD_TABLE_MISSING"));
    return cache;
  }

  const data = result.data;
  const researchFieldsByAgentID = new Map();
  for (const [agentID, fields] of Object.entries(data.researchFieldsByAgentID || {})) {
    const normalizedAgentID = toPositiveInteger(agentID, 0);
    if (!normalizedAgentID || !Array.isArray(fields)) {
      continue;
    }
    const normalizedFields = fields
      .map((skillTypeID) => toPositiveInteger(skillTypeID, 0))
      .filter(Boolean);
    if (normalizedFields.length > 0) {
      researchFieldsByAgentID.set(normalizedAgentID, normalizedFields);
    }
  }

  const datacoreTypeIDBySkillTypeID = new Map();
  for (const [skillTypeID, datacoreTypeID] of Object.entries(
    data.datacoreTypeIDBySkillTypeID || {},
  )) {
    const normalizedSkillTypeID = toPositiveInteger(skillTypeID, 0);
    const normalizedDatacoreTypeID = toPositiveInteger(datacoreTypeID, 0);
    if (normalizedSkillTypeID && normalizedDatacoreTypeID) {
      datacoreTypeIDBySkillTypeID.set(normalizedSkillTypeID, normalizedDatacoreTypeID);
    }
  }

  const fieldNamesBySkillTypeID = new Map();
  for (const [skillTypeID, name] of Object.entries(data.fieldNamesBySkillTypeID || {})) {
    const normalizedSkillTypeID = toPositiveInteger(skillTypeID, 0);
    if (normalizedSkillTypeID && typeof name === "string" && name) {
      fieldNamesBySkillTypeID.set(normalizedSkillTypeID, name);
    }
  }

  cache = {
    loaded: true,
    error: null,
    researchFieldsByAgentID,
    datacoreTypeIDBySkillTypeID,
    fieldNamesBySkillTypeID,
  };
  return cache;
}

// The fields an agent offers in the "Select Research Type" box, in a stable order.
function listResearchFieldsForAgent(agentID) {
  const fields = ensureCache().researchFieldsByAgentID.get(
    toPositiveInteger(agentID, 0),
  );
  return fields ? [...fields] : [];
}

function isResearchFieldOfferedByAgent(agentID, skillTypeID) {
  return listResearchFieldsForAgent(agentID).includes(
    toPositiveInteger(skillTypeID, 0),
  );
}

// "These will always match the science specialty that you chose when you started
// the research." Two of the nineteen fields have no published datacore; that is
// upstream's data, so it is reported as null rather than papered over.
function getDatacoreTypeIDForField(skillTypeID) {
  return (
    ensureCache().datacoreTypeIDBySkillTypeID.get(
      toPositiveInteger(skillTypeID, 0),
    ) || null
  );
}

function getResearchFieldName(skillTypeID) {
  return ensureCache().fieldNamesBySkillTypeID.get(
    toPositiveInteger(skillTypeID, 0),
  ) || "";
}

function clearResearchAuthorityCaches() {
  cache = null;
}

module.exports = {
  RESEARCH_FIELD_TABLE,
  clearResearchAuthorityCaches,
  getDatacoreTypeIDForField,
  getResearchFieldName,
  isResearchFieldOfferedByAgent,
  listResearchFieldsForAgent,
};
