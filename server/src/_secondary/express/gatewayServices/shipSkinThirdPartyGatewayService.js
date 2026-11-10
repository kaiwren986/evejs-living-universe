"use strict";
const { createSkinGatewayService } = require("./shipSkinGatewayHelpers");
const { getShipSkinProtoRoot } = require("./shipSkinGatewayProto");
const { encodePayload, timestampFromMs } = require("./gatewayServiceHelpers");
const runtime = require("../../../services/ship/shipSkinThirdPartyRuntime");
const PREFIX = "eve_public.cosmetic.ship.skin.thirdparty.license.api.";
function licenseAttributes(row) { return { activated: row.activated, unactivated: row.unactivated, escrowed: row.escrowed, first_acquired: timestampFromMs(row.firstAcquiredMs) }; }
function createShipSkinThirdPartyGatewayService(context = {}) {
  const handlers = {};
  for (const action of ["Activate", "Apply", "Unapply"]) handlers[`${PREFIX}${action}Request`] = (request, { characterID, requestID }) => {
    if (Number(request.license?.character?.sequential) !== characterID) return { success: false, statusCode: 403, errorMsg: "SKINR_LICENSE_NOT_OWNED" };
    const hex = request.license?.skin?.hex, previous = runtime.getShipSkinLicense(characterID, hex);
    const result = action === "Activate" ? runtime.activateShipSkinLicense(characterID, hex, requestID)
      : (action === "Apply" ? runtime.applyShipSkinLicense : runtime.unapplyShipSkinLicense)(characterID, hex, Number(request.ship?.sequential), requestID);
    if (action === "Activate" && result.success && !result.duplicate) {
      const type = `${PREFIX}UpdatedNotice`;
      context.publishGatewayNotice?.(type, encodePayload(getShipSkinProtoRoot().lookupType(type), {
        id: request.license, attributes: licenseAttributes(result.license), previous_attributes: licenseAttributes(previous),
      }), { character: characterID });
    }
    return result;
  };
  return createSkinGatewayService("ship-skin-licenses", handlers);
}
module.exports = { createShipSkinThirdPartyGatewayService, licenseAttributes };
