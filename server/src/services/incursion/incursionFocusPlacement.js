"use strict";

// Client/SDE geography is factual. Eligibility, role assignment, quotas and
// placement distributions below are named emulator policy, not retail authoring.
const { SITES, SCENE, fingerprint, fail } = require("./incursionLifecycleContract");
const VERSION = "evejs.incursion-focus-placement.v1";
const AU = 149597870700;
const positive = value => Number.isSafeInteger(value) && value > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function policy() {
  return { version: VERSION, kind: "emulator-policy",
    knownSpace: { system: [30000000, 30999999], constellation: [20000000, 20999999], region: [10000000, 10999999] },
    excludedRegionIDs: [10000004, 10000017, 10000019, 10001004],
    excludedFactionIDs: [500026], excludedSystemIDs: [30100000],
    security: "high-at-least-0.45-low-positive-null-nonpositive",
    affectedSystemCount: 4, roles: [SCENE.staging, SCENE.vanguard, SCENE.assault, SCENE.headquarters],
    links: "reciprocal-static-stargates-in-same-constellation-and-security-band",
    concurrencyTargets: { high: 1, low: 1, null: 1 },
    selection: "sha256-ranked-components-and-connected-breadth-first-system-selection",
    slots: SITES.filter(row => row.role !== "boss").map(row => ({ dungeonID: row.dungeonID,
      sceneType: { scout: SCENE.staging, vanguard: SCENE.vanguard, assault: SCENE.assault, headquarters: SCENE.headquarters }[row.role] })),
    position: { minimumAU: 2, maximumAU: 8, minimumSeparationMeters: 1000000000, maximumAttempts: 64 },
    replacementRangeMs: [12 * 3600000, 36 * 3600000], retryDelayMs: 60000,
    clientReference: "3396210 inventorycommon/const.py; eve/common/script/sys/idCheckers.py; eve/common/lib/appConst.py",
    qualification: "Client space ranges, special-space identities, native roles/site mappings and SDE jumps are reused. Excluding those spaces, selecting four connected systems, one slot per mapped normal site, quotas, hashing and local AU positions are emulator policy. The replacement range is historical CCP guidance; this distribution is emulator policy." };
}
function band(system) {
  const security = Number(system?.security ?? system?.securityStatus);
  return !Number.isFinite(security) ? null : security >= 0.45 ? "high" : security > 0 ? "low" : "null";
}
function eligible(system, rules) {
  const inRange = (value, range) => Number.isSafeInteger(value) && value >= range[0] && value <= range[1];
  return inRange(system?.solarSystemID, rules.knownSpace.system) && inRange(system.constellationID, rules.knownSpace.constellation) &&
    inRange(system.regionID, rules.knownSpace.region) && band(system) &&
    !rules.excludedRegionIDs.includes(system.regionID) && !rules.excludedFactionIDs.includes(system.factionID) &&
    !rules.excludedSystemIDs.includes(system.solarSystemID);
}
function catalogBody(catalog) {
  return { version: catalog.version, policy: catalog.policy, components: catalog.components };
}
function buildCatalog({ systems, stargates }) {
  if (!Array.isArray(systems) || !Array.isArray(stargates)) fail("INCURSION_FOCUS_GEOGRAPHY_UNAVAILABLE");
  const rules = policy(), byID = new Map(), seen = new Set();
  for (const system of systems) {
    if (!positive(system?.solarSystemID) || seen.has(system.solarSystemID)) fail("INCURSION_FOCUS_GEOGRAPHY_INVALID");
    seen.add(system.solarSystemID);
    if (eligible(system, rules)) byID.set(system.solarSystemID, { solarSystemID: system.solarSystemID,
      regionID: system.regionID, constellationID: system.constellationID, securityBand: band(system) });
  }
  const links = new Set(stargates.filter(gate => positive(gate?.solarSystemID) && positive(gate.destinationSolarSystemID))
    .map(gate => `${gate.solarSystemID}:${gate.destinationSolarSystemID}`));
  const adjacent = new Map([...byID.keys()].map(id => [id, new Set()]));
  for (const gate of stargates) {
    const from = byID.get(gate?.solarSystemID), to = byID.get(gate?.destinationSolarSystemID);
    if (from && to && from.solarSystemID !== to.solarSystemID && from.constellationID === to.constellationID &&
        from.regionID === to.regionID && from.securityBand === to.securityBand && links.has(`${to.solarSystemID}:${from.solarSystemID}`))
      adjacent.get(from.solarSystemID).add(to.solarSystemID);
  }
  const visited = new Set(), components = [];
  for (const id of [...byID.keys()].sort((a, b) => a - b)) {
    if (visited.has(id)) continue;
    const queue = [id], members = []; visited.add(id);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]; members.push(current);
      for (const other of [...adjacent.get(current)].sort((a, b) => a - b)) if (!visited.has(other)) { visited.add(other); queue.push(other); }
    }
    if (members.length < rules.affectedSystemCount) continue;
    const source = byID.get(id);
    components.push({ key: `${source.constellationID}:${source.securityBand}:${id}`,
      constellationID: source.constellationID, regionID: source.regionID, securityBand: source.securityBand,
      systems: members.sort((a, b) => a - b).map(systemID => ({ solarSystemID: systemID,
        neighbors: [...adjacent.get(systemID)].sort((a, b) => a - b) })) });
  }
  const result = { version: VERSION, policy: rules, components };
  return { ...result, fingerprint: fingerprint(catalogBody(result)) };
}
function loadCatalog() {
  const { TABLE, readStaticRows } = require("../_shared/referenceData");
  return buildCatalog({ systems: readStaticRows(TABLE.SOLAR_SYSTEMS), stargates: readStaticRows(TABLE.STARGATES) });
}
function assertCatalog(catalog) {
  if (catalog?.version !== VERSION || fingerprint(catalog.policy) !== fingerprint(policy()) ||
      !Array.isArray(catalog.components) || fingerprint(catalogBody(catalog)) !== catalog.fingerprint)
    fail("INCURSION_FOCUS_GEOGRAPHY_PROOF_INVALID");
}
function rank(seed, selectionKey, label) { return fingerprint([VERSION, seed, selectionKey, label]); }
function randomFraction(seed, selectionKey, label) { return Number.parseInt(rank(seed, selectionKey, label).slice(0, 13), 16) / 0x10000000000000; }
function validateSelection(seed, selectionKey) {
  if (typeof seed !== "string" || !/^[a-f0-9]{64}$/.test(seed) || typeof selectionKey !== "string" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(selectionKey)) fail("INCURSION_FOCUS_SELECTION_INVALID");
}
function replacementDelay(seed, selectionKey) {
  validateSelection(seed, selectionKey);
  const [min, max] = policy().replacementRangeMs;
  return min + Math.floor(randomFraction(seed, selectionKey, "replacement-delay") * (max - min + 1));
}
function selectPlacement(catalog, { seed, selectionKey, securityBand, occupiedConstellationIDs = [], occupiedSystemIDs = [] }) {
  assertCatalog(catalog); validateSelection(seed, selectionKey);
  if (!["high", "low", "null"].includes(securityBand) || !Array.isArray(occupiedConstellationIDs) || !Array.isArray(occupiedSystemIDs))
    fail("INCURSION_FOCUS_SELECTION_INVALID");
  const rules = catalog.policy, occupied = new Set(occupiedSystemIDs), constellations = new Set(occupiedConstellationIDs);
  const candidates = catalog.components.filter(component => component.securityBand === securityBand && !constellations.has(component.constellationID) &&
    !component.systems.some(system => occupied.has(system.solarSystemID)));
  const ranked = values => values.slice().sort((a, b) => compare(rank(seed, selectionKey, a), rank(seed, selectionKey, b)) || compare(a, b));
  const key = ranked(candidates.map(component => component.key))[0], selected = candidates.find(component => component.key === key);
  if (!selected) return null;
  const byID = new Map(selected.systems.map(system => [system.solarSystemID, system]));
  const queue = [ranked([...byID.keys()])[0]], visited = new Set(queue), chosen = [];
  for (let index = 0; index < queue.length && chosen.length < rules.affectedSystemCount; index++) {
    const id = queue[index]; chosen.push(id);
    for (const neighbor of ranked(byID.get(id).neighbors)) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
  }
  if (chosen.length !== rules.affectedSystemCount) fail("INCURSION_FOCUS_GEOGRAPHY_INVALID");
  const systems = chosen.map((solarSystemID, index) => ({ solarSystemID, sceneType: rules.roles[index] }));
  const positions = new Map();
  function position(systemID, label) {
    const prior = positions.get(systemID) || [];
    for (let attempt = 0; attempt < rules.position.maximumAttempts; attempt++) {
      const vector = ["x", "y", "z"].map(axis => randomFraction(seed, selectionKey, `${systemID}:${label}:${attempt}:${axis}`) * 2 - 1);
      const length = Math.hypot(...vector); if (length < 0.000001) continue;
      const radius = AU * (rules.position.minimumAU + randomFraction(seed, selectionKey, `${systemID}:${label}:${attempt}:radius`) *
        (rules.position.maximumAU - rules.position.minimumAU));
      const result = Object.fromEntries(["x", "y", "z"].map((axis, index) => [axis, vector[index] * radius / length]));
      if (prior.some(point => Math.hypot(...["x", "y", "z"].map(axis => point[axis] - result[axis])) < rules.position.minimumSeparationMeters)) continue;
      prior.push(result); positions.set(systemID, prior); return result;
    }
    fail("INCURSION_FOCUS_POSITION_CAPACITY");
  }
  const siteSlots = rules.slots.map(slot => {
    const solarSystemID = systems.find(system => system.sceneType === slot.sceneType).solarSystemID;
    return { slotID: `site-${slot.dungeonID}`, dungeonID: slot.dungeonID, solarSystemID, position: position(solarSystemID, slot.dungeonID) };
  });
  const hqID = systems.find(system => system.sceneType === SCENE.headquarters).solarSystemID;
  return { constellationID: selected.constellationID, stagingSolarSystemID: chosen[0], securityBand, systems, siteSlots,
    finalSite: { solarSystemID: hqID, position: position(hqID, "boss") },
    provenance: { placement: VERSION, policyFingerprint: fingerprint(rules), geographyFingerprint: catalog.fingerprint, selectionKey } };
}
module.exports = { VERSION, policy, buildCatalog, loadCatalog, selectPlacement, replacementDelay };
