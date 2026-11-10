"use strict";

const {
  toInt,
} = require("../../../common/numbers");

// Positive regional catalog for k-space gas. Mykoserocin source lists are
// explicitly incomplete: unlisted ordinary regions defer to existing band rules.
// Retain the documented Cytoserocin region/constellation restrictions. Pochven's
// blanket gas exclusion is a project-owner provisional policy, not a measured
// retail rule or the complement of an incomplete community list.

const path = require("path");

const worldData = require(path.join(__dirname, "../../../space/worldData"));

const SOURCE_REFS = Object.freeze({
  ownerProvisionalPochvenGas: Object.freeze({
    title: "Project owner provisional policy: no gas sites in Pochven",
    url: null,
    evidenceClass: "owner_provisional",
    adoptedAt: "2026-11-01",
  }),
  eveUniWildNebula: Object.freeze({
    title: "EVE University: Wild Nebula (additional documented positive locations)",
    url: "https://wiki.eveuniversity.org/Wild_Nebula",
  }),
  eveUniGasCloudHarvesting: Object.freeze({
    title: "EVE University: Gas cloud harvesting (k-space gas sites and their regions)",
    url: "https://wiki.eveuniversity.org/Gas_cloud_harvesting",
  }),
  sistersProbeNebulae: Object.freeze({
    title: "EVE Sister Core Scanner Probe wiki: Small Nebula, Vaporous Nebula",
    url: "https://sistersprobe.fandom.com/de/wiki/Small_Nebula",
  }),
});

function region(regionID, source = null) {
  return Object.freeze(source ? { regionID, source } : { regionID });
}

function constellation(regionID, constellationID) {
  return Object.freeze({ regionID, constellationID });
}

function lowsecOf(regionID) {
  return Object.freeze({ regionID, lowsecOnly: true });
}

function site(source, placements, options = {}) {
  return Object.freeze({
    source,
    placements: Object.freeze(placements),
    gasKind: options.gasKind || "cytoserocin",
    evidenceCompleteness: options.evidenceCompleteness !== false,
  });
}

const GAS_SITE_PLACEMENTS = Object.freeze({
  "Arctic Fox Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000006, 20000086), // Wicked Creek, 760-9C
  ]),
  "Bandit Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000002), // The Forge, low security systems
  ]),
  "Blackeye Nebula": site("eveUniGasCloudHarvesting", [
    region(10000054), // Aridia
    region(10000012), // Curse
    region(10000049), // Khanid
    region(10000065), // Kor-Azor
    region(10000062), // Omist
    region(10000044), // Solitude
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Boisterous Nebula": site("eveUniGasCloudHarvesting", [
    region(10000056), // Feythabolis
  ]),
  "Bright Nebula": site("eveUniGasCloudHarvesting", [
    region(10000064), // Essence
    region(10000058), // Fountain
    region(10000048), // Placid
    region(10000045), // Tenal
    region(10000015), // Venal
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Calabash Nebula": site("eveUniGasCloudHarvesting", [
    region(10000043), // Domain
    region(10000067), // Genesis
    region(10000048), // Placid
    region(10000044), // Solitude
    constellation(10000058, 20000665), // Fountain, Pegasus
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Cardinal Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000056, 20000646), // Feythabolis, I-3ODK
  ]),
  "Cheetah Nebula": site("eveUniGasCloudHarvesting", [
    region(10000014), // Catch
  ]),
  "Cobra Nebula": site("eveUniGasCloudHarvesting", [
    region(10000060), // Delve
  ]),
  "Crab Spider Nebula": site("eveUniGasCloudHarvesting", [
    region(10000060), // Delve
  ]),
  "Crimson Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000054), // Aridia, low security systems
  ]),
  "Crystal Nebula": site("eveUniGasCloudHarvesting", [
    region(10000006), // Wicked Creek
  ]),
  "Dewy Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000003, 20000044), // Vale of the Silent, E-8CSQ
  ]),
  "Diablo Nebula": site("eveUniGasCloudHarvesting", [
    region(10000069), // Black Rise
    region(10000037), // Everyshore
    region(10000016), // Lonetrek
    region(10000021), // Outer Passage
    region(10000032), // Sinq Laison
    region(10000033), // The Citadel
    region(10000002), // The Forge
    region(10000003), // Vale of the Silent
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Diamond Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000058, 20000665), // Fountain, Pegasus
  ]),
  "Duo Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000014, 20000175), // Catch, 9HXQ-G
  ]),
  "Eagle Nebula": site("eveUniGasCloudHarvesting", [
    region(10000012), // Curse
    region(10000001), // Derelik
    region(10000038), // The Bleak Lands
    region(10000036), // Devoid
    region(10000030), // Heimatar
    region(10000009), // Insmother
    region(10000042), // Metropolis
    region(10000028), // Molden Heath
    region(10000061), // Tenerifis
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Emerald Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000001), // Derelik, low security systems
  ]),
  "Flame Nebula": site("eveUniGasCloudHarvesting", [
    region(10000012), // Curse
    region(10000001), // Derelik
    region(10000036), // Devoid
    region(10000038), // The Bleak Lands
    region(10000011), // Great Wildlands
    region(10000005), // Detorid
    region(10000030), // Heimatar
    region(10000009), // Insmother
    region(10000042), // Metropolis
    region(10000062), // Omist
    region(10000061), // Tenerifis
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Flowing Nebula": site("eveUniGasCloudHarvesting", [
    region(10000058), // Fountain
  ]),
  "Fluttering Nebula": site("eveUniGasCloudHarvesting", [
    region(10000003), // Vale of the Silent
  ]),
  "Foggy Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000003, 20000044), // Vale of the Silent, E-8CSQ
  ]),
  "Forgotten Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000048), // Placid, low security systems
  ]),
  "Frosty Nebula": site("eveUniGasCloudHarvesting", [
    region(10000051), // Cloud Ring
  ]),
  "Gaseous Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000045, 20000527), // Tenal, 09-4XW
  ]),
  "Ghost Nebula": site("eveUniGasCloudHarvesting", [
    region(10000012), // Curse
    region(10000001), // Derelik
    region(10000036), // Devoid
    region(10000038), // The Bleak Lands
    region(10000030), // Heimatar
    region(10000028), // Molden Heath
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Glass Nebula": site("eveUniGasCloudHarvesting", [
    region(10000043), // Domain
    region(10000044), // Solitude
    region(10000023), // Pure Blind
    region(10000048), // Placid
    region(10000067), // Genesis
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Glistening Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000006, 20000086), // Wicked Creek, 760-9C
  ]),
  "Goose Nebula": site("eveUniGasCloudHarvesting", [
    region(10000051), // Cloud Ring
  ]),
  "Hazy Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000060, 20000702), // Delve, OK-FEM
  ]),
  "Helix Nebula": site("eveUniGasCloudHarvesting", [
    region(10000054), // Aridia
    region(10000012), // Curse
    region(10000001), // Derelik
    region(10000049), // Khanid
    region(10000065), // Kor-Azor
    region(10000044), // Solitude
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Hidden Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000060, 20000702), // Delve, OK-FEM
  ]),
  "Icy Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000051, 20000594), // Cloud Ring, Assilot
  ]),
  "Leopard Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000014, 20000175), // Catch, 9HXQ-G
  ]),
  "Lion Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000045, 20000527), // Tenal, 09-4XW
  ]),
  "Massive Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000058, 20000665), // Fountain, Pegasus
  ]),
  "Moth Nebula": site("eveUniGasCloudHarvesting", [
    region(10000045), // Tenal
  ]),
  "Murky Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000006, 20000086), // Wicked Creek, 760-9C
  ]),
  "Pale Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000051, 20000594), // Cloud Ring, Assilot
  ]),
  "Peacock Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000058, 20000665), // Fountain, Pegasus
  ]),
  "Phoenix Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000044), // Solitude, low security systems
  ]),
  "Pipe Nebula": site("eveUniGasCloudHarvesting", [
    region(10000012), // Curse
    region(10000001), // Derelik
    region(10000036), // Devoid
    region(10000038), // The Bleak Lands
    region(10000030), // Heimatar
    region(10000025), // Immensea
    region(10000042), // Metropolis
    region(10000061), // Tenerifis
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Polar Bear Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000051, 20000594), // Cloud Ring, Assilot
  ]),
  "Profiteer Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000016), // Lonetrek, low security systems
  ]),
  "Rapture Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000028), // Molden Heath, low security systems
  ]),
  "Red Dragonfly Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000056, 20000646), // Feythabolis, I-3ODK
  ]),
  "Rimy Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000014, 20000175), // Catch, 9HXQ-G
  ]),
  "Ring Nebula": site("eveUniGasCloudHarvesting", [
    region(10000069), // Black Rise
    region(10000027), // Etherium Reach
    region(10000037), // Everyshore
    region(10000016), // Lonetrek
    region(10000013), // Malpais
    region(10000021), // Outer Passage
    region(10000066), // Perrigen Falls
    region(10000032), // Sinq Laison
    region(10000033), // The Citadel
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Rocky Nebula": site("eveUniGasCloudHarvesting", [
    region(10000003), // Vale of the Silent
  ]),
  "Saintly Nebula": site("eveUniGasCloudHarvesting", [
    lowsecOf(10000030), // Heimatar, low security systems
  ]),
  "Shimmering Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000003, 20000044), // Vale of the Silent, E-8CSQ
  ]),
  "Shiny Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000045, 20000527), // Tenal, 09-4XW
  ]),
  "Sister Nebula": site("eveUniGasCloudHarvesting", [
    region(10000054), // Aridia
    region(10000012), // Curse
    region(10000001), // Derelik
    region(10000052), // Kador
    region(10000049), // Khanid
    region(10000065), // Kor-Azor
    region(10000062), // Omist
    region(10000044), // Solitude
    region(10000006), // Wicked Creek
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Small Nebula": site("sistersProbeNebulae", [
    region(10000014), // Catch
  ]),
  "Smoking Nebula": site("eveUniGasCloudHarvesting", [
    region(10000069), // Black Rise
    region(10000027), // Etherium Reach
    region(10000037), // Everyshore
    region(10000016), // Lonetrek
    region(10000021), // Outer Passage
    region(10000066), // Perrigen Falls
    region(10000032), // Sinq Laison
    region(10000033), // The Citadel
    region(10000018), // The Spire
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Snowy Owl Nebula": site("eveUniGasCloudHarvesting", [
    region(10000006), // Wicked Creek
  ]),
  "Spacious Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000003, 20000044), // Vale of the Silent, E-8CSQ
  ]),
  "Sparking Nebula": site("eveUniGasCloudHarvesting", [
    region(10000043), // Domain
    region(10000064), // Essence
    region(10000058), // Fountain
    region(10000067), // Genesis
    region(10000048), // Placid
    region(10000023), // Pure Blind
    region(10000045), // Tenal
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Sunspark Nebula": site("eveUniGasCloudHarvesting", [
    region(10000069), // Black Rise
    region(10000016), // Lonetrek
    region(10000021), // Outer Passage
    region(10000032), // Sinq Laison
    region(10000033), // The Citadel
    region(10000002), // The Forge
    region(10000018), // The Spire
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Swarm Nebula": site("eveUniGasCloudHarvesting", [
    region(10000045), // Tenal
  ]),
  "Thick Nebula": site("eveUniGasCloudHarvesting", [
    region(10000058), // Fountain
  ]),
  "Vaporous Nebula": site("sistersProbeNebulae", [
    region(10000056), // Feythabolis
  ]),
  "Whirling Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000060, 20000702), // Delve, OK-FEM
  ]),
  "Wild Nebula": site("eveUniGasCloudHarvesting", [
    region(10000054), // Aridia
    region(10000009), // Insmother
    region(10000065), // Kor-Azor
    region(10000012), // Curse
    region(10000062), // Omist
    region(10000044), // Solitude
    region(10000020), // Tash-Murkon
    region(10000025, "eveUniWildNebula"), // Immensea (individual site page)
    region(10000049, "eveUniWildNebula"), // Khanid (individual site page)
    region(10000061, "eveUniWildNebula"), // Tenerifis (individual site page)
    region(10000011, "eveUniWildNebula"), // Great Wildlands (individual site page)
  ], { gasKind: "mykoserocin", evidenceCompleteness: false }),
  "Wispy Nebula": site("eveUniGasCloudHarvesting", [
    constellation(10000056, 20000646), // Feythabolis, I-3ODK
  ]),
});

function templateName(template) {
  return String(template && (template.resolvedName || template.name) || "").trim();
}

function resolveTemplateGasPlacement(template) {
  const entry = GAS_SITE_PLACEMENTS[templateName(template)];
  return entry || null;
}

function placementMatches(placement, system, securityBand) {
  if (toInt(system.regionID, 0) !== placement.regionID) {
    return false;
  }
  if (placement.constellationID && toInt(system.constellationID, 0) !== placement.constellationID) {
    return false;
  }
  if (placement.lowsecOnly && securityBand !== "lowsec") {
    return false;
  }
  return true;
}

// A known positive catalog is not an exhaustive negative for Mykoserocin.
// Classification belongs to the table, so the lightweight selection descriptor
// (which intentionally does not carry template.gasKind) takes the same path.
function evaluateTemplateInSystem(template, systemID, securityBand) {
  const entry = resolveTemplateGasPlacement(template);
  const system = worldData.getSolarSystemByID(toInt(systemID, 0)) || null;
  const isGas = Boolean(entry) || String(template && template.siteFamily || "").toLowerCase() === "gas";
  if (system && toInt(system.regionID, 0) === 10000070 && isGas) {
    return {
      allowed: false,
      reason: "gas_blocked_pochven_owner_provisional",
      source: "ownerProvisionalPochvenGas",
      evidenceClass: "owner_provisional",
    };
  }
  if (!entry) return null;
  const matched = system && entry.placements.find(placement => placementMatches(placement, system, securityBand));
  if (system && !matched && entry.evidenceCompleteness === false) return null;
  return {
    allowed: Boolean(matched),
    reason: matched ? "allowed_gas_site_region" : "gas_site_outside_its_regions",
    source: matched && matched.source || entry.source,
  };
}

module.exports = {
  GAS_SITE_PLACEMENTS,
  SOURCE_REFS,
  resolveTemplateGasPlacement,
  evaluateTemplateInSystem,
};
