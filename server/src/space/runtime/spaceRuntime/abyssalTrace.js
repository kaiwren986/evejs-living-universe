"use strict";

const {
  ABYSSAL_TRACE_LIFECYCLE_PHASE,
  applyAbyssalTraceProfileToEntity,
  resolveAbyssalTraceProfile,
} = require("../../../abyssal").engineSupport.traceProfiles;
const {
  isReadyForDestiny,
} = require("../destinyDeliveryEligibility");
const {
  toInt,
} = require("../../../common/numbers");

module.exports = {

publishAbyssalTraceInitial(systemID, traceItemID, options = {}) {
    const scene = this.getSceneByDescriptor({
      sceneKind: "solarSystem",
      solarSystemID: toInt(systemID, 0),
      locationID: toInt(systemID, 0),
    });
    if (!scene) {
      return {
        success: false,
        errorMsg: "SOURCE_SCENE_NOT_FOUND",
        data: null,
      };
    }
    return scene.publishAbyssalTraceInitial(traceItemID, options);
  },

updateAbyssalTracePresentation(systemID, traceItemID, traceState) {
    const scene = this.getSceneByDescriptor({
      sceneKind: "solarSystem",
      solarSystemID: toInt(systemID, 0),
      locationID: toInt(systemID, 0),
    });
    const traceEntity = scene && scene.getEntityByID(toInt(traceItemID, 0));
    if (!scene || !traceEntity || traceEntity.evejsAbyssalTrace !== true) {
      return {
        success: false,
        errorMsg: scene ? "ABYSSAL_TRACE_ENTITY_MISSING" : "SOURCE_SCENE_NOT_FOUND",
      };
    }
    applyAbyssalTraceProfileToEntity(traceEntity, traceState);
    const recipientCount = scene.broadcastSlimItemChanges([traceEntity]);
    return {
      success: true,
      data: { traceEntity, recipientCount },
    };
  },

activateAbyssalTrace(session, traceItemID, traceState, options = {}) {
    if (!session || !session._space || !isReadyForDestiny(session)) {
      return { success: false, errorMsg: "DESTINY_NOT_READY" };
    }
    const scene = this.getSceneForSession(session);
    const traceEntity = scene && scene.getEntityByID(toInt(traceItemID, 0));
    const shipID = toInt(options.shipID, toInt(session._space.shipID, 0));
    const shipEntity = scene && scene.getEntityByID(shipID);
    if (!scene || !traceEntity || traceEntity.evejsAbyssalTrace !== true) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_ENTITY_MISSING" };
    }
    if (!shipEntity) {
      return { success: false, errorMsg: "SHIP_NOT_FOUND" };
    }
    return scene.sendAbyssalTraceActivationBundle(traceEntity, shipEntity, {
      ...options,
      traceState,
      actorSession: session,
    });
  },

validateAbyssalTracePublicationReceipt(
    session,
    traceItemID,
    publicationReceipt,
  ) {
    if (!session || !session._space || !isReadyForDestiny(session)) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_ACTOR_NOT_READY" };
    }
    const scene = this.getSceneForSession(session);
    const traceEntity = scene && scene.getEntityByID(toInt(traceItemID, 0));
    if (!scene || !traceEntity || traceEntity.evejsAbyssalTrace !== true) {
      return { success: false, errorMsg: "ABYSSAL_TRACE_ENTITY_MISSING" };
    }
    return scene.validateAbyssalTracePublicationReceipt(
      session,
      traceEntity,
      publicationReceipt,
    );
  },
};
