"use strict";
const { createSkinGatewayService } = require("./shipSkinGatewayHelpers");
const { getShipSkinProtoRoot } = require("./shipSkinGatewayProto");
const { encodePayload, timestampFromMs } = require("./gatewayServiceHelpers");
const runtime = require("../../../services/ship/shipSkinSequencingRuntime");
const drafts = require("../../../services/ship/shipSkinDraftRuntime");
const rights = require("../../../services/ship/shipSkinThirdPartyRuntime");
const { getShipSkinSequencingPolicy, getShipSkinSequencingTerms } = require("../../../services/ship/shipSkinSequencingAuthority");
const { getCharacterShipSkinLimits } = require("../../../services/ship/shipSkinSkillPolicy");
const PREFIX = "eve_public.cosmetic.ship.skin.thirdparty.";
const INITIATE_ERRORS = { COMPONENT_LICENSES_UNAVAILABLE: 491, COMPONENT_LICENSES_INSUFFICIENT: 491,
  SKINR_BINDERS_INSUFFICIENT: 492, SKINR_HULL_REQUIRES_OMEGA: 493, SKINR_PLEX_INSUFFICIENT: 494,
  SKINR_RUN_LIMIT: 495, SKINR_JOB_LIMIT: 490 };
function failureReason(job) {
  if (job.failureReason) return job.failureReason;
  if (["INSUFFICIENT_FUNDS", "INSUFFICIENT_PLEX", "INSUFFICIENT_PLEX_BALANCE"].includes(job.errorMsg)) return 1;
  return 4;
}
function attributes(job) {
  return { skin: { hex: job.hex }, sequencer: { sequential: job.characterID }, quantity: job.quantity,
    ...(job.state === "completed" ? { completed: timestampFromMs(job.completedMs) }
      : job.state === "refused" ? { failed: failureReason(job) } : job.startedMs ? { started: timestampFromMs(job.startedMs) } : { pending: true }),
    ...(job.plannedCompletionMs ? { planned_completion: timestampFromMs(job.plannedCompletionMs) } : {}) };
}
function createShipSkinSequencingGatewayService(context = {}) {
  const handlers = {}, cents = context.plexGatewayCentsPerPlex || 100;
  const plex = amount => ({ total_in_cents: amount * cents });
  runtime.setNoticeSink((kind, job) => {
    const type = `${PREFIX}sequencing.job.api.${kind}Notice`;
    context.publishGatewayNotice?.(type, encodePayload(getShipSkinProtoRoot().lookupType(type), { id: { uuid: Buffer.from(job.id, "hex") }, ...(kind === "Failed" ? { reason: failureReason(job) } : {}) }), { character: job.characterID });
    if (kind === "Completed") {
      const row = rights.getShipSkinLicense(job.characterID, job.hex);
      const updated = `${PREFIX}license.api.UpdatedNotice`;
      const current = { activated: row.activated, unactivated: row.unactivated, escrowed: row.escrowed, first_acquired: timestampFromMs(row.firstAcquiredMs) };
      context.publishGatewayNotice?.(updated, encodePayload(getShipSkinProtoRoot().lookupType(updated), {
        id: { character: { sequential: job.characterID }, skin: { hex: job.hex } }, attributes: current,
        previous_attributes: { ...current, unactivated: Math.max(0, row.unactivated - job.quantity) },
      }), { character: job.characterID });
    }
  });
  handlers[`${PREFIX}sequencing.api.GetTierPricingRequest`] = () => {
    const policy = getShipSkinSequencingPolicy();
    return { payload: { prices: policy.tierPricing.map(row => ({ tier: { level: row.tier }, plex: plex(getShipSkinSequencingTerms(row.tier, 1, 0, policy).price) })), discount_percentage_applied: policy.discounts.pricingPercent } };
  };
  handlers[`${PREFIX}sequencing.api.GetTierDurationsRequest`] = (_request, { characterID }) => {
    const policy = getShipSkinSequencingPolicy(), { durationBonusPercent } = getCharacterShipSkinLimits(characterID);
    return { payload: { durations: policy.tierDurations.map(row => {
      const { durationMs } = getShipSkinSequencingTerms(row.tier, 1, durationBonusPercent, policy);
      return { tier: { level: row.tier }, duration: { seconds: durationMs / 1000 } };
    }), discount_percentage_applied: policy.discounts.durationPercent } };
  };
  handlers[`${PREFIX}sequencing.api.GetEarlyCompletionPricingRequest`] = () => ({ payload: { prices: getShipSkinSequencingPolicy().earlyCompletionPricing.map(row => ({ remaining_greater: { seconds: row.remainingGreaterSeconds }, remaining_lesser_or_equal: { seconds: row.remainingLesserOrEqualSeconds }, plex: plex(row.plex) })) } });
  handlers[`${PREFIX}sequencing.job.api.InitiateRequest`] = async (request, { characterID, requestID }) => {
    const result = await runtime.initiate(characterID, request, requestID);
    if (!result.success && INITIATE_ERRORS[result.errorMsg]) return { ...result, statusCode: INITIATE_ERRORS[result.errorMsg] };
    return result.success ? { payload: { id: { uuid: Buffer.from(result.job.id, "hex") }, attributes: attributes(result.job) } } : result;
  };
  handlers[`${PREFIX}sequencing.job.api.GetAllActiveRequest`] = (_request, { characterID }) => ({ payload: { jobs: runtime.getActiveJobs(characterID).map(job => ({ id: { uuid: Buffer.from(job.id, "hex") }, attributes: attributes(job) })) } });
  handlers[`${PREFIX}sequencing.job.api.GetRequest`] = (request, { characterID }) => {
    const job = runtime.ownedJob(characterID, drafts.uuid(request.job?.uuid));
    return job ? { payload: { job: attributes(job) } } : { success: false, statusCode: 404, errorMsg: "SKINR_JOB_NOT_FOUND" };
  };
  handlers[`${PREFIX}sequencing.job.api.CompleteEarlyRequest`] = async (request, { characterID, requestID }) => {
    const result = await runtime.completeEarly(characterID, drafts.uuid(request.job?.uuid), requestID);
    return !result.success && ["INSUFFICIENT_FUNDS", "INSUFFICIENT_PLEX", "INSUFFICIENT_PLEX_BALANCE", "SKINR_EARLY_REFUSED"].includes(result.errorMsg)
      ? { ...result, statusCode: 403 } : result;
  };
  handlers[`${PREFIX}license.api.GetOwnedRequest`] = (_request, { characterID }) => ({ payload: { licenses: rights.getOwnedShipSkinLicenses(characterID).map(row => ({ character: { sequential: characterID }, skin: { hex: row.hex } })) } });
  handlers[`${PREFIX}license.api.GetRequest`] = (request, { characterID }) => {
    if (Number(request.license?.character?.sequential) !== characterID) return { success: false, statusCode: 403, errorMsg: "SKINR_LICENSE_NOT_OWNED" };
    const row = rights.getShipSkinLicense(characterID, request.license?.skin?.hex);
    return row ? { payload: { license: { activated: row.activated, unactivated: row.unactivated, escrowed: row.escrowed, first_acquired: timestampFromMs(row.firstAcquiredMs) } } } : { success: false, statusCode: 404, errorMsg: "SKINR_LICENSE_NOT_FOUND" };
  };
  return createSkinGatewayService("ship-skin-sequencing", handlers);
}
module.exports = { createShipSkinSequencingGatewayService, attributes };
