"use strict";

// The in-memory audit event list that about 30 services each keep by hand
// (const auditEvents = []; push in recordAuditEvent; slice and clear for
// tests). The module still builds its own event object, because the fields
// differ from service to service; this only holds them.
//
// limit caps the list by dropping the oldest events. The default keeps every
// event, as the hand-written lists do; see the D1.4 note in doc/CLEANUP_PLAN.md
// about those lists growing for the life of the process.

function createAuditLog(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : Infinity;
  const events = [];

  function record(event) {
    events.push(event);
    if (events.length > limit) {
      events.splice(0, events.length - limit);
    }
    return event;
  }

  function list() {
    return events.slice();
  }

  function clear() {
    events.length = 0;
  }

  return { record, list, clear };
}

module.exports = {
  createAuditLog,
};
