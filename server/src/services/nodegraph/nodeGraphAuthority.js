"use strict";

const { readStaticJsonTable } = require("../_shared/staticJsonTableReader");
const { compileGraphDefinition, graphError } = require("./nodeGraphCompiler");
let payload = null;
const compiled = new Map();

function getPayload() {
  if (!payload) {
    const result = readStaticJsonTable("dungeonAuthority");
    if (!result.success) throw graphError("NODEGRAPH_AUTHORITY_UNAVAILABLE");
    payload = result.data;
  }
  return payload;
}

function getGraphDefinition(graphID) {
  const id = Number(graphID);
  if (compiled.has(id)) return compiled.get(id);
  const raw = getPayload().clientData?.tables?.nodeGraphsByID?.[id];
  if (!raw) throw graphError("NODEGRAPH_NOT_FOUND", String(graphID));
  if (!(raw.tags || []).includes("server")) throw graphError("NODEGRAPH_SERVER_GRAPH_REQUIRED", String(graphID));
  const graph = compileGraphDefinition({ ...raw, graphID: id });
  compiled.set(id, graph);
  return graph;
}

function getClientGraphDefinition(graphID) {
  const raw = getPayload().clientData?.tables?.nodeGraphsByID?.[Number(graphID)];
  return raw && (raw.tags || []).includes("client") ? raw : null;
}

function listGraphIDs() { return Object.keys(getPayload().clientData?.tables?.nodeGraphsByID || {}).map(Number); }
function clearCache() { payload = null; compiled.clear(); }

module.exports = { getGraphDefinition, getClientGraphDefinition, listGraphIDs, clearCache };
