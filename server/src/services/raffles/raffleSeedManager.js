"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const {
  normalizeInteger,
} = require(path.join(__dirname, "./raffleHelpers"));
const {
  RAFFLE_STATUS,
} = require(path.join(__dirname, "./raffleConstants"));
const {
  buildSeedRaffles,
} = require(path.join(__dirname, "./raffleSeed"));

const DEFAULT_SEED_SHIP_TARGET = 5;
const DEFAULT_SEED_ITEM_TARGET = 5;

class RaffleSeedManager {
  constructor(runtimeState) {
    this._state = runtimeState;
  }

  isEnabled() {
    return config.hyperNetSeedEnabled !== false;
  }

  reconcile() {
    if (!this.isEnabled()) {
      return [];
    }

    this._state.initialize();
    const activeSeedRaffles = this._state.getRaffles().filter((raffleState) => (
      raffleState &&
      raffleState.source === "seed" &&
      normalizeInteger(raffleState.raffleStatus, 0) === RAFFLE_STATUS.RUNNING
    ));
    const activeShipSeeds = activeSeedRaffles.filter((raffleState) => raffleState.seedKind === "ship");
    const activeItemSeeds = activeSeedRaffles.filter((raffleState) => raffleState.seedKind === "item");

    const shipTargetCount = Math.max(
      0,
      normalizeInteger(config.hyperNetSeedShips, DEFAULT_SEED_SHIP_TARGET),
    );
    const itemTargetCount = Math.max(
      0,
      normalizeInteger(config.hyperNetSeedItems, DEFAULT_SEED_ITEM_TARGET),
    );

    const shipShortage = Math.max(0, shipTargetCount - activeShipSeeds.length);
    const itemShortage = Math.max(0, itemTargetCount - activeItemSeeds.length);
    if (shipShortage <= 0 && itemShortage <= 0) {
      return [];
    }

    const createdSeedRaffles = buildSeedRaffles(this._state, {
      shipCount: shipShortage,
      itemCount: itemShortage,
    });
    for (const raffleState of createdSeedRaffles) {
      this._state.addRaffle(raffleState);
    }

    return createdSeedRaffles;
  }

  seedRequested(count) {
    if (!this.isEnabled()) {
      return [];
    }

    this._state.initialize();
    const normalizedCount = Math.max(0, normalizeInteger(count, 0));
    if (normalizedCount <= 0) {
      return [];
    }

    const shipCount = Math.ceil(normalizedCount / 2);
    const itemCount = Math.floor(normalizedCount / 2);
    const createdSeedRaffles = buildSeedRaffles(this._state, {
      shipCount,
      itemCount,
    });

    for (const raffleState of createdSeedRaffles) {
      this._state.addRaffle(raffleState);
    }

    return createdSeedRaffles;
  }
}

module.exports = RaffleSeedManager;
