# Full economy and crew XP acceptance

`npm run test:crew-xp-economy` runs a disposable economy in which all six teams
start at zero XP and earn their first level through completed work. It uses the
native inventory, finite mining, reprocessing, industry and market settlement
owners with a local market fixture. It never starts the EVE client or changes
the live pilot's stock, orders or wallet.

The previous stress tests checked XP against completion counters, but did not
require all six teams to level in one economy. The shared stress ledger now
also tracks distinct successful job IDs independently of those counters. A
duplicate counter increment and XP award cannot conceal each other.

## Cohort results

The cohort completes 638 logical ticks, rotating service dispatch order. It
alternates profitable ammo/module prices, follows mineral shortages, exhausts
buyer demand and verifies that useful work resumes when demand returns.

| Team | Distinct successful jobs | Final XP | Final level |
| --- | ---: | ---: | ---: |
| Mining | 30 | 300 | 2 |
| Refining | 33 | 330 | 2 |
| Hauling | 50 | 500 | 2 |
| Manufacturing | 13 | 130 | 1 |
| Selling | 13 | 130 | 1 |
| Buying | 63 | 630 | 3 |

All six reach level 1 by tick 444. New work applies the earned bonus: mining,
refining and hauling durations drop from 1,000 to 970 ms; the native 100-run
factory quote drops from 192 to 187 seconds; trade cooldowns drop from 5,000
to 4,500 ms. Saved jobs retain their accepted timing.

The test deliberately loses the native acknowledgement reply at each team's
first level-up, after completion and its XP have been saved. All six services
are reconstructed from their repositories after each fault. Recovery preserves
XP and resumes work without awarding completion again. Existing separate-process
recovery tests continue to cover native effect, fill, payment and delivery
faults before acknowledgement.

Every tick checks ore, minerals and products across native custody and installed
jobs, and reconciles the wallet against sales, purchases, refining tax and
factory fees. Purchases stay within sales income, price ceilings, policy budget
and wallet reserve. New factory jobs require positive expected profit. During
the settled demand shutdown, XP, extraction, deliveries, taxes, fees and buying
remain unchanged; production resumes after reopening.

The cohort starts with 100,000 ISK and ends with 305,192 ISK:

`100,000 + 294,400 net sales - 66,100 purchases - 4,244 refining tax - 18,864 factory fees`

It mines 18,898 units from a finite 20,000-unit ore allowance, refines 18,800,
and produces/sells 70,000 ammo and 600 modules. The test uses genuine 100-run
recipe batches to exercise native duration rounding and fund mineral restocking.
No XP is seeded. Test clocks and factory readiness are accelerated; this is a
deterministic accounting/recovery check, not a real-time production benchmark.

## Regression and live checks

`npm run test:crew` passes 200 cases, including 61 native resource/planning/XP
scenarios. The existing three price/demand stress runs add 1,200 ticks, with
shortages, price ceilings, unprofitable recipes, quote outages and six further
service reconstructions. No additional runtime defect was found in this pass;
the changes strengthen coverage and provide the repeatable cohort command.

Read-only API and SQLite checks confirm all twelve live crew members and all
six durable skill records. Mining/refining/hauling and procurement are stocked;
manufacturing and selling continue normally. Procurement remains at one purchase,
10 XP and 100 ISK lifetime spending: the test does not buy surplus minerals just
to make the live buyer level. No runtime code changed, so no backend restart
was needed. EVE remains closed.

Evidence is under `_local/living-universe-audit/`:

- `xp-economy-full-tests.txt`: full regression output.
- `xp-economy-decisions.json`: cohort and resource/stress decisions.
- `xp-economy-live-acceptance.json`: live API and durable XP acceptance.

