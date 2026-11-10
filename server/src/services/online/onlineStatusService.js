"use strict";

/**
 * Online Status Service (onlineStatus)
 *
 * Handles online status queries from the client.
 */

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDbRowset,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getSessionCharacterID,
  isCharacterOnline,
  listInitialOnlineStatusRows,
} = require(path.join(__dirname, "./onlineStatusRuntime"));

const DBTYPE_I4 = 0x03;
const DBTYPE_BOOL = 0x0b;
const ONLINE_STATUS_COLUMNS = [
  ["contactID", DBTYPE_I4],
  ["online", DBTYPE_BOOL],
];

// comtool/onlineStatus.py primes presence with
//   GetInitialState().Index('contactID')
// and then keeps that indexed rowset live with
//   self.onlineStatus[charID] = blue.DBRow(self.onlineStatus.header, [charID, x])
// in OnContactLoggedOn / OnContactLoggedOff / GetOnlineStatus(fetch=True).
//
// blue.DBRow's first argument must be a blue.DBRowDescriptor, so the header the
// client ends up holding has to be a descriptor — which pins the container class:
//
//   eve.common.script.sys.rowset.Rowset.Index() builds IndexRowset(header, ...),
//     whose __init__ does header.index(idName). That needs a plain LIST of column
//     names; handed a descriptor it raises
//     AttributeError: 'blue.DBRowDescriptor' object has no attribute 'index'.
//   carbon.common.script.sys.crowset.CRowset.Index() builds
//     CIndexedRowset(header, columnName), which keeps the descriptor as .header
//     and indexes through blue.pyos.XUtil_Index.
//
// Only CRowset satisfies both requirements, so the descriptor-backed rows this
// service emits must be declared as a CRowset, never as a rowset.Rowset.
const ONLINE_STATUS_ROWSET_NAME = "carbon.common.script.sys.crowset.CRowset";

function normalizeCharacterID(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

class OnlineStatusService extends BaseService {
  constructor() {
    super("onlineStatus");
  }

  Handle_GetOnlineStatus(args, session) {
    const targetID = normalizeCharacterID(args && args[0]);
    const observerID = getSessionCharacterID(session);
    const online = isCharacterOnline(targetID, observerID);
    log.debug(
      `[OnlineStatus] GetOnlineStatus observer=${observerID || "none"} target=${targetID || "none"} -> ${online}`,
    );
    return online;
  }

  Handle_GetInitialState(args, session) {
    const observerID = getSessionCharacterID(session);
    const rows = listInitialOnlineStatusRows(observerID);
    log.debug(`[OnlineStatus] GetInitialState observer=${observerID || "none"} rows=${rows.length}`);
    return buildDbRowset(ONLINE_STATUS_COLUMNS, rows, ONLINE_STATUS_ROWSET_NAME);
  }

  Handle_Prime(args, session) {
    return this.Handle_GetInitialState(args, session);
  }
}

module.exports = OnlineStatusService;
