"use strict";

const {
  cloneValue,
} = require("../../common/clone");
const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const pirateFactionPolicy = require(path.join(
  __dirname,
  "../../space/npc/pirateFactionPolicy",
));
const dungeonAuthority = require(path.join(__dirname, "../dungeon/dungeonAuthority"));

const AUTHORITY_VERSION = 1;
const AUTHORED_FOR_CLIENT_BUILD = 3475087;
const LAST_VALIDATED_SDE_BUILD = 3484357;

const SECURITY_TIER = Object.freeze({
  HIGHSEC_09_TO_10: "highsec_0_9_to_1_0",
  HIGHSEC_05_TO_08: "highsec_0_5_to_0_8",
  LOWSEC_01_TO_04: "lowsec_0_1_to_0_4",
  NULLSEC_00_AND_BELOW: "nullsec_0_0_and_below",
  WORMHOLE: "wormhole_excluded",
  SPECIAL_SPACE: "special_space_excluded",
  UNKNOWN: "unknown_excluded",
});

const SOURCE_REFS = Object.freeze({
  ccpCatalystMiningContent: Object.freeze({
    title: "EVE Online: Catalyst Expansion Notes - Mining Content",
    url: "https://www.eveonline.com/fr/news/view/catalyst-expansion-notes",
  }),
  ccpResourceDistribution1812: Object.freeze({
    title: "EVE Online: Patch Notes 18.12 - Resource Distribution",
    url: "https://www.eveonline.com/news/view/patch-notes-version-18-12",
  }),
  ccpSde: Object.freeze({
    title: "EVE Developer Documentation: Static Data Export",
    url: "https://developers.eveonline.com/docs/services/static-data/",
  }),
});

function entry(sourceDungeonID, expectedName) {
  return Object.freeze({
    sourceDungeonID,
    templateID: `client-dungeon:${sourceDungeonID}`,
    expectedName,
  });
}

const CATALOG_BY_TIER = Object.freeze({
  [SECURITY_TIER.HIGHSEC_05_TO_08]: Object.freeze([
    entry(1345, "Small Omber Deposit"),
    entry(1349, "Average Omber Deposit"),
    entry(1413, "Large Omber Deposit"),
    entry(1347, "Small Kernite and Omber Deposit"),
    entry(1448, "Average Kernite and Omber Deposit"),
    entry(1456, "Large Kernite and Omber Deposit"),
  ]),
  [SECURITY_TIER.LOWSEC_01_TO_04]: Object.freeze([
    entry(1466, "Average Jaspet Deposit"),
    entry(1464, "Small Gneiss Deposit"),
    entry(1465, "Average Gneiss Deposit"),
    entry(1482, "Large Gneiss Deposit"),
    entry(1499, "Small Dark Ochre and Gneiss Deposit"),
    entry(1505, "Average Dark Ochre and Gneiss Deposit"),
    entry(1521, "Large Dark Ochre and Gneiss Deposit"),
    entry(1540, "Small Crokite and Dark Ochre Deposit"),
    entry(1527, "Average Crokite and Dark Ochre Deposit"),
    entry(1533, "Small Crokite, Dark Ochre and Gneiss Deposit"),
    entry(1555, "Large Crokite, Dark Ochre and Gneiss Deposit"),
    entry(1348, "Small Hedbergite, Hemorphite and Jaspet Deposit"),
    entry(1344, "Average Hedbergite, Hemorphite and Jaspet Deposit"),
    entry(1350, "Large Hedbergite, Hemorphite and Jaspet Deposit"),
  ]),
  [SECURITY_TIER.NULLSEC_00_AND_BELOW]: Object.freeze([
    entry(1565, "Small Arkonor and Bistot Deposit"),
    entry(1455, "Medium Arkonor and Bistot Deposit"),
    entry(1564, "Average Arkonor and Bistot Deposit"),
    entry(1562, "Large Arkonor and Bistot Deposit"),
    entry(1558, "Small Bistot Deposit"),
    entry(1563, "Average Bistot Deposit"),
    entry(1559, "Large Bistot Deposit"),
  ]),
});

const ELIGIBLE_TIERS = Object.freeze(Object.keys(CATALOG_BY_TIER));

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function isWormholeSystemID(systemID) {
  const numericSystemID = toInt(systemID, 0);
  return numericSystemID >= 31_000_000 && numericSystemID <= 31_999_999;
}

function resolveSecurityTier(systemRecord) {
  const record = systemRecord && typeof systemRecord === "object"
    ? systemRecord
    : null;
  const systemID = toInt(
    record && (record.solarSystemID ?? record.systemID),
    toInt(systemRecord, 0),
  );
  if (isWormholeSystemID(systemID)) {
    return SECURITY_TIER.WORMHOLE;
  }
  if (!record) {
    return SECURITY_TIER.UNKNOWN;
  }
  if (pirateFactionPolicy.isSpecialSpaceSystem(systemID, record)) {
    return SECURITY_TIER.SPECIAL_SPACE;
  }
  const security = Number(record.securityStatus ?? record.security);
  if (!Number.isFinite(security)) {
    return SECURITY_TIER.UNKNOWN;
  }
  if (security >= 0.85) {
    return SECURITY_TIER.HIGHSEC_09_TO_10;
  }
  if (security >= 0.45) {
    return SECURITY_TIER.HIGHSEC_05_TO_08;
  }
  if (security >= 0) {
    return SECURITY_TIER.LOWSEC_01_TO_04;
  }
  return SECURITY_TIER.NULLSEC_00_AND_BELOW;
}

function resolveSecurityTierForSystemID(systemID) {
  const numericSystemID = toInt(systemID, 0);
  if (isWormholeSystemID(numericSystemID)) {
    return SECURITY_TIER.WORMHOLE;
  }
  const systemRecord = worldData.getSolarSystemByID(numericSystemID) || null;
  return resolveSecurityTier(systemRecord);
}

function isEligibleSecurityTier(tier) {
  return Object.prototype.hasOwnProperty.call(CATALOG_BY_TIER, String(tier || ""));
}

function listCatalogEntries(tier) {
  return cloneValue(CATALOG_BY_TIER[String(tier || "")] || []);
}

function listAllowedSourceDungeonIDs(tier) {
  return listCatalogEntries(tier).map((row) => row.sourceDungeonID);
}

function listAllowedTemplateIDs(tier) {
  return listCatalogEntries(tier).map((row) => row.templateID);
}

function listEligibleTemplatesForTier(tier) {
  return listAllowedTemplateIDs(tier)
    .map((templateID) => dungeonAuthority.getTemplateByID(templateID))
    .filter(Boolean);
}

function listEligibleTemplatesForSystem(systemID) {
  return listEligibleTemplatesForTier(resolveSecurityTierForSystemID(systemID));
}

// The shared frozen authority views, paired with their IDs. Selection only
// reads templates; callers get a private copy of the ones they are handed.
function listEligibleTemplateViewsForTier(tier) {
  return listAllowedTemplateIDs(tier)
    .map((templateID) => ({
      templateID,
      view: dungeonAuthority.getTemplateByIDReadOnly(templateID),
    }))
    .filter((entry) => entry.view);
}

function countEligibleTemplatesForSystem(systemID) {
  return listEligibleTemplateViewsForTier(resolveSecurityTierForSystemID(systemID)).length;
}

function hashValue(value) {
  let state = toInt(value, 0) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state ^= state >>> 16;
  return state >>> 0;
}

function hashText(value) {
  const normalized = String(value == null ? "" : value).trim();
  let state = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    state = hashValue(state + normalized.charCodeAt(index));
  }
  return state >>> 0;
}

function getSlotIndex(slot) {
  return Math.max(
    0,
    toInt(
      slot && slot.slotIndex,
      toInt(slot && slot.metadata && slot.metadata.slotIndex, 0),
    ),
  );
}

function getRotationIndex(slot) {
  return Math.max(
    0,
    toInt(
      slot && slot.rotationIndex,
      toInt(slot && slot.metadata && slot.metadata.rotationIndex, 0),
    ),
  );
}

function buildAllocationError(code, details = {}) {
  const error = new Error(`${code}: ${JSON.stringify(details)}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function allocateTemplatesForSystem(options = {}) {
  const systemID = Math.max(0, toInt(options.systemID, 0));
  const configuredCount = Math.max(0, toInt(options.configuredCount, 0));
  const securityTier = resolveSecurityTierForSystemID(systemID);
  const catalog = listEligibleTemplateViewsForTier(securityTier);
  if (configuredCount <= 0) {
    return {
      systemID,
      securityTier,
      configuredCount,
      catalogSize: catalog.length,
      assignments: [],
    };
  }
  if (catalog.length < configuredCount) {
    throw buildAllocationError("ORE_SECURITY_CATALOG_TOO_SMALL", {
      systemID,
      securityTier,
      configuredCount,
      catalogSize: catalog.length,
    });
  }

  const existingBySlot = new Map();
  for (const rawSlot of Array.isArray(options.existingSlots) ? options.existingSlots : []) {
    const slotIndex = getSlotIndex(rawSlot);
    if (slotIndex >= configuredCount || existingBySlot.has(slotIndex)) {
      continue;
    }
    const template = rawSlot && rawSlot.template && typeof rawSlot.template === "object"
      ? rawSlot.template
      : dungeonAuthority.getTemplateByID(String(rawSlot && rawSlot.templateID || "").trim());
    existingBySlot.set(slotIndex, {
      slotIndex,
      rotationIndex: getRotationIndex(rawSlot),
      template,
    });
  }

  const forcedRotationSlots = new Set(
    (Array.isArray(options.forceRotateSlotIndexes) ? options.forceRotateSlotIndexes : [])
      .map((entryValue) => Math.max(0, toInt(entryValue, 0)))
      .filter((entryValue) => entryValue < configuredCount),
  );
  const rotationIndexes = options.rotationIndexes && typeof options.rotationIndexes === "object"
    ? options.rotationIndexes
    : {};
  const assignments = new Array(configuredCount).fill(null);
  const usedSourceDungeonIDs = new Set();
  const previousSourceDungeonIDsBySlot = new Map();
  const vacancyReasonsBySlot = new Map();

  for (let slotIndex = 0; slotIndex < configuredCount; slotIndex += 1) {
    const existing = existingBySlot.get(slotIndex) || null;
    const template = existing && existing.template || null;
    const sourceDungeonID = resolveTemplateSourceDungeonID(template);
    if (sourceDungeonID > 0) {
      previousSourceDungeonIDsBySlot.set(slotIndex, sourceDungeonID);
    }
    if (forcedRotationSlots.has(slotIndex)) {
      vacancyReasonsBySlot.set(slotIndex, "forced_rotation");
      continue;
    }
    if (!template || !isTemplateAllowedInTier(template, securityTier)) {
      vacancyReasonsBySlot.set(
        slotIndex,
        existing ? "wrong_security_or_unknown_template" : "empty_slot",
      );
      continue;
    }
    if (usedSourceDungeonIDs.has(sourceDungeonID)) {
      vacancyReasonsBySlot.set(slotIndex, "duplicate_template");
      continue;
    }
    usedSourceDungeonIDs.add(sourceDungeonID);
    assignments[slotIndex] = {
      slotIndex,
      rotationIndex: Math.max(
        0,
        toInt(rotationIndexes[slotIndex], existing && existing.rotationIndex),
      ),
      template,
      retained: true,
      allocationReason: "retained_allowed_unique_template",
    };
  }

  for (let slotIndex = 0; slotIndex < configuredCount; slotIndex += 1) {
    if (assignments[slotIndex]) {
      continue;
    }
    const existing = existingBySlot.get(slotIndex) || null;
    const rotationIndex = Math.max(
      0,
      toInt(rotationIndexes[slotIndex], existing && existing.rotationIndex),
    );
    const previousSourceDungeonID = previousSourceDungeonIDsBySlot.get(slotIndex) || 0;
    let available = catalog.filter((entry) => (
      !usedSourceDungeonIDs.has(resolveTemplateSourceDungeonID(entry.view))
    ));
    if (forcedRotationSlots.has(slotIndex) && previousSourceDungeonID > 0) {
      const withoutPrevious = available.filter((entry) => (
        resolveTemplateSourceDungeonID(entry.view) !== previousSourceDungeonID
      ));
      if (withoutPrevious.length > 0) {
        available = withoutPrevious;
      }
    }
    available.sort((left, right) => {
      const leftSourceDungeonID = resolveTemplateSourceDungeonID(left.view);
      const rightSourceDungeonID = resolveTemplateSourceDungeonID(right.view);
      const leftRank = hashText([
        "strict-security-ore",
        systemID,
        slotIndex,
        rotationIndex,
        leftSourceDungeonID,
      ].join(":"));
      const rightRank = hashText([
        "strict-security-ore",
        systemID,
        slotIndex,
        rotationIndex,
        rightSourceDungeonID,
      ].join(":"));
      return (leftRank - rightRank) || (leftSourceDungeonID - rightSourceDungeonID);
    });
    const template = available[0]
      ? dungeonAuthority.getTemplateByID(available[0].templateID)
      : null;
    if (!template) {
      throw buildAllocationError("ORE_SECURITY_ALLOCATION_EXHAUSTED", {
        systemID,
        securityTier,
        configuredCount,
        slotIndex,
        usedSourceDungeonIDs: [...usedSourceDungeonIDs],
      });
    }
    const sourceDungeonID = resolveTemplateSourceDungeonID(template);
    usedSourceDungeonIDs.add(sourceDungeonID);
    const vacancyReason = vacancyReasonsBySlot.get(slotIndex) || "empty_slot";
    assignments[slotIndex] = {
      slotIndex,
      rotationIndex,
      template,
      retained: false,
      allocationReason: vacancyReason === "forced_rotation"
        ? "rotated_to_distinct_allowed_template"
        : vacancyReason === "duplicate_template"
          ? "replaced_duplicate_template"
          : vacancyReason === "wrong_security_or_unknown_template"
            ? "replaced_wrong_security_template"
            : "filled_empty_slot",
    };
  }

  return {
    systemID,
    securityTier,
    configuredCount,
    catalogSize: catalog.length,
    assignments,
  };
}

function resolveTemplateSourceDungeonID(template) {
  const direct = toInt(template && template.sourceDungeonID, 0);
  if (direct > 0) {
    return direct;
  }
  const match = /^client-dungeon:(\d+)$/i.exec(String(template && template.templateID || ""));
  return match ? toInt(match[1], 0) : 0;
}

function isTemplateAllowedInTier(template, tier) {
  const sourceDungeonID = resolveTemplateSourceDungeonID(template);
  return sourceDungeonID > 0 && listAllowedSourceDungeonIDs(tier).includes(sourceDungeonID);
}

function isTemplateAllowedInSystem(template, systemID) {
  return isTemplateAllowedInTier(template, resolveSecurityTierForSystemID(systemID));
}

function validateAuthority(options = {}) {
  const errors = [];
  const warnings = [];
  const allSourceDungeonIDs = new Set();

  for (const tier of ELIGIBLE_TIERS) {
    const entries = CATALOG_BY_TIER[tier] || [];
    const tierIDs = new Set();
    for (const catalogEntry of entries) {
      const sourceDungeonID = toInt(catalogEntry && catalogEntry.sourceDungeonID, 0);
      if (sourceDungeonID <= 0) {
        errors.push({
          code: "invalid_source_dungeon_id",
          tier,
          sourceDungeonID,
        });
        continue;
      }
      if (tierIDs.has(sourceDungeonID)) {
        errors.push({
          code: "duplicate_source_dungeon_id_in_tier",
          tier,
          sourceDungeonID,
        });
      }
      tierIDs.add(sourceDungeonID);
      if (allSourceDungeonIDs.has(sourceDungeonID)) {
        errors.push({
          code: "source_dungeon_id_shared_across_tiers",
          tier,
          sourceDungeonID,
        });
      }
      allSourceDungeonIDs.add(sourceDungeonID);

      // Validation reads only catalog identity and selection metadata.  Keep it
      // on the immutable descriptor path so compiling universe spawn families
      // cannot deep-clone every full ore dungeon on a player's first undock.
      const template = dungeonAuthority.getTemplateSelectionDescriptorByID(
        catalogEntry.templateID,
      );
      if (!template) {
        errors.push({
          code: "template_not_found",
          tier,
          sourceDungeonID,
          templateID: catalogEntry.templateID,
        });
        continue;
      }
      if (dungeonAuthority.isBannedDungeonTemplateRecord(template)) {
        errors.push({
          code: "template_is_banned",
          tier,
          sourceDungeonID,
          templateID: catalogEntry.templateID,
        });
      }
      if (String(template.templateID || "") !== catalogEntry.templateID) {
        errors.push({
          code: "template_id_mismatch",
          tier,
          sourceDungeonID,
          expected: catalogEntry.templateID,
          actual: String(template.templateID || ""),
        });
      }
      if (resolveTemplateSourceDungeonID(template) !== sourceDungeonID) {
        errors.push({
          code: "template_source_dungeon_id_mismatch",
          tier,
          sourceDungeonID,
          actual: resolveTemplateSourceDungeonID(template),
        });
      }
      if (String(template.resolvedName || "") !== catalogEntry.expectedName) {
        errors.push({
          code: "template_name_mismatch",
          tier,
          sourceDungeonID,
          expected: catalogEntry.expectedName,
          actual: String(template.resolvedName || ""),
        });
      }
      if (String(template.siteFamily || "").trim().toLowerCase() !== "ore") {
        errors.push({
          code: "template_family_mismatch",
          tier,
          sourceDungeonID,
          actual: String(template.siteFamily || ""),
        });
      }
      if (String(template.siteKind || "").trim().toLowerCase() !== "anomaly") {
        errors.push({
          code: "template_kind_mismatch",
          tier,
          sourceDungeonID,
          actual: String(template.siteKind || ""),
        });
      }
    }
  }

  const poolSizes = Object.fromEntries(
    ELIGIBLE_TIERS.map((tier) => [tier, (CATALOG_BY_TIER[tier] || []).length]),
  );
  const minimumPoolSize = Math.min(...Object.values(poolSizes));
  if (options.configuredCount !== undefined && options.configuredCount !== null) {
    const configuredCount = Number(options.configuredCount);
    if (!Number.isInteger(configuredCount) || configuredCount < 0) {
      errors.push({
        code: "invalid_configured_count",
        configuredCount: options.configuredCount,
      });
    } else if (configuredCount > minimumPoolSize) {
      errors.push({
        code: "configured_count_exceeds_minimum_pool",
        configuredCount,
        minimumPoolSize,
      });
    }
  }

  if (LAST_VALIDATED_SDE_BUILD < AUTHORED_FOR_CLIENT_BUILD) {
    warnings.push({
      code: "validated_sde_build_older_than_authored_client_build",
      authoredForClientBuild: AUTHORED_FOR_CLIENT_BUILD,
      lastValidatedSdeBuild: LAST_VALIDATED_SDE_BUILD,
    });
  }

  return {
    valid: errors.length <= 0,
    authorityVersion: AUTHORITY_VERSION,
    authoredForClientBuild: AUTHORED_FOR_CLIENT_BUILD,
    lastValidatedSdeBuild: LAST_VALIDATED_SDE_BUILD,
    eligibleTiers: [...ELIGIBLE_TIERS],
    poolSizes,
    minimumPoolSize,
    sourceDungeonCount: allSourceDungeonIDs.size,
    errors,
    warnings,
  };
}

function assertAuthority(options = {}) {
  const result = validateAuthority(options);
  if (result.valid) {
    return result;
  }
  const error = new Error(
    `ORE_ANOMALY_SECURITY_AUTHORITY_INVALID: ${JSON.stringify(result.errors)}`,
  );
  error.code = "ORE_ANOMALY_SECURITY_AUTHORITY_INVALID";
  error.validation = result;
  throw error;
}

function getDescriptor() {
  return cloneValue({
    authorityVersion: AUTHORITY_VERSION,
    authoredForClientBuild: AUTHORED_FOR_CLIENT_BUILD,
    lastValidatedSdeBuild: LAST_VALIDATED_SDE_BUILD,
    inputs: ["solarSystemID", "securityStatus"],
    requiresSovereignty: false,
    securityTiers: SECURITY_TIER,
    eligibleTiers: ELIGIBLE_TIERS,
    sourceRefs: SOURCE_REFS,
    catalogs: CATALOG_BY_TIER,
  });
}

module.exports = {
  AUTHORITY_VERSION,
  AUTHORED_FOR_CLIENT_BUILD,
  LAST_VALIDATED_SDE_BUILD,
  SECURITY_TIER,
  SOURCE_REFS,
  allocateTemplatesForSystem,
  countEligibleTemplatesForSystem,
  assertAuthority,
  getDescriptor,
  isEligibleSecurityTier,
  isTemplateAllowedInSystem,
  isTemplateAllowedInTier,
  listAllowedSourceDungeonIDs,
  listAllowedTemplateIDs,
  listCatalogEntries,
  listEligibleTemplatesForSystem,
  listEligibleTemplatesForTier,
  resolveSecurityTier,
  resolveSecurityTierForSystemID,
  resolveTemplateSourceDungeonID,
  validateAuthority,
  _testing: {
    CATALOG_BY_TIER,
    ELIGIBLE_TIERS,
    isWormholeSystemID,
    toFiniteNumber,
  },
};
