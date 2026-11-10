"use strict";

const {
  toInt,
  toPositiveInt,
} = require("../../common/numbers");

/**
 * Skill Manager Service (skillMgr)
 *
 * Handles skill-related queries from the client.
 */

const path = require("path");
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const { buildDbRowset } = require(path.join(__dirname, "../_shared/serviceHelpers"));
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { findItemById } = require(path.join(
  __dirname,
  "../inventory/itemStore",
));
const { getCharacterRecord } = require(path.join(
  __dirname,
  "../character/characterState",
));
const {
  getCharacterSkills,
  getSkillTypeByID,
} = require(path.join(__dirname, "./skillState"));
const {
  abortTraining,
  applyFreeSkillPoints,
  applyFreeSkillPointsInternal,
  buildPointsDict,
  getCharacterIDFromSession,
  getQueueSnapshot,
  normalizeQueueInput,
  previewFreeSkillPointsApplication,
  readBooleanKwarg,
  saveQueue,
} = require(path.join(__dirname, "./training/skillQueueRuntime"));
const {
  checkInjectionConstraints,
  combineSkillInjector,
  extractSkills,
  getDiminishedSpFromInjectors,
  injectSkillPoints,
  splitSkillInjector,
} = require(path.join(__dirname, "./trading/skillTradingRuntime"));
const {
  injectSkillbookItems,
  isSkillInjected,
  purchaseSkills,
} = require(path.join(__dirname, "./skillbooks/skillbookRuntime"));
const {
  consumeRecentSkillPointChanges,
} = require(path.join(__dirname, "./certificates/skillChangeTracker"));
const {
  buildCharacterSkillDict,
  buildCharacterSkillEntry,
} = require(path.join(__dirname, "./skillTransport"));
const {
  buildCharacterBoostersDict,
} = require(path.join(__dirname, "./boosters/boosterRuntime"));
const {
  applyActiveImplantAttributeBonuses,
  getActiveImplants,
} = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));
const {
  applyClientTrainingSpeedScale,
} = require(path.join(__dirname, "./training/skillTrainingSpeed"));

const ATTRIBUTE_CHARISMA = 164;
const ATTRIBUTE_INTELLIGENCE = 165;
const ATTRIBUTE_MEMORY = 166;
const ATTRIBUTE_PERCEPTION = 167;
const ATTRIBUTE_WILLPOWER = 168;

// skillsvc.GetSkillHistory(self, maxresults=50) in the client.
const DEFAULT_SKILL_HISTORY_ROWS = 50;
// The history's columns as Tranquility answers them, recorded at three
// logins (GetSkillHistory(10)): a carbon CRowset whose descriptor is
// logDate (a FILETIME), eventTypeID (two bytes), and skillTypeID,
// relativePoints and absolutePoints (four bytes each).
const SKILL_HISTORY_COLUMNS = [
  ["logDate", 0x40],
  ["eventTypeID", 0x02],
  ["skillTypeID", 0x03],
  ["relativePoints", 0x03],
  ["absolutePoints", 0x03],
];

function buildKeyVal(entries) {
  return {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries,
    },
  };
}

function buildList(items = []) {
  return {
    type: "list",
    items,
  };
}

function unwrapValue(value) {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      return unwrapValue(value.value);
    }
    if (value.type === "int" || value.type === "long") {
      return unwrapValue(value.value);
    }
  }
  return value;
}

function normalizeSkillRequirements(skillTypeIDsAndLevels) {
  if (!skillTypeIDsAndLevels) {
    return [];
  }

  // The client's own levels: a Python list of (typeID, level) pairs (applySkillPointsWindow.py, skillTypeIDsAndLevels,
  // handed to GetFreeSkillPointsAppliedToSkills and ApplyFreeSkillPointsToSkills, skillQueueSvc.py 608 to 613), which
  // arrives as a marshalled list. Read as anything else, it named no level at all: the asking answered no points, and
  // the spreading fell back to the queue's skills.
  if (
    skillTypeIDsAndLevels.type === "list" &&
    Array.isArray(skillTypeIDsAndLevels.items)
  ) {
    return normalizeSkillRequirements(
      skillTypeIDsAndLevels.items.map((entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry.type === "tuple" || entry.type === "list") &&
        Array.isArray(entry.items)
          ? entry.items
          : entry,
      ),
    );
  }

  if (
    skillTypeIDsAndLevels.type === "dict" &&
    Array.isArray(skillTypeIDsAndLevels.entries)
  ) {
    return skillTypeIDsAndLevels.entries
      .map(([typeID, level]) => ({
        typeID: toInt(unwrapValue(typeID), 0),
        toLevel: toInt(unwrapValue(level), 0),
      }))
      .filter((entry) => entry.typeID > 0 && entry.toLevel > 0);
  }

  if (Array.isArray(skillTypeIDsAndLevels)) {
    return skillTypeIDsAndLevels
      .map((entry) =>
        Array.isArray(entry)
          ? {
              typeID: toInt(unwrapValue(entry[0]), 0),
              toLevel: toInt(unwrapValue(entry[1]), 0),
            }
          : {
              typeID: toInt(unwrapValue(entry && (entry.typeID ?? entry.trainingTypeID)), 0),
              toLevel: toInt(unwrapValue(entry && (entry.toLevel ?? entry.trainingToLevel)), 0),
            },
      )
      .filter((entry) => entry.typeID > 0 && entry.toLevel > 0);
  }

  return Object.entries(skillTypeIDsAndLevels)
    .map(([typeID, level]) => ({
      typeID: toInt(unwrapValue(typeID), 0),
      toLevel: toInt(unwrapValue(level), 0),
    }))
    .filter((entry) => entry.typeID > 0 && entry.toLevel > 0);
}

class SkillMgrService extends BaseService {
  constructor() {
    super("skillMgr");
  }

  _getCharacterId(session) {
    // No identity on the session means no acting character; never impersonate a
    // default player. Callers guard on a positive id.
    return getCharacterIDFromSession(session) || 0;
  }

  _getSnapshot(session) {
    return getQueueSnapshot(this._getCharacterId(session));
  }

  _getLiveSkillPointTotal(session) {
    return this._getSnapshot(session).projectedSkills.reduce(
      (sum, skillRecord) => sum + Number(skillRecord.trainedSkillPoints || skillRecord.skillPoints || 0),
      0,
    );
  }

  _buildSkillInfo(skillRecord) {
    return buildCharacterSkillEntry(skillRecord, {
      includeMetadata: true,
    });
  }

  // The persisted per-skill record only advances when a level finishes, so a
  // skill that is mid-level stays frozen at the level's starting SP (and never
  // reports inTraining). The authoritative queue snapshot already projects the
  // live, training-speed-scaled SP for the skill currently training, so overlay
  // it here to keep the per-skill payload consistent with the live SP total and
  // to surface accrued points as the skill trains.
  //
  // This is GetMySkillInfo's view only, which answers that live total beside
  // it. The decompiled retail client has no call to GetMySkillInfo; the reads
  // it does make are answered by _overlayTrainingSkillAtQueueStart below.
  _overlayActiveTrainingSkill(skills, snapshot) {
    const projectedSkillMap = snapshot && snapshot.projectedSkillMap;
    if (!projectedSkillMap || typeof projectedSkillMap.get !== "function") {
      return skills;
    }
    return (Array.isArray(skills) ? skills : []).map((record) => {
      const projected = projectedSkillMap.get(toInt(record && record.typeID, 0));
      if (!projected || !projected.inTraining) {
        return record;
      }
      return {
        ...record,
        skillLevel: projected.skillLevel,
        trainedSkillLevel: projected.trainedSkillLevel,
        effectiveSkillLevel: projected.effectiveSkillLevel,
        skillPoints: projected.skillPoints,
        trainedSkillPoints: projected.trainedSkillPoints,
        inTraining: true,
      };
    });
  }

  // GetSkills and GetAllSkills give the retail client its skill entries, and
  // the client works out the points of the skill in training from them itself:
  // the entry's points, plus the training rate times the time since the first
  // queue entry's trainingStartTime (skillQueueSvc.GetEstimatedSkillPointsTrained
  // and skill_training.get_skill_points_trained_at_sample_time). So that entry
  // holds what the skill had when the first queue entry started: the queue
  // entry's trainingStartSP, at the level below the one it trains to. Given the
  // points trained so far instead, a client that logs in while the skill is
  // training counts the time before it logged in twice.
  //
  // The stored record is not answered as it is, because the queue entry can
  // start a point above it: until 2026-10-09 a level given outright was stored
  // with its points rounded to the nearest, where the queue rounds the same
  // level's points up, and characters stored that way are left as they are
  // (skillState.getStoredLevelPointsFloor).
  _overlayTrainingSkillAtQueueStart(skills, snapshot) {
    const head = snapshot && snapshot.currentEntry;
    const trainingTypeID = toInt(head && head.trainingTypeID, 0);
    if (trainingTypeID <= 0) {
      return skills;
    }
    const startSkillPoints = Math.max(0, toInt(head.trainingStartSP, 0));
    const startSkillLevel = Math.max(0, toInt(head.trainingToLevel, 0) - 1);
    return (Array.isArray(skills) ? skills : []).map((record) => {
      if (toInt(record && record.typeID, 0) !== trainingTypeID) {
        return record;
      }
      return {
        ...record,
        trainedSkillLevel: startSkillLevel,
        skillPoints: startSkillPoints,
        trainedSkillPoints: startSkillPoints,
        inTraining: true,
      };
    });
  }

  _buildSkillsDict(session, snapshot = this._getSnapshot(session), options = {}) {
    const skills = getCharacterSkills(this._getCharacterId(session));
    return buildCharacterSkillDict(
      options.live === true
        ? this._overlayActiveTrainingSkill(skills, snapshot)
        : this._overlayTrainingSkillAtQueueStart(skills, snapshot),
      {
        includeMetadata: true,
      },
    );
  }

  _buildSkillQueue(session) {
    return this._getSnapshot(session).queuePayload;
  }

  _buildEmptyDict() {
    return { type: "dict", entries: [] };
  }

  _getCharacterData(session) {
    return getCharacterRecord(this._getCharacterId(session)) || {};
  }

  _buildCharacterAttributes(session) {
    const charData = getCharacterRecord(this._getCharacterId(session)) || {};
    const source = charData.characterAttributes || {};
    // skillMgr.GetAttributes is the input the client's local training-time
    // calculator reads, so scale the learning attributes by skillTrainingSpeed
    // to keep its displayed estimates in sync with server SP accrual.
    //
    // The values carry what the active implants and boosters add, as godma's
    // and the attribute-change notices do (the same
    // applyActiveImplantAttributeBonuses) and as the server trains by
    // (skillTrainingMath normalizeCharacterAttributes): the client takes them
    // so. Its attributes window shows the base by taking each implant's and
    // each skill accelerator's bonus off them (neocom/attributes.py 84 to 97),
    // and its skill service leaves the accelerators out the same way
    // (skillsvc.py GetCharacterAttribute(includeBoosters=False), 230 to 240).
    const attributes = applyClientTrainingSpeedScale(applyActiveImplantAttributeBonuses({
      [ATTRIBUTE_CHARISMA]: Number(source[ATTRIBUTE_CHARISMA] ?? source.charisma ?? 20),
      [ATTRIBUTE_INTELLIGENCE]: Number(
        source[ATTRIBUTE_INTELLIGENCE] ?? source.intelligence ?? 20,
      ),
      [ATTRIBUTE_MEMORY]: Number(source[ATTRIBUTE_MEMORY] ?? source.memory ?? 20),
      [ATTRIBUTE_PERCEPTION]: Number(
        source[ATTRIBUTE_PERCEPTION] ?? source.perception ?? 20,
      ),
      [ATTRIBUTE_WILLPOWER]: Number(source[ATTRIBUTE_WILLPOWER] ?? source.willpower ?? 20),
    }, this._getCharacterId(session)));
    return {
      type: "dict",
      entries: [
        [ATTRIBUTE_CHARISMA, attributes[ATTRIBUTE_CHARISMA]],
        [ATTRIBUTE_INTELLIGENCE, attributes[ATTRIBUTE_INTELLIGENCE]],
        [ATTRIBUTE_MEMORY, attributes[ATTRIBUTE_MEMORY]],
        [ATTRIBUTE_PERCEPTION, attributes[ATTRIBUTE_PERCEPTION]],
        [ATTRIBUTE_WILLPOWER, attributes[ATTRIBUTE_WILLPOWER]],
      ],
    };
  }

  Handle_GetMySkillQueue(args, session) {
    log.debug("[SkillMgr] GetMySkillQueue");
    return this._buildSkillQueue(session);
  }

  Handle_GetMySkillInfo(args, session) {
    log.debug("[SkillMgr] GetMySkillInfo");
    const snapshot = this._getSnapshot(session);
    return buildKeyVal([
      ["skills", this._buildSkillsDict(session, snapshot, { live: true })],
      ["skillPoints", this._getLiveSkillPointTotal(session)],
      ["freeSkillPoints", snapshot.freeSkillPoints],
      ["queue", snapshot.queuePayload],
    ]);
  }

  Handle_GetSkillQueue(args, session) {
    log.debug("[SkillMgr] GetSkillQueue");
    return this._buildSkillQueue(session);
  }

  Handle_GetSkillHistory(args, session) {
    log.debug("[SkillMgr] GetSkillHistory");
    const charData = this._getCharacterData(session);
    const history = Array.isArray(charData.skillHistory) ? charData.skillHistory : [];
    // The client says how many rows it wants and is given that many, the
    // newest first: skillsvc.GetSkillHistory(maxresults=50), and at login the
    // skill history notification provider asks for 10 and makes a notification
    // of every row it gets back. The dates are FILETIME, too large for a
    // double, so they are compared as BigInt. Rows with the same date keep the
    // order they are stored in.
    const maxResults = toPositiveInt(
      unwrapValue(args && args[0]),
      DEFAULT_SKILL_HISTORY_ROWS,
    );
    const newestFirst = history
      .map((entry) => ({ entry, logDate: BigInt(String(entry.logDate || 0)) }))
      .sort((left, right) => {
        if (left.logDate === right.logDate) {
          return 0;
        }
        return left.logDate < right.logDate ? 1 : -1;
      })
      .slice(0, maxResults);
    // A row kept before the points an event gave were kept has none to say.
    return buildDbRowset(
      SKILL_HISTORY_COLUMNS,
      newestFirst.map(({ entry, logDate }) => [
        logDate,
        Number(entry.eventTypeID || 0),
        Number(entry.skillTypeID || 0),
        Number(entry.relativePoints || 0),
        Number(entry.absolutePoints || 0),
      ]),
      "carbon.common.script.sys.crowset.CRowset",
    );
  }

  Handle_GetSkillChangesForISIS(args, session) {
    log.debug("[SkillMgr] GetSkillChangesForISIS");
    return consumeRecentSkillPointChanges(this._getCharacterId(session));
  }

  Handle_GetSkillPoints(args, session) {
    log.debug("[SkillMgr] GetSkillPoints");
    return this._getLiveSkillPointTotal(session);
  }

  Handle_GetCharacterAttributeModifiers(args, session) {
    log.debug("[SkillMgr] GetCharacterAttributeModifiers");
    return { type: "list", items: [] };
  }

  Handle_GetAttributes(args, session) {
    log.debug("[SkillMgr] GetAttributes");
    return this._buildCharacterAttributes(session);
  }

  Handle_GetSkills(args, session) {
    log.debug("[SkillMgr] GetSkills");
    return this._buildSkillsDict(session);
  }

  Handle_GetAllSkills(args, session) {
    log.debug("[SkillMgr] GetAllSkills");
    return this._buildSkillsDict(session);
  }

  Handle_IsSkillInjected(args, session) {
    const typeID = toInt(unwrapValue(args && args[0]), 0);
    return isSkillInjected(this._getCharacterId(session), typeID);
  }

  Handle_PurchaseSkills(args, session) {
    log.debug("[SkillMgr] PurchaseSkills");
    const rawSkillTypeIDs = args && args.length === 1 ? args[0] : args;
    return purchaseSkills(this._getCharacterId(session), rawSkillTypeIDs, session);
  }

  Handle_InjectSkillIntoBrain(args, session) {
    log.debug("[SkillMgr] InjectSkillIntoBrain");
    const rawItemIDs = args && args.length === 1 ? args[0] : args;
    return injectSkillbookItems(this._getCharacterId(session), rawItemIDs, session);
  }

  // skillsvc.Train sends CharStartTrainingSkill(skill.itemID, skill.locationID):
  // the skill's item id and its location, the character. It trains the next
  // level, put first in the queue.
  Handle_CharStartTrainingSkill(args, session) {
    log.debug("[SkillMgr] CharStartTrainingSkill");
    const characterID = this._getCharacterId(session);
    const itemID = toInt(unwrapValue(args && args[0]), 0);
    const skillRecord = getCharacterSkills(characterID).find((record) => toInt(record.itemID, 0) === itemID);
    const typeID = toInt(skillRecord ? skillRecord.typeID : findItemById(itemID)?.typeID, 0);
    if (typeID <= 0 || !getSkillTypeByID(typeID)) {
      return null;
    }

    const snapshot = getQueueSnapshot(characterID);
    const existingSkill = snapshot.projectedSkillMap.get(typeID);
    const targetLevel = Math.max(
      1,
      Math.min(
        5,
        Number(
          existingSkill
            ? existingSkill.trainedSkillLevel || existingSkill.skillLevel || 0
            : 0,
        ) + 1,
      ),
    );

    const nextQueue = [
      { typeID, toLevel: targetLevel },
      ...snapshot.queueEntries
        .filter(
          (entry) =>
            Number(entry.trainingTypeID || 0) !== typeID ||
            Number(entry.trainingToLevel || 0) !== targetLevel,
        )
        .map((entry) => ({
          typeID: Number(entry.trainingTypeID || 0),
          toLevel: Number(entry.trainingToLevel || 0),
        })),
    ];
    saveQueue(characterID, nextQueue, { activate: true });
    return null;
  }

  Handle_CharStopTrainingSkill(args, session) {
    log.debug("[SkillMgr] CharStopTrainingSkill");
    abortTraining(this._getCharacterId(session));
    return null;
  }

  Handle_GetRespecInfo(args, session) {
    log.debug("[SkillMgr] GetRespecInfo");
    const charData = this._getCharacterData(session);
    const respecInfo =
      charData.respecInfo && typeof charData.respecInfo === "object"
        ? charData.respecInfo
        : {};
    return {
      type: "object",
      name: "util.KeyVal",
      args: {
        type: "dict",
        entries: [
          ["freeRespecs", Number(respecInfo.freeRespecs ?? 3)],
          ["lastRespecDate", respecInfo.lastRespecDate || null],
          ["nextTimedRespec", respecInfo.nextTimedRespec || null],
        ],
      },
    };
  }

  Handle_GetSkillQueueAndFreePoints(args, session) {
    log.debug("[SkillMgr] GetSkillQueueAndFreePoints called");
    const snapshot = this._getSnapshot(session);
    return [snapshot.queuePayload, snapshot.freeSkillPoints];
  }

  Handle_GetBoosters(args, session) {
    log.debug("[SkillMgr] GetBoosters called");
    return buildCharacterBoostersDict(this._getCharacterId(session));
  }

  Handle_GetImplants(args, session) {
    log.debug("[SkillMgr] GetImplants called");
    const charData = this._getCharacterData(session);
    const implants = getActiveImplants(charData);
    return {
      type: "dict",
      entries: implants.map((entry, index) => [
        Number(entry.slot || entry.implantSlot || index + 1),
        buildKeyVal(
          Object.entries(entry || {})
            .filter(([key]) => key !== "typeEntry"),
        ),
      ]),
    };
  }

  Handle_GetFreeSkillPoints(args, session) {
    log.debug("[SkillMgr] GetFreeSkillPoints called");
    return this._getSnapshot(session).freeSkillPoints;
  }

  Handle_GetFreeSkillPointsAppliedToQueue(args, session) {
    log.debug("[SkillMgr] GetFreeSkillPointsAppliedToQueue called");
    return buildPointsDict(
      previewFreeSkillPointsApplication(this._getCharacterId(session)),
    );
  }

  Handle_GetFreeSkillPointsAppliedToSkills(args, session) {
    log.debug("[SkillMgr] GetFreeSkillPointsAppliedToSkills called");
    return buildPointsDict(
      previewFreeSkillPointsApplication(
        this._getCharacterId(session),
        normalizeSkillRequirements(args && args[0]),
      ),
    );
  }

  Handle_ApplyFreeSkillPointsToQueue(args, session) {
    log.debug("[SkillMgr] ApplyFreeSkillPointsToQueue called");
    return applyFreeSkillPointsInternal(this._getCharacterId(session)).newFreeSkillPoints;
  }

  Handle_ApplyFreeSkillPointsToSkills(args, session) {
    log.debug("[SkillMgr] ApplyFreeSkillPointsToSkills called");
    return applyFreeSkillPointsInternal(
      this._getCharacterId(session),
      normalizeSkillRequirements(args && args[0]),
    ).newFreeSkillPoints;
  }

  Handle_ApplyFreeSkillPoints(args, session) {
    log.debug("[SkillMgr] ApplyFreeSkillPoints called");
    return applyFreeSkillPoints(
      this._getCharacterId(session),
      unwrapValue(args && args[0]),
      unwrapValue(args && args[1]),
    );
  }

  Handle_SaveNewQueue(args, session, kwargs) {
    log.debug("[SkillMgr] SaveNewQueue called");
    saveQueue(
      this._getCharacterId(session),
      normalizeQueueInput(args && args[0]),
      {
        activate: readBooleanKwarg(kwargs, "activate", true),
      },
    );
    return null;
  }

  Handle_AbortTraining(args, session) {
    log.debug("[SkillMgr] AbortTraining called");
    abortTraining(this._getCharacterId(session));
    return null;
  }

  Handle_InjectSkillpoints(args, session) {
    log.debug("[SkillMgr] InjectSkillpoints called");
    return injectSkillPoints(
      this._getCharacterId(session),
      toInt(unwrapValue(args && args[0]), 0),
      toInt(unwrapValue(args && args[1]), 1),
      session,
    );
  }

  Handle_CheckInjectionConstraints(args, session) {
    log.debug("[SkillMgr] CheckInjectionConstraints called");
    checkInjectionConstraints(
      this._getCharacterId(session),
      toInt(unwrapValue(args && args[0]), 0),
      toInt(unwrapValue(args && args[1]), 1),
      session,
    );
    return null;
  }

  Handle_GetDiminishedSpFromInjectors(args, session) {
    log.debug("[SkillMgr] GetDiminishedSpFromInjectors called");
    return getDiminishedSpFromInjectors(
      this._getCharacterId(session),
      toInt(unwrapValue(args && args[0]), 0),
      toInt(unwrapValue(args && args[1]), 1),
      toInt(unwrapValue(args && args[2]), 0),
    );
  }

  Handle_ExtractSkills(args, session) {
    log.debug("[SkillMgr] ExtractSkills called");
    return extractSkills(
      this._getCharacterId(session),
      args && args[0],
      toInt(unwrapValue(args && args[1]), 0),
      session,
    );
  }

  Handle_SplitSkillInjector(args, session) {
    log.debug("[SkillMgr] SplitSkillInjector called");
    return splitSkillInjector(
      this._getCharacterId(session),
      toInt(unwrapValue(args && args[0]), 0),
      toInt(unwrapValue(args && args[1]), 1),
      session,
    );
  }

  Handle_CombineSkillInjector(args, session) {
    log.debug("[SkillMgr] CombineSkillInjector called");
    return combineSkillInjector(
      this._getCharacterId(session),
      toInt(unwrapValue(args && args[0]), 0),
      toInt(unwrapValue(args && args[1]), 1),
      session,
    );
  }

  Handle_CheckAndSendNotifications(args, session) {
    log.debug("[SkillMgr] CheckAndSendNotifications called");
    return { type: "list", items: [] };
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    log.debug("[SkillMgr] MachoResolveObject called");
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    const config = require(path.join(__dirname, "../../config"));
    const bindParams = args && args.length > 0 ? args[0] : null;
    const nestedCall = args && args.length > 1 ? args[1] : null;

    log.debug(
      `[SkillMgr] MachoBindObject args.length=${args ? args.length : 0} bindParams=${JSON.stringify(bindParams, (k, v) => (typeof v === "bigint" ? v.toString() : v))} nestedCall=${JSON.stringify(nestedCall, (k, v) => (typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? v.toString("utf8") : v))}`,
    );

    const boundId = config.getNextBoundId();
    const idString = `N=${PROXY_NODE_ID}:${boundId}`;
    const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
    const oid = [idString, now];

    let callResult = null;
    if (nestedCall && Array.isArray(nestedCall) && nestedCall.length >= 1) {
      const methodName =
        typeof nestedCall[0] === "string"
          ? nestedCall[0]
          : Buffer.isBuffer(nestedCall[0])
            ? nestedCall[0].toString("utf8")
            : String(nestedCall[0]);
      const callArgs = nestedCall.length > 1 ? nestedCall[1] : [];
      const callKwargs = nestedCall.length > 2 ? nestedCall[2] : null;

      log.debug(`[SkillMgr] MachoBindObject nested call: ${methodName}`);
      callResult = this.callMethod(
        methodName,
        Array.isArray(callArgs) ? callArgs : [callArgs],
        session,
        callKwargs,
      );
    }

    return [
      {
        type: "substruct",
        value: { type: "substream", value: oid },
      },
      callResult != null ? callResult : null,
    ];
  }
}

module.exports = SkillMgrService;
