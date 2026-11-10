"use strict";

// Core gameplay depends on these ports. The bootstrap installs the event owners,
// which can then call core APIs without a reciprocal module dependency.
const noop = () => {};
const no = () => false;
const none = () => null;
const empty = () => [];
const hooks = {
  recovery: { recoverPending: noop },
  trail: { recordMining: no, tickScene: noop },
  missions: { stageCompletion: noop, reconcileCharacter: noop },
  depot: { isDepot: no, getRecord: none, restoreContainer: noop, commitHack: no, beforePurge: noop },
  fabricator: { isFabricator: no, eligibleSystem: no, tick: noop, destroy: none,
    damageMultiplier: () => 1, disruption: no, refreshDepartedBonuses: noop, beforePurge: noop },
  fabricatorBonuses: { BONUSES: {}, shipModifiers: empty, moduleSources: empty },
  fw: { isSite: no, tick: noop, destroy: none, cloakBlocked: no, faction: () => 0 },
  fwRewards: { getReceipt: none, read: () => ({ systems: {} }) },
  outreach: { processTradeFromClient: no },
};

function install(owners) {
  for (const [name, owner] of Object.entries(owners)) {
    if (!Object.hasOwn(hooks, name)) throw new Error(`Unknown event port: ${name}`);
    Object.assign(hooks[name], owner);
  }
}

module.exports = { ...hooks, install };
