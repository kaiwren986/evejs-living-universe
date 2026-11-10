"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const { buildAllyPayload, buildWarPayload } = require("./warPayloads");
const {
  buildBoundObjectResponse,
  buildDict,
  buildList,
  normalizeNumber,
  normalizeText,
  resolveBoundNodeId,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getWarRecord,
} = require(path.join(__dirname, "./warRuntimeState"));
const {
  buildKillmailPayload,
  buildWarDestructionStatistics,
  getKillmailHashValue,
  getKillmailRecord,
  listKillmailsForWar,
} = require(path.join(__dirname, "../killmail/killmailState"));

function normalizeWarID(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function resolveBoundWarID(args, session) {
  return normalizeWarID(
    (args && args[0]) || (session && session._boundWarStatisticID),
  );
}

function normalizeKillmailIDArg(value) {
  const numeric = normalizeNumber(value, 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

class WarStatisticMgrService extends BaseService {
  constructor() {
    super("warStatisticMgr");
  }

  Handle_MachoResolveObject() {
    return resolveBoundNodeId();
  }

  Handle_MachoBindObject(args, session, kwargs) {
    if (session) {
      session._boundWarStatisticID = normalizeWarID(args && args[0]);
    }
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetBaseInfo(args, session) {
    const war = getWarRecord(resolveBoundWarID(args, session));
    if (!war) {
      return null;
    }
    const stats = buildWarDestructionStatistics(war.warID);

    return [
      buildWarPayload(war),
      buildDict(
        Object.entries(stats.shipsKilled || {}).map(([ownerID, count]) => [
          Number(ownerID),
          Number(count || 0),
        ]),
      ),
      buildDict(
        Object.entries(stats.iskKilled || {}).map(([ownerID, amount]) => [
          Number(ownerID),
          Number(amount || 0),
        ]),
      ),
      buildDict(
        Object.entries(war.allies || {}).map(([allyID, ally]) => [
          Number(allyID),
          buildAllyPayload({
            allyID: Number(allyID),
            ...(ally || {}),
          }),
        ]),
      ),
    ];
  }

  Handle_GetKills(args, session) {
    // This is a bound-object method: its positional arguments are the entity
    // and ship-group filters, not a war id. Reading args[0] as the binding
    // made every nonzero entity filter look up a nonexistent war instead.
    const warID = normalizeWarID(session && session._boundWarStatisticID);
    const entityID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const groupID = args && args.length > 1 && args[1] !== null && args[1] !== undefined
      ? Number(args[1])
      : null;
    return buildList(
      listKillmailsForWar(warID, {
        entityID,
        groupID,
      }).map((record) => buildKillmailPayload(record)),
    );
  }

  Handle_GetKillsByGroup(args, session) {
    const warID = resolveBoundWarID(args, session);
    const stats = buildWarDestructionStatistics(warID);
    return buildDict(
      Object.entries(stats.killsByGroup || {}).map(([groupID, groupStats]) => [
        Number(groupID),
        buildDict([
          ["attackerShipLoss", Number(groupStats && groupStats.attackerShipLoss ? groupStats.attackerShipLoss : 0)],
          ["attackerIskLoss", Number(groupStats && groupStats.attackerIskLoss ? groupStats.attackerIskLoss : 0)],
          ["defenderShipLoss", Number(groupStats && groupStats.defenderShipLoss ? groupStats.defenderShipLoss : 0)],
          ["defenderIskLoss", Number(groupStats && groupStats.defenderIskLoss ? groupStats.defenderIskLoss : 0)],
        ]),
      ]),
    );
  }

  Handle_GetKillMail(args) {
    const killID = Array.isArray(args) ? normalizeKillmailIDArg(args[0]) : 0;
    const hashValue = Array.isArray(args)
      ? normalizeText(args[1], "").trim()
      : "";
    const killmail = getKillmailRecord(killID);
    if (!killmail) {
      return null;
    }
    if (!hashValue || getKillmailHashValue(killmail) !== hashValue) {
      return null;
    }
    return buildKillmailPayload(killmail);
  }
}

module.exports = WarStatisticMgrService;
