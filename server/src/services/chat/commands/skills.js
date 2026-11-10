"use strict";

// Skill chat commands: /giveskill and /removeskill (a skill by name or type ID, or all of them,
// for a target character), /allskills (every published skill) and /gmskills (every unpublished
// skill) for the caller, /backintime (restore a character's starter skills) and /expertsystem
// (list, inspect, status, add, remove, clear, giveitem, consume), with the skill lookup, the live
// session refresh after a change and the skill notification helpers. Five of those helpers
// (normalizeSkillInventoryItem to buildSkillNotificationDict) had no caller when they moved
// here; they came along unchanged.

const path = require("path");

const {
  getCharacterRecord,
  giveItemToHangarForSession,
} = require("../../character/characterState");
const sessionRegistry = require("../sessionRegistry");
const {
  resolveItemByTypeID,
} = require("../../inventory/itemTypeRegistry");
const {
  getSkillTypes,
  getPublishedSkillTypes,
  grantCharacterSkillLevels,
  getUnpublishedSkillTypes,
  clearCharacterSkills,
  removeCharacterSkillTypes,
  getCharacterSkillMap,
  ensureCharacterUnpublishedSkills,
  ensureCharacterPublishedSkills,
} = require("../../skills/skillState");
const {
  reconcileQueueForSkillMutation,
  resetCharacterSkillsToStarterProfile,
} = require("../../skills/skillAdminRuntime");
const {
  emitSkillSessionState,
} = require("../../skills/training/skillQueueNotifications");
const {
  getQueueSnapshot,
} = require("../../skills/training/skillQueueRuntime");
const {
  resolveExpertSystemQuery: resolveExpertSystemCatalogQuery,
  getExpertSystemByTypeID,
  listExpertSystems,
} = require("../../skills/expertSystems/expertSystemCatalog");
const {
  getExpertSystemStatus,
  installExpertSystemForCharacter,
  clearExpertSystemsForCharacter,
  removeExpertSystemFromCharacter,
  consumeExpertSystemItem,
} = require("../../skills/expertSystems/expertSystemRuntime");
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizeCommandName,
  normalizePositiveInteger,
  tokenizeQuotedArguments,
} = require(path.join(__dirname, "./commandArguments"));
const {
  levenshteinDistance,
  formatSuggestions,
} = require(path.join(__dirname, "./commandSuggestions"));
const {
  resolveCharacterTargetDescriptor,
  formatCharacterTargetLabel,
} = require(path.join(__dirname, "./characterTargets"));

function parseStrictInteger(value) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) {
    return null;
  }

  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.trunc(numeric);
}

function clampSkillGrantLevel(value, fallback = 5) {
  const parsed = parseStrictInteger(value);
  const normalized = parsed === null ? fallback : parsed;
  return Math.max(0, Math.min(5, normalized));
}

function formatSkillLevelLabel(level) {
  const normalizedLevel = Math.max(0, Math.min(5, Number(level) || 0));
  const labels = ["0", "I", "II", "III", "IV", "V"];
  return labels[normalizedLevel] || String(normalizedLevel);
}

function suggestSkillNames(skillTypes, query) {
  const normalizedQuery = normalizeCommandName(query);
  if (!normalizedQuery) {
    return [];
  }

  return (Array.isArray(skillTypes) ? skillTypes : [])
    .map((skillType) => {
      const name = String(skillType && skillType.name || "");
      const normalizedName = normalizeCommandName(name);
      let score = levenshteinDistance(normalizedQuery, normalizedName);
      if (normalizedName.startsWith(normalizedQuery)) {
        score = Math.min(score, 0);
      } else if (normalizedName.includes(normalizedQuery)) {
        score = Math.min(score, 1);
      }
      return {
        skillType,
        score,
      };
    })
    .filter((entry) => entry.skillType && entry.score <= 6)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return String(left.skillType.name || "").localeCompare(
        String(right.skillType.name || ""),
      );
    })
    .slice(0, 5)
    .map((entry) => `${entry.skillType.name}(${entry.skillType.typeID})`);
}

function resolveSkillGrantDescriptor(skillToken) {
  const normalizedToken = String(skillToken || "").trim();
  const normalizedQuery = normalizeCommandName(normalizedToken);
  if (!normalizedQuery) {
    return {
      success: false,
      errorMsg: "SKILL_REQUIRED",
    };
  }

  if (normalizedQuery === "all") {
    return {
      success: true,
      data: {
        selector: "all",
      },
    };
  }

  if (normalizedQuery === "super") {
    return {
      success: true,
      data: {
        selector: "super",
      },
    };
  }

  const skillTypes = getSkillTypes({ refresh: true });
  const numericTypeID = normalizePositiveInteger(normalizedToken);
  if (numericTypeID) {
    const match = skillTypes.find(
      (skillType) => Number(skillType && skillType.typeID) === numericTypeID,
    );
    if (!match) {
      return {
        success: false,
        errorMsg: "SKILL_NOT_FOUND",
        suggestions: [],
      };
    }

    return {
      success: true,
      data: {
        selector: "single",
        skillType: match,
      },
    };
  }

  const exactMatches = skillTypes.filter((skillType) => (
    normalizeCommandName(skillType && skillType.name) === normalizedQuery
  ));
  if (exactMatches.length === 1) {
    return {
      success: true,
      data: {
        selector: "single",
        skillType: exactMatches[0],
      },
    };
  }

  if (exactMatches.length > 1) {
    return {
      success: false,
      errorMsg: "SKILL_AMBIGUOUS",
      suggestions: exactMatches
        .slice(0, 5)
        .map((skillType) => `${skillType.name}(${skillType.typeID})`),
    };
  }

  return {
    success: false,
    errorMsg: "SKILL_NOT_FOUND",
    suggestions: suggestSkillNames(skillTypes, normalizedToken),
  };
}

function parseGiveSkillArguments(argumentText) {
  const tokens = tokenizeQuotedArguments(argumentText);
  if (tokens.length < 2) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  let level = 5;
  let requestedLevel = null;
  let skillTokens = tokens.slice(1);
  if (tokens.length >= 3) {
    const trailingLevel = parseStrictInteger(tokens[tokens.length - 1]);
    if (trailingLevel !== null) {
      requestedLevel = trailingLevel;
      level = clampSkillGrantLevel(trailingLevel, 5);
      skillTokens = tokens.slice(1, -1);
    }
  }

  const skillToken = skillTokens.join(" ").trim();
  if (!skillToken) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  return {
    success: true,
    data: {
      targetToken: tokens[0],
      skillToken,
      level,
      requestedLevel,
    },
  };
}

function resolveSkillRemovalDescriptor(skillToken) {
  const normalizedToken = String(skillToken || "").trim();
  const normalizedQuery = normalizeCommandName(normalizedToken);
  if (!normalizedQuery) {
    return {
      success: false,
      errorMsg: "SKILL_REQUIRED",
    };
  }

  if (normalizedQuery === "all") {
    return {
      success: true,
      data: {
        selector: "all",
      },
    };
  }

  const skillTypes = getSkillTypes({ refresh: true });
  const numericTypeID = normalizePositiveInteger(normalizedToken);
  if (numericTypeID) {
    const match = skillTypes.find(
      (skillType) => Number(skillType && skillType.typeID) === numericTypeID,
    );
    if (!match) {
      return {
        success: false,
        errorMsg: "SKILL_NOT_FOUND",
        suggestions: [],
      };
    }

    return {
      success: true,
      data: {
        selector: "single",
        skillType: match,
      },
    };
  }

  const exactMatches = skillTypes.filter((skillType) => (
    normalizeCommandName(skillType && skillType.name) === normalizedQuery
  ));
  if (exactMatches.length === 1) {
    return {
      success: true,
      data: {
        selector: "single",
        skillType: exactMatches[0],
      },
    };
  }

  if (exactMatches.length > 1) {
    return {
      success: false,
      errorMsg: "SKILL_AMBIGUOUS",
      suggestions: exactMatches
        .slice(0, 5)
        .map((skillType) => `${skillType.name}(${skillType.typeID})`),
    };
  }

  return {
    success: false,
    errorMsg: "SKILL_NOT_FOUND",
    suggestions: suggestSkillNames(skillTypes, normalizedToken),
  };
}

function parseRemoveSkillArguments(argumentText) {
  const tokens = tokenizeQuotedArguments(argumentText);
  if (tokens.length < 2) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  const skillToken = tokens.slice(1).join(" ").trim();
  if (!skillToken) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  return {
    success: true,
    data: {
      targetToken: tokens[0],
      skillToken,
    },
  };
}

function parseBackInTimeArguments(argumentText) {
  const tokens = tokenizeQuotedArguments(argumentText);
  if (tokens.length === 0) {
    return {
      success: true,
      data: {
        targetToken: "me",
      },
    };
  }

  return {
    success: true,
    data: {
      targetToken: tokens.join(" ").trim() || "me",
    },
  };
}

function dedupeSkillRecords(skillRecords = []) {
  const recordsByTypeID = new Map();
  for (const skillRecord of Array.isArray(skillRecords) ? skillRecords : []) {
    const typeID = normalizePositiveInteger(skillRecord && skillRecord.typeID);
    if (!typeID) {
      continue;
    }
    recordsByTypeID.set(typeID, skillRecord);
  }

  return Array.from(recordsByTypeID.values());
}

function filterChangedSkillRecords(skillRecords = [], previousSkillMap = null) {
  const dedupedSkillRecords = dedupeSkillRecords(skillRecords);
  if (!(previousSkillMap instanceof Map)) {
    return dedupedSkillRecords;
  }

  return dedupedSkillRecords.filter((skillRecord) => {
    const typeID = normalizePositiveInteger(skillRecord && skillRecord.typeID);
    if (!typeID) {
      return false;
    }

    const previousSkillRecord = previousSkillMap.get(typeID) || null;
    return JSON.stringify(previousSkillRecord) !== JSON.stringify(skillRecord);
  });
}

function skillMutationLowersExistingLevels(skillRecords = [], previousSkillMap = null) {
  if (!(previousSkillMap instanceof Map)) {
    return false;
  }

  return dedupeSkillRecords(skillRecords).some((skillRecord) => {
    const typeID = normalizePositiveInteger(skillRecord && skillRecord.typeID);
    if (!typeID) {
      return false;
    }

    const previousSkillRecord = previousSkillMap.get(typeID);
    if (!previousSkillRecord) {
      return false;
    }

    const previousPoints = Number(
      previousSkillRecord.trainedSkillPoints ?? previousSkillRecord.skillPoints ?? 0,
    ) || 0;
    const nextPoints = Number(
      skillRecord.trainedSkillPoints ?? skillRecord.skillPoints ?? 0,
    ) || 0;
    if (nextPoints < previousPoints) {
      return true;
    }

    const previousLevel = Number(
      previousSkillRecord.trainedSkillLevel ?? previousSkillRecord.skillLevel ?? 0,
    ) || 0;
    const nextLevel = Number(
      skillRecord.trainedSkillLevel ?? skillRecord.skillLevel ?? 0,
    ) || 0;
    return nextLevel < previousLevel;
  });
}

function queueSnapshotChanged(previousSnapshot = null, nextSnapshot = null) {
  const previousActive = Boolean(previousSnapshot && previousSnapshot.active);
  const nextActive = Boolean(nextSnapshot && nextSnapshot.active);
  if (previousActive !== nextActive) {
    return true;
  }

  const previousEntries =
    previousSnapshot && Array.isArray(previousSnapshot.queueEntries)
      ? previousSnapshot.queueEntries
      : [];
  const nextEntries =
    nextSnapshot && Array.isArray(nextSnapshot.queueEntries)
      ? nextSnapshot.queueEntries
      : [];
  if (previousEntries.length !== nextEntries.length) {
    return true;
  }

  for (let index = 0; index < previousEntries.length; index += 1) {
    const previousEntry = previousEntries[index];
    const nextEntry = nextEntries[index];
    if (
      normalizePositiveInteger(previousEntry && previousEntry.trainingTypeID) !==
        normalizePositiveInteger(nextEntry && nextEntry.trainingTypeID) ||
      normalizePositiveInteger(previousEntry && previousEntry.trainingToLevel) !==
        normalizePositiveInteger(nextEntry && nextEntry.trainingToLevel)
    ) {
      return true;
    }
  }

  return false;
}

function normalizeSkillInventoryItem(skillRecord) {
  if (!skillRecord || typeof skillRecord !== "object") {
    return null;
  }

  return {
    ...skillRecord,
    quantity: 1,
    singleton: 1,
    stacksize: 1,
    customInfo: skillRecord.customInfo || "",
  };
}

function buildRemovedSkillNotificationRecord(skillRecord) {
  if (!skillRecord || typeof skillRecord !== "object") {
    return null;
  }

  return {
    ...skillRecord,
    locationID: 0,
    flagID: 0,
    skillLevel: 0,
    trainedSkillLevel: 0,
    effectiveSkillLevel: 0,
    virtualSkillLevel: null,
    skillPoints: 0,
    trainedSkillPoints: 0,
    inTraining: false,
    trainingStartSP: 0,
    trainingDestinationSP: 0,
    trainingStartTime: null,
    trainingEndTime: null,
  };
}

function buildRemovedSkillInventoryItem(skillRecord) {
  const normalizedSkillItem = normalizeSkillInventoryItem(skillRecord);
  if (!normalizedSkillItem) {
    return null;
  }

  return {
    ...normalizedSkillItem,
    locationID: 0,
    flagID: 0,
    quantity: 0,
    singleton: 0,
    stacksize: 0,
  };
}

function buildSkillNotificationInfo(skillRecord) {
  return {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries: [
        ["itemID", skillRecord.itemID],
        ["typeID", skillRecord.typeID],
        ["ownerID", skillRecord.ownerID],
        ["locationID", skillRecord.locationID],
        ["flagID", skillRecord.flagID],
        ["groupID", skillRecord.groupID],
        ["groupName", skillRecord.groupName || ""],
        ["skillLevel", skillRecord.skillLevel],
        ["trainedSkillLevel", skillRecord.trainedSkillLevel],
        ["effectiveSkillLevel", skillRecord.effectiveSkillLevel],
        ["virtualSkillLevel", skillRecord.virtualSkillLevel ?? null],
        ["skillRank", skillRecord.skillRank || 1],
        ["skillPoints", skillRecord.skillPoints],
        [
          "trainedSkillPoints",
          skillRecord.trainedSkillPoints ?? skillRecord.skillPoints,
        ],
        ["published", Boolean(skillRecord.published)],
        ["inTraining", Boolean(skillRecord.inTraining)],
      ],
    },
  };
}

function buildSkillNotificationDict(skillRecords = []) {
  return {
    type: "dict",
    entries: dedupeSkillRecords(skillRecords)
      .map((skillRecord) => {
        const typeID = normalizePositiveInteger(skillRecord && skillRecord.typeID);
        if (!typeID) {
          return null;
        }
        return [typeID, buildSkillNotificationInfo(skillRecord)];
      })
      .filter(Boolean),
  };
}

function refreshLiveCharacterSkillSession(
  targetSession,
  targetDescriptor,
  changedSkillRecords = [],
  previousSkillMap = null,
  options = {},
) {
  const characterID = normalizePositiveInteger(targetDescriptor.characterID);
  if (!characterID) {
    return;
  }

  const changedSkills = dedupeSkillRecords(changedSkillRecords);
  const removedSkills = dedupeSkillRecords(options && options.removedSkillRecords);
  const queueSnapshot =
    options && options.queueSnapshot && typeof options.queueSnapshot === "object"
      ? options.queueSnapshot
      : null;
  const hasQueueState =
    queueSnapshot &&
    Array.isArray(queueSnapshot.queueEntries);
  const hasFreeSkillPoints =
    options &&
    Object.prototype.hasOwnProperty.call(options, "freeSkillPoints");
  if (
    changedSkills.length === 0 &&
    removedSkills.length === 0 &&
    !hasQueueState &&
    !hasFreeSkillPoints
  ) {
    return;
  }

  emitSkillSessionState(targetSession, characterID, changedSkills, {
    removedSkillRecords: removedSkills,
    previousSkillMap,
    emitSkillLevelsTrained:
      options && Object.prototype.hasOwnProperty.call(options, "emitSkillLevelsTrained")
        ? Boolean(options.emitSkillLevelsTrained)
        : !(options && options.removed === true),
    queueEntries: hasQueueState ? queueSnapshot.queueEntries : undefined,
    emitQueuePaused: Boolean(
      hasQueueState &&
      (!queueSnapshot.active || queueSnapshot.queueEntries.length === 0),
    ),
    freeSkillPoints: hasFreeSkillPoints ? options.freeSkillPoints : undefined,
  });
}

function applySkillGrantToCharacter(
  targetDescriptor,
  skillDescriptor,
  skillLevel,
  previousSkillMap = null,
) {
  const characterID = normalizePositiveInteger(
    targetDescriptor && targetDescriptor.characterID,
  );
  if (!characterID) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  const normalizedLevel = clampSkillGrantLevel(skillLevel, 5);
  if (skillDescriptor.selector === "all") {
    const publishedSkillTypes = getPublishedSkillTypes({ refresh: true });
    return {
      success: true,
      data: {
        changedSkills: filterChangedSkillRecords(
          grantCharacterSkillLevels(
            characterID,
            publishedSkillTypes.map((skillType) => ({
              typeID: skillType.typeID,
              level: normalizedLevel,
            })),
          ),
          previousSkillMap,
        ),
      },
    };
  }

  if (skillDescriptor.selector === "super") {
    const targetSkillLevels = [
      ...getPublishedSkillTypes({ refresh: true }),
      ...getUnpublishedSkillTypes({ refresh: true }),
    ].map((skillType) => ({
      typeID: skillType.typeID,
      level: normalizedLevel,
    }));
    return {
      success: true,
      data: {
        changedSkills: filterChangedSkillRecords(
          grantCharacterSkillLevels(characterID, targetSkillLevels),
          previousSkillMap,
        ),
      },
    };
  }

  if (skillDescriptor.selector === "single" && skillDescriptor.skillType) {
    return {
      success: true,
      data: {
        changedSkills: filterChangedSkillRecords(
          grantCharacterSkillLevels(characterID, [
            {
              typeID: skillDescriptor.skillType.typeID,
              level: normalizedLevel,
            },
          ]),
          previousSkillMap,
        ),
      },
    };
  }

  return {
    success: false,
    errorMsg: "SKILL_NOT_FOUND",
  };
}

function applySkillRemovalToCharacter(targetDescriptor, skillDescriptor) {
  const characterID = normalizePositiveInteger(
    targetDescriptor && targetDescriptor.characterID,
  );
  if (!characterID) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  if (skillDescriptor.selector === "all") {
    return {
      success: true,
      data: {
        changedSkills: clearCharacterSkills(characterID),
      },
    };
  }

  if (skillDescriptor.selector === "single" && skillDescriptor.skillType) {
    return {
      success: true,
      data: {
        changedSkills: removeCharacterSkillTypes(characterID, [
          skillDescriptor.skillType.typeID,
        ]),
      },
    };
  }

  return {
    success: false,
    errorMsg: "SKILL_NOT_FOUND",
  };
}

function handleGmSkillsCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /gmskills.",
    );
  }

  const unpublishedSkillTypes = getUnpublishedSkillTypes({ refresh: true });
  if (unpublishedSkillTypes.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No unpublished skill types are available in local reference data.",
    );
  }

  const previousQueueSnapshot = getQueueSnapshot(session.characterID);
  const previousSkillMap = getCharacterSkillMap(session.characterID);
  const grantedSkills = ensureCharacterUnpublishedSkills(session.characterID);
  reconcileQueueForSkillMutation(
    session.characterID,
    "prune_satisfied",
  );
  const nextQueueSnapshot = getQueueSnapshot(session.characterID);
  const targetDescriptor = {
    characterID: session.characterID,
    record: getCharacterRecord(session.characterID),
    session: sessionRegistry.findSessionByCharacterID(session.characterID) || session,
  };
  refreshLiveCharacterSkillSession(
    targetDescriptor.session,
    targetDescriptor,
    grantedSkills,
    previousSkillMap,
    {
      queueSnapshot: queueSnapshotChanged(previousQueueSnapshot, nextQueueSnapshot)
        ? nextQueueSnapshot
        : undefined,
    },
  );
  const polarisSkill = unpublishedSkillTypes.find((skillType) => Number(skillType.typeID) === 9955);
  const sampleNames = grantedSkills
    .slice(0, 5)
    .map((skill) => `${skill.itemName}(${skill.typeID})`)
    .join(", ");

  return handledResult(
    chatHub,
    session,
    options,
    [
      grantedSkills.length > 0
        ? `Ensured ${grantedSkills.length} GM/unpublished skills are at level V. You now have ${unpublishedSkillTypes.length}/${unpublishedSkillTypes.length}.`
        : `No GM/unpublished skills needed changes. You already have ${unpublishedSkillTypes.length}/${unpublishedSkillTypes.length}.`,
      polarisSkill ? `Catalog includes ${polarisSkill.name}(${polarisSkill.typeID}).` : null,
      sampleNames ? `Added: ${sampleNames}.` : null,
    ].filter(Boolean).join(" "),
  );
}

function handleAllSkillsCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /allskills.",
    );
  }

  const publishedSkillTypes = getPublishedSkillTypes({ refresh: true });
  if (publishedSkillTypes.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No published skill types are available in local reference data.",
    );
  }

  const previousQueueSnapshot = getQueueSnapshot(session.characterID);
  const previousSkillMap = getCharacterSkillMap(session.characterID);
  const grantedSkills = ensureCharacterPublishedSkills(session.characterID);
  reconcileQueueForSkillMutation(
    session.characterID,
    "prune_satisfied",
  );
  const nextQueueSnapshot = getQueueSnapshot(session.characterID);
  const targetDescriptor = {
    characterID: session.characterID,
    record: getCharacterRecord(session.characterID),
    session: sessionRegistry.findSessionByCharacterID(session.characterID) || session,
  };
  refreshLiveCharacterSkillSession(
    targetDescriptor.session,
    targetDescriptor,
    grantedSkills,
    previousSkillMap,
    {
      queueSnapshot: queueSnapshotChanged(previousQueueSnapshot, nextQueueSnapshot)
        ? nextQueueSnapshot
        : undefined,
    },
  );
  const sampleNames = grantedSkills
    .slice(0, 5)
    .map((skill) => `${skill.itemName}(${skill.typeID})`)
    .join(", ");

  return handledResult(
    chatHub,
    session,
    options,
    [
      grantedSkills.length > 0
        ? `Ensured ${grantedSkills.length} published skills are at level V. You now have ${publishedSkillTypes.length}/${publishedSkillTypes.length}.`
        : `No published skills needed changes. You already have ${publishedSkillTypes.length}/${publishedSkillTypes.length}.`,
      sampleNames ? `Updated: ${sampleNames}.` : null,
    ].filter(Boolean).join(" "),
  );
}

function handleBackInTimeCommand(session, argumentText, chatHub, options) {
  const parsed = parseBackInTimeArguments(argumentText);
  if (!parsed.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /backintime [me|characterID|character name]",
    );
  }

  const targetResult = resolveCharacterTargetDescriptor(
    session,
    parsed.data.targetToken,
  );
  if (!targetResult.success) {
    const message =
      targetResult.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /backintime me."
        : `Character not found: ${parsed.data.targetToken}. Use me, a character ID, or an exact character name.`;
    return handledResult(chatHub, session, options, message);
  }

  const targetDescriptor = targetResult.data;
  const resetResult = resetCharacterSkillsToStarterProfile(
    targetDescriptor.characterID,
  );
  if (!resetResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      resetResult.errorMsg === "STARTER_PROFILE_NOT_FOUND"
        ? "No starter skill profile exists for that character's bloodline/race."
        : "Failed to restore starter skills.",
    );
  }

  const starterReset = resetResult.data;
  refreshLiveCharacterSkillSession(
    targetDescriptor.session,
    targetDescriptor,
    starterReset.changedSkillRecords,
    starterReset.previousSkillMap,
    {
      removedSkillRecords: starterReset.removedSkillRecords,
      emitSkillLevelsTrained: false,
      queueSnapshot: starterReset.queueSnapshot,
      freeSkillPoints: starterReset.freeSkillPoints,
    },
  );

  const targetLabel = formatCharacterTargetLabel(targetDescriptor);
  const starterProfile = starterReset.starterProfile;
  const queueCleared =
    starterReset.queueSnapshot &&
    Array.isArray(starterReset.queueSnapshot.queueEntries) &&
    starterReset.queueSnapshot.queueEntries.length === 0;

  return handledResult(
    chatHub,
    session,
    options,
    [
      `Reset ${targetLabel} to the ${starterProfile.raceName} starter skill bundle for ${starterProfile.bloodlineName}.`,
      `Restored ${starterProfile.starterSkills.length} starter skill records.`,
      starterReset.removedSkillRecords.length > 0
        ? `Removed ${starterReset.removedSkillRecords.length} non-starter skill records.`
        : "No non-starter skill records needed removal.",
      `Total SP is now ${Number(starterReset.totalSkillPoints || 0).toLocaleString()} and free SP is ${Number(starterReset.freeSkillPoints || 0).toLocaleString()}.`,
      queueCleared ? "Training queue cleared." : null,
    ].filter(Boolean).join(" "),
  );
}

function resolveExpertSystemFromTokens(tokens, startIndex = 0) {
  const sourceTokens = Array.isArray(tokens) ? tokens : [];
  for (let endIndex = sourceTokens.length; endIndex > startIndex; endIndex -= 1) {
    const queryText = sourceTokens.slice(startIndex, endIndex).join(" ").trim();
    if (!queryText) {
      continue;
    }
    const resolveResult = resolveExpertSystemCatalogQuery(queryText, {
      includeHidden: true,
      includeRetired: true,
    });
    if (resolveResult.success) {
      return {
        success: true,
        data: {
          expertSystem: resolveResult.data,
          consumedTokens: endIndex - startIndex,
          tailTokens: sourceTokens.slice(endIndex),
        },
      };
    }
    if (endIndex === startIndex + 1) {
      return resolveResult;
    }
  }

  return {
    success: false,
    errorMsg: "EXPERT_SYSTEM_REQUIRED",
    suggestions: [],
  };
}

function parseExpertSystemTail(tailTokens = []) {
  const targetTokens = [];
  let durationDays = null;
  for (const token of Array.isArray(tailTokens) ? tailTokens : []) {
    const text = String(token || "").trim();
    if (!text) {
      continue;
    }
    const durationMatch = /^(?:days|duration)=(\d+(?:\.\d+)?)$/i.exec(text);
    if (durationMatch) {
      const parsedDays = Number(durationMatch[1]);
      if (Number.isFinite(parsedDays) && parsedDays > 0) {
        durationDays = parsedDays;
      }
      continue;
    }
    targetTokens.push(text);
  }

  return {
    targetToken: targetTokens.join(" ").trim() || "me",
    durationDays,
  };
}

function resolveExpertSystemCommandTarget(session, targetToken) {
  const targetResult = resolveCharacterTargetDescriptor(session, targetToken || "me");
  if (targetResult.success) {
    return targetResult;
  }

  const message =
    targetResult.errorMsg === "CHARACTER_NOT_SELECTED"
      ? "Select a character first, or pass an explicit character target."
      : `Character not found: ${targetToken || "me"}. Use me, a character ID, or an exact character name.`;
  return {
    ...targetResult,
    message,
  };
}

function formatExpertSystemSummary(expertSystem) {
  if (!expertSystem) {
    return "Expert System";
  }
  return `${expertSystem.name}(${expertSystem.typeID})`;
}

function formatExpertSystemStatusLine(entry) {
  const expertSystem = entry && entry.expertSystem
    ? entry.expertSystem
    : getExpertSystemByTypeID(entry && entry.typeID);
  const expiresAtMs = Number(entry && entry.expiresAtMs) || 0;
  const remainingMs = Math.max(0, expiresAtMs - Date.now());
  const remainingDays = remainingMs / (24 * 60 * 60 * 1000);
  return [
    formatExpertSystemSummary(expertSystem || { typeID: entry && entry.typeID }),
    expiresAtMs > 0 ? `expires ${new Date(expiresAtMs).toISOString()}` : null,
    expiresAtMs > 0 ? `${remainingDays.toFixed(1)} days left` : null,
  ].filter(Boolean).join(" - ");
}

function handleExpertSystemCommand(session, argumentText, chatHub, options) {
  const tokens = tokenizeQuotedArguments(argumentText);
  const subcommand = normalizeCommandName(tokens[0] || "status");

  if (subcommand === "help") {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /expertsystem list | inspect <type|name> | status [me|characterID|name] | add <type|name> [target] [days=N] | remove <type|name|all> [target] | clear [target] | giveitem <type|name> [qty] | consume <itemID>",
    );
  }

  if (subcommand === "list") {
    const expertSystems = listExpertSystems({
      includeHidden: true,
      includeRetired: true,
    });
    const visibleCount = expertSystems.filter((entry) => !entry.hidden && !entry.retired).length;
    const sample = expertSystems
      .slice(0, 16)
      .map(formatExpertSystemSummary)
      .join(", ");
    return handledResult(
      chatHub,
      session,
      options,
      `Expert Systems authority contains ${expertSystems.length} systems (${visibleCount} normally activatable). ${sample ? `First entries: ${sample}.` : ""}`,
    );
  }

  if (subcommand === "status") {
    const targetText = tokens.slice(1).join(" ").trim() || "me";
    const targetResult = resolveExpertSystemCommandTarget(session, targetText);
    if (!targetResult.success) {
      return handledResult(chatHub, session, options, targetResult.message);
    }
    const targetDescriptor = targetResult.data;
    const status = getExpertSystemStatus(targetDescriptor.characterID);
    const activeEntries = Array.isArray(status.activeEntries) ? status.activeEntries : [];
    const targetLabel = formatCharacterTargetLabel(targetDescriptor);
    if (activeEntries.length === 0) {
      return handledResult(
        chatHub,
        session,
        options,
        `${targetLabel} has no active Expert Systems. Catalog count: ${status.catalogCount}.`,
      );
    }
    return handledResult(
      chatHub,
      session,
      options,
      `${targetLabel} has ${activeEntries.length} active Expert Systems: ${activeEntries.map(formatExpertSystemStatusLine).join("; ")}.`,
    );
  }

  if (subcommand === "inspect" || subcommand === "info") {
    const expertResult = resolveExpertSystemFromTokens(tokens, 1);
    if (!expertResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `Expert System not found.${formatSuggestions(expertResult.suggestions)}`,
      );
    }
    const expertSystem = expertResult.data.expertSystem;
    return handledResult(
      chatHub,
      session,
      options,
      [
        `${formatExpertSystemSummary(expertSystem)} lasts ${expertSystem.durationDays} days.`,
        `Skills granted: ${expertSystem.skillsGranted.length}.`,
        expertSystem.associatedTypeIDs.length > 0
          ? `Associated item types: ${expertSystem.associatedTypeIDs.slice(0, 12).join(", ")}${expertSystem.associatedTypeIDs.length > 12 ? ", ..." : ""}.`
          : null,
        expertSystem.hidden ? "Hidden." : null,
        expertSystem.retired ? "Retired." : null,
      ].filter(Boolean).join(" "),
    );
  }

  if (subcommand === "add" || subcommand === "install") {
    const expertResult = resolveExpertSystemFromTokens(tokens, 1);
    if (!expertResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `Expert System not found.${formatSuggestions(expertResult.suggestions)}`,
      );
    }
    const tail = parseExpertSystemTail(expertResult.data.tailTokens);
    const targetResult = resolveExpertSystemCommandTarget(session, tail.targetToken);
    if (!targetResult.success) {
      return handledResult(chatHub, session, options, targetResult.message);
    }
    const expertSystem = expertResult.data.expertSystem;
    const targetDescriptor = targetResult.data;
    const installResult = installExpertSystemForCharacter(
      targetDescriptor.characterID,
      expertSystem.typeID,
      {
        session: targetDescriptor.session,
        force: true,
        grantReason: "gm",
        durationDays: tail.durationDays || undefined,
      },
    );
    if (!installResult.success) {
      return handledResult(chatHub, session, options, installResult.message || "Expert System install failed.");
    }
    return handledResult(
      chatHub,
      session,
      options,
      `Installed ${formatExpertSystemSummary(expertSystem)} for ${formatCharacterTargetLabel(targetDescriptor)}${installResult.data.isTopUp ? " as a top-up" : ""}.`,
    );
  }

  if (subcommand === "remove" || subcommand === "uninstall") {
    if (normalizeCommandName(tokens[1] || "") === "all") {
      const targetText = tokens.slice(2).join(" ").trim() || "me";
      const targetResult = resolveExpertSystemCommandTarget(session, targetText);
      if (!targetResult.success) {
        return handledResult(chatHub, session, options, targetResult.message);
      }
      const clearResult = clearExpertSystemsForCharacter(targetResult.data.characterID, {
        session: targetResult.data.session,
      });
      if (!clearResult.success) {
        return handledResult(chatHub, session, options, clearResult.message || "Expert System clear failed.");
      }
      return handledResult(
        chatHub,
        session,
        options,
        `Removed ${Array.isArray(clearResult.data) ? clearResult.data.length : 0} Expert Systems from ${formatCharacterTargetLabel(targetResult.data)}.`,
      );
    }

    const expertResult = resolveExpertSystemFromTokens(tokens, 1);
    if (!expertResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `Expert System not found.${formatSuggestions(expertResult.suggestions)}`,
      );
    }
    const tail = parseExpertSystemTail(expertResult.data.tailTokens);
    const targetResult = resolveExpertSystemCommandTarget(session, tail.targetToken);
    if (!targetResult.success) {
      return handledResult(chatHub, session, options, targetResult.message);
    }
    const expertSystem = expertResult.data.expertSystem;
    const removeResult = removeExpertSystemFromCharacter(
      targetResult.data.characterID,
      expertSystem.typeID,
      { session: targetResult.data.session },
    );
    if (!removeResult.success) {
      return handledResult(chatHub, session, options, removeResult.message || "Expert System removal failed.");
    }
    return handledResult(
      chatHub,
      session,
      options,
      removeResult.removed
        ? `Removed ${formatExpertSystemSummary(expertSystem)} from ${formatCharacterTargetLabel(targetResult.data)}.`
        : `${formatCharacterTargetLabel(targetResult.data)} did not have ${formatExpertSystemSummary(expertSystem)} installed.`,
    );
  }

  if (subcommand === "clear") {
    const targetText = tokens.slice(1).join(" ").trim() || "me";
    const targetResult = resolveExpertSystemCommandTarget(session, targetText);
    if (!targetResult.success) {
      return handledResult(chatHub, session, options, targetResult.message);
    }
    const clearResult = clearExpertSystemsForCharacter(targetResult.data.characterID, {
      session: targetResult.data.session,
    });
    if (!clearResult.success) {
      return handledResult(chatHub, session, options, clearResult.message || "Expert System clear failed.");
    }
    return handledResult(
      chatHub,
      session,
      options,
      `Cleared ${Array.isArray(clearResult.data) ? clearResult.data.length : 0} Expert Systems from ${formatCharacterTargetLabel(targetResult.data)}.`,
    );
  }

  if (subcommand === "giveitem") {
    const expertResult = resolveExpertSystemFromTokens(tokens, 1);
    if (!expertResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `Expert System not found.${formatSuggestions(expertResult.suggestions)}`,
      );
    }
    const quantityToken = expertResult.data.tailTokens.find((token) => parseStrictInteger(token) !== null);
    const quantity = Math.max(1, parseStrictInteger(quantityToken) || 1);
    const expertSystem = expertResult.data.expertSystem;
    const itemType = resolveItemByTypeID(expertSystem.typeID) || expertSystem;
    const giveResult = giveItemToHangarForSession(
      session,
      itemType,
      quantity,
    );
    if (!giveResult.success) {
      const message =
        giveResult.errorMsg === "DOCK_REQUIRED"
          ? "You must be docked before using /expertsystem giveitem."
          : giveResult.errorMsg === "CHARACTER_NOT_SELECTED"
            ? "Select a character before using /expertsystem giveitem."
            : "Expert System item grant failed.";
      return handledResult(chatHub, session, options, message);
    }
    return handledResult(
      chatHub,
      session,
      options,
      `Placed ${quantity}x ${formatExpertSystemSummary(expertSystem)} item in your hangar.`,
    );
  }

  if (subcommand === "consume") {
    const itemID = normalizePositiveInteger(tokens[1]);
    if (!itemID) {
      return handledResult(chatHub, session, options, "Usage: /expertsystem consume <itemID>");
    }
    const characterID = normalizePositiveInteger(session && session.characterID);
    if (!characterID) {
      return handledResult(chatHub, session, options, "Select a character before consuming an Expert System.");
    }
    const consumeResult = consumeExpertSystemItem(characterID, itemID, session, {
      throwOnError: false,
    });
    if (!consumeResult.success) {
      return handledResult(chatHub, session, options, consumeResult.message || "Expert System consume failed.");
    }
    return handledResult(
      chatHub,
      session,
      options,
      `Consumed ${formatExpertSystemSummary(consumeResult.data.expertSystem)} and installed it on your character.`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    "Usage: /expertsystem list | inspect <type|name> | status [target] | add <type|name> [target] [days=N] | remove <type|name|all> [target] | clear [target] | giveitem <type|name> [qty] | consume <itemID>",
  );
}

function handleGiveSkillCommand(session, argumentText, chatHub, options) {
  const parsed = parseGiveSkillArguments(argumentText);
  if (!parsed.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /giveskill <target> <skill name|typeID|all|super> [level]",
    );
  }

  const targetResult = resolveCharacterTargetDescriptor(
    session,
    parsed.data.targetToken,
  );
  if (!targetResult.success) {
    const message =
      targetResult.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /giveskill me."
        : `Character not found: ${parsed.data.targetToken}. Use me, a character ID, or an exact character name.`;
    return handledResult(chatHub, session, options, message);
  }

  const skillResult = resolveSkillGrantDescriptor(parsed.data.skillToken);
  if (!skillResult.success) {
    const suggestions = formatSuggestions(skillResult.suggestions);
    const label =
      skillResult.errorMsg === "SKILL_AMBIGUOUS"
        ? `Skill is ambiguous: ${parsed.data.skillToken}.${suggestions}`
        : `Skill not found: ${parsed.data.skillToken}.${suggestions}`;
    return handledResult(chatHub, session, options, label);
  }

  const targetDescriptor = targetResult.data;
  const skillDescriptor = skillResult.data;
  const previousQueueSnapshot = getQueueSnapshot(targetDescriptor.characterID);
  const previousSkillMap = getCharacterSkillMap(targetDescriptor.characterID);
  const grantResult = applySkillGrantToCharacter(
    targetDescriptor,
    skillDescriptor,
    parsed.data.level,
    previousSkillMap,
  );
  if (!grantResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Failed to update character skills.",
    );
  }

  const changedSkills = dedupeSkillRecords(grantResult.data.changedSkills);
  const clearQueueForMutation = skillMutationLowersExistingLevels(
    changedSkills,
    previousSkillMap,
  );
  const queueResult = reconcileQueueForSkillMutation(
    targetDescriptor.characterID,
    clearQueueForMutation ? "clear" : "prune_satisfied",
  );
  const nextQueueSnapshot = queueResult.snapshot || getQueueSnapshot(targetDescriptor.characterID);
  refreshLiveCharacterSkillSession(
    targetDescriptor.session,
    targetDescriptor,
    changedSkills,
    previousSkillMap,
    {
      emitSkillLevelsTrained: !clearQueueForMutation,
      queueSnapshot: queueSnapshotChanged(previousQueueSnapshot, nextQueueSnapshot)
        ? nextQueueSnapshot
        : undefined,
    },
  );

  const targetLabel = formatCharacterTargetLabel(targetDescriptor);
  const normalizedLevelLabel = formatSkillLevelLabel(parsed.data.level);
  const levelClampNotice =
    parsed.data.requestedLevel !== null && parsed.data.requestedLevel !== parsed.data.level
      ? ` Requested level ${parsed.data.requestedLevel} was clamped to ${parsed.data.level}.`
      : "";

  if (skillDescriptor.selector === "all") {
    return handledResult(
      chatHub,
      session,
      options,
      [
        `Set all published skills for ${targetLabel} to level ${normalizedLevelLabel}.`,
        changedSkills.length > 0
          ? `Updated ${changedSkills.length} skills.`
          : "All published skills already matched the requested level.",
        levelClampNotice.trim() || null,
      ].filter(Boolean).join(" "),
    );
  }

  if (skillDescriptor.selector === "super") {
    return handledResult(
      chatHub,
      session,
      options,
      [
        `Set all published and unpublished skills for ${targetLabel} to level ${normalizedLevelLabel}.`,
        changedSkills.length > 0
          ? `Updated ${changedSkills.length} skills.`
          : "All skills already matched the requested level.",
        levelClampNotice.trim() || null,
      ].filter(Boolean).join(" "),
    );
  }

  const skillType = skillDescriptor.skillType;
  return handledResult(
    chatHub,
    session,
    options,
    [
      changedSkills.length > 0
        ? `Set ${skillType.name}(${skillType.typeID}) for ${targetLabel} to level ${normalizedLevelLabel}.`
        : `${targetLabel} already has ${skillType.name}(${skillType.typeID}) at level ${normalizedLevelLabel}.`,
      levelClampNotice.trim() || null,
    ].filter(Boolean).join(" "),
  );
}

function handleRemoveSkillCommand(session, argumentText, chatHub, options) {
  const parsed = parseRemoveSkillArguments(argumentText);
  if (!parsed.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /removeskill <target> <skill name|typeID|all>",
    );
  }

  const targetResult = resolveCharacterTargetDescriptor(
    session,
    parsed.data.targetToken,
  );
  if (!targetResult.success) {
    const message =
      targetResult.errorMsg === "CHARACTER_NOT_SELECTED"
        ? "Select a character before using /removeskill me."
        : `Character not found: ${parsed.data.targetToken}. Use me, a character ID, or an exact character name.`;
    return handledResult(chatHub, session, options, message);
  }

  const skillResult = resolveSkillRemovalDescriptor(parsed.data.skillToken);
  if (!skillResult.success) {
    const suggestions = formatSuggestions(skillResult.suggestions);
    const label =
      skillResult.errorMsg === "SKILL_AMBIGUOUS"
        ? `Skill is ambiguous: ${parsed.data.skillToken}.${suggestions}`
        : `Skill not found: ${parsed.data.skillToken}.${suggestions}`;
    return handledResult(chatHub, session, options, label);
  }

  const targetDescriptor = targetResult.data;
  const skillDescriptor = skillResult.data;
  const previousQueueSnapshot = getQueueSnapshot(targetDescriptor.characterID);
  const previousSkillMap = getCharacterSkillMap(targetDescriptor.characterID);
  const removalResult = applySkillRemovalToCharacter(targetDescriptor, skillDescriptor);
  if (!removalResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Failed to update character skills.",
    );
  }

  const changedSkills = dedupeSkillRecords(removalResult.data.changedSkills);
  const queueResult = reconcileQueueForSkillMutation(
    targetDescriptor.characterID,
    "clear",
  );
  const nextQueueSnapshot = queueResult.snapshot || getQueueSnapshot(targetDescriptor.characterID);
  refreshLiveCharacterSkillSession(
    targetDescriptor.session,
    targetDescriptor,
    [],
    previousSkillMap,
    {
      removed: true,
      removedSkillRecords: changedSkills,
      queueSnapshot: queueSnapshotChanged(previousQueueSnapshot, nextQueueSnapshot)
        ? nextQueueSnapshot
        : undefined,
    },
  );

  const targetLabel = formatCharacterTargetLabel(targetDescriptor);
  if (skillDescriptor.selector === "all") {
    return handledResult(
      chatHub,
      session,
      options,
      changedSkills.length > 0
        ? `Removed all skills from ${targetLabel}. Deleted ${changedSkills.length} skill records.`
        : `${targetLabel} already has no skills.`,
    );
  }

  const skillType = skillDescriptor.skillType;
  return handledResult(
    chatHub,
    session,
    options,
    changedSkills.length > 0
      ? `Removed ${skillType.name}(${skillType.typeID}) from ${targetLabel}.`
      : `${targetLabel} does not have ${skillType.name}(${skillType.typeID}).`,
  );
}

module.exports = {
  handleGmSkillsCommand,
  handleAllSkillsCommand,
  handleBackInTimeCommand,
  handleExpertSystemCommand,
  handleGiveSkillCommand,
  handleRemoveSkillCommand,
};
