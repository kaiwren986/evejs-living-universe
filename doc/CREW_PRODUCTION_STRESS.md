# Production-aware economy stress tests

`npm run test:crew-stress` runs six scenarios without the EVE client. Three are
targeted procurement regressions; three run all six crews through 1,200 total
simulation ticks. They use disposable native inventories, finite asteroid scenes,
actual reprocessing/industry/trade owners and a local market fixture. Live pilot
inventory and market orders are not changed by these scenarios.

## Problems found and fixed

Procurement could select the strongest profitable recipe even when its missing
mineral exceeded the saved buying ceiling. It then waited indefinitely despite
another profitable recipe needing a different, affordable mineral. In the
regression, Tritanium at 1.10 ISK exceeds a 1 ISK ceiling, while the factory has
enough Tritanium for ammo. The crew now buys the 21 missing Pyerite for 42 ISK
and the factory can build ammo.

A small purchasing budget could also be spent on inputs that could not complete
any batch. With a 50 ISK cap and no minerals, the old code spent all 50 ISK on
Tritanium; neither the 67-unit module recipe nor the 27 Tritanium + 21 Pyerite
ammo recipe could finish. The crew now keeps the ISK and reports insufficient
buying allowance. When Pyerite is already present, that same cap can instead
fund exactly the ammo recipe's 27 missing Tritanium.

Production-aware procurement now checks full-batch supply feasibility before
choosing a recipe. It counts current factory stock and forecast local supply,
then prices remaining inputs from eligible NPC asks under the saved ceilings.
It considers purchase batch limits, minimum lots, remaining order volume,
unspent sales income, the policy cap, wallet reserve and the native factory fee.
It tries feasible recipes in profit order, with batch gaps ahead of buffers.
An incoming top-priority batch keeps precedence until its local supply arrives;
procurement does not buy a lower recipe's minerals prematurely while that ore
pipeline is still feeding the factory.
Unfundable batches wait without a purchase. Basic adapters without a production
supply planner retain their existing partial-purchase behavior.

These assessments reserve no inventory, future market orders or ISK. The native
purchase owner still refreshes the selected ask, checks current stock and wallet
limits, and performs the only debit/delivery. Accepted purchases and installed
factory jobs retain their existing recovery rules. A later market change can
alter realized proceeds; an opportunity quote does not guarantee a future sale.

## Stress coverage and accounting

The scripted 480-tick run includes:

- A module-to-ammo price change, total bid exhaustion and demand replenishment.
- Finite mining depletion, Pyerite ask exhaustion and a Tritanium ask above its
  purchasing ceiling.
- Pausing and resuming the mineral route, a mineral price spike that makes every
  recipe lose money, and later price recovery.
- A quote outage followed by recovery and four reconstructions of all services.

Two reproducible 360-tick sequences (seeds 73 and 991) vary prices and demand,
reconstruct services once each, and restore normal markets to verify recovery.
Dispatch order rotates across the six crews. Every tick verifies native ore,
mineral and finished-product conservation, installed-job material consumption,
and the wallet after sales, purchases, factory fees and refining tax. Every
purchase is checked against its ceiling, the wallet reserve, sales income and
policy cap. New installations require a positive expected native profit.

Four settled blocked-market windows check that no further mining, deliveries,
refining tax, factory fees or purchases occur. Accepted work can finish before
these windows. During the injected quote outage, the seller's documented
`CREW_MARKET_PENDING` retry is accepted only with no sale job/custody and the
saved `market_unavailable` status. Native custody errors remain failures.

All three runs start at 100,000 ISK. The scripted run ends at 104,043 ISK; seed
73 ends at 102,900 ISK and seed 991 at 102,210 ISK. Each depletes its 400-unit
ore supply and recovers production after market conditions improve. Accelerated
test factory readiness does not alter live production times.

`npm run test:crew-resources` now covers 64 resource/courier/stress/progression scenarios.
`npm run test:crew` covers all 227 crew, gateway, native integration and recovery
tests. The earlier native buying/profit/priority regressions also pass, including
price races, native minimum lots and recovery after debit/fill reply loss.

Evidence is saved under `_local/living-universe-audit/stress-*`: the before/after
regression logs, decision records, full suite log, economy acceptance, live
snapshots and dashboard preview. Consistent world and market SQLite backups
passed `quick_check` before restarting the backend in
`_local/backups/pre-stress-backend-20261031T225016Z/`.

The local backend keeps all existing production-following modes and policy
limits. Stocked crews wait while the factory and selling loop continue. No live
mineral purchases are forced for demonstration, and the EVE client remains
closed.

[Crew progression](CREW_PROGRESSION.md) now adds completion XP and bounded time
bonuses. The stress ledger also checks that waiting, empty travel and service
recovery cannot create extra experience.

[Full economy XP acceptance](CREW_XP_ECONOMY.md) adds a 638-tick cohort that
earns levels for every team, verifies their bonuses and checks completions
against independently observed successful job IDs.
