"use strict";

module.exports = [
  {
    "key": "npcPlayerDronesTargetable",
    "defaultValue": true,
    "envVar": "EVEJS_NPC_PLAYER_DRONES_TARGETABLE",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Allows NPC combat AI to treat player-controlled drones as valid targets when the NPC behavior profile includes the drone target class. Disable to make NPCs ignore player drones globally."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RATS_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables lazy normal pirate rat spawns when a player arrives at an asteroid belt. Disable to remove belt-rat spawning entirely."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatHighSecChance",
    "defaultValue": 0.25,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_HIGHSEC_CHANCE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Chance that an eligible high-security belt arrival creates a normal pirate rat group when the belt has no active rat group."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatLowSecChance",
    "defaultValue": 0.35,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_LOWSEC_CHANCE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Chance that an eligible low-security belt arrival creates a normal pirate rat group when the belt has no active rat group."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatNullSecChance",
    "defaultValue": 0.45,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_NULLSEC_CHANCE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Chance that an eligible null-security belt arrival creates a normal pirate rat group when the belt has no active rat group."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatRollCooldownMs",
    "defaultValue": 120000,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_ROLL_COOLDOWN_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Minimum time before the same empty belt can roll for another rat spawn after a player arrival check."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatRespawnCooldownMs",
    "defaultValue": 1200000,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_RESPAWN_COOLDOWN_MS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Minimum time before the same belt can spawn a replacement normal pirate rat group after its previous group was created."
    ],
    "validValues": "Non-negative duration in milliseconds.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatMaxActiveGroupsPerBelt",
    "defaultValue": 1,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_MAX_ACTIVE_GROUPS_PER_BELT",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum active lazy normal pirate rat groups allowed at a single asteroid belt."
    ],
    "validValues": "Positive integer.",
    "minValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatLandingRadiusMeters",
    "defaultValue": 250000,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_LANDING_RADIUS_METERS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum distance from an asteroid belt anchor for login/arrival checks to count the player as being at that belt."
    ],
    "validValues": "Positive distance in meters.",
    "minValue": 1000,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatSpawnDistanceMeters",
    "defaultValue": 30000,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_SPAWN_DISTANCE_METERS",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Approximate anchor-relative distance used when placing lazy normal pirate rat groups around asteroid belts."
    ],
    "validValues": "Positive distance in meters.",
    "minValue": 1000,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatSpecialsEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_SPECIALS_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables rare asteroid-belt special spawns such as hauler, faction commander, and officer-style rats."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatHaulerChance",
    "defaultValue": 0.02,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_HAULER_CHANCE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Chance that an eligible empty-belt arrival creates a rare NPC hauler group instead of a normal pirate group."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatCommanderChance",
    "defaultValue": 0.015,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_COMMANDER_CHANCE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Chance that an eligible empty-belt arrival creates a faction commander spawn instead of a normal pirate group."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatOfficerChance",
    "defaultValue": 0.0005,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_OFFICER_CHANCE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Chance that an eligible deep nullsec pirate-home belt arrival creates an officer-style rare spawn."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatOfficerMaxSecurity",
    "defaultValue": -0.7,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_OFFICER_MAX_SECURITY",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum true security status eligible for non-home-region officer-style asteroid-belt spawns."
    ],
    "validValues": "Number from -1.0 to 1.0.",
    "minValue": -1,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatOfficerRequireHomeRegion",
    "defaultValue": true,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_OFFICER_REQUIRE_HOME_REGION",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Restricts officer-style asteroid-belt spawns to the matching pirate faction's home region."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatCapitalEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_ENABLED",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables rare null-security asteroid-belt capital NPC spawns such as pirate dreadnoughts."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatCapitalChance",
    "defaultValue": 0.00025,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_CHANCE",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Chance that an eligible empty null-security belt arrival creates a rare pirate capital spawn instead of normal belt rats."
    ],
    "validValues": "Number from 0.0 to 1.0.",
    "minValue": 0,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatCapitalMaxSecurity",
    "defaultValue": 0,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_MAX_SECURITY",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum true security status eligible for rare asteroid-belt capital spawns. Capital spawns are still null-security only."
    ],
    "validValues": "Number from -1.0 to 1.0.",
    "minValue": -1,
    "maxValue": 1,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatCapitalClasses",
    "defaultValue": "dreadnought",
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_CLASSES",
    "envType": "string",
    "valueType": "string",
    "description": [
      "Comma-separated capital classes allowed in rare asteroid-belt capital spawns."
    ],
    "validValues": "\"dreadnought\" for CCP-style belt dreads, or a comma-separated list including dreadnought, titan, and supercarrier.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "asteroidBeltNpcRatCapitalMaxActiveGroupsPerSystem",
    "defaultValue": 1,
    "envVar": "EVEJS_ASTEROID_BELT_NPC_RAT_CAPITAL_MAX_ACTIVE_GROUPS_PER_SYSTEM",
    "envType": "number",
    "valueType": "number",
    "description": [
      "Maximum active rare asteroid-belt capital groups allowed in one solar-system scene. Use 0 for no system-wide cap."
    ],
    "validValues": "Non-negative integer.",
    "minValue": 0,
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "npcAuthoredStartupEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_NPC_AUTHORED_STARTUP",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Turns on the startup rules we have written by hand in the local NPC data files.",
      "Plain-English meaning: if this is off, those custom NPC and CONCORD auto-spawns will not appear when a solar system scene is created."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "npcDefaultConcordStartupEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_NPC_DEFAULT_CONCORD_STARTUP",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Turns on generated default CONCORD gate coverage for high-security systems (`0.5+`).",
      "This is separate from npcAuthoredStartupEnabled, so generated default CONCORD can still appear even if authored startup is off."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "npcDefaultConcordGateAutoAggroNpcsEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_NPC_DEFAULT_CONCORD_GATE_AUTO_AGGRO_NPCS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "When generated default CONCORD gate coverage is enabled, lets those gate checkpoint ships auto-aggro nearby NPC ships.",
      "This only affects generated default gate CONCORD; station screens stay passive and Crimewatch CONCORD response is unchanged."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "npcDefaultConcordStationScreensEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_NPC_DEFAULT_CONCORD_STATION_SCREENS",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "When generated default CONCORD coverage is on, also place passive CONCORD patrol groups near stations in `1.0` and `0.9` systems.",
      "Think of these as visible station security screens, not the separate Crimewatch punishment fleet that warps in after a criminal act."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "crimewatchConcordResponseEnabled",
    "defaultValue": true,
    "envVar": "EVEJS_CRIMEWATCH_CONCORD_RESPONSE",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "Enables automatic Crimewatch-driven CONCORD response to criminal actions in high-security space."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  },
  {
    "key": "crimewatchConcordPodKillEnabled",
    "defaultValue": false,
    "envVar": "EVEJS_CRIMEWATCH_CONCORD_POD_KILL",
    "envType": "boolean",
    "valueType": "boolean",
    "description": [
      "When automatic Crimewatch CONCORD response is enabled, lets that transient punishment wing continue onto a criminal capsule after the ship dies.",
      "This does not affect passive startup/default CONCORD presence."
    ],
    "validValues": "true or false.",
    "allowBlank": false,
    "integer": false
  }
];
