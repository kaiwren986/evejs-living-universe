# Buying and selling crew skills

Buying and selling now use the existing persistent crew XP system. A confirmed
purchase earns 10 XP for the Procurement team; a confirmed sale earns 10 XP for
the Market Sales team. Each team shares its skill across its two members.

The same cumulative thresholds apply: 100, 300, 600, 1,000 and 1,500 XP for
levels 1 through 5. Trading skills shorten market checks, post-trade cooldowns
and idle market-outage retries by 10% per level, up to 50%. Other working
skills retain their existing 3% steps and 15% cap.

| Trade skill level | XP threshold | Stock/demand check | Post-trade cooldown |
| --- | ---: | ---: | ---: |
| 0 | 0 | 10 seconds | 5 seconds |
| 1 | 100 | 9 seconds | 4.5 seconds |
| 2 | 300 | 8 seconds | 4 seconds |
| 3 | 600 | 7 seconds | 3.5 seconds |
| 4 | 1,000 | 6 seconds | 3 seconds |
| 5 | 1,500 | 5 seconds | 2.5 seconds |

The runtime polls once per second, so work starts on the first pass at or after
its saved deadline. Each pass still handles at most one trade per owner. Native
prices, quantity limits, fees, tax and settlement remain authoritative; the
skill creates no price adjustment, discount, item or ISK grant. Profit checks,
full-batch funding, local supply forecasts, price limits and reserves continue
to decide whether any trade is useful.

## Learning and recovery

XP is awarded only after the native trade owner confirms success, in the same
durable crew row update as the trade totals, history and acknowledgement phase.
Rejected trades, refunds, deferred purchases, quotes, idle checks and failed
payment attempts earn none. A pending paid trade finishes confirmation even if
orders are stopped or prices change; its successful completion earns XP once.

New accepted trades save their skill snapshot and cooldown before native
effects. Crossing a level does not change that trade's cooldown. Subsequent
trades use the new level. Older accepted jobs without these fields retain the
original five-second cooldown. Reply loss after fill, payment, delivery,
completion or acknowledgement cannot duplicate XP, stock or proceeds.

Existing `completedSales` and `completedPurchases` counters supply legacy XP,
capped at 1,500. The backfill is persisted on the next ordinary crew save.
Changing a policy, station, pause state or backend process does not reset it.
XP stays in the existing authoritative crew tables; no extra ledger or reward
owner is added. Public commands cannot set experience, levels or timing bonuses.
Malformed XP or out-of-range saved cooldowns hold work for recovery.

X-Command shows the team skill, next XP threshold and actual cooldown/check
deadlines. All twelve Living Universe crew members now display their team's
specialization and experience.

## Verification without EVE

Ten added cases cover bounded skill steps, legacy counters, recovered fills,
frozen cooldowns, rejected/refunded trades, idle timing, policy changes, damaged
XP and acknowledgement replay. The unchanged native accounting is checked:
two 200 ISK gross sales each pay 16 ISK tax; purchasing 67 Tritanium and 21
Pyerite costs 109 ISK. No XP reward alters either amount.

Separate-process sale and purchase recovery fixtures now assert exactly one XP
award after native faults, including zero XP after a compensated purchase. The
1,200-tick economy stress scenarios verify XP against successful completions for
all six teams on every tick, together with ore/mineral/product and wallet
conservation across changing prices, demand, shortages and service restarts.

`npm run test:crew` passes all 227 tests. `npm run test:crew-progression` covers
22 progression cases, and `npm run test:crew-resources` includes 64 native
resource, trading, progression and stress scenarios. Pure progression coverage
accounts for six additional cases in the full suite.

Evidence is under `_local/living-universe-audit/trade-progression-*`, including
the full suite log, native decisions, live acceptance, durable XP and dashboard
preview. World and market SQLite backups passed `quick_check` before restart in
`_local/backups/pre-trade-progression-backend-20261031T233835Z/`.

The live crews receive credit for their existing trades. No extra purchases or
sales are forced to demonstrate learning. The EVE client stays closed.
