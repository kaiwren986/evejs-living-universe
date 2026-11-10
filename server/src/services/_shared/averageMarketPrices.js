"use strict";

// The average market prices this server serves, in one place.
//
// config.GetAverageMarketPrices answers a client with them, and that answer is
// the only average and adjusted prices the client has
// (eve/common/script/sys/eveCfg.py, 404 and 524, keeps it as
// cfg._averageMarketPrice; inventorycommon/typeHelpers.py GetAdjustedAveragePrice
// and GetAveragePrice, 92-109, read a type's price out of it and answer None
// for a type it does not hold).
//
// Code the client and the server share reckons from the adjusted price: a
// blueprint's price, and with it every industry job's cost
// (eve/common/script/util/industryCommon.py GetBlueprintPrice, 520-543). The
// client reckons a job's cost itself before it sends the job, so the server
// has to reckon from the very prices it served. What answers the client and
// what the server reckons with are both to be read from here, so that the two
// cannot come apart.
//
// A type is served a price where it is published and its base price is above
// nought, and its average and its adjusted price are both that base price.

const path = require("path");

const {
  TABLE,
  readStaticRows,
} = require(path.join(__dirname, "./referenceData"));

let averageMarketPricesByTypeID = null;

// Every served price, by typeID, in the item types' own order.
function getAverageMarketPrices() {
  if (averageMarketPricesByTypeID) {
    return averageMarketPricesByTypeID;
  }

  const pricesByTypeID = new Map();
  for (const itemType of readStaticRows(TABLE.ITEM_TYPES)) {
    if (
      itemType &&
      Number(itemType.typeID) > 0 &&
      Number(itemType.basePrice) > 0 &&
      itemType.published !== false
    ) {
      const basePrice = Number(itemType.basePrice) || 0;
      pricesByTypeID.set(
        Number(itemType.typeID),
        Object.freeze({
          averagePrice: basePrice,
          adjustedPrice: basePrice,
        }),
      );
    }
  }

  averageMarketPricesByTypeID = pricesByTypeID;
  return averageMarketPricesByTypeID;
}

// A type's adjusted average price as a client has it, and null for a type that
// is served none (typeHelpers.py GetAdjustedAveragePrice, 92-96).
function getAdjustedAveragePrice(typeID) {
  const price = getAverageMarketPrices().get(Number(typeID));
  return price ? price.adjustedPrice : null;
}

module.exports = {
  getAdjustedAveragePrice,
  getAverageMarketPrices,
};
