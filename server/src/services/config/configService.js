"use strict";

/**
 * Config Service
 *
 * Handles client config/settings calls including owner/location/ticker lookups.
 *
 * V23.02 client calls cfg.eveowners.Prime(), cfg.evelocations.Prime(),
 * cfg.corptickernames.Prime() during character selection, which make remote
 * calls to GetMultiOwnersEx, GetMultiLocationsEx, GetMultiCorpTickerNamesEx.
 *
 * EVEmu returns "TupleSet" format: ([columnNames], [[row1], [row2], ...])
 * For empty results: empty tuple ().
 */

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));

const log = require(path.join(__dirname, "../../utils/logger"));
/** const.typeCorporation: an owner row's type for a corporation. */
const TYPE_CORPORATION = 2;
const database = require("../../gameStore")
const {
  toClientSafeDisplayName,
  toClientSafeText,
} = require(path.join(
  __dirname,
  "../_shared/clientNameUtils",
));
const { getCharacterShips } = require(path.join(
  __dirname,
  "../character/characterState",
));
const { normalizeCharacterGender } = require(path.join(
  __dirname,
  "../character/characterIdentity",
));
const {
  findItemById,
  findShipItemById,
  isCargoContainerInventoryItem,
} = require(path.join(
  __dirname,
  "../inventory/itemStore",
));
const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  getAverageMarketPrices,
} = require(path.join(__dirname, "../_shared/averageMarketPrices"));
const { buildKeyVal, buildList, buildMarshalReal } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const { getStationRecord } = require(path.join(
  __dirname,
  "../_shared/stationStaticData",
));
const { getStaticOwnerRecord } = require(path.join(
  __dirname,
  "../_shared/stationStaticData",
));
const {
  getAllianceShortNameRecord,
  getCorporationRecord,
  getCorporationStationSolarSystems,
  getOwnerLookupRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const structureState = require(path.join(
  __dirname,
  "../structure/structureState",
));
const {
  getAgentByID,
} = require(path.join(__dirname, "../agent/agentAuthority"));
const {
  resolveSessionCharacterID,
} = require(path.join(__dirname, "../_shared/sessionIdentity"));

/**
 * Extract a plain JS array from a value that might be:
 *   - A plain array: [1, 2, 3]
 *   - A marshal list object: {type: 'list', items: [1, 2, 3]}
 */
function extractList(val) {
  if (Array.isArray(val)) return val;
  if (
    val &&
    typeof val === "object" &&
    val.type === "list" &&
    Array.isArray(val.items)
  ) {
    return val.items;
  }
  return [];
}

function buildAveragePriceEntry(price, adjustedPrice = null) {
  const normalizedAverage = Number(price) || 0;
  const normalizedAdjusted =
    adjustedPrice == null ? normalizedAverage : Number(adjustedPrice) || 0;

  return buildKeyVal([
    ["averagePrice", normalizedAverage],
    ["adjustedPrice", normalizedAdjusted],
  ]);
}

let staticLocationRowsById = null;
let averageMarketPricesPayload = null;

function normalizeSolarSystemID(value, fallback = null) {
  const numericValue = Number(value);
  if (Number.isInteger(numericValue) && numericValue > 0) {
    return numericValue;
  }
  return fallback;
}

function resolveSessionSolarSystemID(session, fallback = null) {
  return normalizeSolarSystemID(
    session &&
      (session.solarSystemID ??
        session.solarsystemid ??
        session.solarSystemID2 ??
        session.solarsystemid2),
    fallback,
  );
}

function buildLocationRow(
  locationID,
  locationName,
  solarSystemID = null,
  position = null,
  fallbackName = null,
) {
  return [
    locationID,
    toClientSafeDisplayName(
      locationName,
      fallbackName || `Location ${locationID}`,
    ),
    normalizeSolarSystemID(solarSystemID, null),
    // Real numbers, as Tranquility answers every row ([0, '(none)', None, 0.0, 0.0, 0.0, None] and the rest): a whole
    // number here, nought above all, is otherwise sent as an integer.
    buildMarshalReal(Number(position && position.x) || 0),
    buildMarshalReal(Number(position && position.y) || 0),
    buildMarshalReal(Number(position && position.z) || 0),
    null,
  ];
}

function canSessionSeeSpaceEntity(scene, entity, session) {
  if (!scene || !entity || !session || !session._space) {
    return false;
  }

  try {
    if (
      scene.dynamicEntities instanceof Map &&
      scene.dynamicEntities.get(entity.itemID) === entity
    ) {
      return (
        typeof scene.canSessionSeeDynamicEntity === "function" &&
        scene.canSessionSeeDynamicEntity(session, entity) === true
      );
    }
    if (
      scene.staticEntitiesByID instanceof Map &&
      scene.staticEntitiesByID.get(entity.itemID) === entity
    ) {
      return (
        typeof scene.canSessionSeeStaticEntityForSession === "function" &&
        scene.canSessionSeeStaticEntityForSession(session, entity) === true
      );
    }
    if (typeof scene.getVisibleEntitiesForSession === "function") {
      const visibleEntities = scene.getVisibleEntitiesForSession(session);
      return Array.isArray(visibleEntities) && visibleEntities.includes(entity);
    }
  } catch {
    // ignored: a visibility check that throws means not visible (false, fail closed)
    return false;
  }

  return false;
}

/**
 * Resolve a runtime object's client-visible name and position without making
 * the scene a general location oracle. The client only needs this row for an
 * object in the pilot's current ballpark, so hidden and off-grid entities must
 * continue to receive the ordinary numeric placeholder.
 */
function buildVisibleSpaceEntityLocationRow(
  itemID,
  session,
) {
  let spaceRuntime = null;
  try {
    spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
  } catch {
    // ignored: the space runtime is not loaded in this process; the ordinary placeholder is used (null)
    return null;
  }

  let scene = null;
  try {
    scene =
      spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : null;
  } catch {
    // ignored: a session whose scene cannot be read gets the ordinary placeholder (null)
    return null;
  }

  const entity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(itemID)
      : null;
  if (!canSessionSeeSpaceEntity(scene, entity, session)) {
    return null;
  }

  const entityName = [entity.slimName, entity.itemName, entity.name].find(
    (candidate) => typeof candidate === "string" && candidate.trim(),
  );
  if (!entityName) {
    return null;
  }

  // No solar system and the place nought, as Tranquility answers an object in space the client asks about, though it
  // is in the client's ballpark (recorded: a mission site's asteroids, [id, '', None, 0.0, 0.0, 0.0, None]). The
  // client puts its own row, the ball's system and place, for what it does not ask about (michelle, Recordset.Hint).
  return buildLocationRow(
    itemID,
    entityName,
    null,
    null,
    `Location ${itemID}`,
  );
}

function canNameNestedCorporationContainer(item, session) {
  const corporationID = Number(session && (session.corporationID || session.corpid));
  const recovery = require("../structure/structureAssetSafetyRecovery");
  const safety = require("../structure/structureAssetSafetyState");
  const { getDockedLocationID } = require("../structure/structureLocation");
  const { getCorporationOfficeByInventoryID } = require("../corporation/corporationRuntimeState");
  const { getStationByID } = require("../../space/worldData");
  const seen = new Set();
  let current = item;
  while (current && seen.size < 64) {
    const itemID = Number(current.itemID);
    const locationID = Number(current.locationID);
    if (!corporationID || seen.has(itemID) || Number(current.ownerID) !== corporationID ||
        !recovery.isOrdinarySourceContainer(current)) return false;
    seen.add(itemID);
    const wrap = safety.getWrapByID(locationID, { refresh: false });
    if (wrap) {
      const delivered = safety.getDeliveredWrapItem(locationID);
      if (!delivered || Number(delivered.locationID) !== getDockedLocationID(session) ||
          !safety.sessionCanManageWrap(session, wrap)) return false;
      try { recovery.sourcePath(item, wrap); }
      catch { return false; }
      return true;
    }
    // flag0 also occurs inside other containers. Only a proven inventory
    // endpoint grants the additional name; a solar-system endpoint still
    // goes through the scene visibility gate.
    if (Number(current.flagID) !== 0) {
      const office = getCorporationOfficeByInventoryID(corporationID, locationID);
      const structure = structureState.getStructureByID(locationID, { refresh: false });
      if (getStationByID(locationID) || (office && !office.impounded) ||
          Number(structure?.ownerCorpID) === corporationID) return true;
    }
    current = findItemById(locationID);
  }
  return false;
}

function getStaticLocationRowsById() {
  if (staticLocationRowsById) {
    return staticLocationRowsById;
  }

  const rowsById = new Map();
  const addLocation = (
    locationID,
    locationName,
    solarSystemID = null,
    position = null,
  ) => {
    const numericId = Number(locationID) || 0;
    if (numericId <= 0 || !locationName) {
      return;
    }
    rowsById.set(
      numericId,
      buildLocationRow(numericId, locationName, solarSystemID, position),
    );
  };

  for (const system of readStaticRows(TABLE.SOLAR_SYSTEMS)) {
    addLocation(
      system.solarSystemID,
      system.solarSystemName,
      system.solarSystemID,
      system.position,
    );
  }
  for (const station of readStaticRows(TABLE.STATIONS)) {
    addLocation(
      station.stationID,
      station.stationName,
      station.solarSystemID,
      station.position,
    );
  }
  for (const celestial of readStaticRows(TABLE.CELESTIALS)) {
    addLocation(
      celestial.itemID,
      celestial.itemName,
      celestial.solarSystemID,
      celestial.position,
    );
  }
  for (const asteroidBelt of readStaticRows(TABLE.ASTEROID_BELTS)) {
    addLocation(
      asteroidBelt.itemID,
      asteroidBelt.itemName,
      asteroidBelt.solarSystemID,
      asteroidBelt.position,
    );
  }
  for (const stargate of readStaticRows(TABLE.STARGATES)) {
    addLocation(
      stargate.itemID,
      stargate.itemName,
      stargate.solarSystemID,
      stargate.position,
    );
  }

  staticLocationRowsById = rowsById;
  return rowsById;
}

function getAverageMarketPricesPayload() {
  if (averageMarketPricesPayload) {
    return averageMarketPricesPayload;
  }

  // Which types have a price, and what it is, is the one table that industry
  // prices a blueprint from as well (_shared/averageMarketPrices.js).
  const entries = [...getAverageMarketPrices()].map(([typeID, price]) => [
    typeID,
    buildAveragePriceEntry(price.averagePrice, price.adjustedPrice),
  ]);

  averageMarketPricesPayload = {
    type: "dict",
    entries,
  };
  return averageMarketPricesPayload;
}

function buildShipItemOwnerRow(itemID) {
  const shipItem = findShipItemById(itemID);
  if (!shipItem) {
    return null;
  }

  return [
    Number(shipItem.itemID) || Number(itemID) || 0,
    toClientSafeDisplayName(
      shipItem.shipName || shipItem.itemName || `Ship ${itemID}`,
      `Ship ${itemID}`,
    ),
    Number(shipItem.shipTypeID || shipItem.typeID) || 606,
    0,
    null,
  ];
}

function buildAgentOwnerRow(ownerID) {
  const agentRecord = getAgentByID(ownerID);
  if (!agentRecord) {
    return null;
  }

  return [
    Number(agentRecord.agentID) || Number(ownerID) || 0,
    toClientSafeDisplayName(
      agentRecord.ownerName || `Agent ${ownerID}`,
      `Agent ${ownerID}`,
    ),
    Number(agentRecord.ownerTypeID) || 1373,
    Number(agentRecord.gender) || 0,
    null,
  ];
}

// An ID past 2^53 (a command node's, 9988400000367006) arrives as a BigInt,
// which JSON.stringify refuses. A throw in a debug line answered the client
// None, and cfg.evelocations.Prime raised on it.
function formatRequestedIDs(ids) {
  return JSON.stringify(ids, (key, value) => (typeof value === "bigint" ? value.toString() : value));
}

class ConfigService extends BaseService {
  constructor() {
    super("config");
  }

  // Builds the universe location index at boot, so the first GetMultiLocationsEx
  // of a login does not stall every pilot for the half second it takes.
  static warmStaticLocationRows() {
    return getStaticLocationRowsById().size;
  }

  /**
   * GetMultiOwnersEx — fetch owner info for a list of entity IDs.
   *
   * EVEmu returns TupleSet: ([ownerID, ownerName, typeID, gender, ownerNameID], [rows])
   * The client's _Prime method expects a tuple, NOT a list.
   */
  Handle_GetMultiOwnersEx(args, session) {
    const rawArg = args && args.length > 0 ? args[0] : [];
    const requestedIds = extractList(rawArg);
    log.debug(
      `[ConfigService] GetMultiOwnersEx: ${formatRequestedIDs(requestedIds)}`,
    );

    const characterResult = database.read("characters", "/")
    const characters = characterResult.success ? characterResult.data : {}

    const rows = [];

    for (const id of requestedIds) {
      const numericId = Number(id);
      if (!Number.isFinite(numericId)) {
        continue;
      }
      const normalizedId = Math.trunc(numericId);

      // Check if this is a character ID we know about
      const charData = normalizedId > 0 ? characters[String(normalizedId)] : null;
      if (charData) {
        rows.push([
          normalizedId, // ownerID
          toClientSafeText(charData.characterName || "Unknown"), // ownerName
          charData.typeID || 1373, // typeID
          normalizeCharacterGender(charData.gender, 1), // gender
          null, // ownerNameID
        ]);
        continue;
      }

      const agentOwnerRow = normalizedId > 0
        ? buildAgentOwnerRow(normalizedId)
        : null;
      if (agentOwnerRow) {
        rows.push(agentOwnerRow);
        continue;
      }

      const shipItemOwnerRow = normalizedId > 0
        ? buildShipItemOwnerRow(normalizedId)
        : null;
      if (shipItemOwnerRow) {
        rows.push(shipItemOwnerRow);
        continue;
      }

      const staticOwner = normalizedId > 0
        ? getStaticOwnerRecord(normalizedId, session)
        : null;
      const dynamicOwner = normalizedId > 0
        ? getOwnerLookupRecord(normalizedId)
        : null;
      const ownerRecord = dynamicOwner || staticOwner;
      if (ownerRecord) {
        rows.push([
          ownerRecord.ownerID,
          // A missing name keeps going out as None rather than empty unicode.
          ownerRecord.ownerName
            ? toClientSafeText(ownerRecord.ownerName)
            : ownerRecord.ownerName,
          ownerRecord.typeID,
          ownerRecord.gender,
          null,
        ]);
        continue;
      }

      // NPC corps (1000000-1999999 range)
      if (normalizedId >= 1000000 && normalizedId < 2000000) {
        rows.push([
          normalizedId,
          `Corporation ${normalizedId}`,
          2, // typeID = 2 (Corporation)
          0, // gender
          null, // ownerNameID
        ]);
        continue;
      }

      // Unknown entity — return a generic row so the client's cfg._Prime
      // can unpack it and inspect the typeID (e.g. to rule out IsCharacter).
      // Without this, the client gets an empty result and crashes with
      // "ValueError: need more than 0 values to unpack".
      rows.push([
        normalizedId,
        `Item ${normalizedId}`,
        0, // typeID = 0 (not a character/corp/alliance)
        0, // gender
        null, // ownerNameID
      ]);
    }

    if (rows.length === 0) {
      return [];
    }

    // Return TupleSet: ([columnNames], [rows])
    return [["ownerID", "ownerName", "typeID", "gender", "ownerNameID"], rows];
  }

/**
 * GetMultiLocationsEx — fetch location info for a list of location IDs.
 *
 * cfg.evelocations uses:
 * [locationID, locationName, solarSystemID, x, y, z, locationNameID]
 */
  Handle_GetMultiLocationsEx(args, session) {
    const rawArg = args && args.length > 0 ? args[0] : [];
    const requestedIds = extractList(rawArg);
    log.debug(
      `[ConfigService] GetMultiLocationsEx: ${formatRequestedIDs(requestedIds)}`,
    );

    const characterResult = database.read("characters", "/")
    const characters = characterResult.success ? characterResult.data : {}
    const station = getStationRecord(session);
    const sessionSolarSystemID = resolveSessionSolarSystemID(
      session,
      normalizeSolarSystemID(station && station.solarSystemID, null),
    );
    const sessionCharacterID = resolveSessionCharacterID(session);
    const locationRowsById = new Map();
    const staticRowsById = getStaticLocationRowsById();
    const campaignTrail = require("../seasons/campaignTrailCatalog");
    if (campaignTrail.isEnabled()) {
      const outreach = require("../seasons/gallenteOutreachCatalog");
      for (const location of [...campaignTrail.LOCATIONS, ...outreach.getStaticEntitiesForSystem(outreach.SYSTEM_ID)]) {
        locationRowsById.set(location.itemID, buildLocationRow(
          location.itemID, location.itemName, location.solarSystemID,
          location.position,
        ));
      }
    }

    if (station) {
      locationRowsById.set(
        station.stationID,
        buildLocationRow(
          station.stationID,
          station.stationName,
          station.solarSystemID,
          station.position,
        ),
      );
      locationRowsById.set(
        station.orbitID,
        buildLocationRow(
          station.orbitID,
          station.orbitName || station.stationName,
          station.solarSystemID,
        ),
      );
      locationRowsById.set(
        station.solarSystemID,
        buildLocationRow(
          station.solarSystemID,
          station.solarSystemName || `System ${station.solarSystemID}`,
          station.solarSystemID,
        ),
      );
      locationRowsById.set(
        station.constellationID,
        buildLocationRow(
          station.constellationID,
          station.constellationName || `Constellation ${station.constellationID}`,
          null,
        ),
      );
      locationRowsById.set(
        station.regionID,
        buildLocationRow(
          station.regionID,
          station.regionName || `Region ${station.regionID}`,
          null,
        ),
      );
    }

    const shipNameById = new Map();
    const charNameById = new Map();
    for (const [charId, c] of Object.entries(characters)) {
      const cid = parseInt(charId, 10);
      if (!c || typeof c !== "object") {
        continue;
      }
      if (Number.isInteger(cid)) {
        charNameById.set(cid, c.characterName || `Character ${cid}`);
      }
      for (const ship of getCharacterShips(cid)) {
        if (ship && Number.isInteger(ship.shipID)) {
          shipNameById.set(ship.shipID, ship.shipName || "Ship");
        }
      }
    }

    const rows = [];

    for (const id of requestedIds) {
      const parsedId = Number(id);
      if (!Number.isFinite(parsedId)) {
        continue;
      }
      const numericId = Math.trunc(parsedId);
      if (numericId === 0) {
        rows.push(buildLocationRow(0, "(none)", null, null, "(none)"));
        continue;
      }
      if (numericId < 0) {
        continue;
      }

      if (locationRowsById.has(numericId)) {
        rows.push(locationRowsById.get(numericId));
        continue;
      } else {
        const structure = structureState.getStructureByID(numericId, {
          refresh: false,
        });
        if (structure) {
          // A structure's row as Tranquility answers it: its name, no solar system, the place nought (recorded in
          // the structure browser, the Agency and a mission: 'Algogille - OLIMP I', None, 0.0, 0.0, 0.0). The
          // client has the rest of the structure from the structure directory, and a row with the ball's own system
          // and place from michelle once the structure is in its ballpark (Recordset.Hint).
          rows.push(
            buildLocationRow(
              structure.structureID,
              structure.itemName || structure.name || `Structure ${structure.structureID}`,
              null,
              null,
              `Structure ${structure.structureID}`,
            ),
          );
          continue;
        }
      }

      if (staticRowsById.has(numericId)) {
        rows.push(staticRowsById.get(numericId));
      } else if (shipNameById.has(numericId)) {
        // A ship's row as Tranquility answers it: its name, no solar system, the place nought (recorded:
        // [1054810010120, 'Iteron Mark V - Flannel Alpha', None, 0.0, 0.0, 0.0, None]).
        rows.push(
          buildLocationRow(
            numericId,
            shipNameById.get(numericId),
            null,
            null,
            `Ship ${numericId}`,
          ),
        );
      } else if (charNameById.has(numericId)) {
        rows.push(
          buildLocationRow(
            numericId,
            charNameById.get(numericId),
            sessionSolarSystemID,
            null,
            `Character ${numericId}`,
          ),
        );
      } else if (numericId >= 60000000 && numericId < 64000000) {
        rows.push(
          buildLocationRow(
            numericId,
            `Station ${numericId}`,
            sessionSolarSystemID,
            null,
            `Station ${numericId}`,
          ),
        );
      } else if (numericId >= 30000000 && numericId < 40000000) {
        rows.push(
          buildLocationRow(
            numericId,
            `System ${numericId}`,
            numericId,
            null,
            `System ${numericId}`,
          ),
        );
      } else {
        const inventoryItem = findItemById(numericId);
        // shipNameById above is built by sweeping every character's own ships,
        // so a hull owned by anything else has no name at all: one parked in a
        // corporation hangar division, or delivered straight into one by a
        // corporation industry job, fell through this whole chain to the
        // "Location <itemID>" fallback below. The name is on the row, and who
        // holds a hull does not change what it is called -- that sweep already
        // hands every character's ship names to every session, so reading the
        // row here adds no reach.
        //
        // Stowed hulls only. flagID 0 means the hull is an entity in space, and
        // those still go to buildVisibleSpaceEntityLocationRow below, which
        // asks the scene whether this session may see it at all -- naming one
        // straight off the row would answer that question without asking.
        const namedShipItem = findShipItemById(numericId);
        const persistedShipName =
          namedShipItem &&
          Number(namedShipItem.flagID) !== 0 &&
          typeof namedShipItem.itemName === "string" &&
          namedShipItem.itemName.trim()
            ? namedShipItem.itemName
            : null;
        // A container parked in a corporation hangar is owned by the
        // CORPORATION, not by the member who put it there, so the
        // character-owned test alone sent every one of them to the
        // "Location <itemID>" fallback below. The client only asks for this
        // name once the container is singleton (uix.IsValidNamedItem), which
        // is why assembling one appears to rename it while the stack it came
        // from still shows its type name, and why renaming it looks like it
        // does not stick -- SetLabel does persist the name, but the next
        // cfg.evelocations prime asks here again and gets the placeholder.
        //
        // Widened to the session's own corporation rather than to any owner:
        // unlike hulls, which shipNameById above already hands to every
        // session, nothing broadcasts container names, so naming an arbitrary
        // owner's container would be reach this handler does not have today.
        //
        // The corporation case is restricted to STOWED containers. flagID 0
        // can mean a floating container or an ordinary nested inventory row.
        // The latter needs proven stowed ancestry; space entities still go to
        // buildVisibleSpaceEntityLocationRow, which asks the scene whether
        // this session may see the object at all -- naming one off the row
        // would answer that question without asking. The character-owned case
        // deliberately keeps its existing behaviour: a pilot's own jettisoned
        // can is already named off the row from anywhere, and narrowing that
        // here would be an unrelated change.
        const containerOwnerID = inventoryItem
          ? Number(inventoryItem.ownerID)
          : 0;
        const sessionCorporationID = Number(
          (session && (session.corporationID || session.corpid)) || 0,
        );
        const persistedItemName =
          persistedShipName ||
          (
            sessionCharacterID > 0 &&
            inventoryItem &&
            isCargoContainerInventoryItem(inventoryItem) &&
            (
              containerOwnerID === sessionCharacterID ||
              (
                sessionCorporationID > 0 &&
                containerOwnerID === sessionCorporationID &&
                (Number(inventoryItem.flagID) !== 0 ||
                  canNameNestedCorporationContainer(inventoryItem, session))
              )
            ) &&
            typeof inventoryItem.itemName === "string" &&
            inventoryItem.itemName.trim()
              ? inventoryItem.itemName
              : null
          );
        const spaceEntityRow =
          sessionCharacterID > 0 && !persistedItemName
            ? buildVisibleSpaceEntityLocationRow(
                numericId,
                session,
              )
            : null;
        rows.push(
          // A named item's row as Tranquility answers an item's: no solar system, the place nought, wherever the
          // item is (its rename's notice the same).
          persistedItemName
            ? buildLocationRow(
                numericId,
                persistedItemName,
                null,
                null,
                `Item ${numericId}`,
              )
            : spaceEntityRow ||
              buildLocationRow(
                numericId,
                `Location ${numericId}`,
                sessionSolarSystemID,
                null,
                `Location ${numericId}`,
              ),
        );
      }
    }

    if (rows.length === 0) {
      return [];
    }

    return [
      ["locationID", "locationName", "solarSystemID", "x", "y", "z", "locationNameID"],
      rows,
    ];
  }
  Handle_GetMultiAllianceShortNamesEx(args, session) {
    const rawArg = args && args.length > 0 ? args[0] : [];
    const allianceIDs = extractList(rawArg);
    log.debug(
      `[ConfigService] GetMultiAllianceShortNamesEx: ${formatRequestedIDs(allianceIDs)}`,
    );

    const rows = allianceIDs
      .map((allianceID) => getAllianceShortNameRecord(allianceID))
      .filter(Boolean)
      .map((record) => [record.allianceID, toClientSafeText(record.shortName)]);

    if (rows.length === 0) {
      return [];
    }

    return [["allianceID", "shortName"], rows];
  }

  /**
   * GetMultiCorpTickerNamesEx — fetch corporation ticker names.
   *
   * Called by cfg.corptickernames.Prime()
   */
  Handle_GetMultiCorpTickerNamesEx(args, session) {
    const rawArg = args && args.length > 0 ? args[0] : [];
    const requestedIds = extractList(rawArg);
    log.debug(
      `[ConfigService] GetMultiCorpTickerNamesEx: ${formatRequestedIDs(requestedIds)}`,
    );

    const rows = [];

    for (const id of requestedIds) {
      const numericId = Number(id) || 0;
      if (numericId <= 0) {
        continue;
      }

      const staticOwner = getStaticOwnerRecord(numericId, session);
      const dynamicOwner = getOwnerLookupRecord(numericId);
      const corporationRecord = getCorporationRecord(numericId);
      const ownerRecord = dynamicOwner || staticOwner;
      // A row for a corporation only: an ID that is none (a character, an alliance, owner 1) has no ticker, and the
      // client's Recordset keeps it as one it failed to prime (cfg.py _Prime: knownLuzers).
      if (!corporationRecord && !(ownerRecord && Number(ownerRecord.typeID) === TYPE_CORPORATION)) {
        continue;
      }
      rows.push([
        numericId,
        toClientSafeText(
          ownerRecord && ownerRecord.tickerName ? ownerRecord.tickerName : "CORP",
        ),
        corporationRecord ? corporationRecord.shape1 ?? null : null,
        corporationRecord ? corporationRecord.shape2 ?? null : null,
        corporationRecord ? corporationRecord.shape3 ?? null : null,
        corporationRecord ? corporationRecord.color1 ?? null : null,
        corporationRecord ? corporationRecord.color2 ?? null : null,
        corporationRecord ? corporationRecord.color3 ?? null : null,
      ]);
    }

    // Recordset._Prime always unpacks (header, rows), including when the
    // requested alliance owners have no corporation ticker.
    return [
      [
        "corporationID",
        "tickerName",
        "shape1",
        "shape2",
        "shape3",
        "color1",
        "color2",
        "color3",
      ],
      rows,
    ];
  }

  Handle_GetMapObjects(args, session) {
    log.debug("[ConfigService] GetMapObjects");
    return { type: "list", items: [] };
  }

  Handle_GetStationSolarSystemsByOwner(args, session) {
    const ownerID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[ConfigService] GetStationSolarSystemsByOwner(${ownerID})`);
    return buildList(
      getCorporationStationSolarSystems(ownerID).map((solarSystemRecord) =>
        buildKeyVal([
          ["ownerID", Number(solarSystemRecord && solarSystemRecord.ownerID) || ownerID],
          ["solarSystemID", Number(solarSystemRecord && solarSystemRecord.solarSystemID) || 0],
          ["stationCount", Number(solarSystemRecord && solarSystemRecord.stationCount) || 0],
        ]),
      ),
    );
  }

  Handle_GetMultiGraphicsEx(args, session) {
    log.debug("[ConfigService] GetMultiGraphicsEx");
    return [];
  }

  Handle_GetBlackListedPlanets(args, session) {
    log.debug("[ConfigService] GetBlackListedPlanets");
    return { type: "list", items: [] };
  }

  Handle_GetOldStationData(args, session) {
    log.debug("[ConfigService] GetOldStationData");
    return { type: "list", items: [] };
  }

  Handle_GetAverageMarketPrices(args, session) {
    log.debug("[ConfigService] GetAverageMarketPrices");
    return getAverageMarketPricesPayload();
  }
}

module.exports = ConfigService;
