"use strict";

const path = require("path");
const crypto = require("crypto");

const log = require(path.join(__dirname, "../../utils/logger"));
const database = require(path.join(__dirname, "../../gameStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const starbaseIndustry = require("./starbaseIndustryRuntime");
const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  getCachedCharacterSkillMap,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
} = require(path.join(__dirname, "../corporation/corpWalletState"));
const {
  ensureRuntimeInitialized: ensureCorporationRuntimeInitialized,
  getCorporationOfficeByInventoryID,
  getCorporationOffices,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  findItemById,
  getAllItems,
  getInventoryItemUnitVolume,
  getIdempotentGrantReceipt,
  getItemMetadata,
  getPackagedVolumeForType,
  ITEM_FLAGS,
  listContainerItems,
  listOwnedItems,
  moveItemToLocation,
  grantItemsToCharacterLocation,
  grantItemsToOwnerLocation,
  grantItemsToOwnerLocationIdempotent,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const industryInstallSettlementState = require(path.join(
  __dirname,
  "./industryInstallSettlementState",
));
const {
  TARGET_SCHEMA_VERSION: INDUSTRY_INSTALLED_LOCATION_SCHEMA_VERSION,
  buildIndustryInstalledLocationMigration,
} = require(path.join(__dirname, "./industryInstalledLocationMigration"));
const industryInstallItemCustody = require(path.join(
  __dirname,
  "../inventory/industryInstallItemCustody",
));
const {
  CUSTODY_REF_KIND,
  CUSTODY_REASON,
  getCommittedReceipt: getItemCustodyCommittedReceipt,
} = require(path.join(__dirname, "../inventory/itemCustody"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  fanCorporationOfficeInventoryChanges,
} = require(path.join(__dirname, "../inventory/corporationOfficeInventoryObservers"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  matchesTypeList,
} = require(path.join(__dirname, "../inventory/typeListAuthority"));
const {
  buildIndustryValidationErrors,
  parseIndustryRequest,
} = require(path.join(__dirname, "./industryPayloads"));
const {
  forgetMonitor,
  watchMonitor,
} = require(path.join(__dirname, "./industryMonitorNotices"));
const {
  notifyBlueprintsUpdated,
  notifyIndustryJob,
} = require(path.join(__dirname, "./industryNotifications"));
const {
  getBlueprintDefinitionByTypeID,
  getFacilityPayloadByID,
  listFacilitiesForSession,
} = require(path.join(__dirname, "./industryStaticData"));
const {
  buildIndustryActivityMaterials,
  getIndustryActivity,
  resolveIndustryJobBaseCost,
  resolveIndustryJobCost,
  resolveIndustryJobTimeSeconds,
  resolveIndustrySecurityTax,
} = require(path.join(__dirname, "./industryParityHelpers"));
const SubscriptionMgrService = require(path.join(
  __dirname,
  "../subscription/subscriptionMgrService",
));
const {
  resolveIndustryFacilityDistanceRestriction,
  resolveIndustryFacilityRestriction,
  resolveIndustryStructureServiceID,
  resolveIndustrySlotContext,
  resolveIndustryStandingRestriction,
} = require(path.join(__dirname, "./industryRestrictions"));
const {
  structureHasOnlineService,
} = require(path.join(__dirname, "../structure/structureServiceAuthority"));
const {
  resolveSystemCostIndex,
} = require(path.join(__dirname, "./industrySystemCostIndex"));
const {
  resolveBlueprintActivityPrice,
} = require(path.join(__dirname, "./industryPricing"));
const {
  canSeeCorporationBlueprints,
  canTakeFromOwnerLocation,
  canUseCorporationWallet,
  canViewOwnerLocation,
  getMissingCorporationIndustryRoles,
  getAccessibleCorpHangarFlags,
  getSessionCharacterID,
  getSessionCorporationID,
  hasCorporationIndustryJobAccess,
  isCharacterOwner,
  isCorporationOwner,
  normalizeRoleValue,
} = require(path.join(__dirname, "./industryAccess"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  currentFileTime,
} = require("./industryClock");
const {
  BLUEPRINT_CATEGORY_ID,
  COST_PERCENTAGE,
  DEFAULT_ACCOUNT_KEY,
  DEFAULT_TAX_RATE,
  INDUSTRY_ACTIVITY,
  INDUSTRY_BLUEPRINT_STATE_TABLE,
  INDUSTRY_ERROR,
  INDUSTRY_INSTALLED_LOCATION_ID,
  INDUSTRY_JOBS_TABLE,
  INDUSTRY_RUNTIME_TABLE,
  INDUSTRY_STATUS,
  ITEM_FLAG_CORP_DELIVERIES,
  ITEM_FLAG_CORP_HANGAR_1,
  ITEM_FLAG_HANGAR,
  MAX_JOB_LENGTH_SECONDS,
  MAX_COPY_RUNS,
  MAX_INVENTION_RUNS,
  MAX_MATERIAL_EFFICIENCY,
  MAX_MANUFACTURING_RUNS,
  MAX_TIME_EFFICIENCY,
  INVENTION_MATERIAL_EFFICIENCY,
  INVENTION_SKILL_PROBABILITY,
  INVENTION_SKILL_PROBABILITY_LOWER,
  INVENTION_TIME_EFFICIENCY,
  RESEARCH_TIME_MULTIPLIERS,
  SCC_SURCHARGE_RATE,
  SCC_SURCHARGE_RESEARCH_DISCOUNT_MODIFIER,
  STEP_MATERIAL_EFFICIENCY,
  STEP_TIME_EFFICIENCY,
} = require(path.join(__dirname, "./industryConstants"));

const JOB_ID_START = 970000000000000;
const DURABLE_READY_JOB_TYPE = "industry-job.ready";
const DURABLE_READY_JOB_PREFIX = "industry-job:";
const MONITOR_ID_START = 1;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MILLISECOND = 10000n;
const FILETIME_TICKS_PER_SECOND = 10000000n;
const FILETIME_TICKS_PER_MINUTE = 60n * FILETIME_TICKS_PER_SECOND;
const FILETIME_TICKS_PER_DAY = 24n * 60n * FILETIME_TICKS_PER_MINUTE;
const LEGACY_UNIX_MS_MAX = 9999999999999n;
const DECRYPTOR_GROUP_ID = 1304;
const ATTRIBUTE_INVENTION_PROBABILITY_MULTIPLIER = 1112;
const ATTRIBUTE_INVENTION_ME_MODIFIER = 1113;
const ATTRIBUTE_INVENTION_TE_MODIFIER = 1114;
const ATTRIBUTE_INVENTION_MAX_RUN_MODIFIER = 1124;
const LOWER_INVENTION_SKILL_PROBABILITY_TYPE_LIST_ID = 799;
const LOWER_INVENTION_SKILL_PROBABILITY_TYPE_IDS = new Set([
  23087,
  21790,
  23121,
  21791,
  3408,
  52308,
  55025,
]);
const OFFICE_TYPE_ID = 27;
const MAX_INDUSTRY_LOCATION_ANCESTRY_DEPTH = 64;
const INDUSTRY_CONTAINER_GROUP_IDS = new Set([12, 340, 448, 649]);
const INDUSTRY_UNLOCKED_CHILD_FLAG_GROUP_ID = 448;

let typeDogmaAttributesByTypeID = null;
let durableScheduler = null;
let durableSchedulerGeneration = 0;
const durableJobIDs = new Map();
const durableScheduleLanes = new Map();
const loggedIndustryBlueprintOrphanIDs = new Set();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFloat(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function getTypeDogmaAttributesByTypeID() {
  if (typeDogmaAttributesByTypeID) {
    return typeDogmaAttributesByTypeID;
  }
  const table = readStaticTable(TABLE.TYPE_DOGMA);
  typeDogmaAttributesByTypeID =
    table && typeof table === "object" && table.typesByTypeID
      ? table.typesByTypeID
      : {};
  return typeDogmaAttributesByTypeID;
}

function getTypeDogmaAttributeValue(typeID, attributeID, fallback = 0) {
  const typeRecord = getTypeDogmaAttributesByTypeID()[String(toInt(typeID, 0))];
  const attributes =
    typeRecord && typeRecord.attributes && typeof typeRecord.attributes === "object"
      ? typeRecord.attributes
      : {};
  return toFloat(attributes[String(toInt(attributeID, 0))], fallback);
}

function isDecryptorType(typeID) {
  const typeRecord = resolveItemByTypeID(toInt(typeID, 0));
  return toInt(typeRecord && typeRecord.groupID, 0) === DECRYPTOR_GROUP_ID;
}

function resolveDecryptorModifiers(typeID) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0 || !isDecryptorType(numericTypeID)) {
    return {
      typeID: 0,
      probabilityMultiplier: 1.0,
      materialEfficiency: 0,
      timeEfficiency: 0,
      maxRuns: 0,
    };
  }
  return {
    typeID: numericTypeID,
    probabilityMultiplier: getTypeDogmaAttributeValue(
      numericTypeID,
      ATTRIBUTE_INVENTION_PROBABILITY_MULTIPLIER,
      1.0,
    ),
    materialEfficiency: toInt(
      getTypeDogmaAttributeValue(
        numericTypeID,
        ATTRIBUTE_INVENTION_ME_MODIFIER,
        0,
      ),
      0,
    ),
    timeEfficiency: toInt(
      getTypeDogmaAttributeValue(
        numericTypeID,
        ATTRIBUTE_INVENTION_TE_MODIFIER,
        0,
      ),
      0,
    ),
    maxRuns: toInt(
      getTypeDogmaAttributeValue(
        numericTypeID,
        ATTRIBUTE_INVENTION_MAX_RUN_MODIFIER,
        0,
      ),
      0,
    ),
  };
}

function getCharacterSkillLevels(characterID) {
  const levels = new Map();
  for (const [typeID, skillRecord] of getCachedCharacterSkillMap(
    toInt(characterID, 0),
  ).entries()) {
    levels.set(
      toInt(typeID, 0),
      Math.max(
        0,
        toInt(
          skillRecord &&
            (skillRecord.effectiveSkillLevel ??
              skillRecord.trainedSkillLevel ??
              skillRecord.skillLevel),
          0,
        ),
      ),
    );
  }
  return levels;
}

function resolveInventionProduct(definition, requestedProductTypeID = 0) {
  const activity = getIndustryActivity(definition, INDUSTRY_ACTIVITY.INVENTION);
  const products = Array.isArray(activity && activity.products)
    ? activity.products.filter((product) => toInt(product && product.typeID, 0) > 0)
    : [];
  const numericRequestedTypeID = toInt(requestedProductTypeID, 0);
  if (numericRequestedTypeID > 0) {
    return products.find(
      (product) => toInt(product && product.typeID, 0) === numericRequestedTypeID,
    ) || null;
  }
  return products.length === 1 ? products[0] : null;
}

function computeInventionProbability(
  definition,
  characterID,
  decryptorTypeID = 0,
) {
  const activity = getIndustryActivity(definition, INDUSTRY_ACTIVITY.INVENTION);
  const products = Array.isArray(activity && activity.products)
    ? activity.products
    : [];
  if (products.length === 0) {
    return 0;
  }
  const baseProbability = products.reduce((sum, product) => {
    const probability = toFloat(product && product.probability, 1.0);
    return sum + probability;
  }, 0) / products.length;
  const skillLevels = getCharacterSkillLevels(characterID);
  const skillMultiplier = 1.0 + (Array.isArray(activity && activity.skills)
    ? activity.skills
    : []).reduce((sum, skill) => {
      const typeID = toInt(skill && skill.typeID, 0);
      const level = Math.max(0, toInt(skillLevels.get(typeID), 0));
      const perLevel = (
        matchesTypeList(
          { typeID },
          LOWER_INVENTION_SKILL_PROBABILITY_TYPE_LIST_ID,
        ) || LOWER_INVENTION_SKILL_PROBABILITY_TYPE_IDS.has(typeID)
      )
        ? INVENTION_SKILL_PROBABILITY_LOWER
        : INVENTION_SKILL_PROBABILITY;
      return sum + level * perLevel;
    }, 0);
  const decryptor = resolveDecryptorModifiers(decryptorTypeID);
  return clamp(
    baseProbability * skillMultiplier * decryptor.probabilityMultiplier,
    0,
    1,
  );
}

function rollInventionSuccessfulRuns(runs, probability, random = Math.random) {
  const normalizedRuns = Math.max(0, toInt(runs, 0));
  const normalizedProbability = clamp(toFloat(probability, 0), 0, 1);
  let successfulRuns = 0;
  for (let index = 0; index < normalizedRuns; index += 1) {
    if (toFloat(random(), 1) < normalizedProbability) {
      successfulRuns += 1;
    }
  }
  return successfulRuns;
}

function normalizeBigIntLike(value, fallback = 0n) {
  try {
    if (typeof value === "bigint") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string" && value.trim() !== "") {
      return BigInt(value.trim());
    }
  } catch (error) {
    return fallback;
  }
  return fallback;
}

function normalizeIndustryFileTime(value, fallback = 0n) {
  const normalized = normalizeBigIntLike(value, fallback);
  if (normalized <= 0n) {
    return fallback;
  }
  if (normalized <= LEGACY_UNIX_MS_MAX) {
    return normalized * FILETIME_TICKS_PER_MILLISECOND + FILETIME_EPOCH_OFFSET;
  }
  return normalized;
}

function serializeIndustryFileTime(value, fallback = 0n) {
  return normalizeIndustryFileTime(value, fallback).toString();
}

function normalizeIndustryJobRecord(job) {
  if (!job || typeof job !== "object") {
    return null;
  }
  const normalizedJob = {
    ...cloneValue(job),
  };
  if (
    !Object.prototype.hasOwnProperty.call(normalizedJob, "blueprintInventoryFlagID") &&
    toInt(normalizedJob.blueprintLocationFlagID, -1) >= 0
  ) {
    normalizedJob.blueprintInventoryFlagID = toInt(
      normalizedJob.blueprintLocationFlagID,
      0,
    );
    normalizedJob.blueprintLocationFlagID = resolveIndustryLocationFlagID(
      normalizedJob.blueprintInventoryLocationID || normalizedJob.blueprintLocationID,
      normalizedJob.ownerID,
      normalizedJob.blueprintInventoryFlagID,
    );
  }
  if (
    !Object.prototype.hasOwnProperty.call(normalizedJob, "outputInventoryFlagID") &&
    toInt(normalizedJob.outputFlagID, -1) >= 0
  ) {
    // Preserve replay compatibility with an output receipt created by an older
    // server. New jobs persist the canonical child flag explicitly below.
    normalizedJob.outputInventoryFlagID = toInt(normalizedJob.outputFlagID, 0);
  }
  normalizedJob.startDate = serializeIndustryFileTime(normalizedJob.startDate, 0n);
  normalizedJob.endDate = serializeIndustryFileTime(normalizedJob.endDate, 0n);
  normalizedJob.pauseDate = normalizedJob.pauseDate
    ? serializeIndustryFileTime(normalizedJob.pauseDate, 0n)
    : null;
  return normalizedJob;
}

function readTable(tableName, fallbackValue) {
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return cloneValue(fallbackValue);
  }
  return cloneValue(result.data);
}

function writeTable(tableName, payload) {
  const result = database.write(tableName, "/", payload);
  return Boolean(result && result.success);
}

function ensureBlueprintStateTable() {
  const payload = readTable(INDUSTRY_BLUEPRINT_STATE_TABLE, {
    _meta: {
      version: 1,
      generatedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    },
    records: {},
  });
  if (!payload.records || typeof payload.records !== "object") {
    payload.records = {};
  }
  return payload;
}

function persistBlueprintStateTable(payload) {
  payload._meta = {
    ...(payload._meta || {}),
    version: 1,
    lastUpdatedAt: new Date().toISOString(),
  };
  return writeTable(INDUSTRY_BLUEPRINT_STATE_TABLE, payload);
}

function ensureJobsTable() {
  const payload = readTable(INDUSTRY_JOBS_TABLE, {
    _meta: {
      version: 1,
      nextJobID: JOB_ID_START,
      generatedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    },
    jobs: {},
  });
  if (!payload.jobs || typeof payload.jobs !== "object") {
    payload.jobs = {};
  }
  payload._meta = payload._meta && typeof payload._meta === "object" ? payload._meta : {};
  payload._meta.nextJobID = Math.max(JOB_ID_START, toInt(payload._meta.nextJobID, JOB_ID_START));
  return payload;
}

function persistJobsTable(payload) {
  payload._meta = {
    ...(payload._meta || {}),
    version: 1,
    lastUpdatedAt: new Date().toISOString(),
  };
  return writeTable(INDUSTRY_JOBS_TABLE, payload);
}

function migrateIndustryInstalledLocationSchema() {
  const plan = buildIndustryInstalledLocationMigration(ensureJobsTable());
  if (!plan.report.changed) {
    return plan.report;
  }
  if (!persistJobsTable(plan.nextState)) {
    throw new Error("failed to persist industry installed-location migration");
  }
  const flushResult = database.flushTableSync(INDUSTRY_JOBS_TABLE);
  if (!flushResult || flushResult.success !== true) {
    const error = new Error(
      "failed to durably flush industry installed-location migration",
    );
    error.code = "INDUSTRY_INSTALLED_LOCATION_MIGRATION_FLUSH_FAILED";
    throw error;
  }
  const persistedResult = database.readPersisted(INDUSTRY_JOBS_TABLE, "/");
  if (!persistedResult || persistedResult.success !== true) {
    throw new Error(
      "failed to verify durable industry installed-location migration",
    );
  }
  const verification = buildIndustryInstalledLocationMigration(
    persistedResult.data,
  );
  if (
    verification.report.changed ||
    verification.report.sourceVersion !==
      INDUSTRY_INSTALLED_LOCATION_SCHEMA_VERSION
  ) {
    throw new Error(
      "durable industry installed-location migration verification failed",
    );
  }
  log.info(
    "[IndustryRuntime] installed-location schema migrated " +
      `jobs=${plan.report.migratedJobs} total=${plan.report.totalJobs}`,
  );
  return plan.report;
}

// Corporation job output sent to Corp Deliveries used to be filed under the
// corporation's office. No inventory window lists that place, and a job still
// pointing at it matches no listed output location, so it could not be
// delivered. On startup both are moved to the station or structure itself,
// where Corp Deliveries reads. Safe to run on every start: once moved, nothing
// matches again.
function repairOfficeFiledCorpDeliveries() {
  const report = { repointedJobs: 0, movedItems: 0, failedItems: 0 };

  const jobsTable = ensureJobsTable();
  for (const [jobKey, job] of Object.entries(jobsTable.jobs || {})) {
    if (
      !job ||
      toInt(job.outputFlagID, 0) !== ITEM_FLAG_CORP_DELIVERIES ||
      toInt(job.status, 0) >= INDUSTRY_STATUS.COMPLETED
    ) {
      continue;
    }
    const facilityID = toInt(job.facilityID, 0);
    const office = getCorporationOfficeByInventoryID(
      job.ownerID,
      getIndustryJobOutputInventoryLocationID(job),
    );
    if (facilityID <= 0 || !office || toInt(office.stationID, 0) !== facilityID) {
      continue;
    }
    jobsTable.jobs[jobKey] = {
      ...job,
      outputLocationID: facilityID,
      outputInventoryLocationID: facilityID,
    };
    report.repointedJobs += 1;
  }
  if (report.repointedJobs > 0 && !persistJobsTable(jobsTable)) {
    throw new Error("failed to persist the corp deliveries job output repair");
  }

  const corporationRuntimeTable = ensureCorporationRuntimeInitialized();
  for (const runtime of Object.values(corporationRuntimeTable.corporations || {})) {
    for (const office of Object.values((runtime && runtime.offices) || {})) {
      const hostID = toInt(office && office.stationID, 0);
      const corporationID = toInt(office && office.corporationID, 0);
      if (hostID <= 0 || corporationID <= 0) {
        continue;
      }
      for (const inventoryLocationID of getCorporationOfficeInventoryLocationIDs(office)) {
        if (inventoryLocationID === hostID) {
          continue;
        }
        for (const item of listContainerItems(
          corporationID,
          inventoryLocationID,
          ITEM_FLAG_CORP_DELIVERIES,
        )) {
          const moveResult = moveItemToLocation(
            item.itemID,
            hostID,
            ITEM_FLAG_CORP_DELIVERIES,
          );
          if (moveResult && moveResult.success) {
            report.movedItems += 1;
          } else {
            report.failedItems += 1;
            log.warn(
              "[IndustryRuntime] could not move office-filed corp delivery " +
                `itemID=${item.itemID} office=${inventoryLocationID} host=${hostID} ` +
                `error=${(moveResult && moveResult.errorMsg) || "UNKNOWN"}`,
            );
          }
        }
      }
    }
  }

  if (report.repointedJobs > 0 || report.movedItems > 0) {
    log.info(
      "[IndustryRuntime] office-filed corp deliveries repaired " +
        `jobs=${report.repointedJobs} items=${report.movedItems} failed=${report.failedItems}`,
    );
  }
  return report;
}

function ensureRuntimeTable() {
  const payload = readTable(INDUSTRY_RUNTIME_TABLE, {
    _meta: {
      version: 1,
      nextMonitorID: MONITOR_ID_START,
      generatedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    },
    monitors: {},
  });
  if (!payload.monitors || typeof payload.monitors !== "object") {
    payload.monitors = {};
  }
  payload._meta = payload._meta && typeof payload._meta === "object" ? payload._meta : {};
  payload._meta.nextMonitorID = Math.max(MONITOR_ID_START, toInt(payload._meta.nextMonitorID, MONITOR_ID_START));
  return payload;
}

function persistRuntimeTable(payload) {
  payload._meta = {
    ...(payload._meta || {}),
    version: 1,
    lastUpdatedAt: new Date().toISOString(),
  };
  return writeTable(INDUSTRY_RUNTIME_TABLE, payload);
}

function getStoredBlueprintState(itemID) {
  const numericItemID = toInt(itemID, 0);
  if (numericItemID <= 0) {
    return null;
  }
  const payload = ensureBlueprintStateTable();
  const existing = payload.records[String(numericItemID)];
  return existing && typeof existing === "object"
    ? cloneValue(existing)
    : null;
}

function getVerifiedInstalledBlueprintJob(item, options = {}) {
  if (
    !item ||
    toInt(item.locationID, 0) !== INDUSTRY_INSTALLED_LOCATION_ID
  ) {
    return null;
  }
  const state = Object.prototype.hasOwnProperty.call(options, "state")
    ? options.state
    : getStoredBlueprintState(item.itemID);
  const jobID = toInt(state && state.jobID, 0);
  const job = Object.prototype.hasOwnProperty.call(options, "job")
    ? options.job
    : jobID > 0
      ? getJobByID(jobID)
      : null;
  if (
    !job ||
    toInt(job.blueprintID, 0) !== toInt(item.itemID, 0) ||
    toInt(job.blueprintTypeID, 0) !== toInt(item.typeID, 0) ||
    toInt(job.ownerID, 0) !== toInt(item.ownerID, 0) ||
    toInt(job.installedLocationID, 0) !== INDUSTRY_INSTALLED_LOCATION_ID
  ) {
    return null;
  }
  if (job.installationPending === true) {
    return options.includePending === true ? job : null;
  }
  const status = getJobStatus(job);
  return (
    status === INDUSTRY_STATUS.INSTALLED ||
    status === INDUSTRY_STATUS.PAUSED ||
    status === INDUSTRY_STATUS.READY
  )
    ? job
    : null;
}

function shouldHideUnprotectedInstalledBlueprint(item, options = {}) {
  if (
    !item ||
    toInt(item.locationID, 0) !== INDUSTRY_INSTALLED_LOCATION_ID
  ) {
    return false;
  }
  if (getVerifiedInstalledBlueprintJob(item, options)) {
    loggedIndustryBlueprintOrphanIDs.delete(toInt(item.itemID, 0));
    return false;
  }
  if (getVerifiedInstalledBlueprintJob(item, {
    ...options,
    includePending: true,
  })) {
    return true;
  }
  const itemID = toInt(item.itemID, 0);
  if (!loggedIndustryBlueprintOrphanIDs.has(itemID)) {
    loggedIndustryBlueprintOrphanIDs.add(itemID);
    log.warn(
      `[IndustryRuntime] hiding unprotected installed-location blueprint item=${itemID}`,
    );
  }
  return true;
}

function canViewBlueprintInstance(session, item) {
  if (!session || !item) {
    return !shouldHideUnprotectedInstalledBlueprint(item);
  }
  if (shouldHideUnprotectedInstalledBlueprint(item)) {
    return false;
  }
  const state = getBlueprintState(item.itemID, item);
  const installedJob = state && state.jobID ? getJobByID(state.jobID) : null;
  const ownerID = toInt(item.ownerID, 0);
  const location = installedJob ? null : resolveLocationType(item.locationID, ownerID);
  const accessLocationID = installedJob
    ? toInt(installedJob.facilityID, 0)
    : toInt(location.facilityID, 0);
  // Location resolution already identifies the containing facility, including
  // nested containers. Reuse its type instead of cloning that inventory again.
  const isStarbaseLocation = installedJob
    ? installedJob.starbaseTowerID || (
      accessLocationID > 0 &&
      !worldData.getStationByID(accessLocationID) &&
      !structureState.getStructureByID(accessLocationID, { refresh: false }) &&
      starbaseIndustry.getAssemblyArray(accessLocationID)
    )
    : starbaseIndustry.getAssemblyProfile(location.facilityTypeID);
  if (isStarbaseLocation &&
      !starbaseIndustry.canAccessArray(session, { ownerID })) return false;
  if (isCharacterOwner(session, ownerID)) {
    return true;
  }
  if (!isCorporationOwner(session, ownerID)) {
    return false;
  }
  const accessFlagID = installedJob
    ? toInt(installedJob.blueprintLocationFlagID, 0)
    : resolveIndustryLocationFlagID(item.locationID, ownerID, item.flagID);
  return canSeeCorporationBlueprints(session, ownerID) && canViewOwnerLocation(
    session,
    ownerID,
    accessLocationID,
    accessFlagID,
  );
}

function getBlueprintState(itemID, inventoryItem = null) {
  const numericItemID = toInt(itemID, 0);
  if (numericItemID <= 0) {
    return null;
  }
  const existing = getStoredBlueprintState(numericItemID);
  if (existing) {
    return existing;
  }

  const item = inventoryItem || findItemById(numericItemID);
  if (
    !item ||
    toInt(item.categoryID, 0) !== BLUEPRINT_CATEGORY_ID ||
    toInt(item.singleton, 0) !== 1
  ) {
    return null;
  }
  if (toInt(item.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID) {
    return null;
  }

  const payload = ensureBlueprintStateTable();
  const nextState = {
    itemID: numericItemID,
    typeID: toInt(item.typeID, 0),
    materialEfficiency: 0,
    timeEfficiency: 0,
    original: true,
    runsRemaining: -1,
    jobID: null,
    updatedAt: Date.now(),
  };
  payload.records[String(numericItemID)] = nextState;
  persistBlueprintStateTable(payload);
  return cloneValue(nextState);
}

function initializeBlueprintState(itemID, initialState = {}) {
  const numericItemID = toInt(itemID, 0);
  const item = findItemById(numericItemID);
  if (!item || toInt(item.categoryID, 0) !== BLUEPRINT_CATEGORY_ID) {
    return {
      success: false,
      errorMsg: "BLUEPRINT_NOT_FOUND",
    };
  }
  const original = initialState.original === true;
  const runsRemaining = original
    ? -1
    : Math.max(0, toInt(initialState.runsRemaining, 0));
  if (!original && runsRemaining <= 0) {
    return {
      success: false,
      errorMsg: "INVALID_BLUEPRINT_RUNS",
    };
  }
  const expectedSingleton = original ? 1 : 2;
  if (toInt(item.singleton, 0) !== expectedSingleton) {
    return {
      success: false,
      errorMsg: "BLUEPRINT_INSTANCE_MISMATCH",
    };
  }

  const payload = ensureBlueprintStateTable();
  const nextState = {
    itemID: numericItemID,
    typeID: toInt(initialState.typeID || item.typeID, 0),
    materialEfficiency: Math.max(0, toInt(initialState.materialEfficiency, 0)),
    timeEfficiency: Math.max(0, toInt(initialState.timeEfficiency, 0)),
    original,
    runsRemaining,
    jobID: initialState.jobID ? toInt(initialState.jobID, 0) : null,
    updatedAt: Date.now(),
  };
  payload.records[String(numericItemID)] = nextState;
  if (!persistBlueprintStateTable(payload)) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }
  return {
    success: true,
    data: cloneValue(nextState),
  };
}

function updateBlueprintState(itemID, updater) {
  const numericItemID = toInt(itemID, 0);
  const payload = ensureBlueprintStateTable();
  const current = getBlueprintState(numericItemID);
  if (!current) {
    return {
      success: false,
      errorMsg: "BLUEPRINT_NOT_FOUND",
    };
  }

  const nextState =
    typeof updater === "function" ? updater(cloneValue(current)) : updater;
  if (!nextState || typeof nextState !== "object") {
    return {
      success: false,
      errorMsg: "INVALID_BLUEPRINT_STATE",
    };
  }

  payload.records[String(numericItemID)] = {
    ...current,
    ...nextState,
    itemID: numericItemID,
    updatedAt: Date.now(),
  };
  if (!persistBlueprintStateTable(payload)) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  return {
    success: true,
    data: cloneValue(payload.records[String(numericItemID)]),
  };
}

function removeBlueprintState(itemID) {
  const numericItemID = toInt(itemID, 0);
  if (numericItemID <= 0) {
    return false;
  }
  const payload = ensureBlueprintStateTable();
  delete payload.records[String(numericItemID)];
  return persistBlueprintStateTable(payload);
}

function resolveLocationType(locationID, ownerID = 0) {
  const numericLocationID = toInt(locationID, 0);
  const numericOwnerID = toInt(ownerID, 0);
  let immediateTypeID = 0;
  let currentLocationID = numericLocationID;
  let corporationOffice = null;
  const visited = new Set();

  for (let depth = 0; depth < MAX_INDUSTRY_LOCATION_ANCESTRY_DEPTH; depth += 1) {
    if (currentLocationID <= 0 || visited.has(currentLocationID)) {
      break;
    }
    visited.add(currentLocationID);

    const station = worldData.getStationByID(currentLocationID);
    if (station) {
      return {
        typeID: immediateTypeID || toInt(station.stationTypeID, 0),
        facilityTypeID: toInt(station.stationTypeID, 0),
        solarSystemID: toInt(station.solarSystemID, 0),
        facilityID: currentLocationID,
        corporationOffice,
      };
    }

    const structure = structureState.getStructureByID(currentLocationID, {
      refresh: false,
    });
    if (structure) {
      return {
        typeID: immediateTypeID || toInt(structure.typeID, 0),
        facilityTypeID: toInt(structure.typeID, 0),
        solarSystemID: toInt(structure.solarSystemID, 0),
        facilityID: currentLocationID,
        corporationOffice,
      };
    }

    const office = numericOwnerID > 0
      ? getCorporationOfficeByInventoryID(numericOwnerID, currentLocationID)
      : null;
    if (office) {
      corporationOffice = corporationOffice || office;
      if (!immediateTypeID) {
        immediateTypeID = OFFICE_TYPE_ID;
      }
      currentLocationID = toInt(office.stationID, 0);
      continue;
    }

    const item = findItemById(currentLocationID);
    if (!item) {
      break;
    }
    const array = starbaseIndustry.getArrayContext(item);
    if (array) {
      return { typeID: immediateTypeID || toInt(item.typeID, 0), facilityTypeID: toInt(item.typeID, 0),
        solarSystemID: toInt(item.spaceState.systemID, 0), facilityID: currentLocationID, corporationOffice };
    }
    if (!immediateTypeID) {
      immediateTypeID = toInt(item.typeID, 0);
    }
    // Only industry containers pass the item through to the station holding
    // them. Anything else in the chain — a ship's cargo hold above all — is not
    // an industry location, so the chain resolves to no facility rather than to
    // whatever station the holding item happens to be sitting in. Reporting the
    // docked station here binds the industry window to a facility that
    // GetFacilityLocations will never list.
    if (!isIndustryContainerItem(item)) {
      break;
    }
    currentLocationID = toInt(item.locationID, 0);
  }

  return {
    typeID: immediateTypeID,
    facilityTypeID: 0,
    solarSystemID: 0,
    facilityID: 0,
    corporationOffice,
  };
}

function getCorporationOfficeInventoryLocationIDs(office) {
  return [
    toInt(office && office.officeID, 0),
    toInt(office && office.officeFolderID, 0),
    toInt(office && office.itemID, 0),
  ].filter((locationID, index, values) => (
    locationID > 0 && values.indexOf(locationID) === index
  ));
}

function getPrimaryCorporationOfficeInventoryLocationID(office) {
  return getCorporationOfficeInventoryLocationIDs(office)[0] || 0;
}

function resolveCorporationOfficeForFacility(ownerID, facilityID) {
  const numericFacilityID = toInt(facilityID, 0);
  return getCorporationOffices(toInt(ownerID, 0)).find((office) => (
    toInt(office && office.stationID, 0) === numericFacilityID &&
    office.impounded !== true
  )) || null;
}

function isCorporationOfficeInventoryLocation(office, locationID) {
  const numericLocationID = toInt(locationID, 0);
  return getCorporationOfficeInventoryLocationIDs(office)
    .includes(numericLocationID);
}

function isIndustryContainerItem(item) {
  return Boolean(
    item &&
    toInt(item.singleton, 0) === 1 &&
    INDUSTRY_CONTAINER_GROUP_IDS.has(toInt(item.groupID, 0)),
  );
}

function isLockedIndustryContainerEntry(item) {
  if (!item || toInt(item.flagID, 0) !== ITEM_FLAGS.LOCKED) {
    return false;
  }
  const container = findItemById(item.locationID);
  return Boolean(
    container &&
    toInt(container.ownerID, 0) === toInt(item.ownerID, 0) &&
    isIndustryContainerItem(container) &&
    toInt(container.groupID, 0) === INDUSTRY_UNLOCKED_CHILD_FLAG_GROUP_ID,
  );
}

function resolveIndustryLocationFlagID(inventoryLocationID, ownerID, fallbackFlagID) {
  let currentLocationID = toInt(inventoryLocationID, 0);
  let resolvedFlagID = toInt(fallbackFlagID, 0);
  const numericOwnerID = toInt(ownerID, 0);
  const visited = new Set();

  for (let depth = 0; depth < MAX_INDUSTRY_LOCATION_ANCESTRY_DEPTH; depth += 1) {
    if (currentLocationID <= 0 || visited.has(currentLocationID)) {
      break;
    }
    visited.add(currentLocationID);
    if (
      worldData.getStationByID(currentLocationID) ||
      structureState.getStructureByID(currentLocationID, { refresh: false }) ||
      getCorporationOfficeByInventoryID(numericOwnerID, currentLocationID)
    ) {
      return resolvedFlagID;
    }
    const container = findItemById(currentLocationID);
    if (
      !container ||
      toInt(container.ownerID, 0) !== numericOwnerID ||
      !isIndustryContainerItem(container)
    ) {
      break;
    }
    resolvedFlagID = toInt(container.flagID, resolvedFlagID);
    currentLocationID = toInt(container.locationID, 0);
  }
  return toInt(fallbackFlagID, 0);
}

function getIndustryJobBlueprintInventoryFlagID(job) {
  return toInt(
    job && job.blueprintInventoryFlagID,
    toInt(job && job.blueprintLocationFlagID, -1),
  );
}

function getIndustryInventoryLocationID(location) {
  return toInt(
    location && (location.inventoryLocationID || location.itemID),
    0,
  );
}

function getIndustryLocationInventoryFlagID(location) {
  const container = findItemById(getIndustryInventoryLocationID(location));
  if (isIndustryContainerItem(container)) {
    if (toInt(container.groupID, 0) === INDUSTRY_UNLOCKED_CHILD_FLAG_GROUP_ID) {
      // Station and audit-log secure containers store ordinary movable contents
      // at flagUnlocked. flagLocked remains deliberately excluded: an industry
      // job must not bypass the container's item-level lock authority.
      return ITEM_FLAGS.UNLOCKED;
    }
    // The remaining client-supported industry container controllers use
    // flagNone for their contents.
    return 0;
  }
  return toInt(location && location.flagID, 0);
}

function getIndustryJobOutputInventoryFlagID(job) {
  return toInt(
    job && job.outputInventoryFlagID,
    toInt(job && job.outputFlagID, -1),
  );
}

function getIndustryJobOutputInventoryLocationID(job) {
  return toInt(
    job && (job.outputInventoryLocationID || job.outputLocationID),
    0,
  );
}

function buildIndustryOutputManifest(
  definition,
  activityID,
  runs,
  blueprintTypeID,
  productTypeID,
) {
  const numericActivityID = toInt(activityID, 0);
  if (
    numericActivityID === INDUSTRY_ACTIVITY.MANUFACTURING ||
    numericActivityID === INDUSTRY_ACTIVITY.REACTION
  ) {
    return buildProductOutput(definition, runs, numericActivityID);
  }
  if (numericActivityID === INDUSTRY_ACTIVITY.COPYING) {
    return [{
      typeID: toInt(blueprintTypeID, 0),
      quantity: Math.max(1, toInt(runs, 1)),
    }];
  }
  if (numericActivityID === INDUSTRY_ACTIVITY.INVENTION) {
    return [{
      typeID: toInt(productTypeID, 0),
      quantity: Math.max(1, toInt(runs, 1)),
    }].filter((entry) => entry.typeID > 0);
  }
  return [];
}

function resolveIndustryOutputCapacity(ownerID, outputLocation, manifest) {
  const inventoryLocationID = getIndustryInventoryLocationID(outputLocation);
  const container = findItemById(inventoryLocationID);
  if (!isIndustryContainerItem(container) && !starbaseIndustry.isAssemblyArray(container)) {
    return { constrained: false, overflow: false };
  }
  if (
    toInt(container.ownerID, 0) !== toInt(ownerID, 0) ||
    toInt(outputLocation && outputLocation.itemID, 0) !== toInt(container.itemID, 0)
  ) {
    return { constrained: true, overflow: true, invalid: true };
  }

  const capacity = Math.max(
    0,
    toFloat(
      container.capacity ?? getItemMetadata(container.typeID, container.itemName).capacity,
      0,
    ),
  );
  if (!(capacity > 0)) {
    return { constrained: false, overflow: false };
  }
  const used = listContainerItems(toInt(ownerID, 0), container.itemID, null)
    .reduce((total, item) => (
      total +
      Math.max(0, getInventoryItemUnitVolume(item)) *
        Math.max(1, getItemAvailableQuantity(item))
    ), 0);
  const required = (Array.isArray(manifest) ? manifest : []).reduce(
    (total, entry) => (
      total +
      Math.max(0, getPackagedVolumeForType(toInt(entry && entry.typeID, 0))) *
        Math.max(0, toInt(entry && entry.quantity, 0))
    ),
    0,
  );
  const free = Math.max(0, capacity - used);
  return {
    constrained: true,
    overflow: required > free + 1e-9,
    capacity,
    used,
    free,
    required,
  };
}

function resolveSavedIndustryJobOutputLocation(job, session) {
  const locations = resolveFacilityLocations(
    toInt(job && job.facilityID, 0),
    toInt(job && job.ownerID, 0),
    null,
    session,
  );
  const location = locations.find((entry) => (
    toInt(entry && entry.itemID, 0) === toInt(job && job.outputLocationID, 0) &&
    toInt(entry && entry.ownerID, 0) === toInt(job && job.ownerID, 0) &&
    toInt(entry && entry.flagID, 0) === toInt(job && job.outputFlagID, 0)
  )) || null;
  if (
    !location ||
    getIndustryInventoryLocationID(location) !==
      getIndustryJobOutputInventoryLocationID(job)
  ) {
    return null;
  }
  return location;
}

function buildBlueprintInstance(item) {
  if (shouldHideUnprotectedInstalledBlueprint(item)) {
    return null;
  }
  const state = getBlueprintState(item && item.itemID, item);
  if (!item || !state) {
    return null;
  }
  const installedJob = state.jobID ? getJobByID(state.jobID) : null;
  const inventoryLocationID = installedJob
    ? toInt(
        installedJob.blueprintInventoryLocationID || installedJob.blueprintLocationID,
        0,
      )
    : toInt(item.locationID, 0);
  let resolvedLocationID = installedJob
    ? toInt(installedJob.blueprintLocationID, 0)
    : toInt(item.locationID, 0);
  const resolvedLocationFlagID = installedJob
    ? toInt(installedJob.blueprintLocationFlagID, 0)
    : resolveIndustryLocationFlagID(inventoryLocationID, item.ownerID, item.flagID);
  const resolvedInventoryFlagID = installedJob
    ? getIndustryJobBlueprintInventoryFlagID(installedJob)
    : toInt(item.flagID, 0);
  const location = resolveLocationType(inventoryLocationID, item.ownerID);
  let resolvedLocationTypeID = installedJob
    ? toInt(installedJob.blueprintLocationTypeID, toInt(location.typeID, 0))
    : toInt(location.typeID, 0);
  if (
    !installedJob &&
    location.corporationOffice &&
    isCorporationOfficeInventoryLocation(location.corporationOffice, inventoryLocationID)
  ) {
    if (worldData.getStationByID(location.facilityID)) {
      resolvedLocationID = toInt(
        location.corporationOffice.officeID,
        inventoryLocationID,
      );
      resolvedLocationTypeID = OFFICE_TYPE_ID;
    } else {
      resolvedLocationID = toInt(location.facilityID, inventoryLocationID);
      resolvedLocationTypeID = toInt(location.facilityTypeID, 0);
    }
  }
  const resolvedFacilityID = installedJob
    ? toInt(installedJob.facilityID, 0)
    : toInt(location.facilityID, 0);
  return {
    typeID: toInt(item.typeID, 0),
    itemID: toInt(item.itemID, 0),
    timeEfficiency: toInt(state.timeEfficiency, 0),
    materialEfficiency: toInt(state.materialEfficiency, 0),
    original: state.original === true,
    runs: state.original ? -1 : Math.max(0, toInt(state.runsRemaining, 0)),
    quantity: state.original ? -1 : -2,
    locationID: resolvedLocationID,
    inventoryLocationID,
    locationTypeID: resolvedLocationTypeID,
    locationFlagID: resolvedLocationFlagID,
    flagID: resolvedInventoryFlagID,
    facilityID: resolvedFacilityID > 0 ? resolvedFacilityID : null,
    ownerID: toInt(item.ownerID, 0),
    jobID: state.jobID ? toInt(state.jobID, 0) : null,
    isImpounded: false,
    solarSystemID: toInt(location.solarSystemID, 0),
  };
}

function listBlueprintInstancesByOwner(ownerID, facilityID = null, session = null) {
  const numericOwnerID = toInt(ownerID, 0);
  const numericFacilityID =
    facilityID === null || facilityID === undefined ? null : toInt(facilityID, 0);
  const counts = {};
  const blueprints = [];

  for (const item of listOwnedItems(numericOwnerID, {
    categoryID: BLUEPRINT_CATEGORY_ID,
  })) {
    if (!canViewBlueprintInstance(session, item)) {
      continue;
    }
    const instance = buildBlueprintInstance(item);
    if (!instance) {
      continue;
    }
    const resolvedFacilityID =
      instance.facilityID === null || instance.facilityID === undefined
        ? null
        : toInt(instance.facilityID, 0);
    const countKey = resolvedFacilityID && resolvedFacilityID > 0
      ? String(resolvedFacilityID)
      : "null";
    counts[countKey] = (counts[countKey] || 0) + 1;
    if (numericFacilityID !== null && resolvedFacilityID !== numericFacilityID) {
      continue;
    }
    blueprints.push(instance);
  }

  blueprints.sort((left, right) => left.itemID - right.itemID);
  return {
    blueprints,
    counts,
  };
}

function getBlueprintByItemID(itemID, session = null) {
  const item = findItemById(itemID);
  if (!item || toInt(item.categoryID, 0) !== BLUEPRINT_CATEGORY_ID) {
    return null;
  }
  if (!canViewBlueprintInstance(session, item)) {
    return null;
  }
  return buildBlueprintInstance(item);
}

function getJobStatus(job) {
  if (!job) {
    return INDUSTRY_STATUS.UNSUBMITTED;
  }
  // Do not turn an offline or destroyed POS facility into a ready job merely
  // because its old deadline elapsed. Lifecycle writes retain remaining time.
  if (job.starbaseTowerID && toInt(job.status, 0) === INDUSTRY_STATUS.INSTALLED &&
      !starbaseIndustry.getArrayContext(job.facilityID)?.online) return INDUSTRY_STATUS.PAUSED;
  const endDate = normalizeIndustryFileTime(job.endDate, 0n);
  if (
    toInt(job.status, 0) === INDUSTRY_STATUS.INSTALLED &&
    endDate > 0n &&
    endDate <= currentFileTime()
  ) {
    return INDUSTRY_STATUS.READY;
  }
  return toInt(job.status, 0);
}

function listJobsByOwner(ownerID, includeCompleted = false) {
  const payload = ensureJobsTable();
  return Object.values(payload.jobs || {})
    .filter((job) => job && job.installationPending !== true)
    .filter((job) => toInt(job && job.ownerID, 0) === toInt(ownerID, 0))
    .map((job) => {
      const normalizedJob = normalizeIndustryJobRecord(job);
      return {
        ...normalizedJob,
        status: getJobStatus(normalizedJob),
      };
    })
    .filter((job) => includeCompleted || toInt(job.status, 0) < INDUSTRY_STATUS.COMPLETED)
    .sort((left, right) => left.jobID - right.jobID);
}

function getJobByID(jobID) {
  const payload = ensureJobsTable();
  const job = payload.jobs[String(toInt(jobID, 0))];
  if (!job) {
    return null;
  }
  const normalizedJob = normalizeIndustryJobRecord(job);
  return {
    ...normalizedJob,
    status: getJobStatus(normalizedJob),
  };
}

function hasUnfinishedIndustryJobsAtFacility(facilityID) {
  return hasPendingIndustryInstallAtFacility(facilityID) || Object.values(ensureJobsTable().jobs || {}).some((job) =>
    toInt(job.facilityID, 0) === toInt(facilityID, 0) &&
    (job.installationPending === true || toInt(job.status, 0) < INDUSTRY_STATUS.COMPLETED));
}

function hasPendingIndustryInstallAtFacility(facilityID) {
  return industryInstallSettlementState.listPendingIndustryInstallSettlements().some((settlement) =>
    toInt(settlement.jobRecord && settlement.jobRecord.facilityID, 0) === toInt(facilityID, 0)) ||
    Object.values(ensureJobsTable().jobs || {}).some((job) =>
    toInt(job.facilityID, 0) === toInt(facilityID, 0) && job.installationPending === true);
}

// Output already committed before a crash is inventory, even when its POS is
// now offline/destroying. Finish only that delivery's source custody and job
// record before destruction; never invoke a grant or fabricate new outputs.
function recoverCommittedAssemblyDeliveries(facilityID) {
  for (const job of Object.values(ensureJobsTable().jobs || {})) {
    if (!job.starbaseTowerID || toInt(job.facilityID, 0) !== toInt(facilityID, 0) ||
        job.installationPending === true ||
        toInt(job.status, 0) >= INDUSTRY_STATUS.COMPLETED) continue;
    const receipt = getIdempotentGrantReceipt(getIndustryOutputReceiptKey(job), { requireDurable: true });
    if (!receipt.success) return receipt;
    const sourceState = getStoredBlueprintState(job.blueprintID);
    const scienceFinished = toInt(sourceState?.lastCompletedJobID, 0) === toInt(job.jobID, 0);
    const failedInventionCommitted = toInt(job.activityID, 0) === INDUSTRY_ACTIVITY.INVENTION &&
      Number(job.inventionSuccessfulRuns) === 0 && ["outputsCreated", "sourceFinished"].includes(job.inventionDelivery?.phase);
    if (!receipt.found && !scienceFinished && !failedInventionCommitted) continue;
    const outputState = recoverCommittedStarbaseBlueprintOutputs(job, receipt);
    if (!outputState.success) return outputState;
    const source = finishBlueprintAfterDelivery(job, null);
    if (!source.success) return source;
    const persisted = persistRecoveredDeliveredIndustryJob(job);
    if (!persisted.success) return persisted;
    if (toInt(job.activityID, 0) === INDUSTRY_ACTIVITY.INVENTION) clearInventionOutputMarkers(job);
    queueDurableIndustryJobReconciliation(job.jobID);
    notifyIndustryJob(getJobByID(job.jobID));
    notifyBlueprintsUpdated(job.ownerID);
  }
  return { success: true };
}

function recoverCommittedStarbaseBlueprintOutputs(job, receipt) {
  const activityID = toInt(job.activityID, 0);
  if (![INDUSTRY_ACTIVITY.COPYING, INDUSTRY_ACTIVITY.INVENTION].includes(activityID)) return { success: true };
  const itemIDs = receipt.data?.resultData?.itemIDs || [];
  const outputItems = itemIDs.map(findItemById).filter(Boolean);
  const expectedCount = activityID === INDUSTRY_ACTIVITY.COPYING ? toInt(job.runs, 0) : Number(job.inventionSuccessfulRuns);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || outputItems.length !== expectedCount) {
    return { success: false, errorMsg: "STARBASE_INDUSTRY_OUTPUT_RECOVERY_CONFLICT" };
  }
  const source = getBlueprintState(job.blueprintID) || {};
  const decryptor = resolveDecryptorModifiers(job.optionalTypeID);
  const product = activityID === INDUSTRY_ACTIVITY.INVENTION
    ? resolveInventionProduct(getBlueprintDefinitionByTypeID(job.blueprintTypeID), job.productTypeID) : null;
  if (activityID === INDUSTRY_ACTIVITY.INVENTION && !product) return { success: false, errorMsg: "INVALID_PRODUCT" };
  const template = activityID === INDUSTRY_ACTIVITY.COPYING ? {
    typeID: job.blueprintTypeID, materialEfficiency: Number(source.materialEfficiency),
    timeEfficiency: Number(source.timeEfficiency), runsRemaining: job.licensedRuns,
  } : {
    typeID: product.typeID, materialEfficiency: INVENTION_MATERIAL_EFFICIENCY + decryptor.materialEfficiency,
    timeEfficiency: INVENTION_TIME_EFFICIENCY + decryptor.timeEfficiency,
    runsRemaining: Math.max(1, Math.round(toFloat(product.quantity, 0) + decryptor.maxRuns)),
  };
  const initialized = applyBlueprintStateToGrantedCopies({ data: { items: outputItems } }, template);
  return initialized.success
    ? flushIndustryTableSync(INDUSTRY_BLUEPRINT_STATE_TABLE, "INDUSTRY_OUTPUT_BLUEPRINT_STATE_FLUSH_FAILED") : initialized;
}

function buildDurableIndustryJobID(jobID, endDate) {
  return (
    `${DURABLE_READY_JOB_PREFIX}${toInt(jobID, 0)}:` +
    String(endDate || "")
  );
}

function buildDurableIndustryJob(job) {
  const normalizedJob = normalizeIndustryJobRecord(job);
  if (
    !normalizedJob ||
    normalizedJob.installationPending === true ||
    toInt(normalizedJob.jobID, 0) <= 0 ||
    toInt(normalizedJob.status, 0) !== INDUSTRY_STATUS.INSTALLED
  ) {
    return null;
  }
  const endDate = normalizeIndustryFileTime(normalizedJob.endDate, 0n);
  if (endDate <= 0n) {
    return null;
  }
  const remainingTicks = endDate - currentFileTime();
  const remainingMs = remainingTicks > 0n
    ? Number((remainingTicks + FILETIME_TICKS_PER_MILLISECOND - 1n)
      / FILETIME_TICKS_PER_MILLISECOND)
    : 0;
  return {
    jobID: buildDurableIndustryJobID(normalizedJob.jobID, endDate),
    type: DURABLE_READY_JOB_TYPE,
    dueAtMs: Date.now() + Math.max(0, remainingMs) + 100,
    payload: {
      endDate: endDate.toString(),
      industryJobID: toInt(normalizedJob.jobID, 0),
    },
  };
}

async function reconcileDurableIndustryJob(jobID, options = {}) {
  const numericJobID = toInt(jobID, 0);
  if (!durableScheduler || numericJobID <= 0) {
    return null;
  }
  const runningJobID = String(options.runningJobID || "");
  const previousJobID = durableJobIDs.get(numericJobID) || null;
  const jobsTable = ensureJobsTable();
  const job = buildDurableIndustryJob(jobsTable.jobs[String(numericJobID)]);
  if (!job) {
    durableJobIDs.delete(numericJobID);
    if (previousJobID && previousJobID !== runningJobID) {
      await durableScheduler.cancel(previousJobID);
    }
    return null;
  }
  if (previousJobID === job.jobID) {
    return job;
  }
  if (previousJobID && previousJobID !== runningJobID) {
    await durableScheduler.cancel(previousJobID);
  }
  await durableScheduler.schedule(job);
  durableJobIDs.set(numericJobID, job.jobID);
  return job;
}

function pauseInstalledStructureJobWhenServiceIsOffline(jobID, options = {}) {
  const numericJobID = toInt(jobID, 0);
  const jobsTable = ensureJobsTable();
  const rawJob = jobsTable.jobs[String(numericJobID)];
  const normalizedJob = normalizeIndustryJobRecord(rawJob);
  if (
    !normalizedJob ||
    normalizedJob.installationPending === true ||
    toInt(normalizedJob.status, 0) !== INDUSTRY_STATUS.INSTALLED
  ) {
    return { success: true, paused: false };
  }

  const structure = structureState.getStructureByID(
    toInt(normalizedJob.facilityID, 0),
    { refresh: false },
  );
  const isStarbaseJob = Boolean(normalizedJob.starbaseTowerID);
  if (!structure && !isStarbaseJob) {
    return { success: true, paused: false };
  }
  const requiredServiceID = resolveIndustryStructureServiceID(
    normalizedJob.activityID,
    normalizedJob.productTypeID,
  );
  if (
    toInt(requiredServiceID, 0) > 0 &&
    (isStarbaseJob ? starbaseIndustry.getArrayContext(normalizedJob.facilityID)?.online :
      structureHasOnlineService(structure, requiredServiceID))
  ) {
    return { success: true, paused: false };
  }

  const now = normalizeIndustryFileTime(options.nowFiletime, currentFileTime());
  const endDate = normalizeIndustryFileTime(normalizedJob.endDate, now);
  const pauseDate = endDate > 0n && endDate < now ? endDate : now;
  const updatedJob = {
    ...rawJob,
    status: INDUSTRY_STATUS.PAUSED,
    pauseDate: pauseDate.toString(),
  };
  jobsTable.jobs[String(numericJobID)] = updatedJob;
  if (!persistJobsTable(jobsTable)) {
    return { success: false, paused: false, errorMsg: "WRITE_ERROR" };
  }
  const normalizedUpdatedJob = normalizeIndustryJobRecord(updatedJob);
  notifyIndustryJob(normalizedUpdatedJob);
  createIndustryJobStructureNotification(
    normalizedUpdatedJob,
    NOTIFICATION_TYPE.STRUCTURES_JOBS_PAUSED,
  );
  return {
    success: true,
    paused: true,
    requiredServiceID: toInt(requiredServiceID, 0),
    job: normalizedUpdatedJob,
  };
}

function queueDurableIndustryJobReconciliation(jobID) {
  const numericJobID = toInt(jobID, 0);
  if (!durableScheduler || numericJobID <= 0) {
    return Promise.resolve(null);
  }
  const scheduler = durableScheduler;
  const generation = durableSchedulerGeneration;
  let commitError = null;
  try {
    database.flushTableAsync(INDUSTRY_JOBS_TABLE);
  } catch (error) {
    commitError = error;
  }
  const previousLane = durableScheduleLanes.get(numericJobID) || Promise.resolve();
  const lane = previousLane.catch(() => null).then(() => {
    if (
      scheduler !== durableScheduler ||
      generation !== durableSchedulerGeneration
    ) {
      return null;
    }
    if (commitError) {
      throw commitError;
    }
    return reconcileDurableIndustryJob(numericJobID);
  });
  durableScheduleLanes.set(numericJobID, lane);
  void lane.finally(() => {
    if (durableScheduleLanes.get(numericJobID) === lane) {
      durableScheduleLanes.delete(numericJobID);
    }
  }).catch(() => null);
  void lane.catch((error) => {
    log.warn(
      `[IndustryRuntime] durable readiness scheduling failed job=${numericJobID}: ${error.message}`,
    );
  });
  return lane;
}

function bindDurableScheduler(scheduler) {
  if (
    !scheduler ||
    typeof scheduler.schedule !== "function" ||
    typeof scheduler.cancel !== "function"
  ) {
    throw new TypeError("industry scheduler requires schedule and cancel functions");
  }
  durableSchedulerGeneration += 1;
  durableScheduler = scheduler;
  durableJobIDs.clear();
  durableScheduleLanes.clear();
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && durableScheduler !== scheduler) {
    return false;
  }
  durableSchedulerGeneration += 1;
  durableScheduler = null;
  durableJobIDs.clear();
  durableScheduleLanes.clear();
  return true;
}

function hasValidSettledIndustryBlueprintLocation(item) {
  const locationID = toInt(item && item.locationID, 0);
  return Boolean(
    item &&
    locationID > 0 &&
    locationID !== INDUSTRY_INSTALLED_LOCATION_ID &&
    toInt(item.flagID, -1) >= 0
  );
}

function getRecoverableIndustrySourceIntent(job, state, item) {
  if (!job || job.installationPending === true) {
    return null;
  }
  const jobID = toInt(job.jobID, 0);
  const stateJobID = toInt(state && state.jobID, 0);
  const status = getJobStatus(job);
  const itemValidOutsideInstalledLocation = Boolean(
    item &&
    toInt(item.ownerID, 0) === toInt(job.ownerID, 0) &&
    toInt(item.typeID, 0) === toInt(job.blueprintTypeID, 0) &&
    toInt(item.categoryID, 0) === BLUEPRINT_CATEGORY_ID &&
    toInt(item.singleton, 0) === (job.blueprintCopy === true ? 2 : 1) &&
    hasValidSettledIndustryBlueprintLocation(item),
  );
  const cancellationLinksJob = Boolean(
    state &&
    (
      stateJobID === jobID ||
      (
        stateJobID === 0 &&
        toInt(state.lastCancelledJobID, 0) === jobID
      )
    )
  );
  const deliveryLinksJob = Boolean(
    state &&
    (
      stateJobID === jobID ||
      (
        stateJobID === 0 &&
        toInt(state.lastCompletedJobID, 0) === jobID
      )
    )
  );
  if (
    status === INDUSTRY_STATUS.CANCELLED &&
    cancellationLinksJob &&
    !(
      stateJobID === 0 &&
      toInt(state.lastCancelledJobID, 0) === jobID &&
      itemValidOutsideInstalledLocation
    )
  ) {
    return "cancellation";
  }
  if (
    status === INDUSTRY_STATUS.DELIVERED &&
    deliveryLinksJob &&
    !(
      stateJobID === 0 &&
      toInt(state.lastCompletedJobID, 0) === jobID &&
      itemValidOutsideInstalledLocation
    )
  ) {
    return "delivery";
  }
  if (status !== INDUSTRY_STATUS.READY) {
    return null;
  }
  if (toInt(state && state.lastCompletedJobID, 0) === jobID) {
    return "delivery";
  }
  const itemStillInstalled = Boolean(
    item &&
    toInt(item.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID,
  );
  if (stateJobID === jobID && !itemStillInstalled) {
    return "delivery";
  }
  if (!state && job.blueprintCopy === true && !item) {
    return "delivery";
  }
  return null;
}

function persistRecoveredDeliveredIndustryJob(job) {
  const jobID = toInt(job && job.jobID, 0);
  const jobsTable = ensureJobsTable();
  const storedJob = jobsTable.jobs[String(jobID)];
  if (!storedJob) {
    return { success: false, errorMsg: "JOB_NOT_FOUND" };
  }
  if (toInt(storedJob.status, 0) !== INDUSTRY_STATUS.DELIVERED) {
    const successfulRuns = toInt(job && job.activityID, 0) === INDUSTRY_ACTIVITY.INVENTION
      ? Math.max(0, toInt(job && job.inventionSuccessfulRuns, 0))
      : Math.max(0, toInt(job && (job.successfulRuns || job.runs), 0));
    jobsTable.jobs[String(jobID)] = {
      ...storedJob,
      status: INDUSTRY_STATUS.DELIVERED,
      completedCharacterID: toInt(
        job && (job.completedCharacterID || job.installerID),
        0,
      ),
      successfulRuns,
      deliveredAt: String(job && job.deliveredAt || currentFileTime().toString()),
    };
    if (!persistJobsTable(jobsTable)) {
      return { success: false, ambiguous: true, errorMsg: "WRITE_ERROR" };
    }
  }
  return flushIndustryTableSync(
    INDUSTRY_JOBS_TABLE,
    "INDUSTRY_BLUEPRINT_SETTLEMENT_JOB_FLUSH_FAILED",
  );
}

function reconcileIndustrySourceSettlements() {
  let recovered = 0;
  let unresolved = 0;
  const jobs = Object.values(ensureJobsTable().jobs || {});
  const jobsByID = new Map(jobs.map((job) => [
    toInt(job && job.jobID, 0),
    job,
  ]).filter(([jobID]) => jobID > 0));
  const stateRecords = ensureBlueprintStateTable().records || {};
  for (const rawJob of jobs) {
    let job = null;
    try {
      job = normalizeIndustryJobRecord(rawJob);
      const status = getJobStatus(job);
      if (![
        INDUSTRY_STATUS.READY,
        INDUSTRY_STATUS.DELIVERED,
        INDUSTRY_STATUS.CANCELLED,
      ].includes(status)) {
        continue;
      }
      const blueprintID = toInt(job && job.blueprintID, 0);
      const rawState = stateRecords[String(blueprintID)];
      const state = rawState && typeof rawState === "object"
        ? cloneValue(rawState)
        : null;
      const item = findItemById(blueprintID);
      const intent = getRecoverableIndustrySourceIntent(job, state, item);
      if (!intent) {
        continue;
      }
      const jobID = toInt(job && job.jobID, 0);
      const authoritativePostState = Boolean(
        state &&
        (
          toInt(state.lastCompletedJobID, 0) === jobID ||
          toInt(state.lastCancelledJobID, 0) === jobID
        )
      );
      const allowExistingPostcondition =
        status >= INDUSTRY_STATUS.COMPLETED || authoritativePostState;
      const result = intent === "cancellation"
        ? finishCancelledIndustryJobSource(job, null, {
            allowExistingPostcondition,
          })
        : finishBlueprintAfterDelivery(job, null, {
            allowExistingPostcondition,
          });
      if (!result.success) {
        unresolved += 1;
        log.warn(
          "[IndustryRuntime] source blueprint settlement remains unresolved " +
            "job=" + jobID +
            " blueprint=" + blueprintID +
            " error=" + String(result.errorMsg || "UNKNOWN"),
        );
        continue;
      }
      if (
        intent === "delivery" &&
        status !== INDUSTRY_STATUS.DELIVERED
      ) {
        const finalizeResult = persistRecoveredDeliveredIndustryJob(job);
        if (!finalizeResult.success) {
          unresolved += 1;
          log.warn(
            "[IndustryRuntime] recovered source blueprint but could not finalize job " +
              "job=" + jobID +
              " error=" + String(finalizeResult.errorMsg || "UNKNOWN"),
          );
          continue;
        }
      }
      recovered += 1;
      loggedIndustryBlueprintOrphanIDs.delete(blueprintID);
    } catch (error) {
      unresolved += 1;
      log.warn(
        "[IndustryRuntime] source blueprint settlement recovery threw " +
          "job=" + toInt(job && job.jobID, 0) +
          " blueprint=" + toInt(job && job.blueprintID, 0) +
          " error=" + String(error && error.message || error || "UNKNOWN"),
      );
    }
  }
  const allItems = typeof getAllItems === "function" ? getAllItems() : {};
  const installedItems = Array.isArray(allItems)
    ? allItems
    : Object.values(allItems || {});
  for (const item of installedItems) {
    if (
      toInt(item && item.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID &&
      toInt(item && item.categoryID, 0) === BLUEPRINT_CATEGORY_ID
    ) {
      const state = stateRecords[String(toInt(item.itemID, 0))] || null;
      const job = jobsByID.get(toInt(state && state.jobID, 0)) || null;
      shouldHideUnprotectedInstalledBlueprint(item, { state, job });
    }
  }
  return { recovered, unresolved };
}

async function reconcileStarbaseFacilityIndustryJobs(facilityID) {
  const result = starbaseIndustry.reconcileAssemblyJobs(facilityID, { notify: false });
  if (!result?.success) {
    throw new Error(`failed to reconcile POS industry facility=${facilityID}: ${result?.errorMsg || "UNKNOWN"}`);
  }
  let scheduled = 0;
  let paused = 0;
  if (durableScheduler) {
    for (const job of Object.values(ensureJobsTable().jobs || {})) {
      if (!job.starbaseTowerID || toInt(job.facilityID, 0) !== facilityID) continue;
      const serviceResult = pauseInstalledStructureJobWhenServiceIsOffline(job.jobID);
      if (!serviceResult.success) {
        throw new Error(`failed to reconcile POS industry service job=${job.jobID}: ${serviceResult.errorMsg || "UNKNOWN"}`);
      }
      if (serviceResult.paused) paused += 1;
      if (await reconcileDurableIndustryJob(job.jobID)) scheduled += 1;
    }
  }
  return { scheduled, paused };
}

async function reconcileDurableIndustryJobs() {
  const sourceSettlements = reconcileIndustrySourceSettlements();
  // Recover a crash between the POS online-state write and the shared job
  // pause/resume write. No second job clock or material ledger is introduced.
  const starbaseFacilityIDs = new Set(Object.values(ensureJobsTable().jobs || {})
    .filter((job) => job.starbaseTowerID && toInt(job.status, 0) < INDUSTRY_STATUS.COMPLETED)
    .map((job) => toInt(job.facilityID, 0)));
  let scheduled = 0;
  let paused = 0;
  let starbaseRetriesScheduled = 0;
  const unresolvedStarbaseFacilityIDs = [];
  for (const facilityID of starbaseFacilityIDs) {
    try {
      const result = await reconcileStarbaseFacilityIndustryJobs(facilityID);
      scheduled += result.scheduled;
      paused += result.paused;
    } catch (error) {
      unresolvedStarbaseFacilityIDs.push(facilityID);
      log.warn(`[IndustryRuntime] POS facility reconciliation remains unresolved facility=${facilityID}: ${error.message}`);
      // A paused job has no readiness deadline. Persist a facility recovery
      // wake on the existing owner so it can resume without another restart.
      // Handler failures retain the scheduler's normal retry/dead-letter path.
      if (durableScheduler) {
        try {
          await durableScheduler.schedule({
            jobID: `industry-facility:${facilityID}:reconcile`,
            type: DURABLE_READY_JOB_TYPE,
            dueAtMs: Date.now() + 1000,
            payload: { starbaseFacilityID: facilityID },
          });
          starbaseRetriesScheduled += 1;
        } catch (retryError) {
          log.warn(`[IndustryRuntime] POS facility recovery could not be queued facility=${facilityID}; restart or recovery pass required: ${retryError.message}`);
        }
      }
    }
  }
  const recovery = {
    ...sourceSettlements,
    unresolved: sourceSettlements.unresolved + unresolvedStarbaseFacilityIDs.length,
    unresolvedStarbaseFacilityIDs,
    starbaseRetriesScheduled,
  };
  if (!durableScheduler) {
    return { scheduled: 0, ...recovery };
  }
  const jobsTable = ensureJobsTable();
  for (const [jobID, rawJob] of Object.entries(jobsTable.jobs || {})) {
    // POS jobs were handled per facility, including any failed custody repair.
    // Do not re-enter a failed facility through the general readiness pass.
    if (rawJob.starbaseTowerID && starbaseFacilityIDs.has(toInt(rawJob.facilityID, 0))) continue;
    const serviceResult = pauseInstalledStructureJobWhenServiceIsOffline(jobID);
    if (!serviceResult.success) {
      throw new Error(`failed to reconcile industry service state for job ${jobID}`);
    }
    if (serviceResult.paused) {
      paused += 1;
    }
    const job = await reconcileDurableIndustryJob(jobID);
    if (job) scheduled += 1;
  }
  return { scheduled, paused, ...recovery };
}

async function handleDurableIndustryJobReady(job) {
  const starbaseFacilityID = toInt(job?.payload?.starbaseFacilityID, 0);
  if (starbaseFacilityID > 0) {
    if (job.jobID !== `industry-facility:${starbaseFacilityID}:reconcile`) {
      throw new Error("industry facility reconciliation job is invalid");
    }
    const result = await reconcileStarbaseFacilityIndustryJobs(starbaseFacilityID);
    log.info(`[IndustryRuntime] POS facility reconciliation recovered facility=${starbaseFacilityID}`);
    return { starbaseFacilityID, ...result };
  }
  const industryJobID = toInt(
    job && job.payload && job.payload.industryJobID,
    0,
  );
  const scheduledJobID = String(job && job.jobID || "");
  if (industryJobID <= 0 || !scheduledJobID) {
    throw new Error("industry readiness job is invalid");
  }
  if (durableJobIDs.get(industryJobID) === scheduledJobID) {
    durableJobIDs.delete(industryJobID);
  }

  const jobsTable = ensureJobsTable();
  const rawJob = jobsTable.jobs[String(industryJobID)];
  const normalizedJob = normalizeIndustryJobRecord(rawJob);
  if (!normalizedJob) {
    return { industryJobID, missing: true };
  }
  if (toInt(normalizedJob.status, 0) !== INDUSTRY_STATUS.INSTALLED) {
    database.flushTableAsync(INDUSTRY_JOBS_TABLE);
    await reconcileDurableIndustryJob(industryJobID, {
      runningJobID: scheduledJobID,
    });
    return {
      industryJobID,
      ready: toInt(normalizedJob.status, 0) === INDUSTRY_STATUS.READY,
      stale: true,
    };
  }

  const serviceResult = pauseInstalledStructureJobWhenServiceIsOffline(industryJobID);
  if (!serviceResult.success) {
    throw new Error("failed to persist offline industry service pause");
  }
  if (serviceResult.paused) {
    database.flushTableAsync(INDUSTRY_JOBS_TABLE);
    await reconcileDurableIndustryJob(industryJobID, {
      runningJobID: scheduledJobID,
    });
    return {
      industryJobID,
      ready: false,
      paused: true,
      stale: false,
    };
  }

  const expectedEndDate = normalizeIndustryFileTime(
    job && job.payload && job.payload.endDate,
    0n,
  );
  const currentEndDate = normalizeIndustryFileTime(normalizedJob.endDate, 0n);
  if (currentEndDate !== expectedEndDate) {
    database.flushTableAsync(INDUSTRY_JOBS_TABLE);
    await reconcileDurableIndustryJob(industryJobID, {
      runningJobID: scheduledJobID,
    });
    return { industryJobID, ready: false, stale: true };
  }
  if (currentEndDate > currentFileTime()) {
    throw new Error("industry readiness fired before the job end date");
  }

  const updatedJob = {
    ...rawJob,
    status: INDUSTRY_STATUS.READY,
    pauseDate: null,
  };
  jobsTable.jobs[String(industryJobID)] = updatedJob;
  if (!persistJobsTable(jobsTable)) {
    throw new Error("failed to persist industry readiness");
  }
  database.flushTableAsync(INDUSTRY_JOBS_TABLE);
  notifyIndustryJob(updatedJob);
  return { industryJobID, ready: true, stale: false };
}

function normalizeServiceIDSet(serviceIDs) {
  const values =
    serviceIDs instanceof Set
      ? [...serviceIDs]
      : Array.isArray(serviceIDs)
        ? serviceIDs
        : [serviceIDs];
  return new Set(
    values
      .map((serviceID) => toInt(serviceID, 0))
      .filter((serviceID) => serviceID > 0),
  );
}

function jobRequiresStructureService(job, structureID, serviceIDSet) {
  if (
    toInt(job && job.facilityID, 0) !== toInt(structureID, 0) ||
    !(serviceIDSet instanceof Set) ||
    serviceIDSet.size === 0
  ) {
    return false;
  }
  const requiredServiceID = resolveIndustryStructureServiceID(
    job.activityID,
    job.productTypeID,
  );
  return serviceIDSet.has(toInt(requiredServiceID, 0));
}

function getCorporationStateService() {
  return require(path.join(__dirname, "../corporation/corporationState"));
}

function getNotificationStateService() {
  return require(path.join(__dirname, "../notifications/notificationState"));
}

function buildIndustryJobStructureNotificationData(structure, isCorpOwned) {
  const structureID = toInt(structure && structure.structureID, 0);
  const structureTypeID = toInt(structure && structure.typeID, 0);
  return {
    structureID,
    structureShowInfoData: ["showinfo", structureTypeID, structureID],
    solarsystemID: toInt(structure && structure.solarSystemID, 0),
    structureTypeID,
    isCorpOwned: isCorpOwned === true,
  };
}

function isCharacterOwnerID(ownerID) {
  const numericOwnerID = toInt(ownerID, 0);
  if (numericOwnerID <= 0) {
    return false;
  }
  const result = database.read("characters", "/");
  const characters =
    result && result.success && result.data && typeof result.data === "object"
      ? result.data
      : {};
  return Boolean(characters[String(numericOwnerID)]);
}

function createIndustryJobStructureNotification(job, notificationTypeID) {
  const typeID = toInt(notificationTypeID, 0);
  const ownerID = toInt(job && job.ownerID, 0);
  const structureID = toInt(job && job.facilityID, 0);
  if (typeID <= 0 || ownerID <= 0 || structureID <= 0) {
    return;
  }
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  if (!structure) {
    return;
  }
  const isCorpOwned = !isCharacterOwnerID(ownerID);
  const corporationState = getCorporationStateService();
  const characterIDs = isCorpOwned
    ? corporationState.getCharacterIDsInCorporation(ownerID)
    : [ownerID];
  const senderID = toInt(
    structure.ownerCorpID || structure.ownerID || ownerID,
    ownerID,
  );
  const data = buildIndustryJobStructureNotificationData(structure, isCorpOwned);
  const notificationState = getNotificationStateService();
  for (const characterID of [...new Set(characterIDs.map((value) => toInt(value, 0)).filter(Boolean))]) {
    notificationState.createNotification(characterID, {
      typeID,
      senderID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data,
      emitLive: true,
    });
  }
}

function pauseIndustryJobsForStructureServices(structureID, serviceIDs, options = {}) {
  const numericStructureID = toInt(structureID, 0);
  const serviceIDSet = normalizeServiceIDSet(serviceIDs);
  if (numericStructureID <= 0 || serviceIDSet.size === 0) {
    return { success: true, data: { changedJobIDs: [] } };
  }

  const now = normalizeIndustryFileTime(options.nowFiletime, currentFileTime());
  const jobsTable = ensureJobsTable();
  const changedJobs = [];
  for (const [jobID, job] of Object.entries(jobsTable.jobs || {})) {
    const normalizedJob = normalizeIndustryJobRecord(job);
    if (!jobRequiresStructureService(normalizedJob, numericStructureID, serviceIDSet)) {
      continue;
    }
    if ((normalizedJob.starbaseTowerID ? toInt(normalizedJob.status, 0) : getJobStatus(normalizedJob)) !== INDUSTRY_STATUS.INSTALLED) {
      continue;
    }
    const updatedJob = {
      ...job,
      status: INDUSTRY_STATUS.PAUSED,
      pauseDate: now.toString(),
    };
    jobsTable.jobs[jobID] = updatedJob;
    changedJobs.push(normalizeIndustryJobRecord(updatedJob));
  }

  if (changedJobs.length === 0) {
    return { success: true, data: { changedJobIDs: [] } };
  }
  if (!persistJobsTable(jobsTable)) {
    return { success: false, errorMsg: "WRITE_ERROR", data: { changedJobIDs: [] } };
  }
  for (const job of changedJobs) {
    queueDurableIndustryJobReconciliation(job.jobID);
    notifyIndustryJob(job);
    createIndustryJobStructureNotification(
      job,
      NOTIFICATION_TYPE.STRUCTURES_JOBS_PAUSED,
    );
  }
  return {
    success: true,
    data: {
      changedJobIDs: changedJobs.map((job) => toInt(job.jobID, 0)),
      jobs: changedJobs,
    },
  };
}

function resumeIndustryJobsForStructureServices(structureID, serviceIDs, options = {}) {
  const numericStructureID = toInt(structureID, 0);
  const serviceIDSet = normalizeServiceIDSet(serviceIDs);
  if (numericStructureID <= 0 || serviceIDSet.size === 0) {
    return { success: true, data: { changedJobIDs: [] } };
  }

  const now = normalizeIndustryFileTime(options.nowFiletime, currentFileTime());
  const jobsTable = ensureJobsTable();
  const changedJobs = [];
  for (const [jobID, job] of Object.entries(jobsTable.jobs || {})) {
    const normalizedJob = normalizeIndustryJobRecord(job);
    if (!jobRequiresStructureService(normalizedJob, numericStructureID, serviceIDSet)) {
      continue;
    }
    if (toInt(normalizedJob.status, 0) !== INDUSTRY_STATUS.PAUSED) {
      continue;
    }
    const pauseDate = normalizeIndustryFileTime(normalizedJob.pauseDate, now);
    const endDate = normalizeIndustryFileTime(normalizedJob.endDate, now);
    const remainingTicks = endDate > pauseDate ? endDate - pauseDate : 0n;
    const nextEndDate = now + remainingTicks;
    const updatedJob = {
      ...job,
      status: remainingTicks > 0n ? INDUSTRY_STATUS.INSTALLED : INDUSTRY_STATUS.READY,
      endDate: nextEndDate.toString(),
      pauseDate: null,
    };
    jobsTable.jobs[jobID] = updatedJob;
    changedJobs.push(normalizeIndustryJobRecord(updatedJob));
  }

  if (changedJobs.length === 0) {
    return { success: true, data: { changedJobIDs: [] } };
  }
  if (!persistJobsTable(jobsTable)) {
    return { success: false, errorMsg: "WRITE_ERROR", data: { changedJobIDs: [] } };
  }
  for (const job of changedJobs) {
    queueDurableIndustryJobReconciliation(job.jobID);
    notifyIndustryJob(job);
  }
  return {
    success: true,
    data: {
      changedJobIDs: changedJobs.map((job) => toInt(job.jobID, 0)),
      jobs: changedJobs,
    },
  };
}

function cancelIndustryJobsMatching(predicate, options = {}) {
  if (typeof predicate !== "function") {
    return { success: true, data: { changedJobIDs: [] } };
  }
  const now = normalizeIndustryFileTime(options.nowFiletime, currentFileTime());
  const completedCharacterID = toInt(options.completedCharacterID, 0);
  const jobsTable = ensureJobsTable();
  const changedJobs = [];
  const jobsToFinalize = [];
  for (const rawJob of Object.values(jobsTable.jobs || {})) {
    const job = normalizeIndustryJobRecord(rawJob);
    if (
      !job ||
      job.installationPending === true ||
      !predicate(job)
    ) {
      continue;
    }
    const status = getJobStatus(job);
    if (
      status !== INDUSTRY_STATUS.CANCELLED &&
      status < INDUSTRY_STATUS.COMPLETED
    ) {
      const sourcePreflight = preflightIndustryBlueprintCancellation(job);
      if (!sourcePreflight.success) {
        return {
          success: false,
          ambiguous: sourcePreflight.ambiguous === true,
          errorMsg:
            sourcePreflight.errorMsg ||
            "INDUSTRY_CANCEL_SOURCE_PREFLIGHT_FAILED",
          data: { changedJobIDs: [] },
        };
      }
    }
  }
  for (const [jobID, job] of Object.entries(jobsTable.jobs || {})) {
    const normalizedJob = normalizeIndustryJobRecord(job);
    if (!normalizedJob || normalizedJob.installationPending === true) {
      continue;
    }
    if (!predicate(normalizedJob)) {
      continue;
    }
    if (toInt(normalizedJob.status, 0) === INDUSTRY_STATUS.CANCELLED) {
      const blueprintID = toInt(normalizedJob.blueprintID, 0);
      if (
        getRecoverableIndustrySourceIntent(
          normalizedJob,
          getStoredBlueprintState(blueprintID),
          findItemById(blueprintID),
        ) === "cancellation"
      ) {
        jobsToFinalize.push(normalizedJob);
      }
      continue;
    }
    if (toInt(normalizedJob.status, 0) >= INDUSTRY_STATUS.COMPLETED) {
      continue;
    }
    const updatedJob = {
      ...job,
      status: INDUSTRY_STATUS.CANCELLED,
      completedCharacterID,
      successfulRuns: 0,
      pauseDate: null,
      cancelledAt: now.toString(),
    };
    jobsTable.jobs[jobID] = updatedJob;
    const normalizedUpdatedJob = normalizeIndustryJobRecord(updatedJob);
    changedJobs.push(normalizedUpdatedJob);
    jobsToFinalize.push(normalizedUpdatedJob);
  }

  if (changedJobs.length === 0 && jobsToFinalize.length === 0) {
    return { success: true, data: { changedJobIDs: [] } };
  }
  if (changedJobs.length > 0) {
    if (!persistJobsTable(jobsTable)) {
      return { success: false, errorMsg: "WRITE_ERROR", data: { changedJobIDs: [] } };
    }
    const flushResult = database.flushTableSync(INDUSTRY_JOBS_TABLE);
    if (!flushResult || flushResult.success !== true) {
      return {
        success: false,
        errorMsg: "INDUSTRY_CANCEL_FLUSH_FAILED",
        data: { changedJobIDs: [] },
      };
    }
  }
  const session = options.session || null;
  for (const job of jobsToFinalize) {
    queueDurableIndustryJobReconciliation(job.jobID);
    const sourceResult = finishCancelledIndustryJobSource(job, session);
    if (!sourceResult.success) {
      return {
        success: false,
        errorMsg:
          sourceResult.errorMsg || "INDUSTRY_CANCEL_SOURCE_RETURN_FAILED",
        data: {
          changedJobIDs: changedJobs.map((entry) => toInt(entry.jobID, 0)),
        },
      };
    }
    notifyBlueprintsUpdated(job.ownerID);
    if (changedJobs.some((entry) => toInt(entry.jobID, 0) === toInt(job.jobID, 0))) {
      notifyIndustryJob(job);
      createIndustryJobStructureNotification(
        job,
        NOTIFICATION_TYPE.STRUCTURES_JOBS_CANCELLED,
      );
    }
  }
  return {
    success: true,
    data: {
      changedJobIDs: changedJobs.map((job) => toInt(job.jobID, 0)),
      jobs: changedJobs,
    },
  };
}

function cancelIndustryJobsForStructureServices(structureID, serviceIDs, options = {}) {
  const numericStructureID = toInt(structureID, 0);
  const serviceIDSet = normalizeServiceIDSet(serviceIDs);
  if (numericStructureID <= 0 || serviceIDSet.size === 0) {
    return { success: true, data: { changedJobIDs: [] } };
  }

  return cancelIndustryJobsMatching(
    (job) => jobRequiresStructureService(job, numericStructureID, serviceIDSet),
    options,
  );
}

function cancelIndustryJobsForStructure(structureID, options = {}) {
  const numericStructureID = toInt(structureID, 0);
  if (numericStructureID <= 0) {
    return { success: true, data: { changedJobIDs: [] } };
  }

  return cancelIndustryJobsMatching(
    (job) => toInt(job && job.facilityID, 0) === numericStructureID,
    options,
  );
}

function buildIndustryJobsOverLast24HoursRows(jobs, activityID = 0, nowFiletime = currentFileTime()) {
  const numericActivityID = Math.max(0, toInt(activityID, 0));
  const now = normalizeIndustryFileTime(nowFiletime, currentFileTime());
  const cutoff = now - FILETIME_TICKS_PER_DAY;
  const futureGrace = now + FILETIME_TICKS_PER_MINUTE;
  const countsBySolarSystemID = new Map();

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job && job.installationPending === true) {
      continue;
    }
    const solarSystemID = toInt(job && job.solarSystemID, 0);
    if (solarSystemID <= 0) {
      continue;
    }
    if (numericActivityID > 0 && toInt(job && job.activityID, 0) !== numericActivityID) {
      continue;
    }
    const startDate = normalizeIndustryFileTime(job && job.startDate, 0n);
    if (startDate <= 0n || startDate < cutoff || startDate > futureGrace) {
      continue;
    }
    countsBySolarSystemID.set(
      solarSystemID,
      (countsBySolarSystemID.get(solarSystemID) || 0) + 1,
    );
  }

  return [...countsBySolarSystemID.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([solarSystemID, noOfJobs]) => [solarSystemID, noOfJobs]);
}

function listIndustryJobsOverLast24Hours(activityID = 0, nowFiletime = currentFileTime()) {
  const payload = ensureJobsTable();
  return buildIndustryJobsOverLast24HoursRows(
    Object.values(payload.jobs || {}),
    activityID,
    nowFiletime,
  );
}

function allocateJobID(payload) {
  const allocated = Math.max(JOB_ID_START, toInt(payload._meta.nextJobID, JOB_ID_START));
  payload._meta.nextJobID = allocated + 1;
  return allocated;
}

function reserveIndustryJobID() {
  const payload = ensureJobsTable();
  const jobID = allocateJobID(payload);
  if (!persistJobsTable(payload)) {
    return { success: false, errorMsg: "INDUSTRY_JOB_ID_RESERVATION_FAILED" };
  }
  const flushResult = database.flushTableSync(INDUSTRY_JOBS_TABLE);
  return flushResult && flushResult.success
    ? { success: true, jobID }
    : flushResult || { success: false, errorMsg: "INDUSTRY_JOB_ID_RESERVATION_FLUSH_FAILED" };
}

function getStationIDForFacility(facilityID) {
  const station = worldData.getStationByID(facilityID);
  return station ? toInt(station.stationID, 0) : 0;
}

function buildIndustryValidationError(code, ...args) {
  return {
    code: toInt(code, 0),
    args,
  };
}

function throwIndustryValidationError(errors = []) {
  throwWrappedUserError("IndustryValidationError", {
    errors: buildIndustryValidationErrors(errors),
  });
}

function resolveFacilityLocations(facilityID, ownerID, _blueprint = null, session = null) {
  const facility = getFacilityPayloadByID(facilityID, session);
  if (!facility) {
    return [];
  }
  if (starbaseIndustry.isAssemblyArray(findItemById(facilityID))) {
    return starbaseIndustry.getAssemblyLocations(facilityID, ownerID, session);
  }
  const locations = [];
  const seen = new Set();
  const numericOwnerID = toInt(ownerID, 0);
  const pushLocation = (entry) => {
    if (!entry || toInt(entry.itemID, 0) <= 0) {
      return;
    }
    const key = `${entry.itemID}:${entry.flagID}:${entry.ownerID}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    locations.push(entry);
  };
  const pushContainers = (inventoryLocationIDs, rootLocation) => {
    for (const inventoryLocationID of inventoryLocationIDs) {
      for (const item of listContainerItems(
        numericOwnerID,
        inventoryLocationID,
        rootLocation.flagID,
      )) {
        if (!isIndustryContainerItem(item)) {
          continue;
        }
        pushLocation({
          itemID: toInt(item.itemID, 0),
          inventoryLocationID: toInt(item.itemID, 0),
          typeID: toInt(item.typeID, 0),
          ownerID: numericOwnerID,
          flagID: toInt(rootLocation.flagID, 0),
          solarSystemID: facility.solarSystemID,
          canView: rootLocation.canView,
          canTake: rootLocation.canTake,
        });
      }
    }
  };

  if (session && isCorporationOwner(session, numericOwnerID)) {
    const office = resolveCorporationOfficeForFacility(
      numericOwnerID,
      facility.facilityID,
    );
    if (!office) {
      return [];
    }
    const officeInventoryLocationIDs = getCorporationOfficeInventoryLocationIDs(office);
    const primaryOfficeInventoryLocationID = getPrimaryCorporationOfficeInventoryLocationID(office);
    if (primaryOfficeInventoryLocationID <= 0) {
      return [];
    }
    const station = worldData.getStationByID(facility.facilityID);
    const clientRootItemID = station
      ? toInt(office.officeID, primaryOfficeInventoryLocationID)
      : toInt(facility.facilityID, 0);
    const clientRootTypeID = station ? OFFICE_TYPE_ID : toInt(facility.typeID, 0);
    for (const flagID of getAccessibleCorpHangarFlags(session, facility.facilityID)) {
      const rootLocation = {
        itemID: clientRootItemID,
        inventoryLocationID: primaryOfficeInventoryLocationID,
        typeID: clientRootTypeID,
        ownerID: numericOwnerID,
        flagID,
        solarSystemID: facility.solarSystemID,
        canView: canViewOwnerLocation(session, numericOwnerID, facility.facilityID, flagID),
        canTake: canTakeFromOwnerLocation(session, numericOwnerID, facility.facilityID, flagID),
      };
      pushLocation(rootLocation);
      if (
        rootLocation.canTake ||
        hasCorporationIndustryJobAccess(session, numericOwnerID)
      ) {
        pushContainers(officeInventoryLocationIDs, rootLocation);
      }
    }
    // Corp Deliveries is not an office slot: the client lists it, and retail's
    // own fallback builds it, at the station or structure itself. Output filed
    // under the office was stored where no inventory window looks.
    pushLocation({
      itemID: toInt(facility.facilityID, 0),
      inventoryLocationID: toInt(facility.facilityID, 0),
      typeID: station
        ? toInt(station.stationTypeID, toInt(facility.typeID, 0))
        : toInt(facility.typeID, 0),
      ownerID: numericOwnerID,
      flagID: ITEM_FLAG_CORP_DELIVERIES,
      solarSystemID: facility.solarSystemID,
      canView: canViewOwnerLocation(session, numericOwnerID, facility.facilityID, ITEM_FLAG_CORP_DELIVERIES),
      canTake: canTakeFromOwnerLocation(session, numericOwnerID, facility.facilityID, ITEM_FLAG_CORP_DELIVERIES),
    });
  } else {
    const rootLocation = {
      itemID: facility.facilityID,
      inventoryLocationID: facility.facilityID,
      typeID: facility.typeID,
      ownerID: numericOwnerID,
      flagID: ITEM_FLAG_HANGAR,
      solarSystemID: facility.solarSystemID,
      canView: true,
      canTake: true,
    };
    pushLocation(rootLocation);
    pushContainers([facility.facilityID], rootLocation);
  }

  return locations.filter((location) => location.canView !== false);
}

function resolveAvailableMaterials(ownerID, inputLocation) {
  if (!inputLocation) {
    return {};
  }
  const materials = {};
  for (const item of listContainerItems(
    toInt(ownerID, 0),
    getIndustryInventoryLocationID(inputLocation),
    getIndustryLocationInventoryFlagID(inputLocation),
  )) {
    const typeID = toInt(item && item.typeID, 0);
    if (typeID <= 0 || toInt(item.categoryID, 0) === BLUEPRINT_CATEGORY_ID) {
      continue;
    }
    const quantity =
      toInt(item.singleton, 0) === 1 ? 1 : Math.max(0, toInt(item.stacksize || item.quantity, 0));
    materials[typeID] = (materials[typeID] || 0) + quantity;
  }
  return materials;
}

function resolveInventionDecryptorSelection(requestMaterials, runs) {
  const materials =
    requestMaterials && typeof requestMaterials === "object"
      ? requestMaterials
      : {};
  const selected = Object.entries(materials)
    .map(([typeID, quantity]) => ({
      typeID: toInt(typeID, 0),
      quantity: toInt(quantity, 0),
    }))
    .filter((entry) => entry.typeID > 0 && isDecryptorType(entry.typeID));
  if (selected.length === 0) {
    return { success: true, typeID: 0 };
  }
  const requiredQuantity = Math.max(1, toInt(runs, 1));
  if (
    selected.length !== 1 ||
    selected[0].quantity !== requiredQuantity
  ) {
    return { success: false, typeID: 0 };
  }
  return { success: true, typeID: selected[0].typeID };
}

// The client always submits the invention decryptor slot, even when nothing is
// selected: industryCommon.GetDecryptors always appends the optional material,
// and Job.dump() keys it by its typeID, which is None when unselected. That
// entry reaches us as typeID 0, and the server-side material map never carries
// it, so the placeholder is dropped from both sides before comparing.
function materialMapsMatchExactly(left, right) {
  const normalize = (source) => Object.fromEntries(
    Object.entries(source && typeof source === "object" ? source : {})
      .filter(([typeID]) => toInt(typeID, 0) > 0)
      .map(([typeID, quantity]) => [String(toInt(typeID, 0)), toInt(quantity, 0)]),
  );
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  const leftKeys = Object.keys(normalizedLeft).sort();
  const rightKeys = Object.keys(normalizedRight).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && normalizedLeft[key] === normalizedRight[key],
    )
  );
}

function getMissingActivitySkills(activity, characterID) {
  const skillLevels = getCharacterSkillLevels(characterID);
  return (Array.isArray(activity && activity.skills) ? activity.skills : [])
    .map((skill) => {
      const typeID = toInt(skill && skill.typeID, 0);
      const requiredLevel = Math.max(0, toInt(skill && skill.level, 0));
      const actualLevel = Math.max(0, toInt(skillLevels.get(typeID), 0));
      return { typeID, requiredLevel, actualLevel };
    })
    .filter(
      (skill) =>
        skill.typeID > 0 && skill.actualLevel < skill.requiredLevel,
    );
}

function buildManufacturingMaterials(definition, runs, materialEfficiency = 0) {
  return buildIndustryActivityMaterials(
    definition,
    INDUSTRY_ACTIVITY.MANUFACTURING,
    runs,
    { materialEfficiency },
  );
}

function buildProductOutput(definition, runs, activityID = INDUSTRY_ACTIVITY.MANUFACTURING) {
  const activity = getIndustryActivity(definition, activityID);
  const products = Array.isArray(activity && activity.products)
    ? activity.products
    : [];
  const normalizedRuns = Math.max(1, toInt(runs, 1));
  return products.map((product) => ({
    typeID: toInt(product && product.typeID, 0),
    quantity: Math.max(1, toInt(product && product.quantity, 1)) * normalizedRuns,
  })).filter((product) => product.typeID > 0 && product.quantity > 0);
}

function getActivityBlueprintTypeID(definition, blueprintTypeID) {
  const numericBlueprintTypeID = toInt(blueprintTypeID, 0);
  if (numericBlueprintTypeID > 0) {
    return numericBlueprintTypeID;
  }
  return toInt(definition && definition.blueprintTypeID, 0);
}

function getActivityResearchCurrentLevel(state, activityID) {
  if (!state) {
    return 0;
  }
  if (toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL) {
    return Math.max(0, toInt(state.materialEfficiency, 0)) / STEP_MATERIAL_EFFICIENCY;
  }
  if (toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_TIME) {
    return Math.max(0, toInt(state.timeEfficiency, 0)) / STEP_TIME_EFFICIENCY;
  }
  return 0;
}

function getActivityResearchMaxLevel(activityID) {
  if (toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL) {
    return MAX_MATERIAL_EFFICIENCY / STEP_MATERIAL_EFFICIENCY;
  }
  if (toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_TIME) {
    return MAX_TIME_EFFICIENCY / STEP_TIME_EFFICIENCY;
  }
  return 0;
}

function getActivityResearchRunsRemaining(state, activityID) {
  const maxLevel = getActivityResearchMaxLevel(activityID);
  const currentLevel = getActivityResearchCurrentLevel(state, activityID);
  return Math.max(0, maxLevel - currentLevel);
}

function resolveResearchActivityTimeSeconds(definition, activityID, runs) {
  const activity = getIndustryActivity(definition, activityID);
  const baseTime = Math.max(0, toInt(activity && activity.time, 0));
  const normalizedRuns = Math.max(1, toInt(runs, 1));
  const currentLevel = Math.max(0, getActivityResearchCurrentLevel({
    materialEfficiency: 0,
    timeEfficiency: 0,
  }, activityID));
  const maxIndex = Math.max(0, RESEARCH_TIME_MULTIPLIERS.length - 1);
  let totalSeconds = 0;
  for (let index = 0; index < normalizedRuns; index += 1) {
    const levelIndex = Math.min(currentLevel + index, maxIndex);
    totalSeconds += baseTime * RESEARCH_TIME_MULTIPLIERS[levelIndex];
  }
  return totalSeconds;
}

// The activity's base cost as a double, before it is rounded. A job's cost is
// multiplied from this (industry/job.py _get_cost_for_modifiers, 310-320); the
// tax and the SCC surcharge are taken of it rounded (job.py base_cost,
// 127-130).
function resolveActivityUnroundedBaseCost(
  definition,
  blueprintTypeID,
  activityID,
  runs,
  licensedRuns,
  state = null,
  productTypeID = 0,
) {
  const numericActivityID = toInt(activityID, 0);
  const numericRuns = Math.max(1, toInt(runs, 1));
  if (
    numericActivityID === INDUSTRY_ACTIVITY.MANUFACTURING ||
    numericActivityID === INDUSTRY_ACTIVITY.REACTION
  ) {
    return resolveIndustryJobBaseCost(
      definition,
      numericActivityID,
      1,
    ) * numericRuns;
  }

  if (
    numericActivityID === INDUSTRY_ACTIVITY.INVENTION &&
    toInt(productTypeID, 0) > 0
  ) {
    return (
      resolveBlueprintActivityPrice(productTypeID, numericActivityID) *
        COST_PERCENTAGE *
        numericRuns
    );
  }

  const blueprintValue = resolveIndustryJobBaseCost(
    {
      blueprintTypeID: getActivityBlueprintTypeID(definition, blueprintTypeID),
      activities: {},
    },
    INDUSTRY_ACTIVITY.MANUFACTURING,
    COST_PERCENTAGE,
  );
  if (!(blueprintValue > 0)) {
    return 0;
  }

  if (
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL ||
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_TIME
  ) {
    const baseResearchTime = Math.max(
      1,
      toInt(getIndustryActivity(definition, numericActivityID)?.time, 0),
    );
    const currentLevel = getActivityResearchCurrentLevel(state, numericActivityID);
    const maxIndex = Math.max(0, RESEARCH_TIME_MULTIPLIERS.length - 1);
    let weightedSeconds = 0;
    for (let index = 0; index < numericRuns; index += 1) {
      const levelIndex = Math.min(currentLevel + index, maxIndex);
      weightedSeconds += baseResearchTime * RESEARCH_TIME_MULTIPLIERS[levelIndex];
    }
    // The client's order (research_time.py and research_material.py, 26):
    // the price's share times the job's time, and that over the activity's
    // time. Divided first, it is another double, and at a great enough price
    // another whole ISK.
    return (blueprintValue * weightedSeconds) / baseResearchTime;
  }

  if (numericActivityID === INDUSTRY_ACTIVITY.COPYING) {
    return (
      blueprintValue *
        Math.max(1, toInt(licensedRuns, 1)) *
        numericRuns
    );
  }

  return (
    resolveIndustryJobBaseCost(definition, numericActivityID, COST_PERCENTAGE) * numericRuns
  );
}

// The installer's clone grade as subscriptionMgr.GetCloneGrade answers it for
// this session. The client has its own from that call
// (omega/client/clone_grade_svc.py, 113-128) and reckons an alpha's job cost
// with it, so the server's reckoning has to start from the same answer.
function resolveInstallerCloneGrade(session) {
  return new SubscriptionMgrService().Handle_GetCloneGrade([], session);
}

function resolveActivitySccSurcharge(cost, activityID, facility) {
  let surchargeRate =
    SCC_SURCHARGE_RATE * Math.max(0, toFloat(facility && facility.sccTaxModifier, 1));
  if (
    toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_TIME ||
    toInt(activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL
  ) {
    surchargeRate *= SCC_SURCHARGE_RESEARCH_DISCOUNT_MODIFIER;
  }
  return Math.round(Math.max(0, toInt(cost, 0)) * surchargeRate);
}

function resolveActivityProductTypeID(
  definition,
  activityID,
  blueprintTypeID,
  requestedProductTypeID = 0,
) {
  const numericActivityID = toInt(activityID, 0);
  if (
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_TIME ||
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL ||
    numericActivityID === INDUSTRY_ACTIVITY.COPYING
  ) {
    return getActivityBlueprintTypeID(definition, blueprintTypeID);
  }
  if (numericActivityID === INDUSTRY_ACTIVITY.INVENTION) {
    return toInt(
      resolveInventionProduct(definition, requestedProductTypeID)?.typeID,
      0,
    );
  }
  const outputProductTypeID = toInt(
    buildProductOutput(definition, 1, numericActivityID)[0]?.typeID,
    0,
  );
  if (outputProductTypeID > 0) {
    return outputProductTypeID;
  }
  return toInt(definition && definition.productTypeID, 0);
}

function buildCopyOutputBlueprintEntries(job, outputLocationID, outputFlagID) {
  const entries = [];
  const quantity = Math.max(1, toInt(job && job.runs, 1));
  const blueprintTypeID = toInt(job && job.blueprintTypeID, 0);
  const licensedRuns = Math.max(1, toInt(job && job.licensedRuns, 1));
  for (let index = 0; index < quantity; index += 1) {
    entries.push({
      itemType: blueprintTypeID,
      quantity: 1,
      options: {
        singleton: 2,
        itemName: null,
      },
      blueprintState: {
        typeID: blueprintTypeID,
        materialEfficiency: 0,
        timeEfficiency: 0,
        original: false,
        runsRemaining: licensedRuns,
        jobID: null,
      },
      outputLocationID,
      outputFlagID,
    });
  }
  return entries;
}

function resolveBaseJobCost(definition) {
  return resolveIndustryJobBaseCost(
    definition,
    INDUSTRY_ACTIVITY.MANUFACTURING,
    COST_PERCENTAGE,
  );
}

function resolveJobTimeSeconds(definition, runs, timeEfficiency, facility, characterID) {
  return resolveIndustryJobTimeSeconds(
    definition,
    INDUSTRY_ACTIVITY.MANUFACTURING,
    runs,
    timeEfficiency,
    facility,
    characterID,
    1,
    toInt(definition && definition.productTypeID, 0),
  );
}

function resolveActivityJobTimeSeconds(
  definition,
  activityID,
  runs,
  state,
  facility,
  characterID,
  licensedRuns = 1,
  productTypeID = 0,
) {
  const numericActivityID = toInt(activityID, 0);
  const currentEfficiency =
    numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL
      ? Math.max(0, toInt(state && state.materialEfficiency, 0))
      : numericActivityID === INDUSTRY_ACTIVITY.RESEARCH_TIME
        ? Math.max(0, toInt(state && state.timeEfficiency, 0))
        : Math.max(0, toInt(state && state.timeEfficiency, 0));
  return resolveIndustryJobTimeSeconds(
    definition,
    numericActivityID,
    runs,
    currentEfficiency,
    facility,
    characterID,
    licensedRuns,
    productTypeID,
  );
}

function resolveFacilityTaxRate(facility, activityID, productTypeID) {
  if (!facility) {
    return DEFAULT_TAX_RATE;
  }
  if (facility.tax !== null && facility.tax !== undefined) {
    return toFloat(facility.tax, DEFAULT_TAX_RATE);
  }

  const serviceID = resolveIndustryStructureServiceID(activityID, productTypeID);
  if (!serviceID) {
    return DEFAULT_TAX_RATE;
  }
  const serviceAccess =
    facility.serviceAccess && typeof facility.serviceAccess === "object"
      ? facility.serviceAccess
      : {};
  if (!Object.prototype.hasOwnProperty.call(serviceAccess, String(serviceID))) {
    return DEFAULT_TAX_RATE;
  }
  return toFloat(serviceAccess[String(serviceID)], DEFAULT_TAX_RATE);
}

function structureFacilityHasRequiredServiceAccess(facility, activityID, productTypeID) {
  if (!facility || facility.tax !== null) {
    return true;
  }
  const facilityID = toInt(facility.facilityID, 0);
  if (!structureState.getStructureByID(facilityID, { refresh: false })) {
    return true;
  }

  const serviceID = resolveIndustryStructureServiceID(activityID, productTypeID);
  if (!serviceID) {
    return true;
  }
  const serviceAccess =
    facility.serviceAccess && typeof facility.serviceAccess === "object"
      ? facility.serviceAccess
      : {};
  return Object.prototype.hasOwnProperty.call(serviceAccess, String(serviceID));
}

function normalizeIndustryAccount(ownerID, requestAccount, session = null) {
  if (Array.isArray(requestAccount) && requestAccount.length >= 2) {
    return [toInt(requestAccount[0], 0), toInt(requestAccount[1], 0)];
  }
  // Native job dumps always carry an account tuple. Keep null compatible with
  // older internal and web callers by retaining the prior custody-owner default.
  if (requestAccount == null) {
    if (session && isCorporationOwner(session, ownerID)) {
      return [
        toInt(ownerID, 0),
        normalizeCorporationWalletKey(session.corpAccountKey || DEFAULT_ACCOUNT_KEY),
      ];
    }
    return [toInt(ownerID, 0), DEFAULT_ACCOUNT_KEY];
  }
  return null;
}

function normalizeLocationForFacility(
  facility,
  ownerID,
  requestLocation,
  blueprint,
  session = null,
  options = {},
) {
  const requireTake = options && options.requireTake === true;
  const preferDeliveries = options && options.preferDeliveries === true;
  const requireExactRequest = options && options.requireExactRequest === true;
  const canonicalizeOwnerForExactLocation =
    options && options.canonicalizeOwnerForExactLocation === true;
  const locations = resolveFacilityLocations(facility.facilityID, ownerID, blueprint, session);
  if (requestLocation) {
    const requestedItemID = toInt(requestLocation.itemID, 0);
    const requestedFlagID = toInt(requestLocation.flagID, 0);
    const requestedOwnerID = toInt(requestLocation.ownerID || ownerID, 0);
    const match = locations.find((entry) => (
      toInt(entry.itemID, 0) === requestedItemID &&
      toInt(entry.flagID, 0) === requestedFlagID &&
      toInt(entry.ownerID, 0) === requestedOwnerID
    ));
    if (match) {
      return match;
    }
    // Retail can describe the exact authorized structure hangar using the
    // structure owner even though the inventory location belongs to the job
    // formula owner. Canonicalize only against the facility-authorized list.
    if (canonicalizeOwnerForExactLocation) {
      const canonicalOwnerMatch = locations.find((entry) => (
        toInt(entry.itemID, 0) === requestedItemID &&
        toInt(entry.flagID, 0) === requestedFlagID &&
        toInt(entry.ownerID, 0) === toInt(ownerID, 0)
      ));
      if (canonicalOwnerMatch) {
        return canonicalOwnerMatch;
      }
    }
    if (requireExactRequest) {
      return null;
    }
  }
  if (preferDeliveries) {
    const deliveries = locations.find((entry) => (
      toInt(entry.flagID, 0) === ITEM_FLAG_CORP_DELIVERIES &&
      (!requireTake || entry.canTake !== false)
    ));
    if (deliveries) {
      return deliveries;
    }
  }
  if (session && isCorporationOwner(session, ownerID) && requireTake) {
    const firstHangarFlag = getAccessibleCorpHangarFlags(session, facility.facilityID, {
      takeRequired: true,
    })[0];
    if (firstHangarFlag) {
      return locations.find((entry) => toInt(entry.flagID, 0) === firstHangarFlag) || null;
    }
  }
  if (session && isCorporationOwner(session, ownerID) && !requireTake) {
    const deliveries = locations.find((entry) => toInt(entry.flagID, 0) === ITEM_FLAG_CORP_DELIVERIES);
    if (deliveries) {
      return deliveries;
    }
  }
  return locations[0] || null;
}

const crewIndustryActors = new WeakMap();
const crewIndustrySkills = new WeakMap();
const crewIndustryEquipment = new WeakMap();
function createCrewIndustryActor(characterID, stationID) {
  const character = require("../character/characterState").getCharacterRecord(characterID);
  const station = worldData.getStationByID(stationID);
  if (!character || !station) throw new Error("CREW_INDUSTRY_ACTOR_INVALID");
  const actor = { characterID, characterName: character.characterName, corporationID: character.corporationID };
  const record = require("../../gameStore").read("manufacturingCrewRuntime", `/${characterID}`);
  if (!record.success && !["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(record.errorMsg)) throw new Error("CREW_PROGRESSION_UNAVAILABLE");
  const skill = require("../crew/crewProgression").profile(record.success ? record.data : null, "manufacturing");
  crewIndustryActors.set(actor, stationID);
  crewIndustrySkills.set(actor, Object.freeze(skill));
  crewIndustryEquipment.set(actor, Object.freeze(require("../crew/crewEquipmentState").forOwner(characterID, "manufacturing")));
  return actor;
}

function quoteIndustryJob(session, requestInput) {
  const request =
    requestInput && requestInput.rawRequest
      ? requestInput
      : parseIndustryRequest(requestInput);
  const errors = [];
  const activityID = toInt(request.activityID, 0);

  if (![
    INDUSTRY_ACTIVITY.MANUFACTURING,
    INDUSTRY_ACTIVITY.RESEARCH_TIME,
    INDUSTRY_ACTIVITY.RESEARCH_MATERIAL,
    INDUSTRY_ACTIVITY.COPYING,
    INDUSTRY_ACTIVITY.INVENTION,
    INDUSTRY_ACTIVITY.REACTION,
  ].includes(activityID)) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_ACTIVITY));
  }

  const blueprint = getBlueprintByItemID(request.blueprintID);
  const definition = getBlueprintDefinitionByTypeID(blueprint && blueprint.typeID);
  const activity = getIndustryActivity(definition, activityID);
  const facility = getFacilityPayloadByID(request.facilityID, session);
  if (!blueprint) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISSING_BLUEPRINT));
  }
  if (!definition) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_PRODUCT));
  } else if (!activity) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INCOMPATIBLE_ACTIVITY));
  }
  if (!facility) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISSING_FACILITY));
  } else if (!facility.online) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.FACILITY_OFFLINE));
  } else if (!facility.activities || !facility.activities[activityID]) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.FACILITY_ACTIVITY));
  }
  if (blueprint) {
    const blueprintFacilityID = toInt(blueprint.facilityID, 0);
    if (blueprintFacilityID <= 0) {
      errors.push(buildIndustryValidationError(
        INDUSTRY_ERROR.INVALID_BLUEPRINT_LOCATION,
        toInt(blueprint.locationID, 0),
      ));
    } else if (facility && blueprintFacilityID !== toInt(facility.facilityID, 0)) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.BLUEPRINT_WRONG_FACILITY));
    }
  }
  if (errors.length > 0) {
    return { success: false, errors };
  }

  const ownerID = toInt(blueprint.ownerID, 0);
  const blueprintItem = findItemById(blueprint.itemID);
  if (
    !canViewBlueprintInstance(session, blueprintItem) ||
    isLockedIndustryContainerEntry(blueprintItem)
  ) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.BLUEPRINT_ACCESS));
  }
  if (!isCharacterOwner(session, ownerID)) {
    if (!isCorporationOwner(session, ownerID)) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_OWNER));
    } else {
      for (const missingRole of getMissingCorporationIndustryRoles(
        session,
        ownerID,
        facility.facilityID,
        activityID,
      )) {
        errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISSING_ROLE, missingRole));
      }
    }
  }

  const state = getBlueprintState(blueprint.itemID);
  if (state && state.jobID) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.BLUEPRINT_INSTALLED));
  }
  if (
    state &&
    activityID !== INDUSTRY_ACTIVITY.MANUFACTURING &&
    activityID !== INDUSTRY_ACTIVITY.INVENTION &&
    state.original !== true
  ) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INCOMPATIBLE_ACTIVITY));
  }
  if (
    state &&
    activityID === INDUSTRY_ACTIVITY.INVENTION &&
    state.original !== false
  ) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INCOMPATIBLE_ACTIVITY));
  }

  const runs = Math.max(0, toInt(request.runs, 0));
  const licensedRuns = Math.max(1, toInt(request.licensedRuns, 1) || 1);
  const activityProductTypeID = resolveActivityProductTypeID(
    definition,
    activityID,
    blueprint.typeID,
    request.productTypeID,
  );
  if (
    activityID === INDUSTRY_ACTIVITY.INVENTION &&
    activityProductTypeID <= 0
  ) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_PRODUCT));
  }
  if (!structureFacilityHasRequiredServiceAccess(facility, activityID, activityProductTypeID)) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.FACILITY_DENIED));
  }
  if (activityID === INDUSTRY_ACTIVITY.MANUFACTURING) {
    if (runs <= 0 || runs > MAX_MANUFACTURING_RUNS) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_RUNS, state ? state.runsRemaining : 0));
    }
    if (state && !state.original && runs > Math.max(0, toInt(state.runsRemaining, 0))) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_RUNS, toInt(state.runsRemaining, 0)));
    }
  } else if (activityID === INDUSTRY_ACTIVITY.COPYING) {
    if (runs <= 0 || runs > MAX_COPY_RUNS) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_RUNS, MAX_COPY_RUNS));
    }
    if (
      licensedRuns <= 0 ||
      licensedRuns > Math.max(1, toInt(definition && definition.maxProductionLimit, 1))
    ) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_LICENSED_RUNS, licensedRuns));
    }
  } else if (activityID === INDUSTRY_ACTIVITY.REACTION) {
    if (runs <= 0 || runs > MAX_MANUFACTURING_RUNS) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_RUNS, MAX_MANUFACTURING_RUNS));
    }
  } else if (activityID === INDUSTRY_ACTIVITY.INVENTION) {
    const perRunTime = resolveActivityJobTimeSeconds(
      definition,
      activityID,
      1,
      state,
      facility,
      session && (session.characterID || session.charid),
      licensedRuns,
      activityProductTypeID,
    );
    const timeDerivedMaxRuns = Math.max(
      1,
      Math.ceil(MAX_JOB_LENGTH_SECONDS / Math.max(1, perRunTime)),
    );
    const maximumRuns = Math.min(
      MAX_INVENTION_RUNS,
      Math.max(0, toInt(state && state.runsRemaining, 0)),
      timeDerivedMaxRuns,
    );
    if (runs <= 0 || runs > maximumRuns) {
      errors.push(
        buildIndustryValidationError(INDUSTRY_ERROR.INVALID_RUNS, maximumRuns),
      );
    }
  } else {
    const remainingResearchRuns = getActivityResearchRunsRemaining(state, activityID);
    if (remainingResearchRuns <= 0) {
      errors.push(buildIndustryValidationError(
        INDUSTRY_ERROR.RESEARCH_LIMIT,
        getActivityResearchCurrentLevel(state, activityID),
        getActivityResearchMaxLevel(activityID),
      ));
    } else if (runs <= 0 || runs > remainingResearchRuns) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INVALID_RUNS, remainingResearchRuns));
    }
  }

  const installerID = toInt(session && (session.characterID || session.charid), 0);
  // This capability is created only for a server-owned crew at its NPC station.
  // All blueprint, skill, slot, material, fee and facility rules still apply.
  const distanceRestriction = crewIndustryActors.get(session) === facility.facilityID ? null : resolveIndustryFacilityDistanceRestriction(
    session,
    facility,
    activityID,
    installerID,
  );
  if (distanceRestriction) {
    errors.push(
      buildIndustryValidationError(
        distanceRestriction.code,
        ...distanceRestriction.args,
      ),
    );
  }
  const slotContext = resolveIndustrySlotContext(
    activityID,
    installerID,
    getJobCountsByInstaller(installerID),
  );
  if (slotContext.full) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.SLOTS_FULL));
  }

  for (const missingSkill of getMissingActivitySkills(activity, installerID)) {
    errors.push(
      buildIndustryValidationError(
        INDUSTRY_ERROR.MISSING_SKILL,
        missingSkill.typeID,
        missingSkill.requiredLevel,
        missingSkill.actualLevel,
      ),
    );
  }

  const standingRestriction = resolveIndustryStandingRestriction(
    session,
    ownerID,
    facility,
    activityID,
  );
  if (standingRestriction) {
    errors.push(
      buildIndustryValidationError(
        INDUSTRY_ERROR.STANDINGS_RESTRICTION,
        standingRestriction,
      ),
    );
  }

  const facilityRestriction = resolveIndustryFacilityRestriction(
    activityID,
    activityID === INDUSTRY_ACTIVITY.MANUFACTURING ||
      activityID === INDUSTRY_ACTIVITY.REACTION
      ? activityProductTypeID
      : 0,
    facility,
    toInt(blueprint && blueprint.typeID, 0),
  );
  if (facilityRestriction) {
    errors.push(
      buildIndustryValidationError(
        facilityRestriction.code,
        ...(Array.isArray(facilityRestriction.args) ? facilityRestriction.args : []),
      ),
    );
  }

  const inputLocation = normalizeLocationForFacility(
    facility,
    ownerID,
    request.inputLocation,
    blueprint,
    session,
    {
      requireTake: true,
      requireExactRequest: true,
      canonicalizeOwnerForExactLocation: true,
    },
  );
  const outputLocation = normalizeLocationForFacility(
    facility,
    ownerID,
    request.outputLocation,
    blueprint,
    session,
    {
      preferDeliveries: true,
      requireExactRequest: true,
      canonicalizeOwnerForExactLocation: true,
    },
  );
  if (!inputLocation) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISSING_INPUT_LOCATION));
  } else if (
    inputLocation.canTake === false ||
    // Deliveries is an output-only hangar; never draw job materials from it.
    toInt(inputLocation.flagID, 0) === ITEM_FLAG_CORP_DELIVERIES
  ) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.INPUT_ACCESS));
  }
  if (!outputLocation) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISSING_OUTPUT_LOCATION));
  } else {
    const outputCapacity = resolveIndustryOutputCapacity(
      ownerID,
      outputLocation,
      buildIndustryOutputManifest(
        definition,
        activityID,
        runs,
        blueprint.typeID,
        activityProductTypeID,
      ),
    );
    if (outputCapacity.overflow) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.OUTPUT_OVERFLOW));
    }
  }

  const requestMaterials =
    request.materials && typeof request.materials === "object"
      ? request.materials
      : {};
  const decryptorSelection =
    activityID === INDUSTRY_ACTIVITY.INVENTION
      ? resolveInventionDecryptorSelection(requestMaterials, runs)
      : { success: true, typeID: 0 };
  if (!decryptorSelection.success) {
    errors.push(
      buildIndustryValidationError(
        INDUSTRY_ERROR.MISMATCH_MATERIAL,
        requestMaterials,
        {},
      ),
    );
  }
  const materials = buildIndustryActivityMaterials(
    definition,
    activityID,
    runs,
    activityID === INDUSTRY_ACTIVITY.MANUFACTURING
      ? {
          materialEfficiency: state && state.materialEfficiency,
          facility,
          productTypeID: activityProductTypeID,
        }
      : {
          // A copy job's materials are by its licensed runs too.
          licensedRuns,
          facility,
          productTypeID: activityProductTypeID,
        },
  );
  if (decryptorSelection.typeID > 0) {
    materials.push({
      typeID: decryptorSelection.typeID,
      quantity: runs,
    });
  }
  const materialMap = Object.fromEntries(materials.map((material) => [String(material.typeID), material.quantity]));
  const availableMaterials = resolveAvailableMaterials(ownerID, inputLocation);
  for (const material of materials) {
    const available = toInt(availableMaterials[material.typeID], 0);
    if (available < material.quantity) {
      errors.push(buildIndustryValidationError(
        INDUSTRY_ERROR.MISSING_MATERIAL,
        material.typeID,
        material.quantity,
        available,
        material.quantity - available,
      ));
    }
  }

  const unroundedBaseCost = resolveActivityUnroundedBaseCost(
    definition,
    blueprint.typeID,
    activityID,
    runs,
    licensedRuns,
    state,
    activityProductTypeID,
  );
  const baseCost = Math.round(unroundedBaseCost);
  // The facility payload carries the system cost index as a SYSTEM-reference
  // cost modifier, so resolveIndustryJobCost already multiplies it into the
  // gross cost the same way the client multiplies base cost by every cost
  // modifier. systemCostIndex is resolved here only for the quote breakdown.
  const systemCostIndex = resolveSystemCostIndex(
    facility && facility.solarSystemID,
    activityID,
  );
  // The cost is the client's own, from the base before it is rounded and with
  // the installer's clone grade; the tax, the SCC surcharge and the industry
  // security tax are taken of the rounded base, as the client takes them
  // (industry/job.py _get_tax, 450-458; the SCC surcharge, 137-153; the
  // security tax, 164-172), and the total is the four added (133).
  const cost = resolveIndustryJobCost(
    unroundedBaseCost,
    blueprint.typeID,
    activityID,
    facility,
    activityProductTypeID,
    resolveInstallerCloneGrade(session),
  );
  const tax = Math.round(
    baseCost * resolveFacilityTaxRate(
      facility,
      activityID,
      activityProductTypeID,
    ),
  );
  const sccSurcharge = resolveActivitySccSurcharge(baseCost, activityID, facility);
  const industrySecurityTax = resolveIndustrySecurityTax(baseCost, facility);
  const totalCost = cost + tax + sccSurcharge + industrySecurityTax;
  const baseTimeInSeconds = resolveActivityJobTimeSeconds(
    definition,
    activityID,
    runs,
    state,
    facility,
    session && (session.characterID || session.charid),
    licensedRuns,
    activityProductTypeID,
  );
  // Only server-created crew actors carry this private capability. A retail
  // session or request payload cannot supply its own crew level or multiplier.
  const crewSkill = activityID === INDUSTRY_ACTIVITY.MANUFACTURING ? crewIndustrySkills.get(session) : null;
  const crewEquipment = crewIndustryEquipment.get(session);
  const skilledTime = crewSkill ? Math.max(1, Math.ceil(baseTimeInSeconds * crewSkill.durationBasisPoints / 10000)) : baseTimeInSeconds;
  const timeInSeconds = crewEquipment ? require("../crew/crewEquipmentState").duration(skilledTime, crewEquipment) : skilledTime;
  const previousRunLengthSeconds =
    runs > 0 ? timeInSeconds - timeInSeconds / Math.max(1, toInt(runs, 1)) : timeInSeconds;
  if (previousRunLengthSeconds > MAX_JOB_LENGTH_SECONDS) {
    errors.push(
      buildIndustryValidationError(
        INDUSTRY_ERROR.RUN_LENGTH,
        previousRunLengthSeconds,
        MAX_JOB_LENGTH_SECONDS,
      ),
    );
  }

  const account = normalizeIndustryAccount(ownerID, request.account, session);
  const payerOwnerID = toInt(account && account[0], 0);
  const payerAccountKey = toInt(account && account[1], 0);
  let payerKind = null;
  if (!account) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.ACCOUNT_INVALID));
  } else if (
    isCharacterOwner(session, payerOwnerID) &&
    payerAccountKey === DEFAULT_ACCOUNT_KEY
  ) {
    payerKind = "character";
  } else if (isCorporationOwner(session, payerOwnerID)) {
    if (canUseCorporationWallet(session, payerOwnerID, payerAccountKey)) {
      payerKind = "corporation";
    } else {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.ACCOUNT_ACCESS));
    }
  } else {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.ACCOUNT_INVALID));
  }
  if (payerKind) {
    const balance =
      payerKind === "character"
        ? toFloat(getCharacterWallet(payerOwnerID)?.balance, 0)
        : toFloat(
            getCorporationWalletBalance(
              payerOwnerID,
              normalizeCorporationWalletKey(payerAccountKey),
            ),
            0,
          );
    if (balance < totalCost) {
      errors.push(buildIndustryValidationError(INDUSTRY_ERROR.ACCOUNT_FUNDS, balance, totalCost));
    }
  }

  // Job._get_errors guards the comparison with `if self.request['materials']`,
  // so an empty map means "recompute from the blueprint" rather than "match
  // nothing" — for invention the same as for every other activity.
  if (
    activityID === INDUSTRY_ACTIVITY.INVENTION &&
    Object.keys(requestMaterials).length > 0 &&
    !materialMapsMatchExactly(requestMaterials, materialMap)
  ) {
    errors.push(
      buildIndustryValidationError(
        INDUSTRY_ERROR.MISMATCH_MATERIAL,
        requestMaterials,
        materialMap,
      ),
    );
  } else if (
    activityID !== INDUSTRY_ACTIVITY.INVENTION &&
    Object.keys(requestMaterials).length > 0
  ) {
    for (const material of materials) {
      if (toInt(requestMaterials[material.typeID], 0) !== material.quantity) {
        errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISMATCH_MATERIAL, requestMaterials, materialMap));
        break;
      }
    }
  }
  if (request.cost && Math.round(request.cost) !== cost) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISMATCH_COST, request.cost, cost));
  }
  if (request.tax && Math.round(request.tax) !== tax) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISMATCH_TAX, request.tax, tax));
  }
  if (request.time && Math.round(request.time) !== timeInSeconds) {
    errors.push(buildIndustryValidationError(INDUSTRY_ERROR.MISMATCH_TIME, request.time, timeInSeconds));
  }

  return {
    success: errors.length === 0,
    errors,
    quote: {
      activityID,
      ownerID,
      account,
      payerOwnerID,
      payerKind,
      blueprint,
      definition,
      facility,
      inputLocation,
      outputLocation,
      materials,
      materialMap,
      availableMaterials,
      runs,
      slotUsage: slotContext.used,
      slotLimit: slotContext.limit,
      baseCost,
      systemCostIndex,
      cost,
      tax,
      sccSurcharge,
      industrySecurityTax,
      totalCost,
      timeInSeconds,
      ...(crewSkill ? { crewSkill, crewEquipment, baseTimeInSeconds } : {}),
      productTypeID: activityProductTypeID,
      licensedRuns,
      state,
      probability:
        activityID === INDUSTRY_ACTIVITY.INVENTION
          ? computeInventionProbability(
              definition,
              installerID,
              decryptorSelection.typeID,
            )
          : 1,
      optionalTypeID:
        activityID === INDUSTRY_ACTIVITY.INVENTION && decryptorSelection.typeID > 0
          ? decryptorSelection.typeID
          : null,
    },
  };
}

function quoteManufacturingJob(session, requestInput) {
  return quoteIndustryJob(session, requestInput);
}

// Syncs ONE session. The corporation office fan-out is deliberately not folded
// in here: publishPreparedIndustryInstall calls this once per interested
// session, and a fan-out inside the loop would send every observer the same
// row twice. Callers publish to the other members with an explicit
// fanCorporationOfficeInventoryChanges once per settlement.
function syncInventoryChanges(session, changes = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change) {
      continue;
    }
    // TQ's OnItemsChanged: the client's invCache turns it into OnItemChange per item plus
    // OnMultipleItemChange, which recounts item goals (career Industry part 3: the built
    // afterburner).
    if (change.item) {
      syncInventoryItemForSession(
        session,
        change.item,
        change.previousState || change.previousData || {},
        { emitItemsChangedBatch: true },
      );
      continue;
    }
    if (change.removed === true && change.previousData) {
      const removedState = {
        ...change.previousData,
        locationID: 6,
      };
      syncInventoryItemForSession(session, removedState, change.previousData, { emitItemsChangedBatch: true });
    }
  }
}

function flushIndustryTableSync(tableName, errorMsg) {
  const flushResult = database.flushTableSync(tableName);
  return flushResult && flushResult.success === true
    ? { success: true }
    : {
        success: false,
        ambiguous: true,
        errorMsg: errorMsg || "INDUSTRY_FLUSH_FAILED",
      };
}

function getIndustryBlueprintCustodyKey(job, intent, action) {
  const receiptID = String(job && job.deliveryReceiptID || "").trim() || [
    toInt(job && job.jobID, 0),
    toInt(job && job.blueprintID, 0),
  ].join(":");
  return [
    "evejsIndustryBlueprint",
    receiptID,
    intent,
    action,
    "v1",
  ].join(":");
}

function getVerifiedIndustryBlueprintCustodyReceipt(job, intent, action) {
  const receiptResult = getItemCustodyCommittedReceipt(
    getIndustryBlueprintCustodyKey(job, intent, action),
  );
  const receipt = receiptResult && receiptResult.committed
    ? receiptResult.receipt
    : null;
  const fingerprint = receipt && receipt.fingerprint;
  const source = fingerprint && fingerprint.source;
  const destination = fingerprint && fingerprint.destination;
  const itemSpec = fingerprint && fingerprint.itemSpec;
  const blueprintID = toInt(job && job.blueprintID, 0);
  const ownerID = toInt(job && job.ownerID, 0);
  const actorID = toInt(job && (job.installerID || job.completedCharacterID), 0);
  const expectedReason = action === "consume"
    ? CUSTODY_REASON.INDUSTRY_BLUEPRINT_CONSUME
    : CUSTODY_REASON.INDUSTRY_BLUEPRINT_RETURN;
  if (
    !receipt ||
    !fingerprint ||
    blueprintID <= 0 ||
    ownerID <= 0 ||
    actorID <= 0 ||
    String(fingerprint.route || "") !== (
      action === "consume" ? "local-remove" : "local-move"
    ) ||
    String(fingerprint.reason || "") !== expectedReason ||
    toInt(fingerprint.actor, 0) !== actorID ||
    String(source && source.kind || "") !== CUSTODY_REF_KIND.OWNER_LOCATION ||
    toInt(source && source.ownerID, 0) !== ownerID ||
    toInt(source && source.locationID, 0) !== INDUSTRY_INSTALLED_LOCATION_ID ||
    toInt(source && source.flagID, -1) < 0 ||
    toInt(itemSpec && itemSpec.itemID, 0) !== blueprintID ||
    toInt(itemSpec && itemSpec.quantity, 0) !== 1
  ) {
    return null;
  }
  if (action === "consume") {
    return String(destination && destination.kind || "") === CUSTODY_REF_KIND.VOID
      ? receipt
      : null;
  }
  const expectedLocationID = toInt(
    job && (job.blueprintInventoryLocationID || job.blueprintLocationID),
    0,
  );
  const expectedFlagID = getIndustryJobBlueprintInventoryFlagID(job);
  return (
    expectedLocationID > 0 &&
    expectedLocationID !== INDUSTRY_INSTALLED_LOCATION_ID &&
    expectedFlagID >= 0 &&
    String(destination && destination.kind || "") ===
      CUSTODY_REF_KIND.OWNER_LOCATION &&
    toInt(destination && destination.ownerID, 0) === ownerID &&
    toInt(destination && destination.locationID, 0) === expectedLocationID &&
    toInt(destination && destination.flagID, -1) === expectedFlagID
  )
    ? receipt
    : null;
}

function buildIndustryBlueprintSettlementError(errorMsg) {
  return {
    success: false,
    ambiguous: true,
    errorMsg,
  };
}

function validateIndustryBlueprintSettlementState(job, state, item, intent) {
  const jobID = toInt(job && job.jobID, 0);
  const blueprintID = toInt(job && job.blueprintID, 0);
  const blueprintTypeID = toInt(job && job.blueprintTypeID, 0);
  if (
    !state ||
    typeof state !== "object" ||
    jobID <= 0 ||
    blueprintID <= 0 ||
    blueprintTypeID <= 0 ||
    toInt(state.itemID, 0) !== blueprintID ||
    toInt(state.typeID, 0) !== blueprintTypeID ||
    (state.original !== true && state.original !== false) ||
    (job.blueprintCopy !== true && job.blueprintCopy !== false) ||
    job.blueprintCopy === state.original
  ) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_INVALID",
    );
  }

  if (state.original === false) {
    const rawRuns = Number(state.runsRemaining);
    if (!Number.isSafeInteger(rawRuns) || rawRuns < 0) {
      return buildIndustryBlueprintSettlementError(
        "INDUSTRY_BLUEPRINT_SETTLEMENT_RUNS_INVALID",
      );
    }
  }
  if (intent === "delivery") {
    const rawJobRuns = Number(job.runs);
    if (!Number.isSafeInteger(rawJobRuns) || rawJobRuns <= 0) {
      return buildIndustryBlueprintSettlementError(
        "INDUSTRY_BLUEPRINT_SETTLEMENT_RUNS_INVALID",
      );
    }
  }

  const activityID = toInt(job && job.activityID, 0);
  if (activityID === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL) {
    const materialEfficiency = Number(state.materialEfficiency);
    if (
      !Number.isSafeInteger(materialEfficiency) ||
      materialEfficiency < 0 ||
      materialEfficiency > MAX_MATERIAL_EFFICIENCY
    ) {
      return buildIndustryBlueprintSettlementError(
        "INDUSTRY_BLUEPRINT_SETTLEMENT_EFFICIENCY_INVALID",
      );
    }
  }
  if (activityID === INDUSTRY_ACTIVITY.RESEARCH_TIME) {
    const timeEfficiency = Number(state.timeEfficiency);
    if (
      !Number.isSafeInteger(timeEfficiency) ||
      timeEfficiency < 0 ||
      timeEfficiency > MAX_TIME_EFFICIENCY
    ) {
      return buildIndustryBlueprintSettlementError(
        "INDUSTRY_BLUEPRINT_SETTLEMENT_EFFICIENCY_INVALID",
      );
    }
  }

  if (
    item &&
    (
      toInt(item.itemID, 0) !== blueprintID ||
      toInt(item.typeID, 0) !== blueprintTypeID ||
      toInt(item.ownerID, 0) !== toInt(job && job.ownerID, 0) ||
      toInt(item.categoryID, 0) !== BLUEPRINT_CATEGORY_ID ||
      toInt(item.singleton, 0) !== (state.original === true ? 1 : 2)
    )
  ) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
    );
  }

  const stateJobID = toInt(state.jobID, 0);
  const completedForJob = toInt(state.lastCompletedJobID, 0) === jobID;
  const cancelledForJob = toInt(state.lastCancelledJobID, 0) === jobID;
  if (
    (stateJobID === jobID && (completedForJob || cancelledForJob)) ||
    (completedForJob && cancelledForJob) ||
    (intent === "delivery" && cancelledForJob) ||
    (intent === "cancellation" && completedForJob)
  ) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_CONFLICT",
    );
  }
  return { success: true };
}

function getIndustryBlueprintDeliveryPlan(job, state, item) {
  const validation = validateIndustryBlueprintSettlementState(
    job,
    state,
    item,
    "delivery",
  );
  if (!validation.success) {
    return validation;
  }
  const jobID = toInt(job && job.jobID, 0);
  const alreadyApplied = Boolean(
    toInt(state.lastCompletedJobID, 0) === jobID &&
    toInt(state.jobID, 0) === 0
  );
  const remainingRuns = state.original === true
    ? -1
    : alreadyApplied
      ? Number(state.runsRemaining)
      : Math.max(
          0,
          Number(state.runsRemaining) - Math.max(0, toInt(job && job.runs, 0)),
        );
  return {
    success: true,
    alreadyApplied,
    remainingRuns,
    action: state.original === false && remainingRuns <= 0
      ? "consume"
      : "return",
  };
}

function isValidIndustryBlueprintDestinationLocation(ownerID, locationID) {
  const numericOwnerID = toInt(ownerID, 0);
  const numericLocationID = toInt(locationID, 0);
  if (
    worldData.getStationByID(numericLocationID) ||
    structureState.getStructureByID(numericLocationID, { refresh: false }) ||
    getCorporationOfficeByInventoryID(numericOwnerID, numericLocationID)
  ) {
    return true;
  }
  const container = findItemById(numericLocationID);
  return Boolean(
    container &&
    toInt(container.ownerID, 0) === numericOwnerID &&
    (isIndustryContainerItem(container) || starbaseIndustry.isAssemblyArray(container))
  );
}

function resolveIndustryBlueprintDestination(job, item) {
  const locationID = toInt(
    job && (job.blueprintInventoryLocationID || job.blueprintLocationID),
    0,
  );
  const flagID = getIndustryJobBlueprintInventoryFlagID(job);
  if (
    locationID <= 0 ||
    locationID === INDUSTRY_INSTALLED_LOCATION_ID ||
    flagID < 0 ||
    !item ||
    toInt(item.ownerID, 0) !== toInt(job && job.ownerID, 0) ||
    toInt(item.typeID, 0) !== toInt(job && job.blueprintTypeID, 0) ||
    !isValidIndustryBlueprintDestinationLocation(job && job.ownerID, locationID)
  ) {
    return null;
  }
  return { locationID, flagID };
}

function settleIndustryBlueprintCustody(job, action, session, options = {}) {
  const blueprintID = toInt(job && job.blueprintID, 0);
  const ownerID = toInt(job && job.ownerID, 0);
  const actorID = toInt(
    job && (job.installerID || job.completedCharacterID),
    0,
  );
  const itemBefore = findItemById(blueprintID);
  const expectedSingleton = job && job.blueprintCopy === true
    ? 2
    : job && job.blueprintCopy === false
      ? 1
      : 0;
  if (
    blueprintID <= 0 ||
    ownerID <= 0 ||
    actorID <= 0 ||
    expectedSingleton <= 0 ||
    (action !== "return" && action !== "consume") ||
    toInt(job && job.installedLocationID, 0) !== INDUSTRY_INSTALLED_LOCATION_ID ||
    (
      itemBefore &&
      (
        toInt(itemBefore.itemID, 0) !== blueprintID ||
        toInt(itemBefore.categoryID, 0) !== BLUEPRINT_CATEGORY_ID ||
        toInt(itemBefore.ownerID, 0) !== ownerID ||
        toInt(itemBefore.typeID, 0) !== toInt(job && job.blueprintTypeID, 0) ||
        toInt(itemBefore.singleton, 0) !== expectedSingleton
      )
    )
  ) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
    };
  }

  const verifiedReceipt = getVerifiedIndustryBlueprintCustodyReceipt(
    job,
    String(options.intent || "delivery"),
    action,
  );
  const atInstalledLocation = Boolean(
    itemBefore &&
    toInt(itemBefore.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID
  );
  const validMovedReturn = Boolean(
    action === "return" &&
    hasValidSettledIndustryBlueprintLocation(itemBefore)
  );
  if (
    validMovedReturn &&
    !verifiedReceipt &&
    options.allowSettledMovedItem === true
  ) {
    return { success: true, durable: true, duplicate: true, data: { changes: [] } };
  }
  if (
    action === "consume" &&
    !itemBefore &&
    !verifiedReceipt &&
    options.allowExistingPostcondition === true
  ) {
    return { success: true, durable: true, duplicate: true, data: { changes: [] } };
  }

  const destination = action === "return"
    ? verifiedReceipt
      ? {
          locationID: toInt(
            verifiedReceipt.fingerprint &&
              verifiedReceipt.fingerprint.destination &&
              verifiedReceipt.fingerprint.destination.locationID,
            0,
          ),
          flagID: toInt(
            verifiedReceipt.fingerprint &&
              verifiedReceipt.fingerprint.destination &&
              verifiedReceipt.fingerprint.destination.flagID,
            -1,
          ),
        }
      : resolveIndustryBlueprintDestination(job, itemBefore)
    : null;
  if (action === "return" && !destination) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "INDUSTRY_BLUEPRINT_SETTLEMENT_DESTINATION_INVALID",
    };
  }
  const atDestination = Boolean(
    itemBefore &&
    destination &&
    toInt(itemBefore.locationID, 0) === destination.locationID &&
    toInt(itemBefore.flagID, -1) === destination.flagID,
  );
  if (
    options.allowExistingPostcondition === true &&
    (
      action === "return" && atDestination
    )
  ) {
    return { success: true, durable: true, duplicate: true, data: { changes: [] } };
  }
  if (!verifiedReceipt && !atInstalledLocation) {
    return buildIndustryBlueprintSettlementError(
      itemBefore
        ? "INDUSTRY_BLUEPRINT_SETTLEMENT_ITEM_MOVED"
        : "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
    );
  }
  const sourceFlagID = verifiedReceipt
    ? toInt(
        verifiedReceipt.fingerprint &&
          verifiedReceipt.fingerprint.source &&
          verifiedReceipt.fingerprint.source.flagID,
        -1,
      )
    : toInt(itemBefore && itemBefore.flagID, -1);
  if (sourceFlagID < 0) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
    );
  }

  const command = {
    actorID,
    ownerID,
    itemID: blueprintID,
    quantity: 1,
    sourceLocationID: INDUSTRY_INSTALLED_LOCATION_ID,
    sourceFlagID,
    destinationLocationID: destination && destination.locationID,
    destinationFlagID: destination && destination.flagID,
    idempotencyKey: getIndustryBlueprintCustodyKey(
      job,
      String(options.intent || "delivery"),
      action,
    ),
  };
  const result = action === "consume"
    ? industryInstallItemCustody.consumeBlueprint(command)
    : industryInstallItemCustody.returnBlueprint(command);
  if (!result || result.success !== true) {
    return result || {
      success: false,
      ambiguous: true,
      errorMsg: "INDUSTRY_BLUEPRINT_SETTLEMENT_CUSTODY_FAILED",
    };
  }

  const itemAfter = findItemById(blueprintID);
  const postconditionMet = action === "consume"
    ? !itemAfter
    : Boolean(
        itemAfter &&
        toInt(itemAfter.ownerID, 0) === ownerID &&
        toInt(itemAfter.typeID, 0) === toInt(job && job.blueprintTypeID, 0) &&
        toInt(itemAfter.categoryID, 0) === BLUEPRINT_CATEGORY_ID &&
        toInt(itemAfter.singleton, 0) === expectedSingleton &&
        (
          verifiedReceipt
            ? hasValidSettledIndustryBlueprintLocation(itemAfter)
            : toInt(itemAfter.locationID, 0) === destination.locationID &&
              toInt(itemAfter.flagID, -1) === destination.flagID
        ),
      );
  if (!postconditionMet) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "INDUSTRY_BLUEPRINT_SETTLEMENT_POSTCONDITION_FAILED",
    };
  }
  const settledChanges = result.data && Array.isArray(result.data.changes)
    ? result.data.changes
    : [];
  syncInventoryChanges(session, settledChanges);
  // A blueprint returning to the corporation division it was installed from is
  // a change to a shared hangar, so the members watching it are owed the row.
  fanCorporationOfficeInventoryChanges(settledChanges, {
    actorSession: session || null,
  });
  return result;
}

function preflightIndustryBlueprintDelivery(job) {
  if (
    toInt(job && job.installedLocationID, 0) !==
      INDUSTRY_INSTALLED_LOCATION_ID
  ) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
    );
  }
  const blueprintID = toInt(job && job.blueprintID, 0);
  const state = getStoredBlueprintState(blueprintID);
  const item = findItemById(blueprintID);
  if (!state) {
    if (job && job.blueprintCopy === true && !item) {
      if (getVerifiedIndustryBlueprintCustodyReceipt(
        job,
        "delivery",
        "consume",
      )) {
        return { success: true };
      }
    }
    return buildIndustryBlueprintSettlementError("BLUEPRINT_STATE_NOT_FOUND");
  }

  const plan = getIndustryBlueprintDeliveryPlan(job, state, item);
  if (!plan.success) {
    return plan;
  }
  const jobID = toInt(job && job.jobID, 0);
  if (!plan.alreadyApplied && toInt(state.jobID, 0) !== jobID) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_CONFLICT",
    );
  }

  const atInstalledLocation = Boolean(
    item &&
    toInt(item.locationID, 0) === INDUSTRY_INSTALLED_LOCATION_ID
  );
  const committedReceipt = getVerifiedIndustryBlueprintCustodyReceipt(
    job,
    "delivery",
    plan.action,
  );
  if (atInstalledLocation && committedReceipt) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_ITEM_MOVED",
    );
  }
  if (plan.alreadyApplied) {
    if (plan.action === "return") {
      return hasValidSettledIndustryBlueprintLocation(item)
        ? { success: true }
        : resolveIndustryBlueprintDestination(job, item)
          ? { success: true }
          : buildIndustryBlueprintSettlementError(
              "INDUSTRY_BLUEPRINT_SETTLEMENT_DESTINATION_INVALID",
            );
    }
    if (!item || atInstalledLocation) {
      return { success: true };
    }
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_ITEM_MOVED",
    );
  }

  if (!atInstalledLocation) {
    if (!committedReceipt) {
      return buildIndustryBlueprintSettlementError(
        "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
      );
    }
    if (
      plan.action === "return" &&
      hasValidSettledIndustryBlueprintLocation(item)
    ) {
      return { success: true };
    }
    if (plan.action === "consume" && !item) {
      return { success: true };
    }
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_ITEM_MOVED",
    );
  }
  if (toInt(item && item.flagID, -1) < 0) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
    );
  }
  if (
    plan.action === "return" &&
    !resolveIndustryBlueprintDestination(job, item)
  ) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_DESTINATION_INVALID",
    );
  }
  return { success: true };
}

function preflightIndustryBlueprintCancellation(job) {
  const blueprintID = toInt(job && job.blueprintID, 0);
  const jobID = toInt(job && job.jobID, 0);
  const state = getStoredBlueprintState(blueprintID);
  const item = findItemById(blueprintID);
  const outputReceipt = getIdempotentGrantReceipt(
    getIndustryOutputReceiptKey(job),
    { requireDurable: true },
  );
  if (!outputReceipt.success) {
    return {
      success: false,
      ambiguous: outputReceipt.ambiguous === true,
      errorMsg:
        outputReceipt.errorMsg || "INDUSTRY_CANCEL_OUTPUT_RECEIPT_CHECK_FAILED",
    };
  }
  if (outputReceipt.found) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_CANCEL_DELIVERY_IN_PROGRESS",
    );
  }
  const validation = validateIndustryBlueprintSettlementState(
    job,
    state,
    item,
    "cancellation",
  );
  if (!validation.success) {
    return validation;
  }
  if (
    toInt(state && state.jobID, 0) !== jobID ||
    toInt(job && job.installedLocationID, 0) !==
      INDUSTRY_INSTALLED_LOCATION_ID ||
    !item ||
    toInt(item.locationID, 0) !== INDUSTRY_INSTALLED_LOCATION_ID ||
    toInt(item.flagID, -1) < 0
  ) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_SOURCE_INVALID",
    );
  }
  if (!resolveIndustryBlueprintDestination(job, item)) {
    return buildIndustryBlueprintSettlementError(
      "INDUSTRY_BLUEPRINT_SETTLEMENT_DESTINATION_INVALID",
    );
  }
  return { success: true };
}

function finishBlueprintAfterDelivery(job, session, options = {}) {
  const blueprintID = toInt(job && job.blueprintID, 0);
  const jobID = toInt(job && job.jobID, 0);
  const state = getStoredBlueprintState(blueprintID);
  const item = findItemById(blueprintID);

  if (!state) {
    if (job && job.blueprintCopy === true && !item) {
      const committedReceipt = getVerifiedIndustryBlueprintCustodyReceipt(
        job,
        "delivery",
        "consume",
      );
      if (!committedReceipt) {
        return {
          success: false,
          ambiguous: true,
          errorMsg: "BLUEPRINT_STATE_NOT_FOUND",
        };
      }
      const replay = settleIndustryBlueprintCustody(
        job,
        "consume",
        session,
        { intent: "delivery" },
      );
      return replay.success
        ? flushIndustryTableSync(
            INDUSTRY_BLUEPRINT_STATE_TABLE,
            "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_FLUSH_FAILED",
          )
        : replay;
    }
    return {
      success: false,
      ambiguous: true,
      errorMsg: "BLUEPRINT_STATE_NOT_FOUND",
    };
  }

  const plan = getIndustryBlueprintDeliveryPlan(job, state, item);
  if (!plan.success) {
    return plan;
  }
  const alreadyApplied = plan.alreadyApplied;
  if (!alreadyApplied && toInt(state.jobID, 0) !== jobID) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_CONFLICT",
    };
  }
  const remainingRuns = plan.remainingRuns;
  const action = plan.action;
  const custodyResult = settleIndustryBlueprintCustody(
    job,
    action,
    session,
    {
      intent: "delivery",
      allowExistingPostcondition:
        options.allowExistingPostcondition === true || alreadyApplied,
      allowSettledMovedItem: alreadyApplied,
    },
  );
  if (!custodyResult.success) {
    return custodyResult;
  }

  if (action === "consume") {
    if (!removeBlueprintState(blueprintID)) {
      return { success: false, ambiguous: true, errorMsg: "WRITE_ERROR" };
    }
  } else if (!alreadyApplied) {
    const stateResult = updateBlueprintState(blueprintID, (current) => {
      const next = {
        ...current,
        jobID: null,
        lastCompletedJobID: jobID,
      };
      if (current.original !== true) {
        next.runsRemaining = remainingRuns;
      }
      if (toInt(job && job.activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_MATERIAL) {
        next.materialEfficiency = Math.min(
          MAX_MATERIAL_EFFICIENCY,
          Math.max(0, toInt(current.materialEfficiency, 0)) +
            STEP_MATERIAL_EFFICIENCY * Math.max(0, toInt(job && job.runs, 0)),
        );
      }
      if (toInt(job && job.activityID, 0) === INDUSTRY_ACTIVITY.RESEARCH_TIME) {
        next.timeEfficiency = Math.min(
          MAX_TIME_EFFICIENCY,
          Math.max(0, toInt(current.timeEfficiency, 0)) +
            STEP_TIME_EFFICIENCY * Math.max(0, toInt(job && job.runs, 0)),
        );
      }
      return next;
    });
    if (!stateResult.success) {
      return stateResult;
    }
  }
  return flushIndustryTableSync(
    INDUSTRY_BLUEPRINT_STATE_TABLE,
    "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_FLUSH_FAILED",
  );
}

function finishCancelledIndustryJobSource(job, session, options = {}) {
  const blueprintID = toInt(job && job.blueprintID, 0);
  const jobID = toInt(job && job.jobID, 0);
  const state = getStoredBlueprintState(blueprintID);
  if (!state) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "BLUEPRINT_STATE_NOT_FOUND",
    };
  }
  if (
    toInt(state.lastCancelledJobID, 0) === jobID &&
    toInt(state.jobID, 0) > 0 &&
    toInt(state.jobID, 0) !== jobID
  ) {
    return { success: true };
  }
  const validation = validateIndustryBlueprintSettlementState(
    job,
    state,
    findItemById(blueprintID),
    "cancellation",
  );
  if (!validation.success) {
    return validation;
  }
  const alreadyApplied =
    toInt(state.lastCancelledJobID, 0) === jobID &&
    toInt(state.jobID, 0) === 0;
  if (!alreadyApplied && toInt(state.jobID, 0) !== jobID) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_CONFLICT",
    };
  }
  const custodyResult = settleIndustryBlueprintCustody(
    job,
    "return",
    session,
    {
      intent: "cancellation",
      allowExistingPostcondition:
        options.allowExistingPostcondition === true || alreadyApplied,
      allowSettledMovedItem: alreadyApplied,
    },
  );
  if (!custodyResult.success) {
    return custodyResult;
  }
  if (!alreadyApplied) {
    const stateResult = updateBlueprintState(blueprintID, (current) => ({
      ...current,
      jobID: null,
      lastCancelledJobID: jobID,
    }));
    if (!stateResult.success) {
      return stateResult;
    }
  }
  return flushIndustryTableSync(
    INDUSTRY_BLUEPRINT_STATE_TABLE,
    "INDUSTRY_BLUEPRINT_SETTLEMENT_STATE_FLUSH_FAILED",
  );
}

function getItemAvailableQuantity(item) {
  return toInt(item && item.singleton, 0) === 1
    ? 1
    : Math.max(0, toInt(item && (item.stacksize ?? item.quantity), 0));
}

function selectExactIndustryMaterialInputs(quote) {
  const selected = [];
  const reservedByItemID = new Map();
  const requiredByTypeID = new Map();
  for (const material of quote.materials || []) {
    const typeID = toInt(material && material.typeID, 0);
    const quantity = Math.max(0, toInt(material && material.quantity, 0));
    if (typeID > 0 && quantity > 0) {
      requiredByTypeID.set(typeID, (requiredByTypeID.get(typeID) || 0) + quantity);
    }
  }
  for (const [typeID, requiredQuantity] of requiredByTypeID) {
    let remaining = requiredQuantity;
    const candidates = listContainerItems(
      quote.ownerID,
      getIndustryInventoryLocationID(quote.inputLocation),
      getIndustryLocationInventoryFlagID(quote.inputLocation),
    ).filter((item) =>
      toInt(item && item.typeID, 0) === typeID)
      .sort((left, right) => toInt(left.itemID, 0) - toInt(right.itemID, 0));
    for (const item of candidates) {
      if (remaining <= 0) {
        break;
      }
      const itemID = toInt(item.itemID, 0);
      const alreadyReserved = reservedByItemID.get(itemID) || 0;
      const available = Math.max(0, getItemAvailableQuantity(item) - alreadyReserved);
      const quantity = Math.min(remaining, available);
      if (quantity <= 0) {
        continue;
      }
      selected.push({
        itemID,
        typeID: toInt(item.typeID, 0),
        quantity,
        ownerID: quote.ownerID,
        locationID: getIndustryInventoryLocationID(quote.inputLocation),
        flagID: getIndustryLocationInventoryFlagID(quote.inputLocation),
      });
      reservedByItemID.set(itemID, alreadyReserved + quantity);
      remaining -= quantity;
    }
    if (remaining > 0) {
      return {
        success: false,
        errorMsg: "MISSING_MATERIAL",
        typeID,
        requested: requiredQuantity,
        missing: remaining,
      };
    }
  }
  return { success: true, data: selected };
}

function buildIndustryInstallJobRecord(quote, session, jobID) {
  const nowFiletime = currentFileTime();
  const isInvention = quote.activityID === INDUSTRY_ACTIVITY.INVENTION;
  return {
    activityID: quote.activityID,
    jobID,
    blueprintID: quote.blueprint.itemID,
    blueprintTypeID: quote.blueprint.typeID,
    blueprintCopy: quote.state.original !== true,
    blueprintLocationID: quote.blueprint.locationID,
    blueprintLocationTypeID: quote.blueprint.locationTypeID,
    blueprintInventoryLocationID: toInt(
      quote.blueprint.inventoryLocationID || quote.blueprint.locationID,
      0,
    ),
    blueprintLocationFlagID: quote.blueprint.locationFlagID,
    blueprintInventoryFlagID: quote.blueprint.flagID,
    installedLocationID: INDUSTRY_INSTALLED_LOCATION_ID,
    facilityID: quote.facility.facilityID,
    ...(quote.facility.starbaseTowerID ? { starbaseTowerID: quote.facility.starbaseTowerID } : {}),
    ownerID: quote.ownerID,
    status: INDUSTRY_STATUS.INSTALLED,
    installerID: toInt(session && session.characterID, 0),
    completedCharacterID: 0,
    solarSystemID: quote.facility.solarSystemID,
    stationID: getStationIDForFacility(quote.facility.facilityID),
    deliveryReceiptID: crypto.randomUUID(),
    startDate: nowFiletime.toString(),
    endDate: (
      nowFiletime +
      BigInt(Math.max(0, toInt(quote.timeInSeconds, 0))) * FILETIME_TICKS_PER_SECOND
    ).toString(),
    pauseDate: null,
    runs: quote.runs,
    licensedRuns: quote.licensedRuns,
    successfulRuns: 0,
    cost: quote.cost,
    tax: quote.tax,
    totalCost: quote.totalCost,
    timeInSeconds: quote.timeInSeconds,
    probability: isInvention ? quote.probability : 1,
    productTypeID: quote.productTypeID,
    optionalTypeID: isInvention ? quote.optionalTypeID : null,
    optionalTypeID2: null,
    outputLocationID: quote.outputLocation.itemID,
    outputInventoryLocationID: getIndustryInventoryLocationID(quote.outputLocation),
    outputFlagID: quote.outputLocation.flagID,
    outputInventoryFlagID: getIndustryLocationInventoryFlagID(quote.outputLocation),
    inputLocationID: quote.inputLocation.itemID,
    inputInventoryLocationID: getIndustryInventoryLocationID(quote.inputLocation),
    inputFlagID: quote.inputLocation.flagID,
    account: cloneValue(quote.account),
    materials: cloneValue(quote.materialMap),
    inventionSuccessfulRuns: isInvention
      ? rollInventionSuccessfulRuns(quote.runs, quote.probability)
      : null,
  };
}

function persistPreparedIndustryInstall(settlement) {
  const jobID = toInt(settlement && settlement.jobID, 0);
  const operationID = String(settlement && settlement.operationID || "");
  const jobRecord = cloneValue(settlement && settlement.jobRecord || null);
  if (
    !jobID ||
    !operationID ||
    !jobRecord ||
    toInt(jobRecord.installedLocationID, 0) !==
      INDUSTRY_INSTALLED_LOCATION_ID
  ) {
    return { success: false, errorMsg: "INVALID_INDUSTRY_INSTALL_PREPARE" };
  }
  const blueprintState = getBlueprintState(jobRecord.blueprintID);
  if (
    !blueprintState ||
    blueprintState.jobID && toInt(blueprintState.jobID, 0) !== jobID
  ) {
    return { success: false, errorMsg: "BLUEPRINT_INSTALLED" };
  }

  const jobsTable = ensureJobsTable();
  const existing = jobsTable.jobs[String(jobID)];
  if (
    existing &&
    String(existing.installationOperationID || "") !== operationID
  ) {
    return { success: false, ambiguous: true, errorMsg: "INDUSTRY_JOB_ID_REUSED" };
  }
  if (!existing) {
    jobsTable.jobs[String(jobID)] = {
      ...jobRecord,
      jobID,
      installationOperationID: operationID,
      installationPending: true,
    };
    if (!persistJobsTable(jobsTable)) {
      return { success: false, ambiguous: true, errorMsg: "INDUSTRY_JOB_PREPARE_WRITE_FAILED" };
    }
    const flushResult = database.flushTableSync(INDUSTRY_JOBS_TABLE);
    if (!flushResult || flushResult.success !== true) {
      return flushResult || {
        success: false,
        ambiguous: true,
        errorMsg: "INDUSTRY_JOB_PREPARE_FLUSH_FAILED",
      };
    }
  }

  if (toInt(blueprintState.jobID, 0) !== jobID) {
    const stateResult = updateBlueprintState(jobRecord.blueprintID, (current) => ({
      ...current,
      jobID,
    }));
    if (!stateResult.success) {
      return {
        success: false,
        ambiguous: true,
        errorMsg: stateResult.errorMsg || "INDUSTRY_BLUEPRINT_LOCK_FAILED",
      };
    }
    const flushResult = database.flushTableSync(INDUSTRY_BLUEPRINT_STATE_TABLE);
    if (!flushResult || flushResult.success !== true) {
      return flushResult || {
        success: false,
        ambiguous: true,
        errorMsg: "INDUSTRY_BLUEPRINT_LOCK_FLUSH_FAILED",
      };
    }
  }
  return { success: true, data: { jobID } };
}

function finalizePreparedIndustryInstall(settlement) {
  const jobID = toInt(settlement && settlement.jobID, 0);
  const operationID = String(settlement && settlement.operationID || "");
  const jobsTable = ensureJobsTable();
  const existing = jobsTable.jobs[String(jobID)];
  if (
    !existing ||
    String(existing.installationOperationID || "") !== operationID
  ) {
    return {
      success: false,
      ambiguous: true,
      errorMsg: "INDUSTRY_JOB_PREPARE_MISSING",
    };
  }
  if (existing.installationPending === true) {
    jobsTable.jobs[String(jobID)] = {
      ...existing,
      installationPending: false,
    };
    if (!persistJobsTable(jobsTable)) {
      return { success: false, ambiguous: true, errorMsg: "INDUSTRY_JOB_FINALIZE_WRITE_FAILED" };
    }
    const flushResult = database.flushTableSync(INDUSTRY_JOBS_TABLE);
    if (!flushResult || flushResult.success !== true) {
      return flushResult || {
        success: false,
        ambiguous: true,
        errorMsg: "INDUSTRY_JOB_FINALIZE_FLUSH_FAILED",
      };
    }
  }
  return { success: true, data: getJobByID(jobID) };
}

function publishPreparedIndustryInstall(settlement, options = {}) {
  const jobID = toInt(settlement && settlement.jobID, 0);
  const job = getJobByID(jobID);
  if (!job) {
    return false;
  }
  if (options.notify !== false) {
    const sessions = new Set();
    if (options.preferredSession) {
      sessions.add(options.preferredSession);
    }
    const liveSession = sessionRegistry.findSessionByCharacterID(
      toInt(settlement && settlement.characterID, 0),
    );
    if (liveSession) {
      sessions.add(liveSession);
    }
    const installChanges = [
      ...(settlement.materialChanges || []),
      ...(settlement.blueprintChanges || []),
    ];
    for (const session of sessions) {
      syncInventoryChanges(session, installChanges);
    }
    // Once for the settlement, outside the per-session loop above -- the
    // observers are the same set whichever of the installer's sessions is
    // being synced, and this still runs when none of them is online.
    fanCorporationOfficeInventoryChanges(installChanges, {
      actorSession: options.preferredSession || null,
      excludeSessions: [...sessions],
    });
    notifyBlueprintsUpdated(job.ownerID);
    notifyIndustryJob(job);
  }

  if (job.activityID === INDUSTRY_ACTIVITY.MANUFACTURING) {
    try {
      require(path.join(
        __dirname,
        "../dailyGoals/dailyGoalsState",
      )).recordActivity(job.installerID, "install_manufacturing_job", 1);
    } catch (dailyGoalError) {
      log.debug(
        `[IndustryRuntime] daily-goal manufacture hook failed: ${dailyGoalError.message}`,
      );
    }
  }
  queueDurableIndustryJobReconciliation(jobID);
  return true;
}

// JSON has no word for a BigInt, and a request carries what was read off the
// wire beside its fields (industryPayloads.js parseIndustryRequest,
// rawRequest), where a whole number sent as an int64 is one. It is spelt as
// the number it is where a number holds it, so that a request is the same
// request however its numbers were sent, and by its digits where none does.
function spellBigIntForFingerprint(_key, value) {
  if (typeof value !== "bigint") {
    return value;
  }
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function buildIndustryInstallRequestFingerprint(session, requestInput) {
  return JSON.stringify({
    characterID: toInt(session && session.characterID, 0),
    request: requestInput || {},
  }, spellBigIntForFingerprint);
}

function throwIndustryInstallSettlementError(settlement, quote = null) {
  const errorMsg = settlement && settlement.errorMsg || "INDUSTRY_INSTALL_SETTLEMENT_FAILED";
  if (errorMsg === "INSUFFICIENT_FUNDS") {
    throwIndustryValidationError([
      buildIndustryValidationError(
        INDUSTRY_ERROR.ACCOUNT_FUNDS,
        0,
        quote ? quote.totalCost : 0,
      ),
    ]);
  }
  if (errorMsg === "MISSING_MATERIAL") {
    throwIndustryValidationError([
      buildIndustryValidationError(INDUSTRY_ERROR.MISSING_MATERIAL, 0, 0, 0, 0),
    ]);
  }
  if (errorMsg === "BLUEPRINT_NOT_FOUND" || errorMsg === "BLUEPRINT_INSTALLED") {
    throwIndustryValidationError([
      buildIndustryValidationError(INDUSTRY_ERROR.MISSING_BLUEPRINT),
    ]);
  }
  // Not the player's doing and not retryable by them, so say so rather than
  // showing a raw code they will read as having lost the blueprint or the ISK.
  // Nothing was charged (industryInstallSettlementState's
  // debitAnsweredFromAnotherOperation refuses before the charge is recorded) and
  // the blueprint and materials are returned by the rejection.
  if (errorMsg === "INDUSTRY_INSTALL_DEBIT_COLLIDED") {
    throwWrappedUserError("CustomNotify", {
      notify:
        "Industry installation was cancelled by a server wallet fault. You have " +
        "not been charged and your blueprint and materials are untouched. Please " +
        "report this to the server administrator.",
    });
  }
  throwWrappedUserError("CustomNotify", {
    notify: `Industry installation failed: ${errorMsg}`,
  });
}

async function installIndustryJob(session, requestInput) {
  const clientRequestFingerprint = buildIndustryInstallRequestFingerprint(
    session,
    requestInput,
  );
  const characterID = toInt(session && session.characterID, 0);
  const existing = industryInstallSettlementState
    .getPendingIndustryInstallSettlement(characterID);
  if (existing) {
    if (existing.clientRequestFingerprint !== clientRequestFingerprint) {
      throwWrappedUserError("CustomNotify", {
        notify: "Another industry installation is still pending.",
      });
    }
    const resumed = await industryInstallSettlementState
      .settleIndustryInstallSettlement(characterID, {
        preferredSession: session,
      });
    if (!resumed || resumed.success !== true || resumed.rejected === true) {
      throwIndustryInstallSettlementError(resumed, existing.quote);
    }
    return {
      success: true,
      data: {
        jobID: existing.jobID,
        quote: existing.quote,
        job: getJobByID(existing.jobID),
      },
    };
  }

  const quoteResult = quoteIndustryJob(session, requestInput);
  if (!quoteResult.success) {
    throwIndustryValidationError(quoteResult.errors);
  }

  const { quote } = quoteResult;
  const materialInputs = selectExactIndustryMaterialInputs(quote);
  if (!materialInputs.success) {
    throwIndustryValidationError([
      buildIndustryValidationError(
        INDUSTRY_ERROR.MISSING_MATERIAL,
        materialInputs.typeID,
        materialInputs.requested,
        materialInputs.requested - materialInputs.missing,
        materialInputs.missing,
      ),
    ]);
  }
  const reservation = reserveIndustryJobID();
  if (!reservation.success) {
    throwWrappedUserError("CustomNotify", {
      notify: reservation.errorMsg || "Failed to reserve the industry job.",
    });
  }
  const jobID = reservation.jobID;
  const blueprintItem = findItemById(quote.blueprint.itemID);
  if (!blueprintItem) {
    throwIndustryValidationError([
      buildIndustryValidationError(INDUSTRY_ERROR.MISSING_BLUEPRINT),
    ]);
  }
  const jobRecord = buildIndustryInstallJobRecord(quote, session, jobID);
  const prepared = industryInstallSettlementState.prepareIndustryInstallSettlement({
    characterID,
    ownerID: quote.ownerID,
    ownerKind: isCharacterOwner(session, quote.ownerID)
      ? "character"
      : "corporation",
    payerOwnerID: quote.payerOwnerID,
    payerKind: quote.payerKind,
    accountKey: normalizeCorporationWalletKey(quote.account && quote.account[1]),
    jobID,
    jobRecord,
    quote,
    materialInputs: materialInputs.data,
    blueprintInput: {
      itemID: blueprintItem.itemID,
      typeID: blueprintItem.typeID,
      ownerID: blueprintItem.ownerID,
      locationID: blueprintItem.locationID,
      flagID: blueprintItem.flagID,
      sourceSnapshot: blueprintItem,
    },
    totalCost: quote.totalCost,
    walletDescription:
      `Industry job install by ${session && (
        session.characterName ||
        session.userName ||
        session.characterID ||
        quote.ownerID
      )}`,
    clientRequestFingerprint,
  });
  if (!prepared || prepared.success !== true) {
    throwWrappedUserError("CustomNotify", {
      notify: prepared && prepared.errorMsg || "Failed to persist the industry installation.",
    });
  }
  const settlement = await industryInstallSettlementState
    .settleIndustryInstallSettlement(characterID, {
      preferredSession: session,
    });
  if (!settlement || settlement.success !== true || settlement.rejected === true) {
    throwIndustryInstallSettlementError(settlement, quote);
  }

  return {
    success: true,
    data: {
      jobID,
      quote,
      job: getJobByID(jobID),
    },
  };
}

function installManufacturingJob(session, requestInput) {
  return installIndustryJob(session, requestInput);
}

// Return an exact install intent before the crew fences it in its own journal.
// Reserving an ID has no material, blueprint or wallet effect.
function prepareCrewManufacturingIntent(actor, request, crewOrder) {
  if (crewIndustryActors.get(actor) !== request.facilityID || request.activityID !== INDUSTRY_ACTIVITY.MANUFACTURING ||
      !/^[a-f0-9]{64}$/.test(crewOrder?.jobID) || !Number.isSafeInteger(crewOrder.serial) || crewOrder.serial < 1) {
    return { success: false, errorMsg: "CREW_MANUFACTURING_INVALID" };
  }
  const result = quoteIndustryJob(actor, request);
  if (!result.success) return result;
  const quote = result.quote;
  if (quote.ownerID !== actor.characterID || quote.payerOwnerID !== actor.characterID ||
      ![7, 8].includes(quote.definition.productCategoryID) || quote.materials.some(m => getItemMetadata(m.typeID)?.groupID !== 18)) {
    return { success: false, errorMsg: "CREW_MANUFACTURING_RECIPE_INVALID" };
  }
  const inputs = selectExactIndustryMaterialInputs(quote);
  if (!inputs.success) return { success: false, errorMsg: "MISSING_MATERIAL" };
  const reservation = reserveIndustryJobID();
  if (!reservation.success) return reservation;
  const blueprint = findItemById(quote.blueprint.itemID);
  const jobRecord = { ...buildIndustryInstallJobRecord(quote, actor, reservation.jobID), crewOrder: { ...crewOrder }, crewSkill: crewIndustrySkills.get(actor), crewEquipment: crewIndustryEquipment.get(actor) };
  return { success: true, data: { characterID: actor.characterID, ownerID: actor.characterID, ownerKind: "character",
    payerOwnerID: actor.characterID, payerKind: "character", accountKey: DEFAULT_ACCOUNT_KEY,
    jobID: reservation.jobID, jobRecord, quote, materialInputs: inputs.data,
    blueprintInput: { itemID: blueprint.itemID, typeID: blueprint.typeID, ownerID: blueprint.ownerID,
      locationID: blueprint.locationID, flagID: blueprint.flagID, sourceSnapshot: blueprint },
    totalCost: quote.totalCost, walletDescription: "Crew manufacturing installation", crewOrder: { ...crewOrder },
    clientRequestFingerprint: buildIndustryInstallRequestFingerprint(actor, { ...request, crewOrder }) } };
}

function acknowledgeCrewManufacturingJob(characterID, jobID, crewOrder) {
  const job = getJobByID(jobID);
  if (!job || job.ownerID !== characterID || job.crewOrder?.jobID !== crewOrder.jobID || job.crewOrder.serial !== crewOrder.serial ||
      ![INDUSTRY_STATUS.DELIVERED, INDUSTRY_STATUS.CANCELLED, INDUSTRY_STATUS.REVERTED].includes(job.status)) {
    return { success: false, errorMsg: "CREW_MANUFACTURING_ACK_CONFLICT" };
  }
  const hash = key => crypto.createHash("sha256").update(key).digest("hex");
  const keys = new Set([getIndustryOutputReceiptKey(job), ...["return", "consume"].map(action =>
    `item-custody:local:${hash(getIndustryBlueprintCustodyKey(job, "delivery", action))}`)]);
  const pruned = require("../inventory/itemStore").pruneIdempotentGrantReceipts(receipt => keys.has(receipt.receiptKey));
  return pruned.success ? database.flushTableSync("items") : pruned;
}

function getIndustryOutputReceiptKey(job) {
  const receiptID = String(job && job.deliveryReceiptID || "").trim();
  if (receiptID) {
    return `evejsIndustryOutput:${receiptID}:v2`;
  }
  return [
    "evejsIndustryOutput",
    toInt(job && job.jobID, 0),
    toInt(job && job.blueprintID, 0),
    normalizeIndustryFileTime(job && job.startDate, 0n).toString(),
    "v1",
  ].join(":");
}

function applyBlueprintStateToGrantedCopies(grantResult, templateState) {
  const createdItems =
    grantResult &&
    grantResult.data &&
    Array.isArray(grantResult.data.items)
      ? grantResult.data.items
      : [];
  const intendedState = {
    typeID: Number(templateState && templateState.typeID),
    materialEfficiency: Number(templateState && templateState.materialEfficiency),
    timeEfficiency: Number(templateState && templateState.timeEfficiency),
    runsRemaining: Number(templateState && templateState.runsRemaining),
  };
  if (
    !Number.isSafeInteger(intendedState.typeID) ||
    intendedState.typeID <= 0 ||
    !Number.isSafeInteger(intendedState.materialEfficiency) ||
    intendedState.materialEfficiency < 0 ||
    intendedState.materialEfficiency > MAX_MATERIAL_EFFICIENCY ||
    !Number.isSafeInteger(intendedState.timeEfficiency) ||
    intendedState.timeEfficiency < 0 ||
    intendedState.timeEfficiency > MAX_TIME_EFFICIENCY ||
    !Number.isSafeInteger(intendedState.runsRemaining) ||
    intendedState.runsRemaining <= 0
  ) {
    return { success: false, errorMsg: "INVALID_BLUEPRINT_OUTPUT_STATE" };
  }
  for (const item of createdItems) {
    const itemID = toInt(item && item.itemID, 0);
    const storedItem = findItemById(itemID);
    if (
      !storedItem ||
      toInt(storedItem.typeID, 0) !== intendedState.typeID ||
      toInt(storedItem.categoryID, 0) !== BLUEPRINT_CATEGORY_ID ||
      toInt(storedItem.singleton, 0) !== 2
    ) {
      return { success: false, errorMsg: "BLUEPRINT_OUTPUT_STATE_CONFLICT" };
    }
    const existingState = getStoredBlueprintState(itemID);
    if (existingState) {
      const exactIdleState =
        toInt(existingState.itemID, 0) === itemID &&
        toInt(existingState.typeID, 0) === intendedState.typeID &&
        existingState.original === false &&
        Number(existingState.materialEfficiency) ===
          intendedState.materialEfficiency &&
        Number(existingState.timeEfficiency) === intendedState.timeEfficiency &&
        Number(existingState.runsRemaining) === intendedState.runsRemaining &&
        (existingState.jobID === null || existingState.jobID === undefined) &&
        toInt(existingState.lastCompletedJobID, 0) === 0 &&
        toInt(existingState.lastCancelledJobID, 0) === 0;
      if (!exactIdleState) {
        return { success: false, errorMsg: "BLUEPRINT_OUTPUT_STATE_CONFLICT" };
      }
      continue;
    }
    const updateResult = initializeBlueprintState(item.itemID, {
      typeID: intendedState.typeID,
      materialEfficiency: intendedState.materialEfficiency,
      timeEfficiency: intendedState.timeEfficiency,
      original: false,
      runsRemaining: intendedState.runsRemaining,
      jobID: null,
    });
    if (!updateResult.success) {
      return updateResult;
    }
  }
  return { success: true };
}

function resolvePersistedInventionSuccessfulRuns(currentJob) {
  const runs = Math.max(0, toInt(currentJob && currentJob.runs, 0));
  if (
    currentJob &&
    currentJob.inventionSuccessfulRuns !== null &&
    currentJob.inventionSuccessfulRuns !== undefined
  ) {
    return {
      success: true,
      successfulRuns: clamp(
        toInt(currentJob.inventionSuccessfulRuns, 0),
        0,
        runs,
      ),
    };
  }

  const successfulRuns = rollInventionSuccessfulRuns(
    runs,
    currentJob && currentJob.probability,
  );
  const jobsTable = ensureJobsTable();
  const storedJob = jobsTable.jobs[String(toInt(currentJob && currentJob.jobID, 0))];
  if (!storedJob) {
    return { success: false, errorMsg: "JOB_NOT_FOUND" };
  }
  jobsTable.jobs[String(currentJob.jobID)] = {
    ...storedJob,
    inventionSuccessfulRuns: successfulRuns,
  };
  if (!persistJobsTable(jobsTable)) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
  currentJob.inventionSuccessfulRuns = successfulRuns;
  return { success: true, successfulRuns };
}

function persistInventionDeliveryState(currentJob, update) {
  const jobsTable = ensureJobsTable();
  const jobID = toInt(currentJob && currentJob.jobID, 0);
  const storedJob = jobsTable.jobs[String(jobID)];
  if (!storedJob) {
    return { success: false, errorMsg: "JOB_NOT_FOUND" };
  }
  const nextState = {
    ...(
      currentJob.inventionDelivery &&
      typeof currentJob.inventionDelivery === "object"
        ? currentJob.inventionDelivery
        : {}
    ),
    ...(update && typeof update === "object" ? update : {}),
    updatedAt: Date.now(),
  };
  jobsTable.jobs[String(jobID)] = {
    ...storedJob,
    inventionDelivery: nextState,
  };
  if (!persistJobsTable(jobsTable)) {
    return { success: false, errorMsg: "WRITE_ERROR" };
  }
  currentJob.inventionDelivery = nextState;
  return { success: true, data: cloneValue(nextState) };
}

function getInventionOutputMarker(jobID) {
  return `evejsIndustryInvention:${toInt(jobID, 0)}`;
}

function deliverInventionJob(currentJob, session) {
  const definition = getBlueprintDefinitionByTypeID(currentJob.blueprintTypeID);
  const product = resolveInventionProduct(
    definition,
    currentJob.productTypeID,
  );
  if (!product) {
    return { success: false, errorMsg: "INVALID_PRODUCT" };
  }

  const outcome = resolvePersistedInventionSuccessfulRuns(currentJob);
  if (!outcome.success) {
    return outcome;
  }
  const successfulRuns = outcome.successfulRuns;
  const prepareResult = persistInventionDeliveryState(currentJob, {
    phase: "prepared",
    successfulRuns,
  });
  if (!prepareResult.success) {
    return prepareResult;
  }

  const decryptor = resolveDecryptorModifiers(currentJob.optionalTypeID);
  const outputBlueprintTypeID = toInt(product.typeID, 0);
  const outputRuns = Math.max(
    1,
    Math.round(toFloat(product.quantity, 0) + decryptor.maxRuns),
  );
  const outputMarker = getInventionOutputMarker(currentJob.jobID);
  const existingItems = listOwnedItems(currentJob.ownerID)
    .filter((item) => (
      toInt(item && item.typeID, 0) === outputBlueprintTypeID &&
      String(item && item.customInfo || "") === outputMarker
    ))
    .sort((left, right) => toInt(left && left.itemID, 0) - toInt(right && right.itemID, 0));
  if (existingItems.length > successfulRuns) {
    return { success: false, errorMsg: "DUPLICATE_INVENTION_OUTPUTS" };
  }

  let grantResult = {
    success: true,
    data: {
      changes: [],
      items: [],
    },
  };
  const missingOutputCount = successfulRuns - existingItems.length;
  if (missingOutputCount > 0) {
    const grantEntries = [{
      itemType: outputBlueprintTypeID,
      quantity: missingOutputCount,
      options: {
        singleton: 2,
        customInfo: outputMarker,
      },
    }];
    grantResult = grantItemsToOwnerLocationIdempotent(
      currentJob.ownerID,
      getIndustryJobOutputInventoryLocationID(currentJob),
      getIndustryJobOutputInventoryFlagID(currentJob),
      grantEntries,
      {
        receiptKey: getIndustryOutputReceiptKey(currentJob),
        receiptMetadata: {
          domain: "industry",
          jobID: toInt(currentJob.jobID, 0),
          activityID: toInt(currentJob.activityID, 0),
        },
      },
    );
    if (!grantResult.success) {
      return grantResult;
    }
  }

  const outputItems = [
    ...existingItems,
    ...(
      grantResult.data && Array.isArray(grantResult.data.items)
        ? grantResult.data.items
        : []
    ),
  ];
  const recoveredChanges = existingItems.map((item) => ({
    created: true,
    item,
    previousState: {
      locationID: 0,
      flagID: 0,
    },
  }));

  const stateResult = applyBlueprintStateToGrantedCopies({
    data: { items: outputItems },
  }, {
    typeID: outputBlueprintTypeID,
    materialEfficiency:
      INVENTION_MATERIAL_EFFICIENCY + decryptor.materialEfficiency,
    timeEfficiency:
      INVENTION_TIME_EFFICIENCY + decryptor.timeEfficiency,
    runsRemaining: outputRuns,
  });
  if (!stateResult.success) {
    return stateResult;
  }

  const outputStateResult = persistInventionDeliveryState(currentJob, {
    phase: "outputsCreated",
    successfulRuns,
    outputItemIDs: outputItems.map((item) => toInt(item && item.itemID, 0)),
  });
  if (!outputStateResult.success) {
    return outputStateResult;
  }

  return {
    ...grantResult,
    data: {
      ...(grantResult.data || {}),
      changes: [
        ...recoveredChanges,
        ...(
          grantResult.data && Array.isArray(grantResult.data.changes)
            ? grantResult.data.changes
            : []
        ),
      ],
      items: outputItems,
      successfulRuns,
      outputMarker,
    },
  };
}

function clearInventionOutputMarkers(job) {
  const outputMarker = getInventionOutputMarker(job && job.jobID);
  const updatedItems = new Map();
  for (const item of listOwnedItems(toInt(job && job.ownerID, 0))) {
    if (String(item && item.customInfo || "") !== outputMarker) {
      continue;
    }
    const updateResult = updateInventoryItem(item.itemID, (current) => ({
      ...current,
      customInfo: "",
    }));
    if (updateResult.success) {
      updatedItems.set(toInt(item.itemID, 0), updateResult.data);
    }
  }
  return updatedItems;
}

function deliverIndustryJob(session, jobID) {
  const currentJob = getJobByID(jobID);
  if (!currentJob) {
    // The client's own dialog for it (the install's IndustryJobNotFound).
    throwWrappedUserError("IndustryJobNotFound");
  }
  if (!isCharacterOwner(session, currentJob.ownerID) && !hasCorporationIndustryJobAccess(session, currentJob.ownerID)) {
    // The client's own dialog for it (the install's IndustryJobAccessDenied).
    throwWrappedUserError("IndustryJobAccessDenied");
  }
  // Not ready to deliver: the client's own dialog for the job's state (the install's IndustryJobPaused for a facility
  // offline, IndustryJobAlreadyCompleted for one done, IndustryJobNotReady for one still in production).
  const deliverStatus = getJobStatus(currentJob);
  if (deliverStatus !== INDUSTRY_STATUS.READY) {
    throwWrappedUserError(
      deliverStatus === INDUSTRY_STATUS.PAUSED
        ? "IndustryJobPaused"
        : deliverStatus >= INDUSTRY_STATUS.COMPLETED
          ? "IndustryJobAlreadyCompleted"
          : "IndustryJobNotReady",
    );
  }
  if (currentJob.starbaseTowerID && (!starbaseIndustry.getArrayContext(currentJob.facilityID)?.online ||
      !starbaseIndustry.canAccessArray(session, starbaseIndustry.getAssemblyArray(currentJob.facilityID)))) {
    throwWrappedUserError("CustomNotify", { notify: "The POS industrial facility and its control tower must be online and eligible to deliver this job." });
  }

  const definition = getBlueprintDefinitionByTypeID(currentJob.blueprintTypeID);
  const outputManifest = buildIndustryOutputManifest(
    definition,
    currentJob.activityID,
    currentJob.runs,
    currentJob.blueprintTypeID,
    currentJob.productTypeID,
  );
  const existingOutputReceipt = outputManifest.length > 0
    ? getIdempotentGrantReceipt(getIndustryOutputReceiptKey(currentJob), {
        requireDurable: true,
      })
    : { success: false };
  if (
    outputManifest.length > 0 &&
    !(existingOutputReceipt.success && existingOutputReceipt.found)
  ) {
    const savedOutputLocation = resolveSavedIndustryJobOutputLocation(currentJob, session);
    if (!savedOutputLocation) {
      throwWrappedUserError("CustomNotify", {
        notify: "The industry job output location is no longer valid.",
      });
    }
    const outputCapacity = resolveIndustryOutputCapacity(
      currentJob.ownerID,
      savedOutputLocation,
      outputManifest,
    );
    if (outputCapacity.overflow) {
      throwWrappedUserError("CustomNotify", {
        notify: "There is not enough space in the industry job output location.",
      });
    }
  }

  const sourcePreflight = preflightIndustryBlueprintDelivery(currentJob);
  if (!sourcePreflight.success) {
    throwWrappedUserError("CustomNotify", {
      notify: "The industry source blueprint cannot be settled safely.",
    });
  }

  let grantResult = {
    success: true,
    data: {
      changes: [],
      items: [],
    },
  };
  let deliveredSuccessfulRuns = Math.max(0, toInt(currentJob.runs, 0));
  if (
    toInt(currentJob.activityID, 0) === INDUSTRY_ACTIVITY.MANUFACTURING ||
    toInt(currentJob.activityID, 0) === INDUSTRY_ACTIVITY.REACTION
  ) {
    const outputs = buildProductOutput(
      definition,
      currentJob.runs,
      toInt(currentJob.activityID, 0),
    );
    const grantEntries = outputs.map((output) => ({
      itemType: output.typeID,
      quantity: output.quantity,
    }));
    grantResult = grantItemsToOwnerLocationIdempotent(
      currentJob.ownerID,
      getIndustryJobOutputInventoryLocationID(currentJob),
      getIndustryJobOutputInventoryFlagID(currentJob),
      grantEntries,
      {
        receiptKey: getIndustryOutputReceiptKey(currentJob),
        receiptMetadata: {
          domain: "industry",
          jobID: toInt(currentJob.jobID, 0),
          activityID: toInt(currentJob.activityID, 0),
        },
      },
    );
    if (!grantResult.success) {
      throwWrappedUserError("CustomNotify", {
        notify: "Failed to deliver the industry job outputs.",
      });
    }
  } else if (toInt(currentJob.activityID, 0) === INDUSTRY_ACTIVITY.INVENTION) {
    grantResult = deliverInventionJob(currentJob, session);
    if (!grantResult.success) {
      throwWrappedUserError("CustomNotify", {
        notify: "Failed to deliver the invention job outputs.",
      });
    }
    deliveredSuccessfulRuns = Math.max(
      0,
      toInt(grantResult.data && grantResult.data.successfulRuns, 0),
    );
  } else if (toInt(currentJob.activityID, 0) === INDUSTRY_ACTIVITY.COPYING) {
    const sourceBlueprintState = getBlueprintState(currentJob.blueprintID) || {};
    const copyEntries = buildCopyOutputBlueprintEntries(
      currentJob,
      getIndustryJobOutputInventoryLocationID(currentJob),
      getIndustryJobOutputInventoryFlagID(currentJob),
    );
    grantResult = grantItemsToOwnerLocationIdempotent(
      currentJob.ownerID,
      getIndustryJobOutputInventoryLocationID(currentJob),
      getIndustryJobOutputInventoryFlagID(currentJob),
      copyEntries.map((entry) => ({
        itemType: entry.itemType,
        quantity: entry.quantity,
        options: entry.options,
      })),
      {
        receiptKey: getIndustryOutputReceiptKey(currentJob),
        receiptMetadata: {
          domain: "industry",
          jobID: toInt(currentJob.jobID, 0),
          activityID: toInt(currentJob.activityID, 0),
        },
      },
    );
    if (!grantResult.success) {
      throwWrappedUserError("CustomNotify", {
        notify: "Failed to deliver the blueprint copies.",
      });
    }
    const copyStateResult = applyBlueprintStateToGrantedCopies(grantResult, {
      typeID: currentJob.blueprintTypeID,
      materialEfficiency: Math.max(0, toInt(sourceBlueprintState.materialEfficiency, 0)),
      timeEfficiency: Math.max(0, toInt(sourceBlueprintState.timeEfficiency, 0)),
      runsRemaining: currentJob.licensedRuns,
    });
    if (!copyStateResult.success) {
      throwWrappedUserError("CustomNotify", {
        notify: "Failed to initialize the delivered blueprint copies.",
      });
    }
  }

  const outputStateFlush = flushIndustryTableSync(
    INDUSTRY_BLUEPRINT_STATE_TABLE,
    "INDUSTRY_OUTPUT_BLUEPRINT_STATE_FLUSH_FAILED",
  );
  if (!outputStateFlush.success) {
    throwWrappedUserError("CustomNotify", {
      notify: "Failed to durably persist the delivered blueprint state.",
    });
  }

  const sourceResult = finishBlueprintAfterDelivery(currentJob, session);
  if (!sourceResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: "Failed to finish the industry source blueprint.",
    });
  }
  if (toInt(currentJob.activityID, 0) === INDUSTRY_ACTIVITY.INVENTION) {
    const sourceStateResult = persistInventionDeliveryState(currentJob, {
      phase: "sourceFinished",
      successfulRuns: deliveredSuccessfulRuns,
    });
    if (!sourceStateResult.success) {
      throwWrappedUserError("CustomNotify", {
        notify: "Failed to persist the invention delivery state.",
      });
    }
  }

  const jobsTable = ensureJobsTable();
  const storedJob = jobsTable.jobs[String(currentJob.jobID)];
  jobsTable.jobs[String(currentJob.jobID)] = {
    ...storedJob,
    status: INDUSTRY_STATUS.DELIVERED,
    completedCharacterID: toInt(session && session.characterID, 0),
    successfulRuns: deliveredSuccessfulRuns,
    deliveredAt: currentFileTime().toString(),
  };
  if (!persistJobsTable(jobsTable)) {
    throwWrappedUserError("CustomNotify", {
      notify: "Failed to persist the delivered industry job.",
    });
  }
  const jobFlush = flushIndustryTableSync(
    INDUSTRY_JOBS_TABLE,
    "INDUSTRY_BLUEPRINT_SETTLEMENT_JOB_FLUSH_FAILED",
  );
  if (!jobFlush.success) {
    throwWrappedUserError("CustomNotify", {
      notify: "Failed to durably persist the delivered industry job.",
    });
  }
  const deliveredJob = getJobByID(currentJob.jobID);
  try { require("../career/careerProgress").sync(toInt(currentJob.installerID, 0)); }
  catch (error) { log.warn(`[Career] delivered job awaits projection: ${error.message}`); }

  queueDurableIndustryJobReconciliation(currentJob.jobID);

  if (toInt(currentJob.activityID, 0) === INDUSTRY_ACTIVITY.INVENTION) {
    const clearedItems = clearInventionOutputMarkers(currentJob);
    if (grantResult.data && Array.isArray(grantResult.data.changes)) {
      grantResult.data.changes = grantResult.data.changes.map((change) => {
        const itemID = toInt(change && change.item && change.item.itemID, 0);
        return clearedItems.has(itemID)
          ? { ...change, item: clearedItems.get(itemID) }
          : change;
      });
    }
  }
  const deliveredChanges = (grantResult.data && grantResult.data.changes) || [];
  syncInventoryChanges(session, deliveredChanges);
  // The job's output can land in a corporation division, where it is the other
  // members -- not the deliverer -- who would otherwise never learn of it: the
  // client answers a hangar refresh and a hangar search from the snapshot it
  // took when the division was opened, so nothing they can do reveals a stack
  // the server never announced.
  fanCorporationOfficeInventoryChanges(deliveredChanges, {
    actorSession: session || null,
  });
  notifyBlueprintsUpdated(currentJob.ownerID);
  notifyIndustryJob(deliveredJob);

  // Credit the installer only after outputs and the delivered job state are
  // durable. Corporation-owned jobs deliberately remain character progress.
  if (toInt(currentJob.activityID, 0) === INDUSTRY_ACTIVITY.MANUFACTURING) {
    try {
      require(path.join(
        __dirname,
        "../achievement/achievementRuntime",
      )).recordManufacturing(
        toInt(currentJob.installerID, 0),
        buildProductOutput(definition, currentJob.runs, currentJob.activityID),
        toInt(currentJob.solarSystemID, 0),
        { eventKey: `industry:${toInt(currentJob.jobID, 0)}` },
      );
    } catch (achievementError) {
      log.debug(
        `[Industry] achievement manufacturing hook failed job=${currentJob.jobID}: ${achievementError.message}`,
      );
    }
  }

  return {
    success: true,
    data: getJobByID(currentJob.jobID),
  };
}

function deliverManufacturingJob(session, jobID) {
  return deliverIndustryJob(session, jobID);
}

function markIndustryJobReady(jobID) {
  const currentJob = getJobByID(jobID);
  if (!currentJob) {
    return {
      success: false,
      errorMsg: "JOB_NOT_FOUND",
    };
  }
  if (toInt(currentJob.status, 0) >= INDUSTRY_STATUS.COMPLETED) {
    return {
      success: true,
      data: currentJob,
    };
  }

  const jobsTable = ensureJobsTable();
  const updatedJob = {
    ...jobsTable.jobs[String(currentJob.jobID)],
    status: INDUSTRY_STATUS.READY,
    endDate: (currentFileTime() - 1n).toString(),
    pauseDate: null,
  };
  jobsTable.jobs[String(currentJob.jobID)] = updatedJob;
  if (!persistJobsTable(jobsTable)) {
    return {
      success: false,
      errorMsg: "WRITE_ERROR",
    };
  }

  queueDurableIndustryJobReconciliation(currentJob.jobID);
  notifyIndustryJob(updatedJob);

  return {
    success: true,
    data: getJobByID(currentJob.jobID),
  };
}

function cancelIndustryJob(session, jobID) {
  const currentJob = getJobByID(jobID);
  if (!currentJob) {
    // The client's own dialog for it (the install's IndustryJobNotFound).
    throwWrappedUserError("IndustryJobNotFound");
  }
  if (currentJob.starbaseTowerID && !starbaseIndustry.canAccessArray(session, { ownerID: currentJob.ownerID })) {
    throwWrappedUserError("CustomNotify", { notify: "You no longer belong to the corporation that owns this POS industry job." });
  }
  if (!isCharacterOwner(session, currentJob.ownerID) && !hasCorporationIndustryJobAccess(session, currentJob.ownerID)) {
    // The client's own dialog for it (the install's IndustryJobAccessDenied).
    throwWrappedUserError("IndustryJobAccessDenied");
  }

  const currentStatus = toInt(currentJob.status, INDUSTRY_STATUS.UNSUBMITTED);
  const resumingCancellation = currentStatus === INDUSTRY_STATUS.CANCELLED;
  if (
    !resumingCancellation &&
    currentStatus !== INDUSTRY_STATUS.INSTALLED &&
    currentStatus !== INDUSTRY_STATUS.PAUSED
  ) {
    throwWrappedUserError("CustomNotify", {
      notify: "That industry job can no longer be cancelled.",
    });
  }

  let cancelledJob = currentJob;
  if (!resumingCancellation) {
    const sourcePreflight = preflightIndustryBlueprintCancellation(currentJob);
    if (!sourcePreflight.success) {
      throwWrappedUserError("CustomNotify", {
        notify: "The industry source blueprint cannot be cancelled safely.",
      });
    }
    const jobsTable = ensureJobsTable();
    jobsTable.jobs[String(currentJob.jobID)] = {
      ...currentJob,
      status: INDUSTRY_STATUS.CANCELLED,
      completedCharacterID: toInt(session && session.characterID, 0),
      successfulRuns: 0,
      pauseDate: null,
      cancelledAt: currentFileTime().toString(),
    };
    if (!persistJobsTable(jobsTable)) {
      throwWrappedUserError("CustomNotify", {
        notify: "Failed to persist the cancelled industry job.",
      });
    }
    const flushResult = database.flushTableSync(INDUSTRY_JOBS_TABLE);
    if (!flushResult || flushResult.success !== true) {
      throwWrappedUserError("CustomNotify", {
        notify: "Failed to durably persist the cancelled industry job.",
      });
    }
    cancelledJob = normalizeIndustryJobRecord(
      jobsTable.jobs[String(currentJob.jobID)],
    );
  }

  queueDurableIndustryJobReconciliation(currentJob.jobID);
  const sourceResult = finishCancelledIndustryJobSource(cancelledJob, session);
  if (!sourceResult.success) {
    throwWrappedUserError("CustomNotify", {
      notify: "Failed to return the cancelled industry blueprint.",
    });
  }
  notifyBlueprintsUpdated(currentJob.ownerID);
  if (!resumingCancellation) {
    notifyIndustryJob(cancelledJob);
  }
  return {
    success: true,
    data: getJobByID(currentJob.jobID),
  };
}

function sessionCanAccessIndustryOwner(session, ownerID) {
  const numericOwnerID = toInt(ownerID, 0);
  return Boolean(
    numericOwnerID > 0 &&
    (
      isCharacterOwner(session, numericOwnerID) ||
      hasCorporationIndustryJobAccess(session, numericOwnerID)
    )
  );
}

function getJobCountsByInstaller(installerID) {
  const counts = {};
  for (const job of Object.values(ensureJobsTable().jobs || {})) {
    if (job && job.installationPending === true) {
      continue;
    }
    if (toInt(job && job.installerID, 0) !== toInt(installerID, 0)) {
      continue;
    }
    const status = getJobStatus(job);
    if (status >= INDUSTRY_STATUS.COMPLETED) {
      continue;
    }
    const activityID = toInt(job.activityID, 0);
    counts[activityID] = (counts[activityID] || 0) + 1;
  }
  return counts;
}

function resolveMonitorAvailableMaterials(session, request) {
  const blueprint = getBlueprintByItemID(request && request.blueprintID);
  const definition = getBlueprintDefinitionByTypeID(blueprint && blueprint.typeID);
  const activity = getIndustryActivity(definition, request && request.activityID);
  if (!blueprint || !definition || !activity) {
    return {};
  }

  const ownerID = toInt(blueprint.ownerID, 0);
  const facility = getFacilityPayloadByID(request && request.facilityID, session);
  const requireExactInputLocation =
    toInt(request && request.activityID, 0) === INDUSTRY_ACTIVITY.REACTION ||
    Boolean(starbaseIndustry.getAssemblyArray(request && request.facilityID) ||
      starbaseIndustry.getAssemblyArray(request && request.inputLocation && request.inputLocation.itemID) ||
      starbaseIndustry.getAssemblyArray(blueprint.facilityID));

  let inputLocation = null;
  if (facility) {
    inputLocation = normalizeLocationForFacility(
      facility,
      ownerID,
      request && request.inputLocation,
      blueprint,
      session,
      {
        requireTake: true,
        requireExactRequest: requireExactInputLocation,
        canonicalizeOwnerForExactLocation: requireExactInputLocation,
      },
    );
  }
  if (
    !inputLocation &&
    !requireExactInputLocation &&
    request &&
    request.inputLocation
  ) {
    inputLocation = {
      ...request.inputLocation,
      ownerID: toInt(request.inputLocation.ownerID || ownerID, ownerID),
    };
  }
  if (
    !inputLocation ||
    inputLocation.canTake === false ||
    toInt(inputLocation.flagID, 0) === ITEM_FLAG_CORP_DELIVERIES
  ) {
    return {};
  }

  return resolveAvailableMaterials(ownerID, inputLocation);
}

function connectMonitor(session, requestInput) {
  const request =
    requestInput && requestInput.rawRequest
      ? requestInput
      : parseIndustryRequest(requestInput);
  const runtimeTable = ensureRuntimeTable();
  const monitorID = Math.max(MONITOR_ID_START, toInt(runtimeTable._meta.nextMonitorID, MONITOR_ID_START));
  runtimeTable._meta.nextMonitorID = monitorID + 1;
  runtimeTable.monitors[String(monitorID)] = {
    monitorID,
    activityID: toInt(request.activityID, 0),
    blueprintID: toInt(request.blueprintID, 0),
    createdAt: Date.now(),
  };
  persistRuntimeTable(runtimeTable);
  const availableMaterials = resolveMonitorAvailableMaterials(session, request);
  // The session is told what the place has from here on, when that changes
  // (OnIndustryMaterials, industryMonitorNotices.js).
  if (session) {
    watchMonitor(
      session,
      monitorID,
      availableMaterials,
      () => resolveMonitorAvailableMaterials(session, request),
    );
  }
  return {
    success: true,
    data: {
      monitorID,
      availableMaterials,
    },
  };
}

function disconnectMonitor(monitorID, session = null) {
  const runtimeTable = ensureRuntimeTable();
  delete runtimeTable.monitors[String(toInt(monitorID, 0))];
  persistRuntimeTable(runtimeTable);
  if (session) {
    forgetMonitor(session, toInt(monitorID, 0));
  }
  return {
    success: true,
  };
}

function seedBlueprintForOwner(ownerID, locationID, options = {}) {
  const blueprintTypeID = toInt(options.blueprintTypeID, 0);
  const isOriginal = options.original !== false;
  const corporationOwned = options.isCorporation === true || options.ownerMode === "corp";
  const flagID = toInt(
    options.flagID,
    corporationOwned ? ITEM_FLAG_CORP_HANGAR_1 : ITEM_FLAGS.HANGAR,
  );
  const createResult =
    !corporationOwned
      ? grantItemsToCharacterLocation(
          ownerID,
          locationID,
          flagID,
          [{
            itemType: blueprintTypeID,
            quantity: 1,
            options: {
              singleton: isOriginal ? 1 : 2,
              itemName: options.itemName || null,
            },
          }],
        )
      : grantItemsToOwnerLocation(
          ownerID,
          locationID,
          flagID,
          [{
            itemType: blueprintTypeID,
            quantity: 1,
            options: {
              singleton: isOriginal ? 1 : 2,
              itemName: options.itemName || null,
            },
          }],
        );
  if (!createResult.success) {
    return createResult;
  }
  const blueprintItem = createResult.data.items[0];
  const stateResult = initializeBlueprintState(blueprintItem.itemID, {
    typeID: blueprintTypeID,
    materialEfficiency: toInt(options.materialEfficiency, 0),
    timeEfficiency: toInt(options.timeEfficiency, 0),
    original: isOriginal,
    runsRemaining: isOriginal ? -1 : Math.max(1, toInt(options.runsRemaining, 1)),
    jobID: null,
  });
  return {
    success: stateResult.success,
    data: {
      item: blueprintItem,
      state: stateResult.data,
      changes: createResult.data.changes || [],
    },
    errorMsg: stateResult.errorMsg || null,
  };
}

module.exports = {
  createCrewIndustryActor,
  prepareCrewManufacturingIntent,
  acknowledgeCrewManufacturingJob,
  DURABLE_READY_JOB_TYPE,
  bindDurableScheduler,
  buildDurableIndustryJob,
  buildDurableIndustryJobID,
  buildIndustryInstallRequestFingerprint,
  buildIndustryJobsOverLast24HoursRows,
  buildManufacturingMaterials,
  cancelIndustryJob,
  cancelIndustryJobsForStructure,
  cancelIndustryJobsForStructureServices,
  connectMonitor,
  deliverIndustryJob,
  deliverManufacturingJob,
  disconnectMonitor,
  getBlueprintByItemID,
  getBlueprintState,
  getJobByID,
  hasUnfinishedIndustryJobsAtFacility,
  hasPendingIndustryInstallAtFacility,
  recoverCommittedAssemblyDeliveries,
  getJobCountsByInstaller,
  handleDurableIndustryJobReady,
  installIndustryJob,
  installManufacturingJob,
  listIndustryJobsOverLast24Hours,
  listBlueprintInstancesByOwner,
  listFacilitiesForSession,
  listJobsByOwner,
  markIndustryJobReady,
  migrateIndustryInstalledLocationSchema,
  repairOfficeFiledCorpDeliveries,
  quoteIndustryJob,
  quoteManufacturingJob,
  queueDurableIndustryJobReconciliation,
  pauseIndustryJobsForStructureServices,
  persistPreparedIndustryInstall,
  finalizePreparedIndustryInstall,
  publishPreparedIndustryInstall,
  removeBlueprintState,
  reconcileDurableIndustryJobs,
  reconcileIndustrySourceSettlements,
  resumeIndustryJobsForStructureServices,
  resolveActivityUnroundedBaseCost,
  resolveAvailableMaterials,
  resolveFacilityLocations,
  sessionCanAccessIndustryOwner,
  seedBlueprintForOwner,
  initializeBlueprintState,
  updateBlueprintState,
  unbindDurableScheduler,
};
