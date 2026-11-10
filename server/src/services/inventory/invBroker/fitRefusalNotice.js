"use strict";

// Adapted from ciefa/evejs-ciefa-fork fedc9fdd1. FitFitting must retain the
// client's failedToLoad [(typeID, quantity)] reply; this optional notice
// explains modules that were present but failed fitting validation.
const ROMAN = ["0", "I", "II", "III", "IV", "V"];
const roman = (level) => ROMAN[Number(level)] ?? String(level);
const number = (value) => Number(value) || 0;
const escapeText = (value) => String(value).replace(/&/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;");

function describeFitRefusal(failure, nameOf) {
  const data = failure.data || {};
  switch (failure.errorMsg) {
    case "SKILL_REQUIRED": {
      const skills = Array.isArray(data.missingSkills) && data.missingSkills.length > 0
        ? data.missingSkills : [data];
      return `needs ${skills.map((skill) =>
        `${escapeText(nameOf(number(skill.skillTypeID)))} ${roman(skill.requiredLevel)}`
          + ` (you have ${roman(skill.currentLevel)})`).join(", ")}`;
    }
    case "INSUFFICIENT_CALIBRATION":
      return `needs more calibration than the ship has (${number(data.upgradeLoad)} of ${number(data.upgradeCapacity)})`;
    case "INVALID_FIT_SLOT":
      return "has no compatible slot on this ship";
    case "SLOT_OCCUPIED":
      return "has a slot that is already occupied";
    case "MAX_TYPE_FITTED":
    case "MAX_GROUP_FITTED":
      return `exceeds the limit of ${number(data.noOfModules)} module${number(data.noOfModules) === 1 ? "" : "s"} of this kind`;
    case "RIG_SIZE_MISMATCH":
      return "is the wrong rig size for this ship";
    case "NO_TURRET_HARDPOINTS":
      return "needs a free turret hardpoint";
    case "NO_LAUNCHER_HARDPOINTS":
      return "needs a free launcher hardpoint";
    case "INVALID_SHIP_TYPE":
      return "does not fit this ship type";
    default:
      return "cannot be fitted to this ship";
  }
}

function createFitRefusalLog(nameOf = (typeID) => `type ${typeID}`) {
  const byType = new Map();
  return {
    // Call only after the slot's last retry failed. A temporary refusal that
    // succeeds after another slot is swapped out must never become a notice.
    record(typeID, failure) {
      if (Number(typeID) > 0 && failure && failure.success === false) {
        byType.set(Number(typeID), failure);
      }
    },
    message(unfitted) {
      const entries = [...byType.entries()]
        .filter(([typeID]) => unfitted.has(typeID))
        .sort(([a], [b]) => a - b);
      if (entries.length === 0) return null;
      return "Some available modules could not be fitted:<br>" + entries.map(([typeID, failure]) =>
        `${escapeText(nameOf(typeID))} ${describeFitRefusal(failure, nameOf)}.`).join("<br>");
    },
    notify(session, unfitted) {
      const text = this.message(unfitted);
      if (!text || !session || typeof session.sendNotification !== "function") return false;
      // This supplemental UI message must not replace the normal failure list
      // after inventory changes have already committed.
      try {
        return session.sendNotification("OnRemoteMessage", "clientID", ["CustomNotify", {
          type: "dict", entries: [["notify", { type: "wstring", value: text }]],
        }]);
      } catch (_error) {
        return false;
      }
    },
  };
}

module.exports = { createFitRefusalLog };
