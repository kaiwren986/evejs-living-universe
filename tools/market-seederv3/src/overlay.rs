//! Bucket C — the TQ NPC catalog overlay (plan §2.3, §6.1 pass 1).
//!
//! TQ's NPCs sell 1,790 T1 blueprint originals, 469 skillbooks, 31 trade goods, 8 planetary
//! command centers and a handful of structure modules, at ~5,000 authentic stations, and they
//! buy trade goods back at another ~80,000 station/type pairs. None of that is computable
//! from the SDE: it only exists as live orders. So v3 does what v2 does — it streams the EVE
//! Ref full order snapshot and keeps the rows that look like NPC orders.
//!
//! Every rule here is a port of market-seederv2, with the `tools/market-seederv2/src/main.rs`
//! line range it came from:
//!
//! | v3 | v2 `main.rs` | what it does |
//! |---|---|---|
//! | [`EveRefOrderRow`] | `:423-441` | the CSV field set, `csv::invalid_option` on every nullable column |
//! | [`screen_row`] | `:1166-1204` | the seven rejects, **in v2's order**, then the NPC test |
//! | [`accept_order`] | `:1527-1539` | the five `[import] order_filter` modes |
//! | [`SeedLiquidity`] | `:476-529` | min-ask / max-bid collapse, quantity summed only at the kept price |
//! | [`price_to_cents`] | `:1541-1546` | prices are integer cents end to end |
//! | [`write_overlay_rows`] | `:1357-1419` | one `seed_stock` + one `seed_buy_orders` row per (station, type) |
//!
//! ### The collapse rule, and why it is not a sum
//!
//! A station holds many orders for one type. The seed tables hold **one row per
//! `(station_id, type_id)` per side**, so the book has to be flattened, and the flattening is
//! deliberately not "sum everything":
//!
//! * a **sell** row keeps the **cheapest** ask, and sums quantity only across the orders that
//!   are *at that same price*;
//! * a **buy** row keeps the **highest** bid, same rule.
//!
//! That is top-of-book, which is what a player would actually transact against. Summing every
//! order's volume into the best price would invent liquidity at a price it never had: 200
//! units offered at 5 ISK and 1,000,000 at 50 ISK would become 1,000,200 units at 5 ISK.
//!
//! ### Ordering inside the build (load-bearing)
//!
//! The build writes **this overlay first and the index + junk pass second**, because the
//! index pass uses `INSERT OR REPLACE` on the same `(station_id, type_id)` primary key and
//! must win at Jita 4-4. Written the other way round, TQ's snapshot price for a type would
//! silently replace our computed 3x-cost price at the one station the index seed owns. This
//! mirrors v2 running `write_custom_station` (`:1425-1508`) after `write_seed_liquidity`
//! (`:1357-1419`); [`crate::build::run_build`] states the same thing at the call site, and
//! `verify_seed_tables` proves it in SQL before the transaction commits.
//!
//! ### What the overlay does not touch
//!
//! Nothing here prices anything. Overlay rows carry the snapshot's own price and the
//! snapshot's own volume (plan §6.3: "NPC overlay rows keep snapshot volumes"), never the
//! int32-max quantity the index seed writes. The price manifest is not consulted and not
//! modified.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::{Duration as StdDuration, Instant};

use anyhow::{Context, Result};
use console::style;
use bzip2::read::BzDecoder;
use indicatif::{ProgressBar, ProgressStyle};
use rusqlite::{Connection, params};
use serde::Deserialize;

use crate::build::SEED_PRICE_VERSION;
use crate::config::OrderFilter;
use crate::staticdata::StaticData;

/// How often the spinner message is refreshed, in accepted rows. v2 takes this from config
/// (`progress_step`); v3 fixes it, because it only changes how often a string is formatted.
const PROGRESS_STEP: u64 = 250_000;

// -------------------------------------------------------------------------------- the row

/// One snapshot row, exactly v2's `EveRefOrderRow` (`main.rs:423-441`).
///
/// `csv::invalid_option` turns an empty or unparseable cell into `None` rather than failing
/// the whole import: EVE Ref leaves `station_id`, `system_id`, `region_id` and
/// `constellation_id` empty for player structures, which is tens of thousands of rows per
/// snapshot and completely normal. A missing *column*, by contrast, is still a hard error —
/// that is what [`crate::snapshot::smoke_check_header`] exists to catch first.
#[derive(Debug, Clone, Deserialize)]
pub struct EveRefOrderRow {
    pub is_buy_order: bool,
    #[serde(default)]
    pub duration: u32,
    pub location_id: u64,
    pub price: f64,
    #[serde(deserialize_with = "csv::invalid_option")]
    pub system_id: Option<u32>,
    pub type_id: u32,
    pub volume_remain: u64,
    pub http_last_modified: String,
    #[serde(deserialize_with = "csv::invalid_option")]
    pub station_id: Option<u64>,
    #[serde(deserialize_with = "csv::invalid_option")]
    pub region_id: Option<u32>,
    #[serde(deserialize_with = "csv::invalid_option")]
    pub constellation_id: Option<u32>,
}

/// v2 `main.rs:1541-1546`. Prices travel as integer cents so the min/max/equality tests in
/// [`SeedLiquidity`] are exact; a float compare would make "same price" depend on rounding.
pub fn price_to_cents(price: f64) -> i64 {
    if !price.is_finite() || price <= 0.0 {
        return 0;
    }
    (price * 100.0).round().clamp(0.0, i64::MAX as f64) as i64
}

/// v2 `main.rs:1548-1550`.
fn sqlite_quantity(quantity: u64) -> i64 {
    i64::try_from(quantity).unwrap_or(i64::MAX)
}

// ---------------------------------------------------------------------------- the screening

/// Why a snapshot row never became a seed row. The variant order **is** v2's test order
/// (`main.rs:1166-1202`), and the report prints them in it, so a row that fails two rules is
/// always counted under the first one v2 would have hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RejectReason {
    /// `volume_remain == 0` — an order with nothing left on it.
    ZeroVolume,
    /// `station_id` is null: the order lives at a player structure, not an NPC station.
    NullStationId,
    /// `location_id != station_id` — EVE Ref's two location columns disagree.
    LocationIsNotTheStation,
    /// A station we have no static-data row for. Every seed row copies its station's
    /// system/constellation/region, so an unknown station cannot be placed.
    UnknownStation,
    /// `system_id`, `region_id` or `constellation_id` is null.
    NullGeography,
    /// A type that is not in the static item-type table.
    UnknownType,
    /// `price_to_cents(price) <= 0` — zero, negative, NaN, or under half a cent.
    NonPositivePrice,
}

impl RejectReason {
    /// Report order = test order.
    pub const ALL: [RejectReason; 7] = [
        Self::ZeroVolume,
        Self::NullStationId,
        Self::LocationIsNotTheStation,
        Self::UnknownStation,
        Self::NullGeography,
        Self::UnknownType,
        Self::NonPositivePrice,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::ZeroVolume => "volume_remain == 0",
            Self::NullStationId => "station_id is null (player structure)",
            Self::LocationIsNotTheStation => "location_id != station_id",
            Self::UnknownStation => "station not in static data",
            Self::NullGeography => "system/region/constellation is null",
            Self::UnknownType => "type not in static data",
            Self::NonPositivePrice => "price <= 0",
        }
    }
}

/// A snapshot row that survived the screening, resolved into the fields a seed row needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenedRow {
    pub station_id: u64,
    pub solar_system_id: u32,
    pub constellation_id: u32,
    pub region_id: u32,
    pub type_id: u32,
    pub price_cents: i64,
    pub quantity: u64,
    pub is_buy_order: bool,
    /// `duration > [import] npc_order_duration_threshold_days` (v2 `main.rs:1204`).
    ///
    /// TQ NPC orders are published with a 365-day duration; player orders top out at 90.
    /// There is no "this is an NPC" flag in the snapshot, so duration is the whole signal.
    pub is_npc_order: bool,
}

/// The seven rejects and the NPC test, in v2's order (`main.rs:1166-1204`).
///
/// Split out of the stream loop so every rule can be exercised on one row without a 20 MB
/// bzip2 file. `station_ids` / `type_ids` are v2's `StaticData::station_ids` and
/// `market_type_ids` (`:864-871`) — note that the type set is **every** static item type, not
/// just the marketable ones, because the overlay seeds exactly what TQ seeds.
pub fn screen_row(
    row: &EveRefOrderRow,
    station_ids: &BTreeSet<u64>,
    type_ids: &BTreeSet<u32>,
    npc_order_duration_threshold_days: u32,
) -> Result<ScreenedRow, RejectReason> {
    if row.volume_remain == 0 {
        return Err(RejectReason::ZeroVolume);
    }
    let Some(station_id) = row.station_id else {
        return Err(RejectReason::NullStationId);
    };
    if row.location_id != station_id {
        return Err(RejectReason::LocationIsNotTheStation);
    }
    if !station_ids.contains(&station_id) {
        return Err(RejectReason::UnknownStation);
    }
    let (Some(solar_system_id), Some(region_id), Some(constellation_id)) =
        (row.system_id, row.region_id, row.constellation_id)
    else {
        return Err(RejectReason::NullGeography);
    };
    if !type_ids.contains(&row.type_id) {
        return Err(RejectReason::UnknownType);
    }
    let price_cents = price_to_cents(row.price);
    if price_cents <= 0 {
        return Err(RejectReason::NonPositivePrice);
    }

    Ok(ScreenedRow {
        station_id,
        solar_system_id,
        constellation_id,
        region_id,
        type_id: row.type_id,
        price_cents,
        quantity: row.volume_remain,
        is_buy_order: row.is_buy_order,
        is_npc_order: row.duration > npc_order_duration_threshold_days,
    })
}

/// v2 `main.rs:1527-1539`, verbatim. All five modes, so `[import] order_filter` means the
/// same thing in v3 as in v2 — v3's own default is `npc_only`.
pub fn accept_order(filter: OrderFilter, is_npc_order: bool, is_market_scope_order: bool) -> bool {
    match filter {
        OrderFilter::AllStation => true,
        OrderFilter::NpcOnly => is_npc_order,
        OrderFilter::PlayerOnly => !is_npc_order,
        OrderFilter::MarketScope => is_market_scope_order,
        OrderFilter::MarketScopeWithNpc => is_market_scope_order || is_npc_order,
    }
}

// --------------------------------------------------------------------- the reference book

/// Which rule produced a type's reference price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReferenceRule {
    /// Both sides quoted: `(min_ask + max_bid) / 2`, the split/mid.
    Split,
    /// Only asks in the book — nobody is bidding for it in Jita.
    AskOnly,
    /// Only bids — nobody is offering it.
    BidOnly,
}

impl ReferenceRule {
    pub const ALL: [ReferenceRule; 3] = [Self::Split, Self::AskOnly, Self::BidOnly];

    pub fn key(self) -> &'static str {
        match self {
            Self::Split => "split (both sides)",
            Self::AskOnly => "ask only",
            Self::BidOnly => "bid only",
        }
    }
}

/// One type's reference price and the rule that produced it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReferencePrice {
    pub price: f64,
    pub rule: ReferenceRule,
    pub min_ask_cents: Option<i64>,
    pub max_bid_cents: Option<i64>,
}

/// Jita's top-of-book, per type, harvested straight off the snapshot stream — plan §4.2
/// source 1, and v2's `ref_sell` / `ref_buy` (`tools/market-seederv2/src/main.rs:1157-1160`,
/// `:1237-1258`): minimum ask and maximum bid per type in **integer cents**, for orders whose
/// `system_id` is the configured reference system.
///
/// ### Deliberate divergence from v2: the harvest runs BEFORE `order_filter`
///
/// v2 collects `ref_sell`/`ref_buy` after its accept tests, so under `npc_only` — v3's own
/// default — the "Jita book" it ends up with is the *NPC* orders in Jita and nothing else.
/// That is not Jita's book: almost every real Jita quote is a player order, and TQ's NPCs
/// only stock skillbooks, BPOs and trade goods there. Harvesting a price out of that set
/// would price the manifest off a handful of fixed NPC prices while calling it a market
/// capture.
///
/// So [`import_overlay`] absorbs into the reference book *before* it consults
/// [`accept_order`], and the two are independent by construction: changing `[import]
/// order_filter` changes which rows become overlay seed rows and cannot change one reference
/// price. [`ReferenceBook::orders_the_overlay_filtered_out`] counts exactly how many
/// harvested orders the overlay itself threw away, so the divergence is visible in the report
/// rather than implied.
///
/// The screening in [`screen_row`] still applies: a row with no volume left, a null station,
/// a station or type absent from the static data, or a non-positive price is not an order
/// anyone can trade against, and there is nothing to be gained by pricing off it.
#[derive(Debug, Clone, Default)]
pub struct ReferenceBook {
    /// The system whose book this is. 0 on a book nothing was ever harvested into.
    pub reference_solar_system_id: u32,
    /// type -> cheapest ask in cents.
    pub min_ask_cents: BTreeMap<u32, i64>,
    /// type -> highest bid in cents.
    pub max_bid_cents: BTreeMap<u32, i64>,
    pub ask_orders: u64,
    pub bid_orders: u64,
    /// Harvested orders that `[import] order_filter` then dropped from the overlay. Proof
    /// the harvest is not standing behind the filter.
    pub orders_the_overlay_filtered_out: u64,
}

impl ReferenceBook {
    pub fn new(reference_solar_system_id: u32) -> Self {
        Self {
            reference_solar_system_id,
            ..Self::default()
        }
    }

    /// Absorbs one screened row, if it is in the reference system. Called before the filter.
    pub fn absorb(&mut self, row: &ScreenedRow) {
        if row.solar_system_id != self.reference_solar_system_id {
            return;
        }
        if row.is_buy_order {
            self.bid_orders += 1;
            self.max_bid_cents
                .entry(row.type_id)
                .and_modify(|best| *best = (*best).max(row.price_cents))
                .or_insert(row.price_cents);
        } else {
            self.ask_orders += 1;
            self.min_ask_cents
                .entry(row.type_id)
                .and_modify(|best| *best = (*best).min(row.price_cents))
                .or_insert(row.price_cents);
        }
    }

    /// Every type quoted on at least one side.
    pub fn types(&self) -> BTreeSet<u32> {
        self.min_ask_cents
            .keys()
            .chain(self.max_bid_cents.keys())
            .copied()
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.min_ask_cents.is_empty() && self.max_bid_cents.is_empty()
    }

    /// One price for one type — plan §4.2's "Jita split/mid price per type".
    ///
    /// * both sides quoted -> `(min_ask + max_bid) / 2`;
    /// * one side quoted -> that side, because half a book is still a real number somebody
    ///   is standing behind, and the alternative is no price and no seed row at all;
    /// * neither -> `None`, and the type is skipped. A price is never invented.
    ///
    /// The mid is taken in cents and halved in floating point, so a book of 101 and 102 gives
    /// 101.5 rather than integer division's 101 — the manifest holds ISK as `f64` and there
    /// is no reason to round the split before it gets there.
    pub fn reference_price(&self, type_id: u32) -> Option<ReferencePrice> {
        let ask = self.min_ask_cents.get(&type_id).copied().filter(|cents| *cents > 0);
        let bid = self.max_bid_cents.get(&type_id).copied().filter(|cents| *cents > 0);
        let (cents, rule) = match (ask, bid) {
            (Some(ask), Some(bid)) => ((ask as f64 + bid as f64) / 2.0, ReferenceRule::Split),
            (Some(ask), None) => (ask as f64, ReferenceRule::AskOnly),
            (None, Some(bid)) => (bid as f64, ReferenceRule::BidOnly),
            (None, None) => return None,
        };
        let price = cents / 100.0;
        if !price.is_finite() || price <= 0.0 {
            return None;
        }
        Some(ReferencePrice {
            price,
            rule,
            min_ask_cents: ask,
            max_bid_cents: bid,
        })
    }
}

/// Where `refresh-prices` gets its snapshot capture from, resolved before anything expensive
/// runs.
///
/// `refresh-prices` must keep working with **no snapshot on disk** — it is the command that
/// repairs a manifest, it can be run in a sealed environment, and against an already-complete
/// manifest it has nothing to capture at all. So a missing snapshot is a skipped source with a
/// log line, never a failure; ESI still runs behind it. (`build` and `audit` are the opposite:
/// there a missing snapshot means the NPC overlay would be silently absent from the database,
/// so they stop.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferenceCaptureSource<'a> {
    /// `[price_manifest] capture_missing_from_snapshot = false`.
    Disabled,
    /// Nothing cached in `[source] download_dir`.
    NoSnapshot,
    /// Stream this file.
    Snapshot(&'a Path),
}

pub fn choose_reference_capture_source(
    capture_missing_from_snapshot: bool,
    cached: Option<&Path>,
) -> ReferenceCaptureSource<'_> {
    if !capture_missing_from_snapshot {
        return ReferenceCaptureSource::Disabled;
    }
    match cached {
        Some(path) => ReferenceCaptureSource::Snapshot(path),
        None => ReferenceCaptureSource::NoSnapshot,
    }
}

// ------------------------------------------------------------------------- the accumulator

/// One `(station_id, type_id)` seed row being built, v2's `SeedLiquidityAccumulator`
/// (`main.rs:476-529`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedLiquidity {
    pub station_id: u64,
    pub solar_system_id: u32,
    pub constellation_id: u32,
    pub region_id: u32,
    pub type_id: u32,
    pub price_cents: i64,
    pub quantity: u64,
}

impl SeedLiquidity {
    pub fn from_row(row: &ScreenedRow) -> Self {
        Self {
            station_id: row.station_id,
            solar_system_id: row.solar_system_id,
            constellation_id: row.constellation_id,
            region_id: row.region_id,
            type_id: row.type_id,
            price_cents: row.price_cents,
            quantity: row.quantity,
        }
    }

    /// Sells keep the **minimum** price. A cheaper order replaces the row outright — its
    /// quantity does not carry over, because that volume was never available at the new
    /// price. An equal-priced order adds its volume.
    pub fn absorb_sell_order(&mut self, price_cents: i64, quantity: u64) {
        if price_cents < self.price_cents {
            self.price_cents = price_cents;
            self.quantity = quantity;
        } else if price_cents == self.price_cents {
            self.quantity = self.quantity.saturating_add(quantity);
        }
    }

    /// Buys keep the **maximum** price, otherwise identical.
    pub fn absorb_buy_order(&mut self, price_cents: i64, quantity: u64) {
        if price_cents > self.price_cents {
            self.price_cents = price_cents;
            self.quantity = quantity;
        } else if price_cents == self.price_cents {
            self.quantity = self.quantity.saturating_add(quantity);
        }
    }

    pub fn price(&self) -> f64 {
        self.price_cents as f64 / 100.0
    }
}

/// Absorbs one screened row into the right side of the book.
fn absorb(
    sell: &mut BTreeMap<(u64, u32), SeedLiquidity>,
    buy: &mut BTreeMap<(u64, u32), SeedLiquidity>,
    row: &ScreenedRow,
) {
    let key = (row.station_id, row.type_id);
    if row.is_buy_order {
        buy.entry(key)
            .and_modify(|entry| entry.absorb_buy_order(row.price_cents, row.quantity))
            .or_insert_with(|| SeedLiquidity::from_row(row));
    } else {
        sell.entry(key)
            .and_modify(|entry| entry.absorb_sell_order(row.price_cents, row.quantity))
            .or_insert_with(|| SeedLiquidity::from_row(row));
    }
}

// --------------------------------------------------------------------------------- the run

/// Everything the reports need about one import pass.
#[derive(Debug, Clone, Default)]
pub struct OverlayStats {
    /// Rows read out of the CSV, before any test.
    pub source_rows: u64,
    /// Rejected by [`screen_row`], per reason. Sums to [`OverlayStats::rejected`].
    pub rejects: BTreeMap<RejectReason, u64>,
    /// Screened clean but excluded by `[import] order_filter`, split by what they were.
    pub filtered_player_orders: u64,
    pub filtered_npc_orders: u64,
    pub filtered_out_of_scope_orders: u64,
    /// Accepted rows, and their split.
    pub accepted_rows: u64,
    pub accepted_sell_orders: u64,
    pub accepted_buy_orders: u64,
    pub accepted_npc_orders: u64,
    pub accepted_player_orders: u64,
    /// Volume on the accepted orders, before the top-of-book collapse throws most of it away.
    pub accepted_sell_volume: u64,
    pub accepted_buy_volume: u64,
    pub stations: BTreeSet<u64>,
    pub types: BTreeSet<u32>,
    pub regions: BTreeSet<u32>,
    pub systems: BTreeSet<u32>,
    /// The snapshot's own freshness window, straight off the rows (v2 `:1510-1525`).
    pub min_http_last_modified: Option<String>,
    pub max_http_last_modified: Option<String>,
}

impl OverlayStats {
    pub fn rejected(&self) -> u64 {
        self.rejects.values().copied().sum()
    }

    pub fn reject(&self, reason: RejectReason) -> u64 {
        self.rejects.get(&reason).copied().unwrap_or(0)
    }

    pub fn filtered(&self) -> u64 {
        self.filtered_player_orders + self.filtered_npc_orders + self.filtered_out_of_scope_orders
    }

    fn record_timestamp(&mut self, value: &str) {
        if self
            .min_http_last_modified
            .as_ref()
            .is_none_or(|current| value < current.as_str())
        {
            self.min_http_last_modified = Some(value.to_string());
        }
        if self
            .max_http_last_modified
            .as_ref()
            .is_none_or(|current| value > current.as_str())
        {
            self.max_http_last_modified = Some(value.to_string());
        }
    }
}

/// The collapsed book plus the stats that explain how it got that small.
#[derive(Debug, Clone, Default)]
pub struct OverlayImport {
    /// `(station_id, type_id)` -> the one ask row for that pair.
    pub sell: BTreeMap<(u64, u32), SeedLiquidity>,
    /// `(station_id, type_id)` -> the one bid row for that pair.
    pub buy: BTreeMap<(u64, u32), SeedLiquidity>,
    /// Jita top-of-book per type, harvested from the same stream **before** `order_filter`
    /// (plan §4.2 source 1). Nothing in the overlay write path reads it: it exists for
    /// `refresh-prices`, which turns it into `ccp-snapshot-jita-split` captures.
    pub reference_book: ReferenceBook,
    pub stats: OverlayStats,
    pub elapsed: StdDuration,
}

impl OverlayImport {
    pub fn sell_rows(&self) -> usize {
        self.sell.len()
    }

    pub fn buy_rows(&self) -> usize {
        self.buy.len()
    }

    pub fn total_rows(&self) -> usize {
        self.sell.len() + self.buy.len()
    }

    /// Distinct stations that ended up holding at least one row.
    pub fn stations(&self) -> BTreeSet<u64> {
        self.sell
            .keys()
            .chain(self.buy.keys())
            .map(|(station_id, _)| *station_id)
            .collect()
    }

    /// Distinct types that ended up on at least one row.
    pub fn types(&self) -> BTreeSet<u32> {
        self.sell
            .keys()
            .chain(self.buy.keys())
            .map(|(_, type_id)| *type_id)
            .collect()
    }

    /// One screened row's whole effect on the import, **in the order that is load-bearing**:
    /// the Jita harvest first, `[import] order_filter` second. Returns true when the row
    /// became overlay liquidity.
    ///
    /// The ordering is why this is a method and not four lines inlined in the stream loop —
    /// it is a rule about the manifest capture, and it has to be provable on a handful of
    /// rows rather than only against a 20 MB bz2. See [`ReferenceBook`] for why v3 diverges
    /// from v2 here.
    pub fn absorb_screened(
        &mut self,
        screened: &ScreenedRow,
        filter: OrderFilter,
        is_market_scope_order: bool,
    ) -> bool {
        // FIRST, unconditionally: the capture must see Jita's real book, and under the
        // default `npc_only` the accepted set below is TQ's NPC orders and nothing else.
        self.reference_book.absorb(screened);

        if !accept_order(filter, screened.is_npc_order, is_market_scope_order) {
            if screened.solar_system_id == self.reference_book.reference_solar_system_id {
                self.reference_book.orders_the_overlay_filtered_out += 1;
            }
            // One counter per reason it was dropped, so `npc_only` reports "player orders
            // filtered" rather than a single opaque total.
            if !screened.is_npc_order && matches!(filter, OrderFilter::NpcOnly) {
                self.stats.filtered_player_orders += 1;
            } else if screened.is_npc_order && matches!(filter, OrderFilter::PlayerOnly) {
                self.stats.filtered_npc_orders += 1;
            } else {
                self.stats.filtered_out_of_scope_orders += 1;
            }
            return false;
        }

        absorb(&mut self.sell, &mut self.buy, screened);

        let stats = &mut self.stats;
        stats.accepted_rows += 1;
        if screened.is_buy_order {
            stats.accepted_buy_orders += 1;
            stats.accepted_buy_volume = stats.accepted_buy_volume.saturating_add(screened.quantity);
        } else {
            stats.accepted_sell_orders += 1;
            stats.accepted_sell_volume =
                stats.accepted_sell_volume.saturating_add(screened.quantity);
        }
        if screened.is_npc_order {
            stats.accepted_npc_orders += 1;
        } else {
            stats.accepted_player_orders += 1;
        }
        stats.stations.insert(screened.station_id);
        stats.types.insert(screened.type_id);
        stats.regions.insert(screened.region_id);
        stats.systems.insert(screened.solar_system_id);
        true
    }
}

/// Streams the cached snapshot and collapses it into the overlay book.
///
/// Nothing is written and no network is touched: this reads one local bz2 and returns.
/// `market_scope_systems` is only consulted by the two `market_scope*` filter modes; v3 has
/// no `[market_scope]` config section, so [`crate::build::run_build`] refuses those modes up
/// front rather than letting them import an empty book.
pub fn import_overlay(
    snapshot_path: &Path,
    static_data: &StaticData,
    filter: OrderFilter,
    npc_order_duration_threshold_days: u32,
    market_scope_systems: &BTreeSet<u32>,
    reference_solar_system_id: u32,
    quiet: bool,
) -> Result<OverlayImport> {
    let started = Instant::now();
    let station_ids = static_data
        .stations
        .iter()
        .map(|station| station.station_id)
        .collect::<BTreeSet<_>>();
    let type_ids = static_data
        .item_types
        .iter()
        .map(|item| item.type_id)
        .collect::<BTreeSet<_>>();

    if !quiet {
        println!(
            "{} streaming {} ({}, NPC when duration > {} days)",
            style("[overlay]").cyan().bold(),
            crate::display_path(snapshot_path),
            filter.summary_label(),
            npc_order_duration_threshold_days
        );
    }
    let spinner = (!quiet).then(|| spinner("Importing TQ station orders"));

    let input = File::open(snapshot_path).with_context(|| {
        format!(
            "failed to open the cached market-order snapshot {}",
            snapshot_path.to_string_lossy()
        )
    })?;
    let decoder = BzDecoder::new(BufReader::new(input));
    let mut reader = csv::Reader::from_reader(decoder);

    let mut import = OverlayImport {
        reference_book: ReferenceBook::new(reference_solar_system_id),
        ..OverlayImport::default()
    };
    for result in reader.deserialize::<EveRefOrderRow>() {
        let row = result.with_context(|| {
            format!(
                "failed to read a row from {} — the cached snapshot is not the CSV the importer \
                 expects. Re-run `market-seederv3 snapshot-info --download`.",
                snapshot_path.to_string_lossy()
            )
        })?;
        import.stats.source_rows += 1;

        let screened = match screen_row(
            &row,
            &station_ids,
            &type_ids,
            npc_order_duration_threshold_days,
        ) {
            Ok(screened) => screened,
            Err(reason) => {
                *import.stats.rejects.entry(reason).or_insert(0) += 1;
                continue;
            }
        };

        // Harvest first, filter second — the ordering lives in `absorb_screened` so it can be
        // tested on a handful of rows.
        let is_market_scope_order = market_scope_systems.contains(&screened.solar_system_id);
        if !import.absorb_screened(&screened, filter, is_market_scope_order) {
            continue;
        }

        let stats = &mut import.stats;
        stats.record_timestamp(&row.http_last_modified);

        if let Some(spinner) = spinner.as_ref().filter(|_| stats.accepted_rows % PROGRESS_STEP == 0)
        {
            spinner.set_message(format!(
                "Read {} snapshot rows, accepted {}, rejected {}",
                crate::count(stats.source_rows as usize),
                crate::count(stats.accepted_rows as usize),
                crate::count(stats.rejected() as usize)
            ));
        }
    }

    import.elapsed = started.elapsed();
    if let Some(spinner) = spinner {
        spinner.finish_with_message(format!(
            "Collapsed {} accepted orders into {} overlay rows ({} asks + {} bids) at {} stations in {:.1}s",
            crate::count(import.stats.accepted_rows as usize),
            crate::count(import.total_rows()),
            crate::count(import.sell_rows()),
            crate::count(import.buy_rows()),
            crate::count(import.stations().len()),
            import.elapsed.as_secs_f64()
        ));
    }
    Ok(import)
}

// ------------------------------------------------------------------------------- the write

/// Writes the overlay book into `seed_stock` / `seed_buy_orders`, one transaction, v2
/// `main.rs:1357-1419`.
///
/// **Plain `INSERT`, deliberately.** The book is keyed `(station_id, type_id)` in memory, so
/// two rows for one pair cannot exist; if one ever did, a primary-key violation here is the
/// right outcome and `INSERT OR REPLACE` would hide it. The `INSERT OR REPLACE` that matters
/// is the *index* pass's, which runs after this one and is supposed to win at Jita 4-4.
///
/// `quantity` and `initial_quantity` get the same value (`?7, ?7`) — the snapshot's own
/// volume, not the index seed's int32 ceiling (plan §6.3).
pub fn write_overlay_rows(
    connection: &mut Connection,
    import: &OverlayImport,
    updated_at: &str,
    progress: Option<&ProgressBar>,
) -> Result<(u64, u64)> {
    let transaction = connection.transaction()?;
    {
        let mut sell = transaction.prepare(
            "INSERT INTO seed_stock (
               station_id, solar_system_id, constellation_id, region_id,
               type_id, price, quantity, initial_quantity, price_version, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)",
        )?;
        for row in import.sell.values() {
            sell.execute(params![
                row.station_id,
                row.solar_system_id,
                row.constellation_id,
                row.region_id,
                row.type_id,
                row.price(),
                sqlite_quantity(row.quantity),
                SEED_PRICE_VERSION,
                updated_at,
            ])?;
            if let Some(progress) = progress {
                progress.inc(1);
            }
        }

        let mut buy = transaction.prepare(
            "INSERT INTO seed_buy_orders (
               station_id, solar_system_id, constellation_id, region_id,
               type_id, price, quantity, initial_quantity, price_version, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9)",
        )?;
        for row in import.buy.values() {
            buy.execute(params![
                row.station_id,
                row.solar_system_id,
                row.constellation_id,
                row.region_id,
                row.type_id,
                row.price(),
                sqlite_quantity(row.quantity),
                SEED_PRICE_VERSION,
                updated_at,
            ])?;
            if let Some(progress) = progress {
                progress.inc(1);
            }
        }
    }
    transaction.commit()?;
    Ok((import.sell_rows() as u64, import.buy_rows() as u64))
}

// ------------------------------------------------------------------------------ the report

/// The overlay half of the build report: what came in, what was thrown away, and why.
pub fn print_overlay_report(import: &OverlayImport, filter: OrderFilter) {
    let stats = &import.stats;
    println!();
    println!(
        "{} {} snapshot rows read in {:.1}s",
        style("[overlay]").cyan().bold(),
        crate::count(stats.source_rows as usize),
        import.elapsed.as_secs_f64()
    );
    println!(
        "  {:<34}: {}",
        "rejected before filtering",
        crate::count(stats.rejected() as usize)
    );
    for reason in RejectReason::ALL {
        println!(
            "    {:<32}: {:>12}",
            reason.key(),
            crate::count(stats.reject(reason) as usize)
        );
    }
    println!(
        "  {:<34}: {}  (player {}, NPC {}, out of scope {}) under {}",
        "filtered by order_filter",
        crate::count(stats.filtered() as usize),
        crate::count(stats.filtered_player_orders as usize),
        crate::count(stats.filtered_npc_orders as usize),
        crate::count(stats.filtered_out_of_scope_orders as usize),
        filter.mode_key()
    );
    println!(
        "  {:<34}: {}  ({} sells, {} buys; {} NPC, {} player)",
        "accepted",
        crate::count(stats.accepted_rows as usize),
        crate::count(stats.accepted_sell_orders as usize),
        crate::count(stats.accepted_buy_orders as usize),
        crate::count(stats.accepted_npc_orders as usize),
        crate::count(stats.accepted_player_orders as usize)
    );
    println!(
        "  {:<34}: {} rows ({} asks + {} bids), {} stations, {} types",
        "collapsed to one row per pair",
        crate::count(import.total_rows()),
        crate::count(import.sell_rows()),
        crate::count(import.buy_rows()),
        crate::count(import.stations().len()),
        crate::count(import.types().len())
    );
    println!(
        "  {:<34}: {} regions, {} systems",
        "reach",
        crate::count(stats.regions.len()),
        crate::count(stats.systems.len())
    );
    println!(
        "  {:<34}: {} .. {}",
        "snapshot freshness window",
        stats.min_http_last_modified.as_deref().unwrap_or("none"),
        stats.max_http_last_modified.as_deref().unwrap_or("none")
    );
    let book = &import.reference_book;
    println!(
        "  {:<34}: {} types in system {} ({} asks + {} bids harvested, {} of them filtered \
         out of the overlay)",
        "reference book (for the manifest)",
        crate::count(book.types().len()),
        book.reference_solar_system_id,
        crate::count(book.ask_orders as usize),
        crate::count(book.bid_orders as usize),
        crate::count(book.orders_the_overlay_filtered_out as usize)
    );
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

#[cfg(test)]
mod tests {
    use super::*;

    const JITA_4_4: u64 = 60_003_760;
    const RENS: u64 = 60_004_588;
    const VENTURE: u32 = 32_880;
    const TRITANIUM: u32 = 34;

    fn stations() -> BTreeSet<u64> {
        [JITA_4_4, RENS].into_iter().collect()
    }

    fn types() -> BTreeSet<u32> {
        [VENTURE, TRITANIUM].into_iter().collect()
    }

    /// A clean NPC sell order at Jita 4-4; every reject test spoils exactly one field of it.
    fn row() -> EveRefOrderRow {
        EveRefOrderRow {
            is_buy_order: false,
            duration: 365,
            location_id: JITA_4_4,
            price: 100.0,
            system_id: Some(30_000_142),
            type_id: VENTURE,
            volume_remain: 10,
            http_last_modified: "2026-08-09T11:04:07Z".to_string(),
            station_id: Some(JITA_4_4),
            region_id: Some(10_000_002),
            constellation_id: Some(20_000_020),
        }
    }

    fn screen(row: &EveRefOrderRow) -> Result<ScreenedRow, RejectReason> {
        screen_row(row, &stations(), &types(), 90)
    }

    #[test]
    fn every_reject_reason_fires_on_its_own_field_and_a_clean_row_survives() {
        let clean = screen(&row()).expect("the fixture row must be accepted");
        assert_eq!(clean.station_id, JITA_4_4);
        assert_eq!(clean.price_cents, 10_000);
        assert_eq!(clean.quantity, 10);
        assert!(clean.is_npc_order, "duration 365 > threshold 90");

        let mut zero = row();
        zero.volume_remain = 0;
        assert_eq!(screen(&zero), Err(RejectReason::ZeroVolume));

        let mut structure = row();
        structure.station_id = None;
        assert_eq!(screen(&structure), Err(RejectReason::NullStationId));

        let mut mismatched = row();
        mismatched.location_id = 1_035_000_000_001;
        assert_eq!(screen(&mismatched), Err(RejectReason::LocationIsNotTheStation));

        let mut foreign = row();
        foreign.station_id = Some(60_000_001);
        foreign.location_id = 60_000_001;
        assert_eq!(screen(&foreign), Err(RejectReason::UnknownStation));

        for spoil in [0usize, 1, 2] {
            let mut geography = row();
            match spoil {
                0 => geography.system_id = None,
                1 => geography.region_id = None,
                _ => geography.constellation_id = None,
            }
            assert_eq!(
                screen(&geography),
                Err(RejectReason::NullGeography),
                "null geography column {spoil}"
            );
        }

        let mut unknown_type = row();
        unknown_type.type_id = 999_999;
        assert_eq!(screen(&unknown_type), Err(RejectReason::UnknownType));

        for price in [0.0, -1.0, f64::NAN, 0.004] {
            let mut cheap = row();
            cheap.price = price;
            assert_eq!(
                screen(&cheap),
                Err(RejectReason::NonPositivePrice),
                "price {price} rounds to {} cents",
                price_to_cents(price)
            );
        }
    }

    /// The order of the tests is v2's, and it is observable: a row that breaks two rules is
    /// counted under the earlier one.
    #[test]
    fn rejects_are_tested_in_v2s_order_so_a_doubly_bad_row_is_counted_once_under_the_first() {
        let mut both = row();
        both.volume_remain = 0;
        both.station_id = None;
        assert_eq!(
            screen(&both),
            Err(RejectReason::ZeroVolume),
            "zero volume is tested before the null station"
        );

        let mut structure_and_unknown_type = row();
        structure_and_unknown_type.station_id = None;
        structure_and_unknown_type.type_id = 999_999;
        assert_eq!(
            screen(&structure_and_unknown_type),
            Err(RejectReason::NullStationId),
            "the station tests come before the type test"
        );

        let mut unknown_type_and_free = row();
        unknown_type_and_free.type_id = 999_999;
        unknown_type_and_free.price = 0.0;
        assert_eq!(
            screen(&unknown_type_and_free),
            Err(RejectReason::UnknownType),
            "the type test comes before the price test"
        );
    }

    #[test]
    fn npc_only_keeps_long_duration_orders_and_drops_everything_a_player_could_have_placed() {
        // The threshold is exclusive: a 90-day order is the longest a player can place, so
        // 90 is a player order and 91 is not.
        for (duration, expected_npc) in [(0u32, false), (30, false), (90, false), (91, true), (365, true)] {
            let mut candidate = row();
            candidate.duration = duration;
            let screened = screen(&candidate).expect("only duration varies");
            assert_eq!(
                screened.is_npc_order, expected_npc,
                "duration {duration} against threshold 90"
            );
            assert_eq!(
                accept_order(OrderFilter::NpcOnly, screened.is_npc_order, false),
                expected_npc,
                "npc_only keeps duration {duration}?"
            );
            assert_eq!(
                accept_order(OrderFilter::PlayerOnly, screened.is_npc_order, false),
                !expected_npc,
                "player_only is the exact complement"
            );
        }

        // All five modes, at both ends of the NPC test and both ends of the scope test.
        for (is_npc, in_scope) in [(false, false), (false, true), (true, false), (true, true)] {
            assert!(accept_order(OrderFilter::AllStation, is_npc, in_scope));
            assert_eq!(accept_order(OrderFilter::NpcOnly, is_npc, in_scope), is_npc);
            assert_eq!(accept_order(OrderFilter::PlayerOnly, is_npc, in_scope), !is_npc);
            assert_eq!(
                accept_order(OrderFilter::MarketScope, is_npc, in_scope),
                in_scope
            );
            assert_eq!(
                accept_order(OrderFilter::MarketScopeWithNpc, is_npc, in_scope),
                in_scope || is_npc
            );
        }
    }

    /// The collapse rule, which is the whole reason this module is not a `GROUP BY`.
    #[test]
    fn sells_keep_the_cheapest_ask_and_sum_volume_only_at_that_price() {
        let mut liquidity = SeedLiquidity {
            station_id: JITA_4_4,
            solar_system_id: 30_000_142,
            constellation_id: 20_000_020,
            region_id: 10_000_002,
            type_id: VENTURE,
            price_cents: 100_000,
            quantity: 5,
        };

        // Dearer: ignored entirely, price and quantity both untouched.
        liquidity.absorb_sell_order(200_000, 100_0000);
        assert_eq!((liquidity.price_cents, liquidity.quantity), (100_000, 5));

        // Same price: volumes add.
        liquidity.absorb_sell_order(100_000, 7);
        assert_eq!((liquidity.price_cents, liquidity.quantity), (100_000, 12));

        // Cheaper: the row is replaced. The 12 units at 1,000 ISK do NOT carry over — they
        // were never on offer at 500, and carrying them would invent liquidity.
        liquidity.absorb_sell_order(50_000, 3);
        assert_eq!((liquidity.price_cents, liquidity.quantity), (50_000, 3));
        assert_eq!(liquidity.price(), 500.0);

        // …and the new price accumulates from there.
        liquidity.absorb_sell_order(50_000, 4);
        assert_eq!((liquidity.price_cents, liquidity.quantity), (50_000, 7));
    }

    #[test]
    fn buys_keep_the_highest_bid_under_the_mirrored_rule() {
        let mut liquidity = SeedLiquidity {
            station_id: RENS,
            solar_system_id: 30_002_510,
            constellation_id: 20_000_369,
            region_id: 10_000_030,
            type_id: TRITANIUM,
            price_cents: 500,
            quantity: 100,
        };

        liquidity.absorb_buy_order(400, 100_0000);
        assert_eq!((liquidity.price_cents, liquidity.quantity), (500, 100));

        liquidity.absorb_buy_order(500, 50);
        assert_eq!((liquidity.price_cents, liquidity.quantity), (500, 150));

        liquidity.absorb_buy_order(900, 2);
        assert_eq!((liquidity.price_cents, liquidity.quantity), (900, 2));
        assert_eq!(liquidity.price(), 9.0);

        // Saturating add: a quantity that would overflow u64 stops at the ceiling instead of
        // wrapping to a tiny number.
        liquidity.quantity = u64::MAX - 1;
        liquidity.absorb_buy_order(900, 10);
        assert_eq!(liquidity.quantity, u64::MAX);
    }

    #[test]
    fn the_book_is_keyed_per_station_and_per_side_so_one_type_can_hold_four_prices() {
        let mut sell = BTreeMap::new();
        let mut buy = BTreeMap::new();
        let screened = |station_id: u64, is_buy_order: bool, price_cents: i64, quantity: u64| {
            ScreenedRow {
                station_id,
                solar_system_id: 30_000_142,
                constellation_id: 20_000_020,
                region_id: 10_000_002,
                type_id: VENTURE,
                price_cents,
                quantity,
                is_buy_order,
                is_npc_order: true,
            }
        };

        for row in [
            screened(JITA_4_4, false, 1_000, 5),
            screened(JITA_4_4, false, 900, 2),
            screened(JITA_4_4, true, 400, 9),
            screened(RENS, false, 5_000, 1),
            screened(RENS, true, 4_000, 3),
        ] {
            absorb(&mut sell, &mut buy, &row);
        }

        assert_eq!(sell.len(), 2, "one ask row per station");
        assert_eq!(buy.len(), 2, "one bid row per station");
        assert_eq!(sell[&(JITA_4_4, VENTURE)].price_cents, 900);
        assert_eq!(sell[&(JITA_4_4, VENTURE)].quantity, 2);
        assert_eq!(sell[&(RENS, VENTURE)].price_cents, 5_000);
        assert_eq!(buy[&(JITA_4_4, VENTURE)].price_cents, 400);
        assert_eq!(buy[&(RENS, VENTURE)].price_cents, 4_000);
    }

    // ----------------------------------------------------------------- the reference book

    const JITA: u32 = 30_000_142;
    const AMARR: u32 = 30_002_187;

    /// A screened row in whatever system/side/price the test needs.
    fn quote(solar_system_id: u32, type_id: u32, is_buy_order: bool, price: f64) -> ScreenedRow {
        ScreenedRow {
            station_id: if solar_system_id == JITA { JITA_4_4 } else { RENS },
            solar_system_id,
            constellation_id: 20_000_020,
            region_id: 10_000_002,
            type_id,
            price_cents: price_to_cents(price),
            quantity: 1,
            is_buy_order,
            // A player order: v3's default `npc_only` filter drops exactly these, which is
            // what the filter-independence test needs.
            is_npc_order: false,
        }
    }

    #[test]
    fn the_split_is_the_midpoint_of_the_best_ask_and_the_best_bid() {
        let mut book = ReferenceBook::new(JITA);
        // Top of book is 5.00 ask / 4.00 bid; the worse orders on each side never count.
        for (is_buy, price) in [
            (false, 5.0),
            (false, 9.0),
            (false, 7.5),
            (true, 4.0),
            (true, 1.0),
            (true, 3.25),
        ] {
            book.absorb(&quote(JITA, VENTURE, is_buy, price));
        }
        assert_eq!(book.min_ask_cents.get(&VENTURE), Some(&500));
        assert_eq!(book.max_bid_cents.get(&VENTURE), Some(&400));
        assert_eq!(book.ask_orders, 3);
        assert_eq!(book.bid_orders, 3);

        let priced = book.reference_price(VENTURE).expect("both sides quoted");
        assert_eq!(priced.rule, ReferenceRule::Split);
        assert_eq!(priced.price, 4.5, "(5.00 + 4.00) / 2");

        // The mid is taken in cents and halved in floating point, so an odd cent total keeps
        // its half cent instead of being truncated by integer division.
        let mut odd = ReferenceBook::new(JITA);
        odd.absorb(&quote(JITA, TRITANIUM, false, 1.02));
        odd.absorb(&quote(JITA, TRITANIUM, true, 1.01));
        assert_eq!(
            odd.reference_price(TRITANIUM).expect("both sides").price,
            1.015
        );
    }

    #[test]
    fn one_sided_books_fall_back_to_the_side_that_exists_and_an_empty_one_is_skipped() {
        let mut asks_only = ReferenceBook::new(JITA);
        asks_only.absorb(&quote(JITA, VENTURE, false, 12.0));
        let priced = asks_only.reference_price(VENTURE).expect("an ask is a price");
        assert_eq!((priced.rule, priced.price), (ReferenceRule::AskOnly, 12.0));
        assert_eq!(priced.max_bid_cents, None);

        let mut bids_only = ReferenceBook::new(JITA);
        bids_only.absorb(&quote(JITA, VENTURE, true, 8.0));
        let priced = bids_only.reference_price(VENTURE).expect("a bid is a price");
        assert_eq!((priced.rule, priced.price), (ReferenceRule::BidOnly, 8.0));
        assert_eq!(priced.min_ask_cents, None);

        // Neither side: no price, and never a guessed one.
        assert!(ReferenceBook::new(JITA).reference_price(VENTURE).is_none());
        assert!(bids_only.reference_price(TRITANIUM).is_none());

        // A zero-cent quote is not a price. `screen_row` already rejects those upstream, so
        // this is belt and braces on the derivation itself.
        let mut zero = ReferenceBook::new(JITA);
        zero.min_ask_cents.insert(VENTURE, 0);
        assert!(zero.reference_price(VENTURE).is_none());
        zero.max_bid_cents.insert(VENTURE, 250);
        let priced = zero.reference_price(VENTURE).expect("the bid still stands");
        assert_eq!((priced.rule, priced.price), (ReferenceRule::BidOnly, 2.5));
    }

    #[test]
    fn only_the_reference_system_feeds_the_book() {
        let mut book = ReferenceBook::new(JITA);
        book.absorb(&quote(JITA, VENTURE, false, 100.0));
        // Cheaper, but in Amarr — a different market, and it must not touch Jita's ask.
        book.absorb(&quote(AMARR, VENTURE, false, 1.0));
        book.absorb(&quote(AMARR, VENTURE, true, 0.5));
        // A type only ever quoted elsewhere never enters the book at all.
        book.absorb(&quote(AMARR, TRITANIUM, false, 3.0));

        assert_eq!(book.types(), [VENTURE].into_iter().collect::<BTreeSet<_>>());
        assert_eq!(book.min_ask_cents.get(&VENTURE), Some(&10_000));
        assert!(book.max_bid_cents.is_empty());
        assert_eq!((book.ask_orders, book.bid_orders), (1, 0));
        assert!(book.reference_price(TRITANIUM).is_none());
    }

    #[test]
    fn order_filter_cannot_change_one_reference_price() {
        // The same six player orders in Jita, replayed under every filter mode. `npc_only`
        // — v3's default — accepts none of them, and that is exactly the point: v2 harvests
        // behind its filter and would end up pricing Jita off TQ's NPC orders alone.
        let quotes = [
            quote(JITA, VENTURE, false, 5.0),
            quote(JITA, VENTURE, false, 6.0),
            quote(JITA, VENTURE, true, 4.0),
            quote(JITA, TRITANIUM, false, 2.0),
            quote(AMARR, VENTURE, false, 0.5),
            quote(AMARR, VENTURE, true, 0.25),
        ];

        let replay = |filter: OrderFilter| {
            let mut import = OverlayImport {
                reference_book: ReferenceBook::new(JITA),
                ..OverlayImport::default()
            };
            for screened in &quotes {
                import.absorb_screened(screened, filter, false);
            }
            import
        };

        let npc_only = replay(OrderFilter::NpcOnly);
        assert_eq!(
            npc_only.total_rows(),
            0,
            "every fixture order is a player order, so npc_only seeds nothing"
        );
        assert_eq!(
            npc_only.reference_book.orders_the_overlay_filtered_out, 4,
            "the four Jita orders the overlay threw away were still harvested"
        );

        for filter in [
            OrderFilter::NpcOnly,
            OrderFilter::PlayerOnly,
            OrderFilter::AllStation,
            OrderFilter::MarketScope,
            OrderFilter::MarketScopeWithNpc,
        ] {
            let import = replay(filter);
            let book = &import.reference_book;
            assert_eq!(
                book.min_ask_cents.get(&VENTURE),
                Some(&500),
                "{:?} moved the Jita ask",
                filter
            );
            assert_eq!(
                book.max_bid_cents.get(&VENTURE),
                Some(&400),
                "{:?} moved the Jita bid",
                filter
            );
            assert_eq!(
                book.reference_price(VENTURE).map(|priced| priced.price),
                Some(4.5),
                "{:?} moved the Jita split",
                filter
            );
            assert_eq!(
                book.reference_price(TRITANIUM).map(|priced| priced.rule),
                Some(ReferenceRule::AskOnly),
                "{:?} moved the Tritanium rule",
                filter
            );
            assert_eq!((book.ask_orders, book.bid_orders), (3, 1));
        }

        // …while the seed rows the filter governs do move, so the replay is not vacuous.
        // Five rows: Jita holds a Venture ask (the two asks collapse), a Venture bid and a
        // Tritanium ask; Rens holds a Venture ask and a Venture bid.
        assert_eq!(replay(OrderFilter::PlayerOnly).total_rows(), 5);
        assert_eq!(replay(OrderFilter::AllStation).total_rows(), 5);
    }

    #[test]
    fn a_missing_snapshot_skips_the_capture_source_instead_of_failing() {
        let path = Path::new("cache/market-orders-latest.v3.abc.bz2");
        assert_eq!(
            choose_reference_capture_source(true, Some(path)),
            ReferenceCaptureSource::Snapshot(path)
        );
        // No snapshot cached: skipped, never an error. `refresh-prices` has to stay usable
        // offline against a complete manifest, and ESI still runs behind it.
        assert_eq!(
            choose_reference_capture_source(true, None),
            ReferenceCaptureSource::NoSnapshot
        );
        // The knob wins over a cached file.
        assert_eq!(
            choose_reference_capture_source(false, Some(path)),
            ReferenceCaptureSource::Disabled
        );
        assert_eq!(
            choose_reference_capture_source(false, None),
            ReferenceCaptureSource::Disabled
        );
    }

    #[test]
    fn price_to_cents_rounds_and_refuses_anything_that_is_not_a_price() {
        assert_eq!(price_to_cents(1.0), 100);
        assert_eq!(price_to_cents(0.014), 1);
        assert_eq!(price_to_cents(0.015), 2, "half a cent rounds up");
        assert_eq!(price_to_cents(758_719.5), 75_871_950);
        assert_eq!(price_to_cents(0.0), 0);
        assert_eq!(price_to_cents(-5.0), 0);
        assert_eq!(price_to_cents(f64::NAN), 0);
        assert_eq!(price_to_cents(f64::INFINITY), 0);
    }
}
