"use strict";

const {
  toNumber,
} = require("../../common/numbers");

const path = require("path");
const { randomUUID } = require("crypto");
const reserveKeyAuthority = require("./essReserveKeyAuthority.json");

const {
  buildDict,
  buildFiletimeLong,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  TABLE,
  readStaticRows,
  clearReferenceCache,
} = require(path.join(__dirname, "../_shared/referenceData"));

const TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM = 55914;

const ESS_AUTOPAY_STATE_LONG = 0;
const ESS_AUTOPAY_STATE_MEDIUM = 1;
const ESS_AUTOPAY_STATE_SHORT = 2;

const ESS_RESERVE_WINDOW_STATE_INACTIVE = 0;
const ESS_RESERVE_WINDOW_STATE_EARLY = 1;
const ESS_RESERVE_WINDOW_STATE_BEST = 2;
const ESS_RESERVE_WINDOW_STATE_LATE = 3;

const UNLINKED_MANUAL = 0;
const UNLINKED_PROXIMITY = 1;
const UNLINKED_SHIP_CHANGE = 2;

const FILETIME_TICKS_PER_SECOND = 10_000_000n;

const ESS_KEY_TYPE_IDS = Object.freeze({
  NW_15: 57714,
  NW_45: 57715,
  NE_15: 57716,
  NE_45: 57719,
  SE_15: 57717,
  SE_45: 57718,
  SW_15: 57720,
  SW_45: 57721,
});

const ESS_RESERVE_KEY_TOTAL_PULSES = Object.freeze(Object.fromEntries(
  Object.entries(reserveKeyAuthority.keysByTypeID).map(([typeID, definition]) => [typeID, definition.totalPulses]),
));

const DEFAULT_DYNAMIC_RESOURCE_SETTINGS = Object.freeze({
  minOutput: 1.0,
  maxOutput: 2.0,
  equilibriumValue: 1.5,
  timeIntervalSeconds: 86400,
  bountiesCut: 0.4,
  mainBankPayRatio: 0.975,
  autopaymentIntervalSeconds: 9900,
  bufferTimeSeconds: 360,
  reservePulseIntervalSeconds: 60,
  reserveBankMaxPayout: 15_000_000, // Donor policy; client formulas.py defines the pulse curve.
  reserveBankTimeAccessFactor: 3,
  reserveWindowAccessFactor: 1.5,
  reservePayoutExponentLead: 2,
  reservePayoutExponentTail: 2,
  reservePayoutPaddingValue: 0,
  earlyPayoutThresholdFactor: 2 / 3,
  latePayoutThresholdFactor: 1 / 3,
});

const repository = require("./essRepository");
const { SCENE_KIND_SOLAR_SYSTEM } = require("../../space/runtime/sceneIdentity");
const { isPublicEssEntity, TYPE_ESS_ENTRY_BEACON } = require("../../space/encounterSurveillanceSystem");
let nowProvider = () => Date.now();
function now() { return nowProvider(); }
function filetimeNow() { return BigInt(Math.trunc(now())) * 10_000n + 116444736000000000n; }

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function toPositiveInt(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.round(numeric * 100) / 100);
}

function cloneSet(value) {
  return new Set(
    Array.isArray(value)
      ? value.map((entry) => toPositiveInt(entry, 0)).filter(Boolean)
      : value instanceof Set
        ? Array.from(value).map((entry) => toPositiveInt(entry, 0)).filter(Boolean)
        : [],
  );
}

function filetimeAfterSeconds(seconds) {
  return filetimeNow() + BigInt(Math.max(0, toInt(seconds, 0))) * FILETIME_TICKS_PER_SECOND;
}

function getSystemIDFromSession(session = null) {
  return toPositiveInt(
    session && (session.solarsystemid2 || session.solarsystemid),
    0,
  );
}

function getSystemIDFromArgsOrSession(args = [], session = null) {
  return toPositiveInt(
    args && args.length > 0 ? args[0] : getSystemIDFromSession(session),
    0,
  );
}

function getStaticSolarSystem(solarSystemID) {
  const numericSolarSystemID = toPositiveInt(solarSystemID, 0);
  if (!numericSolarSystemID) {
    return null;
  }
  return readStaticRows(TABLE.SOLAR_SYSTEMS).find(
    (system) => toPositiveInt(system && system.solarSystemID, 0) === numericSolarSystemID,
  ) || null;
}

function isKnownNullsecSystem(solarSystemID) {
  const system = getStaticSolarSystem(solarSystemID);
  return Boolean(
    system &&
    toPositiveInt(system.solarSystemID, 0) < 31000000 &&
    toNumber(system.security, 1) <= 0,
  );
}

function listReserveKeyTypeIDsForSystem(solarSystemID) {
  const system = getStaticSolarSystem(solarSystemID);
  const regionID = toPositiveInt(system && system.regionID, 0);
  return Object.entries(reserveKeyAuthority.keysByTypeID)
    .filter(([, definition]) => definition.regionIDs.includes(regionID))
    .sort((left, right) => left[1].totalPulses - right[1].totalPulses || Number(left[0]) - Number(right[0]))
    .map(([typeID]) => Number(typeID));
}

function getReserveKeyTotalPulses(typeID) {
  return ESS_RESERVE_KEY_TOTAL_PULSES[toPositiveInt(typeID, 0)] || 0;
}

function normalizeMainBankLink(link = null) {
  if (!link || typeof link !== "object") {
    return null;
  }
  const characterID = toPositiveInt(link.characterID, 0);
  if (!characterID) {
    return null;
  }
  return {
    ...link,
    linkID: String(link.linkID || randomUUID()),
    characterID,
    startedAt: link.startedAt || filetimeNow(),
    completesAt:
      link.completesAt ||
      filetimeAfterSeconds(DEFAULT_DYNAMIC_RESOURCE_SETTINGS.bufferTimeSeconds),
  };
}

function normalizeState(solarSystemID, source = {}) {
  const numericSolarSystemID = toPositiveInt(solarSystemID, 0);
  const essID = toPositiveInt(source.essID || source.essItemID, 0);
  return {
    ...source,
    solarSystemID: numericSolarSystemID,
    essID,
    beaconID: toPositiveInt(source.beaconID, essID || null),
    typeID: toPositiveInt(source.typeID, TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM),
    currentOutput: toNumber(
      source.currentOutput,
      DEFAULT_DYNAMIC_RESOURCE_SETTINGS.equilibriumValue,
    ),
    mainValue: normalizeMoney(source.mainValue, 0),
    reserveValue: normalizeMoney(source.reserveValue, 0),
    mainBankLink: normalizeMainBankLink(source.mainBankLink),
    reserveBankLastPulseInitiated: source.reserveBankLastPulseInitiated || null,
    reserveBankPulsesTotal: Math.max(0, toInt(source.reserveBankPulsesTotal, 0)),
    reserveBankPulsesRemaining: Math.max(
      0,
      toInt(source.reserveBankPulsesRemaining, 0),
    ),
    reserveLinkedCharacterIDs: cloneSet(source.reserveLinkedCharacterIDs),
    theftHistoryMain: Array.isArray(source.theftHistoryMain)
      ? [...source.theftHistoryMain]
      : [],
    theftHistoryReserve: Array.isArray(source.theftHistoryReserve)
      ? [...source.theftHistoryReserve]
      : [],
  };
}

function setSystemState(solarSystemID, source = {}) {
  const numericSolarSystemID = toPositiveInt(solarSystemID, 0);
  if (!numericSolarSystemID) {
    return null;
  }
  const normalized = normalizeState(numericSolarSystemID, source);
  saveSystemState(normalized);
  return normalized;
}

function saveSystemState(state) {
  const serial = JSON.parse(JSON.stringify({ ...state, reserveLinkedCharacterIDs: [...state.reserveLinkedCharacterIDs] }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  repository.mutate(root => { root.systems[String(state.solarSystemID)] = serial; });
}

function clearSystemState(solarSystemID) {
  repository.mutate(root => { delete root.systems[String(toPositiveInt(solarSystemID, 0))]; });
}

function getSystemState(solarSystemID) {
  const source = repository.read().systems[String(toPositiveInt(solarSystemID, 0))];
  return source ? normalizeState(solarSystemID, source) : null;
}

function ensureAuthoredEss(scene) {
  const systemID = toPositiveInt(scene?.systemID, 0);
  if (!scene || scene.sceneKind !== SCENE_KIND_SOLAR_SYSTEM || !isKnownNullsecSystem(systemID)) return getSystemState(systemID);
  const existing = getSystemState(systemID);
  const entities = (scene.staticEntities || []).filter(isPublicEssEntity);
  const entity = entities.find(item => Number(item.itemID) === existing?.essID) || entities[0];
  if (!entity) return existing;
  const companion = scene.getEntityByID?.(Number(entity.essEntryBeaconID || entity.beaconID));
  const retainedBeacon = scene.getEntityByID?.(Number(existing?.beaconID));
  const isPublicBeacon = item => item && Number(item.itemID) !== Number(entity.itemID) &&
    Number(item.typeID) === TYPE_ESS_ENTRY_BEACON &&
    !item.airNpeOwnerCharacterID && !item.airNpeInstanceID && item.staticVisibilityScope === "publicgrid";
  const beaconID = isPublicBeacon(companion) ? Number(companion.itemID) :
    Number(existing?.essID) === Number(entity.itemID) && isPublicBeacon(retainedBeacon)
      ? Number(retainedBeacon.itemID) : Number(entity.itemID);
  const result = Number(entity.itemID) === existing?.essID && beaconID === existing?.beaconID
    ? existing : setSystemState(systemID, { ...existing, essID: Number(entity.itemID), beaconID });
  require("./essPresentationRuntime").refreshScene(scene, result, { broadcast: true });
  return result;
}

function listSystemStates() {
  return Object.entries(repository.read().systems).map(([id, source]) => normalizeState(id, source))
    .filter((state) => state && toPositiveInt(state.solarSystemID, 0) > 0)
    .sort((left, right) => left.solarSystemID - right.solarSystemID);
}

function buildSettingsPayload() {
  return buildDict(Object.entries({ ...DEFAULT_DYNAMIC_RESOURCE_SETTINGS, ...require("./dynamicBountyPolicy").CONTROL_SETTINGS }));
}

// An unlinked bank is an empty dict, not null: dynamicResourceSvc.py:260 indexes
// the key and tests it, and controller.py:111 calls .get on the value.
function buildMainBankLinkPayload(link = null) {
  if (!link) {
    return buildDict([]);
  }
  return buildDict([
    ["linkID", link.linkID],
    ["characterID", link.characterID],
    ["startedAt", buildFiletimeLong(link.startedAt)],
    ["completesAt", buildFiletimeLong(link.completesAt)],
  ]);
}

function buildEssDataPayload(state = null) {
  if (!state || !toPositiveInt(state.essID, 0)) {
    return null;
  }
  // The client countdown and progress gauge use FILETIME integers. Derive the
  // cycle start from the persisted deadline so queries and restarts do not
  // restart the gauge, including for banks saved before these wire fields.
  const payoutAtMs = Number(state.autopayAtMs);
  const hasScheduledAutopayment = Number.isSafeInteger(payoutAtMs) && payoutAtMs > 0;
  // An idle bank uses a fixed, expired display window ending at the Unix
  // epoch. Equal timestamps divide by zero in the native gauge; a future
  // fallback would advertise a payout which the settlement owner never scheduled.
  const nextScheduledAutopayment =
    BigInt(hasScheduledAutopayment ? payoutAtMs : 0) * 10_000n + 116444736000000000n;
  const lastAutopayment = nextScheduledAutopayment -
    BigInt(DEFAULT_DYNAMIC_RESOURCE_SETTINGS.autopaymentIntervalSeconds) * FILETIME_TICKS_PER_SECOND;
  return buildDict([
    ["essID", state.essID],
    ["beaconID", state.beaconID || state.essID],
    ["typeID", state.typeID || TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM],
    ["solarSystemID", state.solarSystemID],
    ["currentOutput", state.dbs?.active ? require("./dynamicBountyRuntime").project(state).currentOutput : state.currentOutput],
    ["mainValue", state.mainValue],
    ["reserveValue", state.reserveValue],
    ["nextScheduledAutopayment", buildFiletimeLong(nextScheduledAutopayment)],
    ["lastAutopayment", buildFiletimeLong(lastAutopayment)],
    ["mainBankLink", buildMainBankLinkPayload(state.mainBankLink)],
    [
      "reserveBankLastPulseInitiated",
      state.reserveBankLastPulseInitiated
        ? buildFiletimeLong(state.reserveBankLastPulseInitiated)
        : null,
    ],
    ["reserveBankPulsesRemaining", state.reserveBankPulsesRemaining],
    ["reserveBankPulsesTotal", state.reserveBankPulsesTotal],
    ["reserveBankActiveLinks", state.reserveLinkedCharacterIDs.size],
  ]);
}

function buildAgencySystemPayload(state) {
  return buildDict([
    ["currentOutput", state.dbs?.active ? require("./dynamicBountyRuntime").project(state).currentOutput : state.currentOutput],
    ["mainValue", state.mainValue],
    ["reserveValue", state.reserveValue],
    ["vaultOpen", state.reserveBankPulsesRemaining > 0],
  ]);
}

function buildAgencyDataPayload() {
  return buildDict(
    listSystemStates()
      .filter((state) => toPositiveInt(state.essID, 0) > 0)
      .map((state) => [state.solarSystemID, buildAgencySystemPayload(state)]),
  );
}

function buildDbsMapDataPayload() {
  return require("./dynamicBountyRuntime").buildMapPayload();
}

function deriveReserveWindowState(state = null) {
  if (!state || state.reserveBankPulsesRemaining <= 0 || state.reserveBankPulsesTotal <= 0) {
    return ESS_RESERVE_WINDOW_STATE_INACTIVE;
  }
  const currentPulse =
    state.reserveBankPulsesTotal - state.reserveBankPulsesRemaining + 1;
  const windowSize =
    state.reserveBankPulsesTotal /
    DEFAULT_DYNAMIC_RESOURCE_SETTINGS.reserveWindowAccessFactor;
  if (currentPulse < windowSize) {
    return ESS_RESERVE_WINDOW_STATE_EARLY;
  }
  if (currentPulse === Math.round(windowSize)) {
    return ESS_RESERVE_WINDOW_STATE_BEST;
  }
  return ESS_RESERVE_WINDOW_STATE_LATE;
}

function deriveAutopaymentWindowState(state = null) {
  if (!state || state.mainValue <= 0) return ESS_AUTOPAY_STATE_LONG;
  const interval = DEFAULT_DYNAMIC_RESOURCE_SETTINGS.autopaymentIntervalSeconds * 1000;
  const remaining = Math.max(0, Number(state.autopayAtMs || now()) - now());
  if (remaining > interval * DEFAULT_DYNAMIC_RESOURCE_SETTINGS.earlyPayoutThresholdFactor) return ESS_AUTOPAY_STATE_LONG;
  if (remaining > interval * DEFAULT_DYNAMIC_RESOURCE_SETTINGS.latePayoutThresholdFactor) return ESS_AUTOPAY_STATE_MEDIUM;
  return ESS_AUTOPAY_STATE_SHORT;
}

function buildEssSystemDetailsPayload(solarSystemID) {
  const state = getSystemState(solarSystemID);
  const reserveWindowState = deriveReserveWindowState(state);
  return buildDict([
    ["autopaymentWindowState", deriveAutopaymentWindowState(state)],
    ["activeLinks", state ? state.reserveLinkedCharacterIDs.size + (state.mainBankLink ? 1 : 0) : 0],
    ["totalPulses", state ? state.reserveBankPulsesTotal : 0],
    ["reserveTimeWindowState", reserveWindowState],
    [
      "reserveTimeChosen",
      state && reserveWindowState !== ESS_RESERVE_WINDOW_STATE_INACTIVE
        ? state.reserveBankPulsesTotal * 60
        : 0,
    ],
  ]);
}

function buildReserveKeyTypeIDListPayload(solarSystemID) {
  return buildList(listReserveKeyTypeIDsForSystem(solarSystemID));
}

function buildTheftHistoryPayload(entries = []) {
  return buildList(entries.map(entry => buildDict(Object.entries(entry).map(([key, value]) => [key, key === "lastTheft" ? buildFiletimeLong(value) : value]))));
}

function attemptMainBankLink(solarSystemID, characterID, shipID = 0, clientID = 0, identity = {}) {
  const state = getSystemState(solarSystemID);
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!state || !state.essID || !normalizedCharacterID || state.mainBankLink || state.reserveLinkedCharacterIDs.has(normalizedCharacterID)) {
    return { success: false, state };
  }
  state.mainBankLink = {
    ...identity,
    linkID: randomUUID(),
    characterID: normalizedCharacterID,
    shipID,
    clientID,
    startedAt: filetimeNow(),
    completesAt: filetimeAfterSeconds(DEFAULT_DYNAMIC_RESOURCE_SETTINGS.bufferTimeSeconds),
  };
  saveSystemState(state);
  return { success: true, state };
}

function requestMainBankUnlink(solarSystemID, characterID = 0) {
  const state = getSystemState(solarSystemID);
  if (!state || !state.mainBankLink || (characterID && state.mainBankLink.characterID !== characterID)) {
    return { success: false, state, link: null };
  }
  const link = state.mainBankLink;
  state.mainBankLink = null;
  saveSystemState(state);
  return { success: true, state, link };
}


function attemptReserveBankLink(solarSystemID, characterID) {
  const state = getSystemState(solarSystemID);
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (
    !state ||
    !state.essID ||
    state.reserveBankPulsesRemaining <= 0 ||
    !normalizedCharacterID
  ) {
    return { success: false, state };
  }
  state.reserveLinkedCharacterIDs.add(normalizedCharacterID);
  saveSystemState(state);
  return { success: true, state };
}

function requestReserveBankUnlink(solarSystemID, characterID = 0) {
  const state = getSystemState(solarSystemID);
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!state || !normalizedCharacterID) {
    return { success: false, state };
  }
  const wasLinked = state.reserveLinkedCharacterIDs.delete(normalizedCharacterID);
  if (state.reserveLinks) delete state.reserveLinks[normalizedCharacterID];
  if (wasLinked) saveSystemState(state);
  return { success: wasLinked, state };
}

function isCharacterLinkedToReserveBank(solarSystemID, characterID) {
  const state = getSystemState(solarSystemID);
  return Boolean(
    state &&
    state.reserveLinkedCharacterIDs.has(toPositiveInt(characterID, 0)),
  );
}

function resetForTests() {
  repository.write({ version: 1, systems: {}, funding: {}, settlements: {} });
  clearReferenceCache(TABLE.SOLAR_SYSTEMS);
}

module.exports = {
  TYPE_ENCOUNTER_SURVEILLANCE_SYSTEM,
  ESS_AUTOPAY_STATE_LONG,
  ESS_AUTOPAY_STATE_MEDIUM,
  ESS_AUTOPAY_STATE_SHORT,
  ESS_RESERVE_WINDOW_STATE_INACTIVE,
  ESS_RESERVE_WINDOW_STATE_EARLY,
  ESS_RESERVE_WINDOW_STATE_BEST,
  ESS_RESERVE_WINDOW_STATE_LATE,
  UNLINKED_MANUAL,
  UNLINKED_PROXIMITY,
  UNLINKED_SHIP_CHANGE,
  DEFAULT_DYNAMIC_RESOURCE_SETTINGS,
  saveSystemState,
  now,
  setNowProvider: provider => { nowProvider = provider || (() => Date.now()); },
  ESS_KEY_TYPE_IDS,
  ESS_RESERVE_KEY_TOTAL_PULSES,
  getSystemIDFromArgsOrSession,
  getSystemIDFromSession,
  getStaticSolarSystem,
  isKnownNullsecSystem,
  listReserveKeyTypeIDsForSystem,
  setSystemState,
  clearSystemState,
  getSystemState,
  listSystemStates,
  ensureAuthoredEss,
  buildSettingsPayload,
  buildEssDataPayload,
  buildAgencyDataPayload,
  buildDbsMapDataPayload,
  buildEssSystemDetailsPayload,
  buildReserveKeyTypeIDListPayload,
  buildTheftHistoryPayload,
  attemptMainBankLink,
  requestMainBankUnlink,
  getReserveKeyTotalPulses,
  attemptReserveBankLink,
  requestReserveBankUnlink,
  isCharacterLinkedToReserveBank,
  _testing: {
    resetForTests,
    filetimeAfterSeconds,
    deriveAutopaymentWindowState,
    deriveReserveWindowState,
  },
};
