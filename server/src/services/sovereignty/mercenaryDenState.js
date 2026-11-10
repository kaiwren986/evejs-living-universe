"use strict";

const path = require("path");

const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const { getWallclockNowMs } = require(path.join(__dirname, "../../space/runtime/runtimeClock"));
const {
  cloneValue,
  readSovereigntyTable,
  writeSovereigntyTable,
} = require(path.join(__dirname, "./sovStore"));
const {
  createUuidString,
} = require(path.join(
  __dirname,
  "../../_secondary/express/gatewayServices/gatewayServiceHelpers",
));
const {
  DEFAULT_MERCENARY_DEN_ABSOLUTE_MAXIMUM,
  DEFAULT_MERCENARY_DEN_ACTIVITY_CAPACITY,
  MERCENARY_DEN_MANAGEMENT_SKILL_TYPE_ID,
  TYPE_MERCENARY_DEN,
} = require(path.join(__dirname, "./sovConstants"));

const DEFAULT_ACTIVITY_DURATION_MS = 2 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_GENERATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ACTIVITY_TEMPLATE_DEFINITIONS = Object.freeze([
  {
    templateID: 1,
    nameMessageID: 330000001,
    descriptionMessageID: 330000011,
    dungeonID: 8800001,
    developmentImpact: 1,
    anarchyImpact: 0,
    infomorphBonus: 1,
  },
  {
    templateID: 2,
    nameMessageID: 330000002,
    descriptionMessageID: 330000012,
    dungeonID: 8800002,
    developmentImpact: 0,
    anarchyImpact: 1,
    infomorphBonus: 1,
  },
  {
    templateID: 3,
    nameMessageID: 330000003,
    descriptionMessageID: 330000013,
    dungeonID: 8800003,
    developmentImpact: 2,
    anarchyImpact: 0,
    infomorphBonus: 2,
  },
]);

let cache = null;

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = normalizeInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Boolean(value);
}

function normalizeTimestampMs(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(numericValue));
}

function getSkillLevel(characterID, skillTypeID) {
  const skillMap = getCachedCharacterSkillMap(normalizePositiveInteger(characterID, 0));
  const record = skillMap.get(Number(skillTypeID) || 0) || null;
  return Math.max(
    0,
    Math.min(
      5,
      normalizeInteger(
        record &&
          (record.effectiveSkillLevel ??
            record.trainedSkillLevel ??
            record.skillLevel),
        0,
      ),
    ),
  );
}

// Client 3396210 sovereignty/mercenaryden/client/mocks/data.py: one level per
// 17280 s (five a day, as patch 22.02 says), stage bands 0-19, 20-39, 40-69,
// 70-99 and 100, and an anarchy workforce cost per stage of 0, 0, 886, 1772 and
// 3544 for a planet that makes 8860: 0, 0, 10, 20 and 40% of the planet's
// workforce, the shares patch 22.02 gives. The client shows the cost as a share
// of GetPlanetWorkforceProduction (repository.get_workforce_cost_as_percentage).
const EVOLUTION_UNIT_INCREASE_SECONDS = 17280;
const EVOLUTION_LEVEL_MAXIMUM = 100;
const EVOLUTION_STAGE_BANDS = Object.freeze([
  Object.freeze({ stage: 1, levelLowerBound: 0, levelUpperBound: 19 }),
  Object.freeze({ stage: 2, levelLowerBound: 20, levelUpperBound: 39 }),
  Object.freeze({ stage: 3, levelLowerBound: 40, levelUpperBound: 69 }),
  Object.freeze({ stage: 4, levelLowerBound: 70, levelUpperBound: 99 }),
  Object.freeze({ stage: 5, levelLowerBound: 100, levelUpperBound: 100 }),
]);
const ANARCHY_WORKFORCE_SHARE_BY_STAGE = Object.freeze([0, 0, 0.1, 0.2, 0.4]);
// The den makes Infomorph Decryption Keys (85746, group 4824, 0.1 m3; the
// client mock uses the same type). Patch 22.02: 65-100 a tick at the base, plus
// 5, 10, 15 and 20% at development stages 2-5, one tick an hour (the mock's
// generation_rate_tick_seconds). The client gives no capacity of its own (the
// mock's 170000 is a placeholder); the den holds what fits in its 3000 m3
// (type capacity) at 0.1 m3 a key.
const TYPE_INFOMORPH_DECRYPTION_KEY = 85746;
const INFOMORPH_GENERATION_TICK_SECONDS = 3600;
const INFOMORPH_CARGO_CAPACITY = 30000;
const INFOMORPH_BASE_BAND = Object.freeze([65, 100]);
const INFOMORPH_DEVELOPMENT_BONUS_BY_STAGE = Object.freeze([0, 0.05, 0.1, 0.15, 0.2]);
// A den left alone for years must not loop forever on read.
const MAX_GENERATION_TICKS_PER_SETTLE = 24 * 366;

function buildDefaultEvolutionDefinition(planetWorkforce = 0) {
  const workforce = Math.max(0, Number(planetWorkforce) || 0);
  return {
    development: {
      unitIncreaseTimeSeconds: EVOLUTION_UNIT_INCREASE_SECONDS,
      stages: EVOLUTION_STAGE_BANDS.map((band) => ({ ...band })),
    },
    anarchy: {
      unitIncreaseTimeSeconds: EVOLUTION_UNIT_INCREASE_SECONDS,
      stages: EVOLUTION_STAGE_BANDS.map((band, index) => ({
        ...band,
        workforceConsumption: Math.round(
          workforce * ANARCHY_WORKFORCE_SHARE_BY_STAGE[index],
        ),
      })),
    },
  };
}

function buildDefaultEvolutionSimulation(now = Date.now()) {
  return {
    paused: false,
    started: true,
    development: {
      level: 0,
      stage: 1,
      pausedAtMs: 0,
      simulatedAtMs: now,
    },
    anarchy: {
      level: 0,
      stage: 1,
      pausedAtMs: 0,
      simulatedAtMs: now,
    },
  };
}

function buildDefaultInfomorphsDefinition() {
  return {
    infomorphTypeID: TYPE_INFOMORPH_DECRYPTION_KEY,
    generationTickSeconds: INFOMORPH_GENERATION_TICK_SECONDS,
    cargoCapacity: INFOMORPH_CARGO_CAPACITY,
    generationBands: EVOLUTION_STAGE_BANDS.map((band, index) => ({
      stage: band.stage,
      lowerBand: Math.round(
        INFOMORPH_BASE_BAND[0] * (1 + INFOMORPH_DEVELOPMENT_BONUS_BY_STAGE[index]),
      ),
      upperBand: Math.round(
        INFOMORPH_BASE_BAND[1] * (1 + INFOMORPH_DEVELOPMENT_BONUS_BY_STAGE[index]),
      ),
    })),
  };
}

function buildDefaultInfomorphsContents(now = Date.now()) {
  return {
    count: 0,
    lastGenerationTickMs: now,
  };
}

function normalizeEvolutionRecord(value = {}) {
  const fallbackDefinition = buildDefaultEvolutionDefinition();
  const fallbackSimulation = buildDefaultEvolutionSimulation();
  const developmentDefinition = value.definition && value.definition.development
    ? value.definition.development
    : {};
  const anarchyDefinition = value.definition && value.definition.anarchy
    ? value.definition.anarchy
    : {};
  const developmentSimulation = value.simulation && value.simulation.development
    ? value.simulation.development
    : {};
  const anarchySimulation = value.simulation && value.simulation.anarchy
    ? value.simulation.anarchy
    : {};
  return {
    definition: {
      development: {
        unitIncreaseTimeSeconds: Math.max(
          1,
          normalizeInteger(
            developmentDefinition.unitIncreaseTimeSeconds,
            fallbackDefinition.development.unitIncreaseTimeSeconds,
          ),
        ),
        stages: (Array.isArray(developmentDefinition.stages)
          ? developmentDefinition.stages
          : fallbackDefinition.development.stages
        ).map((entry, index) => ({
          stage: Math.max(1, normalizeInteger(entry && entry.stage, index + 1)),
          levelLowerBound: Math.max(
            0,
            normalizeInteger(entry && entry.levelLowerBound, index * 20),
          ),
          levelUpperBound: Math.max(
            0,
            normalizeInteger(entry && entry.levelUpperBound, index * 20 + 19),
          ),
        })),
      },
      anarchy: {
        unitIncreaseTimeSeconds: Math.max(
          1,
          normalizeInteger(
            anarchyDefinition.unitIncreaseTimeSeconds,
            fallbackDefinition.anarchy.unitIncreaseTimeSeconds,
          ),
        ),
        stages: (Array.isArray(anarchyDefinition.stages)
          ? anarchyDefinition.stages
          : fallbackDefinition.anarchy.stages
        ).map((entry, index) => ({
          stage: Math.max(1, normalizeInteger(entry && entry.stage, index + 1)),
          levelLowerBound: Math.max(
            0,
            normalizeInteger(entry && entry.levelLowerBound, index * 20),
          ),
          levelUpperBound: Math.max(
            0,
            normalizeInteger(entry && entry.levelUpperBound, index * 20 + 19),
          ),
          workforceConsumption: Math.max(
            0,
            normalizeInteger(entry && entry.workforceConsumption, index * 5),
          ),
        })),
      },
    },
    simulation: {
      paused: normalizeBoolean(
        value.simulation && value.simulation.paused,
        fallbackSimulation.paused,
      ),
      started: normalizeBoolean(
        value.simulation && value.simulation.started,
        fallbackSimulation.started,
      ),
      development: {
        level: Math.max(
          0,
          normalizeInteger(
            developmentSimulation.level,
            fallbackSimulation.development.level,
          ),
        ),
        stage: Math.max(
          1,
          normalizeInteger(
            developmentSimulation.stage,
            fallbackSimulation.development.stage,
          ),
        ),
        pausedAtMs: normalizeTimestampMs(
          developmentSimulation.pausedAtMs,
          fallbackSimulation.development.pausedAtMs,
        ),
        simulatedAtMs: normalizeTimestampMs(
          developmentSimulation.simulatedAtMs,
          fallbackSimulation.development.simulatedAtMs,
        ),
      },
      anarchy: {
        level: Math.max(
          0,
          normalizeInteger(
            anarchySimulation.level,
            fallbackSimulation.anarchy.level,
          ),
        ),
        stage: Math.max(
          1,
          normalizeInteger(
            anarchySimulation.stage,
            fallbackSimulation.anarchy.stage,
          ),
        ),
        pausedAtMs: normalizeTimestampMs(
          anarchySimulation.pausedAtMs,
          fallbackSimulation.anarchy.pausedAtMs,
        ),
        simulatedAtMs: normalizeTimestampMs(
          anarchySimulation.simulatedAtMs,
          fallbackSimulation.anarchy.simulatedAtMs,
        ),
      },
    },
  };
}

function normalizeInfomorphsRecord(value = {}) {
  const fallbackDefinition = buildDefaultInfomorphsDefinition();
  const fallbackContents = buildDefaultInfomorphsContents();
  const definition = value.definition || {};
  const contents = value.contents || {};
  return {
    definition: {
      infomorphTypeID: normalizePositiveInteger(
        definition.infomorphTypeID,
        fallbackDefinition.infomorphTypeID,
      ),
      generationTickSeconds: Math.max(
        1,
        normalizeInteger(
          definition.generationTickSeconds,
          fallbackDefinition.generationTickSeconds,
        ),
      ),
      cargoCapacity: Math.max(
        0,
        normalizeInteger(
          definition.cargoCapacity,
          fallbackDefinition.cargoCapacity,
        ),
      ),
      generationBands: (Array.isArray(definition.generationBands)
        ? definition.generationBands
        : fallbackDefinition.generationBands
      ).map((entry, index) => ({
        stage: Math.max(1, normalizeInteger(entry && entry.stage, index + 1)),
        lowerBand: Math.max(
          0,
          normalizeInteger(entry && entry.lowerBand, index),
        ),
        upperBand: Math.max(
          0,
          normalizeInteger(entry && entry.upperBand, index + 1),
        ),
      })),
    },
    contents: {
      count: Math.max(0, normalizeInteger(contents.count, fallbackContents.count)),
      lastGenerationTickMs: normalizeTimestampMs(
        contents.lastGenerationTickMs,
        fallbackContents.lastGenerationTickMs,
      ),
    },
  };
}

function normalizeActivityTemplateDefinition(value = {}, fallback = {}) {
  return {
    templateID: normalizePositiveInteger(value.templateID, fallback.templateID || 1),
    nameMessageID: normalizePositiveInteger(
      value.nameMessageID,
      fallback.nameMessageID || 330000001,
    ),
    descriptionMessageID: normalizePositiveInteger(
      value.descriptionMessageID,
      fallback.descriptionMessageID || 330000011,
    ),
    dungeonID: normalizePositiveInteger(value.dungeonID, fallback.dungeonID || 8800001),
    developmentImpact: normalizeInteger(
      value.developmentImpact,
      fallback.developmentImpact || 0,
    ),
    anarchyImpact: normalizeInteger(
      value.anarchyImpact,
      fallback.anarchyImpact || 0,
    ),
    infomorphBonus: Math.max(
      0,
      normalizeInteger(value.infomorphBonus, fallback.infomorphBonus || 0),
    ),
  };
}

function normalizeMercenaryActivityRecord(value = {}, fallback = {}) {
  return {
    activityID: String(value.activityID || fallback.activityID || createUuidString())
      .trim()
      .toLowerCase(),
    mercenaryDenID: normalizePositiveInteger(
      value.mercenaryDenID,
      fallback.mercenaryDenID,
    ),
    solarSystemID: normalizePositiveInteger(
      value.solarSystemID,
      fallback.solarSystemID,
    ),
    started: normalizeBoolean(value.started, fallback.started || false),
    expiryMs: normalizeTimestampMs(value.expiryMs, fallback.expiryMs || 0),
    template: normalizeActivityTemplateDefinition(
      value.template,
      fallback.template || {},
    ),
  };
}

function buildDefaultActivitiesForDen(den, now = Date.now()) {
  return DEFAULT_ACTIVITY_TEMPLATE_DEFINITIONS.slice(
    0,
    DEFAULT_MERCENARY_DEN_ACTIVITY_CAPACITY,
  ).map((templateDefinition, index) =>
    normalizeMercenaryActivityRecord(
      {
        activityID: createUuidString(),
        mercenaryDenID: den.mercenaryDenID,
        solarSystemID: den.solarSystemID,
        started: false,
        expiryMs: now + DEFAULT_ACTIVITY_DURATION_MS + index * 15 * 60 * 1000,
        template: templateDefinition,
      },
      {
        mercenaryDenID: den.mercenaryDenID,
        solarSystemID: den.solarSystemID,
      },
    ),
  );
}

// The den's in-space component state, kept on its record (the runtime in
// ship/mercenaryDenRuntime owns its meaning): activation, the one
// reinforcement cycle, and when the owner was last told of an attack.
function normalizeMercenaryDenSpace(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const reinforcement = value.reinforcement && typeof value.reinforcement === "object"
    ? {
        stage: value.reinforcement.stage === "vulnerable" ? "vulnerable" : "reinforced",
        startedAtMs: normalizeTimestampMs(value.reinforcement.startedAtMs, 0),
        endsAtMs: normalizeTimestampMs(value.reinforcement.endsAtMs, 0),
      }
    : null;
  return {
    deployedAtMs: normalizeTimestampMs(value.deployedAtMs, 0),
    activateAtMs: normalizeTimestampMs(value.activateAtMs, 0),
    active: value.active === true,
    reinforcement,
    lastAttackNoticeAtMs: normalizeTimestampMs(value.lastAttackNoticeAtMs, 0),
  };
}

function normalizeMercenaryDenRecord(value = {}) {
  const now = Date.now();
  const mercenaryDenID = normalizePositiveInteger(
    value.mercenaryDenID || value.denID || value.id,
    null,
  );
  return {
    mercenaryDenID,
    ownerCharacterID: normalizePositiveInteger(value.ownerCharacterID, null),
    skyhookID: normalizePositiveInteger(value.skyhookID, null),
    solarSystemID: normalizePositiveInteger(value.solarSystemID, null),
    planetID: normalizePositiveInteger(value.planetID, null),
    typeID: normalizePositiveInteger(value.typeID, TYPE_MERCENARY_DEN),
    enabled: normalizeBoolean(value.enabled, true),
    cargoExtractionEnabled: normalizeBoolean(value.cargoExtractionEnabled, false),
    skyhookOwnerCorporationID: normalizePositiveInteger(
      value.skyhookOwnerCorporationID,
      null,
    ),
    registeredAtMs: normalizeTimestampMs(value.registeredAtMs, 0),
    space: normalizeMercenaryDenSpace(value.space),
    evolution: normalizeEvolutionRecord(value.evolution || {}),
    infomorphs: normalizeInfomorphsRecord(value.infomorphs || {}),
    nextGenerationAtMs: normalizeTimestampMs(
      value.nextGenerationAtMs,
      now + DEFAULT_ACTIVITY_GENERATION_INTERVAL_MS,
    ),
    activities: Array.isArray(value.activities)
      ? value.activities
          .map((entry) =>
            normalizeMercenaryActivityRecord(entry, {
              mercenaryDenID,
              solarSystemID: value.solarSystemID,
            }),
          )
          .filter((entry) => entry.mercenaryDenID && entry.solarSystemID)
      : [],
  };
}

function applyMercenaryDenTimeTransitions(table) {
  let changed = false;
  const now = Date.now();

  for (const [mercenaryDenID, rawDen] of Object.entries(table.mercenaryDens || {})) {
    let den = normalizeMercenaryDenRecord(rawDen);
    const activeActivities = [];
    for (const activity of den.activities) {
      if (normalizeTimestampMs(activity.expiryMs, 0) > now) {
        activeActivities.push(activity);
      } else {
        changed = true;
      }
    }
    den.activities = activeActivities;
    if (
      den.activities.length === 0 &&
      normalizeTimestampMs(den.nextGenerationAtMs, 0) <= now
    ) {
      den.activities = buildDefaultActivitiesForDen(den, now);
      den.nextGenerationAtMs = now + DEFAULT_ACTIVITY_GENERATION_INTERVAL_MS;
      changed = true;
    }
    table.mercenaryDens[mercenaryDenID] = den;
  }

  return changed;
}

function buildCache(table) {
  const densByID = new Map();
  const denIDBySkyhookID = new Map();
  const denIDsByOwnerCharacterID = new Map();
  const activitiesByDenID = new Map();
  const activityByID = new Map();
  const activitiesByOwnerCharacterID = new Map();

  for (const rawDen of Object.values(table.mercenaryDens || {})) {
    const den = normalizeMercenaryDenRecord(rawDen);
    if (!den.mercenaryDenID || !den.ownerCharacterID) {
      continue;
    }
    densByID.set(den.mercenaryDenID, den);
    if (den.skyhookID) {
      denIDBySkyhookID.set(den.skyhookID, den.mercenaryDenID);
    }
    if (!denIDsByOwnerCharacterID.has(den.ownerCharacterID)) {
      denIDsByOwnerCharacterID.set(den.ownerCharacterID, []);
    }
    denIDsByOwnerCharacterID.get(den.ownerCharacterID).push(den.mercenaryDenID);
    activitiesByDenID.set(den.mercenaryDenID, den.activities);
    if (!activitiesByOwnerCharacterID.has(den.ownerCharacterID)) {
      activitiesByOwnerCharacterID.set(den.ownerCharacterID, []);
    }
    activitiesByOwnerCharacterID.get(den.ownerCharacterID).push(...den.activities);
    for (const activity of den.activities) {
      activityByID.set(activity.activityID, {
        ...activity,
        ownerCharacterID: den.ownerCharacterID,
      });
    }
  }

  for (const denIDs of denIDsByOwnerCharacterID.values()) {
    denIDs.sort((left, right) => left - right);
  }
  for (const activities of activitiesByOwnerCharacterID.values()) {
    activities.sort((left, right) => left.activityID.localeCompare(right.activityID));
  }

  return {
    updatedAt: table && table._meta ? table._meta.updatedAt || null : null,
    densByID,
    denIDBySkyhookID,
    denIDsByOwnerCharacterID,
    activitiesByDenID,
    activityByID,
    activitiesByOwnerCharacterID,
  };
}

function ensureLoaded() {
  const table = readSovereigntyTable();
  const updatedAt = table && table._meta ? table._meta.updatedAt || null : null;
  if (cache && cache.updatedAt === updatedAt) {
    return cache;
  }

  const nextTable = cloneValue(table);
  if (applyMercenaryDenTimeTransitions(nextTable)) {
    writeSovereigntyTable(nextTable);
    cache = buildCache(nextTable);
    return cache;
  }

  cache = buildCache(nextTable);
  return cache;
}

function requireOwner(mercenaryDenID, characterID) {
  const current = ensureLoaded();
  const den = current.densByID.get(normalizePositiveInteger(mercenaryDenID, 0)) || null;
  if (!den) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: "UNKNOWN_MERCENARY_DEN",
    };
  }
  if (normalizePositiveInteger(characterID, 0) !== den.ownerCharacterID) {
    return {
      ok: false,
      statusCode: 403,
      errorCode: "ACCESS_DENIED",
    };
  }
  return {
    ok: true,
    den: buildMercenaryDenView(den),
  };
}

function mutateMercenaryDens(mutator) {
  const table = cloneValue(readSovereigntyTable());
  const result = mutator(table);
  if (result && result.ok === false) {
    return result;
  }
  const writtenTable = writeSovereigntyTable(table);
  cache = buildCache(writtenTable);
  return result;
}

function getMercenaryDenMaximumForCharacter(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, 0);
  const skillLevel = getSkillLevel(
    numericCharacterID,
    MERCENARY_DEN_MANAGEMENT_SKILL_TYPE_ID,
  );
  return {
    currentMaximum: Math.min(DEFAULT_MERCENARY_DEN_ABSOLUTE_MAXIMUM, skillLevel),
    absoluteMaximum: DEFAULT_MERCENARY_DEN_ABSOLUTE_MAXIMUM,
  };
}

function listOwnedMercenaryDenIDs(characterID) {
  const current = ensureLoaded();
  return cloneValue(
    current.denIDsByOwnerCharacterID.get(
      normalizePositiveInteger(characterID, 0),
    ) || [],
  );
}

function getMercenaryDenAsOwner(characterID, mercenaryDenID) {
  const access = requireOwner(mercenaryDenID, characterID);
  if (!access.ok) {
    return access;
  }
  return {
    ok: true,
    den: access.den,
  };
}

function listMercenaryDenActivitiesForCharacter(characterID) {
  const current = ensureLoaded();
  return cloneValue(
    current.activitiesByOwnerCharacterID.get(
      normalizePositiveInteger(characterID, 0),
    ) || [],
  );
}

function getMercenaryDenActivities(characterID, mercenaryDenID) {
  const access = requireOwner(mercenaryDenID, characterID);
  if (!access.ok) {
    return access;
  }
  return {
    ok: true,
    mercenaryDenID: access.den.mercenaryDenID,
    nextGenerationAtMs: access.den.nextGenerationAtMs,
    activities: cloneValue(access.den.activities),
  };
}

function getMercenaryActivityCapacity() {
  return DEFAULT_MERCENARY_DEN_ACTIVITY_CAPACITY;
}

function startMercenaryDenActivity(characterID, activityID) {
  const current = ensureLoaded();
  const existingActivity = current.activityByID.get(
    String(activityID || "").trim().toLowerCase(),
  );
  if (!existingActivity) {
    return {
      ok: false,
      statusCode: 404,
      errorCode: "UNKNOWN_ACTIVITY",
    };
  }
  const access = requireOwner(existingActivity.mercenaryDenID, characterID);
  if (!access.ok) {
    return access;
  }
  if (existingActivity.started) {
    return {
      ok: false,
      statusCode: 409,
      errorCode: "ACTIVITY_ALREADY_STARTED",
    };
  }

  return mutateMercenaryDens((table) => {
    const denKey = String(existingActivity.mercenaryDenID);
    const den = normalizeMercenaryDenRecord(table.mercenaryDens[denKey]);
    const activityIndex = den.activities.findIndex(
      (entry) => entry.activityID === existingActivity.activityID,
    );
    if (activityIndex < 0) {
      return {
        ok: false,
        statusCode: 404,
        errorCode: "UNKNOWN_ACTIVITY",
      };
    }
    const nextActivity = normalizeMercenaryActivityRecord(
      {
        ...den.activities[activityIndex],
        started: true,
        expiryMs: Math.max(
          normalizeTimestampMs(den.activities[activityIndex].expiryMs, 0),
          Date.now() + DEFAULT_ACTIVITY_DURATION_MS,
        ),
      },
      den.activities[activityIndex],
    );
    den.activities[activityIndex] = nextActivity;
    table.mercenaryDens[denKey] = den;
    return {
      ok: true,
      mercenaryDenID: den.mercenaryDenID,
      ownerCharacterID: den.ownerCharacterID,
      solarSystemID: den.solarSystemID,
      activity: nextActivity,
    };
  });
}

// --- Evolution and infomorph simulation -----------------------------------
//
// The server keeps a base level and the time it was reached; the client adds
// one level per unitIncreaseTimeSeconds since simulated_at itself
// (repository._calculate_level_based_on_natural_progression), so a read hands
// out the whole levels earned so far and the time the last one was reached.
// Infomorphs are added one generation tick at a time; each tick's amount is a
// deterministic draw in the band of the development stage at that tick, so a
// settle repeated with the same inputs gives the same count.

function getStageForLevel(stages, level) {
  const numericLevel = Math.max(0, normalizeInteger(level, 0));
  let resolvedStage = 1;
  for (const entry of Array.isArray(stages) ? stages : []) {
    if (numericLevel >= normalizeInteger(entry && entry.levelLowerBound, 0)) {
      resolvedStage = Math.max(resolvedStage, normalizeInteger(entry && entry.stage, 1));
    }
  }
  return resolvedStage;
}

function advanceEvolutionTrack(track, definition, paused, nowMs) {
  const unitMs = Math.max(1, normalizeInteger(definition && definition.unitIncreaseTimeSeconds, 1)) * 1000;
  const level = Math.min(EVOLUTION_LEVEL_MAXIMUM, Math.max(0, normalizeInteger(track.level, 0)));
  if (paused || !track.simulatedAtMs || nowMs <= track.simulatedAtMs) {
    return { ...track, level, stage: getStageForLevel(definition && definition.stages, level) };
  }
  const units = Math.floor((nowMs - track.simulatedAtMs) / unitMs);
  const nextLevel = Math.min(EVOLUTION_LEVEL_MAXIMUM, level + units);
  return {
    ...track,
    level: nextLevel,
    stage: getStageForLevel(definition && definition.stages, nextLevel),
    pausedAtMs: 0,
    simulatedAtMs: nextLevel >= EVOLUTION_LEVEL_MAXIMUM
      ? nowMs
      : track.simulatedAtMs + units * unitMs,
  };
}

function getEvolutionLevelAt(track, definition, paused, atMs) {
  return advanceEvolutionTrack(track, definition, paused, atMs).level;
}

// Unsigned 32-bit FNV-1a hash of the den, the tick time and a salt, as [0, 1).
function hashToUnitInterval(...parts) {
  let hash = 0x811c9dc5;
  const text = parts.join(":");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

function drawInfomorphsForTick(den, stage, tickAtMs) {
  const bands = den.infomorphs.definition.generationBands || [];
  const band = bands.find((entry) => entry.stage === stage) || bands[0] || { lowerBand: 0, upperBand: 0 };
  const lower = Math.max(0, normalizeInteger(band.lowerBand, 0));
  const upper = Math.max(lower, normalizeInteger(band.upperBand, lower));
  const roll = hashToUnitInterval(den.mercenaryDenID, tickAtMs, "infomorphs");
  return lower + Math.floor(roll * (upper - lower + 1));
}

// The den as it stands at nowMs: levels, stages and infomorphs brought up to
// date. Pure; mutations write the result back.
function buildMercenaryDenView(rawDen, nowMs = getWallclockNowMs()) {
  const den = normalizeMercenaryDenRecord(cloneValue(rawDen));
  const definition = den.evolution.definition;
  const simulation = den.evolution.simulation;
  const paused = simulation.paused === true;
  const developmentBefore = { ...simulation.development };

  if (den.enabled) {
    const contents = den.infomorphs.contents;
    const tickMs = Math.max(1, den.infomorphs.definition.generationTickSeconds) * 1000;
    const capacity = den.infomorphs.definition.cargoCapacity;
    const ticks = Math.min(
      MAX_GENERATION_TICKS_PER_SETTLE,
      Math.max(0, Math.floor((nowMs - contents.lastGenerationTickMs) / tickMs)),
    );
    let count = contents.count;
    let lastTickMs = contents.lastGenerationTickMs;
    for (let index = 0; index < ticks; index += 1) {
      lastTickMs += tickMs;
      if (count >= capacity) {
        continue;
      }
      const developmentLevel = getEvolutionLevelAt(
        developmentBefore,
        definition.development,
        paused,
        lastTickMs,
      );
      const stage = getStageForLevel(definition.development.stages, developmentLevel);
      count = Math.min(capacity, count + drawInfomorphsForTick(den, stage, lastTickMs));
    }
    if (ticks === MAX_GENERATION_TICKS_PER_SETTLE) {
      lastTickMs = nowMs - ((nowMs - lastTickMs) % tickMs);
    }
    den.infomorphs.contents = { count, lastGenerationTickMs: lastTickMs };
  }

  simulation.development = advanceEvolutionTrack(
    simulation.development,
    definition.development,
    paused,
    nowMs,
  );
  simulation.anarchy = advanceEvolutionTrack(
    simulation.anarchy,
    definition.anarchy,
    paused,
    nowMs,
  );
  return den;
}

function getAnarchyWorkforceConsumption(den) {
  const stage = den.evolution.simulation.anarchy.stage;
  const entry = den.evolution.definition.anarchy.stages.find(
    (candidate) => candidate.stage === stage,
  );
  return Math.max(0, normalizeInteger(entry && entry.workforceConsumption, 0));
}

// The workforce an enabled den takes from its skyhook now. sovModernState
// subtracts it from the skyhook's harvest.
function getSkyhookWorkforceSiphon(table, skyhookID, nowMs = getWallclockNowMs()) {
  const numericSkyhookID = normalizePositiveInteger(skyhookID, 0);
  if (!numericSkyhookID) {
    return 0;
  }
  for (const rawDen of Object.values((table && table.mercenaryDens) || {})) {
    if (normalizePositiveInteger(rawDen && rawDen.skyhookID, 0) !== numericSkyhookID) {
      continue;
    }
    const den = buildMercenaryDenView(rawDen, nowMs);
    return den.enabled ? getAnarchyWorkforceConsumption(den) : 0;
  }
  return 0;
}

// The next time a stage of this den changes (development or anarchy), so the
// runtime can write the den back and let the hub's resources follow.
function getNextEvolutionStageChangeMs(rawDen, nowMs = getWallclockNowMs()) {
  const den = buildMercenaryDenView(rawDen, nowMs);
  if (!den.enabled || den.evolution.simulation.paused) {
    return null;
  }
  let next = null;
  for (const key of ["development", "anarchy"]) {
    const track = den.evolution.simulation[key];
    const definition = den.evolution.definition[key];
    const upcoming = (definition.stages || [])
      .map((entry) => normalizeInteger(entry.levelLowerBound, 0))
      .filter((bound) => bound > track.level)
      .sort((left, right) => left - right)[0];
    if (upcoming === undefined) {
      continue;
    }
    const atMs = track.simulatedAtMs +
      (upcoming - track.level) * definition.unitIncreaseTimeSeconds * 1000;
    next = next === null ? atMs : Math.min(next, atMs);
  }
  return next;
}

function getMercenaryDenByID(mercenaryDenID, nowMs = getWallclockNowMs()) {
  const current = ensureLoaded();
  const den = current.densByID.get(normalizePositiveInteger(mercenaryDenID, 0)) || null;
  return den ? buildMercenaryDenView(den, nowMs) : null;
}

// The stored record without bringing its simulation up to date.
function peekMercenaryDenRecord(mercenaryDenID) {
  const current = ensureLoaded();
  const den = current.densByID.get(normalizePositiveInteger(mercenaryDenID, 0)) || null;
  return den ? cloneValue(den) : null;
}

function getMercenaryDenIDForSkyhook(skyhookID) {
  const current = ensureLoaded();
  return current.denIDBySkyhookID.get(normalizePositiveInteger(skyhookID, 0)) || null;
}

function countOwnedMercenaryDens(characterID) {
  return listOwnedMercenaryDenIDs(characterID).length;
}

function writeDen(table, den) {
  table.mercenaryDens = table.mercenaryDens || {};
  table.mercenaryDens[String(den.mercenaryDenID)] = den;
}

// Registers a launched den. Placement rules are checked by the launch path;
// the two rules that need the den table are checked again here, inside the
// write, so two launches cannot both pass them.
function registerMercenaryDen(options = {}) {
  const nowMs = normalizeTimestampMs(options.nowMs, getWallclockNowMs());
  const mercenaryDenID = normalizePositiveInteger(options.mercenaryDenID, 0);
  const ownerCharacterID = normalizePositiveInteger(options.ownerCharacterID, 0);
  const skyhookID = normalizePositiveInteger(options.skyhookID, 0);
  if (!mercenaryDenID || !ownerCharacterID || !skyhookID) {
    return { ok: false, errorCode: "INVALID_REGISTRATION" };
  }
  const maximum = getMercenaryDenMaximumForCharacter(ownerCharacterID);
  return mutateMercenaryDens((table) => {
    const dens = Object.values(table.mercenaryDens || {}).map((entry) =>
      normalizeMercenaryDenRecord(entry));
    if (dens.some((den) => den.skyhookID === skyhookID && den.mercenaryDenID !== mercenaryDenID)) {
      return { ok: false, errorCode: "SKYHOOK_ALREADY_OCCUPIED" };
    }
    const owned = dens.filter((den) =>
      den.ownerCharacterID === ownerCharacterID && den.mercenaryDenID !== mercenaryDenID).length;
    if (owned >= maximum.currentMaximum) {
      return {
        ok: false,
        errorCode: owned >= maximum.absoluteMaximum ? "MAXIMUM_DENS_REACHED" : "SKILL_LIMITS",
      };
    }
    // Until the den finishes activating it makes nothing and its levels wait.
    const simulation = buildDefaultEvolutionSimulation(nowMs);
    simulation.paused = true;
    simulation.started = false;
    simulation.development.pausedAtMs = nowMs;
    simulation.anarchy.pausedAtMs = nowMs;
    const den = normalizeMercenaryDenRecord({
      mercenaryDenID,
      ownerCharacterID,
      skyhookID,
      solarSystemID: options.solarSystemID,
      planetID: options.planetID,
      typeID: options.typeID,
      enabled: false,
      cargoExtractionEnabled: true,
      skyhookOwnerCorporationID: options.skyhookOwnerCorporationID,
      registeredAtMs: nowMs,
      space: options.space || null,
      evolution: {
        definition: buildDefaultEvolutionDefinition(options.planetWorkforce),
        simulation,
      },
      infomorphs: {
        definition: buildDefaultInfomorphsDefinition(),
        contents: buildDefaultInfomorphsContents(nowMs),
      },
      nextGenerationAtMs: nowMs + DEFAULT_ACTIVITY_GENERATION_INTERVAL_MS,
      activities: [],
    });
    writeDen(table, den);
    return { ok: true, den: cloneValue(den) };
  });
}

function settleAndMutateDen(mercenaryDenID, nowMs, mutator) {
  const numericDenID = normalizePositiveInteger(mercenaryDenID, 0);
  return mutateMercenaryDens((table) => {
    const raw = table.mercenaryDens && table.mercenaryDens[String(numericDenID)];
    if (!raw) {
      return { ok: false, errorCode: "UNKNOWN_MERCENARY_DEN" };
    }
    const den = buildMercenaryDenView(raw, nowMs);
    const result = mutator(den) || { ok: true };
    if (result.ok === false) {
      return result;
    }
    writeDen(table, den);
    return { ok: true, ...result, den: cloneValue(den) };
  });
}

function setEvolutionPausedOnView(den, paused, nowMs) {
  const simulation = den.evolution.simulation;
  simulation.paused = paused;
  for (const key of ["development", "anarchy"]) {
    simulation[key] = {
      ...simulation[key],
      pausedAtMs: paused ? nowMs : 0,
      simulatedAtMs: nowMs,
    };
  }
}

// Activation done: the den is enabled, starts making infomorphs and its levels
// start to rise.
function activateMercenaryDen(mercenaryDenID, nowMs = getWallclockNowMs()) {
  return settleAndMutateDen(mercenaryDenID, nowMs, (den) => {
    if (den.enabled) {
      return { ok: true, changed: false };
    }
    den.enabled = true;
    den.evolution.simulation.started = true;
    den.infomorphs.contents.lastGenerationTickMs = nowMs;
    setEvolutionPausedOnView(den, false, nowMs);
    return { ok: true, changed: true };
  });
}

// Reinforcement pauses development and anarchy (patch 22.02); the den still
// makes infomorphs (Revenant notes).
function setMercenaryDenEvolutionPaused(mercenaryDenID, paused, nowMs = getWallclockNowMs()) {
  return settleAndMutateDen(mercenaryDenID, nowMs, (den) => {
    if (!den.enabled || den.evolution.simulation.paused === Boolean(paused)) {
      return { ok: true, changed: false };
    }
    setEvolutionPausedOnView(den, Boolean(paused), nowMs);
    return { ok: true, changed: true };
  });
}

// Replaces the den's in-space state with updater(current).
function updateMercenaryDenSpace(mercenaryDenID, updater, nowMs = getWallclockNowMs()) {
  return settleAndMutateDen(mercenaryDenID, nowMs, (den) => {
    den.space = normalizeMercenaryDenSpace(updater({ ...(den.space || {}) }));
    return { ok: true };
  });
}

// Writes the den's current levels and infomorphs back (stage changes).
function settleMercenaryDen(mercenaryDenID, nowMs = getWallclockNowMs()) {
  return settleAndMutateDen(mercenaryDenID, nowMs, () => ({ ok: true }));
}

// Takes up to quantity infomorphs out of the den. The caller grants them and
// puts back what it could not grant with returnMercenaryDenInfomorphs.
function takeMercenaryDenInfomorphs(mercenaryDenID, characterID, quantity, nowMs = getWallclockNowMs()) {
  const access = requireOwner(mercenaryDenID, characterID);
  if (!access.ok) {
    return access;
  }
  const requested = Math.max(0, normalizeInteger(quantity, 0));
  return settleAndMutateDen(mercenaryDenID, nowMs, (den) => {
    const taken = Math.min(requested, den.infomorphs.contents.count);
    den.infomorphs.contents.count -= taken;
    return { ok: true, taken, typeID: den.infomorphs.definition.infomorphTypeID };
  });
}

function returnMercenaryDenInfomorphs(mercenaryDenID, quantity, nowMs = getWallclockNowMs()) {
  const amount = Math.max(0, normalizeInteger(quantity, 0));
  return settleAndMutateDen(mercenaryDenID, nowMs, (den) => {
    den.infomorphs.contents.count = Math.min(
      den.infomorphs.definition.cargoCapacity,
      den.infomorphs.contents.count + amount,
    );
    return { ok: true };
  });
}

// Removes the den's record and hands back what it held at nowMs.
function unregisterMercenaryDen(mercenaryDenID, nowMs = getWallclockNowMs()) {
  const numericDenID = normalizePositiveInteger(mercenaryDenID, 0);
  return mutateMercenaryDens((table) => {
    const raw = table.mercenaryDens && table.mercenaryDens[String(numericDenID)];
    if (!raw) {
      return { ok: false, errorCode: "UNKNOWN_MERCENARY_DEN" };
    }
    const den = buildMercenaryDenView(raw, nowMs);
    delete table.mercenaryDens[String(numericDenID)];
    return { ok: true, den: cloneValue(den) };
  });
}

function resetMercenaryDenStateForTests() {
  cache = null;
}

module.exports = {
  EVOLUTION_UNIT_INCREASE_SECONDS,
  INFOMORPH_CARGO_CAPACITY,
  INFOMORPH_GENERATION_TICK_SECONDS,
  TYPE_INFOMORPH_DECRYPTION_KEY,
  activateMercenaryDen,
  buildMercenaryDenView,
  countOwnedMercenaryDens,
  getMercenaryDenByID,
  getMercenaryDenIDForSkyhook,
  getNextEvolutionStageChangeMs,
  getSkyhookWorkforceSiphon,
  peekMercenaryDenRecord,
  registerMercenaryDen,
  returnMercenaryDenInfomorphs,
  setMercenaryDenEvolutionPaused,
  settleMercenaryDen,
  takeMercenaryDenInfomorphs,
  unregisterMercenaryDen,
  updateMercenaryDenSpace,
  getMercenaryActivityCapacity,
  getMercenaryDenActivities,
  getMercenaryDenAsOwner,
  getMercenaryDenMaximumForCharacter,
  listMercenaryDenActivitiesForCharacter,
  listOwnedMercenaryDenIDs,
  resetMercenaryDenStateForTests,
  startMercenaryDenActivity,
};
