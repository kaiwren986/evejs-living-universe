"use strict";

const { randomUUID } = require("node:crypto");
const drafts = require("../../ship/shipSkinDraftRuntime");
const designFiles = require("../../ship/shipSkinDesignFiles");
const licenses = require("../../ship/shipSkinThirdPartyRuntime");
const publicGatewayNotices = require("../../../_secondary/express/publicGatewayNotices");
const { getShipSkinProtoRoot } = require("../../../_secondary/express/gatewayServices/shipSkinGatewayProto");
const { encodePayload } = require("../../../_secondary/express/gatewayServices/gatewayServiceHelpers");
const { tokenizeQuotedArguments, normalizeCommandName } = require("./commandArguments");
const { resolveCharacterTargetDescriptor, formatCharacterTargetLabel } = require("./characterTargets");
const { handledResult } = require("./commandReplies");
const { hasStaffAccountRole } = require("../../account/accountRoleProfiles");
const { hasStaffDebugRole } = require("./commandAccess");
const { formatStorePrice } = require("../../ship/shipSkinStoreTerms");

const STORE_USAGE = "Usage: /skinr store import <filename.skinr.json> [price [ISK|PLEX] [quantity]]; omit price to use joined listing details.";
const USAGE = "Usage: /skinr skins [target] | /skinr delete <SKIN hash> [target] | /skinr delete confirm all [target] | /skinr list [target] | /skinr export <draft UUID> [target] | /skinr import <filename.skinr.json> [target] | /skinr store import <filename.skinr.json> [price [ISK|PLEX] [quantity]]; omit price to use joined listing details.";

function transferFailure(result) {
  const reasons = {
    INVALID_SKINR_DESIGN_FILENAME: "Use a .skinr.json filename without a directory path.",
    SKINR_DESIGN_FILE_NOT_FOUND: "File not found.",
    INVALID_SKINR_DESIGN_FILE: "The file is not a valid SKINR design.",
    UNSUPPORTED_SKINR_DESIGN_FILE: "Unsupported SKINR file format or version.",
    SKINR_DESIGN_FILE_TOO_LARGE: "The design file exceeds the 64 KiB limit.",
    SKINR_EXPORT_WRITE_FAILED: "Could not write the design file.",
    SKINR_IMPORT_READ_FAILED: "Could not read the design file.",
    DRAFT_CAPACITY_EXCEEDED: "No free saved-design slots. Delete an unwanted saved design in the Studio UI first.",
    DRAFT_NOT_FOUND: "Saved design not found for this character. Use /skinr list to see design UUIDs.",
    SKINR_STORE_IMPORT_CONFLICT: "This source listing or recipe already has a store listing with different terms. Its stock and price were preserved.",
    INVALID_LISTING_PRICE_OR_QUANTITY: "Use a supported positive price and quantity; PLEX requires whole units and ISK supports two decimal places.",
    SKINR_STORE_TERMS_REQUIRED: "Supply a price, or use a joined listing file containing price, currency and quantity.",
    INVALID_SKINR_SOURCE_LISTING: "The joined file has invalid source listing details.",
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

function deleteSkins(characterID, selection, label, options) {
  const result = licenses.deleteShipSkinLicenses(characterID, selection, `chat:skinr:delete:${randomUUID()}`);
  const gateway = publicGatewayNotices.getPublicGateway();
  for (const shipID of result.clearedShips || []) gateway?.publishShipStateSetNotice?.(shipID, characterID);
  if (!result.success) {
    const reasons = {
      SKINR_LICENSE_NOT_FOUND: "Finished SKIN not found for this character. Use /skinr skins to see SKIN hashes.",
      SKINR_LICENSE_MARKET_BUSY: "Cancel its marketplace listings and wait for pending transactions to finish, then try again. No licenses were deleted.",
      SKINR_LICENSE_UNAPPLY_FAILED: "Could not clear an applied SKIN. No licenses were deleted; try again.",
      SKINR_LICENSE_STORE_FAILED: "Applied SKINs were cleared, but no licenses were deleted; try again.",
    };
    return `SKINR deletion failed. ${reasons[result.errorMsg] || result.errorMsg}`;
  }
  const publisher = options?.publishGatewayNotice || gateway?.publishGatewayNotice;
  if (typeof publisher === "function") {
    const type = "eve_public.cosmetic.ship.skin.thirdparty.license.api.DeletedNotice";
    for (const hex of result.deleted) publisher(type, encodePayload(getShipSkinProtoRoot().lookupType(type), {
      id: { character: { sequential: characterID }, skin: { hex } },
    }), { character: characterID });
  }
  return `Deleted ${result.deleted.length} finished SKINR design license${result.deleted.length === 1 ? "" : "s"} for ${label}, including all activated and unactivated copies. Studio saved designs are preserved.`;
}

function handleSkinrCommand(session, argumentText, chatHub, options) {
  const tokens = tokenizeQuotedArguments(argumentText);
  const action = normalizeCommandName(tokens[0] || "list");
  const reply = message => handledResult(chatHub, session, options, message);
  if (action === "import" && !hasStaffDebugRole(session)) return reply("SKINR import requires a staff/admin role.");
  if (action === "store") {
    if (!hasStaffDebugRole(session)) return reply("SKINR store import requires a staff/admin role.");
    if (normalizeCommandName(tokens[1]) !== "import" || !tokens[2] || tokens.length > 6) return reply(STORE_USAGE);
    let terms;
    if (tokens[3] !== undefined) {
      const currency = String(tokens[4] || "PLEX").toUpperCase();
      const priceText = tokens[3], quantityText = tokens[5] || "1";
      if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(priceText) || !/^\d+$/.test(quantityText) ||
          !["ISK", "PLEX"].includes(currency) || currency === "PLEX" && priceText.includes(".")) return reply(STORE_USAGE);
      const [whole, fraction = ""] = priceText.split(".");
      const price = currency === "ISK" ? Number(whole) * 100 + Number(fraction.padEnd(2, "0")) : Number(whole);
      terms = { price, currency, quantity: Number(quantityText) };
    }
    const result = designFiles.importShipSkinStoreDesign(tokens[2], terms);
    return reply(result.success
      ? `${result.duplicate ? "Already imported" : "Imported"} Paragon store SKINR listing ${result.listing.id}: ${result.listing.remaining} remaining at ${formatStorePrice(result.listing.price, result.listing.currency)} ${result.listing.currency} each. Refresh the Paragon HUB listings to see it.`
      : `SKINR store import failed. ${transferFailure(result)} Import folder: ${designFiles.getShipSkinDesignDirectory()}.`);
  }
  if (!["list", "export", "import", "skins", "delete"].includes(action)) return reply(USAGE);
  const selection = normalizeCommandName(tokens[1]);
  const id = action === "export" ? normalizeDraftID(selection) : null;
  // `delete all <anything>` was once a working form and only ever prompts now, so no
  // old command or character name can act as the confirmation.
  const confirmedAll = action === "delete" && selection === "confirm" && normalizeCommandName(tokens[2]) === "all";
  if (action === "delete" && selection !== "all" && !confirmedAll && !/^[a-f0-9]{64}$/.test(selection)) {
    return reply("Usage: /skinr delete <SKIN hash> [target] or /skinr delete confirm all [target]. Use a 64-character hash from /skinr skins, not a Studio draft UUID.");
  }
  if ((action === "export" && !id) || (action === "import" && !tokens[1])) return reply(USAGE);

  const targetText = tokens.slice(["list", "skins"].includes(action) ? 1 : confirmedAll ? 3 : 2).join(" ").trim() || "me";
  const target = resolveCharacterTargetDescriptor(session, targetText);
  if (!target.success) {
    return reply(target.errorMsg === "CHARACTER_NOT_SELECTED"
      ? "Select a character before using /skinr."
      : `Character not found: ${targetText}. Use me, a character ID, or an exact character name.`
        + (selection === "all" ? " Nothing was deleted. To delete everything, use /skinr delete confirm all [target]." : ""));
  }
  const { characterID } = target.data;
  const label = formatCharacterTargetLabel(target.data);
  if (action === "skins") {
    const owned = licenses.getOwnedShipSkinLicenses(characterID).sort((left, right) => left.hex.localeCompare(right.hex));
    const entries = owned.map(row => `${row.hex}: ${(drafts.getShipSkinDesign(row.hex)?.name || "Unnamed SKIN").replace(/[<>]/g, "")} `
      + `(activated: ${row.activated ? "yes" : "no"}, unactivated: ${row.unactivated}, listed: ${row.escrowed})`);
    return reply(`${label} has ${owned.length} finished SKINR design license${owned.length === 1 ? "" : "s"}.`
      + (entries.length ? ` ${entries.join("; ")}. Use /skinr delete <SKIN hash> or /skinr delete confirm all. Studio saved designs are preserved.` : ""));
  }
  if (action === "delete") {
    // Deletion is permanent, and the slash service itself checks no role.
    if (characterID !== Number(session?.characterID) && !hasStaffAccountRole(session)) {
      return reply("Only staff can delete another character's SKINR licenses. No licenses were deleted.");
    }
    if (selection === "all" && !confirmedAll) {
      const count = licenses.getOwnedShipSkinLicenses(characterID).length;
      return reply(`This permanently deletes all ${count} finished SKINR design license${count === 1 ? "" : "s"} for ${label}, with no refund. `
        + `Nothing was deleted. To go ahead, run /skinr delete confirm all${targetText === "me" ? "" : ` ${targetText}`}.`);
    }
    return reply(deleteSkins(characterID, confirmedAll ? "all" : selection, label, options));
  }
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
  const entries = owned.map(draft => {
    const name = drafts.getShipSkinDesign(draft.hex)?.name || "Unnamed design";
    return `${displayDraftID(draft.id)}: ${name.replace(/[<>]/g, "")}`;
  });
  return reply(`${label} has ${owned.length}/${capacity} saved SKINR designs (${Math.max(0, capacity - owned.length)} free slots).`
    + (entries.length ? ` ${entries.join("; ")}.` : "")
    + " Edit or delete saved designs in the Studio UI.");
}

module.exports = { handleSkinrCommand };
