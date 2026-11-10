"use strict";

const crypto = require("crypto");
const path = require("path");
const protobuf = require("protobufjs");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { findShipItemById } = require(path.join(
  __dirname,
  "../../services/inventory/itemStore",
));
const {
  getAppliedSkinRecord,
  getAppliedSkinRecordsForOwner,
} = require(path.join(__dirname, "../../services/ship/shipCosmeticsState"));
const {
  resolveCharacterAccountID,
  resolveOmegaLicenseState,
} = require(path.join(__dirname, "../../services/newEdenStore/storeState"));
const {
  createGatewayServiceRegistry,
} = require(path.join(
  __dirname,
  "./gatewayServices",
));
const {
  buildStructurePaintworkProtoRoot,
} = require(path.join(
  __dirname,
  "./gatewayServices/structurePaintworkGatewayService",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../../services/chat/sessionRegistry",
));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  getLicenseForStructure,
  getPaintworksForSolarSystem,
  normalizePaintwork,
} = require(path.join(
  __dirname,
  "../../services/structure/structurePaintworkState",
));
const {
  getStructureByID,
} = require(path.join(__dirname, "../../services/structure/structureState"));

const GATEWAY_INSTANCE_UUID = Buffer.from(
  crypto.randomUUID().replace(/-/g, ""),
  "hex",
);
const ACTIVE_NOTICE_STREAMS = new Map();
let GATEWAY_TRANSPORT_IDENTITIES = new WeakMap();
const UNKNOWN_REQUEST_COUNTS = new Map();
const GRPC_RESPONSE_HEADERS = {
  ":status": 200,
  "content-type": "application/grpc+proto",
  "grpc-encoding": "identity",
  "grpc-accept-encoding": "identity",
};
const EMPTY_PAYLOAD = Buffer.alloc(0);
const PUBLIC_GATEWAY_ORIGIN = "EveJS Elysian local gateway";

function getCharacterStateService() {
  return require(path.join(__dirname, "../../services/character/characterState"));
}

function getCharacterRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function getDefaultPlexBalance() {
  const characterState = getCharacterStateService();
  return Number(characterState && characterState.DEFAULT_PLEX_BALANCE) || 0;
}

const PROTO_ROOT = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Any: {
              fields: {
                type_url: { type: "string", id: 1 },
                value: { type: "bytes", id: 2 },
              },
            },
            Empty: {
              fields: {},
            },
            Timestamp: {
              fields: {
                seconds: { type: "int64", id: 1 },
                nanos: { type: "int32", id: 2 },
              },
            },
          },
        },
      },
    },
    eve_public: {
      nested: {
        Request: {
          fields: {
            issued: { type: "google.protobuf.Timestamp", id: 1 },
            correlation_uuid: { type: "bytes", id: 2 },
            payload: { type: "google.protobuf.Any", id: 3 },
            external_origin: { type: "string", id: 4 },
            application_instance_uuid: { type: "bytes", id: 5 },
            authoritative_context: {
              type: "eve_public.AuthoritativeContext",
              id: 6,
            },
          },
        },
        Response: {
          fields: {
            dispatched: { type: "google.protobuf.Timestamp", id: 1 },
            correlation_uuid: { type: "bytes", id: 2 },
            status_code: { type: "uint32", id: 3 },
            status_message: { type: "string", id: 4 },
            payload: { type: "google.protobuf.Any", id: 5 },
            internal_origin: { type: "string", id: 6 },
            application_instance_uuid: { type: "bytes", id: 7 },
            gateway_instance_uuid: { type: "bytes", id: 8 },
          },
        },
        Notice: {
          fields: {
            dispatched: { type: "google.protobuf.Timestamp", id: 1 },
            uuid: { type: "bytes", id: 2 },
            internal_origin: { type: "string", id: 3 },
            tenant: { type: "string", id: 4 },
            payload: { type: "google.protobuf.Any", id: 5 },
            target_group: { type: "eve_public.Notice.TargetGroup", id: 6 },
          },
          nested: {
            TargetGroup: {
              oneofs: {
                group: {
                  oneof: [
                    "application_instance_uuid",
                    "solar_system",
                    "user",
                    "character",
                    "corporation",
                    "alliance",
                    "bubble_instance_uuid",
                  ],
                },
              },
              fields: {
                application_instance_uuid: { type: "bytes", id: 1 },
                solar_system: { type: "uint32", id: 2 },
                user: { type: "sint32", id: 3 },
                character: { type: "uint32", id: 4 },
                corporation: { type: "uint32", id: 5 },
                alliance: { type: "int32", id: 6 },
                bubble_instance_uuid: { type: "bytes", id: 7 },
              },
            },
          },
        },
        AuthoritativeContext: {
          fields: {
            no_authenticated_user: { type: "bool", id: 4 },
            authenticated_user: { type: "eve_public.user.Identifier", id: 5 },
            no_active_identity: { type: "bool", id: 9 },
            active_character: {
              type: "eve_public.character.Identifier",
              id: 7,
            },
            identity: {
              type: "eve_public.ActiveIdentity",
              id: 10,
            },
          },
        },
        ActiveIdentity: {
          fields: {
            character: {
              type: "eve_public.character.Identifier",
              id: 1,
            },
          },
        },
        Page: {
          fields: {
            size: { type: "uint32", id: 1 },
            token: { type: "string", id: 2 },
          },
        },
        NextPage: {
          fields: {
            token: { type: "string", id: 1 },
          },
        },
        localization: {
          nested: {
            message: {
              nested: {
                Identifier: {
                  fields: {
                    sequential: { type: "uint32", id: 1 },
                  },
                },
              },
            },
            cerberus: {
              nested: {
                Parameter: {
                  fields: {
                    key: { type: "string", id: 1 },
                    string: { type: "string", id: 2 },
                    integer: { type: "uint64", id: 3 },
                    signed_integer: { type: "int64", id: 4 },
                    double: { type: "double", id: 5 },
                    timestamp: {
                      type: "google.protobuf.Timestamp",
                      id: 6,
                    },
                  },
                },
                FormattedMessage: {
                  fields: {
                    identifier: {
                      type: "eve_public.localization.message.Identifier",
                      id: 1,
                    },
                    parameters: {
                      rule: "repeated",
                      type: "eve_public.localization.cerberus.Parameter",
                      id: 2,
                    },
                  },
                },
              },
            },
          },
        },
        color: {
          nested: {
            RGB: {
              fields: {
                red: { type: "uint32", id: 1 },
                green: { type: "uint32", id: 2 },
                blue: { type: "uint32", id: 3 },
              },
            },
          },
        },
        corporation: {
          nested: {
            Identifier: {
              fields: {
                sequential: { type: "uint32", id: 1 },
              },
            },
          },
        },
        character: {
          nested: {
            Identifier: {
              fields: {
                sequential: { type: "uint32", id: 1 },
              },
            },
            skill: {
              nested: {
                plan: {
                  nested: {
                    GetActiveRequest: {
                      fields: {},
                    },
                    GetActiveResponse: {
                      fields: {
                        skill_plan: {
                          type: "eve_public.skill.plan.Identifier",
                          id: 1,
                        },
                        skill_plan_info: {
                          type: "eve_public.skill.plan.Attributes",
                          id: 2,
                        },
                      },
                    },
                    GetAllRequest: {
                      fields: {},
                    },
                    GetAllResponse: {
                      fields: {
                        skill_plans: {
                          rule: "repeated",
                          type: "eve_public.skill.plan.Identifier",
                          id: 1,
                        },
                      },
                    },
                    SetActiveRequest: {
                      fields: {
                        skill_plan: {
                          type: "eve_public.skill.plan.Identifier",
                          id: 1,
                        },
                      },
                    },
                    SetActiveResponse: {
                      fields: {},
                    },
                  },
                },
              },
            },
          },
        },
        career: {
          nested: {
            goal: {
              nested: {
                Identifier: {
                  fields: {
                    uuid: { type: "bytes", id: 1 },
                  },
                },
                Attributes: {
                  fields: {
                    target: { type: "uint32", id: 4 },
                    threat: { type: "uint32", id: 7 },
                    career: {
                      type: "eve_public.career.goal.Attributes.Career",
                      id: 9,
                    },
                    career_points: { type: "uint32", id: 10 },
                  },
                  nested: {
                    Career: {
                      values: {
                        CAREER_UNSPECIFIED: 0,
                        CAREER_EXPLORATION: 1,
                        CAREER_INDUSTRIALIST: 2,
                        CAREER_ENFORCER: 3,
                        CAREER_SOLDIER_OF_FORTUNE: 4,
                      },
                    },
                  },
                },
                api: {
                  nested: {
                    GetDefinitionsResponse: {
                      fields: {
                        goals: {
                          rule: "repeated",
                          type:
                            "eve_public.career.goal.api.GetDefinitionsResponse.Goal",
                          id: 1,
                        },
                      },
                      nested: {
                        Goal: {
                          fields: {
                            goal: {
                              type: "eve_public.career.goal.Identifier",
                              id: 1,
                            },
                            attributes: {
                              type: "eve_public.career.goal.Attributes",
                              id: 2,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        skill: {
          nested: {
            plan: {
              nested: {
                Identifier: {
                  fields: {
                    uuid: { type: "bytes", id: 1 },
                  },
                },
                Attributes: {
                  fields: {},
                },
              },
            },
          },
        },
        ship: {
          nested: {
            Identifier: {
              fields: {
                sequential: { type: "uint64", id: 1 },
              },
            },
          },
        },
        faction: {
          nested: {
            Identifier: {
              fields: {
                sequential: { type: "uint32", id: 1 },
              },
            },
            activity: {
              nested: {
                Score: {
                  fields: {
                    faction: {
                      type: "eve_public.faction.Identifier",
                      id: 1,
                    },
                    contribution: { type: "uint32", id: 2 },
                    floor: { type: "uint32", id: 3 },
                  },
                },
                GetSolarSystemScoresRequest: {
                  fields: {
                    solar_system: {
                      type: "eve_public.solarsystem.Identifier",
                      id: 1,
                    },
                  },
                },
                GetSolarSystemScoresResponse: {
                  fields: {
                    solar_system: {
                      type: "eve_public.solarsystem.Identifier",
                      id: 1,
                    },
                    scores: {
                      rule: "repeated",
                      type: "eve_public.faction.activity.Score",
                      id: 2,
                    },
                  },
                },
                ScoreContributionNotice: {
                  fields: {
                    solar_system: {
                      type: "eve_public.solarsystem.Identifier",
                      id: 1,
                    },
                    contributor: {
                      type: "eve_public.character.Identifier",
                      id: 2,
                    },
                    faction: {
                      type: "eve_public.faction.Identifier",
                      id: 3,
                    },
                    contribution: { type: "int32", id: 4 },
                  },
                },
                SolarSystemScoresNotice: {
                  fields: {
                    solar_system: {
                      type: "eve_public.solarsystem.Identifier",
                      id: 1,
                    },
                    scores: {
                      rule: "repeated",
                      type: "eve_public.faction.activity.Score",
                      id: 2,
                    },
                  },
                },
              },
            },
          },
        },
        solarsystem: {
          nested: {
            Identifier: {
              fields: {
                sequential: { type: "uint32", id: 1 },
              },
            },
          },
        },
        math: {
          nested: {
            Fraction: {
              fields: {
                numerator: { type: "uint64", id: 1 },
                denominator: { type: "uint64", id: 2 },
              },
            },
          },
        },
        pirate: {
          nested: {
            corruption: {
              nested: {
                api: {
                  nested: {
                    GetSystemInfoRequest: {
                      fields: {
                        system: {
                          type: "eve_public.solarsystem.Identifier",
                          id: 1,
                        },
                      },
                    },
                    GetSystemInfoResponse: {
                      fields: {
                        total_progress: {
                          type: "eve_public.math.Fraction",
                          id: 1,
                        },
                        eve_contribution: {
                          type: "eve_public.math.Fraction",
                          id: 2,
                        },
                        vanguard_contribution: {
                          type: "eve_public.math.Fraction",
                          id: 3,
                        },
                        stage: { type: "uint32", id: 4 },
                      },
                    },
                    GetStageThresholdsRequest: {
                      fields: {},
                    },
                    GetStageThresholdsResponse: {
                      fields: {
                        thresholds: {
                          rule: "repeated",
                          type: "eve_public.math.Fraction",
                          id: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
            suppression: {
              nested: {
                api: {
                  nested: {
                    GetSystemInfoRequest: {
                      fields: {
                        system: {
                          type: "eve_public.solarsystem.Identifier",
                          id: 1,
                        },
                      },
                    },
                    GetSystemInfoResponse: {
                      fields: {
                        total_progress: {
                          type: "eve_public.math.Fraction",
                          id: 1,
                        },
                        stage: { type: "uint32", id: 2 },
                        eve_contribution: {
                          type: "eve_public.math.Fraction",
                          id: 3,
                        },
                        vanguard_contribution: {
                          type: "eve_public.math.Fraction",
                          id: 4,
                        },
                      },
                    },
                    GetStageThresholdsRequest: {
                      fields: {},
                    },
                    GetStageThresholdsResponse: {
                      fields: {
                        thresholds: {
                          rule: "repeated",
                          type: "eve_public.math.Fraction",
                          id: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        user: {
          nested: {
            Identifier: { fields: { sequential: { type: "sint32", id: 1 } } },
            license: {
              nested: {
                Identifier: {
                  fields: {
                    license_type: { type: "string", id: 1 },
                  },
                },
                Attributes: {
                  oneofs: {
                    has_expiry_date: {
                      oneof: ["no_expiry_date", "expiry_date"],
                    },
                  },
                  fields: {
                    no_expiry_date: { type: "bool", id: 1 },
                    expiry_date: {
                      type: "google.protobuf.Timestamp",
                      id: 2,
                    },
                    last_modified: {
                      type: "google.protobuf.Timestamp",
                      id: 3,
                    },
                  },
                },
                api: {
                  nested: {
                    GetRequest: {
                      fields: {
                        license: {
                          type: "eve_public.user.license.Identifier",
                          id: 1,
                        },
                      },
                    },
                    GetResponse: {
                      fields: {
                        license: {
                          type: "eve_public.user.license.Attributes",
                          id: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        cosmetic: {
          nested: {
            corporation: {
              nested: {
                palette: {
                  nested: {
                    Identifier: {
                      fields: {
                        corporation: {
                          type: "eve_public.corporation.Identifier",
                          id: 1,
                        },
                      },
                    },
                    Attributes: {
                      oneofs: {
                        secondary: {
                          oneof: ["secondary_color", "no_secondary_color"],
                        },
                        tertiary: {
                          oneof: ["tertiary_color", "no_tertiary_color"],
                        },
                      },
                      fields: {
                        main_color: {
                          type: "eve_public.color.RGB",
                          id: 1,
                        },
                        secondary_color: {
                          type: "eve_public.color.RGB",
                          id: 2,
                        },
                        no_secondary_color: { type: "bool", id: 3 },
                        tertiary_color: {
                          type: "eve_public.color.RGB",
                          id: 4,
                        },
                        no_tertiary_color: { type: "bool", id: 5 },
                      },
                    },
                    api: {
                      nested: {
                        GetRequest: {
                          fields: {
                            identifier: {
                              type: "eve_public.cosmetic.corporation.palette.Identifier",
                              id: 1,
                            },
                          },
                        },
                        GetResponse: {
                          fields: {
                            attributes: {
                              type: "eve_public.cosmetic.corporation.palette.Attributes",
                              id: 1,
                            },
                          },
                        },
                        GetOwnRequest: {
                          fields: {},
                        },
                        GetOwnResponse: {
                          fields: {
                            attributes: {
                              type: "eve_public.cosmetic.corporation.palette.Attributes",
                              id: 1,
                            },
                            last_modifier: {
                              type: "eve_public.character.Identifier",
                              id: 2,
                            },
                            last_modified: {
                              type: "google.protobuf.Timestamp",
                              id: 3,
                            },
                          },
                        },
                        SetRequest: {
                          fields: {
                            attributes: {
                              type: "eve_public.cosmetic.corporation.palette.Attributes",
                              id: 1,
                            },
                          },
                        },
                        SetResponse: {
                          fields: {},
                        },
                        CanEditRequest: {
                          fields: {},
                        },
                        CanEditResponse: {
                          fields: {
                            can_edit: { type: "bool", id: 1 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ship: {
              nested: {
                api: {
                  nested: {
                    GetRequest: {
                      fields: {
                        ship: {
                          type: "eve_public.ship.Identifier",
                          id: 1,
                        },
                      },
                    },
                    GetResponse: {
                      fields: {
                        state: {
                          type: "eve_public.cosmetic.ship.State",
                          id: 1,
                        },
                      },
                    },
                    GetAllInBubbleRequest: {
                      fields: {},
                    },
                    GetAllInBubbleResponse: {
                      fields: {
                        states: {
                          rule: "repeated",
                          type: "eve_public.cosmetic.ship.State",
                          id: 1,
                        },
                      },
                    },
                    SetNotice: {
                      fields: {
                        state: {
                          type: "eve_public.cosmetic.ship.State",
                          id: 1,
                        },
                      },
                    },
                    SetAllInBubbleNotice: {
                      fields: {
                        state: {
                          rule: "repeated",
                          type: "eve_public.cosmetic.ship.State",
                          id: 1,
                        },
                      },
                    },
                  },
                },
                State: {
                  fields: {
                    character: {
                      type: "eve_public.character.Identifier",
                      id: 1,
                    },
                    ship: {
                      type: "eve_public.ship.Identifier",
                      id: 2,
                    },
                    skin: {
                      type: "eve_public.cosmetic.ship.State.Skin",
                      id: 3,
                    },
                  },
                  nested: {
                    Skin: {
                      oneofs: {
                        skin: {
                          oneof: ["firstparty", "thirdparty", "no_skin"],
                        },
                      },
                      fields: {
                        firstparty: {
                          type: "eve_public.cosmetic.ship.State.Skin.FirstParty",
                          id: 1,
                        },
                        thirdparty: {
                          type: "eve_public.cosmetic.ship.State.Skin.ThirdParty",
                          id: 2,
                        },
                        no_skin: { type: "bool", id: 3 },
                      },
                      nested: {
                        FirstParty: {
                          fields: {
                            identifier: {
                              type: "eve_public.cosmetic.ship.skin.firstparty.Identifier",
                              id: 1,
                            },
                          },
                        },
                        ThirdParty: {
                          fields: {
                            identifier: {
                              type: "eve_public.cosmetic.ship.skin.thirdparty.Identifier",
                              id: 1,
                            },
                          },
                        },
                      },
                    },
                  },
                },
                skin: {
                  nested: {
                    firstparty: {
                      nested: {
                        Identifier: {
                          fields: {
                            sequential: { type: "uint64", id: 1 },
                          },
                        },
                      },
                    },
                    thirdparty: {
                      nested: {
                        Identifier: {
                          fields: {
                            hex: { type: "string", id: 1 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        plex: {
          nested: {
            Currency: {
              fields: {
                // sint64, as the client declares it (eve_public/plex/plex.proto).
                total_in_cents: { type: "sint64", id: 1 },
              },
            },
            vault: {
              nested: {
                transaction: {
                  nested: {
                    Identifier: {
                      fields: {
                        sequential: { type: "int64", id: 1 },
                      },
                    },
                    Attributes: {
                      fields: {
                        timestamp: {
                          type: "google.protobuf.Timestamp",
                          id: 1,
                        },
                        amount_transferred: {
                          type: "eve_public.plex.Currency",
                          id: 2,
                        },
                        resulting_balance: {
                          type: "eve_public.plex.Currency",
                          id: 3,
                        },
                      },
                    },
                    invoice: {
                      nested: {
                        Identifier: {
                          fields: {
                            uuid: { type: "bytes", id: 1 },
                          },
                        },
                        Attributes: {
                          fields: {
                            category: {
                              type: "eve_public.localization.cerberus.FormattedMessage",
                              id: 1,
                            },
                            summary_message: {
                              type: "eve_public.localization.cerberus.FormattedMessage",
                              id: 2,
                            },
                            no_summary: { type: "bool", id: 3 },
                            source_character: {
                              type: "eve_public.character.Identifier",
                              id: 4,
                            },
                            source_corporation: {
                              type: "eve_public.corporation.Identifier",
                              id: 5,
                            },
                            no_source: { type: "bool", id: 6 },
                            destination_character: {
                              type: "eve_public.character.Identifier",
                              id: 7,
                            },
                            destination_corporation: {
                              type: "eve_public.corporation.Identifier",
                              id: 8,
                            },
                            no_destination: { type: "bool", id: 9 },
                          },
                        },
                      },
                    },
                    api: {
                      nested: {
                        GetAllLoggedForUserRequest: {
                          fields: {},
                        },
                        GetAllLoggedForUserResponse: {
                          fields: {
                            transactions: {
                              rule: "repeated",
                              type: "eve_public.plex.vault.transaction.Identifier",
                              id: 1,
                            },
                          },
                        },
                        GetLogRequest: {
                          fields: {
                            identifier: {
                              type: "eve_public.plex.vault.transaction.Identifier",
                              id: 1,
                            },
                          },
                        },
                        GetLogResponse: {
                          fields: {
                            transaction: {
                              type: "eve_public.plex.vault.transaction.Attributes",
                              id: 1,
                            },
                            unavailable: { type: "bool", id: 2 },
                            invoice_entry: {
                              type: "eve_public.plex.vault.transaction.api.GetLogResponse.Invoice",
                              id: 3,
                            },
                          },
                          nested: {
                            Invoice: {
                              fields: {
                                id: {
                                  type: "eve_public.plex.vault.transaction.invoice.Identifier",
                                  id: 1,
                                },
                                attributes: {
                                  type: "eve_public.plex.vault.transaction.invoice.Attributes",
                                  id: 2,
                                },
                              },
                            },
                          },
                        },
                        GetStatisticsRequest: {
                          fields: {},
                        },
                        GetStatisticsResponse: {
                          fields: {
                            entries: {
                              rule: "repeated",
                              type: "eve_public.plex.vault.transaction.api.GetStatisticsResponse.Entry",
                              id: 1,
                            },
                            earliest_transaction: {
                              type: "google.protobuf.Timestamp",
                              id: 2,
                            },
                          },
                          nested: {
                            Entry: {
                              fields: {
                                category: {
                                  type: "eve_public.localization.cerberus.FormattedMessage",
                                  id: 1,
                                },
                                no_classification: { type: "bool", id: 2 },
                                incomes: {
                                  type: "eve_public.plex.Currency",
                                  id: 3,
                                },
                                expenses: {
                                  type: "eve_public.plex.Currency",
                                  id: 4,
                                },
                                transactions_count: { type: "uint32", id: 5 },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                api: {
                  nested: {
                    BalanceRequest: {
                      fields: {},
                    },
                    BalanceResponse: {
                      fields: {
                        balance: {
                          type: "eve_public.plex.Currency",
                          id: 1,
                        },
                      },
                    },
                    BalanceChangedNotice: {
                      fields: {
                        identifier: {
                          type: "eve_public.plex.vault.transaction.Identifier",
                          id: 1,
                        },
                        attributes: {
                          type: "eve_public.plex.vault.transaction.Attributes",
                          id: 2,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});
const RequestEnvelope = PROTO_ROOT.lookupType("eve_public.Request");
const ResponseEnvelope = PROTO_ROOT.lookupType("eve_public.Response");
const NoticeEnvelope = PROTO_ROOT.lookupType("eve_public.Notice");
const skinrShipProtoRoot = require("./gatewayServices/shipSkinGatewayProto").getShipSkinProtoRoot();
const ShipStateGetRequest = skinrShipProtoRoot.lookupType(
  "eve_public.cosmetic.ship.api.GetRequest",
);
const ShipStateGetResponse = skinrShipProtoRoot.lookupType(
  "eve_public.cosmetic.ship.api.GetResponse",
);
const ShipStateGetAllInBubbleResponse = skinrShipProtoRoot.lookupType(
  "eve_public.cosmetic.ship.api.GetAllInBubbleResponse",
);
const ShipStateSetNotice = skinrShipProtoRoot.lookupType(
  "eve_public.cosmetic.ship.api.SetNotice",
);
const ShipStateSetAllInBubbleNotice = skinrShipProtoRoot.lookupType(
  "eve_public.cosmetic.ship.api.SetAllInBubbleNotice",
);
const UserLicenseGetRequest = PROTO_ROOT.lookupType(
  "eve_public.user.license.api.GetRequest",
);
const UserLicenseGetResponse = PROTO_ROOT.lookupType(
  "eve_public.user.license.api.GetResponse",
);
const PlexVaultBalanceResponse = PROTO_ROOT.lookupType(
  "eve_public.plex.vault.api.BalanceResponse",
);
const PlexVaultBalanceChangedNotice = PROTO_ROOT.lookupType(
  "eve_public.plex.vault.api.BalanceChangedNotice",
);
const STRUCTURE_PAINTWORK_PROTO_ROOT = buildStructurePaintworkProtoRoot();
const StructurePaintworkSetNotice = STRUCTURE_PAINTWORK_PROTO_ROOT.lookupType(
  "eve_public.cosmetic.structure.paintwork.api.SetNotice",
);
const StructurePaintworkSetAllInSolarSystemNotice =
  STRUCTURE_PAINTWORK_PROTO_ROOT.lookupType(
    "eve_public.cosmetic.structure.paintwork.api.SetAllInSolarSystemNotice",
  );

const OMEGA_USER_LICENSE_TYPE = "eve_clonestate_omega";
// The client divides total_in_cents by 100 (plex/client/repository.py). It
// reads the field as sint64; encoded as uint64 it came out halved, which a
// factor of 200 used to hide.
const PLEX_GATEWAY_CENTS_PER_PLEX = 100;
const gatewayServiceRegistry = createGatewayServiceRegistry({
  protoRoot: PROTO_ROOT,
  emptyPayload: EMPTY_PAYLOAD,
  plexGatewayCentsPerPlex: PLEX_GATEWAY_CENTS_PER_PLEX,
  publishGatewayNotice,
});

function timestampNow() {
  const now = Date.now();
  return {
    seconds: Math.floor(now / 1000),
    nanos: (now % 1000) * 1000000,
  };
}

function bufferFromBytes(value) {
  if (!value) {
    return EMPTY_PAYLOAD;
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (Array.isArray(value)) {
    return Buffer.from(value);
  }

  return Buffer.from(String(value), "utf8");
}

function bytesToHex(value) {
  const buffer = bufferFromBytes(value);
  return buffer.length > 0 ? buffer.toString("hex") : "";
}

function uuidBuffer() {
  return Buffer.from(crypto.randomUUID().replace(/-/g, ""), "hex");
}

function normalizeProtoNumber(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function removeNoticeStream(stream) {
  if (ACTIVE_NOTICE_STREAMS.delete(stream)) {
    log.info(
      `[PublicGatewayLocal] Notices.Consume disconnected active=${ACTIVE_NOTICE_STREAMS.size}`,
    );
  }
}

function getGatewayTransport(stream) {
  const transport = stream && stream.session;
  return transport &&
    (typeof transport === "object" || typeof transport === "function")
    ? transport
    : null;
}

function observeRequestCharacterIdentity(requestEnvelope) {
  const authoritativeContext =
    requestEnvelope &&
    requestEnvelope.authoritative_context &&
    typeof requestEnvelope.authoritative_context === "object"
      ? requestEnvelope.authoritative_context
      : null;
  const identityCharacter =
    authoritativeContext &&
    authoritativeContext.identity &&
    authoritativeContext.identity.character
      ? authoritativeContext.identity.character
      : null;
  const activeCharacter =
    authoritativeContext && authoritativeContext.active_character
      ? authoritativeContext.active_character
      : null;
  const identityCharacterID = Number(identityCharacter && identityCharacter.sequential || 0);
  const activeCharacterID = Number(activeCharacter && activeCharacter.sequential || 0);
  const invalid = Boolean(
    (identityCharacter && (!Number.isSafeInteger(identityCharacterID) || identityCharacterID <= 0)) ||
    (activeCharacter && (!Number.isSafeInteger(activeCharacterID) || activeCharacterID <= 0)) ||
    (identityCharacterID && activeCharacterID && identityCharacterID !== activeCharacterID) ||
    (authoritativeContext?.no_active_identity === true && (identityCharacter || activeCharacter))
  );
  return {
    observed: Boolean(identityCharacter || activeCharacter || authoritativeContext?.no_active_identity === true),
    activeCharacterID: invalid ? 0 : getActiveCharacterID(requestEnvelope),
    invalid,
  };
}

function mergeNoticeStreamIdentity(
  state,
  activeCharacterID,
  applicationInstanceHex,
  options = {},
) {
  if (!state) {
    return false;
  }

  const previousCharacterID = Number(state.activeCharacterID || 0) || 0;
  const numericCharacterID = Number(activeCharacterID || 0) || 0;
  if (options.activeCharacterObserved === true) {
    state.activeCharacterID = numericCharacterID;
    state.activeCharacterObserved = true;
  }
  if (options.userObserved === true) {
    state.userID = Number(options.userID || 0);
    state.userObserved = true;
  }
  if (state.userObserved && state.activeCharacterID && resolveCharacterAccountID(state.activeCharacterID) !== state.userID) {
    state.activeCharacterID = 0; state.activeCharacterObserved = true;
  }

  const normalizedApplicationInstanceHex = String(
    applicationInstanceHex || "",
  );
  if (normalizedApplicationInstanceHex) {
    state.applicationInstanceHex = normalizedApplicationInstanceHex;
  }

  const nextCharacterID = Number(state.activeCharacterID || 0) || 0;
  return nextCharacterID > 0 && nextCharacterID !== previousCharacterID;
}

function isKnownLicenseAccount(accountID) {
  return Number.isSafeInteger(accountID) && accountID > 0 &&
    Object.values(require("../../services/login/accountStore").readAccountsTable())
      .some(account => Number(account?.accountID ?? account?.id ?? account?.userID) === accountID && !account.banned);
}
function observeRequestUserIdentity(requestEnvelope) {
  const context = requestEnvelope?.authoritative_context;
  if (context?.no_authenticated_user === true && (context.authenticated_user || getActiveCharacterID(requestEnvelope)))
    return { observed: true, userID: 0, invalid: true };
  if (context?.authenticated_user) {
    const userID = Number(context.authenticated_user.sequential);
    const characterID = getActiveCharacterID(requestEnvelope);
    const invalid = !isKnownLicenseAccount(userID) ||
      (characterID > 0 && resolveCharacterAccountID(characterID) !== userID);
    return { observed: true, userID: invalid ? 0 : userID, invalid };
  }
  return { observed: context?.no_authenticated_user === true, userID: 0, invalid: false };
}

function gatewayRequestHasInvalidIdentity(requestEnvelope, stream) {
  const character = observeRequestCharacterIdentity(requestEnvelope);
  const user = observeRequestUserIdentity(requestEnvelope);
  if (character.invalid || user.invalid) {
    return true;
  }
  const transport = getGatewayTransport(stream);
  const previous = transport ? GATEWAY_TRANSPORT_IDENTITIES.get(transport) : null;
  const userObserved = user.observed || previous?.userObserved;
  const userID = user.observed ? user.userID : previous?.userID;
  return Boolean(userObserved && character.activeCharacterID &&
    resolveCharacterAccountID(character.activeCharacterID) !== userID);
}

function observeGatewayTransportIdentity(stream, requestEnvelope) {
  const characterObservation =
    observeRequestCharacterIdentity(requestEnvelope);
  const user = observeRequestUserIdentity(requestEnvelope);
  if (user.invalid || characterObservation.invalid) { characterObservation.observed = true; characterObservation.activeCharacterID = 0; }
  const applicationInstanceHex = bytesToHex(
    requestEnvelope && requestEnvelope.application_instance_uuid,
  );
  const transport = getGatewayTransport(stream);

  if (!transport) {
    return {
      activeCharacterID: characterObservation.activeCharacterID,
      activeCharacterObserved: characterObservation.observed,
      applicationInstanceHex,
      userID: user.userID,
      userObserved: user.observed,
    };
  }

  const previousIdentity = GATEWAY_TRANSPORT_IDENTITIES.get(transport) || {};
  const nextIdentity = {
    activeCharacterID: characterObservation.observed
      ? Number(characterObservation.activeCharacterID || 0) || 0
      : Number(previousIdentity.activeCharacterID || 0) || 0,
    activeCharacterObserved:
      characterObservation.observed ||
      previousIdentity.activeCharacterObserved === true,
    userID: user.observed ? user.userID : Number(previousIdentity.userID || 0),
    userObserved: user.observed || previousIdentity.userObserved === true,
    applicationInstanceHex:
      String(applicationInstanceHex || "") ||
      String(previousIdentity.applicationInstanceHex || ""),
  };
  if (nextIdentity.userObserved && nextIdentity.activeCharacterID && resolveCharacterAccountID(nextIdentity.activeCharacterID) !== nextIdentity.userID) {
    nextIdentity.activeCharacterID = 0; nextIdentity.activeCharacterObserved = true;
  }
  GATEWAY_TRANSPORT_IDENTITIES.set(transport, nextIdentity);

  for (const state of ACTIVE_NOTICE_STREAMS.values()) {
    if (!state || state.gatewayTransport !== transport) {
      continue;
    }
    if (
      mergeNoticeStreamIdentity(
        state,
        nextIdentity.activeCharacterID,
        nextIdentity.applicationInstanceHex,
        {
          activeCharacterObserved: nextIdentity.activeCharacterObserved,
          userID: nextIdentity.userID, userObserved: nextIdentity.userObserved === true,
        },
      )
    ) {
      pushLocalMembershipSnapshotForCharacter(state.activeCharacterID);
    }
  }

  return nextIdentity;
}

function getNoticeStreamState(stream) {
  if (!ACTIVE_NOTICE_STREAMS.has(stream)) {
    const gatewayTransport = getGatewayTransport(stream);
    const transportIdentity = gatewayTransport
      ? GATEWAY_TRANSPORT_IDENTITIES.get(gatewayTransport)
      : null;
    const state = {
      activeCharacterID: 0,
      userID: 0,
      activeCharacterObserved: false,
      applicationInstanceHex: "",
      gatewayTransport,
    };
    ACTIVE_NOTICE_STREAMS.set(stream, state);
    if (
      transportIdentity &&
      mergeNoticeStreamIdentity(
        state,
        transportIdentity.activeCharacterID,
        transportIdentity.applicationInstanceHex,
        {
          activeCharacterObserved:
            transportIdentity.activeCharacterObserved === true,
          userID: transportIdentity.userID, userObserved: transportIdentity.userObserved === true,
        },
      )
    ) {
      pushLocalMembershipSnapshotForCharacter(state.activeCharacterID);
    }
  }
  return ACTIVE_NOTICE_STREAMS.get(stream);
}

// When a notice-consumer stream first identifies its character, immediately push
// that character's local-chat membership snapshot. The notice stream is a
// separate HTTP/2 stream that frequently comes up AFTER the login session
// change already fired its (fire-and-forget, un-replayed) MembershipListNotice,
// so without this the client waits out its ~4s GetMembershipList fallback timer
// before the local member list appears. Pushing here delivers the snapshot the
// instant the stream is able to receive it. The snapshot is a set-based
// idempotent full-list replacement on the client, so an extra push is harmless.
function pushLocalMembershipSnapshotForCharacter(characterID) {
  const numericCharacterID = Number(characterID || 0) || 0;
  if (numericCharacterID <= 0) {
    return;
  }
  try {
    const session = sessionRegistry.findSessionByCharacterID(numericCharacterID);
    if (!session) {
      return;
    }
    const chatRuntime = require(path.join(__dirname, "../chat/chatRuntime"));
    if (typeof chatRuntime.publishLocalMembershipListForSession === "function") {
      chatRuntime.publishLocalMembershipListForSession(session);
    }
  } catch (error) {
    log.debug(
      `[PublicGatewayLocal] Local membership push on notice identify failed char=${numericCharacterID}: ${error.message}`,
    );
  }
}

function updateNoticeStreamState(stream, requestEnvelope) {
  const state = getNoticeStreamState(stream);
  const observedIdentity = observeGatewayTransportIdentity(
    stream,
    requestEnvelope,
  );
  if (
    !state.gatewayTransport &&
    mergeNoticeStreamIdentity(
      state,
      observedIdentity.activeCharacterID,
      observedIdentity.applicationInstanceHex,
      {
        activeCharacterObserved:
          observedIdentity.activeCharacterObserved === true,
        userID: observedIdentity.userID, userObserved: observedIdentity.userObserved === true,
      },
    )
  ) {
    pushLocalMembershipSnapshotForCharacter(state.activeCharacterID);
  }
  return state;
}

function resolveNoticeRoutingState(streamState) {
  const state = streamState || {};
  const transportIdentity = state.gatewayTransport
    ? GATEWAY_TRANSPORT_IDENTITIES.get(state.gatewayTransport)
    : null;
  const routingState = {
    activeCharacterID:
      Number(state.activeCharacterID || 0) ||
      Number((transportIdentity && transportIdentity.activeCharacterID) || 0) ||
      0,
    activeCharacterObserved:
      state.activeCharacterObserved === true ||
      Boolean(
        transportIdentity &&
          transportIdentity.activeCharacterObserved === true,
      ),
    applicationInstanceHex:
      String(state.applicationInstanceHex || "") ||
      String(
        (transportIdentity && transportIdentity.applicationInstanceHex) || "",
      ),
    userID: Number(state.userID || transportIdentity?.userID || 0),
    corporationID: 0,
    allianceID: 0,
    solarSystemID: 0,
  };

  const session = routingState.activeCharacterID
    ? sessionRegistry.findSessionByCharacterID(routingState.activeCharacterID)
    : null;
  if (session) {
    routingState.solarSystemID = Number(session.solarsystemid2 || 0) || 0;
  }
  if (routingState.activeCharacterID) {
    const character = getCharacterStateService().peekCharacterRecord(routingState.activeCharacterID);
    if (character && !character.isDeleted && !character.deletedAt) {
      const { getPersistedCorporationAuthority, getAllianceMemberAuthority } =
        require("../../services/corporation/corporationAuthority");
      const actor = { characterID: routingState.activeCharacterID, corporationID: character.corporationID };
      routingState.userID = resolveCharacterAccountID(routingState.activeCharacterID);
      routingState.corporationID = getPersistedCorporationAuthority(actor)?.corporationID || 0;
      routingState.allianceID = getAllianceMemberAuthority(actor)?.allianceID || 0;
      if (!session) routingState.solarSystemID = Number(character.solarSystemID || 0);
    }
  }

  return routingState;
}

function shouldDeliverNoticeToState(routingState, noticeEnvelope) {
  const targetGroup =
    noticeEnvelope && noticeEnvelope.target_group
      ? noticeEnvelope.target_group
      : null;
  if (!targetGroup || typeof targetGroup !== "object") {
    return true;
  }

  const applicationInstanceHex = bytesToHex(targetGroup.application_instance_uuid);
  if (applicationInstanceHex) {
    return routingState.applicationInstanceHex === applicationInstanceHex;
  }

  const solarSystemID = normalizeProtoNumber(targetGroup.solar_system);
  if (solarSystemID > 0) {
    if (
      routingState.activeCharacterObserved === true &&
      routingState.activeCharacterID <= 0
    ) {
      return false;
    }
    return routingState.solarSystemID === solarSystemID;
  }

  const userID = normalizeProtoNumber(targetGroup.user);
  if (userID > 0) {
    return routingState.userID === userID;
  }

  const characterID = normalizeProtoNumber(targetGroup.character);
  if (characterID > 0) {
    if (
      routingState.activeCharacterObserved === true &&
      routingState.activeCharacterID <= 0
    ) {
      return false;
    }
    return routingState.activeCharacterID === characterID;
  }

  const corporationID = normalizeProtoNumber(targetGroup.corporation);
  if (corporationID > 0) {
    if (
      routingState.activeCharacterObserved === true &&
      routingState.activeCharacterID <= 0
    ) {
      return false;
    }
    return routingState.corporationID === corporationID;
  }

  const allianceID = normalizeProtoNumber(targetGroup.alliance);
  if (allianceID > 0) {
    if (
      routingState.activeCharacterObserved === true &&
      routingState.activeCharacterID <= 0
    ) {
      return false;
    }
    return routingState.allianceID === allianceID;
  }

  if (bufferFromBytes(targetGroup.bubble_instance_uuid).length > 0) {
    return false;
  }

  return true;
}

function extractTypeName(typeUrl) {
  const normalized = String(typeUrl || "");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function normalizeGatewayRequestTypeName(requestTypeName) {
  return String(requestTypeName || "")
    .replace(".requests_pb2.", ".")
    .replace(".api_pb2.", ".");
}

function correlationLabel(requestEnvelope) {
  const correlation = bufferFromBytes(
    requestEnvelope && requestEnvelope.correlation_uuid,
  );
  if (!correlation.length) {
    return "none";
  }

  return correlation.toString("hex").slice(0, 16);
}

function shouldLogUnknownCount(count) {
  return count <= 3 || (count & (count - 1)) === 0;
}

function buildAny(typeName, payloadBuffer) {
  return {
    type_url: `type.googleapis.com/${typeName}`,
    value: payloadBuffer,
  };
}

function createGrpcFrame(messageBuffer) {
  const payload = Buffer.from(messageBuffer || EMPTY_PAYLOAD);
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function createGrpcFrameParser(onFrame) {
  let pending = EMPTY_PAYLOAD;

  return function parseChunk(chunk) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);

    while (pending.length >= 5) {
      const compressed = pending[0];
      const payloadLength = pending.readUInt32BE(1);
      if (pending.length < 5 + payloadLength) {
        return;
      }

      const payload = pending.subarray(5, 5 + payloadLength);
      pending = pending.subarray(5 + payloadLength);

      if (compressed !== 0) {
        log.warn(
          `[PublicGatewayLocal] Ignoring compressed gRPC frame flag=${compressed}`,
        );
        continue;
      }

      onFrame(Buffer.from(payload));
    }
  };
}

function getActiveCharacterID(requestEnvelope) {
  const identityCharacter =
    requestEnvelope &&
    requestEnvelope.authoritative_context &&
    requestEnvelope.authoritative_context.identity &&
    requestEnvelope.authoritative_context.identity.character
      ? normalizeProtoNumber(
          requestEnvelope.authoritative_context.identity.character.sequential,
        )
      : 0;
  if (identityCharacter) {
    return identityCharacter;
  }

  return requestEnvelope &&
    requestEnvelope.authoritative_context &&
    requestEnvelope.authoritative_context.active_character
    ? normalizeProtoNumber(
        requestEnvelope.authoritative_context.active_character.sequential,
      )
    : 0;
}

function getSessionCharacterID(session) {
  return normalizeProtoNumber(
    session &&
      (session.characterID ||
        session.charID ||
        session.charid ||
        session.characterId),
  );
}

function findLiveSessionByCharacterID(characterID) {
  const numericCharacterID = normalizeProtoNumber(characterID);
  if (!numericCharacterID) {
    return null;
  }

  return (
    sessionRegistry
      .getSessions()
      .find((session) => getSessionCharacterID(session) === numericCharacterID) ||
    null
  );
}

function buildShipStateObject(shipID, activeCharacterID) {
  const numericShipID = normalizeProtoNumber(shipID);
  if (!numericShipID) {
    return null;
  }

  const shipItem = findShipItemById(numericShipID);
  const candidate = getAppliedSkinRecord(numericShipID);
  const appliedRecord = shipItem && Number(candidate?.ownerID || candidate?.characterID) === Number(shipItem.ownerID) ? candidate : null;
  const thirdparty = require("../../services/ship/shipSkinThirdPartyRuntime").getAppliedShipSkin(numericShipID);
  if (!appliedRecord && !shipItem) {
    return null;
  }

  const ownerID =
    normalizeProtoNumber(
      appliedRecord && appliedRecord.characterID ? appliedRecord.characterID : 0,
    ) ||
    normalizeProtoNumber(
      appliedRecord && appliedRecord.ownerID ? appliedRecord.ownerID : 0,
    ) ||
    normalizeProtoNumber(shipItem && shipItem.ownerID ? shipItem.ownerID : 0) ||
    normalizeProtoNumber(activeCharacterID);
  const skinID = normalizeProtoNumber(
    appliedRecord && appliedRecord.skinID ? appliedRecord.skinID : 0,
  );

  const state = {
    character: {
      sequential: ownerID,
    },
    ship: {
      sequential: numericShipID,
    },
    skin: thirdparty ? { thirdparty: { identifier: { hex: thirdparty.hex }, layout: thirdparty.layout } } : skinID
      ? {
          firstparty: {
            identifier: {
              sequential: skinID,
            },
          },
        }
      : {
          no_skin: true,
        },
  };

  return state;
}

function buildOwnerShipStates(activeCharacterID) {
  const ids = new Set(getAppliedSkinRecordsForOwner(activeCharacterID).map(record => Number(record.shipID)));
  for (const ship of require("../../services/inventory/itemStore").getCharacterShipItems(activeCharacterID)) if (ship.skinrApplication) ids.add(Number(ship.itemID));
  return [...ids]
    .map(shipID => buildShipStateObject(shipID, activeCharacterID))
    .filter(Boolean);
}

function buildVisibleShipStatesForSession(session, activeCharacterID = 0) {
  const scene = spaceRuntime.getSceneForSession(session);
  if (!scene) {
    return [];
  }

  const seenShipIDs = new Set();
  const states = [];
  for (const entity of scene.getVisibleDynamicEntitiesForSession(session)) {
    if (!entity || entity.kind !== "ship") {
      continue;
    }

    const numericShipID = normalizeProtoNumber(entity.itemID);
    if (!numericShipID || seenShipIDs.has(numericShipID)) {
      continue;
    }

    seenShipIDs.add(numericShipID);
    const state = buildShipStateObject(numericShipID, activeCharacterID);
    if (state) {
      states.push(state);
    }
  }

  states.sort((left, right) => {
    const leftShipID = normalizeProtoNumber(
      left && left.ship ? left.ship.sequential : 0,
    );
    const rightShipID = normalizeProtoNumber(
      right && right.ship ? right.ship.sequential : 0,
    );
    return leftShipID - rightShipID;
  });
  return states;
}

function buildBubbleShipStatesForCharacter(activeCharacterID) {
  const liveSession = findLiveSessionByCharacterID(activeCharacterID);
  if (!liveSession) {
    return buildOwnerShipStates(activeCharacterID);
  }

  return buildVisibleShipStatesForSession(liveSession, activeCharacterID);
}

function getObserverCharacterIDsForShip(shipID) {
  const numericShipID = normalizeProtoNumber(shipID);
  if (!numericShipID) {
    return [];
  }

  const now = Date.now();
  const seenCharacterIDs = new Set();
  const observerCharacterIDs = [];
  for (const session of sessionRegistry.getSessions()) {
    const characterID = getSessionCharacterID(session);
    if (!characterID || seenCharacterIDs.has(characterID)) {
      continue;
    }

    const scene = spaceRuntime.getSceneForSession(session);
    if (!scene) {
      continue;
    }

    const entity = scene.getEntityByID(numericShipID);
    if (!entity || entity.kind !== "ship") {
      continue;
    }

    if (!scene.canSessionSeeDynamicEntity(session, entity, now)) {
      continue;
    }

    seenCharacterIDs.add(characterID);
    observerCharacterIDs.push(characterID);
  }

  observerCharacterIDs.sort((left, right) => left - right);
  return observerCharacterIDs;
}

function buildShipStateResponsePayload(requestEnvelope) {
  const decoded = ShipStateGetRequest.decode(
    bufferFromBytes(requestEnvelope.payload && requestEnvelope.payload.value),
  );
  const shipID = normalizeProtoNumber(decoded && decoded.ship && decoded.ship.sequential);
  const state = buildShipStateObject(shipID, getActiveCharacterID(requestEnvelope));
  if (!state) {
    return null;
  }

  return Buffer.from(
    ShipStateGetResponse.encode(
      ShipStateGetResponse.create({
        state,
      }),
    ).finish(),
  );
}

function buildShipStatesInBubblePayload(requestEnvelope) {
  const activeCharacterID = getActiveCharacterID(requestEnvelope);
  const states = buildBubbleShipStatesForCharacter(activeCharacterID);

  return Buffer.from(
    ShipStateGetAllInBubbleResponse.encode(
      ShipStateGetAllInBubbleResponse.create({
        states,
      }),
    ).finish(),
  );
}

function omegaLicenseEnabled(activeCharacterID = 0) {
  const accountID = resolveCharacterAccountID(activeCharacterID);
  const omegaState = resolveOmegaLicenseState(accountID);
  return Boolean(omegaState && omegaState.hasLicense);
}

function buildUserLicenseResponsePayload(requestEnvelope) {
  let decoded;
  try { decoded = UserLicenseGetRequest.decode(bufferFromBytes(requestEnvelope.payload && requestEnvelope.payload.value)); }
  catch (_) { return { statusCode: 400, payloadBuffer: EMPTY_PAYLOAD, hasLicense: false }; }
  const activeCharacterID = getActiveCharacterID(requestEnvelope);
  const authenticated = observeRequestUserIdentity(requestEnvelope);
  const accountID = authenticated.observed ? authenticated.userID : resolveCharacterAccountID(activeCharacterID);
  const explicitActive = Number(requestEnvelope.authoritative_context?.active_character?.sequential || 0);
  if (!isKnownLicenseAccount(accountID) || authenticated.invalid || (explicitActive && explicitActive !== activeCharacterID))
    return { statusCode: 401, payloadBuffer: EMPTY_PAYLOAD, hasLicense: false };
  const licenseType = String(
    decoded && decoded.license && decoded.license.license_type
      ? decoded.license.license_type
      : "",
  );

  if (licenseType !== OMEGA_USER_LICENSE_TYPE) {
    return {
      statusCode: 404,
      payloadBuffer: Buffer.from(
        UserLicenseGetResponse.encode(
          UserLicenseGetResponse.create({}),
        ).finish(),
      ),
      hasLicense: false,
      licenseType,
    };
  }

  const omegaState = resolveOmegaLicenseState(accountID);

  if (!omegaState || !omegaState.hasLicense) {
    return {
      statusCode: 404,
      payloadBuffer: Buffer.from(
        UserLicenseGetResponse.encode(
          UserLicenseGetResponse.create({}),
        ).finish(),
      ),
      hasLicense: false,
      licenseType,
    };
  }

  return {
    payloadBuffer: Buffer.from(
      UserLicenseGetResponse.encode(
        UserLicenseGetResponse.create({
          // This client ignores no_expiry_date, so always retain real expiry.
          license: require("./gatewayServices/userLicenseGatewayService").attributes(omegaState),
        }),
      ).finish(),
    ),
    hasLicense: true,
    licenseType,
  };
}

function buildPlexBalanceResponsePayload(requestEnvelope) {
  const activeCharacterID = getActiveCharacterID(requestEnvelope);
  // The vault balance is the wallet's, as vaultManager answers it; the
  // character record's copy can lag behind it.
  const { getCharacterWallet } = require(path.join(__dirname, "../../services/account/walletState"));
  const wallet = activeCharacterID ? getCharacterWallet(activeCharacterID) : null;
  const charData = getCharacterRecord(activeCharacterID) || {};
  const plexBalance = Math.max(
    0,
    Math.trunc(Number(
      wallet && wallet.plexBalance !== undefined
        ? wallet.plexBalance
        : charData.plexBalance ?? getDefaultPlexBalance(),
    ) || 0),
  );
  const totalInCents = plexBalance * PLEX_GATEWAY_CENTS_PER_PLEX;
  log.info(
    `[PublicGatewayLocal] PlexBalance.Get character=${activeCharacterID || 0} ` +
      `plex=${plexBalance} totalInCents=${totalInCents}`,
  );

  return Buffer.from(
    PlexVaultBalanceResponse.encode(
      PlexVaultBalanceResponse.create({
        balance: {
          total_in_cents: totalInCents,
        },
      }),
    ).finish(),
  );
}

function publishPlexBalanceChangedNotice(
  activeCharacterID,
  resultingBalance,
  amountTransferred,
) {
  const numericCharacterID = normalizeProtoNumber(activeCharacterID);
  if (!numericCharacterID) {
    return false;
  }

  const resultingBalanceInCents = Math.max(
    0,
    Math.trunc(
      Number(resultingBalance || 0) * PLEX_GATEWAY_CENTS_PER_PLEX,
    ),
  );
  const amountTransferredInCents = Math.trunc(
    Number(amountTransferred || 0) * PLEX_GATEWAY_CENTS_PER_PLEX,
  );
  const noticePayload = Buffer.from(
    PlexVaultBalanceChangedNotice.encode(
      PlexVaultBalanceChangedNotice.create({
        identifier: {
          sequential: Date.now(),
        },
        attributes: {
          timestamp: timestampNow(),
          amount_transferred: {
            total_in_cents: amountTransferredInCents,
          },
          resulting_balance: {
            total_in_cents: resultingBalanceInCents,
          },
        },
      }),
    ).finish(),
  );
  const noticeEnvelope = encodeNoticeEnvelope(
    "eve_public.plex.vault.api.BalanceChangedNotice",
    noticePayload,
    {
      character: numericCharacterID,
    },
  );

  log.info(
    `[PublicGatewayLocal] Notices.Publish eve_public.plex.vault.api.BalanceChangedNotice ` +
      `targetCharacterID=${numericCharacterID} balance=${resultingBalanceInCents} ` +
      `delta=${amountTransferredInCents} streams=${ACTIVE_NOTICE_STREAMS.size}`,
  );
  broadcastNoticeEnvelope(noticeEnvelope);
  return true;
}

function encodeNoticeEnvelope(noticeTypeName, noticePayloadBuffer, targetGroup, noticeUUID = uuidBuffer()) {
  const noticeEnvelope = NoticeEnvelope.create({
    dispatched: timestampNow(),
    uuid: noticeUUID,
    internal_origin: PUBLIC_GATEWAY_ORIGIN,
    tenant: "",
    payload: buildAny(noticeTypeName, noticePayloadBuffer || EMPTY_PAYLOAD),
    target_group: targetGroup,
  });

  return Buffer.from(NoticeEnvelope.encode(noticeEnvelope).finish());
}

function broadcastNoticeEnvelope(noticeBuffer, routingMetadata = {}) {
  const grpcFrame = createGrpcFrame(noticeBuffer);
  // Publication metadata is an in-process routing concern only. It is never
  // added to the protobuf NoticeEnvelope or its target_group.
  const excludeCharacterID = normalizeProtoNumber(
    routingMetadata && routingMetadata.excludeCharacterID,
  );
  let noticeEnvelope = null;
  try {
    noticeEnvelope = NoticeEnvelope.decode(noticeBuffer);
  } catch (error) {
    log.warn(
      `[PublicGatewayLocal] Failed to decode notice envelope for routing: ${error.message}`,
    );
  }

  for (const [stream, streamState] of [...ACTIVE_NOTICE_STREAMS.entries()]) {
    if (stream.destroyed || stream.closed) {
      ACTIVE_NOTICE_STREAMS.delete(stream);
      continue;
    }

    try {
      const routingState = resolveNoticeRoutingState(streamState);
      if (
        excludeCharacterID > 0 &&
        routingState.activeCharacterID === excludeCharacterID
      ) {
        continue;
      }
      if (
        noticeEnvelope &&
        !shouldDeliverNoticeToState(
          routingState,
          noticeEnvelope,
        )
      ) {
        continue;
      }
      stream.write(grpcFrame);
    } catch (error) {
      log.warn(
        `[PublicGatewayLocal] Failed writing notice to stream: ${error.message}`,
      );
      ACTIVE_NOTICE_STREAMS.delete(stream);
    }
  }
}

function publishGatewayNotice(
  noticeTypeName,
  noticePayloadBuffer,
  targetGroup,
  routingMetadata = {},
) {
  const noticeEnvelope = encodeNoticeEnvelope(
    noticeTypeName,
    noticePayloadBuffer,
    targetGroup,
    routingMetadata.noticeUUID,
  );
  broadcastNoticeEnvelope(noticeEnvelope, routingMetadata);
  return true;
}

function buildStructureIdentifier(id) {
  return {
    sequential: normalizeProtoNumber(id),
  };
}

function buildSolarSystemIdentifier(id) {
  return {
    sequential: normalizeProtoNumber(id),
  };
}

function buildStructurePaintworkPayload(paintwork) {
  const source = normalizePaintwork(paintwork);
  const payload = {};
  for (const slotName of [
    "first",
    "second",
    "third",
    "fourth",
    "primary",
    "secondary",
    "detailing",
  ]) {
    if (!source[slotName] || typeof source[slotName] !== "object") {
      continue;
    }
    if (source[slotName].paint !== undefined && source[slotName].paint !== null) {
      payload[slotName] = {
        paint: normalizeProtoNumber(source[slotName].paint),
      };
      continue;
    }
    payload[slotName] = {
      empty: Boolean(source[slotName].empty),
    };
  }
  return payload;
}

function resolveStructurePaintworkNoticeState(structureID, options = {}) {
  const numericStructureID = normalizeProtoNumber(structureID);
  const activeLicense = getLicenseForStructure(numericStructureID);
  const structure = getStructureByID(numericStructureID, { refresh: false });
  const solarSystemID = normalizeProtoNumber(
    options.solarSystemID ||
      (activeLicense && activeLicense.solarSystemID) ||
      (structure && structure.solarSystemID),
  );
  const paintworkSource = Object.prototype.hasOwnProperty.call(options, "paintwork")
    ? options.paintwork
    : activeLicense && activeLicense.paintwork;

  return {
    structureID: numericStructureID,
    solarSystemID,
    paintwork: buildStructurePaintworkPayload(paintworkSource),
  };
}

function publishStructurePaintworkSetNotice(structureID, options = {}) {
  const state = resolveStructurePaintworkNoticeState(structureID, options);
  if (!state.structureID || !state.solarSystemID) {
    log.warn(
      `[PublicGatewayLocal] Skipped SetNotice for structureID=${structureID}; solar system unavailable`,
    );
    return false;
  }

  const noticePayload = Buffer.from(
    StructurePaintworkSetNotice.encode(
      StructurePaintworkSetNotice.create({
        structure: buildStructureIdentifier(state.structureID),
        paintwork: state.paintwork,
      }),
    ).finish(),
  );
  const noticeEnvelope = encodeNoticeEnvelope(
    "eve_public.cosmetic.structure.paintwork.api.SetNotice",
    noticePayload,
    {
      solar_system: state.solarSystemID,
    },
  );

  log.info(
    `[PublicGatewayLocal] Notices.Publish eve_public.cosmetic.structure.paintwork.api.SetNotice ` +
      `structureID=${state.structureID} solarSystemID=${state.solarSystemID} streams=${ACTIVE_NOTICE_STREAMS.size}`,
  );
  broadcastNoticeEnvelope(noticeEnvelope);
  return true;
}

function publishStructurePaintworkSetAllInSolarSystemNotice(solarSystemID) {
  const numericSolarSystemID = normalizeProtoNumber(solarSystemID);
  if (!numericSolarSystemID) {
    return false;
  }

  const paintworks = getPaintworksForSolarSystem(numericSolarSystemID).map(
    (license) => ({
      structure: buildStructureIdentifier(license && license.structureID),
      paintwork: buildStructurePaintworkPayload(license && license.paintwork),
    }),
  );
  const noticePayload = Buffer.from(
    StructurePaintworkSetAllInSolarSystemNotice.encode(
      StructurePaintworkSetAllInSolarSystemNotice.create({
        paintworks,
        solar_system: buildSolarSystemIdentifier(numericSolarSystemID),
      }),
    ).finish(),
  );
  const noticeEnvelope = encodeNoticeEnvelope(
    "eve_public.cosmetic.structure.paintwork.api.SetAllInSolarSystemNotice",
    noticePayload,
    {
      solar_system: numericSolarSystemID,
    },
  );

  log.info(
    `[PublicGatewayLocal] Notices.Publish eve_public.cosmetic.structure.paintwork.api.SetAllInSolarSystemNotice ` +
      `solarSystemID=${numericSolarSystemID} paintworks=${paintworks.length} streams=${ACTIVE_NOTICE_STREAMS.size}`,
  );
  broadcastNoticeEnvelope(noticeEnvelope);
  return true;
}

function publishShipStateSetNotice(shipID, activeCharacterID = 0) {
  const state = buildShipStateObject(shipID, activeCharacterID);
  if (!state) {
    log.warn(
      `[PublicGatewayLocal] Skipped SetNotice for shipID=${shipID}; state unavailable`,
    );
    return false;
  }

  const fallbackTargetCharacterID =
    normalizeProtoNumber(state.character && state.character.sequential) ||
    normalizeProtoNumber(activeCharacterID);
  const targetCharacterIDs = getObserverCharacterIDsForShip(shipID);
  if (targetCharacterIDs.length === 0 && fallbackTargetCharacterID) {
    targetCharacterIDs.push(fallbackTargetCharacterID);
  }
  if (targetCharacterIDs.length === 0) {
    log.warn(
      `[PublicGatewayLocal] Skipped SetNotice for shipID=${shipID}; target character unavailable`,
    );
    return false;
  }

  const noticePayload = Buffer.from(
    ShipStateSetNotice.encode(
      ShipStateSetNotice.create({
        state,
      }),
    ).finish(),
  );
  for (const targetCharacterID of targetCharacterIDs) {
    const noticeEnvelope = encodeNoticeEnvelope(
      "eve_public.cosmetic.ship.api.SetNotice",
      noticePayload,
      {
        character: targetCharacterID,
      },
    );
    broadcastNoticeEnvelope(noticeEnvelope);
  }

  log.info(
    `[PublicGatewayLocal] Notices.Publish eve_public.cosmetic.ship.api.SetNotice shipID=${normalizeProtoNumber(
      shipID,
    )} skinID=${normalizeProtoNumber(
      state &&
        state.skin &&
        state.skin.firstparty &&
        state.skin.firstparty.identifier
        ? state.skin.firstparty.identifier.sequential
        : 0,
    )} targets=${targetCharacterIDs.join(",") || "none"} streams=${ACTIVE_NOTICE_STREAMS.size}`,
  );
  return true;
}

function publishShipStateSetAllInBubbleNotice(activeCharacterID) {
  const numericCharacterID = normalizeProtoNumber(activeCharacterID);
  if (!numericCharacterID) {
    return false;
  }

  const states = buildBubbleShipStatesForCharacter(numericCharacterID);
  const noticePayload = Buffer.from(
    ShipStateSetAllInBubbleNotice.encode(
      ShipStateSetAllInBubbleNotice.create({
        state: states,
      }),
    ).finish(),
  );
  const noticeEnvelope = encodeNoticeEnvelope(
    "eve_public.cosmetic.ship.api.SetAllInBubbleNotice",
    noticePayload,
    {
      character: numericCharacterID,
    },
  );

  log.info(
    `[PublicGatewayLocal] Notices.Publish eve_public.cosmetic.ship.api.SetAllInBubbleNotice targetCharacterID=${numericCharacterID} states=${states.length} streams=${ACTIVE_NOTICE_STREAMS.size}`,
  );
  broadcastNoticeEnvelope(noticeEnvelope);
  return true;
}

function getEmptySuccessResponseType(requestTypeName) {
  return gatewayServiceRegistry.getEmptySuccessResponseType(requestTypeName);
}

function encodeResponseEnvelope(
  requestEnvelope,
  statusCode,
  statusMessage,
  responseTypeName,
  responsePayloadBuffer,
) {
  const responseEnvelope = ResponseEnvelope.create({
    dispatched: timestampNow(),
    correlation_uuid: bufferFromBytes(requestEnvelope.correlation_uuid),
    status_code: statusCode,
    status_message: statusMessage || "",
    payload:
      responseTypeName !== null
        ? buildAny(responseTypeName, responsePayloadBuffer || EMPTY_PAYLOAD)
        : null,
    internal_origin: PUBLIC_GATEWAY_ORIGIN,
    application_instance_uuid: bufferFromBytes(
      requestEnvelope.application_instance_uuid,
    ),
    gateway_instance_uuid: GATEWAY_INSTANCE_UUID,
  });

  return Buffer.from(ResponseEnvelope.encode(responseEnvelope).finish());
}

function buildRequestContext(requestEnvelope, requestTypeName, frameBuffer) {
  return {
    requestEnvelope,
    requestTypeName,
    activeCharacterID: getActiveCharacterID(requestEnvelope),
    correlation: correlationLabel(requestEnvelope),
    requestBytes: Buffer.byteLength(frameBuffer || EMPTY_PAYLOAD),
  };
}

function logGatewaySummary(context, result) {
  const message =
    `[PublicGatewayLocal] Requests.Send type=${context.requestTypeName || "<unknown>"} ` +
    `status=${result.statusCode} duration_ms=${result.durationMs.toFixed(2)} ` +
    `responseType=${result.responseTypeName || "<none>"} ` +
    `activeCharacterID=${context.activeCharacterID || 0} ` +
    `correlation=${context.correlation}`;

  if (result.statusCode >= 500) {
    log.warn(message + ` error="${result.statusMessage || ""}"`);
    return;
  }

  if (result.statusCode >= 400) {
    log.info(message + ` error="${result.statusMessage || ""}"`);
    return;
  }

  log.info(message);
}

function logUnknownRequest(context) {
  const key = context.requestTypeName || "<unknown>";
  const count = (UNKNOWN_REQUEST_COUNTS.get(key) || 0) + 1;
  UNKNOWN_REQUEST_COUNTS.set(key, count);

  if (!shouldLogUnknownCount(count)) {
    return;
  }

  log.warn(
    `[PublicGatewayLocal] Unknown eve_public request type=${key} ` +
      `count=${count} requestBytes=${context.requestBytes} ` +
      `activeCharacterID=${context.activeCharacterID || 0} ` +
      `correlation=${context.correlation}`,
  );
}

function buildGatewayResponseForRequest(frameBuffer, options = {}) {
  const startedAt = process.hrtime.bigint();
  const requestEnvelope = RequestEnvelope.decode(frameBuffer);
  const invalidIdentity = gatewayRequestHasInvalidIdentity(requestEnvelope, options.stream);
  if (options && options.stream) {
    observeGatewayTransportIdentity(options.stream, requestEnvelope);
  }
  const requestTypeName = normalizeGatewayRequestTypeName(
    extractTypeName(
      requestEnvelope &&
        requestEnvelope.payload &&
        requestEnvelope.payload.type_url
        ? requestEnvelope.payload.type_url
        : "",
    ),
  );
  const context = buildRequestContext(
    requestEnvelope,
    requestTypeName,
    frameBuffer,
  );

  function buildGatewayFailure(error) {
    const emptySuccessResponseType = getEmptySuccessResponseType(requestTypeName);
    if (emptySuccessResponseType) {
      log.warn(
        `[PublicGatewayLocal] Degraded failed gateway request type=${requestTypeName || "<unknown>"} ` +
          `to empty success responseType=${emptySuccessResponseType} ` +
          `correlation=${context.correlation}: ${error.message}`,
      );
      return {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: emptySuccessResponseType,
        responsePayloadBuffer: EMPTY_PAYLOAD,
      };
    }
    log.warn(
      `[PublicGatewayLocal] Gateway service request failed type=${requestTypeName || "<unknown>"} ` +
        `correlation=${context.correlation}: ${error.message}`,
    );
    return {
      statusCode: 500,
      statusMessage: error.message || "local gateway handler failed",
      responseTypeName: null,
      responsePayloadBuffer: null,
    };
  }

  function finalizeGatewayResult(resolvedResult) {
    let finalResult = resolvedResult;
    if (!finalResult) {
      logUnknownRequest(context);
      finalResult = {
        statusCode: 404,
        statusMessage: `EveJS Elysian local gateway has no handler for ${requestTypeName || "unknown request"}`,
        responseTypeName: null,
        responsePayloadBuffer: null,
      };
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1000000;
    const responseBuffer = encodeResponseEnvelope(
      requestEnvelope,
      finalResult.statusCode,
      finalResult.statusMessage,
      finalResult.responseTypeName,
      finalResult.responsePayloadBuffer,
    );
    logGatewaySummary(context, {
      ...finalResult,
      durationMs,
    });
    return responseBuffer;
  }

  if (invalidIdentity) {
    return finalizeGatewayResult({
      statusCode: 401,
      statusMessage: "Gateway identity does not match the authenticated account.",
      responseTypeName: getEmptySuccessResponseType(requestTypeName),
      responsePayloadBuffer: EMPTY_PAYLOAD,
    });
  }

  let result;

  if (requestTypeName === "eve_public.cosmetic.ship.api.GetRequest") {
    const payloadBuffer = buildShipStateResponsePayload(requestEnvelope);
    if (!payloadBuffer) {
      result = {
        statusCode: 404,
        statusMessage: "ship cosmetic state not found",
        responseTypeName: null,
        responsePayloadBuffer: null,
      };
    } else {
      result = {
        statusCode: 200,
        statusMessage: "",
        responseTypeName: "eve_public.cosmetic.ship.api.GetResponse",
        responsePayloadBuffer: payloadBuffer,
      };
    }
  }

  if (!result && requestTypeName === "eve_public.cosmetic.ship.api.GetAllInBubbleRequest") {
    result = {
      statusCode: 200,
      statusMessage: "",
      responseTypeName: "eve_public.cosmetic.ship.api.GetAllInBubbleResponse",
      responsePayloadBuffer: buildShipStatesInBubblePayload(requestEnvelope),
    };
  }

  if (!result && requestTypeName === "eve_public.user.license.api.GetRequest") {
    const licenseResult = buildUserLicenseResponsePayload(requestEnvelope);
    result = {
      statusCode: licenseResult.statusCode || 200,
      statusMessage: "",
      responseTypeName: "eve_public.user.license.api.GetResponse",
      responsePayloadBuffer: licenseResult.payloadBuffer,
    };
    log.info(
      `[PublicGatewayLocal] UserLicense.Get license_type=${licenseResult.licenseType || "<unknown>"} ` +
        `hasLicense=${licenseResult.hasLicense} omegaLicenseEnabled=${omegaLicenseEnabled(context.activeCharacterID)}`,
    );
  }

  if (!result && requestTypeName === "eve_public.plex.vault.api.BalanceRequest") {
    result = {
      statusCode: 200,
      statusMessage: "",
      responseTypeName: "eve_public.plex.vault.api.BalanceResponse",
      responsePayloadBuffer: buildPlexBalanceResponsePayload(requestEnvelope),
    };
  }

  if (!result) {
    try {
      result = gatewayServiceRegistry.handleRequest(
        requestTypeName,
        requestEnvelope,
      );
    } catch (error) {
      result = buildGatewayFailure(error);
    }
  }

  if (result && typeof result.then === "function") {
    return result.then(
      finalizeGatewayResult,
      (error) => finalizeGatewayResult(buildGatewayFailure(error)),
    );
  }
  return finalizeGatewayResult(result);
}

function finalizeGrpcStream(stream) {
  if (stream.destroyed || stream.closed) {
    return;
  }

  stream.end();
}

function initializeGrpcStream(stream) {
  stream.respond(GRPC_RESPONSE_HEADERS, { waitForTrailers: true });
  stream.on("wantTrailers", () => {
    try {
      stream.sendTrailers({ "grpc-status": "0" });
    } catch (error) {
      log.debug(`[PublicGatewayLocal] Failed to send trailers: ${error.message}`);
    }
  });
}

function handleUnaryPing(stream, label) {
  initializeGrpcStream(stream);
  stream.on("data", () => {});
  stream.on("end", () => {
    log.debug(`[PublicGatewayLocal] ${label} ping`);
    stream.write(createGrpcFrame(EMPTY_PAYLOAD));
    finalizeGrpcStream(stream);
  });
  stream.on("error", (error) => {
    log.warn(`[PublicGatewayLocal] ${label} ping error: ${error.message}`);
  });
}

function handleRequestsSendStream(stream) {
  initializeGrpcStream(stream);
  let responseLane = Promise.resolve();
  const parseChunk = createGrpcFrameParser((payload) => {
    responseLane = responseLane
      .then(() => buildGatewayResponseForRequest(payload, { stream }))
      .then((responseBuffer) => {
        if (!stream.destroyed && !stream.closed) {
          stream.write(createGrpcFrame(responseBuffer));
        }
      })
      .catch((error) => {
        log.warn(`[PublicGatewayLocal] Requests.Send response failed: ${error.message}`);
      });
  });

  stream.on("data", parseChunk);
  stream.on("end", () => {
    void responseLane.finally(() => finalizeGrpcStream(stream));
  });
  stream.on("error", (error) => {
    log.warn(`[PublicGatewayLocal] Requests.Send error: ${error.message}`);
  });
}

function handleNoticesConsumeStream(stream) {
  initializeGrpcStream(stream);
  getNoticeStreamState(stream);
  log.info(
    `[PublicGatewayLocal] Notices.Consume connected active=${ACTIVE_NOTICE_STREAMS.size}`,
  );

  const parseChunk = createGrpcFrameParser((payload) => {
    try {
      const requestEnvelope = RequestEnvelope.decode(payload);
      updateNoticeStreamState(stream, requestEnvelope);
    } catch (error) {
      log.debug(
        `[PublicGatewayLocal] Notices.Consume ignored undecodable payload: ${error.message}`,
      );
    }
  });
  stream.on("data", parseChunk);
  stream.on("end", () => {
    log.debug(
      "[PublicGatewayLocal] Notices.Consume request completed; keeping stream open",
    );
  });
  stream.on("close", () => {
    removeNoticeStream(stream);
  });
  stream.on("error", (error) => {
    log.warn(`[PublicGatewayLocal] Notices.Consume error: ${error.message}`);
    removeNoticeStream(stream);
  });
}

function handleEventsPublishStream(stream) {
  initializeGrpcStream(stream);
  const parseChunk = createGrpcFrameParser(() => {
    stream.write(createGrpcFrame(EMPTY_PAYLOAD));
  });

  stream.on("data", parseChunk);
  stream.on("end", () => finalizeGrpcStream(stream));
  stream.on("error", (error) => {
    log.warn(`[PublicGatewayLocal] Events.Publish error: ${error.message}`);
  });
}

function handleGatewayStream(stream, headers) {
  const routePath = String(headers[":path"] || "");

  if (routePath === "/eve_public.gateway.Requests/Ping") {
    handleUnaryPing(stream, "Requests");
    return true;
  }

  if (routePath === "/eve_public.gateway.Notices/Ping") {
    handleUnaryPing(stream, "Notices");
    return true;
  }

  if (routePath === "/eve_public.gateway.Events/Ping") {
    handleUnaryPing(stream, "Events");
    return true;
  }

  if (routePath === "/eve_public.gateway.Requests/Send") {
    handleRequestsSendStream(stream);
    return true;
  }

  if (routePath === "/eve_public.gateway.Notices/Consume") {
    handleNoticesConsumeStream(stream);
    return true;
  }

  if (routePath === "/eve_public.gateway.Events/Publish") {
    handleEventsPublishStream(stream);
    return true;
  }

  return false;
}

module.exports = {
  buildGatewayResponseForRequest,
  createGrpcFrame,
  handleGatewayStream,
  publishGatewayNotice,
  publishPlexBalanceChangedNotice,
  publishShipStateSetAllInBubbleNotice,
  publishShipStateSetNotice,
  publishStructurePaintworkSetAllInSolarSystemNotice,
  publishStructurePaintworkSetNotice,
};
module.exports._testing = {
  buildBubbleShipStatesForCharacter,
  findLiveSessionByCharacterID,
  gatewayServiceRegistry,
  getObserverCharacterIDsForShip,
  getEmptySuccessResponseType,
  normalizeGatewayRequestTypeName,
  PROTO_ROOT,
  RequestEnvelope,
  ResponseEnvelope,
  resetGatewayState() {
    ACTIVE_NOTICE_STREAMS.clear();
    GATEWAY_TRANSPORT_IDENTITIES = new WeakMap();
    UNKNOWN_REQUEST_COUNTS.clear();
  },
};

// Services publish notices through this, without requiring the gateway. They read the publish
// functions off these exports at call time, as a require of this module did.
require(path.join(__dirname, "./publicGatewayNotices")).setPublicGateway(module.exports);
