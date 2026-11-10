"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  BILL_TYPE_WAR,
  createBill,
  getBillRecord,
} = require(path.join(__dirname, "../account/billRuntimeState"));
const {
  createInheritedWarRecord,
  getWarRecord,
  listAllWars,
  updateWarRecord,
} = require(path.join(__dirname, "./warRuntimeState"));
const warNotificationCenter = require(path.join(
  __dirname,
  "./warNotificationCenter",
));

const PLAN_SCHEMA_VERSION = 1;
const CONCORD_CORPORATION_ID = 1000125;
const WAR_BILL_AMOUNT = 100000000;
const FILETIME_TICKS_PER_DAY = 864000000000n;
const FILETIME_TICKS_PER_WEEK = FILETIME_TICKS_PER_DAY * 7n;

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeFiletime(value, fallback = 0n) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  try {
    return BigInt(String(value));
  } catch (_error) {
    return fallback;
  }
}

function isMutual(war) {
  return Boolean(Number(war && war.mutual || 0));
}

function isPrincipalAllianceWar(war, allianceID) {
  return Boolean(
    war &&
    (Number(war.declaredByID) === allianceID ||
      Number(war.againstID) === allianceID),
  );
}

function isActiveAt(war, now) {
  const declared = normalizeFiletime(war && war.timeDeclared, 0n);
  const finished = normalizeFiletime(war && war.timeFinished, 0n);
  // Include the 24-hour warmup and cooldown. Both are still live war rows and
  // CCP's war-notification guidance says a copied war keeps the same dates.
  return declared <= now && (finished === 0n || finished > now);
}

function getCurrentPaidCycleBoundary(war, now) {
  if (isMutual(war)) {
    return { cycleEndFiletime: null, inferred: false, bill: null };
  }
  const billID = normalizePositiveInteger(war && war.billID, null);
  const bill = billID ? getBillRecord(billID) : null;
  const dueAt = normalizeFiletime(bill && bill.dueDateTime, 0n);
  if (dueAt >= now && dueAt > 0n) {
    return {
      cycleEndFiletime: dueAt.toString(),
      inferred: false,
      bill: cloneValue(bill),
    };
  }
  const explicitFinish = normalizeFiletime(war && war.timeFinished, 0n);
  if (explicitFinish > now) {
    return {
      cycleEndFiletime: explicitFinish.toString(),
      inferred: false,
      bill: null,
    };
  }
  // Historical/imported rows can lack the live CONCORD bill that defines the
  // paid-cycle boundary. Keeping combat for one cycle is safer than silently
  // creating a permanent inherited war; this fallback needs a TQ golden.
  const declaredAt = normalizeFiletime(war && war.timeDeclared, 0n);
  const elapsed = declaredAt > 0n && now > declaredAt
    ? now - declaredAt
    : 0n;
  const inferredBoundary = declaredAt > 0n
    ? declaredAt + (elapsed / FILETIME_TICKS_PER_WEEK + 1n) *
      FILETIME_TICKS_PER_WEEK
    : now + FILETIME_TICKS_PER_WEEK;
  return {
    cycleEndFiletime: inferredBoundary.toString(),
    inferred: true,
    bill: null,
  };
}

function buildAllianceWarInheritancePlan(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  const corporationID = normalizePositiveInteger(options.corporationID, null);
  const now = normalizeFiletime(options.nowFiletime, 0n);
  if (!allianceID || !corporationID || now <= 0n) {
    throw new TypeError(
      "allianceID, corporationID and nowFiletime are required",
    );
  }

  const principalWars = [];
  const alliedWars = [];
  for (const war of listAllWars()) {
    if (!isActiveAt(war, now)) {
      continue;
    }
    if (isPrincipalAllianceWar(war, allianceID)) {
      const cycle = getCurrentPaidCycleBoundary(war, now);
      principalWars.push({
        sourceWarID: Number(war.warID),
        sourceWar: cloneValue(war),
        expectedDeclaredByID: Number(war.declaredByID),
        expectedAgainstID: Number(war.againstID),
        expectedTimeDeclared: String(war.timeDeclared),
        expectedTimeStarted: String(war.timeStarted),
        expectedTimeFinished: war.timeFinished
          ? String(war.timeFinished)
          : null,
        expectedMutual: isMutual(war),
        cycleEndFiletime: cycle.cycleEndFiletime,
        cycleEndInferred: cycle.inferred,
        sourceBillID: normalizePositiveInteger(war.billID, null),
      });
      continue;
    }
    const allianceAlly = war && war.allies && war.allies[String(allianceID)];
    if (allianceAlly && isActiveAt(allianceAlly, now)) {
      alliedWars.push({
        sourceWarID: Number(war.warID),
        expectedAllyStarted: String(allianceAlly.timeStarted || "0"),
        expectedAllyFinished: allianceAlly.timeFinished
          ? String(allianceAlly.timeFinished)
          : null,
      });
    }
  }
  principalWars.sort((left, right) => left.sourceWarID - right.sourceWarID);
  alliedWars.sort((left, right) => left.sourceWarID - right.sourceWarID);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    allianceID,
    corporationID,
    builtAtFiletime: now.toString(),
    principalWars,
    alliedWars,
  };
}

function validatePlan(plan, allianceID, corporationID) {
  if (!plan || Number(plan.schemaVersion) !== PLAN_SCHEMA_VERSION) {
    return "WAR_INHERITANCE_PLAN_INVALID";
  }
  if (
    Number(plan.allianceID) !== allianceID ||
    Number(plan.corporationID) !== corporationID
  ) {
    return "WAR_INHERITANCE_PLAN_OWNER_MISMATCH";
  }
  if (!Array.isArray(plan.principalWars) || !Array.isArray(plan.alliedWars)) {
    return "WAR_INHERITANCE_PLAN_ROWS_INVALID";
  }
  return null;
}

function sourceMatchesPlan(source, row) {
  return Boolean(
    source &&
    Number(source.declaredByID) === Number(row.expectedDeclaredByID) &&
    Number(source.againstID) === Number(row.expectedAgainstID) &&
    String(source.timeDeclared) === String(row.expectedTimeDeclared) &&
    String(source.timeStarted) === String(row.expectedTimeStarted) &&
    (source.timeFinished ? String(source.timeFinished) : null) ===
      (row.expectedTimeFinished ? String(row.expectedTimeFinished) : null) &&
    isMutual(source) === Boolean(row.expectedMutual)
  );
}

function plannedSourceWar(row) {
  const source = row && row.sourceWar;
  if (
    !source ||
    Number(source.warID) !== Number(row.sourceWarID) ||
    !sourceMatchesPlan(source, row)
  ) {
    return null;
  }
  return cloneValue(source);
}

function attachIndependentBill({
  operationID,
  sourceWar,
  inheritedWar,
  cycleEndFiletime,
}) {
  if (isMutual(inheritedWar) || inheritedWar.timeFinished) {
    return { success: true, bill: null, war: inheritedWar };
  }
  const linkedBillID = normalizePositiveInteger(inheritedWar.billID, null);
  if (linkedBillID) {
    return {
      success: true,
      bill: getBillRecord(linkedBillID),
      war: inheritedWar,
    };
  }
  const bill = createBill({
    billTypeID: BILL_TYPE_WAR,
    amount: WAR_BILL_AMOUNT,
    debtorID: inheritedWar.declaredByID,
    creditorID: CONCORD_CORPORATION_ID,
    dueDateTime: cycleEndFiletime,
    externalID: inheritedWar.againstID,
    externalID2: inheritedWar.warID,
    emitBillReceived: false,
    creationKey: `${operationID}:inherited-war:${sourceWar.warID}:bill`,
  });
  if (!bill) {
    return { success: false, errorMsg: "INHERITED_WAR_BILL_FAILED" };
  }
  const nextWar = updateWarRecord(inheritedWar.warID, (record) => ({
    ...record,
    billID: bill.billID,
  }));
  return nextWar
    ? { success: true, bill, war: nextWar }
    : { success: false, errorMsg: "INHERITED_WAR_BILL_LINK_FAILED" };
}

function inheritAllianceWarsForCorporation(options = {}) {
  const operationID = String(options.operationID || "").trim();
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  const corporationID = normalizePositiveInteger(options.corporationID, null);
  const now = normalizeFiletime(options.nowFiletime, 0n);
  if (!operationID || !allianceID || !corporationID || now <= 0n) {
    return { success: false, errorMsg: "INVALID_WAR_INHERITANCE_REQUEST" };
  }
  const planError = validatePlan(options.plan, allianceID, corporationID);
  if (planError) {
    return { success: false, errorMsg: planError };
  }

  const inheritedWarIDs = [];
  const inheritedAllyWarIDs = [];
  const staleWarIDs = [];
  const inferredCycleWarIDs = [];
  for (const row of options.plan.principalWars) {
    // The departure instant, not a later recovery attempt, decides which wars
    // are inherited. Use the durable source snapshot so a source war ending
    // after the corporation left cannot erase an obligation on replay.
    const source = plannedSourceWar(row);
    if (!source) {
      staleWarIDs.push(Number(row.sourceWarID));
      continue;
    }
    const mutual = isMutual(source);
    const postDepartureWarEligible = options.postDepartureWarEligible !== false;
    let inheritedFinish = source.timeFinished || null;
    if (!mutual && !postDepartureWarEligible && !source.timeFinished) {
      const fightingLegalAt = normalizeFiletime(source.timeStarted, now);
      inheritedFinish = (
        (fightingLegalAt > now ? fightingLegalAt : now) +
        FILETIME_TICKS_PER_DAY
      ).toString();
    } else if (!mutual && !source.timeFinished && row.cycleEndInferred) {
      inheritedFinish = String(row.cycleEndFiletime);
      inferredCycleWarIDs.push(Number(source.warID));
    }
    const created = createInheritedWarRecord({
      operationID,
      sourceWar: source,
      allianceID,
      corporationID,
      timeFinished: inheritedFinish,
    });
    if (!created || created.success !== true) {
      return created || { success: false, errorMsg: "INHERITED_WAR_FAILED" };
    }
    const createdFlush = database.flushTableSync("corporationRuntime");
    if (!createdFlush || createdFlush.success !== true) {
      return createdFlush || {
        success: false,
        errorMsg: "INHERITED_WAR_FLUSH_FAILED",
      };
    }
    let inheritedWar = created.data.war;
    if (
      !mutual &&
      postDepartureWarEligible &&
      !source.timeFinished &&
      !row.cycleEndInferred
    ) {
      const billing = attachIndependentBill({
        operationID,
        sourceWar: source,
        inheritedWar,
        cycleEndFiletime: String(row.cycleEndFiletime),
      });
      if (!billing.success) {
        return billing;
      }
      inheritedWar = billing.war;
      const billingFlush = database.flushTablesSync([
        "corporationBills",
        "corporationRuntime",
      ]);
      if (!billingFlush || billingFlush.success !== true) {
        return billingFlush || {
          success: false,
          errorMsg: "INHERITED_WAR_BILL_FLUSH_FAILED",
        };
      }
    }
    warNotificationCenter.notifyWarInherited(inheritedWar, {
      allianceID,
      quitterID: corporationID,
      opponentID:
        Number(inheritedWar.declaredByID) === corporationID
          ? Number(inheritedWar.againstID)
          : Number(inheritedWar.declaredByID),
      idempotencyKeyPrefix:
        `${operationID}:inherited-war:${source.warID}:notice`,
    });
    inheritedWarIDs.push(Number(inheritedWar.warID));
  }

  for (const row of options.plan.alliedWars) {
    const source = getWarRecord(row.sourceWarID);
    const allianceAlly = source && source.allies && source.allies[String(allianceID)];
    if (
      !source ||
      !allianceAlly ||
      String(allianceAlly.timeStarted || "0") !== row.expectedAllyStarted ||
      (allianceAlly.timeFinished ? String(allianceAlly.timeFinished) : null) !==
        (row.expectedAllyFinished ? String(row.expectedAllyFinished) : null)
    ) {
      staleWarIDs.push(Number(row.sourceWarID));
      continue;
    }
    const existing = source.allies[String(corporationID)];
    if (!existing) {
      const updated = updateWarRecord(source.warID, (war) => {
        war.allies = war.allies && typeof war.allies === "object"
          ? war.allies
          : {};
        war.allies[String(corporationID)] = cloneValue(allianceAlly);
        return war;
      });
      if (!updated) {
        return { success: false, errorMsg: "INHERITED_ALLY_WAR_FAILED" };
      }
    }
    const latest = getWarRecord(source.warID);
    warNotificationCenter.notifyWarInherited(latest, {
      allianceID,
      quitterID: corporationID,
      opponentID: Number(source.declaredByID),
      isAlly: true,
      idempotencyKeyPrefix:
        `${operationID}:inherited-ally-war:${source.warID}:notice`,
    });
    inheritedAllyWarIDs.push(Number(source.warID));
  }

  const flush = database.flushTablesSync([
    "corporationRuntime",
    "corporationBills",
    "notifications",
  ]);
  if (!flush || flush.success !== true) {
    return flush || { success: false, errorMsg: "WAR_INHERITANCE_FLUSH_FAILED" };
  }
  return {
    success: true,
    data: {
      operationID,
      allianceID,
      corporationID,
      inheritedWarIDs,
      inheritedAllyWarIDs,
      staleWarIDs: [...new Set(staleWarIDs)].sort((a, b) => a - b),
      inferredCycleWarIDs,
    },
  };
}

function handleAllianceClosed(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  const now = normalizeFiletime(options.nowFiletime, 0n);
  if (!allianceID || now <= 0n) {
    return { success: false, errorMsg: "INVALID_ALLIANCE_CLOSURE_WARS" };
  }
  const endedWarIDs = [];
  for (const war of listAllWars()) {
    if (!isPrincipalAllianceWar(war, allianceID) || !isActiveAt(war, now)) {
      continue;
    }
    // Mutual wars are inherited by each departing corporation and then need to
    // be ended manually; the vanished alliance's source row cannot remain a
    // legal-combat principal. The regular lifecycle owns end-reason notices.
    const ended = require(path.join(__dirname, "./warRuntimeState"))
      .endWarWithReason(war.warID, {
        nowFiletime: now,
        endReason: 13,
      });
    if (ended) {
      endedWarIDs.push(Number(war.warID));
    }
  }
  const flush = database.flushTablesSync([
    "corporationRuntime",
    "notifications",
  ]);
  return flush && flush.success === true
    ? { success: true, data: { allianceID, endedWarIDs } }
    : flush || { success: false, errorMsg: "ALLIANCE_CLOSURE_WARS_FLUSH_FAILED" };
}

module.exports = {
  buildAllianceWarInheritancePlan,
  handleAllianceClosed,
  inheritAllianceWarsForCorporation,
  _testing: {
    FILETIME_TICKS_PER_DAY,
    FILETIME_TICKS_PER_WEEK,
  },
};
