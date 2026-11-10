"use strict";

module.exports = {
  getAbyssalMgrServiceModule,
};


function getAbyssalMgrServiceModule() {
  const runtimeExports = require("../runtime");
  const abyssalMgrService = require("../../abyssal").spaceRuntimeIntegration;
  const { configureAbyssalManagerEnginePort } = require("../abyssalEngineAdapter");
  configureAbyssalManagerEnginePort(runtimeExports);
  return abyssalMgrService;
}
