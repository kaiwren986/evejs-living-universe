"use strict";

// Reviewed build-3396210 login campaign 2360. Build 3475087 has the same track.
// Keep the 1-based login day order and the native per-reward terms.
const campaignID = 2360;
const version = 1;
const name = "Capsuleer Day XXIII: Warpath";
const retroClaim = true;

function reward(typeID, tier, injection = null, quantity = 1, redeemedExpiryDays = 30) {
  return { typeID, tier, quantity, redeemedExpiryDays, ...(injection ? { injection } : {}) };
}

const booster = (typeID, tier) => reward(typeID, tier, "booster");
const skin = typeID => reward(typeID, 3, "skin");
const component = (typeID, quantity = 1) => reward(typeID, 3, "component", quantity);

const alpha = [
  reward(93645, 1), reward(54650, 2), booster(93133, 1), skin(93734), booster(93066, 1),
  reward(52520, 2), booster(92955, 1), skin(93728), booster(93054, 1), reward(88134, 3),
  reward(63315, 2), booster(93098, 1), skin(93743), booster(92975, 1), reward(49756, 3),
  booster(93122, 1), reward(88133, 3), booster(93065, 1), reward(88134, 3), reward(93832, 3),
  skin(93739), reward(63824, 4), component(93357), booster(93139, 2), reward(88133, 3),
  component(93361), booster(93107, 2), reward(52520, 2), booster(93018, 2), component(93363),
  booster(93024, 2), booster(93778, 3), reward(93832, 3),
];

const omega = [
  reward(49809, 3), skin(93735), component(93357, 3), reward(73277, 2, null, 4000), skin(93727),
  booster(93135, 2), reward(49810, 4), booster(93068, 2), component(93361, 3), reward(73277, 3, null, 7500),
  skin(93740), booster(92976, 2), reward(63825, 4), skin(93744), booster(93020, 2),
  reward(93832, 3, null, 1, 0), reward(73277, 3, null, 15000), booster(93778, 3), reward(88133, 3), component(93363, 3),
  booster(93775, 3), reward(43680, 4), booster(93124, 2), reward(93832, 3), reward(88134, 3),
  booster(93102, 2), reward(93832, 3), booster(92973, 2), reward(88133, 3), booster(93059, 2),
  reward(93832, 3), reward(93783, 3), reward(73277, 3, null, 2000),
];

const days = alpha.map((reward, index) => ({ alpha: reward, omega: omega[index] }));

module.exports = { campaignID, version, name, retroClaim, days };
