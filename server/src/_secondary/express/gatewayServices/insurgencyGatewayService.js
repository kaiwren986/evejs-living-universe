"use strict";

function normalizeUint(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return Math.trunc(numeric);
}

function normalizeProtoNumber(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }

  return Number(value);
}

function buildFraction(numerator = 0, denominator = 1) {
  const normalizedDenominator = normalizeUint(denominator, 1);
  return {
    numerator: normalizeUint(numerator, 0),
    denominator: normalizedDenominator > 0 ? normalizedDenominator : 1,
  };
}

function buildSystemInfo(stage = 0) {
  return {
    total_progress: buildFraction(0, 1),
    stage: normalizeUint(stage, 0),
    eve_contribution: buildFraction(0, 1),
    vanguard_contribution: buildFraction(0, 1),
  };
}

function getPublicCorruptionSystemInfo(_systemID = 0) {
  return buildSystemInfo(0);
}

function getPublicSuppressionSystemInfo(_systemID = 0) {
  return buildSystemInfo(0);
}

// The client counts a system as fully corrupted when its stage reaches
// len(thresholds) - 1 (corruptionSuppressionSvc.IsCurrentSystemFullyCorrupted),
// and a fully corrupted highsec system has no CONCORD response
// (corruptionsuppression/systemEffects.DoesConcordReact). An empty list made
// every system "fully corrupted" at stage 0, so attacking a player's Customs
// Office in 0.95 Perimeter gave no criminal flag (real client, 2026-11-07).
// TQ has five stages (stage 5 is max corruption; station.py divides by at least
// five); no capture gives the exact fractions, so they are equal fifths.
const STAGE_THRESHOLDS = [1, 2, 3, 4, 5].map((stage) => buildFraction(stage, 5));

function getPublicCorruptionStageThresholds() {
  return {
    thresholds: STAGE_THRESHOLDS.map((fraction) => ({ ...fraction })),
  };
}

function getPublicSuppressionStageThresholds() {
  return {
    thresholds: STAGE_THRESHOLDS.map((fraction) => ({ ...fraction })),
  };
}

function buildEncodedPayload(messageType, payload) {
  return Buffer.from(messageType.encode(messageType.create(payload)).finish());
}

const REQUEST_TYPE_ALIASES = Object.freeze({
  "eve_public.pirate.corruption.api.requests_pb2.GetSystemInfoRequest":
    "eve_public.pirate.corruption.api.GetSystemInfoRequest",
  "eve_public.pirate.corruption.api.requests_pb2.GetStageThresholdsRequest":
    "eve_public.pirate.corruption.api.GetStageThresholdsRequest",
  "eve_public.pirate.suppression.api.requests_pb2.GetSystemInfoRequest":
    "eve_public.pirate.suppression.api.GetSystemInfoRequest",
  "eve_public.pirate.suppression.api.requests_pb2.GetStageThresholdsRequest":
    "eve_public.pirate.suppression.api.GetStageThresholdsRequest",
});

function resolveRequestTypeName(requestTypeName) {
  return REQUEST_TYPE_ALIASES[String(requestTypeName || "")] ||
    String(requestTypeName || "");
}

function createInsurgencyGatewayService({ protoRoot }) {
  const publicCorruptionGetSystemInfoRequest = protoRoot.lookupType(
    "eve_public.pirate.corruption.api.GetSystemInfoRequest",
  );
  const publicCorruptionGetSystemInfoResponse = protoRoot.lookupType(
    "eve_public.pirate.corruption.api.GetSystemInfoResponse",
  );
  const publicCorruptionGetStageThresholdsResponse = protoRoot.lookupType(
    "eve_public.pirate.corruption.api.GetStageThresholdsResponse",
  );
  const publicSuppressionGetSystemInfoRequest = protoRoot.lookupType(
    "eve_public.pirate.suppression.api.GetSystemInfoRequest",
  );
  const publicSuppressionGetSystemInfoResponse = protoRoot.lookupType(
    "eve_public.pirate.suppression.api.GetSystemInfoResponse",
  );
  const publicSuppressionGetStageThresholdsResponse = protoRoot.lookupType(
    "eve_public.pirate.suppression.api.GetStageThresholdsResponse",
  );

  function getSystemID(requestType, requestEnvelope) {
    try {
      const request = requestType.decode(requestEnvelope.payload.value || Buffer.alloc(0));
      return normalizeProtoNumber(request?.system?.sequential);
    } catch (error) {
      // ignored: a request that does not decode names no system (0)
      return 0;
    }
  }

  return {
    name: "insurgency",
    handledRequestTypes: [
      "eve_public.pirate.corruption.api.GetSystemInfoRequest",
      "eve_public.pirate.corruption.api.GetStageThresholdsRequest",
      "eve_public.pirate.suppression.api.GetSystemInfoRequest",
      "eve_public.pirate.suppression.api.GetStageThresholdsRequest",
      ...Object.keys(REQUEST_TYPE_ALIASES),
    ],
    handleRequest(requestTypeName, requestEnvelope) {
      const resolvedRequestTypeName = resolveRequestTypeName(requestTypeName);
      if (resolvedRequestTypeName === "eve_public.pirate.corruption.api.GetSystemInfoRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.pirate.corruption.api.GetSystemInfoResponse",
          responsePayloadBuffer: buildEncodedPayload(
            publicCorruptionGetSystemInfoResponse,
            getPublicCorruptionSystemInfo(
              getSystemID(publicCorruptionGetSystemInfoRequest, requestEnvelope),
            ),
          ),
        };
      }

      if (resolvedRequestTypeName === "eve_public.pirate.corruption.api.GetStageThresholdsRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.pirate.corruption.api.GetStageThresholdsResponse",
          responsePayloadBuffer: buildEncodedPayload(
            publicCorruptionGetStageThresholdsResponse,
            getPublicCorruptionStageThresholds(),
          ),
        };
      }

      if (resolvedRequestTypeName === "eve_public.pirate.suppression.api.GetSystemInfoRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName: "eve_public.pirate.suppression.api.GetSystemInfoResponse",
          responsePayloadBuffer: buildEncodedPayload(
            publicSuppressionGetSystemInfoResponse,
            getPublicSuppressionSystemInfo(
              getSystemID(publicSuppressionGetSystemInfoRequest, requestEnvelope),
            ),
          ),
        };
      }

      if (resolvedRequestTypeName === "eve_public.pirate.suppression.api.GetStageThresholdsRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.pirate.suppression.api.GetStageThresholdsResponse",
          responsePayloadBuffer: buildEncodedPayload(
            publicSuppressionGetStageThresholdsResponse,
            getPublicSuppressionStageThresholds(),
          ),
        };
      }

      return null;
    },
  };
}

module.exports = {
  createInsurgencyGatewayService,
};
module.exports._testing = {
  buildFraction,
};
