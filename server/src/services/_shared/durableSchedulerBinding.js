"use strict";

// The per-module durable scheduler slot that about 35 services each wrote by
// hand: bind validates and stores a scheduler, unbind clears it only when it is
// the one bound (or when called with no scheduler), and get reads it.
//
//   const durableScheduler = createDurableSchedulerBinding({
//     requires: ["schedule", "cancel"],
//     message: "bill scheduler requires schedule and cancel functions",
//   });
//   function bindDurableScheduler(scheduler) { return durableScheduler.bind(scheduler); }
//
// beforeBind and afterBind run around the store for modules that reset their
// own state on bind; afterUnbind runs after a successful unbind.

function createDurableSchedulerBinding(options = {}) {
  const requires = Array.isArray(options.requires) && options.requires.length > 0
    ? options.requires.slice()
    : ["schedule"];
  const message = options.message ||
    `durable scheduler requires ${requires.join(" and ")} function${requires.length > 1 ? "s" : ""}`;
  let scheduler = null;

  function bind(candidate) {
    if (!candidate || requires.some((name) => typeof candidate[name] !== "function")) {
      throw new TypeError(message);
    }
    if (typeof options.beforeBind === "function") options.beforeBind(candidate);
    scheduler = candidate;
    if (typeof options.afterBind === "function") options.afterBind(candidate);
    return true;
  }

  function unbind(candidate = null) {
    if (candidate && scheduler !== candidate) {
      return false;
    }
    scheduler = null;
    if (typeof options.afterUnbind === "function") options.afterUnbind();
    return true;
  }

  function get() {
    return scheduler;
  }

  return { bind, unbind, get };
}

module.exports = {
  createDurableSchedulerBinding,
};
