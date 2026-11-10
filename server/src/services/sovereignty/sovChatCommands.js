"use strict";

const path = require("path");

const {
  DEFAULT_VULNERABILITY_DURATION_SECONDS,
  anchorSovereigntyHub,
  buildSovereigntyStatusReport,
  cancelAllianceCapitalTransition,
  captureSystemCampaignNode,
  captureSystemForOwner,
  clearHubVulnerabilityWindow,
  clearSystemSovereignty,
  ensureValidSolarSystem,
  fastForwardSovereigntyTimers,
  loseSystemSovereignty,
  reinforceSystemHub,
  resolveAllianceID,
  resolveCorporationID,
  resolveSolarSystemID,
  setAllianceCapitalSystem,
  setAlliancePrimeHour,
  setHubVulnerabilityWindow,
  setSystemClaimAge,
  setSystemDevelopmentIndexValue,
} = require(path.join(__dirname, "./sovGmState"));
const {
  DEFAULT_SOV_FLEX_FUEL_HOURS,
  deploySovereigntyFlexStructure,
  getSovereigntyFlexDefinitions,
  normalizeSovereigntyFlexKind,
} = require(path.join(__dirname, "./sovFlexStructures"));
const {
  getStrategicIndexLevel,
  getSystemState,
} = require(path.join(__dirname, "./sovState"));
const {
  getUpgradeDefinition,
} = require(path.join(__dirname, "./sovUpgradeSupport"));

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = normalizeInteger(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function buildHelpText() {
  return [
    "/sov help",
    "/sov status [here|systemID]",
    "/sov anchor [here|systemID] [allianceID] [corporationID] (claimed Hub at the sun)",
    "/sov anchor neutral [here|systemID] (SCC Hub waiting for an Entosis claim)",
    "/sov deploy <tenebrex|pharolux|ansiblex|all> [here|systemID] [allianceID] [corporationID]",
    "/sov prime <hour> [allianceID]",
    "/sov capital <here|systemID|clear> [allianceID]",
    "/sov index <strategic|claimed|military|industrial> <value> [here|systemID] (levels 0-5; claimed uses days; operational values >5 use raw points)",
    "/sov age <days> [here|systemID] (set claim age and strategic index)",
    "/sov vuln <seconds|clear> [here|systemID]",
    "/sov reinforce [exitSeconds|now] [here|systemID]",
    "/sov node <nodeID|next> <defender|attacker|allianceID> [here|systemID]",
    "/sov ff <seconds> [here|systemID]",
    "/sov capture <allianceID> <corporationID> [here|systemID]",
    "/sov lose [allianceID|0] [corporationID|0] [here|systemID]",
    "/sov clear [here|systemID]",
  ].join("\n");
}

function appendStatus(message, solarSystemID) {
  return [
    String(message || "").trim(),
    buildSovereigntyStatusReport(solarSystemID),
  ].join("\n");
}

function parseSystemToken(session, token) {
  const solarSystemID = resolveSolarSystemID(session, token, 0);
  const validation = ensureValidSolarSystem(solarSystemID);
  if (!validation.success) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }
  return {
    success: true,
    data: validation.data.solarSystemID,
  };
}

function isSystemToken(session, token) {
  const normalized = String(token || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "here" || normalized === "current") {
    return true;
  }
  return resolveSolarSystemID(session, normalized, 0) > 0;
}

function buildDeployErrorMessage(errorMsg) {
  if (errorMsg === "FORBIDDEN_REQUEST") {
    return "The requested alliance or corporation does not own that Sov Hub.";
  }
  if (errorMsg === "SOV_HUB_REQUIRED") {
    return "Deploying sovereignty flex structures requires an already-claimed system with a Sov Hub.";
  }
  if (errorMsg === "INSUFFICIENT_LOCAL_CAPACITY") {
    return "That solar system cannot support the required Sov Hub upgrade for this flex structure.";
  }
  if (errorMsg === "REQUIRED_HUB_UPGRADE_NOT_ONLINE") {
    return "The required Sov Hub upgrade could not be brought online for this flex structure.";
  }
  if (errorMsg === "HUB_NOT_FOUND") {
    return "No Sov Hub was found for that system.";
  }
  if (errorMsg === "STRUCTURE_SYSTEM_CAP_REACHED") {
    return "That solar system already has the maximum number of that FLEX structure role.";
  }
  return `Failed to deploy sovereignty flex structure: ${errorMsg}.`;
}

function buildHubErrorMessage(action, errorMsg) {
  if (errorMsg === "SOLAR_SYSTEM_NOT_CONQUERABLE") {
    return `${action} only supports conquerable nullsec systems with no faction owner.`;
  }
  if (errorMsg === "OWNED_HUB_REQUIRED") {
    return `${action} needs a claimed Sovereignty Hub in that system. Use /sov anchor or /sov capture first.`;
  }
  if (errorMsg === "SOVEREIGNTY_HUB_ALREADY_REINFORCED") {
    return "That Sovereignty Hub is already reinforced or in a command node event.";
  }
  if (errorMsg === "SOVEREIGNTY_HUB_IN_CAMPAIGN") {
    return "That Sovereignty Hub is reinforced or in a command node event; finish it with /sov node first.";
  }
  if (errorMsg === "CAMPAIGN_NOT_ACTIVE") {
    return "That Sovereignty Hub has no running command node event. Use /sov reinforce now first.";
  }
  if (errorMsg === "COMMAND_NODE_NOT_FOUND") {
    return "No live command node matches that ID. /sov status lists the event's nodes.";
  }
  if (errorMsg === "ATTACKER_ALLIANCE_REQUIRED") {
    return "Your alliance is the defender here. Pass the attacking alliance's ID instead of attacker.";
  }
  if (errorMsg === "SIDE_REQUIRED") {
    return "Usage: /sov node <nodeID|next> <defender|attacker|allianceID> [here|systemID]";
  }
  return `${action} failed: ${errorMsg}.`;
}

function executeSovCommand(session, argumentText) {
  const trimmed = String(argumentText || "").trim();
  const [subcommandRaw, ...rest] = trimmed.split(/\s+/).filter(Boolean);
  const subcommand = String(subcommandRaw || "help").trim().toLowerCase();

  if (subcommand === "help" || subcommand === "?" || subcommand === "commands") {
    return {
      success: true,
      message: buildHelpText(),
    };
  }

  if (subcommand === "status") {
    const systemResult = parseSystemToken(session, rest[0] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Usage: /sov status [here|systemID]",
      };
    }
    return {
      success: true,
      message: buildSovereigntyStatusReport(systemResult.data),
    };
  }

  if (subcommand === "anchor") {
    const neutral = String(rest[0] || "").trim().toLowerCase() === "neutral";
    const tokens = neutral ? rest.slice(1) : rest;
    const systemResult = parseSystemToken(session, tokens[0] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Usage: /sov anchor [neutral] [here|systemID] [allianceID] [corporationID]",
      };
    }
    const allianceID = neutral ? null : resolveAllianceID(session, tokens[1], null);
    const corporationID = neutral ? null : resolveCorporationID(session, tokens[2], null);
    if (!neutral && (!allianceID || !corporationID)) {
      return {
        success: false,
        message: "Anchoring a claimed Hub requires an alliance and corporation. Join an alliance first or pass explicit IDs.",
      };
    }
    const result = anchorSovereigntyHub(systemResult.data, allianceID, corporationID, {
      neutral,
    });
    if (!result.success) {
      return {
        success: false,
        message: buildHubErrorMessage("/sov anchor", result.errorMsg),
      };
    }
    return {
      success: true,
      message: appendStatus(
        neutral
          ? `Anchored a neutral Sovereignty Hub ${result.data.hubID} at the sun in ${systemResult.data}. Claim it with an Entosis Link.`
          : `Anchored a claimed Sovereignty Hub ${result.data.hubID} at the sun in ${systemResult.data} for alliance ${allianceID} corporation ${corporationID}.`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "deploy") {
    const deployKind = normalizeSovereigntyFlexKind(rest[0]);
    if (!deployKind) {
      return {
        success: false,
        message: "Usage: /sov deploy <tenebrex|pharolux|ansiblex|all> [here|systemID] [allianceID] [corporationID]",
      };
    }
    const systemResult = parseSystemToken(session, rest[1] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Solar system not found for /sov deploy.",
      };
    }
    const systemState = getSystemState(systemResult.data) || {};
    const allianceID = resolveAllianceID(
      session,
      rest[2],
      normalizePositiveInteger(systemState.allianceID, null),
    );
    const corporationID = resolveCorporationID(
      session,
      rest[3],
      normalizePositiveInteger(systemState.corporationID, null),
    );
    const definitions = getSovereigntyFlexDefinitions(deployKind);
    if (definitions.length === 0) {
      return {
        success: false,
        message: "Usage: /sov deploy <tenebrex|pharolux|ansiblex|all> [here|systemID] [allianceID] [corporationID]",
      };
    }

    let strategicFloor = 0;
    for (const definition of definitions) {
      const upgradeDefinition = getUpgradeDefinition(definition.requiredUpgradeTypeID);
      strategicFloor = Math.max(
        strategicFloor,
        Math.max(0, normalizeInteger(upgradeDefinition && upgradeDefinition.requiredStrategicIndex, 0)),
      );
    }
    // Setting the strategic index rewrites the claim age, so only raise it.
    // An older claim already meets the floor and must keep its age.
    const currentStrategicLevel = getStrategicIndexLevel(
      systemState.devIndices && systemState.devIndices.claimedForDays,
    );
    if (strategicFloor > currentStrategicLevel) {
      setSystemDevelopmentIndexValue(
        systemResult.data,
        "strategic",
        strategicFloor,
      );
    }

    const deployedLabels = [];
    for (const definition of definitions) {
      const deployResult = deploySovereigntyFlexStructure(
        session,
        definition.kind,
        {
          solarSystemID: systemResult.data,
          allianceID,
          corporationID,
          fuelHours: DEFAULT_SOV_FLEX_FUEL_HOURS,
          reuseExisting: true,
        },
      );
      if (!deployResult.success) {
        return {
          success: false,
          message: buildDeployErrorMessage(deployResult.errorMsg),
        };
      }
      deployedLabels.push(
        deployResult.data.created === false
          ? `${definition.label} refreshed`
          : `${definition.label} deployed`,
      );
    }

    return {
      success: true,
      message: appendStatus(
        `${deployedLabels.join(", ")} in ${systemResult.data}. Required Sov Hub upgrades were brought online and fueled automatically.`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "prime") {
    const hour = normalizeInteger(rest[0], NaN);
    if (!Number.isFinite(hour)) {
      return {
        success: false,
        message: "Usage: /sov prime <hour> [allianceID]",
      };
    }
    const allianceID = resolveAllianceID(session, rest[1], null);
    if (!allianceID) {
      return {
        success: false,
        message: "Prime-time updates require an alliance. Join an alliance first or pass an allianceID.",
      };
    }
    setAlliancePrimeHour(allianceID, hour);
    return {
      success: true,
      message: `Queued alliance ${allianceID} prime hour -> ${hour}. Use /sov ff to bring the pending timer due.`,
    };
  }

  if (subcommand === "capital") {
    const firstToken = String(rest[0] || "here").trim().toLowerCase();
    const allianceID = resolveAllianceID(session, rest[1], null);
    if (!allianceID) {
      return {
        success: false,
        message: "Capital-system updates require an alliance. Join an alliance first or pass an allianceID.",
      };
    }
    if (firstToken === "clear" || firstToken === "cancel" || firstToken === "off") {
      cancelAllianceCapitalTransition(allianceID);
      return {
        success: true,
        message: `Cleared the pending capital transition for alliance ${allianceID}.`,
      };
    }
    const systemResult = parseSystemToken(session, rest[0] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Usage: /sov capital <here|systemID|clear> [allianceID]",
      };
    }
    setAllianceCapitalSystem(allianceID, systemResult.data);
    return {
      success: true,
      message: `Queued alliance ${allianceID} capital system -> ${systemResult.data}. Use /sov ff to bring the pending timer due.`,
    };
  }

  if (subcommand === "age") {
    if (rest.length < 1 || rest.length > 2 || !/^\d+$/.test(rest[0])) {
      return { success: false, message: "Usage: /sov age <days> [here|systemID]. Days must be a non-negative whole number." };
    }
    const systemResult = parseSystemToken(session, rest[1] || "here");
    if (!systemResult.success) {
      return { success: false, message: "Solar system not found for /sov age." };
    }
    const result = setSystemClaimAge(systemResult.data, Number(rest[0]));
    if (!result.success) {
      const message = result.errorMsg === "SOVEREIGNTY_CLAIM_REQUIRED"
        ? "The system must already have an alliance sovereignty claim. A neutral hub must be captured first."
        : result.errorMsg === "INVALID_CLAIM_AGE"
          ? "Days must be a non-negative whole number that keeps the claim date after 1601-01-01."
          : `Failed to set sovereignty age: ${result.errorMsg}.`;
      return { success: false, message };
    }
    return {
      success: true,
      message: appendStatus(
        `Set sovereignty claim age to ${result.data.days} day(s). ` +
        "Wait 15 seconds, then close and reopen the Sov Hub window to refresh its cached claim age.",
        systemResult.data,
      ),
    };
  }

  if (subcommand === "index") {
    const indexKind = String(rest[0] || "").trim().toLowerCase();
    const value = Number(rest[1]);
    if (
      !indexKind || !/^\d+$/.test(rest[1] || "") ||
      !Number.isSafeInteger(value) || rest.length > 3
    ) {
      return {
        success: false,
        message: "Usage: /sov index <strategic|claimed|military|industrial> <value> [here|systemID]. Use levels 0-5, claimed days, or operational raw points >5.",
      };
    }
    const systemResult = parseSystemToken(session, rest[2] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Solar system not found for /sov index.",
      };
    }
    const result = setSystemDevelopmentIndexValue(
      systemResult.data,
      indexKind,
      value,
    );
    if (!result.success) {
      return {
        success: false,
        message: `Failed to update sovereignty indices: ${result.errorMsg}.`,
      };
    }
    return {
      success: true,
      message: appendStatus(
        `Updated ${indexKind} index in ${systemResult.data}.` +
        (indexKind === "strategic" || indexKind === "claimed"
          ? " Wait 15 seconds, then close and reopen the Sov Hub window to refresh its cached claim age."
          : ""),
        systemResult.data,
      ),
    };
  }

  if (subcommand === "vuln") {
    const modeToken = String(rest[0] || "").trim().toLowerCase();
    if (!modeToken || (modeToken !== "clear" && !/^\d+$/.test(modeToken))) {
      return {
        success: false,
        message: "Usage: /sov vuln <seconds|clear> [here|systemID]",
      };
    }
    const systemResult = parseSystemToken(session, rest[1] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Solar system not found for /sov vuln.",
      };
    }
    const seconds = Math.max(1, normalizeInteger(modeToken, DEFAULT_VULNERABILITY_DURATION_SECONDS));
    const result =
      modeToken === "clear"
        ? clearHubVulnerabilityWindow(systemResult.data)
        : setHubVulnerabilityWindow(systemResult.data, seconds);
    if (!result.success) {
      return {
        success: false,
        message: buildHubErrorMessage("/sov vuln", result.errorMsg),
      };
    }
    return {
      success: true,
      message: appendStatus(
        modeToken === "clear"
          ? `Cleared the Hub vulnerability window in ${systemResult.data}; the daily window applies again.`
          : `Opened the Hub vulnerability window for ${seconds} seconds in ${systemResult.data}.`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "reinforce") {
    // A lone numeric token that names a system is the system, not an exit.
    let exitToken = null;
    let systemToken = "here";
    if (rest.length >= 2) {
      exitToken = rest[0];
      systemToken = rest[1];
    } else if (rest.length === 1) {
      if (isSystemToken(session, rest[0])) {
        systemToken = rest[0];
      } else {
        exitToken = rest[0];
      }
    }
    let exitSeconds = null;
    if (exitToken !== null) {
      const normalizedExit = String(exitToken).trim().toLowerCase();
      if (normalizedExit === "now") {
        exitSeconds = 0;
      } else if (/^\d+$/.test(normalizedExit)) {
        exitSeconds = Number(normalizedExit);
      } else {
        return {
          success: false,
          message: "Usage: /sov reinforce [exitSeconds|now] [here|systemID]",
        };
      }
    }
    const systemResult = parseSystemToken(session, systemToken);
    if (!systemResult.success) {
      return {
        success: false,
        message: "Solar system not found for /sov reinforce.",
      };
    }
    const result = reinforceSystemHub(systemResult.data, { exitSeconds });
    if (!result.success) {
      return {
        success: false,
        message: buildHubErrorMessage("/sov reinforce", result.errorMsg),
      };
    }
    const exitLabel = new Date(result.data.reinforcementExitMs).toISOString();
    const nodeCount = result.data.campaign && Array.isArray(result.data.campaign.commandNodes)
      ? result.data.campaign.commandNodes.length
      : 0;
    return {
      success: true,
      message: appendStatus(
        result.data.campaign
          ? `Reinforced Sovereignty Hub ${result.data.hubID} in ${systemResult.data} and started its command node event with ${nodeCount} nodes.`
          : `Reinforced Sovereignty Hub ${result.data.hubID} in ${systemResult.data}; the command node event starts at ${exitLabel}. Use /sov ff to bring it forward.`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "node") {
    const nodeToken = String(rest[0] || "").trim().toLowerCase();
    const sideToken = String(rest[1] || "").trim().toLowerCase();
    if (!nodeToken || !sideToken) {
      return {
        success: false,
        message: "Usage: /sov node <nodeID|next> <defender|attacker|allianceID> [here|systemID]",
      };
    }
    const systemResult = parseSystemToken(session, rest[2] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Solar system not found for /sov node.",
      };
    }
    const result = captureSystemCampaignNode(systemResult.data, {
      nodeToken,
      side: sideToken,
      sessionAllianceID: resolveAllianceID(session, undefined, null),
    });
    if (!result.success) {
      return {
        success: false,
        message: buildHubErrorMessage("/sov node", result.errorMsg),
      };
    }
    const sideLabel = result.data.defenderWon ? "the defender" : `attacker alliance ${result.data.allianceID}`;
    const outcome = result.data.completed
      ? result.data.result === "defender"
        ? " The defenders won and the Hub is secure."
        : " The attackers won and the Hub is destroyed."
      : "";
    return {
      success: true,
      message: appendStatus(
        `Captured command node ${result.data.nodeID} in ${result.data.nodeSolarSystemID} for ${sideLabel}.${outcome}`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "ff") {
    const seconds = normalizeInteger(rest[0], NaN);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return {
        success: false,
        message: "Usage: /sov ff <seconds> [here|systemID]",
      };
    }
    const systemResult = parseSystemToken(session, rest[1] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Solar system not found for /sov ff.",
      };
    }
    const result = fastForwardSovereigntyTimers(systemResult.data, seconds);
    if (!result.success) {
      return {
        success: false,
        message: `Failed to fast-forward sovereignty timers: ${result.errorMsg}.`,
      };
    }
    return {
      success: true,
      message: appendStatus(
        `Fast-forwarded sovereignty timers by ${seconds} seconds in ${systemResult.data}.`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "capture") {
    const allianceID = resolveAllianceID(session, rest[0], null);
    const corporationID = resolveCorporationID(session, rest[1], null);
    if (!allianceID || !corporationID) {
      return {
        success: false,
        message: "Usage: /sov capture <allianceID> <corporationID> [here|systemID]",
      };
    }
    const systemResult = parseSystemToken(session, rest[2] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Solar system not found for /sov capture.",
      };
    }
    const result = captureSystemForOwner(
      systemResult.data,
      allianceID,
      corporationID,
    );
    if (!result.success) {
      return {
        success: false,
        message: buildHubErrorMessage("/sov capture", result.errorMsg),
      };
    }
    return {
      success: true,
      message: appendStatus(
        `Captured solar system ${systemResult.data} for alliance ${allianceID} corporation ${corporationID}.`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "lose") {
    let systemToken = "here";
    let nextAllianceToken = rest[0];
    let nextCorporationToken = rest[1];
    if (rest.length >= 1) {
      const candidateSystemResult = parseSystemToken(session, rest[0]);
      if (candidateSystemResult.success) {
        systemToken = rest[0];
        nextAllianceToken = rest[1];
        nextCorporationToken = rest[2];
      }
    }
    const systemResult = parseSystemToken(session, systemToken);
    if (!systemResult.success) {
      return {
        success: false,
        message: "Usage: /sov lose [allianceID|0] [corporationID|0] [here|systemID]",
      };
    }
    const nextAllianceID = normalizePositiveInteger(nextAllianceToken, null);
    const nextCorporationID = normalizePositiveInteger(nextCorporationToken, null);
    const result = loseSystemSovereignty(
      systemResult.data,
      nextAllianceID,
      nextCorporationID,
    );
    if (!result.success) {
      return {
        success: false,
        message: buildHubErrorMessage("/sov lose", result.errorMsg),
      };
    }
    return {
      success: true,
      message: appendStatus(
        nextAllianceID && nextCorporationID
          ? `Transferred solar system ${systemResult.data} to alliance ${nextAllianceID} corporation ${nextCorporationID}.`
          : `Cleared sovereignty ownership in solar system ${systemResult.data}.`,
        systemResult.data,
      ),
    };
  }

  if (subcommand === "clear") {
    const systemResult = parseSystemToken(session, rest[0] || "here");
    if (!systemResult.success) {
      return {
        success: false,
        message: "Usage: /sov clear [here|systemID]",
      };
    }
    const result = clearSystemSovereignty(systemResult.data);
    if (!result.success) {
      return {
        success: false,
        message: `Failed to clear sovereignty state: ${result.errorMsg}.`,
      };
    }
    return {
      success: true,
      message: appendStatus(
        `Cleared sovereignty state in solar system ${systemResult.data}.`,
        systemResult.data,
      ),
    };
  }

  return {
    success: false,
    message: buildHelpText(),
  };
}

module.exports = {
  executeSovCommand,
};
