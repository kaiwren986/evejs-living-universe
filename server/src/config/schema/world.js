"use strict";

module.exports = [
  {
    "key": "voidReplayEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_VOID_REPLAY_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": "Enables admission to the historical Ruined Electrical relic pocket.",
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "incursionOrganicHighSecEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_INCURSION_ORGANIC_HIGH_SEC_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Starts automatic Sansha focus scheduling in high security on world startup.",
      "Requires both approved Incursion content packs. Disabling it pauses new focus creation while existing tales finish."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "incursionOrganicLowSecEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_INCURSION_ORGANIC_LOW_SEC_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Starts automatic Sansha focus scheduling in low security on world startup.",
      "Requires both approved Incursion content packs. Disabling it pauses new low-security focuses while existing tales finish."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "incursionOrganicNullSecEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_INCURSION_ORGANIC_NULL_SEC_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Starts automatic Sansha focus scheduling in null security on world startup.",
      "Requires both approved Incursion content packs. Disabling it pauses new null-security focuses while existing tales finish."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "wormholesEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_WORMHOLES_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables the live wormhole runtime, wormholeMgr jump service, and automatic static wormhole seeding for eligible systems.",
      "Disable only when isolating unrelated space-runtime regressions."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "wormholeLifetimeScale",
    "defaultValue": 1,
    "envVar": "EVEJS_WORMHOLE_LIFETIME_SCALE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Global multiplier applied to authoritative wormhole lifetimes after static data is loaded.",
      "1 = retail lifetime, 0.5 = half lifetime, 2 = double lifetime."
    ],
    "validValues": "Positive number greater than 0.",
    "minValue": 0,
    "exclusiveMinValue": true,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "wormholeStaticRespawnDelaySeconds",
    "defaultValue": 60,
    "envVar": "EVEJS_WORMHOLE_STATIC_RESPAWN_DELAY_SECONDS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Delay before a collapsed static wormhole slot reseeds a fresh connection.",
      "Use 60 for quick dev parity iteration; increase only when calibrating live collapse/respawn behavior."
    ],
    "validValues": "Non-negative number of seconds.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "wormholeWanderingCountScale",
    "defaultValue": 1,
    "envVar": "EVEJS_WORMHOLE_WANDERING_COUNT_SCALE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Global multiplier applied to repo-owned wandering wormhole profile counts after authority is loaded.",
      "1 = authored wandering volume, 0 = no automatic wandering connections, 2 = double authored volume."
    ],
    "validValues": "Non-negative number.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "wormholeWanderingRespawnDelaySeconds",
    "defaultValue": 60,
    "envVar": "EVEJS_WORMHOLE_WANDERING_RESPAWN_DELAY_SECONDS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Delay before a collapsed wandering wormhole profile is eligible to replenish its global active count.",
      "Use 60 for quick parity iteration; raise only when calibrating live wandering replacement cadence."
    ],
    "validValues": "Non-negative number of seconds.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "wormholeMaintenanceIntervalMs",
    "defaultValue": 1000,
    "envVar": "EVEJS_WORMHOLE_MAINTENANCE_INTERVAL_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Delay between completed bounded wormhole lifecycle passes."
    ],
    "validValues": "Integer milliseconds greater than or equal to 50.",
    "minValue": 50,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "wormholeMaintenanceMaxItemsPerSlice",
    "defaultValue": 24,
    "envVar": "EVEJS_WORMHOLE_MAINTENANCE_MAX_ITEMS_PER_SLICE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum wormhole lifecycle records processed before yielding to the simulation loop."
    ],
    "validValues": "Positive integer.",
    "minValue": 1,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "wormholeMaintenanceMaxSliceMs",
    "defaultValue": 8,
    "envVar": "EVEJS_WORMHOLE_MAINTENANCE_MAX_SLICE_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum elapsed milliseconds targeted by one wormhole lifecycle slice before yielding."
    ],
    "validValues": "Positive number of milliseconds.",
    "minValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "spaceDebrisLifetimeMs",
    "defaultValue": 7200000,
    "envVar": "EVEJS_SPACE_DEBRIS_LIFETIME_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Lifetime of normal player, NPC, and structure wreck/debris entities before cleanup."
    ],
    "validValues": "Integer duration in milliseconds. 7200000 = 2 hours.",
    "minValue": 60000,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "randomSeed",
    "defaultValue": "",
    "envVar": "EVEJS_RANDOM_SEED",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Seed for the server's shared random source (server/src/common/random.js), so a run's random draws can be repeated.",
      "Blank seeds it from the clock at startup, which is normal play. Any other text or number gives the same draws in the same order every run."
    ],
    "validValues": "Blank, or any text or number.",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "tidiAutoscaler",
    "defaultValue": true,
    "envVar": "EVEJS_TIDI_AUTOSCALER",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables automatic tick-lateness-based time dilation scaling."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "systemLoadingMode",
    "defaultValue": "lazy",
    "envVar": "EVEJS_SYSTEM_LOADING_MODE",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Selects which solar-system scenes are created during server startup and whether stargates may load destinations on demand.",
      "Startup preloading does not prevent later empty-scene collection; use alwaysOnSolarSystemIDs for systems that must stay loaded."
    ],
    "validValues": "lazy, highSecurity, all, or onDemandGates.",
    "allowedValues": [
      "lazy",
      "highSecurity",
      "all",
      "onDemandGates"
    ],
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "alwaysOnSolarSystemIDs",
    "defaultValue": [
      30000142,
      30000145,
      30100032
    ],
    "envVar": "EVEJS_ALWAYS_ON_SOLAR_SYSTEM_IDS",
    "envType": "json",
    "valueType": "json",
    "description": [
      "Solar systems whose scenes are preloaded at startup and kept loaded when no players remain.",
      "Use an empty array to allow every empty solar-system scene to be reclaimed.",
      "Ordinary empty scenes use a short grace period; scenes with capsuleer-owned wrecks or anchored space objects are retained for two hours."
    ],
    "validValues": "JSON array of positive integer solar-system IDs, such as [30000142, 30000145].",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "defaultStargateBillboardsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_DEFAULT_STARGATE_BILLBOARDS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Turns on generated default billboard props beside empire-space stargates (`0.1+`).",
      "These use PublicEveJS bubble-scoped static visibility, matching the existing generated CONCORD scene style."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "defaultEmpireSentryGunsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_DEFAULT_EMPIRE_SENTRY_GUNS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Turns on generated default sentry-gun props at empire-space stargates and NPC stations (`0.1+`).",
      "This is visual parity scaffolding for gate/station sentries; it does not replace Crimewatch CONCORD response."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "universeSiteCountDefault",
    "defaultValue": 1,
    "envVar": "EVEJS_UNIVERSE_SITE_COUNT_DEFAULT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How many cosmic sites of a spawn family every eligible solar system receives,",
      "for any family not listed in universeSiteCountsByFamily.",
      "A family only appears in systems whose security band it is eligible for; this sets how many, not where."
    ],
    "validValues": "Non-negative integer. 0 disables families that rely on the default.",
    "minValue": 0,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "homefrontPopulationPreset",
    "defaultValue": "evejs",
    "envVar": "EVEJS_HOMEFRONT_POPULATION_PRESET",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Total Homefront sites per operation type across eligible empire systems: evejs = 8, retail = 77, or custom.",
      "Sites are decided and created only when a player enters a system. Counts describe the fully visited universe, not a minimum in loaded systems.",
      "One site per selected system and operation type. Restart to apply changes; occupied sites finish before cleanup."
    ],
    "validValues": "evejs, retail, or custom.",
    "allowedValues": ["evejs", "retail", "custom"],
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "homefrontCustomSitesPerType",
    "defaultValue": 8,
    "envVar": "EVEJS_HOMEFRONT_CUSTOM_SITES_PER_TYPE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Total sites per Homefront operation type when homefrontPopulationPreset is custom.",
      "0 disables new Homefront sites. Values above the eligible system count saturate at one site per system."
    ],
    "validValues": "Non-negative integer.",
    "minValue": 0,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "universeSiteCountsByFamily",
    "defaultValue": {},
    "envVar": "EVEJS_UNIVERSE_SITE_COUNTS_BY_FAMILY",
    "envType": "json",
    "valueType": "json",
    "description": [
      "Per-family override of how many cosmic sites every eligible solar system receives,",
      "keyed by spawn family (combat, combat_anomaly, drone_anomaly, ore, gas, data, relic, ghost, combat_hacking, ...).",
      "Families omitted here use universeSiteCountDefault. Set a family to 0 to stop it spawning.",
      "A spawn profile may scale this per region (regionSiteCountMultipliers); the count here stays the base amount."
    ],
    "validValues": "Object mapping spawn family name to a non-negative integer count.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "deadspaceWarpRestrictionEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_DEADSPACE_WARP_RESTRICTION",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enforces TQ deadspace parity: while inside a mission/dungeon pocket, warping within the",
      "same complex is blocked (acceleration gates are the only way between rooms), and a warp",
      "from outside that would land inside a site is clamped to the site's warp-in point.",
      "Gate transit warps are exempt. Disable to allow free in-pocket warping."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  }
];
