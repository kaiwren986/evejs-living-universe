"use strict";

const path = require("path");
const {
  getActiveShipRecord,
  applyCharacterToSession,
} = require("../character/characterState");
const sessionRegistry = require("./sessionRegistry");
const itemStore = require("../inventory/itemStore");
const {
  getAllItems,
  getCharacterHangarShipItems,
} = itemStore;
const {
  getCharacterWallet,
  setCharacterBalanceAsync,
  adjustCharacterBalanceAsync,
  setCharacterPlexBalanceAsync,
  adjustCharacterPlexBalanceAsync,
} = require("../account/walletState");
const {
  EVERMARK_ISSUER_CORP_ID,
  adjustCharacterWalletLPBalance,
  adjustCorporationWalletLPBalance,
  getCharacterWalletLPBalance,
  getCharacterWalletLPBalances,
  getCorporationWalletLPBalance,
  setCharacterWalletLPBalance,
  setCorporationWalletLPBalance,
} = require("../corporation/lpWalletState");
const {
  PLEX_LOG_CATEGORY,
} = require("../account/plexVaultLogState");
const {
  resolveShipByName,
} = require("./shipTypeRegistry");
const {
  createCustomAllianceForCorporation,
  createCustomCorporation,
  findCorporationByName,
  joinCorporationToAllianceByName,
  getCorporationRecord,
} = require("../corporation/corporationState");
const {
  buildAllianceMemberSnapshot,
  buildAllianceSummary,
  buildCorporationSnapshot,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyCorporationChanged,
} = require("../corporation/corporationNotifications");

// The GM alliance commands change a corporation's alliance outside the normal
// founding/application flows, which tell everyone through these events. Take
// the snapshots before the change, then send the same notifications.
function captureAllianceAffiliationBefore(corporationRecord) {
  const corporationID = Number(corporationRecord && corporationRecord.corporationID) || 0;
  const previousAllianceID = Number(corporationRecord && corporationRecord.allianceID) || 0;
  return {
    corporationID,
    previousAllianceID,
    corporation: corporationID ? buildCorporationSnapshot(corporationID) : null,
    previousAlliance: previousAllianceID ? buildAllianceSummary(previousAllianceID) : null,
    previousMember: previousAllianceID
      ? buildAllianceMemberSnapshot(previousAllianceID, corporationID)
      : null,
  };
}

function notifyAllianceAffiliationChanged(before, allianceID) {
  const nextAllianceID = Number(allianceID) || 0;
  if (!before || !before.corporationID) {
    return;
  }
  if (before.previousAllianceID && before.previousAllianceID !== nextAllianceID) {
    notifyAllianceMemberChanged(before.previousAllianceID, before.corporationID, before.previousMember);
    notifyAllianceChanged(before.previousAllianceID, before.previousAlliance);
  }
  if (nextAllianceID) {
    notifyAllianceChanged(nextAllianceID, null);
    notifyAllianceMemberChanged(nextAllianceID, before.corporationID, null);
  }
  notifyCorporationChanged(before.corporationID, before.corporation);
}
const worldData = require("../../space/worldData");
const spaceRuntime = require("../../space/runtime");
const {
  playPlayableEffect,
} = require("./specialFxRegistry");
const npcService = require("../../space/npc");
const {
  CAPITAL_NPC_CHAT_COMMANDS,
  CAPITAL_NPC_HELP_LINES,
} = require("./capitalNpc");
const {
  WORMHOLE_CHAT_COMMANDS,
  WORMHOLE_HELP_LINES,
  executeWormholeCommand,
} = require("./wormhole");
const {
  TRIG_DRIFTER_CHAT_COMMANDS,
  TRIG_DRIFTER_HELP_LINES,
  executeTrigDrifterCommand,
} = require("./trigDrifter");
const {
  GATE_SKIN_CHAT_COMMANDS,
  GATE_SKIN_HELP_LINES,
  executeGateSkinCommand,
} = require("../../space/gateSkinCommand");
const {
  handleShipDirtCommand,
  handleShipKillmarksCommand,
} = require("../ship/shipAppearanceGmCommands");
const {
  getDockedLocationID,
  getDockedLocationKind,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  executeExtractionGmCommand,
  executeStructureGmCommand,
  executeUpwellCommand,
} = require(path.join(__dirname, "../structure/structureChatCommands"));
const {
  executeUpwellAutoCommand,
} = require(path.join(__dirname, "../structure/structureAutoCommands"));
const {
  POS_HELP_LINES,
  executePosCommand,
} = require(path.join(__dirname, "../starbase/posChatCommands"));
const structureLog = require(path.join(__dirname, "../structure/structureLog"));
const {
  executeSovCommand,
} = require(path.join(__dirname, "../sovereignty/sovChatCommands"));
const {
  executeSovAutoCommand,
} = require(path.join(__dirname, "../sovereignty/sovAutoCommands"));
const sovLog = require(path.join(__dirname, "../sovereignty/sovLog"));
const {
  handleSuperTitanCommand: executeSuperTitanCommand,
  handleSuperTitanShowCommand: executeSuperTitanShowCommand,
} = require(path.join(__dirname, "../superweapons/superweaponCommands"));
const {
  handleMinerCommand: executeMinerCommand,
  handleMiningFleetCommand: executeMiningFleetCommand,
  handleMiningFleetAggroCommand: executeMiningFleetAggroCommand,
  handleMiningFleetClearCommand: executeMiningFleetClearCommand,
  handleMiningFleetStatusCommand: executeMiningFleetStatusCommand,
  handleMiningFleetRetreatCommand: executeMiningFleetRetreatCommand,
  handleMiningFleetResumeCommand: executeMiningFleetResumeCommand,
  handleMiningFleetHaulCommand: executeMiningFleetHaulCommand,
  handleMiningStateStatusCommand: executeMiningStateStatusCommand,
  handleMiningStateResetCommand: executeMiningStateResetCommand,
} = require(path.join(__dirname, "../mining/miningCommandService"));
const {
  handleOrcaCommand: executeOrcaCommand,
  handleProbeCommand: executeProbeCommand,
  handleProbe2Command: executeProbe2Command,
  handleCburstCommand: executeCburstCommand,
  handleGuardianCommand: executeGuardianCommand,
  handleBasiliskCommand: executeBasiliskCommand,
  handleEwarCommand: executeEwarCommand,
  handleTrigCommand: executeTrigCommand,
} = require(path.join(__dirname, "../ship/devCommandShipRuntime"));
const {
  handleRemoteRepairFleetCommand: executeRemoteRepairFleetCommand,
} = require(path.join(__dirname, "../../RemoteRepShow/remoteRepairFleetCommands"));
const {
  executeBlueprintAutoCommand,
  executeBlueprintCommand,
} = require(path.join(__dirname, "../industry/industryChatCommands"));
const {
  executeBookmarkAutoCommand,
} = require(path.join(__dirname, "../bookmark/bookmarkChatCommands"));
const {
  executeCalendarAutoCommand,
} = require(path.join(__dirname, "../calendar/calendarChatCommands"));
const {
  executeReprocessingSmokeCommand,
} = require(path.join(__dirname, "../reprocessing/reprocessingChatCommands"));
const {
  resolveWelcomeSenderID,
  sendMail,
} = require(path.join(__dirname, "../mail/mailState"));

const DEFAULT_MOTD_MESSAGE = [
  "<b><color=0xfff4d35e>Welcome to EveJS Elysian.</color></b><br>",
  "A lot already works, but you <color=0xffff8080>will</color> still find bugs.<br><br>",
  "<b><color=0xff80d8ff>@Icey</color></b> founded this project. Without him, none of this exists.<br><br>",
  "<b><color=0xffffc266>@John Elysian</color></b> is the reason you can undock, warp, fire missiles, use the market, experience time dilation, and touch a long list of other core systems. A lot of this took weeks of 24/7 work to get running against the latest client, and some of it simply had not been done properly before.<br><br>",
  "Big respect as well to <b><color=0xffd7bde2>EvE-MU</color></b> for proving this path was possible long before AI tools existed.<br><br>",
  "<b><color=0xff9be564>@Deer_Hunter</color></b> helped keep development alive when the costs were make-or-break. Thank you.<br><br>",
  "<color=0xffff8080>If you hit a bug, please report it in the Discord linked on the EveJS Elysian GitHub and include exact steps to reproduce it.</color>",
].join(" ");
const DEER_HUNTER_MESSAGE =
  "Thank you, Deer_Hunter on Discord, for helping make EveJS Elysian possible with your contribution to rising AI development costs.";
const DEER_HUNTER_EFFECT_NAME = "microjump";
const {
  handledResult,
} = require(path.join(__dirname, "./commands/commandReplies"));
const {
  normalizeCommandName,
  parseAmount,
  tokenizeQuotedArguments,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commands/commandArguments"));
const {
  levenshteinDistance,
  formatSuggestions,
} = require(path.join(__dirname, "./commands/commandSuggestions"));
const {
  getSessionDockedStationID,
  getSessionCurrentSolarSystemID,
  isConnectedSessionInAbyssalDeadspace,
} = require(path.join(__dirname, "./commands/commandSessionLocation"));
const {
  hasStaffDebugRole,
} = require(path.join(__dirname, "./commands/commandAccess"));
const {
  handleSolarTeleport,
  handleTransportCommand,
  handleFetchCommand,
  handleTeleCommand,
  handleHomeDock,
  handleDeadwarpCommand,
} = require(path.join(__dirname, "./commands/transport"));
const {
  handleGmSkillsCommand,
  handleAllSkillsCommand,
  handleBackInTimeCommand,
  handleExpertSystemCommand,
  handleGiveSkillCommand,
  handleRemoveSkillCommand,
} = require(path.join(__dirname, "./commands/skills"));
const {
  buildCelestialEntity,
  buildLargeCollidableObjectEntity,
  handleCelestialCommand,
  handleLargeCollidableObjectCommand,
  handleJetcanCommand,
  handleDebrisFieldCommand,
  handleTestClearCommand,
  handleSystemJunkClearCommand,
  handleFireCommand,
  handleKeepstarCommand,
  handleFire2Command,
} = require(path.join(__dirname, "./commands/spaceObjects"));
const {
  getContainer1SeedPlan,
  getGmWeaponsSeedPlan,
  getPropulsionCommandItemTypes,
  handleShipSpawn,
  handleGiveItemCommand,
  handleCreateItemCommand,
  handleLoadCommand,
  handleMineralsCommand,
  handleContainer1Command,
  handleGmShipsCommand,
  handlePropCommand,
  handleGmWeaponsCommand,
} = require(path.join(__dirname, "./commands/itemSeeding"));
const {
  resolveSingleRackCommandPreset,
  handlePresetSingleRackCommand,
  handleLesmisCommand,
} = require(path.join(__dirname, "./commands/fittingPresets"));
const { handleFitCommand } = require("./commands/fitModule");
const { handleUnfitCommand } = require("./commands/unfitModule");
const {
  handleSpawnSiteCommand,
  handleNpcCommand,
  handleMissileNpcCommand,
  handleCapitalNpcCommand,
  handleNpcTestCommand,
  handleNpcWarpCommand,
  handleConcordCommand,
  handleNpcClearCommand,
  handleGateOperatorCommand,
} = require(path.join(__dirname, "./commands/npcCommands"));
const {
  handleCrimewatchCommand,
  handleNaughtyCommand,
  handleSecurityStatusCommand,
} = require(path.join(__dirname, "./commands/crimewatch"));
const {
  handleInvuCommand,
  handleHealCommand,
  handleRepairModulesCommand,
  handleNativeHealCommand,
  handleDamageCommand,
} = require(path.join(__dirname, "./commands/shipHealth"));
const {
  handleAbyssalDebugCommand,
  handleAbyssalLayoutCommand,
  handleAbyssalStatusCommand,
  handleAbyssalRescueCommand,
} = require(path.join(__dirname, "./commands/abyssalDebug"));
const {
  resolveAbyssalSuicideAuthority,
  isSessionShipCapsuleBeforeDestruction,
  handleSuicideCommand,
  handleDeathTestCommand,
  handleStructureDeathTestCommand,
} = require(path.join(__dirname, "./commands/deathTests"));
const {
  handleLoadSystemCommand,
  handleLoadAllSystemsCommand,
  handleTimeDilationCommand,
} = require(path.join(__dirname, "./commands/timeDilation"));
const {
  handleGrantShipLogoCommand,
} = require(path.join(__dirname, "./commands/shipLogos"));
const {
  handleSetStandingCommand,
  handleMaxAgentStandingsCommand,
} = require(path.join(__dirname, "./commands/standings"));
const {
  handleChatColorCommand,
} = require(path.join(__dirname, "./commands/chatColors"));

const {
  handleAllSkinsCommand,
} = require(path.join(__dirname, "./commands/shipSkins"));
const {
  handleAllSkinrCommand,
} = require(path.join(__dirname, "./commands/skinrComponents"));
const {
  handleSkinrCommand,
} = require(path.join(__dirname, "./commands/skinrDrafts"));
const {
  handleSigscanCommand,
  handleSigsCommand,
} = require(path.join(__dirname, "./commands/signatures"));
const {
  handleMissionCompleteCommand,
} = require(path.join(__dirname, "./commands/missions"));
const {
  handleOverlayRefreshCommand,
} = require(path.join(__dirname, "./commands/sensorOverlay"));
const {
  handleEffectCommand,
} = require(path.join(__dirname, "./commands/specialEffects"));

const AVAILABLE_SLASH_COMMANDS = [
  "copyship",
  "orbitals",
  "events",
  "addisk",
  "addlp",
  "addevermarks",
  "addcorpevermarks",
  "announce",
  "addplex",
  "allskills",
  "allskins",
  "allskinr",
  "skinr",
  "corpcreate",
  "blue",
  "commandlist",
  "commands",
  "deer_hunter",
  "expertsystem",
  "expertsystems",
  "giveme",
  "giveskill",
  "grantshipemblem",
  "grantcorplogo",
  "grantalliancelogo",
  "hangar",
  "dmg",
  "dogma",
  "heal",
  "ceq",
  "interference",
  "help",
  "item",
  "iteminfo",
  "killmark",
  "killmarks",
  "keepstar",
  "pos",
  "upwell",
  "upwellauto",
  "structure",
  "extraction",
  "war",
  "bpauto",
  "bp",
  "bookmarkauto",
  "calauto",
  "reprocesssmoke",
  "laser",
  "lasers",
  "hybrids",
  "railgun",
  "projectiles",
  "removeskill",
  "autocannon",
  "rocket",
  "light",
  "heavy",
  "torp",
  "lesmis",
  "miner",
  "orca",
  "probe",
  "probe2",
  "trig",
  "setstanding",
  "maxagentstandings",
  "fullstandings",
  "sigs",
  "sigscan",
  "missioncomplete",
  "overlayrefresh",
  "cburst",
  "guardian",
  "basilisk",
  "ewar",
  "backintime",
  "dock",
  "dirt",
  "effect",
  "fire",
  "fire2",
  "rr",
  "supertitan",
  "supertitanshow",
  "titansupershow",
  "giveitem",
  "fit",
  "unfit",
  "unload",
  "online",
  "getshipsetup",
  "repairmodules",
  "reportdesync",
  "fetch",
  "spawn",
  "spawnn",
  "entity",
  "unspawn",
  "create",
  "createitem",
  "load",
  "minerals",
  "gmweapons",
  "gmships",
  "gmskills",
  "container",
  "container1",
  "jetcan",
  "motd",
  "mailme",
  "spawnsite",
  "population", // Living Universe
  "npc",
  "mnpc",
  "npctest",
  "npctest2",
  "npcminer",
  "npcmineraggro",
  "npcminerpanic",
  "npcminerretreat",
  "npcminerresume",
  "npcminerhaul",
  "npcminerclear",
  "npcminerstatus",
  "miningreset",
  "miningstatus",
  "npcclear",
  "joinalliance",
  "loadallsys",
  "loadsys",
  "solar",
  "tele",
  "tr",
  "prop",
  "npcw",
  "wnpc",
  "spawncontainer",
  "spawnwreck",
  "session",
  "setalliance",
  "sov",
  "sovauto",
  "autosov",
  "setplex",
  "setlp",
  "setevermarks",
  "setcorpevermarks",
  "setisk",
  "ship",
  "celestial",
  "lco",
  "suicide",
  "sysjunkclear",
  "testclear",
  "teal",
  "tidi",
  "deathtest",
  "deathstructure",
  "deadwarp",
  "typeinfo",
  "wallet",
  "lp",
  "evermarks",
  "corpevermarks",
  "where",
  "abyssaldebug",
  "abyssallayout",
  "abyssalstatus",
  "abyssalrescue",
  "who",
  ...CAPITAL_NPC_CHAT_COMMANDS,
  ...WORMHOLE_CHAT_COMMANDS,
  ...TRIG_DRIFTER_CHAT_COMMANDS,
  ...GATE_SKIN_CHAT_COMMANDS,
  "wreck",
  "concord",
  "cwatch",
  "naughty",
  "gateconcord",
  "gaterats",
  "invu",
  "secstatus",
  "yellow",
  "red",
];
const COMMANDS_HELP_TEXT = [
  "Commands:",
  "/help",
  "/motd",
  "/mailme",
  "/allskills",
  "/npc [amount] [faction|profile|pool]",
  "/mnpc [amount] [faction|profile|pool]",
  "/celestial <typeID>",
  "/lco <typeID>",
  "/spawnsite <templateID> [offsetMeters]",
  ...CAPITAL_NPC_HELP_LINES,
  ...WORMHOLE_HELP_LINES,
  ...TRIG_DRIFTER_HELP_LINES,
  ...GATE_SKIN_HELP_LINES,
  "/npcminer [amount] [profile|pool|group] | /npcminer ice [amount]",
  "/npcmineraggro [amount] [profile|pool|group]",
  "/npcminerpanic [amount] [profile|pool|group]",
  "/npcminerretreat",
  "/npcminerresume",
  "/npcminerhaul",
  "/npcminerclear",
  "/npcminerstatus",
  "/miningreset",
  "/miningstatus",
  "/npcw [amount] [profile|pool]",
  "/npcclear <system [npc|concord|all]|radius <meters> [npc|concord|all]>",
  "/dock",
  "/dirt <0.0-1.0> [shipID]",
  "/dmg [light|medium|heavy]",
  "/killmarks <count> [shipID]",
  "/heal",
  "/ceq <0-100> (GM only; /ceq 100 refills your CEQ)",
  "/interference reset (GM only; resets signal interference in your current system)",
  "/chowner <containerID> <characterID>",
  "/deer_hunter",
  "/effect <name>",
  "/keepstar",
  ...POS_HELP_LINES,
  "/upwell <subcommand>",
  "/upwellauto <type|structureID>",
  "/upwellauto undock <structureID> [count] [all|unpublished|published]",
  "/structure <state|timer|deploytimer|unanchor|abandontimer> <structureID> [value]",
  "/extraction advance <mid|stop|ready|decay> [structureID]",
  "/war start <warID>",
  "/bpauto <subcommand>",
  "/bp <subcommand>",
  "/bookmarkauto <subcommand>",
  "/calauto <subcommand>",
  "/reprocesssmoke <subcommand>",
  "/backintime [me|characterID|character name]",
  "/expertsystem <list|inspect|status|add|remove|clear|giveitem|consume>",
  "/sov <subcommand>",
  "/sovauto <subcommand>",
  "/fire [ship name|typeID]",
  "/fire2 [count]",
  "/supertitan",
  "/supertitanshow [count]",
  "/titansupershow [count]",
  "/giveitem <item name|typeID> [amount]",
  "/fit me <module name|typeID>",
  "/copyship <activeShipID> 1",
  "/unfit me <module name|typeID|itemID|all>",
  "/dogma <me|activeShipID> <attributeName> = <value> | /dogma me reset",
  "/create <item name|typeID> [amount]",
  "/createitem <item name|typeID> [amount]",
  "/minerals",
  ".container1",
  "/giveskill <target> <skill|all|super> [level]",
  "/allskins [me|characterID|character name]",
  "/allskinr [me|characterID|character name]",
  "/skinr list [target]",
  "/skinr skins [target] | /skinr delete <SKIN hash> [target] | /skinr delete confirm all [target]",
  "/skinr export <draft UUID> [target] | /skinr import <filename.skinr.json> [target]",
  "/skinr store import <filename.skinr.json> [price [ISK|PLEX] [quantity]]",
  "/removeskill <target> <skill|all>",
  "/laser",
  "/lasers",
  "/hybrids",
  "/railgun",
  "/projectiles",
  "/autocannon",
  "/rocket",
  "/light",
  "/heavy",
  "/torp",
  "/lesmis",
  "/miner",
  "/orca",
  "/probe",
  "/probe2",
  "/trig [hull|family]",
  "/setstanding <value> <owner name|id> [target]",
  "/maxagentstandings [target]",
  "/fullstandings [target]",
  "/sigs",
  "/sigscan",
  "/missioncomplete [agentID|all]",
  "/overlayrefresh",
  "/cburst",
  "/guardian",
  "/basilisk",
  "/ewar",
  "/gmweapons",
  "/container [container type] [count]",
  "/jetcan <item name|typeID> [amount]",
  "/gmships",
  "/gmskills",
  "/where",
  "/orbitals [planetID] — list local customs offices and skyhooks, including while docked",
  "/who",
  "/concord [amount] [profile|pool]",
  "/cwatch [status|clear|safety <full|partial|none>|weapon <off|seconds>|pvp <off|seconds>|npc <off|seconds>|criminal <off|seconds>|suspect <off|seconds>|disapproval <off|seconds>]",
  "/naughty",
  "/secstatus [status]",
  "/gateconcord [on|off]",
  "/gaterats [on|off]",
  "/invu [on|off]",
  "/wallet",
  "/lp [npc corp name|corpID]",
  "/addlp <amount> <npc corp name|corpID>",
  "/setlp <amount> <npc corp name|corpID>",
  "/evermarks",
  "/grantshipemblem <corp|alliance|both> [current|ship name|typeID]",
  "/grantcorplogo [current|ship name|typeID]",
  "/grantalliancelogo [current|ship name|typeID]",
  "/corpcreate <corporation name>",
  "/setalliance <alliance name>",
  "/joinalliance <alliance name>",
  "/loadallsys",
  "/loadsys",
  "/tidi [0.1-1.0]",
  "/prop",
  "/solar <system name>",
  "/tele <character name|characterID>",
  "/tr <me|characterID|entityID> <destination|bookmark=bookmarkID|pos=x,y,z|offset=x,y,z>",
  "/suicide",
  "/sysjunkclear",
  "/wreck [wreck type] [count]",
  "/deathtest [ship name|typeID] [count]",
  "/deathstructure <sovhub|skyhook|bloodraiderfob|guristasfob|angelfob|mercden|vigilance|dreamer|astrahus|typeID> [count] [delaySeconds]",
  "/deadwarp",
  "/testclear",
  "/addisk <amount>",
  "/addevermarks <amount>",
  "/addcorpevermarks <amount>",
  "/addplex <amount>",
  "/blue",
  "/setisk <amount>",
  "/setevermarks <amount>",
  "/setcorpevermarks <amount>",
  "/setplex <amount>",
  "/corpevermarks",
  "/red",
  "/ship <ship name|typeID>",
  "/giveme <ship name|typeID>",
  "/hangar",
  "/item <item name|typeID> [amount]",
  "/iteminfo <itemID>",
  "/typeinfo <ship name|typeID>",
  "/session",
  "/announce <message>",
  "/teal",
  "/yellow",
].join("\n");

const ABYSSAL_PLAYER_HELP_TEXT = [
  "Abyssal Deadspace:",
  "Abyssal filaments create a temporary, scannable trace near your ship. Entering it starts a private three-room run with its own isolated space scene.",
  "Current entry supports one cruiser pilot using 1 matching filament, up to two destroyer pilots using 2, or up to three frigate pilots using 3. Eligible small-hull fleet members independently activate the shared Trace.",
  "Destroy each room's hostile wave to unlock its transfer conduit. The third room's exit conduit returns you near the recorded origin trace.",
  "Rooms can award a Bioadaptive Cache after their objective is cleared. Encounter and reward strength scale conservatively by filament tier.",
  "Dark, Electrical, Exotic, Firestorm, and Gamma weather apply their configured ship, resistance, capacitor, scan, or velocity effects for the run.",
  "Inside Abyssals: normal warp out, fleet warp to the runner, cloak, mobile depot, directional scan, the system scanner, and the starmap are blocked. Combat-probe scans remain available, but probes outside the pocket boundary are lost after movement settles.",
  "Timeouts are lethal. Expiry suppresses rewards, destroys the participant ship and capsule through normal destruction handling, and cleans the run.",
  "Current limitations: group ownership, admission, survivor, disconnect, finalization, and recovery semantics are EveJS-authored policy rather than a retail-exact claim. Encounter balance, loot balance, and some environment presentation also remain conservative.",
].join("\n");
const STAFF_ABYSSAL_HELP_TEXT = [
  "Staff/Admin Abyssal:",
  "/abyssaldebug suppressor <on|off|status>",
  "/abyssallayout <list|status|next <layoutID>|clear>",
  "/abyssalstatus [status|weather|fx <effectKey>|scenery <candidateKey|list [category]|next|prev> [near|mid|far]|help]",
  "/abyssalrescue",
  "Use /abyssalstatus outside and inside a run to inspect active-room, origin-return, reward, extraction, restriction, timeout, Calm Dark FX state, and scenery probe state.",
  "Use /abyssalrescue if isolated-scene relog recovery fails and leaves the pilot in an Abyssal host location.",
  "Use /abyssalstatus help for QA notes, server-owned policies, and current placeholder limitations.",
].join("\n");

function suggestCommands(query) {
  const normalizedQuery = normalizeCommandName(query);
  if (!normalizedQuery) {
    return [];
  }

  return [...AVAILABLE_SLASH_COMMANDS]
    .map((commandName) => {
      let score = levenshteinDistance(normalizedQuery, commandName);
      if (commandName.startsWith(normalizedQuery)) {
        score = Math.min(score, 0);
      } else if (commandName.includes(normalizedQuery)) {
        score = Math.min(score, 1);
      }
      return { commandName, score };
    })
    .filter((entry) => entry.score <= Math.max(2, Math.ceil(entry.commandName.length * 0.35)))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.commandName.localeCompare(right.commandName);
    })
    .slice(0, 5)
    .map((entry) => `/${entry.commandName}`);
}

function formatIsk(value) {
  return `${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ISK`;
}

function formatPlex(value) {
  return `${Math.max(0, Math.trunc(Number(value || 0))).toLocaleString("en-US")} PLEX`;
}

function formatEvermarks(value) {
  return `${Math.max(0, Math.trunc(Number(value || 0))).toLocaleString("en-US")} EverMarks`;
}

function formatSignedEvermarks(value) {
  const numeric = Math.trunc(Number(value || 0));
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric.toLocaleString("en-US")} EverMarks`;
}

function formatLoyaltyPoints(value) {
  return `${Math.max(0, Math.trunc(Number(value || 0))).toLocaleString("en-US")} LP`;
}

function formatSignedLoyaltyPoints(value) {
  const numeric = Math.trunc(Number(value || 0));
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric.toLocaleString("en-US")} LP`;
}

function formatSignedPlex(value) {
  const numeric = Math.trunc(Number(value || 0));
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric.toLocaleString("en-US")} PLEX`;
}

function formatCorporationLabel(corporationRecord) {
  if (!corporationRecord) {
    return "corporation";
  }
  const corporationID = normalizePositiveInteger(corporationRecord.corporationID);
  const name = String(corporationRecord.corporationName || "").trim();
  if (name && corporationID) {
    return `${name}(${corporationID})`;
  }
  return corporationID ? `corporation ${corporationID}` : "corporation";
}

function normalizeLpIssuerLookupText(value) {
  return tokenizeQuotedArguments(value).join(" ").trim();
}

function parseLoyaltyPointMutationArgs(argumentText) {
  const tokens = tokenizeQuotedArguments(argumentText);
  if (tokens.length < 2) {
    return {
      amount: null,
      issuerText: "",
    };
  }
  return {
    amount: parseAmount(tokens[0]),
    issuerText: tokens.slice(1).join(" ").trim(),
  };
}

function resolveLoyaltyPointIssuerCorporation(issuerText) {
  const normalizedIssuerText = normalizeLpIssuerLookupText(issuerText);
  if (!normalizedIssuerText) {
    return {
      success: false,
      errorMsg: "ISSUER_REQUIRED",
    };
  }

  let corporationRecord = null;
  if (/^(evermarks?|paragon lp)$/i.test(normalizedIssuerText)) {
    corporationRecord = getCorporationRecord(EVERMARK_ISSUER_CORP_ID);
  } else {
    const corporationID = normalizePositiveInteger(normalizedIssuerText);
    corporationRecord = corporationID
      ? getCorporationRecord(corporationID)
      : findCorporationByName(normalizedIssuerText);
  }

  if (!corporationRecord) {
    return {
      success: false,
      errorMsg: "ISSUER_NOT_FOUND",
    };
  }

  if (corporationRecord.isNPC !== true) {
    return {
      success: false,
      errorMsg: "ISSUER_NOT_NPC",
      data: corporationRecord,
    };
  }

  return {
    success: true,
    data: corporationRecord,
  };
}

function formatLoyaltyPointIssuerError(result, issuerText) {
  if (!result || result.errorMsg === "ISSUER_REQUIRED") {
    return "Usage: /addlp <amount> <npc corp name|corpID>";
  }
  if (result.errorMsg === "ISSUER_NOT_NPC") {
    return `${formatCorporationLabel(result.data)} is not an NPC corporation. LP issuers must be NPC corporations.`;
  }
  return `NPC corporation not found: ${String(issuerText || "").trim()}.`;
}

function getLoyaltyPointSummary(session, issuerText = "") {
  if (!session || !session.characterID) {
    return "Select a character before checking LP.";
  }

  const normalizedIssuerText = normalizeLpIssuerLookupText(issuerText);
  if (normalizedIssuerText) {
    const issuerResult = resolveLoyaltyPointIssuerCorporation(normalizedIssuerText);
    if (!issuerResult.success) {
      return formatLoyaltyPointIssuerError(issuerResult, normalizedIssuerText);
    }
    const amount = getCharacterWalletLPBalance(
      session.characterID,
      issuerResult.data.corporationID,
    );
    return `${formatCorporationLabel(issuerResult.data)} LP: ${formatLoyaltyPoints(amount)}.`;
  }

  const balances = getCharacterWalletLPBalances(session.characterID);
  if (balances.length === 0) {
    return "No LP balances.";
  }

  const summary = balances
    .map((entry) => {
      const corporationRecord = getCorporationRecord(entry.issuerCorpID);
      return `${formatCorporationLabel(corporationRecord || { corporationID: entry.issuerCorpID })}: ${formatLoyaltyPoints(entry.amount)}`;
    })
    .join("; ");
  return `LP balances: ${summary}.`;
}

function handleDeerHunterCommand(session, chatHub, options) {
  const effectResult = playPlayableEffect(session, DEER_HUNTER_EFFECT_NAME);
  const message = effectResult.success
    ? `${DEER_HUNTER_MESSAGE} Your ship celebrates with a brief micro-jump flash.`
    : DEER_HUNTER_MESSAGE;
  return handledResult(chatHub, session, options, message);
}

function handleMailMeCommand(session, argumentText, chatHub, options) {
  const characterID = normalizePositiveInteger(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
  if (!characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /mailme.",
    );
  }

  const extraNote = String(argumentText || "").trim();
  const senderID = resolveWelcomeSenderID();
  const subject = "EveJS Elysian live mail test";
  const bodyLines = [
    "This is a live Eve Mail generated by /mailme.",
    "",
    "If this popped up and landed in your mailbox, the live notify path and the stored mailbox path are both working.",
  ];
  if (extraNote) {
    bodyLines.push("");
    bodyLines.push(`Note: ${extraNote}`);
  }
  bodyLines.push("");
  bodyLines.push(`Generated at: ${new Date().toISOString()}`);

  const sendResult = sendMail({
    senderID,
    toCharacterIDs: [characterID],
    title: subject,
    body: bodyLines.join("<br>"),
    saveSenderCopy: false,
    excludeSession: null,
  });
  if (!sendResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Test mail failed: ${sendResult.errorMsg || "unknown error"}.`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Live Eve Mail sent to your mailbox: "${subject}".`,
  );
}

function refreshAffiliationSessions(characterIDs) {
  const targetCharacterIDs = new Set(
    (Array.isArray(characterIDs) ? characterIDs : [])
      .map((characterID) => normalizePositiveInteger(characterID))
      .filter(Boolean),
  );

  if (targetCharacterIDs.size === 0) {
    return;
  }

  for (const targetSession of sessionRegistry.getSessions()) {
    const characterID = normalizePositiveInteger(
      targetSession && (targetSession.characterID || targetSession.charid),
    );
    if (!characterID || !targetCharacterIDs.has(characterID)) {
      continue;
    }

    // Corporation and alliance changes carry the new corp roles, as TQ's
    // session change on founding a corporation does (golden log "Create Corp").
    applyCharacterToSession(targetSession, characterID, {
      selectionEvent: false,
      emitNotifications: true,
      includeRoleChanges: true,
      logSelection: false,
    });
  }
}

function getWalletSummary(session) {
  const wallet = session && session.characterID
    ? getCharacterWallet(session.characterID)
    : null;
  if (!wallet) {
    return null;
  }

  const deltaText =
    wallet.balanceChange === 0
      ? "0.00 ISK"
      : `${wallet.balanceChange > 0 ? "+" : ""}${formatIsk(wallet.balanceChange)}`;
  const evermarks = getCharacterWalletLPBalance(
    session.characterID,
    EVERMARK_ISSUER_CORP_ID,
  );

  return `Wallet balance: ${formatIsk(wallet.balance)}. PLEX: ${formatPlex(wallet.plexBalance)}. EverMarks: ${formatEvermarks(evermarks)}. Last ISK change: ${deltaText}.`;
}

function getLocationSummary(session) {
  if (!session || !session.characterID) {
    return "No character selected.";
  }

  const dockedLocationID = getDockedLocationID(session);
  if (dockedLocationID) {
    const kind = getDockedLocationKind(session);
    return `Docked in ${kind} ${dockedLocationID}, solar system ${session.solarsystemid2 || session.solarsystemid || "unknown"}.`;
  }

  if (session.solarsystemid2 || session.solarsystemid) {
    return `In space in solar system ${session.solarsystemid2 || session.solarsystemid}.`;
  }

  return "Current location is unknown.";
}

function formatConnectedCharacterLocation(session) {
  if (isConnectedSessionInAbyssalDeadspace(session)) {
    return "Abyssal Deadspace";
  }
  const currentSystemID = getSessionCurrentSolarSystemID(session);
  const currentSystem = worldData.getSolarSystemByID(currentSystemID);
  const systemLabel =
    (currentSystem && currentSystem.solarSystemName) ||
    (currentSystemID ? `system ${currentSystemID}` : "unknown system");

  const dockedLocationID = getSessionDockedStationID(session);
  if (!dockedLocationID) {
    return systemLabel;
  }

  const station = worldData.getStationByID(dockedLocationID);
  const structure = station ? null : worldData.getStructureByID(dockedLocationID);
  const dockedLocationLabel =
    (station && station.stationName) ||
    (structure && (structure.itemName || structure.name)) ||
    `${getDockedLocationKind(session)} ${dockedLocationID}`;

  return `${systemLabel} | Docked: ${dockedLocationLabel}`;
}

function getConnectedCharacterSummary() {
  const preferredSessionsByCharacterID = new Map();
  for (const session of sessionRegistry.getSessions()) {
    const characterID = Number(session && (session.characterID || session.charID || session.charid || 0));
    if (!Number.isInteger(characterID) || characterID <= 0) {
      continue;
    }

    const current = preferredSessionsByCharacterID.get(characterID) || null;
    if (sessionRegistry.isPreferredCharacterSession(session, current)) {
      preferredSessionsByCharacterID.set(characterID, session);
    }
  }

  const connected = Array.from(preferredSessionsByCharacterID.values())
    .sort((left, right) => {
      const leftName = String(left.characterName || left.userName || "Unknown").toLowerCase();
      const rightName = String(right.characterName || right.userName || "Unknown").toLowerCase();
      if (leftName !== rightName) {
        return leftName.localeCompare(rightName);
      }
      return Number(left.characterID || 0) - Number(right.characterID || 0);
    })
    .map((session) => {
      const characterName = session.characterName || session.userName || "Unknown";
      const characterID = Number(session.characterID || session.charID || session.charid || 0) || 0;
      return `${characterName}(${characterID}) - ${formatConnectedCharacterLocation(session)}`;
    });

  if (connected.length === 0) {
    return "No active characters are connected.";
  }

  return `Connected characters (${connected.length}):\n${connected.join("\n")}`;
}

function getSessionSummary(session) {
  if (!session || !session.characterID) {
    return "No active character session.";
  }

  return [
    `char=${session.characterName || "Unknown"}(${session.characterID})`,
    `ship=${session.shipName || "Ship"}(${session.shipID || session.shipid || 0})`,
    `corp=${session.corporationID || 0}`,
    `${getDockedLocationKind(session)}=${getDockedLocationID(session) || 0}`,
    `system=${session.solarsystemid2 || session.solarsystemid || 0}`,
    `wallet=${formatIsk(session.balance || 0)}`,
  ].join(" | ");
}

function getHangarSummary(session) {
  if (!session || !session.characterID) {
    return "No active character session.";
  }

  const stationId = getDockedLocationID(session);
  if (!stationId) {
    return "You must be docked to inspect the ship hangar.";
  }

  const activeShip = getActiveShipRecord(session.characterID);
  const hangarShips = getCharacterHangarShipItems(session.characterID, stationId);
  const shipSummary = hangarShips
    .map((ship) => `${ship.itemName}(${ship.itemID})`)
    .join(", ");

  return [
    `Active ship: ${activeShip ? `${activeShip.itemName}(${activeShip.itemID})` : "none"}.`,
    `Hangar ships (${hangarShips.length}): ${shipSummary || "none"}.`,
  ].join(" ");
}

function getItemSummary(argumentText) {
  const itemID = Number(argumentText);
  if (!Number.isInteger(itemID) || itemID <= 0) {
    return "Usage: /item <itemID>";
  }

  const item = getAllItems()[String(itemID)];
  if (!item) {
    return `Item not found: ${itemID}.`;
  }

  return [
    `Item ${item.itemID}: ${item.itemName || "Unknown"}`,
    `type=${item.typeID}`,
    `owner=${item.ownerID}`,
    `location=${item.locationID}`,
    `flag=${item.flagID}`,
    `singleton=${item.singleton}`,
    `quantity=${item.quantity}`,
  ].join(" | ");
}

function sendAnnouncement(chatHub, session, message) {
  if (!message) {
    return;
  }

  for (const targetSession of sessionRegistry.getSessions()) {
    if (chatHub) {
      chatHub.sendSystemMessage(targetSession, message);
    }
  }
}

function getCommandsHelpText(session) {
  const voidReplayHelp = require("../../config").voidReplayEnabled === true
    ? "\n/voidreplay — replay Ruined Electrical from an expired filament in cargo"
    : "";
  if (!hasStaffDebugRole(session)) {
    return `${COMMANDS_HELP_TEXT}\n\n${ABYSSAL_PLAYER_HELP_TEXT}${voidReplayHelp}`;
  }
  return `${COMMANDS_HELP_TEXT}\n\n${ABYSSAL_PLAYER_HELP_TEXT}${voidReplayHelp}\n\n${STAFF_ABYSSAL_HELP_TEXT}\n/fireshow [count|stop] — temporary native festival formation\n/gate <type> <destination> | /gate stop\n/gateshowcase [destination|stop]`;
}

function executeChatCommand(session, rawMessage, chatHub, options = {}) {
  const trimmed = String(rawMessage || "").trim();
  if (!trimmed.startsWith("/") && !trimmed.startsWith(".")) {
    return { handled: false };
  }

  const commandLine = trimmed.slice(1).trim();
  if (!commandLine) {
    return handledResult(
      chatHub,
      session,
      options,
      "No command supplied. Use /help.",
    );
  }

  const [commandName, ...rest] = commandLine.split(/\s+/);
  const command = normalizeCommandName(commandName);
  const argumentText = rest.join(" ").trim();

  if (
    command === "help" ||
    command === "commands" ||
    command === "commandlist"
  ) {
    return handledResult(chatHub, session, options, getCommandsHelpText(session));
  }

  if (command === "copyship") {
    return require("./commands/copyShip").handleCopyShipCommand(session, argumentText, chatHub, options);
  }

  if (command === "motd") {
    return handledResult(chatHub, session, options, DEFAULT_MOTD_MESSAGE);
  }

  if (command === "mailme") {
    return handleMailMeCommand(session, argumentText, chatHub, options);
  }

  if (command === "deer_hunter") {
    return handleDeerHunterCommand(session, chatHub, options);
  }

  if (
    command === "blue" ||
    command === "red" ||
    command === "teal" ||
    command === "yellow"
  ) {
    return handleChatColorCommand(session, command, chatHub, options);
  }

  if (command === "where") {
    return handledResult(chatHub, session, options, getLocationSummary(session));
  }
  if (command === "voidreplay") {
    return require("./commands/voidReplay").handleVoidReplayCommand(session, argumentText, chatHub, options);
  }
  if (command === "orbitals") {
    return handledResult(chatHub, session, options,
      require("./commands/orbitalDiscoveryCommand").buildOrbitalDiscoveryMessage(session, argumentText));
  }

  if (command === "abyssaldebug") {
    return handleAbyssalDebugCommand(session, argumentText, chatHub, options);
  }

  if (command === "abyssallayout") {
    return handleAbyssalLayoutCommand(session, argumentText, chatHub, options);
  }

  if (command === "abyssalstatus") {
    return handleAbyssalStatusCommand(session, argumentText, chatHub, options);
  }

  if (command === "abyssalrescue") {
    return handleAbyssalRescueCommand(session, argumentText, chatHub, options);
  }

  if (command === "dock") {
    return handleHomeDock(session, chatHub, options);
  }

  if (command === "dmg") {
    return handleDamageCommand(session, argumentText, chatHub, options);
  }

  if (command === "heal") {
    if (/^\d+\s+0$/.test(argumentText.trim())) {
      return require("./commands/nativeDestroy").handleNativeDestroyCommand(session, argumentText, chatHub, options);
    }
    if (argumentText) return handleNativeHealCommand(session, argumentText, chatHub, options);
    return handleHealCommand(session, chatHub, options);
  }

  if (command === "ceq") {
    const { normalizeRoleValue, ROLE_GML, ROLE_WORLDMOD } = require("../account/accountRoleProfiles");
    const role = normalizeRoleValue(session?.accountRole ?? session?.role, 0n);
    if ((role & (ROLE_GML | ROLE_WORLDMOD)) === 0n) {
      return handledResult(chatHub, session, options, "Only GM accounts can use /ceq.");
    }
    const level = Number(argumentText);
    if (rest.length !== 1 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(argumentText) ||
        !Number.isFinite(level) || level < 0 || level > 100) {
      return handledResult(chatHub, session, options, "Usage: /ceq <0-100> (for example, /ceq 100).");
    }
    const result = require("../character/characterEnergyMgrService").setCharacterEnergyLevel(session, level);
    const message = result.success ? `Set your CEQ to ${level}.`
      : result.errorMsg === "CHARACTER_NOT_FOUND" ? "Select a character before using /ceq."
        : result.errorMsg === "INVALID_CHARACTER_ENERGY_LEVEL" ? "CEQ must be within your character's energy limits (0-100)."
          : `Unable to set CEQ: ${result.errorMsg || "storage failed"}.`;
    return handledResult(chatHub, session, options, message);
  }

  if (command === "interference") {
    const { normalizeRoleValue, ROLE_GML, ROLE_WORLDMOD } = require("../account/accountRoleProfiles");
    const role = normalizeRoleValue(session?.accountRole ?? session?.role, 0n);
    if ((role & (ROLE_GML | ROLE_WORLDMOD)) === 0n) {
      return handledResult(chatHub, session, options, "Only GM accounts can use /interference.");
    }
    if (rest.length !== 1 || argumentText.toLowerCase() !== "reset") {
      return handledResult(chatHub, session, options, "Usage: /interference reset");
    }
    const result = require("../map/solarsystemInterferenceMgrService").resetLocalInterference(session);
    let message;
    if (result.success) {
      const id = result.data.solarSystemID;
      const name = worldData.getSolarSystemByID(id)?.solarSystemName || `system ${id}`;
      message = `Reset signal interference in ${name} to 0%.`;
    } else {
      message = result.errorMsg === "CHARACTER_NOT_FOUND" ? "Select a character before using /interference."
        : result.errorMsg === "SOLAR_SYSTEM_NOT_FOUND" ? "No current public solar system is available."
          : `Unable to reset signal interference: ${result.errorMsg || "storage failed"}.`;
    }
    return handledResult(chatHub, session, options, message);
  }

  if (command === "repairmodules") {
    return handleRepairModulesCommand(session, argumentText, chatHub, options);
  }

  if (command === "chowner") {
    return require("./commands/changeOwner").handleChangeOwnerCommand(session, argumentText, chatHub, options);
  }

  if (command === "effect") {
    return handleEffectCommand(session, argumentText, chatHub, options);
  }

  if (command === "dogma") {
    return require("./commands/dogma").handleDogmaCommand(session, argumentText, chatHub, options);
  }

  if (command === "fireshow") {
    return require("./commands/fireShow").handleFireShowCommand(session, argumentText, chatHub, options);
  }

  if (command === "gate" || command === "gateshowcase") {
    return require("./commands/transientGates").handleTransientGateCommand(session, command, argumentText, chatHub, options);
  }

  if (command === "upwell") {
    const result = executeUpwellCommand(session, argumentText);
    structureLog.logCommand(session, `/upwell ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  // The client's own GM structure menu (eve/client/script/ui/structure/
  // structuremenu.py:74-94) sends /structure state|timer|unanchor|deploytimer|
  // abandontimer through the slash service.
  if (command === "structure") {
    const result = executeStructureGmCommand(session, argumentText);
    structureLog.logCommand(session, `/structure ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "war") {
    const result = require("../corporation/warGmCommands").executeWarGmCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  // The client's moon scheduling window GM buttons (ui/moonmining/scheduling.py:275-278).
  if (command === "extraction") {
    const result = executeExtractionGmCommand(session, argumentText);
    structureLog.logCommand(session, `/extraction ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "pos") {
    const result = executePosCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "upwellauto") {
    const result = executeUpwellAutoCommand(session, argumentText);
    structureLog.logCommand(session, `/upwellauto ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "bpauto") {
    return executeBlueprintAutoCommand(session, argumentText).then((result) =>
      handledResult(chatHub, session, options, result.message));
  }

  if (command === "bp") {
    const result = executeBlueprintCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "bookmarkauto") {
    const result = executeBookmarkAutoCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "calauto") {
    const result = executeCalendarAutoCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "reprocesssmoke") {
    return executeReprocessingSmokeCommand(session, argumentText).then((result) =>
      handledResult(chatHub, session, options, result.message));
  }

  if (command === "sov") {
    const result = executeSovCommand(session, argumentText);
    sovLog.logCommand(session, `/sov ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "sovauto" || command === "autosov") {
    const result = executeSovAutoCommand(session, argumentText, chatHub, options);
    sovLog.logCommand(session, `/${command} ${argumentText}`.trim(), result);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "jetcan") {
    return handleJetcanCommand(session, argumentText, chatHub, options);
  }

  if (command === "container") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "container");
  }

  if (command === "gmships") {
    return handleGmShipsCommand(session, chatHub, options);
  }

  if (command === "gmweapons") {
    return handleGmWeaponsCommand(session, chatHub, options);
  }

  if (command === "prop") {
    return handlePropCommand(session, chatHub, options);
  }

  if (command === "allskills") {
    return handleAllSkillsCommand(session, chatHub, options);
  }

  if (command === "allskins") {
    return handleAllSkinsCommand(session, argumentText, chatHub, options);
  }

  if (command === "allskinr") {
    return handleAllSkinrCommand(session, argumentText, chatHub, options);
  }

  if (command === "skinr") {
    return handleSkinrCommand(session, argumentText, chatHub, options);
  }

  if (command === "backintime") {
    return handleBackInTimeCommand(session, argumentText, chatHub, options);
  }

  if (command === "expertsystem" || command === "expertsystems") {
    return handleExpertSystemCommand(session, argumentText, chatHub, options);
  }

  if (command === "gmskills") {
    return handleGmSkillsCommand(session, chatHub, options);
  }

  if (command === "giveskill" || command === "giveskills") {
    return handleGiveSkillCommand(session, argumentText, chatHub, options);
  }

  if (command === "removeskill" || command === "removeskills") {
    return handleRemoveSkillCommand(session, argumentText, chatHub, options);
  }

  if (command === "loadsys") {
    return handleLoadSystemCommand(session, chatHub, options);
  }

  if (command === "loadallsys") {
    return handleLoadAllSystemsCommand(session, chatHub, options);
  }

  if (command === "tidi") {
    return handleTimeDilationCommand(session, argumentText, chatHub, options);
  }


  if (command === "spawncontainer") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "container");
  }

  if (command === "spawnwreck") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "wreck");
  }

  if (command === "wreck") {
    return handleDebrisFieldCommand(session, argumentText, chatHub, options, "wreck");
  }

  if (command === "suicide") {
    return handleSuicideCommand(session, chatHub, options);
  }

  if (command === "deathtest") {
    return handleDeathTestCommand(session, argumentText, chatHub, options);
  }

  if (command === "deathstructure") {
    return handleStructureDeathTestCommand(session, argumentText, chatHub, options);
  }

  if (command === "deadwarp") {
    return handleDeadwarpCommand(session, argumentText, chatHub, options);
  }

  if (command === "spawnsite") {
    return handleSpawnSiteCommand(session, argumentText, chatHub, options);
  }

  if (command === "celestial") {
    return handleCelestialCommand(session, argumentText, chatHub, options);
  }

  if (command === "lco") {
    const action = String(argumentText || "").trim().split(/\s+/, 1)[0];
    if (["list", "inspect", "move", "offset", "rotate", "save"].includes(action)) {
      if (!hasStaffDebugRole(session)) {
        return handledResult(chatHub, session, options, "LCO requires a staff/admin role.");
      }
      const transforms = require("../../space/lcoTransforms");
      try {
        return handledResult(chatHub, session, options,
          transforms.execute(spaceRuntime.getSceneForSession(session), argumentText));
      } catch (error) {
        return handledResult(chatHub, session, options, `LCO operation failed: ${error.message}`);
      }
    }
    return handleLargeCollidableObjectCommand(session, argumentText, chatHub, options);
  }

  // Living Universe: /population status|depart|reset|load <n>
  if (command === "population") {
    const result = require("./commands/livingUniverse").executeLivingUniverseCommand(argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npc") {
    return handleNpcCommand(session, argumentText, chatHub, options);
  }

  if (command === "mnpc") {
    return handleMissileNpcCommand(session, argumentText, chatHub, options);
  }

  if (CAPITAL_NPC_CHAT_COMMANDS.includes(command)) {
    return handleCapitalNpcCommand(session, argumentText, chatHub, options, command);
  }

  if (WORMHOLE_CHAT_COMMANDS.includes(command)) {
    const result = executeWormholeCommand(session, command, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (TRIG_DRIFTER_CHAT_COMMANDS.includes(command)) {
    const result = executeTrigDrifterCommand(session, command, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (GATE_SKIN_CHAT_COMMANDS.includes(command)) {
    const result = executeGateSkinCommand(session, argumentText, options);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "dirt") {
    const result = handleShipDirtCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "killmarks" || command === "killmark") {
    const result = handleShipKillmarksCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npctest") {
    return handleNpcTestCommand(session, argumentText, chatHub, options, "player");
  }

  if (command === "npctest2") {
    return handleNpcTestCommand(session, argumentText, chatHub, options, "ffa");
  }

  if (command === "npcminer") {
    const result = executeMiningFleetCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcmineraggro") {
    const result = executeMiningFleetAggroCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerpanic") {
    const result = executeMiningFleetAggroCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerretreat") {
    const result = executeMiningFleetRetreatCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerresume") {
    const result = executeMiningFleetResumeCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerhaul") {
    const result = executeMiningFleetHaulCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerclear") {
    const result = executeMiningFleetClearCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcminerstatus") {
    const result = executeMiningFleetStatusCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "miningreset") {
    const result = executeMiningStateResetCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "miningstatus") {
    const result = executeMiningStateStatusCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "npcw" || command === "wnpc") {
    return handleNpcWarpCommand(session, argumentText, chatHub, options, command);
  }

  if (command === "npcclear") {
    return handleNpcClearCommand(session, argumentText, chatHub, options);
  }

  if (command === "concord") {
    return handleConcordCommand(session, argumentText, chatHub, options);
  }

  if (command === "cwatch") {
    return handleCrimewatchCommand(session, argumentText, chatHub, options);
  }

  if (command === "naughty") {
    return handleNaughtyCommand(session, argumentText, chatHub, options);
  }

  if (command === "secstatus") {
    return handleSecurityStatusCommand(session, argumentText, chatHub, options);
  }

  if (command === "gateconcord") {
    return handleGateOperatorCommand(
      session,
      argumentText,
      chatHub,
      options,
      npcService.GATE_OPERATOR_KIND.CONCORD,
    );
  }

  if (command === "gaterats") {
    return handleGateOperatorCommand(
      session,
      argumentText,
      chatHub,
      options,
      npcService.GATE_OPERATOR_KIND.RATS,
    );
  }

  if (command === "invu") {
    return handleInvuCommand(session, argumentText, chatHub, options);
  }

  if (command === "keepstar") {
    return handleKeepstarCommand(session, chatHub, options);
  }

  if (command === "fire") {
    return handleFireCommand(session, argumentText, chatHub, options);
  }

  if (command === "fire2") {
    return handleFire2Command(session, argumentText, chatHub, options);
  }

  if (command === "supertitan") {
    const result = executeSuperTitanCommand(session, argumentText, options);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "supertitanshow" || command === "titansupershow") {
    const result = executeSuperTitanShowCommand(
      session,
      argumentText,
      options,
    );
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "rr") {
    const result = executeRemoteRepairFleetCommand(
      session,
      argumentText,
      options,
    );
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "testclear") {
    return handleTestClearCommand(session, chatHub, options);
  }

  if (command === "sysjunkclear") {
    return handleSystemJunkClearCommand(session, chatHub, options);
  }

  if (command === "who") {
    return handledResult(
      chatHub,
      session,
      options,
      getConnectedCharacterSummary(),
    );
  }

  if (command === "wallet" || command === "isk") {
    const summary = getWalletSummary(session);
    return handledResult(
      chatHub,
      session,
      options,
      summary || "Select a character before checking wallet balance.",
    );
  }

  if (command === "lp") {
    return handledResult(
      chatHub,
      session,
      options,
      getLoyaltyPointSummary(session, argumentText),
    );
  }

  if (command === "evermarks") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before checking EverMarks.",
      );
    }

    const evermarks = getCharacterWalletLPBalance(
      session.characterID,
      EVERMARK_ISSUER_CORP_ID,
    );
    return handledResult(
      chatHub,
      session,
      options,
      `EverMarks: ${formatEvermarks(evermarks)}.`,
    );
  }

  if (command === "corpevermarks") {
    if (!session || !(session.corporationID || session.corpid)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character in a corporation before checking corporation EverMarks.",
      );
    }

    const corporationID = Number(session.corporationID || session.corpid) || 0;
    const evermarks = getCorporationWalletLPBalance(
      corporationID,
      EVERMARK_ISSUER_CORP_ID,
    );
    return handledResult(
      chatHub,
      session,
      options,
      `Corporation EverMarks: ${formatEvermarks(evermarks)}.`,
    );
  }

  if (
    command === "grantshipemblem" ||
    command === "grantcorplogo" ||
    command === "grantalliancelogo"
  ) {
    return handleGrantShipLogoCommand(
      command,
      session,
      argumentText,
      chatHub,
      options,
    );
  }

  if (command === "corpcreate") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before creating a corporation.",
      );
    }

    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /corpcreate <corporation name>",
      );
    }

    // A corporation's headquarters must be an NPC station. The client's own
    // creation flow takes the station from the session (empty when the founder
    // sits in a player structure); this GM shortcut has no client flow behind
    // it, so it fixes a valid default instead: Jita IV-4, which a director can
    // move later with the normal Move HQ action.
    const GM_CORP_CREATE_STATION_ID = 60003760;
    const result = createCustomCorporation(session.characterID, argumentText, {
      stationID: GM_CORP_CREATE_STATION_ID,
    });
    if (!result.success) {
      const message =
        result.errorMsg === "CORPORATION_NAME_TAKEN"
          ? `Corporation already exists: ${argumentText}.`
          : "Corporation creation failed.";
      return handledResult(chatHub, session, options, message);
    }

    // Announce the new corporation as the client's own create does
    // (corpRegistryRuntime: OnCorporationChanged from None, golden log "Create Corp").
    notifyCorporationChanged(result.data.corporationRecord.corporationID, null);
    refreshAffiliationSessions(result.data.affectedCharacterIDs);
    return handledResult(
      chatHub,
      session,
      options,
      `Created corporation ${result.data.corporationRecord.corporationName} [${result.data.corporationRecord.tickerName}] and moved your character into it.`,
    );
  }

  if (command === "setalliance") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before creating an alliance.",
      );
    }

    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setalliance <alliance name>",
      );
    }

    const corporationRecord = getCorporationRecord(session.corporationID);
    if (!corporationRecord) {
      return handledResult(
        chatHub,
        session,
        options,
        "Current corporation could not be resolved.",
      );
    }

    const affiliationBefore = captureAllianceAffiliationBefore(corporationRecord);
    const result = createCustomAllianceForCorporation(
      session.characterID,
      corporationRecord.corporationID,
      argumentText,
    );
    if (!result.success) {
      let message = "Alliance creation failed.";
      if (result.errorMsg === "CUSTOM_CORPORATION_REQUIRED") {
        message = "You must be in a custom corporation before creating an alliance.";
      } else if (result.errorMsg === "ALLIANCE_NAME_TAKEN") {
        message = `Alliance already exists: ${argumentText}.`;
      }
      return handledResult(chatHub, session, options, message);
    }

    refreshAffiliationSessions(result.data.affectedCharacterIDs);
    notifyAllianceAffiliationChanged(affiliationBefore, result.data.allianceID);
    return handledResult(
      chatHub,
      session,
      options,
      `Created alliance ${result.data.allianceRecord.allianceName} [${result.data.allianceRecord.shortName}] and set your corporation into it.`,
    );
  }

  if (command === "joinalliance") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before joining an alliance.",
      );
    }

    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /joinalliance <alliance name>",
      );
    }

    const corporationRecord = getCorporationRecord(session.corporationID);
    if (!corporationRecord) {
      return handledResult(
        chatHub,
        session,
        options,
        "Current corporation could not be resolved.",
      );
    }

    const affiliationBefore = captureAllianceAffiliationBefore(corporationRecord);
    const result = joinCorporationToAllianceByName(
      corporationRecord.corporationID,
      argumentText,
    );
    if (!result.success) {
      let message = "Alliance join failed.";
      if (result.errorMsg === "CUSTOM_CORPORATION_REQUIRED") {
        message = "You must be in a custom corporation before joining a custom alliance.";
      } else if (result.errorMsg === "ALLIANCE_NOT_FOUND") {
        message = `Alliance not found: ${argumentText}.`;
      } else if (result.errorMsg === "ALREADY_IN_ALLIANCE") {
        message = `Your corporation is already in ${argumentText}.`;
      }
      return handledResult(chatHub, session, options, message);
    }

    refreshAffiliationSessions(result.data.affectedCharacterIDs);
    notifyAllianceAffiliationChanged(affiliationBefore, result.data.allianceID);
    return handledResult(
      chatHub,
      session,
      options,
      `Joined alliance ${result.data.allianceRecord.allianceName} [${result.data.allianceRecord.shortName}].`,
    );
  }

  if (command === "solar") {
    return handleSolarTeleport(session, argumentText, chatHub, options);
  }

  if (command === "tele") {
    return handleTeleCommand(session, argumentText, chatHub, options);
  }

  if (command === "setstanding") {
    return handleSetStandingCommand(session, argumentText, chatHub, options);
  }

  if (command === "maxagentstandings" || command === "fullstandings") {
    return handleMaxAgentStandingsCommand(
      session,
      argumentText,
      chatHub,
      options,
    );
  }

  if (command === "sigscan") {
    return handleSigscanCommand(session, chatHub, options);
  }

  if (command === "sigs") {
    return handleSigsCommand(session, chatHub, options);
  }

  if (command === "missioncomplete") {
    return handleMissionCompleteCommand(
      session,
      argumentText,
      chatHub,
      options,
    );
  }

  if (command === "overlayrefresh") {
    return handleOverlayRefreshCommand(session, chatHub, options);
  }

  if (command === "events") {
    if (!hasStaffDebugRole(session)) return handledResult(chatHub, session, options, "Event inspection requires a staff/admin role.");
    const lifecycle = require("../seasons/eventLifecycle");
    const [id, character] = argumentText.trim().split(/\s+/);
    if (id === "readiness") return handledResult(chatHub, session, options, JSON.stringify(require("../seasons/eventReadiness").inspect()));
    if (character !== undefined) {
      if (id !== "gallente-election-yc128" || !/^\d+$/.test(character) || !Number.isSafeInteger(Number(character)) || Number(character) <= 0) return handledResult(chatHub, session, options, "Usage: /events gallente-election-yc128 [characterID]");
      return handledResult(chatHub, session, options, JSON.stringify(lifecycle.inspectCharacter(Number(character))));
    }
    const rows = lifecycle.inspect().filter(row => !id || row.id === id);
    return handledResult(chatHub, session, options, rows.length ? rows.map(row => {
      const result = row.candidateTotals;
      return `${row.id}: ${row.phase}; starts ${row.startsAt}; ends ${row.endsAt}; trader end ${new Date(row.conclusion?.traderEndsAtMs || row.traderEndsAtMs).toISOString()}` +
        (result ? `; totals ${JSON.stringify(result.totals)}; ${result.outcome}; leaders ${result.leaders.join(", ") || "none"}; ${row.conclusion ? "FINAL" : "provisional"}` : "");
    }).join("<br>") : "Unknown event ID. Use /events to list implemented schedules.");
  }

  if (command === "tr") {
    return handleTransportCommand(session, argumentText, chatHub, options);
  }

  if (command === "addisk") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing wallet balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addisk <amount>",
      );
    }

    return adjustCharacterBalanceAsync(session.characterID, amount, {
      description: `Admin /addisk by ${session.characterName || session.userName || "unknown"}`,
      ownerID1: session.characterID,
      ownerID2: session.characterID,
      referenceID: session.characterID,
    }, { source: "chat.admin.addisk" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          result.errorMsg === "INSUFFICIENT_FUNDS"
            ? "Wallet change failed: insufficient funds."
            : "Wallet change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        result.capped
          ? `Adjusted wallet by ${formatIsk(result.delta)}. New balance: ${formatIsk(result.data.balance)}, the most a wallet can hold.`
          : `Adjusted wallet by ${formatIsk(amount)}. New balance: ${formatIsk(result.data.balance)}.`,
      );
    });
  }

  if (command === "addlp") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing LP.",
      );
    }

    const parsed = parseLoyaltyPointMutationArgs(argumentText);
    if (parsed.amount === null || !parsed.issuerText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addlp <amount> <npc corp name|corpID>",
      );
    }

    const issuerResult = resolveLoyaltyPointIssuerCorporation(parsed.issuerText);
    if (!issuerResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        formatLoyaltyPointIssuerError(issuerResult, parsed.issuerText),
      );
    }

    const result = adjustCharacterWalletLPBalance(
      session.characterID,
      issuerResult.data.corporationID,
      parsed.amount,
      { changeType: "admin_adjust" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "LP change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Adjusted ${formatCorporationLabel(issuerResult.data)} LP by ${formatSignedLoyaltyPoints(parsed.amount)}. New balance: ${formatLoyaltyPoints(result.data.amount)}.`,
    );
  }

  if (command === "addevermarks") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addevermarks <amount>",
      );
    }

    const result = adjustCharacterWalletLPBalance(
      session.characterID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { changeType: "admin_adjust" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Adjusted EverMarks by ${formatSignedEvermarks(amount)}. New balance: ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "addcorpevermarks") {
    if (!session || !(session.corporationID || session.corpid)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character in a corporation before changing corporation EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addcorpevermarks <amount>",
      );
    }

    const corporationID = Number(session.corporationID || session.corpid) || 0;
    const result = adjustCorporationWalletLPBalance(
      corporationID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { reason: "admin_adjust" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "Corporation EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Adjusted corporation EverMarks by ${formatSignedEvermarks(amount)}. New balance: ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "addplex") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing PLEX balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /addplex <amount>",
      );
    }

    return adjustCharacterPlexBalanceAsync(session.characterID, amount, {
      categoryMessageID: PLEX_LOG_CATEGORY.CCP,
      reason: `Admin /addplex by ${session.characterName || session.userName || "unknown"}`,
    }, { source: "chat.admin.addplex" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          "PLEX balance change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        `Adjusted PLEX by ${formatSignedPlex(amount)}. New balance: ${formatPlex(result.data.plexBalance)}.`,
      );
    });
  }

  if (command === "setisk") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing wallet balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setisk <amount>",
      );
    }

    return setCharacterBalanceAsync(session.characterID, amount, {
      description: `Admin /setisk by ${session.characterName || session.userName || "unknown"}`,
      ownerID1: session.characterID,
      ownerID2: session.characterID,
      referenceID: session.characterID,
    }, { source: "chat.admin.setisk" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          result.errorMsg === "INSUFFICIENT_FUNDS"
            ? "Wallet change failed: balance cannot be negative."
            : "Wallet change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        result.capped
          ? `Wallet balance set to ${formatIsk(result.data.balance)}, the most a wallet can hold.`
          : `Wallet balance set to ${formatIsk(result.data.balance)}.`,
      );
    });
  }

  if (command === "setlp") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing LP.",
      );
    }

    const parsed = parseLoyaltyPointMutationArgs(argumentText);
    if (parsed.amount === null || !parsed.issuerText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setlp <amount> <npc corp name|corpID>",
      );
    }

    const issuerResult = resolveLoyaltyPointIssuerCorporation(parsed.issuerText);
    if (!issuerResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        formatLoyaltyPointIssuerError(issuerResult, parsed.issuerText),
      );
    }

    const result = setCharacterWalletLPBalance(
      session.characterID,
      issuerResult.data.corporationID,
      parsed.amount,
      { changeType: "admin_set" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "LP change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `${formatCorporationLabel(issuerResult.data)} LP set to ${formatLoyaltyPoints(result.data.amount)}.`,
    );
  }

  if (command === "setevermarks") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setevermarks <amount>",
      );
    }

    const result = setCharacterWalletLPBalance(
      session.characterID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { changeType: "admin_set" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `EverMarks set to ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "setcorpevermarks") {
    if (!session || !(session.corporationID || session.corpid)) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character in a corporation before changing corporation EverMarks.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setcorpevermarks <amount>",
      );
    }

    const corporationID = Number(session.corporationID || session.corpid) || 0;
    const result = setCorporationWalletLPBalance(
      corporationID,
      EVERMARK_ISSUER_CORP_ID,
      amount,
      { reason: "admin_set" },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "Corporation EverMarks change failed.",
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      `Corporation EverMarks set to ${formatEvermarks(result.data.amount)}.`,
    );
  }

  if (command === "setplex") {
    if (!session || !session.characterID) {
      return handledResult(
        chatHub,
        session,
        options,
        "Select a character before changing PLEX balance.",
      );
    }

    const amount = parseAmount(argumentText);
    if (amount === null) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /setplex <amount>",
      );
    }

    return setCharacterPlexBalanceAsync(session.characterID, amount, {
      categoryMessageID: PLEX_LOG_CATEGORY.CCP,
      reason: `Admin /setplex by ${session.characterName || session.userName || "unknown"}`,
    }, { source: "chat.admin.setplex" }).then((result) => {
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          "PLEX balance change failed.",
        );
      }

      return handledResult(
        chatHub,
        session,
        options,
        `PLEX balance set to ${formatPlex(result.data.plexBalance)}.`,
      );
    });
  }

  if (command === "ship" || command === "giveme") {
    return handleShipSpawn(command, session, argumentText, chatHub, options);
  }

  const rackCommandPreset = resolveSingleRackCommandPreset(command);
  if (rackCommandPreset) {
    return handlePresetSingleRackCommand(
      session,
      chatHub,
      options,
      rackCommandPreset,
      command,
    );
  }

  if (command === "lesmis") {
    return handleLesmisCommand(session, chatHub, options);
  }

  if (command === "miner") {
    const result = executeMinerCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "orca") {
    const result = executeOrcaCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "probe") {
    const result = executeProbeCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "probe2") {
    const result = executeProbe2Command(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "trig") {
    const result = executeTrigCommand(session, argumentText);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "cburst") {
    const result = executeCburstCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "guardian") {
    const result = executeGuardianCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "basilisk") {
    const result = executeBasiliskCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "ewar") {
    const result = executeEwarCommand(session);
    return handledResult(chatHub, session, options, result.message);
  }

  if (command === "container1") {
    return handleContainer1Command(session, chatHub, options);
  }

  if (command === "minerals") {
    return handleMineralsCommand(session, chatHub, options);
  }

  if (command === "create" || command === "createitem") {
    return handleCreateItemCommand(session, argumentText, chatHub, options, command);
  }

  if (command === "load") {
    return handleLoadCommand(session, argumentText, chatHub, options);
  }

  if (command === "giveitem" || command === "item") {
    return handleGiveItemCommand(session, argumentText, chatHub, options);
  }

  if (command === "fit") {
    return handleFitCommand(session, argumentText, chatHub, options);
  }

  if (command === "unfit") {
    return handleUnfitCommand(session, argumentText, chatHub, options);
  }

  // menusvc.py and the GM "Unload All" macro use this spelling for unfitting.
  if (command === "unload") {
    if (!hasStaffDebugRole(session)) {
      return handledResult(chatHub, session, options, "/unload requires a staff/admin role.");
    }
    return handleUnfitCommand(session, argumentText, chatHub, options);
  }

  if (command === "online") {
    return require("./commands/onlineModules").handleOnlineCommand(session, argumentText, chatHub, options);
  }

  if (command === "getshipsetup") {
    return require("./commands/shipSetup").handleGetShipSetupCommand(session, argumentText, chatHub, options);
  }

  if (command === "reportdesync") {
    return require("./commands/reportDesync").handleReportDesyncCommand(session, argumentText, chatHub, options);
  }

  if (command === "fetch") {
    return handleFetchCommand(session, argumentText, chatHub, options);
  }

  if (["spawn", "spawnn", "entity"].includes(command)) {
    return require("./commands/nativeSpawns").handleNativeSpawnCommand(session, command, argumentText, chatHub, options);
  }

  if (command === "unspawn") {
    return require("./commands/unspawn").handleUnspawnCommand(session, argumentText, chatHub, options);
  }

  if (command === "hangar") {
    return handledResult(chatHub, session, options, getHangarSummary(session));
  }

  if (command === "session") {
    return handledResult(chatHub, session, options, getSessionSummary(session));
  }

  if (command === "iteminfo") {
    return handledResult(chatHub, session, options, getItemSummary(argumentText));
  }

  if (command === "typeinfo") {
    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /typeinfo <ship name|typeID>",
      );
    }

    const lookup = resolveShipByName(argumentText);
    if (!lookup.success) {
      const message =
        lookup.errorMsg === "SHIP_NOT_FOUND"
          ? `Ship type not found: ${argumentText}.${formatSuggestions(lookup.suggestions)}`
          : `Ship type name is ambiguous: ${argumentText}.${formatSuggestions(lookup.suggestions)}`;
      return handledResult(chatHub, session, options, message.trim());
    }

    return handledResult(
      chatHub,
      session,
      options,
      `${lookup.match.name}: typeID=${lookup.match.typeID}, groupID=${lookup.match.groupID}, categoryID=${lookup.match.categoryID}, published=${lookup.match.published === false ? "false" : "true"}.`,
    );
  }

  if (command === "announce") {
    if (!argumentText) {
      return handledResult(
        chatHub,
        session,
        options,
        "Usage: /announce <message>",
      );
    }

    sendAnnouncement(chatHub, session, argumentText);
    return handledResult(
      chatHub,
      session,
      options,
      `Announcement sent: ${argumentText}`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Unknown command: /${command}. Use /help.${formatSuggestions(suggestCommands(command))}`.trim(),
  );
}

module.exports = {
  AVAILABLE_SLASH_COMMANDS,
  COMMANDS_HELP_TEXT,
  DEER_HUNTER_MESSAGE,
  DEFAULT_MOTD_MESSAGE,
  executeChatCommand,
  getContainer1SeedPlan,
  getGmWeaponsSeedPlan,
  getPropulsionCommandItemTypes,
  _testing: {
    buildCelestialEntity,
    buildLargeCollidableObjectEntity,
    handleCelestialCommand,
    handleLargeCollidableObjectCommand,
    handleSuicideCommand,
    isSessionShipCapsuleBeforeDestruction,
    resolveAbyssalSuicideAuthority,
  },
};
