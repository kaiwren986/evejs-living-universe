"use strict";
/**
 * Hackable-container loot tables — official-caliber distribution model
 * (round 11, 2026-09-17).
 *
 * Official drop tables are CCP server-private: they are in neither the SDE
 * nor the client bytecode (unlike the hacking minigame itself), so exact
 * per-can parity is unreachable. This module targets DISTRIBUTION parity
 * with a three-source anchor system:
 *   - UniWiki Relic_and_data_sites can-tier rates (nullsec relic cans,
 *     captured 2026-09), cross-validated against the MacrophageNT 100-site
 *     expected-count study (T2 4.69 vs 4.72 and T1 38.3 vs 39.45 expected
 *     units per site for a nullsec site mix — golden anchor A in the test);
 *   - Riley Entertainment highsec statistics (100 data + 100 relic sites per
 *     pirate faction, browser-captured 2026-09-17): the data-can model and
 *     the Debris tier are calibrated to its per-category totals (golden
 *     anchors B/C), and it independently confirms the 0.5x highsec scale
 *     (observed highsec Rubble T1 ~0.12-0.15 vs the UniWiki 0.25 base).
 *
 * Tables marked APPROXIMATION have no published official numbers (UniWiki
 * only publishes per-can rates for nullsec relic cans); their structure is
 * official (faction pools, independent per-item rolls, tier scaling) and
 * their magnitudes are calibrated to the community ISK/h baselines.
 *
 * Rolls are seeded deterministically from the caller's container key (same
 * convention as the legacy per-tag builders): one can = one loot roll, the
 * result is granted once and persisted by the site service (lootSeeded).
 *
 * Known deferrals (blueprint copies need the industryBlueprintState grant
 * path, not just an itemStore row): pirate data BPCs, relic rig/POS BPCs,
 * ghost Ascendancy / 'Wetu' / 'Yurt' / 'Packrat' / 'Magpie' BPCs. The
 * non-BPC official categories all ship here.
 */

const path = require("path");
const {
  resolveItemByName,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));

// ---------------------------------------------------------------------------
// Small local helpers (kept module-private: this is a pure logic module and
// must not depend on the site service).

function normalizeLowerText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  return normalized || fallback;
}

// Same algorithm as the site service's hashText — seeded determinism is part
// of the site-content contract (same can key -> same loot across restarts).
function hashText(value) {
  const normalized = String(value == null ? "" : value);
  let state = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    state = Math.imul(state ^ normalized.charCodeAt(index), 0x45d9f3b);
    state ^= state >>> 16;
  }
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state ^= state >>> 16;
  return state >>> 0;
}

// Deterministic unit roll in [0, 1).
function rollUnit(seed) {
  return (hashText(seed) % 1_000_000) / 1_000_000;
}

function rollQuantity(seed, range) {
  const minimum = Math.max(1, Math.trunc(Number(range && range[0]) || 1));
  const maximum = Math.max(minimum, Math.trunc(Number(range && range[1]) || minimum));
  if (maximum <= minimum) {
    return minimum;
  }
  return minimum + (hashText(`${seed}#q`) % ((maximum - minimum) + 1));
}

const cachedTypeRecordByName = new Map();

function resolveTypeRecordByName(candidateName) {
  const key = String(candidateName || "").trim();
  if (!key) {
    return null;
  }
  if (cachedTypeRecordByName.has(key)) {
    return cachedTypeRecordByName.get(key);
  }
  // An absent candidate must never become a fuzzy match for a different item.
  const lookup = resolveItemByName(key, { exactOnly: true });
  const match = lookup && lookup.success && lookup.match ? lookup.match : null;
  cachedTypeRecordByName.set(key, match);
  return match;
}

// ---------------------------------------------------------------------------
// Pirate relic loot — salvage pools and can-tier rates.
//
// Pool composition is the UniWiki salvage-by-faction table (2026-09): every
// faction shares the five T1/T2 circuit/ANN/power pairs plus faction-exclusive
// rows. Rogue-drone relic sites (no pirate faction in the site name) officially
// draw from the whole table, modeled as the union pool.

const COMMON_T2_SALVAGE = Object.freeze([
  "Artificial Neural Network",
  "Interface Circuit",
  "Logic Circuit",
  "Micro Circuit",
  "Power Circuit",
]);

const COMMON_T1_SALVAGE = Object.freeze([
  "Damaged Artificial Neural Network",
  "Fried Interface Circuit",
  "Burned Logic Circuit",
  "Charred Micro Circuit",
  "Tripped Power Circuit",
]);

const FACTION_SALVAGE_POOLS = Object.freeze({
  angel: Object.freeze({
    t2: Object.freeze(["Impetus Console", "Single-crystal Superalloy I-beam", "Trigger Unit"]),
    t1: Object.freeze(["Thruster Console", "Alloyed Tritanium Bar", "Smashed Trigger Unit"]),
  }),
  blood: Object.freeze({
    t2: Object.freeze(["Capacitor Console", "Power Conduit"]),
    t1: Object.freeze(["Melted Capacitor Console", "Tangled Power Conduit"]),
  }),
  guristas: Object.freeze({
    t2: Object.freeze(["Enhanced Ward Console", "Intact Shield Emitter", "Telemetry Processor"]),
    t1: Object.freeze(["Ward Console", "Malfunctioning Shield Emitter", "Scorched Telemetry Processor"]),
  }),
  sansha: Object.freeze({
    t2: Object.freeze(["Current Pump", "Intact Armor Plates", "Nanite Compound"]),
    t1: Object.freeze(["Defective Current Pump", "Armor Plates", "Contaminated Nanite Compound"]),
  }),
  serpentis: Object.freeze({
    t2: Object.freeze(["Conductive Thermoplastic", "Drone Transceiver", "Lorentz Fluid"]),
    t1: Object.freeze(["Conductive Polymer", "Broken Drone Transceiver", "Contaminated Lorentz Fluid", "Malfunctioning Shield Emitter"]),
  }),
});

function buildUnionSalvagePools() {
  const t2 = new Set(COMMON_T2_SALVAGE);
  const t1 = new Set(COMMON_T1_SALVAGE);
  for (const pools of Object.values(FACTION_SALVAGE_POOLS)) {
    pools.t2.forEach((name) => t2.add(name));
    pools.t1.forEach((name) => t1.add(name));
  }
  return {
    t2: Object.freeze([...t2]),
    t1: Object.freeze([...t1]),
  };
}

const UNION_SALVAGE_POOLS = buildUnionSalvagePools();

// Per-can-tier rates (UniWiki, nullsec/wormhole pirate relic cans):
// Rubble T1 25% (3-20) / T2 5.5% (1-3); Remains T1 50% (5-40) / T2 12.5%
// (1-5); Ruins T2-only 25% (1-15). Stack sizes uniform. Each salvage item in
// the faction pool rolls INDEPENDENTLY — the tier rates are per item, which is
// what reproduces the MacrophageNT expected counts.
// Debris: Riley Entertainment highsec statistics (500 relic sites, 2026-09
// capture) — per-item T1 ~15% (stack 3-10) / T2 ~1.6% (1-2) observed at the
// highsec band, i.e. base 0.30/0.032 under the 0.5x security scale. Debris
// only spawns in highsec, so the base rates are the inverted observation.
const RELIC_CAN_ROLLS = Object.freeze({
  debris: Object.freeze({
    t1: Object.freeze({ probability: 0.30, quantity: [3, 10] }),
    t2: Object.freeze({ probability: 0.032, quantity: [1, 2] }),
  }),
  rubble: Object.freeze({
    t1: Object.freeze({ probability: 0.25, quantity: [3, 20] }),
    t2: Object.freeze({ probability: 0.055, quantity: [1, 3] }),
  }),
  remains: Object.freeze({
    t1: Object.freeze({ probability: 0.50, quantity: [5, 40] }),
    t2: Object.freeze({ probability: 0.125, quantity: [1, 5] }),
  }),
  ruins: Object.freeze({
    t1: null,
    t2: Object.freeze({ probability: 0.25, quantity: [1, 15] }),
  }),
});

// Non-salvage relic can categories (Riley relic statistics, 500 sites): Metal
// Scraps and Spatial Attunement Unit accompany salvage (~6%/can each at
// highsec → 0.12 base). Carbon was REMOVED: zero Carbon observed across all
// 500 relic and 500 data sites despite UniWiki listing it.
const RELIC_MISC_ROLLS = Object.freeze([
  Object.freeze({ names: ["Metal Scraps"], probability: 0.12, quantity: [1, 2] }),
  Object.freeze({ names: ["Spatial Attunement Unit"], probability: 0.12, quantity: [1, 3] }),
]);

// ---------------------------------------------------------------------------
// Pirate data loot — datacore pools by faction (UniWiki matrix, 2026-09) and
// per-can-tier roll magnitudes.
//
// Data can rates have NO published official table (UniWiki labels the cans
// only by difficulty) — APPROXIMATION: structure is official (faction science
// pools, all decryptor types, High-Tech parts, Carbon, Calm filaments,
// invention skillbooks), magnitudes track the community ISK/h baselines.

const FACTION_DATACORE_POOLS = Object.freeze({
  angel: Object.freeze([
    "Datacore - Mechanical Engineering",
    "Datacore - Molecular Engineering",
    "Datacore - Nanite Engineering",
    "Datacore - Rocket Science",
    "Datacore - Minmatar Starship Engineering",
    "Datacore - Nuclear Physics",
  ]),
  blood: Object.freeze([
    "Datacore - Mechanical Engineering",
    "Datacore - Hydromagnetic Physics",
    "Datacore - Molecular Engineering",
    "Datacore - Nanite Engineering",
    "Datacore - Quantum Physics",
    "Datacore - Amarrian Starship Engineering",
    "Datacore - High Energy Physics",
    "Datacore - Laser Physics",
  ]),
  guristas: Object.freeze([
    "Datacore - Mechanical Engineering",
    "Datacore - Hydromagnetic Physics",
    "Datacore - Quantum Physics",
    "Datacore - Electromagnetic Physics",
    "Datacore - Electronic Engineering",
    "Datacore - Graviton Physics",
    "Datacore - Rocket Science",
    "Datacore - Caldari Starship Engineering",
  ]),
  sansha: Object.freeze([
    "Datacore - Mechanical Engineering",
    "Datacore - Hydromagnetic Physics",
    "Datacore - Molecular Engineering",
    "Datacore - Nanite Engineering",
    "Datacore - Quantum Physics",
    "Datacore - Amarrian Starship Engineering",
    "Datacore - High Energy Physics",
    "Datacore - Laser Physics",
  ]),
  serpentis: Object.freeze([
    "Datacore - Mechanical Engineering",
    "Datacore - Electromagnetic Physics",
    "Datacore - Electronic Engineering",
    "Datacore - Graviton Physics",
    "Datacore - Gallentean Starship Engineering",
    "Datacore - Plasma Physics",
  ]),
});

// A pirate data can with no resolvable faction falls back to the legacy
// per-tag builder in the site service (drone data sites have their own
// BPC-driven economy this module does not model yet).

// Decryptor draw weights: Riley Entertainment data-site statistics (500
// highsec data sites, 1136 decryptor draws, 2026-09 capture). The pool is NOT
// uniform — Symmetry dominates at ~60%. Plain "Attainment Decryptor" was not
// observed once in 500 sites; it carries a token weight to keep the official
// "all decryptor types" claim honest.
const DECRYPTOR_WEIGHTS = Object.freeze([
  Object.freeze(["Symmetry Decryptor", 683]),
  Object.freeze(["Process Decryptor", 207]),
  Object.freeze(["Parity Decryptor", 87]),
  Object.freeze(["Accelerant Decryptor", 85]),
  Object.freeze(["Augmentation Decryptor", 70]),
  Object.freeze(["Optimized Attainment Decryptor", 2]),
  Object.freeze(["Optimized Augmentation Decryptor", 2]),
  Object.freeze(["Attainment Decryptor", 2]),
]);

// Pirate faction (storyline) materials — the volume backbone of data cans.
// Three tiers per faction; the two Amarr-space factions share one set
// (Riley: Positron Cord/Auxiliary Parts/Force Cable appear only under
// Blood Raiders and Sansha's Nation columns).
const FACTION_MATERIAL_TIERS = Object.freeze({
  angel: Object.freeze({ t1: "Electric Conduit", t2: "Mechanic Parts", t3: "Energy Cells" }),
  blood: Object.freeze({ t1: "Positron Cord", t2: "Auxiliary Parts", t3: "Force Cable" }),
  guristas: Object.freeze({ t1: "Electronic Link", t2: "Spare Parts", t3: "Power Couplings" }),
  sansha: Object.freeze({ t1: "Positron Cord", t2: "Auxiliary Parts", t3: "Force Cable" }),
  serpentis: Object.freeze({ t1: "Current Amplifier", t2: "Second-hand Parts", t3: "Heat Depressor" }),
});

// Molecular Condensers: Info Shard cans only, one 4-8 stack per winning roll,
// variant drawn from the faction's observed set (Riley per-faction columns).
const FACTION_CONDENSER_POOLS = Object.freeze({
  angel: Object.freeze(["AV-Composite Molecular Condenser", "CV-Composite Molecular Condenser"]),
  blood: Object.freeze(["LM-Composite Molecular Condenser"]),
  guristas: Object.freeze(["AG-Composite Molecular Condenser", "CV-Composite Molecular Condenser"]),
  sansha: Object.freeze(["AG-Composite Molecular Condenser", "LM-Composite Molecular Condenser"]),
  serpentis: Object.freeze(["AV-Composite Molecular Condenser", "CV-Composite Molecular Condenser"]),
});

// Encryption Methods skillbooks pair with the faction's host empire
// (Riley: Minmatar books in Angel sites, Caldari in Guristas, ...).
const FACTION_ENCRYPTION_BOOK = Object.freeze({
  angel: "Minmatar Encryption Methods",
  blood: "Amarr Encryption Methods",
  guristas: "Caldari Encryption Methods",
  sansha: "Amarr Encryption Methods",
  serpentis: "Gallente Encryption Methods",
});

// Rigging skillbooks: Jury Rigging dominant, plus the faction's flavor pair
// (weights = Riley observed counts over 500 data sites).
const FACTION_RIGGING_BOOK_WEIGHTS = Object.freeze({
  angel: Object.freeze([["Jury Rigging", 37], ["Projectile Weapon Rigging", 9], ["Astronautics Rigging", 3]]),
  blood: Object.freeze([["Jury Rigging", 37], ["Armor Rigging", 8], ["Energy Weapon Rigging", 8]]),
  guristas: Object.freeze([["Jury Rigging", 37], ["Electronic Superiority Rigging", 6], ["Launcher Rigging", 5]]),
  sansha: Object.freeze([["Jury Rigging", 37], ["Energy Weapon Rigging", 4], ["Armor Rigging", 2]]),
  serpentis: Object.freeze([["Jury Rigging", 37], ["Hybrid Weapon Rigging", 11], ["Drones Rigging", 8]]),
});

const HIGH_TECH_PART_POOL = Object.freeze([
  "High-Tech Manufacturing Tools",
  "High-Tech Data Chip",
  "High-Tech Scanner",
]);

const CALM_FILAMENT_POOL = Object.freeze([
  "Calm Dark Filament",
  "Calm Electrical Filament",
  "Calm Exotic Filament",
  "Calm Firestorm Filament",
  "Calm Gamma Filament",
]);

const TRANQUIL_FILAMENT_POOL = Object.freeze([
  "Tranquil Dark Filament",
  "Tranquil Electrical Filament",
  "Tranquil Exotic Filament",
  "Tranquil Firestorm Filament",
  "Tranquil Gamma Filament",
]);

// Pochven jump filaments: the single most common data-can drop after the
// faction materials (307 units over 500 Riley sites). Treated as unscaled
// filler like decryptors.
const NEEDLEJACK_FILAMENT_WEIGHTS = Object.freeze([
  Object.freeze(["Noise-5 'Needlejack' Filament", 213]),
  Object.freeze(["Signal-5 'Needlejack' Filament", 94]),
]);

// Ancient-race trade materials, faction-paired to the host empire region
// (Riley: Sleeper under Angel, Takmahl under Blood/Sansha, Talocan under
// Guristas, Yan Jung under Serpentis).
const ANCIENT_RACE_POOLS = Object.freeze({
  sleeper: Object.freeze([
    "Sleeper Cryo Batteries",
    "Sleeper Data Crystals",
    "Sleeper Data Interface Protocol",
    "Sleeper Foundation Block",
    "Sleeper Heat Nullifying Coil",
    "Sleeper Micro Circuits",
    "Sleeper Nanite Cluster",
    "Sleeper Technical Schematics",
  ]),
  takmahl: Object.freeze([
    "Takmahl Binary Texts",
    "Takmahl Centrifugal Primer",
    "Takmahl Cohere Cord",
    "Takmahl Diamond Rod",
    "Takmahl Gyro Ballast",
    "Takmahl Magnetic Slab",
    "Takmahl Phrenic Appendix",
    "Takmahl Solid Mox",
    "Takmahl Tri-polished Lens",
  ]),
  talocan: Object.freeze([
    "Talocan Info Shards",
    "Talocan Mathematical Schematics",
    "Talocan Mechanical Gears",
    "Talocan Partition Plates",
    "Talocan Perpetual Clock",
    "Talocan Reflective Sheets",
    "Talocan Solid Atomizer",
  ]),
  yanjung: Object.freeze([
    "Yan Jung Nano Fabric",
    "Yan Jung Paradox Box",
    "Yan Jung Plenary Wire",
    "Yan Jung Semiotic Theory",
    "Yan Jung Silk Armor",
    "Yan Jung Thunder Kite",
    "Yan Jung Trigonometric Laws",
    "Yan Jung Vellum Etch",
    "Yan Jung Void Machine",
  ]),
});

const FACTION_ANCIENT_POOL_KEY = Object.freeze({
  angel: "sleeper",
  blood: "takmahl",
  guristas: "talocan",
  sansha: "takmahl",
  serpentis: "yanjung",
});

// Rare faction artifacts ("Pirate Faction Materials (Artifacts)" in the
// Riley avg table, always 1x). No artifacts were observed for Blood Raiders
// or Sansha's Nation — empty pools there.
const FACTION_ARTIFACT_POOLS = Object.freeze({
  angel: Object.freeze([
    "Angel Simple Trigger Mechanism",
    "Angel Standard Trigger Mechanism",
    "Angel Advanced Trigger Mechanism",
  ]),
  blood: Object.freeze([]),
  guristas: Object.freeze([
    "Guristas Graviton Hardening",
    "Guristas Light Weapon Console",
  ]),
  sansha: Object.freeze([]),
  serpentis: Object.freeze([
    "Serpentis Plain Target Guider",
    "Serpentis Complex Target Guider",
    "Serpentis Modified Capital Microprocessor",
  ]),
});

// Data can roll model, base = nullsec caliber (security scale: highsec 0.5x,
// lowsec 0.75x). Info Shard and Com Tower magnitudes are CALIBRATED to the
// Riley highsec statistics (observed x2 under that scale): decryptor ~0.8/can
// and needlejack ~0.2/can are flat unscaled filler (scaling 0.8 to 1.6 would
// exceed a probability bound and the filler role argues against it);
// Mainframe/Databank tiers keep the APPROXIMATION ladder (official numbers
// never published — highsec sites stop at Com Tower).
// Stack ranges for materials/condensers/datacores are the Riley avg table
// (official caliber); the BPC category (~0.07/can, 'Ligature' dominant) is
// deferred until the blueprint-copy grant path exists.
const DATA_CAN_ROLLS = Object.freeze({
  info_shard: Object.freeze({
    datacore: Object.freeze({ probability: 0.05, quantity: [1, 2] }),
    condenser: Object.freeze({ probability: 0.22, quantity: [4, 8] }),
    materialT1: Object.freeze({ probability: 0.56, quantity: [16, 35] }),
    materialT2: Object.freeze({ probability: 0.44, quantity: [7, 15] }),
    materialT3: null,
    decryptor: Object.freeze({ probability: 0.80 }),
    encryptionBook: Object.freeze({ probability: 0.024 }),
    riggingBook: Object.freeze({ probability: 0.076 }),
    highTech: Object.freeze({ probability: 0.114 }),
    calmFilament: Object.freeze({ probability: 0.128 }),
    tranquilFilament: Object.freeze({ probability: 0.008 }),
    needlejack: Object.freeze({ probability: 0.20 }),
    ancient: Object.freeze({ probability: 0.04 }),
    artifact: Object.freeze({ probability: 0.02 }),
  }),
  com_tower: Object.freeze({
    datacore: Object.freeze({ probability: 0.05, quantity: [2, 4] }),
    condenser: null,
    materialT1: Object.freeze({ probability: 0.56, quantity: [35, 75] }),
    materialT2: Object.freeze({ probability: 0.44, quantity: [15, 32] }),
    materialT3: Object.freeze({ probability: 0.40, quantity: [7, 15] }),
    decryptor: Object.freeze({ probability: 0.80 }),
    encryptionBook: Object.freeze({ probability: 0.024 }),
    riggingBook: Object.freeze({ probability: 0.076 }),
    highTech: Object.freeze({ probability: 0.114 }),
    calmFilament: Object.freeze({ probability: 0.128 }),
    tranquilFilament: Object.freeze({ probability: 0.008 }),
    needlejack: Object.freeze({ probability: 0.20 }),
    ancient: Object.freeze({ probability: 0.04 }),
    artifact: Object.freeze({ probability: 0.02 }),
  }),
  mainframe: Object.freeze({
    datacore: Object.freeze({ probability: 0.06, quantity: [2, 5] }),
    condenser: null,
    materialT1: Object.freeze({ probability: 0.56, quantity: [45, 90] }),
    materialT2: Object.freeze({ probability: 0.44, quantity: [20, 40] }),
    materialT3: Object.freeze({ probability: 0.40, quantity: [10, 20] }),
    decryptor: Object.freeze({ probability: 0.80 }),
    encryptionBook: Object.freeze({ probability: 0.024 }),
    riggingBook: Object.freeze({ probability: 0.076 }),
    highTech: Object.freeze({ probability: 0.114 }),
    calmFilament: Object.freeze({ probability: 0.128 }),
    tranquilFilament: Object.freeze({ probability: 0.008 }),
    needlejack: Object.freeze({ probability: 0.20 }),
    ancient: Object.freeze({ probability: 0.04 }),
    artifact: Object.freeze({ probability: 0.02 }),
  }),
  databank: Object.freeze({
    datacore: Object.freeze({ probability: 0.07, quantity: [3, 6] }),
    condenser: null,
    materialT1: Object.freeze({ probability: 0.56, quantity: [55, 110] }),
    materialT2: Object.freeze({ probability: 0.44, quantity: [25, 50] }),
    materialT3: Object.freeze({ probability: 0.40, quantity: [12, 25] }),
    decryptor: Object.freeze({ probability: 0.80 }),
    encryptionBook: Object.freeze({ probability: 0.024 }),
    riggingBook: Object.freeze({ probability: 0.076 }),
    highTech: Object.freeze({ probability: 0.114 }),
    calmFilament: Object.freeze({ probability: 0.128 }),
    tranquilFilament: Object.freeze({ probability: 0.008 }),
    needlejack: Object.freeze({ probability: 0.20 }),
    ancient: Object.freeze({ probability: 0.04 }),
    artifact: Object.freeze({ probability: 0.02 }),
  }),
});

// ---------------------------------------------------------------------------
// Wormhole Sleeper cans — pools carried over from the legacy builders,
// reshaped as independent rolls scaled by wormhole class. Rates are
// APPROXIMATION (no published official table for wormhole cans).

const SLEEPER_DATACORE_POOL = Object.freeze([
  "Datacore - Electronic Engineering",
  "Datacore - Mechanical Engineering",
  "Datacore - Quantum Physics",
  "Datacore - Rocket Science",
  "Datacore - Laser Physics",
]);

const SLEEPER_DATA_POOL = Object.freeze([
  "Neural Network Analyzer",
  "Sleeper Data Library",
  "Ancient Coordinates Database",
]);

const ANCIENT_SALVAGE_POOL = Object.freeze([
  "Melted Nanoribbons",
  "Fused Nanomechanical Engines",
  "Powdered C-540 Graphite",
  "Modified Fluid Router",
  "Heuristic Selfassemblers",
  "Cartesian Temporal Coordinator",
  "Thermoelectric Catalysts",
  "Electromechanical Hull Sheeting",
]);

const ANCIENT_SALVAGE_RARE_POOL = Object.freeze([
  "Emergent Combat Analyzer",
  "Neurovisual Input Matrix",
  "Resonance Calibration Matrix",
  "Defensive Control Node",
  "Jump Drive Control Nexus",
  "Central System Controller",
  "Emergent Combat Intelligence",
]);

const SLEEPER_COMMON_SALVAGE_POOL = Object.freeze([
  "Intact Armor Plates",
  "Tripped Power Circuit",
  "Burned Logic Circuit",
  "Charred Micro Circuit",
]);

// C1-C2 / C3-C4 / C5-C6 bands.
const SLEEPER_RELIC_BAND_ROLLS = Object.freeze([
  Object.freeze({
    ancient: { probability: 0.18, quantity: [2, 6] },
    ancientRare: { probability: 0.04, quantity: [1, 2] },
    salvage: { probability: 0.10, quantity: [1, 4] },
  }),
  Object.freeze({
    ancient: { probability: 0.24, quantity: [2, 6] },
    ancientRare: { probability: 0.06, quantity: [1, 2] },
    salvage: { probability: 0.10, quantity: [1, 4] },
  }),
  Object.freeze({
    ancient: { probability: 0.30, quantity: [2, 6] },
    ancientRare: { probability: 0.09, quantity: [1, 2] },
    salvage: { probability: 0.10, quantity: [1, 4] },
  }),
]);

const SLEEPER_DATA_ROLLS = Object.freeze({
  datacore: { probability: 0.15, quantity: [1, 4] },
  decryptor: { probability: 0.08, quantity: [1, 1] },
  sleeperData: { probability: 0.22, quantity: [1, 3] },
});

// ---------------------------------------------------------------------------
// Ghost site cans (Covert Research Facility). Non-BPC official categories:
// Covert Research Tools (staple), Shattered Villard Wheel (implant material),
// capital control components (Standard+), and the bonus can's guaranteed
// Electro-Neural Signaller (UniWiki Ghost Sites). The dominant official value
// (Ascendancy / mobile structure / MTU BPCs) awaits the blueprint-copy grant
// path. Rates other than the bonus-can signaller are APPROXIMATION.

const GHOST_TIER_ROLLS = Object.freeze({
  lesser: Object.freeze({
    tools: { probability: 0.85, quantity: [2, 5] },
    villardWheel: { probability: 0.10, quantity: [1, 2] },
    capitalComponent: null,
  }),
  standard: Object.freeze({
    tools: { probability: 0.85, quantity: [3, 7] },
    villardWheel: { probability: 0.12, quantity: [1, 2] },
    capitalComponent: { probability: 0.10, quantity: [1, 2] },
  }),
  improved: Object.freeze({
    tools: { probability: 0.85, quantity: [4, 9] },
    villardWheel: { probability: 0.15, quantity: [1, 2] },
    capitalComponent: { probability: 0.12, quantity: [1, 2] },
  }),
  superior: Object.freeze({
    tools: { probability: 0.85, quantity: [5, 12] },
    villardWheel: { probability: 0.18, quantity: [1, 2] },
    capitalComponent: { probability: 0.15, quantity: [1, 3] },
  }),
});

const GHOST_CAPITAL_COMPONENT_POOL = Object.freeze([
  "Electro-Neural Signaller",
  "Nano Regulation Gate",
]);

// ---------------------------------------------------------------------------
// Roll machinery.

function buildEntry(typeRecord, quantity) {
  if (!typeRecord || !(Math.max(0, Math.trunc(Number(typeRecord.typeID) || 0)) > 0)) {
    return null;
  }
  return {
    itemType: typeRecord,
    quantity: Math.max(1, Math.trunc(Number(quantity) || 1)),
    options: null,
  };
}

// Independent per-item roll across a pool: each name rolls once (probability
// scaled), winners get a uniform quantity in range.
function rollIndependentPool(seed, poolNames, rollSpec, probabilityScale = 1) {
  if (!rollSpec) {
    return [];
  }
  const entries = [];
  for (const name of poolNames) {
    const probability = Math.max(0, Math.min(1, rollSpec.probability * probabilityScale));
    if (rollUnit(`${seed}::${name}`) >= probability) {
      continue;
    }
    const typeRecord = resolveTypeRecordByName(name);
    const entry = typeRecord
      ? buildEntry(typeRecord, rollQuantity(`${seed}::${name}`, rollSpec.quantity))
      : null;
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

// Single pick from a pool (uniform among pool members).
function rollSinglePick(seed, poolNames, probability, quantityRange) {
  const names = [...poolNames];
  if (names.length <= 0 || rollUnit(`${seed}::pick`) >= Math.max(0, Math.min(1, probability))) {
    return [];
  }
  const picked = names[hashText(`${seed}::pick#which`) % names.length];
  const typeRecord = resolveTypeRecordByName(picked);
  const entry = typeRecord ? buildEntry(typeRecord, rollQuantity(`${seed}::pick`, quantityRange)) : null;
  return entry ? [entry] : [];
}

// Single pick from a weighted pool ([[name, weight], ...]).
function rollWeightedPick(seed, weightedPool, probability, quantityRange) {
  const entries = [...weightedPool].filter((pair) => pair && pair[0]);
  if (entries.length <= 0 || rollUnit(`${seed}::wpick`) >= Math.max(0, Math.min(1, probability))) {
    return [];
  }
  const totalWeight = entries.reduce((total, pair) => total + Math.max(0, pair[1] || 0), 0);
  if (totalWeight <= 0) {
    return [];
  }
  let cursor = (hashText(`${seed}::wpick#which`) >>> 0) % totalWeight;
  let picked = entries[0][0];
  for (const pair of entries) {
    cursor -= Math.max(0, pair[1] || 0);
    if (cursor < 0) {
      picked = pair[0];
      break;
    }
  }
  const typeRecord = resolveTypeRecordByName(picked);
  const entry = typeRecord ? buildEntry(typeRecord, rollQuantity(`${seed}::wpick`, quantityRange)) : null;
  return entry ? [entry] : [];
}

function mergeEntries(entries) {
  const mergedByTypeID = new Map();
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const typeID = Math.max(0, Math.trunc(Number(entry.itemType && entry.itemType.typeID) || 0));
    if (typeID <= 0) {
      continue;
    }
    if (!mergedByTypeID.has(typeID)) {
      mergedByTypeID.set(typeID, {
        itemType: entry.itemType,
        quantity: entry.quantity,
        options: null,
      });
      continue;
    }
    mergedByTypeID.get(typeID).quantity += entry.quantity;
  }
  return [...mergedByTypeID.values()];
}

// ---------------------------------------------------------------------------
// Context resolution (site label -> faction / security band / ghost tier).

function resolveFactionFromLabel(siteLabel) {
  const label = normalizeLowerText(siteLabel);
  if (!label) {
    return "";
  }
  if (label.includes("angel") || label.includes("cartel")) {
    return "angel";
  }
  if (label.includes("blood")) {
    return "blood";
  }
  if (label.includes("guristas") || label.includes("pith")) {
    return "guristas";
  }
  if (label.includes("sansha")) {
    return "sansha";
  }
  if (label.includes("serpentis") || label.includes("corelum")) {
    return "serpentis";
  }
  return "";
}

// UniWiki on empire relic/data rates: "likely identical but with lower drop
// rates" — the band scale is an APPROXIMATION of that reduction.
function resolveSecurityScale(securityBand, siteLabel) {
  const band = normalizeLowerText(securityBand);
  const label = normalizeLowerText(siteLabel);
  const effectiveBand = band ||
    (label.includes("local ") || label.includes("crumbling ") ? "highsec" : "") ||
    (label.includes("regional ") || label.includes("decayed ") ? "lowsec" : "") ||
    "";
  if (effectiveBand === "highsec") {
    return 0.5;
  }
  if (effectiveBand === "lowsec") {
    return 0.75;
  }
  return 1.0;
}

function resolveGhostTierFromLabel(siteLabel) {
  const label = normalizeLowerText(siteLabel);
  if (label.includes("lesser")) {
    return "lesser";
  }
  if (label.includes("improved")) {
    return "improved";
  }
  if (label.includes("superior")) {
    return "superior";
  }
  return "standard";
}

function stripRoleFamilyPrefix(role) {
  return normalizeLowerText(role).replace(/^(?:data|relic)_/, "");
}

function resolveSleeperBandIndex(wormholeClassID) {
  const classID = Math.max(0, Math.trunc(Number(wormholeClassID) || 0));
  if (classID >= 5) {
    return 2;
  }
  return classID >= 3 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Profile roll entry points. All return null when the (profile, role) pair is
// not covered, so the site service falls back to the legacy per-tag builder.

function rollPirateRelicLoot(seed, role, siteLabel, securityBand) {
  const canTier = RELIC_CAN_ROLLS[stripRoleFamilyPrefix(role)] ||
    // Generic-role legacy cans: mid-tier approximation.
    RELIC_CAN_ROLLS.remains;
  const faction = resolveFactionFromLabel(siteLabel);
  // Every faction pool = the five shared circuit/ANN/power pairs plus the
  // faction-exclusive rows; faction-less hosts (drone space) use the union.
  const pools = faction
    ? {
      t1: [...COMMON_T1_SALVAGE, ...FACTION_SALVAGE_POOLS[faction].t1],
      t2: [...COMMON_T2_SALVAGE, ...FACTION_SALVAGE_POOLS[faction].t2],
    }
    : UNION_SALVAGE_POOLS;
  const scale = resolveSecurityScale(securityBand, siteLabel);
  const entries = [
    ...rollIndependentPool(`${seed}::t1`, pools.t1, canTier.t1, scale),
    ...rollIndependentPool(`${seed}::t2`, pools.t2, canTier.t2, scale),
  ];
  for (const miscRoll of RELIC_MISC_ROLLS) {
    entries.push(...rollSinglePick(
      `${seed}::misc::${miscRoll.names[0]}`,
      miscRoll.names,
      miscRoll.probability * scale,
      miscRoll.quantity,
    ));
  }
  return entries;
}

function rollPirateDataLoot(seed, role, siteLabel, securityBand) {
  const faction = resolveFactionFromLabel(siteLabel);
  if (!faction) {
    // Drone-region data sites (BPC economy) and unknown hosts stay on the
    // legacy builder.
    return null;
  }
  const tierRolls = DATA_CAN_ROLLS[stripRoleFamilyPrefix(role)] ||
    // Generic-role legacy cans: mid-tier approximation.
    DATA_CAN_ROLLS.mainframe;
  const scale = resolveSecurityScale(securityBand, siteLabel);
  const materials = FACTION_MATERIAL_TIERS[faction];
  const scaled = (spec) => (spec
    ? Object.freeze({
      probability: Math.min(1, spec.probability * scale),
      quantity: spec.quantity,
    })
    : null);
  const datacoreSpec = scaled(tierRolls.datacore);
  const ancientSpec = scaled(tierRolls.ancient);
  const artifactSpec = scaled(tierRolls.artifact);
  const entries = [
    ...rollIndependentPool(`${seed}::datacore`, FACTION_DATACORE_POOLS[faction], datacoreSpec),
    ...rollSinglePick(
      `${seed}::condenser`,
      FACTION_CONDENSER_POOLS[faction],
      tierRolls.condenser ? tierRolls.condenser.probability * scale : 0,
      tierRolls.condenser ? tierRolls.condenser.quantity : [1, 1],
    ),
    ...rollSinglePick(`${seed}::mat_t1`, [materials.t1], tierRolls.materialT1.probability * scale, tierRolls.materialT1.quantity),
    ...rollSinglePick(`${seed}::mat_t2`, [materials.t2], tierRolls.materialT2.probability * scale, tierRolls.materialT2.quantity),
    ...rollSinglePick(`${seed}::mat_t3`, [materials.t3], tierRolls.materialT3 ? tierRolls.materialT3.probability * scale : 0, tierRolls.materialT3 ? tierRolls.materialT3.quantity : [1, 1]),
    ...rollWeightedPick(`${seed}::decryptor`, DECRYPTOR_WEIGHTS, tierRolls.decryptor.probability, [1, 1]),
    ...rollSinglePick(`${seed}::enc_book`, [FACTION_ENCRYPTION_BOOK[faction]], tierRolls.encryptionBook.probability * scale, [1, 1]),
    ...rollWeightedPick(`${seed}::rig_book`, FACTION_RIGGING_BOOK_WEIGHTS[faction], tierRolls.riggingBook.probability * scale, [1, 1]),
    ...rollSinglePick(`${seed}::high_tech`, HIGH_TECH_PART_POOL, tierRolls.highTech.probability * scale, [1, 1]),
    ...rollSinglePick(`${seed}::calm`, CALM_FILAMENT_POOL, tierRolls.calmFilament.probability * scale, [1, 1]),
    ...rollSinglePick(`${seed}::tranquil`, TRANQUIL_FILAMENT_POOL, tierRolls.tranquilFilament.probability * scale, [1, 1]),
    ...rollWeightedPick(`${seed}::needlejack`, NEEDLEJACK_FILAMENT_WEIGHTS, tierRolls.needlejack.probability, [1, 1]),
    ...rollIndependentPool(`${seed}::ancient`, ANCIENT_RACE_POOLS[FACTION_ANCIENT_POOL_KEY[faction]], ancientSpec),
    ...rollIndependentPool(`${seed}::artifact`, FACTION_ARTIFACT_POOLS[faction], artifactSpec),
  ];
  return entries;
}

function rollSleeperRelicLoot(seed, wormholeClassID) {
  const bandRolls = SLEEPER_RELIC_BAND_ROLLS[resolveSleeperBandIndex(wormholeClassID)];
  return [
    ...rollIndependentPool(`${seed}::ancient`, ANCIENT_SALVAGE_POOL, bandRolls.ancient),
    ...rollIndependentPool(`${seed}::ancient_rare`, ANCIENT_SALVAGE_RARE_POOL, bandRolls.ancientRare),
    ...rollIndependentPool(`${seed}::salvage`, SLEEPER_COMMON_SALVAGE_POOL, bandRolls.salvage),
  ];
}

function rollSleeperDataLoot(seed) {
  return [
    ...rollIndependentPool(`${seed}::datacore`, SLEEPER_DATACORE_POOL, SLEEPER_DATA_ROLLS.datacore),
    ...rollWeightedPick(`${seed}::decryptor`, DECRYPTOR_WEIGHTS, SLEEPER_DATA_ROLLS.decryptor.probability, SLEEPER_DATA_ROLLS.decryptor.quantity),
    ...rollIndependentPool(`${seed}::sleeper_data`, SLEEPER_DATA_POOL, SLEEPER_DATA_ROLLS.sleeperData),
  ];
}

function rollGhostResearchLoot(seed, role, siteLabel, securityBand) {
  const tierRolls = GHOST_TIER_ROLLS[resolveGhostTierFromLabel(siteLabel)];
  const isBonusCan = normalizeLowerText(role).startsWith("bonus");
  const entries = [
    ...rollSinglePick(
      `${seed}::tools`,
      ["Covert Research Tools"],
      tierRolls.tools.probability,
      [
        tierRolls.tools.quantity[0] + (isBonusCan ? 2 : 0),
        tierRolls.tools.quantity[1] + (isBonusCan ? 2 : 0),
      ],
    ),
    ...rollSinglePick(
      `${seed}::villard`,
      ["Shattered Villard Wheel"],
      Math.min(1, tierRolls.villardWheel.probability * (isBonusCan ? 1.5 : 1)),
      tierRolls.villardWheel.quantity,
    ),
  ];
  if (tierRolls.capitalComponent) {
    entries.push(...rollSinglePick(
      `${seed}::capital`,
      GHOST_CAPITAL_COMPONENT_POOL,
      tierRolls.capitalComponent.probability,
      tierRolls.capitalComponent.quantity,
    ));
  }
  const effectiveBand = normalizeLowerText(securityBand) ||
    (resolveGhostTierFromLabel(siteLabel) === "lesser" ? "highsec" : "");
  if (isBonusCan && effectiveBand !== "highsec") {
    // The bonus guarantee applies below high security. Lesser sites supply
    // the high-security fallback when the compiled template omits its band.
    const signaller = resolveTypeRecordByName("Electro-Neural Signaller");
    if (signaller) {
      entries.push(buildEntry(signaller, 1));
    }
  }
  return entries;
}

/**
 * Roll loot entries for a hackable container against the tiered official
 * caliber tables.
 *
 * @param {object} params
 * @param {string} params.profileKey loot profile key (e.g. "pirate_relic_loot")
 * @param {string} params.role container role (e.g. "relic_rubble", "research_cache")
 * @param {string} params.siteLabel host site name (faction/ghost tier source)
 * @param {string} [params.securityBand] "highsec"|"lowsec"|"nullsec"|"wormhole"
 * @param {number} [params.wormholeClassID] host wormhole class 1-6
 * @param {string} params.seed deterministic per-can seed (content key)
 * @returns {Array<{itemType: object, quantity: number, options: null}>|null}
 *   entries, or null when the pair is not covered (caller falls back to the
 *   legacy per-tag builder).
 */
function rollTieredContainerLoot({ profileKey, role, siteLabel, securityBand, wormholeClassID, seed }) {
  const normalizedProfile = normalizeLowerText(profileKey);
  const normalizedRole = normalizeLowerText(role, "container");
  const normalizedSeed = String(seed == null ? "" : seed) || `${normalizedProfile}:${normalizedRole}`;
  let entries = null;
  switch (normalizedProfile) {
    case "pirate_relic_loot":
      entries = rollPirateRelicLoot(normalizedSeed, normalizedRole, siteLabel, securityBand);
      break;
    case "pirate_data_loot":
      entries = rollPirateDataLoot(normalizedSeed, normalizedRole, siteLabel, securityBand);
      break;
    case "sleeper_relic_loot":
    case "talocan_relic_loot":
      entries = rollSleeperRelicLoot(normalizedSeed, wormholeClassID);
      break;
    case "sleeper_data_loot":
      entries = rollSleeperDataLoot(normalizedSeed);
      break;
    case "ghost_research_loot":
      entries = rollGhostResearchLoot(normalizedSeed, normalizedRole, siteLabel, securityBand);
      break;
    default:
      return null;
  }
  if (!Array.isArray(entries)) {
    return null;
  }
  return mergeEntries(entries);
}

module.exports = {
  rollTieredContainerLoot,
  // Test surface: pools and rate tables are part of the official-caliber
  // contract the statistical test pins down.
  COMMON_T1_SALVAGE,
  COMMON_T2_SALVAGE,
  FACTION_SALVAGE_POOLS,
  UNION_SALVAGE_POOLS,
  RELIC_CAN_ROLLS,
  RELIC_MISC_ROLLS,
  FACTION_DATACORE_POOLS,
  DATA_CAN_ROLLS,
  DECRYPTOR_WEIGHTS,
  FACTION_MATERIAL_TIERS,
  FACTION_CONDENSER_POOLS,
  FACTION_ENCRYPTION_BOOK,
  FACTION_RIGGING_BOOK_WEIGHTS,
  HIGH_TECH_PART_POOL,
  CALM_FILAMENT_POOL,
  TRANQUIL_FILAMENT_POOL,
  NEEDLEJACK_FILAMENT_WEIGHTS,
  ANCIENT_RACE_POOLS,
  FACTION_ANCIENT_POOL_KEY,
  FACTION_ARTIFACT_POOLS,
  SLEEPER_DATACORE_POOL,
  SLEEPER_DATA_POOL,
  ANCIENT_SALVAGE_POOL,
  ANCIENT_SALVAGE_RARE_POOL,
  SLEEPER_RELIC_BAND_ROLLS,
  SLEEPER_DATA_ROLLS,
  GHOST_TIER_ROLLS,
  resolveFactionFromLabel,
  resolveSecurityScale,
  resolveGhostTierFromLabel,
  __testing: {
    hashText,
    rollUnit,
    rollQuantity,
    resolveTypeRecordByName,
  },
};
