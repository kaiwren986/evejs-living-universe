"use strict";

const BaseService = require("../baseService");
const runtime = require("./projectDiscoveryRuntime");
const { buildDict, buildKeyVal, buildList, buildMarshalReal, unwrapMarshalValue } = require("../_shared/serviceHelpers");
const { throwWrappedUserError } = require("../../common/machoErrors");
const auditEvents = [];
function marshal(value) {
  if (Array.isArray(value)) return buildList(value.map(marshal));
  if (value && typeof value === "object") return buildDict(Object.entries(value).map(([key, child]) => [key, marshal(child)]));
  if (typeof value === "number" && !Number.isInteger(value)) return buildMarshalReal(value);
  return value;
}
function state(session) { return runtime.read(session).state; }
function player(value) { return buildKeyVal(Object.entries(value)); }
function withProgressNotices(session, action) {
  const result = action();
  const current = runtime.playerState(state(session));
  if (typeof session.sendNotification === "function") {
    try {
      // Replays refresh the current committed state, never the historical
      // receipt's playerState. These are idempotent cache-refresh notices.
      session.sendNotification("OnPlayerStateUpdated", "charid", [player(current)]);
      session.sendNotification("OnAnalysisKreditsChange", "charid", []);
    }
    catch (_) { /* A reconnect reads committed points; transport cannot roll them back. */ }
  }
  return result;
}

class ProjectDiscoveryService extends BaseService {
  constructor() { super("ProjectDiscovery"); }
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
  Handle_get_maximum_bonus_samples() { return runtime.BONUS_SAMPLES; }
  Handle_get_remaining_bonus_samples(_args, session) { return state(session).bonusRemaining; }
  Handle_get_current_task_index(_args, session) { return state(session).sequence; }
  Handle_get_player_statistics(_args, session) {
    const s = state(session);
    return marshal({ message: "Project Discovery is not backed by live MMOS data; local authored training statistics only.",
      code: 103010, projectID: runtime.PROJECT,
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
    const result = withProgressNotices(session, () => runtime.classify(session, unwrapMarshalValue(args?.[0])));
    auditEvents.push({ kind: "post_classification", characterID: Number(session.characterID || session.charid), taskID: result.task.id });
    if (auditEvents.length > 100) auditEvents.shift();
    return buildDict(Object.entries(result).map(([key, value]) => [key, key === "playerState" ? player(value) : marshal(value)]));
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
