"use strict";

// NPC chat commands: /npc and /mnpc (spawn NPCs by faction, profile or pool, missile NPCs for
// /mnpc), the capital NPC commands, /npctest and /npctest2 (NPCs that fight the caller or each
// other), /npcw and /wnpc (NPCs that warp in), /concord, /spawnsite (a site template's
// NPCs), /npcclear (clear NPCs or CONCORD in the system or a radius) and /gateconcord and
// /gaterats (gate operators on or off), with their argument parsing and spawn summaries.

const path = require("path");

const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../../../space/entityConstants"));
const spaceRuntime = require("../../../space/runtime");
const npcService = require("../../../space/npc");
// EveAnomUtility: dev command to spawn an authored dungeon-authority template's NPCs at the player.
const dungeonAuthorityForSpawnSite = require("../../dungeon/dungeonAuthority");
const dungeonUniverseSiteServiceForSpawnSite = require("../../dungeon/dungeonUniverseSiteService");
const {
  executeCapitalNpcCommand,
} = require("../capitalNpc");
const {
  NPCTEST_DEFAULT_AMOUNT,
  spawnNpcTestForSession,
} = require("../../../space/npc/npcTestService");
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  parseAmount,
  parseToggleCommandArgument,
} = require(path.join(__dirname, "./commandArguments"));
const {
  formatSuggestions,
} = require(path.join(__dirname, "./commandSuggestions"));
const {
  formatDistanceMeters,
} = require(path.join(__dirname, "./commandFormatting"));
const {
  resolveSessionSolarSystemID,
  isSpaceSessionReady,
  resolveSessionShipEntity,
} = require(path.join(__dirname, "./commandSessionLocation"));

const MAX_NPC_COMMAND_SPAWN_COUNT = 50;
const MAX_NPC_WARP_COMMAND_SPAWN_COUNT = 25;
const MAX_CONCORD_COMMAND_SPAWN_COUNT = 25;

function parseNpcSpawnArguments(argumentText, options = {}) {
  const defaultAmount = Math.max(
    1,
    Number.parseInt(options.defaultAmount, 10) || 1,
  );
  const trimmed = String(argumentText || "").trim();
  if (!trimmed) {
    return {
      success: true,
      amount: defaultAmount,
      query: "",
    };
  }

  const parts = trimmed.split(/\s+/);
  let amount = defaultAmount;
  let amountIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const parsed = parseAmount(parts[index]);
    if (parsed === null) {
      continue;
    }
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        success: false,
        errorMsg: "INVALID_AMOUNT",
      };
    }
    amount = parsed;
    amountIndex = index;
    break;
  }

  const query = amountIndex >= 0
    ? parts.filter((_, index) => index !== amountIndex).join(" ").trim()
    : trimmed;
  return {
    success: true,
    amount,
    query,
  };
}

function normalizeNpcEntityTypeFilter(value, fallback = "all") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["all", "any", "*"].includes(normalized)) {
    return "all";
  }
  if (["npc", "npcs", "rat", "rats"].includes(normalized)) {
    return ENTITY_TYPE.NPC;
  }
  if (normalized === "concord") {
    return ENTITY_TYPE.CONCORD;
  }
  return null;
}

function parseNpcClearArguments(argumentText) {
  const trimmed = String(argumentText || "").trim();
  if (!trimmed) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  const parts = trimmed.split(/\s+/);
  const scope = String(parts[0] || "").trim().toLowerCase();
  if (scope === "system") {
    return {
      success: true,
      scope: "system",
      radiusMeters: 0,
      entityType: normalizeNpcEntityTypeFilter(parts[1], "all"),
    };
  }

  if (scope === "radius") {
    const radiusMeters = parseAmount(parts[1]);
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      return {
        success: false,
        errorMsg: "INVALID_RADIUS",
      };
    }

    return {
      success: true,
      scope: "radius",
      radiusMeters,
      entityType: normalizeNpcEntityTypeFilter(parts[2], "all"),
    };
  }

  return {
    success: false,
    errorMsg: "USAGE",
  };
}

function formatNpcSpawnSummary(result, commandLabel) {
  const data = result && result.data ? result.data : null;
  if (data && Array.isArray(data.spawned) && data.spawned.length > 0) {
    const spawnGroups = new Map();
    let totalLootEntries = 0;
    let totalModules = 0;

    for (const entry of data.spawned) {
      const profileName =
        entry &&
        entry.definition &&
        entry.definition.profile &&
        entry.definition.profile.name
          ? entry.definition.profile.name
          : "Unknown NPC";
      spawnGroups.set(profileName, (spawnGroups.get(profileName) || 0) + 1);
      totalLootEntries += Array.isArray(entry && entry.lootEntries)
        ? entry.lootEntries.length
        : 0;
      totalModules += Array.isArray(entry && entry.fittedModules)
        ? entry.fittedModules.length
        : 0;
    }

    const composition = [...spawnGroups.entries()]
      .map(([name, count]) => `${count}x ${name}`)
      .join(", ");
    const selectionText = data.selectionName
      ? ` from ${data.selectionName}`
      : "";
    const lootSummary = totalLootEntries > 0
      ? `Seeded ${totalLootEntries} random cargo loot entr${totalLootEntries === 1 ? "y" : "ies"}.`
      : "No extra cargo loot was seeded.";
    const partialSummary = data.partialFailure
      ? ` Spawn stopped at ${data.partialFailure.failedAt}/${data.requestedAmount}: ${data.partialFailure.errorMsg}.`
      : "";
    return [
      `Spawned ${data.spawned.length} hull${data.spawned.length === 1 ? "" : "s"}${selectionText}: ${composition}.`,
      `Prepared ${totalModules} fitted weapon module${totalModules === 1 ? "" : "s"} and set preferred target to your ship.`,
      "These command-spawned NPCs are transient and are not written to disk.",
      lootSummary,
      partialSummary.trim(),
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  if (!data || !data.definition || !data.entity) {
    return `${commandLabel} spawn completed.`;
  }

  const lootEntries = Array.isArray(data.lootEntries) ? data.lootEntries : [];
  const nativeNpc = Boolean(data.entity && data.entity.nativeNpc === true);
  const lootSummary = nativeNpc
    ? "Loot will be rolled into the wreck on destruction."
    : lootEntries.length > 0
      ? `Seeded ${lootEntries.length} random cargo loot entr${lootEntries.length === 1 ? "y" : "ies"}.`
      : "No extra cargo loot was seeded.";
  const moduleCount = Array.isArray(data.fittedModules) ? data.fittedModules.length : 0;
  return [
    `Spawned ${data.definition.profile.name} as entity ${data.entity.itemID}.`,
    `Hull: ${data.shipItem && data.shipItem.itemName ? data.shipItem.itemName : data.definition.profile.shipNameTemplate}.`,
    `Prepared ${moduleCount} fitted weapon module${moduleCount === 1 ? "" : "s"} and set preferred target to your ship.`,
    nativeNpc
      ? "This command-spawned NPC is native, transient, and is not written to disk."
      : "This command-spawned NPC is transient and is not written to disk.",
    lootSummary,
  ].join(" ");
}

function formatNpcWarpSpawnSummary(result, commandLabel) {
  const baseSummary = formatNpcSpawnSummary(result, commandLabel);
  const spawnedCount =
    result &&
    result.data &&
    Array.isArray(result.data.spawned)
      ? result.data.spawned.length
      : 0;
  if (spawnedCount <= 0) {
    return `${baseSummary} Warp-in could not be confirmed.`;
  }
  return [
    baseSummary,
    `Warping ${spawnedCount === 1 ? "it" : "them"} in from a safe off-grid origin and attacking your ship.`,
  ].join(" ");
}

function resolveWarpCommandSyntheticChaseTier(entity) {
  const mass = Number(entity && entity.mass || 0);
  const radius = Number(entity && entity.radius || 0);
  if (mass >= 80_000_000 || radius >= 250) {
    return "large";
  }
  if (mass >= 8_000_000 || radius >= 100) {
    return "medium";
  }
  return "small";
}

function applyWarpCommandChaseOverride(result) {
  const spawned = result &&
    result.data &&
    Array.isArray(result.data.spawned)
      ? result.data.spawned
      : [];
  let appliedCount = 0;
  let failedCount = 0;

  for (const entry of spawned) {
    const entityID = Number(entry && entry.entity && entry.entity.itemID || 0);
    if (!Number.isInteger(entityID) || entityID <= 0) {
      failedCount += 1;
      continue;
    }

    const controller = npcService.getControllerByEntityID(entityID);
    const existingOverrides =
      controller &&
      controller.behaviorOverrides &&
      typeof controller.behaviorOverrides === "object"
        ? controller.behaviorOverrides
        : {};
    const overrideResult = npcService.setBehaviorOverrides(entityID, {
      ...existingOverrides,
      useChasePropulsion: true,
      syntheticChasePropulsionTier: resolveWarpCommandSyntheticChaseTier(
        entry && entry.entity,
      ),
      chasePropulsionActivateDistanceMeters: 10_000,
      chasePropulsionDeactivateDistanceMeters: 10_000,
      returnToHomeWhenIdle: false,
      leashRangeMeters: 0,
    });
    if (overrideResult && overrideResult.success) {
      appliedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return {
    appliedCount,
    failedCount,
  };
}

// EveAnomUtility: collect an authored dungeon template's NPC groups as { amount, query, faction } so they
// can be spawned with the same engine /npc uses. Handles eve-survival (rooms[].groups[].spawnEntries) and
// client-dungeon/anomaly (populationHints.encounters[].spawnQuery) shapes.
const SPAWN_SITE_FACTION_KEYS = {
  guristas: "guristas",
  angel: "angel",
  "angel cartel": "angel",
  "arch angels": "angel",
  blood: "blood",
  "blood raiders": "blood",
  sansha: "sansha",
  "sansha's nation": "sansha",
  serpentis: "serpentis",
};

function spawnSiteText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function spawnSiteFactionKey(template) {
  const faction = spawnSiteText(template && template.faction, "").toLowerCase().trim();
  return SPAWN_SITE_FACTION_KEYS[faction] || (faction.split(/\s+/)[0] || "");
}

function collectTemplateNpcSpawns(template) {
  const out = [];
  const faction = spawnSiteFactionKey(template);
  const rooms = Array.isArray(template && template.rooms) ? template.rooms : [];
  for (const room of rooms) {
    const groups = Array.isArray(room && room.groups) && room.groups.length
      ? room.groups
      : [{ spawnEntries: (room && room.spawnEntries) || [] }];
    for (const group of groups) {
      for (const entry of (group && group.spawnEntries) || []) {
        if (spawnSiteText(entry && entry.entityKind, "npc").toLowerCase() !== "npc") {
          continue;
        }
        const amount = Math.max(1, Number(entry && entry.count && entry.count.min) || Number(entry && entry.count) || 1);
        const names = Array.isArray(entry && entry.candidateNames) ? entry.candidateNames : [];
        out.push({
          amount,
          query: spawnSiteText(names[0], "") || spawnSiteText(entry && entry.label, ""),
          faction,
          label: spawnSiteText(entry && entry.label, "NPC"),
        });
      }
    }
  }
  const encounters = template && template.populationHints && Array.isArray(template.populationHints.encounters)
    ? template.populationHints.encounters
    : [];
  for (const enc of encounters) {
    const query = spawnSiteText(enc && enc.spawnQuery, "");
    if (query) {
      out.push({ amount: Math.max(1, Number(enc && (enc.amount || enc.count)) || 1), query, faction, label: query });
    }
  }
  return out;
}

function handleSpawnSiteCommand(session, argumentText, chatHub, options) {
  const [requestedTemplateID, requestedOffsetMeters] = spawnSiteText(argumentText, "")
    .split(/\s+/, 2);
  const templateID = /^\d+$/.test(requestedTemplateID)
    ? `client-dungeon:${Number(requestedTemplateID)}`
    : requestedTemplateID;
  if (!templateID) {
    return handledResult(chatHub, session, options, "Usage: /spawnsite <templateID> [offsetMeters]  (e.g. eve-survival:Score1gu)");
  }
  let template = null;
  try {
    template = dungeonAuthorityForSpawnSite.getTemplateByID(templateID);
  } catch (_error) {
    template = null;
  }
  if (!template) {
    return handledResult(chatHub, session, options, `Template not found: ${templateID}`);
  }
  const miningRocks = template && template.populationHints && Array.isArray(template.populationHints.miningRocks)
    ? template.populationHints.miningRocks
    : [];
  const hasExactClientContent = Boolean(
    template &&
    template.clientDungeonContent &&
    template.clientDungeonContent.audit &&
    template.clientDungeonContent.audit.valid === true,
  );
  const numericSpawnOffsetMeters = Number(requestedOffsetMeters);
  const materializeNamedSite = Number.isFinite(numericSpawnOffsetMeters) && numericSpawnOffsetMeters >= 0;
  if (miningRocks.length > 0 || hasExactClientContent || materializeNamedSite) {
    // A caller that supplies an offset is deliberately asking for the named
    // scannable site. Do not credit dungeon entry until it is scanned and
    // warped to through the normal client flow.
    const result = dungeonUniverseSiteServiceForSpawnSite.spawnTemplateForSession(
      session,
      templateID,
      {
        broadcast: true,
        spawnEncounters: true,
        ...(materializeNamedSite
          ? {
              markCurrentDungeonRoom: false,
              spawnOffsetMeters: numericSpawnOffsetMeters,
            }
          : {}),
      },
    );
    if (!result || result.success !== true) {
      const errorMsg = result && result.errorMsg || "UNKNOWN_ERROR";
      const message = errorMsg === "NOT_IN_SPACE"
        ? "You must be in space before using /spawnsite."
        : errorMsg === "SHIP_NOT_FOUND"
          ? "Your active ship was not found in space."
          : `/spawnsite ${templateID} failed: ${errorMsg}.`;
      return handledResult(chatHub, session, options, message);
    }
    const materialized = result.data && result.data.materialized || {};
    const contentSummary = materialized.contentSummary || {};
    const locationDescription = materializeNamedSite
      ? "materialized in space"
      : "materialized at your ship";
    return handledResult(
      chatHub,
      session,
      options,
      `/spawnsite ${templateID}: site ${result.data.siteID} ${locationDescription} with ` +
        `${materialized.miningRockEntityCount || 0} mining rock(s), ` +
        `${contentSummary.environmentPropsSpawned || 0} environment prop(s), and ` +
        `${contentSummary.encountersSpawned || 0} encounter NPC(s).`,
    );
  }
  const groups = collectTemplateNpcSpawns(template);
  if (!groups.length) {
    return handledResult(chatHub, session, options, `No NPC spawns found in ${templateID}.`);
  }
  let spawned = 0;
  const failures = [];
  for (const group of groups) {
    let result = npcService.runtime.spawnBatchForSession(session, {
      profileQuery: group.query,
      amount: group.amount,
      transient: true,
      preferPools: true,
    });
    if ((!result || !result.success) && group.faction && group.query !== group.faction) {
      result = npcService.runtime.spawnBatchForSession(session, {
        profileQuery: group.faction,
        amount: group.amount,
        transient: true,
        preferPools: true,
      });
    }
    if (result && result.success) {
      spawned += group.amount;
    } else {
      failures.push(`${group.amount}x ${group.label} (${(result && result.errorMsg) || "failed"})`);
    }
  }
  const message = `/spawnsite ${templateID}: spawned ${spawned} NPC(s) from ${groups.length} group(s).`
    + (failures.length ? ` Failed: ${failures.join("; ")}.` : "");
  return handledResult(chatHub, session, options, message);
}

function handleNpcCommand(session, argumentText, chatHub, options) {
  const parsedArguments = parseNpcSpawnArguments(argumentText, {
    defaultAmount: 5,
  });
  if (!parsedArguments.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /npc [amount] [faction|profile|pool]",
    );
  }
  if (parsedArguments.amount > MAX_NPC_COMMAND_SPAWN_COUNT) {
    return handledResult(
      chatHub,
      session,
      options,
      `NPC spawn count must be between 1 and ${MAX_NPC_COMMAND_SPAWN_COUNT}.`,
    );
  }

  const result = npcService.runtime.spawnBatchForSession(session, {
    profileQuery: parsedArguments.query,
    amount: parsedArguments.amount,
    transient: true,
    preferPools: true,
  });
  if (!result.success) {
    const suggestions = formatSuggestions(result.suggestions);
    let message = "NPC spawn failed.";
    if (result.errorMsg === "NOT_IN_SPACE") {
      message = "You must be in space before using /npc.";
    } else if (result.errorMsg === "SHIP_NOT_FOUND") {
      message = "Active ship was not found in space.";
    } else if (result.errorMsg === "PROFILE_NOT_FOUND") {
      message = `NPC profile or pool not found: ${parsedArguments.query || "default"}.${suggestions}`;
    } else if (result.errorMsg === "PROFILE_AMBIGUOUS") {
      message = `NPC profile or pool is ambiguous: ${parsedArguments.query}.${suggestions}`;
    } else if (result.errorMsg === "PROFILE_HULL_NOT_DAMAGEABLE") {
      message = "The selected NPC profile's entity type declares no shield, armor or structure hit points, so the spawned NPC could not be shot or killed.";
    } else if (result.errorMsg === "NPC_DEFINITION_INCOMPLETE") {
      message = "The selected NPC profile is missing authored loadout or behavior data.";
    } else if (result.errorMsg === "NPC_NATIVE_NO_FREE_SLOT") {
      message = "The selected NPC profile has an authored module loadout that does not fit the hull under the current slot resolver.";
    } else if (result.errorMsg === "NPC_NATIVE_MODULE_TYPE_NOT_FOUND") {
      message = "The selected NPC profile references a module type that is missing from local item data.";
    } else if (result.errorMsg === "NPC_NATIVE_CAPABILITY_TYPE_NOT_FOUND") {
      message = "The selected NPC profile references an NPC capability module type that is missing from local item data.";
    } else if (result.errorMsg === "POOL_EMPTY") {
      message = `The selected NPC pool has no spawnable authored entries.${suggestions}`.trim();
    } else {
      message = `NPC spawn failed: ${result.errorMsg || "UNKNOWN_ERROR"}.${suggestions}`.trim();
    }
    return handledResult(chatHub, session, options, message);
  }

  return handledResult(
    chatHub,
    session,
    options,
    formatNpcSpawnSummary(result, "/npc"),
  );
}

function handleMissileNpcCommand(session, argumentText, chatHub, options) {
  const parsedArguments = parseNpcSpawnArguments(argumentText, {
    defaultAmount: 5,
  });
  if (!parsedArguments.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /mnpc [amount] [faction|profile|pool]",
    );
  }
  if (parsedArguments.amount > MAX_NPC_COMMAND_SPAWN_COUNT) {
    return handledResult(
      chatHub,
      session,
      options,
      `NPC spawn count must be between 1 and ${MAX_NPC_COMMAND_SPAWN_COUNT}.`,
    );
  }

  const result = npcService.runtime.spawnBatchForSession(session, {
    profileQuery: parsedArguments.query,
    amount: parsedArguments.amount,
    transient: true,
    defaultPoolID: "npc_missile_hostiles",
    fallbackProfileID: "guristas_missile_battleship",
    preferPools: true,
    requiredWeaponFamily: "missileLauncher",
  });
  if (!result.success) {
    const suggestions = formatSuggestions(result.suggestions);
    let message = "Missile NPC spawn failed.";
    if (result.errorMsg === "NOT_IN_SPACE") {
      message = "You must be in space before using /mnpc.";
    } else if (result.errorMsg === "SHIP_NOT_FOUND") {
      message = "Active ship was not found in space.";
    } else if (result.errorMsg === "PROFILE_NOT_FOUND") {
      message = `Missile NPC profile or pool not found: ${parsedArguments.query || "default"}.${suggestions}`;
    } else if (result.errorMsg === "PROFILE_AMBIGUOUS") {
      message = `Missile NPC profile or pool is ambiguous: ${parsedArguments.query}.${suggestions}`;
    } else if (result.errorMsg === "PROFILE_NOT_ELIGIBLE") {
      message = "The selected /mnpc profile is not missile-capable.";
    } else if (result.errorMsg === "PROFILE_HULL_NOT_DAMAGEABLE") {
      message = "The selected missile NPC profile's entity type declares no shield, armor or structure hit points, so the spawned NPC could not be shot or killed.";
    } else if (result.errorMsg === "NPC_DEFINITION_INCOMPLETE") {
      message = "The selected missile NPC profile is missing authored loadout or behavior data.";
    } else if (result.errorMsg === "NPC_NATIVE_NO_FREE_SLOT") {
      message = "The selected missile NPC profile has an authored module loadout that does not fit the hull under the current slot resolver.";
    } else if (result.errorMsg === "NPC_NATIVE_MODULE_TYPE_NOT_FOUND") {
      message = "The selected missile NPC profile references a module type that is missing from local item data.";
    } else if (result.errorMsg === "NPC_NATIVE_CAPABILITY_TYPE_NOT_FOUND") {
      message = "The selected missile NPC profile references an NPC capability module type that is missing from local item data.";
    } else if (result.errorMsg === "POOL_EMPTY") {
      message = `The selected missile NPC pool has no spawnable authored entries.${suggestions}`.trim();
    } else {
      message = `Missile NPC spawn failed: ${result.errorMsg || "UNKNOWN_ERROR"}.${suggestions}`.trim();
    }
    return handledResult(chatHub, session, options, message);
  }

  return handledResult(
    chatHub,
    session,
    options,
    formatNpcSpawnSummary(result, "/mnpc"),
  );
}

function handleCapitalNpcCommand(session, argumentText, chatHub, options, commandName = "capnpc") {
  const result = executeCapitalNpcCommand(session, commandName, argumentText);
  return handledResult(
    chatHub,
    session,
    options,
    result && result.message ? result.message : `${commandName} completed.`,
  );
}

function handleNpcTestCommand(session, argumentText, chatHub, options, mode = "player") {
  const normalizedMode = String(mode || "player").trim().toLowerCase();
  const commandLabel = normalizedMode === "ffa" ? "/npctest2" : "/npctest";
  const parsedArguments = parseNpcSpawnArguments(argumentText, {
    defaultAmount: NPCTEST_DEFAULT_AMOUNT,
  });
  if (!parsedArguments.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Usage: ${commandLabel} [amount]`,
    );
  }
  if (parsedArguments.amount > MAX_NPC_COMMAND_SPAWN_COUNT) {
    return handledResult(
      chatHub,
      session,
      options,
      `${commandLabel} spawn count must be between 1 and ${MAX_NPC_COMMAND_SPAWN_COUNT}.`,
    );
  }
  if (normalizedMode === "ffa" && parsedArguments.amount < 2) {
    return handledResult(
      chatHub,
      session,
      options,
      "/npctest2 needs at least 2 NPCs.",
    );
  }

  const result = spawnNpcTestForSession(session, {
    amount: parsedArguments.amount,
    mode: normalizedMode,
  });
  if (!result.success || !result.data) {
    let message = `${commandLabel} failed.`;
    if (result.errorMsg === "NOT_IN_SPACE") {
      message = `You must be in space before using ${commandLabel}.`;
    } else if (result.errorMsg === "SHIP_NOT_FOUND") {
      message = "Active ship was not found in space.";
    } else if (result.errorMsg === "NPC_TEST_POOL_EMPTY") {
      message = "No authored combat NPC profiles with working weapons were found for npc test spawning.";
    } else {
      message = `${commandLabel} failed: ${result.errorMsg || "UNKNOWN_ERROR"}.`;
    }
    return handledResult(chatHub, session, options, message);
  }

  const clearedLabel = result.data.clearedCount > 0
    ? ` Cleared ${result.data.clearedCount} previous ${commandLabel} NPC${result.data.clearedCount === 1 ? "" : "s"}.`
    : "";
  if (normalizedMode === "ffa") {
    return handledResult(
      chatHub,
      session,
      options,
      [
        `Spawned ${result.data.spawnedAmount} stationary /npctest2 NPCs in a sphere centered about 20 km ahead of your ship.`,
        `Missile hulls: ${result.data.missileSpawnCount} from ${result.data.missileProfileCount} authored missile NPC profiles.`,
        "They will hold position, fire at other /npctest2 NPCs, and retarget until one champion remains or they mutually destroy each other.",
        clearedLabel.trim(),
      ].filter(Boolean).join(" "),
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    [
      `Spawned ${result.data.spawnedAmount} stationary /npctest NPCs in a sphere centered about 20 km ahead of your ship.`,
      `Missile hulls: ${result.data.missileSpawnCount} from ${result.data.missileProfileCount} authored missile NPC profiles.`,
      "Short-range hulls are range-clamped inward so they can still shoot while staying stationary.",
      clearedLabel.trim(),
    ].filter(Boolean).join(" "),
  );
}

function handleNpcWarpCommand(session, argumentText, chatHub, options, commandName = "npcw") {
  const normalizedCommandName = String(commandName || "npcw").trim().toLowerCase();
  const commandLabel = normalizedCommandName === "wnpc" ? "/wnpc" : "/npcw";
  const parsedArguments = parseNpcSpawnArguments(argumentText);
  if (!parsedArguments.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Usage: ${commandLabel} [amount] [profile|pool]`,
    );
  }
  if (parsedArguments.amount > MAX_NPC_COMMAND_SPAWN_COUNT) {
    return handledResult(
      chatHub,
      session,
      options,
      `NPC warp spawn count must be between 1 and ${MAX_NPC_WARP_COMMAND_SPAWN_COUNT}.`,
    );
  }

  const result = npcService.runtime.spawnWarpBatchForSession(session, {
    profileQuery: parsedArguments.query,
    amount: parsedArguments.amount,
    transient: true,
  });
  if (!result.success) {
    const suggestions = formatSuggestions(result.suggestions);
    let message = "NPC warp spawn failed.";
    if (result.errorMsg === "NOT_IN_SPACE") {
      message = `You must be in space before using ${commandLabel}.`;
    } else if (result.errorMsg === "SHIP_NOT_FOUND") {
      message = "Active ship was not found in space.";
    } else if (result.errorMsg === "PROFILE_NOT_FOUND") {
      message = `NPC profile or pool not found: ${parsedArguments.query || "default"}.${suggestions}`;
    } else if (result.errorMsg === "PROFILE_AMBIGUOUS") {
      message = `NPC profile or pool is ambiguous: ${parsedArguments.query}.${suggestions}`;
    } else if (result.errorMsg === "PROFILE_HULL_NOT_DAMAGEABLE") {
      message = "The selected NPC profile's entity type declares no shield, armor or structure hit points, so the spawned NPC could not be shot or killed.";
    } else if (result.errorMsg === "NPC_DEFINITION_INCOMPLETE") {
      message = "The selected NPC profile is missing authored loadout or behavior data.";
    } else if (result.errorMsg === "POOL_EMPTY") {
      message = `The selected NPC pool has no spawnable authored entries.${suggestions}`.trim();
    } else {
      message = `NPC warp spawn failed: ${result.errorMsg || "UNKNOWN_ERROR"}.${suggestions}`.trim();
    }
    return handledResult(chatHub, session, options, message);
  }

  const chaseOverrideResult =
    normalizedCommandName === "wnpc"
      ? applyWarpCommandChaseOverride(result)
      : null;
  let summary = formatNpcWarpSpawnSummary(result, commandLabel);
  if (chaseOverrideResult && chaseOverrideResult.appliedCount > 0) {
    summary = `${summary} Chase propulsion override enabled for ${chaseOverrideResult.appliedCount} warped NPC${chaseOverrideResult.appliedCount === 1 ? "" : "s"}.`;
  } else if (chaseOverrideResult && chaseOverrideResult.failedCount > 0) {
    summary = `${summary} Chase propulsion override could not be applied.`;
  }

  return handledResult(
    chatHub,
    session,
    options,
    summary,
  );
}

function handleConcordCommand(session, argumentText, chatHub, options) {
  const parsedArguments = parseNpcSpawnArguments(argumentText);
  if (!parsedArguments.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /concord [amount] [profile|pool]",
    );
  }
  if (parsedArguments.amount > MAX_CONCORD_COMMAND_SPAWN_COUNT) {
    return handledResult(
      chatHub,
      session,
      options,
      `CONCORD spawn count must be between 1 and ${MAX_CONCORD_COMMAND_SPAWN_COUNT}.`,
    );
  }

  const result = npcService.runtime.spawnConcordBatchForSession(session, {
    profileQuery: parsedArguments.query,
    amount: parsedArguments.amount,
    transient: true,
  });
  if (!result.success) {
    const suggestions = formatSuggestions(result.suggestions);
    let message = "CONCORD spawn failed.";
    if (result.errorMsg === "NOT_IN_SPACE") {
      message = "You must be in space before using /concord.";
    } else if (result.errorMsg === "SHIP_NOT_FOUND") {
      message = "Active ship was not found in space.";
    } else if (result.errorMsg === "PROFILE_NOT_FOUND") {
      message = `CONCORD profile or pool not found: ${parsedArguments.query || "concord"}.${suggestions}`;
    } else if (result.errorMsg === "PROFILE_AMBIGUOUS") {
      message = `CONCORD profile or pool is ambiguous: ${parsedArguments.query}.${suggestions}`;
    } else if (result.errorMsg === "POOL_EMPTY") {
      message = `The selected CONCORD pool has no spawnable authored entries.${suggestions}`.trim();
    } else {
      message = `CONCORD spawn failed: ${result.errorMsg || "UNKNOWN_ERROR"}.${suggestions}`.trim();
    }
    return handledResult(chatHub, session, options, message);
  }

  return handledResult(
    chatHub,
    session,
    options,
    formatNpcSpawnSummary(result, "/concord"),
  );
}

async function handleNpcClearCommand(session, argumentText, chatHub, options) {
  const parsed = parseNpcClearArguments(argumentText);
  if (!parsed.success || !parsed.entityType) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /npcclear <system [npc|concord|all]|radius <meters> [npc|concord|all]>",
    );
  }

  const systemID = resolveSessionSolarSystemID(session);
  if (!systemID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Current solar system could not be resolved for /npcclear.",
    );
  }

  let result = null;
  let resolvedScene = null;
  if (parsed.scope === "radius") {
    if (!isSpaceSessionReady(session) || !resolveSessionShipEntity(session)) {
      return handledResult(
        chatHub,
        session,
        options,
        "You must be in space before using /npcclear radius.",
      );
    }

    result = await npcService.clearNpcControllersForSessionRadiusAsync(session, {
      entityType: parsed.entityType,
      radiusMeters: parsed.radiusMeters,
      removeContents: true,
      notifyAbyssal: true,
      destructionReason: "admin_clear",
    });
  } else {
    resolvedScene =
      spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
    result =
      resolvedScene && typeof npcService.clearNpcControllersInSceneAsync === "function"
        ? await npcService.clearNpcControllersInSceneAsync(resolvedScene, {
          entityType: parsed.entityType,
          removeContents: true,
          notifyAbyssal: true,
          destructionReason: "admin_clear",
        })
        : await npcService.clearNpcControllersInSystemAsync(systemID, {
          entityType: parsed.entityType,
          removeContents: true,
          notifyAbyssal: true,
          destructionReason: "admin_clear",
        });
  }

  if (!result || !result.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `NPC clear failed: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}.`,
    );
  }

  const resolvedSceneKey = String(resolvedScene && resolvedScene.sceneKey || "").trim();
  const scopeText = parsed.scope === "radius"
    ? `within ${formatDistanceMeters(parsed.radiusMeters)}`
    : resolvedSceneKey
      ? `in scene ${resolvedSceneKey}`
      : `in system ${systemID}`;
  const entityLabel = parsed.entityType === "all"
    ? "NPC/CONCORD"
    : parsed.entityType === ENTITY_TYPE.CONCORD
      ? "CONCORD"
      : "NPC";
  return handledResult(
    chatHub,
    session,
    options,
    `Cleared ${result.data.destroyedCount} ${entityLabel} controller${result.data.destroyedCount === 1 ? "" : "s"} ${scopeText}.`,
  );
}

function formatGateOperatorStatus(label, state) {
  const sourceLabel = state && state.source === "generated"
    ? "generated default startup coverage"
    : state && state.source === "authored"
      ? "data-authored startup rules"
      : state && state.source === "startup"
        ? "startup rules"
        : "dynamic operator rule";
  const enabledText = state && state.enabled ? "ON" : "OFF";
  return `${label} is ${enabledText} in system ${state && state.systemID ? state.systemID : "unknown"} (${sourceLabel}, live respawn enabled while active).`;
}

function handleGateOperatorCommand(session, argumentText, chatHub, options, operatorKind) {
  const systemID = resolveSessionSolarSystemID(session);
  if (!systemID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Current solar system could not be resolved for gate operator controls.",
    );
  }

  const parsed = parseToggleCommandArgument(argumentText);
  if (!parsed.success) {
    const usageLabel = operatorKind === npcService.GATE_OPERATOR_KIND.CONCORD
      ? "/gateconcord [on|off]"
      : "/gaterats [on|off]";
    return handledResult(chatHub, session, options, `Usage: ${usageLabel}`);
  }

  const label = operatorKind === npcService.GATE_OPERATOR_KIND.CONCORD
    ? "Gate CONCORD"
    : "Gate rats";
  const result = parsed.mode === "status"
    ? npcService.getGateOperatorState(systemID, operatorKind)
    : npcService.setGateOperatorEnabled(systemID, operatorKind, parsed.mode === "on");
  if (!result || !result.success || !result.data) {
    return handledResult(
      chatHub,
      session,
      options,
      `${label} command failed: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}.`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    formatGateOperatorStatus(label, result.data),
  );
}

module.exports = {
  handleSpawnSiteCommand,
  handleNpcCommand,
  handleMissileNpcCommand,
  handleCapitalNpcCommand,
  handleNpcTestCommand,
  handleNpcWarpCommand,
  handleConcordCommand,
  handleNpcClearCommand,
  handleGateOperatorCommand,
};
