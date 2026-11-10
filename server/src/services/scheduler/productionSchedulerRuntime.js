"use strict";

const path = require("node:path");
const billRuntime = require(path.join(
  __dirname,
  "../account/billRuntimeState",
));
const essRuntime = require("../dynamic/essSettlementRuntime");
const freelanceRuntime = require("../freelance/freelanceRuntime");
const contractAuctionJobs = require("../contracts/contractAuctionJobs");
const bountyRuntime = require(path.join(__dirname, "../bounty/bountyRuntime"));
const playerBountyState = require(path.join(
  __dirname,
  "../bounty/playerBountyState",
));
const killRightState = require(path.join(
  __dirname,
  "../bounty/killRightState",
));
const warNegotiationRuntime = require(path.join(
  __dirname,
  "../corporation/warNegotiationRuntimeState",
));
const dailyGoalsRuntime = require(path.join(
  __dirname,
  "../dailyGoals/dailyGoalsState",
));
const contrabandPenaltyRuntime = require(path.join(
  __dirname,
  "../security/contrabandPenaltyState",
));
const customsInspectionRuntime = require("../security/customsInspectionRuntime");
const skyhookRaidRuntime = require("../sovereignty/skyhookRaidRuntime");
const sovHubFuelRuntime = require("../sovereignty/sovHubFuelRuntime");
const selfDestructRuntime = require("../ship/selfDestructRuntime");
const shipSkinComponentRuntime = require("../ship/shipSkinComponentRuntime");
const characterResculpt = require("../character/characterResculpt");
const loginCampaignRedemption = require("../campaign/loginCampaignRedemption");
const licenseLifecycleRuntime = require("../newEdenStore/licenseLifecycleRuntime");
const shipSkinSequencingRuntime = require("../ship/shipSkinSequencingRuntime");
const shipSkinMarketRuntime = require("../ship/shipSkinThirdPartyRuntime");
const breacherPodDeathRuntime = require("../ship/breacherPodDeathRuntime");
const structureSelfDestructRuntime = require("../structure/structureSelfDestructRuntime");
const assetSafetyRuntime = require("../structure/structureAssetSafetyScheduler");
const homeCloneSelfDestructRuntime = require("../character/homeStationSelfDestructRuntime");
const nodeGraphRuntime = require("../nodegraph/nodeGraphRuntime");
const airEncounterJobs = require("../npe/airEncounterJobs");
const reprocessingSettlementRuntime = require(path.join(
  __dirname,
  "../reprocessing/reprocessingSettlementState",
));
const missionRewardSettlementRuntime = require(path.join(
  __dirname,
  "../agent/missionRewardSettlementJobs",
));
const planetaryCustomsSettlementRuntime = require(path.join(
  __dirname,
  "../planet/planetaryCustomsSettlementState",
));
const evermarkPurchaseRuntime = require(path.join(
  __dirname,
  "../evermarks/evermarkPurchaseState",
));
const lpStorePurchaseRuntime = require(path.join(
  __dirname,
  "../evermarks/lpStorePurchaseState",
));
const corporationLiquidationRuntime = require(path.join(
  __dirname,
  "../corporation/corporationLiquidationState",
));
const corporationDividendRuntime = require(path.join(
  __dirname,
  "../corporation/corporationDividendState",
));
const corporationFoundingRuntime = require(path.join(
  __dirname,
  "../corporation/corporationFoundingState",
));
const allianceFoundingRuntime = require(path.join(
  __dirname,
  "../corporation/allianceFoundingState",
));
const corporationMemberActionRuntime = require(path.join(
  __dirname,
  "../corporation/corpMemberActionState",
));
const allianceApplicationRuntime = require(path.join(
  __dirname,
  "../corporation/allianceApplicationState",
));
const allianceDepartureRuntime = require(path.join(
  __dirname,
  "../corporation/allianceDepartureState",
));
const allianceGovernanceState = require(path.join(
  __dirname,
  "../corporation/allianceGovernanceState",
));
const sovereigntyCaptureState = require(path.join(
  __dirname,
  "../sovereignty/sovCaptureState",
));
const sovereigntyCampaignState = require(path.join(
  __dirname,
  "../sovereignty/sovCampaignState",
));
const officeImpoundReleaseState = require(path.join(
  __dirname,
  "../corporation/officeImpoundReleaseState",
));
const officeRentalSettlementState = require(path.join(
  __dirname,
  "../corporation/officeRentalSettlementState",
));
const industryRuntime = require(path.join(
  __dirname,
  "../industry/industryRuntimeState",
));
const industryInstallSettlementRuntime = require(path.join(
  __dirname,
  "../industry/industryInstallSettlementState",
));
const contractSettlementRuntime = require(path.join(
  __dirname,
  "../contracts/contractSettlementJobs",
));
const newEdenStorePurchaseSettlementRuntime = require(path.join(
  __dirname,
  "../newEdenStore/storePurchaseSettlementState",
));
const marketRuntime = require(path.join(
  __dirname,
  "../market/marketProxyService",
));
const skillQueueRuntime = require(path.join(
  __dirname,
  "../skills/training/skillQueueRuntime",
));
const expertSystemRuntime = require(path.join(
  __dirname,
  "../skills/expertSystems/expertSystemExpiryScheduler",
));
const raffleRuntime = require(path.join(
  __dirname,
  "../raffles/raffleRuntimeSingleton",
));
const calendarRuntime = require(path.join(
  __dirname,
  "../calendar/calendarSchedulerRuntime",
));
const globalSiteRuntime = require(path.join(
  __dirname,
  "../dungeon/globalSiteSchedulerRuntime",
));
const insuranceRuntime = require(path.join(
  __dirname,
  "../insurance/insuranceRuntime",
));
const repairRuntime = require(path.join(
  __dirname,
  "../station/repairRuntime",
));
const jumpCloneRuntime = require(path.join(
  __dirname,
  "../station/jumpCloneRuntime",
));
const structureJumpBridgeRuntime = require(path.join(
  __dirname,
  "../structure/structureJumpBridgeMgrService",
));
const starbaseFuelRuntime = require(path.join(
  __dirname,
  "../starbase/starbaseFuelRuntime",
));
const { createNpcBountyPayoutHandler } = require(path.join(
  __dirname,
  "../bounty/npcBountySchedulerRuntime",
));
const { createDurableScheduler } = require(path.join(
  __dirname,
  "durableScheduler",
));
const {
  createAuthorityReceiptScan,
} = require(path.join(__dirname, "../_shared/settlementSequenceWatermark"));
const log = require(path.join(__dirname, "../../utils/logger"));

// Runs a synchronous reconciler as one entry of Promise.all. A throw becomes a
// rejected entry instead of escaping while the list is still being built, which
// would leave every reconciler already started without a rejection handler.
function runReconciler(reconcile) {
  try {
    return Promise.resolve(reconcile());
  } catch (error) {
    return Promise.reject(error);
  }
}

function createProductionSchedulerRuntime(options = {}) {
  const scheduler = options.scheduler || createDurableScheduler(
    options.schedulerOptions,
  );
  const billOwner = options.billRuntime || billRuntime;
  const essOwner = options.essRuntime || essRuntime;
  const freelanceOwner = options.freelanceRuntime || freelanceRuntime;
  const auctionOwner = options.contractAuctionJobs || contractAuctionJobs;
  const bountyOwner = options.bountyRuntime || bountyRuntime;
  const playerBountyOwner = options.playerBountyState || playerBountyState;
  const killRightOwner = options.killRightState || killRightState;
  const warNegotiationOwner =
    options.warNegotiationRuntime || warNegotiationRuntime;
  const dailyGoalsOwner = options.dailyGoalsRuntime || dailyGoalsRuntime;
  const contrabandPenaltyOwner =
    options.contrabandPenaltyRuntime || contrabandPenaltyRuntime;
  const customsInspectionOwner = options.customsInspectionRuntime || customsInspectionRuntime;
  const skyhookRaidOwner = options.skyhookRaidRuntime || skyhookRaidRuntime;
  const sovHubFuelOwner = options.sovHubFuelRuntime || sovHubFuelRuntime;
  const selfDestructOwner = options.selfDestructRuntime || selfDestructRuntime;
  const skinComponentOwner = options.shipSkinComponentRuntime || shipSkinComponentRuntime;
  const resculptOwner = options.characterResculpt || characterResculpt;
  const campaignRedemptionOwner = options.loginCampaignRedemption || loginCampaignRedemption;
  const licenseLifecycleOwner = options.licenseLifecycleRuntime || licenseLifecycleRuntime;
  const skinSequencingOwner = options.shipSkinSequencingRuntime || shipSkinSequencingRuntime;
  const skinMarketOwner = options.shipSkinMarketRuntime || shipSkinMarketRuntime;
  const breacherDeathOwner = options.breacherPodDeathRuntime || breacherPodDeathRuntime;
  const structureSelfDestructOwner = options.structureSelfDestructRuntime || structureSelfDestructRuntime;
  const assetSafetyOwner = options.assetSafetyRuntime || assetSafetyRuntime;
  const homeCloneSelfDestructOwner = options.homeCloneSelfDestructRuntime || homeCloneSelfDestructRuntime;
  const nodeGraphOwner = options.nodeGraphRuntime || nodeGraphRuntime;
  const airEncounterOwner = options.airEncounterJobs || airEncounterJobs;
  const reprocessingSettlementOwner =
    options.reprocessingSettlementRuntime || reprocessingSettlementRuntime;
  const missionRewardSettlementOwner =
    options.missionRewardSettlementRuntime || missionRewardSettlementRuntime;
  const planetaryCustomsSettlementOwner =
    options.planetaryCustomsSettlementRuntime || planetaryCustomsSettlementRuntime;
  const evermarkPurchaseOwner =
    options.evermarkPurchaseRuntime || evermarkPurchaseRuntime;
  const lpStorePurchaseOwner =
    options.lpStorePurchaseRuntime || lpStorePurchaseRuntime;
  const corporationLiquidationOwner =
    options.corporationLiquidationRuntime || corporationLiquidationRuntime;
  const corporationDividendOwner =
    options.corporationDividendRuntime || corporationDividendRuntime;
  const corporationFoundingOwner =
    options.corporationFoundingRuntime || corporationFoundingRuntime;
  const allianceFoundingOwner =
    options.allianceFoundingRuntime || allianceFoundingRuntime;
  const corporationMemberActionOwner =
    options.corporationMemberActionRuntime || corporationMemberActionRuntime;
  const allianceApplicationOwner =
    options.allianceApplicationRuntime || allianceApplicationRuntime;
  const allianceDepartureOwner =
    options.allianceDepartureRuntime || allianceDepartureRuntime;
  const allianceGovernanceOwner =
    options.allianceGovernanceState || allianceGovernanceState;
  const sovereigntyCaptureOwner =
    options.sovereigntyCaptureState || sovereigntyCaptureState;
  const sovereigntyCampaignOwner =
    options.sovereigntyCampaignState || sovereigntyCampaignState;
  const officeImpoundOwner =
    options.officeImpoundReleaseState || officeImpoundReleaseState;
  const officeRentalOwner =
    options.officeRentalSettlementState || officeRentalSettlementState;
  const industryInstallSettlementOwner =
    options.industryInstallSettlementRuntime || industryInstallSettlementRuntime;
  const contractSettlementOwner =
    options.contractSettlementRuntime || contractSettlementRuntime;
  const newEdenStorePurchaseSettlementOwner =
    options.newEdenStorePurchaseSettlementRuntime ||
    newEdenStorePurchaseSettlementRuntime;
  const industryOwner = options.industryRuntime || industryRuntime;
  const marketOwner = options.marketRuntime || marketRuntime;
  const skillOwner = options.skillQueueRuntime || skillQueueRuntime;
  const expertSystemOwner = options.expertSystemRuntime || expertSystemRuntime;
  const raffleOwner = options.raffleRuntime || raffleRuntime;
  const calendarOwner = options.calendarRuntime || calendarRuntime;
  const eventOwner = options.eventRuntime || require("../seasons/eventLifecycle");
  const globalSiteOwner = options.globalSiteRuntime || globalSiteRuntime;
  const insuranceOwner = options.insuranceRuntime || insuranceRuntime;
  const repairOwner = options.repairRuntime || repairRuntime;
  const jumpCloneOwner = options.jumpCloneRuntime || jumpCloneRuntime;
  const jumpBridgeOwner =
    options.structureJumpBridgeRuntime || structureJumpBridgeRuntime;
  const starbaseFuelOwner = options.starbaseFuelRuntime || starbaseFuelRuntime;
  const unregisterHandlers = [];
  let state = "idle";
  let startPromise = null;
  let shutdownPromise = null;
  let startResult = null;

  function unregisterAllHandlers() {
    while (unregisterHandlers.length > 0) {
      const unregister = unregisterHandlers.pop();
      unregister();
    }
  }

  function unbindOwners() {
    nodeGraphOwner.unbindDurableScheduler(scheduler);
    airEncounterOwner.unbindDurableScheduler(scheduler);
    billOwner.unbindDurableScheduler(scheduler);
    bountyOwner.detachDurableScheduler(scheduler);
    essOwner.unbindDurableScheduler(scheduler);
    freelanceOwner.unbindDurableScheduler(scheduler);
    auctionOwner.unbindDurableScheduler(scheduler);
    playerBountyOwner.unbindDurableScheduler(scheduler);
    killRightOwner.unbindDurableScheduler(scheduler);
    warNegotiationOwner.unbindDurableScheduler(scheduler);
    dailyGoalsOwner.unbindDurableScheduler(scheduler);
    contrabandPenaltyOwner.unbindDurableScheduler(scheduler);
    customsInspectionOwner.unbindDurableScheduler(scheduler);
    skyhookRaidOwner.unbindDurableScheduler(scheduler);
    sovHubFuelOwner.unbindDurableScheduler(scheduler);
    selfDestructOwner.unbindDurableScheduler(scheduler);
    skinComponentOwner.unbindDurableScheduler(scheduler);
    resculptOwner.unbindDurableScheduler(scheduler);
    campaignRedemptionOwner.unbindDurableScheduler(scheduler);
    licenseLifecycleOwner.unbindDurableScheduler(scheduler);
    skinSequencingOwner.unbindDurableScheduler(scheduler);
    skinMarketOwner.unbindDurableScheduler(scheduler);
    breacherDeathOwner.unbindDurableScheduler(scheduler);
    structureSelfDestructOwner.unbindDurableScheduler(scheduler);
    assetSafetyOwner.unbindDurableScheduler(scheduler);
    homeCloneSelfDestructOwner.unbindDurableScheduler(scheduler);
    reprocessingSettlementOwner.unbindDurableScheduler(scheduler);
    missionRewardSettlementOwner.unbindDurableScheduler(scheduler);
    planetaryCustomsSettlementOwner.unbindDurableScheduler(scheduler);
    evermarkPurchaseOwner.unbindDurableScheduler(scheduler);
    lpStorePurchaseOwner.unbindDurableScheduler(scheduler);
    corporationLiquidationOwner.unbindDurableScheduler(scheduler);
    corporationDividendOwner.unbindDurableScheduler(scheduler);
    corporationFoundingOwner.unbindDurableScheduler(scheduler);
    allianceFoundingOwner.unbindDurableScheduler(scheduler);
    corporationMemberActionOwner.unbindDurableScheduler(scheduler);
    allianceApplicationOwner.unbindDurableScheduler(scheduler);
    allianceDepartureOwner.unbindDurableScheduler(scheduler);
    sovereigntyCampaignOwner.unbindDurableScheduler(scheduler);
    officeImpoundOwner.unbindDurableScheduler(scheduler);
    officeRentalOwner.unbindDurableScheduler(scheduler);
    industryInstallSettlementOwner.unbindDurableScheduler(scheduler);
    contractSettlementOwner.unbindDurableScheduler(scheduler);
    newEdenStorePurchaseSettlementOwner.unbindDurableScheduler(scheduler);
    industryOwner.unbindDurableScheduler(scheduler);
    marketOwner.unbindDurableScheduler(scheduler);
    skillOwner.unbindDurableScheduler(scheduler);
    expertSystemOwner.unbindDurableScheduler(scheduler);
    raffleOwner.unbindDurableScheduler(scheduler);
    calendarOwner.unbindDurableScheduler(scheduler);
    eventOwner.unbindDurableScheduler(scheduler);
    globalSiteOwner.unbindDurableScheduler(scheduler);
    insuranceOwner.unbindDurableScheduler(scheduler);
    repairOwner.unbindDurableScheduler(scheduler);
    jumpCloneOwner.unbindDurableScheduler(scheduler);
    jumpBridgeOwner.unbindDurableScheduler(scheduler);
  }

  function start() {
    if (state === "started") {
      return Promise.resolve(startResult);
    }
    if (startPromise) {
      return startPromise;
    }
    if (state === "closing" || state === "closed") {
      return Promise.reject(new Error("production scheduler is shutting down"));
    }

    state = "starting";
    startPromise = (async () => {
      try {
        unregisterHandlers.push(scheduler.register(essOwner.JOB_TYPE, job => essOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(freelanceOwner.JOB_TYPE, job => freelanceOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(auctionOwner.JOB_TYPE, job => auctionOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(nodeGraphOwner.JOB_TYPE, (job) => nodeGraphOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(airEncounterOwner.JOB_TYPE, job => airEncounterOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(skinComponentOwner.JOB_TYPE, job => skinComponentOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(resculptOwner.JOB_TYPE, job => resculptOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(campaignRedemptionOwner.JOB_TYPE, job => campaignRedemptionOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(licenseLifecycleOwner.JOB_TYPE, job => licenseLifecycleOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(skinSequencingOwner.JOB_TYPE, job => skinSequencingOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(skinMarketOwner.JOB_TYPE, job => skinMarketOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(
          billOwner.DURABLE_DUE_JOB_TYPE,
          (job) => billOwner.handleDurableBillDue(job),
        ));
        unregisterHandlers.push(scheduler.register(
          bountyOwner.DURABLE_PAYOUT_JOB_TYPE,
          createNpcBountyPayoutHandler(bountyOwner),
        ));
        unregisterHandlers.push(scheduler.register(
          playerBountyOwner.DURABLE_PAYOUT_JOB_TYPE,
          (job) => playerBountyOwner.handleDurablePayout(job),
        ));
        unregisterHandlers.push(scheduler.register(
          killRightOwner.DURABLE_PURCHASE_JOB_TYPE,
          (job) => killRightOwner.handleDurableKillRightPurchase(job),
        ));
        unregisterHandlers.push(scheduler.register(
          warNegotiationOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            warNegotiationOwner.handleDurableWarNegotiationSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          dailyGoalsOwner.DURABLE_REWARD_JOB_TYPE,
          (job) => dailyGoalsOwner.handleDurableRewardSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          contrabandPenaltyOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => contrabandPenaltyOwner.handleDurableContrabandPenalty(job),
        ));
        unregisterHandlers.push(scheduler.register(
          customsInspectionOwner.DURABLE_CASE_JOB_TYPE,
          (job) => customsInspectionOwner.handleDurableCase(job),
        ));
        unregisterHandlers.push(scheduler.register(
          skyhookRaidOwner.DURABLE_RAID_JOB_TYPE,
          (job) => skyhookRaidOwner.handleDurableRaid(job),
        ));
        unregisterHandlers.push(scheduler.register(
          sovHubFuelOwner.DURABLE_FUEL_JOB_TYPE,
          (job) => sovHubFuelOwner.handleDurableFuel(job),
        ));
        unregisterHandlers.push(scheduler.register(
          selfDestructOwner.DURABLE_SELF_DESTRUCT_JOB_TYPE,
          (job) => selfDestructOwner.handleDurableSelfDestruct(job),
        ));
        unregisterHandlers.push(scheduler.register(breacherDeathOwner.JOB_TYPE, (job) => breacherDeathOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(assetSafetyOwner.JOB_TYPE, job => assetSafetyOwner.handleJob(job)));
        unregisterHandlers.push(scheduler.register(
          structureSelfDestructOwner.DURABLE_SELF_DESTRUCT_JOB_TYPE,
          (job) => structureSelfDestructOwner.handleDurableSelfDestruct(job),
        ));
        unregisterHandlers.push(scheduler.register(
          homeCloneSelfDestructOwner.DURABLE_SELF_DESTRUCT_JOB_TYPE,
          (job) => homeCloneSelfDestructOwner.handleDurableSelfDestruct(job),
        ));
        unregisterHandlers.push(scheduler.register(
          reprocessingSettlementOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            reprocessingSettlementOwner.handleDurableReprocessingSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          missionRewardSettlementOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            missionRewardSettlementOwner.handleDurableMissionRewardSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          planetaryCustomsSettlementOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            planetaryCustomsSettlementOwner.handleDurablePlanetaryCustomsSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          evermarkPurchaseOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => evermarkPurchaseOwner.handleDurableEvermarkPurchase(job),
        ));
        unregisterHandlers.push(scheduler.register(
          lpStorePurchaseOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => lpStorePurchaseOwner.handleDurableLpStorePurchase(job),
        ));
        unregisterHandlers.push(scheduler.register(
          corporationLiquidationOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            corporationLiquidationOwner.handleDurableCorporationLiquidation(job),
        ));
        unregisterHandlers.push(scheduler.register(
          corporationDividendOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => corporationDividendOwner.handleDurableCorporationDividend(job),
        ));
        unregisterHandlers.push(scheduler.register(
          corporationFoundingOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => corporationFoundingOwner.handleDurableCorporationFounding(job),
        ));
        unregisterHandlers.push(scheduler.register(
          allianceFoundingOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => allianceFoundingOwner.handleDurableAllianceFounding(job),
        ));
        unregisterHandlers.push(scheduler.register(
          corporationMemberActionOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            corporationMemberActionOwner.handleDurableCorporationMemberAction(job),
        ));
        unregisterHandlers.push(scheduler.register(
          allianceApplicationOwner.DURABLE_EFFECTIVE_JOB_TYPE,
          (job) =>
            allianceApplicationOwner.handleDurableAllianceApplicationEffective(job),
        ));
        unregisterHandlers.push(scheduler.register(
          allianceDepartureOwner.DURABLE_DEPARTURE_JOB_TYPE,
          (job) => allianceDepartureOwner.handleDurableAllianceDeparture(job),
        ));
        unregisterHandlers.push(scheduler.register(
          allianceDepartureOwner.DURABLE_CLOSURE_JOB_TYPE,
          (job) => allianceDepartureOwner.handleDurableAllianceClosure(job),
        ));
        unregisterHandlers.push(scheduler.register(
          sovereigntyCampaignOwner.DURABLE_CAMPAIGN_TICK_JOB_TYPE,
          async (job) => {
            const result = await sovereigntyCampaignOwner
              .handleDurableSovereigntyCampaignTick(job);
            if (result && result.success === false) {
              const error = new Error(
                result.errorMsg || "SOVEREIGNTY_CAMPAIGN_TICK_FAILED",
              );
              error.code = result.errorMsg || "SOVEREIGNTY_CAMPAIGN_TICK_FAILED";
              throw error;
            }
            return result;
          },
        ));
        unregisterHandlers.push(scheduler.register(
          officeImpoundOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => officeImpoundOwner.handleDurableImpoundRelease(job),
        ));
        unregisterHandlers.push(scheduler.register(
          officeRentalOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => officeRentalOwner.handleDurableOfficeRental(job),
        ));
        unregisterHandlers.push(scheduler.register(
          industryInstallSettlementOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            industryInstallSettlementOwner.handleDurableIndustryInstallSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          contractSettlementOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => contractSettlementOwner.handleDurableContractSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          newEdenStorePurchaseSettlementOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) =>
            newEdenStorePurchaseSettlementOwner.handleDurableStorePurchaseSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          industryOwner.DURABLE_READY_JOB_TYPE,
          (job) => industryOwner.handleDurableIndustryJobReady(job),
        ));
        unregisterHandlers.push(scheduler.register(
          marketOwner.DURABLE_EXPIRY_JOB_TYPE,
          (job) => marketOwner.handleDurableMarketOrderExpiry(job),
        ));
        unregisterHandlers.push(scheduler.register(
          marketOwner.DURABLE_FILL_RECOVERY_JOB_TYPE,
          (job) => marketOwner.handleDurableMarketFillRecovery(job),
        ));
        unregisterHandlers.push(scheduler.register(
          skillOwner.DURABLE_COMPLETION_JOB_TYPE,
          (job) => skillOwner.handleDurableQueueCompletion(job),
        ));
        unregisterHandlers.push(scheduler.register(
          expertSystemOwner.DURABLE_EXPIRY_JOB_TYPE,
          (job) => expertSystemOwner.handleDurableExpertSystemExpiry(job),
        ));
        unregisterHandlers.push(scheduler.register(
          raffleOwner.DURABLE_EXPIRY_JOB_TYPE,
          (job) => raffleOwner.handleDurableRaffleExpiry(job),
        ));
        unregisterHandlers.push(scheduler.register(
          raffleOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => raffleOwner.handleDurableRaffleSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          eventOwner.JOB_TYPE,
          (job) => eventOwner.handleDurableEventDeadline(job),
        ));
        unregisterHandlers.push(scheduler.register(
          calendarOwner.DURABLE_MAINTENANCE_JOB_TYPE,
          (job) => calendarOwner.handleDurableCalendarMaintenance(job),
        ));
        unregisterHandlers.push(scheduler.register(
          globalSiteOwner.DURABLE_LIFECYCLE_JOB_TYPE,
          (job) => globalSiteOwner.handleDurableGlobalSiteLifecycle(job),
        ));
        unregisterHandlers.push(scheduler.register(
          insuranceOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => insuranceOwner.handleDurableInsuranceSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          repairOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => repairOwner.handleDurableRepairSettlement(job),
        ));
        unregisterHandlers.push(scheduler.register(
          jumpCloneOwner.DURABLE_INSTALL_JOB_TYPE,
          (job) => jumpCloneOwner.handleDurableCloneInstall(job),
        ));
        unregisterHandlers.push(scheduler.register(
          jumpCloneOwner.DURABLE_ACTIVATION_JOB_TYPE,
          (job) => jumpCloneOwner.handleDurableCloneActivation(job),
        ));
        unregisterHandlers.push(scheduler.register(
          jumpBridgeOwner.DURABLE_SETTLEMENT_JOB_TYPE,
          (job) => jumpBridgeOwner.handleDurableJumpBridgeSettlement(job),
        ));

        billOwner.bindDurableScheduler(scheduler);
        essOwner.bindDurableScheduler(scheduler);
        freelanceOwner.bindDurableScheduler(scheduler);
        auctionOwner.bindDurableScheduler(scheduler);
        nodeGraphOwner.bindDurableScheduler(scheduler);
        airEncounterOwner.bindDurableScheduler(scheduler);
        bountyOwner.bindDurableScheduler(scheduler);
        playerBountyOwner.bindDurableScheduler(scheduler);
        killRightOwner.bindDurableScheduler(scheduler);
        warNegotiationOwner.bindDurableScheduler(scheduler);
        dailyGoalsOwner.bindDurableScheduler(scheduler);
        contrabandPenaltyOwner.bindDurableScheduler(scheduler);
        customsInspectionOwner.bindDurableScheduler(scheduler);
        skyhookRaidOwner.bindDurableScheduler(scheduler);
        sovHubFuelOwner.bindDurableScheduler(scheduler);
        selfDestructOwner.bindDurableScheduler(scheduler);
        skinComponentOwner.bindDurableScheduler(scheduler);
        resculptOwner.bindDurableScheduler(scheduler);
        campaignRedemptionOwner.bindDurableScheduler(scheduler);
        licenseLifecycleOwner.bindDurableScheduler(scheduler);
        skinSequencingOwner.bindDurableScheduler(scheduler);
        skinMarketOwner.bindDurableScheduler(scheduler);
        breacherDeathOwner.bindDurableScheduler(scheduler);
        structureSelfDestructOwner.bindDurableScheduler(scheduler);
        assetSafetyOwner.bindDurableScheduler(scheduler);
        homeCloneSelfDestructOwner.bindDurableScheduler(scheduler);
        reprocessingSettlementOwner.bindDurableScheduler(scheduler);
        missionRewardSettlementOwner.bindDurableScheduler(scheduler);
        planetaryCustomsSettlementOwner.bindDurableScheduler(scheduler);
        evermarkPurchaseOwner.bindDurableScheduler(scheduler);
        lpStorePurchaseOwner.bindDurableScheduler(scheduler);
        corporationLiquidationOwner.bindDurableScheduler(scheduler);
        corporationDividendOwner.bindDurableScheduler(scheduler);
        corporationFoundingOwner.bindDurableScheduler(scheduler);
        allianceFoundingOwner.bindDurableScheduler(scheduler);
        corporationMemberActionOwner.bindDurableScheduler(scheduler);
        allianceApplicationOwner.bindDurableScheduler(scheduler);
        allianceDepartureOwner.bindDurableScheduler(scheduler);
        sovereigntyCampaignOwner.bindDurableScheduler(scheduler);
        officeImpoundOwner.bindDurableScheduler(scheduler);
        officeRentalOwner.bindDurableScheduler(scheduler);
        industryInstallSettlementOwner.bindDurableScheduler(scheduler);
        contractSettlementOwner.bindDurableScheduler(scheduler);
        newEdenStorePurchaseSettlementOwner.bindDurableScheduler(scheduler);
        industryOwner.bindDurableScheduler(scheduler);
        marketOwner.bindDurableScheduler(scheduler);
        skillOwner.bindDurableScheduler(scheduler);
        expertSystemOwner.bindDurableScheduler(scheduler);
        raffleOwner.bindDurableScheduler(scheduler);
        calendarOwner.bindDurableScheduler(scheduler);
        eventOwner.bindDurableScheduler(scheduler);
        globalSiteOwner.bindDurableScheduler(scheduler);
        insuranceOwner.bindDurableScheduler(scheduler);
        repairOwner.bindDurableScheduler(scheduler);
        jumpCloneOwner.bindDurableScheduler(scheduler);
        jumpBridgeOwner.bindDurableScheduler(scheduler);
        await Promise.resolve(
          industryOwner.migrateIndustryInstalledLocationSchema(),
        );
        await Promise.resolve(
          industryOwner.repairOfficeFiledCorpDeliveries(),
        );
        // Register scoped AIR atoms before inspecting saved graph coverage.
        // A cold boot must not fence a mining graph before its pilot logs in.
        if (nodeGraphOwner === nodeGraphRuntime) require("../npe/airNpeRuntime");
        const miningCargoRecovery = (options.miningCargoCommits || require("../mining/miningCargoCommits")).reconcile();
        if (!miningCargoRecovery.success) throw new Error(`Mining cargo recovery refused: ${miningCargoRecovery.errorMsg}`);
        await scheduler.start();
        await airEncounterOwner.reconcile();
        await skinComponentOwner.reconcile();
        await resculptOwner.reconcile();
        await campaignRedemptionOwner.reconcile();
        await licenseLifecycleOwner.reconcile();
        await skinSequencingOwner.reconcile();
        await skinMarketOwner.reconcile();
        await essOwner.reconcile();
        await freelanceOwner.reconcile();
        await auctionOwner.reconcile();
        require("../achievement/achievementRuntime").reconcileFactionWarfareKills();
        await nodeGraphOwner.reconcile();
        const customsInspectionReconciliation = await customsInspectionOwner.reconcileDurableCases();
        const skyhookRaidReconciliation = await skyhookRaidOwner.reconcileDurableRaids();
        const sovHubFuelReconciliation = await runReconciler(() => sovHubFuelOwner.reconcileDurableFuel());
        const selfDestructReconciliation = await selfDestructOwner.reconcileDurableSelfDestructs();
        const breacherDeathReconciliation = await breacherDeathOwner.reconcile();
        const structureSelfDestructReconciliation = await structureSelfDestructOwner.reconcileDurableSelfDestructs();
        const assetSafetyReconciliation = await assetSafetyOwner.reconcile();
        const homeCloneSelfDestructReconciliation = await homeCloneSelfDestructOwner.reconcileDurableSelfDestructs();
        // Repair executor authority before departure reconciliation attempts
        // to hand pending sovereignty custody to the active executor.
        const allianceGovernanceReconciliation = await Promise.resolve(
          allianceGovernanceOwner.reconcileAllianceGovernance(),
        );
        // A capture receipt freezes the winning alliance and executor before
        // the canonical sovereignty mutation. Repair those receipts only after
        // governance is authoritative, and before departure reconciliation can
        // move the newly claimed Hub's corporate custody.
        const sovereigntyCaptureReconciliation = await Promise.resolve(
          sovereigntyCaptureOwner.reconcilePreparedSovereigntyCaptures(),
        );
        // Campaign recovery is deliberately ordered after initial-capture
        // receipts (which may create the newly owned Hub) and before alliance
        // departures (which may transfer or drop its executor custody). It
        // also requeues reinforced Hubs so the durable clock advances unloaded
        // systems at wallclock reinforcement exit.
        const sovereigntyCampaignReconciliation = await Promise.resolve(
          sovereigntyCampaignOwner.reconcileSovereigntyCampaigns(),
        );
        // Settlements that mint commandIDs from their own counter check it
        // against the wallet receipt ledger as they reconcile. One lazy scan
        // serves all of them, so the ledger is read once, not once each.
        const receiptScan = createAuthorityReceiptScan();
        const [
          billReconciliation,
          bountyReconciliation,
          playerBountyReconciliation,
          killRightReconciliation,
          warNegotiationReconciliation,
          dailyGoalsReconciliation,
          contrabandPenaltyReconciliation,
          reprocessingSettlementReconciliation,
          missionRewardSettlementReconciliation,
          planetaryCustomsSettlementReconciliation,
          evermarkPurchaseReconciliation,
          lpStorePurchaseReconciliation,
          corporationLiquidationReconciliation,
          corporationDividendReconciliation,
          corporationFoundingReconciliation,
          allianceFoundingReconciliation,
          corporationMemberActionReconciliation,
          allianceApplicationReconciliation,
          allianceDepartureReconciliation,
          officeImpoundReconciliation,
          officeRentalReconciliation,
          industryInstallSettlementReconciliation,
          contractSettlementReconciliation,
          newEdenStorePurchaseSettlementReconciliation,
          industryReconciliation,
          marketReconciliation,
          skillReconciliation,
          expertSystemReconciliation,
          raffleReconciliation,
          calendarReconciliation,
          eventReconciliation,
          globalSiteReconciliation,
          insuranceReconciliation,
          repairReconciliation,
          jumpCloneReconciliation,
          jumpBridgeReconciliation,
          starbaseFuelReconciliation,
        ] = await Promise.all([
          billOwner.reconcileDurableBills(),
          bountyOwner.reconcileDurableScheduler(),
          playerBountyOwner.reconcileDurablePayouts(),
          killRightOwner.reconcileDurableKillRightPurchases(),
          warNegotiationOwner.reconcileDurableWarNegotiations(),
          dailyGoalsOwner.reconcileDurableRewardSettlements(),
          contrabandPenaltyOwner.reconcileDurableContrabandPenalties(),
          reprocessingSettlementOwner.reconcileDurableReprocessingSettlements({
            receiptScan,
          }),
          missionRewardSettlementOwner.reconcileDurableMissionRewardSettlements(),
          planetaryCustomsSettlementOwner.reconcileDurablePlanetaryCustomsSettlements({
            receiptScan,
          }),
          evermarkPurchaseOwner.reconcileDurableEvermarkPurchases(),
          lpStorePurchaseOwner.reconcileDurableLpStorePurchases(),
          corporationLiquidationOwner.reconcileDurableCorporationLiquidations(),
          corporationDividendOwner.reconcileDurableCorporationDividends(),
          corporationFoundingOwner.reconcileDurableCorporationFoundings(),
          allianceFoundingOwner.reconcileDurableAllianceFoundings(),
          corporationMemberActionOwner.reconcileDurableCorporationMemberActions(),
          allianceApplicationOwner.reconcileDurableAllianceApplications(),
          allianceDepartureOwner.reconcileDurableAllianceDepartures(),
          officeImpoundOwner.reconcileDurableImpoundReleases(),
          officeRentalOwner.reconcileDurableOfficeRentals(),
          industryInstallSettlementOwner.reconcileDurableIndustryInstallSettlements({
            receiptScan,
          }),
          contractSettlementOwner.reconcileDurableContractSettlements(),
          newEdenStorePurchaseSettlementOwner.reconcileDurableStorePurchaseSettlements({
            receiptScan,
          }),
          industryOwner.reconcileDurableIndustryJobs(),
          marketOwner.reconcileDurableMarketOrders(),
          skillOwner.reconcileDurableQueueJobs(),
          expertSystemOwner.reconcileDurableExpertSystemExpiries(),
          raffleOwner.reconcileDurableRaffles(),
          calendarOwner.reconcileDurableCalendarJobs(),
          eventOwner.reconcileDurableEventJobs(),
          globalSiteOwner.reconcileDurableGlobalSites(),
          insuranceOwner.reconcileDurableInsuranceOperations(),
          repairOwner.reconcileDurableRepairOperations({ receiptScan }),
          jumpCloneOwner.reconcileDurableCloneInstalls({ receiptScan }),
          jumpBridgeOwner.reconcileDurableJumpBridgeSettlements({ receiptScan }),
          runReconciler(() => starbaseFuelOwner.reconcilePersistedControlTowerFuelStates()),
        ]);
        startResult = Object.freeze({
          customsInspectionJobs: Number(customsInspectionReconciliation.scheduled) || 0,
          skyhookRaidJobs: Number(skyhookRaidReconciliation.scheduled) || 0,
          sovHubFuelHubs: Number(sovHubFuelReconciliation?.hubs) || 0,
          selfDestructJobs: Number(selfDestructReconciliation.scheduled) || 0,
          breacherDeathJobs: Number(breacherDeathReconciliation.scheduled) || 0,
          structureSelfDestructJobs: Number(structureSelfDestructReconciliation.scheduled) || 0,
          assetSafetyJobs: Number(assetSafetyReconciliation.scheduled) || 0,
          homeCloneSelfDestructJobs: Number(homeCloneSelfDestructReconciliation.scheduled) || 0,
          billJobs:
            Number(billReconciliation && billReconciliation.scheduled) || 0,
          bountyJobs:
            Number(bountyReconciliation && bountyReconciliation.scheduled) || 0,
          playerBountyJobs:
            Number(
              playerBountyReconciliation && playerBountyReconciliation.scheduled,
            ) || 0,
          killRightPurchaseJobs:
            Number(killRightReconciliation && killRightReconciliation.scheduled) || 0,
          warNegotiationJobs:
            Number(
              warNegotiationReconciliation &&
                warNegotiationReconciliation.scheduled,
            ) || 0,
          dailyGoalRewardJobs:
            Number(dailyGoalsReconciliation && dailyGoalsReconciliation.scheduled) || 0,
          contrabandPenaltyJobs:
            Number(
              contrabandPenaltyReconciliation &&
                contrabandPenaltyReconciliation.scheduled,
            ) || 0,
          reprocessingSettlementJobs:
            Number(
              reprocessingSettlementReconciliation &&
                reprocessingSettlementReconciliation.scheduled,
            ) || 0,
          missionRewardSettlementJobs:
            Number(
              missionRewardSettlementReconciliation &&
                missionRewardSettlementReconciliation.scheduled,
            ) || 0,
          planetaryCustomsSettlementJobs:
            Number(
              planetaryCustomsSettlementReconciliation &&
                planetaryCustomsSettlementReconciliation.scheduled,
            ) || 0,
          evermarkPurchaseJobs:
            Number(
              evermarkPurchaseReconciliation &&
                evermarkPurchaseReconciliation.scheduled,
            ) || 0,
          lpStorePurchaseJobs:
            Number(
              lpStorePurchaseReconciliation &&
                lpStorePurchaseReconciliation.scheduled,
            ) || 0,
          corporationLiquidationJobs:
            Number(
              corporationLiquidationReconciliation &&
                corporationLiquidationReconciliation.scheduled,
            ) || 0,
          corporationDividendJobs:
            Number(
              corporationDividendReconciliation &&
                corporationDividendReconciliation.scheduled,
            ) || 0,
          corporationFoundingJobs:
            Number(
              corporationFoundingReconciliation &&
                corporationFoundingReconciliation.scheduled,
            ) || 0,
          allianceFoundingJobs:
            Number(
              allianceFoundingReconciliation &&
                allianceFoundingReconciliation.scheduled,
            ) || 0,
          corporationMemberActionJobs:
            Number(
              corporationMemberActionReconciliation &&
                corporationMemberActionReconciliation.scheduled,
            ) || 0,
          allianceApplicationJobs:
            Number(
              allianceApplicationReconciliation &&
                allianceApplicationReconciliation.scheduled,
            ) || 0,
          allianceDepartureJobs:
            Number(
              allianceDepartureReconciliation &&
                allianceDepartureReconciliation.scheduledDepartures,
            ) || 0,
          allianceClosureJobs:
            Number(
              allianceDepartureReconciliation &&
                allianceDepartureReconciliation.scheduledClosures,
            ) || 0,
          allianceGovernanceRepairs:
            Number(
              allianceGovernanceReconciliation &&
                allianceGovernanceReconciliation.reconciled,
            ) || 0,
          sovereigntyCaptureRepairs:
            Number(
              sovereigntyCaptureReconciliation &&
                sovereigntyCaptureReconciliation.data &&
                sovereigntyCaptureReconciliation.data.completed,
            ) || 0,
          sovereigntyCampaignJobs:
            Number(
              sovereigntyCampaignReconciliation &&
                sovereigntyCampaignReconciliation.data &&
                (
                  sovereigntyCampaignReconciliation.data.scheduled ??
                  sovereigntyCampaignReconciliation.data.scheduledCampaigns
                ),
            ) || 0,
          officeImpoundJobs:
            Number(
              officeImpoundReconciliation && officeImpoundReconciliation.scheduled,
            ) || 0,
          officeRentalJobs:
            Number(
              officeRentalReconciliation && officeRentalReconciliation.scheduled,
            ) || 0,
          industryInstallSettlementJobs:
            Number(
              industryInstallSettlementReconciliation &&
                industryInstallSettlementReconciliation.scheduled,
            ) || 0,
          contractSettlementJobs:
            Number(
              contractSettlementReconciliation &&
                contractSettlementReconciliation.scheduled,
            ) || 0,
          newEdenStorePurchaseSettlementJobs:
            Number(
              newEdenStorePurchaseSettlementReconciliation &&
                newEdenStorePurchaseSettlementReconciliation.scheduled,
            ) || 0,
          industryJobs:
            Number(industryReconciliation && industryReconciliation.scheduled) || 0,
          marketExpiryJobs:
            Number(marketReconciliation && marketReconciliation.scheduled) || 0,
          skillQueueJobs:
            Number(skillReconciliation && skillReconciliation.scheduled) || 0,
          expertSystemJobs:
            Number(expertSystemReconciliation && expertSystemReconciliation.scheduled) || 0,
          raffleJobs:
            Number(raffleReconciliation && raffleReconciliation.scheduled) || 0,
          eventJobs: Number(eventReconciliation && eventReconciliation.scheduled) || 0,
          calendarJobs:
            Number(calendarReconciliation && calendarReconciliation.scheduled) || 0,
          globalSiteJobs:
            Number(globalSiteReconciliation && globalSiteReconciliation.scheduled) || 0,
          insuranceJobs:
            Number(insuranceReconciliation && insuranceReconciliation.scheduled) || 0,
          repairJobs:
            Number(repairReconciliation && repairReconciliation.scheduled) || 0,
          jumpCloneInstallJobs:
            Number(
              jumpCloneReconciliation &&
                (jumpCloneReconciliation.installScheduled ??
                  jumpCloneReconciliation.scheduled),
            ) || 0,
          jumpCloneActivationJobs:
            Number(
              jumpCloneReconciliation && jumpCloneReconciliation.activationScheduled,
            ) || 0,
          jumpBridgeSettlementJobs:
            Number(jumpBridgeReconciliation && jumpBridgeReconciliation.scheduled) || 0,
          starbaseFuelTowers:
            Number(starbaseFuelReconciliation && starbaseFuelReconciliation.towers) || 0,
          starbaseFuelCyclesConsumed:
            Number(
              starbaseFuelReconciliation &&
                starbaseFuelReconciliation.fuelCyclesConsumed,
            ) || 0,
          starbaseFuelExhaustedTowers:
            Number(starbaseFuelReconciliation && starbaseFuelReconciliation.exhausted) || 0,
          starbaseFuelReconciliationFailures:
            Number(starbaseFuelReconciliation && starbaseFuelReconciliation.failed) || 0,
          starbaseFuelOfflineCatchupEnabled:
            Boolean(
              starbaseFuelReconciliation &&
                starbaseFuelReconciliation.consumeFuelWhileServerOffline === true,
            ),
        });
        state = "started";
        return startResult;
      } catch (error) {
        if (typeof starbaseFuelOwner.shutdownControlTowerFuelRuntime === "function") {
          await Promise.resolve(
            starbaseFuelOwner.shutdownControlTowerFuelRuntime(),
          ).catch(() => null);
        }
        unbindOwners();
        unregisterAllHandlers();
        await scheduler.shutdown().catch(() => null);
        state = "closed";
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  function shutdown() {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    state = "closing";
    shutdownPromise = (async () => {
      if (startPromise) {
        await startPromise.catch(() => null);
      }
      // Stop POS fuel and production timers before unbinding owners, so none
      // fires against an unbound owner. A failure here must not keep the
      // durable scheduler running.
      if (typeof starbaseFuelOwner.shutdownControlTowerFuelRuntime === "function") {
        await runReconciler(() => starbaseFuelOwner.shutdownControlTowerFuelRuntime())
          .catch((error) => {
            log.warn(`[ProductionScheduler] starbase fuel shutdown failed: ${error && error.message}`);
          });
      }
      if (typeof essOwner.drain === "function") await essOwner.drain();
      await freelanceOwner.drain();
      await skyhookRaidOwner.idle();
      await runReconciler(() => sovHubFuelOwner.shutdown()).catch((error) => {
        log.warn(`[ProductionScheduler] hub fuel shutdown failed: ${error.message}`);
      });
      await selfDestructOwner.idle();
      await breacherDeathOwner.idle();
      await structureSelfDestructOwner.idle();
      await assetSafetyOwner.idle();
      await homeCloneSelfDestructOwner.idle();
      try {
        if (typeof nodeGraphOwner.flushPending === "function") await nodeGraphOwner.flushPending();
        await airEncounterOwner.flushPending();
      } finally {
        unbindOwners();
        unregisterAllHandlers();
        await scheduler.shutdown();
        state = "closed";
      }
      return true;
    })();
    return shutdownPromise;
  }

  return Object.freeze({
    getState: () => state,
    shutdown,
    start,
  });
}

module.exports = { createProductionSchedulerRuntime };
