"use strict";

const config = require("../../config");
const characterState = require("./characterState");
const { createTableRepository } = require("../../gameStore/tableRepository");
const repo = createTableRepository("service:character", { strict: true });
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { throwWrappedUserError } = require("../../common/machoErrors");
const { getSample, validatePolygons, scorePolygons, TUTORIAL_SAMPLES, SAMPLE_COUNT } = require("./projectDiscoverySamples");
const PROJECT = "mcgill-polyseg";
const BONUS_SAMPLES = 5;
const TUTORIAL_XP = 100;
const TUTORIAL_LEVELS = 8;

function fail(message) { throwWrappedUserError("CustomNotify", { notify: `Project Discovery: ${message}` }); }
function identity(session) {
  const id = resolveSessionCharacterID(session);
  const accountID = Number(session?.userid ?? session?.accountID);
  const character = id ? characterState.peekCharacterRecord(id) : null;
  if (!character || !Number.isSafeInteger(accountID) || accountID <= 0 ||
    Number(character.accountID ?? character.accountId) !== accountID || character.deletedAt || character.isDeleted ||
    session?.socket?.destroyed || session?._characterControlDisconnected) fail("an authenticated character is required.");
  return { id, character };
}
function defaults() {
  return { version: 1, experience: 0, analysisKredits: 0, finishedTutorial: false,
    tutorialLevel: 0, tutorialRewardClaimed: false, tutorialProof: [],
    sequence: 0, bonusRemaining: BONUS_SAMPLES, submitted: 0, correct: 0, scoreTotal: 0,
    fixedSampleID: null, active: null };
}
function read(session) {
  const { id, character } = identity(session);
  const source = character.projectDiscovery;
  if (source != null && (typeof source !== "object" || source.version !== 1)) fail("the saved local project version is unsupported.");
  const state = source == null ? defaults() : structuredClone(source);
  for (const key of ["experience", "analysisKredits", "tutorialLevel", "sequence", "bonusRemaining", "submitted", "correct"]) {
    if (!Number.isSafeInteger(state[key]) || state[key] < 0) fail("the saved local project needs repair.");
  }
  if (state.tutorialLevel > TUTORIAL_LEVELS || state.bonusRemaining > BONUS_SAMPLES ||
    !Array.isArray(state.tutorialProof) || state.tutorialProof.length > 5 ||
    state.tutorialProof.some(code => !Object.hasOwn(TUTORIAL_SAMPLES, code)) ||
    !Number.isFinite(state.scoreTotal) || state.scoreTotal < 0) fail("the saved local project needs repair.");
  return { id, state };
}
function write(id, state) {
  const result = characterState.updateCharacterRecord(id, record => ({ ...record, projectDiscovery: state }));
  if (!result?.success) fail("progress could not be saved; retry the request.");
  if (!repo.flushTableSync("characters")?.success) fail("progress could not be committed; retry the request.");
}
function xpNeededForRank(value) {
  const numeric = Number(value);
  const rank = Number.isFinite(numeric) ? Math.max(1, Math.trunc(numeric)) : 1;
  const experience = (rank - 1) * rank * 50;
  if (!Number.isSafeInteger(experience)) fail("that rank exceeds supported local progress precision.");
  return experience;
}
function playerState(state) {
  const rank = Math.floor((1 + Math.sqrt(1 + state.experience * 0.08)) / 2);
  return { rank, experience: state.experience, analysisKredits: state.analysisKredits,
    finishedTutorial: state.finishedTutorial, tutorialLevel: state.tutorialLevel };
}
function sampleUrl(sampleID) {
  return new URL(getSample(sampleID).path, config.microservicesPublicUrl).href;
}
function buildTask(active, solution = false) {
  const sample = getSample(active.sampleID);
  if (!sample) fail("the saved sample is unavailable.");
  const task = { id: active.id, taskID: active.id, taskId: active.id, projectID: PROJECT,
    isTrainingSet: true, isTutorial: active.tutorial, localMode: "EveJS-authored geometry training",
    assets: { url: sampleUrl(sample.id), dimensions: [512, 512] }, url: sampleUrl(sample.id),
    votes: { highScore: 0, avgScore: 0 }, classificationCount: 0 };
  if (solution) task.solution = { clusters: sample.polygons.map(p => ({ polygons: [{ ...p, densityLevel: 1 }] })) };
  return task;
}
function task(session, options = {}) {
  const { id, state } = read(session);
  const tutorial = options.is_tutorial_task === true;
  const code = options.original_code;
  if (code != null && (typeof code !== "string" || !Object.hasOwn(TUTORIAL_SAMPLES, code))) fail("unknown tutorial sample.");
  if ((tutorial && !code) || (code && !tutorial)) fail("invalid tutorial sample request.");
  if (!state.active || state.active.receipt || state.active.tutorialCode !== (code || null)) {
    const sampleID = tutorial ? TUTORIAL_SAMPLES[code] : state.fixedSampleID || (state.sequence % SAMPLE_COUNT) + 1;
    state.sequence++;
    state.active = { id: `evejs-pd-v1-${id}-${state.sequence}`, sampleID, tutorial, tutorialCode: code || null, receipt: null };
  }
  write(id, state);
  return buildTask(state.active);
}
function validateAnswer(answer, active) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer) || typeof answer.skip !== "boolean") fail("invalid classification.");
  for (const key of ["taskID", "taskId", "id"]) if (answer[key] !== undefined && answer[key] !== active.id) fail("that task is not the character's active task.");
  if (!validatePolygons(answer.polygons, answer.skip)) fail("draw up to eight simple, separate polygons with normalized coordinates.");
  return { skip: answer.skip, polygons: answer.polygons.map(p => ({ vertices: p.vertices.map(v => v.slice()) })) };
}
function classify(session, answer) {
  const { id, state } = read(session);
  const active = state.active;
  if (!active) fail("request a task before submitting an answer.");
  const normalized = validateAnswer(answer, active);
  const fingerprint = JSON.stringify(normalized);
  if (active.receipt) {
    if (active.receipt.answer !== fingerprint) fail("this task was already submitted; request a new task.");
    write(id, state); // Also retries a previous failed commit, without re-scoring.
    return structuredClone(active.receipt.result);
  }
  const score = normalized.skip ? 0 : scorePolygons(getSample(active.sampleID), normalized.polygons);
  const passed = !normalized.skip && (active.tutorial ? score > 0.5 : score >= 0.5);
  const bonus = passed && !active.tutorial && state.bonusRemaining > 0;
  const xp = passed && !active.tutorial ? Math.round(score * 50) * (bonus ? 2 : 1) : 0;
  const ak = passed && !active.tutorial ? Math.round(score * 5) : 0;
  if (!Number.isSafeInteger(state.experience + xp) || !Number.isSafeInteger(state.analysisKredits + ak)) fail("the local progress limit has been reached.");
  state.experience += xp; state.analysisKredits += ak;
  if (bonus) state.bonusRemaining--;
  state.submitted++; state.scoreTotal += score;
  if (passed) state.correct++;
  if (passed && active.tutorial && !state.tutorialProof.includes(active.tutorialCode)) state.tutorialProof.push(active.tutorialCode);
  const result = { isSolved: true, score, classificationCount: state.submitted,
    XP_Reward: xp, ISK_Reward: 0, AK_Reward: ak, loot_crates: [], tier_reward: null,
    gotBonusXP: bonus, bonusSamplesAfterClassification: state.bonusRemaining,
    player: { score: state.scoreTotal / state.submitted }, playerState: playerState(state),
    isTraining: active.tutorial, task: buildTask(active, true), localMode: "EveJS-authored geometry training" };
  active.receipt = { answer: fingerprint, result };
  // Receipt and all progress/rewards are one character-owner SQLite write. No
  // notification or material payout happens before this durable commit.
  write(id, state);
  return structuredClone(result);
}
function tutorialEntitled(state) {
  return state.finishedTutorial && !state.tutorialRewardClaimed &&
    Object.keys(TUTORIAL_SAMPLES).every(code => state.tutorialProof.includes(code));
}
function tutorialAction(session, action) {
  const { id, state } = read(session);
  if (action === "reset") { state.finishedTutorial = false; state.tutorialLevel = 0; }
  else if (action === "skip") { state.finishedTutorial = true; state.tutorialLevel = TUTORIAL_LEVELS; }
  else if (action === "increase") {
    state.tutorialLevel = Math.min(TUTORIAL_LEVELS, state.tutorialLevel + 1);
    state.finishedTutorial = state.tutorialLevel === TUTORIAL_LEVELS;
  } else if (action === "reward") {
    if (!tutorialEntitled(state)) { write(id, state); return false; }
    state.tutorialRewardClaimed = true; state.experience += TUTORIAL_XP; state.analysisKredits += 10;
  } else fail("unknown tutorial action.");
  // COVID's complete_tutorial() calls skip_tutorial, rather than the legacy
  // explicit claim method. Completion pays only with all five scored proofs.
  if (action === "skip" && tutorialEntitled(state)) {
    state.tutorialRewardClaimed = true; state.experience += TUTORIAL_XP; state.analysisKredits += 10;
  }
  if (!Number.isSafeInteger(state.experience) || !Number.isSafeInteger(state.analysisKredits)) fail("the local progress limit has been reached.");
  write(id, state);
  return action === "reward" ? true : playerState(state);
}
function fixTask(session, sampleID) {
  const { id, state } = read(session);
  const { buildPersistedAccountRoleRecord, normalizeRoleValue, ROLE_CONTENT } = require("../account/accountRoleProfiles");
  const account = Object.values(require("../login/accountStore").readAccountsTable())
    .find(row => Number(row?.accountID ?? row?.id ?? row?.userID) === Number(session.userid ?? session.accountID));
  if (!account || account.banned || !(normalizeRoleValue(buildPersistedAccountRoleRecord(account).role, 0n) & ROLE_CONTENT)) fail("task pinning requires content permission.");
  if (sampleID !== 0 && !getSample(sampleID)) fail("unknown local sample.");
  state.fixedSampleID = sampleID || null;
  // A diagnostic cannot invalidate a pending submission or its receipt.
  write(id, state);
  return null;
}
function dataFromUrl(session, url) {
  const { state } = read(session);
  if (!state.active || typeof url !== "string" || url !== sampleUrl(state.active.sampleID)) fail("only the current local task resource is available.");
  return { localMode: "EveJS-authored geometry training", points: getSample(state.active.sampleID).points, dimensions: [512, 512] };
}
module.exports = { read, playerState, xpNeededForRank, task, classify, tutorialAction, tutorialEntitled,
  fixTask, dataFromUrl, PROJECT, BONUS_SAMPLES, TUTORIAL_XP, TUTORIAL_LEVELS };
