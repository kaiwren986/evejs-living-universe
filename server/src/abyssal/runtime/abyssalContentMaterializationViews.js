"use strict";
const { toInt, normalizeText } = require("../domain/abyssalRuntimeValues");

function summarizeContentSummary(ports, contentSummary = null) {
  const summary = contentSummary && typeof contentSummary === "object"
    ? contentSummary
    : {};
  return {
    containersSpawned: toInt(summary.containersSpawned, 0),
    hazardsSpawned: toInt(summary.hazardsSpawned, 0),
    environmentPropsSpawned: toInt(summary.environmentPropsSpawned, 0),
    miningRocksSpawned: toInt(summary.miningRocksSpawned, 0),
    gatesSpawned: toInt(summary.gatesSpawned, 0),
    objectivesSpawned: toInt(summary.objectivesSpawned, 0),
    encountersSpawned: toInt(summary.encountersSpawned, 0),
  };
}

function countMaterializedContent(ports, contentSummary = null) {
  const summary = summarizeContentSummary(ports, contentSummary);
  return (
    summary.containersSpawned +
    summary.hazardsSpawned +
    summary.environmentPropsSpawned +
    summary.miningRocksSpawned +
    summary.gatesSpawned +
    summary.objectivesSpawned +
    summary.encountersSpawned
  );
}

function shouldAttemptAuthoredSiteMaterialization(ports, pocketState) {
  const {
    PLACEHOLDER_POCKET_MODE,
  } = ports;
  const instance = pocketState && pocketState.instance;
  const runtimeFlags = instance && instance.runtimeFlags && typeof instance.runtimeFlags === "object"
    ? instance.runtimeFlags
    : {};
  const metadata = instance && instance.metadata && typeof instance.metadata === "object"
    ? instance.metadata
    : {};
  const placeholderMode = normalizeText(
    pocketState && pocketState.placeholderMode,
    normalizeText(metadata.placeholderMode, ""),
  );
  return (
    runtimeFlags.abyssalPlaceholder !== true &&
    placeholderMode !== PLACEHOLDER_POCKET_MODE
  );
}

function createAbyssalContentMaterializationViews(ports) {
  return {
    summarizeContentSummary: summarizeContentSummary.bind(null, ports),
    countMaterializedContent: countMaterializedContent.bind(null, ports),
    shouldAttemptAuthoredSiteMaterialization: shouldAttemptAuthoredSiteMaterialization.bind(null, ports),
  };
}

module.exports = { createAbyssalContentMaterializationViews };
