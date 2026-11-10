#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");
// Backups stay out of the gameStore folder, which each isolated test run copies whole.
const DEFAULT_BACKUP_DIR = path.join(REPO_ROOT, "_local", "backups", "moon-data");
// The project's moon world. An install keeps the same seed for good: a new
// seed gives every moon new ores.
const DEFAULT_SEED = "EveJS";
const BACKUPS_KEPT = 3;
const {
  generateMoonCompositionDatasetFromWorldData,
} = require(path.join(
  REPO_ROOT,
  "server/src/services/structure/moonCompositionPackGenerator",
));

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${argument}`);
      }
      return argv[index];
    };
    switch (argument) {
      case "--out": options.out = path.resolve(next()); break;
      case "--manifest": options.manifest = path.resolve(next()); break;
      case "--seed": options.seed = next(); break;
      case "--rules": options.rulesPath = path.resolve(next()); break;
      case "--source-build": options.sourceBuild = Number(next()); break;
      case "--backup-dir": options.backupDir = path.resolve(next()); break;
      case "--force": options.force = true; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }
  options.seed = String(options.seed || process.env.EVEJS_MOON_WORLD_SEED || DEFAULT_SEED);
  if (!options.help && !options.out) {
    throw new Error("--out is required");
  }
  if (!options.help && options.sourceBuild !== undefined &&
    (!Number.isInteger(options.sourceBuild) || options.sourceBuild <= 0)) {
    throw new Error("--source-build must be a positive integer");
  }
  if (options.out) {
    options.manifest ||= `${options.out}.manifest.json`;
  }
  options.backupDir ||= DEFAULT_BACKUP_DIR;
  return options;
}

function usage() {
  return [
    "Usage: node tools/moon-data/generate-moon-composition-pack.js --out <file> [options]",
    "",
    "  --out <file>              New generated moon-composition JSON authority",
    "  --manifest <file>         Manifest path (default: <out>.manifest.json)",
    `  --seed <text>             Stable per-install world seed (default: ${DEFAULT_SEED})`,
    "  --rules <file>            Optional versioned JSON ruleset",
    "  --source-build <number>  Source client/static build (default: packaged moon-point authority)",
    "  --force                   Replace existing output only after backing it up",
    "  --backup-dir <dir>        Where --force puts backups (default: _local/backups/moon-data).",
    `                            The newest ${BACKUPS_KEPT} of each file are kept.`,
    "",
    "The seed can instead be supplied by EVEJS_MOON_WORLD_SEED.",
    `With neither, the generator uses the default seed "${DEFAULT_SEED}".`,
  ].join("\n");
}

function readRuleset(rulesPath) {
  if (!rulesPath) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ruleset ${rulesPath}: ${error.message}`);
  }
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function createManifest(dataset, serializedPack) {
  return {
    schemaVersion: 1,
    authorityClass: dataset.authorityClass,
    datasetVersion: dataset.datasetVersion,
    sourceBuild: dataset.sourceBuild,
    contentHash: dataset.contentHash,
    packBytes: Buffer.byteLength(serializedPack),
    packSha256: sha256Text(serializedPack),
    generation: dataset.generation,
  };
}

function writeTemporary(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  return temporaryPath;
}

// Timestamps sort by name, so the newest backups are the last names.
function pruneBackups(backupDir, prefix) {
  const names = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))) {
    fs.rmSync(path.join(backupDir, name), { force: true });
  }
}

function backupExisting(filePath, backupDir, stamp) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const prefix = `${path.basename(filePath)}.bak-`;
  const backupPath = path.join(backupDir, `${prefix}${stamp}`);
  try {
    fs.renameSync(filePath, backupPath);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    // The backup folder is on another drive than the output.
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(filePath);
  }
  pruneBackups(backupDir, prefix);
  return backupPath;
}

function publishPack({
  outputPath,
  manifestPath,
  serializedPack,
  serializedManifest,
  force = false,
  backupDir,
}) {
  const existingPaths = [outputPath, manifestPath].filter((filePath) => fs.existsSync(filePath));
  if (existingPaths.length > 0 && !force) {
    throw new Error(
      `Refusing to replace existing moon world output: ${existingPaths.join(", ")}. ` +
      "Use --force to create timestamped backups and replace it deliberately.",
    );
  }
  // No default: a caller forcing a replace must say where its backups go, so a
  // test can never write into, or prune, the real backup folder.
  if (force && !backupDir) {
    throw new Error("publishPack needs backupDir when force is set");
  }
  const temporaryPack = writeTemporary(outputPath, serializedPack);
  let temporaryManifest;
  try {
    temporaryManifest = writeTemporary(manifestPath, serializedManifest);
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backups = force
      ? [
        backupExisting(outputPath, backupDir, stamp),
        backupExisting(manifestPath, backupDir, stamp),
      ].filter(Boolean)
      : [];
    fs.renameSync(temporaryPack, outputPath);
    fs.renameSync(temporaryManifest, manifestPath);
    return { outputPath, manifestPath, backups };
  } catch (error) {
    fs.rmSync(temporaryPack, { force: true });
    if (temporaryManifest) {
      fs.rmSync(temporaryManifest, { force: true });
    }
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const dataset = generateMoonCompositionDatasetFromWorldData({
    seed: options.seed,
    sourceBuild: options.sourceBuild,
    ruleset: readRuleset(options.rulesPath),
  });
  const serializedPack = `${JSON.stringify(dataset)}\n`;
  const manifest = createManifest(dataset, serializedPack);
  const published = publishPack({
    outputPath: options.out,
    manifestPath: options.manifest,
    serializedPack,
    serializedManifest: `${JSON.stringify(manifest, null, 2)}\n`,
    force: options.force,
    backupDir: options.backupDir,
  });
  const summary = {
    outputPath: published.outputPath,
    manifestPath: published.manifestPath,
    backups: published.backups,
    packBytes: manifest.packBytes,
    packSha256: manifest.packSha256,
    contentHash: manifest.contentHash,
    generatedProfiles: dataset.generation.summary.generatedProfiles,
    skippedMoons: dataset.generation.summary.skippedMoons,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_SEED,
  createManifest,
  main,
  parseArgs,
  publishPack,
};
