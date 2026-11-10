"use strict";

const BaseService = require("../baseService");
const runtime = require("./projectDiscoveryRuntime");
const { buildDict, buildKeyVal, buildList, buildMarshalReal, unwrapMarshalValue } = require("../_shared/serviceHelpers");
const { throwWrappedUserError } = require("../../common/machoErrors");
const auditEvents = [];
const pendingMutations = new Map();
const mutatingMethods = new Set(["get_new_task", "post_classification", "reset_tutorial", "skip_tutorial",
  "increase_tutorial_level", "give_tutorial_rewards", "fix_task_id"]);
function marshal(value) {
  if (Array.isArray(value)) return buildList(value.map(marshal));
  if (value && typeof value === "object") return buildDict(Object.entries(value).map(([key, child]) => [key, marshal(child)]));
  if (typeof value === "number" && !Number.isInteger(value)) return buildMarshalReal(value);
  return value;
}
function state(session) { return runtime.read(session).state; }
function player(value) { return buildKeyVal(Object.entries(value)); }
function withProgressNotices(session, action) {
  const publish = result => {
    const current = runtime.playerState(state(session));
    if (typeof session.sendNotification === "function") {
      try {
        // Replays refresh current committed state, never an older receipt.
        session.sendNotification("OnPlayerStateUpdated", "clientID", [player(current)]);
        session.sendNotification("OnAnalysisKreditsChange", "charid", []);
      }
      catch (_) { /* Reconnect reads committed points; transport cannot roll them back. */ }
    }
    return result;
  };
  const result = action();
  return result && typeof result.then === "function" ? result.then(publish) : publish(result);
}

class ProjectDiscoveryService extends BaseService {
  constructor() { super("ProjectDiscovery"); }
  callMethod(method, args, session, kwargs, context) {
    const report = error => {
      if (error?.machoErrorResponse || !/^DISCOVERY_[A-Z_]+$/.test(error?.message || "")) throw error;
      throwWrappedUserError("CustomNotify", { notify: `Project Discovery: progress or rewards await settlement; retry. (${error.message})` });
    };
    try {
      const name = BaseService.normalizeMethodName(method).replace(/^Handle_/, "");
      if (!mutatingMethods.has(name)) return super.callMethod(method, args, session, kwargs, context);
      const initial = runtime.read(session), characterID = initial.id;
      if (pendingMutations.has(characterID) || pendingMutations.size >= 2048)
        throwWrappedUserError("CustomNotify", { notify: "Project Discovery: please wait for the pending request." });
      const invoke = () => {
        if (runtime.read(session).id !== characterID)
          throwWrappedUserError("CustomNotify", { notify: "Project Discovery: the active character changed." });
        const result = super.callMethod(method, args, session, kwargs, context);
        const finish = response => { runtime.settleRankRewards(session); return response; };
        return result && typeof result.then === "function" ? result.then(finish) : finish(result);
      };
      const value = runtime.hasPendingReward(initial.state) ? runtime.settleRewards(session).then(invoke) : invoke();
      if (!value || typeof value.then !== "function") return value;
      const pending = value.catch(report).finally(() => {
        if (pendingMutations.get(characterID) === pending) pendingMutations.delete(characterID);
      });
      pendingMutations.set(characterID, pending);
      return pending;
    } catch (error) { return report(error); }
  }
  Handle_is_enabled() { return true; }
  Handle_get_project_id() { return 1; } // Existing legacy compatibility method.
  Handle_initialize_tutorial_status(args, session) { return this.Handle_get_tutorial_completion_status(args, session); }
  Handle_get_player_state(_args, session) { return player(runtime.playerState(state(session))); }
  Handle_get_player_analysis_kredits(_args, session) { return state(session).analysisKredits; }
  Handle_get_total_needed_xp(args) { return runtime.xpNeededForRank(args?.[0]); }
  Handle_get_tutorial_completion_status(_args, session) { return state(session).finishedTutorial; }
  Handle_get_tutorial_level(_args, session) { return state(session).tutorialLevel; }
  Handle_get_tutorial_xp_reward() { return runtime.TUTORIAL_XP; }
  Handle_get_is_player_entitled_to_tutorial_reward(_args, session) { return runtime.tutorialEntitled(state(session)); }
  Handle_give_tutorial_rewards(_args, session) { return withProgressNotices(session, () => runtime.tutorialAction(session, "reward")); }
  Handle_reset_tutorial(_args, session) { return player(runtime.tutorialAction(session, "reset")); }
  Handle_skip_tutorial(_args, session) { return player(withProgressNotices(session, () => runtime.tutorialAction(session, "skip"))); }
  Handle_increase_tutorial_level(_args, session) { return player(runtime.tutorialAction(session, "increase")); }
  Handle_get_maximum_bonus_samples() { return require("./projectDiscoveryRewards").constants.BONUS_SAMPLES; }
  Handle_get_remaining_bonus_samples(_args, session) { return runtime.remainingBonusSamples(state(session)); }
  Handle_get_current_task_index(_args, session) { return state(session).sequence; }
  Handle_get_player_statistics(_args, session) {
    const s = state(session);
    return marshal({ localMode: "EveJS-authored training; not live MMOS science data", projectID: runtime.PROJECT,
      project: { score: runtime.accuracy(s) },
      local: { submissions: s.submitted, correct: s.correct, averageScore: s.submitted ? s.scoreTotal / s.submitted : 0 } });
  }
  Handle_get_new_task(_args, session, kwargs) { return marshal(runtime.task(session, unwrapMarshalValue(kwargs) || {})); }
  Handle_get_data_from_url(args, session) { return marshal(runtime.dataFromUrl(session, unwrapMarshalValue(args?.[0]))); }
  Handle_new_training_task() {
    throwWrappedUserError("CustomNotify", { notify: "The legacy Project Discovery project is unavailable; use the active local geometry project." });
  }
  Handle_post_classification(args, session) {
    // Native COVID contract is (result, duration); duration is untrusted and
    // intentionally does not affect scoring or rewards. No legacy task/answer
    // overload is accepted by this project.
    const result = withProgressNotices(session, () => {
      const response = runtime.classify(session, unwrapMarshalValue(args?.[0]));
      return runtime.hasPendingReward(state(session)) ? runtime.settleRewards(session) : response;
    });
    const encode = response => {
      auditEvents.push({ kind: "post_classification", characterID: Number(session.characterID || session.charid), taskID: response.task.id });
      if (auditEvents.length > 100) auditEvents.shift();
      return buildDict(Object.entries(response).map(([key, value]) => [key, key === "playerState" ? player(value) : marshal(value)]));
    };
    return result && typeof result.then === "function" ? result.then(encode) : encode(result);
  }
  Handle_fix_task_id(args, session) { return runtime.fixTask(session, unwrapMarshalValue(args?.[0])); }
}
ProjectDiscoveryService._testing = {
  getAuditEvents: () => auditEvents.slice(),
  resetForTests: () => { auditEvents.length = 0; },
  constants: { ACTIVE_PROJECT_ID: runtime.PROJECT, LEGACY_SUBCELLULAR_PROJECT_ID: 1,
    PLAYER_NOT_IN_DATABASE_ERROR_CODE: 103010, TUTORIAL_LEVEL_COUNT: runtime.TUTORIAL_LEVELS },
};
module.exports = ProjectDiscoveryService;
