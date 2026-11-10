"use strict";

const {
  toInt,
} = require("../../../common/numbers");

const path = require("path");

const sessionRegistry = require(path.join(__dirname, "../../chat/sessionRegistry"));
const {
  applyCharacterToSession,
  syncShipFittingStateForSession,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  buildFiletimeLong,
  currentFileTime,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  buildModuleAttributeChangeEvent,
  sendOnMultiEventPairs,
} = require(path.join(__dirname, "../../_shared/godmaMultiEvent"));
const {
  buildImplantAttributeChangePayloads,
} = require(path.join(__dirname, "../../dogma/implants/activeImplantModifiers"));
const {
  buildIndustryAttributeChangePayloads,
} = require(path.join(__dirname, "../../dogma/brain/providers/industryBrainProvider"));
const {
  syncCharacterDogmaBrain,
  syncCharacterDogmaState,
} = require(path.join(__dirname, "../../dogma/brain/characterBrainRuntime"));
const {
  recordRecentSkillPointChangesFromDiff,
} = require(path.join(__dirname, "../certificates/skillChangeTracker"));
const {
  buildCharacterSkillDict,
  buildCharacterSkillEntry,
} = require(path.join(__dirname, "../skillTransport"));
const {
  getCharacterSkills,
} = require(path.join(__dirname, "../skillState"));

function buildKeyVal(entries) {
  return {
    type: "object",
    name: "utillib.KeyVal",
    args: {
      type: "dict",
      entries,
    },
  };
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSkillRecordTypeID(skillRecord) {
  return toInt(skillRecord && skillRecord.typeID, 0);
}

function dedupeSkillRecords(skillRecords = []) {
  const recordsByTypeID = new Map();
  for (const skillRecord of Array.isArray(skillRecords) ? skillRecords : []) {
    const typeID = normalizeSkillRecordTypeID(skillRecord);
    if (!typeID) {
      continue;
    }
    recordsByTypeID.set(typeID, cloneValue(skillRecord));
  }
  return [...recordsByTypeID.values()];
}

function buildSkillQueuePayload(entries = []) {
  return {
    type: "list",
    items: entries.map((entry) =>
      buildKeyVal([
        ["trainingStartSP", toInt(entry.trainingStartSP, 0)],
        ["queuePosition", toInt(entry.queuePosition, 0)],
        ["trainingTypeID", toInt(entry.trainingTypeID, 0)],
        ["trainingDestinationSP", toInt(entry.trainingDestinationSP, 0)],
        [
          "trainingEndTime",
          entry.trainingEndTime ? buildFiletimeLong(entry.trainingEndTime) : null,
        ],
        [
          "trainingStartTime",
          entry.trainingStartTime ? buildFiletimeLong(entry.trainingStartTime) : null,
        ],
        ["trainingToLevel", toInt(entry.trainingToLevel, 0)],
      ]),
    ),
  };
}

function buildSkillNotificationInfo(skillRecord, options = {}) {
  return buildCharacterSkillEntry(skillRecord, {
    includeMetadata: options.includeMetadata !== false,
  });
}

function buildSkillNotificationDict(skillRecords = [], options = {}) {
  return buildCharacterSkillDict(dedupeSkillRecords(skillRecords), {
    includeMetadata: options.includeMetadata !== false,
  });
}

function buildRemovedSkillNotificationRecord(skillRecord) {
  if (!skillRecord || typeof skillRecord !== "object") {
    return null;
  }

  return {
    ...cloneValue(skillRecord),
    locationID: 0,
    flagID: 0,
    skillLevel: 0,
    trainedSkillLevel: 0,
    effectiveSkillLevel: 0,
    virtualSkillLevel: null,
    skillPoints: 0,
    trainedSkillPoints: 0,
    inTraining: false,
    trainingStartSP: 0,
    trainingDestinationSP: 0,
    trainingStartTime: null,
    trainingEndTime: null,
  };
}

function buildRemovedSkillServerRecord(skillRecord) {
  const notificationRecord = buildRemovedSkillNotificationRecord(skillRecord);
  if (!notificationRecord) {
    return null;
  }

  // The client skill service deletes cached skills when trained points go negative.
  notificationRecord.skillPoints = -1;
  notificationRecord.trainedSkillPoints = -1;
  return notificationRecord;
}

function getLiveCharacterSession(characterID) {
  return sessionRegistry.findSessionByCharacterID(characterID);
}

function buildMultiEventPairFromModuleAttributeChange(change) {
  if (!Array.isArray(change) || change.length < 8) {
    return null;
  }
  const time = change[4] ?? currentFileTime();
  return {
    event: buildModuleAttributeChangeEvent(
      change[1],
      change[2],
      change[3],
      change[5],
      change[6],
      time,
    ),
    time,
  };
}

function buildSkillMutationAttributeMultiEventPairs(session, characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return [];
  }

  return [
    ...buildImplantAttributeChangePayloads(session, numericCharacterID),
    ...buildIndustryAttributeChangePayloads(session, numericCharacterID),
  ]
    .map(buildMultiEventPairFromModuleAttributeChange)
    .filter(Boolean);
}

function notifySkillDogmaBrainChanged(characterID, options = {}) {
  const session = getLiveCharacterSession(characterID);
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  return syncCharacterDogmaBrain(session, characterID, {
    idType: options.idType || "charid",
  });
}

function notifySkillDogmaAttributesChangedAsMultiEvent(characterID, options = {}) {
  const session = getLiveCharacterSession(characterID);
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const send = () =>
    sendOnMultiEventPairs(
      session,
      buildSkillMutationAttributeMultiEventPairs(session, characterID),
    );

  if (options.defer === true) {
    setImmediate(send);
    return true;
  }

  return send();
}

function emitSkillSessionState(
  session,
  characterID,
  changedSkillRecords = [],
  options = {},
) {
  if (options.skipRecentSkillTracking !== true) {
    recordRecentSkillPointChangesFromDiff(
      characterID,
      changedSkillRecords,
      options.previousSkillMap,
    );
  }

  if (!session || typeof session.sendNotification !== "function") {
    return;
  }

  const numericCharacterID = toInt(characterID, 0);
  if (numericCharacterID <= 0) {
    return;
  }

  const changedSkills = dedupeSkillRecords(changedSkillRecords);
  const removedSkills = dedupeSkillRecords(options.removedSkillRecords);
  const hasSkillMutation = changedSkills.length > 0 || removedSkills.length > 0;
  const timeStamp = options.timeStamp || currentFileTime();

  if (hasSkillMutation) {
    applyCharacterToSession(session, numericCharacterID, {
      emitNotifications: false,
      logSelection: false,
      selectionEvent: false,
    });
  }

  if (changedSkills.length > 0) {
    session.sendNotification("OnServerSkillsChanged", "charid", [
      buildSkillNotificationDict(changedSkills, options),
      options.serverReason === undefined ? null : options.serverReason,
      buildFiletimeLong(timeStamp),
    ]);
  }

  if (removedSkills.length > 0) {
    session.sendNotification("OnServerSkillsRemoved", "clientID", [
      buildSkillNotificationDict(
        removedSkills
          .map((skillRecord) => buildRemovedSkillServerRecord(skillRecord))
          .filter(Boolean),
        options,
      ),
      buildFiletimeLong(timeStamp),
    ]);
  }

  // OnSkillLevelsTrained and OnSkillsChanged are client-local: skillsvc
  // scatters both from OnServerSkillsChanged / OnServerSkillsRemoved
  // (skillsvc.py:157-178), and retail never sends either from the server.
  // Sending them here made every listener run twice.

  if (options.freeSkillPoints !== undefined) {
    session.sendNotification("OnFreeSkillPointsChanged", "charid", [
      Math.max(0, toInt(options.freeSkillPoints, 0)),
    ]);
  }

  if (options.queueEntries) {
    session.sendNotification("OnNewSkillQueueSaved", "charid", [
      buildSkillQueuePayload(options.queueEntries),
    ]);
  }

  if (options.emitQueuePaused === true) {
    session.sendNotification("OnSkillQueuePausedServer", "clientID", []);
  }

  if (hasSkillMutation && options.syncDogmaState !== false) {
    const activeShipID = toInt(
      session.activeShipID || session.shipID || session.shipid,
      0,
    );
    if (activeShipID > 0 && options.syncShipFittingState !== false) {
      syncShipFittingStateForSession(session, activeShipID, {
        includeOfflineModules: true,
        includeCharges: true,
        // A skill-mutation fitting refresh has no business minting real
        // fitted-charge inventory rows: retail identifies a fitted charge by
        // its (shipID, flagID, chargeTypeID) tuple in both docked and space
        // sessions, so those itemIDs mean nothing to the client.
        emitChargeInventoryRows: false,
        // A skill mutation changes Dogma, not the fitted inventory or the
        // modules' online state. Re-sending unchanged fitted rows makes the
        // client replace live effect rows, while replaying online adds no new
        // authority. Keep the fitting/attribute refresh below, but emit neither.
        suppressNoOpItemChanges: true,
        emitOnlineEffects: false,
      });
    }
    syncCharacterDogmaState(session, numericCharacterID, {
      refreshLiveShip: options.syncShipFittingState !== false,
    });
  }
}

function notifySkillQueueSaved(characterID, queueEntries = []) {
  const session = getLiveCharacterSession(characterID);
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification("OnNewSkillQueueSaved", "charid", [
    buildSkillQueuePayload(queueEntries),
  ]);
}

function notifySkillQueuePaused(characterID) {
  const session = getLiveCharacterSession(characterID);
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification("OnSkillQueuePausedServer", "clientID", []);
}

function notifyFreeSkillPointsChanged(characterID, newFreeSkillPoints) {
  const session = getLiveCharacterSession(characterID);
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification("OnFreeSkillPointsChanged", "charid", [
    toInt(newFreeSkillPoints, 0),
  ]);
}

function notifyMultipleCharacterTrainingUpdated(accountID) {
  const numericAccountID = toInt(accountID, 0);
  if (numericAccountID <= 0) {
    return;
  }

  for (const session of sessionRegistry.getSessions()) {
    if (toInt(session && session.userid, 0) !== numericAccountID) {
      continue;
    }
    if (typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnMultipleCharactersTrainingUpdated", "userid", []);
  }
}

function primeClientSkillCache(session, characterID) {
  const numericCharacterID = toInt(characterID, 0);
  if (
    numericCharacterID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }

  const currentSkill = getCharacterSkills(numericCharacterID).find(
    (skillRecord) => normalizeSkillRecordTypeID(skillRecord) > 0,
  );
  if (!currentSkill) {
    return false;
  }

  // The client handles this on a notification tasklet and refreshes its full
  // skill cache before applying the supplied delta. Sending one unchanged,
  // genuinely-owned skill primes that cache without reporting trained levels.
  session.sendNotification("OnServerSkillsChanged", "charid", [
    buildSkillNotificationDict([currentSkill]),
    null,
    buildFiletimeLong(currentFileTime()),
  ]);
  return true;
}

const LOGON_TRAINED_SKILL_EVENT_IDS = new Set([
  37, // SKILL_EVENT_TRAINING_COMPLETE
  53, // SKILL_EVENT_QUEUE_TRAINING_COMPLETED
]);

function toFiletimeBigInt(value) {
  try {
    if (value === null || value === undefined || value === "") {
      return 0n;
    }
    return BigInt(String(value));
  } catch (error) {
    return 0n;
  }
}

/**
 * Collect the skill levels whose training finished after `sinceFiletime`
 * (the character's last logoff) from the character's skill history.
 * Returns Map(typeID -> { fromLevel, toLevel, skillRank }).
 */
function collectSkillLevelsTrainedSince(characterID, sinceFiletime) {
  const {
    getCharacterRecord,
  } = require(path.join(__dirname, "../../character/characterState"));
  const {
    getSkillLevelForPoints,
  } = require(path.join(__dirname, "./skillTrainingMath"));
  const record = getCharacterRecord(characterID) || {};
  const since = toFiletimeBigInt(sinceFiletime);
  const history = Array.isArray(record.skillHistory) ? record.skillHistory : [];
  const skillsByTypeID = new Map(
    getCharacterSkills(characterID).map((skill) => [normalizeSkillRecordTypeID(skill), skill]),
  );
  const trained = new Map();
  if (since <= 0n) {
    return trained;
  }
  for (const entry of history) {
    if (!entry || !LOGON_TRAINED_SKILL_EVENT_IDS.has(toInt(entry.eventTypeID, 0))) {
      continue;
    }
    if (toFiletimeBigInt(entry.logDate) <= since) {
      continue;
    }
    const typeID = toInt(entry.skillTypeID, 0);
    const skill = skillsByTypeID.get(typeID);
    if (typeID <= 0 || !skill) {
      continue;
    }
    const skillRank = Math.max(1, Number(skill.skillRank) || 1);
    const level = getSkillLevelForPoints(skillRank, entry.absolutePoints);
    if (level <= 0) {
      continue;
    }
    const current = trained.get(typeID);
    trained.set(typeID, {
      fromLevel: Math.min(current ? current.fromLevel : level - 1, level - 1),
      toLevel: Math.max(current ? current.toLevel : level, level),
      skillRank,
    });
  }
  return trained;
}

/**
 * OnLogonSkillsTrained(skillInfos, canTrain): sent once after character
 * selection for skills that finished training while the character was
 * offline. skillsvc.OnLogonSkillsTrained (skillsvc.py:145-155) plays the
 * trained sound and shows the "skills trained" notice. Retail: idtype charid,
 * args ({typeID: KeyVal(currentLevel, skillRank, skillLevel)}, True).
 */
function notifyLogonSkillsTrained(session, characterID, sinceFiletime, options = {}) {
  const numericCharacterID = toInt(characterID, 0);
  if (
    numericCharacterID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }
  const trained = collectSkillLevelsTrainedSince(numericCharacterID, sinceFiletime);
  if (trained.size === 0) {
    return false;
  }
  const entries = [...trained.entries()]
    .sort(([left], [right]) => left - right)
    .map(([typeID, info]) => [
      typeID,
      buildKeyVal([
        ["currentLevel", Math.max(0, info.fromLevel)],
        ["skillRank", Number(info.skillRank)],
        ["skillLevel", info.toLevel],
      ]),
    ]);
  session.sendNotification("OnLogonSkillsTrained", "charid", [
    { type: "dict", entries },
    options.canTrain !== false,
  ]);
  return true;
}

function notifySkillStateChanged(characterID, changedSkillRecords = [], options = {}) {
  recordRecentSkillPointChangesFromDiff(
    characterID,
    changedSkillRecords,
    options.previousSkillMap,
  );

  const session = getLiveCharacterSession(characterID);
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }

  emitSkillSessionState(session, characterID, changedSkillRecords, {
    ...options,
    skipRecentSkillTracking: true,
  });
}

module.exports = {
  buildSkillNotificationDict,
  buildSkillQueuePayload,
  emitSkillSessionState,
  getLiveCharacterSession,
  notifySkillDogmaAttributesChangedAsMultiEvent,
  notifySkillDogmaBrainChanged,
  notifyFreeSkillPointsChanged,
  notifyLogonSkillsTrained,
  notifyMultipleCharacterTrainingUpdated,
  primeClientSkillCache,
  notifySkillQueuePaused,
  notifySkillQueueSaved,
  notifySkillStateChanged,
};
