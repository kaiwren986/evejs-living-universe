"use strict";

// Event-facing adapters for the achievement catalog. Game services call these
// with facts they have already verified; this module translates those facts
// into catalog contribution values without exposing a writable client API.
const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const achievementState = require("./achievementState");

const METHOD_IDS = Object.freeze({
  VISIT_SOLAR_SYSTEM: "0fd986fb-c415-563a-9f07-3cd5984fb49e",
  VISIT_STARGATE: "6c192d1e-cb2c-5a06-a664-80e8e15aa90b",
  DUNGEON_ENTRY: "36bf2e3e-c5b3-5021-8245-fd9b5a54f449",
  UNIQUE_DUNGEON_ENTRY: "3dee9808-0242-5d3f-8c1b-a6f8b6143cb4",
  SIGNATURE_RESOLVED: "edefd4c8-b655-5da4-a74b-22283f66d88b",
  NPC_COMBAT_KILL: "bc91bad3-4a8b-5296-a5d3-087a89f5ef9d",
  PLAYER_SHIP_KILL: "c5cf8c21-4e10-5aaa-829f-1b9420ae93e1",
  SHIP_LOSS: "9f139ef3-d073-5c8d-9395-4fa9f207692d",
  MINING: "b84f272c-e789-5355-8da8-e6586cf04fd5",
  SALVAGING: "c133a532-97d5-55bf-9ba6-0f853e614c8a",
  MARKET_PURCHASE: "0e210216-e983-582d-abb5-d3fd2fe11876",
  MARKET_SALE: "c70994ff-ed5a-5a0e-9b4b-96150bdd1edc",
  MANUFACTURING: "f280d00d-5c68-54ed-a1d0-e7b532f4e235",
  REPROCESSING: "9f622ab2-6fd6-55cf-946c-13fde15f638f",
  EPIC_ARC_COMPLETION: "b1d1f64b-15f0-55c6-825e-785f249f7d8f",
  DATA_RELIC_SITE_COMPLETION: "e3802899-6a71-5ecd-97c4-e891af63281f",
  COMBAT_SITE_COMPLETION: "f07b3d8b-2299-5eef-abab-683ab8869fb2",
  ABYSSAL_COMPLETION: "2c695d07-b170-5b1a-a27b-b49c11e75fdd",
  FW_COMPLEX_COMPLETION: "4365644b-ae5b-54d0-9b2c-8418f23ced25",
  DUEL_PARTICIPATION: "756e3c48-59ff-5e27-b975-ad332d6c6277",
  FW_MOST_DAMAGE_KILL: "5691bcdd-b9fb-5e41-8719-294abb3ffe38",
});
const EXCLUDED_COMBAT_SHIP_GROUP_IDS = new Set([29, 31, 237]);

function positiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
}

function addValue(valuesByType, valueType, value) {
  const type = String(valueType || "").trim();
  const normalizedValue = String(value === undefined || value === null ? "" : value).trim();
  if (!type || !normalizedValue) {
    return;
  }
  if (!valuesByType[type]) {
    valuesByType[type] = [];
  }
  if (!valuesByType[type].includes(normalizedValue)) {
    valuesByType[type].push(normalizedValue);
  }
}

function mergeValueMaps(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [type, values] of Object.entries(map || {})) {
      for (const value of Array.isArray(values) ? values : []) {
        addValue(merged, type, value);
      }
    }
  }
  return merged;
}

function buildLocationValues(solarSystemID) {
  const valuesByType = {};
  const normalizedSolarSystemID = positiveInteger(solarSystemID);
  if (!normalizedSolarSystemID) {
    return valuesByType;
  }
  const system = worldData.getSolarSystemByID(normalizedSolarSystemID);
  if (!system) {
    return valuesByType;
  }
  addValue(valuesByType, "solarsystem", system.solarSystemID);
  addValue(valuesByType, "constellation", system.constellationID);
  addValue(valuesByType, "region", system.regionID);
  const security = Number(system.security || 0);
  if (security >= 0.45) {
    addValue(valuesByType, "security_class", "high_sec");
  } else if (security > 0) {
    addValue(valuesByType, "security_class", "low_sec");
  } else {
    addValue(valuesByType, "security_class", "null_sec");
  }
  return valuesByType;
}

function changed(result) {
  return Boolean(result && result.success && result.data && result.data.changed);
}

function buildShipValues(entity = null, fallbackTypeID = 0) {
  const typeID = positiveInteger(entity && entity.typeID, positiveInteger(fallbackTypeID));
  const itemType = resolveItemByTypeID(typeID);
  return {
    ship_type: [typeID],
    ship_class: [positiveInteger(
      entity && (entity.groupID || entity.slimGroupID),
      positiveInteger(itemType && itemType.groupID),
    )],
  };
}

function isEligibleCombatVictim(entity = null, fallbackTypeID = 0) {
  if (String(entity && entity.kind || "").toLowerCase() !== "ship") {
    return false;
  }
  const typeID = positiveInteger(entity && entity.typeID, positiveInteger(fallbackTypeID));
  const itemType = resolveItemByTypeID(typeID);
  const categoryID = positiveInteger(
    entity && (entity.categoryID || entity.slimCategoryID),
    positiveInteger(itemType && itemType.categoryID),
  );
  const groupID = positiveInteger(
    entity && (entity.groupID || entity.slimGroupID),
    positiveInteger(itemType && itemType.groupID),
  );
  if (isNpcVictim(entity)) {
    // Native combat rats are scene ships, but their SDE types are in the
    // Entity category rather than the capsuleer Ship category. Their native
    // NPC identity keeps ordinary entities out of this progression path.
    return categoryID === 11;
  }
  return categoryID === 6 && !EXCLUDED_COMBAT_SHIP_GROUP_IDS.has(groupID);
}

function isNpcVictim(entity = null) {
  const entityType = String(entity && entity.npcEntityType || "").trim().toLowerCase();
  return Boolean(entity && (entity.nativeNpc === true || entity.nativeNpcOccupied === true)) ||
    entityType === "npc" || entityType === "concord";
}

function recordCombatKillmailOutcome({
  killID,
  solarSystemID,
  victimEntity = null,
  victimIdentity = {},
  finalAttacker = {},
} = {}) {
  const eventKey = `killmail:${positiveInteger(killID)}`;
  const victimShipTypeID = positiveInteger(
    victimIdentity && victimIdentity.victimShipTypeID,
    positiveInteger(victimEntity && victimEntity.typeID),
  );
  if (!positiveInteger(killID) || !positiveInteger(solarSystemID) ||
    !isEligibleCombatVictim(victimEntity, victimShipTypeID)) {
    return { success: true, data: { changed: false } };
  }

  const locationValues = buildLocationValues(solarSystemID);
  const victimCharacterID = positiveInteger(victimIdentity && victimIdentity.victimCharacterID);
  const finalCharacterID = positiveInteger(finalAttacker && finalAttacker.characterID);
  const valuesByType = mergeValueMaps(locationValues, buildShipValues(victimEntity, victimShipTypeID), {
    character: [victimCharacterID],
    corporation: [positiveInteger(victimIdentity && victimIdentity.victimCorporationID)],
    alliance: [positiveInteger(victimIdentity && victimIdentity.victimAllianceID)],
    faction: [positiveInteger(victimIdentity && victimIdentity.victimFactionID)],
    combat_killmail: [eventKey],
  });
  const results = [];
  if (isNpcVictim(victimEntity) && finalCharacterID > 0) {
    results.push(achievementState.recordContribution(finalCharacterID, METHOD_IDS.NPC_COMBAT_KILL, {
      delta: 1,
      uniqueValueType: "combat_killmail",
      valuesByType: mergeValueMaps(locationValues, {
        combat_killmail: [eventKey],
      }),
    }));
  }
  if (!isNpcVictim(victimEntity) && finalCharacterID > 0 && finalCharacterID !== victimCharacterID) {
    results.push(achievementState.recordContribution(finalCharacterID, METHOD_IDS.PLAYER_SHIP_KILL, {
      delta: 1,
      uniqueValueType: "combat_killmail",
      valuesByType,
    }));
  }
  if (!isNpcVictim(victimEntity) && victimCharacterID > 0) {
    results.push(achievementState.recordContribution(victimCharacterID, METHOD_IDS.SHIP_LOSS, {
      delta: 1,
      uniqueValueType: "combat_killmail",
      valuesByType: mergeValueMaps(locationValues, buildShipValues(victimEntity, victimShipTypeID), {
        combat_killmail: [eventKey],
      }),
    }));
  }
  return { success: true, data: { changed: results.some(changed) } };
}

function recordStargateJump(characterID, sourceGate = null, destinationGate = null) {
  const destinationSystemID = positiveInteger(destinationGate && destinationGate.solarSystemID);
  const valuesByType = mergeValueMaps(buildLocationValues(destinationSystemID), {
    stargate: [positiveInteger(destinationGate && destinationGate.itemID)],
    source_stargate: [positiveInteger(sourceGate && sourceGate.itemID)],
  });
  const solarSystem = achievementState.recordContribution(characterID, METHOD_IDS.VISIT_SOLAR_SYSTEM, {
    delta: 1,
    valuesByType,
  });
  const stargate = achievementState.recordContribution(characterID, METHOD_IDS.VISIT_STARGATE, {
    delta: 1,
    valuesByType,
  });
  return {
    success: Boolean(solarSystem && solarSystem.success && stargate && stargate.success),
    data: { changed: changed(solarSystem) || changed(stargate) },
  };
}

function recordMining(characterID, solarSystemID, yieldTypeID, quantity) {
  const typeID = positiveInteger(yieldTypeID);
  const itemType = resolveItemByTypeID(typeID);
  return achievementState.recordContribution(characterID, METHOD_IDS.MINING, {
    delta: nonNegativeInteger(quantity),
    valuesByType: mergeValueMaps(buildLocationValues(solarSystemID), {
      ore_type: [typeID],
      ore_group: [positiveInteger(itemType && itemType.groupID)],
    }),
  });
}

// A successful salvage consumes the wreck even when its loot roll is empty, so
// the destroyed wreck—not the materials granted—is the authoritative unit of
// progress.  The durable wreck ID also makes a retried completion notification
// harmless.
function recordSalvage(characterID, wreckID) {
  const eventKey = String(wreckID === undefined || wreckID === null ? "" : wreckID).trim();
  if (!positiveInteger(characterID) || !eventKey) {
    return { success: true, data: { changed: false } };
  }
  return achievementState.recordContribution(characterID, METHOD_IDS.SALVAGING, {
    delta: 1,
    uniqueValueType: "salvage_wreck",
    valuesByType: {
      salvage_wreck: [`wreck:${eventKey}`],
    },
  });
}

function recordMarketContribution(characterID, methodID, amount, eventKey, eventType) {
  const normalizedEventKey = String(
    eventKey === undefined || eventKey === null ? "" : eventKey,
  ).trim();
  const normalizedAmount = nonNegativeInteger(amount);
  if (!positiveInteger(characterID) || !normalizedEventKey || normalizedAmount <= 0) {
    return { success: true, data: { changed: false } };
  }
  return achievementState.recordContribution(characterID, methodID, {
    delta: normalizedAmount,
    uniqueValueType: "market_fill",
    valuesByType: {
      market_fill: [`${eventType}:${normalizedEventKey}`],
    },
  });
}

// "Big Spender" measures the price paid for completed market purchases;
// broker fees, taxes, refunds, and unfilled escrow are deliberately excluded.
function recordMarketPurchase(characterID, amount, eventKey) {
  return recordMarketContribution(
    characterID,
    METHOD_IDS.MARKET_PURCHASE,
    amount,
    eventKey,
    "purchase",
  );
}

// "Market Tycoon" measures gross proceeds from a completed market sale.  The
// corresponding transaction tax is a separate wallet event, not sale value.
function recordMarketSale(characterID, amount, eventKey) {
  return recordMarketContribution(
    characterID,
    METHOD_IDS.MARKET_SALE,
    amount,
    eventKey,
    "sale",
  );
}

function recordManufacturing(characterID, outputs = [], solarSystemID = 0, options = {}) {
  let anyChanged = false;
  const quantitiesByTypeID = new Map();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    const typeID = positiveInteger(output && output.typeID);
    const quantity = nonNegativeInteger(output && output.quantity);
    if (!typeID || !quantity) {
      continue;
    }
    quantitiesByTypeID.set(typeID, (quantitiesByTypeID.get(typeID) || 0) + quantity);
  }
  for (const [typeID, quantity] of quantitiesByTypeID.entries()) {
    const itemType = resolveItemByTypeID(typeID);
    const result = achievementState.recordContribution(characterID, METHOD_IDS.MANUFACTURING, {
      delta: quantity,
      uniqueValueType: options.eventKey ? "manufacturing_event" : "",
      valuesByType: mergeValueMaps(buildLocationValues(solarSystemID), {
        output_item_type: [typeID],
        item_group: [positiveInteger(itemType && itemType.groupID)],
        manufacturing_event: options.eventKey ? [`${options.eventKey}:${typeID}`] : [],
      }),
    });
    anyChanged = anyChanged || changed(result);
  }
  return { success: true, data: { changed: anyChanged } };
}

function recordReprocessing(characterID, solarSystemID, inputTypeID, quantity, options = {}) {
  return achievementState.recordContribution(characterID, METHOD_IDS.REPROCESSING, {
    delta: nonNegativeInteger(quantity),
    uniqueValueType: options.eventKey ? "reprocessing_event" : "",
    valuesByType: mergeValueMaps(buildLocationValues(solarSystemID), {
      input_item_type: [positiveInteger(inputTypeID)],
      reprocessing_event: options.eventKey ? [String(options.eventKey)] : [],
    }),
  });
}

function recordEpicArcCompletion(characterID, epicArcID) {
  const value = positiveInteger(epicArcID);
  if (!value) {
    return { success: true, data: { changed: false } };
  }
  return achievementState.recordContribution(characterID, METHOD_IDS.EPIC_ARC_COMPLETION, {
    delta: 1,
    uniqueValueType: "epic_arc",
    valuesByType: { epic_arc: [value] },
  });
}

function recordSignatureResolution(characterID, signatureID, solarSystemID = 0) {
  const value = String(signatureID || "").trim();
  if (!value) {
    return { success: true, data: { changed: false } };
  }
  return achievementState.recordContribution(characterID, METHOD_IDS.SIGNATURE_RESOLVED, {
    delta: 1,
    uniqueValueType: "signature",
    valuesByType: mergeValueMaps(buildLocationValues(solarSystemID), {
      signature: [value],
    }),
  });
}

function recordDungeonEntry(characterID, site = {}, options = {}) {
  const dungeonID = positiveInteger(site.dungeonID || site.sourceDungeonID);
  const templateID = String(site.templateID || "").trim();
  const dungeonValue = dungeonID ? String(dungeonID) : templateID;
  if (!dungeonValue) {
    return { success: true, data: { changed: false } };
  }
  const valuesByType = mergeValueMaps(
    buildLocationValues(site.solarSystemID || site.systemID),
    {
      dungeon: [dungeonValue],
      archetype: [positiveInteger(site.archetypeID)],
      faction: [positiveInteger(site.factionID)],
      dungeon_entry: options.eventKey ? [String(options.eventKey)] : [],
    },
  );
  const cumulative = achievementState.recordContribution(characterID, METHOD_IDS.DUNGEON_ENTRY, {
    delta: 1,
    uniqueValueType: options.eventKey ? "dungeon_entry" : "",
    valuesByType,
  });
  const unique = achievementState.recordContribution(characterID, METHOD_IDS.UNIQUE_DUNGEON_ENTRY, {
    delta: 1,
    valuesByType,
  });
  return {
    success: Boolean(cumulative && cumulative.success && unique && unique.success),
    data: { changed: changed(cumulative) || changed(unique) },
  };
}

// These adapters accept only completed outcomes from their domain owners. The
// receipt is independent of sessions, so replay after a restart cannot count a
// site, capture or accepted duel twice.
function recordCompletedOutcome(characterID, methodID, eventKey, valuesByType = {}) {
  const key = String(eventKey || "").trim();
  if (!positiveInteger(characterID) || !key) {
    return { success: false, errorMsg: "ACHIEVEMENT_OUTCOME_RECEIPT_REQUIRED" };
  }
  return achievementState.recordContribution(characterID, methodID, {
    delta: 1,
    uniqueValueType: "completed_outcome",
    valuesByType: mergeValueMaps(valuesByType, { completed_outcome: [key] }),
  });
}

function recordDataRelicSiteCompletion(characterID, site = {}, options = {}) {
  return recordCompletedOutcome(characterID, METHOD_IDS.DATA_RELIC_SITE_COMPLETION,
    options.eventKey, buildLocationValues(site.solarSystemID || site.systemID));
}

function recordCombatSiteCompletion(characterID, site = {}, options = {}) {
  return recordCompletedOutcome(characterID, METHOD_IDS.COMBAT_SITE_COMPLETION,
    options.eventKey, buildLocationValues(site.solarSystemID || site.systemID));
}

function recordAbyssalCompletion(characterID, pocketState = {}, options = {}) {
  return recordCompletedOutcome(characterID, METHOD_IDS.ABYSSAL_COMPLETION, options.eventKey);
}

function recordFwComplexCompletion(characterID, outcome = {}) {
  return recordCompletedOutcome(characterID, METHOD_IDS.FW_COMPLEX_COMPLETION,
    outcome.receiptID, mergeValueMaps(buildLocationValues(outcome.solarSystemID), {
      archetype: [positiveInteger(outcome.complexArchetypeID)],
    }));
}

function recordDuelParticipation(characterID, duelReceiptID) {
  return recordCompletedOutcome(characterID, METHOD_IDS.DUEL_PARTICIPATION, duelReceiptID);
}

// facwarCommon's occupation and insurgency enemies. Racial ancestry and NPC
// corporation allegiance are not militia membership.
const FW_ENEMY_PAIRS = [[500003, 500002], [500001, 500004],
  [500011, 500003], [500011, 500002], [500010, 500001], [500010, 500004]];
function areFactionWarfareEnemies(first, second) {
  return FW_ENEMY_PAIRS.some(([a, b]) => Number(first) === a && Number(second) === b ||
    Number(first) === b && Number(second) === a);
}
function snapshotFactionWarfareWinner(record = {}) {
  if (!positiveInteger(record.victimCharacterID) ||
      !isEligibleCombatVictim({ kind: "ship", typeID: record.victimShipTypeID })) return null;
  const totals = new Map();
  for (const attacker of [...(record.attackers || []), {
    characterID: record.finalCharacterID, damageDone: record.finalDamageDone,
  }]) {
    const id = positiveInteger(attacker.characterID), damage = Number(attacker.damageDone);
    if (id && Number.isFinite(damage) && damage > 0) totals.set(id, (totals.get(id) || 0) + damage);
  }
  const winner = [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (!winner || winner[0] === Number(record.victimCharacterID)) return null;
  const { getCharacterRecord } = require("../character/characterState");
  const victim = getCharacterRecord(record.victimCharacterID), attacker = getCharacterRecord(winner[0]);
  const first = positiveInteger(victim?.warFactionID ?? victim?.warfactionid);
  const second = positiveInteger(attacker?.warFactionID ?? attacker?.warfactionid);
  return areFactionWarfareEnemies(first, second) ? winner[0] : null;
}

function recordCommittedFactionWarfareKill(record = {}) {
  const id = positiveInteger(record.achievementFwWinnerCharacterID);
  if (!id || !positiveInteger(record.killID)) return { success: true, data: { changed: false } };
  return recordCompletedOutcome(id, METHOD_IDS.FW_MOST_DAMAGE_KILL, `killmail:${record.killID}`);
}

function reconcileFactionWarfareKills() {
  for (const record of require("../killmail/killmailState").getAllKillmailRecords()) {
    const result = recordCommittedFactionWarfareKill(record);
    if (!result?.success) throw new Error(result?.errorMsg || "FW_ACHIEVEMENT_RECOVERY_FAILED");
  }
}

module.exports = {
  METHOD_IDS,
  buildLocationValues,
  recordCombatKillmailOutcome,
  recordDungeonEntry,
  recordEpicArcCompletion,
  recordManufacturing,
  recordMarketPurchase,
  recordMarketSale,
  recordMining,
  recordReprocessing,
  recordSalvage,
  recordSignatureResolution,
  recordStargateJump,
  recordDataRelicSiteCompletion,
  recordCombatSiteCompletion,
  recordAbyssalCompletion,
  recordFwComplexCompletion,
  recordDuelParticipation,
  snapshotFactionWarfareWinner,
  areFactionWarfareEnemies,
  recordCommittedFactionWarfareKill,
  reconcileFactionWarfareKills,
};
