"use strict";

// Committed dungeon rows are immutable by convention. Keep their dictionary
// immutable too, without copying every unrelated key for a one-row update.
// Only a balanced search path is copied; prior table views retain their root.
const tableMetadata = new WeakMap();

function height(node) {
  return node ? node.height : 0;
}

function node(key, value, ordinal, left = null, right = null) {
  return {
    key,
    value,
    ordinal,
    left,
    right,
    height: 1 + Math.max(height(left), height(right)),
  };
}

function rotateLeft(root) {
  const pivot = root.right;
  return node(pivot.key, pivot.value, pivot.ordinal,
    node(root.key, root.value, root.ordinal, root.left, pivot.left), pivot.right);
}

function rotateRight(root) {
  const pivot = root.left;
  return node(pivot.key, pivot.value, pivot.ordinal, pivot.left,
    node(root.key, root.value, root.ordinal, pivot.right, root.right));
}

function balance(root) {
  const difference = height(root.left) - height(root.right);
  if (difference > 1) {
    if (height(root.left.left) < height(root.left.right)) {
      root = node(root.key, root.value, root.ordinal, rotateLeft(root.left), root.right);
    }
    return rotateRight(root);
  }
  if (difference < -1) {
    if (height(root.right.right) < height(root.right.left)) {
      root = node(root.key, root.value, root.ordinal, root.left, rotateRight(root.right));
    }
    return rotateLeft(root);
  }
  return root;
}

function find(root, key) {
  while (root) {
    if (key === root.key) return root;
    root = key < root.key ? root.left : root.right;
  }
  return null;
}

function put(root, key, value, ordinal) {
  if (!root) return node(key, value, ordinal);
  if (key === root.key) {
    return root.value === value && root.ordinal === ordinal
      ? root
      : node(key, value, ordinal, root.left, root.right);
  }
  if (key < root.key) {
    const left = put(root.left, key, value, ordinal);
    return left === root.left ? root : balance(node(root.key, root.value, root.ordinal, left, root.right));
  }
  const right = put(root.right, key, value, ordinal);
  return right === root.right ? root : balance(node(root.key, root.value, root.ordinal, root.left, right));
}

function remove(root, key) {
  if (!root) return null;
  if (key < root.key) {
    const left = remove(root.left, key);
    return left === root.left ? root : balance(node(root.key, root.value, root.ordinal, left, root.right));
  }
  if (key > root.key) {
    const right = remove(root.right, key);
    return right === root.right ? root : balance(node(root.key, root.value, root.ordinal, root.left, right));
  }
  if (!root.left) return root.right;
  if (!root.right) return root.left;
  let successor = root.right;
  while (successor.left) successor = successor.left;
  return balance(node(successor.key, successor.value, successor.ordinal,
    root.left, remove(root.right, successor.key)));
}

function arrayIndex(key) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key
    ? index
    : null;
}

function orderedKeys(root) {
  const entries = [];
  function visit(current) {
    if (!current) return;
    visit(current.left);
    entries.push(current);
    visit(current.right);
  }
  visit(root);
  entries.sort((left, right) => {
    const leftIndex = arrayIndex(left.key);
    const rightIndex = arrayIndex(right.key);
    if (leftIndex !== null) return rightIndex === null ? -1 : leftIndex - rightIndex;
    if (rightIndex !== null) return 1;
    return left.ordinal - right.ordinal;
  });
  return entries.map((entry) => entry.key);
}

function rejectMutation() {
  throw new TypeError("Committed dungeon instance tables are read-only");
}

function view(root, nextOrdinal) {
  const target = {};
  const table = new Proxy(target, {
    get(_target, key, receiver) {
      const entry = typeof key === "string" ? find(root, key) : null;
      return entry ? entry.value : Reflect.get(target, key, receiver);
    },
    has(_target, key) {
      return (typeof key === "string" && find(root, key) !== null) || Reflect.has(target, key);
    },
    ownKeys() {
      return orderedKeys(root);
    },
    getOwnPropertyDescriptor(_target, key) {
      const entry = typeof key === "string" ? find(root, key) : null;
      return entry
        ? { value: entry.value, writable: true, enumerable: true, configurable: true }
        : undefined;
    },
    set: rejectMutation,
    deleteProperty: rejectMutation,
    defineProperty: rejectMutation,
    setPrototypeOf: rejectMutation,
    preventExtensions: rejectMutation,
  });
  tableMetadata.set(table, { root, nextOrdinal });
  return table;
}

function createInstanceTable(source = {}) {
  if (source && tableMetadata.has(source)) return source;
  let root = null;
  let nextOrdinal = 0;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const [key, value] of Object.entries(source)) {
      root = put(root, key, value, nextOrdinal++);
    }
  }
  return view(root, nextOrdinal);
}

// `null` removes a key. Reinsertion records delete-then-add ordering for keys
// that are not array indices; an ordinary replacement keeps its prior rank.
function updateInstanceTable(table, changes, reinsertKeys = null) {
  table = createInstanceTable(table);
  const original = tableMetadata.get(table);
  let root = original.root;
  let nextOrdinal = original.nextOrdinal;
  for (const [rawKey, value] of changes) {
    const key = String(rawKey);
    if (value === null) {
      root = remove(root, key);
      continue;
    }
    const previous = find(root, key);
    const ordinal = previous && !(reinsertKeys && reinsertKeys.has(key))
      ? previous.ordinal
      : nextOrdinal++;
    root = put(root, key, value, ordinal);
  }
  return root === original.root ? table : view(root, nextOrdinal);
}

module.exports = { createInstanceTable, updateInstanceTable };
