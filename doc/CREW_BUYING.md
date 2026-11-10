# Automated production procurement

The headless loop is now minerals → factory → surplus sale → net sale income →
replacement minerals. Mining, refining and hauling keep contributing stock;
purchasing fills gaps in the configured working buffers. EveJS runs the loop
without the CCP EVE client.

Both buying and manufacturing now use the shared [profit check](CREW_PROFITABILITY.md).
Only profitable, currently needed recipes authorize mineral purchases.
Procurement follows the [current production priority](CREW_PRODUCTION_PRIORITY.md)
and counts accepted incoming output toward stock targets and demand.

Production-aware restocking now checks whether a complete batch's missing
minerals can be supplied within the current ceilings and allowance. It tries
another profitable recipe when the first cannot be funded and keeps its ISK
when none can finish. See the [full-loop stress report](CREW_PRODUCTION_STRESS.md)
for the reproduced stalls, fixes and conservation evidence.

## Policy in X-Command

In **Buying crew**, load required minerals at an active manufacturing crew's
factory. The catalog derives minerals and quantities from the queued blueprints,
run sizes and current material research. It supports personal mineral recipes
at NPC stations. A missing/exhausted/moved blueprint is not a reason to buy
unrelated material. Copies need enough licensed runs for the configured batch.
Pausing or stopping the factory suspends new purchases. Recipes whose finished
stock already meets its target do not trigger buffer purchases.

Choose up to eight minerals, with a **Target mineral stock**, **Max units per
purchase** and **Maximum ISK per unit**. The suggested targets cover five sets
of queued batches. Targets count all available mineral stacks in the factory's
hangar, including mined, refined and courier-delivered stock. The crew buys the
cheapest eligible local NPC ask below its ceiling, up to the shortage, batch
limit, actual order supply and available funding. It creates no sellers and
does not place buy listings or fill player sell orders in this slice.

Missing minerals for one queued batch take priority over buffer top-ups. While
a configured batch mineral is short, available income buys up to that batch's
shortfall before filling larger buffers. This prevents spending the last sale
proceeds on extra Tritanium while missing Pyerite keeps ammo production idle.

All three funding limits apply:

- Lifetime purchase spending cannot exceed the selling crew's realized net
  sale income. Initial pilot funds alone do not authorize buying.
- The policy's **Spending cap** is a total allocation for that policy, not a
  daily limit. Once used, the policy waits until replaced with another cap.
- **Keep in wallet** is enforced atomically by the wallet authority for each
  purchase debit. Other gameplay expenses retain their existing rules and can
  independently reduce the wallet balance.

Sale proceeds and other funds share the pilot's real wallet. The income limit
is an allocation, not a separate crew bank account: refining/production fees
still come from that wallet. Starting another policy resets its policy spend,
while lifetime buying spend remains deducted from the sales allowance. New
sales replenish that allowance. Price ceilings remain hard limits in addition
to the shared full-recipe profit check.

Pause prevents new purchases; stop disables the policy. An accepted purchase
continues confirming its debit, market fill and mineral delivery. Stop and let
that purchase finish before replacing the policy or its station. Crew totals,
remaining income, cap usage and recent purchases appear in X-Command.

## Native settlement and durability

The crew fences the exact native market intent before any debit or item grant.
The existing seeded-market purchase saga owns the ISK debit, idempotent daemon
fill, native mineral delivery and compensation for a rejected ask. Stock is
rechecked before the first debit, so an intervening mining/courier delivery can
cancel an unnecessary purchase without a net charge.

The wallet command carries the reserve and checks it inside its own serialized
mutation, after duplicate detection. A concurrent expense cannot make the
purchase cross that floor. A debit with an unknown reply is resolved with the
same command before compensation. Definitive rejections refund an applied
debit; unknown market outcomes keep their original intent and fill key.

Two per-character `crewPurchaseWalletReceipts` watermarks (latest debit and
refund) protect purchase money even after ordinary wallet receipts rotate.
Serial/key/fingerprint checks reject stale or changed replays. The wallet
authority owns these fields and preserves them across process restarts.

The market owner atomically clears the pending saga and records one completion
watermark per buyer in `marketEscrow._crewPurchases`. The crew fences totals and
history before retiring item-grant receipts. Completed purchase replay cannot
charge again or recreate minerals already moved or consumed by manufacturing.
Normal market and wallet calls keep their existing behavior when the new
purchase tag and reserve are absent.

`buyingCrewRuntime` belongs to `service:crew-buying`: 128 teams, eight mineral
rules, a 20-entry history and a bounded command ledger with a reserved stop slot.
Work serializes per character, ticks are bounded and shutdown drains purchases.
Arin Sol (procurement agent) and Keva Marr (stores coordinator) have stable
Living Universe identities and `minerals_purchased` observations. The crew is
virtual; its wallet, orders and inventory effects are native.

The authorized gateway adds `/crew/buying`, `/crew/buying/catalog?stationID=...`
and `/crew/buying/orders` under `/_evejs-web/v1`. Commands are `start
{stationID,walletReserve,budgetISK,orders:[{typeID,targetStock,batchSize,
maximumPrice}]}` and `pause`, `resume`, `stop` with `{}`. Existing token, account
ownership, same-origin JSON, strict fields, revisions and command IDs apply.
Targets allow 1–1,000,000 units; batch limits 1–100,000; ceilings 0.01–100 million
ISK; caps 0.01–1 billion ISK. Money inputs use at most two decimal places.

## Verification without EVE

`npm run test:crew` includes the complete economy loop. Purchase coverage includes native demand and
supply, income gating despite a funded pilot, policy caps, wallet floors with a
concurrent expense, partial purchases, price ceilings, new mineral arrivals,
pause/stop/factory suspension, strict policies, exact replay and gateway IPC.
The closed-loop test produces and sells a module, buys missing Pyerite from that
income, resumes ammo manufacture, sells the ammo and balances the shared wallet.

Separate processes crash after debit, daemon fill, mineral delivery, completion,
acknowledgement and refund. Tests move delivered minerals onward before recovery.
A 100-purchase test checks conservation and bounded crew/market/wallet records.
Replacing a policy cannot reuse previously spent sales income, and a lost debit
confirmation before filling an ask refunds exactly once.

`npm run demo:x-command -- 40126` uses a disposable world, fast fixture factories
and isolated TCP market demand/supply. It never contacts the player's market
daemon. Browser acceptance verified catalog defaults, purchase execution,
pause/resume, reload and repeated production restocking with no console errors.

## Live local acceptance

Test Pilot's buyer is active at Jita IV - Moon 4 - Caldari Navy Assembly Plant
(60003760). Working targets are 470 Tritanium and 105 Pyerite (five sets of the
current ammo/module recipes), with matching per-purchase batch limits and
110 ISK per-unit ceilings. The policy cap is 10,000 ISK and the wallet reserve
is 1,000,000,000 ISK, protecting the original pilot balance. Current mining and
hauling stocks exceed these targets, so the policy is waiting with buffers full.

A temporary single-unit buffer verified a real purchase against the running Rust
daemon: one Pyerite for 100 ISK. The actual ask supply decreased by one, hangar
stock increased by one, and the wallet authority recorded a matching debit.
The temporary policy was stopped and replaced with the standing five-batch
buffers; lifetime spent remains 100 ISK and is still deducted from sale income.
The buyer does not need further spending while the current buffers are stocked.

The live page is http://127.0.0.1:26002/x-command. Pre-change world and market
backups are in `_local/backups/pre-buying-backend-20261031T193109Z/`.
Evidence is under `_local/living-universe-audit/buying-*`, including
`buying-live-acceptance.json` and `buying-live-preview.png`. No EVE client was
launched.
