"use strict";

const crypto = require("node:crypto");
const authority = require("./nodeGraphAuthority");
const effects = require("./nodeGraphEffects");
const { LIMITS, NODE_PORTS, UNSAFE_KEYS, safeValue, compareValues, graphError } = require("./nodeGraphCompiler");
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { buildDict, buildList } = require("../_shared/serviceHelpers");
function clientValue(value) {
  if (Array.isArray(value)) return value.map(clientValue);
  if (value && typeof value === "object") return buildDict(Object.entries(value).map(([key, entry]) => [key, clientValue(entry)]));
  return value;
}
function clientBlackboard(root) {
  return clientValue({ ...root.blackboard, server_graph_instance_id: root.instanceID,
    ...(root.activeScene !== undefined ? { active_scene: root.activeScene } : {}),
    ...(root.activeTask !== undefined ? { active_task: root.activeTask } : {}),
  });
}

const NODE_TYPES = Object.freeze(Object.keys(NODE_PORTS).map(Number));
const JOB_TYPE = "nodegraph.delay";
const { cloneValue: clone } = require("../../common/clone");

function createNodeGraphRuntime(options = {}) {
  const getGraph = options.getGraphDefinition || authority.getGraphDefinition;
  const getClientGraph = options.getClientGraphDefinition || authority.getClientGraphDefinition;
  const live = new Map();
  const extensions = new Map();
  const ownerPolicies = new Map();
  const qaObservers = new Map();
  const pendingSchedulerCommands = new Set();
  const characterLanes = new Map();
  const publicOperations = new Set();
  function tracked(promise) {
    publicOperations.add(promise);
    promise.then(() => publicOperations.delete(promise), () => publicOperations.delete(promise));
    return promise;
  }
  function serialized(characterID, operation) {
    const previous = characterLanes.get(characterID) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    characterLanes.set(characterID, result);
    result.then(() => { if (characterLanes.get(characterID) === result) characterLanes.delete(characterID); }, () => { if (characterLanes.get(characterID) === result) characterLanes.delete(characterID); });
    return result;
  }
  const forSession = (operation) => (session, ...args) => tracked(serialized(resolveSessionCharacterID(session), () => operation(session, ...args)));
  const schedulerFailures = [];
  let scheduler = null;
  let now = options.now || Date.now;
  const charOwner = () => options.characterOwner || require("../character/characterState");
  const flush = () => {
    const result = options.flush ? options.flush() : require("../../gameStore").flushTableSync("characters");
    if (!result || result.success !== true) throw graphError("NODEGRAPH_CHECKPOINT_FLUSH_FAILED", result?.errorMsg);
  };
  const save = (root) => {
    if (Buffer.byteLength(JSON.stringify(root)) > LIMITS.bytes * 4) throw graphError("NODEGRAPH_STATE_LIMIT");
    const snapshot = clone(root);
    delete snapshot.pendingCheckpointUpdates;
    const result = charOwner().updateCharacterRecord(root.characterID, (record) => ({
      ...record, serverNodeGraphs: { ...(record.serverNodeGraphs || {}), [root.instanceID]: snapshot },
      serverNodeGraphCheckpoints: { ...(record.serverNodeGraphCheckpoints || {}), ...(root.pendingCheckpointUpdates || {}) },
    }));
    if (!result.success) throw graphError("NODEGRAPH_CHECKPOINT_WRITE_FAILED", result.errorMsg);
    flush();
    delete root.pendingCheckpointUpdates;
  };
  const load = (characterID, instanceID) => {
    const root = charOwner().getCharacterRecord(characterID)?.serverNodeGraphs?.[instanceID];
    if (root && (root.characterID !== characterID || root.instanceID !== instanceID)) throw graphError("NODEGRAPH_INSTANCE_FORBIDDEN");
    return root ? clone(root) : null;
  };
  const graphDigest = (graph) => crypto.createHash("sha256").update(JSON.stringify(graph)).digest("hex");

  function coverage(graphID, visited = new Set(), stack = [], ownerKey = "qa") {
    if (stack.includes(graphID)) throw graphError("NODEGRAPH_SUBGRAPH_CYCLE", [...stack, graphID].join(" -> "));
    if (visited.has(graphID)) return visited;
    if (visited.size >= LIMITS.graphs || stack.length >= LIMITS.depth) throw graphError("NODEGRAPH_GRAPH_LIMIT");
    const graph = getGraph(graphID);
    visited.add(graphID);
    for (const node of Object.values(graph.nodesByID)) {
      if (!NODE_TYPES.includes(node.nodeTypeID)) throw graphError("NODEGRAPH_NODE_UNSUPPORTED", `${graphID}/${node.nodeID}/${node.nodeTypeID}`);
      const support = { 4: effects.ACTION_ATOMS, 5: effects.EVENT_ATOMS, 9: effects.CONDITION_ATOMS, 30: effects.GETTER_ATOMS }[node.nodeTypeID];
      if (support && !support.includes(node.atomID) && !extensions.has(`${node.nodeTypeID}:${node.atomID}`)) throw graphError("NODEGRAPH_ATOM_UNSUPPORTED", `${graphID}/${node.nodeID}/${node.atomID}`);
      const extension = extensions.get(`${node.nodeTypeID}:${node.atomID}`);
      if (extension?.supports && !extension.supports({ graphID, node, ownerKey })) throw graphError("NODEGRAPH_ATOM_CONTEXT_UNSUPPORTED", `${graphID}/${node.nodeID}/${node.atomID}`);
      if (node.nodeTypeID === 4 && node.atomID === 364 && node.atomParameters.skill_points !== undefined && node.atomParameters.skill_points !== null && node.atomParameters.skill_points !== 0) throw graphError("NODEGRAPH_SKILL_COMPENSATION_UNSUPPORTED");
      if (node.nodeTypeID === 5 && node.nodeParameters.validate_on_start) throw graphError("NODEGRAPH_EVENT_START_VALIDATION_UNSUPPORTED");
      if (node.nodeTypeID === 19 && (node.nodeParameters.property_path || node.nodeParameters.object_path)) throw graphError("NODEGRAPH_PROPERTY_WRITE_UNSUPPORTED");
      if (node.nodeTypeID === 39) {
        const clientID = node.nodeParameters.node_graph_id;
        if (!Number.isSafeInteger(clientID)) throw graphError("NODEGRAPH_DYNAMIC_CLIENT_GRAPH_UNSUPPORTED");
        if (!getClientGraph(clientID)) throw graphError("NODEGRAPH_CLIENT_GRAPH_UNAVAILABLE");
      }
      if (node.nodeTypeID === 13) {
        const childID = node.nodeParameters.node_graph_id;
        if (!Number.isSafeInteger(childID)) throw graphError("NODEGRAPH_DYNAMIC_SUBGRAPH_UNSUPPORTED");
        coverage(childID, visited, [...stack, graphID], ownerKey);
      }
    }
    return visited;
  }

  function graphFor(root, instance) {
    const graph = getGraph(instance.graphID);
    if (root.graphDigests[instance.graphID] !== graphDigest(graph)) throw graphError("NODEGRAPH_DEFINITION_CHANGED", String(instance.graphID));
    return graph;
  }
  function stateFor(instance, nodeID) { return instance.nodes[nodeID] ||= { active: false, outputs: {}, once: false }; }
  function enqueue(root, instance, nodeID, source = null, port = null) {
    if (root.queue.length >= LIMITS.steps) throw graphError("NODEGRAPH_QUEUE_LIMIT");
    const task = { instanceID: instance.instanceID, nodeID, source, port };
    const finishIndex = root.queue.findIndex((entry) => entry.finishStop);
    if (finishIndex >= 0) root.queue.splice(finishIndex, 0, task);
    else root.queue.push(task);
  }
  function output(root, instance, node, port = "output") {
    for (const id of node.connections[port] || []) enqueue(root, instance, id, node.nodeID);
  }
  function property(value, path) {
    for (const key of String(path || "").split(".").filter(Boolean)) {
      if (UNSAFE_KEYS.has(key)) throw graphError("NODEGRAPH_UNSAFE_KEY", key);
      value = value && Object.hasOwn(value, key) ? value[key] : null;
    }
    return value ?? null;
  }
  function resolveValue(root, instance, value, depth = 0) {
    if (depth > LIMITS.depth) throw graphError("NODEGRAPH_GETTER_CYCLE");
    if (!value || value.kind !== "connection") return safeValue(value ?? null);
    const node = graphFor(root, instance).nodesByID[value.nodeID];
    const state = stateFor(instance, node.nodeID);
    if (node.nodeTypeID === 18) {
      const p = resolveParameters(root, instance, node.nodeParameters, depth + 1);
      return property(root.blackboard[p.blackboard_key], p.object_path || p.property_path) ?? p.default_value ?? null;
    }
    if (node.nodeTypeID === 30) {
      const cache = Boolean(resolveValue(root, instance, node.nodeParameters.cache_values, depth + 1));
      if (cache && state.getterCached) return property(state.outputs, value.parameterKey);
      const parameters = resolveParameters(root, instance, node.atomParameters, depth + 1);
      const extension = extensions.get(`30:${node.atomID}`);
      const result = extension ? extension({ root, instance, node, parameters, session: live.get(root.instanceID)?.session }) : effects.executeGetter(instance, node, parameters, root);
      if (result && typeof result.then === "function") throw graphError("NODEGRAPH_GETTER_ASYNC_FORBIDDEN");
      state.outputs = safeValue(result || {}); state.getterCached = cache;
      return property(result, value.parameterKey);
    }
    return property(state.outputs, value.parameterKey);
  }
  function resolveParameters(root, instance, values, depth = 0) {
    return Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, resolveValue(root, instance, value, depth)]));
  }
  function validate(root, instance, node, source, depth = 0, triggerConnections = false) {
    if (depth >= LIMITS.depth) throw graphError("NODEGRAPH_VALIDATION_CYCLE");
    if (triggerConnections) {
      const state = stateFor(instance, node.nodeID);
      state.active = true; state.outputs = safeValue(source || {});
    }
    if (node.nodeTypeID === 7) {
      const p = resolveParameters(root, instance, node.nodeParameters);
      const requireAll = p.require_all !== false && p.require_all !== 0;
      let result = requireAll;
      for (const id of node.connections.validation || []) {
        const value = validate(root, instance, graphFor(root, instance).nodesByID[id], source, depth + 1, triggerConnections);
        result = requireAll ? result && value : result || value;
        if (!p.run_all && (requireAll ? !result : result)) break;
      }
      if (triggerConnections) output(root, instance, node, result ? "on_success" : "on_failure");
      return result;
    }
    if (node.nodeTypeID === 22) {
      const p = resolveParameters(root, instance, node.nodeParameters);
      const current = property(root.blackboard[p.blackboard_key], p.object_path || p.property_path);
      const result = compareValues(current, p.blackboard_value, p.operator || "equalTo", Boolean(p.flipped));
      if (triggerConnections) stateFor(instance, node.nodeID).outputs = { blackboard_value: current };
      if (triggerConnections) output(root, instance, node, result ? "on_success" : "on_failure");
      return result;
    }
    const p = resolveParameters(root, instance, node.atomParameters);
    let result;
    switch (node.atomID) {
      case 34: result = compareValues(property(source || {}, p.parameter_key), p.parameter_value, p.operator || "equalTo", Boolean(p.flipped)); break;
      case 289: result = compareValues(p.checkpoint_id, p.checkpoint_id_b, p.operator || "equalTo", Boolean(p.flipped)); break;
      case 308: result = compareValues(p.value_a, p.value_b, p.operator || "equalTo", Boolean(p.flipped)); break;
      case 368: result = p.value === null || p.value === undefined; break;
      default: throw graphError("NODEGRAPH_CONDITION_UNSUPPORTED");
    }
    result = node.nodeParameters.is_not ? !result : result;
    if (triggerConnections) output(root, instance, node, result ? "on_success" : "on_failure");
    return result;
  }
  function writeBlackboard(root, key, value, force = false) {
    if (typeof key !== "string" || UNSAFE_KEYS.has(key) || key.length > 128) throw graphError("NODEGRAPH_BLACKBOARD_KEY_INVALID");
    const old = root.blackboard[key];
    root.blackboard[key] = safeValue(value);
    if (!force && JSON.stringify(old) === JSON.stringify(value)) return;
    for (const instance of Object.values(root.instances)) {
      if (instance.stopped) continue;
      for (const node of Object.values(graphFor(root, instance).nodesByID)) if (node.nodeTypeID === 21 && stateFor(instance, node.nodeID).active && node.nodeParameters.blackboard_key === key) {
        enqueue(root, instance, node.nodeID, null, "changed");
      }
    }
  }
  function notify(root, type, args) {
    (root.outbox ||= []).push({ type, args: clone(args) });
  }
  function publish(root) {
    const session = live.get(root.instanceID)?.session;
    if (!session || session.socket?.destroyed) return;
    const outbox = root.outbox || [];
    const starting = new Set(outbox.filter(event => event.type === "OnStartClientNodeGraph").map(event => event.args[1]));
    const startupSlot = event => {
      if (event.type === "OnStartClientNodeGraph") return `${event.args[1]}:start`;
      if (!starting.has(event.args[0])) return null;
      const key = event.type === "OnClientNodeGraphMessage" ? event.args[1]
        : event.type === "OnClientNodeGraphUpdate" ? event.args[1]?.entries?.[0]?.[0] : null;
      const field = ["active_task", "server_start_task", "server_on_activate_task"].includes(key) ? "task"
        : ["active_scene", "server_start_scene", "server_on_activate_scene"].includes(key) ? "scene" : null;
      return field ? `${event.args[0]}:${event.type}:${field}` : null;
    };
    // A failed bootstrap can leave a start and obsolete presentation in its
    // durable outbox. Resume adds another start and drains the original queue;
    // send each start once and only the latest startup scene/task afterward.
    const latest = new Map();
    outbox.forEach((event, index) => {
      const slot = startupSlot(event);
      if (slot && (event.type !== "OnStartClientNodeGraph" || !latest.has(slot))) latest.set(slot, index);
    });
    for (const [index, event] of outbox.entries()) {
      const slot = startupSlot(event);
      if (slot && latest.get(slot) !== index) continue;
      if (ownerPolicies.get(root.ownerKey)?.canPublish?.(session, root, event) === false) continue;
      if (event.type === "OnNodeGraphLog" && !qaObservers.get(session)?.()) continue;
      // Client nodes start asynchronously. Their blackboard must describe the
      // committed scene/task even if the following transient messages arrive
      // before those nodes subscribe. Rebuild persisted startup events too.
      const args = event.type === "OnStartClientNodeGraph"
        ? [event.args[0], event.args[1], clientBlackboard(root)] : event.args;
      // TQ sends the node graph notices to the character (golden logs:
      // OnClientNodeGraphMessage 55 and OnStopClientNodeGraph 1, all charid).
      session.sendNotification?.(event.type, "charid", args);
    }
    if (root.outbox?.length) { root.outbox = []; save(root); }
  }
  function addInstance(root, graphID, parent = null, parentNodeID = null) {
    if (Object.keys(root.instances).length >= LIMITS.graphs) throw graphError("NODEGRAPH_INSTANCE_LIMIT");
    const instanceID = parent ? `${root.instanceID}:${++root.sequence}` : root.instanceID;
    const instance = { instanceID, rootInstanceID: root.instanceID, characterID: root.characterID, graphID, parentInstanceID: parent?.instanceID || null, parentNodeID, nodes: {}, stopped: false };
    root.instances[instanceID] = instance;
    for (const id of graphFor(root, instance).rootNodeIDs) enqueue(root, instance, id);
    return instance;
  }
  function scheduleCommand(promise) {
    const command = Promise.resolve(promise);
    pendingSchedulerCommands.add(command);
    command.then(() => pendingSchedulerCommands.delete(command), (error) => {
      pendingSchedulerCommands.delete(command);
      schedulerFailures.push(error);
      require("../../utils/logger").warn(`[NodeGraph] scheduler command failed: ${error.message}`);
    });
  }
  function jobID(root, instance, node) { return `nodegraph:${root.instanceID}:${instance.instanceID}:${node.nodeID}`; }
  function rewardJobID(characterID, key) { return `nodegraph-reward:${characterID}:${key}`; }
  const rewardRecovery = {
    async prepare(characterID, key, dueAtMs = now() + 5000) {
      if (scheduler) await scheduler.schedule({ jobID: rewardJobID(characterID, key), type: JOB_TYPE, dueAtMs, payload: { characterID, rewardKey: key } });
    },
    async finish(characterID, key) { if (scheduler) await scheduler.cancel(rewardJobID(characterID, key)); },
  };
  function scheduleDelay(root, instance, node, state) {
    if (scheduler) scheduleCommand(scheduler.schedule({ jobID: jobID(root, instance, node), type: JOB_TYPE, dueAtMs: state.dueAtMs, payload: { characterID: root.characterID, rootID: root.instanceID, instanceID: instance.instanceID, nodeID: node.nodeID, dueAtMs: state.dueAtMs } }));
  }
  function stopInstance(root, instance, explicit = false) {
    if (instance.stopped || instance.stopping) return;
    for (const child of Object.values(root.instances)) if (child.parentInstanceID === instance.instanceID) stopInstance(root, child, true);
    instance.stopping = true;
    instance.explicitStop = explicit;
    for (const node of Object.values(graphFor(root, instance).nodesByID)) {
      const state = stateFor(instance, node.nodeID);
      if (state.dueAtMs && scheduler) scheduleCommand(scheduler.cancel(jobID(root, instance, node)));
      state.active = false; delete state.dueAtMs;
    }
    root.queue = root.queue.filter((task) => task.instanceID !== instance.instanceID);
    for (const node of Object.values(graphFor(root, instance).nodesByID)) if (node.nodeTypeID === 20) output(root, instance, node);
    root.queue.push({ instanceID: instance.instanceID, finishStop: true });
  }
  function finishStop(root, instance) {
    instance.stopped = true; instance.stopping = false;
    if (instance.parentInstanceID && !instance.explicitStop) {
      const parent = root.instances[instance.parentInstanceID];
      if (parent && !parent.stopped) {
        stateFor(parent, instance.parentNodeID).active = false;
        output(root, parent, graphFor(root, parent).nodesByID[instance.parentNodeID], "on_stop");
      }
    }
    if (instance.instanceID === root.instanceID) {
      root.stopped = true;
      for (const id of root.clientInstanceIDs) notify(root, "OnStopClientNodeGraph", [id]);
    }
  }
  function dispatchMessage(root, key, value, client = false) {
    let matched = false;
    for (const instance of Object.values(root.instances)) {
      if (instance.stopped) continue;
      for (const node of Object.values(graphFor(root, instance).nodesByID)) {
        const state = stateFor(instance, node.nodeID);
        if (node.nodeTypeID !== 31 || !state.active || node.nodeParameters.message_key !== key) continue;
        const values = { key, value: safeValue(value), message_value: safeValue(value), message_key: key };
        // Validation getters can connect to this listener's current message.
        // Do not validate against its previous delivery (or its initial null).
        const previousOutputs = state.outputs;
        state.outputs = values;
        if (!(node.connections.validation || []).every(id => validate(root, instance, graphFor(root, instance).nodesByID[id], values))) { state.outputs = previousOutputs; continue; }
        for (const id of node.connections.validation || []) validate(root, instance, graphFor(root, instance).nodesByID[id], values, 0, true);
        state.outputs = values;
        if (!node.nodeParameters.keep_listening) state.active = false;
        output(root, instance, node);
        matched = true;
      }
    }
    if (client && !matched) throw graphError("NODEGRAPH_MESSAGE_INACTIVE");
  }
  async function activate(root, task) {
    const instance = root.instances[task.instanceID];
    if (!instance || instance.stopped) return;
    if (task.finishStop) { finishStop(root, instance); return; }
    const graph = graphFor(root, instance), node = graph.nodesByID[task.nodeID];
    if (!node) throw graphError("NODEGRAPH_NODE_MISSING");
    const state = stateFor(instance, node.nodeID), wasActive = state.active;
    const p = resolveParameters(root, instance, node.nodeParameters);
    state.active = true;
    switch (node.nodeTypeID) {
      case 1: output(root, instance, node); break;
      case 44: break; // Authored analytics node is terminal; no gameplay effect.
      case 4: {
        const parameters = resolveParameters(root, instance, node.atomParameters);
        effects.checkCharacter(instance, parameters);
        const extension = extensions.get(`4:${node.atomID}`);
        const result = await (extension ? extension({ root, instance, node, parameters, session: live.get(root.instanceID)?.session }) : effects.executeAction(instance, node, parameters, root, rewardRecovery));
        if (result === false || result?.success === false) throw graphError("NODEGRAPH_EFFECT_FAILED", result?.errorMsg);
        await options.afterEffect?.({ root, instance, node, result });
        state.outputs = safeValue(result || {});
        output(root, instance, node); break;
      }
      case 5: case 31: break;
      case 7: case 9: case 22:
        validate(root, instance, node, instance.nodes[task.source]?.outputs, 0, true); break;
      case 10: if (!state.once) { state.once = true; output(root, instance, node); } break;
      case 12: stopInstance(root, instance); break;
      case 13:
        if (!wasActive) {
          if (p.exclusive_key) for (const child of Object.values(root.instances)) if (!child.stopped && child.exclusiveKey === p.exclusive_key) stopInstance(root, child, true);
          output(root, instance, node, "on_start");
          const child = addInstance(root, Number(p.node_graph_id), instance, node.nodeID);
          child.exclusiveKey = p.exclusive_key || null;
        }
        break;
      case 17:
        if (task.port === "due") { delete state.dueAtMs; output(root, instance, node); }
        else {
          const seconds = Number(p.delay ?? 1);
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400 * 30) throw graphError("NODEGRAPH_DELAY_INVALID");
          if (seconds === 0) enqueue(root, instance, node.nodeID, node.nodeID, "due");
          else state.dueAtMs = now() + seconds * 1000;
        }
        break;
      case 18: case 30: break;
      case 19:
        if (p.property_path || p.object_path) throw graphError("NODEGRAPH_PROPERTY_WRITE_UNSUPPORTED");
        writeBlackboard(root, p.blackboard_key, p.blackboard_value, Boolean(p.force_scatter));
        state.outputs = { blackboard_value: p.blackboard_value ?? null }; output(root, instance, node); break;
      case 20: break;
      case 21: {
        if (task.port !== "changed" && wasActive) break;
        state.outputs = { blackboard_value: root.blackboard[p.blackboard_key] ?? null };
        const source = { ...state.outputs, [p.blackboard_key]: state.outputs.blackboard_value };
        if ((task.port === "changed" || p.validate_on_start) && (node.connections.validation || []).every((id) => validate(root, instance, graph.nodesByID[id], source))) {
          for (const id of node.connections.validation || []) validate(root, instance, graph.nodesByID[id], source, 0, true);
          if (!p.keep_listening) state.active = false;
          output(root, instance, node);
        }
        break;
      }
      case 24:
        for (const id of node.connections.nodes || []) {
          const target = stateFor(instance, id);
          if (target.dueAtMs !== undefined && scheduler) scheduleCommand(scheduler.cancel(jobID(root, instance, { nodeID: id })));
          target.active = false; delete target.dueAtMs;
        }
        output(root, instance, node); break;
      case 32: {
        if (!String(p.message_key).startsWith("server_")) throw graphError("NODEGRAPH_SERVER_MESSAGE_REQUIRED");
        let presentationKey = null;
        if (["server_on_activate_task", "server_start_task"].includes(p.message_key)) {
          root.activeTask = safeValue(p.message_value); root.activeTaskMessageKey = p.message_key;
          presentationKey = "active_task";
        }
        if (["server_on_activate_scene", "server_start_scene"].includes(p.message_key)) {
          root.activeScene = safeValue(p.message_value); root.activeSceneMessageKey = p.message_key;
          presentationKey = "active_scene";
        }
        const selected = p.client_graph_instance_id || root.blackboard[p.client_graph_instance_id_blackboard_key || "client_graph_instance_id"];
        if (selected && !root.clientInstanceIDs.includes(selected)) throw graphError("NODEGRAPH_CLIENT_INSTANCE_FORBIDDEN");
        for (const id of selected ? [selected] : root.clientInstanceIDs) {
          // Native updates retain presentation in the shared client context
          // even when a newly starting chapter misses a transient message.
          if (presentationKey) notify(root, "OnClientNodeGraphUpdate", [id, clientValue({ [presentationKey]: p.message_value ?? null })]);
          notify(root, "OnClientNodeGraphMessage", [id, p.message_key, clientValue(p.message_value ?? null)]);
        }
        output(root, instance, node); break;
      }
      case 39: {
        if (p.character_id !== undefined && Number(p.character_id) !== root.characterID) throw graphError("NODEGRAPH_CHARACTER_FORBIDDEN");
        if (!getClientGraph(p.node_graph_id)) throw graphError("NODEGRAPH_CLIENT_GRAPH_UNAVAILABLE");
        const id = `${root.instanceID}:client:${p.node_graph_id}`;
        if (!root.clientInstanceIDs.includes(id)) root.clientInstanceIDs.push(id);
        if (!root.clientGraphIDs.includes(Number(p.node_graph_id))) root.clientGraphIDs.push(Number(p.node_graph_id));
        writeBlackboard(root, p.client_graph_instance_id_blackboard_key || "client_graph_instance_id", id);
        notify(root, "OnStartClientNodeGraph", [Number(p.node_graph_id), id, clientBlackboard(root)]);
        state.outputs = { client_graph_instance_id: id }; output(root, instance, node); break;
      }
      case 40: {
        if (p.character_id !== undefined && Number(p.character_id) !== root.characterID) throw graphError("NODEGRAPH_CHARACTER_FORBIDDEN");
        const selected = p.client_graph_instance_id || root.blackboard[p.client_graph_instance_id_blackboard_key || "client_graph_instance_id"];
        if (!selected || !root.clientInstanceIDs.includes(selected)) throw graphError("NODEGRAPH_CLIENT_INSTANCE_FORBIDDEN");
        notify(root, "OnStopClientNodeGraph", [selected]);
        root.clientInstanceIDs = root.clientInstanceIDs.filter(id => id !== selected);
        root.clientGraphIDs = root.clientGraphIDs.filter(id => root.clientInstanceIDs.some(clientID => Number(clientID.split(":").pop()) === id));
        output(root, instance, node); break;
      }
      case 42: dispatchMessage(root, String(p.message_key), p.message_value ?? null); output(root, instance, node); break;
      case 49:
        state.sources ||= [];
        if (task.source && !state.sources.includes(task.source)) state.sources.push(task.source);
        if (node.incomingSourceNodeIDs.every((id) => state.sources.includes(id))) { state.sources = []; output(root, instance, node); }
        break;
      default: throw graphError("NODEGRAPH_NODE_UNSUPPORTED");
    }
  }
  async function drain(root, deferPublish = false) {
    if (root.stopped) return root;
    let steps = 0;
    try {
      while (root.queue.length) {
        if (++steps > LIMITS.steps) throw graphError("NODEGRAPH_ACTIVATION_LIMIT");
        const before = clone(root);
        const task = root.queue.shift();
        try {
          await activate(root, task);
          if (!task.finishStop) {
            const entry = { node_graph_id: root.graphID, node_graph_instance_id: root.instanceID, type: "node", event: "active", info: { node_id: task.nodeID, graph_id: root.instances[task.instanceID].graphID }, timestamp: new Date(now()).toISOString() };
            root.qaLogs ||= []; root.qaLogs.push(entry); root.qaLogs = root.qaLogs.slice(-200);
            if (qaObservers.has(live.get(root.instanceID)?.session)) notify(root, "OnNodeGraphLog", [qaEntry(entry)]);
          }
          save(root); if (!deferPublish) publish(root);
        }
        catch (error) {
          // Keep the original queue head on failure. Owner receipts protect an
          // effect that committed before this checkpoint could be written.
          for (const key of Object.keys(root)) if (!Object.hasOwn(before, key)) delete root[key];
          Object.assign(root, before);
          throw error;
        }
      }
      delete root.failure;
      for (const instance of Object.values(root.instances)) for (const state of Object.values(instance.nodes)) delete state.deliveryPendingAtMs;
      save(root);
      // Reattachment can enqueue presentation without activating a server node.
      // Flush that outbox even when the execution queue was already empty.
      publish(root);
      for (const instance of Object.values(root.instances)) for (const node of Object.values(graphFor(root, instance).nodesByID)) {
        const state = instance.nodes[node.nodeID];
        if (state?.active && state.dueAtMs !== undefined) scheduleDelay(root, instance, node, state);
      }
      return root;
    } catch (error) {
      root.failure = { code: error.code || "NODEGRAPH_EXECUTION_FAILED", message: error.message };
      if (["NODEGRAPH_ACTIVATION_LIMIT", "NODEGRAPH_QUEUE_LIMIT", "NODEGRAPH_DEFINITION_CHANGED"].includes(error.code)) {
        root.stopped = true; root.queue = [];
        for (const instance of Object.values(root.instances)) {
          instance.stopped = true;
          for (const [nodeID, state] of Object.entries(instance.nodes)) {
            if (state.dueAtMs !== undefined && scheduler) scheduleCommand(scheduler.cancel(jobID(root, instance, { nodeID })));
            state.active = false; delete state.dueAtMs;
          }
        }
        for (const id of root.clientInstanceIDs) notify(root, "OnStopClientNodeGraph", [id]);
      }
      save(root);
      throw error;
    }
  }
  function startServerGraph(session, graphID, settings = {}) {
    const characterID = resolveSessionCharacterID(session);
    if (!characterID || !charOwner().getCharacterRecord(characterID)) throw graphError("NODEGRAPH_CHARACTER_REQUIRED");
    const ownerKey = String(settings.ownerKey || "qa");
    if (ownerKey !== "qa" && !ownerPolicies.has(ownerKey)) throw graphError("NODEGRAPH_OWNER_UNAVAILABLE");
    const graphs = coverage(Number(graphID), new Set(), [], ownerKey);
    for (const id of settings.startClientGraphIDs || []) if (!getClientGraph(id)) throw graphError("NODEGRAPH_CLIENT_GRAPH_UNAVAILABLE");
    const roots = charOwner().getCharacterRecord(characterID).serverNodeGraphs || {};
    const existing = Object.values(roots).find((root) => !root.stopped && root.graphID === Number(graphID) && root.ownerKey === String(settings.ownerKey || "qa"));
    if (existing) return resumeSession(session, existing.instanceID);
    if (Object.keys(roots).length >= 16) {
      const stopped = Object.entries(roots).filter(([, root]) => root.stopped);
      if (!stopped.length) throw graphError("NODEGRAPH_ROOT_LIMIT");
      const removed = new Set(stopped.slice(0, Object.keys(roots).length - 15).map(([id]) => id));
      const result = charOwner().updateCharacterRecord(characterID, record => ({ ...record, serverNodeGraphs: Object.fromEntries(Object.entries(record.serverNodeGraphs || {}).filter(([id]) => !removed.has(id))) }));
      if (!result.success) throw graphError("NODEGRAPH_CHECKPOINT_WRITE_FAILED");
      flush();
    }
    const id = crypto.randomUUID();
    const root = { version: 1, characterID, instanceID: id, graphID: Number(graphID), ownerKey: String(settings.ownerKey || "qa"), sceneKey: settings.sceneKey || session._space?.sceneKey || null, shipID: Number(session.shipid || session._space?.shipID || 0), sequence: 0, instances: {}, queue: [], blackboard: safeValue({ ...(settings.blackboard || {}), character_id: characterID }), publicBlackboardKeys: settings.publicBlackboardKeys || [], checkpoints: safeValue({ ...(charOwner().getCharacterRecord(characterID).serverNodeGraphCheckpoints || {}), ...(settings.checkpoints || {}) }), graphDigests: Object.fromEntries([...graphs].map((id) => [id, graphDigest(getGraph(id))])), clientInstanceIDs: [], clientGraphIDs: settings.clientGraphIDs || [], stopped: false };
    if (Object.hasOwn(settings, "sceneKey")) root.sceneKey = settings.sceneKey;
    live.set(id, { session, root });
    for (const clientGraphID of settings.startClientGraphIDs || []) attachClientGraph(root, clientGraphID);
    if (settings.clientScene !== undefined) {
      root.activeScene = safeValue(settings.clientScene); root.activeSceneMessageKey = "server_start_scene";
      for (const clientID of root.clientInstanceIDs) notify(root, "OnClientNodeGraphMessage", [clientID, "server_start_scene", root.activeScene]);
    }
    if (settings.clientTask !== undefined) {
      root.activeTask = safeValue(settings.clientTask); root.activeTaskMessageKey = "server_on_activate_task";
      for (const clientID of root.clientInstanceIDs) notify(root, "OnClientNodeGraphMessage", [clientID, root.activeTaskMessageKey, root.activeTask]);
    }
    addInstance(root, root.graphID); save(root);
    return drain(root, true);
  }
  function owned(session, id) {
    const characterID = resolveSessionCharacterID(session);
    const root = characterID ? load(characterID, String(id)) : null;
    if (!root || root.stopped) throw graphError("NODEGRAPH_INSTANCE_FORBIDDEN");
    const attached = live.get(root.instanceID);
    if (attached && attached.session !== session) throw graphError("NODEGRAPH_SESSION_STALE");
    if (root.sceneKey && root.sceneKey !== session._space?.sceneKey) throw graphError("NODEGRAPH_SCENE_STALE");
    return root;
  }
  function resumeSession(session, id) {
    const root = owned(session, id);
    coverage(root.graphID, new Set(), [], root.ownerKey);
    live.set(root.instanceID, { session, root });
    for (const instance of Object.values(root.instances)) if (!instance.stopped) for (const node of Object.values(graphFor(root, instance).nodesByID)) {
      const state = instance.nodes[node.nodeID];
      if (state?.active && state.dueAtMs !== undefined && state.dueAtMs <= now() && !root.queue.some((task) => task.instanceID === instance.instanceID && task.nodeID === node.nodeID && task.port === "due")) enqueue(root, instance, node.nodeID, null, "due");
    }
    for (const clientID of root.clientInstanceIDs) notify(root, "OnStartClientNodeGraph", [Number(clientID.split(":").pop()), clientID, clientBlackboard(root)]);
    if (root.activeScene) for (const clientID of root.clientInstanceIDs) notify(root, "OnClientNodeGraphMessage", [clientID, root.activeSceneMessageKey || "server_start_scene", root.activeScene]);
    if (root.activeTask) for (const clientID of root.clientInstanceIDs) notify(root, "OnClientNodeGraphMessage", [clientID, root.activeTaskMessageKey || "server_start_task", root.activeTask]);
    save(root); return drain(root, true);
  }
  function isClientGraphDescendant(parentID, graphID) {
    const pending = [Number(parentID)], seen = new Set();
    while (pending.length && seen.size < LIMITS.graphs * 2) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const graph = getClientGraph(id);
      if (!graph) continue;
      if (id === Number(graphID)) return true;
      // Only installed literal child graphs inherit the parent's server ID.
      // Dynamic IDs and graphs outside this authored tree confer no authority.
      for (const node of Object.values(graph.nodes || {})) {
        const child = node.nodeParameters?.node_graph_id?.value;
        if (node.nodeType === 13 && Number.isSafeInteger(child)) pending.push(child);
      }
    }
    return false;
  }
  function clientGraphAllowed(session, root, graphID) {
    const id = Number(graphID);
    const attached = root.clientGraphIDs.includes(id) || root.clientInstanceIDs.some(clientID =>
      isClientGraphDescendant(Number(clientID.split(":").pop()), id));
    return attached && ownerPolicies.get(root.ownerKey)?.authorizeClientGraph?.(session, root, id) !== false;
  }
  async function processClientMessage(session, clientGraphID, id, key, value) {
    const root = owned(session, id);
    if (!clientGraphAllowed(session, root, clientGraphID) || typeof key !== "string" || !key.startsWith("client_")) throw graphError("NODEGRAPH_CLIENT_MESSAGE_FORBIDDEN");
    const policy = ownerPolicies.get(root.ownerKey);
    if (root.ownerKey !== "qa" && (!policy || !policy.authorizeClientMessage(session, root, key, value))) throw graphError("NODEGRAPH_TASK_FORBIDDEN");
    live.set(root.instanceID, { session, root });
    const routed = policy?.routeClientMessage?.(session, root, key, safeValue(value));
    if (routed?.blackboard) for (const [name, entry] of Object.entries(safeValue(routed.blackboard))) {
      if (["character_id", "charid", "scene_key"].includes(name)) throw graphError("NODEGRAPH_IDENTITY_IMMUTABLE");
      writeBlackboard(root, name, entry);
    }
    if (!routed?.handled) dispatchMessage(root, routed?.messageKey || key, safeValue(value), true);
    save(root); await drain(root);
    return root;
  }
  function getGraphBlackboardValue(session, clientGraphID, id, key) {
    const root = owned(session, id);
    if (!clientGraphAllowed(session, root, clientGraphID) || !root.publicBlackboardKeys.includes(key)) throw graphError("NODEGRAPH_BLACKBOARD_FORBIDDEN");
    const value = key === "active_scene" ? root.activeScene : key === "active_task" ? root.activeTask : root.blackboard[key];
    return clientValue(safeValue(value ?? null));
  }
  async function stopServerGraph(session, id) {
    const root = owned(session, id); live.set(root.instanceID, { session, root });
    stopInstance(root, root.instances[root.instanceID], true); save(root); await drain(root); publish(root); live.delete(root.instanceID); return true;
  }
  function stopOwnedGraphs(characterID, ownerKey) {
    for (const stored of Object.values(charOwner().getCharacterRecord(characterID)?.serverNodeGraphs || {})) {
      if (stored.stopped || stored.ownerKey !== ownerKey) continue;
      const root = clone(stored);
      root.queue = []; root.stopped = true;
      for (const instance of Object.values(root.instances)) {
        instance.stopped = true; instance.stopping = false;
        for (const [nodeID, state] of Object.entries(instance.nodes)) {
          if (state.dueAtMs !== undefined && scheduler) scheduleCommand(scheduler.cancel(jobID(root, instance, { nodeID })));
          state.active = false; delete state.dueAtMs;
        }
      }
      for (const id of root.clientInstanceIDs) notify(root, "OnStopClientNodeGraph", [id]);
      save(root); publish(root); live.delete(root.instanceID);
    }
  }
  async function notifyEventForSession(session, atomID, parameters = {}, attached = [...live.values()].filter(entry => entry.session === session)) {
    const characterID = resolveSessionCharacterID(session);
    for (const entry of attached) {
      if (entry.session !== session || entry.root.characterID !== characterID || entry.root.stopped) continue;
      const root = load(characterID, entry.root.instanceID);
      if (!root || root.stopped) continue;
      if (root.sceneKey && root.sceneKey !== session._space?.sceneKey) continue;
      for (const instance of Object.values(root.instances)) if (!instance.stopped) for (const node of Object.values(graphFor(root, instance).nodesByID)) {
        const state = instance.nodes[node.nodeID];
        if (node.nodeTypeID !== 5 || node.atomID !== Number(atomID) || !state?.active) continue;
        const expected = resolveParameters(root, instance, node.atomParameters);
        effects.checkCharacter(instance, expected);
        if (expected.solar_system_id && Number(expected.solar_system_id) !== Number(session.solarsystemid2 || session.solarsystemid)) continue;
        // Validation getters connected to this listener read the current event.
        // Retain its previous output when the event is refused.
        const previousOutputs = state.outputs;
        state.outputs = safeValue(parameters);
        if (!(node.connections.validation || []).every(id => validate(root, instance, graphFor(root, instance).nodesByID[id], parameters))) { state.outputs = previousOutputs; continue; }
        for (const id of node.connections.validation || []) validate(root, instance, graphFor(root, instance).nodesByID[id], parameters, 0, true);
        state.outputs = safeValue(parameters);
        if (!node.nodeParameters.keep_listening) state.active = false;
        output(root, instance, node);
      }
      save(root); await drain(root); entry.root = root;
    }
  }
  async function startServerGraphNode(session, id, nodeID) {
    const root = owned(session, id), instance = root.instances[root.instanceID];
    if (!graphFor(root, instance).nodesByID[String(nodeID)]) throw graphError("NODEGRAPH_NODE_MISSING");
    live.set(root.instanceID, { session, root }); enqueue(root, instance, String(nodeID)); save(root); await drain(root); return true;
  }
  function stopServerGraphNode(session, id, nodeID) {
    const root = owned(session, id), instance = root.instances[root.instanceID];
    const node = graphFor(root, instance).nodesByID[String(nodeID)];
    if (!node) throw graphError("NODEGRAPH_NODE_MISSING");
    const state = stateFor(instance, node.nodeID);
    state.active = false; delete state.dueAtMs;
    root.queue = root.queue.filter((task) => task.instanceID !== instance.instanceID || task.nodeID !== node.nodeID);
    if (scheduler) scheduleCommand(scheduler.cancel(jobID(root, instance, node)));
    save(root); return true;
  }
  function stopServerGraphActiveNodes(session, id) {
    const root = owned(session, id);
    for (const instance of Object.values(root.instances)) for (const [nodeID, state] of Object.entries(instance.nodes)) {
      state.active = false; delete state.dueAtMs;
      if (scheduler) scheduleCommand(scheduler.cancel(jobID(root, instance, { nodeID })));
    }
    root.queue = []; save(root); return true;
  }
  async function handleJob(job) {
    const p = job.payload || {};
    if (p.rewardKey) {
      const intent = charOwner().getCharacterRecord(Number(p.characterID))?.nodeGraphRewardSettlements?.[p.rewardKey];
      if (!intent) return;
      if (intent.status === "complete") { await rewardRecovery.finish(Number(p.characterID), p.rewardKey); return; }
      const result = await require("../account/nodeGraphReward").grantTaxedIskOnce(Number(p.characterID), intent.amount, p.rewardKey, intent.giverID, { finish: rewardRecovery.finish });
      if (!result?.success) throw graphError("NODEGRAPH_REWARD_RETRY", result?.errorMsg);
      return;
    }
    const root = load(Number(p.characterID), String(p.rootID));
    if (!root || root.stopped) return;
    const instance = root.instances[p.instanceID], state = instance?.nodes?.[p.nodeID];
    if (!state?.active || state.dueAtMs !== p.dueAtMs && state.deliveryPendingAtMs !== p.dueAtMs) return;
    if (state.dueAtMs === p.dueAtMs && now() < state.dueAtMs) { scheduleDelay(root, instance, graphFor(root, instance).nodesByID[p.nodeID], state); await flushSchedulerCommands(); return; }
    const session = live.get(root.instanceID)?.session;
    // Offline timers become resumable work, never remote scene simulation.
    if (state.deliveryPendingAtMs !== p.dueAtMs) {
      enqueue(root, instance, p.nodeID, null, "due");
      state.deliveryPendingAtMs = p.dueAtMs;
      delete state.dueAtMs;
      save(root);
    }
    if (session && !session.socket?.destroyed && (!root.sceneKey || root.sceneKey === session._space?.sceneKey)) await drain(root);
  }
  async function flushSchedulerCommands() {
    while (pendingSchedulerCommands.size) await Promise.allSettled([...pendingSchedulerCommands]);
    if (schedulerFailures.length) throw schedulerFailures.shift();
  }
  async function flushPending() {
    while (characterLanes.size || publicOperations.size) await Promise.allSettled([...characterLanes.values(), ...publicOperations]);
    await flushSchedulerCommands();
  }
  function attachClientGraph(root, graphID) {
    if (!getClientGraph(graphID)) throw graphError("NODEGRAPH_CLIENT_GRAPH_UNAVAILABLE");
    const id = `${root.instanceID}:client:${graphID}`;
    if (!root.clientInstanceIDs.includes(id)) root.clientInstanceIDs.push(id);
    if (!root.clientGraphIDs.includes(Number(graphID))) root.clientGraphIDs.push(Number(graphID));
    notify(root, "OnStartClientNodeGraph", [Number(graphID), id, clientBlackboard(root)]);
  }
  function updateRootBlackboard(session, id, updates, options = {}) {
    const root = owned(session, id);
    for (const [key, value] of Object.entries(safeValue(updates))) {
      if (["character_id", "charid", "scene_key"].includes(key)) throw graphError("NODEGRAPH_IDENTITY_IMMUTABLE");
      writeBlackboard(root, key, value);
    }
    if (options.publicBlackboardKeys) {
      const keys = safeValue(options.publicBlackboardKeys);
      if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || UNSAFE_KEYS.has(key))) throw graphError("NODEGRAPH_PUBLIC_KEYS_INVALID");
      root.publicBlackboardKeys = [...new Set([...root.publicBlackboardKeys, ...keys])];
    }
    if (options.publishToClient) for (const clientID of root.clientInstanceIDs) notify(root, "OnClientNodeGraphUpdate", [clientID, clientValue(updates)]);
    live.set(root.instanceID, { session, root }); save(root);
    if (options.deferExecution) {
      if (!root.queue.length && !root.failure) publish(root);
      return root;
    }
    return drain(root);
  }
  function qaEntry(entry) { return buildDict(Object.entries({ ...entry, info: buildDict(Object.entries(entry.info)) })); }
  async function reconcile() {
    const characters = options.listCharacters ? options.listCharacters() : require("../../gameStore").read("characters", "/").data || {};
    for (const [key, record] of Object.entries(characters)) {
      const characterID = Number(record.characterID || key);
      if (!Number.isSafeInteger(characterID) || characterID <= 0 || !record.serverNodeGraphs && !record.nodeGraphRewardSettlements) continue;
      await serialized(characterID, async () => {
        for (const [rewardKey, intent] of Object.entries(charOwner().getCharacterRecord(characterID)?.nodeGraphRewardSettlements || {})) {
          if (intent.status !== "complete") await rewardRecovery.prepare(characterID, rewardKey, now());
        }
        for (const [instanceID, stored] of Object.entries(charOwner().getCharacterRecord(characterID)?.serverNodeGraphs || {})) {
          if (stored.stopped) continue;
          const root = clone(stored);
          try {
            if (root.characterID !== characterID || root.instanceID !== instanceID) throw graphError("NODEGRAPH_INSTANCE_FORBIDDEN");
            coverage(root.graphID, new Set(), [], root.ownerKey);
            for (const instance of Object.values(root.instances)) {
              graphFor(root, instance);
              for (const [nodeID, state] of Object.entries(instance.nodes)) if (state?.active && state.dueAtMs !== undefined) scheduleDelay(root, instance, { nodeID }, state);
            }
          } catch (error) {
            // A damaged saved identity may only be fenced in its own row.
            root.characterID = characterID; root.instanceID = instanceID;
            root.failure = { code: error.code || "NODEGRAPH_RECOVERY_BLOCKED", message: error.message };
            root.stopped = true; root.queue = [];
            for (const instance of Object.values(root.instances)) {
              instance.stopped = true;
              for (const [nodeID, state] of Object.entries(instance.nodes)) {
                if (state.dueAtMs !== undefined && scheduler) scheduleCommand(scheduler.cancel(jobID(root, instance, { nodeID })));
                state.active = false; delete state.dueAtMs;
              }
            }
            save(root);
          }
        }
      });
    }
    await flushPending(); return { success: true };
  }
  return {
    JOB_TYPE, startServerGraph: forSession(startServerGraph), resumeSession: forSession(resumeSession),
    processClientMessage(session, ...args) { return tracked((async () => {
      const root = await serialized(resolveSessionCharacterID(session), () => processClientMessage(session, ...args));
      // Phase advancement can start another graph; run it outside this lane.
      await ownerPolicies.get(root.ownerKey)?.afterClientMessage?.(session, root, args[2], safeValue(args[3]));
      return true;
    })()); },
    getGraphBlackboardValue, isClientGraphDescendant, stopServerGraph: forSession(stopServerGraph),
    stopOwnedGraphs: (characterID, ownerKey) => serialized(characterID, () => stopOwnedGraphs(characterID, ownerKey)),
    startServerGraphNode: forSession(startServerGraphNode), stopServerGraphNode: forSession(stopServerGraphNode), stopServerGraphActiveNodes: forSession(stopServerGraphActiveNodes),
    notifyEventForSession(session, atomID, parameters) {
      const attached = [...live.values()].filter(entry => entry.session === session);
      return serialized(resolveSessionCharacterID(session), () => notifyEventForSession(session, atomID, parameters, attached));
    },
    handleJob: (job) => serialized(Number(job.payload?.characterID), () => handleJob(job)), reconcile, flushPending, updateRootBlackboard: forSession(updateRootBlackboard),
    bindDurableScheduler(value) { scheduler = value; },
    unbindDurableScheduler(value) { if (scheduler === value) scheduler = null; },
    detachSession(session) { qaObservers.delete(session); for (const [id, entry] of live) if (entry.session === session) live.delete(id); },
    subscribeQa(session, authorize) { qaObservers.set(session, authorize); },
    unsubscribeQa(session) { qaObservers.delete(session); },
    getQaLogSnapshot(session) { return buildDict(Object.values(charOwner().getCharacterRecord(resolveSessionCharacterID(session))?.serverNodeGraphs || {}).map((root) => [root.instanceID, buildList((root.qaLogs || []).map(qaEntry))])); },
    registerAtom(nodeTypeID, atomID, handler, supports) {
      const key = `${nodeTypeID}:${atomID}`;
      if (![4, 30].includes(nodeTypeID) || extensions.has(key) || typeof handler !== "function" || (nodeTypeID !== 4 && handler.constructor.name === "AsyncFunction")) throw graphError("NODEGRAPH_HANDLER_INVALID", key);
      if (supports !== undefined && typeof supports !== "function") throw graphError("NODEGRAPH_HANDLER_INVALID", key);
      handler.supports = supports;
      extensions.set(key, handler); return () => extensions.delete(key);
    },
    registerOwnerPolicy(ownerKey, policy) {
      if (!ownerKey || ownerKey === "qa" || ownerPolicies.has(ownerKey) || typeof policy?.authorizeClientMessage !== "function") throw graphError("NODEGRAPH_POLICY_INVALID");
      ownerPolicies.set(ownerKey, policy); return () => ownerPolicies.delete(ownerKey);
    },
    inspectSupport(graphID, ownerKey = "qa") { try { return { supported: true, graphs: [...coverage(Number(graphID), new Set(), [], ownerKey)] }; } catch (error) { return { supported: false, code: error.code, reason: error.message }; } },
    listForSession(session) { return Object.values(charOwner().getCharacterRecord(resolveSessionCharacterID(session))?.serverNodeGraphs || {}).map(clone); },
    resetForTests() { live.clear(); qaObservers.clear(); scheduler = null; },
    setNowProvider(provider) { now = provider || Date.now; },
  };
}

const runtime = createNodeGraphRuntime();
require("./nodeGraphEvents").subscribe((session, atomID, parameters) => runtime.notifyEventForSession(session, atomID, parameters));
module.exports = { ...runtime, createNodeGraphRuntime, NODE_TYPES };
