"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  extractRepackageRequests,
  repackageItemsForSession,
} = require(path.join(__dirname, "./repackagingSupport"));

class RepackagingService extends BaseService {
  constructor() {
    super("repackagingSvc");
  }

  Handle_RepackageItems(args, session, kwargs) {
    repackageItemsForSession(
      session,
      extractRepackageRequests(args && args[0]),
      "RepackagingSvc",
      kwargs,
    );
    return null;
  }
}

module.exports = RepackagingService;
