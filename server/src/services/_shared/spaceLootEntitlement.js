"use strict";

/**
 * Shared loot entitlement for player-facing wreck / space-container access.
 *
 * Server mirror of the client's loot-right check: a pilot may take from a
 * wreck or space container they own, from debris whose owner is not a player
 * character, from something explicitly abandoned, or under their corporation
 * or fleet loot rights. Anything else is theft and must run through
 * `crimewatchState.evaluateContainerTheft` before it is allowed, then record a
 * suspect consequence once the take actually happens.
 *
 * Both the item-level loot path (invbroker Add/MultiAdd) and the container
 * scoop path (`cargoContainerRuntime`) resolve rights here so the two cannot
 * drift apart: dragging one item out of a can and swallowing the whole can
 * have to answer to the same rule set.
 *
 * `characterState`, `fleetRuntime`, and `crimewatchState` are required lazily
 * because both callers sit below them in the module graph.
 */

const path = require("path");

const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "./sessionIdentity"));

const LOOT_CUSTOM_INFO_KEY = "evejsLoot";
const LOOT_RIGHTS_SNAPSHOT_VERSION = 1;
const PROTECTED_PROPERTY_CORPORATION_ID_KEY =
  "protectedPropertyCorporationID";

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function getCharacterState() {
  try {
    return require(path.join(__dirname, "../character/characterState"));
  } catch (_error) {
    // ignored: the character state is not loaded in this process (null)
    return null;
  }
}

function getFleetRuntime() {
  try {
    return require(path.join(__dirname, "../fleets/fleetRuntime"));
  } catch (_error) {
    // ignored: the fleet runtime is not loaded in this process (null)
    return null;
  }
}

function isPlayerCorporationID(corporationID) {
  const normalizedCorporationID = toInt(corporationID, 0);
  if (normalizedCorporationID <= 0) {
    return false;
  }
  try {
    const corporationState = require(path.join(
      __dirname,
      "../corporation/corporationState",
    ));
    return Boolean(
      corporationState &&
      typeof corporationState.isNpcCorporationID === "function" &&
      !corporationState.isNpcCorporationID(normalizedCorporationID)
    );
  } catch (_error) {
    // ignored: corporation membership is a grant, so an unavailable authority must not
    // turn into a fail-open loot right.
    return false;
  }
}

function isAuthoritativePlayerCorporationID(corporationID) {
  const normalizedCorporationID = toInt(corporationID, 0);
  if (!isPlayerCorporationID(normalizedCorporationID)) {
    return false;
  }
  try {
    const corporationState = require(path.join(
      __dirname,
      "../corporation/corporationState",
    ));
    if (
      !corporationState ||
      typeof corporationState.getCorporationRecord !== "function"
    ) {
      return false;
    }
    const record = corporationState.getCorporationRecord(
      normalizedCorporationID,
    );
    return Boolean(record && record.isNPC === false && !record.deleted);
  } catch (_error) {
    // ignored: an unreadable corporation record is not a player corporation, so no corporation loot right (fail closed)
    return false;
  }
}

function getCrimewatchState() {
  return require(path.join(__dirname, "../security/crimewatchState"));
}

function getSpaceRuntime() {
  try {
    return require(path.join(__dirname, "../../space/runtime"));
  } catch (_error) {
    // ignored: the space runtime is not loaded in this process (null)
    return null;
  }
}

function getCharacterRecordSafe(characterID) {
  const normalizedCharacterID = toInt(characterID, 0);
  if (normalizedCharacterID <= 0) {
    return null;
  }
  const characterState = getCharacterState();
  if (
    !characterState ||
    typeof characterState.getCharacterRecord !== "function"
  ) {
    return null;
  }
  try {
    return characterState.getCharacterRecord(normalizedCharacterID) || null;
  } catch (_error) {
    // ignored: an unreadable character record counts as none (null)
    return null;
  }
}

function firstPositiveInt(values) {
  for (const value of values) {
    const normalized = toInt(value, 0);
    if (normalized > 0) {
      return normalized;
    }
  }
  return 0;
}

function hasAuthoritativeSpaceLootRightsSnapshot(lootInfo) {
  return toInt(
    lootInfo && lootInfo.rightsSnapshotVersion,
    0,
  ) >= LOOT_RIGHTS_SNAPSHOT_VERSION;
}

/**
 * Build the immutable character context used to decide corporation and fleet
 * loot access for newly-created space inventory.  A null fleet ID is
 * intentional: together with rightsSnapshotVersion it means the owner was not
 * in a fleet at creation and must not grant rights to a fleet joined later.
 */
function buildSpaceLootRightsSnapshot(context = {}) {
  const corporationID = toInt(context.corporationID, 0);
  const lootRightCorpID =
    toInt(context.lootRightCorpID, 0) || corporationID;
  const lootRightFleetID = toInt(
    context.lootRightFleetID ?? context.fleetID,
    0,
  );
  const snapshot = {
    rightsSnapshotVersion: LOOT_RIGHTS_SNAPSHOT_VERSION,
    abandoned: context.abandoned === true,
    lootRightFleetID: lootRightFleetID > 0 ? lootRightFleetID : null,
  };
  if (corporationID > 0) {
    snapshot.corporationID = corporationID;
  }
  if (lootRightCorpID > 0) {
    snapshot.lootRightCorpID = lootRightCorpID;
  }
  const allianceID = toInt(context.allianceID, 0);
  if (allianceID > 0) {
    snapshot.allianceID = allianceID;
  }
  const warFactionID = toInt(context.warFactionID, 0);
  if (warFactionID > 0) {
    snapshot.warFactionID = warFactionID;
  }
  return snapshot;
}

/**
 * Build the narrow authority descriptor used by corporation-owned space
 * property. This is intentionally separate from character loot snapshots:
 * corporation property has no character owner surrogate and grants no fleet
 * right.
 */
function buildProtectedCorporationSpaceLootInfo(corporationID) {
  const normalizedCorporationID = toInt(corporationID, 0);
  if (!isAuthoritativePlayerCorporationID(normalizedCorporationID)) {
    return null;
  }
  return {
    rightsSnapshotVersion: LOOT_RIGHTS_SNAPSHOT_VERSION,
    abandoned: false,
    corporationID: normalizedCorporationID,
    lootRightCorpID: normalizedCorporationID,
    lootRightFleetID: null,
    [PROTECTED_PROPERTY_CORPORATION_ID_KEY]: normalizedCorporationID,
  };
}

/**
 * Resolve the current character context once, at wreck/container creation.
 * Consumers persist the returned values and must not call this at access time.
 */
function resolveCharacterSpaceLootContext(characterID, options = {}) {
  const normalizedCharacterID = toInt(characterID, 0);
  const session = options.session || null;
  const sessionCharacter = session && session._character || {};
  const characterRecord = options.characterRecord !== undefined
    ? options.characterRecord || {} : getCharacterRecordSafe(normalizedCharacterID) || {};
  const context = {
    corporationID: firstPositiveInt([
      options.corporationID,
      session && (session.corporationID ?? session.corpid ?? session.corpID),
      sessionCharacter.corporationID ?? sessionCharacter.corpid,
      characterRecord.corporationID ?? characterRecord.corpid,
    ]),
    allianceID: firstPositiveInt([
      options.allianceID,
      session && (session.allianceID ?? session.allianceid),
      sessionCharacter.allianceID ?? sessionCharacter.allianceid,
      characterRecord.allianceID ?? characterRecord.allianceid,
    ]),
    warFactionID: firstPositiveInt([
      options.warFactionID,
      session && (session.warFactionID ?? session.warfactionid),
      sessionCharacter.warFactionID ?? sessionCharacter.warfactionid,
      characterRecord.warFactionID ??
        characterRecord.warfactionid ??
        characterRecord.factionID,
    ]),
    fleetID: firstPositiveInt([
      options.lootRightFleetID,
      options.fleetID,
      session && (session.fleetid ?? session.fleetID),
      sessionCharacter.fleetid ?? sessionCharacter.fleetID,
    ]),
  };

  if (context.fleetID <= 0 && normalizedCharacterID > 0) {
    const fleetRuntime = getFleetRuntime();
    const fleetState =
      session &&
      fleetRuntime &&
      typeof fleetRuntime.getSessionFleetState === "function"
        ? fleetRuntime.getSessionFleetState(session)
        : null;
    const fleet =
      fleetRuntime &&
      typeof fleetRuntime.getFleetForCharacter === "function"
        ? fleetRuntime.getFleetForCharacter(normalizedCharacterID)
        : null;
    context.fleetID = firstPositiveInt([
      fleetState && (fleetState.fleetid ?? fleetState.fleetID),
      fleet && fleet.fleetID,
      fleetRuntime &&
      fleetRuntime.runtimeState &&
      fleetRuntime.runtimeState.characterToFleet instanceof Map
        ? fleetRuntime.runtimeState.characterToFleet.get(normalizedCharacterID)
        : 0,
    ]);
  }

  return context;
}

// The client treats anything that is not a player owner as free-for-all
// debris. Space wrecks and containers only ever carry a character ownerID
// here, so "resolves to no character record" is exactly "not a player owner":
// NPC corporation, faction, and agent owners all fall through, and so does an
// unowned (0) wreck. Keeping this on the entitlement side rather than the
// classifier means NPC debris never reaches crimewatch at all.
function isPlayerCharacterOwner(ownerID) {
  return Boolean(getCharacterRecordSafe(ownerID));
}

function readSpaceLootInfo(customInfo) {
  if (!customInfo) {
    return {};
  }
  let parsed = null;
  if (typeof customInfo === "object" && !Array.isArray(customInfo)) {
    parsed = customInfo;
  } else {
    try {
      parsed = JSON.parse(String(customInfo));
    } catch (_error) {
      // ignored: unreadable customInfo counts as empty
      return {};
    }
  }
  const lootInfo = parsed && parsed[LOOT_CUSTOM_INFO_KEY];
  return lootInfo && typeof lootInfo === "object" && !Array.isArray(lootInfo)
    ? lootInfo
    : {};
}

/**
 * Normalize an inventory row (wreck, jetcan, deployed container) into the
 * descriptor the entitlement rules below consume.
 */
function buildSpaceLootSourceFromItem(item) {
  if (!item) {
    return null;
  }
  return {
    itemID: toInt(item.itemID, 0),
    ownerID: toInt(item.ownerID, 0),
    locationID: toInt(item.locationID, 0),
    lootInfo: readSpaceLootInfo(item.customInfo),
  };
}

function resolveProtectedPropertyCorporationID(source) {
  const lootInfo = (source && source.lootInfo) || {};
  const corporationID = toInt(
    lootInfo[PROTECTED_PROPERTY_CORPORATION_ID_KEY],
    0,
  );
  if (
    corporationID <= 0 ||
    corporationID !== toInt(source && source.ownerID, 0)
  ) {
    return 0;
  }
  try {
    const corporationState = require(path.join(
      __dirname,
      "../corporation/corporationState",
    ));
    if (
      corporationState &&
      typeof corporationState.isNpcCorporationID === "function" &&
      corporationState.isNpcCorporationID(corporationID)
    ) {
      return 0;
    }
  } catch (_error) {
    // ignored: recognition of an already-persisted, owner-matching server marker must
    // not fail open when corporation authority is temporarily unavailable.
    // Membership/war grants remain separate and fail closed at their checks.
  }
  return corporationID;
}

function hasProtectedPropertyCorporationMarker(source) {
  const lootInfo = (source && source.lootInfo) || {};
  return Object.prototype.hasOwnProperty.call(
    lootInfo,
    PROTECTED_PROPERTY_CORPORATION_ID_KEY,
  );
}

function hasInvalidProtectedPropertyCorporationMarker(source) {
  return Boolean(
    hasProtectedPropertyCorporationMarker(source) &&
    resolveProtectedPropertyCorporationID(source) <= 0,
  );
}

function resolveSessionCorporationID(session) {
  return toInt(
    session && (session.corporationID || session.corpid),
    0,
  );
}

function resolveSessionSystemID(session) {
  return toInt(
    session && session._space && session._space.systemID,
    toInt(session && (session.solarsystemid2 ?? session.solarsystemid), 0),
  );
}

function sessionHasCorporationLootRight(session, source) {
  const sessionCorporationID = resolveSessionCorporationID(session);
  const lootInfo = (source && source.lootInfo) || {};
  const persistedLootRightCorpID = toInt(
    lootInfo.lootRightCorpID ?? lootInfo.corporationID,
    0,
  );
  const authoritativeSnapshot =
    hasAuthoritativeSpaceLootRightsSnapshot(lootInfo);
  const ownerRecord =
    persistedLootRightCorpID <= 0 && !authoritativeSnapshot
      ? getCharacterRecordSafe(source && source.ownerID)
      : null;
  const ownerCorporationID =
    persistedLootRightCorpID > 0
      ? persistedLootRightCorpID
      : toInt(
        ownerRecord && (ownerRecord.corporationID ?? ownerRecord.corpid),
        0,
      );
  return Boolean(
    sessionCorporationID > 0 &&
    ownerCorporationID > 0 &&
    isPlayerCorporationID(ownerCorporationID) &&
    sessionCorporationID === ownerCorporationID,
  );
}

function sessionHasFleetLootRight(session, source) {
  const fleetRuntime = getFleetRuntime();
  const lootInfo = (source && source.lootInfo) || {};
  const persistedLootRightFleetID = toInt(lootInfo.lootRightFleetID, 0);
  const sourceOwnerFleet =
    persistedLootRightFleetID <= 0 &&
    !hasAuthoritativeSpaceLootRightsSnapshot(lootInfo) &&
    fleetRuntime &&
    typeof fleetRuntime.getFleetForCharacter === "function"
      ? fleetRuntime.getFleetForCharacter(source && source.ownerID)
      : null;
  const fleetState =
    fleetRuntime &&
    typeof fleetRuntime.getSessionFleetState === "function"
      ? fleetRuntime.getSessionFleetState(session)
      : null;
  const ownerFleetID =
    persistedLootRightFleetID > 0
      ? persistedLootRightFleetID
      : toInt(sourceOwnerFleet && sourceOwnerFleet.fleetID, 0);
  const sessionFleetID = toInt(
    fleetState && fleetState.fleetid,
    toInt(session && (session.fleetid ?? session.fleetID), 0),
  );
  const sessionSystemID = resolveSessionSystemID(session);
  return Boolean(
    sessionFleetID > 0 &&
    ownerFleetID > 0 &&
    sessionFleetID === ownerFleetID &&
    sessionSystemID > 0 &&
    sessionSystemID === toInt(source && source.locationID, 0),
  );
}

/**
 * @param {object} session acting session
 * @param {object} source descriptor from `buildSpaceLootSourceFromItem` (or an
 *   equivalent shape built from a non-inventory wreck record)
 * @returns {boolean} true when the take is free and needs no theft evaluation
 */
function sessionHasSpaceLootRight(session, source) {
  if (!source) {
    return false;
  }

  const characterID = resolveSessionCharacterID(session);
  const ownerID = toInt(source.ownerID, 0);
  if (characterID > 0 && ownerID === characterID) {
    return true;
  }
  // Relinquishment always wins, including over an accidentally retained
  // corporation-property descriptor.
  if (source.lootInfo && source.lootInfo.abandoned === true) {
    return true;
  }
  const protectedPropertyCorporationID =
    resolveProtectedPropertyCorporationID(source);
  if (hasProtectedPropertyCorporationMarker(source)) {
    if (
      protectedPropertyCorporationID <= 0 ||
      !isAuthoritativePlayerCorporationID(
        protectedPropertyCorporationID,
      )
    ) {
      return false;
    }
    return (
      resolveSessionCorporationID(session) ===
      protectedPropertyCorporationID
    );
  }
  if (!isPlayerCharacterOwner(ownerID)) {
    return true;
  }
  if (sessionHasCorporationLootRight(session, source)) {
    return true;
  }
  return sessionHasFleetLootRight(session, source);
}

function resolveScene(session, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "scene")) {
    return options.scene;
  }
  const runtime = getSpaceRuntime();
  return runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
}

/**
 * Decide whether a session may take from `source`. Entitled takes short out
 * before crimewatch is consulted; unentitled ones inherit the container-theft
 * verdict (blocked under green safety, suspect timer otherwise).
 *
 * @returns {{success: boolean, errorMsg: (string|null), requiresSuspectTimer:
 *   boolean, entitled: boolean, source: object}}
 */
function evaluateSpaceLootAccess(session, source, options = {}) {
  if (!source) {
    return {
      success: true,
      errorMsg: null,
      requiresSuspectTimer: false,
      entitled: true,
      source: null,
    };
  }
  if (sessionHasSpaceLootRight(session, source)) {
    return {
      success: true,
      errorMsg: null,
      requiresSuspectTimer: false,
      entitled: true,
      source,
    };
  }
  if (hasInvalidProtectedPropertyCorporationMarker(source)) {
    return {
      success: false,
      errorMsg: "PROPERTY_AUTHORITY_INVALID",
      requiresSuspectTimer: false,
      entitled: false,
      source,
    };
  }

  const evaluation = getCrimewatchState().evaluateContainerTheft(
    resolveScene(session, options),
    resolveSessionCharacterID(session),
    source.ownerID,
    toInt(options.nowMs, Date.now()),
    {
      protectedPropertyCorporationID:
        resolveProtectedPropertyCorporationID(source),
    },
  );
  return {
    success: Boolean(evaluation && evaluation.success),
    errorMsg:
      evaluation && evaluation.errorMsg
        ? evaluation.errorMsg
        : "SafetyActivated",
    requiresSuspectTimer: Boolean(
      evaluation &&
      evaluation.data &&
      evaluation.data.requiresSuspectTimer,
    ),
    entitled: false,
    source,
  };
}

/**
 * Durably settle the suspect consequence for an access decision that came
 * back with `requiresSuspectTimer`. Call this immediately before the take is
 * committed: a persistence failure must stop the inventory mutation.
 *
 * @returns {{applied: boolean, errorMsg: (string|null), receipt: (object|null)}}
 */
function recordSpaceLootTheft(session, access, options = {}) {
  if (!access || !access.requiresSuspectTimer || !access.source) {
    return {
      applied: false,
      errorMsg: null,
      receipt: null,
    };
  }

  const result = getCrimewatchState().recordContainerTheft(
    resolveScene(session, options),
    session,
    access.source.ownerID,
    toInt(options.nowMs, Date.now()),
    {
      receiptID: options.receiptID,
      protectedPropertyCorporationID:
        resolveProtectedPropertyCorporationID(access.source),
    },
  );
  if (!result || !result.success) {
    return {
      applied: false,
      errorMsg: (result && result.errorMsg) || "UNKNOWN_ERROR",
      receipt: null,
    };
  }
  return {
    applied: Boolean(result.data && result.data.applied),
    errorMsg: null,
    receipt:
      result.data && result.data.theftReceipt
        ? result.data.theftReceipt
        : null,
  };
}

function mutateSpaceLootTheftReceipt(
  action,
  session,
  settlementOrReceipt,
  options = {},
) {
  const receipt = settlementOrReceipt && settlementOrReceipt.receipt
    ? settlementOrReceipt.receipt
    : settlementOrReceipt;
  if (!receipt) {
    return { applied: false, errorMsg: null, receipt: null };
  }
  const crimewatchState = getCrimewatchState();
  const method = action === "commit"
    ? crimewatchState.commitContainerTheft
    : crimewatchState.compensateContainerTheft;
  if (typeof method !== "function") {
    return {
      applied: false,
      errorMsg: "CRIMEWATCH_THEFT_RECEIPT_UNAVAILABLE",
      receipt,
    };
  }
  const result = method(
    resolveScene(session, options),
    session,
    receipt,
    toInt(options.nowMs, Date.now()),
  );
  if (!result || result.success !== true) {
    return {
      applied: false,
      errorMsg: (result && result.errorMsg) || "UNKNOWN_ERROR",
      receipt,
    };
  }
  return {
    applied: Boolean(result.data && result.data.applied),
    errorMsg: null,
    receipt:
      result.data && result.data.theftReceipt
        ? result.data.theftReceipt
        : receipt,
  };
}

function commitSpaceLootTheft(session, settlementOrReceipt, options = {}) {
  return mutateSpaceLootTheftReceipt(
    "commit",
    session,
    settlementOrReceipt,
    options,
  );
}

function compensateSpaceLootTheft(session, settlementOrReceipt, options = {}) {
  return mutateSpaceLootTheftReceipt(
    "compensate",
    session,
    settlementOrReceipt,
    options,
  );
}

module.exports = {
  LOOT_CUSTOM_INFO_KEY,
  LOOT_RIGHTS_SNAPSHOT_VERSION,
  PROTECTED_PROPERTY_CORPORATION_ID_KEY,
  buildProtectedCorporationSpaceLootInfo,
  buildSpaceLootRightsSnapshot,
  buildSpaceLootSourceFromItem,
  commitSpaceLootTheft,
  compensateSpaceLootTheft,
  evaluateSpaceLootAccess,
  hasAuthoritativeSpaceLootRightsSnapshot,
  hasInvalidProtectedPropertyCorporationMarker,
  hasProtectedPropertyCorporationMarker,
  isPlayerCharacterOwner,
  readSpaceLootInfo,
  recordSpaceLootTheft,
  resolveProtectedPropertyCorporationID,
  resolveCharacterSpaceLootContext,
  sessionHasSpaceLootRight,
};
