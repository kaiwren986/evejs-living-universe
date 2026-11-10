"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DEFAULT_PATH = path.resolve(__dirname, "../../../../config/pos-legacy-production.json");
const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const validID = (value) => Number.isSafeInteger(value) && value > 0;
let cached;
let lastReportedLoadError = "";

function createProductionAuthority(dataset) {
  const invalid = (detail) => { throw new Error(`STARBASE_PRODUCTION_AUTHORITY_INVALID: ${detail}`); };
  if (!dataset || dataset.schemaVersion !== 1 || !String(dataset.datasetVersion || "").trim() ||
      !["project_profile", "historical_evidence", "synthetic_test"].includes(dataset.authorityClass) ||
      dataset.tranquilityExact !== false || !Array.isArray(dataset.provenance) ||
      !Array.isArray(dataset.reactions) || !Array.isArray(dataset.moons)) invalid("unsupported schema or exactness claim");
  const sources = new Set();
  for (const source of dataset.provenance) {
    if (!source || !String(source.sourceID || "").trim() || sources.has(source.sourceID) ||
        !String(source.description || "").trim() || !/^[a-f0-9]{64}$/i.test(source.sha256 || "")) invalid("invalid provenance");
    sources.add(source.sourceID);
  }
  const type = (id) => require("../inventory/itemTypeRegistry").resolveItemByTypeID(id);
  const reactions = new Map(), moons = new Map();
  const materials = (rows) => {
    if (!Array.isArray(rows) || !rows.length || rows.length > 32) invalid("missing recipe materials");
    const seen = new Set();
    return rows.map((row) => {
      const itemType = type(row?.typeID);
      if (!validID(row?.typeID) || !itemType || ![4, 8, 17].includes(Number(itemType.categoryID)) || !positive(row.quantity) || seen.has(row.typeID)) {
        invalid("invalid or duplicate recipe material");
      }
      seen.add(row.typeID);
      return Object.freeze({ typeID: row.typeID, quantity: row.quantity });
    });
  };
  for (const row of dataset.reactions) {
    if (!validID(row?.reactionTypeID) || type(row.reactionTypeID)?.categoryID !== 24 ||
        !sources.has(row.sourceID) || reactions.has(row.reactionTypeID)) invalid("invalid reaction identity or provenance");
    reactions.set(row.reactionTypeID, Object.freeze({ reactionTypeID: row.reactionTypeID,
      sourceID: row.sourceID, inputs: Object.freeze(materials(row.inputs)), outputs: Object.freeze(materials(row.outputs)) }));
  }
  for (const row of dataset.moons) {
    if (!validID(row?.moonID) || !validID(row.solarSystemID) || !sources.has(row.sourceID) ||
        moons.has(row.moonID) || !Array.isArray(row.resources)) invalid("invalid moon identity or provenance");
    const moon = require("../../space/worldData").getCelestialByID(row.moonID);
    if (!moon || moon.groupID !== 8 || moon.solarSystemID !== row.solarSystemID) invalid("moon is not in the declared solar system");
    const seen = new Set();
    const resources = row.resources.map((resource) => {
      if (!validID(resource?.typeID) || type(resource.typeID)?.groupID !== 427 || !positive(resource.abundance) || seen.has(resource.typeID)) {
        invalid("legacy moon resources require raw moon materials and positive integer abundance, not ore fractions");
      }
      seen.add(resource.typeID);
      return Object.freeze({ typeID: resource.typeID, abundance: resource.abundance });
    });
    moons.set(row.moonID, Object.freeze({ moonID: row.moonID, solarSystemID: row.solarSystemID,
      sourceID: row.sourceID, resources: Object.freeze(resources) }));
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(dataset)).digest("hex");
  return Object.freeze({ datasetVersion: dataset.datasetVersion, authorityClass: dataset.authorityClass,
    fingerprint, reactionCount: reactions.size, moonCount: moons.size,
    getReaction: (typeID) => reactions.get(Number(typeID)) || null,
    getMoon: (moonID, systemID) => { const row = moons.get(Number(moonID)); return row?.solarSystemID === Number(systemID) ? row : null; },
  });
}

function loadProductionAuthority() {
  let source;
  try {
    source = fs.readFileSync(DEFAULT_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // An absent optional profile provides no recipes or moon resources. A
  // present but unreadable, malformed or invalid profile must still fail.
  return createProductionAuthority(source === undefined ? {
    schemaVersion: 1, datasetVersion: "unconfigured", authorityClass: "project_profile",
    tranquilityExact: false, provenance: [], reactions: [], moons: [],
  } : JSON.parse(source));
}

function getProductionAuthority() {
  if (cached) return cached;
  try {
    cached = loadProductionAuthority();
    lastReportedLoadError = "";
    return cached;
  } catch (cause) {
    // Operators get the real problem in the log, once per distinct error. A
    // plain Error reaches the client as None, so players get a readable notice.
    // Nothing is cached, so a fixed file takes effect without a restart.
    const detail = `${cause && cause.name || "Error"}: ${cause && cause.message}`;
    if (detail !== lastReportedLoadError) {
      lastReportedLoadError = detail;
      require("../../utils/logger").error(
        `[StarbaseProduction] ${DEFAULT_PATH} could not be loaded: ${detail}`,
      );
    }
    const { MachoWrappedException, buildUserErrorPayload } = require("../../common/machoErrors");
    const error = new MachoWrappedException(buildUserErrorPayload("CustomNotify", {
      notify: "Starbase production data is unavailable on this server. The server log has the details.",
    }));
    error.cause = cause;
    throw error;
  }
}

module.exports = { DEFAULT_PATH, createProductionAuthority, getProductionAuthority };
