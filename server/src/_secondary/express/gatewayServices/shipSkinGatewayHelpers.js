"use strict";

const { getShipSkinProtoRoot } = require("./shipSkinGatewayProto");
const { getActiveCharacterID, bufferFromBytes, encodePayload } = require("./gatewayServiceHelpers");
const { getCharacterRecord } = require("../../../services/character/characterState");

function createSkinGatewayService(name, handlers) {
  const root = getShipSkinProtoRoot();
  const responses = Object.fromEntries(Object.keys(handlers).map(request => [request, request.replace(/Request$/, "Response")]));
  return {
    name, handledRequestTypes: Object.keys(handlers),
    // The outer gateway uses this hook to turn handler exceptions into empty
    // 200s. A failed economic mutation must remain a failure.
    getEmptySuccessResponseType: () => null,
    handleRequest(request, envelope) {
      if (!handlers[request]) return null;
      const responseTypeName = responses[request];
      const response = (result = {}) => ({ statusCode: result.success === false ? result.statusCode || 409 : 200,
        statusMessage: result.errorMsg || "", responseTypeName,
        responsePayloadBuffer: encodePayload(root.lookupType(responseTypeName), result.payload || {}) });
      const characterID = getActiveCharacterID(envelope);
      if (!Number.isSafeInteger(characterID) || !getCharacterRecord(characterID)) return response({ success: false, statusCode: 401, errorMsg: "CHARACTER_REQUIRED" });
      let decoded;
      try { decoded = root.lookupType(request).decode(bufferFromBytes(envelope?.payload?.value)); }
      catch (_error) { return response({ success: false, statusCode: 400, errorMsg: "MALFORMED_REQUEST" }); }
      const bytes = bufferFromBytes(envelope?.correlation_uuid);
      const requestID = bytes.length === 16 && bytes.some(value => value !== 0) ? bytes.toString("hex") : null;
      const result = handlers[request](decoded, { characterID, requestID, envelope });
      return result && typeof result.then === "function" ? result.then(response) : response(result);
    },
  };
}
module.exports = { createSkinGatewayService };
