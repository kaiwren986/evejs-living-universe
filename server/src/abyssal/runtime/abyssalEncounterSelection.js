"use strict";

const { toInt, normalizeText, listUniquePositiveInts } = require("../domain/abyssalRuntimeValues");

// Weighted selection and explicit historical compatibility admission; new-run authorization remains QSNA-owned.
function isAbyssalTier1EncounterEligible(ports, profile = null, context = {}) {
  if (!profile || profile.enabled === false) {
    return false;
  }
  const tier = Math.max(0, toInt(context && context.tier, 0));
  const requiredTheme = tier === 0
    ? normalizeText(ports.ABYSSAL_TIER0_COMBINED_ENCOUNTER_THEME, "")
    : tier === 1
      ? normalizeText(ports.ABYSSAL_TIER1_COMBINED_ENCOUNTER_THEME, "")
      : tier === 2
        ? normalizeText(ports.ABYSSAL_TIER2_COMBINED_ENCOUNTER_THEME, "")
        : tier === 3
          ? normalizeText(ports.ABYSSAL_TIER3_COMBINED_ENCOUNTER_THEME, "")
          : tier === 4
            ? normalizeText(ports.ABYSSAL_TIER4_COMBINED_ENCOUNTER_THEME, "")
            : tier === 5
              ? normalizeText(ports.ABYSSAL_TIER5_COMBINED_ENCOUNTER_THEME, "")
              : tier === 6
                ? normalizeText(ports.ABYSSAL_TIER6_COMBINED_ENCOUNTER_THEME, "")
                : "";
  if (!requiredTheme) {
    return false;
  }
  const roomIndex = Math.max(0, toInt(context && context.roomIndex, 0));
  const weatherType = normalizeText(context && context.weatherType, "");
  const eligibleRooms = listUniquePositiveInts(profile.eligibleRoomIndexes);
  const eligibleWeatherTypes = Array.isArray(profile.eligibleWeatherTypes)
    ? profile.eligibleWeatherTypes.map((entry) => normalizeText(entry, "")).filter(Boolean)
    : [];
  return (
    toInt(profile.tier, 0) === tier &&
    eligibleRooms.includes(roomIndex) &&
    eligibleWeatherTypes.includes(weatherType) &&
    Number(profile.weight) > 0 &&
    normalizeText(profile.encounterTheme, "") === requiredTheme &&
    (
      tier === 0
        ? context.tier0AbyssalSpaceTelemetryEnabled === true
          ? typeof ports.isTier0AbyssalSpaceEncounterProfile === "function" &&
            ports.isTier0AbyssalSpaceEncounterProfile(profile)
          : typeof ports.isTier0CombinedEncounterProfile !== "function" ||
            ports.isTier0CombinedEncounterProfile(profile)
        : tier === 1
          ? context.tier1AbyssalSpaceTelemetryEnabled === true
            ? typeof ports.isTier1AbyssalSpaceEncounterProfile === "function" &&
              ports.isTier1AbyssalSpaceEncounterProfile(profile)
            : typeof ports.isTier1CombinedEncounterProfile !== "function" ||
              ports.isTier1CombinedEncounterProfile(profile)
          : tier === 2
            ? context.tier2AbyssalSpaceTelemetryEnabled === true
              ? typeof ports.isTier2AbyssalSpaceEncounterProfile === "function" &&
                ports.isTier2AbyssalSpaceEncounterProfile(profile)
              : typeof ports.isTier2CombinedEncounterProfile !== "function" ||
                ports.isTier2CombinedEncounterProfile(profile)
            : tier === 3 && context.tier3AbyssalSpaceTelemetryEnabled === true
              ? typeof ports.isTier3AbyssalSpaceEncounterProfile === "function" &&
                ports.isTier3AbyssalSpaceEncounterProfile(profile)
            : tier === 4 && context.tier4AbyssalSpaceTelemetryEnabled === true
              ? typeof ports.isTier4AbyssalSpaceEncounterProfile === "function" &&
                ports.isTier4AbyssalSpaceEncounterProfile(profile)
            : tier === 5 && context.tier5AbyssalSpaceTelemetryEnabled === true
              ? typeof ports.isTier5AbyssalSpaceEncounterProfile === "function" &&
                ports.isTier5AbyssalSpaceEncounterProfile(profile)
            : tier === 6 && context.tier6AbyssalSpaceTelemetryEnabled === true
              ? typeof ports.isTier6AbyssalSpaceEncounterProfile === "function" &&
                ports.isTier6AbyssalSpaceEncounterProfile(profile)
            : typeof ports.isHigherTierCombinedEncounterProfile !== "function" ||
              ports.isHigherTierCombinedEncounterProfile(profile, tier)
    )
  );
}

function summarizeAbyssalTier1ResolvedEntries(ports, npcEntries = []) {
  const summary = {
    droneCount: 0,
    shipCount: 0,
    escortTypeID: 0,
  };
  for (const entry of Array.isArray(npcEntries) ? npcEntries : []) {
    const count = Math.max(0, toInt(entry && entry.count, toInt(entry && entry.resolvedCount, 0)));
    const typeID = toInt(entry && entry.typeID, 0);
    if (toInt(entry && entry.groupID, 0) === 1997 && toInt(entry && entry.factionID, 0) === 500025) {
      summary.droneCount += count;
      if (!summary.escortTypeID && [47847, 47848, 47849, 47855].includes(typeID)) {
        summary.escortTypeID = typeID;
      }
    }
    if (toInt(entry && entry.groupID, 0) === 1982 && toInt(entry && entry.factionID, 0) === 500026) {
      summary.shipCount += count;
    }
  }
  return summary;
}

function selectWeightedAbyssalTier1EncounterProfile(ports, context = {}, deps = ports.getDependencies()) {
  const tier = Math.max(0, toInt(context && context.tier, 0));
  const abyssalSpaceTelemetryEnabled =
    tier <= 6 && context[`tier${tier}AbyssalSpaceTelemetryEnabled`] === true;
  const catalogue = abyssalSpaceTelemetryEnabled
    ? typeof ports.getAbyssalSpaceEncounterPartition ===
        "function"
      ? ports.getAbyssalSpaceEncounterPartition({
        tier,
        weatherType: context.weatherType,
        roomIndex: context.roomIndex,
      })
      : []
    : tier === 0 && typeof ports.listTier0AbyssalEncounterProfiles === "function"
      ? ports.listTier0AbyssalEncounterProfiles()
      : tier === 1 && typeof ports.listTier1AbyssalEncounterProfiles === "function"
      ? ports.listTier1AbyssalEncounterProfiles()
      : tier === 2 && typeof ports.listTier2AbyssalEncounterProfiles === "function"
        ? ports.listTier2AbyssalEncounterProfiles()
        : tier === 3 && typeof ports.listTier3AbyssalEncounterProfiles === "function"
          ? ports.listTier3AbyssalEncounterProfiles()
          : tier === 4 && typeof ports.listTier4AbyssalEncounterProfiles === "function"
            ? ports.listTier4AbyssalEncounterProfiles()
            : tier === 5 && typeof ports.listTier5AbyssalEncounterProfiles === "function"
              ? ports.listTier5AbyssalEncounterProfiles()
              : tier === 6 && typeof ports.listTier6AbyssalEncounterProfiles === "function"
                ? ports.listTier6AbyssalEncounterProfiles()
                : [];
  const candidates = catalogue.filter((profile) => isAbyssalTier1EncounterEligible(ports, profile, context));
  return selectWeightedAbyssalEncounterCandidate(ports, candidates, deps);
}

function selectWeightedAbyssalEncounterCandidate(ports, candidates = [], deps = ports.getDependencies()) {
  if (candidates.length <= 0) {
    return null;
  }
  const totalWeight = candidates.reduce(
    (sum, profile) => sum + Math.max(0, Number(profile && profile.weight) || 0),
    0,
  );
  if (!(totalWeight > 0)) {
    return null;
  }
  const roll = nextAbyssalEncounterRandom(ports, deps) * totalWeight;
  let cumulativeWeight = 0;
  for (const profile of candidates) {
    cumulativeWeight += Math.max(0, Number(profile && profile.weight) || 0);
    if (roll < cumulativeWeight) {
      return profile;
    }
  }
  return candidates[candidates.length - 1];
}

function materializeSelectedAbyssalEncounterProfile(ports, profile = null) {
  const {
    cloneValue,
  } = ports;
  return cloneValue(profile);
}

function rollAbyssalNpcEntryCount(ports, npcEntry = null, deps = ports.getDependencies()) {
  const minimumCount = Math.max(0, toInt(npcEntry && npcEntry.minimumCount, toInt(npcEntry && npcEntry.count, 1)));
  const maximumCount = Math.max(minimumCount, toInt(npcEntry && npcEntry.maximumCount, minimumCount));
  if (maximumCount <= minimumCount) {
    return minimumCount;
  }
  return minimumCount + Math.floor(nextAbyssalEncounterRandom(ports, deps) * ((maximumCount - minimumCount) + 1));
}

function resolveAbyssalTier1EncounterNpcEntries(ports, encounterProfile = null, deps = ports.getDependencies()) {
  const resolvedEntries = [];
  for (const [index, npcEntry] of (Array.isArray(encounterProfile && encounterProfile.npcEntries)
    ? encounterProfile.npcEntries
    : []).entries()) {
    const profileChoices = Array.isArray(npcEntry && npcEntry.npcProfileChoices)
      ? npcEntry.npcProfileChoices.filter(Boolean)
      : [];
    const selectedChoice = profileChoices.length > 0
      ? profileChoices[Math.min(
        profileChoices.length - 1,
        Math.floor(nextAbyssalEncounterRandom(ports, deps) * profileChoices.length),
      )]
      : null;
    const resolvedNpcEntry = selectedChoice
      ? {
        ...npcEntry,
        npcProfileKey: selectedChoice.npcProfileKey,
        profileQuery: selectedChoice.profileQuery,
        profileName: selectedChoice.profileName,
        typeID: selectedChoice.typeID,
        displayName: selectedChoice.displayName,
        groupID: selectedChoice.groupID,
        factionID: selectedChoice.factionID,
        requestedProfileQuery: selectedChoice.requestedProfileQuery,
        fallbackUsed: selectedChoice.fallbackUsed,
        fallbackReason: selectedChoice.fallbackReason,
        weaponStyle: selectedChoice.weaponStyle,
      }
      : npcEntry;
    const resolvedProfileID = normalizeText(
      resolvedNpcEntry &&
        (resolvedNpcEntry.npcProfileKey || resolvedNpcEntry.profileQuery),
      "",
    );
    const admissionReport =
      resolvedProfileID &&
      typeof ports.getAbyssalNpcProfileValidationReport ===
        "function"
        ? ports.getAbyssalNpcProfileValidationReport(
          resolvedProfileID,
        )
        : null;
    if (
      !admissionReport ||
      admissionReport.validationStatus !== "VALID" ||
      admissionReport.admissionAllowed !== true ||
      admissionReport.safe !== true ||
      admissionReport.fallbackUsed === true ||
      admissionReport.profileID !== resolvedProfileID ||
      toInt(admissionReport.typeID, 0) !==
        toInt(resolvedNpcEntry && resolvedNpcEntry.typeID, 0)
    ) {
      return {
        success: false,
        errorMsg:
          "ABYSSAL_NPC_PROFILE_ADMISSION_FAILED " +
          `encounter=${normalizeText(
            encounterProfile && encounterProfile.encounterProfileID,
            "unknown",
          )} entry=${normalizeText(
            resolvedNpcEntry && resolvedNpcEntry.npcEntryID,
            `entry_${index + 1}`,
          )} requested=${resolvedProfileID || "missing"} ` +
          `typeID=${toInt(resolvedNpcEntry && resolvedNpcEntry.typeID, 0)} ` +
          `reason=${normalizeText(
            admissionReport && admissionReport.errorMsg,
            "NPC_PROFILE_UNAVAILABLE_OR_UNSAFE",
          )}`,
      };
    }
    const encounterTier = Math.max(
      0,
      toInt(encounterProfile && encounterProfile.tier, 0),
    );
    const tierAdmission = ports.getAbyssalNpcEncounterTierAdmissionReport(
        resolvedProfileID,
        encounterProfile,
      );
    if (tierAdmission.admitted !== true) {
      return {
        success: false,
        errorMsg:
          "ABYSSAL_NPC_PROFILE_TIER_NOT_ADMITTED " +
          `encounter=${normalizeText(
            encounterProfile && encounterProfile.encounterProfileID,
            "unknown",
          )} entry=${normalizeText(
            resolvedNpcEntry && resolvedNpcEntry.npcEntryID,
            `entry_${index + 1}`,
          )} requested=${resolvedProfileID} tier=${encounterTier}`,
      };
    }

    const count = rollAbyssalNpcEntryCount(ports, npcEntry, deps);
    if (count <= 0 && npcEntry && npcEntry.required === false) {
      continue;
    }
    resolvedEntries.push(buildAdmittedLegacyNpcEntry(ports, resolvedNpcEntry, admissionReport, resolvedProfileID, index, count));
  }
  const maximumTotalCount = Math.max(0, toInt(encounterProfile && encounterProfile.maximumTotalCount, 0));
  if (maximumTotalCount > 0) {
    let totalCount = resolvedEntries.reduce((total, entry) => total + Math.max(0, toInt(entry && entry.count, 0)), 0);
    for (let index = resolvedEntries.length - 1; index >= 0 && totalCount > maximumTotalCount; index -= 1) {
      const entry = resolvedEntries[index];
      const minimumCount = Math.max(0, toInt(entry && entry.minimumCount, 0));
      const reducibleCount = Math.max(0, toInt(entry && entry.count, 0) - minimumCount);
      const reduction = Math.min(reducibleCount, totalCount - maximumTotalCount);
      if (reduction <= 0) {
        continue;
      }
      entry.count -= reduction;
      entry.resolvedCount = entry.count;
      totalCount -= reduction;
    }
    if (totalCount > maximumTotalCount) {
      return {
        success: false,
        errorMsg: "ABYSSAL_ENCOUNTER_MAXIMUM_TOTAL_COUNT_UNSATISFIABLE",
      };
    }
  }
  const objectiveCount = resolvedEntries
    .filter((entry) => entry.objectiveRelevant !== false)
    .reduce((total, entry) => total + Math.max(0, toInt(entry && entry.count, 0)), 0);
  if (objectiveCount <= 0) {
    return {
      success: false,
      errorMsg: "ABYSSAL_ENCOUNTER_ZERO_OBJECTIVE_HOSTILES",
    };
  }
  return {
    success: true,
    data: {
      resolvedEntries,
      npcCount: resolvedEntries.reduce((total, entry) => total + Math.max(0, toInt(entry && entry.count, 0)), 0),
      objectiveCount,
    },
  };
}

function nextAbyssalEncounterRandom(ports, deps = ports.getDependencies()) {
  const randomValue = deps && typeof deps.nextEncounterRandom === "function"
    ? Number(deps.nextEncounterRandom())
    : deps && typeof deps.nextRandom === "function"
      ? Number(deps.nextRandom())
      : Math.random();
  if (!Number.isFinite(randomValue)) {
    return 0;
  }
  if (randomValue <= 0) {
    return 0;
  }
  if (randomValue >= 1) {
    return 0.999999999;
  }
  return randomValue;
}

function buildAdmittedLegacyNpcEntry(ports, resolvedNpcEntry, admissionReport, resolvedProfileID, index, count) {
  const {
    cloneValue,
  } = ports;
  return {
      npcEntryID: normalizeText(resolvedNpcEntry && resolvedNpcEntry.npcEntryID, `entry_${index + 1}`),
      runtimeKind: normalizeText(resolvedNpcEntry && resolvedNpcEntry.runtimeKind, "nativeCombat"),
      npcProfileKey: admissionReport.profileID,
      profileQuery: admissionReport.profileID,
      profileName: normalizeText(
        admissionReport.profileName,
        admissionReport.profileID,
      ),
      typeID: toInt(admissionReport.typeID, 0),
      displayName: normalizeText(
        resolvedNpcEntry && resolvedNpcEntry.displayName,
        admissionReport.displayName,
      ),
      groupID: toInt(admissionReport.groupID, 0),
      factionID: toInt(admissionReport.factionID, 0),
      requestedProfileQuery: resolvedProfileID,
      validationStatus: "VALID",
      admissionAllowed: true,
      fallbackUsed: false,
      fallbackReason: "",
      weaponStyle: normalizeText(admissionReport.weaponStyle, ""),
      capabilities: Array.isArray(admissionReport.capabilities)
        ? cloneValue(admissionReport.capabilities)
        : [],
      role: normalizeText(resolvedNpcEntry && resolvedNpcEntry.role, "hostile"),
      minimumCount: Math.max(0, toInt(resolvedNpcEntry && resolvedNpcEntry.minimumCount, count)),
      maximumCount: Math.max(0, toInt(resolvedNpcEntry && resolvedNpcEntry.maximumCount, count)),
      count,
      resolvedCount: count,
      required: resolvedNpcEntry && resolvedNpcEntry.required !== false,
      objectiveRelevant: resolvedNpcEntry && resolvedNpcEntry.objectiveRelevant !== false,
      objectiveRole: resolvedNpcEntry && resolvedNpcEntry.objectiveRelevant === false ? "support" : "kill_all_hostiles",
      spawnRadiusMeters: Math.max(0, toInt(resolvedNpcEntry && resolvedNpcEntry.spawnRadiusMeters, 0)),
      spawnOffsetMeters: Math.max(0, toInt(resolvedNpcEntry && resolvedNpcEntry.spawnOffsetMeters, 0)),
      spawnReference: normalizeText(resolvedNpcEntry && resolvedNpcEntry.spawnReference, "encounter_anchor"),
      spawnDistanceMode: normalizeText(resolvedNpcEntry && resolvedNpcEntry.spawnDistanceMode, "formation"),
    };
}

function createAbyssalEncounterSelection(ports) {
  return {
    isAbyssalTier1EncounterEligible: isAbyssalTier1EncounterEligible.bind(null, ports),
    summarizeAbyssalTier1ResolvedEntries: summarizeAbyssalTier1ResolvedEntries.bind(null, ports),
    selectWeightedAbyssalTier1EncounterProfile: selectWeightedAbyssalTier1EncounterProfile.bind(null, ports),
    selectWeightedAbyssalEncounterCandidate: selectWeightedAbyssalEncounterCandidate.bind(null, ports),
    materializeSelectedAbyssalEncounterProfile: materializeSelectedAbyssalEncounterProfile.bind(null, ports),
    rollAbyssalNpcEntryCount: rollAbyssalNpcEntryCount.bind(null, ports),
    resolveAbyssalTier1EncounterNpcEntries: resolveAbyssalTier1EncounterNpcEntries.bind(null, ports),
    nextAbyssalEncounterRandom: nextAbyssalEncounterRandom.bind(null, ports),
  };
}

module.exports = { createAbyssalEncounterSelection };
