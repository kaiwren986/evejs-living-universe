"use strict";

const { randomUUID } = require("node:crypto");
const drafts = require("../../ship/shipSkinDraftRuntime");
const designFiles = require("../../ship/shipSkinDesignFiles");
const { tokenizeQuotedArguments, normalizeCommandName } = require("./commandArguments");
const { resolveCharacterTargetDescriptor, formatCharacterTargetLabel } = require("./characterTargets");
const { handledResult } = require("./commandReplies");

const USAGE = "Usage: /skinr list [target] | /skinr delete <draft UUID|all> [target] | /skinr export <draft UUID> [target] | /skinr import <filename.skinr.json> [target]";

function transferFailure(result) {
  const reasons = {
    INVALID_SKINR_DESIGN_FILENAME: "Use a .skinr.json filename without a directory path.",
    SKINR_DESIGN_FILE_NOT_FOUND: "File not found.",
    INVALID_SKINR_DESIGN_FILE: "The file is not a valid SKINR design.",
    UNSUPPORTED_SKINR_DESIGN_FILE: "Unsupported SKINR file format or version.",
    SKINR_DESIGN_FILE_TOO_LARGE: "The design file exceeds the 64 KiB limit.",
    SKINR_EXPORT_WRITE_FAILED: "Could not write the design file.",
    SKINR_IMPORT_READ_FAILED: "Could not read the design file.",
    DRAFT_CAPACITY_EXCEEDED: "No free saved-design slots. Use /skinr list or /skinr delete first.",
    DRAFT_NOT_FOUND: "Saved design not found for this character. Use /skinr list to see design UUIDs.",
  };
  return reasons[result.errorMsg] || `Design validation failed: ${result.errorMsg}.`;
}

function normalizeDraftID(value) {
  const text = String(value || "").toLowerCase();
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(text)
    ? text.replace(/-/g, "") : null;
}

function displayDraftID(id) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function handleSkinrCommand(session, argumentText, chatHub, options) {
  const tokens = tokenizeQuotedArguments(argumentText);
  const action = normalizeCommandName(tokens[0] || "list");
  const reply = message => handledResult(chatHub, session, options, message);
  if (!["list", "delete", "export", "import"].includes(action)) return reply(USAGE);
  const selection = normalizeCommandName(tokens[1]);
  const id = ["delete", "export"].includes(action) ? normalizeDraftID(selection) : null;
  if (action === "delete" && selection !== "all" && !id) return reply(USAGE);
  if ((action === "export" && !id) || (action === "import" && !tokens[1])) return reply(USAGE);

  const targetText = tokens.slice(action === "list" ? 1 : 2).join(" ").trim() || "me";
  const target = resolveCharacterTargetDescriptor(session, targetText);
  if (!target.success) {
    return reply(target.errorMsg === "CHARACTER_NOT_SELECTED"
      ? "Select a character before using /skinr."
      : `Character not found: ${targetText}. Use me, a character ID, or an exact character name.`);
  }
  const { characterID } = target.data;
  const label = formatCharacterTargetLabel(target.data);
  if (action === "export") {
    const result = designFiles.exportShipSkinDesign(characterID, id);
    return reply(result.success
      ? `Exported saved SKINR design for ${label} to ${result.filePath}. Share this .skinr.json file.`
      : `SKINR export failed. ${transferFailure(result)}`);
  }
  if (action === "import") {
    const result = designFiles.importShipSkinDesign(characterID, tokens[1], `chat:skinr:import:${randomUUID()}`);
    return reply(result.success
      ? `Imported saved SKINR design ${displayDraftID(result.draft.id)} for ${label}. Relog if the saved-design list is still cached.`
      : `SKINR import failed. ${transferFailure(result)} Import folder: ${designFiles.getShipSkinDesignDirectory()}.`);
  }
  const owned = drafts.getOwnedShipSkinDrafts(characterID).sort((left, right) => left.id.localeCompare(right.id));
  const capacity = drafts.getShipSkinDraftSaveCapacity(characterID);
  if (action === "list") {
    const entries = owned.map(draft => {
      const name = drafts.getShipSkinDesign(draft.hex)?.name || "Unnamed design";
      return `${displayDraftID(draft.id)}: ${name.replace(/[<>]/g, "")}`;
    });
    return reply(`${label} has ${owned.length}/${capacity} saved SKINR designs (${Math.max(0, capacity - owned.length)} free slots).`
      + (entries.length ? ` ${entries.join("; ")}. Use /skinr delete <draft UUID> or /skinr delete all.` : ""));
  }

  const selected = selection === "all" ? owned : owned.filter(draft => draft.id === id);
  if (selection !== "all" && selected.length === 0) {
    return reply(`Saved SKINR design ${displayDraftID(id)} was not found for ${label}. Use /skinr list to see saved design UUIDs.`);
  }
  let deleted = 0;
  for (const draft of selected) {
    const result = drafts.deleteShipSkinDraft(characterID, draft.id, `chat:skinr:delete:${randomUUID()}`);
    if (!result.success) {
      return reply(`Deleted ${deleted} saved SKINR designs for ${label}. Could not delete ${displayDraftID(draft.id)}: ${result.errorMsg}.`);
    }
    deleted += 1;
  }
  const remaining = drafts.getOwnedShipSkinDrafts(characterID).length;
  // The supported client only clears its draft cache after its own DeleteResponse
  // or a character-session change; the public gateway has no draft-change notice.
  return reply(`Deleted ${deleted} saved SKINR design${deleted === 1 ? "" : "s"} for ${label}. `
    + `${remaining}/${capacity} slots used; ${Math.max(0, capacity - remaining)} free.`
    + (deleted ? " Relog if the saved-design list is still cached." : ""));
}

module.exports = { handleSkinrCommand };
