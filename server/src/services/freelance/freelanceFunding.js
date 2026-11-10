"use strict";
const database = require("../../gameStore");
const corporationWallet = require("../corporation/corpWalletState");
function createFreelanceFunding({readRoot, writeRoot, events}) {
  const clone = value => structuredClone(value);
  const fail = errorMsg => ({success:false,errorMsg});
  const cents = value => Number.isSafeInteger(value) && value >= 0;
  const load = () => clone(readRoot());
  function save(root) { const result=writeRoot(root); return result===true||result?.success===true; }
  function flushWallet() { const result=database.flushTablesSync(["characters", "corporationRuntime", "walletAuthorityState"]); if(result?.success===false)throw new Error("FREELANCE_WALLET_FLUSH_PENDING"); }
  function announce(name, project, extra={}) { events?.emit(name,{project:clone(project),...extra}); }
  async function fundProject(projectID) {
    let root = load(), project = root.projects[projectID];
    if (!project) return fail("PROJECT_NOT_FOUND");
    const funding = project.funding;
    if (funding?.state === "funded") return { success: true, data: { project } };
    if (funding?.state === "failed") return fail("FUNDING_FAILED");
    if (!funding || !cents(funding.escrowCents) || !cents(funding.feeCents)) return fail("INVALID_FUNDING");
    const total = funding.escrowCents + funding.feeCents;
    if (!cents(total)) return fail("INVALID_FUNDING");
    try {
      const result = total === 0 ? {success:true} : await corporationWallet.adjustCorporationWalletDivisionBalanceAsync(
        funding.payerCorporationID || project.ownerCorporationID, funding.accountKey || 1000, -total / 100,
        { idempotencyKey: `freelance:${projectID}:fund`, description: "Freelance project funding and creation fees", referenceID: 0, requireExactCredit: true },
        {commandID:`freelance:${projectID}:fund`,source:"freelance"},
      );
      if (!result?.success) {
        if (result?.errorMsg === "INSUFFICIENT_FUNDS") {
          root = load(); project = root.projects[projectID];
          project.funding.state = "failed"; project.state = 2;
          if (!save(root)) return fail("WRITE_ERROR");
        }
        return result || fail("WALLET_ERROR");
      }
      flushWallet();
      root = load(); project = root.projects[projectID];
      project.funding.state = "funded";
      project.funding.totalCents = total;
      project.funding.escrowRemainingCents = funding.escrowCents;
      project.funding.refundedCents = 0;
      project.funding.paidCents = 0;
      project.state = 1;
      if (!save(root)) return fail("WRITE_ERROR");
      announce("project-created", project);
      return { success: true, data: { project: clone(project) } };
    } catch (error) { return fail(error.code || error.message || "WALLET_ERROR"); }
  }

  return {fundProject};
}
module.exports={createFreelanceFunding};
