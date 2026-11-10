# Automatic equipment reinvestment

X-Command's **Reinvest in equipment** policy lets the operation buy permanent
upgrades for its mining, hauling and manufacturing teams. These are equipment
packages for the existing virtual crews, purchased from a fixed-price NPC
supplier. They do not require the EVE client.

| Equipment | Tier 1 | Tier 2 | Tier 3 | Benefit per tier |
| --- | ---: | ---: | ---: | --- |
| Mining tools | 1,000 ISK | 5,000 ISK | 20,000 ISK | 5% shorter extraction cycles |
| Hauling equipment | 1,500 ISK | 7,500 ISK | 30,000 ISK | 5% shorter travel legs, 25% larger hold |
| Factory tooling | 2,000 ISK | 10,000 ISK | 40,000 ISK | 5% shorter native manufacturing time |

Bonuses are bounded at tier 3 and apply after the crew's XP bonus, rounding up
at each step. The maximum equipment time reduction is 15%; the courier hold can
grow from 1,000 to 1,750 m³. Equipment persists through policy changes and backend
restarts. New jobs save their accepted equipment and timing; upgrades do not
change work already in progress. Industry applies the bonus only through its
private server-created crew actor capability, shared by production planning and
native factory quotes.

## When an upgrade is worth buying

The policy sets a lifetime equipment cap, wallet reserve, extra working capital,
profit share (1–50%) and maximum estimated payback (1–168 hours). Defaults are
100,000 ISK, 100,000 ISK, 10,000 ISK, 25% and 24 hours respectively. Existing
spending counts against a replacement policy's cap.

Realized operating profit is net crew sales minus mineral purchases, refining
tax and factory fees. Only the selected share of that profit can fund equipment.
The operation also preserves the larger of the equipment and procurement wallet
reserves, plus the larger of the configured working capital and three current
replacement batches. It waits while a native trade/refining/factory settlement
is unresolved, and refreshes financial state after assessing opportunities.

Each tier requires ten additional successful jobs by that team. Mining and
hauling must be doing useful production-following work; manufacturing must be
building. Current native quotes must support profitable demand. Idle or stocked
teams do not buy upgrades simply because cash is available.

Eligible next tiers are ranked by shortest estimated payback, with affordable
options considered even if a more expensive option is out of reach. The estimate
uses 5% of the best current recipe's expected profit per production hour. It is
a planning estimate, not guaranteed additional sales or a measured bottleneck
model. Demand and prices are checked again for each new investment. At most one
package is installed per pass, with a 60-second pause after a purchase.

## Payment and recovery

The authoritative equipment row saves the purchase intent before any payment.
The native wallet then debits the supplier price with a permanent receipt for
that pilot, specialization and tier. The payment is durable before the installed
tier and lifetime expense are saved. There are at most nine permanent receipts
and nine installed-package records per pilot. A missing reply or interrupted
save retries the same purchase without another charge or bonus.

Procurement subtracts installed and pending equipment costs from its sales
allowance. It refreshes that allowance after an asynchronous mineral quote, so
an upgrade accepted during the quote cannot spend the same income twice. Native
wallet checks remain authoritative for concurrent spending and reserves. Stopping
reinvestment prevents new purchases and completes an already accepted purchase.
Commands cannot set tiers, prices, bonuses or XP.

## Verification without EVE

`npm run test:crew-equipment` covers supplier payments, insufficient profits,
budgets and reserves, payback rejection, idle work, all nine tier purchases,
policy replay, malformed state, larger native cargo loads and frozen travel
timing. A lost debit reply recovers once even after 1,100 unrelated wallet
operations; separate server processes also recover the same durable debit.
Actual wallet-worker coverage also migrates a paid standalone receipt, restarts
the wallet worker and replays payment without another debit. The wallet owner
retains equipment receipts when seeding an owner record and strips nested receipt
maps from stored command results.
Gateway checks exercise token, ownership, origin and revision protections across
serialized owner IPC.

`npm run test:crew-xp-economy` now includes an upgrade-enabled cohort alongside
the original XP cohort. In 922 accelerated logical ticks, all six teams earn
levels and useful jobs apply mining tier 1, hauling tier 3 and factory tier 1.
The operation spends 42,000 ISK on equipment and ends with 384,566 ISK:

`100,000 + 460,000 net sales - 99,700 minerals - 4,550 refining tax - 29,184 factory fees - 42,000 equipment`

Every tick checks native inventory, wallet conservation, unique completion IDs,
XP, procurement limits and equipment accounting. Six first-level acknowledgement
faults reconstruct all services, including equipment. Demand exhaustion stops
new extraction, dispatch, tax, factory fees, buying and upgrades after accepted
work settles; production resumes when the market reopens.

The full `npm run test:crew` suite passes 227 cases, including 23 focused equipment
cases, 64 resource/planning scenarios and the regression
where an equipment reservation appears during a mineral quote. Test stores,
finite scenes and market demand are disposable; factory readiness is accelerated.
Live order books, stock, XP and wallet balances are never replaced by fixture
data. Evidence is under `_local/living-universe-audit/equipment-*`.

## Local activation

The local backend has reinvestment enabled with a 100,000 ISK lifetime cap,
25% profit share, 24-hour maximum estimated payback and 10,000 ISK extra working
capital. It preserves the existing 1 billion ISK procurement reserve and the
larger three-batch capital buffer. Factory tooling has reached tier 3 for 52,000
ISK total; the next one-run native factory quote is 213 seconds versus 250
seconds with XP alone. Mining and hauling stay at tier 0 while their supply
buffers are stocked. All twelve people, their XP and standing policies remain.

Read-only acceptance verifies the three permanent supplier receipts in
`walletAuthorityState`, which is the balance/receipt authority in process mode;
the world character record is a separate projection. No extra mineral purchases
were forced. Both pre-restart world/market backup pairs passed SQLite
`quick_check`. The EVE client remains closed.

[Equipment economy stress checks](CREW_EQUIPMENT_STRESS.md) combine upgrades
with shortages, price/demand shocks and paid-purchase recovery. They also cover
discarding an equipment quote when the factory or sales policy changes during
its market assessment.
