"use strict";

// A character's own five attributes: charisma, intelligence, memory, perception
// and willpower, as the character's record has them, before an implant or
// anything else is added to them.

const OWN_ATTRIBUTE_NAMES = Object.freeze({
  164: "charisma",
  165: "intelligence",
  166: "memory",
  167: "perception",
  168: "willpower",
});
const DEFAULT_OWN_ATTRIBUTE = 20;

/**
 * The five by attribute ID, read from a character record's characterAttributes:
 * by attribute ID where the record has it so, else by name, and 20 where it has
 * neither.
 */
function readCharacterOwnAttributes(characterAttributes = {}) {
  const source = characterAttributes || {};
  const own = {};
  for (const [attributeID, name] of Object.entries(OWN_ATTRIBUTE_NAMES)) {
    own[attributeID] = Number(source[attributeID] ?? source[name] ?? DEFAULT_OWN_ATTRIBUTE);
  }
  return own;
}

module.exports = {
  readCharacterOwnAttributes,
};
