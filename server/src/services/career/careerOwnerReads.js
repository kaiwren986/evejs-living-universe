"use strict";

const database = require("../../gameStore");

// A projection observes one durable value per owner/path. Keep this cache on
// its supplied context so a later projection still sees newly committed work.
function readDurablePath(table, path, context, errorMsg) {
  const values = context.careerDurablePaths ||= new Map();
  const key = `${table}:${path}`;
  if (values.has(key)) return values.get(key);
  const result = database.readPersisted(table, path);
  if (!result?.success && result?.errorMsg !== "ENTRY_NOT_FOUND") {
    throw new Error(result?.errorMsg || errorMsg);
  }
  const value = result?.success ? result.data : null;
  values.set(key, value);
  return value;
}

module.exports = { readDurablePath };
