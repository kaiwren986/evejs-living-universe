"use strict";

// Ship health chat commands: /heal (restore the docked ship, its modules and its charges to
// full), /dmg (damage them to a light, medium or heavy test preset) and /invu (toggle NPC
// invulnerability, so rats and CONCORD ignore the caller), with the damage presets and the
// repair and damage helpers they use.

const path = require("path");

const {
  getActiveShipRecord,
  syncDamageStateAttributesForSession,
  syncInventoryItemForSession,
  syncShipFittingStateForSession,
} = require("../../character/characterState");
const {
  updateShipItem,
  normalizeShipConditionState,
  updateInventoryItem,
  findItemById,
} = require("../../inventory/itemStore");
const {
  listFittedItems,
  isFittedModuleItem,
  normalizeModuleState,
} = require("../../fitting/liveFittingState");
const spaceRuntime = require("../../../space/runtime");
const npcService = require("../../../space/npc");
const {
  isDockedSession,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  parseToggleCommandArgument,
} = require(path.join(__dirname, "./commandArguments"));
const {
  isSpaceSessionReady,
} = require(path.join(__dirname, "./commandSessionLocation"));

const DAMAGE_TEST_PRESETS = Object.freeze({
  light: {
    label: "light",
    ship: {
      damage: 0.1,
      charge: 0.65,
      armorDamage: 0.18,
      shieldCharge: 0.7,
    },
    module: {
      damage: 0.08,
      charge: 0,
      armorDamage: 0.04,
      shieldCharge: 0.8,
      incapacitated: false,
    },
  },
  medium: {
    label: "medium",
    ship: {
      damage: 0.2,
      charge: 0.35,
      armorDamage: 0.35,
      shieldCharge: 0.45,
    },
    module: {
      damage: 0.18,
      charge: 0,
      armorDamage: 0.1,
      shieldCharge: 0.6,
      incapacitated: false,
    },
  },
  heavy: {
    label: "heavy",
    ship: {
      damage: 0.35,
      charge: 0.18,
      armorDamage: 0.6,
      shieldCharge: 0.22,
    },
    module: {
      damage: 0.3,
      charge: 0,
      armorDamage: 0.18,
      shieldCharge: 0.42,
      incapacitated: false,
    },
  },
});

function healDockedShipForSession(session) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip || !activeShip.itemID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const updateResult = updateShipItem(activeShip.itemID, (currentShip) => ({
    ...currentShip,
    conditionState: normalizeShipConditionState({
      ...(currentShip.conditionState || {}),
      damage: 0,
      charge: 1,
      armorDamage: 0,
      shieldCharge: 1,
    }),
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  const changedModuleIDs = [];
  const fittedModules = listFittedItems(
    session.characterID,
    activeShip.itemID,
  ).filter((item) => isFittedModuleItem(item));
  for (const fittedModule of fittedModules) {
    const moduleState = normalizeModuleState(fittedModule.moduleState);
    if (
      moduleState.damage <= 0 &&
      moduleState.armorDamage <= 0 &&
      moduleState.shieldCharge >= 1 &&
      moduleState.incapacitated !== true
    ) {
      continue;
    }

    const moduleUpdateResult = updateInventoryItem(
      fittedModule.itemID,
      (currentItem) => ({
        ...currentItem,
        moduleState: normalizeModuleState({
          ...(currentItem.moduleState || {}),
          damage: 0,
          armorDamage: 0,
          shieldCharge: 1,
          incapacitated: false,
        }),
      }),
    );
    if (!moduleUpdateResult.success) {
      return moduleUpdateResult;
    }
    syncDamageStateAttributesForSession(
      session,
      moduleUpdateResult.data,
      moduleUpdateResult.previousData || {},
    );
    changedModuleIDs.push(fittedModule.itemID);
  }

  syncInventoryItemForSession(
    session,
    updateResult.data,
    updateResult.previousData || {},
    { emitCfgLocation: true },
  );

  if (changedModuleIDs.length > 0) {
    syncShipFittingStateForSession(session, activeShip.itemID, {
      includeOfflineModules: true,
      includeCharges: false,
      restrictToItemIDs: changedModuleIDs,
    });
  }

  return {
    ...updateResult,
    repairedModuleIDs: changedModuleIDs,
  };
}

function formatCountLabel(count, singular, plural) {
  const numericCount = Number(count) || 0;
  return `${numericCount} ${numericCount === 1 ? singular : plural}`;
}

function resolveDamageTestPreset(argumentText) {
  const normalized = String(argumentText || "").trim().toLowerCase();
  if (!normalized) {
    return {
      success: true,
      preset: DAMAGE_TEST_PRESETS.medium,
    };
  }

  const preset = DAMAGE_TEST_PRESETS[normalized];
  if (!preset) {
    return {
      success: false,
      errorMsg: "INVALID_DAMAGE_PRESET",
    };
  }

  return {
    success: true,
    preset,
  };
}

function damageDockedShipForSession(session, preset) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }

  if (!isDockedSession(session)) {
    return {
      success: false,
      errorMsg: "NOT_DOCKED",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip || !activeShip.itemID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const updateResult = updateShipItem(activeShip.itemID, (currentShip) => ({
    ...currentShip,
    conditionState: normalizeShipConditionState({
      ...(currentShip.conditionState || {}),
      ...((preset && preset.ship) || {}),
    }),
  }));
  if (!updateResult.success) {
    return updateResult;
  }

  const changedModuleIDs = [];
  const fittedModules = listFittedItems(
    session.characterID,
    activeShip.itemID,
  ).filter((item) => isFittedModuleItem(item));

  for (const fittedModule of fittedModules) {
    const moduleUpdateResult = updateInventoryItem(
      fittedModule.itemID,
      (currentItem) => ({
        ...currentItem,
        moduleState: normalizeModuleState({
          ...(currentItem.moduleState || {}),
          ...((preset && preset.module) || {}),
        }),
      }),
    );
    if (!moduleUpdateResult.success) {
      return moduleUpdateResult;
    }
    changedModuleIDs.push(fittedModule.itemID);
  }

  syncInventoryItemForSession(
    session,
    updateResult.data,
    updateResult.previousData || {},
    { emitCfgLocation: true },
  );

  if (changedModuleIDs.length > 0) {
    syncShipFittingStateForSession(session, activeShip.itemID, {
      includeOfflineModules: true,
      includeCharges: false,
      restrictToItemIDs: changedModuleIDs,
    });
  }

  return {
    success: true,
    data: {
      shipID: activeShip.itemID,
      presetLabel: String((preset && preset.label) || "medium"),
      moduleCount: changedModuleIDs.length,
    },
  };
}

function handleInvuCommand(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /invu.",
    );
  }

  const trimmed = String(argumentText || "").trim();
  let result = null;
  if (!trimmed) {
    result = npcService.toggleCharacterNpcInvulnerability(session.characterID);
  } else {
    const parsed = parseToggleCommandArgument(trimmed);
    if (!parsed.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /invu [on|off]",
      );
    }

    if (parsed.mode === "status") {
      const enabled = npcService.isCharacterInvulnerable(session.characterID);
      return handledResult(
        chatHub,
        session,
        options,
        `Invulnerability is ${enabled ? "ON" : "OFF"}. Rats and CONCORD ${enabled ? "will" : "will not"} ignore you.`,
      );
    }

    result = npcService.setCharacterNpcInvulnerability(
      session.characterID,
      parsed.mode === "on",
    );
  }

  if (!result || !result.success || !result.data) {
    return handledResult(
      chatHub,
      session,
      options,
      `Invulnerability update failed: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}.`,
    );
  }

  if (isSpaceSessionReady(session)) {
    const scene = spaceRuntime.getSceneForSession(session);
    if (scene) {
      npcService.tickScene(scene, scene.getCurrentSimTimeMs());
    }
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Invulnerability is now ${result.data.invulnerable ? "ON" : "OFF"}. Rats and CONCORD ${result.data.invulnerable ? "will" : "will not"} ignore you.`,
  );
}

function handleRepairModulesCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!require("./commandAccess").hasStaffDebugRole(session)) {
    return reply("/repairmodules requires a staff/admin role.");
  }
  if (String(argumentText || "").trim()) return reply("Usage: /repairmodules");
  const ship = getActiveShipRecord(session && session.characterID);
  if (!ship) return reply("Board a ship before using /repairmodules.");
  let repaired = [];
  if (isSpaceSessionReady(session)) {
    const scene = spaceRuntime.getSceneForSession(session);
    const entity = scene && scene.getShipEntityForSession(session);
    if (!entity || Number(entity.itemID) !== Number(ship.itemID)) return reply("Active ship not found in space.");
    repaired = require("../../../space/runtime/moduleHeat").repairEntityFittedModules(entity, { session });
  } else if (isDockedSession(session)) {
    for (const item of listFittedItems(session.characterID, ship.itemID).filter(isFittedModuleItem)) {
      const state = normalizeModuleState(item.moduleState);
      if (!(state.damage > 0 || state.armorDamage > 0 || state.shieldCharge < 1 || state.incapacitated)) continue;
      const result = updateInventoryItem(item.itemID, (current) => ({
        ...current,
        moduleState: normalizeModuleState({ ...current.moduleState,
          damage: 0, armorDamage: 0, shieldCharge: 1, incapacitated: false }),
      }));
      if (!result.success) return reply(`Repaired ${repaired.length} modules; repair failed: ${result.errorMsg}.`);
      syncDamageStateAttributesForSession(session, result.data, result.previousData || {});
      repaired.push(item.itemID);
    }
    if (repaired.length) syncShipFittingStateForSession(session, ship.itemID, {
      includeOfflineModules: true, includeCharges: false, restrictToItemIDs: repaired,
    });
  } else return reply("Your active ship must be docked or present in space.");
  return reply(`Repaired ${repaired.length} fitted modules.`);
}

function handleNativeHealCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!require("./commandAccess").hasStaffDebugRole(session)) return reply("Targeted /heal requires a staff/admin role.");
  const text = String(argumentText || "").trim();
  if (/^me$/i.test(text)) return handleHealCommand(session, chatHub, options);
  if (/^me\s+capac=1$/i.test(text)) {
    const scene = spaceRuntime.getSceneForSession(session);
    const entity = scene && scene.getShipEntityForSession(session);
    if (!entity) return reply("Enter space before using /heal me capac=1.");
    const cap = require("../../../space/runtime/entityCapacitor");
    const previousRatio = cap.getEntityCapacitorRatio(entity);
    const previousAmount = cap.getEntityCapacitorAmount(entity);
    cap.setEntityCapacitorRatio(entity, 1);
    if (!cap.persistEntityCapacitorRatio(entity)) {
      cap.setEntityCapacitorRatio(entity, previousRatio);
      return reply("Could not save the capacitor restore.");
    }
    require("../../../space/runtime/attributeChangeNotification").notifyCapacitorChangeToSession(
      session, entity, scene.getCurrentSimTimeMs(), previousAmount,
    );
    return reply("Restored your ship's capacitor.");
  }
  const itemID = /^\d+$/.test(text) ? Number(text) : 0;
  const item = Number.isSafeInteger(itemID) && itemID > 0 ? findItemById(itemID) : null;
  if (!item || Number(item.ownerID) !== Number(session.characterID) || ![7, 32].includes(Number(item.categoryID))) {
    return reply("Usage: /heal [me|me capac=1|ownedModuleID]");
  }
  const ship = getActiveShipRecord(session.characterID);
  const scene = spaceRuntime.getSceneForSession(session);
  const entity = scene && scene.getShipEntityForSession(session);
  if (entity && Number(item.locationID) === Number(entity.itemID) && isFittedModuleItem(item)) {
    require("../../../space/runtime/moduleHeat").repairEntityFittedModules(entity, { session, moduleIDs: [itemID] });
  } else {
    const result = updateInventoryItem(itemID, (current) => ({ ...current,
      moduleState: normalizeModuleState({ ...current.moduleState,
        damage: 0, armorDamage: 0, shieldCharge: 1, incapacitated: false }),
    }));
    if (!result.success) return reply(`Module repair failed: ${result.errorMsg}.`);
    syncDamageStateAttributesForSession(session, result.data, result.previousData || {});
    if (ship && Number(item.locationID) === Number(ship.itemID)) syncShipFittingStateForSession(session, ship.itemID, {
      includeOfflineModules: true, includeCharges: false, restrictToItemIDs: [itemID],
    });
  }
  const saved = findItemById(itemID);
  const state = saved && normalizeModuleState(saved.moduleState);
  if (!state || state.damage > 0 || state.armorDamage > 0 || state.shieldCharge < 1 || state.incapacitated) {
    return reply(`Module ${itemID} could not be repaired.`);
  }
  return reply(`Repaired module ${itemID}.`);
}

function handleHealCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /heal.",
    );
  }

  if (isSpaceSessionReady(session)) {
    const result = spaceRuntime.healSessionShipResources(session, {
      // /heal is a live resource restore, not a real session move. Avoid the
      // owner SetState rebase path here because that packet can rebuild the
      // local ballpark without the follow-up module/charge hydration that
      // login, undock, jump, and other attach flows intentionally queue.
      refreshOwnerDamagePresentation: false,
    });
    if (!result || !result.success) {
      const message =
        result && result.errorMsg === "SCENE_NOT_FOUND"
          ? "Your ship is not loaded in space yet."
          : "Active ship not found in space.";
      return handledResult(chatHub, session, options, message);
    }

    return handledResult(
      chatHub,
      session,
      options,
      "Restored full shields, armor, hull, capacitor, and fitted modules on your active ship.",
    );
  }

  const updateResult = healDockedShipForSession(session);
  if (!updateResult || !updateResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Active ship not found.",
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    "Restored full shields, armor, hull, capacitor, and fitted modules on your active ship.",
  );
}

function handleDamageCommand(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /dmg.",
    );
  }

  const presetResult = resolveDamageTestPreset(argumentText);
  if (!presetResult.success || !presetResult.preset) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /dmg [light|medium|heavy]",
    );
  }

  const damageResult = damageDockedShipForSession(session, presetResult.preset);
  if (!damageResult || !damageResult.success || !damageResult.data) {
    const message =
      damageResult && damageResult.errorMsg === "NOT_DOCKED"
        ? "Dock first before using /dmg so the repair flow stays easy to test."
        : "Active docked ship not found.";
    return handledResult(chatHub, session, options, message);
  }

  const moduleCount = Number(damageResult.data.moduleCount || 0);
  const presetLabel = damageResult.data.presetLabel || "medium";
  const moduleText =
    moduleCount > 0
      ? ` and ${formatCountLabel(moduleCount, "fitted module", "fitted modules")}`
      : "";

  return handledResult(
    chatHub,
    session,
    options,
    `Applied ${presetLabel} test damage to your active ship${moduleText}.`,
  );
}

module.exports = {
  handleInvuCommand,
  handleHealCommand,
  handleRepairModulesCommand,
  handleNativeHealCommand,
  handleDamageCommand,
};
