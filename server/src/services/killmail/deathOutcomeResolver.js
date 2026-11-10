"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const {
  toInt,
} = require("../../common/numbers");

const crypto = require("crypto");
const path = require("path");

const {
  findItemById,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const deathItemCustody = require(path.join(
  __dirname,
  "../inventory/deathItemCustody",
));
const {
  resolveInventoryItemQuantity,
} = require(path.join(__dirname, "./killmailItemPayload"));

const RIG_FLAG_MIN = 92;
const RIG_FLAG_MAX = 99;
const SUBSYSTEM_FLAG_MIN = 125;
const SUBSYSTEM_FLAG_MAX = 132;

// Stacks up to this many units roll every unit separately. Larger stacks draw
// their dropped count in one step instead, because a roll costs about a
// microsecond and the server does nothing else meanwhile: a Charon's hold full
// of Tritanium, 46.5 million units, froze every player for 47 seconds. The
// one-step draw keeps each unit's 50% odds. Its cumulative odds differ from the
// exact per-unit result by under 0.03 percentage points at 100 units, and by
// less as stacks grow.
const PER_UNIT_DROP_ROLL_LIMIT = 100;

function toPositiveInt(value, fallback = null) {
  const numericValue = toInt(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function isAlwaysDestroyedFlag(flagID) {
  const numericFlagID = toInt(flagID, 0);
  return (
    (numericFlagID >= RIG_FLAG_MIN && numericFlagID <= RIG_FLAG_MAX) ||
    (numericFlagID >= SUBSYSTEM_FLAG_MIN && numericFlagID <= SUBSYSTEM_FLAG_MAX)
  );
}

function listSortedContainerItems(containerID) {
  return listContainerItems(null, containerID, null)
    .slice()
    .sort((left, right) => (Number(left.itemID) || 0) - (Number(right.itemID) || 0));
}

// Walked on an explicit frame stack rather than by recursion, so containment
// depth costs heap rather than JS call stack, and so a containment chain that
// loops back on itself is caught instead of running forever. `visited` is
// seeded with the root location, which makes an item that claims to contain
// its own container just as invalid as one that repeats.
//
// Order is unchanged: siblings are still visited by ascending itemID, and a
// node still precedes its children. The throw lands before any caller reaches
// applyResolvedNode(), so a corrupt chain aborts the death outcome whole
// rather than half-applying its moves and destroys. Depth ceilings in the
// later recursive resolution and payload stages are untouched.
function buildSnapshotTree(locationID) {
  const visited = new Set([toPositiveInt(locationID, 0)]);
  const frames = [
    {
      children: [],
      items: listSortedContainerItems(toPositiveInt(locationID, 0)),
      index: 0,
    },
  ];
  const roots = frames[0].children;

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.index >= frame.items.length) {
      frames.pop();
      continue;
    }
    const item = frame.items[frame.index];
    frame.index += 1;

    const itemID = toPositiveInt(item && item.itemID, null);
    if (!itemID || visited.has(itemID)) {
      throw new Error("DEATH_OUTCOME_CONTAINMENT_INVALID");
    }
    visited.add(itemID);

    const node = {
      itemID,
      typeID: toPositiveInt(item && item.typeID, null),
      flag: toInt(item && item.flagID, 0),
      singleton: toInt(item && item.singleton, 0),
      quantity: Math.max(1, resolveInventoryItemQuantity(item)),
      children: [],
    };
    frame.children.push(node);
    const items = listSortedContainerItems(itemID);
    if (items.length > 0) {
      frames.push({ children: node.children, items, index: 0 });
    }
  }

  return roots;
}

function hashToDrop(seed, itemID, unitIndex) {
  const digest = crypto
    .createHash("sha1")
    .update(`${String(seed)}:${Number(itemID) || 0}:${Number(unitIndex) || 0}`, "utf8")
    .digest();
  return (digest.readUInt32BE(0) / 0xffffffff) < 0.5;
}

// How many units of a large stack drop: a normal draw with the per-unit
// roll's mean and spread, n/2 and sqrt(n)/2, rounded to a whole unit. It hashes
// once per stack, so it stays deterministic for a given seed and costs the
// same for 101 units as for two billion.
function drawStackDropCount(seed, itemID, quantity) {
  const digest = crypto
    .createHash("sha1")
    .update(`${String(seed)}:${Number(itemID) || 0}:stack`, "utf8")
    .digest();
  const u1 = (digest.readUInt32BE(0) + 1) / 0x100000000;
  const u2 = digest.readUInt32BE(4) / 0x100000000;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const dropped = Math.round(quantity / 2 + (z * Math.sqrt(quantity)) / 2);
  return Math.min(quantity, Math.max(0, dropped));
}

function resolveStackDropCounts(snapshot, seed, options = {}) {
  const quantity = Math.max(1, toInt(snapshot && snapshot.quantity, 1));
  if (options.forceAllDestroyed === true || isAlwaysDestroyedFlag(snapshot && snapshot.flag)) {
    return {
      qtyDropped: 0,
      qtyDestroyed: quantity,
    };
  }
  if (options.forceAllDropped === true) {
    return {
      qtyDropped: quantity,
      qtyDestroyed: 0,
    };
  }

  if (quantity > PER_UNIT_DROP_ROLL_LIMIT) {
    const qtyDropped = drawStackDropCount(seed, snapshot && snapshot.itemID, quantity);
    return {
      qtyDropped,
      qtyDestroyed: quantity - qtyDropped,
    };
  }

  let qtyDropped = 0;
  for (let unitIndex = 0; unitIndex < quantity; unitIndex += 1) {
    if (hashToDrop(seed, snapshot && snapshot.itemID, unitIndex)) {
      qtyDropped += 1;
    }
  }
  return {
    qtyDropped,
    qtyDestroyed: quantity - qtyDropped,
  };
}

function resolveSnapshotNode(snapshot, seed, options = {}) {
  const quantity = Math.max(1, toInt(snapshot && snapshot.quantity, 1));
  const isSingleton = toInt(snapshot && snapshot.singleton, 0) === 1 || quantity === 1;
  const stackResolution = resolveStackDropCounts(snapshot, seed, options);
  const childResolutions = (Array.isArray(snapshot && snapshot.children) ? snapshot.children : [])
    .map((child) => resolveSnapshotNode(child, seed, options));

  if (!isSingleton) {
    return {
      ...snapshot,
      qtyDropped: stackResolution.qtyDropped,
      qtyDestroyed: stackResolution.qtyDestroyed,
      children: [],
      resolvedChildren: childResolutions,
    };
  }

  const dropped =
    options.forceAllDestroyed === true || isAlwaysDestroyedFlag(snapshot && snapshot.flag)
      ? 0
      : options.forceAllDropped === true
        ? 1
        : (hashToDrop(seed, snapshot && snapshot.itemID, 0) ? 1 : 0);
  return {
    ...snapshot,
    qtyDropped: dropped,
    qtyDestroyed: dropped ? 0 : 1,
    children: childResolutions,
  };
}

function buildKillmailNodePayload(resolution) {
  return {
    typeID: toPositiveInt(resolution && resolution.typeID, null),
    flag: toInt(resolution && resolution.flag, 0),
    singleton: toInt(resolution && resolution.singleton, 0),
    qtyDropped: Math.max(0, toInt(resolution && resolution.qtyDropped, 0)),
    qtyDestroyed: Math.max(0, toInt(resolution && resolution.qtyDestroyed, 0)),
    contents: (Array.isArray(resolution && resolution.children) ? resolution.children : [])
      .map((child) => buildKillmailNodePayload(child)),
  };
}

function moveResolvedQuantity(itemID, destinationLocationID, quantity, operationID) {
  if (!(Number(quantity) > 0) || !(Number(destinationLocationID) > 0)) {
    return [];
  }
  const currentItem = findItemById(itemID);
  if (!currentItem) {
    return [];
  }
  const moveResult = deathItemCustody.moveToLoot({
    item: currentItem,
    lootLocationID: destinationLocationID,
    quantity,
    operationID,
  });
  if (!moveResult.success || !moveResult.data || !Array.isArray(moveResult.data.changes)) {
    return [];
  }
  return moveResult.data.changes;
}

function removeResolvedItem(itemID, operationID) {
  const currentItem = findItemById(itemID);
  if (!currentItem) {
    return [];
  }
  const removeResult = deathItemCustody.destroyItem({
    item: currentItem,
    operationID,
  });
  if (!removeResult.success || !removeResult.data || !Array.isArray(removeResult.data.changes)) {
    return [];
  }
  return removeResult.data.changes;
}

function applyResolvedNode(
  resolution,
  rootLootLocationID,
  parentDropped = false,
  operationID = "death-outcome",
) {
  const movedChanges = [];
  const destroyChanges = [];
  const currentItem = findItemById(resolution && resolution.itemID);
  if (!currentItem) {
    return {
      movedChanges,
      destroyChanges,
    };
  }

  const quantity = Math.max(1, toInt(resolution && resolution.quantity, 1));
  const isSingleton = toInt(resolution && resolution.singleton, 0) === 1 || quantity === 1;

  if (!isSingleton) {
    if (toInt(resolution && resolution.qtyDropped, 0) > 0) {
      movedChanges.push(
        ...moveResolvedQuantity(
          currentItem.itemID,
          rootLootLocationID,
          toInt(resolution.qtyDropped, 0),
          operationID,
        ),
      );
    }
    const remainingItem = findItemById(currentItem.itemID);
    if (remainingItem && toInt(resolution && resolution.qtyDestroyed, 0) > 0) {
      destroyChanges.push(...removeResolvedItem(remainingItem.itemID, operationID));
    }
    return {
      movedChanges,
      destroyChanges,
    };
  }

  const itemDropped = toInt(resolution && resolution.qtyDropped, 0) > 0;
  if (itemDropped && !parentDropped && toPositiveInt(rootLootLocationID, null)) {
    movedChanges.push(...moveResolvedQuantity(
      currentItem.itemID,
      rootLootLocationID,
      1,
      operationID,
    ));
  }

  for (const childResolution of Array.isArray(resolution && resolution.children) ? resolution.children : []) {
    const childResult = applyResolvedNode(
      childResolution,
      rootLootLocationID,
      itemDropped,
      operationID,
    );
    movedChanges.push(...childResult.movedChanges);
    destroyChanges.push(...childResult.destroyChanges);
  }

  const refreshedItem = findItemById(currentItem.itemID);
  if (refreshedItem && !itemDropped) {
    destroyChanges.push(...removeResolvedItem(refreshedItem.itemID, operationID));
  }

  return {
    movedChanges,
    destroyChanges,
  };
}

function resolveLocationDeathOutcome(locationID, options = {}) {
  const seed = options.seed || `death:${String(locationID || 0)}`;
  const rootLootLocationID =
    options.forceAllDestroyed === true
      ? null
      : toPositiveInt(options.rootLootLocationID, null);
  const snapshotTree = buildSnapshotTree(locationID);
  const resolvedTree = snapshotTree.map((snapshot) =>
    resolveSnapshotNode(snapshot, seed, options),
  );
  const movedChanges = [];
  const destroyChanges = [];
  for (const resolution of resolvedTree) {
    const applyResult = applyResolvedNode(
      resolution,
      rootLootLocationID,
      false,
      seed,
    );
    movedChanges.push(...applyResult.movedChanges);
    destroyChanges.push(...applyResult.destroyChanges);
  }

  return {
    success: true,
    data: {
      items: resolvedTree.map((resolution) => buildKillmailNodePayload(resolution)),
      movedChanges,
      destroyChanges,
      snapshotTree: cloneValue(snapshotTree),
    },
  };
}

// A caller with a durable death journal records this plan before touching
// inventory. Each custody command then replays against its original source,
// even after an earlier command moved a stack or removed its parent.
function prepareLocationDeathOutcome(locationID, options = {}) {
  const seed = String(options.seed || `death:${locationID}`);
  const snapshotTree = buildSnapshotTree(locationID);
  const resolvedTree = snapshotTree.map((snapshot) => resolveSnapshotNode(snapshot, seed, options));
  function capture(node) {
    node.sourceItem = cloneValue(findItemById(node.itemID));
    for (const child of [...(node.children || []), ...(node.resolvedChildren || [])]) capture(child);
  }
  resolvedTree.forEach(capture);
  return { seed, forceAllDestroyed: options.forceAllDestroyed === true, resolvedTree,
    items: resolvedTree.map(buildKillmailNodePayload) };
}

function applyPreparedLocationDeathOutcome(plan, rootLootLocationID) {
  const movedChanges = [], destroyChanges = [];
  function check(result) {
    if (!result || result.success !== true) throw new Error(result && result.errorMsg || "DEATH_CUSTODY_FAILED");
    return result.data && result.data.changes || [];
  }
  function apply(node, parentDropped = false) {
    const original = node.sourceItem;
    if (!original) throw new Error("DEATH_PLAN_SOURCE_MISSING");
    const stack = node.singleton !== 1 && node.quantity > 1;
    if (node.qtyDropped > 0 && !parentDropped) {
      if (!(rootLootLocationID > 0)) throw new Error("DEATH_PLAN_LOOT_LOCATION_MISSING");
      movedChanges.push(...check(deathItemCustody.moveToLoot({ item: original,
        lootLocationID: rootLootLocationID, quantity: node.qtyDropped,
        operationID: plan.seed })));
    }
    for (const child of node.children || []) apply(child, node.qtyDropped > 0);
    if (node.qtyDestroyed > 0) {
      // A partial-stack drop retains its source row for the destroyed units.
      destroyChanges.push(...check(deathItemCustody.destroyItem({ item: original,
        operationID: plan.seed })));
    }
    if (stack) for (const child of node.resolvedChildren || []) apply(child, false);
  }
  for (const node of plan.resolvedTree) apply(node);
  return { success: true, data: { items: cloneValue(plan.items), movedChanges, destroyChanges } };
}

module.exports = {
  prepareLocationDeathOutcome,
  applyPreparedLocationDeathOutcome,
  resolveLocationDeathOutcome,
  resolveStackDropCounts,
  _testing: {
    PER_UNIT_DROP_ROLL_LIMIT,
    resolveStackDropCounts,
  },
};
