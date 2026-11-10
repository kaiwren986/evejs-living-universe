"use strict";

// Curated hackable-container content for sites whose compiled templates
// degraded to generic cans.
//
// The client dungeon extract only preserves room containers for part of the
// site catalogue. Where it does not, the compiler falls back to
// family_derived hints ("6 x generic data can") and the site loses its retail
// identity: Sleeper Caches lose their Storage Depots and mixed relic/data
// spread, Detected sites stop reusing the regular sites' can tables, and the
// Legion drone data site loses its F/N/B finale structure. This module
// restores those tables at dungeon-authority load time, after content packs
// merge, from the recorded research (UniWiki Relic and data sites /
// Sleeper Cache / Ghost Sites).
//
// Every rule guards on the template's existing containers being untyped
// (generic roles only), so a future client extract that ships the exact cans
// wins over the curation.

const GENERIC_CONTAINER_ROLES = new Set(["data", "relic", "container", ""]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function templateName(template) {
  return String(template && (template.resolvedName || template.name) || "").trim();
}

function listContainerSpecs(template) {
  const populationHints = normalizeObject(template && template.populationHints);
  return Array.isArray(populationHints.containers) ? populationHints.containers : [];
}

// True when no existing spec carries a typed (non-generic) role: the curation
// is allowed to replace the container table.
function hasOnlyGenericContainerSpecs(template) {
  const specs = listContainerSpecs(template);
  if (specs.length <= 0) {
    return false;
  }
  return specs.every((spec) => {
    if (!GENERIC_CONTAINER_ROLES.has(String(spec && spec.role || "").trim().toLowerCase())) {
      return false;
    }
    // Explicit client or content-pack types take precedence over approximation.
    return !(toInt(spec && spec.typeID, 0) > 0) &&
      !(Array.isArray(spec && spec.typeNameCandidates) && spec.typeNameCandidates.length > 0);
  });
}

function buildCuratedSpec(fields) {
  return {
    role: fields.role,
    count: Math.max(1, toInt(fields.count, 1)),
    analyzer: fields.analyzer || "data",
    typeNameCandidates: Array.isArray(fields.typeNameCandidates) ? [...fields.typeNameCandidates] : [],
    label: fields.label || null,
    bonus: fields.bonus === true,
    persistsAfterResponse: fields.persistsAfterResponse === true,
    failureExplodes: fields.failureExplodes === true,
    failureNeverDestroys: fields.failureNeverDestroys === true,
    failureLocksOut: fields.failureLocksOut === true,
    completesSiteOnHack: fields.completesSiteOnHack === true,
    trigger: fields.trigger || null,
    lootProfile: fields.lootProfile || null,
    lootTags: Array.isArray(fields.lootTags) ? [...fields.lootTags] : [],
    hackingDifficulty: fields.hackingDifficulty != null ? fields.hackingDifficulty : null,
  };
}

// ---------------------------------------------------------------------------
// Sleeper Caches (Limited / Standard / Superior).
//
// UniWiki: the three caches need both analyzers, their cans are the published
// exception to the two-failure destroy rule ("Storage Depot"), and a failure
// answers with a defensive response (toxic gas / turrets - the wave below
// covers the turret half, the sleeper_toxic_cloud hazard the gas half). The
// Standard cache's internal structure (3 loot cans + 1 remote defense grid
// switch + 3 coordinate cans) comes from the eve-search community archive
// recorded in the research findings; Limited / Superior cans are the
// documented approximation around it. The hackingDifficulty stamping (3/3/4)
// has no published per-tier table. 2026-09-16 ruling closed this as "external
// evidence exhausted"; REOPENED 2026-09-17: the Formosa (TW community) guide
// reads Limited/Standard caches as "mostly red cores" (= Hard/4), conflicting
// with tier 3 on the Limited/Standard main cans (Superior agrees at 4; the
// non-red minority is plausibly the Storage Depot). Single unstratified
// community source - not enough to rewrite on its own; verdict passes to
// first-hand observation (research archive findings_can_difficulty_evidence.md,
// spec §9.3 snapshot checklist).
// ---------------------------------------------------------------------------

const SLEEPER_CACHE_LOOKS = {
  storage: ["Preserved Sleeper Depot", "Ruined Sleeper Depot"],
  data: [
    "Malfunctioning Sleeper Databank",
    "Ejected Sleeper Databank",
    "Deformed Sleeper Databank",
    "Obsolete Sleeper Databank",
    "Broken Sleeper Databank",
  ],
  relic: [
    "Derelict Talocan Frigate",
    "Deserted Talocan Cruiser",
  ],
};

function buildSleeperCacheContainers(tier) {
  const lootData = ["datacore", "decryptor"];
  const lootRelic = ["ancient_salvage", "salvage"];
  switch (tier) {
    case "limited":
      return [
        buildCuratedSpec({
          role: "sleeper_cache_storage",
          analyzer: "relic",
          count: 1,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.storage,
          label: "Storage Depot",
          persistsAfterResponse: true,
          failureNeverDestroys: true,
          trigger: "hack_failure",
          lootProfile: "sleeper_relic_loot",
          lootTags: lootRelic,
          hackingDifficulty: 3,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_data",
          analyzer: "data",
          count: 2,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.data,
          label: "Sleeper Databank",
          trigger: "hack_failure",
          lootProfile: "generic_data_loot",
          lootTags: lootData,
          hackingDifficulty: 3,
        }),
      ];
    case "standard":
      return [
        buildCuratedSpec({
          role: "sleeper_cache_storage",
          analyzer: "relic",
          count: 1,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.storage,
          label: "Storage Depot",
          persistsAfterResponse: true,
          failureNeverDestroys: true,
          trigger: "hack_failure",
          lootProfile: "sleeper_relic_loot",
          lootTags: lootRelic,
          hackingDifficulty: 3,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_data",
          analyzer: "data",
          count: 2,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.data,
          label: "Sleeper Databank",
          trigger: "hack_failure",
          lootProfile: "generic_data_loot",
          lootTags: lootData,
          hackingDifficulty: 3,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_relic",
          analyzer: "relic",
          count: 1,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.relic,
          label: "Talocan Wreck",
          trigger: "hack_failure",
          lootProfile: "sleeper_relic_loot",
          lootTags: lootRelic,
          hackingDifficulty: 3,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_defense_grid",
          analyzer: "data",
          count: 1,
          typeNameCandidates: ["Remote Defense Grid Unit"],
          label: "Remote Defense Grid Switch",
          trigger: "hack_failure",
          hackingDifficulty: 2,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_coordinate",
          analyzer: "data",
          count: 3,
          typeNameCandidates: ["Coordinate Plotting Device"],
          label: "Coordinate Datum",
          hackingDifficulty: 2,
        }),
      ];
    case "superior":
      return [
        buildCuratedSpec({
          role: "sleeper_cache_storage",
          analyzer: "relic",
          count: 1,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.storage,
          label: "Storage Depot",
          persistsAfterResponse: true,
          failureNeverDestroys: true,
          trigger: "hack_failure",
          lootProfile: "sleeper_relic_loot",
          lootTags: [...lootRelic, "ancient_salvage_rare"],
          hackingDifficulty: 4,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_data",
          analyzer: "data",
          count: 2,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.data,
          label: "Sleeper Databank",
          trigger: "hack_failure",
          lootProfile: "generic_data_loot",
          lootTags: lootData,
          hackingDifficulty: 4,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_relic",
          analyzer: "relic",
          count: 2,
          typeNameCandidates: SLEEPER_CACHE_LOOKS.relic,
          label: "Talocan Wreck",
          trigger: "hack_failure",
          lootProfile: "sleeper_relic_loot",
          lootTags: [...lootRelic, "ancient_salvage_rare"],
          hackingDifficulty: 4,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_defense_grid",
          analyzer: "data",
          count: 1,
          typeNameCandidates: ["Remote Defense Grid Unit"],
          label: "Remote Defense Grid Switch",
          trigger: "hack_failure",
          hackingDifficulty: 3,
        }),
        buildCuratedSpec({
          role: "sleeper_cache_coordinate",
          analyzer: "data",
          count: 3,
          typeNameCandidates: ["Coordinate Plotting Device"],
          label: "Coordinate Datum",
          hackingDifficulty: 3,
        }),
      ];
    default:
      return null;
  }
}

function buildSleeperCacheEncounterPlan(tier) {
  const amount = tier === "superior" ? 4 : tier === "standard" ? 3 : 2;
  return {
    supported: true,
    key: "cache_defense_response",
    label: "Cache Defense Response",
    spawnQuery: "sleepers_deadspace",
    amount,
    trigger: "hack_failure",
    notes: ["Curated: UniWiki Sleeper Cache failure response, approximated as a Sleeper wave."],
  };
}

// Sleeper Cache failure gas (UniWiki Hacking failure table: "once, a Sleeper
// Cache will release a deadly toxic gas, activate turrets or put up other
// obstacle"). The wave above covers the turret/obstacle half; this spec arms
// the gas half - on hack_failure the site service materializes a toxic cloud
// at the failing can that ticks thermal damage until it dissipates. No
// published damage/range/duration table exists, so the per-tier numbers are
// an UNVERIFIED community calibration held by the site service (spec
// Limitations); this spec only declares the tier.
function buildSleeperCacheToxicCloudHazard(tier) {
  return {
    kind: "sleeper_toxic_cloud",
    label: "Toxic Gas Cloud",
    tier,
  };
}

const SLEEPER_CACHE_TIERS_BY_NAME = Object.freeze({
  "Limited Sleeper Cache": "limited",
  "Standard Sleeper Cache": "standard",
  "Superior Sleeper Cache": "superior",
});

// ---------------------------------------------------------------------------
// Detected sites (2025 Legion exploration-detector supply).
//
// UniWiki: a Detected site reuses the regular site's name and can table
// ("Detected" + regular pirate site name, cans unchanged). A Detected relic
// site completes on the FIRST hacked can; the drone data site's three cans
// are labeled F / N / B, where the F can triggers site completion and any
// can's failure spawns drone rats (the two-failure explosion stays the
// default rule). Classic Abandoned Research Complex sites (with or without
// the Detected prefix) keep their extracted 2+1 tables and are NOT touched.
// ---------------------------------------------------------------------------

const DETECTED_NAME_PATTERN = /^Detected\s+(.+)$/;

function applyDetectedInheritance(template, templatesByName) {
  const match = DETECTED_NAME_PATTERN.exec(templateName(template));
  if (!match) {
    return null;
  }
  const baseTemplate = templatesByName.get(match[1]);
  // Same guard direction as every other rule in this module (see the header:
  // "every rule guards on the template's existing containers being untyped"):
  // ONLY a Detected template whose own table degraded to generic roles needs
  // the inheritance - one carrying a real extracted table keeps it. Until
  // 2026-09-26 this condition was inverted, so generic Detected sites never
  // inherited (and exact ones would have had theirs cloned over).
  if (!baseTemplate || !hasOnlyGenericContainerSpecs(template)) {
    return null;
  }
  // Inheriting a base whose own table degraded to generic roles just clones
  // the degradation - and can silently replace this template's own (count
  // hint) specs with the base's. UniWiki's rule is "reuse the regular site's
  // can table"; a base with no real can table has nothing to reuse, so the
  // Detected site keeps its own hints and falls through to the other rules.
  if (hasOnlyGenericContainerSpecs(baseTemplate)) {
    return null;
  }
  const baseContainers = listContainerSpecs(baseTemplate);
  if (baseContainers.length <= 0) {
    return null;
  }
  const isRelicSite = String(template.siteFamily || "").trim().toLowerCase() === "relic";
  const containers = clone(baseContainers).map((spec) => ({
    ...spec,
    // Detected relic sites complete on the first hacked can.
    ...(isRelicSite ? { completesSiteOnHack: true } : {}),
  }));
  return {
    containers,
    rules: [
      `detected_inherit:${match[1]}`,
      ...(isRelicSite ? ["detected_relic_first_can_completes"] : []),
    ],
  };
}

function buildDetectedDroneDataContainers() {
  // The F/N/B labels are the published UniWiki naming; no published can type
  // exists for them ("Research and Development Laboratories" and "High
  // Security Containment Facility" are scene LCO names, not invTypes), so all
  // three wear the Rogue Drone can type while keeping their labels.
  return [
    buildCuratedSpec({
      role: "detected_drone_finale",
      analyzer: "data",
      count: 1,
      typeNameCandidates: ["Rogue Drone Container"],
      label: "Rogue Drone Data Repository (Type F)",
      completesSiteOnHack: true,
      trigger: "hack_failure",
      hackingDifficulty: 2,
    }),
    buildCuratedSpec({
      role: "detected_drone_loot",
      analyzer: "data",
      count: 1,
      typeNameCandidates: ["Rogue Drone Container"],
      label: "Rogue Drone Data Repository (Type N)",
      trigger: "hack_failure",
      lootProfile: "generic_data_loot",
      lootTags: ["datacore", "decryptor"],
      hackingDifficulty: 3,
    }),
    buildCuratedSpec({
      role: "detected_drone_bonus",
      analyzer: "data",
      count: 1,
      typeNameCandidates: ["Rogue Drone Container"],
      label: "Rogue Drone Data Repository (Type B)",
      bonus: true,
      trigger: "hack_failure",
      lootProfile: "generic_data_loot",
      lootTags: ["datacore", "data_material"],
      hackingDifficulty: 3,
    }),
  ];
}

const DETECTED_DRONE_DATA_SITE_NAMES = Object.freeze(new Set([
  "Detected Rogue Drone Neural Processing Hub",
]));

// ---------------------------------------------------------------------------
// Legion sites with no regular-site base: the pirate Archive Hubs (data) and
// Colonial Remnants (relic), plus the drone Hive Remnants (relic). No
// published can tables exist; the tables below follow the nullsec can-tier
// rules (no Info Shard / Debris, Databank / Ruins legal) with faction-prefixed
// retail naming. Documented approximation.
// ---------------------------------------------------------------------------

const FACTION_PREFIXES = Object.freeze([
  "Angel",
  "Blood Raider",
  "Guristas",
  "Sansha",
  "Serpentis",
]);

// The pirate can families in invTypes drop the "Raider" - the Blood cans are
// "Blood Com Tower" (33242), not "Blood Raider Com Tower". Curated tables must
// use these prefixes or every name lookup misses and the can degrades to the
// Cargo Container fallback.
const CAN_NAME_PREFIX_BY_FACTION = Object.freeze({
  "Angel": "Angel",
  "Blood Raider": "Blood",
  "Guristas": "Guristas",
  "Sansha": "Sansha",
  "Serpentis": "Serpentis",
});

function resolveCanNamePrefix(factionPrefix) {
  return CAN_NAME_PREFIX_BY_FACTION[factionPrefix] || factionPrefix;
}

function resolveFactionPrefix(templateName) {
  for (const prefix of FACTION_PREFIXES) {
    if (templateName.includes(` ${prefix} `)) {
      return prefix;
    }
  }
  return "";
}

function buildArchiveHubContainers(factionPrefix) {
  const canPrefix = resolveCanNamePrefix(factionPrefix);
  return [
    buildCuratedSpec({
      role: "com_tower",
      analyzer: "data",
      count: 2,
      typeNameCandidates: [`${canPrefix} Com Tower`],
      lootProfile: "generic_data_loot",
      lootTags: ["datacore", "decryptor"],
    }),
    buildCuratedSpec({
      role: "mainframe",
      analyzer: "data",
      count: 2,
      typeNameCandidates: [`${canPrefix} Mainframe`],
      lootProfile: "generic_data_loot",
      lootTags: ["datacore", "decryptor"],
    }),
    buildCuratedSpec({
      role: "databank",
      analyzer: "data",
      count: 1,
      typeNameCandidates: [`${canPrefix} Databank`],
      lootProfile: "generic_data_loot",
      lootTags: ["datacore", "data_material"],
    }),
  ];
}

function buildColonialRemnantsContainers(factionPrefix) {
  const canPrefix = resolveCanNamePrefix(factionPrefix);
  return [
    buildCuratedSpec({
      role: "rubble",
      analyzer: "relic",
      count: 1,
      typeNameCandidates: [`${canPrefix} Rubble`],
      lootProfile: "generic_relic_loot",
      lootTags: ["salvage", "relic_component"],
      completesSiteOnHack: true,
    }),
    buildCuratedSpec({
      role: "remains",
      analyzer: "relic",
      count: 2,
      typeNameCandidates: [`${canPrefix} Remains`],
      lootProfile: "generic_relic_loot",
      lootTags: ["salvage", "relic_component"],
      completesSiteOnHack: true,
    }),
    buildCuratedSpec({
      role: "ruins",
      analyzer: "relic",
      count: 2,
      typeNameCandidates: [`${canPrefix} Ruins`],
      lootProfile: "generic_relic_loot",
      lootTags: ["salvage", "relic_component"],
      completesSiteOnHack: true,
    }),
  ];
}

// UniWiki: drone relic sites keep the Ruined naming with no Debris can, and
// the mid tier is "(Rogue Drone) Ship Remains".
function buildHiveRemnantsContainers() {
  return [
    buildCuratedSpec({
      role: "rubble",
      analyzer: "relic",
      count: 2,
      typeNameCandidates: ["Rogue Drone Container"],
      lootProfile: "generic_relic_loot",
      lootTags: ["salvage", "relic_component"],
      completesSiteOnHack: true,
    }),
    buildCuratedSpec({
      role: "remains",
      analyzer: "relic",
      count: 2,
      typeNameCandidates: ["Rogue Drone Ship Remains"],
      lootProfile: "generic_relic_loot",
      lootTags: ["salvage", "relic_component"],
      completesSiteOnHack: true,
    }),
    buildCuratedSpec({
      role: "ruins",
      analyzer: "relic",
      count: 2,
      typeNameCandidates: ["Rogue Drone Container"],
      lootProfile: "generic_relic_loot",
      lootTags: ["salvage", "relic_component"],
      completesSiteOnHack: true,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Ghost sites (Covert Research Facility content pack).
//
// The pack ships the 20 tier x faction sites with exact caches but leaves
// hackingDifficulty null on every spec; the analyzer would then open the
// easiest board for a Superior wormhole cache. No published per-tier minigame
// table exists, so the tiers step green -> yellow -> red with site risk
// (Lesser highsec through Superior wormhole). 2026-09-16 ruling: external
// evidence on these bands is EXHAUSTED (UniWiki silent, no community table,
// no snapshot data in hand) - the ladder below stands as the community-
// caliber approximation and the verdict passes to a stratified hack-difficulty
// snapshot / first-hand experiment (spec §9.3's 377-snapshot checklist), same
// as the wormhole-class and Sleeper-Cache banding in the site service.
// REOPENED 2026-09-17: the Formosa (TW) guide's ghost-site line "except
// Superior, mostly green/yellow cores" is an exclusion phrasing that
// CORROBORATES superior=4 (and is compatible with 2/3/3 below) - see
// findings_can_difficulty_evidence.md before touching this ladder.
// ---------------------------------------------------------------------------

const GHOST_TIER_HACKING_DIFFICULTY = Object.freeze({
  lesser: 2,
  standard: 3,
  improved: 3,
  superior: 4,
});

function resolveGhostTierDifficulty(name) {
  const normalized = String(name || "").trim().toLowerCase();
  for (const [tier, difficulty] of Object.entries(GHOST_TIER_HACKING_DIFFICULTY)) {
    if (normalized.startsWith(tier)) {
      return difficulty;
    }
  }
  return null;
}

function applyGhostTierDifficulty(template) {
  const name = templateName(template);
  if (!/covert research facility/i.test(name)) {
    return null;
  }
  const difficulty = resolveGhostTierDifficulty(name);
  if (!difficulty) {
    return null;
  }
  const specs = listContainerSpecs(template);
  if (specs.length <= 0) {
    return null;
  }
  let stamped = 0;
  const containers = specs.map((spec) => {
    if (spec && spec.hackingDifficulty == null) {
      stamped += 1;
      return { ...spec, hackingDifficulty: difficulty };
    }
    return spec;
  });
  if (stamped <= 0) {
    return null;
  }
  return { containers, rules: [`ghost_tier_difficulty:${difficulty}`] };
}

// ---------------------------------------------------------------------------
// AEGIS / Observatory edge content (the spec's difficulty-system fringe, §8.1
// / §8.3).
//
// The engine's Hardest tier (5) had no carrier anywhere: the AEGIS Capital
// Ship Security Facility compiles down to a family-derived generic table that
// even stamps a wrong authored "easy" difficulty. UniWiki: Hardest hacking
// lives in Upwell structures / AEGIS sites, carried by cans like the AEGIS
// Encrypted Key Storage, and one storage failure answers with a hostile
// response fleet.
//
// The Observatory Infiltration relic site (Pochven) compiles to generic cans
// too; its published failure penalty is the one-failure LOCKOUT - the can
// seals itself, no second attempt, no destruction.
// ---------------------------------------------------------------------------

function buildAegisKeyStorageContainers() {
  return [
    buildCuratedSpec({
      role: "aegis_key_storage",
      analyzer: "data",
      count: 4,
      typeNameCandidates: ["AEGIS Encrypted Key Storage"],
      label: "AEGIS Encrypted Key Storage",
      trigger: "hack_failure",
      lootProfile: "generic_data_loot",
      lootTags: ["datacore", "decryptor"],
      hackingDifficulty: 5,
    }),
  ];
}

function buildObservatoryInfiltrationContainers() {
  return [
    buildCuratedSpec({
      role: "observatory_vault",
      analyzer: "relic",
      count: 3,
      label: "Observatory Vault",
      failureLocksOut: true,
      lootProfile: "generic_relic_loot",
      lootTags: ["salvage", "relic_component"],
      hackingDifficulty: 4,
    }),
  ];
}

const AEGIS_HARDEST_SITE_NAMES = Object.freeze(new Set([
  "AEGIS Capital Ship Security Facility",
]));

// Combat-family layouts whose can-type environment props are deliberate
// hacking cans. Env-can promotion is gated to the data/relic families (a
// warehouse prop in a random combat or mission layout must stay scenery);
// these curated sites are the explicit opt-in that keeps their props hackable.
const COMBAT_HACKING_SITE_NAMES = Object.freeze(new Set([
  "AEGIS Secure Capital Construction Forges",
  "AEGIS Capital Ship Security Facility",
]));

const AEGIS_FORGE_SOURCE_TEMPLATE_ID = "client-dungeon:9065";
const AEGIS_FORGE_FALLBACK_TEMPLATE_ID = "eve-university:AEGIS_Secure_Capital_Construction_Forges";

function aegisForgeOrdinal(prop) {
  const typeOrdinal = toInt(prop && prop.typeID, 0) - 60388;
  if (typeOrdinal >= 1 && typeOrdinal <= 4) return typeOrdinal;
  for (const name of Array.isArray(prop && prop.typeNameCandidates) ? prop.typeNameCandidates : []) {
    const match = /^AEGIS No\. ([1-4]) Capital Construction Forge$/.exec(String(name));
    if (match) return Number(match[1]);
  }
  return 0;
}

function applyAegisForgeEnvironmentFallback(templateID, template, templatesByID) {
  if (templateID !== AEGIS_FORGE_FALLBACK_TEMPLATE_ID ||
      templateName(template) !== "AEGIS Secure Capital Construction Forges" ||
      listContainerSpecs(template).length > 0) {
    return null;
  }
  const hints = normalizeObject(template.populationHints);
  const environmentProps = Array.isArray(hints.environmentProps) ? hints.environmentProps : [];
  const structureProfiles = Array.isArray(template.siteSceneProfile && template.siteSceneProfile.structureProfiles)
    ? template.siteSceneProfile.structureProfiles : [];
  // Only repair the empty community fallback. Any authored type, exact layout
  // or forge definition already owns its objects and must remain intact.
  if ([...environmentProps, ...structureProfiles].some(prop =>
    toInt(prop && prop.typeID, 0) > 0 || prop && prop.exact === true || aegisForgeOrdinal(prop) > 0)) {
    return null;
  }
  const source = templatesByID[AEGIS_FORGE_SOURCE_TEMPLATE_ID];
  if (templateName(source) !== templateName(template)) return null;
  const sourceProps = source && source.populationHints && source.populationHints.environmentProps;
  const forgesByOrdinal = new Map();
  for (const prop of Array.isArray(sourceProps) ? sourceProps : []) {
    const ordinal = aegisForgeOrdinal(prop);
    if (ordinal && !forgesByOrdinal.has(ordinal)) forgesByOrdinal.set(ordinal, prop);
  }
  if (forgesByOrdinal.size !== 4) return null;
  return {
    ...hints,
    environmentProps: [...clone(environmentProps), ...[1, 2, 3, 4].map(ordinal => clone(forgesByOrdinal.get(ordinal)))],
    curatedHackableEnvironment: {
      applied: true,
      sourceTemplateID: AEGIS_FORGE_SOURCE_TEMPLATE_ID,
      sourceDungeonID: 9065,
      originalEnvironmentProps: clone(environmentProps),
      rules: ["aegis_forges_reuse_native_environment"],
    },
  };
}

const OBSERVATORY_LOCKOUT_SITE_NAMES = Object.freeze(new Set([
  "Observatory Infiltration",
]));

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function applyCuratedHackableContent(payload = {}) {
  const templatesByID = normalizeObject(payload.templatesByID);
  const templatesByName = new Map();
  for (const template of Object.values(templatesByID)) {
    const name = templateName(template);
    if (name && !templatesByName.has(name)) {
      templatesByName.set(name, template);
    }
  }

  const patchedTemplates = {};
  const appliedRules = {};
  for (const [templateID, template] of Object.entries(templatesByID)) {
    if (!template || typeof template !== "object") {
      continue;
    }
    const name = templateName(template);
    const family = String(template.siteFamily || "").trim().toLowerCase();
    // A can-shaped prop in combat or mission content remains scenery. The
    // named AEGIS layouts are the sole explicit combat-family exception.
    const ghostTierOnly = family === "ghost" && /covert research facility/i.test(name);
    if (!["data", "relic"].includes(family) && !COMBAT_HACKING_SITE_NAMES.has(name) && !ghostTierOnly) {
      continue;
    }
    let patch = null;

    const sleeperCacheTier = SLEEPER_CACHE_TIERS_BY_NAME[name];
    if (sleeperCacheTier && hasOnlyGenericContainerSpecs(template)) {
      patch = {
        containers: buildSleeperCacheContainers(sleeperCacheTier),
        encounters: [buildSleeperCacheEncounterPlan(sleeperCacheTier)],
        hazards: [buildSleeperCacheToxicCloudHazard(sleeperCacheTier)],
        rules: [`sleeper_cache_cans:${sleeperCacheTier}`, `sleeper_cache_toxic_cloud:${sleeperCacheTier}`],
      };
    }
    if (!patch && DETECTED_DRONE_DATA_SITE_NAMES.has(name) && hasOnlyGenericContainerSpecs(template)) {
      patch = {
        containers: buildDetectedDroneDataContainers(),
        encounters: [{
          supported: true,
          key: "drone_response",
          label: "Drone Response",
          spawnQuery: "npc_hostiles",
          amount: 3,
          trigger: "hack_failure",
          notes: ["Curated: UniWiki Detected drone data site - any can failure spawns drone rats."],
        }],
        rules: ["detected_drone_f_n_b"],
      };
    }
    if (!patch && /Archive Hub$/i.test(name) && String(template.siteFamily || "") === "data") {
      const factionPrefix = resolveFactionPrefix(name);
      if (factionPrefix && hasOnlyGenericContainerSpecs(template)) {
        patch = {
          containers: buildArchiveHubContainers(factionPrefix),
          rules: [`archive_hub_cans:${factionPrefix}`],
        };
      }
    }
    if (!patch && /Colonial Remnants$/i.test(name) && String(template.siteFamily || "") === "relic") {
      const factionPrefix = resolveFactionPrefix(name);
      if (factionPrefix && hasOnlyGenericContainerSpecs(template)) {
        patch = {
          containers: buildColonialRemnantsContainers(factionPrefix),
          rules: [`colonial_remnants_cans:${factionPrefix}`, "detected_relic_first_can_completes"],
        };
      }
    }
    if (!patch && name === "Detected Ruined Rogue Drone Hive Remnants" && String(template.siteFamily || "") === "relic") {
      if (hasOnlyGenericContainerSpecs(template)) {
        patch = {
          containers: buildHiveRemnantsContainers(),
          rules: ["hive_remnants_cans", "detected_relic_first_can_completes"],
        };
      }
    }
    if (!patch && AEGIS_HARDEST_SITE_NAMES.has(name)) {
      if (hasOnlyGenericContainerSpecs(template)) {
        patch = {
          containers: buildAegisKeyStorageContainers(),
          encounters: [{
            supported: true,
            key: "aegis_response_fleet",
            label: "AEGIS Response Fleet",
            spawnQuery: "npc_hostiles",
            amount: 3,
            trigger: "hack_failure",
            notes: ["Curated: UniWiki failure table - one AEGIS Encrypted Key Storage failure answers with a hostile response fleet."],
          }],
          rules: ["aegis_hardest_key_storage"],
        };
      }
    }
    if (!patch && OBSERVATORY_LOCKOUT_SITE_NAMES.has(name) && String(template.siteFamily || "") === "relic") {
      if (hasOnlyGenericContainerSpecs(template)) {
        patch = {
          containers: buildObservatoryInfiltrationContainers(),
          rules: ["observatory_one_failure_lockout"],
        };
      }
    }
    if (!patch) {
      patch = applyDetectedInheritance(template, templatesByName);
    }
    if (!patch) {
      patch = applyGhostTierDifficulty(template);
    }

    if (!patch || !Array.isArray(patch.containers)) {
      continue;
    }
    const populationHints = normalizeObject(template.populationHints);
    const nextPopulationHints = {
      ...populationHints,
      containers: clone(patch.containers),
      ...(Array.isArray(patch.encounters)
        ? { encounters: [...(Array.isArray(populationHints.encounters) ? populationHints.encounters : []), ...patch.encounters] }
        : {}),
      ...(Array.isArray(patch.hazards)
        ? { hazards: [...(Array.isArray(populationHints.hazards) ? populationHints.hazards : []), ...clone(patch.hazards)] }
        : {}),
      curatedHackableContent: {
        applied: true,
        rules: patch.rules || [],
        originalPopulationHints: clone(populationHints),
        sourceTemplateID: templateID,
        sourceDungeonID: template.sourceDungeonID == null ? null : toInt(template.sourceDungeonID),
      },
    };
    patchedTemplates[templateID] = {
      ...template,
      populationHints: nextPopulationHints,
    };
    appliedRules[templateID] = {
      name,
      rules: patch.rules || [],
    };
  }

  // Flag the curated combat hacking sites (COMBAT_HACKING_SITE_NAMES) so the
  // env-promotion family gate can let exactly these layouts through.
  for (const [templateID, template] of Object.entries(templatesByID)) {
    const name = template && templateName(template);
    if (name && COMBAT_HACKING_SITE_NAMES.has(name)) {
      const existing = patchedTemplates[templateID] || template;
      const fallbackHints = applyAegisForgeEnvironmentFallback(templateID, existing, templatesByID);
      patchedTemplates[templateID] = {
        ...existing,
        ...(fallbackHints ? { populationHints: fallbackHints } : {}),
        hackingCombatSite: true,
      };
      if (fallbackHints) {
        appliedRules[templateID] = {
          name,
          rules: fallbackHints.curatedHackableEnvironment.rules,
          sourceTemplateID: AEGIS_FORGE_SOURCE_TEMPLATE_ID,
        };
      }
    }
  }

  if (Object.keys(patchedTemplates).length <= 0) {
    return payload;
  }

  return {
    ...payload,
    counts: {
      ...normalizeObject(payload.counts),
      curatedHackableContainerTemplateCount: Object.keys(patchedTemplates).length,
    },
    meta: {
      ...normalizeObject(payload.meta),
      curatedHackableContent: {
        appliedRules,
      },
    },
    templatesByID: {
      ...templatesByID,
      ...patchedTemplates,
    },
  };
}

module.exports = {
  AEGIS_HARDEST_SITE_NAMES,
  DETECTED_DRONE_DATA_SITE_NAMES,
  GHOST_TIER_HACKING_DIFFICULTY,
  OBSERVATORY_LOCKOUT_SITE_NAMES,
  SLEEPER_CACHE_TIERS_BY_NAME,
  applyCuratedHackableContent,
};
