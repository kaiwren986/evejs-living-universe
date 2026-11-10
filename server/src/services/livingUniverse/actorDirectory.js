"use strict";

// Read-only provider boundary for universe actors. Each provider retains its
// authoritative persistence. Recent events are an observation feed, not outbox
// delivery or permission to move goods/pay wallets.
function createActorDirectory() {
  const providers = new Map();
  return Object.freeze({
    register(name, provider) {
      if (!/^[a-z][a-z0-9_-]{0,40}$/.test(name) || typeof provider !== "function" || providers.has(name) || providers.size >= 16) {
        throw new TypeError("Invalid, duplicate or excessive universe provider");
      }
      providers.set(name, provider);
      return () => providers.delete(name);
    },
    snapshot(query = {}) {
      const actors = new Map(), events = new Map();
      for (const [name, provider] of providers) {
        const facts = provider(query);
        if (!Array.isArray(facts.actors) || facts.actors.length > 512 || !Array.isArray(facts.recentEvents) || facts.recentEvents.length > 2560) {
          throw new Error(`Universe provider ${name} exceeded its observation bounds`);
        }
        for (const actor of facts.actors) {
          if (typeof actor.actorID !== "string" || actors.has(actor.actorID)) throw new Error("Duplicate or invalid universe actor identity");
          if (query.ownerID && actor.ownerID !== query.ownerID) continue;
          if (query.systemID && actor.systemID !== query.systemID) continue;
          actors.set(actor.actorID, actor);
        }
        for (const event of facts.recentEvents) {
          if (typeof event.eventID !== "string" || events.has(event.eventID)) throw new Error("Duplicate or invalid universe event identity");
          if (query.ownerID && event.ownerID !== query.ownerID) continue;
          events.set(event.eventID, event);
        }
      }
      return JSON.parse(JSON.stringify({
        actors: [...actors.values()].sort((a, b) => a.actorID.localeCompare(b.actorID)).slice(0, 512),
        recentEvents: [...events.values()].sort((a, b) => b.occurredAtMs - a.occurredAtMs || a.eventID.localeCompare(b.eventID)).slice(0, 100),
      }));
    },
  });
}
let defaultDirectory;
function getDefaultActorDirectory() {
  if (!defaultDirectory) {
    defaultDirectory = createActorDirectory();
    defaultDirectory.register("crews", (query) => require("../crew/crewRuntime").getDefaultCrewService().universeFacts(query));
    defaultDirectory.register("miners", (query) => require("../crew/miningCrewRuntime").getDefaultMiningCrewService().universeFacts(query));
    defaultDirectory.register("refiners", query => require("../crew/refiningCrewRuntime").getDefaultRefiningCrewService().universeFacts(query));
    defaultDirectory.register("manufacturers", query => require("../crew/manufacturingCrewRuntime").getDefaultManufacturingCrewService().universeFacts(query));
    defaultDirectory.register("sellers", query => require("../crew/sellingCrewRuntime").getDefaultSellingCrewService().universeFacts(query));
    defaultDirectory.register("buyers", query => require("../crew/buyingCrewRuntime").getDefaultBuyingCrewService().universeFacts(query));
  }
  return defaultDirectory;
}
module.exports = { createActorDirectory, getDefaultActorDirectory };
