#!/usr/bin/env node
"use strict";

/**
 * Import a player bundle (produced by exportPlayers.js) into a target gameStore.
 *
 * RUN WITH THE TARGET SERVER STOPPED. The server preloads every table into memory
 * once at startup and never re-reads SQLite at runtime, so writing the DB of a
 * running server would be invisible (and later clobbered by its cache flush). This
 * tool loads the gameStore module against the target data dir, allocates fresh ids
 * via the canonical identityAllocator, remaps every reference, merges into the
 * existing tables, flushes, and exits.
 *
 * Creation order per account: account row → character row → character data.
 *
 * Usage:
 *   EVEJS_GAMESTORE_DATA_DIR=/path/to/target/data \
 *     node src/gameStore/importPlayers.js --in bundle.json
 *   node src/gameStore/importPlayers.js --in bundle.json --target /path/to/target/data
 *   node src/gameStore/importPlayers.js --in bundle.json --on-conflict rename
 *   node src/gameStore/importPlayers.js --in bundle.json --dry-run
 *
 * --on-conflict skip (default) | rename | overwrite   (username already on target)
 * --rename-suffix <s>   suffix for rename mode (default "_imported")
 */

const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("node:util");

const shared = require("./playerTransferShared");

function parseArgs(argv) {
  const opts = {
    in: null,
    target: null,
    onConflict: "skip",
    renameSuffix: "_imported",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--in":
        opts.in = next();
        break;
      case "--target":
        opts.target = next();
        break;
      case "--on-conflict":
        opts.onConflict = String(next() || "skip");
        break;
      case "--rename-suffix":
        opts.renameSuffix = String(next() || "_imported");
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      "Import a player bundle into a STOPPED target server's gameStore.",
      "",
      "Usage:",
      "  node src/gameStore/importPlayers.js --in bundle.json [options]",
      "",
      "Options:",
      "  --in <file>             bundle produced by exportPlayers.js (required)",
      "  --target <dataDir>      target gameStore data dir (else $EVEJS_GAMESTORE_DATA_DIR)",
      "  --on-conflict <mode>    skip (default) | rename | overwrite  (username exists)",
      "  --rename-suffix <s>     suffix used by rename mode (default _imported)",
      "  --dry-run               report planned work; no allocation, no writes",
    ].join("\n"),
  );
}

function requireSuccess(result, operation) {
  if (!result || result.success !== true) {
    const error = new Error(
      `${operation} failed: ${result && (
        result.errorMsg || result.code
      ) || "unknown error"}`,
    );
    error.code = result && (result.code || result.errorMsg) ||
      "GAMESTORE_MAINTENANCE_OPERATION_FAILED";
    throw error;
  }
  return result;
}

async function checkedShutdown(database, reason) {
  const shutdown = await database.shutdown(reason);
  return requireSuccess(shutdown, "GameStore shutdown");
}

function verifyDurableTables(database, expectedByTable) {
  for (const [name, expected] of expectedByTable) {
    if (!database._sqliteTables.has(name)) continue;
    const persisted = requireSuccess(
      database.readPersisted(name, "/"),
      `durable verification for ${name}`,
    );
    if (!isDeepStrictEqual(persisted.data, expected)) {
      const error = new Error(
        `durable verification for ${name} did not match the imported cache`,
      );
      error.code = "GAMESTORE_DURABLE_VERIFICATION_FAILED";
      error.table = name;
      throw error;
    }
  }
}

function requirePlainTableRoot(value, tableName, sourceLabel) {
  const prototype = value && typeof value === "object"
    ? Object.getPrototypeOf(value)
    : null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    const error = new Error(
      `${sourceLabel} ${tableName} table must contain a plain object`,
    );
    error.code = "GAMESTORE_TABLE_ROOT_INVALID";
    error.table = tableName;
    throw error;
  }
  return value;
}

function readLegacyTableRoot(database, tableName) {
  const filePath = path.join(database._dataDir, tableName, "data.json");
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    throw new Error(`Legacy ${tableName} table is empty: ${filePath}`);
  }
  return requirePlainTableRoot(
    JSON.parse(raw),
    tableName,
    `Legacy file ${filePath}`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.in) {
    printHelp();
    console.error("\nError: --in <bundle> is required.");
    process.exitCode = 1;
    return;
  }

  // Point the gameStore at the target BEFORE requiring it (it resolves DATA_DIR
  // and opens the SQLite file at require time).
  if (opts.target) {
    process.env.EVEJS_GAMESTORE_DATA_DIR = path.resolve(opts.target);
  }
  process.env.EVEJS_GAMESTORE_OWNER_ROLE = opts.dryRun
    ? "reader"
    : "maintenance";

  const bundlePath = path.resolve(opts.in);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  if (shared.toPositiveInt(bundle.bundleVersion, 0) !== shared.BUNDLE_VERSION) {
    console.error(
      `Bundle version ${bundle.bundleVersion} != expected ${shared.BUNDLE_VERSION}`,
    );
    process.exitCode = 1;
    return;
  }

  let database = null;
  let failure = null;
  try {
    database = require("./index");
    const sqliteSourceExisted = fs.existsSync(database._sqliteDbPath);
    if (!opts.dryRun) {
      database.acquirePersistenceOwnerLease({ recover: true });
    }
    const allocator = opts.dryRun
      ? null
      : require("../services/_shared/identityAllocator");
    console.log(`Target SQLite: ${database._sqliteDbPath}`);

    // ── table cache: read each touched table's live object once, write at end ──
    const touched = {};
    function table(name) {
      if (!touched[name]) {
        if (opts.dryRun && !sqliteSourceExisted) {
          touched[name] = readLegacyTableRoot(database, name);
        } else {
          const result = requireSuccess(
            database.read(name, "/"),
            `read ${name}`,
          );
          touched[name] = requirePlainTableRoot(
            result.data,
            name,
            "SQLite",
          );
        }
      }
      return touched[name];
    }

    // global-id counters (mail messages / notifications) seeded from the target
    let messageCounter = null;
    function nextMessageID() {
      if (messageCounter === null) {
        const messages = (table("mail").messages) || {};
        messageCounter = Math.max(0, ...Object.keys(messages).map((k) => shared.toPositiveInt(k, 0)));
      }
      messageCounter += 1;
      return messageCounter;
    }
    let notifCounter = null;
    function nextNotificationID() {
      if (notifCounter === null) {
        let max = 0;
        const boxes = (table("notifications").boxes) || {};
        for (const box of Object.values(boxes)) {
          for (const nid of Object.keys((box && box.byID) || {})) {
            max = Math.max(max, shared.toPositiveInt(nid, 0));
          }
        }
        notifCounter = max;
      }
      notifCounter += 1;
      return notifCounter;
    }

    const summary = { accounts: 0, characters: 0, items: 0, skipped: [] };

    for (const acctEntry of bundle.accounts || []) {
      const result = importAccount(acctEntry, {
        opts,
        database,
        allocator,
        table,
        nextMessageID,
        nextNotificationID,
        summary,
      });
      if (result.skipped) {
        summary.skipped.push(`${acctEntry.username} (${result.reason})`);
      }
    }

    if (opts.dryRun) {
      console.log("\n[dry-run] no changes written.");
    } else {
      const touchedTables = Object.keys(touched);
      const expectedByTable = new Map();
      for (const name of touchedTables) {
        requireSuccess(
          database.write(name, "/", touched[name], { force: true }),
          `write ${name}`,
        );
        expectedByTable.set(name, touched[name]);
      }
      if (summary.accounts > 0) {
        const identity = requireSuccess(
          database.read("identityState", "/"),
          "read identityState",
        );
        if (!touchedTables.includes("identityState")) {
          touchedTables.push("identityState");
        }
        expectedByTable.set("identityState", identity.data);
      }
      requireSuccess(
        database.flushTablesSync(touchedTables),
        "flush imported player tables",
      );
      verifyDurableTables(database, expectedByTable);

      console.log(
        `\nImported ${summary.accounts} account(s), ${summary.characters} character(s), ` +
          `${summary.items} item(s). Flushed ${touchedTables.length} table(s).`,
      );
      if (summary.skipped.length) {
        console.log(`Skipped: ${summary.skipped.join(", ")}`);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (database) {
      try {
        await checkedShutdown(database, "player-import");
      } catch (shutdownError) {
        if (failure) {
          const combined = new Error(
            `${failure.message}; GameStore shutdown also failed: ${shutdownError.message}`,
            { cause: failure },
          );
          combined.code = failure.code || shutdownError.code;
          combined.shutdownError = shutdownError;
          failure = combined;
        } else {
          failure = shutdownError;
        }
      }
    }
  }
  if (failure) throw failure;
}

function importAccount(acctEntry, ctx) {
  const { opts, allocator, table, summary } = ctx;
  const accountsObj = table("accounts");
  let username = acctEntry.username;

  if (Object.prototype.hasOwnProperty.call(accountsObj, username)) {
    if (opts.onConflict === "skip") {
      console.log(`  - skip "${username}" (username exists on target)`);
      return { skipped: true, reason: "username exists" };
    }
    if (opts.onConflict === "rename") {
      let candidate = `${username}${opts.renameSuffix}`;
      let n = 2;
      while (Object.prototype.hasOwnProperty.call(accountsObj, candidate)) {
        candidate = `${username}${opts.renameSuffix}${n}`;
        n += 1;
      }
      console.log(`  ~ rename "${username}" -> "${candidate}" (conflict)`);
      username = candidate;
    } else if (opts.onConflict === "overwrite") {
      console.log(`  ! overwrite "${username}" (conflict)`);
    }
  }

  if (opts.dryRun) {
    console.log(
      `  [dry-run] account "${username}" + ${acctEntry.characters.length} char(s)`,
    );
    return { skipped: false };
  }

  const newAccountID = allocator.reserveAccountID();
  accountsObj[username] = { ...acctEntry.account, id: newAccountID };
  summary.accounts += 1;
  console.log(`  + account "${username}" (new id ${newAccountID})`);

  for (const charEntry of acctEntry.characters) {
    importCharacter(charEntry, newAccountID, ctx);
  }
  return { skipped: false };
}

function importCharacter(charEntry, newAccountID, ctx) {
  const { allocator, table, nextMessageID, nextNotificationID, summary } = ctx;
  const oldCharID = shared.toPositiveInt(charEntry.originalCharacterID, 0);
  const newCharID = allocator.reserveCharacterID();

  // item id map (only this character's own items get remapped)
  const oldItemIDs = (charEntry.items || []).map((it) => shared.toPositiveInt(it.itemID, 0));
  const newItemIDs = oldItemIDs.length ? allocator.reserveItemIDs(oldItemIDs.length) : [];
  const itemMap = new Map(oldItemIDs.map((id, i) => [id, newItemIDs[i]]));
  const remapItemRef = (v) => (itemMap.has(v) ? itemMap.get(v) : v);
  const remapCharRef = (v) => (shared.toPositiveInt(v, 0) === oldCharID ? newCharID : v);

  // ── character record ──────────────────────────────────────────────────
  const rec = charEntry.record;
  rec.accountId = newAccountID;
  rec.shipID = remapItemRef(shared.toPositiveInt(rec.shipID, 0)) || rec.shipID;
  if (Array.isArray(rec.storedShips)) {
    for (const s of rec.storedShips) {
      if (s && s.itemID != null) s.itemID = remapItemRef(shared.toPositiveInt(s.itemID, 0));
    }
  }
  remapStandings(rec, remapCharRef);
  remapWalletSelfRefs(rec, oldCharID, newCharID);
  table("characters")[newCharID] = rec;
  summary.characters += 1;

  // ── items ─────────────────────────────────────────────────────────────
  const itemsObj = table("items");
  for (const item of charEntry.items || []) {
    const newID = itemMap.get(shared.toPositiveInt(item.itemID, 0));
    item.itemID = newID;
    item.ownerID = remapCharRef(item.ownerID);
    item.locationID = remapItemRef(shared.toPositiveInt(item.locationID, 0)) || item.locationID;
    if (item.shipID != null) item.shipID = remapItemRef(shared.toPositiveInt(item.shipID, 0));
    itemsObj[newID] = item;
    summary.items += 1;
  }

  // ── skills (itemIDs regenerated deterministically) ──────────────────────
  if (charEntry.skills && typeof charEntry.skills === "object") {
    const skillsObj = table("skills");
    const newSkillMap = {};
    for (const [typeID, sk] of Object.entries(charEntry.skills)) {
      sk.ownerID = newCharID;
      sk.locationID = newCharID;
      sk.itemID = shared.buildSkillItemID(newCharID, sk.typeID != null ? sk.typeID : typeID);
      newSkillMap[typeID] = sk;
    }
    skillsObj[newCharID] = newSkillMap;
  }

  // ── simple per-character tables ─────────────────────────────────────────
  for (const { table: tname, group } of shared.SIMPLE_CHAR_TABLES) {
    const value = charEntry.simple && charEntry.simple[tname];
    if (value == null) continue;
    for (const f of shared.CHARID_FIELDS) {
      if (shared.toPositiveInt(value[f], 0) === oldCharID) value[f] = newCharID;
    }
    const obj = table(tname);
    if (group) {
      if (!obj[group] || typeof obj[group] !== "object") obj[group] = {};
      obj[group][newCharID] = value;
    } else {
      obj[newCharID] = value;
    }
  }

  // ── mail (allocate fresh message ids) ───────────────────────────────────
  const msgIdMap = new Map();
  if (charEntry.mail) {
    const mailObj = table("mail");
    if (!mailObj.messages || typeof mailObj.messages !== "object") mailObj.messages = {};
    if (!mailObj.mailboxes || typeof mailObj.mailboxes !== "object") mailObj.mailboxes = {};
    for (const msg of charEntry.mail.messages || []) {
      const newMid = nextMessageID();
      msgIdMap.set(shared.toPositiveInt(msg.messageID, 0), newMid);
      msg.messageID = newMid;
      if (Array.isArray(msg.toCharacterIDs)) {
        msg.toCharacterIDs = msg.toCharacterIDs.map((id) => remapCharRef(id));
      }
      msg.senderID = remapCharRef(msg.senderID);
      mailObj.messages[newMid] = msg;
    }
    if (charEntry.mail.mailbox) {
      const box = charEntry.mail.mailbox;
      if (box.statuses && typeof box.statuses === "object") {
        const newStatuses = {};
        for (const [mid, st] of Object.entries(box.statuses)) {
          const nm = msgIdMap.get(shared.toPositiveInt(mid, 0));
          if (nm) {
            st.messageID = nm;
            newStatuses[nm] = st;
          } else {
            newStatuses[mid] = st; // message not carried; leave status as-is
          }
        }
        box.statuses = newStatuses;
      }
      mailObj.mailboxes[newCharID] = box;
    }
  }

  // ── notifications (allocate fresh notification ids) ─────────────────────
  if (charEntry.notifications && charEntry.notifications.box) {
    const notifObj = table("notifications");
    if (!notifObj.boxes || typeof notifObj.boxes !== "object") notifObj.boxes = {};
    const box = charEntry.notifications.box;
    const newByID = {};
    const nidMap = new Map();
    for (const [nid, n] of Object.entries(box.byID || {})) {
      const newNid = nextNotificationID();
      nidMap.set(shared.toPositiveInt(nid, 0), newNid);
      n.notificationID = newNid;
      n.receiverID = remapCharRef(n.receiverID);
      n.senderID = remapCharRef(n.senderID);
      if (n.data && n.data.msg) {
        const m = n.data.msg;
        if (msgIdMap.has(shared.toPositiveInt(m.messageID, 0))) {
          m.messageID = msgIdMap.get(shared.toPositiveInt(m.messageID, 0));
        }
        if (Array.isArray(m.toCharacterIDs)) {
          m.toCharacterIDs = m.toCharacterIDs.map((id) => remapCharRef(id));
        }
        m.senderID = remapCharRef(m.senderID);
      }
      newByID[newNid] = n;
    }
    box.byID = newByID;
    if (Array.isArray(box.order)) {
      box.order = box.order.map((o) => nidMap.get(shared.toPositiveInt(o, 0)) || o);
    }
    notifObj.boxes[newCharID] = box;
  }

  console.log(
    `      char "${charEntry.characterName}" ${oldCharID} -> ${newCharID} ` +
      `(${(charEntry.items || []).length} items, ${charEntry.skills ? Object.keys(charEntry.skills).length : 0} skills)`,
  );
}

function remapStandings(rec, remapCharRef) {
  const sd = rec.standingData;
  if (!sd || typeof sd !== "object") return;
  for (const bucket of ["char", "corp", "npc"]) {
    if (!Array.isArray(sd[bucket])) continue;
    for (const entry of sd[bucket]) {
      if (!entry) continue;
      entry.fromID = remapCharRef(entry.fromID);
      entry.toID = remapCharRef(entry.toID);
    }
  }
}

function remapWalletSelfRefs(rec, oldCharID, newCharID) {
  const remap = (v) => (shared.toPositiveInt(v, 0) === oldCharID ? newCharID : v);
  for (const j of Array.isArray(rec.walletJournal) ? rec.walletJournal : []) {
    if (!j) continue;
    j.ownerID1 = remap(j.ownerID1);
    j.ownerID2 = remap(j.ownerID2);
    j.referenceID = remap(j.referenceID);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
