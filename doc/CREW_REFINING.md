# Crew refining and the production supply chain

The headless chain is now finite belt ore → mining crew → station hangar →
refining crew → native minerals → standing courier → manufacturing inventory.
EveJS is the headless server. The CCP EVE client is not required to run these
crews or the tests. Crew people and travel remain virtual server activities.

**Follow production** now lets mining and refining choose ore for the most
profitable configured recipes and wait when mineral buffers are covered. See
[production-directed resource planning](CREW_RESOURCE_PLANNING.md) for setup,
pipeline accounting, useful portions and procurement coordination. The fixed
ore assignments described below remain available.

## Orders in X-Command

Establish a courier crew and assign miners. In **Refining crew**, choose the
mining home station, load ore recipes, select an ore and raw-ore reserve, and
start refining. A recipe can be selected before the miners return their first
load. The refinery waits for new eligible stock and repeats automatically.

The recipe preview shows the native portion size, mineral yield and ISK tax.
Station efficiency, the owner's refining skills/implants and standings use the
same quote implementation as ordinary reprocessing. Veldspar's static recipe
is 400 Tritanium per 100 ore before efficiency; at a 50% yield a 1,000-unit
batch recovers 2,000 Tritanium. Tax is paid in ISK through the wallet owner.
No invented mineral conversion or free tax exemption is used by crew orders.

Set the courier's **Material to supply** to an output mineral. Its source is
the refinery station. When replacing a raw-ore route, stop that standing order,
let the accepted trip finish, then issue the mineral route. The miners and
refiners keep working independently. Multi-mineral ores recover every fixed
output. [Automated manufacturing](CREW_MANUFACTURING.md) now adds mixed-mineral
courier groups, allowing one route to carry every refinery output in turn.

Minerals enter the owner's ordinary station hangar (flag 4). The native industry
material resolver sees and can consume them for manufacturing jobs. Blueprint
selection and automatic installation/delivery of manufacturing jobs are now
available through the manufacturing crew; see the linked guide above.

## Custody, payment and recovery

- A saved batch reserves packaged ore in a separate crew hold. Whole stacks
  remain supported. Oversized stacks and fragmented mining leftovers use a
  capacity-limited selection of up to 32 stacks, atomically exchanged for one
  custody stack with the same ore quantity. Source reserves and ownership are
  checked before custody. Mineral output does not appear during the work timer.
- Refining delegates to `reprocessingSettlementState`: the existing native tax,
  input escrow, mineral grants/delivery and input consumption protocol. It does
  not fabricate a docked pilot session or claim browser/client control.
- The reprocessing owner atomically saves a bounded per-crew completion
  watermark when removing a completed or compensated settlement. Lost replies,
  native scheduler completion and process restart cannot create a second
  operation or repeat payment for the same crew batch.
- A stack with incomplete portions returns its remainder. If the quoted tax
  cannot be paid, ore remains available and the order waits, checking every
  five seconds. A concurrent expense that causes native settlement to reject
  the debit returns reserved ore without producing minerals. The standing
  order resumes automatically when income arrives; other input rejections stop it.
- After the crew's batch history/totals are durable, the native owner retires
  that batch's inventory receipts. The completion watermark remains. Late replay
  cannot recall or recreate minerals already moved or consumed by industry.
- Pause freezes timed work and future pickups. An accepted native settlement
  may finish resolving custody. Stop finishes the reserved batch and prevents
  new pickups. Commands are idempotent, revision checked and serialized per
  owner; one command slot is kept for stopping an active assignment.

The new `refiningCrewRuntime` table belongs to `service:crew-refining`. Each pilot
has one persistent team with stable Living Universe actor IDs, a 20-entry
history, a bounded command ledger and one native completion watermark. The
registry holds at most 128 teams. At most one batch finishes per pass, with no
instant offline production backlog. Shutdown drains in-flight refinery work.

Production defaults in `config/world.json`'s `crew` section are
`crewRefiningCycleMs: 30000` and `crewRefiningBatchM3: 1000`. Jobs retain their
accepted duration and quote. Whole stacks larger than the hold wait for the
player to split them. This slice supports fixed mineral recipes from ordinary
ore at NPC stations with refining facilities. Ice, gas, randomized salvage,
structure access and refining-team skill progression remain future work.

The authorized gateway adds `/crew/refining`, `/crew/refining/options` and
`/crew/refining/orders` under `/_evejs-web/v1`. Its existing account ownership,
token, JSON and same-origin controls apply across the edge/owner protocol.

## Verification without EVE

`npm run test:crew` passes 50 tests in attested disposable worlds. The new cases
exercise the complete mining → refining → mineral haul → native manufacturing
material view; multiple mineral outputs; tax and portion rounding; reserves;
pause/stop; insufficient funds; command replay; and gateway authorization.
Separate processes recover faults after reservation, tax debit, mineral
delivery, native completion, remainder return and receipt retirement. A
100-batch run checks conservation, tax payment and bounded records. Outputs
are moved onward before retry to verify that late completion cannot reclaim
or duplicate them.

`npm run demo:x-command -- 40123` runs a disposable practice world with a finite
5,500-unit Veldspar field. It can produce 11,000 Tritanium at 50% efficiency.
Keep the original 1,000 Tritanium as the courier reserve to verify that only
newly refined minerals are shipped. Evidence is saved under
`_local/living-universe-audit/refining-*`.

## Live local acceptance (31 October 2026)

Test Pilot's refining team is active at New Caldari IV - Moon 1 - Poksu Mineral
Group Mineral Reserve (60000682). It processes Veldspar with no raw-ore reserve.
Wayfarer Logistics now carries Tritanium from there to Jita IV - Moon 4 - Caldari
Navy Assembly Plant (60003760), with no mineral reserve. Mining continues at
New Caldari II - Asteroid Belt 1.

The first mineral delivery completed at 17:38:37 UTC: 2,000 Tritanium reached
Jita. The saved acceptance snapshot records two completed refining batches,
2,000 ore consumed, 4,000 Tritanium produced, 400 ISK tax paid and six Living
Universe actors. Both refinery and supply policies remain active. The live
backend is `http://127.0.0.1:26002/x-command`; port 40120 is an older practice
world. No EVE client was launched.

The consistent pre-change world backup is
`_local/backups/pre-refining-backend-20261031T173525Z/gamestore.sqlite`.
`refining-live-started.json`, `refining-live-acceptance.json` and
`refining-live-preview.png` in the audit directory contain the live evidence.
