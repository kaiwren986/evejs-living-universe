"use strict";

// EveJS RPG fork: the contract director.
//
// Decides every FACT of a generated contract from real game state: where it
// is, which pirates, how strong, what it pays. The language model never chooses
// any of this; it only writes the words (contractWriter.js). Everything returned
// here is plain data that can be stored and replayed.

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const pirateFactionPolicy = require(path.join(__dirname, "../../space/npc/pirateFactionPolicy"));
const pirateHullProfiles = require(path.join(__dirname, "../../space/npc/pirateHullProfiles"));
const { resolveItemByTypeID, resolveItemByName } =
  require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));

// Each faction borrows the single-room "Hideaway" site for its scenery; the
// contents (waves, boss, cache) are replaced per contract.
const FACTIONS = Object.freeze({
  angels: { name: "Angel Cartel", short: "Angel", templateID: "eve-university:Angel_Hideaway", tag: "Angel Copper Tag" },
  blood: { name: "Blood Raiders", short: "Blood Raider", templateID: "eve-university:Blood_Hideaway", tag: "Blood Copper Tag" },
  guristas: { name: "Guristas Pirates", short: "Guristas", templateID: "eve-university:Guristas_Hideaway", tag: "Guristas Copper Tag" },
  sanshas: { name: "Sansha's Nation", short: "Sansha", templateID: "eve-university:Sansha_Hideaway", tag: "Sansha Copper Tag" },
  serpentis: { name: "Serpentis Corporation", short: "Serpentis", templateID: "eve-university:Serpentis_Hideaway", tag: "Serpentis Copper Tag" },
});
const DEFAULT_FACTION = "guristas";

const EMPIRES = Object.freeze({
  500001: "Caldari State", 500002: "Minmatar Republic", 500003: "Amarr Empire", 500004: "Gallente Federation",
  500007: "Ammatar Mandate", 500008: "Khanid Kingdom",
});

const HULLS = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]);

// Ship group -> difficulty tier (1 frigate ... 5 battleship). Unknown hulls play as tier 1.
const TIER_BY_GROUP = Object.freeze({
  25: 1, 31: 1, 237: 1, 324: 1, 830: 1, 831: 1, 834: 1, 893: 1, 1283: 1, 1527: 1, 2001: 1,
  420: 2, 541: 2, 1305: 2, 1534: 2,
  26: 3, 358: 3, 832: 3, 833: 3, 894: 3, 906: 3, 963: 3, 1972: 3,
  419: 4, 540: 4, 1201: 4,
  27: 5, 381: 5, 898: 5, 900: 5,
});

// What each tier fields. A tier-1 boss is a named regular hull so a new pilot
// in a frigate has a fair fight; commanders (faction elites) start at tier 3.
const TIERS = Object.freeze({
  1: { waves: [["frigate", "frigate"], ["frigate", "frigate"]], boss: "frigate", commander: false, escorts: ["frigate"], isk: 400000, tags: 4, paste: 10 },
  2: { waves: [["frigate", "frigate", "frigate"], ["destroyer", "frigate", "frigate"]], boss: "destroyer", commander: false, escorts: ["frigate", "frigate"], isk: 1000000, tags: 8, paste: 20 },
  3: { waves: [["frigate", "frigate", "frigate"], ["cruiser", "cruiser", "frigate"]], boss: "cruiser", commander: true, escorts: ["cruiser"], isk: 2800000, tags: 14, paste: 40 },
  4: { waves: [["cruiser", "cruiser", "frigate", "frigate"], ["battlecruiser", "cruiser", "cruiser"]], boss: "battlecruiser", commander: true, escorts: ["cruiser", "cruiser"], isk: 6500000, tags: 22, paste: 60 },
  5: { waves: [["cruiser", "cruiser", "cruiser", "frigate", "frigate"], ["battleship", "battlecruiser", "cruiser"]], boss: "battleship", commander: true, escorts: ["battlecruiser", "cruiser"], isk: 15000000, tags: 32, paste: 100 },
});

const SITE_DISTANCE_METERS = 5500000000;
const SITE_DISTANCE_JITTER_METERS = 350000000;
const MAX_JUMPS = 2;

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function tierForShip(shipTypeID) {
  const type = resolveItemByTypeID(Number(shipTypeID));
  return TIER_BY_GROUP[Number(type?.groupID)] || 1;
}

function isOrdinarySystem(system) {
  return Boolean(system) && !pirateFactionPolicy.isSpecialSpaceSystem(system.solarSystemID, system) &&
    !pirateFactionPolicy.isWormholeSpaceSystem(system.solarSystemID);
}

// Systems within MAX_JUMPS that are no more dangerous than a step below where the pilot is now.
function nearbySystems(originID) {
  const origin = worldData.getSolarSystemByID(originID);
  const floor = Number(origin?.security) >= 0.45 ? 0.45 : -1;
  const seen = new Map([[Number(originID), 0]]);
  let frontier = [Number(originID)];
  for (let jumps = 1; jumps <= MAX_JUMPS; jumps += 1) {
    const next = [];
    for (const systemID of frontier) {
      for (const gate of worldData.getStargatesForSystem(systemID)) {
        const destinationID = Number(gate.destinationSolarSystemID);
        const destination = worldData.getSolarSystemByID(destinationID);
        if (!destinationID || seen.has(destinationID) || !isOrdinarySystem(destination)) continue;
        if (Number(destination.security) < floor) continue;
        seen.set(destinationID, jumps);
        next.push(destinationID);
      }
    }
    frontier = next;
  }
  return [...seen].map(([systemID, jumps]) => ({ systemID, jumps }));
}

function sitePosition(systemID, seed) {
  const celestials = worldData.getCelestialsForSystem(systemID)
    .filter((celestial) => celestial?.position && String(celestial.kind).toLowerCase() === "planet");
  const anchor = celestials.length ? celestials[hashText(`${seed}:anchor`) % celestials.length] : null;
  const base = anchor?.position || { x: 0, y: 0, z: 0 };
  const angle = ((hashText(`${seed}:angle`) % 3600) / 3600) * Math.PI * 2;
  const distance = SITE_DISTANCE_METERS + (hashText(`${seed}:distance`) % (SITE_DISTANCE_JITTER_METERS * 2)) - SITE_DISTANCE_JITTER_METERS;
  return {
    anchorName: anchor?.itemName || "",
    position: {
      x: base.x + Math.cos(angle) * distance,
      y: base.y + (hashText(`${seed}:vertical`) % 40000000) - 20000000,
      z: base.z + Math.sin(angle) * distance,
    },
  };
}

// A concrete NPC profile for a faction hull, stepping down a class when the faction has none.
function profileFor(factionKey, hull, seed, commander) {
  for (let index = HULLS.indexOf(hull); index >= 0; index -= 1) {
    const profileID = pirateHullProfiles.resolveFactionHullProfileID(factionKey, HULLS[index], { seed, commander });
    if (profileID) return { profileID, hull: HULLS[index] };
  }
  return null;
}

function buildForces(factionKey, tier, seed) {
  const plan = TIERS[tier];
  const waves = plan.waves.map((hulls, waveIndex) => hulls
    .map((hull, index) => profileFor(factionKey, hull, `${seed}:w${waveIndex}:${index}`, false))
    .filter(Boolean));
  const boss = profileFor(factionKey, plan.boss, `${seed}:boss`, plan.commander);
  const escorts = plan.escorts
    .map((hull, index) => profileFor(factionKey, hull, `${seed}:escort:${index}`, false))
    .filter(Boolean);
  return boss && waves.every((wave) => wave.length) ? { waves, boss, escorts } : null;
}

function cacheLoot(faction, tier) {
  const plan = TIERS[tier];
  const loot = [];
  for (const [name, quantity] of [[faction.tag, plan.tags], ["Nanite Repair Paste", plan.paste]]) {
    const type = resolveItemByName(name, { exactOnly: true })?.match;
    if (type?.typeID) loot.push({ typeID: Number(type.typeID), quantity, name: type.name || name });
  }
  return loot;
}

/**
 * Plan a bounty contract for a pilot.
 * @returns {object|null} the contract's facts, or null when the pilot is somewhere contracts cannot run
 */
function planBounty({ characterID, shipTypeID, solarSystemID, sequence }) {
  const origin = worldData.getSolarSystemByID(Number(solarSystemID));
  if (!origin) return null;
  const seed = `${characterID}:${sequence}`;
  const candidates = nearbySystems(Number(solarSystemID));
  const pick = candidates[hashText(`${seed}:system`) % candidates.length];
  const system = worldData.getSolarSystemByID(pick.systemID);

  let factionKey = pirateFactionPolicy.resolvePirateFactionKeyForSystem(pick.systemID);
  if (!FACTIONS[factionKey]) factionKey = DEFAULT_FACTION;
  const faction = FACTIONS[factionKey];
  const tier = tierForShip(shipTypeID);
  const forces = buildForces(factionKey, tier, seed);
  if (!forces) return null;
  const site = sitePosition(pick.systemID, seed);

  return {
    shape: "bounty",
    tier,
    factionKey,
    factionName: faction.name,
    factionShort: faction.short,
    templateID: faction.templateID,
    systemID: pick.systemID,
    systemName: system.solarSystemName,
    security: Math.round(Number(system.security) * 10) / 10,
    jumps: pick.jumps,
    originSystemName: origin?.solarSystemName || "",
    empireName: EMPIRES[Number(system.factionID)] || "CONCORD",
    anchorName: site.anchorName,
    position: site.position,
    forces,
    hostileCount: forces.waves.reduce((sum, wave) => sum + wave.length, 0) + forces.escorts.length + 1,
    bossHull: forces.boss.hull,
    rewardIsk: TIERS[tier].isk,
    cache: cacheLoot(faction, tier),
  };
}

module.exports = { planBounty, tierForShip, FACTIONS };
