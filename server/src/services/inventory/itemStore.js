"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");
const NodeModule = require("node:module");
const { normalizeOwnerTransferLootInfo, replaceOwnerTransferLootInfo } = require("./lootOwnerTransferMetadata");
const { isDeepStrictEqual } = require("util");
const { performance } = require("perf_hooks");
const { StarbaseItemIndex } = require("../starbase/starbaseItemIndex");

// Phase 0 / 0.C: itemStore owns the items table (sole writer); access flows
// through a strict ownership-scoped repository. It also reads characters and
// other tables — reads pass through unrestricted.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:inventory", { strict: true });
const database = require(path.join(__dirname, "../../gameStore"));
const persistenceRoles = require(path.join(
  __dirname,
  "../../gameStore/persistenceRoles",
));
const log = require(path.join(__dirname, "../../utils/logger"));
// Zero-dependency leaf — safe to require here without a cycle. Moved by a
// commit that changes what a fitting is made of (noteDogmaAffectingRowChanges).
const {
  bumpDogmaInvalidationVersion,
} = require(path.join(__dirname, "../character/dogmaInvalidationVersion"));
const { noteCommittedItemChanges: noteGmDogmaItemChanges } = require("../dogma/gmDogmaOverrides");
const worldData = require(path.join(__dirname, "../../space/worldData"));
const { resolveItemByTypeID } = require(path.join(
  __dirname,
  "./itemTypeRegistry",
));
const { resolveShipByTypeID } = require(path.join(
  __dirname,
  "../chat/shipTypeRegistry",
));
const {
  resolveRuntimeWreckRadius,
} = require(path.join(__dirname, "./wreckRadius"));
const {
  normalizeStoredRackHeat,
} = require(path.join(__dirname, "./shipRackHeatState"));
const {
  reserveItemIDs,
} = require(path.join(__dirname, "../_shared/identityAllocator"));
const {
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "../../space/destiny/identity/entityID"));
const {
  convertLegacySavedWarp,
  normalizeSavedWarpLanding,
} = require(path.join(__dirname, "../../space/runtime/savedWarpLanding"));
const {
  FUEL_BAY_FLAG,
  STRUCTURE_FUEL_BAY_FLAG,
} = require(path.join(__dirname, "./fuelBayInventory"));

// Fitting flag ranges (hi/med/lo slots, rigs, subsystems, service slots).
// Duplicated from liveFittingState to avoid circular dependency.
const FITTING_FLAG_RANGES = Object.freeze([
  [11, 34],
  [92, 99],
  [125, 132],
  [164, 171],
]);

function isFittingFlag(flagID) {
  const f = Number(flagID) || 0;
  return FITTING_FLAG_RANGES.some(([lo, hi]) => f >= lo && f <= hi);
}

const CHARACTERS_TABLE = "characters";
const ITEMS_TABLE = "items";

// Whether this process's gameStore role is allowed to write `items` at all.
// The durable owner is `world`; an unlabelled import (reporting tools, parity
// scripts, the read-only edge workers) gets `reader`, which the store refuses
// to let write. The role is fixed for the life of the process, so resolve it
// once here — the same shape walletAuthorityOwnerState uses for its table.
const OWNS_ITEMS_TABLE = persistenceRoles.roleMayMutateTable(
  database._processRole,
  ITEMS_TABLE,
);
const IDEMPOTENT_GRANT_RECEIPTS_KEY = "__evejsInventoryGrantReceipts";
const ITEM_ROW_PLAN_LEDGER = Symbol("itemRowPlanLedger");
const CAREER_COMBAT_OUTCOMES_KEY = "__evejsCareerCombatOutcomes";
const INCURSION_COMBAT_OUTCOMES_KEY = "__evejsIncursionCombatOutcomes";
const TRASH_MANY_OPERATION = "trash-inventory-items-many";
const TRASH_MANY_RECEIPT_SCHEMA_VERSION = 1;
const SHIP_CATEGORY_ID = 6;
const MODULE_CATEGORY_ID = 7;
const BLUEPRINT_CATEGORY_ID = 9;
const SUBSYSTEM_CATEGORY_ID = 32;
const STRUCTURE_MODULE_CATEGORY_ID = 66;
const DEFAULT_SHIP_TYPE_ID = 606;
const CAPSULE_TYPE_ID = 670;
const CAPSULE_TYPE_ID_GOLDEN = 33328;
const GOLDEN_CAPSULE_IMPLANT_TYPE_ID = 33329;
const ITEM_FLAGS = {
  HANGAR: 4,
  CARGO_HOLD: 5,
  CORP_DELIVERIES: 62,
  LOCKED: 63,
  UNLOCKED: 64,
  FUEL_BAY: FUEL_BAY_FLAG,
  DRONE_BAY: 87,
  SHIP_HANGAR: 90,
  SPECIALIZED_FUEL_BAY: FUEL_BAY_FLAG,
  FIGHTER_BAY: 158,
  FIGHTER_TUBE_0: 159,
  FIGHTER_TUBE_1: 160,
  FIGHTER_TUBE_2: 161,
  FIGHTER_TUBE_3: 162,
  FIGHTER_TUBE_4: 163,
  STRUCTURE_DEED: 180,
  STRUCTURE_FUEL_BAY: STRUCTURE_FUEL_BAY_FLAG,
  DELIVERIES: 173,
  CORPSE_BAY: 174,
  BOOSTER_BAY: 176,
  SUBSYSTEM_BAY: 177,
  FRIGATE_ESCAPE_BAY: 179,
  GENERAL_MINING_HOLD: 134,
  SPECIALIZED_MINERAL_HOLD: 136,
  SPECIALIZED_SALVAGE_HOLD: 137,
  SPECIALIZED_SHIP_HOLD: 138,
  SPECIALIZED_SMALL_SHIP_HOLD: 139,
  SPECIALIZED_MEDIUM_SHIP_HOLD: 140,
  SPECIALIZED_LARGE_SHIP_HOLD: 141,
  SPECIALIZED_INDUSTRIAL_SHIP_HOLD: 142,
  SPECIALIZED_AMMO_HOLD: 143,
  SPECIALIZED_COMMAND_CENTER_HOLD: 148,
  SPECIALIZED_PLANETARY_COMMODITIES_HOLD: 149,
  SPECIALIZED_MATERIAL_BAY: 151,
  QUAFE_BAY: 154,
  FLEET_HANGAR: 155,
  HIDDEN_MODIFIERS: 156,
  SPECIALIZED_GAS_HOLD: 135,
  SPECIALIZED_ICE_HOLD: 181,
  SPECIALIZED_ASTEROID_HOLD: 182,
  MOBILE_DEPOT_HOLD: 183,
  COLONY_RESOURCES_HOLD: 185,
  INFRASTRUCTURE_HOLD: 185,
  CAPSULEER_DELIVERIES: 187,
  EXPEDITION_HOLD: 188,
};
const STRUCTURE_DEED_GROUP_ID = 4086;
const CARGO_CONTAINER_GROUP_IDS = new Set([12, 340, 448, 649]);
const ITEM_MOVE_ERROR = Object.freeze({
  CYCLE: "ITEM_MOVE_WOULD_CREATE_CYCLE",
  CONTAINER_NESTING: "CARGO_CONTAINER_NESTING_NOT_ALLOWED",
  CONTAINER_NOT_ASSEMBLED: "CARGO_CONTAINER_NOT_ASSEMBLED",
});
const FIGHTER_TUBE_FLAGS = Object.freeze([
  ITEM_FLAGS.FIGHTER_TUBE_0,
  ITEM_FLAGS.FIGHTER_TUBE_1,
  ITEM_FLAGS.FIGHTER_TUBE_2,
  ITEM_FLAGS.FIGHTER_TUBE_3,
  ITEM_FLAGS.FIGHTER_TUBE_4,
]);
const JUNK_LOCATION_ID = 6;
const DEFAULT_SHIP_CONDITION_STATE = Object.freeze({
  damage: 0.0,
  charge: 1.0,
  armorDamage: 0.0,
  shieldCharge: 1.0,
  incapacitated: false,
});
const DEFAULT_MODULE_STATE = Object.freeze({
  online: false,
  damage: 0.0,
  charge: 0.0,
  skillPoints: 0,
  armorDamage: 0.0,
  shieldCharge: 0.0,
  incapacitated: false,
});
const CLIENT_INVENTORY_STACK_LIMIT = 2147483647;
const ITEM_ID_RESERVE_BATCH_SIZE = 128;
const PACKAGED_VOLUME_OVERRIDES_BY_GROUP_ID = Object.freeze({
  // Mirrored from packaged client inventorycommon.const.packagedVolumeOverridesPerGroup.
  25: 2500.0,
  26: 10000.0,
  27: 50000.0,
  28: 20000.0,
  29: 500.0,
  30: 10000000.0,
  31: 500.0,
  324: 2500.0,
  358: 10000.0,
  380: 20000.0,
  381: 50000.0,
  419: 15000.0,
  420: 5000.0,
  463: 3750.0,
  485: 1300000.0,
  513: 1300000.0,
  540: 15000.0,
  541: 5000.0,
  543: 3750.0,
  547: 1300000.0,
  659: 1300000.0,
  830: 2500.0,
  831: 2500.0,
  832: 10000.0,
  833: 10000.0,
  834: 2500.0,
  883: 1300000.0,
  893: 2500.0,
  894: 10000.0,
  898: 50000.0,
  900: 50000.0,
  902: 1300000.0,
  906: 10000.0,
  941: 500000.0,
  963: 5000.0,
  1022: 500.0,
  1201: 15000.0,
  1202: 20000.0,
  1283: 2500.0,
  1305: 5000.0,
  1527: 2500.0,
  1534: 5000.0,
  1538: 1300000.0,
  1972: 10000.0,
  4594: 1300000.0,
  4902: 50000.0,
  5087: 10000.0,
  5120: 1300000.0,
});
const PACKAGED_VOLUME_OVERRIDES_BY_TYPE_ID = Object.freeze({
  // Mirrored from packaged client inventorycommon.const.packagedVolumeOverridesPerType.
  3293: 33,
  3296: 65,
  3297: 10,
  3465: 65,
  3466: 33,
  3467: 10,
  11019: 100,
  11488: 150,
  11489: 300,
  17363: 10,
  17364: 33,
  17365: 65,
  17366: 10000,
  24445: 1200,
  33003: 2500,
  33005: 500,
  33007: 100,
  33009: 50,
  33011: 10,
  42244: 50000,
  // Capital module type overrides from the pinned client (build 3396210).
  37289: 1000, // typeQuad800mmRepeatingCannonI
  37304: 1000, // typeQuad800mmRepeatingCannonII
  37305: 1000, // typeCompactCarbineQuad800mmRepeatingCannon
  37306: 1000, // typeHexa2500mmRepeatingCannonII
  37307: 1000, // typeQuad3500mmSiegeArtilleryII
  41080: 1000, // typeAmpleGalliumQuad800mmRepeatingCannon
  41081: 1000, // typeScoutScopedQuad800mmRepeatingCannon
  41082: 1000, // typePrototypePreciseQuad800mmRepeatingCannon
  41083: 1000, // typeDominationQuad800mmRepeatingCannon
  41150: 1000, // typeCarbineCompactHexa2500mmRepeatingCannon
  41151: 1000, // typeGalliumAmpleHexa2500mmRepeatingCannon
  41152: 1000, // typeScoutScopedHexa2500mmRepeatingCannon
  41153: 1000, // typePrototypePreciseHexa2500mmRepeatingCannon
  41154: 1000, // typeDominationHexa2500mmRepeatingCannon
  41156: 1000, // typeCarbideCompactQuad3500mmSiegeArtillery
  41157: 1000, // typeGalliumAmpleQuad3500mmSiegeArtillery
  41158: 1000, // typeScoutScopedQuad3500mmSiegeArtillery
  41159: 1000, // typePrototypePreciseQuad3500mmSiegeArtillery
  41160: 1000, // typeDominationQuad3500mmSiegeArtillery
  20452: 1000, // typeHexa2500mmRepeatingCannonI
  20454: 1000, // typeQuad3500mmSiegeArtilleryI
  3571: 1000, // typeCONCORDQuad3500mmSiegeArtillery
  3573: 1000, // typeCONCORDHexa2500mmRepeatingCannon
  37291: 1000, // typeTripleNeutronBlasterCannonI
  37300: 1000, // typeTripleNeutronBlasterCannonII
  37301: 1000, // typeRegulatedCompactTripleNeutronBlasterCannon
  37302: 1000, // typeIonSiegeBlasterII
  37303: 1000, // typeDual1000mmRailgunII
  41076: 1000, // typeModalEnduringTripleNeutronBlasterCannon
  41077: 1000, // typeAnodeScopedTripleNeutronBlasterCannon
  41078: 1000, // typeLimitedPreciseTripleNeutronBlasterCannon
  41079: 1000, // typeShadowSerpentisTripleNeutronBlasterCannon
  41126: 1000, // typeRegulatedCompactIonSiegeBlaster
  41127: 1000, // typeModalEnduringIonSiegeBlaster
  41128: 1000, // typeAnodeScopedIonSiegeBlaster
  41129: 1000, // typeLimitedPreciseIonSiegeBlaster
  41130: 1000, // typeShadowSerpentisIonSiegeBlaster
  41138: 1000, // typeCarbideCompactDual1000mmRailgun
  41139: 1000, // typeCompressedEnduringDual1000mmRailgun
  41140: 1000, // typeScoutScopedDual1000mmRailgun
  41141: 1000, // typePrototypePreciseDual1000mmRailgun
  41142: 1000, // typeShadowSerpentisDual1000mmRailgun
  20448: 1000, // typeDual1000mmRailgunI
  20450: 1000, // typeIonSiegeBlasterI
  3546: 1000, // typeCONCORDIonSiegeBlaster
  3550: 1000, // typeCONCORDDual1000mmRailgun
  37290: 1000, // typeQuadMegaPulseLaserI
  37296: 1000, // typeQuadMegaPulseLaserII
  37297: 1000, // typeModulatedCompactQuadMegaPulseLaser
  37298: 1000, // typeDualGigaPulseLaserII
  37299: 1000, // typeDualGigaBeamLaserII
  41063: 1000, // typeModalEnduringQuadMegaPulseLaser
  41064: 1000, // typeAnodeScopedQuadMegaPulseLaser
  41065: 1000, // typeAfocalPreciseQuadMegaPulseLaser
  41066: 1000, // typeDarkBloodQuadMegaPulseLaser
  41067: 1000, // typeTrueSanshaQuadMegaPulseLaser
  41099: 1000, // typeModulatedCompactDualGigaPulseLaser
  41100: 1000, // typeModalEnduringDualGigaPulseLaser
  41101: 1000, // typeAnodeScopedDualGigaPulseLaser
  41102: 1000, // typeAfocalPreciseDualGigaPulseLaser
  41103: 1000, // typeDarkBloodDualGigaPulseLaser
  41104: 1000, // typeTrueSanshaDualGigaPulseLaser
  41114: 1000, // typeModulatedCompactDualGigaBeamLaser
  41115: 1000, // typeModalEnduringDualGigaBeamLaser
  41116: 1000, // typeAnodeScopedDualGigaBeamLaser
  41117: 1000, // typeAfocalPreciseDualGigaBeamLaser
  41118: 1000, // typeDarkBloodDualGigaBeamLaser
  41119: 1000, // typeTrueSanshaDualGigaBeamLaser
  20444: 1000, // typeDualGigaPulseLaserI
  20446: 1000, // typeDualGigaBeamLaserI
  3559: 1000, // typeCONCORDDualGigaPulseLaser
  3561: 1000, // typeCONCORDDualGigaBeamLaser
  37288: 1000, // typeRapidTorpedoLauncherI
  41224: 1000, // typeTE2100AmpleRapidTorpedoLauncher
  37292: 1000, // typeRapidTorpedoLauncherII
  37293: 1000, // typeDreadGuristasRapidTorpedoLauncher
  41223: 1000, // typeArbalestCompactRapidTorpedoLauncher
  3565: 1000, // typeCONCORDXLTorpedoLauncher
  37294: 1000, // typeXLTorpedoLauncherII
  20539: 1000, // typeXLTorpedoLauncherI
  41180: 1000, // typeArbalestCompactXLTorpedoLauncher
  41181: 1000, // typeTE2100AmpleXLTorpedoLauncher
  41182: 1000, // typeDreadGuristasXLTorpedoLauncher
  3563: 1000, // typeCONCORDXLCruiseMissileLauncher
  37295: 1000, // typeXLCruiseMissileLauncherII
  41174: 1000, // typeDreadGuristasXLCruiseMissileLauncher
  41175: 1000, // typeArbalestCompactXLCruiseMissileLauncher
  41176: 1000, // typeTE2100AmpleXLCruiseMissileLauncher
  32444: 1000, // typeXLCruiseMissileLauncherI
  41236: 1000, // type10000MNAfterburnerI
  41237: 1000, // type10000MNYS8CompactAfterburner
  41238: 1000, // type10000MNMonopropellantEnduringAfterburner
  41239: 1000, // type10000MNAfterburnerII
  41240: 1000, // typeDomination10000MNAfterburner
  41241: 1000, // typeShadowSerpentis10000MNAfterburner
  41249: 1000, // type50000MNMicrowarpdriveI
  41250: 1000, // type50000MNYT8CompactMicrowarpdrive
  41251: 1000, // type50000MNQuadLiFRestrainedMicrowarpdrive
  41252: 1000, // type50000MNColdGasEnduringMicrowarpdrive
  41253: 1000, // type50000MNMicrowarpdriveII
  41254: 1000, // typeDomination50000MNMicrowarpdrive
  41255: 1000, // typeShadowSerpentis50000MNMicrowarpdrive
  40659: 1000, // typeCapitalEnergyNeutralizerI
  40660: 1000, // typeCapitalGremlinCompactEnergyNeutralizer
  40661: 1000, // typeCapitalInfectiousScopedEnergyNeutralizer
  40662: 1000, // typeCapitalEnergyNeutralizerII
  40663: 1000, // typeTrueSanshaCapitalEnergyNeutralizer
  40664: 1000, // typeDarkBloodCapitalEnergyNeutralizer
  40665: 1000, // typeCapitalEnergyNosferatuI
  40666: 1000, // typeCapitalGhoulCompactEnergyNosferatu
  40667: 1000, // typeCapitalKnaveScopedEnergyNosferatu
  40668: 1000, // typeCapitalEnergyNosferatuII
  40669: 1000, // typeTrueSanshaCapitalEnergyNosferatu
  40670: 1000, // typeDarkBloodCapitalEnergyNosferatu
  41483: 1000, // typeCapitalAncillaryRemoteShieldBooster
  41479: 1000, // typeCapitalAncillaryRemoteArmorRepairer
  41503: 1000, // typeCapitalAncillaryArmorRepairer
  41504: 1000, // typeCapitalAnciliaryShieldBooster
  41411: 1000, // typeNetworkedSensorArray
  90475: 1000, // typeIntegratedSensorArray
  4292: 1000, // typeSiegeModuleII
  4294: 1000, // typeTriageModuleII
  28583: 1000, // typeIndustrialCoreI
  42890: 1000, // typeIndustrialCoreII
  27951: 1000, // typeTriageModuleI
  20280: 1000, // typeSiegeModuleI
  41498: 1000, // typeCapitalIaEnduringArmorRepairer
  41499: 1000, // typeCapitalACMCompactArmorRepairer
  41500: 1000, // typeCapitalArmorRepairerII
  41501: 1000, // typeDarkBloodCapitalArmorRepairer
  41502: 1000, // typeShadowSerpentisCapitalArmorRepairer
  20701: 1000, // typeCapitalArmorRepairerI
  3534: 1000, // typeCONCORDCapitalArmorRepairer
  41505: 1000, // typeCapitalC5LCompactShieldBooster
  41506: 1000, // typeCapitalClarityWardEnduringShieldBooster
  41507: 1000, // typeCapitalShieldBoosterII
  41508: 1000, // typeTrueSanshaCapitalShieldBooster
  41509: 1000, // typeDreadGuristasCapitalShieldBooster
  41510: 1000, // typeDominationCapitalShieldBooster
  20703: 1000, // typeCapitalShieldBoosterI
  3542: 1000, // typeCONCORDCapitalShieldBooster
  41472: 1000, // typeTrueSanshaCapitalRemoteShieldBooster
  41474: 1000, // typeDominationCapitalRemoteShieldBooster
  3616: 1000, // typeCapitalRemoteShieldBoosterI
  3618: 1000, // typeCapitalRemoteShieldBoosterII
  41473: 1000, // typeDreadGuristasCapitalRemoteShieldBooster
  3544: 1000, // typeCONCORDCapitalRemoteShieldBooster
  41469: 1000, // typeCapitalAsymmetricEnduringRemoteShieldBooster
  41470: 1000, // typeCapitalMurkyCompactRemoteShieldBooster
  41471: 1000, // typeCapitalS95aScopedRemoteShieldBooster
  3536: 1000, // typeCONCORDCapitalRemoteArmorRepairer
  41464: 1000, // typeCapitalCoaxialCompactRemoteArmorRepairer
  41465: 1000, // typeCapitalSolaceScopedRemoteArmorRepairer
  41463: 1000, // typeCapitalIaxEnduringRemoteArmorRepairer
  24569: 1000, // typeCapitalRemoteArmorRepairerI
  41466: 1000, // typeCapitalRemoteArmorRepairerII
  41467: 1000, // typeDarkBloodCapitalRemoteArmorRepairer
  41468: 1000, // typeShadowSerpentisCapitalRemoteArmorRepairer
  40354: 1000, // typeCapitalShieldExtenderI
  40356: 1000, // typeCapitalFS9RegolithCompactShieldExtender
  40355: 1000, // typeCapitalAzeotropicRestrainedShieldExtender
  40357: 1000, // typeCapitalShieldExtenderII
  41459: 1000, // typeCONCORDCapitalShieldExtender
  41460: 1000, // typeTrueSanshaCapitalShieldExtender
  41461: 1000, // typeDreadGuristasCapitalShieldExtender
  41462: 1000, // typeDominationCapitalShieldExtender
  40348: 1000, // type25000mmSteelPlatesI
  40350: 1000, // type25000mmRolledTungstenCompactPlates
  40349: 1000, // type25000mmCrystallineCarbonideRestrainedPlates
  40351: 1000, // type25000mmSteelPlatesII
  41456: 1000, // typeCONCORD25000mmSteelPlates
  41457: 1000, // typeDarkBlood25000mmSteelPlates
  41458: 1000, // typeShadowSerpentis25000mmSteelPlates
  41511: 1000, // typeCapitalHullRepairerI
  41512: 1000, // typeCapitalIbEnduringHullRepairer
  41513: 1000, // typeCapitalIEFCompactHullRepairer
  41514: 1000, // typeCapitalHullRepairerII
  27934: 1000, // typeCapitalRemoteHullRepairerI
  41475: 1000, // typeCapitalRemoteHullRepairerII
  41484: 1000, // typeCapitalCapBatteryI
  41485: 1000, // typeCapitalCompactPbAcidCapBattery
  41486: 1000, // typeCapitalCapBatteryII
  41487: 1000, // typeDominationCapitalCapBattery
  41488: 1000, // typeDarkBloodCapitalCapBattery
  41491: 1000, // typeCapitalCapacitorBoosterI
  41492: 1000, // typeCapitalFRXCompactCapacitorBooster
  41493: 1000, // typeCapitalCapacitorBoosterII
  41494: 1000, // typeDarkBloodCapitalCapacitorBooster
  41495: 1000, // typeTrueSanshaCapitalCapacitorBooster
  41515: 1000, // typeCapitalFlexArmorHardenerI
  41525: 1000, // typeCapitalFlexArmorHardenerII
  41526: 1000, // typeDarkBloodCapitalFlexArmorHardener
  41527: 1000, // typeShadowSerpentisCapitalFlexArmorHardener
  41516: 1000, // typeCapitalFlexShieldHardenerI
  41528: 1000, // typeCapitalFlexShieldHardenerII
  41529: 1000, // typeTrueSanshaCapitalFlexShieldHardener
  41530: 1000, // typeDreadGuristasCapitalFlexShieldHardener
  41531: 1000, // typeDominationCapitalFlexShieldHardener
  24283: 1000, // typeFighterSupportUnitI
  41415: 1000, // typeFighterSupportUnitII
  41414: 1000, // typeHermesCompactFighterSupportUnit
  41417: 1000, // typeSentientFighterSupportUnit
  12219: 1000, // typeCapitalRemoteCapacitorTransmitterI
  41566: 1000, // typeCapitalInductiveCompactRemoteCapacitorTransmitter
  41565: 1000, // typeCapitalRadiativeScopedRemoteCapacitorTransmitter
  12223: 1000, // typeCapitalRemoteCapacitorTransmitterII
  3575: 1000, // typeCONCORDCapitalRemoteCapacitorTransmitter
  41440: 2000, // typePhalaricaThermalLance
  41441: 2000, // typeGeiravorExplosiveLance
  41443: 2000, // typeGuillotineThermalReaper
  41444: 2000, // typeJormungandrExplosiveReaper
  24550: 2000, // typeJudgementElectromagneticDoomsday
  24552: 2000, // typeOblivionKineticDoomsday
  24554: 2000, // typeAuroraOminaeThermalDoomsday
  41442: 2000, // typeColdWindKineticReaper
  40631: 2000, // typeHolyDestinyElectromagneticLance
  40632: 2000, // typeDivineHarvestElectromagneticReaper
  40633: 2000, // typeBosonicFieldGenerator
  23674: 2000, // typeGjallarhornExplosiveDoomsday
  40634: 2000, // typeGravitationalTransportationFieldOscillator
  41439: 2000, // typeIronPikeKineticLance
  40699: 2000, // typeWeaponDisruptionBurstProjector
  40696: 2000, // typeWarpDisruptionBurstProjector
  40697: 2000, // typeSensorDampeningBurstProjector
  40698: 2000, // typeTargetIlluminationBurstProjector
  40635: 2000, // typeStasisWebificationBurstProjector
  40636: 2000, // typeEnergyNeutralizationBurstProjector
  27678: 2000, // typeECMJammerBurstProjector
  40714: 2000, // typeCapitalEmergencyHullEnergizerI
  40715: 2000, // typeCapitalImplacableCompactEmergencyHullEnergizer
  40716: 2000, // typeCapitalIndefatigableEnduringEmergencyHullEnergizer
  40717: 2000, // typeCapitalEmergencyHullEnergizerII
  40718: 2000, // typeSistersCapitalEmergencyHullEnergizer
  24644: 1000, // typeCapitalTractorBeamI
  4252: 1000, // typeCapitalTractorBeamII
  81949: 1000, // typeCapitalConsortiumTractorBeam
  83465: 1000, // typeCapitalMicroJumpDrive
  83485: 1000, // typeCapitalMicroJumpDriveFieldGenerator
  88266: 1000, // typeStrategosSiegeModule
  88712: 1000, // typeXarasierCapitalMicroJumpDrive
  88713: 1000, // typeXarasierCapitalAncillaryShieldBooster
  88718: 1000, // typeXarasierCapitalAncillaryArmorRepairer
});

let migrationComplete = false;
let itemMutationVersion = 1;
let itemsTableCache = null;
let itemIndexesDirty = true;
let itemIndexesCache = null;
// itemID -> { locationID, ownerID } the item is currently filed under, so an
// incremental update can find and move/remove it without a full rebuild.
let itemIndexKeys = new Map();
let reservedItemIDBatch = [];
let itemIndexFullRebuildCount = 0;
let itemIndexIntegrityValidationCount = 0;
// A write/flush failure can leave the in-memory item snapshot ahead of durable
// SQLite state. Never treat that process-local receipt as proof until the
// corresponding persistence boundary is reconciled (or the process restarts).
const uncertainIdempotentGrantReceipts = new Map();
// A move joins a group only by carrying its exact token. Other custody routes,
// especially grants that retire a source in another table, keep their fences.
let inventoryMoveBatches = new WeakMap();
const pendingInventoryMoveBatches = new Set();

function inventoryMoveBatchError(token) {
  if (token === null || token === undefined) return null;
  const state = inventoryMoveBatches.get(token);
  if (state && !state.closed) return null;
  return {
    success: false,
    durable: false,
    ambiguous: false,
    errorMsg: state ? "INVENTORY_MOVE_BATCH_CLOSED" : "INVENTORY_MOVE_BATCH_INVALID",
  };
}

function isInventoryMoveBatchOpen(token) {
  const state = token && inventoryMoveBatches.get(token);
  return Boolean(state && !state.closed);
}

function getInventoryMoveBatchState(token) {
  const state = token && inventoryMoveBatches.get(token);
  return state ? {
    open: !state.closed,
    dirty: state.dirty,
    pendingReceiptCount: state.receiptKeys.size,
  } : null;
}

function enlistInventoryMoveBatch(token, receiptKey = null) {
  const state = token && inventoryMoveBatches.get(token);
  if (!state) return;
  state.dirty = true;
  if (receiptKey) state.receiptKeys.add(receiptKey);
  pendingInventoryMoveBatches.add(state);
}

// Every successful fence commits the whole items table, including moves from
// another explicit scope. Release their deferred hooks only after that fence.
function settleInventoryMoveBatches() {
  const hooks = [];
  for (const state of pendingInventoryMoveBatches) {
    state.dirty = false;
    for (const receiptKey of state.receiptKeys) {
      if (uncertainIdempotentGrantReceipts.get(receiptKey) === "flush") {
        uncertainIdempotentGrantReceipts.delete(receiptKey);
      }
    }
    state.receiptKeys.clear();
    hooks.push(...state.insuranceHooks);
    state.insuranceHooks.length = 0;
  }
  pendingInventoryMoveBatches.clear();
  for (const { changes, reason } of hooks) {
    notifyInsuranceInventoryMutationChanges(changes, reason);
  }
}

function flushInventoryMoveBatch(state) {
  if (!state.dirty) return { success: true, durable: true, flushed: false };
  let flushed;
  try {
    flushed = repo.flushTableSync(ITEMS_TABLE);
  } catch (error) {
    flushed = { success: false, errorMsg: String(error && error.message || error) };
  }
  if (!flushed || flushed.success !== true) {
    for (const receiptKey of state.receiptKeys) {
      uncertainIdempotentGrantReceipts.set(receiptKey, "flush");
    }
    return {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: flushed && flushed.errorMsg || "INVENTORY_MOVE_BATCH_FLUSH_FAILED",
    };
  }
  settleInventoryMoveBatches();
  return { success: true, durable: true, flushed: flushed.flushed !== false };
}

function createInventoryMoveBatch() {
  const state = { closed: false, dirty: false, receiptKeys: new Set(), insuranceHooks: [] };
  const token = Object.freeze({
    flush() {
      if (state.closed) return state.result;
      return flushInventoryMoveBatch(state);
    },
    commit() {
      if (state.closed) return state.result;
      try {
        state.result = flushInventoryMoveBatch(state);
        return state.result;
      } finally {
        state.closed = true;
      }
    },
  });
  inventoryMoveBatches.set(token, state);
  return token;
}

function notifyInventoryMoveInsurance(changes, reason, token) {
  const state = token && inventoryMoveBatches.get(token);
  if (state) {
    // Only ships have insurance. Avoid retaining every ordinary cargo delta.
    const shipChanges = changes.filter((change) => (
      Number(change && change.item && change.item.categoryID) === SHIP_CATEGORY_ID ||
      Number(change && change.previousData && change.previousData.categoryID) === SHIP_CATEGORY_ID
    ));
    if (shipChanges.length > 0) {
      state.insuranceHooks.push({ changes: cloneValue(shipChanges), reason });
    }
    return;
  }
  notifyInsuranceInventoryMutationChanges(changes, reason);
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

// Rollback metadata is process-local authority context, not part of the client
// inventory-change contract. Keep the exact pre-mutation row non-enumerable so
// callers can compensate byte-for-byte without serializing a duplicate item
// into notifications, receipts, or logs.
function withRollbackPreviousData(change, previousData) {
  Object.defineProperty(change, "rollbackPreviousData", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: cloneValue(previousData),
  });
  return change;
}

function maybeNotifyInsuranceInventoryMutation(
  previousItem,
  nextItem,
  reason = "inventory",
) {
  const previousCategoryID = toNumber(
    previousItem && previousItem.categoryID,
    0,
  );
  const nextCategoryID = toNumber(nextItem && nextItem.categoryID, 0);
  if (
    previousCategoryID !== SHIP_CATEGORY_ID &&
    nextCategoryID !== SHIP_CATEGORY_ID
  ) {
    return;
  }

  try {
    const insuranceRuntime = require(path.join(
      __dirname,
      "../insurance/insuranceRuntime",
    ));
    if (typeof insuranceRuntime.handleInventoryMutation === "function") {
      insuranceRuntime.handleInventoryMutation({
        previousItem: previousItem ? cloneValue(previousItem) : null,
        nextItem: nextItem ? cloneValue(nextItem) : null,
        reason,
      });
    }
  } catch (error) {
    log.warn(
      `[ItemStore] Insurance inventory hook failed item=${
        (nextItem && nextItem.itemID) ||
        (previousItem && previousItem.itemID) ||
        0
      }: ${error.message}`,
    );
  }
}

function notifyInsuranceInventoryMutationChanges(
  changes = [],
  reason = "inventory",
) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || change.removed === true) {
      continue;
    }
    maybeNotifyInsuranceInventoryMutation(
      change.previousData || change.previousState || null,
      change.item || null,
      reason,
    );
  }
}

function normalizeTimestampMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function readCharacters() {
  const result = repo.read(CHARACTERS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }

  return result.data;
}

function readItems() {
  if (itemsTableCache) {
    return itemsTableCache;
  }
  const result = repo.read(ITEMS_TABLE, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }

  itemsTableCache = result.data;
  return itemsTableCache;
}

// Derive an index delta from a mutation's existing `changes` record (the same
// list it sends to the client), so a multi-item path reports exactly what it
// touched. Removed entries use previousData.itemID; everything else is an upsert.
function indexDeltaFromChanges(changes) {
  const upsertedIDs = [];
  const removedIDs = [];
  for (const change of changes || []) {
    if (change && change.removed) {
      const id = toNumber(change.previousData && change.previousData.itemID, 0);
      if (id) {
        removedIDs.push(id);
      }
    } else if (change && change.item) {
      const id = toNumber(change.item.itemID, 0);
      if (id) {
        upsertedIDs.push(id);
      }
    }
  }
  return { upsertedIDs, removedIDs };
}

function buildKnownChangedItemPaths(indexDelta, additionalPaths = []) {
  const paths = new Set();
  if (indexDelta && typeof indexDelta === "object") {
    for (const itemID of [
      ...(Array.isArray(indexDelta.upsertedIDs) ? indexDelta.upsertedIDs : []),
      ...(Array.isArray(indexDelta.removedIDs) ? indexDelta.removedIDs : []),
    ]) {
      const numericItemID = toNumber(itemID, 0);
      if (numericItemID > 0) {
        paths.add(`/${String(numericItemID)}`);
      }
    }
  }
  for (const pathKey of Array.isArray(additionalPaths) ? additionalPaths : []) {
    const normalizedPath = String(pathKey || "").trim();
    if (normalizedPath && normalizedPath !== "/") {
      paths.add(
        normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`,
      );
    }
  }
  return [...paths];
}

function normalizeInventoryCustodyRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function sameInventoryCustodyShape(previous, next) {
  return ["ownerID", "locationID", "flagID", "typeID", "singleton"]
    .every((field) => Number(previous[field]) === Number(next[field])) &&
    Number(previous.stacksize ?? previous.quantity) === Number(next.stacksize ?? next.quantity);
}

function stampInventoryCustodyRevision(previous, next, { track = false, restoreFloor = 0 } = {}) {
  if (!next || typeof next !== "object" || !(Number(next.itemID ?? next.shipID) > 0) ||
      !(Number(next.typeID ?? next.shipTypeID) > 0)) return next;
  const previousRevision = normalizeInventoryCustodyRevision(previous && previous.inventoryCustodyRevision);
  const restoredRevision = normalizeInventoryCustodyRevision(restoreFloor);
  if (restoreFloor && !restoredRevision) throw new Error("INVENTORY_CUSTODY_REVISION_EXHAUSTED");
  if (!previousRevision && !track && !restoredRevision &&
      !Object.prototype.hasOwnProperty.call(next, "inventoryCustodyRevision")) return next;
  let revision = previousRevision;
  if (previousRevision && !sameInventoryCustodyShape(previous, next)) revision += 1;
  if (!previousRevision && track) revision = 1;
  revision = Math.max(revision, restoredRevision);
  if (!Number.isSafeInteger(revision)) throw new Error("INVENTORY_CUSTODY_REVISION_EXHAUSTED");
  const stamped = { ...next };
  if (revision) stamped.inventoryCustodyRevision = revision;
  else delete stamped.inventoryCustodyRevision;
  return stamped;
}

function inventoryCompensationPostState(item) {
  const state = { ...item };
  // This server fence advances with custody. It is not part of the item's
  // business post-state that a receipt-backed compensation must match.
  delete state.inventoryCustodyRevision;
  return state;
}

function writeItems(data, options = {}) {
  const { indexDelta, knownChangedPaths, characterRecordInputChanges, ...dbOptions } = options;
  const localizedPaths = buildKnownChangedItemPaths(indexDelta, knownChangedPaths);
  if (localizedPaths.length > 0) {
    dbOptions.knownChangedPaths = localizedPaths;
  }
  const writeResult = repo.write(ITEMS_TABLE, "/", data, dbOptions);
  if (writeResult && writeResult.success) {
    itemsTableCache = data;
    if (indexDelta && itemIndexesCache && !itemIndexesDirty) {
      // The caller told us exactly what changed and the index is current — patch
      // it in place instead of forcing an O(total items) rebuild on next read.
      applyItemIndexDelta(itemIndexesCache, data, indexDelta);
      itemIndexIncrementalUpdates += 1;
      if (
        ITEM_INDEX_SELFCHECK_INTERVAL > 0 &&
        itemIndexIncrementalUpdates % ITEM_INDEX_SELFCHECK_INTERVAL === 0
      ) {
        validateItemIndexIntegrity();
      }
    } else {
      // No delta (or index not built yet) → fall back to a full rebuild, exactly
      // as before. This keeps every not-yet-migrated caller correct.
      itemIndexesDirty = true;
      itemIndexesCache = null;
    }
    itemMutationVersion += 1;
    // Invalidate synchronously before observers can read the committed rows.
    const recordInputs = require("../character/characterRecordInputs");
    if (characterRecordInputChanges && !characterRecordInputChanges.unknownPreimage) {
      recordInputs.noteCommittedItemRows(characterRecordInputChanges.originals, data);
    } else {
      recordInputs.noteAllCharacterRecordInputsChanged();
    }
    publishSimulationInventoryMutation(data, indexDelta);
    require("./itemMutationEvents").publish(indexDelta
      ? [...(indexDelta.upsertedIDs || []), ...(indexDelta.removedIDs || [])]
      : null, data);
    return true;
  }
  return false;
}

let projectionModuleEntry = null;
let projectionModuleLoader = null;
function resolveInventoryProjectionForPublish() {
  let filename = null;
  let loader = null;
  try {
    filename = path.join(__dirname, "simulationInventoryProjection.js");
    loader = NodeModule._load;
    const entry = NodeModule._cache[filename];
    if (typeof loader === "function" && loader === projectionModuleLoader &&
        entry && entry === projectionModuleEntry && entry.loaded === true) {
      return entry.exports;
    }
  } catch (_) {
    // Metadata is optional: the original require remains authoritative.
  }
  const projection = require(path.join(__dirname, "./simulationInventoryProjection"));
  try {
    const entry = filename && NodeModule._cache[filename];
    if (typeof loader === "function" && NodeModule._load === loader && entry &&
        entry.loaded === true && entry.exports === projection &&
        require.resolve(path.join(__dirname, "./simulationInventoryProjection")) === filename) {
      projectionModuleEntry = entry;
      projectionModuleLoader = loader;
    } else {
      projectionModuleEntry = null;
      projectionModuleLoader = null;
    }
  } catch (_) {
    projectionModuleEntry = null;
    projectionModuleLoader = null;
  }
  return projection;
}

function publishSimulationInventoryMutation(data, indexDelta) {
  try {
    const projection = resolveInventoryProjectionForPublish();
    if (!indexDelta || typeof indexDelta !== "object") {
      projection.publishItemMutation({
        version: itemMutationVersion,
        fullItems: Object.values(data || {}),
      });
      return;
    }
    const upsertedIDs = Array.isArray(indexDelta.upsertedIDs)
      ? [...new Set(indexDelta.upsertedIDs.map((itemID) => toNumber(itemID, 0)).filter(Boolean))]
      : [];
    const removedItemIDs = Array.isArray(indexDelta.removedIDs)
      ? [...new Set(indexDelta.removedIDs.map((itemID) => toNumber(itemID, 0)).filter(Boolean))]
      : [];
    projection.publishItemMutation({
      version: itemMutationVersion,
      upsertedItems: upsertedIDs.map((itemID) => data[String(itemID)]).filter(Boolean),
      removedItemIDs,
    });
  } catch (error) {
    log.warn(`[ItemStore] Failed to publish simulation inventory projection: ${error.message}`);
  }
}

// Persistence exclusions are policy metadata, not part of the item-table
// transaction, and the gameStore exposes no way to read a marker back — so a
// removal can only clear them AFTER its authoritative commit succeeds. Clearing
// them first would leave a rejected write with no way to restore the markers it
// had already dropped.
function clearTransientItemPaths(itemIDs) {
  const paths = (Array.isArray(itemIDs) ? itemIDs : [])
    .map((itemID) => toNumber(itemID, 0))
    .filter((itemID) => itemID > 0)
    .map((itemID) => `/${String(itemID)}`);
  if (paths.length === 0) {
    return;
  }
  repo.setTransientPaths(ITEMS_TABLE, paths, false);
}

// A transient row stays off disk because the thing holding it dies with the
// process. Once a committed move puts it inside a location that does not -- a
// looted NPC sentry ammo stack dragged into a ship's cargo, then on into a
// hangar -- that reason is gone, and keeping the marker silently deletes the
// player's item at the next restart. A whole-stack move keeps its itemID, so
// the marker would otherwise follow it forever. Space and transient items keep
// the marker, so NPC-owned rows launched or moved there stay runtime-only.
// Only rows a change actually left at the destination count: a partial move's
// source stack stays behind in the transient container and keeps its marker.
function persistTransientItemsMovedIntoDurableLocation(destinationLocationID, changes) {
  const locationID = toNumber(destinationLocationID, 0);
  if (
    locationID <= 0 ||
    worldData.getSolarSystemByID(locationID) ||
    repo.isTransientPath(ITEMS_TABLE, `/${String(locationID)}`)
  ) {
    return;
  }
  const clearedItemIDs = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    if (
      !change ||
      change.removed === true ||
      !change.item ||
      toNumber(change.item.locationID, 0) !== locationID
    ) {
      continue;
    }
    const itemID = toNumber(change.item.itemID, 0);
    if (itemID <= 0 || !repo.isTransientPath(ITEMS_TABLE, `/${String(itemID)}`)) {
      continue;
    }
    clearedItemIDs.push(itemID, ...collectContainedItemIDs(itemID));
  }
  clearTransientItemPaths(clearedItemIDs);
}

// Stage a multi-row inventory operation without cloning the entire items map.
// Reads fall through to the live table while writes stay in a row overlay until
// commit. The commit applies only touched rows, supplies their exact persistence
// paths through indexDelta, and restores the original row references if the
// repository rejects the write.
// Whether a stored item row is part of a ship's Dogma: in a fitting slot or
// among its hidden modifiers.
function isDogmaAffectingRow(row) {
  if (!row || typeof row !== "object") {
    return false;
  }
  const flagID = toNumber(row.flagID, 0);
  return isFittingFlag(flagID) || flagID === ITEM_FLAGS.HIDDEN_MODIFIERS;
}

function dogmaAffectingRowKey(row) {
  return [
    row.typeID,
    row.locationID,
    row.flagID,
    row.moduleState && row.moduleState.online,
  ].map(String).join(":");
}

// Moves the Dogma invalidation version once when a committed write added,
// removed or changed (type, place or online state) a row in a fitting slot or
// among the hidden modifiers. A charge's quantity is not part of it.
function noteDogmaAffectingRowChanges(originals, stagedRows, removedRows) {
  for (const [key, original] of originals) {
    const before = original.existed ? original.value : null;
    const after = removedRows.has(key) ? null : stagedRows.get(key);
    if (!isDogmaAffectingRow(before) && !isDogmaAffectingRow(after)) {
      continue;
    }
    if (before && after && dogmaAffectingRowKey(before) === dogmaAffectingRowKey(after)) {
      continue;
    }
    bumpDogmaInvalidationVersion();
    return;
  }
}

function createItemRowMutationPlan() {
  const baseItems = readItems();
  const stagedRows = new Map();
  const removedRows = new Set();
  // The receipt ledger is one row holding every receipt ever written, so
  // staging it as a copy cost the whole ledger on every receipt. A plan stages
  // receipt entries in this overlay instead and commit applies them in place.
  let ledgerOverlay = null;
  function stageLedgerOverlay() {
    if (ledgerOverlay) {
      return stagedRows.get(IDEMPOTENT_GRANT_RECEIPTS_KEY) === ledgerOverlay.view
        ? ledgerOverlay.view
        : null;
    }
    // A whole ledger this plan already replaced or removed keeps the copy path.
    if (stagedRows.has(IDEMPOTENT_GRANT_RECEIPTS_KEY) || removedRows.has(IDEMPOTENT_GRANT_RECEIPTS_KEY)) {
      return null;
    }
    const live = getIdempotentGrantReceiptLedger(baseItems, false);
    const base = live || {};
    const entries = new Map();
    const removed = new Set();
    const view = new Proxy(base, {
      get(target, property, receiver) {
        if (typeof property === "string") {
          if (removed.has(property)) return undefined;
          if (entries.has(property)) return entries.get(property);
        }
        return Reflect.get(target, property, receiver);
      },
      set(_target, property, value) {
        const key = String(property);
        entries.set(key, value);
        removed.delete(key);
        return true;
      },
      deleteProperty(_target, property) {
        const key = String(property);
        entries.delete(key);
        removed.add(key);
        return true;
      },
      has(target, property) {
        const key = String(property);
        if (removed.has(key)) return false;
        return entries.has(key) || Reflect.has(target, property);
      },
      ownKeys(target) {
        const keys = new Set(Reflect.ownKeys(target));
        for (const key of removed) keys.delete(key);
        for (const key of entries.keys()) keys.add(key);
        return [...keys];
      },
      getOwnPropertyDescriptor(target, property) {
        const key = String(property);
        if (removed.has(key)) return undefined;
        if (entries.has(key)) {
          return { configurable: true, enumerable: true, writable: true, value: entries.get(key) };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    ledgerOverlay = { live, entries, removed, view };
    stagedRows.set(IDEMPOTENT_GRANT_RECEIPTS_KEY, view);
    return view;
  }
  // Apply the overlay to the live ledger and return how to undo it.
  function applyLedgerOverlay() {
    const created = !ledgerOverlay.live;
    const ledger = created ? {} : ledgerOverlay.live;
    if (created) {
      if (ledgerOverlay.entries.size === 0) return () => {};
      baseItems[IDEMPOTENT_GRANT_RECEIPTS_KEY] = ledger;
    }
    const prior = [];
    for (const key of new Set([...ledgerOverlay.entries.keys(), ...ledgerOverlay.removed])) {
      prior.push([key, Object.prototype.hasOwnProperty.call(ledger, key), ledger[key]]);
      if (ledgerOverlay.entries.has(key)) ledger[key] = ledgerOverlay.entries.get(key);
      else delete ledger[key];
    }
    return () => {
      for (const [key, existed, value] of prior) {
        if (existed) ledger[key] = value;
        else delete ledger[key];
      }
      if (created) delete baseItems[IDEMPOTENT_GRANT_RECEIPTS_KEY];
    };
  }
  const items = new Proxy(baseItems, {
    get(target, property, receiver) {
      if (property === ITEM_ROW_PLAN_LEDGER) {
        return stageLedgerOverlay;
      }
      if (typeof property === "string") {
        if (removedRows.has(property)) {
          return undefined;
        }
        if (stagedRows.has(property)) {
          return stagedRows.get(property);
        }
      }
      return Reflect.get(target, property, receiver);
    },
    set(_target, property, value) {
      const key = String(property);
      stagedRows.set(key, value);
      removedRows.delete(key);
      return true;
    },
    deleteProperty(_target, property) {
      const key = String(property);
      stagedRows.delete(key);
      removedRows.add(key);
      return true;
    },
    has(target, property) {
      const key = String(property);
      if (removedRows.has(key)) {
        return false;
      }
      return stagedRows.has(key) || Reflect.has(target, property);
    },
    ownKeys(target) {
      const keys = new Set(Reflect.ownKeys(target));
      for (const key of removedRows) {
        keys.delete(key);
      }
      for (const key of stagedRows.keys()) {
        keys.add(key);
      }
      return [...keys];
    },
    getOwnPropertyDescriptor(target, property) {
      const key = String(property);
      if (removedRows.has(key)) {
        return undefined;
      }
      if (stagedRows.has(key)) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stagedRows.get(key),
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  function commit(options = {}) {
    const { trackCustodyRevisionItemIDs = [], custodyRevisionRestoreFloors = {}, ...writeOptions } = options;
    const factoryPaths = require("./incursionFactoryCustody").stageWithdrawals(baseItems, items, stagedRows, removedRows,
      () => require("../incursion/incursionClock").now());
    if (factoryPaths.length) writeOptions.knownChangedPaths = [...(writeOptions.knownChangedPaths || []), ...factoryPaths];
    const trackingIDs = new Set(trackCustodyRevisionItemIDs.map(String));
    function preservesCharacterBinding(row) {
      const bound = Number(row?.careerBoundCharacterID || 0);
      if (!bound) return true;
      if (Number(row.ownerID) !== bound || Number(row.locationID) < 0) return false;
      let parent = items[String(row.locationID)];
      const seen = new Set([Number(row.itemID)]);
      while (parent && ![3, 65].includes(Number(parent.categoryID))) {
        if (seen.has(Number(parent.itemID)) || Number(parent.ownerID) !== bound || Number(parent.locationID) < 0) return false;
        seen.add(Number(parent.itemID)); parent = items[String(parent.locationID)];
      }
      return true;
    }
    // Character-bound ACP goods cannot be laundered through an owner update,
    // an escrow location, or a container whose ownership changes around them.
    // Validate the staged tree before changing the shared cache or writing it.
    for (const [key, next] of stagedRows) {
      if (!(Number(key) > 0) || !next) continue;
      const previous = baseItems[key];
      const bound = Number(next.careerBoundCharacterID || 0);
      if (previous?.careerBoundCharacterID && bound !== Number(previous.careerBoundCharacterID)) return false;
      if (bound && (Number(next.ownerID) !== bound || Number(next.locationID) < 0)) return false;
      if (previous && Number(previous.ownerID) !== Number(next.ownerID) && hasCharacterBoundContents(Number(key))) return false;
      if (!preservesCharacterBinding(next)) return false;
      if (previous && Number(previous.locationID) !== Number(next.locationID))
        for (const childID of collectContainedItemIDs(Number(key)))
          if (!preservesCharacterBinding(items[String(childID)])) return false;
    }
    // The ledger overlay is not a row to replace: it is applied in place below.
    const overlayStaged = Boolean(ledgerOverlay) &&
      stagedRows.get(IDEMPOTENT_GRANT_RECEIPTS_KEY) === ledgerOverlay.view;
    if (overlayStaged) {
      stagedRows.delete(IDEMPOTENT_GRANT_RECEIPTS_KEY);
    }
    const touchedKeys = new Set([...stagedRows.keys(), ...removedRows]);
    const originals = new Map();
    for (const key of touchedKeys) {
      originals.set(key, {
        existed: Object.prototype.hasOwnProperty.call(baseItems, key),
        value: baseItems[key],
      });
    }
    // Calculate against the preimage, before replacing any shared cache row.
    // New split rows remain untagged; only the explicit owner API enrolls one.
    const stampedRows = new Map();
    const unknownPreimage = [...stagedRows].some(([key, next]) =>
      originals.get(key).existed && originals.get(key).value === next);
    for (const [key, next] of stagedRows) {
      const numericKey = Number(key);
      stampedRows.set(key, Number.isSafeInteger(numericKey) && numericKey > 0
        ? stampInventoryCustodyRevision(originals.get(key).value, next, {
          track: trackingIDs.has(key), restoreFloor: custodyRevisionRestoreFloors[key],
        }) : next);
    }
    for (const key of touchedKeys) {
      if (removedRows.has(key)) {
        delete baseItems[key];
      } else {
        baseItems[key] = stampedRows.get(key);
      }
    }
    const undoLedgerOverlay = overlayStaged ? applyLedgerOverlay() : () => {};

    let committed = false;
    try {
      committed = writeItems(baseItems, {
        ...writeOptions,
        characterRecordInputChanges: { originals, unknownPreimage },
      });
    } catch (error) {
      undoLedgerOverlay();
      for (const [key, original] of originals) {
        if (original.existed) {
          baseItems[key] = original.value;
        } else {
          delete baseItems[key];
        }
      }
      throw error;
    }
    if (committed) {
      noteGmDogmaItemChanges(originals, stampedRows, removedRows);
      noteDogmaAffectingRowChanges(originals, stampedRows, removedRows);
      return true;
    }

    undoLedgerOverlay();
    for (const [key, original] of originals) {
      if (original.existed) {
        baseItems[key] = original.value;
      } else {
        delete baseItems[key];
      }
    }
    return false;
  }

  return { items, commit };
}

function setShipSkinrApplicationIdempotent(itemID, characterID, hex, options = {}) {
  return executeIdempotentInventoryMutation(options, "skinr-ship-application", receipt => {
    const plan = createItemRowMutationPlan();
    const current = normalizeInventoryItem(plan.items[String(itemID)]);
    if (!current || Number(current.ownerID) !== Number(characterID) || current.categoryID !== SHIP_CATEGORY_ID || current.singleton !== 1) return { success: false, errorMsg: "SHIP_NOT_OWNED" };
    if (options.requiredTypeID && Number(current.typeID) !== Number(options.requiredTypeID)) return { success: false, errorMsg: "SKIN_SHIP_TYPE_MISMATCH" };
    const shouldClear = !hex && (!options.expectedHex || current.skinrApplication?.hex === options.expectedHex);
    const item = normalizeInventoryItem({ ...current, skinrApplication: hex ? { characterID, hex, receiptKey: receipt.receiptKey } : shouldClear ? null : current.skinrApplication });
    const changes = isDeepStrictEqual(current, item) ? [] : [{ removed: false, previousData: cloneValue(current), item: cloneValue(item) }];
    receipt.resultData = { item: cloneValue(item), changes: cloneValue(changes) };
    plan.items[String(itemID)] = item;
    stageIdempotentGrantReceiptLedger(plan.items);
    attachIdempotentInventoryReceipt(plan.items, receipt);
    if (!plan.commit({ indexDelta: { upsertedIDs: [Number(itemID)] } })) return { success: false, errorMsg: "WRITE_ERROR" };
    return { success: true, data: { item, changes } };
  });
}
function clearShipSkinrApplication(itemID, characterID) {
  const current = findShipItemById(itemID);
  if (!current || current.ownerID !== Number(characterID)) return { success: false, errorMsg: "SHIP_NOT_OWNED" };
  if (!current.skinrApplication) return { success: true };
  const result = updateInventoryItem(itemID, item => ({ ...item, skinrApplication: null }));
  if (!result.success) return result;
  const flushed = repo.flushTableSync(ITEMS_TABLE);
  return flushed?.success ? result : { success: false, ambiguous: true, errorMsg: flushed?.errorMsg || "SKINR_APPLICATION_FLUSH_FAILED" };
}

// The scene owner resolves damage; inventory owns the atomic health/receipt
// boundary. A dungeon acknowledgement can be lost without charging the hit
// twice, and the receipt (including prepared death intent) outlives the hull.
function commitSiteHazardDamageIdempotent(snapshot, calculate, options = {}) {
  return executeIdempotentInventoryMutation(options, "site-hazard-damage", receipt => {
    const plan = createItemRowMutationPlan();
    const itemID = Number(snapshot?.shipID);
    const current = normalizeInventoryItem(plan.items[String(itemID)]);
    const matches = current && current.categoryID === SHIP_CATEGORY_ID && current.singleton === 1 &&
      Number(current.ownerID) === Number(snapshot.ownerID) && Number(current.typeID) === Number(snapshot.typeID) &&
      Number(current.locationID) === Number(snapshot.systemID) && Number(current.flagID) === 0 &&
      Number(current.inventoryCustodyRevision) === Number(snapshot.inventoryCustodyRevision);
    let resultData = { stale: true };
    if (matches) {
      const calculated = calculate(cloneValue(current));
      if (!calculated?.success) return calculated || { success: false, errorMsg: "SITE_HAZARD_CALCULATION_FAILED" };
      const updated = normalizeInventoryItem({ ...current, conditionState: calculated.conditionState });
      plan.items[String(itemID)] = updated;
      resultData = { stale: false, conditionState: cloneValue(updated.conditionState),
        damageResult: cloneValue(calculated.damageResult), deathPlan: cloneValue(calculated.deathPlan || null) };
    }
    receipt.resultData = resultData;
    const attached = attachIdempotentInventoryReceipt(plan.items, receipt);
    if (!plan.commit({ indexDelta: { upsertedIDs: matches ? [itemID] : [] },
      knownChangedPaths: [attached.path] })) return { success: false, errorMsg: "WRITE_ERROR" };
    return { success: true, data: cloneValue(resultData) };
  });
}

function completeSiteHazardDeathIdempotent(options = {}) {
  return executeIdempotentInventoryMutation(options, "site-hazard-death-settled", receipt => {
    const plan = createItemRowMutationPlan();
    receipt.resultData = { settled: true };
    const attached = attachIdempotentInventoryReceipt(plan.items, receipt);
    if (!plan.commit({ knownChangedPaths: [attached.path] })) return { success: false, errorMsg: "WRITE_ERROR" };
    return { success: true, data: { settled: true } };
  });
}

function trackItemCustodyRevision(itemID) {
  ensureMigrated();
  const numericItemID = toNumber(itemID, 0);
  const mutationPlan = createItemRowMutationPlan();
  const current = mutationPlan.items[String(numericItemID)];
  if (!normalizeInventoryItem(current)) return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  if (!normalizeInventoryCustodyRevision(current.inventoryCustodyRevision)) {
    mutationPlan.items[String(numericItemID)] = { ...current };
    if (!mutationPlan.commit({
      trackCustodyRevisionItemIDs: [numericItemID], indexDelta: { upsertedIDs: [numericItemID] },
    })) return { success: false, errorMsg: "WRITE_ERROR" };
  }
  // Repeat this boundary even on an idempotent retry after a failed flush.
  const flushed = repo.flushTableSync(ITEMS_TABLE);
  if (!flushed || flushed.success !== true) {
    return { success: false, errorMsg: flushed && flushed.errorMsg || "INVENTORY_CUSTODY_REVISION_FLUSH_FAILED" };
  }
  return { success: true, data: findItemById(numericItemID) };
}

function getItemMutationVersion() {
  return itemMutationVersion;
}

function getSimulationInventoryProjectionSeed() {
  ensureMigrated();
  return {
    version: itemMutationVersion,
    items: Object.values(readItems()),
  };
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function hasPositiveLocationID(value) {
  return toNumber(value, 0) > 0;
}

function appendIndexedItem(indexMap, key, item) {
  if (!Number.isFinite(Number(key))) {
    return;
  }
  if (!indexMap.has(key)) {
    indexMap.set(key, []);
  }
  indexMap.get(key).push(item);
}

// ── Incremental index maintenance ───────────────────────────────────
// These patch a live (already-built) index for a single item, matching exactly
// what a from-scratch ensureItemIndexes() rebuild produces: byID holds the
// normalized item; byLocation/byOwner buckets stay ascending by itemID; empty
// buckets are dropped. Only used when a caller passes writeItems an indexDelta.

// Find itemID in an ascending-by-itemID bucket. A character's owner bucket holds
// every item they own, so a linear scan here made each item mutation cost the
// size of their whole inventory. The bucket order is an invariant of the insert
// and rebuild paths; if an entry is ever not where the order puts it, fall back
// to the scan rather than miss it.
function findIndexBucketPosition(bucket, itemID) {
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bucket[mid] && bucket[mid].itemID < itemID) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo < bucket.length && bucket[lo] && bucket[lo].itemID === itemID) {
    return lo;
  }
  return bucket.findIndex((entry) => entry && entry.itemID === itemID);
}

function removeFromIndexBucket(indexMap, key, itemID) {
  if (!Number.isFinite(Number(key))) {
    return;
  }
  const bucket = indexMap.get(key);
  if (!bucket) {
    return;
  }
  const at = findIndexBucketPosition(bucket, itemID);
  if (at >= 0) {
    bucket.splice(at, 1);
  }
  if (bucket.length === 0) {
    indexMap.delete(key);
  }
}

function insertIntoIndexBucket(indexMap, key, item) {
  if (!Number.isFinite(Number(key))) {
    return;
  }
  let bucket = indexMap.get(key);
  if (!bucket) {
    bucket = [];
    indexMap.set(key, bucket);
  }
  // Binary search for the ascending-by-itemID insertion point.
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bucket[mid].itemID < item.itemID) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  // Idempotent insert: a bucket must NEVER hold the same itemID twice. If this
  // item is already filed here, replace it in place instead of adding a second
  // entry. The read paths (listOwnedItems/listContainerItems/listSystemSpaceItems)
  // re-filter by the bucket's own key, so a stale cross-bucket entry is dropped —
  // but a same-bucket duplicate would survive that filter and surface to the
  // client as a duplicated item (e.g. a ship + its contents shown twice). Guarding
  // here makes the incremental index self-correcting against a stale/incomplete
  // delta rather than silently doubling a row.
  if (lo < bucket.length && bucket[lo].itemID === item.itemID) {
    bucket[lo] = item;
    return;
  }
  bucket.splice(lo, 0, item);
}

function applyIndexUpsert(indexes, item) {
  const itemID = item.itemID;
  // Remove the prior filing before inserting the new one. byID holds the
  // previously-indexed copy, and inserts always file by that copy's own
  // locationID/ownerID — so it is the authoritative record of which buckets
  // currently hold this item. Removing by it (not only by the parallel
  // itemIndexKeys map) keeps the buckets correct even if itemIndexKeys ever
  // drifted, so a moved/re-owned item never lingers in its old bucket.
  const previous = indexes.byID.get(itemID) || null;
  const filed = itemIndexKeys.get(itemID) || null;
  if (previous) {
    removeFromIndexBucket(indexes.byLocation, previous.locationID, itemID);
    removeFromIndexBucket(indexes.byOwner, previous.ownerID, itemID);
  }
  if (filed && (!previous || filed.locationID !== previous.locationID)) {
    removeFromIndexBucket(indexes.byLocation, filed.locationID, itemID);
  }
  if (filed && (!previous || filed.ownerID !== previous.ownerID)) {
    removeFromIndexBucket(indexes.byOwner, filed.ownerID, itemID);
  }
  indexes.byID.set(itemID, item);
  indexes.starbase.upsert(item);
  insertIntoIndexBucket(indexes.byLocation, item.locationID, item);
  insertIntoIndexBucket(indexes.byOwner, item.ownerID, item);
  itemIndexKeys.set(itemID, { locationID: item.locationID, ownerID: item.ownerID });
}

function applyIndexRemoval(indexes, itemID) {
  const filed = itemIndexKeys.get(itemID);
  indexes.byID.delete(itemID);
  indexes.starbase.remove(itemID);
  if (filed) {
    removeFromIndexBucket(indexes.byLocation, filed.locationID, itemID);
    removeFromIndexBucket(indexes.byOwner, filed.ownerID, itemID);
    itemIndexKeys.delete(itemID);
  }
}

// Remove a whole delta from the derived indexes in one pass per affected
// bucket. Repeated findIndex/splice calls turn a large same-hangar deletion
// into O(n^2) array searching and shifting even when the authoritative table
// mutation itself is atomic. Grouping the removals keeps the work proportional
// to the removed rows plus the size of the owner/location buckets we touch.
function applyIndexRemovals(indexes, rawItemIDs = []) {
  const removedIDs = new Set(
    (Array.isArray(rawItemIDs) ? rawItemIDs : [])
      .map((itemID) => toNumber(itemID, 0))
      .filter((itemID) => itemID > 0),
  );
  if (removedIDs.size === 0) {
    return;
  }

  const locationRemovals = new Map();
  const ownerRemovals = new Map();
  const remember = (groups, key, itemID) => {
    if (!Number.isFinite(Number(key))) {
      return;
    }
    if (!groups.has(key)) {
      groups.set(key, new Set());
    }
    groups.get(key).add(itemID);
  };

  for (const itemID of removedIDs) {
    const previous = indexes.byID.get(itemID) || null;
    const filed = itemIndexKeys.get(itemID) || null;
    if (previous) {
      remember(locationRemovals, previous.locationID, itemID);
      remember(ownerRemovals, previous.ownerID, itemID);
    }
    if (filed) {
      remember(locationRemovals, filed.locationID, itemID);
      remember(ownerRemovals, filed.ownerID, itemID);
    }
    indexes.byID.delete(itemID);
    indexes.starbase.remove(itemID);
    itemIndexKeys.delete(itemID);
  }

  const filterBuckets = (indexMap, removalsByKey) => {
    for (const [key, ids] of removalsByKey) {
      const bucket = indexMap.get(key);
      if (!bucket) {
        continue;
      }
      // A few removals from a large bucket (one item leaving a big hangar) are
      // cheaper as searches than as a copy of the whole bucket. A bucket holds
      // an itemID at most once, so one splice per id removes it.
      if (ids.size * 16 < bucket.length) {
        for (const itemID of ids) {
          const at = findIndexBucketPosition(bucket, itemID);
          if (at >= 0) {
            bucket.splice(at, 1);
          }
        }
        if (bucket.length === 0) {
          indexMap.delete(key);
        }
        continue;
      }
      const retained = bucket.filter(
        (entry) => entry && !ids.has(toNumber(entry.itemID, 0)),
      );
      if (retained.length > 0) {
        indexMap.set(key, retained);
      } else {
        indexMap.delete(key);
      }
    }
  };

  filterBuckets(indexes.byLocation, locationRemovals);
  filterBuckets(indexes.byOwner, ownerRemovals);
}

// Apply a caller-reported set of changes to the live index.
function applyItemIndexDelta(indexes, data, delta) {
  applyIndexRemovals(indexes, delta.removedIDs || []);
  for (const rawID of delta.upsertedIDs || []) {
    const itemID = toNumber(rawID, 0);
    const item = normalizeInventoryItem(data[itemID]);
    if (item) {
      applyIndexUpsert(indexes, item);
    } else {
      applyIndexRemoval(indexes, itemID);
    }
  }
}

// Scaling note: this rebuilds byID/byLocation/byOwner over ALL items whenever
// the index is dirty, and writeItems() marks it dirty on every mutation — so a
// mutate-then-read cycle is O(total items) (normalize + sort every bucket). It
// is deliberately kept simple-and-correct: every item mutation flows through
// writeItems() with the whole items map, so the choke-point cannot tell which
// items changed without an O(N) diff. At large item counts (100k+) the fix is
// incremental maintenance at the writeItems() choke-point — diff the new map
// against the last-indexed snapshot and patch only changed entries with sorted
// insertion into the location/owner buckets. Deferred until profiling shows it
// matters, since it adds real complexity (and regression risk) to a core path.
// Build a fresh index + filing map from the current items. Pure: returns new
// structures and never touches the live cache (so the self-check can rebuild a
// parallel copy to compare against).
function buildItemIndexes() {
  const indexes = {
    byID: new Map(),
    byLocation: new Map(),
    byOwner: new Map(),
    starbase: new StarbaseItemIndex(),
  };
  const keys = new Map();

  for (const rawItem of Object.values(readItems())) {
    const item = normalizeInventoryItem(rawItem);
    if (!item) {
      continue;
    }
    indexes.byID.set(item.itemID, item);
    indexes.starbase.upsert(item);
    appendIndexedItem(indexes.byLocation, item.locationID, item);
    appendIndexedItem(indexes.byOwner, item.ownerID, item);
    keys.set(item.itemID, { locationID: item.locationID, ownerID: item.ownerID });
  }

  for (const indexMap of [indexes.byLocation, indexes.byOwner]) {
    for (const bucket of indexMap.values()) {
      bucket.sort((left, right) => left.itemID - right.itemID);
    }
  }

  return { indexes, keys };
}

function formatElapsedMs(ms) {
  return Number(ms).toFixed(ms >= 10 ? 1 : 3);
}

function rebuildItemIndexes(reason = "unknown") {
  const startedAtMs = performance.now();
  const built = buildItemIndexes();
  itemIndexFullRebuildCount += 1;
  const elapsedMs = performance.now() - startedAtMs;
  if (elapsedMs >= ITEM_INDEX_REBUILD_WARN_MS) {
    log.warn(
      `[itemStore] full item index rebuild reason=${reason} items=${built.keys.size} took ${formatElapsedMs(elapsedMs)}ms`,
    );
  }
  return built;
}

// Deep-comparable shape of an index (item objects in byID, itemID order in the
// buckets) — used by the self-check and the property test.
function snapshotItemIndexes(indexes) {
  const bucketEntries = (indexMap) =>
    [...indexMap.entries()]
      .map(([key, bucket]) => [key, bucket.map((entry) => entry.itemID)])
      .sort((left, right) => Number(left[0]) - Number(right[0]));
  return {
    byID: [...indexes.byID.entries()].sort((left, right) => left[0] - right[0]),
    byLocation: bucketEntries(indexes.byLocation),
    byOwner: bucketEntries(indexes.byOwner),
    starbase: indexes.starbase.snapshot(),
  };
}

function ensureItemIndexes() {
  ensureMigrated();
  if (!itemIndexesDirty && itemIndexesCache) {
    return itemIndexesCache;
  }

  const built = rebuildItemIndexes("ensure");
  itemIndexesCache = built.indexes;
  itemIndexKeys = built.keys;
  itemIndexesDirty = false;
  return itemIndexesCache;
}

// Safety backstop for incremental updates: every Nth incremental write, rebuild
// a parallel index and compare. If a caller ever reports a wrong/incomplete
// delta (e.g. mutates the items cache and bails before writeItems), this catches
// the drift and self-heals by swapping in the rebuild — so the worst case is a
// brief O(total items) rebuild, never an item permanently stuck/duplicated in
// the client's inventory.
//
// This default was previously 0 (disabled) for performance, which turned any
// transient delta inconsistency into PERMANENT drift — surfacing as intermittent
// duplicated/mis-located inventory rows. The structural guards above
// (idempotent insertIntoIndexBucket + byID-authoritative applyIndexUpsert) make
// reported-delta drift self-correcting at zero cost, so this periodic rebuild is
// now only a rare insurance pass against unreported mutations. The default is
// deliberately large so the amortized cost stays negligible (one rebuild per
// ~25k item writes); set EVEJS_ITEM_INDEX_SELFCHECK_INTERVAL=0 to opt out
// entirely, or smaller for aggressive diagnostics.
function readNonNegativeIntegerEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : fallback;
}

function readNonNegativeNumberEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const ITEM_INDEX_SELFCHECK_INTERVAL = (() => {
  return readNonNegativeIntegerEnv("EVEJS_ITEM_INDEX_SELFCHECK_INTERVAL", 25000);
})();
const ITEM_INDEX_REBUILD_WARN_MS = readNonNegativeNumberEnv(
  "EVEJS_ITEM_INDEX_REBUILD_WARN_MS",
  100,
);
let itemIndexIncrementalUpdates = 0;

function validateItemIndexIntegrity() {
  if (!itemIndexesCache || itemIndexesDirty) {
    return true; // nothing live to validate
  }
  itemIndexIntegrityValidationCount += 1;
  const rebuilt = rebuildItemIndexes("integrity-self-check");
  if (
    isDeepStrictEqual(
      snapshotItemIndexes(itemIndexesCache),
      snapshotItemIndexes(rebuilt.indexes),
    )
  ) {
    return true;
  }
  log.info(
    "[itemStore] incremental item index drift detected — self-healing with a full rebuild",
  );
  itemIndexesCache = rebuilt.indexes;
  itemIndexKeys = rebuilt.keys;
  return false;
}

function normalizeSpaceVector(rawValue, fallback = { x: 0, y: 0, z: 0 }) {
  if (!rawValue || typeof rawValue !== "object") {
    return {
      x: fallback.x,
      y: fallback.y,
      z: fallback.z,
    };
  }

  return {
    x: toFiniteNumber(rawValue.x, fallback.x),
    y: toFiniteNumber(rawValue.y, fallback.y),
    z: toFiniteNumber(rawValue.z, fallback.z),
  };
}

function normalizeDunRotation(rawValue) {
  if (!Array.isArray(rawValue) || rawValue.length < 3) {
    return null;
  }

  return [
    toFiniteNumber(rawValue[0], 0),
    toFiniteNumber(rawValue[1], 0),
    toFiniteNumber(rawValue[2], 0),
  ];
}

function normalizeEmergencyWarpReturnState(rawValue, fallbackSystemID = 0) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const systemID = toNumber(rawValue.systemID, fallbackSystemID);
  if (systemID <= 0) {
    return null;
  }

  return {
    systemID,
    position: normalizeSpaceVector(rawValue.position),
    velocity: normalizeSpaceVector(rawValue.velocity),
    direction: normalizeSpaceVector(rawValue.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: rawValue.targetPoint
      ? normalizeSpaceVector(rawValue.targetPoint)
      : normalizeSpaceVector(rawValue.position),
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: 0,
    orbitDistance: 0,
    orbitNormal: rawValue.orbitNormal
      ? normalizeSpaceVector(rawValue.orbitNormal, { x: 0, y: 1, z: 0 })
      : null,
    orbitSign: toFiniteNumber(rawValue.orbitSign, 1) < 0 ? -1 : 1,
  };
}

function normalizePersistentJSONEntityID(value) {
  const normalized = normalizePersistentEntityID(value);
  return normalized === null ? null : toJSONSafeEntityID(normalized);
}

const INVALID_PERSISTENT_IDENTITY = "invalid-persistent-identity";

function hasPersistentIdentityValue(value) {
  return (
    value !== null &&
    value !== undefined &&
    String(value).trim() !== ""
  );
}

function normalizePersistentJSONEntityIDFailClosed(value) {
  if (!hasPersistentIdentityValue(value)) {
    return null;
  }
  return normalizePersistentJSONEntityID(value) ?? INVALID_PERSISTENT_IDENTITY;
}

function normalizeNonNegativeJSONInt64FailClosed(value) {
  if (!hasPersistentIdentityValue(value)) {
    return null;
  }
  const normalized = normalizeNonNegativeInt64(value);
  return normalized === null
    ? INVALID_PERSISTENT_IDENTITY
    : toJSONSafeEntityID(normalized);
}

function normalizeRuntimeEntityScopeMetadata(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return {};
  }

  const normalized = {};
  for (const key of [
    "airNpeOwnerCharacterID",
    "airNpeOperationID",
    "airNpeInstanceID",
    "abyssalRunID",
    "evejsAbyssalInstanceID",
    "evejsAbyssalPocketInstanceID",
    "abyssalRoomIndex",
    "evejsAbyssalRoomIndex",
    "dungeonSiteID",
    "dungeonSiteInstanceID",
  ]) {
    const value = normalizePersistentJSONEntityIDFailClosed(rawValue[key]);
    if (value !== null) {
      normalized[key] = value;
    }
  }
  for (const key of [
    "airNpeBoardingShipPresentation",
    "airNpeTutorialDebris",
    "airNpeHostile",
    "dungeonMaterializedContainer",
    "dungeonMaterializedSiteContent",
    "dungeonSiteContentBonus",
    "dungeonSiteContentFailureExplodes",
    "dungeonSiteContentFailureNeverDestroys",
    "dungeonSiteContentShowsContents",
    "dungeonSiteContentFailureLocksOut",
    "dungeonSiteContentCompletesSiteOnHack",
    "dungeonSiteContentPersistsAfterResponse",
  ]) {
    if (rawValue[key] === true) {
      normalized[key] = true;
    }
  }
  for (const key of [
    "airNpeHostileWave",
    "dungeonEncounterKey",
    "dungeonSiteContentKey",
    "dungeonSiteContentRole",
    "dungeonSiteContentAnalyzer",
    "dungeonSiteContentTrigger",
    "dungeonSiteContentLootProfile",
    "dungeonSiteContentHackingDifficulty",
    "homefrontKey",
    "homefrontRole",
  ]) {
    const value = String(rawValue[key] == null ? "" : rawValue[key]).trim();
    if (value) {
      normalized[key] = value;
    }
  }
  for (const key of [
    "dungeonSiteContentExplicitLoot",
    "dungeonSiteContentLootTags",
  ]) {
    if (Array.isArray(rawValue[key])) {
      normalized[key] = cloneValue(rawValue[key]);
    }
  }
  const hackingBoard = rawValue.dungeonSiteContentHackingBoard;
  if (hackingBoard && typeof hackingBoard === "object" && !Array.isArray(hackingBoard)) {
    normalized.dungeonSiteContentHackingBoard = cloneValue(hackingBoard);
  }
  return normalized;
}

function normalizeDungeonTrackingState(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return {};
  }
  const normalized = {};
  for (const key of [
    "dungeonCurrentInstanceID",
    "dungeonCurrentDungeonID",
    "dungeonCurrentSiteID",
    "dungeonCompletedNotifiedInstanceID",
  ]) {
    const value = normalizePersistentJSONEntityIDFailClosed(rawValue[key]);
    if (value !== null) {
      normalized[key] = value;
    }
  }
  const roomID = normalizeNonNegativeJSONInt64FailClosed(
    rawValue.dungeonCurrentRoomID,
  );
  if (roomID !== null) {
    normalized.dungeonCurrentRoomID = roomID;
  }
  const roomKey = String(rawValue.dungeonCurrentRoomKey || "").trim();
  if (roomKey) {
    normalized.dungeonCurrentRoomKey = roomKey;
  }
  if (
    Array.isArray(rawValue.dungeonCurrentRoomPosition) &&
    rawValue.dungeonCurrentRoomPosition.length >= 3
  ) {
    normalized.dungeonCurrentRoomPosition = [
      toFiniteNumber(rawValue.dungeonCurrentRoomPosition[0], 0),
      toFiniteNumber(rawValue.dungeonCurrentRoomPosition[1], 0),
      toFiniteNumber(rawValue.dungeonCurrentRoomPosition[2], 0),
    ];
  }
  const updatedAtMs = toFiniteNumber(
    rawValue.dungeonCurrentUpdatedAtMs,
    0,
  );
  if (updatedAtMs > 0) {
    normalized.dungeonCurrentUpdatedAtMs = updatedAtMs;
  }
  return normalized;
}

function normalizeStarbaseFuelState(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }
  const normalizeTimestamp = (value) => {
    const numeric = toNumber(value, 0);
    return numeric > 0 ? numeric : null;
  };
  return {
    version: Math.max(1, toNumber(rawValue.version, 1)),
    active: rawValue.active === true,
    periodMs: Math.max(0, toNumber(rawValue.periodMs, 0)),
    startedAtMs: normalizeTimestamp(rawValue.startedAtMs),
    lastConsumedAtMs: normalizeTimestamp(rawValue.lastConsumedAtMs),
    nextCycleAtMs: normalizeTimestamp(rawValue.nextCycleAtMs),
    exhaustedAtMs: normalizeTimestamp(rawValue.exhaustedAtMs),
    cyclesConsumed: Math.max(0, toNumber(rawValue.cyclesConsumed, 0)),
  };
}

function normalizeSpaceState(storedValue) {
  if (!storedValue || typeof storedValue !== "object") {
    return null;
  }
  // A row an older server saved in warp loads stopped (savedWarpLanding.js).
  const rawValue = convertLegacySavedWarp(storedValue);
  const savedWarpLanding = normalizeSavedWarpLanding(rawValue.savedWarpLanding);

  const normalizedMode = ["GOTO", "FOLLOW", "WARP", "ORBIT", "FIELD"].includes(rawValue.mode)
    ? rawValue.mode
    : "STOP";

  const breacherPodRuntime = require("../../space/combat/breacherPodState")
    .normalizeBreacherPodRuntimeRecord(rawValue.breacherPodRuntime);
  return {
    systemID: toNumber(rawValue.systemID, 0),
    ...(Number(rawValue.orbitalPositionVersion) > 0 ? {
      orbitalPositionVersion: Math.trunc(Number(rawValue.orbitalPositionVersion)),
    } : {}),
    ...(breacherPodRuntime ? { breacherPodRuntime } : {}),
    ...(rawValue.jumpBridgeTransitionReceipt &&
    typeof rawValue.jumpBridgeTransitionReceipt === "object"
      ? {
          jumpBridgeTransitionReceipt: {
            operationID: String(
              rawValue.jumpBridgeTransitionReceipt.operationID || "",
            ),
            shipID: toNumber(rawValue.jumpBridgeTransitionReceipt.shipID, 0),
            sourceStructureID: toNumber(
              rawValue.jumpBridgeTransitionReceipt.sourceStructureID,
              0,
            ),
            destinationStructureID: toNumber(
              rawValue.jumpBridgeTransitionReceipt.destinationStructureID,
              0,
            ),
            destinationSolarSystemID: toNumber(
              rawValue.jumpBridgeTransitionReceipt.destinationSolarSystemID,
              0,
            ),
          },
        }
      : {}),
    position: normalizeSpaceVector(rawValue.position),
    velocity: normalizeSpaceVector(rawValue.velocity),
    direction: normalizeSpaceVector(rawValue.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: rawValue.targetPoint
      ? normalizeSpaceVector(rawValue.targetPoint)
      : null,
    speedFraction: toFiniteNumber(rawValue.speedFraction, 0),
    mode: normalizedMode,
    targetEntityID: rawValue.targetEntityID
      ? toNumber(rawValue.targetEntityID, 0)
      : null,
    followRange: toFiniteNumber(rawValue.followRange, 0),
    orbitDistance: toFiniteNumber(rawValue.orbitDistance, 0),
    orbitNormal: rawValue.orbitNormal
      ? normalizeSpaceVector(rawValue.orbitNormal, { x: 0, y: 1, z: 0 })
      : null,
    orbitSign: toFiniteNumber(rawValue.orbitSign, 1) < 0 ? -1 : 1,
    ...(savedWarpLanding ? { savedWarpLanding } : {}),
    emergencyWarpReturnState: normalizeEmergencyWarpReturnState(
      rawValue.emergencyWarpReturnState,
      toNumber(rawValue.systemID, 0),
    ),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "corporationID")
      ? { corporationID: toNumber(rawValue.corporationID, 0) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "allianceID")
      ? { allianceID: toNumber(rawValue.allianceID, 0) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "warFactionID")
      ? { warFactionID: toNumber(rawValue.warFactionID, 0) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "online")
      ? { online: toNumber(rawValue.online, 0) }
      : {}),
    ...(String(rawValue.onlineState || "").trim()
      ? { onlineState: String(rawValue.onlineState).trim().toLowerCase() }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "onlineStartedAtMs")
      ? {
          onlineStartedAtMs:
            toNumber(rawValue.onlineStartedAtMs, 0) > 0
              ? toNumber(rawValue.onlineStartedAtMs, 0)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "onlineCompletesAtMs")
      ? {
          onlineCompletesAtMs:
            toNumber(rawValue.onlineCompletesAtMs, 0) > 0
              ? toNumber(rawValue.onlineCompletesAtMs, 0)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "posTimerScale")
      ? {
          posTimerScale:
            Number.isFinite(Number(rawValue.posTimerScale)) &&
            Number(rawValue.posTimerScale) > 0
              ? Number(rawValue.posTimerScale)
              : 1,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "destinyHarmonic")
      ? { destinyHarmonic: toNumber(rawValue.destinyHarmonic, -1) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "harmonic")
      ? { harmonic: toNumber(rawValue.harmonic, -1) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "controlTowerID")
      ? {
          controlTowerID:
            toNumber(rawValue.controlTowerID, 0) > 0
              ? toNumber(rawValue.controlTowerID, 0)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "moonID")
      ? {
          moonID:
            toNumber(rawValue.moonID, 0) > 0
              ? toNumber(rawValue.moonID, 0)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "incapacitated")
      ? { incapacitated: toNumber(rawValue.incapacitated, 0) }
      : {}),
    ...(String(rawValue.anchorState || "").trim()
      ? { anchorState: String(rawValue.anchorState).trim().toLowerCase() }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "isAnchored")
      ? {
          isAnchored:
            rawValue.isAnchored === true ||
            rawValue.isAnchored === 1 ||
            rawValue.isAnchored === "1",
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "anchorStartedAtMs")
      ? {
          anchorStartedAtMs:
            toNumber(rawValue.anchorStartedAtMs, 0) > 0
              ? toNumber(rawValue.anchorStartedAtMs, 0)
              : null,
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "anchorCompletesAtMs")
      ? {
          anchorCompletesAtMs:
            toNumber(rawValue.anchorCompletesAtMs, 0) > 0
              ? toNumber(rawValue.anchorCompletesAtMs, 0)
              : null,
        }
      : {}),
    ...(rawValue.starbaseFuelState &&
    typeof rawValue.starbaseFuelState === "object"
      ? { starbaseFuelState: normalizeStarbaseFuelState(rawValue.starbaseFuelState) }
      : {}),
    ...(rawValue.starbaseReinforcementState &&
    typeof rawValue.starbaseReinforcementState === "object"
      ? { starbaseReinforcementState: require("../starbase/starbaseReinforcementRuntime")
          .normalizeReinforcementState(rawValue.starbaseReinforcementState) }
      : {}),
    ...(rawValue.starbaseAccessState &&
    typeof rawValue.starbaseAccessState === "object" &&
    !Array.isArray(rawValue.starbaseAccessState)
      ? { starbaseAccessState: require("../starbase/starbaseAccessRuntime")
          .normalizeStarbaseAccessState(rawValue.starbaseAccessState) }
      : {}),
    ...(String(rawValue.starbaseDisabledReason || "").trim()
      ? { starbaseDisabledReason: String(rawValue.starbaseDisabledReason).trim() }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(rawValue, "starbaseDisabledAtMs")
      ? {
          starbaseDisabledAtMs:
            toNumber(rawValue.starbaseDisabledAtMs, 0) > 0
              ? toNumber(rawValue.starbaseDisabledAtMs, 0)
              : null,
        }
      : {}),
    ...(rawValue.starbaseModuleState &&
    typeof rawValue.starbaseModuleState === "object" &&
    !Array.isArray(rawValue.starbaseModuleState)
      ? { starbaseModuleState: cloneValue(rawValue.starbaseModuleState) }
      : {}),
    ...normalizeRuntimeEntityScopeMetadata(rawValue),
    ...normalizeDungeonTrackingState(rawValue),
  };
}

function buildStoppedSpaceStateForSystem(solarSystemID, existingState = null) {
  const rawState =
    existingState && typeof existingState === "object"
      ? existingState
      : {};
  return normalizeSpaceState({
    ...rawState,
    systemID: toNumber(solarSystemID, rawState.systemID),
    velocity: rawState.velocity || { x: 0, y: 0, z: 0 },
    direction: rawState.direction || { x: 1, y: 0, z: 0 },
    targetPoint: rawState.targetPoint || rawState.position || null,
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: 0,
    orbitDistance: 0,
    orbitNormal: null,
    orbitSign: 1,
  });
}

function normalizeFighterState(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const normalized = {};
  const tubeFlagID = toNumber(rawValue.tubeFlagID, 0);
  const controllerID = toNumber(rawValue.controllerID, 0);
  const controllerOwnerID = toNumber(rawValue.controllerOwnerID, 0);

  if (tubeFlagID > 0) {
    normalized.tubeFlagID = tubeFlagID;
  }
  if (controllerID > 0) {
    normalized.controllerID = controllerID;
  }
  if (controllerOwnerID > 0) {
    normalized.controllerOwnerID = controllerOwnerID;
  }

  const abilityStates = normalizeFighterAbilityStates(rawValue.abilityStates);
  if (abilityStates) {
    normalized.abilityStates = abilityStates;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeFighterAbilitySlotState(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const normalized = {};
  const activeSinceMs = toFiniteNumber(rawValue.activeSinceMs, null);
  const durationMs = toFiniteNumber(rawValue.durationMs, null);
  const activeUntilMs = toFiniteNumber(rawValue.activeUntilMs, null);
  const cooldownStartMs = toFiniteNumber(rawValue.cooldownStartMs, null);
  const cooldownEndMs = toFiniteNumber(rawValue.cooldownEndMs, null);
  const reactivateNotBeforeMs = toFiniteNumber(rawValue.reactivateNotBeforeMs, null);
  const remainingChargeCount = toNumber(rawValue.remainingChargeCount, null);
  const targetID = toNumber(rawValue.targetID, 0);
  const targetPoint =
    rawValue.targetPoint && typeof rawValue.targetPoint === "object"
      ? normalizeSpaceVector(rawValue.targetPoint)
      : null;

  if (activeSinceMs !== null && activeSinceMs >= 0) {
    normalized.activeSinceMs = activeSinceMs;
  }
  if (durationMs !== null && durationMs > 0) {
    normalized.durationMs = durationMs;
  }
  if (activeUntilMs !== null && activeUntilMs >= 0) {
    normalized.activeUntilMs = activeUntilMs;
  }
  if (cooldownStartMs !== null && cooldownStartMs >= 0) {
    normalized.cooldownStartMs = cooldownStartMs;
  }
  if (cooldownEndMs !== null && cooldownEndMs >= 0) {
    normalized.cooldownEndMs = cooldownEndMs;
  }
  if (reactivateNotBeforeMs !== null && reactivateNotBeforeMs >= 0) {
    normalized.reactivateNotBeforeMs = reactivateNotBeforeMs;
  }
  if (remainingChargeCount !== null && remainingChargeCount >= 0) {
    normalized.remainingChargeCount = remainingChargeCount;
  }
  if (rawValue.firedAtActivation === true) {
    normalized.firedAtActivation = true;
  }
  if (targetID > 0) {
    normalized.targetID = targetID;
  }
  if (targetPoint) {
    normalized.targetPoint = targetPoint;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeFighterAbilityStates(rawValue) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const normalized = {};
  for (const [slotID, slotState] of Object.entries(rawValue)) {
    const numericSlotID = toNumber(slotID, -1);
    if (numericSlotID < 0 || numericSlotID > 2) {
      continue;
    }

    const normalizedState = normalizeFighterAbilitySlotState(slotState);
    if (normalizedState) {
      normalized[numericSlotID] = normalizedState;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeShipConditionState(rawValue) {
  const source =
    rawValue && typeof rawValue === "object" ? rawValue : DEFAULT_SHIP_CONDITION_STATE;
  const conditionNumber = (value, fallback) =>
    value === undefined || value === null ? fallback : toFiniteNumber(value, fallback);
  const heat = normalizeStoredRackHeat(source.heat);

  return {
    damage: conditionNumber(source.damage, DEFAULT_SHIP_CONDITION_STATE.damage),
    charge: conditionNumber(source.charge, DEFAULT_SHIP_CONDITION_STATE.charge),
    armorDamage: conditionNumber(
      source.armorDamage,
      DEFAULT_SHIP_CONDITION_STATE.armorDamage,
    ),
    shieldCharge: conditionNumber(
      source.shieldCharge,
      DEFAULT_SHIP_CONDITION_STATE.shieldCharge,
    ),
    incapacitated: Boolean(
      source.incapacitated ?? DEFAULT_SHIP_CONDITION_STATE.incapacitated,
    ),
    // A warm ship's rack heat, kept with it (shipRackHeatState.js). A cold ship
    // has no such part.
    ...(heat ? { heat } : {}),
  };
}

function normalizeSecureContainerState(rawValue) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return null;
  }

  const normalized = cloneValue(rawValue);
  delete normalized.password;
  for (const passwordKey of ["generalPassword", "configPassword"]) {
    if (Object.prototype.hasOwnProperty.call(normalized, passwordKey)) {
      normalized[passwordKey] = String(normalized[passwordKey] || "").slice(0, 16);
    }
  }
  for (const revisionKey of [
    "generalPasswordRevision",
    "configPasswordRevision",
  ]) {
    if (Object.prototype.hasOwnProperty.call(normalized, revisionKey)) {
      normalized[revisionKey] = Math.max(
        0,
        Math.trunc(toNumber(normalized[revisionKey], 0)),
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "alscConfig")) {
    normalized.alscConfig = Math.max(
      0,
      Math.trunc(toNumber(normalized.alscConfig, 0)),
    );
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "anchored")) {
    normalized.anchored = Boolean(normalized.anchored);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "auditLog")) {
    const filetimeEpochOffset = 116444736000000000n;
    const filetimeTicksPerMs = 10000n;
    const retentionMs = 21 * 24 * 60 * 60 * 1000;
    const cutoffFiletime =
      (BigInt(Date.now() - retentionMs) * filetimeTicksPerMs) +
      filetimeEpochOffset;
    const auditLog = [];
    for (const rawEntry of Array.isArray(normalized.auditLog)
      ? normalized.auditLog
      : []) {
      if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        continue;
      }
      let logDate;
      try {
        const rawLogDate =
          rawEntry.logDate &&
          typeof rawEntry.logDate === "object" &&
          Object.prototype.hasOwnProperty.call(rawEntry.logDate, "value")
            ? rawEntry.logDate.value
            : rawEntry.logDate;
        logDate = BigInt(String(rawLogDate || "0"));
      } catch (error) {
        continue;
      }
      const logID = Math.max(0, Math.trunc(toNumber(rawEntry.logID, 0)));
      const actionID = Math.max(
        0,
        Math.trunc(toNumber(rawEntry.actionID, 0)),
      );
      if (logID <= 0 || actionID <= 0 || logDate < cutoffFiletime) {
        continue;
      }
      auditLog.push({
        logID,
        inventoryMgrLocationID: Math.max(
          0,
          Math.trunc(toNumber(rawEntry.inventoryMgrLocationID, 0)),
        ),
        locationID: Math.max(
          0,
          Math.trunc(toNumber(rawEntry.locationID, 0)),
        ),
        flagID: Math.max(0, Math.trunc(toNumber(rawEntry.flagID, 0))),
        actionID,
        arg1: Math.trunc(toNumber(rawEntry.arg1, 0)),
        arg2: Math.trunc(toNumber(rawEntry.arg2, 0)),
        logDate: logDate.toString(),
        actorID: Math.max(
          0,
          Math.trunc(toNumber(rawEntry.actorID, 0)),
        ),
        status: Boolean(rawEntry.status),
      });
    }
    auditLog.sort(
      (left, right) =>
        left.logID - right.logID ||
        String(left.logDate).localeCompare(String(right.logDate)),
    );
    normalized.auditLog = auditLog.slice(-10000);
    const highestLogID = normalized.auditLog.reduce(
      (highest, entry) => Math.max(highest, entry.logID),
      0,
    );
    normalized.nextAuditLogID = Math.max(
      highestLogID + 1,
      Math.trunc(toNumber(normalized.nextAuditLogID, 1)),
      1,
    );
  } else {
    delete normalized.nextAuditLogID;
  }

  return normalized;
}

function normalizeModuleState(rawValue) {
  if (rawValue === undefined) {
    return undefined;
  }

  const source =
    rawValue && typeof rawValue === "object" ? rawValue : DEFAULT_MODULE_STATE;

  const normalizedState = {
    online: Boolean(source.online),
    damage: toFiniteNumber(source.damage, DEFAULT_MODULE_STATE.damage),
    charge: toFiniteNumber(source.charge, DEFAULT_MODULE_STATE.charge),
    skillPoints: toNumber(source.skillPoints, DEFAULT_MODULE_STATE.skillPoints),
    armorDamage: toFiniteNumber(
      source.armorDamage,
      DEFAULT_MODULE_STATE.armorDamage,
    ),
    shieldCharge: toFiniteNumber(
      source.shieldCharge,
      DEFAULT_MODULE_STATE.shieldCharge,
    ),
    incapacitated: Boolean(source.incapacitated),
  };
  for (const key of [
    "serviceFuelOnlineAt",
    "serviceFuelLastCycleAt",
    "serviceFuelNextCycleAt",
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      normalizedState[key] =
        value === null || value === undefined
          ? null
          : toNumber(value, null);
    }
  }
  return normalizedState;
}

function normalizePositiveInteger(value, fallback = 1) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizePositiveSafeInteger(value, fallback = null) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function isStackableInventoryItem(item) {
  // Damaged charges carry individual durability, including older rows that
  // were saved without their singleton flag. Never merge them into clean stock.
  return Boolean(item) && toNumber(item.singleton, 0) === 0 &&
    !(toNumber(item.categoryID, 0) === 8 && toFiniteNumber(item.moduleState?.damage, 0) > 0);
}

// Client convention: singleton 2 marks a blueprint copy. The row carries
// quantity -2 and stacksize 1, and its runs/ME/TE live in industryBlueprintState
// keyed by itemID, so two copies of one blueprint type are never
// interchangeable — and a copy shares its typeID with the original. A copy is
// therefore no more fungible than an assembled singleton and must never be
// picked up by a by-type consumer that would delete the row and strand its
// blueprint state.
function isBlueprintCopyInventoryItem(item) {
  return Boolean(item) && toNumber(item.singleton, 0) === 2;
}

function getStackableItemQuantity(item) {
  if (!item) {
    return 0;
  }
  if (!isStackableInventoryItem(item)) {
    return 1;
  }
  return Math.max(
    0,
    toNumber(item.quantity, 0),
    toNumber(item.stacksize, 0),
  );
}

function splitStackQuantityIntoClientSafeChunks(totalQuantity) {
  const normalizedQuantity = normalizePositiveSafeInteger(totalQuantity, 0);
  if (normalizedQuantity <= 0) {
    return [];
  }

  const chunks = [];
  let remainingQuantity = normalizedQuantity;
  while (remainingQuantity > 0) {
    const chunkQuantity = Math.min(
      remainingQuantity,
      CLIENT_INVENTORY_STACK_LIMIT,
    );
    chunks.push(chunkQuantity);
    remainingQuantity -= chunkQuantity;
  }

  return chunks;
}

function appendStackIndexEntry(stackIndex, item) {
  if (!stackIndex || !isStackableInventoryItem(item)) {
    return;
  }

  const stackKey = buildStackKey(
    item.ownerID,
    item.locationID,
    item.flagID,
    item.typeID,
  );
  let entries = stackIndex.get(stackKey);
  if (!entries) {
    entries = [];
    stackIndex.set(stackKey, entries);
  }

  const existingIndex = entries.findIndex(
    (candidate) => toNumber(candidate && candidate.itemID, 0) === toNumber(item.itemID, 0),
  );
  if (existingIndex >= 0) {
    entries[existingIndex] = item;
  } else {
    entries.push(item);
  }

  entries.sort((left, right) => toNumber(left.itemID, 0) - toNumber(right.itemID, 0));
}

// A grant targets exactly one (ownerID, locationID, flagID), and
// findStackWithAvailableCapacity is only ever asked about that destination --
// only the typeID varies across a grant's entries. So the merge candidates are
// the stackable rows already filed in that one byLocation bucket; building the
// index over the whole items table normalized every row the server holds to
// answer a question about one hangar.
//
// The bucket's entries are the index's own normalized items and are used
// read-only here: applyStackableGrant reads a candidate's quantity and spreads
// it into a fresh buildInventoryItem row, and appendStackIndexEntry replaces
// array slots rather than mutating the items in them.
function buildStackIndexForDestination(ownerID, locationID, flagID) {
  const numericOwnerID = toNumber(ownerID, 0);
  const numericLocationID = toNumber(locationID, 0);
  const numericFlagID = toNumber(flagID, 0);
  const stackIndex = new Map();
  for (const item of ensureItemIndexes().byLocation.get(numericLocationID) || []) {
    if (
      !item ||
      item.locationID !== numericLocationID ||
      item.ownerID !== numericOwnerID ||
      item.flagID !== numericFlagID ||
      !isStackableInventoryItem(item)
    ) {
      continue;
    }
    appendStackIndexEntry(stackIndex, item);
  }
  return stackIndex;
}

function findStackWithAvailableCapacity(
  stackIndex,
  ownerID,
  locationID,
  flagID,
  typeID,
  careerBoundCharacterID = 0,
) {
  const entries = stackIndex.get(
    buildStackKey(ownerID, locationID, flagID, typeID),
  ) || [];
  return entries.find(
    (candidate) => Number(candidate.careerBoundCharacterID || 0) === Number(careerBoundCharacterID || 0) &&
      getStackableItemQuantity(candidate) < CLIENT_INVENTORY_STACK_LIMIT,
  ) || null;
}

function captureItemState(item) {
  if (!item || typeof item !== "object") {
    return {};
  }

  return {
    locationID: item.locationID,
    flagID: item.flagID,
    quantity: item.quantity,
    singleton: item.singleton,
    stacksize: item.stacksize,
    moduleState: Object.prototype.hasOwnProperty.call(item, "moduleState")
      ? cloneValue(item.moduleState)
      : undefined,
  };
}

function getItemMetadata(typeID, name = null) {
  const resolvedTypeID = toNumber(typeID, 0);
  const resolvedItem = resolveItemByTypeID(resolvedTypeID);
  if (resolvedItem) {
    return {
      ...resolvedItem,
      name: resolvedItem.name || name || "Item",
    };
  }

  const resolvedShip = resolveShipByTypeID(resolvedTypeID);
  if (resolvedShip) {
    return {
      ...resolvedShip,
      name: resolvedShip.name || name || "Ship",
      portionSize: 1,
      basePrice: null,
      marketGroupID: null,
      iconID: null,
      soundID: null,
      graphicID: null,
      raceID: null,
    };
  }

  return {
    typeID: resolvedTypeID,
    name: name || "Item",
    groupID: 0,
    categoryID: 0,
    groupName: "",
    mass: null,
    volume: null,
    capacity: null,
    portionSize: 1,
    raceID: null,
    basePrice: null,
    marketGroupID: null,
    iconID: null,
    soundID: null,
    graphicID: null,
    radius: null,
    published: true,
  };
}

function getShipMetadata(typeID, name = null) {
  const resolvedTypeID = toNumber(typeID, DEFAULT_SHIP_TYPE_ID);
  return (
    resolveShipByTypeID(resolvedTypeID) || {
      typeID: resolvedTypeID,
      name: name || "Ship",
      groupID: 25,
      categoryID: SHIP_CATEGORY_ID,
      mass: null,
      volume: null,
      capacity: null,
      radius: null,
    }
  );
}

function shouldItemDefaultToSingleton(metadata) {
  const categoryID = toNumber(metadata && metadata.categoryID, 0);
  return categoryID === SHIP_CATEGORY_ID || categoryID === BLUEPRINT_CATEGORY_ID;
}

function getPackagedVolumeForType(typeID, metadata = null) {
  const numericTypeID = toNumber(typeID, 0);
  if (Object.prototype.hasOwnProperty.call(
    PACKAGED_VOLUME_OVERRIDES_BY_TYPE_ID,
    numericTypeID,
  )) {
    return PACKAGED_VOLUME_OVERRIDES_BY_TYPE_ID[numericTypeID];
  }

  const resolvedMetadata = metadata || getItemMetadata(numericTypeID);
  const groupID = toNumber(resolvedMetadata && resolvedMetadata.groupID, 0);
  if (Object.prototype.hasOwnProperty.call(
    PACKAGED_VOLUME_OVERRIDES_BY_GROUP_ID,
    groupID,
  )) {
    return PACKAGED_VOLUME_OVERRIDES_BY_GROUP_ID[groupID];
  }

  return toFiniteNumber(resolvedMetadata && resolvedMetadata.volume, 0);
}

function getUnitVolumeForPackagingState(metadata, singleton) {
  const resolvedMetadata = metadata || {};
  if (toNumber(singleton, 0) === 0) {
    return getPackagedVolumeForType(resolvedMetadata.typeID, resolvedMetadata);
  }
  return toFiniteNumber(resolvedMetadata.volume, 0);
}

function getInventoryItemUnitVolume(item) {
  if (!item || typeof item !== "object") {
    return 0;
  }
  // The client encodes a singleton Plastic Wrap's volume in hundredths of
  // a cubic metre as a negative quantity, instead of using its type volume.
  if (toNumber(item.typeID, 0) === 3468 && toNumber(item.singleton, 0) > 0) {
    const encodedQuantity = toNumber(item.quantity, 0);
    if (encodedQuantity < 0) return -encodedQuantity / 100;
  }
  const metadata = getItemMetadata(item.typeID, item.itemName);
  const volume = getUnitVolumeForPackagingState(metadata, item.singleton);
  if (volume > 0) {
    return volume;
  }
  return toFiniteNumber(item.volume, 0);
}

function buildInventoryItem({
  itemID,
  typeID,
  ownerID,
  locationID,
  flagID = ITEM_FLAGS.HANGAR,
  itemName = null,
  quantity = null,
  stacksize = null,
  singleton = null,
  customInfo = "",
  spaceState = null,
  conditionState = null,
  moduleState = undefined,
  createdAtMs = null,
  expiresAtMs = null,
  launcherID = null,
  dunRotation = null,
  spaceRadius = null,
  clientCustomInfo = undefined,
  secureContainerState = null,
  mobileDepotState = null,
  stackOriginID = null,
  fighterState = null,
  shipConfiguration = null,
  inventoryCustodyRevision = undefined,
  skinrApplication = null,
  plasticWrapVolume = null,
  careerBoundCharacterID = null,
}) {
  const metadata = getItemMetadata(typeID, itemName);
  const defaultSingleton = shouldItemDefaultToSingleton(metadata) ? 1 : 0;
  const rawSingleton = singleton === null || singleton === undefined
    ? defaultSingleton
    : toNumber(singleton, defaultSingleton);
  const normalizedSingleton = rawSingleton === 2 ? 2 : rawSingleton > 0 ? 1 : 0;
  const normalizedUnits = normalizePositiveInteger(
    quantity === null || quantity === undefined ? stacksize : quantity,
    normalizePositiveInteger(metadata.portionSize, 1),
  );
  const isPlasticWrap = toNumber(metadata.typeID, 0) === 3468 && normalizedSingleton === 1;
  const suppliedWrapVolume = Number(plasticWrapVolume);
  if (isPlasticWrap && plasticWrapVolume !== null &&
      (!Number.isFinite(suppliedWrapVolume) || suppliedWrapVolume < 0 ||
       Math.round(suppliedWrapVolume * 100) > 2147483648)) {
    throw new RangeError("Invalid Plastic Wrap volume");
  }
  const encodedWrapQuantity = isPlasticWrap && plasticWrapVolume !== null &&
    Number.isFinite(suppliedWrapVolume) && suppliedWrapVolume >= 0
    ? -Math.max(1, Math.round(suppliedWrapVolume * 100))
    : isPlasticWrap && Number.isSafeInteger(Number(quantity)) &&
        Number(quantity) < -1 && Number(quantity) >= -2147483648
      ? Number(quantity)
      : null;

  const item = {
    itemID: toNumber(itemID),
    typeID: toNumber(metadata.typeID, 0),
    ownerID: toNumber(ownerID),
    locationID: toNumber(locationID),
    flagID: toNumber(flagID, ITEM_FLAGS.HANGAR),
    quantity:
      encodedWrapQuantity !== null
        ? encodedWrapQuantity
        : normalizedSingleton === 2
        ? -2
        : normalizedSingleton === 1
          ? -1
          : normalizedUnits,
    stacksize: normalizedSingleton > 0 ? 1 : normalizedUnits,
    singleton: normalizedSingleton,
    groupID: toNumber(metadata.groupID, 0),
    categoryID: toNumber(metadata.categoryID, 0),
    customInfo: String(customInfo || ""),
    itemName: itemName || metadata.name || "Item",
    mass: toFiniteNumber(metadata.mass, 0),
    volume: getUnitVolumeForPackagingState(metadata, normalizedSingleton),
    capacity: toFiniteNumber(metadata.capacity, 0),
    radius: toFiniteNumber(metadata.radius, 0),
  };
  if (Number.isSafeInteger(Number(careerBoundCharacterID)) && Number(careerBoundCharacterID) > 0)
    item.careerBoundCharacterID = Number(careerBoundCharacterID);
  if (encodedWrapQuantity !== null) {
    item.plasticWrapVolume = -encodedWrapQuantity / 100;
    item.volume = item.plasticWrapVolume;
  }
  const custodyRevision = normalizeInventoryCustodyRevision(inventoryCustodyRevision);
  if (custodyRevision) item.inventoryCustodyRevision = custodyRevision;
  // Custody reconstructs every moved item through this owner. Binding the
  // application to its character here clears it atomically on owner transfer;
  // a later gift back cannot resurrect an old SKIN. Packaging clears it too.
  if (Number(metadata.categoryID) === 6 && normalizedSingleton === 1 &&
      Number(skinrApplication?.characterID) === item.ownerID && /^[a-f0-9]{64}$/.test(skinrApplication?.hex || "")) {
    item.skinrApplication = { characterID: item.ownerID, hex: skinrApplication.hex };
    const applicationReceiptKey = normalizeIdempotentGrantReceiptKey(skinrApplication.receiptKey);
    if (applicationReceiptKey.startsWith(`skinr-app:${item.ownerID}:`)) item.skinrApplication.receiptKey = applicationReceiptKey;
  }
  const normalizedSpaceState = normalizeSpaceState(spaceState);
  const normalizedModuleState = normalizeModuleState(moduleState);
  const normalizedConditionState =
    conditionState === null || conditionState === undefined
      ? null
      : normalizeShipConditionState(conditionState);
  const normalizedCreatedAtMs = normalizeTimestampMs(createdAtMs);
  const normalizedExpiresAtMs = normalizeTimestampMs(expiresAtMs);
  const normalizedFighterState = normalizeFighterState(fighterState);

  if (normalizedCreatedAtMs !== null) {
    item.createdAtMs = normalizedCreatedAtMs;
  }
  if (normalizedExpiresAtMs !== null) {
    item.expiresAtMs = normalizedExpiresAtMs;
  }
  if (toNumber(launcherID, 0) > 0) {
    item.launcherID = toNumber(launcherID, 0);
  }
  if (toFiniteNumber(spaceRadius, 0) > 0) {
    item.spaceRadius = toFiniteNumber(spaceRadius, 0);
  }
  if (clientCustomInfo !== undefined) {
    item.clientCustomInfo = cloneValue(clientCustomInfo);
  }
  const normalizedSecureContainerState = normalizeSecureContainerState(
    secureContainerState,
  );
  if (normalizedSecureContainerState) {
    item.secureContainerState = normalizedSecureContainerState;
  }
  if (mobileDepotState && typeof mobileDepotState === "object" && !Array.isArray(mobileDepotState)) {
    item.mobileDepotState = cloneValue(mobileDepotState);
  }
  if (toNumber(stackOriginID, 0) > 0) {
    item.stackOriginID = toNumber(stackOriginID, 0);
  }
  const normalizedDunRotation = normalizeDunRotation(dunRotation);
  if (normalizedDunRotation) {
    item.dunRotation = normalizedDunRotation;
  }
  // The fleet-hangar / ship-maintenance-bay access toggles a pilot sets on their
  // own hull. Every read of an item goes through this builder (the byID index is
  // rebuilt from normalizeInventoryItem), so dropping the field here silently
  // reverted every ship to "no fleet or corp access" the moment the row was
  // re-indexed — shipServiceAccess.canUseShipServiceFlag reads it off the item
  // record, so the whole guest-access feature was inert. Carried, not
  // interpreted: shipServiceAccess owns the flag normalization.
  if (
    shipConfiguration &&
    typeof shipConfiguration === "object" &&
    !Array.isArray(shipConfiguration)
  ) {
    item.shipConfiguration = cloneValue(shipConfiguration);
  }

  if (item.categoryID === SHIP_CATEGORY_ID) {
    item.spaceState = normalizedSpaceState;
    item.conditionState = normalizedConditionState || normalizeShipConditionState(null);
    if (item.flagID !== 0) {
      item.spaceState = null;
    }

    return {
      ...item,
      shipID: item.itemID,
      shipTypeID: item.typeID,
      shipName: item.itemName,
    };
  }

  if (item.flagID === 0 && normalizedSpaceState) {
    item.spaceState = normalizedSpaceState;
  }

  if (normalizedConditionState) {
    item.conditionState = normalizedConditionState;
  }

  if (normalizedModuleState !== undefined) {
    item.moduleState = normalizedModuleState;
  }
  if (normalizedFighterState) {
    item.fighterState = normalizedFighterState;
  }

  return item;
}

function buildShipItem({
  itemID,
  typeID,
  ownerID,
  locationID,
  flagID = ITEM_FLAGS.HANGAR,
  itemName = null,
  quantity = null,
  stacksize = 1,
  singleton = null,
  customInfo = "",
  spaceState = null,
  conditionState = null,
  shipConfiguration = null,
}) {
  const metadata = getShipMetadata(typeID, itemName);
  return buildInventoryItem({
    itemID,
    typeID: metadata.typeID,
    ownerID,
    locationID,
    flagID,
    itemName: itemName || metadata.name || "Ship",
    quantity,
    stacksize,
    singleton:
      singleton === null || singleton === undefined ? 1 : singleton,
    customInfo,
    spaceState,
    conditionState,
    shipConfiguration,
  });
}

function normalizeInventoryItem(rawItem, defaults = {}) {
  if (!rawItem || typeof rawItem !== "object") {
    return null;
  }

  const itemID = toNumber(rawItem.itemID ?? rawItem.shipID, 0);
  const typeID = toNumber(rawItem.typeID ?? rawItem.shipTypeID, 0);
  if (itemID <= 0 || typeID <= 0) {
    return null;
  }

  return buildInventoryItem({
    itemID,
    typeID,
    ownerID: rawItem.ownerID ?? defaults.ownerID ?? 0,
    locationID: rawItem.locationID ?? defaults.locationID ?? 0,
    flagID: rawItem.flagID ?? defaults.flagID ?? ITEM_FLAGS.HANGAR,
    itemName: rawItem.itemName ?? rawItem.shipName ?? defaults.itemName ?? null,
    quantity: rawItem.quantity ?? defaults.quantity ?? null,
    stacksize: rawItem.stacksize ?? defaults.stacksize ?? null,
    singleton: rawItem.singleton ?? defaults.singleton ?? null,
    plasticWrapVolume: rawItem.plasticWrapVolume ?? defaults.plasticWrapVolume ?? null,
    customInfo: rawItem.customInfo ?? defaults.customInfo ?? "",
    careerBoundCharacterID: rawItem.careerBoundCharacterID ?? defaults.careerBoundCharacterID ?? null,
    skinrApplication: Object.hasOwn(rawItem, "skinrApplication") ? rawItem.skinrApplication : defaults.skinrApplication,
    spaceState: Object.prototype.hasOwnProperty.call(rawItem, "spaceState")
      ? rawItem.spaceState
      : defaults.spaceState ?? null,
    conditionState: Object.prototype.hasOwnProperty.call(rawItem, "conditionState")
      ? rawItem.conditionState
      : defaults.conditionState ?? null,
    moduleState: Object.prototype.hasOwnProperty.call(rawItem, "moduleState")
      ? rawItem.moduleState
      : defaults.moduleState,
    createdAtMs: Object.prototype.hasOwnProperty.call(rawItem, "createdAtMs")
      ? rawItem.createdAtMs
      : defaults.createdAtMs ?? null,
    expiresAtMs: Object.prototype.hasOwnProperty.call(rawItem, "expiresAtMs")
      ? rawItem.expiresAtMs
      : defaults.expiresAtMs ?? null,
    launcherID: Object.prototype.hasOwnProperty.call(rawItem, "launcherID")
      ? rawItem.launcherID
      : defaults.launcherID ?? null,
    spaceRadius: Object.prototype.hasOwnProperty.call(rawItem, "spaceRadius")
      ? rawItem.spaceRadius
      : defaults.spaceRadius ?? null,
    clientCustomInfo: Object.prototype.hasOwnProperty.call(rawItem, "clientCustomInfo")
      ? rawItem.clientCustomInfo
      : defaults.clientCustomInfo,
    secureContainerState: Object.prototype.hasOwnProperty.call(
      rawItem,
      "secureContainerState",
    )
      ? rawItem.secureContainerState
      : defaults.secureContainerState ?? null,
    mobileDepotState: Object.prototype.hasOwnProperty.call(rawItem, "mobileDepotState")
      ? rawItem.mobileDepotState
      : defaults.mobileDepotState ?? null,
    stackOriginID: Object.prototype.hasOwnProperty.call(rawItem, "stackOriginID")
      ? rawItem.stackOriginID
      : defaults.stackOriginID ?? null,
    dunRotation: Object.prototype.hasOwnProperty.call(rawItem, "dunRotation")
      ? rawItem.dunRotation
      : defaults.dunRotation ?? null,
    fighterState: Object.prototype.hasOwnProperty.call(rawItem, "fighterState")
      ? rawItem.fighterState
      : defaults.fighterState ?? null,
    shipConfiguration: Object.prototype.hasOwnProperty.call(
      rawItem,
      "shipConfiguration",
    )
      ? rawItem.shipConfiguration
      : defaults.shipConfiguration ?? null,
    inventoryCustodyRevision: rawItem.inventoryCustodyRevision ?? defaults.inventoryCustodyRevision,
  });
}

function normalizeShipItem(rawItem, defaults = {}) {
  const normalizedItem = normalizeInventoryItem(rawItem, defaults);
  return normalizedItem && normalizedItem.categoryID === SHIP_CATEGORY_ID
    ? normalizedItem
    : null;
}

function getStructureState() {
  return require(path.join(__dirname, "../structure/structureState"));
}

function getLocalItemIDHighWaterMark(charId, items, characterRecord = null) {
  let maxItemID = toNumber(charId, 0) + 100;
  const record = characterRecord || null;

  if (record && record.shipID && toNumber(record.shipID, 0) > maxItemID) {
    maxItemID = toNumber(record.shipID, maxItemID);
  }

  for (const rawItem of Object.values(items)) {
    const item = normalizeInventoryItem(rawItem);
    if (!item) {
      continue;
    }

    if (item.itemID > maxItemID) {
      maxItemID = item.itemID;
    }
  }

  return maxItemID;
}

function nextItemID(charId, items, characterRecord = null) {
  if (!Array.isArray(reservedItemIDBatch) || reservedItemIDBatch.length <= 0) {
    const localHighWaterMark =
      getLocalItemIDHighWaterMark(charId, items, characterRecord) + 1;
    reservedItemIDBatch = reserveItemIDs(ITEM_ID_RESERVE_BATCH_SIZE, {
      minCandidate: localHighWaterMark,
    });
  }

  const allocatedItemID = toNumber(
    reservedItemIDBatch.shift(),
    0,
  );
  if (allocatedItemID <= 0) {
    return getLocalItemIDHighWaterMark(charId, items, characterRecord) + 1;
  }
  return allocatedItemID;
}

// `items` is the mutation target (a row-overlay plan). `scanSource` is the
// read-only table the candidate sweep walks: nothing is staged when the sweep
// runs, so reading the raw table keeps this boot-time full scan off the overlay.
function repairOversizedStackableItems(items, characters = {}, scanSource = items) {
  let itemsDirty = false;
  const repairs = [];
  const stackableItems = Object.values(scanSource || {})
    .map((rawItem) => normalizeInventoryItem(rawItem))
    .filter((item) => isStackableInventoryItem(item))
    .sort((left, right) => toNumber(left.itemID, 0) - toNumber(right.itemID, 0));

  for (const item of stackableItems) {
    const currentQuantity = getStackableItemQuantity(item);
    if (currentQuantity <= CLIENT_INVENTORY_STACK_LIMIT) {
      continue;
    }

    const chunks = splitStackQuantityIntoClientSafeChunks(currentQuantity);
    if (chunks.length === 0) {
      continue;
    }

    const [primaryChunk, ...overflowChunks] = chunks;
    const updatedPrimary = buildInventoryItem({
      ...item,
      quantity: primaryChunk,
      stacksize: primaryChunk,
      singleton: 0,
    });
    items[String(updatedPrimary.itemID)] = updatedPrimary;

    const ownerRecord = characters[String(toNumber(item.ownerID, 0))] || null;
    const stackOriginID =
      toNumber(item.stackOriginID, 0) > 0
        ? toNumber(item.stackOriginID, 0)
        : toNumber(item.itemID, 0);

    for (const chunkQuantity of overflowChunks) {
      const splitItem = buildInventoryItem({
        ...item,
        itemID: nextItemID(item.ownerID, items, ownerRecord),
        quantity: chunkQuantity,
        stacksize: chunkQuantity,
        singleton: 0,
        stackOriginID,
      });
      items[String(splitItem.itemID)] = splitItem;
    }

    repairs.push({
      itemID: toNumber(item.itemID, 0),
      ownerID: toNumber(item.ownerID, 0),
      typeID: toNumber(item.typeID, 0),
      originalQuantity: currentQuantity,
      resultingStacks: chunks.length,
    });
    itemsDirty = true;
  }

  return {
    itemsDirty,
    repairs,
  };
}

function applyStackableGrant({
  ownerID,
  locationID,
  flagID,
  metadata,
  quantity,
  options = {},
  items,
  stackIndex,
  changes,
  createdItems,
  transientCreatedItemIDs,
  characterRecord = null,
}) {
  let remainingQuantity = quantity;
  let stackTouchCount = 0;
  let splitApplied = false;

  while (remainingQuantity > 0) {
    const existingStack = findStackWithAvailableCapacity(
      stackIndex,
      ownerID,
      locationID,
      flagID,
      metadata.typeID,
      options.careerBoundCharacterID || 0,
    );

    if (existingStack) {
      const currentQuantity = getStackableItemQuantity(existingStack);
      const availableCapacity = Math.max(
        0,
        CLIENT_INVENTORY_STACK_LIMIT - currentQuantity,
      );
      if (availableCapacity > 0) {
        const mergedQuantity = Math.min(remainingQuantity, availableCapacity);
        const previousState = captureItemState(existingStack);
        const rollbackPreviousData = items[String(existingStack.itemID)];
        const updatedItem = buildInventoryItem({
          ...existingStack,
          quantity: currentQuantity + mergedQuantity,
          stacksize: currentQuantity + mergedQuantity,
          singleton: 0,
        });
        items[String(updatedItem.itemID)] = updatedItem;
        appendStackIndexEntry(stackIndex, updatedItem);
        changes.push(withRollbackPreviousData({
          created: false,
          item: cloneValue(updatedItem),
          previousState,
        }, rollbackPreviousData));
        createdItems.push(cloneValue(updatedItem));
        remainingQuantity -= mergedQuantity;
        stackTouchCount += 1;
        splitApplied = splitApplied || remainingQuantity > 0;
        continue;
      }
    }

    const chunkQuantity = Math.min(
      remainingQuantity,
      CLIENT_INVENTORY_STACK_LIMIT,
    );
    const item = buildInventoryItem({
      itemID: nextItemID(ownerID, items, characterRecord),
      typeID: metadata.typeID,
      ownerID,
      locationID,
      flagID,
      itemName: options.itemName || metadata.name,
      quantity: chunkQuantity,
      stacksize: chunkQuantity,
      singleton: 0,
      customInfo: options.customInfo || "",
      careerBoundCharacterID: options.careerBoundCharacterID || null,
      spaceState: options.spaceState || null,
      conditionState: options.conditionState || null,
      moduleState: options.moduleState,
      createdAtMs: options.createdAtMs ?? null,
      expiresAtMs: options.expiresAtMs ?? null,
      launcherID: options.launcherID ?? null,
      dunRotation: options.dunRotation ?? null,
      spaceRadius: options.spaceRadius ?? null,
    });
    items[String(item.itemID)] = item;
    appendStackIndexEntry(stackIndex, item);
    changes.push({
      created: true,
      item: cloneValue(item),
      previousState: {
        locationID: 0,
        flagID: 0,
      },
    });
    createdItems.push(cloneValue(item));
    if (options.transient === true) {
      transientCreatedItemIDs.push(item.itemID);
    }
    remainingQuantity -= chunkQuantity;
    stackTouchCount += 1;
    splitApplied =
      splitApplied ||
      chunkQuantity !== quantity ||
      remainingQuantity > 0;
  }

  return {
    stackTouchCount,
    splitApplied,
  };
}

// One-time data-integrity pass run lazily on first ItemStore access. The legacy
// character→items ship migration (storedShips promotion, starter-ship backfill)
// has been retired: live records are normalized by characterState, imports write
// ship rows straight into the items table, and ships are provisioned on demand by
// ensureCharacterActiveShipItem(). All that remains here is repairing any
// oversized stackable items into client-safe stacks.
function ensureMigrated() {
  if (migrationComplete) {
    return;
  }

  const characters = readCharacters();
  const rawItems = readItems();
  const mutationPlan = createItemRowMutationPlan();
  let itemsDirty = false;

  const stackRepairResult = repairOversizedStackableItems(
    mutationPlan.items,
    characters,
    rawItems,
  );
  if (stackRepairResult.itemsDirty) {
    itemsDirty = true;
    for (const repair of stackRepairResult.repairs) {
      log.info(
        `[ItemStore] Repaired oversized stack item=${repair.itemID} owner=${repair.ownerID} type=${repair.typeID} quantity=${repair.originalQuantity} into ${repair.resultingStacks} client-safe stacks`,
      );
    }
  }

  if (itemsDirty && !mutationPlan.commit()) {
    log.warn("[ItemStore] Failed to persist repaired items table");
  }

  migrationComplete = true;
}

function getAllItems() {
  ensureMigrated();
  return cloneValue(readItems());
}

// The rows of the items table the predicate accepts, cloned. Only the matches are
// copied: getAllItems() deep-clones every row, which is seconds of blocked event loop
// for a caller that wants a handful of them. The predicate sees the live row and must
// not modify it.
function listItemsMatching(predicate) {
  ensureMigrated();
  const matches = [];
  for (const item of Object.values(readItems())) {
    if (predicate(item)) {
      matches.push(cloneValue(item));
    }
  }
  return matches;
}

// Starbase structures and force fields are the only rows in the starbase index.
// These answer "is this a starbase item" in O(1) without copying the row, so
// starbase-only checks on ordinary inventory paths cost nothing for other items.
function isStarbaseItemID(itemID) {
  const numericItemID = toNumber(itemID, 0);
  return numericItemID > 0 && ensureItemIndexes().starbase.byID.has(numericItemID);
}

function findStarbaseItemById(itemID) {
  return isStarbaseItemID(itemID) ? findItemById(itemID) : null;
}

// Optional exact filters: systemID, controlTowerID, groupID, typeID, ownerID.
// Only matching POS rows are cloned; no whole-table copy or non-POS scan.
// State, physical deployment and access checks remain the caller's authority.
function listStarbaseItems(options = {}) {
  return [...ensureItemIndexes().starbase.query({ ...options, categoryID: 23 })]
    .sort((left, right) => left.itemID - right.itemID)
    .map((item) => cloneValue(item));
}

function hasStarbaseItems(options = {}) {
  return !ensureItemIndexes().starbase.query({ ...options, categoryID: 23 }).next().done;
}

function listStarbaseForceFieldItems(options = {}) {
  return [...ensureItemIndexes().starbase.query({ ...options, groupID: 411 })]
    .sort((left, right) => left.itemID - right.itemID)
    .map((item) => cloneValue(item));
}

function listOwnedItems(ownerId, options = {}) {
  ensureMigrated();
  const numericOwnerId = toNumber(ownerId, 0);
  const locationID =
    options.locationID === undefined || options.locationID === null
      ? null
      : toNumber(options.locationID, 0);
  const flagID =
    options.flagID === undefined || options.flagID === null
      ? null
      : toNumber(options.flagID, ITEM_FLAGS.HANGAR);
  const categoryID =
    options.categoryID === undefined || options.categoryID === null
      ? null
      : toNumber(options.categoryID, 0);
  const typeID =
    options.typeID === undefined || options.typeID === null
      ? null
      : toNumber(options.typeID, 0);

  return (ensureItemIndexes().byOwner.get(numericOwnerId) || [])
    .filter(
      (entry) =>
        entry &&
        (locationID === null || entry.locationID === locationID) &&
        (flagID === null || entry.flagID === flagID) &&
        (categoryID === null || entry.categoryID === categoryID) &&
        (typeID === null || entry.typeID === typeID),
    )
    .map((entry) => cloneValue(entry));
}

function listCharacterItems(charId, options = {}) {
  return listOwnedItems(charId, options);
}

function listCharacterShipItems(charId, options = {}) {
  return listCharacterItems(charId, {
    ...options,
    categoryID: SHIP_CATEGORY_ID,
  });
}

function getCharacterShipItems(charId) {
  return listCharacterShipItems(charId);
}

function getCharacterHangarShipItems(charId, stationId) {
  return listCharacterShipItems(charId, {
    locationID: stationId,
    flagID: ITEM_FLAGS.HANGAR,
  });
}

// Resolve one ship by identity, not by listing. Going through
// listCharacterShipItems() walked the character's whole byOwner bucket -- every
// item they own, at every station -- and deep-cloned every ship in it, only to
// keep the single row whose itemID was already known. byID answers the same
// question in one map hit, exactly as findShipItemById() below already does;
// the owner and category tests that made the listing correct are kept here, so
// a ship belonging to someone else, or a non-ship item, still resolves to null.
function findCharacterShipItem(charId, shipId) {
  const numericShipId = toNumber(shipId, 0);
  if (numericShipId <= 0) {
    return null;
  }

  const numericCharId = toNumber(charId, 0);
  const entry = ensureItemIndexes().byID.get(numericShipId) || null;
  return entry &&
    entry.ownerID === numericCharId &&
    entry.categoryID === SHIP_CATEGORY_ID
    ? cloneValue(entry)
    : null;
}

function findShipItemById(shipId) {
  const numericShipId = toNumber(shipId, 0);
  if (numericShipId <= 0) {
    return null;
  }

  const entry = ensureItemIndexes().byID.get(numericShipId) || null;
  return entry && entry.categoryID === SHIP_CATEGORY_ID ? cloneValue(entry) : null;
}

function findItemById(itemId) {
  const numericItemId = toNumber(itemId, 0);
  if (numericItemId <= 0) {
    return null;
  }

  const entry = ensureItemIndexes().byID.get(numericItemId) || null;
  return entry ? cloneValue(entry) : null;
}

function findCharacterShipByType(charId, typeId, stationId = null) {
  const numericTypeId = toNumber(typeId, 0);
  if (numericTypeId <= 0) {
    return null;
  }

  const ships =
    stationId === null || stationId === undefined
      ? listCharacterShipItems(charId)
      : getCharacterHangarShipItems(charId, stationId);

  return ships.find((entry) => entry.typeID === numericTypeId) || null;
}

function isCapsuleTypeID(typeID) {
  const numericTypeID = toNumber(typeID, 0);
  return numericTypeID === CAPSULE_TYPE_ID || numericTypeID === CAPSULE_TYPE_ID_GOLDEN;
}

function findCharacterCapsule(charId, stationId = null) {
  const ships =
    stationId === null || stationId === undefined
      ? listCharacterShipItems(charId)
      : getCharacterHangarShipItems(charId, stationId);

  return ships.find((entry) => isCapsuleTypeID(entry.typeID)) || null;
}

function getShipSpaceRecordParts(shipItem) {
  return {
    locationID: toNumber(shipItem && shipItem.locationID, 0),
    flagID: toNumber(shipItem && shipItem.flagID, ITEM_FLAGS.HANGAR),
    stateSystemID: toNumber(
      shipItem && shipItem.spaceState && shipItem.spaceState.systemID,
      0,
    ),
  };
}

function isCoherentSpaceShipRecord(shipItem) {
  const { locationID, flagID, stateSystemID } = getShipSpaceRecordParts(shipItem);
  return (
    flagID === 0 &&
    locationID > 0 &&
    stateSystemID > 0 &&
    locationID === stateSystemID
  );
}

function isDockedShipRecord(shipItem) {
  const { locationID, flagID } = getShipSpaceRecordParts(shipItem);
  if (flagID !== ITEM_FLAGS.HANGAR || locationID <= 0) {
    return false;
  }
  if (worldData.getStationByID(locationID)) {
    return true;
  }
  const structure = getStructureState().getStructureByID(locationID, {
    refresh: false,
  });
  return Boolean(structure);
}

function isEligibleActiveShipRecord(shipItem) {
  const flagID = toNumber(shipItem && shipItem.flagID, ITEM_FLAGS.HANGAR);
  return flagID === 0 || flagID === ITEM_FLAGS.HANGAR;
}

function resolveActiveShipSpaceRepairSystemID(shipItem, solarSystemID) {
  if (!shipItem) {
    return 0;
  }
  if (isDockedShipRecord(shipItem)) {
    return 0;
  }
  const { locationID, flagID, stateSystemID } = getShipSpaceRecordParts(shipItem);

  if (flagID === 0) {
    if (locationID > 0 && stateSystemID > 0) {
      if (locationID === stateSystemID) {
        return 0;
      }
      if (
        hasPositiveLocationID(solarSystemID) &&
        (toNumber(solarSystemID, 0) === locationID ||
          toNumber(solarSystemID, 0) === stateSystemID)
      ) {
        return toNumber(solarSystemID, 0);
      }
      return stateSystemID;
    }
    if (locationID > 0) {
      return locationID;
    }
    if (stateSystemID > 0) {
      return stateSystemID;
    }
  }

  if (hasPositiveLocationID(solarSystemID)) {
    return toNumber(solarSystemID, 0);
  }

  return 0;
}

function activeShipNeedsSpaceRecordRepair(shipItem, solarSystemID) {
  if (!shipItem) {
    return false;
  }
  return resolveActiveShipSpaceRepairSystemID(shipItem, solarSystemID) > 0;
}

function repairActiveShipToSpaceRecord(charId, shipItem, solarSystemID) {
  const repairSystemID = resolveActiveShipSpaceRepairSystemID(
    shipItem,
    solarSystemID,
  );
  if (!shipItem || repairSystemID <= 0) {
    return shipItem;
  }
  const { locationID, flagID, stateSystemID } = getShipSpaceRecordParts(shipItem);

  const moveResult = moveShipToSpace(
    shipItem.itemID,
    repairSystemID,
    buildStoppedSpaceStateForSystem(repairSystemID, shipItem.spaceState),
  );
  if (!moveResult.success) {
    log.warn(
      `[ItemStore] Failed to repair in-space active ship for char=${charId} ` +
        `ship=${shipItem.itemID} system=${repairSystemID}: ${moveResult.errorMsg}`,
    );
    return shipItem;
  }

  log.info(
    `[ItemStore] Repaired in-space active ship for char=${charId} ` +
      `ship=${shipItem.itemID} system=${repairSystemID} ` +
      `location=${locationID} flag=${flagID} stateSystem=${stateSystemID}`,
  );
  return cloneValue(moveResult.data || shipItem);
}

function ensureCharacterActiveShipItem(charId, existingRecord = null) {
  ensureMigrated();

  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return null;
  }

  const characters = readCharacters();
  const record = existingRecord || characters[String(numericCharId)];
  if (!record) {
    return null;
  }
  if (record.isDeleted === true || record.accountId === null) {
    return null;
  }

  const recordStationID = toNumber(record.stationID ?? record.stationid, 0);
  const recordStructureID = toNumber(record.structureID ?? record.structureid, 0);
  const recordSolarSystemID = toNumber(
    record.solarSystemID ??
      record.solarsystemID ??
      record.solarsystemid ??
      record.solarSystemId,
    0,
  );
  const recordIsInSpace =
    recordSolarSystemID > 0 && recordStationID <= 0 && recordStructureID <= 0;

  const activeShip = findCharacterShipItem(numericCharId, record.shipID);
  if (activeShip && isEligibleActiveShipRecord(activeShip)) {
    if (
      recordIsInSpace &&
      activeShipNeedsSpaceRecordRepair(activeShip, recordSolarSystemID)
    ) {
      return repairActiveShipToSpaceRecord(
        numericCharId,
        activeShip,
        recordSolarSystemID,
      );
    }
    return activeShip;
  }

  // A pending docked clone death owns replacement provisioning. Ordinary read
  // repair must not board another owned hull or mint a capsule at the origin.
  if (record.homeStationSelfDestruct && record.homeStationSelfDestruct.state !== "completed") {
    return null;
  }

  if (activeShip) {
    log.info(
      `[ItemStore] Replacing unsupported active ship for char=${numericCharId} ` +
        `ship=${activeShip.itemID} flag=${toNumber(activeShip.flagID, 0)}`,
    );
  }

  const ownedShips = listCharacterShipItems(numericCharId)
    .filter(isEligibleActiveShipRecord);
  if (ownedShips.length > 0) {
    let repairedShip = recordIsInSpace
      ? ownedShips.find(
          (ship) =>
            isCoherentSpaceShipRecord(ship) &&
            toNumber(ship.locationID, 0) === recordSolarSystemID,
        ) || ownedShips.find(
          (ship) => isCoherentSpaceShipRecord(ship),
        ) || ownedShips.find(
          (ship) =>
            toNumber(ship.locationID, 0) === recordSolarSystemID ||
            toNumber(ship.spaceState && ship.spaceState.systemID, 0) ===
              recordSolarSystemID,
        ) || ownedShips[0]
      : ownedShips[0];
    if (
      recordIsInSpace &&
      activeShipNeedsSpaceRecordRepair(repairedShip, recordSolarSystemID)
    ) {
      repairedShip = repairActiveShipToSpaceRecord(
        numericCharId,
        repairedShip,
        recordSolarSystemID,
      );
    }
    const syncResult = syncCharacterActiveShip(numericCharId, repairedShip);
    if (!syncResult.success) {
      log.warn(
        `[ItemStore] Failed to repair active ship for char=${numericCharId} from owned ship=${repairedShip.itemID}`,
      );
    } else {
      log.info(
        `[ItemStore] Repaired active ship for char=${numericCharId} -> ship=${repairedShip.itemID}`,
      );
    }
    return repairedShip;
  }

  if (recordIsInSpace) {
    const mutationPlan = createItemRowMutationPlan();
    const items = mutationPlan.items;
    const starterShip = buildShipItem({
      itemID: nextItemID(numericCharId, items, record),
      typeID: record.shipTypeID || DEFAULT_SHIP_TYPE_ID,
      ownerID: numericCharId,
      locationID: recordSolarSystemID,
      flagID: 0,
      itemName: record.shipName || null,
      spaceState: buildStoppedSpaceStateForSystem(recordSolarSystemID),
    });

    items[String(starterShip.itemID)] = starterShip;
    if (!mutationPlan.commit({ indexDelta: { upsertedIDs: [starterShip.itemID] } })) {
      log.warn(
        `[ItemStore] Failed to provision in-space starter ship for char=${numericCharId}`,
      );
      return null;
    }

    const syncResult = syncCharacterActiveShip(numericCharId, starterShip);
    if (!syncResult.success) {
      log.warn(
        `[ItemStore] Provisioned in-space starter ship=${starterShip.itemID} ` +
          `for char=${numericCharId} but failed to sync character record`,
      );
    } else {
      log.info(
        `[ItemStore] Provisioned in-space starter ship for char=${numericCharId} ` +
          `system=${recordSolarSystemID} -> ship=${starterShip.itemID}`,
      );
    }

    return cloneValue(starterShip);
  }

  const dockedLocationID = recordStationID || recordStructureID || 60003760;
  try {
    const {
      getStarterShipFitting,
    } = require(path.join(__dirname, "../ship/starterShipFittingState"));
    const starterShipFitting = getStarterShipFitting(record.shipTypeID);
    if (starterShipFitting) {
      const {
      spawnRookieShipForCharacter,
      } = require(path.join(__dirname, "../ship/rookieShipRuntime"));
      const rookieShipResult = spawnRookieShipForCharacter(
        numericCharId,
        dockedLocationID,
        {
          characterRecord: record,
          shipTypeID: toNumber(record.shipTypeID, DEFAULT_SHIP_TYPE_ID),
          shipName: record.shipName || null,
          preferExplicitShipType: true,
          setActiveShip: true,
          logLabel: "EnsureCharacterActiveShipItem",
        },
      );
      if (rookieShipResult.success && rookieShipResult.data && rookieShipResult.data.ship) {
        return cloneValue(rookieShipResult.data.ship);
      }
      const writeLog =
        rookieShipResult.errorMsg === "INVALID_ROOKIE_SHIP_REQUEST"
          ? log.debug
          : log.warn;
      writeLog(
        `[ItemStore] Failed to provision rookie ship for char=${numericCharId} error=${rookieShipResult.errorMsg}`,
      );
    }
  } catch (error) {
    log.warn(
      `[ItemStore] Failed to provision rookie ship for char=${numericCharId}: ${error.message}`,
    );
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const starterShip = buildShipItem({
    itemID: nextItemID(numericCharId, items, record),
    typeID: record.shipTypeID || DEFAULT_SHIP_TYPE_ID,
    ownerID: numericCharId,
    locationID: dockedLocationID,
    flagID: ITEM_FLAGS.HANGAR,
    itemName: record.shipName || null,
  });

  items[String(starterShip.itemID)] = starterShip;
  if (!mutationPlan.commit({ indexDelta: { upsertedIDs: [starterShip.itemID] } })) {
    log.warn(
      `[ItemStore] Failed to provision starter ship for char=${numericCharId}`,
    );
    return null;
  }

  const syncResult = syncCharacterActiveShip(numericCharId, starterShip);
  if (!syncResult.success) {
    log.warn(
      `[ItemStore] Provisioned starter ship=${starterShip.itemID} for char=${numericCharId} but failed to sync character record`,
    );
  } else {
    log.info(
      `[ItemStore] Provisioned starter ship for char=${numericCharId} -> ship=${starterShip.itemID}`,
    );
  }

  return cloneValue(starterShip);
}

function getActiveShipItem(charId) {
  return ensureCharacterActiveShipItem(charId);
}

function syncCharacterActiveShip(charId, shipItem) {
  ensureMigrated();
  const characters = readCharacters();
  const record = characters[String(charId)];
  if (!record || !shipItem) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const nextRecord = {
    ...record,
    shipID: shipItem.itemID,
    shipTypeID: shipItem.typeID,
    shipName: shipItem.itemName,
  };

  if (Object.prototype.hasOwnProperty.call(nextRecord, "storedShips")) {
    delete nextRecord.storedShips;
  }

  // Phase 0: persist the single updated character record through its owner
  // (characterState) instead of mutating the whole characters map and writing
  // the table directly. Lazy require avoids the characterState->itemStore cycle.
  const writeResult = require("../character/characterState").writeCharacterRecord(
    charId,
    nextRecord,
  );
  if (!writeResult.success) {
    return {
      success: false,
      errorMsg: writeResult.errorMsg || "WRITE_ERROR",
    };
  }

  return {
    success: true,
    data: nextRecord,
  };
}

function resolveItemTypeReference(itemType) {
  if (itemType && typeof itemType === "object" && itemType.typeID) {
    return getItemMetadata(itemType.typeID, itemType.name || itemType.itemName || null);
  }

  return getItemMetadata(itemType);
}

function buildStackKey(ownerID, locationID, flagID, typeID) {
  return [
    toNumber(ownerID, 0),
    toNumber(locationID, 0),
    toNumber(flagID, ITEM_FLAGS.HANGAR),
    toNumber(typeID, 0),
  ].join(":");
}

// Validate every grant entry BEFORE the mutation loop runs. Both grant paths
// write each created item straight into the shared items cache as they iterate;
// if a later entry failed validation and the function returned early, the
// earlier entries would already be in the cache with no matching writeItems() —
// stranding un-indexed, un-persisted rows that silently drift the item index
// (and later flush to the DB as phantoms). Fail the whole batch up front so the
// cache is only ever touched once the entire grant is known-good.
function validateGrantEntries(entries) {
  for (const entry of entries) {
    const metadata = resolveItemTypeReference(entry.itemType);
    if (
      !metadata ||
      !Number.isInteger(toNumber(metadata.typeID, 0)) ||
      metadata.typeID <= 0
    ) {
      return { success: false, errorMsg: "ITEM_TYPE_NOT_FOUND" };
    }
    if (!normalizePositiveSafeInteger(entry.quantity, null)) {
      return { success: false, errorMsg: "ITEM_QUANTITY_OUT_OF_RANGE" };
    }
  }
  return null;
}

function grantItemsToCharacterLocation(
  charId,
  locationId,
  flagId,
  grantEntries = [],
) {
  ensureMigrated();
  const characters = readCharacters();
  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const record = characters[String(charId)];
  if (!record) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const entries = Array.isArray(grantEntries)
    ? grantEntries.filter(Boolean)
    : [];
  if (entries.length === 0) {
    return {
      success: true,
      data: {
        quantity: 0,
        items: [],
        changes: [],
        grantedEntries: [],
      },
    };
  }

  const numericLocationId = toNumber(locationId, 0);
  const numericFlagId = toNumber(flagId, ITEM_FLAGS.HANGAR);
  const changes = [];
  const createdItems = [];
  const grantedEntries = [];
  const transientCreatedItemIDs = [];
  const entryValidationError = validateGrantEntries(entries);
  if (entryValidationError) {
    return entryValidationError;
  }
  // Nothing is staged yet, so the stack sweep reads the live index: the overlay
  // only has to carry the handful of rows this grant actually touches.
  const stackIndex = buildStackIndexForDestination(
    charId,
    numericLocationId,
    numericFlagId,
  );
  let stackSplitApplied = false;
  let stackSplitStackCount = 0;

  for (const entry of entries) {
    const metadata = resolveItemTypeReference(entry.itemType);
    if (!metadata || !Number.isInteger(toNumber(metadata.typeID, 0)) || metadata.typeID <= 0) {
      return {
        success: false,
        errorMsg: "ITEM_TYPE_NOT_FOUND",
      };
    }

    const normalizedQuantity = normalizePositiveSafeInteger(entry.quantity, null);
    if (!normalizedQuantity) {
      return {
        success: false,
        errorMsg: "ITEM_QUANTITY_OUT_OF_RANGE",
      };
    }
    const options =
      entry.options && typeof entry.options === "object"
        ? entry.options
        : {};
    const singletonMode =
      options.individualItems === true ||
      (options.singleton === undefined || options.singleton === null
        ? shouldItemDefaultToSingleton(metadata)
        : toNumber(options.singleton, 0) > 0);
    const resolvedSingleton =
      options.singleton !== undefined && options.singleton !== null
        ? toNumber(options.singleton, 1)
        : 1;

    if (singletonMode) {
      for (let index = 0; index < normalizedQuantity; index += 1) {
        const item = buildInventoryItem({
          itemID: nextItemID(charId, items, record),
          typeID: metadata.typeID,
          ownerID: charId,
          locationID: numericLocationId,
          flagID: numericFlagId,
          itemName: options.itemName || metadata.name,
          singleton: resolvedSingleton,
          plasticWrapVolume: options.plasticWrapVolume ?? null,
          customInfo: options.customInfo || "",
          careerBoundCharacterID: options.careerBoundCharacterID || null,
          spaceState: options.spaceState || null,
          conditionState: options.conditionState || null,
          moduleState: options.moduleState,
          createdAtMs: options.createdAtMs ?? null,
          expiresAtMs: options.expiresAtMs ?? null,
          launcherID: options.launcherID ?? null,
          dunRotation: options.dunRotation ?? null,
          spaceRadius: options.spaceRadius ?? null,
        });

        items[String(item.itemID)] = item;
        changes.push({
          created: true,
          item: cloneValue(item),
          previousState: {
            locationID: 0,
            flagID: 0,
          },
        });
        createdItems.push(cloneValue(item));
        if (options.transient === true) {
          transientCreatedItemIDs.push(item.itemID);
        }
      }
    } else {
      const stackGrantResult = applyStackableGrant({
        ownerID: charId,
        locationID: numericLocationId,
        flagID: numericFlagId,
        metadata,
        quantity: normalizedQuantity,
        options,
        items,
        stackIndex,
        changes,
        createdItems,
        transientCreatedItemIDs,
        characterRecord: record,
      });
      stackSplitApplied = stackSplitApplied || stackGrantResult.splitApplied;
      stackSplitStackCount += stackGrantResult.stackTouchCount;
    }

    grantedEntries.push({
      itemType: cloneValue(metadata),
      quantity: normalizedQuantity,
    });
  }

  const attachedReceipt = attachIdempotentGrantReceiptForEntries(
    items,
    entries,
    collectReceiptItemIDs(changes),
  );
  if (!mutationPlan.commit({
    indexDelta: indexDeltaFromChanges(changes),
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  if (transientCreatedItemIDs.length > 0) {
    for (const itemID of transientCreatedItemIDs) {
      repo.setTransientPath(ITEMS_TABLE, `/${String(itemID)}`, true);
    }
  }

  const singleEntry = entries.length === 1 ? grantedEntries[0] || null : null;
  return {
    success: true,
    data: {
      itemType: singleEntry ? singleEntry.itemType : null,
      quantity: singleEntry ? singleEntry.quantity : grantedEntries.reduce(
        (sum, entry) => sum + entry.quantity,
        0,
      ),
      items: createdItems,
      changes,
      grantedEntries,
      stackSplitApplied,
      stackSplitStackCount,
    },
  };
}

function grantItemToCharacterLocation(
  charId,
  locationId,
  flagId,
  itemType,
  quantity = 1,
  options = {},
) {
  return grantItemsToCharacterLocation(
    charId,
    locationId,
    flagId,
    [{
      itemType,
      quantity,
      options,
    }],
  );
}

function grantItemToCharacterStationHangar(charId, stationId, itemType, quantity = 1, options = {}) {
  return grantItemToCharacterLocation(
    charId,
    stationId,
    ITEM_FLAGS.HANGAR,
    itemType,
    quantity,
    options,
  );
}

function grantItemsToCharacterStationHangar(charId, stationId, grantEntries = []) {
  return grantItemsToCharacterLocation(
    charId,
    stationId,
    ITEM_FLAGS.HANGAR,
    grantEntries,
  );
}

function grantItemsToOwnerLocation(
  ownerId,
  locationId,
  flagId,
  grantEntries = [],
) {
  ensureMigrated();
  const numericOwnerId = toNumber(ownerId, 0);
  if (numericOwnerId <= 0) {
    return {
      success: false,
      errorMsg: "OWNER_NOT_FOUND",
    };
  }

  const characters = readCharacters();
  if (characters[String(numericOwnerId)]) {
    return grantItemsToCharacterLocation(
      numericOwnerId,
      locationId,
      flagId,
      grantEntries,
    );
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const entries = Array.isArray(grantEntries)
    ? grantEntries.filter(Boolean)
    : [];
  if (entries.length === 0) {
    return {
      success: true,
      data: {
        quantity: 0,
        items: [],
        changes: [],
        grantedEntries: [],
      },
    };
  }

  const numericLocationId = toNumber(locationId, 0);
  const numericFlagId = toNumber(flagId, ITEM_FLAGS.HANGAR);
  const changes = [];
  const createdItems = [];
  const grantedEntries = [];
  const transientCreatedItemIDs = [];
  const entryValidationError = validateGrantEntries(entries);
  if (entryValidationError) {
    return entryValidationError;
  }
  // Nothing is staged yet, so the stack sweep reads the live index: the overlay
  // only has to carry the handful of rows this grant actually touches.
  const stackIndex = buildStackIndexForDestination(
    numericOwnerId,
    numericLocationId,
    numericFlagId,
  );
  let stackSplitApplied = false;
  let stackSplitStackCount = 0;

  for (const entry of entries) {
    const metadata = resolveItemTypeReference(entry.itemType);
    if (!metadata || !Number.isInteger(toNumber(metadata.typeID, 0)) || metadata.typeID <= 0) {
      return {
        success: false,
        errorMsg: "ITEM_TYPE_NOT_FOUND",
      };
    }

    const normalizedQuantity = normalizePositiveSafeInteger(entry.quantity, null);
    if (!normalizedQuantity) {
      return {
        success: false,
        errorMsg: "ITEM_QUANTITY_OUT_OF_RANGE",
      };
    }
    const options =
      entry.options && typeof entry.options === "object"
        ? entry.options
        : {};
    const singletonMode =
      options.singleton === undefined || options.singleton === null
        ? shouldItemDefaultToSingleton(metadata)
        : toNumber(options.singleton, 0) > 0;
    const resolvedSingleton =
      options.singleton !== undefined && options.singleton !== null
        ? toNumber(options.singleton, 1)
        : 1;

    if (singletonMode) {
      for (let index = 0; index < normalizedQuantity; index += 1) {
        const item = buildInventoryItem({
          itemID: nextItemID(
            numericOwnerId,
            items,
            characters[String(numericOwnerId)] || null,
          ),
          typeID: metadata.typeID,
          ownerID: numericOwnerId,
          locationID: numericLocationId,
          flagID: numericFlagId,
          itemName: options.itemName || metadata.name,
          singleton: resolvedSingleton,
          plasticWrapVolume: options.plasticWrapVolume ?? null,
          customInfo: options.customInfo || "",
          careerBoundCharacterID: options.careerBoundCharacterID || null,
          spaceState: options.spaceState || null,
          conditionState: options.conditionState || null,
          moduleState: options.moduleState,
          createdAtMs: options.createdAtMs ?? null,
          expiresAtMs: options.expiresAtMs ?? null,
          launcherID: options.launcherID ?? null,
          dunRotation: options.dunRotation ?? null,
          spaceRadius: options.spaceRadius ?? null,
        });

        items[String(item.itemID)] = item;
        changes.push({
          created: true,
          item: cloneValue(item),
          previousState: {
            locationID: 0,
            flagID: 0,
          },
        });
        createdItems.push(cloneValue(item));
        if (options.transient === true) {
          transientCreatedItemIDs.push(item.itemID);
        }
      }
    } else {
      const stackGrantResult = applyStackableGrant({
        ownerID: numericOwnerId,
        locationID: numericLocationId,
        flagID: numericFlagId,
        metadata,
        quantity: normalizedQuantity,
        options,
        items,
        stackIndex,
        changes,
        createdItems,
        transientCreatedItemIDs,
        characterRecord: characters[String(numericOwnerId)] || null,
      });
      stackSplitApplied = stackSplitApplied || stackGrantResult.splitApplied;
      stackSplitStackCount += stackGrantResult.stackTouchCount;
    }

    grantedEntries.push({
      itemType: cloneValue(metadata),
      quantity: normalizedQuantity,
    });
  }

  const attachedReceipt = attachIdempotentGrantReceiptForEntries(
    items,
    entries,
    collectReceiptItemIDs(changes),
  );
  if (!mutationPlan.commit({
    indexDelta: indexDeltaFromChanges(changes),
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  if (transientCreatedItemIDs.length > 0) {
    for (const itemID of transientCreatedItemIDs) {
      repo.setTransientPath(ITEMS_TABLE, `/${String(itemID)}`, true);
    }
  }

  const singleEntry = entries.length === 1 ? grantedEntries[0] || null : null;
  return {
    success: true,
    data: {
      itemType: singleEntry ? singleEntry.itemType : null,
      quantity: singleEntry ? singleEntry.quantity : grantedEntries.reduce(
        (sum, item) => sum + item.quantity,
        0,
      ),
      items: createdItems,
      changes,
      grantedEntries,
      stackSplitApplied,
      stackSplitStackCount,
    },
  };
}

function grantItemToOwnerLocation(
  ownerId,
  locationId,
  flagId,
  itemType,
  quantity = 1,
  options = {},
) {
  return grantItemsToOwnerLocation(
    ownerId,
    locationId,
    flagId,
    [{
      itemType,
      quantity,
      options,
    }],
  );
}

function resolveSpawnedSpaceItemRadius(itemType, options = {}) {
  const explicitSpaceRadius = toFiniteNumber(options && options.spaceRadius, 0);
  if (explicitSpaceRadius > 0) {
    return explicitSpaceRadius;
  }

  const metadata = getItemMetadata(
    itemType && itemType.typeID,
    itemType && (itemType.itemName || itemType.name),
  );
  const groupName = String(
    metadata && metadata.groupName || itemType && itemType.groupName || "",
  ).trim().toLowerCase();
  if (groupName !== "wreck") {
    return 0;
  }

  return resolveRuntimeWreckRadius(metadata, toFiniteNumber(metadata && metadata.radius, 0));
}

function createSpaceItemForCharacter(charId, solarSystemId, itemType, options = {}) {
  const normalizedSystemId = toNumber(solarSystemId, 0);
  if (normalizedSystemId <= 0) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const createResult = grantItemToCharacterLocation(
    charId,
    normalizedSystemId,
    0,
    itemType,
    1,
    {
      ...options,
      singleton: 1,
      createdAtMs: options.createdAtMs ?? Date.now(),
      expiresAtMs: options.expiresAtMs ?? null,
      spaceRadius: (
        resolveSpawnedSpaceItemRadius(itemType, options) || null
      ),
      spaceState: normalizeSpaceState({
        ...options,
        systemID: normalizedSystemId,
        position: options.position,
        velocity: options.velocity,
        direction: options.direction,
        targetPoint: options.targetPoint,
        speedFraction: options.speedFraction,
        mode: options.mode || "STOP",
        targetEntityID: options.targetEntityID,
        followRange: options.followRange,
        orbitDistance: options.orbitDistance,
        orbitNormal: options.orbitNormal,
        orbitSign: options.orbitSign,
      }),
    },
  );
  if (!createResult.success) {
    return createResult;
  }

  return {
    success: true,
    data: createResult.data.items[0] || null,
    changes: createResult.data.changes || [],
  };
}

function createSpaceItemForOwner(ownerId, solarSystemId, itemType, options = {}) {
  const normalizedSystemId = toNumber(solarSystemId, 0);
  if (normalizedSystemId <= 0) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const createResult = grantItemToOwnerLocation(
    ownerId,
    normalizedSystemId,
    0,
    itemType,
    1,
    {
      ...options,
      singleton: 1,
      createdAtMs: options.createdAtMs ?? Date.now(),
      expiresAtMs: options.expiresAtMs ?? null,
      spaceRadius: (
        resolveSpawnedSpaceItemRadius(itemType, options) || null
      ),
      spaceState: normalizeSpaceState({
        ...options,
        systemID: normalizedSystemId,
        position: options.position,
        velocity: options.velocity,
        direction: options.direction,
        targetPoint: options.targetPoint,
        speedFraction: options.speedFraction,
        mode: options.mode || "STOP",
        targetEntityID: options.targetEntityID,
        followRange: options.followRange,
        orbitDistance: options.orbitDistance,
        orbitNormal: options.orbitNormal,
        orbitSign: options.orbitSign,
      }),
    },
  );
  if (!createResult.success) {
    return createResult;
  }

  return {
    success: true,
    data: createResult.data.items[0] || null,
    changes: createResult.data.changes || [],
  };
}

// Space creation uses the same atomic item/grant receipt boundary as ordinary
// idempotent grants. A replay retains the original ID even if the item is gone.
function createSpaceItemForOwnerIdempotent(ownerId, solarSystemId, itemType, options = {}) {
  const systemID = toNumber(solarSystemId, 0);
  if (systemID <= 0) return { success: false, ambiguous: false, errorMsg: "SOLAR_SYSTEM_NOT_FOUND" };
  const fingerprint = options.fingerprint;
  if (!fingerprint || typeof fingerprint !== "object") return { success: false, ambiguous: false, errorMsg: "INVALID_SPACE_CREATE_FINGERPRINT" };
  const prior = getIdempotentGrantReceipt(options.receiptKey, { requireDurable: true });
  if (!prior.success) return prior;
  if (prior.found && !isDeepStrictEqual(prior.data.metadata?.spaceCreateFingerprint, cloneValue(fingerprint))) {
    return { success: false, ambiguous: true, errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH", receipt: prior.data };
  }
  return grantItemToOwnerLocationIdempotent(ownerId, systemID, 0, itemType, 1, {
    ...options,
    receiptMetadata: { ...options.receiptMetadata, spaceCreateFingerprint: cloneValue(fingerprint) },
    singleton: 1,
    createdAtMs: options.createdAtMs ?? Date.now(),
    expiresAtMs: options.expiresAtMs ?? null,
    spaceRadius: resolveSpawnedSpaceItemRadius(itemType, options) || null,
    spaceState: normalizeSpaceState({ ...options, systemID,
      position: options.position, velocity: options.velocity,
      direction: options.direction, targetPoint: options.targetPoint,
      mode: options.mode || "STOP" }),
  });
}

function takeItemTypeFromCharacterLocation(
  charId,
  locationId,
  flagId,
  typeId,
  quantity = 1,
) {
  ensureMigrated();
  const numericCharId = toNumber(charId, 0);
  const numericLocationId = toNumber(locationId, 0);
  const numericFlagId =
    flagId === null || flagId === undefined ? null : toNumber(flagId, 0);
  const numericTypeId = toNumber(typeId, 0);
  const normalizedQuantity = normalizePositiveInteger(quantity, 1);
  if (numericCharId <= 0 || numericTypeId <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  // Nothing is staged yet, so the candidate sweep reads the raw table.
  const matchingItems = Object.values(readItems())
    .map((entry) => normalizeInventoryItem(entry))
    .filter(
      (entry) =>
        entry &&
        entry.ownerID === numericCharId &&
        entry.locationID === numericLocationId &&
        (numericFlagId === null || entry.flagID === numericFlagId) &&
        entry.typeID === numericTypeId &&
        // A blueprint copy shares its typeID with the original but is not
        // fungible with it, and its quantity of -2 is a copy marker rather than
        // a count. Keep copies out of the candidate set entirely so they
        // neither inflate availableQuantity nor get consumed below.
        !isBlueprintCopyInventoryItem(entry),
    )
    .sort((left, right) => left.itemID - right.itemID);

  const availableQuantity = matchingItems.reduce(
    (sum, entry) => sum + (entry.singleton === 1 ? 1 : toNumber(entry.quantity, 0)),
    0,
  );
  if (availableQuantity < normalizedQuantity) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_ITEMS",
      data: {
        availableQuantity,
        requestedQuantity: normalizedQuantity,
      },
    };
  }

  let remaining = normalizedQuantity;
  const changes = [];
  const clearedTransientItemIDs = [];
  for (const item of matchingItems) {
    if (remaining <= 0) {
      break;
    }

    const previousData = cloneValue(item);
    if (item.singleton === 1) {
      delete items[String(item.itemID)];
      clearedTransientItemIDs.push(item.itemID);
      changes.push({
        removed: true,
        previousData,
        item: null,
      });
      remaining -= 1;
      continue;
    }

    const currentQuantity = toNumber(item.quantity, 0);
    if (currentQuantity <= remaining) {
      delete items[String(item.itemID)];
      clearedTransientItemIDs.push(item.itemID);
      changes.push({
        removed: true,
        previousData,
        item: null,
      });
      remaining -= currentQuantity;
      continue;
    }

    const updatedQuantity = currentQuantity - remaining;
    const updatedItem = buildInventoryItem({
      ...item,
      quantity: updatedQuantity,
      stacksize: updatedQuantity,
      singleton: 0,
    });
    items[String(updatedItem.itemID)] = updatedItem;
    changes.push({
      removed: false,
      previousData,
      item: cloneValue(updatedItem),
    });
    remaining = 0;
  }

  if (!mutationPlan.commit({ indexDelta: indexDeltaFromChanges(changes) })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  clearTransientItemPaths(clearedTransientItemIDs);

  return {
    success: true,
    data: {
      quantity: normalizedQuantity,
      changes,
    },
  };
}

function takeItemTypeFromOwnerLocation(
  ownerId,
  locationId,
  flagId,
  typeId,
  quantity = 1,
) {
  ensureMigrated();
  const numericOwnerId = toNumber(ownerId, 0);
  const characters = readCharacters();
  if (characters[String(numericOwnerId)]) {
    return takeItemTypeFromCharacterLocation(
      numericOwnerId,
      locationId,
      flagId,
      typeId,
      quantity,
    );
  }

  const numericLocationId = toNumber(locationId, 0);
  const numericFlagId =
    flagId === null || flagId === undefined ? null : toNumber(flagId, 0);
  const numericTypeId = toNumber(typeId, 0);
  const normalizedQuantity = normalizePositiveInteger(quantity, 1);
  if (numericOwnerId <= 0 || numericTypeId <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  // Nothing is staged yet, so the candidate sweep reads the raw table.
  const matchingItems = Object.values(readItems())
    .map((entry) => normalizeInventoryItem(entry))
    .filter(
      (entry) =>
        entry &&
        entry.ownerID === numericOwnerId &&
        entry.locationID === numericLocationId &&
        (numericFlagId === null || entry.flagID === numericFlagId) &&
        entry.typeID === numericTypeId &&
        // Same copy exclusion as the character variant above: a singleton-2 row
        // is identity-bearing, and its -2 quantity would drive the consume loop
        // backwards.
        !isBlueprintCopyInventoryItem(entry),
    )
    .sort((left, right) => left.itemID - right.itemID);

  const availableQuantity = matchingItems.reduce(
    (sum, entry) => sum + (entry.singleton === 1 ? 1 : toNumber(entry.quantity, 0)),
    0,
  );
  if (availableQuantity < normalizedQuantity) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_ITEMS",
      data: {
        availableQuantity,
        requestedQuantity: normalizedQuantity,
      },
    };
  }

  let remaining = normalizedQuantity;
  const changes = [];
  const clearedTransientItemIDs = [];
  for (const item of matchingItems) {
    if (remaining <= 0) {
      break;
    }

    const previousData = cloneValue(item);
    if (item.singleton === 1) {
      delete items[String(item.itemID)];
      clearedTransientItemIDs.push(item.itemID);
      changes.push({
        removed: true,
        previousData,
        item: null,
      });
      remaining -= 1;
      continue;
    }

    const currentQuantity = toNumber(item.quantity, 0);
    if (currentQuantity <= remaining) {
      delete items[String(item.itemID)];
      clearedTransientItemIDs.push(item.itemID);
      changes.push({
        removed: true,
        previousData,
        item: null,
      });
      remaining -= currentQuantity;
      continue;
    }

    const updatedQuantity = currentQuantity - remaining;
    const updatedItem = buildInventoryItem({
      ...item,
      quantity: updatedQuantity,
      stacksize: updatedQuantity,
      singleton: 0,
    });
    items[String(updatedItem.itemID)] = updatedItem;
    changes.push({
      removed: false,
      previousData,
      item: cloneValue(updatedItem),
    });
    remaining = 0;
  }

  if (!mutationPlan.commit({ indexDelta: indexDeltaFromChanges(changes) })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  clearTransientItemPaths(clearedTransientItemIDs);

  return {
    success: true,
    data: {
      quantity: normalizedQuantity,
      changes,
    },
  };
}

// The GM Clone Perfect action copies a docked hull and its inventory tree.
// Allocate and publish the whole tree in one item-owner transaction: a failed
// write must never leave a bare hull or contents pointing at the source ship.
function cloneDockedShipForCharacter(characterID, shipID, dockedLocationID) {
  ensureMigrated();
  const actor = Number(characterID), sourceID = Number(shipID), dock = Number(dockedLocationID);
  const character = readCharacters()[String(actor)];
  const plan = createItemRowMutationPlan();
  const source = normalizeInventoryItem(plan.items[String(sourceID)]);
  if (!character || !Number.isSafeInteger(dock) || dock <= 0 ||
      !source || source.ownerID !== actor || source.categoryID !== SHIP_CATEGORY_ID || source.groupID === 29 ||
      source.singleton !== 1 || source.locationID !== dock || source.flagID !== ITEM_FLAGS.HANGAR) {
    return { success: false, errorMsg: "OWNED_DOCKED_SHIP_REQUIRED" };
  }
  const children = new Map();
  for (const row of Object.values(plan.items)) {
    if (!row || typeof row !== "object" || !Number(row.itemID)) continue;
    const locationID = Number(row.locationID);
    if (!children.has(locationID)) children.set(locationID, []);
    children.get(locationID).push(row);
  }
  const originals = [source], seen = new Set([sourceID]);
  for (let index = 0; index < originals.length; index += 1) {
    for (const row of children.get(originals[index].itemID) || []) {
      const item = normalizeInventoryItem(row);
      if (!item || seen.has(item.itemID) || item.ownerID !== actor ||
          // Contract packages contain external ownership/escrow state. Copying
          // their inventory row cannot copy the contract that owns that state.
          item.typeID === 3468 || item.categoryID === BLUEPRINT_CATEGORY_ID || item.flagID === ITEM_FLAGS.HIDDEN_MODIFIERS ||
          item.expiresAtMs || item.launcherID || item.spaceState) {
        return { success: false, errorMsg: "UNSUPPORTED_SHIP_CONTENTS" };
      }
      seen.add(item.itemID);
      originals.push(item);
    }
  }
  const copies = new Map(), changes = [];
  for (const original of originals) {
    const itemID = nextItemID(actor, plan.items, character);
    const item = normalizeInventoryItem({
      ...original,
      itemID,
      locationID: original.itemID === sourceID ? dock : copies.get(original.locationID).itemID,
      // A clone has a new identity. Custody and SKIN application receipts are
      // evidence of operations on the source item, not transferable metadata.
      inventoryCustodyRevision: null,
      skinrApplication: null,
      stackOriginID: null,
    });
    plan.items[String(itemID)] = item;
    copies.set(original.itemID, item);
    changes.push({ created: true, item: cloneValue(item), previousData: { locationID: 0, flagID: 0 } });
  }
  if (!plan.commit({ indexDelta: indexDeltaFromChanges(changes) })) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
  return { success: true, data: { ship: cloneValue(copies.get(sourceID)), changes } };
}

function createShipItemForCharacter(charId, stationId, shipType) {
  const createResult = grantItemToCharacterLocation(
    charId,
    stationId,
    ITEM_FLAGS.HANGAR,
    shipType,
    1,
  );
  if (!createResult.success) {
    return createResult;
  }

  return {
    success: true,
    data: createResult.data.items[0] || null,
    changes: createResult.data.changes,
  };
}

// Private capability: ordinary updateInventoryItem callers keep the complete result.
const INVENTORY_UPDATE_SUCCESS_ONLY = Symbol("inventoryUpdateSuccessOnly");

function updateInventoryItemSuccessOnly(itemId, updater) {
  return updateInventoryItem(itemId, updater, INVENTORY_UPDATE_SUCCESS_ONLY);
}

function validateUnusedInventoryResultClone(value) {
  // Keep JSON serialization, its toJSON side effects and its errors in the same
  // post-commit order as cloneValue. Parsing valid JSON only creates the unused
  // detached return row. JSON.stringify can return undefined via a root toJSON;
  // preserve cloneValue's resulting native SyntaxError in that case as well.
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    JSON.parse(serialized);
  }
}

function updateInventoryItem(itemId, updater, resultMode = null) {
  ensureMigrated();
  const numericItemId = toNumber(itemId, 0);
  if (numericItemId <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const currentItem = normalizeInventoryItem(items[String(numericItemId)]);
  if (!currentItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const updatedValue =
    typeof updater === "function" ? updater(cloneValue(currentItem)) : updater;
  const normalizedItem = normalizeInventoryItem(updatedValue, currentItem);
  if (!normalizedItem) {
    return {
      success: false,
      errorMsg: "INVALID_ITEM_STATE",
    };
  }

  items[String(numericItemId)] = normalizedItem;
  if (!mutationPlan.commit({ indexDelta: { upsertedIDs: [numericItemId] } })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  maybeNotifyInsuranceInventoryMutation(
    currentItem,
    normalizedItem,
    "updateInventoryItem",
  );

  if (resultMode === INVENTORY_UPDATE_SUCCESS_ONLY) {
    validateUnusedInventoryResultClone(currentItem);
    validateUnusedInventoryResultClone(normalizedItem);
    return { success: true };
  }

  return {
    success: true,
    previousData: cloneValue(currentItem),
    data: cloneValue(normalizedItem),
  };
}

// Persist the encoded wrap volume before a contract settlement checkpoints it.
// Retrying after an uncertain flush writes the same value and fences it again.
function setPlasticWrapVolumeDurably(itemID, volume) {
  const numericVolume = Number(volume);
  const centiVolume = Math.max(1, Math.round(numericVolume * 100));
  if (!Number.isFinite(numericVolume) || numericVolume < 0 ||
      !Number.isSafeInteger(centiVolume) || centiVolume > 2147483648) {
    return { success: false, errorMsg: "INVALID_PLASTIC_WRAP_VOLUME" };
  }
  const existing = findItemById(itemID);
  if (!existing || Number(existing.typeID) !== 3468 || Number(existing.singleton) !== 1) {
    return { success: false, errorMsg: "PLASTIC_WRAP_NOT_FOUND" };
  }
  const updated = updateInventoryItem(itemID, (item) => ({
    ...item,
    plasticWrapVolume: centiVolume / 100,
  }));
  if (!updated.success) return updated;
  let flushed;
  try {
    flushed = repo.flushTableSync(ITEMS_TABLE);
  } catch (error) {
    return { success: false, ambiguous: true, errorMsg: String(error && error.message || error) };
  }
  if (!flushed || flushed.success !== true) {
    return { success: false, ambiguous: true, errorMsg: flushed && flushed.errorMsg || "PLASTIC_WRAP_FLUSH_FAILED" };
  }
  return { ...updated, durable: true };
}

function updateInventoryItemsAtomic(itemIds, updater) {
  ensureMigrated();
  const normalizedItemIDs = [
    ...new Set(
      (Array.isArray(itemIds) ? itemIds : [itemIds])
        .map((itemID) => toNumber(itemID, 0))
        .filter((itemID) => itemID > 0),
    ),
  ];
  if (normalizedItemIDs.length === 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const currentItems = normalizedItemIDs.map((itemID) =>
    normalizeInventoryItem(items[String(itemID)]),
  );
  if (currentItems.some((item) => !item)) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const changes = [];
  const updatedItems = [];
  for (let index = 0; index < normalizedItemIDs.length; index += 1) {
    const itemID = normalizedItemIDs[index];
    const currentItem = currentItems[index];
    const updatedValue =
      typeof updater === "function"
        ? updater(cloneValue(currentItem), index)
        : updater && updater[String(itemID)];
    const normalizedItem = normalizeInventoryItem(
      updatedValue === undefined ? currentItem : updatedValue,
      currentItem,
    );
    if (!normalizedItem || toNumber(normalizedItem.itemID, 0) !== itemID) {
      return {
        success: false,
        errorMsg: "INVALID_ITEM_STATE",
      };
    }
    items[String(itemID)] = normalizedItem;
    changes.push({
      removed: false,
      previousData: cloneValue(currentItem),
      item: cloneValue(normalizedItem),
    });
    updatedItems.push(cloneValue(normalizedItem));
  }

  if (
    !mutationPlan.commit({
      indexDelta: { upsertedIDs: normalizedItemIDs },
    })
  ) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  notifyInsuranceInventoryMutationChanges(
    changes,
    "updateInventoryItemsAtomic",
  );
  return {
    success: true,
    data: {
      items: updatedItems,
      changes,
    },
    changes,
  };
}

// Consume explicitly selected stack rows in one items-table mutation. Fuel and
// other activation costs use this instead of updating stacks one at a time: a
// rejected custody write must leave every source row untouched so callers can
// decide whether to commit external consequences (Crimewatch, timers, etc.)
// only after the inventory boundary has succeeded.
function consumeInventoryItemStacksAtomic(rawRequests = [], options = {}) {
  ensureMigrated();
  const requestsByItemID = new Map();
  for (const rawRequest of Array.isArray(rawRequests) ? rawRequests : []) {
    const itemID = toNumber(rawRequest && rawRequest.itemID, 0);
    const quantity = normalizePositiveSafeInteger(
      rawRequest && rawRequest.quantity,
      0,
    );
    if (itemID <= 0 || quantity <= 0) {
      return { success: false, errorMsg: "INVALID_ITEM_QUANTITY" };
    }
    const existing = requestsByItemID.get(itemID);
    if (existing) {
      existing.quantity += quantity;
      if (!Number.isSafeInteger(existing.quantity)) {
        return { success: false, errorMsg: "INVALID_ITEM_QUANTITY" };
      }
      continue;
    }
    requestsByItemID.set(itemID, {
      itemID,
      quantity,
      expectedTypeID: toNumber(rawRequest.expectedTypeID, 0),
      expectedOwnerID: toNumber(rawRequest.expectedOwnerID, 0),
      expectedLocationID: toNumber(rawRequest.expectedLocationID, 0),
      expectedFlagID:
        rawRequest.expectedFlagID === null ||
        rawRequest.expectedFlagID === undefined
          ? null
          : toNumber(rawRequest.expectedFlagID, 0),
      expectedQuantity: normalizePositiveSafeInteger(
        rawRequest.expectedQuantity,
        0,
      ),
    });
  }
  const associatedUpdates = Array.isArray(options.associatedUpdates)
    ? options.associatedUpdates : [];
  const producedStacks = Array.isArray(options.producedStacks) ? options.producedStacks : [];
  if (requestsByItemID.size === 0 && associatedUpdates.length === 0 && producedStacks.length === 0) {
    return {
      success: true,
      data: { consumedQuantity: 0, changes: [] },
      changes: [],
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const changes = [];
  const removedItemIDs = [];
  let consumedQuantity = 0;
  for (const request of requestsByItemID.values()) {
    const currentItem = normalizeInventoryItem(items[String(request.itemID)]);
    if (!currentItem || !isStackableInventoryItem(currentItem)) {
      return { success: false, errorMsg: "ITEM_NOT_FOUND" };
    }
    const currentQuantity = getStackableItemQuantity(currentItem);
    if (
      (request.expectedTypeID > 0 &&
        currentItem.typeID !== request.expectedTypeID) ||
      (request.expectedOwnerID > 0 &&
        currentItem.ownerID !== request.expectedOwnerID) ||
      (request.expectedLocationID > 0 &&
        currentItem.locationID !== request.expectedLocationID) ||
      (request.expectedFlagID !== null &&
        currentItem.flagID !== request.expectedFlagID) ||
      (request.expectedQuantity > 0 &&
        currentQuantity !== request.expectedQuantity) ||
      currentQuantity < request.quantity
    ) {
      return { success: false, errorMsg: "ITEM_CUSTODY_CHANGED" };
    }

    const previousData = cloneValue(currentItem);
    const wasTransient = repo.isTransientPath(
      ITEMS_TABLE,
      `/${String(request.itemID)}`,
    );
    const nextQuantity = currentQuantity - request.quantity;
    if (nextQuantity <= 0) {
      delete items[String(request.itemID)];
      removedItemIDs.push(request.itemID);
      changes.push({ removed: true, previousData, item: null, wasTransient });
    } else {
      const nextItem = buildInventoryItem({
        ...currentItem,
        quantity: nextQuantity,
        stacksize: nextQuantity,
        singleton: 0,
      });
      items[String(request.itemID)] = nextItem;
      changes.push({
        removed: false,
        previousData,
        item: cloneValue(nextItem),
        wasTransient,
      });
    }
    consumedQuantity += request.quantity;
  }

  // Reinforcement needs the activation cost and its durable consequence in the
  // same custody commit. Reject overlapping rows and stale snapshots; callbacks
  // operate only on this mutation plan, never the live table.
  const updatedIDs = new Set(requestsByItemID.keys());
  for (const update of associatedUpdates) {
    const itemID = toNumber(update && update.itemID, 0);
    const currentItem = normalizeInventoryItem(items[String(itemID)]);
    if (!currentItem || updatedIDs.has(itemID) || typeof update.updater !== "function") {
      return { success: false, errorMsg: "INVALID_ASSOCIATED_ITEM_UPDATE" };
    }
    if (update.expectedItem && JSON.stringify(currentItem) !== JSON.stringify(update.expectedItem)) {
      return { success: false, errorMsg: "ITEM_CUSTODY_CHANGED" };
    }
    const nextItem = buildInventoryItem(update.updater(cloneValue(currentItem)));
    if (!nextItem || nextItem.itemID !== itemID) {
      return { success: false, errorMsg: "INVALID_ASSOCIATED_ITEM_UPDATE" };
    }
    items[String(itemID)] = nextItem;
    changes.push({ previousData: cloneValue(currentItem), item: cloneValue(nextItem), removed: false });
    updatedIDs.add(itemID);
  }
  // Server-owned production adapters may commit outputs with their inputs and
  // durable cycle marker. Never issue a separate grant after consuming inputs.
  // These arguments are not client RPC payloads; adapters validate recipes,
  // custody, capacity and lifecycle before entering this boundary.
  const outputStacksByKey = new Map();
  if (producedStacks.length > 0) {
    for (const output of producedStacks) {
      outputStacksByKey.set(buildStackKey(output?.ownerID, output?.locationID,
        toNumber(output?.flagID, 0), output?.typeID), []);
    }
    // Preserve mutation-plan enumeration order and exclude input/marker rows.
    // Buckets contain IDs so later outputs see quantities staged by earlier ones.
    for (const row of Object.values(items)) {
      if (!row || row.singleton !== 0 || updatedIDs.has(row.itemID) || row.custodyReservation || row.careerBoundCharacterID) continue;
      const bucket = outputStacksByKey.get(buildStackKey(row.ownerID, row.locationID, row.flagID, row.typeID));
      if (bucket) bucket.push(row.itemID);
    }
  }
  for (const output of producedStacks) {
    const metadata = resolveItemTypeReference(output && output.typeID);
    const quantity = normalizePositiveSafeInteger(output && output.quantity, 0);
    const ownerID = toNumber(output && output.ownerID, 0);
    const locationID = toNumber(output && output.locationID, 0);
    const flagID = toNumber(output && output.flagID, 0);
    if (!metadata || !quantity || quantity > 2147483647 || !Number.isSafeInteger(ownerID) || ownerID <= 0 ||
        !Number.isSafeInteger(locationID) || locationID <= 0 || !Number.isInteger(flagID) || flagID < 0) {
      return { success: false, errorMsg: "INVALID_PRODUCTION_OUTPUT" };
    }
    const stackKey = buildStackKey(ownerID, locationID, flagID, metadata.typeID);
    const bucket = outputStacksByKey.get(stackKey) || [];
    const existingID = bucket.find((itemID) => {
      const row = items[String(itemID)];
      return row.ownerID === ownerID && row.locationID === locationID &&
        row.flagID === flagID && row.typeID === metadata.typeID &&
        getStackableItemQuantity(row) + quantity <= 2147483647;
    });
    const existing = existingID === undefined ? null : items[String(existingID)];
    const previousData = existing ? cloneValue(existing) : null;
    const nextQuantity = quantity + (existing ? getStackableItemQuantity(existing) : 0);
    const item = buildInventoryItem({ ...(existing || {}),
      itemID: existing ? existing.itemID : nextItemID(ownerID, items), typeID: metadata.typeID,
      ownerID, locationID, flagID, singleton: 0, quantity: nextQuantity, stacksize: nextQuantity,
    });
    items[String(item.itemID)] = item;
    if (!existing) {
      bucket.push(item.itemID);
      outputStacksByKey.set(stackKey, bucket);
    }
    changes.push({ removed: false, created: !existing, previousData,
      previousState: previousData || { locationID: 0, flagID: 0, quantity: 0, stacksize: 0 }, item: cloneValue(item) });
  }
  const attachedReceipt = attachIdempotentInventoryReceipt(items,
    options.__evejsIdempotentInventoryReceipt ? {
      ...cloneValue(options.__evejsIdempotentInventoryReceipt),
      resultData: { consumedQuantity, changes: cloneValue(changes) },
    } : null);
  if (!mutationPlan.commit({ indexDelta: indexDeltaFromChanges(changes),
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return { success: false, errorMsg: "WRITE_ERROR", changes: [] };
  }
  clearTransientItemPaths(removedItemIDs);
  notifyInsuranceInventoryMutationChanges(
    changes,
    "consumeInventoryItemStacksAtomic",
  );
  return {
    success: true,
    data: { consumedQuantity, changes },
    changes,
  };
}

// Compensation boundary for one or more immediately preceding inventory
// mutations. Changes are collapsed by itemID so a saga may safely compensate a
// sequence such as create -> move -> remove. Every current row must still match
// the final post-state before any original row is restored, preventing rollback
// from overwriting unrelated custody that happened later.
function restoreInventoryItemChangesAtomic(rawChanges = []) {
  ensureMigrated();
  const changes = Array.isArray(rawChanges) ? rawChanges : [];
  if (changes.length === 0) {
    return { success: true, data: { changes: [] }, changes: [] };
  }

  const rollbackStates = new Map();
  for (const change of changes) {
    const postData = change && change.removed === true
      ? null
      : normalizeInventoryItem(change && change.item);
    const exactPostData = postData ? cloneValue(change.item) : null;
    const explicitPreviousData = normalizeInventoryItem(
      change && change.previousData,
      postData || {},
    );
    const reconstructedPreviousData = explicitPreviousData ||
      normalizeInventoryItem(
        change && change.previousState
          ? {
              ...(postData || {}),
              ...change.previousState,
            }
          : null,
      );
    const exactPreviousData =
      change &&
      Object.prototype.hasOwnProperty.call(change, "rollbackPreviousData") &&
      change.rollbackPreviousData &&
      typeof change.rollbackPreviousData === "object"
        ? cloneValue(change.rollbackPreviousData)
        : null;
    const itemID = toNumber(
      (postData && postData.itemID) ||
        (explicitPreviousData && explicitPreviousData.itemID) ||
        (reconstructedPreviousData && reconstructedPreviousData.itemID),
      0,
    );
    if (itemID <= 0 || (!postData && !reconstructedPreviousData)) {
      return { success: false, errorMsg: "INVALID_ROLLBACK_STATE" };
    }

    let state = rollbackStates.get(itemID);
    if (!state) {
      state = {
        itemID,
        originalData:
          change && change.created === true
            ? null
            : exactPreviousData || reconstructedPreviousData,
        postData: exactPostData,
        wasTransient:
          change && typeof change.wasTransient === "boolean"
            ? change.wasTransient
            : null,
      };
      if (change && change.created !== true && !state.originalData) {
        return { success: false, errorMsg: "INVALID_ROLLBACK_STATE" };
      }
      rollbackStates.set(itemID, state);
    } else {
      state.postData = exactPostData;
      if (
        state.wasTransient === null &&
        change &&
        typeof change.wasTransient === "boolean"
      ) {
        state.wasTransient = change.wasTransient;
      }
    }
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const restoredChanges = [];
  const custodyRevisionRestoreFloors = {};
  const transientPathsToClear = [];
  const transientPathsToRestore = [];
  for (const state of rollbackStates.values()) {
    const currentData = items[String(state.itemID)] || null;
    if (!state.postData) {
      if (currentData) {
        return { success: false, errorMsg: "ITEM_CUSTODY_CHANGED" };
      }
    } else if (!currentData || !isDeepStrictEqual(
      inventoryCompensationPostState(currentData), inventoryCompensationPostState(state.postData),
    )) {
      return { success: false, errorMsg: "ITEM_CUSTODY_CHANGED" };
    }
  }

  for (const state of rollbackStates.values()) {
    const currentData = normalizeInventoryItem(items[String(state.itemID)]);
    const itemPath = `/${String(state.itemID)}`;
    if (!state.originalData) {
      delete items[String(state.itemID)];
      transientPathsToClear.push(itemPath);
      restoredChanges.push({
        removed: true,
        previousData: cloneValue(currentData),
        item: buildRemovedItemNotificationState(currentData),
      });
      continue;
    }

    items[String(state.itemID)] = state.originalData;
    const originalRevision = normalizeInventoryCustodyRevision(state.originalData.inventoryCustodyRevision);
    if (!currentData && originalRevision) {
      // A deleted row has no place to retain its counter. Restoring it accounts
      // for both deletion and recreation, exposing a missed removal observer.
      custodyRevisionRestoreFloors[state.itemID] = originalRevision + 2;
    }
    if (state.wasTransient === true) {
      transientPathsToRestore.push(itemPath);
    }
    restoredChanges.push({
      removed: false,
      previousData: currentData || {},
      item: cloneValue(state.originalData),
    });
  }
  if (!mutationPlan.commit({ indexDelta: indexDeltaFromChanges(restoredChanges), custodyRevisionRestoreFloors })) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
  repo.setTransientPaths(ITEMS_TABLE, transientPathsToClear, false);
  repo.setTransientPaths(ITEMS_TABLE, transientPathsToRestore, true);
  notifyInsuranceInventoryMutationChanges(
    restoredChanges,
    "restoreInventoryItemChangesAtomic",
  );
  return {
    success: true,
    data: { changes: restoredChanges },
    changes: restoredChanges,
  };
}

/**
 * Atomically trash a set of inventory roots and their complete container
 * closure. This is deliberately one coarse authority command: the closure is
 * planned from the live byLocation index, policy is checked once against that
 * immutable plan, every row is staged, and one root write publishes one
 * projection version.
 *
 * `preflight` is the current in-process policy seam used by invBroker for
 * session/password/audit checks. It runs synchronously with detached rows and
 * must complete before the mutation plan is touched. A future process owner can
 * replace it with transport-safe policy context without changing the command's
 * storage semantics.
 */
function trashInventoryItemsMany(itemIds, options = {}) {
  ensureMigrated();
  const startedAtMs = performance.now();
  const requestedItemIDs = [];
  const requestedIDSet = new Set();
  for (const rawItemID of Array.isArray(itemIds) ? itemIds : []) {
    const itemID = toNumber(rawItemID, 0);
    if (itemID <= 0 || requestedIDSet.has(itemID)) {
      continue;
    }
    requestedIDSet.add(itemID);
    requestedItemIDs.push(itemID);
  }
  if (requestedItemIDs.length === 0) {
    return {
      success: false,
      duplicate: false,
      durable: false,
      ambiguous: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const receiptKey = normalizeIdempotentGrantReceiptKey(options.receiptKey);
  const storageKey = buildIdempotentGrantReceiptStorageKey(receiptKey);
  const fingerprint = options.fingerprint &&
    typeof options.fingerprint === "object" &&
    !Array.isArray(options.fingerprint)
    ? cloneValue(options.fingerprint)
    : null;
  if (!receiptKey || !storageKey || !fingerprint) {
    return {
      success: false,
      duplicate: false,
      durable: false,
      ambiguous: false,
      errorMsg: "INVALID_IDEMPOTENCY_KEY",
    };
  }

  // Receipt lookup intentionally precedes item lookup and authorization. A
  // retry after the successful deletion no longer has item rows to authorize,
  // but it must still resolve as the same completed command without another
  // mutation or another client notification.
  const liveItems = readItems();
  const liveLedger = getIdempotentGrantReceiptLedger(liveItems, false);
  const existingReceipt = liveLedger && liveLedger[storageKey] &&
    typeof liveLedger[storageKey] === "object"
    ? cloneValue(liveLedger[storageKey])
    : null;
  if (existingReceipt) {
    if (
      String(existingReceipt.receiptKey || "") !== receiptKey ||
      String(existingReceipt.operation || "") !== TRASH_MANY_OPERATION ||
      !isDeepStrictEqual(existingReceipt.fingerprint, fingerprint)
    ) {
      return {
        success: false,
        duplicate: false,
        durable: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH",
        receipt: existingReceipt,
      };
    }
    if (options.requireDurable === true) {
      const flushResult = flushIdempotentGrantReceiptBoundary(receiptKey);
      if (!flushResult.success) {
        return {
          ...flushResult,
          duplicate: true,
          receipt: existingReceipt,
        };
      }
    }
    return {
      success: true,
      duplicate: true,
      durable: options.requireDurable === true,
      ambiguous: false,
      receipt: existingReceipt,
      data: {
        ...(cloneValue(existingReceipt.resultData || {})),
        requestedItemIDs: [],
        removedItemIDs: [],
        removedItems: [],
        changes: [],
      },
      changes: [],
    };
  }

  const indexes = ensureItemIndexes();
  const requestedItems = [];
  for (const itemID of requestedItemIDs) {
    const item = indexes.byID.get(itemID) || null;
    if (!item) {
      return {
        success: false,
        duplicate: false,
        durable: false,
        ambiguous: false,
        errorMsg: "ITEM_NOT_FOUND",
      };
    }
    requestedItems.push(cloneValue(item));
  }

  const planningStartedAtMs = performance.now();
  const orderedRemovalIDs = [];
  const seen = new Set();
  for (const rootItemID of requestedItemIDs) {
    const stack = [{ itemID: rootItemID, expanded: false }];
    while (stack.length > 0) {
      const frame = stack.pop();
      const currentItemID = toNumber(frame && frame.itemID, 0);
      if (currentItemID <= 0) {
        continue;
      }
      if (frame.expanded) {
        orderedRemovalIDs.push(currentItemID);
        continue;
      }
      if (seen.has(currentItemID) || !indexes.byID.has(currentItemID)) {
        continue;
      }
      seen.add(currentItemID);
      stack.push({ itemID: currentItemID, expanded: true });
      if (options.removeContents === false) {
        continue;
      }
      const children = indexes.byLocation.get(currentItemID) || [];
      // Buckets are itemID-ascending. Reverse-push preserves that order while
      // the exit frame produces the legacy child-before-parent notification
      // sequence. The global seen set also terminates malformed cycles.
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childItemID = toNumber(children[index] && children[index].itemID, 0);
        if (childItemID > 0 && childItemID !== currentItemID) {
          stack.push({ itemID: childItemID, expanded: false });
        }
      }
    }
  }

  const orderedRemovalItems = orderedRemovalIDs
    .map((itemID) => indexes.byID.get(itemID) || null)
    .filter(Boolean)
    .map((item) => cloneValue(item));
  const planningMs = performance.now() - planningStartedAtMs;

  if (typeof options.preflight === "function") {
    const preflightResult = options.preflight(Object.freeze({
      requestedItemIDs: Object.freeze([...requestedItemIDs]),
      requestedItems: Object.freeze(requestedItems.map((item) => Object.freeze(item))),
      orderedRemovalItems: Object.freeze(
        orderedRemovalItems.map((item) => Object.freeze(item)),
      ),
    }));
    if (preflightResult === false || (
      preflightResult &&
      typeof preflightResult === "object" &&
      preflightResult.success === false
    )) {
      return {
        success: false,
        duplicate: false,
        durable: false,
        ambiguous: false,
        errorMsg: preflightResult && preflightResult.errorMsg || "REMOVAL_NOT_AUTHORIZED",
      };
    }
  }

  const mutationPlan = createItemRowMutationPlan();
  const changes = [];
  const removedItems = [];
  for (const currentItem of orderedRemovalItems) {
    const removalID = toNumber(currentItem.itemID, 0);
    delete mutationPlan.items[String(removalID)];
    const previousData = cloneValue(currentItem);
    changes.push({
      removed: true,
      previousData,
      item: buildRemovedItemNotificationState(currentItem),
    });
    removedItems.push(previousData);
  }

  const receipt = {
    schemaVersion: 3,
    receiptKey,
    state: "completed",
    operation: TRASH_MANY_OPERATION,
    fingerprint,
    completedAtMs: normalizeTimestampMs(options.completedAtMs) || Date.now(),
    metadata: options.receiptMetadata &&
      typeof options.receiptMetadata === "object"
      ? cloneValue(options.receiptMetadata)
      : null,
    // Keep the durable/effectively-durable record compact. The first call
    // returns live changes, while retries need only prove that this command
    // completed; persisting thousands of full deleted rows would permanently
    // bloat the receipt ledger.
    resultData: {
      schemaVersion: TRASH_MANY_RECEIPT_SCHEMA_VERSION,
      requestedCount: requestedItemIDs.length,
      removedCount: orderedRemovalIDs.length,
      requestHash: String(fingerprint.requestHash || "") || null,
    },
  };
  // attachIdempotentInventoryReceipt stages a cloned receipt-ledger row, so a
  // rejected write cannot leak an in-place receipt into the live cache.
  const attachedReceipt = attachIdempotentInventoryReceipt(
    mutationPlan.items,
    receipt,
  );

  const commitStartedAtMs = performance.now();
  if (!mutationPlan.commit({
    indexDelta: { removedIDs: orderedRemovalIDs },
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return {
      success: false,
      duplicate: false,
      durable: false,
      ambiguous: false,
      errorMsg: "WRITE_ERROR",
    };
  }
  const commitMs = performance.now() - commitStartedAtMs;

  clearTransientItemPaths(orderedRemovalIDs);

  let durable = false;
  if (options.requireDurable === true) {
    const flushResult = flushIdempotentGrantReceiptBoundary(receiptKey);
    if (!flushResult.success) {
      return {
        success: false,
        duplicate: false,
        durable: false,
        ambiguous: true,
        errorMsg: flushResult.errorMsg,
        receipt: cloneValue(receipt),
      };
    }
    durable = true;
  }

  const totalMs = performance.now() - startedAtMs;
  return {
    success: true,
    duplicate: false,
    durable,
    ambiguous: false,
    receipt: cloneValue(receipt),
    data: {
      requestedItemIDs: [...requestedItemIDs],
      removedItemIDs: [...orderedRemovalIDs],
      removedItems,
      changes,
      requestedCount: requestedItemIDs.length,
      removedCount: orderedRemovalIDs.length,
      mutationVersion: itemMutationVersion,
      timings: {
        planningMs,
        commitMs,
        totalMs,
      },
    },
    changes,
  };
}

function removeInventoryItem(itemId, options = {}) {
  ensureMigrated();
  const numericItemId = toNumber(itemId, 0);
  if (numericItemId <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const rootItem = normalizeInventoryItem(items[String(numericItemId)]);
  if (!rootItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const removeContents = options.removeContents !== false;
  const orderedRemovalIDs = [];
  const seen = new Set();
  // The closure is planned before anything is staged, so it reads the live
  // byLocation index: every container visits only its own direct children.
  // Sweeping and re-normalizing the whole raw table made removing one item cost
  // O(total items) for EVERY node collected, which a weapon burning its last
  // charge pays on each cycle. trashInventoryItemsMany plans the same closure
  // the same way; this is that walk, for the single-root case.
  const indexes = ensureItemIndexes();

  const stack = [{ itemID: numericItemId, expanded: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    const currentItemID = toNumber(frame && frame.itemID, 0);
    if (currentItemID <= 0) {
      continue;
    }
    if (frame.expanded) {
      orderedRemovalIDs.push(currentItemID);
      continue;
    }
    if (seen.has(currentItemID)) {
      continue;
    }
    seen.add(currentItemID);
    stack.push({ itemID: currentItemID, expanded: true });
    if (!removeContents) {
      continue;
    }
    // Buckets are itemID-ascending. Reverse-push preserves that order while the
    // exit frame keeps the child-before-parent removal sequence the recursive
    // walk produced. The global seen set also terminates a malformed cycle, and
    // re-checking locationID drops a stale cross-bucket entry, exactly as
    // listContainerItems does on the read paths.
    const children = indexes.byLocation.get(currentItemID) || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      const childItemID = toNumber(child && child.itemID, 0);
      if (
        childItemID > 0 &&
        childItemID !== currentItemID &&
        toNumber(child.locationID, 0) === currentItemID
      ) {
        stack.push({ itemID: childItemID, expanded: false });
      }
    }
  }

  const changes = [];
  const removedItems = [];
  const removedIDs = [];
  for (const removalID of orderedRemovalIDs) {
    const rawCurrentItem = items[String(removalID)];
    const currentItem = normalizeInventoryItem(rawCurrentItem);
    if (!currentItem) {
      continue;
    }

    delete items[String(removalID)];
    changes.push(withRollbackPreviousData({
      removed: true,
      previousData: cloneValue(currentItem),
      item: buildRemovedItemNotificationState(currentItem),
      wasTransient: repo.isTransientPath(
        ITEMS_TABLE,
        `/${String(removalID)}`,
      ),
    }, rawCurrentItem));
    removedItems.push(cloneValue(currentItem));
    removedIDs.push(removalID);
  }

  const removedQuantity = rootItem.singleton === 1
    ? 1
    : normalizePositiveInteger(rootItem.stacksize ?? rootItem.quantity, 1);
  const receipt = options && options.__evejsIdempotentInventoryReceipt &&
    typeof options.__evejsIdempotentInventoryReceipt === "object"
    ? {
        ...cloneValue(options.__evejsIdempotentInventoryReceipt),
        resultData: {
          quantity: removedQuantity,
          removedItems: cloneValue(removedItems),
          changes: cloneValue(changes),
        },
      }
    : null;
  const attachedReceipt = attachIdempotentInventoryReceipt(items, receipt);
  if (!mutationPlan.commit({
    indexDelta: { removedIDs },
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  clearTransientItemPaths(removedIDs);

  return {
    success: true,
    data: {
      quantity: removedQuantity,
      removedItems,
      changes,
    },
  };
}

function consumeInventoryItemQuantity(itemId, quantity = 1, options = {}) {
  ensureMigrated();
  const numericItemId = toNumber(itemId, 0);
  if (numericItemId <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const currentItem = normalizeInventoryItem(items[String(numericItemId)]);
  if (!currentItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const availableQuantity =
    currentItem.singleton === 1
      ? 1
      : normalizePositiveInteger(currentItem.stacksize ?? currentItem.quantity, 1);
  const consumeQuantity =
    quantity === null || quantity === undefined
      ? availableQuantity
      : normalizePositiveSafeInteger(quantity, null);
  if (!consumeQuantity) {
    return {
      success: false,
      errorMsg: "ITEM_QUANTITY_OUT_OF_RANGE",
    };
  }
  if (consumeQuantity > availableQuantity) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_ITEMS",
    };
  }

  if (currentItem.singleton === 1 || consumeQuantity === availableQuantity) {
    return removeInventoryItem(itemId, options);
  }

  const previousData = cloneValue(currentItem);
  const updatedItem = buildInventoryItem({
    ...currentItem,
    quantity: availableQuantity - consumeQuantity,
    stacksize: availableQuantity - consumeQuantity,
    singleton: 0,
  });
  items[String(updatedItem.itemID)] = updatedItem;

  const changes = [{
    removed: false,
    previousData,
    item: cloneValue(updatedItem),
  }];
  const receipt = options && options.__evejsIdempotentInventoryReceipt &&
    typeof options.__evejsIdempotentInventoryReceipt === "object"
    ? {
        ...cloneValue(options.__evejsIdempotentInventoryReceipt),
        resultData: {
          quantity: consumeQuantity,
          removedItems: [],
          changes: cloneValue(changes),
        },
      }
    : null;
  const attachedReceipt = attachIdempotentInventoryReceipt(items, receipt);
  if (!mutationPlan.commit({
    indexDelta: { upsertedIDs: [updatedItem.itemID] },
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  return {
    success: true,
    data: {
      quantity: consumeQuantity,
      removedItems: [],
      changes,
    },
  };
}

function updateShipItem(shipId, updater) {
  const updateResult = updateInventoryItem(shipId, updater);
  if (!updateResult.success) {
    return {
      ...updateResult,
      errorMsg:
        updateResult.errorMsg === "ITEM_NOT_FOUND"
          ? "SHIP_NOT_FOUND"
          : updateResult.errorMsg === "INVALID_ITEM_STATE"
            ? "INVALID_SHIP_STATE"
            : updateResult.errorMsg,
    };
  }

  if (updateResult.data.categoryID !== SHIP_CATEGORY_ID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  return updateResult;
}

function buildRemovedItemNotificationState(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return {
    ...cloneValue(item),
    // The client removes container rows most reliably when the disappearing
    // item looks like it moved to a junk location, rather than an in-place
    // zero-stack update inside the same container.
    locationID: JUNK_LOCATION_ID,
    quantity:
      item.singleton === 2
        ? -2
        : item.singleton === 1
          ? -1
        : toNumber(item.stacksize ?? item.quantity, 0),
    stacksize:
      toNumber(item.singleton, 0) > 0
        ? 1
        : toNumber(item.stacksize ?? item.quantity, 0),
  };
}

function buildCreatedItemNotificationPreviousState(
  item,
  fallbackFlagID = ITEM_FLAGS.HANGAR,
  fallbackOwnerID = undefined,
) {
  return {
    ownerID:
      fallbackOwnerID === undefined
        ? toNumber(item && item.ownerID, 0)
        : toNumber(fallbackOwnerID, 0),
    locationID: 0,
    flagID: toNumber(item && item.flagID, fallbackFlagID),
    quantity: 0,
    stacksize: 0,
    singleton: toNumber(item && item.singleton, 0),
  };
}

function mergeItemStacks(sourceItemId, destinationItemId, quantity = null) {
  ensureMigrated();
  const numericSourceItemID = toNumber(sourceItemId, 0);
  const numericDestinationItemID = toNumber(destinationItemId, 0);
  if (numericSourceItemID <= 0 || numericDestinationItemID <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const sourceItem = normalizeInventoryItem(items[String(numericSourceItemID)]);
  const destinationItem = normalizeInventoryItem(items[String(numericDestinationItemID)]);
  if (!sourceItem || !destinationItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }
  if (Number(sourceItem.careerBoundCharacterID || 0) !== Number(destinationItem.careerBoundCharacterID || 0))
    return { success: false, errorMsg: "CAREER_BOUND_STACK_MISMATCH" };

  // A merge rebuilds the destination as a packaged stack (singleton 0) and
  // deletes the source row, so every individually-identified item has to
  // refuse — assembled singletons and blueprint copies alike. Letting a copy
  // through laundered it into a packaged "original" sharing the same typeID and
  // stranded the deleted row's industryBlueprintState.
  if (
    !isStackableInventoryItem(sourceItem) ||
    !isStackableInventoryItem(destinationItem)
  ) {
    return {
      success: false,
      errorMsg: "STACK_REQUIRED",
    };
  }

  if (
    toNumber(sourceItem.typeID, 0) !== toNumber(destinationItem.typeID, 0) ||
    toNumber(sourceItem.ownerID, 0) !== toNumber(destinationItem.ownerID, 0)
  ) {
    return {
      success: false,
      errorMsg: "STACK_MISMATCH",
    };
  }

  const sourceQuantity = toNumber(sourceItem.stacksize ?? sourceItem.quantity, 0);
  const destinationQuantity = toNumber(destinationItem.stacksize ?? destinationItem.quantity, 0);
  const requestedQuantity =
    quantity === null || quantity === undefined
      ? sourceQuantity
      : normalizePositiveSafeInteger(quantity, null);
  if (!requestedQuantity) {
    return {
      success: false,
      errorMsg: "ITEM_QUANTITY_OUT_OF_RANGE",
    };
  }
  if (requestedQuantity > sourceQuantity) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_ITEMS",
    };
  }

  const availableDestinationCapacity = Math.max(
    0,
    CLIENT_INVENTORY_STACK_LIMIT - destinationQuantity,
  );
  if (availableDestinationCapacity <= 0) {
    return {
      success: false,
      errorMsg: "STACK_LIMIT_REACHED",
      data: {
        stackLimit: CLIENT_INVENTORY_STACK_LIMIT,
      },
    };
  }

  const transferQuantity = Math.min(requestedQuantity, availableDestinationCapacity);

  const changes = [];
  const destinationPreviousData = captureItemState(destinationItem);
  const destinationRollbackPreviousData = items[String(numericDestinationItemID)];
  const updatedDestination = buildInventoryItem({
    ...destinationItem,
    quantity: destinationQuantity + transferQuantity,
    stacksize: destinationQuantity + transferQuantity,
    singleton: 0,
  });
  items[String(updatedDestination.itemID)] = updatedDestination;
  // Keep the small notification delta while retaining the exact preimage for
  // compensation if a later step in a multi-slot load refuses.
  changes.push(withRollbackPreviousData({
    removed: false,
    previousData: destinationPreviousData,
    item: cloneValue(updatedDestination),
  }, destinationRollbackPreviousData));

  const sourcePreviousData = cloneValue(sourceItem);
  if (transferQuantity === sourceQuantity) {
    delete items[String(sourceItem.itemID)];
    changes.push({
      removed: true,
      previousData: sourcePreviousData,
      item: buildRemovedItemNotificationState(sourceItem),
    });
  } else {
    const updatedSource = buildInventoryItem({
      ...sourceItem,
      quantity: sourceQuantity - transferQuantity,
      stacksize: sourceQuantity - transferQuantity,
      singleton: 0,
    });
    items[String(updatedSource.itemID)] = updatedSource;
    changes.push({
      removed: false,
      previousData: sourcePreviousData,
      item: cloneValue(updatedSource),
    });
  }

  if (!mutationPlan.commit({ indexDelta: indexDeltaFromChanges(changes) })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  persistTransientItemsMovedIntoDurableLocation(
    updatedDestination.locationID,
    changes,
  );

  return {
    success: true,
    data: {
      quantity: transferQuantity,
      changes,
    },
  };
}

function buildMovedItemState(currentItem, destinationLocationID, destinationFlagID) {
  const nextState = {
    ...currentItem,
    locationID: destinationLocationID,
    flagID: destinationFlagID,
  };

  // Only the categories that actually occupy a fitting slot carry a
  // moduleState: 7 modules, 32 strategic-cruiser subsystems, 66 structure
  // modules -- the three that validateHostFittingCategoryRestriction() in
  // fitting/liveFittingState.js accepts into a host's slots. Charges share
  // their parent module's flag without being modules; drones, cargo and
  // everything else never occupy a slot at all.
  const categoryID = toNumber(currentItem.categoryID, 0);
  const isFittableModule =
    categoryID === MODULE_CATEGORY_ID ||
    categoryID === SUBSYSTEM_CATEGORY_ID ||
    categoryID === STRUCTURE_MODULE_CATEGORY_ID;
  // Structure service slots (164-171) stay offline on the move. Onlining a
  // service module costs fuel, so the fuel-gated auto-online in invBroker
  // decides whether it comes up; it skips any module already marked online.
  const destinationFlag = toNumber(destinationFlagID, 0);
  const isStructureServiceSlot = destinationFlag >= 164 && destinationFlag <= 171;
  if (isFittableModule && isFittingFlag(destinationFlagID) && !isStructureServiceSlot) {
    // CCP parity: modules and subsystems auto-online when fitted to a ship
    // slot.  The client expects fitted modules to be online so that
    // CPU/powergrid load is reflected correctly in the fitting window.
    nextState.moduleState = normalizeModuleState({
      ...(currentItem.moduleState || {}),
      online: true,
    });
  } else if (isFittableModule) {
    nextState.moduleState = normalizeModuleState({
      ...(currentItem.moduleState || {}),
      online: false,
    });
  }

  return nextState;
}

function isCargoContainerInventoryItem(item) {
  return Boolean(
    item &&
      toNumber(item.categoryID, 0) === 2 &&
      CARGO_CONTAINER_GROUP_IDS.has(toNumber(item.groupID, 0)),
  );
}

function normalizeIdempotentGrantReceiptKey(value) {
  const receiptKey = String(value || "").trim();
  return receiptKey && receiptKey.length <= 512 && !receiptKey.includes("/")
    ? receiptKey
    : "";
}

function buildIdempotentGrantReceiptStorageKey(receiptKey) {
  const normalized = normalizeIdempotentGrantReceiptKey(receiptKey);
  return normalized ? encodeURIComponent(normalized) : "";
}

// Read-only lookup. Never create through this seam inside a mutation — an
// in-place ledger edit is invisible to the row-overlay plan and survives a
// rejected write. Use stageIdempotentGrantReceiptLedger() below instead.
function getIdempotentGrantReceiptLedger(items, create = false) {
  const existing = items && items[IDEMPOTENT_GRANT_RECEIPTS_KEY];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing;
  }
  if (!create || !items || typeof items !== "object") {
    return null;
  }
  const ledger = {};
  items[IDEMPOTENT_GRANT_RECEIPTS_KEY] = ledger;
  return ledger;
}

// The row-overlay mutation plan is shallow: it can restore a whole row it was
// asked to replace, but never an in-place edit inside a row it merely handed
// out. The receipt ledger is one such row, so every receipt write copies the
// ledger first and assigns the copy back — the plan then owns the ledger exactly
// like any item row, and a rejected write leaves the live ledger untouched.
function stageIdempotentGrantReceiptLedger(items) {
  // A mutation plan stages receipts in an overlay it applies on commit, so it
  // does not pay for a copy of every receipt ever written.
  const stagePlanLedger = items && items[ITEM_ROW_PLAN_LEDGER];
  const planLedger = typeof stagePlanLedger === "function" ? stagePlanLedger() : null;
  if (planLedger) {
    return planLedger;
  }
  const ledger = { ...(getIdempotentGrantReceiptLedger(items, false) || {}) };
  items[IDEMPOTENT_GRANT_RECEIPTS_KEY] = ledger;
  return ledger;
}

function attachIdempotentInventoryReceipt(items, receipt) {
  const storageKey = buildIdempotentGrantReceiptStorageKey(
    receipt && receipt.receiptKey,
  );
  if (!receipt || !storageKey) {
    return null;
  }
  const ledger = stageIdempotentGrantReceiptLedger(items);
  ledger[storageKey] = cloneValue(receipt);
  return {
    record: ledger[storageKey],
    path: `/${IDEMPOTENT_GRANT_RECEIPTS_KEY}/${storageKey}`,
  };
}

function collectReceiptItemIDs(changes) {
  const itemIDs = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const itemID = toNumber(change && change.item && change.item.itemID, 0);
    if (itemID > 0 && !itemIDs.includes(itemID)) {
      itemIDs.push(itemID);
    }
  }
  return itemIDs;
}

function readReceiptItemIDs(receipt) {
  const stored = receipt && receipt.resultData && receipt.resultData.itemIDs;
  return (Array.isArray(stored) ? stored : [])
    .map((value) => toNumber(value, 0))
    .filter((itemID) => itemID > 0);
}

function resolveReceiptItems(items, receipt) {
  const source = items && typeof items === "object" ? items : readItems();
  return readReceiptItemIDs(receipt)
    .map((itemID) => source[String(itemID)])
    .filter(Boolean)
    .map((item) => cloneValue(item));
}

function attachIdempotentGrantReceiptForEntries(items, entries, grantedItemIDs) {
  if (!Array.isArray(entries) || entries.length <= 0) {
    return null;
  }
  const receipts = entries.map((entry) => {
    const options =
      entry && entry.options && typeof entry.options === "object"
        ? entry.options
        : null;
    return options &&
      options.__evejsIdempotentGrantReceipt &&
      typeof options.__evejsIdempotentGrantReceipt === "object"
      ? options.__evejsIdempotentGrantReceipt
      : null;
  }).filter(Boolean);
  // A batch owns exactly one receipt. Refuse to persist a receipt if callers
  // accidentally supplied more than one internal marker.
  const receipt = receipts.length === 1 ? receipts[0] : null;
  const storageKey = buildIdempotentGrantReceiptStorageKey(
    receipt && receipt.receiptKey,
  );
  if (!receipt || !storageKey) {
    return null;
  }
  // A grant that replays after a crash has to be able to name the rows it
  // created, or every later saga step is left guessing which stack is theirs.
  // The identity joins the same write as the grant itself, so a receipt can
  // never claim rows the inventory write did not commit.
  const itemIDs = (Array.isArray(grantedItemIDs) ? grantedItemIDs : [])
    .map((value) => toNumber(value, 0))
    .filter((itemID) => itemID > 0);
  if (itemIDs.length > 0) {
    receipt.resultData = {
      ...(receipt.resultData && typeof receipt.resultData === "object"
        ? receipt.resultData
        : {}),
      itemIDs,
    };
  }
  return attachIdempotentInventoryReceipt(items, receipt);
}

function executeIdempotentInventoryMutation(options, operation, executor) {
  const inventoryMoveBatch = options && options.inventoryMoveBatch;
  const batchError = inventoryMoveBatchError(inventoryMoveBatch);
  if (batchError) return batchError;
  if (inventoryMoveBatch && ![
    "move-item-to-location", "transfer-item-to-owner-location",
  ].includes(operation)) {
    return { success: false, durable: false, ambiguous: false,
      errorMsg: "INVENTORY_MOVE_BATCH_OPERATION_UNSUPPORTED" };
  }
  ensureMigrated();
  const receiptKey = normalizeIdempotentGrantReceiptKey(
    options && options.receiptKey,
  );
  const storageKey = buildIdempotentGrantReceiptStorageKey(receiptKey);
  const fingerprint = options && options.fingerprint &&
    typeof options.fingerprint === "object"
    ? cloneValue(options.fingerprint)
    : null;
  if (!receiptKey || !storageKey || !fingerprint) {
    return {
      success: false,
      durable: false,
      ambiguous: false,
      errorMsg: "INVALID_IDEMPOTENCY_KEY",
    };
  }

  const items = readItems();
  const ledger = getIdempotentGrantReceiptLedger(items, false);
  const existingReceipt = ledger && ledger[storageKey] &&
    typeof ledger[storageKey] === "object"
    ? cloneValue(ledger[storageKey])
    : null;
  if (existingReceipt) {
    if (
      String(existingReceipt.receiptKey || "") !== receiptKey ||
      String(existingReceipt.operation || "") !== operation ||
      !isDeepStrictEqual(existingReceipt.fingerprint, fingerprint)
    ) {
      return {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH",
        receipt: existingReceipt,
      };
    }
    const receiptResult = getIdempotentGrantReceipt(receiptKey, {
      requireDurable: true,
      inventoryMoveBatch,
    });
    if (!receiptResult.success) {
      return { ...receiptResult, receipt: existingReceipt };
    }
    const committedData = cloneValue(existingReceipt.resultData || {});
    return {
      success: true,
      duplicate: true,
      durable: receiptResult.durable === true,
      pending: receiptResult.pending === true,
      receipt: receiptResult.data,
      data: {
        ...committedData,
        committedChanges: cloneValue(committedData.changes || []),
        changes: [],
      },
    };
  }

  const receipt = {
    schemaVersion: 3,
    receiptKey,
    state: "completed",
    operation,
    fingerprint,
    completedAtMs: normalizeTimestampMs(
      options && options.completedAtMs,
    ) || Date.now(),
    metadata: options && options.receiptMetadata &&
      typeof options.receiptMetadata === "object"
      ? cloneValue(options.receiptMetadata)
      : null,
  };
  let mutationResult;
  try {
    mutationResult = executor(receipt);
  } catch (error) {
    const postErrorLedger = getIdempotentGrantReceiptLedger(readItems(), false);
    const writeMayHaveStarted = Boolean(
      postErrorLedger && postErrorLedger[storageKey],
    );
    if (writeMayHaveStarted) {
      uncertainIdempotentGrantReceipts.set(receiptKey, "write");
    }
    return {
      success: false,
      durable: false,
      ambiguous: writeMayHaveStarted,
      errorMsg: writeMayHaveStarted
        ? "IDEMPOTENT_INVENTORY_WRITE_OUTCOME_AMBIGUOUS"
        : String(error && error.message || "IDEMPOTENT_INVENTORY_MUTATION_FAILED"),
      receipt: writeMayHaveStarted ? cloneValue(receipt) : null,
    };
  }
  if (!mutationResult || mutationResult.success !== true) {
    const postErrorLedger = getIdempotentGrantReceiptLedger(readItems(), false);
    const writeMayHaveStarted = Boolean(
      postErrorLedger && postErrorLedger[storageKey],
    );
    if (writeMayHaveStarted) {
      uncertainIdempotentGrantReceipts.set(receiptKey, "write");
      return {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENT_INVENTORY_WRITE_OUTCOME_AMBIGUOUS",
        receipt: cloneValue(receipt),
        mutationResult,
      };
    }
    return {
      ...mutationResult,
      durable: false,
      ambiguous: false,
    };
  }

  const committedLedger = getIdempotentGrantReceiptLedger(readItems(), false);
  const committedReceipt = committedLedger && committedLedger[storageKey] &&
    typeof committedLedger[storageKey] === "object"
    ? cloneValue(committedLedger[storageKey])
    : null;
  if (!committedReceipt) {
    return {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: "IDEMPOTENT_INVENTORY_RECEIPT_MISSING",
      mutationResult,
    };
  }
  if (inventoryMoveBatch) {
    enlistInventoryMoveBatch(inventoryMoveBatch, receiptKey);
    return {
      ...mutationResult,
      duplicate: false,
      durable: false,
      pending: true,
      ambiguous: false,
      receipt: committedReceipt,
    };
  }
  const flushResult = flushIdempotentGrantReceiptBoundary(receiptKey);
  if (!flushResult.success) {
    return {
      ...flushResult,
      receipt: committedReceipt,
      mutationResult,
    };
  }
  return {
    ...mutationResult,
    duplicate: false,
    durable: true,
    ambiguous: false,
    receipt: committedReceipt,
  };
}

function flushIdempotentGrantReceiptBoundary(receiptKey) {
  let flushResult;
  try {
    flushResult = repo.flushTableSync(ITEMS_TABLE);
  } catch (error) {
    flushResult = { success: false, errorMsg: String(error && error.message || error) };
  }
  if (!flushResult || flushResult.success !== true) {
    uncertainIdempotentGrantReceipts.set(receiptKey, "flush");
    return {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: flushResult && flushResult.errorMsg ||
        "IDEMPOTENT_GRANT_RECEIPT_FLUSH_FAILED",
    };
  }
  uncertainIdempotentGrantReceipts.delete(receiptKey);
  settleInventoryMoveBatches();
  return { success: true, durable: true };
}

function getIdempotentGrantReceipt(receiptKey, options = {}) {
  const inventoryMoveBatch = options && options.inventoryMoveBatch;
  const batchError = inventoryMoveBatchError(inventoryMoveBatch);
  if (batchError) return { ...batchError, data: null };
  ensureMigrated();
  const normalizedReceiptKey = normalizeIdempotentGrantReceiptKey(receiptKey);
  const storageKey = buildIdempotentGrantReceiptStorageKey(normalizedReceiptKey);
  if (!normalizedReceiptKey || !storageKey) {
    return {
      success: false,
      durable: false,
      ambiguous: false,
      errorMsg: "INVALID_IDEMPOTENCY_KEY",
      data: null,
    };
  }
  let uncertainty = uncertainIdempotentGrantReceipts.get(normalizedReceiptKey) || "";
  if (uncertainty === "write" && options.reconcileWriteRefusal === true) {
    // A refused admission may leave no mutation at all. Fence admitted rows,
    // then compare the exact receipt against SQLite before releasing that
    // process-local quarantine. Never retry against divergent cached state.
    const cached = getIdempotentGrantReceiptLedger(readItems(), false)?.[storageKey] || null;
    const fenced = repo.flushTableSync(ITEMS_TABLE);
    if (!fenced?.success) return fenced;
    const durable = database.readPersisted(ITEMS_TABLE, `/${IDEMPOTENT_GRANT_RECEIPTS_KEY}/${storageKey}`);
    if ((durable?.success || durable?.errorMsg === "ENTRY_NOT_FOUND") && isDeepStrictEqual(cached, durable.data || null)) {
      uncertainIdempotentGrantReceipts.delete(normalizedReceiptKey);
      uncertainty = "";
    }
  }
  if (uncertainty === "write") {
    return {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: "IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS",
      data: null,
    };
  }
  const items = readItems();
  const ledger = getIdempotentGrantReceiptLedger(items, false);
  const receipt = ledger && ledger[storageKey] && typeof ledger[storageKey] === "object"
    ? cloneValue(ledger[storageKey])
    : null;
  // Absence has no durability claim to fence. A pending receipt may bypass the
  // fence only for the exact still-open scope that staged it, without errors.
  const state = inventoryMoveBatch && inventoryMoveBatches.get(inventoryMoveBatch);
  const pending = Boolean(receipt && state && !uncertainty &&
    state.receiptKeys.has(normalizedReceiptKey));
  if (receipt && options.requireDurable !== false && !pending) {
    const flushResult = flushIdempotentGrantReceiptBoundary(normalizedReceiptKey);
    if (!flushResult.success) {
      return { ...flushResult, data: null };
    }
  }
  return {
    success: true,
    durable: Boolean(receipt && options.requireDurable !== false && !pending),
    pending,
    found: Boolean(receipt),
    data: receipt,
  };
}

// Receipts are durable by design and nothing ever retired one, so a ledger only
// ever grew. A receipt whose command can never be replayed again — its source
// died with an earlier process — is both dead weight and a trap for a later
// command that derives the same key. Only the module that wrote a receipt family
// can prove which of its rows are dead, so it supplies the predicate.
function pruneIdempotentGrantReceipts(predicate) {
  ensureMigrated();
  if (typeof predicate !== "function") {
    return {
      success: false,
      removed: 0,
      errorMsg: "INVALID_RECEIPT_PRUNE_PREDICATE",
    };
  }
  const ledger = getIdempotentGrantReceiptLedger(readItems(), false);
  if (!ledger) {
    return { success: true, removed: 0, removedReceiptKeys: [] };
  }

  const doomedStorageKeys = [];
  const removedReceiptKeys = [];
  for (const [storageKey, receipt] of Object.entries(ledger)) {
    if (!receipt || typeof receipt !== "object") {
      continue;
    }
    let dead = false;
    try {
      dead = predicate(cloneValue(receipt)) === true;
    } catch (error) {
      log.warn(
        `[ItemStore] Receipt prune predicate failed for ${storageKey}: ${error.message}`,
      );
      dead = false;
    }
    if (dead) {
      doomedStorageKeys.push(storageKey);
      removedReceiptKeys.push(String(receipt.receiptKey || ""));
    }
  }
  return deleteIdempotentGrantReceipts(doomedStorageKeys, removedReceiptKeys);
}

// The same retirement for a caller that knows its receipt keys, so a finished
// operation costs its own receipts rather than a scan of the whole ledger. The
// caller must already have proved that nothing will replay those keys.
function retireIdempotentGrantReceipts(receiptKeys) {
  ensureMigrated();
  const ledger = getIdempotentGrantReceiptLedger(readItems(), false);
  if (!ledger || !Array.isArray(receiptKeys)) {
    return { success: true, removed: 0, removedReceiptKeys: [] };
  }
  const doomedStorageKeys = [];
  const removedReceiptKeys = [];
  for (const value of new Set(receiptKeys.map(normalizeIdempotentGrantReceiptKey))) {
    const storageKey = value ? buildIdempotentGrantReceiptStorageKey(value) : "";
    if (storageKey && Object.prototype.hasOwnProperty.call(ledger, storageKey)) {
      doomedStorageKeys.push(storageKey);
      removedReceiptKeys.push(value);
    }
  }
  return deleteIdempotentGrantReceipts(doomedStorageKeys, removedReceiptKeys);
}

function deleteIdempotentGrantReceipts(doomedStorageKeys, removedReceiptKeys) {
  if (doomedStorageKeys.length === 0) {
    return { success: true, removed: 0, removedReceiptKeys: [] };
  }

  const mutationPlan = createItemRowMutationPlan();
  const stagedLedger = stageIdempotentGrantReceiptLedger(mutationPlan.items);
  for (const storageKey of doomedStorageKeys) {
    delete stagedLedger[storageKey];
  }
  if (!mutationPlan.commit({
    knownChangedPaths: doomedStorageKeys.map(
      (storageKey) => `/${IDEMPOTENT_GRANT_RECEIPTS_KEY}/${storageKey}`,
    ),
  })) {
    return {
      success: false,
      removed: 0,
      errorMsg: "IDEMPOTENT_GRANT_RECEIPT_PRUNE_FAILED",
    };
  }
  // Only a committed prune may retire the process-local uncertainty markers:
  // a rejected write leaves both the ledger and the markers exactly as found.
  for (const receiptKey of removedReceiptKeys) {
    uncertainIdempotentGrantReceipts.delete(receiptKey);
  }
  return {
    success: true,
    removed: doomedStorageKeys.length,
    removedReceiptKeys,
  };
}

function grantItemToOwnerLocationIdempotent(
  ownerId,
  locationId,
  flagId,
  itemType,
  quantity = 1,
  options = {},
) {
  ensureMigrated();
  const receiptKey = normalizeIdempotentGrantReceiptKey(options.receiptKey);
  const storageKey = buildIdempotentGrantReceiptStorageKey(receiptKey);
  const numericOwnerID = toNumber(ownerId, 0);
  const numericLocationID = toNumber(locationId, 0);
  const numericFlagID = toNumber(flagId, ITEM_FLAGS.HANGAR);
  const normalizedQuantity = normalizePositiveSafeInteger(quantity, null);
  const metadata = resolveItemTypeReference(itemType);
  const numericTypeID = toNumber(metadata && metadata.typeID, 0);
  if (!receiptKey || !storageKey) {
    return { success: false, ambiguous: false, errorMsg: "INVALID_IDEMPOTENCY_KEY" };
  }
  if (
    numericOwnerID <= 0 ||
    numericLocationID <= 0 ||
    numericTypeID <= 0 ||
    !normalizedQuantity
  ) {
    return {
      success: false,
      ambiguous: false,
      errorMsg: numericTypeID <= 0
        ? "ITEM_TYPE_NOT_FOUND"
        : !normalizedQuantity
          ? "ITEM_QUANTITY_OUT_OF_RANGE"
          : "INVALID_GRANT_DESTINATION",
    };
  }

  const items = readItems();
  const ledger = getIdempotentGrantReceiptLedger(items, false);
  const existingReceipt = ledger && ledger[storageKey] && typeof ledger[storageKey] === "object"
    ? cloneValue(ledger[storageKey])
    : null;
  if (existingReceipt) {
    const receiptMatches = Boolean(
      String(existingReceipt.receiptKey || "") === receiptKey &&
      toNumber(existingReceipt.ownerID, 0) === numericOwnerID &&
      toNumber(existingReceipt.locationID, 0) === numericLocationID &&
      toNumber(existingReceipt.flagID, 0) === numericFlagID &&
      toNumber(existingReceipt.typeID, 0) === numericTypeID &&
      toNumber(existingReceipt.quantity, 0) === normalizedQuantity
      && Boolean(existingReceipt.onlyIfMissing) === Boolean(options.onlyIfMissing)
    );
    if (!receiptMatches) {
      return {
        success: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH",
        receipt: existingReceipt,
      };
    }
    const receiptResult = getIdempotentGrantReceipt(receiptKey, {
      requireDurable: true,
    });
    if (!receiptResult.success) {
      return { ...receiptResult, receipt: existingReceipt };
    }
    // Replays are silent about *changes* on purpose — the mutation already
    // happened once and must not be re-notified — but they still name the rows
    // the original grant produced so a resumed saga can pick its work back up.
    return {
      success: true,
      duplicate: true,
      durable: true,
      receipt: receiptResult.data,
      data: {
        itemType: cloneValue(metadata),
        quantity: normalizedQuantity,
        items: resolveReceiptItems(items, receiptResult.data),
        itemIDs: readReceiptItemIDs(receiptResult.data),
        changes: [],
        grantedEntries: [{
          itemType: cloneValue(metadata),
          quantity: normalizedQuantity,
        }],
      },
    };
  }

  const grantedAtMs = normalizeTimestampMs(options.grantedAtMs) || Date.now();
  const receipt = {
    schemaVersion: 1,
    receiptKey,
    state: "completed",
    ownerID: numericOwnerID,
    locationID: numericLocationID,
    flagID: numericFlagID,
    typeID: numericTypeID,
    quantity: normalizedQuantity,
    grantedAtMs,
    ...(options.onlyIfMissing ? { onlyIfMissing: true } : {}),
    metadata: options.receiptMetadata && typeof options.receiptMetadata === "object"
      ? cloneValue(options.receiptMetadata)
      : null,
  };
  const {
    receiptKey: _ignoredReceiptKey,
    receiptMetadata: _ignoredReceiptMetadata,
    grantedAtMs: _ignoredGrantedAtMs,
    requireDurable: _ignoredRequireDurable,
    onlyIfMissing: _ignoredOnlyIfMissing,
    __evejsIdempotentGrantReceipt: _ignoredInternalReceipt,
    ...grantOptions
  } = options;
  let grantResult;
  try {
    if (options.onlyIfMissing === true) {
      const matching = Object.values(items).filter((item) => Number(item?.ownerID) === numericOwnerID && Number(item.locationID) === numericLocationID && Number(item.flagID) === numericFlagID && Number(item.typeID) === numericTypeID && Number(item.quantity) > 0);
      if (matching.length) {
        receipt.resultData = { itemIDs: matching.map((item) => item.itemID), skippedExisting: true };
        const attached = attachIdempotentInventoryReceipt(items, receipt);
        if (!writeItems(items, { knownChangedPaths: [attached.path] })) return { success: false, errorMsg: "WRITE_ERROR" };
        const flushed = flushIdempotentGrantReceiptBoundary(receiptKey);
        if (!flushed.success) return flushed;
        return { success: true, durable: true, receipt, data: { items: matching.map(cloneValue), quantity: 0, changes: [] } };
      }
    }
    grantResult = grantItemToOwnerLocation(
      numericOwnerID,
      numericLocationID,
      numericFlagID,
      metadata,
      normalizedQuantity,
      {
        ...grantOptions,
        // Both character- and non-character grant paths attach this receipt
        // immediately before their sole writeItems() call. It therefore joins
        // the inventory mutation in the same SQLite table transaction, while
        // validation failures never leave a receipt-only cache mutation.
        __evejsIdempotentGrantReceipt: receipt,
      },
    );
  } catch (error) {
    const postErrorItems = readItems();
    const postErrorLedger = getIdempotentGrantReceiptLedger(postErrorItems, false);
    const writeMayHaveStarted = Boolean(postErrorLedger && postErrorLedger[storageKey]);
    if (writeMayHaveStarted) {
      uncertainIdempotentGrantReceipts.set(receiptKey, "write");
    }
    return {
      success: false,
      durable: false,
      ambiguous: writeMayHaveStarted,
      errorMsg: writeMayHaveStarted
        ? "IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS"
        : String(error && error.message || "IDEMPOTENT_GRANT_FAILED"),
      receipt: writeMayHaveStarted ? cloneValue(receipt) : null,
    };
  }
  if (!grantResult || grantResult.success !== true) {
    if (grantResult && grantResult.errorMsg === "WRITE_ERROR") {
      uncertainIdempotentGrantReceipts.set(receiptKey, "write");
      return {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS",
        receipt: cloneValue(receipt),
        grantResult,
      };
    }
    return {
      success: false,
      durable: false,
      ambiguous: false,
      errorMsg: grantResult && grantResult.errorMsg || "IDEMPOTENT_GRANT_FAILED",
      grantResult,
    };
  }
  const flushResult = flushIdempotentGrantReceiptBoundary(receiptKey);
  if (!flushResult.success) {
    return {
      ...flushResult,
      receipt: cloneValue(receipt),
      grantResult,
    };
  }
  return {
    success: true,
    duplicate: false,
    durable: true,
    receipt: cloneValue(receipt),
    data: grantResult.data,
    grantResult,
  };
}

function normalizeIdempotentGrantBatch(grantEntries) {
  const entries = Array.isArray(grantEntries)
    ? grantEntries.filter(Boolean)
    : [];
  if (entries.length <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_GRANT_MANIFEST_EMPTY",
    };
  }
  const validationError = validateGrantEntries(entries);
  if (validationError) {
    return validationError;
  }

  const manifestByTypeID = new Map();
  const normalizedEntries = [];
  for (const entry of entries) {
    const metadata = resolveItemTypeReference(entry.itemType);
    const typeID = toNumber(metadata && metadata.typeID, 0);
    const quantity = normalizePositiveSafeInteger(entry.quantity, null);
    const previousQuantity = manifestByTypeID.get(typeID) || 0;
    const combinedQuantity = previousQuantity + quantity;
    if (!Number.isSafeInteger(combinedQuantity) || combinedQuantity <= 0) {
      return {
        success: false,
        errorMsg: "ITEM_QUANTITY_OUT_OF_RANGE",
      };
    }
    manifestByTypeID.set(typeID, combinedQuantity);
    const entryOptions = entry.options && typeof entry.options === "object"
      ? entry.options
      : {};
    const {
      __evejsIdempotentGrantReceipt: _ignoredInternalReceipt,
      ...safeEntryOptions
    } = entryOptions;
    normalizedEntries.push({
      itemType: metadata,
      quantity,
      options: safeEntryOptions,
    });
  }
  const manifest = [...manifestByTypeID.entries()]
    .map(([typeID, quantity]) => ({ typeID, quantity }))
    .sort((left, right) => left.typeID - right.typeID);
  return {
    success: true,
    entries: normalizedEntries,
    manifest,
  };
}

function grantItemsToOwnerLocationIdempotent(
  ownerId,
  locationId,
  flagId,
  grantEntries = [],
  options = {},
) {
  ensureMigrated();
  const receiptKey = normalizeIdempotentGrantReceiptKey(options.receiptKey);
  const storageKey = buildIdempotentGrantReceiptStorageKey(receiptKey);
  const numericOwnerID = toNumber(ownerId, 0);
  const numericLocationID = toNumber(locationId, 0);
  const numericFlagID = toNumber(flagId, ITEM_FLAGS.HANGAR);
  if (!receiptKey || !storageKey) {
    return { success: false, ambiguous: false, errorMsg: "INVALID_IDEMPOTENCY_KEY" };
  }
  if (numericOwnerID <= 0 || numericLocationID <= 0) {
    return {
      success: false,
      ambiguous: false,
      errorMsg: "INVALID_GRANT_DESTINATION",
    };
  }
  const normalizedBatch = normalizeIdempotentGrantBatch(grantEntries);
  if (!normalizedBatch.success) {
    return {
      ...normalizedBatch,
      ambiguous: false,
    };
  }
  const { entries, manifest } = normalizedBatch;

  const items = readItems();
  const ledger = getIdempotentGrantReceiptLedger(items, false);
  const existingReceipt = ledger && ledger[storageKey] && typeof ledger[storageKey] === "object"
    ? cloneValue(ledger[storageKey])
    : null;
  if (existingReceipt) {
    const receiptManifest = Array.isArray(existingReceipt.manifest)
      ? existingReceipt.manifest
      : [];
    const receiptMatches = Boolean(
      String(existingReceipt.receiptKey || "") === receiptKey &&
      toNumber(existingReceipt.ownerID, 0) === numericOwnerID &&
      toNumber(existingReceipt.locationID, 0) === numericLocationID &&
      toNumber(existingReceipt.flagID, 0) === numericFlagID &&
      JSON.stringify(receiptManifest) === JSON.stringify(manifest)
    );
    if (!receiptMatches) {
      return {
        success: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH",
        receipt: existingReceipt,
      };
    }
    const receiptResult = getIdempotentGrantReceipt(receiptKey, {
      requireDurable: true,
    });
    if (!receiptResult.success) {
      return { ...receiptResult, receipt: existingReceipt };
    }
    return {
      success: true,
      duplicate: true,
      durable: true,
      receipt: receiptResult.data,
      data: {
        quantity: manifest.reduce((sum, entry) => sum + entry.quantity, 0),
        items: resolveReceiptItems(items, receiptResult.data),
        itemIDs: readReceiptItemIDs(receiptResult.data),
        changes: [],
        grantedEntries: entries.map((entry) => ({
          itemType: cloneValue(entry.itemType),
          quantity: entry.quantity,
        })),
      },
    };
  }

  const grantedAtMs = normalizeTimestampMs(options.grantedAtMs) || Date.now();
  const receipt = {
    schemaVersion: 2,
    receiptKey,
    state: "completed",
    ownerID: numericOwnerID,
    locationID: numericLocationID,
    flagID: numericFlagID,
    manifest: cloneValue(manifest),
    grantedAtMs,
    metadata: options.receiptMetadata && typeof options.receiptMetadata === "object"
      ? cloneValue(options.receiptMetadata)
      : null,
  };
  const entriesWithReceipt = entries.map((entry, index) => ({
    ...entry,
    options: index === 0
      ? {
          ...entry.options,
          // The receipt is attached immediately before grantItemsToOwnerLocation's
          // sole writeItems() call, so every manifest row and its receipt commit
          // together or none of them do.
          __evejsIdempotentGrantReceipt: receipt,
        }
      : entry.options,
  }));
  let grantResult;
  try {
    grantResult = grantItemsToOwnerLocation(
      numericOwnerID,
      numericLocationID,
      numericFlagID,
      entriesWithReceipt,
    );
  } catch (error) {
    const postErrorItems = readItems();
    const postErrorLedger = getIdempotentGrantReceiptLedger(postErrorItems, false);
    const writeMayHaveStarted = Boolean(postErrorLedger && postErrorLedger[storageKey]);
    if (writeMayHaveStarted) {
      uncertainIdempotentGrantReceipts.set(receiptKey, "write");
    }
    return {
      success: false,
      durable: false,
      ambiguous: writeMayHaveStarted,
      errorMsg: writeMayHaveStarted
        ? "IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS"
        : String(error && error.message || "IDEMPOTENT_GRANT_FAILED"),
      receipt: writeMayHaveStarted ? cloneValue(receipt) : null,
    };
  }
  if (!grantResult || grantResult.success !== true) {
    if (grantResult && grantResult.errorMsg === "WRITE_ERROR") {
      uncertainIdempotentGrantReceipts.set(receiptKey, "write");
      return {
        success: false,
        durable: false,
        ambiguous: true,
        errorMsg: "IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS",
        receipt: cloneValue(receipt),
        grantResult,
      };
    }
    return {
      success: false,
      durable: false,
      ambiguous: false,
      errorMsg: grantResult && grantResult.errorMsg || "IDEMPOTENT_GRANT_FAILED",
      grantResult,
    };
  }
  const flushResult = flushIdempotentGrantReceiptBoundary(receiptKey);
  if (!flushResult.success) {
    return {
      ...flushResult,
      receipt: cloneValue(receipt),
      grantResult,
    };
  }
  return {
    success: true,
    duplicate: false,
    durable: true,
    receipt: cloneValue(receipt),
    data: grantResult.data,
    grantResult,
  };
}

function validateItemMoveDestination(items, currentItem, destinationLocationID) {
  const sourceItemID = toNumber(currentItem && currentItem.itemID, 0);
  const numericDestinationLocationID = toNumber(destinationLocationID, 0);
  if (sourceItemID <= 0 || numericDestinationLocationID <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  if (sourceItemID === numericDestinationLocationID) {
    return {
      success: false,
      errorMsg: ITEM_MOVE_ERROR.CYCLE,
    };
  }

  const destinationItem = normalizeInventoryItem(
    items[String(numericDestinationLocationID)],
  );
  let ancestor = destinationItem;
  const seen = new Set();
  while (ancestor) {
    const ancestorItemID = toNumber(ancestor.itemID, 0);
    if (ancestorItemID === sourceItemID || seen.has(ancestorItemID)) {
      return {
        success: false,
        errorMsg: ITEM_MOVE_ERROR.CYCLE,
      };
    }
    seen.add(ancestorItemID);

    const parentLocationID = toNumber(ancestor.locationID, 0);
    if (parentLocationID <= 0) {
      break;
    }
    ancestor = normalizeInventoryItem(items[String(parentLocationID)]);
  }

  if (
    isCargoContainerInventoryItem(currentItem) &&
    isCargoContainerInventoryItem(destinationItem)
  ) {
    return {
      success: false,
      errorMsg: ITEM_MOVE_ERROR.CONTAINER_NESTING,
    };
  }

  // A packaged container is a stack of goods, not a place. It has to be
  // assembled before it holds anything; the client never offers a packaged
  // can as a drop target, so only a forged call reaches this.
  if (
    isCargoContainerInventoryItem(destinationItem) &&
    toNumber(destinationItem.singleton, 0) !== 1
  ) {
    return {
      success: false,
      errorMsg: ITEM_MOVE_ERROR.CONTAINER_NOT_ASSEMBLED,
    };
  }

  return { success: true };
}

function validateItemMoveToLocation(itemId, destinationLocationId) {
  ensureMigrated();
  const numericItemID = toNumber(itemId, 0);
  const destinationLocationID = toNumber(destinationLocationId, 0);
  const items = readItems();
  const currentItem = normalizeInventoryItem(items[String(numericItemID)]);
  if (!currentItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }
  return validateItemMoveDestination(
    items,
    currentItem,
    destinationLocationID,
  );
}

// A destination that assembles what lands in it (a ship fitting slot, or a
// structure deed slot taking a quantum core) holds exactly ONE unit. Anything
// beyond the first unit of the requested move has nowhere to go, and the move
// primitives used to consume the whole request while writing a single
// singleton row — silently destroying the remainder.
//
// Conserve it instead:
// - No quantity named means "move this row", which at a slot is the retail
//   one-module fit: split a single unit off and leave the rest in the source.
// - An explicit quantity above one is a caller mistake (the client fits one
//   module per drag). Refuse it rather than quietly moving a different amount
//   than the caller asked for, so the bug surfaces instead of eating items.
function resolveSingletonDestinationQuantity(
  convertToSingleton,
  moveQuantity,
  quantityRequested,
) {
  if (!convertToSingleton || moveQuantity <= 1) {
    return { success: true, moveQuantity };
  }
  if (quantityRequested) {
    return {
      success: false,
      errorMsg: "SINGLETON_QUANTITY_INVALID",
    };
  }
  return { success: true, moveQuantity: 1 };
}

function stageItemMoveToLocation(
  items,
  characters,
  itemId,
  destinationLocationId,
  destinationFlagId,
  quantity = null,
) {
  const numericItemId = toNumber(itemId, 0);
  const destinationLocationID = toNumber(destinationLocationId, 0);
  const destinationFlagID = toNumber(destinationFlagId, ITEM_FLAGS.HANGAR);
  if (numericItemId <= 0 || destinationLocationID <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const rawCurrentItem = items[String(numericItemId)];
  const currentItem = normalizeInventoryItem(rawCurrentItem);
  if (!currentItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const destinationValidation = validateItemMoveDestination(
    items,
    currentItem,
    destinationLocationID,
  );
  if (!destinationValidation.success) {
    return destinationValidation;
  }

  const availableQuantity =
    currentItem.singleton === 1
      ? 1
      : normalizePositiveInteger(currentItem.stacksize, 1);
  const quantityRequested = quantity !== null && quantity !== undefined;
  let moveQuantity = quantityRequested
    ? normalizePositiveInteger(quantity, 1)
    : availableQuantity;
  if (moveQuantity > availableQuantity) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_ITEMS",
    };
  }

  const fittingDestination = isFittingFlag(destinationFlagID);
  // CCP parity: only modules (categoryID 7) become singletons when fitted.
  // Charges (categoryID 8) loaded into a module's flag keep their stack
  // quantity — they are NOT singletons.
  const isChargeCategory = toNumber(currentItem.categoryID, 0) === 8;
  const convertToSingleton =
    (fittingDestination && !isChargeCategory) ||
    (
      destinationFlagID === ITEM_FLAGS.STRUCTURE_DEED &&
      toNumber(currentItem.groupID, 0) === STRUCTURE_DEED_GROUP_ID
    );

  const quantityGuard = resolveSingletonDestinationQuantity(
    convertToSingleton,
    moveQuantity,
    quantityRequested,
  );
  if (!quantityGuard.success) {
    return quantityGuard;
  }
  moveQuantity = quantityGuard.moveQuantity;

  const changes = [];
  const movingWholeItem = currentItem.singleton === 1 || moveQuantity === availableQuantity;
  const movedBase = buildMovedItemState(
    currentItem,
    destinationLocationID,
    destinationFlagID,
  );

  if (movingWholeItem) {
    const previousData = cloneValue(currentItem);
    const destinationSingleton = convertToSingleton ? 1 : currentItem.singleton;
    const singletonConvertedItem =
      convertToSingleton && currentItem.singleton !== 1
        ? buildInventoryItem({
            ...currentItem,
            quantity: null,
            stacksize: 1,
            singleton: 1,
          })
        : null;
    const movedItem = buildInventoryItem({
      ...movedBase,
      quantity:
        destinationSingleton === 1 ? null : moveQuantity,
      stacksize:
        destinationSingleton === 1 ? 1 : moveQuantity,
      singleton: destinationSingleton,
    });
    items[String(movedItem.itemID)] = movedItem;
    if (singletonConvertedItem) {
      changes.push(withRollbackPreviousData({
        removed: false,
        previousData,
        item: cloneValue(singletonConvertedItem),
      }, rawCurrentItem));
      changes.push(withRollbackPreviousData({
        removed: false,
        previousData: cloneValue(singletonConvertedItem),
        item: cloneValue(movedItem),
      }, singletonConvertedItem));
    } else {
      changes.push(withRollbackPreviousData({
        removed: false,
        previousData,
        item: cloneValue(movedItem),
      }, rawCurrentItem));
    }
  } else {
    const sourcePreviousData = cloneValue(currentItem);
    const updatedSource = buildInventoryItem({
      ...currentItem,
      quantity: availableQuantity - moveQuantity,
      stacksize: availableQuantity - moveQuantity,
      singleton: 0,
    });
    items[String(updatedSource.itemID)] = updatedSource;
    changes.push(withRollbackPreviousData({
      removed: false,
      previousData: sourcePreviousData,
      item: cloneValue(updatedSource),
    }, rawCurrentItem));

    const splitSingleton = convertToSingleton ? 1 : 0;
    const nextItem = buildInventoryItem({
      ...movedBase,
      itemID: nextItemID(currentItem.ownerID, items, characters[String(currentItem.ownerID)]),
      quantity: splitSingleton === 1 ? null : moveQuantity,
      stacksize: splitSingleton === 1 ? 1 : moveQuantity,
      singleton: splitSingleton,
      stackOriginID:
        toNumber(currentItem.stackOriginID, 0) > 0
          ? toNumber(currentItem.stackOriginID, 0)
          : currentItem.itemID,
    });
    items[String(nextItem.itemID)] = nextItem;
    changes.push({
      created: true,
      removed: false,
      // CCP parity: a partial-stack move creates a brand-new item row in the
      // destination inventory. The client never knew about this new itemID in
      // the source container, so advertise it as arriving from "outside"
      // instead of as a move from the source stack's previous location.
      previousData: buildCreatedItemNotificationPreviousState(
        nextItem,
        sourcePreviousData.flagID,
        sourcePreviousData.ownerID,
      ),
      item: cloneValue(nextItem),
    });
  }

  return {
    success: true,
    data: {
      quantity: moveQuantity,
      changes,
    },
  };
}

// A mobile deployment's placement and component state depend on the final ID
// allocated by a stack split. Finalize that row inside the same mutation plan
// as the move so neither a refused write nor a crash can leave a bare item in
// space. The callback cannot change the custody identity chosen by the owner.
function finalizeMovedInventoryItem(items, changes, options, ownerID, locationID, flagID) {
  const finalize = options && options.finalizeMovedItem;
  if (finalize === undefined) return { success: true };
  if (typeof finalize !== "function") return { success: false, errorMsg: "INVALID_ITEM_FINALIZER" };
  const change = changes.findLast((entry) => entry && !entry.removed && entry.item &&
    Number(entry.item.ownerID) === Number(ownerID) && Number(entry.item.locationID) === Number(locationID) &&
    Number(entry.item.flagID) === Number(flagID));
  if (!change) return { success: false, errorMsg: "MOVED_ITEM_NOT_FOUND" };
  const previous = change.item;
  const finalized = finalize(cloneValue(previous));
  const item = finalized && typeof finalized === "object"
    ? normalizeInventoryItem(finalized, previous) : null;
  if (!item || item.itemID !== previous.itemID || item.ownerID !== previous.ownerID ||
      item.locationID !== previous.locationID || item.flagID !== previous.flagID || item.typeID !== previous.typeID) {
    return { success: false, errorMsg: "INVALID_ITEM_FINALIZER_STATE" };
  }
  items[String(item.itemID)] = item;
  change.item = cloneValue(item);
  return { success: true };
}

function moveItemToLocation(
  itemId,
  destinationLocationId,
  destinationFlagId,
  quantity = null,
  options = {},
) {
  const inventoryMoveBatch = options && options.inventoryMoveBatch;
  const batchError = inventoryMoveBatchError(inventoryMoveBatch);
  if (batchError) return batchError;
  ensureMigrated();
  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const stageResult = stageItemMoveToLocation(
    items,
    readCharacters(),
    itemId,
    destinationLocationId,
    destinationFlagId,
    quantity,
  );
  if (!stageResult.success) {
    return stageResult;
  }

  const changes = stageResult.data.changes;
  const finalized = finalizeMovedInventoryItem(items, changes, options,
    items[String(toNumber(itemId, 0))]?.ownerID,
    destinationLocationId, destinationFlagId);
  if (!finalized.success) return finalized;
  const receipt = options && options.__evejsIdempotentInventoryReceipt &&
    typeof options.__evejsIdempotentInventoryReceipt === "object"
    ? {
        ...cloneValue(options.__evejsIdempotentInventoryReceipt),
        resultData: cloneValue(stageResult.data),
      }
    : null;
  const attachedReceipt = attachIdempotentInventoryReceipt(items, receipt);
  if (!mutationPlan.commit({
    indexDelta: indexDeltaFromChanges(changes),
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  enlistInventoryMoveBatch(inventoryMoveBatch);
  persistTransientItemsMovedIntoDurableLocation(destinationLocationId, changes);
  notifyInventoryMoveInsurance(changes, "moveItemToLocation", inventoryMoveBatch);

  return {
    success: true,
    ...(inventoryMoveBatch ? { durable: false, pending: true } : {}),
    data: stageResult.data,
  };
}

function moveItemsAndSetShipPackagingState(
  shipId,
  moveRequests,
  packaged,
  options = {},
) {
  ensureMigrated();
  const numericShipID = toNumber(shipId, 0);
  if (numericShipID <= 0) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const characters = readCharacters();
  const originalShip = normalizeInventoryItem(items[String(numericShipID)]);
  if (!originalShip || toNumber(originalShip.categoryID, 0) !== SHIP_CATEGORY_ID) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }

  const destroyItemIDs = options && options.destroyItemIDs !== undefined
    ? options.destroyItemIDs
    : [];
  if (!Array.isArray(destroyItemIDs) || (destroyItemIDs.length > 0 && packaged !== true)) {
    return { success: false, errorMsg: "INVALID_DESTROY_REQUEST" };
  }
  const movingItemIDs = new Set(
    (Array.isArray(moveRequests) ? moveRequests : [])
      .map((request) => toNumber(request && request.itemID, 0)),
  );
  const moveDestinationIDs = new Set(
    (Array.isArray(moveRequests) ? moveRequests : [])
      .map((request) => toNumber(request && request.destinationLocationID, 0)),
  );
  const removalIDs = new Set();
  const removalChanges = [];
  for (const itemID of destroyItemIDs) {
    const numericItemID = toNumber(itemID, 0);
    const rawItem = items[String(numericItemID)];
    const item = normalizeInventoryItem(rawItem);
    // This operation deletes only the ship's own direct contents. In
    // particular, never delete a container and leave its descendants orphaned,
    // or allow a move request to restore an item selected for destruction.
    if (
      !Number.isSafeInteger(numericItemID) ||
      numericItemID <= 0 ||
      numericItemID === numericShipID ||
      removalIDs.has(numericItemID) ||
      movingItemIDs.has(numericItemID) ||
      moveDestinationIDs.has(numericItemID) ||
      !item ||
      toNumber(item.locationID, 0) !== numericShipID ||
      toNumber(item.ownerID, 0) !== toNumber(originalShip.ownerID, 0) ||
      listContainerItems(null, numericItemID, null).length > 0
    ) {
      return { success: false, errorMsg: "INVALID_DESTROY_REQUEST" };
    }
    delete items[String(numericItemID)];
    removalIDs.add(numericItemID);
    removalChanges.push(withRollbackPreviousData({
      removed: true,
      previousData: cloneValue(item),
      item: buildRemovedItemNotificationState(item),
      wasTransient: repo.isTransientPath(ITEMS_TABLE, `/${String(numericItemID)}`),
    }, rawItem));
  }

  let targetShipID = numericShipID;
  let prebuiltUpdatedShip = null;
  let shipPreviousData = cloneValue(originalShip);
  const shipSplitChanges = [];
  const packagedShipQuantity = normalizePositiveInteger(
    originalShip.stacksize ?? originalShip.quantity,
    1,
  );
  if (
    !packaged &&
    toNumber(originalShip.singleton, 0) === 0 &&
    packagedShipQuantity > 1
  ) {
    const sourcePreviousData = cloneValue(originalShip);
    const updatedSourceStack = buildInventoryItem({
      ...originalShip,
      quantity: packagedShipQuantity - 1,
      stacksize: packagedShipQuantity - 1,
      singleton: 0,
    });
    items[String(numericShipID)] = updatedSourceStack;
    shipSplitChanges.push({
      removed: false,
      previousData: sourcePreviousData,
      item: cloneValue(updatedSourceStack),
    });

    targetShipID = nextItemID(
      originalShip.ownerID,
      items,
      characters[String(originalShip.ownerID)],
    );
    prebuiltUpdatedShip = buildInventoryItem({
      ...originalShip,
      itemID: targetShipID,
      quantity: -1,
      stacksize: 1,
      singleton: 1,
      stackOriginID:
        toNumber(originalShip.stackOriginID, 0) > 0
          ? toNumber(originalShip.stackOriginID, 0)
          : originalShip.itemID,
    });
    items[String(targetShipID)] = prebuiltUpdatedShip;
    shipPreviousData = buildCreatedItemNotificationPreviousState(
      prebuiltUpdatedShip,
      originalShip.flagID,
      originalShip.ownerID,
    );
  }

  const moveChanges = [];
  for (const request of Array.isArray(moveRequests) ? moveRequests : []) {
    const requestItemID = toNumber(request && request.itemID, 0);
    if (requestItemID <= 0 || requestItemID === numericShipID) {
      return { success: false, errorMsg: "INVALID_MOVE_REQUEST" };
    }
    const stageResult = stageItemMoveToLocation(
      items,
      characters,
      requestItemID,
      !packaged &&
        toNumber(request && request.destinationLocationID, 0) === numericShipID
        ? targetShipID
        : request && request.destinationLocationID,
      request && request.destinationFlagID,
      request && Object.prototype.hasOwnProperty.call(request, "quantity")
        ? request.quantity
        : null,
    );
    if (!stageResult.success) {
      return stageResult;
    }
    moveChanges.push(...stageResult.data.changes);
  }

  const shipBeforePackaging = normalizeInventoryItem(items[String(targetShipID)]);
  if (!shipBeforePackaging) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }
  const updatedShip = prebuiltUpdatedShip || normalizeInventoryItem({
    ...shipBeforePackaging,
    singleton: packaged ? 0 : 1,
    quantity: packaged ? 1 : -1,
    stacksize: 1,
    // Repackaging strips any custom ship name (see setShipPackagingState). Reset
    // to an explicit type-default rather than null, because normalizeInventoryItem
    // would otherwise fall back to defaults.itemName and resurrect the old name.
    ...(packaged
      ? { itemName: getShipMetadata(shipBeforePackaging.typeID).name || null }
      : {}),
  }, shipBeforePackaging);
  if (!updatedShip) {
    return { success: false, errorMsg: "INVALID_SHIP_STATE" };
  }
  items[String(targetShipID)] = updatedShip;
  const shipChange = {
    removed: false,
    previousData: cloneValue(shipPreviousData),
    item: cloneValue(updatedShip),
  };
  const changes = [...shipSplitChanges, ...removalChanges, ...moveChanges, shipChange];

  if (!mutationPlan.commit({ indexDelta: indexDeltaFromChanges(changes) })) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
  clearTransientItemPaths([...removalIDs]);

  notifyInsuranceInventoryMutationChanges(
    changes,
    "moveItemsAndSetShipPackagingState",
  );
  if (packaged) {
    clearPackagedShipRuntimeState(targetShipID);
  }

  return {
    success: true,
    previousData: cloneValue(shipPreviousData),
    data: cloneValue(updatedShip),
    changes,
    moveChanges,
    removalChanges,
    sourceShipID: numericShipID,
    targetShipID,
  };
}

// Every item physically inside `rootItemID`, at any depth: fitted modules and
// their charges, drones, cargo, and the contents of containers in that cargo.
// Read before anything is staged -- a re-own never moves a descendant, so the
// containment tree the index already holds is the tree that matters.
function collectContainedItemIDs(rootItemID) {
  const numericRootID = toNumber(rootItemID, 0);
  if (numericRootID <= 0) {
    return [];
  }

  const indexes = ensureItemIndexes();
  const containedItemIDs = [];
  const seen = new Set([numericRootID]);
  const pending = [numericRootID];
  while (pending.length > 0) {
    const containerID = pending.pop();
    for (const child of indexes.byLocation.get(containerID) || []) {
      const childItemID = toNumber(child && child.itemID, 0);
      // The seen set is also what terminates a malformed containment cycle.
      if (childItemID <= 0 || seen.has(childItemID)) {
        continue;
      }
      seen.add(childItemID);
      containedItemIDs.push(childItemID);
      pending.push(childItemID);
    }
  }

  return containedItemIDs;
}

function hasCharacterBoundContents(itemID) {
  const items = readItems();
  return [Number(itemID), ...collectContainedItemIDs(itemID)]
    .some(id => Number(items[String(id)]?.careerBoundCharacterID || 0) > 0);
}

function transferItemToOwnerLocation(
  itemId,
  destinationOwnerId,
  destinationLocationId,
  destinationFlagId,
  quantity = null,
  options = {},
) {
  const inventoryMoveBatch = options && options.inventoryMoveBatch;
  const batchError = inventoryMoveBatchError(inventoryMoveBatch);
  if (batchError) return batchError;
  ensureMigrated();
  const numericItemId = toNumber(itemId, 0);
  const destinationOwnerID = toNumber(destinationOwnerId, 0);
  const destinationLocationID = toNumber(destinationLocationId, 0);
  const destinationFlagID = toNumber(destinationFlagId, ITEM_FLAGS.HANGAR);
  if (
    numericItemId <= 0 ||
    destinationOwnerID <= 0 ||
    destinationLocationID <= 0
  ) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const characters = readCharacters();
  const currentItem = normalizeInventoryItem(items[String(numericItemId)]);
  if (!currentItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const lootInfoResult = normalizeOwnerTransferLootInfo(options && options.ownerTransferLootInfo);
  if (!lootInfoResult.success) return lootInfoResult;
  let transferredCustomInfo = null;
  if (lootInfoResult.info) {
    if (options.reownContents !== true || Number(currentItem.singleton) !== 1 ||
        currentItem.ownerID === destinationOwnerID || Number(currentItem.flagID) !== 0 || destinationFlagID !== 0 ||
        Number(currentItem.locationID) !== destinationLocationID || quantity !== null && quantity !== undefined) {
      return { success: false, errorMsg: "OWNER_TRANSFER_LOOT_ROUTE_NOT_SUPPORTED" };
    }
    const replacement = replaceOwnerTransferLootInfo(currentItem.customInfo, lootInfoResult.info);
    if (!replacement.success) return replacement;
    transferredCustomInfo = replacement.customInfo;
  }

  const destinationValidation = validateItemMoveDestination(
    items,
    currentItem,
    destinationLocationID,
  );
  if (!destinationValidation.success) {
    return destinationValidation;
  }

  const availableQuantity =
    currentItem.singleton === 1
      ? 1
      : normalizePositiveInteger(currentItem.stacksize, 1);
  const quantityRequested = quantity !== null && quantity !== undefined;
  let moveQuantity = quantityRequested
    ? normalizePositiveInteger(quantity, 1)
    : availableQuantity;
  if (moveQuantity > availableQuantity) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_ITEMS",
    };
  }

  const isChargeCategory = toNumber(currentItem.categoryID, 0) === 8;
  const fittingDestination = isFittingFlag(destinationFlagID);
  const convertToSingleton =
    (fittingDestination && !isChargeCategory) ||
    (
      destinationFlagID === ITEM_FLAGS.STRUCTURE_DEED &&
      toNumber(currentItem.groupID, 0) === STRUCTURE_DEED_GROUP_ID
    );

  const quantityGuard = resolveSingletonDestinationQuantity(
    convertToSingleton,
    moveQuantity,
    quantityRequested,
  );
  if (!quantityGuard.success) {
    return quantityGuard;
  }
  moveQuantity = quantityGuard.moveQuantity;

  const changes = [];
  const movingWholeItem =
    currentItem.singleton === 1 || moveQuantity === availableQuantity;
  // Ownership follows containment for the hand-offs that opt in, so a whole-item
  // transfer carries everything inside the item with it. Collected up front,
  // while the store still holds the pre-transfer tree. Callers with their own
  // model of content ownership -- contract escrow returns a hull whose fitting
  // never left the seller -- leave the flag off and are unaffected.
  const ownerChanges = destinationOwnerID !== toNumber(currentItem.ownerID, 0);
  if (ownerChanges && hasCharacterBoundContents(currentItem.itemID))
    return { success: false, errorMsg: "CAREER_REWARD_CHARACTER_BOUND" };
  const containedItemIDs =
    options && options.reownContents === true && ownerChanges && movingWholeItem
      ? collectContainedItemIDs(currentItem.itemID)
      : [];
  const movedBase = buildMovedItemState(
    currentItem,
    destinationLocationID,
    destinationFlagID,
  );

  if (movingWholeItem) {
    const previousData = cloneValue(currentItem);
    const destinationSingleton = convertToSingleton ? 1 : currentItem.singleton;
    const singletonConvertedItem =
      convertToSingleton && currentItem.singleton !== 1
        ? buildInventoryItem({
            ...currentItem,
            quantity: null,
            stacksize: 1,
            singleton: 1,
          })
        : null;
    const movedItem = buildInventoryItem({
      ...movedBase,
      // The root metadata, recursive ownership and durable receipt join the
      // same mutation-plan commit; publication never sees a half-transfer.
      ...(transferredCustomInfo !== null ? { customInfo: transferredCustomInfo } : {}),
      ownerID: destinationOwnerID,
      quantity: destinationSingleton === 1 ? null : moveQuantity,
      stacksize: destinationSingleton === 1 ? 1 : moveQuantity,
      singleton: destinationSingleton,
    });
    items[String(movedItem.itemID)] = movedItem;
    if (singletonConvertedItem) {
      changes.push({
        removed: false,
        previousData,
        item: cloneValue(singletonConvertedItem),
      });
      changes.push({
        removed: false,
        previousData: cloneValue(singletonConvertedItem),
        item: cloneValue(movedItem),
      });
    } else {
      changes.push({
        removed: false,
        previousData,
        item: cloneValue(movedItem),
      });
    }
    // Re-own what the item contains. Only the container row is rewritten above,
    // so before this every descendant kept the previous owner -- and each
    // owner-filtered read then skipped it. A ship handed over through a
    // corporation hangar reached its new owner with listFittedItems returning
    // nothing, which is a fitted hull arriving unfitted. Empty unless the
    // caller asked for it.
    for (const containedItemID of containedItemIDs) {
      const containedItem = normalizeInventoryItem(items[String(containedItemID)]);
      if (
        !containedItem ||
        toNumber(containedItem.ownerID, 0) === destinationOwnerID
      ) {
        continue;
      }
      const containedPreviousData = cloneValue(containedItem);
      const reownedItem = buildInventoryItem({
        ...containedItem,
        ownerID: destinationOwnerID,
      });
      items[String(reownedItem.itemID)] = reownedItem;
      changes.push({
        removed: false,
        previousData: containedPreviousData,
        item: cloneValue(reownedItem),
      });
    }
  } else {
    const sourcePreviousData = cloneValue(currentItem);
    const updatedSource = buildInventoryItem({
      ...currentItem,
      quantity: availableQuantity - moveQuantity,
      stacksize: availableQuantity - moveQuantity,
      singleton: 0,
    });
    items[String(updatedSource.itemID)] = updatedSource;
    changes.push({
      removed: false,
      previousData: sourcePreviousData,
      item: cloneValue(updatedSource),
    });

    const splitSingleton = convertToSingleton ? 1 : 0;
    const nextItem = buildInventoryItem({
      ...movedBase,
      itemID: nextItemID(
        destinationOwnerID,
        items,
        characters[String(destinationOwnerID)] || null,
      ),
      ownerID: destinationOwnerID,
      quantity: splitSingleton === 1 ? null : moveQuantity,
      stacksize: splitSingleton === 1 ? 1 : moveQuantity,
      singleton: splitSingleton,
      stackOriginID:
        toNumber(currentItem.stackOriginID, 0) > 0
          ? toNumber(currentItem.stackOriginID, 0)
          : currentItem.itemID,
    });
    items[String(nextItem.itemID)] = nextItem;
    changes.push({
      removed: false,
      previousData: buildCreatedItemNotificationPreviousState(
        nextItem,
        sourcePreviousData.flagID,
        sourcePreviousData.ownerID,
      ),
      item: cloneValue(nextItem),
    });
  }

  const finalized = finalizeMovedInventoryItem(items, changes, options,
    destinationOwnerID, destinationLocationID, destinationFlagID);
  if (!finalized.success) return finalized;
  const receipt = options && options.__evejsIdempotentInventoryReceipt &&
    typeof options.__evejsIdempotentInventoryReceipt === "object"
    ? {
        ...cloneValue(options.__evejsIdempotentInventoryReceipt),
        resultData: {
          quantity: moveQuantity,
          changes: cloneValue(changes),
        },
      }
    : null;
  const attachedReceipt = attachIdempotentInventoryReceipt(items, receipt);
  if (!mutationPlan.commit({
    indexDelta: indexDeltaFromChanges(changes),
    knownChangedPaths: attachedReceipt ? [attachedReceipt.path] : [],
  })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  enlistInventoryMoveBatch(inventoryMoveBatch);
  persistTransientItemsMovedIntoDurableLocation(destinationLocationID, changes);
  notifyInventoryMoveInsurance(
    changes,
    "transferItemToOwnerLocation",
    inventoryMoveBatch,
  );

  return {
    success: true,
    ...(inventoryMoveBatch ? { durable: false, pending: true } : {}),
    data: {
      quantity: moveQuantity,
      changes,
    },
  };
}

function moveItemToLocationIdempotent(
  itemId,
  destinationLocationId,
  destinationFlagId,
  quantity = null,
  options = {},
) {
  return executeIdempotentInventoryMutation(
    options,
    "move-item-to-location",
    (receipt) => moveItemToLocation(
      itemId,
      destinationLocationId,
      destinationFlagId,
      quantity,
      { __evejsIdempotentInventoryReceipt: receipt,
        inventoryMoveBatch: options && options.inventoryMoveBatch },
    ),
  );
}

function transferItemToOwnerLocationIdempotent(
  itemId,
  destinationOwnerId,
  destinationLocationId,
  destinationFlagId,
  quantity = null,
  options = {},
) {
  return executeIdempotentInventoryMutation(
    options,
    "transfer-item-to-owner-location",
    (receipt) => transferItemToOwnerLocation(
      itemId,
      destinationOwnerId,
      destinationLocationId,
      destinationFlagId,
      quantity,
      {
        __evejsIdempotentInventoryReceipt: receipt,
        reownContents: options && options.reownContents === true,
        ownerTransferLootInfo: options && options.ownerTransferLootInfo,
        inventoryMoveBatch: options && options.inventoryMoveBatch,
      },
    ),
  );
}

function consumeInventoryItemQuantityIdempotent(
  itemId,
  quantity = 1,
  options = {},
) {
  return executeIdempotentInventoryMutation(
    options,
    "consume-inventory-item-quantity",
    (receipt) => consumeInventoryItemQuantity(
      itemId,
      quantity,
      {
        ...options,
        __evejsIdempotentInventoryReceipt: receipt,
      },
    ),
  );
}

// A native GM spawn must release its pending cleanup markers and checkpoint
// acceptance together. Replaying an uncertain fence returns the same batch.
function commitNativeSpawnItems(itemIDs, batchID, actorID, completion = null) {
  const ids = [...new Set((Array.isArray(itemIDs) ? itemIDs : []).map(Number))].sort((a, b) => a - b);
  if (!ids.length || !ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
      typeof batchID !== "string" || !batchID || batchID.length > 80 ||
      !Number.isSafeInteger(actorID) || actorID <= 0) return { success: false, errorMsg: "NATIVE_SPAWN_COMMIT_INVALID" };
  // Metadata does not change the established receipt fingerprint, so existing
  // three-argument callers and their already-written receipts remain compatible.
  const options = { receiptKey: `native-spawn-commit:${batchID}`, fingerprint: { ids, batchID, actorID },
    receiptMetadata: completion ? { nativeSpawnCompletion: cloneValue(completion) } : null };
  const reconciled = getIdempotentGrantReceipt(options.receiptKey, { reconcileWriteRefusal: true });
  if (!reconciled.success) return reconciled;
  return executeIdempotentInventoryMutation(options, "commit-native-spawn", (receipt) => {
    const plan = createItemRowMutationPlan();
    for (const id of ids) {
      const item = normalizeInventoryItem(plan.items[String(id)]);
      if (!item || item.ownerID !== actorID || item.flagID !== 0 || !item.spaceState) {
        return { success: false, errorMsg: "NATIVE_SPAWN_CUSTODY_CHANGED" };
      }
      let info;
      try { info = JSON.parse(item.customInfo || "{}"); }
      catch (_error) { return { success: false, errorMsg: "NATIVE_SPAWN_MARKER_INVALID" }; }
      const marker = info.evejsNativeSpawnPending;
      if (marker?.version !== 1 || marker.batchID !== batchID || marker.actorID !== actorID) {
        return { success: false, errorMsg: "NATIVE_SPAWN_MARKER_INVALID" };
      }
      delete info.evejsNativeSpawnPending;
      plan.items[String(id)] = { ...item, customInfo: Object.keys(info).length ? JSON.stringify(info) : "" };
    }
    const attached = attachIdempotentInventoryReceipt(plan.items, { ...receipt, resultData: { itemIDs: ids } });
    if (!plan.commit({ indexDelta: { upsertedIDs: ids }, knownChangedPaths: [attached.path] })) {
      return { success: false, errorMsg: "WRITE_ERROR" };
    }
    return { success: true, data: { itemIDs: ids } };
  });
}

// Only unresolved native-spawn commits from this inventory-owner process are
// exposed. A command module can recover known fence ambiguity after reloading;
// completed history and unrelated receipt families are never enumerated here.
function listPendingNativeSpawnCompletions(actorID, solarSystemID) {
  if (!Number.isSafeInteger(actorID) || actorID <= 0 ||
      !Number.isSafeInteger(solarSystemID) || solarSystemID <= 0) return [];
  ensureMigrated();
  const ledger = getIdempotentGrantReceiptLedger(readItems(), false);
  const result = [];
  for (const key of uncertainIdempotentGrantReceipts.keys()) {
    if (!key.startsWith("native-spawn-commit:")) continue;
    const receipt = ledger?.[buildIdempotentGrantReceiptStorageKey(key)];
    const fingerprint = receipt?.fingerprint;
    const completion = receipt?.metadata?.nativeSpawnCompletion;
    const marker = completion?.marker;
    if (receipt?.operation !== "commit-native-spawn" || receipt.state !== "completed" ||
        fingerprint?.actorID !== actorID || marker?.version !== 1 || marker.actorID !== actorID ||
        marker.solarSystemID !== solarSystemID || marker.batchID !== fingerprint.batchID ||
        key !== `native-spawn-commit:${marker.batchID}` ||
        !Array.isArray(fingerprint.ids) || !fingerprint.ids.length ||
        !fingerprint.ids.every(id => Number.isSafeInteger(id) && id > 0) ||
        !Array.isArray(completion.ids) ||
        !isDeepStrictEqual([...completion.ids].sort((a, b) => a - b), fingerprint.ids) ||
        !["spawn", "spawnn", "entity"].includes(completion.command) ||
        typeof completion.typeName !== "string" || !marker.scope || typeof marker.scope !== "object" || Array.isArray(marker.scope)) continue;
    result.push({ ids: [...completion.ids], marker: cloneValue(marker),
      command: completion.command, typeName: completion.typeName });
  }
  return result;
}

// Input stacks, produced stacks and the receipt commit in the same items-table
// transaction. The adapter owns recipe, custody, range and capacity validation.
function exchangeInventoryItemStacksIdempotent(requests, producedStacks, options = {}) {
  return executeIdempotentInventoryMutation(options, "exchange-inventory-item-stacks",
    receipt => consumeInventoryItemStacksAtomic(requests, {
      producedStacks, __evejsIdempotentInventoryReceipt: receipt,
    }));
}

function moveItemTypeFromCharacterLocation(
  charId,
  sourceLocationId,
  sourceFlagId,
  destinationLocationId,
  destinationFlagId,
  typeId,
  quantity = 1,
) {
  ensureMigrated();
  const numericCharId = toNumber(charId, 0);
  const numericSourceLocationId = toNumber(sourceLocationId, 0);
  const numericDestinationLocationId = toNumber(destinationLocationId, 0);
  const numericDestinationFlagId = toNumber(destinationFlagId, ITEM_FLAGS.HANGAR);
  const numericTypeId = toNumber(typeId, 0);
  const numericQuantity = normalizePositiveInteger(quantity, 1);
  const numericSourceFlagId =
    sourceFlagId === null || sourceFlagId === undefined
      ? null
      : toNumber(sourceFlagId, 0);

  if (
    numericCharId <= 0 ||
    numericSourceLocationId <= 0 ||
    numericDestinationLocationId <= 0 ||
    numericTypeId <= 0
  ) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const sourceItems = listContainerItems(
    numericCharId,
    numericSourceLocationId,
    numericSourceFlagId,
  )
    .filter((item) => item && toNumber(item.typeID, 0) === numericTypeId)
    .sort((left, right) => left.itemID - right.itemID);

  const availableQuantity = sourceItems.reduce((sum, item) => (
    sum + (toNumber(item.singleton, 0) === 1 ? 1 : normalizePositiveInteger(item.stacksize, 1))
  ), 0);
  if (availableQuantity < numericQuantity) {
    return {
      success: false,
      errorMsg: "INSUFFICIENT_ITEMS",
      data: {
        availableQuantity,
        requestedQuantity: numericQuantity,
      },
    };
  }

  const allChanges = [];
  const movedItems = [];
  let remaining = numericQuantity;

  for (const sourceItem of sourceItems) {
    if (remaining <= 0) {
      break;
    }

    const movableQuantity =
      toNumber(sourceItem.singleton, 0) === 1
        ? 1
        : Math.min(
            remaining,
            normalizePositiveInteger(sourceItem.stacksize, 1),
          );
    const moveResult = moveItemToLocation(
      sourceItem.itemID,
      numericDestinationLocationId,
      numericDestinationFlagId,
      movableQuantity,
    );
    if (!moveResult.success) {
      return moveResult;
    }

    allChanges.push(...((moveResult.data && moveResult.data.changes) || []));
    const movedChange = ((moveResult.data && moveResult.data.changes) || []).find((change) => (
      change &&
      change.item &&
      toNumber(change.item.locationID, 0) === numericDestinationLocationId &&
      toNumber(change.item.flagID, 0) === numericDestinationFlagId &&
      toNumber(change.item.typeID, 0) === numericTypeId
    ));
    if (movedChange && movedChange.item) {
      movedItems.push(cloneValue(movedChange.item));
    }
    remaining -= movableQuantity;
  }

  return {
    success: true,
    data: {
      quantity: numericQuantity,
      changes: allChanges,
      items: movedItems,
    },
  };
}

function clearPackagedShipRuntimeState(shipId) {
  try {
    const {
      clearShipDirtTimestamp,
    } = require(path.join(__dirname, "../ship/shipDirtState"));
    if (typeof clearShipDirtTimestamp === "function") {
      clearShipDirtTimestamp(shipId, "packaged");
    }
  } catch (error) {
    log.warn(`[ItemStore] Failed to clear ship dirt for packaged ship=${shipId}: ${error.message}`);
  }
  try {
    const {
      clearShipKillCounter,
    } = require(path.join(__dirname, "../ship/shipKillCounterState"));
    if (typeof clearShipKillCounter === "function") {
      clearShipKillCounter(shipId, "packaged");
    }
  } catch (error) {
    log.warn(`[ItemStore] Failed to clear ship killmarks for packaged ship=${shipId}: ${error.message}`);
  }
}

function setShipPackagingState(shipId, packaged) {
  const result = updateShipItem(shipId, (currentItem) => ({
    ...currentItem,
    singleton: packaged ? 0 : 1,
    quantity: packaged ? 1 : -1,
    stacksize: 1,
    // Repackaging strips any custom ship name: reset to the type default so a
    // previously-set name doesn't survive a repackage/reassemble cycle. Only on
    // package; unpackaging/assembly applies the requested name separately.
    ...(packaged
      ? { itemName: getShipMetadata(currentItem.typeID).name || null }
      : {}),
  }));
  if (packaged && result && result.success) {
    clearPackagedShipRuntimeState(shipId);
  }
  return result;
}

function assembleInventoryItem(itemId, options = {}) {
  ensureMigrated();
  const numericItemID = toNumber(itemId, 0);
  if (numericItemID <= 0) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const characters = readCharacters();
  const currentItem = normalizeInventoryItem(items[String(numericItemID)]);
  if (!currentItem) {
    return {
      success: false,
      errorMsg: "ITEM_NOT_FOUND",
    };
  }

  if (toNumber(currentItem.singleton, 0) !== 0) {
    return {
      success: true,
      data: {
        assembledItem: cloneValue(currentItem),
        sourceItem: null,
        changes: [],
        split: false,
        alreadyAssembled: true,
      },
    };
  }

  const availableQuantity = normalizePositiveInteger(
    currentItem.stacksize ?? currentItem.quantity,
    1,
  );
  const requestedItemName = String(options.itemName || "").trim();
  const typeDefaultName =
    getItemMetadata(currentItem.typeID).name ||
    currentItem.itemName ||
    "Item";
  const assembledItemName = requestedItemName || typeDefaultName;
  const resetInstanceState = options.resetInstanceState === true;
  const cleanInstanceState = resetInstanceState
    ? {
        customInfo: "",
        secureContainerState: null,
        createdAtMs: null,
        expiresAtMs: null,
        launcherID: null,
        spaceRadius: null,
        spaceState: null,
      }
    : {};
  const changes = [];
  let sourceItem = null;
  let assembledItem = null;

  if (availableQuantity === 1) {
    const previousData = cloneValue(currentItem);
    assembledItem = buildInventoryItem({
      ...currentItem,
      ...cleanInstanceState,
      itemName: assembledItemName,
      quantity: null,
      stacksize: 1,
      singleton: 1,
    });
    items[String(assembledItem.itemID)] = assembledItem;
    changes.push({
      removed: false,
      previousData,
      item: cloneValue(assembledItem),
    });
  } else {
    const sourcePreviousData = cloneValue(currentItem);
    sourceItem = buildInventoryItem({
      ...currentItem,
      ...cleanInstanceState,
      quantity: availableQuantity - 1,
      stacksize: availableQuantity - 1,
      singleton: 0,
    });
    items[String(sourceItem.itemID)] = sourceItem;
    changes.push({
      removed: false,
      previousData: sourcePreviousData,
      item: cloneValue(sourceItem),
    });

    assembledItem = buildInventoryItem({
      ...currentItem,
      ...cleanInstanceState,
      itemID: nextItemID(
        currentItem.ownerID,
        items,
        characters[String(currentItem.ownerID)] || null,
      ),
      itemName: assembledItemName,
      quantity: null,
      stacksize: 1,
      singleton: 1,
      stackOriginID:
        toNumber(currentItem.stackOriginID, 0) > 0
          ? toNumber(currentItem.stackOriginID, 0)
          : currentItem.itemID,
    });
    items[String(assembledItem.itemID)] = assembledItem;
    changes.push({
      removed: false,
      previousData: buildCreatedItemNotificationPreviousState(
        assembledItem,
        currentItem.flagID,
        currentItem.ownerID,
      ),
      item: cloneValue(assembledItem),
    });
  }

  if (!mutationPlan.commit({ indexDelta: indexDeltaFromChanges(changes) })) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  notifyInsuranceInventoryMutationChanges(changes, "assembleInventoryItem");

  return {
    success: true,
    data: {
      assembledItem: cloneValue(assembledItem),
      sourceItem: sourceItem ? cloneValue(sourceItem) : null,
      changes,
      split: availableQuantity > 1,
      alreadyAssembled: false,
    },
  };
}

function setItemPackagingState(itemId, packaged, options = {}) {
  return updateInventoryItem(itemId, (currentItem) => {
    const metadata = getItemMetadata(currentItem.typeID);
    const resetsContainerInstanceState =
      packaged && CARGO_CONTAINER_GROUP_IDS.has(toNumber(metadata.groupID, 0));
    const resetsGenericInstanceState =
      packaged && options.resetInstanceState === true;
    return {
      ...currentItem,
      singleton: packaged ? 0 : 1,
      quantity: packaged ? 1 : -1,
      stacksize: 1,
      // Packaged containers are stackable and cannot retain any per-instance
      // name, credentials, anchoring state, audit configuration, or legacy
      // customInfo aliases.
      ...(packaged
        ? { itemName: metadata.name || currentItem.itemName }
        : {}),
      ...(resetsContainerInstanceState
        ? {
            customInfo: "",
            secureContainerState: null,
          }
        : {}),
      ...(resetsGenericInstanceState
        ? {
            customInfo: "",
            conditionState: null,
            moduleState: undefined,
            createdAtMs: null,
            expiresAtMs: null,
            launcherID: null,
            spaceRadius: null,
            spaceState: null,
            fighterState: null,
            clientCustomInfo: undefined,
            secureContainerState: null,
          }
        : {}),
    };
  });
}

function buildShipSpaceMove(currentItem, solarSystemId, spaceState) {
    const nextSpaceState = { ...(spaceState || {}) };
    const hasCustomInfoOverride = Object.prototype.hasOwnProperty.call(
      nextSpaceState,
      "customInfo",
    );
    const customInfo = hasCustomInfoOverride
      ? String(nextSpaceState.customInfo || "")
      : currentItem.customInfo;
    if (hasCustomInfoOverride) {
      delete nextSpaceState.customInfo;
    }
    return {
      ...currentItem,
      locationID: toNumber(solarSystemId, currentItem.locationID),
      flagID: 0,
      customInfo,
      spaceState: normalizeSpaceState({
        ...nextSpaceState,
        systemID: toNumber(solarSystemId, currentItem.locationID),
      }),
      conditionState: normalizeShipConditionState(currentItem.conditionState),
    };
}

function moveShipToSpace(shipId, solarSystemId, spaceState) {
  return updateShipItem(shipId, currentItem => buildShipSpaceMove(currentItem, solarSystemId, spaceState));
}

function normalizeShipSpaceMoveIdentity(identity) {
  const fields = ["characterID", "shipID", "sourceSystemID", "destinationSystemID"];
  if (!identity || fields.some(field => !Number.isSafeInteger(Number(identity[field])) || Number(identity[field]) <= 0) ||
      typeof identity.transitionID !== "string" || !identity.transitionID || identity.transitionID.length > 512 ||
      Number(identity.sourceSystemID) === Number(identity.destinationSystemID) ||
      !worldData.getSolarSystemByID(Number(identity.sourceSystemID)) ||
      !worldData.getSolarSystemByID(Number(identity.destinationSystemID))) return null;
  return { transitionID: identity.transitionID, ...Object.fromEntries(fields.map(field => [field, Number(identity[field])])) };
}

function shipSpaceMoveReceiptKey(identity) {
  return `stargate-arrival:${require("node:crypto").createHash("sha256").update(identity.transitionID).digest("hex")}`;
}

// The receipt and the moved ship share the existing items-table transaction.
// A replay returns the historical outcome without moving a later ship back.
function moveShipToSpaceIdempotent(shipID, destinationSystemID, spaceState, identity) {
  const expected = normalizeShipSpaceMoveIdentity(identity);
  if (!expected || Number(shipID) !== expected.shipID || Number(destinationSystemID) !== expected.destinationSystemID)
    return { success: false, errorMsg: "SHIP_SPACE_MOVE_IDENTITY_INVALID" };
  const result = executeIdempotentInventoryMutation({ receiptKey: shipSpaceMoveReceiptKey(expected),
    fingerprint: expected, completedAtMs: require("../../space/runtime/runtimeClock").getWallclockNowMs(),
    receiptMetadata: { shipSpaceMove: { version: 1, kind: "stargate-jump" } } },
  "move-ship-to-space", receipt => {
    const plan = createItemRowMutationPlan(), current = normalizeInventoryItem(plan.items[String(shipID)]);
    if (!current || current.categoryID !== SHIP_CATEGORY_ID || Number(current.ownerID) !== expected.characterID ||
        Number(current.flagID) !== 0 || Number(current.locationID) !== expected.sourceSystemID ||
        Number(current.spaceState?.systemID) !== expected.sourceSystemID)
      return { success: false, errorMsg: "SHIP_SPACE_MOVE_SOURCE_CHANGED" };
    if (database.isTransientPath(ITEMS_TABLE, `/${shipID}`) ||
        database.isTransientPath(CHARACTERS_TABLE, `/${expected.characterID}`))
      return { success: false, errorMsg: "SHIP_SPACE_MOVE_TRANSIENT_OWNER" };
    const item = normalizeInventoryItem(buildShipSpaceMove(current, destinationSystemID, spaceState), current);
    receipt.resultData = { item: cloneValue(item), previousData: cloneValue(current) };
    plan.items[String(shipID)] = item;
    const attached = attachIdempotentInventoryReceipt(plan.items, receipt);
    if (!plan.commit({ indexDelta: { upsertedIDs: [Number(shipID)] }, knownChangedPaths: [attached.path] }))
      return { success: false, errorMsg: "WRITE_ERROR" };
    maybeNotifyInsuranceInventoryMutation(current, item, "updateInventoryItem");
    return { success: true, previousData: cloneValue(current), data: cloneValue(item) };
  });
  return result.success && result.duplicate
    ? { ...result, previousData: result.data.previousData, data: result.data.item } : result;
}

// Historical proof remains readable after docking, another scene transfer or
// destruction. Only the inventory owner interprets its permanent receipt rows.
function getShipSpaceMoveReceipt(identity) {
  const expected = normalizeShipSpaceMoveIdentity(identity);
  if (!expected) return { success: false, errorMsg: "SHIP_SPACE_MOVE_IDENTITY_INVALID" };
  const key = shipSpaceMoveReceiptKey(expected), stored = database.readPersisted(ITEMS_TABLE,
    `/${IDEMPOTENT_GRANT_RECEIPTS_KEY}/${buildIdempotentGrantReceiptStorageKey(key)}`);
  if (stored?.errorMsg === "ENTRY_NOT_FOUND") return { success: true, found: false, data: null };
  if (!stored?.success) return stored || { success: false, errorMsg: "SHIP_SPACE_MOVE_RECEIPT_READ_FAILED" };
  const receipt = stored.data;
  if (!receipt) return { success: true, found: false, data: null };
  const item = receipt.resultData?.item, previous = receipt.resultData?.previousData;
  if (receipt.schemaVersion !== 3 || receipt.state !== "completed" || receipt.receiptKey !== key ||
      !Number.isSafeInteger(receipt.completedAtMs) || receipt.completedAtMs <= 0 ||
      receipt.operation !== "move-ship-to-space" || !isDeepStrictEqual(receipt.fingerprint, expected) ||
      receipt.metadata?.shipSpaceMove?.version !== 1 || receipt.metadata.shipSpaceMove.kind !== "stargate-jump" ||
      Number(item?.itemID) !== expected.shipID || Number(item?.ownerID) !== expected.characterID ||
      Number(item?.categoryID) !== SHIP_CATEGORY_ID || Number(item?.flagID) !== 0 ||
      Number(item?.locationID) !== expected.destinationSystemID || Number(item?.spaceState?.systemID) !== expected.destinationSystemID ||
      Number(previous?.itemID) !== expected.shipID || Number(previous?.ownerID) !== expected.characterID ||
      Number(previous?.flagID) !== 0 || Number(previous?.locationID) !== expected.sourceSystemID ||
      Number(previous?.spaceState?.systemID) !== expected.sourceSystemID)
    return { success: false, errorMsg: "SHIP_SPACE_MOVE_RECEIPT_CONFLICT" };
  return { success: true, found: true, durable: true, data: cloneValue(receipt) };
}

function dockShipToStation(shipId, stationId) {
  return dockShipToLocation(shipId, stationId);
}

function dockShipToLocation(shipId, locationId) {
  const numericLocationId = toNumber(locationId, 0);
  const station = worldData.getStationByID(numericLocationId);
  const structure =
    station || numericLocationId <= 0
      ? null
      : getStructureState().getStructureByID(numericLocationId, {
          refresh: false,
        });
  if (!station && !structure) {
    return {
      success: false,
      errorMsg: "DOCK_LOCATION_NOT_FOUND",
    };
  }

  return updateShipItem(shipId, (currentItem) => ({
    ...currentItem,
    locationID: numericLocationId,
    flagID: ITEM_FLAGS.HANGAR,
    customInfo: String(currentItem.customInfo || "").startsWith("Undocking:")
      ? ""
      : currentItem.customInfo,
    spaceState: null,
  }));
}

function spawnShipInStationHangar(charId, stationId, shipType) {
  ensureMigrated();
  const createResult = createShipItemForCharacter(charId, stationId, shipType);
  if (!createResult.success) {
    return createResult;
  }

  return {
    success: true,
    created: true,
    data: createResult.data,
  };
}

function setActiveShipForCharacter(charId, shipId) {
  const shipItem = findCharacterShipItem(charId, shipId);
  if (!shipItem) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const syncResult = syncCharacterActiveShip(charId, shipItem);
  if (!syncResult.success) {
    return syncResult;
  }

  return {
    success: true,
    data: shipItem,
  };
}

function characterHasGoldenCapsuleImplant(characterRecord) {
  const implants = Array.isArray(characterRecord && characterRecord.implants)
    ? characterRecord.implants
    : [];
  return implants.some((implant) => {
    if (implant && typeof implant === "object") {
      return toNumber(implant.typeID, 0) === GOLDEN_CAPSULE_IMPLANT_TYPE_ID;
    }
    return toNumber(implant, 0) === GOLDEN_CAPSULE_IMPLANT_TYPE_ID;
  });
}

function resolveCapsuleTypeIDForCharacter(charId) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return CAPSULE_TYPE_ID;
  }
  const characters = readCharacters();
  return characterHasGoldenCapsuleImplant(characters[String(numericCharId)])
    ? CAPSULE_TYPE_ID_GOLDEN
    : CAPSULE_TYPE_ID;
}

function buildCapsuleTypeDescriptor(typeID) {
  const resolvedTypeID = isCapsuleTypeID(typeID) ? toNumber(typeID, CAPSULE_TYPE_ID) : CAPSULE_TYPE_ID;
  const metadata = getItemMetadata(resolvedTypeID);
  return {
    typeID: resolvedTypeID,
    name:
      metadata.name ||
      (resolvedTypeID === CAPSULE_TYPE_ID_GOLDEN
        ? "Capsule - Genolution 'Auroral' 197-variant"
        : "Capsule"),
  };
}

function syncCapsuleItemToType(charId, capsuleItem, targetTypeID) {
  if (!capsuleItem || !isCapsuleTypeID(capsuleItem.typeID)) {
    return {
      success: false,
      errorMsg: "CAPSULE_NOT_FOUND",
    };
  }

  const target = buildCapsuleTypeDescriptor(targetTypeID);
  const alreadySynced =
    toNumber(capsuleItem.typeID, 0) === target.typeID &&
    capsuleItem.itemName === target.name &&
    capsuleItem.shipName === target.name;
  if (alreadySynced) {
    return {
      success: true,
      changed: false,
      previousData: cloneValue(capsuleItem),
      data: cloneValue(capsuleItem),
    };
  }

  const updateResult = updateInventoryItem(capsuleItem.itemID, (item) => ({
    ...item,
    typeID: target.typeID,
    itemName: target.name,
    shipName: target.name,
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  const characters = readCharacters();
  const record = characters[String(toNumber(charId, 0))];
  if (record && toNumber(record.shipID, 0) === toNumber(updateResult.data.itemID, 0)) {
    syncCharacterActiveShip(charId, updateResult.data);
  }

  return {
    ...updateResult,
    changed: true,
  };
}

function syncCapsuleTypeForCharacter(charId, options = {}) {
  const numericCharId = toNumber(charId, 0);
  if (numericCharId <= 0) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const capsuleItem = findCharacterCapsule(numericCharId, options.stationId ?? null);
  if (!capsuleItem) {
    return {
      success: false,
      errorMsg: "CAPSULE_NOT_FOUND",
    };
  }

  return syncCapsuleItemToType(
    numericCharId,
    capsuleItem,
    resolveCapsuleTypeIDForCharacter(numericCharId),
  );
}

function ensureCapsuleForCharacter(charId, stationId) {
  const targetCapsuleType = buildCapsuleTypeDescriptor(
    resolveCapsuleTypeIDForCharacter(charId),
  );
  const existingCapsule = findCharacterCapsule(charId, stationId);
  if (existingCapsule) {
    const syncResult = syncCapsuleItemToType(
      charId,
      existingCapsule,
      targetCapsuleType.typeID,
    );
    if (!syncResult.success) {
      return syncResult;
    }
    return {
      success: true,
      created: false,
      data: syncResult.data,
      previousData: syncResult.previousData,
      changed: syncResult.changed === true,
    };
  }

  return createShipItemForCharacter(charId, stationId, {
    typeID: targetCapsuleType.typeID,
    name: targetCapsuleType.name,
  });
}

// `typeIds`, when given, keeps only rows of those types. Every returned row is
// deep-cloned, so a caller that already knows it wants a handful of types out
// of a big container -- a station hangar holds everything the character owns
// there -- should say so and not pay a clone per row it is about to discard.
function listContainerItems(ownerId, locationId, flagId = null, typeIds = null) {
  const numericLocationId = toNumber(locationId, 0);
  const numericOwnerId =
    ownerId === null || ownerId === undefined ? null : toNumber(ownerId, 0);
  const numericFlagId =
    flagId === null || flagId === undefined ? null : toNumber(flagId, 0);
  const typeIdFilter =
    typeIds === null || typeIds === undefined
      ? null
      : new Set([...typeIds].map((typeId) => toNumber(typeId, 0)));

  return (ensureItemIndexes().byLocation.get(numericLocationId) || [])
    .filter(
      (entry) =>
        entry &&
        entry.locationID === numericLocationId &&
        (numericOwnerId === null || entry.ownerID === numericOwnerId) &&
        (numericFlagId === null || entry.flagID === numericFlagId) &&
        (typeIdFilter === null || typeIdFilter.has(entry.typeID)),
    )
    .map((entry) => cloneValue(entry));
}

function listSystemSpaceItems(systemId) {
  const numericSystemId = toNumber(systemId, 0);
  if (numericSystemId <= 0) {
    return [];
  }

  const now = Date.now();

  return (ensureItemIndexes().byLocation.get(numericSystemId) || [])
    .filter(
      (entry) =>
        entry &&
        entry.locationID === numericSystemId &&
        entry.flagID === 0 &&
        entry.spaceState &&
        toNumber(entry.spaceState.systemID, 0) === numericSystemId &&
        (
          entry.expiresAtMs === null || entry.expiresAtMs === undefined ||
          !Number.isFinite(Number(entry.expiresAtMs)) ||
          Number(entry.expiresAtMs) > now
        ),
    )
    .map((entry) => cloneValue(entry));
}

function pruneExpiredSpaceItems(now = Date.now()) {
  // Space-item expiry is a world-owned cleanup, and SpaceRuntime runs it while
  // it is being constructed — which is at module load, so anything that merely
  // *reads* through space/runtime (parity reports, the read-only edge workers)
  // would trip the store's ownership guard on startup purely because the store
  // happened to hold an expired jetcan. A passive role has nothing to clean up
  // on anyone else's behalf: report the no-op instead of throwing, and leave
  // the removals to the process that owns the table.
  if (!OWNS_ITEMS_TABLE) {
    return {
      success: true,
      data: {
        removedTopLevelItemIDs: [],
        changes: [],
        skippedForProcessRole: database._processRole,
      },
    };
  }
  ensureMigrated();
  const numericNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const items = Object.values(readItems())
    .map((entry) => normalizeInventoryItem(entry))
    .filter(Boolean)
    .sort((left, right) => left.itemID - right.itemID);

  const removedTopLevelItemIDs = [];
  const removedChanges = [];
  const seen = new Set();

  for (const item of items) {
    const itemID = toNumber(item && item.itemID, 0);
    if (
      itemID <= 0 ||
      seen.has(itemID) ||
      toNumber(item.locationID, 0) <= 0 ||
      toNumber(item.flagID, 0) !== 0 ||
      !item.spaceState ||
      item.expiresAtMs === null || item.expiresAtMs === undefined ||
      !Number.isFinite(Number(item.expiresAtMs)) ||
      Number(item.expiresAtMs) > numericNow
    ) {
      continue;
    }

    const removeResult = removeInventoryItem(itemID, { removeContents: true });
    if (!removeResult.success) {
      continue;
    }

    removedTopLevelItemIDs.push(itemID);
    removedChanges.push(...((removeResult.data && removeResult.data.changes) || []));
    for (const removedItem of (removeResult.data && removeResult.data.removedItems) || []) {
      seen.add(toNumber(removedItem && removedItem.itemID, 0));
    }
  }

  return {
    success: true,
    data: {
      removedTopLevelItemIDs,
      changes: removedChanges,
    },
  };
}

function getShipConditionState(shipItem) {
  return normalizeShipConditionState(shipItem && shipItem.conditionState);
}

function resetInventoryStoreForTests() {
  migrationComplete = false;
  itemsTableCache = null;
  itemIndexesDirty = true;
  itemIndexesCache = null;
  itemIndexKeys = new Map();
  itemIndexIncrementalUpdates = 0;
  itemIndexFullRebuildCount = 0;
  itemIndexIntegrityValidationCount = 0;
  reservedItemIDBatch = [];
  uncertainIdempotentGrantReceipts.clear();
  inventoryMoveBatches = new WeakMap();
  pendingInventoryMoveBatches.clear();
  itemMutationVersion += 1;
  require("../character/characterRecordInputs").noteAllCharacterRecordInputsChanged();
  try {
    require(path.join(
      __dirname,
      "./simulationInventoryProjection",
    )).resetSimulationInventoryProjectionForTests();
  } catch (_) {
    // ignored: projection may not have been loaded by this test process.
  }
}

// Test-only: snapshot the current index in a deep-comparable shape, and force a
// rebuild — so a property test can assert incremental updates == a from-scratch
// rebuild.
function _itemIndexSnapshotForTest() {
  return snapshotItemIndexes(ensureItemIndexes());
}

function _invalidateItemIndexesForTest() {
  itemIndexesDirty = true;
  itemIndexesCache = null;
  itemIndexKeys = new Map();
}

function _writeItemsForTest(data, options) {
  return writeItems(data, options);
}

function _itemIndexStatsForTest() {
  return {
    fullRebuildCount: itemIndexFullRebuildCount,
    integrityValidationCount: itemIndexIntegrityValidationCount,
    incrementalUpdates: itemIndexIncrementalUpdates,
    selfCheckInterval: ITEM_INDEX_SELFCHECK_INTERVAL,
    rebuildWarnMs: ITEM_INDEX_REBUILD_WARN_MS,
    dirty: itemIndexesDirty,
    cached: Boolean(itemIndexesCache),
  };
}

function _resetItemIndexStatsForTest() {
  itemIndexFullRebuildCount = 0;
  itemIndexIntegrityValidationCount = 0;
}

// Owner API: write an item's customInfo metadata sub-path. customInfo does not
// change identity/location/owner, so the item keeps its byLocation/byOwner
// buckets — but the derived byID index (and the simulation projection that
// mirrors it) each hold a normalized COPY of the row with customInfo included,
// so a bare sub-path write leaves findItemById/listContainerItems and the
// projection serving the pre-write customInfo until an unrelated rebuild. Route
// the edit through the same row-overlay plan every other mutator uses so the
// index is patched, the mutation version bumps, the projection is published, and
// a rejected write rolls the row back. Lets the dogma domain persist dynamic-item
// metadata without touching the items table directly.
function writeItemCustomInfo(itemID, customInfo, options = {}) {
  ensureMigrated();
  const numericItemID = toNumber(itemID, 0);
  if (numericItemID <= 0) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }

  const mutationPlan = createItemRowMutationPlan();
  const items = mutationPlan.items;
  const currentRow = items[String(numericItemID)];
  if (!normalizeInventoryItem(currentRow)) {
    return { success: false, errorMsg: "ITEM_NOT_FOUND" };
  }

  // Preserve every other field byte-for-byte and only replace customInfo, matching
  // the old sub-path write; staging a fresh object keeps the base row intact for
  // rollback if the commit is rejected.
  items[String(numericItemID)] = { ...currentRow, customInfo };
  if (!mutationPlan.commit({
    ...options,
    indexDelta: { upsertedIDs: [numericItemID] },
  })) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }

  return { success: true, errorMsg: null };
}

// A combat effect and its AIR outbox share one inventory checkpoint. Keeping
// the receipt outside either ship row preserves it when a later kill removes
// that ship. Acknowledged receipts remain as the duplicate fence.
function careerCombatOutcomeKey(characterID, eventID) {
  return require("node:crypto").createHash("sha256")
    .update(`${characterID}:${eventID}`).digest("hex");
}

function getCareerCombatOutcome(characterID, eventID) {
  const receipt = readItems()[CAREER_COMBAT_OUTCOMES_KEY]?.[careerCombatOutcomeKey(characterID, eventID)];
  return receipt ? cloneValue(receipt) : null;
}

function flushCareerCombatOutcomes() {
  try { return repo.flushTableSync(ITEMS_TABLE); }
  catch (error) { return { success: false, errorMsg: error.message || "COMBAT_OUTCOME_FLUSH_FAILED" }; }
}

function commitCareerCombatOutcome({ characterID, event, conditionUpdates = [] } = {}) {
  ensureMigrated();
  const actor = Number(characterID);
  const isDuration = ["web", "paint", "warp-disrupt", "warp-scramble", "weapon-disrupt"].includes(event?.effect);
  const measured = isDuration ? event?.durationMs : Math.floor(Number(event?.amount) * 1000 + 1e-7);
  if (!Number.isSafeInteger(actor) || actor <= 0 || event?.kind !== "combat-effect" ||
      typeof event.id !== "string" || !event.id || event.id.length > 512 ||
      !["nosferatu", "neutralizer", "shield-repair", "armor-repair", "web", "paint",
        "warp-disrupt", "warp-scramble", "weapon-disrupt"].includes(event.effect) ||
      !Number.isSafeInteger(measured) || measured <= 0 ||
      (!isDuration && !Number.isFinite(event.amount)) ||
      (isDuration ? event.amount !== undefined : event.durationMs !== undefined))
    return { success: false, errorMsg: "COMBAT_OUTCOME_INVALID" };
  if (database.isTransientPath(CHARACTERS_TABLE, `/${actor}`))
    return { success: false, errorMsg: "COMBAT_OUTCOME_TRANSIENT_OWNER" };
  const key = careerCombatOutcomeKey(actor, event.id);
  const existing = getCareerCombatOutcome(actor, event.id);
  if (existing && !isDeepStrictEqual(existing.event, event))
    return { success: false, errorMsg: "COMBAT_OUTCOME_CONFLICT" };
  if (existing) return { success: true, duplicate: true, receipt: existing,
    durable: flushCareerCombatOutcomes()?.success === true };
  const plan = createItemRowMutationPlan();
  const ledger = plan.items[CAREER_COMBAT_OUTCOMES_KEY] || {};
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger) || Object.keys(ledger).length >= 65536)
    return { success: false, errorMsg: "COMBAT_OUTCOME_CAPACITY" };
  const touched = [];
  for (const change of conditionUpdates) {
    const itemID = Number(change?.itemID), current = plan.items[String(itemID)];
    if (!Number.isSafeInteger(itemID) || itemID <= 0 || !normalizeInventoryItem(current) || touched.includes(itemID))
      return { success: false, errorMsg: "COMBAT_OUTCOME_ITEM_INVALID" };
    if (repo.isTransientPath(ITEMS_TABLE, `/${itemID}`))
      return { success: false, errorMsg: "COMBAT_OUTCOME_ITEM_TRANSIENT" };
    plan.items[String(itemID)] = { ...current,
      conditionState: normalizeShipConditionState({ ...current.conditionState, ...change.conditionState }) };
    touched.push(itemID);
  }
  const receipt = { version: 1, characterID: actor, event: cloneValue(event),
    acknowledged: false, atMs: Math.max(1, Math.trunc(Number(event.atMs) || Date.now())) };
  plan.items[CAREER_COMBAT_OUTCOMES_KEY] = { ...ledger, [key]: receipt };
  if (!plan.commit({ indexDelta: { upsertedIDs: touched },
    knownChangedPaths: [`/${CAREER_COMBAT_OUTCOMES_KEY}/${key}`] }))
    return { success: false, errorMsg: "COMBAT_OUTCOME_WRITE_FAILED" };
  // A failed fence retains both the accepted state and intent for retry. Never
  // publish AIR evidence from this cache before a successful durable fence.
  const flushed = flushCareerCombatOutcomes();
  return { success: true, duplicate: false, durable: flushed?.success === true,
    pending: flushed?.success !== true, receipt };
}

function listPendingCareerCombatOutcomes(characterID) {
  const result = database.readPersistedPendingCareerCombatOutcomes(characterID);
  if (!result?.success) return result || { success: false, errorMsg: "COMBAT_OUTCOME_READ_FAILED" };
  const ledger = result.data || {};
  return { success: true, data: Object.values(ledger).filter(receipt => receipt?.version === 1 &&
    receipt.characterID === Number(characterID) && receipt.acknowledged !== true).map(cloneValue) };
}

function acknowledgeCareerCombatOutcome(characterID, eventID) {
  const key = careerCombatOutcomeKey(characterID, eventID), plan = createItemRowMutationPlan();
  const ledger = plan.items[CAREER_COMBAT_OUTCOMES_KEY] || {}, receipt = ledger[key];
  if (!receipt) return { success: false, errorMsg: "COMBAT_OUTCOME_NOT_FOUND" };
  if (receipt.acknowledged !== true) {
    plan.items[CAREER_COMBAT_OUTCOMES_KEY] = { ...ledger, [key]: { ...receipt, acknowledged: true } };
    if (!plan.commit({ indexDelta: { upsertedIDs: [] }, knownChangedPaths: [`/${CAREER_COMBAT_OUTCOMES_KEY}/${key}`] }))
      return { success: false, errorMsg: "COMBAT_OUTCOME_ACK_FAILED" };
  }
  return flushCareerCombatOutcomes();
}

// Incursion support credit shares the inventory health checkpoint. Its outbox
// lives outside hull rows so later destruction cannot erase a qualifying repair.
function commitIncursionCombatOutcome({ event, conditionUpdates = [], careerOutcome = null } = {}) {
  const carrier = require("./incursionCombatOutcomes");
  let normalized;
  try { normalized = carrier.normalizeEvent(event); }
  catch (error) { return { success: false, handled: true, errorMsg: error.message }; }
  if (normalized.kind !== "repair") return { success: false, handled: true, errorMsg: "INCURSION_REPAIR_EVENT_REQUIRED" };
  ensureMigrated();
  const key = carrier.storageKey(normalized.eventID), plan = createItemRowMutationPlan();
  const ledger = plan.items[INCURSION_COMBAT_OUTCOMES_KEY] || {}, existing = ledger[key];
  if (existing) {
    if (!isDeepStrictEqual(existing.event, normalized)) return { success: false, handled: true, errorMsg: "INCURSION_COMBAT_OUTCOME_CONFLICT" };
    const flushed = flushCareerCombatOutcomes();
    return { success: true, handled: true, accepted: true, duplicate: true, durable: flushed?.success === true,
      pending: flushed?.success !== true, careerDeferred: existing.careerDeferred === true, receipt: cloneValue(existing) };
  }
  if (Object.values(ledger).filter(row => row.event?.operationID === normalized.operationID).length >= 65536)
    return { success: false, handled: true, errorMsg: "INCURSION_COMBAT_OUTCOME_CAPACITY" };
  if (database.isTransientPath(CHARACTERS_TABLE, `/${normalized.characterID}`))
    return { success: false, handled: true, errorMsg: "INCURSION_COMBAT_TRANSIENT_OWNER" };
  const touched = [];
  for (const change of conditionUpdates) {
    const itemID = Number(change?.itemID), current = plan.items[String(itemID)];
    if (!Number.isSafeInteger(itemID) || itemID <= 0 || !normalizeInventoryItem(current) || touched.includes(itemID) ||
        Number(current.categoryID) !== SHIP_CATEGORY_ID || Number(current.singleton) !== 1 ||
        Number(current.ownerID) !== Number(change.ownerID) || Number(current.typeID) !== Number(change.typeID))
      return { success: false, handled: true, errorMsg: "INCURSION_COMBAT_ITEM_INVALID" };
    if (repo.isTransientPath(ITEMS_TABLE, `/${itemID}`)) return { success: false, handled: true, errorMsg: "INCURSION_COMBAT_ITEM_TRANSIENT" };
    plan.items[String(itemID)] = { ...current,
      conditionState: normalizeShipConditionState({ ...current.conditionState, ...change.conditionState }) };
    touched.push(itemID);
  }
  if (!touched.includes(normalized.targetEntityID)) return { success: false, handled: true, errorMsg: "INCURSION_COMBAT_TARGET_MISSING" };
  const changedPaths = [`/${INCURSION_COMBAT_OUTCOMES_KEY}/${key}`];
  let careerDeferred = false;
  if (careerOutcome) {
    const actor = Number(careerOutcome.characterID), observed = careerOutcome.event;
    if (actor !== normalized.characterID || observed?.kind !== "combat-effect" ||
        typeof observed.id !== "string" || !observed.id || observed.id.length > 512 ||
        !["shield-repair", "armor-repair"].includes(observed.effect) ||
        !Number.isFinite(observed.amount) || Math.floor(observed.amount * 1000 + 1e-7) < 1 ||
        !Number.isSafeInteger(Math.floor(observed.amount * 1000 + 1e-7)) || observed.durationMs !== undefined ||
        observed.atMs !== normalized.atMs || Math.abs(observed.amount - normalized.amount) > 1e-6)
      return { success: false, handled: true, errorMsg: "INCURSION_CAREER_OUTCOME_INVALID" };
    const careerKey = careerCombatOutcomeKey(actor, observed.id), careerLedger = plan.items[CAREER_COMBAT_OUTCOMES_KEY] || {};
    const previous = careerLedger[careerKey];
    if (previous && !isDeepStrictEqual(previous.event, observed))
      return { success: false, handled: true, errorMsg: "COMBAT_OUTCOME_CONFLICT" };
    if (!previous && Object.keys(careerLedger).length >= 65536) careerDeferred = true;
    else {
      plan.items[CAREER_COMBAT_OUTCOMES_KEY] = { ...careerLedger, [careerKey]: previous || {
        version: 1, characterID: actor, event: cloneValue(observed), acknowledged: false,
        atMs: Math.max(1, Math.trunc(Number(observed.atMs) || Date.now())),
      } };
      changedPaths.push(`/${CAREER_COMBAT_OUTCOMES_KEY}/${careerKey}`);
    }
  }
  const receipt = { version: 1, event: cloneValue(normalized), acknowledged: false, ...(careerDeferred ? { careerDeferred: true } : {}),
    conditionState: cloneValue(plan.items[String(normalized.targetEntityID)].conditionState) };
  plan.items[INCURSION_COMBAT_OUTCOMES_KEY] = { ...ledger, [key]: receipt };
  if (!plan.commit({ indexDelta: { upsertedIDs: touched }, knownChangedPaths: changedPaths }))
    return { success: false, handled: true, errorMsg: "INCURSION_COMBAT_WRITE_FAILED" };
  const flushed = flushCareerCombatOutcomes();
  return { success: true, handled: true, accepted: true, duplicate: false, durable: flushed?.success === true,
    pending: flushed?.success !== true, careerDeferred, receipt: cloneValue(receipt) };
}

// Environmental logistics cannot mint player contribution. Its bounded receipt
// shares the hull HP mutation and survives the hull's later removal.
function commitIncursionLogisticsRepair(request, calculate) {
  let accepted = false, held = false;
  const presentation = require("../incursion/incursionRepairPresentation");
  try {
    ensureMigrated();
    const support = require("../incursion/incursionLogisticsSupport"), scope = support.validateRequest(request);
    if (scope.pulse.domain !== "player") throw new Error("INCURSION_SUPPORT_HEALTH_DOMAIN_INVALID");
    const plan = createItemRowMutationPlan(), ledgerKey = "__evejsIncursionLogisticsHealth", ledger = plan.items[ledgerKey] || {};
    const current = normalizeInventoryItem(plan.items[String(request.targetID)]);
    const result = support.healthCommit(request, ledger[request.sourceKey], snapshot => {
      if (!current || Number(current.conditionState?.damage) >= 1 || current.categoryID !== SHIP_CATEGORY_ID || current.singleton !== 1 || current.ownerID !== snapshot.ownerID ||
          current.typeID !== snapshot.typeID || current.locationID !== scope.instance.solarSystemID || current.flagID !== 0 ||
          current.inventoryCustodyRevision !== snapshot.inventoryCustodyRevision || repo.isTransientPath(ITEMS_TABLE, `/${request.targetID}`)) return { skipped: true };
      return calculate(current);
    });
    if (result.skipped) return { success: true, durable: true, skipped: true };
    if (!result.duplicate) {
      presentation.hold(request, scope.target, result.receipt.before); held = true;
      plan.items[String(request.targetID)] = { ...current, conditionState: normalizeShipConditionState(result.receipt.after) };
      plan.items[ledgerKey] = { ...ledger, [request.sourceKey]: result.state };
      if (!plan.commit({ indexDelta: { upsertedIDs: [request.targetID] }, knownChangedPaths: [`/${ledgerKey}/${request.sourceKey}`] }))
        throw new Error("INCURSION_SUPPORT_HEALTH_WRITE_FAILED");
    }
    accepted = true;
    const flushed = repo.flushTableSync(ITEMS_TABLE);
    if (flushed.success) presentation.release(request);
    return { success: true, accepted, duplicate: result.duplicate, durable: flushed.success === true, pending: flushed.success !== true, receipt: result.receipt };
  } catch (error) { return { success: accepted, accepted, pending: accepted, errorMsg: error.message }; }
  finally { if (held && !accepted) presentation.release(request); }
}

function acknowledgeIncursionCombatOutcome(eventID) {
  const key = require("./incursionCombatOutcomes").storageKey(eventID), plan = createItemRowMutationPlan();
  const ledger = plan.items[INCURSION_COMBAT_OUTCOMES_KEY] || {}, receipt = ledger[key];
  if (!receipt || receipt.event?.eventID !== eventID) return { success: false, errorMsg: "INCURSION_COMBAT_OUTCOME_NOT_FOUND" };
  if (receipt.acknowledged !== true) {
    plan.items[INCURSION_COMBAT_OUTCOMES_KEY] = { ...ledger, [key]: { ...receipt, acknowledged: true } };
    if (!plan.commit({ indexDelta: { upsertedIDs: [] }, knownChangedPaths: [`/${INCURSION_COMBAT_OUTCOMES_KEY}/${key}`] }))
      return { success: false, errorMsg: "INCURSION_COMBAT_ACK_FAILED" };
  }
  return flushCareerCombatOutcomes();
}

function getIncursionFactoryWithdrawal(productionKey) {
  const { LEDGER } = require("./incursionFactoryCustody");
  if (!/^incursion-mtac:[1-9][0-9]*:[1-9][0-9]*$/.test(productionKey || "")) return { success: false, errorMsg: "INCURSION_FACTORY_RECEIPT_KEY_INVALID" };
  ensureMigrated();
  const cached = readItems()[LEDGER]?.[productionKey] || null, flushed = repo.flushTableSync(ITEMS_TABLE);
  if (!flushed?.success) return flushed;
  const persisted = database.readPersisted(ITEMS_TABLE, `/${LEDGER}/${productionKey}`);
  if (!persisted.success && persisted.errorMsg !== "ENTRY_NOT_FOUND") return persisted;
  const durable = persisted.data || null;
  if (!isDeepStrictEqual(cached, durable)) return { success: false, errorMsg: "INCURSION_FACTORY_WITHDRAWAL_AMBIGUOUS" };
  return { success: true, durable: true, found: Boolean(durable), data: cloneValue(durable) };
}

module.exports = {
  cloneDockedShipForCharacter,
  getIncursionFactoryWithdrawal,
  commitIncursionLogisticsRepair,
  commitIncursionCombatOutcome,
  acknowledgeIncursionCombatOutcome,
  getCareerCombatOutcome,
  commitCareerCombatOutcome,
  listPendingCareerCombatOutcomes,
  acknowledgeCareerCombatOutcome,
  flushCareerCombatOutcomes,
  ITEM_MOVE_ERROR,
  createInventoryMoveBatch,
  getInventoryMoveBatchState,
  isInventoryMoveBatchOpen,
  trackItemCustodyRevision,
  setShipSkinrApplicationIdempotent,
  clearShipSkinrApplication,
  commitSiteHazardDamageIdempotent,
  completeSiteHazardDeathIdempotent,
  writeItemCustomInfo,
  validateItemIndexIntegrity,
  _itemIndexSnapshotForTest,
  _invalidateItemIndexesForTest,
  _writeItemsForTest,
  _itemIndexStatsForTest,
  _resetItemIndexStatsForTest,
  ITEMS_TABLE,
  ITEM_FLAGS,
  FIGHTER_TUBE_FLAGS,
  SHIP_CATEGORY_ID,
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  GOLDEN_CAPSULE_IMPLANT_TYPE_ID,
  CLIENT_INVENTORY_STACK_LIMIT,
  ensureMigrated,
  getAllItems,
  listItemsMatching,
  listStarbaseItems,
  hasStarbaseItems,
  listStarbaseForceFieldItems,
  isStarbaseItemID,
  findStarbaseItemById,
  listOwnedItems,
  listCharacterItems,
  getCharacterShipItems,
  getCharacterHangarShipItems,
  findCharacterShipItem,
  findCharacterCapsule,
  findItemById,
  findShipItemById,
  findCharacterShipByType,
  isCapsuleTypeID,
  isStackableInventoryItem,
  hasCharacterBoundContents,
  isBlueprintCopyInventoryItem,
  ensureCharacterActiveShipItem,
  getActiveShipItem,
  grantItemsToCharacterLocation,
  grantItemToCharacterLocation,
  grantItemsToOwnerLocation,
  grantItemToOwnerLocation,
  grantItemToOwnerLocationIdempotent,
  grantItemsToOwnerLocationIdempotent,
  getIdempotentGrantReceipt,
  pruneIdempotentGrantReceipts,
  retireIdempotentGrantReceipts,
  grantItemToCharacterStationHangar,
  grantItemsToCharacterStationHangar,
  createSpaceItemForCharacter,
  createSpaceItemForOwner,
  createSpaceItemForOwnerIdempotent,
  takeItemTypeFromCharacterLocation,
  takeItemTypeFromOwnerLocation,
  spawnShipInStationHangar,
  updateInventoryItem,
  updateInventoryItemSuccessOnly,
  setPlasticWrapVolumeDurably,
  updateInventoryItemsAtomic,
  consumeInventoryItemStacksAtomic,
  commitNativeSpawnItems,
  listPendingNativeSpawnCompletions,
  restoreInventoryItemChangesAtomic,
  trashInventoryItemsMany,
  removeInventoryItem,
  consumeInventoryItemQuantity,
  consumeInventoryItemQuantityIdempotent,
  exchangeInventoryItemStacksIdempotent,
  pruneExpiredSpaceItems,
  moveItemToLocation,
  moveItemToLocationIdempotent,
  validateItemMoveToLocation,
  isCargoContainerInventoryItem,
  moveItemsAndSetShipPackagingState,
  transferItemToOwnerLocation,
  transferItemToOwnerLocationIdempotent,
  moveItemTypeFromCharacterLocation,
  mergeItemStacks,
  updateShipItem,
  setShipPackagingState,
  assembleInventoryItem,
  setItemPackagingState,
  moveShipToSpace,
  moveShipToSpaceIdempotent,
  getShipSpaceMoveReceipt,
  dockShipToLocation,
  dockShipToStation,
  setActiveShipForCharacter,
  ensureCapsuleForCharacter,
  resolveCapsuleTypeIDForCharacter,
  syncCapsuleTypeForCharacter,
  buildRemovedItemNotificationState,
  buildCreatedItemNotificationPreviousState,
  listContainerItems,
  listSystemSpaceItems,
  buildInventoryItem,
  buildShipItem,
  normalizeInventoryItem,
  normalizeShipItem,
  captureItemState,
  getShipConditionState,
  resetInventoryStoreForTests,
  normalizeShipConditionState,
  normalizeModuleState,
  getItemMetadata,
  getPackagedVolumeForType,
  getInventoryItemUnitVolume,
  getItemMutationVersion,
  getSimulationInventoryProjectionSeed,
};
