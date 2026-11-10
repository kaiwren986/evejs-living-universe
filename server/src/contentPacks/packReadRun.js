"use strict";

// Adapted from ciefa/evejs-ciefa-fork ca46991f9. A cache belongs to one
// synchronous import, never to another engine invocation or a mutable stat key.
// Every read still reads/hashes the current bytes. Only identical bytes share
// their parsed object and full validation; no on-disk ledger can bypass checks.
function openPackRun() {
  return {
    loadedByDigest: new Map(),
    preflightByRegistry: new Map(),
    basePayload: null,
    stats: { packReads: 0, bytesRead: 0, packsParsed: 0, packsReused: 0,
      baseReads: 0, preflightMerges: 0, preflightsReused: 0 },
  };
}

function registryKey(registry) {
  return JSON.stringify(registry.installed
    .map(({ id, version, packSha256 }) => [id, version, packSha256])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function memoBasePayload(run, read) {
  if (run.basePayload === null) {
    run.basePayload = { value: read() };
    run.stats.baseReads += 1;
  }
  return run.basePayload.value;
}

module.exports = { openPackRun, registryKey, memoBasePayload };
