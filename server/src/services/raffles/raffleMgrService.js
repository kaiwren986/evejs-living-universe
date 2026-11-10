"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  getRaffleRuntime,
} = require(path.join(__dirname, "./raffleRuntimeSingleton"));
const {
  isHyperNetAvailable,
  requireHyperNetAvailable,
} = require(path.join(__dirname, "./raffleAvailability"));

class RaffleMgrService extends BaseService {
  constructor() {
    super("raffleMgr");
    this._runtime = getRaffleRuntime();
    if (isHyperNetAvailable()) {
      this._runtime.initialize();
    }
  }

  Handle_QA_SeedRaffles(args) {
    requireHyperNetAvailable();
    const quantity = args && args[0];
    log.debug(`[RaffleMgr] QA_SeedRaffles(${quantity})`);
    return this._runtime.qaSeedRaffles(quantity);
  }
}

module.exports = RaffleMgrService;
