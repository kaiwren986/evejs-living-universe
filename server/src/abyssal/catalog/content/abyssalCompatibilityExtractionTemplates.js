"use strict";

// Compatibility-only recipes. Evaluation order and contents are unchanged.
function buildNone(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:none",
    displayName: "No Extraction Nodes",
    extractionNodeDisplayName: "Abyssal Extraction Node (Disabled)",
    spawnCount: 0,
    placeholderNotes: [
      "Tier 1 placeholder runs do not spawn live extraction nodes in this pass.",
    ],
  });
}

function buildCalmDarkSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:calm-dark-side-node",
    lootTableID: "abyssal:loot:calm-extraction-node",
    enabled: true,
    displayName: "Calm Dark Side Loot Node",
    eligibleRoomIndexes: [1, 2, 3],
    eligibleTiers: [1],
    spawnCount: 1,
    structureTypeIDs: [49661, 49662],
    lootEmptyChance: 0.45,
    wholeNodeEmptyRoll: true,
    spawnOffsetMeters: 2_800,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Calm extraction nodes use a conservative, locally resolved side-loot pool.",
    ],
  });
}

function buildCalmElectricalSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:calm-electrical-side-node",
    lootTableID: "abyssal:loot:calm-extraction-node",
    enabled: true,
    displayName: "Calm Electrical Side Loot Node",
    eligibleRoomIndexes: [1, 2, 3],
    eligibleTiers: [1],
    spawnCount: 1,
    structureTypeIDs: [49661, 49662],
    lootEmptyChance: 0.45,
    wholeNodeEmptyRoll: true,
    spawnOffsetMeters: 2_800,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Calm extraction nodes use a conservative, locally resolved side-loot pool.",
    ],
  });
}

function buildCalmExoticSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:calm-exotic-side-node",
    lootTableID: "abyssal:loot:calm-extraction-node",
    enabled: true,
    displayName: "Calm Exotic Side Loot Node",
    eligibleRoomIndexes: [1, 2, 3],
    eligibleTiers: [1],
    spawnCount: 1,
    structureTypeIDs: [49661, 49662],
    lootEmptyChance: 0.45,
    wholeNodeEmptyRoll: true,
    spawnOffsetMeters: 2_800,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Calm extraction nodes use a conservative, locally resolved side-loot pool.",
    ],
  });
}

function buildCalmFirestormSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:calm-firestorm-side-node",
    lootTableID: "abyssal:loot:calm-extraction-node",
    enabled: true,
    displayName: "Calm Firestorm Side Loot Node",
    eligibleRoomIndexes: [1, 2, 3],
    eligibleTiers: [1],
    spawnCount: 1,
    structureTypeIDs: [49661, 49662],
    lootEmptyChance: 0.45,
    wholeNodeEmptyRoll: true,
    spawnOffsetMeters: 2_800,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Calm extraction nodes use a conservative, locally resolved side-loot pool.",
    ],
  });
}

function buildCalmGammaSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:calm-gamma-side-node",
    lootTableID: "abyssal:loot:calm-extraction-node",
    enabled: true,
    displayName: "Calm Gamma Side Loot Node",
    eligibleRoomIndexes: [1, 2, 3],
    eligibleTiers: [1],
    spawnCount: 1,
    structureTypeIDs: [49661, 49662],
    lootEmptyChance: 0.45,
    wholeNodeEmptyRoll: true,
    spawnOffsetMeters: 2_800,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Calm extraction nodes use a conservative, locally resolved side-loot pool.",
    ],
  });
}

function buildAgitatedDarkSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:agitated-dark-side-node",
    enabled: true,
    displayName: "Agitated Dark Side Loot Node",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [2],
    spawnCount: 1,
    spawnOffsetMeters: 3_200,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Agitated side loot uses the Calm item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedElectricalSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:agitated-electrical-side-node",
    enabled: true,
    displayName: "Agitated Electrical Side Loot Node",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [2],
    spawnCount: 1,
    spawnOffsetMeters: 3_200,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Agitated side loot uses the Calm item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedExoticSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:agitated-exotic-side-node",
    enabled: true,
    displayName: "Agitated Exotic Side Loot Node",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [2],
    spawnCount: 1,
    spawnOffsetMeters: 3_200,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Agitated side loot uses the Calm item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedFirestormSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:agitated-firestorm-side-node",
    enabled: true,
    displayName: "Agitated Firestorm Side Loot Node",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [2],
    spawnCount: 1,
    spawnOffsetMeters: 3_200,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Agitated side loot uses the Calm item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildAgitatedGammaSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:agitated-gamma-side-node",
    enabled: true,
    displayName: "Agitated Gamma Side Loot Node",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [2],
    spawnCount: 1,
    spawnOffsetMeters: 3_200,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Agitated side loot uses the Calm item composition with Tier 2 runtime scaling.",
    ],
  });
}

function buildFierceDarkSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:fierce-dark-side-node",
    enabled: true,
    displayName: "Fierce Dark Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [3],
    spawnCount: 1,
    spawnOffsetMeters: 3_300,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildFierceElectricalSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:fierce-electrical-side-node",
    enabled: true,
    displayName: "Fierce Electrical Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [3],
    spawnCount: 1,
    spawnOffsetMeters: 3_300,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildFierceExoticSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:fierce-exotic-side-node",
    enabled: true,
    displayName: "Fierce Exotic Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [3],
    spawnCount: 1,
    spawnOffsetMeters: 3_300,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildFierceFirestormSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:fierce-firestorm-side-node",
    enabled: true,
    displayName: "Fierce Firestorm Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [3],
    spawnCount: 1,
    spawnOffsetMeters: 3_300,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildFierceGammaSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:fierce-gamma-side-node",
    enabled: true,
    displayName: "Fierce Gamma Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [3],
    spawnCount: 1,
    spawnOffsetMeters: 3_300,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildRagingDarkSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:raging-dark-side-node",
    enabled: true,
    displayName: "Raging Dark Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [4],
    spawnCount: 1,
    spawnOffsetMeters: 3_500,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildRagingElectricalSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:raging-electrical-side-node",
    enabled: true,
    displayName: "Raging Electrical Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [4],
    spawnCount: 1,
    spawnOffsetMeters: 3_500,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildRagingExoticSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:raging-exotic-side-node",
    enabled: true,
    displayName: "Raging Exotic Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [4],
    spawnCount: 1,
    spawnOffsetMeters: 3_500,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildRagingFirestormSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:raging-firestorm-side-node",
    enabled: true,
    displayName: "Raging Firestorm Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [4],
    spawnCount: 1,
    spawnOffsetMeters: 3_500,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildRagingGammaSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:raging-gamma-side-node",
    enabled: true,
    displayName: "Raging Gamma Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [4],
    spawnCount: 1,
    spawnOffsetMeters: 3_500,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildChaoticDarkSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:chaotic-dark-side-node",
    enabled: true,
    displayName: "Chaotic Dark Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [5],
    spawnCount: 1,
    spawnOffsetMeters: 3_400,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildChaoticElectricalSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:chaotic-electrical-side-node",
    enabled: true,
    displayName: "Chaotic Electrical Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [5],
    spawnCount: 1,
    spawnOffsetMeters: 3_400,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildChaoticExoticSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:chaotic-exotic-side-node",
    enabled: true,
    displayName: "Chaotic Exotic Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [5],
    spawnCount: 1,
    spawnOffsetMeters: 3_400,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildChaoticFirestormSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:chaotic-firestorm-side-node",
    enabled: true,
    displayName: "Chaotic Firestorm Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [5],
    spawnCount: 1,
    spawnOffsetMeters: 3_400,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildChaoticGammaSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:chaotic-gamma-side-node",
    enabled: true,
    displayName: "Chaotic Gamma Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [5],
    spawnCount: 1,
    spawnOffsetMeters: 3_400,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; not required for room completion.",
    ],
  });
}

function buildCataclysmicFirestormSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:cataclysmic-firestorm-side-node",
    enabled: true,
    displayName: "Cataclysmic Firestorm Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [6],
    spawnCount: 1,
    spawnOffsetMeters: 3_600,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; kept conservative for the placeholder pass.",
    ],
  });
}

function buildCataclysmicDarkSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:cataclysmic-dark-side-node",
    enabled: true,
    displayName: "Cataclysmic Dark Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [6],
    spawnCount: 1,
    spawnOffsetMeters: 3_600,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; kept conservative for the placeholder pass.",
    ],
  });
}

function buildCataclysmicElectricalSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:cataclysmic-electrical-side-node",
    enabled: true,
    displayName: "Cataclysmic Electrical Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [6],
    spawnCount: 1,
    spawnOffsetMeters: 3_600,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; kept conservative for the placeholder pass.",
    ],
  });
}

function buildCataclysmicExoticSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:cataclysmic-exotic-side-node",
    enabled: true,
    displayName: "Cataclysmic Exotic Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [6],
    spawnCount: 1,
    spawnOffsetMeters: 3_600,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; kept conservative for the placeholder pass.",
    ],
  });
}

function buildCataclysmicGammaSideNode(ports) {
  return (0, ports.buildPlaceholderExtractionNodeProfile)({
    extractionNodeProfileID: "abyssal:extraction:cataclysmic-gamma-side-node",
    enabled: true,
    displayName: "Cataclysmic Gamma Side Loot Node (Placeholder)",
    eligibleRoomIndexes: [2, 3],
    eligibleTiers: [6],
    spawnCount: 1,
    spawnOffsetMeters: 3_600,
    guaranteedLootEntries: [
      { itemName: "Triglavian Survey Database", quantity: 1 },
      { itemName: "Zero-Point Condensate", quantity: 1 },
      { itemName: "Crystalline Isogen-10", quantity: 1 },
    ],
    placeholderNotes: [
      "Optional side loot only; kept conservative for the placeholder pass.",
    ],
  });
}

function createAbyssalCompatibilityExtractionTemplates(ports) {
  return {
    "abyssal:extraction:none": buildNone(ports),
    "abyssal:extraction:calm-dark-side-node": buildCalmDarkSideNode(ports),
    "abyssal:extraction:calm-electrical-side-node": buildCalmElectricalSideNode(ports),
    "abyssal:extraction:calm-exotic-side-node": buildCalmExoticSideNode(ports),
    "abyssal:extraction:calm-firestorm-side-node": buildCalmFirestormSideNode(ports),
    "abyssal:extraction:calm-gamma-side-node": buildCalmGammaSideNode(ports),
    "abyssal:extraction:agitated-dark-side-node": buildAgitatedDarkSideNode(ports),
    "abyssal:extraction:agitated-electrical-side-node": buildAgitatedElectricalSideNode(ports),
    "abyssal:extraction:agitated-exotic-side-node": buildAgitatedExoticSideNode(ports),
    "abyssal:extraction:agitated-firestorm-side-node": buildAgitatedFirestormSideNode(ports),
    "abyssal:extraction:agitated-gamma-side-node": buildAgitatedGammaSideNode(ports),
    "abyssal:extraction:fierce-dark-side-node": buildFierceDarkSideNode(ports),
    "abyssal:extraction:fierce-electrical-side-node": buildFierceElectricalSideNode(ports),
    "abyssal:extraction:fierce-exotic-side-node": buildFierceExoticSideNode(ports),
    "abyssal:extraction:fierce-firestorm-side-node": buildFierceFirestormSideNode(ports),
    "abyssal:extraction:fierce-gamma-side-node": buildFierceGammaSideNode(ports),
    "abyssal:extraction:raging-dark-side-node": buildRagingDarkSideNode(ports),
    "abyssal:extraction:raging-electrical-side-node": buildRagingElectricalSideNode(ports),
    "abyssal:extraction:raging-exotic-side-node": buildRagingExoticSideNode(ports),
    "abyssal:extraction:raging-firestorm-side-node": buildRagingFirestormSideNode(ports),
    "abyssal:extraction:raging-gamma-side-node": buildRagingGammaSideNode(ports),
    "abyssal:extraction:chaotic-dark-side-node": buildChaoticDarkSideNode(ports),
    "abyssal:extraction:chaotic-electrical-side-node": buildChaoticElectricalSideNode(ports),
    "abyssal:extraction:chaotic-exotic-side-node": buildChaoticExoticSideNode(ports),
    "abyssal:extraction:chaotic-firestorm-side-node": buildChaoticFirestormSideNode(ports),
    "abyssal:extraction:chaotic-gamma-side-node": buildChaoticGammaSideNode(ports),
    "abyssal:extraction:cataclysmic-firestorm-side-node": buildCataclysmicFirestormSideNode(ports),
    "abyssal:extraction:cataclysmic-dark-side-node": buildCataclysmicDarkSideNode(ports),
    "abyssal:extraction:cataclysmic-electrical-side-node": buildCataclysmicElectricalSideNode(ports),
    "abyssal:extraction:cataclysmic-exotic-side-node": buildCataclysmicExoticSideNode(ports),
    "abyssal:extraction:cataclysmic-gamma-side-node": buildCataclysmicGammaSideNode(ports),
  };
}

module.exports = { createAbyssalCompatibilityExtractionTemplates };
