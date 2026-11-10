"use strict";

/**
 * RAISE A SETTLEMENT'S OPERATION COUNTER ABOVE EVERY SEQUENCE ITS RECEIPTS USE.
 *
 * A durable settlement keys its money legs with a commandID it mints itself:
 * `<domain>:<ownerID>:<sequence>:<leg>`, where <sequence> comes from a
 * nextOperationID counter kept in that settlement's own gameStore table. The
 * wallet authority keeps the matching receipts somewhere else entirely --
 * walletAuthorityState, on the owner record -- and answers a commandID it has
 * already seen with the result that commandID committed, without re-executing.
 *
 * That arrangement is only safe while the counter never repeats a sequence. The
 * two tables have no shared lifetime, so anything that rewinds one without
 * clearing the other breaks it: a store reset, a migration, a settlement table
 * restored from a different point in time than the character records, or a test
 * install seeded with characters carried over from another one. The counter then
 * walks straight back over sequences whose receipts still exist, and every
 * operation it mints inherits an unrelated operation's committed result.
 *
 * What that costs is not theoretical. A collision on an install debit is
 * reported as success, so the settlement records the charge as applied and
 * completes the job -- free -- while the client is handed the balance the other
 * operation left behind. executeIdempotently logs a WARN and returns the cached
 * result deliberately (throwing wedges a legitimate replay forever); this pass
 * is the other half of that bargain, the part that stops the collision being
 * mintable in the first place.
 *
 * The pass only ever raises the counter, so a healthy store is a no-op, and it
 * is safe to run on every boot. It cannot lower one: a counter already ahead of
 * every receipt is left exactly where it is.
 *
 * Generalized from missionRewardSettlementRecovery.advanceMissionSequenceWatermark,
 * which still owns the mission-reward copy because it also folds in LP wallet
 * receipt keys and runs inside a wider heal.
 *
 * ON EVICTION: a receipt list is capped and drops its oldest entries, so a
 * sequence can age out of it. That is harmless here and in the safe direction --
 * an evicted receipt cannot be collided with, because there is nothing left to
 * match the commandID against.
 *
 * ON FAILURE: this runs at the top of startup reconciliation, inside
 * productionSchedulerRuntime.start(), and a rejection there exits the server.
 * A counter that cannot be checked is worth an error line, not a server that
 * will not boot, so nothing thrown here escapes. The mission reward startup
 * heal takes the same stance for the same reason.
 *
 * ON COST: reading the ledger means reading and copying all of
 * walletAuthorityState, journals included, which grows with every character on
 * the server. Each settlement therefore registers its commandID domain once, at
 * load, and startup reconciliation shares one createAuthorityReceiptScan() across
 * every settlement it reconciles, so the ledger is read once per boot rather than
 * once per settlement.
 */

const path = require("node:path");

const log = require(path.join(__dirname, "../../utils/logger"));
const walletAuthorityOwnerState = require(path.join(
  __dirname,
  "../account/walletAuthorityOwnerState",
));

// commandID domain -> the pattern that reads its sequence. The domain is the text
// before a commandID's first colon, so one pass files each commandID under its
// own settlement instead of trying every pattern against it.
const sequenceDomains = new Map();

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * Declare the commandIDs a settlement mints. Call once at module load.
 *
 * @param {string} domain           The commandID prefix, without its colon.
 * @param {RegExp} sequencePattern  Anchored at `^<domain>:`, with the sequence as its one capture group.
 * @returns {string} The domain, for the settlement to pass back to the pass.
 */
function registerSettlementSequenceDomain(domain, sequencePattern) {
  const name = String(domain || "");
  if (
    !name ||
    name.includes(":") ||
    !(sequencePattern instanceof RegExp) ||
    !sequencePattern.source.startsWith(`^${name}:`)
  ) {
    throw new TypeError(
      `settlement sequence domain "${name}" needs a pattern anchored at "^${name}:"`,
    );
  }
  sequenceDomains.set(name, sequencePattern);
  return name;
}

function requireSequencePattern(domain) {
  const pattern = sequenceDomains.get(domain);
  if (!pattern) {
    throw new TypeError(`settlement sequence domain "${domain}" is not registered`);
  }
  return pattern;
}

/** Every authority receipt commandID on file, character and corporation alike. */
function* iterateAuthorityCommandIDs() {
  for (const record of walletAuthorityOwnerState.listOwnedRecords()) {
    const characterReceipts = Array.isArray(record && record.walletAuthorityReceipts)
      ? record.walletAuthorityReceipts
      : [];
    for (const receipt of characterReceipts) {
      yield receipt && receipt.commandID;
    }
    // A settlement whose payer is a corporation books its receipt on the
    // corporation record even though the commandID still names the acting
    // character, so both lists have to be read to find the true high-water mark.
    const corporationReceipts = record && record.wallet &&
      Array.isArray(record.wallet.authorityReceipts)
      ? record.wallet.authorityReceipts
      : [];
    for (const receipt of corporationReceipts) {
      yield receipt && receipt.commandID;
    }
  }
}

/** One pass over the ledger: the highest receipt sequence for each domain given. */
function scanReceiptWatermarks(patternsByDomain) {
  const watermarks = new Map(
    [...patternsByDomain.keys()].map((domain) => [domain, 0]),
  );
  for (const commandID of iterateAuthorityCommandIDs()) {
    const text = String(commandID || "");
    const colon = text.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const domain = text.slice(0, colon);
    const pattern = patternsByDomain.get(domain);
    const match = pattern ? pattern.exec(text) : null;
    if (match) {
      watermarks.set(
        domain,
        Math.max(watermarks.get(domain), toPositiveInt(match[1], 0)),
      );
    }
  }
  return watermarks;
}

/**
 * One read of the receipt ledger, shared by every settlement reconciled in the
 * same startup pass.
 *
 * The read is lazy. The first settlement to ask pays for it, covering every
 * domain registered by then, and the rest look their answer up. A domain
 * registered after that read is not guessed at: it gets a read of its own.
 *
 * A scan is a snapshot of the ledger at its first use. Make one per startup pass
 * and let it go.
 */
function createAuthorityReceiptScan() {
  let watermarks = null;
  return Object.freeze({
    watermarkFor(domain) {
      if (!watermarks) {
        requireSequencePattern(domain);
        watermarks = scanReceiptWatermarks(new Map(sequenceDomains));
      }
      if (!watermarks.has(domain)) {
        const late = scanReceiptWatermarks(
          new Map([[domain, requireSequencePattern(domain)]]),
        );
        watermarks.set(domain, late.get(domain));
      }
      return watermarks.get(domain);
    },
  });
}

function advanceWatermark({
  logTag,
  counterName,
  domain,
  readCounter,
  writeCounter,
  pendingSequences,
  receiptScan,
}) {
  let watermark = receiptScan
    ? receiptScan.watermarkFor(domain)
    : scanReceiptWatermarks(
      new Map([[domain, requireSequencePattern(domain)]]),
    ).get(domain);
  if (typeof pendingSequences === "function") {
    for (const sequence of pendingSequences() || []) {
      watermark = Math.max(watermark, toPositiveInt(sequence, 0));
    }
  }

  const current = toPositiveInt(readCounter(), 1);
  const required = watermark + 1;
  if (!watermark || current >= required) {
    return { advanced: false, from: current, to: current, watermark };
  }

  const result = writeCounter(required);
  if (!result || result.success !== true) {
    log.warn(
      `${logTag} could not advance ${counterName} from ${current} to ${required}: ` +
        `${(result && result.errorMsg) || "WRITE_FAILED"}. New operations will mint ` +
        `commandIDs that already have wallet authority receipts, and each one will ` +
        `be answered with an unrelated operation's committed result`,
    );
    return { advanced: false, from: current, to: current, watermark };
  }

  log.warn(
    `${logTag} ${counterName} advanced ${current} -> ${required}: wallet authority ` +
      `receipts already reference sequence ${watermark}, so the counter had been ` +
      `rewound. Operations minted between ${current} and ${watermark} would have ` +
      `been answered from an older operation's receipt instead of moving any money`,
  );
  return { advanced: true, from: current, to: required, watermark };
}

/**
 * @param {object} spec
 * @param {string} spec.logTag            Prefix for the warning, e.g. "[IndustryInstallSettlement]".
 * @param {string} spec.counterName       Field name, for the message only.
 * @param {string} spec.domain            Registered with registerSettlementSequenceDomain.
 * @param {() => number} spec.readCounter
 * @param {(required: number) => {success: boolean, errorMsg?: string}} spec.writeCounter
 * @param {() => number[]} [spec.pendingSequences] Sequences held by settlements still in flight.
 * @param {{watermarkFor: (domain: string) => number}} [spec.receiptScan]
 *   A scan shared across one startup pass. Without one, this pass reads the
 *   ledger itself.
 */
function advanceSettlementSequenceWatermark(spec) {
  try {
    return advanceWatermark(spec);
  } catch (error) {
    log.err(
      `${spec && spec.logTag} could not check ${spec && spec.counterName} against ` +
        `the wallet authority receipt ledger, so it was left unchanged and startup ` +
        `continues: ${(error && error.stack) || error}. If the counter had been ` +
        `rewound, new operations will be answered from older operations' receipts ` +
        `until this pass succeeds on a later boot`,
    );
    return {
      advanced: false,
      error: (error && error.message) || String(error),
    };
  }
}

module.exports = {
  advanceSettlementSequenceWatermark,
  createAuthorityReceiptScan,
  registerSettlementSequenceDomain,
};
