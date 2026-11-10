# Automated crew manufacturing

The production chain is finite ore → miners → refinery → minerals → standing
courier → native factory jobs → ammo and modules in the owner's station hangar.
The [selling crew](CREW_SELLING.md) can now sell surplus above a reserve and
return net proceeds to the pilot's wallet to fund production.
EveJS runs headless. The CCP EVE client stays closed during development and
acceptance tests. Crew people are persistent virtual Living Universe actors;
their inputs, jobs, payments, blueprints and outputs use the native owners.

## X-Command

In **Manufacturing crew**, select an NPC factory station and load owned
blueprints. The optional one-time starter pack supplies two original blueprints:
Iron Charge S (1130) and 1MN Civilian Afterburner (21858). Grants are per pilot,
idempotent across restarts, and cannot reset an installed blueprint. The pack
does not provide minerals, ISK or skills.

Select up to eight ammo/module blueprints with fixed mineral recipes. Set runs
per batch and a finished-stock target for each. The team [ranks ready recipes by
expected profit per native production hour](CREW_PRODUCTION_PRIORITY.md), skips
shortages and checks again as minerals arrive. Finished stock is counted
in that factory's ordinary personal hangar (flag 4). A batch can overshoot the
target by its run size. Consuming or moving the products can trigger restocking.

The shared [profit check](CREW_PROFITABILITY.md) requires active selling orders,
eligible local demand and net revenue above all replacement minerals and factory
fees before a new installation. Losing or unpriced recipes wait automatically;
mined minerals retain their replacement value in this calculation.

Industry skills, available slots, facility access, BPO/BPC ownership and licensed
runs, material requirements, production times and ISK installation fees use the
native industry quote and settlement implementation. Remote crew presence at
the factory does not move or take control of the pilot. Pausing or stopping
prevents new installations; accepted native jobs finish and deliver automatically.
An installation fee rejected after a concurrent expense waits and retries when
funds return. Other definitive installation rejections or native cancellation
disable the queue.

For mixed ore, choose **All refinery minerals** in the supply route. An optional
`typeIDs` group rotates up to eight unique material types, starting with
`typeID`. Missing types are skipped. Each trip carries one material within the
courier's hold, splitting a large stack when needed. Source reserves apply
separately to each material.
Legacy single-type routes keep their behavior. Stop an old route and let its
accepted trip finish before replacing it.

## Durability and ownership

The crew fences an exact native install intent before installation: selected
input stacks, quote, blueprint snapshot, native job ID and completion date.
The existing industry settlement owns debit, material escrow/consumption,
blueprint installation and compensation. Its completion transaction clears the
pending operation and retains one per-crew completion watermark. A lost reply
or scheduler completion cannot install the same crew batch a second time.

The native factory clock determines readiness. Delivery uses native product
grants, blueprint return/license consumption and native job status. Crew totals
are saved before retiring custody receipts. A restarted crew sees a delivered
job even when its output was moved or consumed, and cannot recreate that output.
Only an already accepted native job can mature while the server is stopped;
there is no instant backlog of newly installed offline jobs.

`manufacturingCrewRuntime` belongs to `service:crew-manufacturing`: at most
128 teams, eight recipes per team, a 20-batch crew history and a bounded command
ledger with a reserved stop slot. Native industry job history remains in
`industryJobs`. Installation/delivery custody receipts are retired after durable
crew completion; permanent starter-grant receipts and one completion watermark
per owner remain. Commands and ticks serialize per pilot; shutdown drains work.

The Living Universe directory exposes Nia Halen (production chief), Bram Seth
(assembly technician), their factory/status and `goods_manufactured` events.
This is a read-only observation feed, not another authority for creating goods.

The existing authorized edge/owner gateway adds:

- `GET /_evejs-web/v1/crew/manufacturing`
- `GET /_evejs-web/v1/crew/manufacturing/catalog?stationID=...`
- `POST /_evejs-web/v1/crew/manufacturing/orders`

Commands are `starter {stationID}`, `start {stationID,orders:[{blueprintID,runs,
targetStock}]}`, and `pause`, `resume`, `stop` with `{}`. Account ownership,
gateway token, same-origin JSON, strict fields, revisions and command IDs apply.

## Verification

`npm run test:crew` passes 67 tests, including factory and gateway coverage with real native
inventory, wallet, blueprint and industry owners in attested disposable SQLite
worlds. Tests cover the complete finite Scordite → refinery → mixed-mineral
courier → ammo/module chain, native completion clocks, target-driven restocking,
shortage skipping, BPC consumption, pause/stop, ownership and gateway security.
Separate processes recover starter, debit, staged/consumed materials, blueprint
installation, completed installation, output delivery and receipt interruptions.
A 100-batch run checks conservation and bounded crew/custody records. Native
industry history is deliberately retained.

`npm run demo:x-command -- 40124` creates a separate practice world with a finite
6,000-unit Scordite field and two-second fixture factory recipes. Production
uses the original static recipes and native factory times; the live starter
jobs at Jita take 274 seconds per run for Test Pilot's current skills/facility.
Evidence is under `_local/living-universe-audit/manufacturing-*`.

The live local page is http://127.0.0.1:26002/x-command. Port 40120 is an older
practice world. Test Pilot's starter pack and factory are at Jita IV - Moon 4 -
Caldari Navy Assembly Plant (60003760). Miners work Scordite at New Caldari II -
Asteroid Belt 1 (40009256); the refinery at New Caldari IV - Moon 1 - Poksu Mineral
Group Mineral Reserve (60000682) feeds a Tritanium/Pyerite route to Jita. That
refinery station does not have a factory, so production uses Jita.

The consistent pre-change backup is
`_local/backups/pre-manufacturing-backend-20261031T182032Z/gamestore.sqlite`.

Live acceptance on 31 October 2026 delivered one civilian afterburner at
18:25:59 UTC and 100 Iron Charge S at 18:30:35 UTC. Both original blueprints
returned to Jita. The queue reached its targets after paying 28 ISK in total
installation fees. The ammo job survived a backend restart with its job ID,
completion time and fees unchanged. Read-only SQLite inspection confirmed the
finished goods and singleton blueprint records, excluding grant-receipt rows.
The universe feed contains eight persistent crew people. The full evidence is
`manufacturing-live-acceptance.json` in the audit directory; EVE stayed closed.
