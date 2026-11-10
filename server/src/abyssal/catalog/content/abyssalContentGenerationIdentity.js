"use strict";

const { createHash } = require("node:crypto");
const qsna = require("./qsnaAbyssalSpawnTables.generated.json");
const { ABYSSAL_PROCEDURAL_REWARD_MODEL_ID } = require("../abyssalProceduralLoot");
const { PROCEDURAL_DEFINITION_MODEL, PROCEDURAL_DEFINITION_MODEL_V1, PROCEDURAL_ROOM_MODEL, PROCEDURAL_EXTRACTION_MODEL } =
  require("./abyssalProceduralContentComposer");
const { PROCEDURAL_ENVIRONMENT_MODEL, PROCEDURAL_ENVIRONMENT_INPUTS } = require("../abyssalProceduralEnvironment");
const {
  BASE_ROOM_LAYOUT_CATALOG_VERSION,
  BASE_ROOM_LAYOUT_SELECTION_MODEL,
  listAbyssalBaseRoomLayouts,
} = require("../abyssalBaseRoomLayoutCatalog");
const {
  listAbyssalEnvironmentLayoutVariants,
  resolveAbyssalEnvironmentProfile,
} = require("../abyssalEnvironmentProfiles");

// Keep hybrid and procedural-v1 identities unchanged for saved references.
// New definitions use procedural environmental composition over factual inputs.
// Policy upgrades require a matching saved-run reader.
const CONTENT_GENERATION_MODELS = Object.freeze({
  definition: "abyssal:hybrid-definition-v1",
  room: "abyssal:hybrid-three-room-v1",
  npcCatalogue: qsna.catalogueID,
  npcFamilySelection: qsna.policies.familySelection,
  npcQuantitySelection: qsna.policies.quantitySelection,
  npcCountReconciliation: qsna.policies.countReconciliation,
  npcAdmission: "abyssal:qsna-runtime-admission-v1",
  reward: ABYSSAL_PROCEDURAL_REWARD_MODEL_ID,
  extraction: "abyssal:legacy-tier-extraction-v1",
  environment: "abyssal:registered-environments-no-fallback-v1",
  layout: BASE_ROOM_LAYOUT_CATALOG_VERSION,
  layoutSelection: BASE_ROOM_LAYOUT_SELECTION_MODEL,
});
const PROCEDURAL_CONTENT_GENERATION_MODELS_V1 = Object.freeze({
  ...CONTENT_GENERATION_MODELS,
  definition: PROCEDURAL_DEFINITION_MODEL_V1,
  room: PROCEDURAL_ROOM_MODEL,
  extraction: PROCEDURAL_EXTRACTION_MODEL,
});
const PROCEDURAL_CONTENT_GENERATION_MODELS = Object.freeze({
  ...PROCEDURAL_CONTENT_GENERATION_MODELS_V1,
  definition: PROCEDURAL_DEFINITION_MODEL,
  environment: PROCEDURAL_ENVIRONMENT_MODEL,
});

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(value) {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

// Also pin data: version labels alone cannot detect an SDE/catalogue regeneration
// that forgot to bump its model. Compute the shared inputs only once, not per write.
// Pin the catalogue content, not its provenance: the generated notice, the source
// directory label and the derived summaries say where the table came from, and
// moving the scraper output must not invalidate every saved run.
const QSNA_CONTENT_INPUTS = Object.freeze({
  schemaVersion: qsna.schemaVersion,
  catalogueID: qsna.catalogueID,
  authority: qsna.authority,
  policies: qsna.policies,
  combinations: qsna.combinations,
});
const SHARED_INPUTS_DIGEST = digest({
  qsna: QSNA_CONTENT_INPUTS,
  layouts: listAbyssalBaseRoomLayouts(),
  environments: Object.values(qsna.combinations).flatMap(({ tier, weather }) =>
    listAbyssalEnvironmentLayoutVariants(tier, weather).map((layoutVariant) =>
      resolveAbyssalEnvironmentProfile({ tier, weatherType: weather, layoutVariant }))),
});
const PROCEDURAL_SHARED_INPUTS_DIGEST = digest({ qsna: QSNA_CONTENT_INPUTS,
  layouts: listAbyssalBaseRoomLayouts(), environment: PROCEDURAL_ENVIRONMENT_INPUTS });
const DEFINITION_INPUT_FIELDS = Object.freeze([
  "definitionID", "filamentTypeID", "hullMode", "tier", "weatherType",
  "roomProfile", "weatherProfile", "npcProfile", "rewardProfile",
  "cacheProfile", "extractionNodeProfile", "roomEncounterProfilesByIndex",
  "environmentLayoutVariant", "authoredCaptureID",
]);

function buildContentGenerationIdentity(definition, models = CONTENT_GENERATION_MODELS) {
  const environment = resolveAbyssalEnvironmentProfile({
    tier: definition.tier,
    weatherType: definition.weatherType,
    layoutVariant: definition.environmentLayoutVariant,
  });
  if (!environment) throw new Error("ABYSSAL_CONTENT_ENVIRONMENT_UNAVAILABLE");
  const inputs = Object.fromEntries(DEFINITION_INPUT_FIELDS.map((key) =>
    [key, definition[key] ?? null]));
  return {
    ...models,
    inputsDigest: digest({ shared: models.definition === PROCEDURAL_DEFINITION_MODEL
      ? PROCEDURAL_SHARED_INPUTS_DIGEST : SHARED_INPUTS_DIGEST, inputs, environment }),
  };
}

function matchesContentGenerationIdentity(expected, actual) {
  return Boolean(expected && actual && canonicalJSON(expected) === canonicalJSON(actual));
}

module.exports = {
  CONTENT_GENERATION_MODELS,
  PROCEDURAL_CONTENT_GENERATION_MODELS,
  PROCEDURAL_CONTENT_GENERATION_MODELS_V1,
  buildContentGenerationIdentity,
  matchesContentGenerationIdentity,
};
