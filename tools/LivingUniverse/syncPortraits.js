#!/usr/bin/env node
"use strict";

// Living Universe: give every pilot a face.
//
// Pilots reuse NPC agent portraits. This downloads each pilot's source portrait
// from CCP's public image server and saves it under the pilot's own character
// ID in the game store's portrait folder, which is where EveJS's image server
// already looks. Run once after install, and again after raising the population.
// Already downloaded portraits are skipped, so it can be stopped and resumed.
//
//   node tools/LivingUniverse/syncPortraits.js [--size 256] [--limit N]

const fs = require("node:fs");
const path = require("node:path");

const server = path.resolve(__dirname, "../../server/src");
process.env.EVEJS_LOCAL_DATABASE_ROOT ||= path.resolve(__dirname, "../../_local/gameStore");
process.env.EVEJS_GAMESTORE_DATA_DIR ||= path.join(process.env.EVEJS_LOCAL_DATABASE_ROOT, "data");

const directory = require(path.join(server, "livingUniverse/pilotDirectory"));
const portraits = require(path.join(server, "services/character/portraitImageStore"));

const SOURCE = "https://images.evetech.net/characters";
const CONCURRENCY = 12;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) || fallback : fallback;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../config/livingUniverse.json"), "utf8"));
  const size = option("size", 256);
  const count = Math.min(option("limit", config.populationSize), config.populationSize);
  const pool = directory.loadPortraitAgentPool();
  fs.mkdirSync(portraits.getCharacterPortraitRoot(), { recursive: true });

  const jobs = [];
  for (let number = 1; number <= count; number += 1) {
    const target = portraits.getCharacterPortraitFilePath(directory.PILOT_CHARACTER_ID_BASE + number, size, "jpg");
    // Same rule as pilotDirectory.buildStablePilotIdentity: the pilot's number picks the face.
    if (!fs.existsSync(target)) jobs.push({ target, agentID: pool[(number - 1) % pool.length] });
  }
  console.log(`Living Universe portraits: ${count - jobs.length} present, ${jobs.length} to download (${size}px)`);

  let done = 0;
  let failed = 0;
  async function worker() {
    for (;;) {
      const job = jobs.pop();
      if (!job) return;
      try {
        const response = await fetch(`${SOURCE}/${job.agentID}/portrait?size=${size}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const tmp = `${job.target}.tmp`;
        fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
        fs.renameSync(tmp, job.target);
      } catch (error) {
        failed += 1;
        if (failed <= 5) console.log(`  failed ${job.agentID}: ${error.message}`);
      }
      done += 1;
      if (done % 500 === 0) console.log(`  ${done} done, ${failed} failed`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Finished: ${done - failed} downloaded, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
