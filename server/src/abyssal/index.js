"use strict";

// Published capabilities are cold until selected. Host identity and registration
// must not bootstrap the engine or form a catalogue/runtime import cycle.
module.exports = Object.freeze({
  get activationPolicy() { return require("./policy/abyssalPublishedActivationPolicy"); },
  get beyonceIntegration() { return require("./policy/abyssalBeyonceIntegration"); },
  get chatIntegration() { return require("./policy/abyssalChatIntegration"); },
  get jettisonIntegration() { return require("./policy/abyssalJettisonIntegration"); },
  get lifecycleHooks() { return require("./policy/abyssalLifecycleHooks"); },
  get orbitalLaunchPolicy() { return require("./policy/abyssalOrbitalLaunchPolicy"); },
  get scanIntegration() { return require("./policy/abyssalScanIntegration"); },
  get scenePolicy() { return require("./policy/abyssalScenePolicy"); },
  get spaceRuntimeIntegration() { return require("./policy/abyssalSpaceRuntimeIntegration"); },
  get staffTools() { return require("./policy/abyssalStaffTools"); },
  get transportActions() { return require("./policy/abyssalTransportActions"); },
  get transitionIntegration() { return require("./policy/abyssalTransitionIntegration"); },
  get visibilityPolicy() { return require("./policy/abyssalVisibilityPolicy"); },
  get weatherPolicy() { return require("./policy/abyssalWeatherPolicy"); },
  get engineSupport() { return require("./policy/engineSupport"); },
  get transport() { return require("./policy/transport"); },
});
