"use strict";

const { createSkinGatewayService } = require("./shipSkinGatewayHelpers");
const runtime = require("../../../services/ship/shipSkinDraftRuntime");
const { timestampFromMs } = require("./gatewayServiceHelpers");
const PREFIX = "eve_public.cosmetic.ship.skin.thirdparty.";
function attributes(draft) { return { skin: { hex: draft.hex }, editor_configurations: draft.editorConfigurations }; }
function designAttributes(design) {
  const first = design.firstSequencedMs || require("../../../services/ship/shipSkinSequencingRuntime").getFirstSequencedMs(require("../../../services/ship/shipSkinState").fingerprint(design));
  return { name: design.name, line_name: design.lineName, creator: { sequential: design.characterID },
    layout: design.layout, tier: { level: design.tier }, ...(first ? { first_sequenced: timestampFromMs(first) } : { not_sequenced: true }) };
}
function createShipSkinDraftGatewayService() {
  const handlers = {};
  handlers[`${PREFIX}draft.api.GetSaveCapacityRequest`] = (_request, { characterID }) => ({ payload: { capacity: runtime.getShipSkinDraftSaveCapacity(characterID) } });
  handlers[`${PREFIX}draft.api.GetAllSavedRequest`] = (_request, { characterID }) => ({ payload: { drafts: runtime.getOwnedShipSkinDrafts(characterID).map(draft => ({ id: { uuid: Buffer.from(draft.id, "hex") }, attributes: attributes(draft) })) } });
  for (const shared of [false, true]) handlers[`${PREFIX}draft.api.${shared ? "GetShared" : "Get"}Request`] = (request, { characterID }) => {
    // Shared links deliberately carry the author's ID and an unguessable draft UUID.
    const actor = shared ? Number(request.character?.sequential) : characterID;
    const draft = runtime.getShipSkinDraft(actor, runtime.uuid(request.draft?.uuid));
    return draft ? { payload: { draft: attributes(draft) } } : { success: false, statusCode: 404, errorMsg: "DRAFT_NOT_FOUND" };
  };
  for (const action of ["Save", "Update", "Delete"]) handlers[`${PREFIX}draft.api.${action}Request`] = (request, { characterID, requestID }) => {
    const id = runtime.uuid(request.id?.uuid);
    const result = action === "Save" ? runtime.saveShipSkinDraft(characterID, request, requestID)
      : action === "Update" ? runtime.updateShipSkinDraft(characterID, id, request, requestID) : runtime.deleteShipSkinDraft(characterID, id, requestID);
    return result.success ? { payload: result.draft ? { id: { uuid: Buffer.from(result.draft.id, "hex") }, attributes: attributes(result.draft) } : {} } : result;
  };
  handlers[`${PREFIX}api.GetRequest`] = request => {
    const design = runtime.getShipSkinDesign(request.skin?.hex);
    return design ? { payload: { skin: designAttributes(design) } } : { success: false, statusCode: 404, errorMsg: "SKIN_DESIGN_NOT_FOUND" };
  };
  return createSkinGatewayService("ship-skin-drafts", handlers);
}
module.exports = { createShipSkinDraftGatewayService, designAttributes };
