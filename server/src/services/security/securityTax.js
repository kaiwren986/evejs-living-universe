"use strict";

// The Safe Security tax on agent mission ISK and NPC bounties: the rules only.
// CONCORD keeps a share of either payout earned in a system of the safe class,
// and nobody is credited it. Each payout path asks this module how much is
// withheld and writes it into its own journal description; nothing here
// touches a wallet.

const path = require("path");

const {
  toPositiveInt,
} = require(path.join(__dirname, "../../common/numbers"));
const worldData = require(path.join(__dirname, "../../space/worldData"));

// security/common/const.py.
const AGENT_MISSION_SECURITY_TAX_RATE = 0.2;
const NPC_BOUNTY_SECURITY_TAX_RATE = 0.2;
// eveuniverse/security.py SecurityClassFromLevel: a security of 0.95 or more
// is the safe class, read from the system's unrounded security.
const SAFE_SECURITY_CLASS_LEVEL = 0.95;
// appConst.agentTypeCareerAgent: the mission window shows the reduced payouts
// banner for any other agent (agentDialogueUtil.py, 380-388).
const CAREER_AGENT_TYPE_ID = 12;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// No system, and so no security to compare, is not the safe class.
function isSafeSecuritySolarSystem(solarSystemID) {
  const system = worldData.getSolarSystemByID(toPositiveInt(solarSystemID, 0));
  return Number(system && system.security) >= SAFE_SECURITY_CLASS_LEVEL;
}

function computeSecurityTax(rate, gross) {
  const amount = roundMoney(gross);
  const tax = roundMoney(amount * rate);
  return { gross: amount, tax, net: roundMoney(amount - tax) };
}

// A mission is taxed by where its agent is, not where the mission was run.
function computeAgentMissionSecurityTax(agentRecord, gross) {
  const taxed = Number(agentRecord && agentRecord.agentTypeID) !== CAREER_AGENT_TYPE_ID &&
    isSafeSecuritySolarSystem(agentRecord && agentRecord.solarSystemID);
  return computeSecurityTax(taxed ? AGENT_MISSION_SECURITY_TAX_RATE : 0, gross);
}

function computeNpcBountySecurityTax(solarSystemID, gross) {
  return computeSecurityTax(
    isSafeSecuritySolarSystem(solarSystemID) ? NPC_BOUNTY_SECURITY_TAX_RATE : 0,
    gross,
  );
}

// The client's GetDerivedTransactions yaml-parses a payout's description, and a
// positive securityTaxAmount beside the gross is what makes it draw CONCORD's
// tax row (195 for a bounty, 197 for a mission) and set the payout row to the
// gross. grossKey is grossRewardAmount for a mission, grossBountyAmount for a
// bounty. Alone it is the whole description; `into` appends it as more
// top-level keys of an existing YAML mapping.
function buildSecurityTaxDescription(grossKey, grossAmount, taxAmount, options = {}) {
  const keys = `securityTaxAmount: ${taxAmount}\n${grossKey}: ${grossAmount}`;
  return options.into ? `${options.into}\n${keys}` : keys;
}

module.exports = {
  AGENT_MISSION_SECURITY_TAX_RATE,
  NPC_BOUNTY_SECURITY_TAX_RATE,
  SAFE_SECURITY_CLASS_LEVEL,
  buildSecurityTaxDescription,
  computeAgentMissionSecurityTax,
  computeNpcBountySecurityTax,
  isSafeSecuritySolarSystem,
};
