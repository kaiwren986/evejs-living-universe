"use strict";

// Builds staticTables/researchFieldAuthority/data.json: the research fields each
// R&D agent offers, and the datacore each field yields.
//
// Both halves come straight out of the SDE and are not authored here:
//   * npcCharacters.jsonl carries a `skills` array on exactly the 244 agents with
//     agentTypeID 4 (and on no other agent type). Those typeIDs are the agent's
//     science specialty fields -- the list "Start Research" offers.
//   * A datacore (group 333) names its field through dogma attribute 182
//     (requiredSkill1), so the field -> datacore map is derived, not typed in.
//
// Run: node tools/DatabaseCreator/build-research-field-authority.js --sde <dir>

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const AGENT_TYPE_RESEARCH = 4;
const GROUP_DATACORES = 333;
const ATTRIBUTE_REQUIRED_SKILL_1 = 182;

function parseArgs(argv) {
  const options = { sdeDir: "", outFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--sde") {
      options.sdeDir = path.resolve(argv[++index] || "");
    } else if (argv[index] === "--out") {
      options.outFile = path.resolve(argv[++index] || "");
    }
  }
  if (!options.sdeDir) {
    throw new Error("--sde <static-data-jsonl-dir> is required");
  }
  if (!options.outFile) {
    options.outFile = path.join(
      __dirname,
      "staticTables",
      "researchFieldAuthority",
      "data.json",
    );
  }
  return options;
}

async function readJsonl(sdeDir, fileName, onRecord) {
  const filePath = path.join(sdeDir, fileName);
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      onRecord(JSON.parse(trimmed));
    }
  }
}

function sortedNumbers(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const typeNames = new Map();
  const datacoreTypeIDs = [];
  await readJsonl(options.sdeDir, "types.jsonl", (row) => {
    typeNames.set(row._key, (row.name && row.name.en) || "");
    if (row.groupID === GROUP_DATACORES && row.published === true) {
      datacoreTypeIDs.push(row._key);
    }
  });

  const requiredSkillByTypeID = new Map();
  await readJsonl(options.sdeDir, "typeDogma.jsonl", (row) => {
    for (const attribute of row.dogmaAttributes || []) {
      if (attribute.attributeID === ATTRIBUTE_REQUIRED_SKILL_1) {
        requiredSkillByTypeID.set(row._key, Math.trunc(attribute.value));
      }
    }
  });

  const researchFieldsByAgentID = {};
  const agentLevelByAgentID = {};
  await readJsonl(options.sdeDir, "npcCharacters.jsonl", (row) => {
    const agent = row.agent;
    if (!agent || agent.agentTypeID !== AGENT_TYPE_RESEARCH) {
      return;
    }
    const fields = sortedNumbers(
      (row.skills || []).map((skill) => Math.trunc(skill.typeID)),
    );
    if (fields.length === 0) {
      return;
    }
    researchFieldsByAgentID[String(row._key)] = fields;
    agentLevelByAgentID[String(row._key)] = Math.trunc(agent.level) || 1;
  });

  // Every field an agent offers, mapped to the datacore it produces. Fields whose
  // datacore does not exist are still listed as fields: the agent really does offer
  // them, and the skill gate -- which needs the field trained to the agent's level --
  // is what decides whether one is reachable. Filtering them here would be us
  // inventing a rule the client does not have.
  const datacoreTypeIDBySkillTypeID = {};
  for (const datacoreTypeID of datacoreTypeIDs) {
    const skillTypeID = requiredSkillByTypeID.get(datacoreTypeID);
    if (skillTypeID) {
      datacoreTypeIDBySkillTypeID[String(skillTypeID)] = datacoreTypeID;
    }
  }

  const allFields = sortedNumbers(
    Object.values(researchFieldsByAgentID).flat(),
  );
  const fieldsWithoutDatacore = allFields.filter(
    (skillTypeID) => !datacoreTypeIDBySkillTypeID[String(skillTypeID)],
  );

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      sourceSnapshot: path.basename(options.sdeDir),
      sourceFiles: ["npcCharacters.jsonl", "types.jsonl", "typeDogma.jsonl"],
      notes: [
        "Research fields are npcCharacters[].skills, present on agentTypeID 4 only.",
        "Datacore mapping is dogma attribute 182 (requiredSkill1) on group 333.",
      ],
    },
    counts: {
      researchAgents: Object.keys(researchFieldsByAgentID).length,
      researchFields: allFields.length,
      datacoreMappedFields: allFields.length - fieldsWithoutDatacore.length,
      fieldsWithoutDatacore: fieldsWithoutDatacore.length,
    },
    fieldNamesBySkillTypeID: Object.fromEntries(
      allFields.map((skillTypeID) => [
        String(skillTypeID),
        typeNames.get(skillTypeID) || "",
      ]),
    ),
    datacoreTypeIDBySkillTypeID,
    agentLevelByAgentID,
    researchFieldsByAgentID,
  };

  fs.mkdirSync(path.dirname(options.outFile), { recursive: true });
  fs.writeFileSync(options.outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  process.stdout.write(
    `researchFieldAuthority: ${payload.counts.researchAgents} agents, ` +
      `${payload.counts.researchFields} fields ` +
      `(${payload.counts.fieldsWithoutDatacore} without a datacore) -> ${options.outFile}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
