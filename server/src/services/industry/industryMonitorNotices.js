"use strict";

/**
 * What a client's monitored industry job is told without asking.
 *
 * industryMonitor.ConnectJob answers a monitor's number and what the job's
 * input place has (industrySvc.py ConnectJob, 299-301). From then on the
 * client takes OnIndustryMaterials(monitorID, materials) for what the place
 * has, where the number is its monitored job's (324-327). It keeps one
 * monitored job, the last it connected, so one monitor is kept for a session.
 *
 * No recording has the notice, nor any notice of industry's. It is addressed
 * by clientID, as this server's OnIndustryJob is, and sent to the session that
 * opened the monitor after an item change that session is told of, where what
 * the place has is no longer what the session was last told.
 */

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildAvailableMaterialsPayload,
} = require(path.join(__dirname, "./industryPayloads"));

const MATERIALS_NOTICE = "OnIndustryMaterials";

// session -> { monitorID, reckon, told }: the monitor the session opened
// last, how what its place has is reckoned, and what the session was told.
const monitorOfSession = new WeakMap();

/**
 * What a place has, spelt to be compared. Its types are whole numbers, which
 * an object holds in their own order whatever order they were put in.
 */
function spell(materials) {
  return JSON.stringify(
    Object.entries(materials)
      .map(([typeID, quantity]) => [Number(typeID), Number(quantity)]),
  );
}

/**
 * A monitor a session has opened: `materials` is what it was answered, and
 * `reckon` says what the place has now.
 */
function watchMonitor(session, monitorID, materials, reckon) {
  monitorOfSession.set(session, { monitorID, reckon, told: spell(materials) });
}

/** A monitor let go by its number. Another number than the kept one's lets nothing go. */
function forgetMonitor(session, monitorID) {
  const kept = monitorOfSession.get(session);
  if (kept && kept.monitorID === monitorID) {
    monitorOfSession.delete(session);
  }
}

/**
 * To be called when a session has been told of an item change: its monitor
 * is told what its place has, where that is not what it was last told.
 */
function tellMonitorAfterItemChange(session) {
  const kept = monitorOfSession.get(session);
  if (!kept) {
    return;
  }
  let materials;
  try {
    materials = kept.reckon();
  } catch (error) {
    // The item's own notice has gone out, and what follows it must: a
    // monitor that cannot be reckoned is told nothing.
    log.debug(
      `[IndustryMonitor] Monitor ${kept.monitorID} could not be reckoned: ${error && error.message}`,
    );
    return;
  }
  const now = spell(materials);
  if (now === kept.told) {
    return;
  }
  kept.told = now;
  session.sendNotification(MATERIALS_NOTICE, "clientID", [
    kept.monitorID,
    buildAvailableMaterialsPayload(materials),
  ]);
}

module.exports = {
  forgetMonitor,
  tellMonitorAfterItemChange,
  watchMonitor,
};
