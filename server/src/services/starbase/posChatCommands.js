"use strict";

const {
  applyPosDamage,
  fastForwardPosTimers,
  forcePosFuelCycle,
  forcePosAnchorState,
  forcePosOnlineState,
  formatPosStructure,
  logPosGmAction,
  repairPosStructure,
  resolvePosStructure,
  setPosTimerScale,
} = require("./posGmState");

const { hasStaffAccountRole } = require("../account/accountRoleProfiles");

// These subcommands force structure state and skip every corporation and access
// check, so they are staff tools. operate, production, compress and bridge go
// through the normal permission checks and stay open to players.
const STAFF_ONLY_POS_SUBCOMMANDS = new Set([
  "anchor", "unanchor", "online", "offline", "repair",
  "ff", "timer", "damage", "fuelcycle",
]);

const POS_HELP_LINES = Object.freeze([
  "/pos operate <anchor|unanchor|online|offline> <moduleID|name> (validated server diagnostic)",
  "/pos anchor <structureID|name|here>",
  "/pos unanchor <structureID|name|here>",
  "/pos online <structureID|name|here>",
  "/pos offline <structureID|name|here>",
  "/pos ff <structureID|name|here> <seconds>",
  "/pos repair <structureID|name|here>",
  "/pos damage <structureID|name|here> <shield|armor|armour|hull|kill> [amount]",
  "/pos fuelcycle <controlTowerID|name|here>",
  "/pos bridge <link sourceID destinationID|unlink sourceID>",
  "/pos timer <structureID|name|here> <scale>",
  "/pos compress <compressionArrayID> <itemID> [itemID ...] (server diagnostic)",
  "/pos production <status|cycle|provision|link|unlink|clear> <towerID> [...] (server diagnostic)",
]);

function buildPosHelpText() {
  return POS_HELP_LINES.join("\n");
}

function failureMessage(prefix, result) {
  const errorMsg = String(result && result.errorMsg || "UNKNOWN_ERROR");
  if (errorMsg === "POS_STRUCTURE_NAME_AMBIGUOUS") {
    const matches = result && result.data && result.data.matches || [];
    const choices = matches
      .map((item) => `${item.itemName}(${item.itemID})`)
      .join(", ");
    return `POS structure name is ambiguous${choices ? `: ${choices}` : ""}. Use its item ID.`;
  }
  if (errorMsg === "POS_STRUCTURE_NOT_FOUND_HERE") {
    return "No POS structure was found in your current solar system.";
  }
  if (errorMsg === "POS_CURRENT_SYSTEM_UNAVAILABLE") {
    return "Your current solar system is unavailable; provide a POS structure ID or name.";
  }
  if (errorMsg === "POS_STRUCTURE_NOT_FOUND") {
    return "POS structure not found. Provide a valid item ID, exact name, or 'here'.";
  }
  if (errorMsg === "ITEM_NOT_POS_STRUCTURE") {
    return "The selected item is not an in-space POS structure.";
  }
  if (errorMsg === "UNSUPPORTED_POS_RUNTIME") {
    return "The selected POS structure is not supported by the live runtime in this build.";
  }
  return `${prefix}: ${errorMsg}.`;
}

function splitTrailingNumber(argumentText) {
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }
  const valueToken = tokens[tokens.length - 1];
  return {
    targetText: tokens.slice(0, -1).join(" "),
    valueToken,
  };
}

function parseDamageArguments(argumentText) {
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }
  const finalToken = tokens[tokens.length - 1];
  const finalNumber = Number(finalToken);
  const hasAmount = Number.isFinite(finalNumber);
  const layerIndex = hasAmount ? tokens.length - 2 : tokens.length - 1;
  if (layerIndex <= 0) {
    return null;
  }
  const rawLayer = String(tokens[layerIndex] || "").toLowerCase();
  return {
    targetText: tokens.slice(0, layerIndex).join(" "),
    layer: rawLayer === "armour" ? "armor" : rawLayer,
    amount: hasAmount ? finalNumber : null,
  };
}

function resolveCommandTarget(session, targetText) {
  const result = resolvePosStructure(session, targetText);
  if (!result.success) {
    return {
      success: false,
      message: failureMessage("Unable to resolve POS structure", result),
    };
  }
  return result;
}

function executePosCommand(session, argumentText) {
  const trimmed = String(argumentText || "").trim();
  const separatorIndex = trimmed.search(/\s/);
  const subcommand = (
    separatorIndex < 0 ? trimmed : trimmed.slice(0, separatorIndex)
  ).trim().toLowerCase();
  const remainder = separatorIndex < 0
    ? ""
    : trimmed.slice(separatorIndex + 1).trim();

  if (STAFF_ONLY_POS_SUBCOMMANDS.has(subcommand) && !hasStaffAccountRole(session)) {
    return {
      success: false,
      message: `/pos ${subcommand} forces starbase state without access checks and requires a staff or GM account.`,
    };
  }

  // Current-client CanAnchorStructure/CanOnlineStructure suppress deprecated
  // POS groups. This diagnostic uses normal lifecycle authority and timers;
  // the existing force-state commands below retain their GM semantics.
  if (subcommand === "operate") {
    const match = /^(anchor|unanchor|online|offline)\s+(.+)$/i.exec(remainder);
    if (!match) return { success: false, message: POS_HELP_LINES[0] };
    const operation = match[1].toLowerCase();
    const target = resolveCommandTarget(session, match[2]);
    if (!target.success) return target;
    const item = target.data;
    if (!require("./starbaseResourceRuntime").isStarbaseModule(item)) {
      return { success: false, message: "The operate diagnostic requires an in-space POS module." };
    }
    const runtime = require("./starbaseModuleRuntime");
    const result = operation === "anchor" || operation === "unanchor"
      ? runtime.startAnchorTransition(session, item.itemID,
        operation === "anchor" ? "anchorDropForStructures" : "anchorLiftForStructures")
      : runtime.setOnlineState(session, item.itemID, operation === "online");
    if (!result.success) return { success: false,
      message: failureMessage(`Unable to ${operation} POS module`, result) };
    logPosGmAction(session, `operate ${operation}`, result.data || item);
    return { success: true, message:
      `Validated ${operation}: ${formatPosStructure(result.data || item)}. ` +
      "Normal lifecycle timers apply. Server diagnostic; the legacy client menu remains unavailable." };
  }

  if (subcommand === "production") return require("./starbaseProductionRuntime").executeProductionCommand(session, remainder);

  if (subcommand === "compress") {
    const tokens = remainder.split(/\s+/).filter(Boolean).map(Number);
    if (tokens.length < 2 || tokens.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      return { success: false, message: "Usage: /pos compress <compressionArrayID> <itemID> [itemID ...]" };
    }
    const processing = require("./starbaseProcessingInventory");
    const result = processing.compressStarbaseItems(session, tokens[0], tokens.slice(1));
    if (!result.success) return { success: false,
      message: processing.getProcessingErrorMessage(result.errorMsg) || failureMessage("Unable to compress items", result) };
    const resolved = resolvePosStructure(session, String(tokens[0]));
    if (resolved.success) logPosGmAction(session, "compress", resolved.data, `${result.data.outputs.length} stack(s)`);
    return { success: true, message: `Compressed ${result.data.outputs.length} stack(s) in the POS array. This is a server diagnostic; the current client has no POS compression action.` };
  }

  if (!subcommand || ["help", "?", "commands"].includes(subcommand)) {
    return { success: true, message: buildPosHelpText() };
  }

  if (["anchor", "unanchor", "online", "offline", "repair"].includes(subcommand)) {
    if (!remainder) {
      return {
        success: false,
        message: `Usage: /pos ${subcommand} <structureID|name|here>`,
      };
    }
    const targetResult = resolveCommandTarget(session, remainder);
    if (!targetResult.success) {
      return targetResult;
    }
    const item = targetResult.data;
    let result;
    if (subcommand === "anchor" || subcommand === "unanchor") {
      result = forcePosAnchorState(item.itemID, subcommand === "anchor");
    } else if (subcommand === "online" || subcommand === "offline") {
      result = forcePosOnlineState(
        item.itemID,
        subcommand === "online",
        { session },
      );
    } else {
      result = repairPosStructure(item.itemID);
    }
    if (!result.success) {
      return {
        success: false,
        message: failureMessage(`Failed to ${subcommand} POS structure`, result),
      };
    }
    logPosGmAction(session, subcommand, result.data || item);
    const verb = {
      anchor: "Anchored",
      unanchor: "Unanchored",
      online: "Onlined",
      offline: "Offlined",
      repair: "Repaired",
    }[subcommand];
    return {
      success: true,
      message: `${verb} ${formatPosStructure(result.data || item)}.`,
    };
  }

  if (subcommand === "ff" || subcommand === "timer") {
    const parsed = splitTrailingNumber(remainder);
    const numericValue = parsed ? Number(parsed.valueToken) : Number.NaN;
    const valid = subcommand === "ff"
      ? Number.isFinite(numericValue) && numericValue >= 0
      : Number.isFinite(numericValue) && numericValue > 0;
    if (!parsed || !valid) {
      return {
        success: false,
        message: subcommand === "ff"
          ? "Usage: /pos ff <structureID|name|here> <seconds>"
          : "Usage: /pos timer <structureID|name|here> <scale>",
      };
    }
    const targetResult = resolveCommandTarget(session, parsed.targetText);
    if (!targetResult.success) {
      return targetResult;
    }
    const item = targetResult.data;
    const result = subcommand === "ff"
      ? fastForwardPosTimers(item.itemID, numericValue)
      : setPosTimerScale(item.itemID, numericValue);
    if (!result.success) {
      return {
        success: false,
        message: failureMessage(
          subcommand === "ff"
            ? "Failed to fast-forward POS timers"
            : "Failed to set POS timer scale",
          result,
        ),
      };
    }
    logPosGmAction(
      session,
      subcommand,
      result.data || item,
      subcommand === "ff" ? `seconds=${numericValue}` : `scale=${numericValue}`,
    );
    return {
      success: true,
      message: subcommand === "ff"
        ? `Fast-forwarded ${numericValue}s for ${formatPosStructure(result.data || item)}.`
        : `Set timer scale=${numericValue} for ${formatPosStructure(result.data || item)}.`,
    };
  }

  if (subcommand === "damage") {
    const parsed = parseDamageArguments(remainder);
    if (
      !parsed ||
      !["shield", "armor", "hull", "kill"].includes(parsed.layer) ||
      (parsed.amount !== null && parsed.amount <= 0) ||
      (parsed.layer === "kill" && parsed.amount !== null)
    ) {
      return {
        success: false,
        message: "Usage: /pos damage <structureID|name|here> <shield|armor|armour|hull|kill> [amount]",
      };
    }
    const targetResult = resolveCommandTarget(session, parsed.targetText);
    if (!targetResult.success) {
      return targetResult;
    }
    const item = targetResult.data;
    const result = applyPosDamage(item.itemID, parsed.layer, parsed.amount);
    if (!result.success) {
      return {
        success: false,
        message: failureMessage("Failed to apply GM POS damage", result),
      };
    }
    logPosGmAction(
      session,
      "damage",
      item,
      `layer=${parsed.layer}${parsed.amount === null ? "" : ` amount=${parsed.amount}`}`,
    );
    return {
      success: true,
      message: parsed.layer === "kill"
        ? `Destroyed ${item.itemName || `POS structure ${item.itemID}`}(${item.itemID}).`
        : `Applied ${parsed.amount === null ? "all remaining" : parsed.amount} ${parsed.layer} damage to ${formatPosStructure(result.data.item || item)}.`,
    };
  }

  if (subcommand === "bridge") {
    const tokens = remainder.split(/\s+/);
    const operation = tokens[0]?.toLowerCase();
    const sourceID = Number(tokens[1]);
    const destinationID = Number(tokens[2]);
    if (!["link", "unlink"].includes(operation) || !Number.isSafeInteger(sourceID) || sourceID <= 0 ||
      (operation === "link" ? tokens.length !== 3 || !Number.isSafeInteger(destinationID) || destinationID <= 0 : tokens.length !== 2)) {
      return { success: false, message: "Usage: /pos bridge link <sourceID> <destinationID> or /pos bridge unlink <sourceID>" };
    }
    const travel = require("./starbaseTravelRuntime");
    const result = operation === "link" ? travel.linkBridges(session, sourceID, destinationID) : travel.unlinkBridge(session, sourceID);
    if (!result.success) return { success: false, message: failureMessage("Failed to configure POS jump bridge", result) };
    logPosGmAction(session, `bridge-${operation}`, require("../inventory/itemStore").findItemById(sourceID),
      operation === "link" ? `destination=${destinationID}` : "");
    return { success: true, message: operation === "link" ? `Linked POS jump bridges ${sourceID} and ${destinationID}.`
      : `Unlinked POS jump bridge ${sourceID}.` };
  }

  if (subcommand === "fuelcycle") {
    if (!remainder) {
      return {
        success: false,
        message: "Usage: /pos fuelcycle <controlTowerID|name|here>",
      };
    }
    const targetResult = resolveCommandTarget(session, remainder);
    if (!targetResult.success) {
      return targetResult;
    }
    const item = targetResult.data;
    const result = forcePosFuelCycle(item.itemID, { session });
    if (!result.success) {
      return {
        success: false,
        message: failureMessage("Failed to force POS fuel cycle", result),
      };
    }
    logPosGmAction(
      session,
      "fuelcycle",
      result.data || item,
      `completedCycles=${Number(result.completedCycles) || 0}`,
    );
    return {
      success: true,
      message: result.exhausted === true
        ? `Forced a fuel cycle for ${formatPosStructure(result.data || item)}; its fuel bay could not pay the cycle, so the tower was offlined.`
        : `Forced one fuel cycle for ${formatPosStructure(result.data || item)}.`,
    };
  }

  return {
    success: false,
    message: `Unknown /pos subcommand '${subcommand}'. Use /pos help.`,
  };
}

module.exports = {
  POS_HELP_LINES,
  buildPosHelpText,
  executePosCommand,
  _testing: {
    parseDamageArguments,
    splitTrailingNumber,
  },
};
