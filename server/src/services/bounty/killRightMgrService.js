"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { throwWrappedUserError } = require(path.join(
  __dirname,
  "../../common/machoErrors",
));
const killRightState = require(path.join(__dirname, "./killRightState"));
const killRightActivationEffects = require(path.join(
  __dirname,
  "./killRightActivationEffects",
));
const {
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));

const auditEvents = [];

function getCharacterID(session = null) {
  return Number(
    session &&
      (
        session.characterID ||
        session.charid ||
        session.characterId
      ),
  ) || 0;
}

function buildSessionOwnerIDs(session = null) {
  return [
    Number(session && (session.characterID || session.charid)) || 0,
    Number(session && (session.corporationID || session.corpid)) || 0,
    Number(session && (session.allianceID || session.allianceid)) || 0,
  ].filter((ownerID) => ownerID > 0);
}

function cloneArgs(args) {
  return Array.isArray(args) ? args.slice() : [];
}

function recordAuditEvent(kind, args = [], session = null) {
  auditEvents.push({
    kind,
    args: cloneArgs(args),
    characterID: getCharacterID(session) || null,
    timestamp: Date.now(),
  });
}

function throwNoValidKillRight() {
  throwWrappedUserError("NoValidKillRight", {});
}

function throwKillRightExpired() {
  throwWrappedUserError("KillRightExpired", {});
}

function throwKillRightNotForSale() {
  throwWrappedUserError("KillRightNotForSale", {});
}

function throwNotEnoughMoney(requiredAmount, currentBalance) {
  throwWrappedUserError(
    "NotEnoughMoney",
    buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance),
  );
}

function throwKillRightError(errorMsg, options = {}) {
  if (errorMsg === killRightState.ERROR.KILL_RIGHT_EXPIRED) {
    throwKillRightExpired();
  }
  if (errorMsg === killRightState.ERROR.KILL_RIGHT_NOT_FOR_SALE) {
    throwKillRightNotForSale();
  }
  if (errorMsg === killRightState.ERROR.PAYMENT_FAILED) {
    if (options.paymentErrorMsg === "INSUFFICIENT_FUNDS") {
      const wallet = getCharacterWallet(options.characterID);
      throwNotEnoughMoney(options.requiredAmount || 0, wallet ? wallet.balance : 0);
    }
    throwWrappedUserError("CustomNotify", {
      notify: "Unable to buy kill right.",
    });
  }
  throwNoValidKillRight();
}

class KillRightMgrService extends BaseService {
  constructor() {
    super("killRightMgr");
  }

  Handle_ActivateKillRight(args, session) {
    const killRightID = args && args.length > 0 ? args[0] : null;
    const characterID = getCharacterID(session);
    const result = killRightState.activateOwnedKillRight(
      killRightID,
      characterID,
      {
        nowMs: Date.now(),
      },
    );
    if (!result.success) {
      recordAuditEvent("activate_kill_right_rejected", [killRightID], session);
      log.debug(
        `[KillRightMgr] ActivateKillRight rejected: killRightID=${killRightID} error=${result.errorMsg}`,
      );
      throwKillRightError(result.errorMsg, { characterID });
    }
    killRightActivationEffects.applyKillRightSuspectTimer(
      result.data.killRight,
      session,
      Date.now(),
      killRightState.KILL_RIGHT_SUSPECT_TIMER_MS,
    );
    killRightActivationEffects.notifyKillRightActivated(
      result.data.killRight,
      characterID,
      session,
    );
    recordAuditEvent("activate_kill_right", [killRightID], session);
    log.info(
      `[KillRightMgr] ActivateKillRight: killRightID=${killRightID} activator=${characterID} target=${result.data.killRight.toID}`,
    );
    return null;
  }

  async Handle_BuyKillRight(args, session) {
    const killRightID = args && args.length > 0 ? args[0] : null;
    const price = args && args.length > 1 ? args[1] : null;
    const characterID = getCharacterID(session);
    const result = await killRightState.buyKillRightAsync(
      killRightID,
      characterID,
      buildSessionOwnerIDs(session),
      price,
      {
        nowMs: Date.now(),
        publisher: (data) =>
          killRightActivationEffects.publishPurchasedKillRight(data, {
            session,
            durationMs: killRightState.KILL_RIGHT_SUSPECT_TIMER_MS,
            filetimeToMs: killRightState.filetimeToMs,
          }),
      },
    );
    if (!result.success) {
      recordAuditEvent("buy_kill_right_rejected", [killRightID, price], session);
      log.debug(
        `[KillRightMgr] BuyKillRight rejected: killRightID=${killRightID} error=${result.errorMsg}`,
      );
      throwKillRightError(result.errorMsg, {
        characterID,
        paymentErrorMsg: result.paymentErrorMsg,
        requiredAmount: price,
      });
    }
    recordAuditEvent("buy_kill_right", [killRightID, price], session);
    log.info(
      `[KillRightMgr] BuyKillRight: killRightID=${killRightID} buyer=${characterID} target=${result.data.killRight.toID} price=${price}`,
    );
    return null;
  }
}

KillRightMgrService._testing = {
  getAuditEvents() {
    return auditEvents.map((entry) => ({ ...entry }));
  },
  resetForTests() {
    auditEvents.length = 0;
  },
};

module.exports = KillRightMgrService;
