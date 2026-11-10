"use strict";

// Drone settings in the dogma service: whether a pilot's drones are aggressive and whether
// they focus fire. ChangeDroneSettings stores the settings on the character record and
// GetDroneSettingAttributes reads them back for the client. These are DogmaService methods,
// moved here as they were; dogmaService.js puts them back on the class prototype, so `this`
// is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  getAttributeIDByNames,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  extractDictEntries,
  normalizeNumber,
  buildDict,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));

const ATTRIBUTE_DRONE_IS_AGGRESSIVE =
  getAttributeIDByNames("droneIsAggressive") || 1275;

const ATTRIBUTE_DRONE_FOCUS_FIRE =
  getAttributeIDByNames("droneFocusFire") || 1297;

const VALID_DRONE_SETTING_ATTRIBUTE_IDS = new Set([
  ATTRIBUTE_DRONE_IS_AGGRESSIVE,
  ATTRIBUTE_DRONE_FOCUS_FIRE,
]);

module.exports = {
  _getPersistedDroneSettingAttributes(session) {
    const characterRecord = this._getCharacterRecord(session) || {};
    const storedSettings =
      characterRecord.droneSettings &&
      typeof characterRecord.droneSettings === "object"
        ? characterRecord.droneSettings
        : {};
    const normalizedSettings = {};
    for (const attributeID of VALID_DRONE_SETTING_ATTRIBUTE_IDS) {
      if (!Object.prototype.hasOwnProperty.call(storedSettings, attributeID)) {
        continue;
      }
      normalizedSettings[attributeID] = Boolean(storedSettings[attributeID]);
    }
    return normalizedSettings;
  },

  _normalizeDroneSettingChanges(rawChanges) {
    const normalizedChanges = {};
    for (const [rawAttributeID, rawValue] of extractDictEntries(rawChanges)) {
      const attributeID = Number(normalizeNumber(rawAttributeID, 0)) || 0;
      if (!VALID_DRONE_SETTING_ATTRIBUTE_IDS.has(attributeID)) {
        continue;
      }
      normalizedChanges[attributeID] = Boolean(normalizeNumber(rawValue, 0));
    }
    return normalizedChanges;
  },

  _persistDroneSettingChanges(session, droneSettingChanges = {}) {
    const characterID = this._getCharID(session);
    if (characterID <= 0) {
      return this._getPersistedDroneSettingAttributes(session);
    }
    const characterRecord = this._getCharacterRecord(session);
    if (!characterRecord) {
      return {};
    }
    const nextDroneSettings = {
      ...this._getPersistedDroneSettingAttributes(session),
      ...droneSettingChanges,
    };
    const nextCharacterRecord = {
      ...characterRecord,
      droneSettings: nextDroneSettings,
    };
    // Phase 0: persist the character record through its owner (characterState).
    const writeResult = require("../../character/characterState").writeCharacterRecord(
      characterID,
      nextCharacterRecord,
      { silent: true },
    );
    if (!writeResult.success) {
      log.warn(
        `[DogmaService] Failed to persist drone settings for char=${characterID}: ${writeResult.errorMsg || "WRITE_ERROR"}`,
      );
      return this._getPersistedDroneSettingAttributes(session);
    }
    return nextDroneSettings;
  },

  _buildDroneSettingAttributesPayload(session) {
    return buildDict(
      Object.entries(this._getPersistedDroneSettingAttributes(session)).map(
        ([attributeID, value]) => [
          Number(attributeID) || 0,
          Boolean(value),
        ],
      ),
    );
  },

  Handle_ChangeDroneSettings(args, session) {
    const rawDroneSettingChanges = args && args.length > 0 ? args[0] : null;
    const droneSettingChanges = this._normalizeDroneSettingChanges(
      rawDroneSettingChanges,
    );
    const nextDroneSettings = this._persistDroneSettingChanges(
      session,
      droneSettingChanges,
    );
    if (session && typeof session === "object") {
      session.droneSettings = {
        ...nextDroneSettings,
      };
    }
    log.debug(
      `[DogmaService] ChangeDroneSettings char=${this._getCharID(session)} keys=${Object.keys(droneSettingChanges).join(",")}`,
    );
    return true;
  },

  Handle_GetDroneSettingAttributes(args, session) {
    void args;
    return this._buildDroneSettingAttributesPayload(session);
  },
};
