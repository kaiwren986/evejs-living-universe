"use strict";

const { createTableRepository } = require("../../gameStore/tableRepository");
const { cloneValue } = require("../../common/clone");
const { createHash } = require("node:crypto");
// Static recipe validation must not open the player database.
let repository;
function getRepository() { return repository ||= createTableRepository("service:ship"); }
function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "SKINR_STORE_COMMAND_FAILED");
  return result.data;
}
function read(table) {
  const repository = getRepository();
  repository.ensureTable(table);
  return cloneValue(check(repository.read(table, "/")) || {});
}
function readPath(table, pth) {
  const repository = getRepository();
  repository.ensureTable(table);
  const result = repository.read(table, pth);
  if (result?.errorMsg === "ENTRY_NOT_FOUND") return null;
  return cloneValue(check(result));
}
function write(table, next) {
  const repository = getRepository();
  const previous = read(table);
  check(repository.write(table, "/", next));
  try { check(repository.flushTableSync(table)); }
  catch (error) { repository.write(table, "/", previous, { force: true }); throw error; }
  return cloneValue(next);
}
function positive(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : 0;
}
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function requestKey(value) {
  return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,180}$/.test(value) ? value : null;
}
function fail(errorMsg, statusCode = 409) { return { success: false, errorMsg, statusCode }; }
module.exports = { read, readPath, write, check, cloneValue, positive, fingerprint, requestKey, fail };
