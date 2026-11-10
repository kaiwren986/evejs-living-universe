"use strict";

const projects = require("./freelanceProjectState");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const binding = createDurableSchedulerBinding();
const JOB_TYPE = "freelance.maintenance";

function settlement() {
  return require("./freelanceSettlement").createFreelanceSettlement(projects);
}
async function scheduleProject(project, now) {
  const scheduler = binding.get();
  if (!scheduler) return;
  const pending = project.funding?.state === "pending" ||
    Object.values(project.participants || {}).some(p => p.claimIntent) ||
    (project.state > 1 && project.funding?.state === "funded" && !project.funding.refundComplete);
  const deliveryPending = Object.values(projects.readRoot().deliveries).some(d =>
    d.projectID === project.projectID && d.status === "escrowed");
  const dueAtMs = pending || deliveryPending ? now + 1000 : project.state === 1 ? Math.max(now + 1, project.deadlineMs) : null;
  if (dueAtMs !== null) await scheduler.schedule({
    jobID: `freelance:${project.projectID}:${dueAtMs}`, type: JOB_TYPE,
    dueAtMs, payload: { projectID: project.projectID },
  });
}

async function maintain(now = Date.now()) {
  const delivery = require("./freelanceDelivery").createFreelanceDelivery(projects);
  const recovery = delivery.recoverPending();
  if (recovery.success) {
    const root = projects.readRoot();
    const expired = [];
    for (const project of Object.values(root.projects)) {
      if (project.state === 1 && project.deadlineMs <= now) {
        project.state = 4;
        project.finishTimeMs = project.deadlineMs;
        expired.push(project);
      }
    }
    if (expired.length) {
      projects.writeRoot(root);
      for (const project of expired) projects.events.emit("project-expired", { project });
    }
  }
  const result = recovery.success ? await settlement().reconcile() : recovery;
  for (const project of Object.values(projects.readRoot().projects)) await scheduleProject(project, now);
  if (!result.success) throw new Error(result.errorMsg || "FREELANCE_RECOVERY_PENDING");
  return { success: true };
}

const reconcile = (options = {}) => projects.runSerialized(() => maintain(options.nowMs ?? Date.now()));
module.exports = {
  JOB_TYPE, reconcile, handleJob: () => reconcile(),
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind,
  scheduleProject: project => scheduleProject(project, Date.now()),
  drain: () => projects.runSerialized(() => {}),
};
