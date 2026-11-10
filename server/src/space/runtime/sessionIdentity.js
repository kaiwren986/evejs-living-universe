"use strict";

module.exports = {
  sessionMatchesIdentity,
};

// Whether two session references are the same client: the same object, or two
// objects carrying the same positive clientID.
function sessionMatchesIdentity(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const leftClientID = Number(left.clientID ?? left.clientId ?? 0);
  const rightClientID = Number(right.clientID ?? right.clientId ?? 0);
  return leftClientID > 0 && rightClientID > 0 && leftClientID === rightClientID;
}
