"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  NPC_RUNTIME_CAPABILITY,
} = require(path.join(__dirname, "./npcSdeCapabilityResolver"));
const npcEquipment = require(path.join(__dirname, "./npcEquipment"));
const hostileModuleRuntime = require(path.join(
  __dirname,
  "../modules/hostileModuleRuntime",
));
const assistanceModuleRuntime = require(path.join(
  __dirname,
  "../modules/assistanceModuleRuntime",
));
const jammerModuleRuntime = require(path.join(
  __dirname,
  "../modules/jammerModuleRuntime",
));

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function buildAuditEntity(typeID) {
  const numericTypeID = toInt(typeID, 0);
  return {
    itemID: 2_000_000_000 + numericTypeID,
    typeID: numericTypeID,
    kind: "ship",
    nativeNpc: true,
    fittedItems: [],
  };
}

function buildRuntimeSnapshot(typeID) {
  const entity = buildAuditEntity(typeID);
  const weaponModules = npcEquipment.getNpcWeaponModules(entity);
  return {
    entity,
    weaponEffectNames: new Set(
      weaponModules
        .map((entry) => normalize(entry && entry.npcEffectName))
        .filter(Boolean),
    ),
    chainLightningEffectNames: new Set(
      weaponModules
        .filter((moduleItem) => {
          if (
            normalize(moduleItem && moduleItem.npcEffectName) !==
            "entitychainlightning"
          ) {
            return false;
          }
          const snapshot = npcEquipment.buildNpcWeaponModuleSnapshot(
            entity,
            moduleItem,
            { additionalLocationModifierSources: [] },
          );
          const rawDamage = snapshot && snapshot.rawShotDamage
            ? Object.values(snapshot.rawShotDamage).reduce(
              (total, value) => total + Math.max(0, Number(value) || 0),
              0,
            )
            : 0;
          return Boolean(
            snapshot &&
            snapshot.family === "vortonProjector" &&
            rawDamage > 0 &&
            Number(snapshot.arcRange) > 0 &&
            Number(snapshot.arcTargets) > 0
          );
        })
        .map((entry) => normalize(entry && entry.npcEffectName))
        .filter(Boolean),
    ),
    missileWeapon: npcEquipment.getNpcEntityMissileWeaponSource(entity),
    selfEffectNames: new Set(
      npcEquipment.getNpcSelfModules(entity)
        .map((entry) => normalize(entry && entry.effectName))
        .filter(Boolean),
    ),
    superweaponEffectNames: new Set(
      npcEquipment.getNpcSuperweaponModules(entity)
        .map((entry) => normalize(entry && entry.npcEffectName))
        .filter(Boolean),
    ),
  };
}

function effectRecordFromEvidence(evidence = {}) {
  return evidence.effectRecord && typeof evidence.effectRecord === "object"
    ? evidence.effectRecord
    : { name: String(evidence.effectName || "") };
}

function supportResult(supported, runtime, reason = "") {
  return {
    supported: supported === true,
    runtime,
    reason: supported === true ? "" : reason || "NO_RUNTIME_IMPLEMENTATION",
  };
}

const HOSTILE_CAPABILITY_BY_FAMILY = Object.freeze({
  stasisWebifier: NPC_RUNTIME_CAPABILITY.STASIS_WEBIFIER,
  targetPainter: NPC_RUNTIME_CAPABILITY.TARGET_PAINTER,
  warpScrambler: NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER,
  warpDisruptor: NPC_RUNTIME_CAPABILITY.WARP_DISRUPTOR,
  energyNeutralizer: NPC_RUNTIME_CAPABILITY.ENERGY_NEUTRALIZER,
  energyNosferatu: NPC_RUNTIME_CAPABILITY.ENERGY_NOSFERATU,
  sensorDampener: NPC_RUNTIME_CAPABILITY.SENSOR_DAMPENER,
  trackingDisruptor: NPC_RUNTIME_CAPABILITY.TRACKING_DISRUPTOR,
  guidanceDisruptor: NPC_RUNTIME_CAPABILITY.GUIDANCE_DISRUPTOR,
});

const ASSISTANCE_CAPABILITY_BY_FAMILY = Object.freeze({
  remoteArmor: NPC_RUNTIME_CAPABILITY.REMOTE_ARMOR_REPAIR,
  remoteShield: NPC_RUNTIME_CAPABILITY.REMOTE_SHIELD_REPAIR,
  remoteHull: NPC_RUNTIME_CAPABILITY.REMOTE_HULL_REPAIR,
  remoteCapacitor: NPC_RUNTIME_CAPABILITY.REMOTE_CAPACITOR_TRANSFER,
});

function directWeaponSupport(_capabilityID, evidence, context) {
  const effectName = normalize(evidence && evidence.effectName);
  if (effectName === "missilelaunchingforentity") {
    return supportResult(
      Boolean(context.runtimeSnapshot.missileWeapon),
      "npcEquipment.getNpcEntityMissileWeaponSource/npcBehaviorLoop",
      "NPC_MISSILE_SOURCE_UNRESOLVED",
    );
  }
  return supportResult(
    context.runtimeSnapshot.weaponEffectNames.has(effectName),
    "npcEquipment.getNpcWeaponModules/npcBehaviorLoop",
    "NPC_DIRECT_WEAPON_SOURCE_UNRESOLVED",
  );
}

function chainLightningSupport(_capabilityID, evidence, context) {
  return supportResult(
    context.runtimeSnapshot.chainLightningEffectNames.has(
      normalize(evidence && evidence.effectName),
    ),
    "npcEquipment.getNpcWeaponModules/npcBehaviorLoop/vortonProjectors",
    "NPC_CHAIN_LIGHTNING_SOURCE_UNRESOLVED",
  );
}

function localCycleSupport(_capabilityID, evidence, context) {
  const effectName = normalize(evidence && evidence.effectName);
  return supportResult(
    context.runtimeSnapshot.selfEffectNames.has(effectName) &&
      effectName !== "npcbehaviorsiege",
    "npcEquipment.getNpcSelfModules/localCycleRuntime",
    "NPC_LOCAL_CYCLE_EFFECT_UNRESOLVED",
  );
}

function hostileSupport(capabilityID, evidence) {
  const definition = hostileModuleRuntime.resolveHostileDefinition(
    effectRecordFromEvidence(evidence),
  );
  const actualCapability = definition &&
    HOSTILE_CAPABILITY_BY_FAMILY[String(definition.family || "")];
  return supportResult(
    actualCapability === capabilityID,
    "hostileModuleRuntime.resolveHostileDefinition/npcBehaviorLoop",
    "NPC_HOSTILE_EFFECT_UNRESOLVED",
  );
}

function jammerSupport(capabilityID, evidence) {
  const definition = jammerModuleRuntime.resolveJammerDefinition(
    effectRecordFromEvidence(evidence),
  );
  const actualCapability = definition && (
    definition.family === jammerModuleRuntime.ECM_BURST_FAMILY
      ? NPC_RUNTIME_CAPABILITY.ECM_BURST_JAMMER
      : definition.family === jammerModuleRuntime.ECM_FAMILY
        ? NPC_RUNTIME_CAPABILITY.ECM_JAMMER
        : ""
  );
  return supportResult(
    actualCapability === capabilityID,
    "jammerModuleRuntime.resolveJammerDefinition/npcBehaviorLoop",
    "NPC_JAMMER_EFFECT_UNRESOLVED",
  );
}

function assistanceSupport(capabilityID, evidence) {
  const definition = assistanceModuleRuntime.resolveAssistanceDefinition(
    effectRecordFromEvidence(evidence),
  );
  const actualCapability = definition &&
    ASSISTANCE_CAPABILITY_BY_FAMILY[String(definition.family || "")];
  return supportResult(
    actualCapability === capabilityID,
    "assistanceModuleRuntime.resolveAssistanceDefinition/npcBehaviorLoop",
    "NPC_ASSISTANCE_EFFECT_UNRESOLVED",
  );
}

function superweaponSupport(_capabilityID, evidence, context) {
  return supportResult(
    context.runtimeSnapshot.superweaponEffectNames.has(
      normalize(evidence && evidence.effectName),
    ),
    "npcEquipment.getNpcSuperweaponModules/superweaponRuntime",
    "NPC_SUPERWEAPON_EFFECT_UNRESOLVED",
  );
}

const NPC_RUNTIME_CAPABILITY_REGISTRY = Object.freeze({
  [NPC_RUNTIME_CAPABILITY.DIRECT_WEAPON]: Object.freeze({
    runtime: "npcEquipment.getNpcWeaponModules/npcBehaviorLoop",
    resolveEvidenceSupport: directWeaponSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.CHAIN_LIGHTNING]: Object.freeze({
    runtime: "npcEquipment.getNpcWeaponModules/npcBehaviorLoop/vortonProjectors",
    resolveEvidenceSupport: chainLightningSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.LOCAL_ARMOR_REPAIR]: Object.freeze({
    runtime: "npcEquipment.getNpcSelfModules/localCycleRuntime",
    resolveEvidenceSupport: localCycleSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.LOCAL_SHIELD_BOOST]: Object.freeze({
    runtime: "npcEquipment.getNpcSelfModules/localCycleRuntime",
    resolveEvidenceSupport: localCycleSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.REMOTE_ARMOR_REPAIR]: Object.freeze({
    runtime: "assistanceModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: assistanceSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.REMOTE_SHIELD_REPAIR]: Object.freeze({
    runtime: "assistanceModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: assistanceSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.REMOTE_HULL_REPAIR]: Object.freeze({
    runtime: "assistanceModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: assistanceSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.REMOTE_CAPACITOR_TRANSFER]: Object.freeze({
    runtime: "assistanceModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: assistanceSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.REMOTE_SENSOR_BOOST]: Object.freeze({
    supported: false,
    runtime: "assistanceModuleRuntime",
    reason: "NPC_CONTROLLER_TARGET_SELECTION_UNSUPPORTED",
  }),
  [NPC_RUNTIME_CAPABILITY.REMOTE_TRACKING]: Object.freeze({
    supported: false,
    runtime: "assistanceModuleRuntime",
    reason: "NPC_CONTROLLER_TARGET_SELECTION_UNSUPPORTED",
  }),
  [NPC_RUNTIME_CAPABILITY.STASIS_WEBIFIER]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.ENERGY_NEUTRALIZER]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.ENERGY_NOSFERATU]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.WARP_SCRAMBLER]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.WARP_DISRUPTOR]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.TARGET_PAINTER]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.SENSOR_DAMPENER]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.TRACKING_DISRUPTOR]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.GUIDANCE_DISRUPTOR]: Object.freeze({
    runtime: "hostileModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: hostileSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.ECM_JAMMER]: Object.freeze({
    runtime: "jammerModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: jammerSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.ECM_BURST_JAMMER]: Object.freeze({
    runtime: "jammerModuleRuntime/npcBehaviorLoop",
    resolveEvidenceSupport: jammerSupport,
  }),
  [NPC_RUNTIME_CAPABILITY.SUPERWEAPON]: Object.freeze({
    runtime: "npcEquipment.getNpcSuperweaponModules/superweaponRuntime",
    resolveEvidenceSupport: superweaponSupport,
  }),
});

function resolveNpcRuntimeCapabilitySupport(
  capabilityID,
  evidence,
  options = {},
) {
  const registry = options.registry || NPC_RUNTIME_CAPABILITY_REGISTRY;
  const entry = registry[String(capabilityID || "")] || null;
  if (!entry) {
    return supportResult(false, "", "NO_RUNTIME_CAPABILITY_REGISTRATION");
  }
  if (entry.supported === false) {
    return supportResult(false, String(entry.runtime || ""), entry.reason);
  }
  if (typeof entry.resolveEvidenceSupport !== "function") {
    return supportResult(
      entry.supported === true,
      String(entry.runtime || ""),
      entry.reason || "NO_RUNTIME_EVIDENCE_RESOLVER",
    );
  }
  const context = {
    typeID: toInt(options.typeID, 0),
    runtimeSnapshot: options.runtimeSnapshot || buildRuntimeSnapshot(options.typeID),
  };
  return entry.resolveEvidenceSupport(capabilityID, evidence, context);
}

module.exports = {
  NPC_RUNTIME_CAPABILITY_REGISTRY,
  buildAuditEntity,
  buildRuntimeSnapshot,
  resolveNpcRuntimeCapabilitySupport,
};
