"use strict";

/**
 * EVE Service Manager
 *
 * Ported from EVEServiceManager in eve-server.cpp.
 * Registers game services by name and dispatches CALL_REQ to them.
 */

const path = require("path");
const log = require(path.join(__dirname, "../utils/logger"));

class ServiceManager {
  constructor() {
    this._services = new Map();
    this._boundObjects = new Map(); // OID string -> service instance
    this._boundObjectParams = new Map(); // OID string -> bind parameter (e.g. corporationID)
    this._boundObjectRefIDs = new Map(); // OID string -> refID (FILETIME) of the newest bind
    this._boundObjectSessions = new Map(); // OID string -> sessions explicitly given the reference
    this._boundObjectHolderCounts = new Map(); // OID string -> how many sessions hold it now
    this._sessionBoundObjects = new WeakMap(); // session -> OID strings it was given
  }

  /**
   * Register a service instance. The service must have a `name` property.
   * @param {BaseService} service
   */
  register(service) {
    const name = service.name;
    if (!name) {
      throw new Error("service must have a 'name' property!");
    }
    if (this._services.has(name)) {
      log.warn(`service already registered: ${name}`);
    }
    service.serviceManager = this;
    this._services.set(name, service);
    log.debug(`service registered: ${name}`);
  }

  /**
   * Register an alias for an already-registered service instance.
   * @param {string} alias
   * @param {string|BaseService} target
   */
  registerAlias(alias, target) {
    const normalizedAlias = String(alias || "").trim();
    if (!normalizedAlias) {
      throw new Error("alias must be a non-empty string");
    }
    const service =
      typeof target === "string"
        ? this.lookup(target)
        : target;
    if (!service) {
      throw new Error(`cannot register alias ${normalizedAlias}; target service not found`);
    }
    if (this._services.has(normalizedAlias)) {
      log.warn(`service alias already registered: ${normalizedAlias}`);
    }
    this._services.set(normalizedAlias, service);
    log.debug(`service alias registered: ${normalizedAlias} -> ${service.name}`);
  }

  /**
   * Register a bound object OID string -> service mapping.
   * Called whenever a service creates a bound object via MachoBindObject.
   */
  registerBoundObject(oidString, service, refID = null, session = null) {
    this._boundObjects.set(oidString, service);
    if (session) this.registerBoundObjectSession(oidString, session);
    if (typeof refID === "bigint") {
      const previous = this._boundObjectRefIDs.get(oidString);
      if (previous === undefined || refID > previous) {
        this._boundObjectRefIDs.set(oidString, refID);
      }
    }
    log.debug(`bound object registered: ${oidString} -> ${service.name}`);
  }

  registerBoundObjectSession(oidString, session) {
    if (typeof oidString !== "string" || !oidString || !session || typeof session !== "object") return;
    let owners = this._boundObjectSessions.get(oidString);
    if (!owners) {
      owners = new WeakSet();
      this._boundObjectSessions.set(oidString, owners);
    }
    if (owners.has(session)) return;
    owners.add(session);
    this._boundObjectHolderCounts.set(oidString, (this._boundObjectHolderCounts.get(oidString) || 0) + 1);
    let given = this._sessionBoundObjects.get(session);
    if (!given) {
      given = new Set();
      this._sessionBoundObjects.set(session, given);
    }
    given.add(oidString);
  }

  /**
   * A session's connection has closed: the bound objects it was given are let
   * go for it, and those no other session holds are released as a client's
   * ClientHasReleasedTheseObjects releases them (unregisterBoundObject). A
   * client releases an object when it lets go of it, but not at a disconnect,
   * and a client that never releases (a BFF pilot without the client's own
   * Python) would otherwise leave every object it bound registered for as long
   * as the server runs. Answers how many were released.
   */
  releaseSessionBoundObjects(session) {
    const given = session && this._sessionBoundObjects.get(session);
    if (!given) return 0;
    this._sessionBoundObjects.delete(session);
    let released = 0;
    for (const oidString of given) {
      const owners = this._boundObjectSessions.get(oidString);
      if (!owners || !owners.has(session)) continue;
      const holders = (this._boundObjectHolderCounts.get(oidString) || 1) - 1;
      if (holders > 0) {
        owners.delete(session);
        this._boundObjectHolderCounts.set(oidString, holders);
        continue;
      }
      try {
        if (this.unregisterBoundObject(oidString, { session })) released += 1;
      } catch (error) {
        log.warn(`bound object ${oidString} could not be released at its session's close: ${error.message}`);
      }
    }
    return released;
  }

  canAccessBoundObject(oidString, session) {
    return Boolean(session && this._boundObjectSessions.get(oidString)?.has(session));
  }

  /**
   * Record the bind parameter a bound object was created with (e.g. the
   * corporationID a corpRegistry object is bound to). This lets bound-object
   * method handlers operate on the entity that was bound rather than falling
   * back to the caller's own session entity.
   */
  registerBoundObjectParams(oidString, params) {
    if (typeof oidString !== "string" || oidString === "") {
      return;
    }
    this._boundObjectParams.set(oidString, params);
  }

  /**
   * Release a bound object after the client sends
   * ObjectCallGPCS.ClientHasReleasedTheseObjects with matching OID- metadata.
   *
   * TQ removes both the dispatch registration and the bind parameters.  A
   * service may expose onBoundObjectReleased for additional cleanup; the
   * common _boundContexts Map is cleaned as a compatibility fallback.
   */
  unregisterBoundObject(oidString, options = {}) {
    if (typeof oidString !== "string" || oidString === "") {
      return false;
    }
    // Internal cleanup may omit a session. A client release must belong to a
    // session which was actually given this reference, including shared trades.
    if (options.session && !this.canAccessBoundObject(oidString, options.session)) return false;
    const candidate = this._boundObjects.get(oidString);
    if (candidate?.canReleaseBoundObject && !candidate.canReleaseBoundObject(oidString, options)) return false;

    // A service that reuses one OID per session hands it out again on every
    // bind, each time with a newer refID. A release naming an older refID was
    // queued for a connection the client has since replaced, so keep the object.
    const releasedRefID = options && options.releasedRefID;
    const latestRefID = this._boundObjectRefIDs.get(oidString);
    if (
      typeof releasedRefID === "bigint" &&
      typeof latestRefID === "bigint" &&
      releasedRefID < latestRefID
    ) {
      log.debug(
        `bound object release ignored: ${oidString} released refID ${releasedRefID} < bound refID ${latestRefID}`,
      );
      return false;
    }
    this._boundObjectRefIDs.delete(oidString);

    const service = this._boundObjects.get(oidString) || null;
    const preserveReusableSessionIdentity = Boolean(
      service && service.reuseBoundObjectForSession === true,
    );
    const existed = this._boundObjects.delete(oidString);
    this._boundObjectParams.delete(oidString);
    this._boundObjectSessions.delete(oidString);
    this._boundObjectHolderCounts.delete(oidString);

    if (service && typeof service.onBoundObjectReleased === "function") {
      service.onBoundObjectReleased(oidString, options);
    } else if (service && service._boundContexts instanceof Map) {
      service._boundContexts.delete(oidString);
    }

    const session = options && options.session;
    if (session && session._boundObjectIDs && typeof session._boundObjectIDs === "object") {
      for (const [serviceName, objectID] of Object.entries(session._boundObjectIDs)) {
        if (objectID === oidString && !preserveReusableSessionIdentity) {
          delete session._boundObjectIDs[serviceName];
        }
      }
    }
    if (session && session._boundObjectState && typeof session._boundObjectState === "object") {
      for (const [serviceName, state] of Object.entries(session._boundObjectState)) {
        if (state && state.objectID === oidString) {
          delete session._boundObjectState[serviceName];
        }
      }
    }
    if (session && session.currentBoundObjectID === oidString) {
      session.currentBoundObjectID = null;
    }
    if (session && session.lastBoundObjectID === oidString) {
      session.lastBoundObjectID = null;
    }

    if (existed) {
      log.debug(`bound object released: ${oidString}`);
    }
    return existed;
  }

  /**
   * Look up the bind parameter recorded for a bound object OID.
   * Returns null when the OID is unknown or has no recorded parameter.
   */
  getBoundObjectParams(oidString) {
    if (typeof oidString !== "string" || oidString === "") {
      return null;
    }
    return this._boundObjectParams.has(oidString)
      ? this._boundObjectParams.get(oidString)
      : null;
  }

  /**
   * Look up a registered service by name, also checking bound object OIDs.
   * @param {string} name
   * @returns {BaseService|null}
   */
  lookup(name, session = undefined) {
    const service = this._services.get(name);
    if (service) return service;
    // Server-side lookups omit the session. Client dispatch always supplies it;
    // internal-only registrations without an owner cannot be guessed remotely.
    if (session !== undefined && !this.canAccessBoundObject(name, session)) return null;
    return this._boundObjects.get(name) || null;
  }

  /**
   * Get a list of all registered service names.
   */
  getServiceNames() {
    return Array.from(this._services.keys());
  }

  /**
   * Get the total number of registered services.
   */
  get count() {
    return this._services.size;
  }
}

module.exports = ServiceManager;
