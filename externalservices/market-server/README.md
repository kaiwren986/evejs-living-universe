# EvEJS Standalone Market Server

This is the optional fast market daemon used by EvEJS.

Most people do **not** need to start here.

If you just want to get in-game, go back and use:

- `tools\ClientSETUP\StartClientSetup.bat`
- `StartServer.bat`

## What This Is For

The standalone market server exists so EvEJS can keep market reads and seeded market data in a separate fast process.

That gives you:

- faster market window reads
- seeded market stock
- a dedicated place for market persistence
- less pressure on the main Node server

## The Normal User Path

1. build a market seed with any of the four seed types
2. start this daemon with `StartMarketServer.bat`
3. leave it running
4. start the main server with `StartServer.bat`

The root `BuildMarketSeed.bat` lists all four seed types and opens the chosen builder.
They all write the same kind of database for this daemon:

- v1 - `tools\market-seed\BuildMarketSeedGui.bat`. Invented prices, many stations, fully offline.
- v2 - `tools\market-seederv2\BuildMarketSeedV2.bat`. The real Tranquility snapshot. Needs a download.
- v3 - `tools\market-seederv3\BuildMarketSeedV3.bat`. A Jita 4-4 trade hub priced from build cost, over the real Tranquility NPC catalog.
- v4 - `tools\market-seederv4\BuildMarketSeedV4.bat`. Iron Man: authentic NPC stock and buybacks only; BPOs, skillbooks, command centers and trade goods.

If you skip the seed build, this server will not have a useful market database to serve.

Whichever one you use, restart this daemon afterwards. It holds the old database open and keeps serving it until it is restarted.

## What It Serves

By default it listens on:

- HTTP `127.0.0.1:40110`
- RPC `127.0.0.1:40111`

The EVE client still talks to the main EvEJS server. The main server bridges market traffic into this daemon.

## The Good News

You usually do not need to know any internal endpoint details to use it.

If the launcher starts and stays open, that is the important part.

## If Rust Is Missing

The launcher will tell you and stop.

Install Rust, then run `StartMarketServer.bat` again.

## Want The Friendly Setup Guide?

Open:

- [../../doc/MARKET_SETUP.md](../../doc/MARKET_SETUP.md)
- [../../doc/MARKET_SEEDER.md](../../doc/MARKET_SEEDER.md) - all four seed types, side by side
- [../../tools/market-seederv3/README.md](../../tools/market-seederv3/README.md) - the v3 seeder in full

## Useful Truth

This daemon is optional.

The main EvEJS server can still boot without it. You only need it if you want the separate standalone market experience.

## Matching priority

The merged order books use best price first (lowest ask or highest bid), then
oldest issue time, matching the pinned client's quote priority. Timestamp offsets
and fractions are compared chronologically. Station ID and order ID provide
deterministic ties when issue times are equal; malformed dates follow valid dates
at the same price. Seed rows use their existing `updated_at` value as issue time.
Range, minimum volume, access and settlement checks still decide eligibility.

## Transaction Safety and Regression Tests

Market mutations use `BEGIN IMMEDIATE`: the database writer is acquired before
reading order or history state. This prevents concurrent requests from failing
while upgrading an older WAL read snapshot to a writer. Connections retain a
bounded five-second busy wait, installed before WAL setup. A writer held longer
than that can still cause a lock timeout; this is not an unlimited retry loop.

Order fills, their idempotency receipts, and persisted region/seed-system summaries
commit together. A summary failure rolls the entire fill back, so callers can
safely compensate a rejected fill. Successful fills only invalidate in-memory
caches after commit. Seed buy and sell fills both update the seed-system summary.
Replaying the same fill key returns its receipt without decrementing stock again.

Seed and combined system-summary caches share a per-system generation. Seed
changes invalidate both caches, and reads started before an invalidation cannot
publish their older results back into either cache. A request already in flight
may finish with its earlier view, but subsequent reads reload current totals.
The generation guard is only held during cache publication/invalidation, never
across a database query; writes in unrelated systems do not discard valid reads.

From the repository root, run:

```powershell
cargo test --locked --manifest-path externalservices/market-server/Cargo.toml -- --test-threads=1
```

The transaction regressions use disposable, uniquely named SQLite fixtures, never
the configured market database. They cover concurrent player/seed fills and price
history, duplicate requests, rollback/retry after summary errors, cached summaries,
reads interleaved with invalidation, late cache publication, overfill rejection,
bounded writer contention, and concurrent order maintenance.
Order-book tests use in-memory SQLite and cover price/time priority on both
sides, station and order-ID conflicts, mixed seed/player books, timestamp formats,
deterministic ties, and exclusion of closed, depleted or out-of-scope orders.
No database migration or market reseed is needed for this fix; rebuild and restart
the market daemon when deploying it.
