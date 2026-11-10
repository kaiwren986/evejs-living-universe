"use strict";

// ESS owns banks and settlement intents; wallet and item receipts stay with
// their respective authorities. Always read detached state across an await.
const { createTableRepository } = require("../../gameStore/tableRepository");
const repository = createTableRepository("service:dynamic");
const TABLE_NAME = "dynamicResourceRuntime";
function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "ESS_STORE_FAILED");
  return result.data;
}
function read() {
  repository.ensureTable(TABLE_NAME);
  return { version: 1, systems: {}, funding: {}, settlements: {}, unlocks: {}, losses: {}, ...structuredClone(check(repository.read(TABLE_NAME, "/")) || {}) };
}
function write(next) {
  const previous = read();
  check(repository.write(TABLE_NAME, "/", next));
  try { check(repository.flushTableSync(TABLE_NAME)); }
  catch (error) { repository.write(TABLE_NAME, "/", previous, { force: true }); throw error; }
}
function mutate(callback) {
  const next = read();
  const result = callback(next);
  write(next);
  return result;
}
module.exports = { TABLE_NAME, read, write, mutate, check };
