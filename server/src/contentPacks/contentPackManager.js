"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { cloneValue } = require(path.join(__dirname, "../common/clone"));
const storeRoot = require(path.join(__dirname, "../gameStore/storeRoot"));
const {
  readCoreDungeonAuthorityPayload,
} = require(path.join(__dirname, "../services/dungeon/dungeonAuthorityPayload"));
const packReadRun = require("./packReadRun");

const CONTENT_PACK_SCHEMA = "evejs.content-pack.v1";
const CONTENT_PACK_REGISTRY_SCHEMA = "evejs.content-pack-registry.v1";
const DUNGEON_CONTENT_API = 1;
const MAX_PACK_BYTES = 128 * 1024 * 1024;
const MAX_DUNGEON_TEMPLATES = 10_000;
const MUTATION_LOCK_STALE_MS = 5 * 60 * 1000;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_FAMILY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;
// Every capability a pack may declare. A pack that names a capability this
// engine does not list is refused at verify/install time instead of being
// installed and then silently misbehaving at runtime.
const SUPPORTED_CAPABILITIES = Object.freeze([
  "dungeon.templates.ore-anomaly",
  "dungeon.spawn-profile.ore",
  "dungeon.templates.combat-anomaly",
  "dungeon.spawn-profile.combat_anomaly",
  "dungeon.templates.ded-rated-site",
  "dungeon.spawn-profile.ded_rated",
  "dungeon.exact-client-gates",
  "dungeon.gate-type-list-restrictions",
  "dungeon.templates.drone-anomaly",
  "dungeon.spawn-profile.drone_anomaly",
  "dungeon.spawn-profile.faction-scope-anywhere",
  "dungeon.spawn-profile.region-site-count-multipliers",
  "dungeon.spawn-profile.site-tier-bands",
  "dungeon.spawn-profile.system-spawn-chance",
  "dungeon.spawn-profile.wormhole-faction-scope",
  "dungeon.templates.ghost-site",
  "dungeon.spawn-profile.ghost",
  "dungeon.exact-client-containers",
  "dungeon.exact-client-encounters",
  "dungeon.content-pack-template-selection",
  "dungeon.homefront.v1",
  "dungeon.templates.wormhole-site",
  "dungeon.spawn-profile.wormhole_anomaly",
  "dungeon.spawn-profile.wormhole_data",
  "dungeon.spawn-profile.wormhole_relic",
  "dungeon.spawn-profile.wormhole_ore",
  "dungeon.spawn-profile.wormhole-classes",
  "dungeon.spawn-profile.cross-pack-template-ids",
  "dungeon.encounter-trigger.container-hacked",
  "dungeon.templates.pirate-exploration",
  "dungeon.spawn-profile.pirate_relic",
  "dungeon.spawn-profile.pirate_data",
  "dungeon.templates.gas-site",
  "dungeon.spawn-profile.gas_nebula",
  "dungeon.spawn-profile.wormhole_gas",
  "dungeon.templates.booster-production",
  "dungeon.spawn-profile.booster_lab",
  "dungeon.spawn-profile.booster_facility",
  "dungeon.template-security-bands",
  // Mining mission sites. They carry no spawn profile: an agent hands the
  // mission out and the mission runtime resolves the site by its dungeon id,
  // so nothing seeds them into a system.
  "dungeon.templates.mining-mission",
  "dungeon.exact-client-mining-rocks",
  "dungeon.exact-client-environment-props",
  "dungeon.templates.air-tutorial",
]);

let runtimeContentPackSnapshot = null;
let validatorSha256 = null;

// Version/capabilities alone cannot identify an unchanged validator or preflight
// implementation. A release built under the same version must retry packs when
// those rules change too. These are source identities, not trusted pack receipts.
function contentPackCompatibility(options = {}) {
  if (validatorSha256 === null) {
    const hash = crypto.createHash("sha256");
    for (const file of [__filename, path.join(__dirname, "autoInstallContentPacks.js"),
      path.join(__dirname, "packReadRun.js"), path.join(__dirname, "dropFolderFingerprint.js"),
      require.resolve("../services/dungeon/dungeonAuthorityPayload")]) {
      hash.update(fs.readFileSync(file));
    }
    validatorSha256 = hash.digest("hex");
  }
  return { engineVersion: String(options.engineVersion || readEngineVersion()).trim(),
    contentApi: DUNGEON_CONTENT_API, capabilities: [...SUPPORTED_CAPABILITIES].sort(),
    validatorSha256 };
}

function contentPackError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

const clone = cloneValue;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeJsonValue(value, location = "$", depth = 0) {
  if (depth > 80) {
    throw contentPackError("CONTENT_PACK_JSON_TOO_DEEP", `JSON nesting exceeds 80 at ${location}`);
  }
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw contentPackError("CONTENT_PACK_NON_FINITE_NUMBER", `non-finite number at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertSafeJsonValue(value[index], `${location}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw contentPackError("CONTENT_PACK_NON_JSON_VALUE", `unsupported value at ${location}`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw contentPackError("CONTENT_PACK_UNSAFE_KEY", `unsafe key ${JSON.stringify(key)} at ${location}`);
    }
    assertSafeJsonValue(child, `${location}.${key}`, depth + 1);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const normalized = {};
  for (const key of Object.keys(value).sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ))) {
    normalized[key] = canonicalize(value[key]);
  }
  return normalized;
}

function canonicalJson(value) {
  assertSafeJsonValue(value);
  return JSON.stringify(canonicalize(value));
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// Releases up to 0.12.9 were numbered x.y.z. Since then a release is numbered
// by its build date, YYMMDD.n. The date line carries on from 0.12.9: it sorts
// after every 0.12.x and before 0.13.0, so packs written for 0.12
// (maxVersionExclusive "0.13.0") keep loading, and a pack can name a dated
// release as its minimum.
const DATE_RELEASE_LINE = [0, 12, Number.MAX_SAFE_INTEGER];

function normalizeVersionParts(value) {
  const text = String(value || "").trim();
  const dated = text.match(/^(\d{6})\.(\d+)$/);
  if (dated) {
    return [...DATE_RELEASE_LINE, Number(dated[1]), Number(dated[2])];
  }
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [...match.slice(1, 4).map((part) => Number(part)), 0, 0] : null;
}

function compareVersions(left, right) {
  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);
  if (!leftParts || !rightParts) {
    throw contentPackError(
      "CONTENT_PACK_VERSION_INVALID",
      `cannot compare ${JSON.stringify(left)} and ${JSON.stringify(right)}`,
    );
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function readEngineVersion() {
  const candidates = [
    path.resolve(__dirname, "../../..", "package.json"),
    path.resolve(__dirname, "../..", "package.json"),
  ];
  const packagePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!packagePath) {
    throw contentPackError(
      "CONTENT_PACK_ENGINE_VERSION_UNAVAILABLE",
      `could not find package.json in ${candidates.join(" or ")}`,
    );
  }
  return String(JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "").trim();
}

function normalizeManifest(pack) {
  return isPlainObject(pack && pack.manifest) ? pack.manifest : {};
}

function normalizeDungeonContribution(pack) {
  const payload = isPlainObject(pack && pack.payload) ? pack.payload : {};
  return isPlainObject(payload.dungeon) ? payload.dungeon : {};
}

function validateContentPack(pack, options = {}) {
  assertSafeJsonValue(pack);
  const errors = [];
  if (!isPlainObject(pack) || pack.schema !== CONTENT_PACK_SCHEMA) {
    errors.push(`schema must be ${CONTENT_PACK_SCHEMA}`);
  }

  const manifest = normalizeManifest(pack);
  const id = String(manifest.id || "").trim();
  const version = String(manifest.version || "").trim();
  if (!SAFE_ID_RE.test(id)) {
    errors.push("manifest.id is invalid");
  }
  if (!SAFE_VERSION_RE.test(version)) {
    errors.push("manifest.version must be semantic version x.y.z");
  }
  if (Number(manifest.contentApi) !== DUNGEON_CONTENT_API) {
    errors.push(`manifest.contentApi must be ${DUNGEON_CONTENT_API}`);
  }

  const engine = isPlainObject(manifest.engine) ? manifest.engine : {};
  const engineVersion = String(options.engineVersion || readEngineVersion()).trim();
  if (engine.minVersion && compareVersions(engineVersion, engine.minVersion) < 0) {
    errors.push(`requires eve.js >= ${engine.minVersion}; running ${engineVersion}`);
  }
  if (
    engine.maxVersionExclusive &&
    compareVersions(engineVersion, engine.maxVersionExclusive) >= 0
  ) {
    errors.push(`requires eve.js < ${engine.maxVersionExclusive}; running ${engineVersion}`);
  }

  const dungeon = normalizeDungeonContribution(pack);
  const templatesByID = isPlainObject(dungeon.templatesByID) ? dungeon.templatesByID : {};
  const spawnProfilesByFamily = isPlainObject(dungeon.spawnProfilesByFamily)
    ? dungeon.spawnProfilesByFamily
    : {};
  const templateEntries = Object.entries(templatesByID);
  if (templateEntries.length > MAX_DUNGEON_TEMPLATES) {
    errors.push(`contains more than ${MAX_DUNGEON_TEMPLATES} dungeon templates`);
  }
  for (const [templateID, template] of templateEntries) {
    if (!isPlainObject(template)) {
      errors.push(`${templateID} is not an object`);
      continue;
    }
    if (String(template.templateID || "").trim() !== templateID) {
      errors.push(`${templateID} does not match its templateID field`);
    }
  }
  for (const [family, profile] of Object.entries(spawnProfilesByFamily)) {
    const normalizedFamily = family.trim().toLowerCase();
    if (
      family !== normalizedFamily ||
      !SAFE_FAMILY_RE.test(normalizedFamily) ||
      !isPlainObject(profile)
    ) {
      errors.push(`spawn profile ${JSON.stringify(family)} is invalid`);
    }
  }

  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities)) {
      errors.push("manifest.capabilities must be an array of capability names");
    } else {
      for (const capability of manifest.capabilities) {
        if (typeof capability !== "string" || !SUPPORTED_CAPABILITIES.includes(capability)) {
          errors.push(`unsupported capability ${JSON.stringify(capability)}`);
        }
      }
    }
  }

  const counts = isPlainObject(manifest.counts) ? manifest.counts : {};
  if (Number(counts.dungeonTemplates) !== templateEntries.length) {
    errors.push("manifest dungeon template count does not match payload");
  }
  if (Number(counts.spawnProfiles) !== Object.keys(spawnProfilesByFamily).length) {
    errors.push("manifest spawn profile count does not match payload");
  }
  const expectedPayloadHash = String(manifest.payloadSha256 || "").trim().toLowerCase();
  const actualPayloadHash = sha256Canonical(pack && pack.payload || {});
  if (!/^[a-f0-9]{64}$/.test(expectedPayloadHash)) {
    errors.push("manifest.payloadSha256 is invalid");
  } else if (expectedPayloadHash !== actualPayloadHash) {
    errors.push("manifest.payloadSha256 does not match payload");
  }

  if (errors.length > 0) {
    throw contentPackError("CONTENT_PACK_INVALID", errors.join("; "), { errors });
  }
  return {
    id,
    version,
    engineVersion,
    payloadSha256: actualPayloadHash,
    packSha256: sha256Canonical(pack),
    dungeonTemplateCount: templateEntries.length,
    spawnProfileCount: Object.keys(spawnProfilesByFamily).length,
  };
}

// Validating a pack walks it for unsafe keys and hashes its canonical form
// twice, most of the cost of loading it. The answer depends only on the file's
// bytes and on the validating code (contentPackCompatibility), so it is kept in
// content-packs/validated.json under the bytes' SHA-256 and reused while both
// match. The file is a derived cache: deleting it only makes the next load
// validate every pack again.
const VALIDATION_RECEIPTS_SCHEMA = "evejs.content-pack-validation-receipts.v1";
const validationReceiptsByKey = new Map();

function validationReceiptsPath(options = {}) {
  return path.join(resolveContentPacksRoot(options), "validated.json");
}

function readValidationReceipts(options = {}) {
  const file = validationReceiptsPath(options);
  const compatibility = JSON.stringify(contentPackCompatibility(options));
  const key = `${file}\n${compatibility}`;
  if (validationReceiptsByKey.has(key)) {
    return validationReceiptsByKey.get(key);
  }
  let byDigest = {};
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      stored &&
      stored.schema === VALIDATION_RECEIPTS_SCHEMA &&
      stored.compatibility === compatibility &&
      isPlainObject(stored.byRawSha256)
    ) {
      byDigest = stored.byRawSha256;
    }
  } catch (_error) {
    // Missing or unreadable: every pack is validated afresh.
  }
  const receipts = { file, compatibility, byDigest };
  validationReceiptsByKey.set(key, receipts);
  return receipts;
}

function recordValidationReceipt(receipts, digest, validation) {
  receipts.byDigest[digest] = validation;
  try {
    writeJsonRecoverably(receipts.file, {
      schema: VALIDATION_RECEIPTS_SCHEMA,
      compatibility: receipts.compatibility,
      byRawSha256: receipts.byDigest,
    });
  } catch (_error) {
    // Best effort: without the receipt the pack is validated again next load.
  }
}

function readContentPackFile(filePath, options = {}, run = null) {
  const resolvedPath = path.resolve(filePath);
  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw contentPackError("CONTENT_PACK_NOT_FILE", `${resolvedPath} is not a file`);
  }
  if (stats.size > MAX_PACK_BYTES) {
    throw contentPackError(
      "CONTENT_PACK_TOO_LARGE",
      `${resolvedPath} exceeds ${MAX_PACK_BYTES} bytes`,
    );
  }
  let pack, raw, digest;
  try {
    raw = fs.readFileSync(resolvedPath);
    if (raw.length > MAX_PACK_BYTES) {
      throw contentPackError("CONTENT_PACK_TOO_LARGE", `${resolvedPath} exceeds ${MAX_PACK_BYTES} bytes`);
    }
    digest = crypto.createHash("sha256").update(raw).digest("hex");
    if (run) {
      run.stats.packReads += 1;
      run.stats.bytesRead += raw.length;
      const reused = run.loadedByDigest.get(digest);
      if (reused && reused.validation.engineVersion === String(options.engineVersion || readEngineVersion()).trim()) {
        run.stats.packsReused += 1;
        return { ...reused, filePath: resolvedPath, bytes: raw.length };
      }
    }
    pack = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (error.code === "CONTENT_PACK_TOO_LARGE") throw error;
    throw contentPackError("CONTENT_PACK_JSON_INVALID", error.message, { cause: error });
  }
  const receipts = readValidationReceipts(options);
  const receipt = receipts.byDigest[digest];
  const validation = isPlainObject(receipt) ? { ...receipt } : validateContentPack(pack, options);
  if (!isPlainObject(receipt)) {
    recordValidationReceipt(receipts, digest, validation);
  }
  const loaded = { pack, validation, filePath: resolvedPath, bytes: raw.length };
  if (run) {
    run.stats.packsParsed += 1;
    run.loadedByDigest.set(digest, loaded);
  }
  return loaded;
}

function resolveContentPacksRoot(options = {}) {
  if (options.contentPacksRoot) {
    return path.resolve(options.contentPacksRoot);
  }
  if (process.env.EVEJS_CONTENT_PACKS_DIR) {
    return path.resolve(process.env.EVEJS_CONTENT_PACKS_DIR);
  }
  if (process.env.EVEJS_GAMESTORE_DATA_DIR) {
    return storeRoot.resolveContentPacksDir();
  }
  // The game-store resolver intentionally falls back to checked-in source data
  // before a local database exists. Installable content must never share that
  // fallback or it can leak into source/Docker/release trees.
  return path.join(storeRoot.LOCAL_DATABASE_ROOT, "content-packs");
}

function registryPath(options = {}) {
  return path.join(resolveContentPacksRoot(options), "installed.json");
}

function packFilePath(id, version, options = {}) {
  if (!SAFE_ID_RE.test(String(id || "")) || !SAFE_VERSION_RE.test(String(version || ""))) {
    throw contentPackError("CONTENT_PACK_COORDINATE_INVALID", "unsafe pack ID or version");
  }
  return path.join(resolveContentPacksRoot(options), "packs", id, version, "pack.json");
}

function emptyRegistry() {
  return {
    schema: CONTENT_PACK_REGISTRY_SCHEMA,
    installed: [],
  };
}

function validateRegistry(registry) {
  if (!isPlainObject(registry) || registry.schema !== CONTENT_PACK_REGISTRY_SCHEMA) {
    throw contentPackError("CONTENT_PACK_REGISTRY_INVALID", "unsupported registry schema");
  }
  if (!Array.isArray(registry.installed)) {
    throw contentPackError("CONTENT_PACK_REGISTRY_INVALID", "installed must be an array");
  }
  const seen = new Set();
  for (const entry of registry.installed) {
    if (
      !isPlainObject(entry) ||
      !SAFE_ID_RE.test(String(entry.id || "")) ||
      !SAFE_VERSION_RE.test(String(entry.version || "")) ||
      !/^[a-f0-9]{64}$/.test(String(entry.packSha256 || ""))
    ) {
      throw contentPackError("CONTENT_PACK_REGISTRY_INVALID", "registry contains an invalid entry");
    }
    if (seen.has(entry.id)) {
      throw contentPackError("CONTENT_PACK_REGISTRY_INVALID", `duplicate active pack ${entry.id}`);
    }
    seen.add(entry.id);
  }
  return registry;
}

function readRegistry(options = {}) {
  const target = registryPath(options);
  const backup = `${target}.backup`;
  let selected = target;
  if (!fs.existsSync(selected) && fs.existsSync(backup)) {
    selected = backup;
  }
  if (!fs.existsSync(selected)) {
    return emptyRegistry();
  }
  try {
    return validateRegistry(JSON.parse(fs.readFileSync(selected, "utf8")));
  } catch (error) {
    if (error && error.code) {
      throw error;
    }
    throw contentPackError("CONTENT_PACK_REGISTRY_INVALID", error.message, { cause: error });
  }
}

function writeJsonRecoverably(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const backup = `${target}.backup`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  let movedOld = false;
  try {
    if (fs.existsSync(backup)) {
      fs.rmSync(backup, { force: true });
    }
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedOld = true;
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    if (!fs.existsSync(target) && movedOld && fs.existsSync(backup)) {
      fs.renameSync(backup, target);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  // The new target is committed. A stale backup is harmless and can be used as
  // recovery input if a later operation finds the target missing, so cleanup
  // must not turn a successful commit into a reported failure.
  try {
    if (fs.existsSync(backup)) {
      fs.rmSync(backup, { force: true });
    }
  } catch (_error) {
    // ignored: the target is already committed; removing the backup is cleanup
  }
}

function writeRegistry(registry, options = {}) {
  validateRegistry(registry);
  writeJsonRecoverably(registryPath(options), registry);
}

function readMutationLockOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const owner = JSON.parse(raw);
    return {
      raw,
      owner: isPlainObject(owner) ? owner : {},
      stats: fs.statSync(lockPath),
    };
  } catch (_error) {
    try {
      return { raw: null, owner: {}, stats: fs.statSync(lockPath) };
    } catch (_statError) {
      // ignored: the lock file is gone, so there is no owner to read (null)
      return null;
    }
  }
}

function isSameHostProcessAlive(owner) {
  if (
    String(owner && owner.hostname || "") !== os.hostname() ||
    !Number.isInteger(Number(owner && owner.pid)) ||
    Number(owner.pid) <= 0
  ) {
    return null;
  }
  try {
    process.kill(Number(owner.pid), 0);
    return true;
  } catch (error) {
    return error && error.code === "ESRCH" ? false : true;
  }
}

function isMutationLockStale(observed) {
  if (!observed) {
    return true;
  }
  const sameHostAlive = isSameHostProcessAlive(observed.owner);
  if (sameHostAlive !== null) {
    return !sameHostAlive;
  }
  return Date.now() - observed.stats.mtimeMs > MUTATION_LOCK_STALE_MS;
}

function removeObservedMutationLock(lockPath, observed) {
  try {
    const current = readMutationLockOwner(lockPath);
    if (!current) {
      return true;
    }
    const observedToken = String(observed && observed.owner && observed.owner.token || "");
    const currentToken = String(current.owner && current.owner.token || "");
    const sameObservation = observedToken
      ? observedToken === currentToken
      : observed && observed.raw === current.raw &&
        observed.stats.mtimeMs === current.stats.mtimeMs;
    if (!sameObservation) {
      return false;
    }
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch (_error) {
    // ignored: the caller then checks whether the lock is still there and reports the store as busy
    return false;
  }
}

function withContentPackMutationLock(options, operation) {
  const root = resolveContentPacksRoot(options);
  fs.mkdirSync(root, { recursive: true });
  const lockPath = path.join(root, ".mutation.lock");
  const lockToken = crypto.randomUUID();
  let lockHandle = null;
  for (let attempt = 0; attempt < 2 && lockHandle === null; attempt += 1) {
    try {
      lockHandle = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
      const observed = readMutationLockOwner(lockPath);
      if (attempt === 0 && isMutationLockStale(observed)) {
        try {
          if (removeObservedMutationLock(lockPath, observed)) {
            continue;
          }
        } catch (_removeError) {
          // ignored: report the store as busy below.
        }
        if (!fs.existsSync(lockPath)) {
          continue;
        }
      }
      throw contentPackError(
        "CONTENT_PACK_STORE_BUSY",
        `${root} is already being changed by another content-pack command`,
      );
    }
  }
  if (lockHandle === null) {
    throw contentPackError("CONTENT_PACK_STORE_BUSY", `${root} could not be locked`);
  }
  try {
    fs.writeFileSync(lockHandle, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      token: lockToken,
      createdAt: new Date().toISOString(),
    }));
    return operation();
  } finally {
    try {
      fs.closeSync(lockHandle);
    } finally {
      try {
        const current = readMutationLockOwner(lockPath);
        if (String(current && current.owner && current.owner.token || "") === lockToken) {
          fs.rmSync(lockPath, { force: true });
        }
      } catch (_error) {
        // ignored: a stale lock older than MUTATION_LOCK_STALE_MS is recovered safely.
      }
    }
  }
}

// A pack version is immutable: rollback --version 1.0.0 has to mean the same
// bytes on every install, so a second, different 1.0.0 is refused. Publishing a
// corrected build means publishing a higher version.
//
// options.replaceExistingVersion lifts that for the one case it cannot cover: an
// operator who has been handed a corrected build carrying the same version and
// cannot edit it. It overwrites the stored file, so a later rollback to that
// version yields the new bytes. Nothing sets it by default -- the CLI needs an
// explicit --replace and the updater an explicit confirmation -- and the result
// reports `replacedSha256` so the change is visible in a log.
// The newest version of a pack always wins. An install, and so the folder import
// the server runs at startup, never moves a pack back to an older version: if
// 1.0.3 was installed by hand and content-packs/ offers 1.0.2, 1.0.3 stays. Going
// back is a deliberate rollback (activateContentPack). The exception is a newer
// version whose stored copy has gone missing: keeping it would leave a registry
// the server refuses to start with, so the older version is installed instead.
function keepsNewerInstalledVersion(previous, version, options = {}) {
  return Boolean(previous) &&
    compareVersions(previous.version, version) > 0 &&
    fs.existsSync(packFilePath(previous.id, previous.version, options));
}

function installContentPack(filePath, options = {}, run = null) {
  const loaded = readContentPackFile(filePath, options, run);
  const { id, version, packSha256 } = loaded.validation;
  const allowReplace = options.replaceExistingVersion === true;
  return withContentPackMutationLock(options, () => {
    const destination = packFilePath(id, version, options);
    let replacedSha256 = null;
    if (fs.existsSync(destination)) {
      const existing = readContentPackFile(destination, options, run);
      if (existing.validation.packSha256 !== packSha256) {
        if (!allowReplace) {
          throw contentPackError(
            "CONTENT_PACK_VERSION_CONFLICT",
            `${id}@${version} is already stored with different content`,
          );
        }
        replacedSha256 = existing.validation.packSha256;
      }
    }

    const registry = readRegistry(options);
    const previous = registry.installed.find((entry) => entry.id === id) || null;
    if (keepsNewerInstalledVersion(previous, version, options)) {
      // Stored all the same, so a rollback to this version can find it.
      if (!fs.existsSync(destination) || replacedSha256 !== null) {
        writeJsonRecoverably(destination, loaded.pack);
      }
      return {
        changed: false,
        kept: true,
        previous,
        replacedSha256,
        active: { id: previous.id, version: previous.version, packSha256: previous.packSha256 },
        stored: { id, version, packSha256 },
        contentPacksRoot: resolveContentPacksRoot(options),
        preflight: null,
      };
    }
    if (
      previous &&
      previous.version === version &&
      previous.packSha256 !== packSha256 &&
      !allowReplace
    ) {
      throw contentPackError(
        "CONTENT_PACK_VERSION_CONFLICT",
        `${id}@${version} is already registered with different immutable content`,
      );
    }
    const proposedRegistry = registryWithActivePack(registry, { id, version, packSha256 });
    const preflight = preflightContentPackRegistry(
      proposedRegistry,
      options,
      new Map([[id, loaded]]),
      run,
    );
    // Written when the stored bytes differ, which outside a replace can only be
    // the first install of this version.
    if (!fs.existsSync(destination) || replacedSha256 !== null) {
      writeJsonRecoverably(destination, loaded.pack);
    }
    writeRegistry(proposedRegistry, options);
    return {
      changed: !previous || previous.version !== version || previous.packSha256 !== packSha256,
      previous,
      replacedSha256,
      active: { id, version, packSha256 },
      contentPacksRoot: resolveContentPacksRoot(options),
      preflight: preflight.summary,
    };
  });
}

// What an import would do to one pack, without doing it. Deliberately skips the
// collision preflight: this answers "is there work here?" for a setup check that
// runs on every pass, and the real install still refuses a colliding pack.
function describeIntendedImport(candidate, options = {}, run = null) {
  const allowReplace = options.replaceExistingVersion === true;
  const registry = readRegistry(options);
  const previous = registry.installed.find((entry) => entry.id === candidate.id) || null;
  const base = { ok: true, id: candidate.id, version: candidate.version };

  const destination = packFilePath(candidate.id, candidate.version, options);
  let storedDiffers = false;
  if (fs.existsSync(destination)) {
    try {
      storedDiffers = readContentPackFile(destination, options, run).validation.packSha256
        !== candidate.packSha256;
    } catch (_error) {
      storedDiffers = true;
    }
  }

  const conflict = storedDiffers || (previous && previous.version === candidate.version
    && previous.packSha256 !== candidate.packSha256);
  if (conflict && !allowReplace) {
    return {
      ok: false,
      action: "failed",
      code: "CONTENT_PACK_VERSION_CONFLICT",
      message: `${candidate.id}@${candidate.version} is already installed with different content`,
    };
  }
  if (keepsNewerInstalledVersion(previous, candidate.version, options)) {
    return { ...base, action: "kept", installedVersion: previous.version };
  }
  if (conflict) return { ...base, action: "replaced" };
  if (!previous) return { ...base, action: "installed" };
  if (previous.version !== candidate.version) {
    return { ...base, action: "updated", previousVersion: previous.version };
  }
  return { ...base, action: "unchanged" };
}

// Installs every pack file in a directory, so first-time setup and the updater
// can act on "here is a folder of packs" without either of them knowing how a
// pack is installed. Idempotent: a pack already installed reports "unchanged"
// and is not rewritten. A file older than the installed version reports "kept":
// the newer version stays (see keepsNewerInstalledVersion). options.dryRun
// reports what would happen and writes nothing, which is what a re-runnable
// setup check needs.
function importContentPackDirectory(directory, options = {}) {
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { directory: resolved, results: [], failed: 0, changed: 0 };
  }
  const files = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const results = [];
  const run = packReadRun.openPackRun();

  // Identify everything before installing anything. A drop folder accumulates
  // versions -- the operator saves the new pack beside the old one -- and
  // installing in filename order means string sort decides which version wins,
  // so 1.9.0 would land after 1.10.0 and quietly downgrade the pack. Only the
  // highest version of each id is installed; the rest are reported as skipped
  // rather than silently ignored.
  const candidates = [];
  for (const name of files) {
    const filePath = path.join(resolved, name);
    try {
      const loaded = readContentPackFile(filePath, options, run);
      candidates.push({
        name,
        filePath,
        id: loaded.validation.id,
        version: loaded.validation.version,
        packSha256: loaded.validation.packSha256,
      });
    } catch (error) {
      results.push({
        file: name,
        ok: false,
        action: "failed",
        code: (error && error.code) || "CONTENT_PACK_ERROR",
        message: (error && error.message) || String(error),
      });
    }
  }

  const newestById = new Map();
  for (const candidate of candidates) {
    const current = newestById.get(candidate.id);
    if (!current || compareVersions(candidate.version, current.version) > 0) {
      newestById.set(candidate.id, candidate);
    }
  }

  for (const candidate of candidates) {
    const chosen = newestById.get(candidate.id);
    if (chosen.name !== candidate.name) {
      results.push({
        file: candidate.name,
        ok: true,
        action: "skipped",
        id: candidate.id,
        version: candidate.version,
        newerVersion: chosen.version,
      });
      continue;
    }
    if (options.dryRun === true) {
      results.push({ file: candidate.name, ...describeIntendedImport(candidate, options, run) });
      continue;
    }
    try {
      const outcome = installContentPack(candidate.filePath, options, run);
      if (outcome.kept) {
        results.push({
          file: candidate.name,
          ok: true,
          action: "kept",
          id: candidate.id,
          version: candidate.version,
          installedVersion: outcome.active.version,
        });
        continue;
      }
      let action = "unchanged";
      if (outcome.replacedSha256) action = "replaced";
      else if (outcome.changed && outcome.previous) action = "updated";
      else if (outcome.changed) action = "installed";
      results.push({
        file: candidate.name,
        ok: true,
        action,
        id: outcome.active.id,
        version: outcome.active.version,
        previousVersion: outcome.previous ? outcome.previous.version : null,
      });
    } catch (error) {
      results.push({
        file: candidate.name,
        ok: false,
        action: "failed",
        code: (error && error.code) || "CONTENT_PACK_ERROR",
        message: (error && error.message) || String(error),
      });
    }
  }

  results.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  return {
    directory: resolved,
    stats: { ...run.stats },
    results,
    failed: results.filter((entry) => !entry.ok).length,
    changed: results.filter(
      (entry) => entry.ok && !["unchanged", "skipped", "kept"].includes(entry.action),
    ).length,
  };
}

function activateContentPack(id, version, options = {}) {
  return withContentPackMutationLock(options, () => {
    const loaded = readContentPackFile(packFilePath(id, version, options), options);
    if (loaded.validation.id !== id || loaded.validation.version !== version) {
      throw contentPackError("CONTENT_PACK_COORDINATE_MISMATCH", `${id}@${version} file is mismatched`);
    }
    const registry = readRegistry(options);
    const previous = registry.installed.find((entry) => entry.id === id) || null;
    const active = { id, version, packSha256: loaded.validation.packSha256 };
    const proposedRegistry = registryWithActivePack(registry, active);
    const preflight = preflightContentPackRegistry(
      proposedRegistry,
      options,
      new Map([[id, loaded]]),
    );
    writeRegistry(proposedRegistry, options);
    return { previous, active, preflight: preflight.summary };
  });
}

function removeContentPack(id, options = {}) {
  const normalizedID = String(id || "").trim();
  if (!SAFE_ID_RE.test(normalizedID)) {
    throw contentPackError("CONTENT_PACK_ID_INVALID", "a valid pack ID is required");
  }
  return withContentPackMutationLock(options, () => {
    const registry = readRegistry(options);
    const previous = registry.installed.find((entry) => entry.id === normalizedID) || null;
    if (!previous) {
      return { changed: false, previous: null };
    }
    registry.installed = registry.installed.filter((entry) => entry.id !== normalizedID);
    writeRegistry(registry, options);
    return { changed: true, previous };
  });
}

function listStoredVersions(id, options = {}) {
  if (!SAFE_ID_RE.test(String(id || ""))) {
    return [];
  }
  const packRoot = path.join(resolveContentPacksRoot(options), "packs", id);
  if (!fs.existsSync(packRoot)) {
    return [];
  }
  return fs.readdirSync(packRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_VERSION_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);
}

function registryWithActivePack(registry, active) {
  return {
    schema: CONTENT_PACK_REGISTRY_SCHEMA,
    installed: registry.installed
      .filter((entry) => entry.id !== active.id)
      .concat([active])
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function loadContentPacksForRegistry(registry, options = {}, overridesByID = new Map(), run = null) {
  validateRegistry(registry);
  return [...registry.installed]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => {
      const loaded = overridesByID.get(entry.id) ||
        readContentPackFile(packFilePath(entry.id, entry.version, options), options, run);
      if (
        loaded.validation.id !== entry.id ||
        loaded.validation.version !== entry.version ||
        loaded.validation.packSha256 !== entry.packSha256
      ) {
        throw contentPackError(
          "CONTENT_PACK_REGISTRY_MISMATCH",
          `${entry.id}@${entry.version} does not match installed.json`,
        );
      }
      return loaded;
    });
}

function loadInstalledContentPacks(options = {}) {
  return loadContentPacksForRegistry(readRegistry(options), options);
}

function preflightContentPackRegistry(registry, options = {}, overridesByID = new Map(), run = null) {
  // Read and registry-match current stored bytes before consulting the merge
  // cache. A different command may have changed the store between install locks.
  const loaded = loadContentPacksForRegistry(registry, options, overridesByID, run);
  const key = run ? packReadRun.registryKey(registry) : null;
  if (run && run.preflightByRegistry.has(key)) {
    run.stats.preflightsReused += 1;
    return { ...run.preflightByRegistry.get(key), loaded };
  }
  const base = run
    ? packReadRun.memoBasePayload(run, () => readCoreDungeonAuthorityPayload(options))
    : readCoreDungeonAuthorityPayload(options);
  const effective = applyDungeonContentPacks(base, loaded);
  const result = {
    loaded,
    summary: {
      activePackCount: loaded.length,
      dungeonTemplateCount: Object.keys(effective.templatesByID || {}).length,
      spawnProfileCount: Object.keys(
        effective.spawnProfiles && effective.spawnProfiles.families || {},
      ).length,
    },
  };
  if (run) {
    run.stats.preflightMerges += 1;
    // The imported objects stay in loadedByDigest; retain only the small merge
    // summary here rather than every registry's growing array of loaded packs.
    run.preflightByRegistry.set(key, { summary: result.summary });
  }
  return result;
}

function doctorContentPacks(options = {}) {
  return preflightContentPackRegistry(readRegistry(options), options);
}

function initializeContentPacks(options = {}) {
  if (runtimeContentPackSnapshot === null) {
    runtimeContentPackSnapshot = Object.freeze(loadInstalledContentPacks(options));
  }
  return runtimeContentPackSnapshot;
}

function clearContentPackSnapshotForTests() {
  runtimeContentPackSnapshot = null;
  validationReceiptsByKey.clear();
}

function getContentPackStatus(options = {}) {
  const registry = readRegistry(options);
  return {
    contentPacksRoot: resolveContentPacksRoot(options),
    installed: registry.installed.map((entry) => ({
      ...entry,
      storedVersions: listStoredVersions(entry.id, options),
    })),
  };
}

function isOreAnomalyTemplate(template) {
  return String(template && template.siteFamily || "").trim().toLowerCase() === "ore" &&
    String(template && template.siteKind || "").trim().toLowerCase() === "anomaly";
}

// Ownership the base authority recorded when content was extracted into a
// pack (meta.extractedContentPacks). Whatever is listed there belongs to a pack
// and is never served from the base, whether or not the pack is installed.
function listExtractedContentOwnership(payload) {
  const entries = payload && payload.meta && Array.isArray(payload.meta.extractedContentPacks)
    ? payload.meta.extractedContentPacks
    : [];
  const ownership = {
    packs: [],
    templateIDs: new Set(),
    sourceDungeonIDs: new Set(),
    spawnFamilies: new Set(),
  };
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      continue;
    }
    ownership.packs.push({
      id: String(entry.id || ""),
      version: String(entry.version || ""),
      templateCount: Number(entry.templateCount) || 0,
    });
    for (const templateID of Array.isArray(entry.templateIDs) ? entry.templateIDs : []) {
      ownership.templateIDs.add(String(templateID));
    }
    for (const sourceDungeonID of Array.isArray(entry.sourceDungeonIDs) ? entry.sourceDungeonIDs : []) {
      const numeric = Number(sourceDungeonID);
      if (Number.isFinite(numeric) && numeric > 0) {
        ownership.sourceDungeonIDs.add(Math.trunc(numeric));
      }
    }
    for (const family of Array.isArray(entry.spawnFamilies) ? entry.spawnFamilies : []) {
      const normalizedFamily = String(family || "").trim().toLowerCase();
      if (normalizedFamily) {
        ownership.spawnFamilies.add(normalizedFamily);
      }
    }
  }
  return ownership;
}

function stripExtractedBundledDungeonContent(payload) {
  const normalized = clone(payload && typeof payload === "object" ? payload : {});
  const ownership = listExtractedContentOwnership(normalized);
  normalized.templatesByID = Object.fromEntries(
    Object.entries(normalized.templatesByID || {})
      .filter(([templateID, template]) => {
        if (isOreAnomalyTemplate(template)) {
          // Legacy rule for base copies that predate recorded ownership.
          return false;
        }
        if (ownership.templateIDs.has(templateID)) {
          return false;
        }
        const numericSourceDungeonID = Number(template && template.sourceDungeonID);
        return !(
          Number.isFinite(numericSourceDungeonID) &&
          ownership.sourceDungeonIDs.has(Math.trunc(numericSourceDungeonID))
        );
      }),
  );
  if (
    normalized.spawnProfiles &&
    normalized.spawnProfiles.families &&
    typeof normalized.spawnProfiles.families === "object"
  ) {
    delete normalized.spawnProfiles.families.ore;
    for (const family of Object.keys(normalized.spawnProfiles.families)) {
      if (ownership.spawnFamilies.has(String(family).trim().toLowerCase())) {
        delete normalized.spawnProfiles.families[family];
      }
    }
  }
  return normalized;
}

function rebuildDungeonDerivedFields(payload) {
  return rebuildDungeonDerivedFieldsInPlace(
    clone(payload && typeof payload === "object" ? payload : {}),
  );
}

// The same rebuild on a payload the caller already owns. applyDungeonContentPacks
// builds a private deep copy of its base, so copying it again here doubled the
// cost of merging the packs for nothing.
function rebuildDungeonDerivedFieldsInPlace(normalized) {
  const templatesByID = normalized.templatesByID || {};
  const indexes = {
    templateIDsByFamily: {},
    templateIDsBySource: {},
    templateIDsByArchetypeID: {},
    templateIDsBySourceDungeonID: {},
  };
  const append = (target, key, templateID) => {
    if (key === "" || key === null || key === undefined) {
      return;
    }
    const normalizedKey = String(key);
    if (!target[normalizedKey]) {
      target[normalizedKey] = [];
    }
    target[normalizedKey].push(templateID);
  };
  for (const [templateID, template] of Object.entries(templatesByID)) {
    append(indexes.templateIDsByFamily, String(template && template.siteFamily || "unknown"), templateID);
    append(indexes.templateIDsBySource, String(template && template.source || "unknown"), templateID);
    const archetypeID = Number(template && template.archetypeID);
    if (Number.isFinite(archetypeID) && archetypeID > 0) {
      append(indexes.templateIDsByArchetypeID, Math.trunc(archetypeID), templateID);
    }
    const sourceDungeonID = Number(template && template.sourceDungeonID);
    if (Number.isFinite(sourceDungeonID) && sourceDungeonID > 0) {
      indexes.templateIDsBySourceDungeonID[String(Math.trunc(sourceDungeonID))] = templateID;
    }
  }
  for (const index of [
    indexes.templateIDsByFamily,
    indexes.templateIDsBySource,
    indexes.templateIDsByArchetypeID,
  ]) {
    for (const values of Object.values(index)) {
      values.sort((left, right) => left.localeCompare(right));
    }
  }
  normalized.indexes = indexes;
  normalized.counts = {
    ...(normalized.counts || {}),
    templateCount: Object.keys(templatesByID).length,
    sceneProfileCount: Object.values(templatesByID)
      .filter((template) => template && template.siteSceneProfile).length,
    resolvedClientTemplateNameCount: Object.values(templatesByID)
      .filter((template) => template && template.source === "client" && template.resolvedName).length,
    eveUniversitySiteFamilyCount: Object.values(templatesByID)
      .filter((template) => template && template.source === "eve-university").length,
    universeSpawnFamilyCount: Object.keys(
      normalized.spawnProfiles && normalized.spawnProfiles.families || {},
    ).length,
  };
  return normalized;
}

function applyDungeonContentPacks(basePayload, loadedPacks) {
  const payload = stripExtractedBundledDungeonContent(basePayload);
  payload.templatesByID = payload.templatesByID || {};
  // Retire the metadata-only Homefront rows when their playable pack is
  // installed. Other pack/template collisions retain the normal hard error.
  const homefront = (loadedPacks || [])
    .map((entry) => entry.pack || entry)
    .find((pack) => pack.manifest?.id === "evejs.homefront");
  if (homefront) {
    for (const template of Object.values(
      homefront.payload?.dungeon?.templatesByID || {},
    )) {
      const legacyID = `client-dungeon:${template.sourceDungeonID}`;
      if (Number(payload.templatesByID[legacyID]?.archetypeID) === 70)
        delete payload.templatesByID[legacyID];
    }
  }
  const air = (loadedPacks || []).map(entry => entry.pack || entry)
    .find(pack => pack.manifest?.id === "evejs.air-tutorial");
  if (air) {
    for (const dungeonID of [9103, 9105, 10461, 9245]) {
      const replacement = air.payload?.dungeon?.templatesByID?.[`evejs.air-tutorial:${dungeonID}`];
      const legacyID = `client-dungeon:${dungeonID}`, legacy = payload.templatesByID[legacyID];
      // Retire only the derived placeholders. An installed exact asset overlay
      // or another pack remains a hard collision rather than being overwritten.
      if (replacement?.sourceDungeonID === dungeonID && replacement.siteFamily === "air_tutorial" && legacy?.source === "client" && legacy.populationHints?.source === "family_derived" && !legacy.clientDungeonContent) delete payload.templatesByID[legacyID];
    }
  }
  payload.spawnProfiles = payload.spawnProfiles || {};
  payload.spawnProfiles.families = payload.spawnProfiles.families || {};
  const applied = [];
  const sourceDungeonOwners = new Map();
  for (const [templateID, template] of Object.entries(payload.templatesByID)) {
    const numericSourceDungeonID = Number(template && template.sourceDungeonID);
    const sourceDungeonID = Number.isFinite(numericSourceDungeonID)
      ? Math.trunc(numericSourceDungeonID)
      : 0;
    if (sourceDungeonID > 0 && !sourceDungeonOwners.has(sourceDungeonID)) {
      sourceDungeonOwners.set(sourceDungeonID, templateID);
    }
  }

  for (const loaded of Array.isArray(loadedPacks) ? loadedPacks : []) {
    const pack = loaded && loaded.pack ? loaded.pack : loaded;
    const validation = loaded && loaded.validation
      ? loaded.validation
      : validateContentPack(pack);
    const dungeon = normalizeDungeonContribution(pack);
    for (const [templateID, template] of Object.entries(dungeon.templatesByID || {})) {
      if (Object.prototype.hasOwnProperty.call(payload.templatesByID, templateID)) {
        throw contentPackError(
          "CONTENT_PACK_TEMPLATE_CONFLICT",
          `${validation.id}@${validation.version} collides with ${templateID}`,
        );
      }
      const numericSourceDungeonID = Number(template && template.sourceDungeonID);
      const sourceDungeonID = Number.isFinite(numericSourceDungeonID)
        ? Math.trunc(numericSourceDungeonID)
        : 0;
      if (sourceDungeonID > 0 && sourceDungeonOwners.has(sourceDungeonID)) {
        throw contentPackError(
          "CONTENT_PACK_SOURCE_DUNGEON_CONFLICT",
          `${validation.id}@${validation.version} template ${templateID} reuses source dungeon ` +
            `${sourceDungeonID} owned by ${sourceDungeonOwners.get(sourceDungeonID)}`,
        );
      }
      if (sourceDungeonID > 0) {
        sourceDungeonOwners.set(sourceDungeonID, templateID);
      }
      payload.templatesByID[templateID] = {
        ...clone(template),
        _contentPack: {
          id: validation.id,
          version: validation.version,
          packSha256: validation.packSha256,
          payloadSha256: validation.payloadSha256,
        },
      };
    }
    for (const [family, profile] of Object.entries(dungeon.spawnProfilesByFamily || {})) {
      const normalizedFamily = String(family || "").trim().toLowerCase();
      const existingFamily = Object.keys(payload.spawnProfiles.families)
        .find((candidate) => String(candidate).trim().toLowerCase() === normalizedFamily);
      if (existingFamily !== undefined) {
        throw contentPackError(
          "CONTENT_PACK_SPAWN_PROFILE_CONFLICT",
          `${validation.id}@${validation.version} collides with spawn profile ${normalizedFamily}`,
        );
      }
      payload.spawnProfiles.families[normalizedFamily] = clone(profile);
    }
    applied.push({
      id: validation.id,
      version: validation.version,
      packSha256: validation.packSha256,
      payloadSha256: validation.payloadSha256,
    });
  }

  payload.meta = {
    ...(payload.meta || {}),
    installedContentPacks: applied,
  };
  return rebuildDungeonDerivedFieldsInPlace(payload);
}

module.exports = {
  CONTENT_PACK_REGISTRY_SCHEMA,
  CONTENT_PACK_SCHEMA,
  DUNGEON_CONTENT_API,
  MAX_PACK_BYTES,
  SUPPORTED_CAPABILITIES,
  activateContentPack,
  applyDungeonContentPacks,
  canonicalJson,
  clearContentPackSnapshotForTests,
  compareVersions,
  contentPackCompatibility,
  doctorContentPacks,
  getContentPackStatus,
  importContentPackDirectory,
  installContentPack,
  initializeContentPacks,
  isOreAnomalyTemplate,
  listExtractedContentOwnership,
  listStoredVersions,
  loadInstalledContentPacks,
  preflightContentPackRegistry,
  readContentPackFile,
  readRegistry,
  rebuildDungeonDerivedFields,
  removeContentPack,
  resolveContentPacksRoot,
  sha256Canonical,
  stripExtractedBundledDungeonContent,
  validateContentPack,
};
