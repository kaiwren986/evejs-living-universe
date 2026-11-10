"use strict";

// Native wire IDs and hex geometry are from the supported client's hackingcommon
// constants/TileData. Board distributions, tier tuning and special-effect ordering
// below are an authored reconstruction: the client contains no server generator.
const constants = Object.freeze({
  GAMETYPE_HACKING: 0, GAMETYPE_ARCHEOLOGY: 1, GAMETYPE_MULTICORE: 2,
  TYPE_NONE: -1, TYPE_SEGMENT: 0, TYPE_VIRUS: 1, TYPE_CORE: 2,
  TYPE_DEFENSESOFTWARE: 3, TYPE_UTILITYELEMENT: 4, TYPE_UTILITYELEMENTTILE: 5,
  TYPE_DATACACHE: 6, SUBTYPE_NONE: -1,
  SUBTYPE_UE_SELFREPAIR: 0, SUBTYPE_UE_KERNALROT: 1,
  SUBTYPE_UE_SECONDARYVECTOR: 2, SUBTYPE_UE_POLYMORPHICSHIELD: 3,
  SUBTYPE_CORE_HIGH: 10, SUBTYPE_CORE_LOW: 11, SUBTYPE_CORE_MEDIUM: 12,
  SUBTYPE_DS_ANTIVIRUS: 100, SUBTYPE_DS_FIREWALL: 101,
  SUBTYPE_DS_HONEYPOT_STRENGTH: 102, SUBTYPE_DS_HONEYPOT_HEALING: 103,
  SUBTYPE_DS_DISRUPTOR: 104,
  SUBTYPE_DS_IDS: 200, SUBTYPE_DS_BITCHINATOR: 300, SUBTYPE_DS_DELETER: 301,
  SUBTYPE_DS_FLYTRAP: 302, SUBTYPE_DS_MARCHINGCUBES: 303,
  SUBTYPE_DS_REPLICATOR: 304, SUBTYPE_DS_RESETTER: 305,
  EVENT_GAME_LOST: 0, EVENT_GAME_WON: 1, EVENT_GAME_START: 2,
  EVENT_VIRUS_CREATED: 3, EVENT_OBJECT_KILLED: 4, EVENT_GAME_STYLE: 5,
  EVENT_ACK: 6, EVENT_TILE_FLIPPED: 100, EVENT_TILE_CREATED: 101,
  EVENT_TILE_BLOCKED: 102, EVENT_TILE_REACHABLE: 103,
  EVENT_UE_PICKEDUP: 200, EVENT_UE_REMOVED: 201, EVENT_UE_INUSE: 202,
  EVENT_DATACACHE_OPEN: 300, EVENT_ATTACK: 301, EVENT_KERNALROT: 302,
  EVENT_SELFREPAIR: 303, EVENT_SECONDARYVECTOR: 304,
  EVENT_POLYMORPHICSHIELDHIT: 305, EVENT_HONEYPOT_STRENGTH: 306,
  EVENT_HONEYPOT_HEALING: 307, EVENT_DISTANCEINDICATOR: 308,
  EVENT_CORE_CONTENTS: 400, EVENT_UNLOCK_CORE_CONTENTS: 401,
  UE_NOTUSED: 0, UE_DESTROYED: 1, UE_INUSE: 2,
  HACKING_STATE_SECURE: 0, HACKING_STATE_BEING_HACKED: 1, HACKING_STATE_HACKED: 2,
});
const C = constants;
const freeze = object => {
  for (const value of Object.values(object)) {
    if (value && typeof value === "object") freeze(value);
  }
  return Object.freeze(object);
};

// Generation calibration ported from PR #201 (f47fb95d9). Its measured board
// envelopes and reported 701-cell neighbour sample are useful reconstruction
// evidence, not a recovered retail server algorithm. Stats are [coherence,
// strength]. Tier 0 is real dogma authority and uses the very-easy profile
// without being rewritten to tier 1. Unverified rare defenses remain opt-in
// authored objects rather than appearing in the natural generation pools.
const profiles = freeze([
  {tier: 0, name: "introductory", width: 8, height: 8, core: [50, 10], coreSubtype: 11,
    antivirus: [30, 30], firewall: [40, 20], restoration: null, suppressor: null,
    defenseTypes: [101], utilityTypes: [0], cacheUtilityTypes: [0, 1]},
  {tier: 1, name: "very easy", width: 8, height: 8, core: [50, 10], coreSubtype: 11,
    antivirus: [30, 30], firewall: [40, 20], restoration: null, suppressor: null,
    defenseTypes: [101], utilityTypes: [0], cacheUtilityTypes: [0, 1]},
  {tier: 2, name: "easy", width: 8, height: 8, core: [70, 10], coreSubtype: 11,
    antivirus: [30, 30], firewall: [50, 20], restoration: null, suppressor: null,
    defenseTypes: [101], utilityTypes: [0], cacheUtilityTypes: [0, 1]},
  {tier: 3, name: "medium", width: 9, height: 9, core: [78, 10], coreSubtype: 12,
    antivirus: [50, 40], firewall: [80, 20], restoration: [80, 10], suppressor: null,
    defenseTypes: [101, 100, 103], utilityTypes: [0, 1, 3], cacheUtilityTypes: [0, 1, 3]},
  {tier: 4, name: "hard", width: 10, height: 9, core: [90, 10], coreSubtype: 10,
    antivirus: [60, 40], firewall: [90, 20], restoration: [80, 10], suppressor: [60, 15],
    defenseTypes: [101, 100, 103, 102], utilityTypes: [0, 1, 3, 2], cacheUtilityTypes: [0, 1, 3, 2]},
  {tier: 5, name: "hardest", width: 10, height: 9, core: [120, 10], coreSubtype: 10,
    antivirus: [70, 40], firewall: [100, 20], restoration: [90, 10], suppressor: [70, 15],
    defenseTypes: [101, 100, 103, 102], utilityTypes: [0, 1, 3, 2], cacheUtilityTypes: [0, 1, 3, 2]},
]);

// A site container may bring its own board (populationHints.containers[].hackingBoard, the
// career agents' Training Containers): these fields replace the tier profile's.
const BOARD_FIELDS = freeze(["width", "height", "core", "antivirus", "firewall", "restoration", "suppressor",
  "defenseTypes", "utilityTypes", "cacheUtilityTypes", "randomDefenseCount", "cacheDefenses"]);
function boardProfileFor(tier, board) {
  if (!board || typeof board !== "object" || Array.isArray(board)) return profiles[tier];
  const own = Object.fromEntries(BOARD_FIELDS.filter(key => board[key] !== undefined).map(key => [key, board[key]]));
  return freeze({...profiles[tier], ...own, name: `${profiles[tier].name} (site board)`});
}

// Per-size soft fits to PR #201's mixed-size sample. The exemption chance keeps
// the observed short tail of cells with one or two surviving neighbours.
const holeFits = freeze({
  "8x8": {exemptChance: 0.05, clusterSizeWeights: [1, 1, 1, 1, 10], fraction: 0.22},
  "9x9": {exemptChance: 0.07, clusterSizeWeights: [1, 1, 1, 1, 4], fraction: 0.24},
  "9x10": {exemptChance: 0.07, clusterSizeWeights: [1, 1, 1, 1, 6], fraction: 0.25},
});

const tuple = coord => ({type: "tuple", items: [...coord]});
const key = tile => tile.coord.items.join(",");
function validCoord(coord) {
  return Array.isArray(coord) && coord.length === 2 &&
    coord.every(value => typeof value === "number" && Number.isInteger(value) &&
      value >= 0 && value < 10) && coord[1] < 9;
}
function neighbours(tiles, tile) {
  const [x, y] = tile.coord.items;
  const offsets = y % 2
    ? [[0, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [1, 1]]
    : [[-1, -1], [0, -1], [-1, 0], [1, 0], [-1, 1], [0, 1]];
  const keys = new Set(offsets.map(([dx, dy]) => `${x + dx},${y + dy}`));
  return tiles.filter(node => keys.has(key(node)));
}
function distances(tiles, start) {
  const result = new Map([[key(start), 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const node of neighbours(tiles, queue[i])) {
      if (result.has(key(node))) continue;
      result.set(key(node), result.get(key(queue[i])) + 1);
      queue.push(node);
    }
  }
  return result;
}
function random(board) {
  // Mulberry32 keeps seeds reproducible without storing a function in the pure
  // board snapshot. State is advanced only on accepted actions/generation.
  board.randomState = (board.randomState + 0x6d2b79f5) >>> 0;
  let value = board.randomState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
}
function choose(board, list) {
  return list.length ? list[Math.floor(random(board) * list.length)] : undefined;
}
function positiveInteger(value, fallback, max) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(1, Math.floor(value))) : fallback;
}
function emptySlot(index) {
  return {id: -(index + 1), subtype: -1, info: null, isInUse: false,
    durationRemaining: null, totalDuration: null};
}
function utility(board, subtype) {
  const amount = subtype === 0 ? 5 + Math.floor(random(board) * 6)
    : subtype === 1 ? 50 : subtype === 2 ? 20 : 2;
  return {subtype, amount, duration: subtype === 0 || subtype === 2 ? 3
    : subtype === 3 ? 2 : 1};
}
function defense(profile, subtype) {
  const stats = subtype === 100 ? profile.antivirus : subtype === 101 ? profile.firewall
    : subtype === 102 ? profile.suppressor : subtype === 103 ? profile.restoration : [80, 20];
  return {type: C.TYPE_DEFENSESOFTWARE, subtype, coherence: stats[0], strength: stats[1]};
}

function resolveHackingDifficultyTier(value, fallback = 1) {
  const normalizedFallback = fallback === null || Number.isNaN(fallback) ? fallback
    : typeof fallback === "number" && Number.isFinite(fallback)
      ? Math.max(0, Math.min(5, Math.floor(fallback))) : 1;
  if (typeof value === "string") {
    const name = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
    const named = {intro: 0, introductory: 0, veryeasy: 1, easiest: 1,
      easy: 2, medium: 3, moderate: 3, hard: 4, difficult: 4,
      hardest: 5, extreme: 5};
    if (Object.hasOwn(named, name)) return named[name];
    if (!value.trim()) return normalizedFallback;
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(5, Math.floor(value))) : normalizedFallback;
}

function fullGrid(profile) {
  const tiles = [];
  for (let y = 0; y < profile.height; y++) {
    for (let x = 0; x < profile.width; x++) {
      tiles.push({id: y * profile.width + x + 1, coord: tuple([x, y]),
        type: 0, subtype: -1, hidden: true, blocked: false, strength: 0, coherence: 0});
    }
  }
  return tiles;
}

function digPresentTiles(board, profile) {
  const cells = fullGrid(profile);
  // Store full-grid adjacency once: the hole fit counts surviving neighbours,
  // whereas Rule of Eight measures distance through the complete envelope.
  const adjacent = new Map(cells.map(node => [key(node), neighbours(cells, node)]));
  // A size without its own fit (the training board) digs like the 8x8 sample.
  const fit = holeFits[`${profile.height}x${profile.width}`] || holeFits["8x8"];
  const removed = new Set();
  const canRemove = (node, cluster) => {
    if (random(board) < fit.exemptChance) return true;
    return adjacent.get(key(node)).every(neighbor => {
      if (removed.has(key(neighbor)) || cluster.has(key(neighbor))) return true;
      const alive = adjacent.get(key(neighbor)).filter(other =>
        !removed.has(key(other)) && !cluster.has(key(other))).length;
      return alive - 1 >= 3;
    });
  };
  const totalWeight = fit.clusterSizeWeights.reduce((sum, value) => sum + value, 0);
  const rollSize = () => {
    let roll = random(board) * totalWeight;
    for (let i = 0; i < fit.clusterSizeWeights.length; i++) {
      roll -= fit.clusterSizeWeights[i];
      if (roll < 0) return i + 1;
    }
    return 5;
  };
  const target = Math.floor(cells.length * fit.fraction);
  for (let guard = 0; removed.size < target && guard < 20000; guard++) {
    const seeds = cells.filter(node => !removed.has(key(node)) && canRemove(node, new Set()));
    if (!seeds.length) break;
    const seed = choose(board, seeds);
    const cluster = new Set([key(seed)]);
    let frontier = adjacent.get(key(seed)).filter(node => !removed.has(key(node)));
    const wanted = rollSize();
    while (cluster.size < wanted && frontier.length) {
      let candidates = frontier.filter(node => !removed.has(key(node)) &&
        !cluster.has(key(node)) && canRemove(node, cluster));
      if (!candidates.length) break;
      const touching = node => adjacent.get(key(node)).filter(other => cluster.has(key(other))).length;
      const best = Math.max(...candidates.map(touching));
      candidates = candidates.filter(node => touching(node) === best);
      const chosen = choose(board, candidates);
      cluster.add(key(chosen));
      frontier = frontier.filter(node => !cluster.has(key(node)));
      for (const neighbor of adjacent.get(key(chosen))) {
        if (!removed.has(key(neighbor)) && !cluster.has(key(neighbor))) frontier.push(neighbor);
      }
    }
    for (const cellKey of cluster) removed.add(cellKey);
  }

  // Retain the largest connected component. Digging never leaves isolated
  // islands available for encounters or a core the player cannot reach.
  const present = new Map(cells.filter(node => !removed.has(key(node))).map(node => [key(node), node]));
  const visited = new Set();
  let largest = [];
  for (const node of present.values()) {
    if (visited.has(key(node))) continue;
    const component = [node];
    visited.add(key(node));
    for (let i = 0; i < component.length; i++) {
      for (const neighbor of adjacent.get(key(component[i]))) {
        if (present.has(key(neighbor)) && !visited.has(key(neighbor))) {
          visited.add(key(neighbor));
          component.push(neighbor);
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  return {tiles: largest, full: cells};
}

function populate(board, profile) {
  let generated = digPresentTiles(board, profile);
  let attempts = 1;
  const minimumCells = Math.ceil(profile.width * profile.height * 0.6);
  // The reference occasionally cuts the grid in half (8x8 seeds 24/26 retain
  // just 26 cells). Reroll from the same serializable RNG stream to preserve a
  // useful board envelope. Bound the work, then use a connected full grid if
  // every candidate was pathological; this fallback is safe and deterministic.
  while (generated.tiles.length < minimumCells && attempts < 32) {
    generated = digPresentTiles(board, profile);
    attempts++;
  }
  const topologyFallback = generated.tiles.length < minimumCells;
  const {full} = generated;
  const tiles = topologyFallback ? full : generated.tiles;
  board.generationAttempts = attempts;
  board.topologyFallback = topologyFallback;
  board.tiles = tiles;
  const neighborCount = new Map(tiles.map(node => [key(node), neighbours(tiles, node).length]));
  const rim = tiles.filter(node => {
    const [x, y] = node.coord.items;
    return x === 0 || x === profile.width - 1 || y === 0 || y === profile.height - 1;
  });
  const viableRim = rim.filter(node => neighborCount.get(key(node)) >= 2);
  const startPool = viableRim.length ? viableRim : rim.length ? rim : tiles;
  const fewest = Math.min(...startPool.map(node => neighborCount.get(key(node))));
  const start = choose(board, startPool.filter(node => neighborCount.get(key(node)) === fewest));
  start.hidden = false;
  board.startCoord = [...start.coord.items];

  // Rule of Eight uses full-grid distances, including removed cells. Preserve
  // the calibrated small-board fallback when fewer than three far cells exist.
  const fullDistances = distances(full, start);
  const far = tiles.filter(node => node !== start && fullDistances.get(key(node)) >= 8);
  const core = choose(board, far.length >= 3 ? far : tiles.filter(node => node !== start));
  Object.assign(core, {type: 2, subtype: profile.coreSubtype,
    coherence: profile.core[0], strength: profile.core[1]});
  board.coreCoord = [...core.coord.items];

  // Rule of Six: a six-neighbour cell stays empty. Defense/cache placements
  // leave the start neighbourhood clear; caches additionally require <=3
  // neighbours, while their density uses the entire eligible population.
  const occupied = new Set([key(start), key(core)]);
  const startNeighbors = new Set(neighbours(tiles, start).map(key));
  const eligible = tiles.filter(node => !occupied.has(key(node)) && neighborCount.get(key(node)) < 6);
  const defensePool = eligible.filter(node => !startNeighbors.has(key(node)));
  const cachePool = defensePool.filter(node => neighborCount.get(key(node)) <= 3);
  const take = (pool, count) => {
    const available = pool.filter(node => !occupied.has(key(node)));
    const selected = [];
    while (selected.length < count && available.length) {
      const node = available.splice(Math.floor(random(board) * available.length), 1)[0];
      occupied.add(key(node));
      selected.push(node);
    }
    return selected;
  };
  const hasDefenses = profile.defenseTypes.length > 0;
  const defenseCount = !hasDefenses ? 0 : profile.randomDefenseCount ?? Math.floor(defensePool.length / 15) + 1;
  for (const node of take(defensePool, defenseCount)) {
    Object.assign(node, defense(profile, choose(board, profile.defenseTypes)));
  }
  const guardPool = hasDefenses ? neighbours(tiles, core).filter(node => !occupied.has(key(node)) &&
    neighborCount.get(key(node)) < 6 && !startNeighbors.has(key(node))) : [];
  const guard = guardPool.length ? choose(board, guardPool) : null;
  if (guard) {
    occupied.add(key(guard));
    Object.assign(guard, defense(profile, choose(board, profile.defenseTypes)));
  }
  const populationCount = Math.floor(eligible.length / 15) + 1;
  const utilities = take(eligible, populationCount);
  for (const node of utilities) {
    Object.assign(node, {type: 5, subtype: choose(board, profile.utilityTypes)});
  }
  const availableCaches = cachePool.filter(node => !occupied.has(key(node))).length;
  const caches = take(cachePool, populationCount);
  for (const node of caches) Object.assign(node, {type: 6, subtype: -1});
  board.populationAudit = {eligibleCount: eligible.length,
    defensePlacementPool: defensePool.length, defenseCountPlanned: defenseCount,
    coreGuardPlaced: Boolean(guard), utilityCountPlanned: populationCount,
    cacheCountPlanned: populationCount, cachePlacementPool: cachePool.length,
    cacheAvailableAfterEarlierPlacements: availableCaches};

  // Roll hidden contents after all placements, so effect power rolls cannot
  // distort the calibrated placement random sequence. Cache AV/Firewall have
  // the PR's reported +10 coherence; its unverified repair bonus is omitted.
  for (const node of utilities) node.utility = utility(board, node.subtype);
  for (const node of caches) {
    if (!hasDefenses || profile.cacheDefenses === false || random(board) < 0.5) {
      node.cacheContents = {type: 5, ...utility(board, choose(board, profile.cacheUtilityTypes))};
    } else {
      const types = profile.tier <= 2 ? [101, 100] : profile.defenseTypes;
      node.cacheContents = defense(profile, choose(board, types));
      if ([100, 101].includes(node.cacheContents.subtype)) node.cacheContents.coherence += 10;
    }
  }
}
function create({difficulty = 1, seed = 0, coherence = 100, strength = 20, slots = 3, siteBoard = null} = {}) {
  const tier = resolveHackingDifficultyTier(difficulty);
  const profile = boardProfileFor(tier, siteBoard);
  const initialCoherence = positiveInteger(coherence, 100, 1000000);
  const initialStrength = positiveInteger(strength, 20, 1000000);
  const slotCount = typeof slots === "number" && Number.isFinite(slots) && slots >= 0
    ? Math.min(10, Math.floor(slots)) : 3;
  const board = {difficulty: tier, profile: profile.name, seed: Number(seed) >>> 0,
    randomState: (Number(seed) >>> 0) || 1, tiles: [], virusID: 0,
    boardRows: profile.height, boardCols: profile.width,
    virusCoherence: initialCoherence, virusInitialCoherence: initialCoherence,
    virusStrength: initialStrength, baseVirusStrength: initialStrength,
    inventory: Array.from({length: slotCount}, (_, i) => emptySlot(i)),
    turn: 0, outcome: null, pendingUtilityClick: null};
  populate(board, profile);
  return board;
}

// This exact whitelist also serves TILE_CREATED -> TileData(**eventData), whose
// constructor rejects internal cache/utility state and distanceIndicator fields.
function publicTile(tile) {
  const hidden = Boolean(tile.hidden);
  return {id: tile.id, type: hidden ? -1 : tile.type, subtype: hidden ? -1 : tile.subtype,
    coord: tuple(tile.coord.items), hidden, blocked: Boolean(tile.blocked),
    strength: hidden ? 0 : tile.strength, coherence: hidden ? 0 : tile.coherence};
}
function publicInventory(board) {
  // The client supplies index itself to UtilityElementData(index=i, **element).
  return board.inventory.map(slot => ({id: slot.id, subtype: slot.subtype, info: slot.info,
    isInUse: slot.isInUse, durationRemaining: slot.durationRemaining,
    totalDuration: slot.totalDuration}));
}
// Initial construction accepts only id/subtype/info. Update(**element) accepts
// all runtime fields returned by publicInventory.
function initialInventory(board) {
  return publicInventory(board).map(({id, subtype, info}) => ({id, subtype, info}));
}
function virus(board) {
  return {id: board.virusID, type: C.TYPE_VIRUS,
    coherence: board.virusCoherence, strength: board.virusStrength};
}
function activeDefense(tile) {
  return !tile.hidden && tile.type === 3 && tile.coherence > 0;
}
function isBlocked(tiles, tile) {
  // Two neighboring defenses must both remain attackable. Other revealed
  // objects, including the core and unclaimed utilities, can be blocked.
  return (tile.hidden || tile.type !== 3) && neighbours(tiles, tile).some(activeDefense);
}
function canReveal(tiles, tile) {
  return !isBlocked(tiles, tile) && neighbours(tiles, tile).some(node =>
    !node.hidden && !isBlocked(tiles, node));
}
function accessible(board, tile) {
  return tile && !isBlocked(board.tiles, tile) &&
    (!tile.hidden || canReveal(board.tiles, tile));
}
function clue(board, tile) {
  const distance = distances(board.tiles, tile);
  const meaningful = board.tiles.filter(node => node.hidden && [2, 5, 6].includes(node.type));
  return Math.min(5, ...meaningful.map(node => distance.get(key(node))));
}

// Pure transitions let the service persist terminal outcomes before committing
// the last hit. The engine deliberately leaves GAME_WON/GAME_LOST to settlement.
function step(input, action) {
  const board = structuredClone(input);
  const events = [];
  const emit = (eventID, eventData) => events.push({eventID, eventData});
  const result = changed => ({board, events, outcome: board.outcome, changed});
  const ack = changed => { emit(C.EVENT_ACK, {}); return result(changed); };
  if (!action || board.outcome || board.virusCoherence <= 0) return ack(false);
  const pending = board.pendingUtilityClick;
  board.pendingUtilityClick = null;
  if (pending && action.kind === "click" && validCoord(action.coord) &&
      pending.join(",") === action.coord.join(",")) return ack(true);
  const hadPending = pending !== null && pending !== undefined;
  const tile = validCoord(action.coord)
    ? board.tiles.find(node => key(node) === action.coord.join(",")) : null;
  const remove = index => {
    board.inventory[index] = emptySlot(index);
    // Observed nesting consumed by hackingUISvc's UE_REMOVED branch.
    emit(C.EVENT_UE_REMOVED, {index, inventory: {inventory: publicInventory(board)}});
  };
  const refreshStrength = () => {
    const suppressors = board.tiles.filter(node => activeDefense(node) && node.subtype === 102).length;
    const strength = suppressors
      ? Math.max(Math.min(10, board.baseVirusStrength), board.baseVirusStrength - 15 * suppressors)
      : board.baseVirusStrength;
    if (strength !== board.virusStrength) {
      board.virusStrength = strength;
      emit(C.EVENT_HONEYPOT_STRENGTH, {virus: virus(board)});
    }
  };
  const kill = target => {
    const isCore = target.type === 2;
    Object.assign(target, {type: 0, subtype: -1, coherence: 0, strength: 0});
    emit(C.EVENT_OBJECT_KILLED, publicTile(target));
    if (isCore) board.outcome = "won";
    refreshStrength();
  };
  const lose = () => {
    emit(C.EVENT_OBJECT_KILLED, virus(board));
    board.outcome = "lost";
  };
  const counterattack = target => {
    const shieldIndex = board.inventory.findIndex(slot => slot.subtype === 3 &&
      slot.isInUse && slot.durationRemaining > 0);
    if (shieldIndex >= 0 && target.strength > 0) {
      const slot = board.inventory[shieldIndex];
      slot.durationRemaining--;
      emit(C.EVENT_POLYMORPHICSHIELDHIT,
        {index: shieldIndex, durationRemaining: slot.durationRemaining});
      if (slot.durationRemaining === 0) remove(shieldIndex);
    } else {
      board.virusCoherence = Math.max(0, board.virusCoherence - target.strength);
    }
    // Native constants expose this defense without recovering its server rule.
    // Authored policy: a surviving disruptor consumes one random inactive utility
    // when it retaliates. It cannot silently erase running vector/repair effects.
    if (target.subtype === 104) {
      const available = board.inventory.map((slot, index) => ({slot, index}))
        .filter(({slot}) => slot.subtype !== -1 && !slot.isInUse);
      if (available.length) remove(choose(board, available).index);
    }
  };

  if (action.kind === "click") {
    if (!accessible(board, tile)) return ack(hadPending);
    if (tile.hidden) {
      tile.hidden = false;
      emit(C.EVENT_TILE_FLIPPED, publicTile(tile));
      if (tile.type === 0) emit(C.EVENT_DISTANCEINDICATOR,
        {coord: tuple(tile.coord.items), distanceIndicator: clue(board, tile)});
      refreshStrength();
    } else if (tile.type === 6) {
      const contents = tile.cacheContents;
      if (!contents) return ack(hadPending);
      if (contents.type === 5) {
        Object.assign(tile, {type: 5, subtype: contents.subtype,
          utility: {subtype: contents.subtype, amount: contents.amount, duration: contents.duration}});
      } else {
        Object.assign(tile, contents);
      }
      delete tile.cacheContents;
      emit(C.EVENT_DATACACHE_OPEN, publicTile(tile));
      refreshStrength();
    } else if (tile.type === 5) {
      const index = board.inventory.findIndex(slot => slot.subtype === -1);
      if (index < 0 || !tile.utility) return ack(hadPending);
      const content = tile.utility;
      board.inventory[index] = {id: tile.id, subtype: content.subtype, info: content.amount,
        amount: content.amount, duration: content.duration, isInUse: false,
        durationRemaining: content.duration, totalDuration: content.duration};
      Object.assign(tile, {type: 0, subtype: -1, coherence: 0, strength: 0});
      delete tile.utility;
      emit(C.EVENT_UE_PICKEDUP, {coord: tuple(tile.coord.items),
        replacementObject: publicTile(tile), inventory: publicInventory(board)});
    } else if (tile.type === 2 || tile.type === 3) {
      tile.coherence = Math.max(0, tile.coherence - board.virusStrength);
      if (tile.coherence > 0) counterattack(tile);
      emit(C.EVENT_ATTACK, {attackerResult: virus(board), defenderResult: publicTile(tile)});
      if (tile.coherence === 0) kill(tile);
      else if (board.virusCoherence === 0) lose();
    } else {
      return ack(hadPending);
    }
  } else if (action.kind === "utility" || action.kind === "virusUtility") {
    if (typeof action.index !== "number" || !Number.isInteger(action.index) ||
        action.index < 0 || action.index >= board.inventory.length) return ack(hadPending);
    const slot = board.inventory[action.index];
    if (!slot || slot.subtype === -1 || slot.isInUse) return ack(hadPending);
    if (action.kind === "utility") {
      if (![1, 2].includes(slot.subtype) || !accessible(board, tile) || tile.hidden ||
          ![2, 3].includes(tile.type) || tile.coherence <= 0) return ack(hadPending);
      board.pendingUtilityClick = [...action.coord];
      if (slot.subtype === 1) {
        tile.coherence = Math.ceil(tile.coherence / 2);
        emit(C.EVENT_KERNALROT, publicTile(tile));
        remove(action.index);
      } else {
        slot.isInUse = true;
        slot.durationRemaining = slot.duration || 3;
        slot.targetCoord = [...action.coord];
        emit(C.EVENT_UE_INUSE, {index: action.index, value: true});
      }
    } else {
      if (![0, 3].includes(slot.subtype)) return ack(hadPending);
      slot.isInUse = true;
      slot.durationRemaining = slot.duration || (slot.subtype === 3 ? 2 : 3);
      emit(C.EVENT_UE_INUSE, {index: action.index, value: true});
    }
  } else {
    return ack(hadPending);
  }

  board.turn++;
  // A charge fires on activation and after subsequent valid actions, never on
  // ACK/no-op requests or the native utility's trailing ClickedOnTile RPC.
  // Combat death/win is final before repair ticks; repairs cannot revive a virus.
  if (!board.outcome) {
    for (let index = 0; index < board.inventory.length; index++) {
      const slot = board.inventory[index];
      if (!slot.isInUse || ![0, 2].includes(slot.subtype)) continue;
      if (slot.subtype === 0) {
        // Coherence has no maximum; self repair remains useful at initial HP.
        board.virusCoherence += slot.amount || slot.info || 5;
        slot.durationRemaining--;
        emit(C.EVENT_SELFREPAIR,
          {index, durationRemaining: slot.durationRemaining, target: virus(board)});
      } else {
        const target = board.tiles.find(node => key(node) === slot.targetCoord.join(","));
        if (!target || ![2, 3].includes(target.type) || target.coherence <= 0) {
          remove(index);
          continue;
        }
        target.coherence = Math.max(0, target.coherence - (slot.amount || slot.info || 20));
        slot.durationRemaining--;
        emit(C.EVENT_SECONDARYVECTOR,
          {index, durationRemaining: slot.durationRemaining, ...publicTile(target)});
        if (target.coherence === 0) kill(target);
      }
      const vectorTargetGone = slot.subtype === 2 && board.tiles.every(node =>
        key(node) !== slot.targetCoord.join(",") || ![2, 3].includes(node.type));
      if (slot.durationRemaining === 0 || board.outcome || vectorTargetGone) remove(index);
      if (board.outcome) break;
    }
    if (!board.outcome) {
      for (const source of board.tiles.filter(node => activeDefense(node) && node.subtype === 103)) {
        const targets = board.tiles.filter(node => node !== source && activeDefense(node));
        if (!targets.length) continue;
        const target = choose(board, targets);
        target.coherence += 20;
        emit(C.EVENT_HONEYPOT_HEALING, {coord: tuple(source.coord.items),
          healedObject: publicTile(target), healingAmount: 20});
      }
    }
  }
  for (const node of board.tiles) {
    const blocked = isBlocked(board.tiles, node);
    if (blocked !== node.blocked) {
      node.blocked = blocked;
      emit(C.EVENT_TILE_BLOCKED, publicTile(node));
    }
  }
  return result(true);
}

module.exports = {create, step, publicTile, publicInventory, initialInventory,
  profiles, constants, neighbours, distances, canReveal, resolveHackingDifficultyTier};
