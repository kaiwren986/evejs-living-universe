"use strict";

// The most ISK one wallet may hold: a character's cash, or one corporation
// wallet division.
//
// Wallet money is a JavaScript double rounded to cents. Up to about 17.5
// trillion ISK every credit and debit keeps its exact cents; past that, sums
// start drifting by a cent. Far past it, a whole-number balance also overflows
// the int64 the marshaller encodes it as, which is how a character holding
// 1e26 ISK blanked the whole character select list. Ten trillion stays well
// inside the exact range.
const MAX_WALLET_BALANCE = 10_000_000_000_000;

module.exports = {
  MAX_WALLET_BALANCE,
};
