"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { resolveDataRootPath } = require("../../config/dataRoot");
const drafts = require("./shipSkinDraftRuntime");
const { fail } = require("./shipSkinState");

const FORMAT = "eveoffline.skinr-design";
const VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024;
function getShipSkinDesignDirectory() { return resolveDataRootPath("skinr", "designs"); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requestFromValidated(validated) {
  return { name: validated.design.name, line_name: validated.design.lineName,
    layout: validated.design.layout, editor_configurations: validated.editorConfigurations };
}
function validateDocument(characterID, document) {
  if (!record(document) || document.format !== FORMAT || document.version !== VERSION) return fail("UNSUPPORTED_SKINR_DESIGN_FILE", 400);
  const request = document.design;
  if (!record(request) || typeof request.name !== "string" || typeof request.line_name !== "string" ||
      !record(request.layout) || !Array.isArray(request.editor_configurations) || request.editor_configurations.length > 8) return fail("INVALID_SKINR_DESIGN_FILE", 400);
  try {
    // Rebuild from validated fields so imported ownership, hashes, tier, receipts
    // and other extra fields can never enter the saved draft or its identity.
    const validated = drafts.validateDesign(characterID, request);
    return validated.success ? { success: true, request: requestFromValidated(validated) } : validated;
  } catch (_error) { return fail("INVALID_SKINR_DESIGN_FILE", 400); }
}
function validFilename(filename) {
  return typeof filename === "string" && filename.length <= 128 && filename.length > 11 &&
    /\.skinr\.json$/i.test(filename) && path.basename(filename) === filename &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(filename) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename);
}
function exportShipSkinDesign(characterID, draftID) {
  const draft = drafts.getShipSkinDraft(characterID, draftID);
  if (!draft) return fail("DRAFT_NOT_FOUND", 404);
  const design = drafts.getShipSkinDesign(draft.hex);
  if (!design) return fail("SKIN_DESIGN_NOT_FOUND", 404);
  const validated = validateDocument(characterID, { format: FORMAT, version: VERSION, design: {
    name: design.name, line_name: design.lineName, layout: design.layout, editor_configurations: draft.editorConfigurations,
  } });
  if (!validated.success) return validated;
  const content = JSON.stringify({ format: FORMAT, version: VERSION, design: validated.request }, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return fail("SKINR_DESIGN_FILE_TOO_LARGE", 400);
  const directory = getShipSkinDesignDirectory();
  // A fresh name and exclusive creation preserve earlier exports and user files.
  const filename = `${draftID}-${randomUUID()}.skinr.json`;
  const filePath = path.join(directory, filename);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (_error) { return fail("SKINR_EXPORT_WRITE_FAILED"); }
  return { success: true, filename, filePath };
}
function readDocument(filename) {
  if (!validFilename(filename)) return fail("INVALID_SKINR_DESIGN_FILENAME", 400);
  const directory = getShipSkinDesignDirectory();
  const filePath = path.join(directory, filename);
  let fd;
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.lstatSync(filePath).isFile()) return fail("INVALID_SKINR_DESIGN_FILE", 400);
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return fail("INVALID_SKINR_DESIGN_FILE", 400);
    if (info.size > MAX_FILE_BYTES) return fail("SKINR_DESIGN_FILE_TOO_LARGE", 400);
    // Bound the read even if a different process grows the file after fstat.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > MAX_FILE_BYTES) return fail("SKINR_DESIGN_FILE_TOO_LARGE", 400);
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      return { success: true, document: JSON.parse(content) };
    } catch (_error) { return fail("INVALID_SKINR_DESIGN_FILE", 400); }
  } catch (error) {
    return fail(error.code === "ENOENT" ? "SKINR_DESIGN_FILE_NOT_FOUND" : "SKINR_IMPORT_READ_FAILED", 400);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function importShipSkinDesign(characterID, filename, requestID) {
  const input = readDocument(filename);
  if (!input.success) return input;
  const validated = validateDocument(characterID, input.document);
  if (!validated.success) return validated;
  return drafts.saveShipSkinDraft(characterID, validated.request, requestID);
}

function prepareShipSkinStoreFile(filename, terms) {
  const input = readDocument(filename);
  if (!input.success) return input;
  const sellerID = require("./shipSkinStoreAuthority").getShipSkinStoreSellerID();
  const validated = validateDocument(sellerID, input.document);
  if (!validated.success) return validated;
  if (terms === undefined || input.document.store !== undefined) {
    const stored = require("./shipSkinStoreTerms").termsFromStoreDocument(input.document.store);
    if (!stored.success) return stored;
    terms = { ...stored.terms, ...terms };
  }
  return { success: true, request: validated.request, terms };
}
function importShipSkinStoreDesign(filename, terms) {
  const prepared = prepareShipSkinStoreFile(filename, terms);
  return prepared.success ? require("./shipSkinThirdPartyRuntime").importShipSkinStoreDesign(prepared.request, prepared.terms) : prepared;
}
function importShipSkinStoreFiles(filenames) {
  if (!Array.isArray(filenames) || !filenames.length || filenames.length > 10000) return fail("INVALID_SKINR_STORE_BATCH", 400);
  const entries = [];
  for (const [index, filename] of filenames.entries()) {
    const prepared = prepareShipSkinStoreFile(filename);
    if (!prepared.success) return { ...prepared, index, filename };
    entries.push(prepared);
  }
  return require("./shipSkinThirdPartyRuntime").importShipSkinStoreDesigns(entries);
}
module.exports = { MAX_FILE_BYTES, getShipSkinDesignDirectory, exportShipSkinDesign, importShipSkinDesign, importShipSkinStoreDesign, importShipSkinStoreFiles };
