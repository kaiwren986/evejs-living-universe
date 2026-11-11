"use strict";

// Living Universe port: the mod's /population command (stage 1 subset: the
// pilot runtime). The economy and conflict subcommands come with those stages.

const path = require("path");

const livingUniverseRuntime = require(path.join(
  __dirname,
  "../../../space/npc/ambientTraffic/livingUniverseRuntime",
));

const USAGE = "Usage: /population [status|depart|reset|load <1-5000>]";

function executeLivingUniverseCommand(argumentText) {
  const subcommand = String(argumentText || "status").trim().toLowerCase() || "status";
  const parts = subcommand.split(/\s+/).filter(Boolean);
  if (subcommand === "status" || subcommand === "list") {
    return { message: livingUniverseRuntime.formatStatus() };
  }
  if (subcommand === "depart" || subcommand === "now") {
    livingUniverseRuntime.departNow();
    return {
      message: `Living-universe departures requested. ${livingUniverseRuntime.formatStatus()}`,
    };
  }
  if (subcommand === "reset") {
    livingUniverseRuntime.reset();
    return {
      message: `Living-universe population reset. ${livingUniverseRuntime.formatStatus()}`,
    };
  }
  if (parts[0] === "load" || parts[0] === "size") {
    const target = Math.trunc(Number(parts[1]) || 0);
    if (target < 1 || target > 5000) {
      return { message: USAGE };
    }
    const status = livingUniverseRuntime.resizePopulation(target);
    return {
      message:
        `Living-universe load set to ${status.actorCount} actors in ` +
        `${status.flightCount} flights.`,
    };
  }
  return { message: USAGE };
}

module.exports = {
  executeLivingUniverseCommand,
};
