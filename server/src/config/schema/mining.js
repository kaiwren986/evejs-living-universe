"use strict";

module.exports = [
  {
    "key": "miningNpcFleetProfileOrPool",
    "defaultValue": "",
    "envVar": "EVEJS_MINING_NPC_FLEET_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Optional NPC profile, pool, or spawn-group query used by /npcminer when it creates the passive mining fleet. Blank falls back to security-band defaults."
    ],
    "validValues": "Blank, or an NPC profile / pool / spawn-group ID such as \"npc_mining_ops_highsec\".",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "miningNpcFleetHighSecProfileOrPool",
    "defaultValue": "npc_mining_ops_highsec",
    "envVar": "EVEJS_MINING_NPC_FLEET_HIGHSEC_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile, pool, or spawn-group query used for passive mining fleets in high-security systems when no explicit override is supplied."
    ],
    "validValues": "NPC profile / pool / spawn-group ID such as \"npc_mining_ops_highsec\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcFleetLowSecProfileOrPool",
    "defaultValue": "npc_mining_ops_lowsec",
    "envVar": "EVEJS_MINING_NPC_FLEET_LOWSEC_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile, pool, or spawn-group query used for passive mining fleets in low-security systems when no explicit override is supplied."
    ],
    "validValues": "NPC profile / pool / spawn-group ID such as \"npc_mining_ops_lowsec\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcFleetNullSecProfileOrPool",
    "defaultValue": "npc_mining_ops_nullsec",
    "envVar": "EVEJS_MINING_NPC_FLEET_NULLSEC_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile, pool, or spawn-group query used for passive mining fleets in null-security and wormhole systems when no explicit override is supplied."
    ],
    "validValues": "NPC profile / pool / spawn-group ID such as \"npc_mining_ops_nullsec\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcFleetDefaultCount",
    "defaultValue": 1,
    "envVar": "EVEJS_MINING_NPC_FLEET_DEFAULT_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Default repetition count used by /npcminer when no explicit amount is provided. Pool/profile queries treat this as a hull count, while spawn-group queries repeat the full authored group."
    ],
    "validValues": "Positive integer up to the GM command safety cap.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcHaulerProfileOrPool",
    "defaultValue": "",
    "envVar": "EVEJS_MINING_NPC_HAULER_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Optional NPC profile, pool, or spawn-group query used for the transient hauler wing attached to mining fleets. Blank falls back to security-band defaults."
    ],
    "validValues": "Blank, or an NPC profile / pool / spawn-group ID such as \"npc_mining_hauler_highsec\".",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "miningNpcHaulerHighSecProfileOrPool",
    "defaultValue": "npc_mining_hauler_highsec",
    "envVar": "EVEJS_MINING_NPC_HAULER_HIGHSEC_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile, pool, or spawn-group query used for transient mining haulers in high-security systems when no explicit override is supplied."
    ],
    "validValues": "NPC profile / pool / spawn-group ID such as \"npc_mining_hauler_highsec\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHaulerLowSecProfileOrPool",
    "defaultValue": "npc_mining_hauler_lowsec",
    "envVar": "EVEJS_MINING_NPC_HAULER_LOWSEC_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile, pool, or spawn-group query used for transient mining haulers in low-security systems when no explicit override is supplied."
    ],
    "validValues": "NPC profile / pool / spawn-group ID such as \"npc_mining_hauler_lowsec\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHaulerNullSecProfileOrPool",
    "defaultValue": "npc_mining_hauler_nullsec",
    "envVar": "EVEJS_MINING_NPC_HAULER_NULLSEC_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile, pool, or spawn-group query used for transient mining haulers in null-security and wormhole systems when no explicit override is supplied."
    ],
    "validValues": "NPC profile / pool / spawn-group ID such as \"npc_mining_hauler_nullsec\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHaulerDefaultCount",
    "defaultValue": 1,
    "envVar": "EVEJS_MINING_NPC_HAULER_DEFAULT_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Default hauler hull count attached to /npcminer fleets and startup mining fleets."
    ],
    "validValues": "Non-negative integer up to the GM command safety cap.",
    "minValue": 0,
    "maxValue": 20,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcFleetLandingRadiusMeters",
    "defaultValue": 2500,
    "envVar": "EVEJS_MINING_NPC_FLEET_LANDING_RADIUS_METERS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Radius around the target ship used when mining NPCs finish their warp-in."
    ],
    "validValues": "Positive distance in meters.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcResponseProfileOrPool",
    "defaultValue": "npc_laser_hostiles",
    "envVar": "EVEJS_MINING_NPC_RESPONSE_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile or spawn-pool query used by /npcmineraggro when the response fleet is called."
    ],
    "validValues": "NPC profile or pool ID such as \"npc_laser_hostiles\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcResponseDefaultCount",
    "defaultValue": 8,
    "envVar": "EVEJS_MINING_NPC_RESPONSE_DEFAULT_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Default hull count used by /npcmineraggro when no explicit response amount is supplied."
    ],
    "validValues": "Positive integer up to the GM command safety cap.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcStandingsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_MINING_NPC_STANDINGS_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables standings-aware response planning for transient mining NPC fleets when they are aggressed."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHostileStandingThreshold",
    "defaultValue": -5,
    "envVar": "EVEJS_MINING_NPC_HOSTILE_STANDING_THRESHOLD",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Fallback hostile standing threshold used by mining NPC fleets when the NPC profile does not provide explicit response thresholds."
    ],
    "validValues": "Number between -10 and 10.",
    "minValue": -10,
    "maxValue": 10,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcFriendlyStandingThreshold",
    "defaultValue": 5,
    "envVar": "EVEJS_MINING_NPC_FRIENDLY_STANDING_THRESHOLD",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Fallback friendly standing threshold used by mining NPC fleets when the NPC profile does not provide explicit response thresholds."
    ],
    "validValues": "Number between -10 and 10.",
    "minValue": -10,
    "maxValue": 10,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcFriendlyResponseProfileOrPool",
    "defaultValue": "",
    "envVar": "EVEJS_MINING_NPC_FRIENDLY_RESPONSE_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Optional NPC profile or pool used when a mining fleet is aggressed by a character with friendly standings."
    ],
    "validValues": "Blank for no armed response, or an NPC profile/pool ID such as \"npc_laser_hostiles\".",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "miningNpcFriendlyResponseCount",
    "defaultValue": 0,
    "envVar": "EVEJS_MINING_NPC_FRIENDLY_RESPONSE_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Response hull count used for friendly-standing aggressors after a mining fleet retreats."
    ],
    "validValues": "Non-negative integer.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcNeutralResponseProfileOrPool",
    "defaultValue": "npc_laser_hostiles",
    "envVar": "EVEJS_MINING_NPC_NEUTRAL_RESPONSE_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile or pool used when a mining fleet is aggressed by a neutral-standing character."
    ],
    "validValues": "NPC profile or pool ID such as \"npc_laser_hostiles\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcNeutralResponseCount",
    "defaultValue": 8,
    "envVar": "EVEJS_MINING_NPC_NEUTRAL_RESPONSE_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Response hull count used for neutral-standing aggressors after a mining fleet retreats."
    ],
    "validValues": "Non-negative integer.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcHostileResponseProfileOrPool",
    "defaultValue": "npc_laser_hostiles",
    "envVar": "EVEJS_MINING_NPC_HOSTILE_RESPONSE_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile or pool used when a mining fleet is aggressed by a hostile-standing character."
    ],
    "validValues": "NPC profile or pool ID such as \"npc_laser_hostiles\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHostileResponseCount",
    "defaultValue": 10,
    "envVar": "EVEJS_MINING_NPC_HOSTILE_RESPONSE_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Response hull count used for hostile-standing aggressors after a mining fleet retreats."
    ],
    "validValues": "Non-negative integer.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcResponseCooldownMs",
    "defaultValue": 60000,
    "envVar": "EVEJS_MINING_NPC_RESPONSE_COOLDOWN_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Minimum delay between mining-fleet response deployments so repeat aggression during a single exchange does not spam extra wings."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "minValue": 0,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcAggressionMemoryMs",
    "defaultValue": 180000,
    "envVar": "EVEJS_MINING_NPC_AGGRESSION_MEMORY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How long mining fleets remember aggression on their miner or hauler hulls before the event is considered stale."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "minValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcResponseRetreatDelayMs",
    "defaultValue": 120000,
    "envVar": "EVEJS_MINING_NPC_RESPONSE_RETREAT_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How long the transient response wing remains deployed after the last aggression before it retreats or despawns."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcWarpIngressDurationMs",
    "defaultValue": 2500,
    "envVar": "EVEJS_MINING_NPC_WARP_INGRESS_DURATION_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Warp ingress duration used by the mining NPC warp-in and retreat helpers."
    ],
    "validValues": "Positive duration in milliseconds.",
    "minValue": 250,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_MINING_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables the mining runtime, asteroid depletion state, and mining scan service."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningSurveyScanDistanceMeters",
    "defaultValue": 250000,
    "envVar": "EVEJS_MINING_SURVEY_SCAN_DISTANCE_METERS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum range used when the mining scan manager returns asteroid scan tuples to the client."
    ],
    "validValues": "Positive distance in meters.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningBeltQuantityScale",
    "defaultValue": 0.08,
    "envVar": "EVEJS_MINING_BELT_QUANTITY_SCALE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Radius-to-volume scale used when estimating authoritative asteroid quantities for generated belt rocks."
    ],
    "validValues": "Positive number.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningBeltMinimumAsteroidVolumeM3",
    "defaultValue": 15000,
    "envVar": "EVEJS_MINING_BELT_MIN_ASTEROID_VOLUME_M3",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Minimum generated asteroid volume used by the mining runtime for generated belt rocks."
    ],
    "validValues": "Positive number of cubic meters.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningBeltMaximumAsteroidVolumeM3",
    "defaultValue": 3000000,
    "envVar": "EVEJS_MINING_BELT_MAX_ASTEROID_VOLUME_M3",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum generated asteroid volume used by the mining runtime for generated belt rocks."
    ],
    "validValues": "Positive number of cubic meters.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningGeneratedIceSitesEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_MINING_GENERATED_ICE_SITES_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Adds deterministic runtime ice fields to space scenes so ice harvesters and ore-hold routing have live non-moon content to work against."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningGeneratedIceSiteLifetimeMinutes",
    "defaultValue": 1440,
    "envVar": "EVEJS_MINING_GENERATED_ICE_SITE_LIFETIME_MINUTES",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Lifetime in minutes for universe-seeded generated ice site slots before they rotate in place to the next deterministic field definition."
    ],
    "validValues": "Positive integer minutes.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningGeneratedSiteRadiusMeters",
    "defaultValue": 18000,
    "envVar": "EVEJS_MINING_GENERATED_SITE_RADIUS_METERS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Radius of the generated runtime ice and gas fields around each deterministic site anchor."
    ],
    "validValues": "Positive distance in meters.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningIceChunksPerSite",
    "defaultValue": 12,
    "envVar": "EVEJS_MINING_ICE_CHUNKS_PER_SITE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How many mineable ice chunks each generated ice field contains."
    ],
    "validValues": "Positive integer.",
    "minValue": 1,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningGasCloudsPerSite",
    "defaultValue": 14,
    "envVar": "EVEJS_MINING_GAS_CLOUDS_PER_SITE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Number of gas-cloud entities materialized for each active authored dungeon gas signature."
    ],
    "validValues": "Positive integer.",
    "minValue": 1,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningDepletedAsteroidRadiusRatio",
    "defaultValue": 0.25,
    "envVar": "EVEJS_MINING_DEPLETED_ASTEROID_RADIUS_RATIO",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Minimum radius ratio preserved while an asteroid is being depleted before it is removed from the scene."
    ],
    "validValues": "Positive fraction such as 0.25.",
    "minValue": 0.01,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcFleetAutoMineEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_MINING_NPC_FLEET_AUTO_MINE_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Lets /npcminer fleets automatically lock asteroids, approach, activate miners, and deplete rocks."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHaulThresholdRatio",
    "defaultValue": 0.85,
    "envVar": "EVEJS_MINING_NPC_HAUL_THRESHOLD_RATIO",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Fraction of miner cargo fill at which the transient NPC hauler choreography triggers."
    ],
    "validValues": "Positive fraction between 0 and 1.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHaulerInitialDelayMs",
    "defaultValue": 5400000,
    "envVar": "EVEJS_MINING_NPC_HAULER_INITIAL_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Minimum time before a newly spawned mining fleet becomes eligible for its first hauler run.",
      "The default is tuned to public player observations of roughly 90 minutes from fleet spawn to first hauler appearance."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcHaulerRepeatDelayMs",
    "defaultValue": 1800000,
    "envVar": "EVEJS_MINING_NPC_HAULER_REPEAT_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Minimum time between completed hauler runs for the same mining fleet.",
      "The default is tuned to public player observations of roughly 30-minute repeat windows."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcFleetAutoResumeDelayMs",
    "defaultValue": 0,
    "envVar": "EVEJS_MINING_NPC_FLEET_AUTO_RESUME_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Optional delay after /npcmineraggro or /npcminerpanic before transient mining fleets auto-resume mining."
    ],
    "validValues": "Non-negative duration in milliseconds. Use 0 to require manual /npcminerresume.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcStartupSystemIDs",
    "defaultValue": "",
    "envVar": "EVEJS_MINING_NPC_STARTUP_SYSTEM_IDS",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Comma-separated solar system IDs that should receive transient startup mining fleets. Blank means all loaded scenes."
    ],
    "validValues": "Comma-separated IDs such as \"30000142,30002510\".",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "miningNpcStartupFleetCount",
    "defaultValue": 0,
    "envVar": "EVEJS_MINING_NPC_STARTUP_FLEET_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How many transient mining fleets to recreate per matching system scene during startup."
    ],
    "validValues": "Non-negative integer.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcStartupFleetMinerCount",
    "defaultValue": 3,
    "envVar": "EVEJS_MINING_NPC_STARTUP_FLEET_MINER_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Miner hull count per transient startup mining fleet."
    ],
    "validValues": "Positive integer.",
    "minValue": 0,
    "maxValue": 100,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcStartupFleetHaulerCount",
    "defaultValue": 1,
    "envVar": "EVEJS_MINING_NPC_STARTUP_FLEET_HAULER_COUNT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Hauler hull count per transient startup mining fleet."
    ],
    "validValues": "Non-negative integer.",
    "minValue": 0,
    "maxValue": 20,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "miningNpcStartupFleetProfileOrPool",
    "defaultValue": "npc_mining_ops",
    "envVar": "EVEJS_MINING_NPC_STARTUP_FLEET_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile or pool used when config-driven transient startup mining fleets are recreated."
    ],
    "validValues": "NPC profile or pool ID such as \"npc_mining_ops\".",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningNpcStartupHaulerProfileOrPool",
    "defaultValue": "",
    "envVar": "EVEJS_MINING_NPC_STARTUP_HAULER_PROFILE_OR_POOL",
    "envType": "string",
    "valueType": "string",
    "description": [
      "NPC profile or pool used for the transient hauler wing of startup mining fleets."
    ],
    "validValues": "NPC profile or pool ID such as \"npc_mining_ops\".",
    "allowBlank": true,
    "integer": false
  },
  {
    "key": "miningStructureReprocessingEfficiency",
    "defaultValue": 0.5,
    "envVar": "EVEJS_MINING_STRUCTURE_REPROCESSING_EFFICIENCY",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Structure-side base reprocessing efficiency used by the mining industry services until per-structure rig bonuses are modeled."
    ],
    "validValues": "Fraction between 0 and 1.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningStructureGasDecompressionEfficiency",
    "defaultValue": 0.79,
    "envVar": "EVEJS_MINING_STRUCTURE_GAS_DECOMPRESSION_EFFICIENCY",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Structure-side base gas decompression efficiency used by structureCompressionMgr."
    ],
    "validValues": "Fraction between 0 and 1.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningCharacterLedgerDelayMs",
    "defaultValue": 600000,
    "envVar": "EVEJS_MINING_CHARACTER_LEDGER_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Visibility delay applied to personal mining-ledger entries before characterMiningLedger returns them.",
      "This keeps delayed-ledger parity configurable without adding expensive per-cycle database work."
    ],
    "validValues": "Non-negative duration in milliseconds. 600000 = 10 minutes.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "miningObserverLedgerDelayMs",
    "defaultValue": 3600000,
    "envVar": "EVEJS_MINING_OBSERVER_LEDGER_DELAY_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Visibility delay applied to observer/corporation mining-ledger entries before corpMiningLedger exposes them.",
      "Use this to model CCP-style delayed observer data while keeping reads cache-first."
    ],
    "validValues": "Non-negative duration in milliseconds. 3600000 = 1 hour.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "industrySystemCostIndex",
    "defaultValue": 0.04,
    "envVar": "EVEJS_INDUSTRY_SYSTEM_COST_INDEX",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Flat system cost index applied to industry job install costs across manufacturing, research, copying, invention, and reactions.",
      "Live EVE derives this value per solar system and activity from rolling industry job volume; this emulator does not track that telemetry yet, so one static index stands in for the whole cluster.",
      "Job gross cost = estimated item value x this index x facility cost modifier. Facility tax and the SCC surcharge are still charged on the full estimated item value, matching the client industry cost breakdown.",
      "0 reproduces the previous zero-index behavior (install cost equals the full estimated item value); raise toward live high-sec values, roughly 0.01 to 0.10, to keep install costs realistic."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "industryJobSpeedMultiplier",
    "defaultValue": 1,
    "envVar": "EVEJS_INDUSTRY_JOB_SPEED_MULTIPLIER",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Global speed multiplier applied to newly quoted and installed industry jobs across manufacturing, research, copying, invention, and reactions.",
      "1 = retail job speed, 2 = twice as fast (half the duration), and 0.5 = half as fast (twice the duration).",
      "The multiplier composes with blueprint time efficiency, character skills, facility hull bonuses, and rigs. Existing installed jobs keep their stored completion time."
    ],
    "validValues": "Positive number greater than 0.",
    "minValue": 0,
    "exclusiveMinValue": true,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidFieldsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_ASTEROID_FIELDS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Controls generated mineable asteroid-belt entities when a solar-system scene is created."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltStartupReset",
    "defaultValue": false,
    "envVar": "EVEJS_ASTEROID_BELT_STARTUP_RESET",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Clears persisted belt asteroid depletion state during server startup so every asteroid belt repopulates.",
      "Disabled by default so ordinary restarts preserve accepted belt generations and depletion. Enable only for a deliberate downtime reset. Generated ice sites keep their own respawn lifecycle and are not affected."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  }
];
