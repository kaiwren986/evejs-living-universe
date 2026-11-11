"use strict";

const stock = [
  ...require("./server"),
  ...require("./gameplay"),
  ...require("./world"),
  ...require("./mining"),
  ...require("./npc"),
  ...require("./economy"),
  ...require("./crew"),
];

// Living Universe: the mod's own settings (config/xeve.json). The mod was written
// against an older EveJS and its schema repeats a few keys that are stock now;
// the stock definition wins.
const stockKeys = new Set(stock.map((entry) => entry.key));

module.exports = [
  ...stock,
  ...require("./xeve").filter((entry) => !stockKeys.has(entry.key)),
];
