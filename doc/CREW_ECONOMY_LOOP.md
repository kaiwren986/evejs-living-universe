# Automated economy acceptance

Run `npm run test:crew-economy` for the complete isolated economy scenario, or
`npm run test:crew` for the full crew, gateway, native integration and recovery suite.
Neither command starts the CCP EVE client. Temporary worlds are created by the
attested isolated-store helper and never open the player's database or market.

## What runs together

The scenario starts without minerals or finished goods. A finite 1,200-unit
Scordite asteroid feeds a mining crew, a refinery, and a mixed Tritanium/Pyerite
route between different stations. Two owned starter blueprints produce Iron
Charge S and civilian afterburners. Sellers retain 100 charges and one module;
buyers replenish missing minerals using realized net sales income, a policy
cap, price ceilings and a wallet reserve.

All six crew services use their normal persistent repositories, native inventory,
reprocessing taxes, industry installations/delivery, wallet mutations and market
settlement. Only the small static world, finite scene and TCP market book are
fixtures. The scenario advances virtual crew time and marks installed native
factory jobs ready to avoid waiting through production timers. Live production
times remain unchanged.

Dispatch order alternates. Every tick checks both minerals across station
hangars, miner/refiner/courier custody and installed manufacturing inputs:

`refined + bought = available + consumed by installed factory jobs`

It also checks the shared wallet:

`initial balance + net sales - purchases - factory fees - refining taxes`

The six services are reconstructed twice from persisted records. A 35-second
market interruption lowers product bids below selling floors and raises mineral
asks above buying ceilings. No purchase is allowed during that interval, and
production must recover when prices return. Finally, the test checks the actual
market supply decrements against the buyer's mineral totals.

## Faults found and fixed

- Refining stranded complete portions across small stacks left by mining
  unloads. The first full-loop run refined only 1,100 of 1,200 ore. A bounded
  selection now combines up to 32 input stacks in one atomic native inventory
  exchange, retaining source reserves and an idempotent custody receipt.
- Oversized ore and courier stacks could never be selected. Refineries now take
  capacity-limited portions; standing supply routes split loads within their
  1,000 m³ hold and preserve source reserves. The resulting custody item identity
  is recovered from the committed receipt after a lost reply.
- Procurement could spend its available income on a large Tritanium buffer
  while missing Pyerite stopped the next ammo batch. Batch shortages now take
  priority over buffer top-ups. Finished products already at their production
  targets do not trigger new mineral purchasing. Copies require sufficient
  licensed runs, and native quote failures such as missing skills or insufficient
  installation funds suspend buying until the factory can proceed.
- A temporary fee shortage disabled refinery and manufacturing standing orders.
  Refining now checks tax funding before taking ore. If a concurrent expense
  wins the debit race, native compensation returns the input, and the standing
  order waits for income and retries. Other definitive input/installation
  rejections retain their stop behavior.

Separate process tests cover uncertain partial courier reservation and both
whole-stack and fragmented refinery batches after reservation, tax debit,
mineral output, completion, remainder return and receipt acknowledgement.
Existing purchase/sale/industry crash and receipt-growth checks remain included.

## Recorded isolated result

The 240-second scenario processed all 1,200 ore into 900 Tritanium and 540
Pyerite. With adaptive priorities it produced 1,400 charges and 15 modules, sold
1,300 charges and 14 modules, and bought 483 Tritanium after the asteroid depleted.
The wallet ended at 102,489 ISK from an initial 100,000, after 3,680 net sales
income, 483 in purchases, 402 in factory fees and 306 in refining taxes. Conservation held on
all 240 ticks. These prices and timings belong to the test fixture.

Current evidence is in `_local/living-universe-audit/priority-economy-acceptance.json`
and `priority-crew-acceptance.txt`. Earlier `economy-*` and `profit-*` files retain
the preceding acceptance runs.

## Local world

The live backend retains Test Pilot's existing six crews and twelve people.
Mining, refining, mixed hauling, manufacturing, selling and buying assignments
are preserved. The buyer retains its 10,000 ISK allocation, 110 ISK mineral
ceilings and 1,000,000,000 ISK wallet reserve; it has no reason to spend while
the existing mineral stock covers production.

Current native Jita quotes give a full purchased-material margin of 12,178.08
ISK per 100 Iron Charge S and 24,767.45 ISK per civilian afterburner, after the
8% selling tax and factory fees. This is a snapshot at 100 ISK mineral asks;
price ceilings and floors remain user policy. The [shared profit guard](CREW_PROFITABILITY.md)
now blocks new manufacturing and buying when complete-batch quotes lose money.
Snapshots are in `economy-live-catalogs.json` and `economy-live-margins.json`.

Consistent world and market SQLite backups, checked with `PRAGMA quick_check`,
are recorded by `_local/living-universe-audit/economy-backup.json`. The backup
directory is `_local/backups/pre-economy-backend-20261031T200210Z/`.

After the restart, live refining advanced from 51,200 to 53,900 ore processed.
The next accepted batch combined sixteen old leftover stacks into 1,000 ore
in native custody. All twelve people and their assignments remained present.
The buyer remained at 100 ISK lifetime spend because factory stocks were ample.
Before/after snapshots are `economy-live-before.json` and `economy-live-after.json`.
No crew recovery warnings were found in `economy-backend.log`.
