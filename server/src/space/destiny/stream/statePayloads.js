"use strict";

const {
  buildDict,
  buildKeyVal,
  buildList,
  currentFileTime,
} = require("../../../services/_shared/serviceHelpers");
const {
  requireEntityID,
} = require("../identity/entityID");
const {
  encodeEntityBall: defaultEncodeEntityBall,
} = require("./ballEncoding");
const {
  toInt32,
} = require("./primitives");

function normalizeStateStamp(stamp) {
  return toInt32(stamp, 0) >>> 0;
}

function isDestinyBallPayloadEntity(entity) {
  return Boolean(entity) && entity.omitDestinyBall !== true;
}

function encodeStateHeader(packetType, stamp) {
  const buffer = Buffer.alloc(5);
  buffer.writeUInt8(toInt32(packetType, 0) & 0xff, 0);
  buffer.writeUInt32LE(normalizeStateStamp(stamp), 1);
  return buffer;
}

function normalizeBallEntities(entities) {
  return (Array.isArray(entities) ? entities : [])
    .filter(isDestinyBallPayloadEntity);
}

function resolveEntityBallEncoder(deps) {
  if (deps && deps.encodeEntityBall !== undefined) {
    if (typeof deps.encodeEntityBall !== "function") {
      throw new TypeError("encodeEntityBall must be a function");
    }
    return deps.encodeEntityBall;
  }
  return defaultEncodeEntityBall;
}

function buildStateBuffer(packetType, stamp, entities, deps = {}) {
  const encodeEntityBall = resolveEntityBallEncoder(deps);
  const chunks = [encodeStateHeader(packetType, stamp)];
  for (const entity of normalizeBallEntities(entities)) {
    chunks.push(encodeEntityBall(entity, deps.encodeOptions || {}));
  }
  return Buffer.concat(chunks);
}

function buildAddBallsStateBuffer(stamp, entities, deps = {}) {
  return buildStateBuffer(1, stamp, entities, {
    ...deps,
    encodeOptions: {
      ...(deps.encodeOptions || {}),
      forAddBalls: true,
    },
  });
}

function buildSetStateBuffer(stamp, entities, deps = {}) {
  return buildStateBuffer(0, stamp, entities, deps);
}

function shouldBuildDamageState(entity, deps) {
  return Boolean(
    entity &&
    (
      entity.forceDamageState === true ||
      entity.kind === "station" ||
      (
        typeof deps.hasDamageableHealth === "function" &&
        deps.hasDamageableHealth(entity)
      )
    )
  );
}

function buildAddBallsExtraBallData(ballEntities, simFileTime, deps = {}) {
  if (typeof deps.buildSlimItemDict !== "function") {
    throw new TypeError("buildAddBallsExtraBallData requires buildSlimItemDict");
  }
  const buildDamageState = typeof deps.buildDamageState === "function"
    ? deps.buildDamageState
    : null;

  return normalizeBallEntities(ballEntities)
    .filter((entity) => entity.omitSlimItem !== true)
    .map((entity) => {
      const slimItem = deps.buildSlimItemDict(entity);
      if (buildDamageState && shouldBuildDamageState(entity, deps)) {
        return [slimItem, buildDamageState(entity, simFileTime)];
      }
      return slimItem;
    });
}

function buildAddBalls2Payload(
  stateStamp,
  entities,
  simFileTime = currentFileTime(),
  deps = {},
) {
  const ballEntities = normalizeBallEntities(entities);
  const state = buildAddBallsStateBuffer(stateStamp, ballEntities, deps);
  const extraBallData = buildAddBallsExtraBallData(
    ballEntities,
    simFileTime,
    deps,
  );
  return [
    "AddBalls2",
    [
      [
        state,
        buildList(extraBallData),
      ],
    ],
  ];
}

function isSetStateDependencyBag(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    return [
      "buildDamageState",
      "buildDroneState",
      "buildSlimItemObject",
      "buildSolItem",
      "encodeEntityBall",
      "hasDamageableHealth",
    ].some((name) => name in value);
  } catch (_error) {
    // ignored: an object that throws when inspected is not a state builder (false)
    return false;
  }
}

function resolveSetStateArguments(effectStateEntries, deps) {
  if (isSetStateDependencyBag(effectStateEntries)) {
    return {
      deps: effectStateEntries,
      effectStateEntries: [],
    };
  }
  return {
    deps: deps && typeof deps === "object" ? deps : {},
    effectStateEntries: Array.isArray(effectStateEntries)
      ? effectStateEntries
      : [],
  };
}

function buildSetStatePayload(
  stateStamp,
  system,
  egoEntityID,
  entities,
  simFileTime = currentFileTime(),
  dbuffStateEntries = [],
  effectStateEntries = [],
  deps = {},
) {
  const resolved = resolveSetStateArguments(effectStateEntries, deps);
  const stateDeps = resolved.deps;
  if (typeof stateDeps.buildSlimItemObject !== "function") {
    throw new TypeError("buildSetStatePayload requires buildSlimItemObject");
  }
  if (typeof stateDeps.buildDroneState !== "function") {
    throw new TypeError("buildSetStatePayload requires buildDroneState");
  }
  if (typeof stateDeps.buildSolItem !== "function") {
    throw new TypeError("buildSetStatePayload requires buildSolItem");
  }

  const ballEntities = normalizeBallEntities(entities);
  const buildDamageState = typeof stateDeps.buildDamageState === "function"
    ? stateDeps.buildDamageState
    : null;
  const damageEntries = buildDamageState
    ? ballEntities
      .filter((entity) => shouldBuildDamageState(entity, stateDeps))
      .map((entity) => [
        requireEntityID(entity.itemID, "SetState damage entityID"),
        buildDamageState(entity, simFileTime),
      ])
    : [];
  const slimEntities = ballEntities.filter((entity) => (
    entity.omitSlimItem !== true
  ));

  const state = buildKeyVal([
    ["stamp", stateStamp],
    ["state", buildSetStateBuffer(stateStamp, ballEntities, stateDeps)],
    ["ego", requireEntityID(egoEntityID, "SetState ego entityID")],
    ["industryLevel", 0],
    ["researchLevel", 0],
    ["damageState", buildDict(damageEntries)],
    [
      "dbuffState",
      buildList(Array.isArray(dbuffStateEntries) ? dbuffStateEntries : []),
    ],
    ["aggressors", buildDict([])],
    ["droneState", stateDeps.buildDroneState(ballEntities)],
    [
      "slims",
      buildList(slimEntities.map((entity) => (
        stateDeps.buildSlimItemObject(entity)
      ))),
    ],
    ["solItem", stateDeps.buildSolItem(system)],
    ["effectStates", buildList(resolved.effectStateEntries)],
    ["allianceBridges", buildList([])],
  ]);

  return ["SetState", [state]];
}

// DoDestinyUpdate(state, waitForBubble, dogmaMessages): the third element
// only for a character batch with Dogma events (michelle.py:482-511).
function buildDestinyUpdatePayload(
  updates,
  waitForBubble = false,
  dogmaMessages = null,
) {
  const updateList = buildList(
    (Array.isArray(updates) ? updates : []).map((update) => [
      update.stamp,
      update.payload,
    ]),
  );
  if (Array.isArray(dogmaMessages)) {
    return [updateList, waitForBubble, dogmaMessages];
  }
  return [updateList, waitForBubble];
}

module.exports = {
  buildAddBalls2Payload,
  buildAddBallsExtraBallData,
  buildAddBallsStateBuffer,
  buildDestinyUpdatePayload,
  buildSetStateBuffer,
  buildSetStatePayload,
  buildStateBuffer,
  encodeStateHeader,
  isDestinyBallPayloadEntity,
  normalizeBallEntities,
};
