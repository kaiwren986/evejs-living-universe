# Public EveJS Market Seeder v3

`market-seederv3` builds the standalone market-server SQLite database with a **Jita-only
index seed priced from the game's own manufacturing cost**.

v1 (`tools/market-seed`) seeds synthetic prices universe-wide from each type's SDE
`basePrice`; v2 (`tools/market-seederv2`) imports the real Tranquility order snapshot. v3
does neither: it works out what every T1 item costs to *build*, bottom-up through its own
blueprint tree, sells it at 3x that cost and buys it back at 1x, at Jita 4-4 and nowhere
else, from a **permanent price manifest committed to this repo**. Same input, same
database, on every machine, forever.

On top of that it lays the **TQ NPC catalog overlay**: T1 blueprint originals, skillbooks,
PI command centers and trade goods, imported from a cached Tranquility order snapshot at the
stations, prices and volumes TQ actually uses. Two passes, one database — the overlay
universe-wide first, the index seed at Jita 4-4 second and on top, because both write the
same `(station_id, type_id)` key and our computed price has to win where they collide.

Last, it fills `price_history` with a month of synthetic chart per seeded type, drifted
around the price that type actually sells for, so the client's market charts are not empty.

## The Friendly Version

Double-click:

```text
tools\market-seederv3\BuildMarketSeedV3.bat
```

Choose `[1] Build the Jita index seed`. When it finishes, restart the market daemon
(`StartMarketServer.bat`) — the daemon holds the old database open and will not notice the
new one until it does.

If the generated local authority data is missing, the launcher runs
`tools\DatabaseCreator\CreateDatabase.bat` first.

## The Normal Workflow

Run them in this order. Everything except `refresh-prices` is offline and read-only;
only `build` writes the database.

| Step | Command | What it answers |
|---|---|---|
| 1 | `doctor` | Can the seeder find its config, its static data and its manifest? Does the seed station resolve? |
| 2 | `classify` | Which types are in the seed universe, and which rule removed the rest? |
| 3 | `refresh-prices` | What still has no captured price, and what do the Jita snapshot split and one ESI fetch fix? (**the only step that needs network**) |
| 4 | `cost` | What does each seeded type actually cost, where did that number come from, and what is still unpriced? |
| 5 | `snapshot-info --download --reuse-download` | Cache the TQ order snapshot the NPC overlay imports. (**the only other step that needs network**) |
| 6 | `audit` | Can a player turn a seed-bought item back into more ISK than they paid — including by simply hauling it? |
| 7 | `build` | Write it. |

On a fresh clone step 3 is optional: the price manifest is committed, so you can go
straight from `classify` to `cost` and build with no network at all. Run `refresh-prices`
when the SDE moves, when you change the cost model, or when `cost` reports something you
want priced that has no capture yet.

Direct CLI, from the crate directory:

```powershell
cd tools\market-seederv3
cargo run --release -- --config config/market-seederv3.local.toml doctor
```

`--config config/market-seederv3.local.toml` is also the built-in default, so you can drop
it. For automation, `build --yes` skips the interactive prompt and `build --dry-run`
resolves the whole plan and prints exactly what it would write without touching anything.
A dry run still streams the cached snapshot, because the seed plan depends on which types
the NPC catalog seeds; `--skip-overlay` is the way to skip that.

### `snapshot-info` — the TQ snapshot

This is the subcommand that resolves the latest EVE Ref market-order snapshot and reports it
without downloading anything: name, URL, size, publish time, etag, and whether a matching
file is already in the cache.

```powershell
cargo run -- snapshot-info                              # report only, one HTTP GET
cargo run -- snapshot-info --download                   # fetch it into cache/
cargo run -- snapshot-info --download --reuse-download  # reuse a cached file of the right size
```

Downloads land in `[source] download_dir` (`cache/`, gitignored) under an etag-stamped name,
streamed to a `.part` file and renamed only when complete, so an interrupted run cannot leave
a half-file behind for `--reuse-download` to trust. Whenever a local file is available the
command also opens the bzip2 stream, reads **just the CSV header row**, and confirms the
columns the importer will need are there — the cheap way to catch an HTML error page or a
renamed column before an hour-long import does.

**`build` never downloads.** It uses whatever this command last cached, picking the newest
`.bz2` in `[source] download_dir`, and stops with instructions when there is none — a build
has to stay offline and reproducible, so a missing snapshot is a stop and not a silent fetch.
`build --skip-overlay` builds the Jita 4-4 index + junk seed alone if you want a database
without the NPC catalog.

## The Price Manifest

```text
tools/market-seederv3/data/price-manifest.json
```

It is **committed on purpose** and it is not build output. It holds one resolved price and
its provenance for every seeded type — today 4,771 entries, 2,464 of which carry a CCP
capture record, stamped with `sdeBuild 3396210` and the cost model and pricing rules that
produced it.

Today's sources:

| source | entries | meaning |
|---|---|---|
| `cost-recursive` | 2,308 | computed bottom-up from the blueprint tree |
| `ccp-esi-average` | 1,942 | captured from ESI `markets/prices` `average_price` |
| `ccp-snapshot-jita-split` | 239 | captured from Jita's own top-of-book in the TQ order snapshot |
| `derived-compressed-twin` | 165 | taken from the other half of a compression pair |
| `reprocessing-floor` | 117 | lifted so the ask covers what the item refines into |
| `base-price` | 0 | SDE `basePrice` fallback — nothing needs it today |
| `ccp-esi-adjusted` | 0 | recorded, never spent (see rule A below); 3 ride along in `retainedCapture` |

### Two capture sources, snapshot first

Plan §4.2 has two, and decision 6 fixes the order:

1. **`ccp-snapshot-jita-split`** — the Jita order book, read out of the same ~20 MB TQ
   snapshot the NPC overlay imports. `refresh-prices` streams it, keeps the minimum ask and
   maximum bid per type for `[price_manifest] reference_solar_system_id` (30000142, Jita),
   and prices the type at the **split**: `(min_ask + max_bid) / 2` when both sides are
   quoted, the side that exists when only one is, and nothing at all when neither is.
2. **`ccp-esi-average`** — one unauthenticated `GET /markets/prices/`, the gap-filler for
   types with no live Jita order.

The harvest deliberately runs **before** `[import] order_filter`, unlike v2's
(`tools/market-seederv2/src/main.rs:1237-1258`), which sits behind it. Under the default
`npc_only` the filter keeps TQ's NPC orders and drops every player order — 333,268 of the
334,974 orders standing in Jita — and a "Jita price" harvested from what survives that would
be a handful of fixed NPC prices wearing a market price's label. `order_filter` therefore
governs which snapshot rows become overlay seed rows and cannot move one captured price;
`overlay::tests::order_filter_cannot_change_one_reference_price` replays the same orders
through all five modes and proves it.

If no snapshot is cached, the source is **skipped with a log line, not an error**, and ESI
runs behind it — `refresh-prices` has to stay usable offline against an already-complete
manifest. (`build` and `audit` still stop on a missing snapshot: there the whole NPC catalog
would be silently absent from the database.)

**Captured prices are permanent.** Once a type has a CCP price, `refresh-prices` never
fetches it again; it only recomputes the local half and fills genuine gaps. That holds
across sources, which is what made adding the snapshot capture safe long after ESI had
already captured 2,295 types: the run that introduced it wrote 169 new captures, rescued 3
unpriceable index types and 187 uncaptured junk types, and repriced **zero** of the 2,202
market captures already on disk. The one way a capture moves is `--force-refetch <spec>`,
where the spec is a comma-separated list of type IDs and/or the words `a`, `b`, `d`,
`leaves`, `all`. That is deliberate: the seeded economy does not drift with Tranquility, and
any change to it shows up as a reviewable diff.

The one exception is not an exception to that rule: a type holding only a `ccp-esi-adjusted`
record has no captured *price* — rule A never spends CCP's industry index — so it stays on
the shopping list, and the first real market price for it is a first capture rather than a
refetch. 90 of those were filled by the Jita split.

Because the manifest is committed, **a build needs no network at all** — there is no HTTP
in the build path. `refresh-prices --from-file <path>` replays a saved ESI-shaped JSON
payload for air-gapped machines and reproducible reruns, and `--dry-run` reports what would
change while leaving the file byte-identical.

## The Audit Is A Gate

```powershell
cargo run --release -- --config config/market-seederv3.local.toml audit
```

`audit` is the only subcommand with a meaningful exit code: **1 if any loop lets a player
print ISK**, 0 if none does. Run it before every build and treat a non-zero exit as a
failed build.

It matters because the seed has no counterparty and no depth limit. Every row carries
2,147,483,647 units and seed bids mint ISK out of nothing, so a loop that returns 1.01x is
not a rounding artifact — it is an infinite money faucet that runs until someone notices.
The audit checks four loop shapes across all buckets: **reprocess** (buy at the ask, refine,
sell the minerals into seed bids), **manufacture** (buy the inputs at seed asks, build, sell
into the product's own bid), **compression** (buy one side of a compressed/uncompressed pair,
sell the other), and **cross-station** (buy at the cheapest seeded ask anywhere, haul it, sell
into the best seeded bid somewhere else). It evaluates at perfect refine, which is the worst
case for the seed, and applies the 8% transaction tax.

Every price the audit uses is the **best price anywhere**, not the Jita row: with the NPC
overlay seeding ~5,000 stations a player will always take the better of the two, and every
violation names the station each of its prices came from. Check 4 exists because the first
three all look for a *transformation*, and hauling is not one — over an overlay-shaped book a
clean run of 1-3 alone would be false confidence.

**Every violation says who owns its legs**, because that decides whether it is ours to fix:

- **seeder-involved** — at least one leg is an index or junk row, a price this seeder
  computed. Always gates the build.
- **npc-to-npc** — every leg is an NPC overlay row: TQ selling a trade good in one station
  for less than TQ buys it back in another. Nothing of ours produced it and no multiplier of
  ours can close it; the only way to remove it is to discard or reprice NPC rows CCP ships,
  which would undo the plan's TQ-authentic placement (decision 2). Reported in its own
  section under check 4, and gated only when `[import] gate_on_npc_arbitrage = true`.

Both counts print in the verdict on every run, whichever way the knob is set, so the
inherited residue is never invisible.

Today, against a full build: checks 1-3 are **clean** (zero positive loops), and check 4
reports **26 cross-station loops, all of them npc-to-npc and none seeder-involved**, so the
audit exits 0. The 12 seeder-involved loops that existed before piece 11 (worst x165.7:
our 30,180.00 Jita ask on the Element Containment Vessel against a 5,000,000.00 NPC buyback
at K-MGJ7) are gone at the source — `[index_seed] defer_to_npc_catalog` drops the **one side**
of ours whose price would cross TQ's, so the two price bases never meet on a leg that pays.
That is check 4's own condition, evaluated at build time, which is why the seeder-involved
count is zero by construction rather than by luck. Set `gate_on_npc_arbitrage = true` to make
the remaining 26 fail the build instead.

The audit reports and never repairs. Closing a loop is a human decision, and three config
rules are what currently hold the line:

- **`reject_adjusted_price_captures`** — ESI's `average_price` is the only field accepted as
  a market price. `adjusted_price` is CCP's internal industry index, not a trade; rows
  carrying only that are recorded as `ccp-esi-adjusted` so they are visible and never
  refetched, and they price nothing.
- **`derive_compressed_from_source`** — both halves of a compressed/uncompressed pair take
  the same per-unit price, because this game compresses 1:1 and both sides refine
  identically, so any gap between them is arbitrage by construction (166 of 212 pairs
  disagreed before this rule, the worst by x336).
- **`floor_cost_at_reprocessing_value`** — a type is worth at least what it refines into, so
  its cost is lifted until its **ask** covers what the seed's own bids would pay for its
  reprocessing outputs, iterated to a fixpoint. Flooring against the raw material value
  instead would overshoot threefold, because the player buys at the ask and not at cost.
  104 types are lifted today, the largest by x81.6.

Above those sits `[index_seed] leaf_price_source`, default `capture-first`: a leaf costs the
same real market price the seed charges for that leaf. Flip it to `base-price-first` to
price leaves from SDE `basePrice` instead and re-run `cost` and `audit` to compare the two.
`base-price-first` is kept for measurement only — it re-opens the seam the audit found.

## Safety Rails

- **Quantities above 2,147,483,647 are rejected, not clamped.** The EVE client marshals
  `volRemaining` as an int32 and throws above it, so the config parser refuses the value
  rather than silently shipping a book the client cannot render.
- **The price floor lifts asks only and never bids.** `ask = max(price_floor, round2(3.0 x
  cost))`, `bid = round2(1.0 x cost)`. A floored bid is a money pump: Tritanium costs 3.78
  ISK today, so a 100 ISK floored bid would pay 26x cost for it and every cheap mineral
  would open the same loop. Today 137 of 4,571 asks sit at the floor and 0 bids do, by
  design. Both sides are additionally clamped above 0.00 so no row is ever free.
- **`[index_seed] max_unpriced_drops` (default 25) fails the run.** A type with no price is
  dropped and named, never guessed at — but a missing, stale or truncated manifest would
  drop *hundreds* and silently seed almost nothing. Above the budget the build stops and
  says how many. Today 5 index types drop (permanently unpriceable event/exclusive items)
  against a budget of 25.
- **`bid <= ask` per type** is re-asserted in SQL inside the write transaction, so a bug in
  the writer aborts the build instead of leaving a crossed book behind.
- **`price_history` is re-checked in SQL inside its own write transaction too.** Row count
  equals types x days, every type carries the full series, days are distinct and contiguous,
  and every row satisfies `0 < low <= avg <= high` with a positive volume and order count. A
  build that would write fewer than 2 days is refused outright, because that is an empty
  chart wearing a full table's clothes.
- **`[index_seed] defer_to_npc_catalog` (default `"conflicting-prices"`) stands one *side*
  down where TQ's price would cross ours.** Our computed price meeting TQ's fixed NPC price
  for the same type at another station is a haul loop, and it is not closeable by any
  multiplier — the other leg is a price we do not set. But it is only a loop when the prices
  actually cross, so that is the whole test, asked per side:

  - our **ask** goes when `our_ask < best NPC bid` (buy from us, haul, sell into TQ's
    buyback);
  - our **bid** goes when `our_bid > best NPC ask` (buy from TQ, haul, sell into us).

  The comparison is the strict untaxed crossing, not the 8%-tax-adjusted one the audit gates
  on, so marginal loops are dropped too. Today **36 sides defer: 7 asks, 29 bids, and no type
  loses both** — against 340 whole types under the old all-or-nothing rule. Deferrals are
  counted by side and sampled by name with both prices in the build report; they are **not**
  drops for want of a price and never count against `max_unpriced_drops`.

  `"whole-type"` is the old rule (drop both sides whenever the overlay touches the type at
  all) and `"off"` defers nothing; the old booleans still parse, `true` as `"whole-type"` and
  `false` as `"off"`. With `--skip-overlay` there is no catalog to defer to and nothing is
  deferred.

## What Gets Seeded

Measured on SDE build 3396210, from a full `build` with the overlay:

```text
4,571 seedable types -> 9,106 seed rows, all at Jita 4-4 (60003760)
  composition : A 2,163 | A+B 183 | B 666 | D 1,559
  not seeded  : 5 unpriced index, 217 uncaptured junk, 0 deferred on both sides
  deferrals   : 7 asks + 29 bids stood down for the NPC catalog (4,564 asks + 4,542 bids)
  quantity    : 2,147,483,647 on every row
```

`--skip-overlay` defers nothing and writes both sides of all 4,571 types — the difference is
exactly the 36 sides where TQ's price crosses ours.

The candidate buckets behind those numbers (`classify`):

- **A — manufacturable T1: 2,350.** Ships, modules, charges, drones, fighters, containers,
  deployables, POS gear, Upwell structures and modules, boosters, components. Priced at
  3x/1x their computed build cost.
- **B — ores, minerals, materials: 850.** Ores (raw and compressed), minerals, ice
  products, moon materials, intermediates and composites, fuel blocks, salvage, PI P0-P4,
  reagents. 183 of these are also in A and take the computed cost.
- **D — market-priced junk: 1,776 candidates.** Named/meta modules 542, junk commodities
  1,171, charges 44, drones 19. Seeded **only** where the manifest holds a captured market
  price; 217 have none today. All 36 of the sides deferred to the NPC catalog are bucket-D
  trade goods, which is where our cost model and TQ's fixed prices actually collide.
- **C — the TQ NPC catalog**, from the snapshot rather than from any rule of ours: **1,790
  T1 blueprint originals, 469 skillbooks, 8 planetary command centers** and the trade goods
  NPCs buy back, at TQ's own stations, prices and volumes. A full build imports 547,772
  overlay rows (467,807 asks + 79,965 bids) across 5,074 stations and 2,617 types out of
  1,612,535 snapshot rows.

Deliberately **never** seeded by the *index* pass: T2 and T3 products *and* their blueprint
originals, faction/storyline/officer/deadspace gear (metaGroup >= 3), implants and
hardwirings, relics and decryptors, SKINs, apparel and special-edition commodities, PLEX,
injectors and expert systems, corvettes. Blueprints and skills are excluded as whole
categories from the index buckets because they belong to the NPC overlay, which seeds them
at TQ's prices instead.

Anchor to sanity-check a build: the Venture (32880) costs 252,906.50, so it asks
758,719.50 and bids 252,906.50.

## Price History (So The Charts Are Not Empty)

`price_history` used to come out of a v3 build with **zero rows**, which is why every market
chart in the client was blank. The build now writes `[history] days` of synthetic chart —
30 by default — for **every type with any seed row**:

```text
206,970 rows = 6,899 types x 30 days, 2026-07-12 .. 2026-08-10 UTC (ends today)
  types by mechanism : 3,012 index, 1,559 junk, 2,328 overlay
  base price         : the best seeded ask ANYWHERE, drifted ±5% on (type_id, day)
  bid fallback       : 59 types have no ask anywhere and chart around their best bid
```

- **The base is the price a player actually pays**: the best ask across all stations, taken
  from the same book the audit prices its checks off. Index rows, junk rows *and* the TQ NPC
  overlay, so BPOs and skillbooks get charts too — the anchor to check is the Bantam
  Blueprint (683), which no rule of ours prices and which charts around TQ's 2,550,000.00
  ask. A type nothing sells anywhere falls back to its best bid. A type with **no seed row
  at all gets no history**: the seeder does not invent prices, and a chart for an item no
  station sells would be exactly that.
- **One series per type, and that is the whole table.** `price_history` is keyed
  `(type_id, day)` with no station or region column, and the daemon serves it with
  `WHERE type_id = ?` and no filter (`state.rs:2119-2149`). Asks are per station, but since
  the table cannot express a per-station series there is nothing to reconcile.
- **The drift is deterministic**, `(((type_id * 37 + day_offset * 13) % 101) - 50) / 1000`,
  ported from v1 (`tools/market-seed/src/main.rs:1326-1418`). Two builds on the same day
  produce identical charts, so a rebuild does not read as a market event.
- **Two days is the floor.** The Node proxy splits the daemon's rows into "old" (all but the
  last) and "new" (the last) in `splitHistoryRows`
  (`server/src/services/market/marketProxyService.js:429-447`), so a one-day table leaves the
  client's history half empty. `days = 1` is refused at build time; `days = 0` is legal and
  writes nothing.
- **It cannot move a price.** History is derived from the finished book and feeds nothing.
  `audit` output is byte-identical with `days = 30` and `days = 0`.
- Cost: about **11.1 MiB** on a full build (105.31 -> 116.44 MiB), ~56 bytes a row.

## The Build Is Offline And One-Shot

`build` rewrites `market.sqlite` **wholesale**. It is not an update.

- It writes the static tables (40 regions, 8,490 systems, 5,210 stations, 52,590 market
  types), then the **NPC overlay** into `seed_stock` / `seed_buy_orders`, then the **index +
  junk seed** over the top of it, then the region and system summaries, then `price_history`,
  then the manifest rows. A full build lands 472,370 asks, 84,454 bids and 206,970 history
  rows in ~116 MB.
- **The pass order is load-bearing.** Both passes write the same `(station_id, type_id)` key
  and the index pass uses `INSERT OR REPLACE`, so running it second is what makes our
  computed price win at Jita 4-4 — TQ sells index-seeded types there too. Reversed, the
  snapshot's price would replace ours with no error and no row-count change, so the build
  re-reads every planned price back out of SQL before it commits and fails if it ever
  happens.
- **`market_orders` and `market_order_events` come out empty, and `price_history` is
  regenerated.** Every player order and every event in the old database is gone, and the old
  charts are replaced by a fresh 30 days ending on the build date. This is the real cost of
  seeder-only reseeding: schedule rebuilds, do not do them casually.
- The build stages into `market.sqlite.building` and never opens the live file. On install
  the live database is *moved* to `market.sqlite.previous`, the staged file is renamed into
  its place, and the backup is deleted only once that rename succeeds. If anything fails,
  the backup is put straight back and the daemon's database is exactly where it was — so
  `.previous` is a rollback path during the install, not a backup you will find afterwards.
- An existing database is never replaced without typing `OVERWRITE` at the prompt, or
  passing `--yes`.
- **Restart the market daemon afterwards.** It holds the old file open and will keep
  serving it until it is restarted.

**Re-seeding means re-running the seeder.** There is no daemon-side restock, no restock RPC
and no schema change to support one. A rebuild rewrites every seed row at full quantity, so
the rebuild *is* the restock. At 2.1 billion units per row, depletion between rebuilds is
not a practical concern.

## Trying A Build Before You Install It

You can point the real market daemon at a candidate database and confirm it loads and
serves, without touching the live one. Build somewhere harmless first — copy the config and
change `[output] database_path` — then:

```bash
externalservices/market-server/target/release/market-server.exe --config <scratch>.toml doctor
```

`doctor` is read-only and binds no ports. It is the same validation the docker rebuild runs
on a candidate before promoting it. Exit 0 means the schema, manifest and summaries are all
readable. Against a full v3 build it warms about 48,000 region-summary rows across 38
regions and reports the seed and history row counts.

To watch it actually serve, run `serve` with a scratch config — **and change both ports**,
because a running daemon already holds 40110 and 40111 and a second instance on the same
ports will fail or fight it. With `[network] port = 40120` and `[rpc] port = 40121`:

```bash
curl http://127.0.0.1:40120/v1/orders/10000002/32880
```

That is the Venture's order book in The Forge. A correct v3 build answers with one sell at
`758719.5` and one buy at `252906.5`, both `"source":"seed"`, `vol_remaining` 2147483647,
`range_value` 32767 and `duration_days` 3650, at station 60003760. `/v1/history/32880`
returns the 30 charted days and `/v1/summaries/station/60003760` the whole Jita book.

**Stop the scratch daemon when you are done** — it holds its database open, and a stray
copy on an odd port is easy to forget about.

## In Docker

The container image ships the v3 binary and this crate's committed price manifest, so a
deployment seeds the same economics a developer machine does. Stop the runtime first — a
rebuild is an offline operation and takes an exclusive lock on the market database:

```powershell
docker compose stop server market
docker compose run --rm --no-deps market-tools rebuild v3
docker compose start market server
```

`rebuild v3` runs the whole sequence for you, against `docker/market-seed-v3.toml`:

1. `snapshot-info --download --reuse-download` — an explicit step, because `build` never
   downloads. If the snapshot cannot be fetched the rebuild stops there rather than seeding
   without the NPC catalog. Add `--fresh-download` to ignore the cached snapshot.
2. `build --yes` into `market.sqlite.candidate`. The live database is never opened.
3. `audit` — **the gate**. A non-zero exit aborts the rebuild and the candidate is not
   installed, because a seed players can turn back into more ISK than it cost must never be
   promoted. The live database is left exactly as it was.
4. The shared candidate machinery every engine uses: validate the candidate with
   `market-server doctor`, back the live database up, install, re-validate, and roll the
   backup back automatically if the installed database fails validation.

Extra arguments go to `build`, so `rebuild v3 --skip-overlay` works and the audit is told
about it too. `--dry-run` is refused there — a rebuild installs what it builds; run the
seeder directly for a preview.

`docker/market-seed-v3.toml` is this crate's local config with container paths and lower
build tuning, and nothing else: every pricing knob is identical, so a deployment cannot
quietly seed different economics. Changing it needs an image rebuild.

## Config File

```text
tools/market-seederv3/config/market-seederv3.local.toml
```

`market-seederv3.example.toml` beside it documents every key, and every value in it is also
the built-in default, so an empty config behaves identically. The knobs worth touching:

| Key | Default | Why you would change it |
|---|---|---|
| `[input] static_data_dir` | `../../_local/gameStore/data` | Point at generated authority data somewhere else. Falls back to `EVEJS_GAMESTORE_DATA_DIR` when the key is absent. |
| `[output] database_path` | `../../externalservices/market-server/data/generated/market.sqlite` | The path the market daemon reads by default. |
| `[index_seed] station_id` | `60003760` | Jita IV - Moon 4 - Caldari Navy Assembly Plant. Seed rows are region-visible, so all of The Forge sees them. |
| `[index_seed] sell_multiplier` | `3.0` | The ask markup. Raising it makes seeded goods dearer; lowering it toward 1.0 narrows the band player industry lives in. |
| `[index_seed] buy_multiplier` | `1.0` | The bid. Raising it above 1.0 is how you build a money pump — run `audit` if you touch it. |
| `[index_seed] quantity` | `2147483647` | The int32 ceiling. Higher is rejected. |
| `[index_seed] price_floor` | `100.0` | Ask-only minimum, so the seed does not sell items for fractions of an ISK. |
| `[index_seed] max_unpriced_drops` | `25` | The systemic-failure guard. Raise it only deliberately, after reading which types are dropping. |
| `[index_seed] defer_to_npc_catalog` | `"conflicting-prices"` | Drop only the side of ours whose price crosses TQ's: the ask when it is under TQ's best bid, the bid when it is over TQ's best ask. `"whole-type"` is the old all-or-nothing rule (both sides gone whenever the overlay touches the type); `"off"` lets both mechanisms price the same type again, which is how the piece-11 haul loops came back. The old booleans parse as `"whole-type"` / `"off"`. |
| `[index_seed] pricing` | `"recursive"` | `"shallow_eiv"` reproduces the server's one-level job-tax EIV instead, for parity diffing. |
| `[index_seed] leaf_price_source` | `"capture-first"` | `"base-price-first"` for comparison runs only. |
| `[junk_seed] enabled` | `true` | `false` drops bucket D entirely (1,559 fewer seeded types). |
| `[history] enabled` | `true` | `false` writes `price_history` empty, which is the pre-piece-12 behaviour: every market chart in the client comes up blank. |
| `[history] days` | `30` | Calendar days of synthetic chart per seeded type, ending today UTC. `0` writes nothing; `1` is refused (it leaves the client's "old" history half empty); the ceiling is `3650`. Each day is ~6,900 rows and ~56 bytes a row. |
| `[junk_seed] categories` | `["modules", "commodities", "charges", "drones"]` | Which junk categories are eligible at all. |
| `[price_manifest] path` | `data/price-manifest.json` | Relative to the crate directory. |
| `[price_manifest] capture_missing_from_snapshot` | `true` | `false` makes `refresh-prices` skip the Jita split and leave ESI as the only capture source. |
| `[price_manifest] reference_solar_system_id` | `30000142` | Whose book the Jita split reads. A **system**, not a station — the whole Jita book, harvested before `order_filter`. |
| `[price_manifest] capture_missing_from_esi` | `true` | `false` makes `refresh-prices` never call ESI. |
| `[source] index_url` | `https://data.everef.net/market-orders/index.json` | Where `snapshot-info` looks for the latest TQ order snapshot. |
| `[source] download_dir` | `cache` | Where `snapshot-info --download` puts the ~20 MB snapshot. Relative to the crate directory, and gitignored. |
| `[source] user_agent` | `PublicEveJS market-seederv3/0.1` | Sent on the index and snapshot requests. |
| `[import] order_filter` | `"npc_only"` | Which snapshot orders the overlay imports. `"player_only"` and `"all_station"` also work; the two `market_scope` modes are refused, because v3 has no scope config for them to read. |
| `[import] npc_order_duration_threshold_days` | `90` | An order is treated as an NPC order when its duration exceeds this. 90 is the longest a player can place, so it is the whole signal. |
| `[import] gate_on_npc_arbitrage` | `false` | Whether audit check 4 fails the build on a haul between two NPC stations. Those are TQ's own fixed prices, imported verbatim; they are always reported, and this decides whether they also gate. |

## If Rust Is Missing

The launcher says so and stops. Run `tools\InstallRustForMarket.bat`, then run it again.

## Further Reading

- [../../doc/JITA_INDEX_SEED_PLAN.md](../../doc/JITA_INDEX_SEED_PLAN.md) — the design, the
  measurements behind every number above, and the decision record
- [../../doc/MARKET_SETUP.md](../../doc/MARKET_SETUP.md) — running the market daemon
- [../market-seederv2/README.md](../market-seederv2/README.md) — the TQ snapshot seeder,
  which is still the only way to get NPC blueprints and skillbooks
