"use strict";

const runtimeFacade = require("../runtime/abyssalRuntimeFacade");

function createPublishedFacade(propertyNames) {
  const facade = {};
  for (const propertyName of propertyNames) {
    if (!Object.hasOwn(runtimeFacade, propertyName)) {
      throw new Error(`ABYSSAL_PUBLISHED_FACADE_OPERATION_MISSING:${propertyName}`);
    }
    Object.defineProperty(facade, propertyName, {
      enumerable: true,
      get() {
        return runtimeFacade[propertyName];
      },
    });
  }
  return Object.freeze(facade);
}

module.exports = { createPublishedFacade };
