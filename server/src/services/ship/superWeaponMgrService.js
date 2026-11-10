"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  findItemById,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  isModuleOnline,
  getTypeEffectRecords,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));

function normalizePoint(point) {
  let coordinates = null;
  if (Array.isArray(point) && point.length >= 3) {
    coordinates = [point[0], point[1], point[2]];
  } else if (point && typeof point === "object") {
    coordinates = [point.x, point.y, point.z];
  }
  if (!coordinates) {
    return null;
  }

  const normalized = coordinates.map((value) => {
    const unwrapped = value && typeof value === "object" && "value" in value
      ? value.value
      : value;
    return typeof unwrapped === "number" && Number.isFinite(unwrapped)
      ? unwrapped
      : null;
  });
  if (!normalized.every(Number.isFinite)) {
    return null;
  }
  return {
    x: normalized[0],
    y: normalized[1],
    z: normalized[2],
  };
}

// V24 positionalControl sends SinglePointPath/ArcPath render-space points
// directly. Unlike movement, it does not add GetCurrentEgoPos(). Translate
// once at the RPC boundary; runtime/NPC activation already uses world points.
function toWorldPoint(point, origin) {
  return point && origin ? {
    x: point.x + origin.x,
    y: point.y + origin.y,
    z: point.z + origin.z,
  } : null;
}

function getAimOrigin(session) {
  const scene = session && session._space && spaceRuntime.getSceneForSession(session);
  const entity = scene && scene.getShipEntityForSession(session);
  return normalizePoint(entity && entity.position);
}

function midpoint(left, right) {
  return {
    x: (Number(left.x) + Number(right.x)) / 2,
    y: (Number(left.y) + Number(right.y)) / 2,
    z: (Number(left.z) + Number(right.z)) / 2,
  };
}

class SuperWeaponMgrService extends BaseService {
  constructor() {
    super("superWeaponMgr");
  }

  Handle_ActivateSinglePointTargetedModule(args, session, kwargs) {
    void kwargs;

    const moduleID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    const effectID = Number(args && args.length > 1 ? args[1] : 0) || 0;
    const point = toWorldPoint(
      normalizePoint(args && args.length > 2 ? args[2] : null),
      getAimOrigin(session),
    );
    const moduleItem = findItemById(moduleID);
    if (!session || !session._space || !moduleItem || !isModuleOnline(moduleItem) || !point) {
      return null;
    }

    let effectName = null;
    if (effectID > 0) {
      const effectRecord = getTypeEffectRecords(moduleItem.typeID).find(
        (candidate) => Number(candidate && candidate.effectID) === effectID,
      );
      if (!effectRecord) {
        return null;
      }
      effectName = effectRecord.name;
    }

    const result = spaceRuntime.activateGenericModule(session, moduleItem, effectName, {
      targetPoint: point,
      repeat: 1,
    });
    return result && result.success ? 1 : null;
  }

  Handle_ActivateSlashModule(args, session, kwargs) {
    void kwargs;

    const moduleID = Number(args && args.length > 0 ? args[0] : 0) || 0;
    const origin = getAimOrigin(session);
    const startPoint = toWorldPoint(normalizePoint(args && args.length > 1 ? args[1] : null), origin);
    const endPoint = toWorldPoint(normalizePoint(args && args.length > 2 ? args[2] : null), origin);
    const moduleItem = findItemById(moduleID);
    if (!session || !session._space || !moduleItem || !isModuleOnline(moduleItem) || !startPoint || !endPoint) {
      return null;
    }

    const result = spaceRuntime.activateGenericModule(session, moduleItem, null, {
      targetPoint: midpoint(startPoint, endPoint),
      slashStartPoint: startPoint,
      slashEndPoint: endPoint,
      repeat: 1,
    });
    return result && result.success ? 1 : null;
  }
}

module.exports = SuperWeaponMgrService;
