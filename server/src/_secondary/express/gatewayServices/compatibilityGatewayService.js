"use strict";

const EMPTY_SUCCESS_RESPONSE_TYPES = new Map([
  [
    "eve_public.plex.vault.api.BalanceRequest",
    "eve_public.plex.vault.api.BalanceResponse",
  ],
  [
    "eve_public.character.skill.plan.GetAllRequest",
    "eve_public.character.skill.plan.GetAllResponse",
  ],
  [
    "eve_public.character.skill.plan.SetActiveRequest",
    "eve_public.character.skill.plan.SetActiveResponse",
  ],
  [
    "eve_public.stargate.lock.api.GetRestrictedSystemsRequest",
    "eve_public.stargate.lock.api.GetRestrictedSystemsResponse",
  ],
]);

// A 404 is the payment-schedule contract's explicit "no active schedule"
// result. A typed empty 200 would create schedule ID 0 and make the client issue
// a follow-up request that escapes its error handling.
const INTENTIONAL_NOT_FOUND_REQUEST_TYPES = new Set([
  "eve_public.payment.schedule.api.GetActiveByTypeRequest",
]);

const ZERO_UUID_BYTES = Buffer.alloc(16);

function buildEncodedPayload(messageType, payload) {
  return Buffer.from(messageType.encode(messageType.create(payload)).finish());
}

function createCompatibilityGatewayService({ protoRoot, emptyPayload }) {
  const skillPlanGetActiveResponse = protoRoot.lookupType(
    "eve_public.character.skill.plan.GetActiveResponse",
  );

  return {
    name: "compatibility",
    handledRequestTypes: [
      "eve_public.character.skill.plan.GetActiveRequest",
      ...EMPTY_SUCCESS_RESPONSE_TYPES.keys(),
      ...INTENTIONAL_NOT_FOUND_REQUEST_TYPES,
    ],
    getEmptySuccessResponseType(requestTypeName) {
      return EMPTY_SUCCESS_RESPONSE_TYPES.get(requestTypeName) || null;
    },
    handleRequest(requestTypeName) {
      if (requestTypeName === "eve_public.character.skill.plan.GetActiveRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.character.skill.plan.GetActiveResponse",
          responsePayloadBuffer: buildEncodedPayload(skillPlanGetActiveResponse, {
            skill_plan: {
              uuid: ZERO_UUID_BYTES,
            },
          }),
        };
      }

      if (INTENTIONAL_NOT_FOUND_REQUEST_TYPES.has(requestTypeName)) {
        return {
          statusCode: 404,
          statusMessage: "no active payment schedule",
          responseTypeName: null,
          responsePayloadBuffer: null,
        };
      }

      const emptySuccessResponseType =
        EMPTY_SUCCESS_RESPONSE_TYPES.get(requestTypeName);
      if (!emptySuccessResponseType) {
        return null;
      }

      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: emptySuccessResponseType,
        responsePayloadBuffer: emptyPayload,
      };
    },
  };
}

module.exports = {
  createCompatibilityGatewayService,
};
module.exports._testing = {
  EMPTY_SUCCESS_RESPONSE_TYPES,
  INTENTIONAL_NOT_FOUND_REQUEST_TYPES,
};
