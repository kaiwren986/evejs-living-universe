"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const config = require("../../config");
const schedule = require("./eventSchedule");
const WAYPOINTS = Object.freeze(require("./campaignTrailWaypoints.json").map((entry) => Object.freeze({
  ...entry, position: Object.freeze({ ...entry.position }),
  placement: Object.freeze({ ...entry.placement, offsetMeters: Object.freeze({ ...entry.placement.offsetMeters }) }),
})));

const SEASON_ID = 900128;
const MAX_POINTS = 1500;
const REWARD_TRACK_VERSION = 2;
const ROUTE_VERSION = 2;
const EVENT_ART = Object.freeze({
  content: "res:/UI/Texture/classes/Seasons/Agency/ContentCard/GallenteElection_Agency_Navicons_326x200.png",
  navigation: "res:/UI/Texture/classes/Seasons/Agency/NavigationCard/GallenteElection_Agency_Navicons_400x666.png",
});
// Native client election banners and published SDE campaign-bus types.
// These season IDs identify the choices on the wire; SEASON_ID remains the
// shared persistence key so upgrading the prototype retains existing progress.
const CANDIDATES = Object.freeze([
  Object.freeze({ key: "roden", seasonID: 900129, name: "Soraya Roden", surname: "Roden",
    busTypeID: 92284, titleID: 1900128101, infoID: 1900128102, newsID: 1900128103,
    image: "res:/UI/Texture/classes/Seasons/Agency/NavigationCard/season-selectioncard-soraya_250x666.png",
    info: "Soraya Roden is a business leader who champions traditional values and cooperation with private enterprise to strengthen the Federation." }),
  Object.freeze({ key: "moreau", seasonID: 900130, name: "Alix Moreau", surname: "Moreau",
    busTypeID: 92283, titleID: 1900128111, infoID: 1900128112, newsID: 1900128113,
    image: "res:/UI/Texture/classes/Seasons/Agency/NavigationCard/season-selectioncard-alix_250x666.png",
    info: "Governor Alix Moreau champions the freedom to explore new possibilities, challenging traditional limits and embracing change." }),
  Object.freeze({ key: "tenzin", seasonID: 900131, name: "Lucas Tenzin", surname: "Tenzin",
    busTypeID: 92282, titleID: 1900128121, infoID: 1900128122, newsID: 1900128123,
    image: "res:/UI/Texture/classes/Seasons/Agency/NavigationCard/season-selectioncard-lucas_250x666.png",
    info: "Senator Lucas Tenzin champions humanity-first policies and shared prosperity. His grassroots campaign stands apart from political parties and major corporate donors." }),
]);
const REWARDS = Object.freeze(require("./gallenteHistoricalRewards.json").rewards.map((reward, index) =>
  Object.freeze({ ...reward, index, receiptKey: reward.points === 1000 ? 1000 : `historical:${reward.points}` })));
const ARRIVAL_RANGE_METERS = 150_000;
const LUMINAIRE_ID = 30004967;
const OLD_MAN_STAR_ID = 30005000;
const POSTOUVIN_ID = 30003581;
const START_ID = 8_400_300_049_670_001;
const FINISH_ID = 8_400_300_049_670_002;
const GATE_ID = 50006126;
const BEACON_TYPE_ID = 10645; // Celestial Beacon: visible and warpable system-wide.
const KYONOKE_TYPE_ID = BEACON_TYPE_ID;
const START_TIME = Date.UTC(2026, 8, 15);
const END_TIME = Date.UTC(2036, 8, 15);

// Temporary event markers retain route coordinates without installing scenery.
const KYONOKE_FACILITY_ID = 8_400_300_035_810_001;
const KYONOKE_BEACON_ID = KYONOKE_FACILITY_ID;
const kyonokeBeacon = Object.freeze({ itemID: KYONOKE_BEACON_ID,
  itemName: "Campaign Trail: Kyonoke Memorial", solarSystemID: POSTOUVIN_ID,
  position: Object.freeze({ x: -217777503922.9922, y: 18896855040, z: -96119801130.58594 }) });

// Temporary placements 100,000 km off Luminaire VI, 1,000 km apart. These are
// emulator-authored positions, not recovered retail coordinates.
const BEACONS = Object.freeze([
  Object.freeze({ itemID: START_ID, itemName: "Campaign Trail Starting Line",
    solarSystemID: LUMINAIRE_ID,
    position: Object.freeze({ x: 630921512374, y: -10783236579, z: -233691716037 }) }),
  Object.freeze({ itemID: FINISH_ID, itemName: "Campaign Trail Finish Line",
    solarSystemID: LUMINAIRE_ID,
    position: Object.freeze({ x: 630922512374, y: -10783236579, z: -233691716037 }) }),
  kyonokeBeacon,
  ...WAYPOINTS,
]);
const LOCATIONS = BEACONS;

const STEPS = Object.freeze([
  Object.freeze({ key: "start", challengeID: 90012801, itemID: START_ID,
    solarSystemID: LUMINAIRE_ID, typeID: BEACON_TYPE_ID, points: 10,
    nameID: 1900128011, textID: 1900128012, progressID: 1900128013 }),
  Object.freeze({ key: "darieux", challengeID: 90012802, itemID: GATE_ID,
    solarSystemID: OLD_MAN_STAR_ID, typeID: 57760, points: 10,
    nameID: 1900128021, textID: 1900128022, progressID: 1900128023 }),
  // Preserve earlier step keys/IDs so existing points and visits survive.
  Object.freeze({ key: "kyonoke", challengeID: 90012804, itemID: KYONOKE_FACILITY_ID,
    solarSystemID: POSTOUVIN_ID, typeID: KYONOKE_TYPE_ID, points: 10,
    nameID: 1900128041, textID: 1900128042, progressID: 1900128043 }),
  ...WAYPOINTS.map((waypoint) => Object.freeze({
    key: waypoint.key, challengeID: waypoint.challengeID, itemID: waypoint.itemID,
    solarSystemID: waypoint.solarSystemID, typeID: waypoint.typeID, points: 10,
    nameID: waypoint.nameID, textID: waypoint.textID, progressID: waypoint.progressID,
  })),
  Object.freeze({ key: "finish", challengeID: 90012803, itemID: FINISH_ID,
    solarSystemID: LUMINAIRE_ID, typeID: BEACON_TYPE_ID, points: 10,
    nameID: 1900128031, textID: 1900128032, progressID: 1900128033 }),
]);

const MESSAGES = Object.freeze({
  ...Object.fromEntries(WAYPOINTS.flatMap((waypoint, index) => [
    [waypoint.nameID, `${waypoint.systemName}: ${waypoint.destinationName}`],
    [waypoint.textID, `Travel to <a href="showinfo:5//${waypoint.solarSystemID}">${waypoint.systemName}</a> and warp to <a href="showinfo:${waypoint.typeID}//${waypoint.itemID}">${waypoint.itemName}</a>. Arrive within 150 km to earn 10 points. ${waypoint.placement.status === "captured" ? "" : "This destination currently uses a temporary Campaign Trail beacon. "}Next: ${WAYPOINTS[index + 1] ? `${WAYPOINTS[index + 1].destinationName} in ${WAYPOINTS[index + 1].systemName}` : "the finish line in Luminaire"}.`],
    [waypoint.progressID, `Visit ${waypoint.destinationName} in ${waypoint.systemName}`],
  ])),
  ...Object.fromEntries(CANDIDATES.flatMap((candidate) => [
    [candidate.titleID, `${candidate.surname} for President YC128`],
    [candidate.infoID, `${candidate.info}<br><br>Choose ${candidate.name} to represent their campaign. This choice lasts for the event. At 1,000 points, earn the <a href="showinfo:${candidate.busTypeID}">${candidate.surname} YC128 Campaign Bus</a>. Existing Campaign Trail points are kept.`],
    [candidate.newsID, `${candidate.info}<br><br>Complete the Campaign Trail for ${candidate.name}. Earn favors, PLEX, skill points, crates and SKINr materials, plus the <a href="showinfo:${candidate.busTypeID}">${candidate.surname} YC128 Campaign Bus</a> at 1,000 points. Milestone rewards are awarded once through the redeem queue. Continue to 1,500 points for the extended rewards. Return to the starting line after each run to continue earning points.`],
  ])),
  1900128001: "Campaign Trail",
  1900128002: "Begin at the Luminaire starting line, follow the 15 destinations in order, and return to the Luminaire finish line. Reach each destination within 150 km to earn 10 points, for 170 points per full run. Repeat the trail and complete mining, trading or Gallente security missions to earn up to 1,500 points. Milestones award favors, PLEX, skill points, crates, SKINr materials and your candidate's campaign bus at 1,000 points. Rewards are delivered once through the redeem queue.",
  1900128011: "Luminaire: Campaign Trail Starting Line",
  1900128012: `Travel to <a href="showinfo:5//${LUMINAIRE_ID}">Luminaire</a> and warp to <a href="showinfo:${BEACON_TYPE_ID}//${START_ID}">Campaign Trail Starting Line</a>. Arrive within 150 km to earn 10 points and unlock the next destination.`,
  1900128013: "Visit the Campaign Trail Starting Line",
  1900128021: "Old Man Star: Darieux's Stargate",
  1900128022: `Travel to <a href="showinfo:5//${OLD_MAN_STAR_ID}">Old Man Star</a> and approach <a href="showinfo:57760//${GATE_ID}">Stargate (Villore)</a> within 150 km to earn 10 points. This is Old Man Darieux's memorial stargate. Next, visit the Kyonoke Memorial Research Facility in Postouvin.`,
  1900128023: "Visit Darieux's Stargate in Old Man Star",
  1900128031: "Luminaire: Campaign Trail Finish Line",
  1900128032: `Return to <a href="showinfo:5//${LUMINAIRE_ID}">Luminaire</a> and warp to <a href="showinfo:${BEACON_TYPE_ID}//${FINISH_ID}">Campaign Trail Finish Line</a>. Arrive within 150 km to earn 10 points and complete the trail.`,
  1900128033: "Visit the Campaign Trail Finish Line",
  1900128041: "Postouvin: Kyonoke Memorial Research Facility",
  1900128042: `Travel to <a href="showinfo:5//${POSTOUVIN_ID}">Postouvin</a> and warp to <a href="showinfo:${BEACON_TYPE_ID}//${KYONOKE_BEACON_ID}">Kyonoke Memorial Research Site</a>. Arrive within 150 km of the <a href="showinfo:${KYONOKE_TYPE_ID}//${KYONOKE_FACILITY_ID}">H4-RP4 Kyonoke Memorial Research Facility</a> to earn 10 points, then continue to the Duvolle Observatory waypoint in Gererique.`,
  1900128043: "Visit the Kyonoke Memorial Research Facility",
});

function isEnabled(nowMs = getWallclockNowMs()) {
  if (config.campaignTrailEnabled !== true || schedule.get(schedule.ELECTION)?.enabled !== true) return false;
  return !require("./eventLifecycle").concludeIfDue(nowMs) && schedule.isActive(schedule.ELECTION, nowMs);
}
function canClaim(nowMs = getWallclockNowMs()) { return Boolean(require("./eventLifecycle").read(schedule.ELECTION).conclusion) || schedule.canClaim(nowMs); }
function canTrade(nowMs = getWallclockNowMs()) {
  if (config.campaignTrailEnabled !== true || schedule.get(schedule.ELECTION)?.enabled !== true) return false;
  const closed = require("./eventLifecycle").concludeIfDue(nowMs);
  return config.campaignTrailEnabled === true && schedule.get(schedule.ELECTION)?.enabled === true &&
    (closed ? nowMs < closed.traderEndsAtMs : schedule.canTrade(nowMs));
}

function isRunComplete(state) {
  return STEPS.every((step) => Boolean(state.completed[step.key]));
}

function getCandidate(state) {
  return CANDIDATES.find((candidate) => candidate.key === state.candidateKey) || null;
}

function getSeasonID(state) {
  return getCandidate(state)?.seasonID || SEASON_ID;
}

function getRewards(state) {
  const candidate = getCandidate(state);
  return REWARDS.filter(reward => reward.points !== 1000 || candidate).map(reward =>
    reward.points === 1000 ? { ...reward, typeID: candidate.busTypeID,
      name: `${candidate.surname} YC128 Campaign Bus` } : reward);
}

function getActiveStep(state) {
  if (!getCandidate(state) || state.points >= MAX_POINTS) return null;
  return STEPS.find((step) => !state.completed[step.key]) || STEPS[0];
}

function getBeacon(itemID) {
  return BEACONS.find((entry) => entry.itemID === Number(itemID)) || null;
}

function getStaticEntitiesForSystem(systemID) {
  if (!isEnabled()) return [];
  const entities = BEACONS.filter((entry) => entry.solarSystemID === Number(systemID) &&
    entry.placement?.status !== "captured").map((entry) => ({
    kind: "campaignTrailBeacon", itemID: entry.itemID, typeID: BEACON_TYPE_ID,
    groupID: 310, categoryID: 2, graphicID: 1211, ownerID: entry.ownerID || 500004,
    itemName: entry.itemName, slimName: entry.itemName, radius: 1,
    solarSystemID: entry.solarSystemID, position: { ...entry.position },
    velocity: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
    // A "system" beacon is a global Ball.
    staticVisibilityScope: "system", isGlobal: true,
  }));
  return entities;
}

module.exports = { REWARD_TRACK_VERSION, SEASON_ID, ROUTE_VERSION, WAYPOINTS, MAX_POINTS, REWARDS, CANDIDATES, EVENT_ART,
  getCandidate, getSeasonID, getRewards, ARRIVAL_RANGE_METERS, LUMINAIRE_ID, OLD_MAN_STAR_ID, POSTOUVIN_ID,
  START_ID, FINISH_ID, GATE_ID, BEACON_TYPE_ID, START_TIME, END_TIME,
  KYONOKE_FACILITY_ID, KYONOKE_BEACON_ID, KYONOKE_TYPE_ID,
  BEACONS, LOCATIONS, STEPS, MESSAGES, isEnabled, canClaim, canTrade, isRunComplete, getActiveStep, getBeacon, getStaticEntitiesForSystem };
Object.defineProperties(module.exports, {
  START_TIME: { get: () => schedule.get(schedule.ELECTION)?.startsAtMs ?? START_TIME },
  END_TIME: { get: () => require("./eventLifecycle").read(schedule.ELECTION).conclusion?.endsAtMs ?? schedule.get(schedule.ELECTION)?.endsAtMs ?? END_TIME },
});
