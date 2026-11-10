"use strict";

const path = require("path");

const {
  DEFAULT_CHARACTER_PORTRAIT_PATH,
  findCharacterPortraitPath,
} = require("../../services/character/portraitImageStore");
const {
  DEFAULT_FACTION_LOGO_PATH,
  findFactionLogoPath,
} = require("../../services/faction/factionImageStore");
const {
  findAllianceLogoPath,
} = require("../../services/corporation/allianceImageStore");

const IMAGE_ROOT = __dirname;
const DEFAULT_CORPORATION_LOGO_PATH = path.join(
  IMAGE_ROOT,
  "images",
  "evejscorp.png",
);
const DEFAULT_ALLIANCE_LOGO_PATH = path.join(
  IMAGE_ROOT,
  "images",
  "alliance-default.png",
);
const DEFAULT_PNG_PATH = path.join(IMAGE_ROOT, "images", "hi.png");
const DEFAULT_JPG_PATH = path.join(IMAGE_ROOT, "images", "hi.jpg");

let corporationLogoProjection = null;

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toPositiveInteger(value, fallback = null) {
  const numeric = toNumber(value, fallback);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function tableRecords(payload) {
  if (!payload || typeof payload !== "object") return {};
  if (payload.records && typeof payload.records === "object") {
    return payload.records;
  }
  return payload;
}

function buildCorporationLogoProjection(factionsPayload, corporationsPayload) {
  const factionIDs = new Set();
  for (const [key, record] of Object.entries(tableRecords(factionsPayload))) {
    const factionID = toPositiveInteger(
      record && typeof record === "object"
        ? record.factionID ?? record._key ?? key
        : key,
      null,
    );
    if (factionID) factionIDs.add(factionID);
  }

  const corporationFactionIDs = {};
  for (const [key, record] of Object.entries(tableRecords(corporationsPayload))) {
    if (!record || typeof record !== "object") continue;
    const corporationID = toPositiveInteger(
      record.corporationID ?? record._key ?? key,
      null,
    );
    const factionID = toPositiveInteger(record.factionID, null);
    if (corporationID && factionID && factionIDs.has(factionID)) {
      corporationFactionIDs[String(corporationID)] = factionID;
    }
  }

  return {
    version: 1,
    factionIDs: [...factionIDs].sort((left, right) => left - right),
    corporationFactionIDs,
  };
}

function invalidCorporationLogoProjection(message) {
  const error = new TypeError(message);
  error.code = "CORPORATION_LOGO_PROJECTION_INVALID";
  return error;
}

function configureCorporationLogoProjection(projection) {
  if (
    !projection ||
    typeof projection !== "object" ||
    projection.version !== 1 ||
    !Array.isArray(projection.factionIDs) ||
    !projection.corporationFactionIDs ||
    typeof projection.corporationFactionIDs !== "object" ||
    Array.isArray(projection.corporationFactionIDs)
  ) {
    throw invalidCorporationLogoProjection(
      "corporation logo projection version or shape is invalid",
    );
  }

  const factionIDs = new Set();
  for (const value of projection.factionIDs) {
    const factionID = toPositiveInteger(value, null);
    if (!factionID) {
      throw invalidCorporationLogoProjection(
        `corporation logo projection has invalid faction ID ${value}`,
      );
    }
    factionIDs.add(factionID);
  }
  const corporationFactionIDs = new Map();
  for (const [corporationIDValue, factionIDValue] of Object.entries(
    projection.corporationFactionIDs,
  )) {
    const corporationID = toPositiveInteger(corporationIDValue, null);
    const factionID = toPositiveInteger(factionIDValue, null);
    if (!corporationID || !factionID || !factionIDs.has(factionID)) {
      throw invalidCorporationLogoProjection(
        `corporation logo projection has invalid mapping ` +
          `${corporationIDValue} -> ${factionIDValue}`,
      );
    }
    corporationFactionIDs.set(corporationID, factionID);
  }

  corporationLogoProjection = Object.freeze({
    factionIDs,
    corporationFactionIDs,
  });
  return Object.freeze({
    corporationCount: corporationFactionIDs.size,
    factionCount: factionIDs.size,
  });
}

function buildRequestUrl(requestUrl) {
  return new URL(String(requestUrl || "/"), "http://127.0.0.1");
}

function getExtensionContentType(extension) {
  const normalized = String(extension || "").trim().toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") {
    return "image/jpeg";
  }
  return "image/png";
}

function getDefaultImagePath(extension) {
  const normalized = String(extension || "").trim().toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") {
    return DEFAULT_JPG_PATH;
  }
  return DEFAULT_PNG_PATH;
}

function getContentTypeForFilePath(filePath, fallbackExtension = "") {
  const fileExtension =
    path.extname(String(filePath || "")).replace(/^\./, "") || fallbackExtension;
  return getExtensionContentType(fileExtension);
}

function resolveCharacterImagePath(characterID, size, extension) {
  const localPath = findCharacterPortraitPath(characterID, size);
  if (localPath) {
    return localPath;
  }

  return String(extension || "").toLowerCase() === "png"
    ? DEFAULT_PNG_PATH
    : DEFAULT_CHARACTER_PORTRAIT_PATH;
}

function resolveCorporationLogoPath(corporationID, size) {
  if (!corporationLogoProjection) {
    const error = new Error("corporation logo projection is not configured");
    error.code = "CORPORATION_LOGO_PROJECTION_NOT_CONFIGURED";
    throw error;
  }

  const numericCorporationID = toPositiveInteger(corporationID, null);
  const factionID = corporationLogoProjection.factionIDs.has(numericCorporationID)
    ? numericCorporationID
    : corporationLogoProjection.corporationFactionIDs.get(numericCorporationID);
  if (factionID) {
    return findFactionLogoPath(factionID, size) || DEFAULT_FACTION_LOGO_PATH;
  }
  return DEFAULT_CORPORATION_LOGO_PATH;
}

function resolveAllianceLogoPath(allianceID, size) {
  return findAllianceLogoPath(allianceID, size) || DEFAULT_ALLIANCE_LOGO_PATH;
}

function resolveFactionLogoPath(factionID, size) {
  return findFactionLogoPath(factionID, size) || DEFAULT_FACTION_LOGO_PATH;
}

function resolveLegacyImagePath(pathname) {
  const match = String(pathname || "").match(
    /^\/(Character|Corporation|Alliance|Faction)\/(\d+)(?:_(\d+))?\.(png|jpg|jpeg)$/i,
  );
  if (!match) {
    return null;
  }

  const kind = String(match[1] || "").toLowerCase();
  const entityID = toNumber(match[2], 0);
  const size = toNumber(match[3], null);
  const extension = String(match[4] || "png").toLowerCase();

  if (kind === "character") {
    const filePath = resolveCharacterImagePath(entityID, size, extension);
    return {
      filePath,
      contentType: getContentTypeForFilePath(filePath, extension),
    };
  }

  if (kind === "corporation") {
    return {
      filePath: resolveCorporationLogoPath(entityID, size),
      contentType: "image/png",
    };
  }

  if (kind === "alliance") {
    return {
      filePath: resolveAllianceLogoPath(entityID, size),
      contentType: "image/png",
    };
  }

  if (kind === "faction") {
    return {
      filePath: resolveFactionLogoPath(entityID, size),
      contentType: "image/png",
    };
  }

  return null;
}

function resolveRestImagePath(url) {
  const match = String(url.pathname || "").match(
    /^\/(characters|corporations|alliances|factions)\/(\d+)\/(portrait|logo)$/i,
  );
  if (!match) {
    return null;
  }

  const resourceKind = String(match[1] || "").toLowerCase();
  const entityID = toNumber(match[2], 0);
  const requestedAsset = String(match[3] || "").toLowerCase();
  const size = toNumber(url.searchParams.get("size"), null);
  const extension = String(url.searchParams.get("ext") || "png").toLowerCase();

  if (resourceKind === "characters" && requestedAsset === "portrait") {
    const filePath = resolveCharacterImagePath(entityID, size, extension);
    return {
      filePath,
      contentType: getContentTypeForFilePath(filePath, extension),
    };
  }

  if (requestedAsset !== "logo") {
    return null;
  }

  if (resourceKind === "corporations") {
    return {
      filePath: resolveCorporationLogoPath(entityID, size),
      contentType: "image/png",
    };
  }

  if (resourceKind === "alliances") {
    return {
      filePath: resolveAllianceLogoPath(entityID, size),
      contentType: "image/png",
    };
  }

  if (resourceKind === "factions") {
    return {
      filePath: resolveFactionLogoPath(entityID, size),
      contentType: "image/png",
    };
  }

  return null;
}

function resolveImageRequest(requestUrl) {
  const url = buildRequestUrl(requestUrl);

  const legacyResult = resolveLegacyImagePath(url.pathname);
  if (legacyResult) {
    return legacyResult;
  }

  const restResult = resolveRestImagePath(url);
  if (restResult) {
    return restResult;
  }

  const fallbackExtension = path.extname(url.pathname || "").replace(/^\./, "");
  return {
    filePath: getDefaultImagePath(fallbackExtension),
    contentType: getExtensionContentType(fallbackExtension),
  };
}

module.exports = {
  buildCorporationLogoProjection,
  configureCorporationLogoProjection,
  resolveImageRequest,
};
