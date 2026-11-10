"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

/**
 * Process-local item-custody command boundary.
 *
 * Native NPC wreck contents -> the items table is the first durable route.
 * Cross-domain local moves commit an idempotency receipt with the item rows;
 * simulation-local moves remain non-durable custody commands.
 * The API is synchronous for compatibility, but commands and results
 * contain only detached data so the executor can later be replaced by an
 * authority RPC.
 */

const crypto = require("crypto");
const path = require("path");

const defaultItemStore = require(path.join(__dirname, "./itemStore"));
const defaultItemTypeRegistry = require(path.join(
  __dirname,
  "./itemTypeRegistry",
));
const defaultNativeNpcStore = require(path.join(
  __dirname,
  "../../space/npc/nativeNpcStore",
));

const CUSTODY_COMMAND_TYPE = Object.freeze({
  TRANSFER: "item-custody.transfer",
});

const CONTRACT_ESCROW_LOCATION_BASE = 9_300_000_000;

// Transient wreck item IDs come from a process-local counter that is reseeded
// from the same durable value on every start, so the next process reissues the
// exact same IDs. Loot receipts, by contrast, are durable. Naming this process
// in the key of a transient source's receipt is what keeps a reissued ID from
// meeting a receipt an earlier process wrote for a wreck that no longer exists.
const CUSTODY_BOOT_INSTANCE_ID = crypto.randomBytes(12).toString("base64url");

const CUSTODY_REF_KIND = Object.freeze({
  NATIVE_WRECK: "native-wreck",
  OWNER_LOCATION: "owner-location",
  STATION_HANGAR: "station-hangar",
  SHIP_BAY: "ship-bay",
  FITTING_SLOT: "fitting-slot",
  IN_SPACE: "in-space",
  CONTAINER: "container",
  DELIVERIES: "deliveries",
  CORPORATION_OFFICE: "corporation-office",
  MARKET_ESCROW: "market-escrow",
  CONTRACT_ESCROW: "contract-escrow",
  ASSET_SAFETY_WRAP: "asset-safety-wrap",
  REDEEM_TOKEN: "redeem-token",
  VOID: "void",
});

const CUSTODY_REASON = Object.freeze({
  FREELANCE_ITEM_DELIVERY: "freelance-item-delivery",
  NATIVE_WRECK_LOOT: "native-wreck-loot",
  NATIVE_WRECK_SALVAGE: "native-wreck-salvage",
  JETTISON_CONTAINER_CREATE: "jettison-container-create",
  JETTISON_CARGO_MOVE: "jettison-cargo-move",
  JETTISON_CONTAINER_ROLLBACK: "jettison-container-rollback",
  JETCAN_EMPTY_REMOVE: "jetcan-empty-remove",
  DRONE_LAUNCH: "drone-launch",
  DRONE_RECOVER: "drone-recover",
  DRONE_CAPTURE: "drone-capture",
  DRONE_RECOVER_ROLLBACK: "drone-recover-rollback",
  DRONE_SALVAGE_DELIVER: "drone-salvage-deliver",
  DRONE_SALVAGE_JETTISON: "drone-salvage-jettison",
  FIGHTER_LAUNCH: "fighter-launch",
  FIGHTER_LAUNCH_ROLLBACK: "fighter-launch-rollback",
  FIGHTER_RECOVER: "fighter-recover",
  FIGHTER_CAPTURE: "fighter-capture",
  MOBILE_DEPLOY: "mobile-deploy",
  SKYHOOK_DEPLOY: "skyhook-deploy",
  MOBILE_SCOOP: "mobile-scoop",
  MOBILE_DEPOT_CONTENT_EJECT_CONTAINER_CREATE: "mobile-depot-content-eject-container-create",
  MOBILE_DEPOT_CONTENT_EJECT_MOVE: "mobile-depot-content-eject-move",
  MOBILE_DEPOT_CONTENT_EJECT_ROLLBACK: "mobile-depot-content-eject-rollback",
  MOBILE_TRACTOR_UNIT_EJECT_ROLLBACK: "mobile-tractor-unit-eject-rollback",
  SPACE_ENTITY_DESTROY: "space-entity-destroy",
  MOBILE_EXPIRE: "mobile-expire",
  INV_BROKER_MOVE: "inv-broker-move",
  INV_BROKER_MERGE: "inv-broker-merge",
  INV_BROKER_OWNER_TRANSFER: "inv-broker-owner-transfer",
  STRUCTURE_DELIVERY: "structure-delivery",
  STRUCTURE_CARGO_DEPOSIT: "structure-cargo-deposit",
  STRUCTURE_UNANCHOR_HANDOFF: "structure-unanchor-handoff",
  ASSET_SAFETY_WRAP: "asset-safety-wrap",
  ASSET_SAFETY_DELIVER: "asset-safety-deliver",
  MARKET_ESCROW_PLACE: "market-escrow-place",
  MARKET_ESCROW_DELIVER: "market-escrow-deliver",
  MARKET_DIRECT_DELIVER: "market-direct-deliver",
  MARKET_FILL_COMPENSATE: "market-fill-compensate",
  MARKET_ESCROW_RETURN: "market-escrow-return",
  MARKET_SEED_DELIVER: "market-seed-deliver",
  MARKET_SEED_RESERVE: "market-seed-reserve",
  MARKET_SEED_RELEASE: "market-seed-release",
  MARKET_SEED_CONSUME: "market-seed-consume",
  TRADE_STAGE: "trade-stage",
  TRADE_ABORT: "trade-abort",
  TRADE_COMPLETE: "trade-complete",
  TRADE_COMPLETE_CONTENT: "trade-complete-content",
  TRADE_COMPENSATE: "trade-compensate",
  CONTRACT_ESCROW_STAGE: "contract-escrow-stage",
  CONTRACT_REQUEST_DELIVER: "contract-request-deliver",
  CONTRACT_ESCROW_DELIVER: "contract-escrow-deliver",
  CONTRACT_ESCROW_RETURN: "contract-escrow-return",
  CONTRACT_COURIER_ACCEPT: "contract-courier-accept",
  CONTRACT_CONTENT_DELIVER: "contract-content-deliver",
  CONTRACT_CONTENT_OWNER_TRANSFER: "contract-content-owner-transfer",
  CONTRACT_WRAP_CREATE: "contract-wrap-create",
  CONTRACT_WRAP_REMOVE: "contract-wrap-remove",
  LP_STORE_REQUIRED_CONSUME: "lp-store-required-consume",
  LP_STORE_REQUIRED_REFUND: "lp-store-required-refund",
  LP_STORE_REWARD_GRANT: "lp-store-reward-grant",
  RESEARCH_DATACORE_GRANT: "research-datacore-grant",
  CONTRABAND_CONFISCATE: "contraband-confiscate",
  REPROCESSING_INPUT_STAGE: "reprocessing-input-stage",
  REPROCESSING_INPUT_RETURN: "reprocessing-input-return",
  REPROCESSING_INPUT_COMMIT: "reprocessing-input-commit",
  REPROCESSING_OUTPUT_GRANT: "reprocessing-output-grant",
  REPROCESSING_OUTPUT_DELIVER: "reprocessing-output-deliver",
  REPROCESSING_OUTPUT_REVOKE: "reprocessing-output-revoke",
  MISSION_CARGO_STAGE: "mission-cargo-stage",
  MISSION_CARGO_RETURN: "mission-cargo-return",
  MISSION_CARGO_COMMIT: "mission-cargo-commit",
  MISSION_REWARD_GRANT: "mission-reward-grant",
  NODEGRAPH_REWARD_GRANT: "nodegraph-reward-grant",
  AIR_MINING_GRANT: "air-mining-grant",
  AIR_ENCOUNTER_GRANT: "air-encounter-grant",
  ESS_KEY_CONSUME: "ess-key-consume",
  ESS_BOND_GRANT: "ess-bond-grant",
  SKIN_COMPONENT_CONSUME: "skin-component-consume",
  CHARACTER_RESCULPT_CONSUME: "character-resculpt-consume",
  CAMPAIGN_REWARD_GRANT: "campaign-reward-grant",
  SKIN_BINDER_STAGE: "skin-binder-stage",
  SKIN_BINDER_RETURN: "skin-binder-return",
  SKIN_BINDER_CONSUME: "skin-binder-consume",
  SKIN_COMPONENT_STORE_GRANT: "skin-component-store-grant",
  MISSION_REWARD_DELIVER: "mission-reward-deliver",
  MISSION_REWARD_REVOKE: "mission-reward-revoke",
  PLANET_CUSTOMS_IMPORT_STAGE: "planet-customs-import-stage",
  PLANET_CUSTOMS_IMPORT_RETURN: "planet-customs-import-return",
  PLANET_CUSTOMS_IMPORT_COMMIT: "planet-customs-import-commit",
  PLANET_CUSTOMS_EXPORT_GRANT: "planet-customs-export-grant",
  PLANET_CUSTOMS_EXPORT_DELIVER: "planet-customs-export-deliver",
  PLANET_CUSTOMS_EXPORT_REVOKE: "planet-customs-export-revoke",
  PLANET_CUSTOMS_OFFICE_RELOCATE: "planet-customs-office-relocate",
  INDUSTRY_MATERIAL_STAGE: "industry-material-stage",
  INDUSTRY_MATERIAL_RETURN: "industry-material-return",
  INDUSTRY_MATERIAL_COMMIT: "industry-material-commit",
  INDUSTRY_BLUEPRINT_STAGE: "industry-blueprint-stage",
  INDUSTRY_BLUEPRINT_RETURN: "industry-blueprint-return",
  INDUSTRY_BLUEPRINT_INSTALL: "industry-blueprint-install",
  INDUSTRY_BLUEPRINT_CONSUME: "industry-blueprint-consume",
  JUMP_BRIDGE_FUEL_STAGE: "jump-bridge-fuel-stage",
  JUMP_BRIDGE_FUEL_RETURN: "jump-bridge-fuel-return",
  JUMP_BRIDGE_FUEL_COMMIT: "jump-bridge-fuel-commit",
  DEATH_LOOT_DROP: "death-loot-drop",
  DEATH_ITEM_DESTROY: "death-item-destroy",
  AIR_TUTORIAL_CONSUME: "air-tutorial-consume",
  DEATH_DEBRIS_CREATE: "death-debris-create",
  NPC_SENTRY_AMMO_DROP: "npc-sentry-ammo-drop",
  SKYHOOK_SILO_CREATE: "skyhook-silo-create",
  SKYHOOK_RAID_CONTAINER_CREATE: "skyhook-raid-container-create",
  SKYHOOK_RAID_REAGENTS_GRANT: "skyhook-raid-reagents-grant",
});

const LOCAL_PATCH_MOVE_REASONS = new Set([
  CUSTODY_REASON.AIR_ENCOUNTER_GRANT,
  CUSTODY_REASON.DRONE_RECOVER,
  CUSTODY_REASON.DRONE_CAPTURE,
  CUSTODY_REASON.DRONE_RECOVER_ROLLBACK,
  CUSTODY_REASON.FIGHTER_LAUNCH_ROLLBACK,
  CUSTODY_REASON.FIGHTER_RECOVER,
  CUSTODY_REASON.FIGHTER_CAPTURE,
  CUSTODY_REASON.MOBILE_SCOOP,
]);

// Hand-offs where ownership follows containment: the item changes hands as a
// whole, so its fitted modules, charges, drones and cargo change hands with it.
// A corporation hangar is the case that proved it -- a fitted ship deposited by
// one member and taken by another arrived with every module still owned by the
// member who fitted it, and listFittedItems, which filters by ownerID, then
// drew an empty fitting window on a hull that was plainly fitted.
//
// Deliberately not every cross-owner reason. Contract escrow keeps its own
// model: a contracted hull's fitting never leaves the seller, which is what
// lets a deletion treat already-owned contents as satisfied.
const CONTENTS_FOLLOW_OWNER_REASONS = new Set([
  CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
]);

const LOCAL_OWNER_CHANGE_REASONS = new Set([
  CUSTODY_REASON.FREELANCE_ITEM_DELIVERY,
  CUSTODY_REASON.DRONE_CAPTURE,
  CUSTODY_REASON.DRONE_RECOVER_ROLLBACK,
  CUSTODY_REASON.FIGHTER_CAPTURE,
  CUSTODY_REASON.MOBILE_DEPLOY,
  CUSTODY_REASON.SKYHOOK_DEPLOY,
  CUSTODY_REASON.MOBILE_SCOOP,
  CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
  CUSTODY_REASON.STRUCTURE_DELIVERY,
  CUSTODY_REASON.STRUCTURE_CARGO_DEPOSIT,
  CUSTODY_REASON.MARKET_ESCROW_DELIVER,
  CUSTODY_REASON.MARKET_DIRECT_DELIVER,
  CUSTODY_REASON.MARKET_FILL_COMPENSATE,
  CUSTODY_REASON.TRADE_STAGE,
  CUSTODY_REASON.TRADE_COMPLETE,
  CUSTODY_REASON.TRADE_COMPLETE_CONTENT,
  CUSTODY_REASON.TRADE_COMPENSATE,
  CUSTODY_REASON.CONTRACT_ESCROW_STAGE,
  CUSTODY_REASON.CONTRACT_REQUEST_DELIVER,
  CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
  CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
  CUSTODY_REASON.CONTRACT_COURIER_ACCEPT,
  CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
  CUSTODY_REASON.CONTRACT_CONTENT_OWNER_TRANSFER,
]);

const DURABLE_LOCAL_MOVE_REASONS = new Set([
  CUSTODY_REASON.CAMPAIGN_REWARD_GRANT,
  CUSTODY_REASON.CHARACTER_RESCULPT_CONSUME,
  CUSTODY_REASON.FREELANCE_ITEM_DELIVERY,
  CUSTODY_REASON.ESS_KEY_CONSUME,
  CUSTODY_REASON.ESS_BOND_GRANT,
  CUSTODY_REASON.SKIN_COMPONENT_STORE_GRANT,
  CUSTODY_REASON.SKIN_BINDER_STAGE,
  CUSTODY_REASON.SKIN_BINDER_RETURN,
  CUSTODY_REASON.SKIN_BINDER_CONSUME,
  CUSTODY_REASON.SKIN_COMPONENT_CONSUME,
  CUSTODY_REASON.SKYHOOK_DEPLOY,
  CUSTODY_REASON.AIR_TUTORIAL_CONSUME,
  CUSTODY_REASON.NODEGRAPH_REWARD_GRANT,
  CUSTODY_REASON.AIR_MINING_GRANT,
  CUSTODY_REASON.AIR_ENCOUNTER_GRANT,
  CUSTODY_REASON.DEATH_LOOT_DROP,
  CUSTODY_REASON.DEATH_ITEM_DESTROY,
  CUSTODY_REASON.DEATH_DEBRIS_CREATE,
  CUSTODY_REASON.SKYHOOK_SILO_CREATE,
  CUSTODY_REASON.SKYHOOK_RAID_CONTAINER_CREATE,
  CUSTODY_REASON.SKYHOOK_RAID_REAGENTS_GRANT,
  CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
  CUSTODY_REASON.STRUCTURE_DELIVERY,
  CUSTODY_REASON.STRUCTURE_CARGO_DEPOSIT,
  CUSTODY_REASON.STRUCTURE_UNANCHOR_HANDOFF,
  CUSTODY_REASON.ASSET_SAFETY_WRAP,
  CUSTODY_REASON.ASSET_SAFETY_DELIVER,
  CUSTODY_REASON.MARKET_ESCROW_PLACE,
  CUSTODY_REASON.MARKET_ESCROW_DELIVER,
  CUSTODY_REASON.MARKET_DIRECT_DELIVER,
  CUSTODY_REASON.MARKET_FILL_COMPENSATE,
  CUSTODY_REASON.MARKET_ESCROW_RETURN,
  CUSTODY_REASON.MARKET_SEED_DELIVER,
  CUSTODY_REASON.MARKET_SEED_RESERVE,
  CUSTODY_REASON.MARKET_SEED_RELEASE,
  CUSTODY_REASON.MARKET_SEED_CONSUME,
  CUSTODY_REASON.TRADE_STAGE,
  CUSTODY_REASON.TRADE_ABORT,
  CUSTODY_REASON.TRADE_COMPLETE,
  CUSTODY_REASON.TRADE_COMPLETE_CONTENT,
  CUSTODY_REASON.TRADE_COMPENSATE,
  CUSTODY_REASON.CONTRACT_ESCROW_STAGE,
  CUSTODY_REASON.CONTRACT_REQUEST_DELIVER,
  CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
  CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
  CUSTODY_REASON.CONTRACT_COURIER_ACCEPT,
  CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
  CUSTODY_REASON.CONTRACT_CONTENT_OWNER_TRANSFER,
  CUSTODY_REASON.CONTRACT_WRAP_CREATE,
  CUSTODY_REASON.CONTRACT_WRAP_REMOVE,
  CUSTODY_REASON.LP_STORE_REQUIRED_CONSUME,
  CUSTODY_REASON.LP_STORE_REQUIRED_REFUND,
  CUSTODY_REASON.LP_STORE_REWARD_GRANT,
  CUSTODY_REASON.RESEARCH_DATACORE_GRANT,
  CUSTODY_REASON.CONTRABAND_CONFISCATE,
  CUSTODY_REASON.REPROCESSING_INPUT_STAGE,
  CUSTODY_REASON.REPROCESSING_INPUT_RETURN,
  CUSTODY_REASON.REPROCESSING_INPUT_COMMIT,
  CUSTODY_REASON.REPROCESSING_OUTPUT_GRANT,
  CUSTODY_REASON.REPROCESSING_OUTPUT_DELIVER,
  CUSTODY_REASON.REPROCESSING_OUTPUT_REVOKE,
  CUSTODY_REASON.MISSION_CARGO_STAGE,
  CUSTODY_REASON.MISSION_CARGO_RETURN,
  CUSTODY_REASON.MISSION_CARGO_COMMIT,
  CUSTODY_REASON.MISSION_REWARD_GRANT,
  CUSTODY_REASON.MISSION_REWARD_DELIVER,
  CUSTODY_REASON.MISSION_REWARD_REVOKE,
  CUSTODY_REASON.PLANET_CUSTOMS_IMPORT_STAGE,
  CUSTODY_REASON.PLANET_CUSTOMS_IMPORT_RETURN,
  CUSTODY_REASON.PLANET_CUSTOMS_IMPORT_COMMIT,
  CUSTODY_REASON.PLANET_CUSTOMS_EXPORT_GRANT,
  CUSTODY_REASON.PLANET_CUSTOMS_EXPORT_DELIVER,
  CUSTODY_REASON.PLANET_CUSTOMS_EXPORT_REVOKE,
  CUSTODY_REASON.PLANET_CUSTOMS_OFFICE_RELOCATE,
  CUSTODY_REASON.INDUSTRY_MATERIAL_STAGE,
  CUSTODY_REASON.INDUSTRY_MATERIAL_RETURN,
  CUSTODY_REASON.INDUSTRY_MATERIAL_COMMIT,
  CUSTODY_REASON.INDUSTRY_BLUEPRINT_STAGE,
  CUSTODY_REASON.INDUSTRY_BLUEPRINT_RETURN,
  CUSTODY_REASON.INDUSTRY_BLUEPRINT_INSTALL,
  CUSTODY_REASON.INDUSTRY_BLUEPRINT_CONSUME,
  CUSTODY_REASON.JUMP_BRIDGE_FUEL_STAGE,
  CUSTODY_REASON.JUMP_BRIDGE_FUEL_RETURN,
  CUSTODY_REASON.JUMP_BRIDGE_FUEL_COMMIT,
]);

const DRONE_CUSTODY_REASONS = new Set([
  CUSTODY_REASON.DRONE_LAUNCH,
  CUSTODY_REASON.DRONE_RECOVER,
  CUSTODY_REASON.DRONE_CAPTURE,
  CUSTODY_REASON.DRONE_RECOVER_ROLLBACK,
]);

const DRONE_CATEGORY_ID = 18;

const FIGHTER_CUSTODY_REASONS = new Set([
  CUSTODY_REASON.FIGHTER_LAUNCH,
  CUSTODY_REASON.FIGHTER_LAUNCH_ROLLBACK,
  CUSTODY_REASON.FIGHTER_RECOVER,
  CUSTODY_REASON.FIGHTER_CAPTURE,
]);

const FIGHTER_CATEGORY_ID = 87;

const MOBILE_DEPLOY_CATEGORY_IDS = new Set([22, 46]);
const STARBASE_CATEGORY_ID = 23;

function isMobileDeployItem(item) {
  const categoryID = Number(item && item.categoryID);
  return (
    MOBILE_DEPLOY_CATEGORY_IDS.has(categoryID) ||
    categoryID === STARBASE_CATEGORY_ID
  );
}

const LOCAL_DESTINATION_PATCH_KEYS = new Set([
  "customInfo",
  "singleton",
  "quantity",
  "stacksize",
  "launcherID",
  "spaceState",
  "fighterState",
  // Drones carry their health in conditionState the way fighters carry theirs
  // in fighterState, so stowing one has to be able to settle it in the same
  // atomic custody write that moves the row into the bay.
  "conditionState",
  "expiresAtMs",
  "spaceRadius",
  "mobileDepotState",
  "clientCustomInfo",
]);

const LOCATION_REF_KINDS = new Set([
  CUSTODY_REF_KIND.OWNER_LOCATION,
  CUSTODY_REF_KIND.STATION_HANGAR,
  CUSTODY_REF_KIND.SHIP_BAY,
  CUSTODY_REF_KIND.FITTING_SLOT,
  CUSTODY_REF_KIND.IN_SPACE,
  CUSTODY_REF_KIND.CONTAINER,
  CUSTODY_REF_KIND.DELIVERIES,
  CUSTODY_REF_KIND.CORPORATION_OFFICE,
  CUSTODY_REF_KIND.CONTRACT_ESCROW,
]);

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function toFlagID(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function isSingletonRecord(record) {
  return Boolean(
    record && (record.singleton === true || Number(record.singleton) > 0),
  );
}

function nativeWreckSingleton(record) {
  return Number(record && record.singleton) === 2 ? 2 : isSingletonRecord(record) ? 1 : 0;
}

function makeRef(kind, fields = {}) {
  return Object.freeze({ kind, ...cloneValue(fields) });
}

const custodyRef = Object.freeze({
  nativeWreck(wreckID) {
    return makeRef(CUSTODY_REF_KIND.NATIVE_WRECK, {
      wreckID: toPositiveInt(wreckID, 0),
    });
  },
  ownerLocation(ownerID, locationID, flagID = defaultItemStore.ITEM_FLAGS.HANGAR) {
    return makeRef(CUSTODY_REF_KIND.OWNER_LOCATION, {
      ownerID: toPositiveInt(ownerID, 0),
      locationID: toPositiveInt(locationID, 0),
      flagID: Math.max(0, Math.trunc(Number(flagID) || 0)),
    });
  },
  stationHangar(ownerID, stationID) {
    return makeRef(CUSTODY_REF_KIND.STATION_HANGAR, {
      ownerID: toPositiveInt(ownerID, 0),
      locationID: toPositiveInt(stationID, 0),
      flagID: defaultItemStore.ITEM_FLAGS.HANGAR,
    });
  },
  shipBay(ownerID, shipID, flagID) {
    return makeRef(CUSTODY_REF_KIND.SHIP_BAY, {
      ownerID: toPositiveInt(ownerID, 0),
      locationID: toPositiveInt(shipID, 0),
      flagID: Math.max(0, Math.trunc(Number(flagID) || 0)),
    });
  },
  fittingSlot(ownerID, shipID, flagID) {
    return makeRef(CUSTODY_REF_KIND.FITTING_SLOT, {
      ownerID: toPositiveInt(ownerID, 0),
      locationID: toPositiveInt(shipID, 0),
      flagID: Math.max(0, Math.trunc(Number(flagID) || 0)),
    });
  },
  inSpace(ownerID, solarSystemID, spaceState = null) {
    return makeRef(CUSTODY_REF_KIND.IN_SPACE, {
      ownerID: toPositiveInt(ownerID, 0),
      locationID: toPositiveInt(solarSystemID, 0),
      flagID: 0,
      spaceState: cloneValue(spaceState),
    });
  },
  container(ownerID, containerID, flagID = defaultItemStore.ITEM_FLAGS.HANGAR) {
    return makeRef(CUSTODY_REF_KIND.CONTAINER, {
      ownerID: toPositiveInt(ownerID, 0),
      locationID: toPositiveInt(containerID, 0),
      flagID: Math.max(0, Math.trunc(Number(flagID) || 0)),
    });
  },
  deliveries(ownerID, locationID, flagID) {
    return makeRef(CUSTODY_REF_KIND.DELIVERIES, {
      ownerID: toPositiveInt(ownerID, 0),
      locationID: toPositiveInt(locationID, 0),
      flagID: Math.max(0, Math.trunc(Number(flagID) || 0)),
    });
  },
  corporationOffice(corporationID, officeID, divisionFlagID) {
    return makeRef(CUSTODY_REF_KIND.CORPORATION_OFFICE, {
      ownerID: toPositiveInt(corporationID, 0),
      locationID: toPositiveInt(officeID, 0),
      flagID: Math.max(0, Math.trunc(Number(divisionFlagID) || 0)),
    });
  },
  marketEscrow(orderID) {
    return makeRef(CUSTODY_REF_KIND.MARKET_ESCROW, {
      orderID: toPositiveInt(orderID, 0),
    });
  },
  contractEscrow(contractID) {
    const normalizedContractID = toPositiveInt(contractID, 0);
    return makeRef(CUSTODY_REF_KIND.CONTRACT_ESCROW, {
      contractID: normalizedContractID,
      ownerID: 1,
      locationID: normalizedContractID
        ? CONTRACT_ESCROW_LOCATION_BASE + normalizedContractID
        : 0,
      flagID: 0,
    });
  },
  assetSafetyWrap(wrapID) {
    return makeRef(CUSTODY_REF_KIND.ASSET_SAFETY_WRAP, {
      wrapID: toPositiveInt(wrapID, 0),
    });
  },
  redeemToken(accountID) {
    return makeRef(CUSTODY_REF_KIND.REDEEM_TOKEN, {
      accountID: toPositiveInt(accountID, 0),
    });
  },
  void() {
    return makeRef(CUSTODY_REF_KIND.VOID);
  },
});

function buildNativeWreckItemLikeRow(record, itemFlags = defaultItemStore.ITEM_FLAGS) {
  const singleton = nativeWreckSingleton(record);
  const quantity = singleton
    ? 1
    : Math.max(1, toPositiveInt(record && record.quantity, 1));
  return {
    itemID: toPositiveInt(record && record.wreckItemID, 0),
    typeID: toPositiveInt(record && record.typeID, 0),
    ownerID: toPositiveInt(record && record.ownerID, 0),
    locationID: toPositiveInt(record && record.wreckID, 0),
    flagID: toPositiveInt(record && record.flagID, itemFlags.HANGAR),
    quantity: singleton ? -singleton : quantity,
    stacksize: singleton ? 1 : quantity,
    singleton,
    groupID: toPositiveInt(record && record.groupID, 0),
    categoryID: toPositiveInt(record && record.categoryID, 0),
    itemName: String(record && record.itemName || ""),
    customInfo: String(record && record.customInfo || ""),
    volume: toFiniteNumber(record && record.volume, 0),
    moduleState: cloneValue(record && record.moduleState || null),
  };
}

function sourceAvailableQuantity(record) {
  return isSingletonRecord(record)
    ? 1
    : Math.max(1, toPositiveInt(record && record.quantity, 1));
}

function sourceFingerprint(record) {
  return {
    wreckItemID: toPositiveInt(record && record.wreckItemID, 0),
    wreckID: toPositiveInt(record && record.wreckID, 0),
    ownerID: toPositiveInt(record && record.ownerID, 0),
    typeID: toPositiveInt(record && record.typeID, 0),
    singleton: isSingletonRecord(record),
  };
}

function sameSourceFingerprint(left, right) {
  return Boolean(
    left &&
      right &&
      toPositiveInt(left.wreckItemID, 0) === toPositiveInt(right.wreckItemID, 0) &&
      toPositiveInt(left.wreckID, 0) === toPositiveInt(right.wreckID, 0) &&
      toPositiveInt(left.ownerID, 0) === toPositiveInt(right.ownerID, 0) &&
      toPositiveInt(left.typeID, 0) === toPositiveInt(right.typeID, 0) &&
      Boolean(left.singleton) === Boolean(right.singleton)
  );
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  return key && key.length <= 320 ? key : "";
}

function normalizeLocalDestinationPatch(value) {
  if (value === null || value === undefined) {
    return { success: true, patch: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { success: false, errorMsg: "INVALID_CUSTODY_DESTINATION_PATCH" };
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !LOCAL_DESTINATION_PATCH_KEYS.has(key))) {
    return { success: false, errorMsg: "INVALID_CUSTODY_DESTINATION_PATCH" };
  }
  return {
    success: true,
    patch: Object.fromEntries(keys.map((key) => [key, cloneValue(value[key])])),
  };
}

function buildReceiptKey(idempotencyKey) {
  const normalized = normalizeIdempotencyKey(idempotencyKey);
  if (!normalized) {
    return "";
  }
  const key = `item-custody:native-wreck:${encodeURIComponent(normalized)}`;
  return key.length <= 512 ? key : "";
}

function buildLocalReceiptKey(idempotencyKey) {
  const normalized = normalizeIdempotencyKey(idempotencyKey);
  if (!normalized) {
    return "";
  }
  return `item-custody:local:${crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")}`;
}

function normalizeBootInstanceID(value) {
  const bootInstanceID = String(value === null || value === undefined ? "" : value)
    .trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(bootInstanceID) ? bootInstanceID : "";
}

function buildBootScopeSegment(bootInstanceID) {
  const normalized = normalizeBootInstanceID(bootInstanceID);
  return normalized ? `boot:${normalized}:` : "";
}

// A transient wreck row dies with the process, so a receipt describing one can
// never protect a legitimate replay after a restart: the wreck it names cannot
// come back, and its wreck item ID is handed to an unrelated wreck by the next
// process. Scope those keys to this process. Durable wreck rows do survive, so
// their keys stay boot-independent — a restart still has to be able to finish a
// grant the previous process had already committed against a row it can see.
function buildDefaultNativeWreckIdempotencyKey(
  record,
  requestedQuantity,
  bootInstanceID = "",
) {
  const wreckItemID = toPositiveInt(record && record.wreckItemID, 0);
  if (!wreckItemID) {
    return "";
  }
  const scope = record && record.transient === true
    ? buildBootScopeSegment(bootInstanceID)
    : "";
  const availableQuantity = sourceAvailableQuantity(record);
  const quantity = requestedQuantity === null || requestedQuantity === undefined
    ? availableQuantity
    : toPositiveInt(requestedQuantity, 0);
  if (quantity === availableQuantity) {
    return `native-wreck-item:${wreckItemID}:${scope}whole`;
  }
  const revision = Math.max(0, Math.trunc(Number(record.custodyRevision) || 0));
  return `native-wreck-item:${wreckItemID}:${scope}revision:${revision}:quantity:${quantity}`;
}

function buildMissingSourceDefaultIdempotencyKey(wreckItemID, bootInstanceID = "") {
  const normalizedItemID = toPositiveInt(wreckItemID, 0);
  return normalizedItemID
    ? `native-wreck-item:${normalizedItemID}:${buildBootScopeSegment(bootInstanceID)}whole`
    : "";
}

function receiptCustodyMetadata(receipt) {
  const metadata = receipt && receipt.metadata && typeof receipt.metadata === "object"
    ? receipt.metadata.itemCustody
    : null;
  return metadata && typeof metadata === "object" ? metadata : null;
}

// Dead by construction: the transient source it describes cannot exist in this
// process, so the receipt can only ever be met by an unrelated wreck that was
// handed the same reissued ID. Receipts written before keys carried a boot
// instance have no marker at all, which reads as "some earlier process".
function isDeadTransientWreckReceipt(receipt, bootInstanceID) {
  const metadata = receiptCustodyMetadata(receipt);
  const source = metadata && metadata.source && typeof metadata.source === "object"
    ? metadata.source
    : null;
  return Boolean(
    source &&
      String(source.kind || "") === CUSTODY_REF_KIND.NATIVE_WRECK &&
      source.transient === true &&
      normalizeBootInstanceID(source.bootInstanceID) !==
        normalizeBootInstanceID(bootInstanceID),
  );
}

function buildResultError(errorMsg, options = {}) {
  return {
    success: false,
    ambiguous: options.ambiguous === true,
    errorMsg: String(errorMsg || "ITEM_CUSTODY_FAILED"),
    data: {
      commandType: CUSTODY_COMMAND_TYPE.TRANSFER,
      sequence: toPositiveInt(options.sequence, 0) || null,
      idempotencyKey: String(options.idempotencyKey || "") || null,
      receiptKey: String(options.receiptKey || "") || null,
      // Present only when a named field refused the command, so a caller can
      // log which clause failed instead of re-deriving it from source.
      mismatch: options.mismatch ? cloneValue(options.mismatch) : null,
      lifecycle: {
        reserved: options.reserved === true,
        committed: false,
        compensated: options.compensated === true,
      },
    },
  };
}

function createStats() {
  return {
    submitted: 0,
    completed: 0,
    failed: 0,
    ambiguous: 0,
    duplicate: 0,
    compensated: 0,
    rejectedReentrant: 0,
  };
}

function createItemCustody(options = {}) {
  const itemStore = options.itemStore || defaultItemStore;
  const nativeNpcStore = options.nativeNpcStore || defaultNativeNpcStore;
  const resolveItemByTypeID = options.resolveItemByTypeID ||
    defaultItemTypeRegistry.resolveItemByTypeID;
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : Date.now;
  const lifecycleHook = typeof options.lifecycleHook === "function"
    ? options.lifecycleHook
    : null;
  const bootInstanceID = normalizeBootInstanceID(options.bootInstanceID) ||
    CUSTODY_BOOT_INSTANCE_ID;

  let nextSequence = 1;
  let activeCommand = null;
  let stats = createStats();
  let deadReceiptsPruned = false;

  // Nothing else retires a native-wreck receipt, so without this the ledger
  // grows for the lifetime of the database. Every receipt a previous process
  // wrote for a transient source is dead, so drop them the first time this
  // process looks a native wreck up. A failed prune is not a correctness
  // problem — the keys are already scoped away from this process — so it only
  // costs the ledger another boot's worth of rows.
  function pruneDeadTransientWreckReceipts() {
    if (deadReceiptsPruned) {
      return;
    }
    deadReceiptsPruned = true;
    if (typeof itemStore.pruneIdempotentGrantReceipts !== "function") {
      return;
    }
    itemStore.pruneIdempotentGrantReceipts(
      (receipt) => isDeadTransientWreckReceipt(receipt, bootInstanceID),
    );
  }

  function flushSourceBoundary(transient = false) {
    if (transient === true) {
      // Runtime-only wreck rows deliberately do not survive a restart. Their
      // reservation is process-local; the durable destination receipt remains
      // sufficient because the source itself cannot reappear after recovery.
      return { success: true, durable: false };
    }
    if (typeof nativeNpcStore.flushNativeWreckItemsSync !== "function") {
      return { success: true, durable: false };
    }
    const result = nativeNpcStore.flushNativeWreckItemsSync();
    return result && result.success === true
      ? { success: true, durable: true }
      : {
          success: false,
          durable: false,
          errorMsg: result && result.errorMsg || "ITEM_CUSTODY_SOURCE_FLUSH_FAILED",
        };
  }

  function invokeLifecycleHook(step, context) {
    if (lifecycleHook) {
      lifecycleHook(step, cloneValue(context));
    }
  }

  function normalizeNativeWreckTransferCommand(rawCommand, sequence) {
    const command = cloneValue(rawCommand || {});
    const from = command.from && typeof command.from === "object"
      ? command.from
      : null;
    const to = command.to && typeof command.to === "object" ? command.to : null;
    const itemSpecs = Array.isArray(command.items) ? command.items : [command.items];
    const itemSpec = itemSpecs[0];
    const wreckItemID = toPositiveInt(
      itemSpec && typeof itemSpec === "object" ? itemSpec.itemID : itemSpec,
      0,
    );
    const requestedQuantity = itemSpec && typeof itemSpec === "object" &&
      itemSpec.quantity !== null && itemSpec.quantity !== undefined
      ? toPositiveInt(itemSpec.quantity, 0)
      : null;
    const destination = to && LOCATION_REF_KINDS.has(String(to.kind || ""))
      ? {
          kind: String(to.kind),
          ownerID: toPositiveInt(to.ownerID, 0),
          locationID: toPositiveInt(to.locationID, 0),
          flagID: Math.max(0, Math.trunc(Number(to.flagID) || 0)),
        }
      : null;
    const hasSuppliedIdempotencyKey = Boolean(
      command.idempotencyKey !== null &&
        command.idempotencyKey !== undefined &&
        String(command.idempotencyKey).trim(),
    );
    const suppliedIdempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
    const source = from && from.kind === CUSTODY_REF_KIND.NATIVE_WRECK
      ? {
          kind: CUSTODY_REF_KIND.NATIVE_WRECK,
          wreckID: toPositiveInt(from.wreckID, 0),
        }
      : null;

    if (!source || !destination || !wreckItemID || itemSpecs.length !== 1) {
      return {
        success: false,
        result: buildResultError("ITEM_CUSTODY_ROUTE_NOT_SUPPORTED", { sequence }),
      };
    }
    if (!destination.ownerID || !destination.locationID) {
      return {
        success: false,
        result: buildResultError("INVALID_GRANT_DESTINATION", { sequence }),
      };
    }
    if (itemSpec && typeof itemSpec === "object" &&
      itemSpec.quantity !== null && itemSpec.quantity !== undefined &&
      !requestedQuantity) {
      return {
        success: false,
        result: buildResultError("ITEM_QUANTITY_OUT_OF_RANGE", { sequence }),
      };
    }
    if (hasSuppliedIdempotencyKey && !suppliedIdempotencyKey) {
      return {
        success: false,
        result: buildResultError("INVALID_IDEMPOTENCY_KEY", { sequence }),
      };
    }

    return {
      success: true,
      command: {
        commandType: CUSTODY_COMMAND_TYPE.TRANSFER,
        sequence,
        source,
        destination,
        wreckItemID,
        requestedQuantity,
        actor: toPositiveInt(command.actor, 0) || null,
        reason: String(command.reason || CUSTODY_REASON.NATIVE_WRECK_LOOT),
        suppliedIdempotencyKey,
      },
    };
  }

  function normalizeLocationRef(value) {
    if (!value || !LOCATION_REF_KINDS.has(String(value.kind || ""))) {
      return null;
    }
    return {
      kind: String(value.kind),
      ownerID: toPositiveInt(value.ownerID, 0),
      locationID: toPositiveInt(value.locationID, 0),
      flagID: Math.max(0, Math.trunc(Number(value.flagID) || 0)),
    };
  }

  function classifyTransferRoute(rawCommand = {}) {
    const fromKind = String(rawCommand.from && rawCommand.from.kind || "");
    const toKind = String(rawCommand.to && rawCommand.to.kind || "");
    if (fromKind === CUSTODY_REF_KIND.NATIVE_WRECK) {
      return "native-wreck";
    }
    if (!rawCommand.from && toKind === CUSTODY_REF_KIND.IN_SPACE) {
      return "local-space-mint";
    }
    if (!rawCommand.from && LOCATION_REF_KINDS.has(toKind)) {
      return "local-mint";
    }
    if (LOCATION_REF_KINDS.has(fromKind) && LOCATION_REF_KINDS.has(toKind)) {
      return "local-move";
    }
    if (LOCATION_REF_KINDS.has(fromKind) && toKind === CUSTODY_REF_KIND.VOID) {
      return "local-remove";
    }
    return "unsupported";
  }

  function localReasonRouteMatches(reason, route, source, destination) {
    if (reason === CUSTODY_REASON.FREELANCE_ITEM_DELIVERY) {
      return route === "local-move" && source?.kind === CUSTODY_REF_KIND.STATION_HANGAR &&
        source.flagID === 4 && destination?.kind === CUSTODY_REF_KIND.CORPORATION_OFFICE &&
        destination.flagID === 184;
    }
    if ([CUSTODY_REASON.DEATH_DEBRIS_CREATE, CUSTODY_REASON.SKYHOOK_SILO_CREATE, CUSTODY_REASON.SKYHOOK_RAID_CONTAINER_CREATE].includes(reason)) {
      return route === "local-space-mint";
    }
    if (reason === CUSTODY_REASON.SKYHOOK_RAID_REAGENTS_GRANT) return route === "local-mint";
    const cargoHoldFlag = Number(itemStore.ITEM_FLAGS && itemStore.ITEM_FLAGS.CARGO_HOLD) || 5;
    const droneBayFlag = Number(itemStore.ITEM_FLAGS && itemStore.ITEM_FLAGS.DRONE_BAY) || 87;
    const fighterBayFlag = Number(itemStore.ITEM_FLAGS && itemStore.ITEM_FLAGS.FIGHTER_BAY) || 158;
    const fighterTubeFlags = new Set(
      Array.isArray(itemStore.FIGHTER_TUBE_FLAGS)
        ? itemStore.FIGHTER_TUBE_FLAGS.map((flagID) => Number(flagID))
        : [159, 160, 161, 162, 163],
    );
    if (reason === CUSTODY_REASON.DRONE_LAUNCH) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          source.flagID === droneBayFlag &&
          destination && destination.kind === CUSTODY_REF_KIND.IN_SPACE,
      );
    }
    if (
      reason === CUSTODY_REASON.DRONE_RECOVER ||
      reason === CUSTODY_REASON.DRONE_CAPTURE
    ) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.IN_SPACE &&
          destination && destination.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          (
            destination.flagID === droneBayFlag ||
            destination.flagID === cargoHoldFlag
          ),
      );
    }
    if (reason === CUSTODY_REASON.DRONE_RECOVER_ROLLBACK) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          (
            source.flagID === droneBayFlag ||
            source.flagID === cargoHoldFlag
          ) &&
          destination && destination.kind === CUSTODY_REF_KIND.IN_SPACE,
      );
    }
    // A salvage drone carries what it salvages in its own cargo hold. It hands that salvage
    // to its ship's cargo hold, or, when it cannot, leaves it in a cargo container in space.
    if (reason === CUSTODY_REASON.DRONE_SALVAGE_DELIVER) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.CONTAINER &&
          source.flagID === cargoHoldFlag &&
          destination && destination.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          destination.flagID === cargoHoldFlag,
      );
    }
    if (reason === CUSTODY_REASON.DRONE_SALVAGE_JETTISON) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.CONTAINER &&
          source.flagID === cargoHoldFlag &&
          destination && destination.kind === CUSTODY_REF_KIND.CONTAINER,
      );
    }
    if (reason === CUSTODY_REASON.FIGHTER_LAUNCH) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          fighterTubeFlags.has(source.flagID) &&
          destination && destination.kind === CUSTODY_REF_KIND.IN_SPACE,
      );
    }
    if (reason === CUSTODY_REASON.FIGHTER_LAUNCH_ROLLBACK) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.IN_SPACE &&
          destination && destination.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          fighterTubeFlags.has(destination.flagID),
      );
    }
    if (
      reason === CUSTODY_REASON.FIGHTER_RECOVER ||
      reason === CUSTODY_REASON.FIGHTER_CAPTURE
    ) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.IN_SPACE &&
          destination && destination.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          (
            destination.flagID === fighterBayFlag ||
            fighterTubeFlags.has(destination.flagID)
          ),
      );
    }
    if (reason === CUSTODY_REASON.MOBILE_DEPLOY || reason === CUSTODY_REASON.SKYHOOK_DEPLOY) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          destination && destination.kind === CUSTODY_REF_KIND.IN_SPACE,
      );
    }
    if (reason === CUSTODY_REASON.MOBILE_SCOOP) {
      return Boolean(
        route === "local-move" &&
          source && source.kind === CUSTODY_REF_KIND.IN_SPACE &&
          destination && destination.kind === CUSTODY_REF_KIND.SHIP_BAY &&
          (
            destination.flagID === 5 ||
            destination.flagID === 183
          ),
      );
    }
    if (
      reason === CUSTODY_REASON.SPACE_ENTITY_DESTROY ||
      reason === CUSTODY_REASON.MOBILE_EXPIRE
    ) {
      return Boolean(
        route === "local-remove" &&
          source && source.kind === CUSTODY_REF_KIND.IN_SPACE,
      );
    }
    if (reason === CUSTODY_REASON.MARKET_SEED_CONSUME) {
      return route === "local-remove";
    }
    if (reason === CUSTODY_REASON.LP_STORE_REQUIRED_CONSUME) {
      return route === "local-remove";
    }
    if (reason === CUSTODY_REASON.CONTRABAND_CONFISCATE) {
      return route === "local-remove";
    }
    if (
      reason === CUSTODY_REASON.REPROCESSING_INPUT_COMMIT ||
      reason === CUSTODY_REASON.REPROCESSING_OUTPUT_REVOKE ||
      reason === CUSTODY_REASON.MISSION_CARGO_COMMIT ||
      reason === CUSTODY_REASON.MISSION_REWARD_REVOKE ||
      reason === CUSTODY_REASON.PLANET_CUSTOMS_IMPORT_COMMIT ||
      reason === CUSTODY_REASON.PLANET_CUSTOMS_EXPORT_REVOKE ||
      reason === CUSTODY_REASON.INDUSTRY_MATERIAL_COMMIT ||
      reason === CUSTODY_REASON.INDUSTRY_BLUEPRINT_CONSUME
    ) {
      return route === "local-remove";
    }
    if (
      reason === CUSTODY_REASON.REPROCESSING_INPUT_STAGE ||
      reason === CUSTODY_REASON.REPROCESSING_INPUT_RETURN ||
      reason === CUSTODY_REASON.REPROCESSING_OUTPUT_DELIVER ||
      reason === CUSTODY_REASON.MISSION_CARGO_STAGE ||
      reason === CUSTODY_REASON.MISSION_CARGO_RETURN ||
      reason === CUSTODY_REASON.MISSION_REWARD_DELIVER ||
      reason === CUSTODY_REASON.PLANET_CUSTOMS_IMPORT_STAGE ||
      reason === CUSTODY_REASON.PLANET_CUSTOMS_IMPORT_RETURN ||
      reason === CUSTODY_REASON.PLANET_CUSTOMS_EXPORT_DELIVER ||
      reason === CUSTODY_REASON.PLANET_CUSTOMS_OFFICE_RELOCATE ||
      reason === CUSTODY_REASON.INDUSTRY_MATERIAL_STAGE ||
      reason === CUSTODY_REASON.INDUSTRY_MATERIAL_RETURN ||
      reason === CUSTODY_REASON.INDUSTRY_BLUEPRINT_STAGE ||
      reason === CUSTODY_REASON.INDUSTRY_BLUEPRINT_RETURN ||
      reason === CUSTODY_REASON.INDUSTRY_BLUEPRINT_INSTALL
    ) {
      return route === "local-move" &&
        (reason !== CUSTODY_REASON.PLANET_CUSTOMS_OFFICE_RELOCATE ||
          (source && destination && source.ownerID === destination.ownerID));
    }
    if (reason === CUSTODY_REASON.SKIN_BINDER_CONSUME || reason === CUSTODY_REASON.CHARACTER_RESCULPT_CONSUME) return route === "local-remove";
    if ([CUSTODY_REASON.SKIN_BINDER_STAGE, CUSTODY_REASON.SKIN_BINDER_RETURN].includes(reason)) return route === "local-move" && source?.ownerID === destination?.ownerID;
    if (reason === CUSTODY_REASON.INV_BROKER_MOVE) {
      return route === "local-move";
    }
    if (reason === CUSTODY_REASON.INV_BROKER_MERGE) {
      return Boolean(
        route === "local-move" &&
          source && destination &&
          source.ownerID === destination.ownerID,
      );
    }
    if (reason === CUSTODY_REASON.ESS_KEY_CONSUME) return route === "local-remove";
    if (reason === CUSTODY_REASON.ESS_BOND_GRANT) return route === "local-mint";
    if (reason === CUSTODY_REASON.SKIN_COMPONENT_STORE_GRANT) return route === "local-mint";
    if (reason === CUSTODY_REASON.AIR_ENCOUNTER_GRANT) return ["local-mint", "local-move"].includes(route);
    if ([
      CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
      CUSTODY_REASON.STRUCTURE_DELIVERY,
      CUSTODY_REASON.STRUCTURE_CARGO_DEPOSIT,
      CUSTODY_REASON.STRUCTURE_UNANCHOR_HANDOFF,
      CUSTODY_REASON.ASSET_SAFETY_WRAP,
      CUSTODY_REASON.ASSET_SAFETY_DELIVER,
      CUSTODY_REASON.MARKET_ESCROW_PLACE,
      CUSTODY_REASON.MARKET_ESCROW_DELIVER,
      CUSTODY_REASON.MARKET_DIRECT_DELIVER,
      CUSTODY_REASON.MARKET_FILL_COMPENSATE,
      CUSTODY_REASON.MARKET_ESCROW_RETURN,
      CUSTODY_REASON.MARKET_SEED_RESERVE,
      CUSTODY_REASON.MARKET_SEED_RELEASE,
      CUSTODY_REASON.TRADE_STAGE,
      CUSTODY_REASON.TRADE_ABORT,
      CUSTODY_REASON.TRADE_COMPLETE,
      CUSTODY_REASON.TRADE_COMPLETE_CONTENT,
      CUSTODY_REASON.TRADE_COMPENSATE,
      CUSTODY_REASON.CONTRACT_ESCROW_STAGE,
      CUSTODY_REASON.CONTRACT_REQUEST_DELIVER,
      CUSTODY_REASON.CONTRACT_ESCROW_DELIVER,
      CUSTODY_REASON.CONTRACT_ESCROW_RETURN,
      CUSTODY_REASON.CONTRACT_COURIER_ACCEPT,
      CUSTODY_REASON.CONTRACT_CONTENT_DELIVER,
      CUSTODY_REASON.CONTRACT_CONTENT_OWNER_TRANSFER,
      CUSTODY_REASON.DEATH_LOOT_DROP,
    ].includes(reason)) {
      return route === "local-move";
    }
    if (
      reason === CUSTODY_REASON.MARKET_SEED_DELIVER ||
      reason === CUSTODY_REASON.CONTRACT_WRAP_CREATE ||
      reason === CUSTODY_REASON.LP_STORE_REQUIRED_REFUND ||
      reason === CUSTODY_REASON.LP_STORE_REWARD_GRANT ||
      reason === CUSTODY_REASON.RESEARCH_DATACORE_GRANT ||
      reason === CUSTODY_REASON.REPROCESSING_OUTPUT_GRANT ||
      reason === CUSTODY_REASON.MISSION_REWARD_GRANT ||
      reason === CUSTODY_REASON.NODEGRAPH_REWARD_GRANT ||
      reason === CUSTODY_REASON.CAMPAIGN_REWARD_GRANT ||
      reason === CUSTODY_REASON.AIR_MINING_GRANT ||
      reason === CUSTODY_REASON.PLANET_CUSTOMS_EXPORT_GRANT ||
      reason === CUSTODY_REASON.NPC_SENTRY_AMMO_DROP
    ) {
      return route === "local-mint";
    }
    if (
      reason === CUSTODY_REASON.CONTRACT_WRAP_REMOVE ||
      reason === CUSTODY_REASON.AIR_TUTORIAL_CONSUME ||
      reason === CUSTODY_REASON.DEATH_ITEM_DESTROY
    ) {
      return route === "local-remove";
    }
    return true;
  }

  function normalizeLocalInventoryTransferCommand(rawCommand, sequence, route) {
    // The request owns this opaque capability. Never clone or serialize it into
    // receipt metadata; only ordinary broker moves may enlist in its commit.
    const { inventoryMoveBatch, ...serializableCommand } = rawCommand || {};
    const command = cloneValue(serializableCommand);
    if (![
      "local-space-mint",
      "local-mint",
      "local-move",
      "local-remove",
    ].includes(route)) {
      return {
        success: false,
        result: buildResultError("ITEM_CUSTODY_ROUTE_NOT_SUPPORTED", { sequence }),
      };
    }
    const itemSpecs = Array.isArray(command.items) ? command.items : [command.items];
    const itemSpec = itemSpecs[0];
    const source = normalizeLocationRef(command.from);
    const destination = normalizeLocationRef(command.to);
    const hasSuppliedIdempotencyKey = Boolean(
      command.idempotencyKey !== null &&
        command.idempotencyKey !== undefined &&
        String(command.idempotencyKey).trim(),
    );
    const idempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
    const reason = String(command.reason || "local-inventory-transfer");
    if (inventoryMoveBatch && (
      route !== "local-move" ||
      ![CUSTODY_REASON.INV_BROKER_MOVE, CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER].includes(reason) ||
      !itemStore.isInventoryMoveBatchOpen?.(inventoryMoveBatch)
    )) {
      return { success: false, result: buildResultError("INVENTORY_MOVE_BATCH_INVALID", { sequence }) };
    }
    const destinationPatchResult = normalizeLocalDestinationPatch(
      command.options && command.options.destinationItemPatch,
    );
    if (
      itemSpecs.length !== 1 ||
      !itemSpec ||
      (hasSuppliedIdempotencyKey && !idempotencyKey) ||
      !idempotencyKey
    ) {
      return {
        success: false,
        result: buildResultError(
          !idempotencyKey ? "INVALID_IDEMPOTENCY_KEY" : "ITEM_CUSTODY_ROUTE_NOT_SUPPORTED",
          { sequence },
        ),
      };
    }
    if (!destinationPatchResult.success) {
      return {
        success: false,
        result: buildResultError(destinationPatchResult.errorMsg, {
          sequence,
          idempotencyKey,
        }),
      };
    }

    if (route === "local-space-mint" || route === "local-mint") {
      const itemType = itemSpec.itemType && typeof itemSpec.itemType === "object"
        ? cloneValue(itemSpec.itemType)
        : resolveItemByTypeID(itemSpec.typeID);
      const requestedQuantity = itemSpec.quantity === null || itemSpec.quantity === undefined
        ? 1
        : toPositiveInt(itemSpec.quantity, 0);
      const destinationMatches = route === "local-space-mint"
        ? destination &&
          destination.kind === CUSTODY_REF_KIND.IN_SPACE &&
          destination.flagID === 0 &&
          requestedQuantity === 1
        : destination && destination.kind !== CUSTODY_REF_KIND.IN_SPACE;
      if (
        !destinationMatches ||
        !destination.ownerID ||
        !destination.locationID ||
        !itemType ||
        !toPositiveInt(itemType.typeID, 0) ||
        !requestedQuantity ||
        !localReasonRouteMatches(reason, route, null, destination)
      ) {
        return {
          success: false,
          result: buildResultError("ITEM_CUSTODY_ROUTE_NOT_SUPPORTED", {
            sequence,
            idempotencyKey,
          }),
        };
      }
      return {
        success: true,
        command: {
          commandType: CUSTODY_COMMAND_TYPE.TRANSFER,
          route,
          sequence,
          source: null,
          destination,
          itemSpec: {
            itemType,
            quantity: requestedQuantity,
            options: cloneValue(itemSpec.options || {}),
          },
          actor: toPositiveInt(command.actor, 0) || null,
          reason: String(
            command.reason ||
              (route === "local-space-mint"
                ? CUSTODY_REASON.JETTISON_CONTAINER_CREATE
                : "local-inventory-mint"),
          ),
          idempotencyKey,
          durable: DURABLE_LOCAL_MOVE_REASONS.has(reason),
          receiptKey: DURABLE_LOCAL_MOVE_REASONS.has(reason)
            ? buildLocalReceiptKey(idempotencyKey)
            : null,
        },
      };
    }

    const itemID = toPositiveInt(
      itemSpec && typeof itemSpec === "object" ? itemSpec.itemID : itemSpec,
      0,
    );
    if (!source || !source.ownerID || !source.locationID || !itemID) {
      return {
        success: false,
        result: buildResultError("ITEM_CUSTODY_ROUTE_NOT_SUPPORTED", {
          sequence,
          idempotencyKey,
        }),
      };
    }
    if (
      route === "local-move" &&
      (!destination || !destination.ownerID || !destination.locationID)
    ) {
      return {
        success: false,
        result: buildResultError("INVALID_MOVE_DESTINATION", {
          sequence,
          idempotencyKey,
        }),
      };
    }
    if (!localReasonRouteMatches(reason, route, source, destination)) {
      return {
        success: false,
        result: buildResultError("ITEM_CUSTODY_ROUTE_NOT_SUPPORTED", {
          sequence,
          idempotencyKey,
        }),
      };
    }
    const suppliedQuantity = itemSpec && typeof itemSpec === "object" &&
      itemSpec.quantity !== undefined
      ? itemSpec.quantity
      : null;
    const mergeIntoItemID = toPositiveInt(
      command.options && command.options.mergeIntoItemID,
      0,
    );
    if (
      (reason === CUSTODY_REASON.INV_BROKER_MERGE && !mergeIntoItemID) ||
      (reason !== CUSTODY_REASON.INV_BROKER_MERGE && mergeIntoItemID)
    ) {
      return {
        success: false,
        result: buildResultError("ITEM_CUSTODY_ROUTE_NOT_SUPPORTED", {
          sequence,
          idempotencyKey,
        }),
      };
    }
    if (
      destinationPatchResult.patch &&
      (
        route !== "local-move" ||
        suppliedQuantity !== null ||
        !LOCAL_PATCH_MOVE_REASONS.has(reason)
      )
    ) {
      return {
        success: false,
        result: buildResultError("ITEM_CUSTODY_ROUTE_NOT_SUPPORTED", {
          sequence,
          idempotencyKey,
        }),
      };
    }
    return {
      success: true,
      command: {
        commandType: CUSTODY_COMMAND_TYPE.TRANSFER,
        route,
        sequence,
        source,
        destination: route === "local-remove"
          ? { kind: CUSTODY_REF_KIND.VOID }
          : destination,
        itemSpec: {
          itemID,
          quantity: suppliedQuantity,
        },
        options: {
          ...cloneValue(command.options || {}),
          destinationItemPatch: destinationPatchResult.patch,
          mergeIntoItemID: mergeIntoItemID || null,
        },
        actor: toPositiveInt(command.actor, 0) || null,
        reason,
        idempotencyKey,
        durable: DURABLE_LOCAL_MOVE_REASONS.has(reason),
        receiptKey: DURABLE_LOCAL_MOVE_REASONS.has(reason)
          ? buildLocalReceiptKey(idempotencyKey)
          : null,
        inventoryMoveBatch,
      },
    };
  }

  function buildLocalSuccess(command, options = {}) {
    const changes = Array.isArray(options.changes) ? options.changes : [];
    const items = Array.isArray(options.items)
      ? options.items.filter(Boolean).map((item) => cloneValue(item))
      : options.item
        ? [cloneValue(options.item)]
        : [];
    const item = options.item ? cloneValue(options.item) : items[0] || null;
    return {
      success: true,
      ambiguous: false,
      duplicate: options.duplicate === true,
      durable: options.durable === true,
      pending: options.pending === true,
      data: {
        commandType: command.commandType,
        route: command.route,
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey || null,
        quantity: toPositiveInt(options.quantity, 0) || null,
        item,
        items,
        sourceChanges: changes,
        destinationChanges: changes,
        changes,
        receipt: options.receipt ? cloneValue(options.receipt) : null,
        lifecycle: {
          reserved: options.durable === true,
          committed: options.pending !== true,
          compensated: false,
        },
      },
    };
  }

  function buildLocalMutationFingerprint(command) {
    return {
      commandType: command.commandType,
      route: command.route,
      reason: command.reason,
      actor: command.actor,
      source: cloneValue(command.source),
      destination: cloneValue(command.destination),
      itemSpec: cloneValue(command.itemSpec),
      destinationItemPatch: cloneValue(
        command.options && command.options.destinationItemPatch,
      ),
    };
  }

  function executeLocalInventoryTransfer(command) {
    if (command.route === "local-mint") {
      const grantOptions = command.durable === true
        ? {
            ...command.itemSpec.options,
            receiptKey: command.receiptKey,
            fingerprint: buildLocalMutationFingerprint(command),
            receiptMetadata: {
              itemCustody: {
                commandType: command.commandType,
                idempotencyKey: command.idempotencyKey,
                reason: command.reason,
                sequence: command.sequence,
              },
            },
          }
        : command.itemSpec.options;
      const grantResult = command.durable === true
        ? itemStore.grantItemToOwnerLocationIdempotent(
            command.destination.ownerID,
            command.destination.locationID,
            command.destination.flagID,
            command.itemSpec.itemType,
            command.itemSpec.quantity,
            grantOptions,
          )
        : itemStore.grantItemToOwnerLocation(
            command.destination.ownerID,
            command.destination.locationID,
            command.destination.flagID,
            command.itemSpec.itemType,
            command.itemSpec.quantity,
            grantOptions,
          );
      if (!grantResult || grantResult.success !== true) {
        return buildResultError(
          grantResult && grantResult.errorMsg || "ITEM_CUSTODY_MINT_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
          },
        );
      }
      return buildLocalSuccess(command, {
        items: grantResult.data && grantResult.data.items || [],
        quantity: grantResult.data && grantResult.data.quantity,
        changes: grantResult.data && grantResult.data.changes || [],
        duplicate: grantResult.duplicate === true,
        durable: grantResult.durable === true,
        receipt: grantResult.receipt || null,
      });
    }

    if (command.route === "local-space-mint") {
      if (command.durable === true) {
        const result = itemStore.createSpaceItemForOwnerIdempotent(
          command.destination.ownerID, command.destination.locationID,
          command.itemSpec.itemType, { ...command.itemSpec.options,
            receiptKey: command.receiptKey,
            fingerprint: buildLocalMutationFingerprint(command),
            receiptMetadata: { itemCustody: { commandType: command.commandType,
              idempotencyKey: command.idempotencyKey, reason: command.reason,
              sequence: command.sequence } } },
        );
        if (!result || !result.success) return buildResultError(
          result && result.errorMsg || "ITEM_CUSTODY_SPACE_CREATE_FAILED",
          { sequence: command.sequence, idempotencyKey: command.idempotencyKey,
            receiptKey: command.receiptKey, ambiguous: result && result.ambiguous === true, reserved: true },
        );
        return buildLocalSuccess(command, { item: result.data.items[0] || null,
          items: result.data.items || [], quantity: 1, changes: result.data.changes || [],
          duplicate: result.duplicate === true, durable: true, receipt: result.receipt });
      }
      const createResult = itemStore.createSpaceItemForOwner(
        command.destination.ownerID,
        command.destination.locationID,
        command.itemSpec.itemType,
        command.itemSpec.options,
      );
      if (!createResult || createResult.success !== true || !createResult.data) {
        return buildResultError(
          createResult && createResult.errorMsg || "ITEM_CUSTODY_SPACE_CREATE_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
          },
        );
      }
      return buildLocalSuccess(command, {
        item: createResult.data,
        quantity: 1,
        changes: createResult.changes || [],
      });
    }

    if (command.route === "local-move" && command.durable === true) {
      const receiptResult = itemStore.getIdempotentGrantReceipt(
        command.receiptKey,
        { requireDurable: true, inventoryMoveBatch: command.inventoryMoveBatch },
      );
      if (receiptResult.success && receiptResult.found) {
        const ownerChanges =
          command.destination.ownerID !== command.source.ownerID;
        const idempotentOptions = {
          receiptKey: command.receiptKey,
          inventoryMoveBatch: command.inventoryMoveBatch,
          fingerprint: buildLocalMutationFingerprint(command),
          receiptMetadata: {
            itemCustody: {
              commandType: command.commandType,
              idempotencyKey: command.idempotencyKey,
              reason: command.reason,
              sequence: command.sequence,
            },
          },
        };
        const replayResult = ownerChanges
          ? itemStore.transferItemToOwnerLocationIdempotent(
              command.itemSpec.itemID,
              command.destination.ownerID,
              command.destination.locationID,
              command.destination.flagID,
              command.itemSpec.quantity,
              idempotentOptions,
            )
          : itemStore.moveItemToLocationIdempotent(
              command.itemSpec.itemID,
              command.destination.locationID,
              command.destination.flagID,
              command.itemSpec.quantity,
              idempotentOptions,
            );
        if (!replayResult || replayResult.success !== true) {
          return buildResultError(
            replayResult && replayResult.errorMsg || "ITEM_CUSTODY_MOVE_FAILED",
            {
              sequence: command.sequence,
              idempotencyKey: command.idempotencyKey,
              receiptKey: command.receiptKey,
              ambiguous: replayResult && replayResult.ambiguous === true,
              reserved: true,
            },
          );
        }
        const committedChanges = replayResult.data &&
          replayResult.data.committedChanges || [];
        const movedItem = committedChanges
          .map((change) => change && change.item)
          .filter(Boolean)
          .find((item) => (
            Number(item.ownerID) === command.destination.ownerID &&
            Number(item.locationID) === command.destination.locationID &&
            Number(item.flagID) === command.destination.flagID
          )) || null;
        return buildLocalSuccess(command, {
          item: movedItem,
          quantity: replayResult.data && replayResult.data.quantity,
          changes: replayResult.data && replayResult.data.changes || [],
          duplicate: true,
          durable: replayResult.durable === true,
          pending: replayResult.pending === true,
          receipt: replayResult.receipt || receiptResult.data,
        });
      }
      if (!receiptResult.success) {
        return buildResultError(
          receiptResult.errorMsg || "ITEM_CUSTODY_RECEIPT_LOOKUP_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
            receiptKey: command.receiptKey,
            ambiguous: receiptResult.ambiguous === true,
            reserved: true,
          },
        );
      }
    }

    if (command.route === "local-remove" && command.durable === true) {
      if (command.reason === CUSTODY_REASON.ESS_KEY_CONSUME ||
          command.reason === CUSTODY_REASON.CHARACTER_RESCULPT_CONSUME ||
          command.reason === CUSTODY_REASON.INDUSTRY_BLUEPRINT_CONSUME ||
          command.reason === CUSTODY_REASON.SKIN_COMPONENT_CONSUME ||
          command.reason === CUSTODY_REASON.SKIN_BINDER_CONSUME) {
        const receiptResult = itemStore.getIdempotentGrantReceipt(
          command.receiptKey,
          { requireDurable: true },
        );
        if (!receiptResult || receiptResult.success !== true) {
          return buildResultError(
            receiptResult && receiptResult.errorMsg ||
              "ITEM_CUSTODY_RECEIPT_LOOKUP_FAILED",
            {
              sequence: command.sequence,
              idempotencyKey: command.idempotencyKey,
              receiptKey: command.receiptKey,
              ambiguous: receiptResult && receiptResult.ambiguous === true,
              reserved: true,
            },
          );
        }
        if (!receiptResult.found) {
          const currentItem = itemStore.findItemById(command.itemSpec.itemID);
          if (!currentItem) {
            return buildResultError("ITEM_NOT_FOUND", {
              sequence: command.sequence,
              idempotencyKey: command.idempotencyKey,
              receiptKey: command.receiptKey,
            });
          }
          if (
            Number(currentItem.ownerID) !== command.source.ownerID ||
            Number(currentItem.locationID) !== command.source.locationID ||
            Number(currentItem.flagID) !== command.source.flagID
          ) {
            return buildResultError("ITEM_CUSTODY_SOURCE_MISMATCH", {
              sequence: command.sequence,
              idempotencyKey: command.idempotencyKey,
              receiptKey: command.receiptKey,
            });
          }
        }
      }
      const removeResult = itemStore.consumeInventoryItemQuantityIdempotent(
        command.itemSpec.itemID,
        command.itemSpec.quantity,
        {
          ...command.options,
          receiptKey: command.receiptKey,
          fingerprint: buildLocalMutationFingerprint(command),
          receiptMetadata: {
            itemCustody: {
              commandType: command.commandType,
              idempotencyKey: command.idempotencyKey,
              reason: command.reason,
              sequence: command.sequence,
            },
          },
        },
      );
      if (!removeResult || removeResult.success !== true) {
        return buildResultError(
          removeResult && removeResult.errorMsg || "ITEM_CUSTODY_REMOVE_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
            receiptKey: command.receiptKey,
            ambiguous: removeResult && removeResult.ambiguous === true,
            reserved: true,
          },
        );
      }
      return buildLocalSuccess(command, {
        quantity: removeResult.data && removeResult.data.quantity,
        changes: removeResult.data && removeResult.data.changes || [],
        duplicate: removeResult.duplicate === true,
        durable: true,
        receipt: removeResult.receipt || null,
      });
    }

    const currentItem = itemStore.findItemById(command.itemSpec.itemID);
    if (!currentItem) {
      return buildResultError("ITEM_NOT_FOUND", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (
      Number(currentItem.ownerID) !== command.source.ownerID ||
      Number(currentItem.locationID) !== command.source.locationID ||
      Number(currentItem.flagID) !== command.source.flagID
    ) {
      return buildResultError("ITEM_CUSTODY_SOURCE_MISMATCH", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (
      DRONE_CUSTODY_REASONS.has(command.reason) &&
      Number(currentItem.categoryID) !== DRONE_CATEGORY_ID
    ) {
      return buildResultError("ITEM_CUSTODY_ITEM_KIND_MISMATCH", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (
      FIGHTER_CUSTODY_REASONS.has(command.reason) &&
      Number(currentItem.categoryID) !== FIGHTER_CATEGORY_ID
    ) {
      return buildResultError("ITEM_CUSTODY_ITEM_KIND_MISMATCH", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (
      command.reason === CUSTODY_REASON.SKYHOOK_DEPLOY && Number(currentItem.typeID) !== 81080
    ) {
      return buildResultError("ITEM_CUSTODY_ITEM_KIND_MISMATCH", {
        sequence: command.sequence, idempotencyKey: command.idempotencyKey,
      });
    }
    if (
      (
        command.reason === CUSTODY_REASON.MOBILE_DEPLOY ||
        command.reason === CUSTODY_REASON.SKYHOOK_DEPLOY ||
        command.reason === CUSTODY_REASON.MOBILE_SCOOP
      ) &&
      !isMobileDeployItem(currentItem)
    ) {
      return buildResultError("ITEM_CUSTODY_ITEM_KIND_MISMATCH", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
      });
    }

    if (command.route === "local-remove") {
      // Destruction of an in-space POS storage array includes guest-owned ships
      // in its actual containment tree. This is loss, not an ownership grant;
      // ordinary container removal and all owner-changing routes stay strict.
      const destroyingStarbase = command.reason === CUSTODY_REASON.SPACE_ENTITY_DESTROY &&
        Number(currentItem.categoryID) === 23 && Number(currentItem.groupID) !== 411 &&
        Number(currentItem.flagID) === 0 && currentItem.spaceState &&
        Number(currentItem.locationID) === Number(currentItem.spaceState.systemID) &&
        currentItem.spaceState.starbaseModuleState?.destruction?.version === 1;
      if (command.options.removeContents !== false) {
        const pendingContainerIDs = [command.itemSpec.itemID];
        const inspectedContainerIDs = new Set();
        while (pendingContainerIDs.length > 0) {
          const containerID = pendingContainerIDs.pop();
          if (inspectedContainerIDs.has(containerID)) {
            continue;
          }
          inspectedContainerIDs.add(containerID);
          const contents = itemStore.listContainerItems(null, containerID, null);
          for (const child of contents) {
            if (Number(child.ownerID) !== command.source.ownerID && !destroyingStarbase) {
              return buildResultError(
                "ITEM_CUSTODY_OWNER_CHANGE_NOT_SUPPORTED",
                {
                  sequence: command.sequence,
                  idempotencyKey: command.idempotencyKey,
                },
              );
            }
            pendingContainerIDs.push(Number(child.itemID));
          }
        }
      }
      const removeResult = itemStore.consumeInventoryItemQuantity(
        command.itemSpec.itemID,
        command.itemSpec.quantity,
        { removeContents: command.options.removeContents !== false },
      );
      if (!removeResult || removeResult.success !== true) {
        return buildResultError(
          removeResult && removeResult.errorMsg || "ITEM_CUSTODY_REMOVE_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
          },
        );
      }
      return buildLocalSuccess(command, {
        quantity: removeResult.data && removeResult.data.quantity,
        changes: removeResult.data && removeResult.data.changes || [],
      });
    }

    if (command.reason === CUSTODY_REASON.INV_BROKER_MERGE) {
      const destinationItem = itemStore.findItemById(
        command.options.mergeIntoItemID,
      );
      if (
        !destinationItem ||
        Number(destinationItem.itemID) === command.itemSpec.itemID ||
        Number(destinationItem.ownerID) !== command.destination.ownerID ||
        Number(destinationItem.locationID) !== command.destination.locationID ||
        Number(destinationItem.flagID) !== command.destination.flagID
      ) {
        return buildResultError("ITEM_CUSTODY_DESTINATION_MISMATCH", {
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
        });
      }
      const mergeResult = itemStore.mergeItemStacks(
        command.itemSpec.itemID,
        command.options.mergeIntoItemID,
        command.itemSpec.quantity,
      );
      if (!mergeResult || mergeResult.success !== true) {
        return buildResultError(
          mergeResult && mergeResult.errorMsg || "ITEM_CUSTODY_MERGE_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
          },
        );
      }
      const destinationAfter = itemStore.findItemById(
        command.options.mergeIntoItemID,
      );
      return buildLocalSuccess(command, {
        item: destinationAfter,
        quantity: mergeResult.data && mergeResult.data.quantity,
        changes: mergeResult.data && mergeResult.data.changes || [],
      });
    }

    const ownerChanges = command.destination.ownerID !== command.source.ownerID;
    if (ownerChanges && !LOCAL_OWNER_CHANGE_REASONS.has(command.reason)) {
      return buildResultError("ITEM_CUSTODY_OWNER_CHANGE_NOT_SUPPORTED", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
      });
    }
    if (command.options.destinationItemPatch) {
      const updateResult = itemStore.updateInventoryItem(
        command.itemSpec.itemID,
        (item) => ({
          ...item,
          ...cloneValue(command.options.destinationItemPatch),
          ownerID: command.destination.ownerID,
          locationID: command.destination.locationID,
          flagID: command.destination.flagID,
        }),
      );
      if (!updateResult || updateResult.success !== true || !updateResult.data) {
        return buildResultError(
          updateResult && updateResult.errorMsg || "ITEM_CUSTODY_MOVE_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
          },
        );
      }
      const changes = [{
        removed: false,
        previousData: updateResult.previousData || currentItem,
        item: updateResult.data,
      }];
      return buildLocalSuccess(command, {
        item: updateResult.data,
        quantity: 1,
        changes,
      });
    }
    const idempotentOptions = command.durable === true
      ? {
          receiptKey: command.receiptKey,
          inventoryMoveBatch: command.inventoryMoveBatch,
          fingerprint: buildLocalMutationFingerprint(command),
          receiptMetadata: {
            itemCustody: {
              commandType: command.commandType,
              idempotencyKey: command.idempotencyKey,
              reason: command.reason,
              sequence: command.sequence,
            },
          },
        }
      : null;
    const reownContents = CONTENTS_FOLLOW_OWNER_REASONS.has(command.reason);
    const moveResult = ownerChanges
      ? command.durable === true
        ? itemStore.transferItemToOwnerLocationIdempotent(
            command.itemSpec.itemID,
            command.destination.ownerID,
            command.destination.locationID,
            command.destination.flagID,
            command.itemSpec.quantity,
            { ...idempotentOptions, reownContents },
          )
        : itemStore.transferItemToOwnerLocation(
            command.itemSpec.itemID,
            command.destination.ownerID,
            command.destination.locationID,
            command.destination.flagID,
            command.itemSpec.quantity,
            { reownContents },
          )
      : command.durable === true
        ? itemStore.moveItemToLocationIdempotent(
            command.itemSpec.itemID,
            command.destination.locationID,
            command.destination.flagID,
            command.itemSpec.quantity,
            idempotentOptions,
          )
        : itemStore.moveItemToLocation(
            command.itemSpec.itemID,
            command.destination.locationID,
            command.destination.flagID,
            command.itemSpec.quantity,
            { inventoryMoveBatch: command.inventoryMoveBatch },
          );
    if (!moveResult || moveResult.success !== true) {
      return buildResultError(
        moveResult && moveResult.errorMsg || "ITEM_CUSTODY_MOVE_FAILED",
        {
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
          receiptKey: command.receiptKey,
          ambiguous: moveResult && moveResult.ambiguous === true,
          reserved: command.durable === true,
        },
      );
    }
    const committedChanges = moveResult.data &&
      moveResult.data.committedChanges ||
      moveResult.data && moveResult.data.changes ||
      [];
    const movedItem = committedChanges
      .map((change) => change && change.item)
      .filter(Boolean)
      .find((item) => (
        Number(item.ownerID) === command.destination.ownerID &&
        Number(item.locationID) === command.destination.locationID &&
        Number(item.flagID) === command.destination.flagID
      )) || null;
    return buildLocalSuccess(command, {
      item: movedItem,
      quantity: moveResult.data && moveResult.data.quantity,
      changes: moveResult.data && moveResult.data.changes || [],
      duplicate: moveResult.duplicate === true,
      durable: moveResult.durable === true,
      pending: moveResult.pending === true,
      receipt: moveResult.receipt || null,
    });
  }

  // A receipt that does not describe this exact command must never be replayed,
  // but a single collapsed conjunction made every rejection read as one opaque
  // ITEM_CUSTODY_RECEIPT_MISMATCH. The clauses below are the same conjunction
  // and still refuse on any one of them; they only name which clause refused,
  // so the failure is diagnosable from one log line instead of a code audit.
  function validateReceipt(command, receipt) {
    const metadata = receiptCustodyMetadata(receipt);
    const refuse = (field, expected, actual) => ({
      success: false,
      errorMsg: `ITEM_CUSTODY_RECEIPT_MISMATCH_${field}`,
      mismatch: {
        field,
        expected: expected === undefined ? null : expected,
        actual: actual === undefined ? null : actual,
      },
    });

    if (!metadata) {
      return refuse("METADATA", "item-custody-metadata", null);
    }
    if (metadata.schemaVersion !== 1) {
      return refuse("SCHEMA_VERSION", 1, metadata.schemaVersion ?? null);
    }
    if (metadata.commandType !== CUSTODY_COMMAND_TYPE.TRANSFER) {
      return refuse(
        "COMMAND_TYPE",
        CUSTODY_COMMAND_TYPE.TRANSFER,
        metadata.commandType ?? null,
      );
    }
    if (metadata.idempotencyKey !== command.idempotencyKey) {
      return refuse(
        "IDEMPOTENCY_KEY",
        command.idempotencyKey,
        metadata.idempotencyKey ?? null,
      );
    }

    const source = metadata.source;
    if (!source) {
      return refuse("SOURCE", "present", null);
    }
    if (source.kind !== CUSTODY_REF_KIND.NATIVE_WRECK) {
      return refuse(
        "SOURCE_KIND",
        CUSTODY_REF_KIND.NATIVE_WRECK,
        source.kind ?? null,
      );
    }
    if (toPositiveInt(source.wreckID, 0) !== command.source.wreckID) {
      return refuse(
        "SOURCE_WRECK_ID",
        command.source.wreckID,
        toPositiveInt(source.wreckID, 0),
      );
    }
    if (toPositiveInt(source.wreckItemID, 0) !== command.wreckItemID) {
      return refuse(
        "SOURCE_WRECK_ITEM_ID",
        command.wreckItemID,
        toPositiveInt(source.wreckItemID, 0),
      );
    }

    const destination = metadata.destination;
    if (!destination) {
      return refuse("DESTINATION", "present", null);
    }
    if (toPositiveInt(destination.ownerID, 0) !== command.destination.ownerID) {
      return refuse(
        "DESTINATION_OWNER_ID",
        command.destination.ownerID,
        toPositiveInt(destination.ownerID, 0),
      );
    }
    if (toPositiveInt(destination.locationID, 0) !== command.destination.locationID) {
      return refuse(
        "DESTINATION_LOCATION_ID",
        command.destination.locationID,
        toPositiveInt(destination.locationID, 0),
      );
    }
    if (toFlagID(destination.flagID) !== command.destination.flagID) {
      return refuse(
        "DESTINATION_FLAG_ID",
        command.destination.flagID,
        toFlagID(destination.flagID),
      );
    }
    if (String(destination.kind || "") !== command.destination.kind) {
      return refuse(
        "DESTINATION_KIND",
        command.destination.kind,
        String(destination.kind || ""),
      );
    }

    if (!receipt) {
      return refuse("RECEIPT", "present", null);
    }
    if (toPositiveInt(receipt.ownerID, 0) !== command.destination.ownerID) {
      return refuse(
        "RECEIPT_OWNER_ID",
        command.destination.ownerID,
        toPositiveInt(receipt.ownerID, 0),
      );
    }
    if (toPositiveInt(receipt.locationID, 0) !== command.destination.locationID) {
      return refuse(
        "RECEIPT_LOCATION_ID",
        command.destination.locationID,
        toPositiveInt(receipt.locationID, 0),
      );
    }
    if (toFlagID(receipt.flagID) !== command.destination.flagID) {
      return refuse(
        "RECEIPT_FLAG_ID",
        command.destination.flagID,
        toFlagID(receipt.flagID),
      );
    }
    const fingerprintTypeID = toPositiveInt(
      source.fingerprint && source.fingerprint.typeID,
      0,
    );
    if (toPositiveInt(receipt.typeID, 0) !== fingerprintTypeID) {
      return refuse(
        "RECEIPT_TYPE_ID",
        fingerprintTypeID,
        toPositiveInt(receipt.typeID, 0),
      );
    }
    const recordedTransferQuantity = toPositiveInt(metadata.transferQuantity, 0);
    if (toPositiveInt(receipt.quantity, 0) !== recordedTransferQuantity) {
      return refuse(
        "RECEIPT_QUANTITY",
        recordedTransferQuantity,
        toPositiveInt(receipt.quantity, 0),
      );
    }
    if (String(metadata.reason || "") !== command.reason) {
      return refuse("REASON", command.reason, String(metadata.reason || ""));
    }
    if ((toPositiveInt(metadata.actor, 0) || null) !== command.actor) {
      return refuse(
        "ACTOR",
        command.actor,
        toPositiveInt(metadata.actor, 0) || null,
      );
    }
    const expectedQuantity = command.requestedQuantity;
    if (expectedQuantity && recordedTransferQuantity !== expectedQuantity) {
      return refuse(
        "REQUESTED_QUANTITY",
        expectedQuantity,
        recordedTransferQuantity,
      );
    }

    return { success: true, metadata };
  }

  function reservationMatchesCommand(reservation, command) {
    return Boolean(
      reservation &&
        reservation.schemaVersion === 1 &&
        reservation.state === "reserved" &&
        reservation.receiptKey === command.receiptKey &&
        reservation.idempotencyKey === command.idempotencyKey &&
        toPositiveInt(reservation.wreckID, 0) === command.source.wreckID &&
        toPositiveInt(reservation.wreckItemID, 0) === command.wreckItemID &&
        String(reservation.reason || "") === command.reason &&
        (toPositiveInt(reservation.actor, 0) || null) === command.actor &&
        toPositiveInt(reservation.destination && reservation.destination.ownerID, 0) ===
          command.destination.ownerID &&
        toPositiveInt(reservation.destination && reservation.destination.locationID, 0) ===
          command.destination.locationID &&
        Math.max(
          0,
          Math.trunc(Number(reservation.destination && reservation.destination.flagID) || 0),
        ) === command.destination.flagID &&
        String(reservation.destination && reservation.destination.kind || "") ===
          command.destination.kind &&
        toPositiveInt(reservation.transferQuantity, 0) === command.transferQuantity
    );
  }

  function writeReservedSource(sourceRecord, reservation) {
    const writeResult = nativeNpcStore.upsertNativeWreckItem(
      {
        ...sourceRecord,
        custodyReservation: cloneValue(reservation),
      },
      { transient: sourceRecord.transient === true },
    );
    if (!writeResult || writeResult.success !== true) {
      return {
        success: false,
        errorMsg: writeResult && writeResult.errorMsg ||
          "ITEM_CUSTODY_RESERVATION_WRITE_FAILED",
      };
    }
    const flushResult = flushSourceBoundary(sourceRecord.transient === true);
    if (!flushResult.success) {
      return flushResult;
    }
    return {
      success: true,
      durable: sourceRecord.transient !== true && flushResult.durable === true,
      sourceRecord: nativeNpcStore.getNativeWreckItem(sourceRecord.wreckItemID),
    };
  }

  function compensateReservation(command) {
    const current = nativeNpcStore.getNativeWreckItem(command.wreckItemID);
    if (!current) {
      const flushResult = flushSourceBoundary(false);
      return flushResult.success
        ? { success: true, compensated: true }
        : flushResult;
    }
    if (!current.custodyReservation) {
      return { success: true, compensated: false };
    }
    if (!reservationMatchesCommand(current.custodyReservation, command)) {
      return {
        success: false,
        errorMsg: "ITEM_CUSTODY_SOURCE_RESERVATION_CHANGED",
      };
    }
    const restored = { ...current };
    delete restored.custodyReservation;
    const writeResult = nativeNpcStore.upsertNativeWreckItem(
      restored,
      { transient: restored.transient === true },
    );
    if (!writeResult || writeResult.success !== true) {
      return {
        success: false,
        errorMsg: writeResult && writeResult.errorMsg ||
          "ITEM_CUSTODY_COMPENSATION_WRITE_FAILED",
      };
    }
    const flushResult = flushSourceBoundary(restored.transient === true);
    return flushResult.success
      ? { success: true, compensated: true }
      : flushResult;
  }

  function commitSourceRecord(command, sourceRecord, sourceMetadata) {
    if (!sourceRecord) {
      const flushResult = flushSourceBoundary(
        sourceMetadata && sourceMetadata.transient === true,
      );
      return flushResult.success
        ? { success: true, sourceChanges: [], alreadyCommitted: true }
        : flushResult;
    }

    const expectedFingerprint = sourceMetadata && sourceMetadata.fingerprint;
    if (!sameSourceFingerprint(sourceFingerprint(sourceRecord), expectedFingerprint)) {
      return { success: false, errorMsg: "ITEM_CUSTODY_SOURCE_DIVERGED" };
    }

    const originalQuantity = toPositiveInt(sourceMetadata.sourceAvailableQuantity, 0);
    const transferQuantity = toPositiveInt(sourceMetadata.transferQuantity, 0);
    const remainingQuantity = originalQuantity - transferQuantity;
    const currentQuantity = sourceAvailableQuantity(sourceRecord);
    const originalRevision = Math.max(
      0,
      Math.trunc(Number(sourceMetadata.sourceRevision) || 0),
    );
    const currentRevision = Math.max(
      0,
      Math.trunc(Number(sourceRecord.custodyRevision) || 0),
    );
    const reservation = sourceRecord.custodyReservation;

    if (!reservation) {
      if (
        remainingQuantity > 0 &&
        currentQuantity <= remainingQuantity &&
        currentRevision >= originalRevision + 1
      ) {
        const flushResult = flushSourceBoundary(sourceRecord.transient === true);
        return flushResult.success
          ? { success: true, sourceChanges: [], alreadyCommitted: true }
          : flushResult;
      }
      if (currentQuantity !== originalQuantity || currentRevision !== originalRevision) {
        return { success: false, errorMsg: "ITEM_CUSTODY_SOURCE_DIVERGED" };
      }
    } else if (!reservationMatchesCommand(reservation, command)) {
      return { success: false, errorMsg: "ITEM_CUSTODY_SOURCE_RESERVED" };
    } else if (
      currentQuantity !== originalQuantity ||
      currentRevision !== originalRevision
    ) {
      return { success: false, errorMsg: "ITEM_CUSTODY_SOURCE_DIVERGED" };
    }

    const previousData = buildNativeWreckItemLikeRow(sourceRecord, itemStore.ITEM_FLAGS);
    let writeResult;
    let sourceChange;
    if (remainingQuantity <= 0 || isSingletonRecord(sourceRecord)) {
      writeResult = nativeNpcStore.removeNativeWreckItem(command.wreckItemID);
      sourceChange = {
        removed: true,
        previousData,
        // Inventory notifications encode a deletion as a move to the junk
        // location.  A null item is only useful to persistence consumers: every
        // client encoder drops it, which left a looted native-wreck row visible
        // until the window was reopened.  Use the same tombstone shape ordinary
        // itemStore removals publish so both Add and MultiAdd can retire it live.
        item: itemStore.buildRemovedItemNotificationState(previousData),
      };
    } else {
      const updatedRecord = {
        ...sourceRecord,
        quantity: remainingQuantity,
        custodyRevision: originalRevision + 1,
      };
      delete updatedRecord.custodyReservation;
      writeResult = nativeNpcStore.upsertNativeWreckItem(
        updatedRecord,
        { transient: updatedRecord.transient === true },
      );
      sourceChange = {
        removed: false,
        previousData,
        item: buildNativeWreckItemLikeRow(updatedRecord, itemStore.ITEM_FLAGS),
      };
    }
    if (!writeResult || writeResult.success !== true) {
      return {
        success: false,
        errorMsg: writeResult && writeResult.errorMsg ||
          "ITEM_CUSTODY_SOURCE_COMMIT_FAILED",
      };
    }
    const flushResult = flushSourceBoundary(sourceRecord.transient === true);
    if (!flushResult.success) {
      return flushResult;
    }
    return {
      success: true,
      sourceChanges: [sourceChange],
      alreadyCommitted: false,
    };
  }

  function finishFromReceipt(command, receipt) {
    const receiptValidation = validateReceipt(command, receipt);
    if (!receiptValidation.success) {
      return buildResultError(receiptValidation.errorMsg, {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        mismatch: receiptValidation.mismatch,
        ambiguous: true,
        reserved: Boolean(
          nativeNpcStore.getNativeWreckItem(command.wreckItemID) &&
            nativeNpcStore.getNativeWreckItem(command.wreckItemID).custodyReservation,
        ),
      });
    }
    command.transferQuantity = toPositiveInt(
      receiptValidation.metadata.transferQuantity,
      0,
    );
    const durableReceiptResult = itemStore.getIdempotentGrantReceipt(
      command.receiptKey,
      { requireDurable: true },
    );
    if (!durableReceiptResult || durableReceiptResult.success !== true) {
      return buildResultError(
        durableReceiptResult && durableReceiptResult.errorMsg ||
          "ITEM_CUSTODY_RECEIPT_DURABILITY_FAILED",
        {
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
          receiptKey: command.receiptKey,
          ambiguous: true,
          reserved: true,
        },
      );
    }
    const currentSource = nativeNpcStore.getNativeWreckItem(command.wreckItemID);
    const copyStateResult = ensureNativeWreckBlueprintState(
      durableReceiptResult.data,
      currentSource,
    );
    if (!copyStateResult.success) {
      return buildResultError(copyStateResult.errorMsg, {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        ambiguous: true,
        reserved: Boolean(currentSource && currentSource.custodyReservation),
      });
    }
    const commitResult = commitSourceRecord(
      command,
      currentSource,
      receiptValidation.metadata.source,
    );
    if (!commitResult.success) {
      return buildResultError(commitResult.errorMsg, {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        ambiguous: true,
        reserved: Boolean(currentSource && currentSource.custodyReservation),
      });
    }
    const sourceChanges = commitResult.sourceChanges || [];
    return {
      success: true,
      ambiguous: false,
      duplicate: true,
      durable: true,
      data: {
        commandType: command.commandType,
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        quantity: toPositiveInt(
          receiptValidation.metadata.transferQuantity,
          toPositiveInt(receipt.quantity, 0),
        ),
        sourceChanges,
        destinationChanges: [],
        changes: sourceChanges,
        receipt: cloneValue(durableReceiptResult.data),
        lifecycle: {
          reserved: true,
          committed: true,
          compensated: false,
        },
      },
    };
  }

  function ensureNativeWreckBlueprintState(receipt, sourceRecord) {
    const source = receiptCustodyMetadata(receipt)?.source;
    if (!source?.blueprintState) return { success: true };
    const itemIDs = receipt && receipt.resultData && receipt.resultData.itemIDs || [];
    const copies = itemIDs.map((itemID) => itemStore.findItemById(itemID)).filter(Boolean);
    // A completed transfer may be replayed after its copy was used or removed.
    // Its receipt proves the transfer; it must never recreate the spent item.
    if (!sourceRecord && copies.length === 0) return { success: true };
    if (copies.length !== itemIDs.length || copies.length !== 1) {
      return { success: false, errorMsg: "BLUEPRINT_COPY_INSTANCE_MISSING" };
    }
    return require("./blueprintRewardState").ensureGrantedBlueprintCopyState(
      copies,
      source.blueprintState,
    );
  }

  function executeNativeWreckTransfer(command) {
    pruneDeadTransientWreckReceipts();
    let sourceRecord = nativeNpcStore.getNativeWreckItem(command.wreckItemID);
    if (sourceRecord && toPositiveInt(sourceRecord.wreckID, 0) !== command.source.wreckID) {
      return buildResultError("ITEM_NOT_FOUND", { sequence: command.sequence });
    }
    if (sourceRecord && !nativeNpcStore.getNativeWreck(command.source.wreckID)) {
      return buildResultError("ITEM_NOT_FOUND", { sequence: command.sequence });
    }

    // A whole-stack transfer retires its source, so a replay arrives with the
    // transient flag that scoped the original key no longer readable anywhere.
    // Probe this process's key before the boot-independent one a durable wreck
    // would have written, so either kind of source still replays its own
    // receipt instead of granting the loot a second time.
    const candidateIdempotencyKeys = command.suppliedIdempotencyKey
      ? [command.suppliedIdempotencyKey]
      : sourceRecord
        ? [buildDefaultNativeWreckIdempotencyKey(
            sourceRecord,
            command.requestedQuantity,
            bootInstanceID,
          )]
        : [
            buildMissingSourceDefaultIdempotencyKey(command.wreckItemID, bootInstanceID),
            buildMissingSourceDefaultIdempotencyKey(command.wreckItemID),
          ];

    let receiptResult = null;
    for (const candidateKey of candidateIdempotencyKeys) {
      const candidateReceiptKey = buildReceiptKey(candidateKey);
      if (!candidateKey || !candidateReceiptKey) {
        return buildResultError("INVALID_IDEMPOTENCY_KEY", {
          sequence: command.sequence,
        });
      }
      command.idempotencyKey = candidateKey;
      command.receiptKey = candidateReceiptKey;
      receiptResult = itemStore.getIdempotentGrantReceipt(
        candidateReceiptKey,
        { requireDurable: false },
      );
      if (!receiptResult || receiptResult.success !== true) {
        return buildResultError(
          receiptResult && receiptResult.errorMsg || "ITEM_CUSTODY_RECEIPT_READ_FAILED",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
            receiptKey: command.receiptKey,
            ambiguous: receiptResult && receiptResult.ambiguous === true,
            reserved: Boolean(sourceRecord && sourceRecord.custodyReservation),
          },
        );
      }
      if (receiptResult.found) {
        break;
      }
    }
    if (receiptResult.found) {
      return finishFromReceipt(command, receiptResult.data);
    }
    if (!sourceRecord) {
      return buildResultError("ITEM_NOT_FOUND", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
      });
    }

    const availableQuantity = sourceAvailableQuantity(sourceRecord);
    const transferQuantity = command.requestedQuantity === null
      ? availableQuantity
      : command.requestedQuantity;
    if (transferQuantity > availableQuantity) {
      return buildResultError("INSUFFICIENT_ITEMS", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
      });
    }
    command.transferQuantity = transferQuantity;

    let blueprintState = null;
    if (nativeWreckSingleton(sourceRecord) === 2) {
      try {
        blueprintState = require("./blueprintRewardState").resolveBlueprintLootCopyState(
          {
            ...(resolveItemByTypeID(sourceRecord.typeID) || {}),
            typeID: sourceRecord.typeID,
            name: sourceRecord.itemName,
            categoryID: 9,
          },
          sourceRecord.blueprintState || sourceRecord,
          { kind: "native-wreck", seed: `native-wreck-blueprint:${sourceRecord.wreckID}:${sourceRecord.wreckItemID}:${sourceRecord.transient ? bootInstanceID : "durable"}` },
        );
      } catch (error) {
        return buildResultError(error.code || "INVALID_BLUEPRINT_RUNS", {
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
          receiptKey: command.receiptKey,
        });
      }
    }

    let reservation = sourceRecord.custodyReservation;
    if (reservation) {
      if (!reservationMatchesCommand(reservation, command)) {
        return buildResultError("ITEM_CUSTODY_SOURCE_RESERVED", {
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
          receiptKey: command.receiptKey,
          reserved: true,
        });
      }
    } else {
      reservation = {
        schemaVersion: 1,
        state: "reserved",
        commandType: command.commandType,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        wreckID: command.source.wreckID,
        wreckItemID: command.wreckItemID,
        transferQuantity,
        sourceAvailableQuantity: availableQuantity,
        sourceRevision: Math.max(
          0,
          Math.trunc(Number(sourceRecord.custodyRevision) || 0),
        ),
        fingerprint: sourceFingerprint(sourceRecord),
        destination: cloneValue(command.destination),
        actor: command.actor,
        reason: command.reason,
        reservedAtMs: nowMs(),
        durable: sourceRecord.transient !== true,
      };
      const reserveResult = writeReservedSource(sourceRecord, reservation);
      if (!reserveResult.success) {
        command.transferQuantity = transferQuantity;
        const compensationResult = compensateReservation(command);
        return buildResultError(reserveResult.errorMsg, {
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
          receiptKey: command.receiptKey,
          ambiguous: !compensationResult.success,
          reserved: !compensationResult.success,
          compensated: compensationResult.compensated === true,
        });
      }
      sourceRecord = reserveResult.sourceRecord || sourceRecord;
    }

    invokeLifecycleHook("after-reserve", { command, reservation });

    const itemType = resolveItemByTypeID(sourceRecord.typeID) || {
      typeID: sourceRecord.typeID,
      name: sourceRecord.itemName,
    };
    const receiptMetadata = {
      itemCustody: {
        schemaVersion: 1,
        commandType: command.commandType,
        idempotencyKey: command.idempotencyKey,
        reason: command.reason,
        actor: command.actor,
        source: {
          kind: CUSTODY_REF_KIND.NATIVE_WRECK,
          wreckID: command.source.wreckID,
          wreckItemID: command.wreckItemID,
          sourceAvailableQuantity: reservation.sourceAvailableQuantity,
          transferQuantity: reservation.transferQuantity,
          sourceRevision: reservation.sourceRevision,
          transient: sourceRecord.transient === true,
          bootInstanceID,
          fingerprint: cloneValue(reservation.fingerprint),
          ...(blueprintState
            ? { blueprintState: cloneValue(blueprintState) }
            : {}),
        },
        destination: cloneValue(command.destination),
        transferQuantity,
      },
    };
    const grantResult = itemStore.grantItemToOwnerLocationIdempotent(
      command.destination.ownerID,
      command.destination.locationID,
      command.destination.flagID,
      itemType,
      transferQuantity,
      {
        singleton: nativeWreckSingleton(sourceRecord),
        moduleState: sourceRecord.moduleState
          ? cloneValue(sourceRecord.moduleState)
          : undefined,
        receiptKey: command.receiptKey,
        receiptMetadata,
      },
    );
    if (!grantResult || grantResult.success !== true) {
      if (grantResult && grantResult.ambiguous === true) {
        return buildResultError(
          grantResult.errorMsg || "ITEM_CUSTODY_GRANT_AMBIGUOUS",
          {
            sequence: command.sequence,
            idempotencyKey: command.idempotencyKey,
            receiptKey: command.receiptKey,
            ambiguous: true,
            reserved: true,
          },
        );
      }
      const compensationResult = compensateReservation(command);
      return buildResultError(
        grantResult && grantResult.errorMsg || "ITEM_CUSTODY_GRANT_FAILED",
        {
          sequence: command.sequence,
          idempotencyKey: command.idempotencyKey,
          receiptKey: command.receiptKey,
          ambiguous: !compensationResult.success,
          reserved: !compensationResult.success,
          compensated: compensationResult.compensated === true,
        },
      );
    }

    const committedReceiptMetadata = receiptCustodyMetadata(grantResult.receipt);
    if (grantResult.durable !== true || !committedReceiptMetadata) {
      return buildResultError("ITEM_CUSTODY_GRANT_RECEIPT_INVALID", {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        ambiguous: true,
        reserved: true,
      });
    }

    invokeLifecycleHook("after-grant", {
      command,
      reservation,
      receipt: grantResult.receipt,
    });

    const currentSource = nativeNpcStore.getNativeWreckItem(command.wreckItemID);
    const copyStateResult = ensureNativeWreckBlueprintState(grantResult.receipt, currentSource);
    if (!copyStateResult.success) {
      return buildResultError(copyStateResult.errorMsg, {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        ambiguous: true,
        reserved: true,
      });
    }
    const sourceMetadata = committedReceiptMetadata.source;
    const commitResult = commitSourceRecord(command, currentSource, sourceMetadata);
    if (!commitResult.success) {
      return buildResultError(commitResult.errorMsg, {
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        ambiguous: true,
        reserved: true,
      });
    }

    invokeLifecycleHook("after-commit", {
      command,
      reservation,
      receipt: grantResult.receipt,
    });

    const sourceChanges = commitResult.sourceChanges || [];
    const destinationChanges = grantResult.data && grantResult.data.changes || [];
    return {
      success: true,
      ambiguous: false,
      duplicate: grantResult.duplicate === true,
      durable: grantResult.durable === true,
      data: {
        commandType: command.commandType,
        sequence: command.sequence,
        idempotencyKey: command.idempotencyKey,
        receiptKey: command.receiptKey,
        quantity: transferQuantity,
        sourceChanges,
        destinationChanges,
        changes: [...sourceChanges, ...destinationChanges],
        receipt: cloneValue(grantResult.receipt),
        lifecycle: {
          reserved: true,
          committed: true,
          compensated: false,
        },
      },
    };
  }

  function transfer(rawCommand = {}) {
    if (activeCommand) {
      stats.rejectedReentrant += 1;
      return buildResultError("ITEM_CUSTODY_REENTRANT_COMMAND", {
        sequence: nextSequence,
        ambiguous: false,
      });
    }

    const sequence = nextSequence;
    nextSequence += 1;
    stats.submitted += 1;
    const route = classifyTransferRoute(rawCommand);
    const normalized = route === "native-wreck"
      ? normalizeNativeWreckTransferCommand(rawCommand, sequence)
      : normalizeLocalInventoryTransferCommand(rawCommand, sequence, route);
    if (!normalized.success) {
      stats.completed += 1;
      return normalized.result;
    }
    activeCommand = normalized.command;
    try {
      const command = normalized.command;
      const airDeathBlocked = itemStore === defaultItemStore &&
        ![CUSTODY_REASON.DEATH_LOOT_DROP, CUSTODY_REASON.DEATH_ITEM_DESTROY].includes(command.reason) &&
        (require("../ship/airDeathRestrictions").mutationBlocked(command.source?.ownerID || command.destination?.ownerID,
          command.itemSpec?.itemID, command.destination?.locationID) ||
          command.destination?.ownerID !== command.source?.ownerID &&
          require("../ship/airDeathRestrictions").mutationBlocked(command.destination?.ownerID, null, command.destination?.locationID));
      const result = airDeathBlocked
        ? buildResultError("SHIP_DESTRUCTION_IN_PROGRESS", { sequence })
        : route === "native-wreck"
        ? executeNativeWreckTransfer(normalized.command)
        : executeLocalInventoryTransfer(normalized.command);
      stats.completed += 1;
      if (!result.success) {
        stats.failed += 1;
      }
      if (result.ambiguous === true) {
        stats.ambiguous += 1;
      }
      if (result.duplicate === true) {
        stats.duplicate += 1;
      }
      if (result.data && result.data.lifecycle && result.data.lifecycle.compensated) {
        stats.compensated += 1;
      }
      return result;
    } catch (error) {
      stats.failed += 1;
      throw error;
    } finally {
      activeCommand = null;
    }
  }

  function getStats() {
    return {
      ...stats,
      nextSequence,
      active: activeCommand
        ? {
            commandType: activeCommand.commandType,
            sequence: activeCommand.sequence,
            idempotencyKey: activeCommand.idempotencyKey || null,
          }
        : null,
    };
  }

  function resetStatsForTests() {
    if (activeCommand) {
      throw new Error("cannot reset item custody statistics during a command");
    }
    nextSequence = 1;
    stats = createStats();
  }

  return {
    transfer,
    getStats,
    resetStatsForTests,
  };
}

const authority = createItemCustody();

/**
 * Answers "did the custody command behind this idempotency key already commit?"
 *
 * Sagas need this to resume: a step whose own bookkeeping checkpoint was lost
 * can still prove, from the durable ledger, that its later steps already ran,
 * instead of retrying a move whose items have long since left escrow.
 */
function getCommittedReceipt(idempotencyKey, options = {}) {
  const store = options.itemStore || defaultItemStore;
  const receiptKey = buildLocalReceiptKey(idempotencyKey);
  if (!receiptKey) {
    return { success: false, ambiguous: false, errorMsg: "INVALID_IDEMPOTENCY_KEY", committed: false, receipt: null, resultData: null };
  }
  const result = store.getIdempotentGrantReceipt(receiptKey, {
    requireDurable: true,
  });
  if (!result || result.success !== true || !result.found || !result.data) {
    return {
      success: Boolean(result && result.success === true),
      ambiguous: Boolean(result && result.ambiguous === true),
      errorMsg: result && result.errorMsg || null,
      committed: false,
      receipt: null,
      resultData: null,
    };
  }
  return {
    success: true,
    ambiguous: false,
    errorMsg: null,
    committed: String(result.data.state || "") === "completed",
    receipt: result.data,
    resultData: result.data.resultData && typeof result.data.resultData === "object"
      ? result.data.resultData
      : null,
  };
}

module.exports = {
  CUSTODY_COMMAND_TYPE,
  CUSTODY_REF_KIND,
  CUSTODY_REASON,
  custodyRef,
  getCommittedReceipt,
  transfer: authority.transfer,
  getItemCustodyStats: authority.getStats,
  _createItemCustodyForTests: createItemCustody,
  _resetItemCustodyStatsForTests: authority.resetStatsForTests,
  _testing: {
    buildDefaultNativeWreckIdempotencyKey,
    buildNativeWreckItemLikeRow,
    buildReceiptKey,
  },
};
