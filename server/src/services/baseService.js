"use strict";

/**
 * Base Service
 *
 * All game services extend this. Provides method dispatch and
 * a standard interface for the service manager.
 */

const path = require("path");
const log = require(path.join(__dirname, "../utils/logger"));
const serviceCallShapeCapture = require(path.join(
  __dirname,
  "_shared/serviceCallShapeCapture",
));

function normalizeMethodName(method) {
  if (typeof method === "string") {
    return method;
  }
  if (Buffer.isBuffer(method)) {
    return method.toString("utf8");
  }
  if (
    method &&
    typeof method === "object" &&
    typeof method.value === "string"
  ) {
    return method.value;
  }
  if (
    method &&
    typeof method === "object" &&
    Buffer.isBuffer(method.value)
  ) {
    return method.value.toString("utf8");
  }
  if (method === null || method === undefined) {
    return "";
  }
  return String(method);
}

class BaseService {
  static normalizeMethodName(method) {
    return normalizeMethodName(method);
  }

  constructor(name) {
    this._name = name;
  }

  get name() {
    return this._name;
  }

  /**
   * Called by the packet dispatcher to invoke a method on this service.
   * Override this to add custom dispatch logic, or just define methods
   * Handle_<method> methods in your subclass and this will find them automatically.
   *
   * @param {string} method - Method name from the call request
   * @param {Array} args - Arguments from the call request
   * @param {object} session - Client session
   * @param {object} kwargs - Keyword arguments from the call request
   * @param {object} callContext - Transport-scoped request metadata
   * @returns {*} Result to send back to the client
   */
  callMethod(method, args, session, kwargs, callContext = null) {
    const normalizedMethod = normalizeMethodName(method);
    if (session?.characterID || session?.charid) {
      require("./character/homeStationSelfDestructRuntime")
        .assertServiceActionAllowed(session, this._name, normalizedMethod);
    }
    if (session?._safeLogoff) {
      require("./ship/safeLogoffRuntime").handleServiceAction(session, this._name, normalizedMethod);
    }
    const startedAtMs = Date.now();
    const captureResult = (handlerName, result, extra = {}) => {
      serviceCallShapeCapture.captureServiceCall({
        service: this._name,
        method: normalizedMethod,
        handlerName,
        args,
        kwargs,
        session,
        result,
        elapsedMs: Date.now() - startedAtMs,
        ...extra,
      });
    };
    const captureError = (handlerName, error, extra = {}) => {
      serviceCallShapeCapture.captureServiceCall({
        service: this._name,
        method: normalizedMethod,
        handlerName,
        args,
        kwargs,
        session,
        error,
        elapsedMs: Date.now() - startedAtMs,
        ...extra,
      });
    };
    // Only explicitly exported RPC handlers are remotely callable. Falling
    // back to arbitrary instance/prototype methods exposes internal authority
    // helpers, setters, lifecycle hooks and even callMethod itself to clients.
    const handlerName = `Handle_${normalizedMethod}`;
    if (typeof this[handlerName] === "function") {
      try {
        const result = this[handlerName](args, session, kwargs, callContext);
        if (result && typeof result.then === "function") {
          return result.then(
            (resolvedResult) => {
              captureResult(handlerName, resolvedResult);
              return resolvedResult;
            },
            (error) => {
              captureError(handlerName, error);
              throw error;
            },
          );
        }
        captureResult(handlerName, result);
        return result;
      } catch (error) {
        captureError(handlerName, error);
        throw error;
      }
    }
    log.warn(`[${this._name}] Unhandled method: ${normalizedMethod}`);
    captureResult(null, null, { unhandled: true });
    return null;
  }
}

module.exports = BaseService;
