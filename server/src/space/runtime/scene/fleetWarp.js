"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  buildFleetWarpCommandAssociationPlan,
  clearFleetWarpCommandAssociation,
  commitFleetWarpCommandAssociationPlan,
  getFleetWarpCommandAssociation,
  haveSameFleetWarpCommandAssociation,
  isFleetWarpInProgress,
} = require(path.join(
  runtimeEntryDirname,
  "../services/fleets/fleetWarpCommandAssociation.js",
));

module.exports = {

associateSuccessfulFleetWarpFollower(
    leaderSession,
    followerSession,
    commandToken,
    options = {},
  ) {
    const leaderResult = options.leaderResult || null;
    const followerResult = options.followerResult || null;
    if (
      !leaderResult ||
      leaderResult.success !== true ||
      leaderResult.redundant === true ||
      !followerResult ||
      followerResult.success !== true ||
      followerResult.redundant === true
    ) {
      return false;
    }

    const leaderEntity = this.getShipEntityForSession(leaderSession);
    const followerEntity = this.getShipEntityForSession(followerSession);
    // Queued warps start pending at the next Destiny tick, and
    // only a ship with its warp in progress can join the fleet warp, so the
    // association waits in the queue behind them. Until it applies, the
    // ships are joining the fleet warp (isEntityJoiningSessionFleetWarp).
    if (
      (leaderResult.queued === true || followerResult.queued === true) &&
      this.queueMovementChange(
        followerEntity,
        "fleetWarpAssociation",
        () => {
          this.noteJoinedFleetWarp(commandToken, followerEntity);
          return this.associateSuccessfulFleetWarpFollower(
            leaderSession,
            followerSession,
            commandToken,
            options,
          );
        },
      )
    ) {
      this.noteJoiningFleetWarp(commandToken, leaderEntity, followerEntity);
      return true;
    }
    const leaderEntityKey = getEntityMapKey(leaderEntity && leaderEntity.itemID);
    const followerEntityKey = getEntityMapKey(followerEntity && followerEntity.itemID);
    if (
      leaderEntityKey === null ||
      followerEntityKey === null ||
      this.dynamicEntities.get(leaderEntityKey) !== leaderEntity ||
      this.dynamicEntities.get(followerEntityKey) !== followerEntity
    ) {
      return false;
    }

    const plan = buildFleetWarpCommandAssociationPlan({
      token: commandToken,
      sceneSystemID: this.systemID,
      leaderEntity,
      leaderSession,
      leaderGeneration: options.leaderGeneration,
      followerEntity,
      followerSession,
      followerGeneration: options.followerGeneration,
    });
    return commitFleetWarpCommandAssociationPlan(plan);
  },

getActiveFleetWarpFormationID(
    entity,
    _now = this.getCurrentSimTimeMs(),
  ) {
    const association = getFleetWarpCommandAssociation(entity, {
      sceneSystemID: this.systemID,
      getEntityByID: (entityID) => this.getEntityByID(entityID),
    });
    return association ? association.token : "";
  },

isEntityInSessionFleetWarpFormation(
    session,
    entity,
    _now = this.getCurrentSimTimeMs(),
  ) {
    if (!session || !session._space || !entity) {
      return false;
    }
    const egoEntity = this.getShipEntityForSession(session);
    if (!egoEntity || egoEntity.session !== session) {
      return false;
    }
    return haveSameFleetWarpCommandAssociation(egoEntity, entity, {
      sceneSystemID: this.systemID,
      getEntityByID: (entityID) => this.getEntityByID(entityID),
    });
  },

// Ships about to join a fleet warp, by command: the leader and the
// followers still to join. A follower's align goes out before its
// association with the leader's command (associateSuccessfulFleetWarpFollower),
// when the leader is already in its warp's quiet window: while its order is
// given (beyonce brackets it), and while the association waits in the
// Movement queue behind the queued warps.
noteJoiningFleetWarp(commandToken, leaderEntity, followerEntity) {
    if (!(this._joiningFleetWarps instanceof Map)) {
      this._joiningFleetWarps = new Map();
    }
    let members = this._joiningFleetWarps.get(commandToken);
    if (!members) {
      members = new Set([leaderEntity]);
      this._joiningFleetWarps.set(commandToken, members);
    }
    members.add(followerEntity);
  },

noteJoinedFleetWarp(commandToken, followerEntity) {
    const members = this._joiningFleetWarps instanceof Map
      ? this._joiningFleetWarps.get(commandToken)
      : null;
    if (!members) {
      return;
    }
    members.delete(followerEntity);
    // Only the leader left: every follower has had its turn.
    if (members.size <= 1) {
      this._joiningFleetWarps.delete(commandToken);
    }
  },

// Whether `entity` joins the fleet warp the session's ship is in, or joining,
// while a follower's warp order is being given or its association waits in
// the Movement queue. The queue applies the members' warps before their
// association, so the aligns go out first.
isEntityJoiningSessionFleetWarp(session, entity) {
    if (
      !(this._joiningFleetWarps instanceof Map) ||
      this._joiningFleetWarps.size === 0 ||
      !session ||
      !session._space ||
      !entity
    ) {
      return false;
    }
    const egoEntity = this.getShipEntityForSession(session);
    if (!egoEntity || egoEntity.session !== session) {
      return false;
    }
    const isMember = (candidate, token, members) => (
      members.has(candidate) ||
      this.getActiveFleetWarpFormationID(candidate) === token
    );
    for (const [token, members] of this._joiningFleetWarps) {
      if (
        isMember(egoEntity, token, members) &&
        isMember(entity, token, members)
      ) {
        return true;
      }
    }
    return false;
  },

isFleetWarpFormationCompanionForSession(
    session,
    entity,
    now = this.getCurrentSimTimeMs(),
  ) {
    if (!this.isEntityInSessionFleetWarpFormation(session, entity, now)) {
      return false;
    }
    const egoEntity = this.getShipEntityForSession(session);
    if (!egoEntity) {
      return false;
    }
    if (!this.canSessionSeeDynamicEntity(session, entity)) {
      return false;
    }
    return Boolean(
      isFleetWarpInProgress(egoEntity) ||
      isFleetWarpInProgress(entity)
    );
  },

getFleetWarpFormationCompanionEntitiesForSession(
    session,
    now = this.getCurrentSimTimeMs(),
  ) {
    if (!session || !session._space) {
      return [];
    }
    const egoEntity = this.getShipEntityForSession(session);
    if (
      !egoEntity ||
      egoEntity.session !== session ||
      !this.getActiveFleetWarpFormationID(egoEntity, now)
    ) {
      return [];
    }
    const companions = [];
    for (const candidate of this.dynamicEntities.values()) {
      if (
        this.canSessionSeeDynamicEntity(session, candidate) &&
        this.isEntityInSessionFleetWarpFormation(session, candidate, now)
      ) {
        companions.push(candidate);
      }
    }
    return companions;
  },

retireInactiveFleetWarpCommandAssociation(entity) {
    const association = getFleetWarpCommandAssociation(entity, {
      sceneSystemID: this.systemID,
      getEntityByID: (entityID) => this.getEntityByID(entityID),
    });
    if (!association) {
      return clearFleetWarpCommandAssociation(entity);
    }
    for (const candidate of this.dynamicEntities.values()) {
      if (
        candidate !== entity &&
        isFleetWarpInProgress(candidate) &&
        haveSameFleetWarpCommandAssociation(entity, candidate, {
          sceneSystemID: this.systemID,
          getEntityByID: (entityID) => this.getEntityByID(entityID),
        })
      ) {
        return false;
      }
    }
    return clearFleetWarpCommandAssociation(entity);
  },
};
