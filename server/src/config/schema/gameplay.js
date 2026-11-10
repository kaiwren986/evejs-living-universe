"use strict";

module.exports = [
  {
    key: "customsInspectionEnabled", defaultValue: true,
    envVar: "EVEJS_CUSTOMS_INSPECTION_ENABLED", envType: "boolean", valueType: "boolean",
    description: ["Enable persistent officer-based customs inspections at validated gate operators."],
    validValues: "true or false.", allowBlank: false, integer: false,
  },
  {
    key: "customsInspectionScanDelayMs", defaultValue: 3000,
    envVar: "EVEJS_CUSTOMS_INSPECTION_SCAN_DELAY_MS", envType: "number", valueType: "number",
    description: ["Delay between successful gate arrival and the customs officer scan."],
    validValues: "Integer milliseconds from 0 to 600000.", minValue: 0, maxValue: 600000,
    allowBlank: false, integer: true,
  },
  {
    key: "customsInspectionPromptTimeoutSeconds", defaultValue: 60,
    envVar: "EVEJS_CUSTOMS_INSPECTION_PROMPT_TIMEOUT_SECONDS", envType: "number", valueType: "number",
    description: ["Durable deadline for answering the native customs surrender dialog."],
    validValues: "Integer seconds from 1 to 86400.", minValue: 1, maxValue: 86400,
    allowBlank: false, integer: true,
  },
  {
    key: "eventSchedules",
    defaultValue: require("../eventSchedules").DEFAULTS,
    envVar: "EVEJS_EVENT_SCHEDULES", envType: "json", valueType: "json",
    description: ["Independent UTC start/end schedules for implemented events. Apply edits with a server restart. Missing entries are disabled. Changing dates never resets progress."],
    validValues: "Object keyed by supported event ID; see doc/election/OPERATIONS_AND_ACCEPTANCE.md.",
    allowBlank: false, integer: false,
    validateValue: require("../eventSchedules").validateSchedules,
  },
  {
    key: "campaignTrailEnabled",
    defaultValue: false,
    envVar: "EVEJS_CAMPAIGN_TRAIL_ENABLED",
    envType: "boolean",
    valueType: "boolean",
    description: ["Enable the Gallente election, its 28-day seasonal login rewards, Campaign Trail season, Luminaire start/finish beacons and Postouvin Kyonoke memorial site."],
    validValues: "true or false.",
    allowBlank: false,
    integer: false
  },
  {
    "key": "characterDeletionDelayMinutes",
    "defaultValue": 5,
    "envVar": "EVEJS_CHARACTER_DELETION_DELAY_MINUTES",
    "envType": "number",
    "valueType": "number",
    "description": [
      "How long a character must remain queued before biomass can finalize.",
      "Use 600 for retail parity; the default 5-minute value keeps local deletion testing fast."
    ],
    "validValues": "Integer minutes greater than or equal to 1.",
    "minValue": 0,
    "maxValue": 10080,
    "allowBlank": false,
    "integer": true
  },
  {
    "key": "skillTrainingSpeed",
    "defaultValue": 1,
    "envVar": "EVEJS_SKILL_TRAINING_SPEED",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Global multiplier applied after the official CCP skill-training SP-per-minute formula is calculated.",
      "1 = retail training speed, 2 = 2x speed, 10 = 10x speed.",
      "This scales the authoritative server values: actual SP accrual, the active skill's trainingEndTime, and the character-selection queueEndTime.",
      "To keep the client's locally-computed estimates honest, the learning attributes (Charisma/Intelligence/Memory/Perception/Willpower) reported to the client are scaled by the same factor, so the in-game Skill window's per-skill and Total Training Time estimates match the accelerated rate. As a side effect those attributes are shown multiplied in the Character Sheet; CCP SP thresholds are unchanged."
    ],
    "validValues": "Positive number greater than 0.",
    "minValue": 0,
    "exclusiveMinValue": true,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "skillPurchaseEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_SKILL_PURCHASE_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables client direct skillbook purchase through skillHandler.PurchaseSkills.",
      "Keep this enabled for TQ-style skill plan Buy Skill / Buy and Train flows."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    key: "skinrDesignIterationMultiplier", defaultValue: 1,
    envVar: "EVEJS_SKINR_DESIGN_ITERATION_MULTIPLIER", envType: "number", valueType: "number",
    description: [
      "Multiplier applied only to Design Iteration's earned saved-SKINR-design slot bonus. The base five slots and Design Concepting bonus are unchanged.",
      "With both skills at level V: 1 = 125 slots, 2 = 220, 5 = 505. Zero disables only the Design Iteration bonus. Fractional results round down after adding all bonuses.",
      "The client displays the server's capacity; built-in skill descriptions retain their standard bonus text.",
      "The server reports and enforces the scaled limit. Restart the server after editing the config file and relog to refresh the client's cached capacity. Existing designs are retained if the limit is lowered; new saves/imports require space below the new limit."
    ],
    validValues: "Number from 0 to 100, including decimals; 1 preserves the standard limit.",
    minValue: 0, maxValue: 100, allowBlank: false, integer: false,
  },
  {
    "key": "expertSystemsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_EXPERT_SYSTEMS_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables Expert System item activation, active Expert System overlays, and the client expert_system_feature_enabled flag.",
      "Disable only when testing no-Expert-System retail edge cases; GM force installs still require explicit command/runtime force options."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "upwellTimerScale",
    "defaultValue": 1,
    "envVar": "EVEJS_UPWELL_TIMER_SCALE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Global multiplier applied to structure anchor, repair, and reinforcement timers.",
      "Use values below 1 to shorten GM/dev test cycles without hardcoding timer constants in commands."
    ],
    "validValues": "Positive number such as 1, 0.1, or 0.01.",
    "minValue": 0,
    "exclusiveMinValue": true,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "posConsumeFuelWhileServerOffline",
    "defaultValue": false,
    "envVar": "EVEJS_POS_CONSUME_FUEL_WHILE_SERVER_OFFLINE",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Controls whether persisted POS fuel deadlines advance while the server is stopped.",
      "false (default) gives every active tower a fresh fuel period when the server starts and does not charge elapsed offline cycles.",
      "true charges every elapsed cycle during startup reconciliation and offlines towers that cannot pay the first missed cycle."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "sovereigntyOneTimeParityReset",
    "defaultValue": true,
    "envVar": "EVEJS_SOVEREIGNTY_ONE_TIME_PARITY_RESET",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Controls whether the server runs the one-time retail-parity sovereignty reset itself when it starts.",
      "true (default): if the game database has no reset marker, startup backs the database up, removes sovereignty data from older releases (TCU claims, Hubs, Skyhooks, Mercenary Dens, FLEX structures, alliance prime hour and capital settings), records the marker and carries on. Once the marker exists this does nothing.",
      "false: the server only reports old sovereignty data; run node tools/Maintenance/reset-sovereignty.js with the server stopped."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "missionRewardMultiplier",
    "defaultValue": 1,
    "envVar": "EVEJS_MISSION_REWARD_MULTIPLIER",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Server-wide multiplier applied to agent mission ISK and loyalty point payouts.",
      "1 = Tranquility-calibrated payouts, 2 = double, 0.5 = half. Use 0 to pay nothing.",
      "Applied last, after the level tables, the (1.6288 - security) LP term, Negotiation, Division Connections, and any authored or captured per-mission reward. Item rewards are not scaled.",
      "This scales both the offered reward shown in the agent conversation and the amount actually paid at turn-in, so a running server should expect already-offered missions to keep their original values until they are re-offered."
    ],
    "validValues": "Non-negative number such as 1, 2, or 0.5.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "omegaLicenseEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_OMEGA_LICENSE",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables the default local Omega entitlement; explicitly purchased runtime licenses can still exist when false."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "dailyLoginRewardsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_DAILY_LOGIN_REWARDS_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables the 15-day daily login reward campaign."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "dailyLoginRewards",
    "defaultValue": [
      {
        "typeID": 49810,
        "quantity": 1
      }
    ],
    "envVar": "EVEJS_DAILY_LOGIN_REWARDS",
    "envType": "json",
    "valueType": "json",
    "description": [
      "Ordered daily login reward definitions for the 15-day campaign.",
      "A one-entry array repeats that reward every day; shorter arrays cycle until all 15 days are filled."
    ],
    "validValues": "Non-empty JSON array of objects with positive integer typeID and quantity fields.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "loginCampaigns",
    "defaultValue": [],
    "envVar": "EVEJS_LOGIN_CAMPAIGNS",
    "envType": "json",
    "valueType": "json",
    "description": ["Optional reviewed daily, rookie, clone-grade and seasonal login campaign schedules. See doc/LOGIN_CAMPAIGNS.md. Existing daily and Gallente schedules remain defaults."],
    "validValues": "JSON array of versioned campaign definitions.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "factionStandingLossOnKillEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_FACTION_STANDING_LOSS_ON_KILL",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "TQ parity: destroying a faction NPC lowers your standing with that NPC's faction only",
      "(the golden mission logs show a single-faction hit with no derived propagation).",
      "Debounced per (character, faction, system) on a 10-minute window like Tranquility.",
      "Disable to turn off faction-standing loss from kills entirely."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "missionDeclinePenaltyEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_MISSION_DECLINE_PENALTY",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "TQ parity: declining an agent mission a second time within the 4-hour free-decline window",
      "lowers your standing with the agent and its corporation (= agent/10), with the faction hit",
      "arriving via derived propagation. The first decline per agent per 4h is free. Magnitude uses",
      "the mission's own would-be agent reward negated; the golden logs show the true value runs",
      "~1.2-1.5x higher and varies per mission (needs more decline logs to source an exact factor).",
      "Disable to turn off decline standing penalties entirely."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "newCharacterExperienceMode",
    "defaultValue": "disabled",
    "envVar": "EVEJS_NEW_CHARACTER_EXPERIENCE_MODE",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Selects the new-character tutorial experience without conflicting boolean flags."
    ],
    "validValues": "disabled, tutorial, or cinematic.",
    "allowedValues": [
      "disabled",
      "tutorial",
      "cinematic"
    ],
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "turretHitChanceAdditive",
    "defaultValue": 0,
    "envVar": "EVEJS_TURRET_HIT_CHANCE_ADDITIVE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Flat amount added to every turret shot's chance to hit, applied after the TQ tracking/falloff formula and clamped so the total never passes 100%.",
      "0 = the published TQ formula exactly. 0.25 = every shot lands 25 percentage points more often (a 50% falloff-edge shot becomes 75%, a near-zero capital-vs-frigate shot becomes ~25%).",
      "Applies to every consumer of the turret shot resolver: player turrets, NPC turrets, drones, and fighters. Missiles and vorton projectors are untouched.",
      "Shots the formula rules impossible stay impossible: past optimal with no falloff (disintegrators), and weapons with zero tracking, still always miss.",
      "See doc/internal/turret-hit-chance-handoff.md for the full math and calibration tables."
    ],
    "validValues": "Number from 0 (TQ-exact) to 1 (every possible shot always hits).",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "planetResourceAbundanceMultiplier",
    "defaultValue": 1,
    "envVar": "EVEJS_PLANET_RESOURCE_ABUNDANCE_MULTIPLIER",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Scales the shared planet resource field used for client scans and authoritative extractor quotes. Richness = generated baseline * planetResourceAbundanceMultiplier. The baseline retains its existing generation-time security bonus.",
      "Seeds, hotspot locations, factory recipes and cycle times stay unchanged. Existing planets are scaled when read; installed extractor programs retain their quoted yield until restarted. Normal survey resolution, rounding, extractor noise, decay and depletion still apply.",
      "Resource summary bars are scaled within their existing display limit; the heatmap coefficients and server quotes share the full abundance factor. Keep planetSchematicOutputMultiplier at 1 for ordinary factory output. See doc/internal/pi-resource-abundance.md."
    ],
    "validValues": "Positive number greater than 0; 1 preserves current abundance, 2 doubles resource density.",
    "minValue": 0,
    "exclusiveMinValue": true,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "planetSchematicOutputMultiplier",
    "defaultValue": 1,
    "envVar": "EVEJS_PLANET_SCHEMATIC_OUTPUT_MULTIPLIER",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Global multiplier applied to the output quantity of every Planetary Interaction schematic. 1 = retail output, 1.5 = 50% more per factory cycle, 0.5 = half. Extractor (ECU) yield is NOT affected - this only changes what factories make from the inputs they consume.",
      "THE NUMBERS. There are only four output quantities in the whole schematic table: P1 = 20 units per 30-minute cycle, P2 = 5 per hour, P3 = 3 per hour, P4 = 1 per hour. The scaled amount is rounded to the nearest whole unit and never rounds below 1, so P1/P2/P3/P4 come out as: 0.5 -> 10/3/2/1, 0.75 -> 15/4/2/1, 1.0 -> 20/5/3/1, 1.1 -> 22/6/3/1, 1.5 -> 30/8/5/2, 2.0 -> 40/10/6/2. Small multipliers move P1 smoothly and barely move P4, because P4 only makes 1 unit a cycle.",
      "IT COMPOUNDS - PICK A SMALLER NUMBER THAN YOU THINK. Every tier gets both a bigger output AND a bigger supply of the tier below it, so the effect multiplies down the chain instead of adding. At 1.5 the cumulative result per unit of raw material is 1.5x more P1, 2.4x more P2, 4.0x more P3 and 8.0x more P4 - not '50% more'. To hit a target multiple M at tier n, set roughly M^(1/n): 1.5x more P2 = about 1.22, 1.5x more P4 = about 1.11, 2x more P4 = about 1.19.",
      "The EVE client computes PI figures from its own schematic data and is never told this value, so factory output, the Create Route quantity field and the client's colony projection all keep showing retail numbers. The server is authoritative for what is actually produced, routed and stored, so the extra product does show up in storage and at the customs office.",
      "Above 1.0, route factory output into STORAGE rather than straight into the next factory. A downstream factory only accepts one cycle of inputs, and a producer's surplus that no route can take is discarded (retail does this too - it is just much easier to hit here).",
      "Colonies simulate lazily, so a colony that has not been opened since the change catches up its entire idle backlog at the new rate. Change this at downtime on a live server. See doc/internal/pi-schematic-output-multiplier-spec.md."
    ],
    "validValues": "Positive number greater than 0, such as 1, 1.5, or 0.5.",
    "minValue": 0,
    "exclusiveMinValue": true,
    "allowBlank": false,
    "integer": false
  }
];
