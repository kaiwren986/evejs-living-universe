"use strict";

// Standing chat commands: /setstanding (set a character's standing toward one owner) and
// /maxagentstandings, also spelled /fullstandings (max the standing toward every agent
// corporation and faction), with the owner lookup and the trailing target argument they use.

const path = require("path");

const {
  getOwnerLookupRecord,
  findCorporationByName,
} = require("../../corporation/corporationState");
const {
  listAgents,
} = require(path.join(__dirname, "../../agent/agentAuthority"));
const standingRuntime = require(path.join(__dirname, "../../character/standingRuntime"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizePositiveInteger,
  normalizeCommandName,
  tokenizeQuotedArguments,
} = require(path.join(__dirname, "./commandArguments"));
const {
  resolveCharacterTargetDescriptor,
  formatCharacterTargetLabel,
} = require(path.join(__dirname, "./characterTargets"));

function resolveDefaultCharacterTargetDescriptor(requestSession) {
  return resolveCharacterTargetDescriptor(requestSession, "me");
}

function resolveTrailingCharacterTargetDescriptor(requestSession, tokens = [], ownerStartIndex = 0) {
  const tokenList = Array.isArray(tokens) ? tokens : [];
  const ownerTokens = tokenList.slice(ownerStartIndex);
  if (ownerTokens.length >= 2) {
    const trailingToken = ownerTokens[ownerTokens.length - 1];
    const targetResult = resolveCharacterTargetDescriptor(requestSession, trailingToken);
    if (targetResult.success) {
      return {
        success: true,
        data: {
          ownerToken: ownerTokens.slice(0, -1).join(" ").trim(),
          targetDescriptor: targetResult.data,
          explicitTarget: true,
        },
      };
    }
  }

  const fallbackTarget = resolveDefaultCharacterTargetDescriptor(requestSession);
  if (!fallbackTarget.success) {
    return fallbackTarget;
  }

  return {
    success: true,
    data: {
      ownerToken: ownerTokens.join(" ").trim(),
      targetDescriptor: fallbackTarget.data,
      explicitTarget: false,
    },
  };
}

function resolveStandingOwnerDescriptor(ownerToken) {
  const normalizedToken = String(ownerToken || "").trim();
  if (!normalizedToken) {
    return {
      success: false,
      errorMsg: "OWNER_REQUIRED",
    };
  }

  const numericOwnerID = normalizePositiveInteger(normalizedToken);
  if (numericOwnerID) {
    const ownerRecord = getOwnerLookupRecord(numericOwnerID);
    if (ownerRecord) {
      return {
        success: true,
        data: {
          ownerID: numericOwnerID,
          ownerRecord,
          ownerKind: "owner",
        },
      };
    }
  }

  const normalizedName = normalizeCommandName(normalizedToken);
  const corporationRecord = findCorporationByName(normalizedToken);
  if (corporationRecord) {
    return {
      success: true,
      data: {
        ownerID: normalizePositiveInteger(corporationRecord.corporationID),
        ownerRecord: getOwnerLookupRecord(corporationRecord.corporationID),
        ownerKind: "corporation",
      },
    };
  }

  const factionRecord = standingRuntime.getFactionRecordsByName().get(normalizedName);
  if (factionRecord) {
    return {
      success: true,
      data: {
        ownerID: normalizePositiveInteger(factionRecord.factionID),
        ownerRecord: getOwnerLookupRecord(factionRecord.factionID),
        ownerKind: "faction",
      },
    };
  }

  const agentRecord = listAgents().find(
    (entry) => normalizeCommandName(entry && entry.ownerName) === normalizedName,
  );
  if (agentRecord) {
    return {
      success: true,
      data: {
        ownerID: normalizePositiveInteger(agentRecord.agentID),
        ownerRecord: getOwnerLookupRecord(agentRecord.agentID),
        ownerKind: "agent",
      },
    };
  }

  return {
    success: false,
    errorMsg: "OWNER_NOT_FOUND",
  };
}

function formatStandingOwnerLabel(ownerDescriptor) {
  if (!ownerDescriptor) {
    return "owner";
  }

  const ownerID = normalizePositiveInteger(ownerDescriptor.ownerID);
  const ownerName =
    (ownerDescriptor.ownerRecord && ownerDescriptor.ownerRecord.ownerName) ||
    null;
  if (ownerName && ownerID) {
    return `${ownerName}(${ownerID})`;
  }
  if (ownerName) {
    return ownerName;
  }
  if (ownerID) {
    return `owner ${ownerID}`;
  }
  return "owner";
}

function handleSetStandingCommand(session, argumentText, chatHub, options) {
  const usage = "Usage: /setstanding <value> <owner name|id> [target]";
  const tokens = tokenizeQuotedArguments(argumentText);
  if (tokens.length < 2) {
    return handledResult(chatHub, session, options, usage);
  }

  const standingValue = Number(tokens[0]);
  if (!Number.isFinite(standingValue) || standingValue < -10 || standingValue > 10) {
    return handledResult(
      chatHub,
      session,
      options,
      "Standing value must be a number between -10.0 and 10.0.",
    );
  }

  const targetResolution = resolveTrailingCharacterTargetDescriptor(
    session,
    tokens,
    1,
  );
  if (!targetResolution.success) {
    return handledResult(
      chatHub,
      session,
      options,
      targetResolution.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /setstanding."
        : usage,
    );
  }

  const { ownerToken, targetDescriptor } = targetResolution.data;
  if (!ownerToken) {
    return handledResult(chatHub, session, options, usage);
  }

  const ownerResolution = resolveStandingOwnerDescriptor(ownerToken);
  if (!ownerResolution.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Could not resolve a standing owner from "${ownerToken}".`,
    );
  }

  const ownerDescriptor = ownerResolution.data;
  const writeResult = standingRuntime.setCharacterStanding(
    targetDescriptor.characterID,
    ownerDescriptor.ownerID,
    standingValue,
    {
      eventTypeID: standingRuntime.EVENT_STANDING_SLASH_SET,
      message: `GM /setstanding ${standingValue} ${ownerToken}`,
    },
  );
  if (!writeResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Could not update the requested standing.",
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Set standing with ${formatStandingOwnerLabel(ownerDescriptor)} to ${Number(standingValue).toFixed(2)} for ${formatCharacterTargetLabel(targetDescriptor)}.`,
  );
}

function handleMaxAgentStandingsCommand(session, argumentText, chatHub, options) {
  const targetToken = String(argumentText || "").trim() || "me";
  const targetResolution = resolveCharacterTargetDescriptor(session, targetToken);
  if (!targetResolution.success) {
    return handledResult(
      chatHub,
      session,
      options,
      targetResolution.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /maxagentstandings."
        : `Character not found: ${targetToken}.`,
    );
  }

  const targetDescriptor = targetResolution.data;
  const standingOwners = standingRuntime.getAllAgentStandingOwners();
  const corporationIDs = Array.isArray(standingOwners && standingOwners.corporationIDs)
    ? standingOwners.corporationIDs.filter((ownerID) => Number(ownerID) > 0)
    : [];
  const factionIDs = Array.isArray(standingOwners && standingOwners.factionIDs)
    ? standingOwners.factionIDs.filter((ownerID) => Number(ownerID) > 0)
    : [];
  const entries = [
    ...corporationIDs.map((ownerID) => ({ ownerID, standing: 10.0 })),
    ...factionIDs.map((ownerID) => ({ ownerID, standing: 10.0 })),
  ];
  if (entries.length <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No agent corporations or factions were available to update.",
    );
  }

  const writeResult = standingRuntime.setCharacterStandings(
    targetDescriptor.characterID,
    entries,
    {
      eventTypeID: standingRuntime.EVENT_STANDING_SLASH_SET,
      message: "GM /maxagentstandings",
    },
  );
  if (!writeResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Could not max the agent standings set.",
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Set ${corporationIDs.length} agent corporation standings and ${factionIDs.length} agent faction standings to 10.00 for ${formatCharacterTargetLabel(targetDescriptor)}.`,
  );
}

module.exports = {
  handleSetStandingCommand,
  handleMaxAgentStandingsCommand,
};
