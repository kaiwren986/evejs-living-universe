"use strict";
// April rules with explicitly authored populations, timing and reward quantities.
// Keep policy pure so downtime and duplicate destruction can be tested without a scene.
const SPACE_SUPERIORITY_TYPES = new Set([40358,40359,40360,40361,40552,40553,40554,40555,83585,83586,83587,83589]);
const CAPITAL_GROUPS = new Set([547,485,659,30,1538]);
const SHIP_RAMPANCY = new Map([
  [25,1],[324,1],[830,1],[831,1],[834,1],[893,1],[1527,1],
  [420,1],[541,1],[1305,1],[1534,1], [26,1],[832,2],[833,2],[894,2],[906,2],
  [419,2],[1201,2],[540,3],[963,4],[27,6],[898,8],[900,12],
  [1538,36],[547,72],[485,72],[659,72],[30,72],
]);
const NPCS = [91873,91875,91878,91881,91883,91899];
const BONUS_WAVES = new Set([5,10,15,25,35,45,65,85]);
function rampancy(ship) { return SHIP_RAMPANCY.get(Number(ship.groupID)) || 0; }
function initial(tier) {
  return { version:1, phase:"idle", tier, wave:0, rampancy:0, capital:false,
    loot:0, hybrids:{}, slots:[], kills:{}, buffs:{}, bonus:null, unstableAt:null, deadline:null };
}
function startWave(state, ships) {
  const wave = state.wave + 1;
  const capital = ships.some(ship => CAPITAL_GROUPS.has(Number(ship.groupID)));
  const pressure = state.rampancy + ships.reduce((sum,ship) => sum+rampancy(ship),0);
  const threat = pressure >= 72 ? 3 : pressure >= 36 ? 2 : pressure >= 12 ? 1 : 0;
  const count = Math.min(30,3 + Math.floor(wave/4) + threat*2 + (capital ? 8 : 0));
  const pool = wave < 4 && !threat ? NPCS.slice(0,2) : wave < 8 && threat < 2 ? NPCS.slice(0,4) : NPCS;
  return {...state, phase:"wave", wave, rampancy:pressure, capital, deadline:null,
    bonus:BONUS_WAVES.has(wave) ? { wave, chosen:null } : null,
    slots:Array.from({length:count},(_,i) => ({key:`${wave}:${i}`,typeID:pool[(wave+i)%pool.length]})) };
}
function advance(state, ships, now) {
  if (["cashed","failed"].includes(state.phase)) return state;
  if (!ships.length) {
    if (state.phase === "idle") return state;
    const unstableAt = state.unstableAt ?? now;
    return {...state,unstableAt, ...(now-unstableAt >= 30000 ? {phase:"failed",loot:0,hybrids:{},bonus:null} : {})};
  }
  state = {...state,unstableAt:null};
  if (state.phase === "idle" || (state.phase === "break" && now >= state.deadline && state.wave < 100)) return startWave(state,ships);
  return state;
}
function kill(state,key,receipt,now) {
  if (state.phase !== "wave" || !state.slots.some(slot => slot.key === key) || state.kills[key]) return state;
  const next = {...state,kills:{...state.kills,[key]:receipt}};
  if (next.slots.every(slot => next.kills[slot.key])) {
    const amount = (state.tier+1)*Math.max(1,Math.ceil(state.wave/3))*(state.capital ? 4 : 1);
    const hybrids = {...state.hybrids};
    // Authored replay distribution: a hybrid drone every fifth completed wave.
    if (state.wave % 5 === 0) {
      const typeID = 92033 + ((state.wave/5-1)%3)*3 + state.tier;
      hybrids[typeID] = (hybrids[typeID] || 0)+(state.capital ? 4 : 1);
    }
    return {...next,phase:"break",deadline:now+20000,loot:state.loot+amount,hybrids,bonus:null};
  }
  return next;
}
function cashOut(state,now) {
  return state.phase === "break" && (state.wave === 100 || now < state.deadline)
    ? {...state,phase:"cashed",bonus:null} : state;
}
function damageScale(state,targetGroup) {
  const regional = [0.7,1,1.3][state.tier] || 1;
  return regional * (CAPITAL_GROUPS.has(Number(targetGroup)) ? Number(targetGroup) === 547 ? 1.5 : 2 : 1);
}
module.exports = { initial, advance, kill, cashOut, rampancy, damageScale, SPACE_SUPERIORITY_TYPES, CAPITAL_GROUPS, NPCS };
