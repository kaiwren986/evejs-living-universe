"use strict";

const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");

function loadConfigApi() {
  // The bridge protocol is JSON-only. Server-side startup diagnostics must not
  // corrupt stdout or be mistaken for a bridge failure by the Python editor.
  const silent = () => {};
  console.log = silent;
  console.info = silent;
  console.warn = silent;
  console.error = silent;
  console.debug = silent;
  const configApi = require(path.join(repoRoot, "server", "src", "config"));
  if (typeof configApi.initializeConfigFiles === "function") {
    configApi.initializeConfigFiles();
  }
  return configApi;
}

function getStoreDefinitions(configApi) {
  return configApi
    .getConfigDefinitions()
    .filter((entry) => String(entry && entry.key || "").startsWith("newEdenStore"));
}

function getConfigFileDisplayName(entry) {
  const fileName = String(entry && entry.configFile || "").trim();
  return fileName && !path.extname(fileName) ? `${fileName}.json` : fileName || null;
}

function buildPayload(configApi, snapshot = configApi.getConfigStateSnapshot()) {
  const definitions = getStoreDefinitions(configApi);
  const snapshotPaths = snapshot.paths || {};
  const persistedConfig = snapshot.persistedConfig || snapshot.fileConfig || {};
  return {
    generatedAt: new Date().toISOString(),
    paths: {
      configDir: snapshotPaths.configDir || snapshot.configDir || null,
      files: snapshotPaths.files || snapshot.configFilePaths || {},
      versionConfigPath:
        snapshotPaths.versionConfigPath || snapshot.versionConfigPath || null,
    },
    version: snapshot.version || null,
    entries: definitions.map((entry) => ({
      key: entry.key,
      valueType: entry.valueType,
      defaultValue: snapshot.defaults[entry.key],
      fileValue: persistedConfig[entry.key],
      currentValue: snapshot.resolvedConfig[entry.key],
      source: snapshot.sources[entry.key],
      envVar: entry.envVar || null,
      allowedValues: entry.allowedValues,
      validValues: entry.validValues,
      minValue: entry.minValue,
      maxValue: entry.maxValue,
      configFile: getConfigFileDisplayName(entry),
      configPath: Array.isArray(entry.configPath)
        ? [...entry.configPath]
        : entry.configPath || entry.key,
      description: Array.isArray(entry.description)
        ? [...entry.description]
        : [entry.description],
    })),
  };
}

function saveValues(configApi, rawValues) {
  const values =
    rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)
      ? rawValues
      : {};
  const allowedKeys = new Set(getStoreDefinitions(configApi).map((entry) => entry.key));
  const unknownKeys = Object.keys(values).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported store config keys: ${unknownKeys.sort().join(", ")}.`);
  }
  const storeValues = { ...values };
  const save =
    typeof configApi.saveConfig === "function"
      ? configApi.saveConfig
      : configApi.saveLocalConfig;
  if (typeof save !== "function") {
    throw new Error("This EvEJS build does not expose a writable config API.");
  }
  return buildPayload(configApi, save.call(configApi, storeValues));
}

function readStdinPayload() {
  const text = fs.readFileSync(0, "utf8").trim();
  if (!text) {
    return {};
  }
  const payload = JSON.parse(text);
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
}

function main() {
  const command = process.argv[2] || "export";
  const configApi = loadConfigApi();
  let payload;
  if (command === "export") {
    payload = buildPayload(configApi);
  } else if (command === "save") {
    const input = readStdinPayload();
    payload = saveValues(configApi, input.values || input);
  } else {
    throw new Error(`Unknown config bridge command "${command}".`);
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[NewEdenStoreEditor] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildPayload,
  getStoreDefinitions,
  saveValues,
};
