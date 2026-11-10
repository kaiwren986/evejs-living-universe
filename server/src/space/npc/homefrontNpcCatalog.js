"use strict";

// This stationary, hack-activated ally is absent from the generated hostile
// pools. Its actual entity type supplies the weapon and spool-up dogma.
const rows = {
  npcProfiles: [
    {
      profileID: "homefront_malfunctioning_werpost",
      name: "Malfunctioning Werpost",
      entityType: "npc",
      shipTypeID: 83590,
      presentationTypeID: 83590,
      corporationID: 0,
      allianceID: 0,
      factionID: 500026,
      behaviorProfileID: "homefront_werpost",
      loadoutID: "retail_empty_npc_entity_loadout",
      hardwareFamily: "sdeEntityNpc",
      lootTableID: "parity_homefront_operations_pending_loot",
      shipNameTemplate: "Malfunctioning Werpost",
      securityStatus: 0,
      bounty: 0,
      spawnDistanceMeters: 0,
    },
  ],
  npcBehaviorProfiles: [
    {
      behaviorProfileID: "homefront_werpost",
      name: "Hacked Homefront Werpost",
      thinkIntervalMs: 1000,
      autoAggro: true,
      autoAggroTargetClasses: ["npc"],
      autoActivateWeapons: true,
      movementMode: "hold",
      aggressionRangeMeters: 250000,
      leashRangeMeters: 250000,
      returnToHomeWhenIdle: false,
      allowTargetSwitching: true,
    },
  ],
};
function getHomefrontNpcGeneratedRows(table) {
  return rows[table] || null;
}
module.exports = { getHomefrontNpcGeneratedRows };
