"use strict";

/**
 * Phase 0 — gameStore table ownership map (curated source of truth).
 *
 * Declares, for every gameStore table, which subsystem OWNS it (is the
 * authoritative mutator) and whether it is runtime or static. This is the
 * foundation for decoupling state ownership ahead of any multi-core work:
 * the `in-space` runtime tables are the ones that must travel with a sol
 * node. A `shared` (multi-writer) seam would be a cross-domain transaction
 * that gates partitioning — but the Phase 0 reroute drove every table to a
 * single owner, so NO table is classified `shared` today (the category is a
 * dormant capability; see the formerly-shared block below).
 *
 * HOW THIS WAS DERIVED
 *   - `scanner`  — writer attributed by the static analysis in
 *     scripts/Ownership/scan-table-access.js (literal/constant first args).
 *   - `inferred` — the writer is hidden behind a param-helper store
 *     (e.g. space/npc/nativeNpcStore.js, services/bookmark/bookmarkRuntimeStore.js
 *     forward a `tableName` parameter to database.write); the domain is taken
 *     from the owning module's location. Verified by reading the store module.
 *   - `review`   — runtime-persisted but the owning domain is not yet
 *     confidently attributed; needs a human pass.
 *   Runtime vs static is principled: a table is runtime iff it is in
 *   gameStore's SQLITE_TABLES set. (As of the 2026-06-25 backfill, every
 *   runtime table is SQLite-backed — npcCargo/npcWrecks/npcWreckItems and
 *   corporations, previously missed, were migrated.) Everything else is
 *   static SDE/reference data, loaded read-only into memory.
 *
 * LIMITATION: the scanner cannot trace tables written through cross-file
 * param-helpers, so `inferred`/`review` entries are best-effort and meant to
 * be refined. The guard test only enforces COMPLETENESS (every real table is
 * classified) and NO-STALE (no entry for a non-existent table), not the
 * correctness of the domain label — exactly like fixtureIdentityGuard.
 *
 * Consumed by the ownership guard test (Phase 0 / 0.D, live/green) and the
 * repository layer (0.C, adopted by ~33 owner modules). The remaining planned
 * consumer is frozen-view / in-place-mutation detection (0.B), still open.
 */

const TIERS = Object.freeze({ RUNTIME: "runtime", STATIC: "static" });
const CONFIDENCE = Object.freeze({
  SCANNER: "scanner",
  INFERRED: "inferred",
  REVIEW: "review",
});

const TABLE_OWNERSHIP = {};
// EveJS RPG fork: generated contracts (server/src/rpg/contracts).
TABLE_OWNERSHIP.rpgContracts = {
  table: "rpgContracts", tier: TIERS.RUNTIME, domain: "service:rpg-contracts",
  confidence: CONFIDENCE.INFERRED, note: "Generated story contracts per pilot: offers, site links, payout state and memories.",
};
// EveJS RPG fork: what Living Universe pilots remember of talking with a player (server/src/rpg/pilots).
TABLE_OWNERSHIP.rpgPilotMemory = {
  table: "rpgPilotMemory", tier: TIERS.RUNTIME, domain: "service:rpg-pilot-voices",
  confidence: CONFIDENCE.INFERRED, note: "Per pilot and player: the last few lines they said to each other in Local.",
};
TABLE_OWNERSHIP.crewEquipmentRuntime = {
  table: "crewEquipmentRuntime", tier: TIERS.RUNTIME, domain: "service:crew-equipment",
  confidence: CONFIDENCE.INFERRED, note: "Crew equipment tiers, profit reinvestment policy and recoverable supplier payments.",
};
TABLE_OWNERSHIP.manufacturingCrewRuntime = {
  table: "manufacturingCrewRuntime", tier: TIERS.RUNTIME, domain: "service:crew-manufacturing",
  confidence: CONFIDENCE.INFERRED, note: "Persistent manufacturing teams, production targets and native installation intents.",
};
TABLE_OWNERSHIP.sellingCrewRuntime = {
  table: "sellingCrewRuntime", tier: TIERS.RUNTIME, domain: "service:crew-selling",
  confidence: CONFIDENCE.INFERRED, note: "Persistent selling crews, surplus policies and exact native market fill intents.",
};
TABLE_OWNERSHIP.buyingCrewRuntime = {
  table: "buyingCrewRuntime", tier: TIERS.RUNTIME, domain: "service:crew-buying",
  confidence: CONFIDENCE.INFERRED, note: "Persistent procurement crews, income budgets and native purchase intents.",
};
TABLE_OWNERSHIP.refiningCrewRuntime = {
  table: "refiningCrewRuntime", tier: TIERS.RUNTIME, domain: "service:crew-refining",
  confidence: CONFIDENCE.INFERRED, note: "Persistent refinery teams, ore custody and acknowledged native reprocessing batches.",
};
TABLE_OWNERSHIP.miningCrewRuntime = {
  table: "miningCrewRuntime", tier: TIERS.RUNTIME, domain: "service:crew-mining",
  confidence: CONFIDENCE.INFERRED,
  note: "Persistent player mining teams, finite extraction intents and station delivery confirmations.",
};
TABLE_OWNERSHIP.crewRuntime = {
  table: "crewRuntime", tier: TIERS.RUNTIME, domain: "service:crew",
  confidence: CONFIDENCE.INFERRED,
  note: "Persistent courier crews, route/custody intents and durable command receipts; one aggregate row per owner.",
};

TABLE_OWNERSHIP.projectDiscoveryState = {
  table: "projectDiscoveryState", tier: TIERS.RUNTIME, domain: "service:character",
  confidence: CONFIDENCE.INFERRED,
  note: "Authored Project Discovery daily issuance budget and pending durable grants.",
};

TABLE_OWNERSHIP.freelanceProjects = {
  table: "freelanceProjects", tier: TIERS.RUNTIME, domain: "service:freelance",
  confidence: CONFIDENCE.INFERRED,
  note: "Funded freelance projects, participation and recoverable delivery/settlement intents.",
};

function define(tables, { tier, domain = null, confidence, note = null }) {
  for (const table of tables) {
    if (TABLE_OWNERSHIP[table]) {
      throw new Error(`tableOwnership: duplicate classification for "${table}"`);
    }
    TABLE_OWNERSHIP[table] = { table, tier, domain, confidence, note };
  }
}

// ── Formerly-shared seams, now single-writer ─────────────────────────
// These four were multi-writer aggregates; the Phase 0 reroute (6d8a05d0)
// funneled every writer through one owner API, so each is single-writer today
// (domain != "shared"). Documented individually because each remains a Phase 3
// transaction boundary — especially `items`, the 0.E item-custody seam.
TABLE_OWNERSHIP.characters = {
  table: "characters",
  tier: TIERS.RUNTIME,
  domain: "service:character",
  confidence: CONFIDENCE.SCANNER,
  note: "Multi-domain aggregate, but funneled through characterState's owner API (writeCharacterRecord/removeCharacterRecord). As of the Phase 0 reroute (6d8a05d0) ONLY the character domain writes this table; skills/structure/inventory/legacy-npc now call the owner API. Single-writer achieved.",
};
TABLE_OWNERSHIP.items = {
  table: "items",
  tier: TIERS.RUNTIME,
  domain: "service:inventory",
  confidence: CONFIDENCE.SCANNER,
  note: "Sole table-writer is itemStore.js (the items owner). Other domains (dogma, space, market) mutate items only through itemStore's CRUD + custody API (createSpaceItemForCharacter / updateInventoryItem / removeInventoryItem / moveItemToLocation / moveShipToSpace). The item-custody boundary (Phase 0 / 0.E).",
};
TABLE_OWNERSHIP.skills = {
  table: "skills",
  tier: TIERS.RUNTIME,
  domain: "service:skills",
  confidence: CONFIDENCE.SCANNER,
  note: "Owned by skillState (sole table-writer). Other domains delete skills records via skillState.removeSkillsRecord (Phase 0 reroute). Single-writer achieved.",
};
TABLE_OWNERSHIP.accounts = {
  table: "accounts",
  tier: TIERS.RUNTIME,
  domain: "service:login",
  confidence: CONFIDENCE.SCANNER,
  note: "Login/auth account records, owned by services/login/accountStore (sole writer). The TCP handshake and chat admin write via accountStore; userService reads. Single swap point for a future relational accounts table. Single-writer achieved.",
};

// ── Runtime · in-space (must travel with a sol node) ─────────────────
define(["npcControlState"], {
  tier: TIERS.RUNTIME,
  domain: "in-space",
  confidence: CONFIDENCE.SCANNER,
});
define(
  [
    "npcEntities",
    "npcModules",
    "npcRuntimeState",
    "npcRuntimeControllers",
    "npcCargo",
    "npcWrecks",
    "npcWreckItems",
    "npcSpawnSites",
  ],
  {
    tier: TIERS.RUNTIME,
    domain: "in-space",
    confidence: CONFIDENCE.INFERRED,
    note: "NPC runtime, written via space/npc/nativeNpcStore.js param-helper.",
  },
);
define(["authoredSpaceProps"], {
  tier: TIERS.STATIC,
  domain: "sde",
  confidence: CONFIDENCE.INFERRED,
  note: "Static authored scenery — per-system JSON (Jita.json, Perimeter.json, …) under gameStore/data/authoredSpaceProps/, loaded directly via fs by space/authoredSpaceProps.js, NOT the gameStore API. Removed from SQLITE_TABLES 2026-06-25 (vestigial; no writer).",
});

// ── Runtime · single-service domains (scanner-attributed) ────────────
define(["accessGroups", "characterEnergyState", "characterNotes"], {
  tier: TIERS.RUNTIME, domain: "service:character", confidence: CONFIDENCE.SCANNER,
});
define(["characterExpertSystems", "corpSkillPlans", "skillPlans", "skillQueues", "skillTradingState"], {
  tier: TIERS.RUNTIME, domain: "service:skills", confidence: CONFIDENCE.SCANNER,
});
define(["calendarEvents", "calendarResponses"], {
  tier: TIERS.RUNTIME, domain: "service:calendar", confidence: CONFIDENCE.SCANNER,
});
define(["contractRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:contracts", confidence: CONFIDENCE.SCANNER,
});
define(["corporationBills"], {
  tier: TIERS.RUNTIME, domain: "service:account", confidence: CONFIDENCE.SCANNER,
});
define(["walletAuthorityState"], {
  tier: TIERS.RUNTIME,
  domain: "service:account",
  confidence: CONFIDENCE.INFERRED,
  note: "Process-owned durable character and corporation wallet projections and command receipts.",
});
define(["allianceDepartures", "allianceFoundings", "corporationFoundings", "corporationGoals", "corporationLiquidations", "corporationVotes", "lpWallets"], {
  tier: TIERS.RUNTIME, domain: "service:corporation", confidence: CONFIDENCE.SCANNER,
});
define(["dailyGoals"], {
  tier: TIERS.RUNTIME, domain: "service:dailyGoals", confidence: CONFIDENCE.SCANNER,
});
define(["homefrontReplay"], {
  tier: TIERS.RUNTIME,
  domain: "service:homefront",
  confidence: CONFIDENCE.INFERRED,
  note: "Homefront encounter state, immutable reward receipts and settlement outbox.",
});
define(["incursionReplay"], {
  tier: TIERS.RUNTIME,
  domain: "service:incursion",
  confidence: CONFIDENCE.INFERRED,
  note: "Incursion encounter progress, frozen fleet reward receipts, delayed LP pools and settlement outboxes.",
});
define(["incursionLifecycle"], {
  tier: TIERS.RUNTIME,
  domain: "service:incursion",
  confidence: CONFIDENCE.INFERRED,
  note: "World-owned incursion identities, frozen lifecycle policies, deadlines, terminal tombstones and projection/slot intents.",
});
define(["achievements"], {
  tier: TIERS.RUNTIME, domain: "service:achievement", confidence: CONFIDENCE.SCANNER,
  note: "Native achievement progress, reward claim receipts, and character titles.",
});
define(["campaignTrailProgress", "eventLifecycle"], {
  tier: TIERS.RUNTIME, domain: "service:seasons", confidence: CONFIDENCE.INFERRED,
  note: "Per-character election progress plus immutable conclusions and event deadline acknowledgments.",
});
define(["fwOpenReplay"], {
  tier: TIERS.RUNTIME, domain: "service:faction", confidence: CONFIDENCE.INFERRED,
  note: "Offline FW Open Complex occupation baseline, completion receipts and participant reward outbox.",
});
define(["contrabandPenalties", "customsInspectionCases"], {
  tier: TIERS.RUNTIME, domain: "service:security", confidence: CONFIDENCE.INFERRED,
  note: "Durable customs cases, confiscation, wallet-fine, and standing penalty settlements.",
});
define(["crimewatchRuntime"], {
  tier: TIERS.RUNTIME,
  domain: "service:security",
  confidence: CONFIDENCE.INFERRED,
  note: "Durable Crimewatch safety, combat-timer, and criminal/suspect flag state.",
});
define(["contractSettlements"], {
  tier: TIERS.RUNTIME,
  domain: "service:contracts",
  confidence: CONFIDENCE.INFERRED,
  note: "Durable contract creation and lifecycle wallet/custody settlements.",
});
define(["reprocessingSettlements"], {
  tier: TIERS.RUNTIME, domain: "service:reprocessing", confidence: CONFIDENCE.INFERRED,
  note: "Durable input/output escrow and wallet settlement for reprocessing.",
});
define(["missionRewardSettlements"], {
  tier: TIERS.RUNTIME, domain: "service:agent", confidence: CONFIDENCE.INFERRED,
  note: "Durable mission cargo, reward, wallet, LP, standing, and completion settlements.",
});
define(["planetaryCustomsSettlements"], {
  tier: TIERS.RUNTIME, domain: "service:planet", confidence: CONFIDENCE.INFERRED,
  note: "Durable planetary customs tax, import, export, and escrow settlements.",
});
define(["abyssalFilamentCompensations"], {
  tier: TIERS.RUNTIME,
  domain: "service:activity",
  confidence: CONFIDENCE.INFERRED,
  note: "Durable Abyssal filament compensation claims keyed by deployment token.",
});
define(["abyssalRecoveryTombstones"], {
  tier: TIERS.RUNTIME,
  domain: "service:activity",
  confidence: CONFIDENCE.INFERRED,
  note:
    "Durable Abyssal run-recovery tombstones, indexed by character, ship, and host " +
    "location, used to evacuate a stranded pilot after a crash or restart. Written " +
    "by abyssalMgrService via raw database.ensureTable/read/write and persisted in " +
    "SQLite.",
});
define(["dungeonRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:dungeon", confidence: CONFIDENCE.SCANNER,
});
define(["evermarkEntitlements", "evermarkPurchases", "lpStorePurchases"], {
  tier: TIERS.RUNTIME, domain: "service:evermarks", confidence: CONFIDENCE.SCANNER,
});
define(["identityState"], {
  tier: TIERS.RUNTIME, domain: "service:_shared", confidence: CONFIDENCE.SCANNER,
  note: "Identity allocator (services/_shared/identityAllocator.js).",
});
define(["insuranceContracts"], {
  tier: TIERS.RUNTIME, domain: "service:insurance", confidence: CONFIDENCE.SCANNER,
});
define(["dynamicResourceRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:dynamic", confidence: CONFIDENCE.SCANNER,
});
define(["killmails"], {
  tier: TIERS.RUNTIME, domain: "service:killmail", confidence: CONFIDENCE.SCANNER,
});
define(["killRights", "pendingNpcBounties", "playerBounties"], {
  tier: TIERS.RUNTIME, domain: "service:bounty", confidence: CONFIDENCE.SCANNER,
});
define(["mail"], {
  tier: TIERS.RUNTIME, domain: "service:mail", confidence: CONFIDENCE.SCANNER,
});
define(["mapTelemetry", "solarSystemInterferenceState"], {
  tier: TIERS.RUNTIME, domain: "service:map", confidence: CONFIDENCE.SCANNER,
});
define(["marketEscrow", "marketRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:market", confidence: CONFIDENCE.SCANNER,
});
define(["tradeRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:trade", confidence: CONFIDENCE.SCANNER,
});
define(["miningLedger", "miningRuntimeState", "miningCargoCommits"], {
  tier: TIERS.RUNTIME, domain: "service:mining", confidence: CONFIDENCE.SCANNER,
});
define(["missionRuntimeState", "researchRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:agent", confidence: CONFIDENCE.SCANNER,
});
define(["moduleGroupingState"], {
  tier: TIERS.RUNTIME, domain: "service:moduleGrouping", confidence: CONFIDENCE.SCANNER,
});
define(["moonExtractions", "moonMiningFields", "structureAssetSafety", "structureDeliveryRuntime", "structurePaintwork", "structureProfiles", "structureTetherRestrictions"], {
  tier: TIERS.RUNTIME, domain: "service:structure", confidence: CONFIDENCE.SCANNER,
});
define(["newEdenStoreRuntime", "newEdenStore", "newEdenStorePurchaseSettlements"], {
  tier: TIERS.RUNTIME, domain: "service:newEdenStore", confidence: CONFIDENCE.SCANNER,
  note: "Store catalog/runtime state plus durable purchase and fulfillment settlement intents.",
});
define(["notifications"], {
  tier: TIERS.RUNTIME, domain: "service:notifications", confidence: CONFIDENCE.SCANNER,
});
define(["chatState", "chatStaticContracts", "chatBacklog"], {
  tier: TIERS.RUNTIME, domain: "service:chat", confidence: CONFIDENCE.INFERRED,
  note: "Owned by _secondary/chat/chatStore.js; migrated from _secondary/data/chat JSON/JSONL sidecars.",
});
define(["overviewSharedPresets"], {
  tier: TIERS.RUNTIME, domain: "service:overview", confidence: CONFIDENCE.SCANNER,
});
define(["planetOrbitalState", "planetRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:planet", confidence: CONFIDENCE.SCANNER,
});
define(["probeRuntimeState", "wormholeRuntimeState"], {
  tier: TIERS.RUNTIME, domain: "service:exploration", confidence: CONFIDENCE.SCANNER,
});
define(["raffles", "rafflesRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:raffles", confidence: CONFIDENCE.SCANNER,
});
define(["sharedSettings"], {
  tier: TIERS.RUNTIME, domain: "service:settings", confidence: CONFIDENCE.SCANNER,
});
define(["scheduledJobs"], {
  tier: TIERS.RUNTIME,
  domain: "service:scheduler",
  confidence: CONFIDENCE.INFERRED,
  note: "Durable scheduler jobs and leases, owned by the scheduler process.",
});
define(["shipCosmetics", "shipDirt", "shipKillCounters", "shipLogoFittings", "shipSelfDestructs", "breacherPodDeaths"], {
  tier: TIERS.RUNTIME, domain: "service:ship", confidence: CONFIDENCE.SCANNER,
});

// ── Runtime · single-service domains (inferred via param-helper) ─────
define(["corporationRuntime", "corporations", "alliances"], {
  tier: TIERS.RUNTIME, domain: "service:corporation", confidence: CONFIDENCE.INFERRED,
  note: "Written via corporationState/corporationRuntimeState param-helpers; all SQLite-backed (corporations migrated 2026-06-25).",
});
define(["bookmarks", "bookmarkFolders", "bookmarkGroups", "bookmarkKnownFolders", "bookmarkSubfolders", "bookmarkRuntimeState", "sharedBookmarkFolders"], {
  tier: TIERS.RUNTIME, domain: "service:bookmark", confidence: CONFIDENCE.INFERRED,
  note: "Written via services/bookmark/bookmarkRuntimeStore.js (table constants forwarded through a wrapper).",
});
define([
  "industryJobs",
  "industryRuntime",
  "industryBlueprintState",
  "industryFacilityState",
  "industryInstallSettlements",
], {
  tier: TIERS.RUNTIME, domain: "service:industry", confidence: CONFIDENCE.INFERRED,
  note: "Written via industry runtime/facility state and durable install settlement helpers.",
});
define(["jumpCloneActivationSettlements", "jumpCloneInstallSettlements"], {
  tier: TIERS.RUNTIME,
  domain: "service:station",
  confidence: CONFIDENCE.INFERRED,
  note: "Durable clone install and activation wallet/live-transition settlements.",
});
define(["jumpBridgeSettlements"], {
  tier: TIERS.RUNTIME,
  domain: "service:structure",
  confidence: CONFIDENCE.INFERRED,
  note: "Durable Ansiblex fuel, wallet, and live-transition settlements.",
});
define(["reprocessingFacilityState"], {
  tier: TIERS.RUNTIME, domain: "service:reprocessing", confidence: CONFIDENCE.INFERRED,
});
define(["repairOperations"], {
  tier: TIERS.RUNTIME, domain: "service:repair", confidence: CONFIDENCE.INFERRED,
  note: "Durable repair charge, target-state, and structure-tax settlement intents.",
});
define(["sovereignty"], {
  tier: TIERS.RUNTIME, domain: "service:sovereignty", confidence: CONFIDENCE.INFERRED,
});
define(["structures"], {
  tier: TIERS.RUNTIME, domain: "service:structure", confidence: CONFIDENCE.INFERRED,
});

// ── Runtime · domain not yet attributed (needs review) ───────────────
define(["shipSkinComponentRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:ship", confidence: CONFIDENCE.INFERRED,
  note: "SKINR component rights, reservations and activation custody receipts.",
});
define(["shipSkinDraftRuntime", "shipSkinSequencingRuntime", "shipSkinThirdPartyRuntime"], {
  tier: TIERS.RUNTIME, domain: "service:ship", confidence: CONFIDENCE.INFERRED,
  note: "SKINR owned drafts, immutable design snapshots and mutation receipts.",
});

define(["savedFittings"], {
  tier: TIERS.RUNTIME, domain: "secondary:fitting", confidence: CONFIDENCE.SCANNER,
  note: "Owned by _secondary/fitting/fittingStore.js (writes SAVED_FITTINGS_TABLE). Also touched cross-cuttingly by character deletion and player transfer.",
});

// ── Static · read-only SDE / reference data ──────────────────────────
define(
  [
    "agentAuthority", "asteroidBelts", "asteroidFieldStyles", "asteroidTypesBySolarSystemID",
    "capitalNpcAuthority", "celestials", "characterCreationBloodlines", "characterCreationRaces",
    "characterCreationSchools", "clientEntityStandings", "clientTypeLists", "clientShipLinkComponents", "clientMicroJumpComponents", "clientTowComponents", "clientPvpFilaments", "dbuffCollections",
    "dungeonAuthority", "dungeonClientContent", "dynamicItemAttributes", "evermarksCatalog", "expertSystems",
    "explorationAuthority", "explorationWormholeStatic", "factions", "fighterAbilities",
    "industryBlueprints", "industryFacilities", "itemIcons", "itemTypes", "mapTagsAuthority",
    "missionAuthority", "moonMiningPoints", "movementAttributes", "npcBehaviorProfiles",
    "npcHostileUtilities", "npcLoadouts", "npcLootTables", "npcProfiles", "npcSpawnGroups",
    "npcSpawnPools", "npcStandingsAuthority", "npcStartupRules", "planetSchematics",
    "reprocessingClientRandomizedMaterials", "reprocessingStatic", "shipCosmeticsCatalog", "shipSkinComponentAuthority", "shipSkinSequencingAuthority",
    "shipSkinMarketAuthority", "shipSkinComponentListingAuthority", "shipSkinStoreAuthority",
    "shipDogmaAttributes", "shipInsurancePrices", "shipTypes", "skillTrainingAlphaCaps",
    "skillTypes", "solarSystems", "sovereigntyStatic", "stargateTypes", "stargateVisualOverrides",
    "stargates", "starterShipFittings", "stationGraphicLocators", "stationStandingsRestrictions",
    "stationTypes", "stations", "structureGraphicLocators", "structureTypes",
    "trigDrifterSpawnAuthority", "typeDogma",
  ],
  { tier: TIERS.STATIC, domain: "sde", confidence: CONFIDENCE.INFERRED,
    note: "Treated as read-only reference (not in any runtime-persisted set)." },
);
define(["researchFieldAuthority"], {
  tier: TIERS.STATIC,
  domain: "sde",
  confidence: CONFIDENCE.INFERRED,
  note: "Research agents' fields, built by tools/DatabaseCreator/build-research-field-authority.js and read only by services/agent/researchAuthority.js through staticJsonTableReader. No runtime writer.",
});
define(["stationDockingPlacements"], {
  tier: TIERS.STATIC,
  domain: "sde",
  confidence: CONFIDENCE.INFERRED,
  note: "Build input only: tools/DatabaseCreator/database-creator.js reads it when it builds the stations table. The server never reads it at runtime.",
});

// ── Query API ────────────────────────────────────────────────────────
function getTableOwnership(table) {
  return Object.prototype.hasOwnProperty.call(TABLE_OWNERSHIP, table)
    ? TABLE_OWNERSHIP[table]
    : null;
}
function isClassified(table) {
  return getTableOwnership(table) !== null;
}
function isRuntimeTable(table) {
  const entry = getTableOwnership(table);
  return entry !== null && entry.tier === TIERS.RUNTIME;
}
function listTables() {
  return Object.keys(TABLE_OWNERSHIP).sort();
}
function listByDomain(domain) {
  return listTables().filter((t) => TABLE_OWNERSHIP[t].domain === domain);
}
function listInSpaceTables() {
  return listByDomain("in-space");
}
function listSharedSeams() {
  return listByDomain("shared");
}
function listForReview() {
  return listTables().filter((t) => TABLE_OWNERSHIP[t].confidence === CONFIDENCE.REVIEW);
}

module.exports = {
  TIERS,
  CONFIDENCE,
  TABLE_OWNERSHIP,
  getTableOwnership,
  isClassified,
  isRuntimeTable,
  listTables,
  listByDomain,
  listInSpaceTables,
  listSharedSeams,
  listForReview,
};
