"use strict";

const path = require("node:path");

const {
  peekCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCharacterBaseSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  ensureAlliancesInitialized,
  findAllianceByExactName,
  findAllianceByFoundingOperationID,
  findAllianceByShortName,
  findCorporationByName,
  findCorporationByTickerName,
  getCorporationRecord,
  isNpcCorporationID,
} = require(path.join(__dirname, "./corporationState"));
const {
  getCorporationMember,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./corporationRuntimeState"));

const ALLIANCE_CREATION_COST = 1_000_000_000;
const EMPIRE_CONTROL_TYPE_ID = 3732;
const REQUIRED_EMPIRE_CONTROL_LEVEL = 5;
const ALLIANCE_NAME_MIN_LENGTH = 4;
const ALLIANCE_NAME_MAX_LENGTH = 50;
const ALLIANCE_SHORT_NAME_MIN_LENGTH = 1;
const ALLIANCE_SHORT_NAME_MAX_LENGTH = 5;
const ALLIANCE_DESCRIPTION_MAX_LENGTH = 5000;
const ALLIANCE_URL_MAX_LENGTH = 2048;

// The client only applies length limits. Keep the server policy broad enough
// for localized owner names and established punctuation such as a trailing
// period, while still requiring a substantive letter/number. Exact punctuation
// and UserError parity remain a TQ-golden item.
const ALLIANCE_NAME_PATTERN = /^[\p{L}\p{N} .'-]+$/u;
const ALLIANCE_SHORT_NAME_PATTERN = /^[\p{L}\p{N}.-]+$/u;
const OWNER_NAME_SUBSTANTIVE_PATTERN = /[\p{L}\p{N}]/u;

function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value).normalize("NFC");
}

function normalizeAllianceFormationOptions(options = {}) {
  return {
    name: normalizeText(options.name, "").trim(),
    shortName: normalizeText(options.shortName, "").trim().toUpperCase(),
    description: normalizeText(options.description, ""),
    url: normalizeText(options.url, ""),
  };
}

function validateAllianceFormationOptions(options = {}) {
  const normalized = normalizeAllianceFormationOptions(options);
  if (!normalized.name) {
    return { success: false, errorMsg: "ALLIANCE_NAME_REQUIRED" };
  }
  if (
    [...normalized.name].length < ALLIANCE_NAME_MIN_LENGTH ||
    [...normalized.name].length > ALLIANCE_NAME_MAX_LENGTH
  ) {
    return { success: false, errorMsg: "ALLIANCE_NAME_INVALID_LENGTH" };
  }
  if (
    !ALLIANCE_NAME_PATTERN.test(normalized.name) ||
    !OWNER_NAME_SUBSTANTIVE_PATTERN.test(normalized.name)
  ) {
    return { success: false, errorMsg: "ALLIANCE_NAME_INVALID_CHARACTERS" };
  }
  if (
    [...normalized.shortName].length < ALLIANCE_SHORT_NAME_MIN_LENGTH ||
    [...normalized.shortName].length > ALLIANCE_SHORT_NAME_MAX_LENGTH
  ) {
    return { success: false, errorMsg: "ALLIANCE_SHORT_NAME_INVALID_LENGTH" };
  }
  if (
    !ALLIANCE_SHORT_NAME_PATTERN.test(normalized.shortName) ||
    !OWNER_NAME_SUBSTANTIVE_PATTERN.test(normalized.shortName)
  ) {
    return {
      success: false,
      errorMsg: "ALLIANCE_SHORT_NAME_INVALID_CHARACTERS",
    };
  }
  if ([...normalized.description].length > ALLIANCE_DESCRIPTION_MAX_LENGTH) {
    return { success: false, errorMsg: "ALLIANCE_DESCRIPTION_TOO_LONG" };
  }
  if ([...normalized.url].length > ALLIANCE_URL_MAX_LENGTH) {
    return { success: false, errorMsg: "ALLIANCE_URL_TOO_LONG" };
  }
  return { success: true, data: normalized };
}

function getEmpireControlLevel(characterID) {
  const record = getCharacterBaseSkillMap(characterID, {
    includeExpertSystems: false,
  }).get(EMPIRE_CONTROL_TYPE_ID);
  return Math.max(
    0,
    Number(
      record && (
        record.effectiveSkillLevel ??
        record.trainedSkillLevel ??
        record.skillLevel ??
        record.level
      ) || 0,
    ) || 0,
  );
}

function findAllianceMembership(corporationID) {
  const numericCorporationID = normalizePositiveInteger(corporationID, null);
  if (!numericCorporationID) {
    return null;
  }
  const table = ensureAlliancesInitialized();
  for (const record of Object.values(table.records || {})) {
    if (
      record &&
      Array.isArray(record.memberCorporationIDs) &&
      record.memberCorporationIDs.some(
        (candidate) => Number(candidate) === numericCorporationID,
      )
    ) {
      return Number(record.allianceID) || null;
    }
  }
  return null;
}

function checkAllianceFormationEligibility(options = {}) {
  const characterID = normalizePositiveInteger(options.characterID, null);
  const corporationID = normalizePositiveInteger(options.corporationID, null);
  const validatedOptions = validateAllianceFormationOptions(
    options.allianceOptions,
  );
  if (!validatedOptions.success) {
    return validatedOptions;
  }
  if (!characterID || !corporationID) {
    return { success: false, errorMsg: "ALLIANCE_FOUNDER_INVALID" };
  }

  const foundingOperationID = String(options.foundingOperationID || "").trim();
  const resumedAlliance = foundingOperationID
    ? findAllianceByFoundingOperationID(foundingOperationID)
    : null;
  if (resumedAlliance) {
    const resumedCorporationID = normalizePositiveInteger(
      resumedAlliance.creatorCorpID || resumedAlliance.executorCorporationID,
      null,
    );
    const resumedCharacterID = normalizePositiveInteger(
      resumedAlliance.creatorCharID || resumedAlliance.creatorID,
      null,
    );
    if (
      resumedCorporationID !== corporationID ||
      resumedCharacterID !== characterID
    ) {
      return { success: false, errorMsg: "ALLIANCE_FOUNDING_OPERATION_MISMATCH" };
    }
    return {
      success: true,
      resumed: true,
      data: {
        allianceOptions: validatedOptions.data,
        alliance: resumedAlliance,
        characterID,
        corporationID,
      },
    };
  }

  const corporation = getCorporationRecord(corporationID);
  const character = peekCharacterRecord(characterID);
  const member = getCorporationMember(corporationID, characterID);
  if (
    !corporation ||
    corporation.deleted ||
    corporation.isNPC !== false ||
    isNpcCorporationID(corporationID) ||
    !character ||
    character.isDeleted ||
    character.deletedAt ||
    Number(character.corporationID) !== corporationID ||
    !member ||
    member.deleted ||
    Number(member.corporationID) !== corporationID
  ) {
    return { success: false, errorMsg: "ALLIANCE_FOUNDER_INVALID" };
  }
  if (Number(corporation.ceoID) !== characterID) {
    return { success: false, errorMsg: "ALLIANCE_FOUNDER_NOT_CEO" };
  }
  if (
    normalizePositiveInteger(corporation.allianceID, null) ||
    findAllianceMembership(corporationID)
  ) {
    return { success: false, errorMsg: "CORPORATION_ALREADY_IN_ALLIANCE" };
  }
  if (getEmpireControlLevel(characterID) < REQUIRED_EMPIRE_CONTROL_LEVEL) {
    return { success: false, errorMsg: "EMPIRE_CONTROL_LEVEL_REQUIRED" };
  }
  const { name, shortName } = validatedOptions.data;
  if (findAllianceByExactName(name) || findCorporationByName(name)) {
    return { success: false, errorMsg: "ALLIANCE_NAME_TAKEN" };
  }
  if (
    findAllianceByShortName(shortName) ||
    findCorporationByTickerName(shortName)
  ) {
    return { success: false, errorMsg: "ALLIANCE_SHORT_NAME_TAKEN" };
  }

  return {
    success: true,
    data: {
      allianceOptions: validatedOptions.data,
      character,
      characterID,
      corporation,
      corporationID,
      empireControlLevel: getEmpireControlLevel(characterID),
      member,
    },
  };
}

module.exports = {
  ALLIANCE_CREATION_COST,
  ALLIANCE_DESCRIPTION_MAX_LENGTH,
  ALLIANCE_NAME_MAX_LENGTH,
  ALLIANCE_NAME_MIN_LENGTH,
  ALLIANCE_SHORT_NAME_MAX_LENGTH,
  ALLIANCE_SHORT_NAME_MIN_LENGTH,
  ALLIANCE_URL_MAX_LENGTH,
  EMPIRE_CONTROL_TYPE_ID,
  REQUIRED_EMPIRE_CONTROL_LEVEL,
  checkAllianceFormationEligibility,
  getEmpireControlLevel,
  normalizeAllianceFormationOptions,
  validateAllianceFormationOptions,
};
