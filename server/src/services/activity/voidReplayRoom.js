"use strict";

const { RUINED_ELECTRICAL, isVoidSystemID } = require("./voidReplayAdmission");

const ROOM_ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });
const ORIGIN_GATE_POSITION = Object.freeze({ x: 14_000, y: 0, z: 0 });
const VOID_REPLAY_ORIGIN = "historical_void";
const SITE_ID_BASE = 6_800_000_000_000;

// Replay layout. Wreck type IDs are from build 3396210. Placement and common
// loot quantities are authored because the dungeon header has no object graph.
const WRECKS = [
  [80029, -6000, 4000, 7000],
  [80030, 1000, 6000, -11_000],
  [80030, 12_000, -3000, 8000],
  [80029, -20_000, 7000, -8000],
  [80031, -23_000, 5000, 12_000],
  [80034, 20_000, 4000, 20_000],
  [80029, 9000, -8000, -28_000],
  [80031, -34_000, -6000, 16_000],
  [80034, 32_000, -4000, -17_000],
  [80035, 2000, 5000, 41_000],
];

function buildReplayPopulationHints() {
  return {
    containers: WRECKS.map(([typeID, x, y, z], index) => ({
      contentKey: `void-wreck:${index + 1}`,
      typeID,
      role: "void_relic",
      analyzer: "relic",
      hackingDifficulty: "easy",
      count: 1,
      positionOffset: { x, y, z },
      explicitLoot: [{ typeID: 80873, quantity: 1 }],
    })),
  };
}

function isVoidReplayInstance(instance) {
  return instance?.siteOrigin === VOID_REPLAY_ORIGIN &&
    instance.templateID === RUINED_ELECTRICAL.templateID &&
    instance.instanceScope === "private" &&
    instance.ownership?.visibilityScope === "private" &&
    Number.isSafeInteger(instance.ownership?.characterID) &&
    instance.ownership.characterID > 0 &&
    isVoidSystemID(instance.solarSystemID);
}

function createReplayRoom(systemID, characterID, state, nowMs) {
  if (!isVoidSystemID(systemID) || !Number.isSafeInteger(characterID) || characterID <= 0) {
    throw new Error("Invalid Void replay room identity");
  }
  const dungeon = require("../dungeon/dungeonRuntime");
  return dungeon.createInstance({
    templateID: RUINED_ELECTRICAL.templateID,
    solarSystemID: systemID,
    siteKey: `${VOID_REPLAY_ORIGIN}:${characterID}`,
    siteFamily: "relic",
    siteKind: "private",
    siteOrigin: VOID_REPLAY_ORIGIN,
    lifecycleState: "active",
    instanceScope: "private",
    ownership: { characterID, visibilityScope: "private" },
    position: ROOM_ORIGIN,
    nowMs,
    durable: true,
    metadata: {
      label: "Ruined Electrical",
      siteID: SITE_ID_BASE + dungeon.peekNextInstanceID(),
    },
    spawnState: { populationHints: buildReplayPopulationHints() },
    environmentState: { voidReplay: state },
  });
}

function buildOriginGate(instance) {
  const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
  const type = resolveItemByTypeID(RUINED_ELECTRICAL.originGateTypeID);
  return {
    kind: "accelerationGate",
    itemID: instance.metadata.siteID + 1_000_000_000,
    typeID: type.typeID,
    groupID: type.groupID,
    categoryID: type.categoryID,
    graphicID: type.graphicID,
    radius: type.radius,
    itemName: type.name,
    ownerID: 1,
    position: { ...ORIGIN_GATE_POSITION },
    direction: { x: -1, y: 0, z: 0 },
    velocity: { ...ROOM_ORIGIN },
    staticVisibilityScope: "bubble",
    dungeonMaterializedSiteContent: true,
    dungeonSiteInstanceID: instance.instanceID,
    dungeonSiteID: instance.metadata.siteID,
  };
}

function materializeReplayRoom(scene, instance, session) {
  if (!isVoidReplayInstance(instance) || scene?.systemID !== instance.solarSystemID ||
      Number(session?.characterID) !== instance.ownership.characterID) {
    return { success: false, errorMsg: "VOID_REPLAY_ROOM_FORBIDDEN" };
  }
  const materialized = require("../dungeon/dungeonUniverseSiteService").ensureSiteContentsMaterialized(
    scene, instance, { session, markCurrentDungeonRoom: true, broadcast: true, spawnEncounters: false },
  );
  if (!materialized.success) return materialized;
  const gate = buildOriginGate(instance);
  if (!scene.getEntityByID(gate.itemID)) {
    if (!scene.addStaticEntity(gate)) return { success: false, errorMsg: "VOID_REPLAY_GATE_UNAVAILABLE" };
    scene.broadcastAddBalls([gate]);
  }
  return { success: true, gateID: gate.itemID };
}

module.exports = {
  ROOM_ORIGIN,
  VOID_REPLAY_ORIGIN,
  isVoidReplayInstance,
  createReplayRoom,
  materializeReplayRoom,
};
