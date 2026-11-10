"use strict";

const {
  cloneValue,
} = require("../../../common/clone");
const {
  toInt,
} = require("../../../common/numbers");

const crypto = require("crypto");
const path = require("path");

const database = require(path.join(__dirname, "../../../gameStore"));
const {
  getSkillTypeByID,
} = require(path.join(__dirname, "../skillState"));

const SKILL_PLAN_TABLE = "skillPlans";
const MAX_PERSONAL_PLANS = 10;
const MAX_NUM_SKILLS = 150;
const MAX_NUM_MILESTONES = 5;
const MAX_LEN_NAME = 50;
const MAX_LEN_DESC = 1000;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

let skillPlanMutationVersion = 1;

function normalizeUuidString(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function createUuidString() {
  return crypto.randomUUID().toLowerCase();
}

function buildError(code, message, extra = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// The skillPlans table is runtime-owned and not pre-created by the database
// builder. Bootstrap its directory/data file on demand; otherwise the first
// read/write fails with TABLE_NOT_FOUND and personal plan saves silently vanish.
function ensureSkillPlanTable() {
  if (typeof database.ensureTable === "function") {
    database.ensureTable(SKILL_PLAN_TABLE);
  }
}

function readPlanTable() {
  ensureSkillPlanTable();
  const result = database.read(SKILL_PLAN_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }
  return result.data;
}

function writePlanTable(nextTable) {
  ensureSkillPlanTable();
  const result = database.write(SKILL_PLAN_TABLE, "/", nextTable);
  if (result && result.success) {
    skillPlanMutationVersion += 1;
  }
  return result;
}

function normalizeRequirementEntry(entry) {
  if (Array.isArray(entry)) {
    return normalizeRequirementEntry({
      typeID: entry[0],
      level: entry[1],
    });
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const typeID = toInt(entry.typeID ?? entry.skillTypeID, 0);
  const level = Math.max(0, Math.min(5, toInt(entry.level ?? entry.toLevel, 0)));
  if (typeID <= 0 || level <= 0) {
    return null;
  }

  const skillType = getSkillTypeByID(typeID);
  if (!skillType || skillType.published === false) {
    return null;
  }

  return {
    typeID,
    level,
  };
}

function getNormalizedRequirementList(requirements = []) {
  if (!Array.isArray(requirements)) {
    return [];
  }
  return requirements.map(normalizeRequirementEntry).filter(Boolean);
}

// A plan's skills as the client sent them: each [skill, level] in its order, an entry that is no published skill
// at a level 1 to 5 left out (normalizeRequirementEntry), at most MAX_NUM_SKILLS. Nothing is added, merged or
// moved. The retail client puts a plan right itself, by its own rules, before it sends one and again whenever it
// reads one (skills/skillplan/skillPlanValidation.py ValidateSkillPlan: from the editor on every change,
// EditableSkillPlanController._ValidateSkillRequirements; on reading, skillPlanService._GetPersonalSkillPlanController,
// which sends SetRequiredSkills where it changed one). And it keeps the list it sent as the plan, without reading it
// back (_SaveExistingPersonalSkillPlan: personalCache[id] = the edited plan; _CreateAndCachePersonalController
// validates its own copy). A server that rewrote the list (as this did: each skill's levels gathered together, the
// skills ordered by what needs what) gave the pilot a plan in another order on the next login than the one saved,
// where the client lets a skill's levels be spread through a plan.
function canonicalizeSkillRequirements(requirements = []) {
  const storedRequirements = getNormalizedRequirementList(requirements);
  if (storedRequirements.length > MAX_NUM_SKILLS) {
    throw buildError(
      "SKILL_PLAN_TOO_MANY_REQUIREMENTS",
      `Skill plan exceeds ${MAX_NUM_SKILLS} skill entries`,
      { maxEntries: MAX_NUM_SKILLS },
    );
  }
  return storedRequirements;
}

function normalizeMilestoneRecord(planID, milestoneID, rawMilestone = {}) {
  const normalizedMilestoneID = normalizeUuidString(milestoneID);
  if (!normalizedMilestoneID) {
    return null;
  }

  const description = String(rawMilestone.description || "").slice(0, MAX_LEN_DESC);
  const trainToTypeID = toInt(rawMilestone.trainToTypeID, 0);
  const skillTypeID = toInt(rawMilestone.skillTypeID, 0);
  const level = Math.max(0, Math.min(5, toInt(rawMilestone.level, 0)));
  if (trainToTypeID > 0) {
    return {
      milestoneID: normalizedMilestoneID,
      planID,
      description,
      trainToTypeID,
    };
  }
  if (skillTypeID > 0 && level > 0) {
    return {
      milestoneID: normalizedMilestoneID,
      planID,
      description,
      skillTypeID,
      level,
    };
  }
  return null;
}

function normalizePlanRecord(planID, rawPlan = {}) {
  const normalizedPlanID = normalizeUuidString(planID);
  if (!normalizedPlanID) {
    return null;
  }

  const milestonesSource =
    rawPlan && rawPlan.milestones && typeof rawPlan.milestones === "object"
      ? rawPlan.milestones
      : {};
  const normalizedMilestones = {};
  for (const [milestoneID, milestone] of Object.entries(milestonesSource)) {
    const normalizedMilestone = normalizeMilestoneRecord(
      normalizedPlanID,
      milestoneID,
      milestone,
    );
    if (normalizedMilestone) {
      normalizedMilestones[normalizedMilestone.milestoneID] = normalizedMilestone;
    }
  }

  return {
    planID: normalizedPlanID,
    name: String(rawPlan.name || "").slice(0, MAX_LEN_NAME),
    description: String(rawPlan.description || "").slice(0, MAX_LEN_DESC),
    requirements: canonicalizeSkillRequirements(rawPlan.requirements || []),
    milestones: normalizedMilestones,
    createdAt: Number(rawPlan.createdAt || Date.now()),
    updatedAt: Number(rawPlan.updatedAt || Date.now()),
  };
}

function normalizeCharacterPlanState(rawState = {}) {
  const plansSource =
    rawState && rawState.plans && typeof rawState.plans === "object"
      ? rawState.plans
      : {};
  const normalizedPlans = {};
  for (const [planID, plan] of Object.entries(plansSource)) {
    const normalizedPlan = normalizePlanRecord(planID, plan);
    if (normalizedPlan) {
      normalizedPlans[normalizedPlan.planID] = normalizedPlan;
    }
  }

  const activePlanID = normalizeUuidString(rawState.activePlanID);
  return {
    activePlanID: activePlanID && activePlanID !== ZERO_UUID ? activePlanID : null,
    plans: normalizedPlans,
  };
}

function getCharacterPlanState(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return normalizeCharacterPlanState({});
  }
  const table = readPlanTable();
  return normalizeCharacterPlanState(table[String(numericCharacterID)] || {});
}

function setCharacterPlanState(characterID, nextState) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return {
      success: false,
      errorMsg: "INVALID_CHARACTER",
    };
  }
  const table = readPlanTable();
  table[String(numericCharacterID)] = normalizeCharacterPlanState(nextState);
  return writePlanTable(table);
}

function assertPlanName(name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    throw buildError("SKILL_PLAN_INVALID_NAME", "Skill plan name cannot be blank");
  }
  if (normalizedName.length > MAX_LEN_NAME) {
    throw buildError("SKILL_PLAN_NAME_TOO_LONG", "Skill plan name is too long", {
      maxLength: MAX_LEN_NAME,
    });
  }
  return normalizedName;
}

function assertPlanDescription(description) {
  const normalizedDescription = String(description || "");
  if (normalizedDescription.length > MAX_LEN_DESC) {
    throw buildError("SKILL_PLAN_DESCRIPTION_TOO_LONG", "Skill plan description is too long", {
      maxLength: MAX_LEN_DESC,
    });
  }
  return normalizedDescription;
}

function listPersonalPlanIDs(characterID) {
  return Object.keys(getCharacterPlanState(characterID).plans);
}

function getPersonalPlan(characterID, planID) {
  const normalizedPlanID = normalizeUuidString(planID);
  if (!normalizedPlanID) {
    return null;
  }
  return cloneValue(getCharacterPlanState(characterID).plans[normalizedPlanID] || null);
}

function findSharedPersonalPlan(planID) {
  const normalizedPlanID = normalizeUuidString(planID);
  if (!normalizedPlanID) {
    return null;
  }

  const table = readPlanTable();
  for (const [characterID, rawState] of Object.entries(table)) {
    const state = normalizeCharacterPlanState(rawState);
    if (state.plans[normalizedPlanID]) {
      return {
        ownerCharacterID: toInt(characterID, 0),
        plan: cloneValue(state.plans[normalizedPlanID]),
      };
    }
  }
  return null;
}

function createPersonalPlan(characterID, attributes = {}) {
  const state = getCharacterPlanState(characterID);
  if (Object.keys(state.plans).length >= MAX_PERSONAL_PLANS) {
    throw buildError(
      "SKILL_PLAN_CAPACITY_REACHED",
      `Character already has ${MAX_PERSONAL_PLANS} personal skill plans`,
      { maxPlans: MAX_PERSONAL_PLANS },
    );
  }

  const planID = createUuidString();
  const nextPlan = normalizePlanRecord(planID, {
    name: assertPlanName(attributes.name),
    description: assertPlanDescription(attributes.description),
    requirements: attributes.requirements || [],
    milestones: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  state.plans[planID] = nextPlan;
  setCharacterPlanState(characterID, state);
  return cloneValue(nextPlan);
}

function updatePersonalPlan(characterID, planID, updates = {}) {
  const normalizedPlanID = normalizeUuidString(planID);
  const state = getCharacterPlanState(characterID);
  const existingPlan = state.plans[normalizedPlanID];
  if (!existingPlan) {
    throw buildError("SKILL_PLAN_NOT_FOUND", "Skill plan not found");
  }

  const nextPlan = normalizePlanRecord(normalizedPlanID, {
    ...existingPlan,
    ...(Object.prototype.hasOwnProperty.call(updates, "name")
      ? { name: assertPlanName(updates.name) }
      : null),
    ...(Object.prototype.hasOwnProperty.call(updates, "description")
      ? { description: assertPlanDescription(updates.description) }
      : null),
    ...(Object.prototype.hasOwnProperty.call(updates, "requirements")
      ? { requirements: updates.requirements || [] }
      : null),
    updatedAt: Date.now(),
  });
  state.plans[normalizedPlanID] = nextPlan;
  setCharacterPlanState(characterID, state);
  return cloneValue(nextPlan);
}

function deletePersonalPlan(characterID, planID) {
  const normalizedPlanID = normalizeUuidString(planID);
  const state = getCharacterPlanState(characterID);
  if (!state.plans[normalizedPlanID]) {
    return false;
  }
  delete state.plans[normalizedPlanID];
  if (state.activePlanID === normalizedPlanID) {
    state.activePlanID = null;
  }
  setCharacterPlanState(characterID, state);
  return true;
}

function getActivePersonalPlan(characterID) {
  const state = getCharacterPlanState(characterID);
  if (!state.activePlanID) {
    return null;
  }
  return cloneValue(state.plans[state.activePlanID] || null);
}

function getActivePlanID(characterID) {
  const state = getCharacterPlanState(characterID);
  return state.activePlanID || null;
}

function setActivePlanID(characterID, planID) {
  const normalizedPlanID = normalizeUuidString(planID);
  const state = getCharacterPlanState(characterID);
  if (!normalizedPlanID || normalizedPlanID === ZERO_UUID) {
    state.activePlanID = null;
  } else {
    state.activePlanID = normalizedPlanID;
  }
  setCharacterPlanState(characterID, state);
  return state.activePlanID;
}

function setActivePersonalPlan(characterID, planID) {
  return setActivePlanID(characterID, planID);
}

function listPersonalMilestones(characterID, planID) {
  const plan = getPersonalPlan(characterID, planID);
  if (!plan) {
    throw buildError("SKILL_PLAN_NOT_FOUND", "Skill plan not found");
  }
  return Object.values(plan.milestones || {}).map((milestone) => cloneValue(milestone));
}

function createPersonalMilestone(characterID, planID, attributes = {}) {
  const normalizedPlanID = normalizeUuidString(planID);
  const state = getCharacterPlanState(characterID);
  const plan = state.plans[normalizedPlanID];
  if (!plan) {
    throw buildError("SKILL_PLAN_NOT_FOUND", "Skill plan not found");
  }
  if (Object.keys(plan.milestones || {}).length >= MAX_NUM_MILESTONES) {
    throw buildError(
      "SKILL_PLAN_TOO_MANY_MILESTONES",
      `Skill plan exceeds ${MAX_NUM_MILESTONES} milestones`,
      { maxMilestones: MAX_NUM_MILESTONES },
    );
  }

  const milestoneID = createUuidString();
  const nextMilestone = normalizeMilestoneRecord(normalizedPlanID, milestoneID, {
    description: assertPlanDescription(attributes.description || ""),
    trainToTypeID: attributes.trainToTypeID,
    skillTypeID: attributes.skillTypeID,
    level: attributes.level,
  });
  if (!nextMilestone) {
    throw buildError("SKILL_PLAN_INVALID_MILESTONE", "Milestone data is invalid");
  }

  plan.milestones[milestoneID] = nextMilestone;
  plan.updatedAt = Date.now();
  setCharacterPlanState(characterID, state);
  return cloneValue(nextMilestone);
}

function findPersonalMilestone(characterID, milestoneID) {
  const normalizedMilestoneID = normalizeUuidString(milestoneID);
  if (!normalizedMilestoneID) {
    return null;
  }
  const state = getCharacterPlanState(characterID);
  for (const plan of Object.values(state.plans)) {
    if (plan.milestones && plan.milestones[normalizedMilestoneID]) {
      return {
        planID: plan.planID,
        milestone: cloneValue(plan.milestones[normalizedMilestoneID]),
      };
    }
  }
  return null;
}

function updatePersonalMilestoneDescription(characterID, milestoneID, description) {
  const normalizedMilestoneID = normalizeUuidString(milestoneID);
  const state = getCharacterPlanState(characterID);
  for (const plan of Object.values(state.plans)) {
    if (!plan.milestones || !plan.milestones[normalizedMilestoneID]) {
      continue;
    }
    plan.milestones[normalizedMilestoneID] = {
      ...plan.milestones[normalizedMilestoneID],
      description: assertPlanDescription(description || ""),
    };
    plan.updatedAt = Date.now();
    setCharacterPlanState(characterID, state);
    return cloneValue(plan.milestones[normalizedMilestoneID]);
  }
  throw buildError("SKILL_PLAN_MILESTONE_NOT_FOUND", "Skill plan milestone not found");
}

function deletePersonalMilestone(characterID, milestoneID) {
  const normalizedMilestoneID = normalizeUuidString(milestoneID);
  const state = getCharacterPlanState(characterID);
  for (const plan of Object.values(state.plans)) {
    if (!plan.milestones || !plan.milestones[normalizedMilestoneID]) {
      continue;
    }
    delete plan.milestones[normalizedMilestoneID];
    plan.updatedAt = Date.now();
    setCharacterPlanState(characterID, state);
    return true;
  }
  return false;
}

function clearCharacterPlanState(characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const table = readPlanTable();
  const characterKey = String(numericCharacterID);
  if (!Object.prototype.hasOwnProperty.call(table, characterKey)) {
    return {
      success: true,
      removed: false,
    };
  }

  delete table[characterKey];
  const writeResult = writePlanTable(table);
  return {
    ...(writeResult || { success: false, errorMsg: "WRITE_ERROR" }),
    removed: Boolean(writeResult && writeResult.success),
  };
}

function getSkillPlanMutationVersion() {
  return skillPlanMutationVersion;
}

module.exports = {
  MAX_LEN_DESC,
  MAX_LEN_NAME,
  MAX_NUM_MILESTONES,
  MAX_NUM_SKILLS,
  MAX_PERSONAL_PLANS,
  SKILL_PLAN_TABLE,
  ZERO_UUID,
  // Generic helpers reused by the corporation skill-plan state so plan/milestone
  // normalization and validation stay single-sourced across both scopes.
  assertPlanDescription,
  assertPlanName,
  canonicalizeSkillRequirements,
  createUuidString,
  normalizeMilestoneRecord,
  normalizeUuidString,
  clearCharacterPlanState,
  createPersonalMilestone,
  createPersonalPlan,
  deletePersonalMilestone,
  deletePersonalPlan,
  findPersonalMilestone,
  findSharedPersonalPlan,
  getActivePlanID,
  getActivePersonalPlan,
  getCharacterPlanState,
  getPersonalPlan,
  getSkillPlanMutationVersion,
  listPersonalMilestones,
  listPersonalPlanIDs,
  setActivePlanID,
  setActivePersonalPlan,
  setCharacterPlanState,
  updatePersonalMilestoneDescription,
  updatePersonalPlan,
};
