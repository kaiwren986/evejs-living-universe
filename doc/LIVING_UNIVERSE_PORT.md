# Living Universe port

Porting the Living Universe mod (0.3.0, written against EveJS 0.12.6 "xEve") onto
EveJS 261108.1. The RPG layer requires it: its pilots are the cast.

The mod's source tree is the reference. Keep a copy outside the repo and point
`LU_SRC` at its `server` folder when comparing (the notes below call it "old").

## Method

1. Copy the mod's own files across unchanged, at the same paths, so their
   requires keep working and the code stays comparable with the mod.
2. Re-home each edit the mod made to a stock file by hand. Stock files were
   reorganised heavily after 0.12.6 (the space runtime went from one 56,000-line
   file to a folder of modules), so nothing merges. Keep each edit small and
   marked with a `// Living Universe:` comment.
3. The mod's verify scripts (`server/scripts/verifyLiving*.js`) are the bar.
   Run them against a copy of the game store, never the live one:

       cp -r _local/gameStore/{data,gamestore.sqlite*,manifest.json} _local/test-store/
       sqlite: UPDATE _persistence_owners SET active=0   (clears the copied lease, and
                                                         again before every run)
       EVEJS_LOCAL_DATABASE_ROOT=<repo>/_local/test-store
       EVEJS_GAMESTORE_DATA_DIR=<repo>/_local/test-store/data
       EVEJS_GAMESTORE_OWNER_ROLE=maintenance
       cd server && node scripts/verifyLivingUniversePilots.js

## Done

Copied unchanged: `space/npc/ambientTraffic/*` (the mod), `space/npc/governance/*`,
`space/npc/npcPhysicalBudget.js`, `space/liveEvents/deadlineQueue.js`,
`services/xEve/xEveEventBridge.js` (inert while `xEveEnabled` is false),
`services/character/factionHostilityRuntime.js`, `config/schema/xeve.js`,
`scripts/*Living*.js`.

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
| `services/character/characterState.js`, `services/config/configService.js` | Pilot records and names, through `livingUniverse/hooks.js`. |

Local chat: the client only shows pilots when Local runs on the chat gateway
(feature flag `eve-local-chat-authority`). The server sends the flag and the
client mod `local_chat_gateway` makes sure of it. The mod's XMPP presence code
was not ported and is not needed.

Verify scripts passing (11 of 16 in the pilot / roaming / conflict set):
IncrementalPersistence, PilotSyncBudget, ReplacementSchedulerPriority,
StressAcceleration, TransitTiming, RoamingIntegration, RoamingKernel,
ReplacementCoverage, ConflictEconomy, ConflictIncidents, and the pilot identity
part of Pilots.

## Still to do, in order

The runtime does not yet start: `initialize()` stops at the first missing engine
function. Everything below is an edit the mod made to a stock file.

1. **Mining state** (`services/mining/miningRuntimeState.js`):
   `ensurePersistedAsteroidBaselines`, `ensurePersistedGeneratedResourceBaselines`,
   `applyPersistedMiningBatch`, `syncPersistedMiningBatchToScene`. This is what
   lets pilots mine while nobody watches. First blocker.
2. **Mining fleets** (`services/mining/miningNpcOperations.js`):
   `registerAmbientMiningFleet`, `cleanupMiningFleetSupport`,
   `finalizeOnGridMiningSupport`, `estimateNpcMiningVolume`, `getNpcOreCargoItems`.
   The old file is 9,091 lines against 3,298 now; find the mod's part of it.
3. **Spawning** (`space/npc/nativeNpcService.js`): `corporationIDOverride`,
   `allianceIDOverride`, `warFactionIDOverride`, `cargoOverride`, their indexed
   forms for batch spawns, and the doctrine governance fields on the entity
   record (`loadoutGoverned`, `doctrineID`, `npcRole`, `equipmentBand`,
   `pilotSkills`, `governedDroneBay`, ...). Old lines 92-104, 1234, 1425, 1505,
   1968-2095, 2239-2291. verifyLivingUniversePopulation fails here.
4. **Space runtime**: `warpToPoint`, `warpToEntity`, `getSceneForSession` (moved
   or renamed, find the new homes), and `_testing.resolveGenericModuleActivationEffectForTesting`.
5. **Drones** (`services/drone/droneRuntime.js`): `spawnTransientNpcDroneWing`.
6. **Hostility and kills**: `npcService.promoteLivingFlightRetaliation` and the
   aggression hook around it (old npcService 2033-2190),
   `npcBehaviorLoop.isLivingPlayerTargetWithoutHostility` (old 1512-1530, used at
   1820), the kill credit in `killmailTracker` (old 931-950).
7. **Identity leftovers**: `charMgrService` (old 75-95), `imageRequestResolver`
   (serve a pilot's portrait from its source agent's file, which removes the
   need for one file per pilot), `corpReadOnlyEmployeeProjection` (pilots in
   corporation member lists).
8. Script expectations that changed upstream, not in the mod: the bounty reply
   shape in verifyLivingUniversePilots (list now, dict then); the `factions`
   table in verifyLivingFactionHostility; the portrait manifest in
   verifyLivingUniversePortraits.
9. Turn it on: `config/xeve.json` with `livingUniverseEnabled` and the values
   from the mod's `evejs.config.x-eve.json`, economy and conflict still off.
   Restart, look at ships in space.

Then stage 2 (economy: `livingEconomy*`, market hooks in `marketProxyService`,
event journal table) and stage 3 (conflict, hirelings, estate), each against
its own verify scripts. Storage clean-up last.

## Finding what else is missing

Two throwaway checks found most of the list above and are worth rebuilding:
for every stock module a mod file requires, compare the members the mod uses
with what the module exports now, once for direct requires and once for the
`getX()` lazy getters. Then run the runtime headless (`tick(spaceRuntime, now)`
in a loop with `EVEJS_LIVING_UNIVERSE_ENABLED=true`) and fix what throws.
