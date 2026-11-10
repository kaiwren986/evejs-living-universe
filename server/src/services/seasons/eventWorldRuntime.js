"use strict";
const campaign = require("./campaignTrailCatalog");
const outreach = require("./gallenteOutreachCatalog");
const bonuses = require("./gallenteEventBonuses");

function refreshBonusPresentation(scene, entity, enabled) {
  // The simulation can refresh before SetState is delivered, or hydrate a new
  // entity with destination values already applied. Neither produces a usable
  // before/after delta for the client's surviving fitting cache.
  const { isReadyForDestiny } = require("../../space/runtime/destinyDeliveryEligibility");
  const session = entity.session;
  if (!isReadyForDestiny(session)) {
    return;
  }
  const previous = entity._electionBonusPresentation || session._electionBonusPresentation;
  if (!enabled && !previous?.enabled && !entity._electionBonusPresentationPending) return;
  if (previous?.session === session && previous.space === session._space &&
      previous.systemID === entity.systemID && previous.enabled === enabled) return;
  if (scene.refreshShipEntityDerivedState(entity)?.success === false) return;

  const notifications = require("../../space/runtime/attributeChangeNotification");
  const warpMultiplier = entity.passiveDerivedState?.attributes?.[600];
  if (!Number.isFinite(warpMultiplier)) return;
  notifications.notifyAttributeChanges(session, [notifications.buildAttributeChange(
    session, entity.itemID, 600, warpMultiplier, null,
  )]);
  // Publish current values even on removal; the now-inactive bonus has no
  // modifier rows left to enumerate. Use the normal module Dogma calculation
  // so skills, fittings and other environmental effects remain included.
  notifications.notifyFittedGenericModuleModifiedAttributesToSession(session, entity, {
    modifierInfo: [160, 84].map(modifiedAttributeID => ({
      func: "LocationRequiredSkillModifier", modifiedAttributeID,
    })),
  });
  entity._electionBonusPresentation = { session, space: session._space,
    systemID: entity.systemID, enabled };
  session._electionBonusPresentation = entity._electionBonusPresentation;
  delete entity._electionBonusPresentationPending;
}

// Scene ticks use simulation time. Schedules deliberately use UTC wall time,
// so time dilation never extends an event or its trader deadline.
function tickScene(scene) {
  const active = campaign.isEnabled(), traders = campaign.canTrade();
  const state = `${active}:${traders}`;
  if (scene._electionWorldPhase !== state) {
    if (scene._electionWorldPhase !== undefined && scene._electionWorldPhase.split(":")[0] !== String(active)) {
      require("../dungeon/dungeonUniverseRuntime").ensureSystemUniversePersistentSites(scene.systemID,
        { force: true, includeMining: false, reason: "event-boundary" });
    }
    const desired = [...campaign.getStaticEntitiesForSystem(scene.systemID), ...outreach.getStaticEntitiesForSystem(scene.systemID)];
    const wanted = new Set(desired.map(row => row.itemID));
    const owned = new Set([
      ...campaign.BEACONS.filter(row => row.placement?.status !== "captured").map(row => row.itemID),
      ...outreach.CENTERS.flatMap(row => [row.itemID, row.beaconID]),
    ]);
    for (const entity of [...scene.staticEntities]) {
      if (owned.has(entity.itemID) && !wanted.has(entity.itemID)) scene.removeStaticEntity(entity.itemID);
    }
    const added = desired.filter(entity => scene.addStaticEntity(entity));
    if (added.length) scene.broadcastAddBalls(added);
    scene._electionWorldPhase = state;
  }
  for (const entity of scene.dynamicEntities.values()) {
    if (!entity.session) continue;
    const enabled = active && bonuses.active(entity);
    if (!enabled && entity._electionBonusActive !== true &&
        !entity._electionBonusPresentation?.enabled && !entity.session._electionBonusPresentation?.enabled &&
        !entity._electionBonusPresentationPending) continue;
    if (entity._electionBonusActive !== enabled && (enabled || entity._electionBonusActive === true)) {
      entity._electionBonusPresentationPending = true;
      const result = scene.refreshShipEntityDerivedState(entity);
      if (result?.success === false) continue;
    }
    entity._electionBonusActive = enabled;
    refreshBonusPresentation(scene, entity, enabled);
  }
}
module.exports = { tickScene };
