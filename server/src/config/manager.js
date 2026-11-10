"use strict";

const fs = require("fs");
const path = require("path");

const EVEJS_VERSION = "261028.1";
const CONFIG_SCHEMA_VERSION = 1;
const DOMAIN_NAMES = Object.freeze([
  "server",
  "gameplay",
  "world",
  "mining",
  "npc",
  "economy",
]);

const DELETE_KEYS = new Set(`
  abyssalRoomVisualsEnabled
  abyssalSuppressorDebugEnabled
  abyssalClientVisualFxEnabled
  abyssalCalmDarkFx
  abyssalTransitionFxEnabled
  abyssalSceneryVisualsEnabled
  wormholeWanderingEnabled
  devBypassAssetSafetyWrapAccess
  upwellGmBypassRestrictions
  miningNpcResponseDefaultPoolID
  miningNpcResponseFallbackProfileID
  miningGeneratedGasSitesEnabled
  miningIceSitesHighSecPerSystem
  miningIceSitesLowSecPerSystem
  miningIceSitesNullSecPerSystem
  miningIceSitesWormholePerSystem
  miningIceTargetSystemsHighSec
  miningIceTargetSystemsLowSec
  miningIceTargetSystemsNullSec
  miningIceTargetSystemsWormhole
  miningGasSitesHighSecPerSystem
  miningGasSitesLowSecPerSystem
  miningGasSitesNullSecPerSystem
  miningGasSitesWormholePerSystem
  miningNpcHaulerCargoCapacityM3
  miningNpcStartupEnabled
  gameServerHost
  npcDefaultEverMoreGatePresenceSystemIDs
`.trim().split(/\s+/u));

const DECONFIGURED_KEYS = new Set(`
  abyssalIsolatedScenesEnabled
  miningCommandShipName
  miningCommandModuleName
  miningCommandModuleCount
  miningCommandSupportModuleName
  miningCommandSupportModuleCount
  miningCommandRigName
  miningCommandRigCount
  miningCommandCrystalQuantityPerType
  miningGeneratedSiteAnchorOffsetMeters
  miningNpcFleetThinkIntervalMs
  miningNpcFleetMiningRangeBufferMeters
  miningNpcFleetOrbitDistanceMeters
  miningNpcFleetTargetClaimPenaltyMeters
  miningNpcHaulerLandingRadiusMeters
  miningNpcHaulerUnloadDurationMs
  miningNpcMinerCargoCapacityM3
  miningInSpaceCompressionRangeMeters
  clientVersion
  clientBuild
  eveBirthday
  machoVersion
  projectCodename
  projectRegion
  projectVersion
  serverStatusLabel
  serverStatusProgressSeconds
  serverStatusProxyLimit
  serverStatusClusterUserCount
  serverStatusQueuePosition
  hyperNetDevAutoGrantCores
  newEdenStoreFakeFastCheckoutResponse
  newEdenStoreFakeChinaFunnelEnabled
  newEdenStoreFakeBuyPlexOfferUrl
  newEdenStoreUseShellExecuteToBuyPlexOffer
  newEdenStoreEditorPort
  activeSubwarpWatcherPositionAnchorsEnabled
  activeSubwarpWatcherPositionAnchorIntervalMs
  activeSubwarpWatcherPositionAnchorDistanceMeters
  devHandshakeSeedSkillExtractorAccessToken
  xmppServerPort
  factionStandingLossPerKillRaw
  npcDefaultEverMoreGatePresenceEnabled
  proxyNodeId
`.trim().split(/\s+/u));

const REPLACED_KEYS = new Set(`
  newCharacterTutorialEnabled
  newCharacterIntroCinematicEnabled
  hyperNetSeedMinShips
  hyperNetSeedMaxShips
  hyperNetSeedMinItems
  hyperNetSeedMaxItems
  microservicesRedirectUrl
  microservicesPublicBaseUrl
  NewEdenSystemLoading
`.trim().split(/\s+/u));

const LEGACY_TOMBSTONES = new Set([
  "clientPath",
  "autoLaunch",
  "devMode",
  "dailyLoginRewardTypeID",
  "dailyLoginRewardQuantity",
  "presenceReconcileStationEnabled",
  "proxyAllowedHosts",
  "proxyUnhandledHostPolicy",
  "localChatAuthorityEnabled",
  ...DELETE_KEYS,
  ...DECONFIGURED_KEYS,
  ...REPLACED_KEYS,
]);

const OPTIONAL_BLANK_KEYS = new Set([
  "miningNpcFleetProfileOrPool",
  "miningNpcHaulerProfileOrPool",
  "miningNpcFriendlyResponseProfileOrPool",
  "miningNpcStartupSystemIDs",
  "miningNpcStartupHaulerProfileOrPool",
  "playerConnectToken",
  "xmppConferenceDomain",
]);

const INTEGER_KEYS = new Set(`
  logLevel
  logRetentionHours
  logArchiveMaxMegabytes
  characterDeletionDelayMinutes
  socketKeepAliveInitialDelayMs
  socketIdleTimeoutMs
  presenceReconcileIntervalMs
  wormholeMaintenanceIntervalMs
  wormholeMaintenanceMaxItemsPerSlice
  spaceDebrisLifetimeMs
  miningNpcFleetDefaultCount
  miningNpcHaulerDefaultCount
  miningNpcResponseDefaultCount
  miningNpcFriendlyResponseCount
  miningNpcNeutralResponseCount
  miningNpcHostileResponseCount
  miningNpcAggressionMemoryMs
  miningNpcResponseRetreatDelayMs
  miningGeneratedIceSiteLifetimeMinutes
  miningIceChunksPerSite
  miningGasCloudsPerSite
  miningNpcHaulerInitialDelayMs
  miningNpcHaulerRepeatDelayMs
  miningNpcFleetAutoResumeDelayMs
  miningNpcStartupFleetCount
  miningNpcStartupFleetMinerCount
  miningNpcStartupFleetHaulerCount
  miningCharacterLedgerDelayMs
  miningObserverLedgerDelayMs
  asteroidBeltNpcRatRollCooldownMs
  asteroidBeltNpcRatRespawnCooldownMs
  asteroidBeltNpcRatMaxActiveGroupsPerBelt
  asteroidBeltNpcRatCapitalMaxActiveGroupsPerSystem
  serverPort
  marketDaemonPort
  marketDaemonConnectTimeoutMs
  marketDaemonRequestTimeoutMs
  marketDaemonRetryDelayMs
  redshiftMonitorPort
  hyperNetPlexPriceOverride
  newEdenStoreCentsPerPlex
  newEdenStoreDefaultCashTaxRatePoints
  newEdenStorePurchaseLogLimit
`.trim().split(/\s+/u));

const VALIDATION_OVERRIDES = Object.freeze({
  logRetentionHours: { minValue: 0, integer: true },
  logArchiveMaxMegabytes: { minValue: 0, integer: true },
  characterDeletionDelayMinutes: { minValue: 0, maxValue: 10080, integer: true },
  socketKeepAliveInitialDelayMs: { minValue: 0, integer: true },
  socketIdleTimeoutMs: { minValue: 0, integer: true },
  presenceReconcileIntervalMs: { minValue: 0, integer: true },
  wormholeLifetimeScale: { minValue: 0, exclusiveMinValue: true },
  wormholeMaintenanceIntervalMs: { minValue: 50, integer: true },
  wormholeMaintenanceMaxItemsPerSlice: { minValue: 1, integer: true },
  wormholeMaintenanceMaxSliceMs: { minValue: 1 },
  upwellTimerScale: { minValue: 0, exclusiveMinValue: true },
  miningNpcFleetDefaultCount: { minValue: 0, maxValue: 100, integer: true },
  miningNpcHaulerDefaultCount: { minValue: 0, maxValue: 20, integer: true },
  miningNpcResponseDefaultCount: { minValue: 0, maxValue: 100, integer: true },
  miningNpcFriendlyResponseCount: { minValue: 0, maxValue: 100, integer: true },
  miningNpcNeutralResponseCount: { minValue: 0, maxValue: 100, integer: true },
  miningNpcHostileResponseCount: { minValue: 0, maxValue: 100, integer: true },
  miningNpcHostileStandingThreshold: { minValue: -10, maxValue: 10 },
  miningNpcFriendlyStandingThreshold: { minValue: -10, maxValue: 10 },
  miningNpcAggressionMemoryMs: { minValue: 1 },
  miningNpcResponseCooldownMs: { minValue: 0, integer: true },
  miningNpcResponseRetreatDelayMs: { minValue: 0, integer: true },
  miningNpcWarpIngressDurationMs: { minValue: 250, integer: true },
  miningNpcFleetLandingRadiusMeters: { minValue: 0, exclusiveMinValue: true },
  miningSurveyScanDistanceMeters: { minValue: 0, exclusiveMinValue: true },
  miningBeltQuantityScale: { minValue: 0, exclusiveMinValue: true },
  miningBeltMinimumAsteroidVolumeM3: { minValue: 0, exclusiveMinValue: true },
  miningBeltMaximumAsteroidVolumeM3: { minValue: 0, exclusiveMinValue: true },
  miningGeneratedIceSiteLifetimeMinutes: { minValue: 1, integer: true },
  miningGeneratedSiteRadiusMeters: { minValue: 0, exclusiveMinValue: true },
  miningIceChunksPerSite: { minValue: 1, maxValue: 100, integer: true },
  miningGasCloudsPerSite: { minValue: 1, maxValue: 100, integer: true },
  miningDepletedAsteroidRadiusRatio: { minValue: 0.01, maxValue: 1 },
  miningNpcHaulThresholdRatio: { minValue: 0, exclusiveMinValue: true, maxValue: 1 },
  miningNpcHaulerInitialDelayMs: { minValue: 0, integer: true },
  miningNpcHaulerRepeatDelayMs: { minValue: 0, integer: true },
  miningNpcFleetAutoResumeDelayMs: { minValue: 0, integer: true },
  miningNpcStartupFleetCount: { minValue: 0, maxValue: 100, integer: true },
  miningNpcStartupFleetMinerCount: { minValue: 0, maxValue: 100, integer: true },
  miningNpcStartupFleetHaulerCount: { minValue: 0, maxValue: 20, integer: true },
  miningStructureReprocessingEfficiency: { minValue: 0, maxValue: 1 },
  miningStructureGasDecompressionEfficiency: { minValue: 0, maxValue: 1 },
  miningCharacterLedgerDelayMs: { minValue: 0, integer: true },
  miningObserverLedgerDelayMs: { minValue: 0, integer: true },
  industrySystemCostIndex: { minValue: 0, maxValue: 1 },
  asteroidBeltNpcRatRollCooldownMs: { minValue: 0, integer: true },
  asteroidBeltNpcRatRespawnCooldownMs: { minValue: 0, integer: true },
  asteroidBeltNpcRatMaxActiveGroupsPerBelt: { minValue: 1, integer: true },
  asteroidBeltNpcRatCapitalMaxActiveGroupsPerSystem: { minValue: 0, integer: true },
  hyperNetPlexPriceOverride: { minValue: 0, exclusiveMinValue: true, integer: true },
  hyperNetSeedOwnerId: { minValue: 1, integer: true },
  asteroidBeltNpcRatCapitalClasses: { validateValue: validateCapitalClasses },
  miningNpcStartupSystemIDs: { validateValue: validateSystemIdList },
  clusterDowntimeStarts: { validateValue: validateUtcTime },
  defaultCountryCode: { validateValue: validateCountryCode },
  serverPort: { minValue: 1, maxValue: 65535, integer: true },
  marketDaemonPort: { minValue: 1, maxValue: 65535, integer: true },
  marketDaemonConnectTimeoutMs: { minValue: 1, integer: true },
  marketDaemonRequestTimeoutMs: { minValue: 1, integer: true },
  marketDaemonRetryDelayMs: { minValue: 1, integer: true },
  redshiftMonitorPort: { minValue: 1, maxValue: 65535, integer: true },
  xmppDomain: { pattern: /^[A-Za-z0-9.-]+$/u },
  xmppConferenceDomain: { pattern: /^[A-Za-z0-9.-]*$/u },
  imageServerUrl: { validateValue: validateHttpUrl },
  newEdenStoreCentsPerPlex: { minValue: 1, integer: true },
  newEdenStoreDefaultCashTaxRatePoints: { minValue: 0, maxValue: 10000, integer: true },
  newEdenStorePurchaseLogLimit: { minValue: 10, integer: true },
  spaceDebrisLifetimeMs: { minValue: 60000, integer: true },
  alwaysOnSolarSystemIDs: { validateValue: validateAlwaysOnSolarSystemIDs },
  dailyLoginRewards: { validateValue: validateDailyLoginRewards },
  loginCampaigns: { validateValue: require("./loginCampaigns").validateLoginCampaigns },
  universeSiteCountDefault: { minValue: 0, integer: true },
  universeSiteCountsByFamily: { validateValue: validateUniverseSiteCountsByFamily },
  homefrontCustomSitesPerType: { minValue: 0, integer: true },
  microservicesPublicUrl: { validateValue: validateHttpUrl },
});

class ConfigValidationError extends Error {
  constructor(errors) {
    const normalized = [...new Set(
      Array.isArray(errors) ? errors.map(String) : [String(errors)],
    )];
    super(`Invalid EveJS configuration:\n- ${normalized.join("\n- ")}`);
    this.name = "ConfigValidationError";
    this.errors = normalized;
  }
}

function validateAlwaysOnSolarSystemIDs(value) {
  if (!Array.isArray(value)) {
    throw new Error("alwaysOnSolarSystemIDs must be an array of positive integer solar-system IDs.");
  }
  const normalized = [];
  const seen = new Set();
  for (const [index, rawValue] of value.entries()) {
    if (
      typeof rawValue !== "number" ||
      !Number.isSafeInteger(rawValue) ||
      rawValue <= 0
    ) {
      throw new Error(`alwaysOnSolarSystemIDs[${index}] must be a positive integer solar-system ID.`);
    }
    if (!seen.has(rawValue)) {
      seen.add(rawValue);
      normalized.push(rawValue);
    }
  }
  return normalized;
}

function validateUniverseSiteCountsByFamily(value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("universeSiteCountsByFamily must be an object mapping spawn family to a count.");
  }
  const normalized = {};
  for (const [family, count] of Object.entries(value)) {
    const normalizedFamily = String(family || "").trim().toLowerCase();
    if (!normalizedFamily) {
      throw new Error("universeSiteCountsByFamily contains a blank spawn family name.");
    }
    const numericCount = Number(count);
    if (!Number.isInteger(numericCount) || numericCount < 0) {
      throw new Error(
        `universeSiteCountsByFamily.${normalizedFamily} must be a non-negative integer.`,
      );
    }
    normalized[normalizedFamily] = numericCount;
  }
  return normalized;
}

function validateDailyLoginRewards(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("dailyLoginRewards must be a non-empty array.");
  }
  return value.map((reward, index) => {
    const typeID = Number(reward && reward.typeID);
    const quantity = Number(reward && reward.quantity);
    if (!Number.isInteger(typeID) || typeID <= 0) {
      throw new Error(`dailyLoginRewards[${index}].typeID must be a positive integer.`);
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`dailyLoginRewards[${index}].quantity must be a positive integer.`);
    }
    return { typeID, quantity };
  });
}

function validateHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new Error("Configured URL must be absolute.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Configured URL must use http or https.");
  }
  return parsed.toString();
}

function validateCapitalClasses(value) {
  const aliases = new Set([
    "all", "dread", "dreads", "dreadnought", "dreadnoughts",
    "titan", "titans", "super", "supers", "supercarrier", "supercarriers",
    "carrier", "carriers",
  ]);
  const tokens = String(value).split(/[\s,]+/u).map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !aliases.has(token))) {
    throw new Error("asteroidBeltNpcRatCapitalClasses contains an unsupported capital class.");
  }
  return tokens.join(",");
}

function validateSystemIdList(value) {
  const normalized = String(value).trim();
  if (normalized === "") return "";
  const tokens = normalized.split(/[\s,]+/u).filter(Boolean);
  if (tokens.some((token) => !/^\d+$/u.test(token) || Number(token) <= 0)) {
    throw new Error("miningNpcStartupSystemIDs must contain only positive numeric solar-system IDs.");
  }
  return tokens.join(",");
}

function validateUtcTime(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u.test(value)) {
    throw new Error("clusterDowntimeStarts must use HH:MM:SS UTC format.");
  }
  return value;
}

function validateCountryCode(value) {
  if (!/^[A-Z]{2}$/u.test(value)) {
    throw new Error("defaultCountryCode must be a two-letter uppercase country code.");
  }
  return value;
}

function inferConfigEntryType(entry) {
  if (entry.valueType) return entry.valueType;
  if (entry.envType) return entry.envType;
  if (Array.isArray(entry.defaultValue) || (entry.defaultValue && typeof entry.defaultValue === "object")) {
    return "json";
  }
  return typeof entry.defaultValue;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function validateAllowedValue(entry, value) {
  if (entry.integer === true && typeof value === "number" && !Number.isInteger(value)) {
    throw new Error(`${entry.key} must be an integer.`);
  }
  if (typeof entry.minValue === "number" && typeof value === "number") {
    if (value < entry.minValue || (entry.exclusiveMinValue === true && value === entry.minValue)) {
      throw new Error(`${entry.key} must be ${entry.exclusiveMinValue === true ? "greater than" : "at least"} ${entry.minValue}.`);
    }
  }
  if (typeof entry.maxValue === "number" && typeof value === "number" && value > entry.maxValue) {
    throw new Error(`${entry.key} must be at most ${entry.maxValue}.`);
  }
  if (Array.isArray(entry.allowedValues) && !entry.allowedValues.includes(value)) {
    throw new Error(`${entry.key} must be one of ${entry.allowedValues.map((item) => JSON.stringify(item)).join(", ")}.`);
  }
  if (entry.pattern instanceof RegExp && typeof value === "string" && !entry.pattern.test(value)) {
    throw new Error(`${entry.key} has an invalid format.`);
  }
  if (typeof entry.validateValue === "function") return entry.validateValue(value);
  return value;
}

function coerceConfigValue(entry, value) {
  const type = inferConfigEntryType(entry);
  if (type === "boolean") {
    const parsed = parseBoolean(value);
    if (parsed === undefined) throw new Error(`${entry.key} must be true or false.`);
    return validateAllowedValue(entry, parsed);
  }
  if (type === "number") {
    const parsed = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed)) throw new Error(`${entry.key} must be a finite number.`);
    return validateAllowedValue(entry, parsed);
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error(`${entry.key} must be a string.`);
    const parsed = value.trim();
    if (parsed === "" && entry.allowBlank !== true) throw new Error(`${entry.key} cannot be blank.`);
    return validateAllowedValue(entry, parsed);
  }
  if (type === "json") {
    let parsed = value;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch (_error) {
        throw new Error(`${entry.key} must be valid JSON.`);
      }
    }
    return validateAllowedValue(entry, parsed);
  }
  return validateAllowedValue(entry, value);
}

function configDomainForKey(key) {
  if (key.startsWith("skinr")) return "gameplay";
  if (key.startsWith("campaignTrail") || key === "eventSchedules" || key === "loginCampaigns") return "gameplay";
  if (key.startsWith("mining") || key.startsWith("industry") || key === "asteroidFieldsEnabled" || key === "asteroidBeltStartupReset") return "mining";
  if (key.startsWith("asteroidBeltNpcRat") || key.startsWith("npc") || key.startsWith("crimewatch")) return "npc";
  if (key.startsWith("hyperNet") || key.startsWith("newEdenStore") || key.startsWith("marketDaemon")) return "economy";
  if (key.startsWith("abyssal") || key.startsWith("wormhole") || key.startsWith("universeSite") || key.startsWith("homefront") || [
    "spaceDebrisLifetimeMs",
    "randomSeed",
    "tidiAutoscaler",
    "systemLoadingMode",
    "alwaysOnSolarSystemIDs",
    "defaultStargateBillboardsEnabled",
    "defaultEmpireSentryGunsEnabled",
    "deadspaceWarpRestrictionEnabled",
  ].includes(key)) return "world";
  if (key.startsWith("newCharacter") || key.startsWith("character") || key.startsWith("skill") || key.startsWith("expert") || key.startsWith("upwell") || key.startsWith("pos") || key.startsWith("sovereignty") || key.startsWith("mission") || key.startsWith("dailyLogin") || key.startsWith("factionStanding") || key.startsWith("turret") || key.startsWith("planet") || key === "omegaLicenseEnabled") return "gameplay";
  return "server";
}

function configSectionForKey(domain, key) {
  if (key === "loginCampaigns") return "rewards";
  if (domain === "server") {
    if (key.startsWith("dev") || key === "playerConnectToken") return "development";
    if (key === "logLevel" || key === "logRetentionHours" || key === "logArchiveMaxMegabytes" || key === "logPacketPayloadDetails" || key === "spaceBubbleDebugEnabled" || key === "spaceMissileDebugEnabled") return "logging";
    if (key.startsWith("presence")) return "presence";
    if (key.startsWith("image")) return "images";
    if (key.startsWith("microservices")) return "gateway";
    if (key.startsWith("redshift")) return "redshift";
    if (key.startsWith("proxy")) return "proxy";
    if (key.startsWith("xmpp")) return "xmpp";
    if (key === "clusterDowntimeStarts" || key === "defaultCountryCode") return "cluster";
    return "network";
  }
  if (domain === "gameplay") {
    if (key.startsWith("skinr")) return "skinr";
    if (key.startsWith("campaignTrail") || key === "eventSchedules") return "events";
    if (key.startsWith("newCharacter") || key.startsWith("character")) return "characters";
    if (key.startsWith("skill") || key.startsWith("expert")) return "skills";
    if (key.startsWith("upwell") || key.startsWith("pos")) return "structures";
    if (key.startsWith("sovereignty")) return "sovereignty";
    if (key.startsWith("dailyLogin")) return "rewards";
    if (key === "omegaLicenseEnabled") return "subscription";
    if (key.startsWith("turret")) return "combat";
    if (key.startsWith("planet")) return "planets";
    return "missions";
  }
  if (domain === "world") {
    if (key.startsWith("abyssal")) return "abyssal";
    if (key.startsWith("wormhole")) return "wormholes";
    if (key.startsWith("universeSite") || key.startsWith("homefront"))
      return "cosmicSites";
    if (key.startsWith("default") || key.startsWith("deadspace")) return "scenery";
    return "simulation";
  }
  if (domain === "mining") {
    if (key.startsWith("miningNpc")) return "npcFleets";
    if (key.startsWith("miningGenerated") || key.startsWith("miningIce") || key.startsWith("miningGas") || key === "miningDepletedAsteroidRadiusRatio") return "sites";
    if (key.includes("Ledger")) return "ledgers";
    if (key.startsWith("miningStructure") || key.startsWith("industry")) return "industry";
    if (key.startsWith("asteroid")) return "belts";
    return "general";
  }
  if (domain === "npc") {
    if (key.startsWith("asteroidBeltNpcRat")) return "beltRats";
    if (key.startsWith("crimewatch")) return "crimewatch";
    if (key === "npcAuthoredStartupEnabled") return "startup";
    if (key === "npcPlayerDronesTargetable") return "targeting";
    return "concord";
  }
  if (key.startsWith("marketDaemon")) return "market";
  if (key.startsWith("hyperNet")) return "hypernet";
  return "store";
}

function buildDefinitions(schemaDefinitions) {
  const active = schemaDefinitions
    .filter((entry) => !LEGACY_TOMBSTONES.has(entry.key))
    .map((entry) => {
      const override = VALIDATION_OVERRIDES[entry.key] || {};
      return {
        ...entry,
        ...override,
        integer: override.integer === true || INTEGER_KEYS.has(entry.key) || entry.integer === true,
        allowBlank: OPTIONAL_BLANK_KEYS.has(entry.key) || entry.allowBlank === true,
      };
    });
  return active.map((entry) => {
    const configFile = configDomainForKey(entry.key);
    const section = configSectionForKey(configFile, entry.key);
    return Object.freeze({
      ...entry,
      configFile,
      configPath: Object.freeze([section, entry.key]),
      configPathString: `${section}.${entry.key}`,
      valueType: inferConfigEntryType(entry),
    });
  });
}

function getAtPath(object, segments) {
  let cursor = object;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false, value: undefined };
    }
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

function setAtPath(object, segments, value) {
  let cursor = object;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment] || typeof cursor[segment] !== "object" || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function readJsonFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) {
    if (options.required === true) throw new Error(`${filePath} does not exist.`);
    return null;
  }
  try {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").trim();
    if (text === "") return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

function stripJsonComments(text) {
  const source = String(text || "").replace(/^\uFEFF/u, "");
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") { lineComment = false; result += char; }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      else if (char === "\n") result += char;
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; result += char; continue; }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    result += char;
  }
  return result;
}

function readLegacyJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const text = stripJsonComments(fs.readFileSync(filePath, "utf8")).trim();
    return text === "" ? {} : JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid legacy JSON in ${filePath}: ${error.message}`);
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const nextText = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === nextText) {
    return false;
  }
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, nextText, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_cleanupError) { /* ignored: removing the temp file is cleanup; the rename error is rethrown */ }
    throw error;
  }
  return true;
}

function buildRawFiles(definitions, values) {
  const rawFiles = Object.fromEntries(DOMAIN_NAMES.map((name) => [name, {}]));
  for (const entry of definitions) {
    setAtPath(rawFiles[entry.configFile], entry.configPath, values[entry.key]);
  }
  return rawFiles;
}

function stripLegacyTombstonesFromDomainFile(domain, rawFile) {
  const sanitized = {};
  for (const [section, sectionValues] of Object.entries(rawFile || {})) {
    if (!sectionValues || typeof sectionValues !== "object" || Array.isArray(sectionValues)) {
      sanitized[section] = sectionValues;
      continue;
    }
    const retained = {};
    for (const [key, value] of Object.entries(sectionValues)) {
      if (
        LEGACY_TOMBSTONES.has(key) &&
        configDomainForKey(key) === domain
      ) {
        continue;
      }
      retained[key] = value;
    }
    if (Object.keys(retained).length > 0) {
      sanitized[section] = retained;
    }
  }
  return sanitized;
}

function parsePortFromUrl(value, fallback = 26002) {
  try {
    const url = new URL(String(value));
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch (_error) {
    return fallback;
  }
}

function normalizeLegacyValues(rawValues, defaults) {
  const normalized = {};
  for (const [key, value] of Object.entries(rawValues || {})) {
    if (!LEGACY_TOMBSTONES.has(key)) normalized[key] = value;
  }

  const hasTutorial = Object.prototype.hasOwnProperty.call(rawValues, "newCharacterTutorialEnabled");
  const hasCinematic = Object.prototype.hasOwnProperty.call(rawValues, "newCharacterIntroCinematicEnabled");
  if (hasTutorial || hasCinematic) {
    normalized.newCharacterExperienceMode = rawValues.newCharacterIntroCinematicEnabled === true
      ? "cinematic"
      : rawValues.newCharacterTutorialEnabled === true
        ? "tutorial"
        : "disabled";
  }

  const shipCount = Number(rawValues.hyperNetSeedMaxShips ?? rawValues.hyperNetSeedMinShips);
  if (Number.isFinite(shipCount)) normalized.hyperNetSeedShips = Math.max(0, Math.trunc(shipCount));
  const itemCount = Number(rawValues.hyperNetSeedMaxItems ?? rawValues.hyperNetSeedMinItems);
  if (Number.isFinite(itemCount)) normalized.hyperNetSeedItems = Math.max(0, Math.trunc(itemCount));

  const publicUrl = rawValues.microservicesPublicBaseUrl || rawValues.microservicesRedirectUrl;
  if (publicUrl) {
    normalized.microservicesPublicUrl = publicUrl;
    normalized.microservicesPort = parsePortFromUrl(publicUrl, defaults.microservicesPort);
  }

  const legacySystemLoadingMode = Number(rawValues.NewEdenSystemLoading);
  if (Number.isFinite(legacySystemLoadingMode)) {
    normalized.systemLoadingMode = ({
      1: "lazy",
      2: "highSecurity",
      3: "all",
      4: "onDemandGates",
    })[Math.trunc(legacySystemLoadingMode)] || "lazy";
  }

  if (!Object.prototype.hasOwnProperty.call(normalized, "dailyLoginRewards")) {
    const typeID = Number(rawValues.dailyLoginRewardTypeID);
    const quantity = Number(rawValues.dailyLoginRewardQuantity);
    if (Number.isInteger(typeID) && typeID > 0 && Number.isInteger(quantity) && quantity > 0) {
      normalized.dailyLoginRewards = [{ typeID, quantity }];
    }
  }
  return normalized;
}

function validateRelations(values) {
  const errors = [];
  if (values.miningBeltMaximumAsteroidVolumeM3 < values.miningBeltMinimumAsteroidVolumeM3) {
    errors.push("miningBeltMaximumAsteroidVolumeM3 must be greater than or equal to miningBeltMinimumAsteroidVolumeM3.");
  }
  if (values.miningNpcFriendlyStandingThreshold < values.miningNpcHostileStandingThreshold) {
    errors.push("miningNpcFriendlyStandingThreshold must be greater than or equal to miningNpcHostileStandingThreshold.");
  }
  if (values.miningNpcStartupFleetCount > 0 && values.miningNpcStartupFleetMinerCount < 1) {
    errors.push("miningNpcStartupFleetMinerCount must be at least 1 when startup mining fleets are enabled.");
  }
  return errors;
}

function createConfigManager(options) {
  const rootDir = options.rootDir;
  const definitions = buildDefinitions(options.schemaDefinitions);
  const definitionByKey = new Map(definitions.map((entry) => [entry.key, entry]));
  const defaults = Object.fromEntries(definitions.map((entry) => [entry.key, entry.defaultValue]));
  const configDir = path.join(rootDir, "config");
  const versionConfigPath = path.join(configDir, "version.json");
  const configFilePaths = Object.fromEntries(DOMAIN_NAMES.map((name) => [name, path.join(configDir, `${name}.json`)]));
  const legacyLocalConfigPath = path.join(rootDir, "evejs.config.local.json");
  const legacySharedConfigPath = path.join(rootDir, "evejs.config.json");
  let nextBoundId = 1;

  function loadEnvironment(errors) {
    const values = {};
    for (const entry of definitions) {
      let raw = entry.envVar ? process.env[entry.envVar] : undefined;
      if (raw === undefined && entry.key === "newCharacterExperienceMode") {
        const cinematic = parseBoolean(process.env.EVEJS_NEW_CHARACTER_INTRO_CINEMATIC_ENABLED);
        const tutorial = parseBoolean(process.env.EVEJS_NEW_CHARACTER_TUTORIAL_ENABLED);
        if (cinematic !== undefined || tutorial !== undefined) raw = cinematic === true ? "cinematic" : tutorial === true ? "tutorial" : "disabled";
      }
      if (raw === undefined && entry.key === "hyperNetSeedShips") raw = process.env.EVEJS_HYPERNET_SEED_MAX_SHIPS ?? process.env.EVEJS_HYPERNET_SEED_MIN_SHIPS;
      if (raw === undefined && entry.key === "hyperNetSeedItems") raw = process.env.EVEJS_HYPERNET_SEED_MAX_ITEMS ?? process.env.EVEJS_HYPERNET_SEED_MIN_ITEMS;
      if (raw === undefined && entry.key === "microservicesPublicUrl") raw = process.env.EVEJS_MICROSERVICES_PUBLIC_BASE_URL ?? process.env.EVEJS_MICROSERVICES_REDIRECT_URL;
      if (raw === undefined && entry.key === "microservicesPort") {
        const legacyUrl = process.env.EVEJS_MICROSERVICES_PUBLIC_BASE_URL ?? process.env.EVEJS_MICROSERVICES_REDIRECT_URL;
        if (legacyUrl) raw = String(parsePortFromUrl(legacyUrl, defaults.microservicesPort));
      }
      if (raw === undefined && entry.key === "systemLoadingMode") {
        const legacyMode = Number(process.env.EVEJS_NEW_EDEN_SYSTEM_LOADING);
        if (Number.isFinite(legacyMode)) {
          raw = ({ 1: "lazy", 2: "highSecurity", 3: "all", 4: "onDemandGates" })[Math.trunc(legacyMode)] || "lazy";
        }
      }
      if (raw === undefined) continue;
      try {
        values[entry.key] = coerceConfigValue(entry, raw);
      } catch (error) {
        errors.push(`${entry.envVar || entry.key}: ${error.message}`);
      }
    }
    return values;
  }

  function readVersion(errors) {
    let version = null;
    try { version = readJsonFile(versionConfigPath); } catch (error) { errors.push(error.message); }
    if (!version) return { evejsVersion: EVEJS_VERSION, configSchemaVersion: CONFIG_SCHEMA_VERSION, source: "default" };
    const allowed = new Set(["evejsVersion", "configSchemaVersion"]);
    for (const key of Object.keys(version)) if (!allowed.has(key)) errors.push(`version.json contains unknown key ${JSON.stringify(key)}.`);
    if (typeof version.evejsVersion !== "string" || version.evejsVersion.trim() === "") errors.push("version.json evejsVersion must be a non-empty string.");
    if (!Number.isInteger(version.configSchemaVersion) || version.configSchemaVersion < 1) errors.push("version.json configSchemaVersion must be a positive integer.");
    if (version.configSchemaVersion > CONFIG_SCHEMA_VERSION) errors.push(`Config schema ${version.configSchemaVersion} is newer than supported schema ${CONFIG_SCHEMA_VERSION}.`);
    return { ...version, source: "file" };
  }

  function loadState() {
    const errors = [];
    const rawFiles = {};
    const persistedConfig = { ...defaults };
    const persistedPresence = new Set();
    for (const domain of DOMAIN_NAMES) {
      let raw = null;
      try { raw = readJsonFile(configFilePaths[domain]); } catch (error) { errors.push(error.message); }
      raw = stripLegacyTombstonesFromDomainFile(domain, raw || {});
      rawFiles[domain] = raw || {};
      const domainDefinitions = definitions.filter((entry) => entry.configFile === domain);
      const expectedPaths = new Set(domainDefinitions.map((entry) => entry.configPath.join(".")));
      const expectedSections = new Set(domainDefinitions.map((entry) => entry.configPath[0]));
      for (const [section, sectionValues] of Object.entries(raw || {})) {
        if (!expectedSections.has(section)) {
          errors.push(`${domain}.json contains unknown setting ${JSON.stringify(section)}.`);
          continue;
        }
        if (!sectionValues || typeof sectionValues !== "object" || Array.isArray(sectionValues)) {
          errors.push(`${domain}.json section ${JSON.stringify(section)} must be an object.`);
          continue;
        }
        for (const key of Object.keys(sectionValues)) {
          const settingPath = `${section}.${key}`;
          if (!expectedPaths.has(settingPath)) {
            errors.push(`${domain}.json contains unknown setting ${JSON.stringify(settingPath)}.`);
          }
        }
      }
      for (const entry of domainDefinitions) {
        const located = getAtPath(raw || {}, entry.configPath);
        if (!located.found) continue;
        try {
          persistedConfig[entry.key] = coerceConfigValue(entry, located.value);
          persistedPresence.add(entry.key);
        } catch (error) {
          errors.push(`${domain}.json ${entry.configPath.join(".")}: ${error.message}`);
        }
      }
    }
    errors.push(...validateRelations(persistedConfig));
    const envConfig = loadEnvironment(errors);
    const resolvedActiveConfig = { ...persistedConfig, ...envConfig };
    errors.push(...validateRelations(resolvedActiveConfig));
    const version = readVersion(errors);
    if (errors.length > 0) throw new ConfigValidationError(errors);
    const resolvedConfig = { ...resolvedActiveConfig };
    const sources = Object.fromEntries(definitions.map((entry) => [
      entry.key,
      Object.prototype.hasOwnProperty.call(envConfig, entry.key)
        ? "env"
        : persistedPresence.has(entry.key)
          ? `config/${entry.configFile}.json`
          : "default",
    ]));
    return {
      paths: {
        rootDir,
        configDir,
        files: { ...configFilePaths },
        versionConfigPath,
        legacyLocalConfigPath,
        legacySharedConfigPath,
      },
      rootDir,
      configDir,
      configFilePaths: { ...configFilePaths },
      versionConfigPath,
      sharedConfigPath: null,
      localConfigPath: null,
      legacySharedConfigPath,
      legacyLocalConfigPath,
      defaults: { ...defaults },
      persistedConfig: { ...persistedConfig },
      fileConfig: { ...persistedConfig },
      sharedRawConfig: {},
      localRawConfig: { ...persistedConfig },
      rawFiles,
      envConfig,
      invalidEnvFallbacks: {},
      resolvedConfig,
      sources,
      version,
    };
  }

  function validateValues(rawValues, baseValues = null) {
    if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) throw new ConfigValidationError(["Config values must be an object."]);
    const unknown = Object.keys(rawValues).filter((key) => !definitionByKey.has(key));
    if (unknown.length > 0) throw new ConfigValidationError(unknown.map((key) => `Unknown setting ${JSON.stringify(key)}.`));
    const base = baseValues || loadState().persistedConfig;
    const values = {};
    const errors = [];
    for (const entry of definitions) {
      const candidate = Object.prototype.hasOwnProperty.call(rawValues, entry.key) ? rawValues[entry.key] : base[entry.key];
      try { values[entry.key] = coerceConfigValue(entry, candidate); }
      catch (error) { errors.push(error.message); }
    }
    errors.push(...validateRelations(values));
    if (errors.length > 0) throw new ConfigValidationError(errors);
    return values;
  }

  function archiveLegacyFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const backupDir = path.join(rootDir, "_local", "config-backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const extension = path.extname(filePath);
    const stem = path.basename(filePath, extension);
    let backupPath = path.join(backupDir, `${stem}.pre-schema-${CONFIG_SCHEMA_VERSION}${extension}`);
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
      backupPath = path.join(backupDir, `${stem}.pre-schema-${CONFIG_SCHEMA_VERSION}-${suffix}${extension}`);
      suffix += 1;
    }
    fs.renameSync(filePath, backupPath);
    return backupPath;
  }

  function initializeConfigFiles(initOptions = {}) {
    fs.mkdirSync(configDir, { recursive: true });
    const domainFilesExist = DOMAIN_NAMES.some((domain) => fs.existsSync(configFilePaths[domain]));
    const legacyExists = fs.existsSync(legacySharedConfigPath) || fs.existsSync(legacyLocalConfigPath);
    let seedValues = { ...defaults };
    let migratedFromLegacy = false;
    const archivedLegacyPaths = [];
    if (legacyExists) {
      const shared = readLegacyJsonFile(legacySharedConfigPath);
      const local = readLegacyJsonFile(legacyLocalConfigPath);
      const migrationBase = domainFilesExist ? loadState().persistedConfig : defaults;
      seedValues = validateValues(
        normalizeLegacyValues({ ...shared, ...local }, defaults),
        migrationBase,
      );
      migratedFromLegacy = true;
    }
    const desiredFiles = buildRawFiles(definitions, seedValues);
    const createdFiles = [];
    for (const domain of DOMAIN_NAMES) {
      if (!fs.existsSync(configFilePaths[domain])) {
        atomicWriteJson(configFilePaths[domain], desiredFiles[domain]);
        createdFiles.push(configFilePaths[domain]);
      }
    }
    if (migratedFromLegacy && domainFilesExist) {
      for (const domain of DOMAIN_NAMES) {
        atomicWriteJson(configFilePaths[domain], desiredFiles[domain]);
      }
    }
    const currentVersion = fs.existsSync(versionConfigPath) ? readJsonFile(versionConfigPath) : null;
    if (currentVersion && currentVersion.configSchemaVersion > CONFIG_SCHEMA_VERSION) {
      throw new ConfigValidationError([`Config schema ${currentVersion.configSchemaVersion} is newer than supported schema ${CONFIG_SCHEMA_VERSION}.`]);
    }
    const desiredVersion = { evejsVersion: EVEJS_VERSION, configSchemaVersion: CONFIG_SCHEMA_VERSION };
    let state = loadState();
    const hydratedFiles = [];
    for (const domain of DOMAIN_NAMES) {
      let missingSetting = false;
      const rawFile = state.rawFiles[domain];
      for (const entry of definitions.filter((item) => item.configFile === domain)) {
        if (getAtPath(rawFile, entry.configPath).found) continue;
        setAtPath(rawFile, entry.configPath, state.persistedConfig[entry.key]);
        missingSetting = true;
      }
      const persistedRawFile = readJsonFile(configFilePaths[domain]) || {};
      const legacyTombstonesRemoved =
        JSON.stringify(persistedRawFile) !== JSON.stringify(rawFile);
      if (
        (missingSetting || legacyTombstonesRemoved) &&
        atomicWriteJson(configFilePaths[domain], rawFile)
      ) {
        hydratedFiles.push(configFilePaths[domain]);
      }
    }
    if (!currentVersion || currentVersion.evejsVersion !== EVEJS_VERSION || currentVersion.configSchemaVersion !== CONFIG_SCHEMA_VERSION) {
      atomicWriteJson(versionConfigPath, desiredVersion);
    }
    if (migratedFromLegacy && initOptions.archiveLegacy !== false) {
      for (const legacyPath of [legacySharedConfigPath, legacyLocalConfigPath]) {
        const archived = archiveLegacyFile(legacyPath);
        if (archived) archivedLegacyPaths.push(archived);
      }
    }
    state = loadState();
    applyState(state);
    return {
      createdFiles,
      hydratedFiles,
      migratedFromLegacy,
      archivedLegacyPaths,
      version: desiredVersion,
    };
  }

  function saveConfig(rawValues = {}, options = {}) {
    const current = loadState();
    const values = validateValues(rawValues, current.persistedConfig);
    const rawFiles = buildRawFiles(definitions, values);
    const requestedDomains = Array.isArray(options.domains)
      ? [...new Set(options.domains.map(String))]
      : DOMAIN_NAMES;
    const unknownDomains = requestedDomains.filter(
      (domain) => !DOMAIN_NAMES.includes(domain),
    );
    if (unknownDomains.length > 0) {
      throw new ConfigValidationError(
        unknownDomains.map((domain) => `Unknown config domain ${JSON.stringify(domain)}.`),
      );
    }
    for (const domain of requestedDomains) {
      atomicWriteJson(configFilePaths[domain], rawFiles[domain]);
    }
    if (!fs.existsSync(versionConfigPath)) atomicWriteJson(versionConfigPath, { evejsVersion: EVEJS_VERSION, configSchemaVersion: CONFIG_SCHEMA_VERSION });
    const state = loadState();
    applyState(state);
    return state;
  }

  function publicDefinitions() {
    return definitions.map((entry) => ({
      ...entry,
      description: Array.isArray(entry.description) ? [...entry.description] : [entry.description],
      allowedValues: Array.isArray(entry.allowedValues) ? [...entry.allowedValues] : undefined,
      configPath: [...entry.configPath],
    }));
  }

  const config = {};
  function applyState(state) {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, state.resolvedConfig);
  }
  applyState(loadState());
  Object.defineProperties(config, {
    getNextBoundId: { value() { return nextBoundId++; } },
    getConfigDefinitions: { value: publicDefinitions },
    getConfigStateSnapshot: { value: loadState },
    buildValidatedConfigValues: { value: validateValues },
    initializeConfigFiles: { value: initializeConfigFiles },
    saveConfig: { value: saveConfig },
    saveLocalConfig: { value: saveConfig },
    ConfigValidationError: { value: ConfigValidationError },
  });
  return config;
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  DOMAIN_NAMES,
  EVEJS_VERSION,
  ConfigValidationError,
  createConfigManager,
};
