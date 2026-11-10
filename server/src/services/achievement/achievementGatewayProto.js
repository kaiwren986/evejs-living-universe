"use strict";

const protobuf = require("protobufjs");

let protoRoot = null;

function buildProtoRoot() {
  return protobuf.Root.fromJSON({
    nested: {
      google: {
        nested: {
          protobuf: {
            nested: {
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
          semanticversion: {
            nested: {
              Specification: {
                fields: {
                  major: { type: "uint32", id: 1 },
                  minor: { type: "uint32", id: 2 },
                  patch: { type: "uint32", id: 3 },
                  prerelease_tags: { rule: "repeated", type: "string", id: 4 },
                  build_tags: { rule: "repeated", type: "string", id: 5 },
                },
              },
            },
          },
          cdn: {
            nested: {
              Checksum: {
                fields: {
                  crc: { type: "uint32", id: 1 },
                },
              },
              Checkpoint: {
                fields: {
                  url: { type: "string", id: 1 },
                  version: {
                    type: "eve_public.semanticversion.Specification",
                    id: 2,
                  },
                  crc: {
                    type: "eve_public.cdn.Checksum",
                    id: 3,
                  },
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
            },
          },
          inventory: {
            nested: {
              genericitemtype: {
                nested: {
                  Identifier: {
                    fields: {
                      sequential: { type: "uint32", id: 1 },
                    },
                  },
                },
              },
            },
          },
          achievement: {
            nested: {
              contribution: {
                nested: {
                  ChecklistProgress: {
                    fields: {
                      values: {
                        rule: "repeated",
                        type: "eve_public.achievement.contribution.ChecklistProgress.ValueEntry",
                        id: 1,
                      },
                    },
                    nested: {
                      ValueEntry: {
                        fields: {
                          value_type: { type: "string", id: 1 },
                          values: { rule: "repeated", type: "string", id: 2 },
                        },
                      },
                    },
                  },
                },
              },
              definition: {
                nested: {
                  Identifier: {
                    fields: {
                      uuid: { type: "bytes", id: 1 },
                    },
                  },
                  api: {
                    nested: {
                      cdn: {
                        nested: {
                          GetLatestRequest: {
                            fields: {},
                          },
                          GetLatestResponse: {
                            fields: {
                              checkpoint: {
                                type: "eve_public.cdn.Checkpoint",
                                id: 1,
                              },
                            },
                          },
                          requests_pb2: {
                            nested: {
                              GetLatestRequest: {
                                fields: {},
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  version: {
                    nested: {
                      api: {
                        nested: {
                          CheckVersionNotice: {
                            fields: {
                              version: {
                                type: "eve_public.semanticversion.Specification",
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
              milestone: {
                nested: {
                  definition: {
                    nested: {
                      Identifier: {
                        fields: {
                          uuid: { type: "bytes", id: 1 },
                        },
                      },
                    },
                  },
                  api: {
                    nested: {
                      ReachedNotice: {
                        fields: {
                          achievement: {
                            type: "eve_public.achievement.definition.Identifier",
                            id: 1,
                          },
                          milestone: {
                            type: "eve_public.achievement.milestone.definition.Identifier",
                            id: 2,
                          },
                        },
                      },
                    },
                  },
                },
              },
              reward: {
                nested: {
                  definition: {
                    nested: {
                      Identifier: {
                        fields: {
                          uuid: { type: "bytes", id: 1 },
                        },
                      },
                    },
                  },
                  api: {
                    nested: {
                      GetUnclaimedRequest: {
                        fields: {
                          page: { type: "eve_public.Page", id: 1 },
                        },
                      },
                      GetUnclaimedResponse: {
                        fields: {
                          rewards: {
                            rule: "repeated",
                            type: "eve_public.achievement.reward.api.GetUnclaimedResponse.Reward",
                            id: 1,
                          },
                          next_page: { type: "eve_public.NextPage", id: 2 },
                        },
                        nested: {
                          Reward: {
                            oneofs: {
                              source: {
                                oneof: ["achievement_source", "category_source"],
                              },
                            },
                            fields: {
                              achievement_source: {
                                type: "eve_public.achievement.reward.api.GetUnclaimedResponse.Reward.AchievementSource",
                                id: 1,
                              },
                              category_source: {
                                type: "eve_public.achievement.reward.api.GetUnclaimedResponse.Reward.CategorySource",
                                id: 2,
                              },
                              unclaimed_rewards: {
                                rule: "repeated",
                                type: "eve_public.achievement.reward.definition.Identifier",
                                id: 3,
                              },
                            },
                            nested: {
                              AchievementSource: {
                                fields: {
                                  achievement: {
                                    type: "eve_public.achievement.definition.Identifier",
                                    id: 1,
                                  },
                                  milestone: {
                                    type: "eve_public.achievement.milestone.definition.Identifier",
                                    id: 2,
                                  },
                                },
                              },
                              CategorySource: {
                                fields: {
                                  category: {
                                    type: "eve_public.achievement.category.definition.Identifier",
                                    id: 1,
                                  },
                                  milestone: {
                                    type: "eve_public.achievement.category.milestone.definition.Identifier",
                                    id: 2,
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                      ClaimRequest: {
                        oneofs: {
                          source: {
                            oneof: ["achievement_source", "category_source"],
                          },
                        },
                        fields: {
                          achievement_source: {
                            type: "eve_public.achievement.reward.api.ClaimRequest.AchievementSource",
                            id: 1,
                          },
                          category_source: {
                            type: "eve_public.achievement.reward.api.ClaimRequest.CategorySource",
                            id: 2,
                          },
                        },
                        nested: {
                          AchievementSource: {
                            fields: {
                              achievement: {
                                type: "eve_public.achievement.definition.Identifier",
                                id: 1,
                              },
                              milestone: {
                                type: "eve_public.achievement.milestone.definition.Identifier",
                                id: 2,
                              },
                            },
                          },
                          CategorySource: {
                            fields: {
                              category: {
                                type: "eve_public.achievement.category.definition.Identifier",
                                id: 1,
                              },
                              milestone: {
                                type: "eve_public.achievement.category.milestone.definition.Identifier",
                                id: 2,
                              },
                            },
                          },
                        },
                      },
                      ClaimResponse: {
                        fields: {},
                      },
                      requests_pb2: {
                        nested: {
                          GetUnclaimedRequest: {
                            fields: {
                              page: { type: "eve_public.Page", id: 1 },
                            },
                          },
                          ClaimRequest: {
                            oneofs: {
                              source: {
                                oneof: ["achievement_source", "category_source"],
                              },
                            },
                            fields: {
                              achievement_source: {
                                type: "eve_public.achievement.reward.api.ClaimRequest.AchievementSource",
                                id: 1,
                              },
                              category_source: {
                                type: "eve_public.achievement.reward.api.ClaimRequest.CategorySource",
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
              api: {
                nested: {
                  GetRequest: {
                    fields: {
                      achievement: {
                        type: "eve_public.achievement.definition.Identifier",
                        id: 1,
                      },
                    },
                  },
                  GetResponse: {
                    oneofs: {
                      completion: {
                        oneof: ["completed_date", "not_completed"],
                      },
                      progress: {
                        oneof: ["progress_value", "checklist"],
                      },
                    },
                    fields: {
                      completed_date: {
                        type: "google.protobuf.Timestamp",
                        id: 1,
                      },
                      not_completed: { type: "bool", id: 2 },
                      progress_value: { type: "uint64", id: 3 },
                      checklist: {
                        type: "eve_public.achievement.contribution.ChecklistProgress",
                        id: 4,
                      },
                      reached_milestones: {
                        rule: "repeated",
                        type: "eve_public.achievement.api.GetResponse.ReachedMilestone",
                        id: 5,
                      },
                    },
                    nested: {
                      ReachedMilestone: {
                        fields: {
                          milestone: {
                            type: "eve_public.achievement.milestone.definition.Identifier",
                            id: 1,
                          },
                          reached_date: {
                            type: "google.protobuf.Timestamp",
                            id: 2,
                          },
                          category_points_awarded: { type: "uint32", id: 3 },
                        },
                      },
                    },
                  },
                  ProgressedNotice: {
                    oneofs: {
                      progress: {
                        oneof: ["value", "items"],
                      },
                    },
                    fields: {
                      achievement: {
                        type: "eve_public.achievement.definition.Identifier",
                        id: 1,
                      },
                      value: { type: "uint64", id: 2 },
                      items: {
                        type: "eve_public.achievement.contribution.ChecklistProgress",
                        id: 3,
                      },
                    },
                  },
                  CompletedNotice: {
                    fields: {
                      achievement: {
                        type: "eve_public.achievement.definition.Identifier",
                        id: 1,
                      },
                    },
                  },
                  admin: {
                    nested: {
                      ResetAllRequest: {
                        fields: {},
                      },
                      ResetAllResponse: {
                        fields: {},
                      },
                      AddProgressRequest: {
                        oneofs: {
                          progress: {
                            oneof: ["progress_delta", "checklist", "unique_item_count"],
                          },
                        },
                        fields: {
                          achievement: {
                            type: "eve_public.achievement.definition.Identifier",
                            id: 1,
                          },
                          progress_delta: { type: "uint64", id: 2 },
                          checklist: {
                            type: "eve_public.achievement.contribution.ChecklistProgress",
                            id: 3,
                          },
                          unique_item_count: { type: "uint64", id: 4 },
                        },
                      },
                      AddProgressResponse: {
                        fields: {},
                      },
                      CompleteRequest: {
                        fields: {
                          achievement: {
                            type: "eve_public.achievement.definition.Identifier",
                            id: 1,
                          },
                        },
                      },
                      CompleteResponse: {
                        fields: {},
                      },
                      ResetRequest: {
                        fields: {
                          achievement: {
                            type: "eve_public.achievement.definition.Identifier",
                            id: 1,
                          },
                        },
                      },
                      ResetResponse: {
                        fields: {},
                      },
                      requests_pb2: {
                        nested: {
                          ResetAllRequest: { fields: {} },
                          AddProgressRequest: {
                            oneofs: {
                              progress: {
                                oneof: ["progress_delta", "checklist", "unique_item_count"],
                              },
                            },
                            fields: {
                              achievement: {
                                type: "eve_public.achievement.definition.Identifier",
                                id: 1,
                              },
                              progress_delta: { type: "uint64", id: 2 },
                              checklist: {
                                type: "eve_public.achievement.contribution.ChecklistProgress",
                                id: 3,
                              },
                              unique_item_count: { type: "uint64", id: 4 },
                            },
                          },
                          CompleteRequest: {
                            fields: {
                              achievement: {
                                type: "eve_public.achievement.definition.Identifier",
                                id: 1,
                              },
                            },
                          },
                          ResetRequest: {
                            fields: {
                              achievement: {
                                type: "eve_public.achievement.definition.Identifier",
                                id: 1,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  requests_pb2: {
                    nested: {
                      GetRequest: {
                        fields: {
                          achievement: {
                            type: "eve_public.achievement.definition.Identifier",
                            id: 1,
                          },
                        },
                      },
                    },
                  },
                },
              },
              category: {
                nested: {
                  definition: {
                    nested: {
                      Identifier: {
                        fields: {
                          uuid: { type: "bytes", id: 1 },
                        },
                      },
                    },
                  },
                  milestone: {
                    nested: {
                      definition: {
                        nested: {
                          Identifier: {
                            fields: {
                              uuid: { type: "bytes", id: 1 },
                            },
                          },
                        },
                      },
                      api: {
                        nested: {
                          ReachedNotice: {
                            fields: {
                              category: {
                                type: "eve_public.achievement.category.definition.Identifier",
                                id: 1,
                              },
                              milestone: {
                                type: "eve_public.achievement.category.milestone.definition.Identifier",
                                id: 2,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  api: {
                    nested: {
                      GetRequest: {
                        fields: {
                          category: {
                            type: "eve_public.achievement.category.definition.Identifier",
                            id: 1,
                          },
                        },
                      },
                      GetResponse: {
                        fields: {
                          score: { type: "uint32", id: 1 },
                          reached_milestones: {
                            rule: "repeated",
                            type: "eve_public.achievement.category.api.GetResponse.ReachedMilestone",
                            id: 2,
                          },
                        },
                        nested: {
                          ReachedMilestone: {
                            fields: {
                              milestone: {
                                type: "eve_public.achievement.category.milestone.definition.Identifier",
                                id: 1,
                              },
                              reached_date: {
                                type: "google.protobuf.Timestamp",
                                id: 2,
                              },
                            },
                          },
                        },
                      },
                      ProgressedNotice: {
                        fields: {
                          category: {
                            type: "eve_public.achievement.category.definition.Identifier",
                            id: 1,
                          },
                          score: { type: "uint32", id: 2 },
                        },
                      },
                      requests_pb2: {
                        nested: {
                          GetRequest: {
                            fields: {
                              category: {
                                type: "eve_public.achievement.category.definition.Identifier",
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
              showcase: {
                nested: {
                  api: {
                    nested: {
                      GetCharacterScoreRequest: {
                        fields: {
                          character: {
                            type: "eve_public.character.Identifier",
                            id: 1,
                          },
                        },
                      },
                      GetCharacterScoreResponse: {
                        fields: {
                          score: { type: "uint32", id: 1 },
                        },
                      },
                      requests_pb2: {
                        nested: {
                          GetCharacterScoreRequest: {
                            fields: {
                              character: {
                                type: "eve_public.character.Identifier",
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
            },
          },
          cosmetic: {
            nested: {
              character: {
                nested: {
                  title: {
                    nested: {
                      definition: {
                        nested: {
                          Identifier: {
                            fields: {
                              uuid: { type: "bytes", id: 1 },
                            },
                          },
                          api: {
                            nested: {
                              GetLatestRequest: {
                                fields: {},
                              },
                              GetLatestResponse: {
                                fields: {
                                  checkpoint: {
                                    type: "eve_public.cdn.Checkpoint",
                                    id: 1,
                                  },
                                },
                              },
                              requests_pb2: {
                                nested: {
                                  GetLatestRequest: {
                                    fields: {},
                                  },
                                },
                              },
                            },
                          },
                          version: {
                            nested: {
                              api: {
                                nested: {
                                  CheckVersionNotice: {
                                    fields: {
                                      version: {
                                        type: "eve_public.semanticversion.Specification",
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
                      api: {
                        nested: {
                          GetOwnedRequest: {
                            fields: {
                              page: { type: "eve_public.Page", id: 1 },
                            },
                          },
                          GetOwnedResponse: {
                            fields: {
                              titles: {
                                rule: "repeated",
                                type: "eve_public.cosmetic.character.title.definition.Identifier",
                                id: 1,
                              },
                              next_page: { type: "eve_public.NextPage", id: 2 },
                            },
                          },
                          GetEquippedForCharacterRequest: {
                            fields: {
                              character: {
                                type: "eve_public.character.Identifier",
                                id: 1,
                              },
                            },
                          },
                          GetEquippedForCharacterResponse: {
                            oneofs: {
                              equipped: {
                                oneof: ["title", "no_title"],
                              },
                            },
                            fields: {
                              title: {
                                type: "eve_public.cosmetic.character.title.definition.Identifier",
                                id: 1,
                              },
                              no_title: { type: "bool", id: 2 },
                            },
                          },
                          EquipRequest: {
                            fields: {
                              title: {
                                type: "eve_public.cosmetic.character.title.definition.Identifier",
                                id: 1,
                              },
                            },
                          },
                          EquipResponse: {
                            fields: {},
                          },
                          UnequipRequest: {
                            fields: {},
                          },
                          UnequipResponse: {
                            fields: {},
                          },
                          GrantedNotice: {
                            fields: {
                              title: {
                                type: "eve_public.cosmetic.character.title.definition.Identifier",
                                id: 1,
                              },
                            },
                          },
                          RevokedNotice: {
                            fields: {
                              title: {
                                type: "eve_public.cosmetic.character.title.definition.Identifier",
                                id: 1,
                              },
                            },
                          },
                          SetNotice: {
                            oneofs: {
                              equipped: {
                                oneof: ["title", "no_title"],
                              },
                            },
                            fields: {
                              character: {
                                type: "eve_public.character.Identifier",
                                id: 1,
                              },
                              title: {
                                type: "eve_public.cosmetic.character.title.definition.Identifier",
                                id: 2,
                              },
                              no_title: { type: "bool", id: 3 },
                            },
                          },
                          SetAllInBubbleNotice: {
                            fields: {
                              titles: {
                                rule: "repeated",
                                type: "eve_public.cosmetic.character.title.api.SetAllInBubbleNotice.CharacterTitle",
                                id: 1,
                              },
                            },
                            nested: {
                              CharacterTitle: {
                                oneofs: {
                                  equipped: {
                                    oneof: ["title", "no_title"],
                                  },
                                },
                                fields: {
                                  character: {
                                    type: "eve_public.character.Identifier",
                                    id: 1,
                                  },
                                  title: {
                                    type: "eve_public.cosmetic.character.title.definition.Identifier",
                                    id: 2,
                                  },
                                  no_title: { type: "bool", id: 3 },
                                },
                              },
                            },
                          },
                          admin: {
                            nested: {
                              GrantRequest: {
                                fields: {
                                  id: {
                                    type: "eve_public.cosmetic.character.title.definition.Identifier",
                                    id: 1,
                                  },
                                },
                              },
                              GrantResponse: { fields: {} },
                              RevokeRequest: {
                                fields: {
                                  id: {
                                    type: "eve_public.cosmetic.character.title.definition.Identifier",
                                    id: 1,
                                  },
                                },
                              },
                              RevokeResponse: { fields: {} },
                              requests_pb2: {
                                nested: {
                                  GrantRequest: {
                                    fields: {
                                      id: {
                                        type: "eve_public.cosmetic.character.title.definition.Identifier",
                                        id: 1,
                                      },
                                    },
                                  },
                                  RevokeRequest: {
                                    fields: {
                                      id: {
                                        type: "eve_public.cosmetic.character.title.definition.Identifier",
                                        id: 1,
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                          requests_pb2: {
                            nested: {
                              GetOwnedRequest: {
                                fields: {
                                  page: { type: "eve_public.Page", id: 1 },
                                },
                              },
                              GetEquippedForCharacterRequest: {
                                fields: {
                                  character: {
                                    type: "eve_public.character.Identifier",
                                    id: 1,
                                  },
                                },
                              },
                              EquipRequest: {
                                fields: {
                                  title: {
                                    type: "eve_public.cosmetic.character.title.definition.Identifier",
                                    id: 1,
                                  },
                                },
                              },
                              UnequipRequest: {
                                fields: {},
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
      },
    },
  });
}

function getAchievementGatewayProtoRoot() {
  if (!protoRoot) {
    protoRoot = buildProtoRoot();
  }
  return protoRoot;
}

module.exports = {
  getAchievementGatewayProtoRoot,
};
