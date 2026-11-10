"use strict";

/**
 * Character Manager Service (charMgr)
 *
 * Handles character info queries post-selection.
 * Different from charUnboundMgr — this is bound to a specific character.
 */

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  getCharacterRecord,
  resolveHomeStationInfo,
  updateCharacterRecord,
} = require(path.join(__dirname, "./characterState"));
const {
  resolvePaperDollState,
} = require(path.join(__dirname, "./paperDollPayloads"));
const {
  normalizeCharacterGender,
} = require(path.join(__dirname, "./characterIdentity"));
const {
  getStationRecord,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  buildList,
  buildDict,
  extractList,
  buildFiletimeLong,
  buildKeyVal,
  buildNamedObject,
  buildRow,
  buildRowset,
  buildDbRowset,
  extractDictEntries,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal } = require(path.join(
  __dirname,
  "../../network/tcp/utils/marshal",
));
const {
  CharMgrGlobalAssets,
} = require(path.join(__dirname, "./charMgrGlobalAssets"));
const { getCharacterCreationSchool } = require(path.join(__dirname, "./characterCreationData"));
const {
  deleteCharacterSetting,
  getCharacterSettings,
  setCharacterSetting,
} = require(path.join(__dirname, "./characterSettingsState"));
const {
  getCorporationMember,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  getNpcCharacterRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  addLabelMask,
  allocateNextLabelID,
  removeLabelMask,
  toLabelKey,
  toMarshalMaskValue,
  toStoredMaskValue,
} = require(path.join(__dirname, "../corporation/contactLabelState"));
const {
  buildKillmailPayload,
  listKillmailsForCharacter,
} = require(path.join(__dirname, "../killmail/killmailState"));
const {
  listOwnerNotes,
  getOwnerNote,
  addOwnerNote,
  editOwnerNote,
  removeOwnerNote,
  getEntityNote,
  setEntityNote,
} = require(path.join(__dirname, "./characterNoteState"));
const { createNotification } = require(path.join(__dirname, "../notifications/notificationState"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));

function resolveCharacterInfo(args, session) {
  const charId =
    args && args.length > 0 ? args[0] : session ? session.characterID : 0;

  return {
    charId,
    charData: getCharacterRecord(charId) || {},
  };
}

// A character's settings as Tranquility answers GetCharacterSettings: a
// utillib.KeyVal whose fields are the settings, each a unicode string under its
// key, with a __doc__ of the answer's own beside them. The client's character
// settings service reads, sets and deletes them by key
// (eve/client/script/ui/services/characterSettingsSvc.py 31 to 58).
function buildCharacterSettingsAnswer(settings) {
  return buildNamedObject("utillib.KeyVal", [
    ...Object.entries(settings && typeof settings === "object" ? settings : {})
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([settingKey, value]) => [
        settingKey,
        typeof value === "string" ? { type: "wstring", value } : value,
      ]),
    ["__doc__", "Settings KeyVal/Dictionary"],
  ]);
}

function sessionCharacterID(session) {
  return Number(
    session &&
    (session.characterID || session.charID || session.charid || 0),
  ) || 0;
}

function normalizeInteger(value, fallback = 0) {
  const unwrapped = unwrapMarshalValue(value);
  const numeric = Number(unwrapped);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

/**
 * A contact label's color as the client gives it: none where it gives none. The client's address book makes and
 * renames its labels with no color (addressbookService.py CreateContactLabel, 1015 to 1020, keeping None as the
 * label's; RenameContactLabelFromUI, 990 to 999, by EditContactLabel(labelID, name=name)), and draws a label with
 * none in the list's own color (GetLabelText, 1189 to 1202).
 */
function normalizeLabelColor(value) {
  const unwrapped = unwrapMarshalValue(value);
  return unwrapped === undefined || unwrapped === null ? null : normalizeInteger(unwrapped, 0);
}

function normalizeBoolean(value, fallback = false) {
  const unwrapped = unwrapMarshalValue(value);
  if (unwrapped === undefined || unwrapped === null) {
    return fallback;
  }
  if (typeof unwrapped === "string") {
    const normalized = unwrapped.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
    if (normalized === "true" || normalized === "1") {
      return true;
    }
  }
  return Boolean(unwrapped);
}

function extractKwarg(kwargs, key) {
  // A decoded dict key keeps the form the wire used, and `extraInfo` and `status` sit outside
  // the marshal string table, so they arrive as raw Buffers and a raw comparison
  // drops them. See the note on accountService.extractKwarg.
  return extractDictEntries(kwargs).find(
    ([entryKey]) => strVal(entryKey) === key,
  )?.[1];
}

function normalizePersonalContacts(record = {}) {
  const source =
    record.personalContacts && typeof record.personalContacts === "object"
      ? record.personalContacts
      : {};
  const contacts = {};

  for (const [rawContactID, rawContact] of Object.entries(source)) {
    const contactID = normalizeInteger(
      rawContact && rawContact.contactID !== undefined
        ? rawContact.contactID
        : rawContactID,
      0,
    );
    if (!(contactID > 0)) {
      continue;
    }
    contacts[String(contactID)] = {
      contactID,
      inWatchlist: normalizeBoolean(rawContact && rawContact.inWatchlist, false),
      relationshipID: normalizeInteger(rawContact && rawContact.relationshipID, 0),
      labelMask: toStoredMaskValue(rawContact && rawContact.labelMask),
    };
  }

  return contacts;
}

function normalizePersonalContactLabels(record = {}) {
  const source =
    record.personalContactLabels && typeof record.personalContactLabels === "object"
      ? record.personalContactLabels
      : {};
  const labels = {};

  for (const [rawLabelID, rawLabel] of Object.entries(source)) {
    const labelKey = toLabelKey(rawLabelID, null);
    if (!labelKey) {
      continue;
    }
    const label = rawLabel && typeof rawLabel === "object" ? rawLabel : {};
    labels[labelKey] = {
      name: toPlainString(label.name, ""),
      color: normalizeLabelColor(label.color),
    };
  }

  return labels;
}

function normalizeBlockedOwners(record = {}) {
  const source =
    record.blockedOwners && typeof record.blockedOwners === "object"
      ? record.blockedOwners
      : {};
  const blocked = {};

  for (const [rawOwnerID, rawBlocked] of Object.entries(source)) {
    const ownerID = normalizeInteger(
      rawBlocked && rawBlocked.senderID !== undefined
        ? rawBlocked.senderID
        : rawBlocked && rawBlocked.contactID !== undefined
          ? rawBlocked.contactID
          : rawOwnerID,
      0,
    );
    if (ownerID > 0) {
      blocked[String(ownerID)] = {
        senderID: ownerID,
      };
    }
  }

  return blocked;
}

/** GetContactList's two CRowsets' columns and their DB types, as Tranquility's descriptors have them. */
const CONTACT_DBROW_COLUMNS = Object.freeze([
  ["contactID", 0x03],
  ["inWatchlist", 0x0b],
  ["relationshipID", 0x05],
  ["labelMask", 0x14],
]);
const BLOCKED_DBROW_COLUMNS = Object.freeze([["senderID", 0x03]]);

function buildContactRow(contact) {
  return [
    normalizeInteger(contact && contact.contactID, 0),
    normalizeBoolean(contact && contact.inWatchlist, false) ? 1 : 0,
    normalizeInteger(contact && contact.relationshipID, 0),
    toMarshalMaskValue(contact && contact.labelMask),
  ];
}

function buildContactLabelKeyVal(labelID, label) {
  return buildKeyVal([
    ["labelID", toMarshalMaskValue(labelID)],
    ["name", toPlainString(label && label.name, "")],
    ["color", normalizeLabelColor(label && label.color)],
  ]);
}

function buildBlockedRow(blocked) {
  const ownerID = normalizeInteger(
    blocked && (blocked.senderID ?? blocked.contactID),
    0,
  );
  return [ownerID];
}

function upsertPersonalContact(characterID, contactID, options = {}) {
  const normalizedContactID = normalizeInteger(contactID, 0);
  if (!(normalizedContactID > 0)) {
    return { success: false, errorMsg: "CONTACT_REQUIRED" };
  }

  let stagedCareer = false;
  const updated = updateCharacterRecord(characterID, (record) => {
    // A retry may see the accepted contact in the cache after a refused flush.
    // Fence its already staged evidence before acknowledging that retry.
    stagedCareer = Number(record.careerActivityEvidence?.metrics?.["social:contact"]?.value) > 0;
    const contacts = normalizePersonalContacts(record);
    const isNewPlayerContact = !contacts[String(normalizedContactID)] &&
      Number(characterID) !== normalizedContactID && getCharacterRecord(normalizedContactID);
    const existing = contacts[String(normalizedContactID)] || {
      contactID: normalizedContactID,
      inWatchlist: false,
      relationshipID: 0,
      labelMask: 0,
    };
    contacts[String(normalizedContactID)] = {
      contactID: normalizedContactID,
      inWatchlist:
        options.inWatchlist !== undefined
          ? normalizeBoolean(options.inWatchlist, false)
          : normalizeBoolean(existing.inWatchlist, false),
      relationshipID:
        options.relationshipID !== undefined
          ? normalizeInteger(options.relationshipID, 0)
          : normalizeInteger(existing.relationshipID, 0),
      labelMask: toStoredMaskValue(existing.labelMask),
    };
    record.personalContacts = contacts;
    if (isNewPlayerContact) {
      const staged = require("../career/careerEventLedger").stageCharacter(record, characterID,
        { kind: "social", action: "contact", id: "contact:added-player" });
      if (!staged.success) throw new Error(staged.errorMsg || "CAREER_CONTACT_EVIDENCE_FAILED");
      stagedCareer = true;
      return staged.data.record;
    }
    return record;
  });
  if (updated?.success && stagedCareer) {
    const flushed = require("../../gameStore").flushTableSync("characters");
    if (!flushed?.success) return flushed || { success: false, errorMsg: "CAREER_CONTACT_FLUSH_FAILED" };
    require("../career/careerEventLedger").publishCommitted(characterID);
  }
  return updated;
}

function removePersonalContacts(characterID, contactIDs = []) {
  return updateCharacterRecord(characterID, (record) => {
    const contacts = normalizePersonalContacts(record);
    for (const contactID of contactIDs.map((value) => normalizeInteger(value, 0))) {
      delete contacts[String(contactID)];
    }
    record.personalContacts = contacts;
    return record;
  });
}

function updateBlockedOwners(characterID, ownerIDs = [], shouldBlock = true) {
  return updateCharacterRecord(characterID, (record) => {
    const blockedOwners = normalizeBlockedOwners(record);
    for (const ownerID of ownerIDs.map((value) => normalizeInteger(value, 0))) {
      if (!(ownerID > 0)) {
        continue;
      }
      if (shouldBlock) {
        blockedOwners[String(ownerID)] = {
          senderID: ownerID,
        };
      } else {
        delete blockedOwners[String(ownerID)];
      }
    }
    record.blockedOwners = blockedOwners;
    return record;
  });
}

function resolveHomeStationRecord(charData, session) {
  const homeStationInfo = resolveHomeStationInfo(charData, session);

  return {
    station: getStationRecord(session, homeStationInfo.homeStationID),
    homeStationInfo,
  };
}

/** The session, where the character asked of is its own: what another's public info may never be filled from. */
function ownSession(charId, session) {
  return session && sessionCharacterID(session) === Number(charId) ? session : null;
}

/** A static data date ("YYYY-MM-DD hh:mm:ss", UTC) as a FILETIME, or null. */
function filetimeOfStaticDate(text) {
  const milliseconds = typeof text === "string" ? Date.parse(`${text.replace(" ", "T")}Z`) : Number.NaN;
  return Number.isFinite(milliseconds)
    ? (BigInt(milliseconds) + 11644473600000n) * 10000n
    : null;
}

// The character a public info call names: the store's record of it, else, for an NPC character (a CEO, an agent),
// its row of the static data: its name, bloodline, race, corporation, gender and its start there.
function resolvePublicCharacterInfo(args, session) {
  const { charId, charData } = resolveCharacterInfo(args, session);
  if (Object.keys(charData).length > 0) {
    return { charId, charData };
  }
  const npc = getNpcCharacterRecord(charId);
  if (!npc) {
    return { charId, charData };
  }
  const started = filetimeOfStaticDate(npc.startDate);
  return {
    charId,
    charData: {
      characterName: npc.characterName,
      bloodlineID: npc.bloodlineID,
      raceID: npc.raceID,
      corporationID: npc.corporationID,
      gender: npc.gender,
      ...(started !== null ? { startDateTime: started, createDateTime: started } : {}),
    },
  };
}

/** When the character joined its corporation: its member row's start, else its own start, its employment or its creation. */
function corporationStartOf(charId, charData, session) {
  const corporationID =
    Number(charData && charData.corporationID) ||
    Number(session && (session.corporationID || session.corpid)) ||
    0;
  const corporationMember =
    corporationID > 0 ? getCorporationMember(corporationID, charId) : null;
  return (corporationMember && corporationMember.startDate) ||
    (charData &&
      (charData.startDateTime ||
        (Array.isArray(charData.employmentHistory)
          ? charData.employmentHistory.find(
              (entry) =>
                Number(entry && entry.corporationID) === Number(corporationID),
            )?.startDate
          : null) ||
        charData.createDateTime)) ||
    null;
}

// charMgr.GetPublicInfo3(charID), as Tranquility answers it (the retail client's cache of the call): a CRowset of
// one row, its join to its corporation as startDateTime. The client's character window reads its description, its
// start and its militia (characterInfoWindow construct_header_character), its bloodline (its caption).
const PUBLIC_INFO3_COLUMNS = [
  ["bounty", 0x06],
  ["title", 0x82],
  ["startDateTime", 0x40],
  ["description", 0x82],
  ["corporationID", 0x03],
  ["militiaFactionID", 0x03],
  ["bloodlineID", 0x11],
];

function buildPublicInfo3Rowset(charId, charData, session) {
  const own = ownSession(charId, session);
  const corporationID =
    charData.corporationID || (own ? own.corporationID : 1000009);
  const started = buildFiletimeLong(corporationStartOf(charId, charData, own));
  return buildDbRowset(
    PUBLIC_INFO3_COLUMNS,
    [[
      Number(charData.bounty || 0),
      charData.title || "",
      started && typeof started === "object" ? String(started.value) : "0",
      charData.description || "",
      corporationID,
      charData.militiaFactionID ?? charData.warFactionID ?? null,
      charData.bloodlineID || 1,
    ]],
    "carbon.common.script.sys.crowset.CRowset",
  );
}

// charMgr.GetPublicInfo(charID), as Tranquility answers it (a recording of 2026-07-03, charMgr::GetPublicInfo[Cached]):
// a util.KeyVal of these seventeen. The client's character sheet reads its race, bloodline, ancestry, school and
// creation (characterOverviewPanel); the Standings tab its corporation (panelStandings 120).
function buildPublicInfoKeyVal(charId, charData, session) {
  const own = ownSession(charId, session);
  const corporationID =
    charData.corporationID || (own ? own.corporationID : 1000009);
  const allianceID = charData.allianceID || (own && own.allianceID) || null;
  const school = charData.schoolID ? getCharacterCreationSchool(charData.schoolID) : null;
  const careerID = charData.careerID ?? (school && school.careerID) ?? null;
  return buildKeyVal([
    ["characterID", charId],
    [
      "characterName",
      charData.characterName || (own ? own.characterName : "Unknown"),
    ],
    ["typeID", charData.typeID || 1373],
    ["raceID", charData.raceID || 1],
    ["bloodlineID", charData.bloodlineID || 1],
    ["ancestryID", charData.ancestryID || 1],
    ["schoolID", charData.schoolID ?? null],
    ["careerID", careerID],
    ["careerSpecialityID", charData.careerSpecialityID ?? careerID],
    ["gender", Boolean(normalizeCharacterGender(charData.gender, 1))],
    ["createDateTime", buildFiletimeLong(charData.createDateTime)],
    ["corporationID", corporationID],
    ["corporationDateTime", buildFiletimeLong(corporationStartOf(charId, charData, own))],
    ["allianceID", allianceID],
    ["warFactionID", charData.warFactionID ?? charData.militiaFactionID ?? null],
    ["age", 0],
    ["description", charData.description || ""],
  ]);
}

function resolveCorporationChangeInfo(charId, charData, session) {
  const corporationID =
    Number(charData && charData.corporationID) ||
    Number(session && (session.corporationID || session.corpid)) ||
    0;
  const corporationMember =
    corporationID > 0 ? getCorporationMember(corporationID, charId) : null;
  const corporationDateTime =
    (corporationMember && corporationMember.startDate) ||
    (charData &&
      (charData.startDateTime ||
        (Array.isArray(charData.employmentHistory)
          ? charData.employmentHistory.find(
              (entry) =>
                Number(entry && entry.corporationID) === Number(corporationID),
            )?.startDate
          : null) ||
        charData.createDateTime)) ||
    null;

  return buildKeyVal([
    ["corporationID", corporationID || null],
    ["corporationDateTime", buildFiletimeLong(corporationDateTime)],
  ]);
}

function buildHomeStationPayload(station, homeStationInfo = {}) {
  return buildKeyVal([
    ["id", station.stationID],
    ["station_id", station.stationID],
    ["stationID", station.stationID],
    ["home_station_id", station.stationID],
    ["type_id", station.stationTypeID],
    ["typeID", station.stationTypeID],
    ["station_type_id", station.stationTypeID],
    ["name", station.stationName],
    ["station_name", station.stationName],
    ["stationName", station.stationName],
    ["solar_system_id", station.solarSystemID],
    ["solarSystemID", station.solarSystemID],
    ["constellation_id", station.constellationID],
    ["constellationID", station.constellationID],
    ["region_id", station.regionID],
    ["regionID", station.regionID],
    ["owner_id", station.ownerID],
    ["ownerID", station.ownerID],
    ["clone_station_id", homeStationInfo.cloneStationID || station.stationID],
    ["cloneStationID", homeStationInfo.cloneStationID || station.stationID],
    ["is_fallback", Boolean(homeStationInfo.isFallback)],
    ["isFallback", Boolean(homeStationInfo.isFallback)],
    ["stationTypeID", station.stationTypeID],
  ]);
}

function buildCloneEntries(entries = [], valueBuilder) {
  return buildDict(
    entries.map((entry, index) => [
      Number(entry.cloneID || entry.itemID || index + 1),
      valueBuilder(entry, index),
    ]),
  );
}

function toPlainString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (typeof value === "object") {
    if ("value" in value) {
      return toPlainString(value.value, fallback);
    }

    if ("str" in value) {
      return toPlainString(value.str, fallback);
    }
  }

  return fallback;
}

function buildOwnerNotePayload(noteID, label, noteText) {
  return buildList([
    buildKeyVal([
      ["noteID", Number(noteID) || 0],
      ["label", toPlainString(label, "")],
      ["note", toPlainString(noteText, "")],
    ]),
  ]);
}

class CharMgrService extends BaseService {
  constructor() {
    super("charMgr");
    this._globalAssets = new CharMgrGlobalAssets();
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    const result = this._globalAssets.Handle_MachoResolveObject(args, session, kwargs);
    if (result !== null) {
      return result;
    }

    log.warn("[CharMgr] Unsupported MachoResolveObject bind params");
    return null;
  }

  async Handle_MachoBindObject(args, session, kwargs) {
    const result = await this._globalAssets.Handle_MachoBindObject(
      args,
      session,
      kwargs,
      async (boundObjectID, methodName, callArgs, callKwargs) => {
        const previousBoundObjectID = session ? session.currentBoundObjectID : null;
        try {
          if (session) {
            session.currentBoundObjectID = boundObjectID;
          }
          return await this.callMethod(methodName, callArgs, session, callKwargs);
        } finally {
          if (session) {
            session.currentBoundObjectID = previousBoundObjectID || null;
          }
        }
      },
    );
    if (result !== null) {
      return result;
    }

    log.warn("[CharMgr] Unsupported MachoBindObject bind params");
    return null;
  }

  Handle_ListStations(args, session, kwargs) {
    return this._globalAssets.Handle_ListStations(args, session, kwargs);
  }

  Handle_ListStationItems(args, session, kwargs) {
    return this._globalAssets.Handle_ListStationItems(args, session, kwargs);
  }

  Handle_List(args, session, kwargs) {
    return this._globalAssets.Handle_List(args, session, kwargs);
  }

  Handle_ListIncludingContainers(args, session, kwargs) {
    return this._globalAssets.Handle_ListIncludingContainers(args, session, kwargs);
  }

  Handle_GetAssetWorth(args, session, kwargs) {
    return this._globalAssets.Handle_GetAssetWorth(args, session, kwargs);
  }

  Handle_GetPublicInfo(args, session) {
    const { charId, charData } = resolvePublicCharacterInfo(args, session);
    log.debug(`[CharMgr] GetPublicInfo(${charId})`);
    return buildPublicInfoKeyVal(charId, charData, session);
  }

  Handle_GetPublicInfo3(args, session) {
    const { charId, charData } = resolvePublicCharacterInfo(args, session);
    log.debug(`[CharMgr] GetPublicInfo3(${charId})`);
    return buildPublicInfo3Rowset(charId, charData, session);
  }

  Handle_GetOrganizationInfoForCharacters(args) {
    const characterIDs = extractList(args && args[0])
      .map((characterID) => Number(characterID) || 0)
      .filter((characterID) => characterID > 0);
    log.debug(`[CharMgr] GetOrganizationInfoForCharacters(${characterIDs.length})`);
    return buildDict(
      characterIDs.map((characterID) => {
        const character = getCharacterRecord(characterID) || {};
        return [
          characterID,
          buildKeyVal([
            ["corporationID", Number(character.corporationID) || 0],
            ["allianceID", Number(character.allianceID) || 0],
            [
              "warFactionID",
              Number(character.warFactionID ?? character.militiaFactionID) || 0,
            ],
          ]),
        ];
      }),
    );
  }

  Handle_GetTopBounties() {
    log.debug("[CharMgr] GetTopBounties");
    return { type: "list", items: [] };
  }

  Handle_GetCohortsForCharacter(args, session) {
    const charId = sessionCharacterID(session);
    log.debug(`[CharMgr] GetCohortsForCharacter(${charId || "unknown"})`);
    return buildList([]);
  }

  Handle_GetRecentShipKillsAndLosses(args, session) {
    const charId =
      (session && Number(session.currentBoundObjectID || 0)) ||
      (session && Number(session.characterID || session.charid || 0)) ||
      0;
    const limit = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const startKillID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    return {
      type: "list",
      items: listKillmailsForCharacter(charId, {
        limit,
        startKillID,
      }).map((record) => buildKillmailPayload(record)),
    };
  }

  Handle_GetPrivateInfo(args, session) {
    log.debug("[CharMgr] GetPrivateInfo");
    const { charId, charData } = resolveCharacterInfo(args, session);
    return buildRow(
      [
        "characterID",
        "gender",
        "createDateTime",
        "raceID",
        "bloodlineID",
        "ancestryID",
        "balance",
        "securityRating",
      ],
      [
        charId,
        normalizeCharacterGender(charData.gender, 1),
        buildFiletimeLong(charData.createDateTime),
        charData.raceID || 1,
        charData.bloodlineID || 1,
        charData.ancestryID || 1,
        Number(charData.balance ?? 0),
        Number(charData.securityStatus ?? charData.securityRating ?? 0),
      ],
    );
  }

  Handle_GetPrivateInfoOnCorpChange(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    log.debug(`[CharMgr] GetPrivateInfoOnCorpChange(${charId})`);
    return buildCachedMethodCallResult(
      resolveCorporationChangeInfo(charId, charData, session),
      {
        serviceName: this.name,
        method: "GetPrivateInfoOnCorpChange",
        args,
        sessionInfo: "charid",
        sessionInfoValue: charId,
      },
    );
  }

  Handle_GetCharacterDescription(args, session) {
    const { charData } = resolveCharacterInfo(args, session);
    log.debug("[CharMgr] GetCharacterDescription");
    return charData.description || "";
  }

  Handle_GetCloneInfo(args, session) {
    log.debug("[CharMgr] GetCloneInfo");
    const { charData } = resolveCharacterInfo(args, session);
    const { station, homeStationInfo } = resolveHomeStationRecord(charData, session);

    return buildKeyVal([
      ["homeStationID", station.stationID],
      [
        "cloneStationID",
        Number(homeStationInfo.cloneStationID || station.stationID) || station.stationID,
      ],
      [
        "clones",
        buildCloneEntries(charData.jumpClones || [], (entry) =>
          buildKeyVal([
            ["cloneID", Number(entry.cloneID || 0)],
            ["name", entry.name || station.stationName],
            ["stationID", Number(entry.stationID || station.stationID)],
            ["solarSystemID", Number(entry.solarSystemID || station.solarSystemID)],
          ]),
        ),
      ],
      [
        "implants",
        buildCloneEntries(charData.implants || [], (entry) =>
          buildKeyVal([
            ["typeID", Number(entry.typeID || 0)],
            ["name", entry.name || ""],
            ["slot", Number(entry.slot || 0)],
          ]),
        ),
      ],
      ["timeLastJump", buildFiletimeLong(charData.timeLastCloneJump || 0n)],
    ]);
  }

  Handle_GetHomeStation(args, session) {
    log.debug("[CharMgr] GetHomeStation");
    const { charData } = resolveCharacterInfo(args, session);
    const { station, homeStationInfo } = resolveHomeStationRecord(charData, session);
    return buildHomeStationPayload(station, homeStationInfo);
  }

  Handle_GetHomeStationRow(args, session) {
    log.debug("[CharMgr] GetHomeStationRow");

    // V23.02 mapView.py calls:
    //   homeStationRow = sm.GetService('charactersheet').GetHomeStationRow()
    // and then reads:
    //   homeStationRow.stationID
    //   homeStationRow.solarSystemID
    //   homeStationRow.stationTypeID
    //
    // Returning None crashes StarMap with:
    //   AttributeError: 'NoneType' object has no attribute 'stationID'
    //
    // The existing home-station KeyVal payload already exposes those fields,
    // so reuse it for the row-style call.
    return this.Handle_GetHomeStation(args, session);
  }

  Handle_getHomeStationRow(args, session) {
    return this.Handle_GetHomeStationRow(args, session);
  }

  Handle_get_home_station_row(args, session) {
    return this.Handle_GetHomeStationRow(args, session);
  }

  Handle_LogStartOfCharacterCreation() {
    log.debug("[CharMgr] LogStartOfCharacterCreation");
    return null;
  }

  // Paperdoll.State:
  // 0=NoRecustomization, 1=Resculpting, 2=NoExistingCustomization,
  // 3=FullRecustomizing, 4=ForceRecustomize
  Handle_GetPaperdollState(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    const paperDollState = resolvePaperDollState(charData, 2);
    log.debug(`[CharMgr] GetPaperdollState(${charId}) -> ${paperDollState}`);
    return paperDollState;
  }

  Handle_GetCharacterCreationDate(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    log.debug(`[CharMgr] GetCharacterCreationDate(${charId})`);
    return buildFiletimeLong(charData.createDateTime);
  }

  Handle_GetCharacterSettings(args, session) {
    log.debug("[CharMgr] GetCharacterSettings called");
    const characterID = sessionCharacterID(session);
    return buildCharacterSettingsAnswer(getCharacterSettings(characterID));
  }

  Handle_GetSettingsInfo() {
    log.debug("[CharMgr] GetSettingsInfo called");
    const py2codeHex =
      "630000000000000000010000004300000073040000006900005328010000004e280000000028000000002800000000280000000073080000003c737472696e673e740100000066010000007300000000";
    return [Buffer.from(py2codeHex, "hex"), 0];
  }

  Handle_GetContactList(args, session) {
    log.debug("[CharMgr] GetContactList called");
    const characterID = sessionCharacterID(session);
    const character = getCharacterRecord(characterID) || {};
    const contacts = Object.values(normalizePersonalContacts(character)).sort(
      (left, right) => Number(left.contactID) - Number(right.contactID),
    );
    const blockedOwners = Object.values(normalizeBlockedOwners(character)).sort(
      (left, right) => Number(left.senderID) - Number(right.senderID),
    );
    // As Tranquility answers it (the client's log of a login, 2026-07-11: charMgr::GetContactList, retval KeyVal
    // {'addresses': [<DBRow object [3009846, False, 0.0, 0L]>], 'blocked': []}): each a CRowset of DBRows, the
    // addresses' contactID an int, inWatchlist a bool, relationshipID a float and labelMask a long, the blocked
    // senderID an int. The client's address book reads each row by its names (addressbookService.py 222 to 238).
    return buildKeyVal([
      [
        "addresses",
        buildDbRowset(
          CONTACT_DBROW_COLUMNS,
          contacts.map((contact) => buildContactRow(contact)),
          "carbon.common.script.sys.crowset.CRowset",
        ),
      ],
      [
        "blocked",
        buildDbRowset(
          BLOCKED_DBROW_COLUMNS,
          blockedOwners.map((blocked) => buildBlockedRow(blocked)),
          "carbon.common.script.sys.crowset.CRowset",
        ),
      ],
    ]);
  }

  Handle_GetLabels(args, session) {
    const characterID = sessionCharacterID(session);
    const character = getCharacterRecord(characterID) || {};
    const labels = normalizePersonalContactLabels(character);
    return buildDict(
      Object.entries(labels).map(([labelID, label]) => [
        toMarshalMaskValue(labelID),
        buildContactLabelKeyVal(labelID, label),
      ]),
    );
  }

  Handle_CreateLabel(args, session) {
    const characterID = sessionCharacterID(session);
    const name = toPlainString(args && args[0], "").trim();
    const color = normalizeLabelColor(args && args[1]);
    let labelID = null;
    updateCharacterRecord(characterID, (record) => {
      const labels = normalizePersonalContactLabels(record);
      const meta =
        record.personalContactLabelMeta &&
        typeof record.personalContactLabelMeta === "object"
          ? { ...record.personalContactLabelMeta }
          : {};
      const allocation = allocateNextLabelID(labels, meta.nextLabelID || 1);
      labelID = allocation.labelID;
      labels[allocation.labelKey] = { name, color };
      meta.nextLabelID = allocation.nextLabelID;
      record.personalContactLabels = labels;
      record.personalContactLabelMeta = meta;
      return record;
    });
    return labelID;
  }

  Handle_DeleteLabel(args, session) {
    const characterID = sessionCharacterID(session);
    const labelKey = toLabelKey(args && args[0], null);
    if (!labelKey) {
      return null;
    }
    updateCharacterRecord(characterID, (record) => {
      const labels = normalizePersonalContactLabels(record);
      const contacts = normalizePersonalContacts(record);
      delete labels[labelKey];
      for (const contact of Object.values(contacts)) {
        contact.labelMask = removeLabelMask(contact.labelMask, labelKey);
      }
      record.personalContactLabels = labels;
      record.personalContacts = contacts;
      return record;
    });
    return null;
  }

  /**
   * EditLabel(labelID, name, color), as the client's EditContactLabel sends it (addressbookService.py 1001 to 1013):
   * what it gives none of is left as it is, as the client leaves its own copy (a rename gives no color).
   */
  Handle_EditLabel(args, session) {
    const characterID = sessionCharacterID(session);
    const labelKey = toLabelKey(args && args[0], null);
    if (!labelKey) {
      return null;
    }
    const given = (place) => {
      const value = args && args.length > place ? unwrapMarshalValue(args[place]) : undefined;
      return value === undefined || value === null ? undefined : value;
    };
    const name = given(1) === undefined ? undefined : toPlainString(args[1], "");
    const color = given(2) === undefined ? undefined : normalizeLabelColor(args[2]);
    updateCharacterRecord(characterID, (record) => {
      const labels = normalizePersonalContactLabels(record);
      const label = labels[labelKey] || { name: "", color: null };
      if (name !== undefined) {
        label.name = name;
      }
      if (color !== undefined) {
        label.color = color;
      }
      labels[labelKey] = label;
      record.personalContactLabels = labels;
      return record;
    });
    return null;
  }

  /**
   * AssignLabels(contactIDs, labelMask): the label's bits given to those of them that are the pilot's contacts. One
   * that is not is no contact of the pilot's by it: the client asks it for one not in its address book and then, for
   * a single one, opens Contact Management to add it with that label chosen, and gives the label up where that is
   * cancelled (addressbookService.py AssignLabelFromWnd, 1096 to 1125; AddToAddressBook, 705 to 816).
   */
  Handle_AssignLabels(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCharacterRecord(characterID, (record) => {
      const contacts = normalizePersonalContacts(record);
      for (const rawContactID of contactIDs) {
        const contact = contacts[String(normalizeInteger(rawContactID, 0))];
        if (contact) {
          contact.labelMask = addLabelMask(contact.labelMask, labelMask);
        }
      }
      record.personalContacts = contacts;
      return record;
    });
    return null;
  }

  Handle_RemoveLabels(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCharacterRecord(characterID, (record) => {
      const contacts = normalizePersonalContacts(record);
      for (const rawContactID of contactIDs) {
        const contactID = normalizeInteger(rawContactID, 0);
        if (contacts[String(contactID)]) {
          contacts[String(contactID)].labelMask = removeLabelMask(
            contacts[String(contactID)].labelMask,
            labelMask,
          );
        }
      }
      record.personalContacts = contacts;
      return record;
    });
    return null;
  }

  Handle_AddContact(args, session) {
    return this._addOrEditContact(args, session, NOTIFICATION_TYPE.CONTACT_ADD);
  }

  Handle_EditContact(args, session) {
    return this._addOrEditContact(args, session, NOTIFICATION_TYPE.CONTACT_EDIT);
  }

  /**
   * AddContact and EditContact(contactID, relationshipID, inWatchlist, sendNotification, message), as the client's
   * address book sends them (addressbookService.py AddToAddressBook, 705 to 816). Where the pilot asks it, the
   * contact is told: a notification of the contacts' group, added (89) or edited (90), from the pilot, its data the
   * standing given and the message (contactFormatters.py MakeData: {level, message}). Only another player's
   * character is told.
   */
  _addOrEditContact(args, session, notificationTypeID) {
    const characterID = sessionCharacterID(session);
    const contactID = normalizeInteger(args && args[0], 0);
    const relationshipID =
      args && args.length > 1 ? normalizeInteger(args[1], 0) : 0;
    const inWatchlist =
      args && args.length > 2 ? normalizeBoolean(args[2], false) : false;
    const sendNotification =
      args && args.length > 3 ? normalizeBoolean(args[3], false) : false;
    const message = args && args.length > 4 ? toPlainString(args[4], "") : "";
    log.debug(`[CharMgr] ${notificationTypeID === NOTIFICATION_TYPE.CONTACT_EDIT ? "EditContact" : "AddContact"}(${characterID}, ${contactID})`);
    const result = upsertPersonalContact(characterID, contactID, {
      relationshipID,
      inWatchlist,
    });
    if (result?.success === false) {
      throw new Error(result.errorMsg || "CONTACT_SAVE_FAILED");
    }
    if (
      sendNotification &&
      (!result || result.success !== false) &&
      contactID !== characterID &&
      contactID >= 90000000 &&
      getCharacterRecord(contactID)
    ) {
      createNotification(contactID, {
        typeID: notificationTypeID,
        senderID: characterID,
        groupID: NOTIFICATION_GROUP.CONTACTS,
        processed: false,
        data: { level: relationshipID, message },
      });
    }
    return null;
  }

  Handle_DeleteContacts(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    log.debug(`[CharMgr] DeleteContacts(${characterID}, ${contactIDs.length})`);
    removePersonalContacts(characterID, contactIDs);
    return null;
  }

  Handle_EditContactsRelationshipID(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    const relationshipID = normalizeInteger(args && args[1], 0);
    log.debug(
      `[CharMgr] EditContactsRelationshipID(${characterID}, ${contactIDs.length}, ${relationshipID})`,
    );
    for (const contactID of contactIDs) {
      upsertPersonalContact(characterID, contactID, {
        relationshipID,
      });
    }
    return null;
  }

  Handle_BlockOwners(args, session) {
    const characterID = sessionCharacterID(session);
    const ownerIDs = extractList(args && args[0]);
    log.debug(`[CharMgr] BlockOwners(${characterID}, ${ownerIDs.length})`);
    updateBlockedOwners(characterID, ownerIDs, true);
    return null;
  }

  Handle_UnblockOwners(args, session) {
    const characterID = sessionCharacterID(session);
    const ownerIDs = extractList(args && args[0]);
    log.debug(`[CharMgr] UnblockOwners(${characterID}, ${ownerIDs.length})`);
    updateBlockedOwners(characterID, ownerIDs, false);
    return null;
  }

  Handle_SetCharacterDescription(args, session) {
    const characterID = sessionCharacterID(session);
    const description = toPlainString(args && args[0], "").slice(0, 2500);
    log.debug(`[CharMgr] SetCharacterDescription(${characterID})`);
    updateCharacterRecord(characterID, (record) => ({
      ...record,
      description,
    }));
    return null;
  }

  Handle_SetActivityStatus(args, session, kwargs) {
    const characterID = sessionCharacterID(session);
    const status = normalizeInteger(
      extractKwarg(kwargs, "status") ?? (args && args[0]),
      0,
    );
    const extraInfo = unwrapMarshalValue(
      extractKwarg(kwargs, "extraInfo") ?? (args && args[1]) ?? null,
    );
    log.debug(`[CharMgr] SetActivityStatus(${characterID}, ${status})`);
    updateCharacterRecord(characterID, (record) => ({
      ...record,
      activityStatus: status,
      activityStatusExtraInfo:
        extraInfo === undefined || extraInfo === null ? null : String(extraInfo),
    }));
    return null;
  }

  Handle_LogSettings(args, session) {
    const characterID = sessionCharacterID(session);
    const settings = unwrapMarshalValue(args && args[0]);
    log.debug(`[CharMgr] LogSettings(${characterID})`);
    updateCharacterRecord(characterID, (record) => ({
      ...record,
      lastSettingsTelemetry:
        settings && typeof settings === "object" ? settings : {},
    }));
    return null;
  }

  Handle_GetOwnerNoteLabels(args, session) {
    const characterID = sessionCharacterID(session);
    log.debug(`[CharMgr] GetOwnerNoteLabels(${characterID})`);

    return buildRowset(
      ["noteID", "label"],
      listOwnerNotes(characterID).map((entry) => [
        Number(entry.noteID) || 0,
        entry.label || "",
      ]),
      "eve.common.script.sys.rowset.Rowset",
    );
  }

  Handle_GetOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const noteID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CharMgr] GetOwnerNote(${characterID}, ${noteID})`);

    const note = getOwnerNote(characterID, noteID);
    if (!note) {
      return buildOwnerNotePayload(noteID, "", "");
    }

    return buildOwnerNotePayload(note.noteID, note.label, note.note);
  }

  Handle_AddOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const label = args && args.length > 0 ? args[0] : "";
    const noteText = args && args.length > 1 ? args[1] : "";
    log.debug(`[CharMgr] AddOwnerNote(${characterID}, ${toPlainString(label, "")})`);
    return addOwnerNote(characterID, label, noteText);
  }

  Handle_EditOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const noteID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const label = args && args.length > 1 ? args[1] : undefined;
    const noteText = args && args.length > 2 ? args[2] : undefined;
    log.debug(`[CharMgr] EditOwnerNote(${characterID}, ${noteID})`);
    editOwnerNote(characterID, noteID, label, noteText);
    return null;
  }

  Handle_RemoveOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const noteID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CharMgr] RemoveOwnerNote(${characterID}, ${noteID})`);
    removeOwnerNote(characterID, noteID);
    return null;
  }

  Handle_GetNote(args, session) {
    const characterID = sessionCharacterID(session);
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CharMgr] GetNote(${characterID}, ${itemID})`);
    return getEntityNote(characterID, itemID);
  }

  Handle_SetNote(args, session) {
    const characterID = sessionCharacterID(session);
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const noteText = args && args.length > 1 ? args[1] : "";
    log.debug(`[CharMgr] SetNote(${characterID}, ${itemID})`);
    setEntityNote(characterID, itemID, noteText);
    return null;
  }

  Handle_SaveCharacterSetting(args, session) {
    const settingKey = args && args.length > 0 ? args[0] : null;
    const settingValue = args && args.length > 1 ? args[1] : null;
    setCharacterSetting(sessionCharacterID(session), settingKey, settingValue);
    return null;
  }

  Handle_DeleteCharacterSetting(args, session) {
    const settingKey = args && args.length > 0 ? args[0] : null;
    deleteCharacterSetting(sessionCharacterID(session), settingKey);
    return null;
  }
}

CharMgrService._testing = {
  buildCharacterSettingsAnswer,
  buildPublicInfoKeyVal,
};

module.exports = CharMgrService;
