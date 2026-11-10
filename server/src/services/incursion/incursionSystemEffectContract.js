"use strict";

// Reviewed input bindings from both clients. Application is explicitly authored:
// effect4728 has no modifierInfo and client StartSystemEffect is not implemented.
const VERSION = "evejs.incursion-system-effects.v1";
const RESONANCES = Object.freeze([267, 270, 269, 268, 271, 274, 273, 272]);
const DESCRIPTORS = Object.freeze([
  ["cyno", "Cyno", "Cyno", false], ["tax", "Tax", "Tax", false],
  ["tank", "ResistanceDecrease", "Tanking", true], ["damage", "DamageDecrease", "Damage", true],
].map(([name, texture, hint, isScalable]) => Object.freeze({ name: `effectIcon_${name}`,
  texturePath: `res:/UI/Texture/classes/InfluenceBar/effect${texture}.png`,
  hint: `UI/Incursion/HUD/SystemEffect${hint}Hint`, isScalable })));

function policy() {
  return { version: VERSION, authority: "recovered-inputs-with-explicit-emulator-application",
    effectID: 4728, scenes: {
      1: { typeID: 3494, resistancePercent: 50, damagePercent: -50 },
      2: { typeID: 3493, resistancePercent: 25, damagePercent: -25 },
      3: { typeID: 3069, resistancePercent: 10, damagePercent: -10 },
      // Staging has no recovered binding. Zero scalable penalty is policy,
      // never an invented fourth native effect type.
      4: { typeID: null, resistancePercent: 0, damagePercent: 0 },
    }, scaling: "linear-one-minus-native-player-control", resistanceOperation: "nonstacking-resonance-postpercent",
    tankScope: "player-ships", damageScope: "player-ships-and-owned-drones",
    weaponKinds: ["turret", "launcher", "drone", "smartbomb"],
    bountyMultiplier: 0.5, bountyOrder: "before-ess-and-corporation-tax",
    cyno: "block-new-noncovert-cycles-existing-fields-unchanged",
    evidence: { builds: [3396210, 3475087], localizationMessageIDs: [239122, 239123, 239124, 239134],
      reference: "doc/PHASE_8C_NATIVE_EFFECTS.md", privateAudit: "phase8c-effects-20261103/SUMMARY.json" },
  };
}
module.exports = { VERSION, RESONANCES, DESCRIPTORS, policy };
