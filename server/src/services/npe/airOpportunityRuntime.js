"use strict";

// Chapter 2's Opportunities entry ("Hidden Prospects" with "Warp to Site", ...) is the job
// storylines:AIR_NPE_ACT_2 of the client graph 708 "[AIR] 2.0 - Opportunity", a subgraph of
// the client master (graph 716), started on the message "client_start_opportunity_2".
// Chapter 1's entry is the same kind of job (storylines:AIR_NPE_ACT_1, graph 707 "[AIR] 1.0 -
// Opportunity", started by the master on its scene changes) and is lost the same way; it is
// restored for scenes 1.3 to 1.5.
// The client's job board adds that job only at the moment 708 starts (OnNodeGraphStarted).
// Its first refresh after login removes it again: the storylines provider's own refresh is
// never called (JobProvider.refresh_jobs runs the private _JobProvider__refresh_jobs, which
// keeps only _get_all_content(), and that is [] for storylines). On a relog 708 starts
// before that refresh, so the job is gone while 708 keeps running (Opportunities > Active: 0).
// The storylines provider adds the job again on OnNodeGraphStarted for a graph that is
// running (StorylinesProvider._add_job_by_graph_id: get_active_node_graph_by_id), and the
// client turns a server notification into that event like any other. So the server tells the
// client that the running 708 has started: the job is back, from the same 708, whose "Warp to
// Site" button reads next_objective from the client master's blackboard it shares. Nothing is
// stopped or restarted, so nothing replays (a restart replayed the undock cinematic and the
// "warp to" line), and a second notice changes nothing (_create_job updates the existing job).
// Besides the storylines provider only the graph event atom 487 listens to OnNodeGraphStarted,
// and no graph with it names 707 or 708.
//
// When: the job board's first refresh. The client builds the board's storage with all
// providers at once (JobBoardStorage), each provider's refresh runs as a tasklet in that order,
// and the storylines refresh never waits on the server, so it has finished before a later
// provider's call reaches the server (dungeonInstanceCacheMgr GetCombatAnomalyInstances); the
// notice follows at once.
//
// OPEN: when no other job is tracked the board loads without any server call, and the client
// reports nothing when it builds it; 20 s after login the notice goes out anyway.

const characters = require("../character/characterState");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const log = require("../../utils/logger");

const ACTS = [
  { chapter: 1, phaseGraphIDs: new Set([695, 709, 710]), opportunityGraphID: 707, contentKey: "AIR_NPE_ACT_1" },
  { chapter: 2, phaseGraphIDs: new Set([711, 712, 713, 714, 715]), opportunityGraphID: 708, contentKey: "AIR_NPE_ACT_2" },
];
const READD_AFTER_LOGIN_MS = 20_000;

const marked = new WeakSet();

function actMaster(session) {
  const characterID = resolveSessionCharacterID(session);
  const state = characterID ? characters.getCharacterRecord(characterID)?.authoredAirTutorial : null;
  const act = state && state.status === "active" ? ACTS.find(entry => entry.phaseGraphIDs.has(state.phaseGraphID)) : null;
  if (!act) return null;
  const root = characters.getCharacterRecord(characterID)?.serverNodeGraphs?.[state.rootID];
  const master = (root?.clientInstanceIDs || []).filter(id => String(id).endsWith(":716"));
  return root && !root.stopped && master.length ? { characterID, root, master, act } : null;
}

// The chapter's opportunity graph is running on the client: its job goes back on the board.
function readd(session, reason) {
  if (!session || session.socket?.destroyed || typeof session.sendNotification !== "function") return;
  const target = actMaster(session);
  if (!target) return;
  const graphID = target.act.opportunityGraphID;
  const instanceID = (target.root.clientInstanceIDs || []).find(id => String(id).endsWith(`:${graphID}`)) || target.master[0];
  session.sendNotification("OnNodeGraphStarted", "clientID", [instanceID, graphID]);
  log.info(`[AirNpe] character ${target.characterID}: chapter ${target.act.chapter} Opportunities entry re-added (${reason})`);
}

// After every tutorial check (login, client state request, undock).
function restore(session) {
  const target = actMaster(session);
  if (!target || marked.has(session)) return;
  marked.add(session);
  const { characterID, root, act } = target;
  // The job counts as accepted only while the blackboard holds <content key>.state = "active"
  // (client-only memory; for chapter 2 the client writes it in step 1.5.07). Keep it on the
  // server as a published value, so every login gives it back.
  const current = root.blackboard?.[act.contentKey];
  if (!current || current.state !== "active" || !(root.publicBlackboardKeys || []).includes(act.contentKey)) {
    Promise.resolve(require("../nodegraph/nodeGraphRuntime")
      .updateRootBlackboard(session, root.instanceID, { [act.contentKey]: { ...(current || {}), state: "active" } },
        { publicBlackboardKeys: [act.contentKey], publishToClient: true, deferExecution: true }))
      .then(() => log.info(`[AirNpe] character ${characterID}: chapter ${act.chapter} opportunity marked active for the client`))
      .catch(error => log.warn(`[AirNpe] chapter ${act.chapter} opportunity state for ${characterID}: ${error.message}`));
  }
  setTimeout(() => readd(session, "after login"), READD_AFTER_LOGIN_MS);
}

function handleJobBoardLoaded(session) {
  if (session && actMaster(session)) readd(session, "job board loaded");
}

module.exports = { restore, handleJobBoardLoaded };
