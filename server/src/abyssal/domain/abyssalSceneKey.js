"use strict";

// The one place that knows what an Abyssal scene key looks like.
//
// THE PROBLEM THIS SOLVES
//
// The `abyssal-run:<id>` format was hand-built or hand-parsed in ~30 places
// across a dozen files, under three mutually inconsistent rules:
//
//   /^abyssal-run:(\d+)$/        17 sites - accepts abyssal-run:0 and :007
//   /^abyssal-run:([1-9]\d*)$/    4 sites - rejects both
//   .startsWith("abyssal-run:")   9 sites - accepts abyssal-run:abc and :<empty>
//
// Those disagree on real inputs. Because instanceID 0 means "no run", the
// permissive spellings let a scene claim Abyssal authority while identifying no
// run at all, and the prefix checks accept keys that carry no id whatsoever.
//
// Rather than silently pick a winner and change ~30 behaviours at once, this
// module names all three intents so a call site has to say which it means:
//
//   parseAbyssalRunID   - lenient read, returns 0 when there is no usable id
//   isAbyssalSceneKey   - strict: a well-formed key naming a POSITIVE run
//   hasAbyssalSceneKeyPrefix - the loose prefix test, named so its looseness shows
//
// Migrate call sites deliberately, one at a time, choosing the intent rather
// than inheriting whichever regex was copy-pasted. See
// doc/abyssal/target-architecture.md.

const ABYSSAL_SCENE_KEY_PREFIX = "abyssal-run:";

// Canonical form. Leading zeros are never produced, so a built key always
// round-trips through parseAbyssalRunID unchanged.
const ABYSSAL_SCENE_KEY_PATTERN = /^abyssal-run:([1-9]\d*)$/;

// Lenient form, matching the majority of existing call sites: any run of digits,
// including 0 and values with leading zeros.
const ABYSSAL_SCENE_KEY_LENIENT_PATTERN = /^abyssal-run:(\d+)$/;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Returns "" for a non-positive run, because there is no such thing as a scene
// key for "no run" - callers should treat "" as "not in an Abyssal scene".
function buildAbyssalSceneKey(runID) {
  const numericRunID = toInt(runID, 0);
  return numericRunID > 0 ? `${ABYSSAL_SCENE_KEY_PREFIX}${numericRunID}` : "";
}

// Lenient read: returns the run id, or 0 when the key is absent, malformed, or
// names run 0. Use when you want "which run, if any?" and 0 is a safe answer.
function parseAbyssalRunID(sceneKey) {
  const match = ABYSSAL_SCENE_KEY_LENIENT_PATTERN.exec(String(sceneKey || "").trim());
  return match ? toInt(match[1], 0) : 0;
}

// Strict test: a well-formed key naming a positive run. Use when the answer
// gates authority - "may this scene impose Abyssal rules?".
function isAbyssalSceneKey(sceneKey) {
  return ABYSSAL_SCENE_KEY_PATTERN.test(String(sceneKey || "").trim());
}

// Loose test, preserved because ~9 call sites rely on it. Accepts
// "abyssal-run:abc" and a bare "abyssal-run:". Named so that is visible at the
// call site rather than hidden inside a startsWith.
function hasAbyssalSceneKeyPrefix(sceneKey) {
  return String(sceneKey || "").trim().toLowerCase().startsWith(ABYSSAL_SCENE_KEY_PREFIX);
}

const ABYSSAL_SCENE_KIND = "abyssal";

// Mirrors the nested toInt(a, toInt(b, toInt(c, 0))) chain the call sites used.
//
// This is "first DEFINED", not "first truthy", and the distinction is load
// bearing: Number(0) is finite, so an explicit 0 wins and later candidates are
// never consulted, whereas undefined falls through. Rewriting this as a
// first-truthy scan silently changes which id a scene reports when the primary
// source says 0.
function resolveFirstDefinedInt(candidates) {
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric);
    }
  }
  return 0;
}

// Shared core for scene-authority resolution. A source claims Abyssal authority
// if it declares the Abyssal scene kind OR carries a parseable run key.
function resolveAbyssalSceneAuthority({ sceneKind, sceneKey, instanceIDCandidates = [] }) {
  const normalizedKind = String(sceneKind || "").trim();
  const normalizedKey = String(sceneKey || "").trim();
  const claimsByKey = ABYSSAL_SCENE_KEY_LENIENT_PATTERN.test(normalizedKey);

  if (normalizedKind !== ABYSSAL_SCENE_KIND && !claimsByKey) {
    return null;
  }

  return {
    instanceID: resolveFirstDefinedInt([
      ...instanceIDCandidates,
      parseAbyssalRunID(normalizedKey),
    ]),
    sceneKey: normalizedKey,
  };
}

// Reads the scene key off a session, honouring both places it can live.
function readSessionSceneKey(session) {
  return String(
    session && session._space && session._space.sceneKey ||
    session && session.spaceSceneKey ||
    "",
  ).trim();
}

// SECOND scene-authority variant, preserved because several ship-side call sites
// use it and it is NOT equivalent to resolveAbyssalSceneAuthority.
//
// The difference is the id chain. This one is FIRST TRUTHY over two sources
// (`toInt(_space.instanceID, 0) || toInt(keyID, 0)`), so:
//
//   - an explicit _space.instanceID of 0 falls through to the key id, where the
//     runtime variant would report 0
//   - session.spaceInstanceID is never consulted at all
//
// Those are real divergences on real inputs, not style. They are named rather
// than unified because unifying them changes which run a session is judged to be
// in - a gameplay decision. See note S3-7 of the 2026-08-03 review, kept in git history.
function resolveAbyssalSessionSceneAuthorityTruthy(session) {
  const sceneKey = readSessionSceneKey(session);
  const claimsByKey = ABYSSAL_SCENE_KEY_LENIENT_PATTERN.test(sceneKey);
  const sceneKind = String(
    session && session._space && session._space.sceneKind || "",
  ).trim();
  if (sceneKind !== ABYSSAL_SCENE_KIND && !claimsByKey) {
    return null;
  }
  const instanceID =
    toInt(session && session._space && session._space.instanceID, 0) ||
    parseAbyssalRunID(sceneKey);
  return { instanceID, sceneKey };
}

module.exports = {
  ABYSSAL_SCENE_KEY_PREFIX,
  readSessionSceneKey,
  resolveAbyssalSessionSceneAuthorityTruthy,
  ABYSSAL_SCENE_KEY_PATTERN,
  ABYSSAL_SCENE_KEY_LENIENT_PATTERN,
  ABYSSAL_SCENE_KIND,
  buildAbyssalSceneKey,
  parseAbyssalRunID,
  isAbyssalSceneKey,
  hasAbyssalSceneKeyPrefix,
  resolveFirstDefinedInt,
  resolveAbyssalSceneAuthority,
};
