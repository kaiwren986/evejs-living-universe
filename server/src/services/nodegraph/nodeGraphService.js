"use strict";

const BaseService = require("../baseService");
const runtime = require("./nodeGraphRuntime");
const { safeValue } = require("./nodeGraphCompiler");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { buildDict, unwrapMarshalValue } = require("../_shared/serviceHelpers");

const auditEvents = [];
const subscriptions = new Map();
const MAX_AUDIT_EVENTS = 200;
const sessionKey = (session) => `character:${resolveSessionCharacterID(session)}`;

function isAuthorizedStaff(session) {
  const characterID = resolveSessionCharacterID(session);
  if (!characterID) return false;
  const record = require("../character/characterState").getCharacterRecord(characterID);
  const accountID = Number(session?.userid || session?.accountID || 0);
  if (!record || Number(record.accountId ?? record.accountID) !== accountID) return false;
  const { readAccountsTable } = require("../login/accountStore");
  const account = Object.values(readAccountsTable()).find((entry) => Number(entry?.accountID || entry?.id || entry?.userID) === accountID);
  const { hasStaffAccountRole, buildPersistedAccountRoleRecord } = require("../account/accountRoleProfiles");
  return Boolean(account && !account.banned && hasStaffAccountRole(buildPersistedAccountRoleRecord(account)));
}

function audit(kind, args, session, kwargs, failure = null) {
  const bounded = (value) => { try { const serialized = JSON.stringify(value); return serialized?.length > 2048 ? "[oversized]" : JSON.parse(serialized || "null"); } catch { return "[invalid]"; } };
  auditEvents.push({ kind, args: Array.isArray(args) ? args.slice(0, 4).map(bounded) : [], kwargs: bounded(kwargs || null), characterID: resolveSessionCharacterID(session) || null, timestamp: Date.now(), ...(failure ? { failure: failure.code || failure.message } : {}) });
  if (auditEvents.length > MAX_AUDIT_EVENTS) auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  if (failure) require("../../utils/logger").debug(`[NodeGraph] ${kind} character=${resolveSessionCharacterID(session)} graph=${Number(args?.[0]) || 0} key=${JSON.stringify(bounded(args?.[2]))} reason=${failure.code || failure.message}`);
}

function decode(args) {
  if (!Array.isArray(args)) return [];
  const decoded = args.map(unwrapMarshalValue);
  safeValue(decoded);
  if (JSON.stringify(decoded).length > 65536) throw new Error("NODEGRAPH_REQUEST_LIMIT");
  return decoded;
}
function blackboard(value, characterID) {
  const values = value?.type === "dict" ? Object.fromEntries(value.entries || []) : value || {};
  return { ...safeValue(values), character_id: characterID, charid: characterID };
}

class NodeGraphService extends BaseService {
  constructor() { super("node_graph"); }
  async Handle_process_client_graph_message(args, session, kwargs) {
    try {
      const [graphID, instanceID, key, value] = decode(args);
      await runtime.processClientMessage(session, graphID, instanceID, key, value ?? null);
      audit("client_graph_message", args, session, kwargs);
    } catch (error) { audit("client_graph_message_rejected", args, session, kwargs, error); }
    return null;
  }
  Handle_process_client_blackboard_request(args, session, kwargs) {
    try {
      const [graphID, instanceID, key] = decode(args);
      const result = runtime.getGraphBlackboardValue(session, graphID, instanceID, key);
      audit("client_blackboard_request", args, session, kwargs);
      return result;
    } catch (error) { audit("client_blackboard_request_no_value", args, session, kwargs, error); return null; }
  }
  Handle_qa_subscribe(args, session, kwargs) {
    if (!isAuthorizedStaff(session)) { audit("qa_forbidden", args, session, kwargs); return buildDict([]); }
    subscriptions.set(sessionKey(session), session);
    runtime.subscribeQa(session, () => subscriptions.get(sessionKey(session)) === session && isAuthorizedStaff(session));
    audit("qa_subscribe", args, session, kwargs);
    return runtime.getQaLogSnapshot(session);
  }
  Handle_qa_unsubscribe(args, session, kwargs) {
    if (subscriptions.get(sessionKey(session)) === session) subscriptions.delete(sessionKey(session));
    runtime.unsubscribeQa(session);
    audit("qa_unsubscribe", args, session, kwargs); return null;
  }
  async qa(kind, args, session, kwargs, operation) {
    if (!isAuthorizedStaff(session)) { audit("qa_forbidden", args, session, kwargs); return null; }
    try { const result = await operation(decode(args)); audit(kind, args, session, kwargs); return result; }
    catch (error) { audit(`${kind}_rejected`, args, session, kwargs, error); return null; }
  }
  Handle_qa_start_node_graph(args, session, kwargs) {
    return this.qa("qa_start_node_graph", args, session, kwargs, async ([graphID, values]) => (await runtime.startServerGraph(session, Number(graphID), { blackboard: blackboard(values, resolveSessionCharacterID(session)) })).instanceID);
  }
  Handle_qa_stop_node_graph(args, session, kwargs) {
    return this.qa("qa_stop_node_graph", args, session, kwargs, async ([id]) => { await runtime.stopServerGraph(session, id); return null; });
  }
  Handle_qa_start_node(args, session, kwargs) {
    return this.qa("qa_start_node", args, session, kwargs, async ([id, nodeID]) => { await runtime.startServerGraphNode(session, id, nodeID); return null; });
  }
  Handle_qa_stop_node(args, session, kwargs) {
    return this.qa("qa_stop_node", args, session, kwargs, async ([id, nodeID]) => { await runtime.stopServerGraphNode(session, id, nodeID); return null; });
  }
  Handle_qa_stop_active_nodes(args, session, kwargs) {
    return this.qa("qa_stop_active_nodes", args, session, kwargs, async ([id]) => { await runtime.stopServerGraphActiveNodes(session, id); return null; });
  }
}

NodeGraphService.forgetSession = (session) => {
  if (subscriptions.get(sessionKey(session)) === session) subscriptions.delete(sessionKey(session));
  require("./nodeGraphEvents").publish(session, 305);
  runtime.detachSession(session);
};
NodeGraphService._testing = {
  getAuditEvents: () => auditEvents.map((event) => ({ ...event })),
  getSubscriptions: () => [...subscriptions.keys()].sort(),
  resetForTests() { auditEvents.length = 0; subscriptions.clear(); runtime.resetForTests(); },
};
module.exports = NodeGraphService;
