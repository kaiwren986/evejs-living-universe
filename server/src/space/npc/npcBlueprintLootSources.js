"use strict";

// Reward-source records belong here rather than in the installed static tables,
// so correcting a source also works for existing installations. Exact run counts
// are evidence; unspecified drop probabilities and uniform pool selection below
// are explicitly emulator policy, not a claim about CCP's private loot tables.
const EVIDENCE = Object.freeze({
  mordus: "https://www.eveonline.com/news/view/mordus-legion-fleet",
  mordusRuns: "https://forums.eveonline.com/t/ships-for-dualboxing-pve/370521/4",
  frentix: "https://gamingwithdaopa.ellatha.com/eveonline/pdw-09fx-frentix-production-facility/",
  factionShips: "https://forums-archive.eveonline.com/message/6805734/",
  prototypes: "https://www.eveonline.com/news/view/war-modules-super-friends",
  ancillaryArmor: "https://www.eveonline.com/news/view/no-brakes-retribution-1.1-balancing",
  beltPrototypes: "https://forums-archive.eveonline.com/message/2637717",
  beltDrops: "https://forums-archive.eveonline.com/message/2369574/",
});

const MORDUS_BELT_BLUEPRINTS = Object.freeze({ 33864: 33817, 33865: 33819, 33866: 33821 });
const FACTION_SHIPS = Object.freeze({
  angel: { small: 17933, medium: 17721, large: 17739 },
  blood: { small: 17927, medium: 17923, large: 17921 },
  guristas: { small: 17931, medium: 17716, large: 17919 },
  sansha: { small: 17925, medium: 17719, large: 17737 },
  serpentis: { small: 17929, medium: 17723, large: 17741 },
});

// The Inferno announcement identifies these exact launch-era modules (the old
// Target Spectrum Breaker is now Signature Radius Suppressor I, type 4410).
// Later capital, remote, faction and mutated variants are not inferred here.
const INFERNO_PROTOTYPES = Object.freeze([4404, 32775, 32773, 4392, 32781, 4410]);
// Historical nullsec belt reports identify these two blueprints at 50 runs.
const NULLSEC_BELT_PROTOTYPES = Object.freeze([4384, 32773]);
const ANCILLARY_ARMOR_PROTOTYPES = Object.freeze([33077, 33102, 33104]);

function text(value) {
  return String(value || "").trim().toLowerCase().replace(/[’']/g, "");
}

function sourceFaction(source) {
  const value = [source.factionName, source.npcGroupName, source.profileID, source.lootTableID,
    source.npcTypeName].map(text).join(" ");
  if (/angel|domination/.test(value)) return "angel";
  if (/blood|dark corp/.test(value)) return "blood";
  if (/guristas|\bpith/.test(value)) return "guristas";
  if (/sansha|\bcent(us|um|ii|ior)/.test(value)) return "sansha";
  if (/serpentis|\bshadow core/.test(value)) return "serpentis";
  return null;
}

function sourceHullBand(source) {
  const value = [source.npcGroupName, source.hullClass, source.sizeBand].map(text).join(" ");
  if (/\b(battleship|large)\b/.test(value)) return "large";
  if (/\b(cruiser|battlecruiser|medium)\b/.test(value)) return "medium";
  if (/\b(frigate|destroyer|small)\b/.test(value)) return "small";
  if (/\bofficer\b/.test(value)) return "large";
  return null;
}

function copy(typeID, licensedRuns) {
  return { typeID, quantity: 1, licensedRuns, materialEfficiency: 0, timeEfficiency: 0 };
}

function getNpcBlueprintLootSources(source = {}) {
  const npcTypeID = Number(source.npcTypeID);
  if (MORDUS_BELT_BLUEPRINTS[npcTypeID]) {
    return [{ sourceID: `mordus-belt-${npcTypeID}`, chance: 1,
      rewards: [copy(MORDUS_BELT_BLUEPRINTS[npcTypeID], 1)],
      evidenceURLs: [EVIDENCE.mordus, EVIDENCE.mordusRuns],
      policy: "CCP guarantees the belt patrol blueprint; matching hull and one run are observed." }];
  }
  if (npcTypeID === 29923) {
    return [
      { sourceID: "onuoto-standard-frentix", chance: 0.25, rewards: [copy(25509, 200)] },
      { sourceID: "onuoto-improved-frentix", chance: 0.25, rewards: [copy(25505, 100)] },
    ].map((entry) => ({ ...entry, evidenceURLs: [EVIDENCE.frentix],
      policy: "Observed runs and ME/PE 0; independent 25% drop chance is emulator policy." }));
  }

  const faction = sourceFaction(source);
  if (!faction) return [];
  const group = text(source.npcGroupName);
  const identity = [source.profileID, source.lootTableID].map(text).join(" ");
  const commanderOrOfficer = /\bcommander\b|\bofficer\b/.test(group) ||
    /(?:belt_commander|_officer)(?:\b|_)/.test(identity);
  // Overseer records are explicitly classified by the shipped NPC catalog.
  // A normal Deadspace Guristas Battleship is not an end boss.
  const overseer = /^parity_deadspace_overseer_\d+_/.test(text(source.profileID)) ||
    /^deadspace overseer\b/.test(group);
  const band = sourceHullBand(source);
  const nullsecBeltBattleship = /^asteroid\b/.test(group) && /\bbattleship\b/.test(group) &&
    ["nullsec", "null"].includes(text(source.securityClass)) && !source.siteID;
  const entries = [];
  if ((commanderOrOfficer || overseer) && (band || overseer)) {
    const hullTypes = band ? [FACTION_SHIPS[faction][band]] : Object.values(FACTION_SHIPS[faction]);
    entries.push({ sourceID: `${faction}-${overseer ? "overseer" : "commander"}-${band || "any"}-ship`,
      chance: 0.05, rewards: hullTypes.map((typeID) => copy(typeID, 1)),
      evidenceURLs: [EVIDENCE.factionShips],
      policy: "One-run pirate ship copy; 5% chance, matching hull band (or equal hull weights for an unclassified overseer) are emulator policy." });
  }
  if (commanderOrOfficer) {
    entries.push({ sourceID: "inferno-commander-prototypes", chance: 0.01,
      rewards: INFERNO_PROTOTYPES.map((typeID) => ({ typeID, quantity: 1,
        licensedRunsMin: 3, licensedRunsMax: 50, materialEfficiency: 0, timeEfficiency: 0 })),
      evidenceURLs: [EVIDENCE.prototypes],
      policy: "CCP documents 3–50 runs by difficulty; 1% chance, equal pool weights and uniform runs are emulator policy." });
  } else if (nullsecBeltBattleship) {
    entries.push({ sourceID: "nullsec-belt-prototypes", chance: 0.01,
      rewards: NULLSEC_BELT_PROTOTYPES.map((typeID) => copy(typeID, 50)),
      evidenceURLs: [EVIDENCE.beltDrops, EVIDENCE.beltPrototypes],
      policy: "Historical nullsec belt 50-run observations; 1% chance and equal pool weights are emulator policy." });
  }
  if (commanderOrOfficer || nullsecBeltBattleship) {
    entries.push({ sourceID: "retribution-ancillary-armor-prototypes", chance: 0.01,
      rewards: ANCILLARY_ARMOR_PROTOTYPES.map((typeID) => ({ typeID, quantity: 1 })),
      evidenceURLs: [EVIDENCE.ancillaryArmor],
      policy: "CCP confirms the same sources as ASBs but supplies no runs: owner fallback 1–5 runs with random ME/TE; 1% chance and equal pool weights are emulator policy." });
  }
  return entries;
}

function resolveNpcBlueprintLootMetadata(typeID, source = {}) {
  for (const record of getNpcBlueprintLootSources(source)) {
    const reward = record.rewards.find((entry) => Number(entry.typeID) === Number(typeID));
    if (reward) return { ...reward };
  }
  return null;
}

module.exports = { getNpcBlueprintLootSources, resolveNpcBlueprintLootMetadata };
