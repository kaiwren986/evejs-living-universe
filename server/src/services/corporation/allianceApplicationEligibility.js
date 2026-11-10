"use strict";

const path = require("node:path");

const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getAllianceRecord,
  getCorporationRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  listWarsForOwner,
} = require(path.join(__dirname, "./warRuntimeState"));
const {
  normalizeBoolean,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./corporationRuntimeState"));

function normalizeFiletime(value) {
  if (value === undefined || value === null || value === "") {
    return 0n;
  }
  try {
    return BigInt(String(value));
  } catch (error) {
    return 0n;
  }
}

function isWarLive(war, nowFiletime = currentFileTime()) {
  if (!war) {
    return false;
  }
  const finishedAt = normalizeFiletime(war.timeFinished);
  return finishedAt === 0n || finishedAt > nowFiletime;
}

function checkAllianceApplicationEligibility(corporationID, allianceID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const corporation = getCorporationRecord(numericCorporationID);
  const alliance = getAllianceRecord(numericAllianceID);
  if (
    !numericCorporationID ||
    !numericAllianceID ||
    !corporation ||
    corporation.deleted ||
    corporation.isNPC !== false
  ) {
    return { success: false, errorMsg: "INVALID_APPLICANT_CORPORATION" };
  }
  if (!alliance || alliance.deleted) {
    return { success: false, errorMsg: "ALLIANCE_NOT_FOUND" };
  }
  if (alliance.closurePendingAtMs) {
    return { success: false, errorMsg: "ALLIANCE_CLOSING" };
  }
  if (normalizePositiveInteger(corporation.allianceID, null)) {
    return { success: false, errorMsg: "CORPORATION_ALREADY_IN_ALLIANCE" };
  }

  const nowFiletime = currentFileTime();
  for (const war of listWarsForOwner(numericCorporationID)) {
    if (!isWarLive(war, nowFiletime)) {
      continue;
    }
    if (Number(war.declaredByID) === numericCorporationID) {
      return { success: false, errorMsg: "AGGRESSOR_WAR" };
    }
    if (normalizeBoolean(war.mutual, false)) {
      return { success: false, errorMsg: "MUTUAL_WAR" };
    }
    if (
      Number(war.againstID) !== numericCorporationID &&
      Number(war.againstID) !== numericAllianceID
    ) {
      return { success: false, errorMsg: "FOREIGN_ALLY_WAR" };
    }
  }

  return {
    success: true,
    data: { alliance, corporation },
  };
}

module.exports = {
  checkAllianceApplicationEligibility,
  isWarLive,
};
