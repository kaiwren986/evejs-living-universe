"use strict";

/**
 * Process-local wallet command owner.
 *
 * The existing service surface is synchronous, so this executor deliberately
 * stays synchronous while making ownership, ordering, and the future transport
 * contract explicit. A later process client can preserve the command vocabulary
 * and replace execute() only after callers have migrated to saga-safe async flows.
 */

const WALLET_COMMAND_TYPE = Object.freeze({
  CHARACTER_APPEND_MARKET_TRANSACTION: "character.append-market-transaction",
  CHARACTER_SET_ISK: "character.set-isk",
  CHARACTER_ADJUST_ISK: "character.adjust-isk",
  CHARACTER_TRANSFER_ISK: "character.transfer-isk",
  CHARACTER_SET_PLEX: "character.set-plex",
  CHARACTER_ADJUST_PLEX: "character.adjust-plex",
  CORPORATION_APPEND_MARKET_TRANSACTION:
    "corporation.append-market-transaction",
  CORPORATION_SET_ISK: "corporation.set-isk",
  CORPORATION_ADJUST_ISK: "corporation.adjust-isk",
  CORPORATION_TRANSFER_ISK: "corporation.transfer-isk",
  CORPORATION_LIQUIDATE_TO_CHARACTER:
    "corporation.liquidate-to-character",
  CORPORATION_DISTRIBUTE_ISK: "corporation.distribute-isk",
});

const KNOWN_COMMAND_TYPES = new Set(Object.values(WALLET_COMMAND_TYPE));

class WalletAuthorityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WalletAuthorityError";
    this.code = code;
  }
}

function cloneCommandPayload(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function createEmptyCommandStats() {
  return {
    submitted: 0,
    completed: 0,
    failed: 0,
    rejectedReentrant: 0,
    totalExecutionMs: 0,
  };
}

function createWalletCommandAuthority(options = {}) {
  const nowNs =
    typeof options.nowNs === "function"
      ? options.nowNs
      : () => process.hrtime.bigint();
  const handlers = new Map();
  const commandStats = new Map();
  let nextSequence = 1;
  let activeCommand = null;
  let totals = createEmptyCommandStats();

  function getTypeStats(commandType) {
    if (!commandStats.has(commandType)) {
      commandStats.set(commandType, createEmptyCommandStats());
    }
    return commandStats.get(commandType);
  }

  function registerHandlers(owner, entries) {
    const normalizedOwner = String(owner || "").trim();
    if (!normalizedOwner) {
      throw new WalletAuthorityError(
        "wallet command handlers require an owner",
        "INVALID_HANDLER_OWNER",
      );
    }
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new WalletAuthorityError(
        `wallet command owner ${normalizedOwner} provided invalid handlers`,
        "INVALID_HANDLERS",
      );
    }

    for (const [commandType, handler] of Object.entries(entries)) {
      if (!KNOWN_COMMAND_TYPES.has(commandType)) {
        throw new WalletAuthorityError(
          `unknown wallet command type: ${commandType}`,
          "UNKNOWN_COMMAND_TYPE",
        );
      }
      if (typeof handler !== "function") {
        throw new WalletAuthorityError(
          `wallet command ${commandType} requires a handler`,
          "INVALID_HANDLER",
        );
      }
      const existing = handlers.get(commandType);
      if (existing && existing.owner !== normalizedOwner) {
        throw new WalletAuthorityError(
          `wallet command ${commandType} is already owned by ${existing.owner}`,
          "HANDLER_ALREADY_REGISTERED",
        );
      }
      // Same-owner replacement makes focused require-cache reloads deterministic
      // without allowing a second domain to take over a command.
      handlers.set(commandType, {
        owner: normalizedOwner,
        handler,
      });
    }
  }

  function execute(commandType, payload = {}, metadata = {}) {
    if (!KNOWN_COMMAND_TYPES.has(commandType)) {
      throw new WalletAuthorityError(
        `unknown wallet command type: ${commandType}`,
        "UNKNOWN_COMMAND_TYPE",
      );
    }
    const registration = handlers.get(commandType);
    if (!registration) {
      throw new WalletAuthorityError(
        `wallet command ${commandType} has no registered owner`,
        "HANDLER_NOT_REGISTERED",
      );
    }
    if (activeCommand) {
      totals.rejectedReentrant += 1;
      getTypeStats(commandType).rejectedReentrant += 1;
      throw new WalletAuthorityError(
        `wallet command ${commandType} cannot run while ` +
          `${activeCommand.commandType}#${activeCommand.sequence} is committing`,
        "REENTRANT_COMMAND",
      );
    }

    const sequence = nextSequence;
    nextSequence += 1;
    const command = Object.freeze({
      commandType,
      sequence,
      owner: registration.owner,
      payload: cloneCommandPayload(payload),
      metadata: Object.freeze({
        source:
          typeof metadata.source === "string" && metadata.source.trim()
            ? metadata.source.trim()
            : null,
        idempotencyKey:
          typeof metadata.idempotencyKey === "string" &&
          metadata.idempotencyKey.trim()
            ? metadata.idempotencyKey.trim()
            : null,
      }),
    });
    const typeStats = getTypeStats(commandType);
    totals.submitted += 1;
    typeStats.submitted += 1;
    activeCommand = command;
    const startedNs = nowNs();

    try {
      const result = registration.handler(command.payload, {
        commandType,
        sequence,
        owner: registration.owner,
        metadata: command.metadata,
      });
      if (result && typeof result.then === "function") {
        throw new WalletAuthorityError(
          `wallet command ${commandType} returned a promise; ` +
            "the compatibility authority is synchronous",
          "ASYNC_HANDLER_NOT_SUPPORTED",
        );
      }
      totals.completed += 1;
      typeStats.completed += 1;
      return result;
    } catch (error) {
      totals.failed += 1;
      typeStats.failed += 1;
      throw error;
    } finally {
      const elapsedMs = Number(nowNs() - startedNs) / 1e6;
      totals.totalExecutionMs += elapsedMs;
      typeStats.totalExecutionMs += elapsedMs;
      activeCommand = null;
    }
  }

  function getStats() {
    return {
      ...totals,
      active: activeCommand
        ? {
            commandType: activeCommand.commandType,
            sequence: activeCommand.sequence,
            owner: activeCommand.owner,
          }
        : null,
      nextSequence,
      byType: Object.fromEntries(
        [...commandStats.entries()].map(([commandType, stats]) => [
          commandType,
          { ...stats },
        ]),
      ),
      registeredOwners: Object.fromEntries(
        [...handlers.entries()].map(([commandType, registration]) => [
          commandType,
          registration.owner,
        ]),
      ),
    };
  }

  function resetStatsForTests() {
    if (activeCommand) {
      throw new WalletAuthorityError(
        "cannot reset wallet authority statistics during a command",
        "COMMAND_ACTIVE",
      );
    }
    nextSequence = 1;
    totals = createEmptyCommandStats();
    commandStats.clear();
  }

  return {
    execute,
    getStats,
    registerHandlers,
    resetStatsForTests,
  };
}

const authority = createWalletCommandAuthority();
let processModeEnabled = false;
let processTransport = null;

function getProcessTransport() {
  if (!processTransport) {
    const { getWalletAuthorityTransport } = require("./walletAuthorityTransport");
    processTransport = getWalletAuthorityTransport();
  }
  return processTransport;
}

function executeWalletCommand(commandType, payload = {}, metadata = {}) {
  if (processModeEnabled) {
    throw new WalletAuthorityError(
      `synchronous wallet command ${commandType} is disabled in process mode`,
      "SYNC_WALLET_AUTHORITY_DISABLED",
    );
  }
  return authority.execute(commandType, payload, metadata);
}

function executeWalletCommandAsync(commandType, payload = {}, metadata = {}) {
  if (!processModeEnabled) {
    return Promise.resolve().then(() => authority.execute(commandType, payload, metadata));
  }
  return getProcessTransport().execute(commandType, payload, metadata);
}

function enableWalletAuthorityProcess(options = {}) {
  if (process.env.EVEJS_WALLET_AUTHORITY_OWNER === "1") {
    throw new WalletAuthorityError(
      "wallet owner process cannot enable a nested wallet authority",
      "NESTED_WALLET_AUTHORITY",
    );
  }
  if (options.transport) {
    processTransport = options.transport;
  }
  processModeEnabled = true;
  const transport = getProcessTransport();
  return options.start === false ? Promise.resolve() : transport.start();
}

function isWalletAuthorityProcessEnabled() {
  return processModeEnabled;
}

function shutdownWalletAuthorityProcess() {
  return processTransport && typeof processTransport.shutdown === "function"
    ? processTransport.shutdown()
    : Promise.resolve();
}

function resetExecutionModeForTests() {
  processModeEnabled = false;
  processTransport = null;
}

module.exports = {
  WALLET_COMMAND_TYPE,
  WalletAuthorityError,
  enableWalletAuthorityProcess,
  executeWalletCommand,
  executeWalletCommandAsync,
  getWalletAuthorityStats: authority.getStats,
  isWalletAuthorityProcessEnabled,
  registerWalletCommandHandlers: authority.registerHandlers,
  shutdownWalletAuthorityProcess,
  _createWalletCommandAuthorityForTests: createWalletCommandAuthority,
  _resetWalletAuthorityStatsForTests: authority.resetStatsForTests,
  _resetWalletAuthorityExecutionModeForTests: resetExecutionModeForTests,
};
