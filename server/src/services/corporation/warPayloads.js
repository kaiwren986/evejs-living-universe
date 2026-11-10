"use strict";

const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
} = require("../_shared/serviceHelpers");

function buildAllyPayload(ally = {}) {
  return buildKeyVal([
    ["allyID", Number(ally.allyID || 0)],
    ["timeStarted", buildFiletimeLong(ally.timeStarted || 0)],
    ["timeFinished", ally.timeFinished ? buildFiletimeLong(ally.timeFinished) : null],
  ]);
}

// The client constructs evewar.util.War from both live notifications and RPC
// results. Keep their required attributes and wire types in one place.
function buildWarSnapshot(war = null) {
  if (!war) {
    return null;
  }
  const allies = Object.entries(war.allies || {});
  const warHQ = war.warHQID || war.warHQ || null;
  return {
    warID: Number(war.warID || 0),
    declaredByID: Number(war.declaredByID || 0),
    againstID: Number(war.againstID || 0),
    warHQID: warHQ,
    warHQ,
    timeDeclared: buildFiletimeLong(war.timeDeclared || 0),
    timeStarted: buildFiletimeLong(war.timeStarted || 0),
    timeFinished: war.timeFinished ? buildFiletimeLong(war.timeFinished) : null,
    retracted: war.retracted ? buildFiletimeLong(war.retracted) : null,
    retractedBy: war.retractedBy || null,
    billID: war.billID || null,
    mutual: Number(war.mutual || 0),
    openForAllies: Number(war.openForAllies || 0),
    canBeRetracted: war.timeFinished || war.retracted ? 0 : 1,
    reasonEnded: Number(war.reasonEnded ?? war.endReason ?? 0),
    reasonStarted: Number(war.reasonStarted || 0),
    noOfAllies: allies.length,
    createdFromWarID: war.createdFromWarID || null,
    reward: Number(war.reward || 0),
    allies: buildDict(allies.map(([allyID, ally]) => [
      Number(allyID),
      buildAllyPayload({ ...(ally || {}), allyID: Number(allyID) }),
    ])),
  };
}

function buildWarPayload(war = null) {
  const snapshot = buildWarSnapshot(war);
  return snapshot ? buildKeyVal(Object.entries(snapshot)) : null;
}

module.exports = { buildAllyPayload, buildWarPayload, buildWarSnapshot };
