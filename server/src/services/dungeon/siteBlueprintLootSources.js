"use strict";

// Source pools and licensed runs belong together. These are exploration loot
// records, never rules for every instance of a blueprint type.
const SOURCES = Object.freeze({
  drone: "https://evenomad.com/drone-data-sites/",
  prototype: "https://www.eveonline.com/news/view/war-modules-super-friends",
  ancillaryArmor: "https://www.eveonline.com/news/view/no-brakes-retribution-1.1-balancing",
  ghost: "https://evenomad.com/ghost-sites/",
  polarized: "https://www.eveonline.com/news/view/new-exploration-sites-new-modules",
  rigs: "https://www.eveonline.com/news/view/pinch-yourself-more-bosses-more-modules-more-loot-less-lurking-less-scraps-less-pop-up-bother",
  odyssey: "https://www.eveonline.com/news/view/patch-notes-for",
  phoebe: "https://www.eveonline.com/es/news/view/all-that-is-gold-does-not-glitter-data-sites-expeditions-and-more",
});

const STARBASE_BLUEPRINT_GROUPS = new Set([841, 853, 854, 855, 856, 857, 858, 859, 860, 871, 1048]);
const PIRATE_PREFIXES = Object.freeze({
  angel: /^(Angel|Domination) /,
  blood: /^(Blood|Dark Blood) /,
  guristas: /^(Guristas|Dread Guristas) /,
  sansha: /^(Sansha|True Sansha) /,
  serpentis: /^(Serpentis|Shadow) /,
});

const DRONES = Object.freeze({
  A: ["Acolyte", "Infiltrator", "Praetor"],
  C: ["Hornet", "Vespa", "Wasp"],
  G: ["Hobgoblin", "Hammerhead", "Ogre"],
  M: ["Warrior", "Valkyrie", "Berserker"],
});

const PROTOTYPES = Object.freeze([
  "Reactive Armor Hardener Blueprint",
  "Small Ancillary Shield Booster Blueprint",
  "Medium Ancillary Shield Booster Blueprint",
  "Large Ancillary Shield Booster Blueprint",
  "X-Large Ancillary Shield Booster Blueprint",
  // Same blueprint type 4410 as the original Target Spectrum Breaker.
  "Signature Radius Suppressor I Blueprint",
]);

const POLARIZED = Object.freeze([
  "Small Focused Pulse Laser", "Heavy Pulse Laser", "Mega Pulse Laser",
  "Light Neutron Blaster", "Heavy Neutron Blaster", "Neutron Blaster Cannon",
  "200mm AutoCannon", "425mm AutoCannon", "800mm Repeating Cannon",
  "Rocket Launcher", "Heavy Assault Missile Launcher", "Torpedo Launcher",
].map((name) => `Polarized ${name} Blueprint`));

const ANCILLARY_ARMOR = Object.freeze([
  "Small Ancillary Armor Repairer Blueprint",
  "Medium Ancillary Armor Repairer Blueprint",
  "Large Ancillary Armor Repairer Blueprint",
]);

function namesToCandidates(names, spec = {}) {
  return names.map((name) => ({ name, ...spec }));
}

function resolvePirateProfessionSource(context, profile) {
  const faction = String(context.pirateFaction || "").toLowerCase();
  const piratePrefixes = PIRATE_PREFIXES[faction] ? [PIRATE_PREFIXES[faction]] : Object.values(PIRATE_PREFIXES);
  const catalog = typeof context.getBlueprintTypes === "function"
    ? context.getBlueprintTypes() : context.blueprintTypes || [];
  const extraCandidates = catalog.filter((itemType) => {
    if (Number(itemType.categoryID) !== 9 || itemType.published === false) return false;
    const name = String(itemType.name || "");
    // Ship rigs only: structure rigs use a different blueprint group, even
    // when their names happen to begin with a ship-rig size and end in II.
    if (profile === "pirate_relic_loot" && Number(itemType.groupID) === 787 &&
        /^(Small|Medium|Large|Capital) .+ II Blueprint$/.test(name)) return true;
    return STARBASE_BLUEPRINT_GROUPS.has(Number(itemType.groupID)) &&
      piratePrefixes.some((prefix) => prefix.test(name)) && / Blueprint$/.test(name);
  }).map((itemType) => ({ name: itemType.name, typeID: itemType.typeID }));
  // One shared drop roll covers the combined profession pool. Recorded runs
  // stay specific to the launch-era prototypes; rigs/POS/AARs use fallback.
  return { id: `pirate-profession-blueprints:${profile}:${faction || "any"}`,
    evidence: [SOURCES.prototype, SOURCES.ancillaryArmor, SOURCES.rigs, SOURCES.odyssey, SOURCES.phoebe],
    candidates: [
      ...namesToCandidates(PROTOTYPES, { licensedRunsMin: 3, licensedRunsMax: 50,
        materialEfficiency: 0, timeEfficiency: 0 }),
      ...namesToCandidates(ANCILLARY_ARMOR),
      ...extraCandidates,
    ], chanceOneIn: 10 };
}

function droneCanKind(container, typeName) {
  const suffix = /metadrones.*[-–]\s*([bfn])\s*$/i.exec(typeName);
  if (suffix) return suffix[1].toUpperCase();
  const role = String(container.dungeonSiteContentRole || container.role || "");
  if (role === "research_laboratory") return "F";
  // Generic containment descriptors do not establish B versus N identity.
  // Their valid drone pool uses the owner's unknown-stat fallback instead.
  return null;
}

function resolveDroneSource(context) {
  const template = context.template || {};
  const match = /^(?:Detected )?(Abandoned|Derelict) Research Complex D([ACGM])\d+$/i
    .exec(String(template.resolvedName || ""));
  if (!match) return null;
  const can = droneCanKind(context.container || {}, context.containerTypeName || "");
  if (can === "N") return { id: "drone-data-junk-can", candidates: [], chanceOneIn: 10 };
  const escalation = match[1].toLowerCase() === "derelict";
  const race = match[2].toUpperCase();
  const names = DRONES[race].map((name) => `'${escalation ? "Augmented" : "Integrated"}' ${name} Blueprint`);
  const runs = can === "F" ? [120] : can === "B" ? [10, 60] : [];
  const candidates = runs.length > 0 ? runs.flatMap((licensedRuns) => namesToCandidates(names, {
    licensedRuns, materialEfficiency: 0, timeEfficiency: 0,
  })) : namesToCandidates(names);
  if (!escalation && race === "G" && Number(template.signatureLevel) === 1 && can !== "F") {
    candidates.push(...namesToCandidates([
      "'Augmented' Hobgoblin Blueprint", "'Augmented' Hammerhead Blueprint", "'Augmented' Ogre Blueprint",
      "'Augmented' Mining Drone Blueprint", "'Augmented' Ice Harvesting Drone Blueprint",
    ], { licensedRuns: 10, materialEfficiency: 0, timeEfficiency: 0 }));
  }
  return { id: `drone-data-${escalation ? "escalation" : "signature"}-${race}-${can || "aggregate"}`,
    evidence: SOURCES.drone, candidates, chanceOneIn: 10 };
}

function resolveGhostSource(context) {
  const template = context.template || {};
  const tier = String(template.siteTier || "").toLowerCase();
  if (!["lesser", "standard", "improved", "superior"].includes(tier)) return null;
  const container = context.container || {};
  if (container.dungeonSiteContentBonus === true || container.bonus === true) return null;
  const typeName = String(context.containerTypeName || "");
  const high = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  const mid = tier === "lesser" ? high : ["Delta", "Epsilon", "Gamma", "Omega"];
  const names = tier === "superior" ? [] : mid.map((part) => `Mid-grade Ascendancy ${part} Blueprint`);
  if (tier === "standard") names.push(...["Alpha", "Beta"].map((part) => `High-grade Ascendancy ${part} Blueprint`));
  if (tier === "improved") names.push(...high.map((part) => `High-grade Ascendancy ${part} Blueprint`));
  if (tier === "superior") {
    names.push(...["Delta", "Epsilon", "Gamma"].map((part) => `High-grade Ascendancy ${part} Blueprint`));
    if (/Secure Vault/i.test(typeName)) names.push("High-grade Ascendancy Omega Blueprint");
  }
  if (["standard", "improved", "superior"].includes(tier)) names.push("'Wetu' Mobile Depot Blueprint");
  if (["improved", "superior"].includes(tier)) names.push("'Yurt' Mobile Depot Blueprint");
  if (["standard", "improved"].includes(tier) && /Secure Databank/i.test(typeName)) {
    names.push("'Packrat' Mobile Tractor Unit Blueprint");
  }
  if (["improved", "superior"].includes(tier) && /Secure Mainframe/i.test(typeName)) {
    names.push("'Magpie' Mobile Tractor Unit Blueprint");
  }
  // Source and item identities are known. No reliable initial run/ME/TE record
  // was found, so these deliberately use the configured unknown-source policy.
  return { id: `ghost-${tier}-${typeName}`, evidence: SOURCES.ghost,
    candidates: namesToCandidates(names), chanceOneIn: 10 };
}

function resolveSiteBlueprintLootSource(context = {}) {
  const drone = resolveDroneSource(context);
  if (drone) return drone;
  const profile = String(context.profileKey || "");
  if (profile === "ghost_research_loot") return resolveGhostSource(context);
  const label = String(context.template && context.template.resolvedName || "");
  if (/^(Limited|Standard|Superior) Sleeper Cache$/i.test(label)) {
    const role = String(context.container?.dungeonSiteContentRole || context.container?.role || "");
    if (["sleeper_cache_coordinate", "sleeper_cache_defense_grid"].includes(role)) return null;
    return { id: "sleeper-cache-polarized", evidence: SOURCES.polarized,
      candidates: namesToCandidates(POLARIZED), chanceOneIn: 10 };
  }
  if (["pirate_data_loot", "pirate_relic_loot"].includes(profile)) {
    // CCP records the range, but not per-site discrete values or weights.
    // Sampling that range is an emulator policy, not a reconstructed CCP table.
    return resolvePirateProfessionSource(context, profile);
  }
  return null;
}

module.exports = { resolveSiteBlueprintLootSource };
