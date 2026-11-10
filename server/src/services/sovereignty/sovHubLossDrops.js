"use strict";

// What a Sovereignty Hub drops when attackers win its command node event
// (doc/SOV_PARITY_CLEANUP_PLAN.md, decision 5). Every installed upgrade and
// every unit of fuel goes through the server's normal death drop roll, 50%
// per unit, into a Sovereignty Hub Wreck at the Hub's position. When the
// static data has no wreck type, a container takes the dropped items.
//
// The roll is seeded by the Hub and the campaign epoch, so a retry of the
// same outcome rolls the same result. sovState records the summary in the
// campaign outcome receipt, which is the idempotency fence for the outcome.

const path = require("node:path");

const log = require(path.join(__dirname, "../../utils/logger"));
const { TYPE_INFRASTRUCTURE_HUB } = require(path.join(__dirname, "./sovConstants"));

const DROP_KIND_UPGRADE = "upgrade";
const DROP_KIND_FUEL = "fuel";

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function buildHubLossDropSeed(targetID, campaignEpoch) {
  return `sov-hub-loss:${toPositiveInt(targetID)}:${String(campaignEpoch || "").trim()}`;
}

// The stacks a Hub holds: one unit per installed upgrade, the fuel ledger's
// amounts per fuel type.
function listHubStacks(hubRecord) {
  const stacks = [];
  const seenUpgradeTypeIDs = new Set();
  for (const installation of Array.isArray(hubRecord && hubRecord.installedUpgrades)
    ? hubRecord.installedUpgrades
    : []) {
    const typeID = toPositiveInt(installation && installation.typeID, 0);
    if (!typeID || seenUpgradeTypeIDs.has(typeID)) {
      continue;
    }
    seenUpgradeTypeIDs.add(typeID);
    stacks.push({ kind: DROP_KIND_UPGRADE, typeID, quantity: 1 });
  }
  for (const [fuelTypeID, entry] of Object.entries(
    hubRecord && hubRecord.fuelByTypeID && typeof hubRecord.fuelByTypeID === "object"
      ? hubRecord.fuelByTypeID
      : {},
  )) {
    const typeID = toPositiveInt(fuelTypeID, 0);
    const quantity = Math.max(0, Math.trunc(Number(entry && entry.amount) || 0));
    if (!typeID || quantity <= 0) {
      continue;
    }
    stacks.push({ kind: DROP_KIND_FUEL, typeID, quantity });
  }
  return stacks;
}

// Pure: which stacks drop and how much of each. Safe to call again with the
// same inputs.
function rollSovereigntyHubLossDrops({ targetID, campaignEpoch, hubRecord } = {}) {
  const { resolveStackDropCounts } = require(path.join(
    __dirname,
    "../killmail/deathOutcomeResolver",
  ));
  const seed = buildHubLossDropSeed(targetID, campaignEpoch);
  const items = listHubStacks(hubRecord).map((stack) => {
    const roll = resolveStackDropCounts(
      { itemID: stack.typeID, quantity: stack.quantity },
      seed,
    );
    return {
      kind: stack.kind,
      typeID: stack.typeID,
      quantity: stack.quantity,
      dropped: Math.max(0, Math.trunc(Number(roll && roll.qtyDropped) || 0)),
      destroyed: Math.max(0, Math.trunc(Number(roll && roll.qtyDestroyed) || 0)),
      error: null,
    };
  });
  return { seed, items };
}

function buildLootHost(structure, solarSystemID) {
  const corporationID =
    toPositiveInt(structure && structure.corporationID, 0) ||
    toPositiveInt(structure && structure.ownerID, 0);
  const position = structure && structure.position && typeof structure.position === "object"
    ? structure.position
    : { x: 0, y: 0, z: 0 };
  return {
    structureID: toPositiveInt(structure && structure.itemID, 0),
    typeID: TYPE_INFRASTRUCTURE_HUB,
    solarSystemID: toPositiveInt(solarSystemID, 0),
    name: String(structure && structure.name || "Sovereignty Hub"),
    ownerID: corporationID,
    ownerCorpID: corporationID,
    allianceID: toPositiveInt(structure && structure.allianceID, 0) || null,
    position: {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      z: Number(position.z) || 0,
    },
    rotation: [0, 0, 0],
  };
}

// Creates the wreck (or container) and puts the dropped stacks in it. Returns
// the summary sovState stores in the outcome receipt. Never throws: a failure
// is recorded on the summary and logged, because the outcome itself must
// still commit.
function dropSovereigntyHubContents({
  structure,
  solarSystemID,
  hubRecord,
  campaignEpoch,
  nowMs = Date.now(),
  dropLocationID = null,
  destructionKey = null,
} = {}) {
  const targetID = toPositiveInt(structure && structure.itemID, 0);
  const roll = rollSovereigntyHubLossDrops({ targetID, campaignEpoch, hubRecord });
  const summary = {
    seed: roll.seed,
    containerID: null,
    containerTypeID: null,
    items: roll.items,
    error: null,
  };
  const host = buildLootHost(structure, solarSystemID);
  if (!host.structureID || !host.solarSystemID || !host.ownerCorpID) {
    summary.error = "HUB_LOOT_HOST_INVALID";
    return summary;
  }
  const anythingDropped = roll.items.some((item) => item.dropped > 0);
  try {
    const structureWreckState = require(path.join(
      __dirname,
      "../structure/structureWreckState",
    ));
    const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
    let created = dropLocationID
      ? { success: true, data: itemStore.findItemById(dropLocationID) }
      : structureWreckState.createStructureWreck(host, { nowMs, destructionKey });
    if (dropLocationID && !created.data) {
      if (!destructionKey) {
        summary.error = "STRUCTURE_LOOT_DESTINATION_GONE";
        return summary;
      }
      summary.containerID = dropLocationID;
      summary.destinationGone = true;
      for (const item of summary.items) {
        if (item.dropped <= 0) continue;
        const receipt = itemStore.getIdempotentGrantReceipt(`${destructionKey}:hub:${item.kind}:${item.typeID}`);
        if (!receipt.success) { item.error = receipt.errorMsg; continue; }
        if (receipt.found) continue;
        // Already granted stacks may have been looted elsewhere. Undelivered
        // reserved units are lost with the removed destination, never reminted.
        item.lostOnMissingDestination = item.dropped;
        item.destroyed += item.dropped;
        item.dropped = 0;
      }
      return summary;
    }
    if (destructionKey && created && !created.success && created.errorMsg !== "WRECK_TYPE_NOT_FOUND") {
      summary.error = created.errorMsg || "HUB_DROP_LOCATION_FAILED";
      return summary;
    }
    if ((!created || !created.success) && anythingDropped) {
      const { createStructureLootContainer } = require(path.join(
        __dirname,
        "../structure/structureDestructionLootState",
      ));
      created = createStructureLootContainer(host, 0, {
        label: "Destroyed Sovereignty Hub Container",
        nowMs,
        destructionKey,
      });
    }
    if (!created || !created.success || !created.data) {
      if (anythingDropped) {
        summary.error = (created && created.errorMsg) || "HUB_DROP_LOCATION_FAILED";
      }
      return summary;
    }
    summary.containerID = toPositiveInt(created.data.itemID, 0);
    summary.containerTypeID = toPositiveInt(created.data.typeID, 0);

    const { resolveItemByTypeID } = require(path.join(
      __dirname,
      "../inventory/itemTypeRegistry",
    ));
    for (const item of summary.items) {
      if (item.dropped <= 0) {
        continue;
      }
      const itemType = resolveItemByTypeID(item.typeID);
      if (!itemType) {
        item.error = "TYPE_NOT_FOUND";
        continue;
      }
      const grant = destructionKey ? itemStore.grantItemToOwnerLocationIdempotent : itemStore.grantItemToOwnerLocation;
      const granted = grant(
        host.ownerCorpID,
        summary.containerID,
        0,
        itemType,
        item.dropped,
        { singleton: 0, ...(destructionKey ? { receiptKey: `${destructionKey}:hub:${item.kind}:${item.typeID}` } : {}) },
      );
      if (!granted || granted.success !== true) {
        item.error = (granted && granted.errorMsg) || "GRANT_FAILED";
      }
    }

    // Pilots already in the system see the wreck at once. A system nobody
    // has loaded picks it up with the rest of its space items on load.
    const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
    if (
      typeof spaceRuntime.getSceneByDescriptor === "function" &&
      spaceRuntime.getSceneByDescriptor(host.solarSystemID)
    ) {
      const spawned = spaceRuntime.spawnDynamicInventoryEntity(
        host.solarSystemID,
        summary.containerID,
      );
      if (!spawned || spawned.success !== true) {
        log.warn(
          `[SovHubLossDrops] Hub ${targetID} wreck ${summary.containerID} did not spawn in ` +
            `system ${host.solarSystemID}: ${(spawned && spawned.errorMsg) || "unknown"}`,
        );
      }
    }
  } catch (error) {
    summary.error = String((error && error.message) || error || "HUB_DROP_FAILED");
    log.error(
      `[SovHubLossDrops] Hub ${targetID} drop failed in system ${host.solarSystemID}: ` +
        `${summary.error}`,
    );
  }
  const failed = summary.items.filter((item) => item.error);
  if (failed.length > 0) {
    log.warn(
      `[SovHubLossDrops] Hub ${targetID}: ${failed.length} dropped stack(s) could not be placed ` +
        `(${failed.map((item) => `${item.typeID}:${item.error}`).join(", ")})`,
    );
  }
  return summary;
}

module.exports = {
  DROP_KIND_FUEL,
  DROP_KIND_UPGRADE,
  buildHubLossDropSeed,
  rollSovereigntyHubLossDrops,
  dropSovereigntyHubContents,
};
