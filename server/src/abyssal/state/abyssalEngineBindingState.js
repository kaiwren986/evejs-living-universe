"use strict";

class AbyssalEngineBindingState {
  #configuredEnginePort = null;

  #testDependencyOverrides = null;

  configureEnginePort(validatedPort) {
    if (!validatedPort || typeof validatedPort !== "object") {
      throw new TypeError("validatedPort must be an object");
    }
    if (this.#configuredEnginePort && this.#configuredEnginePort !== validatedPort) {
      const error = new Error("ABYSSAL_ENGINE_PORT_ALREADY_CONFIGURED");
      error.code = "ABYSSAL_ENGINE_PORT_ALREADY_CONFIGURED";
      throw error;
    }
    const changed = this.#configuredEnginePort !== validatedPort;
    this.#configuredEnginePort = validatedPort;
    return { success: true, changed };
  }

  getConfiguredEnginePort() {
    return this.#configuredEnginePort;
  }

  setTestDependencyOverrides(overrides) {
    this.#testDependencyOverrides = overrides || null;
  }

  getTestDependencyOverrides() {
    return this.#testDependencyOverrides;
  }

  reset() {
    this.#configuredEnginePort = null;
    this.#testDependencyOverrides = null;
  }
}

function createAbyssalEngineBindingState() {
  return new AbyssalEngineBindingState();
}

const abyssalEngineBindingState = createAbyssalEngineBindingState();

module.exports = {
  AbyssalEngineBindingState,
  abyssalEngineBindingState,
  createAbyssalEngineBindingState,
};
