"use strict";

// The values of a changed attribute as they go on the game's own wire.
//
// A notice of a changed attribute is a tuple,
//
//   ('OnModuleAttributeChange', ownerID, itemID, attributeID, time, newValue,
//    oldValue, time)
//
// sent in a list as OnModuleAttributeChanges, or beside other events in the
// (event, time) pairs of OnMultiEvent. Tranquility's new and old values are
// floats whatever they hold: of the 23,074 changes its client was told of in the
// recordings, over 111 attributes, every value is a float but those of a few
// attributes: 805 (a count of charges: 30, 29, 28), 2 (isOnline: 1 and 0), a
// character's own five (164 to 168) where they are the character's own values,
// and a time (2729), and the integer 0 that a shield or an armor damage is 19
// times of 3,980.
//
// The server holds a value as a plain number, and the marshaller sends a whole
// one as an integer; the client is Python 2, where one integer divided by
// another is floored. A number is made a float for the marshaller by wrapping
// it ({ type: "real", value }), and a wrapped value is an object to everything
// else that reads it: the senders' own tuples, which other code and the tests
// read, and the JSON the web gateway's session makes of the same notice. So the
// values are wrapped here, in a copy, only where the game's own session
// marshals a notice that has one recipient:
//
//   - clientSession.sendNotification, which passes its notify type and its own
//     reader to ClientSession.encodeNotificationPayload;
//   - Destiny's Character batch Dogma part and a direct OnMultiEvent, which
//     call toWireNotificationPayload themselves before the encode.
//
// A payload shared by many sessions (a Grid bubble batch) is encoded once as
// given and never comes through here.

const CHANGE_NAME = "OnModuleAttributeChange";
const CHANGE_ATTRIBUTE_INDEX = 3;
const CHANGE_NEW_VALUE_INDEX = 5;
const CHANGE_OLD_VALUE_INDEX = 6;
const NOTICES_WITH_CHANGES = new Set(["OnModuleAttributeChanges", "OnMultiEvent"]);
// isOnline and a count of charges: integers on Tranquility whatever they hold.
const INTEGER_ATTRIBUTE_IDS = new Set([2, 805]);
// A character's own five: charisma, intelligence, memory, perception, willpower.
// Each is the integer the character's record has (19, 20) where nothing is added
// to it, and the float the reckoning gives where something is (25.0, with an
// implant's 6): Tranquility tells of 164 going 19 to 19, to 25.0 from 19, and
// back to 19 from 25.0.
const CHARACTER_OWN_ATTRIBUTE_IDS = new Set([164, 165, 166, 167, 168]);

function itemsOf(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value &&
    typeof value === "object" &&
    (value.type === "tuple" || value.type === "list") &&
    Array.isArray(value.items)
    ? value.items
    : null;
}

function withItems(value, items) {
  return Array.isArray(value) ? items : { ...value, items };
}

// One change with its new and old value made floats, or the change itself where
// there is nothing to make: its attribute is one that is an integer, or neither
// value is a plain number. readOwnAttributes gives the character's own five by
// attribute ID, or null where nobody can say: the five are then as given.
function toWireChange(items, readOwnAttributes) {
  const attributeID = Number(items[CHANGE_ATTRIBUTE_INDEX]);
  if (INTEGER_ATTRIBUTE_IDS.has(attributeID)) {
    return items;
  }
  const isOwnAttribute = CHARACTER_OWN_ATTRIBUTE_IDS.has(attributeID);
  let ownValue = null;
  if (isOwnAttribute) {
    const ownAttributes = readOwnAttributes();
    if (!ownAttributes) {
      return items;
    }
    ownValue = Number(ownAttributes[attributeID]);
  }
  let wire = items;
  for (const index of [CHANGE_NEW_VALUE_INDEX, CHANGE_OLD_VALUE_INDEX]) {
    const value = items[index];
    if (typeof value !== "number" || (isOwnAttribute && value === ownValue)) {
      continue;
    }
    if (wire === items) {
      wire = items.slice();
    }
    wire[index] = { type: "real", value };
  }
  return wire;
}

// A value with every change in it made so, in a copy of what holds one; what
// holds none is handed back as it is.
function toWireValue(value, readOwnAttributes) {
  const items = itemsOf(value);
  if (!items) {
    return value;
  }
  if (items[0] === CHANGE_NAME) {
    const wire = toWireChange(items, readOwnAttributes);
    return wire === items ? value : withItems(value, wire);
  }
  let copied = null;
  for (let index = 0; index < items.length; index += 1) {
    const wire = toWireValue(items[index], readOwnAttributes);
    if (wire !== items[index]) {
      if (!copied) {
        copied = items.slice();
      }
      copied[index] = wire;
    }
  }
  return copied ? withItems(value, copied) : value;
}

/**
 * A notification's payload as the game's own session marshals it. For the two
 * notices that carry attribute changes it is a copy with each change's new and
 * old value made a float; for every other, and where there is nothing to change,
 * the payload itself.
 *
 * `options.readOwnAttributes` gives the session's character's own five
 * attributes by attribute ID (or null). It is asked at most once for a payload,
 * and only where one of the five has changed. A reader that throws counts as
 * one that gave null: the five are then as given.
 */
function toWireNotificationPayload(notifyType, payloadTuple, options = {}) {
  if (!NOTICES_WITH_CHANGES.has(notifyType)) {
    return payloadTuple;
  }
  const reader = options && options.readOwnAttributes;
  let ownAttributes;
  const readOwnAttributes = () => {
    if (ownAttributes === undefined) {
      ownAttributes = null;
      if (typeof reader === "function") {
        try {
          ownAttributes = reader() || null;
        } catch (_error) {
          ownAttributes = null;
        }
      }
    }
    return ownAttributes;
  };
  return toWireValue(payloadTuple, readOwnAttributes);
}

module.exports = {
  toWireNotificationPayload,
};
