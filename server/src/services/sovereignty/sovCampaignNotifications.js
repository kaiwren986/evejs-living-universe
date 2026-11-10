"use strict";

const path = require("node:path");

const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const {
  getAllianceCorporationIDs,
  getAllianceRecord,
  getCharacterIDsInCorporation,
} = require(path.join(__dirname, "../corporation/corporationState"));

// These four notification payloads are fixed by the V24.01 client formatters.
// TQ does not expose the server-side recipient policy or fan-out order. Until a
// small golden captures that contract, notify every current character in every
// current member corporation of the defending alliance, in numeric ID order.
// Keeping that provisional policy in this adapter lets the campaign state
// machine remain stable when the golden becomes available.

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeEventKey(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function filetimeLongData(value) {
  const raw = value && typeof value === "object" && value.type === "long"
    ? value.value
    : value;
  try {
    const filetime = BigInt(String(raw));
    return filetime > 0n
      ? { type: "long", value: filetime.toString() }
      : null;
  } catch (_error) {
    // ignored: an unreadable FILETIME gives no time (null)
    return null;
  }
}

function getDefenderAllianceRecipientIDs(defenderAllianceID) {
  const numericAllianceID = normalizePositiveInteger(defenderAllianceID, 0);
  const alliance = getAllianceRecord(numericAllianceID);
  if (!numericAllianceID || !alliance || alliance.deleted === true) {
    return [];
  }

  const recipients = new Set();
  for (const corporationID of getAllianceCorporationIDs(numericAllianceID)) {
    for (const characterID of getCharacterIDsInCorporation(corporationID)) {
      const numericCharacterID = normalizePositiveInteger(characterID, 0);
      if (numericCharacterID) {
        recipients.add(numericCharacterID);
      }
    }
  }
  return [...recipients].sort((left, right) => left - right);
}

function invalidNotification(errorMsg = "INVALID_SOV_CAMPAIGN_NOTIFICATION") {
  return {
    success: false,
    errorMsg,
    recipientCharacterIDs: [],
    createdCharacterIDs: [],
    reusedCharacterIDs: [],
    failedCharacterIDs: [],
    notificationIDs: [],
  };
}

function fanoutCampaignNotification(kind, typeID, data, options = {}) {
  const defenderAllianceID = normalizePositiveInteger(
    options.defenderAllianceID,
    0,
  );
  const eventKey = normalizeEventKey(options.eventKey);
  if (!defenderAllianceID || !eventKey || !data) {
    return invalidNotification();
  }

  const recipientCharacterIDs = getDefenderAllianceRecipientIDs(
    defenderAllianceID,
  );
  const createdCharacterIDs = [];
  const reusedCharacterIDs = [];
  const failedCharacterIDs = [];
  const notificationIDs = [];
  const senderID = options.senderID === undefined
    ? defenderAllianceID
    : Math.trunc(Number(options.senderID)) || 0;

  for (const characterID of recipientCharacterIDs) {
    const createOptions = {
      typeID,
      senderID,
      groupID: NOTIFICATION_GROUP.SOV,
      processed: false,
      data,
      emitLive: options.emitLive !== false,
      idempotencyKey:
        `sov-campaign:${kind}:alliance:${defenderAllianceID}:` +
        `event:${eventKey}:receiver:${characterID}`,
    };
    if (options.created !== undefined && options.created !== null) {
      createOptions.created = String(options.created);
    }
    const result = createNotification(characterID, createOptions);
    if (!result || result.success !== true) {
      failedCharacterIDs.push(characterID);
      continue;
    }
    notificationIDs.push(normalizePositiveInteger(result.notificationID, 0));
    if (result.reused === true) {
      reusedCharacterIDs.push(characterID);
    } else {
      createdCharacterIDs.push(characterID);
    }
  }

  return {
    success: failedCharacterIDs.length === 0,
    typeID,
    defenderAllianceID,
    recipientCharacterIDs,
    createdCharacterIDs,
    reusedCharacterIDs,
    failedCharacterIDs,
    notificationIDs,
  };
}

function notifySovCaptureStarted(options = {}) {
  const structureTypeID = normalizePositiveInteger(options.structureTypeID, 0);
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, 0);
  if (!structureTypeID || !solarSystemID) {
    return invalidNotification();
  }
  return fanoutCampaignNotification(
    "capture-started",
    NOTIFICATION_TYPE.SOV_ENTOSIS_CAPTURE_STARTED,
    { structureTypeID, solarSystemID },
    options,
  );
}

function notifySovStructureReinforced(options = {}) {
  const decloakTime = filetimeLongData(options.decloakTime);
  const campaignEventType = normalizePositiveInteger(options.campaignEventType, 0);
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, 0);
  if (!decloakTime || !campaignEventType || !solarSystemID) {
    return invalidNotification();
  }
  return fanoutCampaignNotification(
    "structure-reinforced",
    NOTIFICATION_TYPE.SOV_STRUCTURE_REINFORCED,
    { decloakTime, campaignEventType, solarSystemID },
    options,
  );
}

function notifySovCommandNodeEventStarted(options = {}) {
  const constellationID = normalizePositiveInteger(options.constellationID, 0);
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, 0);
  const campaignEventType = normalizePositiveInteger(options.campaignEventType, 0);
  if (!constellationID || !solarSystemID || !campaignEventType) {
    return invalidNotification();
  }
  return fanoutCampaignNotification(
    "command-node-event-started",
    NOTIFICATION_TYPE.SOV_COMMAND_NODE_EVENT_STARTED,
    { constellationID, solarSystemID, campaignEventType },
    options,
  );
}

function notifySovStructureDestroyed(options = {}) {
  const structureTypeID = normalizePositiveInteger(options.structureTypeID, 0);
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, 0);
  if (!structureTypeID || !solarSystemID) {
    return invalidNotification();
  }
  return fanoutCampaignNotification(
    "structure-destroyed",
    NOTIFICATION_TYPE.SOV_STRUCTURE_DESTROYED,
    { structureTypeID, solarSystemID },
    options,
  );
}

module.exports = {
  getDefenderAllianceRecipientIDs,
  notifySovCaptureStarted,
  notifySovCommandNodeEventStarted,
  notifySovStructureDestroyed,
  notifySovStructureReinforced,
};
