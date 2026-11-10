"use strict";

function normalizeErrorMessage(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function buildExecutionResult({
  success,
  attempted,
  executed,
  alreadyMaterialized,
  emptyManifest,
  receiptKey,
  physicalResult,
  errorMsg = "",
}) {
  return {
    success,
    attempted,
    executed,
    alreadyMaterialized,
    emptyManifest,
    receiptKey,
    physicalResult,
    errorMsg,
  };
}

function createAbyssalRewardMaterializationExecutor(dependencies = {}) {
  const grantItemsToOwnerLocationIdempotent =
    dependencies.grantItemsToOwnerLocationIdempotent;

  return Object.freeze({
    executeMaterialization(request = {}) {
      const normalizedRequest = request && typeof request === "object" ? request : {};
      const receiptKey = String(normalizedRequest.receiptKey || "").trim();
      const suppliedPhysicalResult = normalizedRequest.physicalResult || null;

      if (normalizedRequest.alreadyMaterialized === true) {
        return buildExecutionResult({
          success: true,
          attempted: false,
          executed: false,
          alreadyMaterialized: true,
          emptyManifest: false,
          receiptKey,
          physicalResult: suppliedPhysicalResult,
        });
      }

      const grantEntries = Array.isArray(normalizedRequest.grantEntries)
        ? normalizedRequest.grantEntries
        : [];
      if (grantEntries.length === 0) {
        const physicalResult = suppliedPhysicalResult || {
          success: true,
          data: { changes: [], items: [] },
          emptyManifest: true,
        };
        return buildExecutionResult({
          success: true,
          attempted: false,
          executed: false,
          alreadyMaterialized: false,
          emptyManifest: true,
          receiptKey,
          physicalResult,
        });
      }

      if (typeof grantItemsToOwnerLocationIdempotent !== "function") {
        const physicalResult = {
          success: false,
          errorMsg: "REWARD_BATCH_GRANT_UNAVAILABLE",
        };
        return buildExecutionResult({
          success: false,
          attempted: false,
          executed: false,
          alreadyMaterialized: false,
          emptyManifest: false,
          receiptKey,
          physicalResult,
          errorMsg: physicalResult.errorMsg,
        });
      }

      let physicalResult;
      try {
        physicalResult = grantItemsToOwnerLocationIdempotent(
          normalizedRequest.recipientOwnerID,
          normalizedRequest.destinationLocationID,
          normalizedRequest.destinationFlagID,
          grantEntries,
          normalizedRequest.grantOptions,
        );
      } catch (error) {
        physicalResult = {
          success: false,
          errorMsg: normalizeErrorMessage(
            error && error.message,
            "REWARD_MANIFEST_GRANT_FAILED",
          ),
        };
      }

      const success = Boolean(physicalResult && physicalResult.success === true);
      const alreadyMaterialized = Boolean(success && physicalResult.duplicate === true);
      return buildExecutionResult({
        success,
        attempted: true,
        executed: success && !alreadyMaterialized,
        alreadyMaterialized,
        emptyManifest: false,
        receiptKey,
        physicalResult,
        errorMsg: success
          ? ""
          : normalizeErrorMessage(
              physicalResult && physicalResult.errorMsg,
              "REWARD_MANIFEST_GRANT_FAILED",
            ),
      });
    },
  });
}

module.exports = {
  createAbyssalRewardMaterializationExecutor,
};
