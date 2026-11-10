"use strict";

// Authored Depot difficulty, within the native client's 10 x 9 hex layout.
// Numeric tile/event identifiers are from hackingcommon.hackingConstants.
const { randomInt } = require("node:crypto");
const key = tile => tile.coord.items.join(",");
function neighbours(tiles, tile) {
  const [x, y] = tile.coord.items;
  const offsets = y % 2
    ? [[0,-1],[1,-1],[-1,0],[1,0],[0,1],[1,1]]
    : [[-1,-1],[0,-1],[-1,0],[1,0],[-1,1],[0,1]];
  const keys = new Set(offsets.map(([dx,dy]) => `${x+dx},${y+dy}`));
  return tiles.filter(t => keys.has(key(t)));
}
function distances(tiles, start) {
  const result = new Map([[key(start), 0]]), queue = [start];
  for (let i=0; i<queue.length; i++) {
    for (const tile of neighbours(tiles, queue[i])) {
      if (result.has(key(tile))) continue;
      result.set(key(tile), result.get(key(queue[i]))+1);
      queue.push(tile);
    }
  }
  return result;
}
function create(typeID, seed = randomInt(0x100000000)) {
  const hard = Number(typeID) === 92145;
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525)+1013904223) >>> 0;
    return state / 0x100000000;
  };
  const width = hard ? 10 : 9, height = hard ? 9 : 7;
  let tiles = [];
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    tiles.push({id:tiles.length+1, type:0, subtype:-1, coord:{type:"tuple",items:[x,y]},
      hidden:true, blocked:false, strength:0, coherence:0});
  }
  const start = tiles[Math.floor(random()*height)*width];
  start.hidden = false;
  // Remove holes only when every surviving node remains reachable.
  for (let i=0; i<(hard ? 12 : 8); i++) {
    const candidate = tiles[Math.floor(random()*tiles.length)];
    if (candidate === start) continue;
    const remaining = tiles.filter(t => t !== candidate);
    if (distances(remaining,start).size === remaining.length) tiles = remaining;
  }
  const distance = distances(tiles,start);
  const farthest = Math.max(...distance.values());
  const far = tiles.filter(t => distance.get(key(t)) >= farthest-1);
  const core = far[Math.floor(random()*far.length)];
  Object.assign(core,{type:2,subtype:hard ? 10 : 11,coherence:hard ? 90 : 70,strength:hard ? 20 : 10});
  const candidates = tiles.filter(t => t !== core && distance.get(key(t)) > 1);
  for (let i=0; i<(hard ? 13 : 7); i++) {
    const index = Math.floor(random()*candidates.length);
    const [tile] = candidates.splice(index,1);
    const antivirus = i % 3 === 0;
    Object.assign(tile,{type:3,subtype:antivirus ? 100 : 101,
      coherence:antivirus ? (hard ? 50 : 30) : (hard ? 80 : 50),
      strength:antivirus ? (hard ? 30 : 20) : (hard ? 15 : 10)});
  }
  return tiles;
}
function publicTile(tile) {
  const copy = structuredClone(tile);
  if (copy.hidden) Object.assign(copy,{type:-1,subtype:-1,strength:0,coherence:0});
  return copy;
}
function canReveal(tiles,tile) {
  const adjacent = neighbours(tiles,tile);
  return adjacent.some(t => !t.hidden && t.type === 0) &&
    !adjacent.some(t => !t.hidden && t.type === 3 && t.coherence > 0);
}
// Pure transition: persistence of a win can fail without consuming the last hit.
function step(attempt, coord) {
  const tiles = structuredClone(attempt.tiles);
  const tile = tiles.find(t => key(t) === coord.join(","));
  const events = [];
  const emit = (eventID,eventData) => events.push({eventID,eventData});
  let virusCoherence = attempt.virusCoherence, outcome = null;
  if (!tile || (tile.hidden && !canReveal(tiles,tile)) || (!tile.hidden && tile.type === 0)) {
    return {tiles,virusCoherence,outcome,events:[{eventID:6,eventData:{}}]};
  }
  if (tile.hidden) {
    tile.hidden = false;
    emit(100,publicTile(tile));
    if (tile.type === 0) {
      const core = tiles.find(t => t.type === 2);
      emit(308,{coord:tile.coord,distanceIndicator:Math.min(5,distances(tiles,tile).get(key(core)))});
    }
  } else if (tile.type === 2 || tile.type === 3) {
    tile.coherence = Math.max(0,tile.coherence-attempt.virusStrength);
    if (tile.coherence > 0) virusCoherence = Math.max(0,virusCoherence-tile.strength);
    const virus = {id:attempt.virusID,type:1,strength:attempt.virusStrength,coherence:virusCoherence};
    emit(301,{attackerResult:virus,defenderResult:publicTile(tile)});
    if (tile.coherence === 0) {
      if (tile.type === 2) outcome = "won";
      else Object.assign(tile,{type:0,subtype:-1,strength:0});
      emit(4,publicTile(tile));
    } else if (virusCoherence === 0) {
      emit(4,virus);
      outcome = "lost";
    }
  }
  for (const node of tiles) {
    const blocked = node.hidden && neighbours(tiles,node).some(t => !t.hidden && t.type === 3 && t.coherence > 0);
    if (blocked !== node.blocked) {
      node.blocked = blocked;
      emit(102,publicTile(node));
    }
  }
  return {tiles,virusCoherence,outcome,events};
}
module.exports = {create,step,publicTile,neighbours,distances,canReveal};
