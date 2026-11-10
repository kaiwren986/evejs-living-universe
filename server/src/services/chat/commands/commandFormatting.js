"use strict";

// Chat command number formatting shared by more than one command family: distances in space.

function formatDistanceMeters(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0 m";
  }
  if (numeric >= 1000) {
    return `${(numeric / 1000).toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} km`;
  }
  return `${Math.round(numeric).toLocaleString("en-US")} m`;
}

module.exports = {
  formatDistanceMeters,
};
