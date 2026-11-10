"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const {
  captureFittedGenericModuleAttributeSnapshots,
  notifyFittedGenericModuleAttributeDiffToSession,
} = require("../attributeChangeNotification");
const {
  notifyCommandBurstDbuffStateToSession,
} = require("../commandBurst");
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");

module.exports = {

clearContinuousDbuffSource(entityOrID, sourceKey, options = {}) {
    const entity = entityOrID && typeof entityOrID === "object"
      ? entityOrID
      : this.getEntityByID(toInt(entityOrID, 0));
    if (!entity || entity.kind !== "ship") {
      return { changed: false, success: false, errorMsg: "SHIP_NOT_FOUND", clientState: [] };
    }
    const nowMs = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());
    const session = entity.session && isReadyForDestiny(entity.session)
      ? entity.session
      : null;
    const beforeModuleAttributes = session
      ? captureFittedGenericModuleAttributeSnapshots(entity, { session, nowMs })
      : new Map();
    const result = commandBurstRuntime.clearContinuousDbuffSource(
      entity,
      sourceKey,
      nowMs,
    );
    let moduleAttributeChangeCount = 0;
    if (result.changed) {
      this.refreshShipEntityDerivedState(entity, {
        session: entity.session || null,
        broadcast: true,
        notifyTargeting: true,
        notifyGenericModuleAttributes: false,
      });
      if (session) {
        notifyCommandBurstDbuffStateToSession(this, session, entity, nowMs, {
          reason: options.reason || "continuous-dbuff-remove",
          force: true,
        });
        const afterModuleAttributes = captureFittedGenericModuleAttributeSnapshots(
          entity,
          { session, nowMs },
        );
        moduleAttributeChangeCount = notifyFittedGenericModuleAttributeDiffToSession(
          session,
          beforeModuleAttributes,
          afterModuleAttributes,
          nowMs,
        ).changeCount;
      }
    }
    return { success: true, ...result, moduleAttributeChangeCount };
  },

setContinuousDbuffSource(entityOrID, sourceKey, collectionValues, options = {}) {
    const entity = entityOrID && typeof entityOrID === "object"
      ? entityOrID
      : this.getEntityByID(toInt(entityOrID, 0));
    if (!entity || entity.kind !== "ship") {
      return { changed: false, success: false, errorMsg: "SHIP_NOT_FOUND", clientState: [] };
    }
    const nowMs = toFiniteNumber(options.nowMs, this.getCurrentSimTimeMs());
    const session = entity.session && isReadyForDestiny(entity.session)
      ? entity.session
      : null;
    const beforeModuleAttributes = session
      ? captureFittedGenericModuleAttributeSnapshots(entity, { session, nowMs })
      : new Map();
    const result = commandBurstRuntime.setContinuousDbuffSource(
      entity,
      sourceKey,
      collectionValues,
      nowMs,
    );
    let moduleAttributeChangeCount = 0;
    if (result.changed) {
      this.refreshShipEntityDerivedState(entity, {
        session: entity.session || null,
        broadcast: true,
        notifyTargeting: true,
        notifyGenericModuleAttributes: false,
      });
      if (session) {
        notifyCommandBurstDbuffStateToSession(this, session, entity, nowMs, {
          reason: options.reason || "continuous-dbuff-apply",
          force: true,
        });
        const afterModuleAttributes = captureFittedGenericModuleAttributeSnapshots(
          entity,
          { session, nowMs },
        );
        moduleAttributeChangeCount = notifyFittedGenericModuleAttributeDiffToSession(
          session,
          beforeModuleAttributes,
          afterModuleAttributes,
          nowMs,
        ).changeCount;
      }
    }
    return {
      success: result.unresolvedCollectionIDs.length <= 0,
      ...result,
      moduleAttributeChangeCount,
    };
  },
};
