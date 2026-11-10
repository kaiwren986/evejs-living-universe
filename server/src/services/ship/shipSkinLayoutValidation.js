"use strict";

const authority = require("./shipSkinComponentAuthority");
const policy = require("./shipSkinSequencingAuthority");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { positive, fail } = require("./shipSkinState");
const MAX_VECTOR_MAGNITUDE = 1000000;
function vector(value, keys) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of keys) {
    const scalar = Number(value[key] ?? 0);
    if (!Number.isFinite(scalar) || Math.abs(scalar) > MAX_VECTOR_MAGNITUDE) return null;
    result[key] = Object.is(scalar, -0) ? 0 : scalar;
  }
  return result;
}
function coatingConfiguration(raw) {
  const result = {};
  for (const field of ["diffuse_color", "dust_diffuse_color", "fresnel_color", "gloss"]) {
    result[field] = vector(raw?.[field], ["x", "y", "z", "w"]);
    if (!result[field]) return null;
  }
  return result;
}
function patternConfiguration(raw) {
  const position = vector(raw?.transform?.position, ["x", "y", "z"]);
  const rotation = vector(raw?.transform?.rotation, ["x", "y", "z", "w"]);
  const scaling = vector(raw?.transform?.scaling, ["x", "y", "z"]);
  if (!position || !rotation || !scaling || !raw?.projection) return null;
  const scales = Object.values(scaling);
  if (scales.some(value => value <= 0) || Math.max(...scales) - Math.min(...scales) > 0.000001) return null;
  const projection = {};
  for (const field of ["area1", "area2", "area3", "area4"]) projection[field] = raw.projection[field] === true;
  for (const field of ["projection_type_u", "projection_type_v"]) {
    const value = Number(raw.projection[field] || 0);
    if (!Number.isInteger(value) || value < 0 || value > 2) return null;
    projection[field] = value;
  }
  return { projection, transform: { position, rotation, scaling }, mirrored: raw.mirrored === true };
}
function validateShipSkinLayout(raw) {
  const shipTypeID = positive(raw?.ship_type?.sequential);
  const ship = shipTypeID && resolveItemByTypeID(shipTypeID);
  const configuration = ship && Number(ship.categoryID) === 6 && authority.getShipSkinSlotConfiguration(shipTypeID);
  if (!configuration?.slotIDs.length) return fail("SLOT_CONFIGURATION_UNAVAILABLE", 400);
  if (!Array.isArray(raw.slots) || !raw.slots.length || raw.slots.length > configuration.slotIDs.length) return fail("SLOT_DATA_UNAVAILABLE", 400);
  const seen = new Set();
  const slots = [];
  for (const rawSlot of raw.slots) {
    const id = positive(rawSlot?.id?.sequential);
    const slot = authority.getShipSkinSlot(id);
    if (!slot || !configuration.slotIDs.includes(id) || seen.has(id)) return fail("SLOT_DATA_UNAVAILABLE", 400);
    seen.add(id);
    const coating = rawSlot.configuration?.coating;
    const pattern = rawSlot.configuration?.pattern;
    if (Boolean(coating) === Boolean(pattern)) return fail("COMPONENTS_UNAVAILABLE", 400);
    const componentID = positive(coating?.coating?.sequential || pattern?.pattern?.sequential);
    const component = authority.getShipSkinComponent(componentID);
    if (!component?.associatedItems.length || !slot.allowedComponentCategoryIDs.includes(component.categoryID) ||
      component.disallowedSlotIDs.includes(id) || Boolean(pattern) !== [5, 7].includes(id) ||
      Boolean(pattern) !== (component.categoryID === authority.COMPONENT_CATEGORY.PATTERN)) return fail("COMPONENT_NOT_ALLOWED_IN_SLOT", 400);
    const normalized = pattern ? patternConfiguration(pattern.configuration) : coatingConfiguration(coating.configuration);
    if (!normalized) return fail("COMPONENT_DATA_UNAVAILABLE", 400);
    slots.push({ id: { sequential: id }, configuration: pattern
      ? { pattern: { pattern: { sequential: componentID }, configuration: normalized } }
      : { coating: { coating: { sequential: componentID }, configuration: normalized } } });
  }
  const blendMode = Number(raw.pattern_blend_mode || 1);
  if (!Number.isInteger(blendMode) || blendMode < 1 || blendMode > 5) return fail("INVALID_BLEND_MODE", 400);
  if (seen.has(7) && !seen.has(5) || seen.has(6) && !seen.has(5) || seen.has(8) && !seen.has(7)) return fail("UNUSED_COMPONENTS_FITTED", 400);
  if ([2, 3].includes(blendMode) ? seen.has(8) : seen.has(5) !== seen.has(6) || seen.has(7) !== seen.has(8)) return fail("MISSING_PATTERN_COLOR", 400);
  const layout = { ship_type: { sequential: shipTypeID }, slots: slots.sort((a, b) => a.id.sequential - b.id.sequential), pattern_blend_mode: blendMode };
  const tier = policy.calculateSkinDesignTier(layout);
  return tier ? { success: true, layout, tier, points: policy.calculateSkinDesignPoints(layout) } : fail("SLOT_CONFIGURATION_UNAVAILABLE", 400);
}
module.exports = { validateShipSkinLayout };
