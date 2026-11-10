"use strict";

const path = require("path");

const {
  createTableRepository,
} = require("../../gameStore/tableRepository");
const {
  cloneValue,
} = require("../domain/abyssalValueUtils");

const TABLE_NAME = "abyssalFilamentCompensations";
const repo = createTableRepository("service:activity", { strict: true });

function normalizeDeploymentToken(value) {
  const token = String(value || "").trim();
  return token && token.length <= 512 && !token.includes("/")
    ? token
    : "";
}

function buildClaimPath(deploymentToken) {
  const token = normalizeDeploymentToken(deploymentToken);
  return token ? `/${encodeURIComponent(token)}` : "";
}

function ensureStore() {
  try {
    return repo.ensureTable(TABLE_NAME) === true;
  } catch (_error) {
    // ignored: false tells the caller the table could not be ensured
    return false;
  }
}

function readClaim(deploymentToken) {
  const token = normalizeDeploymentToken(deploymentToken);
  const claimPath = buildClaimPath(token);
  if (!token || !claimPath || !ensureStore()) {
    return {
      success: false,
      errorMsg: token ? "COMPENSATION_STORE_UNAVAILABLE" : "INVALID_DEPLOYMENT_TOKEN",
      data: null,
    };
  }
  const result = repo.read(TABLE_NAME, claimPath);
  if (!result || result.success !== true) {
    if (result && result.errorMsg === "ENTRY_NOT_FOUND") {
      return { success: true, found: false, data: null };
    }
    return {
      success: false,
      errorMsg: result && result.errorMsg || "COMPENSATION_CLAIM_READ_FAILED",
      data: null,
    };
  }
  const claim = result.data && typeof result.data === "object"
    ? cloneValue(result.data)
    : null;
  return {
    success: true,
    found: Boolean(claim),
    data: claim,
  };
}

function persistClaim(claim) {
  const deploymentToken = normalizeDeploymentToken(
    claim && claim.deploymentToken,
  );
  const claimPath = buildClaimPath(deploymentToken);
  if (!deploymentToken || !claimPath || !ensureStore()) {
    return {
      success: false,
      durable: false,
      errorMsg: deploymentToken
        ? "COMPENSATION_STORE_UNAVAILABLE"
        : "INVALID_DEPLOYMENT_TOKEN",
      data: null,
    };
  }
  const normalizedClaim = {
    ...cloneValue(claim),
    deploymentToken,
  };
  const writeResult = repo.write(TABLE_NAME, claimPath, normalizedClaim);
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      durable: false,
      errorMsg: writeResult && writeResult.errorMsg ||
        "COMPENSATION_CLAIM_WRITE_FAILED",
      data: normalizedClaim,
    };
  }
  const flushResult = repo.flushTableSync(TABLE_NAME);
  if (!flushResult || flushResult.success !== true) {
    return {
      success: false,
      durable: false,
      ambiguous: true,
      errorMsg: flushResult && flushResult.errorMsg ||
        "COMPENSATION_CLAIM_FLUSH_FAILED",
      data: normalizedClaim,
    };
  }
  return {
    success: true,
    durable: true,
    data: cloneValue(normalizedClaim),
  };
}

function listClaimsForCharacter(characterID, options = {}) {
  const numericCharacterID = Number(characterID) || 0;
  if (numericCharacterID <= 0 || !ensureStore()) {
    return {
      success: false,
      errorMsg: numericCharacterID > 0
        ? "COMPENSATION_STORE_UNAVAILABLE"
        : "INVALID_CHARACTER_ID",
      data: [],
    };
  }
  const result = repo.read(TABLE_NAME, "/");
  if (!result || result.success !== true) {
    return {
      success: false,
      errorMsg: result && result.errorMsg || "COMPENSATION_CLAIM_LIST_FAILED",
      data: [],
    };
  }
  const includeCompleted = options.includeCompleted === true;
  const claims = Object.values(result.data || {})
    .filter((claim) => (
      claim &&
      typeof claim === "object" &&
      Number(claim.characterID) === numericCharacterID &&
      (includeCompleted || String(claim.state || "").toLowerCase() !== "completed")
    ))
    .map((claim) => cloneValue(claim))
    .sort((left, right) => (
      Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0) ||
      String(left.deploymentToken || "").localeCompare(String(right.deploymentToken || ""))
    ));
  return { success: true, data: claims };
}

function resetForTests() {
  if (!ensureStore()) {
    return false;
  }
  const writeResult = repo.write(TABLE_NAME, "/", {}, { force: true });
  const flushResult = writeResult && writeResult.success
    ? repo.flushTableSync(TABLE_NAME)
    : null;
  return Boolean(flushResult && flushResult.success);
}

module.exports = {
  TABLE_NAME,
  readClaim,
  persistClaim,
  listClaimsForCharacter,
  _testing: {
    resetForTests,
  },
};
