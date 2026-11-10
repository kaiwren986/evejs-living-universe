"use strict";

// Ship skin chat command: /allskins, which grants every skin to a character. Ship emblems are
// a different system and live in ./shipLogos.js.

const path = require("path");

const {
  getAppliedSkinRecordsForOwner,
  grantAllSkinsToCharacter,
  readCatalog,
} = require(path.join(__dirname, "../../ship/shipCosmeticsState"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  resolveCharacterTargetDescriptor,
  formatCharacterTargetLabel,
} = require(path.join(__dirname, "./characterTargets"));

function refreshSkinLicensesForSession(session, characterID) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }

  // The client caches both personal licenses and each open hull's SKIN list.
  // A matching activation clears an open hull's list; unqueried hulls only need
  // the personal cache reset. Limit events because each can reload the visible
  // character sheet's entire SKIN collection.
  const catalog = readCatalog();
  const queries = session._skinLicenseQueries;
  const typeIDs = queries && queries.characterID === characterID
    ? queries.typeIDs
    : [];
  const appliedSkinIDs = new Set(
    getAppliedSkinRecordsForOwner(characterID).map((record) => record.skinID),
  );
  const skinIDs = new Set();
  for (const typeID of typeIDs) {
    const shipType = catalog.shipTypesByTypeID[String(typeID)];
    const candidates = shipType && shipType.skinIDs || [];
    // Activation callbacks clear matching applied fitting previews. If every
    // SKIN for this hull is applied, leave its panel alone and use the global
    // fallback below to refresh the personal cache without clearing the preview.
    const skinID = Number(
      candidates.find((candidate) => !appliedSkinIDs.has(candidate)),
    ) || 0;
    if (skinID > 0) {
      skinIDs.add(skinID);
    }
  }
  if (skinIDs.size === 0) {
    const skin = Object.values(catalog.skinsBySkinID).find(
      (entry) => Number(entry.skinID) > 0 && !appliedSkinIDs.has(entry.skinID),
    );
    if (skin) {
      skinIDs.add(Number(skin.skinID));
    }
  }
  for (const skinID of skinIDs) {
    session.sendNotification("OnSkinLicenseActivated", "charid", [
      skinID,
      characterID,
    ]);
  }
}

function handleAllSkinsCommand(session, argumentText, chatHub, options) {
  const targetToken = String(argumentText || "").trim() || "me";
  const targetResult = resolveCharacterTargetDescriptor(session, targetToken);
  if (!targetResult.success) {
    const message =
      targetResult.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /allskins me."
        : `Character not found: ${targetToken}. Use me, a character ID, or an exact character name.`;
    return handledResult(chatHub, session, options, message);
  }

  const targetDescriptor = targetResult.data;
  const grantResult = grantAllSkinsToCharacter(targetDescriptor.characterID, {
    source: "chatCommands.allskins",
  });
  if (!grantResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Failed to unlock ship SKIN licenses.",
    );
  }

  // Refresh even on a repeat invocation so an already granted character can
  // recover a client list cached before /allskins started sending activations.
  refreshSkinLicensesForSession(
    targetDescriptor.session,
    targetDescriptor.characterID,
  );

  const targetLabel = formatCharacterTargetLabel(targetDescriptor);
  const data = grantResult.data || {};
  return handledResult(
    chatHub,
    session,
    options,
    [
      `Unlocked all ${Number(data.totalSkins || 0).toLocaleString()} ship SKINs for ${targetLabel}.`,
      Number(data.changedCount || 0) > 0
        ? `Updated ${Number(data.changedCount || 0).toLocaleString()} licenses.`
        : "All ship SKINs were already permanently unlocked.",
    ].join(" "),
  );
}

module.exports = {
  handleAllSkinsCommand,
};
