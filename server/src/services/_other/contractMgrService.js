"use strict";

const ContractProxyService = require("./contractProxyService");

// Both native names execute the same ownership, settlement and payload handlers.
class ContractMgrService extends ContractProxyService {
  constructor() {
    super("contractMgr");
  }
}

module.exports = ContractMgrService;
