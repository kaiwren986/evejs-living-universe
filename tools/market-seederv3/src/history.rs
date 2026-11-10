//! Synthetic `price_history` — plan piece 12, so the client's market charts are not empty.
//!
//! ### The bug this closes
//!
//! Every v3 build so far wrote `price_history` with **zero rows**. The market daemon serves
//! that table from `query_history_rows_with_connection`
//! (`externalservices/market-server/src/state.rs:2119-2149`):
//!
//! ```sql
//! SELECT day, low_price, high_price, avg_price, volume, order_count
//!   FROM price_history WHERE type_id = ?1 ORDER BY day ASC
//! ```
//!
//! …with no limit and no station or region filter. The Node proxy then splits whatever comes
//! back into the client's "old" and "new" rowsets in `splitHistoryRows`
//! (`server/src/services/market/marketProxyService.js:429-447`): **old is every row but the
//! last, new is the last row**. So an empty table means an empty chart, and a table with one
//! single day means an empty "old" half. **At least two days must exist** for both halves to
//! be non-empty, which is why [`crate::config::HistoryConfig`] defaults to 30 and why
//! [`verify_history_table`] refuses to leave a one-day build behind.
//!
//! ### The shape, ported from v1
//!
//! The generator is v1's, verbatim in behaviour — `tools/market-seed/src/main.rs:1326-1418`
//! (`build_price_history_rows` / `write_price_history_rows`):
//!
//! ```text
//! day        = today_utc - (days - 1 - day_offset), formatted YYYY-MM-DD
//! drift      = (((type_id * 37 + day_offset * 13) % 101) - 50) / 1000     // ±5%
//! avg        = round_isk(max(base * (1 + drift), floor))
//! low        = round_isk(avg * 0.985)
//! high       = round_isk(avg * 1.015)
//! volume     = 100 + type_id % 500 + day_offset * 3
//! order_count= 10 + type_id % 20
//! ```
//!
//! It is deterministic in `(type_id, day_offset)` alone, so two builds on the same day from
//! the same seed produce byte-identical history, and it is bounded to ±5% so a chart wobbles
//! around the price the item actually sells for instead of wandering.
//!
//! ### What is different in v3: the base price is the seeded ask
//!
//! v1 drifted the SDE `basePrice`, falling back to a synthesised number when there was none.
//! That is not the price anyone pays here. v3 drifts **the price a player actually pays to
//! buy the type from the seed**: the best ask across all stations, taken from exactly the
//! same [`crate::audit::SeedBook`] the audit prices its checks off — index rows, junk rows and
//! the TQ NPC overlay together, so BPOs and skillbooks get charts too. A type seeded on the
//! bid side only (its ask was deferred to the NPC catalog, or TQ only buys it back) has no
//! ask to drift and falls back to its best bid; the count of those is reported. A type with
//! no seed row anywhere gets no history at all — an item nobody sells has no price to chart,
//! and inventing one would be the only place in this seeder that made a price up.
//!
//! ### Why one price per type is the whole story
//!
//! `price_history` is keyed `(type_id, day)` and has **no station or region column**
//! (`externalservices/market-server/crates/market-common/src/lib.rs:188-197`) — it is global
//! per type. Asks are per station, so the two do not line up one-to-one; but because the
//! table cannot express a per-station series there is nothing to reconcile. The single best
//! ask anywhere is the same number the audit uses as "what this costs to buy", and the same
//! number a player sees at the top of the book, so that is the one the chart is drawn around.
//!
//! ### It cannot move a price
//!
//! Nothing here writes `seed_stock`, `seed_buy_orders`, the summaries or the manifest's
//! prices; it only reads the finished book. `market-seederv3 audit` must therefore come back
//! byte-identical with history on or off, and that is the check the piece is verified with.

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use indicatif::ProgressBar;
use market_common::round_isk;
use rusqlite::{Connection, params};
use time::{Date, Duration, OffsetDateTime};

use crate::audit::SeedBook;
use crate::build::MIN_SEED_PRICE;

/// One `price_history` row: the schema's seven columns, nothing else.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryRow {
    pub type_id: u32,
    /// `YYYY-MM-DD`, UTC.
    pub day: String,
    pub low_price: f64,
    pub high_price: f64,
    pub avg_price: f64,
    pub volume: u64,
    pub order_count: u32,
}

/// Which side of the book a type's base price came from.
///
/// [`Self::Bid`] is the fallback, not a second choice of equal standing: the chart is meant to
/// show what buying the thing costs. A type reaches it only when nothing sells it anywhere —
/// its ask was deferred to the NPC catalog, or TQ merely buys it back and never offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryBasis {
    Ask,
    Bid,
}

impl HistoryBasis {
    pub fn key(self) -> &'static str {
        match self {
            Self::Ask => "best-ask-anywhere",
            Self::Bid => "best-bid-anywhere (no ask)",
        }
    }
}

/// Which mechanism seeded a type, for the report split.
///
/// Read off the [`crate::audit::SeedBook`] bucket label, so it is the same partition every
/// other v3 report uses. Note that [`Self::Overlay`] means **overlay-only**: a type our index
/// pass seeds *and* the overlay also carries keeps its index bucket, because that is the row
/// whose price the chart is drawn around.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum HistorySource {
    /// Buckets A, A+B and B — the computed index seed.
    Index,
    /// Bucket D — the market-priced junk seed.
    Junk,
    /// Bucket C — a type only the TQ NPC overlay seeds (BPOs, skillbooks, trade goods).
    Overlay,
}

impl HistorySource {
    pub const ALL: [Self; 3] = [Self::Index, Self::Junk, Self::Overlay];

    pub fn key(self) -> &'static str {
        match self {
            Self::Index => "index",
            Self::Junk => "junk",
            Self::Overlay => "overlay",
        }
    }

    /// The `SeedBook` bucket labels, as [`crate::audit::SeedSide::bucket`] spells them.
    pub fn from_bucket(bucket: &str) -> Self {
        match bucket {
            "D" => Self::Junk,
            "C" => Self::Overlay,
            // "A", "A+B", "B" — and anything unexpected, which is an index row by
            // construction: only `SeedBook::merge_overlay` ever writes a label we did not.
            _ => Self::Index,
        }
    }
}

/// One type's base price, resolved once and then drifted across every day.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryBase {
    pub type_id: u32,
    pub name: String,
    pub source: HistorySource,
    pub basis: HistoryBasis,
    /// The price the whole series is drifted around.
    pub base: f64,
}

/// The rows plus everything the build has to report about them.
#[derive(Debug, Clone, Default)]
pub struct HistoryPlan {
    /// One entry per covered type, in ascending type order.
    pub bases: Vec<HistoryBase>,
    pub rows: Vec<HistoryRow>,
    /// Days per type. 0 when history is disabled or `[history] days = 0`.
    pub days: u32,
    /// Distinct types covered — one per [`HistoryBase`].
    pub types: usize,
    /// `(oldest, newest)` day, `None` when nothing was planned.
    pub day_range: Option<(String, String)>,
    /// Types per seeding mechanism, in [`HistorySource::ALL`] order.
    pub by_source: BTreeMap<HistorySource, usize>,
    /// Types with no ask anywhere, drifted around their best bid instead.
    pub bid_fallbacks: usize,
}

impl HistoryPlan {
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    pub fn source_count(&self, source: HistorySource) -> usize {
        self.by_source.get(&source).copied().unwrap_or(0)
    }

    pub fn base(&self, type_id: u32) -> Option<&HistoryBase> {
        self.bases.iter().find(|base| base.type_id == type_id)
    }

    /// A T1 blueprint original the **overlay** put in the book, for the build's spot-check.
    ///
    /// BPOs are the clearest proof that the piece covers more than our own index seed: nothing
    /// in the index or junk buckets can produce one (blueprints are an excluded category), so a
    /// blueprint with a chart can only have come from the TQ NPC overlay. Lowest type ID wins,
    /// so the anchor is stable from build to build.
    pub fn blueprint_anchor(&self) -> Option<&HistoryBase> {
        self.bases
            .iter()
            .filter(|base| base.source == HistorySource::Overlay)
            .find(|base| base.name.ends_with("Blueprint"))
    }

}

/// `YYYY-MM-DD`, UTC — the exact spelling v1's `DAY_FORMAT` produces
/// (`tools/market-seed/src/main.rs:28`), written out by hand so v3 does not need `time`'s
/// `macros` feature for one format string. The daemon orders on this column as TEXT, so the
/// zero padding is load-bearing: `2026-8-9` would sort after `2026-10-01`.
pub fn format_day(date: Date) -> String {
    let (year, month, day) = date.to_calendar_date();
    format!("{year:04}-{:02}-{day:02}", u8::from(month))
}

/// Today, UTC. Split out so tests can pin a date.
pub fn today_utc() -> Date {
    OffsetDateTime::now_utc().date()
}

/// The `days` calendar days **ending on `today`**, oldest first. Empty when `days == 0`.
pub fn history_days(today: Date, days: u32) -> Vec<String> {
    (0..days)
        .map(|day_offset| {
            format_day(today - Duration::days(i64::from(days - 1 - day_offset)))
        })
        .collect()
}

/// v1's deterministic drift, `tools/market-seed/src/main.rs:1360-1362`: an integer hash of
/// `(type_id, day_offset)` folded into `[-0.050, +0.050]` in steps of 0.001.
///
/// Deterministic on purpose. A rebuild on the same day from the same seed must produce the
/// same chart, or every rebuild would look like a market event to anyone reading one.
pub fn drift(type_id: u32, day_offset: u32) -> f64 {
    ((((type_id as i64 * 37) + (day_offset as i64 * 13)) % 101) - 50) as f64 / 1000.0
}

/// Every type the book holds a price for, with the price the chart is drawn around.
///
/// Ask first, bid as the fallback. A book entry always carries at least one of the two — it
/// only exists because some seed row put it there — so this never invents a base.
pub fn history_bases(book: &SeedBook) -> Vec<HistoryBase> {
    book.iter()
        .filter_map(|side| {
            let (base, basis) = match (side.ask.price(), side.bid.price()) {
                (Some(ask), _) => (ask, HistoryBasis::Ask),
                (None, Some(bid)) => (bid, HistoryBasis::Bid),
                // Unreachable through `SeedBook`, which only ever inserts a priced side, but
                // an entry with neither price has nothing to chart and is not worth a panic.
                (None, None) => return None,
            };
            (base.is_finite() && base > 0.0).then(|| HistoryBase {
                type_id: side.type_id,
                name: side.name.clone(),
                source: HistorySource::from_bucket(side.bucket),
                basis,
                base,
            })
        })
        .collect()
}

/// Builds the whole row set: one series per base, `days` rows each, oldest day first.
///
/// `price_floor` is `[index_seed] price_floor` — the same number the ask itself is floored at,
/// so a chart never dips below a price the seed would actually honour. It is additionally
/// clamped to [`MIN_SEED_PRICE`] so a deliberately floorless config still cannot write a
/// 0.00 price into a chart.
pub fn build_history_rows(bases: &[HistoryBase], days: u32, today: Date, price_floor: f64) -> Vec<HistoryRow> {
    if days == 0 || bases.is_empty() {
        return Vec::new();
    }
    let floor = price_floor.max(MIN_SEED_PRICE);
    let calendar = history_days(today, days);
    let mut rows = Vec::with_capacity(bases.len() * days as usize);
    for base in bases {
        for (day_offset, day) in calendar.iter().enumerate() {
            let day_offset = day_offset as u32;
            let avg_price = round_isk((base.base * (1.0 + drift(base.type_id, day_offset))).max(floor));
            rows.push(HistoryRow {
                type_id: base.type_id,
                day: day.clone(),
                low_price: round_isk(avg_price * 0.985),
                high_price: round_isk(avg_price * 1.015),
                avg_price,
                volume: 100 + u64::from(base.type_id % 500) + u64::from(day_offset * 3),
                order_count: 10 + (base.type_id % 20),
            });
        }
    }
    rows
}

/// Resolve the whole piece from the finished book: bases, rows and every number the report
/// needs. `days == 0` is a legal no-op, not an error.
pub fn plan_history(book: &SeedBook, days: u32, today: Date, price_floor: f64) -> HistoryPlan {
    let bases = history_bases(book);
    let mut by_source: BTreeMap<HistorySource, usize> = BTreeMap::new();
    for base in &bases {
        *by_source.entry(base.source).or_insert(0) += 1;
    }
    let bid_fallbacks = bases
        .iter()
        .filter(|base| base.basis == HistoryBasis::Bid)
        .count();
    let rows = build_history_rows(&bases, days, today, price_floor);
    let calendar = history_days(today, days);
    let day_range = match (calendar.first(), calendar.last()) {
        (Some(first), Some(last)) if !rows.is_empty() => Some((first.clone(), last.clone())),
        _ => None,
    };
    HistoryPlan {
        days: if bases.is_empty() { 0 } else { days },
        types: if days == 0 { 0 } else { bases.len() },
        bases,
        rows,
        day_range,
        by_source,
        bid_fallbacks,
    }
}

/// Writes the rows, then re-asks the same questions in SQL **inside the transaction**, so a
/// bad chart can never be committed.
///
/// `DELETE FROM price_history` first, exactly as v1's `write_price_history_rows`
/// (`tools/market-seed/src/main.rs:1395`). `write_static_tables` has already cleared the
/// table on the build path; keeping it here makes the writer correct on its own and is the
/// one line that stops a re-run doubling a series.
pub fn write_history_rows(
    connection: &mut Connection,
    rows: &[HistoryRow],
    expected_types: usize,
    expected_days: u32,
    progress: Option<&ProgressBar>,
) -> Result<u64> {
    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM price_history", [])?;
    {
        let mut statement = transaction.prepare(
            "INSERT INTO price_history (
               type_id, day, low_price, high_price, avg_price, volume, order_count
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for row in rows {
            statement.execute(params![
                row.type_id,
                row.day,
                row.low_price,
                row.high_price,
                row.avg_price,
                row.volume,
                row.order_count
            ])?;
            if let Some(progress) = progress {
                progress.inc(1);
            }
        }
    }
    verify_history_table(&transaction, expected_types, expected_days)?;
    transaction.commit()?;
    Ok(rows.len() as u64)
}

/// The invariants, asked of the database rather than of the plan, while the transaction can
/// still be thrown away.
///
/// The two-day arm is the one that is really about the client rather than about the data:
/// `splitHistoryRows` hands the client everything-but-the-last as "old" and the last row as
/// "new", so a single-day table renders a chart with an empty history half. A build that
/// wrote one day would look like it worked and produce the same empty chart the whole piece
/// exists to fix.
pub fn verify_history_table(
    connection: &Connection,
    expected_types: usize,
    expected_days: u32,
) -> Result<()> {
    let rows: i64 = connection.query_row("SELECT COUNT(*) FROM price_history", [], |row| row.get(0))?;
    let expected_rows = expected_types as i64 * i64::from(expected_days);
    if rows != expected_rows {
        bail!(
            "price_history holds {rows} rows but {expected_types} types x {expected_days} days \
             is {expected_rows}"
        );
    }
    if rows == 0 {
        // Nothing planned, nothing to check. `[history] enabled = false` and `days = 0` are
        // legal settings, not failures.
        return Ok(());
    }

    if expected_days < 2 {
        bail!(
            "price_history was written with {expected_days} day per type. The Node proxy splits \
             the daemon's rows into \"old\" (every row but the last) and \"new\" (the last row) \
             in splitHistoryRows (server/src/services/market/marketProxyService.js:429-447), so \
             fewer than 2 days leaves the client's history half empty — the same empty chart \
             this table exists to fill. Set [history] days >= 2, or 0 to write no history at \
             all."
        );
    }

    let (types, distinct_days): (i64, i64) = connection.query_row(
        "SELECT COUNT(DISTINCT type_id), COUNT(DISTINCT day) FROM price_history",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if types != expected_types as i64 {
        bail!("price_history covers {types} types, expected {expected_types}");
    }
    if distinct_days != i64::from(expected_days) {
        bail!(
            "price_history spans {distinct_days} distinct days, expected {expected_days}. A gap \
             or a duplicate day would draw a chart with a hole in it."
        );
    }

    // Every type must carry the full series. A short one is a chart that stops early.
    let ragged: Option<(u32, i64)> = connection
        .query_row(
            "SELECT type_id, COUNT(*) AS days FROM price_history
              GROUP BY type_id HAVING days <> ?1 LIMIT 1",
            params![expected_days],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if let Some((type_id, days)) = ragged {
        bail!("type {type_id} holds {days} history rows, expected {expected_days}");
    }

    // NOT NULL is in the schema, so a NULL cannot be stored; what SQL has to answer is
    // whether the three prices are ordered and positive.
    let bad: Option<(u32, String, f64, f64, f64)> = connection
        .query_row(
            "SELECT type_id, day, low_price, avg_price, high_price FROM price_history
              WHERE low_price > avg_price OR avg_price > high_price
                 OR low_price <= 0 OR avg_price <= 0 OR high_price <= 0
              LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .ok();
    if let Some((type_id, day, low, avg, high)) = bad {
        bail!(
            "type {type_id} on {day} has low {low} / avg {avg} / high {high}: every history row \
             must satisfy 0 < low <= avg <= high."
        );
    }

    let bad_counts: Option<(u32, String)> = connection
        .query_row(
            "SELECT type_id, day FROM price_history WHERE volume <= 0 OR order_count <= 0 LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    if let Some((type_id, day)) = bad_counts {
        bail!("type {type_id} on {day} has a non-positive volume or order_count");
    }

    Ok(())
}

/// Reads the newest `limit` rows for one type straight back out of the database — the
/// spot-check the build prints for its anchors, and the same query shape the daemon runs.
pub fn recent_rows(connection: &Connection, type_id: u32, limit: usize) -> Result<Vec<HistoryRow>> {
    let mut statement = connection.prepare(
        "SELECT day, low_price, high_price, avg_price, volume, order_count
           FROM price_history WHERE type_id = ?1 ORDER BY day DESC LIMIT ?2",
    )?;
    let mut rows = statement
        .query_map(params![type_id, limit as i64], |row| {
            Ok(HistoryRow {
                type_id,
                day: row.get(0)?,
                low_price: row.get(1)?,
                high_price: row.get(2)?,
                avg_price: row.get(3)?,
                volume: row.get::<_, i64>(4)? as u64,
                order_count: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.reverse();
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    use market_common::SCHEMA_SQL;
    use time::Month;

    use crate::audit::{BestPrice, PriceOrigin, SeedSide, StationPrice};

    fn day(year: i32, month: Month, day: u8) -> Date {
        Date::from_calendar_date(year, month, day).expect("a real date")
    }

    fn priced(price: f64, station_id: u64) -> BestPrice {
        let mut best = BestPrice::default();
        best.absorb_ask(StationPrice {
            price,
            station_id,
            station_name: format!("station {station_id}"),
            origin: PriceOrigin::Seeder,
        });
        best
    }

    fn side(type_id: u32, bucket: &'static str, ask: Option<f64>, bid: Option<f64>) -> SeedSide {
        SeedSide {
            type_id,
            name: format!("type {type_id}"),
            bucket,
            cost: 0.0,
            ask: ask.map(|price| priced(price, 60_003_760)).unwrap_or_default(),
            bid: bid.map(|price| priced(price, 60_003_760)).unwrap_or_default(),
        }
    }

    fn book(sides: impl IntoIterator<Item = SeedSide>) -> SeedBook {
        let mut book = SeedBook::default();
        for side in sides {
            book.insert(side);
        }
        book
    }

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory sqlite opens");
        connection.execute_batch(SCHEMA_SQL).expect("schema applies");
        connection
    }

    /// The drift is a pure function of `(type_id, day_offset)` and can never move a price by
    /// more than 5%. Both halves matter: determinism is what stops a rebuild looking like a
    /// market event, and the bound is what stops a chart wandering away from the ask the seed
    /// actually honours.
    #[test]
    fn the_drift_is_deterministic_and_bounded_to_five_percent() {
        for type_id in [1_u32, 34, 32_880, 4_051, 99_999, u32::MAX / 7] {
            for day_offset in 0..64 {
                let value = drift(type_id, day_offset);
                assert!(
                    (-0.050..=0.050).contains(&value),
                    "drift({type_id}, {day_offset}) = {value} is outside ±5%"
                );
                assert_eq!(
                    value,
                    drift(type_id, day_offset),
                    "drift must depend on nothing but its two arguments"
                );
            }
        }

        // The v1 formula itself, on numbers worked by hand:
        //   type 1, offset 0 -> ((37 + 0) % 101 - 50) / 1000 = -0.013
        //   type 34, offset 3 -> ((1258 + 39) % 101 - 50) / 1000 = (1297 % 101 - 50) / 1000
        assert_eq!(drift(1, 0), -0.013);
        assert_eq!(drift(34, 3), ((1_297_i64 % 101) - 50) as f64 / 1000.0);

        // …and the same series twice is the same series, byte for byte.
        let bases = history_bases(&book([side(34, "B", Some(100.0), None)]));
        let first = build_history_rows(&bases, 30, day(2026, Month::August, 10), 100.0);
        let second = build_history_rows(&bases, 30, day(2026, Month::August, 10), 100.0);
        assert_eq!(first, second);
    }

    /// The ordering invariant the daemon's consumers assume, over a wide spread of bases —
    /// including ones small enough that the 2-decimal rounding is the whole story.
    #[test]
    fn low_never_exceeds_avg_and_avg_never_exceeds_high() {
        let sides = [0.01_f64, 0.07, 2.0, 100.0, 403_200.0, 9_876_543_210.0]
            .into_iter()
            .enumerate()
            .map(|(index, price)| side(index as u32 + 1, "B", Some(price), None))
            .collect::<Vec<_>>();
        let bases = history_bases(&book(sides));
        let rows = build_history_rows(&bases, 45, day(2026, Month::February, 28), 0.0);
        assert!(!rows.is_empty());
        for row in &rows {
            assert!(
                row.low_price > 0.0 && row.low_price <= row.avg_price && row.avg_price <= row.high_price,
                "0 < {} <= {} <= {} failed for type {} on {}",
                row.low_price,
                row.avg_price,
                row.high_price,
                row.type_id,
                row.day
            );
            assert!(row.volume > 0 && row.order_count > 0);
        }
    }

    /// The floor lifts the whole series, exactly as it lifts the ask it came from.
    #[test]
    fn the_price_floor_lifts_a_cheap_series_and_min_seed_price_catches_a_floorless_config() {
        let bases = history_bases(&book([side(34, "B", Some(2.0), None)]));

        let floored = build_history_rows(&bases, 3, day(2026, Month::August, 10), 100.0);
        assert!(
            floored.iter().all(|row| row.avg_price == 100.0),
            "a 2 ISK base under a 100 ISK floor charts flat at the floor: {floored:?}"
        );

        let floorless = build_history_rows(&bases, 3, day(2026, Month::August, 10), 0.0);
        assert!(
            floorless.iter().all(|row| row.avg_price >= MIN_SEED_PRICE),
            "even with no floor no row may be written at 0.00: {floorless:?}"
        );
    }

    /// `days = 0` writes nothing and is not an error — the "history off" setting, reachable
    /// both ways, and it must not fail the in-SQL verifier either.
    #[test]
    fn zero_days_writes_nothing_and_is_not_an_error() {
        let book = book([side(34, "B", Some(2.0), None), side(32_880, "A", Some(403_200.0), None)]);
        let plan = plan_history(&book, 0, day(2026, Month::August, 10), 100.0);
        assert!(plan.rows.is_empty());
        assert_eq!(plan.types, 0);
        assert_eq!(plan.days, 0);
        assert!(plan.day_range.is_none());
        assert_eq!(plan.row_count(), 0);
        // The bases are still resolved — the types are seeded, they just get no chart — so
        // turning the knob back on needs nothing but the day count.
        assert_eq!(plan.bases.len(), 2);

        let mut connection = memory_db();
        let written = write_history_rows(&mut connection, &plan.rows, plan.types, plan.days, None)
            .expect("writing no history is a legal no-op");
        assert_eq!(written, 0);
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM price_history", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 0);
    }

    /// The calendar ends **today** and is a contiguous run of distinct days — no gaps, no
    /// duplicates, oldest first. A gap draws a hole in the chart; a duplicate collides on the
    /// `(type_id, day)` primary key and silently shortens the series.
    #[test]
    fn the_day_range_ends_today_with_no_gaps_and_no_duplicates() {
        // Across a month boundary, a leap day and a year boundary, so the date arithmetic is
        // exercised where hand-rolled versions of it break.
        for (today, days) in [
            (day(2026, Month::August, 10), 30_u32),
            (day(2026, Month::March, 1), 5),
            (day(2024, Month::March, 1), 3),
            (day(2026, Month::January, 2), 4),
            (day(2026, Month::December, 31), 2),
        ] {
            let calendar = history_days(today, days);
            assert_eq!(calendar.len(), days as usize);
            assert_eq!(
                *calendar.last().expect("non-empty"),
                format_day(today),
                "the newest day must be today"
            );
            assert_eq!(
                *calendar.first().expect("non-empty"),
                format_day(today - Duration::days(i64::from(days - 1))),
                "the oldest day must be exactly days-1 back"
            );
            let mut sorted = calendar.clone();
            sorted.sort();
            assert_eq!(sorted, calendar, "days must come out oldest first");
            sorted.dedup();
            assert_eq!(sorted.len(), days as usize, "no day may repeat");

            // Contiguity, proven by walking forward one day at a time — a different mechanism
            // from the subtraction under test, so the two cannot share a bug.
            let mut cursor = today - Duration::days(i64::from(days - 1));
            for entry in &calendar {
                assert_eq!(*entry, format_day(cursor), "no gap between days");
                cursor = cursor.next_day().expect("a real next day");
            }
            assert_eq!(
                cursor,
                today.next_day().expect("a real next day"),
                "the walk must land one day past today, i.e. the run ended on today"
            );
        }

        // 2024-03-01 minus 2 days is 2024-02-28 only in a leap year, which is the arithmetic
        // a hand-rolled calendar gets wrong.
        assert_eq!(
            history_days(day(2024, Month::March, 1), 3),
            vec!["2024-02-28", "2024-02-29", "2024-03-01"]
        );
        assert_eq!(format_day(day(2026, Month::January, 2)), "2026-01-02");
    }

    /// A type seeded on the bid side only still gets a chart, drawn around the bid, and the
    /// fallback is counted so the build can report it.
    #[test]
    fn a_type_with_no_ask_falls_back_to_its_bid_and_is_counted() {
        let book = book([
            side(34, "B", Some(100.0), Some(2.0)),
            // ask deferred to the NPC catalog: bid only
            side(3_689, "D", None, Some(5_000.0)),
        ]);
        let bases = history_bases(&book);
        assert_eq!(bases.len(), 2);

        let tritanium = bases.iter().find(|base| base.type_id == 34).expect("seeded");
        assert_eq!(tritanium.basis, HistoryBasis::Ask);
        assert_eq!(tritanium.base, 100.0, "the ask wins whenever there is one");

        let bid_only = bases.iter().find(|base| base.type_id == 3_689).expect("seeded");
        assert_eq!(bid_only.basis, HistoryBasis::Bid);
        assert_eq!(bid_only.base, 5_000.0);

        let plan = plan_history(&book, 4, day(2026, Month::August, 10), 100.0);
        assert_eq!(plan.bid_fallbacks, 1);
        assert_eq!(plan.types, 2);
        assert_eq!(plan.rows.len(), 8);
        assert!(
            plan.rows
                .iter()
                .filter(|row| row.type_id == 3_689)
                .all(|row| row.avg_price > 4_000.0),
            "the bid-only series is drifted around 5,000, not around a floor or a zero"
        );
    }

    /// A type nothing seeds gets no history. The seeder never invents a price, and a chart for
    /// an item no station sells would be exactly that.
    #[test]
    fn a_type_with_no_seed_row_gets_no_history() {
        let book = book([side(34, "B", Some(100.0), None)]);
        let plan = plan_history(&book, 3, day(2026, Month::August, 10), 100.0);

        assert_eq!(plan.types, 1);
        assert!(
            plan.rows.iter().all(|row| row.type_id == 34),
            "only the seeded type may appear"
        );
        assert!(
            !plan.rows.iter().any(|row| row.type_id == 32_880),
            "an unseeded type must have no rows at all"
        );

        // …and an entry with neither side priced — which `SeedBook` cannot produce, but the
        // fold has to survive — contributes nothing rather than a zero-priced chart.
        let sideless = self::book([side(11_399, "C", None, None)]);
        assert!(history_bases(&sideless).is_empty());
    }

    /// The report's split is the same partition every other v3 report uses, and overlay-only
    /// types (BPOs, skillbooks) are in it — the piece exists partly for their charts.
    #[test]
    fn the_plan_splits_types_across_index_junk_and_overlay() {
        let book = book([
            side(34, "B", Some(100.0), None),
            side(32_880, "A", Some(403_200.0), None),
            side(11_399, "A+B", Some(1_000.0), None),
            side(3_689, "D", Some(50.0), None),
            side(682, "C", Some(3_000.0), None),
            side(3_380, "C", Some(90_000.0), None),
        ]);
        let plan = plan_history(&book, 2, day(2026, Month::August, 10), 100.0);
        assert_eq!(plan.source_count(HistorySource::Index), 3);
        assert_eq!(plan.source_count(HistorySource::Junk), 1);
        assert_eq!(plan.source_count(HistorySource::Overlay), 2);
        assert_eq!(plan.types, 6);
        assert_eq!(plan.rows.len(), 12);
        assert_eq!(
            plan.day_range,
            Some(("2026-08-09".to_string(), "2026-08-10".to_string()))
        );
    }

    /// The round trip: write, verify in SQL, read back through the daemon's own query shape.
    #[test]
    fn the_written_table_survives_its_own_verifier_and_reads_back_in_day_order() {
        let book = book([
            side(34, "B", Some(100.0), None),
            side(32_880, "A", Some(403_200.0), None),
        ]);
        let plan = plan_history(&book, 30, today_utc(), 100.0);
        let mut connection = memory_db();
        let written = write_history_rows(&mut connection, &plan.rows, plan.types, plan.days, None)
            .expect("a well-formed plan commits");
        assert_eq!(written, 60);

        let recent = recent_rows(&connection, 32_880, 3).expect("read back");
        assert_eq!(recent.len(), 3);
        assert_eq!(
            recent[2].day,
            format_day(today_utc()),
            "the newest row is today"
        );
        assert!(recent[0].day < recent[1].day && recent[1].day < recent[2].day);

        // Two days exist, so splitHistoryRows yields a non-empty old and new half.
        assert!(plan.days >= 2);
    }

    /// The verifier is not decoration: each invariant it claims must actually stop a commit.
    #[test]
    fn the_sql_verifier_rejects_a_short_series_a_crossed_row_and_a_single_day() {
        let book = book([
            side(34, "B", Some(100.0), None),
            side(32_880, "A", Some(403_200.0), None),
        ]);

        // A single day is legal data but an empty client chart, so it is refused.
        let one_day = plan_history(&book, 1, today_utc(), 100.0);
        let mut connection = memory_db();
        let error = write_history_rows(&mut connection, &one_day.rows, one_day.types, 1, None)
            .expect_err("one day leaves the client's history half empty");
        let message = format!("{error:#}");
        assert!(message.contains("splitHistoryRows"), "{message}");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM price_history", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 0, "the failed transaction rolled back");

        // A series one row short of the others.
        let mut ragged = plan_history(&book, 5, today_utc(), 100.0);
        ragged.rows.retain(|row| !(row.type_id == 34 && row.day == format_day(today_utc())));
        let error = write_history_rows(&mut connection, &ragged.rows, ragged.types, 5, None)
            .expect_err("a short series must not commit");
        assert!(format!("{error:#}").contains("rows"), "{error:#}");

        // A crossed row: low above avg.
        let mut crossed = plan_history(&book, 5, today_utc(), 100.0);
        crossed.rows[0].low_price = crossed.rows[0].high_price + 1.0;
        let error = write_history_rows(&mut connection, &crossed.rows, crossed.types, 5, None)
            .expect_err("low > avg must not commit");
        assert!(format!("{error:#}").contains("low"), "{error:#}");

        // …and the good plan still goes in afterwards, so the rollbacks left nothing behind.
        let good = plan_history(&book, 5, today_utc(), 100.0);
        write_history_rows(&mut connection, &good.rows, good.types, good.days, None)
            .expect("the good plan commits");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM price_history", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 10);
    }
}
