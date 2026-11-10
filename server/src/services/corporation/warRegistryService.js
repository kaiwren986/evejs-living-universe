"use strict";

const path = require("path");
const { getWarAuthority, requireWarAuthority } = require("./warAuthority");
const { throwWrappedUserError } = require("../../common/machoErrors");

const BaseService = require(path.join(__dirname, "../baseService"));
const { buildWarPayload } = require("./warPayloads");
const {
  buildBoundObjectResponse,
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../../network/protocolProfile"));
const {
  endWarWithReason,
  listWarsForOwner,
  getWarRecord,
  processWarLifecycle,
  updateWarRecord,
} = require(path.join(__dirname, "./warRuntimeState"));
const {
  WAR_NEGOTIATION_STATE_NEW,
  WAR_NEGOTIATION_STATE_DECLINED,
  WAR_NEGOTIATION_STATE_RETRACTED,
  WAR_NEGOTIATION_TYPE_ALLY_OFFER,
  WAR_NEGOTIATION_TYPE_SURRENDER_OFFER,
  acceptAllyNegotiation,
  acceptSurrender,
  createWarNegotiation,
  getNegotiationRecord,
  listNegotiationsForOwner,
  requireWarOffer,
  updateWarNegotiation,
} = require(path.join(__dirname, "./warNegotiationRuntimeState"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const warNotificationCenter = require(path.join(
  __dirname,
  "./warNotificationCenter",
));

function resolveOwnerID(args, session) {
  return (
    (args && args.length > 0 && Number(args[0])) ||
    (session &&
      (session.allianceID ||
        session.allianceid ||
        session.corporationID ||
        session.corpid)) ||
    0
  );
}

function resolveWarEntityID(session) {
  return requireWarAuthority(session).warEntityID;
}

function resolveCharacterID(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function getAuthorizedPendingNegotiation(warNegotiationID, typeID, ownerField, session) {
  const negotiation = getNegotiationRecord(warNegotiationID);
  if (
    !negotiation ||
    negotiation.walletSettlement ||
    Number(negotiation.warNegotiationTypeID) !== Number(typeID) ||
    Number(negotiation.negotiationState) !== WAR_NEGOTIATION_STATE_NEW ||
    Number(negotiation[ownerField]) !== Number(resolveWarEntityID(session))
  ) {
    return null;
  }
  return negotiation;
}

function buildWarNegotiationPayload(negotiation) {
  return buildKeyVal([
    ["warNegotiationID", Number(negotiation && negotiation.warNegotiationID ? negotiation.warNegotiationID : 0)],
    ["warID", Number(negotiation && negotiation.warID ? negotiation.warID : 0)],
    [
      "warNegotiationTypeID",
      Number(negotiation && negotiation.warNegotiationTypeID ? negotiation.warNegotiationTypeID : 0),
    ],
    ["ownerID1", Number(negotiation && negotiation.ownerID1 ? negotiation.ownerID1 : 0)],
    ["ownerID2", Number(negotiation && negotiation.ownerID2 ? negotiation.ownerID2 : 0)],
    ["declaredByID", Number(negotiation && negotiation.declaredByID ? negotiation.declaredByID : 0)],
    ["againstID", Number(negotiation && negotiation.againstID ? negotiation.againstID : 0)],
    ["iskValue", Number(negotiation && negotiation.iskValue ? negotiation.iskValue : 0)],
    ["description", negotiation && negotiation.description ? negotiation.description : ""],
    [
      "negotiationState",
      Number(negotiation && negotiation.negotiationState ? negotiation.negotiationState : 0),
    ],
    [
      "createdDateTime",
      buildFiletimeLong(
        negotiation && negotiation.createdDateTime ? negotiation.createdDateTime : 0,
      ),
    ],
    [
      "timeAccepted",
      negotiation && negotiation.timeAccepted
        ? buildFiletimeLong(negotiation.timeAccepted)
        : null,
    ],
    [
      "timeDeclined",
      negotiation && negotiation.timeDeclined
        ? buildFiletimeLong(negotiation.timeDeclined)
        : null,
    ],
    [
      "timeRetracted",
      negotiation && negotiation.timeRetracted
        ? buildFiletimeLong(negotiation.timeRetracted)
        : null,
    ],
  ]);
}

class WarRegistryService extends BaseService {
  constructor() {
    super("warRegistry");
  }

  Handle_IsAllianceOrCorpLocal() {
    return 1;
  }

  Handle_MachoResolveObject() {
    return PROXY_NODE_ID;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  Handle_GetWars(args, session) {
    processWarLifecycle();
    const ownerID = resolveOwnerID(args, session);
    return buildDict(
      listWarsForOwner(ownerID).map((war) => [Number(war.warID), buildWarPayload(war)]),
    );
  }

  Handle_GetNegotiations(args, session) {
    // The Wars page requests this collection for every member. Keep private
    // offers restricted to negotiators without preventing ordinary war reads.
    const authority = getWarAuthority(session);
    if (!authority) return buildList([]);
    const ownerID = authority.warEntityID;
    processWarLifecycle();
    return buildList(
      listNegotiationsForOwner(ownerID).map((negotiation) =>
        buildWarNegotiationPayload(negotiation),
      ),
    );
  }

  Handle_CreateWarAllyOffer(args, session) {
    const warID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const amount = args && args.length > 1 ? args[1] : 0;
    const defenderID = args && args.length > 2 ? Number(args[2]) || 0 : 0;
    const description = args && args.length > 3 ? String(args[3] || "") : "";
    const { authority, war, iskValue } = requireWarOffer(
      session, warID, WAR_NEGOTIATION_TYPE_ALLY_OFFER, amount, defenderID,
    );
    const ownerID = authority.warEntityID;
    createWarNegotiation({
      warID,
      warNegotiationTypeID: WAR_NEGOTIATION_TYPE_ALLY_OFFER,
      ownerID1: ownerID,
      ownerID2: defenderID || Number(war.againstID || 0),
      declaredByID: Number(war.declaredByID || 0),
      againstID: Number(war.againstID || 0),
      iskValue,
      description,
      createdByCharacterID: authority.characterID,
    });
    return null;
  }

  Handle_RetractWarAllyOffer(args, session) {
    const warNegotiationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const negotiation = getAuthorizedPendingNegotiation(
      warNegotiationID,
      WAR_NEGOTIATION_TYPE_ALLY_OFFER,
      "ownerID1",
      session,
    );
    if (!negotiation) {
      return null;
    }
    updateWarNegotiation(warNegotiationID, (record) => ({
      ...record,
      negotiationState: WAR_NEGOTIATION_STATE_RETRACTED,
      timeRetracted: currentFileTime().toString(),
    }));
    if (negotiation) {
      warNotificationCenter.notifyAllyOfferRetracted(negotiation, {
        characterID: resolveCharacterID(session),
      });
    }
    return null;
  }

  Handle_CreateSurrenderNegotiation(args, session) {
    const warID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const amount = args && args.length > 1 ? args[1] : 0;
    const description = args && args.length > 2 ? String(args[2] || "") : "";
    const currentAuthority = requireWarAuthority(session);
    const currentWar = getWarRecord(warID);
    if (!currentWar || ![Number(currentWar.declaredByID), Number(currentWar.againstID)]
      .includes(currentAuthority.warEntityID)) return null;
    const { authority, war, iskValue } = requireWarOffer(
      session, warID, WAR_NEGOTIATION_TYPE_SURRENDER_OFFER, amount,
    );
    const ownerID = authority.warEntityID;
    const counterpartyID =
      ownerID === Number(war.declaredByID || 0)
        ? Number(war.againstID || 0)
        : Number(war.declaredByID || 0);
    createWarNegotiation({
      warID,
      warNegotiationTypeID: WAR_NEGOTIATION_TYPE_SURRENDER_OFFER,
      ownerID1: ownerID,
      ownerID2: counterpartyID,
      declaredByID: Number(war.declaredByID || 0),
      againstID: Number(war.againstID || 0),
      iskValue,
      description,
      ownerID1AccountKey:
        (session && (session.corpAccountKey || session.corpaccountkey)) || 1000,
      createdByCharacterID: authority.characterID,
    });
    return null;
  }

  Handle_GetWarNegotiation(args, session) {
    const ownerID = resolveWarEntityID(session);
    const warNegotiationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const negotiation = getNegotiationRecord(warNegotiationID);
    if (negotiation && Number(negotiation.ownerID1) !== ownerID && Number(negotiation.ownerID2) !== ownerID) {
      throwWrappedUserError("CrpAccessDenied");
    }
    return negotiation ? buildWarNegotiationPayload(negotiation) : null;
  }

  async Handle_AcceptAllyNegotiation(args, session) {
    requireWarAuthority(session);
    const warNegotiationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    await acceptAllyNegotiation(warNegotiationID, session);
    return null;
  }

  Handle_DeclineAllyOffer(args, session) {
    const warNegotiationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const negotiation = getAuthorizedPendingNegotiation(
      warNegotiationID,
      WAR_NEGOTIATION_TYPE_ALLY_OFFER,
      "ownerID2",
      session,
    );
    if (!negotiation) {
      return null;
    }
    updateWarNegotiation(warNegotiationID, (record) => ({
      ...record,
      negotiationState: WAR_NEGOTIATION_STATE_DECLINED,
      timeDeclined: currentFileTime().toString(),
    }));
    if (negotiation) {
      warNotificationCenter.notifyAllyOfferDeclined(negotiation, {
        characterID: resolveCharacterID(session),
      });
    }
    return null;
  }

  Handle_RetractMutualWar(args, session) {
    const warID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const war = getWarRecord(warID);
    const ownerID = resolveWarEntityID(session);
    if (
      !war ||
      Number(war.mutual) !== 1 ||
      (Number(war.declaredByID) !== Number(ownerID) && Number(war.againstID) !== Number(ownerID))
    ) {
      return null;
    }
    endWarWithReason(warID, {
      retracted: true,
      retractedBy: ownerID,
      retractedByCharacterID: resolveCharacterID(session),
    });
    return null;
  }

  async Handle_AcceptSurrender(args, session) {
    requireWarAuthority(session);
    const warNegotiationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    await acceptSurrender(warNegotiationID, session);
    return null;
  }

  Handle_DeclineSurrender(args, session) {
    const warNegotiationID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const negotiation = getAuthorizedPendingNegotiation(
      warNegotiationID,
      WAR_NEGOTIATION_TYPE_SURRENDER_OFFER,
      "ownerID2",
      session,
    );
    if (!negotiation) {
      return null;
    }
    updateWarNegotiation(warNegotiationID, (record) => ({
      ...record,
      negotiationState: WAR_NEGOTIATION_STATE_DECLINED,
      timeDeclined: currentFileTime().toString(),
    }));
    if (negotiation) {
      warNotificationCenter.notifySurrenderDeclined(negotiation, {
        characterID: resolveCharacterID(session),
      });
    }
    return null;
  }

  Handle_SetOpenForAllies(args, session) {
    const warID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const state = args && args.length > 1 ? args[1] : false;
    const war = getWarRecord(warID);
    if (!war || war.timeFinished || war.retracted || Number(war.mutual) !== 0 ||
        ![false, true, 0, 1].includes(state) ||
        Number(war.againstID) !== Number(resolveWarEntityID(session))) {
      return null;
    }
    updateWarRecord(warID, (war) => {
      war.openForAllies = state ? 1 : 0;
      return war;
    });
    return null;
  }
}

module.exports = WarRegistryService;
