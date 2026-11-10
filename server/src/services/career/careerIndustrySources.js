"use strict";

// Called inside recoverable domain settlement lanes before their durable intent
// is removed. A refused evidence checkpoint therefore replays the same outcome.
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const ORE_GROUPS = new Set([457, 458, 459, 460, 462]);
function supports(source) {
  return source?.kind === "career-event" && (source.metric === "blueprint-purchased" ||
    /^reprocessed-ore:(457|458|459|460|462)$/.test(String(source.metric)));
}

function recordReprocessing(settlement) {
  if (!positive(settlement?.characterID) || typeof settlement.operationID !== "string" || !settlement.operationID)
    return { success: false, errorMsg: "CAREER_REPROCESSING_IDENTITY_REQUIRED" };
  for (const [index, input] of (settlement.reprocessedEvents || []).entries()) {
    const type = resolveItemByTypeID(positive(input.inputTypeID));
    if (Number(type?.categoryID) !== 25 || !ORE_GROUPS.has(Number(type.groupID)) || !positive(input.quantity)) continue;
    const result = require("./careerEventLedger").record(settlement.characterID, {
      kind: "reprocess", id: `reprocessing:${settlement.operationID}:${index}`,
      oreGroupID: Number(type.groupID), amount: positive(input.quantity),
    });
    if (!result?.success) return result || { success: false, errorMsg: "CAREER_REPROCESSING_WRITE_FAILED" };
  }
  return { success: true };
}
function recordBlueprintPurchase(saga) {
  if (!positive(saga?.buyerCharacterID) || typeof saga.operationKey !== "string" || !saga.operationKey ||
      saga.status !== "forward" || !saga.fillResponse) return { success: true };
  const type = resolveItemByTypeID(positive(saga.typeID));
  if (Number(type?.categoryID) !== 9) return { success: true };
  // Originals and copies share a type. The delivered custody leg, rather than
  // the order's type alone, proves that this buyer received an original.
  const items = Array.isArray(saga.itemLegs)
    ? saga.itemLegs.filter(leg => leg?.compensated !== true).map(leg => leg?.destinationItem)
    : (saga.deliveryChanges || []).map(change => change?.item);
  const original = items.find(item => item && positive(item.itemID) && Number(item.typeID) === Number(saga.typeID) &&
    Number(item.ownerID) === Number(saga.buyerCharacterID) &&
    [0, 1].includes(Number(item.singleton)) && Number(item.quantity) !== -2);
  if (!original) return { success: true };
  return require("./careerEventLedger").record(saga.buyerCharacterID, {
    kind: "blueprint-purchase", id: saga.operationKey,
  });
}

module.exports = { recordReprocessing, recordBlueprintPurchase, supports };
