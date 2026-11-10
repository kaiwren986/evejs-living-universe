# Crew experience and work skills

Mining, refining, courier, manufacturing, buying and selling teams share persistent skills
across their two members. Each successful mining delivery, refining batch,
cargo delivery, delivered manufacturing job or confirmed trade earns 10 XP for its own team.
Waiting, quotes, orders, empty travel/returns, failed payments and cancelled
production earn none. A stopped order can still earn XP if its accepted work
finishes successfully.

| Skill level | Total XP | Shorter work/travel time |
| --- | ---: | ---: |
| 0 | 0 | 0% |
| 1 | 100 | 3% |
| 2 | 300 | 6% |
| 3 | 600 | 9% |
| 4 | 1,000 | 12% |
| 5 | 1,500 | 15% |

XP is capped at 1,500. X-Command shows each team's level, total XP, next
threshold and current time reduction. Living Universe actors show their team's
skill too. These are team specializations, separate from the pilot's EVE skills.
[Market Sales and Procurement](CREW_TRADE_PROGRESSION.md) use the same thresholds
with 10% shorter trading delays per level, capped at 50%.

## Effects on work

- **Mining:** shorter extraction cycles. Native finite ore, hold size and travel
  time remain authoritative.
- **Reprocessing:** shorter refining cycles. Native portion sizes, yield,
  mineral output and tax still come from the ordinary reprocessing quote.
- **Logistics:** shorter travel legs, including necessary empty returns. Cargo
  deliveries award XP; repositioning alone does not.
- **Manufacturing:** shorter native factory jobs. Materials, fees, licensed
  runs, output quantities and pilot skill requirements remain native.
- **Market Sales and Procurement:** shorter market checks and trade cooldowns.
  Confirmed trades earn XP; quotes, rejected fills and refunds earn none.

Durations round up and stay at least one millisecond (virtual work/travel) or
one second (native industry). Bonuses are selected for new work. Saved mining,
refining and courier jobs keep their accepted durations; native industry intents
keep their accepted quote and end date. A level-up cannot accelerate or replay
an already accepted job.

Manufacturing applies its bonus inside the native industry quote, through a
private capability on server-created crew actors. Its immutable skill snapshot
is saved with the native job. Retail sessions and public request payloads cannot
supply a crew multiplier. Manufacturing, procurement and resource planning all
see the same adjusted native duration when ranking profit per production hour.

## Persistence and existing crews

The bounded `{ version: 1, xp }` progression record lives in each team's existing
authoritative crew row. XP, completion totals/history and the next job phase are
saved in the same durable fence after native completion. Retrying an unload,
reprocessing result, cargo move or industry delivery cannot award another 10 XP.
Native completion receipts/watermarks still own every inventory and wallet effect.
No extra reward ledger, table, inventory grant or ISK payment is introduced.

Existing mining/refining/manufacturing/trading crews receive XP for their saved successful
completion counters. Couriers receive credit for the current standing route's
saved cargo delivery count, plus other completed cargo trips still in retained
history. Empty journeys are excluded. Older courier trips beyond that bounded
history cannot be reconstructed. The backfill is persisted on the team's next
normal save and is not repeated after orders change or the backend restarts.

Malformed or out-of-range saved XP holds work for recovery. Commands cannot set
XP, levels or multipliers. Changing an assignment, pausing or stopping does not
reset the team's experience.

## Verification without EVE

`npm run test:crew-progression` runs 22 focused cases: thresholds/caps,
legacy credit, malformed state, read-only views, successful level-ups, frozen
durations, rejected/cancelled work, empty travel, native factory timing and
forged commands/retail actors. A native 100-run factory job goes from 192 to
187 seconds after reaching level 1, with identical fees and materials.

Existing separate-process recovery fixtures now assert XP exactly once after
mining, refining, courier and factory faults. The full 1,200-tick production
stress suite also checks XP against actual completed work on every tick, across
price/demand changes and six service reconstructions. Ore, minerals, products,
native fees/taxes and ISK conservation remain checked.

`npm run test:crew` passes all 227 crew, gateway, native integration and recovery
tests. Resource/progression scenarios account for 64 of these, with six
additional pure progression cases. Evidence is under
`_local/living-universe-audit/progression-*`, including the full suite log,
decisions, live snapshots and dashboard preview. Consistent world and market
SQLite backups passed `quick_check` before restart in
`_local/backups/pre-progression-backend-20261031T231522Z/`.

The local teams retain their identities, standing orders and production-aware
policies. Existing accepted work finishes on its saved schedule. Stocked miners,
refiners and couriers wait instead of grinding XP or spending more ISK. The EVE
client is not launched for development or testing.

[Full economy XP acceptance](CREW_XP_ECONOMY.md) also requires all six teams to
earn levels in one economy, checks distinct successful job IDs and interrupts
each team's first level-up before verifying recovery and its next work bonus.

[Automatic equipment reinvestment](CREW_EQUIPMENT.md) adds permanent purchased
bonuses alongside XP; both apply to new work without changing accepted jobs.
