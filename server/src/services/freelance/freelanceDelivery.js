"use strict";

const crypto = require("node:crypto");
const itemStore = require("../inventory/itemStore");
const itemCustody = require("../inventory/itemCustody");
const { getCharacterRecord } = require("../character/characterState");
const { getCorporationOffices } = require("../corporation/corporationRuntimeState");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");

const positive = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const copy = (value) => structuredClone(value);
const failure = (errorMsg, data) => ({ success: false, errorMsg, ...(data ? { data } : {}) });

function getDeliveryConfiguration(project) {
  return project?.configuration?.parameters?.find((entry) => entry?.corporation_item_delivery)?.corporation_item_delivery || null;
}

// Matchers contain alternatives. Unknown alternatives never match; an absent
// matcher means any value. Creation rejects unsupported matcher definitions.
function matches(matcher, values) {
  const entries = (matcher?.values || []).filter((entry) => entry?.values?.length);
  return !entries.length || entries.some((entry) => values[entry.value_type] &&
    entry.values.some((value) => String(value) === String(values[entry.value_type])));
}

function createFreelanceDelivery(ports) {
  const { readRoot, writeRoot, runSerialized, events } = ports;
  const nowMs = ports.nowMs || Date.now;
  const custody = ports.itemCustody || itemCustody;

  function finishDelivery(deliveryID) {
    let root = readRoot();
    let delivery = root.deliveries?.[deliveryID];
    if (!delivery) return failure("DELIVERY_NOT_FOUND");
    if (delivery.status === "succeeded") return { success: true, data: { delivery: copy(delivery), project: copy(root.projects[delivery.projectID]) } };
    if (delivery.status === "failed") return failure(delivery.errorMsg || "ITEM_NOT_FOUND_AT_LOCATION");

    // The durable command can replay after the original stack was split,
    // moved, destroyed or the pilot disconnected. Its original intent owns
    // the quantity and recipient; later client input cannot replace them.
    const receipt = custody.getCommittedReceipt(delivery.custodyKey);
    let result;
    if (receipt.success && receipt.committed) result = { success: true, durable: true };
    else {
      if (!receipt.success || receipt.ambiguous) return failure("DELIVERY_RECOVERY_PENDING");
      const source = itemStore.findItemById(delivery.itemID);
      const sourceSnapshot = delivery.sourceSnapshot;
      if (!source || Object.keys(sourceSnapshot).some((key) => Number(source[key] || 0) !== Number(sourceSnapshot[key] || 0))) {
        delivery.status = "failed";
        delivery.errorMsg = "ITEM_NOT_FOUND_AT_LOCATION";
        delivery.completedMs = nowMs();
        writeRoot(root);
        return failure(delivery.errorMsg);
      }
      result = custody.transfer(delivery.command);
    }
    if (!result?.success || result.pending || !result.durable) {
      return failure(result?.errorMsg || "DELIVERY_RECOVERY_PENDING");
    }
    const durable = custody.getCommittedReceipt(delivery.custodyKey);
    if (!durable.success || !durable.committed) return failure("DELIVERY_RECOVERY_PENDING");

    root = readRoot();
    delivery = root.deliveries[deliveryID];
    if (delivery.status === "succeeded") return { success: true, data: { delivery: copy(delivery), project: copy(root.projects[delivery.projectID]) } };
    const project = root.projects[delivery.projectID];
    const participant = project?.participants?.[String(delivery.characterID)];
    if (!project || !participant) return failure("DELIVERY_RECOVERY_PENDING");
    participant.progress += delivery.quantityRequested;
    participant.unitsUnredeemed += delivery.quantityRequested;
    participant.contributionsCount += 1;
    participant.lastContributionAtMs = nowMs();
    project.currentProgress += delivery.quantityRequested;
    project.updatedMs = nowMs();
    const completed = project.currentProgress >= project.targetProgress;
    if (completed) {
      project.state = 3;
      project.finishTimeMs = nowMs();
    }
    delivery.status = "succeeded";
    delivery.quantityDelivered = delivery.quantityRequested;
    delivery.quantityReturned = 0;
    delivery.completedMs = nowMs();
    writeRoot(root);
    const payload = { project: copy(project), participant: copy(participant), characterID: delivery.characterID,
      contributed: delivery.quantityRequested, remainder: 0, totalProjectProgress: project.currentProgress,
      totalContributors: Object.values(project.participants).filter((entry) => entry.progress > 0).length };
    events?.emit("project-progressed", payload);
    events?.emit("participant-contributed", payload);
    if (completed) events?.emit("project-completed", { project: copy(project) });
    const changes = result?.data?.changes || durable.resultData?.changes || durable.resultData?.committedChanges || [];
    events?.emit("itemdelivery-succeeded", { delivery: copy(delivery), project: copy(project), characterID: delivery.characterID, changes: copy(changes) });
    ports.onProgress?.(copy(project));
    return { success: true, data: { delivery: copy(delivery), project: copy(project), participant: copy(participant), changes: copy(changes) } };
  }

  function recoverPending() {
    for (const delivery of Object.values(readRoot().deliveries || {})) {
      if (delivery.status !== "escrowed") continue;
      const result = finishDelivery(delivery.deliveryID);
      if (!result.success && readRoot().deliveries[delivery.deliveryID]?.status === "escrowed") return result;
    }
    return { success: true };
  }

  async function deliverItem(input = {}) {
    return runSerialized(() => {
      const recovered = recoverPending();
      if (!recovered.success) return recovered;
      const root = readRoot();
      root.deliveries ||= {};
      const characterID = positive(input.characterID);
      const requestKey = String(input.requestKey || input.requestID || "");
      if (!characterID || !requestKey || requestKey.length > 256) return failure("INVALID_DELIVERY_REQUEST");
      const fingerprint = JSON.stringify([String(input.projectID), characterID, positive(input.itemID),
        positive(input.quantity), input.deliveryLocation || {}, input.itemLocation || {}]);
      const existing = Object.values(root.deliveries).find((entry) => entry.characterID === characterID && entry.requestKey === requestKey);
      if (existing) return existing.fingerprint === fingerprint ? finishDelivery(existing.deliveryID) : failure("INVALID_DELIVERY_REQUEST");
      const project = root.projects[input.projectID];
      if (!project) return failure("PROJECT_NOT_FOUND");
      if (project.state !== 1 || (project.deadlineMs && nowMs() >= project.deadlineMs)) return failure("PROJECT_DOES_NOT_ALLOW_ITEM_DELIVERY");
      if (project.configuration?.contribution_method?.name !== "DeliverItem") return failure("PROJECT_DOES_NOT_ALLOW_ITEM_DELIVERY");
      const participant = project.participants[String(characterID)];
      if (!participant || participant.state !== 1) return failure("CHARACTER_NOT_COMMITTED");
      const character = getCharacterRecord(characterID);
      const stationID = positive(input.deliveryLocation?.station?.sequential);
      if (!stationID || positive(character?.stationID) !== stationID) return failure("DELIVERY_LOCATION_DOES_NOT_EXIST");
      const config = getDeliveryConfiguration(project);
      if (!config || !matches(config.corporation_office_location, { station: stationID })) return failure("DELIVERY_LOCATION_DOES_NOT_EXIST");
      const office = getCorporationOffices(project.ownerCorporationID).find((entry) => positive(entry.stationID) === stationID && !entry.impounded);
      if (!office?.officeID) return failure("DELIVERY_LOCATION_DOES_NOT_EXIST");
      const item = itemStore.findItemById(positive(input.itemID));
      if (!item || positive(item.ownerID) !== characterID) return failure("ITEM_NOT_OWNED_BY_DELIVERER");
      if (positive(item.locationID) !== stationID || Number(item.flagID) !== 4 ||
        positive(input.itemLocation?.item?.sequential) !== stationID || Number(input.itemLocation?.flag?.value ?? input.itemLocation?.flag) !== 4) return failure("INVALID_ITEM_LOCATION");
      const type = resolveItemByTypeID(item.typeID);
      if (!type || !matches(config.item_type, { item_type: item.typeID, item_group: type.groupID })) return failure("INVALID_ITEM_TYPE");
      // Assembled items may own nested cargo/fittings; moving just their top
      // row is not sufficient evidence of safe whole-object delivery.
      if (Number(item.singleton) !== 0) return failure("INVALID_ITEM_TYPE");
      const quantity = positive(input.quantity);
      const maxQuantity = ports.getContributionMaxQuantity(project, participant);
      if (!quantity || quantity > maxQuantity || quantity > positive(item.stacksize ?? item.quantity)) return failure("QUANTITY_TOO_HIGH", { project, participant, maxQuantity });
      const deliveryID = crypto.randomUUID();
      const custodyKey = `freelance-delivery:${deliveryID}`;
      const delivery = { deliveryID, projectID: project.projectID, characterID, itemID: item.itemID,
        sourceSnapshot: Object.fromEntries(["ownerID", "locationID", "flagID", "typeID", "singleton", "stacksize", "inventoryCustodyRevision"].map((key) => [key, Number(item[key] || 0)])),
        requestKey, fingerprint, quantityRequested: quantity, quantityDelivered: 0, quantityReturned: 0,
        status: "escrowed", createdMs: nowMs(), custodyKey,
        command: { actor: characterID, reason: itemCustody.CUSTODY_REASON.FREELANCE_ITEM_DELIVERY,
          idempotencyKey: custodyKey, items: { itemID: item.itemID, quantity },
          from: { kind: "station-hangar", ownerID: characterID, locationID: stationID, flagID: 4 },
          to: { kind: "corporation-office", ownerID: project.ownerCorporationID, locationID: office.officeID, flagID: 184 } } };
      root.deliveries[deliveryID] = delivery;
      writeRoot(root);
      return finishDelivery(deliveryID);
    });
  }

  return { deliverItem, recoverPending, recoverDeliveries: () => runSerialized(recoverPending),
    getDeliveryStatus(deliveryID, characterID) {
      const delivery = readRoot().deliveries?.[deliveryID];
      return delivery && delivery.characterID === positive(characterID)
        ? { success: true, data: { delivery: copy(delivery) } } : failure("DELIVERY_NOT_FOUND");
    } };
}

module.exports = { createFreelanceDelivery, getDeliveryConfiguration };
