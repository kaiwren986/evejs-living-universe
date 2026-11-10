"use strict";

// Chat command inventory updates: pushing item changes a command made to the caller's client,
// and granting a batch of items to the caller's station hangar.

const path = require("path");

const {
  syncInventoryItemForSession,
} = require("../../character/characterState");
const {
  ITEM_FLAGS,
  grantItemsToCharacterStationHangar,
} = require("../../inventory/itemStore");
const {
  getDockedLocationID,
} = require(path.join(__dirname, "../../structure/structureLocation"));

function syncInventoryChangesToSession(session, changes = []) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: true,
      },
    );
  }
}

function syncStationHangarChangesToSession(session, stationID, changes = []) {
  const currentStationID = Number(getDockedLocationID(session) || 0) || 0;
  if (
    !session ||
    !session.characterID ||
    currentStationID <= 0 ||
    currentStationID !== Number(stationID)
  ) {
    return;
  }

  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }

    syncInventoryItemForSession(
      session,
      change.item,
      change.previousState || {
        locationID: 0,
        flagID: ITEM_FLAGS.HANGAR,
      },
      {
        emitCfgLocation: true,
      },
    );
  }
}

function grantStationHangarBatchAndSyncSession(session, stationID, entries = []) {
  const result = grantItemsToCharacterStationHangar(
    Number(session && session.characterID) || 0,
    stationID,
    entries,
  );
  if (result.success) {
    syncStationHangarChangesToSession(
      session,
      stationID,
      result.data && result.data.changes,
    );
  }
  return result;
}

module.exports = {
  syncInventoryChangesToSession,
  syncStationHangarChangesToSession,
  grantStationHangarBatchAndSyncSession,
};
