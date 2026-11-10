"use strict";

// Adapted from ciefa/evejs-ciefa-fork 8781d5580. Select from the cached table
// before entering the updater: even a no-op corporation update persists the
// whole runtime table. Keep the archival predicate and corporation order.
function corporationsWithArchivableApplications(corporations, characterID, exceptApplicationID = null) {
  const matches = [];
  for (const [corporationID, runtime] of Object.entries(corporations || {})) {
    for (const application of Object.values((runtime && runtime.applications) || {})) {
      if (
        application &&
        Number(application.characterID) === Number(characterID) &&
        Number(application.applicationID) !== Number(exceptApplicationID)
      ) {
        matches.push(corporationID);
        break;
      }
    }
  }
  return matches;
}

module.exports = { corporationsWithArchivableApplications };
