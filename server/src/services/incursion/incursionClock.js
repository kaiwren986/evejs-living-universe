"use strict";

// Lifecycle time can advance by days in a gameplay scenario. Persistence
// ownership, IPC deadlines and wallet workers must retain the real wall clock.
let provider = null;
function now() { return provider ? provider() : Date.now(); }
function setNowProvider(next = null) {
  if (next !== null && typeof next !== "function") throw new TypeError("Incursion clock provider must be a function");
  provider = next;
}
module.exports = { now, setNowProvider };
