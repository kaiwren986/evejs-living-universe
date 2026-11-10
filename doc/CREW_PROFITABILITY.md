# Profit-aware crew production and buying

Manufacturing and procurement now require a positive expected batch profit.
X-Command shows the quote or a reason for waiting. There is no opt-out in the
live crew runtime; existing production and buying policies gain these checks
without changing their quantities, price limits, spending caps or reserves.

The [adaptive production planner](CREW_PRODUCTION_PRIORITY.md) now ranks those
profitable recipes by native production-hour return. Existing surplus gets first
claim on the best bids before the next batch is valued.

## Calculation

`expected profit = sale proceeds - native sales tax - replacement minerals - factory installation fee`

The complete native recipe uses its configured runs, material research and
installation quote. All minerals, including mined or already-owned stock, have
their current replacement value. Owning the input does not give it zero cost.
The estimate does not charge a second refining tax on top of replacement value.

Only actual seeded NPC orders at the same station are considered. The guard
walks mineral asks from cheapest upward and product bids from highest downward,
with enough eligible volume for the full batch. It respects the selling floor,
sale batch size, order minimum lots and native tax rounding for each sale lot.
It does not assume unlimited supply at the first listed price. Pending market
fills are excluded. Work uses up to 256 eligible price levels per book.

There must be an active, unpaused selling policy for the product at that factory.
Its production target must exceed the selling reserve and leave room for an
eligible minimum sale lot. Missing mineral prices, insufficient eligible demand,
unavailable market data or a missing selling policy hold work. Break-even also
waits: at least one positive ISK cent is required after costs.

These are current market estimates. Orders are not reserved for a future sale;
prices and available demand can change during a factory job.

## Decisions and recovery

- Manufacturing checks profit before preparing a new native install intent and
  again immediately before starting native settlement. A price drop before
  spending discards the unstarted intent and leaves the queue active to retry.
- Buying derives its requirements only from profitable, currently needed recipes.
  A losing module recipe cannot inflate the mineral allocation for a profitable
  ammo recipe in the same queue. Batch shortages still precede larger buffers.
- Buying checks the actual selected ask, valuing the recipe's units at no less
  than that price. This catches expensive asks selected because a cheaper order's
  minimum lot cannot fit the configured purchase batch.
- A purchase rechecks profit before its first native anchor/debit. Once native
  settlement has started, both buying and manufacturing confirm their saved
  settlement instead of cancelling or charging again because prices changed.
  Installed jobs finish and deliver normally.

The guard uses exact cent arithmetic and the same character tax calculation as
native crew sales. It creates no orders, wallet transactions, minerals or goods.
New economic quotes live inside existing bounded crew records; no new durable
owner or public mutation API is introduced. Command field validation, ownership,
revisions, same-origin requirements and command replay remain enforced.

Manufacturing and buying statuses explain unprofitable prices, unavailable
quotes, missing selling orders, reserve conflicts and insufficient demand.
The normal ticks recheck held work automatically. A satisfied recipe does not
make the overall buying policy appear blocked when other needed buffers are full.

## Verification without EVE

`npm run test:crew-profit` runs 14 native integration and quote tests. They cover
replacement value of owned stock, the exact native tax and factory fee,
break-even versus a one-cent profit, market depth, minimum lots, reserves,
partial demand, actual selected purchase prices, mixed queues, price changes
before debit/install, and recovery of already-started purchases and jobs.

`npm run test:crew` includes those checks and the complete mining → refining →
hauling → manufacturing → selling → buying scenario. The full-loop test uses
real profitability decisions and native accounting, restores services twice,
and recovers from a market interruption. Its isolated accelerated factory clock
does not change live production times. Native custody-focused tests inject a
named profit fixture to isolate settlement behavior; the economic tests and
live runtimes use the real guard.

Evidence is under `_local/living-universe-audit/profit-*`: full test output,
isolated economy totals, pre/post-restart records, live quotes and UI screenshot.
No CCP EVE client is launched by these tests.

## Local acceptance

The native Jita quote currently estimates 12,178.08 ISK per 100 Iron Charge S
and 24,767.45 ISK per civilian afterburner after replacement minerals, selling
tax and factory fees. A newly installed live afterburner job contains the
accepted profitable quote. All twelve people and existing standing orders
survive restart. Buying remains at 100 ISK lifetime spend while factory mineral
buffers are already full.

Consistent world and market backups, both passing SQLite `quick_check`, are in
`_local/backups/pre-profit-backend-20261031T212147Z/`; metadata is recorded in
`_local/living-universe-audit/profit-backup.json`.
