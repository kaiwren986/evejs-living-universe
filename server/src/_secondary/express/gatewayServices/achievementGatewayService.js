"use strict";

const path = require("path");

const {
  buildClientCdnUrl,
} = require(path.join(__dirname, "../../../services/_shared/clientCdnUrl"));
const {
  encodePayload,
  getActiveCharacterID,
  normalizePageRequest,
  timestampFromMs,
  uuidBufferToString,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");
const {
  ACHIEVEMENT_CDN_PATH,
  CHARACTER_TITLE_CDN_PATH,
  getAchievementAsset,
  getAchievementAssetMetadata,
  getAchievementById,
  getCharacterTitleAsset,
  getCharacterTitleAssetMetadata,
  getContributionMethodById,
} = require(path.join(__dirname, "../../../services/achievement/achievementAuthority"));
const achievementState = require(path.join(
  __dirname,
  "../../../services/achievement/achievementState",
));
const {
  getAchievementGatewayProtoRoot,
} = require(path.join(__dirname, "../../../services/achievement/achievementGatewayProto"));

const REQUEST_TYPE_ALIASES = Object.freeze({
  "eve_public.achievement.definition.api.cdn.requests_pb2.GetLatestRequest": "eve_public.achievement.definition.api.cdn.GetLatestRequest",
  "eve_public.achievement.reward.api.requests_pb2.GetUnclaimedRequest": "eve_public.achievement.reward.api.GetUnclaimedRequest",
  "eve_public.achievement.reward.api.requests_pb2.ClaimRequest": "eve_public.achievement.reward.api.ClaimRequest",
  "eve_public.achievement.api.requests_pb2.GetRequest": "eve_public.achievement.api.GetRequest",
  "eve_public.achievement.category.api.requests_pb2.GetRequest": "eve_public.achievement.category.api.GetRequest",
  "eve_public.achievement.showcase.api.requests_pb2.GetCharacterScoreRequest": "eve_public.achievement.showcase.api.GetCharacterScoreRequest",
  "eve_public.cosmetic.character.title.definition.api.requests_pb2.GetLatestRequest": "eve_public.cosmetic.character.title.definition.api.GetLatestRequest",
  "eve_public.cosmetic.character.title.api.requests_pb2.GetOwnedRequest": "eve_public.cosmetic.character.title.api.GetOwnedRequest",
  "eve_public.cosmetic.character.title.api.requests_pb2.GetEquippedForCharacterRequest": "eve_public.cosmetic.character.title.api.GetEquippedForCharacterRequest",
  "eve_public.cosmetic.character.title.api.requests_pb2.EquipRequest": "eve_public.cosmetic.character.title.api.EquipRequest",
  "eve_public.cosmetic.character.title.api.requests_pb2.UnequipRequest": "eve_public.cosmetic.character.title.api.UnequipRequest",
});

const HANDLED_REQUEST_TYPES = Object.freeze([
  "eve_public.achievement.definition.api.cdn.GetLatestRequest",
  "eve_public.achievement.reward.api.GetUnclaimedRequest",
  "eve_public.achievement.reward.api.ClaimRequest",
  "eve_public.achievement.api.GetRequest",
  "eve_public.achievement.category.api.GetRequest",
  "eve_public.achievement.showcase.api.GetCharacterScoreRequest",
  "eve_public.cosmetic.character.title.definition.api.GetLatestRequest",
  "eve_public.cosmetic.character.title.api.GetOwnedRequest",
  "eve_public.cosmetic.character.title.api.GetEquippedForCharacterRequest",
  "eve_public.cosmetic.character.title.api.EquipRequest",
  "eve_public.cosmetic.character.title.api.UnequipRequest",
]);

let noticesInstalled = false;
let noticePublisher = null;

function canonicalRequestType(requestTypeName) {
  return REQUEST_TYPE_ALIASES[requestTypeName] || requestTypeName;
}

function decodePayload(messageType, requestEnvelope) {
  return messageType.decode(Buffer.from(
    requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value
      ? requestEnvelope.payload.value
      : Buffer.alloc(0),
  ));
}

function ok(responseTypeName, responseType, payload = {}) {
  return {
    statusCode: 200,
    statusMessage: "",
    responseTypeName,
    responsePayloadBuffer: encodePayload(responseType, payload),
  };
}

function error(responseTypeName, statusCode, statusMessage = "") {
  return {
    statusCode,
    statusMessage,
    responseTypeName,
    responsePayloadBuffer: Buffer.alloc(0),
  };
}

function identifier(uuid) {
  return { uuid: uuidStringToBuffer(uuid) };
}

function uuidFromIdentifier(value) {
  return uuidBufferToString(value && value.uuid);
}

function buildChecklist(valuesByType) {
  return {
    values: Object.entries(valuesByType || {})
      .map(([valueType, values]) => ({
        value_type: valueType,
        values: Array.isArray(values) ? values : [],
      }))
      .filter((entry) => entry.value_type && entry.values.length > 0),
  };
}

function buildAchievementPayload(characterID, achievementID) {
  const achievement = getAchievementById(achievementID);
  const state = achievementState.getAchievementState(characterID, achievementID);
  if (!achievement || !state) {
    return null;
  }
  const method = getContributionMethodById(
    achievement.contribution && achievement.contribution.method_id,
  );
  const mode = String(method && method.progress && method.progress.progress_type || "CUMULATIVE").toUpperCase();
  const payload = {
    reached_milestones: Object.entries(state.reachedMilestonesById || {})
      .sort((left, right) => Number(left[1].reachedAtMs) - Number(right[1].reachedAtMs))
      .map(([milestoneID, reached]) => ({
        milestone: identifier(milestoneID),
        reached_date: timestampFromMs(reached.reachedAtMs),
        category_points_awarded: Number(reached.categoryPointsAwarded || 0),
      })),
  };
  if (state.completedAtMs > 0) {
    payload.completed_date = timestampFromMs(state.completedAtMs);
  } else {
    payload.not_completed = true;
  }
  if (mode === "SET" || mode === "CHECKLIST") {
    payload.checklist = buildChecklist(state.checklistValuesByType);
  } else {
    payload.progress_value = state.progressValue;
  }
  return payload;
}

function buildRewardPayload(entry) {
  const source = {
    achievement: identifier(entry.sourceID),
    milestone: identifier(entry.milestoneID),
  };
  return {
    achievement_source: entry.sourceKind === "achievement" ? source : undefined,
    unclaimed_rewards: (entry.rewardIds || []).map(identifier),
  };
}

function extractRewardSource(decoded) {
  if (decoded && decoded.achievement_source) {
    return {
      sourceKind: "achievement",
      sourceID: uuidFromIdentifier(decoded.achievement_source.achievement),
      milestoneID: uuidFromIdentifier(decoded.achievement_source.milestone),
    };
  }
  if (decoded && decoded.category_source) {
    return {
      sourceKind: "category",
      sourceID: uuidFromIdentifier(decoded.category_source.category),
      milestoneID: uuidFromIdentifier(decoded.category_source.milestone),
    };
  }
  return null;
}

function getAchievementCdnAsset(routePath) {
  if (routePath === ACHIEVEMENT_CDN_PATH) {
    return { buffer: getAchievementAsset(), contentType: "application/octet-stream" };
  }
  if (routePath === CHARACTER_TITLE_CDN_PATH) {
    return { buffer: getCharacterTitleAsset(), contentType: "application/octet-stream" };
  }
  return null;
}

function installNoticeBridges(types) {
  if (noticesInstalled) {
    return;
  }
  noticesInstalled = true;
  const publish = (typeName, messageType, payload, characterID) => {
    if (typeof noticePublisher === "function" && characterID > 0) {
      noticePublisher(typeName, encodePayload(messageType, payload), { character: characterID });
    }
  };
  achievementState.events.on("achievement-progressed", (event) => {
    const achievement = getAchievementById(event.achievementID);
    const method = getContributionMethodById(achievement && achievement.contribution && achievement.contribution.method_id);
    const mode = String(method && method.progress && method.progress.progress_type || "CUMULATIVE").toUpperCase();
    publish("eve_public.achievement.api.ProgressedNotice", types.achievementProgressedNotice, {
      achievement: identifier(event.achievementID),
      ...(mode === "SET" || mode === "CHECKLIST"
        ? { items: buildChecklist(event.checklistValuesByType) }
        : { value: event.progressValue }),
    }, event.characterID);
  });
  achievementState.events.on("achievement-completed", (event) => {
    publish("eve_public.achievement.api.CompletedNotice", types.achievementCompletedNotice, {
      achievement: identifier(event.achievementID),
    }, event.characterID);
  });
  achievementState.events.on("achievement-milestone-reached", (event) => {
    publish("eve_public.achievement.milestone.api.ReachedNotice", types.achievementMilestoneReachedNotice, {
      achievement: identifier(event.achievementID),
      milestone: identifier(event.milestoneID),
    }, event.characterID);
  });
  achievementState.events.on("category-progressed", (event) => {
    publish("eve_public.achievement.category.api.ProgressedNotice", types.categoryProgressedNotice, {
      category: identifier(event.categoryID),
      score: event.score,
    }, event.characterID);
  });
  achievementState.events.on("title-granted", (event) => {
    publish("eve_public.cosmetic.character.title.api.GrantedNotice", types.titleGrantedNotice, {
      title: identifier(event.titleID),
    }, event.characterID);
  });
  achievementState.events.on("title-revoked", (event) => {
    publish("eve_public.cosmetic.character.title.api.RevokedNotice", types.titleRevokedNotice, {
      title: identifier(event.titleID),
    }, event.characterID);
  });
  achievementState.events.on("title-set", (event) => {
    publish("eve_public.cosmetic.character.title.api.SetNotice", types.titleSetNotice, {
      character: { sequential: event.characterID },
      ...(event.titleID ? { title: identifier(event.titleID) } : { no_title: true }),
    }, event.characterID);
  });
}

function getTypes() {
  const root = getAchievementGatewayProtoRoot();
  const lookup = (name) => root.lookupType(name);
  return {
    achievementCdnResponse: lookup("eve_public.achievement.definition.api.cdn.GetLatestResponse"),
    rewardGetRequest: lookup("eve_public.achievement.reward.api.GetUnclaimedRequest"),
    rewardGetResponse: lookup("eve_public.achievement.reward.api.GetUnclaimedResponse"),
    rewardClaimRequest: lookup("eve_public.achievement.reward.api.ClaimRequest"),
    rewardClaimResponse: lookup("eve_public.achievement.reward.api.ClaimResponse"),
    achievementGetRequest: lookup("eve_public.achievement.api.GetRequest"),
    achievementGetResponse: lookup("eve_public.achievement.api.GetResponse"),
    categoryGetRequest: lookup("eve_public.achievement.category.api.GetRequest"),
    categoryGetResponse: lookup("eve_public.achievement.category.api.GetResponse"),
    scoreGetRequest: lookup("eve_public.achievement.showcase.api.GetCharacterScoreRequest"),
    scoreGetResponse: lookup("eve_public.achievement.showcase.api.GetCharacterScoreResponse"),
    titleCdnResponse: lookup("eve_public.cosmetic.character.title.definition.api.GetLatestResponse"),
    titleOwnedRequest: lookup("eve_public.cosmetic.character.title.api.GetOwnedRequest"),
    titleOwnedResponse: lookup("eve_public.cosmetic.character.title.api.GetOwnedResponse"),
    titleEquippedRequest: lookup("eve_public.cosmetic.character.title.api.GetEquippedForCharacterRequest"),
    titleEquippedResponse: lookup("eve_public.cosmetic.character.title.api.GetEquippedForCharacterResponse"),
    titleEquipRequest: lookup("eve_public.cosmetic.character.title.api.EquipRequest"),
    titleEquipResponse: lookup("eve_public.cosmetic.character.title.api.EquipResponse"),
    titleUnequipResponse: lookup("eve_public.cosmetic.character.title.api.UnequipResponse"),
    achievementProgressedNotice: lookup("eve_public.achievement.api.ProgressedNotice"),
    achievementCompletedNotice: lookup("eve_public.achievement.api.CompletedNotice"),
    achievementMilestoneReachedNotice: lookup("eve_public.achievement.milestone.api.ReachedNotice"),
    categoryProgressedNotice: lookup("eve_public.achievement.category.api.ProgressedNotice"),
    titleGrantedNotice: lookup("eve_public.cosmetic.character.title.api.GrantedNotice"),
    titleRevokedNotice: lookup("eve_public.cosmetic.character.title.api.RevokedNotice"),
    titleSetNotice: lookup("eve_public.cosmetic.character.title.api.SetNotice"),
  };
}

function createAchievementGatewayService(context = {}) {
  const types = getTypes();
  noticePublisher = typeof context.publishGatewayNotice === "function"
    ? context.publishGatewayNotice
    : null;
  installNoticeBridges(types);

  return {
    name: "achievements",
    handledRequestTypes: [...HANDLED_REQUEST_TYPES, ...Object.keys(REQUEST_TYPE_ALIASES)],
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(rawRequestTypeName, requestEnvelope) {
      const requestTypeName = canonicalRequestType(rawRequestTypeName);
      if (!HANDLED_REQUEST_TYPES.includes(requestTypeName)) {
        return null;
      }
      const activeCharacterID = getActiveCharacterID(requestEnvelope);

      if (requestTypeName === "eve_public.achievement.definition.api.cdn.GetLatestRequest") {
        const metadata = getAchievementAssetMetadata();
        return ok("eve_public.achievement.definition.api.cdn.GetLatestResponse", types.achievementCdnResponse, {
          checkpoint: { url: buildClientCdnUrl(metadata.path), version: metadata.version, crc: { crc: metadata.crc } },
        });
      }
      if (requestTypeName === "eve_public.cosmetic.character.title.definition.api.GetLatestRequest") {
        const metadata = getCharacterTitleAssetMetadata();
        return ok("eve_public.cosmetic.character.title.definition.api.GetLatestResponse", types.titleCdnResponse, {
          checkpoint: { url: buildClientCdnUrl(metadata.path), version: metadata.version, crc: { crc: metadata.crc } },
        });
      }
      if (requestTypeName === "eve_public.achievement.api.GetRequest") {
        const decoded = decodePayload(types.achievementGetRequest, requestEnvelope);
        const payload = buildAchievementPayload(activeCharacterID, uuidFromIdentifier(decoded.achievement));
        return payload
          ? ok("eve_public.achievement.api.GetResponse", types.achievementGetResponse, payload)
          : error("eve_public.achievement.api.GetResponse", 404);
      }
      if (requestTypeName === "eve_public.achievement.category.api.GetRequest") {
        const decoded = decodePayload(types.categoryGetRequest, requestEnvelope);
        const category = achievementState.getCategoryState(activeCharacterID, uuidFromIdentifier(decoded.category));
        return category
          ? ok("eve_public.achievement.category.api.GetResponse", types.categoryGetResponse, {
            score: category.score,
            reached_milestones: [],
          })
          : error("eve_public.achievement.category.api.GetResponse", 404);
      }
      if (requestTypeName === "eve_public.achievement.showcase.api.GetCharacterScoreRequest") {
        const decoded = decodePayload(types.scoreGetRequest, requestEnvelope);
        const requestedCharacterID = Number(decoded.character && decoded.character.sequential) || activeCharacterID;
        return ok("eve_public.achievement.showcase.api.GetCharacterScoreResponse", types.scoreGetResponse, {
          score: achievementState.getCharacterScore(requestedCharacterID),
        });
      }
      if (requestTypeName === "eve_public.achievement.reward.api.GetUnclaimedRequest") {
        const decoded = decodePayload(types.rewardGetRequest, requestEnvelope);
        const page = normalizePageRequest(decoded.page, 100);
        const sources = achievementState.getUnclaimedRewardSources(activeCharacterID);
        const items = sources.slice(page.offset, page.offset + page.size);
        const nextOffset = page.offset + page.size;
        return ok("eve_public.achievement.reward.api.GetUnclaimedResponse", types.rewardGetResponse, {
          rewards: items.map(buildRewardPayload),
          next_page: { token: nextOffset < sources.length ? String(nextOffset) : "" },
        });
      }
      if (requestTypeName === "eve_public.achievement.reward.api.ClaimRequest") {
        const decoded = decodePayload(types.rewardClaimRequest, requestEnvelope);
        const source = extractRewardSource(decoded);
        if (!source || !activeCharacterID) {
          return error("eve_public.achievement.reward.api.ClaimResponse", 400, "invalid reward source");
        }
        return achievementState.claimRewards(activeCharacterID, source).then((result) =>
          result && result.success
            ? ok("eve_public.achievement.reward.api.ClaimResponse", types.rewardClaimResponse)
            : error(
              "eve_public.achievement.reward.api.ClaimResponse",
              result && result.errorMsg === "REWARD_SOURCE_NOT_FOUND" ? 404 : 409,
              result && result.errorMsg || "reward claim failed",
            ));
      }
      if (requestTypeName === "eve_public.cosmetic.character.title.api.GetOwnedRequest") {
        const decoded = decodePayload(types.titleOwnedRequest, requestEnvelope);
        const page = normalizePageRequest(decoded.page, 100);
        const titles = achievementState.getOwnedTitles(activeCharacterID);
        const items = titles.slice(page.offset, page.offset + page.size);
        const nextOffset = page.offset + page.size;
        return ok("eve_public.cosmetic.character.title.api.GetOwnedResponse", types.titleOwnedResponse, {
          titles: items.map(identifier),
          next_page: { token: nextOffset < titles.length ? String(nextOffset) : "" },
        });
      }
      if (requestTypeName === "eve_public.cosmetic.character.title.api.GetEquippedForCharacterRequest") {
        const decoded = decodePayload(types.titleEquippedRequest, requestEnvelope);
        const characterID = Number(decoded.character && decoded.character.sequential) || activeCharacterID;
        const titleID = achievementState.getEquippedTitle(characterID);
        return ok("eve_public.cosmetic.character.title.api.GetEquippedForCharacterResponse", types.titleEquippedResponse,
          titleID ? { title: identifier(titleID) } : { no_title: true });
      }
      if (requestTypeName === "eve_public.cosmetic.character.title.api.EquipRequest") {
        const decoded = decodePayload(types.titleEquipRequest, requestEnvelope);
        const result = achievementState.equipTitle(activeCharacterID, uuidFromIdentifier(decoded.title));
        return result.success
          ? ok("eve_public.cosmetic.character.title.api.EquipResponse", types.titleEquipResponse)
          : error("eve_public.cosmetic.character.title.api.EquipResponse", 409, result.errorMsg || "title equip failed");
      }
      if (requestTypeName === "eve_public.cosmetic.character.title.api.UnequipRequest") {
        const result = achievementState.unequipTitle(activeCharacterID);
        return result.success
          ? ok("eve_public.cosmetic.character.title.api.UnequipResponse", types.titleUnequipResponse)
          : error("eve_public.cosmetic.character.title.api.UnequipResponse", 400, result.errorMsg || "title unequip failed");
      }
      return null;
    },
  };
}

module.exports = {
  HANDLED_REQUEST_TYPES,
  createAchievementGatewayService,
  getAchievementCdnAsset,
};
