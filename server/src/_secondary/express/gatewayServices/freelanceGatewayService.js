"use strict";

const protobuf = require("protobufjs");

const {
  bufferFromBytes,
  compareSemver,
  currencyToNumber,
  durationToMs,
  encodePayload,
  getActiveCharacterID,
  sliceWithPage,
  timestampFromMs,
  timestampToMs,
  uuidBufferToString,
  uuidStringToBuffer,
} = require("./gatewayServiceHelpers");
const freelanceProjectState = require("../../../services/freelance/freelanceProjectState");
const {
  getCharacterRecord,
} = require("../../../services/character/characterState");

// Official support references:
// - Freelance Jobs: default active participation cap is 3; corp creation cap is 100;
//   jobs can be broadcast to up to 20 solar systems; max duration is 1 year.
// - CCP client mock values provide the remaining fallback defaults that are not
//   explicitly documented in support copy.
const FREELANCE_LIMITS = Object.freeze({
  maxActiveProjectsPerCorporation: 100,
  maxActiveProjectsBroadcastPerSystem: 20,
  maxCharacterAgeDays: 1000000,
  maxBroadcastingLocationsPerProject: 20,
  maxCommittedParticipantsPerProject: 100000,
  maxContributionMultiplier: 2,
  maxProjectDurationSeconds: 31536000,
  maxActiveProjectsPerParticipant: 3,
});

const FREELANCE_CREATION_PRICES = Object.freeze({
  baseFeePerDay: 75000,
  broadcastingFeePerDayPerLocation: 100000,
});

const CONTRIBUTION_METHOD_VERSION = Object.freeze({
  major: 1,
  minor: 2,
  patch: 4,
  prerelease_tags: [],
  build_tags: [],
});

const PROJECT_API_RESPONSE_TYPES = Object.freeze({
  "eve_public.freelance.project.api.CreateRequest":
    "eve_public.freelance.project.api.CreateResponse",
  "eve_public.freelance.project.api.CloseRequest":
    "eve_public.freelance.project.api.CloseResponse",
  "eve_public.freelance.project.api.CommitRequest":
    "eve_public.freelance.project.api.CommitResponse",
  "eve_public.freelance.project.api.ResignRequest":
    "eve_public.freelance.project.api.ResignResponse",
  "eve_public.freelance.project.api.KickRequest":
    "eve_public.freelance.project.api.KickResponse",
  "eve_public.freelance.project.api.RedeemRewardRequest":
    "eve_public.freelance.project.api.RedeemRewardResponse",
  "eve_public.freelance.project.api.GetRequest":
    "eve_public.freelance.project.api.GetResponse",
  "eve_public.freelance.project.api.GetForManagerRequest":
    "eve_public.freelance.project.api.GetForManagerResponse",
  "eve_public.freelance.project.api.GetAllBroadcastedRequest":
    "eve_public.freelance.project.api.GetAllBroadcastedResponse",
  "eve_public.freelance.project.api.GetAllCommittedRequest":
    "eve_public.freelance.project.api.GetAllCommittedResponse",
  "eve_public.freelance.project.api.GetAllUnredeemedRequest":
    "eve_public.freelance.project.api.GetAllUnredeemedResponse",
  "eve_public.freelance.project.api.GetAllActiveForCorporationRequest":
    "eve_public.freelance.project.api.GetAllActiveForCorporationResponse",
  "eve_public.freelance.project.api.GetAllActiveRequest":
    "eve_public.freelance.project.api.GetAllActiveResponse",
  "eve_public.freelance.project.api.GetAllInactiveRequest":
    "eve_public.freelance.project.api.GetAllInactiveResponse",
  "eve_public.freelance.project.api.GetParticipationDetailsRequest":
    "eve_public.freelance.project.api.GetParticipationDetailsResponse",
  "eve_public.freelance.project.api.GetStatsRequest":
    "eve_public.freelance.project.api.GetStatsResponse",
});

const ITEM_DELIVERY_RESPONSE_TYPES = Object.freeze({
  "eve_public.freelance.contributionmethod.itemdelivery.api.DeliverRequest":
    "eve_public.freelance.contributionmethod.itemdelivery.api.DeliverResponse",
  "eve_public.freelance.contributionmethod.itemdelivery.api.GetStatusRequest":
    "eve_public.freelance.contributionmethod.itemdelivery.api.GetStatusResponse",
});

const CONTRIBUTION_DEFINITION_RESPONSE_TYPES = Object.freeze({
  "eve_public.freelance.contributionmethod.definition.api.GetAllLatestRequest":
    "eve_public.freelance.contributionmethod.definition.api.GetAllLatestResponse",
  "eve_public.freelance.contributionmethod.definition.api.GetAllLatestWithinMajorRequest":
    "eve_public.freelance.contributionmethod.definition.api.GetAllLatestWithinMajorResponse",
});

function contentTags(...ids) {
  return ids.map((id) => ({ id }));
}

function matcherParameter({
  key,
  type,
  title,
  description,
  icon,
  optional = true,
  maxEntries = 10,
  acceptedValueTypes = [],
  unsetDescription = 657073,
}) {
  return {
    kind: "matcher",
    key,
    type,
    title,
    description,
    icon,
    optional,
    maxEntries,
    acceptedValueTypes,
    unsetDescription,
  };
}

function optionsParameter({
  key,
  title,
  description,
  icon,
  maxEntries = 1,
  options = [],
  defaultOptionKey = "",
}) {
  return {
    kind: "options",
    key,
    title,
    description,
    icon,
    maxEntries,
    options,
    defaultOptionKey,
  };
}

function booleanParameter({
  key,
  title,
  description,
  icon,
  choiceLabel,
  optionTrue,
  optionFalse,
  defaultValue = false,
}) {
  return {
    kind: "boolean",
    key,
    title,
    description,
    icon,
    choiceLabel,
    optionTrue,
    optionFalse,
    defaultValue,
  };
}

function deliveryParameter({
  key,
  title,
  description,
  icon,
  inventoryType,
  deliveryLocation,
}) {
  return {
    kind: "corporation_item_delivery",
    key,
    title,
    description,
    icon,
    inventoryType,
    deliveryLocation,
  };
}

function methodDefinition(definition) {
  return Object.freeze(definition);
}

// Only authoritative item custody is supported by this port.
const CONTRIBUTION_METHOD_DEFINITIONS = Object.freeze([
  methodDefinition({
    name: "DeliverItem",
    title: 659185,
    description: 695453,
    progressDescription: 696244,
    targetDescription: 695453,
    rewardDescription: 695454,
    icon: "delivery",
    contentTags: contentTags("career_path_industrialist", "activity_hauling"),
    parameters: [
      deliveryParameter({
        key: "corporation_item_delivery",
        title: 1011314,
        description: 1016567,
        icon: "personal",
        inventoryType: {
          title: 1016567,
          description: 1016568,
          icon: "inventory",
          unsetDescription: 657073,
          acceptedValueTypes: ["item_type", "item_group"],
        },
        deliveryLocation: {
          title: 659193,
          description: 1016569,
          icon: "inventory",
          unsetDescription: 657073,
          maxEntries: 10,
          acceptedValueTypes: ["station"],
        },
      }),
    ],
  }),
]);

function addSemanticVersionTypes(root) {
  root.define("eve_public.semanticversion").add(
    new protobuf.Type("Specification")
      .add(new protobuf.Field("major", 1, "uint32"))
      .add(new protobuf.Field("minor", 2, "uint32"))
      .add(new protobuf.Field("patch", 3, "uint32"))
      .add(new protobuf.Field("prerelease_tags", 4, "string", "repeated"))
      .add(new protobuf.Field("build_tags", 5, "string", "repeated")),
  );
}

function addCommonIdentifierTypes(root) {
  root.define("google.protobuf").add(
    new protobuf.Type("Duration")
      .add(new protobuf.Field("seconds", 1, "int64"))
      .add(new protobuf.Field("nanos", 2, "int32")),
  );
  root.define("google.protobuf").add(
    new protobuf.Type("Timestamp")
      .add(new protobuf.Field("seconds", 1, "int64"))
      .add(new protobuf.Field("nanos", 2, "int32")),
  );
  root.define("eve_public").add(
    new protobuf.Type("Page")
      .add(new protobuf.Field("size", 1, "uint32"))
      .add(new protobuf.Field("token", 2, "string")),
  );
  root.define("eve_public").add(
    new protobuf.Type("NextPage").add(new protobuf.Field("token", 1, "string")),
  );
  for (const namespaceName of [
    "eve_public.acl",
    "eve_public.character",
    "eve_public.corporation",
    "eve_public.solarsystem",
    "eve_public.station",
    "eve_public.structure",
  ]) {
    root.define(namespaceName).add(
      new protobuf.Type("Identifier").add(
        new protobuf.Field("sequential", 1, "uint32"),
      ),
    );
  }
  root.define("eve_public.inventory").add(
    new protobuf.Type("LocationFlag").add(
      new protobuf.Field("value", 1, "uint64"),
    ),
  );
  root.define("eve_public.inventory.genericitem").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint64"),
    ),
  );
  root.define("eve_public.inventory.genericitem").add(
    new protobuf.Type("Location")
      .add(
        new protobuf.Field(
          "item",
          1,
          "eve_public.inventory.genericitem.Identifier",
        ),
      )
      .add(new protobuf.Field("flag", 2, "eve_public.inventory.LocationFlag")),
  );
  root.define("eve_public.localization.message").add(
    new protobuf.Type("Identifier").add(
      new protobuf.Field("sequential", 1, "uint32"),
    ),
  );
  root.define("eve_public.ui.icon").add(
    new protobuf.Type("Identifier").add(new protobuf.Field("name", 1, "string")),
  );
  root.define("eve_public.ui.contenttag").add(
    new protobuf.Type("Identifier").add(new protobuf.Field("name", 1, "string")),
  );
  root.define("eve_public.isk").add(
    new protobuf.Type("Currency")
      .add(new protobuf.Field("units", 1, "uint64"))
      .add(new protobuf.Field("nanos", 2, "int32")),
  );
}

function addContributionDefinitionTypes(root) {
  const definitionNamespace = root.define(
    "eve_public.freelance.contributionmethod.definition",
  );

  definitionNamespace.add(
    new protobuf.Type("Identifier").add(new protobuf.Field("name", 1, "string")),
  );
  definitionNamespace.add(
    new protobuf.Type("BaseUIRepresentation")
      .add(new protobuf.Field("icon", 2, "eve_public.ui.icon.Identifier"))
      .add(
        new protobuf.Field(
          "title",
          3,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "description",
          4,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "unset_description",
          5,
          "eve_public.localization.message.Identifier",
        ),
      ),
  );
  definitionNamespace.add(
    new protobuf.Type("ContributionMultiplier")
      .add(
        new protobuf.Field(
          "representation",
          1,
          "eve_public.freelance.contributionmethod.definition.BaseUIRepresentation",
        ),
      )
      .add(new protobuf.Field("value", 2, "double"))
      .add(new protobuf.Field("no_default_value", 3, "bool"))
      .add(new protobuf.Field("maximum_value", 4, "double"))
      .add(new protobuf.Field("minimum_value", 5, "double")),
  );
  definitionNamespace.add(
    new protobuf.Type("MaxContributionsPerParticipant")
      .add(
        new protobuf.Field(
          "representation",
          1,
          "eve_public.freelance.contributionmethod.definition.BaseUIRepresentation",
        ),
      )
      .add(new protobuf.Field("value", 2, "uint64"))
      .add(new protobuf.Field("no_default_value", 3, "bool")),
  );
  definitionNamespace.add(
    new protobuf.Type("MaxProgressPerContribution")
      .add(
        new protobuf.Field(
          "representation",
          1,
          "eve_public.freelance.contributionmethod.definition.BaseUIRepresentation",
        ),
      )
      .add(new protobuf.Field("value", 2, "uint64"))
      .add(new protobuf.Field("no_default_value", 3, "bool")),
  );

  const optionsParameter = new protobuf.Type("OptionsParameter")
    .add(new protobuf.Field("key", 1, "string"))
    .add(
      new protobuf.Field(
        "title",
        2,
        "eve_public.localization.message.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "description",
        3,
        "eve_public.localization.message.Identifier",
      ),
    )
    .add(new protobuf.Field("icon", 4, "eve_public.ui.icon.Identifier"))
    .add(new protobuf.Field("max_entries", 5, "uint32"))
    .add(new protobuf.Field("options", 6, "Option", "repeated"))
    .add(new protobuf.Field("default_option_key", 7, "string"));
  optionsParameter.add(
    new protobuf.Type("Option")
      .add(new protobuf.Field("key", 1, "string"))
      .add(
        new protobuf.Field(
          "title",
          2,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "description",
          3,
          "eve_public.localization.message.Identifier",
        ),
      ),
  );
  definitionNamespace.add(optionsParameter);

  const booleanParameter = new protobuf.Type("BooleanParameter")
    .add(new protobuf.Field("key", 1, "string"))
    .add(
      new protobuf.Field(
        "title",
        2,
        "eve_public.localization.message.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "description",
        3,
        "eve_public.localization.message.Identifier",
      ),
    )
    .add(new protobuf.Field("icon", 4, "eve_public.ui.icon.Identifier"))
    .add(
      new protobuf.Field(
        "choice_label_id",
        5,
        "eve_public.localization.message.Identifier",
      ),
    )
    .add(new protobuf.Field("option_true", 6, "Option"))
    .add(new protobuf.Field("option_false", 7, "Option"))
    .add(new protobuf.Field("default", 8, "bool"));
  booleanParameter.add(
    new protobuf.Type("Option")
      .add(
        new protobuf.Field(
          "title_id",
          1,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "description_id",
          2,
          "eve_public.localization.message.Identifier",
        ),
      ),
  );
  definitionNamespace.add(booleanParameter);

  const corporationItemDeliveryParameter = new protobuf.Type(
    "CorporationItemDeliveryParameter",
  )
    .add(new protobuf.Field("key", 1, "string"))
    .add(
      new protobuf.Field(
        "title",
        2,
        "eve_public.localization.message.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "description",
        3,
        "eve_public.localization.message.Identifier",
      ),
    )
    .add(new protobuf.Field("icon", 4, "eve_public.ui.icon.Identifier"))
    .add(new protobuf.Field("inventory_type", 5, "InventoryTypeParameter"))
    .add(
      new protobuf.Field(
        "delivery_location",
        6,
        "CorporationOfficeLocationParameter",
      ),
    );
  corporationItemDeliveryParameter.add(
    new protobuf.Type("InventoryTypeParameter")
      .add(
        new protobuf.Field(
          "title",
          1,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "description",
          2,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(new protobuf.Field("icon", 3, "eve_public.ui.icon.Identifier"))
      .add(
        new protobuf.Field(
          "unset_description",
          4,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(new protobuf.Field("no_unset_description", 5, "bool"))
      .add(new protobuf.Field("accepted_value_types", 6, "string", "repeated")),
  );
  corporationItemDeliveryParameter.add(
    new protobuf.Type("CorporationOfficeLocationParameter")
      .add(
        new protobuf.Field(
          "title",
          1,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "description",
          2,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(new protobuf.Field("icon", 3, "eve_public.ui.icon.Identifier"))
      .add(
        new protobuf.Field(
          "unset_description",
          4,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(new protobuf.Field("no_unset_description", 5, "bool"))
      .add(new protobuf.Field("max_entries", 6, "uint32"))
      .add(new protobuf.Field("accepted_value_types", 7, "string", "repeated")),
  );
  definitionNamespace.add(corporationItemDeliveryParameter);

  definitionNamespace.add(
    new protobuf.Type("MatcherParameter")
      .add(new protobuf.Field("key", 1, "string"))
      .add(new protobuf.Field("type", 2, "string"))
      .add(
        new protobuf.Field(
          "title",
          3,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "description",
          4,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(new protobuf.Field("icon", 5, "eve_public.ui.icon.Identifier"))
      .add(
        new protobuf.Field(
          "unset_description",
          6,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(new protobuf.Field("no_unset_description", 7, "bool"))
      .add(new protobuf.Field("optional", 8, "bool"))
      .add(new protobuf.Field("max_entries", 9, "uint32"))
      .add(new protobuf.Field("accepted_value_types", 10, "string", "repeated")),
  );
  definitionNamespace.add(
    new protobuf.Type("Parameter")
      .add(
        new protobuf.Field(
          "matcher",
          1,
          "eve_public.freelance.contributionmethod.definition.MatcherParameter",
        ),
      )
      .add(
        new protobuf.Field(
          "options",
          2,
          "eve_public.freelance.contributionmethod.definition.OptionsParameter",
        ),
      )
      .add(
        new protobuf.Field(
          "boolean",
          3,
          "eve_public.freelance.contributionmethod.definition.BooleanParameter",
        ),
      )
      .add(
        new protobuf.Field(
          "corporation_item_delivery",
          4,
          "eve_public.freelance.contributionmethod.definition.CorporationItemDeliveryParameter",
        ),
      ),
  );
  definitionNamespace.add(
    new protobuf.Type("Attributes")
      .add(
        new protobuf.Field(
          "title",
          1,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "description",
          2,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "progress_description",
          3,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "target_description",
          4,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "reward_description",
          5,
          "eve_public.localization.message.Identifier",
        ),
      )
      .add(new protobuf.Field("icon", 6, "eve_public.ui.icon.Identifier"))
      .add(new protobuf.Field("contribution_multiplier_allowed", 8, "bool"))
      .add(new protobuf.Field("max_contributions_per_participant_allowed", 9, "bool"))
      .add(new protobuf.Field("max_progress_per_contribution_allowed", 10, "bool"))
      .add(
        new protobuf.Field(
          "content_tags",
          7,
          "eve_public.ui.contenttag.Identifier",
          "repeated",
        ),
      )
      .add(
        new protobuf.Field(
          "parameters",
          11,
          "eve_public.freelance.contributionmethod.definition.Parameter",
          "repeated",
        ),
      )
      .add(
        new protobuf.Field(
          "contribution_multiplier",
          12,
          "eve_public.freelance.contributionmethod.definition.ContributionMultiplier",
        ),
      )
      .add(new protobuf.Field("contribution_multiplier_disabled", 13, "bool"))
      .add(
        new protobuf.Field(
          "max_contributions_per_participant",
          14,
          "eve_public.freelance.contributionmethod.definition.MaxContributionsPerParticipant",
        ),
      )
      .add(
        new protobuf.Field(
          "max_contributions_per_participant_disabled",
          15,
          "bool",
        ),
      )
      .add(
        new protobuf.Field(
          "max_progress_per_contribution",
          16,
          "eve_public.freelance.contributionmethod.definition.MaxProgressPerContribution",
        ),
      )
      .add(
        new protobuf.Field("max_progress_per_contribution_disabled", 17, "bool"),
      ),
  );
}

function addContributionDefinitionApiTypes(root) {
  const apiNamespace = root.define(
    "eve_public.freelance.contributionmethod.definition.api",
  );
  apiNamespace.add(
    new protobuf.Type("GetAllLatestRequest")
      .add(
        new protobuf.Field(
          "known_version",
          1,
          "eve_public.semanticversion.Specification",
        ),
      )
      .add(new protobuf.Field("no_known_version", 2, "bool")),
  );

  const latestDefinition = new protobuf.Type("Definition")
    .add(
      new protobuf.Field(
        "id",
        1,
        "eve_public.freelance.contributionmethod.definition.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "attributes",
        2,
        "eve_public.freelance.contributionmethod.definition.Attributes",
      ),
    );
  apiNamespace.add(
    new protobuf.Type("GetAllLatestResponse")
      .add(
        new protobuf.Field(
          "version",
          1,
          "eve_public.semanticversion.Specification",
        ),
      )
      .add(new protobuf.Field("definitions", 2, "Definition", "repeated"))
      .add(latestDefinition),
  );

  apiNamespace.add(
    new protobuf.Type("GetAllLatestWithinMajorRequest")
      .add(new protobuf.Field("major", 1, "uint32"))
      .add(
        new protobuf.Field(
          "known_version",
          2,
          "eve_public.semanticversion.Specification",
        ),
      )
      .add(new protobuf.Field("no_known_version", 3, "bool")),
  );

  const latestWithinMajorDefinition = new protobuf.Type("Definition")
    .add(
      new protobuf.Field(
        "id",
        1,
        "eve_public.freelance.contributionmethod.definition.Identifier",
      ),
    )
    .add(
      new protobuf.Field(
        "attributes",
        2,
        "eve_public.freelance.contributionmethod.definition.Attributes",
      ),
    );
  apiNamespace.add(
    new protobuf.Type("GetAllLatestWithinMajorResponse")
      .add(
        new protobuf.Field(
          "version",
          1,
          "eve_public.semanticversion.Specification",
        ),
      )
      .add(new protobuf.Field("definitions", 2, "Definition", "repeated"))
      .add(latestWithinMajorDefinition),
  );
}

function addContributionConfigurationTypes(root) {
  const namespace = root.define("eve_public.freelance.contributionmethod");

  const matcher = new protobuf.Type("MatcherParameterConfiguration").add(
    new protobuf.Field("values", 1, "ValueEntry", "repeated"),
  );
  matcher.add(
    new protobuf.Type("ValueEntry")
      .add(new protobuf.Field("value_type", 1, "string"))
      .add(new protobuf.Field("values", 2, "string", "repeated")),
  );
  namespace.add(matcher);
  namespace.add(
    new protobuf.Type("OptionsParameterConfiguration").add(
      new protobuf.Field("selected", 1, "string", "repeated"),
    ),
  );
  namespace.add(
    new protobuf.Type("BooleanParameterConfiguration").add(
      new protobuf.Field("value", 1, "bool"),
    ),
  );
  namespace.add(
    new protobuf.Type("CorporationItemDeliveryConfiguration")
      .add(
        new protobuf.Field(
          "item_type",
          1,
          "eve_public.freelance.contributionmethod.MatcherParameterConfiguration",
        ),
      )
      .add(
        new protobuf.Field(
          "corporation_office_location",
          2,
          "eve_public.freelance.contributionmethod.MatcherParameterConfiguration",
        ),
      ),
  );
  namespace.add(
    new protobuf.Type("ParameterConfiguration")
      .add(new protobuf.Field("key", 1, "string"))
      .add(
        new protobuf.Field(
          "matcher",
          2,
          "eve_public.freelance.contributionmethod.MatcherParameterConfiguration",
        ),
      )
      .add(
        new protobuf.Field(
          "options",
          3,
          "eve_public.freelance.contributionmethod.OptionsParameterConfiguration",
        ),
      )
      .add(
        new protobuf.Field(
          "boolean",
          4,
          "eve_public.freelance.contributionmethod.BooleanParameterConfiguration",
        ),
      )
      .add(
        new protobuf.Field(
          "corporation_item_delivery",
          5,
          "eve_public.freelance.contributionmethod.CorporationItemDeliveryConfiguration",
        ),
      ),
  );
  namespace.add(
    new protobuf.Type("Configuration")
      .add(
        new protobuf.Field(
          "contribution_method",
          1,
          "eve_public.freelance.contributionmethod.definition.Identifier",
        ),
      )
      .add(
        new protobuf.Field(
          "version",
          2,
          "eve_public.semanticversion.Specification",
        ),
      )
      .add(
        new protobuf.Field(
          "parameters",
          3,
          "eve_public.freelance.contributionmethod.ParameterConfiguration",
          "repeated",
        ),
      ),
  );
}

function addProjectRuntimeTypes(root) {
  const namespace = root.define("eve_public.freelance.project");
  namespace.add(
    new protobuf.Type("Identifier").add(new protobuf.Field("uuid", 1, "bytes")),
  );
  namespace.add(
    new protobuf.Type("Reward").add(
      new protobuf.Field("payout_per_unit", 1, "eve_public.isk.Currency"),
    ),
  );
  namespace.add(
    new protobuf.Type("CharacterAgeRestriction")
      .add(new protobuf.Field("no_max_age", 1, "bool"))
      .add(new protobuf.Field("max_age", 2, "uint64"))
      .add(new protobuf.Field("no_min_age", 3, "bool"))
      .add(new protobuf.Field("min_age", 4, "uint64")),
  );
  namespace.add(
    new protobuf.Type("ParticipationRestrictions")
      .add(
        new protobuf.Field(
          "age_restriction",
          1,
          "eve_public.freelance.project.CharacterAgeRestriction",
        ),
      )
      .add(new protobuf.Field("max_committed_participants", 2, "uint32")),
  );
  namespace.add(
    new protobuf.Type("ContributionModifiers")
      .add(new protobuf.Field("contributions_per_participant_unlimited", 1, "bool"))
      .add(new protobuf.Field("contributions_per_participant_limit", 2, "uint64"))
      .add(new protobuf.Field("progress_per_contribution_unlimited", 3, "bool"))
      .add(new protobuf.Field("progress_per_contribution_limit", 4, "uint64"))
      .add(new protobuf.Field("default_multiplier", 5, "bool"))
      .add(new protobuf.Field("scalar_multiplier", 6, "double")),
  );
  namespace.add(
    new protobuf.Type("BroadcastLocations").add(
      new protobuf.Field(
        "solar_systems",
        1,
        "eve_public.solarsystem.Identifier",
        "repeated",
      ),
    ),
  );
  namespace.add(
    new protobuf.Type("CreationCost")
      .add(new protobuf.Field("base_fee", 1, "eve_public.isk.Currency"))
      .add(new protobuf.Field("broadcasting_fee", 2, "eve_public.isk.Currency"))
      .add(new protobuf.Field("reward_deposit", 3, "eve_public.isk.Currency"))
      .add(new protobuf.Field("total_cost", 4, "eve_public.isk.Currency")),
  );
  namespace.add(
    new protobuf.Type("CreationPrices")
      .add(
        new protobuf.Field(
          "base_fee_per_day",
          1,
          "eve_public.isk.Currency",
        ),
      )
      .add(
        new protobuf.Field(
          "broadcasting_fee_per_day_per_location",
          2,
          "eve_public.isk.Currency",
        ),
      ),
  );
  namespace.add(
    new protobuf.Type("AdminDetails")
      .add(new protobuf.Field("no_acl", 1, "bool"))
      .add(new protobuf.Field("acl", 2, "eve_public.acl.Identifier")),
  );
  namespace.add(
    new protobuf.Type("Attributes")
      .add(new protobuf.Field("owner", 1, "eve_public.corporation.Identifier"))
      .add(new protobuf.Field("creator", 2, "eve_public.character.Identifier"))
      .add(new protobuf.Field("state", 3, "int32"))
      .add(new protobuf.Field("name", 4, "string"))
      .add(new protobuf.Field("description", 5, "string"))
      .add(new protobuf.Field("career", 6, "int32"))
      .add(new protobuf.Field("deadline", 7, "google.protobuf.Timestamp"))
      .add(new protobuf.Field("created", 8, "google.protobuf.Timestamp"))
      .add(new protobuf.Field("not_finished", 9, "bool"))
      .add(new protobuf.Field("finish_time", 10, "google.protobuf.Timestamp"))
      .add(new protobuf.Field("target_progress", 11, "uint64"))
      .add(new protobuf.Field("current_progress", 12, "uint64"))
      .add(new protobuf.Field("committed_participants", 13, "uint32"))
      .add(new protobuf.Field("total_participants", 14, "uint32"))
      .add(new protobuf.Field("total_contributors", 15, "uint32"))
      .add(
        new protobuf.Field(
          "contribution_modifiers",
          16,
          "eve_public.freelance.project.ContributionModifiers",
        ),
      )
      .add(
        new protobuf.Field(
          "participation_restrictions",
          17,
          "eve_public.freelance.project.ParticipationRestrictions",
        ),
      )
      .add(
        new protobuf.Field(
          "broadcast_locations",
          18,
          "eve_public.freelance.project.BroadcastLocations",
        ),
      )
      .add(new protobuf.Field("reward", 19, "eve_public.freelance.project.Reward"))
      .add(
        new protobuf.Field(
          "configuration",
          20,
          "eve_public.freelance.contributionmethod.Configuration",
        ),
      ),
  );
}

function addProjectLimitTypes(root) {
  root.define("eve_public.freelance.project.api").add(
    new protobuf.Type("GetCommitLimitsResponse")
      .add(
        new protobuf.Field(
          "max_active_projects_per_participant",
          1,
          "uint32",
        ),
      )
      .add(
        new protobuf.Field(
          "max_committed_participants_per_project",
          2,
          "uint32",
        ),
      ),
  );
  root.define("eve_public.freelance.project.api").add(
    new protobuf.Type("GetCreationLimitsResponse")
      .add(
        new protobuf.Field(
          "max_active_projects_per_corporation",
          1,
          "uint32",
        ),
      )
      .add(
        new protobuf.Field(
          "max_active_projects_broadcast_per_system",
          2,
          "uint32",
        ),
      )
      .add(new protobuf.Field("max_character_age_days", 3, "uint32"))
      .add(
        new protobuf.Field(
          "max_broadcasting_locations_per_project",
          4,
          "uint32",
        ),
      )
      .add(
        new protobuf.Field(
          "max_committed_participants_per_project",
          5,
          "uint32",
        ),
      )
      .add(new protobuf.Field("max_contribution_multiplier", 6, "double"))
      .add(
        new protobuf.Field(
          "max_project_duration",
          7,
          "google.protobuf.Duration",
        ),
      ),
  );
  root.define("eve_public.freelance.project.api").add(
    new protobuf.Type("GetCreationPricesResponse").add(
      new protobuf.Field("prices", 1, "eve_public.freelance.project.CreationPrices"),
    ),
  );
}

function addProjectApiTypes(root) {
  const namespace = root.define("eve_public.freelance.project.api");

  namespace.add(
    new protobuf.Type("CreateRequest")
      .add(new protobuf.Field("name", 1, "string"))
      .add(new protobuf.Field("description", 2, "string"))
      .add(new protobuf.Field("target_progress", 3, "uint64"))
      .add(new protobuf.Field("career", 4, "int32"))
      .add(new protobuf.Field("deadline", 5, "google.protobuf.Timestamp"))
      .add(
        new protobuf.Field(
          "configuration",
          6,
          "eve_public.freelance.contributionmethod.Configuration",
        ),
      )
      .add(
        new protobuf.Field(
          "contribution_modifiers",
          7,
          "eve_public.freelance.project.ContributionModifiers",
        ),
      )
      .add(
        new protobuf.Field(
          "participation_restrictions",
          8,
          "eve_public.freelance.project.ParticipationRestrictions",
        ),
      )
      .add(
        new protobuf.Field(
          "broadcast_locations",
          9,
          "eve_public.freelance.project.BroadcastLocations",
        ),
      )
      .add(new protobuf.Field("reward", 10, "eve_public.freelance.project.Reward"))
      .add(
        new protobuf.Field(
          "expected_cost",
          11,
          "eve_public.freelance.project.CreationCost",
        ),
      )
      .add(new protobuf.Field("acl", 12, "eve_public.acl.Identifier"))
      .add(new protobuf.Field("no_acl", 13, "bool")),
  );

  const createResponse = new protobuf.Type("CreateResponse")
    .add(new protobuf.Field("created", 1, "Created"))
    .add(new protobuf.Field("unspecified_error", 2, "bool"))
    .add(
      new protobuf.Field(
        "max_active_projects_per_corporation_reached",
        3,
        "MaxActiveProjectsPerCorporationReached",
      ),
    )
    .add(
      new protobuf.Field(
        "invalid_broadcasting_locations",
        4,
        "InvalidBroadcastingLocations",
      ),
    )
    .add(new protobuf.Field("cannot_manage_projects", 5, "CannotManageProjects"))
    .add(
      new protobuf.Field(
        "max_active_projects_broadcast_per_system_reached",
        6,
        "MaxBroadcastProjectsPerSolarSystemReached",
      ),
    )
    .add(
      new protobuf.Field(
        "outdated_contribution_methods",
        7,
        "OutdatedContributionMethodConfiguration",
      ),
    )
    .add(new protobuf.Field("outdated_project_cost", 8, "OutdatedProjectCost"))
    .add(new protobuf.Field("invalid_delivery_locations", 9, "InvalidDeliveryLocations"))
    .add(new protobuf.Field("cannot_manage_acl", 10, "CannotManageACL"));
  createResponse
    .add(
      new protobuf.Type("Created").add(
        new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
      ),
    )
    .add(
      new protobuf.Type("MaxActiveProjectsPerCorporationReached").add(
        new protobuf.Field("limit", 1, "uint32"),
      ),
    )
    .add(
      new protobuf.Type("InvalidBroadcastingLocations").add(
        new protobuf.Field(
          "solar_systems",
          1,
          "eve_public.solarsystem.Identifier",
          "repeated",
        ),
      ),
    )
    .add(new protobuf.Type("CannotManageProjects"))
    .add(
      new protobuf.Type("MaxBroadcastProjectsPerSolarSystemReached")
        .add(new protobuf.Field("limit", 1, "uint32"))
        .add(
          new protobuf.Field(
            "solar_systems",
            2,
            "eve_public.solarsystem.Identifier",
            "repeated",
          ),
        ),
    )
    .add(new protobuf.Type("OutdatedContributionMethodConfiguration"))
    .add(new protobuf.Type("OutdatedProjectCost"))
    .add(new protobuf.Type("CannotManageACL"))
    .add(
      new protobuf.Type("InvalidDeliveryLocations")
        .add(
          new protobuf.Field(
            "not_found",
            1,
            "eve_public.freelance.contributionmethod.itemdelivery.DeliveryLocation",
            "repeated",
          ),
        )
        .add(
          new protobuf.Field(
            "no_active_office",
            2,
            "eve_public.freelance.contributionmethod.itemdelivery.DeliveryLocation",
            "repeated",
          ),
        )
        .add(
          new protobuf.Field(
            "not_in_full_power",
            3,
            "eve_public.freelance.contributionmethod.itemdelivery.DeliveryLocation",
            "repeated",
          ),
        ),
    );
  namespace.add(createResponse);

  addProjectMutationTypes(namespace);
  addProjectReadTypes(namespace);
}

function addProjectMutationTypes(namespace) {
  namespace.add(
    new protobuf.Type("CloseRequest").add(
      new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
    ),
  );
  const closeResponse = new protobuf.Type("CloseResponse")
    .add(new protobuf.Field("closed", 1, "Closed"))
    .add(new protobuf.Field("unspecified_error", 2, "bool"))
    .add(new protobuf.Field("cannot_manage_projects", 3, "CannotManageProjects"))
    .add(new protobuf.Field("invalid_project_state", 4, "InvalidProjectState"));
  closeResponse
    .add(new protobuf.Type("Closed"))
    .add(new protobuf.Type("CannotManageProjects"))
    .add(new protobuf.Type("InvalidProjectState"));
  namespace.add(closeResponse);

  namespace.add(
    new protobuf.Type("CommitRequest").add(
      new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
    ),
  );
  const commitResponse = new protobuf.Type("CommitResponse")
    .add(new protobuf.Field("committed", 1, "Committed"))
    .add(new protobuf.Field("unspecified_error", 2, "bool"))
    .add(new protobuf.Field("invalid_project_state", 3, "InvalidProjectState"))
    .add(new protobuf.Field("invalid_participation_state", 4, "InvalidParticipationState"))
    .add(
      new protobuf.Field(
        "max_committed_participants_per_project",
        5,
        "MaxCommittedParticipantsPerProject",
      ),
    )
    .add(
      new protobuf.Field(
        "max_projects_committed_per_participant",
        6,
        "MaxProjectsCommittedPerParticipant",
      ),
    )
    .add(new protobuf.Field("invalid_character_age", 7, "InvalidCharacterAge"))
    .add(new protobuf.Field("restricted", 8, "Restricted"));
  commitResponse
    .add(new protobuf.Type("Committed"))
    .add(new protobuf.Type("InvalidProjectState"))
    .add(new protobuf.Type("InvalidParticipationState"))
    .add(new protobuf.Type("MaxCommittedParticipantsPerProject"))
    .add(new protobuf.Type("MaxProjectsCommittedPerParticipant"))
    .add(
      new protobuf.Type("InvalidCharacterAge").add(
        new protobuf.Field(
          "character_age_restriction",
          1,
          "eve_public.freelance.project.CharacterAgeRestriction",
        ),
      ),
    )
    .add(new protobuf.Type("Restricted"));
  namespace.add(commitResponse);

  namespace.add(
    new protobuf.Type("ResignRequest").add(
      new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
    ),
  );
  const resignResponse = new protobuf.Type("ResignResponse")
    .add(new protobuf.Field("resigned", 1, "Resigned"))
    .add(new protobuf.Field("unspecified_error", 2, "bool"))
    .add(new protobuf.Field("invalid_project_state", 3, "InvalidProjectState"))
    .add(new protobuf.Field("invalid_participation_state", 4, "InvalidParticipationState"));
  resignResponse
    .add(new protobuf.Type("Resigned"))
    .add(new protobuf.Type("InvalidProjectState"))
    .add(new protobuf.Type("InvalidParticipationState"));
  namespace.add(resignResponse);

  namespace.add(
    new protobuf.Type("KickRequest")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("participant", 2, "eve_public.character.Identifier")),
  );
  const kickResponse = new protobuf.Type("KickResponse")
    .add(new protobuf.Field("kicked", 1, "Kicked"))
    .add(new protobuf.Field("unspecified_error", 2, "bool"))
    .add(new protobuf.Field("cannot_manage_projects", 3, "CannotManageProjects"))
    .add(new protobuf.Field("invalid_project_state", 4, "InvalidProjectState"))
    .add(new protobuf.Field("invalid_participation_state", 5, "InvalidParticipationState"));
  kickResponse
    .add(new protobuf.Type("Kicked"))
    .add(new protobuf.Type("CannotManageProjects"))
    .add(new protobuf.Type("InvalidProjectState"))
    .add(new protobuf.Type("InvalidParticipationState"));
  namespace.add(kickResponse);

  namespace.add(
    new protobuf.Type("RedeemRewardRequest").add(
      new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
    ),
  );
  namespace.add(new protobuf.Type("RedeemRewardResponse"));
}

function addProjectReadTypes(namespace) {
  namespace.add(
    new protobuf.Type("GetRequest").add(
      new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
    ),
  );
  namespace.add(
    new protobuf.Type("GetResponse")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Attributes"))
      .add(new protobuf.Field("state", 2, "int32"))
      .add(new protobuf.Field("progress", 3, "uint64"))
      .add(new protobuf.Field("units_unredeemed", 4, "uint64")),
  );
  namespace.add(
    new protobuf.Type("GetForManagerRequest").add(
      new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
    ),
  );
  namespace.add(
    new protobuf.Type("GetForManagerResponse")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Attributes"))
      .add(
        new protobuf.Field(
          "admin_project_details",
          2,
          "eve_public.freelance.project.AdminDetails",
        ),
      )
      .add(new protobuf.Field("state", 3, "int32"))
      .add(new protobuf.Field("progress", 4, "uint64"))
      .add(new protobuf.Field("units_unredeemed", 5, "uint64")),
  );
  namespace.add(
    new protobuf.Type("GetAllBroadcastedRequest").add(
      new protobuf.Field(
        "solar_systems",
        1,
        "eve_public.solarsystem.Identifier",
        "repeated",
      ),
    ),
  );
  const broadcastedResponse = new protobuf.Type("GetAllBroadcastedResponse").add(
    new protobuf.Field("broadcasted", 1, "Broadcasted", "repeated"),
  );
  broadcastedResponse.add(
    new protobuf.Type("Broadcasted")
      .add(new protobuf.Field("solar_system", 1, "eve_public.solarsystem.Identifier"))
      .add(
        new protobuf.Field(
          "projects",
          2,
          "eve_public.freelance.project.Identifier",
          "repeated",
        ),
      ),
  );
  namespace.add(broadcastedResponse);
  namespace.add(new protobuf.Type("GetAllCommittedRequest"));
  namespace.add(
    new protobuf.Type("GetAllCommittedResponse").add(
      new protobuf.Field(
        "projects",
        1,
        "eve_public.freelance.project.Identifier",
        "repeated",
      ),
    ),
  );
  namespace.add(
    new protobuf.Type("GetAllUnredeemedRequest").add(
      new protobuf.Field("page", 1, "eve_public.Page"),
    ),
  );
  namespace.add(
    new protobuf.Type("GetAllUnredeemedResponse")
      .add(
        new protobuf.Field(
          "projects",
          1,
          "eve_public.freelance.project.Identifier",
          "repeated",
        ),
      )
      .add(new protobuf.Field("next_page", 2, "eve_public.NextPage")),
  );
  namespace.add(
    new protobuf.Type("GetAllActiveForCorporationRequest").add(
      new protobuf.Field("corporation", 1, "eve_public.corporation.Identifier"),
    ),
  );
  namespace.add(
    new protobuf.Type("GetAllActiveForCorporationResponse").add(
      new protobuf.Field(
        "projects",
        1,
        "eve_public.freelance.project.Identifier",
        "repeated",
      ),
    ),
  );
  namespace.add(new protobuf.Type("GetAllActiveRequest"));
  namespace.add(
    new protobuf.Type("GetAllActiveResponse").add(
      new protobuf.Field(
        "projects",
        1,
        "eve_public.freelance.project.Identifier",
        "repeated",
      ),
    ),
  );
  namespace.add(
    new protobuf.Type("GetAllInactiveRequest")
      .add(new protobuf.Field("start_time", 1, "google.protobuf.Timestamp"))
      .add(new protobuf.Field("duration", 2, "google.protobuf.Duration"))
      .add(new protobuf.Field("page", 3, "eve_public.Page")),
  );
  namespace.add(
    new protobuf.Type("GetAllInactiveResponse")
      .add(
        new protobuf.Field(
          "projects",
          1,
          "eve_public.freelance.project.Identifier",
          "repeated",
        ),
      )
      .add(new protobuf.Field("next_page", 2, "eve_public.NextPage")),
  );
  namespace.add(
    new protobuf.Type("GetParticipationDetailsRequest")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("page", 2, "eve_public.Page")),
  );
  const participantsResponse = new protobuf.Type("GetParticipationDetailsResponse")
    .add(new protobuf.Field("participants", 1, "LimitedParticipantView", "repeated"))
    .add(new protobuf.Field("next_page", 2, "eve_public.NextPage"));
  participantsResponse.add(
    new protobuf.Type("LimitedParticipantView")
      .add(new protobuf.Field("character", 1, "eve_public.character.Identifier"))
      .add(new protobuf.Field("state", 2, "int32"))
      .add(new protobuf.Field("progress", 3, "uint64")),
  );
  namespace.add(participantsResponse);
  namespace.add(
    new protobuf.Type("GetStatsRequest").add(
      new protobuf.Field(
        "projects",
        1,
        "eve_public.freelance.project.Identifier",
        "repeated",
      ),
    ),
  );
  const statsResponse = new protobuf.Type("GetStatsResponse")
    .add(new protobuf.Field("project_stats", 1, "ProjectStats", "repeated"))
    .add(
      new protobuf.Field(
        "redacted",
        2,
        "eve_public.freelance.project.Identifier",
        "repeated",
      ),
    );
  statsResponse.add(
    new protobuf.Type("ProjectStats")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("current_progress", 2, "uint64"))
      .add(new protobuf.Field("committed_participants", 3, "uint32"))
      .add(new protobuf.Field("total_participants", 4, "uint32"))
      .add(new protobuf.Field("total_contributors", 5, "uint32")),
  );
  namespace.add(statsResponse);
}

function addItemDeliveryTypes(root) {
  const itemDeliveryNamespace = root.define(
    "eve_public.freelance.contributionmethod.itemdelivery",
  );
  itemDeliveryNamespace.add(
    new protobuf.Type("Identifier").add(new protobuf.Field("uuid", 1, "bytes")),
  );
  itemDeliveryNamespace.add(
    new protobuf.Type("DeliveryLocation")
      .add(new protobuf.Field("station", 1, "eve_public.station.Identifier"))
      .add(new protobuf.Field("structure", 2, "eve_public.structure.Identifier")),
  );

  const namespace = root.define(
    "eve_public.freelance.contributionmethod.itemdelivery.api",
  );
  namespace.add(
    new protobuf.Type("DeliverRequest")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(
        new protobuf.Field(
          "delivery_location",
          2,
          "eve_public.freelance.contributionmethod.itemdelivery.DeliveryLocation",
        ),
      )
      .add(new protobuf.Field("item", 3, "eve_public.inventory.genericitem.Identifier"))
      .add(new protobuf.Field("quantity", 4, "uint32"))
      .add(new protobuf.Field("item_location", 5, "eve_public.inventory.genericitem.Location")),
  );
  const deliverResponse = new protobuf.Type("DeliverResponse")
    .add(new protobuf.Field("escrowed", 1, "Escrowed"))
    .add(new protobuf.Field("unspecified_error", 2, "bool"))
    .add(new protobuf.Field("delivery_location_does_not_exist", 3, "DeliveryLocationDoesNotExist"))
    .add(new protobuf.Field("delivery_location_not_in_full_power", 4, "DeliveryLocationNotInFullPower"))
    .add(new protobuf.Field("character_not_docked", 5, "CharacterNotDocked"))
    .add(new protobuf.Field("item_not_owned_by_deliverer", 6, "ItemNotOwnedByDeliverer"))
    .add(new protobuf.Field("invalid_item_location", 7, "InvalidItemLocation"))
    .add(new protobuf.Field("item_not_found_at_location", 8, "ItemNotFoundAtLocation"))
    .add(new protobuf.Field("invalid_item_type", 9, "InvalidItemType"))
    .add(new protobuf.Field("quantity_too_high", 10, "QuantityTooHigh"))
    .add(new protobuf.Field("character_not_committed", 11, "CharacterNotCommitted"))
    .add(new protobuf.Field("project_does_not_allow_item_delivery", 12, "ProjectDoesNotAllowItemDelivery"))
    .add(new protobuf.Field("project_does_not_exist", 13, "ProjectDoesNotExist"));
  deliverResponse
    .add(
      new protobuf.Type("Escrowed").add(
        new protobuf.Field(
          "delivery",
          1,
          "eve_public.freelance.contributionmethod.itemdelivery.Identifier",
        ),
      ),
    )
    .add(new protobuf.Type("DeliveryLocationDoesNotExist"))
    .add(new protobuf.Type("DeliveryLocationNotInFullPower"))
    .add(new protobuf.Type("CharacterNotDocked"))
    .add(new protobuf.Type("ItemNotOwnedByDeliverer"))
    .add(new protobuf.Type("InvalidItemLocation"))
    .add(new protobuf.Type("ItemNotFoundAtLocation"))
    .add(new protobuf.Type("InvalidItemType"))
    .add(buildQuantityTooHighType())
    .add(new protobuf.Type("CharacterNotCommitted"))
    .add(new protobuf.Type("ProjectDoesNotAllowItemDelivery"))
    .add(new protobuf.Type("ProjectDoesNotExist"));
  namespace.add(deliverResponse);
  namespace.add(
    new protobuf.Type("GetStatusRequest").add(
      new protobuf.Field(
        "delivery",
        1,
        "eve_public.freelance.contributionmethod.itemdelivery.Identifier",
      ),
    ),
  );
  const statusResponse = new protobuf.Type("GetStatusResponse")
    .add(new protobuf.Field("escrowed", 1, "Escrowed"))
    .add(new protobuf.Field("succeeded", 2, "ContributionSucceeded"))
    .add(new protobuf.Field("failed", 3, "ContributionFailed"));
  statusResponse
    .add(new protobuf.Type("Escrowed"))
    .add(
      new protobuf.Type("ContributionSucceeded")
        .add(new protobuf.Field("quantity_delivered", 1, "uint32"))
        .add(new protobuf.Field("quantity_returned", 2, "uint32")),
    )
    .add(new protobuf.Type("ContributionFailed"));
  namespace.add(statusResponse);

  namespace.add(
    new protobuf.Type("ContributionSucceededNotice")
      .add(
        new protobuf.Field(
          "delivery",
          1,
          "eve_public.freelance.contributionmethod.itemdelivery.Identifier",
        ),
      )
      .add(new protobuf.Field("contributed", 2, "uint64"))
      .add(new protobuf.Field("remainder", 3, "uint64")),
  );
  namespace.add(
    new protobuf.Type("ContributionFailedNotice").add(
      new protobuf.Field(
        "identifier",
        1,
        "eve_public.freelance.contributionmethod.itemdelivery.Identifier",
      ),
    ),
  );
}

function buildQuantityTooHighType() {
  const quantityTooHigh = new protobuf.Type("QuantityTooHigh")
    .add(new protobuf.Field("max_progress_per_contribution", 1, "MaxProgressPerContributionExceeded"))
    .add(
      new protobuf.Field(
        "max_remaining_participant_contributions",
        2,
        "MaxRemainingParticipantContributionsExceeded",
      ),
    )
    .add(
      new protobuf.Field(
        "max_remaining_project_contributions",
        3,
        "MaxRemainingProjectContributionsExceeded",
      ),
    );
  quantityTooHigh
    .add(
      new protobuf.Type("MaxProgressPerContributionExceeded").add(
        new protobuf.Field("max_quantity", 1, "uint32"),
      ),
    )
    .add(
      new protobuf.Type("MaxRemainingParticipantContributionsExceeded").add(
        new protobuf.Field("max_quantity", 1, "uint32"),
      ),
    )
    .add(
      new protobuf.Type("MaxRemainingProjectContributionsExceeded").add(
        new protobuf.Field("max_quantity", 1, "uint32"),
      ),
    );
  return quantityTooHigh;
}

function addProjectNoticeTypes(root) {
  const namespace = root.define("eve_public.freelance.project.api");
  namespace.add(
    new protobuf.Type("CreatedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("attributes", 2, "eve_public.freelance.project.Attributes"))
      .add(
        new protobuf.Field(
          "admin_project_details",
          3,
          "eve_public.freelance.project.AdminDetails",
        ),
      ),
  );
  for (const noticeType of ["CompletedNotice", "ClosedNotice", "ExpiredNotice"]) {
    namespace.add(
      new protobuf.Type(noticeType).add(
        new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"),
      ),
    );
  }
  namespace.add(
    new protobuf.Type("ProgressedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("total_project_progress", 2, "uint64"))
      .add(new protobuf.Field("total_contributors", 3, "uint32")),
  );
  namespace.add(
    new protobuf.Type("ParticipantAddedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("committed_participants", 2, "uint32"))
      .add(new protobuf.Field("total_participants", 3, "uint32")),
  );
  namespace.add(
    new protobuf.Type("ParticipantRemovedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("committed_participants", 2, "uint32")),
  );
  namespace.add(
    new protobuf.Type("ParticipantContributedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("participant", 2, "eve_public.character.Identifier"))
      .add(new protobuf.Field("total_participant_progress", 3, "uint64")),
  );
  namespace.add(
    new protobuf.Type("ParticipantRewardRedeemedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("participant", 2, "eve_public.character.Identifier")),
  );
  namespace.add(
    new protobuf.Type("ParticipantKickedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("participant", 2, "eve_public.character.Identifier")),
  );
  namespace.add(
    new protobuf.Type("AclDeletedNotice")
      .add(new protobuf.Field("project", 1, "eve_public.freelance.project.Identifier"))
      .add(new protobuf.Field("acl", 2, "eve_public.acl.Identifier")),
  );
}

function buildFreelanceProtoRoot() {
  const root = new protobuf.Root();
  addCommonIdentifierTypes(root);
  addSemanticVersionTypes(root);
  addContributionDefinitionTypes(root);
  addContributionConfigurationTypes(root);
  addContributionDefinitionApiTypes(root);
  addProjectRuntimeTypes(root);
  addItemDeliveryTypes(root);
  addProjectApiTypes(root);
  addProjectNoticeTypes(root);
  addProjectLimitTypes(root);
  root.resolveAll();
  return root;
}

function decodePayload(messageType, requestEnvelope) {
  return messageType.decode(
    bufferFromBytes(requestEnvelope && requestEnvelope.payload && requestEnvelope.payload.value),
  );
}

function buildCurrency(value) {
  const amount = Number(value || 0);
  const units = Math.trunc(amount);
  const nanos = Math.round((amount - units) * 1000000000);
  return {
    units,
    nanos,
  };
}

function buildMessageIdentifier(id) {
  return {
    sequential: Number(id || 0),
  };
}

function buildIconIdentifier(name) {
  return {
    name: String(name || ""),
  };
}

function buildContentTagIdentifier(tag) {
  return {
    name: String(tag && tag.id ? tag.id : tag || ""),
  };
}

function buildSemanticVersion(version = CONTRIBUTION_METHOD_VERSION) {
  return {
    major: Number(version.major || 0),
    minor: Number(version.minor || 0),
    patch: Number(version.patch || 0),
    prerelease_tags: Array.isArray(version.prerelease_tags)
      ? version.prerelease_tags.map((tag) => String(tag))
      : [],
    build_tags: Array.isArray(version.build_tags)
      ? version.build_tags.map((tag) => String(tag))
      : [],
  };
}

function buildRepresentationPayload(parameter) {
  return {
    icon: buildIconIdentifier(parameter.icon),
    title: buildMessageIdentifier(parameter.title),
    description: buildMessageIdentifier(parameter.description),
    unset_description: buildMessageIdentifier(parameter.unsetDescription),
  };
}

function buildContributionMultiplierPayload(parameter) {
  return {
    representation: buildRepresentationPayload(parameter),
    value: Number(parameter.defaultValue),
    maximum_value: Number(parameter.maxValue),
    minimum_value: Number(parameter.minValue),
  };
}

function buildLimitPayload(parameter) {
  const payload = {
    representation: buildRepresentationPayload(parameter),
  };
  if (parameter.defaultValue === null || parameter.defaultValue === undefined) {
    payload.no_default_value = true;
  } else {
    payload.value = Number(parameter.defaultValue || 0);
  }
  return payload;
}

function buildParameterPayload(parameter) {
  if (parameter.kind === "matcher") {
    const matcher = {
      key: parameter.key,
      type: parameter.type,
      title: buildMessageIdentifier(parameter.title),
      description: buildMessageIdentifier(parameter.description),
      icon: buildIconIdentifier(parameter.icon),
      optional: Boolean(parameter.optional),
      max_entries: Number(parameter.maxEntries || 0),
      accepted_value_types: parameter.acceptedValueTypes || [],
    };
    if (parameter.unsetDescription) {
      matcher.unset_description = buildMessageIdentifier(parameter.unsetDescription);
    } else {
      matcher.no_unset_description = true;
    }
    return { matcher };
  }

  if (parameter.kind === "options") {
    return {
      options: {
        key: parameter.key,
        title: buildMessageIdentifier(parameter.title),
        description: buildMessageIdentifier(parameter.description),
        icon: buildIconIdentifier(parameter.icon),
        max_entries: Number(parameter.maxEntries || 0),
        options: (parameter.options || []).map((option) => ({
          key: option.key,
          title: buildMessageIdentifier(option.title),
          description: buildMessageIdentifier(option.description),
        })),
        default_option_key: parameter.defaultOptionKey || "",
      },
    };
  }

  if (parameter.kind === "boolean") {
    return {
      boolean: {
        key: parameter.key,
        title: buildMessageIdentifier(parameter.title),
        description: buildMessageIdentifier(parameter.description),
        icon: buildIconIdentifier(parameter.icon),
        choice_label_id: buildMessageIdentifier(parameter.choiceLabel),
        option_true: {
          title_id: buildMessageIdentifier(parameter.optionTrue.title),
          description_id: buildMessageIdentifier(parameter.optionTrue.description),
        },
        option_false: {
          title_id: buildMessageIdentifier(parameter.optionFalse.title),
          description_id: buildMessageIdentifier(parameter.optionFalse.description),
        },
        default: Boolean(parameter.defaultValue),
      },
    };
  }

  if (parameter.kind === "corporation_item_delivery") {
    return {
      corporation_item_delivery: {
        key: parameter.key,
        title: buildMessageIdentifier(parameter.title),
        description: buildMessageIdentifier(parameter.description),
        icon: buildIconIdentifier(parameter.icon),
        inventory_type: {
          title: buildMessageIdentifier(parameter.inventoryType.title),
          description: buildMessageIdentifier(parameter.inventoryType.description),
          icon: buildIconIdentifier(parameter.inventoryType.icon),
          unset_description: buildMessageIdentifier(
            parameter.inventoryType.unsetDescription,
          ),
          accepted_value_types:
            parameter.inventoryType.acceptedValueTypes || [],
        },
        delivery_location: {
          title: buildMessageIdentifier(parameter.deliveryLocation.title),
          description: buildMessageIdentifier(parameter.deliveryLocation.description),
          icon: buildIconIdentifier(parameter.deliveryLocation.icon),
          unset_description: buildMessageIdentifier(
            parameter.deliveryLocation.unsetDescription,
          ),
          max_entries: Number(parameter.deliveryLocation.maxEntries || 0),
          accepted_value_types:
            parameter.deliveryLocation.acceptedValueTypes || [],
        },
      },
    };
  }

  return {};
}

function buildDefinitionPayload(definition) {
  const attributes = {
    title: buildMessageIdentifier(definition.title),
    description: buildMessageIdentifier(definition.description),
    progress_description: buildMessageIdentifier(definition.progressDescription),
    target_description: buildMessageIdentifier(definition.targetDescription),
    reward_description: buildMessageIdentifier(definition.rewardDescription),
    icon: buildIconIdentifier(definition.icon),
    content_tags: (definition.contentTags || []).map(buildContentTagIdentifier),
    parameters: (definition.parameters || []).map(buildParameterPayload),
  };

  if (definition.contributionMultiplier) {
    attributes.contribution_multiplier = buildContributionMultiplierPayload(
      definition.contributionMultiplier,
    );
  } else {
    attributes.contribution_multiplier_disabled = true;
  }

  if (definition.maxContributionsPerParticipant) {
    attributes.max_contributions_per_participant = buildLimitPayload(
      definition.maxContributionsPerParticipant,
    );
  } else {
    attributes.max_contributions_per_participant_disabled = true;
  }

  if (definition.maxProgressPerContribution) {
    attributes.max_progress_per_contribution = buildLimitPayload(
      definition.maxProgressPerContribution,
    );
  } else {
    attributes.max_progress_per_contribution_disabled = true;
  }

  return {
    id: {
      name: definition.name,
    },
    attributes,
  };
}

function buildDefinitionResponsePayload() {
  return {
    version: buildSemanticVersion(CONTRIBUTION_METHOD_VERSION),
    definitions: CONTRIBUTION_METHOD_DEFINITIONS.map(buildDefinitionPayload),
  };
}

function buildErrorResult(requestTypeName, statusCode, errorCode = "") {
  return {
    statusCode,
    statusMessage: String(errorCode || ""),
    responseTypeName: requestTypeName.replace(/Request$/, "Response"),
    responsePayloadBuffer: Buffer.alloc(0),
  };
}

function hasCurrentKnownVersion(decoded) {
  if (!decoded || !decoded.known_version) {
    return false;
  }
  return compareSemver(
    buildSemanticVersion(decoded.known_version),
    CONTRIBUTION_METHOD_VERSION,
  ) === 0;
}

function toInteger(value, fallback = 0) {
  if (value && typeof value.toNumber === "function") {
    const numericLong = value.toNumber();
    return Number.isFinite(numericLong) ? Math.trunc(numericLong) : fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toNumber(value, fallback = 0) {
  if (value && typeof value.toNumber === "function") {
    const numericLong = value.toNumber();
    return Number.isFinite(numericLong) ? numericLong : fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toProjectUUID(value) {
  return uuidBufferToString(value && value.uuid);
}

function buildProjectIdentifier(projectID) {
  return {
    uuid: uuidStringToBuffer(projectID),
  };
}

function buildSequentialIdentifier(id) {
  return {
    sequential: Math.max(0, toInteger(id, 0)),
  };
}

function getRequestCharacterID(requestEnvelope) {
  return getActiveCharacterID(requestEnvelope);
}

function getCharacterCorporationID(characterID) {
  const record = getCharacterRecord(characterID);
  return Math.max(
    0,
    toInteger(record && (record.corporationID || record.corpid), 0),
  );
}

function messageToPlain(messageType, message) {
  if (!message) {
    return {};
  }
  return messageType.toObject(message, {
    bytes: Array,
    defaults: false,
    enums: Number,
    longs: String,
    oneofs: false,
  });
}

function buildContributionModifiersPayload(project) {
  const modifiers = project.contributionModifiers || {};
  const payload = {};
  if (modifiers.contributionsPerParticipantLimit === null ||
      modifiers.contributionsPerParticipantLimit === undefined) {
    payload.contributions_per_participant_unlimited = true;
  } else {
    payload.contributions_per_participant_limit = Math.max(
      0,
      toInteger(modifiers.contributionsPerParticipantLimit, 0),
    );
  }
  if (modifiers.progressPerContributionLimit === null ||
      modifiers.progressPerContributionLimit === undefined) {
    payload.progress_per_contribution_unlimited = true;
  } else {
    payload.progress_per_contribution_limit = Math.max(
      0,
      toInteger(modifiers.progressPerContributionLimit, 0),
    );
  }
  const multiplier = toNumber(modifiers.scalarMultiplier, 1);
  if (multiplier && multiplier !== 1) {
    payload.scalar_multiplier = multiplier;
  } else {
    payload.default_multiplier = true;
  }
  return payload;
}

function buildCharacterAgeRestrictionPayload(restrictions = {}) {
  const payload = {};
  if (
    restrictions.maxCharacterAgeDays === null ||
    restrictions.maxCharacterAgeDays === undefined
  ) {
    payload.no_max_age = true;
  } else {
    payload.max_age = Math.max(0, toInteger(restrictions.maxCharacterAgeDays, 0));
  }
  if (
    restrictions.minCharacterAgeDays === null ||
    restrictions.minCharacterAgeDays === undefined
  ) {
    payload.no_min_age = true;
  } else {
    payload.min_age = Math.max(0, toInteger(restrictions.minCharacterAgeDays, 0));
  }
  return payload;
}

function buildParticipationRestrictionsPayload(project) {
  const restrictions = project.participationRestrictions || {};
  return {
    age_restriction: buildCharacterAgeRestrictionPayload(restrictions),
    max_committed_participants: Math.max(
      1,
      toInteger(restrictions.maxCommittedParticipants, 1),
    ),
  };
}

function buildProjectAttributesPayload(project) {
  const finishTimeMs = toInteger(project.finishTimeMs, 0);
  const payload = {
    owner: buildSequentialIdentifier(project.ownerCorporationID),
    creator: buildSequentialIdentifier(project.creatorCharacterID),
    state: Math.max(0, toInteger(project.state, 0)),
    name: String(project.name || ""),
    description: String(project.description || ""),
    career: Math.max(0, toInteger(project.career, 0)),
    deadline: timestampFromMs(project.deadlineMs),
    created: timestampFromMs(project.createdMs),
    target_progress: Math.max(0, toInteger(project.targetProgress, 0)),
    current_progress: Math.max(0, toInteger(project.currentProgress, 0)),
    committed_participants:
      freelanceProjectState.getCommittedParticipantCount(project),
    total_participants: freelanceProjectState.getTotalParticipantCount(project),
    total_contributors: freelanceProjectState.getTotalContributorCount(project),
    contribution_modifiers: buildContributionModifiersPayload(project),
    participation_restrictions: buildParticipationRestrictionsPayload(project),
    broadcast_locations: {
      solar_systems: (project.broadcastSolarSystemIDs || []).map(
        buildSequentialIdentifier,
      ),
    },
    reward: {
      payout_per_unit: buildCurrency(project.reward && project.reward.payoutPerUnit),
    },
    configuration: project.configuration || {},
  };
  if (finishTimeMs > 0) {
    payload.finish_time = timestampFromMs(finishTimeMs);
  } else {
    payload.not_finished = true;
  }
  return payload;
}

function buildAdminDetailsPayload(project) {
  if (project && project.accessListID) {
    return {
      acl: buildSequentialIdentifier(project.accessListID),
    };
  }
  return {
    no_acl: true,
  };
}

function buildProjectDetailsPayload(project, participant) {
  return {
    project: buildProjectAttributesPayload(project),
    state: Math.max(0, toInteger(participant && participant.state, 0)),
    progress: Math.max(0, toInteger(participant && participant.progress, 0)),
    units_unredeemed: Math.max(
      0,
      toInteger(participant && participant.unitsUnredeemed, 0),
    ),
  };
}

function buildProjectIDList(projects) {
  return (Array.isArray(projects) ? projects : []).map((project) =>
    buildProjectIdentifier(project.projectID || project),
  );
}

function buildPagedProjectIDPayload(projects, page) {
  const { items, nextPage } = sliceWithPage(projects, page);
  return {
    projects: buildProjectIDList(items),
    next_page: nextPage || {},
  };
}

function encodeResponse(protoRoot, responseTypeName, payload, statusCode = 200, statusMessage = "") {
  const responseType = protoRoot.lookupType(responseTypeName);
  return {
    statusCode,
    statusMessage,
    responseTypeName,
    responsePayloadBuffer: encodePayload(responseType, payload || {}),
  };
}

function encodeRequestResponse(protoRoot, requestTypeName, payload, statusCode = 200, statusMessage = "") {
  const responseTypeName =
    PROJECT_API_RESPONSE_TYPES[requestTypeName] ||
    ITEM_DELIVERY_RESPONSE_TYPES[requestTypeName] ||
    requestTypeName.replace(/Request$/, "Response");
  return encodeResponse(protoRoot, responseTypeName, payload, statusCode, statusMessage);
}

function decodeRequest(protoRoot, requestTypeName, requestEnvelope) {
  const requestType = protoRoot.lookupType(requestTypeName);
  return decodePayload(requestType, requestEnvelope);
}

function getCreateRequestPayload(decoded, types, activeCharacterID) {
  const characterID = Math.max(0, toInteger(activeCharacterID, 0));
  const corporationID = getCharacterCorporationID(characterID);
  const configuration = messageToPlain(
    types.contributionConfiguration,
    decoded.configuration,
  );
  const expectedCost = messageToPlain(types.creationCost, decoded.expected_cost);
  const reward = decoded.reward || {};
  const broadcastLocations = decoded.broadcast_locations || {};
  const contributionModifiers = decoded.contribution_modifiers || {};
  const participationRestrictions = decoded.participation_restrictions || {};
  const ageRestriction = participationRestrictions.age_restriction || {};
  return {
    ownerCorporationID: corporationID,
    creatorCharacterID: characterID,
    name: decoded.name,
    description: decoded.description,
    targetProgress: String(decoded.target_progress || "0"),
    career: toInteger(decoded.career, 0),
    deadlineMs: timestampToMs(decoded.deadline),
    configuration,
    contributionModifiers: {
      contributionsPerParticipantLimit:
        toInteger(contributionModifiers.contributions_per_participant_limit, 0) || null,
      progressPerContributionLimit:
        toInteger(contributionModifiers.progress_per_contribution_limit, 0) || null,
      scalarMultiplier:
        toNumber(contributionModifiers.scalar_multiplier, 0) > 0
          ? toNumber(contributionModifiers.scalar_multiplier, 1)
          : 1,
    },
    participationRestrictions: {
      maxCommittedParticipants: Math.max(
        1,
        toInteger(participationRestrictions.max_committed_participants, 1000),
      ),
      minCharacterAgeDays:
        toInteger(ageRestriction.min_age, 0) > 0
          ? toInteger(ageRestriction.min_age, 0)
          : null,
      maxCharacterAgeDays:
        toInteger(ageRestriction.max_age, 0) > 0
          ? toInteger(ageRestriction.max_age, 0)
          : null,
    },
    broadcastSolarSystemIDs: Array.isArray(broadcastLocations.solar_systems)
      ? broadcastLocations.solar_systems.map((entry) => entry.sequential)
      : [],
    payoutPerUnit: currencyToNumber(reward.payout_per_unit),
    payoutCurrency: reward.payout_per_unit ? messageToPlain(types.currency, reward.payout_per_unit) : {},
    expectedCost,
    accessListID: decoded.acl ? toInteger(decoded.acl.sequential, 0) || null : null,
    noAccessList: Boolean(decoded.no_acl || !decoded.acl),
    createdBy: "public-gateway",
  };
}

function resultStatus(result) {
  const code = String(result && result.errorMsg || "");
  if (code.includes("NOT_FOUND")) return 404;
  if (/UNAUTHORIZED|AUTHENTICATION/.test(code)) return 401;
  if (/FORBIDDEN|CANNOT_MANAGE|RESTRICTED|ACCESS_DENIED/.test(code)) return 403;
  if (/PERSISTENCE|FLUSH|RECOVERY|FAILED/.test(code)) return 503;
  return 400;
}

function buildCreateErrorPayload(result) {
  if (!result || result.success) {
    return null;
  }
  if (/CANNOT_MANAGE|FORBIDDEN|ACCESS_DENIED/.test(result.errorMsg)) {
    return { statusCode: 403, payload: { cannot_manage_projects: {} } };
  }
  if (result.errorMsg === "MAX_ACTIVE_PROJECTS_PER_CORPORATION") {
    return {
      statusCode: 400,
      payload: {
        max_active_projects_per_corporation_reached: {
          limit: toInteger(result.data && result.data.limit, 0),
        },
      },
    };
  }
  if (result.errorMsg === "MAX_ACTIVE_PROJECTS_BROADCAST_PER_SYSTEM") {
    return {
      statusCode: 400,
      payload: {
        max_active_projects_broadcast_per_system_reached: {
          limit: toInteger(result.data && result.data.limit, 0),
          solar_systems: ((result.data && result.data.solarSystemIDs) || []).map(
            buildSequentialIdentifier,
          ),
        },
      },
    };
  }
  if (result.errorMsg === "OUTDATED_PROJECT_COST") {
    return { statusCode: 400, payload: { outdated_project_cost: {} } };
  }
  if (result.errorMsg === "OUTDATED_CONTRIBUTION_METHODS") {
    return {
      statusCode: 400,
      payload: { outdated_contribution_methods: {} },
    };
  }
  return {
    statusCode: 400,
    payload: { unspecified_error: true },
  };
}

function buildCommitErrorPayload(result) {
  const data = result && result.data ? result.data : {};
  switch (result && result.errorMsg) {
    case "RESTRICTED":
    case "ACCESS_DENIED":
      return { statusCode: 403, payload: { restricted: {} } };
    case "INVALID_PROJECT_STATE":
      return { statusCode: 400, payload: { invalid_project_state: {} } };
    case "INVALID_PARTICIPATION_STATE":
      return { statusCode: 400, payload: { invalid_participation_state: {} } };
    case "MAX_COMMITTED_PARTICIPANTS_PER_PROJECT":
      return {
        statusCode: 400,
        payload: { max_committed_participants_per_project: {} },
      };
    case "MAX_PROJECTS_COMMITTED_PER_PARTICIPANT":
      return {
        statusCode: 400,
        payload: { max_projects_committed_per_participant: {} },
      };
    case "INVALID_CHARACTER_AGE":
      return {
        statusCode: 400,
        payload: {
          invalid_character_age: {
            character_age_restriction: buildCharacterAgeRestrictionPayload({
              minCharacterAgeDays: data.minAge,
              maxCharacterAgeDays: data.maxAge,
            }),
          },
        },
      };
    case "PROJECT_NOT_FOUND":
      return { statusCode: 404, payload: { unspecified_error: true } };
    default:
      return { statusCode: 400, payload: { unspecified_error: true } };
  }
}

function buildProjectStateErrorPayload(result, fieldName = "invalid_project_state") {
  if (/CANNOT_MANAGE|FORBIDDEN|ACCESS_DENIED/.test(result && result.errorMsg || "")) {
    return { statusCode: 403, payload: { cannot_manage_projects: {} } };
  }
  if (result && result.errorMsg === "PROJECT_NOT_FOUND") {
    return { statusCode: 404, payload: { unspecified_error: true } };
  }
  if (result && result.errorMsg === "INVALID_PARTICIPATION_STATE") {
    return { statusCode: 400, payload: { invalid_participation_state: {} } };
  }
  return { statusCode: 400, payload: { [fieldName]: {} } };
}

function buildDeliveryErrorPayload(result) {
  const maxQuantity = Math.max(
    0,
    toInteger(result && result.data && result.data.maxQuantity, 0),
  );
  switch (result && result.errorMsg) {
    case "PROJECT_NOT_FOUND":
      return { statusCode: 404, payload: { project_does_not_exist: {} } };
    case "PROJECT_DOES_NOT_ALLOW_ITEM_DELIVERY":
    case "INVALID_PROJECT_STATE":
      return {
        statusCode: 400,
        payload: { project_does_not_allow_item_delivery: {} },
      };
    case "CHARACTER_NOT_COMMITTED":
      return { statusCode: 400, payload: { character_not_committed: {} } };
    case "DELIVERY_LOCATION_DOES_NOT_EXIST":
      return {
        statusCode: 400,
        payload: { delivery_location_does_not_exist: {} },
      };
    case "ITEM_NOT_OWNED_BY_DELIVERER":
      return {
        statusCode: 400,
        payload: { item_not_owned_by_deliverer: {} },
      };
    case "INVALID_ITEM_TYPE":
      return { statusCode: 400, payload: { invalid_item_type: {} } };
    case "QUANTITY_TOO_HIGH":
      return {
        statusCode: 400,
        payload: {
          quantity_too_high: {
            max_remaining_project_contributions: {
              max_quantity: maxQuantity,
            },
          },
        },
      };
    case "ITEM_NOT_FOUND_AT_LOCATION":
    default:
      return { statusCode: 400, payload: { item_not_found_at_location: {} } };
  }
}

function validateContributionMethodConfiguration(configuration) {
  const methodName =
    configuration &&
    configuration.contribution_method &&
    configuration.contribution_method.name;
  if (!CONTRIBUTION_METHOD_DEFINITIONS.some((definition) => definition.name === methodName)) {
    return false;
  }
  const version = configuration && configuration.version ? configuration.version : {};
  return toInteger(version.major, CONTRIBUTION_METHOD_VERSION.major) <=
    CONTRIBUTION_METHOD_VERSION.major;
}

async function handleProjectApiRequest(protoRoot, requestTypeName, requestEnvelope, types) {
  const activeCharacterID = getRequestCharacterID(requestEnvelope);
  const decoded = decodeRequest(protoRoot, requestTypeName, requestEnvelope);

  if (requestTypeName === "eve_public.freelance.project.api.CreateRequest") {
    const payload = getCreateRequestPayload(decoded, types, activeCharacterID);
    payload.requestID = bufferFromBytes(requestEnvelope && requestEnvelope.correlation_uuid).toString("hex");
    if (!validateContributionMethodConfiguration(payload.configuration)) {
      return encodeRequestResponse(
        protoRoot,
        requestTypeName,
        { outdated_contribution_methods: {} },
        400,
      );
    }
    const result = await freelanceProjectState.createProject(payload, FREELANCE_LIMITS);
    if (!result.success) {
      const error = buildCreateErrorPayload(result);
      return encodeRequestResponse(
        protoRoot,
        requestTypeName,
        error.payload,
        error.statusCode,
      );
    }
    return encodeRequestResponse(protoRoot, requestTypeName, {
      created: { project: buildProjectIdentifier(result.data.project.projectID) },
    });
  }

  if (requestTypeName === "eve_public.freelance.project.api.CommitRequest") {
    const result = await freelanceProjectState.commitProject(
      toProjectUUID(decoded.project),
      activeCharacterID,
      FREELANCE_LIMITS,
    );
    if (!result.success) {
      const error = buildCommitErrorPayload(result);
      return encodeRequestResponse(protoRoot, requestTypeName, error.payload, error.statusCode);
    }
    return encodeRequestResponse(protoRoot, requestTypeName, { committed: {} });
  }

  if (requestTypeName === "eve_public.freelance.project.api.ResignRequest") {
    const result = await freelanceProjectState.resignProject(
      toProjectUUID(decoded.project),
      activeCharacterID,
    );
    if (!result.success) {
      const error = buildProjectStateErrorPayload(result);
      return encodeRequestResponse(protoRoot, requestTypeName, error.payload, error.statusCode);
    }
    return encodeRequestResponse(protoRoot, requestTypeName, { resigned: {} });
  }

  if (requestTypeName === "eve_public.freelance.project.api.KickRequest") {
    const result = await freelanceProjectState.kickParticipant(
      toProjectUUID(decoded.project),
      decoded.participant && decoded.participant.sequential,
      activeCharacterID,
    );
    if (!result.success) {
      const error = buildProjectStateErrorPayload(result);
      return encodeRequestResponse(protoRoot, requestTypeName, error.payload, error.statusCode);
    }
    return encodeRequestResponse(protoRoot, requestTypeName, { kicked: {} });
  }

  if (requestTypeName === "eve_public.freelance.project.api.CloseRequest") {
    const result = await freelanceProjectState.closeProject(
      toProjectUUID(decoded.project),
      activeCharacterID,
    );
    if (!result.success) {
      const error = buildProjectStateErrorPayload(result);
      return encodeRequestResponse(protoRoot, requestTypeName, error.payload, error.statusCode);
    }
    return encodeRequestResponse(protoRoot, requestTypeName, { closed: {} });
  }

  if (requestTypeName === "eve_public.freelance.project.api.RedeemRewardRequest") {
    const result = await freelanceProjectState.redeemRewards(
      toProjectUUID(decoded.project),
      activeCharacterID,
    );
    if (!result.success) {
      return encodeRequestResponse(protoRoot, requestTypeName, {}, resultStatus(result), result.errorMsg);
    }
    return encodeRequestResponse(protoRoot, requestTypeName, {});
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetRequest") {
    const result = freelanceProjectState.getProjectDetails(
      toProjectUUID(decoded.project),
      activeCharacterID,
    );
    if (!result.success) {
      return buildErrorResult(requestTypeName, resultStatus(result), result.errorMsg);
    }
    return encodeRequestResponse(
      protoRoot,
      requestTypeName,
      buildProjectDetailsPayload(result.data.project, result.data.participant),
    );
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetForManagerRequest") {
    const result = freelanceProjectState.getProjectDetails(
      toProjectUUID(decoded.project),
      activeCharacterID,
      { managerOnly: true },
    );
    if (!result.success) {
      return buildErrorResult(requestTypeName, resultStatus(result), result.errorMsg);
    }
    return encodeRequestResponse(protoRoot, requestTypeName, {
      ...buildProjectDetailsPayload(result.data.project, result.data.participant),
      admin_project_details: buildAdminDetailsPayload(result.data.project),
    });
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetAllActiveForCorporationRequest") {
    const projects = freelanceProjectState.listActiveForCorporation(
      decoded.corporation && decoded.corporation.sequential,
      activeCharacterID,
    );
    return encodeRequestResponse(protoRoot, requestTypeName, {
      projects: buildProjectIDList(projects),
    });
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetAllActiveRequest") {
    const projects = freelanceProjectState.listActiveManaged(
      getCharacterCorporationID(activeCharacterID),
      activeCharacterID,
    );
    return encodeRequestResponse(protoRoot, requestTypeName, {
      projects: buildProjectIDList(projects),
    });
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetAllCommittedRequest") {
    const projects = freelanceProjectState.listCommitted(activeCharacterID);
    return encodeRequestResponse(protoRoot, requestTypeName, {
      projects: buildProjectIDList(projects),
    });
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetAllUnredeemedRequest") {
    const projects = freelanceProjectState.listUnredeemed(activeCharacterID);
    return encodeRequestResponse(
      protoRoot,
      requestTypeName,
      buildPagedProjectIDPayload(projects, decoded.page),
    );
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetAllBroadcastedRequest") {
    const solarSystemIDs = Array.isArray(decoded.solar_systems)
      ? decoded.solar_systems.map((entry) => entry.sequential)
      : [];
    const bySystem = freelanceProjectState.listBroadcasted(solarSystemIDs, activeCharacterID);
    return encodeRequestResponse(protoRoot, requestTypeName, {
      broadcasted: solarSystemIDs.map((solarSystemID) => ({
        solar_system: buildSequentialIdentifier(solarSystemID),
        projects: buildProjectIDList(bySystem[String(solarSystemID)] || []),
      })),
    });
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetAllInactiveRequest") {
    const projects = freelanceProjectState.listInactive(
      timestampToMs(decoded.start_time),
      durationToMs(decoded.duration),
      getCharacterCorporationID(activeCharacterID),
      activeCharacterID,
    );
    return encodeRequestResponse(
      protoRoot,
      requestTypeName,
      buildPagedProjectIDPayload(projects, decoded.page),
    );
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetParticipationDetailsRequest") {
    const result = freelanceProjectState.getParticipants(toProjectUUID(decoded.project), activeCharacterID);
    if (!result.success) {
      return buildErrorResult(requestTypeName, resultStatus(result), result.errorMsg);
    }
    const { items, nextPage } = sliceWithPage(result.data.participants, decoded.page);
    return encodeRequestResponse(protoRoot, requestTypeName, {
      participants: items.map((participant) => ({
        character: buildSequentialIdentifier(participant.characterID),
        state: Math.max(0, toInteger(participant.state, 0)),
        progress: Math.max(0, toInteger(participant.progress, 0)),
      })),
      next_page: nextPage || {},
    });
  }

  if (requestTypeName === "eve_public.freelance.project.api.GetStatsRequest") {
    const projectIDs = Array.isArray(decoded.projects)
      ? decoded.projects.map(toProjectUUID).filter(Boolean)
      : [];
    const { stats, missing } = freelanceProjectState.getStats(projectIDs, activeCharacterID);
    return encodeRequestResponse(protoRoot, requestTypeName, {
      project_stats: stats.map((entry) => ({
        project: buildProjectIdentifier(entry.project.projectID),
        current_progress: entry.currentProgress,
        committed_participants: entry.committedParticipants,
        total_participants: entry.totalParticipants,
        total_contributors: entry.totalContributors,
      })),
      redacted: missing.map(buildProjectIdentifier),
    });
  }

  return null;
}

async function handleItemDeliveryRequest(protoRoot, requestTypeName, requestEnvelope) {
  const activeCharacterID = getRequestCharacterID(requestEnvelope);
  const decoded = decodeRequest(protoRoot, requestTypeName, requestEnvelope);
  if (
    requestTypeName ===
    "eve_public.freelance.contributionmethod.itemdelivery.api.DeliverRequest"
  ) {
    const result = await freelanceProjectState.deliverItem({
      projectID: toProjectUUID(decoded.project),
      characterID: activeCharacterID,
      deliveryLocation: decoded.delivery_location,
      itemID: decoded.item && decoded.item.sequential,
      quantity: decoded.quantity,
      itemLocation: decoded.item_location,
      requestID: bufferFromBytes(requestEnvelope && requestEnvelope.correlation_uuid).toString("hex"),
    });
    if (!result.success) {
      const error = buildDeliveryErrorPayload(result);
      return encodeRequestResponse(protoRoot, requestTypeName, error.payload, error.statusCode);
    }
    return encodeRequestResponse(protoRoot, requestTypeName, {
      escrowed: {
        delivery: buildProjectIdentifier(result.data.delivery.deliveryID),
      },
    });
  }

  if (
    requestTypeName ===
    "eve_public.freelance.contributionmethod.itemdelivery.api.GetStatusRequest"
  ) {
    const result = freelanceProjectState.getDeliveryStatus(
      toProjectUUID(decoded.delivery),
      activeCharacterID,
    );
    if (!result.success) {
      return encodeRequestResponse(protoRoot, requestTypeName, { failed: {} }, resultStatus(result), result.errorMsg);
    }
    const delivery = result.data.delivery;
    if (delivery.status === "escrowed") {
      return encodeRequestResponse(protoRoot, requestTypeName, { escrowed: {} });
    }
    if (delivery.status === "failed") {
      return encodeRequestResponse(protoRoot, requestTypeName, { failed: {} });
    }
    return encodeRequestResponse(protoRoot, requestTypeName, {
      succeeded: {
        quantity_delivered: Math.max(0, toInteger(delivery.quantityDelivered, 0)),
        quantity_returned: Math.max(0, toInteger(delivery.quantityReturned, 0)),
      },
    });
  }

  return null;
}

let activeNoticePublisher = null;
let noticeBindings = [];

function bindFreelanceNotices(context, protoRoot) {
  if (!context || typeof context.publishGatewayNotice !== "function") return () => {};
  activeNoticePublisher = context.publishGatewayNotice;
  const publisher = activeNoticePublisher;
  const dispose = () => {
    if (activeNoticePublisher !== publisher) return;
    activeNoticePublisher = null;
    for (const [name, listener] of noticeBindings) freelanceProjectState.events.off(name, listener);
    noticeBindings = [];
  };
  if (noticeBindings.length) return dispose;
  function on(name, listener) {
    freelanceProjectState.events.on(name, listener);
    noticeBindings.push([name, listener]);
  }

  function publish(typeName, payload, targetGroup) {
    const messageType = protoRoot.lookupType(typeName);
    if (!activeNoticePublisher) return;
    try {
      activeNoticePublisher(typeName, encodePayload(messageType, payload), targetGroup);
    } catch (error) {
      require("../../../utils/logger").warn(`[Freelance] gateway notice failed: ${error.message}`);
    }
  }

  function targetCorporation(project) {
    return { corporation: Math.max(0, toInteger(project && project.ownerCorporationID, 0)) };
  }

  on("project-created", (event) => {
    const project = event.project;
    publish(
      "eve_public.freelance.project.api.CreatedNotice",
      {
        project: buildProjectIdentifier(project.projectID),
        attributes: buildProjectAttributesPayload(project),
        admin_project_details: buildAdminDetailsPayload(project),
      },
      targetCorporation(project),
    );
  });
  on("project-completed", (event) => {
    publish(
      "eve_public.freelance.project.api.CompletedNotice",
      { project: buildProjectIdentifier(event.project.projectID) },
      targetCorporation(event.project),
    );
  });
  on("project-closed", (event) => {
    publish(
      "eve_public.freelance.project.api.ClosedNotice",
      { project: buildProjectIdentifier(event.project.projectID) },
      targetCorporation(event.project),
    );
  });
  on("project-expired", (event) => {
    publish(
      "eve_public.freelance.project.api.ExpiredNotice",
      { project: buildProjectIdentifier(event.project.projectID) },
      targetCorporation(event.project),
    );
  });
  on("project-progressed", (event) => {
    publish(
      "eve_public.freelance.project.api.ProgressedNotice",
      {
        project: buildProjectIdentifier(event.project.projectID),
        total_project_progress: event.totalProjectProgress,
        total_contributors: event.totalContributors,
      },
      targetCorporation(event.project),
    );
  });
  on("participant-added", (event) => {
    publish(
      "eve_public.freelance.project.api.ParticipantAddedNotice",
      {
        project: buildProjectIdentifier(event.project.projectID),
        committed_participants: event.committedParticipants,
        total_participants: event.totalParticipants,
      },
      targetCorporation(event.project),
    );
  });
  on("participant-removed", (event) => {
    publish(
      "eve_public.freelance.project.api.ParticipantRemovedNotice",
      {
        project: buildProjectIdentifier(event.project.projectID),
        committed_participants: event.committedParticipants,
      },
      targetCorporation(event.project),
    );
  });
  on("participant-contributed", (event) => {
    publish(
      "eve_public.freelance.project.api.ParticipantContributedNotice",
      {
        project: buildProjectIdentifier(event.project.projectID),
        participant: buildSequentialIdentifier(event.characterID),
        total_participant_progress:
          event.participant && event.participant.progress
            ? event.participant.progress
            : 0,
      },
      { character: Math.max(0, toInteger(event.characterID, 0)) },
    );
  });
  on("participant-reward-redeemed", (event) => {
    publish(
      "eve_public.freelance.project.api.ParticipantRewardRedeemedNotice",
      {
        project: buildProjectIdentifier(event.project.projectID),
        participant: buildSequentialIdentifier(event.characterID),
      },
      { character: Math.max(0, toInteger(event.characterID, 0)) },
    );
  });
  on("participant-kicked", (event) => {
    publish(
      "eve_public.freelance.project.api.ParticipantKickedNotice",
      {
        project: buildProjectIdentifier(event.project.projectID),
        participant: buildSequentialIdentifier(event.characterID),
      },
      { character: Math.max(0, toInteger(event.characterID, 0)) },
    );
  });
  on("itemdelivery-succeeded", (event) => {
    const session = require("../../../services/chat/sessionRegistry").findSessionByCharacterID(event.characterID);
    const changes = (event.changes || []).filter(change => change && change.item);
    try {
      require("../../../services/inventory/corporationOfficeInventoryObservers").fanCorporationOfficeInventoryChanges(changes, { actorSession: session || null, emitItemsChangedBatch: true });
      if (session) for (const change of changes) {
        require("../../../services/character/characterState").syncInventoryItemForSession(session, change.item, change.previousData || {}, { emitCfgLocation: false });
      }
    } catch (error) {
      require("../../../utils/logger").warn(`[Freelance] inventory notification failed: ${error.message}`);
    }
    publish(
      "eve_public.freelance.contributionmethod.itemdelivery.api.ContributionSucceededNotice",
      {
        delivery: buildProjectIdentifier(event.delivery.deliveryID),
        contributed: event.delivery.quantityDelivered,
        remainder: event.delivery.quantityReturned,
      },
      { character: Math.max(0, toInteger(event.characterID, 0)) },
    );
  });
  on("itemdelivery-failed", (event) => {
    publish(
      "eve_public.freelance.contributionmethod.itemdelivery.api.ContributionFailedNotice",
      {
        delivery: buildProjectIdentifier(event.delivery.deliveryID),
      },
      { character: Math.max(0, toInteger(event.characterID, 0)) },
    );
  });
  return dispose;

}

function createFreelanceGatewayService(context = {}) {
  const protoRoot = buildFreelanceProtoRoot();
  const dispose = bindFreelanceNotices(context, protoRoot);
  const GetCommitLimitsResponse = protoRoot.lookupType(
    "eve_public.freelance.project.api.GetCommitLimitsResponse",
  );
  const GetCreationLimitsResponse = protoRoot.lookupType(
    "eve_public.freelance.project.api.GetCreationLimitsResponse",
  );
  const GetCreationPricesResponse = protoRoot.lookupType(
    "eve_public.freelance.project.api.GetCreationPricesResponse",
  );
  const GetAllLatestRequest = protoRoot.lookupType(
    "eve_public.freelance.contributionmethod.definition.api.GetAllLatestRequest",
  );
  const GetAllLatestResponse = protoRoot.lookupType(
    "eve_public.freelance.contributionmethod.definition.api.GetAllLatestResponse",
  );
  const GetAllLatestWithinMajorRequest = protoRoot.lookupType(
    "eve_public.freelance.contributionmethod.definition.api.GetAllLatestWithinMajorRequest",
  );
  const GetAllLatestWithinMajorResponse = protoRoot.lookupType(
    "eve_public.freelance.contributionmethod.definition.api.GetAllLatestWithinMajorResponse",
  );
  const runtimeTypes = {
    currency: protoRoot.lookupType("eve_public.isk.Currency"),
    contributionConfiguration: protoRoot.lookupType(
      "eve_public.freelance.contributionmethod.Configuration",
    ),
    creationCost: protoRoot.lookupType(
      "eve_public.freelance.project.CreationCost",
    ),
  };

  return {
    name: "freelance-projects",
    dispose,
    handledRequestTypes: [
      "eve_public.freelance.project.api.GetCommitLimitsRequest",
      "eve_public.freelance.project.api.GetCreationLimitsRequest",
      "eve_public.freelance.project.api.GetCreationPricesRequest",
      ...Object.keys(CONTRIBUTION_DEFINITION_RESPONSE_TYPES),
      ...Object.keys(PROJECT_API_RESPONSE_TYPES),
      ...Object.keys(ITEM_DELIVERY_RESPONSE_TYPES),
    ],
    getEmptySuccessResponseType() {
      return null;
    },
    handleRequest(requestTypeName, requestEnvelope) {
      if (PROJECT_API_RESPONSE_TYPES[requestTypeName] || ITEM_DELIVERY_RESPONSE_TYPES[requestTypeName]) {
        if (!getRequestCharacterID(requestEnvelope)) {
          return buildErrorResult(requestTypeName, 401, "AUTHENTICATION_REQUIRED");
        }
        try { decodeRequest(protoRoot, requestTypeName, requestEnvelope); }
        catch (_) { return buildErrorResult(requestTypeName, 400, "MALFORMED_REQUEST"); }
      }
      if (requestTypeName === "eve_public.freelance.project.api.GetCommitLimitsRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.freelance.project.api.GetCommitLimitsResponse",
          responsePayloadBuffer: encodePayload(GetCommitLimitsResponse, {
            max_active_projects_per_participant:
              FREELANCE_LIMITS.maxActiveProjectsPerParticipant,
            max_committed_participants_per_project:
              FREELANCE_LIMITS.maxCommittedParticipantsPerProject,
          }),
        };
      }

      if (requestTypeName === "eve_public.freelance.project.api.GetCreationLimitsRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.freelance.project.api.GetCreationLimitsResponse",
          responsePayloadBuffer: encodePayload(GetCreationLimitsResponse, {
            max_active_projects_per_corporation:
              FREELANCE_LIMITS.maxActiveProjectsPerCorporation,
            max_active_projects_broadcast_per_system:
              FREELANCE_LIMITS.maxActiveProjectsBroadcastPerSystem,
            max_character_age_days: FREELANCE_LIMITS.maxCharacterAgeDays,
            max_broadcasting_locations_per_project:
              FREELANCE_LIMITS.maxBroadcastingLocationsPerProject,
            max_committed_participants_per_project:
              FREELANCE_LIMITS.maxCommittedParticipantsPerProject,
            max_contribution_multiplier:
              FREELANCE_LIMITS.maxContributionMultiplier,
            max_project_duration: {
              seconds: FREELANCE_LIMITS.maxProjectDurationSeconds,
            },
          }),
        };
      }

      if (requestTypeName === "eve_public.freelance.project.api.GetCreationPricesRequest") {
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.freelance.project.api.GetCreationPricesResponse",
          responsePayloadBuffer: encodePayload(GetCreationPricesResponse, {
            prices: {
              base_fee_per_day: buildCurrency(
                FREELANCE_CREATION_PRICES.baseFeePerDay,
              ),
              broadcasting_fee_per_day_per_location: buildCurrency(
                FREELANCE_CREATION_PRICES.broadcastingFeePerDayPerLocation,
              ),
            },
          }),
        };
      }

      if (
        requestTypeName ===
        "eve_public.freelance.contributionmethod.definition.api.GetAllLatestRequest"
      ) {
        const decoded = decodePayload(GetAllLatestRequest, requestEnvelope);
        if (hasCurrentKnownVersion(decoded)) {
          return buildErrorResult(requestTypeName, 304, "NOT_MODIFIED");
        }
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.freelance.contributionmethod.definition.api.GetAllLatestResponse",
          responsePayloadBuffer: encodePayload(
            GetAllLatestResponse,
            buildDefinitionResponsePayload(),
          ),
        };
      }

      if (
        requestTypeName ===
        "eve_public.freelance.contributionmethod.definition.api.GetAllLatestWithinMajorRequest"
      ) {
        const decoded = decodePayload(
          GetAllLatestWithinMajorRequest,
          requestEnvelope,
        );
        const requestedMajor = Number(decoded && decoded.major ? decoded.major : 0);
        if (requestedMajor !== CONTRIBUTION_METHOD_VERSION.major) {
          return buildErrorResult(requestTypeName, 404, "NOT_FOUND");
        }
        if (hasCurrentKnownVersion(decoded)) {
          return buildErrorResult(requestTypeName, 304, "NOT_MODIFIED");
        }
        return {
          statusCode: 200,
          statusMessage: "",
          responseTypeName:
            "eve_public.freelance.contributionmethod.definition.api.GetAllLatestWithinMajorResponse",
          responsePayloadBuffer: encodePayload(
            GetAllLatestWithinMajorResponse,
            buildDefinitionResponsePayload(),
          ),
        };
      }

      if (PROJECT_API_RESPONSE_TYPES[requestTypeName]) {
        return handleProjectApiRequest(
          protoRoot,
          requestTypeName,
          requestEnvelope,
          runtimeTypes,
        );
      }

      if (ITEM_DELIVERY_RESPONSE_TYPES[requestTypeName]) {
        return handleItemDeliveryRequest(protoRoot, requestTypeName, requestEnvelope);
      }

      return null;
    },
  };
}

module.exports = {
  CONTRIBUTION_METHOD_DEFINITIONS,
  CONTRIBUTION_METHOD_VERSION,
  FREELANCE_CREATION_PRICES,
  FREELANCE_LIMITS,
  buildDefinitionResponsePayload,
  buildFreelanceProtoRoot,
  createFreelanceGatewayService,
};
module.exports._testing = {
  CONTRIBUTION_DEFINITION_RESPONSE_TYPES,
  ITEM_DELIVERY_RESPONSE_TYPES,
  PROJECT_API_RESPONSE_TYPES,
};
