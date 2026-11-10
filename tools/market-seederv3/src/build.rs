//! The SQLite build pass — plan §5/§6, ported from market-seederv2's database machinery.
//!
//! What this piece writes, and what it deliberately does not:
//!
//! | table                  | what the build writes                           |
//! |------------------------|-------------------------------------------------|
//! | `regions` / `solar_systems` / `stations` / `market_types` | full static tables, v2's `write_static_tables` |
//! | `seed_stock` / `seed_buy_orders` | the TQ NPC overlay universe-wide ([`crate::overlay`]), then one ask + one bid per seedable type at the index station |
//! | `region_summaries` / `system_seed_summaries` | rebuilt from the seed tables, **after both passes** |
//! | `price_history`        | `[history] days` of synthetic chart per seeded type ([`crate::history`]) |
//! | `manifest`             | `manifest_json` for the daemon, plus flat build-metadata rows |
//! | `market_orders` / `market_order_events` | **never written** |
//!
//! ### The two seed passes, and why the order is load-bearing
//!
//! 1. **NPC overlay** (plan §2.3) — TQ's own NPC orders at ~5,000 authentic stations, taken
//!    from a locally cached snapshot. Prices and volumes are the snapshot's.
//! 2. **Index + junk** (plan §2.1/§2.2/§2.4) — our computed 3x-cost asks and 1x-cost bids at
//!    Jita 4-4, at the int32-max quantity.
//!
//! Both write rows keyed `(station_id, type_id)`, and pass 2 uses `INSERT OR REPLACE`, so
//! **pass 2 must run second** to win at Jita 4-4 — TQ sells plenty of index-seeded types
//! there too. Reversed, the snapshot's price would silently replace ours with no error and no
//! row-count change. [`verify_index_pass_won`] re-reads the stored prices in SQL, inside the
//! write transaction, and fails the build if it ever happens.
//!
//! The build **never downloads**: it uses whatever `snapshot-info --download` last cached, and
//! stops with instructions when the cache is empty. `--skip-overlay` builds pass 2 alone.
//!
//! ### Pricing, and the reason the floor is ask-only
//!
//! ```text
//! ask = max(price_floor, round2(sell_multiplier * cost))
//! bid =                  round2(buy_multiplier  * cost)     // floor NEVER applies
//! ```
//!
//! The plan text (§3.3) originally put `max(floor, …)` on both sides. That is a money pump,
//! measured: Tritanium costs 2 ISK, so a floored bid would pay **100 ISK for it — 50x cost**.
//! Buy a Venture at its 403,200 ask, reprocess it, sell the minerals into floored bids and
//! you get 1,417,500 ISK back: a **3.52x** loop that runs forever at int32-max quantities.
//! Bids must track cost exactly; only the ask carries a floor, and the floor's job is to stop
//! the seed selling items for fractions of an ISK, not to set a price of ISK.
//!
//! Both sides are additionally clamped to [`MIN_SEED_PRICE`] so no row can ever be written at
//! 0.00 — a zero ask hands out free items. With the default 100 ISK floor that clamp never
//! binds on the ask side; it exists for a deliberately floorless configuration.
//!
//! ### The invariants
//!
//! [`verify_seed_rows`] runs over the planned rows and [`verify_seed_tables`] re-runs the same
//! questions in SQL **inside the write transaction, before it commits**, so a bug in the
//! writer cannot leave a bad row behind: a violation aborts the transaction and the staged
//! database is discarded without ever touching the live one.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration as StdDuration, Instant};

use anyhow::{Context, Result, bail};
use console::style;
use indicatif::{ProgressBar, ProgressStyle};
use market_common::{
    MANIFEST_KEY, MARKET_SCHEMA_VERSION, MarketManifest, RUNTIME_INDEX_DROP_SQL, RUNTIME_INDEX_SQL,
    SCHEMA_SQL, now_rfc3339, round_isk,
};
use rusqlite::{Connection, params};

use crate::audit::SeedBook;
use crate::classify::{BucketFlags, Classification};
use crate::config::SeederConfig;
use crate::cost::{CostInputs, CostMap, CostReport, OverridePrices};
use crate::history::{HistoryPlan, HistorySource};
use crate::manifest::{CapturePolicy, PriceManifest, read_sde_build};
use crate::seedplan::{DeferredSide, DropReason, NpcCatalog, SeedPlan, SeedSides};
use crate::staticdata::{StaticData, StationRecord, resolve_static_data_dir};

/// No seed row may be written below this price. A 0.00 ask is free items; a 0.00 bid is a
/// row the client renders as a broken order. Prices are stored to 2 decimals, so this is the
/// smallest representable non-zero price.
pub const MIN_SEED_PRICE: f64 = 0.01;

/// `price_version` for every row this seeder writes. The daemon bumps it when it reprices.
pub const SEED_PRICE_VERSION: i64 = 1;

/// `manifest.selection_mode` — what a v3-built database is.
pub const SELECTION_MODE: &str = "jita_index_seed";

/// Plan §9's anchor: the Venture's EIV is the server's own industry parity fixture
/// (`server/tests/industryManufacturingParity.test.js:667`), so its seeded ask and bid are
/// the one pair a human can check by hand.
pub const ANCHOR_VENTURE: u32 = 32_880;
/// Plan's cheapest anchor and the reason the floor is ask-only: cost 2 ISK.
pub const ANCHOR_TRITANIUM: u32 = 34;

// ---------------------------------------------------------------------------- pricing

/// The two multipliers and the ask floor for one bucket.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeedPricing {
    pub sell_multiplier: f64,
    pub buy_multiplier: f64,
    /// Applies to the **ask only**. See the module docs for the Tritanium pump this
    /// asymmetry prevents.
    pub price_floor: f64,
}

impl SeedPricing {
    /// `max(price_floor, round2(sell_multiplier * cost))`, never below [`MIN_SEED_PRICE`].
    pub fn ask(self, cost: f64) -> f64 {
        let priced = round_isk(self.sell_multiplier * cost);
        let floored = if priced < self.price_floor {
            round_isk(self.price_floor)
        } else {
            priced
        };
        floored.max(MIN_SEED_PRICE)
    }

    /// `round2(buy_multiplier * cost)`, clamped only to the hard [`MIN_SEED_PRICE`] minimum.
    ///
    /// **`price_floor` is not applied here and must never be.** A floored bid pays more than
    /// cost for every cheap material in the game, which is a reprocessing money pump.
    pub fn bid(self, cost: f64) -> f64 {
        round_isk(self.buy_multiplier * cost).max(MIN_SEED_PRICE)
    }

    /// True when the ask came out at the floor rather than at `multiplier x cost`.
    pub fn ask_is_floored(self, cost: f64) -> bool {
        round_isk(self.sell_multiplier * cost) < self.price_floor
    }
}

/// The two pricing sets a run uses, and the rule for choosing between them.
///
/// One value rather than two loose arguments because the seed plan needs it as well now:
/// `[index_seed] defer_to_npc_catalog = "conflicting-prices"` compares our computed ask and
/// bid against the NPC catalog's, so [`crate::seedplan::SeedPlan::resolve`] has to be able to
/// compute exactly the prices [`plan_seed_rows`] will write, from exactly the same inputs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SeedPricingPair {
    /// `[index_seed]` — buckets A, A+B and B.
    pub index: SeedPricing,
    /// `[junk_seed]` — bucket D. It has no floor knob of its own and shares the index one.
    pub junk: SeedPricing,
}

impl SeedPricingPair {
    pub fn from_config(config: &SeederConfig) -> Self {
        Self {
            index: SeedPricing {
                sell_multiplier: config.index_seed.sell_multiplier,
                buy_multiplier: config.index_seed.buy_multiplier,
                price_floor: config.index_seed.price_floor,
            },
            junk: SeedPricing {
                sell_multiplier: config.junk_seed.sell_multiplier,
                buy_multiplier: config.junk_seed.buy_multiplier,
                price_floor: config.index_seed.price_floor,
            },
        }
    }

    /// The one predicate that decides which multipliers a type gets: anything outside A∪B is
    /// junk. `crate::cost` splits on the same test.
    pub fn is_junk(bucket: BucketFlags) -> bool {
        !(bucket.manufacturable_t1 || bucket.material)
    }

    pub fn for_bucket(self, bucket: BucketFlags) -> SeedPricing {
        if Self::is_junk(bucket) {
            self.junk
        } else {
            self.index
        }
    }
}

/// One seedable type resolved into the rows it will occupy — normally two, but one when the
/// NPC catalog took the other side (see [`SeedSides`]).
#[derive(Debug, Clone, PartialEq)]
pub struct SeedRow {
    pub type_id: u32,
    pub name: String,
    /// `A`, `A+B`, `B` or `D`.
    pub bucket: &'static str,
    /// True for bucket D, which carries its own `[junk_seed]` multipliers and quantity.
    pub junk: bool,
    /// The manifest price this row was derived from.
    pub cost: f64,
    pub ask: f64,
    pub bid: f64,
    /// Which of `ask` and `bid` is actually written. Both prices are computed either way —
    /// the deferred one is what the deferral was decided against, and it is worth keeping
    /// visible in a report — but only the enabled sides reach the database.
    pub sides: SeedSides,
    /// Written to both `quantity` and `initial_quantity`.
    pub quantity: i64,
}

impl SeedRow {
    pub fn writes_ask(&self) -> bool {
        self.sides.ask
    }

    pub fn writes_bid(&self) -> bool {
        self.sides.bid
    }

    /// How many seed rows this type contributes: 2, or 1 when a side was deferred.
    pub fn row_count(&self) -> usize {
        usize::from(self.sides.ask) + usize::from(self.sides.bid)
    }
}

/// Turns the seed plan into the row set, applying each type's own bucket pricing.
pub fn plan_seed_rows(
    plan: &SeedPlan,
    static_data: &StaticData,
    pricing: SeedPricingPair,
    index_quantity: i64,
    junk_quantity: i64,
) -> Vec<SeedRow> {
    plan.seedable
        .values()
        .map(|entry| {
            let is_junk = SeedPricingPair::is_junk(entry.bucket);
            // The same call the deferral decision made, on the same cost, so the two can
            // never answer differently about what this row's ask and bid are.
            let priced = pricing.for_bucket(entry.bucket);
            let quantity = if is_junk {
                junk_quantity
            } else {
                index_quantity
            };
            SeedRow {
                type_id: entry.type_id,
                name: static_data
                    .item_type(entry.type_id)
                    .map(|item| item.name.clone())
                    .unwrap_or_else(|| "<unknown type>".to_string()),
                bucket: entry.bucket_label(),
                junk: is_junk,
                cost: entry.price,
                ask: priced.ask(entry.price),
                bid: priced.bid(entry.price),
                sides: entry.sides,
                quantity,
            }
        })
        .collect()
}

/// How many `seed_stock` and `seed_buy_orders` rows a planned row set writes. Not
/// `2 x rows.len()` any more: a type whose ask or bid was deferred writes one row, not two.
pub fn planned_side_counts(rows: &[SeedRow]) -> (usize, usize) {
    (
        rows.iter().filter(|row| row.writes_ask()).count(),
        rows.iter().filter(|row| row.writes_bid()).count(),
    )
}

/// The five invariants that must hold before anything is committed. Each failure names the
/// offending type, because "the build failed" without a type ID is a two-hour bisect.
pub fn verify_seed_rows(
    rows: &[SeedRow],
    seedable_count: usize,
    index_quantity: i64,
    junk_quantity: i64,
) -> Result<()> {
    // 5. no type appears twice on the same side. Checked first: a duplicate makes every
    //    count below lie, so naming it is more useful than the count mismatch it causes.
    let mut seen: BTreeSet<u32> = BTreeSet::new();
    for row in rows {
        if !seen.insert(row.type_id) {
            bail!(
                "type {} ({}) appears twice in the seed row set. Each type may hold exactly \
                 one ask and one bid at the seed station — the seed tables are keyed \
                 (station_id, type_id), so a duplicate would silently overwrite the first row \
                 and leave the row count short.",
                row.type_id,
                row.name
            );
        }
    }

    for row in rows {
        // 1. every row's price is finite and > 0.
        for (side, price) in [("ask", row.ask), ("bid", row.bid)] {
            if !price.is_finite() || price <= 0.0 {
                bail!(
                    "type {} ({}) resolved to a {} of {} from cost {}. Every seed price must \
                     be finite and greater than 0: a zero ask hands out free items and a NaN \
                     cannot be marshalled to the client.",
                    row.type_id,
                    row.name,
                    side,
                    price,
                    row.cost
                );
            }
        }

        // 2. bid <= ask for every type.
        if row.bid > row.ask {
            bail!(
                "type {} ({}) would bid {} against its own ask of {} (cost {}, bucket {}). A \
                 bid above the ask at the same station is an instant arbitrage loop: buy the \
                 seed's stock and sell it straight back for a profit, forever. Check the \
                 [{}] sell_multiplier / buy_multiplier pair.",
                row.type_id,
                row.name,
                row.bid,
                row.ask,
                row.cost,
                row.bucket,
                if row.junk { "junk_seed" } else { "index_seed" }
            );
        }

        // 3. quantity == initial_quantity == the configured quantity. The equality of the two
        //    columns is structural in the INSERT (`?7, ?7`) and re-checked in SQL by
        //    `verify_seed_tables`; what this arm catches is a row planned at the wrong value.
        let expected = if row.junk {
            junk_quantity
        } else {
            index_quantity
        };
        if row.quantity != expected {
            bail!(
                "type {} ({}) was planned at quantity {} but [{}] quantity is {}.",
                row.type_id,
                row.name,
                row.quantity,
                if row.junk { "junk_seed" } else { "index_seed" },
                expected
            );
        }
    }

    // 4. one planned row per seedable type, and every one of them writes at least one side.
    //    A type with neither side is not a seed row at all — the plan drops it as a
    //    both-sides deferral — so one here would silently plan a no-op.
    if rows.len() != seedable_count {
        bail!(
            "the seed plan holds {} seedable types but {} rows were prepared. Every seedable \
             type must produce exactly one planned row.",
            seedable_count,
            rows.len(),
        );
    }
    if let Some(row) = rows.iter().find(|row| row.sides.is_empty()) {
        bail!(
            "type {} ({}) is planned with neither an ask nor a bid. A type that loses both \
             sides to the NPC catalog is dropped from the plan, not carried into it as a row \
             that writes nothing.",
            row.type_id,
            row.name
        );
    }

    Ok(())
}

/// `total_ask_quantity` in both summary tables is a `SUM(quantity)` over every station
/// holding the type, stored in an i64 column. This proves the sum cannot overflow at the
/// configured quantity, and returns how many stations it would take before it could.
pub fn summary_sum_headroom(stations_per_type: u64, quantity: i64) -> Result<i64> {
    let total = i128::from(stations_per_type) * i128::from(quantity);
    if total > i128::from(i64::MAX) {
        bail!(
            "{stations_per_type} stations x quantity {quantity} = {total}, which overflows the \
             i64 SUM(quantity) behind total_ask_quantity."
        );
    }
    Ok((i128::from(i64::MAX) / i128::from(quantity.max(1))) as i64)
}

// ------------------------------------------------------------------------- seed writing

/// The station geometry every seed row copies. Denormalised into the seed tables so the
/// daemon's per-region and per-system book queries never join.
#[derive(Debug, Clone, PartialEq)]
pub struct SeedStation {
    pub station_id: u64,
    pub solar_system_id: u32,
    pub constellation_id: u32,
    pub region_id: u32,
    pub station_name: String,
    pub region_name: String,
}

/// Jita 4-4, for tests anywhere in the crate that need somewhere to put a row. The audit's
/// book is keyed by station now, so a `SeedRow` on its own is no longer a complete fixture.
#[cfg(test)]
pub fn test_station() -> SeedStation {
    SeedStation {
        station_id: 60_003_760,
        solar_system_id: 30_000_142,
        constellation_id: 20_000_020,
        region_id: 10_000_002,
        station_name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant".to_string(),
        region_name: "The Forge".to_string(),
    }
}

impl From<&StationRecord> for SeedStation {
    fn from(station: &StationRecord) -> Self {
        Self {
            station_id: station.station_id,
            solar_system_id: station.solar_system_id,
            constellation_id: station.constellation_id,
            region_id: station.region_id,
            station_name: station.station_name.clone(),
            region_name: station.region_name.clone(),
        }
    }
}

/// How many rows each seed table must hold once every pass has run.
///
/// With the NPC overlay in the picture the row count is no longer "one per planned type":
/// the overlay writes first at ~5,000 stations, and the index pass then `INSERT OR
/// REPLACE`s over whatever it finds at its own station. So the total is
/// `overlay + planned - (overlay rows the index pass replaced)`, and the caller — which is
/// the only thing that knows both sets — computes it with [`SeedTableCounts::after_overlay`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedTableCounts {
    pub sell_rows: i64,
    pub buy_rows: i64,
}

impl SeedTableCounts {
    /// No overlay: one row per planned side, and nothing else.
    pub fn index_only(planned: &[SeedRow]) -> Self {
        let (planned_sell, planned_buy) = planned_side_counts(planned);
        Self {
            sell_rows: planned_sell as i64,
            buy_rows: planned_buy as i64,
        }
    }

    /// The overlay wrote `overlay_sell` / `overlay_buy` rows, of which `replaced_sell` /
    /// `replaced_buy` sat at the index station on a side the index pass also seeds and are
    /// therefore overwritten rather than added.
    pub fn after_overlay(
        planned: &[SeedRow],
        overlay_sell: usize,
        overlay_buy: usize,
        replaced_sell: usize,
        replaced_buy: usize,
    ) -> Self {
        let (planned_sell, planned_buy) = planned_side_counts(planned);
        Self {
            sell_rows: (overlay_sell + planned_sell - replaced_sell) as i64,
            buy_rows: (overlay_buy + planned_buy - replaced_buy) as i64,
        }
    }
}

/// How many overlay rows the index pass will overwrite rather than add: the ones sitting at
/// the index station on a **side** the index seed also prices. `(sell, buy)`.
///
/// Per side, not per type: a type whose ask was deferred to the NPC catalog leaves TQ's own
/// ask at the index station standing, so that row is added rather than replaced, and counting
/// it as replaced would make the expected row count one short.
///
/// This is the measured size of the collision the pass ordering exists to resolve — TQ selling
/// the same skillbook-adjacent types at Jita 4-4 that our own index seed prices — so the build
/// prints it.
pub fn overlay_rows_replaced_at(
    import: &crate::overlay::OverlayImport,
    station_id: u64,
    planned: &[SeedRow],
) -> (usize, usize) {
    let count = |book: &BTreeMap<(u64, u32), crate::overlay::SeedLiquidity>,
                 writes: fn(&SeedRow) -> bool| {
        planned
            .iter()
            .filter(|row| writes(row))
            .map(|row| row.type_id)
            .collect::<BTreeSet<_>>()
            .iter()
            .filter(|type_id| book.contains_key(&(station_id, **type_id)))
            .count()
    };
    (
        count(&import.sell, SeedRow::writes_ask),
        count(&import.buy, SeedRow::writes_bid),
    )
}

/// Writes the planned sides of each planned type — normally one `seed_stock` row and one
/// `seed_buy_orders` row, one row where the NPC catalog took the other side — in a single
/// transaction, verifying the tables in SQL before committing.
///
/// `INSERT OR REPLACE` mirrors v2's `write_custom_station` (`main.rs:1425-1508`): the seed
/// tables are keyed `(station_id, type_id)`, the NPC overlay has already written its rows,
/// and the index seed must win at the one station it owns **on the sides it writes**. A
/// deferred side is simply not written, which leaves TQ's own row there untouched — that is
/// the point of deferring it. That ordering is asserted in SQL by [`verify_seed_tables`]
/// before this transaction commits.
pub fn write_seed_rows(
    connection: &mut Connection,
    station: &SeedStation,
    rows: &[SeedRow],
    updated_at: &str,
    expected: SeedTableCounts,
    progress: Option<&ProgressBar>,
) -> Result<(u64, u64)> {
    let transaction = connection.transaction()?;
    {
        let mut sell = transaction.prepare(
            "INSERT OR REPLACE INTO seed_stock (
               station_id, solar_system_id, constellation_id, region_id,
               type_id, price, quantity, initial_quantity, price_version, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)",
        )?;
        let mut buy = transaction.prepare(
            "INSERT OR REPLACE INTO seed_buy_orders (
               station_id, solar_system_id, constellation_id, region_id,
               type_id, price, quantity, initial_quantity, price_version, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)",
        )?;
        for row in rows {
            if row.writes_ask() {
                sell.execute(params![
                    station.station_id,
                    station.solar_system_id,
                    station.constellation_id,
                    station.region_id,
                    row.type_id,
                    row.ask,
                    row.quantity,
                    SEED_PRICE_VERSION,
                    updated_at,
                ])?;
            }
            if row.writes_bid() {
                buy.execute(params![
                    station.station_id,
                    station.solar_system_id,
                    station.constellation_id,
                    station.region_id,
                    row.type_id,
                    row.bid,
                    row.quantity,
                    SEED_PRICE_VERSION,
                    updated_at,
                ])?;
            }
            if let Some(progress) = progress {
                progress.inc(row.row_count() as u64);
            }
        }
    }

    // The same invariants, asked of the database rather than of the plan, while the
    // transaction can still be thrown away.
    verify_seed_tables(&transaction, rows, station.station_id, expected)?;
    transaction.commit()?;
    let (planned_sell, planned_buy) = planned_side_counts(rows);
    Ok((planned_sell as u64, planned_buy as u64))
}

/// Re-asks [`verify_seed_rows`]'s questions in SQL, inside the open transaction, plus the one
/// question only SQL can answer: **did the index pass actually win at its own station?**
///
/// The crossed-pair test is scoped to the index station on purpose. Overlay rows are TQ's
/// prices, not ours; a station where TQ's own NPC bid sits above its NPC ask is a fact about
/// the snapshot, and the place to report it is the audit (check 4), not an aborted build.
/// What this must never let through is a crossed pair *we* wrote.
///
/// Per-side deferral widens what that test covers, for free. Once one side of a type at the
/// index station can be ours and the other TQ's, a bid of ours above a TQ ask **at Jita
/// itself** becomes expressible — and it would be the cheapest exploit in the game, needing no
/// haul at all, while sitting in check 4's same-station blind spot. It cannot happen, because
/// [`crate::seedplan::NpcCatalog`] measures TQ's best prices including the index station's, so
/// a surviving bid of ours is at or below every TQ ask there. This query is that argument's
/// receipt.
pub fn verify_seed_tables(
    connection: &Connection,
    planned: &[SeedRow],
    station_id: u64,
    expected: SeedTableCounts,
) -> Result<()> {
    for (table, expected) in [
        ("seed_stock", expected.sell_rows),
        ("seed_buy_orders", expected.buy_rows),
    ] {
        let count: i64 =
            connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))?;
        if count != expected {
            bail!(
                "{table} holds {count} rows but the overlay and the seed plan together account \
                 for {expected}"
            );
        }
        // (station_id, type_id) is the primary key, so a duplicate type on one side cannot
        // survive the insert; it shows up as a short count above. This checks the columns
        // the insert is supposed to keep identical.
        let mismatched: i64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE quantity <> initial_quantity"),
            [],
            |row| row.get(0),
        )?;
        if mismatched != 0 {
            bail!("{table} holds {mismatched} rows whose quantity differs from initial_quantity");
        }
        let bad_price: Option<u32> = connection
            .query_row(
                &format!("SELECT type_id FROM {table} WHERE price IS NULL OR price <= 0 LIMIT 1"),
                [],
                |row| row.get(0),
            )
            .ok();
        if let Some(type_id) = bad_price {
            bail!("{table} holds a non-positive price for type {type_id}");
        }
    }

    let total: i64 = connection.query_row(
        "SELECT (SELECT COUNT(*) FROM seed_stock) + (SELECT COUNT(*) FROM seed_buy_orders)",
        [],
        |row| row.get(0),
    )?;
    let expected_total = expected.sell_rows + expected.buy_rows;
    if total != expected_total {
        bail!("seed tables hold {total} rows in total, expected {expected_total}");
    }

    let crossed: Option<(u32, f64, f64)> = connection
        .query_row(
            "SELECT buy.type_id, buy.price, sell.price
               FROM seed_buy_orders AS buy
               JOIN seed_stock AS sell
                 ON sell.station_id = buy.station_id AND sell.type_id = buy.type_id
              WHERE buy.station_id = ?1 AND buy.price > sell.price
              LIMIT 1",
            params![station_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .ok();
    if let Some((type_id, bid, ask)) = crossed {
        bail!("type {type_id} bids {bid} against its own ask of {ask} at the seed station");
    }

    verify_index_pass_won(connection, planned, station_id)
}

/// **The ordering invariant, proven in SQL.** Every planned *side* must hold exactly the price
/// the index pass computed, at the index station — and every **deferred** side must not.
///
/// The first half catches the one mistake the overlay makes possible: writing the two passes
/// in the wrong order. The overlay carries TQ's own Jita 4-4 prices for a few hundred types
/// the index seed also prices, and both passes write `(60003760, type_id)`. Run the overlay
/// last and it silently replaces our computed 3x-cost price with a TQ snapshot price — no
/// error, no row-count change, just a different economy. So the prices are read back and
/// compared.
///
/// The second half is what `defer_to_npc_catalog = "conflicting-prices"` needs: a side we
/// deferred must not carry our price. The whole point of dropping it was to leave TQ's own
/// row (or no row) there, and a write that leaked through would put back exactly the leg of
/// the haul loop the deferral removed.
fn verify_index_pass_won(
    connection: &Connection,
    planned: &[SeedRow],
    station_id: u64,
) -> Result<()> {
    if planned.is_empty() {
        return Ok(());
    }
    connection.execute_batch(
        "DROP TABLE IF EXISTS temp.seed_plan_check;
         CREATE TEMP TABLE seed_plan_check (
           type_id INTEGER PRIMARY KEY, name TEXT NOT NULL, ask REAL NOT NULL, bid REAL NOT NULL,
           writes_ask INTEGER NOT NULL, writes_bid INTEGER NOT NULL
         );",
    )?;
    {
        let mut insert = connection.prepare(
            "INSERT INTO temp.seed_plan_check
               (type_id, name, ask, bid, writes_ask, writes_bid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for row in planned {
            insert.execute(params![
                row.type_id,
                row.name,
                row.ask,
                row.bid,
                row.writes_ask(),
                row.writes_bid()
            ])?;
        }
    }

    for (table, column, flag, side) in [
        ("seed_stock", "ask", "writes_ask", "ask"),
        ("seed_buy_orders", "bid", "writes_bid", "bid"),
    ] {
        let offender: Option<(u32, String, f64, Option<f64>)> = connection
            .query_row(
                &format!(
                    "SELECT plan.type_id, plan.name, plan.{column}, seed.price
                       FROM temp.seed_plan_check AS plan
                       LEFT JOIN {table} AS seed
                         ON seed.station_id = ?1 AND seed.type_id = plan.type_id
                      WHERE plan.{flag} = 1
                        AND (seed.type_id IS NULL OR seed.price <> plan.{column})
                      LIMIT 1"
                ),
                params![station_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .ok();
        if let Some((type_id, name, planned_price, stored)) = offender {
            connection.execute_batch("DROP TABLE IF EXISTS temp.seed_plan_check;")?;
            match stored {
                None => bail!(
                    "type {type_id} ({name}) has no {side} row at station {station_id}, but the \
                     index pass planned one at {planned_price}."
                ),
                Some(stored) => bail!(
                    "type {type_id} ({name}) holds a {side} of {stored} at station {station_id} \
                     but the index pass computed {planned_price}. The NPC overlay must be \
                     written BEFORE the index pass: both write (station_id, type_id) and the \
                     index pass's INSERT OR REPLACE is what makes it win at this station."
                ),
            }
        }

        // …and the mirror: a deferred side must not be ours.
        let leaked: Option<(u32, String, f64)> = connection
            .query_row(
                &format!(
                    "SELECT plan.type_id, plan.name, seed.price
                       FROM temp.seed_plan_check AS plan
                       JOIN {table} AS seed
                         ON seed.station_id = ?1 AND seed.type_id = plan.type_id
                      WHERE plan.{flag} = 0 AND seed.price = plan.{column}
                      LIMIT 1"
                ),
                params![station_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();
        if let Some((type_id, name, stored)) = leaked {
            connection.execute_batch("DROP TABLE IF EXISTS temp.seed_plan_check;")?;
            bail!(
                "type {type_id} ({name}) holds a {side} of {stored} at station {station_id}, \
                 which is exactly the price the index pass computed — but that side was \
                 deferred to the NPC catalog and must not have been written. Leaving it in \
                 restores the leg of the cross-station haul loop the deferral existed to \
                 remove."
            );
        }
    }

    connection.execute_batch("DROP TABLE IF EXISTS temp.seed_plan_check;")?;
    Ok(())
}

/// Stations where an ask and a bid for one type cross, across the whole database. Non-fatal
/// and reported rather than enforced: after the overlay lands these are TQ's own prices (see
/// [`verify_seed_tables`]), and the audit is where they get judged.
pub fn count_crossed_pairs(connection: &Connection) -> Result<i64> {
    let crossed: i64 = connection.query_row(
        "SELECT COUNT(*)
           FROM seed_buy_orders AS buy
           JOIN seed_stock AS sell
             ON sell.station_id = buy.station_id AND sell.type_id = buy.type_id
          WHERE buy.price > sell.price",
        [],
        |row| row.get(0),
    )?;
    Ok(crossed)
}

// ---------------------------------------------------------------------------- summaries

/// Rebuilds one summary table from the seed tables.
///
/// Ported from v2 (`main.rs:1552-1696`), which spells the identical query out twice — once
/// keyed on `region_id` and once on `solar_system_id`. The only difference between them is
/// that column name, so it is a parameter here. With exactly one seeded station every group
/// has one member on the index-only path; with the NPC overlay imported the aggregate form is
/// what makes a type sold at forty stations summarise to one best ask per region.
pub fn rebuild_summaries(connection: &mut Connection, table: &str, key: &str) -> Result<usize> {
    let updated_at = now_rfc3339();
    let sql = format!(
        "INSERT INTO {table} (
           {key}, type_id, best_ask_price, total_ask_quantity, best_ask_station_id,
           best_bid_price, total_bid_quantity, best_bid_station_id, updated_at
         )
         WITH sell_agg AS (
           SELECT {key}, type_id, MIN(price) AS best_ask_price, SUM(quantity) AS total_ask_quantity
           FROM seed_stock
           WHERE quantity > 0
           GROUP BY {key}, type_id
         ),
         sell_station AS (
           SELECT seed.{key}, seed.type_id, MIN(seed.station_id) AS station_id
           FROM seed_stock AS seed
           JOIN sell_agg
             ON sell_agg.{key} = seed.{key}
            AND sell_agg.type_id = seed.type_id
            AND sell_agg.best_ask_price = seed.price
           WHERE seed.quantity > 0
           GROUP BY seed.{key}, seed.type_id
         ),
         buy_agg AS (
           SELECT {key}, type_id, MAX(price) AS best_bid_price, SUM(quantity) AS total_bid_quantity
           FROM seed_buy_orders
           WHERE quantity > 0
           GROUP BY {key}, type_id
         ),
         buy_station AS (
           SELECT seed.{key}, seed.type_id, MIN(seed.station_id) AS station_id
           FROM seed_buy_orders AS seed
           JOIN buy_agg
             ON buy_agg.{key} = seed.{key}
            AND buy_agg.type_id = seed.type_id
            AND buy_agg.best_bid_price = seed.price
           WHERE seed.quantity > 0
           GROUP BY seed.{key}, seed.type_id
         ),
         keys AS (
           SELECT {key}, type_id FROM sell_agg
           UNION
           SELECT {key}, type_id FROM buy_agg
         )
         SELECT
           keys.{key},
           keys.type_id,
           sell_agg.best_ask_price,
           COALESCE(sell_agg.total_ask_quantity, 0),
           sell_station.station_id,
           buy_agg.best_bid_price,
           COALESCE(buy_agg.total_bid_quantity, 0),
           buy_station.station_id,
           ?1
         FROM keys
         LEFT JOIN sell_agg
           ON sell_agg.{key} = keys.{key} AND sell_agg.type_id = keys.type_id
         LEFT JOIN sell_station
           ON sell_station.{key} = keys.{key} AND sell_station.type_id = keys.type_id
         LEFT JOIN buy_agg
           ON buy_agg.{key} = keys.{key} AND buy_agg.type_id = keys.type_id
         LEFT JOIN buy_station
           ON buy_station.{key} = keys.{key} AND buy_station.type_id = keys.type_id"
    );

    let transaction = connection.transaction()?;
    transaction.execute(&format!("DELETE FROM {table}"), [])?;
    let inserted = transaction.execute(&sql, params![updated_at])?;
    transaction.commit()?;
    Ok(inserted)
}

// ------------------------------------------------------------------- database plumbing

/// v2 `main.rs:1006-1030`, verbatim: bulk-load pragmas, the shared schema, then the runtime
/// indexes dropped so inserts do not maintain them.
pub fn open_build_connection(
    path: &Path,
    cache_size_kib: i32,
    page_size_bytes: u32,
    worker_threads: usize,
) -> Result<Connection> {
    let connection = Connection::open(path).with_context(|| {
        format!(
            "failed to create market seed database at {}",
            path.to_string_lossy()
        )
    })?;
    connection.pragma_update(None, "page_size", page_size_bytes)?;
    connection.pragma_update(None, "journal_mode", "OFF")?;
    connection.pragma_update(None, "synchronous", "OFF")?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    connection.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
    connection.pragma_update(None, "cache_size", -cache_size_kib)?;
    connection.pragma_update(None, "threads", worker_threads.max(1))?;
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    connection.pragma_update(None, "cache_spill", "OFF")?;
    connection.execute_batch(SCHEMA_SQL)?;
    connection.execute_batch(RUNTIME_INDEX_DROP_SQL)?;
    Ok(connection)
}

/// v2 `main.rs:1032-1130`. Clears every table, then writes the four static ones.
///
/// **`market_types.market_group_id` is NOT NULL in the schema but nullable in the SDE**, so
/// v2 writes `market_group_id.unwrap_or(0)` — a type with no market group is stored with
/// group 0 rather than dropped. `group_id`, `category_id` and `portion_size` get the same
/// treatment (0, 0 and 1), and a missing `group_name` becomes `"Unknown"`. `base_price` and
/// `volume` are the two genuinely nullable columns and stay `NULL`. Every published item
/// type is written, not just the seed universe: the daemon resolves names and volumes for
/// types nobody seeds.
pub fn write_static_tables(connection: &mut Connection, static_data: &StaticData) -> Result<StaticCounts> {
    let regions = region_rows(static_data);
    let counts = StaticCounts {
        regions: regions.len(),
        solar_systems: static_data.solar_systems.len(),
        stations: static_data.stations.len(),
        market_types: static_data.item_types.len(),
    };
    let progress = row_progress_bar("Static tables", counts.total() as u64);

    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM manifest", [])?;
    transaction.execute("DELETE FROM price_history", [])?;
    transaction.execute("DELETE FROM region_summaries", [])?;
    transaction.execute("DELETE FROM system_seed_summaries", [])?;
    transaction.execute("DELETE FROM seed_buy_orders", [])?;
    transaction.execute("DELETE FROM market_order_events", [])?;
    transaction.execute("DELETE FROM market_orders", [])?;
    transaction.execute("DELETE FROM seed_stock", [])?;
    transaction.execute("DELETE FROM stations", [])?;
    transaction.execute("DELETE FROM solar_systems", [])?;
    transaction.execute("DELETE FROM regions", [])?;
    transaction.execute("DELETE FROM market_types", [])?;

    {
        let mut statement =
            transaction.prepare("INSERT INTO regions (region_id, region_name) VALUES (?1, ?2)")?;
        for (region_id, region_name) in &regions {
            statement.execute(params![region_id, region_name])?;
            progress.inc(1);
        }
    }

    {
        let mut statement = transaction.prepare(
            "INSERT INTO solar_systems (
               solar_system_id, region_id, constellation_id, solar_system_name, security
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for system in &static_data.solar_systems {
            statement.execute(params![
                system.solar_system_id,
                system.region_id,
                system.constellation_id,
                system.solar_system_name,
                system.security
            ])?;
            progress.inc(1);
        }
    }

    {
        let mut statement = transaction.prepare(
            "INSERT INTO stations (
               station_id, solar_system_id, constellation_id, region_id, station_name, security
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for station in &static_data.stations {
            statement.execute(params![
                station.station_id,
                station.solar_system_id,
                station.constellation_id,
                station.region_id,
                station.station_name,
                station.security
            ])?;
            progress.inc(1);
        }
    }

    {
        let mut statement = transaction.prepare(
            "INSERT INTO market_types (
               type_id, group_id, category_id, market_group_id, name, group_name,
               base_price, volume, portion_size, published
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        for item_type in &static_data.item_types {
            statement.execute(params![
                item_type.type_id,
                item_type.group_id.unwrap_or(0),
                item_type.category_id.unwrap_or(0),
                item_type.market_group_id.unwrap_or(0),
                item_type.name,
                item_type
                    .group_name
                    .clone()
                    .unwrap_or_else(|| "Unknown".to_string()),
                item_type.base_price,
                item_type.volume,
                item_type.portion_size.unwrap_or(1),
                if item_type.published { 1 } else { 0 }
            ])?;
            progress.inc(1);
        }
    }

    transaction.commit()?;
    progress.finish_with_message(format!(
        "Static tables wrote {} rows",
        format_count(counts.total())
    ));
    Ok(counts)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StaticCounts {
    pub regions: usize,
    pub solar_systems: usize,
    pub stations: usize,
    pub market_types: usize,
}

impl StaticCounts {
    pub fn total(self) -> usize {
        self.regions + self.solar_systems + self.stations + self.market_types
    }
}

/// v3's static data carries no region table of its own, so regions are folded out of the
/// station list exactly as v2 does (`main.rs:873-885`).
fn region_rows(static_data: &StaticData) -> Vec<(u32, String)> {
    let mut regions: BTreeMap<u32, String> = BTreeMap::new();
    for station in &static_data.stations {
        regions
            .entry(station.region_id)
            .or_insert_with(|| station.region_name.clone());
    }
    regions.into_iter().collect()
}

/// v2 `main.rs:1744-1749`.
fn build_runtime_indexes(connection: &Connection) -> Result<()> {
    let spinner = spinner("Building runtime indexes");
    connection.execute_batch(RUNTIME_INDEX_SQL)?;
    spinner.finish_with_message("Built runtime indexes");
    Ok(())
}

/// v2 `main.rs:1751-1759`.
fn finalize_database(connection: &Connection) -> Result<()> {
    let spinner = spinner("Finalizing SQLite database");
    connection.pragma_update(None, "analysis_limit", 10_000)?;
    connection.execute_batch("ANALYZE;")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    spinner.finish_with_message("Finalized SQLite database");
    Ok(())
}

/// v2 `main.rs:912-939`: an existing database is never replaced without an explicit,
/// typed-out `OVERWRITE` — or `--yes` for the docker/CI path.
fn confirm_replace_database(database_path: &Path, yes: bool) -> Result<()> {
    if yes {
        println!(
            "{} replacing existing database: {}",
            style("[confirm]").yellow().bold(),
            database_path.to_string_lossy()
        );
        return Ok(());
    }

    println!(
        "{} existing seeded market database detected:",
        style("[confirm]").yellow().bold()
    );
    println!("  {}", database_path.to_string_lossy());
    if let Ok(metadata) = fs::metadata(database_path) {
        println!("  size: {}", format_bytes(metadata.len()));
    }
    println!(
        "  it will be moved aside to {} and deleted once the new build installs cleanly.",
        backup_database_path(database_path).to_string_lossy()
    );
    println!();
    print!("Type OVERWRITE to replace it, or anything else to stop: ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if answer.trim() != "OVERWRITE" {
        bail!("database replacement cancelled");
    }
    Ok(())
}

fn database_family_paths(database_path: &Path) -> Vec<PathBuf> {
    vec![
        database_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", database_path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", database_path.to_string_lossy())),
    ]
}

fn remove_existing_database_files(database_path: &Path) -> Result<()> {
    for path in database_family_paths(database_path) {
        if path.exists() {
            fs::remove_file(&path)
                .with_context(|| format!("failed to remove {}", path.to_string_lossy()))?;
        }
    }
    Ok(())
}

pub fn staged_database_path(database_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.building", database_path.to_string_lossy()))
}

pub fn backup_database_path(database_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.previous", database_path.to_string_lossy()))
}

/// v2 `main.rs:959-996`. The live database is only ever moved, never truncated: it becomes
/// `.previous`, the staged build is renamed into its place, and only then is the backup
/// deleted. If the install rename fails the backup is put straight back, so a failed build
/// leaves the daemon's database exactly where it was.
fn install_built_database(staging_path: &Path, database_path: &Path) -> Result<()> {
    let backup_path = backup_database_path(database_path);
    remove_existing_database_files(&backup_path)?;

    if database_path.exists() {
        fs::rename(database_path, &backup_path).with_context(|| {
            format!(
                "failed to stage existing database backup {}",
                backup_path.to_string_lossy()
            )
        })?;
    }
    for sidecar in [
        PathBuf::from(format!("{}-wal", database_path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", database_path.to_string_lossy())),
    ] {
        if sidecar.exists() {
            fs::remove_file(&sidecar)
                .with_context(|| format!("failed to remove {}", sidecar.to_string_lossy()))?;
        }
    }

    if let Err(error) = fs::rename(staging_path, database_path) {
        if backup_path.exists() && !database_path.exists() {
            let _ = fs::rename(&backup_path, database_path);
        }
        return Err(error).with_context(|| {
            format!(
                "failed to install built database {}",
                database_path.to_string_lossy()
            )
        });
    }

    remove_existing_database_files(&backup_path)?;
    remove_existing_database_files(staging_path)?;
    Ok(())
}

// ----------------------------------------------------------------------- build manifest

/// Everything the manifest rows need that is not already in the config.
pub struct ManifestFacts<'a> {
    pub static_data_dir: &'a Path,
    pub static_counts: StaticCounts,
    pub station: &'a SeedStation,
    pub solar_system_name: String,
    pub plan: &'a SeedPlan,
    /// `(seed_stock, seed_buy_orders)` rows the index + junk pass wrote. Not one number any
    /// more: a type whose ask or bid was deferred to the NPC catalog writes only the other.
    pub seed_rows: (usize, usize),
    pub overlay: Option<&'a crate::overlay::OverlayImport>,
    /// `(sell, buy)` overlay rows the index pass replaced at the index station.
    pub overlay_replaced: (usize, usize),
    pub crossed_pairs: i64,
    pub snapshot_path: Option<&'a Path>,
    pub region_summary_rows: usize,
    pub system_summary_rows: usize,
    pub price_manifest_path: &'a Path,
    pub price_manifest: &'a PriceManifest,
    /// The synthetic `price_history` this build wrote (plan piece 12).
    pub history: &'a HistoryPlan,
    pub sde_build: Option<u64>,
    pub built_at: &'a str,
}

/// Writes `manifest_json` (the row the daemon parses, `state.rs:1014`) plus flat
/// build-metadata rows. v2's key set is mirrored where it still means something; the
/// v3-specific keys record the price manifest the build consumed and the seed knobs it used,
/// so a database can always be traced back to the manifest that priced it.
pub fn write_manifest(
    connection: &Connection,
    config: &SeederConfig,
    facts: &ManifestFacts<'_>,
) -> Result<usize> {
    let manifest = MarketManifest {
        schema_version: MARKET_SCHEMA_VERSION,
        generated_at: facts.built_at.to_string(),
        static_data_dir: facts.static_data_dir.to_string_lossy().to_string(),
        database_path: config.output.database_path.to_string_lossy().to_string(),
        selection_mode: SELECTION_MODE.to_string(),
        selection_label: format!(
            "Jita index seed at {} (station {}): {} types, ask x{} / bid x{} on manifest cost. \
             {}",
            facts.station.station_name,
            facts.station.station_id,
            facts.plan.seedable_count(),
            config.index_seed.sell_multiplier,
            config.index_seed.buy_multiplier,
            match facts.overlay {
                Some(overlay) => format!(
                    "TQ NPC overlay ({}): {} rows over {} stations, {} types.",
                    config.import.order_filter.mode_key(),
                    overlay.total_rows(),
                    overlay.stations().len(),
                    overlay.types().len()
                ),
                None => "NPC overlay NOT imported (--skip-overlay).".to_string(),
            }
        ),
        selected_solar_system_ids: vec![facts.station.solar_system_id],
        selected_solar_system_names: vec![facts.solar_system_name.clone()],
        region_count: facts.static_counts.regions as u32,
        solar_system_count: facts.static_counts.solar_systems as u32,
        station_count: facts.static_counts.stations as u32,
        market_type_count: facts.static_counts.market_types as u32,
        // Every seed row in the database, both passes, minus the overlay rows the index pass
        // replaced rather than added.
        seed_row_count: (facts.seed_rows.0
            + facts.seed_rows.1
            + facts
                .overlay
                .map(|overlay| overlay.total_rows())
                .unwrap_or(0)
            - facts.overlay_replaced.0
            - facts.overlay_replaced.1) as u64,
        default_quantity_per_station_type: u32::try_from(config.index_seed.quantity)
            .unwrap_or(u32::MAX),
        seed_buy_orders_enabled: true,
        history_days_seeded: facts.history.days,
        seed_markup_percent: (config.index_seed.sell_multiplier - 1.0) * 100.0,
        station_jitter_percent: 0.0,
        region_jitter_percent: 0.0,
    };

    let mut rows: Vec<(String, String)> = vec![
        (MANIFEST_KEY.to_string(), serde_json::to_string_pretty(&manifest)?),
        ("seeder".to_string(), "market-seederv3".to_string()),
        ("seeder_version".to_string(), env!("CARGO_PKG_VERSION").to_string()),
        ("selection_mode".to_string(), SELECTION_MODE.to_string()),
        ("built_at".to_string(), facts.built_at.to_string()),
        (
            "static_data_dir".to_string(),
            facts.static_data_dir.to_string_lossy().to_string(),
        ),
        (
            "static_data_build".to_string(),
            facts
                .sde_build
                .map(|build| build.to_string())
                .unwrap_or_else(|| "null".to_string()),
        ),
        (
            "price_manifest_path".to_string(),
            facts.price_manifest_path.to_string_lossy().to_string(),
        ),
        (
            "price_manifest_sde_build".to_string(),
            facts
                .price_manifest
                .sde_build
                .map(|build| build.to_string())
                .unwrap_or_else(|| "null".to_string()),
        ),
        (
            "price_manifest_cost_model".to_string(),
            facts.price_manifest.cost_model.clone(),
        ),
        (
            "price_manifest_generated_at".to_string(),
            facts.price_manifest.generated_at.clone(),
        ),
        (
            "price_manifest_entries".to_string(),
            facts.price_manifest.prices.len().to_string(),
        ),
        (
            "index_seed_station_id".to_string(),
            facts.station.station_id.to_string(),
        ),
        (
            "index_seed_station_name".to_string(),
            facts.station.station_name.clone(),
        ),
        (
            "index_seed_sell_multiplier".to_string(),
            config.index_seed.sell_multiplier.to_string(),
        ),
        (
            "index_seed_buy_multiplier".to_string(),
            config.index_seed.buy_multiplier.to_string(),
        ),
        (
            "index_seed_price_floor".to_string(),
            config.index_seed.price_floor.to_string(),
        ),
        (
            "index_seed_price_floor_applies_to".to_string(),
            "ask only (a floored bid is a reprocessing money pump)".to_string(),
        ),
        (
            "index_seed_quantity".to_string(),
            config.index_seed.quantity.to_string(),
        ),
        (
            "index_seed_pricing".to_string(),
            config.index_seed.pricing.mode_key().to_string(),
        ),
        (
            "junk_seed_enabled".to_string(),
            config.junk_seed.enabled.to_string(),
        ),
        (
            "junk_seed_categories".to_string(),
            config.junk_seed.categories.join(","),
        ),
        (
            "junk_seed_sell_multiplier".to_string(),
            config.junk_seed.sell_multiplier.to_string(),
        ),
        (
            "junk_seed_buy_multiplier".to_string(),
            config.junk_seed.buy_multiplier.to_string(),
        ),
        (
            "junk_seed_quantity".to_string(),
            config.junk_seed.quantity.to_string(),
        ),
        (
            "seedable_types".to_string(),
            facts.plan.seedable_count().to_string(),
        ),
        (
            "seedable_index_types".to_string(),
            facts.plan.seedable_index_count().to_string(),
        ),
        (
            "seedable_junk_types".to_string(),
            facts.plan.seedable_junk_count().to_string(),
        ),
        (
            "dropped_index_types".to_string(),
            facts.plan.index_drop_count().to_string(),
        ),
        (
            "dropped_junk_types".to_string(),
            facts.plan.junk_drop_count().to_string(),
        ),
        (
            "deferred_to_npc_catalog_types".to_string(),
            facts.plan.deferred_count().to_string(),
        ),
        (
            "deferred_to_npc_catalog_by_bucket".to_string(),
            facts
                .plan
                .deferred_composition()
                .iter()
                .map(|(label, count)| format!("{label} {count}"))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        (
            "deferred_to_npc_catalog_by_side".to_string(),
            DeferredSide::ALL
                .into_iter()
                .map(|side| {
                    format!("{} {}", side.key(), facts.plan.deferred_side_count(side))
                })
                .collect::<Vec<_>>()
                .join(", "),
        ),
        (
            "index_seed_defer_to_npc_catalog".to_string(),
            format!(
                "{}: {}",
                config.index_seed.defer_to_npc_catalog.key(),
                facts.plan.deferral.label()
            ),
        ),
        (
            "index_seed_stock_rows".to_string(),
            facts.seed_rows.0.to_string(),
        ),
        (
            "index_seed_buy_order_rows".to_string(),
            facts.seed_rows.1.to_string(),
        ),
        (
            "region_summary_rows".to_string(),
            facts.region_summary_rows.to_string(),
        ),
        (
            "system_summary_rows".to_string(),
            facts.system_summary_rows.to_string(),
        ),
        ("market_orders_rows".to_string(), "0".to_string()),
        (
            "price_history_rows".to_string(),
            facts.history.row_count().to_string(),
        ),
        (
            "price_history_days".to_string(),
            facts.history.days.to_string(),
        ),
        (
            "price_history_types".to_string(),
            facts.history.types.to_string(),
        ),
        (
            "price_history_day_range".to_string(),
            match facts.history.day_range.as_ref() {
                Some((first, last)) => format!("{first} .. {last} (UTC, ends today)"),
                None => "none — no history was written".to_string(),
            },
        ),
        (
            "price_history_types_by_source".to_string(),
            HistorySource::ALL
                .into_iter()
                .map(|source| format!("{} {}", source.key(), facts.history.source_count(source)))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        (
            "price_history_base_price".to_string(),
            format!(
                "best seeded ask anywhere, drifted ±5% deterministically; {} types had no ask \
                 anywhere and were drifted around their best bid. price_history has no station \
                 or region column, so one price per type is the whole series.",
                facts.history.bid_fallbacks
            ),
        ),
        (
            "seed_crossed_pairs".to_string(),
            facts.crossed_pairs.to_string(),
        ),
    ];

    match facts.overlay {
        Some(overlay) => {
            rows.extend([
                (
                    "npc_overlay".to_string(),
                    format!(
                        "imported: {} rows ({} asks + {} bids) at {} stations over {} types",
                        overlay.total_rows(),
                        overlay.sell_rows(),
                        overlay.buy_rows(),
                        overlay.stations().len(),
                        overlay.types().len()
                    ),
                ),
                (
                    "npc_overlay_order_filter".to_string(),
                    config.import.order_filter.mode_key().to_string(),
                ),
                (
                    "npc_overlay_duration_threshold_days".to_string(),
                    config.import.npc_order_duration_threshold_days.to_string(),
                ),
                (
                    "npc_overlay_snapshot".to_string(),
                    facts
                        .snapshot_path
                        .map(|path| path.to_string_lossy().to_string())
                        .unwrap_or_else(|| "unknown".to_string()),
                ),
                (
                    "npc_overlay_snapshot_window".to_string(),
                    format!(
                        "{} .. {}",
                        overlay
                            .stats
                            .min_http_last_modified
                            .as_deref()
                            .unwrap_or("none"),
                        overlay
                            .stats
                            .max_http_last_modified
                            .as_deref()
                            .unwrap_or("none")
                    ),
                ),
                (
                    "npc_overlay_source_rows".to_string(),
                    overlay.stats.source_rows.to_string(),
                ),
                (
                    "npc_overlay_rejected_rows".to_string(),
                    overlay.stats.rejected().to_string(),
                ),
                (
                    "npc_overlay_seed_stock_rows".to_string(),
                    overlay.sell_rows().to_string(),
                ),
                (
                    "npc_overlay_seed_buy_order_rows".to_string(),
                    overlay.buy_rows().to_string(),
                ),
                (
                    "npc_overlay_stations".to_string(),
                    overlay.stations().len().to_string(),
                ),
                (
                    "npc_overlay_types".to_string(),
                    overlay.types().len().to_string(),
                ),
                (
                    "npc_overlay_rows_replaced_by_index".to_string(),
                    format!(
                        "{} asks + {} bids at station {} (the index pass writes second and wins)",
                        facts.overlay_replaced.0,
                        facts.overlay_replaced.1,
                        facts.station.station_id
                    ),
                ),
            ]);
        }
        None => rows.push((
            "npc_overlay".to_string(),
            "not imported: the build ran with --skip-overlay".to_string(),
        )),
    }
    rows.sort_by(|left, right| left.0.cmp(&right.0));

    let mut statement =
        connection.prepare("INSERT OR REPLACE INTO manifest (key, value) VALUES (?1, ?2)")?;
    for (key, value) in &rows {
        statement.execute(params![key, value])?;
    }
    Ok(rows.len())
}

// -------------------------------------------------------------------------- the command

/// `build [--yes] [--dry-run] [--skip-overlay]`.
pub fn run_build(
    config_path: &Path,
    yes: bool,
    dry_run: bool,
    skip_overlay: bool,
) -> Result<()> {
    let started = Instant::now();
    let config = SeederConfig::load(config_path)?;
    let (static_data_dir, static_data_dir_source) =
        resolve_static_data_dir(config.input.static_data_dir.as_deref());
    let database_path = config.output.database_path.clone();

    println!(
        "{} market-seederv3 build{}",
        style("[config]").cyan().bold(),
        if dry_run { "  (dry run — nothing is written)" } else { "" }
    );
    crate::print_path("config file", config_path);
    println!(
        "  {:<24}: {} (from {})",
        "static data dir",
        crate::display_path(&static_data_dir),
        static_data_dir_source.label()
    );
    crate::print_path("output database", &database_path);
    crate::print_path("price manifest", &config.price_manifest.path);
    println!(
        "  {:<24}: station {}, ask x{} (floor {}), bid x{} (NO floor), quantity {}, pricing {}",
        "index seed",
        config.index_seed.station_id,
        config.index_seed.sell_multiplier,
        config.index_seed.price_floor,
        config.index_seed.buy_multiplier,
        format_count(config.index_seed.quantity),
        config.index_seed.pricing.mode_key()
    );
    println!(
        "  {:<24}: {}, ask x{}, bid x{}, quantity {}",
        "junk seed",
        if config.junk_seed.enabled {
            "enabled"
        } else {
            "disabled"
        },
        config.junk_seed.sell_multiplier,
        config.junk_seed.buy_multiplier,
        format_count(config.junk_seed.quantity)
    );

    println!(
        "  {:<24}: {}",
        "price history",
        config.history.label()
    );

    println!(
        "  {:<24}: {}, {} ({}), NPC when duration > {} days",
        "npc overlay",
        if skip_overlay {
            "SKIPPED (--skip-overlay)"
        } else {
            "enabled"
        },
        config.import.order_filter.mode_key(),
        config.import.order_filter.summary_label(),
        config.import.npc_order_duration_threshold_days
    );

    // ------------------------------------------------------- the snapshot, offline or not
    //
    // The build never resolves the EVE Ref index and never downloads: a build is an offline,
    // reproducible operation (plan §4.3), and a build that reaches the network cannot be run
    // in a sealed environment or replayed against a known snapshot. `snapshot-info
    // --download` is the one command that fetches.
    let snapshot = if skip_overlay {
        None
    } else {
        let cached = crate::snapshot::find_cached_snapshot(&config.source.download_dir)?;
        match cached {
            Some(cached) => {
                println!(
                    "  {:<24}: {} ({})",
                    "snapshot (cached)",
                    crate::display_path(&cached.path),
                    cached.size_label()
                );
                Some(cached)
            }
            None => bail!(
                "no market-order snapshot is cached in {}, so the NPC catalog overlay has \
                 nothing to import.\n\n  Run this first:\n      market-seederv3 snapshot-info \
                 --download --reuse-download\n\n  The build itself never downloads: it must \
                 stay offline and reproducible (plan §4.3), so a missing snapshot is a stop, \
                 not a silent fetch. Pass --skip-overlay to build the Jita 4-4 index + junk \
                 seed alone — the database will then have no skillbooks, no T1 BPOs and no NPC \
                 trade-good buybacks anywhere.",
                crate::display_path(&config.source.download_dir)
            ),
        }
    };
    if !skip_overlay && config.import.order_filter.uses_market_scope() {
        bail!(
            "[import] order_filter = \"{}\" needs a set of in-scope solar systems, and v3 has \
             no [market_scope] config section (v2 built that set from its own station \
             selection pass). Left alone it would match nothing and import an empty overlay, \
             so it is refused instead. Use \"npc_only\" (the v3 default), \"player_only\" or \
             \"all_station\".",
            config.import.order_filter.mode_key()
        );
    }

    println!();
    if skip_overlay {
        println!(
            "{} --skip-overlay: this build writes the index + junk seed at one station and \
             NOTHING ELSE.",
            style("[scope]").yellow().bold()
        );
        println!("  no TQ NPC overlay is imported, so the database has no skillbooks, no T1");
        println!("  BPOs and no NPC trade-good buybacks anywhere.");
    } else {
        println!(
            "{} two seed passes, in this order: NPC overlay first, index + junk second.",
            style("[scope]").yellow().bold()
        );
        println!("  Both write the seed tables keyed (station_id, type_id) and the index pass");
        println!("  uses INSERT OR REPLACE, so writing it second is what makes it win at the");
        println!("  index station. Summaries are rebuilt after both.");
    }
    println!("  no market_orders and no market_order_events rows are written by either pass.");
    println!(
        "  price_history is written afterwards, from the finished book: {}",
        config.history.label()
    );

    // v2 asks before anything expensive happens (main.rs:569); a dry run never asks because
    // it never writes.
    if !dry_run && database_path.exists() {
        println!();
        confirm_replace_database(&database_path, yes)?;
    }

    // ------------------------------------------------------------------ resolve the plan
    println!();
    let static_data = StaticData::load(&static_data_dir)?;
    let classification = Classification::compute(&static_data, &config.junk_seed)?;

    // --------------------------------------------- pass 1, resolved before the seed plan
    //
    // The snapshot is streamed HERE, before the plan, because the plan depends on it:
    // `[index_seed] defer_to_npc_catalog` stands the index/junk pass down where TQ's price
    // would cross ours, and TQ's prices are only knowable by importing the overlay. The rows
    // are held in memory and written to the staged database further down, still before the
    // index pass — the write order is unchanged and still load-bearing.
    let overlay = match &snapshot {
        Some(cached) => {
            let import = crate::overlay::import_overlay(
                &cached.path,
                &static_data,
                config.import.order_filter,
                config.import.npc_order_duration_threshold_days,
                &BTreeSet::new(),
                config.price_manifest.reference_solar_system_id,
                false,
            )?;
            crate::overlay::print_overlay_report(&import, config.import.order_filter);
            Some(import)
        }
        None => None,
    };
    let npc_catalog = match overlay.as_ref() {
        Some(import) => NpcCatalog::from_overlay(import),
        None => NpcCatalog::none(),
    };

    let sde = read_sde_build(&static_data_dir);
    let price_manifest = PriceManifest::load(&config.price_manifest.path)?.ok_or_else(|| {
        anyhow::anyhow!(
            "no price manifest at {}. The build consumes it read-only and never invents a \
             price, so there is nothing to seed without it. Run `market-seederv3 \
             refresh-prices` first.",
            config.price_manifest.path.to_string_lossy()
        )
    })?;
    if price_manifest.sde_build != sde.build {
        println!(
            "{} price manifest sdeBuild {} != static data build {}. Local prices in the \
             manifest were computed against different static data; re-run refresh-prices.",
            style("[warn]").yellow().bold(),
            price_manifest
                .sde_build
                .map(|build| build.to_string())
                .unwrap_or_else(|| "null".to_string()),
            sde.build
                .map(|build| build.to_string())
                .unwrap_or_else(|| "null".to_string())
        );
    }

    if price_manifest.pricing_rules != config.index_seed.pricing_rules() {
        println!(
            "{} price manifest pricingRules [{}] != configured [{}]. Seed prices come from \
             the manifest; re-run refresh-prices to apply the configured rules.",
            style("[warn]").yellow().bold(),
            if price_manifest.pricing_rules.is_empty() {
                "none recorded".to_string()
            } else {
                price_manifest.pricing_rules.join(", ")
            },
            config.index_seed.pricing_rules().join(", ")
        );
    }

    // As in the audit: the build seeds the manifest's prices, so this map only exists to
    // blame the leaves behind a dropped type. No rule overrides.
    let captures = price_manifest.captured_leaf_prices(CapturePolicy::from_config(&config));
    let no_twins = OverridePrices::new();
    let no_floors = OverridePrices::new();
    let mut cost_map = CostMap::new(CostInputs {
        data: &static_data,
        producers: &classification.producers,
        invention_lineage: &classification.invention_lineage,
        captures: &captures,
        model: config.index_seed.pricing,
        leaf_source: config.index_seed.leaf_price_source,
        twins: &no_twins,
        floors: &no_floors,
    });
    let cost_report = CostReport::build(&mut cost_map, classification.seeded_types().into_iter());
    // The deferral compares our computed prices against TQ's, so the plan needs the
    // multipliers that will write the rows — the same pair `plan_seed_rows` uses below.
    let pricing = SeedPricingPair::from_config(&config);
    let plan = SeedPlan::resolve(
        &classification,
        &static_data,
        &cost_report,
        &price_manifest,
        &npc_catalog,
        pricing,
        &config,
    )?;

    let station = static_data
        .station(config.index_seed.station_id)
        .map(SeedStation::from)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "[index_seed] station_id {} is not in {}. Every seed row copies its station's \
                 solar_system_id / constellation_id / region_id, so the build cannot place a \
                 row at a station the static data has never heard of.",
                config.index_seed.station_id,
                static_data_dir
                    .join("stations")
                    .join("data.json")
                    .to_string_lossy()
            )
        })?;
    let solar_system_name = static_data
        .solar_system(station.solar_system_id)
        .map(|system| system.solar_system_name.clone())
        .unwrap_or_else(|| "<unknown system>".to_string());

    let rows = plan_seed_rows(
        &plan,
        &static_data,
        pricing,
        config.index_seed.quantity,
        config.junk_seed.quantity,
    );
    verify_seed_rows(
        &rows,
        plan.seedable_count(),
        config.index_seed.quantity,
        config.junk_seed.quantity,
    )?;
    let (planned_sell, planned_buy) = planned_side_counts(&rows);
    // One seeded station, so every (region, type) and (system, type) summary group has one
    // member and SUM(quantity) is the row's own quantity.
    let headroom = summary_sum_headroom(1, config.index_seed.quantity.max(config.junk_seed.quantity))?;

    print_plan_report(&config, &plan, &rows, &station, &solar_system_name, headroom);

    // ------------------------------------------------- piece 12: the synthetic price charts
    //
    // The base price is what a player actually pays to buy a type from the seed, so it has to
    // come from the **finished** book — index rows, junk rows and the NPC overlay together,
    // assembled exactly as `audit` assembles it, so a BPO or a skillbook gets a chart too.
    // Resolved here rather than after the write because a dry run has to be able to report it,
    // and because it reads the plan and touches no price: nothing below this line can move a
    // seed row, a summary or a manifest price. See [`crate::history`].
    let mut history_book = SeedBook::from_rows(&rows, &station);
    if let Some(import) = overlay.as_ref() {
        history_book.merge_overlay(import, &static_data, station.station_id);
    }
    let history = crate::history::plan_history(
        &history_book,
        config.history.effective_days(),
        crate::history::today_utc(),
        config.index_seed.price_floor,
    );
    print_history_report(&config, &history);

    let static_counts = StaticCounts {
        regions: region_rows(&static_data).len(),
        solar_systems: static_data.solar_systems.len(),
        stations: static_data.stations.len(),
        market_types: static_data.item_types.len(),
    };

    if dry_run {
        println!();
        println!("{} rows that would be written", style("[plan]").cyan().bold());
        print_row_table(&[
            ("regions", static_counts.regions),
            ("solar_systems", static_counts.solar_systems),
            ("stations", static_counts.stations),
            ("market_types", static_counts.market_types),
            ("seed_stock (index+junk)", planned_sell),
            ("seed_buy_orders (index+junk)", planned_buy),
            ("market_orders", 0),
            ("market_order_events", 0),
            ("price_history", history.row_count()),
        ]);
        // The overlay is imported before the plan now (the plan defers to it), so a dry run
        // knows its real size rather than pointing at the file it would have come from.
        match (&snapshot, overlay.as_ref()) {
            (Some(cached), Some(import)) => println!(
                "  {:<28}: {} ({} asks + {} bids) from {} ({})",
                "seed rows (NPC overlay)",
                format_count(import.total_rows()),
                format_count(import.sell_rows()),
                format_count(import.buy_rows()),
                crate::display_path(&cached.path),
                cached.size_label()
            ),
            _ => println!("  {:<28}: none (--skip-overlay)", "seed rows (NPC overlay)"),
        }
        println!();
        println!(
            "{} dry run: nothing written. The build would stage {} and install it over {}.",
            style("[write]").cyan().bold(),
            staged_database_path(&database_path).to_string_lossy(),
            crate::display_path(&database_path)
        );
        if database_path.exists() {
            println!(
                "  the existing database would be moved to {} and deleted after a clean install.",
                backup_database_path(&database_path).to_string_lossy()
            );
        }
        return Ok(());
    }

    // ------------------------------------------------------------------------- the build
    println!();
    if let Some(parent) = database_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let staging_path = staged_database_path(&database_path);
    remove_existing_database_files(&staging_path)?;
    println!(
        "{} staging into {}",
        style("[build]").cyan().bold(),
        staging_path.to_string_lossy()
    );

    let mut connection = open_build_connection(
        &staging_path,
        config.build.sqlite_cache_size_kib,
        config.build.sqlite_page_size_bytes,
        config.build.sqlite_worker_threads,
    )?;

    let built_at = now_rfc3339();
    write_static_tables(&mut connection, &static_data)?;

    // ------------------------------------------------------- pass 1: the NPC overlay (C)
    //
    // ORDER IS LOAD-BEARING. The overlay goes in FIRST and the index + junk pass second,
    // because both write the seed tables keyed (station_id, type_id) and the index pass uses
    // INSERT OR REPLACE. TQ sells a few hundred of our index-seeded types at Jita 4-4 itself;
    // written the other way round, the snapshot's price would quietly replace our computed
    // 3x-cost price at the one station the index seed owns, with no error and no row-count
    // change. This mirrors v2 running write_custom_station after write_seed_liquidity
    // (main.rs:1335-1342). `verify_seed_tables` proves the outcome in SQL before committing.
    //
    // The import itself already ran, above the seed plan, because the plan defers to it.
    if let Some(import) = overlay.as_ref() {
        let overlay_progress = row_progress_bar("Overlay rows", import.total_rows() as u64);
        let (overlay_sells, overlay_buys) = crate::overlay::write_overlay_rows(
            &mut connection,
            import,
            &built_at,
            Some(&overlay_progress),
        )?;
        overlay_progress.finish_with_message(format!(
            "Overlay wrote {} asks + {} bids across {} stations",
            format_count(overlay_sells),
            format_count(overlay_buys),
            format_count(import.stations().len())
        ));
    }

    // ---------------------------------------- pass 2: the index + junk seed at one station
    let expected_counts = match overlay.as_ref() {
        Some(import) => {
            let (replaced_sell, replaced_buy) =
                overlay_rows_replaced_at(import, station.station_id, &rows);
            SeedTableCounts::after_overlay(
                &rows,
                import.sell_rows(),
                import.buy_rows(),
                replaced_sell,
                replaced_buy,
            )
        }
        None => SeedTableCounts::index_only(&rows),
    };
    let seed_progress = row_progress_bar("Seed rows", (planned_sell + planned_buy) as u64);
    let (sell_rows, buy_rows) = write_seed_rows(
        &mut connection,
        &station,
        &rows,
        &built_at,
        expected_counts,
        Some(&seed_progress),
    )?;
    seed_progress.finish_with_message(format!(
        "Seed rows wrote {} asks + {} bids at {}",
        format_count(sell_rows),
        format_count(buy_rows),
        station.station_name
    ));

    // Overlay rows are TQ's prices, not ours, and TQ does cross its own book here and there.
    // The build reports it; the audit (check 4) is what judges it.
    let crossed_pairs = count_crossed_pairs(&connection)?;

    // Summaries come after BOTH passes, so best_ask/best_bid see the final book.
    let summary_spinner = spinner("Rebuilding region and system summaries from the seed tables");
    let region_summary_rows = rebuild_summaries(&mut connection, "region_summaries", "region_id")?;
    let system_summary_rows =
        rebuild_summaries(&mut connection, "system_seed_summaries", "solar_system_id")?;
    summary_spinner.finish_with_message(format!(
        "Rebuilt {} region + {} system summary rows",
        format_count(region_summary_rows),
        format_count(system_summary_rows)
    ));

    // ------------------------------------------------------- piece 12: price_history rows
    //
    // Last of the data passes, and deliberately so: it is derived from the finished book and
    // feeds nothing, so it cannot influence a price even by accident. `write_history_rows`
    // re-checks the whole table in SQL inside its own transaction before committing, so a
    // malformed chart is discarded rather than shipped.
    if history.row_count() > 0 {
        let history_progress = row_progress_bar("Price history", history.row_count() as u64);
        let written = crate::history::write_history_rows(
            &mut connection,
            &history.rows,
            history.types,
            history.days,
            Some(&history_progress),
        )?;
        history_progress.finish_with_message(format!(
            "Price history wrote {} rows over {} types x {} days",
            format_count(written),
            format_count(history.types),
            history.days
        ));
        print_history_anchors(&connection, &history)?;
    } else {
        println!(
            "{} price_history left empty: {}. The client's market charts will be blank.",
            style("[history]").yellow().bold(),
            config.history.label()
        );
    }

    let manifest_rows = write_manifest(
        &connection,
        &config,
        &ManifestFacts {
            static_data_dir: &static_data_dir,
            static_counts,
            station: &station,
            solar_system_name: solar_system_name.clone(),
            plan: &plan,
            seed_rows: (planned_sell, planned_buy),
            overlay: overlay.as_ref(),
            overlay_replaced: overlay
                .as_ref()
                .map(|import| overlay_rows_replaced_at(import, station.station_id, &rows))
                .unwrap_or((0, 0)),
            crossed_pairs,
            snapshot_path: snapshot.as_ref().map(|cached| cached.path.as_path()),
            region_summary_rows,
            system_summary_rows,
            price_manifest_path: &config.price_manifest.path,
            price_manifest: &price_manifest,
            history: &history,
            sde_build: sde.build,
            built_at: &built_at,
        },
    )?;

    build_runtime_indexes(&connection)?;
    finalize_database(&connection)?;
    drop(connection);

    let backup_path = backup_database_path(&database_path);
    let had_previous = database_path.exists();
    install_built_database(&staging_path, &database_path)?;

    print_build_summary(&BuildSummaryFacts {
        database_path: &database_path,
        backup_path: &backup_path,
        had_previous,
        station: &station,
        solar_system_name: &solar_system_name,
        plan: &plan,
        rows: &rows,
        static_counts,
        overlay: overlay.as_ref(),
        counts: expected_counts,
        crossed_pairs,
        region_summary_rows,
        system_summary_rows,
        manifest_rows,
        history: &history,
        elapsed: started.elapsed(),
    })?;
    Ok(())
}

// ------------------------------------------------------------------------------ reports

fn print_plan_report(
    config: &SeederConfig,
    plan: &SeedPlan,
    rows: &[SeedRow],
    station: &SeedStation,
    solar_system_name: &str,
    headroom: i64,
) {
    println!();
    println!(
        "{} {} at {} ({}, {}), system {} / constellation {} / region {}",
        style("[station]").cyan().bold(),
        station.station_name,
        station.station_id,
        station.region_name,
        solar_system_name,
        station.solar_system_id,
        station.constellation_id,
        station.region_id
    );

    let (planned_sell, planned_buy) = planned_side_counts(rows);
    println!();
    println!(
        "{} {} seedable types -> {} seed rows ({} asks + {} bids)",
        style("[seed plan]").cyan().bold(),
        format_count(plan.seedable_count()),
        format_count(planned_sell + planned_buy),
        format_count(planned_sell),
        format_count(planned_buy)
    );
    println!(
        "  {:<30}: {}",
        "composition",
        plan.seedable_composition()
            .iter()
            .map(|(label, count)| format!("{label} {count}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "  {:<30}: {} index (A/A+B/B), {} junk (D)",
        "rows by bucket",
        format_count(plan.seedable_index_count()),
        format_count(plan.seedable_junk_count())
    );
    println!(
        "  {:<30}: {} unpriced index types (budget {}), {} uncaptured junk candidates",
        "dropped, never guessed at",
        plan.index_drop_count(),
        config.index_seed.max_unpriced_drops,
        plan.junk_drop_count()
    );
    for dropped in plan.dropped_with(DropReason::UnpricedIndexType) {
        println!(
            "    {:>7}  {:<46} bucket {:<4} blocked by {:?}",
            dropped.type_id,
            dropped.name,
            dropped.bucket_label(),
            dropped.blocking_leaves
        );
    }
    print_deferral_report(plan);
    println!(
        "  {:<30}: {} per row; SUM(quantity) per (region, type) fits i64 with {}x headroom",
        "quantity",
        format_count(config.index_seed.quantity),
        format_count(headroom)
    );

    println!();
    println!(
        "{} ask = max(floor {}, round2(x{} cost)); bid = round2(x{} cost), NO floor",
        style("[pricing]").cyan().bold(),
        config.index_seed.price_floor,
        config.index_seed.sell_multiplier,
        config.index_seed.buy_multiplier
    );
    let floored = rows
        .iter()
        .filter(|row| {
            let pricing = SeedPricing {
                sell_multiplier: if row.junk {
                    config.junk_seed.sell_multiplier
                } else {
                    config.index_seed.sell_multiplier
                },
                buy_multiplier: 1.0,
                price_floor: config.index_seed.price_floor,
            };
            pricing.ask_is_floored(row.cost)
        })
        .count();
    println!(
        "  {:<30}: {} of {} asks sit at the floor; 0 bids do, by design",
        "floor bites",
        format_count(floored),
        format_count(rows.len())
    );
    print_price_extremes(rows);
    print_anchors(rows);
}

/// The NPC-catalog deferral, as a first-class outcome rather than a footnote on the drops.
///
/// A deferral is not a pricing failure — the type has a price, and it is still traded in game
/// at TQ's own stations. What it loses is a Jita 4-4 row on one side, or on both, and which of
/// those it was is the judgement a reader has to be able to make. So the three outcomes are
/// counted apart, and each is sampled by name with the two prices that crossed.
pub fn print_deferral_report(plan: &SeedPlan) {
    const SAMPLE: usize = 8;
    println!(
        "  {:<30}: {}",
        "npc catalog deferral",
        plan.deferral.label()
    );
    if !plan.deferral.is_active() {
        return;
    }
    println!(
        "  {:<30}: {} deferrals — {}. None is a missing price, so none counts against \
         max_unpriced_drops.",
        "  by side",
        format_count(plan.deferral_count()),
        DeferredSide::ALL
            .into_iter()
            .map(|side| format!(
                "{} {}",
                format_count(plan.deferred_side_count(side)),
                side.key()
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );
    if plan.deferred_count() > 0 {
        println!(
            "  {:<30}: {} types keep no index/junk row at all ({})",
            "  both sides gone",
            format_count(plan.deferred_count()),
            plan.deferred_composition()
                .iter()
                .map(|(label, count)| format!("{label} {count}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    for side in DeferredSide::ALL {
        let total = plan.deferred_side_count(side);
        if total == 0 {
            continue;
        }
        println!("    {} ({}):", side.key(), format_count(total));
        for deferred in plan.deferrals_with(side).take(SAMPLE) {
            println!(
                "      {:>7}  {:<40} {:<4} {}",
                deferred.type_id,
                deferred.name,
                deferred.bucket_label(),
                deferred.detail()
            );
        }
        if total > SAMPLE {
            println!("      … and {} more", format_count(total - SAMPLE));
        }
    }
}

/// Cheapest / median / dearest, over the rows that actually carry that side. A deferred ask is
/// not a 0.00 ask and must not drag the minimum down: it is simply not a row.
fn print_price_extremes(rows: &[SeedRow]) {
    for (side, price, writes) in [
        ("ask", (|row: &SeedRow| row.ask) as fn(&SeedRow) -> f64, SeedRow::writes_ask as fn(&SeedRow) -> bool),
        ("bid", |row: &SeedRow| row.bid, SeedRow::writes_bid),
    ] {
        let mut sorted = rows.iter().filter(|row| writes(row)).collect::<Vec<_>>();
        if sorted.is_empty() {
            println!("  {side:<6} {:<7}: nothing to price", "");
            continue;
        }
        sorted.sort_by(|left, right| {
            price(left)
                .total_cmp(&price(right))
                .then(left.type_id.cmp(&right.type_id))
        });
        for (label, row) in [
            ("min", sorted[0]),
            ("median", sorted[sorted.len() / 2]),
            ("max", sorted[sorted.len() - 1]),
        ] {
            println!(
                "  {:<6} {:<7}: {:>24} ISK  {} ({}, bucket {})",
                side,
                label,
                crate::isk(price(row)),
                row.name,
                row.type_id,
                row.bucket
            );
        }
    }
}

fn print_anchors(rows: &[SeedRow]) {
    let index = rows
        .iter()
        .map(|row| (row.type_id, row))
        .collect::<BTreeMap<_, _>>();
    for (type_id, expectation) in [
        (ANCHOR_VENTURE, "expect ask 403,200.00 / bid 134,400.00"),
        (
            ANCHOR_TRITANIUM,
            "expect ask 100.00 (floored) / bid 2.00 (NOT floored)",
        ),
    ] {
        match index.get(&type_id) {
            Some(row) => println!(
                "  {:<14}: {} ({}) cost {} -> ask {} / bid {}  [{}]",
                "anchor",
                row.name,
                type_id,
                crate::isk(row.cost),
                if row.writes_ask() {
                    crate::isk(row.ask)
                } else {
                    "deferred".to_string()
                },
                if row.writes_bid() {
                    crate::isk(row.bid)
                } else {
                    "deferred".to_string()
                },
                expectation
            ),
            None => println!(
                "  {:<14}: type {} is NOT seeded ({})",
                "anchor", type_id, expectation
            ),
        }
    }
}

/// Plan piece 12, as a report a human can judge: how many rows, over how many types, drawn
/// around which price, and how the coverage splits across the three seeding mechanisms.
fn print_history_report(config: &SeederConfig, history: &HistoryPlan) {
    println!();
    println!(
        "{} {}",
        style("[price history]").cyan().bold(),
        config.history.label()
    );
    if history.row_count() == 0 {
        println!(
            "  {:<30}: nothing is written, so every market chart in the client stays empty.",
            "effect"
        );
        return;
    }
    let (first, last) = history
        .day_range
        .clone()
        .unwrap_or_else(|| ("?".to_string(), "?".to_string()));
    println!(
        "  {:<30}: {} rows = {} types x {} days, {} .. {} UTC (ends today)",
        "coverage",
        format_count(history.row_count()),
        format_count(history.types),
        history.days,
        first,
        last
    );
    println!(
        "  {:<30}: {}",
        "types by seeding mechanism",
        HistorySource::ALL
            .into_iter()
            .map(|source| format!("{} {}", format_count(history.source_count(source)), source.key()))
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "  {:<30}: the best seeded ask ANYWHERE — what a player actually pays — drifted ±5% \
         deterministically on (type_id, day)",
        "base price"
    );
    println!(
        "  {:<30}: {} types have no ask anywhere and are charted around their best bid instead",
        "  bid fallback",
        format_count(history.bid_fallbacks)
    );
    println!(
        "  {:<30}: price_history is keyed (type_id, day) with NO station or region column, so \
         one price per type is the whole series and there is nothing to reconcile per station",
        "why one price per type"
    );
    println!(
        "  {:<30}: {} days >= 2, so splitHistoryRows gives the client a non-empty old half \
         ({} rows) and new half (1 row)",
        "client split",
        history.days,
        history.days.saturating_sub(1)
    );
}

/// Reads three anchors' newest history rows straight back out of the staged database, using
/// the daemon's own query shape (`externalservices/market-server/src/state.rs:2119-2149`).
///
/// A plan that looks right and a table the daemon can actually serve are two different claims,
/// and this is the one that matters — the piece exists because the charts were empty. The
/// third anchor is a blueprint on purpose: blueprints are an excluded category for the index
/// and junk buckets, so a BPO with a chart proves the coverage reaches the NPC overlay.
fn print_history_anchors(connection: &Connection, history: &HistoryPlan) -> Result<()> {
    if history.row_count() == 0 {
        return Ok(());
    }
    let mut anchors: Vec<(u32, &str)> = vec![
        (ANCHOR_VENTURE, "index anchor"),
        (ANCHOR_TRITANIUM, "index anchor (floored)"),
    ];
    if let Some(blueprint) = history.blueprint_anchor() {
        anchors.push((blueprint.type_id, "overlay anchor (T1 BPO)"));
    }

    println!(
        "  {} the newest 3 rows of each anchor, read back through the daemon's own query:",
        style("spot-check:").bold()
    );
    for (type_id, label) in anchors {
        match history.base(type_id) {
            Some(base) => println!(
                "    {} {} ({}) — base {} ISK from its {}, {} source",
                label,
                base.name,
                type_id,
                crate::isk(base.base),
                base.basis.key(),
                base.source.key()
            ),
            None => {
                println!("    {label} type {type_id} has no history (nothing seeds it)");
                continue;
            }
        }
        for row in crate::history::recent_rows(connection, type_id, 3)? {
            println!(
                "      {}  low {:>18}  avg {:>18}  high {:>18}  vol {:>7}  orders {:>3}",
                row.day,
                crate::isk(row.low_price),
                crate::isk(row.avg_price),
                crate::isk(row.high_price),
                format_count(row.volume),
                row.order_count
            );
        }
    }
    Ok(())
}

fn print_row_table(rows: &[(&str, usize)]) {
    for (table, count) in rows {
        println!("  {:<24}: {:>9}", table, format_count(*count));
    }
}

/// Everything the closing report prints, so the two seed passes can each be reported
/// separately without a fourteen-argument function.
struct BuildSummaryFacts<'a> {
    database_path: &'a Path,
    backup_path: &'a Path,
    had_previous: bool,
    station: &'a SeedStation,
    solar_system_name: &'a str,
    plan: &'a SeedPlan,
    rows: &'a [SeedRow],
    static_counts: StaticCounts,
    overlay: Option<&'a crate::overlay::OverlayImport>,
    counts: SeedTableCounts,
    crossed_pairs: i64,
    region_summary_rows: usize,
    system_summary_rows: usize,
    manifest_rows: usize,
    history: &'a HistoryPlan,
    elapsed: StdDuration,
}

fn print_build_summary(facts: &BuildSummaryFacts<'_>) -> Result<()> {
    println!();
    println!(
        "{}",
        style(match (facts.overlay.is_some(), facts.history.row_count() > 0) {
            (true, true) => "TQ NPC overlay + Jita index seed + synthetic price history written.",
            (true, false) => {
                "TQ NPC overlay + Jita index seed written. price_history is EMPTY — charts will be blank."
            }
            (false, true) => {
                "Jita index seed + synthetic price history written. NPC overlay SKIPPED."
            }
            (false, false) => {
                "Jita index seed written. NPC overlay SKIPPED and price_history is EMPTY."
            }
        })
        .green()
        .bold()
    );
    println!(
        "{} {}",
        style("Database:").bold(),
        facts.database_path.to_string_lossy()
    );
    println!(
        "{} {}",
        style("Size:").bold(),
        format_bytes(fs::metadata(facts.database_path)?.len())
    );
    println!(
        "{} {} ({}, {}), system {}",
        style("Seed station:").bold(),
        facts.station.station_name,
        facts.station.station_id,
        facts.station.region_name,
        facts.solar_system_name
    );
    println!(
        "{} {}",
        style("Previous database:").bold(),
        if facts.had_previous {
            format!(
                "backed up to {} during the install, then deleted after it succeeded",
                facts.backup_path.to_string_lossy()
            )
        } else {
            "none — this build created the file".to_string()
        }
    );
    println!();
    print_row_table(&[
        ("regions", facts.static_counts.regions),
        ("solar_systems", facts.static_counts.solar_systems),
        ("stations", facts.static_counts.stations),
        ("market_types", facts.static_counts.market_types),
        ("seed_stock", facts.counts.sell_rows as usize),
        ("seed_buy_orders", facts.counts.buy_rows as usize),
        ("region_summaries", facts.region_summary_rows),
        ("system_seed_summaries", facts.system_summary_rows),
        ("price_history", facts.history.row_count()),
        ("manifest", facts.manifest_rows),
        ("market_orders", 0),
        ("market_order_events", 0),
    ]);

    // The two passes, counted apart: a single "seed rows" total hides which half moved.
    let (planned_sell, planned_buy) = planned_side_counts(facts.rows);
    println!();
    println!(
        "{} {} asks + {} bids at {} ({} types, one station)",
        style("Index + junk pass:").bold(),
        format_count(planned_sell),
        format_count(planned_buy),
        facts.station.station_name,
        format_count(facts.rows.len())
    );
    match facts.overlay {
        Some(overlay) => {
            let (replaced_sell, replaced_buy) =
                overlay_rows_replaced_at(overlay, facts.station.station_id, facts.rows);
            println!(
                "{} {} asks + {} bids across {} stations ({} types), from {} snapshot rows",
                style("NPC overlay pass:").bold(),
                format_count(overlay.sell_rows()),
                format_count(overlay.buy_rows()),
                format_count(overlay.stations().len()),
                format_count(overlay.types().len()),
                format_count(overlay.stats.source_rows)
            );
            println!(
                "  {} of its asks and {} of its bids sat at {} on an index-seeded type and were \
                 replaced by the index pass, which writes second and wins there.",
                format_count(replaced_sell),
                format_count(replaced_buy),
                facts.station.station_name
            );
        }
        None => println!(
            "{} skipped (--skip-overlay)",
            style("NPC overlay pass:").bold()
        ),
    }
    if facts.crossed_pairs > 0 {
        println!(
            "{} {} (station, type) pairs hold a bid above their own ask. None of them can be \
             ours — the index pass is verified crossing-free at its station — so these are TQ's \
             own prices, imported as-is. `market-seederv3 audit` is where they get judged.",
            style("Crossed pairs:").yellow().bold(),
            format_count(facts.crossed_pairs)
        );
    }

    println!();
    println!(
        "{} {} seedable ({} index, {} junk), {} not seeded ({} unpriced index, {} uncaptured \
         junk, {} deferred to the NPC catalog on both sides)",
        style("Plan:").bold(),
        format_count(facts.plan.seedable_count()),
        format_count(facts.plan.seedable_index_count()),
        format_count(facts.plan.seedable_junk_count()),
        format_count(facts.plan.dropped.len()),
        facts.plan.index_drop_count(),
        facts.plan.junk_drop_count(),
        format_count(facts.plan.deferred_count())
    );
    if facts.plan.deferral_count() > 0 {
        println!(
            "{} {} — a deferred side is a price of ours that would have crossed TQ's, so TQ \
             keeps that side at TQ's own stations and we stand down on it at {}.",
            style("Deferrals:").bold(),
            DeferredSide::ALL
                .into_iter()
                .map(|side| format!(
                    "{} {}",
                    format_count(facts.plan.deferred_side_count(side)),
                    side.key()
                ))
                .collect::<Vec<_>>()
                .join(", "),
            facts.station.station_name
        );
    }
    println!(
        "{} {}",
        style("Price history:").bold(),
        if facts.history.row_count() == 0 {
            "none written — every market chart in the client will be empty".to_string()
        } else {
            let (first, last) = facts
                .history
                .day_range
                .clone()
                .unwrap_or_else(|| ("?".to_string(), "?".to_string()));
            format!(
                "{} rows = {} types x {} days, {first} .. {last} UTC ({}). Base price is the \
                 best seeded ask anywhere ({} types fell back to their bid); price_history has \
                 no station dimension, so one series per type is all there is.",
                format_count(facts.history.row_count()),
                format_count(facts.history.types),
                facts.history.days,
                HistorySource::ALL
                    .into_iter()
                    .map(|source| format!(
                        "{} {}",
                        format_count(facts.history.source_count(source)),
                        source.key()
                    ))
                    .collect::<Vec<_>>()
                    .join(", "),
                format_count(facts.history.bid_fallbacks)
            )
        }
    );
    println!(
        "{} {:.1}s",
        style("Elapsed:").bold(),
        facts.elapsed.as_secs_f64()
    );
    Ok(())
}

// ------------------------------------------------------------------------------ helpers

/// v2 `main.rs:1941-1952`.
fn row_progress_bar(message: &str, total: u64) -> ProgressBar {
    let bar = ProgressBar::new(total.max(1));
    bar.set_style(
        ProgressStyle::with_template(
            "  [{bar:36.cyan/blue}] {percent:>3}% | {msg} | {pos}/{len} rows | eta {eta_precise}",
        )
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("=> "),
    );
    bar.set_message(message.to_string());
    bar
}

fn spinner(message: &str) -> ProgressBar {
    let spinner = ProgressBar::new_spinner();
    spinner.enable_steady_tick(StdDuration::from_millis(120));
    spinner.set_style(
        ProgressStyle::with_template("{spinner:.cyan} {msg}")
            .unwrap_or_else(|_| ProgressStyle::default_spinner()),
    );
    spinner.set_message(message.to_string());
    spinner
}

fn format_bytes(value: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let value_f = value as f64;
    if value_f >= GIB {
        format!("{:.2} GiB", value_f / GIB)
    } else if value_f >= MIB {
        format!("{:.2} MiB", value_f / MIB)
    } else if value_f >= KIB {
        format!("{:.2} KiB", value_f / KIB)
    } else {
        format!("{value} B")
    }
}

fn format_count<T>(value: T) -> String
where
    T: ToString,
{
    let digits = value.to_string();
    let mut parts = Vec::new();
    let mut end = digits.len();
    while end > 3 {
        parts.push(digits[end - 3..end].to_string());
        end -= 3;
    }
    parts.push(digits[..end].to_string());
    parts.reverse();
    parts.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUANTITY: i64 = 2_147_483_647;

    fn pricing() -> SeedPricing {
        SeedPricing {
            sell_multiplier: 3.0,
            buy_multiplier: 1.0,
            price_floor: 100.0,
        }
    }

    fn row(type_id: u32, name: &str, cost: f64, pricing: SeedPricing) -> SeedRow {
        SeedRow {
            type_id,
            name: name.to_string(),
            bucket: "B",
            junk: false,
            cost,
            ask: pricing.ask(cost),
            bid: pricing.bid(cost),
            sides: SeedSides::BOTH,
            quantity: QUANTITY,
        }
    }

    fn station() -> SeedStation {
        test_station()
    }

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory sqlite opens");
        connection.execute_batch(SCHEMA_SQL).expect("schema applies");
        connection
    }

    /// The whole reason `price_floor` is ask-only.
    ///
    /// Tritanium costs 2 ISK. Floor the bid as the plan text originally said and the seed
    /// pays 100 ISK for it — 50x cost. Buying a Venture at its 403,200 ask, reprocessing it
    /// and selling the minerals into floored bids returns 1,417,500 ISK: a 3.52x money pump
    /// that runs forever at int32-max quantities. The bid must track cost exactly.
    #[test]
    fn the_floor_lifts_the_ask_only_so_tritanium_cannot_pump_isk_through_reprocessing() {
        let pricing = pricing();

        // 2 ISK Tritanium: the ask is lifted to the floor, the bid is NOT.
        assert_eq!(pricing.ask(2.0), 100.0, "a 2 ISK cost asks at the 100 ISK floor");
        assert_eq!(pricing.bid(2.0), 2.0, "…and bids at cost, never at the floor");
        assert!(pricing.ask_is_floored(2.0));

        // The Venture anchor, well above the floor: both sides are pure multiples of cost.
        assert_eq!(pricing.ask(134_400.0), 403_200.0);
        assert_eq!(pricing.bid(134_400.0), 134_400.0);
        assert!(!pricing.ask_is_floored(134_400.0));

        // The pump itself, in numbers. A Venture reprocesses into (roughly) these minerals;
        // what matters is that the bid side pays cost, not the floor.
        let venture_ask = pricing.ask(134_400.0);
        let mineral_costs = [2.0_f64, 4.0, 20.0, 80.0];
        let quantities = [10_000.0_f64, 2_500.0, 500.0, 100.0];
        let floored_bid_payout: f64 = quantities
            .iter()
            .map(|quantity| quantity * 100.0_f64.max(0.0))
            .sum();
        let honest_bid_payout: f64 = mineral_costs
            .iter()
            .zip(quantities)
            .map(|(cost, quantity)| pricing.bid(*cost) * quantity)
            .sum();
        assert!(
            floored_bid_payout > venture_ask,
            "a floored bid would pay {floored_bid_payout} for a ship bought at {venture_ask}"
        );
        assert!(
            honest_bid_payout < venture_ask,
            "the cost-tracking bid pays {honest_bid_payout}, below the {venture_ask} ask, so \
             the loop is lossy"
        );

        // Sub-cent costs still never produce a free item or a zero bid.
        assert_eq!(pricing.bid(0.001), MIN_SEED_PRICE);
        let floorless = SeedPricing {
            price_floor: 0.0,
            ..pricing
        };
        assert_eq!(floorless.ask(0.001), MIN_SEED_PRICE);
        assert_eq!(floorless.bid(0.001), MIN_SEED_PRICE);
    }

    #[test]
    fn the_bid_never_exceeds_the_ask_and_a_bad_multiplier_pair_is_caught_by_name() {
        let good = vec![
            row(34, "Tritanium", 2.0, pricing()),
            row(32_880, "Venture", 134_400.0, pricing()),
        ];
        verify_seed_rows(&good, good.len(), QUANTITY, QUANTITY).expect("3x/1x is arbitrage-safe");

        // buy_multiplier above sell_multiplier: the bid crosses its own ask.
        let inverted = SeedPricing {
            sell_multiplier: 1.0,
            buy_multiplier: 3.0,
            price_floor: 100.0,
        };
        let bad = vec![row(32_880, "Venture", 134_400.0, inverted)];
        let error = verify_seed_rows(&bad, bad.len(), QUANTITY, QUANTITY)
            .expect_err("a bid above the ask must fail the build");
        let message = format!("{error:#}");
        assert!(message.contains("32880"), "{message}");
        assert!(message.contains("Venture"), "{message}");
        assert!(message.contains("index_seed"), "{message}");

        // The floor cannot create a crossed pair either: it lifts the ask, never the bid.
        let cheap = row(34, "Tritanium", 2.0, inverted);
        assert!(cheap.bid <= cheap.ask, "bid {} ask {}", cheap.bid, cheap.ask);
    }

    #[test]
    fn a_duplicated_type_is_caught_before_it_can_silently_shorten_the_row_count() {
        let duplicated = vec![
            row(34, "Tritanium", 2.0, pricing()),
            row(34, "Tritanium", 2.0, pricing()),
        ];
        // Two rows for two "seedable" types looks self-consistent by count alone; the
        // duplicate check is what catches it, and the seed tables would have written one row.
        let error = verify_seed_rows(&duplicated, 2, QUANTITY, QUANTITY)
            .expect_err("a duplicate type must fail the build");
        let message = format!("{error:#}");
        assert!(message.contains("34"), "{message}");
        assert!(message.contains("twice"), "{message}");

        // And the plain count mismatch is caught too, naming both numbers.
        let short = vec![row(34, "Tritanium", 2.0, pricing())];
        let error = verify_seed_rows(&short, 2, QUANTITY, QUANTITY)
            .expect_err("one row for two seedable types must fail");
        let message = format!("{error:#}");
        assert!(message.contains('2') && message.contains('1'), "{message}");

        // A row planned at the wrong quantity is caught by the same pass.
        let mut wrong = vec![row(34, "Tritanium", 2.0, pricing())];
        wrong[0].quantity = 1;
        let error = verify_seed_rows(&wrong, 1, QUANTITY, QUANTITY)
            .expect_err("a mis-quantified row must fail");
        assert!(format!("{error:#}").contains("index_seed"));
    }

    #[test]
    fn every_written_row_carries_the_configured_quantity_in_both_quantity_columns() {
        let mut connection = memory_db();
        let station = station();
        let rows = vec![
            row(34, "Tritanium", 2.0, pricing()),
            row(32_880, "Venture", 134_400.0, pricing()),
        ];
        let (sells, buys) = write_seed_rows(
            &mut connection,
            &station,
            &rows,
            "2026-08-10T00:00:00Z",
            SeedTableCounts::index_only(&rows),
            None,
        )
        .expect("the seed rows write");
        assert_eq!((sells, buys), (2, 2));

        for table in ["seed_stock", "seed_buy_orders"] {
            let mismatched: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE quantity <> initial_quantity"),
                    [],
                    |row| row.get(0),
                )
                .expect("query runs");
            assert_eq!(mismatched, 0, "{table} must write quantity into both columns");

            let off_target: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE quantity <> ?1"),
                    params![QUANTITY],
                    |row| row.get(0),
                )
                .expect("query runs");
            assert_eq!(off_target, 0, "{table} must write the configured quantity");

            let versions: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE price_version <> 1"),
                    [],
                    |row| row.get(0),
                )
                .expect("query runs");
            assert_eq!(versions, 0, "{table} must write price_version 1");
        }

        // The station geometry is denormalised onto every row.
        let (system, constellation, region): (u32, u32, u32) = connection
            .query_row(
                "SELECT solar_system_id, constellation_id, region_id FROM seed_stock WHERE type_id = 34",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("query runs");
        assert_eq!(
            (system, constellation, region),
            (
                station.solar_system_id,
                station.constellation_id,
                station.region_id
            )
        );

        // Tritanium: floored ask, honest bid, all the way through to the stored row.
        let (ask, bid): (f64, f64) = connection
            .query_row(
                "SELECT (SELECT price FROM seed_stock WHERE type_id = 34),
                        (SELECT price FROM seed_buy_orders WHERE type_id = 34)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("query runs");
        assert_eq!((ask, bid), (100.0, 2.0));
    }

    #[test]
    fn a_crossed_pair_aborts_the_write_transaction_instead_of_committing_it() {
        let mut connection = memory_db();
        let inverted = SeedPricing {
            sell_multiplier: 1.0,
            buy_multiplier: 3.0,
            price_floor: 0.0,
        };
        let rows = vec![row(32_880, "Venture", 134_400.0, inverted)];
        let error = write_seed_rows(
            &mut connection,
            &station(),
            &rows,
            "2026-08-10T00:00:00Z",
            SeedTableCounts::index_only(&rows),
            None,
        )
        .expect_err("the SQL invariant must reject a crossed pair");
        assert!(format!("{error:#}").contains("32880"), "{error:#}");

        // The transaction rolled back on drop, so nothing was left behind.
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM seed_stock", [], |row| row.get(0))
            .expect("query runs");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn summaries_over_one_seeded_station_take_that_station_s_own_price_and_quantity() {
        let mut connection = memory_db();
        let station = station();
        let rows = vec![
            row(34, "Tritanium", 2.0, pricing()),
            row(32_880, "Venture", 134_400.0, pricing()),
        ];
        write_seed_rows(
            &mut connection,
            &station,
            &rows,
            "2026-08-10T00:00:00Z",
            SeedTableCounts::index_only(&rows),
            None,
        )
        .expect("the seed rows write");

        let region_rows = rebuild_summaries(&mut connection, "region_summaries", "region_id")
            .expect("region summaries rebuild");
        let system_rows =
            rebuild_summaries(&mut connection, "system_seed_summaries", "solar_system_id")
                .expect("system summaries rebuild");
        assert_eq!(region_rows, rows.len());
        assert_eq!(system_rows, rows.len());

        for (table, key, key_value) in [
            ("region_summaries", "region_id", u64::from(station.region_id)),
            (
                "system_seed_summaries",
                "solar_system_id",
                u64::from(station.solar_system_id),
            ),
        ] {
            let (
                summary_key,
                best_ask,
                total_ask,
                ask_station,
                best_bid,
                total_bid,
                bid_station,
            ): (u64, f64, i64, u64, f64, i64, u64) = connection
                .query_row(
                    &format!(
                        "SELECT {key}, best_ask_price, total_ask_quantity, best_ask_station_id,
                                best_bid_price, total_bid_quantity, best_bid_station_id
                           FROM {table} WHERE type_id = 32880"
                    ),
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .expect("query runs");
            assert_eq!(summary_key, key_value, "{table}");
            assert_eq!(best_ask, 403_200.0, "{table} best ask is our own ask");
            assert_eq!(best_bid, 134_400.0, "{table} best bid is our own bid");
            assert_eq!(total_ask, QUANTITY, "{table} total is the one row's quantity");
            assert_eq!(total_bid, QUANTITY, "{table}");
            assert_eq!(ask_station, station.station_id, "{table}");
            assert_eq!(bid_station, station.station_id, "{table}");
        }

        // A rebuild is idempotent: it deletes before it inserts.
        let again = rebuild_summaries(&mut connection, "region_summaries", "region_id")
            .expect("region summaries rebuild again");
        assert_eq!(again, rows.len());
        let total: i64 = connection
            .query_row("SELECT COUNT(*) FROM region_summaries", [], |row| row.get(0))
            .expect("query runs");
        assert_eq!(total, rows.len() as i64);
    }

    #[test]
    fn the_summary_quantity_sum_cannot_overflow_i64_at_the_configured_quantity() {
        // One seeded station today; the headroom says how many it would take to matter.
        let headroom = summary_sum_headroom(1, QUANTITY).expect("one station cannot overflow");
        assert_eq!(headroom, i64::MAX / QUANTITY);
        assert!(headroom > 4_000_000_000, "headroom is {headroom} stations");

        // Every station in New Eden (~5,200) at the int32 ceiling is still nowhere near it.
        summary_sum_headroom(5_200, QUANTITY).expect("the whole universe still fits");

        // And the guard does bite when asked something absurd.
        assert!(summary_sum_headroom(u64::MAX, QUANTITY).is_err());
    }

    /// One overlay book, written the way a snapshot import would produce it.
    fn overlay(rows: &[(u64, u32, bool, f64, u64)]) -> crate::overlay::OverlayImport {
        let mut import = crate::overlay::OverlayImport::default();
        for (station_id, type_id, is_buy, price, quantity) in rows {
            let liquidity = crate::overlay::SeedLiquidity {
                station_id: *station_id,
                solar_system_id: 30_000_142,
                constellation_id: 20_000_020,
                region_id: 10_000_002,
                type_id: *type_id,
                price_cents: (*price * 100.0).round() as i64,
                quantity: *quantity,
            };
            let book = if *is_buy {
                &mut import.buy
            } else {
                &mut import.sell
            };
            book.insert((*station_id, *type_id), liquidity);
        }
        import
    }

    const RENS: u64 = 60_004_588;
    /// Expert Systems: Standard Cruiser — a type only TQ's NPCs seed, so nothing in the index
    /// plan touches it.
    const OVERLAY_ONLY: u32 = 3_380;

    /// The ordering rule the whole two-pass build hangs on.
    ///
    /// TQ sells the Venture at Jita 4-4 too. The overlay writes first, the index pass writes
    /// second with `INSERT OR REPLACE`, and the outcome must be: our computed price at Jita
    /// 4-4, TQ's price everywhere else, and every overlay-only type left alone.
    #[test]
    fn the_index_pass_wins_at_its_own_station_and_the_overlay_survives_everywhere_else() {
        let mut connection = memory_db();
        let station = station();

        // TQ's book: a Venture ask + bid at Jita 4-4 AND at Rens, plus a skillbook at Rens.
        let import = overlay(&[
            (station.station_id, 32_880, false, 500_000.0, 12),
            (station.station_id, 32_880, true, 480_000.0, 40),
            (RENS, 32_880, false, 600_000.0, 3),
            (RENS, 32_880, true, 450_000.0, 7),
            (RENS, OVERLAY_ONLY, false, 20_000.0, 55),
        ]);
        let (overlay_sells, overlay_buys) =
            crate::overlay::write_overlay_rows(&mut connection, &import, "2026-08-10T00:00:00Z", None)
                .expect("the overlay writes");
        assert_eq!((overlay_sells, overlay_buys), (3, 2));

        // Then our own pass, over the top.
        let rows = vec![
            row(34, "Tritanium", 2.0, pricing()),
            row(32_880, "Venture", 252_906.5, pricing()),
        ];
        let (replaced_sell, replaced_buy) =
            overlay_rows_replaced_at(&import, station.station_id, &rows);
        assert_eq!(
            (replaced_sell, replaced_buy),
            (1, 1),
            "exactly the Venture's two Jita rows are overwritten, not the Rens ones"
        );
        let expected = SeedTableCounts::after_overlay(
            &rows,
            import.sell_rows(),
            import.buy_rows(),
            replaced_sell,
            replaced_buy,
        );
        assert_eq!(expected, SeedTableCounts { sell_rows: 4, buy_rows: 3 });

        write_seed_rows(
            &mut connection,
            &station,
            &rows,
            "2026-08-10T00:00:00Z",
            expected,
            None,
        )
        .expect("the index pass writes over the overlay");

        let price = |table: &str, station_id: u64, type_id: u32| -> Option<f64> {
            connection
                .query_row(
                    &format!("SELECT price FROM {table} WHERE station_id = ?1 AND type_id = ?2"),
                    params![station_id, type_id],
                    |row| row.get(0),
                )
                .ok()
        };

        // Jita 4-4: ours, not TQ's.
        assert_eq!(
            price("seed_stock", station.station_id, 32_880),
            Some(pricing().ask(252_906.5)),
            "the index ask must survive the overlay's 500,000 TQ price"
        );
        assert_eq!(
            price("seed_buy_orders", station.station_id, 32_880),
            Some(pricing().bid(252_906.5))
        );
        // Rens: TQ's, untouched.
        assert_eq!(price("seed_stock", RENS, 32_880), Some(600_000.0));
        assert_eq!(price("seed_buy_orders", RENS, 32_880), Some(450_000.0));
        assert_eq!(price("seed_stock", RENS, OVERLAY_ONLY), Some(20_000.0));
        // And the type only we seed exists only where we put it.
        assert_eq!(price("seed_stock", station.station_id, 34), Some(100.0));
        assert_eq!(price("seed_stock", RENS, 34), None);

        // Overlay rows keep the snapshot's volume; index rows keep the configured quantity.
        let overlay_quantity: i64 = connection
            .query_row(
                "SELECT quantity FROM seed_stock WHERE station_id = ?1 AND type_id = ?2",
                params![RENS, 32_880u32],
                |row| row.get(0),
            )
            .expect("query runs");
        assert_eq!(overlay_quantity, 3);
        let index_quantity: i64 = connection
            .query_row(
                "SELECT quantity FROM seed_stock WHERE station_id = ?1 AND type_id = ?2",
                params![station.station_id, 32_880u32],
                |row| row.get(0),
            )
            .expect("query runs");
        assert_eq!(index_quantity, QUANTITY);
    }

    /// The other order, caught rather than shipped.
    #[test]
    fn an_overlay_row_left_standing_at_the_index_station_fails_the_build_by_name() {
        let mut connection = memory_db();
        let station = station();
        let import = overlay(&[
            (station.station_id, 32_880, false, 500_000.0, 12),
            (station.station_id, 32_880, true, 480_000.0, 40),
        ]);
        crate::overlay::write_overlay_rows(&mut connection, &import, "2026-08-10T00:00:00Z", None)
            .expect("the overlay writes");

        // Exactly what running the passes the wrong way round leaves behind: TQ's price
        // sitting where ours should be. Nothing about the row count gives it away.
        let rows = vec![row(32_880, "Venture", 252_906.5, pricing())];
        let error = verify_index_pass_won(&connection, &rows, station.station_id)
            .expect_err("a TQ price at the index station must fail the build");
        let message = format!("{error:#}");
        assert!(message.contains("32880"), "{message}");
        assert!(message.contains("500000"), "{message}");
        assert!(message.contains("BEFORE"), "{message}");

        // A missing row is caught too, with its own message.
        let missing = vec![row(34, "Tritanium", 2.0, pricing())];
        let error = verify_index_pass_won(&connection, &missing, station.station_id)
            .expect_err("a planned type with no row must fail");
        assert!(format!("{error:#}").contains("no ask row"), "{error:#}");
    }

    /// TQ's own crossed pairs are reported, not enforced — the build only owns its own rows.
    #[test]
    fn a_crossed_overlay_pair_is_counted_and_left_alone_while_ours_still_aborts() {
        let mut connection = memory_db();
        let station = station();
        // Rens bids 90 for a type it sells at 50: TQ's problem, imported as-is.
        let import = overlay(&[
            (RENS, OVERLAY_ONLY, false, 50.0, 4),
            (RENS, OVERLAY_ONLY, true, 90.0, 4),
        ]);
        crate::overlay::write_overlay_rows(&mut connection, &import, "2026-08-10T00:00:00Z", None)
            .expect("the overlay writes");

        let rows = vec![row(34, "Tritanium", 2.0, pricing())];
        write_seed_rows(
            &mut connection,
            &station,
            &rows,
            "2026-08-10T00:00:00Z",
            SeedTableCounts::after_overlay(&rows, 1, 1, 0, 0),
            None,
        )
        .expect("a crossed pair at another station must not fail our build");
        assert_eq!(
            count_crossed_pairs(&connection).expect("the count runs"),
            1,
            "it is reported instead, and the audit is what judges it"
        );
    }

    /// **Per-side deferral, end to end at the write.** A type whose ask was deferred writes
    /// only its bid, and TQ's own ask at the index station is left exactly where the overlay
    /// put it — which is the point of deferring, and the thing the row-count arithmetic has to
    /// agree with.
    #[test]
    fn a_deferred_ask_writes_only_the_bid_and_leaves_tqs_row_standing_at_the_index_station() {
        let mut connection = memory_db();
        let station = station();
        // TQ holds the Venture on both sides at Jita 4-4 and sells a skillbook at Rens.
        let import = overlay(&[
            (station.station_id, 32_880, false, 500_000.0, 12),
            (station.station_id, 32_880, true, 480_000.0, 40),
            (RENS, OVERLAY_ONLY, false, 20_000.0, 55),
        ]);
        crate::overlay::write_overlay_rows(&mut connection, &import, "2026-08-10T00:00:00Z", None)
            .expect("the overlay writes");

        // Our Venture ask crossed TQ's 480,000 buyback, so the plan kept only the bid.
        let mut venture = row(32_880, "Venture", 252_906.5, pricing());
        venture.sides = SeedSides {
            ask: false,
            bid: true,
        };
        let rows = vec![row(34, "Tritanium", 2.0, pricing()), venture];
        assert_eq!(planned_side_counts(&rows), (1, 2));

        let (replaced_sell, replaced_buy) =
            overlay_rows_replaced_at(&import, station.station_id, &rows);
        assert_eq!(
            (replaced_sell, replaced_buy),
            (0, 1),
            "only the bid is ours now, so only TQ's Jita bid is replaced"
        );
        let expected = SeedTableCounts::after_overlay(
            &rows,
            import.sell_rows(),
            import.buy_rows(),
            replaced_sell,
            replaced_buy,
        );
        // 2 overlay asks + 1 planned ask - 0 replaced; 1 overlay bid + 2 planned bids - 1.
        assert_eq!(expected, SeedTableCounts { sell_rows: 3, buy_rows: 2 });

        let (sell_rows, buy_rows) = write_seed_rows(
            &mut connection,
            &station,
            &rows,
            "2026-08-10T00:00:00Z",
            expected,
            None,
        )
        .expect("a one-sided row set writes and verifies");
        assert_eq!((sell_rows, buy_rows), (1, 2));

        let price = |table: &str, station_id: u64, type_id: u32| -> Option<f64> {
            connection
                .query_row(
                    &format!("SELECT price FROM {table} WHERE station_id = ?1 AND type_id = ?2"),
                    params![station_id, type_id],
                    |row| row.get(0),
                )
                .ok()
        };
        assert_eq!(
            price("seed_stock", station.station_id, 32_880),
            Some(500_000.0),
            "TQ still sells the Venture at Jita: our ask was deferred, not overwritten by it"
        );
        assert_eq!(
            price("seed_buy_orders", station.station_id, 32_880),
            Some(pricing().bid(252_906.5)),
            "…and our bid still won the side we did write"
        );
        assert_eq!(price("seed_stock", station.station_id, 34), Some(100.0));

        // And a leaked deferred side is caught: put our computed ask back where the plan said
        // it must not be, and the same verification that passed above now fails by name.
        connection
            .execute(
                "UPDATE seed_stock SET price = ?1 WHERE station_id = ?2 AND type_id = ?3",
                params![pricing().ask(252_906.5), station.station_id, 32_880u32],
            )
            .expect("the update runs");
        let error = verify_index_pass_won(&connection, &rows, station.station_id)
            .expect_err("a deferred side that carries our price must fail the build");
        let message = format!("{error:#}");
        assert!(message.contains("32880"), "{message}");
        assert!(message.contains("deferred to the NPC catalog"), "{message}");
    }

    /// A planned row that writes nothing is a plan bug, not a no-op: the type should have been
    /// dropped instead.
    #[test]
    fn a_planned_row_with_neither_side_is_rejected_before_anything_is_written() {
        let mut nothing = row(34, "Tritanium", 2.0, pricing());
        nothing.sides = SeedSides {
            ask: false,
            bid: false,
        };
        let rows = vec![nothing];
        let error = verify_seed_rows(&rows, rows.len(), QUANTITY, QUANTITY)
            .expect_err("a row that writes neither side must be refused");
        let message = format!("{error:#}");
        assert!(message.contains("34"), "{message}");
        assert!(message.contains("neither an ask nor a bid"), "{message}");
    }

    #[test]
    fn plan_rows_price_index_and_junk_buckets_from_their_own_config_sections() {
        // Bucket D carries its own multipliers and quantity; the ask floor is shared.
        let index = pricing();
        let junk = SeedPricing {
            sell_multiplier: 5.0,
            buy_multiplier: 0.5,
            price_floor: 100.0,
        };
        assert_eq!(index.ask(1_000.0), 3_000.0);
        assert_eq!(junk.ask(1_000.0), 5_000.0);
        assert_eq!(junk.bid(1_000.0), 500.0);
        assert!(junk.bid(1_000.0) <= junk.ask(1_000.0));
    }
}
