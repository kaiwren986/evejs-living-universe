"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

// R&D research projects: hiring a research agent, accruing research points, and
// spending them on datacores.
//
// Every rule below is taken from a source rather than chosen here:
//   * The RP/day formula, the qualification skills, the concurrency limit, the
//     datacore price, and what cancelling costs come from EVE University's
//     "Research missions" page.
//   * The standings gate is CCP's own eveCfg.CanUseAgent, already ported in
//     standingRuntime.canCharacterUseAgent, so it is called rather than re-derived.
//     It carries TWO research-agent clauses and both matter: research agents get no
//     free pass at level 1, and at every level they additionally require CORPORATION
//     standing >= threshold - 2.0 (faction and agent standing do not satisfy that
//     one). Re-deriving the ladder anywhere would quietly drop the second.
//   * The agent's lines are the client's own localization labels, sent as
//     (labelPath, kwargs) pairs which agents.py ProcessMessage localizes.
//   * The research fields an agent offers come from the SDE via researchAuthority.

const path = require("path");

const {
  buildDict,
  buildKeyVal,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const standingRuntime = require(path.join(
  __dirname,
  "../character/standingRuntime",
));
const {
  getCharacterSkills,
} = require(path.join(__dirname, "../skills/skillState"));
const researchAuthority = require(path.join(__dirname, "./researchAuthority"));
const researchRuntimeState = require(path.join(
  __dirname,
  "./researchRuntimeState",
));

const AGENT_TYPE_RESEARCH = 4;

// "To qualify for any research missions you must first have trained: Science to
// level V. One or more of the science specialty skills trained to the level
// required for the research agent you wish to work with."
const SCIENCE_SKILL_TYPE_ID = 3402;
const SCIENCE_REQUIRED_LEVEL = 5;

// "This begins as 1, but training in the Research Project Management skill will
// increase the number of agents you can employ with 1 per level."
const RESEARCH_PROJECT_MANAGEMENT_SKILL_TYPE_ID = 12179;
const BASE_CONCURRENT_PROJECTS = 1;

const NEGOTIATION_SKILL_TYPE_ID = 3356;

// "All datacores cost 100 RP and 10k ISK."
const DATACORE_RESEARCH_POINT_COST = 100;
const DATACORE_ISK_COST = 10000;

// "After completion of a mission there is a 12 to 23 hour cool-down before the
// next mission is offered."
const MISSION_COOLDOWN_MIN_MS = 12 * 60 * 60 * 1000;
const MISSION_COOLDOWN_MAX_MS = 23 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const LABEL_TOO_LOW_STANDINGS = "UI/Agents/Research/TooLowStandings";
const LABEL_SKILLS_NOT_SUFFICIENT =
  "UI/Agents/Research/CharacterSkillsNotSufficient";
const LABEL_TOO_LOW_RPM = "UI/Agents/Research/TooLowRpm";
const LABEL_RESEARCH_STARTED = "UI/Agents/Research/ResearchStarted";
const LABEL_RESEARCH_CANCELLED = "UI/Agents/Research/ResearchCancelled";
const LABEL_BOUGHT_DATACORES = "UI/Agents/Research/BoughtDatacores";
const LABEL_NOT_ENOUGH_RP = "UI/Agents/Research/NotEnoughRPForDatacores";
const LABEL_NOT_ENOUGH_ISK = "UI/Agents/Research/NotEnoughISKForDatacores";
const LABEL_DATACORE_INVALID_INPUT = "UI/Agents/Research/DatacoreInvalidInput";
const LABEL_DATACORE_PRICE = "UI/Agents/Research/DatacorePrice";
const LABEL_SELECT_RESEARCH_TYPE_TITLE =
  "UI/Agents/Research/SelectResearchTypeTitle";
const LABEL_SELECT_RESEARCH_TYPE_MESSAGE =
  "UI/Agents/Research/SelectResearchTypeMessage";
const LABEL_CANCEL_RESEARCH_QUESTION = "UI/Agents/Research/CancelResearchQuestion";
const LABEL_SURE_TO_CANCEL_RESEARCH = "UI/Agents/Research/SureToCancelResearch";
const LABEL_SURE_TO_CANCEL_RESEARCH_AND_MISSION =
  "UI/Agents/Research/SureToCancelResearchAndMission";
const LABEL_DATACORES = "UI/Agents/Research/Datacores";

// R&D accrual is wall-clock based in production. The gameplay harness supplies
// a scoped override instead of moving global Date.now(), which would also move
// the durable-store lease and make a long simulated research interval stale.
let nowMsOverride = null;

function getNowMs() {
  return nowMsOverride ? Number(nowMsOverride()) : Date.now();
}

function setNowMsOverride(provider) {
  nowMsOverride = typeof provider === "function" ? provider : null;
}

function resetNowMsOverride() {
  nowMsOverride = null;
}

function toPositiveInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  const normalized = Math.trunc(numericValue);
  return normalized > 0 ? normalized : fallback;
}

function buildMarshalTuple(items = []) {
  return {
    type: "tuple",
    items: Array.isArray(items) ? items : [items],
  };
}

// agents.py ProcessMessage: a tuple msgInfo is localized as GetByLabel(path, **kwargs).
// The kwargs half must marshal as a real dict for the ** expansion to work.
function buildLocalizedMessage(labelPath, kwargs = []) {
  return buildMarshalTuple([String(labelPath), buildDict(kwargs)]);
}

function buildAgentSays(labelPath, kwargs = []) {
  return [buildLocalizedMessage(labelPath, kwargs), null];
}

function isResearchAgent(agentRecord = null) {
  return (
    toPositiveInteger(agentRecord && agentRecord.agentTypeID, 0) ===
    AGENT_TYPE_RESEARCH
  );
}

function getAgentLevel(agentRecord = null) {
  return Math.max(1, toPositiveInteger(agentRecord && agentRecord.level, 1));
}

function getCharacterSkillLevel(characterID, skillTypeID) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  const normalizedSkillTypeID = toPositiveInteger(skillTypeID, 0);
  if (!normalizedCharacterID || !normalizedSkillTypeID) {
    return 0;
  }
  const skillRecord = getCharacterSkills(normalizedCharacterID).find(
    (record) => toPositiveInteger(record && record.typeID, 0) === normalizedSkillTypeID,
  );
  if (!skillRecord) {
    return 0;
  }
  return Math.max(
    0,
    toFiniteNumber(
      skillRecord.effectiveSkillLevel ??
        skillRecord.trainedSkillLevel ??
        skillRecord.skillLevel ??
        0,
      0,
    ),
  );
}

// "Agent standing (not faction or corporation standing). This is affected by your
// Connections skill." getCharacterEffectiveStanding already applies that bonus.
function getAgentStanding(characterID, agentRecord) {
  const result = standingRuntime.getCharacterEffectiveStanding(
    toPositiveInteger(characterID, 0),
    toPositiveInteger(agentRecord && agentRecord.agentID, 0),
  );
  return toFiniteNumber(result && result.standing, 0);
}

// The fields this agent offers that the character is actually qualified for: the
// specialty skill must be trained to the agent's own level.
function listQualifyingFields(characterID, agentRecord) {
  const agentLevel = getAgentLevel(agentRecord);
  return researchAuthority
    .listResearchFieldsForAgent(agentRecord && agentRecord.agentID)
    .filter(
      (skillTypeID) => getCharacterSkillLevel(characterID, skillTypeID) >= agentLevel,
    );
}

function getMaxConcurrentProjects(characterID) {
  return (
    BASE_CONCURRENT_PROJECTS +
    getCharacterSkillLevel(characterID, RESEARCH_PROJECT_MANAGEMENT_SKILL_TYPE_ID)
  );
}

// RP/day = (1 + (20 + 5*N + AS)/100) * (SS + AL)^2
function computePointsPerDay(characterID, agentRecord, skillTypeID) {
  const negotiation = getCharacterSkillLevel(characterID, NEGOTIATION_SKILL_TYPE_ID);
  const agentStanding = getAgentStanding(characterID, agentRecord);
  const specialtySkillLevel = getCharacterSkillLevel(characterID, skillTypeID);
  const agentLevel = getAgentLevel(agentRecord);

  const multiplier = 1 + (20 + 5 * negotiation + agentStanding) / 100;
  const base = (specialtySkillLevel + agentLevel) ** 2;
  return Math.max(0, multiplier * base);
}

// "These points will accrue whether you are logged on or not." Nothing ticks: the
// total is the banked remainder plus whatever the current rate has earned since the
// anchor, so downtime neither loses nor invents points.
function getAccruedPoints(project, nowMs = getNowMs()) {
  if (!project) {
    return 0;
  }
  const startedAtMs = toPositiveInteger(project.startedAtMs, 0);
  const remainder = Math.max(0, toFiniteNumber(project.remainderPoints, 0));
  const pointsPerDay = Math.max(0, toFiniteNumber(project.pointsPerDay, 0));
  if (!startedAtMs || nowMs <= startedAtMs) {
    return remainder;
  }
  return remainder + (pointsPerDay * (nowMs - startedAtMs)) / MS_PER_DAY;
}

// Bank what the old rate earned, then restate the rate from the character's current
// skills and standing. Called on every read, so a skill that finishes or a standing
// that moves is reflected from the moment it is next observed.
//
// The re-anchored record is what callers work with, but it is only PERSISTED when
// the rate actually changed. With an unchanged rate the stored (remainder, startedAt)
// pair and the re-anchored one describe the same total at every future instant, so
// writing it back on every journal read or agent-info panel would cost a synchronous
// store write and buy nothing.
function settleProject(characterID, agentRecord, project, nowMs = getNowMs()) {
  if (!project) {
    return null;
  }
  const accrued = getAccruedPoints(project, nowMs);
  const pointsPerDay = computePointsPerDay(
    characterID,
    agentRecord,
    project.skillTypeID,
  );
  const settled = {
    ...project,
    remainderPoints: accrued,
    startedAtMs: nowMs,
    pointsPerDay,
  };
  if (pointsPerDay !== toFiniteNumber(project.pointsPerDay, 0)) {
    researchRuntimeState.saveProject(characterID, settled);
  }
  return settled;
}

// A purchase whose points were taken but whose ISK or items never landed is finished
// on a later read. Not on EVERY read: each attempt is stamped on the receipt, and a
// new one is only made once this long has passed since the last, so a wallet that is
// unreachable does not get one command per journal refresh.
const PURCHASE_RETRY_INTERVAL_MS = 5 * 60 * 1000;

// (characterID:agentID) pairs with a settlement in flight, so overlapping reads do
// not each fire their own wallet command for the same receipt.
const purchasesSettling = new Set();

function purchaseSettlementKey(characterID, agentID) {
  return `${toPositiveInteger(characterID, 0)}:${toPositiveInteger(agentID, 0)}`;
}

function shouldRetryPendingPurchase(pending, nowMs = getNowMs()) {
  if (!pending) {
    return false;
  }
  const lastAttemptAtMs = toPositiveInteger(pending.lastAttemptAtMs, 0);
  return !lastAttemptAtMs || nowMs - lastAttemptAtMs >= PURCHASE_RETRY_INTERVAL_MS;
}

function getSettledProject(characterID, agentRecord, nowMs = getNowMs()) {
  const project = researchRuntimeState.getProject(
    characterID,
    agentRecord && agentRecord.agentID,
  );
  if (!project) {
    return null;
  }
  // Deliberately NOT awaited: every caller of this function is a synchronous read
  // path (the journal rows, the agent info panel), and the settlement is idempotent,
  // so it completes in the background and a following read sees it.
  const key = purchaseSettlementKey(characterID, agentRecord && agentRecord.agentID);
  if (
    project.pendingPurchase &&
    shouldRetryPendingPurchase(project.pendingPurchase, nowMs) &&
    !purchasesSettling.has(key)
  ) {
    purchasesSettling.add(key);
    Promise.resolve()
      .then(() => settlePendingPurchase(characterID, agentRecord, project, nowMs))
      .catch(() => {
        // Left pending on purpose: the receipt survives and a later read retries.
      })
      .finally(() => {
        purchasesSettling.delete(key);
      });
  }
  return settleProject(characterID, agentRecord, project, nowMs);
}

function hasActiveProject(characterID, agentID) {
  return Boolean(researchRuntimeState.getProject(characterID, agentID));
}

// Why "Start Research" is unavailable, as one of the agent's own lines. Null means
// the character may start. Order matters: standings, then skills, then capacity,
// which is the order the three refusals read as a ladder.
function getStartResearchRefusal(characterID, agentRecord) {
  if (!standingRuntime.canCharacterUseAgent(characterID, agentRecord)) {
    return LABEL_TOO_LOW_STANDINGS;
  }
  if (
    getCharacterSkillLevel(characterID, SCIENCE_SKILL_TYPE_ID) < SCIENCE_REQUIRED_LEVEL
  ) {
    return LABEL_SKILLS_NOT_SUFFICIENT;
  }
  if (listQualifyingFields(characterID, agentRecord).length === 0) {
    return LABEL_SKILLS_NOT_SUFFICIENT;
  }
  if (
    researchRuntimeState.countProjects(characterID) >=
    getMaxConcurrentProjects(characterID)
  ) {
    return LABEL_TOO_LOW_RPM;
  }
  return null;
}

// The "Select Research Type" box. "There will be two or more choices of which you
// must (and can only) choose one. The choices available will depend on the agent's
// science specialty fields."
function buildFieldChoicePrompt(characterID, agentRecord) {
  const fields = listQualifyingFields(characterID, agentRecord);
  if (fields.length === 0) {
    return null;
  }
  return {
    fields,
    title: buildLocalizedMessage(LABEL_SELECT_RESEARCH_TYPE_TITLE),
    body: buildLocalizedMessage(LABEL_SELECT_RESEARCH_TYPE_MESSAGE),
    // SingleChoiceBox localizes a (label, kwargs) choice; the field name is the
    // skill's own type name, which the client resolves from the typeID.
    choices: fields.map((skillTypeID) =>
      buildLocalizedMessage("UI/Agents/Research/SkillListing", [
        ["skillID", skillTypeID],
        ["skillLevel", getAgentLevel(agentRecord)],
      ]),
    ),
  };
}

function startResearch(characterID, agentRecord, skillTypeID, nowMs = getNowMs()) {
  const refusal = getStartResearchRefusal(characterID, agentRecord);
  if (refusal) {
    return { success: false, agentSaysLabel: refusal };
  }

  const normalizedSkillTypeID = toPositiveInteger(skillTypeID, 0);
  if (!listQualifyingFields(characterID, agentRecord).includes(normalizedSkillTypeID)) {
    return { success: false, agentSaysLabel: LABEL_SKILLS_NOT_SUFFICIENT };
  }

  const project = {
    agentID: toPositiveInteger(agentRecord && agentRecord.agentID, 0),
    skillTypeID: normalizedSkillTypeID,
    startedAtMs: nowMs,
    remainderPoints: 0,
    pointsPerDay: computePointsPerDay(characterID, agentRecord, normalizedSkillTypeID),
    // The agent's first mission comes "usually within a few days"; the offer gate
    // uses the same daily cadence as every later one.
    missionAvailableAtMs: nowMs,
  };

  const saved = researchRuntimeState.saveProject(characterID, project);
  if (!saved.success) {
    return { success: false, errorMsg: saved.errorMsg };
  }
  notifyResearchChange(characterID, project.agentID, AGENT_MISSION_RESEARCH_STARTED);
  return { success: true, project, agentSaysLabel: LABEL_RESEARCH_STARTED };
}

// Is a mission from this agent currently accepted? Decides which confirmation body
// the client is shown, and whether cancelling has to quit it.
function hasAcceptedMission(characterID, agentRecord) {
  const agentMissionRuntime = require(path.join(__dirname, "./agentMissionRuntime"));
  const missionRecord = agentMissionRuntime.getMissionRecord(
    toPositiveInteger(characterID, 0),
    toPositiveInteger(agentRecord && agentRecord.agentID, 0),
  );
  return Boolean(
    missionRecord &&
      String(missionRecord.runtimeStatus || "").toLowerCase() === "accepted",
  );
}

// "All points will be lost when the connection is broken." And, per the client's own
// SureToCancelResearchAndMission line, "you will quit the current mission you have
// with this agent" -- so the mission goes with it, through the same quitMission the
// Quit button uses.
function cancelResearch(characterID, agentRecord) {
  const project = researchRuntimeState.getProject(
    characterID,
    agentRecord && agentRecord.agentID,
  );
  if (!project) {
    return { success: false, agentSaysLabel: null };
  }
  let missionQuit = false;
  if (hasAcceptedMission(characterID, agentRecord)) {
    const agentMissionRuntime = require(path.join(__dirname, "./agentMissionRuntime"));
    const quitResult = agentMissionRuntime.quitMission(characterID, agentRecord);
    missionQuit = Boolean(quitResult && quitResult.success);
    // quitMission does not announce the change; every other caller of it does so
    // through notifyMissionQuit. Without this the client keeps showing a green
    // "Accepted" in the journal for a mission that is gone (journal.py:168 marks
    // the agent outdated on OnAgentMissionChange).
    if (missionQuit) {
      agentMissionRuntime.notifyMissionQuit(
        characterID,
        toPositiveInteger(agentRecord && agentRecord.agentID, 0),
      );
    }
  }
  const removed = researchRuntimeState.deleteProject(
    characterID,
    agentRecord && agentRecord.agentID,
  );
  if (!removed.success) {
    return { success: false, errorMsg: removed.errorMsg };
  }
  // The client has no research-cancelled event; research_update_ppd is the
  // research refresh it knows. A quit mission already sent 'quit' for the agent,
  // which drives the same journal refresh.
  if (!missionQuit) {
    notifyResearchChange(
      characterID,
      agentRecord && agentRecord.agentID,
      AGENT_MISSION_RESEARCH_UPDATE_PPD,
    );
  }
  return { success: true, missionQuit, agentSaysLabel: LABEL_RESEARCH_CANCELLED };
}

// The confirmation the client raises before cancelling. The wiki warns that an
// undeclined mission costs standings as if failed, and the client ships a separate
// line saying exactly that -- so which body is used depends on whether a mission is
// open with this agent.
function buildCancelResearchPrompt(hasOpenMission = false) {
  return {
    title: buildLocalizedMessage(LABEL_CANCEL_RESEARCH_QUESTION),
    body: buildLocalizedMessage(
      hasOpenMission
        ? LABEL_SURE_TO_CANCEL_RESEARCH_AND_MISSION
        : LABEL_SURE_TO_CANCEL_RESEARCH,
    ),
  };
}

// "Completion of a mission will add one day's worth of bonus Research Points."
function addMissionBonusPoints(characterID, agentRecord, nowMs = getNowMs()) {
  const settled = getSettledProject(characterID, agentRecord, nowMs);
  if (!settled) {
    return { success: false, bonusPoints: 0 };
  }
  const bonusPoints = Math.max(0, toFiniteNumber(settled.pointsPerDay, 0));
  const cooldownMs =
    MISSION_COOLDOWN_MIN_MS +
    Math.floor(Math.random() * (MISSION_COOLDOWN_MAX_MS - MISSION_COOLDOWN_MIN_MS + 1));
  const updated = {
    ...settled,
    remainderPoints: settled.remainderPoints + bonusPoints,
    missionAvailableAtMs: nowMs + cooldownMs,
  };
  const saved = researchRuntimeState.saveProject(characterID, updated);
  if (!saved.success) {
    return { success: false, bonusPoints: 0, errorMsg: saved.errorMsg };
  }
  return { success: true, bonusPoints, project: updated };
}

// One day's RP, quoted before the mission is done so the offer can advertise it the
// way every other mission advertises its reward.
function getMissionBonusPointPreview(characterID, agentRecord, nowMs = getNowMs()) {
  const settled = getSettledProject(characterID, agentRecord, nowMs);
  return settled ? Math.max(0, toFiniteNumber(settled.pointsPerDay, 0)) : 0;
}

// "To acquire missions from a research agent, you must first 'hire' the agent and
// initiate the research process." No project, no missions -- and after one is done,
// not until the cool-down has run.
function canOfferMission(characterID, agentRecord, nowMs = getNowMs()) {
  const project = researchRuntimeState.getProject(
    characterID,
    agentRecord && agentRecord.agentID,
  );
  if (!project) {
    return false;
  }
  return nowMs >= toPositiveInteger(project.missionAvailableAtMs, 0);
}

function getDatacoreTypeIDForProject(project) {
  return project
    ? researchAuthority.getDatacoreTypeIDForField(project.skillTypeID)
    : null;
}

// "The agent will tell you how many you can afford, based on the number of RPs you
// have accumulated."
function buildDatacoreQuantityPrompt(characterID, agentRecord, nowMs = getNowMs()) {
  const settled = getSettledProject(characterID, agentRecord, nowMs);
  if (!settled) {
    return null;
  }
  const datacoreTypeID = getDatacoreTypeIDForProject(settled);
  if (!datacoreTypeID) {
    return null;
  }
  const affordable = Math.floor(
    settled.remainderPoints / DATACORE_RESEARCH_POINT_COST,
  );
  if (affordable < 1) {
    return {
      datacoreTypeID,
      maxQuantity: 0,
      refusalLabel: LABEL_NOT_ENOUGH_RP,
      refusalKwargs: [
        ["datacoreTypeID", datacoreTypeID],
        ["rpAmount", DATACORE_RESEARCH_POINT_COST],
      ],
    };
  }
  return {
    datacoreTypeID,
    maxQuantity: affordable,
    refusalLabel: null,
    caption: buildLocalizedMessage(LABEL_DATACORES),
    label: buildLocalizedMessage(LABEL_DATACORE_PRICE, [
      ["datacoreTypeID", datacoreTypeID],
      ["rpAmount", DATACORE_RESEARCH_POINT_COST],
      ["iskAmount", DATACORE_ISK_COST],
    ]),
  };
}

// The datacore stacks a character already holds at this location, keyed by itemID,
// captured BEFORE the grant so the notification can carry a real previous state.
function snapshotDatacoreStacks(characterID, locationID, datacoreTypeID) {
  const itemStore = require(path.join(__dirname, "../inventory/itemStore"));
  const snapshot = new Map();
  for (const item of itemStore.listContainerItems(
    characterID,
    locationID,
    itemStore.ITEM_FLAGS.HANGAR,
  )) {
    if (toPositiveInteger(item && item.typeID, 0) !== datacoreTypeID) {
      continue;
    }
    snapshot.set(Number(item.itemID), {
      ownerID: item.ownerID,
      locationID: item.locationID,
      flagID: item.flagID,
      quantity: item.quantity,
      stacksize: item.stacksize,
      singleton: item.singleton,
    });
  }
  return snapshot;
}

// Minting the item is not enough: the client's inventory cache only refreshes when
// it is told. notifyInventoryChangesToCharacter is the path market delivery uses --
// items minted straight into a station hangar that appear immediately -- and it
// resolves the character's sessions itself.
//
// The previous state has to be the stack's REAL state before the grant. Reporting a
// merge as a fresh creation (locationID 0, stacksize 0) hands the client a delta it
// cannot reconcile against the row it already holds, and the open window keeps
// painting the old quantity.
function notifyDatacoreGrant(characterID, locationID, datacoreTypeID, before = new Map()) {
  const {
    notifyInventoryChangesToCharacter,
  } = require(path.join(__dirname, "../raffles/raffleInventory"));
  const itemStore = require(path.join(__dirname, "../inventory/itemStore"));

  const changes = [];
  for (const item of itemStore.listContainerItems(
    characterID,
    locationID,
    itemStore.ITEM_FLAGS.HANGAR,
  )) {
    if (toPositiveInteger(item && item.typeID, 0) !== datacoreTypeID) {
      continue;
    }
    const previousData = before.get(Number(item.itemID)) ||
      itemStore.buildCreatedItemNotificationPreviousState(item);
    // A stack the grant did not touch needs no notification.
    if (
      previousData.quantity === item.quantity &&
      previousData.stacksize === item.stacksize
    ) {
      continue;
    }
    changes.push({ item, previousData });
  }

  if (changes.length > 0) {
    notifyInventoryChangesToCharacter(characterID, changes);
  }
}

// The client keeps the R&D project list (journal Research tab, Industry Research
// tab) in the journal cache and refreshes it only on OnAgentMissionChange for the
// agent (journal.py OnAgentMissionChange marks the agent outdated;
// browserResearch.py reloads on the same event). appConst names the two research
// events: research_started and research_update_ppd.
const AGENT_MISSION_RESEARCH_STARTED = "research_started";
const AGENT_MISSION_RESEARCH_UPDATE_PPD = "research_update_ppd";

function sendToCharacterSessions(characterID, notifyType, args) {
  const normalizedCharacterID = toPositiveInteger(characterID, 0);
  if (!normalizedCharacterID) {
    return false;
  }
  const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
  let sent = false;
  for (const session of sessionRegistry.getSessions()) {
    if (
      Number(session && session.characterID) !== normalizedCharacterID ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    session.sendNotification(notifyType, "charid", args);
    sent = true;
  }
  return sent;
}

function notifyResearchChange(characterID, agentID, eventName) {
  const normalizedAgentID = toPositiveInteger(agentID, 0);
  if (!normalizedAgentID) {
    return false;
  }
  return sendToCharacterSessions(characterID, "OnAgentMissionChange", [
    eventName,
    normalizedAgentID,
  ]);
}

// agents.py OnDatacoreBought(characterID, agentID, balance) re-scatters
// OnAgentMissionChange('research_update_ppd', agentID) and
// OnAccountChange('cash', characterID, balance), so the balance is the wallet
// balance after the purchase.
function notifyDatacoreBought(characterID, agentID, balance) {
  const normalizedAgentID = toPositiveInteger(agentID, 0);
  if (!normalizedAgentID) {
    return false;
  }
  return sendToCharacterSessions(characterID, "OnDatacoreBought", [
    toPositiveInteger(characterID, 0),
    normalizedAgentID,
    toFiniteNumber(balance, 0),
  ]);
}

function resolvePurchaseBalance(walletState, characterID, iskResult) {
  let wallet = null;
  try {
    wallet = typeof walletState.resolveAnnouncedCharacterWallet === "function"
      ? walletState.resolveAnnouncedCharacterWallet(
        characterID,
        iskResult,
        iskResult && iskResult.data,
      )
      : null;
    if (!wallet) {
      wallet = walletState.getCharacterWallet(characterID);
    }
  } catch (_error) {
    wallet = null;
  }
  return toFiniteNumber(wallet && wallet.balance, 0);
}

function buildPurchaseIskKey(characterID, agentID, sequence) {
  return `rnd-datacore-isk-${characterID}-${agentID}-${sequence}`;
}

function buildPurchaseGrantKey(characterID, agentID, sequence) {
  return `rnd-datacore-grant-${characterID}-${agentID}-${sequence}`;
}

// The receipt may have moved on while a settlement was waiting on the wallet: a read
// may have re-anchored the project, a mission may have banked its bonus, research may
// have been cancelled outright. So a settlement never writes back the snapshot it
// started from. It re-reads the record and only touches the receipt it was given,
// identified by sequence, leaving anything newer alone.
function updatePendingPurchase(characterID, agentID, sequence, update) {
  const fresh = researchRuntimeState.getProject(characterID, agentID);
  if (
    !fresh ||
    !fresh.pendingPurchase ||
    toPositiveInteger(fresh.pendingPurchase.sequence, 0) !== toPositiveInteger(sequence, 0)
  ) {
    return fresh;
  }
  const updated = update(fresh);
  researchRuntimeState.saveProject(characterID, updated);
  return updated;
}

function stampPurchaseAttempt(characterID, agentID, pending, nowMs) {
  return updatePendingPurchase(characterID, agentID, pending.sequence, (fresh) => ({
    ...fresh,
    pendingPurchase: {
      ...fresh.pendingPurchase,
      attempts: Math.max(0, toPositiveInteger(fresh.pendingPurchase.attempts, 0)) + 1,
      lastAttemptAtMs: nowMs,
    },
  }));
}

// The wallet answered and said no (INSUFFICIENT_FUNDS, most likely). Nothing was
// charged, so the points go back and the receipt is dropped: the purchase simply did
// not happen, rather than lying in wait to complete itself the next time the wallet
// happens to have the money.
function refundPendingPurchase(characterID, agentID, pending) {
  return updatePendingPurchase(characterID, agentID, pending.sequence, (fresh) => ({
    ...fresh,
    remainderPoints:
      Math.max(0, toFiniteNumber(fresh.remainderPoints, 0)) +
      Math.max(0, toFiniteNumber(pending.researchPointCost, 0)),
    pendingPurchase: null,
  }));
}

function clearPendingPurchase(characterID, agentID, pending) {
  return updatePendingPurchase(characterID, agentID, pending.sequence, (fresh) => ({
    ...fresh,
    pendingPurchase: null,
  }));
}

// Finish a purchase whose research points have already been taken. Both legs carry
// keys derived from the persisted sequence, so running this twice is a no-op rather
// than a double charge or a double grant.
//
// Three outcomes:
//   * settled  -- ISK taken, datacores minted, receipt cleared.
//   * refunded -- the wallet refused; points returned, receipt cleared.
//   * neither  -- the wallet or the item grant could not be reached or failed in a
//                 way that may or may not have taken effect. The receipt stays, with
//                 the attempt stamped on it, and a later read retries.
//
// Async because the wallet authority may run in its own process, where the
// synchronous character.adjust-isk command is refused outright
// ("synchronous wallet command character.adjust-isk is disabled in process mode").
async function settlePendingPurchase(characterID, agentRecord, project, nowMs = getNowMs()) {
  const pending = project && project.pendingPurchase;
  if (!pending) {
    return { success: true, settled: false, project };
  }

  const walletState = require(path.join(__dirname, "../account/walletState"));
  const researchDatacoreItemCustody = require(path.join(
    __dirname,
    "../inventory/researchDatacoreItemCustody",
  ));

  const agentID = toPositiveInteger(agentRecord && agentRecord.agentID, 0);
  stampPurchaseAttempt(characterID, agentID, pending, nowMs);

  let iskResult;
  try {
    iskResult = await walletState.adjustCharacterBalanceAsync(characterID, -pending.iskCost, {
      entryTypeID: walletState.JOURNAL_ENTRY_TYPE.DATACORE_FEE,
      reason: "Datacore purchase",
      idempotencyKey: buildPurchaseIskKey(characterID, agentID, pending.sequence),
    });
  } catch (error) {
    // The wallet could not be reached, so whether it charged is unknown. The key
    // makes a retry safe either way.
    return {
      success: false,
      errorMsg: (error && error.message) || "DATACORE_ISK_DEBIT_FAILED",
      project,
    };
  }
  if (!iskResult) {
    return { success: false, errorMsg: "DATACORE_ISK_DEBIT_FAILED", project };
  }
  if (iskResult.success !== true) {
    const refunded = refundPendingPurchase(characterID, agentID, pending);
    return {
      success: false,
      refunded: true,
      errorMsg: iskResult.errorMsg || "DATACORE_ISK_DEBIT_FAILED",
      project: refunded,
    };
  }

  const before = snapshotDatacoreStacks(
    characterID,
    pending.locationID,
    pending.datacoreTypeID,
  );
  const grantResult = researchDatacoreItemCustody.grantDatacores({
    characterID,
    locationID: pending.locationID,
    typeID: pending.datacoreTypeID,
    quantity: pending.quantity,
    idempotencyKey: buildPurchaseGrantKey(characterID, agentID, pending.sequence),
  });
  if (!grantResult || grantResult.success !== true) {
    // The ISK is gone but the items are not there yet. Never refund here: the grant
    // key lets a retry mint them exactly once.
    return {
      success: false,
      errorMsg: (grantResult && grantResult.errorMsg) || "DATACORE_GRANT_FAILED",
      project,
    };
  }

  const cleared = clearPendingPurchase(characterID, agentID, pending);
  try {
    notifyDatacoreGrant(
      characterID,
      pending.locationID,
      pending.datacoreTypeID,
      before,
    );
  } catch (_error) {
    // ignored: the purchase is settled either way; a failed notification only costs the
    // player a relog to see the items.
  }
  try {
    notifyDatacoreBought(
      characterID,
      agentID,
      resolvePurchaseBalance(walletState, characterID, iskResult),
    );
  } catch (_error) {
    // ignored: as above, the purchase stands without the journal refresh.
  }
  return { success: true, settled: true, project: cleared, quantity: pending.quantity };
}

// "To spend points simply click on the 'Buy Datacores' button and indicate how many
// that you want to purchase." Each costs 100 RP and 10k ISK, and is always the
// datacore for the field the project was started in.
async function buyDatacores(characterID, agentRecord, quantity, locationID, nowMs = getNowMs()) {
  const settled = getSettledProject(characterID, agentRecord, nowMs);
  if (!settled) {
    return { success: false, agentSaysLabel: LABEL_DATACORE_INVALID_INPUT };
  }
  // A receipt is still open from an earlier purchase; let it finish before taking
  // more points, or two settlements end up racing for the same record.
  if (settled.pendingPurchase) {
    return { success: false, agentSaysLabel: LABEL_DATACORE_INVALID_INPUT };
  }

  const datacoreTypeID = getDatacoreTypeIDForProject(settled);
  const normalizedQuantity = toPositiveInteger(quantity, 0);
  const normalizedLocationID = toPositiveInteger(locationID, 0);
  if (!datacoreTypeID || !normalizedQuantity || !normalizedLocationID) {
    return {
      success: false,
      agentSaysLabel: LABEL_DATACORE_INVALID_INPUT,
      agentSaysKwargs: [],
    };
  }

  const researchPointCost = normalizedQuantity * DATACORE_RESEARCH_POINT_COST;
  if (settled.remainderPoints < researchPointCost) {
    return {
      success: false,
      agentSaysLabel: LABEL_NOT_ENOUGH_RP,
      agentSaysKwargs: [
        ["datacoreTypeID", datacoreTypeID],
        ["rpAmount", DATACORE_RESEARCH_POINT_COST],
      ],
    };
  }

  const walletState = require(path.join(__dirname, "../account/walletState"));
  const iskCost = normalizedQuantity * DATACORE_ISK_COST;
  const notEnoughIsk = {
    success: false,
    agentSaysLabel: LABEL_NOT_ENOUGH_ISK,
    agentSaysKwargs: [
      ["datacoreTypeID", datacoreTypeID],
      ["iskAmount", DATACORE_ISK_COST],
    ],
  };
  const wallet = walletState.getCharacterWallet(characterID);
  if (!wallet || toFiniteNumber(wallet.balance, 0) < iskCost) {
    return notEnoughIsk;
  }

  const sequence = researchRuntimeState.claimPurchaseSequence(characterID);
  if (!sequence) {
    return { success: false, agentSaysLabel: LABEL_DATACORE_INVALID_INPUT };
  }

  // Points come off and the receipt goes down together, before any ISK moves or any
  // item is minted. A crash from here on leaves a purchase that can be finished, not
  // one that can be replayed for free.
  const charged = {
    ...settled,
    remainderPoints: settled.remainderPoints - researchPointCost,
    pendingPurchase: {
      sequence,
      quantity: normalizedQuantity,
      datacoreTypeID,
      locationID: normalizedLocationID,
      researchPointCost,
      iskCost,
      attempts: 0,
      lastAttemptAtMs: 0,
    },
  };
  const saved = researchRuntimeState.saveProject(characterID, charged);
  if (!saved.success) {
    return { success: false, errorMsg: saved.errorMsg };
  }

  const settlement = await settlePendingPurchase(characterID, agentRecord, charged, nowMs);
  if (!settlement.success) {
    if (settlement.refunded) {
      return { ...notEnoughIsk, errorMsg: settlement.errorMsg };
    }
    return {
      success: false,
      errorMsg: settlement.errorMsg,
      agentSaysLabel: LABEL_DATACORE_INVALID_INPUT,
    };
  }

  return {
    success: true,
    quantity: normalizedQuantity,
    datacoreTypeID,
    researchPointCost,
    iskCost,
    project: settlement.project,
    agentSaysLabel: LABEL_BOUGHT_DATACORES,
  };
}

function buildResearchDataKeyVal(project) {
  if (!project) {
    return null;
  }
  return buildKeyVal([
    ["skillTypeID", toPositiveInteger(project.skillTypeID, 0)],
    ["points", toFiniteNumber(project.remainderPoints, 0)],
    ["pointsPerDay", toFiniteNumber(project.pointsPerDay, 0)],
  ]);
}

// agents.py _ProcessResearchServiceInfo reads agentServiceType, skills and
// researchData off this. `skills` is the agent's own specialty fields with the level
// the agent requires -- the wiki's worked example ("Plasma Physics II ... you will
// need one of these to that level") is that list for a level 2 agent.
function buildResearchServiceDetails(characterID, agentRecord, nowMs = getNowMs()) {
  if (!isResearchAgent(agentRecord)) {
    return null;
  }
  const agentLevel = getAgentLevel(agentRecord);
  const skills = researchAuthority
    .listResearchFieldsForAgent(agentRecord && agentRecord.agentID)
    .map((skillTypeID) =>
      buildMarshalTuple([
        skillTypeID,
        buildKeyVal([["effectiveSkillLevel", agentLevel]]),
      ]),
    );

  return buildKeyVal([
    ["agentServiceType", "research"],
    ["skills", { type: "list", items: skills }],
    [
      "researchData",
      buildResearchDataKeyVal(getSettledProject(characterID, agentRecord, nowMs)),
    ],
  ]);
}

// The research half of GetMyJournalDetails. browserResearch.py unpacks each row as
// (agentID, researchFieldTypeID, pointsPerDay, currentPoints, level, quality,
// stationID); `quality` is unpacked and never read.
function buildJournalResearchRows(characterID, resolveAgentRecord, nowMs = getNowMs()) {
  const rows = [];
  for (const project of researchRuntimeState.listProjects(characterID)) {
    const agentRecord =
      typeof resolveAgentRecord === "function"
        ? resolveAgentRecord(project.agentID)
        : null;
    if (!agentRecord) {
      continue;
    }
    const settled = settleProject(characterID, agentRecord, project, nowMs);
    rows.push([
      toPositiveInteger(settled.agentID, 0),
      toPositiveInteger(settled.skillTypeID, 0),
      toFiniteNumber(settled.pointsPerDay, 0),
      toFiniteNumber(settled.remainderPoints, 0),
      getAgentLevel(agentRecord),
      0,
      toPositiveInteger(agentRecord.stationID, 0) || null,
    ]);
  }
  return rows;
}

module.exports = {
  AGENT_MISSION_RESEARCH_STARTED,
  AGENT_MISSION_RESEARCH_UPDATE_PPD,
  AGENT_TYPE_RESEARCH,
  DATACORE_ISK_COST,
  DATACORE_RESEARCH_POINT_COST,
  PURCHASE_RETRY_INTERVAL_MS,
  LABEL_BOUGHT_DATACORES,
  LABEL_DATACORE_INVALID_INPUT,
  LABEL_NOT_ENOUGH_ISK,
  LABEL_NOT_ENOUGH_RP,
  LABEL_RESEARCH_CANCELLED,
  LABEL_RESEARCH_STARTED,
  LABEL_SKILLS_NOT_SUFFICIENT,
  LABEL_TOO_LOW_RPM,
  LABEL_TOO_LOW_STANDINGS,
  addMissionBonusPoints,
  buildAgentSays,
  buildCancelResearchPrompt,
  buildDatacoreQuantityPrompt,
  buildFieldChoicePrompt,
  buildJournalResearchRows,
  buildLocalizedMessage,
  buildResearchServiceDetails,
  buyDatacores,
  canOfferMission,
  cancelResearch,
  computePointsPerDay,
  getAccruedPoints,
  getDatacoreTypeIDForProject,
  getMaxConcurrentProjects,
  getMissionBonusPointPreview,
  getSettledProject,
  getStartResearchRefusal,
  hasAcceptedMission,
  hasActiveProject,
  isResearchAgent,
  listQualifyingFields,
  settlePendingPurchase,
  settleProject,
  startResearch,
  _testing: {
    resetNowMsOverride,
    setNowMsOverride,
  },
};
