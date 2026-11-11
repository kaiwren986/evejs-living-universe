"use strict";

// EveJS RPG fork: generated contracts, end to end.
//
//   request  -> the director plans the facts, the writer tells the story (offered)
//   accept   -> a real private combat site and a bookmark are created (accepted)
//   kill     -> EveJS marks the site's objective met; we notice (completed)
//   payout   -> ISK is paid once, under an idempotency key (paid)
//
// One record per pilot in the rpgContracts table. Every step saves before it
// acts, so a crash or restart resumes instead of repeating: an accepted
// contract gets its site back, a completed one gets paid on the next start.

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const dungeonRuntime = require(path.join(__dirname, "../../services/dungeon/dungeonRuntime"));
const walletState = require(path.join(__dirname, "../../services/account/walletState"));
const log = require(path.join(__dirname, "../../utils/logger"));
const director = require("./contractDirector");
const writer = require("./contractWriter");
const site = require("./contractSite");

const TABLE = "rpgContracts";
const PAYER_ID = 1000125; // CONCORD: the name shown against the payment in the wallet journal
const KEPT_CONTRACTS = 12;
const KEPT_MEMORIES = 6;
const OPEN_STATES = Object.freeze(["offered", "accepted", "completed"]);

let started = false;
const lanes = new Map(); // characterID -> promise; one contract operation per pilot at a time

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function load(characterID) {
  database.ensureTable(TABLE);
  const row = database.read(TABLE, `/${characterID}`);
  if (row.success && row.data) return JSON.parse(JSON.stringify(row.data));
  return { version: 1, ownerID: characterID, sequence: 0, contracts: [], memories: [] };
}

function save(record) {
  const closed = record.contracts.filter((contract) => !OPEN_STATES.includes(contract.state));
  const open = record.contracts.filter((contract) => OPEN_STATES.includes(contract.state));
  record.contracts = [...closed.slice(-(KEPT_CONTRACTS - open.length)), ...open];
  record.memories = record.memories.slice(-KEPT_MEMORIES);
  const written = database.write(TABLE, `/${record.ownerID}`, record);
  if (written?.success !== true || database.flushTableSync(TABLE)?.success !== true) {
    throw fail("CONTRACT_STORE_UNAVAILABLE", "Contract records could not be saved. Nothing was changed.");
  }
}

function serialize(characterID, action) {
  const run = (lanes.get(characterID) || Promise.resolve()).catch(() => {}).then(action);
  lanes.set(characterID, run);
  void run.finally(() => { if (lanes.get(characterID) === run) lanes.delete(characterID); }).catch(() => {});
  return run;
}

function openContract(record) {
  return record.contracts.find((contract) => OPEN_STATES.includes(contract.state)) || null;
}

// What the client is shown. Internal fields (forces, positions) stay on the server.
function view(contract) {
  if (!contract) return null;
  const { facts, story } = contract;
  return {
    id: contract.id,
    state: contract.state,
    title: story.title,
    clientName: story.clientName,
    clientRole: story.clientRole,
    bossName: story.bossName,
    bossEpithet: story.bossEpithet,
    siteName: story.siteName,
    briefing: story.briefing,
    taunt: story.taunt,
    debrief: story.debrief,
    storySource: story.source,
    factionName: facts.factionName,
    systemID: facts.systemID,
    systemName: facts.systemName,
    security: facts.security,
    jumps: facts.jumps,
    anchorName: facts.anchorName,
    hostileCount: facts.hostileCount,
    bossHull: facts.bossHull,
    rewardIsk: facts.rewardIsk,
    cache: facts.cache.map((item) => `${item.quantity} x ${item.name}`),
    // Where the hideout is, so the client can tell when the pilot has arrived.
    x: facts.position.x,
    y: facts.position.y,
    z: facts.position.z,
    paid: contract.state === "paid",
  };
}

function summary(record) {
  const current = openContract(record);
  const last = [...record.contracts].reverse().find((contract) => contract.state === "paid") || null;
  return {
    contract: view(current),
    // The most recent paid contract, so the window can show its debrief once.
    lastPaid: current ? null : view(last),
    completedCount: record.contracts.filter((contract) => contract.state === "paid").length,
  };
}

function getContracts(characterID) {
  const record = load(characterID);
  // A payment that failed is retried whenever the pilot's window asks, not only at server start.
  const pending = record.contracts.find((contract) => contract.state === "completed");
  if (pending) void settle(characterID, pending.id);
  return summary(record);
}

/** Offer a new contract, or return the one already open. */
function requestContract({ characterID, pilotName, shipName, shipTypeID, solarSystemID }) {
  return serialize(characterID, async () => {
    const record = load(characterID);
    if (openContract(record)) return summary(record);
    const sequence = record.sequence + 1;
    const facts = director.planBounty({ characterID, shipTypeID, solarSystemID, sequence });
    if (!facts) throw fail("CONTRACT_UNAVAILABLE", "No work is on offer out here.");
    const story = await writer.writeStory({ ...facts, pilotName, shipName }, record.memories);
    // Re-read: the story took seconds to write and the record may have moved on.
    const fresh = load(characterID);
    if (openContract(fresh)) return summary(fresh);
    fresh.sequence = sequence;
    fresh.contracts.push({
      id: `c${sequence}`, sequence, state: "offered", createdAtMs: Date.now(), facts, story,
      instanceID: null, siteID: null, bookmarkID: null, bookmarkFolderID: null, bookmarkInstanceID: null,
    });
    save(fresh);
    log.info(`[Contracts] offered ${characterID}/c${sequence}: "${story.title}" in ${facts.systemName} (${story.source})`);
    return summary(fresh);
  });
}

function acceptContract(characterID, contractID) {
  return serialize(characterID, async () => {
    const record = load(characterID);
    const contract = record.contracts.find((entry) => entry.id === contractID);
    if (!contract) throw fail("CONTRACT_NOT_FOUND", "That contract is no longer on offer.");
    if (contract.state === "offered") {
      // Saved as accepted first: if the site call is interrupted, startup rebuilds it.
      contract.state = "accepted";
      contract.acceptedAtMs = Date.now();
      save(record);
    }
    if (contract.state === "accepted") {
      Object.assign(contract, site.createSite(characterID, contract));
      save(record);
      log.info(`[Contracts] accepted ${characterID}/${contract.id}: site ${contract.instanceID} in ${contract.facts.systemName}`);
    }
    return summary(record);
  });
}

/** Decline an offer or walk away from an accepted job. */
function abandonContract(characterID, contractID) {
  return serialize(characterID, async () => {
    const record = load(characterID);
    const contract = record.contracts.find((entry) => entry.id === contractID);
    if (!contract || !["offered", "accepted"].includes(contract.state)) return summary(record);
    const wasAccepted = contract.state === "accepted";
    contract.state = wasAccepted ? "abandoned" : "declined";
    contract.closedAtMs = Date.now();
    if (wasAccepted) record.memories.push(writer.memoryLine(contract.facts, contract.story, "abandoned"));
    save(record);
    if (wasAccepted) site.removeSite(characterID, contract);
    return summary(record);
  });
}

async function pay(characterID, contract) {
  const key = `rpg-contract:${characterID}:${contract.id}:isk`;
  const result = await walletState.adjustCharacterBalanceAsync(
    characterID,
    contract.facts.rewardIsk,
    {
      idempotencyKey: key,
      description: `Contract payment: ${contract.story.title}`,
      ownerID1: PAYER_ID,
      ownerID2: characterID,
      referenceID: PAYER_ID,
      entryTypeID: walletState.JOURNAL_ENTRY_TYPE.AGENT_MISSION_REWARD,
    },
    { commandID: key, source: "rpg-contract-reward" },
  );
  if (!result || result.success !== true) {
    throw fail("CONTRACT_PAYMENT_PENDING", result?.errorMsg || "Payment is pending.");
  }
  database.flushTableSync("characters");
}

// The objective is met: record it, then pay. Both steps are safe to repeat.
function settle(characterID, contractID) {
  return serialize(characterID, async () => {
    const record = load(characterID);
    const contract = record.contracts.find((entry) => entry.id === contractID);
    if (!contract) return;
    if (contract.state === "accepted") {
      contract.state = "completed";
      contract.completedAtMs = Date.now();
      record.memories.push(writer.memoryLine(contract.facts, contract.story, "completed"));
      save(record);
      log.info(`[Contracts] completed ${characterID}/${contract.id}: ${contract.story.bossName} is dead`);
    }
    if (contract.state === "completed") {
      await pay(characterID, contract);
      contract.state = "paid";
      contract.paidAtMs = Date.now();
      save(record);
      site.removeBookmark(characterID, contract);
      log.info(`[Contracts] paid ${characterID}/${contract.id}: ${contract.facts.rewardIsk} ISK`);
    }
  }).catch((error) => {
    log.warn(`[Contracts] settling ${characterID}/${contractID} is pending: ${error.message}`);
  });
}

function onInstanceChange(change) {
  const instance = change?.after;
  const contractID = instance?.metadata?.rpgContractID;
  if (!contractID || !site.objectiveMet(instance) || site.objectiveMet(change.before)) return;
  void settle(Number(instance.metadata.rpgContractCharacterID), contractID);
}

// Finish anything a restart interrupted.
function recover() {
  database.ensureTable(TABLE);
  const root = database.read(TABLE, "/");
  for (const [id, record] of Object.entries((root.success && root.data) || {})) {
    const characterID = Number(id);
    for (const contract of record?.contracts || []) {
      if (contract.state === "completed") {
        void settle(characterID, contract.id);
      } else if (contract.state === "accepted") {
        const instance = contract.instanceID ? dungeonRuntime.getInstance(contract.instanceID) : null;
        if (instance && site.objectiveMet(instance)) void settle(characterID, contract.id);
        // Re-running accept is safe: it rebuilds a missing site and repairs its saved location.
        else void acceptContract(characterID, contract.id).catch((error) => log.warn(`[Contracts] could not restore ${characterID}/${contract.id}: ${error.message}`));
      }
    }
  }
}

/** Called once when the bridge service is constructed at server start. */
function start() {
  if (started) return;
  started = true;
  dungeonRuntime.registerInstanceChangeListener(onInstanceChange);
  // After the rest of startup: recovery touches dungeons, bookmarks and wallets.
  setTimeout(() => {
    try { recover(); } catch (error) { log.warn(`[Contracts] recovery deferred: ${error.message}`); }
  }, 15000).unref?.();
}

module.exports = { start, getContracts, requestContract, acceptContract, abandonContract, _testing: { settle, view } };
