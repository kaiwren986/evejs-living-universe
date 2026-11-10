"use strict";

// The two kinds of gameplay notification, sorted by the client's own
// dispatch tables:
//
//   Gameplay event  a name michelle.Park applies as a stamped entry
//                   (michelle.py:1482-1614): queued into the one stamped
//                   list at nextDestinyStamp, like an order, and routed to
//                   its Ball's Grid bubble history (scene/destinyHistory.js)
//   Dogma event     a name godma.OnMultiEvent dispatches on arrival
//                   (godma.py:206-252): collected per Observer and sent from
//                   doPostTick with its Character batch, unstamped
//                   (runtime/dogmaEvents.js)
//
// Nothing is both. Any other notification (OnJumpCloakUpdated...) is
// neither, and leaves as it always did.

const GAMEPLAY_EVENT_NAMES = Object.freeze(new Set([
  "OnSpecialFX",
  "OnDamageStateChange",
  "OnDbuffUpdated",
  "OnSlimItemChange",
  "OnDroneStateChange",
  "OnDroneActivityChange",
  "OnShipStateUpdate",
  "OnFleetDamageStateChange",
  "OnSovereigntyChanged",
  "OnDotVictimUpdated",
  "OnClientControllerEvent",
  "OnActivatingWarp",
  "OnDeactivatingWarp",
  "TerminalPlayDestructionEffect",
]));

const DOGMA_EVENT_NAMES = Object.freeze(new Set([
  "OnDamageMessage",
  "OnTarget",
  "OnModuleAttributeChanges",
  // The form an attribute change takes inside OnMultiEvent (godma.py:217).
  "OnModuleAttributeChange",
  "OnGodmaShipEffect",
  "OnGodmaFlushLocation",
  "OnJamStart",
  "OnJamStop",
  // Server's name for a jam's end: the client's own (godma.py:191-199),
  // which OnMultiEvent scatters as it is.
  "OnJamEnd",
  // TQ packs both into the DoDestinyUpdate or OnMultiEvent event list and
  // never sends them alone (golden logs TheBlockadeLevel1, "Minmatar -
  // Tutorial - Career missions part 1").
  "OnEwarStart",
  "OnEwarEnd",
  // A jam's lock clear and its combat log line ride the same list
  // (golden log TheBlockadeLevel1).
  "OnTargetClear",
  "OnCombatMessage",
]));

function isGameplayEvent(name) {
  return GAMEPLAY_EVENT_NAMES.has(name);
}

function isDogmaEvent(name) {
  return DOGMA_EVENT_NAMES.has(name);
}

// "gameplay", "dogma", or null for any other name.
function classifyNotification(name) {
  if (isGameplayEvent(name)) {
    return "gameplay";
  }
  if (isDogmaEvent(name)) {
    return "dogma";
  }
  return null;
}

module.exports = {
  DOGMA_EVENT_NAMES,
  GAMEPLAY_EVENT_NAMES,
  classifyNotification,
  isDogmaEvent,
  isGameplayEvent,
};
