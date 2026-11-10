"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const pirateFactionPolicy = require(path.join(__dirname, "../../space/npc/pirateFactionPolicy"));
const oreAnomalySecurityAuthority = require(path.join(
  __dirname,
  "../mining/oreAnomalySecurityAuthority",
));
const sovModernState = require(path.join(__dirname, "../sovereignty/sovModernState"));
const sovState = require(path.join(__dirname, "../sovereignty/sovState"));
const wormholeSpaceAuthority = require(path.join(__dirname, "../exploration/wormholes/wormholeSpaceAuthority"));

const POLICY_VERSION = 3;
const POWER_STATE_ONLINE = 2;

const SOURCE_REFS = Object.freeze({
  ccpSovHub: Object.freeze({
    title: "EVE Online Support: Sovereignty Hub",
    url: "https://support.eveonline.com/hc/en-us/articles/14339751569436-Sovereignty-Hub",
  }),
  ccpSovHubCombatAnomalies: Object.freeze({
    title: "EVE Online Support: Sovereignty Hub Combat Anomalies",
    url: "https://support.eveonline.com/hc/en-us/articles/14996978906908-Sovereignty-Hub-Combat-Anomalies",
  }),
  ccpActivityDefenseMultiplier: Object.freeze({
    title: "EVE Online Support: Activity Defense Multiplier",
    url: "https://support.eveonline.com/hc/en-us/articles/203354271-Activity-Defense-Multiplier",
  }),
  ccpEquinoxSovUpdates: Object.freeze({
    title: "EVE Online: Sovereignty Updates, Transition and Upgrades",
    url: "https://www.eveonline.com/news/view/sovereignty-updates-transition-and-upgrades",
  }),
  eveUniWormholeSpace: Object.freeze({
    title: "EVE University: Wormhole space, Wormhole sites, Shattered wormhole systems (sites per class)",
    url: "https://wiki.eveuniversity.org/Wormhole_sites",
  }),
  eveUniCosmicAnomalies: Object.freeze({
    title: "EVE University: Cosmic Anomalies",
    url: "https://wiki.eveuniversity.org/Cosmic_Anomalies",
  }),
  eveUniAsteroidsAndOre: Object.freeze({
    title: "EVE University: Asteroids and ore",
    url: "https://wiki.eveuniversity.org/Asteroids_and_ore",
  }),
  eveUniGasCloudHarvesting: Object.freeze({
    title: "EVE University: Gas cloud harvesting",
    url: "https://wiki.eveuniversity.org/Gas_cloud_harvesting",
  }),
  ccpCatalystMiningContent: Object.freeze({
    title: "EVE Online: Catalyst Expansion Notes - Mining Content",
    url: "https://www.eveonline.com/fr/news/view/catalyst-expansion-notes",
  }),
  ccpResourceDistribution1812: Object.freeze({
    title: "EVE Online: Patch Notes 18.12 - Resource Distribution",
    url: "https://www.eveonline.com/news/view/patch-notes-version-18-12",
  }),
  ccpSde: Object.freeze({
    title: "EVE Developer Documentation: Static Data Export",
    url: "https://developers.eveonline.com/docs/services/static-data/",
  }),
});

const UPGRADE_CATEGORY_PATTERNS = Object.freeze({
  threat_detection: Object.freeze([/\bthreat detection array\b/i]),
  prospecting: Object.freeze([/\bprospecting array\b/i]),
  exploration_detector: Object.freeze([/\bexploration detector\b/i]),
});

const RULED_SITE_FAMILIES = new Set([
  "combat",
  "combat_anomaly",
  "ded_rated",
  "combat_hacking",
  "data",
  "gas",
  "ghost",
  "ice",
  "ore",
  "relic",
]);

// Site families whose pirate and drone content still appears in wormhole space
// (in the low classes; see wormholeSpaceAuthority).
const WORMHOLE_EXPLORATION_SITE_FAMILIES = new Set(["data", "relic", "ghost"]);
// The faction wormhole space resolves to (pirateFactionPolicy): Sleeper
// templates match it the way Angel templates match Angel space.
const WORMHOLE_LOCAL_FACTION_KEY = "sleepers";

const LOCALLY_SCOPED_PIRATE_SPAWN_FAMILIES = new Set([
  "combat",
  "combat_anomaly",
  "ded_rated",
  "combat_hacking",
  "data",
  "drone_anomaly",
  "ghost",
  "relic",
  "sov_exploration_detector",
  "sov_threat_detection",
  "wormhole_anomaly",
  "wormhole_data",
  "wormhole_relic",
  "pirate_relic",
  "pirate_data",
  "booster_lab",
  "booster_facility",
]);

const SPACE_BAND_RULES = Object.freeze([
  Object.freeze({
    key: "wormhole_gas_reservoir",
    siteFamilies: Object.freeze(["gas"]),
    siteKinds: Object.freeze(["signature"]),
    namePattern: /\b(perimeter|frontier|core)\s+reservoir\b/i,
    allowedBands: Object.freeze(["wormhole"]),
    sourceRefs: Object.freeze(["eveUniGasCloudHarvesting"]),
  }),
  Object.freeze({
    key: "wormhole_ore_deposit",
    siteFamilies: Object.freeze(["ore"]),
    siteKinds: Object.freeze(["anomaly", "signature"]),
    namePattern: /\b(w-space|perimeter deposit|frontier deposit|core deposit|shattered debris field)\b/i,
    allowedBands: Object.freeze(["wormhole"]),
    sourceRefs: Object.freeze(["eveUniAsteroidsAndOre"]),
  }),
]);

const SOV_UPGRADE_RULES = Object.freeze([
  Object.freeze({
    key: "sov_prospecting_ore",
    spawnFamilies: Object.freeze(["sov_prospecting"]),
    siteFamilies: Object.freeze(["ore"]),
    siteKinds: Object.freeze(["anomaly"]),
    namePattern: /\b(griemeer|hezorime|kylixium|mordunium|ueganite|nocxite|interstitial|veiled|prospecting)\b/i,
    requiredBands: Object.freeze(["nullsec"]),
    requiredUpgradeCategory: "prospecting",
    enforce: true,
    sourceRefs: Object.freeze(["ccpSovHub", "ccpEquinoxSovUpdates"]),
    assumptions: Object.freeze([
      "Generated ore-deposit templates that look like upgrade-supplied deposits are treated as Sov Hub prospecting content.",
    ]),
  }),
  Object.freeze({
    key: "sov_threat_detection_combat",
    // Only the sovereignty-supplied family answers to this rule; the ordinary
    // anomaly families place Hidden/Forsaken/Havens by their own bands.
    spawnFamilies: Object.freeze(["sov_threat_detection"]),
    siteFamilies: Object.freeze(["combat"]),
    siteKinds: Object.freeze(["anomaly"]),
    namePattern: /\b(sanctum|haven|hub|rally point|forlorn|forsaken|hidden)\b/i,
    requiredBands: Object.freeze(["nullsec"]),
    requiredUpgradeCategory: "threat_detection",
    enforce: false,
    sourceRefs: Object.freeze(["ccpSovHubCombatAnomalies"]),
    assumptions: Object.freeze([
      "Baseline combat-anomaly profiles may still seed combat anomalies; threat-detection arrays are modeled as an optional upgraded supply path.",
    ]),
  }),
  Object.freeze({
    key: "sov_exploration_detector_signature",
    // Only the sovereignty-supplied family answers to this rule; ordinary
    // data, relic and combat-hacking signatures follow their families' bands
    // (high-sec and low-sec included) and, in wormhole space, the class rule.
    spawnFamilies: Object.freeze(["sov_exploration_detector"]),
    siteFamilies: Object.freeze(["data", "relic", "combat_hacking"]),
    siteKinds: Object.freeze(["signature"]),
    namePattern: /.*/i,
    requiredBands: Object.freeze(["nullsec"]),
    requiredUpgradeCategory: "exploration_detector",
    enforce: false,
    sourceRefs: Object.freeze(["ccpSovHub"]),
    assumptions: Object.freeze([
      "Exploration Detector upgrades are modeled as an optional upgraded supply path for scanner signatures, not a baseline signature requirement.",
    ]),
  }),
]);

const COMPLETION_RESPAWN_RULES = Object.freeze({
  combat_anomaly: Object.freeze({
    delayMs: 0,
    mode: "next_universe_tick",
    sourceRefs: Object.freeze(["eveUniCosmicAnomalies"]),
    assumptions: Object.freeze([
      "The emulator rotates completed combat anomalies on the next universe tick.",
    ]),
  }),
  combat_signature: Object.freeze({
    delayMs: 0,
    mode: "next_universe_tick",
    sourceRefs: Object.freeze(["eveUniCosmicAnomalies"]),
    assumptions: Object.freeze([
      "Combat signatures use the same immediate replacement bucket once a completion hook marks them cleared.",
    ]),
  }),
  data_signature: Object.freeze({
    delayMs: 0,
    mode: "next_universe_tick",
    sourceRefs: Object.freeze(["eveUniCosmicAnomalies"]),
    assumptions: Object.freeze([
      "Hacked-and-emptied data signatures leave the active supply bucket immediately.",
    ]),
  }),
  relic_signature: Object.freeze({
    delayMs: 0,
    mode: "next_universe_tick",
    sourceRefs: Object.freeze(["eveUniCosmicAnomalies"]),
    assumptions: Object.freeze([
      "Hacked-and-emptied relic signatures leave the active supply bucket immediately.",
    ]),
  }),
  gas_depleted: Object.freeze({
    delayMs: 0,
    mode: "next_universe_tick",
    sourceRefs: Object.freeze(["eveUniGasCloudHarvesting"]),
    assumptions: Object.freeze([
      "A harvested-out gas site is replaced as soon as its grid empties, by a new site elsewhere, the way cleared combat anomalies rotate.",
    ]),
  }),
  ore_depleted: Object.freeze({
    delayMs: 0,
    mode: "next_universe_tick",
    sourceRefs: Object.freeze(["eveUniAsteroidsAndOre"]),
    assumptions: Object.freeze([
      "A mined-out ore anomaly is replaced as soon as its grid empties, by a new anomaly elsewhere, the way cleared combat anomalies rotate.",
    ]),
  }),
});

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

const SECURITY_BANDS = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole"]);

function normalizeSecurityBand(value) {
  const normalized = normalizeLowerText(value, "nullsec");
  return SECURITY_BANDS.includes(normalized) ? normalized : "nullsec";
}

// Unlike normalizeSecurityBand, an unknown band stays unknown here: a pack that
// misspells one must fail loudly rather than silently mean null-sec.
function normalizeDeclaredSecurityBand(value) {
  const normalized = normalizeLowerText(value, "");
  return SECURITY_BANDS.includes(normalized) ? normalized : "";
}

function getSecurityBand(systemID) {
  const numericSystemID = toInt(systemID, 0);
  if (numericSystemID >= 31_000_000 && numericSystemID <= 31_999_999) {
    return "wormhole";
  }
  const systemRecord = worldData.getSolarSystemByID(numericSystemID) || null;
  const securityStatus = Number(
    systemRecord && (systemRecord.securityStatus ?? systemRecord.security),
  );
  if (Number.isFinite(securityStatus)) {
    if (securityStatus >= 0.45) {
      return "highsec";
    }
    if (securityStatus >= 0) {
      return "lowsec";
    }
  }
  return "nullsec";
}

function normalizeStringArray(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => normalizeText(entry, ""))
    .filter(Boolean))];
}

function normalizeUpgrade(value = {}) {
  if (typeof value === "string") {
    return {
      typeID: null,
      name: normalizeText(value, ""),
      online: true,
    };
  }
  const definition = value && value.definition && typeof value.definition === "object"
    ? value.definition
    : {};
  const name = normalizeText(
    value.typeName,
    normalizeText(
      value.name,
      normalizeText(
        value.displayName,
        normalizeText(
          definition.typeName,
          normalizeText(definition.name, normalizeText(definition.displayName, "")),
        ),
      ),
    ),
  );
  const powerState = value.powerState != null
    ? value.powerState
    : value.power_state;
  const online =
    value.online === true ||
    value.isOnline === true ||
    powerState === POWER_STATE_ONLINE ||
    normalizeLowerText(powerState, "") === "online" ||
    (
      value.online == null &&
      value.isOnline == null &&
      powerState == null &&
      name.length > 0
    );
  return {
    typeID: toInt(value.typeID, toInt(definition.typeID, null)),
    name,
    online,
  };
}

function normalizeUpgrades(...values) {
  const merged = [];
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      const upgrade = normalizeUpgrade(entry);
      if (upgrade.name || upgrade.typeID) {
        merged.push(upgrade);
      }
    }
  }
  return merged;
}

function extractHubUpgrades(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  if (Array.isArray(payload.upgrades)) {
    return payload.upgrades;
  }
  if (Array.isArray(payload.installedUpgrades)) {
    return payload.installedUpgrades;
  }
  return [];
}

function normalizePolicyContext(context = {}) {
  const source = context && typeof context === "object" ? context : {};
  const sov = source.sovereignty && typeof source.sovereignty === "object"
    ? source.sovereignty
    : source;
  const claim = sov.claim || source.claim || null;
  const hubID = toInt(
    sov.hubID,
    toInt(source.hubID, toInt(sov.infrastructureHubID, toInt(source.infrastructureHubID, 0))),
  );
  const onlineUpgradeNames = normalizeStringArray([
    ...(Array.isArray(sov.onlineUpgradeNames) ? sov.onlineUpgradeNames : []),
    ...(Array.isArray(source.onlineUpgradeNames) ? source.onlineUpgradeNames : []),
  ]);
  const upgrades = normalizeUpgrades(
    sov.onlineUpgrades,
    source.onlineUpgrades,
    sov.upgrades,
    source.upgrades,
    onlineUpgradeNames,
  );
  const normalizedUpgrades = upgrades.map((upgrade) => ({
    ...upgrade,
    online: upgrade.online !== false,
  }));
  const hasSovereignty =
    sov.hasSovereignty === true ||
    source.hasSovereignty === true ||
    Boolean(
      claim &&
      (
        toInt(claim.ownerID, 0) > 0 ||
        toInt(claim.allianceID, 0) > 0 ||
        toInt(claim.corporationID, 0) > 0 ||
        toInt(claim.claimStructureID, 0) > 0
      ),
    );
  return {
    securityBand: normalizeSecurityBand(source.securityBand || sov.securityBand || "nullsec"),
    localPirateFactionKey: normalizeLowerText(
      source.localPirateFactionKey || sov.localPirateFactionKey,
      "mixed",
    ),
    localPirateFactionSource: normalizeLowerText(
      source.localPirateFactionSource || sov.localPirateFactionSource,
      "unmapped",
    ),
    localPirateFactionSpecialSpace:
      source.localPirateFactionSpecialSpace === true ||
      sov.localPirateFactionSpecialSpace === true,
    wormhole: normalizeWormholeContext(source.wormhole),
    sovereignty: {
      hasSovereignty,
      claim: cloneValue(claim),
      hubID: hubID || null,
      onlineUpgrades: normalizedUpgrades.filter((upgrade) => upgrade.online !== false),
      upgrades: normalizedUpgrades,
      development: cloneValue(sov.development || source.development || {}),
    },
  };
}

// The system's wormhole placement (class, shattered, hosted site classes), or
// null when the caller did not resolve it (known space, or a minimal context).
function normalizeWormholeContext(value) {
  if (!value || typeof value !== "object" || value.isWormholeSpace !== true) {
    return null;
  }
  return {
    systemID: toInt(value.systemID, 0),
    classID: toInt(value.classID, 0),
    kind: normalizeLowerText(value.kind, "wormhole"),
    isWormholeSpace: true,
    shattered: value.shattered === true,
    siteClasses: [...new Set((Array.isArray(value.siteClasses) ? value.siteClasses : [])
      .map((entry) => toInt(entry, 0))
      .filter((entry) => entry > 0))].sort((left, right) => left - right),
  };
}

function buildRuntimeSystemPolicyContext(systemID, options = {}) {
  const numericSystemID = toInt(systemID, 0);
  const localPirateFaction = options.localPirateFactionResolution &&
    typeof options.localPirateFactionResolution === "object"
    ? options.localPirateFactionResolution
    : pirateFactionPolicy.resolvePirateFactionForSystem(numericSystemID, {
      factionKey: options.localPirateFactionKey,
    });
  let claim = null;
  let hubID = 0;
  let hubUpgrades = [];
  let development = {};

  try {
    claim = sovState.getSystemSovClaim(numericSystemID);
  } catch (_) {
    claim = null;
  }

  try {
    hubID = toInt(sovModernState.getHubIDForSolarSystem(numericSystemID), 0);
  } catch (_) {
    hubID = 0;
  }

  if (!hubID) {
    try {
      const hubClaim = sovState.getInfrastructureHubClaim(numericSystemID);
      hubID = toInt(
        hubClaim && (
          hubClaim.infrastructureHubID ||
          hubClaim.hubID ||
          hubClaim.claimStructureID ||
          hubClaim.itemID
        ),
        0,
      );
    } catch (_) {
      hubID = 0;
    }
  }

  if (hubID > 0) {
    try {
      hubUpgrades = extractHubUpgrades(sovModernState.getHubUpgrades(hubID));
    } catch (_) {
      hubUpgrades = [];
    }
  }

  try {
    const devIndices = sovState.getDevelopmentIndicesForSystem(numericSystemID);
    development = devIndices && typeof devIndices === "object" ? devIndices : {};
  } catch (_) {
    development = {};
  }

  return normalizePolicyContext({
    securityBand: normalizeSecurityBand(options.securityBand || getSecurityBand(numericSystemID)),
    localPirateFactionKey: localPirateFaction.factionKey,
    localPirateFactionSource: localPirateFaction.source,
    localPirateFactionSpecialSpace: localPirateFaction.specialSpace === true,
    wormhole: wormholeSpaceAuthority.getWormholeSpaceProfile(numericSystemID),
    sovereignty: {
      claim,
      hasSovereignty: Boolean(claim),
      hubID,
      upgrades: hubUpgrades,
      development,
    },
  });
}

function getTemplateName(template = {}) {
  return normalizeText(
    template.resolvedName,
    normalizeText(template.name, normalizeText(template.templateID, "")),
  );
}

function normalizeSiteFamily(value, fallback = "") {
  const normalized = normalizeLowerText(value, fallback);
  return normalized === "combat_anomaly" ? "combat" : normalized;
}

function isRuledSpawnFamily(family) {
  return RULED_SITE_FAMILIES.has(normalizeSiteFamily(family, ""));
}

function isLocallyScopedPirateSpawnFamily(family) {
  return LOCALLY_SCOPED_PIRATE_SPAWN_FAMILIES.has(
    normalizeLowerText(family, ""),
  );
}

function normalizeSiteInput(input = {}) {
  const template = input.template && typeof input.template === "object"
    ? input.template
    : {};
  const spawnFamilyKey = normalizeLowerText(input.spawnFamilyKey || input.family, "");
  const siteFamily = normalizeSiteFamily(
    input.siteFamily,
    normalizeSiteFamily(template.siteFamily, normalizeSiteFamily(spawnFamilyKey, "unknown")),
  );
  const siteKind = normalizeLowerText(
    input.siteKind,
    normalizeLowerText(template.siteKind, spawnFamilyKey === "combat_anomaly" ? "anomaly" : "signature"),
  );
  const securityBand = normalizeSecurityBand(input.securityBand || getSecurityBand(input.systemID));
  return {
    template,
    templateID: normalizeText(template.templateID, ""),
    templateName: getTemplateName(template),
    sourceDungeonID: oreAnomalySecurityAuthority.resolveTemplateSourceDungeonID(template),
    source: normalizeLowerText(template.source, ""),
    spawnFamilyKey,
    siteFamily,
    siteKind,
    securityBand,
    securityTier: normalizeLowerText(
      input.securityTier,
      oreAnomalySecurityAuthority.resolveSecurityTierForSystemID(input.systemID),
    ),
    systemID: toInt(input.systemID, 0),
  };
}

function siteMatchesRule(site, rule) {
  if (!site || !rule) {
    return false;
  }
  if (Array.isArray(rule.siteFamilies) && rule.siteFamilies.length > 0) {
    const families = rule.siteFamilies.map((entry) => normalizeSiteFamily(entry, ""));
    if (!families.includes(site.siteFamily)) {
      return false;
    }
  }
  if (Array.isArray(rule.spawnFamilies) && rule.spawnFamilies.length > 0) {
    const spawnFamilies = rule.spawnFamilies.map((entry) => normalizeLowerText(entry, ""));
    if (!spawnFamilies.includes(site.spawnFamilyKey)) {
      return false;
    }
  }
  if (Array.isArray(rule.siteKinds) && rule.siteKinds.length > 0) {
    const kinds = rule.siteKinds.map((entry) => normalizeLowerText(entry, ""));
    if (!kinds.includes(site.siteKind)) {
      return false;
    }
  }
  return !rule.namePattern || rule.namePattern.test(site.templateName);
}

function dedupeStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((entry) => normalizeText(entry, ""))
    .filter(Boolean))];
}

function hasOnlineUpgradeCategory(context, category) {
  const normalizedCategory = normalizeLowerText(category, "");
  const patterns = UPGRADE_CATEGORY_PATTERNS[normalizedCategory] || [];
  if (patterns.length <= 0) {
    return false;
  }
  const normalizedContext = normalizePolicyContext(context);
  return normalizedContext.sovereignty.onlineUpgrades.some((upgrade) => (
    patterns.some((pattern) => pattern.test(normalizeText(upgrade.name, "")))
  ));
}

function buildAllowedResult(site, policyKey, extra = {}) {
  return {
    allowed: true,
    reason: normalizeText(extra.reason, "allowed"),
    policyKey,
    securityBand: site.securityBand,
    siteFamily: site.siteFamily,
    siteKind: site.siteKind,
    securityTier: normalizeLowerText(extra.securityTier, site.securityTier) || null,
    sourceDungeonID: Math.max(0, toInt(extra.sourceDungeonID, site.sourceDungeonID)),
    authorityVersion: Math.max(0, toInt(extra.authorityVersion, 0)),
    requiredBands: Array.isArray(extra.requiredBands) ? [...extra.requiredBands] : [],
    requiredUpgradeCategory: normalizeText(extra.requiredUpgradeCategory, "") || null,
    localPirateFactionKey: normalizeLowerText(extra.localPirateFactionKey, "") || null,
    localPirateFactionSource: normalizeLowerText(extra.localPirateFactionSource, "") || null,
    localPirateFactionSpecialSpace: extra.localPirateFactionSpecialSpace === true,
    templatePirateFactionKeys: dedupeStrings(extra.templatePirateFactionKeys),
    factionClassifierVersion: Math.max(0, toInt(extra.factionClassifierVersion, 0)),
    reviewedNeutralOverride: extra.reviewedNeutralOverride === true,
    sourceRefs: dedupeStrings(extra.sourceRefs),
    assumptions: dedupeStrings(extra.assumptions),
    tags: dedupeStrings(extra.tags),
  };
}

function buildBlockedResult(site, policyKey, reason, extra = {}) {
  return {
    allowed: false,
    reason: normalizeText(reason, "blocked"),
    policyKey,
    securityBand: site.securityBand,
    siteFamily: site.siteFamily,
    siteKind: site.siteKind,
    securityTier: normalizeLowerText(extra.securityTier, site.securityTier) || null,
    sourceDungeonID: Math.max(0, toInt(extra.sourceDungeonID, site.sourceDungeonID)),
    authorityVersion: Math.max(0, toInt(extra.authorityVersion, 0)),
    requiredBands: Array.isArray(extra.requiredBands) ? [...extra.requiredBands] : [],
    requiredUpgradeCategory: normalizeText(extra.requiredUpgradeCategory, "") || null,
    localPirateFactionKey: normalizeLowerText(extra.localPirateFactionKey, "") || null,
    localPirateFactionSource: normalizeLowerText(extra.localPirateFactionSource, "") || null,
    localPirateFactionSpecialSpace: extra.localPirateFactionSpecialSpace === true,
    templatePirateFactionKeys: dedupeStrings(extra.templatePirateFactionKeys),
    factionClassifierVersion: Math.max(0, toInt(extra.factionClassifierVersion, 0)),
    reviewedNeutralOverride: extra.reviewedNeutralOverride === true,
    sourceRefs: dedupeStrings(extra.sourceRefs),
    assumptions: dedupeStrings(extra.assumptions),
    tags: dedupeStrings(extra.tags),
  };
}

function isLocallyScopedPirateSite(site) {
  return LOCALLY_SCOPED_PIRATE_SPAWN_FAMILIES.has(
    normalizeLowerText(site && site.spawnFamilyKey, ""),
  );
}

function buildLocalPirateFactionMetadata(context, templatePirateFactionKeys = [], extra = {}) {
  const normalizedContext = normalizePolicyContext(context);
  return {
    localPirateFactionKey: normalizedContext.localPirateFactionKey,
    localPirateFactionSource: normalizedContext.localPirateFactionSource,
    localPirateFactionSpecialSpace: normalizedContext.localPirateFactionSpecialSpace === true,
    templatePirateFactionKeys: dedupeStrings(templatePirateFactionKeys),
    factionClassifierVersion: pirateFactionPolicy.TEMPLATE_CLASSIFIER_VERSION,
    reviewedNeutralOverride: extra.reviewedNeutralOverride === true,
  };
}

function evaluateLocalPirateFactionRule(site, context, options = {}) {
  if (!isLocallyScopedPirateSite(site)) {
    return null;
  }
  const normalizedContext = normalizePolicyContext(context);
  const localFactionKey = normalizedContext.localPirateFactionKey;
  const templateFactionKeys = pirateFactionPolicy.resolveTemplatePirateFactionKeys(site.template);
  const metadata = buildLocalPirateFactionMetadata(
    normalizedContext,
    templateFactionKeys,
  );

  // Wormhole space has no local pirate faction, which the resolver reports as
  // special space. A profile whose content belongs in wormholes (ghost sites'
  // Superior tier) declares wormholeFactionScope "any": any faction's site may
  // appear there, while Pochven and Zarzakh (never the wormhole band) stay blocked.
  if (
    normalizeLowerText(options.wormholeFactionScope, "") === "any" &&
    normalizeSecurityBand(site.securityBand) === "wormhole"
  ) {
    return buildAllowedResult(site, "local_pirate_faction", {
      ...metadata,
      reason: "allowed_wormhole_any_faction",
      tags: ["local_pirate_faction", "wormhole_any_faction"],
    });
  }

  // Wormhole space belongs to the Sleepers: Sleeper content is the local
  // faction's own, faction-neutral content (drifters) and exploration sites
  // are at home there too, and the wormhole class rule decides where. Pirate
  // and drone combat content never spawns there unless the profile says so
  // (wormholeFactionScope above).
  if (normalizedContext.localPirateFactionSource === "wormhole") {
    if (templateFactionKeys.includes(WORMHOLE_LOCAL_FACTION_KEY)) {
      return buildAllowedResult(site, "local_pirate_faction", {
        ...metadata,
        reason: "allowed_local_pirate_faction",
        tags: ["local_pirate_faction", "wormhole_space"],
      });
    }
    const explorationSite = WORMHOLE_EXPLORATION_SITE_FAMILIES.has(site.siteFamily);
    if (templateFactionKeys.length <= 0 || explorationSite) {
      return buildAllowedResult(site, "local_pirate_faction", {
        ...metadata,
        reason: "allowed_wormhole_space",
        tags: ["local_pirate_faction", "wormhole_space"],
      });
    }
    return buildBlockedResult(
      site,
      "local_pirate_faction",
      "wormhole_space_no_local_pirate_faction",
      {
        ...metadata,
        tags: ["local_pirate_faction", "wormhole_space"],
      },
    );
  }

  if (
    normalizedContext.localPirateFactionSpecialSpace === true ||
    normalizedContext.localPirateFactionSource === "special_space"
  ) {
    return buildBlockedResult(
      site,
      "local_pirate_faction",
      "special_space_local_pirate_supply_blocked",
      {
        ...metadata,
        tags: ["local_pirate_faction", "special_space"],
      },
    );
  }

  // A spawn profile can declare its faction at home everywhere (rogue drone
  // anomalies appear in every region): special space stays blocked above, but
  // the system's local pirate faction no longer has to match the template.
  const templateFactionScope = normalizeLowerText(site.template && site.template.factionScope, "");
  if (templateFactionScope === "anywhere" || normalizeLowerText(options.factionScope, "") === "anywhere") {
    return buildAllowedResult(site, "local_pirate_faction", {
      ...metadata,
      reason: templateFactionScope === "anywhere"
        ? "allowed_template_faction_scope_anywhere"
        : "allowed_faction_scope_anywhere",
      tags: ["local_pirate_faction", "faction_scope_anywhere", ...(templateFactionScope === "anywhere" ? ["template_scope"] : [])],
    });
  }

  // A spawn profile can insist on a concrete local pirate faction (content-pack
  // pirate anomalies do): an unmapped "mixed" system then gets no site rather
  // than a site of an arbitrary faction.
  if (
    options.requireConcreteLocalPirateFaction === true &&
    !pirateFactionPolicy.isSupportedLocalPirateFactionKey(localFactionKey)
  ) {
    return buildBlockedResult(
      site,
      "local_pirate_faction",
      "concrete_local_pirate_faction_required",
      {
        ...metadata,
        tags: ["local_pirate_faction", "concrete_faction_required"],
      },
    );
  }

  if (pirateFactionPolicy.isSupportedLocalPirateFactionKey(localFactionKey)) {
    if (templateFactionKeys.includes(localFactionKey)) {
      return buildAllowedResult(site, "local_pirate_faction", {
        ...metadata,
        reason: "allowed_local_pirate_faction",
        tags: ["local_pirate_faction"],
      });
    }

    const reviewedNeutralTemplateIDs = new Set(
      normalizeStringArray(options.reviewedNeutralTemplateIDs),
    );
    if (
      templateFactionKeys.length <= 0 &&
      reviewedNeutralTemplateIDs.has(site.templateID)
    ) {
      return buildAllowedResult(site, "local_pirate_faction", {
        ...buildLocalPirateFactionMetadata(normalizedContext, [], {
          reviewedNeutralOverride: true,
        }),
        reason: "allowed_reviewed_neutral_template",
        tags: ["local_pirate_faction", "reviewed_neutral"],
      });
    }

    return buildBlockedResult(
      site,
      "local_pirate_faction",
      templateFactionKeys.length <= 0
        ? "unknown_template_faction"
        : "wrong_local_pirate_faction",
      {
        ...metadata,
        tags: ["local_pirate_faction"],
      },
    );
  }

  if (localFactionKey === "mixed") {
    return buildAllowedResult(site, "local_pirate_faction", {
      ...metadata,
      reason: "allowed_unmapped_system_faction",
      tags: ["local_pirate_faction", "unmapped_system_faction"],
    });
  }

  return buildBlockedResult(
    site,
    "local_pirate_faction",
    "unsupported_local_pirate_faction",
    {
      ...metadata,
      tags: ["local_pirate_faction", "unsupported_local_faction"],
    },
  );
}

function mergeLocalPirateFactionEvaluation(result, localEvaluation) {
  if (!localEvaluation) {
    return result;
  }
  const merged = {
    ...result,
    localPirateFactionKey: localEvaluation.localPirateFactionKey,
    localPirateFactionSource: localEvaluation.localPirateFactionSource,
    localPirateFactionSpecialSpace: localEvaluation.localPirateFactionSpecialSpace === true,
    templatePirateFactionKeys: [...(localEvaluation.templatePirateFactionKeys || [])],
    factionClassifierVersion: localEvaluation.factionClassifierVersion,
    reviewedNeutralOverride: localEvaluation.reviewedNeutralOverride === true,
    tags: dedupeStrings([
      ...(result && result.tags || []),
      ...(localEvaluation.tags || []),
    ]),
  };
  if (
    result && result.allowed !== false &&
    (
      localEvaluation.reason === "allowed_local_pirate_faction" ||
      localEvaluation.reason === "allowed_reviewed_neutral_template" ||
      localEvaluation.reason === "allowed_unmapped_system_faction" ||
      localEvaluation.reason === "allowed_faction_scope_anywhere" ||
      localEvaluation.reason === "allowed_wormhole_any_faction" ||
      localEvaluation.reason === "allowed_wormhole_space"
    )
  ) {
    merged.reason = localEvaluation.reason;
  }
  return merged;
}

function evaluateSovereigntyUpgradeRule(site, context, rule, options = {}) {
  const requiredBands = Array.isArray(rule.requiredBands) ? [...rule.requiredBands] : [];
  if (requiredBands.length > 0 && !requiredBands.includes(site.securityBand)) {
    return buildBlockedResult(site, rule.key, "wrong_security_band_for_sov_upgrade_site", {
      requiredBands,
      requiredUpgradeCategory: rule.requiredUpgradeCategory,
      sourceRefs: rule.sourceRefs,
      assumptions: rule.assumptions,
      tags: ["sov_upgrade"],
    });
  }

  const enforce =
    options.enforceSovereigntyUpgrades === true ||
    (
      options.enforceSovereigntyUpgrades !== false &&
      rule.enforce === true
    );
  if (!enforce) {
    return buildAllowedResult(site, rule.key, {
      reason: "allowed_baseline_with_optional_sov_upgrade",
      requiredBands,
      requiredUpgradeCategory: rule.requiredUpgradeCategory,
      sourceRefs: rule.sourceRefs,
      assumptions: rule.assumptions,
      tags: ["sov_upgrade_optional"],
    });
  }

  const normalizedContext = normalizePolicyContext(context);
  if (normalizedContext.sovereignty.hasSovereignty !== true) {
    return buildBlockedResult(site, rule.key, "missing_sovereignty_claim", {
      requiredBands,
      requiredUpgradeCategory: rule.requiredUpgradeCategory,
      sourceRefs: rule.sourceRefs,
      assumptions: rule.assumptions,
      tags: ["sov_upgrade"],
    });
  }
  if (!normalizedContext.sovereignty.hubID) {
    return buildBlockedResult(site, rule.key, "missing_sovereignty_hub", {
      requiredBands,
      requiredUpgradeCategory: rule.requiredUpgradeCategory,
      sourceRefs: rule.sourceRefs,
      assumptions: rule.assumptions,
      tags: ["sov_upgrade"],
    });
  }
  if (!hasOnlineUpgradeCategory(normalizedContext, rule.requiredUpgradeCategory)) {
    return buildBlockedResult(site, rule.key, "missing_required_sov_upgrade", {
      requiredBands,
      requiredUpgradeCategory: rule.requiredUpgradeCategory,
      sourceRefs: rule.sourceRefs,
      assumptions: rule.assumptions,
      tags: ["sov_upgrade"],
    });
  }

  return buildAllowedResult(site, rule.key, {
    reason: "allowed_by_sov_upgrade",
    requiredBands,
    requiredUpgradeCategory: rule.requiredUpgradeCategory,
    sourceRefs: rule.sourceRefs,
    assumptions: rule.assumptions,
    tags: ["sov_upgrade"],
  });
}

function evaluateOrdinaryOreSecurityRule(site) {
  if (
    normalizeLowerText(site && site.spawnFamilyKey, "") !== "ore" ||
    normalizeSiteFamily(site && site.siteFamily, "") !== "ore"
  ) {
    return null;
  }
  const securityTier = normalizeLowerText(
    site.securityTier,
    oreAnomalySecurityAuthority.resolveSecurityTierForSystemID(site.systemID),
  );
  const metadata = {
    securityTier,
    sourceDungeonID: site.sourceDungeonID,
    authorityVersion: oreAnomalySecurityAuthority.AUTHORITY_VERSION,
    sourceRefs: [
      "ccpCatalystMiningContent",
      "ccpResourceDistribution1812",
      "ccpSde",
    ],
    tags: ["ordinary_ore", "strict_security_catalog"],
  };
  if (!oreAnomalySecurityAuthority.isEligibleSecurityTier(securityTier)) {
    return buildBlockedResult(
      site,
      "ordinary_ore_security_catalog",
      "ordinary_ore_security_tier_ineligible",
      metadata,
    );
  }
  if (!oreAnomalySecurityAuthority.isTemplateAllowedInTier(site.template, securityTier)) {
    return buildBlockedResult(
      site,
      "ordinary_ore_security_catalog",
      "ore_template_not_allowed_in_security_tier",
      metadata,
    );
  }
  return buildAllowedResult(site, "ordinary_ore_security_catalog", {
    ...metadata,
    reason: "allowed_by_exact_security_catalog",
  });
}

// Wormhole space hosts each documented site only in the classes it belongs to
// (see wormholeSpaceAuthority). A template that carries no restriction, or a
// system outside wormhole space, leaves this rule silent.
function evaluateWormholeClassRule(site, context) {
  if (normalizeSecurityBand(site.securityBand) !== "wormhole") {
    return null;
  }
  const normalizedContext = normalizePolicyContext(context);
  const wormhole = normalizedContext.wormhole;
  if (!wormhole) {
    return null;
  }
  const restriction = wormholeSpaceAuthority.resolveTemplateWormholeRestriction(site.template, {
    spawnFamilyKey: site.spawnFamilyKey,
  });
  if (!restriction) {
    return null;
  }
  const verdict = wormholeSpaceAuthority.evaluateTemplateInWormholeSystem(site.template, wormhole.systemID, {
    spawnFamilyKey: site.spawnFamilyKey,
  });
  const metadata = {
    wormholeClassID: wormhole.classID,
    wormholeKind: wormhole.kind,
    wormholeShattered: wormhole.shattered,
    wormholeSiteClasses: [...wormhole.siteClasses],
    templateWormholeClasses: [...restriction.classes],
    wormholeRestrictionSource: restriction.source,
    sourceRefs: ["eveUniWormholeSpace"],
    tags: ["wormhole_class"],
  };
  // The result builders keep a fixed shape; the wormhole fields ride alongside.
  if (!verdict || verdict.allowed) {
    return mergeWormholeClassEvaluation(buildAllowedResult(site, "wormhole_class", {
      ...metadata,
      reason: verdict ? verdict.reason : "allowed_wormhole_class",
    }), metadata);
  }
  return mergeWormholeClassEvaluation(buildBlockedResult(site, "wormhole_class", verdict.reason, metadata), metadata);
}

function mergeWormholeClassEvaluation(result, wormholeEvaluation) {
  if (!wormholeEvaluation) {
    return result;
  }
  return {
    ...result,
    wormholeClassID: wormholeEvaluation.wormholeClassID,
    wormholeKind: wormholeEvaluation.wormholeKind,
    wormholeShattered: wormholeEvaluation.wormholeShattered === true,
    wormholeSiteClasses: [...(wormholeEvaluation.wormholeSiteClasses || [])],
    templateWormholeClasses: [...(wormholeEvaluation.templateWormholeClasses || [])],
    wormholeRestrictionSource: wormholeEvaluation.wormholeRestrictionSource || null,
    wormholeClassReason: wormholeEvaluation.wormholeClassReason || wormholeEvaluation.reason || null,
    tags: dedupeStrings([
      ...(result && result.tags || []),
      ...(wormholeEvaluation.tags || []),
    ]),
  };
}

// A pack template may name the security bands its site belongs to, the way a
// wormhole template names its classes. The documented spawn band of a site is
// its tier, not its difficulty: a Hidden Hideaway is a high-sec site while a
// Hidden Den is low-sec and null-sec, so a difficulty range cannot say it.
// A template without the field is unrestricted and the family's bands decide.
//
// Sovereignty Hub threat detection is the documented exception. A Minor array
// "causes sites that are usually only found in hisec or lowsec to spawn such
// as refuges, dens, and rally points" (EVE University, Sovereignty), in the
// counts CCP's Sov Hub combat anomaly table gives per security bracket. A
// template's natural band does not apply to that supply path.
const TEMPLATE_SECURITY_BAND_EXEMPT_SPAWN_FAMILIES = new Set([
  "sov_threat_detection",
]);

function evaluateTemplateSecurityBandRule(site) {
  if (TEMPLATE_SECURITY_BAND_EXEMPT_SPAWN_FAMILIES.has(site.spawnFamilyKey)) {
    return null;
  }
  const raw = normalizeStringArray(site.template && site.template.securityBands);
  if (raw.length <= 0) {
    return null;
  }
  const bands = dedupeStrings(raw.map((band) => normalizeDeclaredSecurityBand(band)).filter(Boolean));
  if (bands.length !== raw.length) {
    // A template that names a band this engine does not know is a pack bug, and
    // guessing would put the site in the wrong space. Refuse it everywhere.
    const unknownMetadata = {
      templateSecurityBands: [...bands],
      requiredBands: [...bands],
      tags: ["template_security_band"],
    };
    return mergeTemplateSecurityBandEvaluation(
      buildBlockedResult(site, "template_security_band", "unknown_template_security_band", unknownMetadata),
      unknownMetadata,
    );
  }
  const metadata = {
    templateSecurityBands: [...bands],
    requiredBands: [...bands],
    sourceRefs: normalizeStringArray(site.template && site.template.securityBandSourceRefs),
    tags: ["template_security_band"],
  };
  // The result builders keep a fixed shape and drop unknown fields, so the
  // band list is attached to whatever they return.
  if (bands.includes(site.securityBand)) {
    return mergeTemplateSecurityBandEvaluation(
      buildAllowedResult(site, "template_security_band", {
        ...metadata,
        reason: "allowed_template_security_band",
      }),
      metadata,
    );
  }
  return mergeTemplateSecurityBandEvaluation(
    buildBlockedResult(
      site,
      "template_security_band",
      "wrong_security_band_for_template",
      metadata,
    ),
    metadata,
  );
}

function mergeTemplateSecurityBandEvaluation(result, evaluation) {
  if (!evaluation) {
    return result;
  }
  return {
    ...result,
    templateSecurityBands: [...(evaluation.templateSecurityBands || [])],
    tags: dedupeStrings([
      ...(result && result.tags || []),
      ...(evaluation.tags || []),
    ]),
  };
}

function evaluateSiteSpawnPolicy(input = {}, context = {}, options = {}) {
  const site = normalizeSiteInput(input);
  const wormholeClassEvaluation = evaluateWormholeClassRule(site, context);
  if (wormholeClassEvaluation && wormholeClassEvaluation.allowed === false) {
    return wormholeClassEvaluation;
  }
  // The template's own band restriction is decided before the family's rules,
  // so a site never appears in a band its documented tier never reaches.
  const securityBandEvaluation = evaluateTemplateSecurityBandRule(site);
  if (securityBandEvaluation && securityBandEvaluation.allowed === false) {
    // The result builders keep a fixed shape, so the band fields are merged
    // back onto the refusal the same way the wormhole ones are.
    return mergeTemplateSecurityBandEvaluation(
      mergeWormholeClassEvaluation(securityBandEvaluation, wormholeClassEvaluation),
      securityBandEvaluation,
    );
  }
  return mergeTemplateSecurityBandEvaluation(
    mergeWormholeClassEvaluation(
      evaluateSiteSpawnPolicyWithinBand(site, context, options),
      wormholeClassEvaluation,
    ),
    securityBandEvaluation,
  );
}

function evaluateSiteSpawnPolicyWithinBand(site, context, options) {
  const localPirateFactionEvaluation = evaluateLocalPirateFactionRule(
    site,
    context,
    options,
  );
  if (localPirateFactionEvaluation && localPirateFactionEvaluation.allowed === false) {
    return localPirateFactionEvaluation;
  }
  if (!RULED_SITE_FAMILIES.has(site.siteFamily)) {
    return mergeLocalPirateFactionEvaluation(buildAllowedResult(site, "unruled_family", {
      reason: "allowed_unruled_family",
    }), localPirateFactionEvaluation);
  }

  const ordinaryOreEvaluation = evaluateOrdinaryOreSecurityRule(site);
  if (ordinaryOreEvaluation) {
    return mergeLocalPirateFactionEvaluation(
      ordinaryOreEvaluation,
      localPirateFactionEvaluation,
    );
  }

  for (const rule of SPACE_BAND_RULES) {
    if (!siteMatchesRule(site, rule)) {
      continue;
    }
    const requiredBands = Array.isArray(rule.allowedBands) ? [...rule.allowedBands] : [];
    if (!requiredBands.includes(site.securityBand)) {
      return mergeLocalPirateFactionEvaluation(buildBlockedResult(site, rule.key, "wrong_security_band", {
        requiredBands,
        sourceRefs: rule.sourceRefs,
        tags: ["space_band"],
      }), localPirateFactionEvaluation);
    }
    return mergeLocalPirateFactionEvaluation(buildAllowedResult(site, rule.key, {
      reason: "allowed_by_security_band",
      requiredBands,
      sourceRefs: rule.sourceRefs,
      tags: ["space_band"],
    }), localPirateFactionEvaluation);
  }

  for (const rule of SOV_UPGRADE_RULES) {
    if (siteMatchesRule(site, rule)) {
      return mergeLocalPirateFactionEvaluation(
        evaluateSovereigntyUpgradeRule(site, context, rule, options),
        localPirateFactionEvaluation,
      );
    }
  }

  return mergeLocalPirateFactionEvaluation(buildAllowedResult(site, "baseline_family", {
    reason: "allowed_baseline_family",
    sourceRefs: ["eveUniCosmicAnomalies"],
    assumptions: [
      "Baseline security-band and density selection remains owned by dungeonAuthority spawn profiles.",
    ],
  }), localPirateFactionEvaluation);
}

function buildSelectionMetadata(evaluation) {
  const result = evaluation && typeof evaluation === "object" ? evaluation : {};
  return {
    version: POLICY_VERSION,
    allowed: result.allowed !== false,
    policyKey: normalizeText(result.policyKey, "unknown"),
    reason: normalizeText(result.reason, ""),
    securityTier: normalizeLowerText(result.securityTier, "") || null,
    sourceDungeonID: Math.max(0, toInt(result.sourceDungeonID, 0)),
    authorityVersion: Math.max(0, toInt(result.authorityVersion, 0)),
    requiredBands: Array.isArray(result.requiredBands) ? [...result.requiredBands] : [],
    requiredUpgradeCategory: normalizeText(result.requiredUpgradeCategory, "") || null,
    localPirateFactionKey: normalizeLowerText(result.localPirateFactionKey, "") || null,
    localPirateFactionSource: normalizeLowerText(result.localPirateFactionSource, "") || null,
    localPirateFactionSpecialSpace: result.localPirateFactionSpecialSpace === true,
    templatePirateFactionKeys: dedupeStrings(result.templatePirateFactionKeys),
    wormholeClassID: Math.max(0, toInt(result.wormholeClassID, 0)) || null,
    wormholeKind: normalizeLowerText(result.wormholeKind, "") || null,
    wormholeShattered: result.wormholeShattered === true,
    wormholeSiteClasses: Array.isArray(result.wormholeSiteClasses) ? [...result.wormholeSiteClasses] : [],
    templateWormholeClasses: Array.isArray(result.templateWormholeClasses) ? [...result.templateWormholeClasses] : [],
    wormholeRestrictionSource: normalizeText(result.wormholeRestrictionSource, "") || null,
    wormholeClassReason: normalizeText(result.wormholeClassReason, "") || null,
    templateSecurityBands: Array.isArray(result.templateSecurityBands) ? [...result.templateSecurityBands] : [],
    factionClassifierVersion: Math.max(
      0,
      toInt(result.factionClassifierVersion, pirateFactionPolicy.TEMPLATE_CLASSIFIER_VERSION),
    ),
    reviewedNeutralOverride: result.reviewedNeutralOverride === true,
    sourceRefs: dedupeStrings(result.sourceRefs),
    assumptions: dedupeStrings(result.assumptions),
    tags: dedupeStrings(result.tags),
  };
}

function getCompletionRespawnRule(input = {}) {
  const siteFamily = normalizeSiteFamily(input.siteFamily || input.family, "unknown");
  const siteKind = normalizeLowerText(input.siteKind, "signature");
  const lifecycleReason = normalizeLowerText(input.lifecycleReason || input.reason, "");

  let key = `${siteFamily}_${siteKind}`;
  if ((siteFamily === "ore" || siteFamily === "gas") && lifecycleReason === "depleted") {
    key = `${siteFamily}_depleted`;
  }
  const rule = COMPLETION_RESPAWN_RULES[key] || null;
  if (!rule) {
    return {
      delayMs: 0,
      mode: "next_universe_tick",
      sourceRefs: [],
      assumptions: [
        "No family-specific respawn rule exists yet; use existing immediate universe rotation behavior.",
      ],
    };
  }
  return cloneValue(rule);
}

function getPolicyDescriptor() {
  return {
    version: POLICY_VERSION,
    sources: Object.keys(SOURCE_REFS).sort(),
    ruledFamilies: [...RULED_SITE_FAMILIES].sort(),
    locallyScopedPirateSpawnFamilies: [...LOCALLY_SCOPED_PIRATE_SPAWN_FAMILIES].sort(),
    supportedLocalPirateFactionKeys: [
      ...pirateFactionPolicy.SUPPORTED_LOCAL_PIRATE_FACTION_KEYS,
    ],
    factionClassifierVersion: pirateFactionPolicy.TEMPLATE_CLASSIFIER_VERSION,
    spaceBandRuleKeys: SPACE_BAND_RULES.map((rule) => rule.key),
    sovUpgradeRuleKeys: SOV_UPGRADE_RULES.map((rule) => rule.key),
    wormholeClassRule: {
      siteNameCount: Object.keys(wormholeSpaceAuthority.SITE_CLASSES_BY_NAME).length,
      explorationFactionClasses: [...wormholeSpaceAuthority.EXPLORATION_FACTION_CLASSES],
      shatteredSystemCount: wormholeSpaceAuthority.SHATTERED_SYSTEM_NAMES.length,
    },
    templateSecurityBandRule: {
      securityBands: [...SECURITY_BANDS],
      templateField: "securityBands",
    },
  };
}

module.exports = {
  POLICY_VERSION,
  SOURCE_REFS,
  buildRuntimeSystemPolicyContext,
  buildSelectionMetadata,
  evaluateSiteSpawnPolicy,
  evaluateTemplateSecurityBandRule,
  evaluateWormholeClassRule,
  getCompletionRespawnRule,
  getPolicyDescriptor,
  hasOnlineUpgradeCategory,
  isLocallyScopedPirateSpawnFamily,
  isRuledSpawnFamily,
  normalizePolicyContext,
  _testing: {
    COMPLETION_RESPAWN_RULES,
    SPACE_BAND_RULES,
    SOV_UPGRADE_RULES,
    UPGRADE_CATEGORY_PATTERNS,
    LOCALLY_SCOPED_PIRATE_SPAWN_FAMILIES,
    evaluateLocalPirateFactionRule,
    getSecurityBand,
    normalizeSiteInput,
    normalizeUpgrade,
  },
};
