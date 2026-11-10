"use strict";
const engine = require("./homefrontEngine");
const rewards = require("./homefrontRewards");
const world = require("./homefrontWorld");
const dungeon = () => require("../dungeon/dungeonRuntime");
const authority = () => require("../dungeon/dungeonAuthority");
const active = new Map();
const clocks = new Map();
const templateConfigurations = new Map();
const EMPIRES = {
  Amarr: 500003,
  Caldari: 500001,
  Gallente: 500004,
  Minmatar: 500002,
};
const FIVE = { Amarr: 62, Caldari: 63, Gallente: 64, Minmatar: 65 };
const THREE = { Amarr: 76, Caldari: 77, Gallente: 79, Minmatar: 80 };
// The shared hooks reach here for any ship, drone or fighter in any dungeon.
// getInstance returns a full copy of the record, so read the template name on
// the live record first; only Homefront sites pay for the copy.
function homefrontInstance(instanceID) {
  if (!instanceID) return null;
  const ref = dungeon().getInstanceRef(instanceID);
  if (!ref || !String(ref.templateID || "").startsWith("evejs-homefront:"))
    return null;
  return dungeon().getInstance(instanceID);
}
function config(instance) {
  if (!String(instance?.templateID || "").startsWith("evejs-homefront:"))
    return null;
  if (!templateConfigurations.has(instance.templateID)) {
    const original =
      authority().getTemplateByID(instance.templateID)?.populationHints
        ?.homefront || null;
    templateConfigurations.set(instance.templateID, {
      original,
      resolved: new Map(),
    });
  }
  const cached = templateConfigurations.get(instance.templateID);
  const original = cached.original;
  if (!original) return null;
  const empire = original.universal
    ? original.empireSystems[instance.solarSystemID] || original.empire
    : original.empire;
  let reward = original.universal
    ? original.rewards[(original.optimalPilots === 3 ? THREE : FIVE)[empire]]
    : original.reward;
  const exordium = require("./homefrontAdmission").isExordium(
    instance.solarSystemID,
  );
  const cacheKey = `${empire}:${exordium}`;
  if (cached.resolved.has(cacheKey)) return cached.resolved.get(cacheKey);
  if (exordium) {
    const tables =
      original.family === "metaliminal_meteoroid"
        ? [205, 208, 210, 212]
        : original.optimalPilots === 3
          ? [192, 193, 196, 198]
          : [185, 188, 190, 191];
    reward =
      original.rewards[
        tables[["Amarr", "Caldari", "Gallente", "Minmatar"].indexOf(empire)]
      ];
  }
  const resolved = {
    ...original,
    empire,
    empireFactionID: EMPIRES[empire],
    reward,
    waveRewardScale: exordium ? 0.5 : 1,
  };
  cached.resolved.set(cacheKey, resolved);
  return resolved;
}
function isSite(instance) {
  return Boolean(instance && config(instance));
}
const role = (entity) => entity?.homefrontRole || null;
const character = (entity) =>
  Number(
    entity?.session?.characterID ||
      entity?.session?.charid ||
      entity?.controllerOwnerID ||
      entity?.characterID ||
      entity?.ownerID ||
      0,
  );
function position(instance, siteConfig = config(instance)) {
  return world.add(instance.position, siteConfig.roomOffset);
}
function players(scene, instance, siteConfig = config(instance)) {
  if (!siteConfig) return [];
  const pocketCenter = position(instance, siteConfig);
  return [...scene.dynamicEntities.values()].filter(
    (entity) =>
      entity.kind === "ship" &&
      !entity.nativeNpc &&
      character(entity) > 0 &&
      entity.groupID !== 29 &&
      entity.dungeonCurrentInstanceID === instance.instanceID &&
      entity.dungeonCurrentRoomKey === siteConfig.roomKey &&
      !require("../../space/destiny/simulation/warpPhase").isEntityInActiveWarp(
        entity,
      ) &&
      Math.hypot(
        entity.position.x - pocketCenter.x,
        entity.position.y - pocketCenter.y,
        entity.position.z - pocketCenter.z,
      ) <= siteConfig.pocketRadiusMeters,
  );
}
function stateFor(instance) {
  if (!instance) return null;
  return active.get(instance.instanceID) || rewards.getOperation(instance);
}
function queueOperationUpdate(instance, state, scene, now = Date.now()) {
  if (scene)
    engine.sealRewards(
      state,
      config(instance),
      players(scene, instance).map(character),
      now,
    );
  rewards.markOperationDirty(instance, state);
}
function context(scene, target) {
  const instance = homefrontInstance(target?.dungeonSiteInstanceID);
  if (!instance || instance.solarSystemID !== scene?.systemID) return null;
  const siteConfig = config(instance);
  const state = siteConfig && stateFor(instance);
  return siteConfig && state ? { instance, config: siteConfig, state } : null;
}
function noteContribution(
  scene,
  source,
  target,
  amount,
  kind,
  now = Date.now(),
) {
  if (!source || !target || !Number.isFinite(amount) || amount <= 0) return;
  let ctx = context(scene, target);
  if (!ctx && kind === "repair") {
    const instance = homefrontInstance(target.dungeonCurrentInstanceID);
    const siteConfig = config(instance);
    if (siteConfig)
      ctx = { instance, config: siteConfig, state: stateFor(instance) };
  }
  if (!ctx?.state || ctx.state.status !== "active") return;
  const { instance, config: siteConfig, state } = ctx;
  const ships = players(scene, instance, siteConfig);
  const id = character(source);
  if (!ships.some((entity) => character(entity) === id)) return;
  if (
    kind === "damage" &&
    ![
      "dps",
      "drone",
      "ewar",
      "logi",
      "objectiveAttacker",
      "focusedNeutralizer",
      "batterySupport",
      "cutter",
      "smuggler",
      "hauler",
      "objective",
    ].includes(role(target))
  )
    return;
  if (
    kind === "repair" &&
    !(["protected", "dread"].includes(role(target)) || ships.includes(target))
  )
    return;
  if (kind === "capacitor" && role(target) !== "dread") return;
  if (kind === "neutralize" && role(target) !== "array") return;
  engine.qualify(state, siteConfig, id, kind, amount, now);
  if (target.homefrontKey) {
    state.health[target.homefrontKey] = { ...target.conditionState };
    state.capacitors[target.homefrontKey] = target.capacitorChargeRatio;
  }
  if (kind === "neutralize" && role(target) === "array") {
    const arrays = world
      .all(scene, instance)
      .filter((entity) => role(entity) === "array");
    if (
      arrays.length === 5 &&
      arrays.every(
        (entity) =>
          entity.capacitorChargeRatio >= 0 && entity.capacitorChargeRatio < 0.2,
      )
    )
      engine.complete(state);
  }
  queueOperationUpdate(instance, state, scene, now);
}
function noteAggression(scene, source, target, now = Date.now()) {
  const ctx = context(scene, target);
  if (!ctx || ctx.config.family !== "traffic_stop") return;
  const id = character(source);
  if (
    !players(scene, ctx.instance, ctx.config).some(
      (entity) => character(entity) === id,
    )
  )
    return;
  engine.event(ctx.state, ctx.config, {
    kind: "aggression",
    key: target.homefrontKey,
    characterID: id,
    nowMs: now,
  });
  queueOperationUpdate(ctx.instance, ctx.state);
}
function destroyed(scene, target, now = Date.now()) {
  const ctx = context(scene, target);
  if (!ctx) return;
  engine.event(ctx.state, ctx.config, {
    kind: "destroyed",
    key: target.homefrontKey,
    role: role(target),
    nowMs: now,
  });
  queueOperationUpdate(ctx.instance, ctx.state, scene, now);
}
function destroyArtifact(scene, target) {
  const ctx = context(scene, target);
  if (!ctx) return { success: false, errorMsg: "HOMEFRONT_CONTEXT_NOT_FOUND" };
  return require("./homefrontArtifact").destroy(
    scene,
    ctx.instance,
    ctx.config,
    ctx.state,
    target,
  );
}
const preparedHackOutcomes = new WeakSet();
function restoreHackingContainer(entity, instance, nowMs) {
  const operation = stateFor(instance);
  const hacked = operation && (operation.resolved?.[entity.homefrontKey] === true ||
    (operation.hacks?.[entity.homefrontKey] || 0) > operation.elapsedMs);
  return require("../exploration/hackingContainerState").setTransientState(entity, hacked ? 2 : 0, { nowMs });
}

function prepareHackOutcome(scene, target, source, receiptID) {
  const ctx = context(scene, target);
  const characterID = typeof source === "number" ? source : character(source);
  if (!ctx || !receiptID || !players(scene, ctx.instance, ctx.config).some(entity => character(entity) === characterID)) {
    return null;
  }
  const prepared = Object.freeze({ instanceID: ctx.instance.instanceID,
    key: target.homefrontKey, characterID, receiptID });
  preparedHackOutcomes.add(prepared);
  return prepared;
}

function objectiveEvent(
  scene,
  target,
  source,
  kind,
  amount = 1,
  now = Date.now(),
  options = {},
) {
  const ctx = context(scene, target);
  if (!ctx) return false;
  const id = typeof source === "number" ? source : character(source);
  const prepared = options.preparedHack;
  const authorizedRetry = kind === "hack" && preparedHackOutcomes.has(prepared) &&
    prepared.instanceID === ctx.instance.instanceID && prepared.key === target.homefrontKey &&
    prepared.characterID === id && prepared.receiptID === options.receiptID;
  if (
    !authorizedRetry &&
    !players(scene, ctx.instance, ctx.config).some(
      (entity) => character(entity) === id,
    )
  )
    return false;
  const receiptID = kind === "hack" ? String(options.receiptID || "").trim() : "";
  const snapshot = receiptID ? structuredClone(ctx.state) : null;
  try {
    const receipt = receiptID && ctx.state.hackOutcomeReceipts?.[receiptID];
    if (receipt && (receipt.key !== target.homefrontKey || receipt.characterID !== id)) return false;
    if (!receipt) {
      engine.event(ctx.state, ctx.config, {
        kind,
        key: target.homefrontKey,
        characterID: id,
        amount,
        nowMs: now,
      });
      if (receiptID) {
        ctx.state.hackOutcomeReceipts ||= {};
        ctx.state.hackOutcomeReceipts[receiptID] = {
          key: target.homefrontKey, characterID: id, nowMs: now,
        };
      }
      queueOperationUpdate(ctx.instance, ctx.state, scene, now);
    }
    // Hacking publishes its native win only after this dedicated Homefront
    // receipt is durable. Repeated calls cannot extend a 90-second hack.
    if (receiptID) rewards.saveOperation(ctx.instance, ctx.state);
  } catch (error) {
    if (snapshot) {
      for (const key of Object.keys(ctx.state)) delete ctx.state[key];
      Object.assign(ctx.state, snapshot);
      rewards.markOperationDirty(ctx.instance, ctx.state);
    }
    throw error;
  }
  return true;
}
function noteMining(scene, target, source, quantity, remaining, now) {
  const ctx = context(scene, target);
  if (!ctx) return;
  ctx.state.ore ||= {};
  ctx.state.ore[target.homefrontKey] = remaining;
  const id = character(source);
  if (
    players(scene, ctx.instance, ctx.config).some(
      (entity) => character(entity) === id,
    )
  )
    engine.qualify(ctx.state, ctx.config, id, "mining", quantity, now);
  if (remaining <= 0)
    engine.event(ctx.state, ctx.config, {
      kind: "depleted",
      key: target.homefrontKey,
      nowMs: now,
    });
  queueOperationUpdate(ctx.instance, ctx.state, scene, now);
}
function canDamage(target) {
  if (!target?.homefrontKey) return true;
  if (
    ["array", "dread", "hack", "salvage", "trafficDestination"].includes(
      role(target),
    )
  )
    return false;
  if (role(target) === "objective") {
    const instance = dungeon().getInstance(target.dungeonSiteInstanceID);
    const siteConfig = config(instance);
    const state = instance && stateFor(instance);
    if (siteConfig?.family === "suspicious_signal")
      return Boolean(
        state &&
        engine.signalVulnerable(
          state,
          siteConfig.hackTargets.map((t) => `hack:${t.objectID}`),
        ),
      );
    if (siteConfig?.family === "dread_assault") return false;
  }
  return true;
}
function acceptsAssistance(target, family) {
  if (!target?.homefrontKey) return false;
  if (family === "remoteCapacitor" && role(target) === "array") return true;
  if (["remoteShield", "remoteArmor"].includes(family))
    return ["protected", "dread"].includes(role(target));
  if (family === "remoteCapacitor" && role(target) === "dread") {
    const state = stateFor(dungeon().getInstance(target.dungeonSiteInstanceID));
    return state?.phase !== "siege";
  }
  return false;
}
function notify(ships, text) {
  for (const entity of ships)
    entity.session?.sendNotification?.("OnRemoteMessage", "clientID", [
      "CustomNotify",
      require("../_shared/serviceHelpers").buildDict([
        ["notify", { type: "wstring", value: text }],
      ]),
    ]);
}
function materializeObjectives(
  scene,
  instance,
  root,
  siteConfig,
  state,
  entities,
) {
  const ensure = (profile, role) =>
    entities.find((entity) => entity.homefrontKey === profile.key) ||
    world.structure(scene, instance, root, profile, role, state, siteConfig);
  const targets = siteConfig.objectives.filter(
    (profileEntry) =>
      !siteConfig.hackTargets.some((h) => h.objectID === profileEntry.objectID),
  );
  for (const profileEntry of targets) {
    if (["salvage_research", "raid"].includes(siteConfig.family)) continue;
    ensure(
      profileEntry,
      ["emergency_aid", "raid"].includes(siteConfig.family)
        ? "protected"
        : "objective",
    );
  }
  if (siteConfig.family === "dread_assault") {
    const anchor = siteConfig.anchors[0];
    const typeID = {
      Amarr: 77019,
      Caldari: 77184,
      Gallente: 77185,
      Minmatar: 77183,
    }[siteConfig.empire];
    ensure(
      {
        key: "dread",
        typeID,
        label: "Allied Dreadnought",
        positionOffset: anchor?.positionOffset || siteConfig.roomOffset,
      },
      "dread",
    );
  }
  if (siteConfig.family === "stabilize_rift")
    for (let i = 0; i < 5; i++) {
      // The recovered dictionary coordinates contain five distinct battery anchors.
      const anchor = siteConfig.anchors.find(
        (profileEntry) =>
          profileEntry.objectOrder === i &&
          profileEntry.npcGroupingID === 32901,
      );
      const angle = (i * Math.PI * 2) / 5;
      ensure(
        {
          key: `array:${i}`,
          typeID: 81402,
          label: `Destabilizing Array ${i + 1}`,
          positionOffset:
            anchor?.positionOffset ||
            world.add(siteConfig.roomOffset, {
              x: Math.cos(angle) * 12000,
              y: 0,
              z: Math.sin(angle) * 12000,
            }),
        },
        "array",
      );
    }
  if (siteConfig.family === "traffic_stop") {
    const typeID = {
      Amarr: 83568,
      Caldari: 83571,
      Gallente: 83570,
      Minmatar: 83569,
    }[siteConfig.empire];
    const object = authority()
      .getTemplateByID(instance.templateID)
      .clientDungeonContent.objects.find(
        (profileEntry) => profileEntry.typeID === typeID,
      );
    if (object)
      ensure(
        {
          key: "traffic-destination",
          typeID,
          label: object.typeName,
          positionOffset: {
            x: object.position[0],
            y: object.position[1],
            z: object.position[2],
          },
        },
        "trafficDestination",
      );
  }
  if (siteConfig.hackTargets.length)
    world.containers(
      scene,
      instance,
      root,
      authority().getTemplateByID(instance.templateID),
      siteConfig.hackTargets,
      state,
    );
  if (siteConfig.family === "raid")
    world.containers(
      scene,
      instance,
      root,
      authority().getTemplateByID(instance.templateID),
      targets,
      state,
      "receiver",
    );
  if (siteConfig.family === "salvage_research")
    world.containers(
      scene,
      instance,
      root,
      authority().getTemplateByID(instance.templateID),
      siteConfig.salvageTargets,
      state,
      "salvage",
    );
  if (siteConfig.family === "metaliminal_meteoroid") {
    state.selectedRock ??= Math.floor(
      engine.random(state) * siteConfig.rocks.length,
    );
    world.rocks(
      scene,
      instance,
      root,
      [siteConfig.rocks[state.selectedRock]],
      state,
      0,
    );
  }
  if (
    siteConfig.family === "abyssal_artifact_recovery" &&
    state.phase === "wave"
  )
    world.rocks(scene, instance, root, siteConfig.rocks, state, state.wave);
}
function spawnSlots(scene, instance, root, siteConfig, state, entities) {
  if (state.werpostActivated) {
    for (const entity of entities.filter((entity) => role(entity) === "hack"))
      world.remove(scene, entity);
    engine.addSlot(state, "werpost", "werpost", [83590]);
  }
  for (const slot of Object.values(state.slots)) {
    let entity = entities.find((entity) => entity.homefrontKey === slot.key);
    if (slot.deadAtMs != null) {
      const delay =
        slot.role === "hauler"
          ? 75000
          : ["batterySupport", "focusedNeutralizer"].includes(slot.role)
            ? 175000
            : siteConfig.family === "salvage_research"
              ? 535000
              : 30000;
      if (
        [
          "objectiveAttacker",
          "cutter",
          "smuggler",
          "civilian",
          "werpost",
        ].includes(slot.role) ||
        siteConfig.family === "abyssal_artifact_recovery" ||
        state.elapsedMs < slot.deadAtMs + delay
      )
        continue;
      delete slot.deadAtMs;
      slot.entityID = null;
      slot.expiresAtMs = state.elapsedMs + 90000;
      delete state.health[slot.key];
      delete state.capacitors[slot.key];
    }
    if (!entity)
      entity = world.spawn(scene, instance, root, slot, siteConfig, state);
    const departed = ["smuggler", "civilian"].includes(slot.role)
      ? world.moveTraffic(scene, entity, slot, state, state.lastTickAtMs)
      : slot.role === "hauler" &&
        state.elapsedMs >= slot.expiresAtMs &&
        !require("../../space/modules/hostileModuleRuntime").isEntityWarpScrambled(
          entity,
        );
    if (departed) {
      if (slot.role === "smuggler" && ++state.smugglerEscapes >= 5)
        engine.fail(state, "five_smugglers_escaped");
      world.remove(scene, entity);
      slot.deadAtMs = state.elapsedMs;
      slot.entityID = null;
      continue;
    }
    let target;
    if (slot.role === "objectiveAttacker")
      target = entities.find((entity) => role(entity) === "protected");
    if (slot.role === "focusedNeutralizer")
      target = entities.find((entity) => role(entity) === "dread");
    if (
      slot.role === "drone" &&
      siteConfig.family !== "abyssal_artifact_recovery"
    )
      target = [...scene.dynamicEntities.values()].find(
        (entity) =>
          entity.kind === "drone" &&
          players(scene, instance, siteConfig).some(
            (ship) => character(ship) === character(entity),
          ),
      );
    if (target) world.retarget(scene, entity, target);
  }
}
function tick(scene, instance, now) {
  if (
    instance.environmentState?.homefrontRewardsRetired ||
    scene.homefrontParkedSites?.has(instance.instanceID)
  )
    return;
  const siteConfig = config(instance);
  if (!siteConfig) return;
  if (now - (clocks.get(instance.instanceID) || 0) < 1000) return;
  clocks.set(instance.instanceID, now);
  const root = scene.getEntityByID(instance.metadata.siteID);
  if (!root) return;
  let state = stateFor(instance);
  const ships = players(scene, instance, siteConfig);
  require("./homefrontAdmission").syncOwnership(scene, instance, ships, now);
  if (!state && !ships.length) return;
  if (!state) state = engine.create(siteConfig, now, instance.instanceID);
  if (state.runtimeError) return;
  if (state.pendingDelivery) {
    require("./homefrontCargo").finishDelivery(instance, siteConfig, state);
    state = rewards.getOperation(instance);
  }
  active.set(instance.instanceID, state);
  try {
    let entities = world.all(scene, instance);
    if (state.status === "active") {
      materializeObjectives(scene, instance, root, siteConfig, state, entities);
      entities = world.all(scene, instance);
      for (const entity of entities) {
        if (entity.conditionState)
          state.health[entity.homefrontKey] = { ...entity.conditionState };
        if (role(entity) === "array") {
          const ratio = Math.max(
            0,
            Math.min(1, entity.capacitorChargeRatio ?? 1),
          );
          entity.capacitorChargeRatio = Math.min(
            1,
            ratio + (10 * (Math.sqrt(ratio) - ratio)) / 1800,
          );
        }
        if (entity.capacitorChargeRatio != null)
          state.capacitors[entity.homefrontKey] = entity.capacitorChargeRatio;
        if (
          role(entity) === "hack" &&
          state.hacks[entity.homefrontKey] != null &&
          state.hacks[entity.homefrontKey] <= state.elapsedMs
        ) {
          delete state.hacks[entity.homefrontKey];
          if (state.resolved[entity.homefrontKey] !== true) {
            require("../exploration/hackingContainerState").setTransientState(entity, 0, { nowMs: now });
            delete entity.dungeonSiteContentHackedAtMs;
            scene.broadcastSlimItemChanges?.([entity]);
          }
        }
        if (role(entity) === "rock") {
          state.ore ||= {};
          state.ore[entity.homefrontKey] = entity.miningRemainingQuantity;
          if (entity.miningRemainingQuantity <= 0)
            engine.event(state, siteConfig, {
              kind: "depleted",
              key: entity.homefrontKey,
              nowMs: now,
            });
        }
      }
      if (siteConfig.family === "dread_assault") {
        require("./homefrontDread").tick(
          scene,
          siteConfig,
          state,
          entities,
          now,
        );
      }
      engine.advance(state, siteConfig, now, {
        occupied: ships.length > 0,
        arrayRatios: entities
          .filter((entity) => role(entity) === "array")
          .map((entity) => entity.capacitorChargeRatio),
      });
      if (state.status === "active")
        spawnSlots(scene, instance, root, siteConfig, state, entities);
    }
    if (siteConfig.family === "abyssal_artifact_recovery") {
      if (state.phase === "wave" && (state.status === "active" || ships.length))
        world.rocks(scene, instance, root, siteConfig.rocks, state, state.wave);
      if (state.status === "failed" && ships.length)
        spawnSlots(scene, instance, root, siteConfig, state, entities);
      require("./homefrontArtifact").materialize(
        scene,
        instance,
        root,
        siteConfig,
        state,
      );
      require("./homefrontWeather").sync(scene, instance, siteConfig, state);
    }
    engine.sealRewards(state, siteConfig, ships.map(character), now);
    const clientState = require("./homefrontClient").dungeonState(
      siteConfig,
      state,
    );
    if (
      !state.lastValuesAtMs ||
      now - state.lastValuesAtMs >= 5000 ||
      state.status !== "active" ||
      state.lastClientState !== clientState
    ) {
      state.lastClientState = clientState;
      state.lastValuesAtMs = now;
      require("./homefrontClient").publish(scene, instance, ships, now);
    }
    for (const settlement of state.settlements) {
      const rewardID =
        { Amarr: 59, Caldari: 66, Gallente: 69, Minmatar: 72 }[
          siteConfig.empire
        ] + settlement.tier;
      const receipt = rewards.commit(
        instance,
        siteConfig,
        state,
        ships.map(character),
        now,
        settlement.key,
        siteConfig.rewards[rewardID],
      );
      rewards.settle(receipt, [...scene.sessions.values()]);
    }
    if (
      state.status === "completed" &&
      siteConfig.family !== "abyssal_artifact_recovery"
    ) {
      const receipt = rewards.commit(
        instance,
        siteConfig,
        state,
        ships.map(character),
        now,
      );
      rewards.settle(receipt, [...scene.sessions.values()]);
    }
    require("./homefrontNotifications").publish(
      instance,
      siteConfig,
      state,
      ships,
    );
    if (state.status !== "active") {
      if (!state.notified) {
        if (state.status === "completed")
          require("../dungeon/dungeonTrackingRuntime").notifyDungeonCompletedForScene(
            scene,
            instance,
            { nowMs: now },
          );
        state.notified = true;
      }
      if (
        siteConfig.family === "abyssal_artifact_recovery" &&
        state.phase === "drifter" &&
        ships.length
      ) {
        engine.addSlot(state, "final-drifter", "drifter", [77702]);
        const slot = state.slots["final-drifter"];
        if (
          slot.deadAtMs == null &&
          !world
            .all(scene, instance)
            .some((entity) => entity.homefrontKey === slot.key)
        )
          world.spawn(scene, instance, root, slot, siteConfig, state);
      } else if (!(
        siteConfig.family === "abyssal_artifact_recovery" &&
        state.status === "failed" &&
        ships.length
      )) {
        if (siteConfig.family === "abyssal_artifact_recovery") {
          require("./homefrontArtifact").cleanup(scene, instance, state);
          require("./homefrontWeather").sync(
            scene,
            instance,
            siteConfig,
            state,
            true,
          );
        }
        for (const entity of world.all(scene, instance))
          world.remove(scene, entity);
      }
      if (
        !ships.length &&
        !require("../dungeon/dungeonUniverseSiteService").homefrontPorts.occupied(
          scene,
          instance,
          root.itemID,
        )
      )
        dungeon().setLifecycleState(instance.instanceID, state.status, {
          nowMs: now,
          lifecycleReason: `homefront_${state.status}`,
        });
    } else if (!state.lastNoticeAtMs || now - state.lastNoticeAtMs >= 30000) {
      state.lastNoticeAtMs = now;
      if (siteConfig.family === "abyssal_artifact_recovery") {
        const weather =
          siteConfig.artifactWeather?.choices[state.weather]?.name;
        notify(
          ships,
          `Artifact Recovery: wave ${state.wave}/9, ${state.phase}, ${Math.max(0, Math.ceil((state.phaseEndsAtMs - state.elapsedMs) / 1000))} seconds remaining.${weather ? ` ${weather} weather.` : ""}`,
        );
      } else
        notify(
          ships,
          `${siteConfig.family.replaceAll("_", " ")}: ${Math.max(0, Math.ceil((siteConfig.durationMs - state.elapsedMs) / 1000))} seconds remaining.`,
        );
    }
    rewards.saveOperation(instance, state);
  } finally {
    active.delete(instance.instanceID);
  }
  if (
    ["completed", "failed", "despawned"].includes(
      dungeon().getInstance(instance.instanceID)?.lifecycleState,
    )
  ) {
    rewards.pruneOperation(instance.instanceID);
    clocks.delete(instance.instanceID);
  }
}
function releaseScene(scene) {
  rewards.releaseSystem(scene.systemID);
  for (const instanceID of clocks.keys()) {
    if (dungeon().getInstance(instanceID)?.solarSystemID === scene.systemID)
      clocks.delete(instanceID);
  }
}
function closeOperation(instance) {
  if (!isSite(instance) || active.has(instance.instanceID)) return;
  rewards.flushOperations(instance.solarSystemID);
  rewards.pruneOperation(instance.instanceID);
  clocks.delete(instance.instanceID);
}
function parkSite(scene, instance, error, now) {
  for (const entity of scene.dynamicEntities.values()) {
    if (
      entity.dungeonCurrentInstanceID === instance.instanceID ||
      entity.dungeonSiteInstanceID === instance.instanceID ||
      entity.homefrontWeatherInstanceID === instance.instanceID
    ) {
      entity.homefrontParkedInstanceID = instance.instanceID;
      delete entity.homefrontWeatherInstanceID;
      delete entity.homefrontWeatherSelection;
      delete entity.homefrontWeatherSignature;
    }
  }
  const state = stateFor(instance);
  if (state) {
    state.runtimeError = error.message;
    state.runtimeFailedAtMs = now;
    engine.fail(state, "runtime_error");
    state.weatherCleanedUp = true;
    rewards.markOperationDirty(instance, state);
  }
  notify(
    players(scene, instance),
    "This Homefront operation has been stopped because of a server error. You may leave the site.",
  );
  if (state) rewards.saveOperation(instance, state);
}
function isWarpBlocked(entity) {
  if (
    entity?.homefrontParkedInstanceID &&
    entity.homefrontParkedInstanceID === entity.dungeonCurrentInstanceID
  )
    return false;
  const instance = homefrontInstance(entity?.dungeonCurrentInstanceID);
  if (!instance) return false;
  const siteConfig = config(instance);
  if (
    siteConfig?.family !== "abyssal_artifact_recovery" ||
    entity.dungeonCurrentRoomKey !== siteConfig.roomKey
  )
    return false;
  const operationState = stateFor(instance);
  if (
    !operationState ||
    operationState.runtimeError ||
    !["active", "failed"].includes(operationState.status) ||
    operationState.phase !== "wave" ||
    operationState.rocksCleared >= 12
  )
    return false;
  const center = world.add(
    instance.position,
    siteConfig.artifactField?.positionOffset || siteConfig.roomOffset,
  );
  return (
    !!entity.position &&
    Math.hypot(
      entity.position.x - center.x,
      entity.position.y - center.y,
      entity.position.z - center.z,
    ) <= (siteConfig.artifactField?.radiusMeters ?? 45000)
  );
}
module.exports = {
  config,
  homefrontInstance,
  isSite,
  role,
  character,
  position,
  players,
  getState: stateFor,
  tick,
  releaseScene,
  closeOperation,
  parkSite,
  noteContribution,
  noteAggression,
  destroyed,
  destroyArtifact,
  objectiveEvent,
  prepareHackOutcome,
  restoreHackingContainer,
  noteMining,
  canDamage,
  acceptsAssistance,
  isWarpBlocked,
  _testing: {
    reset() {
      active.clear();
      clocks.clear();
      templateConfigurations.clear();
      rewards._testing.resetCache();
    },
  },
};
