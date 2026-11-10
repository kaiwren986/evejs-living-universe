"use strict";

// EveJS-authored geometry exercises. These are neither patient data nor MMOS
// consensus. Coordinates use the native COVID project's bottom-left origin.
const zlib = require("node:zlib");
const PREFIX = "/project-discovery/samples/v1/";
const WIDTH = 512;
const boxes = [
  [[0.25, 0.3, 0.65, 0.7]],
  [[0.12, 0.15, 0.38, 0.42], [0.6, 0.58, 0.87, 0.85]],
  [[0.1, 0.15, 0.31, 0.4], [0.4, 0.58, 0.62, 0.85], [0.72, 0.2, 0.92, 0.46]],
  [[0.12, 0.6, 0.35, 0.83], [0.42, 0.15, 0.64, 0.4], [0.7, 0.6, 0.91, 0.86]],
  [[0.08, 0.12, 0.25, 0.32], [0.4, 0.1, 0.58, 0.3], [0.74, 0.15, 0.92, 0.36],
    [0.17, 0.63, 0.37, 0.85], [0.6, 0.62, 0.81, 0.86]],
  [[0.1, 0.14, 0.33, 0.38], [0.65, 0.12, 0.89, 0.37],
    [0.12, 0.65, 0.36, 0.89], [0.64, 0.62, 0.87, 0.86]],
];
const TUTORIAL_SAMPLES = Object.freeze({
  "ed134308-e080-49bc-be56-169a5f839c96": 2,
  "be362d8b-4ff4-448b-877f-23b8c2cb4fe0": 3,
  "eb4c6403-e878-43cf-a009-9c8c566ae90f": 4,
  "21cbef0c-684e-4a4c-b1fe-be6e24d894c2": 5,
  "ff9f9a21-954b-4c1c-9a54-16b21cf17670": 6,
});
function getSample(id) {
  if (!Number.isInteger(id) || id < 1 || id > boxes.length) return null;
  const polygons = boxes[id - 1].map(([x0, y0, x1, y1]) => ({
    vertices: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  }));
  const points = [];
  // Deterministic point clouds, dense at the centre, with an obvious boundary.
  for (let cluster = 0; cluster < boxes[id - 1].length; cluster++) {
    const [x0, y0, x1, y1] = boxes[id - 1][cluster];
    let seed = id * 7919 + cluster * 1297;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 1200; i++) {
      const x = (random() + random()) / 2;
      const y = (random() + random()) / 2;
      points.push([x0 + x * (x1 - x0), y0 + y * (y1 - y0)]);
    }
  }
  return { id, polygons, points, path: `${PREFIX}${id}.png` };
}

function inside([x, y], vertices) {
  let result = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [xi, yi] = vertices[i], [xj, yj] = vertices[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function intersects(a, b, c, d) {
  const on = (p, q, r) => Math.abs(cross(p, q, r)) < 1e-10 &&
    r[0] >= Math.min(p[0], q[0]) && r[0] <= Math.max(p[0], q[0]) &&
    r[1] >= Math.min(p[1], q[1]) && r[1] <= Math.max(p[1], q[1]);
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
    on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
function validatePolygons(polygons, skip = false) {
  if (!Array.isArray(polygons) || polygons.length > 8 || (!skip && !polygons.length)) return false;
  for (const polygon of polygons) {
    const v = polygon?.vertices;
    if (!Array.isArray(v) || v.length < 3 || v.length > 64 || v.some(p => !Array.isArray(p) || p.length !== 2 ||
      p.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1))) return false;
    let area = 0;
    for (let i = 0; i < v.length; i++) {
      const next = (i + 1) % v.length;
      if (v[i][0] === v[next][0] && v[i][1] === v[next][1]) return false;
      area += v[i][0] * v[next][1] - v[next][0] * v[i][1];
      for (let j = i + 2; j < v.length; j++) {
        if (i === 0 && j === v.length - 1) continue;
        if (intersects(v[i], v[next], v[j], v[(j + 1) % v.length])) return false;
      }
    }
    if (Math.abs(area) < 1e-6) return false;
  }
  for (let i = 0; i < polygons.length; i++) for (let j = i + 1; j < polygons.length; j++) {
    const a = polygons[i].vertices, b = polygons[j].vertices;
    if (inside(a[0], b) || inside(b[0], a)) return false;
    for (let x = 0; x < a.length; x++) for (let y = 0; y < b.length; y++) {
      if (intersects(a[x], a[(x + 1) % a.length], b[y], b[(y + 1) % b.length])) return false;
    }
  }
  return true;
}
function scorePolygons(sample, polygons) {
  // Match regions one-to-one using intersection over union on a fixed grid.
  // Count mismatch is penalized; drawing the entire image cannot pass.
  const masks = list => list.map(p => {
    const mask = new Set();
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      if (inside([(x + 0.5) / 64, (y + 0.5) / 64], p.vertices)) mask.add(y * 64 + x);
    }
    return mask;
  });
  const expected = masks(sample.polygons), actual = masks(polygons);
  const scores = expected.map(a => actual.map(b => {
    let intersection = 0;
    for (const p of a) if (b.has(p)) intersection++;
    return intersection / (a.size + b.size - intersection || 1);
  }));
  let states = new Map([[0, 0]]);
  for (const row of scores) {
    const next = new Map(states);
    for (const [mask, score] of states) for (let i = 0; i < actual.length; i++) {
      if (!(mask & (1 << i))) next.set(mask | (1 << i), Math.max(next.get(mask | (1 << i)) || 0, score + row[i]));
    }
    states = next;
  }
  const score = Math.round(Math.max(...states.values()) / Math.max(expected.length, actual.length) * 10000) / 10000;
  return expected.length === actual.length ? score : Math.min(0.49, score);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4), tail = Buffer.alloc(4);
  header.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, tail]);
}
const images = new Map();
function getSampleAsset(routePath) {
  if (typeof routePath === "string" && routePath.startsWith("/project-discovery/samples/corpus-v1/")) {
    const match = /^\/project-discovery\/samples\/corpus-v1\/([a-z0-9-]{1,40})\.png$/.exec(routePath);
    const buffer = match && require("./projectDiscoveryCorpus").renderPng(match[1]);
    return buffer ? { contentType: "image/png", buffer: Buffer.from(buffer) } : null;
  }
  if (typeof routePath !== "string" || !routePath.startsWith(PREFIX)) return null;
  const match = /^([1-6])\.png$/.exec(routePath.slice(PREFIX.length));
  if (!match) return null;
  const id = Number(match[1]);
  if (!images.has(id)) {
    const pixels = Buffer.alloc(WIDTH * WIDTH, 12);
    for (const [x, y] of getSample(id).points) {
      const index = Math.min(511, Math.floor((1 - y) * WIDTH)) * WIDTH + Math.min(511, Math.floor(x * WIDTH));
      pixels[index] = Math.min(255, pixels[index] + 95);
    }
    const raw = Buffer.alloc(WIDTH * (WIDTH + 1));
    for (let y = 0; y < WIDTH; y++) pixels.copy(raw, y * (WIDTH + 1) + 1, y * WIDTH, (y + 1) * WIDTH);
    const header = Buffer.alloc(13);
    header.writeUInt32BE(WIDTH, 0); header.writeUInt32BE(WIDTH, 4); header[8] = 8;
    images.set(id, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  }
  return { contentType: "image/png", buffer: Buffer.from(images.get(id)) };
}
module.exports = { getSample, getSampleAsset, validatePolygons, scorePolygons, TUTORIAL_SAMPLES, SAMPLE_COUNT: boxes.length };
