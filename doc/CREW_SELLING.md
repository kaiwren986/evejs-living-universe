# Automated surplus selling

The headless chain now continues from manufacturing into trade:
finite ore → miners → refinery → mineral courier → factory → surplus sale →
pilot wallet. Sale proceeds can pay the existing refining tax and factory
installation fees. Mining currently has no ISK fee; this change adds no wages.
The [buying crew](CREW_BUYING.md) can now allocate net sale income to missing
production minerals within stock targets, price ceilings and spending limits.
The EVE client is not needed to run any part of the loop.

## Policy in X-Command

In **Selling crew**, select the factory/delivery station and load products and
buyers. Products include owned packaged ammo/modules and the current factory's
planned products, so a policy can be assigned before their first delivery.
Select up to eight products and choose:

- **Keep in stock**: units protected in that station's ordinary personal hangar.
- **Max units per sale**: a limit on each accepted sale, not a daily limit.
- **Minimum ISK per unit**: the lowest acceptable gross bid, before sales tax.

The crew fills the best eligible local NPC buy order above the price floor.
It rotates products, skips missing demand/minimum-volume mismatches, sells
partial surplus when appropriate and waits when only the reserve remains.
There are no invented buyers or fixed vendor payouts. Bid quantities decrease
through the existing market daemon, and native market skills/tax rules apply.
This slice does not place sell listings or fill player-owned buy orders.

Set factory targets above reserves to maintain a surplus. For example, a target
of 200 Iron Charge S with a reserve of 100 lets the factory build another
100-round batch, then sell it while keeping 100 rounds. A target of two civilian
afterburners with a reserve of one works the same way. The UI shows these paired
targets and flags a factory target that cannot produce surplus.

Pause prevents new sales. Stop disables the policy. An accepted native fill
continues resolving its goods/payment and confirmation. Changing policy or
station requires stopping and finishing that accepted sale first. All income
returns to the same pilot's wallet; there is no separate virtual crew treasury.
Price floors do not calculate manufacturing profitability or buy missing input.

## Native settlement and recovery

The crew saves an exact native market fill intent before custody or payment.
The existing seeded-market sale saga reserves the chosen quantity, commits the
daemon fill using its durable idempotency key, consumes the goods, credits gross
proceeds and deducts native sales tax. Unknown replies retain that same intent.
A definitive rejected fill compensates the reservation and pays nothing.

The market owner atomically removes the pending saga and saves a bounded
per-owner completion watermark in `marketEscrow._crewSales`. Crew totals/history
are fenced before retiring native item-custody receipts. The watermark remains,
so late retries cannot recreate goods or repeat payment after receipt cleanup.
The reserve is rechecked before the first native custody effect, including after
restart. A lost reservation checkpoint can recover its escrow item from the
committed native custody receipt before compensation.

`sellingCrewRuntime` belongs to `service:crew-selling`. It supports 128 teams,
eight products per team, a 20-sale crew history and a bounded 1,024-command
ledger with a reserved stop slot. Native wallet journals and achievement
contributions retain their existing history. Commands serialize per pilot;
ticks are bounded and shutdown drains in-flight sales. The market daemon's fill
receipts remain authoritative and are not deleted by crew acknowledgement.

Lysa Rell (market agent) and Torin Voss (trade clerk) have stable Living Universe
actor IDs, station/activity information and `goods_sold` observations. Like the
other crew people they are virtual; the goods and wallet effects are native.

The same authenticated edge/owner gateway adds `/crew/selling`,
`/crew/selling/catalog?stationID=...` and `/crew/selling/orders` beneath
`/_evejs-web/v1`. `start` takes `{stationID,orders:[{typeID,reserve,batchSize,
minimumPrice}]}`; `pause`, `resume`, `stop` take `{}`. Account ownership, gateway
tokens, same-origin JSON, strict fields, revisions and idempotent command IDs
apply. Policies accept whole reserves up to 1 billion, batch sizes 1–10,000 and
unit-price floors from 0.01 to 100 million ISK with two decimal places.

## Verification without EVE

`npm run test:crew` passes 83 tests covering the complete chain and the existing crew regressions.
Selling tests use attested disposable SQLite worlds, native custody, inventory,
wallet/tax and market settlement code, plus an isolated TCP demand fixture using
the daemon's GetOrders/FillOrder/idempotency contract. Live acceptance uses the
actual running Rust market daemon and its existing buy orders.

Cases include reserves, price floors, partial demand, buyer minimum volumes,
missing/exhausted buyers, pause/resume/stop, gateway security, exact command
replay, stale revisions, changed inventory, failed completion durability and
100 repeated sales with bounded crew/custody records. Separate processes crash
after reservation, daemon fill, consumption, gross credit, tax, completion and
receipt retirement. The funding test checks native wallet conservation:
initial balance − refining tax − installation fees + net sale proceeds.

`npm run demo:x-command -- 40125` serves an independent practice world with
finite Scordite and fast fixture factories/local NPC demand. It never connects
to the player's market daemon. Audit evidence uses `selling-*` under
`_local/living-universe-audit`.

## Live local policy

The live page is http://127.0.0.1:26002/x-command. Test Pilot's selling team is
at Jita IV - Moon 4 - Caldari Navy Assembly Plant (60003760). It keeps 100 Iron
Charge S and one 1MN Civilian Afterburner, sells up to 100 rounds or one module
per transaction, and uses initial price floors of 166.27 and 30,793.16 ISK per
unit respectively. Factory targets are 200 rounds and two modules. Existing
Scordite mining, refining and Tritanium/Pyerite hauling continue independently.

The pre-change world and market backups are in
`_local/backups/pre-selling-backend-20261031T185020Z/` (`gamestore.sqlite` and
`market.sqlite`). The market snapshot was taken before the first crew sale.

Live acceptance on 31 October 2026 sold 100 surplus rounds for 16,996.08 ISK net
and one surplus afterburner for 31,477.45 ISK net: 52,688.62 ISK gross, 4,215.09
ISK tax and 48,473.53 ISK net income. The original 100 rounds and one module
remained at Jita, and the actual Rust market bids fell by exactly the sold
quantities. Ten persistent crew people appear in the universe feed.

Read-only inspection of `walletAuthorityState/character:140000001` confirmed the
live wallet equation: 999,993,071 − 885 refining tax − 46 new factory fees +
48,473.53 sale proceeds = 1,000,040,613.53 ISK. That authority is the wallet
source in the running cluster; the legacy character balance is not its current
balance. Production and selling remain active. The acceptance JSON and dashboard
PNG are `selling-live-acceptance.json` and `selling-live-preview.png` in the audit
directory. No EVE client was launched.
