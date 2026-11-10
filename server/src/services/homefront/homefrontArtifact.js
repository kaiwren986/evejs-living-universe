"use strict";

const world = require("./homefrontWorld");
const rewards = require("./homefrontRewards");
const service = () => require("../dungeon/dungeonUniverseSiteService");
const items = () => require("../inventory/itemStore");

function cacheKey(rockKey) {
  return `cache:${rockKey}`;
}
function wreckKey(rockKey) {
  return `cache-wreck:${rockKey}`;
}
function profileFor(siteConfig, cache) {
  const objectID = Number(cache.rockKey.split(":").at(-1));
  return siteConfig.rocks.find(
    (profileEntry) =>
      Number(profileEntry.dunObjectID || profileEntry.objectID) === objectID,
  );
}
function removeCacheEntities(scene, instance, cache) {
  for (const entity of world.all(scene, instance))
    if (
      [cacheKey(cache.rockKey), wreckKey(cache.rockKey)].includes(
        entity.homefrontKey,
      )
    )
      world.remove(scene, entity);
  // A persisted wreck need not currently be in the scene (e.g. after reload).
  if (cache.wreckID && items().findItemById(cache.wreckID))
    items().removeInventoryItem(cache.wreckID, { removeContents: true });
}
function expireForRock(scene, instance, state, rockKey) {
  const sourceID = rockKey.split(":").at(-1);
  for (const cache of Object.values(state.caches || {})) {
    if (
      cache.rockKey !== rockKey &&
      cache.rockKey.split(":").at(-1) === sourceID &&
      cache.status !== "expired"
    ) {
      cache.status = "expired";
      removeCacheEntities(scene, instance, cache);
    }
  }
}
function materialize(scene, instance, root, siteConfig, state) {
  const entities = world.all(scene, instance);
  for (const cache of Object.values(state.caches || {})) {
    const profileEntry = profileFor(siteConfig, cache);
    if (!profileEntry)
      throw new Error(`Missing source asteroid for ${cache.rockKey}`);
    if (cache.status === "expired") {
      removeCacheEntities(scene, instance, cache);
      continue;
    }
    if (cache.status === "cache") {
      if (
        !entities.some(
          (entity) => entity.homefrontKey === cacheKey(cache.rockKey),
        )
      )
        world.structure(
          scene,
          instance,
          root,
          {
            key: cacheKey(cache.rockKey),
            typeID: siteConfig.artifactCache.typeID,
            positionOffset: profileEntry.positionOffset,
            label: "Faulty Triglavian Cache",
          },
          "artifactCache",
          state,
          siteConfig,
        );
      continue;
    }
    // Destruction state was committed before removing the old cache. Complete
    // that transition again after a crash, without rerolling its loot.
    for (const entity of entities)
      if (entity.homefrontKey === cacheKey(cache.rockKey))
        world.remove(scene, entity);
    if (
      entities.some((entity) => entity.homefrontKey === wreckKey(cache.rockKey))
    )
      continue;
    if (cache.wreckID && !items().findItemById(cache.wreckID)) {
      cache.status = "expired";
      continue;
    }
    const hints = {
      homefront: true,
      containers: [
        {
          typeID: siteConfig.artifactCache.wreckTypeID,
          count: 1,
          role: "homefront",
          label: "Faulty Triglavian Cache Wreck",
          positionOffset: profileEntry.positionOffset,
          explicitLoot: cache.loot,
        },
      ],
    };
    const entity = service().homefrontPorts.containers(
      instance,
      root,
      hints,
    )[0];
    entity.dungeonSiteContentKey = wreckKey(cache.rockKey);
    world.tag(entity, instance, wreckKey(cache.rockKey), "artifactCacheWreck");
    if (
      !service().homefrontPorts.materializeContainer(
        scene,
        instance,
        root,
        null,
        hints,
        entity,
        { broadcast: true },
      )
    )
      throw new Error(`Unable to materialize ${entity.dungeonSiteContentKey}`);
    const live = world
      .all(scene, instance)
      .find((x) => x.homefrontKey === entity.homefrontKey);
    if (!live) throw new Error("Artifact wreck lost its Homefront identity");
    cache.wreckID = live.itemID;
  }
}
function destroy(scene, instance, siteConfig, state, target) {
  const prefix =
    target.homefrontRole === "artifactCache" ? "cache:" : "cache-wreck:";
  const cache = state.caches?.[target.homefrontKey.slice(prefix.length)];
  if (!cache) return { success: false, errorMsg: "HOMEFRONT_CACHE_NOT_FOUND" };
  if (target.homefrontRole === "artifactCacheWreck") cache.status = "expired";
  else if (cache.status === "cache") cache.status = "wreck";
  rewards.saveOperation(instance, state);
  const removed = world.remove(scene, target);
  const root = scene.getEntityByID(instance.metadata.siteID);
  if (root) materialize(scene, instance, root, siteConfig, state);
  rewards.saveOperation(instance, state);
  return removed;
}
function cleanup(scene, instance, state) {
  for (const cache of Object.values(state.caches || {})) {
    cache.status = "expired";
    removeCacheEntities(scene, instance, cache);
  }
}
module.exports = { materialize, destroy, cleanup, expireForRock };
