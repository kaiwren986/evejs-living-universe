"use strict";

// Independent auction claims share the existing durable contract operation journal.
function createContractAuctionClaims(p) {
  const state = p.settlementState;
  const status = p.CONTRACT_STATUS;
  const fail = (errorMsg) => ({ success: false, errorMsg });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const highest = (record) => (record.bids || [])[0] || null;
  const ended = (record) => Boolean(record.auctionEnded) ||
    BigInt(record.dateExpired || 0) <= BigInt(p.currentFileTime());
  const issuerAuthorized = (record, session) => record.forCorp
    ? p.getSessionCorporationID(session) === record.issuerCorpID && p.sessionHasCorpContractManagerRole(session)
    : p.getSessionCharacterID(session) === record.issuerID;
  const winnerAuthorized = (bid, session) => bid.forCorp
    ? p.getSessionCorporationID(session) === bid.bidderID && p.sessionHasCorpContractManagerRole(session)
    : p.getSessionCharacterID(session) === bid.bidderID;

  async function settle(contractID, options = {}) {
    const operation = state.getPendingContractSettlement(contractID);
    if (!operation) return { success: true, contract: p.getContractRecord(contractID) };
    if (!operation.kind.startsWith("auction-claim-")) return fail("UNSUPPORTED_AUCTION_SETTLEMENT");
    const payload = operation.payload;
    let record = p.getContractRecord(contractID);
    const committed = record && record.lastAuctionOperationID === payload.operationID;
    if (!committed) {
      if (!record || Number(record.auctionVersion || 0) !== payload.expectedVersion) return fail("AUCTION_VERSION_CONFLICT");
      const wallet = await p.applyContractWalletLegs(contractID);
      if (!wallet.success) return wallet;
      const custody = await p.transferContractTerminalItems(contractID);
      if (!custody.success) return custody;
      record = p.getContractRecord(contractID);
      if (Number(record.auctionVersion || 0) !== payload.expectedVersion) return fail("AUCTION_VERSION_CONFLICT");
      const seller = Boolean(record.auctionIssuerClaimed || payload.side === "issuer" || payload.side === "return");
      const winner = Boolean(record.auctionWinnerClaimed || payload.side === "winner" || payload.side === "return");
      const bid = highest(record);
      const next = { ...record,
        ...(bid ? { acceptorID: bid.bidderID, acceptedByCharacterID: bid.bidderCharacterID,
          acceptorWallet: clone(bid.wallet || { kind: bid.forCorp ? "corporation" : "character", ownerID: bid.bidderID, accountKey: bid.accountKey || 1000 }),
          acceptorWalletKey: bid.accountKey || 1000, dateAccepted: bid.dateBid } : {}),
        auctionIssuerClaimed: seller, auctionWinnerClaimed: winner,
        auctionEnded: true, auctionVersion: payload.expectedVersion + 1,
        lastAuctionOperationID: payload.operationID,
        auctionSalesTax: payload.side === "issuer" ? payload.salesTax : (record.auctionSalesTax || 0),
        auctionDepositReturned: Boolean(record.auctionDepositReturned || payload.side === "issuer"),
        status: seller && winner ? status.FINISHED : seller ? status.FINISHED_ISSUER : status.FINISHED_CONTRACTOR,
        dateCompleted: seller && winner ? String(p.currentFileTime()) : record.dateCompleted,
      };
      const written = p.putContractRecordDurably(next);
      if (!written.success) return written;
      record = next;
    }
    const finalPayload = state.getPendingContractSettlement(contractID).payload;
    const removed = state.updateContractSettlement(contractID, () => null);
    if (!removed.success) return removed;
    if (!committed && options.syncInventory !== false) {
      p.syncInventoryChangesToSession(options.preferredSession || null, p.collectTerminalInventoryChanges(finalPayload));
    }
    if (!committed && record.status === status.FINISHED && options.notify !== false && p.notifyAuctionCompleted) p.notifyAuctionCompleted(record, options.preferredSession);
    return { success: true, contract: clone(record) };
  }

  async function finishAuction(contractID, isIssuerClaim, session, options = {}) {
    return state.runSerialized(contractID, async () => {
      if (!p.getSessionCharacterID(session)) return fail("CONTRACT_CHARACTER_REQUIRED");
      if (state.getPendingContractSettlement(contractID)) {
        const recovered = await p.settleContractOperation(contractID, options);
        if (!recovered.success) return recovered;
      }
      const record = p.getContractRecord(contractID);
      if (!record || record.type !== p.CONTRACT_TYPE.AUCTION) return fail("CONTRACT_NOT_FOUND");
      const bid = highest(record);
      const side = !bid ? "return" : isIssuerClaim ? "issuer" : "winner";
      if (side !== "winner" ? !issuerAuthorized(record, session) : !winnerAuthorized(bid, session)) return fail("CONTRACT_ACCESS_DENIED");
      if (record.status === status.FINISHED || (side === "issuer" && record.auctionIssuerClaimed) || (side === "winner" && record.auctionWinnerClaimed)) {
        return { success: true, duplicate: true, contract: clone(record) };
      }
      if (![status.OUTSTANDING, status.FINISHED_ISSUER, status.FINISHED_CONTRACTOR].includes(record.status)) return fail("INVALID_AUCTION_STATUS");
      if (!ended(record)) return fail("CONTRACT_NOT_EXPIRED");
      const actorCharacterID = p.getSessionCharacterID(session);
      const operationID = `contract:${contractID}:auction-claim-${side}`;
      const walletLegs = [];
      let itemLegs = [];
      let salesTax = 0;
      if (side === "issuer") {
        // Winner's claim may have moved the goods already. Before either claim,
        // refuse payout if custody has lost the original escrow.
        if (!record.auctionWinnerClaimed) p.validateAuctionEscrow(record);
        const level = Math.min(5, Math.max(0, Number(record.auctionAccountingLevel || 0)));
        salesTax = record.availability === 0
          ? Math.max(10000, Math.min(Math.trunc(Number(bid.amount) * (0.01 - 0.001 * level)), 1000000000 * (1 - 0.1 * level))) : 0;
        const proceeds = Math.round((Number(bid.amount) - salesTax + Number(record.auctionDeposit || 0)) * 100) / 100;
        // Local fee policy must never turn a funded auction into an unexpected
        // issuer debit; fee is capped to the sale plus held deposit.
        salesTax = Math.min(salesTax, Number(bid.amount) + Number(record.auctionDeposit || 0));
        walletLegs.push({ legID: "proceeds", ref: clone(record.issuerWallet),
          delta: Math.max(0, proceeds), counterpartyID: bid.bidderID,
          description: `Auction contract ${contractID} seller proceeds`, commandID: `${operationID}:proceeds`, applied: false });
      } else {
        const ownerID = side === "return" ? record.issuerOwnerID || record.issuerID : bid.bidderID;
        const forCorp = side === "return" ? record.forCorp : bid.forCorp;
        const flag = side === "return" ? p.getOwnerDeliveryFlag(forCorp, record.startStationDivision) : p.getAcceptorDeliveryFlag(forCorp);
        itemLegs = p.buildAuctionItemLegs(record, `auction-${side}`, ownerID, flag,
          side === "return" ? p.CUSTODY_REASON.CONTRACT_ESCROW_RETURN : p.CUSTODY_REASON.CONTRACT_ESCROW_DELIVER);
      }
      const prepared = state.prepareContractSettlement({ contractID, kind: `auction-claim-${side}`,
        requestFingerprint: operationID, payload: { operationID, expectedVersion: Number(record.auctionVersion || 0),
          actorCharacterID, side, walletLegs, itemLegs, salesTax } });
      if (!prepared.success) return prepared;
      return settle(contractID, { ...options, preferredSession: session });
    });
  }

  async function reconcileExpiry(contractID) {
    return state.runSerialized(contractID, async () => {
      if (state.getPendingContractSettlement(contractID)) {
        const result = await p.settleContractOperation(contractID, {});
        if (!result.success) return result;
      }
      const record = p.getContractRecord(contractID);
      if (!record || record.type !== p.CONTRACT_TYPE.AUCTION || record.auctionEnded) return { success: true };
      if (!ended(record)) return { success: false, errorMsg: "CONTRACT_NOT_EXPIRED" };
      return p.putContractRecordDurably({ ...record, auctionEnded: true });
    });
  }
  return { settle, finishAuction, reconcileExpiry };
}
module.exports = { createContractAuctionClaims };
