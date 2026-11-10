# Production-directed mining and refining

Mining and refining can now follow the factory's profitable recipe priorities.
In X-Command, use **Follow production** on each active crew. **Keep current ore**
returns that crew to a fixed ore assignment. The choice persists between backend
restarts. An accepted trip or refining batch finishes with its saved ore and
quote; the new policy applies when choosing the next job.

The refinery must be active at the miners' home station. Manufacturing must be
active, with profitable configured recipes and selling orders. A factory at
another station needs an active, unpaused mineral supply route from the refinery
to that factory. Include every needed mineral in the route's material group.
Crews wait when these prerequisites are missing. This feature does not relocate
crews or create new routes or blueprint orders.
If the refinery is kept on a fixed ore, production-led miners only choose that
ore and supply forecasts ignore other raw ores it would not process.

## Choosing useful ore

The resource planner refreshes the same native profitability assessments used
by manufacturing. It ranks eligible ammo/module recipes by net ISK per native
production hour, including replacement mineral prices, factory fees, sales tax,
unsold stock and remaining buyer demand. Accepted factory output also counts
when assessing further demand. Price changes affect the next resource job.

For the strongest opportunity with an uncovered mineral need, it compares local
ore using the owner's native refining portions, station yield, skills, standings
and ISK tax. It favors useful coverage of those shortages, then lower tax and
smaller loads. It tries another profitable configured recipe when the strongest
one needs no more useful local ore. Mining stays within the home system and
switches ore or finite belts between trips. Exhausting every useful local source
leaves the order waiting for supply.

Working mineral targets use the buyer's saved stock targets for that factory,
with at least one recipe batch. Without a matching buying rule they default to
five batches. Targets are bounded at one million units per mineral. Available
factory minerals, transportable source minerals above the courier reserve,
hauling cargo, accepted refining output and accepted purchases reduce the gap.
Mining additionally counts complete refining portions already in the ore buffer
or returning home. Refining chooses from eligible ore in the source hangar and
limits custody to useful native portions and hold capacity. The raw-ore reserve
continues to apply separately to each ore type.

Both crews wait when these buffers are covered. A batch whose native refining
tax would equal or exceed the replacement value of its useful missing minerals
also waits. For example, a one-unit Pyerite gap can be cheaper to buy than to
refine a whole ore portion. Unneeded coproducts do not justify extra tax.

## Coordination with buying and native inventory

Procurement counts transportable upstream minerals and an economical, funded
upcoming refining batch before buying the same supplies. Returning ore can
cover that batch. It waits for local supply when that forecast covers a shortage;
it can still buy uncovered gaps under its existing price ceilings, sales-income
allowance, spending cap and wallet reserve. Uneconomical raw ore does not block
a cheaper purchase. Actual factory stock above target is shown as stocked even
when more supply is in transit.

Forecasts grant no items or ISK. Native finite extraction, ore custody,
reprocessing settlements, taxes, mineral grants, hauling and purchasing remain
the only effects. Durable receipts and reprocessing completion watermarks keep
lost replies from counting completed output twice. Unavailable quotes or custody
confirmations hold new resource decisions. Accepted work retains its existing
recovery and compensation behavior.

The planner is read-only and bounded. It assesses the factory's existing maximum
of eight recipes, scans at most 128 belt/ore candidates and projects at most 32
ore types per pass. Mining prepares asynchronous assessments before its existing
synchronous tick and discards a prepared decision if the crew revision changes.
No new public endpoint, database table or durable financial owner is added.
The existing mining/refining order endpoint accepts a strict
`prioritize` command with payload `{ "enabled": true }` (or `false`), using the
normal owner, origin, token, idempotency and expected-revision protections.

## Verification without EVE

`npm run test:crew-resources` runs 60 tests with disposable native inventories,
finite asteroid scenes, actual industry/reprocessing owners and a local market
fixture. They cover profitable recipe changes, Veldspar/Tritanium and
Scordite/Pyerite selection, queued ore, stocked buffers, route pauses, source
reserves, finite depletion, accepted-job reconstruction, quote outages, strict
mode commands, stale asynchronous decisions, lost settlement replies and buying
coordination.
An additional fixed-refinery case prevents mining or forecasting ore that the
refinery's saved policy would leave unprocessed.

The six-crew integration case checks ore, mineral and ISK conservation on every
one of 110 ticks. It mines and refines 500 ore, produces 500 Iron Charge S and
12 civilian afterburners, and ends at 102,056.50 ISK from 100,000 ISK after sales,
purchases, native refining tax and factory fees. Its accelerated test clocks do
not change live factory durations. `npm run test:crew` covers all 199 crew,
gateway, native integration and recovery tests.

Evidence is under `_local/living-universe-audit/resource-*`, including decision
records, the full suite log and live acceptance snapshots. Consistent world and
market SQLite backups, both passing `quick_check`, were saved before the backend
restart in `_local/backups/pre-resource-backend-20261031T221636Z/`.

On the local Test Pilot, both follow modes are enabled at New Caldari. Existing
mineral buffers already exceed their targets, so miners and refiners wait while
the native factory, selling crew and mineral route continue. The accepted mining
trip delivered normally. All twelve Living Universe people remain present and
procurement has made no new purchase. EveJS runs headless; the EVE client was
not launched for this work.

The courier can now follow the same production priorities, cap deliveries to
factory shortages and wait at a stocked factory. See
[production-directed courier deliveries](CREW_COURIER_PRIORITY.md) for setup,
destination accounting and the additional 18 courier scenarios. Supply planning
now also skips recipes whose finished stock plus accepted output meets their
product target.
