"use strict";

const {
  CONCORD_FACTION_ID,
  EVERMORE_CUSTOMS_CORPORATION_ID,
  EVERMORE_CUSTOMS_SPAWN_GROUP_ID,
  EVERMORE_FACTION_ID,
  getEverMoreGateCustomsLayout,
} = require("./everMoreGatePresence");

// Static reference only: decoded TQ AddBalls2 captures, checked against the
// installed 3396210 gate, corporation, item-type and dogma authorities. See
// doc/customs-operator-authority.md. Captured runtime entity IDs are excluded.
const CPF_CORPORATION_ID = 1000043;
const CPF_FACTION_ID = 500001;
const CPF_SPAWN_GROUP_ID = "customs_operator_corporate_police_force";
const CPF_STARTUP_RULE_PREFIX = "default_customs_operator_";
const CPF_COMMISSIONER_PROFILE_ID = "customs_operator_cpf_commissioner";
const CPF_AGENT_PROFILE_ID = "customs_operator_cpf_agent";
const CPF_CUSTOMS_LOADOUT_ID = "customs_operator_native_entity";
const CPF_LAYOUT_SOURCE = Object.freeze({
  provider: "decoded TQ customs AddBalls2 capture",
  captureSha256: "bf76df191bd1f907234271899fbd45aa995115f917016c388d55f5e53ae86e0e",
  decoderSha256: "2b1e275a059dac44c6d85a3b9ea09c6b1d368679dc6469cec620295349aa7bfe",
  schemaVersion: 1,
});

function slot(typeID, x, y, z, orbitTarget) {
  const commissioner = typeID === 19367;
  return Object.freeze({
    profileID: commissioner ? CPF_COMMISSIONER_PROFILE_ID : CPF_AGENT_PROFILE_ID,
    typeID,
    offset: Object.freeze({ x, y, z }),
    orbitTarget,
    orbitDistanceMeters: 6000,
    maxVelocity: commissioner ? 1500 : 5000,
    speedFraction: commissioner ? 0.13333334028720856 : 0.10000000149011612,
  });
}

const CPF_LAYOUTS = Object.freeze([
  Object.freeze({
    layoutKey: "maurasi-50000802-corporate-police-force",
    solarSystemID: 30000140,
    gateID: 50000802,
    corporationID: CPF_CORPORATION_ID,
    factionID: CPF_FACTION_ID,
    lawFactionID: CPF_FACTION_ID,
    spawnGroupID: CPF_SPAWN_GROUP_ID,
    evidenceSourceLine: 46419,
    slots: Object.freeze([
      slot(19367, 571.832, 7428.128, -7440.545, "anchor"),
      slot(19385, 5458.06, 6664.449, -2373.181, 0),
      slot(19385, -623.443, 4663.33, -1913.035, 1),
      slot(19367, 9206.124, 3667.191, -480.706, 2),
    ]),
  }),
  Object.freeze({
    layoutKey: "muvolailen-50016472-corporate-police-force",
    solarSystemID: 30002780,
    gateID: 50016472,
    corporationID: CPF_CORPORATION_ID,
    factionID: CPF_FACTION_ID,
    lawFactionID: CPF_FACTION_ID,
    spawnGroupID: CPF_SPAWN_GROUP_ID,
    evidenceSourceLine: 80059,
    slots: Object.freeze([
      slot(19385, -5044.526, 1547.734, -13198.19, "anchor"),
      slot(19385, 6819.011, 5951.649, -9794.552, 0),
      slot(19367, 2707.817, -5083.607, 433.958, 1),
      slot(19367, -6868.424, 846.511, -525.839, 2),
    ]),
  }),
]);

function getCustomsOperatorLayout(systemID, gateID) {
  const captured = CPF_LAYOUTS.find((layout) => (
    layout.solarSystemID === Number(systemID) && layout.gateID === Number(gateID)
  ));
  if (captured) {
    return captured;
  }
  const slots = getEverMoreGateCustomsLayout(systemID, gateID);
  return slots.length > 0
    ? Object.freeze({
        layoutKey: `jita-${Number(gateID)}-evermore`,
        solarSystemID: Number(systemID),
        gateID: Number(gateID),
        corporationID: EVERMORE_CUSTOMS_CORPORATION_ID,
        factionID: EVERMORE_FACTION_ID,
        // Jita's installed world authority is CONCORD. EverMore is the
        // existing delegated gate operator, not a substitute law faction.
        lawFactionID: CONCORD_FACTION_ID,
        spawnGroupID: EVERMORE_CUSTOMS_SPAWN_GROUP_ID,
        slots,
      })
    : null;
}

function getCustomsGateSlots(systemID, gateID) {
  const layout = getCustomsOperatorLayout(systemID, gateID);
  return layout ? layout.slots.map((entry) => ({ ...entry, offset: { ...entry.offset } })) : [];
}

module.exports = {
  CPF_AGENT_PROFILE_ID,
  CPF_COMMISSIONER_PROFILE_ID,
  CPF_CORPORATION_ID,
  CPF_CUSTOMS_LOADOUT_ID,
  CPF_FACTION_ID,
  CPF_LAYOUTS,
  CPF_LAYOUT_SOURCE,
  CPF_SPAWN_GROUP_ID,
  CPF_STARTUP_RULE_PREFIX,
  getCustomsGateSlots,
  getCustomsOperatorLayout,
};
