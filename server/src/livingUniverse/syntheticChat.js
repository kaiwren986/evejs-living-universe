"use strict";

// Living Universe: pilots as chat members.
//
// The mod's pilots have no session and no chat connection, so chat cannot find
// them the way it finds players. This module is the list chat is given instead:
// who is visible in which system's Local, and who is in which corporation, per
// source (the pilot population, the hirelings, ...). Changing the list emits
// the same join / leave / refresh events a player causes, so the game client's
// Local window updates through the normal gateway path.
//
// The functions are the mod's own (Living Universe 0.3.0, where they sat inside
// chatRuntime.js). They are built by create() around the handful of chatRuntime
// internals they use, so chatRuntime itself only gains a few one-line calls.

function create(chat) {
  const {
    runtimeEmitter,
    chatStore,
    ensureChannel,
    getLocalChatRoomNameForSolarSystemID,
    isDelayedLocalChatRoomName,
    parseLocalChatRoomName,
    repushLocalMembershipForRoom,
    normalizePositiveInteger,
    normalizeString,
    dedupePositiveIntegers,
  } = chat;

  const DEFAULT_SYNTHETIC_PRESENCE_SOURCE = "legacy";
  const syntheticLocalMembersBySource = new Map();
  const syntheticLocalMembersByCharacterID = new Map();
  const syntheticCorporationMembersBySource = new Map();
  const syntheticCorporationMembersByCharacterID = new Map();

  function normalizeSyntheticLocalMember(pilot) {
    const characterID = normalizePositiveInteger(
      pilot && (pilot.characterID || pilot.charid),
      0,
    );
    const solarSystemID = normalizePositiveInteger(
      pilot && (pilot.solarSystemID || pilot.currentSystemID),
      0,
    );
    if (!characterID || !solarSystemID || pilot && pilot.localVisible === false) {
      return null;
    }
    return {
      characterID,
      characterName: normalizeString(pilot.characterName, String(characterID)),
      corporationID: normalizePositiveInteger(pilot.corporationID, 0),
      allianceID: normalizePositiveInteger(pilot.allianceID, 0),
      warFactionID: normalizePositiveInteger(pilot.warFactionID, 0),
      solarSystemID,
      syntheticNpcPilot: true,
    };
  }

  function normalizeSyntheticCorporationMember(pilot) {
    const characterID = normalizePositiveInteger(
      pilot && (pilot.characterID || pilot.charid),
      0,
    );
    const corporationID = normalizePositiveInteger(
      pilot && (pilot.corporationID || pilot.corpid),
      0,
    );
    if (
      !characterID ||
      !corporationID ||
      (pilot && (
        pilot.corporationVisible === false ||
        pilot.corpVisible === false ||
        pilot.corporationChatVisible === false
      ))
    ) {
      return null;
    }
    return {
      characterID,
      characterName: normalizeString(
        pilot && (pilot.characterName || pilot.name),
        String(characterID),
      ),
      corporationID,
      allianceID: normalizePositiveInteger(pilot && pilot.allianceID, 0),
      warFactionID: normalizePositiveInteger(pilot && pilot.warFactionID, 0),
      syntheticNpcPilot: true,
    };
  }

  function buildSyntheticLocalGatewayMember(pilot) {
    const allianceID = normalizePositiveInteger(pilot && pilot.allianceID, 0);
    const warFactionID = normalizePositiveInteger(pilot && pilot.warFactionID, 0);
    return {
      character: {
        sequential: normalizePositiveInteger(pilot && pilot.characterID, 0),
      },
      corporation: {
        sequential: normalizePositiveInteger(pilot && pilot.corporationID, 0),
      },
      alliance: allianceID > 0 ? { sequential: allianceID } : null,
      no_alliance: allianceID <= 0,
      faction: warFactionID > 0 ? { sequential: warFactionID } : null,
      no_faction: warFactionID <= 0,
      // These are simulated capsuleers, not special NPC chat actors. Keeping the
      // normal classification makes them render like ordinary Local occupants.
      classification: "CLASSIFICATION_UNSPECIFIED",
    };
  }

  function buildSyntheticCharacterSummary(pilot) {
    return {
      characterID: normalizePositiveInteger(pilot && pilot.characterID, 0),
      characterName: normalizeString(pilot && pilot.characterName, ""),
      corporationID: normalizePositiveInteger(pilot && pilot.corporationID, 0),
      allianceID: normalizePositiveInteger(pilot && pilot.allianceID, 0),
      warFactionID: normalizePositiveInteger(pilot && pilot.warFactionID, 0),
      role: "0",
      classification: "CLASSIFICATION_UNSPECIFIED",
      syntheticNpcPilot: true,
    };
  }

  function normalizeSyntheticPresenceSource(source) {
    const normalized = normalizeString(source, "").trim().toLowerCase();
    return normalized || DEFAULT_SYNTHETIC_PRESENCE_SOURCE;
  }

  // Compatibility:
  //   syncSyntheticLocalMembers(pilots)
  //   syncSyntheticLocalMembers(pilots, { sourceID: "industrial_hirelings" })
  //   syncSyntheticLocalMembers("industrial_hirelings", pilots)
  // The legacy one-argument form owns only the "legacy" slice, so a full ambient
  // refresh cannot erase an explicitly-owned industrial/service-member slice.
  function resolveSyntheticPresenceMutationArguments(
    pilotsOrSource,
    optionsOrPilots,
  ) {
    if (typeof pilotsOrSource === "string") {
      return {
        source: normalizeSyntheticPresenceSource(pilotsOrSource),
        pilots: Array.isArray(optionsOrPilots) ? optionsOrPilots : [],
      };
    }
    const options = (
      optionsOrPilots &&
      !Array.isArray(optionsOrPilots) &&
      typeof optionsOrPilots === "object"
    )
      ? optionsOrPilots
      : {};
    return {
      source: normalizeSyntheticPresenceSource(
        options.source || options.sourceKey || options.sourceID,
      ),
      pilots: Array.isArray(pilotsOrSource) ? pilotsOrSource : [],
    };
  }

  function assertSyntheticPresenceSourceOwnership(
    sourceRegistry,
    source,
    nextSourceMembers,
    presenceKind,
  ) {
    for (const characterID of nextSourceMembers.keys()) {
      for (const [otherSource, otherMembers] of sourceRegistry) {
        if (otherSource === source || !otherMembers.has(characterID)) {
          continue;
        }
        const error = new Error(
          `Synthetic ${presenceKind} character ${characterID} is already owned by source ${otherSource}.`,
        );
        error.code = "SYNTHETIC_CHAT_CHARACTER_SOURCE_COLLISION";
        error.characterID = characterID;
        error.source = source;
        error.existingSource = otherSource;
        throw error;
      }
    }
  }

  function buildSyntheticSourceMembers(
    sourceRegistry,
    source,
    pilots,
    normalizeMember,
    options = {},
  ) {
    const nextSourceMembers = options.upsert === true
      ? new Map(sourceRegistry.get(source) || [])
      : new Map();
    for (const pilot of pilots) {
      const characterID = normalizePositiveInteger(
        pilot && (pilot.characterID || pilot.charid),
        0,
      );
      const normalized = normalizeMember(pilot);
      if (!normalized) {
        if (options.upsert === true && characterID > 0) {
          nextSourceMembers.delete(characterID);
        }
        continue;
      }
      nextSourceMembers.set(normalized.characterID, {
        ...normalized,
        syntheticPresenceSource: source,
      });
    }
    assertSyntheticPresenceSourceOwnership(
      sourceRegistry,
      source,
      nextSourceMembers,
      options.presenceKind || "presence",
    );
    return nextSourceMembers;
  }

  function replaceSyntheticSourceMembers(
    sourceRegistry,
    aggregateMembers,
    source,
    nextSourceMembers,
  ) {
    const previousAggregate = new Map(aggregateMembers);
    if (nextSourceMembers.size > 0) {
      sourceRegistry.set(source, nextSourceMembers);
    } else {
      sourceRegistry.delete(source);
    }
    aggregateMembers.clear();
    for (const sourceMembers of sourceRegistry.values()) {
      for (const [characterID, member] of sourceMembers) {
        aggregateMembers.set(characterID, member);
      }
    }
    return previousAggregate;
  }

  function syntheticMemberChanged(left, right) {
    return JSON.stringify(left) !== JSON.stringify(right);
  }

  function cloneSyntheticPresenceMember(member) {
    const cloned = { ...(member || {}) };
    delete cloned.syntheticPresenceSource;
    return cloned;
  }

  function getSyntheticLocalMembers(roomNameOrSystemID, options = {}) {
    const parsed = typeof roomNameOrSystemID === "string"
      ? parseLocalChatRoomName(roomNameOrSystemID)
      : null;
    const solarSystemID = normalizePositiveInteger(
      parsed ? parsed.solarSystemID : roomNameOrSystemID,
      0,
    );
    const roomName = parsed
      ? parsed.roomName
      : getLocalChatRoomNameForSolarSystemID(solarSystemID);
    if (!solarSystemID || isDelayedLocalChatRoomName(roomName)) {
      return [];
    }
    const excludeCharacterID = normalizePositiveInteger(options.excludeCharacterID, 0);
    const source = options.source || options.sourceKey || options.sourceID
      ? normalizeSyntheticPresenceSource(
          options.source || options.sourceKey || options.sourceID,
        )
      : "";
    return [...syntheticLocalMembersByCharacterID.values()]
      .filter((pilot) => (
        pilot.solarSystemID === solarSystemID &&
        (!excludeCharacterID || pilot.characterID !== excludeCharacterID) &&
        (!source || pilot.syntheticPresenceSource === source)
      ))
      .sort((left, right) => left.characterID - right.characterID)
      .map(cloneSyntheticPresenceMember);
  }

  function getSyntheticCorporationMembers(corporationID, options = {}) {
    const normalizedCorporationID = normalizePositiveInteger(corporationID, 0);
    if (!normalizedCorporationID) {
      return [];
    }
    const excludeCharacterID = normalizePositiveInteger(options.excludeCharacterID, 0);
    const source = options.source || options.sourceKey || options.sourceID
      ? normalizeSyntheticPresenceSource(
          options.source || options.sourceKey || options.sourceID,
        )
      : "";
    return [...syntheticCorporationMembersByCharacterID.values()]
      .filter((pilot) => (
        pilot.corporationID === normalizedCorporationID &&
        (!excludeCharacterID || pilot.characterID !== excludeCharacterID) &&
        (!source || pilot.syntheticPresenceSource === source)
      ))
      .sort((left, right) => left.characterID - right.characterID)
      .map(cloneSyntheticPresenceMember);
  }

  function getSyntheticPresenceMember(characterID) {
    const normalizedCharacterID = normalizePositiveInteger(characterID, 0);
    if (!normalizedCharacterID) {
      return null;
    }
    const member =
      syntheticCorporationMembersByCharacterID.get(normalizedCharacterID) ||
      syntheticLocalMembersByCharacterID.get(normalizedCharacterID) ||
      null;
    return member ? cloneSyntheticPresenceMember(member) : null;
  }

  function publishSyntheticLocalChanges(leaves, joins, refreshes, affectedRoomNames) {
    for (const pilot of leaves) {
      const roomName = getLocalChatRoomNameForSolarSystemID(pilot.solarSystemID);
      if (isDelayedLocalChatRoomName(roomName)) {
        continue;
      }
      const event = {
        roomName,
        solarSystemID: pilot.solarSystemID,
        characterID: pilot.characterID,
        source: pilot.syntheticPresenceSource,
        syntheticNpcPilot: true,
      };
      runtimeEmitter.emit("local-leave", event);
      runtimeEmitter.emit("synthetic-local-leave", event);
    }
    for (const pilot of joins) {
      const roomName = getLocalChatRoomNameForSolarSystemID(pilot.solarSystemID);
      if (isDelayedLocalChatRoomName(roomName)) {
        continue;
      }
      const event = {
        roomName,
        solarSystemID: pilot.solarSystemID,
        member: buildSyntheticLocalGatewayMember(pilot),
        summary: buildSyntheticCharacterSummary(pilot),
        pilot: cloneSyntheticPresenceMember(pilot),
        source: pilot.syntheticPresenceSource,
        syntheticNpcPilot: true,
      };
      runtimeEmitter.emit("local-join", event);
      runtimeEmitter.emit("synthetic-local-join", event);
    }
    for (const pilot of refreshes) {
      const roomName = getLocalChatRoomNameForSolarSystemID(pilot.solarSystemID);
      if (isDelayedLocalChatRoomName(roomName)) {
        continue;
      }
      const event = {
        roomName,
        solarSystemID: pilot.solarSystemID,
        member: buildSyntheticLocalGatewayMember(pilot),
        summary: buildSyntheticCharacterSummary(pilot),
        pilot: cloneSyntheticPresenceMember(pilot),
        source: pilot.syntheticPresenceSource,
        syntheticNpcPilot: true,
      };
      runtimeEmitter.emit("local-membership-refresh", event);
      runtimeEmitter.emit("synthetic-local-refresh", event);
    }
    for (const roomName of affectedRoomNames) {
      repushLocalMembershipForRoom(roomName);
    }
  }

  function collectSyntheticLocalChanges(previousMembers, nextMembers) {
    const leaves = [];
    const joins = [];
    const refreshes = [];
    const affectedRoomNames = new Set();
    for (const previous of previousMembers.values()) {
      const next = nextMembers.get(previous.characterID) || null;
      if (!next || next.solarSystemID !== previous.solarSystemID) {
        leaves.push(previous);
        affectedRoomNames.add(
          getLocalChatRoomNameForSolarSystemID(previous.solarSystemID),
        );
      } else if (syntheticMemberChanged(next, previous)) {
        refreshes.push(next);
        affectedRoomNames.add(getLocalChatRoomNameForSolarSystemID(next.solarSystemID));
      }
    }
    for (const next of nextMembers.values()) {
      const previous = previousMembers.get(next.characterID) || null;
      if (!previous || previous.solarSystemID !== next.solarSystemID) {
        joins.push(next);
        affectedRoomNames.add(getLocalChatRoomNameForSolarSystemID(next.solarSystemID));
      }
    }
    return { leaves, joins, refreshes, affectedRoomNames };
  }

  function mutateSyntheticLocalMembers(
    pilotsOrSource = [],
    optionsOrPilots = {},
    mutationOptions = {},
  ) {
    const { source, pilots } = resolveSyntheticPresenceMutationArguments(
      pilotsOrSource,
      optionsOrPilots,
    );
    const nextSourceMembers = buildSyntheticSourceMembers(
      syntheticLocalMembersBySource,
      source,
      pilots,
      normalizeSyntheticLocalMember,
      {
        upsert: mutationOptions.upsert === true,
        presenceKind: "Local",
      },
    );
    const previousMembers = replaceSyntheticSourceMembers(
      syntheticLocalMembersBySource,
      syntheticLocalMembersByCharacterID,
      source,
      nextSourceMembers,
    );
    const {
      leaves,
      joins,
      refreshes,
      affectedRoomNames,
    } = collectSyntheticLocalChanges(
      previousMembers,
      syntheticLocalMembersByCharacterID,
    );

    publishSyntheticLocalChanges(leaves, joins, refreshes, affectedRoomNames);

    return {
      source,
      sourceMembers: nextSourceMembers.size,
      members: syntheticLocalMembersByCharacterID.size,
      joins: joins.length,
      leaves: leaves.length,
      refreshes: refreshes.length,
    };
  }

  function syncSyntheticLocalMembers(pilotsOrSource = [], optionsOrPilots = {}) {
    return mutateSyntheticLocalMembers(
      pilotsOrSource,
      optionsOrPilots,
      { upsert: false },
    );
  }

  function upsertSyntheticLocalMembers(pilotsOrSource = [], optionsOrPilots = {}) {
    return mutateSyntheticLocalMembers(
      pilotsOrSource,
      optionsOrPilots,
      { upsert: true },
    );
  }

  function collectSyntheticCorporationChanges(previousMembers, nextMembers) {
    const leaves = [];
    const joins = [];
    const refreshes = [];
    for (const previous of previousMembers.values()) {
      const next = nextMembers.get(previous.characterID) || null;
      if (!next || next.corporationID !== previous.corporationID) {
        leaves.push(previous);
      } else if (syntheticMemberChanged(next, previous)) {
        refreshes.push(next);
      }
    }
    for (const next of nextMembers.values()) {
      const previous = previousMembers.get(next.characterID) || null;
      if (!previous || previous.corporationID !== next.corporationID) {
        joins.push(next);
      }
    }
    return { leaves, joins, refreshes };
  }

  function buildSyntheticCorporationEvent(pilot, options = {}) {
    const corporationID = normalizePositiveInteger(pilot && pilot.corporationID, 0);
    const event = {
      roomName: corporationID > 0 ? `corp_${corporationID}` : "",
      corporationID,
      characterID: normalizePositiveInteger(pilot && pilot.characterID, 0),
      source: normalizeSyntheticPresenceSource(
        pilot && pilot.syntheticPresenceSource,
      ),
      syntheticNpcPilot: true,
    };
    if (options.includeMember === true) {
      event.summary = buildSyntheticCharacterSummary(pilot);
      event.member = cloneSyntheticPresenceMember(pilot);
      event.pilot = cloneSyntheticPresenceMember(pilot);
    }
    return event;
  }

  function publishSyntheticCorporationChanges(leaves, joins, refreshes) {
    for (const pilot of leaves) {
      const event = buildSyntheticCorporationEvent(pilot);
      runtimeEmitter.emit("corp-leave", event);
      runtimeEmitter.emit("synthetic-corporation-leave", event);
    }
    for (const pilot of joins) {
      const event = buildSyntheticCorporationEvent(
        pilot,
        { includeMember: true },
      );
      runtimeEmitter.emit("corp-join", event);
      runtimeEmitter.emit("synthetic-corporation-join", event);
    }
    for (const pilot of refreshes) {
      const event = buildSyntheticCorporationEvent(
        pilot,
        { includeMember: true },
      );
      runtimeEmitter.emit("corp-membership-refresh", event);
      runtimeEmitter.emit("synthetic-corporation-refresh", event);
    }
  }

  function mutateSyntheticCorporationMembers(
    pilotsOrSource = [],
    optionsOrPilots = {},
    mutationOptions = {},
  ) {
    const { source, pilots } = resolveSyntheticPresenceMutationArguments(
      pilotsOrSource,
      optionsOrPilots,
    );
    const nextSourceMembers = buildSyntheticSourceMembers(
      syntheticCorporationMembersBySource,
      source,
      pilots,
      normalizeSyntheticCorporationMember,
      {
        upsert: mutationOptions.upsert === true,
        presenceKind: "corporation",
      },
    );
    const previousMembers = replaceSyntheticSourceMembers(
      syntheticCorporationMembersBySource,
      syntheticCorporationMembersByCharacterID,
      source,
      nextSourceMembers,
    );
    const {
      leaves,
      joins,
      refreshes,
    } = collectSyntheticCorporationChanges(
      previousMembers,
      syntheticCorporationMembersByCharacterID,
    );

    publishSyntheticCorporationChanges(leaves, joins, refreshes);
    return {
      source,
      sourceMembers: nextSourceMembers.size,
      members: syntheticCorporationMembersByCharacterID.size,
      joins: joins.length,
      leaves: leaves.length,
      refreshes: refreshes.length,
    };
  }

  function syncSyntheticCorporationMembers(
    pilotsOrSource = [],
    optionsOrPilots = {},
  ) {
    return mutateSyntheticCorporationMembers(
      pilotsOrSource,
      optionsOrPilots,
      { upsert: false },
    );
  }

  function upsertSyntheticCorporationMembers(
    pilotsOrSource = [],
    optionsOrPilots = {},
  ) {
    return mutateSyntheticCorporationMembers(
      pilotsOrSource,
      optionsOrPilots,
      { upsert: true },
    );
  }

  function removeSyntheticPilotMembers(characterIDs = [], options = {}) {
    const source = normalizeSyntheticPresenceSource(
      options.source || options.sourceKey || options.sourceID,
    );
    const normalizedCharacterIDs = dedupePositiveIntegers(characterIDs);
    const localSourceMembers = syntheticLocalMembersBySource.get(source) || new Map();
    const corporationSourceMembers =
      syntheticCorporationMembersBySource.get(source) || new Map();
    const removedCharacterIDs = normalizedCharacterIDs.filter((characterID) => (
      localSourceMembers.has(characterID) ||
      corporationSourceMembers.has(characterID)
    ));
    const removals = normalizedCharacterIDs.map((characterID) => ({
      characterID,
      localVisible: false,
      corporationVisible: false,
      corporationChatVisible: false,
    }));
    const local = upsertSyntheticLocalMembers(source, removals);
    const corporation = upsertSyntheticCorporationMembers(source, removals);
    return {
      source,
      removedCharacterIDs,
      local,
      corporation,
    };
  }

  function broadcastSyntheticLocalMessage(pilot, message, options = {}) {
    const trimmedMessage = normalizeString(message, "").trim();
    const normalizedPilot = normalizeSyntheticLocalMember({
      ...(pilot && typeof pilot === "object" ? pilot : {}),
      solarSystemID: normalizePositiveInteger(
        options.solarSystemID || pilot && pilot.solarSystemID,
        0,
      ),
    });
    if (!normalizedPilot || !trimmedMessage) {
      return null;
    }

    const roomName = getLocalChatRoomNameForSolarSystemID(
      normalizedPilot.solarSystemID,
    );
    const record = ensureChannel(roomName);
    if (!record || isDelayedLocalChatRoomName(roomName)) {
      return null;
    }
    const entry = {
      roomName: record.roomName,
      characterID: normalizedPilot.characterID,
      characterName: normalizedPilot.characterName,
      message: trimmedMessage,
      createdAtMs: Math.max(0, Number(options.createdAtMs) || Date.now()),
      sender: buildSyntheticCharacterSummary(normalizedPilot),
      syntheticNpcPilot: true,
    };
    if (record.persistBacklog !== false) {
      chatStore.appendBacklogEntry(record.roomName, entry, {
        limit: record.backlogLimit,
      });
    }
    runtimeEmitter.emit("channel-message", {
      roomName: record.roomName,
      record,
      entry,
    });
    const event = {
      roomName: record.roomName,
      solarSystemID: normalizedPilot.solarSystemID,
      authorCharacterID: normalizedPilot.characterID,
      message: entry.message,
      entry,
      pilot: { ...normalizedPilot },
      syntheticNpcPilot: true,
    };
    runtimeEmitter.emit("local-message", event);
    runtimeEmitter.emit("synthetic-local-message", event);
    return { record, entry };
  }

  function reset() {
    syntheticLocalMembersBySource.clear();
    syntheticLocalMembersByCharacterID.clear();
    syntheticCorporationMembersBySource.clear();
    syntheticCorporationMembersByCharacterID.clear();
  }

  return {
    buildSyntheticLocalGatewayMember,
    getSyntheticLocalMembers,
    getSyntheticCorporationMembers,
    getSyntheticPresenceMember,
    syncSyntheticLocalMembers,
    upsertSyntheticLocalMembers,
    syncSyntheticCorporationMembers,
    upsertSyntheticCorporationMembers,
    removeSyntheticPilotMembers,
    broadcastSyntheticLocalMessage,
    reset,
  };
}

module.exports = { create };
