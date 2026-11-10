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
      // The goal panel's "Estimated Time" (goal_definition.duration_text: int(duration) minutes). Tranquility's
      // estimates are not recovered: they come with the server's definitions, not the client data, and the EVE
      // University wiki only gives rough times for whole groups. The catalog's 0 would read as "0s", which is
      // wrong; "null" (a ValueError there) leaves the value empty instead. A real estimate (duration > 0) is sent.
      duration: row.duration > 0 ? row.duration : "null", videoID: row.videoID || "null", ...(row.group ? { group: row.group } : {}),
      ...(row.auraTextID ? { auraTextID: row.auraTextID } : {}),
      ...(row.agencyScreen && row.agencyLinkTextID ? { agencyScreen: row.agencyScreen, agencyLinkTextID: row.agencyLinkTextID } : {}) })
      .map(([key, value]) => ({ key, value: String(value) })),
    rewards: row.rewards.map(reward => ({ reward_label: reward.label, reward_type:
      reward.kind === "sp" ? { skill_points: reward.amount } : reward.kind === "isk" ? { isk: { units: reward.amount, nanos: 0 } }
        : { item: { identifier: { sequential: reward.typeID }, quantity: reward.quantity } } })),
  } };
}
function buildProgress(characterID, row, snapshot = null) {
  const progress = snapshot ? snapshot.progress.get(row.id) : require("../../../services/career/careerProgress").get(characterID, row.id);
  const claims = require("../../../services/career/careerRewardRuntime");
  return { goal: identifier(row.id), progress: progress?.progress || 0,
    ...(progress?.completedAtMs ? { completed_time: timestampFromMs(progress.completedAtMs) } : { not_completed: true }),
    reward_label_states: [...new Set(row.rewards.map(reward => reward.label))].map(label => {
      const claim = claims.getClaim(characterID, row.id, label, snapshot?.claims);
      return { label, ...(claim?.state === "completed" ? { claimed_time: timestampFromMs(claim.claimedAtMs) } : { not_claimed: true }) };
    }),
  };
}
let publisher, listening = false;
// One reprocessing settlement reports a notice per input stack, all in one turn, and
// careerProgress.sync() reconciles every career source: 420 stacks held the event loop
// for 24 s. Run one sync per character per turn instead. Career progress is a projection
// of durable owner state and handleRequest syncs before it reads, so a turn's delay
// cannot lose progress or show a stale answer. A burst spread over several turns still
// costs one sync per turn.
const pendingCareerSyncs = new Set();
let careerSyncScheduled = false;
function runPendingCareerSyncs() {
  careerSyncScheduled = false;
  const characterIDs = [...pendingCareerSyncs];
  pendingCareerSyncs.clear();
  // Writes are refused once a shutdown starts. The next sync rebuilds this from the owners.
  if (require("../../../gameStore").isShutdownInProgress()) return;
  for (const characterID of characterIDs) {
    try {
      const result = require("../../../services/career/careerProgress").sync(characterID);
      if (!result.success) require("../../../utils/logger").warn(`[Career] progress awaits retry: ${result.errorMsg}`);
    } catch (error) { require("../../../utils/logger").warn(`[Career] progress awaits retry: ${error.message}`); }
  }
}
function scheduleCareerSync(characterID) {
  pendingCareerSyncs.add(characterID);
  if (careerSyncScheduled) return;
  careerSyncScheduled = true;
  setImmediate(runPendingCareerSyncs);
}
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
    require("../../../services/achievement/achievementState").events.on("achievement-progressed", event => scheduleCareerSync(event.characterID));
    require("../../../services/career/careerEventLedger").events.on("committed", event => scheduleCareerSync(event.characterID));
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
      if (request === `${PREFIX}GetAllRequest`) {
        const snapshot = { claims: claims.createClaimSnapshot(characterID), progress: new Map(synced.data.map(row => [row.goalID, row])) };
        return respond(200, { goals: catalog.list().map(row => buildProgress(characterID, row, snapshot)) });
      }
      return fulfill();
    } };
}
module.exports = { createCareerGoalGatewayService, buildDefinition, buildProgress, HANDLED_REQUEST_TYPES };
