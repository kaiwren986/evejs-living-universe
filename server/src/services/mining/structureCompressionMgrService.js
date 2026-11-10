"use strict";

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const {
  syncInventoryItemForSession,
} = require(path.join(__dirname, "../character/characterState"));
const {
  findItemById,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  fanCorporationOfficeInventoryChanges,
} = require(path.join(__dirname, "../inventory/corporationOfficeInventoryObservers"));
const {
  matchesTypeList,
} = require(path.join(__dirname, "../inventory/typeListAuthority"));
const {
  compressInventoryItem,
  decompressGasInStructure,
  getGasDecompressionCharacterEfficiency,
  getStructureGasDecompressionEfficiency,
  itemIsInStructureCompressionSource,
} = require("./miningIndustry");
const {
  resolveReprocessingContext,
} = require(path.join(__dirname, "../reprocessing"));

const STRUCTURE_COMPRESSIBLE_TYPE_LIST_ID = 336;

function syncInventoryChangesToSession(session, changes = []) {
  const normalizedChanges = (Array.isArray(changes) ? changes : [])
    .filter((change) => change && change.item);
  for (const change of normalizedChanges) {
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: true,
      },
    );
  }
  // Compression rewrites a stack in place, and a corporation division is an
  // accepted source, so the ore another member is looking at can change type
  // and volume under them with nothing sent to say so.
  fanCorporationOfficeInventoryChanges(normalizedChanges, {
    actorSession: session || null,
  });
}

function buildCompressionTuple(resultData) {
  if (!resultData) {
    return null;
  }
  return [
    resultData.sourceItemID,
    resultData.sourceTypeID,
    resultData.sourceQuantity,
    resultData.outputItemID,
    resultData.outputTypeID,
    resultData.outputQuantity,
  ];
}

class StructureCompressionMgrService extends BaseService {
  constructor() {
    super("structureCompressionMgr");
  }

  Handle_CompressItemInStructure(args, session) {
    const itemID = Number(args && args[0]) || 0;
    const contextResult = resolveReprocessingContext(session);
    if (!contextResult.success || !contextResult.data || contextResult.data.dockedKind !== "structure") {
      return null;
    }

    const item = findItemById(itemID);
    if (!item || !itemIsInStructureCompressionSource(item, contextResult.data, session)) {
      return null;
    }
    if (!matchesTypeList(item, STRUCTURE_COMPRESSIBLE_TYPE_LIST_ID)) {
      return null;
    }

    const compressResult = compressInventoryItem(itemID);
    if (!compressResult.success || !compressResult.data) {
      return null;
    }
    syncInventoryChangesToSession(session, [compressResult.data.change]);
    return buildCompressionTuple(compressResult.data);
  }

  Handle_DecompressGasInStructure(args, session) {
    const itemID = Number(args && args[0]) || 0;
    const decompressResult = decompressGasInStructure(session, itemID);
    if (!decompressResult.success || !decompressResult.data) {
      return null;
    }
    syncInventoryChangesToSession(session, decompressResult.data.changes);
    return buildCompressionTuple(decompressResult.data);
  }

  Handle_GetMyGasDecompressionEfficiency(args, session) {
    const contextResult = resolveReprocessingContext(session);
    if (!contextResult.success || !contextResult.data) {
      return [0, 0];
    }
    return [
      getStructureGasDecompressionEfficiency(contextResult.data),
      getGasDecompressionCharacterEfficiency(contextResult.data.skillMap),
    ];
  }
}

module.exports = StructureCompressionMgrService;
