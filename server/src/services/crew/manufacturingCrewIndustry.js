"use strict";
const { CrewError } = require("./crewService");
function createManufacturingCrewIndustry({ items, worldData, selling, profitability }) {
  const native = require("../industry/industryRuntimeState");
  const installs = require("../industry/industryInstallSettlementState");
  const data = require("../industry/industryStaticData");
  const { INDUSTRY_ERROR_NAME, INDUSTRY_STATUS } = require("../industry/industryConstants");
  profitability ||= require("./crewProfitability").createCrewProfitability({ worldData, selling });
  const pending = () => { throw new CrewError("CREW_CUSTODY_PENDING", "Manufacturing is awaiting durable confirmation. The saved job will retry.", 503); };
  function actor(ownerID, stationID) {
    if (!worldData.getStationByID(stationID) || !data.getFacilityPayloadByID(stationID)?.activities?.[1]) throw new CrewError("CREW_STATION_INVALID", "Choose an NPC station with a factory.", 400);
    return native.createCrewIndustryActor(ownerID, stationID);
  }
  function describe(ownerID, stationID, blueprintID, runs = 1) {
    const a = actor(ownerID, stationID), blueprint = native.getBlueprintByItemID(blueprintID, a);
    const definition = data.getBlueprintDefinitionByTypeID(blueprint?.typeID), activity = definition?.activities?.manufacturing;
    const item = items.findItemById(blueprintID);
    if (!item || item.ownerID !== ownerID || blueprint?.facilityID !== stationID || ![7, 8].includes(definition?.productCategoryID) ||
        !activity?.materials?.length || activity.products?.length !== 1 || activity.products[0].typeID !== definition.productTypeID || activity.materials.some(m => items.getItemMetadata(m.typeID)?.groupID !== 18)) {
      throw new CrewError("CREW_CARGO_INVALID", "Choose an owned ammo or module blueprint at this station, with a mineral recipe.", 400);
    }
    return { blueprintID, blueprintTypeID: blueprint.typeID, blueprintName: definition.blueprintName,
      productTypeID: definition.productTypeID, name: definition.productName, category: definition.productCategoryID === 8 ? "Ammo" : "Module",
      quantity: activity.products.reduce((sum, p) => sum + p.quantity, 0) * runs,
      materials: native.buildManufacturingMaterials(definition, runs, native.getBlueprintState(blueprintID)?.materialEfficiency || 0)
        .map(m => ({ ...m, name: items.getItemMetadata(m.typeID)?.name || `Type ${m.typeID}` })),
      original: native.getBlueprintState(blueprintID)?.original === true,
      runsRemaining: native.getBlueprintState(blueprintID)?.runsRemaining ?? null };
  }
  function request(ownerID, stationID, order) {
    const location = { itemID: stationID, ownerID, flagID: 4 };
    return { blueprintID: order.blueprintID, activityID: 1, facilityID: stationID, runs: order.runs,
      inputLocation: location, outputLocation: location };
  }
  function availability(result, description) {
    const errors = (result.errors || []).map(e => ({ code: INDUSTRY_ERROR_NAME[e.code] || result.errorMsg || "UNAVAILABLE", args: e.args }));
    const status = errors.some(e => e.code === "MISSING_MATERIAL") ? "waiting_for_materials" : errors.some(e => e.code === "ACCOUNT_FUNDS") ? "insufficient_funds" :
      errors.some(e => e.code === "MISSING_SKILL") ? "needs_skill" : errors.some(e => e.code === "SLOTS_FULL" || e.code === "BLUEPRINT_INSTALLED") ? "factory_busy" : "blueprint_unavailable";
    return { ...description, ready: false, status, errors };
  }
  function inspect(job) {
    const current = native.getJobByID(job.intent.jobID);
    if (!current || current.ownerID !== job.intent.characterID || current.crewOrder?.jobID !== job.jobID || current.crewOrder?.serial !== job.serial) pending();
    return { status: current.status, endDate: current.endDate, jobID: current.jobID };
  }
  async function assess(ownerID, stationID, order, {incomingQuantity=0}={}) {
    let description; try { description = describe(ownerID, stationID, order.blueprintID, order.runs); }
    catch (error) { if (error.code === "CREW_CARGO_INVALID") return { ready: false, status: "blueprint_unavailable", errors: [{ code: "BLUEPRINT_UNAVAILABLE" }] }; throw error; }
    const quote = native.quoteManufacturingJob(actor(ownerID, stationID), request(ownerID, stationID, order));
    const profit = await profitability.evaluate(ownerID, stationID, description, quote.quote?.totalCost, { targetStock: order.targetStock,incomingQuantity });
    const summary = { ...description, cost: quote.quote?.totalCost, timeSeconds: quote.quote?.timeInSeconds,
      baseTimeSeconds: quote.quote?.baseTimeInSeconds, crewSkill: quote.quote?.crewSkill, crewEquipment: quote.quote?.crewEquipment, targetStock: order.targetStock, profit };
    if (!profit.allowed) return { ready: false, status: profit.status, profit, summary };
    if (!quote.success) return { ...availability(quote, description), profit, summary };
    return { ready: true, status: "ready", profit, summary };
  }
  return { station: id => worldData.getStationByID(id), describe, assess,
    stock(ownerID, stationID, typeID) { return items.listContainerItems(ownerID, stationID, 4).filter(i => i.typeID === typeID && !i.custodyReservation)
      .reduce((sum, i) => sum + Math.max(0, i.quantity), 0); },
    catalog(ownerID, stationID) {
      const a = actor(ownerID, stationID);
      return native.listBlueprintInstancesByOwner(ownerID, stationID, a).blueprints.slice(0, 500).flatMap(b => {
        try {
          const description = describe(ownerID, stationID, b.itemID), result = native.quoteManufacturingJob(a, request(ownerID, stationID, { blueprintID: b.itemID, runs: 1 }));
          return [{ ...description, ready: result.success, status: result.success ? "ready" : availability(result).status,
            errors: (result.errors || []).map(e => INDUSTRY_ERROR_NAME[e.code]), cost: result.quote?.totalCost, timeSeconds: result.quote?.timeInSeconds }];
        } catch (error) { if (error.code === "CREW_CARGO_INVALID") return []; throw error; }
      });
    },
    async prepare(ownerID, stationID, order, crewOrder) {
      const assessed = await assess(ownerID, stationID, order);
      if (!assessed.ready) return assessed;
      const result = native.prepareCrewManufacturingIntent(actor(ownerID, stationID), request(ownerID, stationID, order), crewOrder);
      if (!result.success) return { ...availability(result, assessed.summary), profit: assessed.profit };
      return { ready: true, intent: result.data, summary: { ...assessed.summary, cost: result.data.totalCost,
        timeSeconds: result.data.quote.timeInSeconds, baseTimeSeconds: result.data.quote.baseTimeInSeconds, crewSkill: result.data.quote.crewSkill, crewEquipment: result.data.quote.crewEquipment,
        materials: result.data.quote.materials.map(m => ({ ...m, name: items.getItemMetadata(m.typeID)?.name })) } };
    },
    async install(job) {
      const ownerID = job.intent.characterID;
      if (!installs.getPendingIndustryInstallSettlement(ownerID) && !installs.getCrewIndustryInstallResult(ownerID, job.intent.crewOrder)) {
        const profit = await profitability.evaluate(ownerID, job.intent.jobRecord.stationID, job.summary, job.summary.cost, { targetStock: job.summary.targetStock });
        if (!profit.allowed) return { deferred: true, status: profit.status, profit };
        job.summary.profit = profit;
        if (job.summary.priority) job.summary.priority = require("./productionPriority").productionPriority({ profit, timeSeconds: job.summary.timeSeconds });
      }
      const prepared = installs.prepareIndustryInstallSettlement(job.intent);
      if (!prepared.success) pending();
      if (prepared.completed) return prepared.result;
      const result = await installs.settleIndustryInstallSettlement(job.intent.characterID);
      if (!result.success) pending();
      const completed = installs.getCrewIndustryInstallResult(job.intent.characterID, job.intent.crewOrder);
      if (!completed) pending(); return completed;
    },
    inspect,
    deliver(job) {
      let current = inspect(job);
      if (current.status === INDUSTRY_STATUS.READY) {
        const session = require("../chat/sessionRegistry").findSessionByCharacterID(job.intent.characterID);
        native.deliverManufacturingJob(session || actor(job.intent.characterID, job.intent.jobRecord.stationID), current.jobID);
        current = inspect(job);
      }
      return { delivered: current.status === INDUSTRY_STATUS.DELIVERED, cancelled: current.status >= 100 && current.status !== INDUSTRY_STATUS.DELIVERED, ...current };
    },
    acknowledge(job) {
      if (!job.rejected && !native.acknowledgeCrewManufacturingJob(job.intent.characterID, job.intent.jobID, job.intent.crewOrder).success) pending();
      if (!installs.acknowledgeCrewIndustryInstall(job.intent.characterID, job.intent.crewOrder).success) pending();
    },
    starter(ownerID, stationID) {
      actor(ownerID, stationID);
      for (const typeID of [1130, 21858]) {
        const result = items.grantItemToOwnerLocationIdempotent(ownerID, stationID, 4, typeID, 1,
          { singleton: 1, receiptKey: `crew-manufacturing:${ownerID}:starter:${typeID}`, requireDurable: true });
        if (!result.success || !result.durable) pending();
        const ids = result.data.itemIDs || result.data.items.map(i => i.itemID);
        for (const itemID of ids) if (!native.getBlueprintState(itemID)) {
          const initialized = native.initializeBlueprintState(itemID, { original: true, materialEfficiency: 0, timeEfficiency: 0 });
          if (!initialized.success) pending();
        }
      }
      if (!require("../../gameStore").flushTableSync("industryBlueprintState").success) pending();
    },
  };
}
module.exports = { createManufacturingCrewIndustry };
