"use strict";

module.exports = {
  popMinHeapEntry,
  pushMinHeapEntry,
};


function pushMinHeapEntry(heap, entry, compareEntries) {
  if (!Array.isArray(heap) || !entry || typeof compareEntries !== "function") {
    return false;
  }
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (compareEntries(heap[parentIndex], heap[index]) <= 0) {
      break;
    }
    const parent = heap[parentIndex];
    heap[parentIndex] = heap[index];
    heap[index] = parent;
    index = parentIndex;
  }
  return true;
}

function popMinHeapEntry(heap, compareEntries) {
  if (!Array.isArray(heap) || heap.length <= 0) {
    return null;
  }
  const first = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const leftIndex = (index * 2) + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = index;
      if (
        leftIndex < heap.length &&
        compareEntries(heap[leftIndex], heap[smallestIndex]) < 0
      ) {
        smallestIndex = leftIndex;
      }
      if (
        rightIndex < heap.length &&
        compareEntries(heap[rightIndex], heap[smallestIndex]) < 0
      ) {
        smallestIndex = rightIndex;
      }
      if (smallestIndex === index) {
        break;
      }
      const current = heap[index];
      heap[index] = heap[smallestIndex];
      heap[smallestIndex] = current;
      index = smallestIndex;
    }
  }
  return first;
}
