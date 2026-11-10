"use strict";

const {
  toInt,
} = require("../../common/numbers");

/**
 * Alert Service
 *
 * Handles client alert calls like crash reports (BeanCount).
 */

const path = require("path");
const zlib = require("zlib");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDict,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { strVal, marshalDecode } = require(
  path.join(__dirname, "../../network/tcp/utils/marshal"),
);

const MAX_AUDIT_EVENTS = 100;
const MAX_AUDIT_PAYLOAD_ITEMS = 25;

// Decoded client traces can be several KB. Keep the whole thing when we can; if
// it is enormous, preserve the head AND the tail, because the exception
// type/message is the final line of a Python traceback (after every frame) and
// is the piece we actually need.
const MAX_TRACE_CHARS = 20000;
const TRACE_TAIL_CHARS = 2000;

// Bean counting modes, from carbon/common/script/sys/alert.py:22-23.
const LOGGING_BATCHED = "B";
const LOGGING_DETAILS = "D";

// TQ picks the mode from cluster liveness (alert.py:619-622):
//   if self.IsLiveCluster(): logMode = 'B' else: logMode = 'D'
// eve.js is never a live cluster, so 'D' is the faithful answer. 'D' gives us
// everything 'B' does plus a per-user record (count, time, charID, locationID1,
// locationID2, argStr, nodeID).
const CLIENT_LOG_MODE = LOGGING_DETAILS;

const auditEvents = [];
const beanCountsByErrorID = new Map();

// TQ allocates errorID as a zcluster.Errors DB identity (alert.py:623,
// `Errors_Insert(...)[0].errorID`) and keys stacktraceLogMode by stackhash. A
// monotonic counter plus a stackhash->id map is the faithful equivalent.
//
// The client requires errorID to be non-null (its check is `is None`, so 0 would
// be legal but is avoided here), hashable, and unique per stackhash -- two
// stackhashes sharing an errorID would silently merge distinct errors in
// stacktracebeancounts. See docs/ErrorWatch for the full consumer trace.
const errorIDByStackHash = new Map();
let nextErrorID = 1;

function resolveErrorID(stackHash, stackKey) {
  // decodeStackTraceArgs can yield a null stackHash; fall back to the stack key
  // so repeats still collapse onto one errorID rather than leaking the counter.
  const key = stackHash !== null && stackHash !== undefined
    ? `h:${stackHash}`
    : stackKey
      ? `k:${stackKey}`
      : null;
  if (key === null) {
    // Nothing stable to key on. Still MUST return a usable id -- returning null
    // here is the defect this function exists to prevent.
    return nextErrorID++;
  }
  const existing = errorIDByStackHash.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const allocated = nextErrorID++;
  errorIDByStackHash.set(key, allocated);
  return allocated;
}

function getCharacterID(session) {
  return Math.max(
    0,
    toInt(
      session && (
        session.characterID ||
        session.charid ||
        session.characterId
      ),
      0,
    ),
  );
}

function cloneValue(value, depth = 0) {
  if (Buffer.isBuffer(value)) {
    return {
      type: "buffer",
      byteLength: value.length,
    };
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (depth >= 3) {
    return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_AUDIT_PAYLOAD_ITEMS)
      .map((entry) => cloneValue(entry, depth + 1));
  }
  if (value.type === "dict" && Array.isArray(value.entries)) {
    return {
      type: "dict",
      entries: value.entries
        .slice(0, MAX_AUDIT_PAYLOAD_ITEMS)
        .map(([key, entry]) => [cloneValue(key, depth + 1), cloneValue(entry, depth + 1)]),
    };
  }
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_AUDIT_PAYLOAD_ITEMS)) {
    result[key] = cloneValue(entry, depth + 1);
  }
  return result;
}

function normalizeDictEntries(value) {
  if (!value) {
    return [];
  }
  if (value.type === "dict" && Array.isArray(value.entries)) {
    return value.entries;
  }
  if (value instanceof Map) {
    return Array.from(value.entries());
  }
  if (typeof value === "object" && !Buffer.isBuffer(value) && !Array.isArray(value)) {
    return Object.entries(value);
  }
  return [];
}

function asSequence(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && value.type === "list" && Array.isArray(value.items)) {
    return value.items;
  }
  return null;
}

// Pulls the human-readable fields out of a SendClientStackTraceAlert payload.
// Client call is SendClientStackTraceAlert(stackID, stackTrace, mode, nextErrorKeyHash):
//   stackID    -> (adler32Hash, stackKeyString); the key arrives as a Buffer
//   stackTrace -> the full trace; arrives as a Buffer (PyLongString)
//   mode       -> 'error' | 'Error' | 'Warning' | 'Info' | ...
// Python str values unmarshal to Node Buffers, so every text field needs
// decoding (strVal handles Buffer/string/wstring/token uniformly).
function decodeStackTraceArgs(args) {
  const list = Array.isArray(args) ? args : [];
  let stackHash = null;
  let stackKey = null;
  const stackSeq = asSequence(list[0]);
  if (stackSeq) {
    stackHash = typeof stackSeq[0] === "number" ? stackSeq[0] : null;
    stackKey = stackSeq.length > 1 ? strVal(stackSeq[1]) : null;
  }
  const trace = list.length > 1 ? strVal(list[1]) : "";
  const mode = list.length > 2 ? strVal(list[2]) : null;
  return { stackHash, stackKey, mode, trace };
}

function clampTrace(trace) {
  if (typeof trace !== "string") {
    return "";
  }
  if (trace.length <= MAX_TRACE_CHARS) {
    return trace;
  }
  const head = trace.slice(0, MAX_TRACE_CHARS - TRACE_TAIL_CHARS);
  const tail = trace.slice(-TRACE_TAIL_CHARS);
  return `${head}\n…[${trace.length - MAX_TRACE_CHARS} chars omitted]…\n${tail}`;
}

function recordAuditEvent(kind, args = [], session = null, extra = {}) {
  auditEvents.push({
    kind,
    characterID: getCharacterID(session) || null,
    args: cloneValue(Array.isArray(args) ? args : []),
    ...extra,
    timestamp: Date.now(),
  });
  if (auditEvents.length > MAX_AUDIT_EVENTS) {
    auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  }
}

// The grouped payload is zlib(marshal({errorID: {userID: (count, time, charID,
// locationID1, locationID2, argStr, nodeID)}})). TQ treats a payload it cannot
// decode as hostile (alert.py:302-318), so never let a malformed blob throw --
// fall back to null and the caller degrades to byte-length-only logging.
function decodeGroupBeans(payload) {
  try {
    const inflated = zlib.inflateSync(payload);
    return marshalDecode(inflated);
  } catch (err) {
    log.debug(
      `[AlertService] GroupBeanDelivery payload not decodable: ${err && err.message}`,
    );
    return null;
  }
}

function summarizeGroupBeans(decoded) {
  const groups = [];
  for (const [errorID, perUser] of normalizeDictEntries(decoded)) {
    let totalCount = 0;
    let userCount = 0;
    for (const [, tuple] of normalizeDictEntries(perUser)) {
      const row = Array.isArray(tuple) ? tuple : [];
      totalCount += Math.max(0, toInt(row[0], 0));
      userCount += 1;
    }
    groups.push({ errorID: String(errorID), totalCount, userCount });
  }
  return groups;
}

function recordBeanCounts(beans) {
  let entryCount = 0;
  for (const [errorID, value] of normalizeDictEntries(beans)) {
    const key = String(errorID);
    const tuple = Array.isArray(value) ? value : [];
    const count = Math.max(0, toInt(tuple[0], 0));
    const latestTime = Math.max(0, toInt(tuple[1], 0));
    const current = beanCountsByErrorID.get(key) || {
      count: 0,
      latestTime: 0,
    };
    beanCountsByErrorID.set(key, {
      count: current.count + count,
      latestTime: Math.max(current.latestTime, latestTime),
    });
    entryCount += 1;
  }
  return entryCount;
}

class AlertService extends BaseService {
  constructor() {
    super("alert");
  }

  Handle_BeanCount(args, session) {
    recordAuditEvent("bean_count", args, session);
    log.debug("[AlertService] BeanCount (crash report)");
    // Client unpacks: (errorID, logMode) = result   (alert.py:512)
    //
    // Deliberately always (None, None): a null errorID is how TQ says "unknown
    // hash, send me the trace" (alert.py:639 returns the same for a miss), which
    // makes the client cross the wire with the full stack text once per session
    // per hash. Returning a cached tuple here would permanently stop trace text
    // arriving for hashes we have already seen -- not what we want on a dev server.
    return [null, null];
  }

  Handle_BeanDelivery(args, session) {
    const beans = args && args.length > 0 ? args[0] : null;
    const entryCount = recordBeanCounts(beans);
    recordAuditEvent("bean_delivery", args, session, { entryCount });
    log.debug(`[AlertService] BeanDelivery entries=${entryCount}`);
    return null;
  }

  Handle_GroupBeanDelivery(args, session) {
    const payload = args && args.length > 0 ? args[0] : null;
    const nodeID = args && args.length > 1 ? args[1] : null;
    const isCompressed = Buffer.isBuffer(payload);
    // Client sends zlib.compress(blue.marshal.Save(groupBeans)) (alert.py:298-300).
    // Under logMode 'D' this blob is the entire added value over 'B', so it has to
    // be inflated -- logging its byte length only would make 'D' and 'B'
    // observationally identical.
    const decoded = isCompressed ? decodeGroupBeans(payload) : payload;
    const entryCount = normalizeDictEntries(decoded).length;
    const groups = summarizeGroupBeans(decoded);
    recordAuditEvent("group_bean_delivery", args, session, {
      byteLength: isCompressed ? payload.length : null,
      entryCount,
      groups,
      nodeID: nodeID || null,
    });
    log.debug(
      `[AlertService] GroupBeanDelivery entries=${entryCount} compressed=${isCompressed}` +
        (groups.length
          ? ` detail=${groups
              .map((g) => `${g.errorID}:${g.totalCount}x/${g.userCount}u`)
              .join(",")}`
          : ""),
    );
    return null;
  }

  Handle_GetLogModeForError(args, session) {
    const errorIDs = args && args.length > 0 ? args[0] : null;
    recordAuditEvent("get_log_mode_for_error", args, session, {
      requestedCount: normalizeDictEntries(errorIDs).length,
    });
    return [buildDict([]), buildList([])];
  }

  Handle_SendClientStackTraceAlert(args, session) {
    recordAuditEvent("send_client_stack_trace_alert", args, session);
    const { stackHash, stackKey, mode, trace } = decodeStackTraceArgs(args);
    const charID = session && session.characterID;
    log.warn(
      `[AlertService] SendClientStackTraceAlert char=${charID} ` +
        `mode=${mode || "?"} key=${stackKey || stackHash || "?"}\n` +
        clampTrace(trace),
    );
    // MUST be a 2-tuple (errorID, logMode) -- the client caches this return value
    // verbatim under the stackhash (alert.py:516) and unpacks it on the NEXT
    // occurrence of the same error (alert.py:520-521). Returning null poisons that
    // cache, so the repeat raises TypeError inside the client's own error reporter
    // and its repeat-count telemetry dies. The client suppresses that failure with
    // toAlertSvc=0 (alert.py:485), so it never reaches us -- the bug hides itself.
    const errorID = resolveErrorID(stackHash, stackKey);
    return [errorID, CLIENT_LOG_MODE];
  }
}

AlertService._testing = {
  getAuditEvents() {
    return auditEvents.slice();
  },
  getBeanCounts() {
    return new Map(beanCountsByErrorID);
  },
  getErrorIDMap() {
    return new Map(errorIDByStackHash);
  },
  resetForTests() {
    auditEvents.length = 0;
    beanCountsByErrorID.clear();
    errorIDByStackHash.clear();
    nextErrorID = 1;
  },
};

module.exports = AlertService;
