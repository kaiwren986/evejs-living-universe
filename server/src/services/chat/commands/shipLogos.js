"use strict";

// Ship emblem chat commands: /grantshipemblem, /grantcorplogo and /grantalliancelogo, which
// give a ship hull the right to display its owner's corporation or alliance logo, with the mode
// table, the type labels and the hull lookup they use.

const path = require("path");

const {
  getActiveShipRecord,
} = require("../../character/characterState");
const {
  SHIP_LOGO_ENTITLEMENT_CORPORATION,
  SHIP_LOGO_ENTITLEMENT_ALLIANCE,
  COSMETIC_TYPE_ALLIANCE_LOGO,
  COSMETIC_TYPE_CORPORATION_LOGO,
} = require("../../evermarks/evermarksConstants");
const {
  getLicenseByShipAndCosmeticType,
} = require("../../evermarks/evermarksCatalog");
const {
  grantShipLogoEntitlement,
} = require("../../evermarks/evermarksEntitlements");
const {
  publishShipLogoGrantedNotice,
} = require("../../evermarks/evermarksNotices");
const {
  resolveShipByTypeID,
  resolveShipByName,
} = require("../shipTypeRegistry");
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizeCommandName,
  normalizePositiveInteger,
  tokenizeQuotedArguments,
} = require(path.join(__dirname, "./commandArguments"));
const {
  formatSuggestions,
} = require(path.join(__dirname, "./commandSuggestions"));

const SHIP_LOGO_GRANT_MODE_MAP = Object.freeze({
  corp: [SHIP_LOGO_ENTITLEMENT_CORPORATION],
  corporation: [SHIP_LOGO_ENTITLEMENT_CORPORATION],
  corplogo: [SHIP_LOGO_ENTITLEMENT_CORPORATION],
  alliance: [SHIP_LOGO_ENTITLEMENT_ALLIANCE],
  alliancelogo: [SHIP_LOGO_ENTITLEMENT_ALLIANCE],
  both: [
    SHIP_LOGO_ENTITLEMENT_CORPORATION,
    SHIP_LOGO_ENTITLEMENT_ALLIANCE,
  ],
  all: [
    SHIP_LOGO_ENTITLEMENT_CORPORATION,
    SHIP_LOGO_ENTITLEMENT_ALLIANCE,
  ],
});

function getShipLogoGrantTypeLabel(entitlementType) {
  if (entitlementType === SHIP_LOGO_ENTITLEMENT_ALLIANCE) {
    return "alliance";
  }
  return "corporation";
}

function formatShipLogoGrantTypeList(entitlementTypes = []) {
  const labels = [...new Set(entitlementTypes.map(getShipLogoGrantTypeLabel))];
  if (labels.length === 0) {
    return "ship emblem";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function resolveShipLogoGrantTypes(command, tokens) {
  const normalizedCommand = normalizeCommandName(command);
  if (normalizedCommand === "grantcorplogo") {
    return {
      success: true,
      entitlementTypes: [SHIP_LOGO_ENTITLEMENT_CORPORATION],
      remainingTokens: tokens,
    };
  }
  if (normalizedCommand === "grantalliancelogo") {
    return {
      success: true,
      entitlementTypes: [SHIP_LOGO_ENTITLEMENT_ALLIANCE],
      remainingTokens: tokens,
    };
  }

  const modeToken = normalizeCommandName(tokens[0]);
  const entitlementTypes = SHIP_LOGO_GRANT_MODE_MAP[modeToken];
  if (!entitlementTypes) {
    return {
      success: false,
      errorMsg: "MODE_REQUIRED",
    };
  }

  return {
    success: true,
    entitlementTypes,
    remainingTokens: tokens.slice(1),
  };
}

function resolveShipLogoGrantTarget(session, lookupText) {
  const normalizedLookup = String(lookupText || "").trim();
  if (!normalizedLookup || ["active", "current", "me"].includes(normalizeCommandName(normalizedLookup))) {
    if (!session || !session.characterID) {
      return {
        success: false,
        errorMsg: "CHARACTER_NOT_SELECTED",
      };
    }

    const activeShip = getActiveShipRecord(session.characterID);
    const shipTypeID = normalizePositiveInteger(activeShip && activeShip.typeID);
    if (!shipTypeID) {
      return {
        success: false,
        errorMsg: "ACTIVE_SHIP_REQUIRED",
      };
    }

    const shipType = resolveShipByTypeID(shipTypeID);
    return {
      success: true,
      data: {
        shipTypeID,
        shipLabel:
          (shipType && shipType.name) ||
          String(activeShip.itemName || `typeID ${shipTypeID}`),
      },
    };
  }

  const numericTypeID = normalizePositiveInteger(normalizedLookup);
  if (numericTypeID) {
    const shipType = resolveShipByTypeID(numericTypeID);
    return {
      success: true,
      data: {
        shipTypeID: numericTypeID,
        shipLabel: (shipType && shipType.name) || `typeID ${numericTypeID}`,
      },
    };
  }

  const shipLookup = resolveShipByName(normalizedLookup);
  if (!shipLookup.success || !shipLookup.match) {
    return {
      success: false,
      errorMsg: shipLookup.errorMsg || "SHIP_NOT_FOUND",
      lookupText: normalizedLookup,
      suggestions: shipLookup.suggestions || [],
    };
  }

  return {
    success: true,
    data: {
      shipTypeID: shipLookup.match.typeID,
      shipLabel: shipLookup.match.name,
    },
  };
}

function handleGrantShipLogoCommand(command, session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before granting ship emblem licenses.",
    );
  }

  const usage =
    command === "grantshipemblem"
      ? "Usage: /grantshipemblem <corp|alliance|both> [current|ship name|typeID]"
      : `Usage: /${command} [current|ship name|typeID]`;

  const tokens = tokenizeQuotedArguments(argumentText);
  const modeResult = resolveShipLogoGrantTypes(command, tokens);
  if (!modeResult.success) {
    return handledResult(chatHub, session, options, usage);
  }

  const targetResult = resolveShipLogoGrantTarget(
    session,
    modeResult.remainingTokens.join(" "),
  );
  if (!targetResult.success) {
    if (targetResult.errorMsg === "ACTIVE_SHIP_REQUIRED") {
      return handledResult(
        chatHub,
        session,
        options,
        "No active ship was found. Pass a ship name or typeID, or board a ship first.",
      );
    }
    if (targetResult.errorMsg === "SHIP_NOT_FOUND") {
      return handledResult(
        chatHub,
        session,
        options,
        `Ship type not found: ${targetResult.lookupText}.${formatSuggestions(targetResult.suggestions)}`.trim(),
      );
    }
    if (targetResult.errorMsg === "AMBIGUOUS_SHIP_NAME") {
      return handledResult(
        chatHub,
        session,
        options,
        `Ship type is ambiguous: ${targetResult.lookupText}.${formatSuggestions(targetResult.suggestions)}`.trim(),
      );
    }
    return handledResult(chatHub, session, options, "Ship emblem license grant failed.");
  }

  const shipTypeID = targetResult.data.shipTypeID;
  const shipLabel = targetResult.data.shipLabel;
  const requestedEntitlementTypes = modeResult.entitlementTypes;
  const licenseEntries = requestedEntitlementTypes.map((entitlementType) => ({
    entitlementType,
    license: getLicenseByShipAndCosmeticType(
      shipTypeID,
      entitlementType === SHIP_LOGO_ENTITLEMENT_ALLIANCE
        ? COSMETIC_TYPE_ALLIANCE_LOGO
        : COSMETIC_TYPE_CORPORATION_LOGO,
    ),
  }));

  const missingLicenseEntry = licenseEntries.find((entry) => !entry.license);
  if (missingLicenseEntry) {
    return handledResult(
      chatHub,
      session,
      options,
      `No cached ${getShipLogoGrantTypeLabel(missingLicenseEntry.entitlementType)} emblem license exists for ${shipLabel} (shipTypeID=${shipTypeID}).`,
    );
  }

  const grantedEntries = [];
  const alreadyOwnedEntries = [];
  for (const entry of licenseEntries) {
    const grantResult = grantShipLogoEntitlement(
      session.characterID,
      shipTypeID,
      entry.entitlementType,
      {
        source: "admin_grant",
      },
    );
    if (!grantResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "Ship emblem license grant failed.",
      );
    }

    if (grantResult.alreadyOwned) {
      alreadyOwnedEntries.push(entry);
      continue;
    }

    publishShipLogoGrantedNotice(grantResult.data);
    grantedEntries.push(entry);
  }

  const renderLicenseIDList = (entries) =>
    entries.map((entry) => entry.license.fsdTypeID).join(", ");
  const requestedLabel = formatShipLogoGrantTypeList(requestedEntitlementTypes);
  if (grantedEntries.length === 0) {
    const requestedPlural = requestedEntitlementTypes.length === 1 ? "is" : "are";
    return handledResult(
      chatHub,
      session,
      options,
      `${requestedLabel.charAt(0).toUpperCase()}${requestedLabel.slice(1)} emblem license${requestedEntitlementTypes.length === 1 ? "" : "s"} for ${shipLabel} ${requestedPlural} already owned.`,
    );
  }

  let message = `Granted ${formatShipLogoGrantTypeList(grantedEntries.map((entry) => entry.entitlementType))} emblem license${grantedEntries.length === 1 ? "" : "s"} for ${shipLabel} (shipTypeID=${shipTypeID}; licenseTypeID${grantedEntries.length === 1 ? "" : "s"}=${renderLicenseIDList(grantedEntries)}).`;
  if (alreadyOwnedEntries.length > 0) {
    message += ` Already owned: ${formatShipLogoGrantTypeList(alreadyOwnedEntries.map((entry) => entry.entitlementType))}.`;
  }

  return handledResult(chatHub, session, options, message);
}

module.exports = {
  handleGrantShipLogoCommand,
};
