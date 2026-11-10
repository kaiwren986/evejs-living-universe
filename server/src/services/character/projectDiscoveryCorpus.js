"use strict";

// Adapted from Locksmith's Project Discovery — Coffee Edition (AGPL-3.0).
// Authored New Eden research tasks, not MMOS scientific submissions. The version
// pins both the plotted population and its scoring contours across restarts.
// All five IDs are requested by the unmodified mcgill-polyseg tutorial client.
const zlib = require("node:zlib");
const VERSION = 1;
const REGULAR_COUNT = 64;
const SIZE = 768;
const PREFIX = "/project-discovery/samples/corpus-v1/";
const TUTORIALS = Object.freeze({
  "ed134308-e080-49bc-be56-169a5f839c96": 2,
  "be362d8b-4ff4-448b-877f-23b8c2cb4fe0": 3,
  "eb4c6403-e878-43cf-a009-9c8c566ae90f": 3,
  "21cbef0c-684e-4a4c-b1fe-be6e24d894c2": 5,
  "ff9f9a21-954b-4c1c-9a54-16b21cf17670": 4,
});
const tutorialIDs = Object.keys(TUTORIALS);
const pngCache = new Map();
function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function definition(key) {
  const tutorialIndex = tutorialIDs.indexOf(key);
  const match = /^cell-(\d{2})$/.exec(key);
  const index = match ? Number(match[1]) : -1;
  if (tutorialIndex < 0 && (index < 0 || index >= REGULAR_COUNT)) return null;
  const seed = tutorialIndex >= 0 ? 7001 + tutorialIndex * 113 : 11003 + index * 977;
  const random = rng(seed);
  const count = tutorialIndex >= 0 ? TUTORIALS[key] : 2 + index % 5;
  const clusters = [];
  for (let i = 0; i < count; i++) {
    let chosen = null;
    for (let attempt = 0; attempt < 256; attempt++) {
      const scale = count <= 3 ? 1.2 : 1;
      const rx = (.045 + random() * .055) * scale;
      const ry = (.045 + random() * .065) * scale;
      const radius = Math.max(rx, ry) * 1.32;
      const cx = radius + .025 + random() * (1 - 2 * radius - .05);
      const cy = radius + .025 + random() * (1 - 2 * radius - .05);
      if (clusters.some(c => Math.hypot(c.cx-cx,c.cy-cy) < c.radius+radius+.018)) continue;
      const rotation = random() * Math.PI;
      const bend = (random()-.5)*.34, lobe = (random()-.5)*.24;
      const phase = random()*Math.PI*2;
      const spread = .24+random()*.13, population = 7000+Math.floor(random()*15000);
      chosen = {cx,cy,rx,ry,radius,rotation,bend,lobe,phase,spread,population};
      break;
    }
    // Finite authored seeds must fit; never serve a plot with missing labels.
    if (!chosen) throw new Error("DISCOVERY_CORPUS_LAYOUT");
    chosen.vertices=Array.from({length:24},(_,j)=>clusterPoint(chosen,j*Math.PI/12,1));
    clusters.push(chosen);
  }
  return {key, seed, tutorial: tutorialIndex >= 0, clusters};
}
function clusterPoint(cluster, angle, radius) {
  const c=cluster;
  // Asymmetric and gently lobed boundaries vary the populations without
  // overlapping their conservative placement discs.
  const edge=1+c.bend*Math.cos(angle-c.phase)+c.lobe*Math.cos(3*angle+c.phase);
  const a=Math.cos(angle)*c.rx*edge*radius,b=Math.sin(angle)*c.ry*edge*radius;
  return [c.cx+a*Math.cos(c.rotation)-b*Math.sin(c.rotation),c.cy+a*Math.sin(c.rotation)+b*Math.cos(c.rotation)];
}
function regularKey(characterID, sequence) {
  return `cell-${String((characterID % REGULAR_COUNT + sequence - 1) % REGULAR_COUNT).padStart(2, "0")}`;
}
function unpack(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value && value.type === "dict" && Array.isArray(value.entries)) return Object.fromEntries(value.entries);
  if (value && (value.type === "list" || value.type === "tuple") && Array.isArray(value.items)) return value.items;
  return value;
}
function cross(a, b, c) { return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]); }
function onSegment(a, b, p) {
  return Math.abs(cross(a,b,p)) < 1e-10 && p[0] >= Math.min(a[0],b[0])-1e-10 && p[0] <= Math.max(a[0],b[0])+1e-10 && p[1] >= Math.min(a[1],b[1])-1e-10 && p[1] <= Math.max(a[1],b[1])+1e-10;
}
function intersects(a,b,c,d) {
  const ab1=cross(a,b,c), ab2=cross(a,b,d), cd1=cross(c,d,a), cd2=cross(c,d,b);
  return (ab1*ab2 < 0 && cd1*cd2 < 0) || onSegment(a,b,c) || onSegment(a,b,d) || onSegment(c,d,a) || onSegment(c,d,b);
}
function inside(point, polygon) {
  let hit = false;
  for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
    const a=polygon[i],b=polygon[j];
    if ((a[1]>point[1]) !== (b[1]>point[1]) && point[0] < (b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]) hit=!hit;
  }
  return hit;
}
function normalizePolygons(raw) {
  const rows=unpack(raw);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 8) throw new Error("DISCOVERY_POLYGON_COUNT");
  return rows.map(row => {
    const vertices=unpack(unpack(row)?.vertices);
    if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 64) throw new Error("DISCOVERY_VERTEX_COUNT");
    const points=vertices.map(value => {
      const p=unpack(value);
      if (!Array.isArray(p) || p.length !== 2 || p.some(n=>typeof n !== "number" || !Number.isFinite(n) || n<0 || n>1)) throw new Error("DISCOVERY_VERTEX_INVALID");
      return p.slice();
    });
    // Some client shapes explicitly close their final vertex.
    if (points.length>3 && points[0][0]===points.at(-1)[0] && points[0][1]===points.at(-1)[1]) points.pop();
    return points;
  });
}
function validatePolygons(raw) {
  const polygons=normalizePolygons(raw).map(points => {
    let area=0;
    for(let i=0;i<points.length;i++) {
      const a=points[i],b=points[(i+1)%points.length];
      if(a[0]===b[0] && a[1]===b[1]) throw new Error("DISCOVERY_DUPLICATE_VERTEX");
      area+=a[0]*b[1]-b[0]*a[1];
      for(let j=i+1;j<points.length;j++) {
        if(j===i+1 || (i===0 && j===points.length-1)) continue;
        if(intersects(a,b,points[j],points[(j+1)%points.length])) throw new Error("DISCOVERY_POLYGON_CROSSES");
      }
    }
    if(Math.abs(area)<1e-6) throw new Error("DISCOVERY_POLYGON_EMPTY");
    return points;
  });
  for(let i=0;i<polygons.length;i++) for(let j=i+1;j<polygons.length;j++) {
    const a=polygons[i],b=polygons[j];
    if(inside(a[0],b) || inside(b[0],a)) throw new Error("DISCOVERY_POLYGONS_OVERLAP");
    for(let k=0;k<a.length;k++) for(let l=0;l<b.length;l++)
      if(intersects(a[k],a[(k+1)%a.length],b[l],b[(l+1)%b.length])) throw new Error("DISCOVERY_POLYGONS_OVERLAP");
  }
  return polygons;
}
function score(key, polygons) {
  const task=definition(key);
  if(!task) throw new Error("DISCOVERY_TASK_UNKNOWN");
  // Deterministic area IoU with one-to-one cluster matching. A whole-image gate
  // or duplicate gate cannot claim every cluster; extra/missing gates cost score.
  const masks=[...task.clusters.map(c=>c.vertices),...polygons].map(p=>{
    const mask=new Uint8Array(64*64);
    for(let y=0;y<64;y++) for(let x=0;x<64;x++) mask[y*64+x]=inside([(x+.5)/64,(y+.5)/64],p)?1:0;
    return mask;
  });
  const n=task.clusters.length;
  const weights=task.clusters.map((_,i)=>polygons.map((__,j)=>{
    let intersection=0,union=0;
    for(let p=0;p<4096;p++) {intersection+=masks[i][p]&masks[n+j][p];union+=masks[i][p]|masks[n+j][p];}
    return union ? intersection/union : 0;
  }));
  let states=new Map([[0,0]]);
  for(const row of weights) {
    const next=new Map(states);
    for(const [mask,total] of states) for(let j=0;j<polygons.length;j++) if(!(mask&(1<<j))) {
      const bit=mask|(1<<j);next.set(bit,Math.max(next.get(bit)||0,total+row[j]));
    }
    states=next;
  }
  const result = Math.round(Math.max(...states.values())/Math.max(n,polygons.length)*1e6)/1e6;
  return n === polygons.length ? result : Math.min(0.49, result);
}
function solution(key) {
  // The native DrawingArea.inject_polygon uses Polygon's default ten-vertex
  // limit. Its add_point closes at ten and silently discards later points.
  // Sample the complete contour into eight vertices instead of sending the
  // 24-point scoring boundary, which the client renders as a truncated wedge.
  // Keep the authored plot and scoring boundary unchanged for pending tasks.
  return {clusters: definition(key).clusters.map(c=>({polygons:[{
    densityLevel:0,vertices:c.vertices.filter((_,index)=>index%3===0),
  }]}))};
}
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data) {
  const name=Buffer.from(type),out=Buffer.alloc(data.length+12);
  out.writeUInt32BE(data.length,0);name.copy(out,4);data.copy(out,8);
  let crc=0xffffffff;for(const b of Buffer.concat([name,data])) crc=crcTable[(crc^b)&255]^(crc>>>8);
  out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
}
function visitPoints(key, visit) {
  const task=definition(key);if(!task)return null;
  const random=rng(task.seed^0xa153cab);
  for(const c of task.clusters) for(let i=0;i<c.population;i++) {
    const angle=random()*Math.PI*2;
    const radius=Math.sqrt(-2*Math.log(Math.max(1e-12,random())))*c.spread;
    if(radius>1.06)continue;
    const point=clusterPoint(c,angle,radius);
    if(point.every(n=>n>=0&&n<=1))visit(point);
  }
  // Sparse background events retain the native cytometry presentation. They
  // are deliberately not separate scoring populations.
  for(let i=0;i<600+Math.floor(random()*900);i++) {
    visit([random(),random()]);
  }
  return true;
}
function getPoints(key) {
  const points=[];
  return visitPoints(key, point=>points.push(point)) ? points : null;
}
function renderPng(key) {
  if(pngCache.has(key)) {const png=pngCache.get(key);pngCache.delete(key);pngCache.set(key,png);return png;}
  const density=new Uint16Array(SIZE*SIZE);
  if(!visitPoints(key, point=>{
    const x=Math.round(point[0]*(SIZE-1)),y=Math.round((1-point[1])*(SIZE-1));
    density[y*SIZE+x]++;
  }))return null;
  const scan=Buffer.alloc((SIZE*3+1)*SIZE);
  const palette=[[0,60,150],[0,140,235],[0,220,235],[80,245,110],[230,240,0],[255,130,0],[245,0,0]];
  for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++) {
    if(!density[y*SIZE+x])continue;
    let nearby=0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++) {
      const px=x+dx,py=y+dy;
      if(px>=0&&px<SIZE&&py>=0&&py<SIZE)nearby+=density[py*SIZE+px];
    }
    const level=Math.min(6,Math.max(0,(nearby-1)/50));
    const lo=Math.floor(level),hi=Math.min(6,lo+1),mix=level-lo;
    const offset=y*(SIZE*3+1)+1+x*3;
    for(let channel=0;channel<3;channel++)scan[offset+channel]=Math.round(palette[lo][channel]*(1-mix)+palette[hi][channel]*mix);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(SIZE,0);header.writeUInt32BE(SIZE,4);header[8]=8;header[9]=2;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",zlib.deflateSync(scan,{level:6})),chunk("IEND",Buffer.alloc(0))]);
  pngCache.set(key,png);while(pngCache.size>8)pngCache.delete(pngCache.keys().next().value);
  return png;
}
module.exports={VERSION,REGULAR_COUNT,SIZE,PREFIX,TUTORIALS,definition,regularKey,unpack,normalizePolygons,validatePolygons,score,solution,getPoints,renderPng};
