# Eve.JS Elysian Market Seeder (by Elysian)

This is the tool that builds the optional standalone market database.

This version keeps EveJS's existing v1 market schema and market-server contract,
while using Elysian's high-throughput bulk materialization and deferred-index
build pipeline. Installing the tool does not modify or replace an existing
market database. A database is replaced only when you explicitly run a rebuild.

If you only want to boot EvEJS and log in, you do not need this yet.

## The Friendly Version

From the repo root, double-click:

```text
BuildMarketSeed.bat
```

Then choose:

```text
Jita + New Caldari
```

That is the easiest first build.
If the generated local database is missing, the launcher creates it first under
`_local/gameStore/data`.

After the seed finishes:

1. start `StartMarketServer.bat`
2. leave it open
3. start `StartServer.bat`

## What This Tool Builds

It creates the database used by the standalone market server.

In simple terms:

- no seed database = no useful standalone market
- finished seed database = the standalone market has stock and order data to serve

## Best First Choice

For most people:

- use `Jita + New Caldari`

It is faster than a full-universe seed and still gives you a very usable market area.

## The Main Menu Options

- `Full universe rebuild`
  Huge build, slower, larger output
- `Jita + New Caldari rebuild`
  Best normal choice
- `Quick smoke rebuild`
  Tiny validation build
- `Rebuild summaries only`
  Refreshes summary tables without a full reseed
- `Doctor`
  Checks the current market database state
- `Edit market seed config`
  Opens the config file in Notepad

## Config File

The seeder config lives here:

```text
tools/market-seed/config/market-seed.local.toml
```

## Seeded Buy Orders

If you want seeded buy orders too, edit:

```text
tools/market-seed/config/market-seed.local.toml
```

Change:

```toml
seed_buy_orders_enabled = false
```

to:

```toml
seed_buy_orders_enabled = true
```

Then rebuild the seed and restart `StartMarketServer.bat`.

## If Rust Is Missing

The tool will tell you and stop.

Install Rust, then run the same launcher again.

## Want The Full User Guide?

Open:

- [../../doc/MARKET_SEEDER.md](../../doc/MARKET_SEEDER.md)
- [../../doc/MARKET_SETUP.md](../../doc/MARKET_SETUP.md)

## Advanced Note

If you are a maintainer and want direct CLI access, the project still supports it, but the normal user path is the launcher above.

The additional build controls are optional. Existing local and Docker config
files remain valid; omitted values use the native seeder defaults:

```toml
seed_insert_target_rows = 10000000
sqlite_temp_store = "FILE"
sqlite_analyze_enabled = false
```
