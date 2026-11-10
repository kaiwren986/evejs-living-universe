"use strict";

const database = require("../../gameStore");
const corporationWallet = require("../corporation/corpWalletState");
const characterWallet = require("../account/walletState");

// The project owner serializes callers. Every wallet leg is recoverable from a
// project intent and an authority-owned receipt; no balance is edited here.
function createFreelanceSettlement({ readRoot, writeRoot, events }) {
  const clone = value => structuredClone(value);
  const fail = errorMsg => ({ success: false, errorMsg });
  const cents = value => Number.isSafeInteger(value) && value >= 0;
  const load = () => clone(readRoot());
  function save(root) {
    const result = writeRoot(root);
    return result === true || result?.success === true;
  }
  function flushWallet() {
    const result = database.flushTablesSync(["characters", "corporationRuntime", "walletAuthorityState"]);
    if (result?.success === false) throw new Error("FREELANCE_WALLET_FLUSH_PENDING");
  }
  function announce(name, project, extra = {}) {
    events?.emit(name, { project: clone(project), ...extra });
  }

  const { fundProject } = require("./freelanceFunding").createFreelanceFunding({readRoot,writeRoot,events});

  async function finishClaim(projectID, characterID) {
    let root = load(), project = root.projects[projectID];
    let participant = project?.participants?.[characterID], intent = participant?.claimIntent;
    if (!intent) return fail("NO_REWARDS");
    try {
      const result = intent.cents === 0 ? {success:true} : await characterWallet.adjustCharacterBalanceAsync(characterID, intent.cents / 100, {
        idempotencyKey: intent.key, description: "Freelance project reward", referenceID: 0, requireExactCredit: true,
      }, {commandID:intent.key,source:"freelance"});
      if (!result?.success) return result || fail("WALLET_ERROR");
      flushWallet();
      root = load(); project = root.projects[projectID]; participant = project.participants[characterID];
      intent = participant.claimIntent;
      participant.unitsUnredeemed -= intent.units;
      participant.redeemedUnits = (participant.redeemedUnits || 0) + intent.units;
      project.funding.escrowRemainingCents -= intent.cents;
      project.funding.paidCents = (project.funding.paidCents || 0) + intent.cents;
      participant.lastClaim = clone(intent);
      delete participant.claimIntent;
      if (!save(root)) return fail("WRITE_ERROR");
      announce("participant-reward-redeemed", project, { characterID, amount: intent.cents / 100, units: intent.units });
      return { success: true, data: { project: clone(project), participant: clone(participant), amount: intent.cents / 100, units: intent.units } };
    } catch (error) { return fail(error.code || error.message || "WALLET_ERROR"); }
  }

  async function redeemRewards(projectID, characterID) {
    const root = load(), project = root.projects[projectID];
    if (!project) return fail("PROJECT_NOT_FOUND");
    if (project.funding?.state !== "funded") return fail("FUNDING_PENDING");
    const participant = project.participants?.[characterID];
    if (!participant) return fail("PARTICIPANT_NOT_FOUND");
    if (participant.claimIntent) return finishClaim(projectID, characterID);
    const units = Number(participant.unitsUnredeemed || 0);
    if (!Number.isSafeInteger(units) || units <= 0) return fail("NO_REWARDS");
    const payoutCents = project.reward?.payoutPerUnitCents ?? Math.round(Number(project.reward?.payoutPerUnit || 0) * 100);
    const amount = units * payoutCents;
    if (!cents(amount) || amount > project.funding.escrowRemainingCents) return fail("ESCROW_INSUFFICIENT");
    participant.claimIntent = { key: `freelance:${projectID}:claim:${characterID}:${participant.redeemedUnits || 0}`, units, cents: amount };
    if (!save(root)) return fail("WRITE_ERROR");
    return finishClaim(projectID, characterID);
  }

  async function refundProject(projectID) {
    let root = load(), project = root.projects[projectID];
    if (!project) return fail("PROJECT_NOT_FOUND");
    if (project.state === 0 || project.state === 1) return fail("INVALID_PROJECT_STATE");
    if (project.funding?.state !== "funded") return { success: true, data: { project } };
    if (project.funding.refundComplete) return { success: true, data: { project } };
    if (!project.funding.refundIntent) {
      const payoutCents = project.reward?.payoutPerUnitCents ?? Math.round(Number(project.reward?.payoutPerUnit || 0) * 100);
      const reserved = Object.values(project.participants || {}).reduce((sum, participant) => sum + Number(participant.unitsUnredeemed || 0) * payoutCents, 0);
      const amount = project.funding.escrowRemainingCents - reserved;
      if (!cents(amount)) return fail("ESCROW_INSUFFICIENT");
      project.funding.refundIntent = { key: `freelance:${projectID}:refund`, cents: amount };
      if (!save(root)) return fail("WRITE_ERROR");
    }
    const intent = project.funding.refundIntent;
    try {
      const result = intent.cents === 0 ? {success:true} : await corporationWallet.adjustCorporationWalletDivisionBalanceAsync(
        project.funding.payerCorporationID || project.ownerCorporationID, project.funding.accountKey || 1000, intent.cents / 100,
        { idempotencyKey: intent.key, description: "Freelance project unused funding refund", referenceID: 0, requireExactCredit: true },
        {commandID:intent.key,source:"freelance"},
      );
      if (!result?.success) return result || fail("WALLET_ERROR");
      flushWallet();
      root = load(); project = root.projects[projectID];
      project.funding.escrowRemainingCents -= intent.cents;
      project.funding.refundedCents = intent.cents;
      project.funding.refundComplete = true;
      delete project.funding.refundIntent;
      if (!save(root)) return fail("WRITE_ERROR");
      return { success: true, data: { project: clone(project) } };
    } catch (error) { return fail(error.code || error.message || "WALLET_ERROR"); }
  }

  async function reconcile() {
    const results = [];
    for (const project of Object.values(load().projects || {})) {
      if (project.funding?.state === "pending") {
        const result = await fundProject(project.projectID);
        // A proven refusal is a durable tombstone, not a pending recovery leg.
        // It must not keep startup or maintenance failing forever.
        if (result.success || load().projects[project.projectID]?.funding?.state !== "failed") results.push(result);
      }
      for (const participant of Object.values(project.participants || {})) {
        if (participant.claimIntent) results.push(await finishClaim(project.projectID, participant.characterID));
      }
      if (project.state > 1 && project.funding?.state === "funded") results.push(await refundProject(project.projectID));
    }
    return { success: results.every(result => result.success), data: results };
  }
  return { fundProject, redeemRewards, refundProject, reconcile };
}

module.exports = { createFreelanceSettlement };
