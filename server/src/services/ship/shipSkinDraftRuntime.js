"use strict";

const { randomBytes } = require("node:crypto");
const state = require("./shipSkinState");
const config = require("../../config");
const { validateDesign } = require("./shipSkinDesignValidation");
const { getCumulativeSkillPolicyValue } = require("./shipSkinSequencingAuthority");
const { getCharacterSkillMap } = require("../skills/skillState");
const TABLE_NAME = "shipSkinDraftRuntime";
const DESIGN_ITERATION_SKILL_TYPE_ID = 81371;
function root() { return { version: 1, drafts: {}, designs: {}, requests: {}, ...state.read(TABLE_NAME) }; }
function uuid(value) {
  const bytes = Buffer.from(value || []);
  return bytes.length === 16 && bytes.some(Boolean) ? bytes.toString("hex") : null;
}
function getShipSkinDraftSaveCapacity(characterID) {
  const skills = getCharacterSkillMap(characterID);
  return Math.floor(getCumulativeSkillPolicyValue("maxSavedDesigns", id => skills.get(id)?.effectiveSkillLevel || 0, {
    [DESIGN_ITERATION_SKILL_TYPE_ID]: config.skinrDesignIterationMultiplier,
  }));
}
function getOwnedShipSkinDrafts(characterID) { return Object.values(root().drafts).filter(draft => draft.characterID === characterID); }
function getShipSkinDraft(characterID, id) {
  const record = root().drafts[id];
  return record?.characterID === characterID ? record : null;
}
function getShipSkinDesign(hex) {
  return /^[a-f0-9]{64}$/.test(hex || "") ? require("./shipSkinStoreAuthority").getShipSkinStoreDesign(hex)
    || require("./shipSkinThirdPartyRuntime").getImportedShipSkinStoreDesign(hex) || root().designs[hex] || null : null;
}
function getShipSkinDesignShipTypes(hexes) {
  const unique = [...new Set(hexes)].filter(hex => /^[a-f0-9]{64}$/.test(hex || ""));
  const store = require("./shipSkinStoreAuthority");
  const shipTypes = store.getShipSkinStoreShipTypes(unique);
  const missing = unique.filter(hex => !shipTypes.has(hex));
  if (missing.length) {
    const imported = require("./shipSkinThirdPartyRuntime").getImportedShipSkinStoreDesigns(missing);
    for (const hex of missing) {
      const design = imported[hex] || state.readPath(TABLE_NAME, `/designs/${hex}`);
      if (design) shipTypes.set(hex, Number(design.layout?.ship_type?.sequential));
    }
  }
  return shipTypes;
}
function retainShipSkinDesign(design) {
  const next = root(), hex = state.fingerprint(design);
  if (!next.designs[hex]) { next.designs[hex] = state.cloneValue(design); state.write(TABLE_NAME, next); }
  return hex;
}
function mutate(characterID, action, id, request, requestID) {
  if (!state.positive(characterID) || !state.requestKey(requestID)) return state.fail("INVALID_DRAFT_REQUEST", 400);
  if (action !== "save" && !/^[a-f0-9]{32}$/.test(id || "")) return state.fail("INVALID_DRAFT_ID", 400);
  const fingerprint = state.fingerprint([action, id, request.name, request.line_name, request.layout, request.editor_configurations]);
  const key = `${characterID}:${requestID}`;
  const next = root();
  const prior = next.requests[key];
  if (prior) {
    let matches = prior.fingerprint === fingerprint;
    // Initial draft receipts used the derived design hash. Retain their
    // replay contract across policy updates by using their original tier.
    if (!matches && !prior.requestVersion) {
      const original = next.designs[prior.result.draft?.hex];
      const candidate = action === "delete" ? { success: true } : validateDesign(characterID, request);
      if (candidate.success && candidate.design && original) { candidate.design.tier = original.tier; candidate.hex = state.fingerprint(candidate.design); }
      matches = candidate.success && prior.fingerprint === state.fingerprint([action, id, candidate.hex, candidate.editorConfigurations]);
    }
    return matches ? { success: true, ...prior.result, duplicate: true } : state.fail("SKINR_REQUEST_CONFLICT");
  }
  const validated = action === "delete" ? { success: true } : validateDesign(characterID, request);
  if (!validated.success) return validated;
  if (action === "save" && getOwnedShipSkinDrafts(characterID).length >= getShipSkinDraftSaveCapacity(characterID)) return state.fail("DRAFT_CAPACITY_EXCEEDED", 403);
  if (action !== "save" && next.drafts[id]?.characterID !== characterID) return state.fail("DRAFT_NOT_FOUND", 404);
  let result;
  if (action === "delete") {
    delete next.drafts[id];
    result = { id };
  } else {
    id ||= randomBytes(16).toString("hex");
    next.designs[validated.hex] ||= validated.design;
    const draft = { id, characterID, hex: validated.hex, editorConfigurations: validated.editorConfigurations,
      revision: (next.drafts[id]?.revision || 0) + 1 };
    next.drafts[id] = draft;
    result = { draft };
  }
  next.requests[key] = { requestVersion: 2, fingerprint, result };
  state.write(TABLE_NAME, next);
  return { success: true, ...state.cloneValue(result) };
}
module.exports = { TABLE_NAME, uuid, getShipSkinDraftSaveCapacity, getOwnedShipSkinDrafts, getShipSkinDraft, getShipSkinDesign, getShipSkinDesignShipTypes, retainShipSkinDesign,
  saveShipSkinDraft: (actor, request, key) => mutate(actor, "save", null, request, key),
  updateShipSkinDraft: (actor, id, request, key) => mutate(actor, "update", id, request, key),
  deleteShipSkinDraft: (actor, id, key) => mutate(actor, "delete", id, {}, key), validateDesign };
