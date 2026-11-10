"use strict";

// Derived exclusively from itemStore's normalized, committed index rows.
// Latest inventorycommon/const.py:321 defines categoryStarbase = 23.
// Force fields (Latest inventorycommon/const.py:612, group 411) are category 2
// in the pinned SDE. Index them separately from category-23 query results.
// Lifecycle/state policy belongs to callers; offline and packaged POS remain
// indexed so reconciliation can find structures after they become unavailable.
const keysFor = (item) => ({
  systemID: Number(item.spaceState?.systemID) || 0,
  controlTowerID: Number(item.spaceState?.controlTowerID || item.controlTowerID) || 0,
  groupID: Number(item.groupID) || 0,
  categoryID: Number(item.categoryID) || 0,
  typeID: Number(item.typeID) || 0,
  ownerID: Number(item.ownerID) || 0,
});

class StarbaseItemIndex {
  constructor() {
    this.byID = new Map();
    this.keys = new Map();
    this.buckets = Object.fromEntries(Object.keys(keysFor({})).map((key) => [key, new Map()]));
  }

  remove(itemID) {
    const keys = this.keys.get(itemID);
    if (!keys) return;
    for (const [key, value] of Object.entries(keys)) {
      const bucket = this.buckets[key].get(value);
      bucket.delete(itemID);
      if (!bucket.size) this.buckets[key].delete(value);
    }
    this.byID.delete(itemID);
    this.keys.delete(itemID);
  }

  upsert(item) {
    this.remove(item.itemID);
    if (Number(item.categoryID) !== 23 && Number(item.groupID) !== 411) return;
    const keys = keysFor(item);
    this.byID.set(item.itemID, item);
    this.keys.set(item.itemID, keys);
    for (const [key, value] of Object.entries(keys)) {
      const buckets = this.buckets[key];
      if (!buckets.has(value)) buckets.set(value, new Set());
      buckets.get(value).add(item.itemID);
    }
  }

  *query(options = {}) {
    const filters = Object.entries(this.buckets)
      .filter(([key]) => options[key] !== undefined && options[key] !== null)
      .map(([key, buckets]) => buckets.get(Number(options[key])));
    if (filters.some((bucket) => !bucket)) return;
    const smallest = filters.reduce((best, bucket) => bucket.size < best.size ? bucket : best, this.byID);
    for (const itemID of smallest.keys()) {
      if (filters.every((bucket) => bucket.has(itemID))) yield this.byID.get(itemID);
    }
  }

  snapshot() {
    return Object.fromEntries(Object.entries(this.buckets).map(([key, buckets]) => [key,
      [...buckets].map(([value, ids]) => [value, [...ids].sort((a, b) => a - b)])
        .sort((a, b) => a[0] - b[0]),
    ]));
  }
}

module.exports = { StarbaseItemIndex };
