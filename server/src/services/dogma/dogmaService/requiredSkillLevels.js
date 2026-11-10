"use strict";

// Required skill levels in the dogma service: GetRequiredSkillLevels answers which skills an
// item type needs, and at which level, as the client asks for them. These are DogmaService
// methods, moved here as they were; dogmaService.js puts them back on the class prototype, so
// `this` is the service.

const path = require("path");
const {
  getRequiredSkillRequirements,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  normalizeNumber,
  buildDict,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));

module.exports = {
  _normalizeTypeID(value) {
    return Math.trunc(normalizeNumber(value, 0)) || 0;
  },

  _buildRequiredSkillLevelDict(typeID) {
    const levelsBySkillID = new Map();
    for (const requirement of getRequiredSkillRequirements(typeID)) {
      const skillTypeID = this._normalizeTypeID(requirement && requirement.skillTypeID);
      const requiredLevel = Math.max(
        1,
        this._normalizeTypeID(
          requirement && (requirement.requiredLevel || requirement.level),
        ),
      );
      if (skillTypeID <= 0) {
        continue;
      }
      levelsBySkillID.set(
        skillTypeID,
        Math.max(levelsBySkillID.get(skillTypeID) || 0, requiredLevel),
      );
    }
    return buildDict(
      [...levelsBySkillID.entries()].sort((left, right) => left[0] - right[0]),
    );
  },

  Handle_GetRequiredSkillLevels(args) {
    const typeID = this._normalizeTypeID(args && args.length > 0 ? args[0] : 0);
    if (typeID <= 0) {
      return buildDict([]);
    }
    return this._buildRequiredSkillLevelDict(typeID);
  },
};
