"use strict";
const GALLENTE = 500004;
const CALDARI = 500001;
const CAPTURE_MS = 15 * 60 * 1000;
const RADIUS = 30000;
// Two explicit offline replay placements, not a claim about live occupation.
const SYSTEMS = Object.freeze({
  30004980: { name: "Fliet", occupier: GALLENTE, initialVP: 37500 },
  30004979: { name: "Heydieles", occupier: CALDARI, initialVP: 37500 },
});
const ISSUERS = Object.freeze({ [GALLENTE]: 1000181, [CALDARI]: 1000180 });
function advance(progress, faction, elapsedMs) {
  if (![GALLENTE,CALDARI].includes(faction)) return progress;
  return Math.max(-CAPTURE_MS,Math.min(CAPTURE_MS,progress+(faction===GALLENTE ? 1 : -1)*Math.max(0,elapsedMs)));
}
function reward(faction,system,count) {
  // Authored Command Operations placement: no frontline/suppression multiplier.
  const base = faction===system.occupier && system.score===0 ? 0 : 30000;
  return Math.floor(base*Math.min(5,count)/Math.max(1,count));
}
module.exports={GALLENTE,CALDARI,CAPTURE_MS,RADIUS,SYSTEMS,ISSUERS,advance,reward};
