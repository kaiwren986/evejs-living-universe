"use strict";

// Compatibility for stores extracted before bounds were retained. These are
// relationships in CCP's public SDE 3396210, not fixed limits: the referenced
// attribute still resolves on the fitted item, then falls back to its default.
const maximum = {
  18: 482,
  37: 2033,
  76: 797,
  109: 2770,
  110: 2769,
  111: 2771,
  113: 2768,
  264: 263,
  267: 1527,
  268: 1527,
  269: 1527,
  270: 1527,
  271: 1528,
  272: 1528,
  273: 1528,
  274: 1528,
  974: 1529,
  975: 1529,
  976: 1529,
  977: 1529,
  2621: 2623,
  2622: 2624,
  5727: 5732,
  5731: 5732,
  5734: 5732,
  5743: 5732,
  5744: 5732,
  5967: 5968,
  5979: 5985,
};
const minimum = {
  20: 2266,
  309: 6205,
  349: 6205,
  351: 6205,
  566: 6205,
  767: 6205,
  5967: 2623,
  5969: 2623,
};

module.exports = { maximum, minimum };
