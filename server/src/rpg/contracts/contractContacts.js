"use strict";

// EveJS RPG fork: contacts.
//
// A client whose contract the pilot completes becomes a contact: a persistent
// person with a trust score and a shared history. Contacts come back with
// follow-up work, pay more as trust grows, and remember being let down.
// Contacts live in the pilot's rpgContracts record (record.contacts). This
// module only changes the record it is handed; saving is the caller's job.

const TRUST_MIN = -100;
const TRUST_MAX = 100;
const TRUST_FIRST_JOB = 25;
const TRUST_PER_JOB = 15;
const TRUST_ABANDONED = -20;
const KEPT_HISTORY = 5;
const KEPT_CONTACTS = 24;
// How often "Find work" comes from someone the pilot already knows, when they know anyone.
const RETURNING_CHANCE_PERCENT = 55;

// Highest first. payBonus is a real multiplier on the contract's ISK.
const TIERS = Object.freeze([
  { key: "partner", label: "Partner", min: 80, payBonus: 0.30 },
  { key: "trusted", label: "Trusted", min: 50, payBonus: 0.20 },
  { key: "acquaintance", label: "Acquaintance", min: 20, payBonus: 0.10 },
  { key: "new", label: "New contact", min: 0, payBonus: 0 },
  { key: "soured", label: "Soured", min: -Infinity, payBonus: 0 },
]);

function tierFor(trust) {
  return TIERS.find((tier) => Number(trust) >= tier.min);
}

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function sameName(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function find(record, contactID) {
  return (record.contacts || []).find((contact) => contact.id === contactID) || null;
}

function historyLine(contract, outcome) {
  const { facts, story } = contract;
  return outcome === "completed"
    ? `Hired the captain to kill ${facts.factionName} leader ${story.bossName} in ${facts.systemName}; the captain did it. ${story.reason || ""}`.trim()
    : `Hired the captain to kill ${facts.factionName} leader ${story.bossName} in ${facts.systemName}; the captain took the job and walked away from it.`;
}

/**
 * Record a contract's outcome against its client.
 * A completed job creates the contact if the client was new; an abandoned one
 * only counts against a contact who already exists (a stranger just moves on).
 * Sets contract.contactID when a contact is involved. Safe to call once per outcome.
 */
function recordOutcome(record, contract, outcome, nowMs = Date.now()) {
  record.contacts = record.contacts || [];
  if (contract.outcomeRecorded) return find(record, contract.contactID);
  // The name match is only for a finished job from someone not yet linked. An
  // abandoned stranger's job must never count against a contact who shares a name.
  let contact = find(record, contract.contactID) ||
    (outcome === "completed"
      ? record.contacts.find((entry) => sameName(entry.name, contract.story.clientName))
      : null) || null;
  if (!contact) {
    if (outcome !== "completed") return null;
    record.contactSequence = (record.contactSequence || 0) + 1;
    contact = {
      id: `k${record.contactSequence}`,
      name: contract.story.clientName,
      role: contract.story.clientRole,
      voice: contract.story.clientVoice || "",
      homeSystemName: contract.facts.originSystemName || contract.facts.systemName,
      empireName: contract.facts.empireName,
      trust: 0,
      jobsCompleted: 0,
      jobsAbandoned: 0,
      metAtMs: nowMs,
      lastAtMs: nowMs,
      history: [],
    };
    record.contacts.push(contact);
  }
  if (outcome === "completed") {
    contact.trust += contact.jobsCompleted === 0 && contact.trust >= 0 ? TRUST_FIRST_JOB : TRUST_PER_JOB;
    contact.jobsCompleted += 1;
  } else {
    contact.trust += TRUST_ABANDONED;
    contact.jobsAbandoned += 1;
  }
  contact.trust = Math.max(TRUST_MIN, Math.min(TRUST_MAX, contact.trust));
  contact.lastAtMs = nowMs;
  contact.history = [...contact.history, historyLine(contract, outcome)].slice(-KEPT_HISTORY);
  // history is written from the contact's side, for the writer; this line is for the pilot's screen.
  contact.lastSummary = outcome === "completed"
    ? `Last job: you killed ${contract.story.bossName} in ${contract.facts.systemName}.`
    : `Last job: you walked away from the hunt for ${contract.story.bossName}.`;
  contract.contactID = contact.id;
  contract.outcomeRecorded = outcome;
  // Keep the people the pilot has dealt with most recently.
  record.contacts = [...record.contacts].sort((a, b) => a.lastAtMs - b.lastAtMs).slice(-KEPT_CONTACTS);
  return contact;
}

// Brings a loaded record up to date: any finished contract that has not been
// credited to a contact yet (records from before contacts existed) is credited
// now. contract.outcomeRecorded marks a contract as credited, so this never counts twice.
function ensure(record) {
  record.contacts = Array.isArray(record.contacts) ? record.contacts : [];
  for (const contract of record.contracts || []) {
    if (["completed", "paid"].includes(contract.state) && !contract.outcomeRecorded) {
      recordOutcome(record, contract, "completed", contract.paidAtMs || contract.completedAtMs || Date.now());
    }
  }
  return record;
}

function willOffer(contact) {
  return Boolean(contact) && contact.trust >= 0;
}

/**
 * Who offers the next contract when the pilot just asks for work: a contact
 * (weighted towards those who trust the pilot more), or null for a new client.
 */
function pickForOffer(record, seed) {
  const eligible = (record.contacts || []).filter(willOffer);
  if (!eligible.length || hashText(`${seed}:returning`) % 100 >= RETURNING_CHANCE_PERCENT) return null;
  const weights = eligible.map((contact) => contact.trust + 10);
  let roll = hashText(`${seed}:who`) % weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < eligible.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return eligible[index];
  }
  return eligible[eligible.length - 1];
}

// What the writer needs to know to speak as this person.
function persona(contact) {
  const tier = tierFor(contact.trust);
  return {
    name: contact.name,
    role: contact.role,
    voice: contact.voice,
    tierLabel: tier.label,
    jobsCompleted: contact.jobsCompleted,
    jobsAbandoned: contact.jobsAbandoned,
    history: [...contact.history],
  };
}

function view(contact) {
  const tier = tierFor(contact.trust);
  return {
    id: contact.id,
    name: contact.name,
    role: contact.role,
    homeSystemName: contact.homeSystemName || "",
    trust: contact.trust,
    tierKey: tier.key,
    tierLabel: tier.label,
    payBonusPercent: Math.round(tier.payBonus * 100),
    jobsCompleted: contact.jobsCompleted,
    jobsAbandoned: contact.jobsAbandoned,
    lastLine: contact.lastSummary || "",
    willOffer: willOffer(contact),
  };
}

function list(record) {
  return [...(record.contacts || [])].sort((a, b) => b.lastAtMs - a.lastAtMs).map(view);
}

function findByName(record, name) {
  return (record.contacts || []).find((entry) => sameName(entry.name, name)) || null;
}

module.exports = { ensure, find, findByName, recordOutcome, pickForOffer, willOffer, persona, view, list, tierFor };
