"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { unwrapMarshalValue } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const { hasStaffAccountRole } = require(path.join(
  __dirname,
  "../account/accountRoleProfiles",
));

const qaToolEvents = [];

function toText(value, fallback = "") {
  const unwrapped = unwrapMarshalValue(value);
  if (unwrapped === null || unwrapped === undefined) {
    return fallback;
  }
  if (Buffer.isBuffer(unwrapped)) {
    return unwrapped.toString("utf8");
  }
  return String(unwrapped);
}

function recordQaToolEvent(eventType, args = [], session = null) {
  const event = {
    eventID: qaToolEvents.length + 1,
    eventType,
    characterID: Number(session && (session.characterID || session.charid || 0)) || 0,
    accountID: Number(session && (session.userid || session.userID || 0)) || 0,
    recordedAt: new Date().toISOString(),
    args: (Array.isArray(args) ? args : []).map((entry) => toText(entry, "")),
  };
  qaToolEvents.push(event);
  log.info(`[PublicQaToolsServer] ${eventType} received`);
  return event;
}

class PublicQaToolsServerService extends BaseService {
  constructor() {
    super("publicQaToolsServer");
  }

  Handle_MoveMeTo(args, session) {
    recordQaToolEvent("move_me_to", args, session);
    if (!hasStaffAccountRole(session)) return null;
    // publicQaToolsClient.py sends the system name from the Move Me window.
    // Resolve it before constructing a command, so it cannot become arguments.
    const { resolveSolarSystemByName } = require("../chat/solarSystemRegistry");
    const lookup = resolveSolarSystemByName(toText(Array.isArray(args) ? args[0] : null));
    if (!lookup.success) {
      const { throwWrappedUserError } = require("../../common/machoErrors");
      throwWrappedUserError("CustomNotify", { notify: "Choose a known solar system for Move Me." });
    }
    return this.Handle_SlashCmd([`/tr me ${lookup.match.solarSystemID}`], session, {});
  }

  Handle_SlashCmd(args, session, kwargs) {
    recordQaToolEvent("slash_cmd", args, session);
    // The client sends its public QA command list (such as /giveitem) here
    // before it checks the account's GM role, so this route has to check it.
    // Accounts saved with isGM:false are ordinary players; their requests stay
    // inert, as they were before this route ran commands at all.
    if (!hasStaffAccountRole(session)) {
      return null;
    }
    // Staff get the same execution, validation, and chat feedback as slash.SlashCmd.
    if (!this.slashService) {
      const SlashService = require("../admin/slashService");
      this.slashService = new SlashService();
    }
    this.slashService.serviceManager = this.serviceManager;
    return this.slashService.Handle_SlashCmd(args, session, kwargs);
  }

  afterCallResponse(methodName, session) {
    if (this.slashService) {
      this.slashService.afterCallResponse(methodName, session);
    }
  }

  Handle_CanGiveItemForMultifit(args, session) {
    recordQaToolEvent("can_give_item_for_multifit", args, session);
    return false;
  }
}

module.exports = PublicQaToolsServerService;
module.exports._testing = {
  getEvents() {
    return qaToolEvents.map((event) => JSON.parse(JSON.stringify(event)));
  },
  resetForTests() {
    qaToolEvents.length = 0;
  },
};
