"use strict";

const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const express = require(path.join(repoRoot, "server", "node_modules", "express"));
const config = require(path.join(repoRoot, "server/src/config"));
if (typeof config.initializeConfigFiles === "function") {
  config.initializeConfigFiles();
}
const {
  getEditorSnapshot,
  getStoreConfig,
  resetStoreCaches,
  saveEditorAuthority,
} = require(path.join(
  repoRoot,
  "server/src/services/newEdenStore/storeState",
));

const app = express();
const publicDir = path.join(__dirname, "public");

function getStoreConfigDefinitions() {
  return config
    .getConfigDefinitions()
    .filter((entry) => String(entry && entry.key || "").startsWith("newEdenStore"));
}

function getConfigFileDisplayName(entry) {
  const fileName = String(entry && entry.configFile || "").trim();
  return fileName && !path.extname(fileName) ? `${fileName}.json` : fileName || null;
}

function buildStoreConfigPayload() {
  const snapshot = config.getConfigStateSnapshot();
  const definitions = getStoreConfigDefinitions();
  const persistedConfig = snapshot.persistedConfig || snapshot.fileConfig || {};

  return {
    generatedAt: new Date().toISOString(),
    version: snapshot.version || null,
    paths: {
      configDir: (snapshot.paths || {}).configDir || snapshot.configDir || null,
      files: (snapshot.paths || {}).files || snapshot.configFilePaths || {},
      versionConfigPath:
        (snapshot.paths || {}).versionConfigPath ||
        snapshot.versionConfigPath ||
        null,
    },
    entries: definitions.map((entry) => ({
      key: entry.key,
      label: entry.key,
      valueType: entry.valueType,
      defaultValue: snapshot.defaults[entry.key],
      validValues: entry.validValues,
      allowedValues: entry.allowedValues,
      minValue: entry.minValue,
      maxValue: entry.maxValue,
      configFile: getConfigFileDisplayName(entry),
      configPath: entry.configPath || entry.key,
      description: Array.isArray(entry.description)
        ? entry.description
        : [entry.description],
      fileValue: persistedConfig[entry.key],
      currentValue: snapshot.resolvedConfig[entry.key],
      source: snapshot.sources[entry.key],
      envVar: entry.envVar || null,
    })),
  };
}

function sanitizeStoreConfigInput(rawValues = {}) {
  const source = rawValues && typeof rawValues === "object" ? rawValues : {};
  const storeKeys = new Set(getStoreConfigDefinitions().map((entry) => entry.key));
  const unknownKeys = Object.keys(source).filter((key) => !storeKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported store config keys: ${unknownKeys.sort().join(", ")}.`);
  }
  return { ...source };
}

function buildBootstrapPayload() {
  const storeSnapshot = getEditorSnapshot();
  return {
    generatedAt: new Date().toISOString(),
    effectiveStoreConfig: getStoreConfig(),
    config: buildStoreConfigPayload(),
    store: storeSnapshot,
    summary: {
      legacyStores: Object.keys((storeSnapshot.authority && storeSnapshot.authority.stores) || {}).length,
      publicOffers: Object.keys((storeSnapshot.authority && storeSnapshot.authority.publicOffers) || {}).length,
      fastCheckoutOffers:
        (((storeSnapshot.authority || {}).fastCheckout || {}).offers || []).length,
      quickPayTokens: Object.keys(
        ((((storeSnapshot.authority || {}).fastCheckout || {}).tokensByID) || {}),
      ).length,
      runtimeAccounts: Object.keys((storeSnapshot.runtime && storeSnapshot.runtime.accounts) || {}).length,
      completedPurchases: Object.keys(
        (storeSnapshot.runtime && storeSnapshot.runtime.completedPurchases) || {},
      ).length,
    },
  };
}

app.use(express.json({ limit: "8mb" }));
app.use(express.static(publicDir));

app.get("/api/bootstrap", (_req, res) => {
  res.json(buildBootstrapPayload());
});

app.post("/api/store", (req, res) => {
  try {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const authority = payload.authority;
    const runtime = payload.runtime;
    const result = saveEditorAuthority(authority, runtime ? { runtime } : {});
    res.json({
      ok: true,
      store: result,
      effectiveStoreConfig: getStoreConfig(),
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/config", (req, res) => {
  try {
    const values = sanitizeStoreConfigInput(
      req.body && typeof req.body === "object" ? req.body.values : {},
    );
    const save =
      typeof config.saveConfig === "function"
        ? config.saveConfig
        : config.saveLocalConfig;
    if (typeof save !== "function") {
      throw new Error("This EvEJS build does not expose a writable config API.");
    }
    const snapshot = save.call(config, values);
    resetStoreCaches();
    const persistedConfig = snapshot.persistedConfig || snapshot.fileConfig || {};
    res.json({
      ok: true,
      config: {
        generatedAt: new Date().toISOString(),
        entries: getStoreConfigDefinitions()
          .map((entry) => ({
            key: entry.key,
            valueType: entry.valueType,
            allowedValues: entry.allowedValues,
            minValue: entry.minValue,
            maxValue: entry.maxValue,
            configFile: getConfigFileDisplayName(entry),
            configPath: entry.configPath || entry.key,
            fileValue: persistedConfig[entry.key],
            currentValue: snapshot.resolvedConfig[entry.key],
            source: snapshot.sources[entry.key],
          })),
      },
      effectiveStoreConfig: getStoreConfig(),
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = Number(process.env.EVEJS_NEW_EDEN_STORE_EDITOR_PORT || 26008) || 26008;
app.listen(port, () => {
  console.log(
    `[NewEdenStoreEditor] listening on http://127.0.0.1:${port}`,
  );
});
