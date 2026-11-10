"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { getDockedLocationID } = require("../structure/structureLocation");
const {
  buildDict,
  buildFiletimeLong,
  buildMarshalReal,
  buildObjectEx1,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const solarSystemInterferenceState = require(path.join(
  __dirname,
  "solarSystemInterferenceState",
));
const { getWallclockNowMs, toFileTimeFromMs } = require("../../space/runtime/runtimeClock");

function interferenceFiletime() {
  return toFileTimeFromMs(getWallclockNowMs());
}

const STATE_CLASS_NAME =
  "solarsysteminterference.solarsystemInterferenceState.SolarsystemInterferenceState";

function resolveSolarSystemID(session) {
  const kind = String(session?._space?.sceneKind || "").trim();
  const key = String(session?._space?.sceneKey || session?.spaceSceneKey || "").trim();
  if ((kind && kind !== "solarSystem") || (key && !/^solar-system:\d+$/.test(key))) return 0;
  const worldData = require("../../space/worldData");
  const dockedID = getDockedLocationID(session);
  const docked = dockedID ? worldData.getStationByID(dockedID) || worldData.getStructureByID(dockedID) : null;
  const id = Number(dockedID ? docked?.solarSystemID
    : session?._space?.systemID || session?.solarsystemid2 || session?.solarsystemid);
  if (!dockedID && key && key !== `solar-system:${id}`) return 0;
  if (!Number.isSafeInteger(id) || id <= 0 ||
      require("../../abyssal").engineSupport.hostLocation.isAbyssalHostLocationID(id)) return 0;
  return worldData.getSolarSystemByID(id) ? id : 0;
}

function buildInterferenceStatePayload(rawState = {}, filetime = interferenceFiletime()) {
  const state = solarSystemInterferenceState.calculateInterferenceStateAtFileTime(
    rawState,
    filetime,
  );
  return buildObjectEx1(STATE_CLASS_NAME, [
    // Avoid Python 2 integer division in both normalized level and decay.
    buildMarshalReal(state.interferenceLevel),
    buildFiletimeLong(state.lastDecayTickTimestamp),
    buildMarshalReal(state.interferenceDecreasePerDecayTick),
    buildMarshalReal(state.decayTickPeriod),
    buildMarshalReal(state.maxInterferenceLevel),
    buildMarshalReal(state.quiescentInterferenceLevel),
  ]);
}

function notifySolarSystemInterferenceChanged(solarSystemID, state, filetime = interferenceFiletime()) {
  const payload = buildInterferenceStatePayload(state, filetime);
  for (const session of require("../chat/sessionRegistry").getSessions()) {
    try {
      if (resolveSolarSystemID(session) !== solarSystemID || typeof session.sendNotification !== "function") continue;
      session.sendNotification("OnSolarsystemInterferenceChanged", "clientID", [solarSystemID, payload]);
    } catch (error) {
      log.warn(`[SolarSystemInterferenceMgr] Notification failed system=${solarSystemID}: ${error.message}`);
    }
  }
}

function resetLocalInterference(session) {
  if (!resolveSessionCharacterID(session)) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  const solarSystemID = resolveSolarSystemID(session);
  if (!solarSystemID) return { success: false, errorMsg: "SOLAR_SYSTEM_NOT_FOUND" };
  let recovery;
  try { recovery = require("../ship/mobileAnalysisBeaconRuntime").recoverPendingLinkPayments(); }
  catch (error) { return { success: false, errorMsg: error.message }; }
  if (!recovery.success) return recovery;

  const read = solarSystemInterferenceState.readSolarSystemInterferenceState(solarSystemID);
  if (!read.success) return read;
  const previous = read.data;
  const filetime = interferenceFiletime();
  const current = solarSystemInterferenceState.calculateInterferenceStateAtFileTime(
    previous || solarSystemInterferenceState.buildQuietInterferenceState(filetime), filetime,
  );
  // Reset to the policy's quiet baseline, which the native client shows as 0%.
  const state = { ...current, interferenceLevel: current.quiescentInterferenceLevel, lastDecayTickTimestamp: filetime };
  let result;
  try {
    result = solarSystemInterferenceState.writeSolarSystemInterferenceState(solarSystemID, state);
    if (result.success) result = solarSystemInterferenceState.flushSolarSystemInterferenceState();
  } catch (error) {
    result = { success: false, errorMsg: error.message };
  }
  if (!result?.success) {
    try {
      const restored = solarSystemInterferenceState.restoreSolarSystemInterferenceState(solarSystemID, previous);
      if (!restored.success) log.warn(`[SolarSystemInterferenceMgr] Reset rollback failed system=${solarSystemID}: ${restored.errorMsg}`);
    } catch (error) {
      log.warn(`[SolarSystemInterferenceMgr] Reset rollback failed system=${solarSystemID}: ${error.message}`);
    }
    return { success: false, errorMsg: result?.errorMsg || "SOLAR_SYSTEM_INTERFERENCE_STORAGE_FAILED" };
  }
  notifySolarSystemInterferenceChanged(solarSystemID, state, filetime);
  return { success: true, data: { solarSystemID, state } };
}

class SolarSystemInterferenceMgrService extends BaseService {
  constructor() {
    super("solarsystemInterferenceMgr");
  }

  Handle_GetLocalInterferenceState(args, session) {
    const solarSystemID = resolveSolarSystemID(session);
    const state =
      solarSystemInterferenceState.getSolarSystemInterferenceState(solarSystemID) ||
      solarSystemInterferenceState.buildQuietInterferenceState(interferenceFiletime());

    log.debug(
      `[SolarSystemInterferenceMgr] GetLocalInterferenceState system=${solarSystemID || "unknown"} level=${state.interferenceLevel}`,
    );
    return buildInterferenceStatePayload(state);
  }

  Handle_GetAllInterferenceBands() {
    const table = solarSystemInterferenceState.readSolarSystemInterferenceTable();
    const entries = [];
    for (const [solarSystemID, rawState] of Object.entries(table.systems || {})) {
      const state = solarSystemInterferenceState.calculateInterferenceStateAtFileTime(
        rawState,
        interferenceFiletime(),
      );
      const band = solarSystemInterferenceState.getInterferenceBand(state);
      if (band !== solarSystemInterferenceState.INTERFERENCE_BAND_NONE) {
        entries.push([Number(solarSystemID), band]);
      }
    }

    log.debug(
      `[SolarSystemInterferenceMgr] GetAllInterferenceBands -> ${entries.length} active`,
    );
    return buildDict(entries);
  }
}

SolarSystemInterferenceMgrService._testing = {
  buildInterferenceStatePayload,
  resolveSolarSystemID,
};
SolarSystemInterferenceMgrService.notifySolarSystemInterferenceChanged = notifySolarSystemInterferenceChanged;
SolarSystemInterferenceMgrService.resetLocalInterference = resetLocalInterference;

module.exports = SolarSystemInterferenceMgrService;
