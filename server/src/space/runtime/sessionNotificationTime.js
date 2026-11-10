"use strict";

module.exports = {
  resolveSessionNotificationFileTime,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  toFileTimeFromMs,
} = require("./runtimeClock");

function resolveSessionNotificationFileTime(session, whenMs = null) {
  const runtimeExports = require("../runtime");
  const scene =
    runtimeExports &&
    typeof runtimeExports.getSceneForSession === "function"
      ? runtimeExports.getSceneForSession(session)
      : null;
  if (whenMs != null) {
    if (scene) {
      return scene.getCurrentSessionFileTime(session, whenMs);
    }
    return toFileTimeFromMs(whenMs);
  }
  if (scene) {
    return scene.getCurrentSessionFileTime(session);
  }
  if (session && session._space && session._space.simFileTime) {
    return session._space.simFileTime;
  }
  return currentFileTime();
}
