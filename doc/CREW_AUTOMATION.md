# Crew automation and the Living Universe

The chain now includes [crew refining and production supply](CREW_REFINING.md).

The current crew slice supports persistent mining teams, standing supply orders
and a shared read-only actor directory. Miners and couriers are independent
teams and can work concurrently. Their activities are virtual; their finite
rocks and cargo use native mining and inventory owners. The old 5,000-pilot
Living Universe patch, physical crew ships and synthetic Local presence have
not been installed.

## Standing supply orders

In X-Command, choose a destination and **Material to supply**, enter the quantity
to keep at the source, and select **Automate supply route**. A mining team's ore
uses its home station as the supply source; other materials use the courier's
current station. The source is shown before submission. A route can be started
before miners unload their first batch. The policy selects a type rather than
one item ID. It then:

1. Takes an eligible load of that type, preserving the source reserve.
2. Follows its timed route and deposits the original cargo through native inventory.
3. Returns empty to the source.
4. Waits when eligible stock is unavailable, checking again every five seconds.
5. Picks up new stock and repeats without further player orders.

The 1,000 m³ capacity applies. Large stacks and source reserves now use partial
loads: a durable native move splits exactly the accepted quantity into crew
custody. The original source and resulting custody item IDs survive a lost
reservation reply and process restart. Manual cargo selection retains its
whole-stack capacity check.

**Pause work** also pauses a standing order while waiting for stock. When a trip
is in progress it preserves the remaining leg time. **Stop automation** disables
future departures while allowing an accepted delivery to finish; stopping a
paused trip resumes that trip to safely finish its custody obligation.

The policy, monotonically increasing job serial, current job and counters share
the durable crew aggregate. An automatic job ID derives from the standing-order
identity and serial. Restart or command replay cannot replace an accepted job
with another pickup. A pass starts at most one new trip and does not simulate
months of repeated production instantly after downtime.

Automatic trips do not consume the player's command receipt slots. After a
completed delivery is durable, its inventory receipts are retired by the native
inventory owner. A persistent acknowledgement intent prevents a new departure
until retirement is confirmed, including after a failure/restart. The worker
does not discard that intent to make progress. One player-command slot is
reserved for stopping an active standing order at journal capacity.

## Shared people and outcomes

`services/livingUniverse/actorDirectory.js` aggregates bounded provider views.
The crew provider projects the same persisted people used by X-Command, with
stable actor IDs, employer, crew, system, station, activity and destination.
There is no second mutable copy of a crew or cargo balance. Existing crew rows
gain stored actor IDs on their next durable save without resetting progress.

`GET /_evejs-web/v1/crew/universe` returns the authenticated character's actors
and recent arrival/delivery observations through the same edge/owner bridge.
The UI's Living Universe section uses it to show hauling, returning, waiting,
paused and pending-confirmation states. The directory can host further providers
for miners, independent traders or other actors.

Recent observations have stable event IDs and a bounded history. They are a
read-only activity feed, **not** a reliable delivery queue or an economic
outbox. Future economy mutations need their own acknowledged owner protocol;
they must not issue payment or duplicate stock from an event appearing here.

## Mining crews feeding the route

Establish the founding courier crew, select the mining **Home station**, and
choose **Survey local belts**. Pick a belt and available ore, then **Start mining
crew**. The home must be an NPC station in that belt's system. Two persistent
people, Sera Holt and Oren Vale, make timed trips to the belt, extract one load,
return home, and unload to that pilot's native station hangar. The courier's
standing order detects and hauls these stacks automatically.

**Find a mining home** searches other NPC stations without moving the courier.
Jita has no mining belts in the installed world; nearby New Caldari has two.

Inspection found an important integration gap in the existing NPC fleet:
`miningNpcOperations.completeHaulCycle` clears miners' native cargo and records
hauled volume, but does not deliver that ore into a player's station inventory.
Calling that function and then inventing a timed stock grant would lose the
connection between depleted rocks and delivered goods.

The new owned mining team uses its own custody path rather than redirecting
ambient NPC fleet cargo. Each batch follows these durable boundaries:

1. Save the mining assignment, job serial and extraction allocation in
   `miningCrewRuntime`, owned by `service:crew-mining`.
2. The existing `miningCargoCommits` journal accepts an extraction against an
   actual rock's current `miningRuntimeState`. A competing native mining cycle
   invalidates an unaccepted allocation; the crew then selects again.
3. Debit that finite rock once and grant the matching ore once into a separate
   mining escrow location. Pending settlements block later use of that rock.
4. After a timed return, move that original stack once into the pilot's home
   hangar using a native inventory receipt and the normal online notification
   path. The courier can collect it immediately.
5. Persist delivery totals/history before retiring inventory receipts. A bounded
   per-team extraction watermark survives receipt cleanup, so old extraction
   replays cannot create another stack. Late unload replays cannot recall ore
   that the courier or player already moved onward.

Both teams project stable identities and delivery observations into the shared
actor directory. There is no second ore balance in the UI or Living Universe
feed. The mining registry is bounded to 128 teams, histories to 20 deliveries,
and each worker pass to 8 teams and one completed batch per team. Downtime does
not cause instant catch-up production. The first implementation supports ore
in ordinary persistent belts; ice, gas, refining and physical mining ships are
future work. Depletion disables the assignment and returns the miners empty;
they never refill rocks on a timer.

**Pause miners** freezes timed work/travel. An already accepted extraction or
unload may settle to resolve custody; paused travel still waits for resume.
**Return and stop** cancels work that has not been accepted and brings any
accepted ore home before stopping. Command replay, revision checks and a
reserved stop slot use the same rules as the courier.

Production defaults in the `crew` section of `config/world.json` are
`crewMiningTravelMs: 30000`, `crewMiningCycleMs: 60000` and
`crewMiningBatchM3: 100`. Jobs retain their accepted timings/hold size. Mining
requires `crewOperationsEnabled`, `miningEnabled` and `asteroidFieldsEnabled`.
The gateway adds authenticated `/crew/mining`, `/crew/mining/sites` and
`/crew/mining/orders` routes through the existing edge/owner protocol.

## Verification

`npm run test:crew` runs 39 tests against attested disposable stores. Coverage
includes finite ore → miner custody → home hangar → repeating courier →
destination, depletion, competition with a native mining producer, failed intent
flushes, pause/stop, command replay and owner-scoped gateway access. Separate
processes recover faults after source debit, grant, unload and acknowledgement;
late replay is checked after a player/courier moves ore onward. Separate
100-delivery courier and mining runs check conservation, bounded history,
unchanged command receipt usage and retired inventory receipts. A production
adapter test creates a generated space scene and verifies its native finite
resource state and ore custody without launching EVE.

The practice server accepts an optional port:

```powershell
npm run demo:x-command -- 40122
```

It uses disposable practice inventory and a finite 5,500-unit Veldspar field.
Mining takes 3 seconds each way and 5 seconds per extraction in this preview;
courier travel takes 6 seconds per leg. The installed real server was restarted
to load the new code; no EVE launch is required for backend verification.
The earlier client inventory/notification acceptance check remains pending.

## Local running assignment (31 October 2026)

The live backend at `http://127.0.0.1:26002/x-command` has Test Pilot's mining
team assigned to Veldspar in New Caldari II - Asteroid Belt 1. Its home is
New Caldari IV - Moon 1 - Poksu Mineral Group Mineral Reserve (60000682).
Wayfarer Logistics has a standing route from that source to Jita IV - Moon 4 -
Caldari Navy Assembly Plant (60003760), with zero source reserve. These are
saved gameplay orders and continue while the backend runs.

A live restart during the first return trip retained the original 1,000-unit
stack (9988400000231). It unloaded home and was picked up automatically by the
courier under the same item ID. The saved checks are under
`_local/living-universe-audit/mining-live-*.json`. A consistent world backup was
taken before loading the new backend at
`_local/backups/pre-mining-backend-20261031T170649Z/gamestore.sqlite`.

The first live supply delivery completed at 17:12:29 UTC: 1,000 Veldspar reached
Jita. Both standing orders remain active. Screenshot evidence is saved in
`_local/living-universe-audit/mining-live-delivery.png`; all 39 headless tests
passed in `mining-crew-acceptance.txt`. EVE was not launched for these checks.
