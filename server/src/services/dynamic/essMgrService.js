"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const dynamicResourceState = require(path.join(
  __dirname,
  "./dynamicResourceState",
));
const { buildDict } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const { validateEssLinkEligibility, getSessionShipID, ESS_LINKABLE_TYPES_LIST, ESS_MAX_LINK_DISTANCE_METERS } = require("./essEligibility");
const settlement = require("./essSettlementRuntime");
const reserve = require("./essReserveRuntime");
function getCharacterID(session) { return require("../_shared/sessionIdentity").resolveSessionCharacterID(session); }

function notify(session, name, payload) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification(name, "clientID", payload);
}

function notifyEssDataChanged(session, state) {
  if (!state) {
    return;
  }
  settlement.changed(state.solarSystemID);
  if (require("../chat/sessionRegistry").isRegisteredSession(session)) return;
  notify(session, "OnSystemESSDataChanged", [
    state.solarSystemID,
    dynamicResourceState.buildEssDataPayload(state),
  ]);
}

function buildMainBankDisconnectedPayload(state, link) {
  return buildDict([
    ["solarSystemID", state ? state.solarSystemID : 0],
    ["linkID", link ? link.linkID : ""],
    ["characterID", link ? link.characterID : 0],
    ["reason", dynamicResourceState.UNLINKED_MANUAL],
  ]);
}

function buildReserveBankDisconnectedPayload(state, characterID) {
  return buildDict([
    ["solarSystemID", state ? state.solarSystemID : 0],
    ["characterID", characterID || 0],
    ["reason", dynamicResourceState.UNLINKED_MANUAL],
  ]);
}

class EssMgrService extends BaseService {
  constructor() {
    super("essMgr");
  }

  Handle_GetDataForClientSolarSystem(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromArgsOrSession(
      args,
      session,
    );
    dynamicResourceState.ensureAuthoredEss(require("../../space/runtime").getSceneForSession(session));
    log.debug(`[EssMgr] GetDataForClientSolarSystem solarsystemid=${solarSystemID}`);
    return dynamicResourceState.buildEssDataPayload(
      dynamicResourceState.getSystemState(solarSystemID),
    );
  }

  Handle_IsClientLinkedToReserveBank(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromSession(session);
    const characterID = getCharacterID(session);
    return dynamicResourceState.isCharacterLinkedToReserveBank(
      solarSystemID,
      characterID,
    );
  }

  async Handle_AttemptLinkToMainBank(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromSession(session);
    const characterID = getCharacterID(session);
    await settlement.synchronize(solarSystemID);
    const state = dynamicResourceState.getSystemState(solarSystemID);
    const validationError = validateEssLinkEligibility(session, state, "main");
    if (validationError) {
      log.debug(
        `[EssMgr] AttemptLinkToMainBank rejected solarsystemid=${solarSystemID} characterID=${characterID} reason=${validationError}`,
      );
      return null;
    }
    const result = dynamicResourceState.attemptMainBankLink(
      solarSystemID,
      characterID,
      getSessionShipID(session),
      Number(session.clientID || session.clientId || 0),
      settlement.createLinkIdentity(session),
    );
    if (result.success) await settlement.scheduleSystem(solarSystemID);
    log.debug(
      `[EssMgr] AttemptLinkToMainBank solarsystemid=${solarSystemID} characterID=${characterID} success=${result.success}`,
    );
    if (result.success) {
      notify(session, "OnESSMainBankLinkNotification", [solarSystemID]);
      notifyEssDataChanged(session, result.state);
    }
    return null;
  }

  async Handle_AttemptLinkToReserveBank(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromSession(session);
    const result = await reserve.link(session);
    if (result.success) {
      notify(session, "OnESSReserveBankLinkNotification", [solarSystemID]);
      notifyEssDataChanged(session, result.state);
    }
    return null;
  }

  async Handle_RequestMainBankUnlink(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromSession(session);
    if (!getCharacterID(session)) return null;
    await settlement.synchronize(solarSystemID);
    const result = dynamicResourceState.requestMainBankUnlink(solarSystemID, getCharacterID(session));
    log.debug(
      `[EssMgr] RequestMainBankUnlink solarsystemid=${solarSystemID} success=${result.success}`,
    );
    if (result.success) {
      notify(session, "OnMainBankPlayerLinkDisconnected", [
        buildMainBankDisconnectedPayload(result.state, result.link),
      ]);
      notifyEssDataChanged(session, result.state);
    }
    return null;
  }

  async Handle_RequestReserveBankUnlink(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromSession(session);
    const characterID = getCharacterID(session);
    await settlement.synchronize(solarSystemID);
    const result = dynamicResourceState.requestReserveBankUnlink(
      solarSystemID,
      characterID,
    );
    log.debug(
      `[EssMgr] RequestReserveBankUnlink solarsystemid=${solarSystemID} characterID=${characterID} success=${result.success}`,
    );
    if (result.success) {
      notify(session, "OnReserveBankPlayerLinkDisconnected", [
        buildReserveBankDisconnectedPayload(result.state, characterID),
      ]);
      notifyEssDataChanged(session, result.state);
    }
    return null;
  }

  async Handle_RequestUnlockReserveBank(args, session) {
    const keyTypeID = Number(args?.[0]) || 0;
    const result = await reserve.requestUnlock(session, keyTypeID);
    if (result.success) notifyEssDataChanged(session, result.state);
    return null;
  }

  Handle_GetMainBankTheftsForClientSolarSystem(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromArgsOrSession(
      args,
      session,
    );
    const state = dynamicResourceState.getSystemState(solarSystemID);
    return dynamicResourceState.buildTheftHistoryPayload(
      state ? state.theftHistoryMain : [],
    );
  }

  Handle_GetReserveBankTheftsForClientSolarSystem(args, session) {
    const solarSystemID = dynamicResourceState.getSystemIDFromArgsOrSession(
      args,
      session,
    );
    const state = dynamicResourceState.getSystemState(solarSystemID);
    return dynamicResourceState.buildTheftHistoryPayload(
      state ? state.theftHistoryReserve : [],
    );
  }

}

module.exports = EssMgrService;
module.exports._testing = {
  ESS_LINKABLE_TYPES_LIST,
  ESS_MAX_LINK_DISTANCE_METERS,
  validateEssLinkEligibility,
};
