"use strict";

// Pure encounter decisions. The adapter supplies only committed server events;
// client telemetry never advances an objective or rewards a character.
function create(config, now, seed) {
  return {
    version: 1,
    family: config.family,
    seed: seed >>> 0,
    startedAtMs: now,
    lastTickAtMs: now,
    elapsedMs: 0,
    status: "active",
    phase:
      config.family === "abyssal_artifact_recovery" ? "preparation" : "active",
    phaseEndsAtMs: config.family === "abyssal_artifact_recovery" ? 90000 : 0,
    wave: 0,
    contributions: {},
    slots: {},
    health: {},
    capacitors: {},
    hacks: {},
    resolved: {},
    civilianStrikes: {},
    smugglerEscapes: 0,
    deliveries: 0,
    salvaged: 0,
    rocksCleared: 0,
    charges: 0,
    settlements: [],
    emptySinceMs: null,
  };
}
function random(state) {
  let x = state.seed || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.seed = x >>> 0;
  return state.seed / 4294967296;
}
function qualify(state, config, id, kind, amount, now) {
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    state.status !== "active"
  )
    return;
  const contribution = (state.contributions[id] ||= {
    damage: 0,
    repair: 0,
    mining: 0,
    hack: 0,
    salvage: 0,
    delivery: 0,
    capacitor: 0,
    neutralize: 0,
  });
  if (!Object.hasOwn(contribution, kind) || kind === "qualifiedAtMs") return;
  contribution[kind] += amount;
  const qualified =
    config.family === "salvage_research"
      ? contribution.salvage > 0
      : contribution.damage >= config.contributionThreshold ||
        contribution.repair >= config.contributionThreshold ||
        contribution.mining > 0 ||
        contribution.hack > 0 ||
        contribution.delivery > 0 ||
        contribution.capacitor > 0 ||
        contribution.neutralize > 0;
  if (qualified && contribution.qualifiedAtMs == null)
    contribution.qualifiedAtMs = now;
}
function fail(state, reason) {
  if (state.status === "active") {
    state.status = "failed";
    state.failure = reason;
  }
}
function complete(state) {
  if (state.status === "active") state.status = "completed";
}
function event(state, config, eventData) {
  // A failed Artifact wave retains its rocks and field, but can never pay or
  // restart waves. Mining the remainder still releases trapped pilots.
  if (
    state.status === "failed" &&
    config.family === "abyssal_artifact_recovery" &&
    eventData.kind === "depleted"
  ) {
    if (eventData.key && !state.resolved[eventData.key]) {
      state.resolved[eventData.key] = true;
      state.rocksCleared++;
    }
    return;
  }
  if (eventData.kind === "destroyed" && state.slots[eventData.key]) {
    state.slots[eventData.key].deadAtMs = state.elapsedMs;
    state.slots[eventData.key].entityID = null;
  }
  if (state.status !== "active") return;
  if (eventData.kind === "contribution")
    qualify(
      state,
      config,
      eventData.characterID,
      eventData.contribution,
      eventData.amount,
      eventData.nowMs,
    );
  if (eventData.kind === "aggression" && config.family === "traffic_stop") {
    const slot = state.slots[eventData.key];
    if (
      slot &&
      ["civilian", "smuggler"].includes(slot.role) &&
      !slot.aggressedAtMs
    ) {
      slot.aggressedAtMs = Math.max(1, state.elapsedMs);
      slot.expiresAtMs = Math.min(slot.expiresAtMs, state.elapsedMs + 45000);
      state.pendingCutters = (state.pendingCutters || 0) + 2;
      if (slot.role === "civilian" && eventData.characterID > 0)
        state.civilianStrikes[eventData.key] = true;
      if (Object.keys(state.civilianStrikes).length >= 3)
        fail(state, "three_civilians_harmed");
    }
  }
  if (eventData.kind === "destroyed") {
    const slot = state.slots[eventData.key];
    if (slot) {
      slot.deadAtMs = state.elapsedMs;
      slot.entityID = null;
    }
    if (eventData.role === "protected")
      fail(state, "protected_asset_destroyed");
    if (
      eventData.role === "objective" &&
      ["dread_assault", "suspicious_signal"].includes(config.family)
    )
      complete(state);
  }
  if (["hack", "salvage", "delivery", "depleted"].includes(eventData.kind)) {
    if (!eventData.key || state.resolved[eventData.key]) return;
    if (eventData.kind !== "hack") state.resolved[eventData.key] = true;
    if (eventData.kind === "hack") {
      state.hacks[eventData.key] = state.elapsedMs + 90000;
      qualify(state, config, eventData.characterID, "hack", 1, eventData.nowMs);
      if (config.family === "salvage_research") {
        state.werpostActivated = true;
        state.resolved[eventData.key] = true;
      }
    }
    if (eventData.kind === "salvage") {
      state.salvaged++;
      qualify(
        state,
        config,
        eventData.characterID,
        "salvage",
        1,
        eventData.nowMs,
      );
      if (state.salvaged >= 30) complete(state);
    }
    if (eventData.kind === "delivery") {
      state.deliveries += eventData.amount;
      qualify(
        state,
        config,
        eventData.characterID,
        "delivery",
        eventData.amount,
        eventData.nowMs,
      );
      if (state.deliveries >= 4) complete(state);
    }
    if (eventData.kind === "depleted") {
      state.rocksCleared++;
      if (config.family === "metaliminal_meteoroid") complete(state);
      if (
        config.family === "abyssal_artifact_recovery" &&
        config.artifactCache
      ) {
        const cache = config.artifactCache;
        // Persist both the appearance and contents at depletion; retries/reloads
        // never reroll either. Cache RNG has its own stream, separate from weather.
        state.cacheSeed ??= (state.seed ^ 0x85ebca6b) >>> 0;
        const rng = { seed: state.cacheSeed };
        if (random(rng) < cache.spawnChancePerDepletedAsteroid) {
          const loot = cache.loot
            .filter((item) => random(rng) < item.chance)
            .map(({ typeID, quantity }) => ({ typeID, quantity }));
          if (!loot.length && cache.guaranteeOne && cache.loot.length) {
            const { typeID, quantity } = pick(rng, cache.loot);
            loot.push({ typeID, quantity });
          }
          state.caches ||= {};
          state.caches[eventData.key] = {
            rockKey: eventData.key,
            wave: state.wave,
            status: "cache",
            loot,
          };
        }
        state.cacheSeed = rng.seed;
      }
    }
  }
}
function pick(state, pool) {
  return pool[Math.floor(random(state) * pool.length)];
}
function addSlot(state, key, role, pool, extra = {}) {
  if (state.slots[key] || !pool?.length) return;
  const selected = pick(state, pool);
  state.slots[key] = {
    key,
    role,
    typeID: selected.typeID || selected,
    createdAtMs: state.elapsedMs,
    ...extra,
  };
}
function schedule(state, config) {
  const settlement = config.spawns;
  if (config.family === "abyssal_artifact_recovery") return;
  for (const [role, count] of Object.entries(
    settlement.initialRoleCounts || {},
  )) {
    let desired = count;
    if (role === "objectiveAttacker")
      desired +=
        2 * [175000, 350000, 525000].filter((t) => state.elapsedMs >= t).length;
    for (let i = 0; i < desired; i++)
      addSlot(state, `${role}:${i}`, role, settlement.pools[role]);
  }
  if (config.family === "salvage_research")
    for (let i = 0; i < settlement.initialCount; i++)
      addSlot(state, `guard:${i}`, "dps", settlement.pool);
  if (config.family === "raid")
    addSlot(state, "hauler:0", "hauler", settlement.haulerPool, {
      expiresAtMs: state.elapsedMs + 90000,
    });
  if (config.family === "traffic_stop") {
    if (state.elapsedMs >= (state.nextTrafficAtMs || 0)) {
      const n = (state.arrivals = (state.arrivals || 0) + 1);
      const role =
        random(state) < settlement.contrabandChance ? "smuggler" : "civilian";
      addSlot(
        state,
        `traffic:${n}`,
        role,
        settlement.haulersByEmpire[config.empire],
        {
          expiresAtMs: state.elapsedMs + 90000,
        },
      );
      state.nextTrafficAtMs =
        state.elapsedMs + (15 + random(state) * 10) * 1000;
    }
    const live = Object.values(state.slots).filter(
      (settlement) =>
        settlement.role === "cutter" && settlement.deadAtMs == null,
    ).length;
    for (let n = 0; n < Math.min(8 - live, state.pendingCutters || 0); n++)
      addSlot(
        state,
        `cutter:${(state.cutters = (state.cutters || 0) + 1)}`,
        "cutter",
        settlement.cutterPool,
      );
    state.pendingCutters = 0;
  }
}
function advance(
  state,
  config,
  now,
  { occupied = true, arrayRatios = [] } = {},
) {
  if (state.status !== "active") return;
  // Server downtime and scene unloads do not award unattended survival time.
  const delta = Math.max(0, Math.min(5000, now - state.lastTickAtMs));
  state.lastTickAtMs = now;
  state.elapsedMs += delta;
  if (occupied) state.emptySinceMs = null;
  else if (state.emptySinceMs == null) state.emptySinceMs = state.elapsedMs;
  else if (state.elapsedMs - state.emptySinceMs >= 60000) {
    fail(state, "abandoned");
    return;
  }
  if (
    config.family === "stabilize_rift" &&
    arrayRatios.length === 5 &&
    arrayRatios.every((v) => Number.isFinite(v) && v >= 0 && v < 0.2)
  )
    complete(state);
  if (config.family === "abyssal_artifact_recovery") {
    if (state.elapsedMs >= state.phaseEndsAtMs) {
      if (state.phase === "wave") {
        if (state.rocksCleared < 12) {
          fail(state, "asteroids_remaining");
          return;
        }
        state.settlements.push({
          key: `wave:${state.wave}`,
          tier: Math.floor((state.wave - 1) / 3),
          elapsedMs: state.elapsedMs,
        });
        state.phase = state.wave === 9 ? "escape" : "intermission";
        state.phaseEndsAtMs =
          state.elapsedMs + (state.wave === 9 ? 60000 : 120000);
      } else if (state.phase === "escape") {
        state.phase = "drifter";
        complete(state);
      } else if (["preparation", "intermission"].includes(state.phase)) {
        state.wave++;
        state.phase = "wave";
        state.rocksCleared = 0;
        const tier = Math.floor((state.wave - 1) / 3);
        state.phaseEndsAtMs = state.elapsedMs + [180000, 150000, 120000][tier];
        const faction = pick(state, Object.keys(config.spawns.factionWeights));
        // Five equal 20% chances, rerolled only when a wave starts. Retain the
        // selection and its tier through intermission and the final escape.
        state.weather = Math.floor(random(state) * 5);
        state.weatherTier = tier;
        for (const [role, count] of Object.entries(
          config.spawns.tierRoleCounts[tier],
        ))
          for (let i = 0; i < count; i++)
            addSlot(
              state,
              `wave:${state.wave}:${role}:${i}`,
              role,
              config.spawns.pools[faction][role],
            );
      }
    }
  } else {
    schedule(state, config);
    if (state.elapsedMs >= config.durationMs) {
      if (["emergency_aid", "traffic_stop"].includes(config.family))
        complete(state);
      else fail(state, "deadline");
    }
  }
}
function recipients(state, config, characterIDs) {
  return [...new Set(characterIDs)]
    .filter((id) => state.contributions[id]?.qualifiedAtMs != null)
    .sort(
      (a, b) =>
        state.contributions[a].qualifiedAtMs -
          state.contributions[b].qualifiedAtMs || a - b,
    )
    .slice(0, config.maxPilots);
}
function rewardAmount(reward, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return 0;
  const table = reward?.tables?.find((t) => t.rewardType === 2);
  let amount = 0;
  for (const eventData of [...(table?.entries || [])].sort(
    (a, b) => a.playerCount - b.playerCount,
  ))
    if (eventData.playerCount <= count) amount = eventData.quantity;
  return amount;
}
function sealRewards(state, config, characterIDs, now) {
  // Freeze eligibility at the authoritative objective event, before anyone
  // can leave the pocket or a restart can change the payout population.
  for (const settlement of state.settlements) {
    if (!settlement.characterIDs) {
      settlement.characterIDs = recipients(state, config, characterIDs);
      settlement.completedAtMs = now;
    }
  }
  if (state.status === "completed" && !state.completion)
    state.completion = {
      characterIDs: recipients(state, config, characterIDs),
      completedAtMs: now,
    };
}
function signalVulnerable(state, keys) {
  return (
    keys.length === 3 &&
    keys.every((k) => (state.hacks[k] || 0) > state.elapsedMs)
  );
}
module.exports = {
  create,
  random,
  event,
  advance,
  schedule,
  addSlot,
  qualify,
  fail,
  complete,
  recipients,
  rewardAmount,
  sealRewards,
  signalVulnerable,
};
