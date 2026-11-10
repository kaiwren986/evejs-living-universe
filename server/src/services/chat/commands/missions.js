"use strict";

// Mission chat command: /missioncomplete, which marks the objectives of one agent's mission, or
// of every accepted mission, complete.

const path = require("path");

const {
  markMissionObjectiveComplete,
} = require(path.join(__dirname, "../../agent/agentMissionRuntime"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));

function handleMissionCompleteCommand(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /missioncomplete.",
    );
  }

  const targetToken = String(argumentText || "").trim();
  const agentTarget = targetToken.length > 0 ? targetToken : "all";
  const result = markMissionObjectiveComplete(session.characterID, {
    agentID: agentTarget,
  });
  if (!result.success) {
    return handledResult(
      chatHub,
      session,
      options,
      result.errorMsg === "MISSION_NOT_FOUND"
        ? "No accepted placeholder mission objectives were found to mark complete."
        : "Placeholder mission completion failed.",
    );
  }

  const markedAgentIDs = Array.isArray(result.data && result.data.markedAgentIDs)
    ? result.data.markedAgentIDs.filter((agentID) => Number(agentID) > 0)
    : [];
  const missionCount = markedAgentIDs.length;
  if (missionCount <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No accepted placeholder mission objectives were found to mark complete.",
    );
  }

  const suffix = missionCount === 1 ? "" : "s";
  const agentSuffix = missionCount === 1 ? "" : "s";
  const details =
    missionCount === 1
      ? ` Agent ${markedAgentIDs[0]} is now ready to hand in.`
      : ` Agents: ${markedAgentIDs.join(", ")}.`;
  return handledResult(
    chatHub,
    session,
    options,
    `Marked ${missionCount} placeholder mission objective${suffix} complete.${details} Talk to the agent${agentSuffix} and click Complete Mission.`,
  );
}

module.exports = {
  handleMissionCompleteCommand,
};
