"use strict";

const { grantAllShipSkinComponentLicenses } = require("../../ship/shipSkinComponentRuntime");
const { buildComponentIdentifier } = require("../../ship/shipSkinComponentAuthority");
const publicGatewayNotices = require("../../../_secondary/express/publicGatewayNotices");
const { getShipSkinProtoRoot } = require("../../../_secondary/express/gatewayServices/shipSkinGatewayProto");
const { encodePayload } = require("../../../_secondary/express/gatewayServices/gatewayServiceHelpers");
const { handledResult } = require("./commandReplies");
const { resolveCharacterTargetDescriptor, formatCharacterTargetLabel } = require("./characterTargets");

const GRANTED_NOTICE = "eve_public.cosmetic.ship.skin.thirdparty.component.license.api.GrantedNotice";

function publishComponentGrants(characterID, grants, options) {
  const publisher = options?.publishGatewayNotice || publicGatewayNotices.getPublicGateway()?.publishGatewayNotice;
  if (typeof publisher !== "function") return;
  const messageType = getShipSkinProtoRoot().lookupType(GRANTED_NOTICE);
  for (const grant of grants) {
    publisher(GRANTED_NOTICE, encodePayload(messageType, {
      kind: {
        component: buildComponentIdentifier(grant.componentID),
        ...(grant.licenseType === "finite" ? { finite: grant.grantedCapacity } : { infinite: true }),
      },
    }), { character: characterID });
  }
}

function handleAllSkinrCommand(session, argumentText, chatHub, options) {
  const targetToken = String(argumentText || "").trim() || "me";
  const target = resolveCharacterTargetDescriptor(session, targetToken);
  if (!target.success) {
    return handledResult(chatHub, session, options, target.errorMsg === "CHARACTER_NOT_SELECTED"
      ? "Select a character before using /allskinr me."
      : `Character not found: ${targetToken}. Use me, a character ID, or an exact character name.`);
  }

  const result = grantAllShipSkinComponentLicenses(target.data.characterID, 1000);
  if (!result.success) {
    const reason = result.errorMsg === "SKINR_ACTIVATION_PENDING"
      ? "A component activation is pending; try again after it completes."
      : result.errorMsg === "SKINR_CAPACITY_OVERFLOW"
        ? "A limited component would exceed its maximum capacity."
        : result.errorMsg === "SKINR_COMPONENT_CATALOG_EMPTY"
          ? "The SKINR component catalog is unavailable."
          : result.errorMsg;
    return handledResult(chatHub, session, options, `Failed to grant SKINR components. ${reason}`);
  }

  const data = result.data;
  publishComponentGrants(target.data.characterID, data.grants, options);
  return handledResult(chatHub, session, options, [
    `Granted ${data.infiniteGranted.toLocaleString()} unlimited SKINR components for ${formatCharacterTargetLabel(target.data)}.`,
    `${data.infiniteAlreadyOwned.toLocaleString()} unlimited components already owned.`,
    `Added 1,000 uses of each of ${data.finiteGranted.toLocaleString()} limited SKINR components.`,
  ].join(" "));
}

module.exports = { handleAllSkinrCommand };
