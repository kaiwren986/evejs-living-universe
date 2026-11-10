"use strict";

// Service discovery keeps its conventional paths, but implementations live in
// this subsystem and are selected without eagerly constructing both services.
module.exports = Object.freeze({
  get AbyssalMgrService() { return require("../transport/abyssalMgrService"); },
  get AbyssalContentManagerService() { return require("../transport/abyssalContentManagerService"); },
});
