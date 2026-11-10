"use strict";

const path = require("path");

const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getCharacterSkills,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  normalizeCorporationWalletKey,
  transferCorporationWalletBalanceAsync,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  getAllianceRecord,
  getCorporationRecord,
} = require(path.join(__dirname, "./corporationState"));

const DIPLOMATIC_RELATIONS_TYPE_ID = 3368;
const ATTRIBUTE_BASE_DEFENDER_ALLY_COST = 1820;
const ATTRIBUTE_SKILL_ALLY_COST_MODIFIER_BONUS = 1821;
const DEFAULT_ALLY_BASE_COST = 10000000;
const DEFAULT_RECEIVING_ACCOUNT_KEY = 1000;

function normalizeOwnerID(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeMoney(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.round(numeric * 100) / 100;
}

function getDiplomaticRelationsDogmaAttributes() {
  const typeDogma = readStaticTable(TABLE.TYPE_DOGMA);
  const byTypeID =
    typeDogma && typeof typeDogma === "object" && typeDogma.typesByTypeID
      ? typeDogma.typesByTypeID
      : {};
  const record = byTypeID[String(DIPLOMATIC_RELATIONS_TYPE_ID)];
  return record && typeof record.attributes === "object" ? record.attributes : {};
}

function getCharacterSkillLevel(characterID, skillTypeID) {
  const numericCharacterID = normalizeOwnerID(characterID);
  const numericSkillTypeID = Number(skillTypeID) || 0;
  if (!numericCharacterID || !numericSkillTypeID) {
    return 0;
  }

  const skillRecord = getCharacterSkills(numericCharacterID).find(
    (record) => Number(record && record.typeID) === numericSkillTypeID,
  );
  if (!skillRecord) {
    return 0;
  }

  return Math.max(
    0,
    Number(
      skillRecord.effectiveSkillLevel ??
        skillRecord.trainedSkillLevel ??
        skillRecord.skillLevel ??
        0,
    ) || 0,
  );
}

function getCharacterAllyBaseCost(characterID) {
  const attributes = getDiplomaticRelationsDogmaAttributes();
  const baseCost = normalizeMoney(
    attributes[String(ATTRIBUTE_BASE_DEFENDER_ALLY_COST)],
    DEFAULT_ALLY_BASE_COST,
  );
  const modifierPercentPerLevel = normalizeMoney(
    attributes[String(ATTRIBUTE_SKILL_ALLY_COST_MODIFIER_BONUS)],
    0,
  );
  const skillLevel = getCharacterSkillLevel(
    characterID,
    DIPLOMATIC_RELATIONS_TYPE_ID,
  );
  const modifierMultiplier = Math.max(
    0,
    1 + (modifierPercentPerLevel * skillLevel) / 100,
  );
  return Math.max(0, Math.round(baseCost * modifierMultiplier));
}

function resolveWarEntityWalletOwner(ownerID) {
  const numericOwnerID = normalizeOwnerID(ownerID);
  if (!numericOwnerID) {
    return null;
  }

  const corporation = getCorporationRecord(numericOwnerID);
  if (corporation) {
    return {
      kind: "corporation",
      ownerID: numericOwnerID,
      walletCorporationID: numericOwnerID,
    };
  }

  const alliance = getAllianceRecord(numericOwnerID);
  if (!alliance) {
    return null;
  }

  const executorCorporationID = normalizeOwnerID(alliance.executorCorporationID);
  if (!executorCorporationID || !getCorporationRecord(executorCorporationID)) {
    return null;
  }

  return {
    kind: "alliance",
    ownerID: numericOwnerID,
    walletCorporationID: executorCorporationID,
  };
}

async function settleWarEntityTransferAsync({
  fromOwnerID,
  toOwnerID,
  fromWalletCorporationID = 0,
  toWalletCorporationID = 0,
  amount,
  fromAccountKey = DEFAULT_RECEIVING_ACCOUNT_KEY,
  description = "War wallet transfer",
  commandID,
  additionalDebitAmount = 0,
  additionalDebitOptions = {},
} = {}) {
  const normalizedAmount = Math.abs(normalizeMoney(amount, 0));
  const normalizedAdditionalDebitAmount = Math.abs(
    normalizeMoney(additionalDebitAmount, 0),
  );
  if (!(normalizedAmount > 0) && !(normalizedAdditionalDebitAmount > 0)) {
    return { success: true, data: { amount: 0 } };
  }
  const normalizedFromOwnerID = normalizeOwnerID(fromOwnerID);
  const normalizedToOwnerID = normalizeOwnerID(toOwnerID);
  const frozenSourceCorporationID = normalizeOwnerID(fromWalletCorporationID);
  const frozenTargetCorporationID = normalizeOwnerID(toWalletCorporationID);
  const resolvedSourceWallet = resolveWarEntityWalletOwner(fromOwnerID);
  const resolvedTargetWallet = resolveWarEntityWalletOwner(toOwnerID);
  const sourceWallet = frozenSourceCorporationID && normalizedFromOwnerID
    ? {
        ownerID: normalizedFromOwnerID,
        walletCorporationID: frozenSourceCorporationID,
      }
    : resolvedSourceWallet;
  const targetWallet = frozenTargetCorporationID && normalizedToOwnerID
    ? {
        ownerID: normalizedToOwnerID,
        walletCorporationID: frozenTargetCorporationID,
      }
    : resolvedTargetWallet;
  if (!sourceWallet || !targetWallet) {
    return { success: false, errorMsg: "WAR_ENTITY_NOT_FOUND" };
  }
  const result = await transferCorporationWalletBalanceAsync(
    sourceWallet.walletCorporationID,
    normalizeCorporationWalletKey(fromAccountKey),
    targetWallet.walletCorporationID,
    DEFAULT_RECEIVING_ACCOUNT_KEY,
    normalizedAmount,
    {
      entryTypeID: 10,
      fromOwnerID: sourceWallet.ownerID,
      toOwnerID: targetWallet.ownerID,
      description,
      additionalDebitAmount: normalizedAdditionalDebitAmount,
      additionalDebitOptions,
    },
    {
      commandID,
      idempotencyKey: commandID,
      source: "war-negotiation-transfer",
    },
  );
  if (!result || result.success !== true) {
    return result || { success: false, errorMsg: "WALLET_TRANSFER_FAILED" };
  }
  return {
    success: true,
    data: {
      amount: normalizedAmount,
      additionalDebitAmount: normalizedAdditionalDebitAmount,
      fromOwnerID: sourceWallet.ownerID,
      toOwnerID: targetWallet.ownerID,
      fromWalletCorporationID: sourceWallet.walletCorporationID,
      toWalletCorporationID: targetWallet.walletCorporationID,
      wallet: result,
    },
  };
}

module.exports = {
  DEFAULT_ALLY_BASE_COST,
  getCharacterAllyBaseCost,
  resolveWarEntityWalletOwner,
  settleWarEntityTransferAsync,
};
