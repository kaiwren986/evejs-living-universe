"use strict";

// Chat command argument parsing: command and subcommand names, positive integers, amounts with
// k/m/b/t suffixes, quoted arguments, on/off toggles and an optional type name and count.

function normalizeCommandName(value) {
  return String(value || "").trim().toLowerCase();
}

function parseAmount(value) {
  const text = String(value || "")
    .trim()
    .replace(/,/g, "")
    .replace(/_/g, "");
  if (!text) {
    return null;
  }

  const match = /^(-?\d+(?:\.\d+)?)([kmbt])?$/i.exec(text);
  if (!match) {
    return null;
  }

  const baseValue = Number(match[1]);
  if (!Number.isFinite(baseValue)) {
    return null;
  }

  const multiplier = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };
  const suffix = String(match[2] || "").toLowerCase();
  return baseValue * (multiplier[suffix] || 1);
}

function splitTrailingAmount(argumentText) {
  const trimmed = String(argumentText || "").trim();
  if (!trimmed) {
    return {
      lookupText: "",
      amount: null,
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return {
      lookupText: trimmed,
      amount: null,
    };
  }

  const trailingAmount = parseAmount(parts[parts.length - 1]);
  if (trailingAmount === null) {
    return {
      lookupText: trimmed,
      amount: null,
    };
  }

  return {
    lookupText: parts.slice(0, -1).join(" ").trim(),
    amount: trailingAmount,
  };
}

function tokenizeQuotedArguments(argumentText) {
  const tokens = [];
  const expression =
    /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  const text = String(argumentText || "");
  let match = expression.exec(text);
  while (match) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(
      String(value)
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\"),
    );
    match = expression.exec(text);
  }

  return tokens;
}

function normalizePositiveInteger(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseToggleCommandArgument(argumentText) {
  const normalized = String(argumentText || "").trim().toLowerCase();
  if (!normalized) {
    return {
      success: true,
      mode: "status",
    };
  }

  if (["on", "enable", "enabled", "true", "1"].includes(normalized)) {
    return {
      success: true,
      mode: "on",
    };
  }
  if (["off", "disable", "disabled", "false", "0"].includes(normalized)) {
    return {
      success: true,
      mode: "off",
    };
  }
  if (["status", "state"].includes(normalized)) {
    return {
      success: true,
      mode: "status",
    };
  }

  return {
    success: false,
    errorMsg: "INVALID_TOGGLE",
  };
}

function parseOptionalTypeAndCount(argumentText) {
  const trimmed = String(argumentText || "").trim();
  if (!trimmed) {
    return {
      typeName: "",
      count: null,
    };
  }

  if (/^\d+$/.test(trimmed)) {
    return {
      typeName: "",
      count: normalizePositiveInteger(trimmed),
    };
  }

  const splitLookup = splitTrailingAmount(trimmed);
  if (splitLookup.lookupText && splitLookup.amount !== null) {
    return {
      typeName: splitLookup.lookupText,
      count: normalizePositiveInteger(Math.trunc(splitLookup.amount)),
    };
  }

  return {
    typeName: trimmed,
    count: null,
  };
}

module.exports = {
  normalizeCommandName,
  parseAmount,
  splitTrailingAmount,
  tokenizeQuotedArguments,
  normalizePositiveInteger,
  parseToggleCommandArgument,
  parseOptionalTypeAndCount,
};
