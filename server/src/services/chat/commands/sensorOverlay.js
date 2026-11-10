"use strict";

// Sensor overlay chat command: /overlayrefresh, which resends the sensor overlay to a caller in
// space.

const path = require("path");

const worldData = require("../../../space/worldData");
const ScanMgrService = require(path.join(__dirname, "../../exploration/scanMgrService"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));

function handleOverlayRefreshCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /overlayrefresh.",
    );
  }

  const systemID = Number(
    (session._space && session._space.systemID) ||
    session.solarsystemid2 ||
    session.solarsystemid ||
    0
  ) || 0;
  if (systemID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space to refresh the sensor overlay.",
    );
  }

  const scanMgr = new ScanMgrService();
  const refreshResult = scanMgr.refreshSignalTrackerForSession(session, {
    shouldRemoveOldSites: true,
  });
  if (!refreshResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Could not refresh the sensor overlay for the current system.",
    );
  }

  const system = worldData.getSolarSystemByID(systemID);
  const systemLabel =
    (system && system.solarSystemName) ||
    (systemID > 0 ? `system ${systemID}` : "the current system");
  return handledResult(
    chatHub,
    session,
    options,
    `Refreshing the sensor overlay for ${systemLabel}.`,
  );
}

module.exports = {
  handleOverlayRefreshCommand,
};
