"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const localChannelMove = require(path.join(__dirname, "./localChannelMove"));

function describeSessionHydrationState(session, shipID = null) {
  if (!session || typeof session !== "object") {
    return "session=none";
  }

  const space = session._space || null;
  const resolvedShipID =
    Number(shipID) ||
    Number(
      space &&
        (space.shipID ||
          session.activeShipID ||
          session.shipID ||
          session.shipid ||
          0),
    ) ||
    0;
  return [
    `clientID=${Number(session.clientID) || 0}`,
    `charID=${Number(session.characterID || session.charid) || 0}`,
    `shipID=${resolvedShipID}`,
    `profile=${
      space && typeof space.loginChargeHydrationProfile === "string"
        ? space.loginChargeHydrationProfile
        : "unknown"
    }`,
    `beyonce=${Boolean(space && space.beyonceBound)}`,
    `initial=${Boolean(space && space.initialStateSent)}`,
    `invPrimed=${Boolean(space && space.loginShipInventoryPrimed)}`,
    `bound=${session.currentBoundObjectID || "none"}`,
  ].join(" ");
}

function flushPendingInitialBallpark(session, pending, attempt = 0) {
  if (!session || !pending || !session.socket || session.socket.destroyed) {
    return;
  }
  if (!session._space || session._space.initialStateSent) {
    return;
  }
  if (pending.awaitBeyonceBound === true && !session._space.beyonceBound) {
    if (attempt >= 480) {
      // Giving up here strands the session: every destiny send path early-returns
      // while initialStateSent is false, so the client stays frozen until it jumps
      // systems. Force the full bootstrap instead, and keep
      // allowDeferredJumpBootstrapVisuals false so ensureInitialBallpark skips the
      // visuals-only deferred branch and actually sets initialStateSent.
      log.warn(
        `[SpaceBootstrap] Beyonce bind wait timed out after ${attempt} attempts; ` +
          `forcing initial ballpark bootstrap ` +
          `systemID=${Number(session._space.systemID) || 0} ` +
          `sceneKey=${session._space.sceneKey || "none"} ` +
          `${describeSessionHydrationState(session)}`,
      );
      spaceRuntime.ensureInitialBallpark(session, {
        allowDeferredJumpBootstrapVisuals: false,
        force: true,
      });
      return;
    }
    setTimeout(() => {
      flushPendingInitialBallpark(session, pending, attempt + 1);
    }, 25);
    return;
  }

  spaceRuntime.ensureInitialBallpark(session, {
    allowDeferredJumpBootstrapVisuals: true,
    force: pending.force === true,
  });
}

function flushPendingCommandSessionEffects(session) {
  if (!session || typeof session !== "object") {
    return;
  }

  const pendingLocalChannelSync = session._pendingLocalChannelSync || null;
  const pendingInitialBallpark = session._pendingCommandInitialBallpark || null;
  session._pendingLocalChannelSync = null;
  session._pendingCommandInitialBallpark = null;

  if (
    pendingLocalChannelSync &&
    !localChannelMove.moveLocalSession(session, pendingLocalChannelSync.previousChannelID)
  ) {
    log.debug("[CommandSessionEffects] local channel sync skipped: chatHub is not loaded");
  }

  if (pendingInitialBallpark) {
    setTimeout(() => {
      flushPendingInitialBallpark(session, pendingInitialBallpark);
    }, 0);
  }
}

module.exports = {
  describeSessionHydrationState,
  flushPendingCommandSessionEffects,
};
