#!/usr/bin/env node
"use strict";

const path = require("node:path");

const manager = require(path.resolve(
  __dirname,
  "../../server/src/contentPacks/contentPackManager",
));
const { syncStaticTables, describeSyncResult } = require(path.resolve(
  __dirname,
  "../../server/src/gameStore/syncStaticTables",
));

// Commands that build the effective dungeon authority, so they need the store's
// static tables to match the installed release. A carried-over store fails these
// two ways: a table the release added is missing
// (CONTENT_PACK_DUNGEON_BASE_UNAVAILABLE), or dungeonAuthority still holds
// templates the release moved into a pack (CONTENT_PACK_TEMPLATE_CONFLICT ...
// collides with client-dungeon:NNNN). Setup and the updater run these before the
// server ever gets a chance to reconcile the store itself.
const COMMANDS_NEEDING_A_COMPLETE_STORE = new Set([
  "install", "import", "remove", "rollback", "doctor",
]);

// Switches that stand alone. Everything else is --key value, so an unknown bare
// switch still fails loudly rather than swallowing the next argument.
const BOOLEAN_FLAGS = new Set(["replace", "dry-run"]);

function parseArguments(argv) {
  const args = [...argv];
  const command = String(args.shift() || "help").trim().toLowerCase();
  const options = { positional: [] };
  while (args.length > 0) {
    const token = args.shift();
    if (!token.startsWith("--")) {
      options.positional.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const key = token.slice(2, separator >= 0 ? separator : undefined);
    if (BOOLEAN_FLAGS.has(key)) {
      const raw = separator >= 0 ? token.slice(separator + 1).trim().toLowerCase() : "true";
      if (raw !== "true" && raw !== "false") {
        throw new Error(`--${key} takes true or false`);
      }
      options[key] = raw === "true";
      continue;
    }
    const value = separator >= 0 ? token.slice(separator + 1) : args.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    options[key] = value;
  }
  return { command, options };
}

const COMMAND_ARGUMENTS = Object.freeze({
  status: { options: ["store-root", "content-packs-dir"], positional: [] },
  verify: { options: ["pack", "store-root", "content-packs-dir"], positional: ["pack"] },
  install: {
    options: ["pack", "store-root", "content-packs-dir", "replace"],
    positional: ["pack"],
    flags: ["replace"],
  },
  import: {
    options: ["dir", "store-root", "content-packs-dir", "replace", "dry-run"],
    positional: ["dir"],
    flags: ["replace", "dry-run"],
  },
  remove: { options: ["id", "store-root", "content-packs-dir"], positional: ["id"] },
  rollback: {
    options: ["id", "version", "store-root", "content-packs-dir"],
    positional: ["id", "version"],
  },
  doctor: { options: ["store-root", "content-packs-dir"], positional: [] },
  help: { options: ["store-root", "content-packs-dir"], positional: [] },
  "--help": { options: ["store-root", "content-packs-dir"], positional: [] },
  "-h": { options: ["store-root", "content-packs-dir"], positional: [] },
});

function validateCommandArguments(command, options) {
  const contract = COMMAND_ARGUMENTS[command];
  if (!contract) {
    throw new Error(`Unknown command ${JSON.stringify(command)}`);
  }
  const allowed = new Set(contract.options);
  const unknown = Object.keys(options)
    .filter((key) => key !== "positional" && !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length === 1 ? "" : "s"} ` +
      unknown.map((key) => `--${key}`).join(", "),
    );
  }
  const namedPositionals = contract.positional.filter((key) => options[key]);
  if (options.positional.length > 0 && namedPositionals.length > 0) {
    throw new Error(`${command} cannot mix named and positional content arguments`);
  }
  if (options.positional.length > contract.positional.length) {
    throw new Error(
      `${command} received ${options.positional.length - contract.positional.length} extra argument(s)`,
    );
  }
}

function managerOptions(options) {
  const targetOptions = {};
  if (options["store-root"]) {
    const targetStoreRoot = path.resolve(options["store-root"]);
    targetOptions.contentPacksRoot = path.join(targetStoreRoot, "content-packs");
    targetOptions.dataDir = path.join(targetStoreRoot, "data");
  }
  if (options["content-packs-dir"]) {
    targetOptions.contentPacksRoot = path.resolve(options["content-packs-dir"]);
  }
  if (options.replace === true) {
    targetOptions.replaceExistingVersion = true;
  }
  if (options["dry-run"] === true) {
    targetOptions.dryRun = true;
  }
  return targetOptions;
}

function requiredValue(options, key, positionalIndex = -1) {
  const value = options[key] ||
    (positionalIndex >= 0 ? options.positional[positionalIndex] : null);
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return String(value);
}

function printHelp() {
  console.log(`EvEJS content packs (restart-only)

Usage:
  node tools/ContentPacks/index.js status [--store-root PATH]
  node tools/ContentPacks/index.js verify --pack PATH
  node tools/ContentPacks/index.js install --pack PATH [--replace] [--store-root PATH]
  node tools/ContentPacks/index.js import --dir PATH [--replace] [--dry-run] [--store-root PATH]
  node tools/ContentPacks/index.js remove --id PACK_ID [--store-root PATH]
  node tools/ContentPacks/index.js rollback --id PACK_ID --version X.Y.Z [--store-root PATH]
  node tools/ContentPacks/index.js doctor [--store-root PATH]

Installing a newer version of a pack that is already installed just works:
install and import both replace the active version and keep the old file for
rollback. Neither ever moves a pack to an older version: an older file is stored
for rollback and the newer version stays active. rollback is how to go back.
--replace is only for a corrected build carrying the SAME version
number, which is otherwise refused because pack versions are immutable. It
overwrites the stored file, so a later rollback to that version returns the new
content.

import walks one folder of *.json packs and installs each one. It is what
SetupEveJS.bat and UpdateEveJS.bat call, and it is safe to re-run.

Store selection:
  --store-root PATH         Use PATH/content-packs and PATH/data for preflight.
  --content-packs-dir PATH  Override only the managed content-pack directory.

The server reads installed packs once, when dungeon content is first loaded.
Stop the server before changing packs and restart it afterward. Pack files are
data-only JSON; JavaScript content packs are never executed.`);
}

// "Installed" is wrong for the common case of a pack that was already there at
// an older version, which is what most people are actually doing.
function describeInstallOutcome(result) {
  const coordinate = `${result.active.id}@${result.active.version}`;
  if (result.kept) {
    // An install never moves a pack to an older version; rollback does.
    return `Kept ${coordinate}, which is newer than ${result.stored.version}. ` +
      `${result.stored.version} is stored, so ` +
      `"rollback --id ${result.active.id} --version ${result.stored.version}" switches to it.`;
  }
  if (result.replacedSha256) {
    return `Replaced ${coordinate} with a different build of the same version.`;
  }
  if (!result.changed) {
    return `Already installed ${coordinate}.`;
  }
  if (result.previous && result.previous.version !== result.active.version) {
    return `Updated ${result.active.id} from ${result.previous.version} to ${result.active.version}.`;
  }
  return `Installed ${coordinate}.`;
}

function printStatus(status) {
  console.log(`Content pack directory: ${status.contentPacksRoot}`);
  if (status.installed.length === 0) {
    console.log("Installed content packs: none");
    return;
  }
  console.log("Installed content packs:");
  for (const entry of status.installed) {
    console.log(`  ${entry.id}@${entry.version}  ${entry.packSha256}`);
    const inactive = entry.storedVersions.filter((version) => version !== entry.version);
    if (inactive.length > 0) {
      console.log(`    retained versions: ${inactive.join(", ")}`);
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  validateCommandArguments(command, options);
  const targetOptions = managerOptions(options);
  if (COMMANDS_NEEDING_A_COMPLETE_STORE.has(command) && targetOptions.dryRun !== true) {
    const sync = syncStaticTables({ dataDir: targetOptions.dataDir });
    const summary = describeSyncResult(sync);
    if (summary) {
      console.log(`[game store] ${summary}`);
    }
  }
  switch (command) {
    case "status":
      printStatus(manager.getContentPackStatus(targetOptions));
      return;
    case "verify": {
      const packPath = requiredValue(options, "pack", 0);
      const loaded = manager.readContentPackFile(packPath);
      console.log(
        `Verified ${loaded.validation.id}@${loaded.validation.version}: ` +
        `${loaded.validation.dungeonTemplateCount} dungeon templates, ` +
        `${loaded.validation.packSha256}`,
      );
      return;
    }
    case "install": {
      const packPath = requiredValue(options, "pack", 0);
      const result = manager.installContentPack(packPath, targetOptions);
      console.log(describeInstallOutcome(result));
      console.log(`Registry: ${result.contentPacksRoot}`);
      if (result.changed) {
        console.log("Restart the server to use this content pack.");
      }
      return;
    }
    case "import": {
      const directory = requiredValue(options, "dir", 0);
      const result = manager.importContentPackDirectory(directory, targetOptions);
      const dryRun = targetOptions.dryRun === true;
      console.log(`Content pack folder: ${result.directory}`);
      if (dryRun) {
        console.log("Dry run: nothing is installed.");
      }
      if (result.results.length === 0) {
        console.log("No pack files found.");
        return;
      }
      for (const entry of result.results) {
        if (!entry.ok) {
          console.log(`  FAILED   ${entry.file}: ${entry.message}`);
          continue;
        }
        const coordinate = `${entry.id}@${entry.version}`;
        if (entry.action === "skipped") {
          console.log(`  skipped  ${coordinate}: ${entry.newerVersion} is also in this folder`);
        } else if (entry.action === "kept") {
          console.log(`  kept     ${entry.id}@${entry.installedVersion}, which is newer than ${entry.version} in this folder`);
        } else if (entry.action === "updated") {
          console.log(`  updated  ${coordinate} (was ${entry.previousVersion})`);
        } else if (entry.action === "replaced") {
          console.log(`  replaced ${coordinate} with a different build of the same version`);
        } else if (entry.action === "installed") {
          console.log(`  installed ${coordinate}`);
        } else {
          console.log(`  already installed ${coordinate}`);
        }
      }
      console.log(
        `${result.results.length} pack file(s): ` +
        `${result.changed} ${dryRun ? "to change" : "changed"}, ${result.failed} failed.`,
      );
      if (result.changed > 0 && !dryRun) {
        console.log("Restart the server to use them.");
      }
      if (result.failed > 0) {
        process.exitCode = 1;
      }
      return;
    }
    case "remove": {
      const id = requiredValue(options, "id", 0);
      const result = manager.removeContentPack(id, targetOptions);
      console.log(result.changed ? `Removed ${id} from the active pack set.` : `${id} is not installed.`);
      console.log("Stored pack files were retained for rollback. Restart the server.");
      return;
    }
    case "rollback": {
      const id = requiredValue(options, "id", 0);
      const version = requiredValue(options, "version", 1);
      const result = manager.activateContentPack(id, version, targetOptions);
      console.log(`Activated ${result.active.id}@${result.active.version}.`);
      console.log("Restart the server to use this content pack.");
      return;
    }
    case "doctor": {
      const result = manager.doctorContentPacks(targetOptions);
      console.log(
        `Content pack registry is healthy (${result.summary.activePackCount} active pack(s), ` +
        `${result.summary.dungeonTemplateCount} effective dungeon template(s), ` +
        `${result.summary.spawnProfileCount} spawn profile(s)).`,
      );
      for (const pack of result.loaded) {
        console.log(
          `  ${pack.validation.id}@${pack.validation.version}: ` +
          `${pack.validation.dungeonTemplateCount} dungeon templates`,
        );
      }
      return;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command ${JSON.stringify(command)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[content-packs] ${error && error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  managerOptions,
  parseArguments,
  validateCommandArguments,
};
