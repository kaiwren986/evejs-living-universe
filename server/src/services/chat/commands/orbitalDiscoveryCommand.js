"use strict";

const { getSessionCurrentSolarSystemID, isConnectedSessionInAbyssalDeadspace } = require("./commandSessionLocation");
const { hasPrivateScope } = require("../../planet/planetOrbitalPlacement");

function escapeLabel(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function buildOrbitalDiscoveryMessage(session, argumentText = "", ports = {}) {
  if (!session || !session.characterID) return "No character selected.";
  if (isConnectedSessionInAbyssalDeadspace(session)) return "Planet offices are available in known-space solar systems.";
  const systemID = getSessionCurrentSolarSystemID(session);
  if (!systemID) return "Current solar system is unknown.";
  const input = String(argumentText || "").trim();
  const planetID = input ? Number(input) : 0;
  if (input && (!/^\d+$/.test(input) || !Number.isSafeInteger(planetID) || planetID <= 0)) {
    return "Usage: /orbitals [planetID]";
  }
  const state = ports.orbitalState || require("../../planet/planetOrbitalState");
  const resolvePlanet = ports.resolvePlanet || ((id) => require("../../../space/worldData").getCelestialByID(id));
  const findItem = ports.findItem || ((id) => require("../../inventory/itemStore").findItemById(id));
  if (planetID && Number(resolvePlanet(planetID)?.solarSystemID) !== Number(systemID)) {
    return "That planet is not in your current solar system.";
  }
  const records = [
    ...state.listOrbitalsForSystem(systemID),
    ...state.listDefaultCustomsOfficesForSystem(systemID),
  ].filter((orbital) => {
    const item = findItem(orbital.itemID);
    return !orbital.destroyedAtMs && [1025, 4736].includes(Number(orbital.groupID)) &&
      (typeof state.isCustomsInventoryOrbitalRecord !== "function" || state.isCustomsInventoryOrbitalRecord(orbital)) &&
      ![-2, -3].includes(Number(orbital.state)) &&
      (!planetID || Number(orbital.planetID) === planetID) &&
      !hasPrivateScope(item) && !hasPrivateScope(item && item.spaceState);
  }).sort((left, right) => Number(left.planetID) - Number(right.planetID));
  if (!records.length) return "No customs offices or skyhooks found for that selection.";
  return [
    "Planet offices in your current system:",
    ...records.map((orbital) => {
      const planet = resolvePlanet(orbital.planetID);
      const label = Number(orbital.groupID) === 4736 ? "Orbital Skyhook" : "Customs Office";
      return `${escapeLabel(planet && (planet.itemName || planet.name) || `Planet ${orbital.planetID}`)}: ` +
        `<a href="showinfo:${Number(orbital.typeID)}//${Number(orbital.itemID)}">${label}</a> ` +
        `(ID ${Number(orbital.itemID)}${Number(orbital.groupID) === 4736
          ? `, ${[0, 1].includes(Number(orbital.state)) ? "online" : "offline"}` : ""})`;
    }),
    "Undock to warp to an office or transfer goods. Online skyhooks also appear in the Sovereignty window.",
  ].join("<br>");
}

module.exports = { buildOrbitalDiscoveryMessage };
