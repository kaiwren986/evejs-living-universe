"use strict";
const service = () => require("../dungeon/dungeonUniverseSiteService");
const npc = () => require("../../space/npc/npcService");
const registry = () => require("../../space/npc/npcRegistry");
const add = (left, right) => ({
  x: left.x + right.x,
  y: left.y + right.y,
  z: left.z + right.z,
});
function tag(entity, instance, key, role) {
  Object.assign(entity, {
    homefrontRole: role,
    homefrontKey: key,
    dungeonMaterializedSiteContent: true,
    dungeonSiteInstanceID: instance.instanceID,
    dungeonSiteID: instance.metadata.siteID,
    dungeonEncounterKey: `homefront:${key}`,
  });
  return entity;
}
function all(scene, instance) {
  return service()
    .listMaterializedUniverseSiteContentEntities(scene, {
      instanceID: instance.instanceID,
    })
    .filter((entity) => entity.homefrontKey);
}
function remove(scene, entity) {
  return service().destroyMaterializedContentEntity(scene, entity, {
    broadcast: true,
    suppressWreck: true,
    suppressBounty: true,
    suppressStandings: true,
  });
}
function structure(scene, instance, root, profile, role, state, config) {
  const entity = service().homefrontPorts.structure(
    scene,
    instance,
    root,
    { key: `homefront:${profile.key}` },
    [profile],
  )[0]?.entity;
  if (!entity)
    throw new Error(
      `Cannot materialize Homefront ${profile.key} type ${profile.typeID}`,
    );
  tag(entity, instance, profile.key, role);
  const attributes = Object.fromEntries(
    (config.dogma[profile.typeID]?.dogmaAttributes || []).map((a) => [
      a.attributeID,
      a.value,
    ]),
  );
  for (const [name, id] of Object.entries({
    shieldCapacity: 263,
    armorHP: 265,
    structureHP: 9,
    signatureRadius: 552,
    capacitorCapacity: 482,
  }))
    if (attributes[id] != null) entity[name] = attributes[id];
  entity.capacitorChargeRatio =
    state.capacitors[profile.key] ?? (role === "dread" ? 0 : 1);
  if (state.health[profile.key])
    entity.conditionState = { ...state.health[profile.key] };
  if (role === "dread") {
    entity.capacitorCapacity = 30000;
    entity.capacitorChargeRatio = state.capacitors[profile.key] || 0;
  }
  if (role === "array") {
    entity.capacitorCapacity = Math.max(1000, entity.capacitorCapacity || 0);
    entity.homefrontInvulnerable = true;
  }
  if (role === "objective" && config.family === "suspicious_signal") {
    entity.shieldCapacity = 0;
    entity.armorHP = 0;
    entity.structureHP = 350000;
  }
  return entity;
}
function spawn(scene, instance, root, slot, config, state) {
  const profile = npc()
    .listNpcProfiles()
    .find((profileEntry) => profileEntry.shipTypeID === slot.typeID);
  if (!profile)
    throw new Error(`Missing Homefront native NPC profile for ${slot.typeID}`);
  const slotIndex = Object.keys(state.slots).indexOf(slot.key);
  const angle = slotIndex * 2.399963;
  const authored =
    slot.role === "werpost"
      ? config.hackTargets.find((profileEntry) => profileEntry.typeID === 83590)
      : null;
  const peaceful = ["hauler", "civilian", "smuggler"].includes(slot.role);
  const arrival = ["civilian", "smuggler"].includes(slot.role)
    ? require("../dungeon/dungeonAuthority")
        .getTemplateByID(instance.templateID)
        .clientDungeonContent.objects.find(
          (profileEntry) => profileEntry.typeID === 81334,
        )
    : null;
  const arrivalOffset = arrival
    ? { x: arrival.position[0], y: arrival.position[1], z: arrival.position[2] }
    : null;
  const position = add(
    root.position,
    authored?.positionOffset ||
      arrivalOffset ||
      add(config.roomOffset, {
        x: Math.cos(angle) * 25000,
        y: 0,
        z: Math.sin(angle) * 25000,
      }),
  );
  const response = npc().spawnNpcBatchInSystem(scene.systemID, {
    profileQuery: profile.profileID,
    amount: 1,
    transient: true,
    runtimeKind: "nativeCombat",
    position,
    spawnStateOverride: { position },
    skipInitialBehaviorTick: true,
    broadcast: true,
    behaviorOverrides: {
      autoAggro: !peaceful,
      autoAggroTargetClasses:
        slot.role === "cutter"
          ? ["player", "drone", "npc"]
          : ["objectiveAttacker", "focusedNeutralizer", "werpost"].includes(
                slot.role,
              )
            ? ["npc"]
            : ["player", "drone"],
      ...(config.family === "abyssal_artifact_recovery"
        ? { autoAggroTargetClasses: ["player"] }
        : {}),
      allowFriendlyNpcTargets: true,
      aggressionRangeMeters: 250000,
      leashRangeMeters: 250000,
    },
    entityScopeMetadata: {
      homefrontRole: slot.role,
      homefrontKey: slot.key,
      dungeonMaterializedSiteContent: true,
      dungeonSiteInstanceID: instance.instanceID,
      dungeonSiteID: root.itemID,
      dungeonEncounterKey: `homefront:${slot.key}`,
    },
  });
  const entity = response?.data?.spawned?.[0]?.entity;
  if (!entity)
    throw new Error(
      `Homefront NPC ${slot.typeID}: ${response?.errorMsg || "spawn failed"}`,
    );
  tag(entity, instance, slot.key, slot.role);
  slot.entityID = entity.itemID;
  // Generated NPC profiles invent a hull-class bounty when retail dogma is
  // zero. Homefront must retain the actual entity bounty instead.
  entity.bounty = Number(
    require("../fitting/liveFittingState").getTypeAttributeMap(
      slot.typeID,
    )[481] || 0,
  );
  if (state.health[slot.key])
    entity.conditionState = { ...state.health[slot.key] };
  if (state.capacitors[slot.key] != null)
    entity.capacitorChargeRatio = state.capacitors[slot.key];
  if (["hauler", "smuggler"].includes(slot.role)) {
    const store = require("../../space/npc/nativeNpcStore");
    const cargoID = store.allocateCargoID({ transient: true });
    if (!cargoID.success) throw new Error("Homefront cargo allocation failed");
    const typeID = slot.role === "hauler" ? 77474 : 81383;
    const type = require("../inventory/itemTypeRegistry").resolveItemByTypeID(
      typeID,
    );
    const result = store.upsertNativeCargo(
      {
        cargoID: cargoID.data,
        entityID: entity.itemID,
        ownerID: entity.ownerID,
        moduleID: 0,
        typeID,
        groupID: type.groupID,
        categoryID: type.categoryID,
        itemName: type.name,
        quantity: slot.role === "smuggler" ? 6 : 1,
        singleton: 0,
        transient: true,
      },
      { transient: true },
    );
    if (!result.success) throw new Error("Homefront cargo seeding failed");
  }
  // The system spawn API leaves deferred controllers at MAX_SAFE_INTEGER.
  // Arm combat only after scope, health and cargo have been restored; the
  // normal scene AI tick can now acquire players without a scripted retarget.
  if (!peaceful) npc().scheduleNpcController(entity.itemID, 0);
  return entity;
}
function retarget(scene, entity, target) {
  const ai = registry().getControllerByEntityID(entity.itemID);
  if (ai) {
    ai.preferredTargetID = target?.itemID || null;
    ai.nextThinkAtMs = 0;
  }
}
function moveTraffic(scene, entity, slot, state, now) {
  const controller = registry().getControllerByEntityID(entity.itemID);
  if (controller) controller.nextThinkAtMs = now + 2000;
  const destination = [...scene.staticEntitiesByID.values()].find(
    (entity) =>
      entity.dungeonSiteInstanceID === entity.dungeonSiteInstanceID &&
      entity.homefrontRole === "trafficDestination",
  );
  if (destination) slot.exitPosition = { ...destination.position };
  if (!slot.exitPosition)
    slot.exitPosition = {
      x: entity.position.x + Math.max(100, entity.maxVelocity || 200) * 90,
      y: entity.position.y,
      z: entity.position.z,
    };
  const fleeing = Boolean(slot.aggressedAtMs);
  if (entity.homefrontTrafficFleeing !== fleeing) {
    entity.homefrontTrafficFleeing = fleeing;
    // Rebuild from base Dogma so repeated ticks/reloads cannot compound the
    // boost, and ordinary projected webs still reduce the resulting speed.
    if (!scene.refreshShipEntityDerivedState(entity)?.success)
      delete entity.homefrontTrafficFleeing;
  }
  const exitPosition = slot.exitPosition;
  const delta = {
    x: exitPosition.x - entity.position.x,
    y: exitPosition.y - entity.position.y,
    z: exitPosition.z - entity.position.z,
  };
  const distance = Math.hypot(delta.x, delta.y, delta.z);
  if (distance < Math.max(0, destination?.radius || 0) + 1000) return true;
  const pseudo = {
    characterID: 0,
    _space: { shipID: entity.itemID, systemID: scene.systemID },
  };
  scene.gotoDirection(
    pseudo,
    { x: delta.x / distance, y: delta.y / distance, z: delta.z / distance },
    { queueHistorySafeContract: true, suppressFreshAcquireReplay: true },
  );
  return false;
}
// The pack's offsets are from the site, but the shared builders stand anything
// with a roomKey on its room's anchor. Without this the object lands one whole
// room offset beyond the pocket, out of every pilot's reach.
function roomRelative(instance, root, profile) {
  const anchor = service().homefrontPorts.roomAnchor(
    root.position,
    require("../dungeon/dungeonAuthority").getTemplateByID(instance.templateID),
    profile.roomKey,
  );
  const offset = profile.positionOffset;
  if (!anchor || !offset) return profile;
  return {
    ...profile,
    positionOffset: {
      x: root.position.x + offset.x - anchor.x,
      y: root.position.y + offset.y - anchor.y,
      z: root.position.z + offset.z - anchor.z,
    },
  };
}
function rocks(scene, instance, root, profiles, state, wave) {
  const hints = {
    exactClientContent: true,
    resourceYieldKind: "ore",
    miningRocks: profiles.map((profile) => roomRelative(instance, root, profile)),
    exactContentCaps: { miningRocks: profiles.length },
  };
  const entities = service().homefrontPorts.rocks(
    {
      ...instance,
      spawnState: { ...instance.spawnState, miningRockRemainingByID: {} },
    },
    root,
    hints,
  );
  for (const entity of entities) {
    const key = `rock:${wave}:${entity.dunObjectID || entity.dungeonSourceObjectID || entity.itemID}`;
    if (state.resolved[key]) continue;
    const existing = scene.getEntityByID(entity.itemID);
    if (existing && existing.homefrontKey !== key) remove(scene, existing);
    else if (existing) {
      tag(existing, instance, key, "rock");
      continue;
    }
    if (state.ore?.[key] != null)
      entity.miningRemainingQuantity = state.ore[key];
    tag(entity, instance, key, "rock");
    scene.addStaticEntity(entity);
    require("./homefrontArtifact").expireForRock(scene, instance, state, key);
    require("../mining/miningRuntimeState").updateMineableState(scene, entity, {
      entityID: entity.itemID,
      visualTypeID: entity.visualTypeID || entity.typeID,
      yieldTypeID: entity.miningYieldTypeID,
      yieldKind: "ore",
      unitVolume: entity.miningUnitVolume,
      originalQuantity:
        entity.miningOriginalQuantity || entity.miningRemainingQuantity,
      remainingQuantity: entity.miningRemainingQuantity,
      originalRadius: entity.radius,
    });
    scene.broadcastAddBalls?.([entity]);
  }
}
function containers(
  scene,
  instance,
  root,
  template,
  profiles,
  state,
  role = "hack",
) {
  const hints = {
    homefront: true,
    containers: profiles.map((profileEntry) => ({
      ...roomRelative(instance, root, profileEntry),
      count: 1,
      role: "homefront",
      analyzer: role === "hack" ? "data" : null,
      hackingDifficulty: profileEntry.typeID === 83590 ? "medium" : "easy",
      explicitLoot: [],
    })),
  };
  for (const entity of service().homefrontPorts.containers(
    instance,
    root,
    hints,
  )) {
    const key = `${role}:${entity.dungeonSourceObjectID}`;
    if (state.resolved[key]) continue;
    const existing = all(scene, instance).find((x) => x.homefrontKey === key);
    if (existing) continue;
    tag(entity, instance, key, role);
    service().homefrontPorts.materializeContainer(
      scene,
      instance,
      root,
      template,
      hints,
      entity,
      { broadcast: true },
    );
  }
}
module.exports = {
  tag,
  all,
  remove,
  structure,
  spawn,
  retarget,
  moveTraffic,
  rocks,
  containers,
  add,
};
