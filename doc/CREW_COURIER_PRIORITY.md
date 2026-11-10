# Production-directed courier deliveries

Use **Follow production** on an active mineral supply route in X-Command.
The saved route keeps its stations, permitted materials and per-type source
reserve. **Rotate materials** returns to its original stock-driven rotation.
The mode persists through a backend restart. An accepted load or empty return
finishes its saved trip before the next decision changes.

## Selection and waiting

The courier shares the mining/refining planner's native recipe assessment:
net sales after native sales tax, replacement mineral costs and factory fees,
ranked by profit per native production hour. Only the destination factory's
configured ammo/module recipes participate. The factory and selling orders
must be active. Market outages, unprofitable recipes or a paused factory hold
new trips without moving inventory.

Finished stock plus accepted production counts against each recipe's product
target. Covered recipes are skipped so a stocked high-profit product cannot
block another profitable recipe's supplies. This correction also applies to
mining and refining.

Courier selection first considers one-batch mineral shortages, in profitable
recipe order. Only after those possibilities does it fill working buffers.
Buffer targets use the buyer's saved mineral targets for this factory, with
at least one recipe batch; otherwise they default to five batches. Within a
recipe it prefers a load covering more of the shortage, with the saved route
rotation breaking ties. It skips unavailable materials and can feed another
recipe. It never adds a material outside the route's selected group.

Only minerals already at the factory and accepted, unreceived purchases cover
the destination's hauling gap. Source minerals, mining cargo and refinery
output still need transport. Each load is capped by the gap, source reserve,
actual stack quantity and hold volume. Native partial-stack custody allows a
67-unit requirement to take 67 units from a 1,000-unit stack.

When every useful buffer is covered, the crew waits at its current station.
It does not make an automatic empty return just because the previous delivery
finished. New factory consumption or changed profitable demand wakes the route
on its next check. A needed load must exist at the source before an idle crew
returns there; it checks again before picking up that load. Waiting checks
run every five seconds and preserve native travel time.

## Custody and recovery

Assessments are read-only. A bounded asynchronous planning pass runs before the
existing synchronous courier tick and discards decisions when the crew revision
changes. Immediately before a new trip, it checks factory activity, recipe
policy, finished output and destination supply again. An arrival during the
assessment can shrink or cancel the proposed load. Source selection also reads
fresh native inventory before the durable reservation intent is saved.

Accepted jobs use the existing native cargo moves, receipts, notifications,
partial-stack recovery, completion history and receipt acknowledgement. Price
changes do not redirect cargo already in custody. Pause freezes the accepted
trip, and stop lets it finish while preventing more pickups. Planning does not
consume command receipts or create a second financial/inventory owner.

The existing `/crew/orders` endpoint accepts `prioritize` with the strict payload
`{ "enabled": true }` or `false`, retaining token, account ownership, same-origin,
idempotency and expected-revision checks. New `automate` commands can optionally
include `followProduction`; saved orders without it retain the original
rotation. The existing bounded `crewRuntime` record stores the mode and current
priority. Living Universe crew actors display stocked/waiting activities.

## Verification without EVE

`npm run test:crew-hauling` runs courier priority and progression scenarios in disposable
native inventories with a local market fixture. `npm run test:crew-resources`
covers all 60 resource/courier/stress/progression scenarios, and `npm run test:crew` covers
all 199 crew, gateway, native integration and recovery tests. Checks include:

- Price-driven recipe and mineral switches, batch-first loads, stocked product
  fallback and entirely stocked/unprofitable factories.
- Waiting at the destination, resuming after consumption, limited loads and
  source reserves.
- Accepted purchases, arrivals during assessment, stale decisions after stop,
  strict mode controls and native gateway authorization.
- Reconstruction and lost reservation/delivery replies without duplicated cargo.
- A 160-tick six-crew loop with a mid-run price change, checking ore, minerals
  and the wallet on every tick. It produces 400 ammo and six modules, completes
  18 supply deliveries and finishes at 101,329 ISK from 100,000 ISK.

Evidence is under `_local/living-universe-audit/hauling-*`, including the full
suite log, decisions, live acceptance and dashboard preview. Consistent world
and market SQLite backups passed `quick_check` before the restart in
`_local/backups/pre-hauling-backend-20261031T223515Z/`.

The local Test Pilot's existing New Caldari-to-Jita mineral route has production
following enabled. Its accepted cargo finishes normally; stocked factory buffers
then hold new pickups and empty returns. Mining, refining, manufacturing, selling
and buying keep their existing policies and all twelve crew people remain in
the Living Universe. These checks use the EveJS backend; the EVE client is not
launched.

The [full production-aware stress report](CREW_PRODUCTION_STRESS.md) adds
changing demand, mineral shortages, quote outages and full-batch funding checks.
