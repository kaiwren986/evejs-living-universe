"use strict";

// Bridge for feature/election-event. Main has no campaign yet; the Homefront
// operations remain permanent universe content when the election is inactive.
function campaignModules() {
  try {
    require.resolve("./campaignTrailCatalog");
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
  return {
    campaign: require("./campaignTrailCatalog"),
    trail: require("./campaignTrailRuntime"),
    catalog: require("./gallenteHomefrontCatalog"),
  };
}
function snapshot(characterID, instance, config) {
  const modules = campaignModules();
  if (
    !modules ||
    !modules.campaign.isEnabled() ||
    config.empireFactionID !== 500004
  )
    return null;
  const progress = modules.trail.getProgress(characterID);
  const step = modules.catalog.getActiveStep(progress);
  return step && !progress.homefront?.readyAtMs
    ? {
        seasonID: modules.campaign.SEASON_ID,
        candidateKey: progress.candidateKey,
        index: step.index,
      }
    : null;
}
function apply(session, receipt, participant) {
  const modules = campaignModules();
  if (!modules)
    throw new Error(
      "Election adapter is unavailable for an earned election receipt",
    );
  const progress = modules.trail.getProgress(participant.characterID);
  const election = participant.election;
  if (progress.homefrontReceipts?.[receipt.id]) return;
  const step = modules.catalog.getActiveStep(progress);
  const eligible =
    election &&
    election.seasonID === modules.campaign.SEASON_ID &&
    step &&
    step.index === election.index &&
    progress.candidateKey === election.candidateKey &&
    !progress.homefront?.readyAtMs;
  if (eligible) {
    progress.homefront = {
      ...progress.homefront,
      count: Math.min(step.count, (progress.homefront?.count || 0) + 1),
    };
    if (progress.homefront.count === step.count)
      progress.homefront.readyAtMs = receipt.completedAtMs;
  }
  progress.homefrontReceipts = {
    ...progress.homefrontReceipts,
    [receipt.id]: true,
  };
  modules.trail.saveProgress(participant.characterID, progress);
  if (eligible) {
    session?.sendNotification?.("OnChallengeProgressUpdate", "charid", [
      step.challengeID,
      progress.homefront.count,
    ]);
    if (progress.homefront.readyAtMs)
      session?.sendNotification?.("OnChallengeRewardsGranted", "charid", [
        step.challengeID,
      ]);
  }
}
module.exports = { snapshot, apply };
