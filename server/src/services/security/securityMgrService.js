"use strict";

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildDict,
  buildPackedRowDescriptor,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

// A modified system's row as Tranquility's answer describes it: the system (an
// I4), and its security before and after (two R8).
const MODIFIED_SYSTEM_COLUMNS = [
  ["solarSystemID", 0x03],
  ["security", 0x05],
  ["modifiedSecurity", 0x05],
];

class SecurityMgrService extends BaseService {
  constructor() {
    super("securityMgr");
  }

  Handle_get_modified_systems(args, session, kwargs) {
    log.debug("[SecurityMgrService] get_modified_systems called");
    // The solar systems whose security is other than the map's, each by its
    // ID: a CIndexedRowset on solarSystemID, as Tranquility answers the
    // client's security service at a login (security/client/securitySvc.py 39
    // to 43). Its state is the row's descriptor and the column it is keyed by,
    // those two and no more, as the recorded answer has them. This server
    // modifies no system's security, so it has no rows.
    return {
      type: "objectex2",
      header: [
        [{ type: "token", value: "carbon.common.script.sys.crowset.CIndexedRowset" }],
        buildDict([
          ["header", buildPackedRowDescriptor(MODIFIED_SYSTEM_COLUMNS)],
          ["columnName", "solarSystemID"],
        ]),
      ],
      list: [],
      dict: [],
    };
  }
}

module.exports = SecurityMgrService;
