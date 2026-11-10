"use strict";

const fs = require("fs");
const path = require("path");
const log = require("../utils/logger");
const { resolveStoreRoot } = require("../gameStore/storeRoot");

// Saved edits are keyed by the object's TQ source item ID from its authored data file.
// The runtime item ID comes from the prop's position in that file, so it changes when
// props are added or reordered, and a file keyed by it would land on another object.
function sourceItemIDOf(entity) {
  const sourceItemID = String((entity && entity.authoredSpacePropSourceItemID) || "").trim();
  return /^\d{1,20}$/.test(sourceItemID) ? sourceItemID : null;
}
function isEditable(entity) {
  return Boolean(entity && entity.kind === "authoredSpaceProp" &&
    [226, 227, 319].includes(Number(entity.groupID)) && sourceItemIDOf(entity));
}
function systemDirFor(systemID) {
  if (!Number.isSafeInteger(systemID) || systemID <= 0) {
    throw new Error("Invalid LCO system ID");
  }
  return path.join(resolveStoreRoot(), "lco-transforms", String(systemID));
}
function validTransform(value) {
  return value && value.position && ["x", "y", "z"].every((axis) =>
    typeof value.position[axis] === "number" && Number.isFinite(value.position[axis])) &&
    Array.isArray(value.dunRotation) && value.dunRotation.length === 3 &&
    value.dunRotation.every((angle) => typeof angle === "number" && Number.isFinite(angle));
}
function snapshot(entity) {
  return { typeID: entity.typeID, position: { ...entity.position },
    dunRotation: [...(entity.dunRotation || [0, 0, 0])] };
}
function readSavedTransform(file, entity) {
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!validTransform(saved)) throw new Error("not a valid transform");
  if (saved.typeID !== entity.typeID) {
    throw new Error(`saved for type ${saved.typeID}, but the object is type ${entity.typeID}`);
  }
  if (saved.sourceItemID !== sourceItemIDOf(entity)) {
    throw new Error(`saved for source item ${saved.sourceItemID}, not ${sourceItemIDOf(entity)}`);
  }
  return saved;
}
// Runs while a scene is built, including the boot preload, so it never throws: a file it
// cannot use is logged and the authored placement stays.
function applySavedTransforms(systemID, entities) {
  const list = Array.isArray(entities) ? entities : [];
  if (!list.some(isEditable)) return list;
  let dir;
  let fileNames;
  try {
    dir = systemDirFor(Number(systemID));
    if (!fs.existsSync(dir)) return list;
    fileNames = new Set(fs.readdirSync(dir).filter((name) => name.endsWith(".json")));
  } catch (error) {
    log.warn(`[LcoTransforms] Could not read saved LCO transforms for system ${systemID}: ${error.message}`);
    return list;
  }
  const used = new Set();
  const result = list.map((entity) => {
    if (!isEditable(entity)) return entity;
    const fileName = `${sourceItemIDOf(entity)}.json`;
    if (!fileNames.has(fileName)) return entity;
    used.add(fileName);
    const file = path.join(dir, fileName);
    try {
      const saved = readSavedTransform(file, entity);
      return { ...entity, position: { ...saved.position }, dunRotation: [...saved.dunRotation],
        suppressSlimDunRotation: false };
    } catch (error) {
      log.warn(`[LcoTransforms] Ignored saved LCO transform ${file} (${error.message}); using the authored placement.`);
      return entity;
    }
  });
  for (const fileName of fileNames) {
    if (!used.has(fileName)) {
      log.warn(`[LcoTransforms] Ignored saved LCO transform ${path.join(dir, fileName)}: no editable object in system ${systemID} has that source item ID.`);
    }
  }
  return result;
}
function saveTransform(systemID, entity) {
  const saved = snapshot(entity);
  if (!isEditable(entity) || !validTransform(saved)) throw new Error("Invalid LCO transform");
  const file = path.join(systemDirFor(Number(systemID)), `${sourceItemIDOf(entity)}.json`);
  const record = { typeID: saved.typeID, sourceItemID: sourceItemIDOf(entity),
    position: saved.position, dunRotation: saved.dunRotation };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
function displayName(entity) {
  if (entity.itemName) return entity.itemName;
  // Captured props often carry an empty name, so fall back to the type name.
  const { resolveItemByTypeID } = require("../services/inventory/itemTypeRegistry");
  const itemType = resolveItemByTypeID(entity.typeID);
  return (itemType && itemType.name) || `Type ${entity.typeID}`;
}
function execute(scene, argumentText) {
  const [action, target, ...args] = String(argumentText || "").trim().split(/\s+/);
  const usage = "Usage: /lco list | inspect <itemID> | move <itemID> <x> <y> <z> | offset <itemID> <dx> <dy> <dz> | rotate <itemID> <x> <y> <z> | save <itemID>. Metres; rotation degrees about X/Y/Z. Edits are previews until saved.";
  if (!scene || scene.sceneKind !== "solarSystem") return "Enter a public solar system first.";
  if (action === "list") {
    return scene.staticEntities.filter(isEditable).map((e) => `${e.itemID}: ${displayName(e)}`).join("\n") || "No editable LCOs in this system.";
  }
  if (!["inspect", "move", "offset", "rotate", "save"].includes(action)) return usage;
  const entity = scene.staticEntitiesByID.get(Number(target));
  if (!isEditable(entity)) return "Editable LCO not found in this system. Use /lco list.";
  if (["inspect", "save"].includes(action)) {
    if (args.length) return usage;
    if (action === "save") saveTransform(scene.systemID, entity);
    return `${action === "save" ? "Saved" : "Current"} LCO ${entity.itemID}: ${JSON.stringify(snapshot(entity))}`;
  }
  const values = args.map(Number);
  if (values.length !== 3 || !values.every(Number.isFinite)) return usage;
  const next = { ...entity, ...snapshot(entity), suppressSlimDunRotation: false };
  if (action === "rotate") {
    // The client dunRotation tuple is yaw (Y), pitch (X), roll (Z), in degrees.
    next.dunRotation = [values[1], values[0], values[2]];
  } else {
    ["x", "y", "z"].forEach((axis, index) => {
      next.position[axis] = values[index] + (action === "offset" ? entity.position[axis] : 0);
    });
  }
  if (!validTransform(next)) return "Transform must contain finite coordinates.";
  scene.removeStaticEntity(entity.itemID);
  if (!scene.addStaticEntity(next)) {
    scene.addStaticEntity(entity);
    scene.broadcastAddBalls([entity]);
    return "LCO refresh failed; original transform restored.";
  }
  scene.broadcastAddBalls([next]);
  return `Updated LCO ${entity.itemID}. Use /lco save ${entity.itemID} to persist it.`;
}
module.exports = { isEditable, applySavedTransforms, saveTransform, execute };
