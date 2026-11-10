"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
// Phase 0 / 0.C: skillState owns the skills table; access via a strict repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:skills", { strict: true });
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  TABLE,
  clearReferenceCache,
  readStaticTable,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getCharacterCreationRaces,
} = require(path.join(__dirname, "../character/characterCreationData"));

const CHARACTERS_TABLE = "characters";
const SKILLS_TABLE = "skills";
const SKILL_FLAG_ID = 7;
const MAX_SKILL_LEVEL = 5;
const DEFAULT_MISSING_SKILL_LEVEL = 0;
const DEFAULT_SKILL_RANK = 1;
const SKILL_TIME_CONSTANT_ATTRIBUTE_ID = 275;
const SKILL_BOOTSTRAP_SUPPRESSED_FIELD = "suppressSkillBootstrap";

let skillReferenceCache = null;
let skillMutationVersion = 1;
let skillTypeByIDCache = null;
const {
  noteCharacterRecordInputChanged,
  noteAllCharacterRecordInputsChanged,
} = require("../character/characterRecordInputs");

function readCharacters() {
  const result = repo.read(CHARACTERS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }

  return result.data;
}

function readSkillsTable() {
  const result = repo.read(SKILLS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }

  return result.data;
}

function writeSkillsTable(skillsTable, characterID) {
  const writeResult = repo.write(SKILLS_TABLE, "/", skillsTable);
  if (writeResult && writeResult.success) {
    skillMutationVersion += 1;
    if (characterID === undefined) noteAllCharacterRecordInputsChanged();
    else noteCharacterRecordInputChanged(characterID);
  }
  return writeResult;
}

// Owner removal API: lets another domain delete a character's skills record
// without writing the skills table directly.
function removeSkillsRecord(charId) {
  const removeResult = repo.remove(SKILLS_TABLE, `/${String(charId)}`);
  if (removeResult && removeResult.success) {
    skillMutationVersion += 1;
    noteCharacterRecordInputChanged(charId);
  }
  return removeResult;
}

function writeCharacter(charId, record) {
  // Phase 0: route the characters write through its owner (characterState)
  // instead of writing the table directly. Lazy require avoids the
  // characterState->skillState cycle.
  return require("../character/characterState").writeCharacterRecord(charId, record);
}

function getSkillMutationVersion() {
  return skillMutationVersion;
}

function applyExpertSystemProjection(charId, skillRecords, options = {}) {
  if (options && options.includeExpertSystems === false) {
    return skillRecords.map((record) => cloneValue(record));
  }

  try {
    const {
      projectSkillRecordsForCharacter,
    } = require(path.join(__dirname, "./expertSystems/expertSystemProjection"));
    return projectSkillRecordsForCharacter(charId, skillRecords, {
      ...options,
      getSkillTypeByID,
      skillMutationVersion,
    });
  } catch (error) {
    log.warn(
      `[SkillState] Failed to project Expert System skill overlay for character ${toNumber(charId, 0)}: ${error.message}`,
    );
    return skillRecords.map((record) => cloneValue(record));
  }
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getSkillRank(skillType) {
  const numericRank = toFiniteNumber(skillType && skillType.skillRank, NaN);
  if (Number.isFinite(numericRank) && numericRank > 0) {
    return numericRank;
  }

  return DEFAULT_SKILL_RANK;
}

// The skill points a skill has at a level: the curve rounded up, as the game's
// own shared code has it (characterskills/util.py GetSPForLevelRaw) and as the
// skill queue has it in training/skillTrainingMath.getSkillPointsForLevel.
// That file cannot be required from here, because it requires this one through
// liveFittingState; tests/skillLevelPointsRoundedUp.test.js holds the two to
// the same figure for every rank in the skill data.
function calculateSkillPointsForLevel(skillRank, skillLevel = MAX_SKILL_LEVEL) {
  const normalizedRank = toFiniteNumber(skillRank, DEFAULT_SKILL_RANK);
  const normalizedLevel = toNumber(skillLevel, MAX_SKILL_LEVEL);
  if (normalizedLevel <= 0) {
    return 0;
  }

  return Math.ceil(
    normalizedRank * 250 * 2 ** (2.5 * (normalizedLevel - 1)),
  );
}

function getSkillMaxPoints(skillType, skillLevel = MAX_SKILL_LEVEL) {
  return calculateSkillPointsForLevel(getSkillRank(skillType), skillLevel);
}

// The least points a stored record may hold at a level. Until 2026-10-09 a
// level given outright was stored with its points rounded to the nearest,
// which for some ranks at levels 2 and 4 is a point short of the level (1414
// where a rank 1 skill's level 2 takes 1415). A character stored that way is
// not rewritten when it is read: a record holding exactly that figure keeps
// it. Anything else is held to the level's points.
function getStoredLevelPointsFloor(skillType, skillLevel, storedPoints) {
  const levelPoints = getSkillMaxPoints(skillType, skillLevel);
  if (skillLevel <= 0) {
    return levelPoints;
  }

  const roundedToNearest = Math.round(
    250 * getSkillRank(skillType) * Math.pow(Math.sqrt(32), skillLevel - 1),
  );
  return roundedToNearest < levelPoints &&
    toFiniteNumber(storedPoints, NaN) === roundedToNearest
    ? roundedToNearest
    : levelPoints;
}

function clampSkillLevel(value, fallback = DEFAULT_MISSING_SKILL_LEVEL) {
  return Math.max(0, Math.min(MAX_SKILL_LEVEL, toNumber(value, fallback)));
}

function normalizeSkillPoints(value, minimum, maximum, fallback) {
  const numeric = toFiniteNumber(value, NaN);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.round(Math.max(minimum, Math.min(maximum, numeric)));
}

function loadSkillReference() {
  if (skillReferenceCache) {
    return skillReferenceCache;
  }

  try {
    const skillTypes = readStaticRows(TABLE.SKILL_TYPES);
    const typeDogma = readStaticTable(TABLE.TYPE_DOGMA);
    const dogmaByTypeID =
      (typeDogma && typeof typeDogma === "object" && typeDogma.typesByTypeID) || {};

    skillReferenceCache = skillTypes.map((skillType) => {
      const typeID = toNumber(skillType && skillType.typeID, 0);
      const dogmaRecord = dogmaByTypeID[String(typeID)];
      const dogmaAttributes =
        dogmaRecord && typeof dogmaRecord === "object" && dogmaRecord.attributes
          ? dogmaRecord.attributes
          : {};
      const dogmaSkillRank = toFiniteNumber(
        dogmaAttributes[String(SKILL_TIME_CONSTANT_ATTRIBUTE_ID)],
        NaN,
      );
      const skillRank =
        Number.isFinite(dogmaSkillRank) && dogmaSkillRank > 0
          ? dogmaSkillRank
          : getSkillRank(skillType);

      return {
        ...skillType,
        skillRank,
        maxSkillPoints: calculateSkillPointsForLevel(skillRank, MAX_SKILL_LEVEL),
      };
    });
  } catch (error) {
    log.warn(`[SkillState] Failed to load skill reference data: ${error.message}`);
    skillReferenceCache = [];
  }

  return skillReferenceCache;
}

function refreshSkillReference() {
  noteAllCharacterRecordInputsChanged();
  skillReferenceCache = null;
  skillTypeByIDCache = null;
  clearReferenceCache([TABLE.SKILL_TYPES, TABLE.TYPE_DOGMA]);
  return loadSkillReference();
}

function getSkillTypes(options = {}) {
  if (options && options.refresh) {
    return refreshSkillReference();
  }

  return loadSkillReference();
}

function getSkillTypeByID(typeID, options = {}) {
  const numericTypeID = toNumber(typeID, 0);
  if (numericTypeID <= 0) {
    return null;
  }

  if (!skillTypeByIDCache || options.refresh) {
    const nextCache = new Map();
    for (const skillType of getSkillTypes(options)) {
      const resolvedTypeID = toNumber(skillType && skillType.typeID, 0);
      if (resolvedTypeID > 0) {
        nextCache.set(resolvedTypeID, cloneValue(skillType));
      }
    }
    skillTypeByIDCache = nextCache;
  }

  return cloneValue(skillTypeByIDCache.get(numericTypeID) || null);
}

function getPublishedSkillTypes(options = {}) {
  return getSkillTypes(options)
    .filter((skillType) => skillType && skillType.published !== false)
    .map((skillType) => cloneValue(skillType));
}

function getUnpublishedSkillTypes(options = {}) {
  return getSkillTypes(options)
    .filter((skillType) => skillType && skillType.published === false)
    .map((skillType) => cloneValue(skillType));
}

function buildSkillItemId(charId, typeId) {
  return toNumber(charId, 0) * 100000 + toNumber(typeId, 0);
}

function buildSkillRecord(
  charId,
  skillType,
  skillLevel = DEFAULT_MISSING_SKILL_LEVEL,
) {
  const numericCharId = toNumber(charId, 0);
  const skillRank = getSkillRank(skillType);
  const resolvedSkillLevel = clampSkillLevel(skillLevel, DEFAULT_MISSING_SKILL_LEVEL);
  const skillPoints = getSkillMaxPoints(skillType, resolvedSkillLevel);
  return {
    itemID: buildSkillItemId(numericCharId, skillType.typeID),
    typeID: skillType.typeID,
    ownerID: numericCharId,
    locationID: numericCharId,
    flagID: SKILL_FLAG_ID,
    categoryID: skillType.categoryID || 16,
    groupID: skillType.groupID || 0,
    groupName: skillType.groupName || "",
    itemName: skillType.name,
    published: Boolean(skillType.published),
    skillLevel: resolvedSkillLevel,
    trainedSkillLevel: resolvedSkillLevel,
    effectiveSkillLevel: resolvedSkillLevel,
    virtualSkillLevel: null,
    skillRank,
    skillPoints,
    trainedSkillPoints: skillPoints,
    inTraining: false,
    trainingStartSP: skillPoints,
    trainingDestinationSP: skillPoints,
    trainingStartTime: null,
    trainingEndTime: null,
  };
}

function normalizeSkillRecord(
  charId,
  existingRecord,
  skillType,
  options = {},
) {
  const defaultSkillLevel = clampSkillLevel(
    options.defaultSkillLevel,
    DEFAULT_MISSING_SKILL_LEVEL,
  );
  const baseRecord = buildSkillRecord(charId, skillType, defaultSkillLevel);
  const skillRank = getSkillRank(skillType);
  const hasExistingRecord = existingRecord && typeof existingRecord === "object";
  const inTraining = Boolean(hasExistingRecord && existingRecord.inTraining);
  const skillLevel = clampSkillLevel(
    hasExistingRecord ? existingRecord.skillLevel : undefined,
    defaultSkillLevel,
  );
  const trainedSkillLevel = inTraining
    ? clampSkillLevel(
        hasExistingRecord ? existingRecord.trainedSkillLevel : undefined,
        skillLevel,
      )
    : skillLevel;
  const effectiveSkillLevel = inTraining
    ? clampSkillLevel(
        hasExistingRecord ? existingRecord.effectiveSkillLevel : undefined,
        skillLevel,
      )
    : skillLevel;
  const maxSkillPoints = getSkillMaxPoints(skillType, MAX_SKILL_LEVEL);
  const skillPointsAtLevel = getStoredLevelPointsFloor(
    skillType,
    skillLevel,
    hasExistingRecord
      ? existingRecord.skillPoints ?? existingRecord.trainedSkillPoints
      : undefined,
  );
  const trainedSkillPoints = getStoredLevelPointsFloor(
    skillType,
    trainedSkillLevel,
    hasExistingRecord
      ? existingRecord.trainedSkillPoints ?? existingRecord.skillPoints
      : undefined,
  );
  const nextSkillLevelPoints =
    skillLevel >= MAX_SKILL_LEVEL
      ? maxSkillPoints
      : getSkillMaxPoints(skillType, skillLevel + 1) - 1;
  const nextTrainedSkillLevelPoints =
    trainedSkillLevel >= MAX_SKILL_LEVEL
      ? maxSkillPoints
      : getSkillMaxPoints(skillType, trainedSkillLevel + 1) - 1;
  const resolvedSkillPoints = inTraining
    ? normalizeSkillPoints(
        hasExistingRecord ? existingRecord.skillPoints : undefined,
        trainedSkillPoints,
        maxSkillPoints,
        skillPointsAtLevel,
      )
    : normalizeSkillPoints(
        hasExistingRecord
          ? existingRecord.skillPoints ?? existingRecord.trainedSkillPoints
          : undefined,
        skillPointsAtLevel,
        nextSkillLevelPoints,
        skillPointsAtLevel,
      );
  const resolvedTrainedSkillPoints = inTraining
    ? normalizeSkillPoints(
        hasExistingRecord ? existingRecord.trainedSkillPoints : undefined,
        trainedSkillPoints,
        resolvedSkillPoints,
        trainedSkillPoints,
      )
    : normalizeSkillPoints(
        hasExistingRecord
          ? existingRecord.trainedSkillPoints ?? existingRecord.skillPoints
          : undefined,
        trainedSkillPoints,
        Math.min(nextTrainedSkillLevelPoints, resolvedSkillPoints),
        skillPointsAtLevel,
      );
  const resolvedTrainingStartSP = inTraining
    ? normalizeSkillPoints(
        hasExistingRecord ? existingRecord.trainingStartSP : undefined,
        resolvedTrainedSkillPoints,
        maxSkillPoints,
        resolvedTrainedSkillPoints,
      )
    : resolvedTrainedSkillPoints;
  const resolvedTrainingDestinationSP = inTraining
    ? normalizeSkillPoints(
        hasExistingRecord ? existingRecord.trainingDestinationSP : undefined,
        Math.max(resolvedSkillPoints, resolvedTrainingStartSP),
        maxSkillPoints,
        skillPointsAtLevel,
      )
    : resolvedSkillPoints;
  return {
    ...baseRecord,
    ...(hasExistingRecord ? existingRecord : {}),
    itemID: buildSkillItemId(charId, skillType.typeID),
    typeID: skillType.typeID,
    ownerID: toNumber(charId, 0),
    locationID: toNumber(charId, 0),
    flagID: SKILL_FLAG_ID,
    categoryID: skillType.categoryID || 16,
    groupID: skillType.groupID || 0,
    groupName: skillType.groupName || "",
    itemName: skillType.name,
    published: Boolean(skillType.published),
    skillLevel,
    trainedSkillLevel,
    effectiveSkillLevel,
    virtualSkillLevel:
      hasExistingRecord && Object.prototype.hasOwnProperty.call(existingRecord, "virtualSkillLevel")
        ? existingRecord.virtualSkillLevel
        : null,
    skillRank,
    skillPoints: resolvedSkillPoints,
    trainedSkillPoints: resolvedTrainedSkillPoints,
    inTraining,
    trainingStartSP: resolvedTrainingStartSP,
    trainingDestinationSP: resolvedTrainingDestinationSP,
    trainingStartTime: inTraining ? existingRecord.trainingStartTime ?? null : null,
    trainingEndTime: inTraining ? existingRecord.trainingEndTime ?? null : null,
  };
}

function syncCharacterSkillPoints(charId, totalSkillPoints) {
  const characters = readCharacters();
  const record = characters[String(charId)];
  if (!record) {
    return;
  }

  if (toNumber(record.skillPoints, 0) === totalSkillPoints) {
    return;
  }

  writeCharacter(charId, {
    ...record,
    skillPoints: totalSkillPoints,
  });
}

function setCharacterSkillBootstrapSuppressed(charId, suppressed = true) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return {
      success: false,
      errorMsg: "INVALID_CHARACTER",
    };
  }

  const characters = readCharacters();
  const record = characters[String(numericCharId)];
  if (!record || typeof record !== "object") {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const normalizedSuppressed = Boolean(suppressed);
  const existingSuppressed = Boolean(record[SKILL_BOOTSTRAP_SUPPRESSED_FIELD]);
  if (existingSuppressed === normalizedSuppressed) {
    return {
      success: true,
      data: cloneValue(record),
    };
  }

  const nextRecord = {
    ...record,
  };
  if (normalizedSuppressed) {
    nextRecord[SKILL_BOOTSTRAP_SUPPRESSED_FIELD] = true;
  } else {
    delete nextRecord[SKILL_BOOTSTRAP_SUPPRESSED_FIELD];
  }

  const writeResult = writeCharacter(numericCharId, nextRecord);
  if (!writeResult || !writeResult.success) {
    log.warn(
      `[SkillState] Failed to persist bootstrap suppression for character ${numericCharId}`,
    );
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg ? writeResult.errorMsg : "WRITE_ERROR",
    };
  }

  return {
    success: true,
    data: cloneValue(nextRecord),
  };
}

function normalizeGrantedSkillLevelEntries(skillLevels = []) {
  const grantedSkillLevelByTypeID = new Map();
  const entries =
    skillLevels instanceof Map
      ? [...skillLevels.entries()].map(([typeID, level]) => ({ typeID, level }))
      : Array.isArray(skillLevels)
        ? skillLevels
        : Object.entries(skillLevels || {}).map(([typeID, level]) => ({
            typeID,
            level,
          }));

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const typeID = toNumber(entry.typeID, 0);
    if (typeID <= 0) {
      continue;
    }

    grantedSkillLevelByTypeID.set(
      typeID,
      clampSkillLevel(entry.level, DEFAULT_MISSING_SKILL_LEVEL),
    );
  }

  return grantedSkillLevelByTypeID;
}

function bootstrapCharacterSkillsIfMissing(charId) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return [];
  }

  const characters = readCharacters();
  const characterRecord = characters[String(numericCharId)];
  if (!characterRecord || typeof characterRecord !== "object") {
    return [];
  }

  const bootstrapSuppressed = Boolean(
    characterRecord[SKILL_BOOTSTRAP_SUPPRESSED_FIELD],
  );
  const existingSkills = readSkillsTable()[String(numericCharId)];
  if (existingSkills && typeof existingSkills === "object") {
    const normalizedExistingSkills = Object.values(existingSkills).map((record) =>
      cloneValue(record),
    );
    if (Object.keys(existingSkills).length > 0 || bootstrapSuppressed) {
      return normalizedExistingSkills;
    }
  }

  if (bootstrapSuppressed) {
    return [];
  }

  if (config.devBootstrapPublishedSkills) {
    return seedCharacterPublishedSkills(numericCharId, MAX_SKILL_LEVEL);
  }

  return seedCharacterStarterSkills(numericCharId, characterRecord.raceID);
}

function ensureCharacterSkills(charId, options = {}) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return [];
  }

  if (!options.skipBootstrap) {
    bootstrapCharacterSkillsIfMissing(numericCharId);
  }

  const skillTypes = getSkillTypes();
  if (skillTypes.length === 0) {
    return [];
  }

  const defaultSkillLevel = clampSkillLevel(
    options.defaultSkillLevel,
    DEFAULT_MISSING_SKILL_LEVEL,
  );
  const populateMissingSkills = Boolean(options.populateMissingSkills);
  const grantedSkillTypeIDs =
    options.grantedSkillTypeIDs instanceof Set ? options.grantedSkillTypeIDs : null;
  const grantedSkillLevel =
    grantedSkillTypeIDs && options.grantedSkillLevel !== undefined
      ? clampSkillLevel(options.grantedSkillLevel, MAX_SKILL_LEVEL)
      : null;
  const grantedSkillLevelByTypeID = normalizeGrantedSkillLevelEntries(
    options.grantedSkillLevelByTypeID,
  );
  const skillsTable = readSkillsTable();
  const characterKey = String(numericCharId);
  const existingSkills = skillsTable[characterKey] || {};
  const nextSkills = {};
  let dirty = !skillsTable[characterKey];

  for (const skillType of skillTypes) {
    const typeKey = String(skillType.typeID);
    const existingSkillRecord = existingSkills[typeKey];
    const grantedSkillLevelForType = grantedSkillLevelByTypeID.get(
      toNumber(skillType.typeID, 0),
    );
    const hasCustomGrantedSkillLevel = grantedSkillLevelByTypeID.has(
      toNumber(skillType.typeID, 0),
    );
    const isGrantedSkill =
      grantedSkillTypeIDs && grantedSkillTypeIDs.has(toNumber(skillType.typeID, 0));
    let normalizedRecord = null;

    if (hasCustomGrantedSkillLevel) {
      normalizedRecord = buildSkillRecord(
        numericCharId,
        skillType,
        grantedSkillLevelForType,
      );
    } else if (isGrantedSkill) {
      normalizedRecord = buildSkillRecord(numericCharId, skillType, grantedSkillLevel);
    } else if (existingSkillRecord && typeof existingSkillRecord === "object") {
      normalizedRecord = normalizeSkillRecord(numericCharId, existingSkillRecord, skillType, {
        defaultSkillLevel,
      });
    } else if (populateMissingSkills) {
      normalizedRecord = buildSkillRecord(numericCharId, skillType, defaultSkillLevel);
    }

    if (!normalizedRecord) {
      continue;
    }

    nextSkills[typeKey] = normalizedRecord;

    if (
      !existingSkillRecord ||
      JSON.stringify(existingSkillRecord) !== JSON.stringify(normalizedRecord)
    ) {
      dirty = true;
    }
  }

  if (dirty) {
    skillsTable[characterKey] = nextSkills;
    const writeResult = writeSkillsTable(skillsTable, numericCharId);
    if (!writeResult || !writeResult.success) {
      log.warn(`[SkillState] Failed to persist skills for character ${numericCharId}`);
    }
  }

  const skills = Object.values(nextSkills).map((record) => cloneValue(record));
  const totalSkillPoints = skills.reduce(
    (sum, skill) => sum + toNumber(skill.skillPoints, 0),
    0,
  );
  syncCharacterSkillPoints(numericCharId, totalSkillPoints);
  return skills;
}

function grantCharacterSkillTypes(
  charId,
  skillTypeIDs = [],
  skillLevel = MAX_SKILL_LEVEL,
) {
  const grantedSkillTypeIDs = new Set(
    (Array.isArray(skillTypeIDs) ? skillTypeIDs : [...skillTypeIDs])
      .map((typeID) => toNumber(typeID, 0))
      .filter((typeID) => typeID > 0),
  );
  if (grantedSkillTypeIDs.size === 0) {
    return [];
  }

  const grantedSkills = ensureCharacterSkills(charId, {
    grantedSkillTypeIDs,
    grantedSkillLevel: skillLevel,
    skipBootstrap: true,
  });

  const changedSkills = grantedSkills
    .filter((record) => grantedSkillTypeIDs.has(toNumber(record.typeID, 0)))
    .map((record) => cloneValue(record));
  if (changedSkills.length > 0) {
    setCharacterSkillBootstrapSuppressed(charId, false);
  }
  return changedSkills;
}

function grantCharacterSkillLevels(charId, skillLevels = []) {
  const grantedSkillLevelByTypeID = normalizeGrantedSkillLevelEntries(skillLevels);
  if (grantedSkillLevelByTypeID.size === 0) {
    return [];
  }

  const grantedSkills = ensureCharacterSkills(charId, {
    grantedSkillLevelByTypeID,
    skipBootstrap: true,
  });

  const changedSkills = grantedSkills
    .filter((record) => grantedSkillLevelByTypeID.has(toNumber(record.typeID, 0)))
    .map((record) => cloneValue(record));
  if (changedSkills.length > 0) {
    setCharacterSkillBootstrapSuppressed(charId, false);
  }
  return changedSkills;
}

function removeCharacterSkillTypes(charId, skillTypeIDs = []) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return [];
  }

  const targetTypeIDs = new Set(
    (Array.isArray(skillTypeIDs) ? skillTypeIDs : [...skillTypeIDs])
      .map((typeID) => toNumber(typeID, 0))
      .filter((typeID) => typeID > 0),
  );
  if (targetTypeIDs.size === 0) {
    return [];
  }

  const characterKey = String(numericCharId);
  const currentSkillMap = getCharacterSkillMap(numericCharId, {
    includeExpertSystems: false,
  });
  const skillsTable = readSkillsTable();
  const existingSkills =
    skillsTable[characterKey] && typeof skillsTable[characterKey] === "object"
      ? { ...skillsTable[characterKey] }
      : {};
  const removedSkills = [];
  let dirty = !skillsTable[characterKey];

  for (const typeID of targetTypeIDs) {
    const typeKey = String(typeID);
    const existingRecord = currentSkillMap.get(typeID);
    if (existingRecord) {
      removedSkills.push(cloneValue(existingRecord));
    }

    if (Object.prototype.hasOwnProperty.call(existingSkills, typeKey)) {
      delete existingSkills[typeKey];
      dirty = true;
    }
  }

  if (dirty) {
    skillsTable[characterKey] = existingSkills;
    const writeResult = writeSkillsTable(skillsTable, numericCharId);
    if (!writeResult || !writeResult.success) {
      log.warn(
        `[SkillState] Failed to persist removed skills for character ${numericCharId}`,
      );
      return [];
    }
  }

  const remainingSkills = Object.values(existingSkills).map((record) => cloneValue(record));
  const remainingSkillPoints = remainingSkills.reduce(
    (sum, skill) => sum + toNumber(skill && skill.skillPoints, 0),
    0,
  );
  syncCharacterSkillPoints(numericCharId, remainingSkillPoints);
  setCharacterSkillBootstrapSuppressed(numericCharId, remainingSkills.length === 0);
  return removedSkills;
}

function clearCharacterSkills(charId) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return [];
  }

  const currentSkillMap = getCharacterSkillMap(numericCharId, {
    includeExpertSystems: false,
  });
  if (currentSkillMap.size === 0) {
    const skillsTable = readSkillsTable();
    const characterKey = String(numericCharId);
    if (!skillsTable[characterKey]) {
      skillsTable[characterKey] = {};
      const writeResult = writeSkillsTable(skillsTable, numericCharId);
      if (!writeResult || !writeResult.success) {
        log.warn(
          `[SkillState] Failed to persist empty skill state for character ${numericCharId}`,
        );
      }
    }
    syncCharacterSkillPoints(numericCharId, 0);
    setCharacterSkillBootstrapSuppressed(numericCharId, true);
    return [];
  }

  return removeCharacterSkillTypes(numericCharId, currentSkillMap.keys());
}

function seedCharacterAllSkills(
  charId,
  skillLevel = MAX_SKILL_LEVEL,
) {
  const seededSkills = ensureCharacterSkills(charId, {
    defaultSkillLevel: skillLevel,
    populateMissingSkills: true,
    skipBootstrap: true,
  }).map((record) => cloneValue(record));
  if (seededSkills.length > 0) {
    setCharacterSkillBootstrapSuppressed(charId, false);
  }
  return seededSkills;
}

function ensureAllCharacterSkills() {
  const characters = readCharacters();
  const results = {};
  for (const charId of Object.keys(characters)) {
    results[charId] = ensureCharacterSkills(charId).length;
  }
  return results;
}

function getCharacterBaseSkills(charId, options = {}) {
  return ensureCharacterSkills(charId, options)
    .sort((left, right) => left.typeID - right.typeID)
    .map((record) => cloneValue(record));
}

function getCharacterSkills(charId, options = {}) {
  const baseSkills = getCharacterBaseSkills(charId, options);
  return applyExpertSystemProjection(charId, baseSkills, options)
    .sort((left, right) => left.typeID - right.typeID)
    .map((record) => cloneValue(record));
}

function getCharacterBaseSkillMap(charId, options = {}) {
  const entries = getCharacterBaseSkills(charId, options).map((record) => [
    record.typeID,
    cloneValue(record),
  ]);
  return new Map(entries);
}

function getCharacterSkillMap(charId, options = {}) {
  const entries = getCharacterSkills(charId, options).map((record) => [
    record.typeID,
    cloneValue(record),
  ]);
  return new Map(entries);
}

// Per-character cache of the DEFAULT-options skill map — the read-only view used
// by all per-tick dogma resolution (drone / ship-resource / targeting / weapon /
// fighter / module / NPC). getCharacterSkillMap deep-clones every skill record
// (~511 for a maxed pilot, ~6ms) on every call, and that cost was being paid once
// per character per tick on several hot paths. Skills change only on
// train/grant/remove and expert-system activation/expiry, both tracked by
// mutation-version counters, so rebuild only when one bumps and otherwise return
// the SHARED map.
//
// CONTRACT: the returned map is SHARED and MUST be treated read-only — do not
// .set/.delete it or mutate its records. Callers that need a private, mutable copy
// (skill management, "previous skill map" snapshots, cold paths) keep using
// getCharacterSkillMap. Only the default-options call is cached; any options
// change the result and must go through getCharacterSkillMap.
const cachedSkillMaps = new Map(); // charId -> { versionKey, skillMap }

function cachedSkillMapVersionKey() {
  // Lazy require: skillState is widely depended-upon, so importing expertSystemState
  // at module load risks a cycle. require() is cached → this is a Map lookup.
  const {
    getExpertSystemMutationVersion,
  } = require(path.join(__dirname, "./expertSystems/expertSystemState"));
  return `${skillMutationVersion}:${getExpertSystemMutationVersion()}`;
}

function getCachedCharacterSkillMap(charId) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return getCharacterSkillMap(numericCharId);
  }
  const versionKey = cachedSkillMapVersionKey();
  const cacheKey = String(numericCharId);
  let entry = cachedSkillMaps.get(cacheKey);
  if (!entry || entry.versionKey !== versionKey) {
    entry = { versionKey, skillMap: getCharacterSkillMap(numericCharId) };
    cachedSkillMaps.set(cacheKey, entry);
  }
  return entry.skillMap;
}

function isCharacterSkillMapCached(charId) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return false;
  }
  const entry = cachedSkillMaps.get(String(numericCharId));
  return Boolean(entry && entry.versionKey === cachedSkillMapVersionKey());
}

// Drop a character's cached skill map (logout / character switch). Optional: the
// version key already prevents serving stale data, so this only frees memory.
function evictCachedCharacterSkillMap(charId) {
  cachedSkillMaps.delete(String(toNumber(charId, 0)));
}

function clearCachedCharacterSkillMaps() {
  cachedSkillMaps.clear();
}

function getCharacterSkillPointTotal(charId) {
  const skills = getCharacterBaseSkills(charId, {
    includeExpertSystems: false,
  });
  if (skills.length === 0) {
    return null;
  }

  return skills.reduce((sum, skill) => sum + toNumber(skill.skillPoints, 0), 0);
}

function needsSkillLevelGrant(record, targetSkillLevel = MAX_SKILL_LEVEL) {
  if (!record || typeof record !== "object") {
    return true;
  }

  const currentSkillLevel = clampSkillLevel(
    record.skillLevel,
    DEFAULT_MISSING_SKILL_LEVEL,
  );
  const currentTrainedSkillLevel = clampSkillLevel(
    record.trainedSkillLevel,
    currentSkillLevel,
  );
  const currentEffectiveSkillLevel = clampSkillLevel(
    record.effectiveSkillLevel,
    currentSkillLevel,
  );

  return (
    currentSkillLevel < targetSkillLevel ||
    currentTrainedSkillLevel < targetSkillLevel ||
    currentEffectiveSkillLevel < targetSkillLevel
  );
}

function ensureCharacterSkillTypes(charId, skillTypes = [], options = {}) {
  const targetSkillLevel = clampSkillLevel(
    options.skillLevel,
    MAX_SKILL_LEVEL,
  );
  const existingSkillMap = getCharacterSkillMap(charId, {
    includeExpertSystems: false,
  });
  const targetSkillTypeIDs = skillTypes
    .map((skillType) => cloneValue(skillType))
    .filter((skillType) => skillType && toNumber(skillType.typeID, 0) > 0)
    .filter((skillType) =>
      needsSkillLevelGrant(
        existingSkillMap.get(toNumber(skillType.typeID, 0)),
        targetSkillLevel,
      ),
    )
    .map((skillType) => toNumber(skillType.typeID, 0));

  if (targetSkillTypeIDs.length === 0) {
    return [];
  }

  return grantCharacterSkillTypes(charId, targetSkillTypeIDs, targetSkillLevel);
}

function ensureCharacterPublishedSkills(charId, options = {}) {
  const publishedSkillTypes = getPublishedSkillTypes(options);
  if (publishedSkillTypes.length === 0) {
    return [];
  }

  return ensureCharacterSkillTypes(charId, publishedSkillTypes, options);
}

function ensureCharacterUnpublishedSkills(charId, options = {}) {
  const unpublishedSkillTypes = getUnpublishedSkillTypes(options);
  if (unpublishedSkillTypes.length === 0) {
    return [];
  }

  return ensureCharacterSkillTypes(charId, unpublishedSkillTypes, options);
}

function seedCharacterPublishedSkills(
  charId,
  skillLevel = MAX_SKILL_LEVEL,
) {
  return grantCharacterSkillTypes(
    charId,
    getPublishedSkillTypes().map((skillType) => toNumber(skillType.typeID, 0)),
    skillLevel,
  );
}

function seedCharacterStarterSkills(charId, raceId) {
  const numericRaceId = toNumber(raceId, 0);
  if (numericRaceId <= 0) {
    return [];
  }

  const raceProfiles = getCharacterCreationRaces();
  if (raceProfiles.length === 0) {
    return [];
  }

  const raceProfile = raceProfiles.find(
    (profile) => profile && profile.raceID === numericRaceId,
  );
  if (!raceProfile || !Array.isArray(raceProfile.skills) || raceProfile.skills.length === 0) {
    log.warn(
      `[SkillState] No starter skill profile found for race=${numericRaceId} char=${toNumber(charId, 0)}`,
    );
    return [];
  }

  return grantCharacterSkillLevels(charId, raceProfile.skills);
}

function replaceCharacterSkillRecords(charId, skillRecords = []) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return {
      success: false,
      errorMsg: "INVALID_CHARACTER",
    };
  }

  const nextSkills = {};
  for (const rawRecord of Array.isArray(skillRecords) ? skillRecords : []) {
    if (!rawRecord || typeof rawRecord !== "object") {
      continue;
    }

    const typeID = toNumber(rawRecord.typeID, 0);
    if (typeID <= 0) {
      continue;
    }

    const skillType = getSkillTypeByID(typeID);
    if (!skillType) {
      continue;
    }

    nextSkills[String(typeID)] = normalizeSkillRecord(
      numericCharId,
      rawRecord,
      skillType,
      {
        defaultSkillLevel: rawRecord.skillLevel,
      },
    );
  }

  const skillsTable = readSkillsTable();
  skillsTable[String(numericCharId)] = nextSkills;
  const writeResult = writeSkillsTable(skillsTable, numericCharId);
  if (!writeResult || !writeResult.success) {
    log.warn(
      `[SkillState] Failed to replace skill records for character ${numericCharId}`,
    );
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg ? writeResult.errorMsg : "WRITE_ERROR",
    };
  }

  const totalSkillPoints = Object.values(nextSkills).reduce(
    (sum, skillRecord) => sum + toNumber(skillRecord && skillRecord.skillPoints, 0),
    0,
  );
  syncCharacterSkillPoints(numericCharId, totalSkillPoints);
  return {
    success: true,
    data: Object.values(nextSkills).map((record) => cloneValue(record)),
  };
}

// Commit skill levels and the permanent reward receipt in one skills-owner write.
function grantCharacterSkillLevelsOnce(charId, skillLevels, actionKey) {
  const numericCharId = toNumber(charId, 0);
  if (!readCharacters()[String(numericCharId)] || !Array.isArray(skillLevels) ||
      !skillLevels.length || skillLevels.length > 64 ||
      skillLevels.some(entry => !entry || !Number.isSafeInteger(entry.typeID) || entry.typeID <= 0 || !Number.isInteger(entry.level) || entry.level < 0 || entry.level > 5) ||
      typeof actionKey !== "string" || !/^nodegraph:[a-f0-9]{64}$/.test(actionKey)) {
    return { success: false, errorMsg: "INVALID_SKILL_LEVEL_GRANT" };
  }
  const levels = normalizeGrantedSkillLevelEntries(skillLevels);
  const fingerprint = JSON.stringify([...levels].sort(([a], [b]) => a - b));
  const characterKey = String(numericCharId);
  const receipt = readSkillsTable()._nodeGraphGrantReceipts?.[characterKey]?.[actionKey];
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
    ensureCharacterSkills(numericCharId);
    const flushed = repo.flushTableSync(SKILLS_TABLE);
    return flushed?.success ? { success: true, duplicate: true } : flushed;
  }
  if (Object.keys(readSkillsTable()._nodeGraphGrantReceipts?.[characterKey] || {}).length >= 8192) return { success: false, errorMsg: "SKILL_LEVEL_RECEIPT_LIMIT" };
  const types = [...levels.keys()].map(typeID => getSkillTypeByID(typeID));
  if (types.some(type => !type)) return { success: false, errorMsg: "SKILL_TYPE_NOT_FOUND" };
  ensureCharacterSkills(numericCharId);
  const skillsTable = readSkillsTable();
  const nextSkills = { ...(skillsTable[characterKey] || {}) };
  for (const type of types) {
    const level = levels.get(type.typeID), current = nextSkills[String(type.typeID)];
    if (!current || current.skillLevel < level) nextSkills[String(type.typeID)] = buildSkillRecord(numericCharId, type, level);
  }
  // Skills and the permanent receipt share one skills-owner write. Extraction,
  // skill removal and whole-character skill replacement retain this namespace.
  const written = writeSkillsTable({ ...skillsTable, [characterKey]: nextSkills,
    _nodeGraphGrantReceipts: { ...(skillsTable._nodeGraphGrantReceipts || {}), [characterKey]: {
      ...(skillsTable._nodeGraphGrantReceipts?.[characterKey] || {}), [actionKey]: { fingerprint },
    } },
  }, numericCharId);
  if (!written?.success) return written;
  const flushed = repo.flushTableSync(SKILLS_TABLE);
  if (!flushed?.success) return flushed;
  syncCharacterSkillPoints(numericCharId, Object.values(nextSkills).reduce((sum, skill) => sum + toNumber(skill.skillPoints, 0), 0));
  setCharacterSkillBootstrapSuppressed(numericCharId, false);
  return { success: true, duplicate: false };
}

// Free SP belongs to the character owner, with its receipt in the same write.
function grantFreeSkillPointsOnce(charId, amount, actionKey) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 10000000 ||
      typeof actionKey !== "string" || !/^(nodegraph|campaign):[a-f0-9]{64}$/.test(actionKey)) {
    return { success: false, errorMsg: "INVALID_SKILL_POINT_GRANT" };
  }
  const owner = require("../character/characterState");
  const record = owner.getCharacterRecord(charId);
  if (!record) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  const receipts = record.freeSkillPointGrantReceipts || {};
  if (Object.hasOwn(receipts, actionKey)) {
    if (receipts[actionKey] !== amount) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
    const flushed = repo.flushTablesSync([CHARACTERS_TABLE]);
    return flushed?.success ? { success: true, duplicate: true } : flushed;
  }
  if (Object.keys(receipts).length >= 8192) return { success: false, errorMsg: "SKILL_POINT_RECEIPT_LIMIT" };
  const result = owner.updateCharacterRecord(charId, (current) => ({
    ...current,
    freeSkillPoints: Math.max(0, Number(current.freeSkillPoints) || 0) + amount,
    freeSkillPointGrantReceipts: { ...(current.freeSkillPointGrantReceipts || {}), [actionKey]: amount },
  }));
  if (!result.success) return result;
  const flushed = repo.flushTablesSync([CHARACTERS_TABLE]);
  if (flushed?.success) require("./training/skillQueueNotifications").notifyFreeSkillPointsChanged(charId, result.data.freeSkillPoints);
  return flushed && flushed.success ? { success: true, duplicate: false } : flushed;
}

module.exports = {
  grantCharacterSkillLevelsOnce,
  grantFreeSkillPointsOnce,
  removeSkillsRecord,
  SKILL_FLAG_ID,
  MAX_SKILL_LEVEL,
  buildSkillRecord,
  calculateSkillPointsForLevel,
  ensureAllCharacterSkills,
  ensureCharacterPublishedSkills,
  ensureCharacterSkills,
  ensureCharacterSkillTypes,
  ensureCharacterUnpublishedSkills,
  clearCharacterSkills,
  grantCharacterSkillLevels,
  grantCharacterSkillTypes,
  getCharacterBaseSkillMap,
  getCharacterBaseSkills,
  getCharacterSkillMap,
  getCachedCharacterSkillMap,
  isCharacterSkillMapCached,
  evictCachedCharacterSkillMap,
  clearCachedCharacterSkillMaps,
  getCharacterSkillPointTotal,
  getCharacterSkills,
  getSkillTypeByID,
  getSkillMutationVersion,
  getPublishedSkillTypes,
  getSkillTypes,
  getUnpublishedSkillTypes,
  removeCharacterSkillTypes,
  refreshSkillReference,
  replaceCharacterSkillRecords,
  seedCharacterAllSkills,
  seedCharacterPublishedSkills,
  seedCharacterStarterSkills,
  setCharacterSkillBootstrapSuppressed,
};
