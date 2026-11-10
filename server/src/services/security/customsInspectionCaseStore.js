"use strict";

const { cloneValue } = require("../../common/clone");
const database = require("../../gameStore");
const { createTableRepository } = require("../../gameStore/tableRepository");
const repository = createTableRepository("service:security", { strict: true });
const TABLE_NAME = "customsInspectionCases";
const TERMINAL_STATES = new Set([
  "ineligible", "not-selected", "clean", "surrendered", "evaded", "destroyed", "expired",
]);

function readRoot() {
  database.ensureTable(TABLE_NAME);
  const result = repository.read(TABLE_NAME, "/");
  if (!result || !result.success) throw new Error("CUSTOMS_CASE_READ_FAILED");
  return cloneValue(result.data && result.data.byCaseID || {});
}

function getCase(caseID) {
  return readRoot()[String(caseID)] || null;
}

function listCases({ characterID, activeOnly = false } = {}) {
  return Object.values(readRoot()).filter((record) =>
    (!characterID || record.characterID === Number(characterID)) &&
    (!activeOnly || !TERMINAL_STATES.has(record.state)));
}

function saveCase(record) {
  if (!record || !record.caseID) throw new Error("CUSTOMS_CASE_ID_REQUIRED");
  const root = readRoot();
  root[record.caseID] = cloneValue(record);
  const written = repository.write(TABLE_NAME, "/", { version: 1, byCaseID: root });
  if (!written || !written.success) throw new Error("CUSTOMS_CASE_WRITE_FAILED");
  const flushed = database.flushTableSync(TABLE_NAME);
  if (!flushed || !flushed.success) throw new Error("CUSTOMS_CASE_FLUSH_FAILED");
  return cloneValue(record);
}

module.exports = { TABLE_NAME, TERMINAL_STATES, getCase, listCases, saveCase };
