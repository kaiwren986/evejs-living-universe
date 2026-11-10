"use strict";

// ACP claims use the earning character's ordinary SP, wallet and item owners.
// Every effect has its own durable receipt; the intent can resume after a hard
// stop between effects without paying any already committed effect twice.
const { createHash } = require("node:crypto");
const database = require("../../gameStore");
const characters = require("../character/characterState");
const store = require("../newEdenStore/storeState");
const { createDurableSchedulerBinding } = require("../_shared/durableSchedulerBinding");
const binding = createDurableSchedulerBinding(), lanes = new Map();
const JOB_TYPE = "career.reward";
function check(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_REWARD_SETTLEMENT_FAILED");
  return result;
}
const effectID = (id, index) => `campaign:${createHash("sha256").update(JSON.stringify([id, "character-delivery", index])).digest("hex")}`;
function isCharacterBoundReward(typeID) {
  return Number(require("../inventory/itemTypeRegistry").resolveItemByTypeID(typeID)?.groupID) === 303 ||
    require("../skills/expertSystems/expertSystemCatalog").isExpertSystemType(typeID);
}
function canFitCargoRewards(characterID, shipID, entries) {
  const items = require("../inventory/itemStore");
  const ship = items.findItemById(shipID);
  if (!ship || Number(ship.ownerID) !== characterID || Number(ship.categoryID) !== 6 || Number(ship.singleton) !== 1) return false;
  // Match the inventory grant's actual representation: copies are singleton2;
  // other rewards, including ships, are packaged singleton0 inventory items.
  const required = entries.reduce((sum, reward) => sum + items.getInventoryItemUnitVolume({
    typeID: reward.typeID, singleton: reward.blueprintRuns ? 2 : 0,
  }) * reward.quantity, 0);
  const used = items.listContainerItems(null, shipID, items.ITEM_FLAGS.CARGO_HOLD)
    .reduce((sum, item) => sum + items.getInventoryItemUnitVolume(item) *
      (Number(item.singleton) > 0 ? 1 : Number(item.stacksize ?? item.quantity)), 0);
  const capacity = require("../fitting/liveFittingState").buildShipResourceState(characterID, ship).cargoCapacity;
  return Number.isFinite(required) && required >= 0 && Number.isFinite(used) && used >= 0 &&
    Number.isFinite(capacity) && capacity >= 0 && used + required <= capacity + 1e-7;
}
function isHangarLocation(locationID) {
  if (require("../../space/worldData").getStationByID(locationID)) return true;
  const structure = require("../structure/structureState").getStructureByID(locationID, { refresh: false });
  return Boolean(structure && !structure.destroyedAt);
}
function canDeliverRewardItems(characterID, target, entries) {
  const { ITEM_FLAGS } = require("../inventory/itemStore");
  if (target?.flagID === ITEM_FLAGS.CARGO_HOLD) return canFitCargoRewards(characterID, target.locationID, entries);
  // A crate can be opened inside a portable container or a specialized ship
  // bay. Those are finite too; use the known home hangar until their admission
  // rules are supported. A missing inventory row is not proof of a station.
  return target?.flagID === ITEM_FLAGS.HANGAR && isHangarLocation(target.locationID);
}
function homeDestination(character) {
  const home = [character.homeStationID, character.schoolStationID, character.birthStationID]
    .map(Number).find(id => id > 0 && isHangarLocation(id));
  return home ? { locationID: home, flagID: require("../inventory/itemStore").ITEM_FLAGS.HANGAR } : null;
}
function destination(character, entries, characterID) {
  const items = require("../inventory/itemStore");
  const stationID = Number(character.stationID || character.structureID || 0);
  if (stationID > 0 && isHangarLocation(stationID)) return { locationID: stationID, flagID: items.ITEM_FLAGS.HANGAR };
  const physical = entries.filter(entry => entry.kind === "item");
  if (!physical.length) return { locationID: 0, flagID: items.ITEM_FLAGS.HANGAR };
  const ship = characters.getActiveShipRecord(characterID);
  if (ship && Number(ship.locationID) === Number(character.solarSystemID) &&
      canFitCargoRewards(characterID, ship.itemID, physical)) return { locationID: ship.itemID, flagID: items.ITEM_FLAGS.CARGO_HOLD };
  return homeDestination(character);
}
function exclusive(accountID, work) {
  const previous = lanes.get(accountID) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  lanes.set(accountID, next);
  return next.finally(() => { if (lanes.get(accountID) === next) lanes.delete(accountID); });
}
async function settleUnlocked(accountID, id, session) {
  let account = store.readRuntimeAccount(accountID), operation = account.careerProgramClaims?.[id];
  if (!operation || operation.accountID !== accountID) throw new Error("CAREER_CLAIM_NOT_FOUND");
  // A lost flush acknowledgement can leave this intent ahead of disk in cache.
  // Recommit before effects, including retries in the accepting process.
  check(database.flushTableSync("newEdenStoreRuntime"));
  if (operation.state === "completed") return { success: true, duplicate: true, data: operation };
  if (operation.deliveryMode !== "earning-character" || operation.state !== "pending") throw new Error("CAREER_CLAIM_STATE_INVALID");
  const character = characters.getCharacterRecord(operation.characterID);
  if (!character || Number(character.accountId) !== accountID) throw new Error("CAREER_CLAIM_OWNER_CHANGED");
  const result = { items: [], changes: [], skillpoints: 0, isk: 0, tokens: [] };
  for (const [index, reward] of operation.entries.entries()) {
    const effect = effectID(id, index);
    if (reward.kind === "sp") {
      check(require("../skills/skillState").grantFreeSkillPointsOnce(operation.characterID, reward.amount, effect));
      result.skillpoints += reward.amount;
    } else if (reward.kind === "isk") {
      const credit = await require("../account/walletState").adjustCharacterBalanceAsync(operation.characterID, reward.amount,
        { idempotencyKey: effect, referenceID: operation.characterID, description: "AIR Career Program reward", requireExactCredit: true,
          entryTypeID: require("../account/walletState").JOURNAL_ENTRY_TYPE.CAREER_PROGRAM_PAYOUT,
          allowLegacyCareerJournalReceipt: true },
        // Version the command envelope, retaining the economic idempotency key.
        // A pre-fix wallet-process command has a different serialized payload.
        { source: "career-reward", commandID: `${effect}:isk:${operation.walletAttempts?.[index] || 0}:journal-v2` });
      if (!credit?.success && credit?.errorMsg === "WALLET_LIMIT") {
        const latest = store.readRuntimeAccount(accountID);
        const attempts = latest.careerProgramClaims[id].walletAttempts ||= {};
        attempts[index] = (operation.walletAttempts?.[index] || 0) + 1;
        check(store.writeRewardAccount(accountID, latest));
      }
      check(credit);
      result.isk += reward.amount;
    } else if (reward.kind === "item") {
      const custody = require("../inventory/itemCustody");
      const proof = check(custody.getCommittedReceipt(effect));
      let target = operation.itemDestinations?.[index] || operation.destination;
      // Capacity can change while a claim waits for money I/O or restart. Check
      // each unpaid item against the current hold, including earlier grants.
      // A committed receipt keeps its original destination and never remints.
      if (!proof.committed && !canDeliverRewardItems(operation.characterID, target, [reward])) {
        const current = characters.getCharacterRecord(operation.characterID);
        const home = homeDestination(current);
        if (!home) throw new Error("CAREER_REWARD_DESTINATION_UNAVAILABLE");
        account = store.readRuntimeAccount(accountID);
        target = home;
        (account.careerProgramClaims[id].itemDestinations ||= {})[index] = target;
        check(store.writeRewardAccount(accountID, account));
        check(database.flushTableSync("newEdenStoreRuntime"));
        operation = account.careerProgramClaims[id];
      }
      const transfer = check(custody.transfer({ items: { typeID: reward.typeID, quantity: reward.quantity,
        options: { singleton: reward.blueprintRuns ? 2 : 0,
          ...(isCharacterBoundReward(reward.typeID) ? { careerBoundCharacterID: operation.characterID } : {}) } },
        to: custody.custodyRef.ownerLocation(operation.characterID, target.locationID, target.flagID),
        actor: operation.characterID, reason: custody.CUSTODY_REASON.CAMPAIGN_REWARD_GRANT, idempotencyKey: effect }));
      if (!transfer.durable) throw new Error("CAREER_ITEM_GRANT_NOT_DURABLE");
      if (reward.blueprintRuns && transfer.data.items.length) check(require("../inventory/blueprintRewardState").ensureGrantedBlueprintCopyState(transfer.data.items,
        { runsRemaining: reward.blueprintRuns, materialEfficiency: reward.materialEfficiency, timeEfficiency: reward.timeEfficiency }));
      // Crate opening and expert-system activation remain separate native RPCs.
      result.items.push(...(transfer.data.items || []));
      result.changes.push(...(transfer.data.changes || []));
    } else throw new Error("CAREER_REWARD_UNSUPPORTED");
  }
  // Wallet I/O may have interleaved a different reward/account mutation.
  account = store.readRuntimeAccount(accountID);
  operation = { ...account.careerProgramClaims[id], state: "completed", result };
  account.careerProgramClaims[id] = operation;
  check(store.writeRewardAccount(accountID, account));
  check(database.flushTableSync("newEdenStoreRuntime"));
  require("./careerRewardRuntime").notifyCompleted(operation, session);
  return { success: true, duplicate: false, data: operation };
}
function settle(accountID, id, session) { return exclusive(accountID, () => settleUnlocked(accountID, id, session)); }
function enqueue(accountID, id) {
  return binding.get()?.schedule({ jobID: id, type: JOB_TYPE, dueAtMs: Date.now(), payload: { accountID, id } });
}
async function reconcile() {
  const root = check(database.read("newEdenStoreRuntime", "/"));
  for (const [key, account] of Object.entries(root.data?.accounts || {})) for (const operation of Object.values(account.careerProgramClaims || {})) {
    if (operation.deliveryMode !== "earning-character" || operation.state !== "pending") continue;
    if (Number(key) !== operation.accountID) throw new Error("CAREER_CLAIM_IDENTITY_MISMATCH");
    if (binding.get()) await enqueue(operation.accountID, operation.id);
    else await settle(operation.accountID, operation.id);
  }
}
async function drain() { await Promise.allSettled([...lanes.values()]); }
module.exports = { JOB_TYPE, destination, canFitCargoRewards, canDeliverRewardItems, homeDestination,
  effectID, isCharacterBoundReward, settle, enqueue, reconcile, drain,
  bindDurableScheduler: binding.bind, unbindDurableScheduler: binding.unbind,
  handleJob: job => settle(job.payload.accountID, job.payload.id) };
