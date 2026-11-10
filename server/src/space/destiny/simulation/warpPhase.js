"use strict";

// A Ball in warp proper: WARP mode past its align, its effectStamp the tick
// it entered warp. Lifecycle and presentation only.
function isEntityInActiveWarp(entity) {
  return Boolean(
    entity &&
      String(entity.mode || "").trim().toUpperCase() === "WARP" &&
      Number(entity.effectStamp) >= 0,
  );
}

module.exports = {
  isEntityInActiveWarp,
};
