"use strict";

const { createSkinGatewayService } = require("./shipSkinGatewayHelpers");
const { getShipSkinProtoRoot } = require("./shipSkinGatewayProto");
const { timestampFromMs, encodePayload } = require("./gatewayServiceHelpers");
const authority = require("../../../services/ship/shipSkinComponentAuthority");
const runtime = require("../../../services/ship/shipSkinComponentRuntime");
const { notifyInventoryChangesToCharacter } = require("../../../services/raffles/raffleInventory");
const PREFIX = "eve_public.cosmetic.ship.skin.thirdparty.component.license.";
function identifier(record) {
  return { character: { sequential: record.characterID }, component: authority.buildComponentIdentifier(record.componentID) };
}
function createShipSkinComponentLicenseGatewayService(context = {}) {
  const handlers = {};
  handlers[`${PREFIX}api.GetOwnedRequest`] = (_request, { characterID }) => {
    const owned = runtime.getOwnedShipSkinComponentLicenses(characterID);
    return { payload: { finite: owned.finite.map(identifier), infinite: owned.infinite.map(identifier) } };
  };
  for (const kind of ["finite", "infinite"]) {
    handlers[`${PREFIX}${kind}.api.GetRequest`] = (request, { characterID }) => {
      if (Number(request.license?.character?.sequential) !== characterID) return { success: false, statusCode: 403, errorMsg: "SKINR_LICENSE_NOT_OWNED" };
      const component = authority.resolveComponentIdentifier(request.license?.component);
      const record = component && (kind === "finite" ? runtime.getFiniteShipSkinComponentLicense : runtime.getInfiniteShipSkinComponentLicense)(characterID, component.componentID);
      return record && (kind !== "finite" || record.capacity > 0)
        ? { payload: { license: { first_acquired: timestampFromMs(record.firstAcquiredMs), ...(kind === "finite" ? { capacity: record.capacity } : {}) } } }
        : { success: false, statusCode: 404, errorMsg: "SKINR_LICENSE_NOT_FOUND" };
    };
  }
  handlers[`${PREFIX}item.api.ConsumeRequest`] = (request, { characterID, requestID }) => {
    const result = runtime.consumeShipSkinComponentItem(characterID, Number(request.item?.item?.sequential), Number(request.quantity), requestID);
    if (result.success && !result.duplicate) {
      (context.notifyInventoryChangesToCharacter || notifyInventoryChangesToCharacter)(characterID, result.inventoryChanges);
      const notice = `${PREFIX}api.GrantedNotice`;
      context.publishGatewayNotice?.(notice, encodePayload(getShipSkinProtoRoot().lookupType(notice), {
        kind: { component: authority.buildComponentIdentifier(result.componentID),
          ...(result.licenseType === "finite" ? { finite: result.grantedCapacity } : { infinite: true }) },
      }), { character: characterID });
    }
    return result;
  };
  return createSkinGatewayService("ship-skin-component-license", handlers);
}
module.exports = { createShipSkinComponentLicenseGatewayService };
