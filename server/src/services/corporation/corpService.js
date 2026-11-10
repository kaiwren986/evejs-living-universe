"use strict";

/**
 * Corporation Service (corporationSvc)
 *
 * Handles corporation-related queries from the client.
 */

const path = require("path");
const { getPersistedCorporationAuthority, corporationAuthorityHasRole } = require("./corporationAuthority");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { throwWrappedUserError } = require("../../common/machoErrors");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { getCharacterRecord } = require(path.join(
  __dirname,
  "../character/characterState",
));
const {
  buildDbRowset,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  buildRow,
  buildRowset,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  NPC_STARTER_CORPORATION_ID,
  getCorporationInfoRecord,
} = require(path.join(__dirname, "./corporationState"));
const {
  getCorporationRuntime,
  ensureRuntimeInitialized,
  normalizeInteger,
  normalizePositiveInteger,
  normalizeText,
  updateCorporationRuntime,
  CORP_ROLE_PERSONNEL_MANAGER,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  notifyCorporationMedalAdded,
  notifyMedalIssued,
} = require(path.join(__dirname, "./corporationNotifications"));
let medalCacheVersion = 1;
let cachedMedalRuntimeState = null;
let cachedMedalRuntimeStateVersion = 0;
const medalDetailsCacheByMedalID = new Map();
const receivedMedalsCacheByCharacterID = new Map();

function requireMedalAwardAuthority(session) {
  const authority = getPersistedCorporationAuthority(session);
  if (!corporationAuthorityHasRole(authority, CORP_ROLE_PERSONNEL_MANAGER)) {
    throwWrappedUserError("CrpAccessDenied");
  }
  return authority;
}

function resolveCharacterInfo(args, session) {
  const charId =
    args && args.length > 0 ? args[0] : session ? session.characterID : 0;

  return {
    charId,
    charData: getCharacterRecord(charId) || {},
  };
}

function buildMedalInfoRowset(medals = []) {
  return buildRowset(
    [
      "medalID",
      "issuerID",
      "ownerID",
      "status",
      "reason",
      "date",
      "isDeleted",
      "title",
      "description",
    ],
    medals.map((entry) =>
      buildList([
        Number(entry.medalID || 0),
        Number(entry.issuerID || 0),
        Number(entry.ownerID || 0),
        Number(entry.status ?? 3),
        { type: "wstring", value: normalizeText(entry.reason, "") },
        buildFiletimeLong(entry.date || entry.issueDate || entry.createdAt || 0n),
        entry.isDeleted ? 1 : 0,
        { type: "wstring", value: normalizeText(entry.title, "") },
        { type: "wstring", value: normalizeText(entry.description, "") },
      ]),
    ),
    "eve.common.script.sys.rowset.Rowset",
  );
}

function buildMedalGraphicsRowset(medalGraphics = []) {
  return buildRowset(
    [
      "medalID",
      "part",
      "graphic",
      "color",
    ],
    medalGraphics.map((entry) =>
      buildList([
        Number(entry.medalID || 0),
        Number(entry.part || 0),
        // uix.FormatMedalData does row.graphic.split("."), so this column is the
        // dotted "<type>.<mapping>" string the client sent, never an integer.
        normalizeText(entry.graphic ?? entry.graphicID, ""),
        Number(entry.color || entry.colorID || 0),
      ]),
    ),
    "eve.common.script.sys.rowset.Rowset",
  );
}

function buildCorpMedalRowset(medals = [], recipientsByMedalID = {}) {
  return buildDbRowset(
    [
      ["medalID", 3],
      ["ownerID", 3],
      ["title", 130],
      ["description", 130],
      ["creatorID", 3],
      ["date", 64],
      ["noRecepients", 3],
    ],
    medals.map((entry) => {
      const recipients = recipientsByMedalID[String(entry.medalID)];
      return [
        Number(entry.medalID || 0),
        Number(entry.ownerID || 0),
        { type: "wstring", value: normalizeText(entry.title, "") },
        { type: "wstring", value: normalizeText(entry.description, "") },
        Number(entry.creatorID || 0),
        buildFiletimeLong(entry.createDateTime || entry.createdAt || 0n),
        Array.isArray(recipients) ? recipients.length : 0,
      ];
    }),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function buildCorpMedalGraphicsRowset(graphics = []) {
  const ordinals = new Map();
  return buildDbRowset(
    [["medalID", 3], ["part", 3], ["layer", 3], ["graphic", 129], ["color", 3]],
    graphics.map((entry) => {
      const medalID = Number(entry.medalID || 0);
      const part = Number(entry.part || 0);
      const key = `${medalID}:${part}`;
      const ordinal = ordinals.get(key) || 0;
      ordinals.set(key, ordinal + 1);
      // TQ records this column in an empty catalogue. SubmitData sends no
      // layer: use input order per medal/part until populated TQ values exist.
      const layer = entry.layer != null ? normalizeInteger(entry.layer, 0) : ordinal;
      return [
        medalID, part, layer,
        normalizeText(entry.graphic ?? entry.graphicID, ""),
        // Preserve ARGB bits as signed I4; the packed encoder does not coerce uint32.
        Number(entry.color || entry.colorID || 0) | 0,
      ];
    }),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function buildMedalRecipientsRowset(recipients = []) {
  return buildRowset(
    ["medalID", "recepientID", "issuerID", "reason", "date"],
    recipients.map((entry) =>
      buildList([
        Number(entry.medalID || 0),
        Number(entry.characterID || 0),
        Number(entry.issuerID || 0),
        { type: "wstring", value: normalizeText(entry.reason, "") },
        buildFiletimeLong(entry.date || entry.createDateTime || 0n),
      ]),
    ),
    "eve.common.script.sys.rowset.Rowset",
  );
}

function invalidateMedalCaches() {
  medalCacheVersion += 1;
  cachedMedalRuntimeState = null;
  cachedMedalRuntimeStateVersion = 0;
  medalDetailsCacheByMedalID.clear();
  receivedMedalsCacheByCharacterID.clear();
}

/**
 * Unwrap a marshalled python sequence into a plain array.  A tuple decodes to a
 * bare array while a list decodes to { type: "list", items }, and the client
 * builds medal graphics out of lists, so both spellings have to be accepted.
 */
function toMarshalSequence(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    value.type === "list" &&
    Array.isArray(value.items)
  ) {
    return value.items;
  }
  return null;
}

/**
 * medalribbonranks.CreateDecorationWindow.SubmitData sends the graphics as a
 * python list of positional [part, "<type>.<mapping>", color] lists, so the
 * graphic is the dotted string uix.FormatMedalData later splits into its
 * texture set and icon.  The harness still sends keyed dict/object entries, so
 * keep reading those too.
 */
function normalizeMedalGraphics(value) {
  const graphics = toMarshalSequence(value) || [];
  return graphics.map((entry) => {
    const positional = toMarshalSequence(entry);
    if (positional) {
      return {
        part: normalizeInteger(positional[0], 0),
        graphic: normalizeText(positional[1], ""),
        color: normalizeInteger(positional[2], 0),
      };
    }
    const fields = entry && entry.type === "dict" && Array.isArray(entry.entries)
      ? Object.fromEntries(entry.entries.map(([key, item]) => [normalizeText(key, ""), item]))
      : entry && typeof entry === "object" ? entry : {};
    return {
      part: normalizeInteger(fields.part, 0),
      graphic: normalizeText(fields.graphic ?? fields.graphicID, ""),
      color: normalizeInteger(fields.color ?? fields.colorID, 0),
    };
  });
}

function collectRuntimeMedalState() {
  if (
    cachedMedalRuntimeState &&
    cachedMedalRuntimeStateVersion === medalCacheVersion
  ) {
    return cachedMedalRuntimeState;
  }

  const runtimeTable = ensureRuntimeInitialized();
  const medalsByID = new Map();
  const recipientsByMedalID = new Map();

  for (const [corporationID, runtime] of Object.entries(runtimeTable.corporations || {})) {
    const medalState = runtime && runtime.medals ? runtime.medals : {};
    for (const medal of Object.values(medalState.medals || {})) {
      medalsByID.set(Number(medal.medalID || 0), {
        ...medal,
        ownerID: Number(medal.ownerID || corporationID) || Number(corporationID) || 0,
      });
    }
    for (const [medalID, recipients] of Object.entries(
      medalState.recipientsByMedalID || {},
    )) {
      recipientsByMedalID.set(
        Number(medalID || 0),
        Array.isArray(recipients) ? recipients : [],
      );
    }
  }

  cachedMedalRuntimeState = {
    medalsByID,
    recipientsByMedalID,
  };
  cachedMedalRuntimeStateVersion = medalCacheVersion;
  return cachedMedalRuntimeState;
}

function buildMedalDetailsPayload(medalID) {
  const numericMedalID = Number(medalID || 0);
  const cachedPayload = medalDetailsCacheByMedalID.get(numericMedalID);
  if (cachedPayload && cachedPayload.version === medalCacheVersion) {
    return cachedPayload.payload;
  }

  const { medalsByID, recipientsByMedalID } = collectRuntimeMedalState();
  const medal = medalsByID.get(numericMedalID);
  if (!medal) {
    const emptyPayload = buildKeyVal([
      ["info", buildList([])],
      ["graphics", buildMedalGraphicsRowset([])],
    ]);
    medalDetailsCacheByMedalID.set(numericMedalID, {
      version: medalCacheVersion,
      payload: emptyPayload,
    });
    return emptyPayload;
  }

  const recipients = recipientsByMedalID.get(numericMedalID) || [];
  const payload = buildKeyVal([
    [
      "info",
      buildList([
        buildKeyVal([
          ["medalID", Number(medal.medalID || 0)],
          ["ownerID", Number(medal.ownerID || 0)],
          ["creatorID", Number(medal.creatorID || 0)],
          // LabelCore.GetAsUnicode uses the installed cp1252 default for str;
          // persisted user text must remain Unicode rather than UTF-8 bytes.
          ["title", { type: "wstring", value: normalizeText(medal.title, "") }],
          ["description", { type: "wstring", value: normalizeText(medal.description, "") }],
          ["createDateTime", buildFiletimeLong(medal.createDateTime || 0)],
          ["numberOfRecipients", recipients.length],
        ]),
      ]),
    ],
    [
      "graphics",
      buildMedalGraphicsRowset(
        (Array.isArray(medal.graphics) ? medal.graphics : []).map((graphic) => ({
          medalID: Number(medal.medalID || 0),
          part: graphic.part || 0,
          graphic: graphic.graphic ?? graphic.graphicID ?? "",
          color: graphic.color || graphic.colorID || 0,
        })),
      ),
    ],
  ]);
  medalDetailsCacheByMedalID.set(numericMedalID, {
    version: medalCacheVersion,
    payload,
  });
  return payload;
}

function getReceivedMedalsForCharacter(characterID) {
  const numericCharacterID = Number(characterID || 0);
  const cachedState = receivedMedalsCacheByCharacterID.get(numericCharacterID);
  if (cachedState && cachedState.version === medalCacheVersion) {
    return cachedState.payload;
  }

  const { medalsByID, recipientsByMedalID } = collectRuntimeMedalState();
  const medalInfo = [];
  const medalGraphics = [];

  for (const [medalID, recipients] of recipientsByMedalID.entries()) {
    const medal = medalsByID.get(medalID);
    if (!medal) {
      continue;
    }
    const matchingRecipients = recipients.filter(
      (recipient) => Number(recipient && recipient.characterID) === numericCharacterID,
    );
    if (matchingRecipients.length === 0) {
      continue;
    }

    for (const recipient of matchingRecipients) {
      medalInfo.push({
        medalID,
        issuerID: Number(recipient.issuerID || 0),
        ownerID: Number(medal.ownerID || 0),
        status: Number(recipient.status ?? medal.status ?? 3),
        reason: recipient.reason || "",
        date: recipient.date || recipient.createDateTime || medal.createDateTime || 0,
        isDeleted: Number(recipient.status ?? medal.status ?? 3) === 1 || medal.isDeleted ? 1 : 0,
        // infosvc.GetMedalEntry reads these from the received row itself.
        title: medal.title || "",
        description: medal.description || "",
      });
    }

    for (const graphic of Array.isArray(medal.graphics) ? medal.graphics : []) {
      medalGraphics.push({
        medalID,
        part: graphic.part || 0,
        graphic: graphic.graphic ?? graphic.graphicID ?? "",
        color: graphic.color || graphic.colorID || 0,
      });
    }
  }

  const payload = {
    medalInfo,
    medalGraphics,
  };
  receivedMedalsCacheByCharacterID.set(numericCharacterID, {
    version: medalCacheVersion,
    payload,
  });
  return payload;
}

class CorpService extends BaseService {
  constructor() {
    super("corporationSvc");
  }

  Handle_GetNPCDivisions() {
    log.debug("[CorpSvc] GetNPCDivisions");
    return { type: "list", items: [] };
  }

  Handle_GetEmploymentRecord(args, session) {
    log.debug("[CorpSvc] GetEmploymentRecord");
    const { charData } = resolveCharacterInfo(args, session);
    const history = Array.isArray(charData.employmentHistory)
      ? charData.employmentHistory
      : [
          {
            corporationID:
              charData.corporationID || (session ? session.corporationID : NPC_STARTER_CORPORATION_ID),
            startDate: charData.startDateTime || charData.createDateTime,
            deleted: 0,
          },
        ];
    const sortedHistory = history
      .slice()
      .sort((left, right) =>
        String(right && right.startDate ? right.startDate : "").localeCompare(
          String(left && left.startDate ? left.startDate : ""),
        ),
      );
    return buildRowset(
      ["corporationID", "startDate", "deleted"],
      sortedHistory.map((entry) =>
        buildList([
          Number(entry.corporationID) ||
            charData.corporationID ||
            (session ? session.corporationID : NPC_STARTER_CORPORATION_ID),
          buildFiletimeLong(entry.startDate || charData.startDateTime || charData.createDateTime),
          entry.deleted ? 1 : 0,
        ]),
      ),
      "eve.common.script.sys.rowset.Rowset",
    );
  }

  Handle_GetRecruitmentAdsByCriteria() {
    log.debug("[CorpSvc] GetRecruitmentAdsByCriteria");
    return { type: "list", items: [] };
  }

  Handle_GetCorpInfo(args) {
    const corporationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CorpSvc] GetCorpInfo(${corporationID})`);
    const info = getCorporationInfoRecord(corporationID);
    if (!info) {
      return null;
    }

    // The NPC corporation info window consumes this RPC as an iterable market-activity
    // recordset, not as corporation metadata. Returning an empty list preserves the
    // client contract until we wire real NPC market supply/demand aggregation.
    return buildList([]);
  }

  Handle_GetEmployementRecordAndCharacterTransfers(args, session) {
    log.debug("[CorpSvc] GetEmployementRecordAndCharacterTransfers");
    return [this.Handle_GetEmploymentRecord(args, session), { type: "list", items: [] }];
  }

  Handle_GetMedalsReceived(args, session) {
    log.debug("[CorpSvc] GetMedalsReceived");
    const { charId } = resolveCharacterInfo(args, session);
    const { medalInfo, medalGraphics } = getReceivedMedalsForCharacter(charId);
    const ownMedals = Number(charId) === resolveSessionCharacterID(session);
    const visibleMedals = ownMedals ? medalInfo : medalInfo.filter((medal) => medal.status === 3 && !medal.isDeleted);
    const visibleIDs = new Set(visibleMedals.map((medal) => medal.medalID));
    return [buildMedalInfoRowset(visibleMedals), buildMedalGraphicsRowset(medalGraphics.filter((graphic) => visibleIDs.has(graphic.medalID)))];
  }

  Handle_GetMedalDetails(args, session) {
    const medalID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CorpSvc] GetMedalDetails(${medalID})`);
    return buildMedalDetailsPayload(medalID);
  }

  Handle_GetInfoWindowDataForChar(args, session) {
    log.debug("[CorpSvc] GetInfoWindowDataForChar");
    const { charData } = resolveCharacterInfo(args, session);
    return buildKeyVal([
      ["corpID", charData.corporationID || (session ? session.corporationID : NPC_STARTER_CORPORATION_ID)],
      ["allianceID", charData.allianceID || (session ? session.allianceID : null)],
      ["title", charData.title || ""],
    ]);
  }

  Handle_CreateMedal(args, session) {
    requireMedalAwardAuthority(session);
    const corporationID =
      (session && (session.corporationID || session.corpid)) || 0;
    let medalID = null;
    const updateResult = updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      medalID = table._meta.nextMedalID++;
      const medal = {
        medalID,
        ownerID: corporationID,
        creatorID: (session && (session.characterID || session.charid)) || 0,
        title: normalizeText(args && args[0], ""),
        description: normalizeText(args && args[1], ""),
        graphics: normalizeMedalGraphics(args && args[2]),
        status: 3,
        createDateTime: String(Date.now() * 10000 + 116444736000000000),
      };
      runtime.medals.medals[String(medalID)] = medal;
      runtime.medals.recipientsByMedalID[String(medalID)] = [];
      return runtime;
    });
    invalidateMedalCaches();
    if (updateResult && updateResult.success === true && medalID > 0) {
      notifyCorporationMedalAdded(corporationID, medalID);
    }
    return medalID;
  }

  Handle_SetMedalStatus(args, session) {
    const characterID = resolveSessionCharacterID(session);
    if (!characterID || !getCharacterRecord(characterID)) throwWrappedUserError("CrpAccessDenied");
    const statusMap = args && args[0] && typeof args[0] === "object" ? args[0] : {};
    const statusEntries = statusMap.type === "dict" && Array.isArray(statusMap.entries)
      ? statusMap.entries
      : Object.entries(statusMap);
    const changes = new Map();
    const corporations = ensureRuntimeInitialized().corporations || {};
    // The character sheet edits only the caller's received decoration privacy.
    // Preflight every entry before changing any recipient or issuing corporation.
    for (const [rawMedalID, rawStatus] of statusEntries) {
      const medalID = normalizePositiveInteger(rawMedalID, 0);
      const status = Number(rawStatus);
      if (!medalID || ![1, 2, 3].includes(status)) throwWrappedUserError("CrpAccessDenied");
      const issuer = Object.entries(corporations).find(([, runtime]) =>
        (runtime.medals?.recipientsByMedalID?.[String(medalID)] || []).some((recipient) => Number(recipient.characterID) === characterID));
      if (!issuer) throwWrappedUserError("CrpAccessDenied");
      const corporationChanges = changes.get(issuer[0]) || new Map();
      corporationChanges.set(medalID, status);
      changes.set(issuer[0], corporationChanges);
    }
    for (const [corporationID, corporationChanges] of changes) {
      updateCorporationRuntime(corporationID, (runtime) => {
        for (const [medalID, status] of corporationChanges) {
          for (const recipient of runtime.medals.recipientsByMedalID[String(medalID)] || []) {
            if (Number(recipient.characterID) === characterID) recipient.status = status;
          }
        }
        return runtime;
      });
    }
    invalidateMedalCaches();
    return null;
  }

  Handle_GetAllCorpMedals(args) {
    const corporationID = normalizePositiveInteger(args && args[0], 0) || 0;
    const runtime = getCorporationRuntime(corporationID) || {};
    const medals = Object.values((runtime.medals && runtime.medals.medals) || {});
    const recipientsByMedalID = (runtime.medals && runtime.medals.recipientsByMedalID) || {};
    const graphics = [];
    for (const medal of medals) {
      for (const graphic of Array.isArray(medal.graphics) ? medal.graphics : []) {
        graphics.push({
          medalID: medal.medalID,
          part: graphic.part || 0,
          layer: graphic.layer,
          graphic: graphic.graphic ?? graphic.graphicID ?? "",
          color: graphic.color || graphic.colorID || 0,
        });
      }
    }
    return buildCachedMethodCallResult(
      buildList([buildCorpMedalRowset(medals, recipientsByMedalID), buildCorpMedalGraphicsRowset(graphics)]),
      {
        serviceName: "corporationSvc",
        method: "GetAllCorpMedals",
        args: [corporationID],
        versionCheck: "1 hour",
        proxyCache: true,
      },
    );
  }

  Handle_GetRecipientsOfMedal(args, session) {
    const medalID = normalizePositiveInteger(args && args[0], 0) || 0;
    const { medalsByID, recipientsByMedalID } = collectRuntimeMedalState();
    const medal = medalsByID.get(medalID);
    const characterID = resolveSessionCharacterID(session);
    return buildMedalRecipientsRowset(
      (recipientsByMedalID.get(medalID) || []).filter((recipient) =>
        Number(recipient.characterID) === characterID || Number(recipient.status ?? medal?.status ?? 3) === 3),
    );
  }

  Handle_GiveMedalToCharacters(args, session) {
    requireMedalAwardAuthority(session);
    const corporationID =
      (session && (session.corporationID || session.corpid)) || 0;
    const medalID = normalizePositiveInteger(args && args[0], 0) || 0;
    const runtime = getCorporationRuntime(corporationID);
    if (!runtime?.medals?.medals?.[String(medalID)]) throwWrappedUserError("CrpAccessDenied");
    // Compiled medals.GiveMedalToCharacters sends a scalar medal ID and a
    // Python recipient list; the dispatcher preserves that list wrapper.
    const characterIDs = toMarshalSequence(args && args[1]) || [args && args[1]];
    if (!characterIDs.length || characterIDs.some((characterID) => !getCharacterRecord(normalizePositiveInteger(characterID, 0)))) {
      throwWrappedUserError("CrpAccessDenied");
    }
    const reason = normalizeText(args && args[2], "");
    const awardedCharacterIDs = [];
    const updateResult = updateCorporationRuntime(corporationID, (runtime) => {
      if (!runtime.medals.recipientsByMedalID[String(medalID)]) {
        runtime.medals.recipientsByMedalID[String(medalID)] = [];
      }
      for (const characterID of characterIDs) {
        runtime.medals.recipientsByMedalID[String(medalID)].push({
          medalID,
          characterID: Number(characterID || 0),
          issuerID: (session && (session.characterID || session.charid)) || 0,
          reason,
          date: String(Date.now() * 10000 + 116444736000000000),
        });
        awardedCharacterIDs.push(Number(characterID || 0));
      }
      return runtime;
    });
    invalidateMedalCaches();
    if (updateResult && updateResult.success === true) {
      notifyMedalIssued(awardedCharacterIDs);
    }
    return null;
  }
}

CorpService._testing = {
  resetMedalCachesForTests: invalidateMedalCaches,
};

module.exports = CorpService;
