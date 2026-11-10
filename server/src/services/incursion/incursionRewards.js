"use strict";
const incursionClock = require("./incursionClock");

const crypto = require("node:crypto");
const database = require("../../gameStore");
const store = require("./incursionRewardStore");
const { evaluateGroupReward, REWARD_TYPE, validateRewardGroup } = require("../rewards/groupRewardEvaluator");
const { resolveCorporationTaxProfile, computeCorporationTax, buildCorporationTaxDescription,
  CORPORATION_TAX_CURRENCY, isUnpayableCorporationTaxError } = require("../corporation/corporationTax");
const log = require("../../utils/logger");
const clone = value => structuredClone(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const EVENT = Object.freeze({ STORED: 312, PAID: 313, LOST: 314, DISQUALIFIED: 315, DIRECT: 471 });
// Supported appConst rewardIneligibleReason values. These name server decisions;
// they do not establish how participation or fleet competition is calculated.
const NATIVE_DISQUALIFIER = Object.freeze({ "trial-account": 1, "invalid-group": 2, cloaked: 3,
  "not-in-fleet": 4, "not-best-fleet": 5, "not-top-five": 6, "not-right-amount-of-players": 7,
  "tale-already-ended": 8, "not-in-range": 9, "no-isk-lost": 10, "not-top-n": 11, "low-contribution": 12 });
const poolKey = identity => `${identity.poolGroupID}:${identity.taleID}`;
let inFlight = null;

function validateIdentity(identity) {
  if (!identity || !/^[A-Za-z0-9:_-]{1,180}$/.test(identity.operationID || "") ||
      !["instanceID", "poolGroupID", "taleID", "solarSystemID", "rewardID"].every(key => positive(identity[key])) ||
      typeof identity.dungeonName !== "string" || !identity.dungeonName.trim() ||
      !["high", "low", "null", "safe"].includes(identity.securityBand)) fail("INCURSION_IDENTITY_INVALID");
}
function assertPoolIdentity(poolGroupID, taleID) {
  if (!positive(poolGroupID) || !positive(taleID)) fail("INCURSION_IDENTITY_INVALID");
  for (const group of ["operations", "receipts", "releases", "closures"]) {
    for (const row of Object.values(store.read(`/${group}`) || {})) {
      const identity = row.identity || row;
      if (identity.poolGroupID === poolGroupID && identity.taleID !== taleID) fail("INCURSION_POOL_ID_REUSED");
    }
  }
}
function addPending(changes, pending, characterID, receiptID, leg) {
  pending[characterID] ||= store.read(`/pending/${characterID}`) || {};
  pending[characterID][leg.id] = { receiptID, legID: leg.id };
  changes.set(`/pending/${characterID}`, pending[characterID]);
}
function historyRow(receipt, participant, fields) {
  return { dateMs: receipt.completedAtMs, taleID: receipt.identity.taleID,
    solarSystemID: receipt.identity.solarSystemID, rewardID: receipt.identity.rewardID,
    rewardMessageKey: receipt.rewardDefinition.lpLogTypeNameID, dungeonName: receipt.identity.dungeonName,
    numberOfPlayers: receipt.eligibleCount, disqualifierType: null, disqualifierData: null,
    lpAmountAddedToPool: 0, lpAmountPayedOut: 0, ...fields, characterID: participant.characterID };
}
function walletOptions(receipt, characterID, issuerID, tax, description) {
  // A block mapping can accept the native integer tax-ref key. Appending a
  // block key after a closed JSON/flow mapping would be invalid YAML.
  const base = `DESC: ${JSON.stringify(description)}`;
  return { entryTypeID: 99, ownerID1: issuerID, ownerID2: characterID,
    referenceID: receipt.identity.solarSystemID, requireExactCredit: true,
    description: tax.tax > 0
      ? buildCorporationTaxDescription(103, tax.corporationID, tax.tax, { into: base }) : base };
}

function sealCompletion({ completedOperation, recipients, completedAtMs = incursionClock.now() } = {}) {
  const operation = clone(completedOperation || {}), identity = operation.identity;
  validateIdentity(identity);
  if (operation.status !== "completed" || !/^[a-f0-9]{64}$/.test(operation.policyFingerprint || "") ||
      !Number.isSafeInteger(completedAtMs) || completedAtMs <= 0) fail("INCURSION_COMPLETION_INVALID");
  const previous = store.getOperation(identity.operationID);
  if (!previous || fingerprint(previous.identity) !== fingerprint(identity) ||
      previous.policyFingerprint !== operation.policyFingerprint ||
      fingerprint(previous.policy) !== fingerprint(operation.policy)) fail("INCURSION_COMPLETION_SCOPE_MISMATCH");
  assertPoolIdentity(identity.poolGroupID, identity.taleID);
  if (!Array.isArray(recipients)) fail("INCURSION_RECIPIENTS_INVALID");
  const characterIDs = recipients.map(value => typeof value === "object" && value !== null ? value.characterID : value);
  if (characterIDs.some(value => !positive(value)) || new Set(characterIDs).size !== characterIDs.length) {
    fail("INCURSION_RECIPIENTS_INVALID");
  }
  characterIDs.sort((a, b) => a - b);
  const knownCharacters = new Set([...(operation.participantIDs || []),
    ...Object.keys(operation.participants || {}).map(Number), ...Object.keys(operation.contributions || {}).map(Number),
    ...Object.values(operation.participants || {}).map(row => row?.characterID)].filter(positive));
  if (characterIDs.some(id => !knownCharacters.has(id))) fail("INCURSION_RECIPIENT_NOT_OBSERVED");
  const requiresCompletionTax = operation.policy?.participation?.version === 1;
  let completionTaxProfiles = null;
  if (requiresCompletionTax || operation.completion?.taxProfiles !== undefined) {
    completionTaxProfiles = require("../inventory/incursionCombatOutcomes").normalizeCompletionTaxProfiles(
      operation.completion?.taxProfiles, operation.completion?.presence);
    if (characterIDs.some(id => !Object.hasOwn(completionTaxProfiles, id))) fail("INCURSION_COMPLETION_TAX_SNAPSHOT_INVALID");
  }
  const disqualified = clone(operation.completion?.disqualified || []), rejected = new Set();
  for (const decision of disqualified) {
    if (!positive(decision?.characterID) || !knownCharacters.has(decision.characterID) ||
        rejected.has(decision.characterID) || characterIDs.includes(decision.characterID)) fail("INCURSION_DISQUALIFICATION_SCOPE_INVALID");
    rejected.add(decision.characterID);
    if (typeof decision.reason !== "string" || !decision.reason.trim()) fail("INCURSION_DISQUALIFICATION_INVALID");
    const nativeID = NATIVE_DISQUALIFIER[decision.reason] ?? null;
    if (decision.reasonID !== undefined && decision.reasonID !== nativeID) fail("INCURSION_DISQUALIFICATION_INVALID");
    if ([2, 11].includes(nativeID) && !positive(decision.data)) fail("INCURSION_DISQUALIFICATION_DATA_INVALID");
    decision.nativeReasonID = nativeID;
  }
  const completion = clone(operation);
  delete completion.receiptID; delete completion.completedAtMs;
  const requestFingerprint = fingerprint({ operation: completion, recipients: characterIDs });
  const id = `incursion:${identity.operationID}:completion`, existing = store.read(`/receipts/${id}`);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint || existing.policyFingerprint !== operation.policyFingerprint ||
        fingerprint(existing.identity) !== fingerprint(identity)) {
      fail("INCURSION_COMPLETION_SCOPE_MISMATCH");
    }
    return existing;
  }
  require("./incursionTerminalContract").assertCompletionOpen(identity, completedAtMs);
  if (previous.receiptID || store.read(`/releases/${poolKey(identity)}`) || store.read(`/closures/${poolKey(identity)}`)) fail("INCURSION_POOL_CLOSED");
  if (["failed", "abandoned", "retired"].includes(previous.status)) fail("INCURSION_OPERATION_TERMINAL");
  const rewardDefinition = operation.policy?.rewardDefinition, catalogIdentity = operation.policy?.catalogIdentity;
  validateRewardGroup(rewardDefinition);
  if (rewardDefinition.groupRewardID !== identity.rewardID || !catalogIdentity?.sha256) fail("INCURSION_REWARD_SNAPSHOT_INVALID");
  const rewards = evaluateGroupReward(rewardDefinition, { playerCount: characterIDs.length, securityBand: identity.securityBand });
  if (rewards.some(reward => ![REWARD_TYPE.ISK, REWARD_TYPE.LP].includes(reward.rewardType) ||
      (reward.rewardType === REWARD_TYPE.ISK && reward.delayed) ||
      (reward.rewardType === REWARD_TYPE.LP && !reward.delayed))) fail("INCURSION_REWARD_TYPE_UNSUPPORTED");
  const receipt = { id, identity: clone(identity), policyFingerprint: operation.policyFingerprint,
    completedAtMs, rewardDefinition: clone(rewardDefinition), catalogIdentity: clone(catalogIdentity),
    eligibleCount: characterIDs.length, participants: [], disqualified };
  const changes = new Map(), pending = {};
  for (const characterID of characterIDs) {
    if (!require("../character/characterState").peekCharacterRecord(characterID)) fail("INCURSION_CHARACTER_NOT_FOUND");
    // Completion-time affiliation/tax is explicit frozen emulator policy for
    // delayed LP; the capture does not establish a retail tax-snapshot instant.
    // Production participation policies carry affiliation/rates with the
    // terminal health checkpoint. Recovery must never re-read later membership.
    // Legacy low-level operations without participation retain first-seal reads.
    const taxProfile = completionTaxProfiles ? clone(completionTaxProfiles[characterID]) : resolveCorporationTaxProfile(characterID);
    const participant = { characterID, taxProfile, legs: [], grossLP: 0, netLP: 0 };
    for (const reward of rewards) {
      const tax = computeCorporationTax(taxProfile, reward.rewardType === REWARD_TYPE.ISK
        ? CORPORATION_TAX_CURRENCY.ISK : CORPORATION_TAX_CURRENCY.LP, reward.quantity);
      const prefix = `${id}:${characterID}:${reward.tableKey}`;
      const member = { id: `${prefix}:member`, characterID, ownerID: characterID,
        issuerCorpID: reward.rewardingNpcCorporationID, kind: reward.rewardType === REWARD_TYPE.ISK ? "characterISK" : "characterLP",
        delayed: reward.delayed, amount: tax.net, grossAmount: tax.gross,
        state: tax.net > 0 ? reward.delayed ? "held" : "pending" : "paid" };
      if (member.kind === "characterISK") member.walletOptions = walletOptions(receipt, characterID, member.issuerCorpID,
        tax, `Incursion ${identity.dungeonName}`);
      participant.legs.push(member);
      if (tax.credit) participant.legs.push({ id: `${prefix}:corporation-tax`, characterID,
        ownerID: tax.corporationID, issuerCorpID: member.issuerCorpID,
        kind: reward.rewardType === REWARD_TYPE.ISK ? "corporationISK" : "corporationLP",
        delayed: reward.delayed, amount: tax.tax, state: reward.delayed ? "held" : "pending",
        walletOptions: reward.rewardType === REWARD_TYPE.ISK ? { entryTypeID: 103, ownerID1: characterID,
          ownerID2: tax.corporationID, referenceID: identity.solarSystemID, requireExactCredit: true,
          description: `Incursion ${identity.dungeonName} corporation tax` } : null });
      if (member.kind === "characterLP") {
        participant.grossLP += tax.gross; participant.netLP += tax.net;
      }
    }
    receipt.participants.push(participant);
    for (const leg of participant.legs) if (leg.state === "pending") addPending(changes, pending, characterID, id, leg);
    if (participant.grossLP > 0) {
      const history = store.read(`/history/${characterID}`) || {};
      history[`${id}:stored`] = historyRow(receipt, participant,
        { eventTypeID: EVENT.STORED, lpAmountAddedToPool: participant.grossLP });
      changes.set(`/history/${characterID}`, history);
    }
  }
  for (const decision of disqualified) if (decision.nativeReasonID !== null) {
    const history = store.read(`/history/${decision.characterID}`) || {};
    history[`${id}:disqualified`] = historyRow(receipt, decision,
      { eventTypeID: EVENT.DISQUALIFIED, disqualifierType: decision.nativeReasonID, disqualifierData: decision.data ?? null });
    changes.set(`/history/${decision.characterID}`, history);
  }
  receipt.requestFingerprint = requestFingerprint;
  changes.set(`/operations/${identity.operationID}`, { ...operation, receiptID: id, completedAtMs });
  changes.set(`/receipts/${id}`, receipt);
  store.transaction([...changes]);
  return clone(receipt);
}

function releasePool({ poolGroupID, taleID, eventID, eventType, proof, releasedAtMs = incursionClock.now() } = {}) {
  if (!positive(poolGroupID) || !positive(taleID) || !["controlled-completion", "incursion-defeated"].includes(eventType) ||
      !/^[A-Za-z0-9:_-]{1,180}$/.test(eventID || "") || !positive(releasedAtMs)) fail("INCURSION_RELEASE_INVALID");
  const organic = eventType === "incursion-defeated" ? require("./incursionTerminalContract").resolveDecision(
    { poolGroupID, taleID, eventID, proof, atMs: releasedAtMs }, "defeated") : null;
  assertPoolIdentity(poolGroupID, taleID);
  if (!organic && Object.values(store.read("/operations") || {}).some(operation => operation.identity.poolGroupID === poolGroupID &&
      operation.identity.taleID === taleID && ["tale-slot", "tale-final"].includes(operation.identity.placement))) fail("INCURSION_ORGANIC_SETTLEMENT_UNAVAILABLE");
  if (!Object.values(store.read("/operations") || {}).some(operation => operation.identity.poolGroupID === poolGroupID &&
      operation.identity.taleID === taleID)) fail("INCURSION_POOL_NOT_FOUND");
  const key = poolKey({ poolGroupID, taleID }), existing = store.read(`/releases/${key}`);
  const closure = store.read(`/closures/${key}`);
  if (closure && (!organic || closure.proof !== proof || closure.outcome !== "defeated")) fail("INCURSION_POOL_CLOSED");
  if (existing) {
    if (existing.eventID !== eventID || existing.eventType !== eventType || (organic && existing.terminalProof !== proof)) fail("INCURSION_POOL_ALREADY_RELEASED");
    return existing;
  }
  const release = { id: `incursion:pool:${key}:release`, poolGroupID, taleID, eventID, eventType,
    releasedAtMs, qualification: organic ? "Lifecycle-owned sealed final encounter; frozen terminal cutoff and recipients."
      : "Controlled Phase7 completion event; organic mothership/withdrawal lifecycle belongs to Phase8.",
    ...(organic ? { terminalProof: proof } : {}), participants: {} };
  const changes = new Map(), pending = {};
  for (const original of organic?.receipts || Object.values(store.read("/receipts") || {})) {
    if (original.identity.poolGroupID !== poolGroupID || original.identity.taleID !== taleID) continue;
    const receipt = clone(original);
    for (const participant of receipt.participants) {
      const held = participant.legs.filter(leg => leg.delayed && leg.state === "held");
      if (!held.length) continue;
      participant.releaseID = release.id;
      const released = release.participants[participant.characterID] ||= { characterID: participant.characterID,
        grossLP: 0, netLP: 0, legs: [], historyPublished: false,
        identity: clone(receipt.identity), rewardMessageKey: receipt.rewardDefinition.lpLogTypeNameID };
      released.grossLP += participant.grossLP; released.netLP += participant.netLP;
      for (const leg of held) {
        leg.releaseID = release.id; leg.state = leg.amount > 0 ? "pending" : "paid";
        released.legs.push({ receiptID: receipt.id, legID: leg.id });
        if (leg.state === "pending") addPending(changes, pending, participant.characterID, receipt.id, leg);
      }
    }
    changes.set(`/receipts/${receipt.id}`, receipt);
  }
  changes.set(`/releases/${key}`, release);
  if (organic) changes.set(`/closures/${key}`, { poolGroupID, taleID, eventID, proof, outcome: "defeated",
    atMs: releasedAtMs, receiptIDs: organic.terminal.receipts.map(row => row.receiptID) });
  store.transaction([...changes]);
  publishReleasedHistory();
  return store.read(`/releases/${key}`);
}

function forfeitPool({ poolGroupID, taleID, eventID, proof, forfeitedAtMs } = {}) {
  const { terminal, receipts } = require("./incursionTerminalContract").resolveDecision(
    { poolGroupID, taleID, eventID, proof, atMs: forfeitedAtMs }, "expired");
  assertPoolIdentity(poolGroupID, taleID);
  const key = poolKey({ poolGroupID, taleID }), previous = store.read(`/closures/${key}`);
  if (previous) {
    if (previous.outcome !== "expired" || previous.eventID !== eventID || previous.proof !== proof) fail("INCURSION_POOL_CLOSED");
    return previous;
  }
  if (store.read(`/releases/${key}`)) fail("INCURSION_POOL_ALREADY_RELEASED");
  const closure = { id: `incursion:pool:${key}:forfeiture`, poolGroupID, taleID, eventID, proof,
    outcome: "expired", atMs: forfeitedAtMs, receiptIDs: terminal.receipts.map(row => row.receiptID), participants: {} };
  const changes = new Map();
  for (const original of receipts) {
    const receipt = clone(original);
    for (const participant of receipt.participants) {
      if (participant.releaseID || participant.forfeitureID) fail("INCURSION_POOL_ALREADY_RELEASED");
      const delayed = participant.legs.filter(leg => leg.delayed);
      if (delayed.some(leg => leg.state !== "held" && !(leg.state === "paid" && leg.amount === 0))) {
        fail("INCURSION_FORFEITURE_STATE_INVALID");
      }
      participant.forfeitureID = closure.id;
      for (const leg of delayed) if (leg.state === "held") { leg.state = "forfeited"; leg.forfeitureID = closure.id; }
      if (!(participant.grossLP > 0)) continue;
      const audit = closure.participants[participant.characterID] ||= { characterID: participant.characterID,
        grossLP: 0, netLP: 0, historyPublished: true, identity: clone(receipt.identity),
        rewardMessageKey: receipt.rewardDefinition.lpLogTypeNameID };
      audit.grossLP += participant.grossLP; audit.netLP += participant.netLP;
    }
    changes.set(`/receipts/${receipt.id}`, receipt);
  }
  for (const participant of Object.values(closure.participants)) {
    const history = store.read(`/history/${participant.characterID}`) || {};
    // The native panel has no lost-amount field. Event 314 supplies the loss
    // label; numeric forfeiture is retained in the durable server audit.
    history[closure.id] = { dateMs: forfeitedAtMs, taleID, solarSystemID: participant.identity.solarSystemID,
      rewardID: participant.identity.rewardID, rewardMessageKey: participant.rewardMessageKey, dungeonName: "",
      eventTypeID: EVENT.LOST, lpAmountAddedToPool: 0, lpAmountPayedOut: 0,
      numberOfPlayers: 0, disqualifierType: null, disqualifierData: null, characterID: participant.characterID };
    changes.set(`/history/${participant.characterID}`, history);
  }
  changes.set(`/closures/${key}`, closure);
  store.transaction([...changes]);
  return store.read(`/closures/${key}`);
}

function terminalPoolSettled(tale) {
  const terminal = require("./incursionTerminalContract").assertDecision(tale), key = poolKey(tale);
  const closure = store.read(`/closures/${key}`);
  if (!closure || closure.proof !== terminal.proof || closure.outcome !== terminal.outcome) return false;
  if (allPending().some(entry => {
    const receipt = store.read(`/receipts/${entry.receiptID}`);
    return receipt?.identity.taleID === tale.taleID && receipt.identity.poolGroupID === tale.poolGroupID;
  })) return false;
  if (terminal.outcome === "expired") return Object.values(closure.participants).every(row => row.historyPublished);
  const release = store.read(`/releases/${key}`);
  return Boolean(release && release.terminalProof === terminal.proof && Object.values(release.participants).every(row => row.historyPublished));
}

function allPending() {
  return Object.entries(store.read("/pending") || {}).flatMap(([characterID, entries]) =>
    Object.entries(entries).map(([key, value]) => ({ characterID: Number(characterID), key, ...value })));
}
function findLeg(receipt, legID) {
  for (const participant of receipt?.participants || []) {
    const leg = participant.legs.find(candidate => candidate.id === legID);
    if (leg) return { participant, leg };
  }
  fail("INCURSION_REWARD_LEG_MISSING");
}
async function deliver(leg) {
  if (leg.kind.startsWith("corporation") && !require("../corporation/corporationState").getCorporationRecord(leg.ownerID)) {
    return { success: true, unpayableTax: true };
  }
  let result;
  if (leg.kind === "characterISK") result = await require("../account/walletState").adjustCharacterBalanceAsync(
    leg.ownerID, leg.amount, { ...leg.walletOptions, idempotencyKey: leg.id },
    { commandID: leg.id, source: "incursion-settlement" });
  else if (leg.kind === "corporationISK") result = await require("../corporation/corpWalletState").adjustCorporationWalletDivisionBalanceAsync(
    leg.ownerID, 1000, leg.amount, { ...leg.walletOptions, idempotencyKey: leg.id },
    { commandID: leg.id, source: "incursion-settlement" });
  else if (leg.kind === "characterLP") result = require("../corporation/lpWalletState").adjustCharacterWalletLPBalanceDurable(
    leg.ownerID, leg.issuerCorpID, leg.amount, { idempotencyKey: leg.id, changeType: "incursion_reward", grossEarned: leg.grossAmount });
  else if (leg.kind === "corporationLP") {
    result = require("../corporation/lpWalletState").adjustCorporationWalletLPBalance(leg.ownerID, leg.issuerCorpID,
      leg.amount, { idempotencyKey: leg.id, reason: "incursion_reward_corporation_tax" });
    if (result?.success) {
      const flush = database.flushTableSync("lpWallets");
      if (!flush?.success) fail(flush?.errorMsg || "INCURSION_LP_FLUSH_FAILED");
    }
  } else fail("INCURSION_REWARD_KIND_INVALID");
  if (!result?.success && leg.kind.startsWith("corporation") && isUnpayableCorporationTaxError(result?.errorMsg)) {
    return { success: true, unpayableTax: true };
  }
  if (!result?.success) fail(result?.errorMsg || "INCURSION_DELIVERY_FAILED");
  const actual = leg.kind === "characterISK" ? result.delta : result.data?.delta;
  if (actual !== leg.amount || result.fingerprintMismatch === true) fail("INCURSION_DELIVERY_AMOUNT_MISMATCH");
  return result;
}
function acknowledge(entry, result) {
  const receipt = store.read(`/receipts/${entry.receiptID}`), { leg } = findLeg(receipt, entry.legID);
  if (leg.state !== "pending") fail("INCURSION_REWARD_STATE_INVALID");
  leg.state = result.unpayableTax ? "tax-sink" : "paid";
  leg.result = { duplicate: result.duplicate === true, unpayableTax: result.unpayableTax === true };
  const pending = store.read(`/pending/${entry.characterID}`) || {};
  delete pending[entry.key];
  store.transaction([[`/receipts/${receipt.id}`, receipt],
    [`/pending/${entry.characterID}`, Object.keys(pending).length ? pending : undefined]]);
}
function publishReleasedHistory() {
  for (const [key, release] of Object.entries(store.read("/releases") || {})) {
    const changes = new Map();
    for (const participant of Object.values(release.participants)) {
      if (participant.historyPublished || participant.legs.some(entry => {
        const { leg } = findLeg(store.read(`/receipts/${entry.receiptID}`), entry.legID);
        return !["paid", "tax-sink"].includes(leg.state);
      })) continue;
      const history = store.read(`/history/${participant.characterID}`) || {};
      history[release.id] = { dateMs: release.releasedAtMs, taleID: release.taleID,
        solarSystemID: participant.identity.solarSystemID, rewardID: participant.identity.rewardID,
        rewardMessageKey: participant.rewardMessageKey, dungeonName: "",
        eventTypeID: EVENT.PAID, lpAmountAddedToPool: 0, lpAmountPayedOut: participant.netLP,
        numberOfPlayers: 0, disqualifierType: null, disqualifierData: null, characterID: participant.characterID };
      participant.historyPublished = true;
      changes.set(`/history/${participant.characterID}`, history);
    }
    if (changes.size) {
      changes.set(`/releases/${key}`, release);
      store.transaction([...changes]);
    }
  }
}
function reconcilePending() {
  if (inFlight) return inFlight;
  inFlight = Promise.resolve().then(async () => {
    const attempted = new Set(), failures = [];
    for (;;) {
      const entry = allPending().find(candidate => !attempted.has(candidate.key));
      if (!entry) break;
      attempted.add(entry.key);
      try {
        const receipt = store.read(`/receipts/${entry.receiptID}`), { leg } = findLeg(receipt, entry.legID);
        if (leg.characterID !== entry.characterID || leg.state !== "pending") fail("INCURSION_REWARD_OUTBOX_INVALID");
        const result = await deliver(clone(leg));
        acknowledge(entry, result);
      } catch (error) { failures.push(error); log.warn(`[Incursion] Reward ${entry.key} pending: ${error.message}`); }
    }
    publishReleasedHistory();
    if (failures.length) throw failures[0];
    return { success: true, delivered: attempted.size };
  }).finally(() => { inFlight = null; });
  return inFlight;
}
function getDelayedRewards(characterID, groupIDs = []) {
  if (!positive(characterID)) return {};
  const requested = new Set(groupIDs.filter(positive)), totals = {};
  for (const receipt of Object.values(store.read("/receipts") || {})) {
    if (!requested.has(receipt.identity.poolGroupID)) continue;
    const participant = receipt.participants.find(row => row.characterID === characterID);
    const memberLP = participant?.legs.filter(leg => leg.kind === "characterLP" && leg.delayed) || [];
    const amount = !participant?.forfeitureID && (!participant?.releaseID || memberLP.some(leg => ["held", "pending"].includes(leg.state)))
      ? memberLP.reduce((sum, leg) => sum + leg.grossAmount, 0) : 0;
    if (amount > 0) totals[receipt.identity.poolGroupID] = (totals[receipt.identity.poolGroupID] || 0) + amount;
  }
  return Object.fromEntries(Object.entries(totals).map(([key, amount]) =>
    [key, [{ rewardTypeID: REWARD_TYPE.LP, rewardQuantity: amount }]]));
}
function getRewardLPLogs(characterID) {
  if (!positive(characterID)) return [];
  return Object.values(store.read(`/history/${characterID}`) || {})
    .map(clone).sort((a, b) => b.dateMs - a.dateMs || a.eventTypeID - b.eventTypeID);
}

module.exports = { EVENT, NATIVE_DISQUALIFIER, assertPoolIdentity, sealCompletion, releasePool, forfeitPool, terminalPoolSettled, reconcilePending, recoverPending: reconcilePending,
  getDelayedRewards, getRewardLPLogs, listPendingCharacterIDs: store.listPendingCharacterIDs,
  getOperation: store.getOperation, saveOperation: store.saveOperation,
  hasPendingDelivery: () => allPending().length > 0,
  _testing: { fingerprint, findLeg, publishReleasedHistory } };
