//! The committed price manifest and its CCP capture — `doc/JITA_INDEX_SEED_PLAN.md` §4.
//!
//! One versioned artifact (`data/price-manifest.json`, decision 7: **committed**) holding
//! the resolved price and provenance for every seeded type, plus the captured leaf prices
//! the local cost model needs to reach them.
//!
//! ```json
//! {
//!   "formatVersion": 1,
//!   "sdeBuild": 3396210,
//!   "costModel": "recursive-v1",
//!   "generatedAt": "…",
//!   "sources": { "esi": "markets/prices @ …" },
//!   "prices": { "34": { "price": 2.0, "source": "base-price" } }
//! }
//! ```
//!
//! Four rules this module exists to enforce:
//!
//! 1. **Local entries are derived, captures are permanent.** `cost-recursive` and
//!    `base-price` entries are recomputed from the SDE on every refresh, so a static-data
//!    or cost-model change flows through. A `ccp-*` entry is **never** overwritten except
//!    by an explicit `--force-refetch` (§4.3): the economy must not drift with TQ, and
//!    rebuilds must be deterministic and offline.
//! 2. **Bucket D is capture-only** (§2.4/§3.3). `cost(type) := manifest.fetchedPrice(type)`
//!    and nothing else — a D type with no capture stays **unseeded**, which is the designed
//!    outcome, not an error. It must never fall back to `basePrice`; that fallback is what
//!    [`PriceManifest::seed_price`] and [`crate::classify::Classification::junk_seedability`]
//!    exist to make impossible.
//! 3. **Unpriced means unseeded, never guessed.** The same rule as bucket D, applied to
//!    every bucket: an A∪B type with no manifest entry is [`SeedPrice::Blocked`], and
//!    [`crate::seedplan::SeedPlan`] drops it and names it rather than inventing a price.
//!    A handful of A∪B types are permanently unpriceable, so the refresh reports exactly
//!    what is blocked and which leaves are to blame, and `[index_seed] max_unpriced_drops`
//!    is what still fails the run when the drop count says the manifest itself is broken.
//! 4. **The file is a reviewable diff.** Type-id keys are numerically sorted (34 before 200
//!    before 1000, not lexicographic), the JSON is pretty-printed, and a refresh that
//!    changes nothing rewrites nothing — not even `generatedAt`.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::classify::BucketFlags;
use crate::config::PricingModel;
use crate::cost::{CapturedLeafPrices, CostOutcome, CostReport, CostSource};

/// Bumped only when the on-disk shape changes incompatibly.
pub const MANIFEST_FORMAT_VERSION: u32 = 1;

/// How long one unauthenticated ESI request may take. The payload is a few MB of JSON.
pub const ESI_REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// Significant digits every manifest price is normalised to.
///
/// This is a correctness knob, not cosmetics. serde_json's float parser is not exactly
/// inverse to its writer for long significands: a computed cost of `227075028.41125003` is
/// written verbatim and read back as `227075028.41125005`, one ULP away. Left alone, every
/// refresh would see the reloaded manifest differ from the recomputed one and rewrite an
/// otherwise unchanged committed file forever. Twelve significant digits always survives
/// the round trip (the significand stays inside serde_json's exact fast path) and is finer
/// than 0.01 ISK even at the most expensive seeded type (~9.55e9 ISK) — far finer than the
/// whole-ISK rounding the seed writer applies. It also makes the diff readable.
pub const MANIFEST_PRICE_SIGNIFICANT_DIGITS: usize = 12;

/// `sources` key for the ESI capture.
pub const SOURCE_KEY_ESI: &str = "esi";
/// `sources` key for the snapshot capture (written by the snapshot harvest, piece 4b).
pub const SOURCE_KEY_SNAPSHOT: &str = "snapshot";

/// Where one price came from. These strings are the whole vocabulary of the manifest's
/// `source` field (§4.1); anything else in a loaded file is a hard error.
///
/// Three axes, and they are not the same question:
///
/// * [`PriceSource::is_capture`] — "did this number come off CCP's servers?" Captures are
///   permanent and are never refetched without `--force-refetch` (§4.3).
/// * [`PriceSource::is_market_price`] — "did anyone actually pay this?" **`CcpEsiAdjusted`
///   is a capture and is not a market price**: `adjusted_price` is CCP's internal industry
///   index, not a trade. Rule A ([`crate::config::IndexSeedConfig::reject_adjusted_price_captures`])
///   turns on that distinction; the record exists either way so flipping the rule needs no
///   network.
/// * [`PriceSource::is_derived`] — the piece-8 pricing rules B and C, which take real prices
///   and produce a different, arbitrage-free one. Local: recomputed every refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PriceSource {
    /// Expanded bottom-up from the type's own T1 blueprint (§3.3). Recomputed every refresh.
    CostRecursive,
    /// SDE `basePrice` leaf. Recomputed every refresh.
    BasePrice,
    /// Rule B: this type's compressed/uncompressed twin priced the pair, because compression
    /// is 1:1 and any difference between the two sides is arbitrage. Recomputed every
    /// refresh.
    DerivedCompressedTwin,
    /// Rule C: lifted to what the type reprocesses into, because it cannot be worth less
    /// than its own outputs. Recomputed every refresh.
    ReprocessingFloor,
    /// CCP `GET /markets/prices/`, **`average_price`** — a real market price. Permanent once
    /// written.
    CcpEsiAverage,
    /// CCP `GET /markets/prices/`, **`adjusted_price` only** — the type carries no
    /// `average_price` at all. Recorded so the number is visible and never refetched as
    /// though it were missing, but it is CCP's internal industry index rather than something
    /// anyone paid, so under rule A it prices nothing. Permanent once written.
    CcpEsiAdjusted,
    /// Jita 4-4 top-of-book harvested from the TQ order snapshot (§4.2 source 1). Defined
    /// here so the vocabulary is complete; **written by the snapshot harvest, piece 4b**,
    /// never by this module. Permanent once written.
    CcpSnapshotJitaSplit,
}

impl PriceSource {
    /// Every legal source, in manifest-report order.
    pub const ALL: &'static [PriceSource] = &[
        PriceSource::CostRecursive,
        PriceSource::BasePrice,
        PriceSource::DerivedCompressedTwin,
        PriceSource::ReprocessingFloor,
        PriceSource::CcpEsiAverage,
        PriceSource::CcpEsiAdjusted,
        PriceSource::CcpSnapshotJitaSplit,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::CostRecursive => "cost-recursive",
            Self::BasePrice => "base-price",
            Self::DerivedCompressedTwin => "derived-compressed-twin",
            Self::ReprocessingFloor => "reprocessing-floor",
            Self::CcpEsiAverage => "ccp-esi-average",
            Self::CcpEsiAdjusted => "ccp-esi-adjusted",
            Self::CcpSnapshotJitaSplit => "ccp-snapshot-jita-split",
        }
    }

    /// True for the `ccp-*` sources: captured from CCP once, never refetched without
    /// `--force-refetch`. Says nothing about whether the number is a *price* — see
    /// [`PriceSource::is_market_price`].
    pub fn is_capture(self) -> bool {
        matches!(
            self,
            Self::CcpEsiAverage | Self::CcpEsiAdjusted | Self::CcpSnapshotJitaSplit
        )
    }

    /// True only for captures that are a price somebody paid. `adjusted_price` is not one.
    pub fn is_market_price(self) -> bool {
        matches!(self, Self::CcpEsiAverage | Self::CcpSnapshotJitaSplit)
    }

    /// True for rules B and C: a price derived from other prices by an arbitrage-closing
    /// rule rather than read off a blueprint, the SDE or the market.
    pub fn is_derived(self) -> bool {
        matches!(self, Self::DerivedCompressedTwin | Self::ReprocessingFloor)
    }

    /// True for the sources the refresh recomputes from static data every run.
    pub fn is_local(self) -> bool {
        !self.is_capture()
    }
}

/// Whether `adjusted_price`-only captures may price anything — rule A, as one value passed
/// to every consumer of the manifest so the question is answered in exactly one way per run.
///
/// `accept_adjusted = false` (the default, `reject_adjusted_price_captures = true`) makes
/// [`PriceSource::CcpEsiAdjusted`] a record and nothing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapturePolicy {
    pub accept_adjusted: bool,
}

impl CapturePolicy {
    /// The policy `[index_seed] reject_adjusted_price_captures` asks for.
    pub fn from_config(config: &crate::config::SeederConfig) -> Self {
        Self {
            accept_adjusted: !config.index_seed.reject_adjusted_price_captures,
        }
    }

    /// The pre-piece-8 behaviour: `adjusted_price` is as good as `average_price`.
    pub fn accept_adjusted() -> Self {
        Self {
            accept_adjusted: true,
        }
    }

    /// Rule A: only `average_price` counts.
    pub fn reject_adjusted() -> Self {
        Self {
            accept_adjusted: false,
        }
    }

    /// Whether a capture in this source may set a price.
    pub fn prices(self, source: PriceSource) -> bool {
        source.is_market_price() || (self.accept_adjusted && source == PriceSource::CcpEsiAdjusted)
    }
}

impl Default for CapturePolicy {
    fn default() -> Self {
        Self::reject_adjusted()
    }
}

/// The local cost ladder's answer for one type, ready to be written to the manifest.
/// [`CostSource::Captured`] has no local spelling on purpose — a type resolved from a
/// capture already owns a `ccp-*` entry and must keep it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalPrice {
    pub price: f64,
    pub source: PriceSource,
}

impl LocalPrice {
    pub fn from_cost(unit_cost: f64, source: CostSource) -> Option<Self> {
        if !unit_cost.is_finite() || unit_cost <= 0.0 {
            return None;
        }
        let source = match source {
            CostSource::CostRecursive => PriceSource::CostRecursive,
            CostSource::BasePrice => PriceSource::BasePrice,
            CostSource::DerivedTwin => PriceSource::DerivedCompressedTwin,
            CostSource::ReprocessingFloor => PriceSource::ReprocessingFloor,
            // Resolved through an existing capture: the capture entry is the manifest
            // entry, so there is nothing local to write.
            CostSource::Captured => return None,
        };
        Some(Self {
            price: unit_cost,
            source,
        })
    }
}

/// A `ccp-*` capture that is **not** the entry's own price, kept beside it.
///
/// Captures are permanent (rule 1) but there is only one price per type, and under
/// `[index_seed] leaf_price_source = "base-price-first"` the ladder deliberately prices some
/// leaves off the SDE even though a real market price for them has been captured. Discarding
/// the capture to make room would mean refetching it — over the network, at a different
/// TQ price — the moment the knob moved back, which is exactly what §4.3 forbids. So the
/// capture rides along, and flipping the knob is a pure local recompute with no network.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedCapture {
    #[serde(deserialize_with = "deserialize_normalized_price")]
    pub price: f64,
    pub source: PriceSource,
    pub captured_at: String,
}

impl RetainedCapture {
    pub fn new(price: f64, source: PriceSource, captured_at: &str) -> Self {
        debug_assert!(source.is_capture(), "{} is not a capture", source.key());
        Self {
            price: normalize_price(price),
            source,
            captured_at: captured_at.to_string(),
        }
    }
}

/// One `prices` entry.
///
/// `price` and `source` are always the **seed price and the rung that produced it** — never a
/// price the configured ladder did not choose. A capture the ladder passed over lives in
/// [`PriceEntry::retained_capture`].
///
/// The price is normalised on the way in *and* on the way out, so `load` then `save` is a
/// fixpoint no matter who wrote the file — a hand edit, or piece 4b's snapshot harvest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriceEntry {
    #[serde(deserialize_with = "deserialize_normalized_price")]
    pub price: f64,
    pub source: PriceSource,
    /// Set only on `ccp-*` entries; it is the timestamp the price was captured, not the
    /// timestamp the manifest was written.
    #[serde(
        rename = "capturedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub captured_at: Option<String>,
    /// A capture held for this type that the configured leaf ladder did not pick. Absent on
    /// `ccp-*` entries (their own price *is* the capture) and on any type never captured.
    #[serde(
        rename = "retainedCapture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub retained_capture: Option<RetainedCapture>,
}

impl PriceEntry {
    pub fn local(local: LocalPrice) -> Self {
        Self {
            price: normalize_price(local.price),
            source: local.source,
            captured_at: None,
            retained_capture: None,
        }
    }

    pub fn capture(price: f64, source: PriceSource, captured_at: &str) -> Self {
        debug_assert!(source.is_capture(), "{} is not a capture", source.key());
        Self {
            price: normalize_price(price),
            source,
            captured_at: Some(captured_at.to_string()),
            retained_capture: None,
        }
    }

    /// The entry a held capture becomes when the ladder does choose it.
    pub fn from_retained(capture: &RetainedCapture) -> Self {
        Self::capture(capture.price, capture.source, &capture.captured_at)
    }

    /// This local entry, carrying a capture the ladder passed over.
    pub fn retaining(mut self, capture: RetainedCapture) -> Self {
        debug_assert!(
            !self.is_capture(),
            "a capture entry already is its own capture"
        );
        self.retained_capture = Some(capture);
        self
    }

    /// True when this entry's **own** price is a capture.
    pub fn is_capture(&self) -> bool {
        self.source.is_capture()
    }

    /// The capture held for this type whether or not the ladder chose it — the entry itself
    /// when it is a `ccp-*` entry, otherwise the retained one. This, not
    /// [`PriceEntry::is_capture`], is what "has this type been captured?" means.
    pub fn capture_record(&self) -> Option<RetainedCapture> {
        if self.is_capture() {
            return Some(RetainedCapture {
                price: self.price,
                source: self.source,
                captured_at: self
                    .captured_at
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string()),
            });
        }
        self.retained_capture.clone()
    }

    /// The capture held for this type **that the policy accepts as a price**. This, not
    /// [`PriceEntry::capture_record`], is what "does a real market price exist for this
    /// type?" means, and it is the question bucket D is gated on (§2.4).
    pub fn market_capture_record(&self, policy: CapturePolicy) -> Option<RetainedCapture> {
        self.capture_record()
            .filter(|capture| policy.prices(capture.source))
    }
}

/// The manifest itself. `prices` is keyed by `u32`, so serde_json emits the type-id keys in
/// **numeric** order (34, 200, 1000) rather than the lexicographic order a string-keyed map
/// would give (1000, 200, 34) — the difference between a reviewable diff and a shuffled one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceManifest {
    pub format_version: u32,
    /// The CCP static-data build the local entries were computed from
    /// (`_local/gameStore/manifest.json`). `null` when it could not be read.
    pub sde_build: Option<u64>,
    pub cost_model: String,
    /// The pricing rules that produced these entries, in apply order — see
    /// [`crate::config::IndexSeedConfig::pricing_rules`]. `costModel` says which cost
    /// *formula* ran; this says which arbitrage-closing rules ran on top of it, so a manifest
    /// built with a rule off is visible in the diff rather than silently different.
    /// Defaulted, so a pre-piece-8 manifest still loads (as "no rules recorded").
    #[serde(default)]
    pub pricing_rules: Vec<String>,
    pub generated_at: String,
    #[serde(default)]
    pub sources: BTreeMap<String, String>,
    #[serde(default)]
    pub prices: BTreeMap<u32, PriceEntry>,
}

impl PriceManifest {
    /// An empty manifest with the current header — what a first refresh starts from.
    pub fn empty(sde_build: Option<u64>, cost_model: &str, generated_at: &str) -> Self {
        Self {
            format_version: MANIFEST_FORMAT_VERSION,
            sde_build,
            cost_model: cost_model.to_string(),
            pricing_rules: Vec::new(),
            generated_at: generated_at.to_string(),
            sources: BTreeMap::new(),
            prices: BTreeMap::new(),
        }
    }

    /// Loads the manifest, or `None` when the file does not exist yet (the first-run case,
    /// which is normal and not an error).
    pub fn load(path: &Path) -> Result<Option<Self>> {
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to read {}", path.to_string_lossy()));
            }
        };
        let manifest = Self::from_json_str(&raw)
            .with_context(|| format!("failed to parse {}", path.to_string_lossy()))?;
        if manifest.format_version != MANIFEST_FORMAT_VERSION {
            bail!(
                "{} has formatVersion {} but this build understands {}",
                path.to_string_lossy(),
                manifest.format_version,
                MANIFEST_FORMAT_VERSION
            );
        }
        Ok(Some(manifest))
    }

    pub fn from_json_str(raw: &str) -> Result<Self> {
        serde_json::from_str::<Self>(raw).map_err(Into::into)
    }

    /// Pretty JSON with a trailing newline — one key per line so git diffs are per-type.
    pub fn to_json_string(&self) -> Result<String> {
        let mut json = serde_json::to_string_pretty(self)?;
        json.push('\n');
        Ok(json)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create {} for the price manifest", parent.to_string_lossy())
            })?;
        }
        let json = self.to_json_string()?;
        fs::write(path, json)
            .with_context(|| format!("failed to write {}", path.to_string_lossy()))
    }

    pub fn entry(&self, type_id: u32) -> Option<&PriceEntry> {
        self.prices.get(&type_id)
    }

    /// The capture held for a type, chosen by the ladder or merely retained beside a local
    /// price. A purely local entry with no capture history never answers here — that is what
    /// makes bucket D capture-only.
    pub fn capture(&self, type_id: u32) -> Option<RetainedCapture> {
        self.prices.get(&type_id)?.capture_record()
    }

    pub fn has_capture(&self, type_id: u32) -> bool {
        self.capture(type_id).is_some()
    }

    /// The capture held for a type **that the policy accepts as a price** (rule A). Bucket D
    /// seedability and the cost map's capture rung both go through this, never through
    /// [`PriceManifest::capture`].
    pub fn market_capture(&self, type_id: u32, policy: CapturePolicy) -> Option<RetainedCapture> {
        self.prices.get(&type_id)?.market_capture_record(policy)
    }

    pub fn has_market_capture(&self, type_id: u32, policy: CapturePolicy) -> bool {
        self.market_capture(type_id, policy).is_some()
    }

    /// Types a capture is held for, however the ladder priced them.
    pub fn capture_count(&self) -> usize {
        self.prices
            .values()
            .filter(|entry| entry.capture_record().is_some())
            .count()
    }

    /// Types holding a capture the policy will not price anything from — the
    /// `adjusted_price`-only records rule A keeps but refuses to spend.
    pub fn non_market_capture_count(&self, policy: CapturePolicy) -> usize {
        self.prices
            .values()
            .filter(|entry| {
                entry.capture_record().is_some() && entry.market_capture_record(policy).is_none()
            })
            .count()
    }

    /// Entries whose own price is a capture — the subset of [`PriceManifest::capture_count`]
    /// the ladder actually picked.
    pub fn capture_priced_count(&self) -> usize {
        self.prices.values().filter(|entry| entry.is_capture()).count()
    }

    /// Every captured **market** price, as the leaf rung the cost map consults (§3.3).
    ///
    /// Retained captures are included: they are still real captured prices, and under
    /// `capture-first` they are what the leaf ladder reaches for first. Records the policy
    /// refuses (rule A: `adjusted_price`-only) are excluded — that is the whole point of the
    /// rule, and excluding them here is what stops one from pricing a leaf, a product built
    /// from that leaf, or a bucket-D seed row.
    pub fn captured_leaf_prices(&self, policy: CapturePolicy) -> CapturedLeafPrices {
        let mut captures = CapturedLeafPrices::default();
        for (type_id, entry) in &self.prices {
            if let Some(capture) = entry.market_capture_record(policy) {
                captures.insert(*type_id, capture.price);
            }
        }
        captures
    }

    /// `source` → count, over every legal source (zeroes included, so the histogram shape is
    /// stable between runs).
    pub fn source_histogram(&self) -> Vec<(PriceSource, usize)> {
        PriceSource::ALL
            .iter()
            .map(|source| {
                (
                    *source,
                    self.prices
                        .values()
                        .filter(|entry| entry.source == *source)
                        .count(),
                )
            })
            .collect()
    }

    /// The price the seeder may use for one classified type, enforcing the §2.4 bucket-D
    /// rule in the one place every consumer goes through.
    pub fn seed_price(&self, type_id: u32, flags: BucketFlags, policy: CapturePolicy) -> SeedPrice {
        let index_type = flags.manufacturable_t1 || flags.material;
        if !index_type && flags.junk_candidate {
            // Bucket D: a captured **market** price or nothing. §2.4 seeds junk "iff the
            // price manifest holds a captured real-market price for it", so a `base-price`
            // or `cost-recursive` entry is deliberately ignored rather than used, and under
            // rule A an `adjusted_price`-only record is not a market price either.
            let Some(entry) = self.entry(type_id) else {
                return SeedPrice::UnseedableJunk;
            };
            let Some(capture) = entry.market_capture_record(policy) else {
                return SeedPrice::UnseedableJunk;
            };
            // The gate is the capture; the *price* is whatever the pricing rules made of it.
            // Rules B and C rewrite a junk type's entry (a module is worth at least the
            // minerals it recycles into), and the rewritten price is the one that must be
            // seeded — otherwise the rule would fix the index rows and leave the junk rows
            // pumping.
            return match entry.source {
                source if source.is_market_price() || source.is_derived() => SeedPrice::Priced {
                    price: entry.price,
                    source,
                },
                _ => SeedPrice::Priced {
                    price: capture.price,
                    source: capture.source,
                },
            };
        }
        match self.entry(type_id) {
            // An entry whose own price is a capture the policy refuses is not a price at
            // all. Without this an index type whose only number is CCP's industry index
            // would be seeded off it, which is precisely what rule A exists to stop — and
            // unlike bucket D it would not even be visible as a junk drop.
            Some(entry) if entry.source.is_capture() && !policy.prices(entry.source) => {
                SeedPrice::Blocked
            }
            Some(entry) => SeedPrice::Priced {
                price: entry.price,
                source: entry.source,
            },
            None => SeedPrice::Blocked,
        }
    }
}

/// The outcome of [`PriceManifest::seed_price`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SeedPrice {
    Priced { price: f64, source: PriceSource },
    /// Bucket D with no capture: not seeded, by design (§2.4). Never an error.
    UnseedableJunk,
    /// An A∪B type with no manifest entry. Not seeded either — dropped and reported by
    /// [`crate::seedplan::SeedPlan`], which fails the run only once the number of such
    /// drops exceeds `[index_seed] max_unpriced_drops`.
    Blocked,
}

impl SeedPrice {
    pub fn price(self) -> Option<f64> {
        match self {
            Self::Priced { price, .. } => Some(price),
            _ => None,
        }
    }
}

/// Rounds a price to [`MANIFEST_PRICE_SIGNIFICANT_DIGITS`] via its decimal spelling, so the
/// stored value is exactly the f64 nearest a short decimal and therefore survives a JSON
/// round trip. Formatting through a string rather than `(v * f).round() / f` matters: the
/// arithmetic form can land one ULP off the nearest f64 and reintroduce a 17-digit
/// significand.
pub fn normalize_price(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let text = format!("{:.*e}", MANIFEST_PRICE_SIGNIFICANT_DIGITS - 1, value);
    text.parse::<f64>().unwrap_or(value)
}

fn deserialize_normalized_price<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(normalize_price(f64::deserialize(deserializer)?))
}

/// `costModel` header value for a pricing mode. Pinned in the manifest so a model change is
/// visible in the diff.
pub fn cost_model_key(model: PricingModel) -> &'static str {
    match model {
        PricingModel::Recursive => "recursive-v1",
        PricingModel::ShallowEiv => "shallow-eiv-v1",
    }
}

/// UTC, whole seconds, RFC 3339 — e.g. `2026-08-10T09:14:02Z`.
pub fn now_timestamp() -> String {
    let now = OffsetDateTime::now_utc();
    now.replace_nanosecond(0)
        .unwrap_or(now)
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

/// What `_local/gameStore/manifest.json` says the static data was built from.
#[derive(Debug, Clone)]
pub struct SdeBuildInfo {
    pub build: Option<u64>,
    pub path: PathBuf,
    /// Set when the build could not be read; the caller warns and records `null`.
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GameStoreManifest {
    #[serde(default)]
    build: Option<u64>,
    #[serde(rename = "sdeMeta", default)]
    sde_meta: Option<GameStoreSdeMeta>,
}

#[derive(Debug, Deserialize)]
struct GameStoreSdeMeta {
    #[serde(rename = "buildNumber", default)]
    build_number: Option<u64>,
}

/// Reads the CCP static-data build number that produced the loaded tables. The generator
/// writes it to `manifest.json` beside the `data/` directory it fills.
pub fn read_sde_build(static_data_dir: &Path) -> SdeBuildInfo {
    let path = static_data_dir
        .parent()
        .unwrap_or(static_data_dir)
        .join("manifest.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) => {
            return SdeBuildInfo {
                build: None,
                warning: Some(format!("cannot read {}: {error}", path.to_string_lossy())),
                path,
            };
        }
    };
    match serde_json::from_str::<GameStoreManifest>(&raw) {
        Ok(manifest) => {
            let build = manifest
                .build
                .or_else(|| manifest.sde_meta.and_then(|meta| meta.build_number));
            let warning = build
                .is_none()
                .then(|| format!("{} carries no build number", path.to_string_lossy()));
            SdeBuildInfo {
                build,
                path,
                warning,
            }
        }
        Err(error) => SdeBuildInfo {
            build: None,
            warning: Some(format!("cannot parse {}: {error}", path.to_string_lossy())),
            path,
        },
    }
}

// ---------------------------------------------------------------------------- ESI capture

/// One row of `GET /markets/prices/`. Both prices are optional in the real payload.
#[derive(Debug, Clone, Deserialize)]
pub struct EsiPriceRow {
    #[serde(default)]
    pub adjusted_price: Option<f64>,
    #[serde(default)]
    pub average_price: Option<f64>,
    pub type_id: i64,
}

impl EsiPriceRow {
    /// The row's usable number **and which ESI field it came from**, `average_price` first.
    ///
    /// A zero, negative or non-finite value is not a price: seeding one would hand out free
    /// items. Which field answered is carried out of here rather than collapsed, because
    /// that is exactly the distinction rule A is built on — an `adjusted_price`-only row is
    /// recorded but must never price anything.
    pub fn captured_price(&self) -> Option<CapturedPrice> {
        if let Some(price) = usable(self.average_price) {
            return Some(CapturedPrice {
                price,
                source: PriceSource::CcpEsiAverage,
            });
        }
        usable(self.adjusted_price).map(|price| CapturedPrice {
            price,
            source: PriceSource::CcpEsiAdjusted,
        })
    }

    /// True when ESI holds an `average_price` for this type — the only field rule A treats
    /// as a price.
    pub fn has_market_price(&self) -> bool {
        usable(self.average_price).is_some()
    }
}

fn usable(value: Option<f64>) -> Option<f64> {
    value.filter(|price| price.is_finite() && *price > 0.0)
}

/// One captured number and the field it came from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CapturedPrice {
    pub price: f64,
    pub source: PriceSource,
}

pub fn parse_esi_price_rows(raw: &str) -> Result<Vec<EsiPriceRow>> {
    serde_json::from_str::<Vec<EsiPriceRow>>(raw)
        .context("ESI markets/prices payload is not a JSON array of {type_id, average_price, adjusted_price}")
}

/// What one capture attempt yielded.
#[derive(Debug, Clone, Default)]
pub struct CaptureBatch {
    /// False when no capture ran at all (nothing to fetch, or capture disabled). Distinct
    /// from "ran and found nothing", which must not be able to erase held captures.
    pub attempted: bool,
    pub captured_at: String,
    /// type id → captured price **and the field it came from**, already restricted to the
    /// requested set. Per entry, not per batch: one ESI payload yields both `average_price`
    /// captures and `adjusted_price`-only records, and rule A has to tell them apart.
    pub prices: BTreeMap<u32, CapturedPrice>,
    /// `sources` entries to record in the manifest header, e.g.
    /// `[("esi", "markets/prices @ …")]`. A list rather than one pair because §4.2 has two
    /// capture sources and [`combine_captures`] runs both in one merge — the header has to
    /// name whichever of them actually contributed.
    pub provenance: Vec<(String, String)>,
    /// Rows in the payload, before filtering.
    pub rows_total: usize,
    /// Rows carrying a usable number in either field.
    pub rows_usable: usize,
    /// Rows carrying a usable `average_price` — the subset rule A will spend.
    pub rows_market: usize,
    /// Requested types the payload answered with an `adjusted_price` and no `average_price`.
    pub adjusted_only: BTreeSet<u32>,
}

impl CaptureBatch {
    pub fn price(&self, type_id: u32) -> Option<CapturedPrice> {
        self.prices.get(&type_id).copied()
    }

    /// The batch's answer for a type **only if the policy would let it price something**.
    pub fn market_price(&self, type_id: u32, policy: CapturePolicy) -> Option<CapturedPrice> {
        self.price(type_id)
            .filter(|captured| policy.prices(captured.source))
    }

    pub fn is_empty(&self) -> bool {
        self.prices.is_empty()
    }

    /// Requested types the payload priced with a real `average_price`.
    pub fn market_count(&self) -> usize {
        self.prices
            .values()
            .filter(|captured| captured.source.is_market_price())
            .count()
    }
}

/// Filters an ESI payload down to the requested type ids, keeping the field provenance.
pub fn collect_esi_capture(
    rows: &[EsiPriceRow],
    requested: &BTreeSet<u32>,
    captured_at: &str,
    provenance: String,
) -> CaptureBatch {
    let mut prices = BTreeMap::new();
    let mut adjusted_only = BTreeSet::new();
    let mut rows_usable = 0_usize;
    let mut rows_market = 0_usize;
    for row in rows {
        let Some(captured) = row.captured_price() else {
            continue;
        };
        rows_usable += 1;
        if captured.source.is_market_price() {
            rows_market += 1;
        }
        let Ok(type_id) = u32::try_from(row.type_id) else {
            continue;
        };
        if requested.contains(&type_id) {
            if captured.source == PriceSource::CcpEsiAdjusted {
                adjusted_only.insert(type_id);
            }
            prices.insert(type_id, captured);
        }
    }
    CaptureBatch {
        attempted: true,
        captured_at: captured_at.to_string(),
        prices,
        provenance: vec![(SOURCE_KEY_ESI.to_string(), provenance)],
        rows_total: rows.len(),
        rows_usable,
        rows_market,
        adjusted_only,
    }
}

// ------------------------------------------------------------------- snapshot Jita capture

/// What the snapshot half of the capture found — plan §4.2 source 1, per-rule so the report
/// can say which rule priced what rather than quoting one opaque total.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotCaptureStats {
    /// Types quoted on at least one side in the reference system.
    pub types_in_book: usize,
    /// Types the book could put a price on, whether or not this run wants one.
    pub priced_split: usize,
    pub priced_ask_only: usize,
    pub priced_bid_only: usize,
    /// Types in the book whose quotes did not survive [`crate::overlay::ReferenceBook::reference_price`]
    /// — a non-positive or non-finite side. Never priced at a guess.
    pub skipped_unusable: usize,
}

impl SnapshotCaptureStats {
    pub fn priced(&self) -> usize {
        self.priced_split + self.priced_ask_only + self.priced_bid_only
    }
}

/// Turns a harvested Jita book into a [`CaptureBatch`] of `ccp-snapshot-jita-split` prices,
/// restricted to `requested`.
///
/// Restricting here is the whole permanence story (§4.3): the caller passes the types it is
/// allowed to write, [`merge`] refuses to overwrite a held capture anyway, and so a source
/// added years after the first capture can only ever *fill gaps*. The per-rule counts are
/// computed over the **whole** book, not the requested subset, because "what could this
/// source price" and "what may it write today" are different questions and the report asks
/// both.
pub fn collect_snapshot_capture(
    book: &crate::overlay::ReferenceBook,
    requested: &BTreeSet<u32>,
    captured_at: &str,
    provenance: String,
) -> (CaptureBatch, SnapshotCaptureStats) {
    let mut stats = SnapshotCaptureStats::default();
    let mut prices = BTreeMap::new();
    for type_id in book.types() {
        stats.types_in_book += 1;
        let Some(reference) = book.reference_price(type_id) else {
            stats.skipped_unusable += 1;
            continue;
        };
        match reference.rule {
            crate::overlay::ReferenceRule::Split => stats.priced_split += 1,
            crate::overlay::ReferenceRule::AskOnly => stats.priced_ask_only += 1,
            crate::overlay::ReferenceRule::BidOnly => stats.priced_bid_only += 1,
        }
        if requested.contains(&type_id) {
            prices.insert(
                type_id,
                CapturedPrice {
                    price: reference.price,
                    source: PriceSource::CcpSnapshotJitaSplit,
                },
            );
        }
    }
    let batch = CaptureBatch {
        attempted: true,
        captured_at: captured_at.to_string(),
        prices,
        provenance: vec![(SOURCE_KEY_SNAPSHOT.to_string(), provenance)],
        rows_total: stats.types_in_book,
        rows_usable: stats.priced(),
        rows_market: stats.priced(),
        // A snapshot quote is a real order at a real price. `adjusted_only` is ESI's
        // industry-index concept and has no meaning here; leaving it empty also keeps the
        // provenance reconciliation in `merge` reading only the ESI payload, which is the
        // only payload that can answer it.
        adjusted_only: BTreeSet::new(),
    };
    (batch, stats)
}

/// Folds two capture batches into the one batch [`merge`] consumes, `primary` winning every
/// type both answer.
///
/// Decision 6 fixes the order: **the snapshot is primary and ESI is the gap-filler**. Running
/// them as one batch rather than two sequential merges is deliberate — `merge` decides
/// permanence, provenance and the `unchanged` test against the manifest that was loaded off
/// disk, and chaining merges would quietly measure the second one against the first one's
/// output instead.
pub fn combine_captures(primary: CaptureBatch, secondary: CaptureBatch) -> CaptureBatch {
    if !primary.attempted {
        return secondary;
    }
    if !secondary.attempted {
        return primary;
    }
    let mut prices = secondary.prices;
    // `extend` on a BTreeMap overwrites on collision, so the primary lands last on purpose.
    prices.extend(primary.prices);
    let mut provenance = primary.provenance;
    provenance.extend(secondary.provenance);
    CaptureBatch {
        attempted: true,
        // Both halves of one run share the run's timestamp; keeping the primary's is only a
        // tie-break for the degenerate case where they ever differ.
        captured_at: primary.captured_at,
        prices,
        provenance,
        rows_total: primary.rows_total + secondary.rows_total,
        rows_usable: primary.rows_usable + secondary.rows_usable,
        rows_market: primary.rows_market + secondary.rows_market,
        // Only ESI can observe an adjusted-price-only row, and only ESI ever sets this.
        adjusted_only: secondary.adjusted_only,
    }
}

/// One unauthenticated `GET` against ESI, blocking client, configured user agent.
pub fn fetch_esi_body(url: &str, user_agent: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(user_agent)
        .timeout(ESI_REQUEST_TIMEOUT)
        .build()
        .context("failed to build the HTTP client for the ESI price capture")?;
    let response = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .with_context(|| {
            format!(
                "GET {url} failed. If this environment has no network, pass \
                 --from-file <path> to merge an ESI-shaped JSON array from disk instead."
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        bail!("GET {url} returned HTTP {status}");
    }
    response
        .text()
        .with_context(|| format!("failed to read the response body from {url}"))
}

pub fn read_esi_file(path: &Path) -> Result<String> {
    fs::read_to_string(path)
        .with_context(|| format!("failed to read ESI price file {}", path.to_string_lossy()))
}

// ------------------------------------------------------------------------- force-refetch

/// A bucket word accepted by `--force-refetch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ForceBucket {
    /// `a` — bucket A, manufacturable T1.
    A,
    /// `b` — bucket B, ores/minerals/materials.
    B,
    /// `d` — bucket D, every junk candidate.
    D,
    /// `leaves` — every leaf the cost map needs a capture for to price A∪B.
    Leaves,
    /// `all` — everything capturable: the whole want list plus every capture already held.
    All,
}

impl ForceBucket {
    pub fn key(self) -> &'static str {
        match self {
            Self::A => "a",
            Self::B => "b",
            Self::D => "d",
            Self::Leaves => "leaves",
            Self::All => "all",
        }
    }
}

/// The parsed `--force-refetch` spec: type ids and/or bucket words.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForceSpec {
    pub type_ids: BTreeSet<u32>,
    pub buckets: BTreeSet<ForceBucket>,
}

impl ForceSpec {
    pub fn is_empty(&self) -> bool {
        self.type_ids.is_empty() && self.buckets.is_empty()
    }

    /// Expands the spec against the classified universe.
    ///
    /// The result is intersected with what is actually *capturable* — the current want list
    /// plus the captures already held. Naming a type that neither holds nor needs a capture
    /// cannot conjure one: that would quietly reprice an index type off the live market and
    /// bypass the cost model. Those names are returned separately so the run can report
    /// them.
    pub fn resolve(&self, context: &ForceContext<'_>) -> ForceSelection {
        let mut named: BTreeSet<u32> = self.type_ids.clone();
        for bucket in &self.buckets {
            match bucket {
                ForceBucket::A => named.extend(context.bucket_a.iter().copied()),
                ForceBucket::B => named.extend(context.bucket_b.iter().copied()),
                ForceBucket::D => named.extend(context.bucket_d.iter().copied()),
                ForceBucket::Leaves => named.extend(context.blocking_leaves.iter().copied()),
                ForceBucket::All => {
                    named.extend(context.wanted.iter().copied());
                    named.extend(context.held_captures.iter().copied());
                }
            }
        }
        let mut selected = BTreeSet::new();
        let mut not_capturable = BTreeSet::new();
        for type_id in named {
            if context.wanted.contains(&type_id) || context.held_captures.contains(&type_id) {
                selected.insert(type_id);
            } else {
                not_capturable.insert(type_id);
            }
        }
        ForceSelection {
            selected,
            not_capturable,
        }
    }
}

/// The universe a [`ForceSpec`] is expanded against.
#[derive(Debug, Clone, Copy)]
pub struct ForceContext<'a> {
    pub bucket_a: &'a BTreeSet<u32>,
    pub bucket_b: &'a BTreeSet<u32>,
    pub bucket_d: &'a BTreeSet<u32>,
    /// Leaves the cost map must have captured to price A∪B, computed with no captures
    /// applied — the permanent shopping list, not "what is still missing today".
    pub blocking_leaves: &'a BTreeSet<u32>,
    /// Every type a capture is wanted for: `blocking_leaves` ∪ bucket D.
    pub wanted: &'a BTreeSet<u32>,
    /// Types the loaded manifest already holds a capture for.
    pub held_captures: &'a BTreeSet<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForceSelection {
    /// Entries that will actually be refetched.
    pub selected: BTreeSet<u32>,
    /// Named types that hold no capture and need none — ignored, and reported as such.
    pub not_capturable: BTreeSet<u32>,
}

/// Parses `34,2073,leaves` into a [`ForceSpec`]. Empty items are skipped; an unknown word is
/// a hard error listing the legal vocabulary.
pub fn parse_force_refetch(spec: &str) -> Result<ForceSpec> {
    let mut parsed = ForceSpec::default();
    for raw in spec.split(',') {
        let item = raw.trim();
        if item.is_empty() {
            continue;
        }
        let lowered = item.to_ascii_lowercase();
        let bucket = match lowered.as_str() {
            "a" => Some(ForceBucket::A),
            "b" => Some(ForceBucket::B),
            "d" => Some(ForceBucket::D),
            "leaves" => Some(ForceBucket::Leaves),
            "all" => Some(ForceBucket::All),
            _ => None,
        };
        if let Some(bucket) = bucket {
            parsed.buckets.insert(bucket);
            continue;
        }
        let type_id = lowered.parse::<u32>().map_err(|_| {
            anyhow::anyhow!(
                "--force-refetch does not understand \"{item}\". Legal items: a type ID, \
                 or one of a, b, d, leaves, all (comma-separated)."
            )
        })?;
        if type_id == 0 {
            bail!("--force-refetch does not accept type ID 0");
        }
        parsed.type_ids.insert(type_id);
    }
    Ok(parsed)
}

// -------------------------------------------------------------------------------- merging

/// Everything a merge needs that is not the network.
#[derive(Debug, Clone)]
pub struct MergeInput {
    pub sde_build: Option<u64>,
    pub cost_model: String,
    /// The rules that produced `local`, recorded in the header so the committed manifest
    /// says which arbitrage-closing rules were on when it was written.
    pub pricing_rules: Vec<String>,
    pub generated_at: String,
    /// A∪B types the local ladder priced. Bucket D never appears here — it is capture-only.
    pub local: BTreeMap<u32, LocalPrice>,
    /// Types a capture is wanted for: every leaf that feeds an A∪B type plus every bucket D
    /// candidate (§4.2, widened in piece 7 — under `capture-first` a leaf's cost *is* its
    /// captured price, so every leaf needs one).
    pub wanted: BTreeSet<u32>,
    /// Already resolved and intersected with what is capturable (see [`ForceSpec::resolve`]).
    pub forced: BTreeSet<u32>,
    /// Types whose **local** price is the entry even though a capture is held, because the
    /// configured leaf ladder passed the capture over. Empty under `capture-first`, where a
    /// held capture is always the price the ladder reaches for first; under
    /// `base-price-first` it is every type with a positive `basePrice`.
    ///
    /// The capture is not discarded — it is retained on the entry (see [`RetainedCapture`]).
    #[allow(clippy::doc_markdown)]
    pub local_outranks_capture: BTreeSet<u32>,
    /// Check the *field provenance* of held `ccp-esi-average` captures against the payload,
    /// once.
    ///
    /// A manifest written before rule A existed labelled every ESI number `ccp-esi-average`,
    /// including the ones that only ever had an `adjusted_price`. This is the one-time
    /// migration that corrects those labels. It is deliberately **not** a per-run check: a
    /// type that trades today and not tomorrow would otherwise have its captured price
    /// demoted by a transient gap in the payload, and captures are permanent (§4.3). The
    /// caller turns it on exactly while the loaded manifest does not yet record the rule.
    pub reconcile_capture_provenance: bool,
    /// Rule A. Decides whether a held capture is allowed to *be* an entry's price, which is
    /// the same question the cost map's leaf ladder answers — so it has to be answered the
    /// same way here, or the merge would hand back a price the ladder refused.
    pub policy: CapturePolicy,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeStats {
    pub entries_before: usize,
    pub entries_after: usize,
    pub local_written: usize,
    pub local_written_cost_recursive: usize,
    pub local_written_base_price: usize,
    /// Entries rule B rewrote so a compressed pair carries one price.
    pub local_written_derived_twin: usize,
    /// Entries rule C lifted to their reprocessing value.
    pub local_written_reprocessing_floor: usize,
    /// Entries that were local before and are not in the new manifest: the type left A∪B, or
    /// stopped resolving locally.
    pub local_dropped: usize,
    /// A∪B types with both a local price and a permanent capture where the **capture** is the
    /// entry, because the configured leaf ladder prefers it. The local price is discarded (it
    /// is recomputed every run anyway), and this counter exists so that never happens
    /// silently.
    pub local_suppressed_by_capture: usize,
    /// The mirror case: types with both, where the **local** price is the entry and the
    /// capture rides along in `retainedCapture`. Always 0 under `capture-first`.
    pub captures_retained_beside_local: usize,
    /// Entries that were local in the loaded manifest and are a `ccp-*` entry now — the
    /// leaves `capture-first` moved off `basePrice` and onto the market. The manifest's
    /// `source` follows the rung that priced the entry, so this is exactly what the diff says.
    pub local_became_capture: usize,
    /// The reverse: `ccp-*` before, local now (`base-price-first` taking a leaf back off the
    /// market). The capture itself is retained, never dropped.
    pub capture_became_local: usize,
    /// Captures carried over unchanged.
    pub captures_held: usize,
    /// Captures written for a type that had none.
    pub captures_new: usize,
    /// Captures replaced because `--force-refetch` named them and a new price arrived.
    pub captures_forced_replaced: usize,
    /// Captures `--force-refetch` named but the capture source had no price for: the old
    /// value is kept rather than discarding a good price for nothing.
    pub captures_forced_kept: usize,
    /// Captures held for types outside the current want list (an SDE change moved them).
    /// Kept: captures are permanent.
    pub captures_retained_unwanted: usize,
    /// Held captures whose **label** was corrected because the payload shows the number came
    /// from `adjusted_price` and not `average_price`. The value and `capturedAt` do not move:
    /// this is a provenance fix, not a repricing, and it is what lets rule A tell a real
    /// market price from CCP's industry index in a manifest written before the distinction
    /// existed.
    pub captures_relabelled_adjusted: usize,
    /// `adjusted_price`-only records replaced by a real `average_price` that has since
    /// appeared. Not a refetch — the type never had a market price to begin with.
    pub captures_upgraded_to_market: usize,
    /// Records in the merged manifest that carry a number rule A will not spend.
    pub captures_adjusted_records: usize,
    /// Wanted types that still have no capture after the merge. For bucket D these stay
    /// unseeded by design; for a blocking leaf they fail the build (§4.1).
    pub captures_missing: usize,
    /// True when the merged manifest is byte-identical to the loaded one.
    pub unchanged: bool,
}

/// How much a capture is worth keeping. A real market price outranks CCP's industry index,
/// so no path in the merge can replace the first with the second.
fn capture_rank(source: PriceSource) -> u8 {
    if source.is_market_price() { 2 } else { 1 }
}

/// Applies the §4.3 lifecycle: recompute local entries, keep every capture, honour
/// `--force-refetch`, and never invent a price.
pub fn merge(existing: &PriceManifest, input: &MergeInput, batch: &CaptureBatch) -> (PriceManifest, MergeStats) {
    let mut stats = MergeStats {
        entries_before: existing.prices.len(),
        ..MergeStats::default()
    };
    // 1. Every capture the run ends up holding, before anything decides which price wins.
    //    Permanent, and immune to everything but --force-refetch.
    let mut held: BTreeMap<u32, RetainedCapture> = BTreeMap::new();
    for (type_id, entry) in &existing.prices {
        let Some(capture) = entry.capture_record() else {
            continue;
        };
        // 1a. Provenance reconciliation. A manifest written before rule A existed labelled
        //     every ESI number `ccp-esi-average`, including the ones that only ever had an
        //     `adjusted_price`. Correcting the label costs nothing (the value and the
        //     capture timestamp are untouched) and is the only way an old manifest can tell
        //     a trade from CCP's industry index without refetching every price on the market.
        let capture = if input.reconcile_capture_provenance
            && capture.source == PriceSource::CcpEsiAverage
            && batch.adjusted_only.contains(type_id)
        {
            stats.captures_relabelled_adjusted += 1;
            RetainedCapture {
                source: PriceSource::CcpEsiAdjusted,
                ..capture
            }
        } else {
            capture
        };

        if input.forced.contains(type_id) {
            // Never downgrade: a forced refetch that only comes back with an
            // `adjusted_price` must not throw away a real market price for it.
            if let Some(offer) = batch.price(*type_id)
                && capture_rank(offer.source) >= capture_rank(capture.source)
            {
                held.insert(
                    *type_id,
                    RetainedCapture::new(offer.price, offer.source, &batch.captured_at),
                );
                stats.captures_forced_replaced += 1;
                continue;
            }
            stats.captures_forced_kept += 1;
        } else if !capture.source.is_market_price()
            && let Some(offer) = batch.price(*type_id)
            && offer.source.is_market_price()
        {
            // The held record is CCP's industry index, which prices nothing. A real
            // `average_price` appearing is a *first* capture for this type, not a refetch of
            // one, so §4.3's "never refetch" rule does not protect the old number.
            held.insert(
                *type_id,
                RetainedCapture::new(offer.price, offer.source, &batch.captured_at),
            );
            stats.captures_upgraded_to_market += 1;
            continue;
        }
        held.insert(*type_id, capture);
        stats.captures_held += 1;
    }

    // 2. New captures, only for types the run actually asked about.
    if batch.attempted {
        for (type_id, captured) in &batch.prices {
            if held.contains_key(type_id) {
                continue;
            }
            if !input.wanted.contains(type_id) && !input.forced.contains(type_id) {
                continue;
            }
            if !captured.price.is_finite() || captured.price <= 0.0 {
                continue;
            }
            held.insert(
                *type_id,
                RetainedCapture::new(captured.price, captured.source, &batch.captured_at),
            );
            stats.captures_new += 1;
        }
    }

    // 3. One entry per type, carrying the rung the configured ladder actually used. Local
    //    prices are recomputed every run; captures are never lost, only out-ranked.
    let mut prices: BTreeMap<u32, PriceEntry> = BTreeMap::new();
    for (type_id, local) in &input.local {
        let entry = match held.get(type_id) {
            // A capture only outranks a computed price if it *is* a price: under rule A an
            // `adjusted_price`-only record loses to `basePrice` and rides along instead.
            Some(capture)
                if input.policy.prices(capture.source)
                    && !input.local_outranks_capture.contains(type_id) =>
            {
                stats.local_suppressed_by_capture += 1;
                PriceEntry::from_retained(capture)
            }
            Some(capture) => {
                stats.captures_retained_beside_local += 1;
                stats.local_written += 1;
                PriceEntry::local(*local).retaining(capture.clone())
            }
            None => {
                stats.local_written += 1;
                PriceEntry::local(*local)
            }
        };
        if !entry.is_capture() {
            match local.source {
                PriceSource::CostRecursive => stats.local_written_cost_recursive += 1,
                PriceSource::BasePrice => stats.local_written_base_price += 1,
                PriceSource::DerivedCompressedTwin => stats.local_written_derived_twin += 1,
                PriceSource::ReprocessingFloor => stats.local_written_reprocessing_floor += 1,
                _ => {}
            }
        }
        prices.insert(*type_id, entry);
    }
    for (type_id, capture) in &held {
        prices
            .entry(*type_id)
            .or_insert_with(|| PriceEntry::from_retained(capture));
    }

    stats.local_dropped = existing
        .prices
        .iter()
        .filter(|(type_id, entry)| !entry.is_capture() && !prices.contains_key(type_id))
        .count();
    for (type_id, before) in &existing.prices {
        match prices.get(type_id) {
            Some(after) if !before.is_capture() && after.is_capture() => {
                stats.local_became_capture += 1;
            }
            Some(after) if before.is_capture() && !after.is_capture() => {
                stats.capture_became_local += 1;
            }
            _ => {}
        }
    }
    stats.captures_missing = input
        .wanted
        .iter()
        .filter(|type_id| {
            prices
                .get(type_id)
                .is_none_or(|entry| entry.capture_record().is_none())
        })
        .count();
    stats.captures_retained_unwanted = prices
        .iter()
        .filter(|(type_id, entry)| {
            entry.capture_record().is_some() && !input.wanted.contains(type_id)
        })
        .count();
    stats.captures_adjusted_records = prices
        .values()
        .filter(|entry| {
            entry
                .capture_record()
                .is_some_and(|capture| !capture.source.is_market_price())
        })
        .count();
    stats.entries_after = prices.len();

    let mut sources = existing.sources.clone();
    // Only stamp provenance when the capture actually changed something: a no-op refresh
    // must leave the committed file byte-identical.
    if stats.captures_new > 0
        || stats.captures_forced_replaced > 0
        || stats.captures_upgraded_to_market > 0
    {
        for (key, value) in &batch.provenance {
            sources.insert(key.clone(), value.clone());
        }
    }

    let unchanged = prices == existing.prices
        && sources == existing.sources
        && existing.sde_build == input.sde_build
        && existing.cost_model == input.cost_model
        && existing.pricing_rules == input.pricing_rules
        && existing.format_version == MANIFEST_FORMAT_VERSION;
    stats.unchanged = unchanged;

    let manifest = PriceManifest {
        format_version: MANIFEST_FORMAT_VERSION,
        sde_build: input.sde_build,
        cost_model: input.cost_model.clone(),
        pricing_rules: input.pricing_rules.clone(),
        // Nothing changed → keep the old timestamp so the committed artifact does not churn.
        generated_at: if unchanged {
            existing.generated_at.clone()
        } else {
            input.generated_at.clone()
        },
        sources,
        prices,
    };
    (manifest, stats)
}

/// The first place two manifests differ, as a human-readable line. Used by the write-back
/// check so a round-trip failure names the entry instead of just asserting inequality.
pub fn first_difference(left: &PriceManifest, right: &PriceManifest) -> Option<String> {
    if left.format_version != right.format_version {
        return Some(format!(
            "formatVersion {} != {}",
            left.format_version, right.format_version
        ));
    }
    if left.sde_build != right.sde_build {
        return Some(format!("sdeBuild {:?} != {:?}", left.sde_build, right.sde_build));
    }
    if left.cost_model != right.cost_model {
        return Some(format!("costModel {} != {}", left.cost_model, right.cost_model));
    }
    if left.pricing_rules != right.pricing_rules {
        return Some(format!(
            "pricingRules {:?} != {:?}",
            left.pricing_rules, right.pricing_rules
        ));
    }
    if left.generated_at != right.generated_at {
        return Some(format!(
            "generatedAt {} != {}",
            left.generated_at, right.generated_at
        ));
    }
    if left.sources != right.sources {
        return Some(format!("sources {:?} != {:?}", left.sources, right.sources));
    }
    for (type_id, entry) in &left.prices {
        match right.prices.get(type_id) {
            None => return Some(format!("type {type_id} is missing on the right")),
            Some(other) if other != entry => {
                return Some(format!("type {type_id}: {entry:?} != {other:?}"));
            }
            _ => {}
        }
    }
    for type_id in right.prices.keys() {
        if !left.prices.contains_key(type_id) {
            return Some(format!("type {type_id} is missing on the left"));
        }
    }
    None
}

/// The local half of the ladder: every A∪B type the cost map priced from static data.
/// Types resolved through a capture, and types still unpriced, are deliberately absent.
pub fn local_prices_from_report(report: &CostReport) -> BTreeMap<u32, LocalPrice> {
    let mut local = BTreeMap::new();
    for (type_id, outcome) in &report.outcomes {
        let CostOutcome::Priced { unit_cost, source } = outcome else {
            continue;
        };
        if let Some(price) = LocalPrice::from_cost(*unit_cost, *source) {
            local.insert(*type_id, price);
        }
    }
    local
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_entry(price: f64, source: PriceSource) -> PriceEntry {
        PriceEntry {
            price,
            source,
            captured_at: None,
            retained_capture: None,
        }
    }

    fn capture_entry(price: f64, at: &str) -> PriceEntry {
        PriceEntry::capture(price, PriceSource::CcpEsiAverage, at)
    }

    fn manifest_with(entries: &[(u32, PriceEntry)]) -> PriceManifest {
        let mut manifest = PriceManifest::empty(Some(3_396_210), "recursive-v1", "2026-08-01T00:00:00Z");
        for (type_id, entry) in entries {
            manifest.prices.insert(*type_id, entry.clone());
        }
        manifest
    }

    fn input(local: &[(u32, LocalPrice)], wanted: &[u32], forced: &[u32]) -> MergeInput {
        MergeInput {
            sde_build: Some(3_396_210),
            cost_model: "recursive-v1".to_string(),
            pricing_rules: Vec::new(),
            generated_at: "2026-08-10T00:00:00Z".to_string(),
            local: local.iter().copied().collect(),
            wanted: wanted.iter().copied().collect(),
            forced: forced.iter().copied().collect(),
            local_outranks_capture: BTreeSet::new(),
            reconcile_capture_provenance: true,
            policy: CapturePolicy::reject_adjusted(),
        }
    }

    /// A batch of real `average_price` captures.
    fn batch(prices: &[(u32, f64)], at: &str) -> CaptureBatch {
        batch_of(
            &prices
                .iter()
                .map(|(type_id, price)| (*type_id, *price, PriceSource::CcpEsiAverage))
                .collect::<Vec<_>>(),
            at,
        )
    }

    /// A batch with explicit per-type provenance, so a test can mix `average_price` captures
    /// and `adjusted_price`-only records the way one real ESI payload does.
    fn batch_of(prices: &[(u32, f64, PriceSource)], at: &str) -> CaptureBatch {
        let adjusted_only = prices
            .iter()
            .filter(|(_, _, source)| *source == PriceSource::CcpEsiAdjusted)
            .map(|(type_id, _, _)| *type_id)
            .collect::<BTreeSet<_>>();
        CaptureBatch {
            attempted: true,
            captured_at: at.to_string(),
            prices: prices
                .iter()
                .map(|(type_id, price, source)| {
                    (
                        *type_id,
                        CapturedPrice {
                            price: *price,
                            source: *source,
                        },
                    )
                })
                .collect(),
            provenance: vec![(SOURCE_KEY_ESI.to_string(), format!("markets/prices @ {at}"))],
            rows_total: prices.len(),
            rows_usable: prices.len(),
            rows_market: prices.len() - adjusted_only.len(),
            adjusted_only,
        }
    }

    // -------------------------------------------- the snapshot Jita-split capture source

    /// A Jita book: `(type, is_buy, price)`, in the reference system.
    fn jita_book(quotes: &[(u32, bool, f64)]) -> crate::overlay::ReferenceBook {
        let mut book = crate::overlay::ReferenceBook::new(30_000_142);
        for (type_id, is_buy_order, price) in quotes {
            book.absorb(&crate::overlay::ScreenedRow {
                station_id: 60_003_760,
                solar_system_id: 30_000_142,
                constellation_id: 20_000_020,
                region_id: 10_000_002,
                type_id: *type_id,
                price_cents: crate::overlay::price_to_cents(*price),
                quantity: 1,
                is_buy_order: *is_buy_order,
                is_npc_order: false,
            });
        }
        book
    }

    fn snapshot_batch(
        quotes: &[(u32, bool, f64)],
        requested: &[u32],
        at: &str,
    ) -> (CaptureBatch, SnapshotCaptureStats) {
        collect_snapshot_capture(
            &jita_book(quotes),
            &requested.iter().copied().collect::<BTreeSet<_>>(),
            at,
            format!("market-orders.bz2 jita-split system 30000142 @ {at}"),
        )
    }

    #[test]
    fn the_snapshot_batch_prices_by_rule_and_stays_inside_the_requested_set() {
        let (batch, stats) = snapshot_batch(
            &[
                // 34: both sides -> the split.
                (34, false, 6.0),
                (34, true, 4.0),
                // 2073: asks only.
                (2073, false, 9.0),
                // 25595: bids only.
                (25595, true, 3.0),
                // 32880: priced, but not requested — it must not reach the batch.
                (32880, false, 100.0),
                (32880, true, 90.0),
            ],
            &[34, 2073, 25595],
            "2026-08-10T00:00:00Z",
        );

        assert_eq!(stats.types_in_book, 4, "counted over the whole book");
        assert_eq!(
            (stats.priced_split, stats.priced_ask_only, stats.priced_bid_only),
            (2, 1, 1),
            "34 and 32880 both have two sides"
        );
        assert_eq!(stats.skipped_unusable, 0);
        assert_eq!(stats.priced(), 4);

        assert!(batch.attempted);
        assert_eq!(
            batch.prices.keys().copied().collect::<Vec<_>>(),
            vec![34, 2073, 25595],
            "a type nobody asked about is never captured, however well quoted it is"
        );
        assert_eq!(batch.price(34).expect("split").price, 5.0);
        assert_eq!(batch.price(2073).expect("ask only").price, 9.0);
        assert_eq!(batch.price(25595).expect("bid only").price, 3.0);
        for type_id in [34, 2073, 25595] {
            assert_eq!(
                batch.price(type_id).expect("priced").source,
                PriceSource::CcpSnapshotJitaSplit
            );
        }
        assert!(
            batch.adjusted_only.is_empty(),
            "adjusted_price is an ESI concept; a snapshot quote is always a real order"
        );
        assert_eq!(
            batch.provenance,
            vec![(
                SOURCE_KEY_SNAPSHOT.to_string(),
                "market-orders.bz2 jita-split system 30000142 @ 2026-08-10T00:00:00Z".to_string()
            )]
        );
    }

    #[test]
    fn a_snapshot_price_fills_a_gap_and_never_repriced_a_capture_esi_already_took() {
        // The state this source was actually added into: ESI captured 2073 long ago, 25595
        // never got a price from anywhere. Adding a second source years later must fill the
        // hole and leave the held capture alone — §4.3, and the whole risk of piece 14.
        let existing = manifest_with(&[
            (34, local_entry(2.0, PriceSource::BasePrice)),
            (2073, capture_entry(4.1, "2026-08-01T00:00:00Z")),
        ]);
        let (batch, _) = snapshot_batch(
            &[
                (2073, false, 400.0),
                (2073, true, 300.0),
                (25595, false, 6200.0),
                (25595, true, 6000.0),
            ],
            &[2073, 25595],
            "2026-08-10T00:00:00Z",
        );
        let input = input(
            &[(
                34,
                LocalPrice {
                    price: 2.0,
                    source: PriceSource::BasePrice,
                },
            )],
            &[2073, 25595],
            &[],
        );

        let (merged, stats) = merge(&existing, &input, &batch);

        let held = &merged.prices[&2073];
        assert_eq!(
            (held.price, held.source),
            (4.1, PriceSource::CcpEsiAverage),
            "the ESI capture stands: a Jita split of 350.00 does not get to overwrite it"
        );
        assert_eq!(held.captured_at.as_deref(), Some("2026-08-01T00:00:00Z"));
        assert_eq!(
            &merged.prices[&2073], &existing.prices[&2073],
            "byte-for-byte the entry that was on disk"
        );

        let filled = &merged.prices[&25595];
        assert_eq!(
            (filled.price, filled.source),
            (6100.0, PriceSource::CcpSnapshotJitaSplit),
            "the type ESI could not cover is exactly what the new source is for"
        );
        assert_eq!(filled.captured_at.as_deref(), Some("2026-08-10T00:00:00Z"));

        assert_eq!(stats.captures_held, 1);
        assert_eq!(stats.captures_new, 1);
        assert_eq!(stats.captures_forced_replaced, 0);
        assert_eq!(
            merged.sources.get(SOURCE_KEY_SNAPSHOT).map(String::as_str),
            Some("market-orders.bz2 jita-split system 30000142 @ 2026-08-10T00:00:00Z"),
            "the header names the source that actually contributed"
        );
    }

    #[test]
    fn force_refetch_is_the_one_thing_that_lets_a_jita_split_replace_a_held_capture() {
        let existing = manifest_with(&[(2073, capture_entry(4.1, "2026-08-01T00:00:00Z"))]);
        let (batch, _) = snapshot_batch(
            &[(2073, false, 400.0), (2073, true, 300.0)],
            &[2073],
            "2026-08-10T00:00:00Z",
        );

        let (merged, stats) = merge(&existing, &input(&[], &[2073], &[2073]), &batch);

        let entry = &merged.prices[&2073];
        assert_eq!(
            (entry.price, entry.source),
            (350.0, PriceSource::CcpSnapshotJitaSplit),
            "(400.00 + 300.00) / 2, written over the old ESI number"
        );
        assert_eq!(
            entry.captured_at.as_deref(),
            Some("2026-08-10T00:00:00Z"),
            "a forced replacement carries the new capture's timestamp"
        );
        assert_eq!(stats.captures_forced_replaced, 1);
        assert_eq!(stats.captures_held, 0);

        // Forced but the book has nothing to say: the good price is kept, not discarded.
        let (empty, _) = snapshot_batch(&[], &[2073], "2026-08-10T00:00:00Z");
        let (kept, kept_stats) = merge(&existing, &input(&[], &[2073], &[2073]), &empty);
        assert_eq!(&kept.prices[&2073], &existing.prices[&2073]);
        assert_eq!(kept_stats.captures_forced_kept, 1);
    }

    #[test]
    fn combining_the_two_sources_puts_the_snapshot_first_and_esi_in_the_gaps() {
        // 34 is quoted in Jita and priced by ESI: decision 6 says the snapshot wins it.
        // 2073 is ESI-only, 25595 snapshot-only — one batch has to carry both.
        let (snapshot, _) = snapshot_batch(
            &[(34, false, 6.0), (34, true, 4.0), (25595, false, 6100.0)],
            &[34, 25595],
            "2026-08-10T00:00:00Z",
        );
        let esi = batch(&[(34, 99.0), (2073, 4.1)], "2026-08-10T00:00:00Z");

        let combined = combine_captures(snapshot, esi);
        assert_eq!(
            combined.price(34).expect("both sources answered 34"),
            CapturedPrice {
                price: 5.0,
                source: PriceSource::CcpSnapshotJitaSplit
            },
            "snapshot first, ESI is the gap-filler"
        );
        assert_eq!(combined.price(2073).expect("esi only").source, PriceSource::CcpEsiAverage);
        assert_eq!(
            combined.price(25595).expect("snapshot only").source,
            PriceSource::CcpSnapshotJitaSplit
        );
        assert_eq!(
            combined.provenance.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
            vec![SOURCE_KEY_SNAPSHOT, SOURCE_KEY_ESI],
            "the header records both sources, in the order they ran"
        );

        // A source that did not run contributes nothing and erases nothing.
        let (snapshot, _) = snapshot_batch(&[(34, false, 6.0)], &[34], "2026-08-10T00:00:00Z");
        let only_snapshot = combine_captures(snapshot.clone(), CaptureBatch::default());
        assert_eq!(only_snapshot.prices, snapshot.prices);
        let only_esi = combine_captures(
            CaptureBatch::default(),
            batch(&[(2073, 4.1)], "2026-08-10T00:00:00Z"),
        );
        assert_eq!(only_esi.prices.keys().copied().collect::<Vec<_>>(), vec![2073]);
        assert!(!combine_captures(CaptureBatch::default(), CaptureBatch::default()).attempted);
    }

    #[test]
    fn a_snapshot_split_upgrades_an_adjusted_price_only_record_because_that_is_a_first_capture() {
        // Rule A spends nothing from `ccp-esi-adjusted`, so a type holding only one has no
        // captured *price*. A Jita split for it is a first capture, not a refetch, and §4.3
        // does not protect CCP's industry index.
        let existing = manifest_with(&[(
            2073,
            PriceEntry::capture(4.1, PriceSource::CcpEsiAdjusted, "2026-08-01T00:00:00Z"),
        )]);
        let (batch, _) = snapshot_batch(
            &[(2073, false, 12.0), (2073, true, 8.0)],
            &[2073],
            "2026-08-10T00:00:00Z",
        );

        let (merged, stats) = merge(&existing, &input(&[], &[2073], &[]), &batch);

        let entry = &merged.prices[&2073];
        assert_eq!((entry.price, entry.source), (10.0, PriceSource::CcpSnapshotJitaSplit));
        assert_eq!(stats.captures_upgraded_to_market, 1);
        assert_eq!(stats.captures_forced_replaced, 0);
    }

    #[test]
    fn a_capture_survives_a_refresh_while_a_local_entry_is_recomputed() {
        // 2073 holds a capture from an earlier run; 34 was written from basePrice and the
        // SDE has since revalued it. The refresh must recompute 34 and not touch 2073.
        let existing = manifest_with(&[
            (34, local_entry(2.0, PriceSource::BasePrice)),
            (2073, capture_entry(4.1, "2026-08-01T00:00:00Z")),
        ]);
        let input = input(
            &[(
                34,
                LocalPrice {
                    price: 2.5,
                    source: PriceSource::BasePrice,
                },
            )],
            &[2073],
            &[],
        );
        // The capture source offers a *different* price for 2073. It must be ignored.
        let (merged, stats) = merge(&existing, &input, &batch(&[(2073, 99.0)], "2026-08-10T00:00:00Z"));

        assert_eq!(
            merged.prices.get(&2073),
            Some(&capture_entry(4.1, "2026-08-01T00:00:00Z")),
            "captured prices are permanent"
        );
        assert_eq!(
            merged.prices.get(&34),
            Some(&local_entry(2.5, PriceSource::BasePrice)),
            "local entries are recomputed every run"
        );
        assert_eq!(stats.captures_held, 1);
        assert_eq!(stats.captures_new, 0);
        assert_eq!(stats.captures_forced_replaced, 0);
        assert_eq!(stats.local_written, 1);
        assert_eq!(stats.captures_missing, 0);
        assert!(!stats.unchanged);
    }

    #[test]
    fn a_local_entry_that_no_longer_resolves_is_dropped_not_frozen() {
        let existing = manifest_with(&[(34, local_entry(2.0, PriceSource::BasePrice))]);
        let (merged, stats) = merge(&existing, &input(&[], &[], &[]), &CaptureBatch::default());
        assert!(merged.prices.is_empty());
        assert_eq!(stats.local_dropped, 1);
    }

    #[test]
    fn force_refetch_replaces_only_the_named_capture() {
        let existing = manifest_with(&[
            (34, capture_entry(2.0, "2026-08-01T00:00:00Z")),
            (35, capture_entry(8.0, "2026-08-01T00:00:00Z")),
            (2073, capture_entry(4.1, "2026-08-01T00:00:00Z")),
        ]);
        let spec = parse_force_refetch("34").expect("34 parses");
        assert_eq!(spec.type_ids, BTreeSet::from([34]));
        assert!(spec.buckets.is_empty());

        let held = BTreeSet::from([34, 35, 2073]);
        let empty = BTreeSet::new();
        let wanted = BTreeSet::from([34, 35, 2073]);
        let selection = spec.resolve(&ForceContext {
            bucket_a: &empty,
            bucket_b: &empty,
            bucket_d: &empty,
            blocking_leaves: &empty,
            wanted: &wanted,
            held_captures: &held,
        });
        assert_eq!(selection.selected, BTreeSet::from([34]));
        assert!(selection.not_capturable.is_empty());

        let input = input(&[], &[34, 35, 2073], &[34]);
        // The batch carries fresh prices for all three; only 34 may move.
        let (merged, stats) = merge(
            &existing,
            &input,
            &batch(&[(34, 3.0), (35, 9.0), (2073, 5.0)], "2026-08-10T00:00:00Z"),
        );

        assert_eq!(
            merged.prices.get(&34),
            Some(&capture_entry(3.0, "2026-08-10T00:00:00Z"))
        );
        assert_eq!(
            merged.prices.get(&35),
            Some(&capture_entry(8.0, "2026-08-01T00:00:00Z")),
            "an unnamed capture is untouched"
        );
        assert_eq!(
            merged.prices.get(&2073),
            Some(&capture_entry(4.1, "2026-08-01T00:00:00Z")),
            "an unnamed capture is untouched"
        );
        assert_eq!(stats.captures_forced_replaced, 1);
        assert_eq!(stats.captures_held, 2);
        assert_eq!(stats.captures_new, 0);
    }

    #[test]
    fn a_forced_capture_with_no_new_price_keeps_the_old_one() {
        let existing = manifest_with(&[(34, capture_entry(2.0, "2026-08-01T00:00:00Z"))]);
        let (merged, stats) = merge(
            &existing,
            &input(&[], &[34], &[34]),
            &batch(&[], "2026-08-10T00:00:00Z"),
        );
        assert_eq!(
            merged.prices.get(&34),
            Some(&capture_entry(2.0, "2026-08-01T00:00:00Z"))
        );
        assert_eq!(stats.captures_forced_kept, 1);
        assert_eq!(stats.captures_held, 1);
        assert!(stats.unchanged, "nothing moved, so the file must not churn");
    }

    #[test]
    fn force_refetch_cannot_conjure_a_capture_for_a_type_that_needs_none() {
        // 32880 (a cost-recursive index type) is neither wanted nor already captured.
        // Naming it must not turn it into a market-priced entry.
        let spec = parse_force_refetch("32880,34").expect("parses");
        let held = BTreeSet::from([34]);
        let wanted = BTreeSet::from([34]);
        let empty = BTreeSet::new();
        let selection = spec.resolve(&ForceContext {
            bucket_a: &empty,
            bucket_b: &empty,
            bucket_d: &empty,
            blocking_leaves: &empty,
            wanted: &wanted,
            held_captures: &held,
        });
        assert_eq!(selection.selected, BTreeSet::from([34]));
        assert_eq!(selection.not_capturable, BTreeSet::from([32880]));

        // …and even if a price for it turns up in the batch, the merge ignores it.
        let existing = manifest_with(&[(34, capture_entry(2.0, "2026-08-01T00:00:00Z"))]);
        let (merged, _) = merge(
            &existing,
            &input(&[], &[34], &[34]),
            &batch(&[(34, 3.0), (32880, 500_000.0)], "2026-08-10T00:00:00Z"),
        );
        assert!(!merged.prices.contains_key(&32880));
    }

    #[test]
    fn force_refetch_spec_vocabulary() {
        let spec = parse_force_refetch("a, b ,D,leaves,ALL,34, ,35").expect("parses");
        assert_eq!(spec.type_ids, BTreeSet::from([34, 35]));
        assert_eq!(
            spec.buckets,
            BTreeSet::from([
                ForceBucket::A,
                ForceBucket::B,
                ForceBucket::D,
                ForceBucket::Leaves,
                ForceBucket::All
            ])
        );

        let error = format!("{:#}", parse_force_refetch("everything").expect_err("rejected"));
        assert!(error.contains("leaves"), "{error}");
        assert!(error.contains("all"), "{error}");
        assert!(parse_force_refetch("0").is_err());
        assert!(parse_force_refetch("-1").is_err());
        assert!(parse_force_refetch("").expect("empty is legal").is_empty());
    }

    #[test]
    fn force_bucket_words_expand_against_the_classified_universe() {
        let bucket_a = BTreeSet::from([100, 101]);
        let bucket_b = BTreeSet::from([34]);
        let bucket_d = BTreeSet::from([200, 201]);
        let leaves = BTreeSet::from([300]);
        let wanted = BTreeSet::from([200, 201, 300]);
        let held = BTreeSet::from([34]);
        let context = ForceContext {
            bucket_a: &bucket_a,
            bucket_b: &bucket_b,
            bucket_d: &bucket_d,
            blocking_leaves: &leaves,
            wanted: &wanted,
            held_captures: &held,
        };

        let d = parse_force_refetch("d").unwrap().resolve(&context);
        assert_eq!(d.selected, BTreeSet::from([200, 201]));

        let leaves_only = parse_force_refetch("leaves").unwrap().resolve(&context);
        assert_eq!(leaves_only.selected, BTreeSet::from([300]));

        let all = parse_force_refetch("all").unwrap().resolve(&context);
        assert_eq!(all.selected, BTreeSet::from([34, 200, 201, 300]));
        assert!(all.not_capturable.is_empty());

        // Bucket A holds no captures and needs none, so naming it selects nothing.
        let a = parse_force_refetch("a").unwrap().resolve(&context);
        assert!(a.selected.is_empty());
        assert_eq!(a.not_capturable, BTreeSet::from([100, 101]));
    }

    /// **Rule A, at the parser.** An `adjusted_price`-only row still yields a number — it has
    /// to, or the record could not be kept — but it is labelled as what it is, and that label
    /// is what stops it pricing anything downstream.
    #[test]
    fn an_adjusted_price_only_row_is_recorded_but_is_not_a_market_price() {
        let raw = r#"[
            {"adjusted_price": 306988.09, "average_price": 306988.09, "type_id": 32772},
            {"adjusted_price": 100.0, "type_id": 34},
            {"average_price": 4.1, "type_id": 2073},
            {"adjusted_price": 0.0, "average_price": 0.0, "type_id": 35},
            {"type_id": 36},
            {"adjusted_price": 0.0, "average_price": 12.5, "type_id": 37},
            {"adjusted_price": 7.5, "average_price": 0.0, "type_id": 38},
            {"adjusted_price": -3.0, "type_id": 39}
        ]"#;
        let rows = parse_esi_price_rows(raw).expect("payload parses");
        assert_eq!(rows.len(), 8);

        let by_type = rows
            .iter()
            .map(|row| (row.type_id, row.captured_price()))
            .collect::<BTreeMap<_, _>>();
        let average = |price: f64| {
            Some(CapturedPrice {
                price,
                source: PriceSource::CcpEsiAverage,
            })
        };
        let adjusted = |price: f64| {
            Some(CapturedPrice {
                price,
                source: PriceSource::CcpEsiAdjusted,
            })
        };
        assert_eq!(by_type[&32772], average(306_988.09));
        assert_eq!(
            by_type[&34],
            adjusted(100.0),
            "adjusted_price still yields a number, labelled as the index it is"
        );
        assert_eq!(by_type[&2073], average(4.1), "average_price alone is enough");
        assert_eq!(by_type[&35], None, "both zero is uncaptured");
        assert_eq!(by_type[&36], None, "both missing is uncaptured");
        assert_eq!(
            by_type[&37],
            average(12.5),
            "a zero adjusted price cannot beat a real average"
        );
        assert_eq!(
            by_type[&38],
            adjusted(7.5),
            "a zero average falls through to adjusted, still as adjusted"
        );
        assert_eq!(by_type[&39], None, "a negative price is not a price");

        assert!(!rows[1].has_market_price(), "34 has no average_price");
        assert!(rows[2].has_market_price(), "2073 does");

        let requested = BTreeSet::from([34, 35, 36, 2073, 999_999]);
        let capture = collect_esi_capture(&rows, &requested, "2026-08-10T00:00:00Z", "markets/prices @ x".to_string());
        assert_eq!(capture.price(34), adjusted(100.0));
        assert_eq!(capture.price(2073), average(4.1));
        assert_eq!(capture.rows_total, 8);
        assert_eq!(capture.rows_usable, 5);
        assert_eq!(capture.rows_market, 3, "32772, 2073 and 37 carry an average_price");
        assert_eq!(capture.adjusted_only, BTreeSet::from([34]));
        assert_eq!(capture.market_count(), 1, "only 2073 of the requested types");

        // The policy, not the parser, decides whether that number may be spent.
        let strict = CapturePolicy::reject_adjusted();
        assert_eq!(capture.market_price(2073, strict), average(4.1));
        assert_eq!(
            capture.market_price(34, strict),
            None,
            "rule A refuses to price anything from CCP's industry index"
        );
        assert_eq!(
            capture.market_price(34, CapturePolicy::accept_adjusted()),
            adjusted(100.0),
            "with the rule off the old ladder is back, unchanged"
        );
    }

    /// The other half of rule A: a manifest entry holding only an adjusted record is not a
    /// captured price, so a bucket-D type carrying one is not seeded and the cost map cannot
    /// see it either.
    #[test]
    fn an_adjusted_only_entry_prices_nothing_and_leaves_junk_unseeded() {
        let strict = CapturePolicy::reject_adjusted();
        let lax = CapturePolicy::accept_adjusted();
        let manifest = manifest_with(&[
            (
                500,
                PriceEntry::capture(150.8, PriceSource::CcpEsiAdjusted, "2026-08-10T00:00:00Z"),
            ),
            (
                501,
                PriceEntry::capture(4.1, PriceSource::CcpEsiAverage, "2026-08-10T00:00:00Z"),
            ),
        ]);
        let junk = BucketFlags {
            junk_candidate: true,
            ..BucketFlags::default()
        };

        assert!(manifest.has_capture(500), "the record is kept and visible");
        assert!(!manifest.has_market_capture(500, strict));
        assert!(manifest.has_market_capture(500, lax));
        assert_eq!(manifest.non_market_capture_count(strict), 1);
        assert_eq!(manifest.non_market_capture_count(lax), 0);

        assert_eq!(
            manifest.seed_price(500, junk, strict),
            SeedPrice::UnseedableJunk,
            "no market price, no junk seed row (§2.4)"
        );
        assert_eq!(
            manifest.seed_price(501, junk, strict),
            SeedPrice::Priced {
                price: 4.1,
                source: PriceSource::CcpEsiAverage
            }
        );
        assert_eq!(
            manifest.seed_price(500, junk, lax),
            SeedPrice::Priced {
                price: 150.8,
                source: PriceSource::CcpEsiAdjusted
            },
            "with the rule off it seeds exactly as it used to"
        );

        assert_eq!(manifest.captured_leaf_prices(strict).get(500), None);
        assert_eq!(manifest.captured_leaf_prices(strict).get(501), Some(4.1));
        assert_eq!(manifest.captured_leaf_prices(lax).get(500), Some(150.8));

        // The index side of the same rule, and the sharper edge of it: bucket D at least
        // fails visibly as an uncaptured junk drop, whereas an A∪B type whose only number is
        // the industry index would otherwise be seeded off it silently.
        let index = BucketFlags {
            manufacturable_t1: true,
            ..BucketFlags::default()
        };
        assert_eq!(
            manifest.seed_price(500, index, strict),
            SeedPrice::Blocked,
            "an index type priced only by CCP's industry index is dropped, not seeded"
        );
        assert_eq!(
            manifest.seed_price(500, index, lax),
            SeedPrice::Priced {
                price: 150.8,
                source: PriceSource::CcpEsiAdjusted
            }
        );
    }

    /// The merge side of rule A: a capture only outranks a locally computed price if the
    /// policy would spend it. Otherwise `basePrice` is the entry and the record rides along,
    /// so nothing is lost and flipping the rule back needs no network.
    #[test]
    fn an_adjusted_only_record_loses_to_a_local_price_and_is_retained_beside_it() {
        let existing = manifest_with(&[(
            500,
            PriceEntry::capture(150.8, PriceSource::CcpEsiAdjusted, "2026-08-09T00:00:00Z"),
        )]);
        let local = [(500_u32, LocalPrice { price: 9.0, source: PriceSource::BasePrice })];

        let strict = MergeInput {
            reconcile_capture_provenance: false,
            ..input(&local, &[500], &[])
        };
        let (merged, stats) = merge(&existing, &strict, &CaptureBatch::default());
        let entry = merged.entry(500).expect("present");
        assert_eq!(entry.source, PriceSource::BasePrice);
        assert_eq!(entry.price, 9.0);
        assert_eq!(
            entry.retained_capture.as_ref().map(|capture| capture.price),
            Some(150.8),
            "the record is kept, not discarded — refetching it would be a network round trip"
        );
        assert_eq!(stats.captures_retained_beside_local, 1);
        assert_eq!(stats.local_written, 1);

        // With the rule off, the same inputs give the pre-piece-8 answer.
        let lax = MergeInput {
            policy: CapturePolicy::accept_adjusted(),
            ..strict
        };
        let (merged, stats) = merge(&existing, &lax, &CaptureBatch::default());
        assert_eq!(merged.entry(500).expect("present").source, PriceSource::CcpEsiAdjusted);
        assert_eq!(stats.local_suppressed_by_capture, 1);
    }

    /// A manifest written before rule A existed labelled every ESI number `ccp-esi-average`.
    /// The merge corrects the label from the payload without moving the value, so the rule
    /// works on old data and the correction is a one-time diff, not a per-run churn.
    #[test]
    fn a_mislabelled_adjusted_capture_is_relabelled_without_repricing() {
        let existing = manifest_with(&[(
            500,
            PriceEntry::capture(150.8, PriceSource::CcpEsiAverage, "2026-08-09T00:00:00Z"),
        )]);
        let observed = batch_of(&[(500, 150.8, PriceSource::CcpEsiAdjusted)], "2026-08-10T00:00:00Z");

        let (merged, stats) = merge(&existing, &input(&[], &[500], &[]), &observed);
        assert_eq!(stats.captures_relabelled_adjusted, 1);
        assert_eq!(stats.captures_new, 0, "nothing was captured, only relabelled");
        let entry = merged.entry(500).expect("still present");
        assert_eq!(entry.source, PriceSource::CcpEsiAdjusted);
        assert_eq!(entry.price, 150.8, "the value is untouched");
        assert_eq!(
            entry.captured_at.as_deref(),
            Some("2026-08-09T00:00:00Z"),
            "and so is when it was captured"
        );

        // Idempotent: a second run over the corrected manifest changes nothing.
        let (again, stats) = merge(&merged, &input(&[], &[500], &[]), &observed);
        assert_eq!(stats.captures_relabelled_adjusted, 0);
        assert!(stats.unchanged, "{:?}", first_difference(&merged, &again));
    }

    /// An adjusted-only record is not a price, so it does not enjoy the "never refetch"
    /// protection a price does: when ESI publishes a real `average_price` the type is
    /// captured for the first time.
    #[test]
    fn an_adjusted_record_upgrades_when_a_real_market_price_appears() {
        let existing = manifest_with(&[(
            500,
            PriceEntry::capture(150.8, PriceSource::CcpEsiAdjusted, "2026-08-09T00:00:00Z"),
        )]);
        let payload = batch(&[(500, 900.0)], "2026-08-10T00:00:00Z");

        let (merged, stats) = merge(&existing, &input(&[], &[500], &[]), &payload);
        assert_eq!(stats.captures_upgraded_to_market, 1);
        let entry = merged.entry(500).expect("present");
        assert_eq!(entry.source, PriceSource::CcpEsiAverage);
        assert_eq!(entry.price, 900.0);
        assert_eq!(entry.captured_at.as_deref(), Some("2026-08-10T00:00:00Z"));

        // The reverse never happens: a real market price is never downgraded to CCP's index,
        // even when --force-refetch names it. (Provenance reconciliation is off here, as it
        // is on any manifest already written with rule A — otherwise a transient gap in the
        // payload could demote a captured price, and captures are permanent.)
        let snapshot = manifest_with(&[(
            501,
            PriceEntry::capture(900.0, PriceSource::CcpSnapshotJitaSplit, "2026-08-10T00:00:00Z"),
        )]);
        let settled = MergeInput {
            reconcile_capture_provenance: false,
            ..input(&[], &[501], &[501])
        };
        let (kept, stats) = merge(
            &snapshot,
            &settled,
            &batch_of(&[(501, 1.0, PriceSource::CcpEsiAdjusted)], "2026-08-11T00:00:00Z"),
        );
        assert_eq!(stats.captures_forced_kept, 1);
        assert_eq!(stats.captures_forced_replaced, 0);
        assert_eq!(kept.entry(501).expect("present").price, 900.0);
    }

    /// The migration runs once. A manifest that already records rule A is trusted, so a
    /// transient gap in the ESI payload cannot demote a price it captured earlier.
    #[test]
    fn provenance_reconciliation_is_a_one_time_migration_not_a_per_run_check() {
        let existing = manifest_with(&[(
            500,
            PriceEntry::capture(150.8, PriceSource::CcpEsiAverage, "2026-08-09T00:00:00Z"),
        )]);
        let observed = batch_of(&[(500, 150.8, PriceSource::CcpEsiAdjusted)], "2026-08-10T00:00:00Z");
        let settled = MergeInput {
            reconcile_capture_provenance: false,
            ..input(&[], &[500], &[])
        };

        let (merged, stats) = merge(&existing, &settled, &observed);
        assert_eq!(stats.captures_relabelled_adjusted, 0);
        assert_eq!(
            merged.entry(500).expect("present").source,
            PriceSource::CcpEsiAverage,
            "a settled manifest's labels are not second-guessed"
        );
    }

    #[test]
    fn type_id_keys_serialize_in_numeric_order() {
        let manifest = manifest_with(&[
            (1000, local_entry(11.0, PriceSource::CostRecursive)),
            (34, local_entry(2.0, PriceSource::BasePrice)),
            (200, local_entry(3.0, PriceSource::BasePrice)),
            (2, local_entry(4.0, PriceSource::BasePrice)),
        ]);
        let json = manifest.to_json_string().expect("serializes");

        let position = |needle: &str| json.find(needle).unwrap_or_else(|| panic!("{needle} missing from {json}"));
        let two = position("\"2\":");
        let thirty_four = position("\"34\":");
        let two_hundred = position("\"200\":");
        let thousand = position("\"1000\":");
        assert!(
            two < thirty_four && thirty_four < two_hundred && two_hundred < thousand,
            "keys must sort numerically, not lexicographically: {json}"
        );
        assert!(json.ends_with('\n'), "the file ends with a newline");
        assert!(json.contains("\"formatVersion\": 1"));
        assert!(json.contains("\"sdeBuild\": 3396210"));
        assert!(json.contains("\"costModel\": \"recursive-v1\""));
        assert!(
            !json.contains("capturedAt"),
            "local entries carry no capture timestamp"
        );
    }

    #[test]
    fn a_long_significand_price_survives_the_json_round_trip() {
        // Regression: 227075028.41125003 is a real cost-recursive price from SDE build
        // 3396210. Written verbatim, serde_json reads it back as …005 — one ULP off — and
        // every refresh would then rewrite an unchanged committed file.
        let raw = 227_075_028.411_250_03_f64;
        let normalized = normalize_price(raw);
        assert_eq!(normalized, 227_075_028.411);
        assert!((normalized - raw).abs() < 0.01, "0.01 ISK is the tolerance that matters");

        let manifest = manifest_with(&[
            (2028, PriceEntry::local(LocalPrice { price: raw, source: PriceSource::CostRecursive })),
            (1, PriceEntry::local(LocalPrice { price: 1.0 / 3.0, source: PriceSource::CostRecursive })),
            (2, PriceEntry::local(LocalPrice { price: 9_551_872_000.0, source: PriceSource::CostRecursive })),
            (3, PriceEntry::local(LocalPrice { price: 0.000_000_123_456_789_012_345, source: PriceSource::BasePrice })),
            (4, PriceEntry::capture(4.123_456_789_012_345_6, PriceSource::CcpEsiAverage, "t")),
        ]);
        let json = manifest.to_json_string().expect("serializes");
        let reloaded = PriceManifest::from_json_str(&json).expect("parses");
        assert_eq!(first_difference(&manifest, &reloaded), None, "{json}");
        assert_eq!(reloaded, manifest);
        // Serialising the reloaded copy reproduces the same bytes, so the file is stable
        // across refreshes.
        assert_eq!(reloaded.to_json_string().unwrap(), json);
        // A positive price is never normalised to zero, however small.
        assert!(reloaded.prices[&3].price > 0.0);
    }

    #[test]
    fn a_hand_written_long_price_is_normalised_on_load_so_save_is_a_fixpoint() {
        let raw = r#"{
            "formatVersion": 1, "sdeBuild": 3396210, "costModel": "recursive-v1",
            "generatedAt": "2026-08-10T00:00:00Z", "sources": {},
            "prices": { "2028": { "price": 227075028.41125003, "source": "cost-recursive" } }
        }"#;
        let loaded = PriceManifest::from_json_str(raw).expect("parses");
        assert_eq!(loaded.prices[&2028].price, 227_075_028.411);
        let json = loaded.to_json_string().expect("serializes");
        assert_eq!(
            PriceManifest::from_json_str(&json).unwrap().to_json_string().unwrap(),
            json,
            "load -> save must be a fixpoint"
        );
    }

    #[test]
    fn an_absent_sde_build_serializes_as_null() {
        let manifest = PriceManifest::empty(None, "recursive-v1", "2026-08-10T00:00:00Z");
        let json = manifest.to_json_string().expect("serializes");
        assert!(json.contains("\"sdeBuild\": null"), "{json}");
        let parsed = PriceManifest::from_json_str(&json).expect("round trips");
        assert_eq!(parsed.sde_build, None);
    }

    #[test]
    fn write_then_load_yields_identical_data() {
        let mut manifest = manifest_with(&[
            (34, local_entry(2.0, PriceSource::BasePrice)),
            (2073, capture_entry(4.1, "2026-08-01T00:00:00Z")),
            (
                25595,
                PriceEntry::capture(6100.0, PriceSource::CcpSnapshotJitaSplit, "2026-08-02T00:00:00Z"),
            ),
            (32880, local_entry(134_400.0, PriceSource::CostRecursive)),
        ]);
        manifest.sources.insert(
            SOURCE_KEY_ESI.to_string(),
            "markets/prices @ 2026-08-01T00:00:00Z".to_string(),
        );

        let dir = std::env::temp_dir().join(format!(
            "market-seederv3-manifest-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let path = dir.join("nested").join("price-manifest.json");
        assert!(
            PriceManifest::load(&path).expect("a missing manifest is not an error").is_none()
        );

        manifest.save(&path).expect("writes, creating parents");
        let loaded = PriceManifest::load(&path)
            .expect("loads")
            .expect("exists now");
        assert_eq!(loaded, manifest);
        assert_eq!(
            loaded.to_json_string().unwrap(),
            manifest.to_json_string().unwrap()
        );

        // Provenance survives, and so does the snapshot source this piece never writes.
        assert_eq!(
            loaded.entry(25595).map(|entry| entry.source),
            Some(PriceSource::CcpSnapshotJitaSplit)
        );
        assert!(loaded.has_capture(25595));
        assert!(!loaded.has_capture(34));
        assert_eq!(loaded.capture_count(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_source_is_rejected_rather_than_silently_kept() {
        let raw = r#"{
            "formatVersion": 1, "sdeBuild": 1, "costModel": "recursive-v1",
            "generatedAt": "x", "sources": {},
            "prices": { "34": { "price": 2.0, "source": "vibes" } }
        }"#;
        let error = format!("{:#}", PriceManifest::from_json_str(raw).expect_err("rejected"));
        assert!(error.contains("cost-recursive"), "{error}");
        assert!(error.contains("ccp-snapshot-jita-split"), "{error}");
    }

    #[test]
    fn a_bucket_d_type_without_a_capture_is_unseedable_and_never_falls_back_to_base_price() {
        let junk = BucketFlags {
            manufacturable_t1: false,
            material: false,
            junk_candidate: true,
        };
        // The manifest even holds a local base-price entry for it — a stale artifact of the
        // generic cost ladder. §2.4 says it is still not seedable.
        let manifest = manifest_with(&[
            (500, local_entry(1_000.0, PriceSource::BasePrice)),
            (501, capture_entry(2_500.0, "2026-08-01T00:00:00Z")),
        ]);
        assert_eq!(manifest.seed_price(500, junk, CapturePolicy::reject_adjusted()), SeedPrice::UnseedableJunk);
        assert_eq!(manifest.seed_price(502, junk, CapturePolicy::reject_adjusted()), SeedPrice::UnseedableJunk);
        assert_eq!(
            manifest.seed_price(501, junk, CapturePolicy::reject_adjusted()),
            SeedPrice::Priced {
                price: 2_500.0,
                source: PriceSource::CcpEsiAverage
            }
        );
        assert_eq!(manifest.seed_price(500, junk, CapturePolicy::reject_adjusted()).price(), None);

        // The same entry under an index bucket *is* usable — the rule is about D, not about
        // the source.
        let index = BucketFlags {
            manufacturable_t1: true,
            material: false,
            junk_candidate: false,
        };
        assert_eq!(
            manifest.seed_price(500, index, CapturePolicy::reject_adjusted()),
            SeedPrice::Priced {
                price: 1_000.0,
                source: PriceSource::BasePrice
            }
        );
        assert_eq!(manifest.seed_price(999, index, CapturePolicy::reject_adjusted()), SeedPrice::Blocked);
    }

    #[test]
    fn bucket_d_entries_are_never_written_locally_by_a_refresh() {
        // The merge only ever writes what `local` holds, and the refresh builds `local` from
        // A∪B alone. A D type therefore appears only if a capture arrived for it.
        let existing = manifest_with(&[(500, local_entry(1_000.0, PriceSource::BasePrice))]);
        let (merged, stats) = merge(
            &existing,
            &input(&[], &[500, 501], &[]),
            &batch(&[(501, 2_500.0)], "2026-08-10T00:00:00Z"),
        );
        assert!(!merged.prices.contains_key(&500), "the stale local D entry is dropped");
        assert!(merged.prices[&501].is_capture());
        assert_eq!(stats.local_dropped, 1);
        assert_eq!(stats.captures_new, 1);
        assert_eq!(stats.captures_missing, 1, "500 stays unseeded, by design");
    }

    #[test]
    fn a_capture_beats_a_local_price_for_the_same_type_and_says_so() {
        // The cycle-guard class: a craftable type with no basePrice that was captured as a
        // leaf, and now also resolves through its own blueprint. Captures are permanent, so
        // the capture stays and the collision is counted rather than hidden.
        let existing = manifest_with(&[(700, capture_entry(50.0, "2026-08-01T00:00:00Z"))]);
        let (merged, stats) = merge(
            &existing,
            &input(&[(700, cost_recursive(12.0))], &[700], &[]),
            &CaptureBatch::default(),
        );
        assert_eq!(merged.prices[&700].price, 50.0);
        assert_eq!(stats.local_suppressed_by_capture, 1);
        assert_eq!(stats.local_written, 0);
        assert_eq!(stats.captures_retained_beside_local, 0);
    }

    fn cost_recursive(price: f64) -> LocalPrice {
        LocalPrice {
            price,
            source: PriceSource::CostRecursive,
        }
    }

    fn base_price(price: f64) -> LocalPrice {
        LocalPrice {
            price,
            source: PriceSource::BasePrice,
        }
    }

    #[test]
    fn base_price_first_keeps_the_local_price_and_retains_the_capture_beside_it() {
        // Piece 7's enlarged capture set means a leaf can hold a market price the configured
        // ladder does not want. `base-price-first` must then price the leaf off the SDE — and
        // the capture must survive in the file, or flipping the knob back would refetch it
        // over the network at a different TQ price, which §4.3 forbids.
        let existing = manifest_with(&[(34, capture_entry(5.0, "2026-08-01T00:00:00Z"))]);
        let mut merge_input = input(&[(34, base_price(2.0))], &[34], &[]);
        merge_input.local_outranks_capture = BTreeSet::from([34]);
        let (merged, stats) = merge(&existing, &merge_input, &CaptureBatch::default());

        let entry = &merged.prices[&34];
        assert_eq!(entry.price, 2.0, "the SDE basePrice is the seed price");
        assert_eq!(entry.source, PriceSource::BasePrice, "and the source says so");
        let retained = entry
            .retained_capture
            .as_ref()
            .expect("the capture must not be discarded");
        assert_eq!(retained.price, 5.0);
        assert_eq!(retained.source, PriceSource::CcpEsiAverage);
        assert_eq!(retained.captured_at, "2026-08-01T00:00:00Z");

        assert_eq!(stats.captures_retained_beside_local, 1);
        assert_eq!(stats.local_suppressed_by_capture, 0);
        assert_eq!(stats.capture_became_local, 1);
        assert_eq!(stats.captures_missing, 0, "the type is still captured");
        // The cost map still sees the captured price, so flipping back needs no network.
        assert_eq!(merged.captured_leaf_prices(CapturePolicy::reject_adjusted()).get(34), Some(5.0));
        assert!(merged.has_capture(34));
        assert_eq!(merged.capture_count(), 1);
        assert_eq!(merged.capture_priced_count(), 0);
    }

    #[test]
    fn capture_first_makes_the_capture_the_entry_and_the_source_follows_the_rung() {
        // The same type under the default ladder: the leaf resolves through its capture, so
        // `local_prices_from_report` offers nothing for it and the entry is the capture. The
        // manifest's `source` has to move with it — a leaf that switched from base-price to
        // ccp-esi-average must say so in the diff.
        let existing = manifest_with(&[(34, local_entry(2.0, PriceSource::BasePrice))]);
        let (merged, stats) = merge(
            &existing,
            &input(&[], &[34], &[]),
            &batch(&[(34, 5.0)], "2026-08-10T00:00:00Z"),
        );

        let entry = &merged.prices[&34];
        assert_eq!(entry.price, 5.0);
        assert_eq!(entry.source, PriceSource::CcpEsiAverage);
        assert_eq!(entry.captured_at.as_deref(), Some("2026-08-10T00:00:00Z"));
        assert!(entry.retained_capture.is_none(), "it IS the capture");
        assert_eq!(stats.captures_new, 1);
        assert_eq!(stats.local_became_capture, 1);
        assert_eq!(stats.local_dropped, 0, "it became a capture, it did not vanish");
    }

    #[test]
    fn a_retained_capture_round_trips_and_can_be_promoted_back_without_a_refetch() {
        // base-price-first writes the retained capture…
        let existing = manifest_with(&[(34, capture_entry(5.0, "2026-08-01T00:00:00Z"))]);
        let mut base_first = input(&[(34, base_price(2.0))], &[34], &[]);
        base_first.local_outranks_capture = BTreeSet::from([34]);
        let (with_retained, _) = merge(&existing, &base_first, &CaptureBatch::default());

        // …it survives the JSON round trip…
        let reloaded = PriceManifest::from_json_str(&with_retained.to_json_string().unwrap())
            .expect("the retained capture parses");
        assert_eq!(reloaded, with_retained);

        // …and capture-first promotes it back with an empty batch, i.e. offline.
        let (promoted, stats) = merge(
            &reloaded,
            &input(&[], &[34], &[]),
            &CaptureBatch::default(),
        );
        assert_eq!(promoted.prices[&34].price, 5.0);
        assert_eq!(promoted.prices[&34].source, PriceSource::CcpEsiAverage);
        assert_eq!(
            promoted.prices[&34].captured_at.as_deref(),
            Some("2026-08-01T00:00:00Z"),
            "the original capture timestamp, not today's"
        );
        assert_eq!(stats.captures_new, 0, "nothing was fetched");
        assert_eq!(stats.captures_held, 1);
    }

    #[test]
    fn a_no_op_refresh_leaves_the_file_byte_identical() {
        let existing = manifest_with(&[
            (34, local_entry(2.0, PriceSource::BasePrice)),
            (2073, capture_entry(4.1, "2026-08-01T00:00:00Z")),
        ]);
        let (merged, stats) = merge(
            &existing,
            &input(
                &[(
                    34,
                    LocalPrice {
                        price: 2.0,
                        source: PriceSource::BasePrice,
                    },
                )],
                &[2073],
                &[],
            ),
            &CaptureBatch::default(),
        );
        assert!(stats.unchanged);
        assert_eq!(merged.generated_at, existing.generated_at);
        assert_eq!(
            merged.to_json_string().unwrap(),
            existing.to_json_string().unwrap()
        );
    }

    #[test]
    fn captures_outside_the_want_list_are_retained() {
        let existing = manifest_with(&[(9_999, capture_entry(1.0, "2026-08-01T00:00:00Z"))]);
        let (merged, stats) = merge(&existing, &input(&[], &[], &[]), &CaptureBatch::default());
        assert!(merged.has_capture(9_999));
        assert_eq!(stats.captures_retained_unwanted, 1);
        assert_eq!(stats.captures_held, 1);
    }

    #[test]
    fn captured_leaf_prices_expose_only_captures() {
        let manifest = manifest_with(&[
            (34, local_entry(2.0, PriceSource::BasePrice)),
            (2073, capture_entry(4.1, "2026-08-01T00:00:00Z")),
        ]);
        let captures = manifest.captured_leaf_prices(CapturePolicy::reject_adjusted());
        assert_eq!(captures.get(2073), Some(4.1));
        assert_eq!(captures.get(34), None, "a local price is not a capture");
        assert_eq!(captures.len(), 1);
    }

    #[test]
    fn the_source_histogram_covers_every_legal_source() {
        let manifest = manifest_with(&[
            (34, local_entry(2.0, PriceSource::BasePrice)),
            (35, local_entry(8.0, PriceSource::BasePrice)),
            (32880, local_entry(134_400.0, PriceSource::CostRecursive)),
            (2073, capture_entry(4.1, "2026-08-01T00:00:00Z")),
        ]);
        assert_eq!(
            manifest.source_histogram(),
            vec![
                (PriceSource::CostRecursive, 1),
                (PriceSource::BasePrice, 2),
                (PriceSource::DerivedCompressedTwin, 0),
                (PriceSource::ReprocessingFloor, 0),
                (PriceSource::CcpEsiAverage, 1),
                (PriceSource::CcpEsiAdjusted, 0),
                (PriceSource::CcpSnapshotJitaSplit, 0),
            ]
        );
    }

    #[test]
    fn cost_model_keys_are_pinned_per_pricing_mode() {
        assert_eq!(cost_model_key(PricingModel::Recursive), "recursive-v1");
        assert_eq!(cost_model_key(PricingModel::ShallowEiv), "shallow-eiv-v1");
    }

    #[test]
    fn a_capture_resolved_cost_produces_no_local_entry() {
        assert_eq!(LocalPrice::from_cost(5.0, CostSource::Captured), None);
        assert_eq!(
            LocalPrice::from_cost(5.0, CostSource::BasePrice),
            Some(LocalPrice {
                price: 5.0,
                source: PriceSource::BasePrice
            })
        );
        assert_eq!(LocalPrice::from_cost(0.0, CostSource::BasePrice), None);
        assert_eq!(LocalPrice::from_cost(f64::NAN, CostSource::CostRecursive), None);
    }
}
