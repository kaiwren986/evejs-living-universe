# Adaptive production priorities

Crews now prefer the highest expected net ISK per native production hour among
ready recipes in their configured ammo/module queue. Every new batch refreshes
prices, demand, replacement mineral costs, character tax and factory fees.
The [profit guard](CREW_PROFITABILITY.md) remains mandatory.

## Choosing a batch

The planner compares each recipe's positive expected batch profit divided by its
native quoted production time, including configured runs, research and skill
effects. Ranking uses integer cents and milliseconds with exact integer cross
multiplication. Rounded hourly figures are for display only. Equal rates retain
the rotating queue order so tied recipes take turns.

Assessment does not reserve job IDs or install work for every candidate. Only
the chosen ready recipe prepares an exact native intent. That recipe refreshes
its quote before commitment; if its still-positive rate has fallen below another
ready option, the planner tries the stronger option before any expense. An
unused prepared intent has no mineral, blueprint or wallet effect. Native IDs
can have gaps after a changed quote.

Native material shortages, skills, licensed blueprint runs, fees and slots still
determine readiness. A ready lower-rate recipe can run while the top opportunity
is blocked. Finished-stock targets remain the cap, and only the pilot's selected
recipes and batch sizes participate. The crew does not acquire other blueprints
or rewrite its production/selling policies.

Once native installation begins, its saved job completes normally. Price changes
affect the next selection instead of cancelling an installed job. Selection,
quotes and the ordinary queue survive a backend restart. Eight candidates fit
inside the existing bounded crew record; no new durable owner or public mutation
endpoint is introduced.

## Responding to demand and supply

Existing unsold surplus gets first claim on the highest eligible product bids.
The next batch is valued against the demand left over, including lower price
levels. This prevents reusing a lucrative bid already needed by stock in the
hangar. Insufficient marginal demand holds that recipe and can move another
product into first place.

Procurement independently refreshes the profitable ranking. It first feeds a
configured batch shortage for the strongest opportunity, then the next recipe's
batch shortage, before larger buffers. The first mineral listed in a purchasing
policy cannot override a more profitable recipe's needs. Finished goods plus
accepted incoming output count against production targets. Incoming surplus
also counts against buyer demand when pricing further work.

Native purchase price checks, sales-income allowance, spending caps and wallet
reserves remain enforced. No extra purchase is made merely to demonstrate the
ranking when current stocks already cover the requirements.

X-Command displays the latest manufacturing ranking with batch profit, hourly
rate, native duration and readiness. It identifies the selected batch and the
current procurement priority. These are current opportunity estimates, not
reservations of future buyers or a forecast of guaranteed realized income.

## Verification without the EVE client

`npm run test:crew-priority` runs eleven native integration tests. They cover:

- A faster ammo recipe beating a module with higher total batch profit.
- Switching after price increases, demand exhaustion and replenishment.
- Unsold inventory consuming the best bid before another batch is priced.
- Ready fallback work, fixed stock caps and entirely unprofitable queues.
- Procurement priorities, price-driven mineral switches and incoming output.
- Equal-rate rotation, reconstruction of a saved job, and quote-refresh changes
  before installation with no extra fee or material consumption.

`npm run test:crew` passes all 199 crew, gateway, native integration and recovery
tests, including the complete mining/refining/hauling/production/trade loop.
The accelerated isolated loop balances minerals and the wallet every tick and
recovers from its market interruption. Test production clocks do not alter
the live backend's factory times.

Evidence is under `_local/living-universe-audit/priority-*`:
`priority-decisions.json`, `priority-economy-acceptance.json`,
`priority-crew-acceptance.txt`, live acceptance records and the dashboard preview.
Consistent world and market SQLite backups, both passing `quick_check`, are in
`_local/backups/pre-priority-backend-20261031T214719Z/`.

The first live ranked selection was native job 970000000000041: a civilian
afterburner at 24,767.45 ISK expected batch profit and 325,411.75 ISK/hour. The
previous ammo job completed normally. All twelve people survived restart, and
procurement remained at 100 ISK lifetime spend because minerals were stocked.

Mining and refining can now follow these same priorities; see
[production-directed resource planning](CREW_RESOURCE_PLANNING.md) for ore
selection, working buffers, supply forecasts and native tax checks.
