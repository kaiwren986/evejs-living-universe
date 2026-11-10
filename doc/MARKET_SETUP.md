# Optional Market Setup

This guide is only for the optional standalone market system.

If you just want to boot EvEJS, log in, and fly around, you can skip this entire page.

## What The Optional Market Adds

The optional market path gives you:

- a separate fast market daemon
- seeded market stock
- faster market window reads
- a cleaner place for market persistence

## Which Market Do You Want?

There are four seed types. They all write the same kind of database for the same market server, so you only ever use one at a time.

### v1 - invented prices, lots of stations

Works the prices out from the static data's own base prices, and seeds many stations at once. It has presets, including `Jita + New Caldari`. Fully offline.

Pick this if: you want the simplest, quickest market and you do not mind that the prices are made up.

Double-click:

```text
BuildMarketSeed.bat
```

### v2 - the real Tranquility market

Downloads the real Tranquility market snapshot and imports it, so stations, prices and volumes mirror the live game.

Pick this if: you want the market to look like the real thing. It has to download first.

Double-click:

```text
tools\market-seederv2\BuildMarketSeedV2.bat
```

### v3 - a Jita trade hub over the real NPC catalog

Two layers.

On top there is a trade hub at Jita 4-4. Everything that can be manufactured, plus ores, minerals and materials, sells there at 3x what it costs to build, and is bought back at 1x. Stock is effectively unlimited.

Underneath it sits the real Tranquility NPC catalog at the real stations: T1 blueprint originals, skillbooks, planetary command centers and trade goods.

The prices come from a price list committed to the repo, so every build comes out the same. After the first snapshot download it needs no network at all. It also audits itself and refuses to install a build that would let players print ISK.

Pick this if: you want somewhere dependable to buy and sell while you test, plus real NPC blueprints and skillbooks.

Double-click:

```text
tools\market-seederv3\BuildMarketSeedV3.bat
```

### v4 - Iron Man, NPC stock only

Only authentic NPC station orders are seeded: BPOs, skillbooks, command centers,
trade goods and other NPC stock, including NPC buybacks. Prices, stations and
quantities come from the snapshot. Players obtain everything else through gameplay
and industry. There is no synthetic Jita hub or custom-station stock.

Double-click and choose `[1]`:

```text
tools\market-seederv4\BuildMarketSeedV4.bat
```

The root `BuildMarketSeed.bat` lists all four seed types with descriptions and
opens your chosen builder. The paths above open each tool directly.

## Before You Start

Make sure the normal setup already works first.

If you have not done that yet, go here:

- [SETUP.md](SETUP.md)

## The Easy Market Path

### 1. Build the seed database

Double-click:

```text
BuildMarketSeed.bat
```

For the easiest first build, choose `[1] v1 - Synthetic starter market`, then:

```text
Jita + New Caldari
```

That is the best starter preset for quick builds and realistic testing.

For v2, v3 or v4, choose that seed type in the root menu, then choose `[1]` in its
builder for the normal build. V3 needs its snapshot cached first: choose `[C]`
once, reopen the builder, then choose `[1]`. These seed types do not use geography presets.

### 2. Start the standalone market server

Double-click:

```text
StartMarketServer.bat
```

Choose the normal release option.

Leave that window open while you use EvEJS.

### 3. Start the main server

Double-click:

```text
StartServer.bat
```

Then choose:

```text
2 = Server + Play
```

## Do I Need Rust?

Only for the standalone market tools.

If Rust is missing, the market tools will tell you and stop. Install Rust, then run the same launcher again.

If you are not using the standalone market, you do not need Rust at all.

## Best First Preset (v1 Only)

Presets are a v1 thing. v2, v3 and v4 do not have them.

For most people, start with:

- `Jita + New Caldari`

Use a bigger seed only if you know you want it.

## If You Built The v3 Market

A few things worth knowing before you go looking for stock:

- The trade hub is one station: `Jita IV - Moon 4 - Caldari Navy Assembly Plant`, station 60003760. That is where everything the seeder prices is sold and bought back.
- Blueprints and skillbooks are not at Jita. They sit at their own stations, the same ones the live game uses.
- Stock is effectively unlimited. Every order carries 2,147,483,647 units, so nothing runs dry while you test.
- Re-running the seeder is how you restock. There is no restock button on the market server.
- Builds are fast: about 7 seconds for roughly 557,000 rows of stock, plus 30 days of price history so the market charts are not blank.

## When To Reseed

Run your seeder again if:

- you want to switch to a different seeder
- you want a different v1 preset
- you changed that seeder's settings
- you want a newer Tranquility snapshot on v2
- you want to restock the shelves on v3
- you want to refresh the generated market database

Use the same launcher you used the first time.

After reseeding, restart `StartMarketServer.bat` so it loads the new database.

## If The Market Looks Empty

Check these in order:

1. Did your seed build finish successfully? That is `BuildMarketSeed.bat` for v1, `BuildMarketSeedV2.bat` for v2, `BuildMarketSeedV3.bat` for v3, or `BuildMarketSeedV4.bat` for v4.
2. Is `StartMarketServer.bat` still open?
3. Did you restart `StartMarketServer.bat` after the seed build? It keeps serving the old database until you do.
4. Did you start the main server after the market server?
5. Are you looking in the right place? None of the seeders stock every station. On v3 in particular, the shelves are at Jita 4-4, and blueprints and skillbooks are somewhere else entirely.

## More Help

- [MARKET_SEEDER.md](MARKET_SEEDER.md) - all four seed types, side by side
- [../tools/market-seederv2/README.md](../tools/market-seederv2/README.md) - the v2 snapshot seeder in detail
- [../tools/market-seederv3/README.md](../tools/market-seederv3/README.md) - the v3 Jita index seeder in detail
- [TOOLS.md](TOOLS.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
