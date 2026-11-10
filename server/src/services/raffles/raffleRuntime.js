"use strict";

const path = require("path");
const { resolveDataRootPath } = require(path.join(__dirname, "../../config/dataRoot"));

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const {
  buildList,
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  throwWrappedRaffleCreateError,
  throwWrappedRaffleError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  adjustCharacterBalanceAsync,
} = require(path.join(__dirname, "../account/walletState"));
const {
  findItemById,
  getActiveShipItem,
  listCharacterItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const itemTypeRegistry = require(path.join(
  __dirname,
  "../inventory/itemTypeRegistry",
));
const log = require(path.join(__dirname, "../../utils/logger"));
const rotatingLog = require(path.join(__dirname, "../../utils/rotatingLog"));
const {
  FILETIME_TICKS_PER_MS,
  SEED_DURATION_MS,
  HISTORY_PAGE_SIZE,
  DEFAULT_GRAB_SIZE,
  DEFAULT_STARTUP_SEED_COUNT,
  MAX_QA_SEED_COUNT,
  RAFFLE_STATUS,
  TOKEN_TYPE_ID,
} = require(path.join(__dirname, "./raffleConstants"));
const {
  normalizeInteger,
  getSessionCharacterID,
  dedupeTicketNumbers,
  shuffleArray,
  calculateTotalPrice,
  tokensRequired,
  matchesGrabFilters,
  isExpired,
  pickWinningTicket,
  buildCreationPayload,
  getSessionStationID,
  isFinishedStatus,
  groupTicketsByOwner,
} = require(path.join(__dirname, "./raffleHelpers"));
const {
  buildTicketValue,
  buildRaffleValue,
  buildCharacterStatisticsValue,
  buildTypeStatisticsValue,
} = require(path.join(__dirname, "./raffleMarshal"));
const {
  notifyTicketsUpdated,
  notifyRaffleUpdated,
  notifyRaffleFinished,
  notifyRaffleCreated,
} = require(path.join(__dirname, "./raffleNotifications"));
const {
  ensureCharacterTokenStack,
  consumeTokenStack,
  moveItemToRaffleEscrow,
  restoreEscrowedItem,
  deliverRaffleItemToCharacterStation,
  notifyInventoryChangesToCharacter,
  getCharacterSessions,
  getLargestTokenStack,
  ITEM_FLAGS,
} = require(path.join(__dirname, "./raffleInventory"));
const RaffleState = require(path.join(__dirname, "./raffleState"));
const {
  buildRaffleSettlementState,
} = require(path.join(__dirname, "./raffleSeed"));
const RaffleSeedManager = require(path.join(__dirname, "./raffleSeedManager"));
const {
  ensureSettlementState,
  repairPersistedRaffleState,
  restoreExpiredItem,
  refundExpiredTickets,
  creditSellerIfNeeded,
} = require(path.join(__dirname, "./raffleSettlement"));
const {
  validateCreateInput,
} = require(path.join(__dirname, "./raffleValidation"));

const RAFFLE_CREATE_DEBUG_PATH = resolveDataRootPath("logs", "raffle-create-debug.log");
const DURABLE_EXPIRY_JOB_TYPE = "raffle.expire";
const DURABLE_SETTLEMENT_JOB_TYPE = "raffle.settle";
const EXPIRY_GRACE_MS = 100;
const FILETIME_UNIX_EPOCH_OFFSET = 116444736000000000n;

function fileTimeToUnixMs(fileTime) {
  const normalizedFileTime = typeof fileTime === "bigint" ? fileTime : 0n;
  if (normalizedFileTime <= FILETIME_UNIX_EPOCH_OFFSET) {
    return null;
  }
  const dueAtMs = Number(
    (
      normalizedFileTime - FILETIME_UNIX_EPOCH_OFFSET +
      FILETIME_TICKS_PER_MS - 1n
    ) / FILETIME_TICKS_PER_MS,
  );
  return Number.isSafeInteger(dueAtMs) && dueAtMs > 0 ? dueAtMs : null;
}

function buildDurableRaffleExpiryJob(raffleState) {
  const raffleId = normalizeInteger(raffleState && raffleState.raffleId, 0);
  const expirationTime = raffleState && typeof raffleState.expirationTime === "bigint"
    ? raffleState.expirationTime
    : 0n;
  if (
    raffleId <= 0 ||
    expirationTime <= FILETIME_UNIX_EPOCH_OFFSET ||
    Boolean(raffleState && raffleState.purchaseSaga) ||
    normalizeInteger(raffleState && raffleState.raffleStatus, 0) !==
      RAFFLE_STATUS.RUNNING
  ) {
    return null;
  }
  const dueAtMs = fileTimeToUnixMs(expirationTime);
  if (!dueAtMs) {
    return null;
  }
  return {
    jobID: `raffle:${raffleId}:${expirationTime}:expire`,
    type: DURABLE_EXPIRY_JOB_TYPE,
    dueAtMs: dueAtMs + EXPIRY_GRACE_MS,
    payload: {
      raffleId,
      expirationTime: expirationTime.toString(),
    },
  };
}

function buildDurableRaffleSettlementJob(raffleState) {
  const raffleId = normalizeInteger(raffleState && raffleState.raffleId, 0);
  const creationTime = raffleState && typeof raffleState.creationTime === "bigint"
    ? raffleState.creationTime
    : 0n;
  const settlement = (raffleState && raffleState.settlement) || {};
  const hasPendingPurchase = Boolean(raffleState && raffleState.purchaseSaga);
  if (
    raffleId <= 0 ||
    creationTime <= FILETIME_UNIX_EPOCH_OFFSET ||
    (
      !hasPendingPurchase &&
      (!raffleState.winningTicket || settlement.sellerPayoutApplied === true)
    )
  ) {
    return null;
  }
  const dueAtMs = fileTimeToUnixMs(raffleState.endDate || creationTime);
  if (!dueAtMs) {
    return null;
  }
  return {
    jobID: `raffle:${raffleId}:${creationTime}:settle`,
    type: DURABLE_SETTLEMENT_JOB_TYPE,
    dueAtMs: dueAtMs + EXPIRY_GRACE_MS,
    payload: {
      raffleId,
      creationTime: creationTime.toString(),
    },
  };
}

function buildDurableRaffleJob(raffleState) {
  return buildDurableRaffleSettlementJob(raffleState) ||
    buildDurableRaffleExpiryJob(raffleState);
}

function summarizeCreateItem(item) {
  if (!item) {
    return null;
  }

  return {
    itemID: item.itemID,
    typeID: item.typeID,
    ownerID: item.ownerID,
    locationID: item.locationID,
    flagID: item.flagID,
    singleton: item.singleton,
    stacksize: item.stacksize,
  };
}

function appendCreateDebug(entry) {
  try {
    rotatingLog.append(RAFFLE_CREATE_DEBUG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    log.warn(`[RaffleRuntime] Failed to write create debug log: ${error.message}`);
  }
}

function resolveCreateItem(ownerId, creationData, sessionStationId) {
  const directItem = findItemById(creationData.item_id);
  const locationId = normalizeInteger(
    creationData.location_id,
    sessionStationId,
  );
  const directItemMatches = (
    directItem &&
    normalizeInteger(directItem.ownerID, 0) === ownerId &&
    normalizeInteger(directItem.typeID, 0) === normalizeInteger(creationData.type_id, 0) &&
    normalizeInteger(directItem.flagID, 0) === ITEM_FLAGS.HANGAR &&
    (
      locationId <= 0 ||
      normalizeInteger(directItem.locationID, 0) === locationId
    )
  );
  if (directItemMatches) {
    return {
      item: directItem,
      resolution: "direct",
    };
  }

  const candidates = listCharacterItems(ownerId, {
    locationID: locationId > 0 ? locationId : null,
    flagID: ITEM_FLAGS.HANGAR,
    typeID: creationData.type_id,
  });
  if (candidates.length === 1) {
    return {
      item: candidates[0],
      resolution: "owner-location-type-fallback",
    };
  }

  return {
    item: null,
    resolution: "missing",
    candidateCount: candidates.length,
    directItem: summarizeCreateItem(directItem),
  };
}

function resolveCreateToken(ownerId, creationData, sessionStationId) {
  const directToken = findItemById(creationData.token_id);
  const locationId = normalizeInteger(
    creationData.token_location_id,
    sessionStationId,
  );
  const directTokenMatches = (
    directToken &&
    normalizeInteger(directToken.ownerID, 0) === ownerId &&
    normalizeInteger(directToken.typeID, 0) === TOKEN_TYPE_ID &&
    normalizeInteger(directToken.flagID, 0) === ITEM_FLAGS.HANGAR &&
    (
      locationId <= 0 ||
      normalizeInteger(directToken.locationID, 0) === locationId
    )
  );
  if (directTokenMatches) {
    return {
      token: directToken,
      resolution: "direct",
    };
  }

  const fallbackToken = getLargestTokenStack(
    ownerId,
    locationId > 0 ? locationId : null,
  );
  if (fallbackToken) {
    return {
      token: fallbackToken,
      resolution: "largest-stack-fallback",
    };
  }

  return {
    token: null,
    resolution: "missing",
    directToken: summarizeCreateItem(directToken),
  };
}

class RaffleRuntime {
  constructor() {
    this._state = new RaffleState();
    this._seedManager = new RaffleSeedManager(this._state);
    this._nowFileTimeOverride = null;
    this._durableScheduler = null;
    this._durableSchedulerGeneration = 0;
    this._durableJobIDs = new Map();
    this._durableScheduleLanes = new Map();
    this._activeDurableExpiryJobs = new Set();
    this._purchaseLanes = new Map();
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) {
      return;
    }

    this._state.initialize();
    this._repairPersistedRaffles();

    this._seedManager.reconcile();

    this._initialized = true;
  }

  reset(options = {}) {
    this._durableSchedulerGeneration += 1;
    this._durableJobIDs.clear();
    this._durableScheduleLanes.clear();
    this._activeDurableExpiryJobs.clear();
    this._purchaseLanes.clear();
    this._state.reset(options);
    this._initialized = false;
  }

  /**
   * Let the isolated gameplay harness advance raffle deadlines without
   * advancing process-wide Date.now(), which owns the persistence lease.
   */
  setNowFileTimeOverride(getNowFileTime) {
    this._nowFileTimeOverride = typeof getNowFileTime === "function"
      ? getNowFileTime
      : null;
  }

  resetNowFileTimeOverride() {
    this._nowFileTimeOverride = null;
  }

  _currentFileTime() {
    return this._nowFileTimeOverride
      ? this._nowFileTimeOverride()
      : currentFileTime();
  }

  subscribeToTickets(session) {
    this.initialize();
    this._ensureCharacterReady(session);
    this._state.subscriptions.subscribeToTickets(session);
  }

  unsubscribeFromTickets(session) {
    this.initialize();
    this._state.subscriptions.unsubscribeFromTickets(session);
  }

  subscribeToRaffle(session, raffleId) {
    this.initialize();
    const raffleState = this._requireRaffle(raffleId);
    this._state.subscriptions.subscribeToRaffle(session, raffleState.raffleId);
  }

  unsubscribeFromRaffle(session, raffleId) {
    this.initialize();
    this._state.subscriptions.unsubscribeFromRaffle(session, raffleId);
  }

  grab(filters = {}, constraints = {}, size = null, session = null) {
    this.initialize();
    this._ensureCharacterReady(session);

    const maxSize =
      size === null || size === undefined
        ? DEFAULT_GRAB_SIZE
        : Math.max(0, normalizeInteger(size, DEFAULT_GRAB_SIZE));
    if (maxSize === 0) {
      return buildList([]);
    }

    const viewerCharacterId = getSessionCharacterID(session);
    const now = this._currentFileTime();
    const raffles = this._state.getRaffles()
      .filter((raffleState) => raffleState.raffleStatus === RAFFLE_STATUS.RUNNING)
      .filter((raffleState) => !isExpired(raffleState, now))
      .filter((raffleState) => (
        matchesGrabFilters(
          raffleState,
          filters,
          constraints,
          viewerCharacterId,
        )
      ))
      .slice(0, maxSize)
      .map(buildRaffleValue);

    return buildList(raffles);
  }

  getRaffle(raffleId, session = null) {
    this.initialize();
    this._ensureCharacterReady(session);
    return buildRaffleValue(this._requireRaffle(raffleId));
  }

  getActiveTickets(session) {
    this.initialize();
    const ownerId = getSessionCharacterID(session);
    const now = this._currentFileTime();
    const tickets = this._state.getRaffles()
      .filter((raffleState) => raffleState.raffleStatus === RAFFLE_STATUS.RUNNING)
      .filter((raffleState) => !isExpired(raffleState, now))
      .flatMap((raffleState) => this._getOwnedTickets(ownerId, raffleState))
      .map(buildTicketValue);
    return buildList(tickets);
  }

  getHistory(session, runningId = null) {
    this.initialize();
    const ownerId = getSessionCharacterID(session);
    const normalizedRunningId = normalizeInteger(runningId, 0);
    const page = this._state.getRaffles()
      .filter((raffleState) => (
        raffleState.ownerId === ownerId ||
        this._getOwnedTickets(ownerId, raffleState).length > 0
      ))
      .filter((raffleState) => (
        normalizedRunningId <= 0 || raffleState.runningId < normalizedRunningId
      ))
      .slice(0, HISTORY_PAGE_SIZE)
      .map(buildRaffleValue);

    return [buildList(page), HISTORY_PAGE_SIZE];
  }

  getCharacterStatistics(session) {
    this.initialize();
    const ownerId = getSessionCharacterID(session);
    const now = this._currentFileTime();
    let rafflesParticipated = 0;
    let rafflesWon = 0;
    let finishedDelivered = 0;
    let finishedUndelivered = 0;
    let finishedExpired = 0;
    let createdRunning = 0;

    for (const raffleState of this._state.getRaffles()) {
      const hasTickets = this._getOwnedTickets(ownerId, raffleState).length > 0;
      const isWinner =
        normalizeInteger(raffleState.winningTicket && raffleState.winningTicket.ownerId, 0) ===
        ownerId;
      const isOwner = raffleState.ownerId === ownerId;

      if (hasTickets) {
        rafflesParticipated += 1;
      }
      if (isWinner) {
        rafflesWon += 1;
      }
      if (isOwner && raffleState.raffleStatus === RAFFLE_STATUS.FINISHED_DELIVERED) {
        finishedDelivered += 1;
      }
      if (isOwner && raffleState.raffleStatus === RAFFLE_STATUS.FINISHED_UNDELIVERED) {
        finishedUndelivered += 1;
      }
      if (isOwner && raffleState.raffleStatus === RAFFLE_STATUS.FINISHED_EXPIRED) {
        finishedExpired += 1;
      }
      if (
        isOwner &&
        raffleState.raffleStatus === RAFFLE_STATUS.RUNNING &&
        !isExpired(raffleState, now)
      ) {
        createdRunning += 1;
      }
    }

    return buildCharacterStatisticsValue({
      raffles_participated: rafflesParticipated,
      raffles_won: rafflesWon,
      finished_delivered: finishedDelivered,
      finished_undelivered: finishedUndelivered,
      finished_expired: finishedExpired,
      created_running: createdRunning,
    });
  }

  getTypeStatistics(typeId) {
    this.initialize();
    const normalizedTypeId = normalizeInteger(typeId, 0);
    const now = this._currentFileTime();
    const matchingRaffles = this._state.getRaffles().filter(
      (raffleState) => raffleState.typeId === normalizedTypeId,
    );
    const activePrices = matchingRaffles
      .filter((raffleState) => (
        raffleState.raffleStatus === RAFFLE_STATUS.RUNNING &&
        !isExpired(raffleState, now)
      ))
      .map((raffleState) => calculateTotalPrice(raffleState.ticketPrice, raffleState.ticketCount));
    const historicPrices = matchingRaffles
      .filter((raffleState) => (
        raffleState.raffleStatus !== RAFFLE_STATUS.RUNNING ||
        isExpired(raffleState, now)
      ))
      .map((raffleState) => calculateTotalPrice(raffleState.ticketPrice, raffleState.ticketCount));
    const average = (values) => (
      values.length > 0
        ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : 0
    );

    return buildTypeStatisticsValue({
      historic_count: historicPrices.length,
      historic_min: historicPrices.length ? Math.min(...historicPrices) : 0,
      historic_max: historicPrices.length ? Math.max(...historicPrices) : 0,
      historic_average: average(historicPrices),
      active_count: activePrices.length,
      active_min: activePrices.length ? Math.min(...activePrices) : 0,
      active_max: activePrices.length ? Math.max(...activePrices) : 0,
      active_average: average(activePrices),
    });
  }

  createRaffle(session, rawCreationData) {
    this.initialize();
    this._ensureCharacterReady(session);

    const creationData = buildCreationPayload(rawCreationData);
    const ownerId = getSessionCharacterID(session);
    const sessionStationId = getSessionStationID(session);
    const resolvedItem = resolveCreateItem(ownerId, creationData, sessionStationId);
    const resolvedToken = resolveCreateToken(ownerId, creationData, sessionStationId);
    const item = resolvedItem.item;
    const token = resolvedToken.token;
    const activeShip = getActiveShipItem(ownerId);
    const totalPrice = calculateTotalPrice(
      creationData.ticket_price,
      creationData.ticket_count,
    );
    let validated = null;
    try {
      validated = validateCreateInput({
        session,
        sessionStationId,
        creationData,
        totalPrice,
        item,
        token,
        activeShipId: normalizeInteger(activeShip && activeShip.itemID, 0),
        raffleState: this._state,
      });
    } catch (error) {
      appendCreateDebug({
        at: new Date().toISOString(),
        phase: "validate",
        error: error && error.message ? error.message : String(error),
        session: {
          characterID: session && session.characterID,
          charid: session && session.charid,
          stationID: session && session.stationID,
          stationid: session && session.stationid,
        },
        ownerId,
        sessionStationId,
        creationData,
        resolvedItem,
        resolvedToken,
        item: summarizeCreateItem(item),
        token: summarizeCreateItem(token),
      });
      throw error;
    }

    const requiredTokens = tokensRequired(totalPrice);
    if (normalizeInteger(token.stacksize, 0) < requiredTokens) {
      appendCreateDebug({
        at: new Date().toISOString(),
        phase: "token-count",
        error: "TokenAmountError",
        ownerId,
        sessionStationId,
        creationData,
        resolvedItem,
        resolvedToken,
        item: summarizeCreateItem(item),
        token: summarizeCreateItem(token),
        requiredTokens,
      });
      throwWrappedRaffleCreateError("TokenAmountError");
    }

    const escrowResult = moveItemToRaffleEscrow(item.itemID);
    if (!escrowResult.success) {
      appendCreateDebug({
        at: new Date().toISOString(),
        phase: "escrow",
        error: "ItemEscrowError",
        ownerId,
        sessionStationId,
        creationData,
        resolvedItem,
        resolvedToken,
        item: summarizeCreateItem(item),
        token: summarizeCreateItem(token),
      });
      throwWrappedRaffleCreateError("ItemEscrowError");
    }

    const tokenResult = consumeTokenStack(token.itemID, requiredTokens);
    if (!tokenResult.success) {
      appendCreateDebug({
        at: new Date().toISOString(),
        phase: "consume-tokens",
        error:
          tokenResult.errorMsg === "INSUFFICIENT_TOKENS"
            ? "TokenAmountError"
            : "TokenPaymentError",
        ownerId,
        sessionStationId,
        creationData,
        resolvedItem,
        resolvedToken,
        item: summarizeCreateItem(item),
        token: summarizeCreateItem(token),
        requiredTokens,
        tokenResult,
      });
      restoreEscrowedItem(item.itemID, item.locationID, item.flagID);
      throwWrappedRaffleCreateError(
        tokenResult.errorMsg === "INSUFFICIENT_TOKENS"
          ? "TokenAmountError"
          : "TokenPaymentError",
      );
    }

    const ids = this._state.allocateIds();
    const creationTime = this._currentFileTime();
    const expirationTime =
      creationTime + BigInt(SEED_DURATION_MS) * FILETIME_TICKS_PER_MS;
    const typeMetadata = itemTypeRegistry.resolveItemByTypeID(item.typeID) || {};
    const raffleState = {
      runningId: ids.runningId,
      raffleId: ids.raffleId,
      ownerId,
      locationId: item.locationID,
      solarSystemId: validated.solarSystemId,
      itemId: item.itemID,
      typeId: item.typeID,
      groupId: normalizeInteger(item.groupID, 0),
      categoryId: normalizeInteger(item.categoryID, 0),
      metaGroupId: normalizeInteger(
        typeMetadata.metaGroupID || typeMetadata.metaGroupId,
        0,
      ),
      ticketCount: creationData.ticket_count,
      ticketPrice: creationData.ticket_price,
      restrictionId: creationData.restriction_id,
      creationTime,
      expirationTime,
      soldTickets: [],
      winningTicket: null,
      raffleStatus: RAFFLE_STATUS.RUNNING,
      endDate: null,
      pendingIsk: 0,
      metaData: {
        is_copy: normalizeInteger(item.categoryID, 0) === 9 && item.quantity === -2,
      },
      inventory: {
        escrowItemId: item.itemID,
        originalLocationId: item.locationID,
        originalFlagId: item.flagID,
        tokenItemId: token.itemID,
        tokenCount: requiredTokens,
      },
      settlement: buildRaffleSettlementState(),
      nextPurchaseGeneration: 1,
      purchaseSaga: null,
      source: "player",
    };

    this._state.addRaffle(raffleState);
    this._scheduleExpiration(raffleState);
    notifyInventoryChangesToCharacter(
      ownerId,
      [escrowResult.data.change, tokenResult.data.change],
      { includeSession: session },
    );

    const creatorSessions = getCharacterSessions(ownerId, {
      includeSession: session,
    });
    setTimeout(() => {
      notifyRaffleCreated(
        creatorSessions,
        raffleState.raffleId,
        buildRaffleValue(raffleState),
      );
    }, 0);

    return raffleState.raffleId;
  }

  buyTicket(session, raffleId, ticketNumber) {
    this.initialize();
    const normalizedTicketNumber = normalizeInteger(ticketNumber, -1);
    if (normalizedTicketNumber < 0) {
      throwWrappedRaffleError("raffles.TicketUnavailableError");
    }

    return this._runTicketPurchaseLane(raffleId, async () => {
      const existingState = this._requireRaffle(raffleId);
      if (existingState.purchaseSaga) {
        return this._resumeTicketPurchase(existingState, { session });
      }
      const raffleState = this._requireRunningRaffle(raffleId);
      if (normalizedTicketNumber >= raffleState.ticketCount) {
        throwWrappedRaffleError("raffles.TicketUnavailableError");
      }
      return this._buyTickets(session, raffleState, [normalizedTicketNumber]);
    });
  }

  buyRandomTickets(session, raffleId, ticketCount) {
    this.initialize();
    const requestedCount = Math.max(0, normalizeInteger(ticketCount, 0));
    return this._runTicketPurchaseLane(raffleId, async () => {
      const existingState = this._requireRaffle(raffleId);
      if (existingState.purchaseSaga) {
        return this._resumeTicketPurchase(existingState, { session });
      }
      const raffleState = this._requireRunningRaffle(raffleId);
      if (requestedCount === 0) {
        return buildRaffleValue(raffleState);
      }

      const availableTicketNumbers = shuffleArray(
        this._getAvailableTicketNumbers(raffleState),
      );
      if (
        availableTicketNumbers.length === 0 ||
        requestedCount > availableTicketNumbers.length
      ) {
        throwWrappedRaffleError("raffles.TicketUnavailableError");
      }

      return this._buyTickets(
        session,
        raffleState,
        availableTicketNumbers.slice(0, requestedCount),
      );
    });
  }

  awardItem(session, raffleId) {
    this.initialize();
    return this._runTicketPurchaseLane(raffleId, async () => {
      const pendingState = this._requireRaffle(raffleId);
      if (pendingState.purchaseSaga) {
        await this._resumeTicketPurchase(pendingState, { notify: false });
      }
      return this._awardItemNow(session, raffleId);
    });
  }

  _awardItemNow(session, raffleId) {
    const raffleState = this._requireRaffle(raffleId);
    const ownerId = getSessionCharacterID(session);
    const winnerId = normalizeInteger(
      raffleState.winningTicket && raffleState.winningTicket.ownerId,
      0,
    );

    if (
      raffleState.raffleStatus !== RAFFLE_STATUS.FINISHED_UNDELIVERED ||
      ownerId <= 0 ||
      winnerId !== ownerId
    ) {
      throwWrappedRaffleError("raffles.FailureToDeliverItemError");
    }

    const deliveryResult = deliverRaffleItemToCharacterStation(
      raffleState.itemId,
      winnerId,
      raffleState.locationId,
      ITEM_FLAGS.HANGAR,
    );
    if (!deliveryResult.success) {
      throwWrappedRaffleError("raffles.FailureToDeliverItemError");
    }

    raffleState.raffleStatus = RAFFLE_STATUS.FINISHED_DELIVERED;
    if (!raffleState.endDate) {
      raffleState.endDate = this._currentFileTime();
    }
    ensureSettlementState(raffleState).itemDelivered = true;
    this._state.saveRaffle(raffleState);

    const deliveredChange = deliveryResult.data && deliveryResult.data.change;
    const previousOwnerId = normalizeInteger(
      deliveredChange && deliveredChange.previousData && deliveredChange.previousData.ownerID,
      0,
    );
    if (deliveredChange) {
      notifyInventoryChangesToCharacter(winnerId, [deliveredChange], {
        includeSession: session,
      });
      if (previousOwnerId > 0 && previousOwnerId !== winnerId) {
        notifyInventoryChangesToCharacter(previousOwnerId, [deliveredChange]);
      }
    }

    const raffleData = buildRaffleValue(raffleState);
    const recipientSessions = this._state.subscriptions.getInterestedSessions(
      raffleState,
      { includeSession: session },
    );
    notifyRaffleUpdated(recipientSessions, raffleState.raffleId, raffleData);
    return null;
  }

  qaSeedRaffles(count = DEFAULT_STARTUP_SEED_COUNT) {
    this.initialize();
    const normalizedCount = Math.max(
      0,
      Math.min(MAX_QA_SEED_COUNT, normalizeInteger(count, 0)),
    );
    const raffleStates = this._seedManager.seedRequested(normalizedCount);
    for (const raffleState of raffleStates) {
      this._scheduleExpiration(raffleState);
    }
    return raffleStates.length;
  }

  _ensureCharacterReady(session) {
    if (!session || getSessionStationID(session) <= 0) {
      return;
    }
    ensureCharacterTokenStack(session);
  }

  _repairPersistedRaffles() {
    for (const raffleState of this._state.getRaffles()) {
      if (repairPersistedRaffleState(raffleState)) {
        this._state.saveRaffle(raffleState);
      }
    }
  }

  _flushDurableOwnerState() {
    for (const tableName of ["raffles", "items", "characters"]) {
      database.flushTableAsync(tableName);
    }
  }

  _persistRaffleSettlementBoundary(raffleState) {
    this._state.saveRaffle(raffleState);
    const result = database.flushTableSync("raffles");
    if (!result || result.success !== true) {
      throw new Error(
        `raffle ${raffleState && raffleState.raffleId || 0} settlement checkpoint failed`,
      );
    }
  }

  bindDurableScheduler(scheduler) {
    if (
      !scheduler ||
      typeof scheduler.schedule !== "function" ||
      typeof scheduler.cancel !== "function"
    ) {
      throw new TypeError("raffle scheduler requires schedule and cancel functions");
    }
    this._durableSchedulerGeneration += 1;
    this._durableScheduler = scheduler;
    this._durableJobIDs.clear();
    this._durableScheduleLanes.clear();
    this._activeDurableExpiryJobs.clear();
    return true;
  }

  unbindDurableScheduler(scheduler = null) {
    if (scheduler && this._durableScheduler !== scheduler) {
      return false;
    }
    this._durableSchedulerGeneration += 1;
    this._durableScheduler = null;
    this._durableJobIDs.clear();
    this._durableScheduleLanes.clear();
    this._activeDurableExpiryJobs.clear();
    return true;
  }

  async _reconcileDurableRaffle(raffleId, options = {}) {
    const normalizedRaffleId = normalizeInteger(raffleId, 0);
    if (!this._durableScheduler || normalizedRaffleId <= 0) {
      return null;
    }
    const runningJobID = String(options.runningJobID || "");
    const previousJobID = this._durableJobIDs.get(normalizedRaffleId) || null;
    const raffleState = this._state.getRaffle(normalizedRaffleId);
    const nextJob = buildDurableRaffleJob(raffleState);
    if (!nextJob) {
      this._durableJobIDs.delete(normalizedRaffleId);
      if (
        previousJobID &&
        previousJobID !== runningJobID &&
        !this._activeDurableExpiryJobs.has(previousJobID)
      ) {
        await this._durableScheduler.cancel(previousJobID);
      }
      return null;
    }
    if (previousJobID === nextJob.jobID) {
      return nextJob;
    }
    if (
      previousJobID &&
      previousJobID !== runningJobID &&
      !this._activeDurableExpiryJobs.has(previousJobID)
    ) {
      await this._durableScheduler.cancel(previousJobID);
    }
    await this._durableScheduler.schedule(nextJob);
    this._durableJobIDs.set(normalizedRaffleId, nextJob.jobID);
    return nextJob;
  }

  _scheduleExpiration(raffleState, options = {}) {
    const raffleId = normalizeInteger(raffleState && raffleState.raffleId, 0);
    if (!this._durableScheduler || raffleId <= 0) {
      return Promise.resolve(null);
    }
    const scheduler = this._durableScheduler;
    const generation = this._durableSchedulerGeneration;
    const runningJobID = String(options.runningJobID || "");
    let commitError = null;
    try {
      this._flushDurableOwnerState();
    } catch (error) {
      commitError = error;
    }
    const previousLane = this._durableScheduleLanes.get(raffleId) || Promise.resolve();
    const lane = previousLane.catch(() => null).then(() => {
      if (
        scheduler !== this._durableScheduler ||
        generation !== this._durableSchedulerGeneration
      ) {
        return null;
      }
      if (commitError) {
        throw commitError;
      }
      return this._reconcileDurableRaffle(raffleId, { runningJobID });
    });
    this._durableScheduleLanes.set(raffleId, lane);
    void lane.finally(() => {
      if (this._durableScheduleLanes.get(raffleId) === lane) {
        this._durableScheduleLanes.delete(raffleId);
      }
    }).catch(() => null);
    void lane.catch((error) => {
      log.warn(
        `[RaffleRuntime] Durable expiry scheduling failed raffle=${raffleId}: ${error.message}`,
      );
    });
    return lane;
  }

  async reconcileDurableRaffles() {
    if (!this._durableScheduler) {
      return { scheduled: 0 };
    }
    this.initialize();
    this._flushDurableOwnerState();
    let scheduled = 0;
    for (const raffleState of this._state.getRaffles()) {
      const job = await this._reconcileDurableRaffle(raffleState.raffleId);
      if (job) scheduled += 1;
    }
    return { scheduled };
  }

  _isExpirySettled(raffleState) {
    if (
      !raffleState ||
      normalizeInteger(raffleState.raffleStatus, 0) !==
        RAFFLE_STATUS.FINISHED_EXPIRED
    ) {
      return false;
    }
    const settlement = ensureSettlementState(raffleState);
    for (const [ownerId, tickets] of groupTicketsByOwner(raffleState.soldTickets)) {
      const expectedRefund = raffleState.ticketPrice * tickets.length;
      if (Number(settlement.refundedOwners[String(ownerId)] || 0) < expectedRefund) {
        return false;
      }
    }
    return !(
      raffleState.source === "player" &&
      raffleState.inventory &&
      normalizeInteger(raffleState.inventory.escrowItemId, 0) > 0 &&
      settlement.itemRestored !== true
    );
  }

  async handleDurableRaffleExpiry(job) {
    const jobID = String(job && job.jobID || "");
    const raffleId = normalizeInteger(job && job.payload && job.payload.raffleId, 0);
    let expectedExpirationTime = 0n;
    try {
      expectedExpirationTime = BigInt(
        String(job && job.payload && job.payload.expirationTime || "0"),
      );
    } catch (_error) {
      expectedExpirationTime = 0n;
    }
    if (!jobID || raffleId <= 0 || expectedExpirationTime <= 0n) {
      throw new Error("raffle expiry job is invalid");
    }

    this.initialize();
    this._activeDurableExpiryJobs.add(jobID);
    try {
      if (this._durableJobIDs.get(raffleId) === jobID) {
        this._durableJobIDs.delete(raffleId);
      }
      const raffleState = this._state.getRaffle(raffleId);
      if (!raffleState) {
        this._flushDurableOwnerState();
        return { raffleId, expired: false, missing: true };
      }
      const currentExpirationTime = typeof raffleState.expirationTime === "bigint"
        ? raffleState.expirationTime
        : 0n;
      if (
        normalizeInteger(raffleState.raffleStatus, 0) ===
          RAFFLE_STATUS.FINISHED_EXPIRED &&
        currentExpirationTime === expectedExpirationTime
      ) {
        const recoveryResult = await this._expireRaffle(raffleId, {
          returnScheduling: true,
          runningJobID: jobID,
        });
        await recoveryResult.scheduling;
        this._flushDurableOwnerState();
        if (!this._isExpirySettled(this._state.getRaffle(raffleId))) {
          throw new Error(`raffle ${raffleId} expiry settlement is incomplete`);
        }
        return { raffleId, expired: true, recovered: true };
      }
      const currentJob = buildDurableRaffleExpiryJob(raffleState);
      if (
        !currentJob ||
        currentJob.jobID !== jobID ||
        String(currentJob.payload.expirationTime) !== expectedExpirationTime.toString()
      ) {
        this._flushDurableOwnerState();
        await this._reconcileDurableRaffle(raffleId, { runningJobID: jobID });
        return { raffleId, expired: false, stale: true };
      }
      if (expectedExpirationTime > this._currentFileTime()) {
        throw new Error(`raffle ${raffleId} expiry fired before its deadline`);
      }

      const expirationResult = await this._expireRaffle(raffleId, {
        returnScheduling: true,
        runningJobID: jobID,
      });
      await expirationResult.scheduling;
      this._flushDurableOwnerState();
      const settledRaffle = this._state.getRaffle(raffleId);
      if (!this._isExpirySettled(settledRaffle)) {
        throw new Error(`raffle ${raffleId} expiry settlement is incomplete`);
      }
      return { raffleId, expired: true, stale: false };
    } finally {
      this._activeDurableExpiryJobs.delete(jobID);
    }
  }

  async handleDurableRaffleSettlement(job) {
    const jobID = String(job && job.jobID || "");
    const raffleId = normalizeInteger(job && job.payload && job.payload.raffleId, 0);
    const creationTime = String(job && job.payload && job.payload.creationTime || "");
    if (!jobID || raffleId <= 0 || !creationTime) {
      throw new Error("raffle settlement job is invalid");
    }

    this.initialize();
    return this._runTicketPurchaseLane(raffleId, async () => {
      this._activeDurableExpiryJobs.add(jobID);
      try {
        if (this._durableJobIDs.get(raffleId) === jobID) {
          this._durableJobIDs.delete(raffleId);
        }
        const raffleState = this._state.getRaffle(raffleId);
        const currentJob = buildDurableRaffleSettlementJob(raffleState);
        if (
          !currentJob ||
          currentJob.jobID !== jobID ||
          currentJob.payload.creationTime !== creationTime
        ) {
          this._flushDurableOwnerState();
          await this._reconcileDurableRaffle(raffleId, { runningJobID: jobID });
          return { raffleId, settled: false, stale: true };
        }

        if (raffleState.purchaseSaga) {
          await this._resumeTicketPurchase(raffleState, { notify: false });
        }
        if (await creditSellerIfNeeded(raffleState)) {
          this._persistRaffleSettlementBoundary(raffleState);
        }
        this._flushDurableOwnerState();
        if (
          raffleState.purchaseSaga ||
          (
            raffleState.winningTicket &&
            !ensureSettlementState(raffleState).sellerPayoutApplied
          )
        ) {
          throw new Error(`raffle ${raffleId} settlement is incomplete`);
        }
        await this._reconcileDurableRaffle(raffleId, { runningJobID: jobID });
        return { raffleId, settled: true, stale: false };
      } finally {
        this._activeDurableExpiryJobs.delete(jobID);
      }
    });
  }

  async _expireRaffle(raffleId, options = {}) {
    const raffleState = this._state.getRaffle(raffleId);
    if (!raffleState) {
      return false;
    }

    ensureSettlementState(raffleState);
    const alreadyFinished = isFinishedStatus(raffleState.raffleStatus);
    if (!alreadyFinished) {
      raffleState.winningTicket = null;
      raffleState.raffleStatus = RAFFLE_STATUS.FINISHED_EXPIRED;
      raffleState.endDate = this._currentFileTime();
      this._persistRaffleSettlementBoundary(raffleState);
    }

    const refundedDirty = await refundExpiredTickets(raffleState);
    const restoreResult = restoreExpiredItem(raffleState);
    if (refundedDirty || restoreResult.dirty) {
      this._persistRaffleSettlementBoundary(raffleState);
    }

    if (restoreResult.inventoryChanges.length > 0) {
      notifyInventoryChangesToCharacter(raffleState.ownerId, restoreResult.inventoryChanges);
    }

    const scheduling = this._scheduleExpiration(raffleState, options);

    if (!alreadyFinished) {
      const raffleData = buildRaffleValue(raffleState);
      const recipientSessions = this._state.subscriptions.getInterestedSessions(
        raffleState,
      );
      notifyRaffleUpdated(recipientSessions, raffleState.raffleId, raffleData);
      notifyRaffleFinished(recipientSessions, raffleState.raffleId, null);
      return options.returnScheduling === true
        ? { changed: true, scheduling }
        : true;
    }

    const changed = refundedDirty || restoreResult.dirty;
    return options.returnScheduling === true
      ? { changed, scheduling }
      : changed;
  }

  _runTicketPurchaseLane(raffleId, operation) {
    const normalizedRaffleId = normalizeInteger(raffleId, 0);
    const previous = this._purchaseLanes.get(normalizedRaffleId) || Promise.resolve();
    const lane = previous.catch(() => null).then(operation);
    this._purchaseLanes.set(normalizedRaffleId, lane);
    void lane.finally(() => {
      if (this._purchaseLanes.get(normalizedRaffleId) === lane) {
        this._purchaseLanes.delete(normalizedRaffleId);
      }
    }).catch(() => null);
    return lane;
  }

  async _buyTickets(session, raffleState, requestedTicketNumbers = []) {
    const ownerId = getSessionCharacterID(session);
    if (ownerId <= 0) {
      throwWrappedRaffleError("raffles.TicketUnavailableError");
    }

    const requestedNumbers = dedupeTicketNumbers(requestedTicketNumbers).filter(
      (ticketNumber) => ticketNumber < raffleState.ticketCount,
    );
    if (requestedNumbers.length === 0) {
      return buildRaffleValue(raffleState);
    }

    const availableTicketNumbers = this._getAvailableTicketNumbers(raffleState);
    const availableNumbers = new Set(availableTicketNumbers);
    for (const ticketNumber of requestedNumbers) {
      if (!availableNumbers.has(ticketNumber)) {
        throwWrappedRaffleError("raffles.TicketUnavailableError");
      }
    }

    const generation = Math.max(
      1,
      normalizeInteger(raffleState.nextPurchaseGeneration, 1),
    );
    const operationKey =
      `raffle:${raffleState.raffleId}:${String(raffleState.creationTime || 0)}` +
      `:purchase:${generation}`;
    raffleState.nextPurchaseGeneration = generation + 1;
    raffleState.purchaseSaga = {
      generation,
      operationKey,
      ownerId,
      ticketNumbers: requestedNumbers.slice().sort((left, right) => left - right),
      amount: raffleState.ticketPrice * requestedNumbers.length,
      phase: "prepared",
    };
    this._persistRaffleSettlementBoundary(raffleState);
    return this._resumeTicketPurchase(raffleState, { session });
  }

  async _resumeTicketPurchase(raffleState, options = {}) {
    const saga = raffleState && raffleState.purchaseSaga;
    if (!saga) {
      return buildRaffleValue(raffleState);
    }
    const ownerId = normalizeInteger(saga.ownerId, 0);
    const amount = Number(saga.amount) || 0;
    const commandID = `${saga.operationKey}:wallet-debit`;
    if (saga.phase === "prepared") {
      let walletResult;
      try {
        walletResult = await adjustCharacterBalanceAsync(ownerId, -amount, {
          description: `HyperNet ticket purchase ${raffleState.raffleId}`,
          ownerID1: ownerId,
          ownerID2: raffleState.ownerId,
          referenceID: raffleState.raffleId,
          idempotencyKey: commandID,
        }, {
          commandID,
          idempotencyKey: commandID,
          source: "raffle.ticket-purchase",
        });
      } catch (_error) {
        this._scheduleExpiration(raffleState);
        throwWrappedRaffleError("raffles.PurchaseError");
      }
      if (!walletResult || walletResult.success !== true) {
        raffleState.purchaseSaga = null;
        this._persistRaffleSettlementBoundary(raffleState);
        this._scheduleExpiration(raffleState);
        throwWrappedRaffleError(
          walletResult && walletResult.errorMsg === "INSUFFICIENT_FUNDS"
            ? "raffles.NotEnoughISKError"
            : "raffles.PurchaseError",
        );
      }
      saga.phase = "debited";
      this._persistRaffleSettlementBoundary(raffleState);
    }

    if (saga.phase === "debited") {
      for (const ticketNumber of saga.ticketNumbers || []) {
        const existing = raffleState.soldTickets.find(
          (ticket) => normalizeInteger(ticket && ticket.number, -1) === ticketNumber,
        );
        if (existing) {
          if (normalizeInteger(existing.ownerId, 0) !== ownerId) {
            throw new Error(
              `raffle ${raffleState.raffleId} purchase reservation conflicted at ticket ${ticketNumber}`,
            );
          }
          continue;
        }
        raffleState.soldTickets.push({
          runningId: raffleState.runningId,
          raffleId: raffleState.raffleId,
          ownerId,
          number: ticketNumber,
        });
      }
      raffleState.soldTickets.sort((left, right) => left.number - right.number);
      raffleState.pendingIsk = raffleState.ticketPrice * raffleState.soldTickets.length;
      saga.phase = "tickets";
      this._persistRaffleSettlementBoundary(raffleState);
    }

    const justFinished = raffleState.soldTickets.length >= raffleState.ticketCount;
    if (saga.phase === "tickets" && justFinished) {
      await this._finishRaffle(raffleState);
    }
    raffleState.purchaseSaga = null;
    this._persistRaffleSettlementBoundary(raffleState);

    const raffleData = buildRaffleValue(raffleState);
    if (options.notify === false) {
      return raffleData;
    }
    const session = options.session || null;
    const recipientSessions = this._state.subscriptions.getInterestedSessions(
      raffleState,
      { includeSession: session },
    );
    notifyTicketsUpdated(
      recipientSessions,
      raffleState.raffleId,
      raffleState.soldTickets.length,
    );
    notifyRaffleUpdated(recipientSessions, raffleState.raffleId, raffleData);
    if (justFinished) {
      notifyRaffleFinished(
        recipientSessions,
        raffleState.raffleId,
        raffleState.winningTicket
          ? buildTicketValue(raffleState.winningTicket)
          : null,
      );
    }

    return raffleData;
  }

  async _finishRaffle(raffleState) {
    if (isFinishedStatus(raffleState.raffleStatus)) {
      return;
    }

    raffleState.winningTicket = pickWinningTicket(raffleState.soldTickets);
    raffleState.raffleStatus = raffleState.winningTicket
      ? RAFFLE_STATUS.FINISHED_UNDELIVERED
      : RAFFLE_STATUS.FINISHED_EXPIRED;
    raffleState.endDate = this._currentFileTime();
    this._persistRaffleSettlementBoundary(raffleState);

    if (raffleState.winningTicket) {
      if (await creditSellerIfNeeded(raffleState)) {
        this._persistRaffleSettlementBoundary(raffleState);
      }
    }
    this._scheduleExpiration(raffleState);
  }

  _getOwnedTickets(ownerId, raffleState) {
    return raffleState.soldTickets.filter((ticket) => (
      normalizeInteger(ticket && ticket.ownerId, 0) === normalizeInteger(ownerId, 0)
    ));
  }

  _getAvailableTicketNumbers(raffleState) {
    const availableTicketNumbers = [];
    for (let ticketNumber = 0; ticketNumber < raffleState.ticketCount; ticketNumber += 1) {
      const alreadySold = raffleState.soldTickets.some((ticket) => (
        normalizeInteger(ticket && ticket.number, -1) === ticketNumber
      ));
      if (!alreadySold) {
        availableTicketNumbers.push(ticketNumber);
      }
    }
    return availableTicketNumbers;
  }

  _requireRaffle(raffleId) {
    const raffleState = this._state.getRaffle(raffleId);
    if (!raffleState) {
      throwWrappedRaffleError("raffles.RaffleNotFoundError");
    }
    return raffleState;
  }

  _requireRunningRaffle(raffleId) {
    const raffleState = this._requireRaffle(raffleId);
    if (
      isFinishedStatus(raffleState.raffleStatus) ||
      isExpired(raffleState, this._currentFileTime())
    ) {
      throwWrappedRaffleError("raffles.TicketUnavailableError");
    }
    return raffleState;
  }
}

module.exports = RaffleRuntime;
module.exports.DURABLE_EXPIRY_JOB_TYPE = DURABLE_EXPIRY_JOB_TYPE;
module.exports.DURABLE_SETTLEMENT_JOB_TYPE = DURABLE_SETTLEMENT_JOB_TYPE;
module.exports.buildDurableRaffleExpiryJob = buildDurableRaffleExpiryJob;
module.exports.buildDurableRaffleSettlementJob = buildDurableRaffleSettlementJob;
