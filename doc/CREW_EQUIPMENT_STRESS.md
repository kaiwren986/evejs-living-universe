# Equipment economy stress checks

`npm run test:crew-equipment-stress` runs two complete economies with mining,
refining, hauling, manufacturing, selling, buying and automatic equipment
reinvestment. Both use disposable native inventories, finite asteroid scenes,
reprocessing/industry/wallet owners and a local market fixture. EVE is never
started and live pilot assets and order books are not used as test fixtures.

## Quote race found and fixed

Equipment assessment takes a snapshot of the factory and selling policies, then
awaits native profitability quotes. Previously it could approve tooling after
the factory had paused or switched to a larger production batch. The larger
batch also needs a larger protected cash buffer, so using the earlier quote
could spend cash that the replacement queue needed for minerals.

The assessment now checks the current factory, accepted job and selling policy
after the quote replies. A changed configuration discards the quote and waits
for a fresh assessment. Settlement state and the mining/hauling teams' current
work are also read again before choosing equipment. Existing accepted purchases
retain their recovery behavior and permanent payment identities.

Two regressions failed before this fix: pausing the factory during its quote,
and increasing its batch from one to 100 runs during the quote. They now wait
without an upgrade candidate. The next assessment of the larger batch protects
24,000 ISK of replacement capital instead of using the earlier 240 ISK quote.

## Full-loop scenarios

Both economies start at 100,000 ISK with zero crew XP and equipment. They earn
all six teams' levels and buy useful equipment before the market shocks. Each
team's first level-up loses its acknowledgement reply; each equipment role's
first supplier debit loses its reply after payment is durable. All services are
reconstructed to verify recovery. No XP or equipment tier is seeded.

The subsequent schedule includes:

- Exhausting all product demand, settling accepted work and reopening buyers.
- Pausing local supply, moving working minerals to a remote station through
  native inventory operations, raising Tritanium above its buying ceiling and
  exhausting the Pyerite ask. Local supply and affordable asks are restored.
- Raising mineral prices until every recipe loses money, then restoring prices.
- A quote outage, followed by recovery and further service reconstructions.
- A reproducible seed-991 sequence of price changes, partial/exhausted bids and
  missing mineral asks, followed by a final normal market and resumed production.

Four settled blocked windows per run verify no further extraction, deliveries,
tax, factory fees, mineral purchases, equipment spending or XP. Accepted work
may finish first. Manufacturing readiness is accelerated but remains building
for several logical ticks so dispatch order cannot turn every factory job into
an instantaneous event.

Each tick reconciles ore, minerals, finished products, installed-job consumption
and ISK. XP is checked against distinct successful job IDs. Equipment debits are
independently reconstructed from permanent native wallet receipts, including a
paid purchase whose installed tier has not yet been acknowledged. A second debit
with the same receipt would fail wallet conservation. Every new payment is
checked against the approved profit allowance, budget, payback and protected
wallet balance. Procurement and equipment cannot reuse the same sales income.

The stress procurement cap is 1,000,000 ISK so the recovery tests can keep
operating after their finite local ore is depleted. Separate cap regressions
retain the expected stop when a policy is exhausted. The live policy is not
enlarged for these tests.

Each case has its own finite scene and belt catalogue. Old empty fixture belts
cannot consume the next case's discovery window; the native 128-site bound is
unchanged.

## Results

The two focused runs complete 2,442 logical ticks and 26 service reconstructions.
All six crews earn levels in each run. Six equipment payments lose their replies
and recover once, with no duplicate debit, installed tier or XP award. Eight
settled market windows preserve cash and wait for recovery.

| Run | Starting ISK | Net sales | Mineral purchases | Refining tax | Factory fees | Equipment | Ending ISK |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Scripted | 100,000 | 653,200 | 203,645 | 4,550 | 41,712 | 59,500 | 443,793 |
| Seed 991 | 100,000 | 506,000 | 150,245 | 4,550 | 33,504 | 19,500 | 398,201 |

The scripted run reaches mining/hauling/manufacturing tiers 2/1/3; seed 991
reaches 2/1/2. Production resumes after the final market recovery in both.

The complete `npm run test:crew` run passes 227 tests: 64 resource/planning
scenarios, 23 focused equipment cases and the existing crew, gateway, native
settlement and progression regressions. The combined run reproduces both focused
stress results. The delayed-quote regressions failed before the fix and pass
after it.

The updated backend was restarted after world and market backups passed SQLite
`quick_check`. Read-only live acceptance confirms all twelve people, persistent
XP, the existing reinvestment and purchasing limits, and the same three supplier
receipts for 52,000 ISK. No additional live mineral purchases were made for the
test; EVE remained closed.

Results and logs are under `_local/living-universe-audit/equipment-stress-*`.
The backend fix preserves existing equipment, receipts, people, XP, standing
orders and financial limits. See [equipment policy](CREW_EQUIPMENT.md) for the
upgrade rules and [earlier production stress tests](CREW_PRODUCTION_STRESS.md)
for the purchasing-budget and recipe-fallback regressions.
