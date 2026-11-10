"use strict";

// Client contract: moonmining.py:541-582, 703-750, 1195-1217 and
// playerOwned.py:91-115, 173-191. Shield admission is not sentry aggression.
const crypto = require("node:crypto");
const shipPasswords = new WeakMap();
const DEPLOY_KEYS = ["anchor", "unanchor", "online", "offline"];
const USAGE_KEYS = ["viewput", "viewputtake", "use"];
// appConst.py:361,366; Equipment Config and Junior Accountant are different roles.
const CONFIG_ROLE = 9007199254740992n;
const CARETAKER_ROLE = 288230376151711744n;
const inventory = () => require("../inventory/itemStore");
const authorityRuntime = () => require("../corporation/corporationAuthority");
const corpState = () => require("../corporation/corporationState");
const positiveID = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const failure = (errorMsg) => ({ success: false, errorMsg });
const success = (data) => ({ success: true, data });
const bool = (value, fallback = false) => value === undefined ? fallback : value === true || value === 1;
const validPermission = (value, maximum = 3) => Number.isInteger(value) && value >= 0 && value <= maximum;
// A structure without a saved access row uses retail's defaults. View (query
// and deposit) is open to Starbase Fuel Technicians (3), while take and use
// need Config Starbase Equipment (0). EVE University's POS Structures guide
// has owners change "query" from Starbase Fuel Technician and "take" from
// Config Starbase Equipment before corporation members can use an array.
const DEFAULT_USAGE_FLAGS = Object.freeze({ viewput: 3, viewputtake: 0, use: 0 });

function normalizeStarbaseAccessState(raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  const sentry = raw.sentry || {};
  const threshold = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Math.max(-10, Math.min(10, Number(value))) : null;
  return {
    version: 1,
    allowCorp: bool(raw.allowCorp, true),
    allowAlliance: bool(raw.allowAlliance, true),
    passwordSalt: /^[a-f0-9]{32}$/.test(raw.passwordSalt) ? raw.passwordSalt : null,
    passwordHash: /^[a-f0-9]{64}$/.test(raw.passwordHash) ? raw.passwordHash : null,
    sentry: {
      standing: threshold(sentry.standing), securityStatus: threshold(sentry.securityStatus),
      statusDrop: bool(sentry.statusDrop), war: bool(sentry.war),
      useAllianceStandings: bool(sentry.useAllianceStandings),
    },
    notifications: {
      showInCalendar: bool(raw.notifications && raw.notifications.showInCalendar),
      sendFuelNotifications: bool(raw.notifications && raw.notifications.sendFuelNotifications),
    },
    deployFlags: Object.fromEntries(DEPLOY_KEYS.map((key) => [key,
      validPermission(raw.deployFlags && raw.deployFlags[key], 2) ? raw.deployFlags[key] : 0])),
    usageFlags: (Array.isArray(raw.usageFlags) ? raw.usageFlags : [])
      .filter((row) => row && positiveID(row.structureID))
      .map((row) => ({ structureID: positiveID(row.structureID), ...Object.fromEntries(
        USAGE_KEYS.map((key) => [key, validPermission(row[key]) ? row[key] : 0]),
      ) })),
  };
}

function resolveTower(towerOrID) {
  const tower = typeof towerOrID === "object" ? towerOrID : inventory().findItemById(towerOrID);
  return tower && Number(tower.categoryID) === 23 && Number(tower.groupID) === 365 ? tower : null;
}

function getConfig(tower) {
  return normalizeStarbaseAccessState(tower && tower.spaceState && tower.spaceState.starbaseAccessState);
}

function getAuthority(session, options = {}) {
  return Object.prototype.hasOwnProperty.call(options, "authority")
    ? options.authority : authorityRuntime().getPersistedCorporationAuthority(session);
}

function getTowerConfiguration(session, towerID, options = {}) {
  const tower = resolveTower(towerID);
  if (!tower) return failure("CONTROL_TOWER_NOT_FOUND");
  const authority = getAuthority(session, options);
  if (!authority) return failure("STARBASE_PLAYER_CORPORATION_REQUIRED");
  if (Number(authority.corporationID) !== Number(tower.ownerID)) return failure("STARBASE_CORPORATION_OWNER_REQUIRED");
  // Management RPCs revalidate location on every read/write, not just the
  // inventory binding used to open moonmining.py's window. An explicit trusted
  // authority option is reserved for internal callers/tests, never RPC input.
  if (!Object.prototype.hasOwnProperty.call(options, "authority")) {
    const location = require("./starbaseInventoryRuntime").validateStarbaseInventoryAccess(
      session, tower, { allowOffline: true, allowTowerShieldRead: true },
    );
    if (!location.success) return location;
  }
  return success({ tower, config: getConfig(tower), authority });
}

function authorizeConfigurationWrite(session, towerID, options = {}) {
  const result = getTowerConfiguration(session, towerID, options);
  if (!result.success) return result;
  const { authority } = result.data;
  if (!authority.isCEO && !authority.isDirector && !authorityRuntime().corporationAuthorityHasRole(authority, CONFIG_ROLE)) {
    return failure("STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED");
  }
  return result;
}

function writeConfiguration(session, towerID, transform, options = {}) {
  const result = authorizeConfigurationWrite(session, towerID, options);
  if (!result.success) return result;
  const { tower, config } = result.data;
  const next = transform(config, tower);
  if (next && next.success === false) return next;
  return inventory().updateInventoryItem(tower.itemID, (current) => ({
    ...current, spaceState: { ...current.spaceState, starbaseAccessState: normalizeStarbaseAccessState(next) },
  }));
}

async function setTowerPassword(session, towerID, password, options = {}) {
  let credentials = null;
  if (password !== false) {
    // Check access, then the password, before hashing. The hash runs on the
    // thread pool; a synchronous one stopped the whole server for about 22 ms.
    const authorized = authorizeConfigurationWrite(session, towerID, options);
    if (!authorized.success) return authorized;
    if (typeof password !== "string" || password.length < 1 || password.length > 50) {
      return failure(password === "" ? "STARBASE_PASSWORD_REQUIRED" : "STARBASE_PASSWORD_INVALID");
    }
    const passwordSalt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await derivePasswordHash(passwordDigest(password), passwordSalt)).toString("hex");
    credentials = { passwordSalt, passwordHash };
  }
  // writeConfiguration checks access again, since the tower may have changed
  // while the hash ran.
  return writeConfiguration(session, towerID, (config) => {
    if (credentials) Object.assign(config, credentials);
    for (const key of ["allowCorp", "allowAlliance"]) {
      if (options[key] !== undefined) {
        if (![true, false, 0, 1].includes(options[key])) return failure("STARBASE_SETTINGS_INVALID");
        config[key] = bool(options[key]);
      }
    }
    return config;
  }, options);
}

function setTowerSentrySettings(session, towerID, settings, options = {}) {
  return writeConfiguration(session, towerID, (config, tower) => {
    for (const key of ["standing", "securityStatus"]) {
      if (settings[key] !== null && (!Number.isFinite(settings[key]) || Math.abs(settings[key]) > 10)) return failure("STARBASE_SETTINGS_INVALID");
    }
    if (settings.useAllianceStandings && !getTowerAllianceID(tower)) return failure("STARBASE_ALLIANCE_REQUIRED");
    return { ...config, sentry: settings };
  }, options);
}

function setTowerNotifications(session, towerID, settings, options = {}) {
  return writeConfiguration(session, towerID, (config) => {
    if (!settings || ["showInCalendar", "sendFuelNotifications"].some((key) => ![true, false, 0, 1].includes(settings[key]))) return failure("STARBASE_SETTINGS_INVALID");
    return { ...config, notifications: settings };
  }, options);
}

function getTowerAllianceID(tower) {
  const corporation = tower && corpState().getCorporationRecord(tower.ownerID);
  const allianceID = positiveID(corporation && !corporation.deleted && corporation.allianceID);
  const alliance = allianceID && corpState().getAllianceRecord(allianceID);
  return alliance && !alliance.deleted && corpState().getAllianceCorporationIDs(allianceID).includes(Number(tower.ownerID)) ? allianceID : 0;
}

function getForceFieldAccess(towerOrID) {
  const tower = resolveTower(towerOrID);
  if (!tower) return { harmonic: -1, corporationID: -1, allianceID: -1 };
  const config = getConfig(tower);
  return {
    harmonic: Number(tower.itemID),
    corporationID: config.allowCorp ? Number(tower.ownerID) : -1,
    allianceID: config.allowAlliance ? getTowerAllianceID(tower) || -1 : -1,
  };
}

function getStarbasePermissions(session, towerID, options = {}) {
  const result = getTowerConfiguration(session, towerID, options);
  if (!result.success) return result;
  const { tower, config } = result.data;
  const structures = [tower, ...require("./starbaseResourceRuntime").listTowerModules(tower)];
  return success({ deployFlags: config.deployFlags, usageFlags: structures.map((item) => (
    config.usageFlags.find((row) => row.structureID === Number(item.itemID)) ||
    { structureID: Number(item.itemID), ...DEFAULT_USAGE_FLAGS }
  )) });
}

function setStarbasePermissions(session, towerID, deployFlags, usageFlags, options = {}) {
  return writeConfiguration(session, towerID, (config, tower) => {
    if (!deployFlags || !Array.isArray(usageFlags) || DEPLOY_KEYS.some((key) => !validPermission(deployFlags[key], 2))) return failure("STARBASE_PERMISSION_INVALID");
    const ids = new Set([Number(tower.itemID), ...require("./starbaseResourceRuntime").listTowerModules(tower).map((item) => Number(item.itemID))]);
    const seen = new Set();
    for (const row of usageFlags) {
      if (!row || !ids.has(Number(row.structureID)) || seen.has(Number(row.structureID)) || USAGE_KEYS.some((key) => !validPermission(row[key]))) return failure("STARBASE_PERMISSION_INVALID");
      seen.add(Number(row.structureID));
    }
    return { ...config, deployFlags, usageFlags };
  }, options);
}

function passwordDigest(password) {
  return crypto.createHash("sha256").update(password, "utf8").digest("hex");
}

function activeShipID(session) {
  return positiveID(session && ((session._space && session._space.shipID) || session.shipID || session.shipid || session.activeShipID));
}

// scrypt costs about 22 ms per hash. It runs on the libuv thread pool here,
// because a synchronous hash stops every scene tick and every client request.
function derivePasswordHash(digest, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(digest, salt, 32, (error, hash) => (error ? reject(error) : resolve(hash)));
  });
}

// Resolves whether the ship password matches one tower's saved hash and caches
// the answer on the credential. Concurrent checks of one tower share one hash.
function primePasswordMatch(credential, config) {
  const cacheKey = `${config.passwordSalt}:${config.passwordHash}`;
  if (credential.matches.has(cacheKey)) return Promise.resolve(credential.matches.get(cacheKey));
  let pending = credential.pending.get(cacheKey);
  if (!pending) {
    pending = derivePasswordHash(credential.digest, config.passwordSalt)
      .then((hash) => {
        const matched = crypto.timingSafeEqual(hash, Buffer.from(config.passwordHash, "hex"));
        credential.matches.set(cacheKey, matched);
        return matched;
      })
      // A failed hash admits nobody. Nothing is cached, so the next check retries.
      .catch(() => false)
      .finally(() => credential.pending.delete(cacheKey));
    credential.pending.set(cacheKey, pending);
  }
  return pending;
}

function matchesPassword(session, config) {
  const credential = session && shipPasswords.get(session);
  if (!credential || credential.shipID !== activeShipID(session) || credential.characterID !== Number(session.characterID || session.charid) || !config.passwordHash || !config.passwordSalt) return false;
  const cacheKey = `${config.passwordSalt}:${config.passwordHash}`;
  if (credential.matches.has(cacheKey)) return credential.matches.get(cacheKey);
  // Force-field crossings and scoops ask synchronously. Never hash on those
  // paths: start the hash in the background and deny this one check. The next
  // crossing sees the cached answer.
  primePasswordMatch(credential, config);
  return false;
}

function canShipEnterForceField(towerOrID, shipOrSession, options = {}) {
  const tower = resolveTower(towerOrID);
  if (!tower || !tower.spaceState || tower.spaceState.onlineState !== "online" || Number(tower.spaceState.online) !== 1) return true;
  const config = getConfig(tower);
  let session = shipOrSession && (shipOrSession.session || shipOrSession._session ||
    (shipOrSession.characterID || shipOrSession.charid ? shipOrSession : null));
  if (!session && shipOrSession) {
    const storedShip = inventory().findItemById(shipOrSession.itemID || shipOrSession.id);
    if (storedShip && config.allowCorp && Number(storedShip.ownerID) === Number(tower.ownerID)) return true;
    const character = storedShip && require("../character/characterState").peekCharacterRecord(storedShip.ownerID);
    if (character) session = { characterID: storedShip.ownerID, corporationID: character.corporationID };
  }
  const authority = getAuthority(session, options);
  if (authority && config.allowCorp && Number(authority.corporationID) === Number(tower.ownerID)) return true;
  const allianceID = config.allowAlliance && getTowerAllianceID(tower);
  if (authority && allianceID && authorityRuntime().getAllianceMemberAuthority(session, allianceID)) return true;
  return matchesPassword(session, config);
}

async function setShipPassword(session, password) {
  if (!session || typeof password !== "string" || password.length < 1 || password.length > 50) return failure("STARBASE_PASSWORD_INVALID");
  const shipID = activeShipID(session);
  if (!shipID) return failure("SHIP_NOT_FOUND");
  const ship = inventory().findItemById(shipID);
  const systemID = positiveID(ship && ship.spaceState && ship.spaceState.systemID);
  const characterID = positiveID(session.characterID || session.charid);
  if (!ship || Number(ship.categoryID) !== 6 || Number(ship.ownerID) !== characterID || !systemID ||
      Number(session.stationID || session.stationid) > 0) return failure("SHIP_NOT_IN_SPACE");
  const credential = { shipID, characterID, digest: passwordDigest(password), matches: new Map(), pending: new Map() };
  shipPasswords.set(session, credential);
  // Read towers from the starbase index instead of copying every item in the
  // system, then hash one tower at a time until one matches.
  const towers = inventory().listStarbaseItems({ systemID, groupID: 365 }).filter((item) => (
    resolveTower(item) && Number(item.locationID) === systemID && Number(item.flagID) === 0 &&
    item.spaceState.onlineState === "online" && Number(item.spaceState.online) === 1
  ));
  let harmonic = -1;
  for (const tower of towers) {
    const config = getConfig(tower);
    if (!config.passwordHash || !config.passwordSalt) continue;
    if (await primePasswordMatch(credential, config)) {
      harmonic = Number(tower.itemID);
      break;
    }
  }
  // A newer password, or a different ship, set while hashing makes this answer stale.
  const superseded = shipPasswords.get(session) !== credential || activeShipID(session) !== shipID;
  return success({ shipID, harmonic, superseded });
}

// Shared permission authority for later hangar, maintenance and deployment adapters.
function hasStarbasePermission(session, towerOrID, structureID, operation, options = {}) {
  if (![...DEPLOY_KEYS, ...USAGE_KEYS].includes(operation)) return false;
  const tower = resolveTower(towerOrID);
  if (!tower) return false;
  const config = getConfig(tower);
  const authority = getAuthority(session, options);
  if (!authority) return false;
  const sameCorp = Number(authority.corporationID) === Number(tower.ownerID);
  const flag = DEPLOY_KEYS.includes(operation) ? config.deployFlags[operation] :
    (config.usageFlags.find((row) => row.structureID === Number(structureID)) || DEFAULT_USAGE_FLAGS)[operation];
  if (sameCorp && (authority.isCEO || authority.isDirector || authorityRuntime().corporationAuthorityHasRole(authority, CONFIG_ROLE))) return true;
  if (flag === 1) return sameCorp;
  if (flag === 2) return sameCorp || Boolean(getTowerAllianceID(tower) && authorityRuntime().getAllianceMemberAuthority(session, getTowerAllianceID(tower)));
  if (flag === 3) return sameCorp && authorityRuntime().corporationAuthorityHasRole(authority, CARETAKER_ROLE);
  return false;
}

module.exports = {
  normalizeStarbaseAccessState, getTowerConfiguration, setTowerPassword,
  setTowerSentrySettings, setTowerNotifications, getStarbasePermissions,
  setStarbasePermissions, getForceFieldAccess, getTowerAllianceID,
  canShipEnterForceField, setShipPassword, hasStarbasePermission,
  DEFAULT_USAGE_FLAGS,
};
