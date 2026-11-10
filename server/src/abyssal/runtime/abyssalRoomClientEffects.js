"use strict";
const { normalizeText, toInt } = require("../domain/abyssalRuntimeValues");

function buildAbyssalRoomOneFxSelection(ports) {
  const {
    resolveAbyssalCalmDarkProbeEffect,
    ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY,
    listAbyssalCalmDarkProbeEffectKeys,
  } = ports;
  const selectedEffect =
    resolveAbyssalCalmDarkProbeEffect(ABYSSAL_CALM_DARK_DEFAULT_EFFECT_KEY);

  return {
    enabled: true,
    requestedKey: "",
    selectedKey: normalizeText(selectedEffect && selectedEffect.key, "none"),
    guid: normalizeText(selectedEffect && selectedEffect.guid, "none"),
    fallbackReason: selectedEffect ? "SERVER_OWNED_DEFAULT" : "DEFAULT_EFFECT_NOT_FOUND",
    effect: selectedEffect || null,
    allowlistKeys: listAbyssalCalmDarkProbeEffectKeys(),
  };
}

function getAbyssalRoomOneClientFxState(ports, pocketState) {
  if (
    pocketState &&
    pocketState.roomOneClientFxState &&
    typeof pocketState.roomOneClientFxState === "object"
  ) {
    return pocketState.roomOneClientFxState;
  }
  if (
    pocketState &&
    pocketState.calmDarkClientFxState &&
    typeof pocketState.calmDarkClientFxState === "object"
  ) {
    return pocketState.calmDarkClientFxState;
  }
  return {};
}

function updateAbyssalRoomOneFxState(ports, pocketState, nextState = {}) {
  const {
    updatePocketState,
    cloneValue,
  } = ports;
  const numericInstanceID = toInt(pocketState && pocketState.instanceID, 0);
  if (numericInstanceID <= 0) {
    return pocketState;
  }
  const previousState = getAbyssalRoomOneClientFxState(ports, pocketState);
  return updatePocketState(numericInstanceID, {
    roomOneClientFxState: {
      ...cloneValue(previousState),
      ...cloneValue(nextState),
    },
  }) || pocketState;
}

function maybeSendAbyssalRoomOneClientFx(ports,
  pocketState,
  session,
  deps = ports.getDependencies(),
) {
  const {
    getContentProfile,
    buildPlaceholderRoomState,
    isAbyssalVisualFxContentProfile,
    buildAbyssalRoomOneFxStatus,
    cloneValue,
  } = ports;
  const contentProfile = getContentProfile(pocketState) || {};
  const roomState = buildPlaceholderRoomState(pocketState);
  if (
    !isAbyssalVisualFxContentProfile(contentProfile) ||
    toInt(roomState.currentRoomIndex, 0) !== 1
  ) {
    return {
      pocketState,
      fxStatus: buildAbyssalRoomOneFxStatus(pocketState, deps),
    };
  }

  const fxStatus = buildAbyssalRoomOneFxStatus(pocketState, deps, {
    defaultShipID: toInt(session && session._space && session._space.shipID, 0),
  });
  if (fxStatus.attemptedAtMs > 0) {
    return {
      pocketState,
      fxStatus,
    };
  }

  const baseState = {
    requestedKey: fxStatus.requestedKey,
    selectedKey: fxStatus.selectedKey,
    guid: fxStatus.guid,
    fallbackReason: fxStatus.fallbackReason,
    sourceShipID: toInt(session && session._space && session._space.shipID, 0),
    roomIndex: 1,
    attemptedAtMs: toInt(deps.now(), 0),
    sentAtMs: 0,
    sendErrorMsg: "none",
  };

  if (fxStatus.enabled !== true) {
    const updatedPocketState = updateAbyssalRoomOneFxState(ports, pocketState, {
      ...baseState,
      sendStatus: "DISABLED",
    });
    return {
      pocketState: updatedPocketState,
      fxStatus: buildAbyssalRoomOneFxStatus(updatedPocketState, deps),
    };
  }
  if (!fxStatus.effect) {
    const updatedPocketState = updateAbyssalRoomOneFxState(ports, pocketState, {
      ...baseState,
      sendStatus: "NO_ALLOWLIST_EFFECT",
      sendErrorMsg: fxStatus.fallbackReason,
    });
    return {
      pocketState: updatedPocketState,
      fxStatus: buildAbyssalRoomOneFxStatus(updatedPocketState, deps),
    };
  }

  const runtime = deps;
  if (!runtime || typeof runtime.playSpecialFx !== "function") {
    const updatedPocketState = updateAbyssalRoomOneFxState(ports, pocketState, {
      ...baseState,
      sendStatus: "FX_RUNTIME_UNAVAILABLE",
      sendErrorMsg: "FX_RUNTIME_UNAVAILABLE",
    });
    return {
      pocketState: updatedPocketState,
      fxStatus: buildAbyssalRoomOneFxStatus(updatedPocketState, deps),
    };
  }

  const runtimeResult = runtime.playSpecialFx(session, fxStatus.effect.guid, {
    ...cloneValue(fxStatus.effect.start),
  });
  const updatedPocketState = updateAbyssalRoomOneFxState(ports, pocketState, {
    ...baseState,
    sendStatus: runtimeResult && runtimeResult.success ? "SENT" : normalizeText(
      runtimeResult && runtimeResult.errorMsg,
      "SEND_FAILED",
    ),
    sendErrorMsg: runtimeResult && runtimeResult.success
      ? "none"
      : normalizeText(runtimeResult && runtimeResult.errorMsg, "SEND_FAILED"),
    sourceShipID: toInt(
      runtimeResult && runtimeResult.data && runtimeResult.data.shipID,
      baseState.sourceShipID,
    ),
    sentAtMs: runtimeResult && runtimeResult.success ? toInt(deps.now(), 0) : 0,
  });
  return {
    pocketState: updatedPocketState,
    fxStatus: buildAbyssalRoomOneFxStatus(updatedPocketState, deps),
  };
}

function playAbyssalCalmDarkFxProbeForSession(ports,
  session,
  effectKey,
  deps = ports.getDependencies(),
) {
  const {
    resolveAbyssalCalmDarkProbeEffect,
    listAbyssalCalmDarkProbeEffectKeys,
    cloneValue,
  } = ports;
  const effect = resolveAbyssalCalmDarkProbeEffect(effectKey);
  if (!effect) {
    return {
      success: false,
      errorMsg: "FX_NOT_ALLOWLISTED",
      data: {
        allowlistKeys: listAbyssalCalmDarkProbeEffectKeys(),
      },
    };
  }
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
      data: {
        effect,
      },
    };
  }
  if (!session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
      data: {
        effect,
      },
    };
  }
  const runtime = deps;
  if (!runtime || typeof runtime.playSpecialFx !== "function") {
    return {
      success: false,
      errorMsg: "FX_RUNTIME_UNAVAILABLE",
      data: {
        effect,
      },
    };
  }

  const runtimeResult = runtime.playSpecialFx(session, effect.guid, {
    ...cloneValue(effect.start),
  });
  if (!runtimeResult || !runtimeResult.success) {
    return {
      success: false,
      errorMsg: normalizeText(
        runtimeResult && runtimeResult.errorMsg,
        "FX_SEND_FAILED",
      ),
      data: {
        effect,
        sourceShipID: toInt(session._space && session._space.shipID, 0),
      },
    };
  }

  return {
    success: true,
    data: {
      effect,
      guid: effect.guid,
      sourceShipID: toInt(
        runtimeResult && runtimeResult.data && runtimeResult.data.shipID,
        toInt(session._space && session._space.shipID, 0),
      ),
      sendStatus: "SENT",
    },
  };
}

function createAbyssalRoomClientEffects(ports) {
  return {
    buildAbyssalRoomOneFxSelection: buildAbyssalRoomOneFxSelection.bind(null, ports),
    getAbyssalRoomOneClientFxState: getAbyssalRoomOneClientFxState.bind(null, ports),
    updateAbyssalRoomOneFxState: updateAbyssalRoomOneFxState.bind(null, ports),
    maybeSendAbyssalRoomOneClientFx: maybeSendAbyssalRoomOneClientFx.bind(null, ports),
    playAbyssalCalmDarkFxProbeForSession: playAbyssalCalmDarkFxProbeForSession.bind(null, ports),
  };
}

module.exports = { createAbyssalRoomClientEffects };
