"use strict";

const crypto = require("node:crypto");
const { graphError } = require("./nodeGraphCompiler");

// These handlers have current domain owners. AIR supplies its scene actions
// separately; unsupported atoms are never allowed to fall through as success.
const ACTION_ATOMS = Object.freeze([204, 269, 363, 364, 365]);
const GETTER_ATOMS = Object.freeze([285, 301, 302, 303, 307, 391, 406, 415, 446, 452]);
const CONDITION_ATOMS = Object.freeze([34, 289, 308, 368]);
const EVENT_ATOMS = Object.freeze([190, 305]);

function effectKey(instance, node) {
  return `nodegraph:${crypto.createHash("sha256").update(JSON.stringify([instance.characterID, instance.rootInstanceID, instance.instanceID, instance.graphID, node.nodeID, node.atomID])).digest("hex")}`;
}

function checkCharacter(instance, parameters) {
  if (parameters.character_id !== undefined && Number(parameters.character_id) !== instance.characterID) throw graphError("NODEGRAPH_CHARACTER_FORBIDDEN");
}

function requireSuccess(result) {
  if (!result || result.success !== true) throw graphError("NODEGRAPH_EFFECT_FAILED", result?.errorMsg || "missing result");
  return result;
}

function executeAction(instance, node, parameters, root, recovery) {
  checkCharacter(instance, parameters);
  const characterState = require("../character/characterState");
  const characterID = instance.characterID;
  const idempotencyKey = effectKey(instance, node);
  switch (node.atomID) {
    case 204: {
      const checkpoint = Number(parameters.checkpoint_id);
      if (!Number.isSafeInteger(checkpoint) || checkpoint <= 0) throw graphError("NODEGRAPH_CHECKPOINT_INVALID");
      const graphID = Number(parameters.node_graph_id || root.graphID);
      root.checkpoints[graphID] = checkpoint;
      (root.pendingCheckpointUpdates ||= {})[graphID] = checkpoint;
      return {};
    }
    case 269: {
      const custody = require("../inventory/itemCustody");
      const record = characterState.getCharacterRecord(characterID);
      const locationID = Number(record.structureID || record.stationID || record.stationid || (parameters.should_use_home_station_as_fallback ? record.homeStationID : 0));
      if (!locationID || !Number.isSafeInteger(Number(parameters.type_id)) || !Number.isSafeInteger(Number(parameters.quantity ?? 1)) || Number(parameters.quantity ?? 1) < 1) throw graphError("NODEGRAPH_ITEM_REWARD_INVALID");
      const result = requireSuccess(custody.transfer({
        items: { typeID: Number(parameters.type_id), quantity: Number(parameters.quantity ?? 1), options: { singleton: 0, onlyIfMissing: Boolean(parameters.should_only_create_if_missing) } },
        to: custody.custodyRef.ownerLocation(characterID, locationID, 4),
        reason: custody.CUSTODY_REASON.NODEGRAPH_REWARD_GRANT,
        actor: characterID, idempotencyKey,
      }));
      return { item_id: result.data?.items?.[0]?.itemID || null };
    }
    case 363: {
      const amount = Number(parameters.isk_amount);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e9) throw graphError("NODEGRAPH_ISK_REWARD_INVALID");
      return require("../account/nodeGraphReward").grantTaxedIskOnce(characterID, amount, idempotencyKey, Number(parameters.corporation_id || 1000125), recovery).then(result => { requireSuccess(result); return {}; });
    }
    case 364: {
      const typeID = Number(parameters.type_id), level = Number(parameters.level ?? 1);
      if (!Number.isSafeInteger(typeID) || !Number.isInteger(level) || level < 0 || level > 5) throw graphError("NODEGRAPH_SKILL_REWARD_INVALID");
      const skills = require("../skills/skillState");
      if (Number(parameters.skill_points || 0) !== 0) throw graphError("NODEGRAPH_SKILL_COMPENSATION_UNSUPPORTED");
      const grants = new Map([[typeID, level]]);
      if (parameters.should_train_prerequisites !== false && parameters.should_train_prerequisites !== 0) {
        const visit = (id, stack = []) => {
          if (stack.includes(id) || stack.length >= 32) throw graphError("NODEGRAPH_SKILL_PREREQUISITE_CYCLE");
          for (const requirement of require("../fitting/liveFittingState").getRequiredSkillRequirements(id)) {
            grants.set(requirement.skillTypeID, Math.max(grants.get(requirement.skillTypeID) || 0, requirement.level));
            visit(requirement.skillTypeID, [...stack, id]);
          }
        };
        visit(typeID);
      }
      requireSuccess(skills.grantCharacterSkillLevelsOnce(characterID, [...grants].map(([typeID, level]) => ({ typeID, level })), idempotencyKey));
      return {};
    }
    case 365:
      return requireSuccess(require("../skills/skillState").grantFreeSkillPointsOnce(characterID, Number(parameters.skill_points), idempotencyKey));
    default: throw graphError("NODEGRAPH_ATOM_UNSUPPORTED", String(node.atomID));
  }
}

function executeGetter(instance, node, parameters, root) {
  checkCharacter(instance, parameters);
  const record = require("../character/characterState").getCharacterRecord(instance.characterID) || {};
  switch (node.atomID) {
    case 285: return { checkpoint_id: root.checkpoints[Number(parameters.node_graph_id || root.graphID)] ?? null };
    case 301: return { value: Number(parameters.value) || 0 };
    case 302: return { value: Math.trunc(Number(parameters.value) || 0) };
    case 303: return { value: String(parameters.value ?? "") };
    case 307: return { value: require("./nodeGraphCompiler").parseLiteralValue(parameters.value ?? null) };
    case 391: return { solar_system_id: record.stationID || record.structureID ? null : record.solarSystemID, solar_system_id_2: record.solarSystemID, station_id: record.stationID || null, structure_id: record.structureID || null, constellation_id: record.constellationID || null, regioin_id: record.regionID || null, location_id: Number(record.structureID || record.stationID || record.solarSystemID || 0), ship_id: require("../character/characterState").getActiveShipRecord(instance.characterID)?.itemID || null };
    case 406: return { home_station_id: Number(record.homeStationID || 0) };
    case 415: {
      const stationID = Number(record.birthStationID || record.schoolStationID || record.homeStationID || 0);
      const station = require("../_shared/stationStaticData").getStationRecord(null, stationID);
      return { birth_station_id: stationID, solar_system_id: station?.solarSystemID || null };
    }
    case 446: return { value: null };
    case 452: return { solar_system_id: require("../_shared/stationStaticData").getStationRecord(null, record.homeStationID)?.solarSystemID || null };
    default: throw graphError("NODEGRAPH_ATOM_UNSUPPORTED", String(node.atomID));
  }
}

module.exports = { ACTION_ATOMS, GETTER_ATOMS, CONDITION_ATOMS, EVENT_ATOMS, effectKey, checkCharacter, executeAction, executeGetter };
