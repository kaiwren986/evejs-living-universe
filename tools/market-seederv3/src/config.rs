//! Configuration for the Public EveJS v3 market seeder.
//!
//! Mirrors the config sketch in `doc/JITA_INDEX_SEED_PLAN.md` §6.1. Every knob has a
//! default, so an empty TOML file yields the decided build (npc_only overlay, Jita 4-4
//! index seed at 3x/1x, int32-ceiling quantities).
//!
//! Validation is deliberately loud rather than forgiving: §6.3 requires that a quantity
//! above the int32 ceiling be **rejected**, not silently clamped, because the EVE client
//! marshals `volRemaining` as an int32 and throws above it.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::classify::resolve_junk_categories;

/// EVE client packed-book ceiling for `volRemaining` (`marshal.js:745-755` throws above
/// this). Seed rows may never carry a quantity larger than this value.
pub const INT32_MAX_QUANTITY: i64 = 2_147_483_647;

/// Jita IV - Moon 4 - Caldari Navy Assembly Plant.
pub const JITA_4_4_STATION_ID: u64 = 60_003_760;

/// The Jita solar system. The snapshot capture (plan §4.2 source 1) reads this system's whole
/// order book, exactly as v2's `reference_solar_system_id` does (`main.rs:1157-1160`).
pub const JITA_SOLAR_SYSTEM_ID: u32 = 30_000_142;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SeederConfig {
    #[serde(default)]
    pub input: InputConfig,
    #[serde(default)]
    pub output: OutputConfig,
    #[serde(default)]
    pub source: SourceConfig,
    #[serde(default)]
    pub import: ImportConfig,
    #[serde(default)]
    pub price_manifest: PriceManifestConfig,
    #[serde(default)]
    pub index_seed: IndexSeedConfig,
    #[serde(default)]
    pub junk_seed: JunkSeedConfig,
    #[serde(default)]
    pub history: HistoryConfig,
    #[serde(default)]
    pub build: BuildConfig,
}

/// Where the configured static-data directory came from, for doctor reporting.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum StaticDataDirSource {
    Config,
    Environment,
    Fallback,
}

impl StaticDataDirSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Config => "config file",
            Self::Environment => "EVEJS_GAMESTORE_DATA_DIR",
            Self::Fallback => "built-in default",
        }
    }
}

/// `[input]`
///
/// `static_data_dir` is optional so the loader can report how the path was resolved:
/// configured value, else `EVEJS_GAMESTORE_DATA_DIR`, else `../../_local/gameStore/data`
/// (identical resolution order to market-seederv2).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct InputConfig {
    #[serde(default)]
    pub static_data_dir: Option<PathBuf>,
}

/// `[output]`
#[derive(Debug, Clone, Deserialize)]
pub struct OutputConfig {
    #[serde(default = "default_database_path")]
    pub database_path: PathBuf,
}

/// `[source]` — ported from market-seederv2.
#[derive(Debug, Clone, Deserialize)]
pub struct SourceConfig {
    #[serde(default = "default_index_url")]
    pub index_url: String,
    #[serde(default = "default_download_dir")]
    pub download_dir: PathBuf,
    #[serde(default = "default_user_agent")]
    pub user_agent: String,
}

/// `[import]` — the NPC overlay pass (plan §6.1 pass 1).
#[derive(Debug, Clone, Deserialize)]
pub struct ImportConfig {
    #[serde(default)]
    pub order_filter: OrderFilter,
    #[serde(default = "default_npc_order_duration_threshold_days")]
    pub npc_order_duration_threshold_days: u32,
    /// Whether audit check 4 fails the build on a haul loop **both** of whose legs are
    /// overlay rows — TQ buying a trade good in one station for more than TQ sells it in
    /// another.
    ///
    /// Default `false`, and the default is a judgement, not laziness. Those loops are not
    /// produced by any pricing rule of ours: they are TQ's own fixed NPC prices, imported
    /// verbatim, and plan decision 2 chose TQ-authentic placement precisely so that the NPC
    /// catalog stays what TQ ships. Real EVE genuinely has NPC trade-good spreads across
    /// stations. Closing them would mean discarding or repricing NPC buyback rows, i.e.
    /// inventing a catalog CCP did not ship — a bigger change than the loop is worth, and
    /// not one the audit may make on its own (it reports, it never repairs).
    ///
    /// The residue is never hidden: both counts are printed in the verdict and every
    /// npc-to-npc loop is listed in its own section whatever this is set to. Turn it on to
    /// make them gate the build too.
    #[serde(default)]
    pub gate_on_npc_arbitrage: bool,
}

/// How much of a type the index/junk pass stands down on when the NPC catalog also seeds it
/// (`[index_seed] defer_to_npc_catalog`).
///
/// The knob started life as a bool, and `true` was blunt: **any** overlay row for a type, on
/// either side, at any station, removed both of our rows. That closed the piece-11 haul loops
/// by removing 340 types from the Jita seed, 289 of which had been seeded before — including
/// every Mutanite, Magmatic Gas, Superionic Ice and Neo-Jadarite, three bucket-A inputs, and
/// 13 recipes that could no longer be bought end to end at one station.
///
/// Most of those were never exploitable. A haul loop needs the two prices to actually **cross**
/// — our ask below TQ's bid, or our bid above TQ's ask — and for the overwhelming majority of
/// overlapping types they do not come close. So the default narrowed to exactly the crossing
/// condition, evaluated per side.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Default)]
pub enum NpcDeferralMode {
    /// **The default.** Drop only the side that would form a profitable loop:
    ///
    /// * our **ask** goes iff `our_ask < best_npc_bid` (buy from us, haul, sell to TQ),
    /// * our **bid** goes iff `our_bid > best_npc_ask` (buy from TQ, haul, sell to us).
    ///
    /// The two are independent, so a type can keep its ask and lose its bid or the reverse,
    /// and a type the overlay merely *touches* keeps both. This is audit check 4's own
    /// condition, so a build under this mode cannot produce a seeder-involved check-4
    /// violation — see [`crate::seedplan::SeedPlan::resolve`].
    #[default]
    ConflictingPrices,
    /// The original bool `true`: an overlay row anywhere, on either side, removes the type
    /// from the index/junk seed entirely, whatever the prices are.
    WholeType,
    /// The original bool `false`: both mechanisms may own one type, which is how the
    /// piece-11 haul loops got in.
    Off,
}

impl NpcDeferralMode {
    pub fn key(self) -> &'static str {
        match self {
            Self::ConflictingPrices => "conflicting-prices",
            Self::WholeType => "whole-type",
            Self::Off => "off",
        }
    }

    /// Every legal spelling, for the error message a bad one gets.
    pub const ALL: [Self; 3] = [Self::ConflictingPrices, Self::WholeType, Self::Off];

    fn parse(value: &str) -> Option<Self> {
        // `_` and `-` are both accepted because every other enum in this config is
        // snake_case; refusing one spelling of a three-value knob helps nobody.
        let normalised = value.trim().to_ascii_lowercase().replace('_', "-");
        Self::ALL
            .into_iter()
            .find(|mode| mode.key() == normalised)
    }
}

/// Accepts the string spellings **and** the original bool, so a config written before the knob
/// grew a third state keeps meaning what it meant: `true` was whole-type deferral and `false`
/// was none.
impl<'de> Deserialize<'de> for NpcDeferralMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ModeVisitor;

        impl serde::de::Visitor<'_> for ModeVisitor {
            type Value = NpcDeferralMode;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(
                    formatter,
                    "one of \"conflicting-prices\", \"whole-type\" or \"off\" (or the old \
                     boolean: true = whole-type, false = off)"
                )
            }

            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(if value {
                    NpcDeferralMode::WholeType
                } else {
                    NpcDeferralMode::Off
                })
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                NpcDeferralMode::parse(value).ok_or_else(|| {
                    E::custom(format!(
                        "[index_seed] defer_to_npc_catalog = \"{value}\" is not a deferral mode. \
                         Use \"conflicting-prices\" (the default: drop only the side whose price \
                         crosses TQ's), \"whole-type\" (drop both sides whenever the NPC catalog \
                         touches the type at all) or \"off\". The old booleans still parse: true \
                         means \"whole-type\", false means \"off\"."
                    ))
                })
            }
        }

        deserializer.deserialize_any(ModeVisitor)
    }
}

/// Which snapshot orders the overlay pass imports. Legal TOML values are the snake_case
/// spellings; anything else is rejected by serde with the full list of variants.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderFilter {
    AllStation,
    NpcOnly,
    PlayerOnly,
    MarketScope,
    MarketScopeWithNpc,
}

impl Default for OrderFilter {
    fn default() -> Self {
        Self::NpcOnly
    }
}

impl OrderFilter {
    pub fn mode_key(self) -> &'static str {
        match self {
            Self::AllStation => "all_station",
            Self::NpcOnly => "npc_only",
            Self::PlayerOnly => "player_only",
            Self::MarketScope => "market_scope",
            Self::MarketScopeWithNpc => "market_scope_with_npc",
        }
    }

    /// True for the two modes that need a set of in-scope solar systems. v3 has no
    /// `[market_scope]` section — v2's `market_solar_system_ids` came from its own selection
    /// pass — so the overlay refuses these modes rather than importing an empty book from an
    /// empty scope.
    pub fn uses_market_scope(self) -> bool {
        matches!(self, Self::MarketScope | Self::MarketScopeWithNpc)
    }

    pub fn summary_label(self) -> &'static str {
        match self {
            Self::AllStation => "all valid station orders",
            Self::NpcOnly => "NPC station orders only",
            Self::PlayerOnly => "player station orders only",
            Self::MarketScope => "market-scope station orders only",
            Self::MarketScopeWithNpc => "market-scope station orders plus NPC station stock",
        }
    }
}

/// `[price_manifest]` — plan §4.
#[derive(Debug, Clone, Deserialize)]
pub struct PriceManifestConfig {
    #[serde(default = "default_price_manifest_path")]
    pub path: PathBuf,
    /// Source 1 of plan §4.2, and the one decision 6 puts **first**: Jita top-of-book
    /// harvested out of the market-order snapshot the build already downloads
    /// ([`crate::overlay::ReferenceBook`]).
    ///
    /// Turning it off leaves ESI as the only capture source, which is what every manifest
    /// written before piece 14 was built from.
    #[serde(default = "default_true")]
    pub capture_missing_from_snapshot: bool,
    #[serde(default = "default_true")]
    pub capture_missing_from_esi: bool,
    #[serde(default = "default_esi_prices_url")]
    pub esi_prices_url: String,
    /// Whose order book the snapshot capture reads — Jita, 30000142, by default, the same
    /// constant v2 calls `reference_solar_system_id` (`main.rs:1157-1160`).
    ///
    /// A **system**, not a station: TQ's own trade hub is the whole Jita system's book, and
    /// pinning it to 4-4 alone would throw away real asks and bids sitting at the other
    /// stations in system for no gain.
    #[serde(default = "default_reference_solar_system_id")]
    pub reference_solar_system_id: u32,
}

/// `[index_seed]` — plan §2.1/§2.2 buckets A and B at Jita 4-4.
#[derive(Debug, Clone, Deserialize)]
pub struct IndexSeedConfig {
    #[serde(default = "default_index_station_id")]
    pub station_id: u64,
    #[serde(default = "default_sell_multiplier")]
    pub sell_multiplier: f64,
    #[serde(default = "default_buy_multiplier")]
    pub buy_multiplier: f64,
    #[serde(default = "default_seed_quantity")]
    pub quantity: i64,
    #[serde(default)]
    pub pricing: PricingModel,
    #[serde(default = "default_price_floor")]
    pub price_floor: f64,
    /// How many A∪B index types may be **dropped** for want of a price before the run is
    /// treated as broken (plan §4.1, as amended).
    ///
    /// An unpriceable type is never seeded and always reported by name — dropping is the
    /// uniform rule across every bucket, and it is not the same thing as inventing a price.
    /// A handful of permanently unpriceable A∪B types exist (event/exclusive items whose
    /// inputs CCP has never priced), so failing forever on those is useless. What this knob
    /// catches is the *systemic* failure: a missing, stale or truncated price manifest would
    /// drop hundreds, and must fail loudly rather than silently seed almost nothing.
    #[serde(default = "default_max_unpriced_drops")]
    pub max_unpriced_drops: i64,
    /// **Two mechanisms must not price one side of one type into a loop.** See
    /// [`NpcDeferralMode`] for the three settings; the default is `"conflicting-prices"`.
    ///
    /// Plan §2.3 says bucket C is "seeded differently": TQ's own orders at TQ's own stations
    /// and prices. Where our computed `3 x cost` ask or `1 x cost` bid lands on a type TQ
    /// already trades at a fixed price, the two price bases meet across stations and the gap
    /// between them can be a haul loop — measured before this knob existed: 7 loops of
    /// ours-sell → TQ-buys (worst x165.7 on the Element Containment Vessel, our 30,180.00
    /// Jita ask against a 5,000,000.00 NPC buyback at K-MGJ7) and 5 of TQ-sells → ours-buys
    /// (worst x8.41 on Plutonium). Neither can be closed by moving a multiplier: the other
    /// side of the trade is a fixed NPC price we do not set.
    ///
    /// Deferring removes the collision at the source — with no seeder-priced row on the
    /// crossing side there is no our-price-against-TQ-price pair to arbitrage — and it costs
    /// only availability at Jita, on that one side, for the types where the prices really do
    /// cross. Deferrals are **reported by name and counted separately**; they are not drops
    /// for want of a price and never count against [`IndexSeedConfig::max_unpriced_drops`].
    ///
    /// With `--skip-overlay`, or in any command that does not import the overlay, there is no
    /// catalog to defer to and nothing is deferred whatever this is set to.
    #[serde(default)]
    pub defer_to_npc_catalog: NpcDeferralMode,
    /// Which price a **leaf** takes when both an SDE `basePrice` and a captured market price
    /// exist for it (plan §11, open question 10). See [`LeafPriceSource`].
    #[serde(default)]
    pub leaf_price_source: LeafPriceSource,
    /// **Rule A.** `average_price` is the only ESI field accepted as a market price.
    ///
    /// `GET /markets/prices/` returns two numbers per type. `average_price` is what the
    /// market actually paid. `adjusted_price` is CCP's internal industry index — the number
    /// the job-cost formula uses — and it is *not* a price anyone traded at; for untraded
    /// moon and exotic ores it is the only one ESI offers, and the piece-7 audit traced the
    /// worst loop in the seed (x1,085) to pricing one side of a pair off it while the other
    /// side came off a real market price.
    ///
    /// With this on, a row carrying only `adjusted_price` is still **recorded** — as
    /// [`crate::manifest::PriceSource::CcpEsiAdjusted`], so it is visible in the committed
    /// manifest and never refetched as if it were missing — but it prices nothing: not a
    /// leaf, not a bucket-D seed row, not an input. A type whose only number is the adjusted
    /// one falls through to `basePrice`, or is dropped and named.
    ///
    /// Turning it off restores the pre-piece-8 ladder (`average_price` preferred,
    /// `adjusted_price` accepted) so the two can be measured against each other. It is a
    /// pure local recompute either way: which ESI field a capture came from is stored, so
    /// flipping this knob never needs the network.
    #[serde(default = "default_true")]
    pub reject_adjusted_price_captures: bool,
    /// **Rule B.** Both sides of every `compressedTypeBySourceTypeID` pair take the same
    /// per-unit price.
    ///
    /// This game compresses **1:1** — `compressInventoryItem` retypes the stack and sets
    /// `outputQuantity: sourceQuantity` (`server/src/services/mining/miningIndustry.js:640`),
    /// and gas decompression is `floor(quantity x efficiency)` with efficiency capped at 1 —
    /// and the two sides refine identically per unit (Veldspar and Compressed Veldspar both
    /// yield 400 Tritanium per 100 units). All 212 pairs are 1:1 on both bases, including
    /// the 12 ice pairs that carry an SDE compression blueprint. Compression exists here to
    /// save hauling volume, and volume is a dimension the seed does not model at all.
    ///
    /// So **any** per-unit price difference between the two sides is arbitrage by
    /// construction, whatever produced it. The rule picks one price for the pair and gives
    /// it to both sides; see `crate::cost::derive_compressed_twins` for the preference
    /// order. It also rescues untraded raw ores whose compressed twin *is* traded.
    #[serde(default = "default_true")]
    pub derive_compressed_from_source: bool,
    /// **Rule C.** A type's **ask** must cover what its reprocessing outputs pay at the
    /// seed's **bids**:
    ///
    /// ```text
    /// refine_revenue(T) = Σ(qty x buy_multiplier(material) x cost(material)) / portionSize
    /// cost(T) := max( cost(T), refine_revenue(T) / sell_multiplier(T) )
    /// ```
    ///
    /// This is the exact mirror of the rule the cost model already prices a manufactured
    /// product with. The seed prices a product at what its inputs cost because you can turn
    /// the inputs into the product; the same logic run backwards says you can always turn a
    /// type into its reprocessing outputs, so buying it must never be cheaper than them.
    /// Where the two disagree — a captured market price for an ore whose ask is below the
    /// captured market value of the minerals inside it — buying the ore and refining it
    /// prints ISK against the seed, which is exactly what the piece-7 audit found 64 times.
    ///
    /// **The multipliers are the whole formulation.** Audit check 1 compares two *seed
    /// prices*: the type's ask (`sell_multiplier x cost`) against what the seed's bids pay for
    /// its refine outputs (`buy_multiplier x cost` each). Both sides therefore have to be put
    /// into price units before they can be compared, and the answer converted back into the
    /// cost units the manifest stores. Flooring `cost` at the raw un-multiplied material value
    /// instead over-prices every lifted type by a factor of `sell_multiplier` and can push a
    /// type above the ceiling audit check 2 imposes (`cost <= sell_multiplier x build_cost`),
    /// manufacturing a violation out of a type that had a perfectly feasible price window.
    ///
    /// Every multiplier is the one that will actually price *that* row — `[index_seed]` for
    /// A∪B, `[junk_seed]` for bucket D — and the two sides are keyed on different types on
    /// purpose: the ask is the candidate's own, while each unit of revenue is paid at the bid
    /// of the material that produced it (a junk module recycles into index-priced minerals).
    /// At the shipped `buy_multiplier = 1.0` every form of this collapses to the same number,
    /// so the buy side only starts to bite if that knob is turned.
    ///
    /// Applied as a fixpoint (`ore → mineral` is one hop, `moon ore → intermediate →
    /// composite` is deeper), capped and reported by
    /// [`crate::cost::compute_reprocessing_floors`].
    #[serde(default = "default_true")]
    pub floor_cost_at_reprocessing_value: bool,
    /// Rule C's safety margin, as a fraction — `0.001` is 0.1%.
    ///
    /// The corrected floor makes the ask land *exactly* on the refine revenue, and audit
    /// check 1 flags `revenue > ask` strictly. Two f64 roundings that disagree in the last
    /// bit — the seeder's `cost x sell_multiplier` against the audit's
    /// `Σ qty x bid / portionSize`, plus the build's round-to-2-decimals — would be enough to
    /// flip that comparison and report a violation worth a fraction of an ISK. The floor is
    /// therefore `refine_revenue / sell_multiplier x (1 + margin)`, which buys headroom far
    /// larger than the noise and far smaller than the 8% transaction tax.
    ///
    /// `0` is legal and means "no margin at all" — the exact-equality formulation, kept
    /// reachable so the floating-point behaviour can be measured rather than assumed.
    #[serde(default = "default_reprocessing_floor_margin")]
    pub reprocessing_floor_margin: f64,
}

impl IndexSeedConfig {
    /// The pricing rules this configuration turns on, as the stable keys recorded in the
    /// manifest header (`pricingRules`) and printed by every subcommand.
    ///
    /// The order is the order the rules run in, which is also the order they depend on each
    /// other: A settles which numbers count as market prices, B settles the compressed pairs
    /// against those numbers, and C floors the result.
    pub fn pricing_rules(&self) -> Vec<String> {
        let mut rules = vec![self.leaf_price_source.key().to_string()];
        if self.reject_adjusted_price_captures {
            rules.push(RULE_REJECT_ADJUSTED.to_string());
        }
        if self.derive_compressed_from_source {
            rules.push(RULE_DERIVE_COMPRESSED.to_string());
        }
        if self.floor_cost_at_reprocessing_value {
            rules.push(RULE_REPROCESSING_FLOOR.to_string());
        }
        rules
    }
}

/// `pricingRules` key for `[index_seed] reject_adjusted_price_captures`.
pub const RULE_REJECT_ADJUSTED: &str = "reject-adjusted-price-captures";
/// `pricingRules` key for `[index_seed] derive_compressed_from_source`.
pub const RULE_DERIVE_COMPRESSED: &str = "derive-compressed-from-source";
/// `pricingRules` key for `[index_seed] floor_cost_at_reprocessing_value`.
pub const RULE_REPROCESSING_FLOOR: &str = "floor-cost-at-reprocessing-value";

/// Which rung the leaf ladder tries first — plan §11, resolved in favour of the capture.
///
/// The cost map's leaf ladder has two priced rungs, `basePrice` and the manifest's captured
/// market price, and this knob decides their order. Nothing else about the cost model moves:
/// the recursive blueprint expansion, the per-run divide, the cycle guard and
/// [`crate::cost::CostMap::server_parity_eiv`] are all unchanged.
///
/// **Why the default is the capture.** The seed sells a leaf at `3 x cost(leaf)` and prices
/// every product built from it at `3 x Σ qty x cost(input)`. Those two are only consistent
/// while the number that sets a leaf's own ask is the same number a product pays for it. With
/// `base-price-first` they are not: a seeded leaf's ask comes off its captured market price
/// (bucket D and every capture-only leaf) while products value it at an SDE constant, and SDE
/// `basePrice` is not even internally consistent for ore — compression is 1:1 in game, but
/// basePrice puts compressed ore at 5-25x the raw rock. The piece-6 audit measured what that
/// seam is worth: 120 positive loops, 117 surviving the 8% tax, worst 37.5x.
///
/// Making a leaf's cost the same number that sets its own ask closes the seam by construction:
/// building a product out of seed-bought inputs then costs exactly what the product's own ask
/// is derived from, so no manufacture loop can profit.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeafPriceSource {
    /// **Default.** A leaf costs its captured market price when the manifest holds one, then
    /// `basePrice`, then it is unpriced.
    CaptureFirst,
    /// The pre-piece-7 ladder, kept so the two can be A/B'd: `basePrice`, then the capture,
    /// then unpriced.
    BasePriceFirst,
}

impl Default for LeafPriceSource {
    fn default() -> Self {
        Self::CaptureFirst
    }
}

impl LeafPriceSource {
    /// The TOML spelling, which is also the manifest/report label.
    pub fn key(self) -> &'static str {
        match self {
            Self::CaptureFirst => "capture-first",
            Self::BasePriceFirst => "base-price-first",
        }
    }

    /// True when a captured price outranks `basePrice` for a leaf.
    pub fn prefers_capture(self) -> bool {
        matches!(self, Self::CaptureFirst)
    }
}

/// Cost basis for index seed prices (plan §3.3).
#[derive(Debug, Copy, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingModel {
    /// Bottom-up cost over the whole dependency graph with manifest leaves.
    Recursive,
    /// One-level EIV, matching the server's job-tax math exactly.
    ShallowEiv,
}

impl Default for PricingModel {
    fn default() -> Self {
        Self::Recursive
    }
}

impl PricingModel {
    pub fn mode_key(self) -> &'static str {
        match self {
            Self::Recursive => "recursive",
            Self::ShallowEiv => "shallow_eiv",
        }
    }
}

/// `[junk_seed]` — plan §2.4 bucket D.
#[derive(Debug, Clone, Deserialize)]
pub struct JunkSeedConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_junk_categories")]
    pub categories: Vec<String>,
    #[serde(default = "default_sell_multiplier")]
    pub sell_multiplier: f64,
    #[serde(default = "default_buy_multiplier")]
    pub buy_multiplier: f64,
    #[serde(default = "default_seed_quantity")]
    pub quantity: i64,
}

/// The largest `[history] days` that is taken as a real setting rather than a typo: ten years.
///
/// The table is `types x days` rows keyed `(type_id, day)`, so the number multiplies straight
/// into the database. At the ~6,700 types a full build seeds, 3,650 days is already ~24
/// million rows, and anything above it is far likelier to be a slipped decimal point than a
/// deliberate decade-and-a-bit of synthetic chart.
pub const MAX_HISTORY_DAYS: i64 = 3_650;

/// `[history]` — synthetic `price_history`, plan piece 12.
///
/// The table exists to stop the client's market charts coming up empty; see
/// [`crate::history`] for what is written and why the base price is the seeded ask. Two knobs
/// only, because there is exactly one decision here: how many days of chart, or none.
#[derive(Debug, Clone, Deserialize)]
pub struct HistoryConfig {
    /// Default **true**. `false` is the same outcome as `days = 0` — an empty table — and is
    /// spelled separately so a build can be turned back on without anyone having to remember
    /// what the day count used to be.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Calendar days ending today UTC, per type. Default 30.
    ///
    /// **0 is legal and writes nothing.** 1 is legal to *configure* but the build refuses it:
    /// the Node proxy splits the daemon's rows into "old" (every row but the last) and "new"
    /// (the last row) in `splitHistoryRows`
    /// (`server/src/services/market/marketProxyService.js:429-447`), so a one-day table gives
    /// the client an empty history half — the same empty chart the piece exists to fix. That
    /// is enforced where the rows are written rather than here, so the config error and the
    /// data error stay one message.
    ///
    /// Stored as `i64` rather than `u32` so a negative value is rejected with an explanation
    /// instead of serde's "invalid value: integer `-1`".
    #[serde(default = "default_history_days")]
    pub days: i64,
}

impl HistoryConfig {
    /// How many days the build will actually write: 0 when disabled, else [`Self::days`].
    /// Safe to narrow because [`SeederConfig::validate`] has already bounded it.
    pub fn effective_days(&self) -> u32 {
        if !self.enabled {
            return 0;
        }
        self.days.clamp(0, MAX_HISTORY_DAYS) as u32
    }

    /// One line for the config echo at the top of every build.
    pub fn label(&self) -> String {
        if !self.enabled {
            return "disabled (price_history is written empty)".to_string();
        }
        match self.days {
            0 => "enabled but days = 0 (price_history is written empty)".to_string(),
            days => format!("{days} days per type, ending today UTC"),
        }
    }
}

/// `[build]` — SQLite write tuning, ported from market-seederv2.
#[derive(Debug, Clone, Deserialize)]
pub struct BuildConfig {
    #[serde(default = "default_sqlite_cache_size_kib")]
    pub sqlite_cache_size_kib: i32,
    #[serde(default = "default_sqlite_page_size_bytes")]
    pub sqlite_page_size_bytes: u32,
    #[serde(default = "default_sqlite_worker_threads")]
    pub sqlite_worker_threads: usize,
    #[serde(default = "default_insert_batch_rows")]
    pub insert_batch_rows: u64,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            database_path: default_database_path(),
        }
    }
}

impl Default for SourceConfig {
    fn default() -> Self {
        Self {
            index_url: default_index_url(),
            download_dir: default_download_dir(),
            user_agent: default_user_agent(),
        }
    }
}

impl Default for ImportConfig {
    fn default() -> Self {
        Self {
            order_filter: OrderFilter::default(),
            npc_order_duration_threshold_days: default_npc_order_duration_threshold_days(),
            gate_on_npc_arbitrage: false,
        }
    }
}

impl Default for PriceManifestConfig {
    fn default() -> Self {
        Self {
            path: default_price_manifest_path(),
            capture_missing_from_snapshot: true,
            capture_missing_from_esi: true,
            esi_prices_url: default_esi_prices_url(),
            reference_solar_system_id: default_reference_solar_system_id(),
        }
    }
}

impl Default for IndexSeedConfig {
    fn default() -> Self {
        Self {
            station_id: default_index_station_id(),
            sell_multiplier: default_sell_multiplier(),
            buy_multiplier: default_buy_multiplier(),
            quantity: default_seed_quantity(),
            pricing: PricingModel::default(),
            price_floor: default_price_floor(),
            max_unpriced_drops: default_max_unpriced_drops(),
            defer_to_npc_catalog: NpcDeferralMode::default(),
            leaf_price_source: LeafPriceSource::default(),
            reject_adjusted_price_captures: true,
            derive_compressed_from_source: true,
            floor_cost_at_reprocessing_value: true,
            reprocessing_floor_margin: default_reprocessing_floor_margin(),
        }
    }
}

impl Default for JunkSeedConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            categories: default_junk_categories(),
            sell_multiplier: default_sell_multiplier(),
            buy_multiplier: default_buy_multiplier(),
            quantity: default_seed_quantity(),
        }
    }
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            days: default_history_days(),
        }
    }
}

impl Default for BuildConfig {
    fn default() -> Self {
        Self {
            sqlite_cache_size_kib: default_sqlite_cache_size_kib(),
            sqlite_page_size_bytes: default_sqlite_page_size_bytes(),
            sqlite_worker_threads: default_sqlite_worker_threads(),
            insert_batch_rows: default_insert_batch_rows(),
        }
    }
}

impl SeederConfig {
    /// Reads and validates a config file. A missing file is an error: v3 ships both an
    /// example and a local config, so a missing path is nearly always a wrong `--config`.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path).with_context(|| {
            format!(
                "failed to read market-seederv3 config at {}",
                path.to_string_lossy()
            )
        })?;
        Self::from_toml_str(&raw).with_context(|| {
            format!(
                "invalid market-seederv3 config at {}",
                path.to_string_lossy()
            )
        })
    }

    /// Parses and validates a config from TOML text.
    pub fn from_toml_str(raw: &str) -> Result<Self> {
        let config = toml::from_str::<Self>(raw)?;
        config.validate()?;
        Ok(config)
    }

    /// Rejects configurations the later build passes cannot honour.
    pub fn validate(&self) -> Result<()> {
        validate_quantity("index_seed", self.index_seed.quantity)?;
        validate_multiplier("index_seed", "sell_multiplier", self.index_seed.sell_multiplier)?;
        validate_multiplier("index_seed", "buy_multiplier", self.index_seed.buy_multiplier)?;
        if !self.index_seed.price_floor.is_finite() || self.index_seed.price_floor < 0.0 {
            bail!(
                "[index_seed] price_floor must be a finite value >= 0 (got {})",
                self.index_seed.price_floor
            );
        }
        if !self.index_seed.reprocessing_floor_margin.is_finite()
            || self.index_seed.reprocessing_floor_margin < 0.0
        {
            bail!(
                "[index_seed] reprocessing_floor_margin must be a finite fraction >= 0 (got {}). \
                 It is rule C's headroom above the exact ask/refine-revenue equality, so 0.001 \
                 is 0.1%; 0 means no margin at all.",
                self.index_seed.reprocessing_floor_margin
            );
        }
        if self.index_seed.max_unpriced_drops < 0 {
            bail!(
                "[index_seed] max_unpriced_drops must be >= 0 (got {}). 0 means no A∪B type \
                 may be dropped for want of a price.",
                self.index_seed.max_unpriced_drops
            );
        }

        // Junk-seed knobs are validated even when disabled: a disabled section with an
        // illegal quantity is a trap waiting for whoever flips `enabled = true`.
        validate_quantity("junk_seed", self.junk_seed.quantity)?;
        validate_multiplier("junk_seed", "sell_multiplier", self.junk_seed.sell_multiplier)?;
        validate_multiplier("junk_seed", "buy_multiplier", self.junk_seed.buy_multiplier)?;
        // Category names map onto SDE category IDs through classify::JUNK_CATEGORY_TABLE.
        // An unknown name is rejected here rather than silently seeding nothing.
        resolve_junk_categories(&self.junk_seed.categories)?;

        // Validated even when disabled, for the same reason the junk knobs are: a disabled
        // section holding an illegal value is a trap for whoever flips `enabled = true`.
        if self.history.days < 0 {
            bail!(
                "[history] days must be >= 0 (got {}). 0 means write no price_history at all, \
                 which is a legal setting — the charts are then empty, as they were before \
                 piece 12.",
                self.history.days
            );
        }
        if self.history.days > MAX_HISTORY_DAYS {
            bail!(
                "[history] days = {} is beyond the {MAX_HISTORY_DAYS}-day ceiling. price_history \
                 is one row per type per day, so at the ~6,700 types a full build seeds this \
                 would write {} rows. A value this large is far likelier to be a slipped \
                 decimal point than a deliberate setting, so it is rejected rather than \
                 clamped.",
                self.history.days,
                self.history.days.saturating_mul(6_700)
            );
        }

        if self.build.insert_batch_rows == 0 {
            bail!("[build] insert_batch_rows must be greater than 0");
        }
        if self.build.sqlite_worker_threads == 0 {
            bail!("[build] sqlite_worker_threads must be greater than 0");
        }
        Ok(())
    }
}

fn validate_quantity(section: &str, quantity: i64) -> Result<()> {
    if quantity > INT32_MAX_QUANTITY {
        bail!(
            "[{section}] quantity {quantity} exceeds the int32 ceiling {INT32_MAX_QUANTITY}. \
             The EVE client marshals volRemaining as int32 and throws above it, so this value \
             is rejected rather than clamped. Set quantity = {INT32_MAX_QUANTITY} or lower."
        );
    }
    if quantity <= 0 {
        bail!("[{section}] quantity must be greater than 0 (got {quantity})");
    }
    Ok(())
}

fn validate_multiplier(section: &str, field: &str, value: f64) -> Result<()> {
    if !value.is_finite() || value <= 0.0 {
        bail!("[{section}] {field} must be a finite value greater than 0 (got {value})");
    }
    Ok(())
}

fn default_true() -> bool {
    true
}

fn default_database_path() -> PathBuf {
    PathBuf::from("../../externalservices/market-server/data/generated/market.sqlite")
}

fn default_index_url() -> String {
    "https://data.everef.net/market-orders/index.json".to_string()
}

fn default_download_dir() -> PathBuf {
    PathBuf::from("cache")
}

fn default_user_agent() -> String {
    "PublicEveJS market-seederv3/0.1".to_string()
}

fn default_npc_order_duration_threshold_days() -> u32 {
    90
}

fn default_price_manifest_path() -> PathBuf {
    PathBuf::from("data/price-manifest.json")
}

fn default_esi_prices_url() -> String {
    "https://esi.evetech.net/latest/markets/prices/".to_string()
}

/// Jita. v2's `reference_solar_system_id` default (`main.rs:1157-1160`).
fn default_reference_solar_system_id() -> u32 {
    JITA_SOLAR_SYSTEM_ID
}

fn default_index_station_id() -> u64 {
    JITA_4_4_STATION_ID
}

fn default_sell_multiplier() -> f64 {
    3.0
}

fn default_buy_multiplier() -> f64 {
    1.0
}

fn default_seed_quantity() -> i64 {
    INT32_MAX_QUANTITY
}

fn default_price_floor() -> f64 {
    100.0
}

/// 0.1%. See [`IndexSeedConfig::reprocessing_floor_margin`]: big enough to swallow every
/// rounding difference between the seeder's ask and the audit's refine revenue, small enough
/// to be invisible next to the 8% transaction tax the gate already requires a loop to beat.
fn default_reprocessing_floor_margin() -> f64 {
    0.001
}

/// Five A∪B types are permanently unpriceable at SDE build 3396210 — untraded event and
/// exclusive items whose own inputs CCP has never priced, plus one whose only ESI number is
/// an `adjusted_price` that rule A refuses to spend. 25 leaves headroom for a few more of
/// those without ever tolerating a manifest-shaped failure, which drops hundreds.
fn default_max_unpriced_drops() -> i64 {
    25
}

fn default_junk_categories() -> Vec<String> {
    vec![
        "modules".to_string(),
        "commodities".to_string(),
        "charges".to_string(),
        "drones".to_string(),
        "decryptors".to_string(),
    ]
}

/// 30 days. Enough for a chart that looks like a month of trading, small enough that the
/// table stays a few hundred thousand rows rather than millions, and comfortably above the
/// 2-day minimum `splitHistoryRows` needs to fill both halves of the client's rowset.
fn default_history_days() -> i64 {
    30
}

fn default_sqlite_cache_size_kib() -> i32 {
    262_144
}

fn default_sqlite_page_size_bytes() -> u32 {
    32 * 1024
}

fn default_sqlite_worker_threads() -> usize {
    24
}

fn default_insert_batch_rows() -> u64 {
    100_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_config_yields_the_decided_defaults() {
        let config = SeederConfig::from_toml_str("").expect("empty config must be valid");

        assert!(config.input.static_data_dir.is_none());
        assert_eq!(
            config.output.database_path,
            PathBuf::from("../../externalservices/market-server/data/generated/market.sqlite")
        );

        assert_eq!(
            config.source.index_url,
            "https://data.everef.net/market-orders/index.json"
        );
        assert_eq!(config.source.download_dir, PathBuf::from("cache"));
        assert_eq!(config.source.user_agent, "PublicEveJS market-seederv3/0.1");

        assert_eq!(config.import.order_filter, OrderFilter::NpcOnly);
        assert_eq!(config.import.npc_order_duration_threshold_days, 90);
        assert!(
            !config.import.gate_on_npc_arbitrage,
            "a haul between two NPC stations is TQ's own price, reported but not gating"
        );

        assert_eq!(
            config.price_manifest.path,
            PathBuf::from("data/price-manifest.json")
        );
        assert!(config.price_manifest.capture_missing_from_snapshot);
        assert!(config.price_manifest.capture_missing_from_esi);
        assert_eq!(
            config.price_manifest.esi_prices_url,
            "https://esi.evetech.net/latest/markets/prices/"
        );
        assert_eq!(
            config.price_manifest.reference_solar_system_id, 30_000_142,
            "the snapshot capture reads Jita's book, v2's reference_solar_system_id"
        );

        assert_eq!(config.index_seed.station_id, 60_003_760);
        assert_eq!(config.index_seed.sell_multiplier, 3.0);
        assert_eq!(config.index_seed.buy_multiplier, 1.0);
        assert_eq!(config.index_seed.quantity, 2_147_483_647);
        assert_eq!(config.index_seed.pricing, PricingModel::Recursive);
        assert_eq!(config.index_seed.price_floor, 100.0);
        assert_eq!(
            config.index_seed.reprocessing_floor_margin, 0.001,
            "rule C's floor carries 0.1% of headroom over the exact ask/revenue equality"
        );
        assert_eq!(config.index_seed.max_unpriced_drops, 25);
        assert_eq!(
            config.index_seed.defer_to_npc_catalog,
            NpcDeferralMode::ConflictingPrices,
            "bucket C owns a side of a type only where its price would cross ours"
        );
        assert_eq!(
            config.index_seed.leaf_price_source,
            LeafPriceSource::CaptureFirst,
            "plan §11 resolved in favour of the captured market price"
        );

        assert!(config.junk_seed.enabled);
        assert_eq!(
            config.junk_seed.categories,
            vec!["modules", "commodities", "charges", "drones", "decryptors"]
        );
        assert_eq!(config.junk_seed.sell_multiplier, 3.0);
        assert_eq!(config.junk_seed.buy_multiplier, 1.0);
        assert_eq!(config.junk_seed.quantity, 2_147_483_647);

        assert!(
            config.history.enabled,
            "piece 12 defaults history ON: an empty price_history is an empty market chart"
        );
        assert_eq!(config.history.days, 30);
        assert_eq!(config.history.effective_days(), 30);

        assert_eq!(config.build.sqlite_cache_size_kib, 262_144);
        assert_eq!(config.build.sqlite_page_size_bytes, 32_768);
        assert_eq!(config.build.sqlite_worker_threads, 24);
        assert_eq!(config.build.insert_batch_rows, 100_000);
    }

    #[test]
    fn shipped_example_config_matches_the_defaults() {
        let raw = include_str!("../config/market-seederv3.example.toml");
        let example = SeederConfig::from_toml_str(raw).expect("example config must be valid");
        let defaults = SeederConfig::default();

        assert_eq!(example.index_seed.station_id, defaults.index_seed.station_id);
        assert_eq!(example.index_seed.quantity, defaults.index_seed.quantity);
        assert_eq!(example.index_seed.pricing, defaults.index_seed.pricing);
        assert_eq!(
            example.index_seed.max_unpriced_drops,
            defaults.index_seed.max_unpriced_drops
        );
        assert_eq!(
            example.index_seed.reprocessing_floor_margin,
            defaults.index_seed.reprocessing_floor_margin
        );
        assert_eq!(
            example.index_seed.defer_to_npc_catalog,
            defaults.index_seed.defer_to_npc_catalog
        );
        assert_eq!(example.import.order_filter, defaults.import.order_filter);
        assert_eq!(
            example.import.gate_on_npc_arbitrage,
            defaults.import.gate_on_npc_arbitrage
        );
        assert_eq!(example.junk_seed.categories, defaults.junk_seed.categories);
        assert_eq!(example.junk_seed.quantity, defaults.junk_seed.quantity);
        assert_eq!(example.history.enabled, defaults.history.enabled);
        assert_eq!(example.history.days, defaults.history.days);
    }

    #[test]
    fn every_shipped_v3_build_config_enables_the_supported_decryptors() {
        let defaults = SeederConfig::default();
        let local =
            SeederConfig::from_toml_str(include_str!("../config/market-seederv3.local.toml"))
                .expect("local v3 config must be valid");
        let docker =
            SeederConfig::from_toml_str(include_str!("../../../docker/market-seed-v3.toml"))
                .expect("Docker v3 config must be valid");

        for (name, config) in [("local", local), ("Docker", docker)] {
            assert_eq!(
                config.junk_seed.categories, defaults.junk_seed.categories,
                "the {name} v3 build must seed every supported Generic Decryptor"
            );
        }
    }

    /// Both knobs are switchable from TOML, which is what makes their effect measurable.
    #[test]
    fn the_npc_catalog_knobs_can_both_be_turned_over_from_the_config_file() {
        let config = SeederConfig::from_toml_str(
            "[index_seed]\ndefer_to_npc_catalog = \"off\"\n\n[import]\ngate_on_npc_arbitrage = true\n",
        )
        .expect("both knobs parse");
        assert_eq!(config.index_seed.defer_to_npc_catalog, NpcDeferralMode::Off);
        assert!(config.import.gate_on_npc_arbitrage);

        let defaults = SeederConfig::from_toml_str("").expect("an empty config is the default");
        assert_eq!(
            defaults.index_seed.defer_to_npc_catalog,
            NpcDeferralMode::ConflictingPrices
        );
        assert!(!defaults.import.gate_on_npc_arbitrage);
    }

    /// All three spellings, and the two booleans the knob used to be. A config written before
    /// the third state existed must keep meaning what it meant, or an old TOML would silently
    /// change the economy the moment it stopped parsing as a bool.
    #[test]
    fn every_deferral_spelling_parses_including_the_two_the_knob_used_to_be() {
        for (raw, expected) in [
            ("\"conflicting-prices\"", NpcDeferralMode::ConflictingPrices),
            ("\"conflicting_prices\"", NpcDeferralMode::ConflictingPrices),
            ("\"whole-type\"", NpcDeferralMode::WholeType),
            ("\"whole_type\"", NpcDeferralMode::WholeType),
            ("\"off\"", NpcDeferralMode::Off),
            ("\"OFF\"", NpcDeferralMode::Off),
            ("true", NpcDeferralMode::WholeType),
            ("false", NpcDeferralMode::Off),
        ] {
            let config = SeederConfig::from_toml_str(&format!(
                "[index_seed]\ndefer_to_npc_catalog = {raw}\n"
            ))
            .unwrap_or_else(|error| panic!("{raw} must parse: {error:#}"));
            assert_eq!(
                config.index_seed.defer_to_npc_catalog, expected,
                "defer_to_npc_catalog = {raw}"
            );
        }

        // …and a typo names every legal value rather than failing with "invalid type".
        let error =
            SeederConfig::from_toml_str("[index_seed]\ndefer_to_npc_catalog = \"conflicting\"\n")
                .expect_err("an unknown mode must be rejected");
        let message = format!("{error:#}");
        for expected in ["conflicting-prices", "whole-type", "off", "true", "false"] {
            assert!(
                message.contains(expected),
                "the error must name {expected}: {message}"
            );
        }
    }

    #[test]
    fn index_quantity_above_the_int32_ceiling_is_rejected() {
        let error = SeederConfig::from_toml_str("[index_seed]\nquantity = 2147483648\n")
            .expect_err("quantity above the int32 ceiling must be rejected");
        let message = format!("{error:#}");
        assert!(message.contains("2147483648"), "message: {message}");
        assert!(message.contains("int32 ceiling"), "message: {message}");
        assert!(message.contains("index_seed"), "message: {message}");
    }

    #[test]
    fn junk_quantity_above_the_int32_ceiling_is_rejected() {
        let error = SeederConfig::from_toml_str("[junk_seed]\nquantity = 9999999999\n")
            .expect_err("quantity above the int32 ceiling must be rejected");
        assert!(format!("{error:#}").contains("junk_seed"));
    }

    #[test]
    fn the_int32_ceiling_itself_is_accepted_and_not_clamped() {
        let config = SeederConfig::from_toml_str(
            "[index_seed]\nquantity = 2147483647\n\n[junk_seed]\nquantity = 2147483647\n",
        )
        .expect("the ceiling itself is legal");
        assert_eq!(config.index_seed.quantity, INT32_MAX_QUANTITY);
        assert_eq!(config.junk_seed.quantity, INT32_MAX_QUANTITY);
    }

    #[test]
    fn zero_and_negative_quantities_are_rejected() {
        assert!(SeederConfig::from_toml_str("[index_seed]\nquantity = 0\n").is_err());
        assert!(SeederConfig::from_toml_str("[index_seed]\nquantity = -1\n").is_err());
        assert!(SeederConfig::from_toml_str("[junk_seed]\nquantity = 0\n").is_err());
    }

    #[test]
    fn non_positive_multipliers_are_rejected() {
        assert!(SeederConfig::from_toml_str("[index_seed]\nsell_multiplier = 0.0\n").is_err());
        assert!(SeederConfig::from_toml_str("[index_seed]\nbuy_multiplier = -1.0\n").is_err());
        assert!(SeederConfig::from_toml_str("[junk_seed]\nsell_multiplier = -0.5\n").is_err());
    }

    #[test]
    fn both_leaf_price_sources_parse_and_an_unknown_one_is_rejected() {
        let capture = SeederConfig::from_toml_str(
            "[index_seed]\nleaf_price_source = \"capture-first\"\n",
        )
        .expect("capture-first is legal");
        assert_eq!(
            capture.index_seed.leaf_price_source,
            LeafPriceSource::CaptureFirst
        );
        assert!(capture.index_seed.leaf_price_source.prefers_capture());

        let base = SeederConfig::from_toml_str(
            "[index_seed]\nleaf_price_source = \"base-price-first\"\n",
        )
        .expect("base-price-first is legal");
        assert_eq!(
            base.index_seed.leaf_price_source,
            LeafPriceSource::BasePriceFirst
        );
        assert!(!base.index_seed.leaf_price_source.prefers_capture());
        assert_eq!(base.index_seed.leaf_price_source.key(), "base-price-first");

        // A typo must fail loudly rather than fall back to a default that silently reprices
        // every leaf in the seed.
        let error = SeederConfig::from_toml_str("[index_seed]\nleaf_price_source = \"market\"\n")
            .expect_err("an unknown ladder must be rejected");
        let message = format!("{error:#}");
        assert!(message.contains("leaf_price_source"), "message: {message}");
    }

    #[test]
    fn negative_price_floor_is_rejected() {
        assert!(SeederConfig::from_toml_str("[index_seed]\nprice_floor = -1.0\n").is_err());
    }

    /// Rule C's margin is a fraction, not a price: negative or non-finite is rejected, 0 is
    /// the legal "no headroom" setting, and anything positive is taken as given.
    #[test]
    fn reprocessing_floor_margin_must_be_a_finite_non_negative_fraction() {
        let error = SeederConfig::from_toml_str("[index_seed]\nreprocessing_floor_margin = -0.01\n")
            .expect_err("a negative margin would lower the floor below the ask it protects");
        let message = format!("{error:#}");
        assert!(
            message.contains("reprocessing_floor_margin"),
            "message: {message}"
        );
        assert!(message.contains(">= 0"), "message: {message}");

        assert!(
            SeederConfig::from_toml_str("[index_seed]\nreprocessing_floor_margin = nan\n").is_err(),
            "a NaN margin would make every floor NaN and silently unfloor the whole seed"
        );
        assert!(SeederConfig::from_toml_str("[index_seed]\nreprocessing_floor_margin = inf\n").is_err());

        let exact = SeederConfig::from_toml_str("[index_seed]\nreprocessing_floor_margin = 0.0\n")
            .expect("zero margin is the exact-equality formulation and is legal");
        assert_eq!(exact.index_seed.reprocessing_floor_margin, 0.0);

        let wide = SeederConfig::from_toml_str("[index_seed]\nreprocessing_floor_margin = 0.05\n")
            .expect("a wider margin is legal");
        assert_eq!(wide.index_seed.reprocessing_floor_margin, 0.05);
    }

    #[test]
    fn negative_max_unpriced_drops_is_rejected_and_zero_is_legal() {
        let error = SeederConfig::from_toml_str("[index_seed]\nmax_unpriced_drops = -1\n")
            .expect_err("a negative drop budget must be rejected");
        let message = format!("{error:#}");
        assert!(message.contains("max_unpriced_drops"), "message: {message}");
        assert!(message.contains(">= 0"), "message: {message}");

        // 0 is the "no A∪B type may ever be dropped" setting — strict, but legal.
        let strict = SeederConfig::from_toml_str("[index_seed]\nmax_unpriced_drops = 0\n")
            .expect("zero is a legal budget");
        assert_eq!(strict.index_seed.max_unpriced_drops, 0);
    }

    #[test]
    fn unknown_pricing_model_is_rejected() {
        let error = SeederConfig::from_toml_str("[index_seed]\npricing = \"magic\"\n")
            .expect_err("unknown pricing model must be rejected");
        let message = format!("{error:#}");
        assert!(message.contains("recursive"), "message: {message}");
        assert!(message.contains("shallow_eiv"), "message: {message}");
    }

    #[test]
    fn both_legal_pricing_models_parse() {
        let recursive = SeederConfig::from_toml_str("[index_seed]\npricing = \"recursive\"\n")
            .expect("recursive is legal");
        assert_eq!(recursive.index_seed.pricing, PricingModel::Recursive);
        let shallow = SeederConfig::from_toml_str("[index_seed]\npricing = \"shallow_eiv\"\n")
            .expect("shallow_eiv is legal");
        assert_eq!(shallow.index_seed.pricing, PricingModel::ShallowEiv);
    }

    #[test]
    fn unknown_order_filter_is_rejected() {
        let error = SeederConfig::from_toml_str("[import]\norder_filter = \"everything\"\n")
            .expect_err("unknown order filter must be rejected");
        let message = format!("{error:#}");
        assert!(message.contains("npc_only"), "message: {message}");
        assert!(message.contains("market_scope_with_npc"), "message: {message}");
    }

    #[test]
    fn every_legal_order_filter_parses() {
        for mode in [
            "all_station",
            "npc_only",
            "player_only",
            "market_scope",
            "market_scope_with_npc",
        ] {
            let config =
                SeederConfig::from_toml_str(&format!("[import]\norder_filter = \"{mode}\"\n"))
                    .unwrap_or_else(|error| panic!("{mode} must be legal: {error:#}"));
            assert_eq!(config.import.order_filter.mode_key(), mode);
        }
    }

    /// `[history] days` is a row multiplier, so both ends of it are guarded — and 0 is the
    /// legal "no charts" setting, not an error.
    #[test]
    fn history_days_is_bounded_at_both_ends_and_zero_is_legal() {
        let error = SeederConfig::from_toml_str("[history]\ndays = -1\n")
            .expect_err("a negative day count must be rejected");
        let message = format!("{error:#}");
        assert!(message.contains("[history] days"), "message: {message}");
        assert!(message.contains(">= 0"), "message: {message}");

        let error = SeederConfig::from_toml_str("[history]\ndays = 100000\n")
            .expect_err("an absurd day count must be rejected, not clamped");
        let message = format!("{error:#}");
        assert!(message.contains("3650"), "message: {message}");

        let ceiling = SeederConfig::from_toml_str("[history]\ndays = 3650\n")
            .expect("the ceiling itself is legal");
        assert_eq!(ceiling.history.effective_days(), 3_650);

        let none = SeederConfig::from_toml_str("[history]\ndays = 0\n")
            .expect("0 days is the legal 'write no history' setting");
        assert_eq!(none.history.effective_days(), 0);
        assert!(none.history.label().contains("empty"));
    }

    /// `enabled = false` and `days = 0` are the same outcome by two spellings, and the day
    /// count survives being switched off so turning it back on does not need it retyped.
    #[test]
    fn disabling_history_is_the_same_as_zero_days_but_keeps_the_day_count() {
        let off = SeederConfig::from_toml_str("[history]\nenabled = false\n")
            .expect("disabling history is legal");
        assert_eq!(off.history.effective_days(), 0);
        assert_eq!(off.history.days, 30, "the configured day count is remembered");
        assert!(off.history.label().contains("disabled"));

        let on = SeederConfig::from_toml_str("[history]\nenabled = true\ndays = 7\n")
            .expect("legal");
        assert_eq!(on.history.effective_days(), 7);
        assert!(on.history.label().contains("7 days"));
    }

    #[test]
    fn zero_build_batch_sizes_are_rejected() {
        assert!(SeederConfig::from_toml_str("[build]\ninsert_batch_rows = 0\n").is_err());
        assert!(SeederConfig::from_toml_str("[build]\nsqlite_worker_threads = 0\n").is_err());
    }

    /// All three piece-8 rules default **on**, and each one can be turned off by itself so
    /// its contribution to the pump audit is measurable.
    #[test]
    fn the_three_pricing_rules_default_on_and_are_independently_switchable() {
        let defaults = SeederConfig::from_toml_str("").expect("an empty config is legal");
        assert!(defaults.index_seed.reject_adjusted_price_captures);
        assert!(defaults.index_seed.derive_compressed_from_source);
        assert!(defaults.index_seed.floor_cost_at_reprocessing_value);
        assert_eq!(
            defaults.index_seed.pricing_rules(),
            vec![
                "capture-first",
                RULE_REJECT_ADJUSTED,
                RULE_DERIVE_COMPRESSED,
                RULE_REPROCESSING_FLOOR
            ],
            "the recorded order is the apply order"
        );

        for (toml, rule) in [
            (
                "[index_seed]\nreject_adjusted_price_captures = false\n",
                RULE_REJECT_ADJUSTED,
            ),
            (
                "[index_seed]\nderive_compressed_from_source = false\n",
                RULE_DERIVE_COMPRESSED,
            ),
            (
                "[index_seed]\nfloor_cost_at_reprocessing_value = false\n",
                RULE_REPROCESSING_FLOOR,
            ),
        ] {
            let config = SeederConfig::from_toml_str(toml).expect("legal");
            let rules = config.index_seed.pricing_rules();
            assert!(!rules.iter().any(|entry| entry == rule), "{rule} still on");
            assert_eq!(rules.len(), 3, "only that one rule came off: {rules:?}");
        }

        let none = SeederConfig::from_toml_str(
            "[index_seed]\nreject_adjusted_price_captures = false\n\
             derive_compressed_from_source = false\nfloor_cost_at_reprocessing_value = false\n",
        )
        .expect("legal");
        assert_eq!(
            none.index_seed.pricing_rules(),
            vec!["capture-first"],
            "with all three off only the leaf ladder is recorded — the piece-7 baseline"
        );
    }

    #[test]
    fn the_shipped_example_config_matches_the_built_in_defaults_for_the_pricing_rules() {
        let example = SeederConfig::from_toml_str(
            &std::fs::read_to_string("config/market-seederv3.example.toml")
                .expect("the example config ships with the crate"),
        )
        .expect("the example config is valid");
        let defaults = SeederConfig::default();
        assert_eq!(
            example.index_seed.pricing_rules(),
            defaults.index_seed.pricing_rules()
        );
    }
}
