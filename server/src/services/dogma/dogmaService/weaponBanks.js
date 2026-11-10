"use strict";

// Weapon banks in the dogma service: grouping a ship's weapons so they fire together. LinkWeapons,
// LinkAllWeapons, MergeModuleGroups and PeelAndLink build or change a bank; UnlinkModule,
// UnlinkAllModules and DestroyWeaponBank take one apart. The banks themselves live in the module
// grouping runtime. These are DogmaService methods, moved here as they were; dogmaService.js puts
// them back on the class prototype, so `this` is the service.

const path = require("path");
const log = require(path.join(__dirname, "../../../utils/logger"));
const {
  syncShipFittingStateForSession,
} = require(path.join(__dirname, "../../character/characterState"));
const {
  buildWeaponBankStateDict,
  getShipWeaponBanks,
  getModulesInBank,
  linkWeapons: linkWeaponBanks,
  mergeModuleGroups,
  peelAndLink,
  unlinkModuleFromBank,
  linkAllWeapons: linkAllWeaponBanks,
  unlinkAllWeaponBanks,
  destroyWeaponBank,
} = require(path.join(__dirname, "../../moduleGrouping/moduleGroupingRuntime"));
const spaceRuntime = require(path.join(__dirname, "../../../space/runtime"));

module.exports = {
  _collectWeaponBankTouchedModuleIDs(
    shipID,
    moduleIDs = [],
    options = {},
  ) {
    const numericShipID = Number(shipID) || 0;
    const touchedModuleIDs = new Set();
    if (options.includeAllBanks === true) {
      const banks = getShipWeaponBanks(numericShipID, {
        characterID: this._getCharID(options.session || null),
      });
      for (const [masterID, slaveIDs] of Object.entries(banks || {})) {
        const numericMasterID = Number(masterID) || 0;
        if (numericMasterID > 0) {
          touchedModuleIDs.add(numericMasterID);
        }
        for (const slaveID of Array.isArray(slaveIDs) ? slaveIDs : []) {
          const numericSlaveID = Number(slaveID) || 0;
          if (numericSlaveID > 0) {
            touchedModuleIDs.add(numericSlaveID);
          }
        }
      }
    }
    for (const rawModuleID of Array.isArray(moduleIDs) ? moduleIDs : [moduleIDs]) {
      const numericModuleID = Number(rawModuleID) || 0;
      if (numericModuleID <= 0) {
        continue;
      }
      touchedModuleIDs.add(numericModuleID);
      for (const bankModuleID of getModulesInBank(numericShipID, numericModuleID)) {
        const numericBankModuleID = Number(bankModuleID) || 0;
        if (numericBankModuleID > 0) {
          touchedModuleIDs.add(numericBankModuleID);
        }
      }
    }
    return [...touchedModuleIDs].sort((left, right) => left - right);
  },

  _repairWeaponBankModulePresentation(session, shipID, moduleIDs = []) {
    if (!session || !Array.isArray(moduleIDs) || moduleIDs.length <= 0) {
      return;
    }
    const numericShipID = Number(shipID) || this._getShipID(session);
    if (numericShipID <= 0) {
      return;
    }
    if (!session._space) {
      syncShipFittingStateForSession(session, numericShipID, {
        includeOfflineModules: true,
        includeCharges: true,
        onlyCharges: true,
        // Real fitted-charge inventory rows are not retail's docked identity
        // (golden "Topping Up Ammo from cargo direct to fitting while
        // docked.txt" contains no real itemID for the loaded ammo), and after
        // docked hydration went tuple-only the client cannot resolve them.
        emitChargeInventoryRows: false,
        syntheticFitTransition: true,
      });
      // Carry the per-slot ammo counts in retail's docked form instead: one
      // attribute 805 change per loaded charge tuple.
      this._notifyModuleAttributeChanges(
        session,
        this._buildLoadedChargeTupleQuantityChanges(
          session,
          this._getCharID(session),
          numericShipID,
        ),
      );
      return;
    }
    if (
      spaceRuntime &&
      typeof spaceRuntime.reconcileActiveTurretWeaponBankEffects === "function"
    ) {
      const reconcileResult = spaceRuntime.reconcileActiveTurretWeaponBankEffects(
        session,
        numericShipID,
        moduleIDs,
      );
      if (reconcileResult && reconcileResult.changed) {
        log.debug(
          `[DogmaIM] Reconciled active turret bank effects shipID=${numericShipID} ` +
          `modules=${JSON.stringify(reconcileResult.activeModuleIDs || [])}`,
        );
      }
    }
  },

  _throwWeaponBankMutationUserError(errorMsg = "") {
    switch (String(errorMsg || "").trim()) {
      case "MODULES_MUST_BE_ONLINE":
        this._throwCustomNotifyUserError(
          "All weapons in the bank must be online before grouping them.",
        );
        break;
      case "MODULE_CHARGE_MISMATCH":
        this._throwCustomNotifyUserError(
          "All weapons in the bank must have the same loaded charge, or all be empty.",
        );
        break;
      case "BANK_NOT_FOUND":
        this._throwCustomNotifyUserError("That weapon bank no longer exists.");
        break;
      default:
        this._throwCustomNotifyUserError(
          "Failed to change the current weapon bank configuration.",
        );
        break;
    }
  },

  // The ship a weapon-bank call acts on. The banks are kept by ship ID with no
  // owner beside them, and each call carries the ship as its first argument.
  // The client only ever names the ship it is flying, so that is the only ship
  // a call may name: a call naming any other, or from a session flying none, is
  // refused here before a bank is read or written. A call naming none acts on
  // the session's ship, as it always did.
  _resolveWeaponBankShipID(args, session) {
    // _getShipID answers a placeholder ship for a session with none of its own.
    const fliesAShip = Number(
      session && (session.activeShipID || session.shipID || session.shipid),
    ) > 0;
    const sessionShipID = fliesAShip ? Number(this._getShipID(session)) || 0 : 0;
    const namedShipID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    if (sessionShipID <= 0 || (namedShipID > 0 && namedShipID !== sessionShipID)) {
      this._throwCustomNotifyUserError(
        "You can only change the weapon groups of the ship you are flying.",
      );
    }
    return sessionShipID;
  },

  Handle_LinkWeapons(args, session) {
    const shipID = this._resolveWeaponBankShipID(args, session);
    const masterModuleID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const slaveModuleID = args && args.length > 2 ? Number(args[2]) || 0 : 0;
    const touchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
      shipID,
      [masterModuleID, slaveModuleID],
    );
    const result = linkWeaponBanks(shipID, masterModuleID, slaveModuleID, {
      characterID: this._getCharID(session),
    });
    if (!result || result.success !== true) {
      this._throwWeaponBankMutationUserError(result && result.errorMsg);
    }
    if (result && result.data && result.data.changed) {
      this._repairWeaponBankModulePresentation(session, shipID, touchedModuleIDs);
    }
    return buildWeaponBankStateDict(shipID, {
      banks:
        result && result.data && result.data.banks
          ? result.data.banks
          : null,
      characterID: this._getCharID(session),
    });
  },

  Handle_MergeModuleGroups(args, session) {
    const shipID = this._resolveWeaponBankShipID(args, session);
    const targetMasterID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const sourceMasterID = args && args.length > 2 ? Number(args[2]) || 0 : 0;
    const touchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
      shipID,
      [targetMasterID, sourceMasterID],
    );
    const result = mergeModuleGroups(shipID, targetMasterID, sourceMasterID, {
      characterID: this._getCharID(session),
    });
    if (!result || result.success !== true) {
      this._throwWeaponBankMutationUserError(result && result.errorMsg);
    }
    if (result && result.data && result.data.changed) {
      this._repairWeaponBankModulePresentation(session, shipID, touchedModuleIDs);
    }
    return buildWeaponBankStateDict(shipID, {
      banks:
        result && result.data && result.data.banks
          ? result.data.banks
          : null,
      characterID: this._getCharID(session),
    });
  },

  Handle_PeelAndLink(args, session) {
    const shipID = this._resolveWeaponBankShipID(args, session);
    const targetMasterID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const sourceMasterID = args && args.length > 2 ? Number(args[2]) || 0 : 0;
    const touchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
      shipID,
      [targetMasterID, sourceMasterID],
    );
    const result = peelAndLink(shipID, targetMasterID, sourceMasterID, {
      characterID: this._getCharID(session),
    });
    if (!result || result.success !== true) {
      this._throwWeaponBankMutationUserError(result && result.errorMsg);
    }
    if (result && result.data && result.data.changed) {
      this._repairWeaponBankModulePresentation(session, shipID, touchedModuleIDs);
    }
    return buildWeaponBankStateDict(shipID, {
      banks:
        result && result.data && result.data.banks
          ? result.data.banks
          : null,
      characterID: this._getCharID(session),
    });
  },

  Handle_UnlinkModule(args, session) {
    const shipID = this._resolveWeaponBankShipID(args, session);
    const masterModuleID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const touchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
      shipID,
      [masterModuleID],
    );
    const result = unlinkModuleFromBank(shipID, masterModuleID, {
      characterID: this._getCharID(session),
    });
    if (!result || result.success !== true) {
      this._throwWeaponBankMutationUserError(result && result.errorMsg);
    }
    if (result && result.data && result.data.changed) {
      this._repairWeaponBankModulePresentation(session, shipID, touchedModuleIDs);
    }
    return Number(result && result.data && result.data.peeledModuleID) || 0;
  },

  Handle_LinkAllWeapons(args, session) {
    const shipID = this._resolveWeaponBankShipID(args, session);
    const touchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
      shipID,
      [],
      { includeAllBanks: true, session },
    );
    const result = linkAllWeaponBanks(shipID, {
      characterID: this._getCharID(session),
    });
    if (!result || result.success !== true) {
      this._throwWeaponBankMutationUserError(result && result.errorMsg);
    }
    if (result && result.data && result.data.changed) {
      const nextTouchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
        shipID,
        [],
        { includeAllBanks: true, session },
      );
      this._repairWeaponBankModulePresentation(
        session,
        shipID,
        [...new Set([...touchedModuleIDs, ...nextTouchedModuleIDs])],
      );
    }
    return buildWeaponBankStateDict(shipID, {
      banks:
        result && result.data && result.data.banks
          ? result.data.banks
          : null,
      characterID: this._getCharID(session),
    });
  },

  Handle_UnlinkAllModules(args, session) {
    const shipID = this._resolveWeaponBankShipID(args, session);
    const touchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
      shipID,
      [],
      { includeAllBanks: true, session },
    );
    const result = unlinkAllWeaponBanks(shipID, {
      characterID: this._getCharID(session),
    });
    if (!result || result.success !== true) {
      this._throwWeaponBankMutationUserError(result && result.errorMsg);
    }
    if (result && result.data && result.data.changed) {
      this._repairWeaponBankModulePresentation(session, shipID, touchedModuleIDs);
    }
    return buildWeaponBankStateDict(shipID, {
      banks:
        result && result.data && result.data.banks
          ? result.data.banks
          : {},
      characterID: this._getCharID(session),
    });
  },

  Handle_DestroyWeaponBank(args, session) {
    const shipID = this._resolveWeaponBankShipID(args, session);
    const masterModuleID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    const touchedModuleIDs = this._collectWeaponBankTouchedModuleIDs(
      shipID,
      [masterModuleID],
    );
    const result = destroyWeaponBank(shipID, masterModuleID, {
      characterID: this._getCharID(session),
    });
    if (!result || result.success !== true) {
      this._throwWeaponBankMutationUserError(result && result.errorMsg);
    }
    if (result && result.data && result.data.changed) {
      this._repairWeaponBankModulePresentation(session, shipID, touchedModuleIDs);
    }
    return null;
  },
};
