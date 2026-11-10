"use strict";

// Implants and boosters in the dogma service: plugging in an implant (InjectImplant),
// destroying one (DestroyImplant) and using a booster (UseBooster). Either can change the
// character's attributes, so the skill queue is brought into line with the change, and an
// implant change keeps the capsule type in step. These are DogmaService methods, moved here as
// they were; dogmaService.js puts them back on the class prototype, so `this` is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  syncCapsuleTypeForCharacter,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const {
  useBoosterItem,
} = require(path.join(__dirname, "../../skills/boosters/boosterRuntime"));
const {
  destroyImplantItem,
  installImplantItem,
} = require(path.join(__dirname, "../implants/implantRuntime"));
const {
  syncCharacterDogmaState,
} = require(path.join(__dirname, "../brain/characterBrainRuntime"));
const {
  unwrapMarshalValue,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));

module.exports = {
  _getSkillQueueRuntime() {
    return require(path.join(
      __dirname,
      "../../skills/training/skillQueueRuntime",
    ));
  },

  _captureQueueSnapshotForAttributeChange(charID, reason = "attribute") {
    try {
      const { getQueueSnapshot } = this._getSkillQueueRuntime();
      return getQueueSnapshot(charID);
    } catch (error) {
      log.warn(
        `[DogmaIM] Failed to capture skill queue before ${reason} change char=${charID}: ${error && error.message ? error.message : error}`,
      );
      return null;
    }
  },

  _prepareQueueForAttributeChange(charID, reason = "attribute", snapshot = null) {
    try {
      const { prepareQueueForAttributeChange } = this._getSkillQueueRuntime();
      return prepareQueueForAttributeChange(charID, snapshot ? { snapshot } : {});
    } catch (error) {
      log.warn(
        `[DogmaIM] Failed to prepare skill queue for ${reason} change char=${charID}: ${error && error.message ? error.message : error}`,
      );
      return null;
    }
  },

  _syncQueueAfterAttributeChange(charID, reason = "attribute") {
    try {
      const { syncQueueAfterAttributeChange } = this._getSkillQueueRuntime();
      return syncQueueAfterAttributeChange(charID);
    } catch (error) {
      log.warn(
        `[DogmaIM] Failed to sync skill queue after ${reason} change char=${charID}: ${error && error.message ? error.message : error}`,
      );
      return null;
    }
  },

  _syncCapsuleTypeForCharacter(session, charID) {
    const result = syncCapsuleTypeForCharacter(charID);
    if (!result.success) {
      if (result.errorMsg !== "CAPSULE_NOT_FOUND") {
        log.warn(
          `[DogmaIM] Failed to sync capsule type after implant change char=${charID}: ${result.errorMsg || "UNKNOWN"}`,
        );
      }
      return result;
    }

    if (session && result.changed && result.data) {
      const activeShipID = Number(
        session.shipID ||
        session.shipid ||
        session.activeShipID ||
        session._space && session._space.shipID ||
        0,
      ) || 0;
      if (activeShipID === Number(result.data.itemID)) {
        session.shipTypeID = Number(result.data.typeID) || session.shipTypeID;
        session.shiptypeid = Number(result.data.typeID) || session.shiptypeid;
        session.shipName = result.data.itemName || session.shipName;
      }
      this._syncInventoryChanges(session, [{
        item: result.data,
        previousData: result.previousData || {},
      }]);
    }
    return result;
  },

  _formatBoosterUserError(errorMsg = "") {
    switch (String(errorMsg || "")) {
      case "ITEM_NOT_FOUND":
      case "ITEM_NOT_OWNED":
      case "ITEM_LOCATION_MISMATCH":
        return "That booster is no longer available.";
      case "NOT_A_CONSUMABLE_BOOSTER":
        return "That item cannot be consumed as a booster.";
      case "BOOSTER_EXPIRED":
        return "That booster can no longer be consumed.";
      case "BOOSTER_CHARACTER_TOO_OLD":
        return "Your character is too old to consume that booster.";
      case "BOOSTER_CHARACTER_AGE_UNKNOWN":
        return "That booster cannot be consumed by this character.";
      case "BOOSTER_SLOT_OCCUPIED":
        return "You already have an active booster in that slot.";
      case "INSUFFICIENT_ITEMS":
      case "ITEM_QUANTITY_OUT_OF_RANGE":
        return "You do not have a booster available to consume.";
      default:
        return "The booster could not be consumed.";
    }
  },

  _formatImplantUserError(errorMsg = "") {
    switch (String(errorMsg || "")) {
      case "ITEM_NOT_FOUND":
      case "ITEM_NOT_OWNED":
      case "ITEM_LOCATION_MISMATCH":
      case "IMPLANT_NOT_FOUND":
        return "That implant is no longer available.";
      case "NOT_AN_IMPLANT":
        return "That item cannot be plugged in as an implant.";
      case "IMPLANT_SLOT_OCCUPIED":
        return "You already have an implant in that slot.";
      case "SKILL_REQUIRED":
        return "You do not have the required skills to plug in that implant.";
      case "INSUFFICIENT_ITEMS":
      case "ITEM_QUANTITY_OUT_OF_RANGE":
        return "You do not have an implant available to plug in.";
      default:
        return "The implant could not be plugged in.";
    }
  },

  Handle_InjectImplant(args, session) {
    const itemID = Number.parseInt(String(unwrapMarshalValue(args && args[0])), 10) || 0;
    const charID = this._getCharID(session);
    log.debug(`[DogmaIM] InjectImplant(itemID=${itemID})`);
    const queueSnapshot = this._captureQueueSnapshotForAttributeChange(charID, "implant");
    const result = installImplantItem(charID, itemID, { session });
    if (!result.success) {
      log.warn(
        `[DogmaIM] InjectImplant rejected itemID=${itemID} error=${result.errorMsg || "UNKNOWN"}`,
      );
      this._throwCustomNotifyUserError(this._formatImplantUserError(result.errorMsg));
    }

    if (queueSnapshot) {
      this._prepareQueueForAttributeChange(charID, "implant", queueSnapshot);
    }
    this._syncInventoryChanges(session, result.data.inventoryChanges || []);
    this._syncCapsuleTypeForCharacter(session, charID);
    if (session && typeof session.sendNotification === "function") {
      session.sendNotification("OnServerImplantsChanged", "clientID", []);
      session.sendNotification("OnJumpCloneCacheInvalidated", "clientID", []);
    }
    syncCharacterDogmaState(session, charID, { refreshLiveShip: true });
    this._syncQueueAfterAttributeChange(charID, "implant");
    return null;
  },

  Handle_DestroyImplant(args, session) {
    const itemID = Number.parseInt(String(unwrapMarshalValue(args && args[0])), 10) || 0;
    const charID = this._getCharID(session);
    log.debug(`[DogmaIM] DestroyImplant(itemID=${itemID})`);
    const queueSnapshot = this._captureQueueSnapshotForAttributeChange(charID, "implant");
    const result = destroyImplantItem(charID, itemID);
    if (!result.success) {
      log.warn(
        `[DogmaIM] DestroyImplant rejected itemID=${itemID} error=${result.errorMsg || "UNKNOWN"}`,
      );
      this._throwCustomNotifyUserError(this._formatImplantUserError(result.errorMsg));
    }

    if (queueSnapshot) {
      this._prepareQueueForAttributeChange(charID, "implant", queueSnapshot);
    }
    this._syncCapsuleTypeForCharacter(session, charID);
    if (session && typeof session.sendNotification === "function") {
      session.sendNotification("OnServerImplantsChanged", "clientID", []);
      session.sendNotification("OnJumpCloneCacheInvalidated", "clientID", []);
    }
    syncCharacterDogmaState(session, charID, { refreshLiveShip: true });
    this._syncQueueAfterAttributeChange(charID, "implant");
    return null;
  },

  Handle_UseBooster(args, session) {
    const itemID = Number.parseInt(String(unwrapMarshalValue(args && args[0])), 10) || 0;
    const locationID = Number.parseInt(String(unwrapMarshalValue(args && args[1])), 10) || 0;
    const charID = this._getCharID(session);
    log.debug(`[DogmaIM] UseBooster(itemID=${itemID}, locationID=${locationID})`);
    const queueSnapshot = this._captureQueueSnapshotForAttributeChange(charID, "booster");
    const result = useBoosterItem(
      charID,
      itemID,
      locationID > 0 ? locationID : null,
    );
    if (!result.success) {
      log.warn(
        `[DogmaIM] UseBooster rejected itemID=${itemID} error=${result.errorMsg || "UNKNOWN"}`,
      );
      this._throwCustomNotifyUserError(this._formatBoosterUserError(result.errorMsg));
    }

    if (queueSnapshot) {
      this._prepareQueueForAttributeChange(charID, "booster", queueSnapshot);
    }
    this._syncInventoryChanges(session, result.data.inventoryChanges || []);
    if (session && typeof session.sendNotification === "function") {
      session.sendNotification("OnServerBoostersChanged", "charid", []);
    }
    syncCharacterDogmaState(session, charID, { refreshLiveShip: true });
    this._syncQueueAfterAttributeChange(charID, "booster");
    return null;
  },
};
