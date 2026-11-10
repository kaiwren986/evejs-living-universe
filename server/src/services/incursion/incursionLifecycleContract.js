"use strict";

const { createHash } = require("node:crypto");
const VERSION = "evejs.sansha-lifecycle-contract.v1";
const FOCUS_PROFILES = Object.freeze({
  simulation: "phase8-full-content-preview-v1",
  organic: "phase8-organic-high-v1",
});
const ORGANIC_FOCUS_PROFILES = Object.freeze({
  high: FOCUS_PROFILES.organic,
  low: "phase8-organic-low-v1",
  null: "phase8-organic-null-v1",
});
const ORGANIC_CONFIG_KEYS = Object.freeze({
  high: "incursionOrganicHighSecEnabled",
  low: "incursionOrganicLowSecEnabled",
  null: "incursionOrganicNullSecEnabled",
});
const PHASE = Object.freeze({ withdrawing: 0, mobilizing: 1, established: 2 });
const SCENE = Object.freeze({ headquarters: 1, assault: 2, vanguard: 3, staging: 4, boss: 1000001 });
// Reviewed identifiers, not a broad faction/archetype query. The native dictionary
// also contains Throne Worlds. Boss UI severity remains HQ, not boss scene ID.
const SITES = Object.freeze([
  [5191, "scout", 8], [5193, "scout", 8], [5188, "scout", 8], [5190, "scout", 8],
  [5165, "vanguard", 1], [5166, "vanguard", 1], [5164, "vanguard", 1],
  [5167, "assault", 2], [5172, "assault", 2], [5168, "assault", 2],
  [5114, "headquarters", 3], [5175, "headquarters", 3], [5171, "headquarters", 3],
  [5158, "boss", 10], [5201, "boss", 10],
].map(([dungeonID, role, rewardGroupID]) => Object.freeze({ dungeonID, role, rewardGroupID,
  factionID: dungeonID === 5114 ? 500021 : 500019,
  encounterContract: dungeonID === 5166 ? "incursion-vanguard-v1" : null })));

const SOURCES = Object.freeze({
  client: Object.freeze({ kind: "client", builds: [3396210, 3475087],
    reference: "talecommon/const.py:INCURSION_INFO_BY_DUNGEONID; appConst.py; talecommon/influence.py",
    supportedConstSHA256: "d8d0bdf949a68c710c4f4043b3b489d8ff88539bbde9d628eac59428a34c5c5b",
    extraConstSHA256: "e7dc6c53db3f3b50ee4efd9595c156e712a1d7ebe312ae6023cd8db9706a9cc6" }),
  itamo: Object.freeze({ kind: "sampled-capture", taleID: 167056, systemID: 30000119,
    reference: "private phase8-incursions-20261103/itamo-incursion-snapshot-pair.private.json",
    qualification: "Two observations of one tale; no creation timestamp or universal decay profile." }),
  bossAge: Object.freeze({ kind: "official-rule", date: "2024-06-07",
    url: "https://www.eveonline.com/news/view/equinox-expansion-notes" }),
  replacement: Object.freeze({ kind: "historical-official-rule", date: "2014-08-20",
    url: "https://www.eveonline.com/news/view/incursion-changes-in-hyperion" }),
  affected: Object.freeze({ kind: "official-protocol", date: "2016-01-25",
    url: "https://developers.eveonline.com/blog/crest-incursion-update-out-on-singularity" }),
  publicHistory: Object.freeze({ kind: "historical-observation", date: "2026-08-03",
    url: "https://github.com/Shadowlauch/eve-incursions-node/tree/6764c639173b6fd4e8350effcc545e0c583908be",
    seedSHA256: "057a94f58540ef98c7421122e191969e172df7973be78ade8632b31b4f8e62a2",
    qualification: "Polling observations, timezone unspecified; Ended means absent from ESI, not proven expiry. Seed roles are historical assignments." }),
  synthetic: Object.freeze({ kind: "emulator-policy", reference: "doc/PHASE_8_LIFECYCLE_CONTRACT.md",
    qualification: "Accelerated synthetic lifecycle; no retail timing, placement, population or balance claim." }),
});
Object.freeze(SOURCES.client.builds);

const GAPS = Object.freeze([
  "eligible-locations-and-quotas", "phase-duration-distributions", "role-and-slot-selection",
  "site-influence-increments", "full-boss-predicate-and-security-variant",
  "boss-population-and-terminal-objective", "effect-4728-application-and-bounty-order",
  "expiry-lp-history-and-cutoffs",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function fail(code) { const error = new Error(code); error.code = code; throw error; }

function getProfile(profileID) {
  const band = Object.keys(ORGANIC_FOCUS_PROFILES).find(key => ORGANIC_FOCUS_PROFILES[key] === profileID);
  if (band) {
    const profile = getProfile(FOCUS_PROFILES.simulation);
    const bossDungeonID = profile.boss.securityDungeonBindings[band];
    const otherBossDungeonID = bossDungeonID === 5158 ? 5201 : 5158;
    const ageQualification = {
      high: "CCP supplies the high-security minimum age.",
      low: "CCP supplies the low-security minimum age. Uroborus is the qualified emulator variant for low security.",
      null: "Null security has no age floor and uses Kundalini under this emulator policy.",
    }[band];
    return {
      ...profile,
      profileID,
      testOnly: false,
      organicActivation: true,
      source: "emulator-policy",
      unresolved: [],
      retailEvidenceGaps: [...GAPS],
      randomPolicy: "durable-seed-focus-placement-and-replacement",
      phases: [
        { name: "established", durationMs: 72 * 3600000 },
        { name: "mobilizing", durationMs: 24 * 3600000 },
        { name: "withdrawing", durationMs: 24 * 3600000 },
      ],
      replacementDelayMs: null,
      placement: {
        selection: "seeded-connected-systems",
        overlap: "reject-shared-system-or-constellation",
        source: "emulator-policy",
      },
      influence: {
        initial: 0.5,
        graceMinutes: 10,
        decayPerHour: 0.05,
        source: "emulator-policy",
        qualification: band === "high"
          ? "Initial control of 0.5 is an emulator choice. Grace and decay adopt the values observed in Itamo for this profile."
          : "Initial control, grace and decay reuse the high-security emulator policy for this band.",
      },
      sites: {
        ...profile.sites,
        securityBands: [band],
        qualification: "The placement provider assigns one slot per approved normal site. Slot recycling and influence gains use the versioned emulator policy.",
      },
      boss: {
        ...profile.boss,
        minimumAgeMs: { [band]: profile.boss.minimumAgeMs[band] },
        securityDungeonBindings: { [band]: bossDungeonID },
        qualification: `${ageQualification} Full control and a sealed HQ completion at full control are emulator requirements.`,
      },
      encounters: profile.encounters.filter(row => row.dungeonID !== otherBossDungeonID),
    };
  }
  if (profileID === FOCUS_PROFILES.simulation) {
    const profile = getProfile("phase8-terminal-preview-v1");
    return { ...profile, profileID,
      sites: { ...profile.sites, contentVersion: 2, securityBands: ["high", "low", "null"] },
      influence: { ...profile.influence, initial: 1, decayPerHour: 0, source: "emulator-boss-preview",
        qualification: "Full control and zero passive decay are explicit isolated boss-acceptance setup, not retail initial influence or decay." },
      boss: { ...profile.boss, version: "evejs.incursion-final-sites.v1", automaticUnlock: true,
        minimumAgeMs: { high: 72 * 3600000, low: 24 * 3600000, null: 0 },
        securityDungeonBindings: { high: 5158, low: 5201, null: 5158 },
        predicate: "minimum-age-current-full-control-and-applied-hq-completion-at-full-control",
        qualification: "CCP supplies high/low minimum ages. Null age, variant bindings and the complete unlock predicate are versioned emulator policy; an HQ seal is required in this generation." },
      encounters: SITES.map(row => ({ dungeonID: row.dungeonID,
        templateID: row.dungeonID === 5166 ? "evejs-incursion-vanguard:nation-commander-outpost" : `evejs-incursion-sites:${row.dungeonID}`,
        capability: row.dungeonID === 5166 ? "incursion-vanguard-v1" : "incursion-sites-v2", materialize: true })) };
  }
  if (profileID === "phase8-terminal-preview-v1") {
    const profile = getProfile("phase8-shared-sites-preview-v1");
    return { ...profile, profileID, terminal: require("./incursionTerminalContract").policy(),
      phases: [{ name: "established", durationMs: 72 * 3600000 },
        { name: "mobilizing", durationMs: 24 * 3600000 }, { name: "withdrawing", durationMs: 24 * 3600000 }] };
  }
  if (profileID === "phase8-shared-sites-preview-v1") {
    const profile = getProfile("phase8-native-effects-preview-v1");
    return { ...profile, profileID, sites: {
      version: "evejs.incursion-shared-sites.v1", enabled: true, securityBands: ["high"],
      maxSlots: 16, respawnDelayMs: 60000, retryDelayMs: 30000,
      replacementOffsetMeters: 20000000, influencePerCompletion: 0.05,
      influenceClock: "max-last-update-and-completion", renewGrace: true,
      completionCutoff: "active-at-reconciliation-before-expiry",
      qualification: "Explicit emulator preview policy. Client schemas/defaults and per-object respawn commands do not establish selected Sansha slot recycling or completion deltas.",
    }, encounters: profile.encounters.map(row => ({ ...row, materialize: true })) };
  }
  if (profileID === "phase8-native-effects-short-v1") {
    const profile = getProfile("phase8-native-effects-preview-v1");
    return { ...profile, profileID, phases: profile.phases.map(phase => ({ ...phase, durationMs: 60000 })) };
  }
  if (profileID === "phase8-native-effects-preview-v1") {
    const profile = getProfile("phase8-native-presentation-v1");
    const effects = require("./incursionSystemEffectContract");
    return { ...profile, profileID,
      phases: profile.phases.map(phase => ({ ...phase, durationMs: 3600000 })),
      influence: { ...profile.influence, initial: 0.5, source: "synthetic" },
      effects: { application: effects.policy() },
      presentation: { ...profile.presentation, effects: structuredClone(effects.DESCRIPTORS) } };
  }
  if (profileID === "phase8-native-presentation-v1") {
    const profile = getProfile("phase8-synthetic-lifecycle-v1");
    return { ...profile, profileID, presentation: {
      enabled: true, templateClassID: 2, templateNameID: 507300,
      // Sansha template identity is server authoring absent from the capture.
      // This is a synthetic removal-wire identity, not TALE_SYSTEM_MODIFIERS[1].
      templateID: 980000001, templateIDSource: "synthetic", visualEffect: 1,
      hasChat: true, chatAnnouncementMessageId: 508159, effects: [],
    } };
  }
  if (profileID !== "phase8-synthetic-lifecycle-v1") fail("INCURSION_PROFILE_UNAVAILABLE");
  return {
    contractVersion: VERSION, profileID, version: 1, kind: "emulator-policy", testOnly: true,
    organicActivation: false, source: "synthetic", provenance: structuredClone(SOURCES),
    // Explicit policy, never derived by sorting the native enum. Durations are
    // deliberately accelerated for deterministic tests and have no retail claim.
    phases: [{ name: "established", durationMs: 60000 }, { name: "mobilizing", durationMs: 60000 },
      { name: "withdrawing", durationMs: 60000 }],
    replacementDelayMs: 30000, randomPolicy: "none-explicit-frozen-placement",
    influence: { initial: 1, graceMinutes: 10, decayPerHour: 0.05, source: "itamo" },
    boss: { minimumAgeMs: { high: 72 * 3600000, low: 24 * 3600000, null: null },
      ageSource: "bossAge", predicate: null, securityDungeonBindings: null, automaticUnlock: false },
    placement: { selection: "explicit-test-fixture", overlap: "reject-shared-system-or-constellation", source: "synthetic" },
    encounters: [{ dungeonID: 5166, capability: "incursion-vanguard-v1", materialize: false }],
    terminal: { expiry: "durable-decision-only", victory: "unavailable-until-8E", settlement: "unavailable-until-8E",
      source: "synthetic" },
    effects: { application: null }, unresolved: [...GAPS],
  };
}

function activationReadiness(profile = getProfile("phase8-synthetic-lifecycle-v1")) {
  const nativeReady = profile.presentation?.enabled &&
    profile.effects?.application?.version === require("./incursionSystemEffectContract").VERSION;
  const sitesReady = profile.sites?.enabled && profile.sites.version === require("./incursionSiteSlots").VERSION;
  const terminalReady = profile.terminal?.enabled === true &&
    profile.terminal.version === require("./incursionTerminalContract").VERSION;
  const finalReady = profile.boss?.automaticUnlock === true &&
    profile.boss.version === require("./incursionFinalSiteSlots").VERSION;
  const blockers = [...new Set([
    ...(profile.unresolved || []),
    ...(!nativeReady ? ["native-projection-8C"] : []),
    ...(!sitesReady ? ["site-owner-8D"] : []),
    ...(!terminalReady ? ["terminal-settlement-8E"] : []),
    ...(!finalReady ? ["final-site-owner-8E"] : []),
  ])];
  if (!Object.values(ORGANIC_FOCUS_PROFILES).includes(profile.profileID) || profile.testOnly !== false || profile.organicActivation !== true) {
    blockers.unshift("organic-activation-disabled");
  }
  return { ready: blockers.length === 0, blockers };
}

function freezeProfile(profileID, mode) {
  const policy = getProfile(profileID);
  if (!(mode === "simulation" && policy.testOnly === true) &&
      !(mode === "organic" && activationReadiness(policy).ready)) {
    fail("INCURSION_ORGANIC_ACTIVATION_DISABLED");
  }
  return { policy, policyFingerprint: fingerprint(policy) };
}

function organicSchedulingEnabled(band) {
  return Object.hasOwn(ORGANIC_CONFIG_KEYS, band) && require("../../config")[ORGANIC_CONFIG_KEYS[band]] === true;
}

// Python 2 integer division happens before subtracting (possibly float) grace.
// Timestamps here are Unix milliseconds; native adapters supply FILETIME in 8C.
function projectInfluence(snapshot, nowMs) {
  const { value, lastUpdatedAtMs, graceMinutes, decayPerHour } = snapshot;
  if (![value, lastUpdatedAtMs, graceMinutes, decayPerHour, nowMs].every(Number.isFinite) ||
      value < 0 || value > 1 || graceMinutes < 0 || decayPerHour < 0) fail("INCURSION_INFLUENCE_INVALID");
  let projected = value;
  if (decayPerHour > 0 && nowMs - graceMinutes * 60000 > lastUpdatedAtMs) {
    projected -= decayPerHour * Math.max((Math.floor((nowMs - lastUpdatedAtMs) / 60000) - graceMinutes) / 60, 0);
  }
  return projected < 0.0001 ? 0 : projected;
}

module.exports = { VERSION, FOCUS_PROFILES, ORGANIC_FOCUS_PROFILES, PHASE, SCENE, SITES, SOURCES, GAPS, fingerprint, fail, getProfile,
  activationReadiness, freezeProfile, organicSchedulingEnabled, projectInfluence };
