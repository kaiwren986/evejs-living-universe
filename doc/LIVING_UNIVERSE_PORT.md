# Living Universe port

Porting the Living Universe mod (0.3.0, written against EveJS 0.12.6 "xEve") onto
EveJS 261108.1. The RPG layer requires it: its pilots are the cast.

The mod's source tree is the reference. Keep a copy outside the repo and point
`LU_SRC` at its `server` folder when comparing (the notes below call it "old").

## Where it stands

Stage 1 (pilots and their ships in space) runs. The pilot runtime starts, keeps
5,000 pilots moving with nobody logged in, puts them in Local, and spawns their
hulls in a system somebody is watching. It is switched on in `config/xeve.json`
with economy, conflict, xEve, estate, hirelings and live events off.

It has not been run inside a server process or seen in the game client yet.

## Method

1. Copy the mod's own files across unchanged, at the same paths, so their
   requires keep working and the code stays comparable with the mod.
2. Re-home each edit the mod made to a stock file by hand. Stock files were
   reorganised heavily after 0.12.6 (the space runtime went from one 56,000-line
   file to a folder of modules), so nothing merges. Keep each edit small and
   marked with a `// Living Universe:` comment. The old tree marks most of its
   own stock edits with a "Living Universe" comment too, so
   `grep -rn "Living Universe\|livingUniverse" src` in old, minus the mod's own
   folders, lists what there is to port.
3. The mod's verify scripts (`server/scripts/verifyLiving*.js`) are the bar.
   Run them against a copy of the game store, never the live one:

       cp -r _local/gameStore/{data,gamestore.sqlite*,manifest.json} _local/test-store/
       sqlite: UPDATE _persistence_owners SET active=0   (clears the copied lease, and
                                                         again before every run)
       EVEJS_LOCAL_DATABASE_ROOT=<repo>/_local/test-store
       EVEJS_GAMESTORE_DATA_DIR=<repo>/_local/test-store/data
       EVEJS_GAMESTORE_OWNER_ROLE=maintenance
       cd server && node scripts/verifyLivingUniversePilots.js

   The conflict and roaming scripts check the feature itself, which
   `config/xeve.json` keeps off. Switch it on for those runs:

       EVEJS_LIVING_CONFLICT_ENABLED=true
       EVEJS_LIVING_CONFLICT_CAMPAIGNS_ENABLED=true
       EVEJS_LIVING_CONFLICT_ROAMING_ENABLED=true

4. `node scripts/runLivingUniverseHeadless.js` is the acceptance run for stage
   1: ten simulated minutes of `livingUniverseRuntime.tick` with 5,000 pilots,
   then three more with an observer in Jita. Last result: 5,000 actors in seven
   roles, 2,789 flights, 171 pilots in Jita Local, 64 hulls spawned in Jita
   (the per-system cap), none left once the observer is gone.

## Done

Copied unchanged: `space/npc/ambientTraffic/*` (the mod), `space/npc/governance/*`,
`space/npc/npcPhysicalBudget.js`, `space/liveEvents/deadlineQueue.js`,
`services/xEve/xEveEventBridge.js` (inert while `xEveEnabled` is false),
`services/character/factionHostilityRuntime.js`,
`services/mining/virtualMiningTransactions.js`, `config/schema/xeve.js`,
`scripts/*Living*.js`.

One edit to a mod file: `areEntitiesLanded` in `livingUniverseRuntime.js` also
treats a hull with a queued warp order as not landed (see "Warp" below).

New files written for the port: `livingUniverse/hooks.js` and
`livingUniverse/syntheticChat.js` (identity and Local),
`space/npc/governance/nativeNpcGovernedSpawn.js` (the mod's spawn-time logic,
so `nativeNpcService.js` only calls in), `services/chat/commands/livingUniverse.js`
(`/population`), `scripts/runLivingUniverseHeadless.js`.

Stock files edited:

| File | Edit |
| --- | --- |
| `config/schema/index.js`, `config/manager.js` | The mod's settings as their own file, `config/xeve.json`. |
| `space/worldData.js` | `getStations()`. |
| `services/market/marketTopology.js` | `getShortestPath()`. |
| `space/npc/npcData.js` | The mod's ship definitions, loadouts and spawn groups. |
| `space/runtime/spaceRuntime/tick.js` | One `livingUniverseRuntime.tick` per runtime tick. |
| `gameStore/index.js` | `suspendTableFlush` / `resumeTableFlush`, built on the flush hold. |
| `gameStore/sqliteStore.js` | Pilots, flights and encounters stored one row each. |
| `_secondary/chat/chatRuntime.js` | Pilots as chat members, through `livingUniverse/syntheticChat.js`. |
| `_secondary/express/server.js` | Sends the flag that puts Local on the chat gateway. |
| `services/character/characterState.js`, `services/config/configService.js` | Pilot records and names, through `livingUniverse/hooks.js`. This also covers `charMgrService` (it reads through `getCharacterRecord`). |
| `space/asteroids/asteroidService.js` | `buildSystemAsteroidEntities`: a belt's rocks without a scene. |
| `services/mining/miningRuntimeState.js` | Off-grid mining: baseline rows for belts and generated sites, mining batches against them, sync back to a scene. |
| `services/mining/miningNpcOperations.js` | `registerAmbientMiningFleet`, `estimateNpcMiningVolume`, `getNpcOreCargoItems`, and reduced `finalizeOnGridMiningSupport` / `cleanupMiningFleetSupport` (see "Not ported"). |
| `space/npc/nativeNpcService.js` | Corporation, alliance and faction overrides; cargo override; per-hull batch options; doctrine governance fields on the record; pilot skills and drone bay on the live hull; charges that name their module. |
| `services/drone/droneRuntime.js`, `services/drone/droneDogma.js` | `spawnTransientNpcDroneWing`; a native NPC hull as a drone controller (ship item, fitted items and skills from the entity); NPC wings exempt from the player companion check and the drone control range gate. |
| `space/runtime/scene/pilotCommands.js`, `space/runtime/spaceRuntime/pilotCommands.js` | `gotoDynamicEntityPoint` (the powered undock run). |
| `space/runtime/moduleActivationEffectRecord.js`, `space/runtime.js` | `resolveGenericModuleActivationEffect`, exposed for the mod's script. |
| `space/npc/npcService.js` | A player shooting a pilot becomes hostile to its faction; the attacked flight wakes and shoots back (`promoteLivingFlightRetaliation`). |
| `space/npc/npcBehaviorLoop.js` | Pilots only target players who are hostile to their faction. |
| `space/combat/killmailTracker.js` | Kill credit for a pilot's death; standing changes go to the session-resolved player only. |
| `services/character/factionKillStandingRuntime.js` | `recordNpcFactionStandingGains`. |
| `space/destiny/index.js` | A pilot's hull carries the pilot as `charID`. |
| `_secondary/image/imageRequestResolver.js` | A pilot's portrait comes from its source agent's file when that file exists. |
| `services/chat/chatCommands.js` | `/population status|depart|reset|load <n>`. |

Local chat: the client only shows pilots when Local runs on the chat gateway
(feature flag `eve-local-chat-authority`). The server sends the flag and the
client mod `local_chat_gateway` makes sure of it. The mod's XMPP presence code
was not ported and is not needed.

Verify scripts: 15 of 16 in the pilot / roaming / hostility / conflict set pass.
`verifyLivingUniversePortraits` does not: it needs each pilot's source-agent
portrait file (`<agentID>_256.jpg`) in the store's `images/Character`, and the
store has none. `node scripts/syncLivingUniversePortraits.js` fetches them from
`images.evetech.net` (one request per pilot); it has not been run.

Script expectations changed for the new engine, each marked in the script:

- `verifyLivingUniversePilots`: `GetBounties` answers a list of pairs, not a dict.
- `verifyLivingFactionHostility`: reads the standings payload from the store copy.
- `verifyLivingUniversePhysicalBehavior`: NPC ship effects are keyed to the ship
  with the fitted module's own type (0.12.6 xEve sent the hull type plus
  `graphicInfo`); an arriving hull is "in warp" by mode or queued order, not by
  `sessionlessWarpIngress`; synthetic module IDs only have to be distinct; the
  support hull is read from `supportEntityIDs`; the jetcan slice is skipped and
  reported as `miningSupportJetcan: false`.

## Differences from the mod that are worth knowing

- **Warp.** 0.12.6 xEve marked an NPC warp-in with `entity.sessionlessWarpIngress`
  and took the ingress time as an option. 261108.1 queues the order for the next
  Destiny tick and flies a real warp, so the mod's `ingressDurationMs` is
  ignored and a gate arrival takes as long as the warp takes. The mod's
  timeouts (120 s) cover it.
- **Mining support.** A mining flight's command ship is spawned and sits on
  grid, but does not make jetcans or tractor them. Ore stays in the miners'
  holds and is read from there, so a flight's haul is capped by hold size.
- **Mining fleets never expire.** Stock fleets leave after two hours; a fleet
  registered for the mod gets a far-future expiry because the mod owns its
  lifetime.
- **Standing gains.** `factionStandingGainOnKillEnabled` and
  `livingHostilityEnabled` default to on in the mod's schema. With them, killing
  a pirate NPC gives a small standing gain with that faction's enemies, and
  standing loss for NPC kills is only booked for a real player session.
- **First tick.** Building the population and seeding mining baselines takes
  about two seconds the first time the runtime ticks.

## Not ported

- On-grid mining support (jetcans, tractor, command-ship hauling,
  `processOnGridMiningSupport`): about a thousand lines inside the 0.12.6 xEve
  mining fleet tick.
- `corpReadOnlyEmployeeProjection` and the `corpRegistryRuntime` guard: these
  are for hirelings in player corporations, stage 3.
- `runtimePerformanceTelemetry` summary, the wormhole and estate edits, the
  hireling scene hooks in the runtime, `marketDaemonClient` retry: later stages.
- The economy and conflict subcommands of `/population` and `/economy`.

## Still to do

1. Switch the branch into the game, restart, and look (list below).
2. Portraits: run `scripts/syncLivingUniversePortraits.js`, then
   `verifyLivingUniversePortraits`.
3. Stage 2, economy: `livingEconomy*`, market hooks in `marketProxyService`,
   the event journal table, `salvagerRuntime.buildSalvageRewardEntries`,
   `services/estate/familyEstateProjectsRuntime` (required by
   `livingEconomyRuntime`, missing).
4. Stage 3, conflict, hirelings, estate, each against its own verify scripts.
   `services/xEve/xEveRuntime` is missing for the xEve bridge.
5. On-grid mining support, if the jetcan behaviour is wanted.
6. Storage clean-up last.

## To check in game

- Local in a busy system (Jita) lists pilots, with names and portraits.
- Ships undock from stations, align, warp to gates and jump; ships arrive at
  gates from warp; a ship's pilot and corporation show in its info window.
- A belt with a mining flight: miners orbit and run lasers, a command ship sits
  with them.
- Portraits match the pilot. The store holds one portrait file per pilot ID,
  downloaded during slice 1 with a different population planner; until the
  source-agent files are fetched, those older files are what the client gets,
  and a face may not fit its pilot.
- Shoot a pilot: its flight turns on you, bystanders do not.
- `/population status` in chat; the server log at start-up for the first tick.
- Tick time with a full system (64 hulls is the per-system cap, 180 overall).

## Found on the way

- 261108.1 builds synthetic NPC hull module IDs as `entityID * 10000 + slot`.
  Native entity IDs start at 980000000000, so those IDs pass 2^53 and are no
  longer exact integers. Stock behaviour, not caused by the port.
- Bash heredocs in this environment drop backslashes; write patch scripts with a
  file tool. Console output through a pipe is cut off by `process.exit` on
  Windows; let it drain first.

## Finding what else is missing

Two throwaway checks found most of the list above and are worth rebuilding:
for every stock module a mod file requires, compare the members the mod uses
with what the module exports now, once for direct requires and once for the
`getX()` lazy getters. Then run the runtime headless and fix what throws.
Today that check reports only `salvagerRuntime.buildSalvageRewardEntries`,
`familyEstateProjectsRuntime` and `xEveRuntime`, all stage 2 or 3.
