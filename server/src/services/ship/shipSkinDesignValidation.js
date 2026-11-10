"use strict";

const state = require("./shipSkinState");
const { validateShipSkinLayout } = require("./shipSkinLayoutValidation");
const { getShipSkinSlotConfiguration } = require("./shipSkinComponentAuthority");

// Shared by live imports and offline conversion. Reads immutable references only.
function validateDesign(characterID, request) {
  const name = String(request.name || "");
  const lineName = String(request.line_name || "");
  if (!name.trim() || [...name].length > 20 || [...lineName].length > 50 || /[\p{Cc}\p{Cs}]/u.test(name + lineName)) return state.fail("INVALID_SKIN_NAME", 400);
  const validated = validateShipSkinLayout(request.layout);
  if (!validated.success) return validated;
  const slotIDs = getShipSkinSlotConfiguration(validated.layout.ship_type.sequential).slotIDs;
  const configurations = [];
  const seen = new Set();
  for (const entry of request.editor_configurations || []) {
    const id = state.positive(entry.id?.sequential);
    // Native Save includes editor state for unfitted pattern slots too.
    if (!slotIDs.includes(id) || seen.has(id) || !entry.config) return state.fail("INVALID_EDITOR_CONFIGURATION", 400);
    seen.add(id);
    const config = {};
    for (const field of ["offset_u_ratio", "offset_v_ratio", "yaw", "pitch", "roll", "scaling"]) {
      const value = Number(entry.config[field] ?? 0);
      if (!Number.isFinite(value) || Math.abs(value) > 1000000) return state.fail("INVALID_EDITOR_CONFIGURATION", 400);
      config[field] = Object.is(value, -0) ? 0 : value;
    }
    configurations.push({ id: { sequential: id }, config });
  }
  const design = { version: 1, characterID, name, lineName, layout: validated.layout, tier: validated.tier };
  return { success: true, design, hex: state.fingerprint(design), editorConfigurations: configurations.sort((a, b) => a.id.sequential - b.id.sequential) };
}
module.exports = { validateDesign };
