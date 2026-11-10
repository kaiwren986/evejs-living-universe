"use strict";

const database = require("../../gameStore");
const engine = require("./homefrontEngine");
const store = require("./homefrontStore");
const inFlight = new Map();
const pruning = new Set();
const wallet = () => require("../account/walletState");
const TERMINAL_STATES = new Set(["completed", "failed", "despawned"]);

function electionAdapter() {
  return require("../seasons/homefrontEventAdapter");
}

function readForOperation(instance) {
  const operation = store.getOperation(instance);
  const receipts = {};
  const pending = {};
  for (const id of operation?.receiptIDs || []) {
    const receipt = store.read(`/receipts/${id}`);
    if (!receipt) continue;
    receipts[id] = receipt;
    for (const participant of receipt.participants) {
      pending[participant.characterID] ??=
        store.read(`/pending/${participant.characterID}`) || {};
    }
  }
  return { receipts, pending };
}

function commit(
  instance,
  config,
  operation,
  characterIDs,
  now,
  key = "completion",
  reward = config.reward,
) {
  const id = `homefront-v1:${instance.instanceID}:${key}`;
  const existing = store.read(`/receipts/${id}`);
  if (existing) return existing;
  const currentInstance = require("../dungeon/dungeonRuntime").getInstance(
    instance.instanceID,
  );
  if (currentInstance?.environmentState?.homefrontRewardsRetired) {
    throw new Error("Homefront rewards have already been retired");
  }
  if (
    operation.status !== "completed" &&
    !operation.settlements.some((settlement) => settlement.key === key)
  ) {
    throw new Error("Homefront completion is not authoritative");
  }
  const sealed =
    key === "completion"
      ? operation.completion
      : operation.settlements.find((settlement) => settlement.key === key);
  const recipients =
    sealed?.characterIDs || engine.recipients(operation, config, characterIDs);
  const amount = Math.floor(
    engine.rewardAmount(reward, recipients.length) *
      (key.startsWith("wave:") ? (config.waveRewardScale ?? 1) : 1),
  );
  const receipt = {
    id,
    instanceID: instance.instanceID,
    systemID: instance.solarSystemID,
    territory: config.empireFactionID,
    operation: config.family,
    completedAtMs: sealed?.completedAtMs || now,
    key,
    participants: recipients.map((characterID) => ({
      characterID,
      isk: amount,
      election: ["completion", "wave:9"].includes(key)
        ? electionAdapter().snapshot(characterID, instance, config) || null
        : null,
      walletOptions: {
        entryTypeID: wallet().JOURNAL_ENTRY_TYPE.CORPORATE_REWARD_PAYOUT,
        ownerID1: reward.rewardingNpcCorporationID,
        ownerID2: characterID,
        referenceID: instance.solarSystemID,
        description: JSON.stringify({
          DESC: `Homefront ${config.family.replaceAll("_", " ")} — ${key}`,
        }),
      },
    })),
  };
  const committedOperation = {
    ...operation,
    receiptIDs: [...new Set([...(operation.receiptIDs || []), id])],
  };
  const changes = [
    [`/operations/${instance.instanceID}`, committedOperation],
    [`/receipts/${id}`, receipt],
    ...receipt.participants.map((participant) => [
      `/pending/${participant.characterID}`,
      {
        ...(store.read(`/pending/${participant.characterID}`) || {}),
        [id]: true,
      },
    ]),
  ];
  // The operation, receipt and outbox are durable together before wallet IPC.
  store.transaction(changes);
  Object.assign(operation, committedOperation);
  store.markOperationSaved(instance, operation);
  return receipt;
}

function pruneOperationRows(instanceID, { includeOrphans = false } = {}) {
  const dungeon = require("../dungeon/dungeonRuntime");
  const instance = dungeon.getInstance(instanceID);
  if (!instance && !includeOrphans) return false;
  if (instance && !TERMINAL_STATES.has(instance.lifecycleState)) return false;
  const operation = store.getOperation(instance || { instanceID });
  if (!operation) return false;
  const receiptIDs = operation.receiptIDs || [];
  for (const id of receiptIDs) {
    const receipt = store.read(`/receipts/${id}`);
    if (
      receipt?.participants.some(
        (participant) =>
          store.read(`/pending/${participant.characterID}`)?.[id],
      )
    )
      return false;
  }
  if (instance && !instance.environmentState?.homefrontRewardsRetired) {
    // Keep deduplication with the site's existing lifecycle record, rather than
    // retaining encounter history or relying on the wallet's bounded receipts.
    dungeon.mergeEnvironmentStateDurably(instanceID, {
      homefrontRewardsRetired: true,
    });
  }
  store.transaction([
    [`/operations/${instanceID}`, undefined],
    ...receiptIDs.map((id) => [`/receipts/${id}`, undefined]),
  ]);
  store.forgetOperation(instanceID);
  return true;
}

function pruneOperation(instanceID, options) {
  const key = String(instanceID);
  if (pruning.has(key)) return false;
  pruning.add(key);
  try {
    return pruneOperationRows(instanceID, options);
  } finally {
    pruning.delete(key);
  }
}

async function reconcileProgress(session) {
  const characterID = Number(
    session?.characterID || session?.charid || session,
  );
  if (!Number.isSafeInteger(characterID) || characterID <= 0) return;
  if (inFlight.has(characterID)) return inFlight.get(characterID);
  const work = Promise.resolve()
    .then(async () => {
      // A second site can finish while wallet IPC for the first is awaiting.
      // Drain the current outbox before releasing this character's single flight.
      for (;;) {
        const id = Object.keys(store.read(`/pending/${characterID}`) || {})[0];
        if (!id) break;
        const receipt = store.read(`/receipts/${id}`);
        const participant = receipt?.participants.find(
          (entry) => entry.characterID === characterID,
        );
        if (!participant) throw new Error("Missing Homefront receipt");
        // Emergency Aid prototype receipts (homefront-aid-v1) carry no wallet
        // options. A retry must send the payload their first attempt sent, or
        // the wallet refuses the reused key and the payout never settles.
        const walletOptions = {
          ...(participant.walletOptions ||
            (id.startsWith("homefront-aid-v1:")
              ? { description: "Homefront Emergency Aid completion" }
              : {})),
          idempotencyKey: `${id}:${characterID}`,
        };
        // The async command runs in process or through the wallet authority's
        // own process, whichever is in use.
        const result = await wallet().adjustCharacterBalanceAsync(
          characterID,
          participant.isk,
          walletOptions,
        );
        if (!result.success)
          throw new Error(result.errorMsg || "Homefront payment failed");
        const flushed = database.flushTableSync("characters");
        if (!flushed.success) throw new Error(flushed.errorMsg);
        if (participant.election)
          await electionAdapter().apply(session, receipt, participant);
        // Re-read after await so another completed site cannot lose its outbox entry.
        const remaining = store.read(`/pending/${characterID}`) || {};
        delete remaining[id];
        store.transaction([
          [
            `/pending/${characterID}`,
            Object.keys(remaining).length ? remaining : undefined,
          ],
        ]);
        pruneOperation(receipt.instanceID);
      }
    })
    .catch((error) =>
      require("../../utils/logger").warn(
        `[Homefront] Pending reward for ${characterID}: ${error.message}`,
      ),
    )
    .finally(() => inFlight.delete(characterID));
  inFlight.set(characterID, work);
  return work;
}

function settle(receipt, sessions = []) {
  return Promise.all(
    receipt.participants.map((participant) =>
      reconcileProgress(
        sessions.find(
          (session) =>
            Number(session.characterID || session.charid) ===
            participant.characterID,
        ) || { characterID: participant.characterID },
      ),
    ),
  );
}

async function recoverPending() {
  await Promise.all(
    Object.keys(store.read("/pending") || {}).map((characterID) =>
      reconcileProgress({ characterID: Number(characterID) }),
    ),
  );
  for (const instanceID of store.listOperationIDs())
    pruneOperation(instanceID, { includeOrphans: true });
}

module.exports = {
  getOperation: store.getOperation,
  saveOperation: store.saveOperation,
  markOperationDirty: store.markOperationDirty,
  releaseSystem: store.releaseSystem,
  flushOperations: store.flushOperations,
  pruneOperation,
  readForOperation,
  commit,
  reconcileProgress,
  settle,
  recoverPending,
  // Diagnostic/test snapshots only. Gameplay reads individual operation rows.
  read: () => ({
    operations: store.read("/operations") || {},
    receipts: store.read("/receipts") || {},
    pending: store.read("/pending") || {},
  }),
  write(value) {
    store.transaction(
      Object.entries(value).map(([key, data]) => [`/${key}`, data]),
    );
    store.resetCache();
  },
  _testing: { resetCache: store.resetCache },
};
