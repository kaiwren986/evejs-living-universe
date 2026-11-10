"use strict";
const { randomUUID } = require("node:crypto");

// Auction decisions live here; persistence, wallet authority and item custody remain
// with their existing owners, injected by the contract runtime.
function createContractAuctionRuntime(p) {
  const state = p.settlementState;
  const status = p.CONTRACT_STATUS;
  const fail = (errorMsg) => ({ success: false, errorMsg });
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const cents = (value) => {
    const n = Number(value);
    const amount = Math.round(n * 100);
    return Number.isFinite(n) && n >= 0 && Number.isSafeInteger(amount) &&
      Math.abs(n * 100 - amount) < 0.00001 ? amount : null;
  };
  const highest = (record) => (record.bids || [])[0] || null;
  const now = () => BigInt(p.currentFileTime());
  const ended = (record) => Boolean(record.auctionEnded) ||
    BigInt(record.dateExpired || 0) <= now();
  const version = (record) => Number(record.auctionVersion || 0);
  const walletForBid = (bid) => bid.wallet || ({
    kind: bid.forCorp ? "corporation" : "character",
    ownerID: bid.bidderID,
    accountKey: bid.accountKey || 1000,
  });

  async function settle(contractID, options = {}) {
    let operation = state.getPendingContractSettlement(contractID);
    if (!operation) return { success: true, contract: p.getContractRecord(contractID) };
    if (operation.kind !== "auction-bid") return fail("UNSUPPORTED_AUCTION_SETTLEMENT");
    let record = p.getContractRecord(contractID);
    const payload = operation.payload;
    // An acknowledged record can survive a crash before clearing the intent.
    const committed = record && record.lastAuctionOperationID === payload.operationID;
    if (!committed && (!record || version(record) !== payload.expectedVersion)) {
      return fail("AUCTION_VERSION_CONFLICT");
    }
    if (!committed) {
      const result = await p.applyContractWalletLegs(contractID);
      if (!result.success) {
        // The first debit is the only leg which can be rejected without any
        // obligation. Unknown/interrupted outcomes always retain the intent.
        if (["INSUFFICIENT_FUNDS", "CHARACTER_NOT_FOUND", "CORPORATION_NOT_FOUND"].includes(result.errorMsg) &&
            !(state.getPendingContractSettlement(contractID).payload.walletLegs || []).some((leg) => leg.applied)) {
          const removed = state.updateContractSettlement(contractID, () => null);
          if (!removed.success) return removed;
        }
        return result;
      }
      operation = state.getPendingContractSettlement(contractID);
      record = p.getContractRecord(contractID);
      if (version(record) !== payload.expectedVersion) return fail("AUCTION_VERSION_CONFLICT");
      const next = {
        ...record,
        auctionVersion: payload.expectedVersion + 1,
        lastAuctionOperationID: payload.operationID,
        bids: [payload.bid, ...(record.bids || []).filter((bid) =>
          !(bid.bidderID === payload.bid.bidderID && Boolean(bid.forCorp) === Boolean(payload.bid.forCorp)))],
        nextBidID: payload.bid.bidID + 1,
        auctionEnded: payload.buyout || false,
        dateExpired: payload.buyout ? payload.bid.dateBid : record.dateExpired,
      };
      const written = p.putContractRecordDurably(next);
      if (!written.success) return written;
      record = next;
    }
    const removed = state.updateContractSettlement(contractID, () => null);
    if (!removed.success) return removed;
    if (!committed && options.notify !== false && p.notifyAuctionBid) {
      p.notifyAuctionBid(record, payload.previousBid, payload.buyout, options.preferredSession);
    }
    return { success: true, contract: copy(record) };
  }

  function leg(record, operationID, name, ref, delta, counterpartyID) {
    return { legID: name, ref: copy(ref), delta, counterpartyID,
      description: `Auction contract ${record.contractID} ${name}`,
      commandID: `${operationID}:${name}`, applied: false };
  }

  async function placeBid(contractID, amount, session, forCorp = false, options = {}) {
    return state.runSerialized(contractID, async () => {
      const actor = p.getSessionCharacterID(session);
      if (!actor) return fail("CONTRACT_CHARACTER_REQUIRED");
      if (state.getPendingContractSettlement(contractID)) {
        const recovered = await p.settleContractOperation(contractID, options);
        if (!recovered.success) return recovered;
      }
      const record = p.getContractRecord(contractID);
      if (!record || record.type !== p.CONTRACT_TYPE.AUCTION) return fail("CONTRACT_NOT_FOUND");
      if (forCorp && !p.sessionHasCorpContractManagerRole(session)) return fail("CONTRACT_CORPORATION_ROLE_REQUIRED");
      const ref = p.buildWalletRef(session, forCorp);
      p.assertAuctionWalletAccess(session, ref);
      // Block the original character even when spending a corporation wallet,
      // and block the issuing corporation regardless of which director bids.
      if (actor === record.issuerID || (record.forCorp && ref.ownerID === record.issuerCorpID)) return fail("CONTRACT_SELF_BID");
      const previousBid = highest(record);
      const amountCents = cents(amount);
      if (amountCents === null || amountCents <= 0 || amountCents > 1000000000000000) return fail("INVALID_AUCTION_BID");
      const same = previousBid && previousBid.bidderID === ref.ownerID && Boolean(previousBid.forCorp) === Boolean(forCorp) &&
        Number(walletForBid(previousBid).accountKey) === Number(ref.accountKey);
      if (same && cents(previousBid.amount) === amountCents) {
        return { success: true, duplicate: true, contract: copy(record) };
      }
      if (record.status !== status.OUTSTANDING || ended(record)) return fail("CONTRACT_EXPIRED");
      if (!p.canAcceptContract(record, session)) return fail("CONTRACT_ACCESS_DENIED");
      const start = cents(record.price);
      const buyout = cents(record.collateral || 0);
      if (start === null || buyout === null) return fail("INVALID_AUCTION_PRICE");
      // Native client uses floor(10% of starting ISK price), at least 1000 ISK.
      let minimum = previousBid ? cents(previousBid.amount) + Math.max(100000, Math.floor(Number(record.price) * 0.1) * 100) : start;
      if (buyout) minimum = Math.min(minimum, buyout);
      if (amountCents < minimum) return { ...fail("AUCTION_BID_TOO_LOW"), minimum: minimum / 100 };
      if (buyout && amountCents > buyout) return fail("AUCTION_BID_ABOVE_BUYOUT");
      const debit = amountCents - (same ? cents(previousBid.amount) : 0);
      if (Number(p.getWalletBalance(ref)) * 100 < debit) return fail("INSUFFICIENT_FUNDS");
      const expectedVersion = version(record);
      // A refused first debit leaves the auction version unchanged. Give every
      // new attempt its own durable identity so the wallet process cannot replay
      // the previous attempt's cached refusal after the player adds funds.
      const operationID = `contract:${contractID}:auction-bid:${expectedVersion + 1}:${randomUUID()}`;
      const walletLegs = [leg(record, operationID, "bid-escrow", ref, -debit / 100, record.issuerOwnerID || record.issuerID)];
      if (previousBid && !same) walletLegs.push(leg(record, operationID, "outbid-refund", walletForBid(previousBid), previousBid.amount, ref.ownerID));
      const bid = {
        contractID, bidID: Number(record.nextBidID || expectedVersion + 1), bidderID: ref.ownerID,
        bidderCharacterID: actor, accountKey: ref.accountKey, forCorp: Boolean(forCorp),
        wallet: copy(ref), amount: amountCents / 100, dateBid: now().toString(),
      };
      const prepared = state.prepareContractSettlement({ contractID, kind: "auction-bid",
        requestFingerprint: operationID, payload: { operationID, actorCharacterID: actor,
          expectedVersion, bid, previousBid, buyout: Boolean(buyout && amountCents === buyout), walletLegs } });
      if (!prepared.success) return prepared;
      return settle(contractID, { ...options, preferredSession: session });
    });
  }

  function getMyBids(session, forCorp = false) {
    const ownerID = forCorp ? p.getSessionCorporationID(session) : p.getSessionCharacterID(session);
    return p.listContractRecords().filter((record) => record.type === p.CONTRACT_TYPE.AUCTION &&
      (record.bids || []).some((bid) => bid.bidderID === ownerID && Boolean(bid.forCorp) === Boolean(forCorp)));
  }
  return { placeBid, settle, getMyBids };
}

module.exports = { createContractAuctionRuntime };
