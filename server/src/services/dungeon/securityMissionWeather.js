"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  DESTINY_BALL_FLAG,
  resolveSiteEnvironmentPropDestinyPresentation,
  DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2,
} = require("../../space/destiny/presentation/siteEnvironment");

// Target client 3396210 types + environmenttemplateanchortypeids. These are
// presentation anchors; no dogma or damage policy exists on these type records.
const NATIVE_TYPES = Object.freeze({
  19749: { name: "Celestial Environment", graphicID: 2721, templateID: 2705 },
  19753: { name: "Toxic Cloud Environment", graphicID: 2726, templateID: 2709 },
  19756: { name: "Xenon Gas Environment", graphicID: 2731, templateID: 2712 },
});
// TQ AddBalls2 records for 19749 and 19753 send these as FREE|MASSIVE with mass 10.
// TODO: No capture has 19756; it follows the two others in its group.
const NATIVE_BALL = Object.freeze({
  destinyBallFlags: DESTINY_BALL_FLAG.IS_FREE | DESTINY_BALL_FLAG.IS_MASSIVE,
  mass: 10,
});
const ITEM_ID_BASE = 6_900_000_000_000;
const ITEM_ID_SPAN = 100_000_000_000n;

function fail(message) {
  throw new Error(`SECURITY_NATIVE_WEATHER_INVALID: ${message}`);
}

function positiveID(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(label);
  return value;
}

function vector(value, label) {
  if (!Array.isArray(value) || value.length !== 3 ||
      !value.every((axis) => typeof axis === "number" && Number.isFinite(axis))) fail(label);
  return { x: value[0], y: value[1], z: value[2] };
}

// The caller supplies a template obtained from dungeonAuthority, whose installed
// Security binding gate is the trust boundary. Never use persisted population
// overrides as authority for these native objects.
function buildNativeWeatherEntities(instance, siteEntity, template) {
  if (!template || !template.securityMission || typeof template.securityMission !== "object" ||
      Array.isArray(template.securityMission)) return [];
  const objects = template.populationHints && template.populationHints.weatherObjects;
  if (objects === undefined || Array.isArray(objects) && objects.length === 0) return [];
  if (!Array.isArray(objects)) fail("weatherObjects must be an array");
  if (!instance || typeof instance !== "object" || !siteEntity || typeof siteEntity !== "object") fail("instance/site required");
  const mission = template.securityMission;
  const content = template.clientDungeonContent;
  if (template.templateID !== `security-mission:${positiveID(mission.missionID, "missionID")}` ||
      instance.templateID !== template.templateID ||
      template.source !== "client_static_3579973" || !content ||
      content.source !== "client_static_3579973" ||
      content.dungeonID !== positiveID(mission.dungeonID, "dungeonID") ||
      template.sourceDungeonID !== content.dungeonID || !Array.isArray(content.objects)) fail("native source binding");
  const instanceID = positiveID(instance.instanceID, "instanceID");
  const siteID = positiveID(siteEntity.itemID, "siteID");
  const systemID = positiveID(instance.solarSystemID, "solarSystemID");
  const origin = siteEntity.position;
  if (!origin || !["x", "y", "z"].every((axis) =>
    typeof origin[axis] === "number" && Number.isFinite(origin[axis]))) fail("site position");
  const seen = new Set();
  return objects.map((object) => {
    if (!object || !Number.isSafeInteger(object.typeID) || !Object.hasOwn(NATIVE_TYPES, object.typeID) || object.groupID !== 1882 ||
        object.categoryID !== 2 || object.role !== "weather") fail("native type/group/category/role");
    const objectID = positiveID(object.objectID, "objectID");
    const roomID = positiveID(object.roomID, "roomID");
    if (object.roomKey !== `room:${roomID}` || seen.has(objectID)) fail("room or duplicate object");
    seen.add(objectID);
    const originals = content.objects.filter((entry) => entry.objectID === objectID);
    if (originals.length !== 1 || !isDeepStrictEqual(originals[0], object)) fail("weather projection differs from native IR");
    const source = object.sourceFields;
    if (!source || source.objectID !== objectID || source.typeID !== object.typeID ||
        source.roomID !== roomID || !isDeepStrictEqual(source.position, object.sourcePosition) ||
        (source.radius ?? null) !== (object.radius ?? null)) fail("native object source fields");
    vector(object.sourcePosition, "source position");
    const offset = vector(object.position, "site-relative position");
    const radius = object.radius == null ? 1 : object.radius;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) fail("native radius");
    const nativeType = NATIVE_TYPES[object.typeID];
    const identity = `${instanceID}:${siteID}:${objectID}`;
    // Bounded hashing keeps even very large site IDs inside this namespace.
    // Materialization rejects any occupied ID owned by a different identity.
    const hash = createHash("sha256").update(identity).digest().readBigUInt64BE();
    const itemID = ITEM_ID_BASE + Number(hash % ITEM_ID_SPAN);
    const position = { x: origin.x + offset.x, y: origin.y + offset.y, z: origin.z + offset.z };
    if (!Object.values(position).every(Number.isFinite)) fail("world position overflow");
    return {
      kind: "siteEnvironmentProp",
      itemID, typeID: object.typeID, groupID: 1882, categoryID: 2,
      graphicID: nativeType.graphicID, ownerID: 1,
      itemName: nativeType.name, slimName: nativeType.name, skinMaterialSetID: null,
      position, radius, velocity: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
      dungeonMaterializedSiteContent: true,
      dungeonMaterializedEnvironment: true,
      dungeonNativeWeatherAnchor: true,
      dungeonNativeWeatherIdentity: identity,
      dungeonEnvironmentTemplateID: nativeType.templateID,
      dungeonSiteID: siteID, dungeonSiteInstanceID: instanceID,
      solarSystemID: systemID, dunObjectID: objectID, dungeonRoomKey: object.roomKey,
      dunPosition: [...object.position],
      staticVisibilityScope: "bubble",
      ...resolveSiteEnvironmentPropDestinyPresentation({
        ...NATIVE_BALL,
        destinyBootstrapDelivery: DESTINY_BOOTSTRAP_DELIVERY_ADDBALLS2,
      }),
    };
  });
}

module.exports = { buildNativeWeatherEntities };
