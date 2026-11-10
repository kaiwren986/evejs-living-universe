"use strict";

const crypto = require("node:crypto");

const authority = require("./authority/hullBonusSkillAxes.json");

const EXPECTED_SCHEMA_VERSION = 1;
const EXPECTED_SDE_BUILD = 3396210;
const EXPECTED_TYPE_BONUS_FILE_SHA256 =
  "673813baf547a72eba5336e325d0ef9c4f2984f01f569c151eb496b4452e41ed";
const EXPECTED_PROJECTION_SHA256 =
  "5de09aaee77b44e0a9e44f6165b4850132153f6957ab9f18b60e2b1989b65308";
const EXPECTED_COUNTS = Object.freeze({
  publishedHullCount: 423,
  bonusHullCount: 389,
  bonusSkillLinkCount: 622,
});

if (
  Number(authority.schemaVersion) !== EXPECTED_SCHEMA_VERSION ||
  Number(authority.source && authority.source.buildNumber) !== EXPECTED_SDE_BUILD ||
  authority.source.fileSha256 !== EXPECTED_TYPE_BONUS_FILE_SHA256 ||
  authority.source.projectionSha256 !== EXPECTED_PROJECTION_SHA256
) {
  throw new Error(
    "Hull bonus skill authority does not match the supported SDE schema/build",
  );
}

const EMPTY_SKILL_TYPE_IDS = Object.freeze([]);
const projectionSha256 = crypto
  .createHash("sha256")
  .update(JSON.stringify(authority.byHullTypeID || {}))
  .digest("hex");
if (projectionSha256 !== EXPECTED_PROJECTION_SHA256) {
  throw new Error("Hull bonus skill authority projection is corrupted");
}
const bonusSkillTypeIDsByHullTypeID = new Map();
let bonusHullCount = 0;
let bonusSkillLinkCount = 0;
for (const [rawHullTypeID, rawSkillTypeIDs] of Object.entries(
  authority.byHullTypeID || {},
)) {
  const hullTypeID = Number(rawHullTypeID);
  const skillTypeIDs = Array.isArray(rawSkillTypeIDs)
    ? rawSkillTypeIDs.map(Number)
    : [];
  if (
    !Number.isInteger(hullTypeID) ||
    hullTypeID <= 0 ||
    !Array.isArray(rawSkillTypeIDs) ||
    skillTypeIDs.some((skillTypeID) => (
      !Number.isInteger(skillTypeID) || skillTypeID <= 0
    )) ||
    new Set(skillTypeIDs).size !== skillTypeIDs.length
  ) {
    throw new Error(`Invalid hull bonus skill authority row for type ${rawHullTypeID}`);
  }
  bonusSkillTypeIDsByHullTypeID.set(hullTypeID, Object.freeze(skillTypeIDs));
  if (skillTypeIDs.length > 0) {
    bonusHullCount += 1;
    bonusSkillLinkCount += skillTypeIDs.length;
  }
}

const computedCounts = {
  publishedHullCount: bonusSkillTypeIDsByHullTypeID.size,
  bonusHullCount,
  bonusSkillLinkCount,
};
for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
  if (
    Number(authority.counts && authority.counts[name]) !== expected ||
    computedCounts[name] !== expected
  ) {
    throw new Error(`Hull bonus skill authority has invalid ${name}`);
  }
}

function getHullBonusSkillTypeIDs(hullTypeID) {
  return (
    bonusSkillTypeIDsByHullTypeID.get(Number(hullTypeID)) ||
    EMPTY_SKILL_TYPE_IDS
  );
}

function hasHullBonusSkillAuthority(hullTypeID) {
  return bonusSkillTypeIDsByHullTypeID.has(Number(hullTypeID));
}

module.exports = {
  EXPECTED_SDE_BUILD,
  EXPECTED_SCHEMA_VERSION,
  EXPECTED_COUNTS,
  EXPECTED_PROJECTION_SHA256,
  EXPECTED_TYPE_BONUS_FILE_SHA256,
  getHullBonusSkillTypeIDs,
  hasHullBonusSkillAuthority,
};
