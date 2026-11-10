"use strict";

// Engine-side consumers receive named, fixed capabilities through the public
// facade. The underlying modules retain their existing singleton identities.
module.exports = Object.freeze({
  get hostLocation() { return require("../domain/abyssalHostLocation"); },
  get gateActivationRange() { return require("../runtime/abyssalGateActivationRange"); },
  get gatePresentation() { return require("../domain/abyssalGatePresentation"); },
  get roomEntityRoles() { return require("../domain/abyssalRoomEntityRoles"); },
  get suppressorDiagnostics() { return require("../runtime/controllers/abyssalSuppressorDiagnostics"); },
  get traceProfiles() { return require("../catalog/abyssalTraceProfiles"); },
  get activationRules() { return require("../runtime/abyssalActivationPolicy"); },
  get inventoryClassification() { return require("../runtime/abyssalInventoryClassification"); },
  get tracePublicationReceipts() { return require("../runtime/abyssalTracePublicationReceipts"); },
  get sceneKey() { return require("../domain/abyssalSceneKey"); },
  get valueUtils() { return require("../domain/abyssalValueUtils"); },
  get npcSpawnTables() { return require("../catalog/content/qsnaAbyssalSpawnTables.generated.json"); },
  get filamentCompensationStore() { return require("../state/abyssalFilamentCompensationStore"); },
  get enginePort() { return require("../ports/abyssalEnginePort"); },
  get runtimeConstants() { return require("../catalog/abyssalRuntimeConstants"); },
});
