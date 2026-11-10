"use strict";

// Carbon's literal and connection forms, adapted from the John compiler.
// Literal strings are data: never evaluate them as JavaScript or Python.
const { isDeepStrictEqual } = require("node:util");
const { atomsByID: nativeAtomSignatures } = require("./nativeAtomSignatures.json");

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const LIMITS = Object.freeze({ nodes: 1024, edges: 8192, depth: 32, bytes: 1048576, steps: 4096, graphs: 64 });
const NODE_PORTS = Object.freeze({
  1: ["output"], 4: ["output"], 5: ["output", "validation"],
  7: ["validation", "on_success", "on_failure"], 9: ["on_success", "on_failure"],
  10: ["output"], 12: [], 13: ["on_start", "on_stop"], 17: ["output"],
  18: [], 19: ["output"], 20: ["output"], 21: ["output", "validation"],
  22: ["on_success", "on_failure"], 24: ["nodes", "output"], 30: [],
  31: ["output", "validation"], 32: ["output"], 39: ["output"],
  40: ["output"], 42: ["output"], 44: [], 49: ["output"], 65: ["output"],
});

function graphError(code, detail = "") {
  const error = new Error(`${code}${detail ? `: ${detail}` : ""}`);
  error.code = code;
  return error;
}

// Native nodegraph.common.util.get_object_value_by_path, restricted to the
// serialized data values admitted by safeValue. Never traverse JS prototypes.
function getObjectValueByPath(object, path, defaultValue = null) {
  const keys = typeof path === "string" ? (path.length ? path.split(".") : []) : Array.isArray(path) ? path : [path];
  let result = object;
  for (const key of keys) {
    // Serialized dictionaries have string keys. Python does not coerce0 or
    // False into those strings, and list/dict keys are unhashable. Preserve
    // that distinction instead of invoking JavaScript property coercion.
    if (key !== null && typeof key === "object") return defaultValue;
    if (UNSAFE_KEYS.has(String(key))) throw graphError("NODEGRAPH_UNSAFE_KEY", String(key));
    if (Array.isArray(result)) {
      if (typeof key !== "boolean" && !(typeof key === "number" && Number.isFinite(key)) &&
          !(typeof key === "string" && /^[+-]?\d+$/.test(key.trim()))) return defaultValue;
      let index = Math.trunc(Number(key));
      if (index < 0) index += result.length;
      if (!Object.hasOwn(result, index)) return defaultValue;
      result = result[index];
    } else if (result && typeof result === "object") {
      result = typeof key === "string" && Object.hasOwn(result, key) ? result[key] : defaultValue;
    } else {
      if (typeof key !== "string") return defaultValue;
      result = defaultValue;
    }
  }
  return result;
}

function safeValue(value, depth = 0) {
  if (depth > LIMITS.depth) throw graphError("NODEGRAPH_VALUE_DEPTH");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= LIMITS.bytes) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => safeValue(entry, depth + 1));
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw graphError("NODEGRAPH_UNSAFE_KEY", key);
      result[key] = safeValue(entry, depth + 1);
    }
    return result;
  }
  throw graphError("NODEGRAPH_INVALID_VALUE");
}

function parseLiteralValue(input) {
  if (typeof input !== "string") return safeValue(input);
  const text = input.trim();
  if (!/^(?:[\[({"']|None$|True$|False$|null$|true$|false$|[-+]?\d)/.test(text)) return input;
  let offset = 0;
  const skip = () => { while (/\s/.test(text[offset] || "") && offset < text.length) offset++; };
  const read = (depth = 0) => {
    if (depth > LIMITS.depth) throw graphError("NODEGRAPH_VALUE_DEPTH");
    skip();
    const c = text[offset++];
    if (c === '"' || c === "'") {
      let value = "";
      while (offset < text.length) {
        const next = text[offset++];
        if (next === c) return value;
        if (next !== "\\") { value += next; continue; }
        const escape = text[offset++];
        if (escape === "u") {
          const hex = text.slice(offset, offset + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex)) throw graphError("NODEGRAPH_LITERAL_INVALID");
          value += String.fromCharCode(parseInt(hex, 16)); offset += 4;
        } else {
          const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", "'": "'", '"': '"', "/": "/" };
          if (!(escape in escapes)) throw graphError("NODEGRAPH_LITERAL_INVALID");
          value += escapes[escape];
        }
      }
      throw graphError("NODEGRAPH_LITERAL_INVALID");
    }
    if (c === "[" || c === "(" || c === "{") {
      const close = { "[": "]", "(": ")", "{": "}" }[c];
      const values = c === "{" ? {} : [];
      skip();
      while (text[offset] !== close) {
        const value = read(depth + 1); skip();
        if (c === "{") {
          if (typeof value !== "string" || UNSAFE_KEYS.has(value) || text[offset++] !== ":") throw graphError("NODEGRAPH_LITERAL_INVALID");
          values[value] = read(depth + 1); skip();
        } else values.push(value);
        if (text[offset] === close) break;
        if (text[offset++] !== ",") throw graphError("NODEGRAPH_LITERAL_INVALID");
        skip();
      }
      offset++;
      return values;
    }
    offset--;
    const scalar = /^(?:None|True|False|null|true|false|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/.exec(text.slice(offset));
    if (!scalar) throw graphError("NODEGRAPH_LITERAL_INVALID");
    offset += scalar[0].length;
    const known = { None: null, null: null, True: true, true: true, False: false, false: false };
    return Object.hasOwn(known, scalar[0]) ? known[scalar[0]] : Number(scalar[0]);
  };
  try {
    const value = read(); skip();
    if (offset !== text.length) return input;
    return safeValue(value);
  } catch (error) {
    // Ordinary authored text may begin with a digit or bracket. Invalid literal
    // text stays text; executable-looking text never becomes executable code.
    if (error.code === "NODEGRAPH_VALUE_DEPTH") throw error;
    return input;
  }
}

function compareValues(left, right, operator = "equalTo", flipped = false) {
  left = parseLiteralValue(left); right = parseLiteralValue(right);
  if (flipped) [left, right] = [right, left];
  switch (operator) {
    case "equalTo": case "==": return isDeepStrictEqual(left, right);
    case "notEqualTo": case "!=": return !isDeepStrictEqual(left, right);
    case "greaterThan": case ">": return typeof left === "number" && typeof right === "number" && left > right;
    case "greaterThanOrEqual": case "greaterThanOrEqualTo": case ">=": return typeof left === "number" && typeof right === "number" && left >= right;
    case "lessThan": case "<": return typeof left === "number" && typeof right === "number" && left < right;
    case "lessThanOrEqual": case "lessThanOrEqualTo": case "<=": return typeof left === "number" && typeof right === "number" && left <= right;
    case "in": return Array.isArray(right) ? right.some((entry) => isDeepStrictEqual(left, entry)) : typeof right === "string" && typeof left === "string" ? right.includes(left) : false;
    case "notIn": return !compareValues(left, right, "in");
    default: throw graphError("NODEGRAPH_OPERATOR_UNSUPPORTED", operator);
  }
}

function compileParameterValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Object.hasOwn(value, "connection")) {
      return { kind: "connection", nodeID: String(value.connection.node || ""), parameterKey: String(value.connection.parameter || "") };
    }
    if (Object.keys(value).length === 1 && Object.hasOwn(value, "value")) return safeValue(value.value);
  }
  return safeValue(value);
}

function compileGraphDefinition(rawGraph) {
  const raw = safeValue(rawGraph);
  if (Buffer.byteLength(JSON.stringify(raw)) > LIMITS.bytes) throw graphError("NODEGRAPH_SIZE_LIMIT");
  const graphID = Number(raw.graphID);
  if (!Number.isSafeInteger(graphID) || graphID <= 0) throw graphError("NODEGRAPH_ID_INVALID");
  const definitions = raw.nodesByID || raw.nodes;
  if (!definitions || !Object.keys(definitions).length || Object.keys(definitions).length > LIMITS.nodes) throw graphError("NODEGRAPH_NODE_LIMIT");
  const nodesByID = {};
  let edges = 0;
  for (const [nodeID, definition] of Object.entries(definitions)) {
    const parameters = (values) => Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, compileParameterValue(value)]));
    const node = {
      nodeID, nodeTypeID: Number(definition.nodeTypeID || definition.nodeType),
      nodeParameters: parameters(definition.nodeParameters), atomParameters: parameters(definition.atomParameters),
      connections: {}, incomingSourceNodeIDs: [],
    };
    node.atomID = Number(node.nodeParameters.atom_id || 0);
    const signature = node.nodeTypeID === 30 && nativeAtomSignatures[node.atomID];
    if (signature) {
      for (const key of Object.keys(node.atomParameters)) {
        if (!Object.hasOwn(signature.inputs, key)) throw graphError("NODEGRAPH_ATOM_PARAMETER_UNSUPPORTED", `${node.atomID}/${key}`);
      }
      for (const [key, parameter] of Object.entries(signature.inputs)) {
        if (!Object.hasOwn(node.atomParameters, key) && Object.hasOwn(parameter, "defaultValue")) {
          node.atomParameters[key] = safeValue(parameter.defaultValue);
        }
      }
    }
    for (const [port, targets] of Object.entries(definition.connections || {})) {
      if (NODE_PORTS[node.nodeTypeID] && !NODE_PORTS[node.nodeTypeID].includes(port)) throw graphError("NODEGRAPH_PORT_UNSUPPORTED", `${nodeID}/${port}`);
      if (!Array.isArray(targets)) throw graphError("NODEGRAPH_CONNECTION_INVALID", nodeID);
      edges += targets.length;
      node.connections[port] = targets.map(String);
    }
    nodesByID[nodeID] = node;
  }
  if (edges > LIMITS.edges) throw graphError("NODEGRAPH_EDGE_LIMIT");
  for (const node of Object.values(nodesByID)) {
    for (const [port, targets] of Object.entries(node.connections)) for (const target of targets) {
      if (!nodesByID[target]) throw graphError("NODEGRAPH_CONNECTION_MISSING", target);
      if (!["validation", "nodes"].includes(port)) nodesByID[target].incomingSourceNodeIDs.push(node.nodeID);
    }
    for (const value of [...Object.values(node.nodeParameters), ...Object.values(node.atomParameters)]) {
      if (value && value.kind === "connection" && (!nodesByID[value.nodeID] || UNSAFE_KEYS.has(value.parameterKey))) throw graphError("NODEGRAPH_VALUE_CONNECTION_INVALID", node.nodeID);
    }
  }
  const rootNodeIDs = Object.values(nodesByID).filter((node) => node.nodeTypeID === 1).map((node) => node.nodeID);
  if (!rootNodeIDs.length) throw graphError("NODEGRAPH_ROOT_REQUIRED");
  const visitValidation = (id, stack = []) => {
    if (stack.includes(id) || stack.length >= LIMITS.depth) throw graphError("NODEGRAPH_VALIDATION_CYCLE");
    const node = nodesByID[id];
    for (const childID of node.connections.validation || []) {
      if (![7, 9, 22].includes(nodesByID[childID].nodeTypeID)) throw graphError("NODEGRAPH_VALIDATION_TARGET_INVALID");
      visitValidation(childID, [...stack, id]);
    }
  };
  for (const id of Object.keys(nodesByID)) visitValidation(id);
  const visitGetter = (id, stack = []) => {
    const node = nodesByID[id];
    if (![18, 30].includes(node.nodeTypeID)) return;
    if (stack.includes(id) || stack.length >= LIMITS.depth) throw graphError("NODEGRAPH_GETTER_CYCLE");
    for (const value of [...Object.values(node.nodeParameters), ...Object.values(node.atomParameters)]) {
      if (value?.kind === "connection") visitGetter(value.nodeID, [...stack, id]);
    }
  };
  for (const id of Object.keys(nodesByID)) visitGetter(id);
  return { graphID, name: String(raw.name || ""), tags: raw.tags || [], nodesByID, rootNodeIDs };
}

module.exports = { LIMITS, NODE_PORTS, UNSAFE_KEYS, safeValue, parseLiteralValue, compareValues, compileGraphDefinition, graphError, getObjectValueByPath };
