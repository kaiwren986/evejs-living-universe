"use strict";
const { getCareerProtoRoot } = require("./careerGatewayProto");
const { bufferFromBytes, encodePayload, getActiveCharacterID, timestampFromMs, uuidBufferToString, uuidStringToBuffer } = require("./gatewayServiceHelpers");
const catalog = require("../../../services/career/careerCatalog");
const characters = require("../../../services/character/characterState");
const PREFIX = "eve_public.career.goal.api.";
const HANDLED_REQUEST_TYPES = ["GetDefinitions", "GetAll", "ClaimReward"].map(method => `${PREFIX}${method}Request`);
function identifier(id) { return { uuid: uuidStringToBuffer(id) }; }
function buildDefinition(row) {
  return { goal: identifier(row.id), attributes: {
    name: { sequential: row.nameMessageID }, description: { sequential: row.descriptionMessageID },
    target: row.target, career: row.career, career_points: row.points, threat: row.threat || 0,
    ui_annotations: Object.entries({ subtype: row.subtype || "OVERALL_GOAL", order: row.order || 0,
      duration: row.duration || 0, videoID: row.videoID || "null", ...(row.group ? { group: row.group } : {}),
      ...(row.auraTextID ? { auraTextID: row.auraTextID } : {}),
      ...(row.agencyScreen && row.agencyLinkTextID ? { agencyScreen: row.agencyScreen, agencyLinkTextID: row.agencyLinkTextID } : {}) })
      .map(([key, value]) => ({ key, value: String(value) })),
    rewards: row.rewards.map(reward => ({ reward_label: reward.label, reward_type:
      reward.kind === "sp" ? { skill_points: reward.amount } : reward.kind === "isk" ? { isk: { units: reward.amount, nanos: 0 } }
        : { item: { identifier: { sequential: reward.typeID }, quantity: reward.quantity } } })),
  } };
}
function buildProgress(characterID, row) {
  const progress = require("../../../services/career/careerProgress").get(characterID, row.id);
  const claims = require("../../../services/career/careerRewardRuntime");
  return { goal: identifier(row.id), progress: progress?.progress || 0,
    ...(progress?.completedAtMs ? { completed_time: timestampFromMs(progress.completedAtMs) } : { not_completed: true }),
    reward_label_states: [...new Set(row.rewards.map(reward => reward.label))].map(label => {
      const claim = claims.getClaim(characterID, row.id, label);
      return { label, ...(claim?.state === "completed" ? { claimed_time: timestampFromMs(claim.claimedAtMs) } : { not_claimed: true }) };
    }),
  };
}
let publisher, listening = false;
function createCareerGoalGatewayService(context) {
  const root = getCareerProtoRoot();
  publisher = context.publishGatewayNotice;
  if (!listening) {
    listening = true;
    require("../../../services/career/careerProgress").events.on("progressed", event => {
      if (typeof publisher !== "function") return;
      const send = (type, payload) => publisher(`${PREFIX}${type}`, encodePayload(root.lookupType(`${PREFIX}${type}`), payload), { character: event.characterID });
      try {
        send("ProgressedNotice", { goal: identifier(event.goalID), amount: event.progress });
        if (event.completedAtMs) send("CompletedNotice", { goal: identifier(event.goalID) });
      } catch (error) { require("../../../utils/logger").warn(`[Career] progress notice failed: ${error.message}`); }
    });
    require("../../../services/achievement/achievementState").events.on("achievement-progressed", event => {
      try {
        const result = require("../../../services/career/careerProgress").sync(event.characterID);
        if (!result.success) require("../../../utils/logger").warn(`[Career] native progress awaits retry: ${result.errorMsg}`);
      } catch (error) { require("../../../utils/logger").warn(`[Career] native progress awaits retry: ${error.message}`); }
    });
    require("../../../services/career/careerEventLedger").events.on("committed", event => {
      try {
        const result = require("../../../services/career/careerProgress").sync(event.characterID);
        if (!result.success) require("../../../utils/logger").warn(`[Career] gameplay progress awaits retry: ${result.errorMsg}`);
      } catch (error) { require("../../../utils/logger").warn(`[Career] gameplay progress awaits retry: ${error.message}`); }
    });
  }
  return { name: "career-goals", handledRequestTypes: HANDLED_REQUEST_TYPES, getEmptySuccessResponseType: () => null,
    handleRequest(type, envelope) {
      const request = type.replace(".api.requests_pb2.", ".api.");
      if (!HANDLED_REQUEST_TYPES.includes(request)) return null;
      const responseTypeName = request.replace(/Request$/, "Response");
      const respond = (statusCode = 200, payload = {}, statusMessage = "") => ({ statusCode, statusMessage, responseTypeName,
        responsePayloadBuffer: encodePayload(root.lookupType(responseTypeName), payload) });
      const characterID = getActiveCharacterID(envelope), active = Number(envelope?.authoritative_context?.active_character?.sequential || 0);
      if (!Number.isSafeInteger(characterID) || !characters.getCharacterRecord(characterID) || active && active !== characterID)
        return respond(401, {}, "CHARACTER_REQUIRED");
      let decoded;
      try { decoded = root.lookupType(request).decode(bufferFromBytes(envelope?.payload?.value)); }
      catch (_) { return respond(400, {}, "MALFORMED_REQUEST"); }
      if (request === `${PREFIX}GetDefinitionsRequest`) return respond(200, { goals: catalog.list().map(buildDefinition) });
      const claims = require("../../../services/career/careerRewardRuntime");
      const isClaim = request === `${PREFIX}ClaimRewardRequest`;
      const goalID = isClaim ? uuidBufferToString(decoded.goal?.uuid) : null;
      if (isClaim && (!goalID || ![1, 2].includes(decoded.label))) return respond(400, {}, "INVALID_CAREER_CLAIM");
      const fulfill = () => claims.claim(characterID, goalID, decoded.label)
        .then(result => respond(result.success ? 200 : 409, {}, result.errorMsg || ""));
      // Accepted queue entries survive later catalog/progress changes. A lost
      // response must not require the original eligibility projection again.
      if (isClaim && claims.getClaim(characterID, goalID, decoded.label)) return fulfill();
      const synced = require("../../../services/career/careerProgress").sync(characterID);
      if (!synced.success) return respond(503, {}, synced.errorMsg);
      if (request === `${PREFIX}GetAllRequest`) return respond(200, { goals: catalog.list().map(row => buildProgress(characterID, row)) });
      return fulfill();
    } };
}
module.exports = { createCareerGoalGatewayService, buildDefinition, buildProgress, HANDLED_REQUEST_TYPES };
