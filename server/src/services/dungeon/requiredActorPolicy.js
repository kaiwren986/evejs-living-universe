"use strict";

// Exact arc declarations only. Existing saved population hints are passed by
// the site owner; a newer catalogue cannot silently choose another actor.
const PREPARING_ROLE = "required_actor_preparing";
const ACTIVE_ROLE = "required_actor";

function declarations(instance, template, populationHints) {
  const incursion = require("../incursion/incursionAdmission");
  const incursionPolicy = incursion.admittedPolicy(instance);
  if (incursionPolicy && incursion.isTemplate(template)) {
    const plans = populationHints?.encounters || instance.spawnState.populationHints.encounters, result = [], keys = new Set();
    if (incursionPolicy.version === 2) {
      const operation = require("../incursion/incursionRewardStore").getOperation(`incursion-v2:${instance.instanceID}`);
      if (operation && require("../incursion/incursionLifecycleContract").fingerprint(operation.identity) !==
          require("../incursion/incursionLifecycleContract").fingerprint(incursion.operationIdentity(instance))) throw new Error("INCURSION_REQUIRED_ACTORS_INVALID");
      const cohorts = operation ? require("../incursion/incursionReinforcements").cohorts(operation) : [];
      const friendly = require("../incursion/incursionFriendlyActors").cohorts(operation || { policy: incursionPolicy, stages: {} });
      for (const stage of [...incursionPolicy.stages, ...cohorts, ...friendly]) {
        const matches = plans.filter(plan => plan.key === stage.encounterKey), plan = matches[0];
        if (matches.length !== 1 || plan.roomKey !== stage.roomKey || plan.spawnEntries?.length !== stage.actors.length) {
          throw new Error("INCURSION_REQUIRED_ACTORS_INVALID");
        }
        for (const actor of stage.actors) {
          const entries = plan.spawnEntries.filter(entry => entry.key === actor.key), entry = entries[0];
          const blocks = !["optional", "friendly"].includes(actor.role), ownerID = actor.role === "friendly" ? actor.ownerID : 1000162;
          if (entries.length !== 1 || keys.has(actor.key) || entry.typeID !== actor.typeID || entry.ownerID !== ownerID ||
              entry.entityKind !== "npc" || entry.blocksEncounterProgress !== blocks) throw new Error("INCURSION_REQUIRED_ACTORS_INVALID");
          keys.add(actor.key);
          result.push({ key: actor.key, planKey: plan.key, typeID: entry.typeID, ownerID: entry.ownerID,
            roomKey: plan.roomKey, blocksEncounterProgress: blocks, recoverMembership: true, label: entry.label });
        }
      }
      return result;
    }
    for (const wave of incursionPolicy.waves) {
      const matches = plans.filter(plan => plan.key === wave.encounterKey), plan = matches[0];
      if (matches.length !== 1 || plan.roomKey !== incursionPolicy.roomKey ||
          plan.spawnEntries?.length !== wave.actors.length) throw new Error("INCURSION_REQUIRED_ACTORS_INVALID");
      for (const actor of wave.actors) {
        const entries = plan.spawnEntries.filter(entry => entry.key === actor.key), entry = entries[0];
        if (entries.length !== 1 || keys.has(actor.key) || entry.typeID !== actor.typeID ||
            entry.ownerID !== 1000162 || entry.entityKind !== "npc" || entry.blocksEncounterProgress !== true) {
          throw new Error("INCURSION_REQUIRED_ACTORS_INVALID");
        }
        keys.add(actor.key);
        result.push({ key: actor.key, planKey: plan.key, typeID: entry.typeID, ownerID: entry.ownerID,
          roomKey: plan.roomKey, blocksEncounterProgress: true, recoverMembership: true, label: entry.label });
      }
    }
    return result;
  }
  const ownerID = Number(instance?.ownership?.missionOwnerCharacterID);
  const contentID = Number(instance?.metadata?.missionContentID);
  if (!Number.isSafeInteger(ownerID) || ownerID <= 0 ||
      instance?.runtimeFlags?.missionRuntime !== true ||
      instance.templateID !== template?.templateID ||
      Number(instance.ownership?.characterID) !== ownerID) return [];
  const frozen = instance.spawnState?.populationHints;
  if (contentID === 17184 && Number(template.sourceDungeonID) === 14098 &&
      template.visionsOfGreatness?.epicArcID === 132 && template.visionsOfGreatness.missionID === 17184 &&
      template.requiresMechanics?.includes("visions-of-greatness-v1") && frozen?.visionsCaldariPolicy?.version === 1) {
    // Admission belongs to the accepted instance, not a later pack refresh.
    // A malformed opted-in cohort must fail rather than fall back to transient
    // actors whose disappearance could be mistaken for an earned outcome.
    const specs = [
      { key: "caldari-civilians", count: 5, types: [93937], room: "room:33217", blocks: false, entry: i => `caldari-civilians:${i}` },
      { key: "maulus-disruptors", count: 5, types: [93958], room: "room:33217", blocks: true, entry: i => `maulus-disruptors:${i}` },
      { key: "federation-screen", count: 10, types: [93944, 93947], room: "room:33253", blocks: true, entry: i => `federation-screen:${i}` },
      { key: "kairiola", count: 1, types: [95351], room: "room:33253", blocks: false, entry: i => `kairiola:${i}` },
      { key: "protected-civilians", count: 5, types: [93937], room: "room:33253", blocks: false, entry: i => `protected-civilian-${i}` },
    ];
    const plans = frozen.encounters || [], result = [], allKeys = plans.flatMap(plan => (plan.spawnEntries || []).map(entry => entry.key));
    for (const spec of specs) {
      const matches = plans.filter(plan => plan.key === spec.key), plan = matches[0];
      if (matches.length !== 1 || plan.roomKey !== spec.room || plan.spawnEntries?.length !== spec.count) {
        throw new Error("CALDARI_REQUIRED_ACTOR_DECLARATION_INVALID");
      }
      for (let ordinal = 1; ordinal <= spec.count; ordinal += 1) {
        const key = spec.entry(ordinal), entries = plan.spawnEntries.filter(entry => entry.key === key), entry = entries[0];
        if (entries.length !== 1 || allKeys.filter(value => value === key).length !== 1 ||
            !spec.types.includes(entry.typeID) || entry.ownerID !== 500001 || entry.entityKind !== "npc" ||
            entry.blocksEncounterProgress !== spec.blocks) throw new Error("CALDARI_REQUIRED_ACTOR_DECLARATION_INVALID");
        result.push({ key, planKey: spec.key, typeID: entry.typeID, ownerID: entry.ownerID,
          roomKey: plan.roomKey, blocksEncounterProgress: spec.blocks, recoverMembership: true,
          label: entry.label || plan.label || null });
      }
    }
    return result;
  }
  let expected;
  if (contentID === 17131 && Number(template.sourceDungeonID) === 13339 &&
      template.fracturedLegacy?.version === 1 && template.fracturedLegacy.epicArcID === 128 &&
      template.fracturedLegacy.missionID === 17131 && template.requiresMechanics?.includes("fractured-legacy-v1") &&
      template.fracturedLegacy.delivery?.containerTypeID === 90423) {
    expected = { key: "soe-odysseus:1", planKey: "soe-odysseus", typeID: 90423, ownerID: 1000130 };
  } else if (contentID === 17183 && Number(template.sourceDungeonID) === 14097 &&
      template.visionsOfGreatness?.epicArcID === 132 && template.visionsOfGreatness.missionID === 17183 &&
      template.requiresMechanics?.includes("visions-of-greatness-v1") &&
      template.visionsOfGreatness.repair?.actorKey === "nuras-revelation" &&
      template.visionsOfGreatness.repair.typeID === 93883) {
    expected = { key: "nuras-revelation", planKey: "nuras-revelation", typeID: 93883, ownerID: 500003 };
  } else return [];
  const rows = (populationHints?.encounters || []).flatMap(plan => (plan.spawnEntries || [])
    .map(entry => ({ plan, entry })));
  const matches = rows.filter(({ plan, entry }) => plan.key === expected.planKey &&
    plan.spawnEntries.length === 1 && entry.key === expected.key && entry.typeID === expected.typeID &&
    entry.ownerID === expected.ownerID && entry.entityKind === "npc" && entry.blocksEncounterProgress === false);
  if (matches.length !== 1 || rows.filter(({ entry }) => entry.key === expected.key).length !== 1) return [];
  return [{ ...expected, roomKey: matches[0].plan.roomKey, blocksEncounterProgress: false }];
}

function recordMatches(record, instance, siteID, declaration) {
  return Boolean(record && declaration && record.transient === false &&
    [PREPARING_ROLE, ACTIVE_ROLE].includes(record.dungeonSiteContentRole) &&
    record.dungeonMaterializedSiteContent === true &&
    Number(record.systemID) === Number(instance.solarSystemID) &&
    Number(record.dungeonSiteID) === Number(siteID) &&
    Number(record.dungeonSiteInstanceID) === Number(instance.instanceID) &&
    record.dungeonSiteContentKey === declaration.key &&
    record.dungeonEncounterKey === `instance:${instance.instanceID}:${declaration.planKey}` &&
    Number(record.typeID) === declaration.typeID && Number(record.ownerID) === declaration.ownerID);
}

function terminalRecord(instance, record) {
  const terminal = instance?.spawnState?.requiredActorRetirements?.[record?.dungeonSiteContentKey];
  return terminal && terminal.contentKey === record?.dungeonSiteContentKey &&
    Number(terminal.entityID) === Number(record?.entityID || record?.itemID) &&
    Number(terminal.typeID) === Number(record?.typeID) ? terminal : null;
}

module.exports = { PREPARING_ROLE, ACTIVE_ROLE, declarations, recordMatches, terminalRecord };
