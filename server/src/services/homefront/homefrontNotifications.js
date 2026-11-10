"use strict";

const { buildKeyVal } = require("../_shared/serviceHelpers");
const rewards = require("./homefrontRewards");

const FAILURE_REASONS = {
  three_civilians_harmed: "Three civilian ships were harmed by pilots.",
  protected_asset_destroyed: "The friendly asset was destroyed.",
  five_smugglers_escaped: "Five smugglers escaped.",
  asteroids_remaining:
    "The wave timer expired before all asteroids were depleted.",
  abandoned: "The operation was abandoned.",
  deadline: "The operation timer expired before the objective was completed.",
};

function rewardText(ledger, instance, config, state, characterID) {
  const receipts = Object.values(ledger.receipts).filter(
    (receipt) => receipt.instanceID === instance.instanceID,
  );
  let amount = 0;
  let pending = 0;
  for (const receipt of receipts) {
    const participant = receipt.participants.find(
      (participant) => participant.characterID === characterID,
    );
    if (!participant) continue;
    amount += participant.isk;
    if (ledger.pending[characterID]?.[receipt.id]) pending += participant.isk;
  }
  if (amount > 0) {
    const format = (value) =>
      value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    return (
      `Your ${config.family === "abyssal_artifact_recovery" ? "total wave rewards" : "reward"}: <b>${format(amount)} ISK</b>.` +
      (pending === amount
        ? " Wallet payment is being processed."
        : pending > 0
          ? ` Wallet payment pending: ${format(pending)} ISK.`
          : " Credited to your wallet.")
    );
  }
  if (state.status === "failed")
    return "No ISK reward was earned from this operation.";
  if (state.contributions[characterID]?.qualifiedAtMs == null)
    return "No ISK reward: you did not meet this operation's participation requirements.";
  if (
    receipts.some((receipt) =>
      receipt.participants.some(
        (participant) => participant.characterID === characterID,
      ),
    )
  )
    return "Your recorded ISK reward is 0 ISK for this reward population.";
  return "No ISK reward: you were not on the eligible payout roster. Only qualifying pilots in the pocket at each payout, within the recipient cap, receive ISK.";
}

function publish(instance, config, state, ships) {
  const artifact = config.family === "abyssal_artifact_recovery";
  const escape =
    artifact && state.phase === "escape" && state.status === "active";
  if (!escape && state.status === "active") return;
  // Escape is the Artifact success announcement. Do not repeat it when the
  // Drifter arrives, or after a scene reload/restart with the same pilot.
  const key = state.status === "failed" ? "failed" : "completed";
  const recipients = ships.filter((ship) => {
    const characterID = Number(
      ship.session?.characterID || ship.session?.charid,
    );
    return (
      characterID > 0 &&
      typeof ship.session?.sendNotification === "function" &&
      !state.resultNotifications?.[key]?.[characterID]
    );
  });
  if (!recipients.length) return;
  const ledger = rewards.readForOperation(instance);
  const name = config.family
    .split("_")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
  const header = escape
    ? `${name} — Recovery complete`
    : `${name} — Operation ${key}`;
  let body;
  if (escape) {
    const seconds = Math.max(
      0,
      Math.ceil((state.phaseEndsAtMs - state.elapsedMs) / 1000),
    );
    body = `<b>Evacuate within ${seconds} seconds.</b><br>All nine waves are complete. The asteroid warp-disruption field is down. Warp away before the Drifter response arrives.`;
  } else if (state.status === "failed") {
    body =
      FAILURE_REASONS[state.failure] ||
      "The operation's objective could not be completed.";
    if (artifact && state.phase === "wave" && state.rocksCleared < 12)
      body +=
        "<br>The warp-disruption field is still active. Deplete the remaining asteroids or fly outside the field to escape.";
  } else if (artifact) {
    body =
      "All nine waves are complete. The evacuation window has ended. The Drifter response is arriving — warp away immediately.";
  } else {
    body = "The operation's objective has been completed.";
  }
  for (const ship of recipients) {
    const characterID = Number(ship.session.characterID || ship.session.charid);
    ship.session.sendNotification("OnIncomingTransmission", "shipid", [
      buildKeyVal([
        ["caption", { type: "wstring", value: "Homefront Operations" }],
        ["header", { type: "wstring", value: header }],
        [
          "text",
          {
            type: "wstring",
            value: `${body}<br><br>${rewardText(ledger, instance, config, state, characterID)}`,
          },
        ],
        ["icon", null],
        ["hasDungeonWarp", false],
      ]),
      // isAgentMission: TQ sends (transmission, False) (golden logs).
      false,
    ]);
    state.resultNotifications ??= {};
    state.resultNotifications[key] ??= {};
    state.resultNotifications[key][characterID] = true;
  }
}

module.exports = { publish };
