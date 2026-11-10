"use strict";

// A capsuleer corporation's member limit, reckoned from its CEO's skills.
//
// Client 3396210's SDE (fsd/staticdata dogmaeffects, dogmaattributes, typedogma):
// effect 82 corporationMemberLimitBonus adds a skill's corporationMemberBonus
// (attribute 191) to the character's corporationMemberLimit (attribute 190,
// default 0), once per trained level. Four skills carry the bonus: Corporation
// Management 20, Megacorp Management 100, Empire Control 400 and Sovereignty
// 2000 per level, so 12,600 with all four at V. The figure is read from the
// type dogma table rather than listed here, as dogma does.
//
// The corporation keeps the figure it was given: at founding, and when the CEO
// presses "Update with my skills" (corp_dlg_editcorpdetails.UpdateWithSkills ->
// corpRegistry.UpdateCorporationAbilities). It does not follow later training.

const path = require("path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));

const ATTRIBUTE_CORPORATION_MEMBER_BONUS = 191;
const MAX_SKILL_LEVEL = 5;

function getCorporationMemberBonus(typeID) {
  const table = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const record = table.typesByTypeID && table.typesByTypeID[String(typeID)];
  const value = Number(
    record && record.attributes && record.attributes[String(ATTRIBUTE_CORPORATION_MEMBER_BONUS)],
  );
  return Number.isFinite(value) ? value : 0;
}

function getSkillLevel(skillRecord) {
  const level = Math.trunc(Number(
    skillRecord && (
      skillRecord.effectiveSkillLevel ??
      skillRecord.trainedSkillLevel ??
      skillRecord.skillLevel
    ),
  ));
  return Number.isFinite(level) ? Math.max(0, Math.min(MAX_SKILL_LEVEL, level)) : 0;
}

// The character's corporationMemberLimit: what "Update with my skills" sets.
function computeCharacterCorporationMemberLimit(characterID) {
  const skillMap = getCachedCharacterSkillMap(characterID);
  if (!(skillMap instanceof Map)) {
    return 0;
  }
  let memberLimit = 0;
  for (const [typeID, skillRecord] of skillMap) {
    const level = getSkillLevel(skillRecord);
    if (level > 0) {
      memberLimit += level * getCorporationMemberBonus(typeID);
    }
  }
  return Math.max(0, Math.trunc(memberLimit));
}

// Whether a corporation of memberCount members may take one more. NPC
// corporations carry no limit (memberLimit -1). The CEO counts as a member:
// no client code or TQ capture says otherwise.
function hasRoomForAnotherMember(memberLimit, memberCount) {
  const limit = Math.trunc(Number(memberLimit));
  if (!Number.isFinite(limit) || limit < 0) {
    return true;
  }
  return Math.max(0, Math.trunc(Number(memberCount) || 0)) < limit;
}

module.exports = {
  ATTRIBUTE_CORPORATION_MEMBER_BONUS,
  computeCharacterCorporationMemberLimit,
  getCorporationMemberBonus,
  hasRoomForAnotherMember,
};
