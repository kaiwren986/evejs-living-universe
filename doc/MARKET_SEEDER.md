# Market Seeder Guide

This guide explains the tools that build the optional standalone market database.

There are four seed types. They all write the same kind of database for the same market server, so you pick one and run it.

- `v1`
  Works prices out from the static data's own base prices and seeds many stations at once. Fully offline. The prices are invented.
  Launcher: `BuildMarketSeed.bat`
- `v2`
  Downloads the real Tranquility market snapshot and imports it, so stations, prices and volumes mirror the live game.
  Launcher: `tools\market-seederv2\BuildMarketSeedV2.bat`
- `v3`
  Builds a Jita 4-4 trade hub priced from what things cost to make, and lays the real Tranquility NPC catalog underneath it.
  Launcher: `tools\market-seederv3\BuildMarketSeedV3.bat`
- `v4` — Iron Man
  Seeds only authentic NPC station orders: BPOs, skillbooks, command centers, trade goods and other NPC stock, including NPC buybacks. Players obtain everything else through gameplay and industry.
  Launcher: `tools\market-seederv4\BuildMarketSeedV4.bat`

`BuildMarketSeed.bat` in the repo root lists all four seed types with descriptions
and opens the builder you choose. Each builder also has its own launcher under `tools`.

## What A Seeder Does

The seeder builds the market database used by the standalone market server.

In plain English:

- no seed database = no useful standalone market
- a fresh seed database = the standalone market has stock and data to serve

## v1: The Easiest First Build

Double-click:

```text
BuildMarketSeed.bat
```

Choose `[1] v1 - Synthetic starter market`, then choose:

```text
Jita + New Caldari
```

That is the best default build for most people.

It is much faster than a full-universe build and still gives you a realistic market area to test with.

## v1: The Main Options

Choose v1 in the root `BuildMarketSeed.bat` menu to open the synthetic seed builder
window. Its buttons are:

- `Full Universe`
  Biggest build. Takes longer and creates a much larger database.
- `Jita + New Caldari`
  Best first choice. The window marks it as recommended.
- `Quick Smoke Test`
  Tiny test build used mostly for fast checks.
- `Rebuild Summaries`
  Refreshes summary tables without doing a full reseed.
- `Doctor`
  Checks the current market seed/database state.
- `Show Presets`
  Lists every preset the seeder knows about.
- `Build Release`
  Compiles the seeder binary and nothing else.

There is also a plain text menu at:

```text
tools\market-seed\BuildMarketSeed.bat
```

It offers the same builds, plus `Edit market seed config` and `Open seeder README`.

## v1: Where The Config Lives

The config file is:

```text
tools\market-seed\config\market-seed.local.toml
```

That is the file you edit if you want to change how the seeder behaves.

## v1: How To Turn On Seeded Buy Orders

Open:

```text
tools\market-seed\config\market-seed.local.toml
```

Find:

```toml
seed_buy_orders_enabled = false
```

Change it to:

```toml
seed_buy_orders_enabled = true
```

Then build the seed again and restart `StartMarketServer.bat`.

## v1: What Happens If I Run It Again?

Running a full build again replaces the previous generated market database with a new one.

It does not stack a second seed on top of the first.

## v2: The Tranquility Snapshot Seeder

Double-click:

```text
tools\market-seederv2\BuildMarketSeedV2.bat
```

The menu is:

- `Build latest TQ station-market snapshot`
  The normal build. Fetches the snapshot and imports it.
- `Snapshot info only`
  Tells you which snapshot is published right now, without building anything.
- `Doctor`
  Inspects the database that is there already.
- `Build release binary only`
  Compiles the seeder and nothing else.
- `Edit v2 config`
  Opens the v2 config file in Notepad.

The config file is:

```text
tools\market-seederv2\config\market-seederv2.local.toml
```

What makes it different: nothing is invented. Stations, prices and volumes come from the live game's own order snapshot. It keeps station markets only, so player structures are left out. It is also the one seeder that cannot work offline, because it has to download that snapshot first.

## v3: The Jita Index Seeder

Double-click:

```text
tools\market-seederv3\BuildMarketSeedV3.bat
```

For a normal build, choose `[1] Build the Jita index seed`.

The menu is:

- `[1] Build the Jita index seed`
  The normal build. Asks before replacing an existing database.
- `[2] Build without the prompt`
  The same build, with no confirmation.
- `[3] Dry run`
  Works the whole plan out and writes nothing.
- `[4] Doctor`
  Checks the config, the static data and the seed station.
- `[5] Classify`
  Reports which items are in the seed and which rule left the rest out.
- `[6] Cost`
  Reports what each item costs and where that number came from.
- `[7] Refresh prices`
  Fetches the prices the price list is missing. This is the only option that uses the network.
- `[8] Audit`
  The money-pump check. See below.
- `[9] Edit v3 config`
  Opens the v3 config file in Notepad.
- `[A] Build release binary only`
  Compiles the seeder and nothing else.
- `[B] Open seeder README`
  Opens the full v3 write-up in Notepad.

The config file is:

```text
tools\market-seederv3\config\market-seederv3.local.toml
```

What makes it different:

- Prices are worked out from what each item costs to build, rather than invented or copied from live prices. Everything manufacturable, plus ores, minerals and materials, sells at 3x that cost at Jita 4-4 and is bought back at 1x.
- Underneath that sits the real Tranquility NPC catalog at the real stations: T1 blueprint originals, skillbooks, planetary command centers and trade goods. So blueprints and skillbooks are not at Jita.
- The price list is committed to the repo, so every build comes out the same on every machine. After the first snapshot download, a build needs no network at all.
- Every order carries 2,147,483,647 units, so the shelves do not run dry while you test.
- It writes 30 days of price history, so the market charts in the client are not blank.
- A build takes about 7 seconds and produces roughly 557,000 rows of stock.

### v3: The Audit Is A Gate

Run `[8] Audit` before you trust a build.

It hunts for any loop that would let a player buy from the seeded market and sell back for more than they paid, including by simply hauling something from one station to another. If it finds one, it exits with an error, and you should not build on that price list.

The Docker rebuild runs the same check and refuses to install a build that fails it, so a market that lets players print ISK never goes live.

### v3: Running It Again Wipes Player Orders

Like any rebuild, a v3 build replaces the market database whole.

Player orders and order history do not survive it, and the price charts are regenerated from the build date. That is the real cost of reseeding, so plan rebuilds rather than doing them casually.

Re-running the seeder is also the only way to restock, because there is no restock button on the market server. At 2.1 billion units per order, that is rarely why you would rebuild.

## v4: Iron Man

Run `tools\market-seederv4\BuildMarketSeedV4.bat` and choose `[1]`.
It reuses the v2 snapshot importer with a strict NPC-only filter. Original
stations, prices and quantities are preserved. There is no synthetic Jita stock
or custom-station stock, even if a custom station is configured. NPC identification
uses snapshot order duration greater than the normal 90-day player limit.

The config is `tools\market-seederv4\config\market-seederv4.local.toml`.
It needs network access to the snapshot index and can reuse a matching cached
snapshot. Like the other seed types, rebuilding replaces player orders and history.
This is a market seed option; it does not change mission rewards or GM commands.

For Docker, stop `server` and `market`, then run:

```text
docker compose run --rm --no-deps market-tools rebuild v4
```

See the [Iron Man guide](../tools/market-seederv4/README.md) for direct CLI usage.

## What Most People Should Do

If you are not sure which seeder to pick:

1. build `Jita + New Caldari` with v1
2. start `StartMarketServer.bat`
3. start `StartServer.bat`

If you want real blueprints and skillbooks, or a hub whose prices make sense against building things yourself, use v3 instead.

## If Rust Is Missing

All four seed types need Rust. Whichever one you ran will tell you and stop cleanly.

The easiest path here is:

```text
tools\InstallRustForMarket.bat
```

Run that helper, let it finish installing Rust, then run the same market seeder launcher again.

## Related Guides

- [MARKET_SETUP.md](MARKET_SETUP.md)
- [../tools/market-seederv2/README.md](../tools/market-seederv2/README.md) - the v2 snapshot seeder in full
- [../tools/market-seederv3/README.md](../tools/market-seederv3/README.md) - the v3 Jita index seeder in full
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
