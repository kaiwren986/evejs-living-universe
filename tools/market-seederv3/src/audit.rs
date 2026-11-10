//! The cross-bucket pump audit — plan §8.3, and the §9 checklist item that gates a real seed.
//!
//! The seed both buys and sells almost everything at Jita 4-4, at `ask = 3 x cost` and
//! `bid = 1 x cost`. That is safe **only while every way of turning one seeded type into
//! another loses money**. Two price bases coexist (SDE `basePrice` for leaves, captured TQ
//! market prices for everything else), and every seam between them is a place where a loop
//! can come out positive. Two were found by hand:
//!
//! * floored **bids** put Tritanium's bid 50x above its cost, making buy-Venture → reprocess
//!   → sell-minerals a 3.52x pump (fixed in piece 5 by making the floor ask-only);
//! * *Batch Compressed Mercoxit III-Grade* prices at 9.55B/unit because its blueprint eats
//!   500 ore units at an SDE `basePrice` of 19.1M each.
//!
//! This module finds the rest mechanically. It **reports and never fixes**: no pricing rule
//! lives here, and nothing it computes is written anywhere.
//!
//! ### What a price means here
//!
//! Only seeded types have prices, and the two sides are not interchangeable:
//!
//! * a type with a `seed_stock` row can be **bought** at its ask;
//! * a type with a `seed_buy_orders` row can be **sold** at its bid;
//! * a type with neither has no ask and no bid. It contributes **zero revenue** as a
//!   reprocessing output, and makes a recipe **unbuyable** as a manufacturing input — such a
//!   recipe is not exploitable at all, so it is skipped and counted rather than flagged.
//!
//! v3 writes both sides for every seedable type, so in practice "seeded" is one set; the
//! asymmetry is still modelled explicitly because it is what makes an unpriced input a skip
//! instead of a free lunch.
//!
//! ### The four checks
//!
//! | check | the loop | violation |
//! |-------|----------|-----------|
//! | 1 reprocess   | buy 1 unit at ask, refine it, sell the output into seed bids | `revenue > ask` |
//! | 2 manufacture | buy the blueprint's inputs at asks, build 1 unit, sell it into its own seed bid | `bid > input cost` |
//! | 3 compression | buy one side, sell the other, both directions | `revenue > outlay` |
//! | 4 cross-station | buy at the cheapest seeded ask anywhere, haul, sell into the best bid elsewhere | `best bid > best ask` |
//!
//! ### Prices are the best price anywhere, not the Jita row
//!
//! Checks 1-3 predate the NPC overlay, when "the seed" meant one station and a type had one
//! ask and one bid. Now that TQ's NPC catalog seeds ~5,000 stations, every check prices a
//! type at the **best ask and best bid across all seeded stations** — a player will always
//! use the better price, so anything else under-reports — and every violation names the
//! station each of its prices came from.
//!
//! Check 4 exists because the first three would otherwise come back clean over a book they
//! only half understand: they all look for a *transformation*, and hauling is not one. With
//! rows at thousands of stations, "buy here, sell there" needs no skill, blueprint or refinery
//! and is the cheapest exploit in the game to run.
//!
//! ### Yield, and why the default is the *perfect* refine
//!
//! `--yield` defaults to **1.0**. A 100% recovery is the worst case for us: a loop that does
//! not pay at perfect refine cannot be exploited at any real skill level, so 1.0 is the only
//! honest gate. The realistic 0.906 pass is printed beside it so the report shows both.
//! Yield enters check 1 only — check 2 never refines anything, and in check 3 both sides
//! refine at the same rate, so it cancels out of the ratio.
//!
//! ### The 8% tax
//!
//! Selling into a seed bid pays the 8% transaction tax (`marketProxyService.js:2951`), so a
//! loop only really prints ISK when `revenue x 0.92 > outlay`. Every violation is reported
//! with and without it, and **the tax-surviving count at yield 1.0 is the build gate**:
//! non-zero means exit 1.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Result, bail};
use console::style;

use crate::build::{SeedPricingPair, SeedRow, SeedStation, plan_seed_rows};
use crate::classify::{Classification, ProducerIndex};
use crate::config::SeederConfig;
use crate::cost::{CostInputs, CostMap, CostReport, OverridePrices};
use crate::manifest::{CapturePolicy, PriceManifest, read_sde_build};
use crate::seedplan::{NpcCatalog, SeedPlan};
use crate::staticdata::{ReprocessingStatic, StaticData, resolve_static_data_dir};

/// The transaction tax a seed-bid fill pays (`doc/JITA_INDEX_SEED_PLAN.md` §5).
pub const SEED_BID_TAX: f64 = 0.08;
/// What the seller actually keeps out of a seed-bid sale.
pub const TAX_KEPT_FRACTION: f64 = 1.0 - SEED_BID_TAX;
/// Perfect refine — the default and the only yield the build gate is evaluated at.
pub const PERFECT_YIELD: f64 = 1.0;
/// A realistic station refine (50% base, max skills, no rigs), printed as a second pass.
pub const REALISTIC_YIELD: f64 = 0.906;

// ------------------------------------------------------------------------------- the book

/// Who wrote a seed row: us, or TQ.
///
/// This is the difference between a loop we can fix and a loop we inherited. Every price in
/// the book carries it, so a violation can say which of its legs — if any — is a price the
/// seeder computed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceOrigin {
    /// An index or junk row: `sell_multiplier x manifest cost` / `buy_multiplier x cost`, at
    /// the index station. Ours, and movable by a pricing rule.
    Seeder,
    /// A row imported verbatim from the TQ snapshot by [`crate::overlay`] — TQ's own NPC
    /// price at TQ's own station.
    NpcOverlay,
}

impl PriceOrigin {
    pub fn key(self) -> &'static str {
        match self {
            Self::Seeder => "seeder",
            Self::NpcOverlay => "npc-overlay",
        }
    }
}

/// One price, the station it is at, and who put it there.
#[derive(Debug, Clone, PartialEq)]
pub struct StationPrice {
    pub price: f64,
    pub station_id: u64,
    pub station_name: String,
    pub origin: PriceOrigin,
}

/// The best price for one side of one type across every seeded station, plus the best price
/// available at some **other** station.
///
/// The second field is what makes check 4 exact. If a type's best ask and best bid happen to
/// be at the same station, the cross-station question is not "is there an opportunity" but
/// "is there one between two *different* stations", and answering it needs the runner-up from
/// elsewhere. Without it a station that both buys high and sells low would mask a genuine
/// haul against a third station.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BestPrice {
    pub best: Option<StationPrice>,
    /// Best price at a station other than `best`'s.
    pub elsewhere: Option<StationPrice>,
}

impl BestPrice {
    /// One candidate ask: cheapest wins.
    pub fn absorb_ask(&mut self, candidate: StationPrice) {
        self.absorb(candidate, true);
    }

    /// One candidate bid: dearest wins.
    pub fn absorb_bid(&mut self, candidate: StationPrice) {
        self.absorb(candidate, false);
    }

    fn absorb(&mut self, candidate: StationPrice, minimise: bool) {
        let better = |left: f64, right: f64| {
            if minimise {
                left < right
            } else {
                left > right
            }
        };
        let Some(best) = self.best.clone() else {
            self.best = Some(candidate);
            return;
        };
        if better(candidate.price, best.price) {
            // The old best was the best over *all* stations, so it is exactly the best over
            // "every station but the new winner's" — unless it came from that same station,
            // in which case `elsewhere` is already right and must not move.
            if candidate.station_id != best.station_id {
                self.elsewhere = Some(best);
            }
            self.best = Some(candidate);
        } else if candidate.station_id != best.station_id {
            let improves = self
                .elsewhere
                .as_ref()
                .is_none_or(|current| better(candidate.price, current.price));
            if improves {
                self.elsewhere = Some(candidate);
            }
        }
    }

    pub fn price(&self) -> Option<f64> {
        self.best.as_ref().map(|entry| entry.price)
    }

    pub fn station_id(&self) -> Option<u64> {
        self.best.as_ref().map(|entry| entry.station_id)
    }

    /// Who wrote the best price on this side, when there is one.
    pub fn origin(&self) -> Option<PriceOrigin> {
        self.best.as_ref().map(|entry| entry.origin)
    }
}

/// Both seed prices for one seeded type, at the best station for each side.
#[derive(Debug, Clone, PartialEq)]
pub struct SeedSide {
    pub type_id: u32,
    pub name: String,
    /// `A`, `A+B`, `B`, `D`, or `C` for a type only the NPC overlay seeds.
    pub bucket: &'static str,
    /// The manifest price the index/junk sides were derived from; 0 for overlay-only types,
    /// which carry TQ's price and no cost model at all.
    pub cost: f64,
    /// Cheapest ask anywhere. Empty when nothing sells this type.
    pub ask: BestPrice,
    /// Highest bid anywhere, before the 8% tax. Empty when nothing buys this type.
    pub bid: BestPrice,
}

/// Which side of the book a price came from, so a report can say where to find it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceSide {
    Ask,
    Bid,
}

/// The seeded universe as a price book: the audit's whole view of the economy.
///
/// **A price is the best price available anywhere.** Before the NPC overlay landed this was
/// trivially the Jita 4-4 row, and the checks could assume it; now the same type can be sold
/// at Jita 4-4 by the index seed and bought by an NPC in Rens, and a player will always take
/// the better of the two. Every check therefore prices a type at its best ask and best bid
/// across all seeded stations, and reports which station each came from.
///
/// [`SeedBook::ask`] and [`SeedBook::bid`] return `None` for a side nothing seeds, which is
/// the distinction the checks are built on — an absent price is never silently a zero price.
#[derive(Debug, Clone, Default)]
pub struct SeedBook {
    entries: BTreeMap<u32, SeedSide>,
    /// The index seed's own station, used only to keep the report readable: prices from
    /// anywhere else are tagged with their station, prices from here are not.
    index_station_id: Option<u64>,
    /// Distinct stations contributing at least one price.
    stations: BTreeSet<u64>,
}

impl SeedBook {
    /// Built from the same [`SeedRow`] set the build writes, so the audited prices are the
    /// prices — not a re-derivation that could drift from them. A side the build will not
    /// write (deferred to the NPC catalog) gets no price here either: an absent price is the
    /// whole distinction the checks are built on.
    pub fn from_rows(rows: &[SeedRow], station: &SeedStation) -> Self {
        let mut book = Self {
            index_station_id: Some(station.station_id),
            ..Self::default()
        };
        for row in rows {
            book.insert(SeedSide {
                type_id: row.type_id,
                name: row.name.clone(),
                bucket: row.bucket,
                cost: row.cost,
                ask: one_price(row.writes_ask().then_some(row.ask), station),
                bid: one_price(row.writes_bid().then_some(row.bid), station),
            });
        }
        book.stations.insert(station.station_id);
        book
    }

    /// Folds the NPC overlay into the book **exactly as the build writes it**: the overlay
    /// went in first, then the index pass `INSERT OR REPLACE`d its own station, so an overlay
    /// row at the index station on a side the index pass also seeds no longer exists in the
    /// database and must not exist here either. Every other overlay row does — including the
    /// one at the index station on a side the index pass **deferred**, which is precisely the
    /// row the deferral left standing.
    pub fn merge_overlay(
        &mut self,
        import: &crate::overlay::OverlayImport,
        static_data: &StaticData,
        index_station_id: u64,
    ) {
        let planned = |side: PriceSide| -> BTreeSet<u32> {
            self.entries
                .values()
                .filter(|entry| match side {
                    PriceSide::Ask => entry.ask.best.is_some(),
                    PriceSide::Bid => entry.bid.best.is_some(),
                })
                .map(|entry| entry.type_id)
                .collect()
        };
        let (planned_ask, planned_bid) = (planned(PriceSide::Ask), planned(PriceSide::Bid));
        let mut names: BTreeMap<u64, String> = BTreeMap::new();
        let mut station_name = |station_id: u64, data: &StaticData| -> String {
            names
                .entry(station_id)
                .or_insert_with(|| {
                    data.station(station_id)
                        .map(|station| station.station_name.clone())
                        .unwrap_or_else(|| format!("station {station_id}"))
                })
                .clone()
        };

        for (side, book, planned) in [
            (PriceSide::Ask, &import.sell, &planned_ask),
            (PriceSide::Bid, &import.buy, &planned_bid),
        ] {
            for ((station_id, type_id), row) in book {
                if *station_id == index_station_id && planned.contains(type_id) {
                    // Replaced by the index pass. Counting it here would audit a price that
                    // is not in the database.
                    continue;
                }
                let candidate = StationPrice {
                    price: row.price(),
                    station_id: *station_id,
                    station_name: station_name(*station_id, static_data),
                    origin: PriceOrigin::NpcOverlay,
                };
                let entry = self.entries.entry(*type_id).or_insert_with(|| SeedSide {
                    type_id: *type_id,
                    name: static_data
                        .item_type(*type_id)
                        .map(|item| item.name.clone())
                        .unwrap_or_else(|| format!("type {type_id}")),
                    // Plan §2.3's bucket: seeded by TQ's NPCs, priced by nothing of ours.
                    bucket: "C",
                    cost: 0.0,
                    ask: BestPrice::default(),
                    bid: BestPrice::default(),
                });
                match side {
                    PriceSide::Ask => entry.ask.absorb_ask(candidate),
                    PriceSide::Bid => entry.bid.absorb_bid(candidate),
                }
                self.stations.insert(*station_id);
            }
        }
    }

    pub fn insert(&mut self, side: SeedSide) {
        for price in [
            side.ask.best.as_ref(),
            side.ask.elsewhere.as_ref(),
            side.bid.best.as_ref(),
            side.bid.elsewhere.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            self.stations.insert(price.station_id);
        }
        self.entries.insert(side.type_id, side);
    }

    pub fn get(&self, type_id: u32) -> Option<&SeedSide> {
        self.entries.get(&type_id)
    }

    pub fn station_count(&self) -> usize {
        self.stations.len()
    }

    /// What one unit costs to buy from the seed at the cheapest station that sells it, or
    /// `None` when no `seed_stock` row anywhere holds it.
    pub fn ask(&self, type_id: u32) -> Option<f64> {
        self.entries
            .get(&type_id)
            .and_then(|side| side.ask.price())
    }

    /// What the best seed bid anywhere pays for one unit, or `None` when nothing buys it.
    pub fn bid(&self, type_id: u32) -> Option<f64> {
        self.entries
            .get(&type_id)
            .and_then(|side| side.bid.price())
    }

    /// The cheapest ask anywhere, with its station and its origin — what a check needs to
    /// know both what a leg costs and whose price it is.
    pub fn ask_price(&self, type_id: u32) -> Option<&StationPrice> {
        self.entries
            .get(&type_id)
            .and_then(|side| side.ask.best.as_ref())
    }

    /// The dearest bid anywhere, with its station and its origin.
    pub fn bid_price(&self, type_id: u32) -> Option<&StationPrice> {
        self.entries
            .get(&type_id)
            .and_then(|side| side.bid.best.as_ref())
    }

    /// `" @ Rens VI - Moon 8 - …"` when the price is not at the index station, `""` when it
    /// is. Keeps a 40-item material list readable while still saying where every price lives.
    pub fn qualify(&self, type_id: u32, side: PriceSide) -> String {
        let Some(entry) = self.entries.get(&type_id) else {
            return String::new();
        };
        let best = match side {
            PriceSide::Ask => entry.ask.best.as_ref(),
            PriceSide::Bid => entry.bid.best.as_ref(),
        };
        match best {
            Some(price) if Some(price.station_id) != self.index_station_id => {
                format!(" @ {}", price.station_name)
            }
            _ => String::new(),
        }
    }

    /// The revenue an unseeded output contributes: nothing. Separate from [`SeedBook::bid`]
    /// so a caller has to opt into the zero rather than get it by accident.
    pub fn bid_or_zero(&self, type_id: u32) -> f64 {
        self.bid(type_id).unwrap_or(0.0)
    }

    pub fn name(&self, type_id: u32) -> String {
        self.entries
            .get(&type_id)
            .map(|side| side.name.clone())
            .unwrap_or_else(|| format!("type {type_id}"))
    }

    pub fn iter(&self) -> impl Iterator<Item = &SeedSide> {
        self.entries.values()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Seeded types per bucket label, in report order.
    pub fn composition(&self) -> Vec<(&'static str, usize)> {
        let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
        for side in self.entries.values() {
            *counts.entry(side.bucket).or_insert(0) += 1;
        }
        ["A", "A+B", "B", "C", "D"]
            .into_iter()
            .map(|label| (label, counts.get(label).copied().unwrap_or(0)))
            .collect()
    }
}

/// One price at one station: what an index/junk seed row is before any overlay merges in.
/// `None` for a side the index pass does not write, which is an absent price, not a zero one.
fn one_price(price: Option<f64>, station: &SeedStation) -> BestPrice {
    BestPrice {
        best: price.map(|price| StationPrice {
            price,
            station_id: station.station_id,
            station_name: station.station_name.clone(),
            origin: PriceOrigin::Seeder,
        }),
        elsewhere: None,
    }
}

// ----------------------------------------------------------------------------- the checks

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Check {
    Reprocess,
    Manufacture,
    Compression,
    CrossStation,
}

impl Check {
    pub fn number(self) -> u8 {
        match self {
            Self::Reprocess => 1,
            Self::Manufacture => 2,
            Self::Compression => 3,
            Self::CrossStation => 4,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Reprocess => "reprocess",
            Self::Manufacture => "manufacture",
            Self::Compression => "compression",
            Self::CrossStation => "cross-station",
        }
    }

    /// One line saying what loop the check walks.
    pub fn headline(self) -> &'static str {
        match self {
            Self::Reprocess => "buy 1 unit at its ask, refine it, sell the output into seed bids",
            Self::Manufacture => {
                "buy a blueprint's inputs at seed asks, build 1 unit, sell it into its own seed bid"
            }
            Self::Compression => {
                "buy one side of a compressed/uncompressed pair and sell the other, both ways"
            }
            Self::CrossStation => {
                "buy 1 unit at the cheapest seeded ask anywhere, haul it, sell it into the \
                 highest seeded bid at another station"
            }
        }
    }
}

// Skip reasons. Static strings so the report can group them without allocating per type.
const SKIP_NO_REPROCESSING_ROW: &str = "no reprocessing row";
const SKIP_NOT_REPROCESSABLE: &str = "neither refinable nor recyclable";
const SKIP_REFINES_INTO_NOTHING: &str = "refines into nothing";
const SKIP_BAD_PORTION_SIZE: &str = "portion size <= 0 (bad data)";
const SKIP_NO_PRODUCER: &str = "no blueprint produces it";
const SKIP_BAD_PER_RUN: &str = "blueprint per-run output <= 0 (bad data)";
const SKIP_BUILDS_FROM_NOTHING: &str = "blueprint consumes nothing";
const SKIP_UNBUYABLE_MATERIAL: &str = "an input is not seeded (unbuyable)";
const SKIP_ZERO_INPUT_COST: &str = "inputs cost 0 (bad data)";
const SKIP_PAIR_UNSEEDED: &str = "one side of the pair is not seeded";
const SKIP_NO_RATIO_BASIS: &str = "no blueprint and no comparable refine yields";
const SKIP_RATIO_DISAGREES: &str = "refine yields disagree on the ratio";
const SKIP_NOT_BUYABLE: &str = "nothing sells it (no ask anywhere)";
const SKIP_NOT_SELLABLE: &str = "nothing buys it (no bid anywhere)";
const SKIP_ONE_SIDED: &str = "seeded on one side only";
const SKIP_SINGLE_STATION: &str = "only one station holds both sides";

/// Whether a loop touches a price **we** set.
///
/// The whole point of the distinction is that only one of these two is ours to fix. A loop
/// with a seeder-priced leg exists because our computed price met some other price; a loop
/// with no seeder-priced leg at all is TQ's own book, imported verbatim by decision 2's
/// TQ-authentic placement, and no pricing rule of ours can close it without discarding NPC
/// rows CCP ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ownership {
    /// At least one leg is an index or junk row — a price the seeder computed.
    SeederInvolved,
    /// Every leg is an NPC overlay row. Inherited from the TQ snapshot.
    NpcToNpc,
}

impl Ownership {
    /// Ours if **any** leg is ours.
    pub fn of(origins: impl IntoIterator<Item = PriceOrigin>) -> Self {
        if origins
            .into_iter()
            .any(|origin| origin == PriceOrigin::Seeder)
        {
            Self::SeederInvolved
        } else {
            Self::NpcToNpc
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::SeederInvolved => "seeder-involved",
            Self::NpcToNpc => "npc-to-npc",
        }
    }

    pub fn is_seeder_involved(self) -> bool {
        matches!(self, Self::SeederInvolved)
    }
}

/// One loop that returns more than it costs.
///
/// `type_id`/`name` always name the type the loop **sells** — the thing whose bid is paying
/// out — because that is the price a fix would have to move.
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    pub check: Check,
    pub type_id: u32,
    pub name: String,
    pub bucket: &'static str,
    /// Whether any leg of this loop is a price the seeder computed.
    pub ownership: Ownership,
    /// The loop in words, with the quantities that make it work.
    pub loop_text: String,
    /// ISK spent at seed asks.
    pub outlay: f64,
    /// ISK the seed bids pay back, before tax.
    pub revenue: f64,
}

impl Violation {
    /// `revenue / outlay`. Callers only build a [`Violation`] with a positive outlay, so this
    /// is finite and > 1.
    pub fn ratio(&self) -> f64 {
        self.revenue / self.outlay
    }

    /// What the loop actually pays after the 8% seed-bid transaction tax.
    pub fn after_tax(&self) -> f64 {
        self.revenue * TAX_KEPT_FRACTION
    }

    /// The question that matters: is this still a money pump once the tax is paid?
    pub fn survives_tax(&self) -> bool {
        self.after_tax() > self.outlay
    }

    /// Whether this loop fails the build.
    ///
    /// Everything that survives the tax gates, with exactly one exception: a **check 4**
    /// npc-to-npc haul is TQ's own fixed NPC spread across two of TQ's own stations, which
    /// `[import] gate_on_npc_arbitrage` (default false) decides about. The exception is
    /// deliberately narrow — an npc-to-npc *transformation* (checks 1-3) would mean TQ's
    /// prices disagree with the game's own reprocessing or manufacturing mechanics, which is
    /// a different claim entirely and still gates.
    pub fn gates(&self, gate_on_npc_arbitrage: bool) -> bool {
        if !self.survives_tax() {
            return false;
        }
        self.ownership.is_seeder_involved()
            || self.check != Check::CrossStation
            || gate_on_npc_arbitrage
    }
}

/// What one check found: how much it looked at, what it could not look at and why, and every
/// loop that came out positive.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckOutcome {
    pub check: Check,
    /// Candidates actually evaluated.
    pub checked: usize,
    /// Reason → how many candidates it excluded. Sums to [`CheckOutcome::skipped_total`].
    pub skipped: BTreeMap<&'static str, usize>,
    /// Sorted by ratio, worst first.
    pub violations: Vec<Violation>,
    /// Free-text observations that are not skips — printed under the counts.
    pub notes: Vec<String>,
}

impl CheckOutcome {
    pub fn new(check: Check) -> Self {
        Self {
            check,
            checked: 0,
            skipped: BTreeMap::new(),
            violations: Vec::new(),
            notes: Vec::new(),
        }
    }

    fn skip(&mut self, reason: &'static str) {
        *self.skipped.entry(reason).or_insert(0) += 1;
    }

    /// Records a loop **only if it is actually positive**, so callers can hand every
    /// evaluated candidate here without pre-filtering. A non-positive outlay is refused: a
    /// free purchase would divide by zero and is bad data, not an exploit.
    ///
    /// `ownership` is computed from the origins of every price the loop actually used, which
    /// only the caller knows.
    fn consider(
        &mut self,
        type_id: u32,
        name: String,
        bucket: &'static str,
        ownership: Ownership,
        outlay: f64,
        revenue: f64,
        loop_text: impl FnOnce() -> String,
    ) {
        if !(outlay.is_finite() && outlay > 0.0) || !revenue.is_finite() || revenue <= outlay {
            return;
        }
        self.violations.push(Violation {
            check: self.check,
            type_id,
            name,
            bucket,
            ownership,
            loop_text: loop_text(),
            outlay,
            revenue,
        });
    }

    fn finish(mut self) -> Self {
        self.violations.sort_by(|left, right| {
            right
                .ratio()
                .partial_cmp(&left.ratio())
                .unwrap_or(Ordering::Equal)
                .then(left.type_id.cmp(&right.type_id))
        });
        self
    }

    pub fn skipped_total(&self) -> usize {
        self.skipped.values().sum()
    }

    pub fn violation_count(&self) -> usize {
        self.violations.len()
    }

    /// Violations that still print ISK after the 8% tax.
    pub fn surviving_tax(&self) -> usize {
        self.violations
            .iter()
            .filter(|violation| violation.survives_tax())
            .count()
    }

    pub fn violations_owned(&self, ownership: Ownership) -> impl Iterator<Item = &Violation> {
        self.violations
            .iter()
            .filter(move |violation| violation.ownership == ownership)
    }

    pub fn violation_count_owned(&self, ownership: Ownership) -> usize {
        self.violations_owned(ownership).count()
    }

    /// Tax-surviving violations on one side of the ownership split.
    pub fn surviving_tax_owned(&self, ownership: Ownership) -> usize {
        self.violations_owned(ownership)
            .filter(|violation| violation.survives_tax())
            .count()
    }

    /// Tax-surviving violations that actually fail the build under this gate setting.
    pub fn gating(&self, gate_on_npc_arbitrage: bool) -> usize {
        self.violations
            .iter()
            .filter(|violation| violation.gates(gate_on_npc_arbitrage))
            .count()
    }

    pub fn worst_ratio(&self) -> Option<f64> {
        self.violations.first().map(Violation::ratio)
    }
}

/// Check 1 — reprocess pump.
///
/// `revenue_per_unit = yield * Σ(quantity * bid(material)) / portion_size`, flagged when it
/// beats the type's own ask. Outputs that are not seeded pay nothing and are counted in a
/// note: they make the loop *less* profitable, so including them can only under-report.
pub fn check_reprocess(
    book: &SeedBook,
    reprocessing: &ReprocessingStatic,
    refine_yield: f64,
) -> CheckOutcome {
    let mut outcome = CheckOutcome::new(Check::Reprocess);
    let mut with_unseeded_outputs = 0usize;

    for side in book.iter() {
        let Some(ask_price) = side.ask.best.as_ref() else {
            // Nothing sells it, so the loop cannot even be started.
            outcome.skip(SKIP_NOT_BUYABLE);
            continue;
        };
        let Some(entry) = reprocessing.get(side.type_id) else {
            outcome.skip(SKIP_NO_REPROCESSING_ROW);
            continue;
        };
        if !entry.is_reprocessable() {
            outcome.skip(SKIP_NOT_REPROCESSABLE);
            continue;
        }
        if entry.materials.is_empty() {
            outcome.skip(SKIP_REFINES_INTO_NOTHING);
            continue;
        }
        if entry.portion_size <= 0 {
            outcome.skip(SKIP_BAD_PORTION_SIZE);
            continue;
        }

        outcome.checked += 1;
        let portion = entry.portion_size as f64;
        let mut revenue = 0.0;
        let mut unseeded_output = false;
        // Every price the loop touches: the ask it buys at, and each output bid it sells into.
        let mut origins = vec![ask_price.origin];
        // (material, units per refined unit, ISK per refined unit)
        let mut parts: Vec<(u32, f64, f64)> = Vec::with_capacity(entry.materials.len());
        for material in &entry.materials {
            let per_unit = material.quantity as f64 / portion;
            match book.bid_price(material.type_id) {
                Some(bid) => {
                    let value = per_unit * bid.price * refine_yield;
                    revenue += value;
                    origins.push(bid.origin);
                    parts.push((material.type_id, per_unit * refine_yield, value));
                }
                None => unseeded_output = true,
            }
        }
        if unseeded_output {
            with_unseeded_outputs += 1;
        }

        let ask = ask_price.price;
        let ask_station = ask_price.station_name.clone();
        let name = side.name.clone();
        let ownership = Ownership::of(origins);
        outcome.consider(
            side.type_id,
            name.clone(),
            side.bucket,
            ownership,
            ask,
            revenue,
            || {
                format!(
                    "buy 1 x {} at ask {} at {} -> refine at {} -> {} -> seed bids pay {}",
                    name,
                    crate::isk(ask),
                    ask_station,
                    percent(refine_yield),
                    describe_parts(book, &parts, PriceSide::Bid),
                    crate::isk(revenue)
                )
            },
        );
    }

    if with_unseeded_outputs > 0 {
        outcome.notes.push(format!(
            "{} of the checked types refine into at least one unseeded output, which pays 0 \
             and can only make the loop look worse than it is",
            count(with_unseeded_outputs)
        ));
    }
    outcome.finish()
}

/// Check 2 — manufacture pump.
///
/// `input_cost_per_unit = Σ(quantity * ask(material)) / per_run`, flagged when the product's
/// own seed **bid** beats it: build it out of seed-bought parts and sell it straight back.
/// A recipe with any unbuyable input cannot be run against the seed at all and is skipped.
pub fn check_manufacture(book: &SeedBook, producers: &ProducerIndex) -> CheckOutcome {
    let mut outcome = CheckOutcome::new(Check::Manufacture);

    for side in book.iter() {
        let Some(bid_price) = side.bid.best.as_ref() else {
            // Nothing buys it, so building it against the seed pays nothing.
            outcome.skip(SKIP_NOT_SELLABLE);
            continue;
        };
        let Some(producer) = producers.get(side.type_id) else {
            outcome.skip(SKIP_NO_PRODUCER);
            continue;
        };
        if producer.per_run <= 0 {
            outcome.skip(SKIP_BAD_PER_RUN);
            continue;
        }
        if producer.materials.is_empty() {
            outcome.skip(SKIP_BUILDS_FROM_NOTHING);
            continue;
        }

        let per_run = producer.per_run as f64;
        let mut input_cost = 0.0;
        let mut unbuyable = false;
        // The product's own bid, plus the ask of every input the recipe buys.
        let mut origins = vec![bid_price.origin];
        let mut parts: Vec<(u32, f64, f64)> = Vec::with_capacity(producer.materials.len());
        for material in &producer.materials {
            let Some(ask) = book.ask_price(material.type_id) else {
                unbuyable = true;
                break;
            };
            let per_unit = material.quantity as f64 / per_run;
            input_cost += per_unit * ask.price;
            origins.push(ask.origin);
            parts.push((material.type_id, per_unit, per_unit * ask.price));
        }
        if unbuyable {
            outcome.skip(SKIP_UNBUYABLE_MATERIAL);
            continue;
        }
        if !(input_cost.is_finite() && input_cost > 0.0) {
            outcome.skip(SKIP_ZERO_INPUT_COST);
            continue;
        }

        outcome.checked += 1;
        let name = side.name.clone();
        let bid = bid_price.price;
        let bid_station = bid_price.station_name.clone();
        let activity = producer.activity.label();
        let blueprint = producer.blueprint_type_id;
        let ownership = Ownership::of(origins);
        outcome.consider(
            side.type_id,
            name.clone(),
            side.bucket,
            ownership,
            input_cost,
            bid,
            || {
                format!(
                    "buy {} at seed asks for {} per unit -> {} 1 x {} (blueprint {}, {} per \
                     run) -> the best seed bid, at {}, pays {}",
                    describe_parts(book, &parts, PriceSide::Ask),
                    crate::isk(input_cost),
                    activity.to_lowercase(),
                    name,
                    blueprint,
                    producer_run_label(producer.per_run),
                    bid_station,
                    crate::isk(bid)
                )
            },
        );
    }

    outcome.finish()
}

/// Where a compression ratio came from. Reported per pair, because the two bases can and do
/// disagree, and a guess would be worse than a skip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RatioBasis {
    /// The compression blueprint itself: `material quantity / per-run output`.
    Blueprint(u32),
    /// Both sides refine into the same materials, so their per-unit yields fix the ratio.
    RefineYield,
}

impl RatioBasis {
    pub fn describe(self) -> String {
        match self {
            Self::Blueprint(blueprint) => format!("blueprint {blueprint}"),
            Self::RefineYield => "refine yields".to_string(),
        }
    }
}

/// How many source units one compressed unit is worth, and where that number came from.
///
/// The blueprint is preferred because it is the mechanism a player would actually use. The
/// refine-yield basis is the fallback for the 200 of 212 pairs with no compression blueprint
/// in the SDE: both sides refine into the same materials, so the ratio of their per-unit
/// yields *is* the compression ratio. Returns the skip reason when neither basis exists.
pub fn compression_ratio(
    source: u32,
    compressed: u32,
    reprocessing: &ReprocessingStatic,
    producers: &ProducerIndex,
) -> Result<(f64, RatioBasis), &'static str> {
    if let Some(producer) = producers.get(compressed) {
        if producer.per_run > 0 {
            if let Some(material) = producer
                .materials
                .iter()
                .find(|material| material.type_id == source)
            {
                let ratio = material.quantity as f64 / producer.per_run as f64;
                if ratio.is_finite() && ratio > 0.0 {
                    return Ok((ratio, RatioBasis::Blueprint(producer.blueprint_type_id)));
                }
            }
        }
    }

    let source_yield = per_unit_yield(reprocessing, source).ok_or(SKIP_NO_RATIO_BASIS)?;
    let compressed_yield = per_unit_yield(reprocessing, compressed).ok_or(SKIP_NO_RATIO_BASIS)?;
    let mut resolved: Option<f64> = None;
    for (material, source_per_unit) in &source_yield {
        let Some(compressed_per_unit) = compressed_yield.get(material) else {
            continue;
        };
        if *source_per_unit <= 0.0 {
            continue;
        }
        let ratio = compressed_per_unit / source_per_unit;
        if !(ratio.is_finite() && ratio > 0.0) {
            continue;
        }
        match resolved {
            None => resolved = Some(ratio),
            // Every shared material must agree, or the pair has no single ratio and the
            // honest answer is to skip it.
            Some(first) if (ratio - first).abs() > first.abs() * 1e-6 => {
                return Err(SKIP_RATIO_DISAGREES);
            }
            Some(_) => {}
        }
    }
    resolved
        .map(|ratio| (ratio, RatioBasis::RefineYield))
        .ok_or(SKIP_NO_RATIO_BASIS)
}

/// Materials per **one unit** of a type, or `None` when it has no usable refine row.
fn per_unit_yield(reprocessing: &ReprocessingStatic, type_id: u32) -> Option<BTreeMap<u32, f64>> {
    let entry = reprocessing.get(type_id)?;
    if entry.materials.is_empty() || entry.portion_size <= 0 {
        return None;
    }
    let portion = entry.portion_size as f64;
    Some(
        entry
            .materials
            .iter()
            .map(|material| (material.type_id, material.quantity as f64 / portion))
            .collect(),
    )
}

/// Check 3 — compression pump.
///
/// Both directions of every compressed/uncompressed pair where both sides are seeded: buy
/// the source and sell the compressed product, and buy the compressed product and sell the
/// source back. Yield does not enter: no refining happens in either direction, and the
/// refine-yield *basis* is a ratio of two yields, so a common factor cancels.
pub fn check_compression(
    book: &SeedBook,
    reprocessing: &ReprocessingStatic,
    producers: &ProducerIndex,
) -> CheckOutcome {
    let mut outcome = CheckOutcome::new(Check::Compression);
    let mut by_basis: BTreeMap<&'static str, usize> = BTreeMap::new();

    for (source, compressed) in &reprocessing.compressed_by_source {
        let (source, compressed) = (*source, *compressed);
        let (Some(source_side), Some(compressed_side)) = (book.get(source), book.get(compressed))
        else {
            outcome.skip(SKIP_PAIR_UNSEEDED);
            continue;
        };
        // Both directions need both sides of both types.
        let (
            Some(source_ask),
            Some(source_bid),
            Some(compressed_ask),
            Some(compressed_bid),
        ) = (
            source_side.ask.best.as_ref(),
            source_side.bid.best.as_ref(),
            compressed_side.ask.best.as_ref(),
            compressed_side.bid.best.as_ref(),
        )
        else {
            outcome.skip(SKIP_ONE_SIDED);
            continue;
        };
        let (ratio, basis) = match compression_ratio(source, compressed, reprocessing, producers) {
            Ok(resolved) => resolved,
            Err(reason) => {
                outcome.skip(reason);
                continue;
            }
        };

        outcome.checked += 1;
        *by_basis
            .entry(match basis {
                RatioBasis::Blueprint(_) => "blueprint",
                RatioBasis::RefineYield => "refine yields",
            })
            .or_insert(0) += 1;

        // Forward: buy `ratio` source units, end up holding one compressed unit, sell it.
        let compress_outlay = ratio * source_ask.price;
        let compressed_name = compressed_side.name.clone();
        let source_name = source_side.name.clone();
        let basis_text = basis.describe();
        let source_ask_station = source_ask.station_name.clone();
        let compressed_bid_station = compressed_bid.station_name.clone();
        outcome.consider(
            compressed,
            compressed_name.clone(),
            compressed_side.bucket,
            Ownership::of([source_ask.origin, compressed_bid.origin]),
            compress_outlay,
            compressed_bid.price,
            || {
                format!(
                    "buy {} x {} at ask {} each at {} = {} -> compress to 1 x {} (ratio from \
                     {}) -> its seed bid at {} pays {}",
                    trim_float(ratio),
                    source_name,
                    crate::isk(source_ask.price),
                    source_ask_station,
                    crate::isk(compress_outlay),
                    compressed_name,
                    basis_text,
                    compressed_bid_station,
                    crate::isk(compressed_bid.price)
                )
            },
        );

        // Reverse: buy one compressed unit and sell the source units it stands for.
        let expand_revenue = ratio * source_bid.price;
        let compressed_name = compressed_side.name.clone();
        let source_name = source_side.name.clone();
        let basis_text = basis.describe();
        let compressed_ask_station = compressed_ask.station_name.clone();
        let source_bid_station = source_bid.station_name.clone();
        outcome.consider(
            source,
            source_name.clone(),
            source_side.bucket,
            Ownership::of([compressed_ask.origin, source_bid.origin]),
            compressed_ask.price,
            expand_revenue,
            || {
                format!(
                    "buy 1 x {} at ask {} at {} -> unpack to {} x {} (ratio from {}) -> their \
                     seed bids at {} pay {} each = {}",
                    compressed_name,
                    crate::isk(compressed_ask.price),
                    compressed_ask_station,
                    trim_float(ratio),
                    source_name,
                    basis_text,
                    source_bid_station,
                    crate::isk(source_bid.price),
                    crate::isk(expand_revenue)
                )
            },
        );
    }

    for (basis, pairs) in by_basis {
        outcome
            .notes
            .push(format!("{} pairs took their ratio from {basis}", count(pairs)));
    }
    outcome.finish()
}

/// Check 4 — cross-station arbitrage (plan §8 item 7, generalised).
///
/// The first three checks all ask "can one seeded type be turned into another for a profit".
/// None of them asks the simplest question of all: **can one type be bought at one station
/// and sold at another?** While the seed lived at Jita 4-4 alone that question had no content.
/// With the NPC overlay writing rows at ~5,000 stations it does, and a clean run of checks 1-3
/// over an overlay-shaped book would be false confidence: no transformation is needed, no
/// skill, no blueprint — buy, undock, dock, sell.
///
/// So: for every type seeded anywhere, compare the **lowest ask across all seeded stations**
/// against the **highest bid across all seeded stations**. `best_bid > best_ask` is free ISK
/// at the rate a player can haul.
///
/// **Same-station pairs are not this check's business.** A bid above an ask at one station is
/// the build's own `bid <= ask` invariant (`build::verify_seed_rows`), and for our own rows it
/// cannot happen; where the overlay carries one it is TQ's price, and it is counted in a note
/// rather than double-reported here. When the best ask and the best bid *are* at one station,
/// the check falls back to the best price available elsewhere on each side
/// ([`BestPrice::elsewhere`]) so a station that both buys high and sells low cannot mask a
/// genuine haul against a third one.
///
/// ### Who owns the loop decides what it means
///
/// Every violation is tagged [`Ownership`], and the two kinds are genuinely different findings:
///
/// * **seeder-involved** — one leg is our computed price. Our price met a fixed NPC price and
///   lost. This is a bug in the seed and it gates the build.
/// * **npc-to-npc** — both legs are TQ's own NPC rows: TQ sells a trade good in one station
///   for less than TQ buys it back in another. Nothing of ours produced it, and no multiplier
///   of ours can close it; the only way to remove it is to discard or reprice NPC rows, which
///   would undo plan decision 2 (TQ-authentic placement) and invent a catalog CCP does not
///   ship. Reported in full, in its own section, and gated only when `[import]
///   gate_on_npc_arbitrage` says so.
pub fn check_cross_station(book: &SeedBook) -> CheckOutcome {
    let mut outcome = CheckOutcome::new(Check::CrossStation);
    let mut same_station_crossings: Vec<(u32, String, f64, f64, String)> = Vec::new();

    for side in book.iter() {
        let (Some(best_ask), Some(best_bid)) = (side.ask.best.as_ref(), side.bid.best.as_ref())
        else {
            outcome.skip(SKIP_ONE_SIDED);
            continue;
        };

        // The best pair whose two legs are at different stations.
        let (buy_at, sell_to) = if best_ask.station_id != best_bid.station_id {
            (Some(best_ask), Some(best_bid))
        } else {
            if best_bid.price > best_ask.price {
                same_station_crossings.push((
                    side.type_id,
                    side.name.clone(),
                    best_ask.price,
                    best_bid.price,
                    best_ask.station_name.clone(),
                ));
            }
            // Both legs at one station: take whichever substitution leaves more on the table.
            let hold_bid = side
                .ask
                .elsewhere
                .as_ref()
                .map(|ask| (best_bid.price - ask.price, ask, best_bid));
            let hold_ask = side
                .bid
                .elsewhere
                .as_ref()
                .map(|bid| (bid.price - best_ask.price, best_ask, bid));
            match [hold_bid, hold_ask]
                .into_iter()
                .flatten()
                .max_by(|left, right| left.0.total_cmp(&right.0))
            {
                Some((_, ask, bid)) => (Some(ask), Some(bid)),
                None => {
                    outcome.skip(SKIP_SINGLE_STATION);
                    continue;
                }
            }
        };
        let (Some(buy_at), Some(sell_to)) = (buy_at, sell_to) else {
            outcome.skip(SKIP_SINGLE_STATION);
            continue;
        };

        outcome.checked += 1;
        let name = side.name.clone();
        let ask = buy_at.price;
        let bid = sell_to.price;
        let ask_station = buy_at.station_name.clone();
        let ask_station_id = buy_at.station_id;
        let ask_origin = buy_at.origin;
        let bid_station = sell_to.station_name.clone();
        let bid_station_id = sell_to.station_id;
        let bid_origin = sell_to.origin;
        outcome.consider(
            side.type_id,
            name.clone(),
            side.bucket,
            Ownership::of([ask_origin, bid_origin]),
            ask,
            bid,
            || {
                format!(
                    "buy 1 x {} for {} at {} ({}, {}) -> haul it -> sell into the seed bid at \
                     {} ({}, {}) for {}: margin {} per unit",
                    name,
                    crate::isk(ask),
                    ask_station,
                    ask_station_id,
                    ask_origin.key(),
                    bid_station,
                    bid_station_id,
                    bid_origin.key(),
                    crate::isk(bid),
                    crate::isk(bid - ask)
                )
            },
        );
    }

    if !same_station_crossings.is_empty() {
        same_station_crossings.sort_by(|left, right| (right.3 - right.2).total_cmp(&(left.3 - left.2)));
        let worst = same_station_crossings
            .iter()
            .take(5)
            .map(|(type_id, name, ask, bid, station)| {
                format!(
                    "{type_id} {name} bids {} against its own {} ask at {station}",
                    crate::isk(*bid),
                    crate::isk(*ask)
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        outcome.notes.push(format!(
            "{} types cross their own book at ONE station (bid above ask at the same place). \
             Those are not cross-station hauls and are not counted above; none can be ours, \
             so they are TQ prices the overlay imported. Two things make that true: the build \
             proves its own two rows uncrossed, and where per-side deferral leaves one side \
             ours and the other TQ's at the index station, the deferral measured TQ's best \
             prices INCLUDING that station's. Worst: {worst}",
            count(same_station_crossings.len())
        ));
    }
    outcome.finish()
}

// ------------------------------------------------------------------------------ the report

/// All four checks at one yield.
#[derive(Debug, Clone)]
pub struct AuditReport {
    pub refine_yield: f64,
    pub reprocess: CheckOutcome,
    pub manufacture: CheckOutcome,
    pub compression: CheckOutcome,
    pub cross_station: CheckOutcome,
}

impl AuditReport {
    pub fn run(
        book: &SeedBook,
        reprocessing: &ReprocessingStatic,
        producers: &ProducerIndex,
        refine_yield: f64,
    ) -> Self {
        Self {
            refine_yield,
            reprocess: check_reprocess(book, reprocessing, refine_yield),
            manufacture: check_manufacture(book, producers),
            compression: check_compression(book, reprocessing, producers),
            cross_station: check_cross_station(book),
        }
    }

    pub fn checks(&self) -> [&CheckOutcome; 4] {
        [
            &self.reprocess,
            &self.manufacture,
            &self.compression,
            &self.cross_station,
        ]
    }

    pub fn violations(&self) -> impl Iterator<Item = &Violation> {
        self.checks()
            .into_iter()
            .flat_map(|outcome| outcome.violations.iter())
    }

    pub fn violation_count(&self) -> usize {
        self.checks()
            .into_iter()
            .map(CheckOutcome::violation_count)
            .sum()
    }

    /// Loops that still pay after the 8% transaction tax, whoever owns them.
    pub fn surviving_tax(&self) -> usize {
        self.checks()
            .into_iter()
            .map(CheckOutcome::surviving_tax)
            .sum()
    }

    pub fn surviving_tax_owned(&self, ownership: Ownership) -> usize {
        self.checks()
            .into_iter()
            .map(|outcome| outcome.surviving_tax_owned(ownership))
            .sum()
    }

    pub fn violation_count_owned(&self, ownership: Ownership) -> usize {
        self.checks()
            .into_iter()
            .map(|outcome| outcome.violation_count_owned(ownership))
            .sum()
    }

    /// **The build gate.** Tax-surviving loops that fail the build, which is everything
    /// except the check-4 npc-to-npc hauls when `[import] gate_on_npc_arbitrage` is off.
    pub fn gating(&self, gate_on_npc_arbitrage: bool) -> usize {
        self.checks()
            .into_iter()
            .map(|outcome| outcome.gating(gate_on_npc_arbitrage))
            .sum()
    }

    /// Tax-surviving check-4 hauls between two NPC stations — inherited from the TQ snapshot,
    /// and the one class the gate can be told to forgive.
    pub fn inherited_npc_hauls(&self) -> usize {
        self.cross_station.surviving_tax_owned(Ownership::NpcToNpc)
    }

    /// The worst loops on one side of the ownership split, by ratio.
    pub fn worst_owned(&self, ownership: Ownership, limit: usize) -> Vec<&Violation> {
        let mut all = self
            .violations()
            .filter(|violation| violation.ownership == ownership)
            .collect::<Vec<_>>();
        all.sort_by(|left, right| {
            right
                .ratio()
                .partial_cmp(&left.ratio())
                .unwrap_or(Ordering::Equal)
                .then(left.check.cmp(&right.check))
                .then(left.type_id.cmp(&right.type_id))
        });
        all.truncate(limit);
        all
    }

    /// Worst offenders across all three checks, by ratio.
    pub fn worst(&self, limit: usize) -> Vec<&Violation> {
        let mut all = self.violations().collect::<Vec<_>>();
        all.sort_by(|left, right| {
            right
                .ratio()
                .partial_cmp(&left.ratio())
                .unwrap_or(Ordering::Equal)
                .then(left.check.cmp(&right.check))
                .then(left.type_id.cmp(&right.type_id))
        });
        all.truncate(limit);
        all
    }

    /// `(check, type_id)` for every violation — used to diff two yields.
    pub fn violation_keys(&self) -> BTreeSet<(Check, u32)> {
        self.violations()
            .map(|violation| (violation.check, violation.type_id))
            .collect()
    }
}

// -------------------------------------------------------------------------- the subcommand

/// `audit [--yield F] [--top N] [--allow-violations] [--skip-overlay]`.
///
/// Reconstructs the seeded book exactly as `build` writes it — same [`SeedPlan::resolve`],
/// same [`plan_seed_rows`], same NPC overlay off the same cached snapshot, merged in the same
/// order — so what it audits is what would be written. It reads no database: a build is a
/// pure function of the config, the static data, the price manifest and the cached snapshot,
/// and the audit runs that same function. Returns `Ok(true)` when the gate passes.
pub fn run_audit(
    config_path: &Path,
    refine_yield: f64,
    top: usize,
    allow_violations: bool,
    skip_overlay: bool,
) -> Result<bool> {
    if !(refine_yield.is_finite() && refine_yield > 0.0 && refine_yield <= 1.0) {
        bail!(
            "--yield {refine_yield} is not a refine fraction. It must be greater than 0 and at \
             most 1.0 (1.0 = perfect refine, which is the worst case for the seed and the only \
             yield the build gate is evaluated at)."
        );
    }

    let config = SeederConfig::load(config_path)?;
    let (static_data_dir, static_data_dir_source) =
        resolve_static_data_dir(config.input.static_data_dir.as_deref());

    println!("{} market-seederv3 audit", style("[config]").cyan().bold());
    crate::print_path("config file", config_path);
    println!(
        "  {:<24}: {} (from {})",
        "static data dir",
        crate::display_path(&static_data_dir),
        static_data_dir_source.label()
    );
    crate::print_path("price manifest", &config.price_manifest.path);
    println!(
        "  {:<24}: ask x{} (floor {}), bid x{} (NO floor), pricing {}",
        "index seed",
        config.index_seed.sell_multiplier,
        config.index_seed.price_floor,
        config.index_seed.buy_multiplier,
        config.index_seed.pricing.mode_key()
    );
    println!(
        "  {:<24}: {} (plan §11: which rung a leaf tries first)",
        "leaf price source",
        config.index_seed.leaf_price_source.key()
    );
    println!(
        "  {:<24}: {}",
        "pricing rules",
        config.index_seed.pricing_rules().join(", ")
    );
    println!(
        "  {:<24}: {}, ask x{}, bid x{}",
        "junk seed",
        if config.junk_seed.enabled {
            "enabled"
        } else {
            "disabled"
        },
        config.junk_seed.sell_multiplier,
        config.junk_seed.buy_multiplier
    );
    println!(
        "  {:<24}: {} primary, {} second pass; gate evaluated at {}",
        "refine yield",
        percent(refine_yield),
        percent(REALISTIC_YIELD),
        percent(PERFECT_YIELD)
    );

    println!();
    println!(
        "{} this command reports; it never changes a price. A violation is a decision for a \
         human,",
        style("[scope]").yellow().bold()
    );
    println!("  not something the audit is allowed to paper over (plan §8.3, §11).");

    // ------------------------------------------------------------------ resolve the plan
    println!();
    let static_data = StaticData::load(&static_data_dir)?;
    let reprocessing = ReprocessingStatic::load(&static_data_dir)?;
    let classification = Classification::compute(&static_data, &config.junk_seed)?;

    // The overlay is imported before the plan, exactly as the build does it, because the plan
    // depends on it: `[index_seed] defer_to_npc_catalog` stands the index/junk pass down on
    // the side where TQ's price would cross ours, and an audit that resolved the plan first
    // would price a seed the build would not write.
    let overlay = if skip_overlay {
        println!(
            "{} --skip-overlay: the NPC overlay is NOT in this book. Checks 1-3 price every \
             type as if TQ's ~5,000 stations did not exist, check 4 has one station to \
             compare so it can only ever come back empty, and nothing is deferred to the NPC \
             catalog. Exploratory runs only.",
            style("[warn]").yellow().bold()
        );
        None
    } else {
        match crate::snapshot::find_cached_snapshot(&config.source.download_dir)? {
            Some(cached) => {
                println!(
                    "{} folding the NPC overlay in from {} ({})",
                    style("[overlay]").cyan().bold(),
                    crate::display_path(&cached.path),
                    cached.size_label()
                );
                Some(crate::overlay::import_overlay(
                    &cached.path,
                    &static_data,
                    config.import.order_filter,
                    config.import.npc_order_duration_threshold_days,
                    &BTreeSet::new(),
                    config.price_manifest.reference_solar_system_id,
                    false,
                )?)
            }
            None => bail!(
                "no market-order snapshot is cached in {}, so the audit cannot reconstruct the \
                 NPC overlay half of the book — and an audit that silently sees only the index \
                 station would be false confidence, which is exactly what check 4 exists to \
                 stop.\n\n  Run: market-seederv3 snapshot-info --download --reuse-download\n  \
                 Or pass --skip-overlay to audit the index + junk seed alone.",
                crate::display_path(&config.source.download_dir)
            ),
        }
    };
    let npc_catalog = match overlay.as_ref() {
        Some(import) => NpcCatalog::from_overlay(import),
        None => NpcCatalog::none(),
    };

    let sde = read_sde_build(&static_data_dir);
    let price_manifest = PriceManifest::load(&config.price_manifest.path)?.ok_or_else(|| {
        anyhow::anyhow!(
            "no price manifest at {}. The audit prices the seed exactly as the build does and \
             never invents a price, so there is nothing to audit without it. Run \
             `market-seederv3 refresh-prices` first.",
            config.price_manifest.path.to_string_lossy()
        )
    })?;
    if price_manifest.sde_build != sde.build {
        println!(
            "{} price manifest sdeBuild {} != static data build {}; the audited prices are not \
             the prices this static data would produce.",
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
    // The audit reads prices, it does not recompute them, so the rules that matter are the
    // ones the manifest was *written* with. A config that has moved since is not an error —
    // but it means this run is not measuring what the config says.
    let configured_rules = config.index_seed.pricing_rules();
    if price_manifest.pricing_rules != configured_rules {
        println!(
            "{} the manifest was written with pricingRules [{}] but this config asks for [{}]. \
             Seed prices come from the manifest, so the audit measures the former. Re-run \
             `refresh-prices` to bring them together.",
            style("[warn]").yellow().bold(),
            if price_manifest.pricing_rules.is_empty() {
                "none recorded".to_string()
            } else {
                price_manifest.pricing_rules.join(", ")
            },
            configured_rules.join(", ")
        );
    }

    // The audit prices nothing itself: every seed price comes from the manifest, which the
    // refresh already wrote with rules A/B/C applied. This cost map exists only to name the
    // leaves blocking a dropped type, so it runs with no overrides.
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
    // Same pricing pair the build uses, and the plan needs it for the same reason: under
    // `defer_to_npc_catalog = "conflicting-prices"` the deferral is decided by comparing our
    // computed ask and bid against the catalog's.
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
    println!();
    println!(
        "{} {} seedable types, and what the NPC catalog took off the index seed",
        style("[seed plan]").cyan().bold(),
        count(plan.seedable_count())
    );
    crate::build::print_deferral_report(&plan);

    let rows = plan_seed_rows(
        &plan,
        &static_data,
        pricing,
        config.index_seed.quantity,
        config.junk_seed.quantity,
    );

    let station = static_data
        .station(config.index_seed.station_id)
        .map(SeedStation::from)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "[index_seed] station_id {} is not in the static data, so the audit cannot say \
                 where the index seed's prices live.",
                config.index_seed.station_id
            )
        })?;
    let mut book = SeedBook::from_rows(&rows, &station);

    // The overlay half of the book, merged in the same order the build writes it — so the
    // audited prices are the ones a build would write, without either command reading the
    // other's output.
    if let Some(import) = overlay.as_ref() {
        let index_only = book.len();
        book.merge_overlay(import, &static_data, station.station_id);
        println!(
            "  {:<24}: {} rows ({} asks + {} bids) over {} stations; the book grew from {} \
             types to {}",
            "overlay",
            count(import.total_rows()),
            count(import.sell_rows()),
            count(import.buy_rows()),
            count(import.stations().len()),
            count(index_only),
            count(book.len())
        );
    }

    println!();
    println!(
        "{} {} seeded types priced ({}) across {} stations",
        style("[book]").cyan().bold(),
        count(book.len()),
        book.composition()
            .iter()
            .map(|(label, size)| format!("{label} {}", count(*size)))
            .collect::<Vec<_>>()
            .join(" | "),
        count(book.station_count())
    );
    println!(
        "  {:<24}: the best ask and the best bid ANYWHERE, because a player will always use \
         the better price",
        "every price is"
    );
    println!(
        "  {:<24}: prices at {} are unmarked; anything else is tagged \" @ station\"",
        "in the report", station.station_name
    );
    println!(
        "  {:<24}: {} types, {} compressed/uncompressed pairs",
        "reprocessing table",
        count(reprocessing.len()),
        count(reprocessing.compressed_by_source.len())
    );
    println!(
        "  {:<24}: {} product types",
        "producer index",
        count(classification.producers.len())
    );

    // --------------------------------------------------------------------- run the checks
    let primary = AuditReport::run(
        &book,
        &reprocessing,
        &classification.producers,
        refine_yield,
    );
    let gate = if (refine_yield - PERFECT_YIELD).abs() < f64::EPSILON {
        primary.clone()
    } else {
        AuditReport::run(
            &book,
            &reprocessing,
            &classification.producers,
            PERFECT_YIELD,
        )
    };
    let realistic = if (refine_yield - REALISTIC_YIELD).abs() < f64::EPSILON {
        primary.clone()
    } else {
        AuditReport::run(
            &book,
            &reprocessing,
            &classification.producers,
            REALISTIC_YIELD,
        )
    };

    let gate_on_npc_arbitrage = config.import.gate_on_npc_arbitrage;
    for outcome in primary.checks() {
        print_check(outcome, refine_yield, gate_on_npc_arbitrage);
    }

    print_worst_table(&primary, top);
    print_yield_comparison(&primary, &realistic);

    // ------------------------------------------------------------------------- the verdict
    println!();
    let gating = gate.gating(gate_on_npc_arbitrage);
    let inherited = gate.inherited_npc_hauls();
    let surviving = gate.surviving_tax();
    let passed = gating == 0;
    // Printed on every run, pass or fail: the residue must never be invisible.
    println!(
        "{} {} loops evaluated at {} yield; {} positive, {} surviving the {}% tax — {} \
         seeder-involved, {} npc-to-npc.",
        style("[gate]").cyan().bold(),
        count(
            gate.checks()
                .into_iter()
                .map(|outcome| outcome.checked)
                .sum()
        ),
        percent(PERFECT_YIELD),
        count(gate.violation_count()),
        count(surviving),
        (SEED_BID_TAX * 100.0).round(),
        count(gate.surviving_tax_owned(Ownership::SeederInvolved)),
        count(gate.surviving_tax_owned(Ownership::NpcToNpc))
    );
    println!(
        "  {} of those gate the build; [import] gate_on_npc_arbitrage = {}, so the {} \
         cross-station haul(s) between two NPC stations {}.",
        count(gating),
        gate_on_npc_arbitrage,
        count(inherited),
        if gate_on_npc_arbitrage {
            "gate too"
        } else {
            "are reported without gating"
        }
    );

    if passed {
        println!(
            "{} CLEAN — no loop that survives the {}% transaction tax gates this build. Nothing \
             the seeder prices can be pumped by reprocessing, manufacturing, compression or \
             hauling.",
            style("[verdict]").green().bold(),
            (SEED_BID_TAX * 100.0).round()
        );
        if inherited > 0 {
            println!(
                "  {} inherited TQ-to-TQ haul loop(s) remain in the book and are listed under \
                 check 4 above. They are TQ's own NPC prices at TQ's own stations (plan \
                 decision 2); set [import] gate_on_npc_arbitrage = true to fail the build on \
                 them instead.",
                count(inherited)
            );
            if let Some(worst) = gate
                .worst_owned(Ownership::NpcToNpc, 1)
                .first()
                .filter(|violation| violation.check == Check::CrossStation)
            {
                println!(
                    "  worst inherited: x{:.3} on {} ({}) — {}",
                    worst.ratio(),
                    worst.name,
                    worst.type_id,
                    worst.loop_text
                );
            }
        }
    } else {
        println!(
            "{} EXPLOITABLE — {} positive loops at {} yield, {} still profitable after the {}% \
             transaction tax, {} of which gate this build.",
            style("[verdict]").red().bold(),
            count(gate.violation_count()),
            percent(PERFECT_YIELD),
            count(surviving),
            (SEED_BID_TAX * 100.0).round(),
            count(gating)
        );
        // Name a loop the build is actually failing on, not merely the worst one on paper.
        let mut gating_loops = gate
            .violations()
            .filter(|violation| violation.gates(gate_on_npc_arbitrage))
            .collect::<Vec<_>>();
        gating_loops.sort_by(|left, right| {
            right
                .ratio()
                .partial_cmp(&left.ratio())
                .unwrap_or(Ordering::Equal)
                .then(left.type_id.cmp(&right.type_id))
        });
        if let Some(violation) = gating_loops.first() {
            println!(
                "  worst gating: x{:.3} on {} ({}, {}) — {}",
                violation.ratio(),
                violation.name,
                violation.type_id,
                violation.ownership.key(),
                violation.loop_text
            );
        }
        println!(
            "  the audit reports and never repairs: fix these in the pricing rules (plan §11) \
             and re-run."
        );
    }

    if !passed && allow_violations {
        println!(
            "{} --allow-violations: exiting 0 despite {} gating loops. Never use this on a \
             real seed build.",
            style("[gate]").yellow().bold(),
            count(gating)
        );
    }
    Ok(passed || allow_violations)
}

fn print_check(outcome: &CheckOutcome, refine_yield: f64, gate_on_npc_arbitrage: bool) {
    println!();
    println!(
        "{} {} pump — {}{}",
        style(format!("[check {}]", outcome.check.number()))
            .cyan()
            .bold(),
        outcome.check.key(),
        outcome.check.headline(),
        if outcome.check == Check::Reprocess {
            format!(" (yield {})", percent(refine_yield))
        } else {
            String::new()
        }
    );
    println!("  {:<24}: {}", "checked", count(outcome.checked));
    println!(
        "  {:<24}: {}{}",
        "skipped",
        count(outcome.skipped_total()),
        if outcome.skipped.is_empty() {
            String::new()
        } else {
            format!(
                "  ({})",
                outcome
                    .skipped
                    .iter()
                    .map(|(reason, size)| format!("{reason}: {}", count(*size)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    );
    let violations = outcome.violation_count();
    let surviving = outcome.surviving_tax();
    let line = format!(
        "{}  ({} survive the {}% tax)",
        count(violations),
        count(surviving),
        (SEED_BID_TAX * 100.0).round()
    );
    println!(
        "  {:<24}: {}",
        "violations",
        if violations == 0 {
            style(line).green()
        } else {
            style(line).red().bold()
        }
    );
    // The split is printed for every check, always, so the inherited residue can never become
    // invisible by being reported only when someone asks for it.
    println!(
        "  {:<24}: {} seeder-involved ({} survive the tax) | {} npc-to-npc ({} survive)",
        "  by ownership",
        count(outcome.violation_count_owned(Ownership::SeederInvolved)),
        count(outcome.surviving_tax_owned(Ownership::SeederInvolved)),
        count(outcome.violation_count_owned(Ownership::NpcToNpc)),
        count(outcome.surviving_tax_owned(Ownership::NpcToNpc))
    );
    for note in &outcome.notes {
        println!("  note: {note}");
    }

    for violation in outcome.violations_owned(Ownership::SeederInvolved) {
        print_violation(violation, gate_on_npc_arbitrage);
    }

    let inherited = outcome
        .violations_owned(Ownership::NpcToNpc)
        .collect::<Vec<_>>();
    if inherited.is_empty() {
        return;
    }
    println!();
    println!(
        "  {} {} loop(s) with NO seeder-priced leg — both sides are NPC rows imported verbatim \
         from the TQ snapshot.",
        style("[inherited from TQ]").yellow().bold(),
        count(inherited.len())
    );
    println!(
        "      TQ's own fixed NPC prices; plan decision 2 keeps the catalog TQ-authentic, and \
         no pricing rule of ours"
    );
    println!(
        "      can close these without discarding NPC rows CCP ships. {}",
        if outcome.check == Check::CrossStation {
            if gate_on_npc_arbitrage {
                "GATING ([import] gate_on_npc_arbitrage = true).".to_string()
            } else {
                "Reported, not gating ([import] gate_on_npc_arbitrage = false).".to_string()
            }
        } else {
            "A transformation loop gates whoever owns it.".to_string()
        }
    );
    for violation in inherited {
        print_violation(violation, gate_on_npc_arbitrage);
    }
}

fn print_violation(violation: &Violation, gate_on_npc_arbitrage: bool) {
    println!();
    println!(
        "  x{:<8.3} {:<7} {} [{}] {}",
        violation.ratio(),
        violation.type_id,
        violation.name,
        violation.bucket,
        violation.ownership.key()
    );
    println!("      {}", violation.loop_text);
    println!(
        "      outlay {} -> revenue {} ({} after the {}% tax) -> {}",
        crate::isk(violation.outlay),
        crate::isk(violation.revenue),
        crate::isk(violation.after_tax()),
        (SEED_BID_TAX * 100.0).round(),
        if !violation.survives_tax() {
            style("dies to the tax".to_string()).yellow()
        } else if violation.gates(gate_on_npc_arbitrage) {
            style("SURVIVES THE TAX — GATES THE BUILD".to_string())
                .red()
                .bold()
        } else {
            style("survives the tax, inherited from TQ, not gating".to_string()).yellow()
        }
    );
}

fn print_worst_table(report: &AuditReport, top: usize) {
    println!();
    println!(
        "{} worst {} offenders by ratio, all checks, yield {}",
        style("[top]").cyan().bold(),
        top,
        percent(report.refine_yield)
    );
    let worst = report.worst(top);
    if worst.is_empty() {
        println!("  none — no loop returns more than it costs.");
        return;
    }
    println!(
        "  {:>4}  {:>9}  {:<12}  {:>7}  {:<40}  {:<5}  {:<15}  {:>18}  {:>18}  {}",
        "rank",
        "ratio",
        "check",
        "type",
        "name",
        "bkt",
        "owner",
        "outlay",
        "revenue",
        "after tax?"
    );
    for (rank, violation) in worst.iter().enumerate() {
        println!(
            "  {:>4}  {:>9}  {:<12}  {:>7}  {:<40}  {:<5}  {:<15}  {:>18}  {:>18}  {}",
            rank + 1,
            format!("x{:.3}", violation.ratio()),
            violation.check.key(),
            violation.type_id,
            truncate(&violation.name, 40),
            violation.bucket,
            violation.ownership.key(),
            crate::isk(violation.outlay),
            crate::isk(violation.revenue),
            if violation.survives_tax() {
                "SURVIVES"
            } else {
                "dies"
            }
        );
    }
}

fn print_yield_comparison(primary: &AuditReport, realistic: &AuditReport) {
    println!();
    println!(
        "{} {} (primary) vs {} (realistic station refine)",
        style("[yield]").cyan().bold(),
        percent(primary.refine_yield),
        percent(realistic.refine_yield)
    );
    if (primary.refine_yield - realistic.refine_yield).abs() < f64::EPSILON {
        println!("  same yield — nothing to compare.");
        return;
    }
    for (left, right) in primary.checks().into_iter().zip(realistic.checks()) {
        if left.check == Check::Reprocess {
            println!(
                "  check {} {:<12}: {} -> {} violations, {} -> {} survive the tax",
                left.check.number(),
                left.check.key(),
                count(left.violation_count()),
                count(right.violation_count()),
                count(left.surviving_tax()),
                count(right.surviving_tax())
            );
        } else {
            println!(
                "  check {} {:<12}: {} violations, unchanged — yield does not enter this loop",
                left.check.number(),
                left.check.key(),
                count(left.violation_count())
            );
        }
    }
    let gone = primary
        .violation_keys()
        .difference(&realistic.violation_keys())
        .copied()
        .collect::<Vec<_>>();
    if gone.is_empty() {
        println!("  the same loops violate at both yields.");
        return;
    }
    let named = gone
        .iter()
        .take(12)
        .map(|(_, type_id)| {
            primary
                .violations()
                .find(|violation| violation.type_id == *type_id)
                .map(|violation| format!("{} {}", violation.type_id, violation.name))
                .unwrap_or_else(|| type_id.to_string())
        })
        .collect::<Vec<_>>()
        .join(", ");
    println!(
        "  violating at {} but not at {}: {}{}",
        percent(primary.refine_yield),
        percent(realistic.refine_yield),
        named,
        if gone.len() > 12 {
            format!(", … and {} more", gone.len() - 12)
        } else {
            String::new()
        }
    );
}

// ---------------------------------------------------------------------------- formatting

/// The three biggest contributors of a loop's material list, with the tail summarised.
///
/// `side` says which price each part was taken at, so the station can be named when it is not
/// the index station. Unmarked parts are at the index station; the report header says so once
/// rather than repeating it forty times per line.
fn describe_parts(book: &SeedBook, parts: &[(u32, f64, f64)], side: PriceSide) -> String {
    if parts.is_empty() {
        return "nothing seeded".to_string();
    }
    let mut sorted = parts.to_vec();
    sorted.sort_by(|left, right| {
        right
            .2
            .partial_cmp(&left.2)
            .unwrap_or(Ordering::Equal)
            .then(left.0.cmp(&right.0))
    });
    const NAMED: usize = 3;
    let mut text = sorted
        .iter()
        .take(NAMED)
        .map(|(type_id, quantity, value)| {
            format!(
                "{} x {} ({}){}",
                trim_float(*quantity),
                book.name(*type_id),
                crate::isk(*value),
                book.qualify(*type_id, side)
            )
        })
        .collect::<Vec<_>>()
        .join(" + ");
    if sorted.len() > NAMED {
        let rest: f64 = sorted.iter().skip(NAMED).map(|(_, _, value)| value).sum();
        text.push_str(&format!(
            " + {} more ({})",
            sorted.len() - NAMED,
            crate::isk(rest)
        ));
    }
    text
}

fn producer_run_label(per_run: i64) -> String {
    count(per_run.max(0) as usize)
}

/// `100.0%` / `90.6%`.
fn percent(fraction: f64) -> String {
    format!("{:.1}%", fraction * 100.0)
}

/// Quantities that are usually whole but can be fractional (0.25 x Tritanium per unit).
fn trim_float(value: f64) -> String {
    if value.is_finite() && (value - value.round()).abs() < 1e-9 {
        count(value.round().max(0.0) as usize)
    } else {
        format!("{value:.4}")
    }
}

/// Thousands-grouped integer (the crate-wide helper, kept under the short local name the
/// report lines are written against).
fn count(value: usize) -> String {
    crate::count(value)
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_string();
    }
    let mut shortened = text.chars().take(width.saturating_sub(1)).collect::<String>();
    shortened.push('…');
    shortened
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use super::*;
    use crate::staticdata::{
        BlueprintActivities, BlueprintActivity, BlueprintDefinition, DogmaProjection, ItemTypeRecord,
        MaterialEntry, ProductEntry, ReprocessingMaterial, ReprocessingType,
    };

    const TRITANIUM: u32 = 34;
    const PYERITE: u32 = 35;

    const JITA_4_4: u64 = 60_003_760;
    const RENS: u64 = 60_004_588;
    const AMARR: u64 = 60_008_494;

    /// A price at a station, owned by whoever seeds that station in these fixtures: Jita 4-4
    /// is the index station, so a price there is ours; everywhere else is the NPC overlay.
    /// That is the real shape of the book — the index/junk pass writes one station and the
    /// overlay writes the other ~5,000 — and [`npc_at`] is there for the exception (an overlay
    /// row at Jita 4-4 for a type the index pass does not seed).
    fn at(station_id: u64, price: f64) -> StationPrice {
        priced(
            station_id,
            price,
            if station_id == JITA_4_4 {
                PriceOrigin::Seeder
            } else {
                PriceOrigin::NpcOverlay
            },
        )
    }

    fn npc_at(station_id: u64, price: f64) -> StationPrice {
        priced(station_id, price, PriceOrigin::NpcOverlay)
    }

    fn priced(station_id: u64, price: f64, origin: PriceOrigin) -> StationPrice {
        StationPrice {
            price,
            station_id,
            station_name: match station_id {
                JITA_4_4 => "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
                RENS => "Rens VI - Moon 8 - Brutor Tribe Treasury",
                AMARR => "Amarr VIII (Oris) - Emperor Family Academy",
                _ => "somewhere else",
            }
            .to_string(),
            origin,
        }
    }

    /// Both sides at the index station, at the real 3x/1x pricing minus the floor so the
    /// fixtures stay readable.
    fn side(type_id: u32, name: &str, cost: f64) -> SeedSide {
        SeedSide {
            type_id,
            name: name.to_string(),
            bucket: "B",
            cost,
            ask: BestPrice {
                best: Some(at(JITA_4_4, cost * 3.0)),
                elsewhere: None,
            },
            bid: BestPrice {
                best: Some(at(JITA_4_4, cost)),
                elsewhere: None,
            },
        }
    }

    /// One type priced at named stations: `(station, ask)` and `(station, bid)` candidates,
    /// absorbed exactly as the real book absorbs them.
    fn side_at(
        type_id: u32,
        name: &str,
        asks: &[(u64, f64)],
        bids: &[(u64, f64)],
    ) -> SeedSide {
        let mut ask = BestPrice::default();
        for (station_id, price) in asks {
            ask.absorb_ask(at(*station_id, *price));
        }
        let mut bid = BestPrice::default();
        for (station_id, price) in bids {
            bid.absorb_bid(at(*station_id, *price));
        }
        SeedSide {
            type_id,
            name: name.to_string(),
            bucket: "C",
            cost: 0.0,
            ask,
            bid,
        }
    }

    /// One price at the index station.
    fn one_at(price: f64) -> BestPrice {
        BestPrice {
            best: Some(at(JITA_4_4, price)),
            elsewhere: None,
        }
    }

    fn seed_book(sides: impl IntoIterator<Item = SeedSide>) -> SeedBook {
        let mut book = SeedBook {
            index_station_id: Some(JITA_4_4),
            ..SeedBook::default()
        };
        for side in sides {
            book.insert(side);
        }
        book
    }

    fn refines(
        type_id: u32,
        portion_size: i64,
        materials: &[(u32, i64)],
    ) -> ReprocessingType {
        ReprocessingType {
            type_id,
            name: format!("type {type_id}"),
            portion_size,
            is_refinable: true,
            is_recyclable: true,
            family: "test".to_string(),
            materials: materials
                .iter()
                .map(|(type_id, quantity)| ReprocessingMaterial {
                    type_id: *type_id,
                    quantity: *quantity,
                })
                .collect(),
        }
    }

    fn repro_table(
        types: Vec<ReprocessingType>,
        pairs: &[(u32, u32)],
    ) -> ReprocessingStatic {
        ReprocessingStatic::new(types, pairs.iter().copied().collect())
    }

    /// A [`ProducerIndex`] built the real way, from blueprint rows, so the tests exercise the
    /// same index the audit reads in production.
    fn producers(blueprints: Vec<BlueprintDefinition>) -> ProducerIndex {
        let data = StaticData {
            dir: PathBuf::from("."),
            stations: Vec::new(),
            station_index: HashMap::new(),
            solar_systems: Vec::new(),
            solar_system_index: HashMap::new(),
            item_types: Vec::<ItemTypeRecord>::new(),
            item_type_index: HashMap::new(),
            blueprints,
            dogma: HashMap::<u32, DogmaProjection>::new(),
        };
        ProducerIndex::build(&data)
    }

    fn blueprint(
        blueprint_type_id: u32,
        product_type_id: u32,
        per_run: i64,
        materials: &[(u32, i64)],
    ) -> BlueprintDefinition {
        BlueprintDefinition {
            blueprint_type_id,
            blueprint_name: format!("Blueprint {blueprint_type_id}"),
            product_type_id: 0,
            product_name: String::new(),
            max_production_limit: None,
            published: true,
            activities: BlueprintActivities {
                manufacturing: Some(BlueprintActivity {
                    materials: materials
                        .iter()
                        .map(|(type_id, quantity)| MaterialEntry {
                            type_id: *type_id,
                            quantity: *quantity,
                        })
                        .collect(),
                    products: vec![ProductEntry {
                        type_id: product_type_id,
                        quantity: per_run,
                    }],
                    time: Some(100),
                }),
                ..BlueprintActivities::default()
            },
        }
    }

    #[test]
    fn a_reprocess_pump_is_detected_with_the_right_ratio() {
        // 900 refines into 100 Tritanium per unit: 200 ISK of minerals out of a 30 ISK ask.
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            side(900, "Pumped Ore", 10.0),
        ]);
        let reprocessing = repro_table(vec![refines(900, 100, &[(TRITANIUM, 10_000)])], &[]);

        let outcome = check_reprocess(&book, &reprocessing, PERFECT_YIELD);

        assert_eq!(outcome.checked, 1, "Tritanium has no refine row of its own");
        assert_eq!(
            *outcome.skipped.get(SKIP_NO_REPROCESSING_ROW).unwrap_or(&0),
            1,
            "and it is counted as skipped with the reason, not quietly ignored"
        );
        assert_eq!(outcome.violation_count(), 1);
        let violation = &outcome.violations[0];
        assert_eq!(violation.type_id, 900);
        assert_eq!(violation.check, Check::Reprocess);
        // 10,000 Tritanium / portion 100 = 100 per unit x bid 2.00 = 200.00 against a 30.00 ask.
        assert_eq!(violation.outlay, 30.0);
        assert_eq!(violation.revenue, 200.0);
        assert!((violation.ratio() - 200.0 / 30.0).abs() < 1e-12);
        assert!(violation.loop_text.contains("Tritanium"));
    }

    #[test]
    fn a_safe_item_is_not_flagged_and_an_unseeded_output_pays_nothing() {
        // The cost model's own shape: a type built from 22,400 Tritanium costs 44,800, asks
        // 134,400 and refines back into exactly 44,800 — a third of the ask.
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            side(901, "Honest Hull", 44_800.0),
        ]);
        let reprocessing = repro_table(
            vec![refines(901, 1, &[(TRITANIUM, 22_400), (7777, 5)])],
            &[],
        );

        let outcome = check_reprocess(&book, &reprocessing, PERFECT_YIELD);

        assert_eq!(outcome.violation_count(), 0, "revenue is a third of the ask");
        assert_eq!(outcome.checked, 1);
        assert!(
            outcome.notes.iter().any(|note| note.contains("unseeded")),
            "the unseeded output 7777 must be reported, not silently valued: {:?}",
            outcome.notes
        );
    }

    #[test]
    fn a_manufacture_pump_is_detected_and_a_sane_recipe_is_not() {
        // 902 bids 1,000 but builds out of 100 Tritanium bought at 6.00 = 600. Free money.
        // 903 is the honest shape: bid 600 against the same 600 of inputs is not a profit.
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            side(902, "Overbid Widget", 1_000.0),
            side(903, "Fair Widget", 600.0),
        ]);
        let producers = producers(vec![
            blueprint(9021, 902, 1, &[(TRITANIUM, 100)]),
            blueprint(9031, 903, 1, &[(TRITANIUM, 100)]),
        ]);

        let outcome = check_manufacture(&book, &producers);

        assert_eq!(outcome.checked, 2);
        assert_eq!(*outcome.skipped.get(SKIP_NO_PRODUCER).unwrap_or(&0), 1);
        assert_eq!(outcome.violation_count(), 1);
        let violation = &outcome.violations[0];
        assert_eq!(violation.type_id, 902);
        assert_eq!(violation.outlay, 600.0);
        assert_eq!(violation.revenue, 1_000.0);
        assert!((violation.ratio() - 1_000.0 / 600.0).abs() < 1e-12);
    }

    #[test]
    fn per_run_output_divides_the_input_cost() {
        // 100 units per run out of 100 Tritanium: 6.00 of inputs per unit, not 600.
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            side(904, "Missile", 5.0),
        ]);
        let producers = producers(vec![blueprint(9041, 904, 100, &[(TRITANIUM, 100)])]);

        let outcome = check_manufacture(&book, &producers);

        assert_eq!(outcome.violation_count(), 0, "bid 5.00 < 6.00 of inputs");

        // Nudge the bid past the per-unit input cost and it must flag.
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            side(904, "Missile", 7.0),
        ]);
        let outcome = check_manufacture(&book, &producers);
        assert_eq!(outcome.violation_count(), 1);
        assert_eq!(outcome.violations[0].outlay, 6.0);
    }

    #[test]
    fn an_unbuyable_material_is_skipped_not_flagged() {
        // 905 bids 1,000,000 against inputs that would cost nothing if an absent ask were
        // read as 0 — the exact bug this skip exists to prevent.
        let book = seed_book([side(905, "Needs An Unseeded Part", 1_000_000.0)]);
        let producers = producers(vec![blueprint(9051, 905, 1, &[(7777, 1)])]);

        let outcome = check_manufacture(&book, &producers);

        assert_eq!(outcome.checked, 0);
        assert_eq!(outcome.violation_count(), 0);
        assert_eq!(
            *outcome.skipped.get(SKIP_UNBUYABLE_MATERIAL).unwrap_or(&0),
            1,
            "the recipe must be counted as skipped, with the reason"
        );
        assert_eq!(outcome.skipped_total(), 1);
    }

    #[test]
    fn tax_survival_is_computed_at_the_boundary() {
        // revenue x 0.92 must be strictly greater than the outlay to survive.
        let just_over = Violation {
            check: Check::Reprocess,
            type_id: 1,
            name: "Just Over".to_string(),
            bucket: "B",
            ownership: Ownership::SeederInvolved,
            loop_text: String::new(),
            outlay: 100.0,
            revenue: 108.7,
        };
        let exactly_at = Violation {
            revenue: 100.0 / TAX_KEPT_FRACTION,
            ..just_over.clone()
        };
        let just_under = Violation {
            revenue: 108.6,
            ..just_over.clone()
        };

        assert!(just_over.survives_tax(), "{}", just_over.after_tax());
        assert!(
            !exactly_at.survives_tax(),
            "breaking even is not printing ISK: {}",
            exactly_at.after_tax()
        );
        assert!(!just_under.survives_tax(), "{}", just_under.after_tax());
        // …and all three are still violations before tax.
        for violation in [&just_over, &exactly_at, &just_under] {
            assert!(violation.ratio() > 1.0);
        }

        // The same boundary through a whole check: ask 100, refine into 108.70 of Tritanium.
        let book = seed_book([
            SeedSide {
                type_id: TRITANIUM,
                name: "Tritanium".to_string(),
                bucket: "B",
                cost: 1.0,
                ask: one_at(3.0),
                bid: one_at(1.0),
            },
            SeedSide {
                type_id: 906,
                name: "Boundary Ore".to_string(),
                bucket: "B",
                cost: 100.0,
                ask: one_at(100.0),
                bid: one_at(100.0),
            },
        ]);
        let outcome = check_reprocess(
            &book,
            &repro_table(vec![refines(906, 10, &[(TRITANIUM, 1_087)])], &[]),
            PERFECT_YIELD,
        );
        assert_eq!(outcome.violation_count(), 1);
        assert_eq!(outcome.surviving_tax(), 1);

        let outcome = check_reprocess(
            &book,
            &repro_table(vec![refines(906, 10, &[(TRITANIUM, 1_040)])], &[]),
            PERFECT_YIELD,
        );
        assert_eq!(outcome.violation_count(), 1, "104.00 > the 100.00 ask");
        assert_eq!(
            outcome.surviving_tax(),
            0,
            "but 104.00 x 0.92 = 95.68 does not clear it"
        );
    }

    #[test]
    fn yield_scaling_changes_the_verdict_where_expected() {
        // Refines into 195.00 of Tritanium against a 180.00 ask: a pump at 100% recovery,
        // dead at 90.6% (176.67).
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            SeedSide {
                type_id: 907,
                name: "Marginal Ore".to_string(),
                bucket: "B",
                cost: 60.0,
                ask: one_at(180.0),
                bid: one_at(60.0),
            },
        ]);
        let reprocessing = repro_table(vec![refines(907, 2, &[(TRITANIUM, 195)])], &[]);

        let perfect = check_reprocess(&book, &reprocessing, PERFECT_YIELD);
        assert_eq!(perfect.violation_count(), 1);
        assert_eq!(perfect.violations[0].revenue, 195.0);

        let realistic = check_reprocess(&book, &reprocessing, REALISTIC_YIELD);
        assert_eq!(
            realistic.violation_count(),
            0,
            "195.00 x 0.906 = {} is under the 180.00 ask",
            195.0 * REALISTIC_YIELD
        );

        // …and a loop far enough over the line survives both, so the yield knob is not just
        // switching everything off.
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            SeedSide {
                type_id: 908,
                name: "Blatant Ore".to_string(),
                bucket: "B",
                cost: 10.0,
                ask: one_at(30.0),
                bid: one_at(10.0),
            },
        ]);
        let reprocessing = repro_table(vec![refines(908, 1, &[(TRITANIUM, 100)])], &[]);
        assert_eq!(
            check_reprocess(&book, &reprocessing, PERFECT_YIELD).violation_count(),
            1
        );
        assert_eq!(
            check_reprocess(&book, &reprocessing, REALISTIC_YIELD).violation_count(),
            1
        );
    }

    #[test]
    fn compression_uses_the_blueprint_ratio_when_one_exists() {
        // 100 raw units make 1 compressed unit, and the compressed bid pays more than the
        // 100 raw asks cost.
        let book = seed_book([
            SeedSide {
                type_id: 910,
                name: "Raw Ore".to_string(),
                bucket: "B",
                cost: 1.0,
                ask: one_at(3.0),
                bid: one_at(1.0),
            },
            SeedSide {
                type_id: 911,
                name: "Compressed Ore".to_string(),
                bucket: "B",
                cost: 400.0,
                ask: one_at(1_200.0),
                bid: one_at(400.0),
            },
        ]);
        let producers = producers(vec![blueprint(9111, 911, 1, &[(910, 100)])]);
        let reprocessing = repro_table(Vec::new(), &[(910, 911)]);

        let (ratio, basis) = compression_ratio(910, 911, &reprocessing, &producers)
            .expect("the blueprint fixes the ratio");
        assert_eq!(ratio, 100.0);
        assert_eq!(basis, RatioBasis::Blueprint(9111));

        let outcome = check_compression(&book, &reprocessing, &producers);
        assert_eq!(outcome.checked, 1);
        assert_eq!(outcome.violation_count(), 1);
        let violation = &outcome.violations[0];
        assert_eq!(violation.type_id, 911, "the compressed side is the one sold");
        assert_eq!(violation.outlay, 300.0);
        assert_eq!(violation.revenue, 400.0);
        assert!(violation.loop_text.contains("blueprint 9111"));
    }

    #[test]
    fn compression_falls_back_to_refine_yields_and_checks_the_reverse_direction() {
        // No blueprint: 1 compressed unit refines into 100x what a raw unit does, so it is
        // worth 100 raw units. Here the *raw* bids overpay, so the reverse leg is the pump.
        let book = seed_book([
            SeedSide {
                type_id: 912,
                name: "Raw Ore".to_string(),
                bucket: "B",
                cost: 10.0,
                ask: one_at(30.0),
                bid: one_at(10.0),
            },
            SeedSide {
                type_id: 913,
                name: "Compressed Ore".to_string(),
                bucket: "B",
                cost: 100.0,
                ask: one_at(300.0),
                bid: one_at(100.0),
            },
        ]);
        let reprocessing = repro_table(
            vec![
                refines(912, 100, &[(TRITANIUM, 100), (PYERITE, 50)]),
                refines(913, 1, &[(TRITANIUM, 100), (PYERITE, 50)]),
            ],
            &[(912, 913)],
        );
        let producers = producers(Vec::new());

        let (ratio, basis) = compression_ratio(912, 913, &reprocessing, &producers)
            .expect("both sides refine into the same materials");
        assert_eq!(ratio, 100.0);
        assert_eq!(basis, RatioBasis::RefineYield);

        let outcome = check_compression(&book, &reprocessing, &producers);
        assert_eq!(outcome.checked, 1);
        assert_eq!(outcome.violation_count(), 1);
        let violation = &outcome.violations[0];
        assert_eq!(violation.type_id, 912, "the raw side is the one sold");
        assert_eq!(violation.outlay, 300.0, "one compressed unit at its ask");
        assert_eq!(violation.revenue, 1_000.0, "100 raw units at their bids");
        assert!(violation.loop_text.contains("refine yields"));
    }

    #[test]
    fn a_pair_with_no_usable_basis_is_skipped_not_guessed() {
        let book = seed_book([side(914, "Raw", 10.0), side(915, "Compressed", 10.0)]);
        let producers = producers(Vec::new());

        // Nothing to go on at all.
        let outcome = check_compression(&book, &repro_table(Vec::new(), &[(914, 915)]), &producers);
        assert_eq!(outcome.checked, 0);
        assert_eq!(outcome.violation_count(), 0);
        assert_eq!(*outcome.skipped.get(SKIP_NO_RATIO_BASIS).unwrap_or(&0), 1);

        // Refine rows that share no material: still no ratio.
        let disjoint = repro_table(
            vec![
                refines(914, 1, &[(TRITANIUM, 10)]),
                refines(915, 1, &[(PYERITE, 10)]),
            ],
            &[(914, 915)],
        );
        assert_eq!(
            *check_compression(&book, &disjoint, &producers)
                .skipped
                .get(SKIP_NO_RATIO_BASIS)
                .unwrap_or(&0),
            1
        );

        // Shared materials that imply two different ratios: a guess would be worse.
        let inconsistent = repro_table(
            vec![
                refines(914, 1, &[(TRITANIUM, 10), (PYERITE, 10)]),
                refines(915, 1, &[(TRITANIUM, 100), (PYERITE, 50)]),
            ],
            &[(914, 915)],
        );
        assert_eq!(
            *check_compression(&book, &inconsistent, &producers)
                .skipped
                .get(SKIP_RATIO_DISAGREES)
                .unwrap_or(&0),
            1
        );

        // And an unseeded side is its own skip.
        let half_seeded = seed_book([side(914, "Raw", 10.0)]);
        let outcome = check_compression(
            &half_seeded,
            &repro_table(vec![refines(914, 1, &[(TRITANIUM, 10)])], &[(914, 915)]),
            &producers,
        );
        assert_eq!(*outcome.skipped.get(SKIP_PAIR_UNSEEDED).unwrap_or(&0), 1);
    }

    #[test]
    fn the_report_gates_on_tax_survival_and_ranks_by_ratio() {
        let book = seed_book([
            side(TRITANIUM, "Tritanium", 2.0),
            // x6.67 before tax, x6.13 after — survives.
            side(920, "Blatant", 10.0),
            // x1.04 before tax, x0.96 after — a violation that dies to the tax.
            SeedSide {
                type_id: 921,
                name: "Marginal".to_string(),
                bucket: "B",
                cost: 100.0,
                ask: one_at(100.0),
                bid: one_at(100.0),
            },
        ]);
        let reprocessing = repro_table(
            vec![
                refines(920, 1, &[(TRITANIUM, 100)]),
                refines(921, 1, &[(TRITANIUM, 52)]),
            ],
            &[],
        );
        let report = AuditReport::run(&book, &reprocessing, &producers(Vec::new()), PERFECT_YIELD);

        assert_eq!(report.violation_count(), 2);
        assert_eq!(report.surviving_tax(), 1);
        let worst = report.worst(20);
        assert_eq!(worst.len(), 2);
        assert!(
            worst[0].ratio() > worst[1].ratio(),
            "the top table must be sorted by ratio"
        );
        assert_eq!(worst[0].type_id, 920);
        assert_eq!(report.worst(1).len(), 1);
    }

    /// Check 4's whole reason to exist: nothing is transformed, so checks 1-3 cannot see it.
    #[test]
    fn check_four_finds_a_haul_from_the_cheapest_ask_to_the_dearest_bid() {
        let book = seed_book([
            // We sell it at Jita for 1,000; an NPC in Rens buys it for 4,000.
            side_at(950, "Hauled Commodity", &[(JITA_4_4, 1_000.0)], &[(RENS, 4_000.0)]),
            // Safe: bought dearer than anyone will pay for it.
            side_at(951, "Honest Commodity", &[(JITA_4_4, 1_000.0)], &[(RENS, 900.0)]),
        ]);

        let outcome = check_cross_station(&book);

        assert_eq!(outcome.checked, 2);
        assert_eq!(outcome.violation_count(), 1);
        let violation = &outcome.violations[0];
        assert_eq!(violation.type_id, 950);
        assert_eq!(violation.check, Check::CrossStation);
        assert_eq!(violation.outlay, 1_000.0);
        assert_eq!(violation.revenue, 4_000.0);
        assert_eq!(violation.ratio(), 4.0);
        assert!(violation.survives_tax(), "4,000 x 0.92 = 3,680 > 1,000");
        // Both stations, both prices and the margin are in the text a human reads.
        assert!(violation.loop_text.contains("Jita IV - Moon 4"), "{}", violation.loop_text);
        assert!(violation.loop_text.contains("Rens VI - Moon 8"), "{}", violation.loop_text);
        assert!(violation.loop_text.contains("3,000.00"), "margin: {}", violation.loop_text);

        // A margin the tax eats is still reported, and still marked as dying to it.
        let thin = seed_book([side_at(
            952,
            "Thin Margin",
            &[(JITA_4_4, 1_000.0)],
            &[(RENS, 1_050.0)],
        )]);
        let outcome = check_cross_station(&thin);
        assert_eq!(outcome.violation_count(), 1);
        assert!(
            !outcome.violations[0].survives_tax(),
            "1,050 x 0.92 = 966 < 1,000, so it is a violation that does not gate the build"
        );
        assert_eq!(outcome.surviving_tax(), 0);
    }

    /// The scope line: check 4 is about hauling between two stations. A bid over an ask at
    /// ONE station is the build's own `bid <= ask` invariant and checks 1-3's territory, so it
    /// is counted in a note instead of being reported twice.
    #[test]
    fn check_four_ignores_a_same_station_crossing_but_still_says_it_saw_one() {
        let crossed_at_one_station = seed_book([side_at(
            960,
            "TQ Crossed Trade Good",
            &[(RENS, 100.0)],
            &[(RENS, 900.0)],
        )]);

        let outcome = check_cross_station(&crossed_at_one_station);

        assert_eq!(
            outcome.violation_count(),
            0,
            "one station is not a cross-station haul"
        );
        assert_eq!(
            *outcome.skipped.get(SKIP_SINGLE_STATION).unwrap_or(&0),
            1,
            "and with nowhere else to buy or sell there is nothing for this check to compare"
        );
        assert_eq!(outcome.notes.len(), 1);
        assert!(outcome.notes[0].contains("960"), "{}", outcome.notes[0]);
        assert!(
            outcome.notes[0].contains("ONE station"),
            "{}",
            outcome.notes[0]
        );

        // The same crossing, plus a third station that sells it cheaper still: now there IS a
        // haul, and it must be measured against that third station rather than dismissed.
        let with_a_third_station = seed_book([side_at(
            960,
            "TQ Crossed Trade Good",
            &[(RENS, 100.0), (AMARR, 120.0)],
            &[(RENS, 900.0)],
        )]);
        let outcome = check_cross_station(&with_a_third_station);
        assert_eq!(outcome.violation_count(), 1);
        assert_eq!(
            outcome.violations[0].outlay, 120.0,
            "the best ask is at Rens, where the bid also is, so the haul starts at Amarr"
        );
        assert_eq!(outcome.violations[0].revenue, 900.0);

        // A one-sided type cannot be hauled at all.
        let sell_only = seed_book([side_at(961, "Skillbook", &[(RENS, 100.0)], &[])]);
        let outcome = check_cross_station(&sell_only);
        assert_eq!(outcome.checked, 0);
        assert_eq!(*outcome.skipped.get(SKIP_ONE_SIDED).unwrap_or(&0), 1);
    }

    /// **Fix 2.** A haul loop with one of our prices on it is a bug in the seed; a haul loop
    /// between two NPC stations is TQ's own spread, imported verbatim. Check 4 has to say
    /// which it is looking at, because only the first one is ours to fix.
    #[test]
    fn check_four_says_whether_a_haul_touches_a_price_we_set() {
        let book = seed_book([
            // Ours sells at Jita, an NPC buys higher at Rens — the class-A shape.
            side_at(950, "Our Ask vs NPC Bid", &[(JITA_4_4, 1_000.0)], &[(RENS, 4_000.0)]),
            // An NPC sells at Rens, our Jita bid pays more — the class-B shape.
            side_at(951, "NPC Ask vs Our Bid", &[(RENS, 100.0)], &[(JITA_4_4, 800.0)]),
            // Neither leg is ours: TQ sells it at Amarr and buys it back dearer at Rens.
            side_at(952, "TQ Trade Good", &[(AMARR, 100.0)], &[(RENS, 202.0)]),
        ]);

        let outcome = check_cross_station(&book);

        assert_eq!(outcome.violation_count(), 3);
        let owned = outcome
            .violations
            .iter()
            .map(|violation| (violation.type_id, violation.ownership))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(owned[&950], Ownership::SeederInvolved, "our ask is a leg");
        assert_eq!(owned[&951], Ownership::SeederInvolved, "our bid is a leg");
        assert_eq!(owned[&952], Ownership::NpcToNpc, "neither leg is ours");
        assert_eq!(outcome.violation_count_owned(Ownership::SeederInvolved), 2);
        assert_eq!(outcome.violation_count_owned(Ownership::NpcToNpc), 1);
        assert_eq!(outcome.surviving_tax(), 3);
        assert_eq!(outcome.surviving_tax_owned(Ownership::NpcToNpc), 1);

        // The loop text names the owner of each leg, so the split can be read without
        // cross-referencing a station list.
        let tq = outcome
            .violations
            .iter()
            .find(|violation| violation.type_id == 952)
            .expect("the TQ loop is reported, never hidden");
        assert!(tq.loop_text.contains("npc-overlay"), "{}", tq.loop_text);
        assert!(!tq.loop_text.contains("seeder"), "{}", tq.loop_text);

        // The gate: npc-to-npc hauls are forgiven by default and gate when asked to.
        assert_eq!(
            outcome.gating(false),
            2,
            "the two loops with one of our prices on them fail the build"
        );
        assert_eq!(
            outcome.gating(true),
            3,
            "[import] gate_on_npc_arbitrage = true makes the inherited one fail too"
        );
        assert!(!tq.gates(false));
        assert!(tq.gates(true));
        for type_id in [950, 951] {
            let ours = outcome
                .violations
                .iter()
                .find(|violation| violation.type_id == type_id)
                .expect("ours is reported");
            assert!(ours.gates(false), "{type_id} gates whatever the knob says");
            assert!(ours.gates(true));
        }

        // A loop that dies to the tax gates under neither setting, whoever owns it.
        let thin = seed_book([side_at(
            953,
            "Thin TQ Spread",
            &[(AMARR, 1_000.0)],
            &[(RENS, 1_050.0)],
        )]);
        let outcome = check_cross_station(&thin);
        assert_eq!(outcome.violations[0].ownership, Ownership::NpcToNpc);
        assert_eq!(outcome.gating(true), 0);
    }

    /// The exemption is check 4's alone. A *transformation* loop between two NPC stations
    /// means TQ's prices disagree with the game's own reprocessing mechanics, which is a
    /// different claim from a haul and still fails the build.
    #[test]
    fn the_npc_exemption_does_not_leak_into_the_transformation_checks() {
        // Both legs are NPC rows: TQ sells the ore at Amarr, TQ buys the mineral at Rens.
        let book = seed_book([
            side_at(TRITANIUM, "Tritanium", &[(RENS, 4.0)], &[(RENS, 2.0)]),
            side_at(971, "TQ Ore", &[(AMARR, 30.0)], &[(AMARR, 10.0)]),
        ]);
        let reprocessing = repro_table(vec![refines(971, 1, &[(TRITANIUM, 100)])], &[]);

        let outcome = check_reprocess(&book, &reprocessing, PERFECT_YIELD);

        assert_eq!(outcome.violation_count(), 1);
        assert_eq!(outcome.violations[0].ownership, Ownership::NpcToNpc);
        assert!(outcome.violations[0].survives_tax());
        assert_eq!(
            outcome.gating(false),
            1,
            "an npc-to-npc reprocess pump gates the build; only check 4 is exempt"
        );
        assert_eq!(outcome.gating(true), 1);

        // And the same loop with one of our prices on it is seeder-involved.
        let mut ours = side_at(TRITANIUM, "Tritanium", &[(RENS, 4.0)], &[(RENS, 2.0)]);
        ours.bid.absorb_bid(at(JITA_4_4, 50.0));
        let book = seed_book([ours, side_at(971, "TQ Ore", &[(AMARR, 30.0)], &[(AMARR, 10.0)])]);
        let outcome = check_reprocess(&book, &reprocessing, PERFECT_YIELD);
        assert_eq!(outcome.violations[0].ownership, Ownership::SeederInvolved);
    }

    /// The whole-report gate, which is what the exit code is.
    #[test]
    fn the_report_gate_forgives_only_inherited_hauls_and_still_counts_them() {
        let book = seed_book([
            side_at(952, "TQ Trade Good", &[(AMARR, 100.0)], &[(RENS, 202.0)]),
            side_at(953, "Another TQ Spread", &[(AMARR, 10.0)], &[(RENS, 30.0)]),
        ]);
        let report = AuditReport::run(&book, &repro_table(Vec::new(), &[]), &producers(Vec::new()), PERFECT_YIELD);

        assert_eq!(report.violation_count(), 2);
        assert_eq!(report.surviving_tax(), 2, "both still pay after the tax");
        assert_eq!(report.violation_count_owned(Ownership::SeederInvolved), 0);
        assert_eq!(report.inherited_npc_hauls(), 2);
        assert_eq!(report.gating(false), 0, "nothing of ours is involved, so nothing gates");
        assert_eq!(report.gating(true), 2);
        // The residue is still visible in the numbers a verdict prints.
        assert_eq!(report.surviving_tax_owned(Ownership::NpcToNpc), 2);
        assert_eq!(report.worst_owned(Ownership::NpcToNpc, 1)[0].type_id, 953);

        // One seeder-involved loop and the gate closes whatever the knob says.
        let mut with_ours = book.clone();
        with_ours.insert(side_at(
            954,
            "Our Ask vs NPC Bid",
            &[(JITA_4_4, 1_000.0)],
            &[(RENS, 4_000.0)],
        ));
        let report = AuditReport::run(
            &with_ours,
            &repro_table(Vec::new(), &[]),
            &producers(Vec::new()),
            PERFECT_YIELD,
        );
        assert_eq!(report.gating(false), 1);
        assert_eq!(report.gating(true), 3);
        assert_eq!(report.inherited_npc_hauls(), 2, "the inherited count is unchanged");
    }

    /// Jita 4-4 and Rens, a Venture and a skillbook — the smallest world a merge test needs.
    fn two_station_data() -> StaticData {
        use crate::staticdata::{SolarSystemRecord, StationRecord};

        let station_record = |station_id: u64, name: &str| StationRecord {
            station_id,
            solar_system_id: 30_000_142,
            constellation_id: 20_000_020,
            region_id: 10_000_002,
            region_name: "The Forge".to_string(),
            station_name: name.to_string(),
            security: 0.9,
        };
        let item = |type_id: u32, name: &str| ItemTypeRecord {
            type_id,
            group_id: Some(1),
            category_id: Some(9),
            group_name: Some("Test".to_string()),
            name: name.to_string(),
            mass: None,
            volume: None,
            capacity: None,
            portion_size: Some(1),
            race_id: None,
            base_price: None,
            market_group_id: Some(1),
            icon_id: None,
            sound_id: None,
            graphic_id: None,
            radius: None,
            published: true,
        };
        let stations = vec![
            station_record(JITA_4_4, "Jita IV - Moon 4 - Caldari Navy Assembly Plant"),
            station_record(RENS, "Rens VI - Moon 8 - Brutor Tribe Treasury"),
        ];
        let item_types = vec![item(32_880, "Venture"), item(980, "Skillbook")];
        StaticData {
            dir: PathBuf::from("."),
            station_index: stations
                .iter()
                .enumerate()
                .map(|(index, station)| (station.station_id, index))
                .collect(),
            stations,
            solar_systems: Vec::<SolarSystemRecord>::new(),
            solar_system_index: HashMap::new(),
            item_type_index: item_types
                .iter()
                .enumerate()
                .map(|(index, item)| (item.type_id, index))
                .collect(),
            item_types,
            blueprints: Vec::new(),
            dogma: HashMap::<u32, DogmaProjection>::new(),
        }
    }

    /// The merge has to reproduce the database, not the snapshot: the index pass's
    /// `INSERT OR REPLACE` deleted the overlay's rows at the index station for every type it
    /// seeds, so those prices are not in the book either.
    #[test]
    fn merging_the_overlay_drops_exactly_the_rows_the_index_pass_replaced() {
        let data = two_station_data();

        let mut import = crate::overlay::OverlayImport::default();
        let mut row = |station_id: u64, type_id: u32, is_buy: bool, price_cents: i64| {
            let liquidity = crate::overlay::SeedLiquidity {
                station_id,
                solar_system_id: 30_000_142,
                constellation_id: 20_000_020,
                region_id: 10_000_002,
                type_id,
                price_cents,
                quantity: 5,
            };
            if is_buy {
                import.buy.insert((station_id, type_id), liquidity);
            } else {
                import.sell.insert((station_id, type_id), liquidity);
            }
        };
        // TQ's Venture prices at Jita 4-4 (replaced by us) and at Rens (kept), plus a
        // skillbook only TQ seeds.
        // Prices are integer cents: 10_000 cents = 100.00 ISK.
        row(JITA_4_4, 32_880, false, 10_000);
        row(JITA_4_4, 32_880, true, 9_000);
        row(RENS, 32_880, false, 60_000_000);
        row(RENS, 32_880, true, 45_000_000);
        row(RENS, 980, false, 2_000_000);

        let station = crate::build::test_station();
        let rows = vec![SeedRow {
            type_id: 32_880,
            name: "Venture".to_string(),
            bucket: "A",
            junk: false,
            cost: 252_906.5,
            ask: 758_719.5,
            bid: 252_906.5,
            sides: crate::seedplan::SeedSides::BOTH,
            quantity: 2_147_483_647,
        }];
        let mut book = SeedBook::from_rows(&rows, &station);
        book.merge_overlay(&import, &data, station.station_id);

        let venture = book.get(32_880).expect("the Venture is seeded");
        assert_eq!(
            venture.ask.price(),
            Some(600_000.0),
            "TQ's 100.00 ask at Jita 4-4 no longer exists — the index pass replaced that row — \
             so the cheapest ask anywhere is the 600,000.00 at Rens, not 100.00"
        );
        assert_eq!(venture.ask.station_id(), Some(RENS));
        assert_eq!(
            venture.ask.elsewhere.as_ref().map(|price| price.price),
            Some(758_719.5),
            "and our own Jita ask is the runner-up"
        );
        assert_eq!(
            venture.bid.price(),
            Some(450_000.0),
            "TQ's 90.00 Jita bid is gone too; the best bid is our 252,906.50 or TQ's 450,000.00"
        );
        assert_eq!(venture.bid.station_id(), Some(RENS));

        // The overlay-only type joins the book as bucket C, sell side only.
        let skillbook = book.get(980).expect("the skillbook comes in from the overlay");
        assert_eq!(skillbook.bucket, "C");
        assert_eq!(skillbook.name, "Skillbook");
        assert_eq!(skillbook.ask.price(), Some(20_000.0));
        assert_eq!(skillbook.bid.price(), None, "nothing buys it back");
        assert_eq!(book.station_count(), 2);
        assert_eq!(
            book.composition(),
            vec![("A", 1), ("A+B", 0), ("B", 0), ("C", 1), ("D", 0)]
        );
        // Report qualification: the index station is unmarked, everything else is named.
        assert_eq!(book.qualify(980, PriceSide::Ask), " @ Rens VI - Moon 8 - Brutor Tribe Treasury");
    }

    /// The other half of that rule, once a deferral can take one side: the index pass replaces
    /// only the side it **writes**. A deferred ask leaves TQ's ask at Jita 4-4 in the database,
    /// so it has to be in the book too — otherwise the audit prices a station that does not
    /// exist and check 4 gets a free pass on the leg the deferral deliberately left standing.
    #[test]
    fn a_deferred_side_leaves_tqs_row_at_the_index_station_in_the_book() {
        let data = two_station_data();
        let mut import = crate::overlay::OverlayImport::default();
        let mut row = |station_id: u64, type_id: u32, is_buy: bool, price_cents: i64| {
            let liquidity = crate::overlay::SeedLiquidity {
                station_id,
                solar_system_id: 30_000_142,
                constellation_id: 20_000_020,
                region_id: 10_000_002,
                type_id,
                price_cents,
                quantity: 5,
            };
            if is_buy {
                import.buy.insert((station_id, type_id), liquidity);
            } else {
                import.sell.insert((station_id, type_id), liquidity);
            }
        };
        // TQ holds the Venture on both sides at Jita 4-4: sells at 100.00, buys at 90.00.
        row(JITA_4_4, 32_880, false, 10_000);
        row(JITA_4_4, 32_880, true, 9_000);

        let station = crate::build::test_station();
        let rows = vec![SeedRow {
            type_id: 32_880,
            name: "Venture".to_string(),
            bucket: "A",
            junk: false,
            cost: 252_906.5,
            ask: 758_719.5,
            bid: 252_906.5,
            // The ask was deferred; only the bid is ours.
            sides: crate::seedplan::SeedSides {
                ask: false,
                bid: true,
            },
            quantity: 2_147_483_647,
        }];
        let mut book = SeedBook::from_rows(&rows, &station);
        let venture = book.get(32_880).expect("the Venture is in the book");
        assert_eq!(
            venture.ask.price(),
            None,
            "a deferred side is an ABSENT price, not a zero one"
        );
        assert_eq!(venture.bid.price(), Some(252_906.5));

        book.merge_overlay(&import, &data, station.station_id);
        let venture = book.get(32_880).expect("still there");
        assert_eq!(
            venture.ask.price(),
            Some(100.0),
            "TQ's Jita ask survives, because our ask was never written over it"
        );
        assert_eq!(venture.ask.origin(), Some(PriceOrigin::NpcOverlay));
        assert_eq!(
            venture.bid.price(),
            Some(252_906.5),
            "TQ's 90.00 Jita bid IS replaced — that is the side the index pass wrote"
        );
        assert_eq!(venture.bid.origin(), Some(PriceOrigin::Seeder));

        // …and this is exactly the same-station pair `build::verify_seed_tables` refuses to
        // let a build commit: our 252,906.50 bid against TQ's 100.00 ask would be free ISK
        // with no haul at all. It only cannot happen because the deferral measures TQ's best
        // ask over every station INCLUDING this one, so a surviving bid of ours is under it.
        assert!(
            venture.bid.price() > venture.ask.price(),
            "the fixture deliberately builds the crossing the real rule makes impossible"
        );
    }

    /// The runner-up bookkeeping check 4 leans on, exercised directly.
    #[test]
    fn the_best_price_keeps_a_runner_up_from_a_different_station() {
        let mut asks = BestPrice::default();
        asks.absorb_ask(at(JITA_4_4, 100.0));
        asks.absorb_ask(at(JITA_4_4, 90.0)); // cheaper, same station: no runner-up yet
        assert_eq!(asks.price(), Some(90.0));
        assert!(asks.elsewhere.is_none());

        asks.absorb_ask(at(RENS, 120.0)); // dearer, elsewhere: becomes the runner-up
        assert_eq!(asks.price(), Some(90.0));
        assert_eq!(asks.elsewhere.as_ref().map(|p| p.price), Some(120.0));

        asks.absorb_ask(at(AMARR, 110.0)); // dearer still, but better than the runner-up
        assert_eq!(asks.elsewhere.as_ref().map(|p| p.price), Some(110.0));

        asks.absorb_ask(at(AMARR, 50.0)); // new best from elsewhere: the old best steps down
        assert_eq!(asks.price(), Some(50.0));
        assert_eq!(asks.station_id(), Some(AMARR));
        assert_eq!(asks.elsewhere.as_ref().map(|p| p.price), Some(90.0));

        // Bids mirror it exactly, dearest wins.
        let mut bids = BestPrice::default();
        for (station, price) in [(JITA_4_4, 10.0), (JITA_4_4, 20.0), (RENS, 15.0), (AMARR, 5.0)] {
            bids.absorb_bid(at(station, price));
        }
        assert_eq!(bids.price(), Some(20.0));
        assert_eq!(bids.station_id(), Some(JITA_4_4));
        assert_eq!(bids.elsewhere.as_ref().map(|p| p.price), Some(15.0));
    }

    /// Checks 1-3 price a type at the best seeded price anywhere, not at the Jita row.
    #[test]
    fn the_earlier_checks_use_the_best_price_anywhere_and_name_the_station() {
        // Tritanium: our Jita bid is 2.00, but some NPC in Rens pays 50.00 for it. Refining
        // an ore bought at Jita for 30.00 into 100 Tritanium is only a pump at the Rens bid.
        let mut tritanium = side(TRITANIUM, "Tritanium", 2.0);
        tritanium.bid.absorb_bid(at(RENS, 50.0));
        let book = seed_book([tritanium, side(970, "Ore", 10.0)]);
        let reprocessing = repro_table(vec![refines(970, 100, &[(TRITANIUM, 100)])], &[]);

        let outcome = check_reprocess(&book, &reprocessing, PERFECT_YIELD);

        assert_eq!(outcome.violation_count(), 1);
        let violation = &outcome.violations[0];
        assert_eq!(
            violation.revenue, 50.0,
            "1 Tritanium per unit, valued at the best bid anywhere (50.00), not the 2.00 at Jita"
        );
        assert_eq!(violation.outlay, 30.0);
        assert!(
            violation.loop_text.contains("@ Rens VI - Moon 8"),
            "the report must say where that bid is: {}",
            violation.loop_text
        );
        // The ask side is at the index station, so it is left unmarked.
        assert!(
            violation.loop_text.contains("at Jita IV - Moon 4"),
            "{}",
            violation.loop_text
        );
    }

    #[test]
    fn the_book_never_turns_an_absent_price_into_a_zero() {
        let book = seed_book([side(930, "Seeded", 10.0)]);
        assert_eq!(book.ask(930), Some(30.0));
        assert_eq!(book.bid(930), Some(10.0));
        assert_eq!(book.ask(931), None);
        assert_eq!(book.bid(931), None);
        assert_eq!(book.bid_or_zero(931), 0.0);
        assert_eq!(book.len(), 1);
    }

    #[test]
    fn the_book_is_built_from_the_rows_the_build_would_write() {
        let rows = vec![SeedRow {
            type_id: 940,
            name: "Row Type".to_string(),
            bucket: "A",
            junk: false,
            cost: 12.5,
            ask: 100.0,
            bid: 12.5,
            sides: crate::seedplan::SeedSides::BOTH,
            quantity: 2_147_483_647,
        }];
        let station = crate::build::test_station();
        let book = SeedBook::from_rows(&rows, &station);
        let side = book.get(940).expect("the row is in the book");
        assert_eq!(side.ask.price(), Some(100.0), "the floored ask is carried through as-is");
        assert_eq!(side.bid.price(), Some(12.5));
        assert_eq!(side.bucket, "A");
        // Every index row is at the index station, and nothing is "elsewhere" until the
        // overlay merges in.
        assert_eq!(side.ask.station_id(), Some(station.station_id));
        assert!(side.ask.elsewhere.is_none());
        assert_eq!(book.station_count(), 1);
        assert_eq!(
            book.composition(),
            vec![("A", 1), ("A+B", 0), ("B", 0), ("C", 0), ("D", 0)]
        );
    }
}
