"use strict";
const { toInt, normalizeText, toReal, getObjectItemID, getObjectPosition, getObjectRadius, normalizeLowerText, getVectorDistance } = require("../domain/abyssalRuntimeValues");

function buildValidationError(ports, code, details = {}, kind = "") {
  const {
    ABYSS_ERROR,
    cloneValue,
  } = ports;
  return {
    code: toInt(code, ABYSS_ERROR.UNKNOWN_ERROR),
    // Internal-only discriminator. Several refusals share a client code, so
    // handler branching keys off this (or details.reason), never off `code`.
    kind: normalizeText(kind, ""),
    details: cloneValue(details),
  };
}

function normalizeSecurityBand(ports, security) {
  const rawValue = toReal(security, -1);
  const value = Math.round(rawValue * 10) / 10;
  if (value >= 1.0) {
    return 1.0;
  }
  if (value >= 0.9) {
    return 0.9;
  }
  if (value >= 0.8) {
    return 0.8;
  }
  if (value >= 0.7) {
    return 0.7;
  }
  if (value >= 0.6) {
    return 0.6;
  }
  return 0.5;
}

function getAbyssalShipCloakMode(ports, shipEntity) {
  return toInt(
    shipEntity && (
      shipEntity.isCloaked ??
      shipEntity.cloakMode ??
      shipEntity.cloaked
    ),
    0,
  );
}

function hasActiveAbyssalCynosuralGeneration(ports, shipEntity) {
  if (!shipEntity || !(shipEntity.activeModuleEffects instanceof Map)) {
    return false;
  }
  return [...shipEntity.activeModuleEffects.values()].some((effectState) => (
    effectState &&
    effectState.cynosuralGeneration === true &&
    toReal(effectState.deactivatedAtMs, 0) <= 0
  ));
}

function listAbyssalValidationSceneEntities(ports, scene) {
  if (!scene || typeof scene !== "object") {
    return [];
  }
  const entities = [];
  const seen = new Set();
  const append = (entity) => {
    if (!entity || typeof entity !== "object") {
      return;
    }
    const itemID = getObjectItemID(entity);
    const key = itemID > 0 ? `item:${itemID}` : entity;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entities.push(entity);
  };
  for (const source of [
    scene.staticEntities,
    scene.staticEntitiesByID,
    scene.dynamicEntities,
  ]) {
    if (source instanceof Map) {
      for (const entity of source.values()) {
        append(entity);
      }
    } else if (Array.isArray(source)) {
      for (const entity of source) {
        append(entity);
      }
    }
  }
  return entities;
}

function isAbyssalShipInsideForceField(ports, scene, shipEntity, deps) {
  const {
    resolveTypeRecord,
    FORCE_FIELD_GROUP_ID,
  } = ports;
  const shipPosition = getObjectPosition(shipEntity);
  if (!shipPosition) {
    return false;
  }
  const shipRadius = Math.max(0, getObjectRadius(shipEntity));
  return listAbyssalValidationSceneEntities(ports, scene).some((entity) => {
    if (!entity || entity === shipEntity) {
      return false;
    }
    const typeRecord = resolveTypeRecord(entity, deps);
    const groupID = toInt(entity.groupID, toInt(typeRecord && typeRecord.groupID, 0));
    const kind = normalizeLowerText(entity.kind, "");
    if (groupID !== FORCE_FIELD_GROUP_ID && kind !== "forcefield" && kind !== "force field") {
      return false;
    }
    const fieldPosition = getObjectPosition(entity);
    const fieldRadius = getObjectRadius(entity, typeRecord);
    return Boolean(
      fieldPosition &&
      fieldRadius > 0 &&
      getVectorDistance(shipPosition, fieldPosition) + shipRadius < fieldRadius
    );
  });
}

function buildAbyssalShipStateBlock(ports, reason, details = {}, code = 0) {
  const {
    ABYSSAL_SHIP_STATE_CLIENT_CODE,
    CLIENT_ABYSS_ERROR,
    cloneValue,
  } = ports;
  const resolvedCode = toInt(code, 0) > 0
    ? toInt(code, 0)
    : toInt(
      ABYSSAL_SHIP_STATE_CLIENT_CODE[reason],
      CLIENT_ABYSS_ERROR.UNKNOWN_ERROR,
    );
  return {
    code: resolvedCode,
    details: {
      reason,
      ...cloneValue(details),
    },
  };
}

function resolveAbyssalSecurityPolicy(ports, tier, security) {
  const normalizedTier = Math.max(0, Math.min(6, toInt(tier, 1)));
  const normalizedSecurity = normalizeSecurityBand(ports, security);
  const policy = {
    tier: normalizedTier,
    security: toReal(security, 0),
    normalizedSecurity,
    allowed: true,
    suspectRequired: false,
    maxTierWithoutSuspect: 6,
    reason: "ALLOWED",
  };
  if (normalizedSecurity >= 0.9) {
    policy.maxTierWithoutSuspect = 0;
    if (normalizedTier > 0) {
      policy.allowed = false;
      policy.reason = "VERY_SECURE_SYSTEM_DISALLOWED";
    }
    return policy;
  }
  if (normalizedSecurity >= 0.8) {
    policy.maxTierWithoutSuspect = 3;
  } else if (normalizedSecurity >= 0.7) {
    policy.maxTierWithoutSuspect = 4;
  } else if (normalizedSecurity >= 0.6) {
    policy.maxTierWithoutSuspect = 5;
  }
  if (normalizedTier > policy.maxTierWithoutSuspect) {
    policy.suspectRequired = true;
    policy.reason = "SUSPECT_REQUIRED";
  }
  return policy;
}

function buildAbyssalSecurityRestrictionNotify(ports, details = {}) {
  const reason = normalizeText(details && details.reason, "");
  if (reason === "VERY_SECURE_SYSTEM_DISALLOWED") {
    return "Only Tranquil (Tier 0) Abyssal filaments can be activated in 0.9 or 1.0 security systems.";
  }
  return "";
}

function createAbyssalAdmissionPolicies(ports) {
  return {
    buildValidationError: buildValidationError.bind(null, ports),
    normalizeSecurityBand: normalizeSecurityBand.bind(null, ports),
    getAbyssalShipCloakMode: getAbyssalShipCloakMode.bind(null, ports),
    hasActiveAbyssalCynosuralGeneration: hasActiveAbyssalCynosuralGeneration.bind(null, ports),
    listAbyssalValidationSceneEntities: listAbyssalValidationSceneEntities.bind(null, ports),
    isAbyssalShipInsideForceField: isAbyssalShipInsideForceField.bind(null, ports),
    buildAbyssalShipStateBlock: buildAbyssalShipStateBlock.bind(null, ports),
    resolveAbyssalSecurityPolicy: resolveAbyssalSecurityPolicy.bind(null, ports),
    buildAbyssalSecurityRestrictionNotify: buildAbyssalSecurityRestrictionNotify.bind(null, ports),
  };
}

module.exports = { createAbyssalAdmissionPolicies };
