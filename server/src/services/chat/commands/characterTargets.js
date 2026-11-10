"use strict";

// Chat command character targets: resolving "me", a character ID or a character name to the
// character a command acts on, and labelling it in replies.

const path = require("path");

const {
  getCharacterRecord,
} = require("../../character/characterState");
const sessionRegistry = require("../sessionRegistry");
const database = require("../../../gameStore");
const {
  normalizeCommandName,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commandArguments"));

function readCharacterTable() {
  const result = database.read("characters", "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }

  return result.data;
}

function resolveCharacterTargetDescriptor(requestSession, targetToken) {
  const normalizedToken = String(targetToken || "").trim();
  if (!normalizedToken) {
    return {
      success: false,
      errorMsg: "TARGET_REQUIRED",
    };
  }

  if (normalizeCommandName(normalizedToken) === "me") {
    const characterID = normalizePositiveInteger(
      requestSession && requestSession.characterID,
    );
    if (!characterID) {
      return {
        success: false,
        errorMsg: "CHARACTER_NOT_SELECTED",
      };
    }

    const record = getCharacterRecord(characterID);
    if (!record) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }

    return {
      success: true,
      data: {
        characterID,
        record,
        session:
          sessionRegistry.findSessionByCharacterID(characterID) || requestSession || null,
      },
    };
  }

  const numericTargetID = normalizePositiveInteger(normalizedToken);
  if (numericTargetID) {
    const record = getCharacterRecord(numericTargetID);
    if (!record) {
      return {
        success: false,
        errorMsg: "TARGET_NOT_FOUND",
      };
    }

    return {
      success: true,
      data: {
        characterID: numericTargetID,
        record,
        session: sessionRegistry.findSessionByCharacterID(numericTargetID),
      },
    };
  }

  const normalizedName = normalizeCommandName(normalizedToken);
  const characters = readCharacterTable();
  const matchEntry = Object.entries(characters).find(([, record]) => (
    normalizeCommandName(record && record.characterName) === normalizedName
  ));

  if (!matchEntry) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  const characterID = normalizePositiveInteger(matchEntry[0]);
  const record = characterID ? getCharacterRecord(characterID) : null;
  if (!characterID || !record) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  return {
    success: true,
    data: {
      characterID,
      record,
      session: sessionRegistry.findSessionByCharacterID(characterID),
    },
  };
}

function formatCharacterTargetLabel(targetDescriptor) {
  if (!targetDescriptor) {
    return "character";
  }

  const characterID = normalizePositiveInteger(targetDescriptor.characterID);
  const name =
    (targetDescriptor.record && targetDescriptor.record.characterName) ||
    (targetDescriptor.session && targetDescriptor.session.characterName) ||
    null;
  if (name && characterID) {
    return `${name}(${characterID})`;
  }
  if (name) {
    return name;
  }
  if (characterID) {
    return `character ${characterID}`;
  }
  return "character";
}

module.exports = {
  readCharacterTable,
  resolveCharacterTargetDescriptor,
  formatCharacterTargetLabel,
};
