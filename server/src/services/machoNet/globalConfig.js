"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const {
  CLIENT_COMPATIBILITY_PROFILE,
} = require(path.join(__dirname, "../../network/protocolProfile"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  buildClientGlobalConfigEntries,
} = require(path.join(__dirname, "../newEdenStore/storeState"));

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const SAFE_DEFAULT_COUNTRY_CODE = "GB";
const runtimeGlobalConfigOverrides = new Map();
const runtimeGlobalConfigDeletedKeys = new Set();
const DEFAULT_SERVER_STATUS_LABEL = "/Carbon/MachoNet/ServerStatus/OK";
const BUG_REPORT_CONFIG_KEY = "bugReporting_BugReportServer";
const BUG_REPORT_URL = "http://127.0.0.1:26004/api";
const HONEYCOMB_WRITE_KEY = "monolith_honeycomb_public_write_key";

function getRuntimeConfig() {
  if (typeof config.getConfigStateSnapshot === "function") {
    try {
      return config.getConfigStateSnapshot().resolvedConfig || config;
    } catch {
      // ignored: an unreadable config snapshot falls back to the loaded config
    }
  }
  return config;
}

function coerceCountryCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return COUNTRY_CODE_PATTERN.test(normalized) ? normalized : null;
}

function normalizeCountryCode(
  value,
  fallback = getRuntimeConfig().defaultCountryCode,
) {
  const fallbackCountryCode =
    coerceCountryCode(fallback) || SAFE_DEFAULT_COUNTRY_CODE;
  const normalizedCountryCode = coerceCountryCode(value);

  if (!normalizedCountryCode || normalizedCountryCode === "KR") {
    return fallbackCountryCode === "KR"
      ? SAFE_DEFAULT_COUNTRY_CODE
      : fallbackCountryCode;
  }

  return normalizedCountryCode;
}

function buildGlobalConfigEntries(runtimeConfig = getRuntimeConfig()) {
  const baseEntries = [
    [BUG_REPORT_CONFIG_KEY, BUG_REPORT_URL],
    ["imageserverurl", runtimeConfig.imageServerUrl],
    ["defaultPortraitSaveSize", 1024],
    [
      "air_npe_enabled",
      runtimeConfig.newCharacterExperienceMode !== "disabled"
        ? 1
        : 0,
    ],
    ["HyperNetKillSwitch", runtimeConfig.hyperNetKillSwitch ? 1 : 0],
    [
      "HyperNetPlexPriceOverride",
      Number(runtimeConfig.hyperNetPlexPriceOverride || 0) || 0,
    ],
    ["SkillPurchaseEnabled", runtimeConfig.skillPurchaseEnabled ? 1 : 0],
    [
      "expert_system_feature_enabled",
      runtimeConfig.expertSystemsEnabled ? 1 : 0,
    ],
    ...buildClientGlobalConfigEntries(),
  ];

  const entriesByKey = new Map();
  for (const [key, value] of baseEntries) {
    if (!runtimeGlobalConfigDeletedKeys.has(String(key))) {
      entriesByKey.set(key, value);
    }
  }
  for (const [key, value] of runtimeGlobalConfigOverrides.entries()) {
    entriesByKey.set(key, value);
  }
  // Honeycomb starts when this key appears, regardless of which producer set
  // it. Filter the final payload as well as rejecting runtime overrides.
  entriesByKey.delete(HONEYCOMB_WRITE_KEY);
  return Array.from(entriesByKey.entries());
}

function normalizeGlobalConfigKey(key) {
  return String(key === undefined || key === null ? "" : key).trim();
}

function setRuntimeGlobalConfigValue(key, value, options = {}) {
  const normalizedKey = normalizeGlobalConfigKey(key);
  // Offline-only: never allow removal (which restores the CCP default) or
  // replacement with an external endpoint through the GM config service.
  if (normalizedKey === BUG_REPORT_CONFIG_KEY || normalizedKey === HONEYCOMB_WRITE_KEY) return false;
  if (!normalizedKey) {
    return false;
  }

  if (options.isDelete === true) {
    runtimeGlobalConfigOverrides.delete(normalizedKey);
    runtimeGlobalConfigDeletedKeys.add(normalizedKey);
    return true;
  }

  runtimeGlobalConfigDeletedKeys.delete(normalizedKey);
  runtimeGlobalConfigOverrides.set(normalizedKey, value);
  return true;
}

function getRuntimeGlobalConfigValue(key, runtimeConfig = getRuntimeConfig()) {
  const normalizedKey = normalizeGlobalConfigKey(key);
  if (!normalizedKey || runtimeGlobalConfigDeletedKeys.has(normalizedKey)) {
    return null;
  }

  if (runtimeGlobalConfigOverrides.has(normalizedKey)) {
    return runtimeGlobalConfigOverrides.get(normalizedKey);
  }

  const baseEntries = buildGlobalConfigEntries(runtimeConfig);
  for (const [entryKey, entryValue] of baseEntries) {
    if (entryKey === normalizedKey) {
      return entryValue;
    }
  }
  return null;
}

function resetRuntimeGlobalConfigForTests() {
  runtimeGlobalConfigOverrides.clear();
  runtimeGlobalConfigDeletedKeys.clear();
}

function getRuntimeGlobalConfigOverrides() {
  return {
    overrides: Object.fromEntries(runtimeGlobalConfigOverrides.entries()),
    deletedKeys: Array.from(runtimeGlobalConfigDeletedKeys.values()),
  };
}

function buildClientBootMetadataEntries() {
  return [
    ["boot_version", CLIENT_COMPATIBILITY_PROFILE.clientVersion],
    ["boot_build", CLIENT_COMPATIBILITY_PROFILE.clientBuild],
    ["boot_codename", CLIENT_COMPATIBILITY_PROFILE.projectCodename],
    ["boot_region", CLIENT_COMPATIBILITY_PROFILE.projectRegion],
  ];
}

function buildGlobalConfigDict(runtimeConfig = getRuntimeConfig()) {
  return {
    type: "dict",
    entries: buildGlobalConfigEntries(runtimeConfig),
  };
}

function buildServerStatusMessage() {
  // A client can only call this service after the MachoNet runtime is accepting
  // connections. Startup, shutdown, capacity, and queue labels are therefore
  // runtime state, not editable configuration.
  return [DEFAULT_SERVER_STATUS_LABEL, {}];
}

function getClusterUserCount() {
  const sessions = typeof sessionRegistry.getSessions === "function"
    ? sessionRegistry.getSessions()
    : [];
  return Math.max(1, Array.isArray(sessions) ? sessions.length : 0);
}

function buildServerStatusDict() {
  return {
    type: "dict",
    entries: [
      ...buildClientBootMetadataEntries(),
      ["update_info", CLIENT_COMPATIBILITY_PROFILE.projectVersion],
      ["cluster_usercount", getClusterUserCount()],
      ["user_logonqueueposition", 1],
      ["macho_version", CLIENT_COMPATIBILITY_PROFILE.machoVersion],
      ["status", "OK"],
    ],
  };
}

function buildServerStatusResponse() {
  return [
    buildServerStatusMessage(),
    buildServerStatusDict(),
  ];
}

module.exports = {
  buildClientBootMetadataEntries,
  buildGlobalConfigDict,
  buildGlobalConfigEntries,
  buildServerStatusDict,
  buildServerStatusMessage,
  buildServerStatusResponse,
  getRuntimeConfig,
  getRuntimeGlobalConfigOverrides,
  getRuntimeGlobalConfigValue,
  normalizeCountryCode,
  resetRuntimeGlobalConfigForTests,
  setRuntimeGlobalConfigValue,
};
